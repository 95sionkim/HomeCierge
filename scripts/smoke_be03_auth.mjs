// 격리한 개발 스택에서 실행한다. SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,
// SUPABASE_WORKER_KEY(또는 SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY)를 실행 환경으로 받는다.
// 호스팅 개발 프로젝트를 사용할 때는 APP_ENV=development도 지정한다.
// 같은 두 계정으로 로컬 HTTP 서버를 통해 수집본·실행·저장된 비교 결과를 검수한다.
// node --import tsx scripts/smoke_be03_auth.mjs 로 실행한다.
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { isDeepStrictEqual, promisify } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { createDevServer } from '../dev/server.ts';
import { createHandler } from '../src/server/handler.ts';
import { createBackend } from '../src/server/supabase.ts';
import { checkNoticeSearch } from './smoke_notice_search.mjs';
import { checkFundingPlan } from './smoke_funding_plan.mjs';
import { checkLegalEvidence } from './smoke_legal_evidence.mjs';
import { checkBe04Cleanup, runBe04Smoke } from './smoke_be04_runs.mjs';

const DEVELOPMENT_ORIGIN = 'https://jcaelooqogosbzrfyrhe.supabase.co';
const ACCOUNT_TAG = 'homecierge_be03_smoke_run';
const SNAPSHOT_TABLE = 'analysis_input_snapshots';
const SAVE_SNAPSHOT = 'save_ingestion_snapshot';
const UPLOAD_BUCKET = 'analysis-uploads';
const UPLOAD_TABLE = 'analysis_uploads';
const REGISTER_UPLOAD = 'register_analysis_upload';
const REQUEST_UPLOAD_DELETE = 'request_analysis_upload_deletion';
const FINALIZE_UPLOAD_DELETE = 'finalize_analysis_upload_deletion';
const ROOT = new URL('../', import.meta.url);
const INGESTION_FIXTURE = 'tests/fixtures/ingestion-v0.json';
const PYTHON_ENV = { PATH: process.env.PATH, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' };
const execFileAsync = promisify(execFile);
const ME_ROUTE = '/api/v1/me';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

class SmokeFailure extends Error {}

function check(condition, step) {
  if (!condition) throw new SmokeFailure(step);
}

function result(reply, step) {
  check(!reply.error, step);
  return reply.data;
}

function failureStep(error) {
  return error instanceof SmokeFailure ? error.message : 'unexpected_failure';
}

function isServiceRoleKey(key) {
  if (/^sb_secret_[\w-]+$/.test(key ?? '')) return true;
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(key ?? '')) return false;
  try {
    return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'service_role';
  } catch {
    return false;
  }
}

function readConfig(env) {
  check((env.APP_ENV === undefined || env.APP_ENV === 'development') && env.VERCEL_ENV !== 'production'
    && env.VERCEL_TARGET_ENV !== 'production' && env.NODE_ENV !== 'production', 'development_only');
  let url;
  try {
    url = new URL(env.SUPABASE_URL);
  } catch {
    throw new SmokeFailure('target_not_allowed');
  }
  // 로컬 주소는 제품 핸들러가 개발용 HTTP로 허용한 호스트를 사용한다.
  const loopback = ['localhost', '127.0.0.1'].includes(url.hostname)
    && ['http:', 'https:'].includes(url.protocol);
  check((url.origin === DEVELOPMENT_ORIGIN || loopback) && url.pathname === '/'
    && !url.username && !url.password && !url.search && !url.hash, 'target_not_allowed');
  check(loopback || env.APP_ENV === 'development', 'development_only');
  check(env.BE07_EPHEMERAL_SEARCH_FIXTURE !== '1' || loopback, 'be07_ephemeral_database_required');

  const publishable = env.SUPABASE_PUBLISHABLE_KEY;
  const service = env.SUPABASE_WORKER_KEY ?? env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
  check(/^sb_publishable_[\w-]+$/.test(publishable ?? ''), 'publishable_key_required');
  check(isServiceRoleKey(service), 'service_key_required');
  return { origin: url.origin, publishable, service };
}

function loadCapture() {
  // 같은 BE-02 요청에 맞는 두 합성 원천을 재생해 유효한 내용 충돌을 만든다.
  const replay = spawnSync('python3', ['-c', `
import json
import sys
from pathlib import Path

sys.path.insert(0, 'scripts')
from replay_ingestion import loads_source_json, replay

bundle = loads_source_json(Path(sys.argv[1]).read_text(encoding='utf-8'))
original = replay(bundle)
notice = bundle['pages'][0]['body']['data'][0]
notice['HOUSE_NM'] += ' 변경'
changed = replay(bundle)
print(json.dumps({'input': bundle['request'], 'original': original, 'changed': changed}, allow_nan=False))
`, INGESTION_FIXTURE], { cwd: ROOT, encoding: 'utf8', timeout: 10_000, env: PYTHON_ENV });
  check(replay.status === 0, 'synthetic_replay');
  const capture = JSON.parse(replay.stdout);
  check(capture.original.dataOrigin === 'synthetic' && capture.changed.dataOrigin === 'synthetic'
    && !isDeepStrictEqual(capture.original, capture.changed), 'synthetic_capture');
  return capture;
}

function makeSyntheticPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> >>',
  ];
  let pdf = '%PDF-1.4\n% Synthetic BE-03 smoke fixture\n';
  const offsets = objects.map((entry, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${entry}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

function makeClient(origin, key) {
  return createClient(origin, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function makeAccount() {
  const id = randomUUID();
  return {
    id, email: `homecierge-be03-${id}@example.invalid`,
    password: `${randomBytes(24).toString('base64url')}aA1!`,
  };
}

async function createAccount(admin, account, runId) {
  const { id, email, password } = account;
  const { user } = result(await admin.auth.admin.createUser({
    id, email, password, email_confirm: true, app_metadata: { [ACCOUNT_TAG]: runId },
  }), 'auth_create');
  check(user?.id === id && user.email === email && user.app_metadata?.[ACCOUNT_TAG] === runId,
    'auth_create_identity');
}

async function login(account, client) {
  const { session } = result(await client.auth.signInWithPassword({
    email: account.email, password: account.password,
  }), 'auth_sign_in');
  check(session?.user?.id === account.id && session.access_token && session.refresh_token,
    'auth_sign_in_identity');
  return session;
}

async function refreshAndVerify(account, initial) {
  const { session } = result(await account.client.auth.refreshSession({
    refresh_token: initial.refresh_token,
  }), 'auth_refresh');
  check(session?.user?.id === account.id && session.access_token && session.refresh_token,
    'auth_refresh_identity');
  const { user } = result(await account.client.auth.getUser(session.access_token), 'auth_get_user');
  check(user?.id === account.id && user.is_anonymous !== true, 'auth_get_user_identity');
  return session;
}

async function checkMe(requestApi, account, session) {
  const reply = await requestApi(ME_ROUTE, { headers: { Authorization: `Bearer ${session.access_token}` } });
  check(reply.status === 200, 'me_status');
  const data = await reply.json();
  check(data.user?.id === account.id && data.profile?.user_id === account.id, 'me_identity_and_profile');
}

async function seedAccount(account) {
  const { id, client } = account;
  result(await client.from('user_profiles').insert({ user_id: id }), 'profile_insert');
  const chat = result(await client.from('chats')
    .insert({ user_id: id, title: 'BE-03 합성 대화' }).select('id').single(), 'chat_insert');
  check(UUID.test(chat?.id), 'chat_identity');
  account.chatId = chat.id;
  const analysis = result(await client.from('analyses')
    .insert({ user_id: id, chat_id: chat.id }).select('id').single(), 'analysis_insert');
  check(UUID.test(analysis?.id), 'analysis_identity');
  account.analysisId = analysis.id;
}

async function checkVisibility(table, column, own, other, client) {
  const rows = result(await client.from(table).select(column).in(column, [own, other]), `${table}_read`);
  check(rows?.length === 1 && rows[0][column] === own, `${table}_owner_isolation`);
}

async function storeWithPython(config, params) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('python3', [
      'scripts/store_ingestion.py', INGESTION_FIXTURE, '--owner-id', params.p_user_id,
      '--analysis-id', params.p_analysis_id, '--capture-key', params.p_capture_key,
    ], {
      cwd: ROOT, encoding: 'utf8', timeout: 35_000, maxBuffer: 4096,
      env: { ...PYTHON_ENV, APP_ENV: 'development', SUPABASE_URL: config.origin, SUPABASE_WORKER_KEY: config.service },
    }));
  } catch {
    throw new SmokeFailure('capture_store_cli');
  }
  try {
    const { snapshotId } = JSON.parse(stdout);
    check(UUID.test(snapshotId), 'capture_store_cli_response');
    return snapshotId;
  } catch {
    throw new SmokeFailure('capture_store_cli_response');
  }
}

async function storeConcurrently(admin, params) {
  // 두 번째 계정의 새 분석에서 같은 키의 첫 저장을 병행한다.
  const [first, retry] = await Promise.all([admin.rpc(SAVE_SNAPSHOT, params), admin.rpc(SAVE_SNAPSHOT, params)]);
  const id = result(first, 'capture_concurrent_save');
  check(result(retry, 'capture_concurrent_retry') === id, 'capture_concurrent_identity');
  return id;
}

async function saveSnapshot(admin, account, capture, captureKey, initialStore) {
  const params = {
    p_user_id: account.id, p_analysis_id: account.analysisId, p_capture_key: captureKey,
    p_input: capture.input, p_result: capture.original,
  };
  const id = await initialStore(params);
  check(UUID.test(id), 'capture_identity');
  const replayed = result(await admin.rpc(SAVE_SNAPSHOT, params), 'capture_replay');
  check(replayed === id, 'capture_replay_identity');
  const conflict = await admin.rpc(SAVE_SNAPSHOT, { ...params, p_result: capture.changed });
  check(conflict.status === 409 && conflict.error?.code === '23505', 'capture_conflict');
  const forbidden = await account.client.rpc(SAVE_SNAPSHOT, params);
  check((forbidden.status === 403 && forbidden.error?.code === '42501')
    || (forbidden.status === 404 && forbidden.error?.code === 'PGRST202'), 'capture_server_only');
  account.snapshotId = id;
  account.captureKey = captureKey;
}

async function reopenSnapshot(account, capture, client) {
  const row = result(await client.from(SNAPSHOT_TABLE).select('user_id,analysis_id,capture_key,input_snapshot,result_snapshot')
    .eq('id', account.snapshotId).single(), 'capture_reopen');
  check(row?.user_id === account.id && row.analysis_id === account.analysisId
    && row.capture_key === account.captureKey && isDeepStrictEqual(row.input_snapshot, capture.input)
    && isDeepStrictEqual(row.result_snapshot, capture.original), 'capture_reopen_contents');
  return row;
}

function collectionCoverage(coverage, reasons) {
  return {
    source_id: coverage.source, status: coverage.status, pages_expected: coverage.pagesExpected,
    missing_pages: coverage.missingPages, reported_total_count: coverage.reportedTotalCount,
    rows_received: coverage.rowsReceived, total_count_changed: coverage.totalCountChanged, error: coverage.error, reasons,
  };
}

function expectedViewRows({ input_snapshot: input, result_snapshot: stored }) {
  const collections = [
    ...stored.catalogCollections.map(coverage => ({
      ...collectionCoverage(coverage, coverage.reasons),
      collection_kind: coverage.source === input.noticeSource ? 'notice' : 'model',
      record_id: null, request_region_code: null, contract_month: null, trade_kinds: null,
      request_scope: coverage.scope,
    })),
    ...stored.tradeBatches.map(({ record, reasons }) => ({
      ...collectionCoverage(record, reasons), collection_kind: 'trade', record_id: record.recordId,
      request_region_code: record.requestRegionCode, contract_month: `${record.month}-01`, trade_kinds: record.tradeKinds,
      request_scope: { LAWD_CD: record.requestRegionCode, DEAL_YMD: record.month.replace('-', '') },
    })),
  ];
  const pages = collections.flatMap(collection => Array.from({ length: collection.pages_expected ?? 1 }, (_, index) => {
    const page = index + 1;
    let pageStatus = 'received';
    if (collection.status === 'failed') pageStatus = 'failed';
    else if (collection.missing_pages.includes(page)) pageStatus = 'missing';
    return { source_id: collection.source_id, record_id: collection.record_id, page, page_status: pageStatus };
  }));
  const observations = stored.tradeBatches.flatMap(({ record, trades }) => trades.map(trade => ({
    source_id: record.source, record_id: record.recordId,
    page: trade.provenance.page, row_position: trade.provenance.position,
    trade_kind: trade.tradeKind, contract_date: trade.contractDate.date,
    amount_won: trade.amount.won, exclusive_area_m2: trade.exclusiveArea.m2, supply_area_m2: trade.supplyArea.m2,
    cancellation_status: trade.cancellation.status, disposition: trade.disposition, observation: trade,
  })));
  const documents = stored.catalog.documents.map(document => ({
    document_id: document.id, version: document.version, acquisition_source: document.source,
    origin_check: document.originCheck, house_manage_no: document.houseManageNo, notice_no: document.noticeNo,
    edition: document.edition, status: document.status, document,
  }));
  return {
    ingestion_collections: collections, ingestion_collection_pages: pages,
    ingestion_trade_observations: observations, ingestion_document_versions: documents,
  };
}

async function checkSnapshotViews(account, other, row, client) {
  for (const [view, values] of Object.entries(expectedViewRows(row))) {
    check(values.length > 0, `${view}_fixture_nonempty`);
    const expected = values.map(fields => ({
      ...fields, snapshot_id: account.snapshotId, analysis_id: account.analysisId, user_id: account.id,
    }));
    const rows = result(await client.from(view).select(Object.keys(expected[0]).join(','))
      .in('snapshot_id', [account.snapshotId, other.snapshotId]), `${view}_read`);
    check(rows?.length === expected.length && rows.every(item => item.snapshot_id === account.snapshotId
      && item.analysis_id === account.analysisId && item.user_id === account.id), `${view}_owner_isolation`);
    check(isDeepStrictEqual(new Set(rows), new Set(expected)), `${view}_saved_values`);
  }
}

function uploadRpc(client, name, account) {
  return client.rpc(name, { analysis_id: account.analysisId, upload_id: account.upload.id }).single();
}

function checkUploadRow(row, account, expectedStatus, step) {
  check(row?.id === account.upload.id && row.user_id === account.id && row.analysis_id === account.analysisId
    && row.object_path === account.upload.path && row.status === expectedStatus, step);
}

async function registerUpload(account) {
  const id = randomUUID();
  // 응답이 끊겨도 이 작업이 만든 정확한 경로만 다시 조회·정리할 수 있다.
  account.upload = { id, path: `${account.id}/${account.analysisId}/${id}.pdf` };
  const row = result(await uploadRpc(account.client, REGISTER_UPLOAD, account), 'upload_register');
  checkUploadRow(row, account, 'registered', 'upload_registered_identity');
}

function uploadObject(client, path, pdf) {
  return client.storage.from(UPLOAD_BUCKET).upload(path, pdf, {
    cacheControl: '0', contentType: 'application/pdf', upsert: false,
  });
}

function deniedByStorage(error) {
  // Storage 버전에 따라 권한 오류를 403/404 또는 레거시 400 응답으로 보낸다.
  if ([403, 404].includes(error?.status)) return true;
  const legacyCodes = ['403', '404', 'AccessDenied', 'NoSuchKey', 'NoSuchBucket'];
  return error?.status === 400 && [error.statusCode, error.code].some(code => legacyCodes.includes(String(code)));
}

async function checkOwnFile(bucket, path, pdf) {
  const data = result(await bucket.download(path, { cacheNonce: randomUUID() }), 'storage_owner_download');
  check(data && Buffer.from(await data.arrayBuffer()).equals(pdf), 'storage_owner_contents');
}

function requestUploadContent(requestApi, account, token) {
  const route = `/api/v1/analyses/${account.analysisId}/uploads/${account.upload.id}/content`;
  return requestApi(route, { headers: { Authorization: `Bearer ${token}` } });
}

function checkContentResponse(reply, status, step) {
  check(reply.status === status, `${step}_status`);
  const directives = (reply.headers.get('cache-control') ?? '').toLowerCase().split(',');
  check(directives.some(value => value.trim() === 'no-store'), `${step}_no_store`);
}

async function checkUploadContents(requestApi, account, pdf, step) {
  const reply = await requestUploadContent(requestApi, account, account.accessToken);
  checkContentResponse(reply, 200, step);
  check(reply.headers.get('content-type')?.split(';')[0] === 'application/pdf', `${step}_type`);
  check(Buffer.from(await reply.arrayBuffer()).equals(pdf), `${step}_bytes`);
}

async function checkUnavailableUpload(requestApi, account, token, step) {
  const reply = await requestUploadContent(requestApi, account, token);
  checkContentResponse(reply, 404, step);
  const body = await reply.json().catch(() => null);
  check(body?.error === 'not_found', `${step}_body`);
}

async function documentWorkerDigest(account, token, port) {
  // 실제 문서 작업자와 같은 사용자 조회를 실행한다. 자식에는 서비스 키를 전달하지 않는다.
  const program = [
    'import hashlib, os, sys',
    'sys.path.insert(0, "scripts")',
    'from review_notice_documents import read_owned_upload',
    'upload = read_owned_upload(sys.argv[1], sys.argv[2], os.environ["HOMECIERGE_USER_JWT"], int(sys.argv[3]))',
    'print(hashlib.sha256(upload["content"]).hexdigest() if upload else "unavailable")',
  ].join('\n');
  try {
    const { stdout } = await execFileAsync('python3', ['-c', program, account.analysisId, account.upload.id, String(port)], {
      cwd: ROOT, encoding: 'utf8', timeout: 20_000, maxBuffer: 2048,
      env: { ...PYTHON_ENV, HOMECIERGE_USER_JWT: token },
    });
    return stdout.trim();
  } catch {
    throw new SmokeFailure('document_worker_upload_read');
  }
}

async function checkPublicFile(bucket, path, publishable) {
  const { data } = bucket.getPublicUrl(path);
  const reply = await fetch(data.publicUrl, { headers: { apikey: publishable } });
  const detail = reply.status === 400 ? await reply.json().catch(() => ({})) : {};
  check(deniedByStorage({ status: reply.status, statusCode: detail?.statusCode, code: detail?.code }),
    'storage_public_route_denied');
}

async function checkStorageIsolation(requestApi, account, other, pdf, publishable) {
  const { path } = account.upload;
  const ownBucket = account.client.storage.from(UPLOAD_BUCKET);
  const otherBucket = other.client.storage.from(UPLOAD_BUCKET);
  await checkUnavailableUpload(requestApi, account, account.accessToken, 'upload_content_before_upload');

  const foreignRegistration = await uploadRpc(other.client, REGISTER_UPLOAD, account);
  check(foreignRegistration.error?.code === 'P0002', 'upload_foreign_registration_denied');

  account.upload.writeAttempted = true;
  const foreignUpload = await uploadObject(other.client, path, pdf);
  check(deniedByStorage(foreignUpload.error), 'storage_foreign_upload_denied');
  const uploaded = result(await uploadObject(account.client, path, pdf), 'storage_owner_upload');
  check(uploaded?.path === path, 'storage_uploaded_path');
  await checkOwnFile(ownBucket, path, pdf);
  await checkUploadContents(requestApi, account, pdf, 'upload_content_first_read');
  await checkUploadContents(requestApi, account, pdf, 'upload_content_repeat_read');
  await checkUnavailableUpload(requestApi, account, other.accessToken, 'upload_content_foreign');

  const foreignRead = await otherBucket.download(path, { cacheNonce: randomUUID() });
  check(deniedByStorage(foreignRead.error), 'storage_foreign_download_denied');
  await checkPublicFile(ownBucket, path, publishable);
}

async function removeAndFinalizeUpload(account, requireFile) {
  const bucket = account.client.storage.from(UPLOAD_BUCKET);
  const removed = result(await bucket.remove([account.upload.path]), 'storage_remove');
  check(Array.isArray(removed) && (!requireFile || (removed.length === 1 && removed[0].name === account.upload.path)),
    'storage_removed_file');
  const deleted = result(await uploadRpc(account.client, FINALIZE_UPLOAD_DELETE, account), 'upload_finalize');
  checkUploadRow(deleted, account, 'deleted', 'upload_deleted_identity');
  account.upload.finalized = true;
}

async function checkUploadDeletion(requestApi, account, other, userClient) {
  const pending = result(await uploadRpc(account.client, REQUEST_UPLOAD_DELETE, account), 'upload_delete_request');
  checkUploadRow(pending, account, 'deletion_requested', 'upload_delete_requested_identity');
  await checkUnavailableUpload(requestApi, account, account.accessToken, 'upload_content_deletion_requested');
  const premature = await uploadRpc(account.client, FINALIZE_UPLOAD_DELETE, account);
  check(premature.error?.code === '55000', 'upload_cannot_finalize_with_object');

  const foreignRequest = await uploadRpc(other.client, REQUEST_UPLOAD_DELETE, account);
  check(foreignRequest.error?.code === 'P0002', 'upload_foreign_delete_request_denied');
  const foreignDelete = await other.client.storage.from(UPLOAD_BUCKET).remove([account.upload.path]);
  check(deniedByStorage(foreignDelete.error) || (!foreignDelete.error && foreignDelete.data?.length === 0),
    'storage_foreign_delete_denied');

  await removeAndFinalizeUpload(account, true);
  const metadata = result(await account.client.from(UPLOAD_TABLE).select('id')
    .eq('analysis_id', account.analysisId).eq('id', account.upload.id), 'upload_after_delete_read');
  check(metadata?.length === 0, 'upload_deleted_row_hidden');
  await checkUnavailableUpload(requestApi, account, account.accessToken, 'upload_content_finalized');
  const reopened = userClient();
  const newSession = await login(account, reopened);
  await checkUnavailableUpload(requestApi, account, newSession.access_token, 'upload_content_deleted_relogin');

  // 새 주소로 Storage 원본 조회도 수행해 이전 응답 캐시의 영향을 피한다.
  const gone = await reopened.storage.from(UPLOAD_BUCKET).download(account.upload.path, { cacheNonce: randomUUID() });
  const { status, statusCode, code } = gone.error ?? {};
  check(status === 404 || (status === 400 && [statusCode, code].some(value => ['404', 'NoSuchKey'].includes(String(value)))),
    'storage_deleted_fresh_not_found');
}

async function cleanUpUpload(account) {
  if (!account.upload || account.upload.finalized) return;
  const reply = await uploadRpc(account.client, REQUEST_UPLOAD_DELETE, account);
  if (reply.error?.code === 'P0002' && !account.upload.writeAttempted) return;
  const row = result(reply, 'upload_cleanup_request');
  if (row?.status === 'deleted') {
    checkUploadRow(row, account, 'deleted', 'upload_cleanup_identity');
    return;
  }
  checkUploadRow(row, account, 'deletion_requested', 'upload_cleanup_identity');
  await removeAndFinalizeUpload(account, false);
}

async function deleteAccount(admin, account, runId) {
  // 생성 응답이 끊긴 경우도 미리 지정한 ID로 찾되 이 실행의 표식을 확인한 뒤 삭제한다.
  const lookup = await admin.auth.admin.getUserById(account.id);
  if (lookup.error?.status === 404) return;
  const { user } = result(lookup, 'auth_cleanup_lookup');
  check(user?.id === account.id && user.email === account.email && user.app_metadata?.[ACCOUNT_TAG] === runId,
    'auth_cleanup_ownership');
  result(await admin.auth.admin.deleteUser(account.id), 'auth_cleanup_delete');
  const gone = await admin.auth.admin.getUserById(account.id);
  check(gone.error?.status === 404, 'auth_cleanup_verify');
}

async function retryCleanup(cleanUp, failures) {
  try {
    await cleanUp();
  } catch {
    // 삭제 응답이 유실되어도 같은 ID와 상태를 다시 확인해 마무리한다.
    try {
      await cleanUp();
    } catch (error) {
      failures.push(failureStep(error));
    }
  }
}

async function run(config, capture, requestApi, apiPort) {
  const admin = makeClient(config.origin, config.service);
  const userClient = () => makeClient(config.origin, config.publishable);
  const runId = randomUUID();
  const captureKey = randomUUID();
  const accounts = [];
  const failed = [];
  let be04Started = false;
  try {
    const noSession = await requestApi(ME_ROUTE);
    check(noSession.status === 401, 'me_unauthenticated');
    await noSession.body?.cancel();
    for (let index = 0; index < 2; index++) {
      const account = makeAccount();
      accounts.push(account);
      await createAccount(admin, account, runId);
      account.client = userClient();
      const initial = await login(account, account.client);
      const session = await refreshAndVerify(account, initial);
      await seedAccount(account);
      await checkMe(requestApi, account, session);
    }
    await saveSnapshot(admin, accounts[0], capture, captureKey, params => storeWithPython(config, params));
    await saveSnapshot(admin, accounts[1], capture, captureKey, params => storeConcurrently(admin, params));
    const pairs = [[accounts[0], accounts[1]], [accounts[1], accounts[0]]];
    for (const [account, other] of pairs) {
      const reopened = userClient();
      const session = await login(account, reopened);
      await checkMe(requestApi, account, session);
      await checkVisibility('user_profiles', 'user_id', account.id, other.id, reopened);
      await checkVisibility('chats', 'id', account.chatId, other.chatId, reopened);
      await checkVisibility('analyses', 'id', account.analysisId, other.analysisId, reopened);
      await checkVisibility(SNAPSHOT_TABLE, 'id', account.snapshotId, other.snapshotId, reopened);
      const row = await reopenSnapshot(account, capture, reopened);
      await checkSnapshotViews(account, other, row, reopened);
      account.client = reopened;
      account.accessToken = session.access_token;
      await registerUpload(account);
    }
    if (process.env.BE07_EPHEMERAL_SEARCH_FIXTURE === '1') {
      await checkNoticeSearch({ config, accounts, admin, requestApi, check, result });
      await checkLegalEvidence({ config, accounts, admin, capture, requestApi, check, result });
    }
    await checkFundingPlan({ accounts, admin, capture, requestApi, check, result });
    const pdf = makeSyntheticPdf();
    for (const [account, other] of pairs) {
      await checkVisibility(UPLOAD_TABLE, 'id', account.upload.id, other.upload.id, account.client);
      await checkStorageIsolation(requestApi, account, other, pdf, config.publishable);
    }
    const testedUpload = accounts[0];
    check(await documentWorkerDigest(testedUpload, testedUpload.accessToken, apiPort) ===
      createHash('sha256').update(pdf).digest('hex'), 'document_worker_own_pdf');
    check(await documentWorkerDigest(testedUpload, accounts[1].accessToken, apiPort) === 'unavailable',
      'document_worker_foreign_pdf');
    for (const [account, other] of pairs) {
      await checkUploadDeletion(requestApi, account, other, userClient);
    }
    check(await documentWorkerDigest(testedUpload, testedUpload.accessToken, apiPort) === 'unavailable',
      'document_worker_deleted_pdf');
    be04Started = true;
    const secondWorker = makeClient(config.origin, config.service);
    const savedComparison = await runBe04Smoke({ requestApi, admin, secondWorker, accounts, capture, config, check, result });
    // 새 기기처럼 로그인한 뒤 분석 목록만으로 마지막 실행과 저장한 수집본을 다시 찾는다.
    const [peer, owner] = accounts;
    const reopened = userClient();
    const session = await login(owner, reopened);
    const visible = result(await reopened.from('analyses').select('id,latest_run_id,status')
      .in('id', [peer.analysisId, owner.analysisId]), 'be04_reopen_analyses');
    check(visible.length === 1 && visible[0].id === owner.analysisId && visible[0].status === 'input_ready'
      && typeof visible[0].latest_run_id === 'string', 'be04_reopen_latest_run');
    const resumed = await requestApi(`/api/v1/analyses/${owner.analysisId}/runs/${visible[0].latest_run_id}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    check(resumed.status === 200, 'be04_reopen_run_status');
    const operation = await resumed.json();
    check(operation.runId === visible[0].latest_run_id && operation.status === 'finished'
      && operation.snapshotId === owner.snapshotId, 'be04_reopen_run_capture');
    const restored = await requestApi(`/api/v1/analyses/${owner.analysisId}/runs/${operation.runId}/result`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    check(restored.status === 200 && isDeepStrictEqual(await restored.json(), savedComparison),
      'be05_reopen_saved_comparison');
  } catch (error) {
    const step = failureStep(error);
    failed.push(be04Started && step === 'unexpected_failure' ? 'be04_unexpected_failure' : step);
  } finally {
    for (const account of accounts) {
      await retryCleanup(() => cleanUpUpload(account), failed);
      await retryCleanup(() => deleteAccount(admin, account, runId), failed);
    }
    if (be04Started) await retryCleanup(() => checkBe04Cleanup(admin, accounts, check, result), failed);
  }
  return failed;
}

function restrictFetch(fetcher, allowedOrigin) {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    check(url.origin === allowedOrigin, 'unexpected_request_target');
    const timeout = AbortSignal.timeout(10_000);
    const signal = init?.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
    return fetcher(input, { ...init, signal, redirect: 'error' });
  };
}

async function main() {
  const config = readConfig(process.env);
  const capture = loadCapture();
  const fetchForSmoke = globalThis.fetch;
  // 사용자 HTTP 요청만 로컬 포트로 보낸다. 서버의 외부 요청은 승인된 개발 DB로 제한한다.
  globalThis.fetch = restrictFetch(fetchForSmoke, config.origin);
  // SDK 자체 진단에는 외부 본문이 실릴 수 있으므로 CLI는 정해진 검사명만 출력한다.
  console.warn = console.error = () => {};
  const server = createDevServer(createHandler({
    env: { APP_ENV: 'development', SUPABASE_URL: config.origin, SUPABASE_PUBLISHABLE_KEY: config.publishable },
    createBackend,
    log: () => {},
  }));
  try {
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    check(address && typeof address === 'object', 'http_listen');
    const apiOrigin = `http://127.0.0.1:${address.port}`;
    const apiFetch = restrictFetch(fetchForSmoke, apiOrigin);
    return await run(config, capture, (path, init) => apiFetch(new URL(path, apiOrigin), init), address.port);
  } finally {
    if (server.listening) {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
  }
}

let failures;
try {
  failures = await main();
} catch (error) {
  failures = [failureStep(error)];
}
if (failures.length) {
  for (const step of failures) {
    const stage = step.startsWith('be08_') ? 'BE-08' : step.startsWith('be07_') ? 'BE-07' : step.startsWith('be05_') ? 'BE-05' : step.startsWith('be04_') ? 'BE-04' : 'BE-03';
    process.stderr.write(`${stage} smoke failed (${step})\n`);
  }
  process.exitCode = 1;
} else {
  if (process.env.BE07_EPHEMERAL_SEARCH_FIXTURE === '1') {
    process.stdout.write('BE-07 smoke passed (two-user search, publication, budget, incomplete rooms, source revocation)\n');
  }
  process.stdout.write('BE-03 smoke passed (Auth, /api/v1/me, RLS, capture, upload content API, Storage, cleanup)\n');
  process.stdout.write('BE-04 smoke passed (run API, RLS, scoped worker, claim and cancel races, recovery, cleanup)\n');
  process.stdout.write('BE-05 smoke passed (comparison, evidence holds, snapshot replay, two-user isolation, new session)\n');
  process.stdout.write('BE-08 smoke passed (funding inputs, saved schedule, two-user isolation, recalculation)\n');
}
