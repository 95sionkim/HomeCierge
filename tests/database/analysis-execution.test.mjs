// 합성 BE-02 재생 자료와 PGlite로 실행 RPC, 저장, 권한을 검사한다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBe03Db } from './helpers/be03-db.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = 'tests/fixtures/ingestion-v0.json';
const request = JSON.parse(readFileSync(new URL('../fixtures/ingestion-v0.json', import.meta.url), 'utf8')).request;
const synthetic = { kind: 'synthetic', fixture: 'ingestion-v0' };
const conditions = { budget_max_won: '750000000', ingestion_target: { noticeSource: request.noticeSource, ...request.target } };
const missing = { code: 'PT404' };
const conflict = { code: 'PT409' };
const invalid = { code: '22023' };
const forbidden = { code: '42501' };
const rateLimited = { code: 'PT429' };

let db;
let result;
let noticeId;
let housingTypeId;

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function as(role, userId = null, anonymous = false) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)",
    [userId ?? '', JSON.stringify({ is_anonymous: anonymous })]);
  await db.exec(`set role ${role}`);
}

async function analysis(userId = null, status = 'draft') {
  if (userId === null) {
    userId = randomUUID();
    await db.query('insert into auth.users(id) values ($1)', [userId]);
    await db.query('insert into public.user_profiles(user_id, revision) values ($1, 7)', [userId]);
  }
  const chat = await one('insert into public.chats(user_id) values ($1) returning id', [userId]);
  const row = await one(`insert into public.analyses
    (user_id, chat_id, notice_id, housing_type_id, conditions_snapshot, rules_version, status)
    values ($1, $2, $3, $4, $5, 'synthetic-rules-1', $6) returning id`,
    [userId, chat.id, noticeId, housingTypeId, JSON.stringify(conditions), status]);
  return { userId, analysisId: row.id };
}

async function rpc(name, ...params) {
  const args = params.map((_, index) => `$${index + 1}`).join(', ');
  return (await one(`select public.${name}(${args}) as reply`, params)).reply;
}

const enqueue = (owner, key = randomUUID(), input = synthetic) =>
  rpc('enqueue_analysis_run', owner.analysisId, key, JSON.stringify(input));
const get = (owner, run) => rpc('get_analysis_run', owner.analysisId, run.runId);
const cancel = (owner, run) => rpc('cancel_analysis_run', owner.analysisId, run.runId);
const claim = (seconds = 300, runId) => runId === undefined
  ? rpc('claim_analysis_run', seconds) : rpc('claim_analysis_run', seconds, runId);
const leaseArgs = job => [job.runId, job.generation, job.leaseToken];
const renew = (job, seconds) => rpc('renew_analysis_run', ...leaseArgs(job), seconds);
const fail = (job, retryable) => rpc('fail_analysis_run', ...leaseArgs(job), retryable);
const finish = (job, input = request, output = result) => rpc('finish_analysis_run', ...leaseArgs(job),
  input === null ? null : JSON.stringify(input), output === null ? null : JSON.stringify(output));
const save = (owner, key = randomUUID()) => rpc('save_ingestion_snapshot', owner.userId, owner.analysisId,
  key, JSON.stringify(request), JSON.stringify(result));
const snapshots = async owner => (await one(
  'select count(*)::int as count from public.analysis_input_snapshots where analysis_id = $1', [owner.analysisId])).count;
const summary = async owner => (await one('select status from public.analyses where id = $1', [owner.analysisId])).status;
const latestRunId = async owner => (await one('select latest_run_id from public.analyses where id = $1',
  [owner.analysisId])).latest_run_id;

async function makeDue(run) {
  await db.exec('reset role');
  await db.query("update private.analysis_runs set next_claim_at = clock_timestamp() - interval '1 second' where id = $1",
    [run.runId]);
  await as('service_role');
}

before(async () => {
  result = JSON.parse(execFileSync('python3', ['scripts/replay_ingestion.py', fixture], { cwd: root, encoding: 'utf8' }));
  db = await createBe03Db();
  await db.exec("insert into public.source_registry(id, display_name) values ('synthetic', '합성 공고 출처')");
  noticeId = (await one(`insert into public.notices(source_id, external_id, title, notice_kind, collected_at)
    values ('synthetic', 'synthetic-notice', '합성 공고', 'unknown', now()) returning id`)).id;
  housingTypeId = (await one(`insert into public.housing_types(notice_id, external_type_id, label)
    values ($1, '01', '합성 주택형') returning id`, [noticeId])).id;
});
beforeEach(async () => db.exec('reset role; delete from auth.users;'));
after(async () => db?.close());

test('one analysis and idempotency key accept one exact normalized input and replay the current operation', async () => {
  const owner = await analysis(null, 'completed');
  const untouched = await analysis(owner.userId, 'partial');
  const key = randomUUID();
  await as('authenticated', owner.userId);
  assert.equal(await summary(owner), 'completed');
  assert.equal(await summary(untouched), 'partial');
  assert.equal(await latestRunId(owner), null);
  for (const input of [null, [], { kind: 'synthetic' }, { ...synthetic, path: '/synthetic.json' },
    { kind: 'snapshot', snapshotId: 'invalid' }, { kind: 'snapshot', snapshotId: randomUUID(), url: 'https://example.invalid' }]) {
    await assert.rejects(enqueue(owner, key, input), invalid);
  }
  // Promise.all 제출은 PGlite 단일 세션에서 직렬 실행되므로 실제 연결 간 경합과 구분한다.
  const [first, duplicate] = await Promise.all([enqueue(owner, key), enqueue(owner, key)]);
  assert.deepEqual(first, {
    runId: first.runId, analysisId: owner.analysisId, status: 'queued', attempt: 0, submittedAt: first.submittedAt,
    finishedAt: null, input: synthetic, snapshotId: null, errorCode: null,
  });
  assert.match(first.runId, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(first.submittedAt)));
  assert.deepEqual(duplicate, first);
  assert.equal(await summary(owner), 'queued');
  assert.equal(await latestRunId(owner), first.runId);
  assert.equal(await latestRunId(untouched), null);
  await assert.rejects(db.query('update public.analyses set latest_run_id = null where id = $1',
    [owner.analysisId]), forbidden);
  await assert.rejects(db.query(`insert into public.analyses (user_id, chat_id, latest_run_id)
    select user_id, chat_id, $2::uuid from public.analyses where id = $1`, [owner.analysisId, first.runId]), forbidden);
  await assert.rejects(enqueue(owner, key, { kind: 'snapshot', snapshotId: randomUUID() }), conflict);
  assert.notEqual((await enqueue(untouched, key)).runId, first.runId);
  await assert.rejects(one('select private.read_analysis_run($1, $2, null)', [owner.analysisId, first.runId]), invalid);
  const cancelled = await cancel(owner, first);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.finishedAt);
  assert.deepEqual(await enqueue(owner, key), cancelled);
  assert.deepEqual(await cancel(owner, first), cancelled);
});

test('only the analysis owner sees its runs and only the worker can use lease RPCs', async () => {
  const owner = await analysis();
  const anotherAnalysis = await analysis(owner.userId);
  const stranger = await analysis();
  await as('service_role');
  const snapshotId = await save(owner);
  await assert.rejects(enqueue(owner), forbidden);
  await assert.rejects(one('select lease_token from private.analysis_runs'), forbidden);
  await as('authenticated', owner.userId);
  const run = await enqueue(owner, randomUUID(), { kind: 'snapshot', snapshotId });
  await assert.rejects(get(anotherAnalysis, run), missing);
  await assert.rejects(cancel(anotherAnalysis, run), missing);
  await assert.rejects(enqueue(anotherAnalysis, randomUUID(), run.input), missing);
  await assert.rejects(one('select * from private.analysis_runs'), forbidden);
  await assert.rejects(claim(), forbidden);
  await assert.rejects(claim(60, run.runId), forbidden);
  await assert.rejects(renew({ ...run, generation: 1, leaseToken: randomUUID() }, 1), forbidden);
  await assert.rejects(fail({ ...run, generation: 1, leaseToken: randomUUID() }, false), forbidden);
  await assert.rejects(finish({ ...run, generation: 1, leaseToken: randomUUID() }, null, null), forbidden);
  await as('authenticated', stranger.userId);
  await assert.rejects(get(owner, run), missing);
  await assert.rejects(cancel(owner, run), missing);
  await assert.rejects(enqueue(owner), missing);
  await assert.rejects(enqueue(stranger, randomUUID(), run.input), missing);
  await as('authenticated', owner.userId, true);
  await assert.rejects(get(owner, run), forbidden);
  await as('anon');
  await assert.rejects(get(owner, run), forbidden);
});

test('new submissions share a rolling account limit across analyses without blocking replays, reads or cancellation', async () => {
  const owner = await analysis();
  const sibling = await analysis(owner.userId);
  const stranger = await analysis();
  const key = randomUUID();
  await as('authenticated', owner.userId);
  const first = await enqueue(owner, key);
  for (let index = 1; index < 12; index += 1) {
    await enqueue(index % 2 === 0 ? owner : sibling);
  }
  await assert.rejects(enqueue(sibling), rateLimited);
  assert.deepEqual(await get(owner, first), first);
  const cancelled = await cancel(owner, first);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(await enqueue(owner, key), cancelled);
  await assert.rejects(enqueue(owner, key, { kind: 'snapshot', snapshotId: randomUUID() }), conflict);
  await assert.rejects(enqueue(owner), rateLimited);
  await as('authenticated', stranger.userId);
  assert.equal((await enqueue(stranger)).status, 'queued');

  await db.exec('reset role');
  await db.query("update private.analysis_runs set submitted_at = clock_timestamp() - interval '61 seconds' where id = $1",
    [first.runId]);
  await as('authenticated', owner.userId);
  assert.equal((await enqueue(sibling)).status, 'queued');
  await assert.rejects(enqueue(owner), rateLimited);
});

test('synthetic finish saves one BE-03 capture atomically and retains the submission inputs', async () => {
  const owner = await analysis();
  await as('authenticated', owner.userId);
  const run = await enqueue(owner);
  await db.exec('reset role');
  await db.query('update public.user_profiles set revision = 8 where user_id = $1', [owner.userId]);
  await as('service_role');
  const job = await claim();
  assert.deepEqual(job, {
    runId: run.runId, analysisId: owner.analysisId, userId: owner.userId, input: synthetic,
    generation: 1, leaseToken: job.leaseToken,
  });
  assert.match(job.leaseToken, /^[0-9a-f-]{36}$/);
  for (const duration of [null, 0, 301]) {
    await assert.rejects(claim(duration), invalid);
    await assert.rejects(renew(job, duration), invalid);
  }
  const running = await renew(job, 300);
  assert.equal(running.status, 'running');
  assert.equal(running.attempt, 1);
  assert.equal(running.snapshotId, null);
  await assert.rejects(finish(job, request, { ...result, dataOrigin: 'collected' }), invalid);
  await assert.rejects(finish(job, { ...request, pageSize: 3 }), invalid);
  await assert.rejects(save(owner, run.runId), forbidden);
  const done = await finish(job);
  assert.equal(done.status, 'finished');
  assert.ok(done.finishedAt);
  assert.ok(done.snapshotId);
  assert.equal(done.errorCode, null);
  await assert.rejects(finish(job), conflict);
  assert.equal(await snapshots(owner), 1);
  assert.deepEqual(await one(`select capture_key, data_origin, conditions_snapshot, rules_version,
    notice_id, housing_type_id, as_of::text from public.analysis_input_snapshots where id = $1`, [done.snapshotId]), {
    capture_key: run.runId, data_origin: 'synthetic', conditions_snapshot: conditions, rules_version: 'synthetic-rules-1',
    notice_id: noticeId, housing_type_id: housingTypeId, as_of: '2026-11-10',
  });
  assert.equal(await claim(), null);
  await db.exec('reset role');
  const pinned = await one(`select profile_revision::int, basis_date::text, conditions_snapshot, rules_version,
    notice_id, housing_type_id from private.analysis_runs where id = $1`, [run.runId]);
  assert.deepEqual(pinned, {
    profile_revision: 7, basis_date: '2026-11-10', conditions_snapshot: conditions,
    rules_version: 'synthetic-rules-1', notice_id: noticeId, housing_type_id: housingTypeId,
  });
  await as('authenticated', owner.userId);
  assert.deepEqual(await get(owner, run), done);
  assert.equal(await summary(owner), 'input_ready');
  await assert.rejects(cancel(owner, run), conflict);
});

test('snapshot finish reuses the original capture and older execution changes preserve the latest summary', async () => {
  const owner = await analysis();
  await as('service_role');
  const snapshotId = await save(owner);
  await db.query(`update public.analyses set conditions_snapshot = '{}', rules_version = 'synthetic-rules-2',
    notice_id = null, housing_type_id = null where id = $1`, [owner.analysisId]);
  await as('authenticated', owner.userId);
  const key = randomUUID();
  const old = await enqueue(owner, key, { kind: 'snapshot', snapshotId: snapshotId.toUpperCase() });
  assert.deepEqual(await enqueue(owner, key, { kind: 'snapshot', snapshotId }), old);
  assert.equal(await latestRunId(owner), old.runId);
  const latest = await enqueue(owner);
  assert.equal(await summary(owner), 'queued');
  assert.equal(await latestRunId(owner), latest.runId);
  await as('service_role');
  const job = await claim();
  assert.equal(job.runId, old.runId);
  await assert.rejects(finish(job), invalid);
  const done = await finish(job, null, null);
  assert.equal(done.snapshotId, snapshotId);
  assert.equal(await snapshots(owner), 1);
  assert.equal(await summary(owner), 'queued');
  assert.equal(await latestRunId(owner), latest.runId);
  const newest = await claim();
  assert.equal(newest.runId, latest.runId);
  assert.equal(await summary(owner), 'running');
  assert.equal((await fail(newest, false)).errorCode, 'run_internal_error');
  assert.equal(await summary(owner), 'failed');
  await assert.rejects(finish(newest), conflict);
  assert.equal(await snapshots(owner), 1);
  await db.exec('reset role');
  assert.deepEqual(await one(`select conditions_snapshot, rules_version, housing_type_id, basis_date::text
    from private.analysis_runs where id = $1`, [old.runId]), {
    conditions_snapshot: conditions, rules_version: 'synthetic-rules-1', housing_type_id: housingTypeId,
    basis_date: '2026-11-10',
  });
  await as('authenticated', owner.userId);
  await assert.rejects(cancel(owner, latest), conflict);
  assert.deepEqual(await enqueue(owner, key, old.input), done);
  assert.equal(await latestRunId(owner), latest.runId);
  assert.notEqual((await enqueue(owner)).runId, latest.runId);
});

test('a scoped worker claim skips unrelated jobs and returns null when the requested job is unavailable', async () => {
  const { rows: signatures } = await db.query(`select p.pronargs, p.pronargdefaults from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = 'claim_analysis_run'`);
  assert.deepEqual(signatures, [{ pronargs: 2, pronargdefaults: 1 }]);
  const owner = await analysis();
  await as('authenticated', owner.userId);
  const first = await enqueue(owner);
  const selected = await enqueue(owner);
  await as('service_role');
  assert.equal(await claim(60, randomUUID()), null);
  assert.equal((await claim(60, selected.runId)).runId, selected.runId);
  assert.equal(await claim(60, selected.runId), null);
  assert.equal((await claim()).runId, first.runId);
});

test('retries wait, reclaim with a new generation and expire the last lease before the next claim', async () => {
  const owner = await analysis();
  const other = await analysis();
  await as('authenticated', owner.userId);
  const run = await enqueue(owner);
  await as('service_role');
  const first = await claim();
  assert.equal(first.generation, 1);
  await assert.rejects(fail({ ...first, generation: 2 }, true), conflict);
  await assert.rejects(renew({ ...first, leaseToken: randomUUID() }, 300), conflict);
  assert.equal((await fail(first, true)).status, 'retry_wait');
  assert.equal(await summary(owner), 'queued');
  assert.equal(await claim(), null);
  await makeDue(run);
  const second = await claim();
  assert.equal(second.generation, 2);
  assert.notEqual(second.leaseToken, first.leaseToken);
  await assert.rejects(finish(first), conflict);
  await makeDue(run);
  await assert.rejects(renew(second, 300), conflict);
  const third = await claim();
  assert.equal(third.generation, 3);
  await makeDue(run);
  await assert.rejects(finish(third), conflict);
  assert.equal(await claim(60, randomUUID()), null);
  assert.equal(await summary(owner), 'running');
  await as('authenticated', other.userId);
  const upcoming = await enqueue(other);
  await as('service_role');
  assert.equal((await claim()).runId, upcoming.runId);
  assert.equal(await summary(owner), 'failed');
  assert.equal(await claim(), null);
  assert.equal(await snapshots(owner), 0);
  await as('authenticated', owner.userId);
  const expired = await get(owner, run);
  assert.equal(expired.status, 'failed');
  assert.equal(expired.attempt, 3);
  assert.equal(expired.errorCode, 'run_deadline_exceeded');
  assert.ok(expired.finishedAt);
});

test('analysis drift, cancellation and deletion prevent stale snapshot writes', async () => {
  const owner = await analysis();
  await as('authenticated', owner.userId);
  const run = await enqueue(owner);
  await as('service_role');
  const job = await claim();
  for (const changed of ["conditions_snapshot = '{}'", "rules_version = 'synthetic-rules-2'", 'housing_type_id = null']) {
    await db.query(`update public.analyses set ${changed} where id = $1`, [owner.analysisId]);
    await assert.rejects(finish(job), invalid);
    assert.equal(await snapshots(owner), 0);
    await db.query(`update public.analyses set conditions_snapshot = $2, rules_version = 'synthetic-rules-1',
      housing_type_id = $3 where id = $1`, [owner.analysisId, JSON.stringify(conditions), housingTypeId]);
  }
  await as('authenticated', owner.userId);
  assert.equal((await cancel(owner, run)).status, 'cancelled');
  assert.equal(await summary(owner), 'cancelled');
  const following = await enqueue(owner);
  assert.equal(await latestRunId(owner), following.runId);
  await as('service_role');
  await assert.rejects(finish(job), conflict);
  await assert.rejects(fail(job, true), conflict);
  await assert.rejects(save(owner, run.runId), forbidden);
  const deleted = await claim();
  assert.equal(deleted.runId, following.runId);
  await db.query('delete from public.analyses where id = $1', [owner.analysisId]);
  await assert.rejects(finish(deleted), missing);
  await assert.rejects(renew(deleted, 300), missing);
  await assert.rejects(fail(deleted, false), missing);
  assert.equal(await snapshots(owner), 0);
  assert.equal(await claim(), null);
  await db.exec('reset role');
  assert.equal(await one('select latest_run_id from public.analyses where id = $1', [owner.analysisId]), undefined);
  assert.equal((await one('select count(*)::int as count from private.analysis_runs where analysis_id = $1',
    [owner.analysisId])).count, 0);
});

test('a deleted input snapshot is reported as an input error while the run lease can still record failure', async () => {
  const owner = await analysis();
  await as('service_role');
  const snapshotId = await save(owner);
  await as('authenticated', owner.userId);
  const run = await enqueue(owner, randomUUID(), { kind: 'snapshot', snapshotId });
  await as('service_role');
  const job = await claim(60, run.runId);
  await db.exec('reset role');
  await db.query('delete from public.analysis_input_snapshots where id = $1', [snapshotId]);
  await as('service_role');
  await assert.rejects(finish(job, null, null), invalid);
  const failed = await fail(job, false);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.snapshotId, null);
  assert.equal(failed.errorCode, 'run_internal_error');
  assert.equal(await summary(owner), 'failed');
});
