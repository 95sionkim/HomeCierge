// 합성 Auth·Storage 카탈로그와 PGlite로 D-06/A-56 삭제 대기열, 계정 삭제,
// 업로드 스테이징, 작업자 배치·공정 재시도·외부 버킷 차단, 백업 확인 영수증 계약을 검사한다.
// 실제 외부 API·실제 Auth 계정·실제 Storage 버킷은 호출하지 않으며 모든 자료는 합성 자료다.
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

const bucket = 'analysis-uploads';
const uploadOp = 'storage.object.upload';
const downloadOp = 'storage.object.get_authenticated';
const infoOp = 'storage.object.get_authenticated_info';
const deleteOp = 'storage.object.delete_many';
const storedPdfMetadata = { mimetype: 'application/pdf', cacheControl: 'private, max-age=0' };

const authRequired = { code: '42501', message: 'authentication_required' };
const forbidden = { code: '42501' };
const invalidReceipt = { code: '22023', message: 'invalid_deletion_receipt' };
const notFound = { code: 'PT404', message: 'deletion_receipt_not_found' };
const conflict = { code: 'PT409', message: 'deletion_receipt_conflict' };
const foreignBlocked = { code: 'PT409', message: 'deletion_foreign_storage_object' };
const isoTimestamp = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|\+00:00)$/;

const modelNo = '01';
const houseType = '084.0000A';
const roomLabel = '101동 101호';
const proof = { document: 'synthetic-notice-pdf', version: 'synthetic-v1', page: 7 };

let db;
let syntheticIngestion;
let syntheticComparison;

function fixtureSchedules() {
  return [
    {
      modelNo,
      houseType,
      room: roomLabel,
      item: 'sale_price',
      status: 'confirmed',
      totalWon: '700000000',
      reasons: [],
      evidence: [proof],
      installments: [
        {
          stage: 'balance',
          won: '700000000',
          timing: { trigger: 'deadline', dateStatus: 'exact', date: '2026-11-30', evidence: [proof] },
        },
      ],
    },
  ];
}

function buildReplays() {
  const replayPy = `
import json, sys
sys.path.insert(0, 'scripts')
from replay_ingestion import loads_source_json, replay
from compare_trades import compare_snapshot

raw, evidence = json.load(sys.stdin)
ing = replay(loads_source_json(json.dumps(raw, ensure_ascii=False)))
comp = compare_snapshot(ing, {'modelNo': '${modelNo}', 'room': '${roomLabel}'}, evidence)
print(json.dumps({'input': raw['request'], 'ingestion': ing, 'comparison': comp}, ensure_ascii=False))
`;
  return JSON.parse(execFileSync('python3', ['-B', '-c', replayPy], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify([fixtureRaw, fixtureEvidence]),
  }));
}

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function countOf(table, where = '', params = []) {
  const row = await one(`select count(*)::integer as n from ${table} ${where}`, params);
  return row.n;
}

async function rootRole() {
  await db.exec('reset role');
}

async function asRole(role, userId = '', { isAnonymous = false, operation = '' } = {}) {
  await rootRole();
  const claims = userId ? { sub: userId, is_anonymous: isAnonymous } : {};
  await db.query(
    `select set_config('request.jwt.claim.sub', $1, false),
            set_config('request.jwt.claims', $2, false),
            set_config('storage.operation', $3, false)`,
    [userId, JSON.stringify(claims), operation],
  );
  await db.exec(`set role ${role}`);
}

async function asUser(userId, opts = {}) {
  await asRole('authenticated', userId, opts);
}

async function rpc(name, ...params) {
  const args = params.map((_, index) => `$${index + 1}`).join(', ');
  return (await one(`select public.${name}(${args}) as reply`, params)).reply;
}

async function uploadRpc(name, analysisId, uploadId) {
  return one(`select * from public.${name}($1, $2)`, [analysisId, uploadId]);
}

async function createUser({
  verified = true,
  anonymous = false,
  bannedUntil = null,
  deletedAt = null,
  withSession = true,
} = {}) {
  await rootRole();
  const userId = randomUUID();
  await db.query(
    `insert into auth.users(id, confirmed_at, is_anonymous, banned_until, deleted_at)
     values ($1, case when $2 then now() end, $3, $4, $5)`,
    [userId, verified, anonymous, bannedUntil, deletedAt],
  );
  if (withSession) {
    await db.query('insert into auth.sessions(id, user_id) values ($1, $2)', [randomUUID(), userId]);
  }
  return userId;
}

async function storeObject(bucketId, path, ownerId, { ownerUuid = null, metadata = storedPdfMetadata } = {}) {
  await db.query(
    'insert into storage.objects(bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3, $4, $5)',
    [bucketId, path, ownerUuid, ownerId, metadata],
  );
}

async function removeStoragePaths(paths) {
  await asRole('service_role');
  if (paths.length === 0) return;
  await db.query(
    'delete from storage.objects where bucket_id = $1 and name = any($2::text[])',
    [bucket, paths],
  );
}

async function hardDeleteAuthUser(userId) {
  await rootRole();
  await db.query('delete from auth.users where id = $1', [userId]);
}

function assertReceiptShape(receipt, expected) {
  assert.deepEqual(Object.keys(receipt).sort(), ['backup', 'completedAt', 'receiptId', 'requestedAt', 'scope', 'status']);
  assert.equal(receipt.receiptId, expected.receiptId);
  assert.equal(receipt.scope, expected.scope);
  assert.equal(receipt.status, expected.status);
  assert.match(receipt.requestedAt, isoTimestamp);
  if (expected.status === 'processing') {
    assert.equal(receipt.completedAt, null);
  } else {
    assert.match(receipt.completedAt, isoTimestamp);
    assert.ok(Date.parse(receipt.completedAt) >= Date.parse(receipt.requestedAt));
  }
  if (expected.backupStatus === 'verified') {
    assert.deepEqual(Object.keys(receipt.backup).sort(), ['status', 'verifiedAt']);
    assert.equal(receipt.backup.status, 'verified');
    assert.match(receipt.backup.verifiedAt, isoTimestamp);
    assert.ok(Date.parse(receipt.backup.verifiedAt) >= Date.parse(receipt.completedAt));
  } else {
    assert.deepEqual(receipt.backup, { status: 'unverified' });
  }
}

async function seedSharedCatalogs() {
  await rootRole();
  const sources = [
    'applyhome_apt', 'applyhome_apt_model', 'applyhome_remainder', 'applyhome_remainder_model',
    'applyhome_notice_pdf', 'mois_legal_region_codes', 'apt_trade', 'apt_rights', 'law_eflaw',
    'naver_news', 'kakao_address', 'odsay_route', 'kakao_directions',
  ];
  await db.query(
    `insert into public.source_registry(
       id, display_name, storage_permission, reuse_permission, display_permission, export_permission
     )
     select id, '합성 출처', 'allowed', 'allowed', 'allowed', 'allowed'
     from unnest($1::text[]) as t(id)
     on conflict (id) do nothing`,
    [sources],
  );
  const notice = await one(
    `insert into public.notices(source_id, external_id, title, notice_kind, collected_at)
     values ('applyhome_apt', 'synthetic-ext-1', '합성 공유 공고', 'new_sale', now())
     returning id`,
  );
  const doc = await one(
    `insert into public.notice_documents(notice_id, official_url, collected_at)
     values ($1, 'https://synthetic.invalid/notice.pdf', now())
     returning id`,
    [notice.id],
  );
  await db.query(
    `insert into public.housing_types(notice_id, external_type_id, label, supply_area_m2, supply_area_status, source_document_id, source_page)
     values ($1, '01', '84A', 105.5, 'verified', $2, 1)`,
    [notice.id, doc.id],
  );
  await db.query(
    `insert into private.ingestion_runs(source_id, request_scope, status, total_count, collected_count, completed_at)
     values ('applyhome_apt', '{}'::jsonb, 'complete', 1, 1, now())`,
  );
  const todayKst = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const indexValue = {
    contractVersion: 'notice-search-index/v1',
    dataOrigin: 'collected',
    observedAt: new Date().toISOString(),
    publicationWindow: { start: todayKst, end: todayKst },
    coverage: {
      status: 'complete',
      sources: [
        { source: 'applyhome_apt', status: 'empty' },
        { source: 'applyhome_remainder', status: 'empty' },
      ],
    },
    notices: [],
    regionCodes: ['11215'],
  };
  await asRole('service_role');
  await rpc('publish_notice_search_index', JSON.stringify(indexValue));
  await rpc('publish_notice_directory', JSON.stringify(indexValue), JSON.stringify({ '11215': '서울특별시 광진구' }));
  await rpc('publish_law_reference', JSON.stringify({
    contractVersion: 'law-reference/v1',
    dataOrigin: 'collected',
    asOf: '2026-10-05',
    observedAt: new Date().toISOString(),
    title: '주택공급에 관한 규칙',
    mst: '123456',
    lawId: '123456',
    promulgatedOn: '2026-09-01',
    effectiveOn: '2026-09-05',
    articles: [{ number: '1', branch: null, heading: '목적' }],
  }));
  return { noticeId: notice.id, docId: doc.id };
}

async function seedFullAccountData(userId) {
  await asUser(userId);
  await db.query('insert into public.user_profiles(user_id) values ($1)', [userId]);
  // 레거시 프로필 변경안 + 관리 대상 공유 프로필 변경안
  const legacyProposal = await one(
    `insert into public.profile_change_requests(user_id, base_revision, proposed_changes, reason)
     values ($1, 0, '{"commute_destination":"합성 목적지"}'::jsonb, '합성 레거시 사유') returning id`,
    [userId],
  );
  await rpc(
    'propose_search_profile_change',
    randomUUID(),
    0,
    JSON.stringify({ budget_max_won: '900000000' }),
    '합성 프로필 제안',
  );

  // 대화·메시지·분석·자금
  const chat = await one(
    "insert into public.chats(user_id, title) values ($1, '합성 개인 대화') returning id",
    [userId],
  );
  await db.query(
    "insert into public.chat_messages(user_id, chat_id, role, content) values ($1, $2, 'user', '합성 사용자 메시지')",
    [userId, chat.id],
  );
  const conditions = {
    ingestion_target: { noticeSource: 'applyhome_apt', ...syntheticIngestion.input.target },
    comparison: { modelNo, room: roomLabel },
  };
  const analysis = await one(
    'insert into public.analyses(user_id, chat_id, title, conditions_snapshot) values ($1, $2, $3, $4) returning id',
    [userId, chat.id, '합성 개인 분석', JSON.stringify(conditions)],
  );
  const fund = await one(
    `insert into public.funding_entries(user_id, analysis_id, kind, amount_won, available_on, certainty, note)
     values ($1, $2, 'current', 300000000, '2026-10-20', 'confirmed', '합성 메모') returning id`,
    [userId, analysis.id],
  );

  // 수집본 + 납부 일정 + 실행 완료 + 비교 결과 + 대화 턴 + 저장 보고서(관리+레거시+삭제요청)
  await asRole('service_role');
  const snapshotId = await rpc(
    'save_funding_schedule_snapshot',
    userId, analysis.id, randomUUID(),
    JSON.stringify(syntheticIngestion.input),
    JSON.stringify(syntheticIngestion.ingestion),
    JSON.stringify(fixtureSchedules()),
  );
  await asUser(userId);
  const finishedRunReq = await rpc(
    'enqueue_analysis_run', analysis.id, randomUUID(),
    JSON.stringify({ kind: 'snapshot', snapshotId }),
  );
  await asRole('service_role');
  const claimedFinished = await rpc('claim_analysis_run', 300, finishedRunReq.runId);
  await rpc(
    'finish_analysis_comparison',
    claimedFinished.runId, claimedFinished.generation, claimedFinished.leaseToken,
    null, null, JSON.stringify(syntheticIngestion.comparison),
  );

  // 비교 대화 턴 + 저장 보고서(1건 유지, 1건 삭제해 deleted_report_requests도 채움)
  await asUser(userId);
  await rpc(
    'submit_analysis_chat_turn',
    analysis.id, finishedRunReq.runId, randomUUID(), '합성 질문입니다.', 'help',
  );
  const savedReport = await rpc('save_analysis_report', analysis.id, finishedRunReq.runId, randomUUID());
  const deletedReport = await rpc('save_analysis_report', analysis.id, finishedRunReq.runId, randomUUID());
  await rpc('delete_saved_analysis_report', deletedReport.reportId);

  // 레거시 보고서 + 뉴스/출퇴근 시도 카운터 + 진행 중(임대 보유) 분석 실행 1건
  await rootRole();
  await db.query(
    `insert into public.reports(user_id, analysis_id, snapshot_version, result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot, queried_at)
     values ($1, $2, 99, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, now())`,
    [userId, analysis.id],
  );
  await db.query(
    'insert into private.regional_news_attempts(user_id, window_start, attempts) values ($1, now(), 1)',
    [userId],
  );
  await db.query(
    'insert into private.commute_attempts(user_id, window_start, attempts) values ($1, now(), 1)',
    [userId],
  );

  // 별도 분석에 진행 중인 작업자 임대(run lease) 준비
  await asUser(userId);
  const activeAnalysis = await one(
    "insert into public.analyses(user_id, chat_id, title) values ($1, $2, '합성 진행 중 분석') returning id",
    [userId, chat.id],
  );
  const inflightReq = await rpc(
    'enqueue_analysis_run', activeAnalysis.id, randomUUID(), JSON.stringify(syntheticInput),
  );
  await asRole('service_role');
  const inflightLease = await rpc('claim_analysis_run', 300, inflightReq.runId);

  // 업로드 3건: registered(객체 있음), deletion_requested(객체 있음), deleted(이미 정리됨)
  await asUser(userId, { operation: uploadOp });
  const uploadRegistered = await uploadRpc('register_analysis_upload', analysis.id, randomUUID());
  await storeObject(bucket, uploadRegistered.object_path, userId);

  const uploadDeletionRequested = await uploadRpc('register_analysis_upload', analysis.id, randomUUID());
  await storeObject(bucket, uploadDeletionRequested.object_path, userId);
  await uploadRpc('request_analysis_upload_deletion', analysis.id, uploadDeletionRequested.id);

  const uploadAlreadyDeleted = await uploadRpc('register_analysis_upload', analysis.id, randomUUID());
  await uploadRpc('request_analysis_upload_deletion', analysis.id, uploadAlreadyDeleted.id);
  await uploadRpc('finalize_analysis_upload_deletion', analysis.id, uploadAlreadyDeleted.id);

  return {
    legacyProposalId: legacyProposal.id,
    chatId: chat.id,
    analysisId: analysis.id,
    activeAnalysisId: activeAnalysis.id,
    fundId: fund.id,
    snapshotId,
    finishedRunId: finishedRunReq.runId,
    savedReportId: savedReport.reportId,
    inflightLease,
    uploadRegistered,
    uploadDeletionRequested,
    uploadAlreadyDeleted,
  };
}

before(async () => {
  syntheticIngestion = buildReplays();
  syntheticComparison = syntheticIngestion.comparison;
  db = await createBe03Db();
  await db.exec(`
    alter table auth.users
      add column confirmed_at timestamptz,
      add column is_anonymous boolean not null default false,
      add column banned_until timestamptz,
      add column deleted_at timestamptz;
    create table auth.sessions (
      id uuid primary key,
      user_id uuid not null references auth.users(id) on delete cascade
    );
    insert into storage.buckets (id, name, public)
    values ('unrelated-bucket', 'unrelated-bucket', false);
  `);
});

beforeEach(async () => {
  await rootRole();
  await db.exec(`
    delete from storage.objects;
    truncate private.account_deletion_fences, private.data_deletion_objects, private.data_deletion_requests,
      private.search_profile_proposals, private.saved_report_funding_refs, private.saved_analysis_reports,
      private.deleted_report_requests, private.analysis_report_versions, private.analysis_chat_turns,
      private.analysis_funding_schedule_snapshots, private.comparison_results, private.comparison_evidence,
      private.analysis_runs, private.regional_news_attempts, private.commute_attempts,
      private.notice_directory_publication, private.notice_search_index, private.law_references,
      private.ingestion_runs, public.analysis_uploads, public.analysis_input_snapshots,
      public.reports, public.funding_entries, public.analyses, public.chat_messages, public.chats,
      public.profile_change_requests, public.user_profiles, public.housing_types,
      public.notice_documents, public.notices, public.source_registry, auth.sessions, auth.users cascade;
  `);
});

after(async () => {
  await db?.close();
});

test('private tables enable RLS with zero grants, public RPC grants stay strict, and no client DELETE is opened', async () => {
  await rootRole();

  for (const table of [
    'private.data_deletion_requests',
    'private.account_deletion_fences',
    'private.data_deletion_objects',
  ]) {
    const rls = await one(
      `select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname || '.' || c.relname = $1`,
      [table],
    );
    assert.equal(rls.relrowsecurity, true, `${table} must enable RLS`);
    for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const granted = await one('select has_table_privilege($1, $2, $3) as ok', [role, table, priv]);
        assert.equal(granted.ok, false, `${role} must not have ${priv} on ${table}`);
      }
    }
  }

  // anon은 private 스키마 USAGE 권한이 없어야 한다.
  assert.equal((await one("select has_schema_privilege('anon', 'private', 'USAGE') as ok")).ok, false);

  // 공개 테이블에 새 일반 DELETE 권한을 열지 않는다.
  for (const table of [
    'public.user_profiles', 'public.profile_change_requests', 'public.chats', 'public.chat_messages',
    'public.analyses', 'public.funding_entries', 'public.reports', 'public.analysis_input_snapshots',
    'public.analysis_uploads',
  ]) {
    for (const role of ['public', 'anon', 'authenticated']) {
      assert.equal(
        (await one('select has_table_privilege($1, $2, $3) as ok', [role, table, 'DELETE'])).ok,
        false,
        `${role} must not have DELETE on ${table}`,
      );
    }
  }

  // 공개 RPC 역할별 실행 권한을 정확히 확인한다.
  const expectedGrants = [
    ['public.request_account_deletion(uuid)', { public: false, anon: false, authenticated: true, service_role: false }],
    ['public.read_deletion_receipt(uuid)', { public: false, anon: true, authenticated: true, service_role: false }],
    ['private.read_deletion_receipt(uuid)', { public: false, anon: true, authenticated: true, service_role: false }],
    ['public.deletion_work(uuid)', { public: false, anon: false, authenticated: false, service_role: true }],
    ['public.advance_deletion_work(uuid)', { public: false, anon: false, authenticated: false, service_role: true }],
    ['public.record_deletion_backup_review(uuid,timestamp with time zone)', { public: false, anon: false, authenticated: false, service_role: true }],
    ['private.current_account_access_active()', { public: false, anon: false, authenticated: true, service_role: false }],
    ['private.begin_data_deletion(uuid,uuid,text,uuid)', { public: false, anon: false, authenticated: false, service_role: false }],
    ['private.stage_deletion_uploads(uuid,uuid,uuid[],uuid)', { public: false, anon: false, authenticated: false, service_role: false }],
    ['private.finish_data_deletion_request(uuid)', { public: false, anon: false, authenticated: false, service_role: false }],
    ['private.require_deletion_read_owner()', { public: false, anon: false, authenticated: false, service_role: false }],
    ['private.lock_deletion_owner(boolean)', { public: false, anon: false, authenticated: false, service_role: false }],
    ['private.deletion_receipt_payload(private.data_deletion_requests)', { public: false, anon: false, authenticated: false, service_role: false }],
    ['private.owner_has_foreign_storage_objects(uuid)', { public: false, anon: false, authenticated: false, service_role: false }],
  ];
  for (const [signature, matrix] of expectedGrants) {
    for (const [role, expected] of Object.entries(matrix)) {
      const actual = await one('select has_function_privilege($1, $2, $3) as ok', [role, signature, 'EXECUTE']);
      assert.equal(actual.ok, expected, `${role} EXECUTE on ${signature}`);
    }
  }

  // 실제 역할 전환 호출에서도 권한 거부를 검증한다.
  assert.equal((await one("select prosecdef from pg_proc where oid='public.read_deletion_receipt(uuid)'::regprocedure")).prosecdef,false);
  const receipt = randomUUID();
  const user = await createUser();
  await asRole('anon');
  await assert.rejects(rpc('request_account_deletion', receipt), forbidden);
  await assert.rejects(rpc('deletion_work', receipt), forbidden);
  await assert.rejects(rpc('advance_deletion_work', receipt), forbidden);
  await assert.rejects(rpc('record_deletion_backup_review', receipt, new Date().toISOString()), forbidden);
  await assert.rejects(rpc('read_deletion_receipt', receipt), notFound);

  await asUser(user);
  await assert.rejects(rpc('deletion_work', receipt), forbidden);
  await assert.rejects(rpc('advance_deletion_work', receipt), forbidden);
  await assert.rejects(rpc('record_deletion_backup_review', receipt, new Date().toISOString()), forbidden);

  await asRole('service_role');
  await assert.rejects(rpc('request_account_deletion', receipt), forbidden);
  await assert.rejects(rpc('read_deletion_receipt', receipt), forbidden);
});

test('verified owner check and UUID v4 validation gate account deletion and anonymous receipt lookup', async () => {
  const unverified = await createUser({ verified: false });
  const anonAccount = await createUser({ anonymous: true });
  const banned = await createUser({ bannedUntil: new Date(Date.now() + 3600_000).toISOString() });
  const deleted = await createUser({ deletedAt: new Date().toISOString() });
  const expiredBan = await createUser({ bannedUntil: new Date(Date.now() - 60_000).toISOString() });
  const missingUser = randomUUID();

  for (const [label, uid, opts] of [
    ['unverified', unverified, {}],
    ['db-anonymous', anonAccount, {}],
    ['jwt-anonymous', expiredBan, { isAnonymous: true }],
    ['banned', banned, {}],
    ['soft-deleted', deleted, {}],
    ['missing-auth', missingUser, {}],
  ]) {
    await asUser(uid, opts);
    await assert.rejects(rpc('request_account_deletion', randomUUID()), authRequired, label);
  }

  // 비-v4 UUID(nil, v1, 잘못된 variant)와 NULL 거부
  const badUuids = [
    null,
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-1111-8111-111111111111',
    '11111111-1111-4111-c111-111111111111',
  ];
  await asUser(expiredBan);
  for (const bad of badUuids) {
    await assert.rejects(rpc('request_account_deletion', bad), invalidReceipt);
  }
  await asRole('anon');
  for (const bad of badUuids) {
    await assert.rejects(rpc('read_deletion_receipt', bad), invalidReceipt);
  }
  await assert.rejects(rpc('read_deletion_receipt', randomUUID()), notFound);

  // 과거에 만료된 ban 계정은 정상 접수된다.
  await asUser(expiredBan);
  const receiptId = randomUUID();
  const receipt = await rpc('request_account_deletion', receiptId);
  assertReceiptShape(receipt, { receiptId, scope: 'account', status: 'processing' });
});

test('account deletion atomically purges all personal rows, fences old JWT/legacy RPCs/workers, and preserves shared data & other owners', async () => {
  await seedSharedCatalogs();
  const userA = await createUser();
  const userB = await createUser();
  const seededA = await seedFullAccountData(userA);
  const seededB = await seedFullAccountData(userB);

  const receiptA = randomUUID();
  await asUser(userA);
  const first = await rpc('request_account_deletion', receiptA);
  assertReceiptShape(first, { receiptId: receiptA, scope: 'account', status: 'processing' });

  // 동일 소유자의 동일 영수증 재전송은 차단/울타리 이후에도 수렴한다.
  const retry = await rpc('request_account_deletion', receiptA);
  assert.deepEqual(retry, first);

  // 이미 접수된 계정이 다른 영수증으로 재요청하면 차단된다.
  await assert.rejects(rpc('request_account_deletion', randomUUID()), authRequired);

  // 다른 계정이 알려진 영수증을 채택하려 해도 PT409로 거부되고 다른 계정 자료는 그대로 유지된다.
  await asUser(userB);
  await assert.rejects(rpc('request_account_deletion', receiptA), conflict);

  // 1) User A의 모든 개인 앱 테이블이 즉시 0건이고, Auth 행은 banned_until이 설정된 채 유지되며 세션은 제거됐다.
  await rootRole();
  const authA = await one('select id, banned_until from auth.users where id = $1', [userA]);
  assert.equal(authA.id, userA);
  assert.ok(Date.parse(authA.banned_until) > Date.now() + 86_400_000);
  assert.equal(await countOf('auth.sessions', 'where user_id = $1', [userA]), 0);
  assert.equal(await countOf('private.account_deletion_fences', 'where user_id = $1', [userA]), 1);

  const personalTables = [
    ['public.user_profiles', 'where user_id = $1'],
    ['public.profile_change_requests', 'where user_id = $1'],
    ['private.search_profile_proposals', 'where user_id = $1'],
    ['public.chats', 'where user_id = $1'],
    ['public.chat_messages', 'where user_id = $1'],
    ['public.analyses', 'where user_id = $1'],
    ['public.funding_entries', 'where user_id = $1'],
    ['public.reports', 'where user_id = $1'],
    ['public.analysis_uploads', 'where user_id = $1'],
    ['public.analysis_input_snapshots', 'where user_id = $1'],
    ['private.analysis_runs', 'where user_id = $1'],
    ['private.analysis_chat_turns', 'where user_id = $1'],
    ['private.saved_analysis_reports', 'where user_id = $1'],
    ['private.saved_report_funding_refs', 'where user_id = $1'],
    ['private.deleted_report_requests', 'where user_id = $1'],
    ['private.regional_news_attempts', 'where user_id = $1'],
    ['private.commute_attempts', 'where user_id = $1'],
  ];
  for (const [table, where] of personalTables) {
    assert.equal(await countOf(table, where, [userA]), 0, `${table} must be empty for deleted account`);
  }
  assert.equal(await countOf('private.analysis_report_versions', 'where analysis_id = $1', [seededA.analysisId]), 0);
  assert.equal(await countOf('private.comparison_results', 'where run_id = $1', [seededA.finishedRunId]), 0);
  assert.equal(await countOf('private.analysis_funding_schedule_snapshots', 'where snapshot_id = $1', [seededA.snapshotId]), 0);

  // Storage 객체는 DB에서 직접 지우지 않고 정확한 2개 경로만 대기열에 적재한다(이미 deleted된 3번째 제외).
  const staged = await db.query(
    'select object_path from private.data_deletion_objects where receipt_id = $1 order by object_path',
    [receiptA],
  );
  assert.deepEqual(
    staged.rows.map(r => r.object_path),
    [seededA.uploadRegistered.object_path, seededA.uploadDeletionRequested.object_path].sort(),
  );
  assert.equal(
    await countOf('storage.objects', 'where bucket_id = $1 and owner_id = $2', [bucket, userA]),
    2,
  );

  // 2) 공유 카탈로그와 다른 소유자(User B)의 자료·세션·Storage 객체는 그대로 보존된다.
  assert.equal(await countOf('public.source_registry'), 13);
  assert.equal(await countOf('public.notices'), 1);
  assert.equal(await countOf('public.notice_documents'), 1);
  assert.equal(await countOf('public.housing_types'), 1);
  assert.equal(await countOf('private.ingestion_runs'), 1);
  assert.equal(await countOf('private.notice_search_index'), 1);
  assert.equal(await countOf('private.notice_directory_publication'), 1);
  assert.equal(await countOf('private.law_references'), 1);
  assert.equal(await countOf('auth.sessions', 'where user_id = $1', [userB]), 1);
  assert.equal(await countOf('public.chats', 'where user_id = $1', [userB]), 1);
  assert.equal(await countOf('public.analyses', 'where user_id = $1', [userB]), 2);
  assert.equal(await countOf('private.saved_analysis_reports', 'where user_id = $1', [userB]), 1);
  assert.equal(await countOf('storage.objects', 'where bucket_id = $1 and owner_id = $2', [bucket, userB]), 2);

  // 3) User A의 옛 JWT로 PostgREST 읽기·재생성·레거시/신규 DEFINER RPC·Storage 접근이 모두 차단된다.
  await asUser(userA);
  for (const tbl of ['source_registry', 'notices', 'notice_documents', 'housing_types', 'chats', 'analyses', 'user_profiles']) {
    assert.equal((await db.query(`select * from public.${tbl}`)).rows.length, 0, `fenced old JWT must not read ${tbl}`);
  }
  await assert.rejects(db.query('insert into public.user_profiles(user_id) values ($1)', [userA]), forbidden);
  await assert.rejects(db.query("insert into public.chats(user_id, title) values ($1, '재생성')", [userA]), forbidden);
  await assert.rejects(rpc('decide_profile_change', seededA.legacyProposalId, 'approved'), authRequired);
  await assert.rejects(rpc('register_analysis_upload', seededA.analysisId, randomUUID()), authRequired);
  await assert.rejects(rpc('request_analysis_upload_deletion', seededA.analysisId, seededA.uploadRegistered.id), authRequired);
  await assert.rejects(rpc('finalize_analysis_upload_deletion', seededA.analysisId, seededA.uploadRegistered.id), authRequired);
  await assert.rejects(rpc('enqueue_analysis_run', seededA.analysisId, randomUUID(), JSON.stringify(syntheticInput)), authRequired);
  await assert.rejects(rpc('get_analysis_run', seededA.analysisId, seededA.finishedRunId), authRequired);
  await assert.rejects(rpc('cancel_analysis_run', seededA.analysisId, seededA.finishedRunId), authRequired);
  await assert.rejects(rpc('get_analysis_comparison', seededA.analysisId, seededA.finishedRunId), authRequired);
  await assert.rejects(rpc('confirm_commute_destination', userA, 0, '광화문역'), forbidden);
  await assert.rejects(rpc('read_notice_search_index'), forbidden);
  await assert.rejects(rpc('read_notice_directory_index'), forbidden);
  await assert.rejects(rpc('read_search_profile'), authRequired);
  await assert.rejects(rpc('propose_search_profile_change', randomUUID(), 0, '{"budget_max_won":"500000000"}', '차단'), authRequired);
  await assert.rejects(rpc('list_saved_analysis_reports'), authRequired);
  await assert.rejects(rpc('read_saved_analysis_report', seededA.savedReportId), authRequired);
  await assert.rejects(rpc('read_analysis_conversation', seededA.analysisId, seededA.finishedRunId), authRequired);

  // Storage RLS & 커밋 트리거 차단
  for (const op of [downloadOp, infoOp, deleteOp]) {
    await asUser(userA, { operation: op });
    assert.equal(
      (await db.query('select name from storage.objects where bucket_id = $1', [bucket])).rows.length,
      0,
      `fenced JWT must not see storage objects under ${op}`,
    );
  }
  await asUser(userA, { operation: uploadOp });
  await assert.rejects(storeObject(bucket, `${userA}/${seededA.analysisId}/${randomUUID()}.pdf`, userA), forbidden);

  // 4) 동시/지연 작업자(service_role)도 삭제 접수된 계정의 임대 완료·스냅샷 저장·루트 행 생성이 차단된다.
  await asRole('service_role');
  const { runId, generation, leaseToken } = seededA.inflightLease;
  await assert.rejects(rpc('renew_analysis_run', runId, generation, leaseToken, 60), { code: 'PT404' });
  await assert.rejects(rpc('read_comparison_work', runId, generation, leaseToken), { code: 'PT404' });
  await assert.rejects(
    rpc('finish_analysis_comparison', runId, generation, leaseToken,
      JSON.stringify(syntheticIngestion.input), JSON.stringify(syntheticIngestion.ingestion), JSON.stringify(syntheticComparison)),
    { code: 'PT404' },
  );
  await assert.rejects(
    rpc('save_ingestion_snapshot', userA, seededA.activeAnalysisId, randomUUID(),
      JSON.stringify(syntheticIngestion.input), JSON.stringify(syntheticIngestion.ingestion)),
    { code: '23503' },
  );
  await assert.rejects(
    db.query("insert into public.chats(user_id, title) values ($1, '작업자 경합')", [userA]),
    authRequired,
  );
  await assert.rejects(
    storeObject(bucket, seededA.uploadRegistered.object_path, userA),
    forbidden,
  );

  // 5) 서비스 작업자 단계: Storage API 삭제 -> advance -> deleteAuth:true -> Auth 삭제 -> advance -> live_deleted
  const work1 = await rpc('deletion_work', receiptA);
  assert.deepEqual(work1, {
    receiptId: receiptA,
    ownerId: userA,
    scope: 'account',
    paths: [seededA.uploadRegistered.object_path, seededA.uploadDeletionRequested.object_path].sort(),
    deleteAuth: false,
  });

  // Storage 삭제 전 advance 호출은 완료로 전이하지 않는다.
  assertReceiptShape(await rpc('advance_deletion_work', receiptA), {
    receiptId: receiptA, scope: 'account', status: 'processing',
  });

  // 1개만 지우면 아직 1개가 남아 deleteAuth=false 유지
  await removeStoragePaths([work1.paths[0]]);
  assertReceiptShape(await rpc('advance_deletion_work', receiptA), {
    receiptId: receiptA, scope: 'account', status: 'processing',
  });
  const work2 = await rpc('deletion_work', receiptA);
  assert.deepEqual(work2, {
    receiptId: receiptA, ownerId: userA, scope: 'account', paths: [work1.paths[1]], deleteAuth: false,
  });

  // 남은 1개까지 지워도 auth.users가 있으면 processing 유지, 다음 work가 deleteAuth=true 발행
  await removeStoragePaths(work2.paths);
  assertReceiptShape(await rpc('advance_deletion_work', receiptA), {
    receiptId: receiptA, scope: 'account', status: 'processing',
  });
  const work3 = await rpc('deletion_work', receiptA);
  assert.deepEqual(work3, {
    receiptId: receiptA, ownerId: userA, scope: 'account', paths: [], deleteAuth: true,
  });

  // Auth 삭제 전 advance 호출은 절대 live_deleted를 주장하지 않는다.
  assertReceiptShape(await rpc('advance_deletion_work', receiptA), {
    receiptId: receiptA, scope: 'account', status: 'processing',
  });

  // Auth Admin 하드 삭제 시뮬레이션 -> advance -> live_deleted
  await hardDeleteAuthUser(userA);
  await asRole('service_role');
  const completed = await rpc('advance_deletion_work', receiptA);
  assertReceiptShape(completed, { receiptId: receiptA, scope: 'account', status: 'live_deleted' });

  // 완료 후 재시도(advance idempotent, deletion_work NULL, anon/auth 상태 조회 가능, 원시 식별자 익명화)
  assert.deepEqual(await rpc('advance_deletion_work', receiptA), completed);
  assert.equal(await rpc('deletion_work', receiptA), null);

  await rootRole();
  const storedReceipt = await one(
    'select owner_id, target_id, request_digest, blocked_reason from private.data_deletion_requests where receipt_id = $1',
    [receiptA],
  );
  assert.deepEqual(storedReceipt, {
    owner_id: null, target_id: null, request_digest: null, blocked_reason: null,
  });
  assert.equal(await countOf('private.data_deletion_objects', 'where receipt_id = $1', [receiptA]), 0);
  assert.equal(await countOf('private.account_deletion_fences', 'where user_id = $1', [userA]), 0);

  // Auth 삭제 이후에도 anon·authenticated 영수증 상태 조회는 최소 공개 페이로드만 반환하고 원시 정보를 노출하지 않는다.
  await asRole('anon');
  const anonRead = await rpc('read_deletion_receipt', receiptA);
  assert.deepEqual(anonRead, completed);
  const serialized = JSON.stringify(anonRead);
  for (const secret of [userA, seededA.chatId, seededA.analysisId, seededA.uploadRegistered.id, seededA.uploadRegistered.object_path, '합성', 'foreign_storage_object']) {
    assert.equal(serialized.includes(secret), false, `receipt must not leak ${secret}`);
  }
  await asUser(userB);
  assert.deepEqual(await rpc('read_deletion_receipt', receiptA), completed);

  // Auth 삭제 이후 옛 JWT는 여전히 모든 테이블·RPC 접근이 차단된다.
  await asUser(userA);
  assert.equal((await db.query('select * from public.source_registry')).rows.length, 0);
  await assert.rejects(rpc('request_account_deletion', receiptA), authRequired);

  // 완료 및 익명화 후에도 다른 사용자는 알려진 영수증을 채택할 수 없다.
  await asUser(userB);
  await assert.rejects(rpc('request_account_deletion', receiptA), conflict);
  assert.equal((await db.query('select id from public.chats')).rows.length, 1);

  // 기존 개별 삭제에 쓴 영수증을 같은 소유자가 계정 삭제에 재사용하면 PT409로 거부되고 계정은 보존된다.
  const rPriorItem = randomUUID();
  await rootRole();
  await one("select private.begin_data_deletion($1, $2, 'profile', null)", [userB, rPriorItem]);
  await one('select private.finish_data_deletion_request($1)', [rPriorItem]);
  await asUser(userB);
  await assert.rejects(rpc('request_account_deletion', rPriorItem), conflict);
  assert.equal((await db.query('select id from public.chats')).rows.length, 1);
  await rootRole();
  assert.equal(await countOf('private.account_deletion_fences', 'where user_id = $1', [userB]), 0);
});

test('reusable private item-deletion helpers enforce idempotency, tombstone single uploads, cascade gating, and auto-completion', async () => {
  const userA = await createUser();
  const userB = await createUser();
  await asUser(userA);
  const chatA = await one("insert into public.chats(user_id, title) values ($1, '합성') returning id", [userA]);
  const analysisA = await one('insert into public.analyses(user_id, chat_id) values ($1, $2) returning id', [userA, chatA.id]);
  const analysisNoUpload = await one('insert into public.analyses(user_id, chat_id) values ($1, $2) returning id', [userA, chatA.id]);

  await asUser(userA, { operation: uploadOp });
  const up1 = await uploadRpc('register_analysis_upload', analysisA.id, randomUUID());
  const up2 = await uploadRpc('register_analysis_upload', analysisA.id, randomUUID());
  await storeObject(bucket, up1.object_path, userA);
  await storeObject(bucket, up2.object_path, userA);

  await asUser(userB, { operation: uploadOp });
  const chatB = await one("insert into public.chats(user_id, title) values ($1, '타인') returning id", [userB]);
  const analysisB = await one('insert into public.analyses(user_id, chat_id) values ($1, $2) returning id', [userB, chatB.id]);
  const upB = await uploadRpc('register_analysis_upload', analysisB.id, randomUUID());
  await storeObject(bucket, upB.object_path, userB);

  // 1) 모든 허용 범위와 대상 nullability 검증
  await rootRole();
  await assert.rejects(one("select private.begin_data_deletion($1, $2, 'invalid', $3)", [userA, randomUUID(), analysisA.id]), { code: '22023' });
  await assert.rejects(one("select private.begin_data_deletion($1, $2, 'profile', $3)", [userA, randomUUID(), analysisA.id]), { code: '22023' });
  await assert.rejects(one("select private.begin_data_deletion($1, $2, 'analysis', null)", [userA, randomUUID()]), { code: '22023' });

  for (const scope of ['chat', 'analysis', 'upload', 'message', 'turn', 'fund', 'report', 'profile']) {
    const rId = randomUUID();
    const target = scope === 'profile' ? null : randomUUID();
    const started = await one('select private.begin_data_deletion($1, $2, $3, $4) as reply', [userA, rId, scope, target]);
    assert.equal(started.reply, null, `${scope} new begin must return NULL`);
    const finished = await one('select private.finish_data_deletion_request($1) as reply', [rId]);
    assertReceiptShape(finished.reply, { receiptId: rId, scope, status: 'live_deleted' });
    // 완료 후에도 동일 소유·범위·대상 재전송은 기존 완료 영수증을 반환하고, 타인/타범위/타대상은 PT409다.
    const replay = await one('select private.begin_data_deletion($1, $2, $3, $4) as reply', [userA, rId, scope, target]);
    assert.deepEqual(replay.reply, finished.reply);
    await assert.rejects(one('select private.begin_data_deletion($1, $2, $3, $4)', [userB, rId, scope, target]), conflict);
    if (target !== null) {
      await assert.rejects(one('select private.begin_data_deletion($1, $2, $3, $4)', [userA, rId, scope, randomUUID()]), conflict);
    }
    const otherScope = scope === 'profile' ? 'account' : 'profile';
    await assert.rejects(one('select private.begin_data_deletion($1, $2, $3, null)', [userA, rId, otherScope]), conflict);
  }

  // 2) 단일 업로드 삭제: 지정된 1건만 스테이지하고 deleted tombstone을 유지해 재등록·조회를 차단한다.
  const rSingle = randomUUID();
  assert.equal((await one("select private.begin_data_deletion($1, $2, 'upload', $3) as reply", [userA, rSingle, up1.id])).reply, null);
  // 타인 분석 ID가 섞여도 타인 업로드는 절대 스테이지하지 않는다.
  await db.query('select private.stage_deletion_uploads($1, $2, $3::uuid[], $4)', [userA, rSingle, [analysisA.id, analysisB.id], up1.id]);
  const singleReceipt = (await one('select private.finish_data_deletion_request($1) as reply', [rSingle])).reply;
  assertReceiptShape(singleReceipt, { receiptId: rSingle, scope: 'upload', status: 'processing' });

  // up1은 deleted tombstone으로 남고 up2와 upB는 그대로 registered다.
  assert.equal((await one('select status from public.analysis_uploads where id = $1', [up1.id])).status, 'deleted');
  assert.equal((await one('select status from public.analysis_uploads where id = $1', [up2.id])).status, 'registered');
  assert.equal((await one('select status from public.analysis_uploads where id = $1', [upB.id])).status, 'registered');

  // up1 재등록은 tombstone을 되돌리지 못하고, Storage 조회·업로드·미완료 finalize도 차단된다.
  await asUser(userA, { operation: downloadOp });
  assert.equal((await uploadRpc('register_analysis_upload', analysisA.id, up1.id)).status, 'deleted');
  await assert.rejects(uploadRpc('finalize_analysis_upload_deletion', analysisA.id, up1.id), { code: '55000' });
  assert.equal((await db.query('select name from storage.objects where name = $1', [up1.object_path])).rows.length, 0);
  await asUser(userA, { operation: uploadOp });
  await assert.rejects(storeObject(bucket, up1.object_path, userA), forbidden);

  // 아직 up2가 스테이지되지 않았으므로 부모 분석 직접 삭제는 여전히 23503으로 차단된다.
  await rootRole();
  await assert.rejects(db.query('delete from public.analyses where id = $1', [analysisA.id]), { code: '23503' });

  // 3) 분석 삭제: 남은 up2 + 아직 Storage에 남아 있는 up1 tombstone까지 함께 스테이지하고 연쇄 삭제 허용
  const rAnalysis = randomUUID();
  assert.equal((await one("select private.begin_data_deletion($1, $2, 'analysis', $3) as reply", [userA, rAnalysis, analysisA.id])).reply, null);
  await db.query('select private.stage_deletion_uploads($1, $2, $3::uuid[], null)', [userA, rAnalysis, [analysisA.id]]);
  await db.query('delete from public.analyses where id = $1', [analysisA.id]);
  const analysisReceipt = (await one('select private.finish_data_deletion_request($1) as reply', [rAnalysis])).reply;
  assertReceiptShape(analysisReceipt, { receiptId: rAnalysis, scope: 'analysis', status: 'processing' });

  // 업로드가 없는 분석은 0건 no-op 스테이징 후 즉시 live_deleted로 자동 완료된다.
  const rEmpty = randomUUID();
  assert.equal((await one("select private.begin_data_deletion($1, $2, 'analysis', $3) as reply", [userA, rEmpty, analysisNoUpload.id])).reply, null);
  await db.query('select private.stage_deletion_uploads($1, $2, $3::uuid[], null)', [userA, rEmpty, [analysisNoUpload.id]]);
  await db.query('select private.stage_deletion_uploads($1, $2, $3::uuid[], null)', [userA, rEmpty, []]);
  await db.query('delete from public.analyses where id = $1', [analysisNoUpload.id]);
  const emptyReceipt = (await one('select private.finish_data_deletion_request($1) as reply', [rEmpty])).reply;
  assertReceiptShape(emptyReceipt, { receiptId: rEmpty, scope: 'analysis', status: 'live_deleted' });

  // 작업자가 up1, up2를 제거하면 rSingle과 rAnalysis 모두 live_deleted로 완료되고 raw 식별자가 비워진다.
  await asRole('service_role');
  const wSingle = await rpc('deletion_work', rSingle);
  assert.deepEqual(wSingle, { receiptId: rSingle, ownerId: userA, scope: 'upload', paths: [up1.object_path], deleteAuth: false });
  await removeStoragePaths([up1.object_path]);
  assertReceiptShape(await rpc('advance_deletion_work', rSingle), { receiptId: rSingle, scope: 'upload', status: 'live_deleted' });

  // rAnalysis는 up2가 아직 남아 있어 processing을 유지한다.
  assertReceiptShape(await rpc('advance_deletion_work', rAnalysis), { receiptId: rAnalysis, scope: 'analysis', status: 'processing' });
  const wAnalysis = await rpc('deletion_work', rAnalysis);
  assert.deepEqual(wAnalysis, { receiptId: rAnalysis, ownerId: userA, scope: 'analysis', paths: [up2.object_path], deleteAuth: false });
  await removeStoragePaths([up2.object_path]);
  assertReceiptShape(await rpc('advance_deletion_work', rAnalysis), { receiptId: rAnalysis, scope: 'analysis', status: 'live_deleted' });

  // User B의 업로드는 전혀 영향받지 않았다.
  await rootRole();
  assert.equal(await countOf('storage.objects', 'where name = $1', [upB.object_path]), 1);
  assert.equal((await one('select owner_id, target_id from private.data_deletion_requests where receipt_id = $1', [rAnalysis])).owner_id, null);
});

test('worker enforces 50-path batching, fair retry across failing jobs, and global app-bucket verification before deleteAuth', async () => {
  const userBatch = await createUser();
  const userFairA = await createUser();
  const userFairB = await createUser();
  const userEmpty = await createUser();

  // 1) 55개 업로드를 가진 계정 -> 50개 + 5개 배치 뒤에만 deleteAuth:true
  await asUser(userBatch, { operation: uploadOp });
  const chatBatch = await one("insert into public.chats(user_id, title) values ($1, '배치') returning id", [userBatch]);
  const analysisBatch = await one('insert into public.analyses(user_id, chat_id) values ($1, $2) returning id', [userBatch, chatBatch.id]);
  const expectedPaths = [];
  for (let i = 0; i < 55; i += 1) {
    const up = await uploadRpc('register_analysis_upload', analysisBatch.id, randomUUID());
    await storeObject(bucket, up.object_path, userBatch);
    expectedPaths.push(up.object_path);
  }
  expectedPaths.sort();
  const receiptBatch = randomUUID();
  await rpc('request_account_deletion', receiptBatch);

  await asRole('service_role');
  const firstBatch = await rpc('deletion_work', receiptBatch);
  assert.equal(firstBatch.deleteAuth, false);
  assert.equal(firstBatch.paths.length, 50);
  assert.deepEqual(firstBatch.paths, expectedPaths.slice(0, 50));
  await removeStoragePaths(firstBatch.paths);
  assertReceiptShape(await rpc('advance_deletion_work', receiptBatch), {
    receiptId: receiptBatch, scope: 'account', status: 'processing',
  });

  const secondBatch = await rpc('deletion_work', receiptBatch);
  assert.equal(secondBatch.deleteAuth, false);
  assert.deepEqual(secondBatch.paths, expectedPaths.slice(50));
  await removeStoragePaths(secondBatch.paths);
  assertReceiptShape(await rpc('advance_deletion_work', receiptBatch), {
    receiptId: receiptBatch, scope: 'account', status: 'processing',
  });

  // 앱 버킷에 고아 정규 파일이 하나 남아 있으면 전역 검사로 잡아내어 deleteAuth=true를 보류한다.
  await rootRole();
  const orphanPath = `${userBatch}/${randomUUID()}/${randomUUID()}.pdf`;
  await db.exec('alter table storage.objects disable trigger guard_analysis_upload_object_write');
  await storeObject(bucket, orphanPath, userBatch);
  await db.exec('alter table storage.objects enable trigger guard_analysis_upload_object_write');

  await asRole('service_role');
  const orphanWork = await rpc('deletion_work', receiptBatch);
  assert.deepEqual(orphanWork, {
    receiptId: receiptBatch, ownerId: userBatch, scope: 'account', paths: [orphanPath], deleteAuth: false,
  });
  await removeStoragePaths([orphanPath]);
  await rpc('advance_deletion_work', receiptBatch);

  const authWork = await rpc('deletion_work', receiptBatch);
  assert.deepEqual(authWork, {
    receiptId: receiptBatch, ownerId: userBatch, scope: 'account', paths: [], deleteAuth: true,
  });
  await hardDeleteAuthUser(userBatch);
  await asRole('service_role');
  assertReceiptShape(await rpc('advance_deletion_work', receiptBatch), {
    receiptId: receiptBatch, scope: 'account', status: 'live_deleted',
  });

  // 2) 공정 재시도: 실패해 객체가 남은 작업(fairA)이 정상 대기 작업(fairB)을 기아시키지 않는다.
  for (const uid of [userFairA, userFairB]) {
    await asUser(uid, { operation: uploadOp });
    const c = await one("insert into public.chats(user_id, title) values ($1, '공정') returning id", [uid]);
    const a = await one('insert into public.analyses(user_id, chat_id) values ($1, $2) returning id', [uid, c.id]);
    const up = await uploadRpc('register_analysis_upload', a.id, randomUUID());
    await storeObject(bucket, up.object_path, uid);
  }
  const rFairA = randomUUID();
  const rFairB = randomUUID();
  await asUser(userFairA);
  await rpc('request_account_deletion', rFairA);
  await asUser(userFairB);
  await rpc('request_account_deletion', rFairB);

  await asRole('service_role');
  const pick1 = await rpc('deletion_work');
  assert.equal(pick1.receiptId, rFairA);
  // rFairA 실패(객체 미삭제) -> 다음 일반 폴링은 rFairB를 먼저 선택한다.
  const pick2 = await rpc('deletion_work');
  assert.equal(pick2.receiptId, rFairB);
  await removeStoragePaths(pick2.paths);
  await rpc('advance_deletion_work', rFairB);
  await hardDeleteAuthUser(userFairB);
  await asRole('service_role');
  assertReceiptShape(await rpc('advance_deletion_work', rFairB), {
    receiptId: rFairB, scope: 'account', status: 'live_deleted',
  });

  // 이제 남은 rFairA를 재시도해 완료한다.
  const pick3 = await rpc('deletion_work');
  assert.equal(pick3.receiptId, rFairA);
  await removeStoragePaths(pick3.paths);
  await rpc('advance_deletion_work', rFairA);
  const pick4 = await rpc('deletion_work');
  assert.deepEqual(pick4, { receiptId: rFairA, ownerId: userFairA, scope: 'account', paths: [], deleteAuth: true });
  await hardDeleteAuthUser(userFairA);
  await asRole('service_role');
  assertReceiptShape(await rpc('advance_deletion_work', rFairA), {
    receiptId: rFairA, scope: 'account', status: 'live_deleted',
  });

  // 3) 파일이 0건인 계정도 즉시 deleteAuth:true 작업이 발급되고 Auth 삭제 후 완료된다.
  const rEmpty = randomUUID();
  await asUser(userEmpty);
  assertReceiptShape(await rpc('request_account_deletion', rEmpty), {
    receiptId: rEmpty, scope: 'account', status: 'processing',
  });
  await asRole('service_role');
  assert.deepEqual(await rpc('deletion_work'), {
    receiptId: rEmpty, ownerId: userEmpty, scope: 'account', paths: [], deleteAuth: true,
  });
  await hardDeleteAuthUser(userEmpty);
  await asRole('service_role');
  assertReceiptShape(await rpc('advance_deletion_work', rEmpty), {
    receiptId: rEmpty, scope: 'account', status: 'live_deleted',
  });
  assert.equal(await rpc('deletion_work'), null);
});

test('worker blocks and reports foreign/unrelated-bucket objects without deleting them while serving healthy jobs fairly', async () => {
  const userBlocked = await createUser();
  const userNonCanon = await createUser();
  const userHealthy = await createUser();

  // userBlocked: 정상 app 버킷 PDF 1건 + 관련 없는 버킷 객체 1건
  await asUser(userBlocked, { operation: uploadOp });
  const chat1 = await one("insert into public.chats(user_id, title) values ($1, '차단') returning id", [userBlocked]);
  const analysis1 = await one('insert into public.analyses(user_id, chat_id) values ($1, $2) returning id', [userBlocked, chat1.id]);
  const validUpload = await uploadRpc('register_analysis_upload', analysis1.id, randomUUID());
  await storeObject(bucket, validUpload.object_path, userBlocked);

  await rootRole();
  await storeObject('unrelated-bucket', 'foreign/user-asset.txt', userBlocked, { metadata: null });

  const rBlocked = randomUUID();
  await asUser(userBlocked);
  await rpc('request_account_deletion', rBlocked);

  // 정상 app 버킷 PDF만 먼저 정리 대상에 포함된다(외부 버킷 경로 절대 미포함).
  await asRole('service_role');
  const firstStep = await rpc('deletion_work', rBlocked);
  assert.deepEqual(firstStep, {
    receiptId: rBlocked, ownerId: userBlocked, scope: 'account', paths: [validUpload.object_path], deleteAuth: false,
  });
  await removeStoragePaths([validUpload.object_path]);
  assertReceiptShape(await rpc('advance_deletion_work', rBlocked), {
    receiptId: rBlocked, scope: 'account', status: 'processing',
  });

  // 정상 파일이 비어도 외부 버킷 객체가 있으면 deleteAuth=true를 금지하고 PT409로 보고한다.
  await assert.rejects(rpc('deletion_work', rBlocked), foreignBlocked);
  assertReceiptShape(await rpc('advance_deletion_work', rBlocked), {
    receiptId: rBlocked, scope: 'account', status: 'processing',
  });

  // 다른 정상 계정 삭제(userHealthy)가 들어오면 일반 폴링은 차단 작업을 건너뛰고 정상 작업을 먼저 처리한다.
  const rHealthy = randomUUID();
  await asUser(userHealthy);
  await rpc('request_account_deletion', rHealthy);
  await asRole('service_role');
  const healthyWork = await rpc('deletion_work');
  assert.deepEqual(healthyWork, {
    receiptId: rHealthy, ownerId: userHealthy, scope: 'account', paths: [], deleteAuth: true,
  });
  await hardDeleteAuthUser(userHealthy);
  await asRole('service_role');
  assertReceiptShape(await rpc('advance_deletion_work', rHealthy), {
    receiptId: rHealthy, scope: 'account', status: 'live_deleted',
  });

  // 차단된 작업만 남았을 때 일반 폴링도 PT409로 차단 상태를 보고하며 외부 버킷 객체는 삭제되지 않는다.
  await assert.rejects(rpc('deletion_work'), foreignBlocked);
  await rootRole();
  assert.equal(await countOf('storage.objects', "where bucket_id = 'unrelated-bucket'"), 1);

  // 외부 버킷 객체가 별도로 정리되면 자동으로 차단이 풀려 Auth 삭제까지 완료된다.
  await db.query("delete from storage.objects where bucket_id = 'unrelated-bucket' and owner_id = $1", [userBlocked]);
  await asRole('service_role');
  assert.deepEqual(await rpc('deletion_work', rBlocked), {
    receiptId: rBlocked, ownerId: userBlocked, scope: 'account', paths: [], deleteAuth: true,
  });
  await hardDeleteAuthUser(userBlocked);
  await asRole('service_role');
  assertReceiptShape(await rpc('advance_deletion_work', rBlocked), {
    receiptId: rBlocked, scope: 'account', status: 'live_deleted',
  });

  // app 버킷 내 비정규 경로 또는 소유자 불일치·owner UUID 외국 버킷 객체도 삭제하지 않고 PT409로 차단한다.
  const userCrossOwner = await createUser();
  const userUuidForeign = await createUser();
  const otherOwner = await createUser();
  const legacyOwner = await createUser();
  await asUser(legacyOwner, { operation: uploadOp });
  const chat = await one("insert into public.chats(user_id,title) values ($1,'합성 옛 파일') returning id",[legacyOwner]);
  const analysis = await one('insert into public.analyses(user_id,chat_id) values ($1,$2) returning id',[legacyOwner,chat.id]);
  const missingOwner = await uploadRpc('register_analysis_upload',analysis.id,randomUUID());
  await rootRole();
  await db.exec('alter table storage.objects disable trigger guard_analysis_upload_object_write');
  await storeObject(bucket, missingOwner.object_path, null);
  await storeObject(bucket, 'unexpected/non-canonical.pdf', userNonCanon, { metadata: storedPdfMetadata });
  await storeObject(bucket, `${userCrossOwner}/${randomUUID()}/${randomUUID()}.pdf`, otherOwner, { metadata: storedPdfMetadata });
  await db.exec('alter table storage.objects enable trigger guard_analysis_upload_object_write');
  await storeObject('unrelated-bucket', 'foreign/by-owner-uuid.txt', null, { ownerUuid: userUuidForeign, metadata: null });

  for (const uid of [userNonCanon, userCrossOwner, userUuidForeign, legacyOwner]) {
    const rec = randomUUID();
    await asUser(uid);
    await rpc('request_account_deletion', rec);
    await asRole('service_role');
    await assert.rejects(rpc('deletion_work', rec), foreignBlocked);
    assertReceiptShape(await rpc('advance_deletion_work', rec), {
      receiptId: rec, scope: 'account', status: 'processing',
    });
  }
  await rootRole();
  assert.equal(await countOf('storage.objects','where name=$1',[missingOwner.object_path]),1);
  assert.equal(await countOf('storage.objects', "where bucket_id = $1 and name = 'unexpected/non-canonical.pdf'", [bucket]), 1);
  assert.equal(await countOf('storage.objects', "where bucket_id = 'unrelated-bucket' and owner = $1", [userUuidForeign]), 1);
});

test('overlapping single-upload deletion + account deletion, reservation uploads, early auth drop, and private owner helpers stay airtight', async () => {
  const user = await createUser();
  const unverified = await createUser({ verified: false });

  // private 소유자 검증·잠금 헬퍼 직접 검사(unverified 거부, verified 통과)
  await rootRole();
  await db.query(
    `select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
    [unverified, JSON.stringify({ sub: unverified, is_anonymous: false })],
  );
  await assert.rejects(one('select private.require_deletion_read_owner()'), authRequired);
  await assert.rejects(one('select private.lock_deletion_owner(false)'), authRequired);
  await db.query(
    `select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
    [user, JSON.stringify({ sub: user, is_anonymous: false })],
  );
  assert.equal((await one('select private.require_deletion_read_owner() as id')).id, user);
  assert.equal((await one('select private.lock_deletion_owner(false) as id')).id, user);

  // 업로드 2건: 1건은 실제 객체 있음(단일 삭제 대기), 1건은 미업로드 예약(registered, storage.objects 부재)
  await asUser(user, { operation: uploadOp });
  const chat = await one("insert into public.chats(user_id, title) values ($1, '겹침') returning id", [user]);
  const analysis = await one('insert into public.analyses(user_id, chat_id) values ($1, $2) returning id', [user, chat.id]);
  const upStored = await uploadRpc('register_analysis_upload', analysis.id, randomUUID());
  await storeObject(bucket, upStored.object_path, user);
  const upReserved = await uploadRpc('register_analysis_upload', analysis.id, randomUUID());

  // 단일 업로드 삭제를 먼저 접수(작업자 실행 전 -> storage.objects에 아직 남음)
  await rootRole();
  const rSingle = randomUUID();
  assert.equal((await one("select private.begin_data_deletion($1, $2, 'upload', $3) as reply", [user, rSingle, upStored.id])).reply, null);
  await db.query('select private.stage_deletion_uploads($1, $2, $3::uuid[], $4)', [user, rSingle, [analysis.id], upStored.id]);
  assertReceiptShape((await one('select private.finish_data_deletion_request($1) as reply', [rSingle])).reply, {
    receiptId: rSingle, scope: 'upload', status: 'processing',
  });

  // 이어서 계정 삭제 접수 -> 두 경로(upStored, upReserved) 모두 스케줄되며 fenced 후 private 헬퍼도 차단
  const rAccount = randomUUID();
  await asUser(user);
  assertReceiptShape(await rpc('request_account_deletion', rAccount), {
    receiptId: rAccount, scope: 'account', status: 'processing',
  });
  await rootRole();
  await db.query(
    `select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)`,
    [user, JSON.stringify({ sub: user, is_anonymous: false })],
  );
  await assert.rejects(one('select private.require_deletion_read_owner()'), authRequired);
  await assert.rejects(one('select private.lock_deletion_owner(false)'), authRequired);

  // 직렬 중복 호출에도 동일한 작업 배치를 멱등하게 반환한다.
  await asRole('service_role');
  const w1 = await rpc('deletion_work', rAccount);
  const w1Repeat = await rpc('deletion_work', rAccount);
  assert.deepEqual(w1Repeat, w1);
  assert.deepEqual(w1, {
    receiptId: rAccount,
    ownerId: user,
    scope: 'account',
    paths: [upStored.object_path, upReserved.object_path].sort(),
    deleteAuth: false,
  });

  // 만약 auth.users가 먼저 사라져도 Storage 객체가 남아 있으면 절대 live_deleted를 주장하지 않는다.
  await hardDeleteAuthUser(user);
  await asRole('service_role');
  assertReceiptShape(await rpc('advance_deletion_work', rAccount), {
    receiptId: rAccount, scope: 'account', status: 'processing',
  });

  // 실제 Storage 객체 제거 후 advance하면 예약 경로(storage.objects 부재)와 함께 두 영수증 모두 완료된다.
  await removeStoragePaths([upStored.object_path]);
  assertReceiptShape(await rpc('advance_deletion_work', rAccount), {
    receiptId: rAccount, scope: 'account', status: 'live_deleted',
  });
  assertReceiptShape(await rpc('advance_deletion_work', rSingle), {
    receiptId: rSingle, scope: 'upload', status: 'live_deleted',
  });
});

test('backup verification defaults to unverified, validates observation bounds, converges on identical retry, and rejects conflicts', async () => {
  const user = await createUser();
  const receiptId = randomUUID();
  await asUser(user);
  const pending = await rpc('request_account_deletion', receiptId);
  assertReceiptShape(pending, { receiptId, scope: 'account', status: 'processing', backupStatus: 'unverified' });

  // 완료 전에는 백업 확인을 기록할 수 없다.
  await asRole('service_role');
  await assert.rejects(rpc('record_deletion_backup_review', receiptId, new Date().toISOString()), {
    code: 'PT409', message: 'deletion_not_completed',
  });
  await assert.rejects(rpc('record_deletion_backup_review', randomUUID(), new Date().toISOString()), notFound);
  await assert.rejects(rpc('record_deletion_backup_review', null, new Date().toISOString()), {
    code: '22023', message: 'invalid_deletion_backup_review',
  });

  // 계정 삭제 완료
  await rpc('deletion_work', receiptId);
  await hardDeleteAuthUser(user);
  await asRole('service_role');
  const completed = await rpc('advance_deletion_work', receiptId);
  assertReceiptShape(completed, { receiptId, scope: 'account', status: 'live_deleted', backupStatus: 'unverified' });

  const completedMs = Date.parse(completed.completedAt);
  const beforeCompleted = new Date(completedMs - 1000).toISOString();
  const futureTime = new Date(Date.now() + 60_000).toISOString();

  // completedAt 이전·미래 시각·NULL 시각 거부
  await assert.rejects(rpc('record_deletion_backup_review', receiptId, null), {
    code: '22023', message: 'invalid_deletion_backup_review',
  });
  await assert.rejects(rpc('record_deletion_backup_review', receiptId, beforeCompleted), {
    code: '22023', message: 'invalid_deletion_backup_review',
  });
  await assert.rejects(rpc('record_deletion_backup_review', receiptId, futureTime), {
    code: '22023', message: 'invalid_deletion_backup_review',
  });

  // completedAt 이상, DB now() 이하 관측은 정상 기록되고 backup:{status:'verified',verifiedAt}만 노출한다.
  const verifiedAt = completed.completedAt;
  const reviewed = await rpc('record_deletion_backup_review', receiptId, verifiedAt);
  assertReceiptShape(reviewed, { receiptId, scope: 'account', status: 'live_deleted', backupStatus: 'verified' });
  assert.equal(Date.parse(reviewed.backup.verifiedAt), completedMs);

  // 동일 시각 재시도는 멱등하게 같은 영수증을 반환한다.
  assert.deepEqual(await rpc('record_deletion_backup_review', receiptId, verifiedAt), reviewed);

  // 이미 확인된 뒤 다른 시각으로 덮어쓰려는 시도는 PT409로 거부한다.
  await new Promise(resolve => setTimeout(resolve, 15));
  const laterNow = (await one('select now()::text as ts')).ts;
  await assert.rejects(rpc('record_deletion_backup_review', receiptId, laterNow), {
    code: 'PT409', message: 'deletion_backup_review_conflict',
  });

  // 익명 영수증 조회에도 verified 결과만 노출된다.
  await asRole('anon');
  assert.deepEqual(await rpc('read_deletion_receipt', receiptId), reviewed);

  // completedAt보다 나중이고 DB now() 이하인 별도 관측 시각도 정상 기록된다.
  const user2 = await createUser();
  const receipt2 = randomUUID();
  await asUser(user2);
  await rpc('request_account_deletion', receipt2);
  await asRole('service_role');
  await rpc('deletion_work', receipt2);
  await hardDeleteAuthUser(user2);
  await asRole('service_role');
  const completed2 = await rpc('advance_deletion_work', receipt2);
  await new Promise(resolve => setTimeout(resolve, 20));
  const observedAfter = (await one('select now()::text as ts')).ts;
  const reviewed2 = await rpc('record_deletion_backup_review', receipt2, observedAfter);
  assertReceiptShape(reviewed2, { receiptId: receipt2, scope: 'account', status: 'live_deleted', backupStatus: 'verified' });
  assert.ok(Date.parse(reviewed2.backup.verifiedAt) > Date.parse(completed2.completedAt));
  await assert.rejects(rpc('record_deletion_backup_review', receipt2, completed2.completedAt), {
    code: 'PT409', message: 'deletion_backup_review_conflict',
  });
});
