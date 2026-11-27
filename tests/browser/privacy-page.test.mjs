// D-06 / A-56 내 데이터 관리(#privacy) 브라우저 E2E 검증:
// src/server/data-deletion.ts의 고정 projection(items / impact[reportsDeleted, reportsUpdated, profileCleared, storageObjects] /
// request / 6키 receipt, backup 2상태)과 실제 워크스페이스 라우팅(#profile·계정 팝업·모바일 하단 메뉴 → #privacy)을 기준으로
// 성공/실패/잘못된 응답 거부/지연 응답·계정 전환·새로고침·한글 IME 조합·데스크톱(1440)/모바일(390)을 검증한다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { createDevServer } from '../../dev/server.ts';
import { serveWorkspace } from '../../dev/static.ts';

const RECEIPT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_A = { id: 'a1100000-0000-4000-8000-000000000001', email: 'privacy-alice@example.invalid' };
const USER_B = { id: 'b2200000-0000-4000-8000-000000000002', email: 'privacy-bob@example.invalid' };

const ITEM_CHAT_1 = '11111111-1111-4111-8111-111111111111';
const ITEM_ANALYSIS_1 = '14111111-1111-4111-8111-111111111111';
const ITEM_FUND_1 = '22222222-2222-4222-8222-222222222221';
const ITEM_FUND_2 = '22222222-2222-4222-8222-222222222222';
const ITEM_UPLOAD_1 = '33333333-3333-4333-8333-333333333331';
const RECEIPT_GUEST_1 = '44444444-4444-4444-8444-444444444441';
const RECEIPT_VERIFIED_BACKUP = '44444444-4444-4444-8444-444444444442';
const RECEIPT_UNKNOWN = '55555555-5555-4555-8555-555555555555';
const RECEIPT_MALFORMED_COMPLETE = '66666666-6666-4666-8666-666666666661';
const RECEIPT_MALFORMED_BACKUP = '66666666-6666-4666-8666-666666666662';
const RECEIPT_MALFORMED_PURGED = '66666666-6666-4666-8666-666666666663';

let server, browser, origin;
let activeHandler = null;

// src/server/data-deletion.ts의 고정 projection과 동일한 필드·불변식만 반환하는 합성 모의 API
function createSyntheticBackend() {
  const calls = [];
  const receipts = new Map();
  let failNextRequest = null;
  let impactDelayGate = null;
  let malformedImpactMode = null;

  receipts.set(RECEIPT_GUEST_1, {
    receiptId: RECEIPT_GUEST_1,
    scope: 'upload',
    status: 'processing',
    requestedAt: '2026-11-24T01:00:00Z',
    completedAt: null,
    backup: { status: 'unverified' },
  });

  receipts.set(RECEIPT_VERIFIED_BACKUP, {
    receiptId: RECEIPT_VERIFIED_BACKUP,
    scope: 'profile',
    status: 'live_deleted',
    requestedAt: '2026-11-24T01:00:00Z',
    completedAt: '2026-11-24T01:05:00Z',
    backup: { status: 'verified', verifiedAt: '2026-11-24T02:00:00Z' },
  });

  // 계약 위반 회귀 검증용 비정상 영수증 응답(완료로 표시하지 않고 거부해야 함)
  receipts.set(RECEIPT_MALFORMED_COMPLETE, {
    receiptId: RECEIPT_MALFORMED_COMPLETE,
    scope: 'upload',
    status: 'live_deleted',
    requestedAt: '2026-11-24T01:00:00Z',
    completedAt: null,
    backup: { status: 'unverified' },
  });
  receipts.set(RECEIPT_MALFORMED_BACKUP, {
    receiptId: RECEIPT_MALFORMED_BACKUP,
    scope: 'upload',
    status: 'processing',
    requestedAt: '2026-11-24T01:00:00Z',
    completedAt: null,
    backup: { status: 'verified', verifiedAt: '2026-11-24T02:00:00Z' },
  });
  receipts.set(RECEIPT_MALFORMED_PURGED, {
    receiptId: RECEIPT_MALFORMED_PURGED,
    scope: 'profile',
    status: 'live_deleted',
    requestedAt: '2026-11-24T01:00:00Z',
    completedAt: '2026-11-24T01:05:00Z',
    backup: { status: 'purged', note: '계약 밖 상태' },
  });

  const userItems = {
    [USER_A.id]: {
      chat: [{ id: ITEM_CHAT_1, label: '합성 가람 아파트 비교 채팅', detail: '2026.11.20 · 메시지 4건' }],
      message: [{ id: '12111111-1111-4111-8111-111111111111', label: '예산 상한 7억 원 질문', detail: '2026.11.20' }],
      turn: [{ id: '13111111-1111-4111-8111-111111111111', label: '최근 2년 비교 기간 제안', detail: '2026.11.20' }],
      analysis: [{ id: ITEM_ANALYSIS_1, label: '합성 가람 아파트 084A 분석', detail: '실행 2건 · 보고서 3건' }],
      fund: [
        {
          id: ITEM_FUND_1,
          label: '보유 현금 3억 원 <img src=x onerror="window.__xss=1">',
          detail: '확정 · 2026.11.01 <script>window.__xss=2</script>',
        },
        { id: ITEM_FUND_2, label: '추가 입금 5,000만 원', detail: '예상 · 2026.12.15' },
      ],
      upload: [{ id: ITEM_UPLOAD_1, label: '합성 공고 보완 PDF', detail: '합성 가람 아파트 · 4쪽' }],
      report: [{ id: '15111111-1111-4111-8111-111111111111', label: '합성 가람 아파트 084A 보고서 v1', detail: '2026.11.23 저장' }],
    },
    [USER_B.id]: {
      chat: [],
      message: [],
      turn: [],
      analysis: [],
      fund: [{ id: '99999999-9999-4999-8999-999999999991', label: '사용자 B 자금 항목', detail: '확정 · 2026.11.10' }],
      upload: [],
      report: [],
    },
  };

  function ownerFromAuth(request) {
    const auth = request.headers.get('authorization') ?? '';
    if (auth === 'Bearer TOKEN_' + USER_A.id) return USER_A;
    if (auth === 'Bearer TOKEN_' + USER_B.id) return USER_B;
    return null;
  }

  async function handle(request) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    if (pathname === '/api/v1/client-config') {
      return Response.json({ supabaseUrl: 'https://synthetic.invalid', publishableKey: 'sb_publishable_TEST_ONLY' });
    }

    if (pathname === '/api/v1/notices') {
      const owner = ownerFromAuth(request);
      if (!owner) return Response.json({ error: 'authentication_required' }, { status: 401 });
      const raw = JSON.parse(
        await readFile(new URL('../../public/app/assets/directory-example.json', import.meta.url), 'utf8'),
      );
      return Response.json({ ...raw, dataOrigin: 'collected' });
    }

    if (pathname === '/api/v1/notices/regions') {
      const owner = ownerFromAuth(request);
      if (!owner) return Response.json({ error: 'authentication_required' }, { status: 401 });
      return Response.json({ regions: [{ code: '11215', name: '서울특별시 광진구' }] });
    }

    if (pathname === '/api/v1/privacy/items' && request.method === 'GET') {
      const owner = ownerFromAuth(request);
      calls.push({ method: 'GET', pathname, query: Object.fromEntries(searchParams), ownerId: owner?.id ?? null });
      if (!owner) return Response.json({ error: 'authentication_required' }, { status: 401 });
      const kind = searchParams.get('kind');
      const before = searchParams.get('before');
      const all = userItems[owner.id]?.[kind];
      if (!Array.isArray(all)) return Response.json({ error: 'invalid_deletion_input' }, { status: 400 });
      if (kind === 'fund' && owner.id === USER_A.id) {
        if (!before) {
          return Response.json({ items: all.slice(0, 1), nextCursor: all.length > 1 ? all[0].id : null });
        }
        const idx = all.findIndex((entry) => entry.id === before);
        return Response.json({ items: idx >= 0 ? all.slice(idx + 1) : [], nextCursor: null });
      }
      return Response.json({ items: all, nextCursor: null });
    }

    if (pathname === '/api/v1/privacy/impact' && request.method === 'POST') {
      const owner = ownerFromAuth(request);
      const body = await request.json();
      calls.push({ method: 'POST', pathname, body, ownerId: owner?.id ?? null });
      if (!owner) return Response.json({ error: 'authentication_required' }, { status: 401 });
      if (impactDelayGate && body.scope === impactDelayGate.scope) {
        await impactDelayGate.promise;
      }
      if (malformedImpactMode === 'missing_counts') {
        malformedImpactMode = null;
        return Response.json({
          scope: body.scope,
          targetId: body.targetId ?? null,
          counts: { chats: 1 },
          profileCleared: false,
          reportsDeleted: 0,
          reportsUpdated: 0,
          storageObjects: 0,
          backup: { status: 'unverified' },
        });
      }
      if (malformedImpactMode === 'report_sum_mismatch') {
        malformedImpactMode = null;
        return Response.json({
          scope: body.scope,
          targetId: body.targetId ?? null,
          counts: { chats: 0, messages: 0, analyses: 0, runs: 0, turns: 0, funds: 1, reports: 2, uploads: 0, profileChanges: 0 },
          profileCleared: false,
          reportsDeleted: 1,
          reportsUpdated: 0, // 1 + 0 !== 2
          storageObjects: 0,
          backup: { status: 'unverified' },
        });
      }
      const impactByScope = {
        chat: {
          counts: { chats: 1, messages: 4, analyses: 1, runs: 2, turns: 3, funds: 2, reports: 1, uploads: 1, profileChanges: 0 },
          profileCleared: false,
          reportsDeleted: 1,
          reportsUpdated: 0,
          storageObjects: 1,
        },
        message: {
          counts: { chats: 0, messages: 1, analyses: 0, runs: 0, turns: 0, funds: 0, reports: 0, uploads: 0, profileChanges: 0 },
          profileCleared: false,
          reportsDeleted: 0,
          reportsUpdated: 0,
          storageObjects: 0,
        },
        turn: {
          counts: { chats: 0, messages: 0, analyses: 0, runs: 0, turns: 1, funds: 0, reports: 0, uploads: 0, profileChanges: 0 },
          profileCleared: false,
          reportsDeleted: 0,
          reportsUpdated: 0,
          storageObjects: 0,
        },
        analysis: {
          counts: { chats: 0, messages: 0, analyses: 1, runs: 2, turns: 3, funds: 2, reports: 3, uploads: 2, profileChanges: 0 },
          profileCleared: false,
          reportsDeleted: 2,
          reportsUpdated: 1,
          storageObjects: 2,
        },
        fund: {
          counts: { chats: 0, messages: 0, analyses: 0, runs: 0, turns: 0, funds: 1, reports: 1, uploads: 0, profileChanges: 0 },
          profileCleared: false,
          reportsDeleted: 0,
          reportsUpdated: 1,
          storageObjects: 0,
        },
        upload: {
          counts: { chats: 0, messages: 0, analyses: 0, runs: 0, turns: 0, funds: 0, reports: 0, uploads: 1, profileChanges: 0 },
          profileCleared: false,
          reportsDeleted: 0,
          reportsUpdated: 0,
          storageObjects: 1,
        },
        report: {
          counts: { chats: 0, messages: 0, analyses: 0, runs: 0, turns: 0, funds: 0, reports: 1, uploads: 0, profileChanges: 0 },
          profileCleared: false,
          reportsDeleted: 1,
          reportsUpdated: 0,
          storageObjects: 0,
        },
        profile: {
          counts: { chats: 0, messages: 0, analyses: 0, runs: 0, turns: 0, funds: 0, reports: 0, uploads: 0, profileChanges: 3 },
          profileCleared: true,
          reportsDeleted: 0,
          reportsUpdated: 0,
          storageObjects: 0,
        },
        account: {
          counts: { chats: 2, messages: 8, analyses: 1, runs: 2, turns: 3, funds: 2, reports: 2, uploads: 1, profileChanges: 3 },
          profileCleared: true,
          reportsDeleted: 2,
          reportsUpdated: 0,
          storageObjects: 1,
        },
      };
      const entry = impactByScope[body.scope];
      if (!entry) return Response.json({ error: 'invalid_deletion_input' }, { status: 400 });
      return Response.json({
        scope: body.scope,
        targetId: body.targetId ?? null,
        counts: entry.counts,
        profileCleared: entry.profileCleared,
        reportsDeleted: entry.reportsDeleted,
        reportsUpdated: entry.reportsUpdated,
        storageObjects: entry.storageObjects,
        backup: { status: 'unverified' },
      });
    }

    if (pathname === '/api/v1/privacy/requests' && request.method === 'POST') {
      const owner = ownerFromAuth(request);
      const body = await request.json();
      calls.push({ method: 'POST', pathname, body, ownerId: owner?.id ?? null });
      if (!owner) return Response.json({ error: 'authentication_required' }, { status: 401 });
      if (body.confirmed !== true || !RECEIPT_UUID_RE.test(body.receiptId ?? '')) {
        return Response.json({ error: 'invalid_deletion_input' }, { status: 400 });
      }
      if (failNextRequest) {
        const fail = failNextRequest;
        failNextRequest = null;
        return Response.json({ error: fail.code }, { status: fail.status });
      }
      const rid = body.receiptId.toLowerCase();
      if (receipts.has(rid)) return Response.json(receipts.get(rid));
      const pending = ['upload', 'analysis', 'chat', 'account'].includes(body.scope);
      // 영수증은 고정 6키만 반환
      const receipt = {
        receiptId: rid,
        scope: body.scope,
        status: pending ? 'processing' : 'live_deleted',
        requestedAt: '2026-11-24T04:10:00Z',
        completedAt: pending ? null : '2026-11-24T04:10:02Z',
        backup: { status: 'unverified' },
      };
      receipts.set(rid, receipt);
      if (body.targetId && userItems[owner.id]?.[body.scope]) {
        userItems[owner.id][body.scope] = userItems[owner.id][body.scope].filter((entry) => entry.id !== body.targetId);
      }
      return Response.json(receipt, { status: pending ? 202 : 200 });
    }

    if (pathname === '/api/v1/privacy/receipt' && request.method === 'POST') {
      const body = await request.json();
      const authHeader = request.headers.get('authorization');
      calls.push({ method: 'POST', pathname, body, hasAuth: Boolean(authHeader) });
      const id = typeof body?.receiptId === 'string' ? body.receiptId.toLowerCase() : '';
      if (!RECEIPT_UUID_RE.test(id)) return Response.json({ error: 'invalid_deletion_input' }, { status: 400 });
      const found = receipts.get(id);
      if (!found) return Response.json({ error: 'deletion_not_found' }, { status: 404 });
      return Response.json(found);
    }

    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  return {
    handle,
    calls,
    setFailNextRequest(code, status = 503) {
      failNextRequest = { code, status };
    },
    setMalformedImpact(mode) {
      malformedImpactMode = mode;
    },
    setImpactDelay(scope) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      impactDelayGate = { scope, promise };
      return () => {
        impactDelayGate = null;
        release();
      };
    },
    completeReceipt(receiptId) {
      const current = receipts.get(receiptId.toLowerCase());
      if (!current) return;
      receipts.set(receiptId.toLowerCase(), {
        ...current,
        status: 'live_deleted',
        completedAt: '2026-11-24T04:12:00Z',
        backup: { status: 'unverified' },
      });
    },
  };
}

async function installMockSupabase(context, initialUser = null) {
  await context.addInitScript((init) => {
    let currentUser = init.user;
    let listeners = [];
    let failNextSignOut = false;
    let signOutCalls = 0;

    function sessionFor(u) {
      if (!u) return null;
      return { access_token: 'TOKEN_' + u.id, user: { id: u.id, email: u.email, is_anonymous: false } };
    }

    function notify(event) {
      const sess = sessionFor(currentUser);
      for (const cb of [...listeners]) cb(event, sess);
    }

    window.__mockAuth = {
      setUser(u) {
        currentUser = u;
        notify(u ? 'SIGNED_IN' : 'SIGNED_OUT');
      },
      failNextSignOut(flag = true) {
        failNextSignOut = flag;
      },
      getSignOutCalls() {
        return signOutCalls;
      },
    };

    window.supabase = {
      createClient() {
        return {
          auth: {
            async getSession() {
              return { data: { session: sessionFor(currentUser) }, error: null };
            },
            async signOut() {
              signOutCalls += 1;
              if (failNextSignOut) {
                failNextSignOut = false;
                return { error: { code: 'backend_unavailable', message: 'synthetic signout failure' } };
              }
              currentUser = null;
              notify('SIGNED_OUT');
              return { error: null };
            },
            onAuthStateChange(cb) {
              listeners.push(cb);
              return {
                data: {
                  subscription: {
                    unsubscribe() {
                      listeners = listeners.filter((x) => x !== cb);
                    },
                  },
                },
              };
            },
          },
          from() {
            return {
              select() {
                const chain = {
                  eq() { return chain; },
                  not() { return chain; },
                  order() { return chain; },
                  limit() { return Promise.resolve({ data: [], error: null }); },
                  abortSignal() { return chain; },
                  maybeSingle() { return Promise.resolve({ data: null, error: null }); },
                };
                return chain;
              },
            };
          },
          rpc(name) {
            const builder = {
              setHeader() { return builder; },
              abortSignal() { return builder; },
              then(resolve) {
                if (name === 'read_search_profile') {
                  return Promise.resolve({
                    data: {
                      contractVersion: 'shared-profile/v1',
                      revision: 1,
                      updatedAt: '2026-11-23T01:00:00Z',
                      conditions: { budget_max_won: '700000000' },
                      destination: null,
                      proposals: [],
                      nextCursor: null,
                    },
                    error: null,
                  }).then(resolve);
                }
                return Promise.resolve({ data: null, error: { code: 'PT404', message: 'unknown' } }).then(resolve);
              },
            };
            return builder;
          },
        };
      },
    };
  }, { user: initialUser });
}

before(async () => {
  server = createDevServer((request) =>
    serveWorkspace(request, (req) =>
      activeHandler ? activeHandler(req) : Response.json({ error: 'no_handler' }, { status: 500 }),
    ),
  );
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

test('게스트 #privacy: 비로그인 6키 접수번호 조회(processing→live_deleted, backup 2상태), 계약 밖·손상 응답 거부, 저장소·URL 비보관', async () => {
  const backend = createSyntheticBackend();
  activeHandler = backend.handle;

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockSupabase(context, null);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(origin + '/#privacy', { waitUntil: 'networkidle' });
  await page.waitForSelector('#privacy-guest-heading');

  assert.equal(await page.locator('[data-privacy="select-scope"]').count(), 0);
  assert.equal(await page.locator('button[data-action="auth"]').first().isVisible(), true);

  await page.fill('#privacy-receipt-input', 'not-a-uuid');
  await page.click('#privacy-receipt-form button[type="submit"]');
  await page.waitForSelector('#privacy-lookup-error');
  assert.equal(backend.calls.filter((c) => c.pathname === '/api/v1/privacy/receipt').length, 0);

  await page.fill('#privacy-receipt-input', RECEIPT_UNKNOWN);
  await page.click('#privacy-receipt-form button[type="submit"]');
  await page.waitForSelector('#privacy-lookup-error');
  assert.match(await page.locator('#privacy-lookup-error').textContent(), /찾지 못했습니다/);

  // 계약 위반 영수증 3종: 완료 표시 없이 거부
  for (const badId of [RECEIPT_MALFORMED_COMPLETE, RECEIPT_MALFORMED_BACKUP, RECEIPT_MALFORMED_PURGED]) {
    await page.fill('#privacy-receipt-input', badId);
    await page.click('#privacy-receipt-form button[type="submit"]');
    await page.waitForSelector('#privacy-lookup-error');
    assert.equal(await page.locator('#privacy-lookup-result').count(), 0);
  }

  // 정상 processing 조회(비로그인 Authorization 없음)
  await page.fill('#privacy-receipt-input', RECEIPT_GUEST_1);
  await page.click('#privacy-receipt-form button[type="submit"]');
  await page.waitForSelector('#privacy-lookup-result');
  assert.equal(backend.calls.at(-1).hasAuth, false);

  const procText = await page.locator('#privacy-lookup-result').textContent();
  assert.match(procText, /처리 중/);
  assert.match(procText, /업로드 파일을 포함한 삭제 처리 중일 수 있습니다/);
  assert.match(procText, /백업 미확인/);
  assert.equal(await page.locator('#privacy-lookup-result .badge').count(), 2);

  backend.completeReceipt(RECEIPT_GUEST_1);
  await page.click('#privacy-lookup-result [data-privacy="refresh-receipt"]');
  await page.waitForFunction(
    () => document.querySelector('#privacy-lookup-result')?.dataset.receiptStatus === 'live_deleted',
  );
  const doneText = await page.locator('#privacy-lookup-result').textContent();
  assert.match(doneText, /서비스에서 삭제 완료/);
  assert.match(doneText, /백업 미확인/);

  await page.fill('#privacy-receipt-input', RECEIPT_VERIFIED_BACKUP);
  await page.click('#privacy-receipt-form button[type="submit"]');
  await page.waitForFunction(
    (code) => document.querySelector('#privacy-lookup-result')?.dataset.receiptId === code,
    RECEIPT_VERIFIED_BACKUP,
  );
  const verifiedText = await page.locator('#privacy-lookup-result').textContent();
  assert.match(verifiedText, /백업 정리 확인됨/);
  assert.match(verifiedText, /KST/);

  const storageCheck = await page.evaluate((code) => ({
    hrefHasCode: location.href.toLowerCase().includes(code),
    localKeys: Object.keys(localStorage),
    sessionValues: Object.values(sessionStorage).join(' '),
  }), RECEIPT_GUEST_1);
  assert.equal(storageCheck.hrefHasCode, false);
  assert.equal(storageCheck.localKeys.length, 0);
  assert.equal(storageCheck.sessionValues.toLowerCase().includes(RECEIPT_GUEST_1), false);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#privacy-guest-heading');
  assert.equal(await page.locator('#privacy-lookup-result').count(), 0);
  assert.deepEqual(pageErrors, []);

  await context.close();
});

test('로그인 사용자: 실제 진입(#profile·계정 팝업), reportsDeleted/reportsUpdated·profileCleared·storageObjects 구분, 손상 영향 거부, 멱등 재시도', async () => {
  const backend = createSyntheticBackend();
  activeHandler = backend.handle;

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockSupabase(context, USER_A);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // 실제 진입 1: 계정 팝업 → 내 데이터 관리
  await page.goto(origin + '/#notices', { waitUntil: 'networkidle' });
  await page.click('.topbar [data-action="account"]');
  await page.waitForSelector('dialog[open] [data-action="open-privacy"]');
  await page.click('dialog[open] [data-action="open-privacy"]');
  await page.waitForSelector('[data-privacy="select-scope"][data-scope="chat"]');
  assert.equal(await page.evaluate(() => location.hash), '#privacy');

  // 실제 진입 2: #profile → 내 데이터 관리
  await page.goto(origin + '/#profile', { waitUntil: 'networkidle' });
  await page.click('#profile-page-slot a[href="#privacy"]');
  await page.waitForSelector('[data-privacy="select-scope"][data-scope="chat"]');

  const scopes = await page.locator('[data-privacy="select-scope"]').evaluateAll((els) => els.map((el) => el.dataset.scope));
  assert.deepEqual(scopes, ['chat', 'message', 'turn', 'analysis', 'fund', 'upload', 'report', 'profile', 'account']);
  assert.equal(await page.locator('.privacy-destructive-btn').count(), 0);

  // fund 페이지네이션 + XSS 이스케이프 + 손상 영향 2종(필수 키 누락, reports 합계 불일치) 거부
  await page.click('[data-privacy="select-scope"][data-scope="fund"]');
  await page.waitForSelector(`[data-privacy="select-item"][data-item-id="${ITEM_FUND_1}"]`);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await page.click('[data-privacy="load-more-items"]');
  await page.waitForSelector(`[data-privacy="select-item"][data-item-id="${ITEM_FUND_2}"]`);

  backend.setMalformedImpact('missing_counts');
  await page.click(`[data-privacy="select-item"][data-item-id="${ITEM_FUND_1}"]`);
  await page.waitForSelector('.privacy-inline-error');
  assert.equal(await page.locator('[data-privacy="open-confirm"]').count(), 0);

  backend.setMalformedImpact('report_sum_mismatch');
  await page.click('[data-privacy="reload-impact"]');
  await page.waitForSelector('.privacy-inline-error');
  assert.equal(await page.locator('[data-privacy="open-confirm"]').count(), 0);

  // 정상 fund 영향: reportsDeleted=0, reportsUpdated=1 → 삭제가 아니라 관련 금액만 지워짐을 한 번 표시
  await page.click('[data-privacy="reload-impact"]');
  await page.waitForSelector('.privacy-impact-box[data-impact-scope="fund"]');
  const fundDetail = await page.locator('[data-impact-detail="reports"]').textContent();
  assert.match(fundDetail, /저장 보고서 1건은 삭제되지 않고/);
  assert.equal(await page.locator('[data-impact-detail="profile"]').count(), 0);
  assert.equal(await page.locator('[data-impact-detail="storage"]').count(), 0);

  // analysis 영향: reportsDeleted=2, reportsUpdated=1, storageObjects=2 → 삭제·변경 및 미리보기 파일 수 모두 정확 표시
  await page.click('[data-privacy="select-scope"][data-scope="analysis"]');
  await page.waitForSelector(`[data-privacy="select-item"][data-item-id="${ITEM_ANALYSIS_1}"]`);
  await page.click(`[data-privacy="select-item"][data-item-id="${ITEM_ANALYSIS_1}"]`);
  await page.waitForSelector('.privacy-impact-box[data-impact-scope="analysis"]');
  assert.match(await page.locator('[data-impact-detail="reports"]').textContent(), /저장 보고서 2건이 삭제되고, 1건에서는 관련 금액·입력 항목이 지워집니다/);
  assert.match(await page.locator('[data-impact-detail="storage"]').textContent(), /확인 시점 기준 정리 대상 업로드 파일 2건/);

  // upload 범위: Escape 취소 + 503 실패 후 동일 접수번호 멱등 재시도 + processing → live_deleted
  await page.click('[data-privacy="select-scope"][data-scope="upload"]');
  await page.waitForSelector(`[data-privacy="select-item"][data-item-id="${ITEM_UPLOAD_1}"]`);
  await page.click(`[data-privacy="select-item"][data-item-id="${ITEM_UPLOAD_1}"]`);
  await page.waitForSelector('.privacy-impact-box[data-impact-scope="upload"]');
  assert.equal(await page.locator('.privacy-destructive-btn').count(), 0);
  assert.match(await page.locator('[data-impact-detail="storage"]').textContent(), /정리 대상 업로드 파일 1건/);

  await page.click('[data-privacy="open-confirm"]');
  await page.waitForSelector('#privacy-confirm-stage');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-privacy')), 'cancel-confirm');
  assert.equal(await page.locator('.privacy-destructive-btn').count(), 1);

  await page.keyboard.press('Escape');
  await page.waitForSelector('#privacy-confirm-stage', { state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-privacy')), 'open-confirm');

  await page.click('[data-privacy="open-confirm"]');
  await page.waitForSelector('#privacy-confirm-stage');
  backend.setFailNextRequest('backend_unavailable', 503);
  await page.click('[data-privacy="confirm-delete"]');
  await page.waitForSelector('#privacy-submit-error');
  assert.match(await page.locator('#privacy-submit-error code').innerText(), RECEIPT_UUID_RE);
  await page.click('[data-privacy="confirm-delete"]');
  await page.waitForSelector('#privacy-latest-receipt');

  const reqCalls = backend.calls.filter((c) => c.pathname === '/api/v1/privacy/requests');
  assert.equal(reqCalls.length, 2);
  assert.equal(reqCalls[0].body.receiptId, reqCalls[1].body.receiptId);
  assert.equal(reqCalls[1].body.confirmed, true);

  const issuedCode = await page.locator('#privacy-latest-receipt').getAttribute('data-receipt-id');
  assert.match(issuedCode, RECEIPT_UUID_RE);
  assert.match(await page.locator('#privacy-latest-receipt').textContent(), /업로드 파일을 포함한 삭제 처리 중일 수 있습니다/);

  backend.completeReceipt(issuedCode);
  await page.click('#privacy-latest-receipt [data-privacy="refresh-receipt"]');
  await page.waitForFunction(
    () => document.querySelector('#privacy-latest-receipt')?.dataset.receiptStatus === 'live_deleted',
  );
  assert.match(await page.locator('#privacy-latest-receipt').textContent(), /서비스에서 삭제 완료/);
  assert.match(await page.locator('#privacy-latest-receipt').textContent(), /백업 미확인/);
  assert.deepEqual(pageErrors, []);

  await context.close();
});

test('단일 범위(profileCleared) 표시, 지연 응답 무효화, 계정 전환 격리', async () => {
  const backend = createSyntheticBackend();
  activeHandler = backend.handle;

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockSupabase(context, USER_A);
  const page = await context.newPage();

  await page.goto(origin + '/#privacy', { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-privacy="select-scope"][data-scope="chat"]');

  const releaseChatImpact = backend.setImpactDelay('chat');
  await page.click('[data-privacy="select-scope"][data-scope="chat"]');
  await page.waitForSelector(`[data-privacy="select-item"][data-item-id="${ITEM_CHAT_1}"]`);
  await page.click(`[data-privacy="select-item"][data-item-id="${ITEM_CHAT_1}"]`);

  await page.click('[data-privacy="select-scope"][data-scope="profile"]');
  await page.waitForSelector('.privacy-impact-box[data-impact-scope="profile"]');
  releaseChatImpact();
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.privacy-impact-box').getAttribute('data-impact-scope'), 'profile');
  assert.match(await page.locator('[data-impact-detail="profile"]').textContent(), /승인된 공유 프로필 조건.*출퇴근 목적지도 함께 삭제됩니다/);
  assert.equal(await page.locator('[data-impact-detail="reports"]').count(), 0);
  assert.equal(await page.locator('[data-impact-detail="storage"]').count(), 0);

  await page.evaluate((u) => {
    window.__mockAuth.setUser(u);
  }, USER_B);
  await page.waitForFunction(() => !document.querySelector('.privacy-impact-box'));
  await page.click('[data-privacy="select-scope"][data-scope="fund"]');
  await page.waitForSelector('[data-privacy="select-item"]');
  const bobText = await page.locator('.privacy-item-list').textContent();
  assert.match(bobText, /사용자 B 자금 항목/);
  assert.doesNotMatch(bobText, /보유 현금 3억 원/);

  await context.close();
});

test('계정 전체 삭제: profileCleared·reportsDeleted·storageObjects, IME 조합, 요청 실패와 부모 단일 signOut·참조 해제 구분', async () => {
  const backend = createSyntheticBackend();
  activeHandler = backend.handle;

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockSupabase(context, USER_A);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(origin + '/#privacy', { waitUntil: 'networkidle' });
  await page.click('[data-privacy="select-scope"][data-scope="account"]');
  await page.waitForSelector('.privacy-impact-box[data-impact-scope="account"]');
  assert.match(await page.locator('[data-impact-detail="reports"]').textContent(), /저장 보고서 2건이 삭제됩니다/);
  assert.match(await page.locator('[data-impact-detail="profile"]').textContent(), /승인된 공유 프로필 조건.*출퇴근 목적지/);
  assert.match(await page.locator('[data-impact-detail="storage"]').textContent(), /정리 대상 업로드 파일 1건/);

  await page.click('[data-privacy="open-confirm"]');
  await page.waitForSelector('#privacy-account-phrase');

  const imeOk = await page.evaluate(() => {
    const input = document.getElementById('privacy-account-phrase');
    input.focus();
    const initialNode = input;
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    input.value = '계정 삭ㅈ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const disabledDuring = document.querySelector('[data-privacy="confirm-delete"]').disabled;
    input.value = '계정 삭제';
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '계정 삭제' }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      sameNode: document.getElementById('privacy-account-phrase') === initialNode,
      stillFocused: document.activeElement === initialNode,
      disabledDuring,
      enabledAfter: !document.querySelector('[data-privacy="confirm-delete"]').disabled,
    };
  });
  assert.deepEqual(imeOk, { sameNode: true, stillFocused: true, disabledDuring: true, enabledAfter: true });

  backend.setFailNextRequest('backend_unavailable', 503);
  await page.click('[data-privacy="confirm-delete"]');
  await page.waitForSelector('#privacy-submit-error');
  assert.equal(await page.evaluate(() => window.__mockAuth.getSignOutCalls()), 0);
  assert.equal(await page.locator('#privacy-guest-heading').count(), 0);

  // 서버가 계정을 접수한 직후 응답이 유실된 경우 공개 접수 조회로 복구한다.
  await page.route('**/api/v1/privacy/requests', async route => {
    const accepted = await route.fetch();
    assert.equal(accepted.status(), 202);
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'backend_unavailable'})});
  }, {times:1});
  await page.click('[data-privacy="retry-delete"]');
  await page.waitForSelector('#privacy-guest-heading');
  await page.waitForSelector('#privacy-account-receipt');
  assert.equal(await page.evaluate(() => window.__mockAuth.getSignOutCalls()), 1);

  const accountReceiptId = await page.locator('#privacy-account-receipt article[data-receipt-id]').getAttribute('data-receipt-id');
  assert.match(accountReceiptId, RECEIPT_UUID_RE);
  assert.doesNotMatch(await page.locator('#privacy-account-receipt').textContent(), /privacy-alice@example\.invalid/);
  assert.equal(await page.evaluate(() => location.href.toLowerCase()), (origin + '/#privacy').toLowerCase());
  assert.equal(await page.evaluate(() => localStorage.length), 0);

  // 명시적 닫기 후 같은 #privacy 경로 재진입 시 부모 참조도 이미 비워져 접수번호가 되살아나지 않음
  await page.click('[data-privacy="clear-account-receipt"]');
  assert.equal(await page.locator('#privacy-account-receipt').count(), 0);
  await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#privacy-account-receipt').count(), 0);

  // 비로그인 상태에서 복사한 접수번호 직접 입력 조회 가능
  backend.completeReceipt(accountReceiptId);
  await page.fill('#privacy-receipt-input', accountReceiptId);
  await page.click('#privacy-receipt-form button[type="submit"]');
  await page.waitForSelector('#privacy-lookup-result');
  assert.match(await page.locator('#privacy-lookup-result').textContent(), /서비스에서 삭제 완료/);

  // 다른 계정 로그인 시 이전 조회 결과 소거
  await page.evaluate((u) => window.__mockAuth.setUser(u), USER_B);
  await page.waitForSelector('[data-privacy="select-scope"][data-scope="chat"]');
  assert.equal(await page.locator('#privacy-account-receipt').count(), 0);
  assert.equal(await page.locator('#privacy-lookup-result').count(), 0);
  assert.deepEqual(pageErrors, []);

  await context.close();
});

test('모바일(390px) 실제 하단 메뉴 진입 및 데스크톱(1440px) 가로 넘침 없음', async () => {
  const backend = createSyntheticBackend();
  activeHandler = backend.handle;

  for (const [viewport, viaMobileNav] of [
    [{ width: 390, height: 844 }, true],
    [{ width: 1440, height: 900 }, false],
  ]) {
    const context = await browser.newContext({ viewport });
    await installMockSupabase(context, USER_A);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    if (viaMobileNav) {
      await page.goto(origin + '/#notices', { waitUntil: 'networkidle' });
      await page.click('.mobile-nav [data-action="account"]');
      await page.waitForSelector('dialog[open] [data-action="open-privacy"]');
      await page.click('dialog[open] [data-action="open-privacy"]');
    } else {
      await page.goto(origin + '/#privacy', { waitUntil: 'networkidle' });
    }
    await page.waitForSelector('[data-privacy="select-scope"][data-scope="account"]');
    await page.click('[data-privacy="select-scope"][data-scope="account"]');
    await page.waitForSelector('.privacy-impact-box[data-impact-scope="account"]');
    await page.click('[data-privacy="open-confirm"]');
    await page.waitForSelector('#privacy-account-phrase');

    await page.fill('#privacy-receipt-input', RECEIPT_GUEST_1);
    await page.click('#privacy-receipt-form button[type="submit"]');
    await page.waitForSelector('#privacy-lookup-result');

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert.ok(
      overflow.scrollWidth <= overflow.innerWidth,
      `${viewport.width}px에서 가로 넘침 발생: scrollWidth=${overflow.scrollWidth} > innerWidth=${overflow.innerWidth}`,
    );
    assert.deepEqual(pageErrors, []);
    await context.close();
  }
});
