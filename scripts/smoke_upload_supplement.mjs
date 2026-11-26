// 실제 로그인한 두 임시 계정과 Storage로 PDF 업로드 보완·멱등 접수·타 계정 404·A-56 파생 삭제 영향 미리보기와 정리를 검수한다.
// 외부 청약홈·실거래 API는 호출하지 않으며 합성 공고·합성 PDF 바이트만 사용한다.
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

const TARGET = { houseManageNo: '9900000001', noticeNo: '9900000042', edition: '2026-10-05' };
const MODEL_NO = '01';
const ROOM = '101동 101호';
const LOOPBACK_SOURCES = [
  'applyhome_apt',
  'applyhome_apt_model',
  'mois_legal_region_codes',
  'apt_trade',
  'apt_rights',
].map(id => ({ id, storage_permission: 'allowed', reuse_permission: 'allowed', display_permission: 'allowed' }));

async function buildUploadSupplementCapture({ docMode, uploadId = null, uploadHash = null }, check, step) {
  const python = `
import json, sys
from pathlib import Path
sys.path.insert(0, 'scripts')
from compare_trades import compare_snapshot
from replay_ingestion import ingest

doc_mode, upload_id, upload_hash = json.load(sys.stdin)
sample = json.loads(Path('tests/fixtures/ingestion-v0.json').read_text(encoding='utf-8'))
target = {'houseManageNo': '9900000001', 'noticeNo': '9900000042', 'edition': '2026-10-05'}
request = {
    'noticeSource': 'applyhome_apt',
    'target': target,
    'asOf': '2026-11-10',
    'requestRegionCodes': ['99999'],
    'tradeKinds': ['sale', 'presale_right', 'occupancy_right'],
    'pageSize': 100,
}
notice = dict(sample['pages'][0]['body']['data'][0], HOUSE_MANAGE_NO=target['houseManageNo'],
              PBLANC_NO=target['noticeNo'], RCRIT_PBLANC_DE=target['edition'])
model = dict(sample['pages'][1]['body']['data'][0], HOUSE_MANAGE_NO=target['houseManageNo'],
             PBLANC_NO=target['noticeNo'], MODEL_NO='01')

def fetch(source, scope, page, page_size):
    entry = dict(source=source, scope=scope, page=page, pageSize=page_size,
                 observedAt='2026-11-10T01:00:00Z', httpStatus=200)
    if source == 'applyhome_apt':
        entry['body'] = dict(page=page, perPage=page_size, currentCount=1, matchCount=1, totalCount=1, data=[notice])
    elif source == 'applyhome_apt_model':
        entry['body'] = dict(page=page, perPage=page_size, currentCount=1, matchCount=1, totalCount=1, data=[model])
    elif source == 'apt_trade' and scope['DEAL_YMD'] == '202610':
        entry['body'] = sample['pages'][2]['body']
        inner = entry['body']['response']['body']
        inner['numOfRows'] = page_size
        inner['totalCount'] = len(inner['items']['item'])
    else:
        entry['body'] = {'response': {'header': {'resultCode': '000', 'resultMsg': 'OK'},
                         'body': {'pageNo': page, 'numOfRows': page_size, 'totalCount': 0, 'items': {}}}}
    return entry

if doc_mode == 'missing':
    captured = ingest(
        request, fetch, data_origin='collected',
        review_documents=lambda *_: {'evidence': [], 'issues': [{'code': 'attachment_not_found', 'stage': 'document_acquisition'}]},
    )
    schedules = []
else:
    doc_id = 'upload:' + upload_id
    version = 'sha256:' + upload_hash
    doc = {'id': doc_id, 'version': version, 'source': 'upload', 'originCheck': 'confirmed', **target}
    ev_rows = [dict(item, document=dict(doc)) for item in sample['evidence']]
    captured = ingest(request, fetch, data_origin='collected', evidence=ev_rows)
    schedules = [
        {
            'modelNo': '01', 'houseType': '084.0000A', 'room': '101동 101호', 'item': 'sale_price',
            'status': 'confirmed', 'totalWon': '700000000', 'reasons': [],
            'evidence': [{'document': doc_id, 'version': version, 'page': 7}],
            'installments': [{
                'stage': 'balance', 'won': '700000000',
                'timing': {'trigger': 'calendar_date', 'dateStatus': 'exact', 'date': '2026-11-30',
                           'evidence': [{'document': doc_id, 'version': version, 'page': 7}]},
            }],
        },
        {
            'modelNo': '01', 'houseType': '084.0000A', 'room': '101동 101호', 'item': 'required_options',
            'status': 'confirmed', 'totalWon': '10000000', 'reasons': [],
            'evidence': [{'document': doc_id, 'version': version, 'page': 8}],
            'installments': [{
                'stage': 'balance', 'won': '10000000',
                'timing': {'trigger': 'calendar_date', 'dateStatus': 'exact', 'date': '2026-11-30',
                           'evidence': [{'document': doc_id, 'version': version, 'page': 8}]},
            }],
        },
    ]

comparison = compare_snapshot(captured, {'modelNo': '01', 'room': '101동 101호'}, None)
print(json.dumps({'request': request, 'result': captured, 'comparison': comparison, 'schedules': schedules}, ensure_ascii=False))
`;
  return runPythonJson(python, [docMode, uploadId, uploadHash], check, step);
}

export async function checkUploadSupplement({
  config, accounts, admin, requestApi, freshToken, userClient, login, finishTestDeletion, pdf, check, result,
}) {
  const [owner, peer] = accounts;
  const uploads = [];
  let pendingReceiptId = null;

  await withLoopbackSources(admin, config.origin, LOOPBACK_SOURCES, check, result, 'supplement', async () => {
    try {
      // 1) 공식 PDF 누락 상태의 기준 수집본(합성)과 완료 실행 준비
      const analysis = result(
        await owner.client.from('analyses').insert({
          user_id: owner.id,
          chat_id: owner.chatId,
          title: '합성 가람 아파트',
          conditions_snapshot: {
            ingestion_target: { noticeSource: 'applyhome_apt', ...TARGET },
            comparison: { modelNo: MODEL_NO, room: ROOM },
          },
        }).select('id').single(),
        'supplement_analysis',
      );
      const analysisId = analysis.id;

      const basePayload = await buildUploadSupplementCapture({ docMode: 'missing' }, check, 'supplement_base_capture');
      const baseSnapshotId = result(
        await admin.rpc('save_ingestion_snapshot', {
          p_user_id: owner.id,
          p_analysis_id: analysisId,
          p_capture_key: randomUUID(),
          p_input: basePayload.request,
          p_result: basePayload.result,
        }),
        'supplement_base_snapshot',
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
        'supplement_base_enqueue',
      );
      const baseRunId = baseRun.runId;
      const baseJob = result(
        await admin.rpc('claim_analysis_run', { p_lease_seconds: 120, p_run_id: baseRunId }),
        'supplement_base_claim',
      );
      result(
        await admin.rpc('finish_analysis_comparison', {
          p_run_id: baseJob.runId,
          p_generation: baseJob.generation,
          p_lease_token: baseJob.leaseToken,
          p_input: null,
          p_result: null,
          p_comparison: basePayload.comparison,
        }),
        'supplement_base_finish',
      );

      const baseSupplementPath = `/api/v1/analyses/${analysisId}/runs/${baseRunId}/upload-supplement`;

      // 2) 보완 컨텍스트 조회 및 타 계정 404
      const ctxReply = await requestJson(requestApi, baseSupplementPath, { token: owner.accessToken });
      if (ctxReply.status !== 200) {
        // 진단: API가 숨긴 DB 오류의 SQLSTATE와 메시지만 남긴다(토큰·응답 본문은 출력하지 않는다).
        const direct = await owner.client.rpc('read_upload_supplement_context', { p_analysis_id: analysisId, p_run_id: baseRunId });
        const err = direct.error;
        process.stderr.write(`supplement_context direct rpc: ${err ? `${err.code} ${String(err.message).slice(0, 200)} ${String(err.details ?? '').slice(0, 200)} ${String(err.hint ?? '').slice(0, 120)}` : 'no error'}\n`);
      }
      checkNoStore(ctxReply, check, 'supplement_context');
      const ctx = await expectJson(ctxReply, 200, check, 'supplement_context');
      check(
        ctx.contractVersion === 'upload-supplement-context/v1'
          && ctx.eligible === true
          && ctx.needsSupplement === true
          && ctx.target?.noticeNo === TARGET.noticeNo
          && ctx.reasonCodes.includes('attachment_not_found')
          && ctx.reasonCodes.includes('official_document_missing'),
        'supplement_context_needs_upload',
      );
      check((await requestJson(requestApi, baseSupplementPath, { token: peer.accessToken })).status === 404, 'supplement_peer_context_404');

      // 3) Storage에 올리지 않은 등록 업로드로 접수 시 409(upload_file_missing)
      const missingFileUpload = await registerScopedUpload(
        owner.client, owner.id, analysisId, pdf, check, result, 'supplement_missing_file', { storeFile: false },
      );
      uploads.push(missingFileUpload);
      const missingFileReply = await requestJson(requestApi, baseSupplementPath, {
        token: owner.accessToken,
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: { uploadId: missingFileUpload.id },
      });
      check(missingFileReply.status === 409, 'supplement_missing_storage_409');
      await missingFileReply.body?.cancel();

      // 4) 합성 PDF 등록 + 비공개 Storage 업로드 + 소유자/타 계정 다운로드 확인
      const upload = await registerScopedUpload(owner.client, owner.id, analysisId, pdf, check, result, 'supplement_pdf');
      uploads.push(upload);
      const uploadHash = createHash('sha256').update(pdf).digest('hex');

      const ownContent = await requestJson(requestApi, `/api/v1/analyses/${analysisId}/uploads/${upload.id}/content`, {
        token: owner.accessToken,
      });
      checkNoStore(ownContent, check, 'supplement_upload_content');
      check(
        ownContent.status === 200
          && ownContent.headers.get('content-type')?.split(';')[0] === 'application/pdf'
          && Buffer.from(await ownContent.arrayBuffer()).equals(pdf),
        'supplement_upload_content_bytes',
      );
      check(
        (await requestJson(requestApi, `/api/v1/analyses/${analysisId}/uploads/${upload.id}/content`, {
          token: peer.accessToken,
        })).status === 404,
        'supplement_peer_upload_content_404',
      );

      // 브라우저가 보낸 해시·채택 등 추가 필드는 400으로 거부한다.
      const extraFieldReply = await requestJson(requestApi, baseSupplementPath, {
        token: owner.accessToken,
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: { uploadId: upload.id, sha256: uploadHash },
      });
      check(extraFieldReply.status === 400, 'supplement_extra_body_field_400');
      await extraFieldReply.body?.cancel();

      // 5) 보완 실행 접수 + 같은 키 재전송 멱등성 + 다른 업로드 충돌 409 + 타 계정 404
      check(
        (await requestJson(requestApi, baseSupplementPath, {
          token: peer.accessToken,
          method: 'POST',
          headers: { 'Idempotency-Key': randomUUID() },
          body: { uploadId: upload.id },
        })).status === 404,
        'supplement_peer_enqueue_404',
      );

      const idemKey = randomUUID();
      const enqueueReply = await requestJson(requestApi, baseSupplementPath, {
        token: owner.accessToken,
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey },
        body: { uploadId: upload.id },
      });
      const queued = await expectJson(enqueueReply, 202, check, 'supplement_enqueue');
      const supRunId = queued.runId;
      const supRunPath = `/api/v1/analyses/${analysisId}/upload-supplements/${supRunId}`;
      check(
        queued.contractVersion === 'upload-supplement-run/v1'
          && UUID.test(supRunId)
          && queued.baseRunId === baseRunId
          && queued.uploadId === upload.id
          && queued.status === 'queued'
          && queued.input?.kind === 'upload_supplement'
          && enqueueReply.headers.get('location') === supRunPath,
        'supplement_enqueue_shape',
      );

      const replayed = await expectJson(
        await requestJson(requestApi, baseSupplementPath, {
          token: owner.accessToken,
          method: 'POST',
          headers: { 'Idempotency-Key': idemKey },
          body: { uploadId: upload.id },
        }),
        202,
        check,
        'supplement_enqueue_replay',
      );
      check(isDeepStrictEqual(replayed, queued), 'supplement_enqueue_idempotent');

      const otherUpload = await registerScopedUpload(owner.client, owner.id, analysisId, pdf, check, result, 'supplement_other_pdf');
      uploads.push(otherUpload);
      const conflictReply = await requestJson(requestApi, baseSupplementPath, {
        token: owner.accessToken,
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey },
        body: { uploadId: otherUpload.id },
      });
      check(conflictReply.status === 409, 'supplement_enqueue_conflict_409');
      await conflictReply.body?.cancel();

      check((await requestJson(requestApi, supRunPath, { token: owner.accessToken })).status === 200, 'supplement_owner_status_200');
      check((await requestJson(requestApi, supRunPath, { token: peer.accessToken })).status === 404, 'supplement_peer_status_404');

      // 6) 작업자 RPC 권한 분리 + 바인딩 검증 + 보완 실행 완료
      const supJob = result(
        await admin.rpc('claim_analysis_run', { p_lease_seconds: 180, p_run_id: supRunId }),
        'supplement_worker_claim',
      );
      checkServiceOnlyDenied(
        check,
        await owner.client.rpc('read_upload_supplement_work', {
          p_run_id: supJob.runId,
          p_generation: supJob.generation,
          p_lease_token: supJob.leaseToken,
        }),
        'supplement_work_user_denied',
      );
      checkServiceOnlyDenied(
        check,
        await peer.client.rpc('lookup_official_notice_document_index', {
          p_run_id: supJob.runId,
          p_generation: supJob.generation,
          p_lease_token: supJob.leaseToken,
          p_sha256: uploadHash,
        }),
        'supplement_index_lookup_user_denied',
      );

      const work = result(
        await admin.rpc('read_upload_supplement_work', {
          p_run_id: supJob.runId,
          p_generation: supJob.generation,
          p_lease_token: supJob.leaseToken,
        }),
        'supplement_read_work',
      );
      check(work.upload?.uploadId === upload.id && work.upload.objectPath === upload.path, 'supplement_work_bound');

      // 다른 업로드 ID 문서는 저장 거부(22023)
      const wrongCapture = await buildUploadSupplementCapture(
        { docMode: 'upload', uploadId: randomUUID(), uploadHash },
        check,
        'supplement_wrong_capture',
      );
      checkRpcError(
        check,
        await admin.rpc('finish_notice_with_funding', {
          p_run_id: supJob.runId,
          p_generation: supJob.generation,
          p_lease_token: supJob.leaseToken,
          p_input: wrongCapture.request,
          p_result: wrongCapture.result,
          p_comparison: wrongCapture.comparison,
          p_schedules: wrongCapture.schedules,
        }),
        '22023',
        'supplement_wrong_upload_rejected',
      );

      const validCapture = await buildUploadSupplementCapture(
        { docMode: 'upload', uploadId: upload.id, uploadHash },
        check,
        'supplement_valid_capture',
      );
      const finished = result(
        await admin.rpc('finish_notice_with_funding', {
          p_run_id: supJob.runId,
          p_generation: supJob.generation,
          p_lease_token: supJob.leaseToken,
          p_input: validCapture.request,
          p_result: validCapture.result,
          p_comparison: validCapture.comparison,
          p_schedules: validCapture.schedules,
        }),
        'supplement_finish',
      );
      check(finished.status === 'finished' && UUID.test(finished.snapshotId), 'supplement_finished_snapshot');

      const finishedStatus = await expectJson(
        await requestJson(requestApi, supRunPath, { token: owner.accessToken }),
        200,
        check,
        'supplement_finished_read',
      );
      check(
        finishedStatus.status === 'finished'
          && finishedStatus.documents[0]?.source === 'upload'
          && finishedStatus.documents[0]?.status === 'accepted',
        'supplement_finished_doc',
      );

      const comp = await expectJson(
        await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs/${supRunId}/result`, { token: owner.accessToken }),
        200,
        check,
        'supplement_result',
      );
      check(
        comp.result?.target?.supplyArea?.status === 'confirmed'
          && comp.result.noticePrice?.status === 'confirmed'
          && comp.result.noticePrice.won === '710000000',
        'supplement_result_confirmed',
      );
      check(
        (await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs/${supRunId}/result`, { token: peer.accessToken })).status === 404,
        'supplement_peer_result_404',
      );

      const evidenceRes = await expectJson(
        await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs/${supRunId}/evidence`, { token: owner.accessToken }),
        200,
        check,
        'supplement_evidence',
      );
      check(
        evidenceRes.documents?.some(doc => doc.uploadContentPath === `/api/v1/analyses/${analysisId}/uploads/${upload.id}/content`),
        'supplement_evidence_upload_path',
      );

      const afterCtx = await expectJson(
        await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs/${supRunId}/upload-supplement`, { token: owner.accessToken }),
        200,
        check,
        'supplement_after_context',
      );
      check(afterCtx.needsSupplement === false && afterCtx.currentSupplement?.uploadId === upload.id, 'supplement_resolved');

      // 7) 파생 자료(저장 보고서 + 승인된 조건 변경 파생 실행) 생성 후 A-56 업로드 삭제 영향 미리보기와 정리
      const savedReport = await expectJson(
        await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs/${supRunId}/reports`, {
          token: owner.accessToken,
          method: 'POST',
          body: { requestId: randomUUID() },
        }),
        201,
        check,
        'supplement_derived_report',
      );
      const turnSubmitted = await expectJson(
        await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs/${supRunId}/conversation`, {
          token: owner.accessToken,
          method: 'POST',
          body: {
            requestId: randomUUID(),
            message: '공급면적 범위를 ±3%로 좁혀줘',
            conditions: { areaTolerancePercent: '3' },
          },
        }),
        200,
        check,
        'supplement_derived_turn',
      );
      const turnId = turnSubmitted.turns.at(-1).id;
      const turnApproved = await expectJson(
        await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs/${supRunId}/conversation/${turnId}/decision`, {
          token: owner.accessToken,
          method: 'POST',
          body: { decision: 'approve' },
        }),
        200,
        check,
        'supplement_derived_approve',
      );
      const descendantRunId = turnApproved.turns.find(t => t.id === turnId)?.proposal?.resultRunId;
      check(UUID.test(descendantRunId), 'supplement_descendant_run');

      // 타 계정의 영향 미리보기·삭제 요청은 404
      check(
        (await requestJson(requestApi, '/api/v1/privacy/impact', {
          token: peer.accessToken,
          method: 'POST',
          body: { scope: 'upload', targetId: upload.id },
        })).status === 404,
        'supplement_peer_impact_404',
      );
      check(
        (await requestJson(requestApi, '/api/v1/privacy/requests', {
          token: peer.accessToken,
          method: 'POST',
          body: { scope: 'upload', targetId: upload.id, receiptId: randomUUID(), confirmed: true },
        })).status === 404,
        'supplement_peer_delete_404',
      );

      // 소유자 영향 미리보기: 업로드 1 + 파생 실행 2(보완 + 조건 변경) + 대화 턴 1 + 저장 보고서 1 + Storage 객체 1
      const impact = await expectJson(
        await requestJson(requestApi, '/api/v1/privacy/impact', {
          token: owner.accessToken,
          method: 'POST',
          body: { scope: 'upload', targetId: upload.id },
        }),
        200,
        check,
        'supplement_delete_impact',
      );
      check(
        impact.scope === 'upload'
          && impact.targetId === upload.id
          && impact.counts?.uploads === 1
          && impact.counts.runs === 2
          && impact.counts.turns === 1
          && impact.counts.reports === 1
          && impact.reportsDeleted === 1
          && impact.storageObjects === 1,
        'supplement_delete_impact_counts',
      );

      // 업로드 삭제 요청 + 삭제 작업자 실행으로 Storage까지 정리
      const receiptId = randomUUID();
      const deleted = await expectJson(
        await requestJson(requestApi, '/api/v1/privacy/requests', {
          token: owner.accessToken,
          method: 'POST',
          body: { scope: 'upload', targetId: upload.id, receiptId, confirmed: true },
        }),
        202,
        check,
        'supplement_delete_request',
      );
      check(deleted.scope === 'upload' && deleted.status === 'processing' && deleted.receiptId === receiptId, 'supplement_delete_accepted');
      upload.delegated = true;
      pendingReceiptId = receiptId;

      await finishTestDeletion(config, receiptId, check, requestApi);
      pendingReceiptId = null;
      upload.finalized = true;

      const receiptStatus = await expectJson(
        await requestJson(requestApi, '/api/v1/privacy/receipt', {
          method: 'POST',
          body: { receiptId },
        }),
        200,
        check,
        'supplement_delete_receipt',
      );
      check(receiptStatus.status === 'live_deleted', 'supplement_delete_live_deleted');

      // 재로그인 후 파생 실행·후속 실행·보고서·업로드 다운로드·Storage 원본 모두 제거, 기준 실행은 보존 확인
      const freshOwnerToken = await freshToken(owner);
      for (const [gonePath, label] of [
        [`/api/v1/analyses/${analysisId}/runs/${supRunId}`, 'supplement_deleted_sup_run'],
        [`/api/v1/analyses/${analysisId}/runs/${descendantRunId}`, 'supplement_deleted_descendant_run'],
        [supRunPath, 'supplement_deleted_sup_status'],
        [`/api/v1/reports/${savedReport.reportId}`, 'supplement_deleted_report'],
        [`/api/v1/analyses/${analysisId}/uploads/${upload.id}/content`, 'supplement_deleted_upload_content'],
      ]) {
        check((await requestJson(requestApi, gonePath, { token: freshOwnerToken })).status === 404, label);
      }

      const freshClient = userClient();
      await login(owner, freshClient);
      const goneFile = await freshClient.storage.from('analysis-uploads').download(upload.path, { cacheNonce: randomUUID() });
      check(Boolean(goneFile.error), 'supplement_deleted_storage_gone');

      // 삭제된 업로드 재사용 차단(A-56)
      const reuseDeleted = await requestJson(requestApi, baseSupplementPath, {
        token: freshOwnerToken,
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: { uploadId: upload.id },
      });
      check(reuseDeleted.status === 409, 'supplement_deleted_upload_blocked');
      await reuseDeleted.body?.cancel();

      // 기준 실행은 그대로 유지된다.
      check(
        (await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs/${baseRunId}`, { token: freshOwnerToken })).status === 200,
        'supplement_base_run_preserved',
      );
    } finally {
      if (pendingReceiptId) {
        await finishTestDeletion(config, pendingReceiptId, check, requestApi);
      }
      await cleanUpScopedUploads(owner.client, uploads, check, result, 'supplement_upload');
    }
  });
}
