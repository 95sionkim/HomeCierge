// 실제 로그인한 두 임시 계정으로 채팅 에이전트 확인 카드(대기열→합성 조건 제안→확인 시 맞춤 검색 실행·요약 기록, 거절 시 미실행, 타 계정 404)를 검수한다.
// 외부 LLM·청약홈 API는 호출하지 않으며 검사 끝에 에이전트 설정과(로컬 DB에서 바꾼 경우) 출처 권한을 원복한다.
import { randomUUID } from 'node:crypto';
import {
  UUID,
  checkNoStore,
  checkRpcError,
  checkServiceOnlyDenied,
  expectJson,
  isLoopbackOrigin,
  koreaDate,
  nextFreshObservedAt,
  requestJson,
  withLoopbackSources,
} from './smoke_helpers.mjs';

const VALID_MODELS = new Set(['gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-astra']);
const LOOPBACK_SOURCES = [
  ...['applyhome_apt', 'applyhome_remainder', 'applyhome_apt_model', 'applyhome_remainder_model', 'mois_legal_region_codes', 'applyhome_notice_pdf']
    .map(id => ({
      id,
      storage_permission: 'allowed',
      reuse_permission: 'allowed',
      display_permission: 'allowed',
      llm_permission: 'allowed',
    })),
  {
    id: 'naver_news',
    storage_permission: 'denied',
    reuse_permission: 'denied',
    display_permission: 'denied',
    llm_permission: 'denied',
  },
];

function buildSyntheticPublications(observed) {
  const day = koreaDate(observed);
  const start = koreaDate(new Date(observed.getTime() - 90 * 24 * 3600 * 1000));
  const ref = { document: 'applyhome:9900000101:9900000101:4:1', version: 'sha256:' + 'a'.repeat(64), page: 3 };
  const directory = {
    contractVersion: 'notice-search-index/v1',
    dataOrigin: 'collected',
    observedAt: observed.toISOString(),
    publicationWindow: { start, end: day },
    regionCodes: ['11200', '11215'],
    coverage: {
      status: 'complete',
      sources: [
        { source: 'applyhome_apt', status: 'complete' },
        { source: 'applyhome_remainder', status: 'complete' },
      ],
    },
    notices: [
      {
        houseManageNo: '9900000101',
        noticeNo: '9900000101',
        edition: day,
        title: '합성 가람 아파트',
        kind: 'new_sale',
        regionCode: '11200',
        moveIn: { start: '2027-06', end: '2027-06' },
        application: { start: day, end: day },
        inventoryComplete: false,
        models: [{ modelNo: '01', houseType: '084.0000A', supplyAreaM2: null, areaEvidence: [], rooms: [] }],
        sourceIds: ['applyhome_apt', 'applyhome_apt_model'],
        reasonCodes: [],
      },
      {
        houseManageNo: '9900000040',
        noticeNo: '9900000040',
        edition: day,
        title: '합성 센트럴 아이파크',
        kind: 'resupply',
        regionCode: '11215',
        moveIn: null,
        application: { start: day, end: day },
        inventoryComplete: false,
        models: [{ modelNo: '01', houseType: '084.9811C', supplyAreaM2: null, areaEvidence: [], rooms: [] }],
        sourceIds: ['applyhome_remainder', 'applyhome_remainder_model'],
        reasonCodes: [],
      },
    ],
  };
  const search = {
    ...directory,
    notices: [
      {
        ...directory.notices[0],
        inventoryComplete: true,
        models: [{
          modelNo: '01',
          houseType: '084.0000A',
          supplyAreaM2: '84',
          areaEvidence: [ref],
          rooms: [{ room: '101동 101호', subtotalWon: '700000000', priceEvidence: [ref] }],
        }],
        sourceIds: ['applyhome_apt', 'applyhome_apt_model', 'applyhome_notice_pdf'],
      },
      directory.notices[1],
    ],
  };
  return {
    directory,
    search,
    regions: { '11200': '서울특별시 성동구', '11215': '서울특별시 광진구' },
    proposedConditions: {
      regionCodes: ['11200', '11215'],
      budgetMaxWon: '700000000',
      includeClosed: false,
    },
    rejectConditions: {
      regionCodes: ['11215'],
      budgetMaxWon: '600000000',
      includeClosed: false,
    },
  };
}

export async function checkChatAgent({ config, accounts, admin, requestApi, freshToken, check, result }) {
  const [owner, peer] = accounts;
  const loopback = isLoopbackOrigin(config.origin);

  await withLoopbackSources(admin, config.origin, LOOPBACK_SOURCES, check, result, 'chat_agent', async () => {
    let proposedConditions;
    let rejectConditions;

    if (loopback) {
      const observed = await nextFreshObservedAt(owner.client, ['read_notice_directory_index', 'read_notice_search_index']);
      const pub = buildSyntheticPublications(observed);
      result(
        await admin.rpc('publish_notice_directory', { p_index: pub.directory, p_regions: pub.regions }),
        'chat_agent_publish_directory',
      );
      result(
        await admin.rpc('publish_notice_search_index', { p_index: pub.search }),
        'chat_agent_publish_search_index',
      );
      proposedConditions = pub.proposedConditions;
      rejectConditions = pub.rejectConditions;
    } else {
      const regionsRes = await expectJson(
        await requestJson(requestApi, '/api/v1/notices/regions', { token: owner.accessToken }),
        200,
        check,
        'chat_agent_hosted_regions',
      );
      const firstCode = regionsRes.regions?.[0]?.code;
      check(typeof firstCode === 'string' && /^[0-9]{5}$/.test(firstCode), 'chat_agent_hosted_region_code');
      proposedConditions = { regionCodes: [firstCode], budgetMaxWon: '700000000', includeClosed: true };
      rejectConditions = { regionCodes: [firstCode], budgetMaxWon: '600000000', includeClosed: true };
      const probeSearch = await requestJson(requestApi, '/api/v1/notices/search', {
        token: owner.accessToken,
        method: 'POST',
        body: proposedConditions,
      });
      check(probeSearch.status === 200, 'chat_agent_hosted_search_index_ready');
      await probeSearch.body?.cancel();
    }

    // 1) 일반 사용자는 채팅 에이전트 작업자 RPC를 호출할 수 없다.
    for (const [client, tag] of [[owner.client, 'owner'], [peer.client, 'peer']]) {
      checkServiceOnlyDenied(
        check,
        await client.rpc('claim_chat_agent_reply', { p_lease_seconds: 60 }),
        `chat_agent_${tag}_claim_denied`,
      );
      checkServiceOnlyDenied(
        check,
        await client.rpc('expire_stale_chat_agent_replies'),
        `chat_agent_${tag}_expire_denied`,
      );
      checkServiceOnlyDenied(
        check,
        await client.rpc('read_chat_agent_reply_context', {
          p_reply_id: randomUUID(),
          p_generation: 1,
          p_lease_token: randomUUID(),
        }),
        `chat_agent_${tag}_context_denied`,
      );
      checkServiceOnlyDenied(
        check,
        await client.rpc('fail_chat_agent_reply', {
          p_reply_id: randomUUID(),
          p_generation: 1,
          p_lease_token: randomUUID(),
          p_failure_code: 'llm_timeout',
        }),
        `chat_agent_${tag}_fail_denied`,
      );
    }

    // 2) 설정 변경 전 탐침 메시지로 기존 agent_settings 상태를 관찰하고 즉시 삭제한다.
    const probeMsg = await expectJson(
      await requestJson(requestApi, `/api/v1/chats/${owner.chatId}/messages`, {
        token: owner.accessToken,
        method: 'POST',
        body: { requestId: randomUUID(), message: '도움말' },
      }),
      200,
      check,
      'chat_agent_probe_message',
    );
    const originalSettings = probeMsg.agentReply
      ? {
          enabled: true,
          model: VALID_MODELS.has(probeMsg.agentReply.model) ? probeMsg.agentReply.model : 'gpt-6.2-sol',
        }
      : { enabled: false, model: 'gpt-6.2-sol' };

    const probeDelete = await expectJson(
      await requestJson(requestApi, '/api/v1/privacy/requests', {
        token: owner.accessToken,
        method: 'POST',
        body: { scope: 'message', targetId: probeMsg.userMessage.id, receiptId: randomUUID(), confirmed: true },
      }),
      200,
      check,
      'chat_agent_probe_delete',
    );
    check(probeDelete.status === 'live_deleted', 'chat_agent_probe_deleted');

    // 3) 에이전트 활성화 후 확인 카드 흐름을 검수하고 종료 시 설정을 원복한다.
    const enabledSettings = result(
      await admin.rpc('configure_agent_settings', { p_enabled: true, p_model: 'gpt-6.2-sol' }),
      'chat_agent_enable',
    );
    check(enabledSettings?.enabled === true && enabledSettings.model === 'gpt-6.2-sol', 'chat_agent_enabled_state');

    try {
      const chatCreated = await expectJson(
        await requestJson(requestApi, '/api/v1/chats', {
          token: owner.accessToken,
          method: 'POST',
          body: { requestId: randomUUID(), title: '합성 채팅 에이전트 검수' },
        }),
        201,
        check,
        'chat_agent_create_chat',
      );
      const chatId = chatCreated.chat.chatId;
      const profileBefore = result(await owner.client.rpc('read_search_profile', {}), 'chat_agent_profile_before');

      // 3-1) 메시지 1 제출 → queued 대기열 생성 → 서비스 키로 임대·문맥 조회·합성 확인 카드 완료
      const msg1 = await expectJson(
        await requestJson(requestApi, `/api/v1/chats/${chatId}/messages`, {
          token: owner.accessToken,
          method: 'POST',
          body: { requestId: randomUUID(), message: '희망 지역에서 7억 이하 공고를 찾아줘' },
        }),
        200,
        check,
        'chat_agent_msg1',
      );
      const reply1Id = msg1.agentReply?.id;
      check(
        UUID.test(reply1Id)
          && msg1.agentReply.status === 'queued'
          && msg1.agentReply.model === 'gpt-6.2-sol',
        'chat_agent_msg1_queued',
      );

      const job1 = result(
        await admin.rpc('claim_chat_agent_reply', { p_lease_seconds: 60, p_reply_id: reply1Id }),
        'chat_agent_claim1',
      );
      check(job1?.replyId === reply1Id && job1.generation === 1 && job1.model === 'gpt-6.2-sol', 'chat_agent_claim1_identity');

      const ctx1 = result(
        await admin.rpc('read_chat_agent_reply_context', {
          p_reply_id: job1.replyId,
          p_generation: job1.generation,
          p_lease_token: job1.leaseToken,
        }),
        'chat_agent_context1',
      );
      check(ctx1?.llmSourcePolicy?.newsExcluded === true && ctx1.message === '희망 지역에서 7억 이하 공고를 찾아줘', 'chat_agent_context1_shape');

      const comp1 = result(
        await admin.rpc('complete_chat_agent_reply', {
          p_reply_id: job1.replyId,
          p_generation: job1.generation,
          p_lease_token: job1.leaseToken,
          p_status: 'answered',
          p_intent: 'search_confirm',
          p_answer: '예산 700,000,000원 조건으로 맞춤 검색 확인 카드를 준비했습니다. 확인을 누르면 검색을 실행합니다.',
          p_citations: [{ kind: 'region', reference: proposedConditions.regionCodes.join(','), label: '공식 지역 코드' }],
          p_search_proposal: proposedConditions,
          p_profile_proposal: {
            patch: { budget_max_won: '700000000' },
            reason: '합성 채팅 조건 재사용 제안',
          },
          p_lookup_query: null,
          p_usage: { inputTokens: 350, outputTokens: 110, latencyMs: 210, estimatedCostUsd: '0.00180000', pricingAsOf: '2026-11-26' },
          p_validation: { status: 'passed', reasons: [] },
          p_prompt_version: 'chat-agent-v1',
        }),
        'chat_agent_complete1',
      );
      check(comp1?.status === 'answered' && comp1.searchProposalAttached === true && UUID.test(comp1.profileChangeRequestId), 'chat_agent_comp1_done');

      // 공유 프로필은 자동 승인되지 않고 pending 변경안으로만 남는다.
      const profileMid = result(await owner.client.rpc('read_search_profile', {}), 'chat_agent_profile_mid');
      check(
        profileMid.revision === profileBefore.revision
          && profileMid.proposals.some(p => p.id === comp1.profileChangeRequestId && p.status === 'pending'),
        'chat_agent_profile_pending_only',
      );

      // 3-2) 타 계정은 채팅 상세와 확인 카드 결정 모두 404
      check((await requestJson(requestApi, `/api/v1/chats/${chatId}`, { token: peer.accessToken })).status === 404, 'chat_agent_peer_detail_404');
      check(
        (await requestJson(requestApi, `/api/v1/chats/${chatId}/replies/${reply1Id}/decision`, {
          token: peer.accessToken,
          method: 'POST',
          body: { decision: 'confirm' },
        })).status === 404,
        'chat_agent_peer_confirm_404',
      );
      check(
        (await requestJson(requestApi, `/api/v1/chats/${chatId}/replies/${reply1Id}/decision`, {
          token: peer.accessToken,
          method: 'POST',
          body: { decision: 'reject' },
        })).status === 404,
        'chat_agent_peer_reject_404',
      );

      // 3-3) 소유자 확인(confirm) → 맞춤 검색 실행 + 채팅에 결과 요약 메시지 기록 + 멱등 재확인 + 조건 충돌 409
      const confirmReply = await requestJson(requestApi, `/api/v1/chats/${chatId}/replies/${reply1Id}/decision`, {
        token: owner.accessToken,
        method: 'POST',
        body: { decision: 'confirm' },
      });
      checkNoStore(confirmReply, check, 'chat_agent_confirm');
      const confirmed = await expectJson(confirmReply, 200, check, 'chat_agent_confirm');
      check(
        confirmed.contractVersion === 'chat-search-decision/v1'
          && confirmed.agentReply?.searchProposal?.status === 'confirmed'
          && confirmed.agentReply.searchProposal.resultSummary?.contractVersion === 'chat-search-summary/v1'
          && confirmed.searchResult?.contractVersion === 'notice-search/v1'
          && UUID.test(confirmed.resultMessage?.id)
          && confirmed.resultMessage.role === 'assistant',
        'chat_agent_confirmed_shape',
      );
      if (loopback) {
        check(
          confirmed.searchResult.counts.matched === 1
            && confirmed.searchResult.counts.needsReview === 1
            && confirmed.resultMessage.content.includes('조건 충족 1건, 확인 필요 1건'),
          'chat_agent_confirmed_counts',
        );
      }

      const reconfirmed = await expectJson(
        await requestJson(requestApi, `/api/v1/chats/${chatId}/replies/${reply1Id}/decision`, {
          token: owner.accessToken,
          method: 'POST',
          body: { decision: 'confirm' },
        }),
        200,
        check,
        'chat_agent_confirm_replay',
      );
      check(reconfirmed.resultMessage?.id === confirmed.resultMessage.id, 'chat_agent_confirm_idempotent');

      const conflictConfirm = await requestJson(requestApi, `/api/v1/chats/${chatId}/replies/${reply1Id}/decision`, {
        token: owner.accessToken,
        method: 'POST',
        body: { decision: 'confirm', conditions: { ...proposedConditions, budgetMaxWon: '800000000' } },
      });
      check(conflictConfirm.status === 409, 'chat_agent_confirm_conflict_409');
      await conflictConfirm.body?.cancel();

      // 3-4) 메시지 2 거절(reject) → 맞춤 검색 미실행 + 결과 메시지 미생성 + 이후 확인 409
      const msg2 = await expectJson(
        await requestJson(requestApi, `/api/v1/chats/${chatId}/messages`, {
          token: owner.accessToken,
          method: 'POST',
          body: { requestId: randomUUID(), message: '6억 이하로도 찾아줘' },
        }),
        200,
        check,
        'chat_agent_msg2',
      );
      const reply2Id = msg2.agentReply?.id;
      check(UUID.test(reply2Id), 'chat_agent_msg2_queued');
      const job2 = result(
        await admin.rpc('claim_chat_agent_reply', { p_lease_seconds: 60, p_reply_id: reply2Id }),
        'chat_agent_claim2',
      );
      result(
        await admin.rpc('complete_chat_agent_reply', {
          p_reply_id: job2.replyId,
          p_generation: job2.generation,
          p_lease_token: job2.leaseToken,
          p_status: 'answered',
          p_intent: 'search_confirm',
          p_answer: '예산 600,000,000원 조건으로 확인 카드를 준비했습니다.',
          p_citations: [],
          p_search_proposal: rejectConditions,
          p_profile_proposal: null,
          p_lookup_query: null,
          p_usage: {},
          p_validation: { status: 'passed', reasons: [] },
          p_prompt_version: 'chat-agent-v1',
        }),
        'chat_agent_complete2',
      );

      const beforeRejectDetail = await expectJson(
        await requestJson(requestApi, `/api/v1/chats/${chatId}`, { token: owner.accessToken }),
        200,
        check,
        'chat_agent_before_reject',
      );
      const countBeforeReject = beforeRejectDetail.messages.length;

      const rejected = await expectJson(
        await requestJson(requestApi, `/api/v1/chats/${chatId}/replies/${reply2Id}/decision`, {
          token: owner.accessToken,
          method: 'POST',
          body: { decision: 'reject' },
        }),
        200,
        check,
        'chat_agent_reject',
      );
      check(
        rejected.agentReply?.searchProposal?.status === 'rejected'
          && rejected.resultMessage === null
          && rejected.searchResult === null,
        'chat_agent_rejected_no_execution',
      );

      const afterRejectDetail = await expectJson(
        await requestJson(requestApi, `/api/v1/chats/${chatId}`, { token: owner.accessToken }),
        200,
        check,
        'chat_agent_after_reject',
      );
      check(afterRejectDetail.messages.length === countBeforeReject, 'chat_agent_rejected_no_summary_message');

      check(
        (await requestJson(requestApi, `/api/v1/chats/${chatId}/replies/${reply2Id}/decision`, {
          token: owner.accessToken,
          method: 'POST',
          body: { decision: 'confirm' },
        })).status === 409,
        'chat_agent_rejected_confirm_409',
      );

      // 3-5) 새 세션 복원 확인(요약 메시지와 확인/거절 상태 유지)
      const freshOwnerToken = await freshToken(owner);
      const reopened = await expectJson(
        await requestJson(requestApi, `/api/v1/chats/${chatId}`, { token: freshOwnerToken }),
        200,
        check,
        'chat_agent_reopen',
      );
      check(
        reopened.messages.some(m => m.id === confirmed.resultMessage.id)
          && reopened.messages.find(m => m.id === msg1.userMessage.id)?.agentReply?.searchProposal?.status === 'confirmed'
          && reopened.messages.find(m => m.id === msg2.userMessage.id)?.agentReply?.searchProposal?.status === 'rejected',
        'chat_agent_reopen_states',
      );

      // 3-6) 메시지 삭제 시 임대 중인 채팅 에이전트 응답도 함께 삭제된다(PT404).
      const msg3 = await expectJson(
        await requestJson(requestApi, `/api/v1/chats/${chatId}/messages`, {
          token: owner.accessToken,
          method: 'POST',
          body: { requestId: randomUUID(), message: '삭제할 탐색 질문입니다' },
        }),
        200,
        check,
        'chat_agent_msg3',
      );
      const job3 = result(
        await admin.rpc('claim_chat_agent_reply', { p_lease_seconds: 60, p_reply_id: msg3.agentReply.id }),
        'chat_agent_claim3',
      );
      const delMsg3 = await expectJson(
        await requestJson(requestApi, '/api/v1/privacy/requests', {
          token: owner.accessToken,
          method: 'POST',
          body: { scope: 'message', targetId: msg3.userMessage.id, receiptId: randomUUID(), confirmed: true },
        }),
        200,
        check,
        'chat_agent_delete_msg3',
      );
      check(delMsg3.status === 'live_deleted', 'chat_agent_deleted_msg3');
      checkRpcError(
        check,
        await admin.rpc('read_chat_agent_reply_context', {
          p_reply_id: job3.replyId,
          p_generation: job3.generation,
          p_lease_token: job3.leaseToken,
        }),
        'PT404',
        'chat_agent_deleted_context_404',
      );
    } finally {
      const restored = result(
        await admin.rpc('configure_agent_settings', {
          p_enabled: originalSettings.enabled,
          p_model: originalSettings.model,
        }),
        'chat_agent_restore_settings',
      );
      check(
        restored?.enabled === originalSettings.enabled && restored.model === originalSettings.model,
        'chat_agent_restored_settings',
      );
    }
  });
}
