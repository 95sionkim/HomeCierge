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

test('login becomes available after initial session restoration and keeps the email field open', async () => {
  const context = await browser.newContext();
  let releaseConfig;
  const delayed = new Promise(resolve => { releaseConfig = resolve; });
  await context.route('**/api/v1/client-config', async route => { await delayed; await route.continue(); });
  try {
    const page = await context.newPage();
    await page.goto(origin + '/#notices');
    const button = page.locator('.topbar [data-action="auth"]');
    await page.getByText('세션 확인 중', { exact: true }).waitFor();
    assert.ok(await button.isDisabled());
    releaseConfig();
    await button.click();
    await page.locator('#auth-email').fill('synthetic@example.invalid');
    assert.equal(await page.locator('dialog[open] #auth-email').inputValue(), 'synthetic@example.invalid');
  } finally {
    releaseConfig();
    await context.close();
  }
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
      assert.ok((await first.locator('.card-identity').innerText()).includes('공고일 2026.10.30'));
      assert.ok((await first.locator('.card-identity').innerText()).includes('9900000101'));
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
    const table = page.getByRole('region', { name: '아파트 매매 단지별 통계' });
    const sale = table.getByRole('row').filter({ hasText: '합성 비교 A' });
    await sale.getByText('잠정', { exact: true }).waitFor();
    assert.equal(await sale.getByRole('cell', { name: '51,500', exact: true }).count(), 3);
    await page.getByRole('button', { name: '입주권', exact: true }).click();
    const rights = page.getByRole('region', { name: '입주권 단지별 통계' });
    await rights.getByRole('row').filter({ hasText: '합성 비교 A' }).getByText('미확인', { exact: true }).waitFor();
    assert.equal(await page.locator('.market-chart').count(), 0);
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
  let conditionStatus = 403;
  const comparisonFixture = JSON.parse(await readFile(new URL('../../public/app/assets/comparison-example.json', import.meta.url)));
  const buildNewsPage = (pageNumber = 1) =>
    readRegionalNews(
      { analysisId, snapshotId, status: 'ready', region: '서울특별시 광진구' },
      analysisId,
      snapshotId,
      {
        page: pageNumber,
        signal: new AbortController().signal,
        clientId: 'synthetic-browser-id',
        clientSecret: 'synthetic-browser-value',
        fetch: async (input) => {
          const start = Number(new URL(String(input)).searchParams.get('start'));
          const total = 25;
          const count = Math.max(0, Math.min(10, total - start + 1));
          return Response.json({
            total,
            start,
            display: count,
            items: Array.from({ length: count }, (_, index) => ({
              title: '합성 기사 ' + (start + index),
              description: '합성 검색 발췌 ' + (start + index),
              originallink: 'https://example.org/' + (start + index),
              pubDate: 'Mon, 05 Oct 2026 10:00:00 +0900',
            })),
          });
        },
      },
    );
  const ready = await buildNewsPage(1);
  let newsOverride = null,
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
      return route.fulfill(conditionStatus === 200
        ? { json: { analysisId, runId, snapshotId, result: comparisonFixture } }
        : { status: conditionStatus, json: { error: conditionStatus === 403 ? 'comparison_source_restricted' : 'backend_unavailable' } });
    if (p === refPath + '/legal-evidence') return route.fulfill({ json: law });
    if (p === refPath + '/regional-news') {
      const bodyText = req.postData();
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      requests.push({ method: req.method(), body: bodyText, auth: req.headers().authorization });
      if (pending) {
        notifyPending();
        await gate;
      }
      const payload = newsOverride ?? (await buildNewsPage(parsed.page ?? 1));
      await route.fulfill({ status: newsHttp, json: payload }).catch(() => {});
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
    await p.locator('#analysis-conditions').click();
    await p.locator('.condition-message').getByText('이 결과에 사용된 출처의 표시 권한을 확인 중입니다.').waitFor();
    assert.equal(await p.locator('.condition-detail').count(), 0);
    await p.locator('#analysis-conditions').click();
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
    conditionStatus = 503;
    await p.locator('#analysis-conditions').click();
    await p.getByRole('button', { name: '조건 다시 조회' }).waitFor();
    conditionStatus = 200;
    await p.getByRole('button', { name: '조건 다시 조회' }).click();
    await p.locator('.condition-detail').getByText('±5%', { exact: true }).waitFor();
    await p.locator('#analysis-conditions').click();
    conditionStatus = 403;
    await p.getByRole('button', { name: '지역 뉴스 보기' }).click();
    await p.getByRole('link', { name: '합성 기사 1', exact: true }).waitFor();
    assert.deepEqual(
      (await p.locator('.ref-news-list h3').allInnerTexts()).map((title) => title.trim()),
      Array.from({ length: 10 }, (_, idx) => '합성 기사 ' + (idx + 1)),
    );
    assert.equal(
      await p.getByRole('link', { name: '합성 기사 1', exact: true }).getAttribute('href'),
      'https://example.org/1',
    );
    const nav = p.getByRole('navigation', { name: '뉴스 쪽 이동' });
    const prevBtn = nav.getByRole('button', { name: '이전' });
    const nextBtn = nav.getByRole('button', { name: '다음' });
    assert.equal((await nav.locator('.ref-page-status').innerText()).trim(), '1 / 3');
    assert.equal(await prevBtn.isDisabled(), true);
    assert.equal(await nextBtn.isDisabled(), false);

    // 다음 쪽(2쪽)으로 이동하면 본문 {"page":2}로 새 요청하고 11~20번 기사만 표시한다.
    await nextBtn.focus();
    await nextBtn.press('Enter');
    await p.getByRole('link', { name: '합성 기사 11', exact: true }).waitFor();
    assert.equal(await p.locator('.ref-news-list h3').count(), 10);
    assert.equal(await p.getByRole('link', { name: '합성 기사 1', exact: true }).count(), 0);
    assert.equal((await nav.locator('.ref-page-status').innerText()).trim(), '2 / 3');
    assert.equal(await prevBtn.isDisabled(), false);
    assert.equal(await nextBtn.isDisabled(), false);
    assert.equal(await p.evaluate(() => document.activeElement?.id), 'ref-news-next');

    // 마지막 쪽(3쪽)에서는 5건을 표시하고 다음 버튼을 비활성화한다.
    await nextBtn.click();
    await p.getByRole('link', { name: '합성 기사 21', exact: true }).waitFor();
    assert.equal(await p.locator('.ref-news-list h3').count(), 5);
    assert.equal((await nav.locator('.ref-page-status').innerText()).trim(), '3 / 3');
    assert.equal(await prevBtn.isDisabled(), false);
    assert.equal(await nextBtn.isDisabled(), true);

    // 이전 쪽(2쪽)과 첫 쪽(1쪽)으로 되돌아간다.
    await prevBtn.click();
    await p.getByRole('link', { name: '합성 기사 11', exact: true }).waitFor();
    assert.equal((await nav.locator('.ref-page-status').innerText()).trim(), '2 / 3');
    await prevBtn.click();
    await p.getByRole('link', { name: '합성 기사 1', exact: true }).waitFor();
    assert.equal((await nav.locator('.ref-page-status').innerText()).trim(), '1 / 3');
    assert.equal(await prevBtn.isDisabled(), true);

    assert.deepEqual(
      requests.map((r) => ({ method: r.method, page: JSON.parse(r.body).page, auth: r.auth })),
      [1, 2, 3, 2, 1].map((page) => ({ method: 'POST', page, auth: 'Bearer SYNTHETIC_TEST_SESSION' })),
    );
    for (const [status, label] of [
      ['partial', '검색 결과 일부 누락'],
      ['empty', '검색 결과 0건'],
      ['rate_limited', '뉴스 조회 한도 도달'],
      ['source_restricted', '출처 표시 보류'],
    ]) {
      newsOverride = {
        ...ready,
        status,
        search:
          status === 'source_restricted'
            ? null
            : {
                ...ready.search,
                page:
                  status === 'rate_limited'
                    ? null
                    : status === 'empty'
                      ? { number: 1, size: 10, total: 0, lastPage: 0, hasPrevious: false, hasNext: false }
                      : ready.search.page,
                items: [],
                omittedCount: status === 'partial' ? 1 : 0,
              },
      };
      await p.getByRole('button', { name: '다시 조회' }).click();
      await p.getByText(label, { exact: true }).waitFor();
      assert.equal(await p.locator('.ref-news-list').count(), 0);
    }
    newsHttp = 429;
    newsOverride = { error: 'news_rate_limited' };
    await p.getByRole('button', { name: '다시 조회' }).click();
    await p.getByText('최근 뉴스 요청이 많습니다. 1분 뒤 다시 조회하세요.').waitFor();
    newsHttp = 200;
    newsOverride = null;
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
      assert.equal(await page.locator('.ref-news-list h3').count(), 10);
      assert.equal(await page.locator('.ref-news-list a').count(), 0);
      const guestNav = page.getByRole('navigation', { name: '뉴스 쪽 이동' });
      assert.equal((await guestNav.locator('.ref-page-status').innerText()).trim(), '1 / 3');
      assert.equal(await guestNav.getByRole('button', { name: '이전' }).isDisabled(), true);
      await guestNav.getByRole('button', { name: '다음' }).click();
      await page.waitForFunction(() => document.querySelector('.ref-page-status')?.textContent?.trim() === '2 / 3');
      assert.equal(await page.locator('.ref-news-list h3').count(), 10);
      await guestNav.getByRole('button', { name: '다음' }).click();
      await page.waitForFunction(() => document.querySelector('.ref-page-status')?.textContent?.trim() === '3 / 3');
      assert.equal(await page.locator('.ref-news-list h3').count(), 3);
      assert.equal(await guestNav.getByRole('button', { name: '다음' }).isDisabled(), true);
      await guestNav.getByRole('button', { name: '이전' }).click();
      await page.waitForFunction(() => document.querySelector('.ref-page-status')?.textContent?.trim() === '2 / 3');
      await page.getByRole('link', { name: '법령 근거' }).click();
      await page.getByText('판본 표시 예시', { exact: true }).waitFor();
      await page.goBack();
      await page.getByRole('button', { name: '예시 기사 보기' }).waitFor();
      assert.equal(await page.locator('.ref-news-list').count(), 0);
      const guestStores = await page.evaluate(() =>
        JSON.stringify([Object.values(localStorage), Object.values(sessionStorage)]),
      );
      assert.equal(guestStores.includes('가람구'), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(calls, []);
    } finally {
      await ctx.close();
    }
  });
}

for (const width of [1440, 390]) {
  test(`analysis context, exact amounts and keyboard navigation at ${width}px`, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    const sample = JSON.parse(await readFile(new URL('../../public/app/assets/comparison-example.json', import.meta.url)));
    const stat = sample.comparables[0].tradeStats.sale;
    Object.assign(stat, { minWon: '515000000', maxWon: '515000001', medianWon: '515000000.5', count: 2 });
    await ctx.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.endsWith('/comparison-example.json')) return route.fulfill({ json: sample });
      return route.continue();
    });
    try {
      const p = await ctx.newPage();
      await p.goto(origin + '/#notices');
      const cards = p.getByRole('button', { name: '카드 보기' });
      await cards.focus();
      await cards.press('ArrowRight');
      await p.locator('.big-calendar').waitFor();
      assert.equal(await p.locator('[data-view=calendar]').evaluate(e => e === document.activeElement), true);
      await p.goto(origin + '/#sample/saved');
      const conditions = p.locator('#analysis-conditions');
      if (width === 1440) {
        await p.getByRole('button', { name: '메뉴 펼치기', exact: true }).click();
        assert.equal(await p.locator('.rail-toggle').getAttribute('aria-expanded'), 'true');
        await p.getByRole('button', { name: '메뉴 접기', exact: true }).click();
      }
      await conditions.click();
      await p.locator('.condition-detail').getByText('±5%', { exact: true }).waitFor();
      await conditions.click();
      const sale = p.getByRole('region', { name: '아파트 매매 단지별 통계' });
      await sale.getByRole('cell', { name: '51,500.00005', exact: true }).waitFor();
      assert.equal(await p.locator('.notice-series strong').innerText(), '7억 1,000만 원');
      assert.equal(await p.locator('.chart-series').count(), 2);
      await p.getByLabel('101동 101호 필수 옵션 근거 · 공고문 8쪽', { exact: true }).click();
      await p.locator('.price-panel details[open]').getByText('synthetic-v1', { exact: true }).waitFor();
      await p.getByRole('button', { name: '아파트 매매' }).press('ArrowRight');
      await p.getByRole('region', { name: '분양권 단지별 통계' }).waitFor();
      assert.equal(await p.locator('.chart-series').last().locator('strong').innerText(), '4억 500만 원');
      assert.equal(await p.locator('[data-trade-kind=presale_right]').evaluate(e => e === document.activeElement), true);
      assert.equal(await p.locator('.price-panel details[open]').count(), 1);
      await p.getByRole('link', {name: '비교 결과', exact:true}).press('ArrowRight');
      await p.locator('.fund-total').waitFor();
      assert.equal(await p.locator('.analysis-tabs a[aria-current]').evaluate(e => e === document.activeElement), true);
      await p.goto(origin + '/#sample/9900000101/01');
      await p.getByRole('heading', {name: '가격 비교를 보류했습니다'}).waitFor();
      await p.getByRole('heading', {name: '다시 비교하려면'}).waitFor();
      assert.equal(await p.locator('.market-chart').count(), 0);
      assert.equal(await p.locator('.trade-summary .zero').count(), 0);
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally { await ctx.close(); }
  });
}

test('the comparison plots an exact shared domain and only labels a substantiated expansion', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const sample = JSON.parse(await readFile(new URL('../../public/app/assets/comparison-example.json', import.meta.url)));
  const price = sample.noticePrice, stat = sample.comparables[0].tradeStats.sale;
  Object.assign(price, { minWon: '9007199254740993', maxWon: '9007199254740994' });
  Object.assign(stat, { minWon: '9007199254740992', medianWon: '9007199254740992.5', maxWon: '9007199254740993', count: 2 });
  sample.appliedScope = 'expansion';
  sample.regionDecision.priority.conclusion = 'normal_zero';
  sample.regionDecision.expansion = {name:'합성구', conclusion:'candidates_found'};
  await ctx.route('**/*', r => {
    const url = new URL(r.request().url());
    if (url.origin !== origin) return r.abort();
    return url.pathname.endsWith('/comparison-example.json') ? r.fulfill({json:sample}) : r.continue();
  });
  try {
    const page = await ctx.newPage();
    await page.goto(origin + '/#sample/saved');
    await page.locator('#analysis-conditions').getByText('합성구 · 확대', {exact:true}).waitFor();
    assert.equal(await page.locator('.chart-series .series-track b').evaluate(e => e.style.left), '25%');
    assert.equal(await page.locator('.notice-series .series-track i').evaluate(e => e.style.left), '50%');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    price.status = 'held';
    sample.appliedScope = 'priority';
    sample.regionDecision.priority.conclusion = 'held';
    sample.regionDecision.priority.unresolvedRows = 1;
    sample.regionDecision.expansion = null;
    stat.maxWon = stat.minWon;
    stat.medianWon = stat.minWon;
    await page.reload();
    await page.locator('#analysis-conditions').getByText('가람동 · 판정 보류', {exact:true}).waitFor();
    assert.equal(await page.locator('.notice-series, .legend-notice, .notice-price-row').count(), 0);
    assert.equal(await page.locator('.chart-series .series-track b').evaluate(e => e.style.left), '50%');
  } finally { await ctx.close(); }
});

test('a mobile guest can inspect the fixed commute example without sending an address', async () => {
  const page=await browser.newPage({viewport:{width:360,height:800}});
  let requests=0;
  page.on('request',req=>{if(new URL(req.url()).pathname.endsWith('/commute')) requests++;});
  try {
    await page.goto(origin+'/#sample/saved/commute');
    await page.locator('.commute-point').first().getByText('합성시 가람구 가람로 10', { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('.commute-point').first().innerText(), /공고 \d+/);
    await page.getByRole('button',{name:'예시 경로 보기'}).click();
    await page.getByRole('region',{name:'수단별 경로 결과'}).waitFor();
    assert.match(await page.locator('.commute-result-origin').innerText(), /합성시 가람구 가람로 10/);
    assert.match(await page.locator('.commute-mode').first().innerText(),/시간 미제공/);
    assert.equal(await page.locator('.commute-time b').first().innerText(),'38');
    assert.ok(await page.locator('#commute-destination').getAttribute('readonly')!==null);
    assert.equal(await page.getByRole('button',{name:'공유 목적지로 저장'}).count(),0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await page.getByRole('link',{name:'지역 뉴스',exact:true}).click();
    await page.getByRole('heading',{name:'지역 뉴스',exact:true}).waitFor();
    assert.equal(await page.locator('.commute-mode').count(),0);
    assert.equal(requests,0);
  } finally { await page.close(); }
});

test('commute lookup shows auto notice origin instead of notice number, supports manual override and confirmed shared destination', async () => {
  const analysis='c1000000-0000-4000-8000-000000000001', run='c1000000-0000-4000-8000-000000000002';
  const snapshot='c1000000-0000-4000-8000-000000000003', owner='c1000000-0000-4000-8000-000000000004';
  const ctx=await browser.newContext();
  await ctx.addInitScript(owner=>{
    window.testProfile={revision:0,commute_destination:null};
    window.confirmations=[];
    const auth={getSession:async()=>({data:{session:{user:{id:owner,email:'reader@example.invalid'},access_token:'SYNTHETIC_USER'}}}),
      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})};
    const query={select(){return this;},eq(){return this;},not(){return this;},order(){return this;},abortSignal(){return this;},
      limit:async()=>({data:[]}), maybeSingle:async()=>({data:window.testProfile})};
    globalThis.supabase={createClient:()=>({auth,from:()=>query,rpc:async(name,args)=>{
      window.confirmations.push({name,args});window.testProfile={revision:1,commute_destination:args.p_destination};
      return {error:null};}})};
  },owner);
  let previews=0, queries=0;
  const postedBodies=[];
  const autoOrigin={
    noticeAddress:'서울특별시 광진구 가람로 999 (가람동, 합성아파트)',
    address:'서울특별시 광진구 가람로 999',
    basis:'notice_address',
    reason:null,
    suggestion:null,
  };
  await ctx.route('**/api/v1/analyses/**',async route=>{
    const req=route.request();
    const path=new URL(req.url()).pathname;
    if(path.endsWith('/commute') && req.method()==='GET') {
      previews++;
      await route.fulfill({json:{contractVersion:'commute/v1',analysisId:analysis,snapshotId:snapshot,status:'ready',origin:autoOrigin}});
    } else if(path.endsWith('/commute') && req.method()==='POST') {
      queries++;
      const body=req.postDataJSON();
      postedBodies.push(body);
      const usedOrigin=body.origin
        ? {noticeAddress:autoOrigin.noticeAddress,address:body.origin,basis:'user_input',reason:null,suggestion:null}
        : autoOrigin;
      const empty={queriedAt:'2026-10-27T08:00:00Z',durationSeconds:null,distanceMeters:null,walkMinutes:null,walkMeters:null,kind:null};
      await route.fulfill({json:{contractVersion:'commute/v1',analysisId:analysis,snapshotId:snapshot,
        status:'ready',originAddress:usedOrigin.address,origin:usedOrigin,
        transit:{...empty,source:'odsay_route',status:'provider_denied'},
        driving:{...empty,source:'kakao_directions',status:'available',durationSeconds:600,distanceMeters:3000,kind:'car'}}});
    } else if(path.endsWith(run)) {
      await route.fulfill({json:{analysisId:analysis,runId:run,snapshotId:snapshot,status:'finished',input:{kind:'notice',noticeNo:'2026000505'}}});
    } else await route.fulfill({status:403,json:{error:'comparison_source_restricted'}});
  });
  try {
    const p=await ctx.newPage(); p.setDefaultTimeout(5000);
    await p.goto(`${origin}/#run/${analysis}/${run}/commute`);
    await p.locator('.commute-point').first().getByText('서울특별시 광진구 가람로 999', { exact: true }).waitFor();
    const originText=await p.locator('.commute-point').first().innerText();
    assert.match(originText, /청약홈 공고 공급위치 기준/);
    assert.match(originText, /서울특별시 광진구 가람로 999 \(가람동, 합성아파트\)/);
    assert.doesNotMatch(originText, /2026000505/);
    const submit=p.getByRole('button',{name:'경로 조회',exact:true});
    assert.equal(await submit.isDisabled(), true);

    const input=p.getByLabel('목적지 주소');
    await input.fill('서울특별시 가람구 합성로 24');
    assert.equal(await submit.isDisabled(), false);
    await submit.click();
    await p.getByText('제공자가 이 환경의 요청을 승인하지 않았습니다.').waitFor();
    assert.equal(await p.locator('.commute-time b').innerText(),'10');
    assert.match(await p.locator('.commute-result-origin').innerText(), /서울특별시 광진구 가람로 999[\s\S]*청약홈 공고 공급위치 기준/);
    assert.deepEqual(postedBodies[0], {destination:'서울특별시 가람구 합성로 24'});
    assert.equal(await p.evaluate(()=>window.confirmations.length),0);

    await p.getByRole('button',{name:'공유 목적지로 저장'}).click(); await p.getByRole('button',{name:'취소',exact:true}).click();
    assert.equal(await p.evaluate(()=>window.confirmations.length),0);
    await p.getByRole('button',{name:'공유 목적지로 저장'}).click(); await p.getByRole('button',{name:'확인하고 반영'}).click();
    await p.getByText('공유 목적지를 저장했습니다.').waitFor();
    assert.deepEqual(await p.evaluate(()=>window.confirmations),[{name:'confirm_commute_destination',
      args:{p_user_id:owner,p_base_revision:0,p_destination:'서울특별시 가람구 합성로 24'}}]);

    // 자동 출발지가 있어도 직접 입력으로 전환해 조회할 수 있다.
    await p.getByRole('button',{name:'출발지 직접 입력'}).click();
    const originInput=p.locator('#commute-origin');
    await originInput.fill('서울특별시 광진구 예시로 15');
    await submit.click();
    await p.locator('.commute-result-origin').getByText('입력한 단지 주소 기준').waitFor();
    assert.deepEqual(postedBodies[1], {destination:'서울특별시 가람구 합성로 24',origin:'서울특별시 광진구 예시로 15'});

    await input.fill('변경로 10'); assert.equal(await p.locator('.commute-mode').count(),0);
    await p.getByRole('link',{name:'법령 근거'}).click();
    await p.getByRole('link',{name:'출퇴근 경로'}).click();
    await p.waitForFunction(()=>document.querySelector('#commute-destination')?.value==='서울특별시 가람구 합성로 24');
    assert.equal(queries,2);
    assert.equal(previews,2);
  } finally {await ctx.close();}
});

test('commute ambiguous area shows raw address, reason, suggestion input and submits user origin', async () => {
  const analysis='c2000000-0000-4000-8000-000000000001', run='c2000000-0000-4000-8000-000000000002';
  const snapshot='c2000000-0000-4000-8000-000000000003', owner='c2000000-0000-4000-8000-000000000004';
  const ctx=await browser.newContext();
  await ctx.addInitScript(owner=>{
    const auth={getSession:async()=>({data:{session:{user:{id:owner,email:'reader@example.invalid'},access_token:'SYNTHETIC_USER'}}}),
      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})};
    const query={select(){return this;},eq(){return this;},not(){return this;},order(){return this;},abortSignal(){return this;},
      limit:async()=>({data:[]}), maybeSingle:async()=>({data:{revision:0,commute_destination:'서울특별시 중구 합성대로 110'}})};
    globalThis.supabase={createClient:()=>({auth,from:()=>query,rpc:async()=>({error:null})})};
  },owner);
  let mode='ilwon';
  const posted=[];
  await ctx.route('**/api/v1/analyses/**',async route=>{
    const req=route.request();
    const path=new URL(req.url()).pathname;
    if(path.endsWith('/commute') && req.method()==='GET') {
      const origin=mode==='ilwon'
        ? {noticeAddress:'서울특별시 종로구 합성동 28번지 일원',address:null,basis:null,reason:'ambiguous_area',suggestion:'서울특별시 종로구 합성동 28'}
        : {noticeAddress:'인천광역시 서해구 합성역세권 공공주택지구 내 B-1BL',address:null,basis:null,reason:'ambiguous_area',suggestion:null};
      await route.fulfill({json:{contractVersion:'commute/v1',analysisId:analysis,snapshotId:snapshot,status:'ready',origin}});
    } else if(path.endsWith('/commute') && req.method()==='POST') {
      const body=req.postDataJSON();
      posted.push(body);
      const empty={queriedAt:'2026-10-27T08:00:00Z',durationSeconds:null,distanceMeters:null,walkMinutes:null,walkMeters:null,kind:null};
      await route.fulfill({json:{contractVersion:'commute/v1',analysisId:analysis,snapshotId:snapshot,status:'ready',
        originAddress:body.origin,
        origin:{noticeAddress:'서울특별시 종로구 합성동 28번지 일원',address:body.origin,basis:'user_input',reason:null,suggestion:null},
        transit:{...empty,source:'odsay_route',status:'available',durationSeconds:1500,walkMinutes:5,walkMeters:320,kind:'subway'},
        driving:{...empty,source:'kakao_directions',status:'available',durationSeconds:900,distanceMeters:4500,kind:'car'}}});
    } else if(path.endsWith(run)) {
      await route.fulfill({json:{analysisId:analysis,runId:run,snapshotId:snapshot,status:'finished',input:{kind:'notice',noticeNo:'2026000505'}}});
    } else await route.fulfill({status:403,json:{error:'comparison_source_restricted'}});
  });
  try {
    const p=await ctx.newPage(); p.setDefaultTimeout(5000);
    await p.goto(`${origin}/#run/${analysis}/${run}/commute`);
    const originInput=p.locator('#commute-origin');
    await originInput.waitFor();
    const originBlock=await p.locator('.commute-point').first().innerText();
    assert.match(originBlock, /서울특별시 종로구 합성동 28번지 일원/);
    assert.match(originBlock, /공고 공급위치의 대표 지번입니다\. 단지 주소가 맞는지 확인하세요\./);
    assert.doesNotMatch(originBlock, /2026000505/);
    assert.equal(await originInput.inputValue(), '서울특별시 종로구 합성동 28');

    const submit=p.getByRole('button',{name:'경로 조회',exact:true});
    await p.waitForFunction(()=>document.querySelector('#commute-destination')?.value==='서울특별시 중구 합성대로 110');
    assert.equal(await submit.isDisabled(), false);

    // 출발지를 비우면 조회 버튼이 비활성화된다.
    await originInput.fill('');
    assert.equal(await submit.isDisabled(), true);
    await originInput.fill('서울특별시 종로구 합성동 28');
    assert.equal(await submit.isDisabled(), false);
    await submit.click();

    await p.getByRole('region',{name:'수단별 경로 결과'}).waitFor();
    assert.deepEqual(posted, [{destination:'서울특별시 중구 합성대로 110',origin:'서울특별시 종로구 합성동 28'}]);
    assert.match(await p.locator('.commute-result-origin').innerText(), /서울특별시 종로구 합성동 28[\s\S]*입력한 단지 주소 기준/);

    // 블록 표기처럼 대표 지번이 없으면 입력칸이 비어 있고 조회 버튼이 비활성으로 시작한다.
    mode='block';
    await p.reload();
    await p.locator('#commute-origin').waitFor();
    assert.equal(await p.locator('#commute-origin').inputValue(), '');
    assert.match(await p.locator('.commute-point').first().innerText(), /B-1BL/);
    assert.equal(await p.getByRole('button',{name:'경로 조회',exact:true}).isDisabled(), true);
  } finally {await ctx.close();}
});

test('browser queries ODsay directly with URI key, strict fetch options, handles all states and stores no coordinates (Q-47)', async () => {
  const analysis='c3000000-0000-4000-8000-000000000001', run='c3000000-0000-4000-8000-000000000002';
  const snapshot='c3000000-0000-4000-8000-000000000003', owner='c3000000-0000-4000-8000-000000000004';
  const ctx=await browser.newContext();
  await ctx.addInitScript(owner=>{
    window.odsayFetches=[];
    const realFetch=window.fetch.bind(window);
    window.fetch=(input, init)=>{
      const url=typeof input==='string' ? input : input?.url ?? '';
      if (url.startsWith('https://api.odsay.com/')) {
        window.odsayFetches.push({
          url,
          method: init?.method,
          credentials: init?.credentials,
          cache: init?.cache,
          redirect: init?.redirect,
          referrerPolicy: init?.referrerPolicy,
          hasSignal: Boolean(init?.signal),
          headers: init?.headers ?? null,
        });
      }
      return realFetch(input, init);
    };
    const auth={getSession:async()=>({data:{session:{user:{id:owner,email:'reader@example.invalid'},access_token:'SYNTHETIC_USER'}}}),
      onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})};
    const query={select(){return this;},eq(){return this;},not(){return this;},order(){return this;},abortSignal(){return this;},
      limit:async()=>({data:[]}), maybeSingle:async()=>({data:{revision:0,commute_destination:'서울특별시 중구 합성대로 110'}})};
    globalThis.supabase={createClient:()=>({auth,from:()=>query,rpc:async()=>({error:null})})};
  },owner);

  let serverMode='valid';
  let odsayScenario='available';
  let releasePendingOdsay=null;
  const originObj={
    noticeAddress:'서울특별시 광진구 가람로 999',
    address:'서울특별시 광진구 가람로 999',
    basis:'notice_address',
    reason:null,
    suggestion:null,
  };
  await ctx.route('**/api/v1/analyses/**', async route=>{
    const req=route.request();
    const path=new URL(req.url()).pathname;
    if (path.endsWith('/commute') && req.method()==='GET') {
      await route.fulfill({json:{contractVersion:'commute/v1',analysisId:analysis,snapshotId:snapshot,status:'ready',origin:originObj}});
    } else if (path.endsWith('/commute') && req.method()==='POST') {
      const empty={queriedAt:null,durationSeconds:null,distanceMeters:null,walkMinutes:null,walkMeters:null,kind:null};
      const transitQuery=serverMode==='bad_coords'
        ? {provider:'odsay_route',origin:{x:'37.5',y:'127.2'},destination:{x:'127.11',y:'37.4'},apiKey:'synthetic+web/key='}
        : {provider:'odsay_route',origin:{x:'127.10',y:'37.4'},destination:{x:'127.11',y:'37.5'},apiKey:'synthetic+web/key='};
      await route.fulfill({json:{
        contractVersion:'commute/v1',analysisId:analysis,snapshotId:snapshot,status:'ready',
        originAddress:originObj.address,origin:originObj,
        transit:{...empty,source:'odsay_route',status:'client_query'},
        transitQuery,
        driving:{...empty,source:'kakao_directions',status:'available',queriedAt:'2026-10-27T08:00:00Z',durationSeconds:600,distanceMeters:3000,kind:'car'},
      }});
    } else if (path.endsWith(run)) {
      await route.fulfill({json:{analysisId:analysis,runId:run,snapshotId:snapshot,status:'finished',input:{kind:'notice',noticeNo:'2026000505'}}});
    } else await route.fulfill({status:403,json:{error:'comparison_source_restricted'}});
  });

  await ctx.route('https://api.odsay.com/v1/api/searchPubTransPathT**', async route=>{
    if (odsayScenario==='pending_then_available') {
      await new Promise(resolve=>{ releasePendingOdsay=resolve; });
      await route.fulfill({
        status:200,
        headers:{'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*'},
        body:JSON.stringify({result:{searchType:0,path:[{pathType:3,info:{totalTime:31,totalWalkTime:-1,totalWalk:230}}]}}),
      });
      return;
    }
    if (odsayScenario==='timeout') {
      await new Promise(resolve=>setTimeout(resolve, 5600));
      try { await route.abort('timedout'); } catch {}
      return;
    }
    if (odsayScenario==='rate_limited') {
      await route.fulfill({status:429,headers:{'access-control-allow-origin':'*'},body:''});
      return;
    }
    if (odsayScenario==='non_json') {
      await route.fulfill({status:200,headers:{'content-type':'text/plain','access-control-allow-origin':'*'},body:'not json'});
      return;
    }
    const bodies={
      available:{result:{searchType:0,path:[{pathType:1,info:{totalTime:22,totalWalkTime:4,totalWalk:280}}]}},
      no_route:{error:[{code:'-99',msg:'no route'}]},
      points_too_close:{error:[{code:'-98',msg:'too close'}]},
      provider_denied:{error:[{code:'500',message:'[ApiKeyAuthFailed] invalid domain'}]},
      connections_unverified:{result:{searchType:1}},
      malformed:{result:{searchType:0,path:[]}},
    };
    await route.fulfill({
      status:200,
      headers:{'content-type':'application/json','access-control-allow-origin':'*'},
      body:JSON.stringify(bodies[odsayScenario]),
    });
  });

  try {
    const p=await ctx.newPage(); p.setDefaultTimeout(8000);
    await p.goto(`${origin}/#run/${analysis}/${run}/commute`);
    await p.locator('.commute-point').first().getByText('서울특별시 광진구 가람로 999', { exact: true }).waitFor();
    assert.match(await p.locator('.commute-form').innerText(), /브라우저가 확인된 좌표를 ODsay에 직접 보내 조회합니다/);
    await p.waitForFunction(()=>document.querySelector('#commute-destination')?.value==='서울특별시 중구 합성대로 110');

    // 1) 조회 중 상태 표시 후 정상 결과 표시 + fetch 옵션·인코딩·출처 표기 확인
    odsayScenario='pending_then_available';
    const submit=p.getByRole('button',{name:'경로 조회',exact:true});
    await submit.click();
    await p.locator('.commute-mode').first().getByText('대중교통 경로를 조회 중입니다.').waitFor();
    assert.equal(await p.locator('.commute-mode').nth(1).locator('.commute-time b').innerText(), '10');
    assert.match(await p.locator('.commute-mode').first().innerText(), /powered by www\.ODsay\.com/);
    releasePendingOdsay();
    await p.locator('.commute-mode').first().locator('.commute-time b').waitFor();
    assert.equal(await p.locator('.commute-mode').first().locator('.commute-time b').innerText(), '31');
    assert.match(await p.locator('.commute-mode').first().innerText(), /시간 미제공 · 230 m/);

    const firstFetch=(await p.evaluate(()=>window.odsayFetches))[0];
    assert.equal(firstFetch.method, 'GET');
    assert.equal(firstFetch.credentials, 'omit');
    assert.equal(firstFetch.cache, 'no-store');
    assert.equal(firstFetch.redirect, 'error');
    assert.equal(firstFetch.referrerPolicy, 'strict-origin-when-cross-origin');
    assert.equal(firstFetch.hasSignal, true);
    assert.equal(firstFetch.headers, null);
    assert.ok(firstFetch.url.includes('SX=127.10&SY=37.4&EX=127.11&EY=37.5&OPT=0&apiKey=synthetic%2Bweb%2Fkey%3D'));

    // 2) ODsay 오류·형식 이상·제한 상태별 메시지 확인
    for (const [scenario, expectedText] of [
      ['no_route', '제공자가 이 조건에서 찾은 경로가 없습니다.'],
      ['points_too_close', '출발지와 목적지가 너무 가까워 이 수단의 경로를 조회할 수 없습니다.'],
      ['provider_denied', '제공자가 이 환경의 요청을 승인하지 않았습니다.'],
      ['connections_unverified', '도시간 경로의 터미널 연결 구간이 확인되지 않아 전체 소요시간을 표시할 수 없습니다.'],
      ['rate_limited', '제공자의 조회 한도에 도달했습니다.'],
      ['malformed', '제공자의 경로 응답을 확인하지 못했습니다. 잠시 후 다시 조회하세요.'],
      ['non_json', '제공자의 경로 응답을 확인하지 못했습니다. 잠시 후 다시 조회하세요.'],
      ['timeout', '제공자의 경로 응답을 확인하지 못했습니다. 잠시 후 다시 조회하세요.'],
    ]) {
      odsayScenario=scenario;
      await submit.click();
      await p.locator('.commute-mode').first().getByText(expectedText).waitFor();
      assert.equal(await p.locator('.commute-mode').nth(1).locator('.commute-time b').innerText(), '10');
    }

    // 3) 좌표·결과를 브라우저 저장소(localStorage·sessionStorage)에 저장하지 않는다.
    const stored=await p.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}));
    assert.deepEqual(stored, {local:0,session:0});

    // 4) 서버 응답의 transitQuery 좌표 형식이 한국 범위를 벗어나면 클라이언트 검증에서 차단하고 ODsay를 호출하지 않는다.
    const countBeforeBad=await p.evaluate(()=>window.odsayFetches.length);
    serverMode='bad_coords';
    await submit.click();
    await p.locator('.commute-feedback').getByText('요청을 마치지 못했습니다. 연결을 확인하고 다시 시도하세요.').waitFor();
    assert.equal(await p.evaluate(()=>window.odsayFetches.length), countBeforeBad);
  } finally {await ctx.close();}
});

test('band-format notice switches copy to 가격 구간 in comparison, funding, and report views (synthetic)', async () => {
  const bandName = '101동·102동 3호 라인 11~15층';
  const bandUnit = { kind: 'band', buildings: ['101동', '102동'], lines: ['3호'], floors: { from: 11, to: 15 }, households: 3 };
  const comparison = JSON.parse(await readFile(new URL('../../public/app/assets/comparison-example.json', import.meta.url), 'utf8'));
  comparison.noticePrice.confirmedRooms[0].room = bandName;
  comparison.noticePrice.confirmedRooms[0].unit = bandUnit;
  comparison.noticePrice.confirmedRooms[0].requiredOptionsWon = '0';
  comparison.noticePrice.confirmedRooms[0].subtotalWon = '700000000';
  comparison.noticePrice.heldRooms = [];

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/app/assets/comparison-example.json') return route.fulfill({ json: comparison });
    return route.continue();
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(6500);
    await page.goto(origin + '/#sample/saved');
    await page.getByRole('heading', { name: '가격 구간별 공고 가격' }).waitFor();
    await page.getByRole('heading', { name: bandName }).waitFor();
    await page.getByRole('link', { name: '호실 자금표' }).click();
    await page.getByRole('heading', { name: '가격 구간별 자금표' }).waitFor();
    await page.getByLabel('납부 일정을 볼 가격 구간').waitFor();
    assert.equal(await page.locator('#fund-room').inputValue(), bandName);
  } finally {
    await context.close();
  }
});
