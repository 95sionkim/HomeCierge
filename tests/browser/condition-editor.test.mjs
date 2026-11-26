// O-1 비교 조건 편집 패널의 데스크톱·모바일 동작, 변경 없음 비활성화, 경계 입력, 단지 교체, 승인 카드 연결을 검사한다.
// 모든 분석·단지·거래는 합성 자료이며 API 응답은 브라우저 경로 가로채기로만 제공한다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { createDevServer } from '../../dev/server.ts';
import { serveWorkspace } from '../../dev/static.ts';

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

async function installMockAuth(context, user, rows) {
  await context.addInitScript(
    ({ user: current, rows: analyses }) => {
      const session = { user: current, access_token: 'TOKEN_' + current.id };
      const auth = {
        getSession: async () => ({ data: { session }, error: null }),
        signOut: async () => ({ error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      };
      const query = {
        select() { return this; },
        eq() { return this; },
        not() { return this; },
        order() { return this; },
        limit: async () => ({ data: analyses, error: null }),
      };
      globalThis.supabase = { createClient: () => ({ auth, from: () => query }) };
    },
    { user, rows },
  );
}

function pooledComparison() {
  const result = structuredClone(comparisonFixture);
  result.candidatePool = [
    { complexId: 'comparison-a', name: '합성 비교 A', localityCode: '9999900100', localityName: '가람동', eligible: true,
      selected: true, supplyAreaM2: '112.50', areaDifferenceM2: '0.10', tradeKinds: ['sale'], reasonCode: null },
    { complexId: 'comparison-b', name: '합성 비교 B', localityCode: '9999900100', localityName: '가람동', eligible: true,
      selected: true, supplyAreaM2: '110.00', areaDifferenceM2: '2.40', tradeKinds: ['presale_right', 'occupancy_right'], reasonCode: null },
    { complexId: 'comparison-c', name: '합성 비교 C', localityCode: '9999900100', localityName: '가람동', eligible: true,
      selected: false, supplyAreaM2: '113.00', areaDifferenceM2: '0.60', tradeKinds: ['sale'], reasonCode: null },
    { complexId: 'comparison-d', name: '합성 비교 D', localityCode: '9999900200', localityName: '별빛동', eligible: false,
      selected: false, supplyAreaM2: null, areaDifferenceM2: null, tradeKinds: [], reasonCode: 'outside_applied_region' },
    { complexId: 'comparison-e', name: '합성 비교 E', localityCode: '9999900100', localityName: '가람동', eligible: false,
      selected: false, supplyAreaM2: '120.00', areaDifferenceM2: null, tradeKinds: [], reasonCode: 'outside_supply_area' },
  ];
  return result;
}

const bounds = {
  editable: true,
  period: { start: '2026-10-10', end: '2026-10-31', asOf: '2026-11-10' },
  tradeKinds: ['sale', 'presale_right', 'occupancy_right'],
  areaToleranceMax: '5',
  areaEditable: true,
  replacementsEditable: true,
};

for (const width of [1440, 390]) {
  test(`O-1 condition editor previews changes, disables unchanged input and opens the same approval card at ${width}px`, async () => {
    const aid = 'c1000000-0000-4000-8000-000000000010';
    const rid1 = 'c1000000-0000-4000-8000-000000000011';
    const rid2 = 'c1000000-0000-4000-8000-000000000012';
    const owner = { id: 'c1000000-0000-4000-8000-000000000015', email: 'buyer@example.invalid' };
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await installMockAuth(ctx, owner, [
      { id: aid, latest_run_id: rid1, title: '합성 가람 아파트', status: 'completed', updated_at: '2026-11-10T01:00:00Z' },
    ]);
    const comparison = pooledComparison();
    const posted = [];
    const decisions = [];
    let turns = [];
    const conversation = (rid) => ({
      contractVersion: 'analysis-conversation/v1', analysisId: aid, runId: rid,
      previousRunId: rid === rid2 ? rid1 : null,
      conditionBounds: { ...bounds, editable: rid === rid1 }, hasEarlier: false, turns: rid === rid1 ? turns : [],
    });

    await ctx.route('**/*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      const p = url.pathname;
      for (const rid of [rid1, rid2]) {
        if (p === `/api/v1/analyses/${aid}/runs/${rid}`) {
          return route.fulfill({ json: { analysisId: aid, runId: rid, snapshotId: rid, status: rid === rid1 ? 'finished' : 'queued',
            submittedAt: '2026-11-10T01:55:00Z', input: { kind: 'snapshot' } } });
        }
        if (p === `/api/v1/analyses/${aid}/runs/${rid}/result`) {
          return route.fulfill({ json: { analysisId: aid, runId: rid, snapshotId: rid, result: comparison } });
        }
        if (p === `/api/v1/analyses/${aid}/runs/${rid}/conversation`) {
          if (req.method() === 'POST') {
            const body = req.postDataJSON();
            assert.match(body.requestId, UUID_RE);
            posted.push(body);
            const previous = {};
            if (body.conditions.tradeKinds) previous.tradeKinds = ['sale', 'presale_right', 'occupancy_right'];
            if (body.conditions.areaTolerancePercent) previous.areaTolerancePercent = '5';
            if (body.conditions.replacements) previous.replacements = [];
            turns = [...turns, {
              id: 'turn-' + posted.length, runId: rid, message: body.message, intent: 'change_conditions',
              createdAt: '2026-11-10T01:05:00Z', answer: '비교 조건 변경을 제안합니다. 공유 프로필은 바뀌지 않습니다.',
              proposal: { kind: 'conditions', previous, proposed: body.conditions, effective: body.conditions,
                status: 'pending', resultRunId: null },
            }];
          }
          return route.fulfill({ json: conversation(rid) });
        }
      }
      const decision = p.match(/^\/api\/v1\/analyses\/[^/]+\/runs\/([^/]+)\/conversation\/([^/]+)\/decision$/);
      if (decision && req.method() === 'POST') {
        const { decision: verb } = req.postDataJSON();
        decisions.push(verb);
        const status = { approve: 'approved', reject: 'rejected', cancel: 'cancelled' }[verb];
        turns = turns.map((t) => (t.id === decision[2]
          ? { ...t, proposal: { ...t.proposal, status, resultRunId: verb === 'approve' ? rid2 : null } } : t));
        return route.fulfill({ json: conversation(decision[1]) });
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
      const opener = page.getByRole('button', { name: '조건 변경', exact: true });
      await opener.click();
      const dialog = page.getByRole('dialog', { name: '비교 조건' });
      await dialog.waitFor();
      const confirm = dialog.getByRole('button', { name: '이 조건으로 다시 비교' });

      // 바뀐 조건이 없으면 확인 버튼을 끈다(09b). 같은 값으로 되돌려도 다시 꺼진다.
      await dialog.getByText('바뀐 조건이 없습니다.', { exact: true }).waitFor();
      assert.equal(await confirm.isDisabled(), true);
      const presale = dialog.getByRole('checkbox', { name: /분양권/ });
      await presale.uncheck();
      assert.equal(await confirm.isDisabled(), false);
      await presale.check();
      assert.equal(await confirm.isDisabled(), true);

      // 공급면적 경계는 반올림 없이 양 끝 포함으로 미리 보여주고 0·5 초과(Q-41)·소수 5자리는 막는다.
      const presetTexts = await dialog.locator('[data-cond-area]').allInnerTexts();
      assert.deepEqual(presetTexts, ['±1%', '±2%', '±3%', '±5% (기본)']);
      const area = dialog.locator('#cond-area-input');
      for (const bad of ['0', '5.0001', '7', '3.12345', '-3']) {
        await area.fill(bad);
        assert.equal(await confirm.isDisabled(), true, bad);
      }
      await area.fill('5');
      await dialog.getByText('바뀐 조건이 없습니다.', { exact: true }).waitFor();
      assert.equal(await confirm.isDisabled(), true);
      await area.fill('3');
      await dialog.getByText('109.028㎡ – 115.772㎡', { exact: true }).waitFor();
      assert.equal(await confirm.isDisabled(), false);

      // 거래 종류는 수집한 종류 안에서만 바꾸고 하나도 고르지 않으면 막는다.
      await dialog.getByRole('checkbox', { name: /입주권/ }).uncheck();
      await presale.uncheck();
      await dialog.getByRole('checkbox', { name: /아파트 매매/ }).uncheck();
      await dialog.getByText('비교할 거래 종류를 1개 이상 선택하세요.').waitFor();
      assert.equal(await confirm.isDisabled(), true);
      await dialog.getByRole('checkbox', { name: /아파트 매매/ }).check();

      // 단지 직접 지정은 적격 후보만 고를 수 있고, 지역 밖·기준 미충족 단지는 사유와 함께 따로 보여준다.
      await dialog.getByText('단지 직접 지정 · 교체').click();
      const slot = dialog.getByLabel(/비교 단지 1/);
      const options = await slot.locator('option').allInnerTexts();
      assert.ok(options.some((text) => text.startsWith('합성 비교 C')));
      assert.ok(!options.some((text) => text.startsWith('합성 비교 D') || text.startsWith('합성 비교 E')));
      await dialog.getByText('적용 지역 밖', { exact: true }).waitFor();
      await dialog.getByText('공급면적 범위 밖', { exact: true }).waitFor();
      await slot.selectOption('comparison-c');
      const summary = dialog.locator('.cond-diff-list');
      await summary.getByText('합성 비교 A → 합성 비교 C').waitFor();
      await summary.getByText('±3% (109.028 – 115.772㎡)').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const box = await page.locator('#condition-editor-dialog').boundingBox();
      assert.ok(box && box.width <= width && box.x >= 0 && box.x + box.width <= width + 1);
      if (width === 1440) assert.equal(Math.round(box.width), 560);

      // Escape는 아무것도 보내지 않고 닫으며 연 버튼으로 초점을 돌려준다.
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await opener.evaluate((el) => el === document.activeElement), true);
      assert.equal(posted.length, 0);

      // 다시 열어 확인하면 대화에 같은 승인 카드가 생기고, 승인 전에는 결정이 전송되지 않는다.
      await opener.click();
      await dialog.waitFor();
      await dialog.locator('#cond-area-input').fill('3');
      await dialog.getByRole('checkbox', { name: /입주권/ }).uncheck();
      await dialog.getByRole('button', { name: '이 조건으로 다시 비교' }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.deepEqual(posted.at(-1).conditions, { tradeKinds: ['sale', 'presale_right'], areaTolerancePercent: '3' });
      assert.match(posted.at(-1).message, /^비교 조건 변경: /);
      const card = page.locator('.conv-approve').last();
      await card.getByText('공급면적 범위', { exact: true }).waitFor();
      await card.locator('.conv-diff-to').getByText('아파트 매매 · 분양권').waitFor();
      assert.equal(decisions.length, 0);
      await card.getByRole('button', { name: '이 조건으로 다시 비교' }).click();
      await page.waitForFunction((expected) => location.hash === expected, `#run/${aid}/${rid2}`);
      assert.deepEqual(decisions, ['approve']);
      await page.getByRole('link', { name: '이전 결과와 대화 보기' }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await ctx.close();
    }
  });
}

test('guest sample previews a condition change card without sending any request', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const requests = [];
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/v1/analyses')) requests.push(url.pathname);
    return route.continue();
  });
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(7000);
    await page.goto(`${origin}/#sample/saved`);
    await page.getByRole('button', { name: '조건 변경', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '비교 조건' });
    await dialog.getByText('합성 예시 화면입니다.', { exact: false }).waitFor();
    await dialog.locator('#cond-area-input').fill('7');
    assert.equal(await dialog.getByRole('button', { name: '이 조건으로 다시 비교' }).isDisabled(), true);
    await dialog.locator('#cond-area-input').fill('3');
    await dialog.getByRole('button', { name: '이 조건으로 다시 비교' }).click();
    await dialog.waitFor({ state: 'hidden' });
    const card = page.locator('.conv-approve').last();
    await card.getByText('공급면적 범위', { exact: true }).waitFor();
    await card.locator('.conv-diff-to').getByText('±3% (109.028–115.772㎡)').waitFor();
    await card.getByRole('button', { name: /로그인하고 내 분석 열기/ }).waitFor();
    assert.equal(await card.getByRole('button', { name: '이 조건으로 다시 비교' }).count(), 0);
    // 게스트 대화에서도 5% 초과 확대 요청은 제안을 만들지 않고 Q-41 상한을 안내한다.
    await page.locator('#conversation-input').fill('공급면적 범위를 ±7%로 넓혀줘');
    await page.locator('#conversation-send-btn').click();
    await page.getByText(/±5%가 상한입니다\(Q-41\)/).waitFor();
    assert.equal(await page.locator('.conv-approve').count(), 1);
    assert.deepEqual(requests, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally {
    await ctx.close();
  }
});

test('active manual replacement excludes base slots from other dropdowns and chat condition reject keeps run', async () => {
  const aid = 'c1000000-0000-4000-8000-000000000020';
  const rid1 = 'c1000000-0000-4000-8000-000000000021';
  const owner = { id: 'c1000000-0000-4000-8000-000000000025', email: 'buyer2@example.invalid' };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await installMockAuth(ctx, owner, [
    { id: aid, latest_run_id: rid1, title: '합성 가람 아파트', status: 'completed', updated_at: '2026-11-10T01:00:00Z' },
  ]);
  const comparison = pooledComparison();
  comparison.comparables[0] = {
    ...comparison.comparables[0],
    complexId: 'comparison-c', name: '합성 비교 C',
    selectionReason: 'manual_replacement', replacesComplexId: 'comparison-a',
  };
  comparison.candidatePool[0].selected = false;
  comparison.candidatePool[2].selected = true;
  const posted = [];
  let turns = [];
  const conv = () => ({
    contractVersion: 'analysis-conversation/v1', analysisId: aid, runId: rid1, previousRunId: null,
    conditionBounds: bounds, hasEarlier: false, turns,
  });
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    const p = url.pathname;
    if (p === `/api/v1/analyses/${aid}/runs/${rid1}`) {
      return route.fulfill({ json: { analysisId: aid, runId: rid1, snapshotId: rid1, status: 'finished',
        submittedAt: '2026-11-10T01:55:00Z', input: { kind: 'snapshot' } } });
    }
    if (p === `/api/v1/analyses/${aid}/runs/${rid1}/result`) {
      return route.fulfill({ json: { analysisId: aid, runId: rid1, snapshotId: rid1, result: comparison } });
    }
    if (p === `/api/v1/analyses/${aid}/runs/${rid1}/conversation`) {
      if (req.method() === 'POST') {
        const body = req.postDataJSON();
        posted.push(body);
        turns = [...turns, {
          id: 'turn-' + posted.length, runId: rid1, message: body.message, intent: 'change_conditions',
          createdAt: '2026-11-10T01:05:00Z', answer: '비교 조건 변경을 제안합니다.',
          proposal: body.conditions
            ? { kind: 'conditions', previous: { replacements: [{ complexId: 'comparison-c', replaceComplexId: 'comparison-a' }] },
                proposed: body.conditions, effective: body.conditions, status: 'pending', resultRunId: null }
            : { kind: 'conditions', previous: { areaTolerancePercent: '5' },
                proposed: { areaTolerancePercent: '3' }, effective: { areaTolerancePercent: '3' }, status: 'pending', resultRunId: null },
        }];
      }
      return route.fulfill({ json: conv() });
    }
    const dec = p.match(/^\/api\/v1\/analyses\/[^/]+\/runs\/[^/]+\/conversation\/([^/]+)\/decision$/);
    if (dec && req.method() === 'POST') {
      const { decision: verb } = req.postDataJSON();
      turns = turns.map((t) => (t.id === dec[1]
        ? { ...t, proposal: { ...t.proposal, status: verb === 'reject' ? 'rejected' : 'cancelled', resultRunId: null } } : t));
      return route.fulfill({ json: conv() });
    }
    return route.continue();
  });

  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(7000);
    await page.goto(`${origin}/#run/${aid}/${rid1}`);
    await page.getByRole('heading', { name: '비교 대화' }).waitFor();
    await page.getByRole('button', { name: '조건 변경', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '비교 조건' });
    await dialog.waitFor();
    // 슬롯 2의 교체 목록에 원래 자동 선정 단지(합성 비교 A)가 잘못 노출되지 않는다.
    const slot2Options = await dialog.getByLabel(/비교 단지 2/).locator('option').allInnerTexts();
    assert.ok(!slot2Options.some((text) => text.startsWith('합성 비교 A')));
    // 슬롯 1을 자동 선정으로 복원하면 replacements: [] 변경 요약을 보여준다.
    await dialog.getByLabel(/비교 단지 1/).selectOption('');
    await dialog.locator('.cond-diff-list').getByText('자동 선정', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '이 조건으로 다시 비교' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(posted[0].conditions, { replacements: [] });
    // 거절하면 현재 실행을 유지하고 새 실행으로 이동하지 않는다.
    const card = page.locator('.conv-approve').last();
    await card.getByRole('button', { name: '거절', exact: true }).click();
    await card.getByText('거절했습니다. 기존 조건을 유지합니다.').waitFor();
    assert.equal(await page.evaluate(() => location.hash), `#run/${aid}/${rid1}`);

    // 대화 입력으로 조건 변경을 요청해도 같은 승인 카드가 열린다.
    await page.locator('#conversation-input').fill('공급면적 범위를 ±3%로 좁혀줘');
    await page.locator('#conversation-send-btn').click();
    const chatCard = page.locator('.conv-approve').last();
    await chatCard.getByText('공급면적 범위', { exact: true }).waitFor();
    await chatCard.locator('.conv-diff-to').getByText('±3% (109.028–115.772㎡)').waitFor();
    await chatCard.getByRole('button', { name: '취소', exact: true }).click();
    await chatCard.getByText('취소했습니다. 기존 조건을 유지합니다.').waitFor();
    assert.equal(await page.evaluate(() => location.hash), `#run/${aid}/${rid1}`);
  } finally {
    await ctx.close();
  }
});
