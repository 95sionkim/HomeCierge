// 합성 Auth·Storage·공고·비교·대화·프로필·보고서 자료와 PGlite로 D-06/A-56 개별 자료 삭제 RPC를 검증한다.
// 실제 인증·Storage API·외부 API는 호출하지 않으며 모든 계정·공고·거래·자금·파일 경로는 합성 자료다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBe03Db } from './helpers/be03-db.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRaw = JSON.parse(readFileSync(new URL('../fixtures/ingestion-v0.json', import.meta.url), 'utf8'));
const fixtureEvidence = JSON.parse(readFileSync(new URL('../fixtures/comparison-evidence-v1.json', import.meta.url), 'utf8'));
const syntheticInput = { kind: 'synthetic', fixture: 'ingestion-v0' };

const apt = 'applyhome_apt';
const remainder = 'applyhome_remainder';
const regionSource = 'mois_legal_region_codes';
const pdfSource = 'applyhome_notice_pdf';
const lawSource = 'law_eflaw';
const supplementalSources = [
  'synthetic-area-register',
  'synthetic-complex-register',
  'synthetic-coordinate-register',
  'synthetic-region-register',
];
const modelNo = '01';
const houseType = '084.0000A';
const firstRoom = '101동 101호';
const noticeDate = '2026-10-05';
const proof = { document: 'synthetic-notice-pdf', version: 'synthetic-v1', page: 7 };
const koreanDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });
const storedPdfMetadata = { mimetype: 'application/pdf', cacheControl: 'max-age=0' };

const authRequired = { code: '42501', message: 'authentication_required' };
const forbidden = { code: '42501' };
const invalidKind = { code: '22023', message: 'invalid_deletion_kind' };
const invalidScope = { code: '22023', message: 'invalid_deletion_scope' };
const invalidReceipt = { code: '22023', message: 'invalid_deletion_receipt' };
const cursorNotFound = { code: 'PT404', message: 'deletion_cursor_not_found' };
const targetNotFound = { code: 'PT404', message: 'deletion_target_not_found' };
const receiptNotFound = { code: 'PT404', message: 'deletion_receipt_not_found' };
const receiptConflict = { code: 'PT409', message: 'deletion_receipt_conflict' };
const uploadScopeUnverified = { code: 'PT409', message: 'deletion_upload_scope_unverified' };

const lawReference = {
  contractVersion: 'law-reference/v1',
  dataOrigin: 'collected',
  title: '주택공급에 관한 규칙',
  asOf: noticeDate,
  observedAt: '2026-11-12T11:12:13.123456789+09:00',
  mst: '90071992547409931234',
  lawId: '00090071992547409931',
  promulgatedOn: '2026-09-02',
  effectiveOn: '2026-09-05',
  articles: [
    { number: '2', branch: null, heading: '합성 조문 제목' },
  ],
};

let db;
let syntheticIngestion;
let collectedReplay;

const json = value => (value === null ? null : JSON.stringify(value));

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function as(role, userId = '', claims = { is_anonymous: false }, operation = '') {
  await db.exec('reset role');
  const jwt = { ...(userId ? { sub: userId } : {}), ...claims };
  await db.query(
    `select set_config('request.jwt.claim.sub', $1, false),
            set_config('request.jwt.claims', $2, false),
            set_config('storage.operation', $3, false)`,
    [userId, JSON.stringify(jwt), operation],
  );
  await db.exec(`set role ${role}`);
}

async function rpc(name, ...params) {
  const args = params.map((_, index) => `$${index + 1}`).join(', ');
  return (await one(`select public.${name}(${args}) as reply`, params)).reply;
}

const listItems = (kind, beforeId = undefined) => (
  beforeId === undefined
    ? rpc('list_deletion_items', kind)
    : rpc('list_deletion_items', kind, beforeId)
);

const readImpact = (scope, targetId = undefined) => (
  targetId === undefined
    ? rpc('read_deletion_impact', scope)
    : rpc('read_deletion_impact', scope, targetId)
);

const deleteData = (scope, receiptId, targetId = undefined) => (
  targetId === undefined
    ? rpc('delete_personal_data', scope, receiptId)
    : rpc('delete_personal_data', scope, receiptId, targetId)
);

function runCompare(ingestion, selection, evidence = fixtureEvidence, comparisonPeriod = null) {
  const python = `
import json, sys
sys.path.insert(0, 'scripts')
from compare_trades import compare_snapshot

ingestion, selection, evidence, period = json.load(sys.stdin)
print(json.dumps(compare_snapshot(ingestion, selection, evidence, comparison_period=period), ensure_ascii=False))
`;
  return JSON.parse(execFileSync('python3', ['-B', '-c', python], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify([ingestion, selection, evidence, comparisonPeriod]),
  }));
}

function buildCollectedReplay() {
  const replayPy = `
import json, sys
sys.path.insert(0, 'scripts')
from replay_ingestion import loads_source_json, replay

print(json.dumps(replay(loads_source_json(sys.stdin.read())), ensure_ascii=False))
`;
  const copy = structuredClone(fixtureRaw);
  for (const page of copy.pages) {
    if (page.source === apt) {
      page.body.data[0].RCRIT_PBLANC_DE = noticeDate;
      page.body.data[0].HOUSE_NM = '합성 가람 아파트';
    }
  }
  const result = JSON.parse(execFileSync('python3', ['-B', '-c', replayPy], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(copy),
  }));
  result.dataOrigin = 'collected';
  return { input: copy.request, result };
}

function fixtureSchedules() {
  return [
    {
      modelNo,
      houseType,
      room: firstRoom,
      item: 'sale_price',
      status: 'confirmed',
      totalWon: '700000000',
      reasons: [],
      evidence: [proof],
      installments: [
        {
          stage: 'deposit',
          won: '70000000',
          timing: { trigger: 'contract_signing', dateStatus: 'exact', date: '2026-10-23', evidence: [proof] },
        },
        {
          stage: 'balance',
          won: '630000000',
          timing: { trigger: 'deadline', dateStatus: 'exact', date: '2026-11-30', evidence: [proof] },
        },
      ],
    },
    {
      modelNo,
      houseType,
      room: firstRoom,
      item: 'required_options',
      status: 'confirmed',
      totalWon: '10000000',
      reasons: [],
      evidence: [{ ...proof, page: 8 }],
      installments: [
        {
          stage: 'balance',
          won: '10000000',
          timing: { trigger: 'move_in', dateStatus: 'relative', date: null, evidence: [] },
        },
      ],
    },
  ];
}

async function allowSources(sources) {
  await db.exec('reset role');
  await db.query(
    `insert into public.source_registry(
       id, display_name, storage_permission, reuse_permission, display_permission, export_permission, retention_days
     )
     select id, '합성 출처', 'allowed', 'allowed', 'allowed', 'allowed', null
     from unnest($1::text[]) as source(id)
     on conflict (id) do update set
       storage_permission = 'allowed',
       reuse_permission = 'allowed',
       display_permission = 'allowed',
       export_permission = 'allowed',
       retention_days = null`,
    [sources],
  );
}

async function publishNoticeDirectory(regionCodes = ['11215', '11200'], notices = []) {
  await allowSources([apt, remainder, `${apt}_model`, `${remainder}_model`, regionSource, 'apt_trade', 'apt_rights']);
  const observedAt = new Date().toISOString();
  const day = koreanDate.format(new Date(observedAt));
  const sorted = [...new Set(regionCodes)].sort();
  const names = Object.fromEntries(sorted.map(code => [code, `합성 지역 ${code}`]));
  const index = {
    contractVersion: 'notice-search-index/v1',
    dataOrigin: 'collected',
    observedAt,
    publicationWindow: { start: day, end: day },
    regionCodes: sorted,
    coverage: {
      status: 'complete',
      sources: [
        { source: apt, status: notices.some(n => n.sourceIds.includes(apt)) ? 'complete' : 'empty' },
        { source: remainder, status: notices.some(n => n.sourceIds.includes(remainder)) ? 'complete' : 'empty' },
      ],
    },
    notices,
  };
  await as('service_role');
  await rpc('publish_notice_directory', json(index), json(names));
  return day;
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

async function createChatAndAnalysis(userId, {
  chatTitle = '합성 대화',
  analysisTitle = '합성 분석',
  room = firstRoom,
  conditions,
  chatId = null,
} = {}) {
  await db.exec('reset role');
  let targetChatId = chatId;
  if (!targetChatId) {
    targetChatId = (await one(
      'insert into public.chats(user_id, title) values ($1, $2) returning id',
      [userId, chatTitle],
    )).id;
  }
  const snapshotConditions = conditions ?? {
    ingestion_target: { noticeSource: apt, ...collectedReplay.input.target },
    comparison: room ? { modelNo, room } : { modelNo },
  };
  const analysisId = (await one(
    `insert into public.analyses(user_id, chat_id, title, conditions_snapshot)
     values ($1, $2, $3, $4::jsonb) returning id`,
    [userId, targetChatId, analysisTitle, JSON.stringify(snapshotConditions)],
  )).id;
  return { chatId: targetChatId, analysisId };
}

async function addMessage(userId, chatId, content, role = 'user') {
  await db.exec('reset role');
  return (await one(
    'insert into public.chat_messages(user_id, chat_id, role, content) values ($1, $2, $3, $4) returning id',
    [userId, chatId, role, content],
  )).id;
}

async function addFund(userId, analysisId, {
  kind = 'current',
  amountWon = '300000000',
  availableOn = '2026-10-20',
  certainty = 'confirmed',
  note = '합성 자금 메모',
  requestKey = null,
} = {}) {
  await as('authenticated', userId);
  const row = await one(
    `insert into public.funding_entries(user_id, analysis_id, kind, amount_won, available_on, certainty, note, request_key)
     values ($1, $2, $3, $4::bigint, $5::date, $6, $7, $8)
     returning id, kind, amount_won::text as "amountWon", to_char(available_on, 'YYYY-MM-DD') as "availableOn", certainty`,
    [userId, analysisId, kind, amountWon, availableOn, certainty, note, requestKey],
  );
  return row;
}

async function finishCollectedRun(userId, analysisId, {
  room = firstRoom,
  withLaw = true,
  withSchedules = true,
} = {}) {
  await allowSources([apt, `${apt}_model`, pdfSource, lawSource, 'apt_trade', 'apt_rights', ...supplementalSources]);
  await as('service_role');
  if (withLaw) {
    await rpc('publish_law_reference', json(lawReference));
  }
  const snapshotId = withSchedules
    ? await rpc(
      'save_funding_schedule_snapshot',
      userId, analysisId, randomUUID(),
      json(collectedReplay.input), json(collectedReplay.result), json(fixtureSchedules()),
    )
    : await rpc(
      'save_ingestion_snapshot',
      userId, analysisId, randomUUID(),
      json(collectedReplay.input), json(collectedReplay.result),
    );
  const collectedEvidence = { ...fixtureEvidence, dataOrigin: 'collected' };
  const evSources = [apt, 'apt_trade', 'apt_rights', ...supplementalSources];
  await rpc('register_comparison_evidence', snapshotId, json(collectedEvidence), evSources);

  await as('authenticated', userId);
  const run = await rpc('enqueue_analysis_run', analysisId, randomUUID(), json({ kind: 'snapshot', snapshotId }));
  await as('service_role');
  const job = await rpc('claim_analysis_run', 300, run.runId);
  const work = await rpc('read_comparison_work', job.runId, job.generation, job.leaseToken);
  const selection = room ? { modelNo, room } : { modelNo };
  const comparison = runCompare(work.ingestion, selection, work.evidence);
  await rpc('finish_analysis_comparison', job.runId, job.generation, job.leaseToken, null, null, json(comparison));
  return { runId: job.runId, snapshotId };
}

async function finishSyntheticUploadBoundRun(userId, analysisId, documentId, {
  captureKey = randomUUID(),
  runIdempotencyKey = randomUUID(),
} = {}) {
  const customResult = structuredClone(syntheticIngestion);
  customResult.catalog.documents = [
    {
      ...customResult.catalog.documents[0],
      id: documentId,
      source: 'upload',
      originCheck: 'confirmed',
      status: 'accepted',
    },
  ];
  for (const model of customResult.catalog.housingTypes) {
    for (const ref of model.checkedSupplyArea.evidence) {
      if (ref.document !== null) ref.document = documentId;
    }
  }
  for (const room of customResult.catalog.rooms) {
    for (const ref of [...room.salePrice.evidence, ...room.requiredOptions.evidence]) {
      if (ref.document !== null) ref.document = documentId;
    }
    for (const docRef of room.subtotal.documents) {
      docRef.id = documentId;
    }
  }

  await as('service_role');
  const snapshotId = await rpc(
    'save_ingestion_snapshot',
    userId, analysisId, captureKey,
    json(fixtureRaw.request), json(customResult),
  );
  await as('authenticated', userId);
  const run = await rpc('enqueue_analysis_run', analysisId, runIdempotencyKey, json({ kind: 'snapshot', snapshotId }));
  await as('service_role');
  const job = await rpc('claim_analysis_run', 300, run.runId);
  const work = await rpc('read_comparison_work', job.runId, job.generation, job.leaseToken);
  const comparison = runCompare(work.ingestion, { modelNo }, work.evidence);
  await rpc('finish_analysis_comparison', job.runId, job.generation, job.leaseToken, null, null, json(comparison));
  return { snapshotId, runId: job.runId, captureKey, runIdempotencyKey };
}

async function approveAndFinishPeriodTurn(userId, analysisId, baseRunId, {
  requestId = randomUUID(),
  message = '2026-10-24부터 2026-10-26까지 다시 비교해줘',
  start = '2026-10-24',
  end = '2026-10-26',
  finish = true,
} = {}) {
  await as('authenticated', userId);
  const submitted = await rpc('submit_analysis_chat_turn', analysisId, baseRunId, requestId, message, 'change_period', start, end);
  const turn = submitted.turns.at(-1);
  const decided = await rpc('decide_analysis_chat_turn', analysisId, baseRunId, turn.id, 'approve');
  const approvedTurn = decided.turns.find(item => item.id === turn.id);
  const resultRunId = approvedTurn.proposal.resultRunId;
  if (finish) {
    await as('service_role');
    const job = await rpc('claim_analysis_run', 300, resultRunId);
    const work = await rpc('read_comparison_work', job.runId, job.generation, job.leaseToken);
    const comparison = runCompare(
      work.ingestion,
      work.conditions.comparison ?? { modelNo },
      work.evidence,
      work.comparisonPeriod,
    );
    await rpc('finish_analysis_comparison', job.runId, job.generation, job.leaseToken, null, null, json(comparison));
  }
  return { turnId: turn.id, requestId, resultRunId };
}

async function registerAndStoreUpload(userId, analysisId, uploadId = randomUUID(), { storeBytes = true } = {}) {
  await as('authenticated', userId, { is_anonymous: false }, 'storage.object.upload');
  const row = await one('select * from public.register_analysis_upload($1, $2)', [analysisId, uploadId]);
  if (storeBytes) {
    await db.query(
      'insert into storage.objects(bucket_id, name, owner_id, metadata) values ($1, $2, $3, $4)',
      ['analysis-uploads', row.object_path, userId, storedPdfMetadata],
    );
  }
  return row;
}

async function completeQueuedStorageDeletion(receiptId) {
  await as('service_role');
  const work = await rpc('deletion_work', receiptId);
  if (work && work.paths.length > 0) {
    await db.exec('reset role');
    await db.query(
      `delete from storage.objects where bucket_id = 'analysis-uploads' and name = any($1::text[])`,
      [work.paths],
    );
  }
  await as('service_role');
  const advanced = await rpc('advance_deletion_work', receiptId);
  return { work, advanced };
}

before(async () => {
  syntheticIngestion = JSON.parse(execFileSync('python3', [
    'scripts/replay_ingestion.py', 'tests/fixtures/ingestion-v0.json',
  ], { cwd: root, encoding: 'utf8' }));
  collectedReplay = buildCollectedReplay();
  db = await createBe03Db();
  await db.exec(`alter table auth.users add column confirmed_at timestamptz,
    add column is_anonymous boolean not null default false,
    add column banned_until timestamptz, add column deleted_at timestamptz`);
});

beforeEach(async () => {
  await db.exec('reset role');
  await db.exec(`truncate
    private.retired_deletion_keys,
    private.data_deletion_objects,
    private.account_deletion_fences,
    private.data_deletion_requests,
    private.saved_report_funding_refs,
    private.saved_analysis_reports,
    private.deleted_report_requests,
    private.analysis_report_versions,
    private.search_profile_proposals,
    private.analysis_chat_turns,
    private.comparison_results,
    private.comparison_evidence,
    private.analysis_funding_schedule_snapshots,
    private.analysis_runs,
    private.notice_directory_publication,
    private.notice_search_index,
    private.law_references,
    private.regional_news_attempts,
    private.commute_attempts,
    public.reports,
    public.funding_entries,
    public.analysis_uploads,
    public.analysis_input_snapshots,
    public.analyses,
    public.chat_messages,
    public.chats,
    public.profile_change_requests,
    public.user_profiles,
    public.housing_types,
    public.notice_documents,
    public.notices,
    public.source_registry,
    storage.objects,
    auth.users cascade`);
});

after(async () => {
  await db?.close();
});

test('private storage enables RLS with zero grants, public RPCs are narrow invokers with PostgREST-compatible signatures', async () => {
  await db.exec('reset role');
  const rls = await one(`select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relname = 'retired_deletion_keys'`);
  assert.equal(rls.relrowsecurity, true);

  for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(
        (await one('select has_table_privilege($1, $2, $3) as ok', [role, 'private.retired_deletion_keys', priv])).ok,
        false,
        `${role} ${priv}`,
      );
    }
  }

  // 공용 RPC는 security invoker + authenticated 전용, private 진입점은 security definer + authenticated 전용이다.
  const publicRpcs = [
    'public.list_deletion_items(text,uuid)',
    'public.read_deletion_impact(text,uuid)',
    'public.delete_personal_data(text,uuid,uuid)',
  ];
  for (const sig of publicRpcs) {
    const def = await one('select prosecdef, prorettype::regtype::text as ret, proargnames from pg_proc where oid = $1::regprocedure', [sig]);
    assert.equal(def.prosecdef, false, `${sig} must be security invoker`);
    assert.equal(def.ret, 'jsonb', sig);
    assert.equal((await one("select has_function_privilege('authenticated', $1, 'EXECUTE') as ok", [sig])).ok, true, sig);
    for (const role of ['public', 'anon', 'service_role']) {
      assert.equal((await one('select has_function_privilege($1, $2, $3) as ok', [role, sig, 'EXECUTE'])).ok, false, `${role} ${sig}`);
    }
  }

  // delete_personal_data는 Supabase 생성 타입·PostgREST 호환을 위해 (p_scope, p_receipt, p_target default null) 순서다.
  const delSig = await one(
    `select proargnames, pronargdefaults from pg_proc where oid = 'public.delete_personal_data(text,uuid,uuid)'::regprocedure`,
  );
  assert.deepEqual(delSig.proargnames, ['p_scope', 'p_receipt', 'p_target']);
  assert.equal(delSig.pronargdefaults, 1);

  const privateRpcs = [
    'private.list_deletion_items(text,uuid)',
    'private.read_deletion_impact(text,uuid)',
    'private.delete_personal_data(text,uuid,uuid)',
  ];
  for (const sig of privateRpcs) {
    const def = await one('select prosecdef from pg_proc where oid = $1::regprocedure', [sig]);
    assert.equal(def.prosecdef, true, `${sig} must be security definer`);
    assert.equal((await one("select has_function_privilege('authenticated', $1, 'EXECUTE') as ok", [sig])).ok, true, sig);
    for (const role of ['public', 'anon', 'service_role']) {
      assert.equal((await one('select has_function_privilege($1, $2, $3) as ok', [role, sig, 'EXECUTE'])).ok, false, `${role} ${sig}`);
    }
  }

  const internalHelpers = [
    'private.guard_retired_workspace_key()',
    'private.guard_retired_analysis_run_key()',
    'private.guard_retired_chat_turn_key()',
    'private.guard_retired_funding_entry_key()',
    'private.guard_retired_profile_proposal_key()',
    'private.guard_retired_upload_key()',
    'private.guard_retired_snapshot_key()',
    'private.purge_retired_keys_on_account_fence()',
    'private.deletion_text_preview(text,text,integer)',
    'private.jsonb_mentions_uuid(jsonb,uuid)',
    'private.legacy_report_references_any_uuid(public.reports,uuid[])',
    'private.upload_doc_id_matches(text,uuid,uuid,uuid)',
    'private.resync_analysis_latest_run(uuid,uuid)',
    'private.bump_analysis_report_version(uuid,integer)',
    'private.resolve_turn_deletion_scope(uuid,uuid)',
    'private.resolve_fund_deletion_scope(uuid,uuid)',
    'private.resolve_upload_deletion_scope(uuid,uuid)',
  ];
  for (const sig of internalHelpers) {
    for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
      assert.equal((await one('select has_function_privilege($1, $2, $3) as ok', [role, sig, 'EXECUTE'])).ok, false, `${role} ${sig}`);
    }
  }
});

test('enforces verified-owner auth, invalid scope/target/receipt combos, cross-owner PT404, zero-side-effect preview, and receipt conflicts', async () => {
  const userA = await createUser();
  const userB = await createUser();
  const unverified = await createUser({ verified: false });
  const anonAccount = await createUser({ anonymous: true });
  const banned = await createUser({ bannedUntil: new Date(Date.now() + 60_000).toISOString() });
  const deleted = await createUser({ deletedAt: new Date().toISOString() });

  const { chatId: chatA, analysisId: analysisA } = await createChatAndAnalysis(userA);
  const { chatId: chatB } = await createChatAndAnalysis(userB);
  const msgA = await addMessage(userA, chatA, '사용자 A 메시지');
  const msgB = await addMessage(userB, chatB, '사용자 B 메시지');

  // anon / service_role 호출 거부(42501)
  for (const role of ['anon', 'service_role']) {
    await as(role);
    await assert.rejects(listItems('chat'), forbidden, `${role} list`);
    await assert.rejects(readImpact('profile'), forbidden, `${role} impact`);
    await assert.rejects(deleteData('profile', randomUUID()), forbidden, `${role} delete`);
  }

  // 미인증·익명 JWT·미확인·익명계정·정지·삭제 계정은 모두 42501
  const blockedCallers = [
    ['missing sub', '', { is_anonymous: false }],
    ['anonymous jwt claim', userA, { is_anonymous: true }],
    ['unverified account', unverified, { is_anonymous: false }],
    ['anonymous account', anonAccount, { is_anonymous: false }],
    ['banned account', banned, { is_anonymous: false }],
    ['deleted account', deleted, { is_anonymous: false }],
  ];
  for (const [label, uid, claims] of blockedCallers) {
    await as('authenticated', uid, claims);
    await assert.rejects(listItems('chat'), authRequired, `${label} list`);
    await assert.rejects(readImpact('account'), authRequired, `${label} impact`);
    await assert.rejects(deleteData('profile', randomUUID()), authRequired, `${label} delete`);
  }

  // 유효하지 않은 조합은 22023
  await as('authenticated', userA);
  for (const badKind of [null, '', 'profile', 'account', 'unknown']) {
    await assert.rejects(listItems(badKind), invalidKind, `list ${badKind}`);
  }
  for (const [scope, target] of [
    [null, null],
    ['unknown', null],
    ['chat', null],
    ['analysis', null],
    ['message', null],
    ['turn', null],
    ['fund', null],
    ['upload', null],
    ['report', null],
    ['profile', chatA],
    ['account', chatA],
  ]) {
    await assert.rejects(readImpact(scope, target), invalidScope, `impact ${scope}/${target}`);
  }

  // delete_personal_data: account는 22023(전용 계정 삭제 RPC 사용), 비-v4 영수증·누락 영수증은 22023
  await assert.rejects(deleteData('account', randomUUID(), null), invalidScope);
  await assert.rejects(deleteData('profile', null, null), invalidReceipt);
  await assert.rejects(deleteData('profile', '11111111-1111-1111-1111-111111111111', null), invalidReceipt);
  await assert.rejects(deleteData('profile', randomUUID(), chatA), invalidScope);
  await assert.rejects(deleteData('chat', randomUUID(), null), invalidScope);

  // 미리보기는 부작용이 없다(프로필 행 미생성, 영수증 미생성, 행 건수 불변).
  const profilePreview = await readImpact('profile');
  assert.deepEqual(profilePreview, {
    scope: 'profile',
    targetId: null,
    counts: { chats: 0, messages: 0, analyses: 0, runs: 0, turns: 0, funds: 0, reports: 0, uploads: 0, profileChanges: 0 },
    profileCleared: false,
    reportsDeleted: 0,
    reportsUpdated: 0,
    storageObjects: 0,
  });
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from public.user_profiles where user_id = $1', [userA])).n, 0);
  assert.equal((await one('select count(*)::int as n from private.data_deletion_requests')).n, 0);

  // 타인 소유·존재하지 않는 대상은 PT404이며 실패한 영수증은 소모되지 않는다.
  await as('authenticated', userA);
  await assert.rejects(readImpact('chat', chatB), targetNotFound);
  await assert.rejects(readImpact('message', msgB), targetNotFound);
  await assert.rejects(readImpact('analysis', randomUUID()), targetNotFound);

  const reusableReceipt = randomUUID();
  await assert.rejects(deleteData('message', reusableReceipt, msgB), targetNotFound);
  await assert.rejects(rpc('read_deletion_receipt', reusableReceipt), receiptNotFound);

  // 실패했던 영수증으로 본인 메시지 삭제는 정상 성공하고, 동일 재전송은 PT404 대신 기존 영수증을 반환한다.
  const deletedMsgReceipt = await deleteData('message', reusableReceipt, msgA);
  assert.equal(deletedMsgReceipt.receiptId, reusableReceipt);
  assert.equal(deletedMsgReceipt.scope, 'message');
  assert.equal(deletedMsgReceipt.status, 'live_deleted');
  assert.ok(deletedMsgReceipt.requestedAt);
  assert.ok(deletedMsgReceipt.completedAt);
  assert.deepEqual(deletedMsgReceipt.backup, { status: 'unverified' });

  // 대상이 사라진 뒤에도 동일 영수증·동일 범위·동일 대상 재시도는 멱등 수렴한다.
  assert.deepEqual(await deleteData('message', reusableReceipt, msgA), deletedMsgReceipt);

  // 동일 영수증을 다른 대상·다른 범위·다른 소유자가 재사용하면 PT409다.
  await assert.rejects(deleteData('message', reusableReceipt, randomUUID()), receiptConflict);
  await assert.rejects(deleteData('chat', reusableReceipt, chatA), receiptConflict);
  await assert.rejects(deleteData('profile', reusableReceipt), receiptConflict);

  await as('authenticated', userB);
  await assert.rejects(deleteData('message', reusableReceipt, msgB), receiptConflict);
  await assert.rejects(deleteData('message', reusableReceipt, msgA), receiptConflict);

  // 사용자 B의 메시지와 사용자 A의 대화·분석은 모두 보존된다.
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from public.chat_messages where id = $1', [msgB])).n, 1);
  assert.equal((await one('select count(*)::int as n from public.chats where id = $1', [chatA])).n, 1);
  assert.equal((await one('select count(*)::int as n from public.analyses where id = $1', [analysisA])).n, 1);
});

test('list_deletion_items paginates stably with equal timestamps, isolates owners, maps legacy/unknown rows, and masks restricted report titles', async () => {
  const userA = await createUser();
  const userB = await createUser();
  const { chatId: chatA, analysisId: analysisA } = await createChatAndAnalysis(userA, {
    chatTitle: '대표 대화',
    analysisTitle: '대표 분석',
  });
  const { chatId: chatB, analysisId: analysisB } = await createChatAndAnalysis(userB, {
    chatTitle: '타인 대화',
    analysisTitle: '타인 분석',
  });

  // 동일 created_at 시각으로 메시지 35건(user/assistant/system 포함)을 생성해 안정 UUID 커서 페이지네이션을 검증한다.
  await db.exec('reset role');
  const sameTs = '2026-11-24T01:00:00Z';
  const expectedMsgIds = [];
  for (let i = 0; i < 35; i += 1) {
    const role = i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'system';
    const row = await one(
      `insert into public.chat_messages(user_id, chat_id, role, content, created_at)
       values ($1, $2, $3, $4, $5::timestamptz) returning id`,
      [userA, chatA, role, `합성 메시지 #${String(i).padStart(2, '0')}`, sameTs],
    );
    expectedMsgIds.push(row.id);
  }
  const msgB = await addMessage(userB, chatB, '타인 메시지');
  expectedMsgIds.sort((a, b) => (a < b ? 1 : -1)); // created_at desc, id desc

  await as('authenticated', userA);
  const page1 = await listItems('message');
  assert.equal(page1.items.length, 30);
  assert.equal(page1.nextCursor, page1.items[29].id);
  assert.deepEqual(page1.items.map(item => item.id), expectedMsgIds.slice(0, 30));
  assert.ok(page1.items.some(item => item.detail.startsWith('안내 ·')));
  assert.ok(page1.items.some(item => item.detail.startsWith('시스템 ·')));

  const page2 = await listItems('message', page1.nextCursor);
  assert.equal(page2.items.length, 5);
  assert.equal(page2.nextCursor, null);
  assert.deepEqual(page2.items.map(item => item.id), expectedMsgIds.slice(30));

  // 타인 ID나 다른 종류 ID를 커서로 넣으면 PT404다.
  await assert.rejects(listItems('message', msgB), cursorNotFound);
  await assert.rejects(listItems('message', chatA), cursorNotFound);

  // 보고서 목록은 관리 보고서와 레거시 보고서를 함께 나열하고, 출처 표시 권한 회수 시 공고명을 가린다.
  await db.exec('reset role');
  const legacyReport = await one(
    `insert into public.reports(
       user_id, analysis_id, snapshot_version, result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot, queried_at
     ) values ($1, $2, 1, '{"legacy":true}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, now()) returning id`,
    [userA, analysisA],
  );
  const baseRun = await finishCollectedRun(userA, analysisA);
  await as('authenticated', userA);
  const managedReport = await rpc('save_analysis_report', analysisA, baseRun.runId, randomUUID());
  await db.exec('reset role');
  await db.query(
    `insert into public.reports(
       user_id, analysis_id, snapshot_version, result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot, queried_at
     ) values ($1, $2, 1, '{"legacy":true}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, now())`,
    [userB, analysisB],
  );

  await as('authenticated', userA);
  const reportsVisible = await listItems('report');
  assert.equal(reportsVisible.items.length, 2);
  const visibleManaged = reportsVisible.items.find(item => item.id === managedReport.reportId);
  const visibleLegacy = reportsVisible.items.find(item => item.id === legacyReport.id);
  assert.ok(visibleManaged.label.includes('합성 가람 아파트'));
  assert.ok(visibleLegacy.label.includes('이전 보고서 v1'));

  // 출처 표시 권한을 철회하면 목록에서도 제3자 공고명이 가려지고, 턴 목록은 본인 입력으로 계속 조회된다.
  await as('authenticated', userA);
  const conv = await rpc('submit_analysis_chat_turn', analysisA, baseRun.runId, randomUUID(), '비교 보류 이유 알려줘', 'holds');
  const turnId = conv.turns[0].id;

  await db.exec('reset role');
  await db.query(`update public.source_registry set display_permission = 'denied' where id = $1`, [apt]);

  await as('authenticated', userA);
  const reportsRestricted = await listItems('report');
  const maskedManaged = reportsRestricted.items.find(item => item.id === managedReport.reportId);
  assert.equal(maskedManaged.label.includes('합성 가람 아파트'), false);
  assert.ok(maskedManaged.label.includes('대표 분석'));

  const turns = await listItems('turn');
  assert.deepEqual(turns.items.map(item => item.id), [turnId]);
  assert.equal(turns.items[0].label, '비교 보류 이유 알려줘');

  // 업로드 목록은 registered/deletion_requested를 포함하고 deleted tombstone은 제외한다.
  const uploadActive = await registerAndStoreUpload(userA, analysisA, randomUUID(), { storeBytes: false });
  const uploadPending = await registerAndStoreUpload(userA, analysisA, randomUUID(), { storeBytes: false });
  const uploadFinalized = await registerAndStoreUpload(userA, analysisA, randomUUID(), { storeBytes: false });
  await as('authenticated', userA);
  await rpc('request_analysis_upload_deletion', analysisA, uploadPending.id);
  await rpc('request_analysis_upload_deletion', analysisA, uploadFinalized.id);
  await rpc('finalize_analysis_upload_deletion', analysisA, uploadFinalized.id);

  const uploads = await listItems('upload');
  assert.equal(uploads.items.length, 2);
  assert.deepEqual(new Set(uploads.items.map(item => item.id)), new Set([uploadActive.id, uploadPending.id]));
  assert.equal(uploads.items.find(item => item.id === uploadPending.id).detail, '삭제 대기 중');
  await assert.rejects(listItems('upload', uploadFinalized.id), cursorNotFound);

  // chat, analysis, fund 목록과 소유자 격리·빈 목록 응답도 모두 확인한다.
  const fundA = await addFund(userA, analysisA, { kind: 'current', amountWon: '120000000', availableOn: '2026-10-15', certainty: 'confirmed' });
  const chatsA = await listItems('chat');
  assert.deepEqual(chatsA.items.map(item => item.id), [chatA]);
  assert.equal(chatsA.nextCursor, null);
  assert.equal(chatsA.items[0].label, '대표 대화');
  const analysesA = await listItems('analysis');
  assert.deepEqual(analysesA.items.map(item => item.id), [analysisA]);
  assert.equal(analysesA.items[0].label, '대표 분석');
  const fundsA = await listItems('fund');
  assert.deepEqual(fundsA.items.map(item => item.id), [fundA.id]);
  assert.ok(fundsA.items[0].label.includes('120000000원'));

  const emptyOwner = await createUser();
  await as('authenticated', emptyOwner);
  for (const kind of ['chat', 'analysis', 'message', 'turn', 'fund', 'upload', 'report']) {
    assert.deepEqual(await listItems(kind), { items: [], nextCursor: null }, `empty ${kind}`);
  }
});

test('analysis and chat deletions stage only relevant uploads, clean attributable profile proposals, block workspace restoration, and preserve unrelated/official data', async () => {
  const userA = await createUser();
  const userB = await createUser();

  const day = await publishNoticeDirectory(['11215'], [
    {
      houseManageNo: '2026000001',
      noticeNo: '2026000001',
      edition: dayNow(),
      title: '합성 공고',
      kind: 'new_sale',
      regionCode: '11215',
      parentRegionCode: null,
      application: { start: dayNow(), end: dayNow() },
      moveIn: null,
      inventoryComplete: false,
      models: [{ modelNo: '01', houseType: '084A', supplyAreaM2: null, areaEvidence: [], rooms: [] }],
      sourceIds: [apt, `${apt}_model`],
      reasonCodes: [],
    },
  ]);

  // 공유 공식 카탈로그 행을 준비해 삭제 후에도 보존되는지 검증한다.
  await db.exec('reset role');
  const officialNoticeId = (await one(
    `insert into public.notices(source_id, external_id, title, notice_kind, region_code, collected_at)
     values ($1, 'official-ext-1', '공식 보존 공고', 'new_sale', '11215', now()) returning id`,
    [apt],
  )).id;

  // 사용자 A: start_notice_workspace로 만든 대화1/분석1 + 별도 대화2/분석2 + 사용자 B 데이터
  const workspaceKey = randomUUID();
  const noticeInput = {
    kind: 'notice',
    noticeSource: apt,
    houseManageNo: '2026000001',
    noticeNo: '2026000001',
    edition: day,
    modelNo: '01',
  };
  await as('authenticated', userA);
  const wsRun = await rpc('start_notice_workspace', workspaceKey, json(noticeInput));
  const analysisWs = wsRun.analysisId;
  await db.exec('reset role');
  const chatWs = (await one('select chat_id from public.analyses where id = $1', [analysisWs])).chat_id;
  await addMessage(userA, chatWs, '워크스페이스 대화 메시지');

  // 같은 대화에 두 번째 분석(수집 완료 + 보고서 + 자금 + 업로드 + 출처 연결 프로필 변경안)을 생성한다.
  const { analysisId: analysisDetail } = await createChatAndAnalysis(userA, {
    chatId: chatWs,
    analysisTitle: '상세 분석',
  });
  await addFund(userA, analysisDetail, { kind: 'current', amountWon: '250000000', requestKey: randomUUID() });
  const runDetail = await finishCollectedRun(userA, analysisDetail);
  await as('authenticated', userA);
  await rpc('submit_analysis_chat_turn', analysisDetail, runDetail.runId, randomUUID(), '가격 구성 알려줘', 'price');
  await rpc('save_analysis_report', analysisDetail, runDetail.runId, randomUUID());
  const uploadDetail = await registerAndStoreUpload(userA, analysisDetail);

  // 프로필 변경안: (1) analysisDetail에서 승인된 변경안(확인된 공유 프로필 유지 + 사유 삭제 대상),
  // (2) analysisDetail에서 대기 중인 변경안(자동 복원 방지를 위해 제거 대상),
  // (3) 프로필 화면에서 직접 만든 독립 대기 변경안(보존 대상).
  await as('authenticated', userA);
  const reqApprovedFromAnalysis = randomUUID();
  await rpc('propose_search_profile_change', reqApprovedFromAnalysis, 0, json({ budget_max_won: '800000000' }), '분석1에서 예산 승인', analysisDetail, runDetail.runId);
  await rpc('decide_search_profile_change', reqApprovedFromAnalysis, 'approve');
  const reqPendingFromAnalysis = randomUUID();
  await rpc('propose_search_profile_change', reqPendingFromAnalysis, 1, json({ budget_max_won: '950000000' }), '분석1에서 미승인 초안', analysisDetail, runDetail.runId);
  const reqIndependent = randomUUID();
  await rpc('propose_search_profile_change', reqIndependent, 1, json({ region_codes: ['11215'] }), '독립 프로필 제안', null, null);

  // 독립 대화2/분석2 (업로드 포함) + 사용자 B 대화/분석 (업로드 포함)
  const { chatId: chatKeep, analysisId: analysisKeep } = await createChatAndAnalysis(userA, { chatTitle: '보존 대화', analysisTitle: '보존 분석' });
  await addMessage(userA, chatKeep, '보존 메시지');
  const uploadKeep = await registerAndStoreUpload(userA, analysisKeep);
  const { chatId: chatB, analysisId: analysisB } = await createChatAndAnalysis(userB, { chatTitle: 'B 대화', analysisTitle: 'B 분석' });
  const uploadB = await registerAndStoreUpload(userB, analysisB);

  // 1) analysisDetail 영향 미리보기 검증
  await as('authenticated', userA);
  const analysisImpact = await readImpact('analysis', analysisDetail);
  assert.deepEqual(analysisImpact, {
    scope: 'analysis',
    targetId: analysisDetail,
    counts: {
      chats: 0,
      messages: 0,
      analyses: 1,
      runs: 1,
      turns: 1,
      funds: 1,
      reports: 1,
      uploads: 1,
      profileChanges: 2,
    },
    profileCleared: false,
    reportsDeleted: 1,
    reportsUpdated: 0,
    storageObjects: 1,
  });

  // analysisDetail 삭제: 업로드가 있으므로 processing을 반환하고 부모 대화·워크스페이스 분석은 보존한다.
  const receiptAnalysis = randomUUID();
  const resAnalysis = await deleteData('analysis', receiptAnalysis, analysisDetail);
  assert.equal(resAnalysis.status, 'processing');
  assert.equal(resAnalysis.completedAt, null);
  assert.deepEqual(await deleteData('analysis', receiptAnalysis, analysisDetail), resAnalysis);

  // DB에서 storage.objects를 직접 삭제하지 않았으며, 작업자 큐에 analysisDetail 업로드 경로만 올라간다.
  await db.exec('reset role');
  assert.equal((await one(`select count(*)::int as n from storage.objects where name = $1`, [uploadDetail.object_path])).n, 1);
  assert.equal((await one(`select count(*)::int as n from public.chats where id = $1`, [chatWs])).n, 1);
  assert.equal((await one(`select count(*)::int as n from public.chat_messages where chat_id = $1`, [chatWs])).n, 1);
  assert.equal((await one(`select count(*)::int as n from public.analyses where id = $1`, [analysisWs])).n, 1);

  // 귀속 프로필 변경안 2건(승인 사유·미승인 초안)은 삭제됐고, 확인된 공유 프로필 값과 독립 제안은 보존된다.
  await as('authenticated', userA);
  const profileAfterAnalysis = await rpc('read_search_profile');
  assert.equal(profileAfterAnalysis.conditions.budget_max_won, '800000000');
  assert.deepEqual(profileAfterAnalysis.proposals.map(p => p.id), [reqIndependent]);
  await assert.rejects(rpc('decide_search_profile_change', reqPendingFromAnalysis, 'approve'), { code: 'PT404' });

  // 대기열 작업 완료 처리 후 live_deleted로 전이되며, 다른 분석·타인 업로드 객체는 그대로 남아 있다.
  const { work: analysisWork, advanced: analysisDone } = await completeQueuedStorageDeletion(receiptAnalysis);
  assert.deepEqual(analysisWork.paths, [uploadDetail.object_path]);
  assert.equal(analysisDone.status, 'live_deleted');
  assert.ok(analysisDone.completedAt);
  await as('authenticated', userA);
  assert.deepEqual(await deleteData('analysis', receiptAnalysis, analysisDetail), analysisDone);

  // 2) chatWs 전체 삭제: 남은 메시지 + analysisWs(워크스페이스 키 은퇴)까지 함께 삭제된다.
  const chatImpact = await readImpact('chat', chatWs);
  assert.deepEqual(chatImpact.counts, {
    chats: 1,
    messages: 1,
    analyses: 1,
    runs: 1,
    turns: 0,
    funds: 0,
    reports: 0,
    uploads: 0,
    profileChanges: 0,
  });
  const receiptChat = randomUUID();
  const resChat = await deleteData('chat', receiptChat, chatWs);
  assert.equal(resChat.status, 'live_deleted');
  assert.deepEqual(await deleteData('chat', receiptChat, chatWs), resChat);

  // 지연된 start_notice_workspace 재시도는 PT409로 거부되고 고아 대화·분석을 복원하지 않는다.
  await assert.rejects(rpc('start_notice_workspace', workspaceKey, json(noticeInput)), {
    code: 'PT409',
    message: 'workspace_request_retired',
  });

  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from public.chats where user_id = $1', [userA])).n, 1);
  assert.equal((await one('select count(*)::int as n from public.chats where id = $1', [chatKeep])).n, 1);
  assert.equal((await one('select count(*)::int as n from storage.objects where name = $1', [uploadKeep.object_path])).n, 1);
  assert.equal((await one('select count(*)::int as n from public.chats where id = $1', [chatB])).n, 1);
  assert.equal((await one('select count(*)::int as n from storage.objects where name = $1', [uploadB.object_path])).n, 1);
  assert.equal((await one('select count(*)::int as n from public.notices where id = $1', [officialNoticeId])).n, 1);
  assert.equal((await one('select count(*)::int as n from private.law_references')).n, 1);
  assert.equal((await one('select count(*)::int as n from private.notice_directory_publication')).n, 1);
});

test('turn deletion removes recursive approved-period descendant runs, turns, reports, and attributable profile proposals while resyncing latest_run_id', async () => {
  const userA = await createUser();
  const { analysisId } = await createChatAndAnalysis(userA);
  await addFund(userA, analysisId, { kind: 'current', amountWon: '300000000' });

  // 승인 이전 레거시 보고서 1건(보존 대상)
  await db.exec('reset role');
  const legacyBefore = (await one(
    `insert into public.reports(
       user_id, analysis_id, snapshot_version, result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot, queried_at
     ) values ($1, $2, 1, '{"legacy":"before"}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, now() - interval '1 hour')
     returning id`,
    [userA, analysisId],
  )).id;

  const baseRun = await finishCollectedRun(userA, analysisId);
  await as('authenticated', userA);
  const reportOnBase = await rpc('save_analysis_report', analysisId, baseRun.runId, randomUUID());
  const basePropReq = randomUUID();
  await rpc('propose_search_profile_change', basePropReq, 0, json({ budget_max_won: '750000000' }), '기준 실행 제안', analysisId, baseRun.runId);

  const siblingTurnReq = randomUUID();
  const siblingConv = await rpc('submit_analysis_chat_turn', analysisId, baseRun.runId, siblingTurnReq, '보류 항목 설명해줘', 'holds');
  const siblingTurnId = siblingConv.turns[0].id;

  // 연쇄 기간 변경: baseRun -> T1 -> run2 -> T2(질문) + T3 -> run3 -> T4(질문)
  const turn1 = await approveAndFinishPeriodTurn(userA, analysisId, baseRun.runId, {
    start: '2026-10-20',
    end: '2026-10-30',
  });
  await as('authenticated', userA);
  const reportOnRun2Req = randomUUID();
  const reportOnRun2 = await rpc('save_analysis_report', analysisId, turn1.resultRunId, reportOnRun2Req);
  const propOnRun2Req = randomUUID();
  await rpc('propose_search_profile_change', propOnRun2Req, 0, json({ budget_max_won: '820000000' }), 'run2 제안', analysisId, turn1.resultRunId);
  await rpc('submit_analysis_chat_turn', analysisId, turn1.resultRunId, randomUUID(), 'run2 질문', 'price');

  const turn3 = await approveAndFinishPeriodTurn(userA, analysisId, turn1.resultRunId, {
    start: '2026-10-24',
    end: '2026-10-26',
  });
  await as('authenticated', userA);
  const reportOnRun3Req = randomUUID();
  const reportOnRun3 = await rpc('save_analysis_report', analysisId, turn3.resultRunId, reportOnRun3Req);
  const propOnRun3Req = randomUUID();
  await rpc('propose_search_profile_change', propOnRun3Req, 0, json({ budget_max_won: '880000000' }), 'run3 제안', analysisId, turn3.resultRunId);
  await rpc('submit_analysis_chat_turn', analysisId, turn3.resultRunId, randomUUID(), 'run3 질문', 'scope');

  // 승인 이후 생성된 출처 불명 레거시 보고서 1건(영향 포함·삭제 대상)
  await db.exec('reset role');
  const legacyAfter = (await one(
    `insert into public.reports(
       user_id, analysis_id, snapshot_version, result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot, queried_at
     ) values ($1, $2, 99, '{"legacy":"after"}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, now())
     returning id`,
    [userA, analysisId],
  )).id;

  // 1) 일반 질문 턴 삭제는 그 턴만 지우고 다른 실행·보고서를 건드리지 않는다.
  await as('authenticated', userA);
  const siblingImpact = await readImpact('turn', siblingTurnId);
  assert.deepEqual(siblingImpact.counts, {
    chats: 0, messages: 0, analyses: 0, runs: 0, turns: 1, funds: 0, reports: 0, uploads: 0, profileChanges: 0,
  });
  const siblingReceipt = randomUUID();
  assert.equal((await deleteData('turn', siblingReceipt, siblingTurnId)).status, 'live_deleted');
  await assert.rejects(
    rpc('submit_analysis_chat_turn', analysisId, baseRun.runId, siblingTurnReq, '보류 항목 설명해줘', 'holds'),
    { code: 'PT409', message: 'analysis_chat_request_retired' },
  );

  // 2) 승인된 turn1 삭제 영향: 후속 실행 2건(run2, run3), 턴 4건(T1, T2, T3, T4), 보고서 3건, 프로필 제안 2건
  const turn1Impact = await readImpact('turn', turn1.turnId);
  assert.deepEqual(turn1Impact.counts, {
    chats: 0, messages: 0, analyses: 0, runs: 2, turns: 4, funds: 0, reports: 3, uploads: 0, profileChanges: 2,
  });

  const turn1Receipt = randomUUID();
  const turn1Deleted = await deleteData('turn', turn1Receipt, turn1.turnId);
  assert.equal(turn1Deleted.status, 'live_deleted');
  assert.deepEqual(await deleteData('turn', turn1Receipt, turn1.turnId), turn1Deleted);

  // 후속 실행·보고서·제안은 모두 제거되고 기준 실행·기준 보고서·이전 레거시 보고서·기준 제안은 보존된다.
  await assert.rejects(rpc('get_analysis_comparison', analysisId, turn1.resultRunId), { code: 'PT404' });
  await assert.rejects(rpc('get_analysis_comparison', analysisId, turn3.resultRunId), { code: 'PT404' });
  await assert.rejects(rpc('read_saved_analysis_report', reportOnRun2.reportId), { code: 'PT404' });
  await assert.rejects(rpc('read_saved_analysis_report', reportOnRun3.reportId), { code: 'PT404' });
  assert.equal((await rpc('read_saved_analysis_report', reportOnBase.reportId)).reportId, reportOnBase.reportId);

  const profileNow = await rpc('read_search_profile');
  assert.deepEqual(profileNow.proposals.map(p => p.id), [basePropReq]);

  await db.exec('reset role');
  const analysisState = await one('select latest_run_id, status from public.analyses where id = $1', [analysisId]);
  assert.deepEqual(analysisState, { latest_run_id: baseRun.runId, status: 'input_ready' });
  assert.ok(await one('select id from public.reports where id = $1', [legacyBefore]));
  assert.equal(await one('select id from public.reports where id = $1', [legacyAfter]), undefined);

  // 복원 방지: 은퇴한 턴 키·보고서 키·프로필 제안 키 재시도는 모두 PT409, 삭제된 제안 승인은 PT404다.
  await as('authenticated', userA);
  await assert.rejects(
    rpc('submit_analysis_chat_turn', analysisId, baseRun.runId, turn1.requestId, '재시도', 'change_period', '2026-10-20', '2026-10-30'),
    { code: 'PT409', message: 'analysis_chat_request_retired' },
  );
  await assert.rejects(
    rpc('save_analysis_report', analysisId, baseRun.runId, reportOnRun2Req),
    { code: 'PT409', message: 'report_request_retired' },
  );
  await assert.rejects(rpc('decide_search_profile_change', propOnRun2Req, 'approve'), { code: 'PT404' });

  // 실행 중인 미완료 후속 실행을 가진 승인 턴 삭제 시 지연된 작업자 완료 쓰기도 PT404로 차단된다.
  const inflightTurn = await approveAndFinishPeriodTurn(userA, analysisId, baseRun.runId, {
    start: '2026-10-21',
    end: '2026-10-28',
    finish: false,
  });
  await as('service_role');
  const leased = await rpc('claim_analysis_run', 300, inflightTurn.resultRunId);

  await as('authenticated', userA);
  assert.equal((await deleteData('turn', randomUUID(), inflightTurn.turnId)).status, 'live_deleted');
  await as('service_role');
  await assert.rejects(
    rpc('read_comparison_work', leased.runId, leased.generation, leased.leaseToken),
    { code: 'PT404', message: 'analysis_run_not_found' },
  );
});

test('single funding deletion prunes managed frozen reports, destroys opaque/referencing legacy reports, preserves unrelated reports, and blocks request_key replay', async () => {
  const userA = await createUser();
  const userB = await createUser();
  const { analysisId: analysisA } = await createChatAndAnalysis(userA, { analysisTitle: '자금 분석 A', room: null });
  const { analysisId: analysisA2 } = await createChatAndAnalysis(userA, { analysisTitle: '다른 분석 A2' });
  const { analysisId: analysisB } = await createChatAndAnalysis(userB, { analysisTitle: '타인 분석 B' });

  const fundKeep = await addFund(userA, analysisA, {
    kind: 'current', amountWon: '300000000', availableOn: '2026-10-20', certainty: 'confirmed',
  });
  const fundDeleteReqKey = randomUUID();
  const fundDelete = await addFund(userA, analysisA, {
    kind: 'additional', amountWon: '100000000', availableOn: '2026-11-05', certainty: 'expected',
    requestKey: fundDeleteReqKey,
  });

  const runA = await finishCollectedRun(userA, analysisA, { room: null });
  await as('authenticated', userA);
  const reportWithFunds = await rpc('save_analysis_report', analysisA, runA.runId, randomUUID(), firstRoom);
  const reportMissingRef = await rpc('save_analysis_report', analysisA, runA.runId, randomUUID(), firstRoom);
  const reportUnselected = await rpc('save_analysis_report', analysisA, runA.runId, randomUUID(), null);

  // 방어 검증: saved_report_funding_refs가 누락된 관리 보고서도 JSON 금액 제거 대상에 포함된다.
  await db.exec('reset role');
  await db.query(
    'delete from private.saved_report_funding_refs where report_id = $1 and funding_entry_id = $2',
    [reportMissingRef.reportId, fundDelete.id],
  );

  // 레거시 보고서 4종:
  // (1) 동일 분석의 판별 불가 레거시 사본(파기 대상),
  // (2) 다른 분석이지만 삭제 자금 UUID를 직접 참조하는 레거시 보고서(파기 대상),
  // (3) 다른 분석의 무관 레거시 보고서(보존 대상),
  // (4) 타인의 레거시 보고서(보존 대상).
  const legacySameAnalysis = (await one(
    `insert into public.reports(
       user_id, analysis_id, snapshot_version, result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot, queried_at
     ) values ($1, $2, 50, '{"legacyFundingSummary":"총 4억원"}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, now()) returning id`,
    [userA, analysisA],
  )).id;
  const legacyCrossRef = (await one(
    `insert into public.reports(
       user_id, analysis_id, snapshot_version, result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot, queried_at
     ) values ($1, $2, 1, $3::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, now()) returning id`,
    [userA, analysisA2, JSON.stringify({ copiedFunds: [{ id: fundDelete.id, amountWon: '100000000' }] })],
  )).id;
  const legacyOtherClean = (await one(
    `insert into public.reports(
       user_id, analysis_id, snapshot_version, result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot, queried_at
     ) values ($1, $2, 2, '{"legacy":"unrelated"}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, now()) returning id`,
    [userA, analysisA2],
  )).id;
  const legacyOtherOwner = (await one(
    `insert into public.reports(
       user_id, analysis_id, snapshot_version, result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot, queried_at
     ) values ($1, $2, 1, $3::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, now()) returning id`,
    [userB, analysisB, JSON.stringify({ note: fundDelete.id })],
  )).id;

  // 미리보기: 실제로 금액 제거(2) 또는 레거시 파기(2) 영향을 받는 보고서 4건만 집계한다(미선택·타 분석·타인 제외).
  await as('authenticated', userA);
  const fundImpact = await readImpact('fund', fundDelete.id);
  assert.deepEqual(fundImpact, {
    scope: 'fund',
    targetId: fundDelete.id,
    counts: { chats: 0, messages: 0, analyses: 0, runs: 0, turns: 0, funds: 1, reports: 4, uploads: 0, profileChanges: 0 },
    profileCleared: false,
    reportsDeleted: 2,
    reportsUpdated: 2,
    storageObjects: 0,
  });

  const receipt = randomUUID();
  const deleted = await deleteData('fund', receipt, fundDelete.id);
  assert.equal(deleted.status, 'live_deleted');
  assert.deepEqual(await deleteData('fund', receipt, fundDelete.id), deleted);

  // 관리 보고서 2건은 살아남아 fundDelete만 제거되고 fundKeep은 보존된다.
  const reread1 = await rpc('read_saved_analysis_report', reportWithFunds.reportId);
  const reread2 = await rpc('read_saved_analysis_report', reportMissingRef.reportId);
  const reread3 = await rpc('read_saved_analysis_report', reportUnselected.reportId);
  assert.deepEqual(reread1.sections.funding.value.funds, [fundKeep]);
  assert.deepEqual(reread2.sections.funding.value.funds, [fundKeep]);
  assert.equal(reread3.sections.funding.status, 'room_unselected');

  // 영향 대상 레거시 보고서 2건은 제거되고, 무관 레거시·타인 보고서는 보존된다.
  await db.exec('reset role');
  assert.equal(await one('select id from public.reports where id = $1', [legacySameAnalysis]), undefined);
  assert.equal(await one('select id from public.reports where id = $1', [legacyCrossRef]), undefined);
  assert.ok(await one('select id from public.reports where id = $1', [legacyOtherClean]));
  assert.ok(await one('select id from public.reports where id = $1', [legacyOtherOwner]));

  // 삭제된 레거시 버전(50)이 단조 카운터에 반영되어 새 저장 보고서는 51이 된다.
  await as('authenticated', userA);
  const nextSaved = await rpc('save_analysis_report', analysisA, runA.runId, randomUUID(), firstRoom);
  assert.equal(nextSaved.version, 51);

  // 복원 방지: 은퇴한 request_key로 자금 재등록 시도는 PT409로 차단된다.
  await assert.rejects(
    addFund(userA, analysisA, {
      kind: 'additional', amountWon: '100000000', availableOn: '2026-11-05', certainty: 'expected',
      requestKey: fundDeleteReqKey,
    }),
    { code: 'PT409', message: 'funding_request_retired' },
  );
});

test('profile purge clears search conditions, destination, and all managed/legacy history with monotonic revision while preserving independent facts and blocking delayed writes', async () => {
  const userA = await createUser();
  const userB = await createUser();
  await publishNoticeDirectory(['11215', '11200']);

  // 사용자 A: 관리 프로필 승인 + 대기 제안 + 출퇴근 목적지 + 레거시 직접 제안 + 독립 분석·보고서·자금
  await as('authenticated', userA);
  const approvedReq = randomUUID();
  await rpc('propose_search_profile_change', approvedReq, 0, json({ region_codes: ['11215'], budget_max_won: '850000000' }), '예산과 지역 설정');
  await rpc('decide_search_profile_change', approvedReq, 'approve');
  await rpc('confirm_commute_destination', userA, 1, '합성 강남역');
  const pendingReq = randomUUID();
  await rpc('propose_search_profile_change', pendingReq, 2, json({ budget_max_won: '920000000' }), '미승인 대기 제안');
  const legacyPending = (await one(
    `insert into public.profile_change_requests(user_id, base_revision, proposed_changes, reason)
     values ($1, 2, '{"commute_destination":"합성 판교역"}'::jsonb, '레거시 대기 사유') returning id`,
    [userA],
  )).id;

  // 사용자 B 프로필도 설정해 격리를 확인한다.
  await as('authenticated', userB);
  const userBReq = randomUUID();
  await rpc('propose_search_profile_change', userBReq, 0, json({ budget_max_won: '600000000' }), '사용자 B 예산');
  await rpc('decide_search_profile_change', userBReq, 'approve');

  // 독립 불변 사실(분석·수집본·실행·보고서·자금) 준비
  const { analysisId: analysisA } = await createChatAndAnalysis(userA, {
    conditions: {
      ingestion_target: { noticeSource: apt, ...collectedReplay.input.target },
      comparison: { modelNo, room: firstRoom },
      budget_max_won: '850000000',
    },
  });
  await addFund(userA, analysisA, { kind: 'current', amountWon: '200000000' });
  const runA = await finishCollectedRun(userA, analysisA);
  await as('authenticated', userA);
  const reportA = await rpc('save_analysis_report', analysisA, runA.runId, randomUUID());
  await db.exec('reset role');
  const legacyReportA = (await one(
    `insert into public.reports(
       user_id, analysis_id, snapshot_version, result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot, queried_at
     ) values ($1, $2, 2, '{"summary":"불변"}'::jsonb, '{"budget_max_won":"850000000"}'::jsonb, '[]'::jsonb, '[]'::jsonb, now()) returning id`,
    [userA, analysisA],
  )).id;
  const beforeFacts = {
    analysis: await one('select conditions_snapshot, latest_run_id from public.analyses where id = $1', [analysisA]),
    snapshot: await one('select conditions_snapshot from public.analysis_input_snapshots where id = $1', [runA.snapshotId]),
    legacyReport: await one('select result_snapshot, conditions_snapshot from public.reports where id = $1', [legacyReportA]),
    fund: await one('select amount_won::text from public.funding_entries where analysis_id = $1', [analysisA]),
  };

  // 미리보기: profileCleared = true, profileChanges = 4(관리 승인 + 출퇴근 + 관리 대기 + 레거시 대기)
  await as('authenticated', userA);
  const impact = await readImpact('profile');
  assert.deepEqual(impact, {
    scope: 'profile',
    targetId: null,
    counts: { chats: 0, messages: 0, analyses: 0, runs: 0, turns: 0, funds: 0, reports: 0, uploads: 0, profileChanges: 4 },
    profileCleared: true,
    reportsDeleted: 0,
    reportsUpdated: 0,
    storageObjects: 0,
  });

  // PostgREST 이름 인자 호환: p_target 생략 2인자 호출로 삭제한다.
  const receipt = randomUUID();
  const purged = await one(
    `select public.delete_personal_data(p_scope => 'profile', p_receipt => $1) as reply`,
    [receipt],
  );
  assert.equal(purged.reply.status, 'live_deleted');
  assert.equal(purged.reply.scope, 'profile');

  // 검색 조건·목적지·이력은 비워지고 revision은 2 -> 3으로 단조 증가한다.
  const afterProfile = await rpc('read_search_profile');
  assert.equal(afterProfile.revision, 3);
  assert.deepEqual(afterProfile.conditions, {});
  assert.equal(afterProfile.destination, null);
  assert.deepEqual(afterProfile.proposals, []);

  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from public.profile_change_requests where user_id = $1', [userA])).n, 0);
  assert.equal((await one('select count(*)::int as n from private.search_profile_proposals where user_id = $1', [userA])).n, 0);
  assert.equal((await one('select count(*)::int as n from public.profile_change_requests where user_id = $1', [userB])).n, 1);

  // 독립 불변 사실(분석·스냅샷·보고서·자금)은 그대로 보존된다.
  assert.deepEqual({
    analysis: await one('select conditions_snapshot, latest_run_id from public.analyses where id = $1', [analysisA]),
    snapshot: await one('select conditions_snapshot from public.analysis_input_snapshots where id = $1', [runA.snapshotId]),
    legacyReport: await one('select result_snapshot, conditions_snapshot from public.reports where id = $1', [legacyReportA]),
    fund: await one('select amount_won::text from public.funding_entries where analysis_id = $1', [analysisA]),
  }, beforeFacts);

  // 지연된 쓰기·레거시 승인·은퇴 요청 키는 모두 복원 차단된다.
  await as('authenticated', userA);
  assert.equal((await rpc('read_saved_analysis_report', reportA.reportId)).reportId, reportA.reportId);
  await assert.rejects(
    rpc('propose_search_profile_change', randomUUID(), 2, json({ budget_max_won: '850000000' }), '지연 쓰기'),
    { code: 'PT409', message: 'search_profile_revision_conflict' },
  );
  await assert.rejects(
    rpc('propose_search_profile_change', approvedReq, 3, json({ budget_max_won: '850000000' }), '은퇴 키 재사용'),
    { code: 'PT409', message: 'search_profile_request_retired' },
  );
  await assert.rejects(rpc('decide_search_profile_change', pendingReq, 'approve'), { code: 'PT404' });
  await assert.rejects(rpc('confirm_commute_destination', userA, 2, '합성 강남역'), {
    code: '40001',
    message: 'profile_revision_conflict',
  });
  await assert.rejects(rpc('decide_profile_change', legacyPending, 'approved'), {
    code: 'P0002',
    message: 'proposal_not_found',
  });

  // 삭제 이후 새 프로필을 revision=3 기준으로 정상 저장한 뒤, 옛 삭제 영수증을 재전송해도 새 프로필이 지워지지 않는다!
  const freshReq = randomUUID();
  await rpc('propose_search_profile_change', freshReq, 3, json({ budget_max_won: '700000000' }), '삭제 후 새 예산');
  const freshApproved = await rpc('decide_search_profile_change', freshReq, 'approve');
  assert.equal(freshApproved.revision, 4);
  assert.equal(freshApproved.conditions.budget_max_won, '700000000');

  assert.deepEqual(await deleteData('profile', receipt, null), purged.reply);
  const stillFresh = await rpc('read_search_profile');
  assert.equal(stillFresh.revision, 4);
  assert.equal(stillFresh.conditions.budget_max_won, '700000000');

  // 프로필 행이 아직 없는 새 계정의 profile 삭제도 revision=1로 끌어올려 지연된 base_revision=0 쓰기를 차단한다.
  const emptyUser = await createUser();
  await as('authenticated', emptyUser);
  assert.equal((await deleteData('profile', randomUUID())).status, 'live_deleted');
  assert.equal((await rpc('read_search_profile')).revision, 1);
  await assert.rejects(
    rpc('confirm_commute_destination', emptyUser, 0, '지연 목적지'),
    { code: '40001', message: 'profile_revision_conflict' },
  );
});

test('upload deletion clears bound reusable derivatives, preserves unrelated uploads, blocks unbound legacy ambiguity and duplicate IDs, and keeps tombstone anti-restoration', async () => {
  const userA = await createUser();
  const { analysisId } = await createChatAndAnalysis(userA, { analysisTitle: '업로드 파생 분석', room: null });

  // 1) 바인딩된 업로드 U1과 독립 업로드 U2를 같은 분석에 등록한다.
  // U2 실행을 먼저 마친 뒤 U1 실행과 그 기간 변경 후속 실행을 쌓아, U1 삭제 시 latest_run_id가 bound2.runId로 복원되는지도 확인한다.
  const upload1 = await registerAndStoreUpload(userA, analysisId);
  const upload2 = await registerAndStoreUpload(userA, analysisId);
  const bound2 = await finishSyntheticUploadBoundRun(userA, analysisId, upload2.id);
  const bound1 = await finishSyntheticUploadBoundRun(userA, analysisId, upload1.id);

  // U1 파생 실행에 연결된 대화·기간 변경 후속 실행·저장 보고서·프로필 제안 생성
  const turnOn1 = await approveAndFinishPeriodTurn(userA, analysisId, bound1.runId, {
    start: '2026-10-20',
    end: '2026-10-28',
  });
  await as('authenticated', userA);
  const report1Req = randomUUID();
  const report1 = await rpc('save_analysis_report', analysisId, bound1.runId, report1Req);
  const report2 = await rpc('save_analysis_report', analysisId, bound2.runId, randomUUID());
  const prop1Req = randomUUID();
  await rpc('propose_search_profile_change', prop1Req, 0, json({ budget_max_won: '770000000' }), 'U1 기반 제안', analysisId, bound1.runId);

  // U1 영향 미리보기: U1 + 파생 실행 2건(bound1, turnOn1.resultRunId) + 턴 1건 + 보고서 1건 + 프로필 제안 1건 (U2 파생은 제외!)
  const impact1 = await readImpact('upload', upload1.id);
  assert.deepEqual(impact1, {
    scope: 'upload',
    targetId: upload1.id,
    counts: { chats: 0, messages: 0, analyses: 0, runs: 2, turns: 1, funds: 0, reports: 1, uploads: 1, profileChanges: 1 },
    profileCleared: false,
    reportsDeleted: 1,
    reportsUpdated: 0,
    storageObjects: 1,
  });

  const receipt1 = randomUUID();
  const deleted1 = await deleteData('upload', receipt1, upload1.id);
  assert.equal(deleted1.status, 'processing');
  assert.deepEqual(await deleteData('upload', receipt1, upload1.id), deleted1);

  // U1 파생물은 모두 제거되고, U2와 U2의 스냅샷·실행·보고서는 보존되며 latest_run_id는 bound2.runId로 복원된다.
  await assert.rejects(rpc('get_analysis_comparison', analysisId, bound1.runId), { code: 'PT404' });
  await assert.rejects(rpc('get_analysis_comparison', analysisId, turnOn1.resultRunId), { code: 'PT404' });
  await assert.rejects(rpc('read_saved_analysis_report', report1.reportId), { code: 'PT404' });
  assert.equal((await rpc('read_saved_analysis_report', report2.reportId)).reportId, report2.reportId);

  await db.exec('reset role');
  assert.equal(await one('select id from public.analysis_input_snapshots where id = $1', [bound1.snapshotId]), undefined);
  assert.ok(await one('select id from public.analysis_input_snapshots where id = $1', [bound2.snapshotId]));
  assert.equal((await one('select latest_run_id from public.analyses where id = $1', [analysisId])).latest_run_id, bound2.runId);
  assert.equal(
    (await one('select status from public.analysis_uploads where user_id = $1 and analysis_id = $2 and id = $3', [userA, analysisId, upload1.id])).status,
    'deleted',
  );

  // tombstone 복원 방지: 동일 upload_id 재등록은 deleted 상태를 유지해 Storage 재업로드를 차단하고,
  // 은퇴한 스냅샷·실행·보고서 키 재시도는 모두 PT409다.
  await as('authenticated', userA, { is_anonymous: false }, 'storage.object.upload');
  const reregistered = await one('select * from public.register_analysis_upload($1, $2)', [analysisId, upload1.id]);
  assert.equal(reregistered.status, 'deleted');
  await assert.rejects(
    rpc('enqueue_analysis_run', analysisId, bound1.runIdempotencyKey, json({ kind: 'snapshot', snapshotId: bound2.snapshotId })),
    { code: 'PT409', message: 'analysis_run_request_retired' },
  );
  await assert.rejects(
    rpc('save_analysis_report', analysisId, bound2.runId, report1Req),
    { code: 'PT409', message: 'report_request_retired' },
  );
  await as('service_role');
  await assert.rejects(
    rpc('save_ingestion_snapshot', userA, analysisId, bound1.captureKey, json(fixtureRaw.request), json(syntheticIngestion)),
    { code: 'PT409', message: 'snapshot_capture_retired' },
  );

  // 큐 작업자는 U1 경로만 수거해 live_deleted로 마무리하며 U2 Storage 객체는 보존한다.
  const { work: uploadWork, advanced: uploadDone } = await completeQueuedStorageDeletion(receipt1);
  assert.deepEqual(uploadWork.paths, [upload1.object_path]);
  assert.equal(uploadDone.status, 'live_deleted');
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from storage.objects where name = $1', [upload2.object_path])).n, 1);

  // 2) 미바인딩 레거시 업로드 스냅샷이 있는 분석에서 단일 업로드 미리보기·삭제는 PT409로 명시 차단한다.
  const { analysisId: ambigAnalysis } = await createChatAndAnalysis(userA, { analysisTitle: '모호 업로드 분석', room: null });
  const ambigUpload = await registerAndStoreUpload(userA, ambigAnalysis);
  await finishSyntheticUploadBoundRun(userA, ambigAnalysis, 'legacy-unbound-pdf-v1');

  await as('authenticated', userA);
  await assert.rejects(readImpact('upload', ambigUpload.id), uploadScopeUnverified);
  const blockedReceipt = randomUUID();
  await assert.rejects(deleteData('upload', blockedReceipt, ambigUpload.id), uploadScopeUnverified);
  await assert.rejects(rpc('read_deletion_receipt', blockedReceipt), receiptNotFound);

  // 반면 상위 분석 단위 삭제는 모호함 없이 전체를 정리할 수 있다.
  const ambigAnalysisDeleted = await deleteData('analysis', blockedReceipt, ambigAnalysis);
  assert.equal(ambigAnalysisDeleted.status, 'processing');
  const { advanced: ambigDone } = await completeQueuedStorageDeletion(blockedReceipt);
  assert.equal(ambigDone.status, 'live_deleted');

  // 3) 미바인딩 레거시 보고서(sources_snapshot에 user_upload만 표시)도 단일 업로드 삭제를 PT409로 차단한다.
  const { analysisId: ambigRepAnalysis } = await createChatAndAnalysis(userA, { analysisTitle: '레거시 보고서 모호 분석', room: null });
  const ambigRepUpload = await registerAndStoreUpload(userA, ambigRepAnalysis, randomUUID(), { storeBytes: false });
  await db.exec('reset role');
  await db.query(
    `insert into public.reports(
       user_id, analysis_id, snapshot_version, result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot, queried_at
     ) values ($1, $2, 1, '{"legacy":true}'::jsonb, '{}'::jsonb, '["user_upload"]'::jsonb, '[]'::jsonb, now())`,
    [userA, ambigRepAnalysis],
  );
  await as('authenticated', userA);
  await assert.rejects(readImpact('upload', ambigRepUpload.id), uploadScopeUnverified);
  await assert.rejects(deleteData('upload', randomUUID(), ambigRepUpload.id), uploadScopeUnverified);

  // 4) 두 분석에 같은 upload_id가 중복 등록된 경우 목록은 안정 표시하되 단일 삭제·미리보기는 PT409로 차단한다.
  const dupUploadId = randomUUID();
  const { analysisId: dupA1 } = await createChatAndAnalysis(userA, { analysisTitle: '중복 분석 1' });
  const { analysisId: dupA2 } = await createChatAndAnalysis(userA, { analysisTitle: '중복 분석 2' });
  await registerAndStoreUpload(userA, dupA1, dupUploadId, { storeBytes: false });
  await registerAndStoreUpload(userA, dupA2, dupUploadId, { storeBytes: false });

  await as('authenticated', userA);
  const uploadList = await listItems('upload');
  assert.equal(uploadList.items.filter(item => item.id === dupUploadId).length, 1);
  await assert.rejects(readImpact('upload', dupUploadId), uploadScopeUnverified);
  await assert.rejects(deleteData('upload', randomUUID(), dupUploadId), uploadScopeUnverified);

  // 5) 기존 deletion_requested 상태의 업로드도 개별 삭제 경로로 정상 수거·완료한다.
  const { analysisId: pendingDelAnalysis } = await createChatAndAnalysis(userA, { analysisTitle: '삭제대기 업로드 분석' });
  const pendingUpload = await registerAndStoreUpload(userA, pendingDelAnalysis);
  await as('authenticated', userA);
  await rpc('request_analysis_upload_deletion', pendingDelAnalysis, pendingUpload.id);
  const pendingReceipt = randomUUID();
  assert.equal((await deleteData('upload', pendingReceipt, pendingUpload.id)).status, 'processing');
  const { work: pendingWork, advanced: pendingDone } = await completeQueuedStorageDeletion(pendingReceipt);
  assert.deepEqual(pendingWork.paths, [pendingUpload.object_path]);
  assert.equal(pendingDone.status, 'live_deleted');
});

test('report deletion handles both managed and legacy reports, and account preview + fence coordinate with queue worker', async () => {
  const userA = await createUser();
  const userB = await createUser();
  const { chatId: chatA, analysisId: analysisA } = await createChatAndAnalysis(userA);
  const { analysisId: analysisB } = await createChatAndAnalysis(userB);
  await addMessage(userA, chatA, '계정 미리보기 메시지');
  await addFund(userA, analysisA, { kind: 'current', amountWon: '150000000' });
  const runA = await finishCollectedRun(userA, analysisA);
  await registerAndStoreUpload(userA, analysisA);
  await registerAndStoreUpload(userB, analysisB);

  await as('authenticated', userA);
  const managedReq = randomUUID();
  const managed = await rpc('save_analysis_report', analysisA, runA.runId, managedReq);
  await db.exec('reset role');
  const legacy = (await one(
    `insert into public.reports(
       user_id, analysis_id, snapshot_version, result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot, queried_at
     ) values ($1, $2, 10, '{"legacy":true}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, now()) returning id`,
    [userA, analysisA],
  )).id;

  // 1) 관리 보고서와 레거시 보고서를 각각 delete_personal_data('report', ...)로 삭제한다.
  await as('authenticated', userA);
  const repImpact = await readImpact('report', legacy);
  assert.equal(repImpact.counts.reports, 1);
  assert.equal(repImpact.reportsDeleted, 1);
  assert.equal((await deleteData('report', randomUUID(), legacy)).status, 'live_deleted');
  assert.equal((await deleteData('report', randomUUID(), managed.reportId)).status, 'live_deleted');

  // 은퇴한 저장 키 재시도는 PT409이며, 새 보고서는 삭제된 레거시 버전(10) 이후인 11을 부여받는다.
  await assert.rejects(rpc('save_analysis_report', analysisA, runA.runId, managedReq), {
    code: 'PT409',
    message: 'report_request_retired',
  });
  const savedV11 = await rpc('save_analysis_report', analysisA, runA.runId, randomUUID());
  assert.equal(savedV11.version, 11);

  // 프로필 설정 + 대화 턴 추가 후 account 전체 미리보기를 검증한다.
  await rpc('propose_search_profile_change', randomUUID(), 0, json({ budget_max_won: '800000000' }), '계정 미리보기 예산');
  await rpc('confirm_commute_destination', userA, 0, '합성 서울역');
  await rpc('submit_analysis_chat_turn', analysisA, runA.runId, randomUUID(), '계정 미리보기 턴', 'help');

  const accountImpact = await readImpact('account');
  assert.deepEqual(accountImpact, {
    scope: 'account',
    targetId: null,
    counts: {
      chats: 1,
      messages: 1,
      analyses: 1,
      runs: 1,
      turns: 1,
      funds: 1,
      reports: 1,
      uploads: 1,
      profileChanges: 2,
    },
    profileCleared: true,
    reportsDeleted: 1,
    reportsUpdated: 0,
    storageObjects: 1,
  });

  // 실제 계정 삭제는 queue worker의 request_account_deletion이 처리하며, 접수 직후 retired keys 제거와 42501 울타리가 작동한다.
  const acctReceipt = randomUUID();
  const acctRes = await rpc('request_account_deletion', acctReceipt);
  assert.equal(acctRes.scope, 'account');
  assert.equal(acctRes.status, 'processing');

  await assert.rejects(listItems('chat'), authRequired);
  await assert.rejects(readImpact('account'), authRequired);
  await assert.rejects(deleteData('profile', randomUUID()), authRequired);

  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from private.retired_deletion_keys where user_id = $1', [userA])).n, 0);
  assert.equal((await one('select count(*)::int as n from public.analyses where user_id = $1', [userB])).n, 1);
});

function dayNow() {
  return koreanDate.format(new Date());
}
