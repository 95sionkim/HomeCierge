// 실제 네트워크와 계정 없이 데스크톱·모바일에서 같은 합성 공고를 조작한다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
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
