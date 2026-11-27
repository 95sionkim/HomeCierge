// S-04 비교 대상 판정, O-4 단지 상세, O-5 원문 근거 시트의 게스트 합성 예시·로그인 API·데스크톱/모바일 반응형을 검증한다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { createDevServer } from '../../dev/server.ts';
import { serveWorkspace } from '../../dev/static.ts';

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

async function installMockAuth(context, user, analyses = []) {
  await context.addInitScript(
    ({ initialUser, rows }) => {
      let current = initialUser;
      const auth = {
        getSession: async () => ({
          data: { session: current ? { user: current, access_token: 'SYNTHETIC_TOKEN_' + current.id } : null },
          error: null,
        }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
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
    { initialUser: user, rows: analyses },
  );
}

for (const width of [1440, 390]) {
  test(`guest synthetic samples render S-04 (same dong, auto expansion, held), O-4 complex detail, and O-5 evidence at ${width}px`, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const privateRequests = [];
    await ctx.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.startsWith('/api/v1/analyses/')) privateRequests.push(url.pathname);
      return route.continue();
    });
    try {
      const page = await ctx.newPage();
      const pageErrors = [];
      page.setDefaultTimeout(7000);
      page.on('pageerror', (err) => pageErrors.push(err.message));

      // 1) #sample/saved: 같은 동 S-04 + O-4(식별 근거·해제·기간 밖 제외 거래) + O-5(분양가·공급면적·자금표 납부일)
      await page.goto(`${origin}/#sample/saved`);
      const scopePanel = page.locator('.scope-panel');
      await scopePanel.waitFor();
      assert.equal(await scopePanel.getAttribute('data-scope-level'), 'priority');
      await scopePanel.locator('.hc-scope-dong').getByText('가람동', { exact: true }).waitFor();
      assert.equal(await scopePanel.locator('.scope-expansion-notice, .scope-hold-notice').count(), 0);
      await scopePanel.locator('.scope-breakdown summary').click();
      await scopePanel.locator('.scope-breakdown').getByText('해제 거래 제외').waitFor();
      await scopePanel.locator('.scope-breakdown').getByText('계약 기간 밖 제외').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

      // O-4: 비교표에서 합성 비교 A 열기 -> 식별 근거, 미제공 배지, 포함/해제/기간밖 거래 확인
      const rowTrigger = page.locator('.comparison-table button[data-open-complex="comparison-a"]').first();
      await rowTrigger.click();
      const sheet = page.locator('#evidence-sheet');
      await sheet.locator('#sheet-title').getByText('합성 비교 A', { exact: true }).waitFor();
      assert.equal(await sheet.getAttribute('data-sheet'), 'complex');
      await sheet.getByText('99999-100', { exact: true }).waitFor();
      await sheet.getByText('미제공').first().waitFor();
      await sheet.getByText('112.50㎡').first().waitFor();
      await sheet.getByText('0.10㎡').first().waitFor();
      await sheet.getByText('2026.10.20', { exact: true }).waitFor();
      await sheet.locator('del.cancelled-amount').getByText('51,500').waitFor();
      await sheet.getByText('해제 · 통계 제외', { exact: true }).waitFor();
      await sheet.getByText('계약 기간 밖 제외', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

      // 거래 목록 필터 전환 (제외만 -> 포함만 -> 전체)
      await sheet.locator('[data-trade-filter="excluded"]').click();
      assert.equal(await sheet.locator('.sheet-trade-table tbody tr').count(), 2);
      await sheet.locator('[data-trade-filter="included"]').click();
      assert.equal(await sheet.locator('.sheet-trade-table tbody tr').count(), 1);
      await sheet.locator('[data-trade-filter="all"]').click();
      assert.equal(await sheet.locator('.sheet-trade-table tbody tr').count(), 3);

      // Esc로 시트 닫기 + 트리거 포커스 복원
      await page.keyboard.press('Escape');
      assert.equal(await sheet.evaluate((el) => el.open), false);
      assert.equal(await rowTrigger.evaluate((el) => el === document.activeElement), true);

      // O-5: 분양가 SourceChip 클릭 -> 문서·판본·쪽·점검 상태 + 항목 전환(공급면적)
      const saleChip = page.locator('button[data-open-evidence="room:0:salePrice"]');
      await saleChip.click();
      await sheet.locator('#sheet-title').getByText('원문 근거 · 101동 101호 분양가').waitFor();
      assert.equal(await sheet.getAttribute('data-sheet'), 'evidence');
      await sheet.getByText('synthetic-notice-pdf', { exact: true }).waitFor();
      await sheet.getByText('synthetic-v1', { exact: true }).waitFor();
      await sheet.getByText('7쪽', { exact: true }).waitFor();
      await sheet.locator('.ev-doc-card').getByText('자동 점검 통과 · 같은 회차', { exact: true }).waitFor();
      await sheet.getByText('합성 예시 문서', { exact: true }).waitFor();
      assert.equal(await sheet.locator('a[target="_blank"]').count(), 0);
      await sheet.locator('[data-evidence-item="target:supplyArea"]').click();
      await sheet.locator('#sheet-title').getByText('원문 근거 · 대상 주택형 공급면적').waitFor();
      await sheet.getByText('4쪽', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.keyboard.press('Escape');
      assert.equal(await sheet.evaluate((el) => el.open), false);

      // O-5 in 호실 자금표 (#sample/saved/funding) 납부 일정 출처 칩
      await page.getByRole('link', { name: '호실 자금표', exact: true }).click();
      await page.locator('.fund-total').waitFor();
      await page.locator('.payment-parts summary').first().click();
      await page.locator('button[data-open-evidence^="funding:timing:"]').first().click();
      await sheet.locator('#sheet-title').waitFor();
      assert.equal(await sheet.getAttribute('data-sheet'), 'evidence');
      await sheet.getByText('synthetic-notice-pdf', { exact: true }).waitFor();
      await page.keyboard.press('Escape');

      // 2) #sample/expanded: 동 정상 0개 -> 구 자동 확대(확인 질문 없음) + 자체 거래 별도 참고 + 출처 충돌 + K-apt 오류 04
      await page.goto(`${origin}/#sample/expanded`);
      await scopePanel.waitFor();
      assert.equal(await scopePanel.getAttribute('data-scope-level'), 'expansion');
      const expNotice = scopePanel.locator('.scope-expansion-notice');
      await expNotice.getByText('가람동 내 비교 가능한 단지가 없어 가람구(으)로 확대했습니다.').waitFor();
      await expNotice.getByText('정상 0건', { exact: true }).waitFor();
      // 자동 확대 알림에는 승인/확인 버튼이 없어야 한다(A-05).
      assert.equal(await expNotice.locator('button').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

      // 비교 단지 D 열기 -> K-apt/건축물대장 세대수 충돌(대표값 미선택) + 공급면적 범위 밖 제외 거래 확인
      await scopePanel.locator('button[data-open-complex="exp-d"]').click();
      await sheet.locator('#sheet-title').getByText('합성 확대 단지 D', { exact: true }).waitFor();
      await sheet.getByText('612세대 (K-apt) · 613세대 (건축물대장)').waitFor();
      await sheet.getByText('출처 충돌', { exact: true }).waitFor();
      await sheet.getByText('대표값을 임의로 고르지 않습니다').waitFor();
      await sheet.getByText('합성누리로 120', { exact: true }).waitFor();
      await sheet.getByText('A99000001', { exact: true }).first().waitFor();
      await sheet.getByText('공급면적 허용 범위 밖 제외', { exact: true }).waitFor();
      await sheet.getByText('공급 132.40㎡').waitFor();
      await page.keyboard.press('Escape');

      // 비교 단지 E 열기 -> K-apt 조회 실패 오류 04 + 거리 미확인
      await scopePanel.locator('button[data-open-complex="exp-e"]').click();
      await sheet.locator('#sheet-title').getByText('합성 확대 단지 E', { exact: true }).waitFor();
      await sheet.getByText('K-apt 조회 실패 오류 04', { exact: true }).waitFor();
      await sheet.getByText('거리 미확인', { exact: true }).waitFor();
      await page.keyboard.press('Escape');

      // 대상 단지 자체 거래(별도 참고) 열기
      await scopePanel.locator('button[data-open-complex="target-nuri"][data-complex-role="target"]').click();
      await sheet.locator('#sheet-title').getByText('합성 누리 센트럴 아파트', { exact: true }).waitFor();
      await sheet.getByText('자체 거래 · 별도 참고', { exact: true }).waitFor();
      await sheet.getByText('주변 비교표와 최대 5단지 집계에서 제외한 별도 참고 자료입니다').waitFor();
      await page.keyboard.press('Escape');

      // 3) #sample/held: 보류 잔존 -> 정상 0개 아님 · 확대 보류 + 거래 종류별 보류/정상 0건/조회 실패 구분(A-24·A-25)
      await page.goto(`${origin}/#sample/held`);
      await scopePanel.waitFor();
      assert.equal(await scopePanel.getAttribute('data-scope-level'), 'held');
      await scopePanel.locator('.scope-hold-notice').getByText('정상 0개 아님 · 확대 보류', { exact: true }).waitFor();
      assert.equal(await scopePanel.locator('.scope-expansion-notice').count(), 0);
      await scopePanel.locator('[data-kind-verdict="sale"]').getByText('확인 보류', { exact: true }).waitFor();
      await scopePanel.locator('[data-kind-verdict="presale_right"]').getByText('정상 0건', { exact: true }).waitFor();
      await scopePanel.locator('[data-kind-verdict="occupancy_right"]').getByText('조회 실패', { exact: true }).waitFor();
      await scopePanel.getByText('D-01', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

      // 비로그인 합성 예시에서는 비공개 분석 API를 절대 호출하지 않는다.
      assert.deepEqual(privateRequests, []);
      assert.deepEqual(pageErrors, []);
    } finally {
      await ctx.close();
    }
  });
}

test('authenticated run loads /evidence for official links, authenticated own upload /content download, deleted upload, and surfaces 403 source restriction', async () => {
  const aid = 'e1000000-0000-4000-8000-000000000010';
  const ridOk = 'e1000000-0000-4000-8000-000000000011';
  const ridRestricted = 'e1000000-0000-4000-8000-000000000012';
  const snapId = 'e1000000-0000-4000-8000-000000000013';
  const uploadReg = 'e1000000-0000-4000-8000-000000000021';
  const uploadDel = 'e1000000-0000-4000-8000-000000000022';
  const owner = { id: 'e1000000-0000-4000-8000-000000000099', email: 'evidence@example.invalid' };
  const fullSha = 'sha256:97987f527a961051724f6561aca34451e3131a23ae9e11a0c65ee53ddee1d98e';

  const collectedResult = structuredClone(comparisonFixture);
  collectedResult.dataOrigin = 'collected';
  collectedResult.target.houseManageNo = '2026000123';
  collectedResult.target.noticeNo = '2026000456';
  collectedResult.target.edition = '2026-10-15';
  collectedResult.target.supplyArea.evidence = [
    { document: 'applyhome:2026000123:2026000456:1001:1', version: fullSha, page: 4 },
  ];
  collectedResult.noticePrice.confirmedRooms[0].evidence = {
    salePrice: [{ document: `upload:${uploadReg}`, version: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', page: 7 }],
    requiredOptions: [{ document: `upload:${uploadDel}`, version: 'upload-del-v1', page: 8 }],
  };

  const evidencePayload = {
    contractVersion: 'comparison-evidence-detail/v1',
    analysisId: aid,
    runId: ridOk,
    snapshotId: snapId,
    dataOrigin: 'collected',
    noticeLink: 'https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?houseManageNo=2026000123&pblancNo=2026000456',
    documents: [
      {
        id: 'applyhome:2026000123:2026000456:1001:1',
        version: fullSha,
        versionShort: 'sha256:97987f527a96…',
        source: 'official',
        originCheck: 'confirmed',
        status: 'accepted',
        reasons: [],
        houseManageNo: '2026000123',
        noticeNo: '2026000456',
        edition: '2026-10-15',
        officialUrl: 'https://static.applyhome.co.kr/ai/aia/getAtchmnfl.do?houseManageNo=2026000123&pblancNo=2026000456&atchmnflSeqNo=1001&atchmnflSn=1',
        uploadId: null,
        uploadContentPath: null,
        uploadStatus: null,
      },
      {
        id: `upload:${uploadReg}`,
        version: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        versionShort: 'sha256:abcdef012345…',
        source: 'upload',
        originCheck: 'confirmed',
        status: 'accepted',
        reasons: [],
        houseManageNo: '2026000123',
        noticeNo: '2026000456',
        edition: '2026-10-15',
        officialUrl: null,
        uploadId: uploadReg,
        uploadContentPath: `/api/v1/analyses/${aid}/uploads/${uploadReg}/content`,
        uploadStatus: 'registered',
      },
      {
        id: `upload:${uploadDel}`,
        version: 'upload-del-v1',
        versionShort: 'upload-del-v1',
        source: 'upload',
        originCheck: 'confirmed',
        status: 'accepted',
        reasons: [],
        houseManageNo: '2026000123',
        noticeNo: '2026000456',
        edition: '2026-10-15',
        officialUrl: null,
        uploadId: null,
        uploadContentPath: null,
        uploadStatus: 'deleted',
      },
      {
        id: 'upload:e1000000-0000-4000-8000-000000000099',
        version: 'rejected-v1',
        versionShort: 'rejected-v1',
        source: 'upload',
        originCheck: 'conflict',
        status: 'rejected',
        reasons: ['different_notice_round'],
        houseManageNo: '2026000123',
        noticeNo: '2026000999',
        edition: '2025-01-01',
        officialUrl: null,
        uploadId: null,
        uploadContentPath: null,
        uploadStatus: 'unavailable',
      },
    ],
    tradeObservations: [],
  };

  let evidenceFetches = 0;
  let uploadDownloadAuth = null;

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockAuth(ctx, owner, [
    { id: aid, latest_run_id: ridOk, title: '합성 수집 공고', status: 'completed', updated_at: '2026-11-26T00:00:00Z' },
  ]);
  await ctx.route('**/*', (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/v1/notices') {
      return route.fulfill({
        json: {
          contractVersion: 'notice-directory/v1',
          dataOrigin: 'collected',
          asOf: '2026-11-26',
          observedAt: '2026-11-26T00:00:00Z',
          counts: { total: 0, open: 0, upcoming: 0, closed: 0, unknown: 0 },
          page: { offset: 0, limit: 50, nextCursor: null },
          notices: [],
        },
      });
    }
    if (url.pathname === `/api/v1/analyses/${aid}/runs/${ridOk}` || url.pathname === `/api/v1/analyses/${aid}/runs/${ridRestricted}`) {
      const rid = url.pathname.endsWith(ridOk) ? ridOk : ridRestricted;
      return route.fulfill({
        json: {
          runId: rid,
          analysisId: aid,
          status: 'finished',
          attempt: 1,
          submittedAt: '2026-11-26T00:00:00Z',
          finishedAt: '2026-11-26T00:01:00Z',
          input: { kind: 'snapshot', snapshotId: snapId },
          snapshotId: snapId,
          errorCode: null,
        },
      });
    }
    if (url.pathname === `/api/v1/analyses/${aid}/runs/${ridOk}/result` || url.pathname === `/api/v1/analyses/${aid}/runs/${ridRestricted}/result`) {
      const rid = url.pathname.includes(ridOk) ? ridOk : ridRestricted;
      return route.fulfill({
        json: { analysisId: aid, runId: rid, snapshotId: snapId, rulesVersion: 'comparison-rules/v1', result: collectedResult },
      });
    }
    if (url.pathname.endsWith('/conversation')) {
      return route.fulfill({
        json: {
          contractVersion: 'analysis-conversation/v1',
          analysisId: aid,
          runId: ridOk,
          previousRunId: null,
          hasEarlier: false,
          turns: [],
        },
      });
    }
    if (url.pathname === `/api/v1/analyses/${aid}/runs/${ridOk}/evidence`) {
      evidenceFetches += 1;
      assert.equal(req.headers()['authorization'], 'Bearer SYNTHETIC_TOKEN_' + owner.id);
      return route.fulfill({ json: evidencePayload });
    }
    if (url.pathname === `/api/v1/analyses/${aid}/runs/${ridRestricted}/evidence`) {
      return route.fulfill({ status: 403, json: { error: 'comparison_source_restricted' } });
    }
    if (url.pathname === `/api/v1/analyses/${aid}/uploads/${uploadReg}/content`) {
      uploadDownloadAuth = req.headers()['authorization'];
      return route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: Buffer.from('%PDF-1.4\n%synthetic\n%%EOF\n'),
      });
    }
    return route.continue();
  });

  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(7000);
    await page.goto(`${origin}/#run/${aid}/${ridOk}`);
    await page.locator('.scope-panel').waitFor();

    // 1) 공식 PDF 근거 칩 -> 단축 해시, 전체 해시 펼침, 공식 ApplyHome 출처 링크(재호스팅 없음), 반려 문서 기록 확인
    await page.locator('button[data-open-evidence="target:supplyArea"]').click();
    const sheet = page.locator('#evidence-sheet');
    await sheet.getByText('sha256:97987f527a96…', { exact: true }).waitFor();
    const officialLink = sheet.locator('a', { hasText: '공식 출처에서 PDF 열기' });
    assert.equal(
      await officialLink.getAttribute('href'),
      'https://static.applyhome.co.kr/ai/aia/getAtchmnfl.do?houseManageNo=2026000123&pblancNo=2026000456&atchmnflSeqNo=1001&atchmnflSn=1',
    );
    await sheet.locator('.ev-full-hash summary').click();
    await sheet.locator('.ev-full-hash').getByText(fullSha, { exact: true }).waitFor();
    await sheet.getByText('채택되지 않은 문서 기록', { exact: true }).waitFor();
    await sheet.getByText('선택 공고와 다른 회차 문서', { exact: true }).waitFor();

    // 2) 등록된 본인 업로드 문서 -> 인증 헤더로 /content 호출
    await sheet.locator('[data-evidence-item="room:0:salePrice"]').click();
    await sheet.getByRole('button', { name: '본인 업로드 PDF 열기' }).click();
    await page.waitForFunction(() => document.querySelector('#announcement')?.textContent?.includes('내려받았습니다'));
    assert.equal(uploadDownloadAuth, 'Bearer SYNTHETIC_TOKEN_' + owner.id);

    // 3) 삭제된 업로드 문서 -> 열기 버튼 없이 삭제 상태 표시
    await sheet.locator('[data-evidence-item="room:0:requiredOptions"]').click();
    await sheet.getByText('삭제된 업로드 문서', { exact: true }).waitFor();
    assert.equal(await sheet.locator('[data-download-upload]').count(), 0);
    // 같은 실행 내 항목 전환 시 /evidence를 중복 호출하지 않는다.
    assert.equal(evidenceFetches, 1);

    await page.keyboard.press('Escape');

    // 4) 출처 제한(403 comparison_source_restricted) -> 에러 배너로 분명히 표시
    await page.goto(`${origin}/#run/${aid}/${ridRestricted}`);
    await page.locator('.scope-panel').waitFor();
    await page.locator('button[data-open-evidence="target:supplyArea"]').click();
    await sheet.locator('.sheet-error-banner').getByText('출처의 표시 권한을 확인 중입니다').waitFor();
  } finally {
    await ctx.close();
  }
});
