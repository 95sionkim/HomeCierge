// 업로드 보완 사용자 API 라우트, 인증/CORS/캐시 헤더, 브라우저 해시·채택 필드 거부 및 보고서 출처 표기를 검사한다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createHandler } from '../../src/server/handler.js';
import type { Backend } from '../../src/server/handler.js';
import { ApiError } from '../../src/server/http-input.js';
import { projectSavedReport } from '../../src/server/saved-report.js';
import type {
  UploadSupplementContext,
  UploadSupplementOperation,
  UploadSupplementRun,
} from '../../src/server/upload-supplement.js';

const env = {
  APP_ENV: 'development',
  SUPABASE_URL: 'https://synthetic.supabase.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_TEST_ONLY',
  ALLOWED_ORIGINS: 'https://app.example.invalid',
};

const analysisId = '11111111-1111-4111-8111-111111111111';
const baseRunId = '22222222-2222-4222-8222-222222222222';
const supplementRunId = '33333333-3333-4333-8333-333333333333';
const uploadId = '44444444-4444-4444-8444-444444444444';
const idempotencyKey = '55555555-5555-4555-8555-555555555555';

const sampleContext: UploadSupplementContext = {
  contractVersion: 'upload-supplement-context/v1',
  analysisId,
  runId: baseRunId,
  runStatus: 'finished',
  snapshotId: '66666666-6666-4666-8666-666666666666',
  eligible: true,
  needsSupplement: true,
  target: {
    title: '합성 가람 아파트',
    noticeSource: 'applyhome_apt',
    houseManageNo: '9900000001',
    noticeNo: '9900000042',
    edition: '2026-10-05',
    modelNo: '01',
    houseType: '084.0000A',
    room: '101동 101호',
  },
  reasonCodes: ['attachment_not_found', 'target_supply_area_unverified'],
  documents: [],
  issues: [{ code: 'attachment_not_found', stage: 'document_acquisition', modelNo: null, houseType: null, room: null, item: null }],
  currentSupplement: null,
  recentSupplements: [],
  uploadRules: {
    bucket: 'analysis-uploads',
    accept: 'application/pdf',
    maxBytes: 50 * 1024 * 1024,
    sameNoticeRequired: true,
  },
};

const sampleRun: UploadSupplementRun = {
  contractVersion: 'upload-supplement-run/v1',
  runId: supplementRunId,
  analysisId,
  baseRunId,
  uploadId,
  status: 'queued',
  attempt: 0,
  submittedAt: '2026-11-26T01:00:00Z',
  finishedAt: null,
  snapshotId: null,
  errorCode: null,
  input: {
    kind: 'upload_supplement',
    baseRunId,
    uploadId,
    noticeSource: 'applyhome_apt',
    houseManageNo: '9900000001',
    noticeNo: '9900000042',
    edition: '2026-10-05',
    modelNo: '01',
  },
  documents: [],
  issues: [],
};

function makeHandler(overrides: Partial<Backend> = {}) {
  const calls: UploadSupplementOperation[] = [];
  const backend: Backend = {
    getUser: async () => ({ id: '99999999-9999-4999-8999-999999999999', isAnonymous: false }),
    getProfile: async () => null,
    getUploadContent: async () => null,
    runAnalysis: async (op) => {
      if (op.action === 'get' && op.runId === supplementRunId) {
        return {
          runId: supplementRunId,
          analysisId,
          status: 'queued',
          attempt: 0,
          submittedAt: sampleRun.submittedAt,
          finishedAt: null,
          input: sampleRun.input,
          snapshotId: null,
          errorCode: null,
        };
      }
      throw new ApiError('run_not_found');
    },
    getNoticeSearchIndex: async () => null,
    getFundingInputs: async () => ({}),
    getLegalEvidence: async () => ({}),
    prepareCommute: async () => ({}),
    prepareRegionalNews: async () => ({}),
    getComparison: async () => { throw new ApiError('comparison_not_available'); },
    getComparisonEvidence: async () => { throw new ApiError('comparison_not_available'); },
    analysisConversation: async () => ({}),
    savedReport: async () => ({}),
    dataDeletion: async () => ({}),
    uploadSupplement: async (op) => {
      calls.push(op);
      if (op.action === 'context') return sampleContext;
      return sampleRun;
    },
    ...overrides,
  };
  return {
    calls,
    handler: createHandler({ env, createBackend: () => backend, log: () => {} }),
  };
}

test('GET context, POST enqueue (202 + Location) and GET supplement status keep private no-store cache headers', async () => {
  const { handler, calls } = makeHandler();
  const baseUrl = `https://api.example.invalid/api/v1/analyses/${analysisId}/runs/${baseRunId}/upload-supplement`;
  const runUrl = `https://api.example.invalid/api/v1/analyses/${analysisId}/upload-supplements/${supplementRunId}`;
  const auth = { Authorization: 'Bearer synthetic-user-jwt', Origin: 'https://app.example.invalid' };

  const ctxRes = await handler(new Request(baseUrl, { method: 'GET', headers: auth }));
  assert.equal(ctxRes.status, 200);
  assert.equal(ctxRes.headers.get('cache-control'), 'private, no-store');
  assert.equal(ctxRes.headers.get('vercel-cdn-cache-control'), 'no-store');
  assert.equal(ctxRes.headers.get('vary'), 'Authorization, Origin');
  assert.deepEqual(await ctxRes.json(), sampleContext);

  const postRes = await handler(new Request(baseUrl, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ uploadId }),
  }));
  assert.equal(postRes.status, 202);
  assert.equal(postRes.headers.get('location'), `/api/v1/analyses/${analysisId}/upload-supplements/${supplementRunId}`);
  assert.equal(postRes.headers.get('cache-control'), 'private, no-store');
  assert.equal(postRes.headers.get('access-control-expose-headers'), 'Location');
  assert.deepEqual(await postRes.json(), sampleRun);

  const statusRes = await handler(new Request(runUrl, { method: 'GET', headers: auth }));
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await statusRes.json(), sampleRun);

  assert.deepEqual(calls, [
    { action: 'context', analysisId, runId: baseRunId },
    { action: 'enqueue', analysisId, baseRunId, uploadId, idempotencyKey },
    { action: 'get', analysisId, runId: supplementRunId },
  ]);
});

test('POST rejects browser-supplied hashes, adoption flags, missing idempotency key, wrong media type and anonymous auth', async () => {
  const { handler, calls } = makeHandler();
  const baseUrl = `https://api.example.invalid/api/v1/analyses/${analysisId}/runs/${baseRunId}/upload-supplement`;
  const auth = { Authorization: 'Bearer synthetic-user-jwt' };

  // 브라우저가 보낸 해시·채택 상태·공고 판정 필드는 즉시 400 거부(백엔드 미호출)
  for (const body of [
    { uploadId, sha256: 'a'.repeat(64) },
    { uploadId, originCheck: 'confirmed' },
    { uploadId, adoption: 'standalone' },
    { uploadId, status: 'accepted' },
    { uploadId: 'not-a-uuid' },
    {},
  ]) {
    const res = await handler(new Request(baseUrl, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_upload_supplement_input');
  }

  // Idempotency-Key 누락
  const noKey = await handler(new Request(baseUrl, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  }));
  assert.equal(noKey.status, 400);

  // 미인증 401
  const unauth = await handler(new Request(baseUrl, { method: 'GET' }));
  assert.equal(unauth.status, 401);

  // DELETE 메서드 405
  const wrongMethod = await handler(new Request(baseUrl, { method: 'DELETE', headers: auth }));
  assert.equal(wrongMethod.status, 405);

  // 일반 /runs enqueue 경로로는 upload_supplement 직접 접수 불가
  const directEnqueue = await handler(new Request(
    `https://api.example.invalid/api/v1/analyses/${analysisId}/runs`,
    {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ input: sampleRun.input }),
    },
  ));
  assert.equal(directEnqueue.status, 400);
  assert.equal(calls.length, 0);
});

test('error mapping preserves 404 for foreign accounts, 409 conflicts and 429 Retry-After', async () => {
  const baseUrl = `https://api.example.invalid/api/v1/analyses/${analysisId}/runs/${baseRunId}/upload-supplement`;
  const auth = { Authorization: 'Bearer synthetic-user-jwt', 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey };

  for (const [code, expectedStatus] of [
    ['run_not_found', 404],
    ['upload_not_found', 404],
    ['upload_file_missing', 409],
    ['upload_not_available', 409],
    ['upload_supplement_conflict', 409],
    ['run_rate_limited', 429],
  ] as const) {
    const { handler } = makeHandler({
      uploadSupplement: async () => { throw new ApiError(code); },
    });
    const res = await handler(new Request(baseUrl, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ uploadId }),
    }));
    assert.equal(res.status, expectedStatus);
    assert.equal((await res.json()).error, code);
    if (expectedStatus === 429) {
      assert.equal(res.headers.get('retry-after'), '60');
    }
  }
});

test('saved report projection formats upload document provenance distinctly from official notices', () => {
  const docId = `upload:${uploadId}`;
  const version = `sha256:${'b'.repeat(64)}`;
  const raw = {
    contractVersion: 'report-snapshot/v1',
    reportId: randomUUID(),
    analysisId,
    runId: supplementRunId,
    snapshotId: '66666666-6666-4666-8666-666666666666',
    version: 1,
    createdAt: '2026-11-26T01:00:00Z',
    queriedAt: '2026-11-26T00:55:00Z',
    rulesVersion: 'v0',
    dataOrigin: 'collected',
    sections: {
      comparison: {
        status: 'available',
        exportAllowed: true,
        sources: ['applyhome_apt', 'applyhome_apt_model'],
        identity: { title: '합성 가람 아파트', houseManageNo: '9900000001', noticeNo: '9900000042', edition: '2026-10-05' },
        value: {
          contractVersion: 'comparison/v1',
          dataOrigin: 'collected',
          completeness: 'partial',
          appliedScope: null,
          rankingComplete: false,
          target: {
            name: '합성 가람 아파트',
            houseManageNo: '9900000001',
            noticeNo: '9900000042',
            edition: '2026-10-05',
            modelNo: '01',
            houseType: '084.0000A',
            supplyArea: {
              status: 'confirmed',
              m2: '112.40',
              evidence: [{ document: docId, version, page: 1 }],
            },
          },
          conditions: {
            asOf: '2026-11-10',
            period: { status: 'confirmed', start: '2025-11-11', end: '2026-11-10' },
            area: { basis: 'supply', minM2: '106.78', maxM2: '118.02', tolerancePercent: '5' },
            tradeKinds: ['sale'],
          },
          noticePrice: {
            status: 'confirmed',
            scope: 'selected_room',
            room: '101동 101호',
            basis: 'sale_price_plus_required_options',
            won: '710000000',
            confirmedRooms: [{
              room: '101동 101호',
              salePriceWon: '700000000',
              requiredOptionsWon: '10000000',
              subtotalWon: '710000000',
              evidence: {
                salePrice: [{ document: docId, version, page: 2 }],
                requiredOptions: [{ document: docId, version, page: 3 }],
              },
            }],
            heldRooms: [],
          },
          regionDecision: { priority: null, expansion: null },
          tradeKinds: {},
          collections: [],
          comparables: [],
          targetReferences: [],
          holds: [],
          exclusions: [],
        },
      },
      funding: { status: 'room_unselected', exportAllowed: true, sources: [], value: null },
      law: { status: 'source_restricted', exportAllowed: false, sources: [], value: null },
    },
  };

  const report = projectSavedReport(raw);
  const evidence = report.sections.find(s => s.id === 'evidence');
  assert.ok(evidence);
  const uploadRows = evidence.rows.filter(r => r.label === '사용자 업로드 근거');
  assert.equal(uploadRows.length, 3);
  assert.equal(uploadRows[0].value, `사용자 업로드 · ${uploadId} · ${version} · 1쪽`);
  assert.equal(evidence.rows.some(r => r.label === '공고문 판본·쪽'), false);
});
