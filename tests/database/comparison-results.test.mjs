// 합성 입력과 PGlite로 비교 저장 계약을 검사한다. 실제 Auth·Storage 서비스는 호출하지 않는다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBe03Db } from './helpers/be03-db.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = 'tests/fixtures/ingestion-v0.json';
const { request } = JSON.parse(readFileSync(new URL('../fixtures/ingestion-v0.json', import.meta.url), 'utf8'));
const synthetic = { kind: 'synthetic', fixture: 'ingestion-v0' };
const snapshotInput = snapshotId => ({ kind: 'snapshot', snapshotId });
const conditions = { comparison: { modelNo: '01' }, comparisonEvidence: { target: 'SYNTHETIC_UNTRUSTED' },
  useSyntheticFixture: true, selectionBindingIssue: null, budget_max_won: '750000000' };
const matchedConditions = { ...conditions, ingestion_target: { noticeSource: request.noticeSource, ...request.target } };
const evidence = {
  ...JSON.parse(readFileSync(new URL('../fixtures/comparison-evidence-v1.json', import.meta.url), 'utf8')),
  dataOrigin: 'collected',
};
const comparison = {
  contractVersion: 'comparison/v1', dataOrigin: 'synthetic', completeness: 'complete', appliedScope: 'priority',
  target: { modelNo: '01' }, conditions: { modelNo: '01' }, noticePrice: { status: 'held' },
  regionDecision: { priority: { conclusion: 'candidates' }, expansion: null }, tradeKinds: {}, collections: [],
  comparables: [{ complexId: 'SYNTHETIC_COMPLEX_1' }], targetReferences: [], holds: [], exclusions: [],
  rankingComplete: true,
};
const collectedComparison = { ...comparison, dataOrigin: 'collected' };
const invalid = { code: '22023' };
const missing = { code: 'PT404' };
const conflict = { code: 'PT409' };
const forbidden = { code: '42501' };
const supplementalSources = [
  'synthetic-area-register', 'synthetic-complex-register', 'synthetic-coordinate-register', 'synthetic-region-register',
];
const sourceIds = ['applyhome_apt', 'apt_trade', 'apt_rights', ...supplementalSources];

let db;
let ingestion;

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function as(role, userId = '', anonymous = false) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)",
    [userId, JSON.stringify({ is_anonymous: anonymous })]);
  await db.exec(`set role ${role}`);
}

async function analysis(userId = null, { conditionsSnapshot = conditions, noticeId = null, housingTypeId = null } = {}) {
  await db.exec('reset role');
  if (userId === null) {
    userId = randomUUID();
    await db.query('insert into auth.users(id) values ($1)', [userId]);
  }
  await as('authenticated', userId);
  const chat = await one('insert into public.chats(user_id) values ($1) returning id', [userId]);
  const row = await one(`insert into public.analyses(user_id, chat_id, conditions_snapshot, notice_id, housing_type_id)
    values ($1, $2, $3, $4, $5) returning id`, [userId, chat.id, JSON.stringify(conditionsSnapshot), noticeId, housingTypeId]);
  return { userId, analysisId: row.id };
}

async function rpc(name, ...params) {
  const args = params.map((_, index) => `$${index + 1}`).join(', ');
  return (await one(`select public.${name}(${args}) as reply`, params)).reply;
}

const json = value => value === null ? null : JSON.stringify(value);
const enqueue = (owner, input = synthetic, key = randomUUID()) =>
  rpc('enqueue_analysis_run', owner.analysisId, key, json(input));
const claim = run => rpc('claim_analysis_run', 300, run.runId);
const lease = job => [job.runId, job.generation, job.leaseToken];
const work = job => rpc('read_comparison_work', ...lease(job));
const finish = (job, value = comparison, input = request, result = ingestion) =>
  rpc('finish_analysis_comparison', ...lease(job), json(input), json(result), json(value));
const get = (owner, run) => rpc('get_analysis_comparison', owner.analysisId, run.runId);
const save = (owner, result = ingestion) =>
  rpc('save_ingestion_snapshot', owner.userId, owner.analysisId, randomUUID(), json(request), json(result));
const register = (snapshotId, value = evidence, sources = sourceIds) =>
  rpc('register_comparison_evidence', snapshotId, json(value), sources);
const snapshotCount = async owner => (await one(
  'select count(*)::int as count from public.analysis_input_snapshots where analysis_id = $1', [owner.analysisId])).count;

async function makeDue(run) {
  await db.exec('reset role');
  await db.query("update private.analysis_runs set next_claim_at = clock_timestamp() - interval '1 second' where id = $1",
    [run.runId]);
  await as('service_role');
}

async function saveCollected(owner) {
  // 권한 분기를 위한 합성 행과 표식이다. 실제 출처의 권한이나 수집 사실을 뜻하지 않는다.
  await allowSources(['applyhome_apt', 'applyhome_apt_model', 'apt_trade', 'apt_rights', 'applyhome_notice_pdf']);
  const result = { ...ingestion, dataOrigin: 'collected' };
  return { snapshotId: await save(owner, result), result };
}

async function allowSources(sources = supplementalSources) {
  await db.query(`insert into public.source_registry(id, display_name, storage_permission, reuse_permission, display_permission)
    select id, '합성 비교 근거', 'allowed', 'allowed', 'allowed' from unnest($1::text[]) as source(id)`, [sources]);
}

before(async () => {
  ingestion = JSON.parse(execFileSync('python3', ['scripts/replay_ingestion.py', fixture], { cwd: root, encoding: 'utf8' }));
  db = await createBe03Db();
});
beforeEach(async () => db.exec('reset role; delete from auth.users; delete from public.notices; delete from public.source_registry;'));
after(async () => db?.close());

test('synthetic comparison finishes the BE-04 run and pins its result envelope', async () => {
  const owner = await analysis();
  const run = await enqueue(owner);
  await assert.rejects(get(owner, run), conflict);
  await as('service_role');
  const job = await claim(run);
  assert.deepEqual(await work(job), {
    conditions, ingestion: null, evidence: null, useSyntheticFixture: true, selectionBindingIssue: null,
  });
  const finished = await finish(job);
  assert.equal(finished.status, 'finished');
  assert.ok(finished.snapshotId);
  assert.equal(await snapshotCount(owner), 1);
  await assert.rejects(finish(job, { ...comparison, completeness: 'partial' }), conflict);
  await db.query("update public.analyses set rules_version = 'synthetic-new-rules' where id = $1", [owner.analysisId]);
  await as('authenticated', owner.userId);
  assert.deepEqual(await rpc('get_analysis_run', owner.analysisId, run.runId), finished);
  assert.deepEqual(await get(owner, run), {
    runId: run.runId, analysisId: owner.analysisId, snapshotId: finished.snapshotId, rulesVersion: 'prd-1.0',
    result: comparison,
  });
  assert.equal((await one('select status from public.analyses where id = $1', [owner.analysisId])).status, 'input_ready');
  await assert.rejects(rpc('cancel_analysis_run', owner.analysisId, run.runId), conflict);
  const replay = await enqueue(owner, snapshotInput(finished.snapshotId));
  await as('service_role');
  assert.deepEqual(await work(await claim(replay)), {
    conditions, ingestion, evidence: null, useSyntheticFixture: true, selectionBindingIssue: null,
  });
});

test('only the owner JWT reads results, and only the worker calls comparison work RPCs', async () => {
  const owner = await analysis();
  const sibling = await analysis(owner.userId);
  const stranger = await analysis();
  await as('authenticated', owner.userId);
  const run = await enqueue(owner);
  await as('service_role', owner.userId);
  const job = await claim(run);
  const done = await finish(job);
  await assert.rejects(get(owner, run), forbidden);
  await assert.rejects(one('select * from private.comparison_results'), forbidden);
  await assert.rejects(one('select * from private.comparison_evidence'), forbidden);
  await assert.rejects(db.exec('delete from private.comparison_results'), forbidden);
  await assert.rejects(db.exec("update private.comparison_evidence set evidence = '{}'"), forbidden);

  await as('authenticated', stranger.userId);
  await assert.rejects(get(owner, run), missing);
  await as('authenticated', owner.userId);
  await assert.rejects(get(sibling, run), missing);
  await assert.rejects(get(owner, { runId: randomUUID() }), missing);
  for (const [role, userId, anonymous] of [
    ['authenticated', owner.userId, false], ['authenticated', '', false],
    ['authenticated', owner.userId, true], ['anon', '', false],
  ]) {
    await as(role, userId, anonymous);
    await assert.rejects(work(job), forbidden);
    await assert.rejects(finish(job), forbidden);
    await assert.rejects(register(done.snapshotId), forbidden);
    if (role !== 'authenticated' || userId === '' || anonymous) {
      await assert.rejects(get(owner, run), forbidden);
    }
  }
});

test('existing snapshot work uses the captured conditions and never injects the synthetic demo evidence', async () => {
  const owner = await analysis();
  const sibling = await analysis(owner.userId);
  const stranger = await analysis();
  await as('service_role');
  const snapshotId = await save(owner);
  await assert.rejects(register(snapshotId), invalid);
  await db.query("update public.analyses set conditions_snapshot = '{}' where id = $1", [owner.analysisId]);
  const input = snapshotInput(snapshotId);
  await as('authenticated', stranger.userId);
  await assert.rejects(enqueue(stranger, input), missing);
  await as('authenticated', owner.userId);
  await assert.rejects(enqueue(sibling, input), missing);
  const run = await enqueue(owner, input);
  const removedRun = await enqueue(owner, input);
  await as('service_role');
  const job = await claim(run);
  assert.deepEqual(await work(job), {
    conditions, ingestion, evidence: null, useSyntheticFixture: false, selectionBindingIssue: null,
  });
  await assert.rejects(finish(job), invalid);

  // 아직 완료한 실행이 없는 캡처는 삭제할 수 있다.
  const removed = await claim(removedRun);
  await db.exec('reset role');
  await db.query('delete from public.analysis_input_snapshots where id = $1', [snapshotId]);
  await as('service_role');
  await assert.rejects(work(removed), { code: '22023', message: 'analysis_run_snapshot_missing' });
  await assert.rejects(finish(removed, comparison, null, null), invalid);
  assert.equal((await rpc('fail_analysis_run', ...lease(removed), false)).status, 'failed');
  assert.equal(await snapshotCount(owner), 0);
});

test('collected registration checks evidence identity and all declared and observed sources', async () => {
  const owner = await analysis();
  await as('service_role');
  const { snapshotId } = await saveCollected(owner);
  await assert.rejects(register(randomUUID()), missing);
  await assert.rejects(register(snapshotId), forbidden);
  await allowSources();
  for (const sources of [null, [], [null], ['']]) {
    await assert.rejects(register(snapshotId, evidence, sources), invalid);
  }
  await assert.rejects(register(snapshotId, null), invalid);
  for (const edit of [
    { ...evidence, contractVersion: 'comparison-evidence/v0' },
    { ...evidence, dataOrigin: 'synthetic' },
    { ...evidence, target: { ...evidence.target, edition: 'other' } },
    { ...evidence, target: { ...evidence.target, houseManageNo: 'other' } },
    { ...evidence, target: { ...evidence.target, noticeNo: 'other' } },
    { ...evidence, target: { ...evidence.target, notice: { ...evidence.target.notice, position: 99 } } },
    { ...evidence, target: { ...evidence.target, notice: { ...evidence.target.notice, source: 'apt_trade' } } },
    { ...evidence, target: { ...evidence.target, notice: { ...evidence.target.notice, address: '다른 합성 주소' } } },
    { ...evidence, target: { ...evidence.target, evidence: { source: supplementalSources[0] } } },
    { ...evidence, complexes: {} },
    { ...evidence, complexes: [{ ...evidence.complexes[0], pdfBytes: 'SYNTHETIC_RAW' }] },
  ]) {
    await assert.rejects(register(snapshotId, edit), invalid);
  }
  for (const omitted of ['applyhome_apt', 'apt_trade', ...supplementalSources]) {
    await assert.rejects(register(snapshotId, evidence, sourceIds.filter(id => id !== omitted)), forbidden, omitted);
  }
  await allowSources(['user_upload']);
  await assert.rejects(register(snapshotId, evidence, [...sourceIds, 'user_upload']), forbidden);
  const upload = structuredClone(evidence);
  upload.complexes[0].coordinates.evidence.source = 'user_upload';
  await assert.rejects(register(snapshotId, upload), forbidden);
  await assert.rejects(register(snapshotId, upload, [...sourceIds, 'user_upload']), forbidden);
  for (const column of ['storage_permission', 'reuse_permission', 'display_permission']) {
    for (const permission of ['unknown', 'denied']) {
      await db.query(`update public.source_registry set ${column} = $1 where id = $2`, [permission, supplementalSources[0]]);
      await assert.rejects(register(snapshotId), forbidden);
    }
    await db.query(`update public.source_registry set ${column} = 'allowed' where id = $1`, [supplementalSources[0]]);
  }
  await db.exec("update public.source_registry set display_permission = 'unknown' where id = 'applyhome_notice_pdf'");
  await assert.rejects(register(snapshotId), forbidden);
  await db.exec("update public.source_registry set display_permission = 'allowed' where id = 'applyhome_notice_pdf'");
  await db.query('update public.source_registry set retention_days = 1 where id = $1', [supplementalSources[0]]);
  await assert.rejects(register(snapshotId), forbidden);
  await db.query('update public.source_registry set retention_days = null where id = $1', [supplementalSources[0]]);
  assert.equal(await register(snapshotId), snapshotId);
  assert.equal(await register(snapshotId, evidence, [...sourceIds].reverse()), snapshotId);
  const changed = { ...evidence, target: { ...evidence.target, complexId: 'different-complex' } };
  await assert.rejects(register(snapshotId, changed), { code: '23505' });
  await assert.rejects(register(snapshotId, evidence, [...sourceIds, 'applyhome_notice_pdf']), { code: '23505' });
});

test('submission pins evidence or its absence across late registration, duplicate enqueue and retry', async () => {
  const owner = await analysis();
  await as('service_role');
  const { snapshotId, result } = await saveCollected(owner);
  await allowSources();
  const input = snapshotInput(snapshotId);
  const key = randomUUID();
  await as('authenticated', owner.userId);
  const prior = await enqueue(owner, input, key);
  await as('service_role');
  await register(snapshotId);
  await db.query("update public.source_registry set display_permission = 'denied' where id = $1",
    [supplementalSources[0]]);
  const first = await claim(prior);
  assert.deepEqual(await work(first), {
    conditions, ingestion: result, evidence: null, useSyntheticFixture: false, selectionBindingIssue: null,
  });
  await rpc('fail_analysis_run', ...lease(first), true);
  await as('authenticated', owner.userId);
  assert.equal((await enqueue(owner, input, key)).runId, prior.runId);
  const newRun = await enqueue(owner, input);
  await makeDue(prior);
  const retry = await claim(prior);
  await assert.rejects(work(first), conflict);
  await assert.rejects(finish(first, collectedComparison, null, null), conflict);
  assert.deepEqual(await work(retry), {
    conditions, ingestion: result, evidence: null, useSyntheticFixture: false, selectionBindingIssue: null,
  });
  assert.equal((await finish(retry, collectedComparison, null, null)).snapshotId, snapshotId);
  const newJob = await claim(newRun);
  await assert.rejects(work(newJob), forbidden);
  await db.query("update public.source_registry set display_permission = 'allowed' where id = $1",
    [supplementalSources[0]]);
  const pinnedWork = { conditions, ingestion: result, evidence, useSyntheticFixture: false, selectionBindingIssue: null };
  assert.deepEqual(await work(newJob), pinnedWork);
  await rpc('fail_analysis_run', ...lease(newJob), true);
  await makeDue(newRun);
  const newRetry = await claim(newRun);
  assert.deepEqual(await work(newRetry), pinnedWork);
  assert.equal((await finish(newRetry, collectedComparison, null, null)).snapshotId, snapshotId);
  assert.equal(await snapshotCount(owner), 1);
  await as('authenticated', owner.userId);
  for (const run of [prior, newRun]) {
    assert.deepEqual(await get(owner, run), {
      runId: run.runId, analysisId: owner.analysisId, snapshotId, rulesVersion: 'prd-1.0', result: collectedComparison,
    });
  }
});

test('a matching user target cannot certify a frozen unrelated notice or housing UUID', async () => {
  await allowSources(['synthetic-catalog']);
  const { id: noticeId } = await one(`insert into public.notices(source_id, external_id, title, notice_kind, collected_at)
    values ('synthetic-catalog', 'unrelated-synthetic-notice', '별도 합성 공고', 'unknown', now()) returning id`);
  const { id: housingTypeId } = await one(`insert into public.housing_types(notice_id, external_type_id, label)
    values ($1, '01', '합성 주택형') returning id`, [noticeId]);
  for (const [conditionsSnapshot, selectedNotice, selectedHousing, issue] of [
    [conditions, noticeId, housingTypeId, 'target_identity_unverified'],
    [matchedConditions, noticeId, housingTypeId, 'target_identity_unverified'],
    [matchedConditions, noticeId, null, 'target_identity_unverified'],
    [matchedConditions, null, null, null],
  ]) {
    const owner = await analysis(null, { conditionsSnapshot, noticeId: selectedNotice, housingTypeId: selectedHousing });
    const syntheticRun = await enqueue(owner);
    await as('service_role');
    const snapshotId = await save(owner);
    await db.query("update public.analyses set conditions_snapshot = '{}', housing_type_id = null, notice_id = null where id = $1",
      [owner.analysisId]);
    await as('authenticated', owner.userId);
    const snapshotRun = await enqueue(owner, snapshotInput(snapshotId));
    await as('service_role');
    assert.deepEqual(await work(await claim(syntheticRun)), {
      conditions: conditionsSnapshot, ingestion: null, evidence: null, useSyntheticFixture: true,
      selectionBindingIssue: issue,
    });
    assert.deepEqual(await work(await claim(snapshotRun)), {
      conditions: conditionsSnapshot, ingestion, evidence: null, useSyntheticFixture: false,
      selectionBindingIssue: issue,
    });
  }

  // 사용자 접수 경로에서 만들 수 없는 주택형 UUID 단독 실행 행을 합성한다.
  const owner = await analysis(null, { conditionsSnapshot: matchedConditions });
  const run = await enqueue(owner);
  await db.exec('reset role');
  await db.query('update private.analysis_runs set housing_type_id = $2 where id = $1', [run.runId, housingTypeId]);
  await as('service_role');
  assert.equal((await work(await claim(run))).selectionBindingIssue, 'housing_type_identity_unverified');
});

test('current collected source rights gate reads and writes without rewriting saved results', async () => {
  const owner = await analysis();
  const stranger = await analysis();
  await as('service_role');
  const { snapshotId, result } = await saveCollected(owner);
  await allowSources();
  await register(snapshotId);
  await as('authenticated', owner.userId);
  const run = await enqueue(owner, snapshotInput(snapshotId));
  await as('service_role');
  const job = await claim(run);
  assert.equal((await work(job)).ingestion.dataOrigin, 'collected');
  for (const [id, column, blocked, allowed] of [
    ['applyhome_apt', 'reuse_permission', 'unknown', 'allowed'],
    ['applyhome_apt_model', 'display_permission', 'denied', 'allowed'],
    ['apt_trade', 'reuse_permission', 'denied', 'allowed'],
    ['apt_rights', 'storage_permission', 'denied', 'allowed'],
    ['applyhome_notice_pdf', 'display_permission', 'unknown', 'allowed'],
    [supplementalSources[0], 'retention_days', 1, null],
    [supplementalSources[1], 'display_permission', 'denied', 'allowed'],
  ]) {
    await db.query(`update public.source_registry set ${column} = $1 where id = $2`, [blocked, id]);
    await assert.rejects(work(job), forbidden, id);
    await assert.rejects(finish(job, collectedComparison, null, null), forbidden, id);
    await db.query(`update public.source_registry set ${column} = $1 where id = $2`, [allowed, id]);
  }
  assert.deepEqual((await work(job)).ingestion, result);
  await finish(job, collectedComparison, null, null);
  await as('authenticated', owner.userId);
  const saved = await get(owner, run);
  for (const id of ['applyhome_notice_pdf', supplementalSources[0]]) {
    await as('service_role');
    await db.query("update public.source_registry set display_permission = 'denied' where id = $1", [id]);
    await as('authenticated', owner.userId);
    await assert.rejects(get(owner, run), { code: 'PT403', message: 'comparison_source_restricted' });
    assert.equal((await rpc('get_analysis_run', owner.analysisId, run.runId)).status, 'finished');
    await as('authenticated', stranger.userId);
    await assert.rejects(get(owner, run), missing);
    await as('service_role');
    await db.query("update public.source_registry set display_permission = 'allowed' where id = $1", [id]);
    await as('authenticated', owner.userId);
    assert.deepEqual(await get(owner, run), saved);
  }
});

test('invalid comparison shape or origin cannot leave a capture or finish the run', async () => {
  const owner = await analysis();
  const run = await enqueue(owner);
  await as('service_role');
  const job = await claim(run);
  const required = ['appliedScope', 'target', 'conditions', 'noticePrice', 'regionDecision', 'tradeKinds', 'collections', 'rankingComplete'];
  for (const field of required) {
    const omitted = { ...comparison };
    delete omitted[field];
    await assert.rejects(finish(job, omitted), invalid, field);
  }
  for (const value of [null, [], { ...comparison, contractVersion: 'comparison/v0' },
    { ...comparison, dataOrigin: 'collected' }, { ...comparison, completeness: 'finished' },
    { ...comparison, appliedScope: false }, { ...comparison, comparables: Array(6).fill({}) },
    { ...comparison, comparables: {} }, { ...comparison, targetReferences: null },
    { ...comparison, holds: {} }, { ...comparison, exclusions: 0 }, { ...comparison, target: [] },
    { ...comparison, conditions: null }, { ...comparison, noticePrice: 'unavailable' },
    { ...comparison, regionDecision: null }, { ...comparison, tradeKinds: [] }, { ...comparison, collections: {} },
    { ...comparison, rankingComplete: 'true' }, { ...comparison, noticePrice: { rawPdf: 'SYNTHETIC_RAW' } }]) {
    await assert.rejects(finish(job, value), invalid);
    assert.equal(await snapshotCount(owner), 0);
  }
  await as('authenticated', owner.userId);
  assert.equal((await rpc('get_analysis_run', owner.analysisId, run.runId)).status, 'running');
  await assert.rejects(get(owner, run), conflict);
  await as('service_role');
  const unavailable = {
    ...comparison, completeness: 'unavailable', appliedScope: null, target: null, noticePrice: null,
    comparables: [], rankingComplete: false,
  };
  const done = await finish(job, unavailable);
  assert.equal(done.status, 'finished');
  await as('authenticated', owner.userId);
  assert.deepEqual((await get(owner, run)).result, unavailable);
});

test('read and finish reject the wrong lease, expiry and cancellation while results remain unavailable', async () => {
  const owner = await analysis();
  const run = await enqueue(owner);
  await as('service_role');
  const job = await claim(run);
  for (const invalidJob of [{ ...job, generation: job.generation + 1 }, { ...job, leaseToken: randomUUID() }]) {
    await assert.rejects(work(invalidJob), conflict);
    await assert.rejects(finish(invalidJob), conflict);
  }
  await makeDue(run);
  await assert.rejects(work(job), conflict);
  await assert.rejects(finish(job), conflict);
  const retry = await claim(run);
  await as('authenticated', owner.userId);
  await assert.rejects(get(owner, run), conflict);
  assert.equal((await rpc('cancel_analysis_run', owner.analysisId, run.runId)).status, 'cancelled');
  await assert.rejects(get(owner, run), conflict);
  await as('service_role');
  await assert.rejects(work(retry), conflict);
  await assert.rejects(finish(retry), conflict);
  assert.equal(await snapshotCount(owner), 0);
});

test('expiry during the comparison insert rolls back a capture and leaves the run recoverable', async () => {
  const owner = await analysis();
  const run = await enqueue(owner);
  await as('service_role');
  const job = await claim(run);
  await db.exec('reset role');
  await db.exec(`create temporary sequence comparison_insert_probe;
    create function private.delay_comparison_insert() returns trigger language plpgsql as $$
    begin
      perform nextval('pg_temp.comparison_insert_probe');
      perform pg_sleep(1.1);
      return new;
    end; $$;
    create trigger delay_comparison_insert before insert on private.comparison_results
      for each row execute function private.delay_comparison_insert();`);
  try {
    await db.query("update private.analysis_runs set next_claim_at = clock_timestamp() + interval '1 second' where id = $1",
      [run.runId]);
    await as('service_role');
    await assert.rejects(finish(job), { code: 'PT409', message: 'analysis_run_stale_lease' });
    assert.equal(await snapshotCount(owner), 0);
    await db.exec('reset role');
    assert.equal((await one('select is_called from pg_temp.comparison_insert_probe')).is_called, true);
    assert.equal(await one('select run_id from private.comparison_results where run_id = $1', [run.runId]), undefined);
  } finally {
    await db.exec(`reset role;
      drop trigger delay_comparison_insert on private.comparison_results;
      drop function private.delay_comparison_insert();
      drop sequence pg_temp.comparison_insert_probe;`);
  }
  await as('authenticated', owner.userId);
  assert.equal((await rpc('get_analysis_run', owner.analysisId, run.runId)).status, 'running');
  await assert.rejects(get(owner, run), conflict);
  await as('service_role');
  const retry = await claim(run);
  assert.equal(retry.generation, 2);
  assert.equal((await finish(retry)).status, 'finished');
  assert.equal(await snapshotCount(owner), 1);
});

test('BE-04 finish stays compatible and legacy captures do not receive BE-05 demo evidence', async () => {
  const owner = await analysis();
  const legacy = await enqueue(owner);
  const fails = await enqueue(owner);
  await as('service_role');
  const operation = await rpc('finish_analysis_run', ...lease(await claim(legacy)), json(request), json(ingestion));
  await rpc('fail_analysis_run', ...lease(await claim(fails)), false);
  await as('authenticated', owner.userId);
  assert.deepEqual(await rpc('get_analysis_run', owner.analysisId, legacy.runId), operation);
  await assert.rejects(get(owner, legacy), conflict);
  await assert.rejects(get(owner, fails), conflict);
  const reuse = await enqueue(owner, snapshotInput(operation.snapshotId));
  await as('service_role');
  assert.deepEqual(await work(await claim(reuse)), {
    conditions, ingestion, evidence: null, useSyntheticFixture: false, selectionBindingIssue: null,
  });
});

test('account deletion cascades the comparison and its source evidence without touching another owner', async () => {
  const owner = await analysis();
  const stranger = await analysis();
  const otherRun = await enqueue(stranger);
  await as('service_role');
  await finish(await claim(otherRun));
  const { snapshotId } = await saveCollected(owner);
  await allowSources();
  await register(snapshotId);
  await as('authenticated', owner.userId);
  const run = await enqueue(owner, snapshotInput(snapshotId));
  const pending = await enqueue(owner, snapshotInput(snapshotId));
  await as('service_role');
  await finish(await claim(run), collectedComparison, null, null);
  const job = await claim(pending);
  await db.exec('reset role');
  await db.query('delete from auth.users where id = $1', [owner.userId]);
  assert.equal(await one('select run_id from private.comparison_results where run_id = $1', [run.runId]), undefined);
  assert.equal(await one('select snapshot_id from private.comparison_evidence where snapshot_id = $1', [snapshotId]), undefined);
  assert.equal(await snapshotCount(owner), 0);
  await as('service_role');
  await assert.rejects(work(job), missing);
  await assert.rejects(finish(job, collectedComparison, null, null), missing);
  await as('authenticated', stranger.userId);
  await assert.rejects(get(owner, run), missing);
  assert.deepEqual((await get(stranger, otherRun)).result, comparison);
});
