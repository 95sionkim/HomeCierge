// 실제 로그인한 두 임시 계정과 합성 과천 갈현동 픽스처로 자동 비교 근거(공유 캐시 RPC 권한·읽기·쓰기·만료 정리,
// finish_notice_with_evidence 원자 저장, 같은 수집본 재계산의 근거 재사용)를 검수한다.
// 외부 API(청약홈·실거래·카카오)는 호출하지 않는다.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  UUID,
  checkNoStore,
  checkRpcError,
  checkServiceOnlyDenied,
  cleanUpScopedUploads,
  expectJson,
  registerScopedUpload,
  requestJson,
  runPythonJson,
  withLoopbackSources,
} from './smoke_helpers.mjs';

const REGION_CODE = '91290';
const TARGET = { houseManageNo: '9129000001', noticeNo: '9129000001', edition: '2026-09-25' };
const MODEL_NO = '01';
const ROOM = '101동 101호';

const LOOPBACK_SOURCES = [
  ...['applyhome_apt', 'applyhome_apt_model', 'applyhome_remainder', 'applyhome_remainder_model', 'mois_legal_region_codes', 'apt_trade', 'apt_rights']
    .map(id => ({ id, storage_permission: 'allowed', reuse_permission: 'allowed', display_permission: 'allowed' })),
  { id: 'kakao_address', storage_permission: 'unknown', reuse_permission: 'unknown', display_permission: 'allowed' },
];

async function buildBaseHeldFixture(check) {
  const python = `
import json, sys
from pathlib import Path
sys.path.insert(0, 'scripts')
from compare_trades import compare_snapshot
from replay_ingestion import ingest
from store_ingestion import snapshot_input
from test_auto_evidence import make_synthetic_harness

fixture = json.loads(Path('tests/fixtures/auto-evidence-gwacheon-synthetic.json').read_text(encoding='utf-8'))
api_fetch, _, _, _, _ = make_synthetic_harness(fixture)
req = dict(fixture['request'])
req.pop('start', None)
req.pop('end', None)
cap = ingest(
    req, api_fetch, data_origin='collected',
    review_documents=lambda *_: {'evidence': [], 'issues': [{'code': 'attachment_not_found', 'stage': 'document_acquisition'}]},
)
comp = compare_snapshot(cap, {'modelNo': '01', 'room': '101동 101호'}, None)
print(json.dumps({'request': snapshot_input(req), 'result': cap, 'comparison': comp}, ensure_ascii=False))
`;
  return runPythonJson(python, undefined, check, 'auto_evidence_base_fixture');
}

async function buildAutoEvidenceArtifacts({ kakaoStorage, uploadId, uploadHash }, check) {
  const python = `
import json, sys
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, 'scripts')
from compare_trades import compare_snapshot
from complex_evidence import LegalRegionCatalog, build_comparison_evidence
from replay_ingestion import ingest
from store_ingestion import snapshot_input
from test_auto_evidence import make_synthetic_harness

kakao_storage, upload_id, upload_hash = json.load(sys.stdin)
live_now = lambda: datetime.now(timezone.utc)
fixture = json.loads(Path('tests/fixtures/auto-evidence-gwacheon-synthetic.json').read_text(encoding='utf-8'))
catalog = LegalRegionCatalog.from_mois_tsv_text(fixture['regionTsv'])
api_fetch, kakao_fetch, _, _, _ = make_synthetic_harness(fixture)

req = dict(fixture['request'])
req.pop('start', None)
req.pop('end', None)
spec = fixture['pdfReviewEvidence']
doc_meta = {
    'id': 'upload:' + upload_id,
    'version': 'sha256:' + upload_hash,
    'source': 'upload',
    'originCheck': 'confirmed',
    'status': 'accepted',
    'houseManageNo': req['target']['houseManageNo'],
    'noticeNo': req['target']['noticeNo'],
    'edition': req['target']['edition'],
    'role': 'original',
}
def review_fn(target, current):
    return {
        'documentVersions': [doc_meta],
        'issues': [],
        'evidence': [
            {'document': doc_meta, 'modelNo': spec['modelNo'], 'houseType': spec['houseType'],
             'item': 'supply_area', 'basis': 'supply', 'unit': 'm2', 'm2': spec['supplyAreaM2'], 'check': 'confirmed', 'page': 4},
            {'document': doc_meta, 'modelNo': spec['modelNo'], 'houseType': spec['houseType'], 'room': spec['room'],
             'item': 'sale_price', 'unit': 'won', 'won': spec['salePriceWon'], 'check': 'confirmed', 'page': 4},
            {'document': doc_meta, 'modelNo': spec['modelNo'], 'houseType': spec['houseType'], 'room': spec['room'],
             'item': 'required_options', 'unit': 'won', 'won': spec['requiredOptionsWon'], 'check': 'confirmed', 'page': 5},
        ],
    }

capture = ingest(req, api_fetch, data_origin='collected', review_documents=review_fn)
built = build_comparison_evidence(
    capture, region_catalog=catalog, api_fetch=api_fetch, kakao_fetch=kakao_fetch,
    model_no='01',
    permissions={'applyhomeApt': True, 'applyhomeRemainder': True, 'moisRegions': True,
                 'kakaoRuntime': True, 'kakaoStorage': bool(kakao_storage)},
    now=live_now,
)
# kakaoStorage=False일 때 DB가 카카오 좌표 캐시 저장을 42501로 차단하는지 검증할 합성 좌표 캐시 샘플도 함께 생성한다.
kakao_probe_built = build_comparison_evidence(
    capture, region_catalog=catalog, api_fetch=api_fetch, kakao_fetch=kakao_fetch,
    model_no='01',
    permissions={'applyhomeApt': True, 'applyhomeRemainder': True, 'moisRegions': True,
                 'kakaoRuntime': True, 'kakaoStorage': True},
    now=live_now,
)
kakao_probe = [e for e in kakao_probe_built['newCacheEntries'] if e['cacheKind'] == 'kakao_road_coordinate']
comparison = compare_snapshot(capture, {'modelNo': '01', 'room': '101동 101호'}, built['runtimeEvidence'])
region_record = catalog.to_cache_record('91290', live_now().isoformat())
print(json.dumps({
    'request': snapshot_input(req),
    'result': capture,
    'comparison': comparison,
    'persistedEvidence': built['persistedEvidence'],
    'persistedSources': built['persistedSourceIds'],
    'metadata': built['metadata'],
    'newCacheEntries': built['newCacheEntries'],
    'kakaoCacheProbe': kakao_probe,
    'regionCacheRecord': region_record,
    'schedules': [],
}, ensure_ascii=False))
`;
  return runPythonJson(python, [Boolean(kakaoStorage), uploadId, uploadHash], check, 'auto_evidence_artifacts');
}

async function prepareWorkerComparison(selection, work, check, step) {
  const python = `
import json, sys
sys.path.insert(0, 'scripts')
from run_analysis_worker import prepare_comparison
selection, work = json.load(sys.stdin)
_, _, comparison = prepare_comparison(selection, work)
print(json.dumps(comparison, ensure_ascii=False))
`;
  return runPythonJson(python, [selection, work], check, step);
}

export async function checkAutoEvidence({ config, accounts, admin, requestApi, freshToken, pdf, check, result }) {
  const [owner, peer] = accounts;
  const uploads = [];

  await withLoopbackSources(admin, config.origin, LOOPBACK_SOURCES, check, result, 'auto_evidence', async () => {
    try {
      // 1) 합성 과천 갈현동 기준 수집본(asOf=2026-10-20, PDF 누락)을 저장하고 완료 실행 + 업로드 보완 실행을 임대한다.
      const analysis = result(
        await owner.client.from('analyses').insert({
          user_id: owner.id,
          chat_id: owner.chatId,
          title: '합성과천 갈현타운 대상단지',
          conditions_snapshot: {
            ingestion_target: { noticeSource: 'applyhome_remainder', ...TARGET },
            comparison: { modelNo: MODEL_NO, room: ROOM },
          },
        }).select('id').single(),
        'auto_evidence_analysis',
      );
      const analysisId = analysis.id;

      const baseHeld = await buildBaseHeldFixture(check);
      const baseSnapshotId = result(
        await admin.rpc('save_ingestion_snapshot', {
          p_user_id: owner.id,
          p_analysis_id: analysisId,
          p_capture_key: randomUUID(),
          p_input: baseHeld.request,
          p_result: baseHeld.result,
        }),
        'auto_evidence_base_snapshot',
      );
      const baseRun = await expectJson(
        await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs`, {
          token: owner.accessToken,
          method: 'POST',
          headers: { 'Idempotency-Key': randomUUID() },
          body: { input: { kind: 'snapshot', snapshotId: baseSnapshotId } },
        }),
        202,
        check,
        'auto_evidence_base_enqueue',
      );
      const baseJob = result(
        await admin.rpc('claim_analysis_run', { p_lease_seconds: 120, p_run_id: baseRun.runId }),
        'auto_evidence_base_claim',
      );
      result(
        await admin.rpc('finish_analysis_comparison', {
          p_run_id: baseJob.runId,
          p_generation: baseJob.generation,
          p_lease_token: baseJob.leaseToken,
          p_input: null,
          p_result: null,
          p_comparison: baseHeld.comparison,
        }),
        'auto_evidence_base_finish',
      );

      // upload_supplement 실행은 기준 스냅샷의 asOf('2026-10-20')을 그대로 basis_date로 계승한다.
      const upload = await registerScopedUpload(owner.client, owner.id, analysisId, pdf, check, result, 'auto_evidence_pdf');
      uploads.push(upload);
      const uploadHash = createHash('sha256').update(pdf).digest('hex');

      const supQueued = await expectJson(
        await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs/${baseRun.runId}/upload-supplement`, {
          token: owner.accessToken,
          method: 'POST',
          headers: { 'Idempotency-Key': randomUUID() },
          body: { uploadId: upload.id },
        }),
        202,
        check,
        'auto_evidence_sup_enqueue',
      );
      const supRunId = supQueued.runId;
      const supJob = result(
        await admin.rpc('claim_analysis_run', { p_lease_seconds: 300, p_run_id: supRunId }),
        'auto_evidence_sup_claim',
      );
      const lease = {
        p_run_id: supJob.runId,
        p_generation: supJob.generation,
        p_lease_token: supJob.leaseToken,
      };

      // 2) 일반 사용자는 자동 비교 근거·공유 캐시 RPC 4종을 실행할 수 없다.
      for (const [client, tag] of [[owner.client, 'owner'], [peer.client, 'peer']]) {
        checkServiceOnlyDenied(check, await client.rpc('read_auto_evidence_permissions', lease), `auto_evidence_${tag}_perms_denied`);
        checkServiceOnlyDenied(
          check,
          await client.rpc('read_auto_evidence_cache', { ...lease, p_region_code: REGION_CODE, p_complex_keys: [] }),
          `auto_evidence_${tag}_cache_read_denied`,
        );
        checkServiceOnlyDenied(
          check,
          await client.rpc('upsert_auto_evidence_cache', { ...lease, p_region: null, p_entries: [] }),
          `auto_evidence_${tag}_cache_write_denied`,
        );
        checkServiceOnlyDenied(
          check,
          await client.rpc('finish_notice_with_evidence', {
            ...lease,
            p_input: {},
            p_result: {},
            p_comparison: {},
            p_evidence: {},
            p_evidence_sources: [],
            p_evidence_metadata: null,
            p_schedules: null,
          }),
          `auto_evidence_${tag}_finish_denied`,
        );
      }

      // 3) 서비스 키로 권한 조회 후 현재 권한에 맞는 합성 자동 근거 산출물을 생성한다.
      const perms = result(await admin.rpc('read_auto_evidence_permissions', lease), 'auto_evidence_perms');
      check(
        perms?.applyhomeApt === true
          && perms.applyhomeRemainder === true
          && perms.moisRegions === true
          && typeof perms.kakaoRuntime === 'boolean'
          && typeof perms.kakaoStorage === 'boolean',
        'auto_evidence_perms_shape',
      );

      const artifacts = await buildAutoEvidenceArtifacts(
        { kakaoStorage: perms.kakaoStorage, uploadId: upload.id, uploadHash },
        check,
      );
      const applyhomeOnly = artifacts.newCacheEntries.filter(entry => entry.cacheKind === 'applyhome_supply_area');
      const applyhomeKeys = applyhomeOnly.map(entry => entry.complexKey);
      check(applyhomeOnly.length > 0 && artifacts.regionCacheRecord?.requestRegionCode === REGION_CODE, 'auto_evidence_cache_fixture');

      // 4) 공유 캐시 쓰기·읽기·검증 후 같은 임대 안에서 합성 캐시 항목을 과거 TTL로 만료해 활성 잔여 0건을 확인한다.
      try {
        if (!perms.kakaoStorage && artifacts.kakaoCacheProbe.length > 0) {
          checkRpcError(
            check,
            await admin.rpc('upsert_auto_evidence_cache', {
              ...lease,
              p_region: null,
              p_entries: artifacts.kakaoCacheProbe,
            }),
            '42501',
            'auto_evidence_kakao_storage_denied',
          );
        }

        const stored = result(
          await admin.rpc('upsert_auto_evidence_cache', {
            ...lease,
            p_region: artifacts.regionCacheRecord,
            p_entries: applyhomeOnly,
          }),
          'auto_evidence_cache_upsert',
        );
        check(stored?.regionStored === true && stored.entriesStored === applyhomeOnly.length, 'auto_evidence_cache_stored');

        const fetched = result(
          await admin.rpc('read_auto_evidence_cache', {
            ...lease,
            p_region_code: REGION_CODE,
            p_complex_keys: applyhomeKeys,
          }),
          'auto_evidence_cache_read',
        );
        check(
          fetched?.region?.requestRegionCode === REGION_CODE
            && Object.keys(fetched.applyhome ?? {}).length === applyhomeOnly.length
            && Object.keys(fetched.kakao ?? {}).length === 0,
          'auto_evidence_cache_hit',
        );

        // 원문 payload 키와 90일 초과 TTL은 DB가 거부한다(22023).
        checkRpcError(
          check,
          await admin.rpc('upsert_auto_evidence_cache', {
            ...lease,
            p_region: null,
            p_entries: [{ ...applyhomeOnly[0], entryData: { body: 'raw payload forbidden' } }],
          }),
          '22023',
          'auto_evidence_cache_reject_raw',
        );
        const overTtl = new Date(Date.now() + 120 * 24 * 3600 * 1000).toISOString();
        checkRpcError(
          check,
          await admin.rpc('upsert_auto_evidence_cache', {
            ...lease,
            p_region: null,
            p_entries: [{ ...applyhomeOnly[0], expiresAt: overTtl }],
          }),
          '22023',
          'auto_evidence_cache_reject_ttl',
        );
      } finally {
        // PostgREST에는 private 캐시 물리 삭제 RPC가 없으므로 합성 키의 만료 시각을 과거로 갱신해 활성 캐시 0건을 확인한다.
        const pastObserved = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        const pastExpires = new Date(Date.now() - 3600 * 1000).toISOString();
        const expiredRegion = { ...artifacts.regionCacheRecord, observedAt: pastObserved, expiresAt: pastExpires };
        const expiredEntries = applyhomeOnly.map(entry => ({ ...entry, observedAt: pastObserved, expiresAt: pastExpires }));
        result(
          await admin.rpc('upsert_auto_evidence_cache', {
            ...lease,
            p_region: expiredRegion,
            p_entries: expiredEntries,
          }),
          'auto_evidence_cache_expire',
        );
        const afterExpire = result(
          await admin.rpc('read_auto_evidence_cache', {
            ...lease,
            p_region_code: REGION_CODE,
            p_complex_keys: applyhomeKeys,
          }),
          'auto_evidence_cache_verify_empty',
        );
        check(
          afterExpire?.region === null
            && Object.keys(afterExpire.applyhome ?? {}).length === 0
            && Object.keys(afterExpire.kakao ?? {}).length === 0,
          'auto_evidence_cache_zero_active',
        );
      }

      // 5) 근거 고정 없는 finish_analysis_comparison 거부(22023) 및 대상 공고 불일치 거부(22023)
      checkRpcError(
        check,
        await admin.rpc('finish_analysis_comparison', {
          ...lease,
          p_input: artifacts.request,
          p_result: artifacts.result,
          p_comparison: artifacts.comparison,
        }),
        '22023',
        'auto_evidence_unpinned_finish_rejected',
      );

      const mismatchedEvidence = structuredClone(artifacts.persistedEvidence);
      mismatchedEvidence.target.noticeNo = '0000000000';
      checkRpcError(
        check,
        await admin.rpc('finish_notice_with_evidence', {
          ...lease,
          p_input: artifacts.request,
          p_result: artifacts.result,
          p_comparison: artifacts.comparison,
          p_evidence: mismatchedEvidence,
          p_evidence_sources: artifacts.persistedSources,
          p_evidence_metadata: artifacts.metadata,
          p_schedules: artifacts.schedules,
        }),
        '22023',
        'auto_evidence_target_mismatch_rejected',
      );

      // 6) finish_notice_with_evidence 원자 저장 + 소유자 조회 + 타 계정 404
      const done = result(
        await admin.rpc('finish_notice_with_evidence', {
          ...lease,
          p_input: artifacts.request,
          p_result: artifacts.result,
          p_comparison: artifacts.comparison,
          p_evidence: artifacts.persistedEvidence,
          p_evidence_sources: artifacts.persistedSources,
          p_evidence_metadata: artifacts.metadata,
          p_schedules: artifacts.schedules,
        }),
        'auto_evidence_finish',
      );
      check(done?.status === 'finished' && UUID.test(done.snapshotId), 'auto_evidence_finished');

      const ownerResultReply = await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs/${supRunId}/result`, {
        token: owner.accessToken,
      });
      checkNoStore(ownerResultReply, check, 'auto_evidence_owner_result');
      const ownerResult = await expectJson(ownerResultReply, 200, check, 'auto_evidence_owner_result');
      check(
        ownerResult.snapshotId === done.snapshotId
          && ownerResult.result?.appliedScope === 'priority'
          && ownerResult.result.comparables?.length === 2
          && ownerResult.result.comparables[0].rank === 1,
        'auto_evidence_owner_result_shape',
      );
      check(
        (await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs/${supRunId}/evidence`, { token: owner.accessToken })).status === 200,
        'auto_evidence_owner_evidence_200',
      );
      check(
        (await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs/${supRunId}/result`, { token: peer.accessToken })).status === 404,
        'auto_evidence_peer_result_404',
      );
      check(
        (await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs/${supRunId}/evidence`, { token: peer.accessToken })).status === 404,
        'auto_evidence_peer_evidence_404',
      );

      // 7) 같은 수집본 재계산(기간 축소 승인)이 저장된 comparison_evidence를 그대로 재사용하는지 확인한다(외부 조회 없음).
      const convPath = `/api/v1/analyses/${analysisId}/runs/${supRunId}/conversation`;
      const submitted = await expectJson(
        await requestJson(requestApi, convPath, {
          token: owner.accessToken,
          method: 'POST',
          body: {
            requestId: randomUUID(),
            message: '2026-10-01부터 2026-10-20까지 다시 비교해줘',
            conditions: { period: { start: '2026-10-01', end: '2026-10-20' } },
          },
        }),
        200,
        check,
        'auto_evidence_recalc_submit',
      );
      const turnId = submitted.turns.at(-1).id;
      const approved = await expectJson(
        await requestJson(requestApi, `${convPath}/${turnId}/decision`, {
          token: owner.accessToken,
          method: 'POST',
          body: { decision: 'approve' },
        }),
        200,
        check,
        'auto_evidence_recalc_approve',
      );
      const recalcRunId = approved.turns.find(t => t.id === turnId)?.proposal?.resultRunId;
      check(UUID.test(recalcRunId) && recalcRunId !== supRunId, 'auto_evidence_recalc_run_id');

      const recalcJob = result(
        await admin.rpc('claim_analysis_run', { p_lease_seconds: 120, p_run_id: recalcRunId }),
        'auto_evidence_recalc_claim',
      );
      const recalcWork = result(
        await admin.rpc('read_comparison_work', {
          p_run_id: recalcJob.runId,
          p_generation: recalcJob.generation,
          p_lease_token: recalcJob.leaseToken,
        }),
        'auto_evidence_recalc_work',
      );
      check(
        isDeepStrictEqual(recalcWork.evidence, artifacts.persistedEvidence)
          && isDeepStrictEqual(recalcWork.comparisonPeriod, { start: '2026-10-01', end: '2026-10-20' }),
        'auto_evidence_reused_saved_evidence',
      );

      const recalcComparison = await prepareWorkerComparison(recalcJob.input, recalcWork, check, 'auto_evidence_recalc_prepare');
      const recalcDone = result(
        await admin.rpc('finish_analysis_comparison', {
          p_run_id: recalcJob.runId,
          p_generation: recalcJob.generation,
          p_lease_token: recalcJob.leaseToken,
          p_input: null,
          p_result: null,
          p_comparison: recalcComparison,
        }),
        'auto_evidence_recalc_finish',
      );
      check(recalcDone?.status === 'finished' && recalcDone.snapshotId === done.snapshotId, 'auto_evidence_recalc_same_snapshot');

      const freshOwnerToken = await freshToken(owner);
      const recalcResult = await expectJson(
        await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs/${recalcRunId}/result`, { token: freshOwnerToken }),
        200,
        check,
        'auto_evidence_recalc_read',
      );
      check(
        recalcResult.snapshotId === done.snapshotId
          && recalcResult.result?.appliedScope === 'priority'
          && recalcResult.result.conditions?.period?.start === '2026-10-01'
          && recalcResult.result.conditions?.period?.end === '2026-10-20'
          && recalcResult.result.comparables?.length === 2,
        'auto_evidence_recalc_verified',
      );
      check(
        (await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs/${recalcRunId}/result`, { token: peer.accessToken })).status === 404,
        'auto_evidence_recalc_peer_404',
      );
    } finally {
      await cleanUpScopedUploads(owner.client, uploads, check, result, 'auto_evidence_upload');
    }
  });
}
