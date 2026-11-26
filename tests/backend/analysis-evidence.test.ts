// 합성 세션과 저장 수집본 응답으로 비교 근거 상세(/evidence) 직렬화와 권한 경계를 검사한다.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createHandler } from '../../src/server/handler.js';
import { createBackend } from '../../src/server/supabase.js';
import {
  buildComparisonEvidenceDetail,
  parseComparisonSnapshot,
  shortenDocumentVersion,
} from '../../src/server/analysis-runs.js';

const env = {
  SUPABASE_URL: 'https://synthetic.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC_NOT_A_REAL_KEY',
  APP_ENV: 'preview',
  ALLOWED_ORIGINS: 'https://frontend.invalid',
};

const analysisId = 'd1100000-0000-4000-8000-000000000001';
const runId = 'd1100000-0000-4000-8000-000000000002';
const snapshotId = 'd1100000-0000-4000-8000-000000000003';
const userId = 'd1100000-0000-4000-8000-000000000004';
const registeredUploadId = 'd1100000-0000-4000-8000-000000000011';
const deletedUploadId = 'd1100000-0000-4000-8000-000000000012';
const missingUploadId = 'd1100000-0000-4000-8000-000000000013';
const evidencePath = `/api/v1/analyses/${analysisId}/runs/${runId}/evidence`;
const auth = { Authorization: 'Bearer SYNTHETIC_TEST_TOKEN', Origin: env.ALLOWED_ORIGINS };

const officialSha = 'sha256:97987f527a961051724f6561aca34451e3131a23ae9e11a0c65ee53ddee1d98e';
const uploadSha = 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

function req(path: string, init: RequestInit = {}) {
  return new Request(`https://api.invalid${path}`, init);
}

async function loadSyntheticComparison() {
  return JSON.parse(
    await readFile(new URL('../../public/app/assets/comparison-example.json', import.meta.url), 'utf8'),
  );
}

function makeCollectedSnapshot(baseComparison: Record<string, unknown>) {
  const result = structuredClone(baseComparison) as Record<string, unknown>;
  result.dataOrigin = 'collected';
  const target = result.target as Record<string, unknown>;
  target.houseManageNo = '2026000123';
  target.noticeNo = '2026000456';
  target.edition = '2026-10-15';
  (target.supplyArea as Record<string, unknown>).evidence = [
    { document: 'applyhome:2026000123:2026000456:1001:1', version: officialSha, page: 4 },
  ];
  const rooms = (result.noticePrice as Record<string, unknown>).confirmedRooms as Array<Record<string, unknown>>;
  rooms[0]!.evidence = {
    salePrice: [{ document: `upload:${registeredUploadId}`, version: uploadSha, page: 7 }],
    requiredOptions: [{ document: `upload:${deletedUploadId}`, version: 'upload-del-v1', page: 8 }],
  };
  return {
    analysisId,
    runId,
    snapshotId,
    rulesVersion: 'comparison-rules/v1',
    result,
  };
}

function makeCollectedInputSnapshot() {
  return {
    id: snapshotId,
    analysis_id: analysisId,
    data_origin: 'collected',
    result_snapshot: {
      catalog: {
        notice: {
          link: {
            status: 'reported',
            kind: 'notice_page',
            value: 'https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?houseManageNo=2026000123&pblancNo=2026000456',
          },
        },
        documents: [
          {
            id: 'applyhome:2026000123:2026000456:1001:1',
            version: officialSha,
            source: 'official',
            originCheck: 'confirmed',
            status: 'accepted',
            reasons: [],
            houseManageNo: '2026000123',
            noticeNo: '2026000456',
            edition: '2026-10-15',
            rawInternalUrl: 'https://evil.invalid/should-not-leak',
          },
          {
            id: `upload:${registeredUploadId}`,
            version: uploadSha,
            source: 'upload',
            originCheck: 'confirmed',
            status: 'accepted',
            reasons: [],
            houseManageNo: '2026000123',
            noticeNo: '2026000456',
            edition: '2026-10-15',
          },
          {
            id: `upload:${deletedUploadId}`,
            version: 'upload-del-v1',
            source: 'upload',
            originCheck: 'confirmed',
            status: 'accepted',
            reasons: [],
            houseManageNo: '2026000123',
            noticeNo: '2026000456',
            edition: '2026-10-15',
          },
          {
            id: `upload:${missingUploadId}`,
            version: 'upload-rejected-v1',
            source: 'upload',
            originCheck: 'conflict',
            status: 'rejected',
            reasons: ['different_notice_round'],
            houseManageNo: '2026000123',
            noticeNo: '2026000999',
            edition: '2025-01-01',
          },
        ],
      },
      tradeBatches: [
        {
          record: { recordId: 'col-apt_trade-99999-202610', source: 'apt_trade' },
          trades: [
            {
              tradeKind: 'sale',
              provenance: { page: 1, position: 1 },
              contractDate: { status: 'parsed', date: '2026-10-20' },
              amount: { status: 'parsed', won: '515000000' },
              exclusiveArea: { status: 'parsed', m2: '84.00' },
              attributes: { floor: '7', buildYear: '2016', dealingGbn: '중개거래', rawSecret: 'DO_NOT_LEAK' },
              cancellation: { status: 'not_marked', cdealDay: { state: 'blank', value: null } },
              identifiers: {
                aptNm: '합성 비교 A',
                aptSeq: '99999-100',
                sggCd: '99999',
                umdCd: '00100',
                umdNm: '가람동',
                jibun: '100',
                roadNm: '합성로',
                roadNmBonbun: '00010',
                roadNmBubun: '00002',
                disallowedInternalField: 'MUST_DROP',
              },
            },
            {
              tradeKind: 'sale',
              provenance: { page: 1, position: 2 },
              contractDate: { status: 'parsed', date: '2026-10-21' },
              amount: { status: 'parsed', won: '515000000' },
              exclusiveArea: { status: 'parsed', m2: '84.00' },
              attributes: { floor: '8' },
              cancellation: { status: 'cancelled', cdealDay: { state: 'date', value: '26.10.29' } },
              identifiers: { aptNm: '합성 비교 A', aptSeq: '99999-100', sggCd: '99999', umdNm: '가람동', jibun: '100' },
            },
            {
              tradeKind: 'sale',
              provenance: { page: 99, position: 99 },
              contractDate: { status: 'parsed', date: '2026-10-15' },
              amount: { status: 'parsed', won: '999000000' },
              exclusiveArea: { status: 'parsed', m2: '99.00' },
              attributes: { floor: '1' },
              cancellation: { status: 'not_marked' },
              identifiers: { aptNm: '미참조 단지', sggCd: '99999' },
            },
          ],
        },
      ],
    },
  };
}

function mockSupabase(
  t: TestContext,
  handlers: {
    rpc: () => Response;
    snapshot?: () => Response;
    uploads?: () => Response;
  },
) {
  const calls: Array<{ path: string; method: string }> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const upstream = new Request(input, init);
    const url = new URL(upstream.url);
    assert.equal(url.origin, env.SUPABASE_URL);
    assert.equal(upstream.headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(upstream.headers.get('authorization'), auth.Authorization);
    if (url.pathname === '/auth/v1/user') return Response.json({ id: userId });
    calls.push({ path: url.pathname, method: upstream.method });
    if (url.pathname === '/rest/v1/rpc/get_analysis_comparison') return handlers.rpc();
    if (url.pathname === '/rest/v1/analysis_input_snapshots') {
      assert.ok(handlers.snapshot, 'unexpected snapshot read');
      return handlers.snapshot();
    }
    if (url.pathname === '/rest/v1/analysis_uploads') {
      assert.ok(handlers.uploads, 'unexpected uploads read');
      return handlers.uploads();
    }
    throw new Error(`unexpected upstream path: ${url.pathname}`);
  });
  return calls;
}

test('GET /evidence serializes official ApplyHome links, own upload /content paths, and only referenced trade identifiers', async (t) => {
  const base = await loadSyntheticComparison();
  const saved = makeCollectedSnapshot(base);
  const inputSnap = makeCollectedInputSnapshot();
  const calls = mockSupabase(t, {
    rpc: () => Response.json(saved),
    snapshot: () => Response.json(inputSnap),
    uploads: () =>
      Response.json([
        { id: registeredUploadId, status: 'registered' },
        { id: deletedUploadId, status: 'deleted' },
      ]),
  });

  const handle = createHandler({ env, createBackend, log: () => {} });
  const res = await handle(req(evidencePath, { headers: auth }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');

  const body = await res.json();
  assert.equal(body.contractVersion, 'comparison-evidence-detail/v1');
  assert.equal(body.analysisId, analysisId);
  assert.equal(body.runId, runId);
  assert.equal(body.snapshotId, snapshotId);
  assert.equal(body.dataOrigin, 'collected');
  assert.equal(
    body.noticeLink,
    'https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?houseManageNo=2026000123&pblancNo=2026000456',
  );

  // 공식 PDF는 공식 출처 URL만 연결하고 재호스팅 경로를 만들지 않는다.
  const official = body.documents.find((d: { id: string }) => d.id.startsWith('applyhome:'));
  assert.ok(official);
  assert.equal(official.versionShort, 'sha256:97987f527a96…');
  assert.equal(
    official.officialUrl,
    'https://static.applyhome.co.kr/ai/aia/getAtchmnfl.do?houseManageNo=2026000123&pblancNo=2026000456&atchmnflSeqNo=1001&atchmnflSn=1',
  );
  assert.equal(official.uploadContentPath, null);
  assert.equal('rawInternalUrl' in official, false);

  // 등록된 본인 업로드만 /content 다운로드 경로를 제공한다.
  const regUpload = body.documents.find((d: { id: string }) => d.id === `upload:${registeredUploadId}`);
  assert.equal(regUpload.uploadId, registeredUploadId);
  assert.equal(regUpload.uploadStatus, 'registered');
  assert.equal(regUpload.uploadContentPath, `/api/v1/analyses/${analysisId}/uploads/${registeredUploadId}/content`);
  assert.equal(regUpload.officialUrl, null);

  // 삭제된 업로드와 미등록(반려) 업로드는 다운로드 경로를 제공하지 않는다.
  const delUpload = body.documents.find((d: { id: string }) => d.id === `upload:${deletedUploadId}`);
  assert.equal(delUpload.uploadStatus, 'deleted');
  assert.equal(delUpload.uploadContentPath, null);

  const rejUpload = body.documents.find((d: { id: string }) => d.id === `upload:${missingUploadId}`);
  assert.equal(rejUpload.status, 'rejected');
  assert.equal(rejUpload.uploadStatus, 'unavailable');
  assert.equal(rejUpload.uploadContentPath, null);
  assert.deepEqual(rejUpload.reasons, ['different_notice_round']);

  // 비교 결과(포함·제외)에 참조된 거래만 허용 필드(식별 근거)로 직렬화하고 미참조 거래와 내부 필드는 제외한다.
  assert.equal(body.tradeObservations.length, 2);
  const includedObs = body.tradeObservations.find((o: { position: number }) => o.position === 1);
  assert.equal(includedObs.identifiers.aptSeq, '99999-100');
  assert.equal(includedObs.identifiers.roadNm, '합성로');
  assert.equal('disallowedInternalField' in includedObs.identifiers, false);
  assert.equal('rawSecret' in includedObs, false);

  const cancelledObs = body.tradeObservations.find((o: { position: number }) => o.position === 2);
  assert.equal(cancelledObs.cancellationStatus, 'cancelled');
  assert.equal(cancelledObs.cancellationDate, '26.10.29');

  assert.deepEqual(
    calls.map((c) => c.path),
    ['/rest/v1/rpc/get_analysis_comparison', '/rest/v1/analysis_input_snapshots', '/rest/v1/analysis_uploads'],
  );
});

test('GET /evidence enforces comparison_sources_permitted (403), ownership (404), and availability (409) BEFORE reading snapshots', async (t) => {
  const cases = [
    { code: 'PT403', status: 403, error: 'comparison_source_restricted' },
    { code: 'PT404', status: 404, error: 'run_not_found' },
    { code: 'PT409', status: 409, error: 'comparison_not_available' },
  ];
  for (const item of cases) {
    const calls = mockSupabase(t, {
      rpc: () => Response.json({ code: item.code, message: 'SYNTHETIC_INTERNAL' }, { status: item.status }),
      // snapshot & uploads 핸들러가 없음 -> RPC 실패 시 테이블을 절대 읽지 않아야 한다.
    });
    const handle = createHandler({ env, createBackend, log: () => {} });
    const res = await handle(req(evidencePath, { headers: auth }));
    assert.equal(res.status, item.status);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal((await res.json()).error, item.error);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.path, '/rest/v1/rpc/get_analysis_comparison');
  }
});

test('GET /evidence validates authentication, origin, HTTP method, UUID, and rejects query params', async () => {
  const handle = createHandler({ env, createBackend, log: () => {} });
  // 미인증 401
  assert.equal((await handle(req(evidencePath, { headers: { Origin: env.ALLOWED_ORIGINS } }))).status, 401);
  // 허용되지 않은 Origin 403
  assert.equal(
    (await handle(req(evidencePath, { headers: { Authorization: auth.Authorization, Origin: 'https://other.invalid' } })))
      .status,
    403,
  );
  // POST 405
  const postRes = await handle(req(evidencePath, { method: 'POST', headers: auth }));
  assert.equal(postRes.status, 405);
  assert.equal(postRes.headers.get('allow'), 'GET, OPTIONS');
  // 쿼리 파라미터 400
  const queryRes = await handle(req(evidencePath + '?extra=1', { headers: auth }));
  assert.equal(queryRes.status, 400);
  assert.equal((await queryRes.json()).error, 'invalid_run_input');
  // 잘못된 UUID 400
  const badUuidRes = await handle(req('/api/v1/analyses/not-a-uuid/runs/' + runId + '/evidence', { headers: auth }));
  assert.equal(badUuidRes.status, 400);
  assert.equal((await badUuidRes.json()).error, 'invalid_run_input');
});

test('buildComparisonEvidenceDetail never emits external URLs for synthetic runs or untrusted hosts and fails closed on snapshot mismatch', async () => {
  const base = await loadSyntheticComparison();
  const parsed = parseComparisonSnapshot(
    { analysisId, runId, snapshotId, rulesVersion: 'comparison-rules/v1', result: base },
    analysisId,
    runId,
  );
  assert.ok(parsed);

  // 합성 수집본에는 공식 URL이 부여되지 않는다.
  const syntheticDetail = buildComparisonEvidenceDetail(
    parsed,
    {
      id: snapshotId,
      analysis_id: analysisId,
      data_origin: 'synthetic',
      result_snapshot: {
        catalog: {
          notice: {
            link: {
              status: 'reported',
              kind: 'notice_page',
              value: 'https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?houseManageNo=9900000001&pblancNo=9900000042',
            },
          },
          documents: [
            {
              id: 'applyhome:9900000001:9900000042:1:1',
              version: officialSha,
              source: 'official',
              originCheck: 'confirmed',
              status: 'accepted',
              reasons: [],
            },
          ],
        },
        tradeBatches: [],
      },
    },
    [],
  );
  assert.ok(syntheticDetail);
  assert.equal(syntheticDetail.noticeLink, null);
  assert.equal(syntheticDetail.documents[0]!.officialUrl, null);

  // 스냅샷 ID/분석 ID/data_origin 불일치 시 null 반환(503 fail-closed).
  const mismatch = buildComparisonEvidenceDetail(
    parsed,
    { id: 'd1100000-0000-4000-8000-000000009999', analysis_id: analysisId, data_origin: 'synthetic', result_snapshot: {} },
    [],
  );
  assert.equal(mismatch, null);

  // 해시 단축 경계 검사
  assert.equal(shortenDocumentVersion(officialSha), 'sha256:97987f527a96…');
  assert.equal(shortenDocumentVersion('synthetic-v1'), 'synthetic-v1');
});
