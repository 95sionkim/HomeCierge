// 실제 로그인한 두 임시 계정과 합성 6단지 수집본으로 비교 조건 변경(Q-41 면적 ±5% 이내 축소·거래 종류·단지 교체)을 검수한다.
// 외부 API는 호출하지 않으며, 승인 시 새 실행 1건·중복 승인 1건·위조 결과 거부·거절/취소 유지·공유 프로필 불변·타 계정 404를 확인한다.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  UUID,
  checkNoStore,
  checkRpcError,
  cleanUpScopedUploads,
  expectJson,
  registerScopedUpload,
  requestJson,
  runPythonJson,
  withLoopbackSources,
} from './smoke_helpers.mjs';

const STANDARD_SOURCES = [
  'applyhome_apt',
  'applyhome_apt_model',
  'mois_legal_region_codes',
  'apt_trade',
  'apt_rights',
];
const LOOPBACK_SOURCES = STANDARD_SOURCES.map(id => ({
  id,
  storage_permission: 'allowed',
  reuse_permission: 'allowed',
  display_permission: 'allowed',
}));

async function buildRichCollectedFixture(uploadId, uploadHash, check) {
  const python = `
import copy, json, sys
sys.path.insert(0, 'scripts')
from test_compare_trades import ComparisonTests, SALE
from replay_ingestion import replay
from compare_trades import compare_snapshot

upload_id, upload_hash = json.load(sys.stdin)
t = ComparisonTests()
t.setUp()
doc_id = 'upload:' + upload_id
doc_ver = 'sha256:' + upload_hash
for item in t.bundle['evidence']:
    item['document'] = {**item['document'], 'id': doc_id, 'version': doc_ver, 'source': 'upload', 'originCheck': 'confirmed'}
scope = {'LAWD_CD': '99999', 'DEAL_YMD': '202610'}
original = [item for page in t.bundle['pages'] if (page['source'], page['scope']) == (SALE, scope)
            for item in page['body']['response']['body']['items']['item']]
extra = [('near-1', '112.2'), ('near-2', '112.7'), ('near-3', '113.0'), ('near-4', '113.4')]
t.rows(SALE, original + [t.sale_row(name) for name, _ in extra])
for name, _ in extra:
    t.complex(name)
ingestion = replay(t.bundle)
t.link_sales(ingestion, {(f'합성 {name}', '84.00'): (name, area) for name, area in extra})
ingestion['dataOrigin'] = 'collected'
evidence = copy.deepcopy(t.evidence)
evidence['dataOrigin'] = 'collected'
source_map = {
    'synthetic-region-register': 'mois_legal_region_codes',
    'synthetic-complex-register': 'applyhome_apt',
    'synthetic-area-register': 'applyhome_apt_model',
    'synthetic-coordinate-register': 'applyhome_apt',
}
def remap(node):
    if isinstance(node, dict):
        src = node.get('source')
        if isinstance(src, str) and src in source_map:
            node['source'] = source_map[src]
        for value in node.values():
            remap(value)
    elif isinstance(node, list):
        for value in node:
            remap(value)
remap(evidence)
base_comparison = compare_snapshot(ingestion, {'modelNo': '01'}, evidence)
print(json.dumps({
    'request': t.bundle['request'],
    'ingestion': ingestion,
    'evidence': evidence,
    'comparison': base_comparison,
}, ensure_ascii=False))
`;
  return runPythonJson(python, [uploadId, uploadHash], check, 'cond_fixture');
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

export async function checkConditionChanges({ config, accounts, admin, requestApi, freshToken, pdf, check, result }) {
  const [owner, peer] = accounts;
  const uploads = [];

  await withLoopbackSources(admin, config.origin, LOOPBACK_SOURCES, check, result, 'cond', async () => {
    try {
      // 공유 프로필에 기준 값을 설정해 두고, 조건 변경 전후로 revision과 조건이 변하지 않음을 확인한다.
      const profileReq = randomUUID();
      result(
        await owner.client.rpc('propose_search_profile_change', {
          p_request_id: profileReq,
          p_base_revision: 0,
          p_patch: { budget_max_won: '900000000' },
          p_reason: '합성 조건 변경 불변 기준',
          p_analysis_id: null,
          p_run_id: null,
        }),
        'cond_profile_propose',
      );
      const profileBefore = result(
        await owner.client.rpc('decide_search_profile_change', {
          p_change_id: profileReq,
          p_decision: 'approve',
        }),
        'cond_profile_approve',
      );
      check(profileBefore.conditions?.budget_max_won === '900000000' && profileBefore.revision >= 1, 'cond_profile_seeded');

      // 6단지 합성 수집본용 분석 생성 + 바인딩 업로드 등록
      const analysis = result(
        await owner.client.from('analyses').insert({
          user_id: owner.id,
          chat_id: owner.chatId,
          conditions_snapshot: { comparison: { modelNo: '01' } },
        }).select('id').single(),
        'cond_analysis',
      );
      const analysisId = analysis.id;
      const upload = await registerScopedUpload(owner.client, owner.id, analysisId, pdf, check, result, 'cond_upload');
      uploads.push(upload);

      const uploadHash = createHash('sha256').update(pdf).digest('hex');
      const rich = await buildRichCollectedFixture(upload.id, uploadHash, check);
      check(
        isDeepStrictEqual(rich.comparison.comparables.map(c => c.complexId), ['comparison-a', 'near-1', 'near-2', 'near-3', 'near-4']),
        'cond_fixture_top5',
      );

      const snapshotId = result(
        await admin.rpc('save_ingestion_snapshot', {
          p_user_id: owner.id,
          p_analysis_id: analysisId,
          p_capture_key: randomUUID(),
          p_input: rich.request,
          p_result: rich.ingestion,
        }),
        'cond_save_snapshot',
      );
      result(
        await admin.rpc('register_comparison_evidence', {
          p_snapshot_id: snapshotId,
          p_evidence: rich.evidence,
          p_source_ids: STANDARD_SOURCES,
        }),
        'cond_register_evidence',
      );

      // 기준 실행 r1 접수 및 완료
      const run1Reply = await requestJson(requestApi, `/api/v1/analyses/${analysisId}/runs`, {
        token: owner.accessToken,
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: { input: { kind: 'snapshot', snapshotId } },
      });
      const run1 = await expectJson(run1Reply, 202, check, 'cond_base_enqueue');
      const r1 = run1.runId;
      const job1 = result(
        await admin.rpc('claim_analysis_run', { p_lease_seconds: 120, p_run_id: r1 }),
        'cond_base_claim',
      );
      result(
        await admin.rpc('finish_analysis_comparison', {
          p_run_id: job1.runId,
          p_generation: job1.generation,
          p_lease_token: job1.leaseToken,
          p_input: null,
          p_result: null,
          p_comparison: rich.comparison,
        }),
        'cond_base_finish',
      );

      const convPath = runId => `/api/v1/analyses/${analysisId}/runs/${runId}/conversation`;
      const resultPath = runId => `/api/v1/analyses/${analysisId}/runs/${runId}/result`;

      // 1) 초기 조건 범위 조회 및 타 계정 404
      const openedReply = await requestJson(requestApi, convPath(r1), { token: owner.accessToken });
      checkNoStore(openedReply, check, 'cond_open');
      const opened = await expectJson(openedReply, 200, check, 'cond_open');
      check(
        opened.conditionBounds?.editable === true
          && opened.conditionBounds.areaToleranceMax === '5'
          && opened.conditionBounds.areaEditable === true
          && opened.conditionBounds.replacementsEditable === true,
        'cond_bounds',
      );
      check((await requestJson(requestApi, convPath(r1), { token: peer.accessToken })).status === 404, 'cond_peer_read_404');
      check(
        (await requestJson(requestApi, convPath(r1), {
          token: peer.accessToken,
          method: 'POST',
          body: { requestId: randomUUID(), message: '면적 3%로', conditions: { areaTolerancePercent: '3' } },
        })).status === 404,
        'cond_peer_submit_404',
      );

      // 2) Q-41 상한(±5%) 초과 및 0% 차단
      for (const badTol of ['7', '5.0001', '0']) {
        const badReply = await requestJson(requestApi, convPath(r1), {
          token: owner.accessToken,
          method: 'POST',
          body: { requestId: randomUUID(), message: `공급면적 ±${badTol}%`, conditions: { areaTolerancePercent: badTol } },
        });
        check(badReply.status === 400, `cond_q41_reject_${badTol.replace('.', '_')}`);
        await badReply.body?.cancel();
      }
      const nlWiden = await expectJson(
        await requestJson(requestApi, convPath(r1), {
          token: owner.accessToken,
          method: 'POST',
          body: { requestId: randomUUID(), message: '공급면적 허용 범위를 ±7%로 넓혀줘' },
        }),
        200,
        check,
        'cond_q41_nl_guidance',
      );
      check(nlWiden.turns.at(-1)?.intent === 'help' && nlWiden.turns.at(-1)?.proposal === null, 'cond_q41_nl_no_proposal');

      // 3) 거절·취소 시 새 실행이 만들어지지 않고 기존 조건이 유지된다.
      const rejectSubmitted = await expectJson(
        await requestJson(requestApi, convPath(r1), {
          token: owner.accessToken,
          method: 'POST',
          body: { requestId: randomUUID(), message: '매매만 비교해줘', conditions: { tradeKinds: ['sale'] } },
        }),
        200,
        check,
        'cond_reject_submit',
      );
      const rejectTurnId = rejectSubmitted.turns.at(-1).id;
      const rejected = await expectJson(
        await requestJson(requestApi, `${convPath(r1)}/${rejectTurnId}/decision`, {
          token: owner.accessToken,
          method: 'POST',
          body: { decision: 'reject' },
        }),
        200,
        check,
        'cond_reject_decide',
      );
      const rejectedTurn = rejected.turns.find(t => t.id === rejectTurnId);
      check(rejectedTurn?.proposal?.status === 'rejected' && rejectedTurn.proposal.resultRunId === null, 'cond_rejected_state');
      check(
        (await requestJson(requestApi, `${convPath(r1)}/${rejectTurnId}/decision`, {
          token: owner.accessToken,
          method: 'POST',
          body: { decision: 'approve' },
        })).status === 409,
        'cond_rejected_cannot_approve',
      );

      const cancelSubmitted = await expectJson(
        await requestJson(requestApi, convPath(r1), {
          token: owner.accessToken,
          method: 'POST',
          body: { requestId: randomUUID(), message: '분양권만 비교해줘', conditions: { tradeKinds: ['presale_right'] } },
        }),
        200,
        check,
        'cond_cancel_submit',
      );
      const cancelTurnId = cancelSubmitted.turns.at(-1).id;
      const cancelled = await expectJson(
        await requestJson(requestApi, `${convPath(r1)}/${cancelTurnId}/decision`, {
          token: owner.accessToken,
          method: 'POST',
          body: { decision: 'cancel' },
        }),
        200,
        check,
        'cond_cancel_decide',
      );
      const cancelledTurn = cancelled.turns.find(t => t.id === cancelTurnId);
      check(cancelledTurn?.proposal?.status === 'cancelled' && cancelledTurn.proposal.resultRunId === null, 'cond_cancelled_state');

      const stillR1 = result(
        await owner.client.from('analyses').select('latest_run_id').eq('id', analysisId).single(),
        'cond_latest_still_r1',
      );
      check(stillR1.latest_run_id === r1, 'cond_no_run_on_reject_cancel');

      // 4) 공급면적 범위 ±3% 좁히기 제안 → 중복 승인도 새 실행 하나(r2) → 작업자 재계산 및 위조 결과 거부
      const areaReqId = randomUUID();
      const areaSubmitted = await expectJson(
        await requestJson(requestApi, convPath(r1), {
          token: owner.accessToken,
          method: 'POST',
          body: { requestId: areaReqId, message: '공급면적 범위를 ±3%로 좁혀줘', conditions: { areaTolerancePercent: '3.0' } },
        }),
        200,
        check,
        'cond_area_submit',
      );
      const areaTurn = areaSubmitted.turns.at(-1);
      check(
        areaTurn?.proposal?.kind === 'conditions'
          && areaTurn.proposal.proposed?.areaTolerancePercent === '3'
          && areaTurn.proposal.status === 'pending'
          && areaTurn.proposal.resultRunId === null,
        'cond_area_pending',
      );
      const areaReplayed = await expectJson(
        await requestJson(requestApi, convPath(r1), {
          token: owner.accessToken,
          method: 'POST',
          body: { requestId: areaReqId, message: '공급면적 범위를 ±3%로 좁혀줘', conditions: { areaTolerancePercent: '3' } },
        }),
        200,
        check,
        'cond_area_replay',
      );
      check(isDeepStrictEqual(areaReplayed, areaSubmitted), 'cond_area_idempotent');

      check(
        (await requestJson(requestApi, `${convPath(r1)}/${areaTurn.id}/decision`, {
          token: peer.accessToken,
          method: 'POST',
          body: { decision: 'approve' },
        })).status === 404,
        'cond_peer_approve_404',
      );

      const [approveA, approveB] = await Promise.all([
        requestJson(requestApi, `${convPath(r1)}/${areaTurn.id}/decision`, {
          token: owner.accessToken,
          method: 'POST',
          body: { decision: 'approve' },
        }),
        requestJson(requestApi, `${convPath(r1)}/${areaTurn.id}/decision`, {
          token: owner.accessToken,
          method: 'POST',
          body: { decision: 'approve' },
        }),
      ]);
      const [approvedA, approvedB] = await Promise.all([
        expectJson(approveA, 200, check, 'cond_area_approve_a'),
        expectJson(approveB, 200, check, 'cond_area_approve_b'),
      ]);
      const r2 = approvedA.turns.find(t => t.id === areaTurn.id)?.proposal?.resultRunId;
      check(UUID.test(r2) && r2 !== r1 && isDeepStrictEqual(approvedA, approvedB), 'cond_duplicate_approve_one_run');

      const job2 = result(
        await admin.rpc('claim_analysis_run', { p_lease_seconds: 120, p_run_id: r2 }),
        'cond_r2_claim',
      );
      const work2 = result(
        await admin.rpc('read_comparison_work', {
          p_run_id: job2.runId,
          p_generation: job2.generation,
          p_lease_token: job2.leaseToken,
        }),
        'cond_r2_work',
      );
      check(work2.comparisonConditions?.areaTolerancePercent === '3', 'cond_r2_work_conditions');
      const prepared2 = await prepareWorkerComparison(job2.input, work2, check, 'cond_r2_prepare');
      check(
        prepared2.conditions?.area?.tolerancePercent === '3'
          && prepared2.conditions.area.minM2 === '109.028'
          && prepared2.conditions.area.maxM2 === '115.772',
        'cond_r2_exact_bounds',
      );

      // 승인과 다른 면적 기준·경계·거래 종류·선정 이유 결과는 DB가 거부한다(22023).
      const forgedR2 = [
        rich.comparison,
        { ...prepared2, conditions: { ...prepared2.conditions, area: { ...prepared2.conditions.area, minM2: '109.02' } } },
        { ...prepared2, conditions: { ...prepared2.conditions, area: { ...prepared2.conditions.area, tolerancePercent: '3.5' } } },
        { ...prepared2, conditions: { ...prepared2.conditions, tradeKinds: ['sale'] } },
      ];
      for (let i = 0; i < forgedR2.length; i++) {
        checkRpcError(
          check,
          await admin.rpc('finish_analysis_comparison', {
            p_run_id: job2.runId,
            p_generation: job2.generation,
            p_lease_token: job2.leaseToken,
            p_input: null,
            p_result: null,
            p_comparison: forgedR2[i],
          }),
          '22023',
          `cond_r2_forged_${i}`,
        );
      }

      result(
        await admin.rpc('finish_analysis_comparison', {
          p_run_id: job2.runId,
          p_generation: job2.generation,
          p_lease_token: job2.leaseToken,
          p_input: null,
          p_result: null,
          p_comparison: prepared2,
        }),
        'cond_r2_finish',
      );
      const r2Result = await expectJson(
        await requestJson(requestApi, resultPath(r2), { token: owner.accessToken }),
        200,
        check,
        'cond_r2_result',
      );
      check(r2Result.snapshotId === snapshotId && r2Result.result.conditions.area.tolerancePercent === '3', 'cond_r2_saved');

      // 5) 단지 교체(near-4 → comparison-b) 제안·승인(r3)·재계산·위조 거부
      const replaceSubmitted = await expectJson(
        await requestJson(requestApi, convPath(r2), {
          token: owner.accessToken,
          method: 'POST',
          body: {
            requestId: randomUUID(),
            message: '합성 near-4를 합성 비교 B로 바꿔줘',
            conditions: { replacements: [{ complexId: 'comparison-b', replaceComplexId: 'near-4' }] },
          },
        }),
        200,
        check,
        'cond_replace_submit',
      );
      const replaceTurn = replaceSubmitted.turns.at(-1);
      check(
        replaceTurn?.proposal?.effective?.areaTolerancePercent === '3'
          && isDeepStrictEqual(replaceTurn.proposal.effective.replacements, [{ complexId: 'comparison-b', replaceComplexId: 'near-4' }]),
        'cond_replace_effective',
      );
      const replaceApproved = await expectJson(
        await requestJson(requestApi, `${convPath(r2)}/${replaceTurn.id}/decision`, {
          token: owner.accessToken,
          method: 'POST',
          body: { decision: 'approve' },
        }),
        200,
        check,
        'cond_replace_approve',
      );
      const r3 = replaceApproved.turns.find(t => t.id === replaceTurn.id)?.proposal?.resultRunId;
      check(UUID.test(r3) && r3 !== r2, 'cond_r3_created');

      const job3 = result(
        await admin.rpc('claim_analysis_run', { p_lease_seconds: 120, p_run_id: r3 }),
        'cond_r3_claim',
      );
      const work3 = result(
        await admin.rpc('read_comparison_work', {
          p_run_id: job3.runId,
          p_generation: job3.generation,
          p_lease_token: job3.leaseToken,
        }),
        'cond_r3_work',
      );
      const prepared3 = await prepareWorkerComparison(job3.input, work3, check, 'cond_r3_prepare');
      const manual = prepared3.comparables.find(c => c.selectionReason === 'manual_replacement');
      check(
        manual?.complexId === 'comparison-b'
          && manual.replacesComplexId === 'near-4'
          && prepared3.comparables.length === 5,
        'cond_r3_manual_replacement',
      );
      // 승인된 교체를 무시한 결과(prepared2)는 DB가 거부한다.
      checkRpcError(
        check,
        await admin.rpc('finish_analysis_comparison', {
          p_run_id: job3.runId,
          p_generation: job3.generation,
          p_lease_token: job3.leaseToken,
          p_input: null,
          p_result: null,
          p_comparison: prepared2,
        }),
        '22023',
        'cond_r3_forged_ignored_replacement',
      );
      result(
        await admin.rpc('finish_analysis_comparison', {
          p_run_id: job3.runId,
          p_generation: job3.generation,
          p_lease_token: job3.leaseToken,
          p_input: null,
          p_result: null,
          p_comparison: prepared3,
        }),
        'cond_r3_finish',
      );

      // 6) 거래 종류(['sale']) 변경 제안·승인(r4) → 분양·입주권 전용 교체 후보 보류 + 보류 삭제 위조 거부
      const saleSubmitted = await expectJson(
        await requestJson(requestApi, convPath(r3), {
          token: owner.accessToken,
          method: 'POST',
          body: { requestId: randomUUID(), message: '매매만 비교해줘', conditions: { tradeKinds: ['sale'] } },
        }),
        200,
        check,
        'cond_sale_submit',
      );
      const saleTurn = saleSubmitted.turns.at(-1);
      const saleApproved = await expectJson(
        await requestJson(requestApi, `${convPath(r3)}/${saleTurn.id}/decision`, {
          token: owner.accessToken,
          method: 'POST',
          body: { decision: 'approve' },
        }),
        200,
        check,
        'cond_sale_approve',
      );
      const r4 = saleApproved.turns.find(t => t.id === saleTurn.id)?.proposal?.resultRunId;
      check(UUID.test(r4) && r4 !== r3, 'cond_r4_created');

      const job4 = result(
        await admin.rpc('claim_analysis_run', { p_lease_seconds: 120, p_run_id: r4 }),
        'cond_r4_claim',
      );
      const work4 = result(
        await admin.rpc('read_comparison_work', {
          p_run_id: job4.runId,
          p_generation: job4.generation,
          p_lease_token: job4.leaseToken,
        }),
        'cond_r4_work',
      );
      const prepared4 = await prepareWorkerComparison(job4.input, work4, check, 'cond_r4_prepare');
      check(
        isDeepStrictEqual(prepared4.conditions.tradeKinds, ['sale'])
          && !prepared4.comparables.some(c => c.complexId === 'comparison-b')
          && prepared4.holds.some(h => h.reasonCode === 'replacement_candidate_ineligible' && h.complexId === 'comparison-b'),
        'cond_r4_sale_only_and_hold',
      );
      checkRpcError(
        check,
        await admin.rpc('finish_analysis_comparison', {
          p_run_id: job4.runId,
          p_generation: job4.generation,
          p_lease_token: job4.leaseToken,
          p_input: null,
          p_result: null,
          p_comparison: {
            ...prepared4,
            holds: prepared4.holds.filter(h => h.reasonCode !== 'replacement_candidate_ineligible'),
          },
        }),
        '22023',
        'cond_r4_forged_drop_hold',
      );
      result(
        await admin.rpc('finish_analysis_comparison', {
          p_run_id: job4.runId,
          p_generation: job4.generation,
          p_lease_token: job4.leaseToken,
          p_input: null,
          p_result: null,
          p_comparison: prepared4,
        }),
        'cond_r4_finish',
      );

      // 7) 새 세션 복원, 원본 r1 보존, 타 계정 404, 공유 프로필 불변 확인
      const freshOwnerToken = await freshToken(owner);
      const r4Restored = await expectJson(
        await requestJson(requestApi, resultPath(r4), { token: freshOwnerToken }),
        200,
        check,
        'cond_r4_reopen',
      );
      check(
        r4Restored.snapshotId === snapshotId
          && r4Restored.result.conditions.area.tolerancePercent === '3'
          && isDeepStrictEqual(r4Restored.result.conditions.tradeKinds, ['sale']),
        'cond_r4_reopen_values',
      );
      const r1Restored = await expectJson(
        await requestJson(requestApi, resultPath(r1), { token: freshOwnerToken }),
        200,
        check,
        'cond_r1_preserved',
      );
      check(isDeepStrictEqual(r1Restored.result, rich.comparison), 'cond_r1_unchanged');
      check((await requestJson(requestApi, resultPath(r4), { token: peer.accessToken })).status === 404, 'cond_peer_r4_404');

      const profileAfter = result(await owner.client.rpc('read_search_profile', {}), 'cond_profile_after');
      check(
        profileAfter.revision === profileBefore.revision
          && isDeepStrictEqual(profileAfter.conditions, profileBefore.conditions),
        'cond_shared_profile_unchanged',
      );
    } finally {
      await cleanUpScopedUploads(owner.client, uploads, check, result, 'cond_upload');
    }
  });
}
