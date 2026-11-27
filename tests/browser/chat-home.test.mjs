// 실제 네트워크와 계정 없이 S-01 채팅 홈·채팅 화면·S-02 공고 찾기·계정 격리를 데스크톱·모바일에서 검사한다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { createDevServer } from '../../dev/server.ts';
import { serveWorkspace } from '../../dev/static.ts';
import { createHandler } from '../../src/server/handler.ts';
import { ApiError } from '../../src/server/http-input.ts';

const OWNER_A = { id: 'a1000000-0000-4000-8000-000000000001', email: 'alpha@example.invalid', token: 'SYNTHETIC_TOKEN_A' };
const OWNER_B = { id: 'b2000000-0000-4000-8000-000000000002', email: 'beta@example.invalid', token: 'SYNTHETIC_TOKEN_B' };
const AS_OF = '2026-11-22';
const OBSERVED_AT = '2026-11-22T00:17:00+09:00';
const PUB_WINDOW = { start: '2026-08-25', end: '2026-11-22' };

function makeSyntheticIndex() {
  return {
    contractVersion: 'notice-search-index/v1',
    dataOrigin: 'collected',
    observedAt: OBSERVED_AT,
    publicationWindow: PUB_WINDOW,
    regionCodes: ['11200', '11215'],
    regionNames: { '11215': '서울특별시 광진구', '11200': '서울특별시 성동구' },
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
        edition: '2026-10-23',
        title: '합성 센트럴 아이파크',
        kind: 'resupply',
        regionCode: '11215',
        application: { start: '2026-10-28', end: '2026-10-29' },
        moveIn: null,
        inventoryComplete: false,
        models: [{ modelNo: '01', houseType: '084.9811C', supplyAreaM2: null, areaEvidence: [], rooms: [] }],
        sourceIds: ['applyhome_remainder', 'applyhome_remainder_model'],
        reasonCodes: [],
      },
      {
        houseManageNo: '9900000019',
        noticeNo: '9900000019',
        edition: '2026-09-01',
        title: '합성 센트럴 아이파크',
        kind: 'resupply',
        regionCode: '11215',
        application: { start: '2026-09-05', end: '2026-09-06' },
        moveIn: null,
        inventoryComplete: false,
        models: [],
        sourceIds: ['applyhome_remainder'],
        reasonCodes: ['model_unverified'],
      },
      {
        houseManageNo: '9900000101',
        noticeNo: '9900000101',
        edition: '2026-11-10',
        title: '합성 가람 아파트',
        kind: 'new_sale',
        regionCode: '11200',
        application: { start: '2026-11-20', end: '2026-11-24' },
        moveIn: null,
        inventoryComplete: false,
        models: [{ modelNo: '01', houseType: '084.0000A', supplyAreaM2: null, areaEvidence: [], rooms: [] }],
        sourceIds: ['applyhome_apt', 'applyhome_apt_model'],
        reasonCodes: [],
      },
    ],
  };
}

// 실제 createHandler에 연결되는 메모리 합성 저장소 (계정 격리·멱등성·시간순 저장 검증용).
function createInMemoryStore() {
  const chats = new Map();
  const messages = new Map();
  const analyses = new Map();
  const runs = new Map();
  const chatReqKeys = new Map();
  const msgReqKeys = new Map();
  const runReqKeys = new Map();
  const index = makeSyntheticIndex();
  let tick = Date.parse('2026-11-22T01:00:00Z');
  const nextIso = () => new Date((tick += 1000)).toISOString();

  function summaryFor(chat) {
    const msgs = messages.get(chat.chatId) ?? [];
    const anas = analyses.get(chat.chatId) ?? [];
    const lastMsg = msgs.at(-1) ?? null;
    const latestAna = [...anas].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
    const times = [chat.updatedAt, ...(lastMsg ? [lastMsg.createdAt] : []), ...(latestAna ? [latestAna.updatedAt] : [])];
    const lastActivityAt = times.sort().at(-1);
    return {
      chatId: chat.chatId,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      lastActivityAt,
      messageCount: msgs.length,
      analysisCount: anas.length,
      lastMessagePreview: lastMsg ? lastMsg.content.slice(0, 120) : null,
      latestAnalysis: latestAna,
    };
  }

  function assistantReplyFor(op) {
    if (op.replyAction === 'help') {
      return '공고명이나 10자리 공고번호를 입력하시면 게시된 청약홈 공유 색인에서 회차를 구별해 찾아 드립니다. 개인 청약 자격 판정이나 가격 전망은 제공하지 않습니다.';
    }
    if (op.replyAction === 'pdf_guide') {
      return '공고 PDF 보완은 공고와 주택형을 먼저 고른 뒤 분석 화면에서 진행할 수 있습니다.';
    }
    const q = op.query ?? '';
    const matched = index.notices.filter((n) =>
      op.mode === 'number'
        ? n.noticeNo.includes(q) || n.houseManageNo.includes(q)
        : n.title.replace(/\s+/g, '').includes(q.replace(/\s+/g, '')),
    );
    if (!matched.length) {
      return `조회 범위(모집공고일 2026.08.25–2026.11.22, 관측 시각 2026.11.22 00:17 KST) 안에서 '${q}'에 해당하는 공고를 찾지 못했습니다. 이 기간 밖의 회차는 현재 조회 범위 밖입니다.`;
    }
    return `'${q}' 검색 결과 총 ${matched.length}건을 찾았습니다. 같은 이름의 다른 회차는 합치지 않았습니다. 공고일·공고번호·주택관리번호를 확인해 회차를 고르세요.`;
  }

  function createBackendFor(config) {
    const owner = config.token === OWNER_A.token ? OWNER_A : config.token === OWNER_B.token ? OWNER_B : null;
    return {
      getUser: async () => (owner ? { id: owner.id, isAnonymous: false } : null),
      getProfile: async () => null,
      getUploadContent: async () => null,
      getNoticeSearchIndex: async () => index,
      runAnalysis: async (op) => {
        if (op.action === 'get') {
          const run = runs.get(op.runId);
          if (!run || run.ownerId !== owner?.id || run.analysisId !== op.analysisId) throw new ApiError('run_not_found');
          const { ownerId: _ignore, ...publicRun } = run;
          return publicRun;
        }
        throw new ApiError('run_not_found');
      },
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
          const owned = [...chats.values()]
            .filter((c) => c.ownerId === owner.id)
            .map(summaryFor)
            .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || b.chatId.localeCompare(a.chatId));
          return { contractVersion: 'chat-home/v1', chats: owned.slice(0, op.limit), nextCursor: null };
        }
        if (op.action === 'create') {
          const rk = `${owner.id}:${op.requestId}`;
          const existingId = chatReqKeys.get(rk);
          const title = op.title ?? '새 채팅';
          if (existingId) {
            const existing = chats.get(existingId);
            if (existing.title !== title) throw new ApiError('chat_conflict');
            return { contractVersion: 'chat-home/v1', chat: summaryFor(existing) };
          }
          const chatId = randomUUID();
          const now = nextIso();
          const record = { chatId, ownerId: owner.id, title, createdAt: now, updatedAt: now };
          chats.set(chatId, record);
          messages.set(chatId, []);
          analyses.set(chatId, []);
          chatReqKeys.set(rk, chatId);
          return { contractVersion: 'chat-home/v1', chat: summaryFor(record) };
        }
        const chat = chats.get(op.chatId);
        if (!chat || chat.ownerId !== owner.id) throw new ApiError('chat_not_found');
        if (op.action === 'detail') {
          return {
            contractVersion: 'chat-detail/v1',
            chat: summaryFor(chat),
            messages: [...(messages.get(chat.chatId) ?? [])],
            analyses: [...(analyses.get(chat.chatId) ?? [])],
          };
        }
        if (op.action === 'rename') {
          chat.title = op.title;
          chat.updatedAt = nextIso();
          return { contractVersion: 'chat-home/v1', chat: summaryFor(chat) };
        }
        if (op.action === 'message') {
          const rk = `${owner.id}:${chat.chatId}:${op.requestId}`;
          const existing = msgReqKeys.get(rk);
          if (existing) {
            if (existing.userMessage.content !== op.message) throw new ApiError('chat_conflict');
            return { contractVersion: 'chat-message/v1', chatId: chat.chatId, action: op.replyAction, ...existing };
          }
          const userMessage = { id: randomUUID(), role: 'user', content: op.message, createdAt: nextIso() };
          const assistantMessage = { id: randomUUID(), role: 'assistant', content: assistantReplyFor(op), createdAt: nextIso() };
          messages.get(chat.chatId).push(userMessage, assistantMessage);
          chat.updatedAt = assistantMessage.createdAt;
          msgReqKeys.set(rk, { userMessage, assistantMessage });
          return { contractVersion: 'chat-message/v1', chatId: chat.chatId, action: op.replyAction, userMessage, assistantMessage };
        }
        if (op.action === 'startAnalysis') {
          const rk = `${owner.id}:${op.requestId}`;
          const prior = runReqKeys.get(rk);
          if (prior) {
            if (prior.chatId !== chat.chatId) throw new ApiError('chat_conflict');
            return prior.response;
          }
          const notice = index.notices.find(
            (n) => n.houseManageNo === op.input.houseManageNo && n.noticeNo === op.input.noticeNo,
          );
          const model = notice?.models.find((m) => m.modelNo === op.input.modelNo);
          if (!notice || !model) throw new ApiError('notice_model_not_found');
          const analysisId = randomUUID();
          const runId = randomUUID();
          const now = nextIso();
          const title = `${notice.title} · ${model.houseType}`;
          const analysisItem = {
            analysisId,
            title,
            status: 'queued',
            latestRunId: runId,
            latestRunStatus: 'queued',
            latestRunErrorCode: null,
            noticeNo: notice.noticeNo,
            houseManageNo: notice.houseManageNo,
            edition: notice.edition,
            modelNo: model.modelNo,
            houseType: model.houseType,
            createdAt: now,
            updatedAt: now,
          };
          analyses.get(chat.chatId).push(analysisItem);
          chat.updatedAt = now;
          const runObj = {
            ownerId: owner.id,
            analysisId,
            runId,
            status: 'queued',
            attempt: 0,
            submittedAt: now,
            finishedAt: null,
            snapshotId: null,
            errorCode: null,
            input: op.input,
          };
          runs.set(runId, runObj);
          const response = { ...runObj, chatId: chat.chatId };
          delete response.ownerId;
          runReqKeys.set(rk, { chatId: chat.chatId, response });
          return response;
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

  return { handler };
}

async function attachAuthAdapter(context, initialUser) {
  await context.addInitScript((user) => {
    let current = user;
    const listeners = [];
    window.__setSyntheticUser = (next) => {
      current = next;
      const session = next ? { user: { id: next.id, email: next.email, is_anonymous: false }, access_token: next.token } : null;
      for (const fn of listeners) fn(next ? 'SIGNED_IN' : 'SIGNED_OUT', session);
    };
    const auth = {
      getSession: async () => ({
        data: {
          session: current
            ? { user: { id: current.id, email: current.email, is_anonymous: false }, access_token: current.token }
            : null,
        },
        error: null,
      }),
      onAuthStateChange: (cb) => {
        listeners.push(cb);
        return { data: { subscription: { unsubscribe() {} } } };
      },
    };
    const emptyQuery = {
      select() { return this; },
      eq() { return this; },
      not() { return this; },
      order() { return this; },
      limit: async () => ({ data: [], error: null }),
    };
    const profileRpc = {
      setHeader() { return this; },
      abortSignal() { return this; },
      then(resolve) {
        return Promise.resolve({
          data: {
            contractVersion: 'shared-profile/v1',
            revision: 2,
            updatedAt: '2026-11-21T09:00:00Z',
            destination: null,
            conditions: { region_codes: ['11215'], budget_max_won: '1200000000' },
            proposals: [],
            nextCursor: null,
          },
          error: null,
        }).then(resolve);
      },
    };
    globalThis.supabase = {
      createClient: () => ({
        auth,
        from: () => emptyQuery,
        rpc: () => profileRpc,
      }),
    };
  }, initialUser);
}

let server, browser, origin, store;

before(async () => {
  store = createInMemoryStore();
  server = createDevServer((request) => serveWorkspace(request, store.handler));
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  origin = 'http://127.0.0.1:' + server.address().port;
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

for (const width of [1440, 390]) {
  test(`guest S-01 and S-02 routes at ${width}px label synthetic preview and block private lookups (A-51)`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const privateCalls = [];
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.startsWith('/api/v1/chats') || url.pathname === '/api/v1/notices/lookup') {
        privateCalls.push(url.pathname);
      }
      return route.continue();
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await page.goto(origin + '/#home');
      await page.getByRole('heading', { name: '어떤 청약 공고를 검토할까요?' }).waitFor();
      await page.locator('.chat-eyebrow').getByText('합성 자료', { exact: true }).waitFor();
      assert.ok((await page.locator('a[href="#notices"]').count()) >= 1);

      // PDF로 보완 카드는 업로드 대신 안내 문구만 표시한다.
      await page.locator('[data-chat-home="start-pdf"]').click();
      await page.locator('#pdf-supplement-guide').getByText('공고를 먼저 고른 뒤 분석 화면에서 PDF로 보완할 수 있습니다.').waitFor();

      // 비로그인 공고명 찾기 클릭 시 로그인 다이얼로그 열림 + API 미호출
      await page.locator('[data-chat-home="start-name"]').click();
      await page.locator('dialog[open] #auth-email').waitFor();
      await page.keyboard.press('Escape');

      // 비로그인으로 직접 채팅/공고 찾기 주소 방문 시 로그인 안내만 표시 + API 미호출
      await page.goto(origin + '/#chat/a1000000-0000-4000-8000-000000000099');
      await page.getByRole('heading', { name: '로그인한 뒤 채팅을 열 수 있습니다.' }).waitFor();
      await page.goto(origin + '/#lookup/number');
      await page.getByRole('heading', { name: '로그인한 뒤 공고 찾기를 이용할 수 있습니다.' }).waitFor();

      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(privateCalls, []);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

for (const width of [1440, 390]) {
  test(`signed-in S-01 chat home, S-02 edition lookup, S-03 start, rename and cross-device restore at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await attachAuthAdapter(context, OWNER_A);
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));

    let createdChatId;
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await page.goto(origin + '/#home');
      await page.getByRole('heading', { name: '어떤 청약 공고를 검토할까요?' }).waitFor();
      await page.locator('.chat-profile-bar').getByText('확인된 프로필 v2').waitFor();

      // 새 채팅 만들기
      await page.locator('[data-chat-home="new-chat"]').first().click();
      await page.waitForFunction(() => location.hash.startsWith('#chat/'));
      createdChatId = await page.evaluate(() => location.hash.slice('#chat/'.length));

      // 제목 변경: 취소 후 실제 저장
      await page.locator('[data-chat-view="start-rename"]').click();
      await page.locator('#chat-title-input').fill('취소될 제목');
      await page.locator('[data-chat-view="cancel-rename"]').click();
      assert.equal(await page.locator('#page-heading').innerText(), '새 채팅');

      await page.locator('[data-chat-view="start-rename"]').click();
      const customTitle = `광진구 회차 비교 ${width}`;
      await page.locator('#chat-title-input').fill(customTitle);
      await page.locator('#chat-rename-form button[type="submit"]').click();
      await page.locator('#page-heading').getByText(customTitle, { exact: true }).waitFor();

      // 채팅 입력창에서 같은 이름의 2개 회차 공고 검색
      await page.locator('#chat-message-input').fill('합성 센트럴 아이파크');
      await page.locator('#chat-message-form button[type="submit"]').click();

      // 좌측 타임라인에 user + assistant 응답 기록
      await page.locator('.chat-bubble-user').getByText('합성 센트럴 아이파크').waitFor();
      await page.locator('.chat-bubble-assistant').getByText(/총 2건/).waitFor();

      // 우측 S-02 패널: 같은 이름 2건 미병합 + 공고일·공고번호·주택관리번호·유형·접수 상태 + 조회 범위 안내
      await page.locator('.lookup-dup-banner').waitFor();
      assert.equal(await page.locator('.lookup-edition-card').count(), 2);
      const cardsText = await page.locator('.lookup-radio-list').innerText();
      assert.ok(cardsText.includes('2026.10.23'));
      assert.ok(cardsText.includes('2026.09.01'));
      assert.ok(cardsText.includes('9900000040'));
      assert.ok(cardsText.includes('9900000019'));
      assert.ok(cardsText.includes('재공급'));
      assert.ok(cardsText.includes('접수 종료'));
      assert.ok((await page.locator('.lookup-scope-box').innerText()).includes('조회 범위 밖'));

      // 두 번째 회차(주택형 미확인 보류 사례)로 라디오를 바꾸면 CTA 공고일이 바뀌고 S-03에서 시작이 막힌다.
      await page.locator('.lookup-edition-card input[value="9900000019:9900000019"]').check();
      assert.ok((await page.locator('[data-chat-view="select-edition"]').innerText()).includes('2026.09.01'));
      await page.locator('[data-chat-view="select-edition"]').click();
      const heldDialog = page.getByRole('dialog');
      await heldDialog.getByText('주택형 확인 필요').waitFor();
      assert.equal(await heldDialog.locator('[data-action="start"]').isDisabled(), true);
      await page.keyboard.press('Escape');

      // 첫 번째 회차 선택 -> S-03 주택형 선택 다이얼로그 -> 분석 시작 (현재 채팅에 연결)
      await page.locator('.lookup-edition-card input[value="9900000040:9900000040"]').check();
      assert.ok((await page.locator('[data-chat-view="select-edition"]').innerText()).includes('2026.10.23'));
      await page.locator('[data-chat-view="select-edition"]').click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText('084.9811C').waitFor();
      await dialog.locator('[data-action="start"]').click();
      await page.waitForFunction(() => location.hash.startsWith('#run/'));

      // 채팅으로 돌아오면 메시지와 연결된 분석(최신 상태·결과 링크)이 시간순으로 복원된다.
      await page.goto(origin + '/#chat/' + createdChatId);
      await page.locator('.chat-analysis-card').getByText('합성 센트럴 아이파크 · 084.9811C').waitFor();
      await page.locator('.chat-analysis-card a[href^="#run/"]').waitFor();

      // 한글 IME 조합 중 Enter는 전송되지 않는다.
      await page.locator('#chat-message-input').fill('조합중 입력');
      await page.locator('#chat-message-input').evaluate((el) => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
      });
      assert.equal(await page.locator('#chat-message-input').inputValue(), '조합중 입력');

      // 자유 질문은 LLM 없이 지원 동작 안내 정형 응답만 반환한다.
      await page.locator('#chat-message-input').fill('여기 청약 자격 되나요?');
      await page.locator('#chat-message-form button[type="submit"]').click();
      await page.locator('.chat-bubble-assistant').getByText(/개인 청약 자격 판정이나 가격 전망은 제공하지 않습니다/).waitFor();

      // 조회 범위 밖 번호 검색 시 범위 밖 안내 표시
      await page.locator('[data-lookup-mode="number"]').click();
      await page.locator('#lookup-query').fill('2020000001');
      await page.locator('#notice-lookup-form button[type="submit"]').click();
      await page.getByRole('heading', { name: '조회 범위 안에서 일치하는 공고를 찾지 못했습니다.' }).waitFor();

      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }

    // 다른 기기(새 브라우저 컨텍스트)에서 같은 계정으로 로그인해 채팅·분석 복원 확인 (A-15)
    const secondDevice = await browser.newContext({ viewport: { width, height: 900 } });
    await attachAuthAdapter(secondDevice, OWNER_A);
    await secondDevice.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    try {
      const page2 = await secondDevice.newPage();
      await page2.goto(origin + '/#home');
      const card = page2.locator('.chat-list-card').filter({ hasText: `광진구 회차 비교 ${width}` });
      await card.waitFor();
      assert.ok((await card.innerText()).includes('연결된 분석 1건'));
      await card.click();
      await page2.waitForFunction((id) => location.hash === '#chat/' + id, createdChatId);
      await page2.locator('.chat-bubble-user').getByText('합성 센트럴 아이파크').waitFor();
      await page2.locator('.chat-analysis-card a[href^="#run/"]').waitFor();
    } finally {
      await secondDevice.close();
    }
  });
}

test('another account cannot list or directly open foreign chats and switching accounts clears private chat view (A-43)', async () => {
  // 계정 A로 채팅 생성
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await attachAuthAdapter(ctxA, OWNER_A);
  await ctxA.route('**/*', (r) => (new URL(r.request().url()).origin === origin ? r.continue() : r.abort()));
  let secretChatId;
  try {
    const pageA = await ctxA.newPage();
    await pageA.goto(origin + '/#home');
    await pageA.locator('[data-chat-home="new-chat"]').first().click();
    await pageA.waitForFunction(() => location.hash.startsWith('#chat/'));
    secretChatId = await pageA.evaluate(() => location.hash.slice('#chat/'.length));
    await pageA.locator('[data-chat-view="start-rename"]').click();
    await pageA.locator('#chat-title-input').fill('계정 A 비밀 검토');
    await pageA.locator('#chat-rename-form button[type="submit"]').click();
    await pageA.locator('#page-heading').getByText('계정 A 비밀 검토').waitFor();

    // 같은 탭에서 계정 B로 전환되면 채팅 화면이 닫히고 계정 A 내용이 남지 않는다.
    await pageA.evaluate((nextUser) => window.__setSyntheticUser(nextUser), OWNER_B);
    await pageA.waitForFunction(() => location.hash === '#home');
    assert.equal(await pageA.getByText('계정 A 비밀 검토').count(), 0);
  } finally {
    await ctxA.close();
  }

  // 계정 B로 직접 주소(#chat/<secretChatId>) 방문 시 404 안내
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await attachAuthAdapter(ctxB, OWNER_B);
  await ctxB.route('**/*', (r) => (new URL(r.request().url()).origin === origin ? r.continue() : r.abort()));
  try {
    const pageB = await ctxB.newPage();
    await pageB.goto(origin + '/#home');
    await pageB.getByText('아직 저장된 채팅이 없습니다.').waitFor();
    assert.equal(await pageB.getByText('계정 A 비밀 검토').count(), 0);

    await pageB.goto(origin + '/#chat/' + secretChatId);
    await pageB.getByRole('heading', { name: '채팅을 찾을 수 없습니다.' }).waitFor();
    assert.equal(await pageB.getByText('계정 A 비밀 검토').count(), 0);
  } finally {
    await ctxB.close();
  }
});

test('a zero-match lookup from a partially collected index is held instead of shown as a confirmed zero', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await attachAuthAdapter(context, OWNER_A);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname !== '/api/v1/notices/lookup') return route.continue();
    // 합성 색인 응답의 수집 상태만 부분 수집으로 바꿔 0건 보류 표시를 확인한다.
    const response = await route.fetch();
    const body = await response.json();
    body.coverage = {
      status: 'partial',
      sources: [
        { source: 'applyhome_apt', status: 'complete' },
        { source: 'applyhome_remainder', status: 'partial' },
      ],
    };
    body.scopeIssues = ['coverage_incomplete'];
    return route.fulfill({ response, json: body });
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/#lookup/number');
    await page.locator('#lookup-query').waitFor();
    await page.locator('#lookup-query').fill('2020000001');
    await page.locator('#notice-lookup-form button[type="submit"]').click();
    await page.getByRole('heading', { name: '수집이 완전하지 않아 0건으로 확정하지 않습니다.' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '조회 범위 안에서 일치하는 공고를 찾지 못했습니다.' }).count(), 0);
    assert.ok((await page.locator('.lookup-scope-box').innerText()).includes('부분 수집'));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('reloading a signed-in chat or lookup address restores that screen after the session check', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await attachAuthAdapter(context, OWNER_A);
  await context.route('**/*', (r) => (new URL(r.request().url()).origin === origin ? r.continue() : r.abort()));
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/#home');
    await page.locator('[data-chat-home="new-chat"]').first().click();
    await page.waitForFunction(() => location.hash.startsWith('#chat/'));
    await page.locator('[data-chat-view="start-rename"]').click();
    await page.locator('#chat-title-input').fill('새로고침 합성 채팅');
    await page.locator('#chat-rename-form button[type="submit"]').click();
    await page.locator('#page-heading').getByText('새로고침 합성 채팅').waitFor();

    await page.reload();
    await page.locator('#page-heading').getByText('새로고침 합성 채팅').waitFor();

    await page.goto(origin + '/#lookup/number');
    await page.reload();
    await page.locator('#lookup-query').waitFor();
    assert.equal(await page.locator('[data-lookup-mode="number"]').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
