// 합성 수집본·근거와 PGlite로 비교 결과별 대화·기간 변경 승인·작업자 연동을 검사한다.
// 실제 인증·Storage·외부 API는 호출하지 않으며 모든 공고·거래·메시지는 합성 자료다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBe03Db } from './helpers/be03-db.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixturePath = 'tests/fixtures/ingestion-v0.json';
const { request: fixtureRequest } = JSON.parse(readFileSync(new URL('../fixtures/ingestion-v0.json', import.meta.url), 'utf8'));
const fixtureEvidence = JSON.parse(readFileSync(new URL('../fixtures/comparison-evidence-v1.json', import.meta.url), 'utf8'));
const collectedEvidence = { ...fixtureEvidence, dataOrigin: 'collected' };
const syntheticInput = { kind: 'synthetic', fixture: 'ingestion-v0' };
const snapshotInput = snapshotId => ({ kind: 'snapshot', snapshotId });
const defaultConditions = {
  comparison: { modelNo: '01' },
  comparisonPeriod: { start: '2026-10-12', end: '2026-10-18' },
  period: { start: '2026-10-12', end: '2026-10-18' },
  budget_max_won: '750000000',
};
const supplementalSources = [
  'synthetic-area-register', 'synthetic-complex-register',
  'synthetic-coordinate-register', 'synthetic-region-register',
];
const collectedCaptureSources = [
  'applyhome_apt', 'applyhome_apt_model', 'apt_trade', 'apt_rights', 'applyhome_notice_pdf',
];
const evidenceSourceIds = ['applyhome_apt', 'apt_trade', 'apt_rights', ...supplementalSources];
const noticeSourceIds = [
  'applyhome_apt', 'applyhome_remainder', 'applyhome_apt_model', 'applyhome_remainder_model',
  'mois_legal_region_codes', 'apt_trade', 'apt_rights', 'applyhome_notice_pdf',
];
const koreanDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });

const authRequired = { code: '42501', message: 'authentication_required' };
const forbidden = { code: '42501' };
const sourceRestricted = { code: 'PT403', message: 'comparison_source_restricted' };
const runNotFound = { code: 'PT404', message: 'analysis_run_not_found' };
const turnNotFound = { code: 'PT404', message: 'analysis_chat_turn_not_found' };
const notReady = { code: 'PT409', message: 'analysis_comparison_not_ready' };
const requestConflict = { code: 'PT409', message: 'analysis_chat_request_conflict' };
const staleRun = { code: 'PT409', message: 'analysis_chat_stale_run' };
const decisionConflict = { code: 'PT409', message: 'analysis_chat_decision_conflict' };
const periodUnavailable = { code: 'PT409', message: 'analysis_chat_period_unavailable' };
const conditionUnavailable = { code: 'PT409', message: 'analysis_chat_condition_unavailable' };
const invalidTurn = { code: '22023', message: 'invalid_analysis_chat_turn' };
const invalidPeriod = { code: '22023', message: 'invalid_analysis_chat_period' };
const invalidCondition = { code: '22023', message: 'invalid_analysis_chat_condition' };
const invalidDecision = { code: '22023', message: 'invalid_analysis_chat_decision' };
const invalidComparison = { code: '22023', message: 'invalid_comparison_result' };
const rateLimited = { code: 'PT429', message: 'analysis_run_rate_limited' };

let db;
let syntheticIngestion;
let collectedIngestion;

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function as(role, userId = '', claims = { is_anonymous: false }) {
  await db.exec('reset role');
  const jwt = { ...(userId ? { sub: userId } : {}), ...claims };
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)",
    [userId, JSON.stringify(jwt)]);
  await db.exec(`set role ${role}`);
}

async function rpc(name, ...params) {
  const args = params.map((_, index) => `$${index + 1}`).join(', ');
  return (await one(`select public.${name}(${args}) as reply`, params)).reply;
}

const json = value => value === null ? null : JSON.stringify(value);
const enqueue = (owner, input = syntheticInput, key = randomUUID()) =>
  rpc('enqueue_analysis_run', owner.analysisId, key, json(input));
const claim = run => rpc('claim_analysis_run', 300, run.runId);
const lease = job => [job.runId, job.generation, job.leaseToken];
const readWork = job => rpc('read_comparison_work', ...lease(job));
const finishRun = (job, input = null, result = null) =>
  rpc('finish_analysis_run', ...lease(job), json(input), json(result));
const finishComparison = (job, comparison, input = null, result = null) =>
  rpc('finish_analysis_comparison', ...lease(job), json(input), json(result), json(comparison));
const getComparison = (owner, runId) => rpc('get_analysis_comparison', owner.analysisId, runId);
const readConversation = (owner, runId) => rpc('read_analysis_conversation', owner.analysisId, runId);
const submitTurn = (owner, runId, {
  requestId = randomUUID(),
  message = '합성 비교 조건을 설명해 주세요',
  intent = 'period',
  start = undefined,
  end = undefined,
} = {}) => (start === undefined && end === undefined
  ? rpc('submit_analysis_chat_turn', owner.analysisId, runId, requestId, message, intent)
  : rpc('submit_analysis_chat_turn', owner.analysisId, runId, requestId, message, intent, start, end));
const submitConditions = (owner, runId, {
  requestId = randomUUID(),
  message = '합성 비교 조건 변경 요청',
  conditions,
}) => rpc('submit_analysis_condition_turn', owner.analysisId, runId, requestId, message, json(conditions));
const decideTurn = (owner, runId, turnId, decision) =>
  rpc('decide_analysis_chat_turn', owner.analysisId, runId, turnId, decision);

function runCompare(ingestion, selection = { modelNo: '01' }, evidence = null, period = null, conditions = null) {
  const python = `
import json, sys
sys.path.insert(0, 'scripts')
from compare_trades import compare_snapshot

ingestion, selection, evidence, period, conditions = json.load(sys.stdin)
print(json.dumps(compare_snapshot(ingestion, selection, evidence, comparison_period=period, comparison_conditions=conditions), ensure_ascii=False))
`;
  return JSON.parse(execFileSync('python3', ['-c', python], {
    cwd: root, encoding: 'utf8', input: JSON.stringify([ingestion, selection, evidence, period, conditions]),
  }));
}

function runWorkerPrepare(selection, work) {
  const python = `
import json, sys
sys.path.insert(0, 'scripts')
from run_analysis_worker import prepare_comparison

selection, work = json.load(sys.stdin)
inputs, capture, comparison = prepare_comparison(selection, work)
print(json.dumps({'inputs': inputs, 'capture': capture, 'comparison': comparison}, ensure_ascii=False))
`;
  return JSON.parse(execFileSync('python3', ['-c', python], {
    cwd: root, encoding: 'utf8', input: JSON.stringify([selection, work]),
  }));
}

function noticeCaptureBundle(basisDate = '2026-11-10', modelNo = '01') {
  const day = koreanDate.format(new Date());
  const index = {
    contractVersion: 'notice-search-index/v1', dataOrigin: 'collected', observedAt: new Date().toISOString(),
    publicationWindow: { start: day, end: day }, regionCodes: ['99999'],
    coverage: {
      status: 'complete',
      sources: [
        { source: 'applyhome_apt', status: 'complete' },
        { source: 'applyhome_remainder', status: 'empty' },
      ],
    },
    notices: [{
      houseManageNo: '9900000001', noticeNo: '9900000042', edition: day, title: '합성 가람 아파트',
      kind: 'new_sale', regionCode: '99999', moveIn: null, application: { start: day, end: day },
      inventoryComplete: false,
      models: [{ modelNo, houseType: '084.0000A', supplyAreaM2: null, areaEvidence: [], rooms: [] }],
      sourceIds: ['applyhome_apt', 'applyhome_apt_model'], reasonCodes: [],
    }],
  };
  const input = {
    kind: 'notice', noticeSource: 'applyhome_apt',
    houseManageNo: '9900000001', noticeNo: '9900000042', edition: day, modelNo,
  };
  const request = {
    noticeSource: 'applyhome_apt',
    target: { houseManageNo: '9900000001', noticeNo: '9900000042', edition: day },
    asOf: basisDate, requestRegionCodes: ['99999'],
    tradeKinds: ['sale', 'presale_right', 'occupancy_right'], pageSize: 100,
  };
  const python = `
import json, sys
from pathlib import Path
sys.path.insert(0, 'scripts')
from compare_trades import compare_snapshot
from replay_ingestion import ingest

request, model_no = json.load(sys.stdin)
sample = json.loads(Path('tests/fixtures/ingestion-v0.json').read_text())
notice, model = [dict(p['body']['data'][0], HOUSE_MANAGE_NO=request['target']['houseManageNo'],
                      PBLANC_NO=request['target']['noticeNo']) for p in sample['pages'][:2]]
notice['RCRIT_PBLANC_DE'] = request['target']['edition']
model['MODEL_NO'] = model_no

def fetch(source, scope, page, page_size):
    entry = dict(source=source, scope=scope, page=page, pageSize=page_size,
                 observedAt=request['asOf'] + 'T00:00:00Z', httpStatus=200)
    if source in ('applyhome_apt', 'applyhome_apt_model'):
        entry['body'] = dict(page=page, perPage=page_size, currentCount=1, matchCount=1, totalCount=1,
                             data=[notice if source == 'applyhome_apt' else model])
    else:
        entry['body'] = {'response': {'header': {'resultCode': '000', 'resultMsg': 'OK'},
            'body': {'pageNo': page, 'numOfRows': page_size, 'totalCount': 0, 'items': {}}}}
    return entry

result = ingest(request, fetch, data_origin='collected', evidence=[])
comparison = compare_snapshot(result, {'modelNo': model_no}, evidence=None)
print(json.dumps({'result': result, 'comparison': comparison}, ensure_ascii=False))
`;
  const captured = JSON.parse(execFileSync('python3', ['-c', python], {
    cwd: root, encoding: 'utf8', input: JSON.stringify([request, modelNo]),
  }));
  return { index, input, request, ...captured };
}

async function allowSources(sources) {
  await db.exec('reset role');
  await db.query(`insert into public.source_registry(id, display_name, storage_permission, reuse_permission, display_permission)
    select id, '합성 출처', 'allowed', 'allowed', 'allowed' from unnest($1::text[]) as source(id)
    on conflict (id) do update set storage_permission = 'allowed', reuse_permission = 'allowed',
      display_permission = 'allowed', retention_days = null`, [sources]);
}

async function createOwner({
  userId = null,
  verified = true,
  conditionsSnapshot = defaultConditions,
  profileSearch = { region_codes: ['11215'], budget_max_won: '900000000' },
  commuteDestination = '합성 강남역',
  noticeId = null,
  housingTypeId = null,
} = {}) {
  await db.exec('reset role');
  if (userId === null) {
    userId = randomUUID();
    await db.query('insert into auth.users(id, confirmed_at) values ($1, case when $2 then now() end)', [userId, verified]);
    await db.query(`insert into public.user_profiles(user_id, search_conditions, commute_destination, revision)
      values ($1, $2, $3, 3)`, [userId, JSON.stringify(profileSearch), commuteDestination]);
  }
  const chat = await one("insert into public.chats(user_id, title) values ($1, '합성 대화') returning id", [userId]);
  const analysis = await one(`insert into public.analyses(user_id, chat_id, conditions_snapshot, notice_id, housing_type_id)
    values ($1, $2, $3, $4, $5) returning id`, [userId, chat.id, JSON.stringify(conditionsSnapshot), noticeId, housingTypeId]);
  return { userId, chatId: chat.id, analysisId: analysis.id };
}

async function finishSyntheticRun(owner) {
  await as('authenticated', owner.userId);
  const run = await enqueue(owner, syntheticInput);
  await as('service_role');
  const job = await claim(run);
  const comparison = runCompare(syntheticIngestion, { modelNo: '01' }, fixtureEvidence);
  const finished = await finishComparison(job, comparison, fixtureRequest, syntheticIngestion);
  return { runId: finished.runId, snapshotId: finished.snapshotId, comparison };
}

async function saveCollectedSnapshot(owner, { registerEvidence = true } = {}) {
  await allowSources([...collectedCaptureSources, ...supplementalSources]);
  await as('service_role');
  const snapshotId = await rpc('save_ingestion_snapshot', owner.userId, owner.analysisId, randomUUID(),
    json(fixtureRequest), json(collectedIngestion));
  if (registerEvidence) {
    await rpc('register_comparison_evidence', snapshotId, json(collectedEvidence), evidenceSourceIds);
  }
  return snapshotId;
}

async function finishCollectedSnapshotRun(owner, snapshotId, { withEvidence = true } = {}) {
  await as('authenticated', owner.userId);
  const run = await enqueue(owner, snapshotInput(snapshotId));
  await as('service_role');
  const job = await claim(run);
  const comparison = runCompare(collectedIngestion, { modelNo: '01' }, withEvidence ? collectedEvidence : null);
  const finished = await finishComparison(job, comparison, null, null);
  return { runId: finished.runId, snapshotId, comparison };
}

before(async () => {
  syntheticIngestion = JSON.parse(execFileSync('python3', ['scripts/replay_ingestion.py', fixturePath], {
    cwd: root, encoding: 'utf8',
  }));
  collectedIngestion = { ...syntheticIngestion, dataOrigin: 'collected' };
  db = await createBe03Db();
  await db.exec(`alter table auth.users add column confirmed_at timestamptz,
    add column is_anonymous boolean not null default false,
    add column banned_until timestamptz, add column deleted_at timestamptz`);
});

beforeEach(async () => {
  await db.exec(`reset role;
    delete from private.notice_search_index;
    delete from private.notice_directory_publication;
    delete from auth.users;
    delete from public.notices;
    delete from public.source_registry;`);
});

after(async () => db?.close());

test('private storage has RLS and zero direct grants while public RPCs stay narrow invokers', async () => {
  await db.exec('reset role');
  assert.deepEqual(await one(`select relrowsecurity as rls, to_regclass('public.analysis_chat_turns') is null as private_only,
      has_table_privilege('public', 'private.analysis_chat_turns', 'SELECT') as pub_sel,
      has_table_privilege('anon', 'private.analysis_chat_turns', 'SELECT') as anon_sel,
      has_table_privilege('authenticated', 'private.analysis_chat_turns', 'SELECT') as auth_sel,
      has_table_privilege('authenticated', 'private.analysis_chat_turns', 'INSERT') as auth_ins,
      has_table_privilege('authenticated', 'private.analysis_chat_turns', 'UPDATE') as auth_upd,
      has_table_privilege('service_role', 'private.analysis_chat_turns', 'SELECT') as svc_sel
    from pg_class where oid = 'private.analysis_chat_turns'::regclass`), {
    rls: true, private_only: true,
    pub_sel: false, anon_sel: false, auth_sel: false, auth_ins: false, auth_upd: false, svc_sel: false,
  });

  const { rows: rpcs } = await db.query(`select n.nspname as schema, p.proname as name, p.prosecdef as definer,
      p.proconfig,
      has_function_privilege('public', p.oid, 'EXECUTE') as pub,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname in (
        'read_analysis_conversation', 'submit_analysis_chat_turn', 'submit_analysis_condition_turn',
        'decide_analysis_chat_turn',
        'normalize_analysis_chat_message', 'require_comparison_chat_sources', 'analysis_conversation_payload',
        'expected_comparison_period', 'check_approved_period_comparison', 'check_approved_condition_comparison',
        'normalize_area_tolerance', 'normalize_trade_kinds', 'normalize_replacements',
        'extract_run_replacements', 'is_demo_snapshot', 'analysis_condition_bounds',
        'finish_analysis_run_core',
        'read_comparison_work', 'finish_analysis_run', 'finish_analysis_comparison'
      )
    order by n.nspname, p.proname`);

  const byKey = new Map(rpcs.map(row => [`${row.schema}.${row.name}`, row]));
  for (const name of ['read_analysis_conversation', 'submit_analysis_chat_turn', 'submit_analysis_condition_turn', 'decide_analysis_chat_turn']) {
    const pubFn = byKey.get(`public.${name}`);
    const privFn = byKey.get(`private.${name}`);
    assert.deepEqual({ definer: pubFn.definer, pub: pubFn.pub, anon: pubFn.anon, auth: pubFn.auth, svc: pubFn.svc },
      { definer: false, pub: false, anon: false, auth: true, svc: false }, `public.${name}`);
    assert.deepEqual({ definer: privFn.definer, pub: privFn.pub, anon: privFn.anon, auth: privFn.auth, svc: privFn.svc },
      { definer: true, pub: false, anon: false, auth: true, svc: false }, `private.${name}`);
    assert.ok(pubFn.proconfig?.includes('search_path=""'), `public.${name} search_path`);
    assert.ok(privFn.proconfig?.includes('search_path=""'), `private.${name} search_path`);
  }
  for (const helper of [
    'private.normalize_analysis_chat_message', 'private.require_comparison_chat_sources',
    'private.analysis_conversation_payload', 'private.expected_comparison_period',
    'private.check_approved_period_comparison', 'private.check_approved_condition_comparison',
    'private.normalize_area_tolerance', 'private.normalize_trade_kinds', 'private.normalize_replacements',
    'private.extract_run_replacements', 'private.is_demo_snapshot', 'private.analysis_condition_bounds',
    'private.finish_analysis_run_core',
  ]) {
    const fn = byKey.get(helper);
    assert.deepEqual({ pub: fn.pub, anon: fn.anon, auth: fn.auth, svc: fn.svc },
      { pub: false, anon: false, auth: false, svc: false }, helper);
  }
  for (const workerFn of ['public.read_comparison_work', 'public.finish_analysis_run', 'public.finish_analysis_comparison']) {
    const fn = byKey.get(workerFn);
    assert.deepEqual({ pub: fn.pub, anon: fn.anon, auth: fn.auth, svc: fn.svc },
      { pub: false, anon: false, auth: false, svc: true }, workerFn);
  }

  // 인증 사용자는 대화 테이블이나 근거·분석 행을 직접 수정할 수 없다.
  const owner = await createOwner();
  await as('authenticated', owner.userId);
  await assert.rejects(db.query('select * from private.analysis_chat_turns'), forbidden);
  await assert.rejects(db.query('select * from private.comparison_evidence'), forbidden);
  await assert.rejects(db.query('select * from private.comparison_results'), forbidden);
  await assert.rejects(db.query("update public.analyses set conditions_snapshot = '{}' where id = $1", [owner.analysisId]), forbidden);
});

test('verified non-anonymous JWT auth, ownership, readiness and current source permissions gate all conversation RPCs', async () => {
  const owner = await createOwner();
  const sibling = await createOwner({ userId: owner.userId });
  const stranger = await createOwner();
  const unconfirmed = await createOwner({ verified: false });

  // 미완료·실패·취소·구형 완료 실행은 모두 comparison_not_ready(PT409)를 반환한다.
  await as('authenticated', owner.userId);
  const queued = await enqueue(owner, syntheticInput);
  const cancelled = await enqueue(owner, syntheticInput);
  await rpc('cancel_analysis_run', owner.analysisId, cancelled.runId);
  const legacy = await enqueue(owner, syntheticInput);
  const failed = await enqueue(owner, syntheticInput);
  await as('service_role');
  await finishRun(await claim(legacy), fixtureRequest, syntheticIngestion);
  await rpc('fail_analysis_run', ...lease(await claim(failed)), false);

  await as('authenticated', owner.userId);
  for (const runId of [queued.runId, cancelled.runId, legacy.runId, failed.runId]) {
    await assert.rejects(readConversation(owner, runId), notReady);
    await assert.rejects(submitTurn(owner, runId), notReady);
    await assert.rejects(decideTurn(owner, runId, randomUUID(), 'approve'), notReady);
  }

  const snapshotId = await saveCollectedSnapshot(owner, { registerEvidence: true });
  const { runId } = await finishCollectedSnapshotRun(owner, snapshotId, { withEvidence: true });
  await as('authenticated', owner.userId);
  const submitted = await submitTurn(owner, runId, {
    message: '기간을 좁혀서 다시 비교해 주세요', intent: 'change_period', start: '2026-10-20', end: '2026-10-24',
  });
  const pendingTurnId = submitted.turns[0].id;

  // 익명·미확인·정지·삭제·서비스 역할·문자열 is_anonymous JWT는 모두 42501이다.
  for (const [role, uid, claims, expected] of [
    ['anon', '', { is_anonymous: false }, forbidden],
    ['service_role', owner.userId, { is_anonymous: false }, forbidden],
    ['authenticated', '', { is_anonymous: false }, authRequired],
    ['authenticated', owner.userId, { is_anonymous: true }, authRequired],
    ['authenticated', owner.userId, { is_anonymous: 'false' }, authRequired],
    ['authenticated', randomUUID(), { is_anonymous: false }, authRequired],
    ['authenticated', unconfirmed.userId, { is_anonymous: false }, authRequired],
  ]) {
    await as(role, uid, claims);
    await assert.rejects(readConversation(owner, runId), expected);
    await assert.rejects(submitTurn(owner, runId), expected);
    await assert.rejects(decideTurn(owner, runId, pendingTurnId, 'cancel'), expected);
  }

  for (const flag of [
    'confirmed_at = null',
    'is_anonymous = true',
    "banned_until = now() + interval '1 hour'",
    'deleted_at = now()',
  ]) {
    await db.exec('reset role');
    await db.query(`update auth.users set ${flag} where id = $1`, [owner.userId]);
    await as('authenticated', owner.userId);
    await assert.rejects(readConversation(owner, runId), authRequired, flag);
    await assert.rejects(submitTurn(owner, runId), authRequired, flag);
    await assert.rejects(decideTurn(owner, runId, pendingTurnId, 'cancel'), authRequired, flag);
    await db.exec('reset role');
    await db.query('update auth.users set confirmed_at = now(), is_anonymous = false, banned_until = null, deleted_at = null where id = $1',
      [owner.userId]);
  }

  // 타 계정과 다른 분석·없는 실행·없는 턴은 PT404다.
  await as('authenticated', stranger.userId);
  await assert.rejects(readConversation(owner, runId), runNotFound);
  await assert.rejects(submitTurn(owner, runId), runNotFound);
  await assert.rejects(decideTurn(owner, runId, pendingTurnId, 'approve'), runNotFound);
  await as('authenticated', owner.userId);
  await assert.rejects(readConversation(sibling, runId), runNotFound);
  await assert.rejects(submitTurn(owner, randomUUID()), runNotFound);
  await assert.rejects(decideTurn(owner, runId, randomUUID(), 'cancel'), turnNotFound);

  // 출처 권한 철회 시 읽기·제출·재전송·결정이 모두 PT403이고 타인에게는 여전히 PT404다.
  const replayKey = randomUUID();
  await submitTurn(owner, runId, { requestId: replayKey, message: '보류 사유 확인', intent: 'holds' });
  for (const [sourceId, column, blocked, restored] of [
    ['applyhome_notice_pdf', 'display_permission', 'denied', 'allowed'],
    [supplementalSources[0], 'reuse_permission', 'unknown', 'allowed'],
    ['apt_trade', 'storage_permission', 'denied', 'allowed'],
    [supplementalSources[1], 'retention_days', 7, null],
  ]) {
    await db.exec('reset role');
    await db.query(`update public.source_registry set ${column} = $1 where id = $2`, [blocked, sourceId]);
    await as('authenticated', owner.userId);
    await assert.rejects(readConversation(owner, runId), sourceRestricted, sourceId);
    await assert.rejects(submitTurn(owner, runId, { message: '질문', intent: 'help' }), sourceRestricted, sourceId);
    await assert.rejects(submitTurn(owner, runId, { requestId: replayKey, message: '보류 사유 확인', intent: 'holds' }),
      sourceRestricted, sourceId);
    await assert.rejects(decideTurn(owner, runId, pendingTurnId, 'approve'), sourceRestricted, sourceId);
    await assert.rejects(decideTurn(owner, runId, pendingTurnId, 'cancel'), sourceRestricted, sourceId);
    await as('authenticated', stranger.userId);
    await assert.rejects(readConversation(owner, runId), runNotFound, sourceId);
    await db.exec('reset role');
    await db.query(`update public.source_registry set ${column} = $1 where id = $2`, [restored, sourceId]);
  }
  await as('authenticated', owner.userId);
  assert.equal((await readConversation(owner, runId)).turns.length, 2);
});

test('message trimming, 1-800 Unicode code points, control char rejection, intents and date rules are strictly enforced', async () => {
  const owner = await createOwner();
  const { runId } = await finishSyntheticRun(owner);
  await as('authenticated', owner.userId);

  // 널 ID 및 허용되지 않은 의도는 22023 invalid_analysis_chat_turn이다.
  await assert.rejects(rpc('read_analysis_conversation', null, runId), invalidTurn);
  await assert.rejects(rpc('read_analysis_conversation', owner.analysisId, null), invalidTurn);
  await assert.rejects(rpc('submit_analysis_chat_turn', owner.analysisId, runId, null, '질문', 'help'), invalidTurn);
  for (const badIntent of [null, '', 'unknown', 'assistant', 'CHANGE_PERIOD', 'change_area']) {
    await assert.rejects(submitTurn(owner, runId, { intent: badIntent }), invalidTurn, String(badIntent));
  }

  // 공백 전용·801 코드 포인트·줄바꿈(LF) 외 ASCII 제어 문자는 모두 거부한다.
  for (const badMessage of [
    null, '', '   ', '\n\n  \u3000\u00A0\uFEFF \n',
    '가'.repeat(801),
    '😀'.repeat(801),
    '합성\t질문', '\t앞탭', '뒤탭\t',
    '합성\r\n질문', '합성\r질문', '\r앞개행',
    '합성\x01질문', '합성\x07질문', '합성\x08질문', '합성\x0B질문',
    '합성\x0C질문', '합성\x1B질문', '합성\x1F질문', '합성\x7F질문',
  ]) {
    await assert.rejects(submitTurn(owner, runId, { message: badMessage, intent: 'help' }), invalidTurn);
  }

  // 날짜 쌍은 change_period에만 허용하며, 미완성·역전·동일 범위는 22023, 수집 범위 밖은 PT409다.
  for (const nonChangeIntent of ['inclusion', 'holds', 'scope', 'price', 'period', 'help']) {
    await assert.rejects(submitTurn(owner, runId, { intent: nonChangeIntent, start: '2026-10-20', end: '2026-10-24' }),
      invalidPeriod, nonChangeIntent);
    await assert.rejects(submitTurn(owner, runId, { intent: nonChangeIntent, start: '2026-10-20', end: null }),
      invalidPeriod, `${nonChangeIntent}-start-only`);
    await assert.rejects(submitTurn(owner, runId, { intent: nonChangeIntent, start: null, end: '2026-10-24' }),
      invalidPeriod, `${nonChangeIntent}-end-only`);
  }
  await assert.rejects(submitTurn(owner, runId, { intent: 'change_period' }), invalidPeriod);
  await assert.rejects(submitTurn(owner, runId, { intent: 'change_period', start: '2026-10-20', end: null }), invalidPeriod);
  await assert.rejects(submitTurn(owner, runId, { intent: 'change_period', start: null, end: '2026-10-24' }), invalidPeriod);
  await assert.rejects(submitTurn(owner, runId, { intent: 'change_period', start: '2026-10-25', end: '2026-10-24' }), invalidPeriod);
  // 현재 적용 기간(2026-10-10~2026-10-31)과 완전히 같은 범위는 중복 재실행을 막기 위해 22023으로 거부한다.
  await assert.rejects(submitTurn(owner, runId, { intent: 'change_period', start: '2026-10-10', end: '2026-10-31' }), invalidPeriod);
  // 원래 수집 기간 밖의 정렬된 날짜는 PT409 analysis_chat_period_unavailable이다.
  await assert.rejects(submitTurn(owner, runId, { intent: 'change_period', start: '2026-10-09', end: '2026-10-31' }), periodUnavailable);
  await assert.rejects(submitTurn(owner, runId, { intent: 'change_period', start: '2026-10-10', end: '2026-11-01' }), periodUnavailable);
  await assert.rejects(submitTurn(owner, runId, { intent: 'change_period', start: '2026-09-01', end: '2026-09-30' }), periodUnavailable);

  // 모든 7개 의도와 트림·내부 줄바꿈·정확히 800 코드 포인트(이모지 포함)를 허용한다.
  const emoji800 = '😀'.repeat(800);
  const firstKey = randomUUID();
  const res1 = await submitTurn(owner, runId, {
    requestId: firstKey, message: `  \n\u3000${emoji800}\u00A0\n  `, intent: 'inclusion',
  });
  assert.equal(res1.turns[0].message, emoji800);
  assert.equal([...res1.turns[0].message].length, 800);
  assert.equal(res1.turns[0].proposal, null);

  for (const [intent, msg] of [
    ['holds', '  첫 줄\n둘째 줄  '],
    ['scope', '지역 범위 설명'],
    ['price', '분양가 소계 확인'],
    ['period', '적용 기간 확인'],
    ['help', '도움말'],
  ]) {
    await submitTurn(owner, runId, { message: msg, intent });
  }
  const withProposal = await submitTurn(owner, runId, {
    message: '  10월 20일부터 24일까지로 바꿔주세요  ', intent: 'change_period', start: '2026-10-20', end: '2026-10-24',
  });
  assert.equal(withProposal.analysisId, owner.analysisId);
  assert.equal(withProposal.runId, runId);
  assert.equal(withProposal.previousRunId, null);
  assert.equal(withProposal.hasEarlier, false);
  assert.equal(withProposal.turns.length, 7);
  assert.equal(withProposal.turns[1].message, '첫 줄\n둘째 줄');
  assert.deepEqual(withProposal.turns[6].proposal, {
    start: '2026-10-20', end: '2026-10-24',
    previousStart: '2026-10-10', previousEnd: '2026-10-31',
    status: 'pending', resultRunId: null,
  });

  // 저장 테이블에는 사용자 메시지와 의도·제안 메타데이터만 남고 외부 응답 원문 컬럼이 없다.
  await db.exec('reset role');
  const { rows: cols } = await db.query(`select column_name from information_schema.columns
    where table_schema = 'private' and table_name = 'analysis_chat_turns' order by ordinal_position`);
  assert.deepEqual(cols.map(c => c.column_name), [
    'id', 'analysis_id', 'base_run_id', 'user_id', 'request_id', 'turn_order',
    'message', 'intent', 'created_at', 'proposed_start', 'proposed_end',
    'previous_start', 'previous_end', 'proposal_status', 'decided_at', 'result_run_id',
    'proposed_conditions', 'previous_conditions', 'effective_conditions',
  ]);
});

test('idempotency, conflicting reuse, latest-30 chronological paging and per-run isolation work cleanly', async () => {
  const owner = await createOwner();
  const sibling = await createOwner({ userId: owner.userId });
  const { runId: r1 } = await finishSyntheticRun(owner);
  const { runId: siblingRun } = await finishSyntheticRun(sibling);

  await as('authenticated', owner.userId);
  const sharedKey = randomUUID();
  const first = await submitTurn(owner, r1, { requestId: sharedKey, message: '  합성 질문 1  ', intent: 'scope' });
  const replay = await submitTurn(owner, r1, { requestId: sharedKey, message: '합성 질문 1', intent: 'scope' });
  assert.deepEqual(replay, first);

  // 같은 키에 메시지·의도·기간을 바꾸면 PT409 analysis_chat_request_conflict다.
  await assert.rejects(submitTurn(owner, r1, { requestId: sharedKey, message: '다른 합성 질문', intent: 'scope' }), requestConflict);
  await assert.rejects(submitTurn(owner, r1, { requestId: sharedKey, message: '합성 질문 1', intent: 'holds' }), requestConflict);
  await assert.rejects(submitTurn(owner, r1, {
    requestId: sharedKey, message: '합성 질문 1', intent: 'change_period', start: '2026-10-20', end: '2026-10-24',
  }), requestConflict);

  const proposalKey = randomUUID();
  await submitTurn(owner, r1, {
    requestId: proposalKey, message: '기간 제안', intent: 'change_period', start: '2026-10-20', end: '2026-10-24',
  });
  await assert.rejects(submitTurn(owner, r1, {
    requestId: proposalKey, message: '기간 제안', intent: 'change_period', start: '2026-10-20', end: '2026-10-25',
  }), requestConflict);

  // 다른 분석의 대화에서는 같은 요청 키를 독립적으로 사용할 수 있고 대화 이력도 분리된다.
  const otherConv = await submitTurn(sibling, siblingRun, { requestId: sharedKey, message: '별도 분석 질문', intent: 'price' });
  assert.equal(otherConv.turns.length, 1);
  assert.equal(otherConv.turns[0].message, '별도 분석 질문');

  // 30개까지는 hasEarlier=false, 31개 이상이면 최신 30개를 시간순으로 반환하고 hasEarlier=true다.
  for (let i = 3; i <= 30; i += 1) {
    await submitTurn(owner, r1, { message: `합성 질문 ${i}`, intent: 'help' });
  }
  const at30 = await readConversation(owner, r1);
  assert.equal(at30.turns.length, 30);
  assert.equal(at30.hasEarlier, false);
  assert.equal(at30.turns[0].message, '합성 질문 1');
  assert.equal(at30.turns[29].message, '합성 질문 30');

  const at31 = await submitTurn(owner, r1, { message: '합성 질문 31', intent: 'help' });
  assert.equal(at31.turns.length, 30);
  assert.equal(at31.hasEarlier, true);
  assert.equal(at31.turns[0].message, '기간 제안');
  assert.equal(at31.turns[29].message, '합성 질문 31');

  const at32 = await submitTurn(owner, r1, { message: '합성 질문 32', intent: 'help' });
  assert.equal(at32.turns.length, 30);
  assert.equal(at32.hasEarlier, true);
  assert.equal(at32.turns[0].message, '합성 질문 3');
  assert.equal(at32.turns[29].message, '합성 질문 32');
  for (const turn of at32.turns) {
    assert.equal(turn.runId, r1);
    assert.ok(Number.isFinite(Date.parse(turn.createdAt)));
  }
});

test('explicit approve/reject/cancel, stale-run protection, serialization, idempotent replays and PT429 rate limits work', async () => {
  const owner = await createOwner();
  const sibling = await createOwner({ userId: owner.userId });
  const { runId: r1 } = await finishSyntheticRun(owner);
  const { runId: siblingRun } = await finishSyntheticRun(sibling);

  await as('authenticated', owner.userId);
  const readOnly = await submitTurn(owner, r1, { message: '일반 질문', intent: 'holds' });
  const readOnlyTurnId = readOnly.turns[0].id;

  // 잘못된 결정 동사와 제안 없는 턴에 대한 결정은 각각 22023 / PT409다.
  for (const badVerb of [null, '', 'approved', 'rejected', 'cancelled', 'confirm']) {
    await assert.rejects(decideTurn(owner, r1, readOnlyTurnId, badVerb), invalidDecision, String(badVerb));
  }
  for (const verb of ['approve', 'reject', 'cancel']) {
    await assert.rejects(decideTurn(owner, r1, readOnlyTurnId, verb), decisionConflict, verb);
  }

  // 거절과 취소는 실행을 만들지 않으며 동일 결정은 멱등이고 다른 결정은 충돌(PT409)이다.
  const rejectSubmit = await submitTurn(owner, r1, {
    message: '거절될 제안', intent: 'change_period', start: '2026-10-15', end: '2026-10-25',
  });
  const rejectTurnId = rejectSubmit.turns.at(-1).id;
  const rejected = await decideTurn(owner, r1, rejectTurnId, 'reject');
  assert.equal(rejected.turns.at(-1).proposal.status, 'rejected');
  assert.equal(rejected.turns.at(-1).proposal.resultRunId, null);
  assert.deepEqual(await decideTurn(owner, r1, rejectTurnId, 'reject'), rejected);
  await assert.rejects(decideTurn(owner, r1, rejectTurnId, 'approve'), decisionConflict);
  await assert.rejects(decideTurn(owner, r1, rejectTurnId, 'cancel'), decisionConflict);

  const cancelSubmit = await submitTurn(owner, r1, {
    message: '취소될 제안', intent: 'change_period', start: '2026-10-16', end: '2026-10-25',
  });
  const cancelTurnId = cancelSubmit.turns.at(-1).id;
  const cancelled = await decideTurn(owner, r1, cancelTurnId, 'cancel');
  assert.equal(cancelled.turns.at(-1).proposal.status, 'cancelled');
  assert.equal(cancelled.turns.at(-1).proposal.resultRunId, null);
  assert.deepEqual(await decideTurn(owner, r1, cancelTurnId, 'cancel'), cancelled);
  await assert.rejects(decideTurn(owner, r1, cancelTurnId, 'approve'), decisionConflict);
  await assert.rejects(decideTurn(owner, r1, cancelTurnId, 'reject'), decisionConflict);

  // 대기 제안 두 건을 제출해도 승인 전에는 새 실행이 생기지 않는다.
  const approveKey = randomUUID();
  const p1 = await submitTurn(owner, r1, {
    requestId: approveKey, message: '첫 승인 제안', intent: 'change_period', start: '2026-10-20', end: '2026-10-24',
  });
  const t1Id = p1.turns.at(-1).id;
  const p2 = await submitTurn(owner, r1, {
    message: '두 번째 대기 제안', intent: 'change_period', start: '2026-10-18', end: '2026-10-24',
  });
  const t2Id = p2.turns.at(-1).id;
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from private.analysis_runs where analysis_id = $1', [owner.analysisId])).n, 1);

  // T1 승인 시 새 스냅샷 실행 하나만 생성되고 공유 프로필·다른 분석·원본 비교는 불변이다.
  await as('authenticated', owner.userId);
  const [approved, approvedReplay] = await Promise.all([
    decideTurn(owner, r1, t1Id, 'approve'),
    decideTurn(owner, r1, t1Id, 'approve'),
  ]);
  assert.deepEqual(approvedReplay, approved);
  const t1After = approved.turns.find(t => t.id === t1Id);
  assert.equal(t1After.proposal.status, 'approved');
  assert.match(t1After.proposal.resultRunId, /^[0-9a-f-]{36}$/);
  assert.notEqual(t1After.proposal.resultRunId, r1);
  await assert.rejects(decideTurn(owner, r1, t1Id, 'reject'), decisionConflict);
  await assert.rejects(decideTurn(owner, r1, t1Id, 'cancel'), decisionConflict);

  // 오래된 기준 실행(r1)에서는 정확히 같은 키의 멱등 재전송과 읽기 전용 질문·기존 대기의 거절/취소만 허용된다.
  assert.deepEqual(await submitTurn(owner, r1, {
    requestId: approveKey, message: '첫 승인 제안', intent: 'change_period', start: '2026-10-20', end: '2026-10-24',
  }), approved);
  await assert.rejects(submitTurn(owner, r1, {
    requestId: approveKey, message: '다른 메시지', intent: 'change_period', start: '2026-10-20', end: '2026-10-24',
  }), requestConflict);
  await assert.rejects(submitTurn(owner, r1, {
    message: '오래된 결과에서 새 기간 제안', intent: 'change_period', start: '2026-10-15', end: '2026-10-20',
  }), staleRun);
  await assert.rejects(decideTurn(owner, r1, t2Id, 'approve'), staleRun);
  const historicalReadOnly = await submitTurn(owner, r1, { message: '이전 결과에서 보류 질문', intent: 'holds' });
  assert.equal(historicalReadOnly.turns.at(-1).message, '이전 결과에서 보류 질문');
  const t2Cancelled = await decideTurn(owner, r1, t2Id, 'cancel');
  assert.equal(t2Cancelled.turns.find(t => t.id === t2Id).proposal.status, 'cancelled');

  // 공유 프로필과 다른 분석은 승인에 영향받지 않는다.
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from private.analysis_runs where analysis_id = $1', [owner.analysisId])).n, 2);
  assert.equal((await one('select count(*)::int as n from private.analysis_runs where analysis_id = $1', [sibling.analysisId])).n, 1);
  assert.deepEqual(await one('select search_conditions, commute_destination, revision from public.user_profiles where user_id = $1',
    [owner.userId]), {
    search_conditions: { region_codes: ['11215'], budget_max_won: '900000000' },
    commute_destination: '합성 강남역',
    revision: 3,
  });
  assert.equal((await one('select count(*)::int as n from public.profile_change_requests where user_id = $1', [owner.userId])).n, 0);

  // 분석의 조건·규칙 버전이 변경된 경우도 오래된 기준 실행으로 차단한다.
  await as('authenticated', sibling.userId);
  const sibProp = await submitTurn(sibling, siblingRun, {
    message: '형제 분석 기간 변경', intent: 'change_period', start: '2026-10-20', end: '2026-10-24',
  });
  const sibTurnId = sibProp.turns[0].id;
  await db.exec('reset role');
  await db.query("update public.analyses set rules_version = 'prd-2.0-synthetic' where id = $1", [sibling.analysisId]);
  await as('authenticated', sibling.userId);
  await assert.rejects(submitTurn(sibling, siblingRun, {
    message: '변경 후 새 제안', intent: 'change_period', start: '2026-10-15', end: '2026-10-24',
  }), staleRun);
  await assert.rejects(decideTurn(sibling, siblingRun, sibTurnId, 'approve'), staleRun);
  const sibRejected = await decideTurn(sibling, siblingRun, sibTurnId, 'reject');
  assert.equal(sibRejected.turns[0].proposal.status, 'rejected');

  // 큐 분당 한도(12건)에 도달하면 승인은 PT429로 롤백되어 제안이 pending으로 남고, 기존 승인 재전송은 막히지 않는다.
  const capped = await createOwner();
  const { runId: capRun } = await finishSyntheticRun(capped);
  await as('authenticated', capped.userId);
  const capProp = await submitTurn(capped, capRun, {
    message: '한도 검사 제안', intent: 'change_period', start: '2026-10-20', end: '2026-10-24',
  });
  const capTurnId = capProp.turns[0].id;
  const filler = await createOwner({ userId: capped.userId });
  await as('authenticated', capped.userId);
  for (let i = 0; i < 11; i += 1) {
    await enqueue(filler, syntheticInput);
  }
  await assert.rejects(decideTurn(capped, capRun, capTurnId, 'approve'), rateLimited);
  const afterRateLimit = await readConversation(capped, capRun);
  assert.equal(afterRateLimit.turns[0].proposal.status, 'pending');
  assert.equal(afterRateLimit.turns[0].proposal.resultRunId, null);
  // 이미 승인된 턴의 멱등 재전송은 큐 한도에 도달했더라도 그대로 성공한다.
  await as('authenticated', owner.userId);
  for (let i = 0; i < 9; i += 1) {
    await enqueue(sibling, syntheticInput);
  }
  assert.equal((await decideTurn(owner, r1, t1Id, 'approve')).turns.find(t => t.id === t1Id).proposal.resultRunId,
    t1After.proposal.resultRunId);
});

test('worker linkage enforces authoritative comparisonPeriod, inclusive endpoints, re-widening and previousRunId navigation', async () => {
  const owner = await createOwner();
  const { runId: r1, snapshotId, comparison: originalComparison } = await finishSyntheticRun(owner);

  // 일반 스냅샷 재실행은 conditions_snapshot에 사용자 지정 comparisonPeriod가 들어있어도 comparisonPeriod를 전달하지 않는다.
  await as('authenticated', owner.userId);
  const ordinaryReplay = await enqueue(owner, snapshotInput(snapshotId));
  await as('service_role');
  const ordinaryJob = await claim(ordinaryReplay);
  const ordinaryWork = await readWork(ordinaryJob);
  assert.equal('comparisonPeriod' in ordinaryWork, false);
  await finishComparison(ordinaryJob, originalComparison, null, null);
  await as('authenticated', owner.userId);
  assert.equal((await readConversation(owner, ordinaryReplay.runId)).previousRunId, null);

  // 최신 실행(ordinaryReplay)에서 2026-10-20~2026-10-24(양 끝 포함)로 축소를 제안·승인한다.
  const narrowSubmit = await submitTurn(owner, ordinaryReplay.runId, {
    message: '10월 20일부터 24일까지만 보고 싶어요', intent: 'change_period', start: '2026-10-20', end: '2026-10-24',
  });
  const narrowApproved = await decideTurn(owner, ordinaryReplay.runId, narrowSubmit.turns[0].id, 'approve');
  const r2 = narrowApproved.turns[0].proposal.resultRunId;
  await assert.rejects(readConversation(owner, r2), notReady);

  // 작업자는 승인된 턴에서 나온 comparisonPeriod를 받고, 구형 스크립트의 미필터 저장과 finish_analysis_run 우회를 차단한다.
  await as('service_role');
  const job2 = await claim({ runId: r2 });
  const work2 = await readWork(job2);
  assert.deepEqual(work2.comparisonPeriod, { start: '2026-10-20', end: '2026-10-24' });
  assert.equal(work2.useSyntheticFixture, true);
  assert.equal(work2.evidence, null);

  // 1) finish_analysis_run 직접 호출 차단 (비교 검증 우회 방지)
  await assert.rejects(finishRun(job2, null, null), { code: '22023', message: 'comparison_finish_required' });
  // 2) 기존 미필터 비교 결과 저장 차단
  await assert.rejects(finishComparison(job2, originalComparison, null, null), invalidComparison);
  // 3) 기간 헤더만 바꾸고 범위 밖 거래 관측(2026-10-26, 2026-10-19)·건수 불일치·다른 월 수집·다른 대상 모델을 남긴 결과 차단
  const prepared2 = runWorkerPrepare(job2.input, work2);
  assert.equal(prepared2.inputs, null);
  assert.equal(prepared2.capture, null);
  const narrowedComparison = prepared2.comparison;
  const withLateTrade = structuredClone(narrowedComparison);
  withLateTrade.comparables[1].tradeStats.presale_right.observations.push({
    ...withLateTrade.comparables[1].tradeStats.presale_right.observations[0], contractDate: '2026-10-26',
  });
  withLateTrade.comparables[1].tradeStats.presale_right.count = 2;
  const withEarlyTrade = structuredClone(narrowedComparison);
  withEarlyTrade.comparables[0].tradeStats.sale.observations[0].contractDate = '2026-10-19';
  const withBadCount = structuredClone(narrowedComparison);
  withBadCount.comparables[0].tradeStats.sale.count = 99;
  const withWrongSource = structuredClone(narrowedComparison);
  withWrongSource.conditions.period.source = 'default_recent_year';
  const withExtraMonthCollection = structuredClone(narrowedComparison);
  withExtraMonthCollection.collections.push({ ...withExtraMonthCollection.collections[0], month: '2026-09' });
  const withChangedModel = structuredClone(narrowedComparison);
  withChangedModel.target.modelNo = '99';
  const withChangedTarget = structuredClone(narrowedComparison);
  withChangedTarget.target.houseManageNo = '9900000999';
  const withChangedTargetArea = structuredClone(narrowedComparison);
  withChangedTargetArea.target.supplyArea.m2 = '115.000';
  const withChangedTargetComplex = structuredClone(narrowedComparison);
  withChangedTargetComplex.target.complexId = 'synthetic-other-complex';
  const withChangedNoticePriceWon = structuredClone(narrowedComparison);
  withChangedNoticePriceWon.noticePrice.minWon = '690000000';
  const withChangedNoticePriceEvidence = structuredClone(narrowedComparison);
  withChangedNoticePriceEvidence.noticePrice.confirmedRooms[0].evidence.salePrice[0].page = 99;
  const withChangedNoticePriceStatus = structuredClone(narrowedComparison);
  withChangedNoticePriceStatus.noticePrice.status = 'held';
  const withNullNoticePrice = structuredClone(narrowedComparison);
  withNullNoticePrice.noticePrice = null;
  const withChangedAreaTolerance = structuredClone(narrowedComparison);
  withChangedAreaTolerance.conditions.area.tolerancePercent = '10';
  const withChangedAreaBounds = structuredClone(narrowedComparison);
  withChangedAreaBounds.conditions.area.maxM2 = '120.00000';
  const withExtraCondition = structuredClone(narrowedComparison);
  withExtraCondition.conditions.maxComparables = 3;

  for (const bad of [
    withLateTrade, withEarlyTrade, withBadCount, withWrongSource,
    withExtraMonthCollection, withChangedModel, withChangedTarget,
    withChangedTargetArea, withChangedTargetComplex,
    withChangedNoticePriceWon, withChangedNoticePriceEvidence, withChangedNoticePriceStatus, withNullNoticePrice,
    withChangedAreaTolerance, withChangedAreaBounds, withExtraCondition,
  ]) {
    await assert.rejects(finishComparison(job2, bad, null, null), invalidComparison);
    // 실패한 완료 시도는 전체 롤백되어 실행이 running 상태로 남고 비교 결과가 저장되지 않는다.
    await db.exec('reset role');
    assert.equal((await one('select status from private.analysis_runs where id = $1', [r2])).status, 'running');
    assert.equal(await one('select run_id from private.comparison_results where run_id = $1', [r2]), undefined);
    await as('service_role');
  }
  // 스냅샷 실행에 새 입력/결과를 넣으려는 시도도 차단한다.
  await assert.rejects(finishComparison(job2, narrowedComparison, fixtureRequest, syntheticIngestion), { code: '22023' });

  // 양 끝 날짜(2026-10-20, 2026-10-24)를 모두 포함한 정상 비교 결과로 완료한다.
  const datesInNarrowed = narrowedComparison.comparables.flatMap(c =>
    Object.values(c.tradeStats).flatMap(stat => stat.observations.map(o => o.contractDate)));
  assert.deepEqual(datesInNarrowed.sort(), ['2026-10-20', '2026-10-24']);
  const done2 = await finishComparison(job2, narrowedComparison, null, null);
  assert.equal(done2.status, 'finished');
  assert.equal(done2.snapshotId, snapshotId);

  // 새 세션처럼 다시 열면 r2는 자신의 빈 대화와 previousRunId(직전 승인 기준 실행)를 반환하고, 이전 결과는 불변이다.
  const expectedBounds = {
    editable: true,
    period: { start: '2026-10-10', end: '2026-10-31', asOf: '2026-11-10' },
    tradeKinds: ['sale', 'presale_right', 'occupancy_right'],
    areaToleranceMax: '5',
    areaEditable: false,
    replacementsEditable: true,
  };
  await as('authenticated', owner.userId);
  const conv2 = await readConversation(owner, r2);
  assert.deepEqual(conv2, {
    analysisId: owner.analysisId, runId: r2, previousRunId: ordinaryReplay.runId,
    conditionBounds: expectedBounds, turns: [], hasEarlier: false,
  });
  assert.deepEqual((await getComparison(owner, r2)).result, narrowedComparison);
  assert.deepEqual((await getComparison(owner, ordinaryReplay.runId)).result, originalComparison);
  assert.equal((await readConversation(owner, ordinaryReplay.runId)).turns[0].proposal.resultRunId, r2);

  // 축소된 r2에서 원래 수집 기간(2026-10-10~2026-10-31) 안으로 다시 확대할 수 있으며, 그 바깥은 PT409다.
  await assert.rejects(submitTurn(owner, r2, {
    message: '현재와 동일한 축소 기간', intent: 'change_period', start: '2026-10-20', end: '2026-10-24',
  }), invalidPeriod);
  await assert.rejects(submitTurn(owner, r2, {
    message: '원래 수집 창보다 하루 넓게', intent: 'change_period', start: '2026-10-09', end: '2026-10-31',
  }), periodUnavailable);

  const widenSubmit = await submitTurn(owner, r2, {
    message: '원래 전체 수집 기간으로 다시 넓혀 주세요', intent: 'change_period', start: '2026-10-10', end: '2026-10-31',
  });
  assert.deepEqual(widenSubmit.turns[0].proposal, {
    start: '2026-10-10', end: '2026-10-31',
    previousStart: '2026-10-20', previousEnd: '2026-10-24',
    status: 'pending', resultRunId: null,
  });
  const widenApproved = await decideTurn(owner, r2, widenSubmit.turns[0].id, 'approve');
  const r3 = widenApproved.turns[0].proposal.resultRunId;

  await as('service_role');
  const job3 = await claim({ runId: r3 });
  const work3 = await readWork(job3);
  assert.deepEqual(work3.comparisonPeriod, { start: '2026-10-10', end: '2026-10-31' });
  const rewidenedComparison = runWorkerPrepare(job3.input, work3).comparison;
  await finishComparison(job3, rewidenedComparison, null, null);

  await as('authenticated', owner.userId);
  const conv3 = await readConversation(owner, r3);
  assert.deepEqual(conv3, {
    analysisId: owner.analysisId, runId: r3, previousRunId: r2,
    conditionBounds: expectedBounds, turns: [], hasEarlier: false,
  });
  assert.equal((await readConversation(owner, r2)).previousRunId, ordinaryReplay.runId);
  assert.equal((await readConversation(owner, r1)).previousRunId, null);
  assert.equal((await getComparison(owner, r2)).result.conditions.period.start, '2026-10-20');
  assert.equal((await getComparison(owner, r3)).result.conditions.period.start, '2026-10-10');
});

test('collected evidence pinning, notice-run no-escalation checks, leap-day holds and inaccessible previousRunId are enforced', async () => {
  // 1) 근거 없이 완료한 수집 스냅샷에 뒤늦게 근거를 등록해도 승인 재실행은 기준 실행의 근거 없음(false)을 유지한다.
  const unpinnedOwner = await createOwner();
  const unpinnedSnapshot = await saveCollectedSnapshot(unpinnedOwner, { registerEvidence: false });
  const { runId: unpinnedRun } = await finishCollectedSnapshotRun(unpinnedOwner, unpinnedSnapshot, { withEvidence: false });
  await as('service_role');
  await rpc('register_comparison_evidence', unpinnedSnapshot, json(collectedEvidence), evidenceSourceIds);

  await as('authenticated', unpinnedOwner.userId);
  const unpinnedTurn = await submitTurn(unpinnedOwner, unpinnedRun, {
    message: '근거 없는 스냅샷 기간 변경', intent: 'change_period', start: '2026-10-20', end: '2026-10-24',
  });
  const unpinnedNext = (await decideTurn(unpinnedOwner, unpinnedRun, unpinnedTurn.turns[0].id, 'approve'))
    .turns[0].proposal.resultRunId;

  await as('service_role');
  const unpinnedJob = await claim({ runId: unpinnedNext });
  const unpinnedWork = await readWork(unpinnedJob);
  assert.equal(unpinnedWork.evidence, null);
  assert.equal(unpinnedWork.useSyntheticFixture, false);
  assert.deepEqual(unpinnedWork.comparisonPeriod, { start: '2026-10-20', end: '2026-10-24' });
  // 근거 없는 재실행에 근거 있는 비교 결과를 저장하려는 권한 상승 시도는 차단한다.
  const forgedWithEvidence = runCompare(collectedIngestion, { modelNo: '01' }, collectedEvidence,
    { start: '2026-10-20', end: '2026-10-24' });
  await assert.rejects(finishComparison(unpinnedJob, forgedWithEvidence, null, null), invalidComparison);
  const honestUnpinned = runCompare(collectedIngestion, { modelNo: '01' }, null,
    { start: '2026-10-20', end: '2026-10-24' });
  await finishComparison(unpinnedJob, honestUnpinned, null, null);

  // 2) 근거가 고정된 수집 스냅샷의 승인 재실행은 근거와 출처 제약을 그대로 유지한다.
  const pinnedOwner = await createOwner();
  const pinnedSnapshot = await saveCollectedSnapshot(pinnedOwner, { registerEvidence: true });
  const { runId: pinnedRun } = await finishCollectedSnapshotRun(pinnedOwner, pinnedSnapshot, { withEvidence: true });
  await as('authenticated', pinnedOwner.userId);
  const pinnedTurn = await submitTurn(pinnedOwner, pinnedRun, {
    message: '근거 고정 스냅샷 기간 변경', intent: 'change_period', start: '2026-10-20', end: '2026-10-24',
  });
  const pinnedNext = (await decideTurn(pinnedOwner, pinnedRun, pinnedTurn.turns[0].id, 'approve'))
    .turns[0].proposal.resultRunId;
  await as('service_role');
  const pinnedJob = await claim({ runId: pinnedNext });
  const pinnedWork = await readWork(pinnedJob);
  assert.deepEqual(pinnedWork.evidence, collectedEvidence);
  assert.deepEqual(pinnedWork.comparisonPeriod, { start: '2026-10-20', end: '2026-10-24' });
  await finishComparison(pinnedJob, forgedWithEvidence, null, null);

  // 기준 실행의 출처가 제한되어 접근 불가능한 경우 previousRunId는 null로 숨긴다.
  await db.exec('reset role');
  await db.query("update private.comparison_results set source_ids = array['restricted_synthetic_base'] where run_id = $1",
    [pinnedRun]);
  await as('authenticated', pinnedOwner.userId);
  assert.equal((await readConversation(pinnedOwner, pinnedNext)).previousRunId, null);

  // 3) 공고 실행(13개월 수집, 근거 없음)의 기간 축소는 해당 계약월 수집만 허용하고 비교 후보 생성을 차단한다.
  await allowSources(noticeSourceIds);
  const noticeOwner = await createOwner({ conditionsSnapshot: {} });
  const bundle = noticeCaptureBundle('2026-11-10');
  await as('service_role');
  await rpc('publish_notice_directory', json(bundle.index), json({ 99999: '합성 가람구' }));
  await as('authenticated', noticeOwner.userId);
  const noticeRun = await enqueue(noticeOwner, bundle.input);
  await db.exec('reset role');
  await db.query(`update private.analysis_runs set basis_date = '2026-11-10',
    notice_request = jsonb_set(notice_request, '{asOf}', '"2026-11-10"') where id = $1`, [noticeRun.runId]);
  await as('service_role');
  const noticeJob = await claim(noticeRun);
  await finishComparison(noticeJob, bundle.comparison, bundle.request, bundle.result);

  await as('authenticated', noticeOwner.userId);
  const noticeTurn = await submitTurn(noticeOwner, noticeRun.runId, {
    message: '최근 2개월로 줄여 주세요', intent: 'change_period', start: '2026-09-01', end: '2026-10-31',
  });
  assert.deepEqual(noticeTurn.turns[0].proposal, {
    start: '2026-09-01', end: '2026-10-31',
    previousStart: '2025-11-11', previousEnd: '2026-11-10',
    status: 'pending', resultRunId: null,
  });
  const noticeNext = (await decideTurn(noticeOwner, noticeRun.runId, noticeTurn.turns[0].id, 'approve'))
    .turns[0].proposal.resultRunId;

  await as('service_role');
  const noticeNextJob = await claim({ runId: noticeNext });
  assert.deepEqual((await readWork(noticeNextJob)).comparisonPeriod, { start: '2026-09-01', end: '2026-10-31' });
  const noticeNarrowed = runCompare(bundle.result, { modelNo: '01' }, null, { start: '2026-09-01', end: '2026-10-31' });
  assert.equal(noticeNarrowed.collections.length, 4);
  // 13개월 미필터 수집 목록이나 조작된 수집 목록은 차단한다.
  await assert.rejects(finishComparison(noticeNextJob, {
    ...noticeNarrowed, collections: bundle.comparison.collections,
  }, null, null), invalidComparison);
  await assert.rejects(finishComparison(noticeNextJob, {
    ...noticeNarrowed, collections: [],
  }, null, null), invalidComparison);
  await finishComparison(noticeNextJob, noticeNarrowed, null, null);

  await as('authenticated', noticeOwner.userId);
  assert.equal((await readConversation(noticeOwner, noticeNext)).previousRunId, noticeRun.runId);

  // 4) 윤일 보류(decision_required) 공고 실행에서는 기간 변경은 PT409, 읽기 전용 질문은 허용한다.
  const leapOwner = await createOwner({ conditionsSnapshot: {} });
  const leapBundle = noticeCaptureBundle('2028-02-29');
  await as('authenticated', leapOwner.userId);
  const leapRun = await enqueue(leapOwner, leapBundle.input);
  await db.exec('reset role');
  await db.query(`update private.analysis_runs set basis_date = '2028-02-29',
    notice_request = jsonb_set(notice_request, '{asOf}', '"2028-02-29"') where id = $1`, [leapRun.runId]);
  await as('service_role');
  await finishComparison(await claim(leapRun), leapBundle.comparison, leapBundle.request, leapBundle.result);
  await as('authenticated', leapOwner.userId);
  await assert.rejects(submitTurn(leapOwner, leapRun.runId, {
    message: '윤일 보류 결과 기간 변경 시도', intent: 'change_period', start: '2028-01-01', end: '2028-02-28',
  }), periodUnavailable);
  const leapReadOnly = await submitTurn(leapOwner, leapRun.runId, {
    message: '왜 기간이 보류됐나요?', intent: 'period',
  });
  assert.equal(leapReadOnly.turns.length, 1);
  assert.equal(leapReadOnly.turns[0].proposal, null);

  // 5) 기준일이 월말(예: 2026-10-31, 2028-02-29, 2025-12-31)일 때도 inProgressMonth가 BE-02 trade_period와 정확히 일치하며
  //    기간 축소로 인한 정당한 지역 확대(priority→expansion)·순위/보류 변화는 보존된다.
  await db.exec('reset role');
  for (const [asOf, start, end, expectedInProgress] of [
    ['2026-10-31', '2026-10-10', '2026-10-31', '202610'],
    ['2026-10-31', '2026-10-10', '2026-10-20', '202610'],
    ['2026-10-31', '2026-09-01', '2026-09-30', null],
    ['2028-02-29', '2027-03-01', '2028-02-29', '202802'],
    ['2025-12-31', '2025-12-01', '2025-12-31', '202512'],
  ]) {
    const sqlPeriod = (await one('select private.expected_comparison_period($1::date, $2::date, $3::date) as p',
      [asOf, start, end])).p;
    const pyPeriod = JSON.parse(execFileSync('python3', [
      '-c', 'import json, sys; sys.path.insert(0, "scripts"); from ingestion_trades import trade_period; print(json.dumps(trade_period(*sys.argv[1:])))',
      asOf, start, end,
    ], { cwd: root, encoding: 'utf8' }));
    assert.deepEqual(sqlPeriod, pyPeriod, `${asOf}:${start}..${end}`);
    assert.equal(sqlPeriod.inProgressMonth, expectedInProgress, `${asOf}:${start}..${end}`);
  }

  // 월말 기준일(2026-10-31) 수집본에서 거래가 없는 기간(2026-10-10~2026-10-15)으로 축소하면
  // target·noticePrice·비기간 조건은 유지된 채 appliedScope가 priority→expansion으로 변한 정당한 결과를 허용한다.
  const monthEndOwner = await createOwner();
  const monthEndReq = { ...fixtureRequest, asOf: '2026-10-31', start: '2026-10-10', end: '2026-10-31' };
  const monthEndIngestion = {
    ...collectedIngestion,
    asOf: '2026-10-31',
    period: {
      status: 'confirmed', source: 'user_confirmed', asOf: '2026-10-31',
      start: '2026-10-10', end: '2026-10-31', bounds: 'inclusive',
      months: ['202610'], inProgressMonth: '202610', decision: null,
    },
  };
  await allowSources([...collectedCaptureSources, ...supplementalSources]);
  await as('service_role');
  const monthEndSnap = await rpc('save_ingestion_snapshot', monthEndOwner.userId, monthEndOwner.analysisId, randomUUID(),
    json(monthEndReq), json(monthEndIngestion));
  await rpc('register_comparison_evidence', monthEndSnap, json(collectedEvidence), evidenceSourceIds);
  await as('authenticated', monthEndOwner.userId);
  const meRun1 = await enqueue(monthEndOwner, snapshotInput(monthEndSnap));
  await as('service_role');
  const meBaseComp = runCompare(monthEndIngestion, { modelNo: '01' }, collectedEvidence);
  assert.equal(meBaseComp.appliedScope, 'priority');
  assert.equal(meBaseComp.conditions.period.inProgressMonth, '202610');
  await finishComparison(await claim(meRun1), meBaseComp, null, null);

  await as('authenticated', monthEndOwner.userId);
  const meTurn = await submitTurn(monthEndOwner, meRun1.runId, {
    message: '10월 10일부터 15일까지로 좁혀 주세요', intent: 'change_period', start: '2026-10-10', end: '2026-10-15',
  });
  const meRun2Id = (await decideTurn(monthEndOwner, meRun1.runId, meTurn.turns[0].id, 'approve'))
    .turns[0].proposal.resultRunId;
  await as('service_role');
  const meJob2 = await claim({ runId: meRun2Id });
  const meWork2 = await readWork(meJob2);
  const meNarrowedComp = runWorkerPrepare(meJob2.input, meWork2).comparison;
  assert.equal(meNarrowedComp.appliedScope, 'expansion');
  assert.equal(meNarrowedComp.conditions.period.inProgressMonth, '202610');
  assert.equal(meNarrowedComp.comparables.length, 0);
  // inProgressMonth를 임의로 null로 바꾼 결과는 BE-02 불일치로 거부하고, 정당한 expansion 결과는 저장된다.
  await assert.rejects(finishComparison(meJob2, {
    ...meNarrowedComp,
    conditions: { ...meNarrowedComp.conditions, period: { ...meNarrowedComp.conditions.period, inProgressMonth: null } },
  }, null, null), invalidComparison);
  const meDone2 = await finishComparison(meJob2, meNarrowedComp, null, null);
  assert.equal(meDone2.status, 'finished');
});

test('account deletion cascades chained conversations without affecting another owner', async () => {
  const owner = await createOwner();
  const peer = await createOwner();
  const { runId: r1 } = await finishSyntheticRun(owner);
  const { runId: peerRun } = await finishSyntheticRun(peer);

  await as('authenticated', owner.userId);
  const t1 = await submitTurn(owner, r1, {
    message: '연쇄 삭제 검사용 제안', intent: 'change_period', start: '2026-10-20', end: '2026-10-24',
  });
  const r2 = (await decideTurn(owner, r1, t1.turns[0].id, 'approve')).turns[0].proposal.resultRunId;
  await as('service_role');
  await finishComparison(await claim({ runId: r2 }),
    runCompare(syntheticIngestion, { modelNo: '01' }, fixtureEvidence, { start: '2026-10-20', end: '2026-10-24' }),
    null, null);
  await as('authenticated', owner.userId);
  await submitTurn(owner, r2, { message: '두 번째 결과 질문', intent: 'price' });

  await as('authenticated', peer.userId);
  await submitTurn(peer, peerRun, { message: '다른 계정 질문', intent: 'help' });

  await db.exec('reset role');
  await db.query('delete from auth.users where id = $1', [owner.userId]);
  assert.equal((await one('select count(*)::int as n from private.analysis_chat_turns where user_id = $1', [owner.userId])).n, 0);
  assert.equal((await one('select count(*)::int as n from private.analysis_chat_turns where user_id = $1', [peer.userId])).n, 1);

  await as('authenticated', peer.userId);
  const peerConv = await readConversation(peer, peerRun);
  assert.equal(peerConv.turns.length, 1);
  assert.equal(peerConv.turns[0].message, '다른 계정 질문');
});

// 기본 합성 수집본에 주변 단지 4곳의 매매를 더해 교체 후보(6번째 적격 단지)가 남는 수집 스냅샷을 만든다(합성 자료).
function richCollectedCapture() {
  const python = `
import copy, json, sys
sys.path.insert(0, 'scripts')
from test_compare_trades import ComparisonTests, SALE
from replay_ingestion import replay

t = ComparisonTests()
t.setUp()
scope = {'LAWD_CD': '99999', 'DEAL_YMD': '202610'}
original = [item for page in t.bundle['pages'] if (page['source'], page['scope']) == (SALE, scope)
            for item in page['body']['response']['body']['items']['item']]
extra = [('near-1', '112.2', '37.5025'), ('near-2', '112.7', '37.5030'), ('near-3', '113.0', '37.5035'), ('near-4', '113.4', '37.5040')]
t.rows(SALE, original + [t.sale_row(name) for name, _, _ in extra])
for name, _, lat in extra:
    t.complex(name, latitude=lat)
ingestion = replay(t.bundle)
t.link_sales(ingestion, {(f'합성 {name}', '84.00'): (name, area) for name, area, _ in extra})
ingestion['dataOrigin'] = 'collected'
t.evidence['dataOrigin'] = 'collected'
print(json.dumps({'request': t.bundle['request'], 'ingestion': ingestion, 'evidence': t.evidence}, ensure_ascii=False))
`;
  return JSON.parse(execFileSync('python3', ['-c', python], { cwd: root, encoding: 'utf8' }));
}

test('condition changes validate input, keep one run per approval and bind worker results to approved area, kinds and replacements', async () => {
  const rich = richCollectedCapture();
  const owner = await createOwner();
  const stranger = await createOwner();
  await allowSources([...collectedCaptureSources, ...supplementalSources]);
  await as('service_role');
  const snapshotId = await rpc('save_ingestion_snapshot', owner.userId, owner.analysisId, randomUUID(),
    json(rich.request), json(rich.ingestion));
  await rpc('register_comparison_evidence', snapshotId, json(rich.evidence), evidenceSourceIds);
  await as('authenticated', owner.userId);
  const firstRun = await enqueue(owner, snapshotInput(snapshotId));
  await as('service_role');
  const baseComparison = runCompare(rich.ingestion, { modelNo: '01' }, rich.evidence);
  await finishComparison(await claim(firstRun), baseComparison, null, null);
  const r1 = firstRun.runId;
  assert.deepEqual(baseComparison.comparables.map(c => c.complexId),
    ['comparison-a', 'near-1', 'near-2', 'near-3', 'near-4']);
  const poolB = baseComparison.candidatePool.find(entry => entry.complexId === 'comparison-b');
  assert.equal(poolB.eligible, true);
  assert.equal(poolB.selected, false);

  await as('authenticated', owner.userId);
  const opened = await readConversation(owner, r1);
  assert.deepEqual(opened.conditionBounds, {
    editable: true,
    period: { start: '2026-10-10', end: '2026-10-31', asOf: '2026-11-10' },
    tradeKinds: ['sale', 'presale_right', 'occupancy_right'],
    areaToleranceMax: '5', areaEditable: false, replacementsEditable: true,
  });

  // 형식 오류·Q-52에서 폐지된 면적 범위(areaTolerancePercent)·현재 값과 같은 변경은 22023으로 거부하고 턴을 남기지 않는다.
  for (const conditions of [
    null, {}, [], { other: true }, { areaTolerancePercent: '3' }, { areaTolerancePercent: '5' },
    { areaTolerancePercent: '0' }, { areaTolerancePercent: '-1' }, { areaTolerancePercent: '7' }, { areaTolerancePercent: 3 },
    { tradeKinds: [] }, { tradeKinds: ['sale', 'sale'] },
    { tradeKinds: ['jeonse'] }, { tradeKinds: ['sale', 'presale_right', 'occupancy_right'] },
    { replacements: [] }, { replacements: [{ complexId: 'near-1', replaceComplexId: 'near-1' }] },
    { replacements: [{ complexId: 'comparison-b' }] },
    { replacements: [{ complexId: 'x', replaceComplexId: 'near-1' }, { complexId: 'near-1', replaceComplexId: 'near-2' }] },
    { replacements: [{ complexId: 'x', replaceComplexId: 'near-1' }, { complexId: 'x', replaceComplexId: 'near-2' }] },
    { period: { start: '2026-10-10', end: '2026-10-31' } }, { period: { start: '2026-10-25', end: '2026-10-20' } },
  ]) {
    await assert.rejects(submitConditions(owner, r1, { conditions }), { code: '22023' }, JSON.stringify(conditions));
  }
  await assert.rejects(submitConditions(owner, r1, { conditions: { period: { start: '2026-10-09', end: '2026-10-31' } } }),
    periodUnavailable);
  assert.equal((await readConversation(owner, r1)).turns.length, 0);

  // 다른 계정은 존재 여부를 알 수 없도록 404로 막는다.
  await as('authenticated', stranger.userId);
  await assert.rejects(submitConditions(owner, r1, { conditions: { tradeKinds: ['sale'] } }), runNotFound);
  await as('authenticated', owner.userId);

  // 제출은 대기 제안만 만들고 같은 요청 ID 재전송은 같은 결과, 다른 내용은 충돌이다.
  const kindsKey = randomUUID();
  const kindsSubmit1 = await submitConditions(owner, r1, {
    requestId: kindsKey, message: '입주권을 빼고 매매·분양권만 비교해줘', conditions: { tradeKinds: ['presale_right', 'sale'] },
  });
  const kindsTurn1 = kindsSubmit1.turns.at(-1);
  assert.equal(kindsTurn1.intent, 'change_conditions');
  assert.deepEqual(kindsTurn1.proposal, {
    kind: 'conditions',
    previous: { tradeKinds: ['sale', 'presale_right', 'occupancy_right'] },
    proposed: { tradeKinds: ['sale', 'presale_right'] },
    effective: { tradeKinds: ['sale', 'presale_right'] },
    status: 'pending', resultRunId: null,
  });
  assert.deepEqual(await submitConditions(owner, r1, {
    requestId: kindsKey, message: '입주권을 빼고 매매·분양권만 비교해줘', conditions: { tradeKinds: ['sale', 'presale_right'] },
  }), kindsSubmit1);
  await assert.rejects(submitConditions(owner, r1, {
    requestId: kindsKey, message: '입주권을 빼고 매매·분양권만 비교해줘', conditions: { tradeKinds: ['sale'] },
  }), requestConflict);

  // 거절·취소는 실행을 만들지 않고 이후 다른 결정은 충돌이다.
  const rejectSubmit = await submitConditions(owner, r1, { message: '매매만 비교해줘', conditions: { tradeKinds: ['sale'] } });
  const rejectTurnId = rejectSubmit.turns.at(-1).id;
  const rejected = await decideTurn(owner, r1, rejectTurnId, 'reject');
  assert.equal(rejected.turns.find(t => t.id === rejectTurnId).proposal.status, 'rejected');
  await assert.rejects(decideTurn(owner, r1, rejectTurnId, 'approve'), decisionConflict);
  const cancelSubmit = await submitConditions(owner, r1, { message: '분양권만', conditions: { tradeKinds: ['presale_right'] } });
  const cancelTurnId = cancelSubmit.turns.at(-1).id;
  assert.equal((await decideTurn(owner, r1, cancelTurnId, 'cancel')).turns.find(t => t.id === cancelTurnId).proposal.status,
    'cancelled');
  await as('authenticated', stranger.userId);
  await assert.rejects(decideTurn(owner, r1, kindsTurn1.id, 'approve'), runNotFound);
  await as('authenticated', owner.userId);
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from private.analysis_runs where analysis_id = $1', [owner.analysisId])).n, 1);

  // 같은 제안을 동시에 두 번 승인해도 새 실행은 하나이고 공유 프로필은 바뀌지 않는다.
  await as('authenticated', owner.userId);
  const [approved, replay] = await Promise.all([
    decideTurn(owner, r1, kindsTurn1.id, 'approve'), decideTurn(owner, r1, kindsTurn1.id, 'approve'),
  ]);
  assert.deepEqual(replay, approved);
  const r2 = approved.turns.find(t => t.id === kindsTurn1.id).proposal.resultRunId;
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from private.analysis_runs where analysis_id = $1', [owner.analysisId])).n, 2);
  assert.deepEqual(await one('select search_conditions, revision from public.user_profiles where user_id = $1', [owner.userId]),
    { search_conditions: { region_codes: ['11215'], budget_max_won: '900000000' }, revision: 3 });
  await as('authenticated', owner.userId);
  await assert.rejects(submitConditions(owner, r1, { conditions: { tradeKinds: ['sale'] } }), staleRun);

  // 작업자는 승인된 조건만 받고, 평형 기준·거래 종류·선정 이유·관측 평형이 어긋나면 저장하지 못한다.
  await as('service_role');
  const job2 = await claim({ runId: r2 });
  const work2 = await readWork(job2);
  assert.deepEqual(work2.comparisonConditions, { tradeKinds: ['sale', 'presale_right'] });
  assert.equal('comparisonPeriod' in work2, false);
  const prepared2 = runWorkerPrepare(job2.input, work2).comparison;
  assert.deepEqual(prepared2.conditions.area, { basis: 'exclusive_area_class', class: 84 });
  const forged = [
    baseComparison,
    { ...prepared2, conditions: { ...prepared2.conditions, area: { basis: 'exclusive_area_class', class: 59 } } },
    { ...prepared2, conditions: { ...prepared2.conditions, area: { basis: 'exclusive_area_class', class: 84, extra: 1 } } },
    { ...prepared2, conditions: { ...prepared2.conditions, tradeKinds: ['sale'] } },
    { ...prepared2, comparables: prepared2.comparables.map((c, i) => i === 4
      ? { ...c, selectionReason: 'manual_replacement', replacesComplexId: 'comparison-b' } : c) },
    { ...prepared2, comparables: prepared2.comparables.map((c, i) => i === 0
      ? { ...c, tradeStats: { ...c.tradeStats, sale: { ...c.tradeStats.sale, observations: c.tradeStats.sale.observations.map(o => ({ ...o, exclusiveAreaM2: '59.90' })) } } } : c) },
  ];
  for (const bad of forged) {
    await assert.rejects(finishComparison(job2, bad, null, null), invalidComparison);
  }
  await finishComparison(job2, prepared2, null, null);
  await as('authenticated', owner.userId);
  assert.equal((await readConversation(owner, r2)).previousRunId, r1);
  assert.deepEqual((await getComparison(owner, r1)).result, baseComparison);
  assert.equal((await readConversation(owner, r1)).conditionBounds.editable, false);

  // 단지 교체는 이전 승인 조건(거래 종류)을 유지한 채 적격 후보만 기존 단지 자리에 넣는다.
  const replaceSubmit = await submitConditions(owner, r2, {
    message: '합성 near-4를 합성 비교 B로 바꿔줘',
    conditions: { replacements: [{ complexId: 'comparison-b', replaceComplexId: 'near-4' }] },
  });
  const replaceTurn = replaceSubmit.turns.at(-1);
  assert.deepEqual(replaceTurn.proposal.effective, {
    tradeKinds: ['sale', 'presale_right'],
    replacements: [{ complexId: 'comparison-b', replaceComplexId: 'near-4' }],
  });
  assert.deepEqual(replaceTurn.proposal.previous, { replacements: [] });
  const r3 = (await decideTurn(owner, r2, replaceTurn.id, 'approve')).turns.at(-1).proposal.resultRunId;
  await as('service_role');
  const job3 = await claim({ runId: r3 });
  const work3 = await readWork(job3);
  const prepared3 = runWorkerPrepare(job3.input, work3).comparison;
  const manual = prepared3.comparables.find(c => c.selectionReason === 'manual_replacement');
  assert.deepEqual([manual.complexId, manual.replacesComplexId], ['comparison-b', 'near-4']);
  assert.equal(new Set(prepared3.comparables.map(c => c.complexId)).size, 5);
  // 승인된 교체를 반영하지 않거나 보류 사유도 남기지 않은 결과, 교체된 기존 단지가 동시에 남은 결과는 거부한다.
  await assert.rejects(finishComparison(job3, prepared2, null, null), invalidComparison);
  await assert.rejects(finishComparison(job3, {
    ...prepared3,
    comparables: [
      ...prepared3.comparables.filter(c => c.complexId !== 'near-3'),
      baseComparison.comparables.find(c => c.complexId === 'near-4'),
    ],
  }, null, null), invalidComparison);
  await finishComparison(job3, prepared3, null, null);

  // 매매만 비교하면 교체 후보(분양·입주권만 있는 단지)는 기준을 통과하지 못해 보류로 남고 비교표에 들어가지 않는다.
  await as('authenticated', owner.userId);
  const saleSubmit = await submitConditions(owner, r3, { message: '매매만 비교해줘', conditions: { tradeKinds: ['sale'] } });
  assert.deepEqual(saleSubmit.turns.at(-1).proposal.effective, {
    tradeKinds: ['sale'],
    replacements: [{ complexId: 'comparison-b', replaceComplexId: 'near-4' }],
  });
  const r4 = (await decideTurn(owner, r3, saleSubmit.turns.at(-1).id, 'approve')).turns.at(-1).proposal.resultRunId;
  await as('service_role');
  const job4 = await claim({ runId: r4 });
  const prepared4 = runWorkerPrepare(job4.input, await readWork(job4)).comparison;
  assert.deepEqual(prepared4.conditions.tradeKinds, ['sale']);
  assert.deepEqual([...new Set(prepared4.collections.map(c => c.source))], ['apt_trade']);
  assert.equal(prepared4.comparables.some(c => c.complexId === 'comparison-b'), false);
  assert.equal(prepared4.holds.find(h => h.reasonCode === 'replacement_candidate_ineligible')?.complexId, 'comparison-b');
  await assert.rejects(finishComparison(job4, { ...prepared4, holds: prepared4.holds.filter(h =>
    h.reasonCode !== 'replacement_candidate_ineligible') }, null, null), invalidComparison);
  await finishComparison(job4, prepared4, null, null);

  // 대화의 기간 변경(기존 7인자 경로)도 기준 결과에 실제 적용된 거래 종류를 이어받는다.
  await as('authenticated', owner.userId);
  const periodSubmit = await submitTurn(owner, r4, {
    message: '2026-10-15부터 2026-10-31까지로 바꿔줘', intent: 'change_period', start: '2026-10-15', end: '2026-10-31',
  });
  const r5 = (await decideTurn(owner, r4, periodSubmit.turns.at(-1).id, 'approve')).turns.at(-1).proposal.resultRunId;
  await as('service_role');
  const job5 = await claim({ runId: r5 });
  const work5 = await readWork(job5);
  assert.deepEqual(work5.comparisonPeriod, { start: '2026-10-15', end: '2026-10-31' });
  assert.deepEqual(work5.comparisonConditions, {
    tradeKinds: ['sale'], period: { start: '2026-10-15', end: '2026-10-31' },
  });
  const prepared5 = runWorkerPrepare(job5.input, work5).comparison;
  assert.deepEqual(prepared5.conditions.area, { basis: 'exclusive_area_class', class: 84 });
  await assert.rejects(finishComparison(job5, { ...prepared5, conditions: { ...prepared5.conditions,
    tradeKinds: ['sale', 'presale_right', 'occupancy_right'] } }, null, null), invalidComparison);
  await finishComparison(job5, prepared5, null, null);
});

test('condition edits stay unavailable without verified scope or evidence and other accounts see 404', async () => {
  const owner = await createOwner();
  const snapshot = await saveCollectedSnapshot(owner, { registerEvidence: false });
  const { runId } = await finishCollectedSnapshotRun(owner, snapshot, { withEvidence: false });
  await as('authenticated', owner.userId);
  const bounds = (await readConversation(owner, runId)).conditionBounds;
  assert.equal(bounds.replacementsEditable, false);
  await assert.rejects(submitConditions(owner, runId, {
    conditions: { replacements: [{ complexId: 'comparison-b', replaceComplexId: 'comparison-a' }] },
  }), conditionUnavailable);
  // 보류된 결과에서도 승인 없이는 어떤 실행도 만들어지지 않는다.
  const pending = await submitConditions(owner, runId, { conditions: { tradeKinds: ['sale'] } });
  assert.equal(pending.turns.at(-1).proposal.status, 'pending');
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from private.analysis_runs where analysis_id = $1', [owner.analysisId])).n, 1);
  const other = await createOwner();
  await as('authenticated', other.userId);
  await assert.rejects(readConversation(owner, runId), runNotFound);
  await assert.rejects(submitConditions(owner, runId, { conditions: { tradeKinds: ['sale'] } }), runNotFound);
});

test('resetting initial draft overrides persists across follow-up changes and turn deletion covers condition runs', async () => {
  const rich = richCollectedCapture();
  const owner = await createOwner({
    conditionsSnapshot: {
      comparison: {
        modelNo: '01',
        replacements: [{ complexId: 'comparison-b', replaceComplexId: 'near-4' }],
      },
    },
  });
  await allowSources([...collectedCaptureSources, ...supplementalSources]);
  await as('service_role');
  const snapshotId = await rpc('save_ingestion_snapshot', owner.userId, owner.analysisId, randomUUID(),
    json(rich.request), json(rich.ingestion));
  await rpc('register_comparison_evidence', snapshotId, json(rich.evidence), evidenceSourceIds);
  await as('authenticated', owner.userId);
  const run1 = await enqueue(owner, snapshotInput(snapshotId));
  await as('service_role');
  const job1 = await claim(run1);
  const comp1 = runWorkerPrepare(job1.input, await readWork(job1)).comparison;
  assert.deepEqual(comp1.conditions.area, { basis: 'exclusive_area_class', class: 84 });
  assert.equal(comp1.comparables.some(c => c.selectionReason === 'manual_replacement'), true);
  await finishComparison(job1, comp1, null, null);

  // 1) 초기 초안의 직접 교체를 자동 선정으로 되돌린다.
  await as('authenticated', owner.userId);
  const resetSubmit = await submitConditions(owner, run1.runId, {
    message: '자동 선정으로 되돌려줘',
    conditions: { replacements: [] },
  });
  const resetTurnId = resetSubmit.turns.at(-1).id;
  const r2 = (await decideTurn(owner, run1.runId, resetTurnId, 'approve')).turns.at(-1).proposal.resultRunId;
  await as('service_role');
  const job2 = await claim({ runId: r2 });
  const comp2 = runWorkerPrepare(job2.input, await readWork(job2)).comparison;
  assert.deepEqual(comp2.conditions.area, { basis: 'exclusive_area_class', class: 84 });
  assert.equal(comp2.comparables.some(c => c.selectionReason === 'manual_replacement'), false);
  await finishComparison(job2, comp2, null, null);

  // 2) 이어서 거래 종류만 바꿔도 초기 초안의 직접 교체가 되살아나지 않는다.
  await as('authenticated', owner.userId);
  const followSubmit = await submitConditions(owner, r2, {
    message: '매매만 비교해줘',
    conditions: { tradeKinds: ['sale'] },
  });
  assert.deepEqual(followSubmit.turns.at(-1).proposal.effective, {
    tradeKinds: ['sale'],
    replacements: [],
  });
  const r3 = (await decideTurn(owner, r2, followSubmit.turns.at(-1).id, 'approve')).turns.at(-1).proposal.resultRunId;
  await as('service_role');
  const job3 = await claim({ runId: r3 });
  const work3 = await readWork(job3);
  const comp3 = runWorkerPrepare(job3.input, work3).comparison;
  assert.deepEqual(comp3.conditions.area, { basis: 'exclusive_area_class', class: 84 });
  assert.deepEqual(comp3.conditions.tradeKinds, ['sale']);
  assert.equal(comp3.comparables.some(c => c.selectionReason === 'manual_replacement'), false);
  await finishComparison(job3, comp3, null, null);

  // 3) 기존 삭제 범위(turn)가 change_conditions 턴과 파생된 후속 실행(r2·r3)을 그대로 포함한다.
  await as('authenticated', owner.userId);
  const impact = await rpc('read_deletion_impact', 'turn', resetTurnId);
  assert.equal(impact.counts.runs, 2);
  assert.equal(impact.counts.turns, 2);
  const deleted = await rpc('delete_personal_data', 'turn', randomUUID(), resetTurnId);
  assert.equal(deleted.status, 'live_deleted');
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from private.analysis_runs where analysis_id = $1', [owner.analysisId])).n, 1);
  assert.equal((await one('select count(*)::int as n from private.analysis_chat_turns where analysis_id = $1', [owner.analysisId])).n, 0);
});

test('Q-52 keeps historical ±5% results and turns readable, blocks approving legacy pending area turns, and allows upgrading base runs', async () => {
  const owner = await createOwner();
  const { runId: legacyRunId, comparison: baseQ52 } = await finishSyntheticRun(owner);
  // 이전에 저장된 공급면적 ±5% 비교 결과와 과거 areaTolerancePercent 대기 턴을 DB에 재현한다(합성 자료).
  const legacyComparison = structuredClone(baseQ52);
  delete legacyComparison.target.exclusiveAreaM2;
  delete legacyComparison.target.areaClass;
  legacyComparison.conditions.area = { basis: 'supply', tolerancePercent: '5', minM2: '106.78', maxM2: '118.02' };
  for (const row of legacyComparison.comparables) {
    delete row.areaClass;
    delete row.supplyAreaReference;
    row.supplyAreaM2 = '112.50';
    row.areaDifferenceM2 = '0.10';
    row.selectionReason = 'area_difference_then_straight_line';
  }
  await db.exec('reset role');
  await db.query('update private.comparison_results set result = $2 where run_id = $1',
    [legacyRunId, json(legacyComparison)]);
  const legacyTurnId = randomUUID();
  await db.query(`
    insert into private.analysis_chat_turns (
      id, analysis_id, base_run_id, user_id, request_id, message, intent,
      proposal_status, previous_conditions, proposed_conditions, effective_conditions
    ) values (
      $1, $2, $3, $4, $5, '과거 공급면적 ±3% 제안', 'change_conditions',
      'pending', '{"areaTolerancePercent":"5"}'::jsonb, '{"areaTolerancePercent":"3"}'::jsonb, '{"areaTolerancePercent":"3"}'::jsonb
    )`, [legacyTurnId, owner.analysisId, legacyRunId, owner.userId, randomUUID()]);

  // 1) 과거 ±5% 결과와 과거 턴은 계속 정상 읽힌다.
  await as('authenticated', owner.userId);
  const readLegacy = await getComparison(owner, legacyRunId);
  assert.equal(readLegacy.result.conditions.area.basis, 'supply');
  const conv = await readConversation(owner, legacyRunId);
  assert.equal(conv.conditionBounds.areaEditable, false);
  assert.equal(conv.turns.length, 1);
  assert.deepEqual(conv.turns[0].proposal.proposed, { areaTolerancePercent: '3' });

  // 2) 과거 areaTolerancePercent 대기 턴의 승인은 PT409(condition_unavailable)로 차단하되 거절·취소는 허용한다.
  await assert.rejects(decideTurn(owner, legacyRunId, legacyTurnId, 'approve'), conditionUnavailable);
  const rejectedLegacy = await decideTurn(owner, legacyRunId, legacyTurnId, 'reject');
  assert.equal(rejectedLegacy.turns[0].proposal.status, 'rejected');

  // 3) 과거 ±5% 기준 실행 위에서 거래 종류 변경(매매만)을 승인하면 새 Q-52 평형 결과로 재계산·저장할 수 있다.
  const upgradeSubmit = await submitConditions(owner, legacyRunId, {
    message: '매매만 다시 비교해줘', conditions: { tradeKinds: ['sale'] },
  });
  const upgradeRunId = (await decideTurn(owner, legacyRunId, upgradeSubmit.turns.at(-1).id, 'approve'))
    .turns.at(-1).proposal.resultRunId;
  await as('service_role');
  const upgradeJob = await claim({ runId: upgradeRunId });
  const upgradeWork = await readWork(upgradeJob);
  assert.deepEqual(upgradeWork.comparisonConditions, { tradeKinds: ['sale'] });
  const upgradeComp = runWorkerPrepare(upgradeJob.input, upgradeWork).comparison;
  assert.deepEqual(upgradeComp.conditions.area, { basis: 'exclusive_area_class', class: 84 });
  const doneUpgrade = await finishComparison(upgradeJob, upgradeComp, null, null);
  assert.equal(doneUpgrade.status, 'finished');
});
