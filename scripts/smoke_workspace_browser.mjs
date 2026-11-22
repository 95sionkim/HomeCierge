// 격리된 Supabase의 임시 사용자로 화면을 조작한다. 청약홈과 실거래 제공자 입력은 합성이다.
import { chromium } from 'playwright-core';

export async function checkWorkspaceInBrowser({ apiPort, dbOrigin, owner, notice, runWorker, check }) {
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
  } catch {
    // 공급자 오류, 브라우저 상태, 계정·인증값이 CI 로그에 실리지 않도록 단계만 기록한다.
    check(false, 'be11_browser_' + step);
  } finally {
    await browser?.close();
  }
}
