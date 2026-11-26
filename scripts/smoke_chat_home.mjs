// 실제 로그인한 두 임시 계정으로 채팅 홈·공고 찾기·채팅 내 분석 시작·계정 전환 복원을 검수한다.
// 외부 청약홈 API는 호출하지 않으며, 로컬 격리 DB에서는 합성 디렉터리를 게시하고 호스팅 개발 DB에서는 기존 디렉터리를 읽는다.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  UUID,
  checkNoStore,
  expectJson,
  isLoopbackOrigin,
  koreaDate,
  nextFreshObservedAt,
  requestJson,
  withLoopbackSources,
} from './smoke_helpers.mjs';

const LOOPBACK_SOURCES = [
  'applyhome_apt',
  'applyhome_remainder',
  'applyhome_apt_model',
  'applyhome_remainder_model',
  'mois_legal_region_codes',
  'apt_trade',
  'apt_rights',
].map(id => ({ id, storage_permission: 'allowed', reuse_permission: 'allowed', display_permission: 'allowed' }));

function buildSyntheticDirectory(observed) {
  const day = koreaDate(observed);
  const start = koreaDate(new Date(observed.getTime() - 90 * 24 * 3600 * 1000));
  const earlier = koreaDate(new Date(observed.getTime() - 60 * 24 * 3600 * 1000));
  return {
    index: {
      contractVersion: 'notice-search-index/v1',
      dataOrigin: 'collected',
      observedAt: observed.toISOString(),
      publicationWindow: { start, end: day },
      regionCodes: ['11215'],
      coverage: {
        status: 'complete',
        sources: [
          { source: 'applyhome_apt', status: 'complete' },
          { source: 'applyhome_remainder', status: 'complete' },
        ],
      },
      notices: [
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
        {
          houseManageNo: '9900000019',
          noticeNo: '9900000019',
          edition: earlier,
          title: '합성 센트럴 아이파크',
          kind: 'resupply',
          regionCode: '11215',
          moveIn: null,
          application: { start: earlier, end: earlier },
          inventoryComplete: false,
          models: [],
          sourceIds: ['applyhome_remainder'],
          reasonCodes: ['model_unverified'],
        },
        {
          houseManageNo: '9900000101',
          noticeNo: '9900000101',
          edition: day,
          title: '합성 가람 아파트',
          kind: 'new_sale',
          regionCode: '11215',
          moveIn: null,
          application: { start: day, end: day },
          inventoryComplete: false,
          models: [{ modelNo: '01', houseType: '084.0000A', supplyAreaM2: null, areaEvidence: [], rooms: [] }],
          sourceIds: ['applyhome_apt', 'applyhome_apt_model'],
          reasonCodes: [],
        },
        {
          houseManageNo: '9900000999',
          noticeNo: '9900000999',
          edition: day,
          title: '합성 제외 유형 공고',
          kind: 'unsupported',
          regionCode: '11215',
          moveIn: null,
          application: { start: day, end: day },
          inventoryComplete: false,
          models: [],
          sourceIds: ['applyhome_apt'],
          reasonCodes: ['notice_kind_unsupported'],
        },
      ],
    },
    regions: { '11215': '서울특별시 광진구' },
    lookupName: '합성 센트럴 아이파크',
    lookupNumber: '9900000040',
    analysisInput: {
      kind: 'notice',
      noticeSource: 'applyhome_remainder',
      houseManageNo: '9900000040',
      noticeNo: '9900000040',
      edition: day,
      modelNo: '01',
    },
  };
}

export async function checkChatHome({ config, accounts, admin, requestApi, freshToken, check, result }) {
  const [owner, peer] = accounts;
  const loopback = isLoopbackOrigin(config.origin);

  await withLoopbackSources(admin, config.origin, LOOPBACK_SOURCES, check, result, 'chat_home', async () => {
    let lookupName;
    let lookupNumber;
    let analysisInput;

    if (loopback) {
      const observed = await nextFreshObservedAt(owner.client, ['read_notice_directory_index']);
      const fixture = buildSyntheticDirectory(observed);
      result(
        await admin.rpc('publish_notice_directory', { p_index: fixture.index, p_regions: fixture.regions }),
        'chat_home_publish_directory',
      );
      ({ lookupName, lookupNumber, analysisInput } = fixture);
    } else {
      const dirReply = await requestJson(requestApi, '/api/v1/notices', { token: owner.accessToken });
      const dirBody = await expectJson(dirReply, 200, check, 'chat_home_read_hosted_directory');
      const candidate = (dirBody.notices ?? []).find(
        notice => typeof notice.title === 'string' && notice.title.trim().length > 0
          && Array.from(notice.title.trim()).length <= 120
          && Array.isArray(notice.models) && notice.models.some(model => model.analysisInput !== null),
      );
      check(Boolean(candidate), 'chat_home_hosted_notice_required');
      const selectedModel = candidate.models.find(model => model.analysisInput !== null);
      lookupName = candidate.title;
      lookupNumber = candidate.noticeNo;
      analysisInput = selectedModel.analysisInput;
    }

    // 1) 미인증 차단
    const unauth = await requestJson(requestApi, '/api/v1/chats');
    check(unauth.status === 401, 'chat_home_unauthenticated');
    await unauth.body?.cancel();

    // 2) 채팅 생성 + 같은 요청 키 멱등성 + 충돌 409
    const createKey = randomUUID();
    const createdReply = await requestJson(requestApi, '/api/v1/chats', {
      token: owner.accessToken,
      method: 'POST',
      body: { requestId: createKey, title: '합성 채팅 홈 검수' },
    });
    checkNoStore(createdReply, check, 'chat_home_create');
    const created = await expectJson(createdReply, 201, check, 'chat_home_create');
    const chatId = created.chat?.chatId;
    check(
      created.contractVersion === 'chat-home/v1'
        && UUID.test(chatId)
        && created.chat.title === '합성 채팅 홈 검수'
        && createdReply.headers.get('location') === `/api/v1/chats/${chatId}`,
      'chat_home_create_shape',
    );

    const replayReply = await requestJson(requestApi, '/api/v1/chats', {
      token: owner.accessToken,
      method: 'POST',
      body: { requestId: createKey, title: '합성 채팅 홈 검수' },
    });
    const replayed = await expectJson(replayReply, 201, check, 'chat_home_create_replay');
    check(replayed.chat?.chatId === chatId && replayed.chat.title === created.chat.title, 'chat_home_create_idempotent');

    const conflictReply = await requestJson(requestApi, '/api/v1/chats', {
      token: owner.accessToken,
      method: 'POST',
      body: { requestId: createKey, title: '다른 합성 제목' },
    });
    check(conflictReply.status === 409, 'chat_home_create_conflict');
    await conflictReply.body?.cancel();

    const secondCreated = await expectJson(
      await requestJson(requestApi, '/api/v1/chats', {
        token: owner.accessToken,
        method: 'POST',
        body: { requestId: randomUUID(), title: null },
      }),
      201,
      check,
      'chat_home_create_default_title',
    );
    const secondChatId = secondCreated.chat?.chatId;
    check(UUID.test(secondChatId) && secondCreated.chat.title === '새 채팅', 'chat_home_default_title');

    // 3) 목록·커서 페이지네이션 + 타 계정 격리
    const page1 = await expectJson(
      await requestJson(requestApi, '/api/v1/chats?limit=2', { token: owner.accessToken }),
      200,
      check,
      'chat_home_list_page1',
    );
    check(page1.contractVersion === 'chat-home/v1' && page1.chats.length === 2 && UUID.test(page1.nextCursor), 'chat_home_list_cursor');
    const page2 = await expectJson(
      await requestJson(requestApi, `/api/v1/chats?limit=2&before=${page1.nextCursor}`, { token: owner.accessToken }),
      200,
      check,
      'chat_home_list_page2',
    );
    const listedIds = new Set([...page1.chats, ...page2.chats].map(item => item.chatId));
    check(listedIds.has(chatId) && listedIds.has(secondChatId) && listedIds.has(owner.chatId), 'chat_home_list_all');

    const peerList = await expectJson(
      await requestJson(requestApi, '/api/v1/chats', { token: peer.accessToken }),
      200,
      check,
      'chat_home_peer_list',
    );
    check(
      !peerList.chats.some(item => item.chatId === chatId || item.chatId === secondChatId || item.chatId === owner.chatId),
      'chat_home_peer_list_isolated',
    );

    // 4) 이름 변경 + 타 계정 404
    const renamed = await expectJson(
      await requestJson(requestApi, `/api/v1/chats/${chatId}`, {
        token: owner.accessToken,
        method: 'PATCH',
        body: { title: '이름 바꾼 합성 채팅' },
      }),
      200,
      check,
      'chat_home_rename',
    );
    check(renamed.chat?.chatId === chatId && renamed.chat.title === '이름 바꾼 합성 채팅', 'chat_home_renamed_title');

    check((await requestJson(requestApi, `/api/v1/chats/${chatId}`, { token: peer.accessToken })).status === 404, 'chat_home_peer_detail_404');
    check(
      (await requestJson(requestApi, `/api/v1/chats/${chatId}`, {
        token: peer.accessToken,
        method: 'PATCH',
        body: { title: '타 계정 변경 시도' },
      })).status === 404,
      'chat_home_peer_rename_404',
    );

    // 5) 공고 찾기(이름·번호)
    const nameLookup = await expectJson(
      await requestJson(requestApi, `/api/v1/notices/lookup?q=${encodeURIComponent(lookupName)}&mode=name`, { token: owner.accessToken }),
      200,
      check,
      'chat_home_lookup_name',
    );
    check(nameLookup.contractVersion === 'notice-lookup/v1' && nameLookup.counts.matched >= 1, 'chat_home_lookup_name_matched');
    if (loopback) {
      check(
        nameLookup.counts.matched === 2
          && nameLookup.counts.sameTitleGroups === 1
          && nameLookup.notices.every(notice => notice.sameTitleCount === 2),
        'chat_home_lookup_same_title_editions',
      );
    }

    const numLookup = await expectJson(
      await requestJson(requestApi, `/api/v1/notices/lookup?q=${encodeURIComponent(lookupNumber)}&mode=number`, { token: owner.accessToken }),
      200,
      check,
      'chat_home_lookup_number',
    );
    check(numLookup.notices.some(notice => notice.noticeNo === lookupNumber), 'chat_home_lookup_number_matched');

    // 6) 메시지 기록 + 같은 요청 키 멱등성 + 충돌 + RLS 직접 assistant 삽입 차단 + 타 계정 404
    const msgKey = randomUUID();
    const postedReply = await requestJson(requestApi, `/api/v1/chats/${chatId}/messages`, {
      token: owner.accessToken,
      method: 'POST',
      body: { requestId: msgKey, message: lookupName, mode: 'name' },
    });
    checkNoStore(postedReply, check, 'chat_home_message');
    const posted = await expectJson(postedReply, 200, check, 'chat_home_message');
    check(
      posted.contractVersion === 'chat-message/v1'
        && posted.chatId === chatId
        && posted.userMessage?.role === 'user'
        && posted.assistantMessage?.role === 'assistant'
        && posted.lookup !== null
        && posted.lookupError === null,
      'chat_home_message_shape',
    );
    if (loopback) {
      check(
        posted.assistantMessage.content.includes('총 2건') && posted.assistantMessage.content.includes('합치지 않았습니다'),
        'chat_home_message_edition_grounding',
      );
    }

    const msgReplay = await expectJson(
      await requestJson(requestApi, `/api/v1/chats/${chatId}/messages`, {
        token: owner.accessToken,
        method: 'POST',
        body: { requestId: msgKey, message: lookupName, mode: 'name' },
      }),
      200,
      check,
      'chat_home_message_replay',
    );
    check(
      msgReplay.userMessage.id === posted.userMessage.id && msgReplay.assistantMessage.id === posted.assistantMessage.id,
      'chat_home_message_idempotent',
    );

    const msgConflict = await requestJson(requestApi, `/api/v1/chats/${chatId}/messages`, {
      token: owner.accessToken,
      method: 'POST',
      body: { requestId: msgKey, message: '다른 합성 메시지' },
    });
    check(msgConflict.status === 409, 'chat_home_message_conflict');
    await msgConflict.body?.cancel();

    const helpMsg = await expectJson(
      await requestJson(requestApi, `/api/v1/chats/${chatId}/messages`, {
        token: owner.accessToken,
        method: 'POST',
        body: { requestId: randomUUID(), message: '여기 청약 자격 되나요?' },
      }),
      200,
      check,
      'chat_home_help_message',
    );
    check(helpMsg.assistantMessage.content.includes('개인 청약 자격 판정'), 'chat_home_help_boundary');

    check(
      (await requestJson(requestApi, `/api/v1/chats/${chatId}/messages`, {
        token: peer.accessToken,
        method: 'POST',
        body: { requestId: randomUUID(), message: '타 계정 메시지 시도' },
      })).status === 404,
      'chat_home_peer_message_404',
    );

    const directAssistant = await owner.client.from('chat_messages').insert({
      user_id: owner.id,
      chat_id: chatId,
      role: 'assistant',
      content: '위조 서버 응답',
    });
    check(Boolean(directAssistant.error), 'chat_home_direct_assistant_blocked');

    // 7) 채팅 안에서 분석 시작(start_chat_notice_workspace) + 같은 키 멱등성 + 교차 채팅 충돌 + 타 계정 404
    const startKey = randomUUID();
    check(
      (await requestJson(requestApi, `/api/v1/chats/${chatId}/analyses`, {
        token: peer.accessToken,
        method: 'POST',
        body: { requestId: randomUUID(), input: analysisInput },
      })).status === 404,
      'chat_home_peer_start_analysis_404',
    );

    const startedReply = await requestJson(requestApi, `/api/v1/chats/${chatId}/analyses`, {
      token: owner.accessToken,
      method: 'POST',
      body: { requestId: startKey, input: analysisInput },
    });
    const started = await expectJson(startedReply, 202, check, 'chat_home_start_analysis');
    check(
      started.chatId === chatId
        && UUID.test(started.analysisId)
        && UUID.test(started.runId)
        && started.status === 'queued'
        && isDeepStrictEqual(started.input, analysisInput)
        && startedReply.headers.get('location') === `/api/v1/analyses/${started.analysisId}/runs/${started.runId}`,
      'chat_home_start_analysis_shape',
    );

    const startReplay = await expectJson(
      await requestJson(requestApi, `/api/v1/chats/${chatId}/analyses`, {
        token: owner.accessToken,
        method: 'POST',
        body: { requestId: startKey, input: analysisInput },
      }),
      202,
      check,
      'chat_home_start_analysis_replay',
    );
    check(
      startReplay.analysisId === started.analysisId && startReplay.runId === started.runId,
      'chat_home_start_analysis_idempotent',
    );

    const crossChatConflict = await requestJson(requestApi, `/api/v1/chats/${secondChatId}/analyses`, {
      token: owner.accessToken,
      method: 'POST',
      body: { requestId: startKey, input: analysisInput },
    });
    check(crossChatConflict.status === 409, 'chat_home_start_cross_chat_conflict');
    await crossChatConflict.body?.cancel();

    // 외부 API 작업자가 실행을 인수하지 않도록 즉시 취소한다.
    const cancelReply = await requestJson(
      requestApi,
      `/api/v1/analyses/${started.analysisId}/runs/${started.runId}/cancel`,
      { token: owner.accessToken, method: 'POST' },
    );
    check(loopback ? cancelReply.status === 200 : [200, 409].includes(cancelReply.status), 'chat_home_cancel_queued_run');
    await cancelReply.body?.cancel();

    // 8) 계정 전환(peer 로그인) 후 원래 소유자 재로그인 복원 확인
    const freshPeerToken = await freshToken(peer);
    check((await requestJson(requestApi, `/api/v1/chats/${chatId}`, { token: freshPeerToken })).status === 404, 'chat_home_switched_peer_404');

    const freshOwnerToken = await freshToken(owner);
    const restoredList = await expectJson(
      await requestJson(requestApi, '/api/v1/chats', { token: freshOwnerToken }),
      200,
      check,
      'chat_home_restored_list',
    );
    const restoredSummary = restoredList.chats.find(item => item.chatId === chatId);
    check(
      restoredSummary?.title === '이름 바꾼 합성 채팅'
        && restoredSummary.analysisCount === 1
        && restoredSummary.messageCount === 4,
      'chat_home_restored_summary',
    );

    const restoredDetail = await expectJson(
      await requestJson(requestApi, `/api/v1/chats/${chatId}`, { token: freshOwnerToken }),
      200,
      check,
      'chat_home_restored_detail',
    );
    check(
      restoredDetail.chat?.title === '이름 바꾼 합성 채팅'
        && restoredDetail.messages.length === 4
        && restoredDetail.messages[0].id === posted.userMessage.id
        && restoredDetail.messages[1].id === posted.assistantMessage.id
        && restoredDetail.analyses.length === 1
        && restoredDetail.analyses[0].analysisId === started.analysisId
        && restoredDetail.analyses[0].latestRunId === started.runId,
      'chat_home_restored_contents',
    );
  });
}
