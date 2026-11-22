// 합성 공고와 법령 식별값으로 저장·조회 계약 및 PGlite 권한을 검사한다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, before, beforeEach, test } from 'node:test';
import { createBe03Db } from './helpers/be03-db.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/ingestion-v0.json', import.meta.url), 'utf8'));
const apt = 'applyhome_apt';
const remainder = 'applyhome_remainder';
const law = 'law_eflaw';
const unrelatedSources = [apt + '_model', remainder + '_model', 'applyhome_notice_pdf', 'apt_trade', 'apt_rights'];
const noticeDate = '2026-10-05';
const reference = {
  contractVersion: 'law-reference/v1', dataOrigin: 'collected', title: '주택공급에 관한 규칙',
  asOf: noticeDate, observedAt: '2026-11-12T11:12:13.123456789+09:00',
  mst: '90071992547409931234', lawId: '00090071992547409931',
  promulgatedOn: '2026-09-02', effectiveOn: '2026-09-05',
  articles: [{ number: '2', branch: null, heading: '합성 조문 제목' },
    { number: '2', branch: '1', heading: '합성 가지 조문 제목' }],
};
const laterReference = { ...reference, observedAt: '2026-11-12T02:12:13.123456790Z' };
const forbidden = { code: '42501' };
const authenticationRequired = { ...forbidden, message: 'legal_authentication_required' };
const invalid = { code: '22023' };
const notFound = { code: 'PT404' };
const publicationConflict = { code: 'PT409' };
const emptyEvidence = { noticeDate: null, reference: null };
const replays = new Map();
let db;

before(() => {
  const command = ['import json, sys', 'sys.path.insert(0, "scripts")',
    'from replay_ingestion import loads_source_json, replay',
    'print(json.dumps(replay(loads_source_json(sys.stdin.read())), ensure_ascii=False))'].join('\n');
  for (const source of [apt, remainder]) {
    const replayFixture = structuredClone(fixture);
    replayFixture.request.noticeSource = source;
    for (const page of replayFixture.pages) {
      if (page.source === apt) page.source = source;
      if (page.source === apt + '_model') page.source = source + '_model';
    }
    const result = JSON.parse(execFileSync('python3', ['-B', '-c', command], {
      cwd: new URL('../../', import.meta.url), input: JSON.stringify(replayFixture), encoding: 'utf8',
    }));
    replays.set(source, { input: replayFixture.request, result });
  }
});

beforeEach(async () => {
  db = await createBe03Db();
  await db.exec(`alter table auth.users add column confirmed_at timestamptz,
    add column is_anonymous boolean not null default false,
    add column banned_until timestamptz, add column deleted_at timestamptz`);
});

afterEach(async () => { await db?.close(); });

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function as(role, userId = '', anonymous = false) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub',$1,false),
    set_config('request.jwt.claims',$2,false)`, [userId, JSON.stringify({ sub: userId, is_anonymous: anonymous })]);
  await db.exec(`set role ${role}`);
}

async function permitSources(sources) {
  await db.exec('reset role');
  await db.query(`insert into public.source_registry(id,display_name,storage_permission,reuse_permission,display_permission)
    select id,'권한 검사용 합성 출처','allowed','allowed','allowed' from unnest($1::text[]) as source(id)`, [sources]);
}

async function analysis({ userId, source = apt, conditions, noticeId = null } = {}) {
  await db.exec('reset role');
  if (!userId) {
    userId = randomUUID();
    await db.query('insert into auth.users(id,confirmed_at) values ($1,now())', [userId]);
  }
  const chat = await one("insert into public.chats(user_id,title) values ($1,'합성 대화') returning id", [userId]);
  const input = replays.get(source).input;
  const binding = conditions ?? { ingestion_target: { noticeSource: source, ...input.target } };
  const row = await one(`insert into public.analyses(user_id,chat_id,conditions_snapshot,notice_id)
    values ($1,$2,$3,$4) returning id`, [userId, chat.id, JSON.stringify(binding), noticeId]);
  return { userId, analysisId: row.id };
}

async function capture(owner, { source = apt, origin = 'collected', adjustNotice = () => {} } = {}) {
  const { input, result } = replays.get(source);
  const snapshot = { ...structuredClone(result), dataOrigin: origin };
  adjustNotice(snapshot.catalog.notice);
  await as('service_role');
  return (await one('select public.save_ingestion_snapshot($1,$2,$3,$4,$5) as id', [
    owner.userId, owner.analysisId, randomUUID(), JSON.stringify(input), JSON.stringify(snapshot),
  ])).id;
}

function publish(value = reference) {
  return db.query('select public.publish_law_reference($1::jsonb)', [value === null ? null : JSON.stringify(value)]);
}

async function read(analysisId, snapshotId) {
  return (await one('select public.read_analysis_legal_evidence($1,$2) as value', [analysisId, snapshotId])).value;
}

function expected(owner, snapshotId, status, fields = {}) {
  return { analysisId: owner.analysisId, snapshotId, dataOrigin: 'collected', noticeSource: apt,
    status, ...emptyEvidence, ...fields };
}

test('only the worker can publish and only the verified owner can read their analysis and snapshot', async () => {
  const { rows: grants } = await db.query(`select n.nspname as schema, p.proname as name, p.prosecdef as definer,
    has_function_privilege('anon',p.oid,'execute') as anon,
    has_function_privilege('authenticated',p.oid,'execute') as authenticated,
    has_function_privilege('service_role',p.oid,'execute') as service_role
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private') and p.proname in ('publish_law_reference','read_analysis_legal_evidence')
    order by n.nspname,p.proname`);
  assert.deepEqual(grants, [
    { schema: 'private', name: 'publish_law_reference', definer: true, anon: false, authenticated: false, service_role: true },
    { schema: 'private', name: 'read_analysis_legal_evidence', definer: true, anon: false, authenticated: true, service_role: false },
    { schema: 'public', name: 'publish_law_reference', definer: false, anon: false, authenticated: false, service_role: true },
    { schema: 'public', name: 'read_analysis_legal_evidence', definer: false, anon: false, authenticated: true, service_role: false },
  ]);
  assert.deepEqual(await one(`select relrowsecurity as rls, to_regclass('public.law_references') is null as private_only
    from pg_class where oid = 'private.law_references'::regclass`), { rls: true, private_only: true });
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal((await one(`select has_table_privilege($1,'private.law_references','select,insert,update,delete') as allowed`, [role])).allowed, false);
  }

  const owner = await analysis();
  const sibling = await analysis({ userId: owner.userId });
  const stranger = await analysis();
  const snapshot = await capture(owner, { origin: 'synthetic' });
  for (const role of ['anon', 'authenticated']) {
    await as(role, owner.userId);
    await assert.rejects(publish(), forbidden);
  }
  for (const [role, userId, anonymous] of [
    ['anon', owner.userId], ['service_role', owner.userId], ['authenticated', ''],
    ['authenticated', randomUUID()], ['authenticated', owner.userId, true],
  ]) {
    await as(role, userId, anonymous);
    await assert.rejects(read(owner.analysisId, snapshot), role === 'authenticated' ? authenticationRequired : forbidden);
  }
  for (const [restriction, restore] of [
    ['confirmed_at = null', 'confirmed_at = now()'],
    ['is_anonymous = true', 'is_anonymous = false'],
    ["banned_until = now() + interval '1 day'", 'banned_until = null'],
    ['deleted_at = now()', 'deleted_at = null'],
  ]) {
    await db.exec('reset role');
    await db.query(`update auth.users set ${restriction} where id = $1`, [owner.userId]);
    await as('authenticated', owner.userId);
    await assert.rejects(read(owner.analysisId, snapshot), authenticationRequired);
    await db.exec('reset role');
    await db.query(`update auth.users set ${restore} where id = $1`, [owner.userId]);
  }
  await as('authenticated', stranger.userId);
  await assert.rejects(read(owner.analysisId, snapshot), notFound);
  assert.equal((await one('select id from public.analysis_input_snapshots where id = $1', [snapshot])), undefined);
  await as('authenticated', owner.userId);
  for (const [analysisId, snapshotId] of [
    [sibling.analysisId, snapshot], [stranger.analysisId, snapshot],
    [owner.analysisId, randomUUID()], [null, snapshot], [owner.analysisId, null],
  ]) {
    await assert.rejects(read(analysisId, snapshotId), notFound);
  }
  assert.deepEqual(await read(owner.analysisId, snapshot), expected(owner, snapshot, 'synthetic_input', { dataOrigin: 'synthetic' }));
});

test('publication requires current law permissions and advances each day only to a newer observation', async () => {
  assert.equal((await one('select id from public.source_registry where id = $1', [law])), undefined);
  await as('service_role');
  await assert.rejects(publish(), forbidden);
  await permitSources([law]);
  for (const [column, restricted] of [
    ['storage_permission', 'denied'], ['reuse_permission', 'unknown'],
    ['display_permission', 'denied'], ['retention_days', 1],
  ]) {
    await db.query(`update public.source_registry set ${column} = $1 where id = $2`, [restricted, law]);
    await as('service_role');
    await assert.rejects(publish(), forbidden);
    await db.exec('reset role');
    await db.query(`update public.source_registry set ${column} = $1 where id = $2`,
      [column === 'retention_days' ? null : 'allowed', law]);
  }
  await as('service_role');
  await Promise.all([publish(), publish()]);
  await assert.rejects(publish({ ...reference, mst: '90071992547409931235' }), publicationConflict);
  await assert.rejects(publish({ ...reference, observedAt: '2026-11-12T02:12:13.123456789Z' }), publicationConflict);
  await publish(laterReference);
  await publish(laterReference);
  await assert.rejects(publish(), publicationConflict);
  await assert.rejects(publish({ ...reference, mst: '90071992547409931235' }), publicationConflict);
  await db.exec('reset role');
  assert.deepEqual((await db.query('select reference_value from private.law_references')).rows,
    [{ reference_value: laterReference }]);
});

test('publication accepts only bounded calendar, timestamp, identifier and article metadata', async () => {
  await permitSources([law]);
  await as('service_role');
  const [article] = reference.articles;
  const { asOf, ...missingAsOf } = reference;
  const { branch, ...missingBranch } = article;
  for (const payload of [
    null, [], {}, missingAsOf,
    { ...reference, contractVersion: 'law-reference/v2' }, { ...reference, dataOrigin: 'synthetic' },
    { ...reference, title: '주택공급에 관한 규칙 ' },
    { ...reference, url: 'https://example.invalid/law' }, { ...reference, OC: 'synthetic-marker' },
    ...[900719925, '', '0x1', '00', '1'.repeat(21), '123\n'].map(mst => ({ ...reference, mst })),
    ...[null, 987654, '0', '１２'].map(lawId => ({ ...reference, lawId })),
    ...['20261005', '2026.10.05', '2026-09-31', '0000-09-01', '2026-10-05\n'].map(asOf => ({ ...reference, asOf })),
    { ...reference, promulgatedOn: '2026-10-06' }, { ...reference, effectiveOn: '2026-10-06' },
    { ...reference, effectiveOn: '2026-02-29' },
    ...[null, '2026-10-04T14:59:59Z', '2026-10-05T00:00:00', '2026-02-30T00:00:00Z',
      '2026-11-12T00:00:00+24:00', '9999-01-01T00:00:00Z'].map(observedAt => ({ ...reference, observedAt })),
    ...[null, {}, [], Array.from({ length: 65 }, (_, index) => ({ ...article, number: String(index + 1) })),
      [missingBranch], [null], [article, { ...article, heading: '다른 합성 제목' }],
      [{ ...article, text: '합성 본문' }], [{ ...article, body: '합성 본문' }],
      ...[0, '0', '02', '10000'].map(number => [{ ...article, number }]),
      ...[1, '0', '01', '100'].map(branch => [{ ...article, branch }]),
      ...[null, '', ' ', '가'.repeat(161), '첫째 줄\n둘째 줄', '<b>합성</b>', 'https://example.invalid/law',
        'OC=synthetic-marker'].map(heading => [{ ...article, heading }]),
    ].map(articles => ({ ...reference, articles })),
  ]) {
    await assert.rejects(publish(payload), invalid);
  }
  const maxArticles = Array.from({ length: 64 }, (_, index) => ({
    number: String(9936 + index), branch: '99', heading: '𠮷'.repeat(160),
  }));
  await publish({ ...reference, observedAt: '2026-10-04T15:00:00Z', articles: maxArticles });
});

test('shares the latest exact-day version across owners and supported notice date formats', async () => {
  await permitSources([apt, remainder, law, ...unrelatedSources]);
  const first = await analysis();
  const second = await analysis({ source: remainder });
  const firstSnapshot = await capture(first);
  const secondSnapshot = await capture(second, { source: remainder, adjustNotice: notice => {
    notice.fields.RCRIT_PBLANC_DE.value = '20261005';
  } });
  const dottedSnapshot = await capture(first, { adjustNotice: notice => {
    notice.fields.RCRIT_PBLANC_DE.value = '2026.10.05';
  } });
  await publish({ ...reference, asOf: '2026-11-10' });
  await as('authenticated', first.userId);
  assert.deepEqual(await read(first.analysisId, firstSnapshot), expected(first, firstSnapshot, 'version_unverified', { noticeDate }));

  await as('service_role');
  await publish();
  await db.exec('reset role');
  await db.query("update public.analyses set conditions_snapshot = '{}' where id = $1", [first.analysisId]);
  await as('authenticated', first.userId);
  assert.deepEqual(await read(first.analysisId, firstSnapshot), expected(first, firstSnapshot, 'available', { noticeDate, reference }));
  assert.deepEqual(await read(first.analysisId, dottedSnapshot), expected(first, dottedSnapshot, 'available', { noticeDate, reference }));
  await assert.rejects(read(second.analysisId, secondSnapshot), notFound);
  await as('authenticated', second.userId);
  assert.deepEqual(await read(second.analysisId, secondSnapshot),
    expected(second, secondSnapshot, 'available', { noticeSource: remainder, noticeDate, reference }));

  const revisedReference = { ...laterReference, mst: '90071992547409931235' };
  await as('service_role');
  await publish(revisedReference);
  await as('authenticated', first.userId);
  assert.deepEqual(await read(first.analysisId, firstSnapshot),
    expected(first, firstSnapshot, 'available', { noticeDate, reference: revisedReference }));
  await as('authenticated', second.userId);
  assert.deepEqual(await read(second.analysisId, secondSnapshot),
    expected(second, secondSnapshot, 'available', { noticeSource: remainder, noticeDate, reference: revisedReference }));
});

test('requires an explicit captured binding and an actually reported notice calendar date', async () => {
  await permitSources([apt, law, ...unrelatedSources]);
  const owner = await analysis();
  const unspecified = await analysis({ conditions: {} });
  const legacyNotice = await one(`insert into public.notices(source_id,external_id,title,notice_kind,collected_at)
    values ($1,'synthetic-catalog-notice','합성 카탈로그 공고','unknown',now()) returning id`, [apt]);
  const legacy = await analysis({ conditions: {}, noticeId: legacyNotice.id });
  const ambiguous = await analysis({ noticeId: legacyNotice.id });
  const unboundSnapshot = await capture(unspecified);
  const legacySnapshot = await capture(legacy);
  const ambiguousSnapshot = await capture(ambiguous);
  const inconsistent = await capture(owner);
  await publish();
  await publish({ ...reference, asOf: '2026-11-10' });
  await db.exec('reset role');
  // 저장된 matched 표기만으로는 번호쌍·회차에 대한 명시적 선택을 복원할 수 없다.
  await db.query("update public.analysis_input_snapshots set conditions_snapshot = '{}' where id = $1", [inconsistent]);
  await as('authenticated', unspecified.userId);
  assert.deepEqual(await read(unspecified.analysisId, unboundSnapshot), expected(unspecified, unboundSnapshot, 'selection_unverified'));
  await as('authenticated', legacy.userId);
  assert.deepEqual(await read(legacy.analysisId, legacySnapshot), expected(legacy, legacySnapshot, 'selection_unverified'));
  await as('authenticated', ambiguous.userId);
  assert.deepEqual(await read(ambiguous.analysisId, ambiguousSnapshot), expected(ambiguous, ambiguousSnapshot, 'selection_unverified'));
  await as('authenticated', owner.userId);
  assert.deepEqual(await read(owner.analysisId, inconsistent), expected(owner, inconsistent, 'selection_unverified'));

  for (const adjustNotice of [
    notice => { notice.fields = null; },
    notice => { delete notice.fields.RCRIT_PBLANC_DE; },
    notice => { notice.fields.RCRIT_PBLANC_DE = { status: 'missing', value: null }; },
    notice => { notice.fields.RCRIT_PBLANC_DE = { status: 'conflict', value: noticeDate }; },
    notice => { notice.fields.RCRIT_PBLANC_DE = { status: 'reported', value: 20261005 }; },
    ...[null, '2026-02-29', '2026.02.29', '20260230', '2026.10-05', '2026-10.05',
      '2026.1.05', '2026.10.05.', '2026-10-05 ', '2026-10-05T00:00:00Z']
      .map(value => notice => { notice.fields.RCRIT_PBLANC_DE.value = value; }),
    notice => { notice.status = 'partially_collected'; },
    notice => { notice.evidence = []; },
  ]) {
    const snapshot = await capture(owner, { adjustNotice });
    await as('authenticated', owner.userId);
    assert.deepEqual(await read(owner.analysisId, snapshot), expected(owner, snapshot, 'notice_date_unverified'));
  }
});

test('checks only law and date feed rights and masks date and binding details under a feed restriction', async () => {
  await permitSources([apt, remainder, law, ...unrelatedSources]);
  const owner = await analysis();
  const snapshot = await capture(owner);
  const unbound = await analysis({ userId: owner.userId, conditions: {} });
  const unboundSnapshot = await capture(unbound);
  const untimedSnapshot = await capture(owner, { adjustNotice: notice => { notice.fields = null; } });
  await publish();
  await db.exec('reset role');
  await db.query(`update public.source_registry set storage_permission = 'denied',reuse_permission = 'denied',
    display_permission = 'denied',retention_days = 1 where id = any($1::text[])`, [[remainder, ...unrelatedSources]]);
  await as('authenticated', owner.userId);
  assert.deepEqual(await read(owner.analysisId, snapshot), expected(owner, snapshot, 'available', { noticeDate, reference }));
  assert.deepEqual(await read(unbound.analysisId, unboundSnapshot), expected(unbound, unboundSnapshot, 'selection_unverified'));
  assert.deepEqual(await read(owner.analysisId, untimedSnapshot), expected(owner, untimedSnapshot, 'notice_date_unverified'));

  for (const source of [law, apt]) {
    for (const [column, restricted] of [
      ['storage_permission', 'denied'], ['reuse_permission', 'unknown'],
      ['display_permission', 'denied'], ['retention_days', 1],
    ]) {
      await db.exec('reset role');
      await db.query(`update public.source_registry set ${column} = $1 where id = $2`, [restricted, source]);
      if (source === law) {
        await as('service_role');
        await assert.rejects(publish(), forbidden);
      }
      await as('authenticated', owner.userId);
      const visible = source === law ? { noticeDate } : {};
      assert.deepEqual(await read(owner.analysisId, snapshot), expected(owner, snapshot, 'source_restricted', visible));
      if (source === apt) {
        assert.deepEqual(await read(unbound.analysisId, unboundSnapshot), expected(unbound, unboundSnapshot, 'source_restricted'));
        assert.deepEqual(await read(owner.analysisId, untimedSnapshot), expected(owner, untimedSnapshot, 'source_restricted'));
      }
      await db.exec('reset role');
      await db.query(`update public.source_registry set ${column} = $1 where id = $2`,
        [column === 'retention_days' ? null : 'allowed', source]);
    }
    await db.query('delete from public.source_registry where id = $1', [source]);
    await as('authenticated', owner.userId);
    assert.deepEqual(await read(owner.analysisId, snapshot),
      expected(owner, snapshot, 'source_restricted', source === law ? { noticeDate } : {}));
    await permitSources([source]);
  }
  await as('authenticated', owner.userId);
  assert.deepEqual(await read(owner.analysisId, snapshot), expected(owner, snapshot, 'available', { noticeDate, reference }));
});
