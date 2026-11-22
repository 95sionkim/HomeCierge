// 실제 네트워크와 계정 없이 데스크톱·모바일에서 같은 합성 공고를 조작한다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { createDevServer } from '../../dev/server.ts';
import { serveWorkspace } from '../../dev/static.ts';

let server, browser, origin;
before(async () => {
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

for (const width of [1440, 390]) {
  test('custom search and room funding at ' + width + 'px use the exact conditions and payment evidence', async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
    try {
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(6500);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/#search');
      const matched = page.getByRole('region', { name: '조건 충족', exact: true });
      await matched.getByText('101동 101호', { exact: true }).waitFor();
      assert.equal(await matched.locator('.money').first().innerText(), '7억 1,000만 원');
      await matched.getByText('공고문 7·8쪽').click();
      await matched.locator('details[open] .evidence-content').getByText('sha256:' + 'a'.repeat(64)).waitFor();
      await matched.getByRole('button', {name:'주택형 선택'}).click();
      assert.equal(await page.getByRole('dialog').getByRole('radio').isChecked(), true);
      await page.keyboard.press('Escape');
      await page.locator('#criteria-budget').fill('709,999,999');
      await page.getByRole('button', {name:'이 조건으로 검색'}).click();
      await matched.getByText('현재 자료로 조건을 충족한다고 확정한 공고가 없습니다.').waitFor();
      await page.getByRole('button', {name:'합성시 가람구 제외'}).click();
      await page.locator('#criteria-region').fill('99998');
      await page.getByRole('button', {name:'이 조건으로 검색'}).click();
      await page.getByText('수집 범위에서 조건을 충족한 공고는 0건입니다.').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.goto(origin + '/#sample/saved');
      await page.getByRole('link', {name:'호실 자금표'}).click();
      await page.locator('.fund-total h2').getByText('7억 1,000만 원').waitFor();
      await page.getByRole('button', {name:'예상 자금 포함'}).click();
      const day = page.locator('.fund-day').filter({has:page.locator('time[datetime="2026-10-20"]')});
      assert.deepEqual(await day.locator('.checkpoint strong').allInnerTexts(), ['2,100만 원','1,700만 원']);
      await page.getByRole('button', {name:'자금 입력'}).click();
      await page.locator('#fund-amount').fill('1000000');
      await page.locator('#fund-date').fill('2026-10-20');
      await page.getByRole('button', {name:'예시에 적용'}).click();
      await day.locator('.checkpoint strong').getByText('1,600만 원').waitFor();
      await page.locator('#fund-room').selectOption('101동 102호');
      await page.getByRole('heading', {name:'날짜 미확정 납부'}).waitFor();
      assert.equal(await page.locator('.fund-total h2').innerText(), '합계 확인 필요');
      await page.getByLabel('분양대금 근거 · 공고문 7쪽', {exact:true}).click();
      await page.locator('.component details[open] .evidence-content').getByText('synthetic-v1').waitFor();
      const balance = page.locator('.fund-entry').filter({hasText:'보유 잔액'});
      await balance.getByRole('button').click();
      await page.getByLabel('자금 확실성').selectOption('expected');
      await page.getByRole('button', {name:'예시에 적용'}).click();
      await balance.getByText('예상 보유 잔액').waitFor();
      await balance.getByRole('button').click();
      assert.equal(await page.getByLabel('자금 확실성').inputValue(), 'expected');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const width of [1440, 390]) {
  test('the ' + width + 'px screen keeps split dates, selection and guest results consistent', async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.name));
      await page.goto(origin + '/#notices');
      const first = page.locator('button.notice-card').filter({ hasText: '합성 가람 아파트' });
      await first.waitFor();
      assert.equal(await page.locator('button.notice-card').count(), 3);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole('button', { name: '달력 보기' }).click();
      await page.locator('.big-calendar [data-date="2026-11-22"]').click();
      await first.waitFor();
      // 20일과 24일에만 접수하는 공고는 22일 공고에 들지 않는다.
      assert.equal(await page.locator('button.notice-card').count(), 1);
      await first.click();
      const dialog = page.getByRole('dialog');
      const start = dialog.locator('[data-action="start"]');
      assert.equal(await start.isDisabled(), true);
      await dialog.getByRole('radio').first().check();
      await start.click();
      await page.locator('[data-result-status]').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.goto(origin + '/#notices');
      await page.locator('[data-action="auth"]:visible').first().click();
      assert.equal(await page.locator('#auth-password').getAttribute('type'), 'password');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog[open]').count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

test('more cards remain searchable and provisional prices stay distinct from confirmed empty scopes', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const fixture = async (name) =>
    JSON.parse(
      await readFile(new URL('../../public/app/assets/' + name + '-example.json', import.meta.url), 'utf8'),
    );
  const directory = await fixture('directory'),
    comparison = await fixture('comparison');
  directory.notices = Array.from({ length: 15 }, (_, index) => ({
    ...directory.notices[0],
    noticeNo: String(9900000042 + index),
    title: '합성 공고 ' + (index + 1),
  }));
  directory.counts = { ...directory.counts, listed: 15, open: 15, upcoming: 0, unknown: 0 };
  directory.page.returned = directory.notices.length;
  comparison.comparables = [comparison.comparables[0]];
  comparison.completeness = 'partial';
  comparison.comparables[0].tradeStats.sale.status = 'provisional';
  comparison.tradeKinds.occupancy_right = {
    conclusion: 'normal_zero',
    collectionStatus: 'complete',
    unresolvedRows: 0,
  };
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/app/assets/directory-example.json') return route.fulfill({ json: directory });
    if (url.pathname === '/app/assets/comparison-example.json') return route.fulfill({ json: comparison });
    return route.continue();
  });
  try {
    const page = await context.newPage();
    await page.goto(origin + '/#notices');
    await page.locator('[data-action="more-notices"]').click();
    assert.equal(await page.locator('.notice-card').count(), 15);
    await page.locator('#notice-search').fill('합성 공고 15');
    assert.equal(await page.locator('.notice-card').count(), 1);
    await page.goto(origin + '/#sample/saved');
    const table = page.getByRole('region', { name: '합성 비교 A 거래 통계' });
    const sale = table.getByRole('row').filter({ hasText: '아파트 매매' });
    await sale.getByText('잠정', { exact: true }).waitFor();
    assert.equal(await sale.getByRole('cell', { name: '5억 1,500만 원', exact: true }).count(), 3);
    await table.getByRole('row').filter({ hasText: '입주권' }).getByText('미확인', { exact: true }).waitFor();
    await page.getByText('입주권 · 해당 범위 0건', { exact: true }).waitFor();
  } finally {
    await context.close();
  }
});

test('a completed run opens each source independently, binds its snapshot and releases earlier article text', async () => {
  const analysisId = 'a1000000-0000-4000-8000-000000000001',
    runId = 'a1000000-0000-4000-8000-000000000002',
    snapshotId = 'a1000000-0000-4000-8000-000000000003';
  const owner = { id: 'a1000000-0000-4000-8000-000000000004', email: 'reader@example.invalid' };
  const ctx = await browser.newContext();
  await ctx.addInitScript((user) => {
    // 인증 어댑터만 대체한다. 페이지와 사용자 HTTP 클라이언트는 실제 구현을 실행한다.
    const auth = {
      getSession: async () => ({ data: { session: { user, access_token: 'SYNTHETIC_TEST_SESSION' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    };
    const history = {
      select() {
        return this;
      },
      eq() {
        return this;
      },
      not() {
        return this;
      },
      order() {
        return this;
      },
      limit: async () => ({ data: [] }),
    };
    globalThis.supabase = { createClient: () => ({ auth, from: () => history }) };
  }, owner);
  const { readLegalEvidence } = await import('../../src/server/legal-evidence.ts');
  const { readRegionalNews } = await import('../../src/server/regional-news-request.ts');
  const asOf = '2026-10-05';
  const legalContext = {
    analysisId,
    snapshotId,
    noticeSource: 'applyhome_remainder',
    noticeDate: asOf,
    dataOrigin: 'collected',
    status: 'available',
    reference: {
      contractVersion: 'law-reference/v1',
      dataOrigin: 'collected',
      asOf,
      mst: '99900001',
      lawId: '008243',
      title: '주택공급에 관한 규칙',
      promulgatedOn: '2025-01-02',
      effectiveOn: '2025-02-03',
      observedAt: '2026-10-05T12:00:00Z',
      articles: [{ number: '21', branch: '2', heading: '합성 재공급 안내' }],
    },
  };
  let law = readLegalEvidence(legalContext, analysisId, snapshotId);
  const ready = await readRegionalNews(
    { analysisId, snapshotId, status: 'ready', region: '서울특별시 광진구' },
    analysisId,
    snapshotId,
    {
      signal: new AbortController().signal,
      clientId: 'synthetic-browser-id',
      clientSecret: 'synthetic-browser-value',
      fetch: async () =>
        Response.json({
          total: 2,
          items: ['나', '가'].map((label, index) => ({
            title: '합성 기사 ' + label,
            description: '합성 검색 발췌 ' + label,
            originallink: 'https://example.org/' + index,
            pubDate: 'Mon, 05 Oct 2026 10:00:00 +0900',
          })),
        }),
    },
  );
  let news = ready,
    newsHttp = 200,
    pending = false,
    notifyPending,
    resume;
  const paused = new Promise((resolve) => {
    notifyPending = resolve;
  });
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  const requests = [];
  const runPath = '/api/v1/analyses/' + analysisId + '/runs/' + runId;
  const refPath = '/api/v1/analyses/' + analysisId + '/snapshots/' + snapshotId;
  await ctx.route(new RegExp('.+'), async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    const p = url.pathname;
    if (p === runPath)
      return route.fulfill({
        json: { analysisId, runId, snapshotId, status: 'finished', input: { kind: 'snapshot' } },
      });
    if (p === runPath + '/result')
      return route.fulfill({ status: 403, json: { error: 'comparison_source_restricted' } });
    if (p === refPath + '/legal-evidence') return route.fulfill({ json: law });
    if (p === refPath + '/regional-news') {
      requests.push({ method: req.method(), body: req.postData(), auth: req.headers().authorization });
      if (pending) {
        notifyPending();
        await gate;
      }
      await route.fulfill({ status: newsHttp, json: news }).catch(() => {});
      return;
    }
    return route.continue();
  });
  try {
    const p = await ctx.newPage();
    p.setDefaultTimeout(6000);
    await p.goto(origin + '/#run/' + analysisId + '/' + runId);
    await p.getByText('이 결과에 사용된 출처의 표시 권한을 확인 중입니다.').waitFor();
    await p.getByRole('link', { name: '법령 근거' }).click();
    await p.getByText('합성 재공급 안내', { exact: true }).waitFor();
    assert.equal(
      await p.getByRole('link', { name: '당시 시행본 원문' }).getAttribute('href'),
      'https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=99900001&efYd=20250203',
    );
    await p.getByText('최초·재공급 공고', { exact: true }).waitFor();
    law = readLegalEvidence(
      { ...legalContext, status: 'version_unverified', reference: null },
      analysisId,
      snapshotId,
    );
    await p.getByRole('button', { name: '다시 확인' }).click();
    await p.getByRole('link', { name: '법령 개정 이력 열기' }).waitFor();
    assert.equal(await p.getByText('합성 재공급 안내', { exact: true }).count(), 0);
    law = { ...law, snapshotId: runId };
    await p.getByRole('button', { name: '다시 확인' }).click();
    await p.getByText('법령 조회 실패', { exact: true }).waitFor();
    await p.getByRole('link', { name: '지역 뉴스', exact: true }).click();
    await p.getByRole('button', { name: '지역 뉴스 보기' }).waitFor();
    assert.equal(requests.length, 0);
    await p.getByRole('button', { name: '지역 뉴스 보기' }).click();
    await p.getByRole('link', { name: '합성 기사 나' }).waitFor();
    assert.deepEqual(
      (await p.locator('.ref-news-list h3').allInnerTexts()).map((title) => title.trim()),
      ['합성 기사 나', '합성 기사 가'],
    );
    assert.equal(
      await p.getByRole('link', { name: '합성 기사 나' }).getAttribute('href'),
      'https://example.org/0',
    );
    assert.deepEqual(requests, [{ method: 'POST', body: null, auth: 'Bearer SYNTHETIC_TEST_SESSION' }]);
    for (const [status, label] of [
      ['partial', '검색 결과 일부 누락'],
      ['empty', '검색 결과 0건'],
      ['rate_limited', '뉴스 조회 한도 도달'],
      ['source_restricted', '출처 표시 보류'],
    ]) {
      news = {
        ...ready,
        status,
        search:
          status === 'source_restricted'
            ? null
            : { ...ready.search, items: [], omittedCount: status === 'partial' ? 1 : 0 },
      };
      await p.getByRole('button', { name: '다시 조회' }).click();
      await p.getByText(label, { exact: true }).waitFor();
      assert.equal(await p.locator('.ref-news-list').count(), 0);
    }
    newsHttp = 429;
    news = { error: 'news_rate_limited' };
    await p.getByRole('button', { name: '다시 조회' }).click();
    await p.getByText('최근 뉴스 요청이 많습니다. 1분 뒤 다시 조회하세요.').waitFor();
    newsHttp = 200;
    news = ready;
    pending = true;
    await p.getByRole('button', { name: '다시 조회' }).click();
    await paused;
    await p.getByRole('link', { name: '법령 근거' }).click();
    await p.getByText('법령 조회 실패', { exact: true }).waitFor();
    resume();
    await p.getByRole('link', { name: '지역 뉴스', exact: true }).click();
    await p.getByRole('button', { name: '지역 뉴스 보기' }).waitFor();
    assert.equal(await p.locator('.ref-news-list').count(), 0);
    const stores = await p.evaluate(() =>
      JSON.stringify([Object.values(localStorage), Object.values(sessionStorage)]),
    );
    assert.equal(stores.includes('합성 기사'), false);
  } finally {
    resume();
    await ctx.close();
  }
});

for (const width of [1440, 390]) {
  test(`reference tabs at ${width}px label the guest example and discard news on navigation`, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    const calls = [];
    await ctx.route(new RegExp('.+'), (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/legal-evidence') || url.pathname.endsWith('/regional-news'))
        calls.push(url.pathname);
      return url.origin === origin ? route.continue() : route.abort();
    });
    try {
      const page = await ctx.newPage();
      await page.goto(origin + '/#sample/saved/law');
      await page.getByText('판본 표시 예시', { exact: true }).waitFor();
      await page.getByText('합성 재공급 예시', { exact: true }).waitFor();
      assert.equal(await page.getByRole('link', { name: '당시 시행본 원문' }).count(), 0);
      await page.getByRole('link', { name: '지역 뉴스', exact: true }).click();
      const query = page.getByRole('button', { name: '예시 기사 보기' });
      await query.focus();
      await query.press('Enter');
      await page.locator('.ref-news-list li').first().waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'ref-query-action');
      assert.equal(await page.locator('.ref-news-list h3').count(), 2);
      assert.equal(await page.locator('.ref-news-list a').count(), 0);
      await page.getByRole('link', { name: '법령 근거' }).click();
      await page.getByText('판본 표시 예시', { exact: true }).waitFor();
      await page.goBack();
      await page.getByRole('button', { name: '예시 기사 보기' }).waitFor();
      assert.equal(await page.locator('.ref-news-list').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(calls, []);
    } finally {
      await ctx.close();
    }
  });
}
