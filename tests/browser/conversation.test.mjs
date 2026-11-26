// 완료된 비교 분석 대화 UI의 데스크톱·모바일, IME·키보드, 복원·오류·409 재시도·계정 전환·게스트 예시를 검증한다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { createDevServer } from '../../dev/server.ts';
import { serveWorkspace } from '../../dev/static.ts';
import { createHandler } from '../../src/server/handler.ts';
import { parseComparisonSnapshot } from '../../src/server/analysis-runs.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let server, browser, origin, comparisonFixture;

before(async () => {
  comparisonFixture = JSON.parse(
    await readFile(new URL('../../public/app/assets/comparison-example.json', import.meta.url), 'utf8'),
  );
  const config = { supabaseUrl: 'https://synthetic.invalid', publishableKey: 'sb_publishable_TEST_ONLY' };
  const api = async (request) =>
    new URL(request.url).pathname === '/api/v1/client-config'
      ? Response.json(config)
      : Response.json({ error: 'authentication_required' }, { status: 401 });
  server = createDevServer((request) => serveWorkspace(request, api));
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

async function installMockAuth(context, initialUser, analyses = []) {
  await context.addInitScript(
    ({ user, rows }) => {
      let current = user;
      let listeners = [];
      window.__mockAuth = {
        switchUser(nextUser) {
          current = nextUser;
          for (const cb of listeners) cb(nextUser ? 'SIGNED_IN' : 'SIGNED_OUT', nextUser ? { user: nextUser, access_token: 'TOKEN_' + nextUser.id } : null);
        },
        setAnalyses(nextRows) {
          rows = nextRows;
        },
      };
      const auth = {
        getSession: async () => ({
          data: { session: current ? { user: current, access_token: 'TOKEN_' + current.id } : null },
          error: null,
        }),
        signInWithPassword: async ({ email }) => {
          const next = current && current.email === email
            ? current
            : { id: 'b2000000-0000-4000-8000-000000000099', email };
          current = next;
          const session = { user: current, access_token: 'TOKEN_' + current.id };
          return { data: { session }, error: null };
        },
        signOut: async () => {
          current = null;
          return { error: null };
        },
        onAuthStateChange: (cb) => {
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
      };
      const query = {
        select() { return this; },
        eq() { return this; },
        not() { return this; },
        order() { return this; },
        limit: async () => ({ data: rows, error: null }),
      };
      globalThis.supabase = { createClient: () => ({ auth, from: () => query }) };
    },
    { user: initialUser, rows: analyses },
  );
}

for (const width of [1440, 390]) {
  test(`authenticated comparison conversation layout, IME, code points, XSS safety and approve/reject/cancel at ${width}px`, async () => {
    const aid = 'a1000000-0000-4000-8000-000000000010';
    const rid1 = 'a1000000-0000-4000-8000-000000000011';
    const rid2 = 'a1000000-0000-4000-8000-000000000012';
    const snap1 = 'a1000000-0000-4000-8000-000000000013';
    const snap2 = 'a1000000-0000-4000-8000-000000000014';
    const owner = { id: 'a1000000-0000-4000-8000-000000000015', email: 'buyer@example.invalid' };

    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await installMockAuth(ctx, owner, [
      { id: aid, latest_run_id: rid1, title: '합성 가람 아파트', status: 'completed', updated_at: '2026-11-10T01:00:00Z' },
    ]);

    const turnsByRun = {
      [rid1]: [
        {
          id: 'turn-initial',
          runId: rid1,
          message: '기존 질문입니다',
          intent: 'inclusion',
          createdAt: '2026-11-10T01:01:00Z',
          answer: '가람동에서 공급면적 ±5% 기준을 충족한 거래만 포함했습니다.',
          proposal: null,
        },
      ],
      [rid2]: [
        {
          id: 'turn-run2',
          runId: rid2,
          message: '새 실행 기록 확인',
          intent: 'period',
          createdAt: '2026-11-10T02:00:00Z',
          answer: '2026.10.12 – 2026.10.25 기간으로 재비교한 실행의 별도 대화입니다.',
          proposal: null,
        },
      ],
    };

    const run2States = ['queued', 'running', 'finished'];
    let run2Polls = 0;
    const postedMessages = [];
    const decisions = [];

    const comparison2 = structuredClone(comparisonFixture);
    comparison2.conditions.period.start = '2026-10-12';
    comparison2.conditions.period.end = '2026-10-25';

    await ctx.route('**/*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      const p = url.pathname;

      if (p === `/api/v1/analyses/${aid}/runs/${rid1}`) {
        return route.fulfill({
          json: { analysisId: aid, runId: rid1, snapshotId: snap1, status: 'finished', input: { kind: 'snapshot' } },
        });
      }
      if (p === `/api/v1/analyses/${aid}/runs/${rid1}/result`) {
        return route.fulfill({
          json: { analysisId: aid, runId: rid1, snapshotId: snap1, result: comparisonFixture },
        });
      }
      if (p === `/api/v1/analyses/${aid}/runs/${rid2}`) {
        const status = run2States[Math.min(run2Polls, run2States.length - 1)];
        run2Polls++;
        return route.fulfill({
          json: {
            analysisId: aid,
            runId: rid2,
            snapshotId: status === 'finished' ? snap2 : null,
            status,
            submittedAt: '2026-11-10T01:55:00Z',
            input: { kind: 'snapshot' },
          },
        });
      }
      if (p === `/api/v1/analyses/${aid}/runs/${rid2}/result`) {
        return route.fulfill({
          json: { analysisId: aid, runId: rid2, snapshotId: snap2, result: comparison2 },
        });
      }

      const convMatch = p.match(/^\/api\/v1\/analyses\/([^/]+)\/runs\/([^/]+)\/conversation$/);
      if (convMatch) {
        const rid = convMatch[2];
        if (req.method() === 'GET') {
          return route.fulfill({
            json: {
              contractVersion: 'analysis-conversation/v1',
              analysisId: aid,
              runId: rid,
              hasEarlier: rid === rid1,
              turns: turnsByRun[rid] ?? [],
            },
          });
        }
        if (req.method() === 'POST') {
          const body = req.postDataJSON();
          assert.match(body.requestId, UUID_RE);
          postedMessages.push(body);
          const id = 'turn-' + postedMessages.length;
          let turn;
          if (body.message.includes('최근 6개월')) {
            turn = {
              id,
              runId: rid,
              message: body.message,
              intent: 'change_period',
              createdAt: '2026-11-10T01:05:00Z',
              answer: '최근 6개월 기간 변경을 제안합니다.',
              proposal: {
                start: '2026-05-11',
                end: '2026-11-10',
                previousStart: '2026-10-10',
                previousEnd: '2026-10-31',
                status: 'pending',
                resultRunId: null,
              },
            };
          } else if (body.message.includes('2026-10-12')) {
            turn = {
              id,
              runId: rid,
              message: body.message,
              intent: 'change_period',
              createdAt: '2026-11-10T01:06:00Z',
              answer: '2026-10-12부터 2026-10-25까지 기간 변경을 제안합니다.',
              proposal: {
                start: '2026-10-12',
                end: '2026-10-25',
                previousStart: '2026-10-10',
                previousEnd: '2026-10-31',
                status: 'pending',
                resultRunId: null,
              },
            };
          } else {
            turn = {
              id,
              runId: rid,
              message: body.message,
              intent: 'inclusion',
              createdAt: '2026-11-10T01:04:00Z',
              answer: '안전한 답변 <img src=x onerror="window.__xss=1"><script>window.__xss=2</script>',
              proposal: null,
            };
          }
          turnsByRun[rid] = [...(turnsByRun[rid] ?? []), turn];
          return route.fulfill({
            json: {
              contractVersion: 'analysis-conversation/v1',
              analysisId: aid,
              runId: rid,
              hasEarlier: rid === rid1,
              turns: turnsByRun[rid],
            },
          });
        }
      }

      const decMatch = p.match(/^\/api\/v1\/analyses\/([^/]+)\/runs\/([^/]+)\/conversation\/([^/]+)\/decision$/);
      if (decMatch && req.method() === 'POST') {
        const [, , rid, turnId] = decMatch;
        const body = req.postDataJSON();
        decisions.push({ rid, turnId, decision: body.decision });
        const statusMap = { approve: 'approved', reject: 'rejected', cancel: 'cancelled' };
        turnsByRun[rid] = turnsByRun[rid].map((t) =>
          t.id === turnId
            ? {
                ...t,
                proposal: {
                  ...t.proposal,
                  status: statusMap[body.decision],
                  resultRunId: body.decision === 'approve' ? rid2 : null,
                },
              }
            : t,
        );
        return route.fulfill({
          json: {
            contractVersion: 'analysis-conversation/v1',
            analysisId: aid,
            runId: rid,
            hasEarlier: rid === rid1,
            turns: turnsByRun[rid],
          },
        });
      }

      return route.continue();
    });

    try {
      const page = await ctx.newPage();
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));

      await page.goto(`${origin}/#run/${aid}/${rid1}`);
      await page.getByRole('heading', { name: '비교 대화' }).waitFor();
      await page.getByText('이전 대화가 더 있습니다. 이 실행의 최근 대화를 표시합니다.').waitFor();
      await page.getByText('기존 질문입니다', { exact: true }).waitFor();

      // S-05 §4·§7.6: 데스크톱은 왼쪽 --chat-width(420px) 대화 + 오른쪽 결과, 모바일은 결과 우선 + '대화로 질문하기' 점프.
      const stageBox = await page.locator('.comparison-stage').boundingBox();
      const convBox = await page.locator('.conversation-panel').boundingBox();
      assert.ok(stageBox && convBox);
      if (width === 1440) {
        assert.ok(
          convBox.x + convBox.width <= stageBox.x + 1,
          'desktop conversation panel must sit to the left of the comparison result',
        );
        assert.equal(Math.round(convBox.width), 420, 'desktop conversation panel must use --chat-width (420px)');
        assert.equal(await page.locator('.conv-jump-btn').isVisible(), false);

        // 1440px 펼친 레일에서도 왼쪽 대화 순서와 가로 넘침 없음을 유지한다.
        await page.getByRole('button', { name: '메뉴 펼치기', exact: true }).click();
        assert.equal(await page.locator('.rail-toggle').getAttribute('aria-expanded'), 'true');
        const expandedStage = await page.locator('.comparison-stage').boundingBox();
        const expandedConv = await page.locator('.conversation-panel').boundingBox();
        assert.ok(expandedConv.x + expandedConv.width <= expandedStage.x + 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

        // 1280px 최소 데스크톱 너비에서 접힌 레일(420px)과 펼친 레일 모두 가로 넘침 없이 동작한다.
        await page.setViewportSize({ width: 1280, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.getByRole('button', { name: '메뉴 접기', exact: true }).click();
        const stage1280 = await page.locator('.comparison-stage').boundingBox();
        const conv1280 = await page.locator('.conversation-panel').boundingBox();
        assert.ok(conv1280.x + conv1280.width <= stage1280.x + 1);
        assert.equal(Math.round(conv1280.width), 420);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.setViewportSize({ width: 1440, height: 900 });
      } else {
        assert.ok(convBox.y >= stageBox.y + stageBox.height - 2, 'mobile conversation panel must stack below result');
        const jump = page.getByRole('button', { name: '대화로 질문하기', exact: true });
        await jump.waitFor();
        const hashBefore = await page.evaluate(() => location.hash);
        await jump.focus();
        await jump.press('Enter');
        assert.equal(await page.evaluate(() => location.hash), hashBefore);
        assert.equal(await page.locator('#conversation-input').evaluate((el) => el === document.activeElement), true);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

      // 예시 버튼 클릭은 자동 전송하지 않고 입력란만 채우고 포커스를 둔다.
      const input = page.locator('#conversation-input');
      await page.getByRole('button', { name: '왜 이 거래만 포함됐어?', exact: true }).click();
      assert.equal(await input.inputValue(), '왜 이 거래만 포함됐어?');
      assert.equal(await input.evaluate((el) => el === document.activeElement), true);
      assert.equal(postedMessages.length, 0);

      // 한글 IME 조합 중 Enter는 전송하지 않는다.
      await input.evaluate((el) => {
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '왜' }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });
      assert.equal(postedMessages.length, 0);
      await input.evaluate((el) => {
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '왜' }));
      });

      // Shift+Enter는 줄바꿈이며 전송하지 않는다.
      await input.press('Shift+Enter');
      assert.equal(postedMessages.length, 0);

      // 801 코드포인트는 차단하고, 800 코드포인트(이모지/서로게이트 포함)는 허용한다.
      await input.fill('🏠'.repeat(801));
      await page.locator('#conversation-validation').getByText('800자(유니코드 문자 기준) 이하로 입력하세요.').waitFor();
      assert.equal(await page.locator('#conversation-send-btn').isDisabled(), true);
      assert.equal(postedMessages.length, 0);

      await input.fill('🏠'.repeat(800));
      assert.equal(await page.locator('#conversation-count').innerText(), '800 / 800');
      assert.equal(await page.locator('#conversation-send-btn').isDisabled(), false);

      // XSS 페이로드 안전 렌더링 확인 (Enter 전송).
      const payload = '왜 이 거래만 포함됐어? <img src=x onerror="window.__xss=3">';
      await input.fill(payload);
      await input.press('Enter');
      await page.getByText('안전한 답변 <img src=x onerror="window.__xss=1"><script>window.__xss=2</script>', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__xss ?? null), null);
      assert.equal(await page.locator('.conv-thread img, .conv-thread script').count(), 0);

      // 제안 거절 (reject): 새 실행을 시작하지 않고 기존 조건 유지.
      await page.getByRole('button', { name: '최근 6개월로 다시 비교해줘', exact: true }).click();
      await page.getByRole('button', { name: '보내기' }).click();
      const rejectCard = page.locator('.conv-approve').last();
      await rejectCard.getByText('이번 분석에만 적용', { exact: true }).waitFor();
      assert.equal(decisions.length, 0); // 자동 결정 없음
      await rejectCard.getByRole('button', { name: '거절', exact: true }).click();
      await rejectCard.getByText('거절했습니다. 기존 조건을 유지합니다.', { exact: true }).waitFor();
      assert.ok(page.url().endsWith(`#run/${aid}/${rid1}`));

      // 제안 취소 (cancel): 새 실행을 시작하지 않고 기존 조건 유지.
      await page.getByRole('button', { name: '2026-10-12부터 2026-10-25까지로 바꿔줘', exact: true }).click();
      await input.press('Enter');
      const cancelCard = page.locator('.conv-approve').last();
      await cancelCard.getByRole('button', { name: '취소', exact: true }).click();
      await cancelCard.getByText('취소했습니다. 기존 조건을 유지합니다.', { exact: true }).waitFor();
      assert.ok(page.url().endsWith(`#run/${aid}/${rid1}`));

      // 명시적 승인 (approve): 새 실행 #run/{aid}/{rid2}로 이동해 queued -> running -> finished 추적 + 원래 실행 링크 유지.
      await page.getByRole('button', { name: '2026-10-12부터 2026-10-25까지로 바꿔줘', exact: true }).click();
      await input.press('Enter');
      const approveCard = page.locator('.conv-approve').last();
      await approveCard.getByRole('button', { name: '이 조건으로 다시 비교' }).click();
      await page.waitForFunction((expected) => location.hash === expected, `#run/${aid}/${rid2}`);
      await page.locator('[data-run-status="queued"]').waitFor();
      await page.getByRole('link', { name: '이전 결과와 대화 보기' }).waitFor();

      // 상태 새로고침으로 running -> finished 전환 확인 (기존 경로 유지).
      await page.getByRole('button', { name: '상태 새로고침' }).click();
      await page.locator('[data-run-status="running"]').waitFor();
      await page.getByRole('button', { name: '상태 새로고침' }).click();
      await page.locator('[data-run-status="finished"]').waitFor();

      // 새 실행은 자체 실행별 대화 기록을 표시한다.
      await page.getByText('2026.10.12 – 2026.10.25 기간으로 재비교한 실행의 별도 대화입니다.').waitFor();
      assert.equal(await page.getByText('기존 질문입니다', { exact: true }).count(), 0);

      // 이전 결과와 대화 보기 링크로 원래 실행에 다시 접근 가능하며, 원래 실행에 승인 기록과 새 실행 링크가 남아 있다.
      await page.getByRole('link', { name: '이전 결과와 대화 보기' }).click();
      await page.waitForFunction((expected) => location.hash === expected, `#run/${aid}/${rid1}`);
      await page.getByText('기존 질문입니다', { exact: true }).waitFor();
      assert.equal(
        await page.getByRole('link', { name: '새 실행 결과 보기' }).getAttribute('href'),
        `#run/${aid}/${rid2}`,
      );
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
    } finally {
      await ctx.close();
    }
  });
}

test('errors, 409 conflict, retry with same client UUID, restore on reload/relogin, and account switch isolation', async () => {
  const aidA = 'c1000000-0000-4000-8000-000000000001';
  const ridA = 'c1000000-0000-4000-8000-000000000002';
  const snapA = 'c1000000-0000-4000-8000-000000000003';
  const userA = { id: 'c1000000-0000-4000-8000-000000000004', email: 'alice@example.invalid' };

  const aidB = 'd2000000-0000-4000-8000-000000000001';
  const ridB = 'd2000000-0000-4000-8000-000000000002';
  const snapB = 'd2000000-0000-4000-8000-000000000003';
  const userB = { id: 'd2000000-0000-4000-8000-000000000004', email: 'bob@example.invalid' };

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockAuth(ctx, userA, [
    { id: aidA, latest_run_id: ridA, title: '합성 가람 아파트', status: 'completed', updated_at: '2026-11-10T01:00:00Z' },
  ]);

  let postScript = [
    { status: 503, body: { error: 'backend_unavailable' } },
    { status: 409, body: { error: 'conversation_conflict' } },
    { status: 200, makeProposal: true },
    { status: 409, body: { error: 'conversation_period_unavailable' } },
    { status: 429, body: { error: 'run_rate_limited' } },
    { status: 400, body: { error: 'invalid_conversation_input' } },
    { status: 403, body: { error: 'comparison_source_restricted' } },
    { status: 404, body: { error: 'run_not_found' } },
    { status: 409, body: { error: 'comparison_not_available' } },
  ];
  let decisionScript = [
    { status: 409, body: { error: 'conversation_conflict' } },
    { status: 200 },
  ];

  const seenPosts = [];
  const authHeaders = [];
  const turnsA = [];
  const turnsB = [
    {
      id: 'turn-b-1',
      runId: ridB,
      message: '사용자 B의 비공개 질문',
      intent: 'inclusion',
      createdAt: '2026-11-10T03:00:00Z',
      answer: '사용자 B의 실행에 저장된 답변입니다.',
      proposal: null,
    },
  ];

  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    const p = url.pathname;
    const auth = req.headers().authorization;

    if (p === `/api/v1/analyses/${aidA}/runs/${ridA}`) {
      if (auth !== 'Bearer TOKEN_' + userA.id) return route.fulfill({ status: 404, json: { error: 'run_not_found' } });
      return route.fulfill({ json: { analysisId: aidA, runId: ridA, snapshotId: snapA, status: 'finished', input: { kind: 'snapshot' } } });
    }
    if (p === `/api/v1/analyses/${aidA}/runs/${ridA}/result`) {
      if (auth !== 'Bearer TOKEN_' + userA.id) return route.fulfill({ status: 404, json: { error: 'run_not_found' } });
      return route.fulfill({ json: { analysisId: aidA, runId: ridA, snapshotId: snapA, result: comparisonFixture } });
    }
    if (p === `/api/v1/analyses/${aidB}/runs/${ridB}`) {
      return route.fulfill({ json: { analysisId: aidB, runId: ridB, snapshotId: snapB, status: 'finished', input: { kind: 'snapshot' } } });
    }
    if (p === `/api/v1/analyses/${aidB}/runs/${ridB}/result`) {
      return route.fulfill({ json: { analysisId: aidB, runId: ridB, snapshotId: snapB, result: comparisonFixture } });
    }

    if (p === `/api/v1/analyses/${aidA}/runs/${ridA}/conversation`) {
      authHeaders.push({ path: p, auth });
      if (req.method() === 'GET') {
        return route.fulfill({
          json: { contractVersion: 'analysis-conversation/v1', analysisId: aidA, runId: ridA, hasEarlier: false, turns: turnsA },
        });
      }
      if (req.method() === 'POST') {
        const payload = req.postDataJSON();
        seenPosts.push(payload);
        const step = postScript.shift() ?? { status: 200 };
        if (step.status !== 200) return route.fulfill({ status: step.status, json: step.body });
        turnsA.push({
          id: 'turn-a-' + turnsA.length,
          runId: ridA,
          message: payload.message,
          intent: step.makeProposal ? 'change_period' : 'inclusion',
          createdAt: '2026-11-10T01:10:00Z',
          answer: '사용자 A의 재시도 성공 답변입니다.',
          proposal: step.makeProposal
            ? {
                start: '2026-10-12',
                end: '2026-10-25',
                previousStart: '2026-10-10',
                previousEnd: '2026-10-31',
                status: 'pending',
                resultRunId: null,
              }
            : null,
        });
        return route.fulfill({
          json: { contractVersion: 'analysis-conversation/v1', analysisId: aidA, runId: ridA, hasEarlier: false, turns: turnsA },
        });
      }
    }

    if (p.startsWith(`/api/v1/analyses/${aidA}/runs/${ridA}/conversation/`) && p.endsWith('/decision')) {
      const step = decisionScript.shift() ?? { status: 200 };
      if (step.status !== 200) return route.fulfill({ status: step.status, json: step.body });
      turnsA[0] = { ...turnsA[0], proposal: { ...turnsA[0].proposal, status: 'rejected', resultRunId: null } };
      return route.fulfill({
        json: { contractVersion: 'analysis-conversation/v1', analysisId: aidA, runId: ridA, hasEarlier: false, turns: turnsA },
      });
    }

    if (p === `/api/v1/analyses/${aidB}/runs/${ridB}/conversation` && req.method() === 'GET') {
      authHeaders.push({ path: p, auth });
      return route.fulfill({
        json: { contractVersion: 'analysis-conversation/v1', analysisId: aidB, runId: ridB, hasEarlier: false, turns: turnsB },
      });
    }

    return route.continue();
  });

  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(7000);
    await page.goto(`${origin}/#run/${aidA}/${ridA}`);
    await page.getByRole('heading', { name: '비교 대화' }).waitFor();

    // 1) 503 -> 다시 시도 -> 409 conversation_conflict -> 다시 시도 -> 200: 모두 동일한 클라이언트 UUID 재사용!
    const input = page.locator('#conversation-input');
    await input.fill('2026-10-12부터 2026-10-25까지로 바꿔줘');
    await input.press('Enter');
    await page.locator('#conversation-submit-error').getByText('서비스에 연결할 수 없습니다. 잠시 후 다시 시도하세요.').waitFor();

    await page.getByRole('button', { name: '다시 시도' }).click();
    await page.locator('#conversation-submit-error').getByText('다른 대화나 결정이 먼저 처리됐습니다. 최신 대화 내역을 확인한 뒤 다시 진행하세요.').waitFor();
    await page.getByRole('button', { name: '최신 대화 불러오기' }).waitFor();

    await page.getByRole('button', { name: '다시 시도' }).click();
    await page.getByText('사용자 A의 재시도 성공 답변입니다.').waitFor();

    assert.equal(seenPosts.length, 3);
    assert.match(seenPosts[0].requestId, UUID_RE);
    assert.equal(seenPosts[1].requestId, seenPosts[0].requestId, 'Retry after 503 must reuse same client UUID');
    assert.equal(seenPosts[2].requestId, seenPosts[0].requestId, 'Retry after 409 must reuse same client UUID');

    // 2) 결정 409 conversation_conflict -> 다시 시도 -> 성공.
    const card = page.locator('.conv-approve').first();
    await card.getByRole('button', { name: '거절', exact: true }).click();
    await card.getByText('다른 대화나 결정이 먼저 처리됐습니다. 최신 대화 내역을 확인한 뒤 다시 진행하세요.').waitFor();
    await card.getByRole('button', { name: '다시 시도' }).click();
    await card.getByText('거절했습니다. 기존 조건을 유지합니다.').waitFor();

    // 3) 나머지 오류 키 (409 period_unavailable, 429, 400, 403, 404, 409 comparison_not_available) 및 메시지 수정 시 새 UUID 발급.
    const expectedErrors = [
      ['기간 오류 테스트', '요청한 기간은 현재 수집 자료로 비교할 수 없습니다. 기간을 조정해 다시 질문하세요.'],
      ['한도 테스트', '최근 분석 요청이 많습니다. 1분 뒤 다시 시도하세요.'],
      ['입력 오류 테스트', '질문은 1~800자 이내로 입력하고, 현재 분석 화면에서 다시 시도하세요.'],
      ['출처 제한 테스트', '이 결과에 사용된 출처의 표시 권한을 확인 중입니다.'],
      ['없는 실행 테스트', '이 계정에서 조회할 수 있는 분석이 없습니다.'],
      ['비교 미준비 테스트', '아직 저장된 비교 결과가 없습니다. 실행 상태를 확인하세요.'],
    ];
    let prevUuid = seenPosts[0].requestId;
    for (const [msg, expected] of expectedErrors) {
      await input.fill(msg);
      await input.press('Enter');
      await page.locator('#conversation-submit-error').getByText(expected, { exact: true }).waitFor();
      const latestUuid = seenPosts.at(-1).requestId;
      assert.notEqual(latestUuid, prevUuid, 'Edited message must issue a fresh client UUID');
      prevUuid = latestUuid;
    }

    // 4) 새로고침(재오픈) 시 서버 API 이력 복원.
    await page.reload();
    await page.getByText('사용자 A의 재시도 성공 답변입니다.').waitFor();
    await page.getByText('거절했습니다. 기존 조건을 유지합니다.').waitFor();

    // 4-b) 로그아웃 후 같은 계정으로 재로그인 -> 원래 실행을 다시 열면 서버 API 이력이 복원된다.
    await page.locator('.topbar [data-action="account"]').click();
    await page.locator('dialog[open] [data-action="logout"]').click();
    await page.waitForFunction(() => location.hash === '#notices');
    assert.equal(await page.getByText('사용자 A의 재시도 성공 답변입니다.').count(), 0);

    await page.evaluate((sameUser) => window.__mockAuth.switchUser(sameUser), userA);
    await page.goto(`${origin}/#run/${aidA}/${ridA}`);
    await page.getByText('사용자 A의 재시도 성공 답변입니다.').waitFor();
    await page.getByText('거절했습니다. 기존 조건을 유지합니다.').waitFor();

    // 5) 계정 전환 시 사용자 A의 대화·초안이 완전히 제거되고 사용자 B에게 노출되지 않는다.
    await page.locator('#conversation-input').fill('사용자 A의 미전송 비공개 초안');
    await page.evaluate((nextUser) => window.__mockAuth.switchUser(nextUser), userB);
    await page.waitForFunction(() => location.hash === '#notices');
    assert.equal(await page.getByText('사용자 A의 재시도 성공 답변입니다.').count(), 0);
    assert.equal(await page.getByText('사용자 A의 미전송 비공개 초안').count(), 0);

    await page.goto(`${origin}/#run/${aidB}/${ridB}`);
    await page.getByText('사용자 B의 실행에 저장된 답변입니다.').waitFor();
    assert.equal(await page.getByText('사용자 A의 재시도 성공 답변입니다.').count(), 0);
    assert.equal(await page.locator('#conversation-input').inputValue(), '');

    // 브라우저 저장소에 대화 본문이 남지 않는다.
    const stored = await page.evaluate(() => JSON.stringify([Object.values(localStorage), Object.values(sessionStorage)]));
    assert.equal(stored.includes('사용자 A'), false);
    assert.equal(stored.includes('사용자 B'), false);
    assert.ok(authHeaders.some((h) => h.path.includes(ridB) && h.auth === 'Bearer TOKEN_' + userB.id));
  } finally {
    await ctx.close();
  }
});

for (const width of [1440, 390]) {
  test(`synthetic guest sample labels preview, explains grounded data, previews proposal with login link and zero API/storage at ${width}px`, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    const forbiddenCalls = [];
    await ctx.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.startsWith('/api/v1/analyses/')) {
        forbiddenCalls.push(url.pathname);
      }
      return route.continue();
    });
    try {
      const page = await ctx.newPage();
      page.setDefaultTimeout(6500);
      await page.goto(`${origin}/#sample/saved`);
      await page.getByText('합성 예시 대화', { exact: true }).waitFor();

      // 1) 실경로와 동일한 conversationExample 기반 근거 설명 및 후속 질문 확인
      await page.getByRole('button', { name: '왜 이 거래만 포함됐어?', exact: true }).click();
      await page.locator('#conversation-input').press('Enter');
      await page.locator('.conv-msg-agent').last().getByText(/비교표에 포함된 주변 단지는 2곳입니다.*매매 1건, 분양권 1건, 입주권 1건.*해제된 거래를 제외했습니다.*계약 기간 밖의 거래를 제외했습니다/).waitFor();

      await page.locator('#conversation-input').fill('더 알려줘');
      await page.locator('#conversation-input').press('Enter');
      await page.locator('.conv-msg-agent').last().getByText(/합성 비교 A의 2026-10-20 매매 신고금액은 515,000,000원입니다/).waitFor();

      // 2) 합성 예시(10월 10~31일) 범위를 벗어나는 최근 6개월 요청은 제안 카드를 만들지 않고 수집 기간을 설명한다.
      await page.getByRole('button', { name: '최근 6개월로 다시 비교해줘', exact: true }).click();
      await page.locator('#conversation-input').press('Enter');
      await page.locator('.conv-msg-agent').last().getByText('이 예시에서 수집한 계약 기간은 2026-10-10부터 2026-10-31까지입니다. 이 안의 날짜로 요청해 주세요.', { exact: true }).waitFor();
      assert.equal(await page.locator('.conv-approve.is-preview').count(), 0);

      // 3) 수집 범위 안의 2026-10-12 ~ 2026-10-25 요청은 기간 변경 제안 미리보기 카드를 표시한다 (실제 실행 없음, 로그인 직접 연결).
      await page.getByRole('button', { name: '2026-10-12부터 2026-10-25까지로 바꿔줘', exact: true }).click();
      await page.locator('#conversation-input').press('Enter');
      const preview = page.locator('.conv-approve.is-preview').last();
      await preview.getByText('예시 미리보기 · 실행 안 함', { exact: true }).waitFor();
      await preview.getByText('2026.10.12 – 2026.10.25').waitFor();
      assert.equal(await preview.getByRole('button', { name: '이 조건으로 다시 비교' }).count(), 0);

      // 로그인 버튼으로 바로 로그인 대화상자 열기
      if (width === 1440) {
        await page.evaluate(() => window.scrollTo(0, 0));
        const sendBox = await page.locator('#conversation-send-btn').boundingBox();
        assert.ok(sendBox && sendBox.y + sendBox.height <= 844, 'the full composer must fit below the comparison tabs');
      }
      await preview.getByRole('button', { name: '로그인하고 내 분석 열기' }).click();
      await page.locator('dialog[open] #auth-email').waitFor();
      await page.keyboard.press('Escape');

      // 미리보기 닫기 동작
      await preview.getByRole('button', { name: '미리보기 닫기' }).click();
      await preview.getByText('미리보기를 닫았습니다. 예시 조건을 유지합니다.').waitFor();

      // 4) 보류 예시 화면에서도 같은 conversationExample 규칙으로 응답한다.
      await page.goto(`${origin}/#sample/9900000101/01`);
      await page.getByRole('button', { name: '왜 이 거래만 포함됐어?', exact: true }).click();
      await page.locator('#conversation-input').press('Enter');
      await page.locator('.conv-msg-agent').last().getByText(/0건이라고 확정할 수는 없습니다.*공급면적/).waitFor();
      await page.getByRole('button', { name: '2026-10-12부터 2026-10-25까지로 바꿔줘', exact: true }).click();
      await page.locator('#conversation-input').press('Enter');
      await page.locator('.conv-msg-agent').last().getByText('이 예시에는 날짜를 바꿔 비교할 수 있는 확정 계약 기간이 없습니다.', { exact: true }).waitFor();
      assert.equal(await page.locator('.conv-approve.is-preview').count(), 0);

      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(forbiddenCalls, []);
      const stored = await page.evaluate(() => JSON.stringify([Object.values(localStorage), Object.values(sessionStorage)]));
      assert.equal(stored.includes('왜 이 거래만 포함됐어?'), false);
    } finally {
      await ctx.close();
    }
  });
}

test('initial GET conversation error offers reload recovery and preserves comparison result', async () => {
  const aid = 'e1000000-0000-4000-8000-000000000001';
  const rid = 'e1000000-0000-4000-8000-000000000002';
  const snap = 'e1000000-0000-4000-8000-000000000003';
  const owner = { id: 'e1000000-0000-4000-8000-000000000004', email: 'recover@example.invalid' };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockAuth(ctx, owner);
  let convAttempts = 0;
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === `/api/v1/analyses/${aid}/runs/${rid}`) {
      return route.fulfill({ json: { analysisId: aid, runId: rid, snapshotId: snap, status: 'finished', input: { kind: 'snapshot' } } });
    }
    if (url.pathname === `/api/v1/analyses/${aid}/runs/${rid}/result`) {
      return route.fulfill({ json: { analysisId: aid, runId: rid, snapshotId: snap, result: comparisonFixture } });
    }
    if (url.pathname === `/api/v1/analyses/${aid}/runs/${rid}/conversation`) {
      convAttempts++;
      if (convAttempts === 1) {
        return route.fulfill({ status: 503, json: { error: 'backend_unavailable' } });
      }
      return route.fulfill({
        json: {
          contractVersion: 'analysis-conversation/v1',
          analysisId: aid,
          runId: rid,
          hasEarlier: false,
          turns: [
            {
              id: 'turn-recovered',
              runId: rid,
              message: '복구된 질문',
              intent: 'inclusion',
              createdAt: '2026-11-10T01:20:00Z',
              answer: '다시 불러오기로 복구한 대화입니다.',
              proposal: null,
            },
          ],
        },
      });
    }
    return route.continue();
  });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(6500);
    await page.goto(`${origin}/#run/${aid}/${rid}`);
    // 비교 결과는 그대로 열람 가능하면서 대화 패널만 오류와 다시 불러오기 버튼을 보여준다.
    await page.getByRole('heading', { name: '합성 가람 아파트' }).waitFor();
    await page.locator('.conversation-panel').getByText('서비스에 연결할 수 없습니다. 잠시 후 다시 시도하세요.').waitFor();
    await page.getByRole('button', { name: '다시 불러오기' }).click();
    await page.getByText('다시 불러오기로 복구한 대화입니다.').waitFor();
    assert.equal(convAttempts, 2);
  } finally {
    await ctx.close();
  }
});

test('browser UI integrates end-to-end with real createHandler conversation routes and server previousRunId', async () => {
  const aid = 'f1000000-0000-4000-8000-000000000001';
  const rid1 = 'f1000000-0000-4000-8000-000000000002';
  const rid2 = 'f1000000-0000-4000-8000-000000000003';
  const snap1 = 'f1000000-0000-4000-8000-000000000004';
  const snap2 = 'f1000000-0000-4000-8000-000000000005';
  const turn1 = 'f1000000-0000-4000-8000-000000000011';
  const turn2 = 'f1000000-0000-4000-8000-000000000012';
  const owner = { id: 'f1000000-0000-4000-8000-000000000006', email: 'real@example.invalid' };

  const comp2 = structuredClone(comparisonFixture);
  comp2.conditions.period.start = '2026-05-11';
  comp2.conditions.period.end = '2026-11-10';
  const snaps = {
    [rid1]: parseComparisonSnapshot({ analysisId: aid, runId: rid1, snapshotId: snap1, rulesVersion: 'v1', result: comparisonFixture }, aid, rid1),
    [rid2]: parseComparisonSnapshot({ analysisId: aid, runId: rid2, snapshotId: snap2, rulesVersion: 'v1', result: comp2 }, aid, rid2),
  };
  const dbTurns = { [rid1]: [], [rid2]: [] };
  let turnSeq = 0;

  const handler = createHandler({
    env: { APP_ENV: 'development', SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_TEST_ONLY' },
    createBackend: () => ({
      getUser: async () => ({ id: owner.id, isAnonymous: false }),
      runAnalysis: async (op) => ({
        analysisId: aid,
        runId: op.runId,
        snapshotId: op.runId === rid1 ? snap1 : snap2,
        status: 'finished',
        attempt: 1,
        submittedAt: '2026-11-10T01:00:00Z',
        finishedAt: '2026-11-10T01:01:00Z',
        errorCode: null,
        input: { kind: 'snapshot' },
      }),
      getComparison: async (_aid, rid) => snaps[rid],
      analysisConversation: async (op) => {
        if (op.action === 'submit') {
          const id = turnSeq++ === 0 ? turn1 : turn2;
          dbTurns[op.runId].push({
            id,
            runId: op.runId,
            message: op.message,
            intent: op.intent,
            createdAt: '2026-11-10T01:05:00Z',
            proposal: op.period
              ? {
                  start: op.period.start,
                  end: op.period.end,
                  previousStart: '2026-10-10',
                  previousEnd: '2026-10-31',
                  status: 'pending',
                  resultRunId: null,
                }
              : null,
          });
        } else if (op.action === 'decide') {
          dbTurns[op.runId] = dbTurns[op.runId].map((t) =>
            t.id === op.turnId
              ? {
                  ...t,
                  proposal: {
                    ...t.proposal,
                    status: op.decision === 'approve' ? 'approved' : op.decision === 'reject' ? 'rejected' : 'cancelled',
                    resultRunId: op.decision === 'approve' ? rid2 : null,
                  },
                }
              : t,
          );
        }
        return {
          analysisId: aid,
          runId: op.runId,
          previousRunId: op.runId === rid2 ? rid1 : null,
          hasEarlier: false,
          turns: dbTurns[op.runId],
        };
      },
    }),
    log: () => {},
  });

  const realServer = createDevServer((request) => serveWorkspace(request, handler));
  const listening = once(realServer, 'listening');
  realServer.listen(0, '127.0.0.1');
  await listening;
  const realOrigin = 'http://127.0.0.1:' + realServer.address().port;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockAuth(ctx, owner);
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(7000);
    await page.goto(`${realOrigin}/#run/${aid}/${rid1}`);
    await page.getByRole('button', { name: '왜 이 거래만 포함됐어?', exact: true }).click();
    await page.locator('#conversation-input').press('Enter');
    await page.locator('.conv-msg-agent').getByText(/비교표에 포함된 주변 단지는 2곳입니다/).waitFor();

    await page.getByRole('button', { name: '최근 6개월로 다시 비교해줘', exact: true }).click();
    await page.locator('#conversation-input').press('Enter');
    const card = page.locator('.conv-approve').last();
    await card.getByText('2026.05.11 – 2026.11.10').waitFor();
    await card.getByRole('button', { name: '이 조건으로 다시 비교' }).click();
    await page.waitForFunction((expected) => location.hash === expected, `#run/${aid}/${rid2}`);
    await page.getByRole('link', { name: '이전 결과와 대화 보기' }).waitFor();

    // 새로고침 후에도 서버 previousRunId로 이전 결과와 대화 링크가 유지된다.
    await page.reload();
    assert.equal(
      await page.getByRole('link', { name: '이전 결과와 대화 보기' }).getAttribute('href'),
      `#run/${aid}/${rid1}`,
    );

    // 로그아웃 후 재로그인해 로컬 캐시 없이 새 실행을 직접 열어도 previousRunId로 이전 결과·대화로 돌아갈 수 있다.
    await page.locator('.topbar [data-action="account"]').click();
    await page.locator('dialog[open] [data-action="logout"]').click();
    await page.waitForFunction(() => location.hash === '#notices');
    await page.evaluate((sameUser) => window.__mockAuth.switchUser(sameUser), owner);
    await page.goto(`${realOrigin}/#run/${aid}/${rid2}`);
    await page.getByRole('link', { name: '이전 결과와 대화 보기' }).click();
    await page.waitForFunction((expected) => location.hash === expected, `#run/${aid}/${rid1}`);
    assert.equal(
      await page.getByRole('link', { name: '새 실행 결과 보기' }).getAttribute('href'),
      `#run/${aid}/${rid2}`,
    );
  } finally {
    await ctx.close();
    await new Promise((resolve) => realServer.close(resolve));
  }
});

test('comparison conversation renders AI explanation with model alongside rule-based answer and hides pending indicator on rejected/failed/expired/null', async () => {
  const aid = 'f1000000-0000-4000-8000-000000000001';
  const rid = 'f1000000-0000-4000-8000-000000000002';
  const snap = 'f1000000-0000-4000-8000-000000000003';
  const owner = { id: 'f1000000-0000-4000-8000-000000000004', email: 'agent-ui@example.invalid' };
  const tAnswered = 'f1000000-0000-4000-8000-000000000010';
  const tRejected = 'f1000000-0000-4000-8000-000000000011';
  const tFailed = 'f1000000-0000-4000-8000-000000000012';
  const tExpired = 'f1000000-0000-4000-8000-000000000013';
  const tNone = 'f1000000-0000-4000-8000-000000000014';

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockAuth(ctx, owner, [
    { id: aid, latest_run_id: rid, title: '합성 가람 아파트', status: 'completed', updated_at: '2026-11-10T01:00:00Z' },
  ]);

  let pollCount = 0;
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    const p = url.pathname;
    if (p === `/api/v1/analyses/${aid}/runs/${rid}`) {
      return route.fulfill({ json: { analysisId: aid, runId: rid, snapshotId: snap, status: 'finished', input: { kind: 'snapshot' } } });
    }
    if (p === `/api/v1/analyses/${aid}/runs/${rid}/result`) {
      return route.fulfill({ json: { analysisId: aid, runId: rid, snapshotId: snap, result: comparisonFixture } });
    }
    if (p === `/api/v1/analyses/${aid}/runs/${rid}/conversation` && req.method() === 'GET') {
      pollCount += 1;
      const firstReply =
        pollCount === 1
          ? { status: 'queued', model: 'gpt-6.2-sol', answer: null, citations: [], completedAt: null }
          : {
              status: 'answered',
              model: 'gpt-6.2-sol',
              answer: '가람동에서 공급면적 ±5% 기준으로 주변 단지 2곳을 확인했습니다. <img src=x onerror="window.__aiXss=1">',
              citations: [{ kind: 'comparison', reference: 'comparison/v1', label: '비교 결과 요약' }],
              completedAt: '2026-11-10T01:02:00Z',
            };
      return route.fulfill({
        json: {
          contractVersion: 'analysis-conversation/v1',
          analysisId: aid,
          runId: rid,
          hasEarlier: false,
          turns: [
            {
              id: tAnswered,
              runId: rid,
              message: '왜 이 거래만 포함됐어?',
              intent: 'inclusion',
              createdAt: '2026-11-10T01:01:00Z',
              answer: '규칙 기반: 비교표에 포함된 주변 단지는 2곳입니다.',
              proposal: null,
              agentReply: firstReply,
            },
            {
              id: tRejected,
              runId: rid,
              message: '보류 사유 알려줘',
              intent: 'holds',
              createdAt: '2026-11-10T01:03:00Z',
              answer: '규칙 기반: 보류 항목 안내입니다.',
              proposal: null,
              agentReply: { status: 'rejected', model: 'gpt-6.2-sol', answer: null, citations: [], completedAt: '2026-11-10T01:03:05Z' },
            },
            {
              id: tFailed,
              runId: rid,
              message: '계약 기간 알려줘',
              intent: 'period',
              createdAt: '2026-11-10T01:04:00Z',
              answer: '규칙 기반: 2026-10-10부터 2026-10-31까지입니다.',
              proposal: null,
              agentReply: { status: 'failed', model: 'gpt-6.2-sol', answer: null, citations: [], completedAt: '2026-11-10T01:04:05Z' },
            },
            {
              id: tExpired,
              runId: rid,
              message: '비교 지역 알려줘',
              intent: 'scope',
              createdAt: '2026-11-10T01:05:00Z',
              answer: '규칙 기반: 비교 범위는 가람동입니다.',
              proposal: null,
              agentReply: { status: 'expired', model: 'gpt-6.2-sol', answer: null, citations: [], completedAt: '2026-11-10T01:06:00Z' },
            },
            {
              id: tNone,
              runId: rid,
              message: '기능 꺼짐 질문',
              intent: 'help',
              createdAt: '2026-11-10T01:07:00Z',
              answer: '규칙 기반: 기능 꺼짐 상태의 답변입니다.',
              proposal: null,
              agentReply: null,
            },
          ],
        },
      });
    }
    return route.continue();
  });

  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    await page.goto(`${origin}/#run/${aid}/${rid}`);

    // 최초 응답에서 규칙 기반 답변이 바로 보이고, queued 턴에만 'AI 설명 작성 중'이 표시된다.
    const turn1 = page.locator(`[data-turn-id="${tAnswered}"]`);
    await turn1.locator('.conv-msg-agent').getByText('규칙 기반: 비교표에 포함된 주변 단지는 2곳입니다.').waitFor();
    await turn1.locator('.conv-ai-pending').getByText('AI 설명 작성 중').waitFor();

    // rejected · failed · expired · null 턴에는 '작성 중'이나 AI 블록이 표시되지 않고 규칙 기반 답변만 보인다(A-58).
    for (const tid of [tRejected, tFailed, tExpired, tNone]) {
      const turn = page.locator(`[data-turn-id="${tid}"]`);
      assert.equal(await turn.locator('.conv-msg-agent').count(), 1);
      assert.equal(await turn.locator('.conv-msg-ai').count(), 0);
      assert.equal(await turn.locator('.conv-ai-pending').count(), 0);
    }

    // 폴링 후 answered로 도착하면 'AI 설명'과 모델 이름이 표시되고 규칙 기반 답변도 계속 보인다.
    const aiBlock = turn1.locator('.conv-msg-ai');
    await aiBlock.waitFor();
    await aiBlock.getByText('AI 설명').waitFor();
    await aiBlock.getByText('gpt-6.2-sol').waitFor();
    await aiBlock.getByText('비교 결과 요약').waitFor();
    await turn1.locator('.conv-msg-agent').getByText('규칙 기반: 비교표에 포함된 주변 단지는 2곳입니다.').waitFor();
    assert.equal(await page.locator('.conv-ai-pending').count(), 0);
    assert.equal(await page.evaluate(() => window.__aiXss ?? null), null);
  } finally {
    await ctx.close();
  }
});
