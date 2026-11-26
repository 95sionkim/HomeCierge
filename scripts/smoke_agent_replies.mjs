// 실제 로그인한 두 임시 계정과 합성 비교 실행으로 비교 대화 AI 설명 대기열(agent_replies)을 검수한다.
// 외부 LLM(OpenAI)은 호출하지 않으며 서비스 키로 합성 답변 완료, 타 계정 404, 턴 삭제 연쇄, 설정 원복을 확인한다.
import { randomUUID } from 'node:crypto';
import {
  UUID,
  checkNoStore,
  checkRpcError,
  checkServiceOnlyDenied,
  expectJson,
  requestJson,
} from './smoke_helpers.mjs';

const VALID_MODELS = new Set(['gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-astra']);
const SYNTHETIC_RUN_INPUT = { kind: 'synthetic', fixture: 'ingestion-v0' };

export async function checkAgentReplies({ config, accounts, admin, requestApi, freshToken, workerOnce, check, result }) {
  const [owner, peer] = accounts;

  // 1) 합성 데모 실행을 완료해 비교 대화 대상 실행을 만든다(외부 API 무호출).
  const runReply = await requestJson(requestApi, `/api/v1/analyses/${owner.analysisId}/runs`, {
    token: owner.accessToken,
    method: 'POST',
    headers: { 'Idempotency-Key': randomUUID() },
    body: { input: SYNTHETIC_RUN_INPUT },
  });
  const queuedRun = await expectJson(runReply, 202, check, 'agent_reply_run_enqueue');
  const runId = queuedRun.runId;
  const worked = await workerOnce(config, runId, check, 'agent_reply_run_worker');
  check(worked?.status === 'finished' && UUID.test(worked.snapshotId), 'agent_reply_run_finished');

  const convPath = `/api/v1/analyses/${owner.analysisId}/runs/${runId}/conversation`;

  // 2) 일반 사용자가 에이전트 설정·작업자 RPC를 호출할 수 없는지 확인한다.
  for (const [client, tag] of [[owner.client, 'owner'], [peer.client, 'peer']]) {
    checkServiceOnlyDenied(
      check,
      await client.rpc('configure_agent_settings', { p_enabled: true, p_model: 'gpt-6.2-sol' }),
      `agent_reply_${tag}_configure_denied`,
    );
    checkServiceOnlyDenied(
      check,
      await client.rpc('claim_agent_reply', { p_lease_seconds: 60 }),
      `agent_reply_${tag}_claim_denied`,
    );
    checkServiceOnlyDenied(
      check,
      await client.rpc('expire_stale_agent_replies'),
      `agent_reply_${tag}_expire_denied`,
    );
    checkServiceOnlyDenied(
      check,
      await client.rpc('read_agent_reply_context', {
        p_reply_id: randomUUID(),
        p_generation: 1,
        p_lease_token: randomUUID(),
      }),
      `agent_reply_${tag}_context_denied`,
    );
    checkServiceOnlyDenied(
      check,
      await client.rpc('complete_agent_reply', {
        p_reply_id: randomUUID(),
        p_generation: 1,
        p_lease_token: randomUUID(),
        p_status: 'rejected',
      }),
      `agent_reply_${tag}_complete_denied`,
    );
    checkServiceOnlyDenied(
      check,
      await client.rpc('fail_agent_reply', {
        p_reply_id: randomUUID(),
        p_generation: 1,
        p_lease_token: randomUUID(),
        p_failure_code: 'llm_timeout',
      }),
      `agent_reply_${tag}_fail_denied`,
    );
  }

  // 3) 설정을 바꾸기 전에 탐침 턴 하나로 현재 agent_settings 상태를 관찰하고 탐침 턴을 즉시 삭제한다.
  // private.agent_settings의 읽기 전용 RPC가 없으므로 활성화 여부와(활성 시) 모델명을 관찰해 종료 시 원복한다.
  const probeConv = await expectJson(
    await requestJson(requestApi, convPath, {
      token: owner.accessToken,
      method: 'POST',
      body: { requestId: randomUUID(), message: '왜 이 거래만 포함됐어?' },
    }),
    200,
    check,
    'agent_reply_probe_submit',
  );
  const probeTurn = probeConv.turns.at(-1);
  check(UUID.test(probeTurn?.id), 'agent_reply_probe_id');
  const originalSettings = probeTurn.agentReply
    ? {
        enabled: true,
        model: VALID_MODELS.has(probeTurn.agentReply.model) ? probeTurn.agentReply.model : 'gpt-6.2-sol',
      }
    : { enabled: false, model: 'gpt-6.2-sol' };

  const probeDelete = await expectJson(
    await requestJson(requestApi, '/api/v1/privacy/requests', {
      token: owner.accessToken,
      method: 'POST',
      body: { scope: 'turn', targetId: probeTurn.id, receiptId: randomUUID(), confirmed: true },
    }),
    200,
    check,
    'agent_reply_probe_delete',
  );
  check(probeDelete.status === 'live_deleted', 'agent_reply_probe_deleted');

  // 4) 서비스 키로 기능을 켠 상태에서 대기열 생성·임대·완료·검증·턴 삭제 연쇄를 검수하고, 끝에 원래 설정으로 되돌린다.
  const enabledSettings = result(
    await admin.rpc('configure_agent_settings', { p_enabled: true, p_model: 'gpt-6.2-sol' }),
    'agent_reply_enable',
  );
  check(enabledSettings?.enabled === true && enabledSettings.model === 'gpt-6.2-sol', 'agent_reply_enabled_state');

  try {
    // 4-1) 턴 제출 → queued 대기열 생성 + 타 계정 404
    const submittedReply = await requestJson(requestApi, convPath, {
      token: owner.accessToken,
      method: 'POST',
      body: { requestId: randomUUID(), message: '왜 이 거래만 포함됐어?' },
    });
    checkNoStore(submittedReply, check, 'agent_reply_submit');
    const submitted = await expectJson(submittedReply, 200, check, 'agent_reply_submit');
    const turn1 = submitted.turns.at(-1);
    check(
      UUID.test(turn1?.id)
        && typeof turn1.answer === 'string' && turn1.answer.length > 0
        && turn1.agentReply?.status === 'queued'
        && turn1.agentReply.model === 'gpt-6.2-sol'
        && turn1.agentReply.answer === null,
      'agent_reply_queued_shape',
    );
    check((await requestJson(requestApi, convPath, { token: peer.accessToken })).status === 404, 'agent_reply_peer_read_404');
    check(
      (await requestJson(requestApi, convPath, {
        token: peer.accessToken,
        method: 'POST',
        body: { requestId: randomUUID(), message: '타 계정 질문 시도' },
      })).status === 404,
      'agent_reply_peer_submit_404',
    );

    // 4-2) 서비스 키로 임대·문맥 조회·합성 답변 완료(외부 LLM 호출 없음)
    const claimed1 = result(await admin.rpc('claim_agent_reply', { p_lease_seconds: 60 }), 'agent_reply_claim1');
    check(
      claimed1?.turnId === turn1.id && claimed1.generation === 1 && claimed1.model === 'gpt-6.2-sol',
      'agent_reply_claim1_matches_turn',
    );
    const ctx1 = result(
      await admin.rpc('read_agent_reply_context', {
        p_reply_id: claimed1.replyId,
        p_generation: claimed1.generation,
        p_lease_token: claimed1.leaseToken,
      }),
      'agent_reply_context1',
    );
    check(ctx1?.message === '왜 이 거래만 포함됐어?' && ctx1.comparison?.contractVersion === 'comparison/v1', 'agent_reply_context1_shape');

    const syntheticAnswer = '합성 비교표에 포함된 주변 단지는 2곳이며, 규칙 기반 계산 수치와 같습니다.';
    const done1 = result(
      await admin.rpc('complete_agent_reply', {
        p_reply_id: claimed1.replyId,
        p_generation: claimed1.generation,
        p_lease_token: claimed1.leaseToken,
        p_status: 'answered',
        p_intent: 'inclusion',
        p_answer: syntheticAnswer,
        p_citations: [{ kind: 'comparison', reference: 'comparison/v1', label: '비교 결과 요약' }],
        p_proposal: null,
        p_usage: { inputTokens: 320, outputTokens: 120, reasoningTokens: 40, latencyMs: 180, estimatedCostUsd: '0.00184000', pricingAsOf: '2026-11-26' },
        p_validation: { status: 'passed', reasons: [] },
        p_prompt_version: 'agent-core-v1',
      }),
      'agent_reply_complete1',
    );
    check(done1?.status === 'answered', 'agent_reply_done1_status');

    // 소유자 조회 및 새 세션 재로그인에 agentReply가 표시되고, 타 계정은 404다.
    const ownerView = await expectJson(
      await requestJson(requestApi, convPath, { token: owner.accessToken }),
      200,
      check,
      'agent_reply_owner_read',
    );
    const answered1 = ownerView.turns.find(t => t.id === turn1.id);
    check(
      answered1?.agentReply?.status === 'answered'
        && answered1.agentReply.answer === syntheticAnswer
        && answered1.agentReply.model === 'gpt-6.2-sol'
        && answered1.agentReply.citations?.length === 1
        && typeof answered1.answer === 'string' && answered1.answer.length > 0,
      'agent_reply_owner_visible',
    );

    const freshOwnerToken = await freshToken(owner);
    const reopenedView = await expectJson(
      await requestJson(requestApi, convPath, { token: freshOwnerToken }),
      200,
      check,
      'agent_reply_reopen_read',
    );
    check(reopenedView.turns.find(t => t.id === turn1.id)?.agentReply?.answer === syntheticAnswer, 'agent_reply_reopen_visible');
    check((await requestJson(requestApi, convPath, { token: peer.accessToken })).status === 404, 'agent_reply_peer_after_done_404');

    // 4-3) Q-41 상한(±5%)을 넘는 잘못된 LLM 조건 제안(±7%)은 서버 검증이 거부한다.
    const badSubmitted = await expectJson(
      await requestJson(requestApi, convPath, {
        token: owner.accessToken,
        method: 'POST',
        body: { requestId: randomUUID(), message: '면적 범위를 7퍼센트로 넓힐 수 있어?' },
      }),
      200,
      check,
      'agent_reply_bad_proposal_submit',
    );
    const turn2 = badSubmitted.turns.at(-1);
    const claimed2 = result(await admin.rpc('claim_agent_reply', { p_lease_seconds: 60 }), 'agent_reply_claim2');
    check(claimed2?.turnId === turn2.id, 'agent_reply_claim2_matches_turn');
    const badDone = result(
      await admin.rpc('complete_agent_reply', {
        p_reply_id: claimed2.replyId,
        p_generation: claimed2.generation,
        p_lease_token: claimed2.leaseToken,
        p_status: 'answered',
        p_intent: 'change_conditions',
        p_answer: '공급면적 허용 범위를 ±7%로 제안합니다.',
        p_citations: [],
        p_proposal: { kind: 'conditions', conditions: { areaTolerancePercent: '7' } },
        p_usage: {},
        p_validation: { status: 'passed', reasons: [] },
        p_prompt_version: 'agent-core-v1',
      }),
      'agent_reply_bad_proposal_complete',
    );
    check(badDone?.status === 'rejected' && badDone.proposalAttached === false, 'agent_reply_bad_proposal_rejected');

    // 4-4) 턴 삭제 시 연결된 에이전트 응답도 함께 삭제되고 임대 작업자의 후속 읽기·완료가 PT404로 차단된다.
    const delSubmitted = await expectJson(
      await requestJson(requestApi, convPath, {
        token: owner.accessToken,
        method: 'POST',
        body: { requestId: randomUUID(), message: '삭제할 턴 질문입니다' },
      }),
      200,
      check,
      'agent_reply_delete_submit',
    );
    const turn3 = delSubmitted.turns.at(-1);
    const leased3 = result(await admin.rpc('claim_agent_reply', { p_lease_seconds: 60 }), 'agent_reply_claim3');
    check(leased3?.turnId === turn3.id, 'agent_reply_claim3_matches_turn');

    const impact = await expectJson(
      await requestJson(requestApi, '/api/v1/privacy/impact', {
        token: owner.accessToken,
        method: 'POST',
        body: { scope: 'turn', targetId: turn3.id },
      }),
      200,
      check,
      'agent_reply_turn_delete_impact',
    );
    check(impact.scope === 'turn' && impact.counts?.turns >= 1, 'agent_reply_turn_delete_impact_count');

    const deleted = await expectJson(
      await requestJson(requestApi, '/api/v1/privacy/requests', {
        token: owner.accessToken,
        method: 'POST',
        body: { scope: 'turn', targetId: turn3.id, receiptId: randomUUID(), confirmed: true },
      }),
      200,
      check,
      'agent_reply_turn_delete',
    );
    check(deleted.status === 'live_deleted', 'agent_reply_turn_deleted');

    const afterDelete = await expectJson(
      await requestJson(requestApi, convPath, { token: owner.accessToken }),
      200,
      check,
      'agent_reply_after_delete_read',
    );
    check(!afterDelete.turns.some(t => t.id === turn3.id), 'agent_reply_turn_removed');

    checkRpcError(
      check,
      await admin.rpc('read_agent_reply_context', {
        p_reply_id: leased3.replyId,
        p_generation: leased3.generation,
        p_lease_token: leased3.leaseToken,
      }),
      'PT404',
      'agent_reply_deleted_context_404',
    );
    checkRpcError(
      check,
      await admin.rpc('complete_agent_reply', {
        p_reply_id: leased3.replyId,
        p_generation: leased3.generation,
        p_lease_token: leased3.leaseToken,
        p_status: 'rejected',
      }),
      'PT404',
      'agent_reply_deleted_complete_404',
    );
  } finally {
    // 검사 끝에 에이전트 기능 설정을 원래 값으로 되돌린다.
    const restored = result(
      await admin.rpc('configure_agent_settings', {
        p_enabled: originalSettings.enabled,
        p_model: originalSettings.model,
      }),
      'agent_reply_restore_settings',
    );
    check(
      restored?.enabled === originalSettings.enabled && restored.model === originalSettings.model,
      'agent_reply_restored_settings',
    );
  }

  // 원래 비활성 상태였다면 복원 후 제출한 턴에서 agentReply가 null인지 한 번 더 확인한다.
  if (!originalSettings.enabled) {
    const checkOff = await expectJson(
      await requestJson(requestApi, convPath, {
        token: owner.accessToken,
        method: 'POST',
        body: { requestId: randomUUID(), message: '설정 복원 확인 질문' },
      }),
      200,
      check,
      'agent_reply_verify_disabled',
    );
    check(checkOff.turns.at(-1)?.agentReply === null, 'agent_reply_disabled_restored');
  }
}
