// 격리된 Supabase의 임시 사용자로 화면을 조작한다. 청약홈과 실거래 제공자 입력은 합성이다.
import { chromium } from 'playwright-core';

export async function checkWorkspaceInBrowser({ apiPort, dbOrigin, owner, notice, runWorker, check, referenceDisplay }) {
  check(['127.0.0.1', 'localhost'].includes(new URL(dbOrigin).hostname), 'be11_browser_local_db_required');
  const origin = 'http://127.0.0.1:' + apiPort;
  const executablePath =
    process.env.CHROME_BIN ||
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/google-chrome');
  let browser;
  let step = 'launch';
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return [origin, dbOrigin].includes(url.origin) || url.protocol === 'data:'
        ? route.continue()
        : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    async function login() {
      await page.locator('[data-action="auth"]:visible').first().click();
      await page.locator('#auth-email').fill(owner.email);
      await page.locator('#auth-password').fill(owner.password);
      await page.locator('#auth-form [type="submit"]').click();
      await page.locator('[data-action="account"]:visible').first().waitFor();
    }
    step = 'login';
    await page.goto(origin + '/#notices');
    await login();
    step = 'region_picker';
    await page.getByRole('link', {name:'맞춤 검색',exact:true}).first().click();
    await page.locator('#criteria-regions option[value="서울특별시 광진구"]').waitFor({state:'attached'});
    await page.locator('#criteria-region').fill('11215');
    await page.locator('#criteria-budget').fill('710000000');
    const searched = page.waitForResponse(r => new URL(r.url()).pathname === '/api/v1/notices/search' && r.request().method() === 'POST');
    await page.getByRole('button',{name:'이 조건으로 검색'}).click();
    // 앞 BE-07 검사에서 PDF 표시 권한을 철회했다. 디렉터리의 지역 선택은 계속 열려 있다.
    check((await searched).status() === 403,'workspace_search_rights');
    await page.locator('#criteria-form [role=alert]').waitFor();
    check(await page.locator('.search-results').count() === 0,'workspace_search_discards_restricted_results');
    await page.getByRole('link',{name:'오늘의 청약',exact:true}).first().click();
    step = 'choose_model';
    await page.locator('button.notice-card').filter({ hasText: notice.title }).click();
    await page.locator('dialog input[name="model"][value="01"]').check();
    step = 'start';
    const started = page.waitForResponse(
      (response) =>
        response.url() === dbOrigin + '/rest/v1/rpc/start_notice_workspace' &&
        response.request().method() === 'POST',
    );
    await page.locator('dialog [data-action="start"]').click();
    const startResponse = await started;
    check(startResponse.ok(), 'be11_browser_submit');
    const { runId, analysisId } = await startResponse.json();
    const hash = '#run/' + analysisId + '/' + runId;
    await page.waitForURL((url) => url.hash === hash);
    step = 'worker_result';
    check((await runWorker(runId, 'present')).status === 'finished', 'be11_browser_worker');
    await page.locator('[data-result-status]').waitFor({ timeout: 35_000 });
    step = 'fund_entry';
    await page.getByRole('link',{name:'호실 자금표'}).click();
    await page.getByRole('button',{name:'자금 입력'}).click();
    await page.locator('#fund-amount').fill('9007199254740993');
    await page.locator('#fund-date').fill('2026-10-20');
    await page.getByRole('button',{name:'이 분석에 저장'}).click();
    await page.locator('.fund-entry').waitFor();
    await page.locator('.fund-entry [data-fund-edit]').click();
    check(await page.locator('#fund-amount').inputValue() === '9007199254740993','workspace_fund_bigint_exact');
    await page.locator('#fund-amount').fill('0');
    await page.getByRole('button',{name:'이 분석에 저장'}).click();
    await page.locator('.fund-entry strong').getByText('0원',{exact:true}).waitFor();
    step = 'signout';
    await page.locator('[data-action="account"]:visible').first().click();
    await page.locator('dialog [data-action="logout"]').click();
    await page.locator('[data-action="auth"]:visible').first().waitFor();
    step = 'new_session';
    await page.goto(origin + '/#notices');
    await login();
    await page.locator('a[href="#analyses"]:visible').first().click();
    await page
      .locator('a[href="' + hash + '"]')
      .first()
      .click();
    await page.locator('[data-result-status]').waitFor();
    check(new URL(page.url()).hash === hash, 'be11_browser_restore_same_run');
    await page.getByRole('link',{name:'호실 자금표'}).click();
    await page.locator('.fund-entry strong').getByText('0원',{exact:true}).waitFor();
    step = 'reference_permissions';
    await page.getByRole('link',{name:'법령 근거'}).click();
    await page.getByText('출처 표시 보류',{exact:true}).waitFor();
    await referenceDisplay(true);
    await page.getByRole('button',{name:'다시 확인'}).click();
    await page.getByText('합성 모집공고 확인',{exact:true}).waitFor();
    check((await page.getByRole('link',{name:'당시 시행본 원문'}).getAttribute('href'))
      === 'https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=99900002&efYd=20250201','workspace_historical_law_link');
    step = 'on_demand_news';
    let newsRequests = 0;
    page.on('request', req => { if (new URL(req.url()).pathname.endsWith('/regional-news')) newsRequests++; });
    await page.getByRole('link',{name:'지역 뉴스',exact:true}).click();
    const fetchNews = page.getByRole('button',{name:'지역 뉴스 보기'});
    await fetchNews.waitFor();
    check(newsRequests === 0,'workspace_news_no_background_request');
    await fetchNews.click();
    const original = page.getByRole('link',{name:'합성 뉴스 제목'});
    await original.waitFor();
    check(newsRequests === 1 && await original.getAttribute('href') === 'https://example.org/article/1','workspace_news_original');
    await referenceDisplay(false);
    await page.getByRole('button',{name:'다시 조회'}).click();
    await page.getByText('출처 표시 보류',{exact:true}).waitFor();
    check(await original.count() === 0,'workspace_revoked_news_removed');
    await page.getByRole('link',{name:'법령 근거'}).click();
    await page.getByText('출처 표시 보류',{exact:true}).waitFor();
    check(await page.getByRole('link',{name:'당시 시행본 원문'}).count() === 0,'workspace_revoked_law_removed');
  } catch {
    // 공급자 오류, 브라우저 상태, 계정·인증값이 CI 로그에 실리지 않도록 단계만 기록한다.
    check(false, 'be11_browser_' + step);
  } finally {
    await browser?.close();
  }
}
