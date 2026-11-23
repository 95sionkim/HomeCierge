// 합성 Auth·공고 색인·비교 결과와 PGlite로 공유 탐색 프로필 RPC 계약을 검사한다.
// 실제 인증·Storage·외부 API는 호출하지 않으며 모든 지역·공고·사유는 합성 자료다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBe03Db } from './helpers/be03-db.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { request: fixtureRequest } = JSON.parse(readFileSync(new URL('../fixtures/ingestion-v0.json', import.meta.url), 'utf8'));
const fixtureEvidence = JSON.parse(readFileSync(new URL('../fixtures/comparison-evidence-v1.json', import.meta.url), 'utf8'));
const syntheticInput = { kind: 'synthetic', fixture: 'ingestion-v0' };
const koreanDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });
const directorySources = ['applyhome_apt', 'applyhome_remainder', 'mois_legal_region_codes'];

const authRequired = { code: '42501', message: 'authentication_required' };
const forbidden = { code: '42501' };
const managedOnly = { code: '42501', message: 'managed_profile_change_requires_rpc' };
const regionsUnavailable = { code: 'PT403', message: 'profile_regions_unavailable' };
const cursorNotFound = { code: 'PT404', message: 'search_profile_cursor_not_found' };
const changeNotFound = { code: 'PT404', message: 'search_profile_change_not_found' };
const originNotFound = { code: 'PT404', message: 'search_profile_origin_not_found' };
const originNotReady = { code: 'PT409', message: 'search_profile_origin_not_ready' };
const revisionConflict = { code: 'PT409', message: 'search_profile_revision_conflict' };
const requestConflict = { code: 'PT409', message: 'search_profile_request_conflict' };
const decisionConflict = { code: 'PT409', message: 'search_profile_decision_conflict' };
const invalidPatch = { code: '22023', message: 'invalid_search_profile_patch' };
const invalidReason = { code: '22023', message: 'invalid_search_profile_reason' };
const invalidDecision = { code: '22023', message: 'invalid_search_profile_decision' };
const invalidOrigin = { code: '22023', message: 'invalid_search_profile_origin' };
const invalidRequest = { code: '22023', message: 'invalid_search_profile_request' };
const invalidRegion = { code: '22023', message: 'invalid_search_profile_region' };
const unchanged = { code: '22023', message: 'search_profile_unchanged' };

let db;
let syntheticIngestion;

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function as(role, userId = '', claims = { is_anonymous: false }) {
  await db.exec('reset role');
  const jwt = { ...(userId ? { sub: userId } : {}), ...claims };
  await db.query(
    "select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)",
    [userId, JSON.stringify(jwt)],
  );
  await db.exec(`set role ${role}`);
}

async function rpc(name, ...params) {
  const args = params.map((_, index) => `$${index + 1}`).join(', ');
  return (await one(`select public.${name}(${args}) as reply`, params)).reply;
}

const json = value => (value === null ? null : JSON.stringify(value));

const readProfile = (beforeId = undefined) => (
  beforeId === undefined
    ? rpc('read_search_profile')
    : rpc('read_search_profile', beforeId)
);

const proposeChange = ({
  requestId = randomUUID(),
  baseRevision = 0,
  patch,
  reason = '합성 프로필 변경 사유',
  analysisId = undefined,
  runId = undefined,
}) => (
  analysisId === undefined && runId === undefined
    ? rpc('propose_search_profile_change', requestId, baseRevision, json(patch), reason)
    : rpc('propose_search_profile_change', requestId, baseRevision, json(patch), reason, analysisId ?? null, runId ?? null)
);

const decideChange = (changeId, decision) => rpc('decide_search_profile_change', changeId, decision);

function runCompare(ingestion) {
  const python = `
import json, sys
sys.path.insert(0, 'scripts')
from compare_trades import compare_snapshot

ingestion, evidence = json.load(sys.stdin)
print(json.dumps(compare_snapshot(ingestion, {'modelNo': '01'}, evidence), ensure_ascii=False))
`;
  return JSON.parse(execFileSync('python3', ['-c', python], {
    cwd: root, encoding: 'utf8', input: JSON.stringify([ingestion, fixtureEvidence]),
  }));
}

async function allowSources(sources = directorySources) {
  await db.exec('reset role');
  await db.query(`insert into public.source_registry(id, display_name, storage_permission, reuse_permission, display_permission)
    select id, '합성 출처', 'allowed', 'allowed', 'allowed' from unnest($1::text[]) as source(id)
    on conflict (id) do update set storage_permission = 'allowed', reuse_permission = 'allowed',
      display_permission = 'allowed', retention_days = null`, [sources]);
}

function buildRegionIndex(regionCodes, observedAt = new Date().toISOString()) {
  const sorted = [...new Set(regionCodes)].sort();
  const day = koreanDate.format(new Date(observedAt));
  return {
    contractVersion: 'notice-search-index/v1',
    dataOrigin: 'collected',
    observedAt,
    publicationWindow: { start: day, end: day },
    regionCodes: sorted,
    coverage: {
      status: 'complete',
      sources: [
        { source: 'applyhome_apt', status: 'empty' },
        { source: 'applyhome_remainder', status: 'empty' },
      ],
    },
    notices: [],
  };
}

async function publishSearchIndex(regionCodes, observedAt = new Date().toISOString()) {
  await allowSources();
  await as('service_role');
  await rpc('publish_notice_search_index', json(buildRegionIndex(regionCodes, observedAt)));
}

async function publishDirectory(regionCodes, observedAt = new Date().toISOString()) {
  await allowSources();
  const sorted = [...new Set(regionCodes)].sort();
  const names = Object.fromEntries(sorted.map(code => [code, `합성 지역 ${code}`]));
  await as('service_role');
  await rpc('publish_notice_directory', json(buildRegionIndex(sorted, observedAt)), json(names));
}

async function createUser({ verified = true, anonymous = false, bannedUntil = null, deletedAt = null } = {}) {
  await db.exec('reset role');
  const userId = randomUUID();
  await db.query(
    `insert into auth.users(id, confirmed_at, is_anonymous, banned_until, deleted_at)
     values ($1, case when $2 then now() end, $3, $4, $5)`,
    [userId, verified, anonymous, bannedUntil, deletedAt],
  );
  return userId;
}

async function createAnalysis(userId, conditionsSnapshot = { budget_max_won: '750000000' }) {
  await db.exec('reset role');
  const chat = await one("insert into public.chats(user_id, title) values ($1, '합성 대화') returning id", [userId]);
  const analysis = await one(
    `insert into public.analyses(user_id, chat_id, conditions_snapshot) values ($1, $2, $3) returning id`,
    [userId, chat.id, JSON.stringify(conditionsSnapshot)],
  );
  return { chatId: chat.id, analysisId: analysis.id };
}

async function finishComparisonRun(userId, analysisId) {
  await as('authenticated', userId);
  const run = await rpc('enqueue_analysis_run', analysisId, randomUUID(), json(syntheticInput));
  await as('service_role');
  const job = await rpc('claim_analysis_run', 300, run.runId);
  const comparison = runCompare(syntheticIngestion);
  const finished = await rpc(
    'finish_analysis_comparison',
    job.runId, job.generation, job.leaseToken,
    json(fixtureRequest), json(syntheticIngestion), json(comparison),
  );
  return { runId: finished.runId, snapshotId: finished.snapshotId };
}

before(async () => {
  syntheticIngestion = JSON.parse(execFileSync('python3', [
    'scripts/replay_ingestion.py', 'tests/fixtures/ingestion-v0.json',
  ], { cwd: root, encoding: 'utf8' }));
  db = await createBe03Db();
  await db.exec(`alter table auth.users add column confirmed_at timestamptz,
    add column is_anonymous boolean not null default false,
    add column banned_until timestamptz, add column deleted_at timestamptz`);
});

beforeEach(async () => {
  await db.exec('reset role');
  await db.exec(`truncate private.search_profile_proposals, private.notice_directory_publication,
    private.notice_search_index, private.analysis_chat_turns, private.comparison_results,
    private.comparison_evidence, private.analysis_runs, public.reports, public.funding_entries,
    public.analysis_input_snapshots, public.analyses, public.chats, public.profile_change_requests,
    public.user_profiles, auth.users, public.source_registry cascade`);
});

after(async () => {
  await db?.close();
});

test('private storage has RLS and zero direct grants, no duplicate sensitive columns, and narrow public RPC invokers', async () => {
  await db.exec('reset role');
  const table = await one(`select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relname = 'search_profile_proposals'`);
  assert.equal(table.relrowsecurity, true);

  for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(
        (await one('select has_table_privilege($1, $2, $3) as ok', [role, 'private.search_profile_proposals', priv])).ok,
        false,
        `${role} ${priv}`,
      );
    }
  }

  // 민감 자유 서술(reason)이나 출퇴근 목적지를 별도 테이블에 중복 저장하지 않는다.
  const { rows: cols } = await db.query(`select column_name from information_schema.columns
    where table_schema = 'private' and table_name = 'search_profile_proposals' order by ordinal_position`);
  assert.deepEqual(cols.map(c => c.column_name), [
    'change_id', 'user_id', 'request_id', 'proposal_order',
    'previous_values', 'patch_values', 'request_patch_digest', 'analysis_id', 'run_id',
  ]);

  const publicRpcs = [
    'public.read_search_profile(uuid)',
    'public.propose_search_profile_change(uuid,bigint,jsonb,text,uuid,uuid)',
    'public.decide_search_profile_change(uuid,text)',
  ];
  for (const sig of publicRpcs) {
    const def = await one('select prosecdef from pg_proc where oid = $1::regprocedure', [sig]);
    assert.equal(def.prosecdef, false, `${sig} must be security invoker`);
    assert.equal((await one("select has_function_privilege('authenticated', $1, 'EXECUTE') as ok", [sig])).ok, true, sig);
    for (const role of ['public', 'anon', 'service_role']) {
      assert.equal((await one('select has_function_privilege($1, $2, $3) as ok', [role, sig, 'EXECUTE'])).ok, false, `${role} ${sig}`);
    }
  }

  const internalHelpers = [
    'private.format_search_area(jsonb)',
    'private.format_search_conditions(jsonb)',
    'private.normalize_search_profile_reason(text)',
    'private.normalize_search_profile_patch(jsonb)',
    'private.require_search_profile_regions(jsonb)',
    'private.decide_profile_change_core(uuid,text,boolean)',
    'private.search_profile_payload(uuid,bigint)',
  ];
  for (const sig of internalHelpers) {
    for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
      assert.equal((await one('select has_function_privilege($1, $2, $3) as ok', [role, sig, 'EXECUTE'])).ok, false, `${role} ${sig}`);
    }
  }
});

test('only verified non-anonymous owners can call RPCs or receive managed proposal reasons', async () => {
  const ownerId = await createUser();
  const otherId = await createUser();
  const unconfirmedId = await createUser({ verified: false });

  await as('authenticated', ownerId);
  const reqId = randomUUID();
  const secretReason = '합성 소유자 전용 사유 메모';
  const created = await proposeChange({
    requestId: reqId,
    baseRevision: 0,
    patch: { budget_max_won: '850000000' },
    reason: secretReason,
  });
  assert.equal(created.proposals.length, 1);
  assert.equal(created.proposals[0].id, reqId);
  assert.equal(created.proposals[0].reason, secretReason);
  assert.equal((await db.query('select reason from public.profile_change_requests')).rows.length, 1);

  // 익명 역할·서비스 역할·미확인·문자열 is_anonymous JWT는 모두 42501이며 reason을 받지 못한다.
  const deniedSessions = [
    ['anon', '', { is_anonymous: false }, forbidden],
    ['service_role', ownerId, { is_anonymous: false }, forbidden],
    ['authenticated', '', { is_anonymous: false }, authRequired],
    ['authenticated', ownerId, { is_anonymous: true }, authRequired],
    ['authenticated', ownerId, { is_anonymous: 'false' }, authRequired],
    ['authenticated', randomUUID(), { is_anonymous: false }, authRequired],
    ['authenticated', unconfirmedId, { is_anonymous: false }, authRequired],
  ];
  for (const [role, uid, claims, expected] of deniedSessions) {
    await as(role, uid, claims);
    await assert.rejects(readProfile(), expected, `read ${role} ${JSON.stringify(claims)}`);
    await assert.rejects(proposeChange({ patch: { budget_max_won: '900000000' } }), expected, `propose ${role}`);
    await assert.rejects(decideChange(reqId, 'approve'), expected, `decide ${role}`);
    if (role === 'authenticated') {
      assert.equal((await db.query('select reason from public.profile_change_requests')).rows.length, 0,
        `direct select must hide reason for ${JSON.stringify(claims)}`);
    }
  }

  // 계정이 미확인·익명·정지·삭제 상태가 되면 RPC(42501)와 직접 SELECT(0행) 모두에서 사유를 차단한다.
  for (const mutation of [
    'confirmed_at = null',
    'is_anonymous = true',
    "banned_until = now() + interval '1 hour'",
    'deleted_at = now()',
  ]) {
    await db.exec('reset role');
    await db.query(`update auth.users set ${mutation} where id = $1`, [ownerId]);
    await as('authenticated', ownerId);
    await assert.rejects(readProfile(), authRequired, mutation);
    await assert.rejects(proposeChange({ patch: { budget_max_won: '900000000' } }), authRequired, mutation);
    await assert.rejects(decideChange(reqId, 'approve'), authRequired, mutation);
    assert.equal((await db.query('select reason from public.profile_change_requests')).rows.length, 0, mutation);

    await db.exec('reset role');
    await db.query('update auth.users set confirmed_at = now(), is_anonymous = false, banned_until = null, deleted_at = null where id = $1', [ownerId]);
  }

  // 정지 기한이 만료된 확인 소유자는 다시 정상 접근한다.
  await db.exec('reset role');
  await db.query("update auth.users set banned_until = now() - interval '1 minute' where id = $1", [ownerId]);
  await as('authenticated', ownerId);
  const restored = await readProfile();
  assert.equal(restored.proposals[0].reason, secretReason);

  // 다른 확인 사용자는 소유자의 변경안·사유·커서에 접근할 수 없고 존재 오라클도 없다.
  await db.exec('reset role');
  const internalRow = await one('select id from public.profile_change_requests where user_id = $1', [ownerId]);
  await as('authenticated', otherId);
  const otherView = await readProfile();
  assert.deepEqual(otherView, {
    contractVersion: 'shared-profile/v1',
    revision: 0,
    updatedAt: null,
    conditions: {},
    destination: null,
    proposals: [],
    nextCursor: null,
  });
  assert.equal((await db.query('select reason from public.profile_change_requests')).rows.length, 0);
  await assert.rejects(readProfile(reqId), cursorNotFound);
  await assert.rejects(decideChange(reqId, 'approve'), changeNotFound);
  await assert.rejects(decideChange(reqId, 'reject'), changeNotFound);
  await assert.rejects(decideChange(reqId, 'cancel'), changeNotFound);
  assert.equal((await one('select private.managed_profile_change_visible($1, $2) as v', [internalRow.id, ownerId])).v, false);
  assert.equal((await one('select private.managed_profile_change_visible($1, $2) as v', [randomUUID(), ownerId])).v, false);
});

test('validates all 6 public keys, exact paired ranges, JS-safe decimal areas, reason rules, and filtered diffs', async () => {
  const ownerId = await createUser();
  const fiftyRegions = Array.from({ length: 50 }, (_, i) => String(11001 + i));
  const fiftyOneRegions = [...fiftyRegions, '11999'];
  await publishDirectory(fiftyOneRegions);

  await as('authenticated', ownerId);
  // 최초 빈 상태는 user_profiles 행을 만들지 않으며 updatedAt은 null이다.
  assert.deepEqual(await readProfile(), {
    contractVersion: 'shared-profile/v1',
    revision: 0,
    updatedAt: null,
    conditions: {},
    destination: null,
    proposals: [],
    nextCursor: null,
  });
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from public.user_profiles where user_id = $1', [ownerId])).n, 0);

  await as('authenticated', ownerId);
  // 잘못된 스칼라·사유·패치 형식·상세 자금/목적지 키·미완성 쌍·역전 범위는 모두 22023이다.
  await assert.rejects(rpc('propose_search_profile_change', null, 0, '{"budget_max_won":"100"}', '사유'), invalidRequest);
  await assert.rejects(rpc('propose_search_profile_change', randomUUID(), null, '{"budget_max_won":"100"}', '사유'), invalidRequest);
  await assert.rejects(rpc('propose_search_profile_change', randomUUID(), -1, '{"budget_max_won":"100"}', '사유'), invalidRequest);

  for (const badReason of [
    null, '', '   ', '\n\u3000\u00A0\uFEFF\n',
    '가'.repeat(801), '😀'.repeat(801),
    '탭\t사유', '개행\r\n사유', '제어\x01사유', '삭제\x7F사유',
  ]) {
    await assert.rejects(proposeChange({ patch: { budget_max_won: '100' }, reason: badReason }), invalidReason);
  }

  for (const badPatch of [
    null, [], 'budget', 123, true, {},
    { commute_destination: '합성 강남역' },
    { current_funds: '300000000' },
    { additional_funds: '50000000' },
    { balance: '300000000' },
    { exclusive_area_min_m2: '59', exclusive_area_max_m2: '84' },
    { budget_max_won: 900000000 },
    { budget_max_won: '' },
    { budget_max_won: '-1' },
    { budget_max_won: '01' },
    { budget_max_won: '00' },
    { budget_max_won: '1,000' },
    { budget_max_won: '100.5' },
    { budget_max_won: '100000000000000000000' }, // 21자리
    { region_codes: '11001' },
    { region_codes: [] },
    { region_codes: [11001] },
    { region_codes: ['11001', null] },
    { region_codes: ['1100'] },
    { region_codes: ['110010'] },
    { region_codes: ['1100a'] },
    { region_codes: ['11001', '11001'] },
    { region_codes: fiftyOneRegions },
    { supply_area_min_m2: '84' },
    { supply_area_max_m2: '114' },
    { supply_area_min_m2: null },
    { supply_area_max_m2: null },
    { supply_area_min_m2: null, supply_area_max_m2: '114' },
    { supply_area_min_m2: '84', supply_area_max_m2: null },
    { supply_area_min_m2: 84, supply_area_max_m2: 114 },
    { supply_area_min_m2: '0', supply_area_max_m2: '114' },
    { supply_area_min_m2: '0.00', supply_area_max_m2: '114' },
    { supply_area_min_m2: '-1', supply_area_max_m2: '114' },
    { supply_area_min_m2: '01', supply_area_max_m2: '114' },
    { supply_area_min_m2: '00.5', supply_area_max_m2: '114' },
    { supply_area_min_m2: '.5', supply_area_max_m2: '114' },
    { supply_area_min_m2: '84.', supply_area_max_m2: '114' },
    { supply_area_min_m2: '1e2', supply_area_max_m2: '2e2' },
    { supply_area_min_m2: '84.0001', supply_area_max_m2: '84' },
    { supply_area_min_m2: '1234567890123456789012345', supply_area_max_m2: '1234567890123456789012345' },
    { move_in_start_month: '2027-01' },
    { move_in_end_month: '2027-06' },
    { move_in_start_month: null },
    { move_in_end_month: null },
    { move_in_start_month: null, move_in_end_month: '2027-06' },
    { move_in_start_month: '2027-01', move_in_end_month: null },
    { move_in_start_month: '2027-07', move_in_end_month: '2027-06' },
    { move_in_start_month: '0000-01', move_in_end_month: '2027-06' },
    { move_in_start_month: '2027-00', move_in_end_month: '2027-06' },
    { move_in_start_month: '2027-13', move_in_end_month: '2027-13' },
    { move_in_start_month: '2027-6', move_in_end_month: '2027-6' },
    { move_in_start_month: '2027-06-01', move_in_end_month: '2027-06-30' },
  ]) {
    await assert.rejects(proposeChange({ patch: badPatch }), invalidPatch, JSON.stringify(badPatch));
  }

  // 이미 비어 있는 키를 null로 제거하려는 변경안은 실제 변경이 없어 22023이다.
  await assert.rejects(proposeChange({ patch: { budget_max_won: null } }), unchanged);
  await assert.rejects(proposeChange({ patch: { region_codes: null } }), unchanged);
  await assert.rejects(proposeChange({ patch: { supply_area_min_m2: null, supply_area_max_m2: null } }), unchanged);
  await assert.rejects(proposeChange({ patch: { move_in_start_month: null, move_in_end_month: null } }), unchanged);

  // 20자리 예산, 50개 지역(역순 입력 → 정렬 저장), JS float64 정밀도를 초과하는 면적, 정확히 같은 입주월·이모지 800자 사유를 허용한다.
  const exactReason = '😀'.repeat(798) + '\n끝';
  const highMin = '84.1234567890123456789';
  const highMax = '114.9876543210987654321';
  const req1 = randomUUID();
  const proposed1 = await proposeChange({
    requestId: req1,
    baseRevision: 0,
    patch: {
      region_codes: [...fiftyRegions].reverse(),
      budget_max_won: '99999999999999999999',
      supply_area_min_m2: highMin,
      supply_area_max_m2: highMax,
      move_in_start_month: '2027-06',
      move_in_end_month: '2027-06',
    },
    reason: `  \n\u3000${exactReason}\u00A0\n  `,
  });
  // 승인 전에는 프로필은 비어 있고 updatedAt도 null이다.
  assert.equal(proposed1.revision, 0);
  assert.equal(proposed1.updatedAt, null);
  assert.deepEqual(proposed1.conditions, {});
  assert.equal(proposed1.proposals[0].id, req1);
  assert.equal(proposed1.proposals[0].status, 'pending');
  assert.equal(proposed1.proposals[0].decidedAt, null);
  assert.equal(proposed1.proposals[0].reason, exactReason);
  assert.deepEqual(proposed1.proposals[0].previous, {
    region_codes: null,
    budget_max_won: null,
    supply_area_min_m2: null,
    supply_area_max_m2: null,
    move_in_start_month: null,
    move_in_end_month: null,
  });
  assert.deepEqual(proposed1.proposals[0].patch, {
    region_codes: fiftyRegions,
    budget_max_won: '99999999999999999999',
    supply_area_min_m2: highMin,
    supply_area_max_m2: highMax,
    move_in_start_month: '2027-06',
    move_in_end_month: '2027-06',
  });

  const approved1 = await decideChange(req1, 'approve');
  assert.equal(approved1.revision, 1);
  assert.ok(Number.isFinite(Date.parse(approved1.updatedAt)));
  assert.deepEqual(approved1.conditions, {
    region_codes: fiftyRegions,
    budget_max_won: '99999999999999999999',
    supply_area_min_m2: highMin,
    supply_area_max_m2: highMax,
    move_in_start_month: '2027-06',
    move_in_end_month: '2027-06',
  });
  assert.equal(approved1.proposals[0].status, 'approved');
  assert.ok(Number.isFinite(Date.parse(approved1.proposals[0].decidedAt)));

  // SQL 저장 면적은 numeric(jsonb number)으로 보존되며 API 출력은 정밀 십진 문자열이다.
  await db.exec('reset role');
  const storedTypes = await one(`select
    jsonb_typeof(search_conditions->'supply_area_min_m2') as min_t,
    jsonb_typeof(search_conditions->'supply_area_max_m2') as max_t,
    search_conditions->>'supply_area_min_m2' as min_s,
    search_conditions->>'supply_area_max_m2' as max_s
    from public.user_profiles where user_id = $1`, [ownerId]);
  assert.equal(storedTypes.min_t, 'number');
  assert.equal(storedTypes.max_t, 'number');
  assert.equal(storedTypes.min_s, highMin);
  assert.equal(storedTypes.max_s, highMax);

  // 쌍 키는 함께 보내야 하며, 값이 바뀐 쪽만 previous/patch diff에 담긴다.
  await as('authenticated', ownerId);
  await assert.rejects(proposeChange({ baseRevision: 1, patch: { supply_area_max_m2: '120' } }), invalidPatch);
  await assert.rejects(proposeChange({ baseRevision: 1, patch: { move_in_end_month: '2027-12' } }), invalidPatch);
  // 동일 값(지역 집합 동일·면적 0 끝자리 포함·예산 동일)은 변경 없음(22023)이다.
  await assert.rejects(proposeChange({
    baseRevision: 1,
    patch: {
      region_codes: [...fiftyRegions].reverse(),
      budget_max_won: '99999999999999999999',
      supply_area_min_m2: `${highMin}0`, // 24자: 끝 0 제거 시 highMin과 동일
      supply_area_max_m2: highMax,
      move_in_start_month: '2027-06',
      move_in_end_month: '2027-06',
    },
  }), unchanged);

  const req2 = randomUUID();
  const proposed2 = await proposeChange({
    requestId: req2,
    baseRevision: 1,
    patch: {
      supply_area_min_m2: highMin,
      supply_area_max_m2: '120.50',
      move_in_start_month: '2027-06',
      move_in_end_month: '2027-12',
      budget_max_won: '0',
    },
    reason: '최대 면적·종료월·0원 예산 경계 확인',
  });
  assert.deepEqual(proposed2.proposals[0].previous, {
    budget_max_won: '99999999999999999999',
    supply_area_max_m2: highMax,
    move_in_end_month: '2027-06',
  });
  assert.deepEqual(proposed2.proposals[0].patch, {
    budget_max_won: '0',
    supply_area_max_m2: '120.5',
    move_in_end_month: '2027-12',
  });
  const approved2 = await decideChange(req2, 'approve');
  assert.equal(approved2.revision, 2);
  assert.equal(approved2.conditions.budget_max_won, '0');
  assert.equal(approved2.conditions.supply_area_min_m2, highMin);
  assert.equal(approved2.conditions.supply_area_max_m2, '120.5');
  assert.equal(approved2.conditions.move_in_start_month, '2027-06');
  assert.equal(approved2.conditions.move_in_end_month, '2027-12');

  // 정확한 단일 지점 면적(min = max) 및 모든 키 제거 후에도 revision > 0이면 updatedAt이 유지된다.
  const req3 = randomUUID();
  await proposeChange({
    requestId: req3,
    baseRevision: 2,
    patch: { supply_area_min_m2: '84.00', supply_area_max_m2: '84' },
    reason: '단일 면적 범위',
  });
  const approved3 = await decideChange(req3, 'approve');
  assert.equal(approved3.conditions.supply_area_min_m2, '84');
  assert.equal(approved3.conditions.supply_area_max_m2, '84');

  const req4 = randomUUID();
  const clearProposed = await proposeChange({
    requestId: req4,
    baseRevision: 3,
    patch: {
      region_codes: null,
      budget_max_won: null,
      supply_area_min_m2: null,
      supply_area_max_m2: null,
      move_in_start_month: null,
      move_in_end_month: null,
    },
    reason: '모든 조건 초기화',
  });
  assert.deepEqual(clearProposed.proposals[0].patch, {
    region_codes: null,
    budget_max_won: null,
    supply_area_min_m2: null,
    supply_area_max_m2: null,
    move_in_start_month: null,
    move_in_end_month: null,
  });
  const cleared = await decideChange(req4, 'approve');
  assert.equal(cleared.revision, 4);
  assert.deepEqual(cleared.conditions, {});
  assert.ok(Number.isFinite(Date.parse(cleared.updatedAt)));
});

test('official region directory gates new region selections at propose and approval while budget and clear edits stay available', async () => {
  const ownerId = await createUser();
  await as('authenticated', ownerId);

  // 디렉터리 미게시 상태에서도 예산·면적·입주월 변경과 승인은 동작한다.
  const budgetReq = randomUUID();
  await proposeChange({
    requestId: budgetReq,
    baseRevision: 0,
    patch: { budget_max_won: '700000000', move_in_start_month: '2027-01', move_in_end_month: '2027-06' },
    reason: '디렉터리 없이 예산·입주월 설정',
  });
  const afterBudget = await decideChange(budgetReq, 'approve');
  assert.equal(afterBudget.revision, 1);
  assert.equal(afterBudget.conditions.budget_max_won, '700000000');

  // 디렉터리 미게시 상태에서 새 지역 선택은 PT403 profile_regions_unavailable, 중복 코드는 22023이다.
  await assert.rejects(proposeChange({ baseRevision: 1, patch: { region_codes: ['11215'] } }), regionsUnavailable);
  await assert.rejects(proposeChange({ baseRevision: 1, patch: { region_codes: ['11215', '11215'] } }), invalidPatch);

  // notice_search_index 폴백 게시 시 공식 코드만 허용하고 미등록 5자리 코드는 22023이다.
  await publishSearchIndex(['11200', '11215']);
  await as('authenticated', ownerId);
  await assert.rejects(proposeChange({ baseRevision: 1, patch: { region_codes: ['99999'] } }), invalidRegion);

  const regionReq = randomUUID();
  const regionProposed = await proposeChange({
    requestId: regionReq,
    baseRevision: 1,
    patch: { region_codes: ['11215', '11200'] },
    reason: '공식 지역 2곳 선택',
  });
  assert.deepEqual(regionProposed.proposals[0].patch, { region_codes: ['11200', '11215'] });

  // 승인 직전에 출처 권한이 철회되면 승인 재검사가 PT403으로 차단한다.
  for (const sourceId of directorySources) {
    await db.exec('reset role');
    await db.query("update public.source_registry set display_permission = 'denied' where id = $1", [sourceId]);
    await as('authenticated', ownerId);
    await assert.rejects(decideChange(regionReq, 'approve'), regionsUnavailable, sourceId);
    await allowSources();
  }

  // 게시 시각이 72시간을 초과해 만료되면 새 지역 제안과 승인 모두 PT403이다.
  await db.exec('reset role');
  const staleIso = new Date(Date.now() - 73 * 3600 * 1000).toISOString();
  await db.query(`update private.notice_search_index
    set index_value = jsonb_set(index_value, '{observedAt}', to_jsonb($1::text))`, [staleIso]);
  await as('authenticated', ownerId);
  await assert.rejects(decideChange(regionReq, 'approve'), regionsUnavailable);
  await assert.rejects(proposeChange({ baseRevision: 1, patch: { region_codes: ['11215'] } }), regionsUnavailable);

  // 디렉터리 전용 게시가 11215를 제외한 새 목록으로 바뀌면 기존 대기안 승인은 22023으로 거부된다.
  await publishDirectory(['11200', '11230']);
  await as('authenticated', ownerId);
  await assert.rejects(decideChange(regionReq, 'approve'), invalidRegion);

  // 디렉터리가 불가용해도 대기 중인 지역 변경안의 취소·거절은 가능하다.
  await db.exec('reset role');
  await db.query("update public.source_registry set reuse_permission = 'denied' where id = 'mois_legal_region_codes'");
  await as('authenticated', ownerId);
  const cancelledRegion = await decideChange(regionReq, 'cancel');
  assert.equal(cancelledRegion.proposals[0].status, 'cancelled');

  // 정상 디렉터리에서 지역을 승인한 뒤, 디렉터리가 사라져도 동일 지역 포함 예산 변경과 지역 제거(null)는 가능하다.
  await publishDirectory(['11200', '11215', '11230'], new Date(Date.now() + 1000).toISOString());
  await as('authenticated', ownerId);
  const regionReq2 = randomUUID();
  await proposeChange({ requestId: regionReq2, baseRevision: 1, patch: { region_codes: ['11215', '11200'] }, reason: '지역 반영' });
  const approvedRegion = await decideChange(regionReq2, 'approve');
  assert.equal(approvedRegion.revision, 2);
  assert.deepEqual(approvedRegion.conditions.region_codes, ['11200', '11215']);

  await db.exec('reset role');
  await db.exec('truncate private.notice_directory_publication, private.notice_search_index');
  await as('authenticated', ownerId);

  // 이미 승인된 지역 변경안의 멱등 재호출(제안·승인 모두)은 디렉터리 만료 뒤에도 성공한다.
  const idempotentPropose = await proposeChange({
    requestId: regionReq2,
    baseRevision: 1,
    patch: { region_codes: ['11200', '11215'] },
    reason: '지역 반영',
  });
  assert.equal(idempotentPropose.revision, 2);
  assert.equal((await decideChange(regionReq2, 'approve')).revision, 2);

  // 지역 집합은 그대로 두고 예산만 바꾸는 패치와 지역 전체 제거(null)는 디렉터리 없이도 동작한다.
  const budgetWithSameRegions = randomUUID();
  const sameRegionRes = await proposeChange({
    requestId: budgetWithSameRegions,
    baseRevision: 2,
    patch: { region_codes: ['11215', '11200'], budget_max_won: '800000000' },
    reason: '지역 유지·예산 변경',
  });
  assert.deepEqual(sameRegionRes.proposals[0].patch, { budget_max_won: '800000000' });
  assert.equal((await decideChange(budgetWithSameRegions, 'approve')).revision, 3);

  const clearRegions = randomUUID();
  await proposeChange({ requestId: clearRegions, baseRevision: 3, patch: { region_codes: null }, reason: '지역 조건 해제' });
  const cleared = await decideChange(clearRegions, 'approve');
  assert.equal(cleared.revision, 4);
  assert.equal(Object.hasOwn(cleared.conditions, 'region_codes'), false);
});

test('idempotency, conflicting reuse, simultaneous approvals, stale revisions, and cross-user request ids are strictly handled', async () => {
  const userA = await createUser();
  const userB = await createUser();
  await publishDirectory(['11200', '11215']);

  await as('authenticated', userA);
  const sharedReqId = randomUUID();
  const first = await proposeChange({
    requestId: sharedReqId,
    baseRevision: 0,
    patch: { budget_max_won: '800000000', supply_area_min_m2: '84.50', supply_area_max_m2: '114.00' },
    reason: '  첫 제안  ',
  });

  // 같은 요청 ID로 동일 내용 재시도(키 순서·공백·면적 끝 0 정규화 포함)는 멱등이다.
  const replayPending = await proposeChange({
    requestId: sharedReqId,
    baseRevision: 0,
    patch: { supply_area_max_m2: '114', budget_max_won: '800000000', supply_area_min_m2: '84.5' },
    reason: '첫 제안',
  });
  assert.deepEqual(replayPending, first);

  // 같은 요청 ID로 base_revision·patch·reason을 바꾸면 PT409이다.
  await assert.rejects(proposeChange({
    requestId: sharedReqId,
    baseRevision: 1,
    patch: { budget_max_won: '800000000', supply_area_min_m2: '84.5', supply_area_max_m2: '114' },
    reason: '첫 제안',
  }), requestConflict);
  await assert.rejects(proposeChange({
    requestId: sharedReqId,
    baseRevision: 0,
    patch: { budget_max_won: '900000000', supply_area_min_m2: '84.5', supply_area_max_m2: '114' },
    reason: '첫 제안',
  }), requestConflict);
  await assert.rejects(proposeChange({
    requestId: sharedReqId,
    baseRevision: 0,
    patch: { budget_max_won: '800000000', supply_area_min_m2: '84.5', supply_area_max_m2: '114' },
    reason: '다른 사유',
  }), requestConflict);

  // 다른 사용자는 동일한 requestId를 충돌이나 노출 없이 독립적으로 사용할 수 있다.
  await as('authenticated', userB);
  const userBProposal = await proposeChange({
    requestId: sharedReqId,
    baseRevision: 0,
    patch: { budget_max_won: '600000000' },
    reason: '사용자 B 독립 제안',
  });
  assert.equal(userBProposal.proposals.length, 1);
  assert.equal(userBProposal.proposals[0].id, sharedReqId);
  assert.equal(userBProposal.proposals[0].patch.budget_max_won, '600000000');

  // 같은 기준 버전(revision 0)에 두 개의 서로 다른 제안을 동시에 승인하면 하나만 적용되고 나머지는 PT409다.
  await as('authenticated', userA);
  const secondReqId = randomUUID();
  await proposeChange({
    requestId: secondReqId,
    baseRevision: 0,
    patch: { region_codes: ['11215'] },
    reason: '두 번째 동시 제안',
  });
  const [race1, race2] = await Promise.allSettled([
    decideChange(sharedReqId, 'approve'),
    decideChange(secondReqId, 'approve'),
  ]);
  const succeeded = [race1, race2].filter(r => r.status === 'fulfilled');
  const failed = [race1, race2].filter(r => r.status === 'rejected');
  assert.equal(succeeded.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.code, 'PT409');
  assert.equal(failed[0].reason.message, 'search_profile_revision_conflict');

  const afterRace = await readProfile();
  assert.equal(afterRace.revision, 1);
  const winnerId = afterRace.proposals.find(p => p.status === 'approved').id;
  const loserId = afterRace.proposals.find(p => p.status === 'pending').id;
  assert.notEqual(winnerId, loserId);

  // 동일 제안의 동시 승인·손실 응답 재전송은 멱등하게 성공하고 버전을 두 번 올리지 않는다.
  const [same1, same2] = await Promise.all([
    decideChange(winnerId, 'approve'),
    decideChange(winnerId, 'approve'),
  ]);
  assert.equal(same1.revision, 1);
  assert.equal(same2.revision, 1);
  assert.deepEqual(same2, same1);

  // 이미 해결된 제안의 원래 p_request_id 재시도도 멱등하게 성공한다.
  if (winnerId === sharedReqId) {
    const afterResolveRetry = await proposeChange({
      requestId: sharedReqId,
      baseRevision: 0,
      patch: { budget_max_won: '800000000', supply_area_min_m2: '84.5', supply_area_max_m2: '114' },
      reason: '첫 제안',
    });
    assert.equal(afterResolveRetry.revision, 1);
    assert.equal(afterResolveRetry.proposals.find(p => p.id === sharedReqId).status, 'approved');
  }

  // 이미 승인된 제안에 reject/cancel을 시도하면 PT409, 잘못된 동사는 22023이다.
  await assert.rejects(decideChange(winnerId, 'reject'), decisionConflict);
  await assert.rejects(decideChange(winnerId, 'cancel'), decisionConflict);
  for (const badVerb of [null, '', 'approved', 'rejected', 'cancelled', 'confirm']) {
    await assert.rejects(decideChange(loserId, badVerb), invalidDecision);
  }
  await assert.rejects(decideChange(null, 'approve'), invalidDecision);

  // 오래된 기준 버전의 대기 제안은 승인 시 PT409지만 거절·취소 및 같은 결정 재전송은 성공한다.
  await assert.rejects(decideChange(loserId, 'approve'), revisionConflict);
  const rejectedLoser = await decideChange(loserId, 'reject');
  assert.equal(rejectedLoser.revision, 1);
  assert.equal(rejectedLoser.proposals.find(p => p.id === loserId).status, 'rejected');
  assert.deepEqual(await decideChange(loserId, 'reject'), rejectedLoser);
  await assert.rejects(decideChange(loserId, 'approve'), decisionConflict);
  await assert.rejects(decideChange(loserId, 'cancel'), decisionConflict);

  // 오래된 base_revision으로 새 제안을 내면 PT409다.
  await assert.rejects(proposeChange({ baseRevision: 0, patch: { budget_max_won: '500000000' } }), revisionConflict);
  await assert.rejects(proposeChange({ baseRevision: 2, patch: { budget_max_won: '500000000' } }), revisionConflict);

  // 사용자 B의 프로필은 사용자 A의 승인에 영향받지 않는다.
  await as('authenticated', userB);
  const bState = await readProfile();
  assert.equal(bState.revision, 0);
  assert.equal(bState.proposals[0].status, 'pending');
});

test('origin enforces owned finished comparison results, preserves analysis and report snapshots immutably, and cascades cleanly', async () => {
  const userA = await createUser();
  const userB = await createUser();
  const { analysisId: analysisA } = await createAnalysis(userA, { budget_max_won: '750000000', tag: 'original-a' });
  const { analysisId: analysisB } = await createAnalysis(userB, { budget_max_won: '650000000', tag: 'original-b' });

  // 사용자 A의 완료되지 않은 실행(queued)과 비교 결과 없는 완료 실행(finish_analysis_run 단독)을 준비한다.
  await as('authenticated', userA);
  const queuedRun = await rpc('enqueue_analysis_run', analysisA, randomUUID(), json(syntheticInput));
  const finishedNoCompRun = await rpc('enqueue_analysis_run', analysisA, randomUUID(), json(syntheticInput));
  await as('service_role');
  const jobNoComp = await rpc('claim_analysis_run', 300, finishedNoCompRun.runId);
  await rpc('finish_analysis_run', jobNoComp.runId, jobNoComp.generation, jobNoComp.leaseToken,
    json(fixtureRequest), json(syntheticIngestion));

  // 사용자 A와 사용자 B의 완료된 비교 결과를 각각 생성한다.
  const { runId: finishedRunA, snapshotId: snapshotA } = await finishComparisonRun(userA, analysisA);
  const { runId: finishedRunB } = await finishComparisonRun(userB, analysisB);

  // 보고서와 분석별 자금을 저장해 프로필 승인 뒤 불변성을 검증한다.
  await db.exec('reset role');
  await db.query(`insert into public.reports(
      user_id, analysis_id, snapshot_version, result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot, queried_at
    ) values ($1, $2, 1, '{"summary":"합성"}'::jsonb, '{"budget_max_won":"750000000"}'::jsonb, '[]'::jsonb, '[]'::jsonb, now())`,
    [userA, analysisA]);
  await as('authenticated', userA);
  await db.query(`insert into public.funding_entries(user_id, analysis_id, kind, amount_won, available_on, certainty)
    values ($1, $2, 'current', 300000000, '2026-11-23', 'confirmed')`, [userA, analysisA]);

  // 한쪽 origin ID만 전달하면 22023이다.
  await assert.rejects(proposeChange({
    patch: { budget_max_won: '900000000' }, analysisId: analysisA, runId: null,
  }), invalidOrigin);
  await assert.rejects(proposeChange({
    patch: { budget_max_won: '900000000' }, analysisId: null, runId: finishedRunA,
  }), invalidOrigin);

  // 없는 ID·교차 분석 ID·타인의 완료 결과 ID는 모두 PT404다.
  await assert.rejects(proposeChange({
    patch: { budget_max_won: '900000000' }, analysisId: randomUUID(), runId: randomUUID(),
  }), originNotFound);
  await assert.rejects(proposeChange({
    patch: { budget_max_won: '900000000' }, analysisId: analysisB, runId: finishedRunB,
  }), originNotFound);
  await assert.rejects(proposeChange({
    patch: { budget_max_won: '900000000' }, analysisId: analysisA, runId: finishedRunB,
  }), originNotFound);

  // 본인 실행이지만 미완료(queued) 또는 비교 결과 없음(finish_analysis_run 단독)은 PT409다.
  await assert.rejects(proposeChange({
    patch: { budget_max_won: '900000000' }, analysisId: analysisA, runId: queuedRun.runId,
  }), originNotReady);
  await assert.rejects(proposeChange({
    patch: { budget_max_won: '900000000' }, analysisId: analysisA, runId: finishedNoCompRun.runId,
  }), originNotReady);

  // 승인 전 스냅샷·비교 결과·보고서·분석 조건·자금 상태를 기록한다.
  await db.exec('reset role');
  const beforeSnapshots = {
    analysis: await one('select conditions_snapshot, rules_version, latest_run_id from public.analyses where id = $1', [analysisA]),
    inputSnapshot: await one('select input_snapshot, result_snapshot, conditions_snapshot from public.analysis_input_snapshots where id = $1', [snapshotA]),
    comparison: await one('select result, source_ids from private.comparison_results where run_id = $1', [finishedRunA]),
    report: await one('select result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot from public.reports where analysis_id = $1', [analysisA]),
    funding: await one('select kind, amount_won::text, certainty from public.funding_entries where analysis_id = $1', [analysisA]),
  };

  // 본인 완료 결과에 연결해 제안·멱등 재시도·다른 origin 충돌·승인을 검증한다.
  await as('authenticated', userA);
  const originReq = randomUUID();
  const originProposed = await proposeChange({
    requestId: originReq,
    baseRevision: 0,
    patch: { budget_max_won: '950000000' },
    reason: '비교 화면에서 예산 상향 초안',
    analysisId: analysisA,
    runId: finishedRunA,
  });
  assert.equal(originProposed.proposals[0].analysisId, analysisA);
  assert.equal(originProposed.proposals[0].runId, finishedRunA);

  // 타인 ID로 기존 requestId 충돌을 떠보아도 PT404가 먼저 반환된다.
  await assert.rejects(proposeChange({
    requestId: originReq,
    baseRevision: 0,
    patch: { budget_max_won: '950000000' },
    reason: '비교 화면에서 예산 상향 초안',
    analysisId: analysisB,
    runId: finishedRunB,
  }), originNotFound);

  // 같은 requestId에서 origin을 null로 바꾸면 PT409다.
  await assert.rejects(proposeChange({
    requestId: originReq,
    baseRevision: 0,
    patch: { budget_max_won: '950000000' },
    reason: '비교 화면에서 예산 상향 초안',
  }), requestConflict);

  const originApproved = await decideChange(originReq, 'approve');
  assert.equal(originApproved.revision, 1);
  assert.equal(originApproved.conditions.budget_max_won, '950000000');

  // 승인 후 동일 origin 재시도는 멱등하게 성공한다.
  assert.deepEqual(await proposeChange({
    requestId: originReq,
    baseRevision: 0,
    patch: { budget_max_won: '950000000' },
    reason: '비교 화면에서 예산 상향 초안',
    analysisId: analysisA,
    runId: finishedRunA,
  }), originApproved);

  // 기존 분석·스냅샷·비교 결과·보고서·자금은 공유 프로필 승인 뒤에도 완전히 불변이다.
  await db.exec('reset role');
  const afterSnapshots = {
    analysis: await one('select conditions_snapshot, rules_version, latest_run_id from public.analyses where id = $1', [analysisA]),
    inputSnapshot: await one('select input_snapshot, result_snapshot, conditions_snapshot from public.analysis_input_snapshots where id = $1', [snapshotA]),
    comparison: await one('select result, source_ids from private.comparison_results where run_id = $1', [finishedRunA]),
    report: await one('select result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot from public.reports where analysis_id = $1', [analysisA]),
    funding: await one('select kind, amount_won::text, certainty from public.funding_entries where analysis_id = $1', [analysisA]),
  };
  assert.deepEqual(afterSnapshots, beforeSnapshots);

  // 사용자 B에도 제안 하나를 만들어 두고, 사용자 A 분석 삭제 및 계정 삭제가 각각 안전하게 처리되는지 확인한다.
  await as('authenticated', userB);
  const reqB = randomUUID();
  await proposeChange({
    requestId: reqB, baseRevision: 0, patch: { budget_max_won: '550000000' },
    reason: '사용자 B 제안', analysisId: analysisB, runId: finishedRunB,
  });

  await db.exec('reset role');
  await db.query('delete from public.analyses where id = $1', [analysisA]);
  await as('authenticated', userA);
  const afterAnalysisDelete = await readProfile();
  assert.equal(afterAnalysisDelete.proposals.length, 1);
  assert.equal(afterAnalysisDelete.proposals[0].analysisId, null);
  assert.equal(afterAnalysisDelete.proposals[0].runId, null);

  await db.exec('reset role');
  await db.query('delete from auth.users where id = $1', [userA]);
  assert.equal((await one('select count(*)::int as n from private.search_profile_proposals where user_id = $1', [userA])).n, 0);
  assert.equal((await one('select count(*)::int as n from public.profile_change_requests where user_id = $1', [userA])).n, 0);
  assert.equal((await one('select count(*)::int as n from private.search_profile_proposals where user_id = $1', [userB])).n, 1);
});

test('preserves legacy profile data and direct RPC compatibility while blocking bypass of managed proposals', async () => {
  const ownerId = await createUser();
  const otherId = await createUser();

  // 레거시 허용 값(미정렬 지역, 22자리 예산, 단측 면적 numeric, 단측 입주월, 출퇴근 목적지)을 준비한다.
  await db.exec('reset role');
  await db.query(
    `insert into public.user_profiles(user_id, search_conditions, commute_destination, revision)
     values ($1, $2::jsonb, $3, 2)`,
    [
      ownerId,
      JSON.stringify({
        region_codes: ['11215', '11200'],
        budget_max_won: '1000000000000000000000',
        supply_area_min_m2: 84.5,
        move_in_start_month: '2027-01',
      }),
      '합성 광화문역',
    ],
  );

  // 레거시 직접 변경안 생성·승인과 confirm_commute_destination은 계속 동작하며 관리 이력에 섞이지 않는다.
  await as('authenticated', ownerId);
  const legacyReq = await one(
    `insert into public.profile_change_requests(user_id, base_revision, proposed_changes, reason)
     values ($1, 2, '{"commute_destination":"합성 판교역"}'::jsonb, '레거시 변경') returning id`,
    [ownerId],
  );
  await rpc('decide_profile_change', legacyReq.id, 'approved');
  await rpc('confirm_commute_destination', ownerId, 3, '합성 강남역');

  const initial = await readProfile();
  assert.equal(initial.revision, 4);
  assert.equal(initial.destination, '합성 강남역');
  assert.ok(Number.isFinite(Date.parse(initial.updatedAt)));
  assert.deepEqual(initial.conditions, {
    region_codes: ['11215', '11200'],
    budget_max_won: '1000000000000000000000',
    supply_area_min_m2: '84.5',
    move_in_start_month: '2027-01',
  });
  assert.deepEqual(initial.proposals, []);
  await assert.rejects(decideChange(legacyReq.id, 'approve'), changeNotFound);
  await assert.rejects(readProfile(legacyReq.id), cursorNotFound);

  // 관리 변경안으로 예산만 수정하면 건드리지 않은 레거시 필드와 출퇴근 목적지가 그대로 보존된다.
  const managedReq = randomUUID();
  const proposed = await proposeChange({
    requestId: managedReq,
    baseRevision: 4,
    patch: { budget_max_won: '900000000' },
    reason: '예산만 조정',
  });
  assert.deepEqual(proposed.proposals[0].previous, { budget_max_won: '1000000000000000000000' });
  assert.deepEqual(proposed.proposals[0].patch, { budget_max_won: '900000000' });

  // 기존 public/private decide_profile_change로 관리 변경안을 우회 결정할 수 없다(42501).
  const internalRow = await one(
    `select id from public.profile_change_requests where user_id = $1 and status = 'pending'`,
    [ownerId],
  );
  for (const verb of ['approved', 'rejected', 'cancelled']) {
    await assert.rejects(rpc('decide_profile_change', internalRow.id, verb), managedOnly, `public ${verb}`);
    await assert.rejects(db.query('select private.decide_profile_change($1, $2)', [internalRow.id, verb]), managedOnly, `private ${verb}`);
  }
  await assert.rejects(
    db.query("select private.decide_profile_change_core($1, 'approved', true)", [internalRow.id]),
    forbidden,
  );

  // 타인이 내부 ID로 구 RPC를 호출해도 존재를 노출하지 않고 P0002를 받는다.
  await as('authenticated', otherId);
  await assert.rejects(rpc('decide_profile_change', internalRow.id, 'approved'), { code: 'P0002', message: 'proposal_not_found' });

  // 관리 RPC로 정상 승인하면 예산만 갱신되고 레거시 필드와 목적지는 유지된다.
  await as('authenticated', ownerId);
  const approved = await decideChange(managedReq, 'approve');
  assert.equal(approved.revision, 5);
  assert.equal(approved.destination, '합성 강남역');
  assert.deepEqual(approved.conditions, {
    region_codes: ['11215', '11200'],
    budget_max_won: '900000000',
    supply_area_min_m2: '84.5',
    move_in_start_month: '2027-01',
  });

  // 레거시 단측 면적/입주월을 쌍 null로 정리하면 실제로 존재하던 키만 diff에 기록된다.
  const clearHalfReq = randomUUID();
  const clearHalf = await proposeChange({
    requestId: clearHalfReq,
    baseRevision: 5,
    patch: { supply_area_min_m2: null, supply_area_max_m2: null, move_in_start_month: null, move_in_end_month: null },
    reason: '레거시 단측 조건 정리',
  });
  assert.deepEqual(clearHalf.proposals[0].previous, {
    supply_area_min_m2: '84.5',
    move_in_start_month: '2027-01',
  });
  assert.deepEqual(clearHalf.proposals[0].patch, {
    supply_area_min_m2: null,
    move_in_start_month: null,
  });

  // 그 사이 출퇴근 목적지가 갱신돼 버전이 오르면 기존 대기 검색 변경안 승인은 PT409로 거절된다.
  await rpc('confirm_commute_destination', ownerId, 5, '합성 여의도역');
  await assert.rejects(decideChange(clearHalfReq, 'approve'), revisionConflict);
  const afterCommute = await readProfile();
  assert.equal(afterCommute.revision, 6);
  assert.equal(afterCommute.destination, '합성 여의도역');
  assert.equal(afterCommute.proposals[0].status, 'pending');
});

test('newest-first 30 pagination and owner-scoped cursor isolate legacy rows and other users', async () => {
  const ownerId = await createUser();
  const otherId = await createUser();

  await as('authenticated', otherId);
  const otherReq = randomUUID();
  await proposeChange({ requestId: otherReq, baseRevision: 0, patch: { budget_max_won: '500000000' }, reason: '타인 제안' });

  await as('authenticated', ownerId);
  const ids = [];
  for (let i = 1; i <= 35; i += 1) {
    const id = randomUUID();
    ids.push(id);
    await proposeChange({
      requestId: id,
      baseRevision: 0,
      patch: { budget_max_won: String(i * 10000000) },
      reason: `합성 제안 ${i}`,
    });
    if (i === 5) await decideChange(id, 'reject');
    if (i === 10) await decideChange(id, 'cancel');
    if (i === 15) {
      // 중간에 레거시 행이 섞여도 관리 이력과 커서에서 제외된다.
      await db.query(
        `insert into public.profile_change_requests(user_id, base_revision, proposed_changes, reason)
         values ($1, 0, '{"commute_destination":"합성 시청역"}'::jsonb, '레거시 이력')`,
        [ownerId],
      );
    }
  }

  const page1 = await readProfile();
  assert.equal(page1.proposals.length, 30);
  assert.deepEqual(page1.proposals.map(p => p.id), ids.slice(5).reverse());
  assert.equal(page1.proposals[0].reason, '합성 제안 35');
  assert.equal(page1.proposals[29].reason, '합성 제안 6');
  assert.equal(page1.proposals.find(p => p.id === ids[9]).status, 'cancelled');
  assert.equal(page1.nextCursor, ids[5]);

  const page2 = await readProfile(page1.nextCursor);
  assert.equal(page2.proposals.length, 5);
  assert.deepEqual(page2.proposals.map(p => p.id), ids.slice(0, 5).reverse());
  assert.equal(page2.proposals[0].reason, '합성 제안 5');
  assert.equal(page2.proposals[0].status, 'rejected');
  assert.equal(page2.proposals[4].reason, '합성 제안 1');
  assert.equal(page2.nextCursor, null);

  // 가장 오래된 항목을 커서로 주면 빈 목록과 nextCursor=null을 반환한다.
  const emptyTail = await readProfile(ids[0]);
  assert.deepEqual(emptyTail.proposals, []);
  assert.equal(emptyTail.nextCursor, null);

  // 타인 커서·존재하지 않는 커서·내부 change_id는 모두 PT404다.
  await db.exec('reset role');
  const internalId = (await one('select change_id from private.search_profile_proposals where user_id = $1 limit 1', [ownerId])).change_id;
  await as('authenticated', ownerId);
  await assert.rejects(readProfile(otherReq), cursorNotFound);
  await assert.rejects(readProfile(randomUUID()), cursorNotFound);
  await assert.rejects(readProfile(internalId), cursorNotFound);

  // 정확히 30건일 때는 nextCursor가 null이다.
  const exact30User = await createUser();
  await as('authenticated', exact30User);
  for (let i = 1; i <= 30; i += 1) {
    await proposeChange({ baseRevision: 0, patch: { budget_max_won: String(i * 10000000) }, reason: `정확히 30건 ${i}` });
  }
  const exact30 = await readProfile();
  assert.equal(exact30.proposals.length, 30);
  assert.equal(exact30.nextCursor, null);
});
