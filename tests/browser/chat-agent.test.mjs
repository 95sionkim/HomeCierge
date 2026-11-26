// 실제 네트워크·외부 LLM 호출 없이 채팅 홈 총괄 에이전트 UI(AI 응답·모델명·확인 카드·수정·거절·취소·
// 검색 결과 요약·O-3 공유 프로필 연동·작성 중 미표시 조건)를 데스크톱(1440px)·모바일(390px)에서 검사한다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { createDevServer } from '../../dev/server.ts';
import { serveWorkspace } from '../../dev/static.ts';
import { createHandler } from '../../src/server/handler.ts';
import { ApiError } from '../../src/server/http-input.ts';

const OWNER = { id: 'a1000000-0000-4000-8000-000000000011', email: 'chat-agent@example.invalid', token: 'SYNTHETIC_CHAT_AGENT_TOKEN' };
const OBSERVED_AT = '2026-11-22T00:17:00+09:00';
const PUB_WINDOW = { start: '2026-08-25', end: '2026-11-22' };
const DOC_REF = {
  document: 'applyhome:9900000101:9900000101:1:1',
  version: 'sha256:' + 'a'.repeat(64),
  page: 3,
};

function makeSyntheticSearchIndex() {
  return {
    contractVersion: 'notice-search-index/v1',
    dataOrigin: 'collected',
    observedAt: OBSERVED_AT,
    publicationWindow: PUB_WINDOW,
    regionCodes: ['11200', '11215', '11680'],
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
        edition: '2026-11-10',
        title: '합성 가람 아파트',
        kind: 'new_sale',
        regionCode: '11200',
        application: { start: '2026-11-20', end: '2026-11-24' },
        moveIn: { start: '2027-06', end: '2027-06' },
        inventoryComplete: true,
        models: [
          {
            modelNo: '01',
            houseType: '084.0000A',
            supplyAreaM2: '84',
            areaEvidence: [DOC_REF],
            rooms: [{ room: '101동 501호', subtotalWon: '680000000', priceEvidence: [DOC_REF] }],
          },
        ],
        sourceIds: ['applyhome_apt', 'applyhome_apt_model', 'applyhome_notice_pdf'],
        reasonCodes: [],
      },
      {
        houseManageNo: '9900000040',
        noticeNo: '9900000040',
        edition: '2026-10-23',
        title: '합성 센트럴 아이파크',
        kind: 'resupply',
        regionCode: '11215',
        application: { start: '2026-11-20', end: '2026-11-25' },
        moveIn: null,
        inventoryComplete: false,
        models: [{ modelNo: '01', houseType: '084.9811C', supplyAreaM2: null, areaEvidence: [], rooms: [] }],
        sourceIds: ['applyhome_remainder', 'applyhome_remainder_model'],
        reasonCodes: ['inventory_incomplete'],
      },
    ],
  };
}

function makeSyntheticDirectoryIndex() {
  return {
    ...makeSyntheticSearchIndex(),
    regionNames: {
      '11200': '서울특별시 성동구',
      '11215': '서울특별시 광진구',
      '11680': '서울특별시 강남구',
    },
  };
}

function createAgentChatStore() {
  const chats = new Map();
  const messages = new Map();
  const replies = new Map();
  const searchIndex = makeSyntheticSearchIndex();
  const directoryIndex = makeSyntheticDirectoryIndex();
  let tick = Date.parse('2026-11-22T01:00:00Z');
  const nextIso = () => new Date((tick += 1000)).toISOString();
  let searchExecutions = 0;

  const profileChangeId = randomUUID();
  const profileState = {
    revision: 1,
    updatedAt: '2026-11-21T09:00:00Z',
    conditions: { region_codes: ['11215'], budget_max_won: '900000000' },
    proposals: [
      {
        id: profileChangeId,
        baseRevision: 1,
        previous: { region_codes: ['11215'], budget_max_won: '900000000' },
        patch: { region_codes: ['11200', '11215'], budget_max_won: '700000000' },
        reason: '채팅에서 요청한 탐색 조건 재사용',
        status: 'pending',
        createdAt: '2026-11-22T01:00:05Z',
        decidedAt: null,
        analysisId: null,
        runId: null,
      },
    ],
  };

  function summaryFor(chat) {
    const msgs = messages.get(chat.chatId) ?? [];
    const last = msgs.at(-1) ?? null;
    return {
      chatId: chat.chatId,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      lastActivityAt: last?.createdAt ?? chat.updatedAt,
      messageCount: msgs.length,
      analysisCount: 0,
      lastMessagePreview: last?.content?.slice(0, 120) ?? null,
      latestAnalysis: null,
    };
  }

  function hydrateMessages(chatId) {
    return (messages.get(chatId) ?? []).map((m) => {
      if (!m._replyId) return { ...m };
      const r = replies.get(m._replyId);
      const { _replyId: _ignore, ...clean } = m;
      if (!r) return { ...clean, agentReply: null };
      const cloned = structuredClone(r);
      if (cloned.profileProposal?.changeId === profileChangeId) {
        cloned.profileProposal.status = profileState.proposals[0].status;
        cloned.profileProposal.decidedAt = profileState.proposals[0].decidedAt;
      }
      return { ...clean, agentReply: cloned };
    });
  }

  // 테스트용 에이전트 응답 시나리오 제어
  let nextReplyBehavior = 'queued_then_search_and_profile';
  const pendingSettlements = new Map();

  function settleReply(replyId) {
    const fn = pendingSettlements.get(replyId);
    if (fn) {
      fn();
      pendingSettlements.delete(replyId);
    }
  }

  function createBackendFor(config) {
    const owner = config.token === OWNER.token ? OWNER : null;
    return {
      getUser: async () => (owner ? { id: owner.id, isAnonymous: false } : null),
      getProfile: async () => null,
      getUploadContent: async () => null,
      getNoticeSearchIndex: async (_signal, purpose) => {
        if (purpose === 'search') {
          searchExecutions += 1;
          return searchIndex;
        }
        return directoryIndex;
      },
      runAnalysis: async () => { throw new ApiError('run_not_found'); },
      getFundingInputs: async () => { throw new Error('unused'); },
      getLegalEvidence: async () => { throw new Error('unused'); },
      prepareCommute: async () => { throw new Error('unused'); },
      prepareRegionalNews: async () => { throw new Error('unused'); },
      getComparison: async () => { throw new ApiError('comparison_not_available'); },
      analysisConversation: async () => { throw new Error('unused'); },
      savedReport: async () => { throw new Error('unused'); },
      dataDeletion: async () => { throw new Error('unused'); },
      chatHome: async (op) => {
        if (!owner) throw new ApiError('authentication_required');
        if (op.action === 'list') {
          return { contractVersion: 'chat-home/v1', chats: [...chats.values()].map(summaryFor), nextCursor: null };
        }
        if (op.action === 'create') {
          const chatId = randomUUID();
          const now = nextIso();
          const record = { chatId, title: op.title ?? '새 채팅', createdAt: now, updatedAt: now };
          chats.set(chatId, record);
          messages.set(chatId, []);
          return { contractVersion: 'chat-home/v1', chat: summaryFor(record) };
        }
        const chat = chats.get(op.chatId);
        if (!chat) throw new ApiError('chat_not_found');
        if (op.action === 'detail') {
          return {
            contractVersion: 'chat-detail/v1',
            chat: summaryFor(chat),
            messages: hydrateMessages(chat.chatId),
            analyses: [],
          };
        }
        if (op.action === 'message') {
          const userId = randomUUID();
          const assistantId = randomUUID();
          const userMsg = { id: userId, role: 'user', content: op.message, createdAt: nextIso() };
          const assistantMsg = {
            id: assistantId,
            role: 'assistant',
            content: '공고명이나 10자리 공고번호를 입력하시면 공유 색인에서 찾아 드립니다. 개인 청약 자격 판정이나 가격 전망은 제공하지 않습니다.',
            createdAt: nextIso(),
          };

          let agentReply = null;
          if (nextReplyBehavior !== 'disabled') {
            const replyId = randomUUID();
            userMsg._replyId = replyId;
            if (nextReplyBehavior === 'rejected' || nextReplyBehavior === 'expired') {
              agentReply = {
                id: replyId,
                userMessageId: userId,
                assistantMessageId: assistantId,
                status: nextReplyBehavior,
                model: 'gpt-6.2-sol',
                intent: null,
                answer: null,
                citations: [],
                searchProposal: null,
                profileProposal: null,
                lookupQuery: null,
                completedAt: nextIso(),
              };
              replies.set(replyId, agentReply);
            } else {
              agentReply = {
                id: replyId,
                userMessageId: userId,
                assistantMessageId: assistantId,
                status: 'queued',
                model: 'gpt-6.2-sol',
                intent: null,
                answer: null,
                citations: [],
                searchProposal: null,
                profileProposal: null,
                lookupQuery: null,
                completedAt: null,
              };
              replies.set(replyId, agentReply);
              const mode = nextReplyBehavior;
              pendingSettlements.set(replyId, () => {
                replies.set(replyId, {
                  id: replyId,
                  userMessageId: userId,
                  assistantMessageId: assistantId,
                  status: 'answered',
                  model: 'gpt-6.2-sol',
                  intent: 'search_confirm',
                  answer: '희망 지역 서울특별시 성동구·서울특별시 광진구, 최대 예산 700,000,000원, 공급면적 84㎡로 정리했습니다. 아래 확인 카드에서 조건을 확인하시면 맞춤 검색을 실행합니다.',
                  citations: [
                    { kind: 'region', reference: '11200,11215', label: '공식 지역 코드' },
                    { kind: 'search_condition', reference: 'notice-search', label: '확인 대기 탐색 조건' },
                  ],
                  searchProposal: {
                    status: 'pending',
                    conditions: {
                      regionCodes: ['11200', '11215'],
                      budgetMaxWon: '700000000',
                      supplyArea: { min: '84', max: '84', unit: 'm2' },
                      includeClosed: false,
                    },
                    regionLabels: { '11200': '서울특별시 성동구', '11215': '서울특별시 광진구' },
                    confirmedConditions: null,
                    resultSummary: null,
                    resultMessageId: null,
                    decidedAt: null,
                  },
                  profileProposal:
                    mode === 'queued_then_search_and_profile'
                      ? {
                          changeId: profileChangeId,
                          baseRevision: 1,
                          previous: profileState.proposals[0].previous,
                          patch: profileState.proposals[0].patch,
                          reason: profileState.proposals[0].reason,
                          status: profileState.proposals[0].status,
                          createdAt: profileState.proposals[0].createdAt,
                          decidedAt: profileState.proposals[0].decidedAt,
                        }
                      : null,
                  lookupQuery: null,
                  completedAt: nextIso(),
                });
              });
            }
          }
          messages.get(chat.chatId).push(userMsg, assistantMsg);
          chat.updatedAt = assistantMsg.createdAt;
          const { _replyId: _ignore, ...cleanUser } = userMsg;
          return {
            contractVersion: 'chat-message/v1',
            chatId: chat.chatId,
            action: op.replyAction,
            userMessage: { ...cleanUser, agentReply },
            assistantMessage: assistantMsg,
            agentReply,
          };
        }
        if (op.action === 'prepareSearch') {
          const r = replies.get(op.replyId);
          if (!r?.searchProposal) throw new ApiError('chat_not_found');
          return {
            chatId: chat.chatId,
            replyId: op.replyId,
            status: r.searchProposal.status,
            searchProposal: r.searchProposal.conditions,
            confirmedConditions: r.searchProposal.confirmedConditions,
            resultSummary: r.searchProposal.resultSummary,
            agentReply: structuredClone(r),
            resultMessage: null,
          };
        }
        if (op.action === 'decideSearch') {
          const r = replies.get(op.replyId);
          if (!r?.searchProposal) throw new ApiError('chat_not_found');
          if (op.decision === 'reject' || op.decision === 'cancel') {
            r.searchProposal.status = op.decision === 'reject' ? 'rejected' : 'cancelled';
            r.searchProposal.decidedAt = nextIso();
            return {
              contractVersion: 'chat-search-decision/v1',
              chatId: chat.chatId,
              replyId: op.replyId,
              agentReply: structuredClone(r),
              resultMessage: null,
            };
          }
          const summaryMsg = {
            id: randomUUID(),
            role: 'assistant',
            content: `확인한 조건으로 맞춤 검색을 실행했습니다. 조건 충족 ${op.resultSummary.counts.matched}건, 확인 필요 ${op.resultSummary.counts.needsReview}건입니다.`,
            createdAt: nextIso(),
          };
          messages.get(chat.chatId).push(summaryMsg);
          r.searchProposal.status = 'confirmed';
          r.searchProposal.confirmedConditions = op.conditions;
          r.searchProposal.resultSummary = op.resultSummary;
          r.searchProposal.resultMessageId = summaryMsg.id;
          r.searchProposal.decidedAt = summaryMsg.createdAt;
          return {
            contractVersion: 'chat-search-decision/v1',
            chatId: chat.chatId,
            replyId: op.replyId,
            agentReply: structuredClone(r),
            resultMessage: summaryMsg,
          };
        }
        throw new Error('unsupported');
      },
    };
  }

  const handler = createHandler({
    env: {
      SUPABASE_URL: 'https://synthetic.invalid',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC_TEST_ONLY',
      APP_ENV: 'development',
    },
    now: () => new Date('2026-11-22T02:00:00Z'),
    createBackend: createBackendFor,
  });

  return {
    handler,
    profileState,
    profileChangeId,
    setBehavior: (b) => { nextReplyBehavior = b; },
    settleAllPending: () => {
      for (const id of [...pendingSettlements.keys()]) settleReply(id);
    },
    getSearchExecutions: () => searchExecutions,
    resetSearchExecutions: () => { searchExecutions = 0; },
    approveProfileProposal: () => {
      profileState.revision += 1;
      profileState.conditions = { region_codes: ['11200', '11215'], budget_max_won: '700000000' };
      profileState.proposals[0].status = 'approved';
      profileState.proposals[0].decidedAt = nextIso();
    },
  };
}

async function attachSyntheticSdk(context, store) {
  await context.exposeFunction('__syntheticProfileRpc', (name, params) => {
    if (name === 'decide_search_profile_change' && params?.p_decision === 'approve') {
      store.approveProfileProposal();
    }
    return {
      contractVersion: 'shared-profile/v1',
      revision: store.profileState.revision,
      updatedAt: store.profileState.updatedAt,
      destination: null,
      conditions: store.profileState.conditions,
      proposals: store.profileState.proposals,
      nextCursor: null,
    };
  });

  await context.addInitScript((user) => {
    const session = { user: { id: user.id, email: user.email, is_anonymous: false }, access_token: user.token };
    const auth = {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    };
    const emptyQuery = {
      select() { return this; },
      eq() { return this; },
      not() { return this; },
      order() { return this; },
      limit: async () => ({ data: [], error: null }),
    };
    globalThis.supabase = {
      createClient: () => ({
        auth,
        from: () => emptyQuery,
        rpc: (name, params) => ({
          setHeader() { return this; },
          abortSignal() { return this; },
          then(resolve) {
            return window.__syntheticProfileRpc(name, params).then((data) => resolve({ data, error: null }));
          },
        }),
      }),
    };
  }, OWNER);
}

let server, browser, origin, store;

before(async () => {
  store = createAgentChatStore();
  server = createDevServer((request) => serveWorkspace(request, store.handler));
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath =
    process.env.CHROME_BIN ||
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/google-chrome');
  browser = await chromium.launch({ executablePath, headless: true });
});

after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
});

test('desktop(1440px): immediate rule reply, AI badge + model name, confirmation card edit/confirm/result, O-3 handoff, reject/cancel, and no fake pending', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await attachSyntheticSdk(context, store);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(origin + '/#home');
  await page.waitForSelector('#chat-home-input');

  // 1) 채팅 홈에서 자연어 탐색 조건 입력 -> 규칙 기반 즉시 응답 + 'AI 응답 작성 중' + gpt-6.2-sol
  store.setBehavior('queued_then_search_and_profile');
  await page.fill('#chat-home-input', '광진구랑 성동구에서 7억 이하, 84㎡ 정도로 찾아주고 다음에도 이 조건으로 써줘');
  await page.click('#chat-home-form button[type="submit"]');
  await page.waitForSelector('#chat-timeline');

  await page.waitForSelector('[data-agent-reply="queued"]');
  const pendingText = await page.locator('[data-agent-reply="queued"]').innerText();
  assert.match(pendingText, /AI 응답 작성 중/);
  assert.match(pendingText, /gpt-6\.2-sol/);
  assert.equal(store.getSearchExecutions(), 0);

  // 2) 작업자 완료 -> 폴링으로 'AI 응답' + 모델명 + 확인 카드 + O-3 공유 프로필 변경안 표시
  store.settleAllPending();
  await page.waitForSelector('[data-agent-reply="answered"]', { timeout: 6000 });
  assert.equal(await page.locator('[data-agent-reply="queued"]').count(), 0);

  const aiCard = page.locator('[data-agent-reply="answered"]').first();
  const aiText = await aiCard.innerText();
  assert.match(aiText, /AI 응답/);
  assert.match(aiText, /gpt-6\.2-sol/);
  assert.match(aiText, /이 조건으로 공고를 찾을까요\?/);
  assert.match(aiText, /서울특별시 광진구/);
  assert.match(aiText, /서울특별시 성동구/);
  assert.match(aiText, /7억/);
  assert.match(aiText, /공유 프로필 변경안/);
  assert.equal(store.getSearchExecutions(), 0);

  // 3) 확인 카드 조건 수정 -> 확인 실행 -> 결과 요약(조건 충족 1건 · 확인 필요 1건) + 공고 카드 링크
  await aiCard.locator('[data-chat-agent="edit-search"]').click();
  await page.waitForSelector('[data-chat-edit-form]');
  await page.fill('#chat-edit-budget', '750000000');
  await page.click('[data-chat-edit-form] button[type="submit"]');

  await page.waitForSelector('[data-chat-search-summary]');
  assert.equal(store.getSearchExecutions(), 1);
  const summaryText = await page.locator('[data-chat-search-summary]').innerText();
  assert.match(summaryText, /조건 충족 1건/);
  assert.match(summaryText, /확인 필요 1건/);
  assert.match(summaryText, /합성 가람 아파트/);
  assert.match(summaryText, /합성 센트럴 아이파크/);

  // 공고 카드 '회차 확인·주택형 선택' 클릭 -> 오른쪽 S-02 공고 찾기 패널 조회 연동
  await page.locator('[data-chat-agent="open-notice-lookup"][data-notice-no="9900000101"]').click();
  await page.waitForSelector('.lookup-edition-card');
  assert.match(await page.locator('.lookup-panel').innerText(), /합성 가람 아파트/);

  // 4) 공유 프로필 변경안 -> O-3 다이얼로그에서 직접 승인 -> 채팅 카드 상태 '승인 반영됨' 갱신
  await page.locator('[data-chat-agent="review-profile"]').click();
  await page.waitForSelector('[data-profile-review-dialog]');
  await page.click('[data-review="approve"]');
  await page.waitForSelector('[data-profile-proposal-status="approved"]', { timeout: 5000 });
  await page.click('#workspace-dialog [data-action="close"]');

  // 5) 두 번째 메시지: 거절 클릭 -> 검색 미실행 확인
  store.resetSearchExecutions();
  store.setBehavior('queued_then_search_only');
  await page.fill('#chat-message-input', '광진구 6억 이하 찾아줘');
  await page.click('#chat-message-form button[type="submit"]');
  await page.waitForSelector('[data-agent-reply="queued"]');
  store.settleAllPending();
  await page.waitForFunction(() => document.querySelectorAll('[data-agent-reply="answered"]').length === 2, { timeout: 6000 });
  await page.locator('[data-agent-reply="answered"]').nth(1).locator('[data-chat-agent="reject-search"]').click();
  await page.waitForSelector('[data-search-proposal-status="rejected"]');
  assert.equal(store.getSearchExecutions(), 0);

  // 6) rejected / expired / disabled(null) 상태에서는 '작성 중'이 절대 표시되지 않는다.
  for (const mode of ['rejected', 'expired', 'disabled']) {
    store.setBehavior(mode);
    await page.fill('#chat-message-input', `폴백 확인 메시지 (${mode})`);
    await page.click('#chat-message-form button[type="submit"]');
    await page.waitForFunction(
      (needle) => document.querySelector('#chat-timeline')?.textContent?.includes(needle),
      `폴백 확인 메시지 (${mode})`,
    );
    assert.equal(await page.locator('.chat-agent-pending').count(), 0, mode);
    assert.ok(!(await page.locator('#chat-timeline').innerText()).includes('작성 중'), mode);
  }

  // 데스크톱 가로 넘침 및 런타임 오류 0건
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `desktop overflow: ${overflow}`);
  assert.deepEqual(pageErrors, []);
  await context.close();
});

test('mobile(390px): confirmation card, search summary and cancel flow render without horizontal overflow', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await attachSyntheticSdk(context, store);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  store.resetSearchExecutions();
  store.setBehavior('queued_then_search_only');
  await page.goto(origin + '/#home');
  await page.waitForSelector('#chat-home-input');
  await page.fill('#chat-home-input', '성동구에서 7억 이하로 찾아줘');
  await page.click('#chat-home-form button[type="submit"]');
  await page.waitForSelector('[data-agent-reply="queued"]');

  store.settleAllPending();
  await page.waitForSelector('[data-agent-reply="answered"]', { timeout: 6000 });
  const overflowCard = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflowCard <= 1, `mobile card overflow: ${overflowCard}`);

  // 모바일에서 취소 클릭 -> 검색 미실행
  await page.locator('[data-chat-agent="cancel-search"]').click();
  await page.waitForSelector('[data-search-proposal-status="cancelled"]');
  assert.equal(store.getSearchExecutions(), 0);
  assert.equal(await page.locator('.chat-agent-pending').count(), 0);

  const overflowAfter = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflowAfter <= 1, `mobile after-cancel overflow: ${overflowAfter}`);
  assert.deepEqual(pageErrors, []);
  await context.close();
});
