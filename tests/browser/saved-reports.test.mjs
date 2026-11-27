// S-07 저장 보고서(#reports, #reports/{uuid}, #run/{aid}/{rid}/report, #sample/saved/report)의
// 게스트 합성 예시, 수동 저장·멱등 UUID 재시도, 섹션 상태/권한/이스케이프, 키보드 삭제 확인, 타인 404,
// 지연 응답·계정 전환 격리, 데스크톱(1440)·모바일(390) 반응형을 실제 워크스페이스 진입점으로 검증한다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { createDevServer } from '../../dev/server.ts';
import { serveWorkspace } from '../../dev/static.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_A = { id: 'a1000000-0000-4000-8000-000000000011', email: 'report-alice@example.invalid' };
const USER_B = { id: 'b2000000-0000-4000-8000-000000000022', email: 'report-bob@example.invalid' };

const ANALYSIS_A = 'c1000000-0000-4000-8000-000000000001';
const RUN_A = 'c2000000-0000-4000-8000-000000000002';
const SNAP_A = 'c3000000-0000-4000-8000-000000000003';

const REPORT_A1 = 'd1000000-0000-4000-8000-000000000001';
const REPORT_A2 = 'd1000000-0000-4000-8000-000000000002';
const REPORT_A3 = 'd1000000-0000-4000-8000-000000000003';
const REPORT_B1 = 'd2000000-0000-4000-8000-000000000099';

function makeRichSyntheticReport({
  reportId = REPORT_A1,
  analysisId = ANALYSIS_A,
  runId = RUN_A,
  snapshotId = SNAP_A,
  version = 1,
  dataOrigin = 'synthetic',
  title = '합성 가람 아파트 084.0000A 분석 보고서',
  createdAt = '2026-11-23T05:30:00Z',
  queriedAt = '2026-11-23T04:15:00Z',
  xssProbe = false,
} = {}) {
  const probe = xssProbe ? ' <img src=x onerror="window.__xss=1"><script>window.__xss=2</script>' : '';
  return {
    contractVersion: 'saved-report/v1',
    reportId,
    analysisId,
    runId,
    snapshotId,
    version,
    createdAt,
    queriedAt,
    dataOrigin,
    title: title + probe,
    sections: [
      {
        id: 'notice',
        title: '공고 요약',
        state: 'confirmed',
        exportAllowed: true,
        rows: [
          { label: '공고', value: '합성 가람 아파트' + probe },
          { label: '주택관리번호', value: '9900000001' },
          { label: '공고번호', value: '9900000042' },
          { label: '주택형', value: '084.0000A' },
          { label: '공급면적', value: '112.40㎡' },
          { label: '확인된 호실 소계 범위', value: '7억 1,000만 원' },
        ],
        tables: [
          {
            headers: ['호실', '분양가', '필수 옵션', '소계 또는 보류 사유'],
            rows: [
              ['101동 101호', '7억 원', '1,000만 원', '7억 1,000만 원'],
              ['101동 102호', '—', '—', '필수 옵션 금액을 확인할 수 없습니다.'],
            ],
          },
        ],
        notes: ['소계는 분양가와 필수 옵션을 합한 금액입니다. 취득세·등기비·금융비용은 별도로 확인해야 합니다.' + probe],
      },
      {
        id: 'comparison',
        title: '주변 실거래 비교',
        state: 'partial',
        exportAllowed: true,
        rows: [
          { label: '적용 지역', value: '합성시 가람구 가람동' },
          { label: '분석 기준일', value: '2026-11-10' },
          { label: '계약 기간', value: '2025-11-11 ~ 2026-11-10' },
          { label: '비교 공급면적 범위', value: '106.78㎡ ~ 118.02㎡' },
          { label: '거래 종류', value: '아파트 매매 · 분양권' },
        ],
        tables: [
          {
            headers: ['단지', '공급면적', '거래', '건수', '최저', '중위', '최고', '상태'],
            rows: [
              ['주변 · 합성 비교 A' + probe, '112.50㎡', '아파트 매매', '1건', '5억 1,500만 원', '5억 1,500만 원', '5억 1,500만 원', '확인 · 소표본'],
              ['주변 · 합성 비교 B', '110.00㎡', '분양권', '1건', '4억 500만 원', '4억 500만 원', '4억 500만 원', '잠정 · 소표본'],
            ],
          },
        ],
        notes: [
          '입주권은 적용한 범위에서 조건에 맞는 주변 거래 0건을 확인했습니다.',
          '확인할 자료가 남아 있어 단지 순위를 확정하지 않았습니다.',
        ],
      },
      {
        id: 'funding',
        title: '호실 자금표',
        state: 'held',
        exportAllowed: true,
        rows: [],
        tables: [],
        notes: ['분석에서 호실을 선택하면 해당 호실의 납부 일정과 자금을 대조할 수 있습니다.'],
      },
      {
        id: 'law',
        title: '법령 근거',
        state: 'reference',
        exportAllowed: true,
        rows: [
          { label: '공고일', value: '2026-09-23' },
          { label: '법령', value: '주택공급에 관한 규칙' },
          { label: '시행일', value: '2026-07-01' },
          { label: '판본', value: '264123' },
          { label: '법제처 원문', value: 'https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=264123&efYd=20260701' },
        ],
        tables: [
          {
            headers: ['조문', '제목'],
            rows: [['제4조', '주택의 공급대상']],
          },
        ],
        notes: ['개인 신청 자격과 경과규정 적용 여부는 공고와 법령 원문에서 확인해야 합니다.'],
      },
      {
        id: 'news',
        title: '지역 뉴스',
        state: 'reference',
        exportAllowed: false,
        rows: [],
        tables: [],
        notes: ['지역 뉴스는 원래 분석의 뉴스 탭에서 조회할 수 있습니다. 기사와 발췌문은 조회 시점에 제공됩니다.'],
      },
      {
        id: 'commute',
        title: '출퇴근 경로',
        state: 'reference',
        exportAllowed: false,
        rows: [],
        tables: [],
        notes: ['원래 분석의 출퇴근 경로 탭에서 목적지와 교통수단을 선택하면 현재 경로를 조회할 수 있습니다.'],
      },
      {
        id: 'evidence',
        title: '자료 출처와 확인할 항목',
        state: 'partial',
        exportAllowed: true,
        rows: [
          { label: '자료 출처', value: '청약홈 아파트 공고' },
          { label: '공고문 판본·쪽', value: 'synthetic-notice-pdf · synthetic-v1 · 4쪽' },
          { label: '분석 규칙 버전', value: 'comparison/v1' },
        ],
        tables: [
          {
            headers: ['수집 출처', '요청 지역', '계약월', '조회 시각', '상태'],
            rows: [['국토교통부 아파트 매매 실거래', '99999', '2026-10', '2026-11-10T01:00:02Z', '부분 수집']],
          },
        ],
        notes: ['거래 신고 지연과 정정·해제에 따라 이후 조회 결과가 달라질 수 있습니다.'],
      },
    ],
  };
}

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

async function installMockAuth(context, { user = null, analyses = [] } = {}) {
  await context.addInitScript(
    (init) => {
      let currentUser = init.user;
      let listeners = [];
      const analysesList = init.analyses ?? [];

      window.__mockAuth = {
        switchUser(nextUser) {
          currentUser = nextUser;
          for (const cb of listeners) {
            cb(
              nextUser ? 'SIGNED_IN' : 'SIGNED_OUT',
              nextUser ? { user: nextUser, access_token: 'TOKEN_' + nextUser.id } : null,
            );
          }
        },
      };

      const auth = {
        getSession: async () => ({
          data: {
            session: currentUser
              ? { user: currentUser, access_token: 'TOKEN_' + currentUser.id }
              : null,
          },
          error: null,
        }),
        signInWithPassword: async ({ email }) => {
          currentUser = { id: 'a1000000-0000-4000-8000-000000000011', email };
          return {
            data: { session: { user: currentUser, access_token: 'TOKEN_' + currentUser.id } },
            error: null,
          };
        },
        signOut: async () => {
          currentUser = null;
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

      const tableQuery = {
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
        limit: async () => ({
          data: currentUser ? analysesList.filter((a) => a.user_id === currentUser.id) : [],
          error: null,
        }),
      };

      globalThis.supabase = {
        createClient: () => ({
          auth,
          from: () => tableQuery,
        }),
      };
    },
    { user, analyses },
  );
}

function createReportApiRouter(context, initial = {}) {
  const reportsByOwner = new Map();
  for (const [uid, list] of Object.entries(initial.reportsByOwner ?? {})) {
    reportsByOwner.set(uid, list.map((r) => structuredClone(r)));
  }
  const pageSize = initial.pageSize ?? 2;
  const calls = [];
  const savedByRequestId = new Map();
  let failSaveRemaining = initial.failSaveCount ?? 0;
  let failPdfRemaining = initial.failPdfCount ?? 0;
  let delayReadGate = null;
  let delayReadStarted = null;
  let delayListGate = null;
  let delayListStarted = null;

  function ownerFromAuth(req) {
    const auth = req.headers()['authorization'] ?? '';
    if (!auth.startsWith('Bearer TOKEN_')) return null;
    return auth.slice('Bearer TOKEN_'.length);
  }

  function ownerList(uid) {
    if (!reportsByOwner.has(uid)) reportsByOwner.set(uid, []);
    return reportsByOwner.get(uid);
  }

  function toSummary(report) {
    return {
      reportId: report.reportId,
      analysisId: report.analysisId,
      runId: report.runId,
      version: report.version,
      createdAt: report.createdAt,
      dataOrigin: report.dataOrigin,
    };
  }

  const ready = context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    const p = url.pathname;
    const method = req.method();

    if (p === '/api/v1/notices') {
      return route.fulfill({
        json: {
          contractVersion: 'notice-directory/v1',
          dataOrigin: 'collected',
          asOf: '2026-11-23',
          observedAt: '2026-11-23T01:00:00Z',
          publicationWindow: { start: '2026-10-23', end: '2026-11-23' },
          counts: { open: 0, upcoming: 0, closed: 0, unknown: 0 },
          zeroStatus: {
            open: 'confirmed_zero',
            upcoming: 'confirmed_zero',
            closed: 'confirmed_zero',
            unknown: 'confirmed_zero',
          },
          coverage: { sources: [{ source: 'applyhome_apt', status: 'empty' }] },
          notices: [],
          page: { offset: 0, limit: 50, nextCursor: null },
        },
      });
    }

    if (p === `/api/v1/analyses/${ANALYSIS_A}/runs/${RUN_A}` && method === 'GET') {
      return route.fulfill({
        json: {
          analysisId: ANALYSIS_A,
          runId: RUN_A,
          snapshotId: SNAP_A,
          status: 'finished',
          input: { kind: 'synthetic', noticeNo: '9900000042', modelNo: '01' },
        },
      });
    }

    if (p === `/api/v1/analyses/${ANALYSIS_A}/runs/${RUN_A}/result` && method === 'GET') {
      if (initial.resultMode === 'restricted') {
        return route.fulfill({ status: 403, json: { error: 'comparison_source_restricted' } });
      }
      const resultPayload = initial.comparisonOverride ?? comparisonFixture;
      return route.fulfill({
        json: { analysisId: ANALYSIS_A, runId: RUN_A, snapshotId: SNAP_A, result: resultPayload },
      });
    }

    if (p === `/api/v1/analyses/${ANALYSIS_A}/runs/${RUN_A}/conversation` && method === 'GET') {
      return route.fulfill({
        json: {
          contractVersion: 'analysis-conversation/v1',
          analysisId: ANALYSIS_A,
          runId: RUN_A,
          hasEarlier: false,
          turns: [],
        },
      });
    }

    // POST /api/v1/analyses/{aid}/runs/{rid}/reports
    const saveMatch = p.match(/^\/api\/v1\/analyses\/([^/]+)\/runs\/([^/]+)\/reports$/);
    if (saveMatch && method === 'POST') {
      const uid = ownerFromAuth(req);
      const body = req.postDataJSON();
      calls.push({
        kind: 'save',
        uid,
        analysisId: saveMatch[1],
        runId: saveMatch[2],
        requestId: body?.requestId,
        body: structuredClone(body),
      });
      if (!uid) return route.fulfill({ status: 401, json: { error: 'authentication_required' } });
      if (failSaveRemaining > 0) {
        failSaveRemaining -= 1;
        return route.fulfill({ status: 503, json: { error: 'backend_unavailable' } });
      }
      const key = `${uid}:${body.requestId}`;
      if (savedByRequestId.has(key)) {
        return route.fulfill({ status: 201, json: savedByRequestId.get(key) });
      }
      const list = ownerList(uid);
      const nextVersion = list.reduce((max, r) => Math.max(max, r.version), 0) + 1;
      const newId = `e0000000-0000-4000-8000-${String(nextVersion).padStart(12, '0')}`;
      const created = makeRichSyntheticReport({
        reportId: newId,
        analysisId: saveMatch[1],
        runId: saveMatch[2],
        snapshotId: SNAP_A,
        version: nextVersion,
        dataOrigin: 'synthetic',
        title: `합성 가람 아파트 084.0000A 분석 보고서 v${nextVersion}`,
      });
      list.unshift(created);
      savedByRequestId.set(key, created);
      return route.fulfill({ status: 201, json: created });
    }

    // GET /api/v1/reports?before=...
    if (p === '/api/v1/reports' && method === 'GET') {
      const uid = ownerFromAuth(req);
      const before = url.searchParams.get('before');
      calls.push({ kind: 'list', uid, before, search: url.search });
      if (!uid) return route.fulfill({ status: 401, json: { error: 'authentication_required' } });
      if (delayListGate && delayListGate.uid === uid && !before) {
        delayListStarted?.();
        await delayListGate.promise;
      }
      const list = ownerList(uid);
      let start = 0;
      if (before) {
        const idx = list.findIndex((r) => r.reportId === before);
        if (idx < 0) return route.fulfill({ status: 404, json: { error: 'report_not_found' } });
        start = idx + 1;
      }
      const slice = list.slice(start, start + pageSize);
      const nextCursor = start + pageSize < list.length ? slice.at(-1).reportId : null;
      return route.fulfill({ json: { reports: slice.map(toSummary), nextCursor } });
    }

    // GET /api/v1/reports/{reportId}/pdf
    const pdfMatch = p.match(/^\/api\/v1\/reports\/([^/]+)\/pdf$/);
    if (pdfMatch && method === 'GET') {
      const uid = ownerFromAuth(req);
      const rid = pdfMatch[1];
      calls.push({ kind: 'pdf', uid, reportId: rid });
      if (!uid) return route.fulfill({ status: 401, json: { error: 'authentication_required' } });
      if (failPdfRemaining > 0) {
        failPdfRemaining -= 1;
        return route.fulfill({ status: 503, json: { error: 'backend_unavailable' } });
      }
      const found = ownerList(uid).find((r) => r.reportId === rid);
      if (!found) return route.fulfill({ status: 404, json: { error: 'report_not_found' } });
      return route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: Buffer.from('%PDF-1.4\n% synthetic test pdf\n%%EOF\n'),
      });
    }

    // GET / DELETE /api/v1/reports/{reportId}
    const detailMatch = p.match(/^\/api\/v1\/reports\/([^/]+)$/);
    if (detailMatch && (method === 'GET' || method === 'DELETE')) {
      const uid = ownerFromAuth(req);
      const rid = detailMatch[1];
      calls.push({ kind: method === 'GET' ? 'read' : 'delete', uid, reportId: rid });
      if (!uid) return route.fulfill({ status: 401, json: { error: 'authentication_required' } });
      const list = ownerList(uid);
      const idx = list.findIndex((r) => r.reportId === rid);
      if (method === 'GET' && delayReadGate && delayReadGate.reportId === rid && delayReadGate.uid === uid) {
        delayReadStarted?.();
        await delayReadGate.promise;
      }
      if (idx < 0) return route.fulfill({ status: 404, json: { error: 'report_not_found' } });
      if (method === 'DELETE') {
        list.splice(idx, 1);
        return route.fulfill({ status: 204, body: '' });
      }
      return route.fulfill({ status: 200, json: list[idx] });
    }

    return route.continue();
  });

  return {
    ready,
    calls,
    delayNextRead(uid, reportId) {
      let release;
      let markStarted;
      const started = new Promise((res) => {
        markStarted = res;
      });
      const promise = new Promise((res) => {
        release = res;
      });
      delayReadStarted = markStarted;
      delayReadGate = { uid, reportId, promise };
      return {
        started,
        release() {
          delayReadGate = null;
          release();
        },
      };
    },
    delayNextList(uid) {
      let release;
      let markStarted;
      const started = new Promise((res) => {
        markStarted = res;
      });
      const promise = new Promise((res) => {
        release = res;
      });
      delayListStarted = markStarted;
      delayListGate = { uid, promise };
      return {
        started,
        release() {
          delayListGate = null;
          release();
        },
      };
    },
  };
}

test('guest #sample/saved/report shows synthetic sample report with sign-in CTA and zero private API calls', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockAuth(ctx, { user: null });
  const api = createReportApiRouter(ctx);
  await api.ready;

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(origin + '/#analyses');
  await page.locator('a[href="#sample/saved"]').first().click();
  await page.waitForSelector('.analysis-tabs');
  await page.locator('.analysis-tabs a[href="#sample/saved/report"]').click();

  await page.waitForSelector('.report-document[data-sample="true"]');
  const text = await page.locator('#report-page-slot').textContent();
  assert.match(text, /합성 자료/);
  assert.match(text, /로그인하면 실제 분석 보고서를 저장하고 PDF로 내보낼 수 있습니다/);
  assert.match(text, /로그인하고 보고서 저장/);
  assert.match(text, /공고 요약/);
  assert.match(text, /주변 실거래 비교/);
  assert.match(text, /호실 자금표/);
  assert.match(text, /법령 근거/);
  assert.match(text, /지역 뉴스/);
  assert.match(text, /출퇴근 경로/);
  assert.match(text, /자료 출처와 확인할 항목/);

  // 게스트가 저장 보고서 목록/상세로 이동하면 로그인 안내만 표시하고 비공개 API를 호출하지 않는다.
  await page.locator('.rail a[href="#reports"]').click();
  await page.waitForSelector('#report-guest-heading');
  assert.match(await page.locator('#report-guest-heading').textContent(), /로그인 후 저장 보고서를 확인할 수 있습니다/);

  await page.evaluate((id) => {
    location.hash = `#reports/${id}`;
  }, REPORT_A1);
  await page.waitForSelector('#report-guest-heading');
  assert.equal(api.calls.length, 0);
  assert.deepEqual(pageErrors, []);

  await ctx.close();
});

test('signed-in run report tab performs no auto-save/export, retries with identical UUID, and navigates to #reports/{id}', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockAuth(ctx, {
    user: USER_A,
    analyses: [
      {
        id: ANALYSIS_A,
        latest_run_id: RUN_A,
        title: '합성 가람 아파트',
        status: 'completed',
        updated_at: '2026-11-23T01:00:00Z',
        user_id: USER_A.id,
      },
    ],
  });
  const api = createReportApiRouter(ctx, { failSaveCount: 1, reportsByOwner: { [USER_A.id]: [] } });
  await api.ready;

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(origin + `/#run/${ANALYSIS_A}/${RUN_A}`);
  await page.waitForSelector('.analysis-tabs');
  await page.locator(`.analysis-tabs a[href="#run/${ANALYSIS_A}/${RUN_A}/report"]`).click();
  await page.waitForSelector('[data-report="save-run"]');

  // 자동 생성·자동 내보내기 금지 검증
  assert.equal(api.calls.filter((c) => c.kind === 'save').length, 0);
  assert.equal(api.calls.filter((c) => c.kind === 'pdf').length, 0);

  // 첫 저장 시도는 503 실패 -> 같은 요청 UUID로 재시도 가능해야 한다.
  await page.locator('[data-report="save-run"]').click();
  await page.waitForSelector('[data-report="retry-save"]');
  const firstSave = api.calls.find((c) => c.kind === 'save');
  assert.ok(firstSave && UUID_RE.test(firstSave.requestId));

  // 같은 요청으로 다시 시도 -> 정확히 같은 requestId UUID 전송 후 #reports/{id} 이동
  await page.locator('[data-report="retry-save"]').click();
  await page.waitForFunction(() => /^#reports\/[0-9a-f-]{36}$/i.test(location.hash));
  await page.waitForSelector('.report-document[data-sample="false"]');

  const saveCalls = api.calls.filter((c) => c.kind === 'save');
  assert.equal(saveCalls.length, 2);
  assert.equal(saveCalls[0].requestId, saveCalls[1].requestId);
  assert.deepEqual(pageErrors, []);

  await ctx.close();
});

test('detail view renders independent states, export permissions, safe escaping, TOC without hash clobber, and explicit PDF retry', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const richReport = makeRichSyntheticReport({ reportId: REPORT_A1, xssProbe: true });
  await installMockAuth(ctx, { user: USER_A });
  const api = createReportApiRouter(ctx, {
    failPdfCount: 1,
    reportsByOwner: { [USER_A.id]: [richReport] },
  });
  await api.ready;

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(origin + `/#reports/${REPORT_A1}`);
  await page.waitForSelector('.report-document');

  // XSS 스크립트/태그가 실행되거나 HTML로 주입되지 않았는지 검증
  const xssState = await page.evaluate(() => ({
    flag: window.__xss ?? null,
    injectedImg: document.querySelectorAll('#report-page-slot img').length,
    injectedScript: document.querySelectorAll('#report-page-slot script').length,
  }));
  assert.deepEqual(xssState, { flag: null, injectedImg: 0, injectedScript: 0 });
  assert.match(await page.locator('#report-doc-title').textContent(), /<img src=x onerror=/);

  // 보고서 저장 시각과 원자료 수집본 저장 시각이 UTC datetime 속성으로 구분 표시되는지 확인
  const timeLabels = await page.locator('.report-timestamps dt').allTextContents();
  assert.equal(timeLabels[0], '보고서 저장 시각');
  assert.equal(timeLabels[1], '원자료 수집본 저장');
  const timeValues = await page.locator('.report-timestamps time').evaluateAll((els) => els.map((e) => e.getAttribute('datetime')));
  assert.deepEqual(timeValues, ['2026-11-23T05:30:00Z', '2026-11-23T04:15:00Z']);

  // 독립 상태 및 PDF 포함/제외 권한 표시 확인
  assert.equal(await page.locator('section[data-section-id="notice"]').getAttribute('data-section-state'), 'confirmed');
  assert.equal(await page.locator('section[data-section-id="comparison"]').getAttribute('data-section-state'), 'partial');
  assert.equal(await page.locator('section[data-section-id="funding"]').getAttribute('data-section-state'), 'held');
  assert.equal(await page.locator('section[data-section-id="news"]').getAttribute('data-export-allowed'), 'false');
  assert.equal(await page.locator('section[data-section-id="commute"]').getAttribute('data-export-allowed'), 'false');
  assert.equal(await page.locator('section[data-section-id][data-export-allowed="true"]').count(), 5);
  assert.match(await page.locator('section[data-section-id="news"]').textContent(), /PDF 제외 · 화면 전용/);
  assert.match(await page.locator('section[data-section-id="comparison"]').textContent(), /주변 거래 0건을 확인했습니다/);

  // 목차 이동 버튼이 해시 라우트를 깨지 않고 섹션에 포커스하는지 확인
  await page.locator('[data-report="jump-section"][data-section-id="evidence"]').click();
  assert.equal(await page.evaluate(() => location.hash), `#reports/${REPORT_A1}`);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'report-sec-evidence');

  // 원본 분석 실행 돌아가기 링크 확인
  assert.equal(
    await page.locator(`.report-doc-actions a[href="#run/${ANALYSIS_A}/${RUN_A}"]`).count(),
    1,
  );

  // PDF 내보내기는 명시적 클릭 전에는 호출되지 않으며, 실패 후 재시도로 성공한다.
  assert.equal(api.calls.filter((c) => c.kind === 'pdf').length, 0);
  await page.locator('[data-report="download-pdf"]').click();
  await page.waitForSelector('.report-inline-error[role="alert"]');
  assert.match(await page.locator('.report-inline-error').textContent(), /보고서 서비스에 연결할 수 없습니다/);

  await page.locator('.report-inline-error [data-report="download-pdf"]').click();
  await page.waitForSelector('#report-banner.is-verified');
  assert.equal(api.calls.filter((c) => c.kind === 'pdf').length, 2);
  assert.deepEqual(pageErrors, []);

  await ctx.close();
});

test('list pagination, keyboard-accessible per-report delete confirmation with Escape cancel, and single-report deletion', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const r1 = makeRichSyntheticReport({ reportId: REPORT_A1, version: 3, createdAt: '2026-11-23T06:00:00Z' });
  const r2 = makeRichSyntheticReport({ reportId: REPORT_A2, version: 2, createdAt: '2026-11-23T05:00:00Z' });
  const r3 = makeRichSyntheticReport({ reportId: REPORT_A3, version: 1, createdAt: '2026-11-23T04:00:00Z' });
  await installMockAuth(ctx, { user: USER_A });
  const api = createReportApiRouter(ctx, {
    pageSize: 2,
    reportsByOwner: { [USER_A.id]: [r1, r2, r3] },
  });
  await api.ready;

  const page = await ctx.newPage();
  await page.goto(origin + '/#reports');
  await page.waitForSelector(`[data-report-card="${REPORT_A1}"]`);
  assert.equal(await page.locator('[data-report-card]').count(), 2);

  // 첫 페이지는 쿼리 없이 요청하고, 더 불러오기는 before 커서를 사용한다.
  assert.equal(api.calls[0].kind, 'list');
  assert.equal(api.calls[0].search, '');
  await page.locator('[data-report="load-more"]').click();
  await page.waitForSelector(`[data-report-card="${REPORT_A3}"]`);
  assert.equal(await page.locator('[data-report-card]').count(), 3);
  assert.equal(api.calls[1].before, REPORT_A2);

  // Report A2 삭제 확인을 키보드로 열고 Escape로 취소
  const deleteBtnA2 = page.locator(`[data-report="ask-delete"][data-report-id="${REPORT_A2}"]`);
  await deleteBtnA2.focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector(`#delete-confirm-${REPORT_A2}`);
  // 다른 카드(A1)에는 삭제 확인이 열리지 않아야 한다.
  assert.equal(await page.locator(`#delete-confirm-${REPORT_A1}`).count(), 0);
  // 초기 포커스는 안전한 취소 버튼에 위치한다.
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.report), 'cancel-delete');

  await page.keyboard.press('Escape');
  await page.waitForSelector(`#delete-confirm-${REPORT_A2}`, { state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.reportId), REPORT_A2);
  assert.equal(api.calls.filter((c) => c.kind === 'delete').length, 0);

  // 다시 열어 이 보고서 삭제 버튼으로 확정 삭제 -> A2만 제거되고 A1·A3 유지
  await page.keyboard.press('Enter');
  await page.waitForSelector(`#delete-confirm-${REPORT_A2}`);
  await page.locator(`#delete-confirm-${REPORT_A2} [data-report="confirm-delete"]`).focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector(`[data-report-card="${REPORT_A2}"]`, { state: 'detached' });
  assert.equal(await page.locator(`[data-report-card="${REPORT_A1}"]`).count(), 1);
  assert.equal(await page.locator(`[data-report-card="${REPORT_A3}"]`).count(), 1);
  assert.equal(api.calls.filter((c) => c.kind === 'delete').length, 1);

  await ctx.close();
});

test('other owner report returns hidden 404 and slow responses never leak private UI after identity switch or sign-out', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const rA = makeRichSyntheticReport({
    reportId: REPORT_A1,
    title: '계정A 비공개 보고서 비밀제목',
    version: 1,
  });
  const rB = makeRichSyntheticReport({
    reportId: REPORT_B1,
    title: '계정B 전용 보고서',
    version: 1,
  });
  await installMockAuth(ctx, { user: USER_A });
  const api = createReportApiRouter(ctx, {
    reportsByOwner: { [USER_A.id]: [rA], [USER_B.id]: [rB] },
  });
  await api.ready;

  const page = await ctx.newPage();
  // 계정 A가 계정 B의 보고서 UUID에 접근 -> 404 숨김 응답, B의 제목 노출 없음
  await page.goto(origin + `/#reports/${REPORT_B1}`);
  await page.waitForSelector('.report-empty[role="alert"]');
  const notFoundText = await page.locator('#report-page-slot').textContent();
  assert.match(notFoundText, /저장 보고서를 찾을 수 없습니다/);
  assert.doesNotMatch(notFoundText, /계정B 전용 보고서/);

  // 계정 A의 보고서 상세 조회를 지연시킨 상태에서 계정 B로 전환 -> 워크스페이스가 #notices로 이동하며,
  // 지연 응답이 도착해도 계정 A의 비공개 UI가 노출되지 않아야 한다.
  const slowRead = api.delayNextRead(USER_A.id, REPORT_A1);
  await page.evaluate((id) => {
    location.hash = `#reports/${id}`;
  }, REPORT_A1);
  await slowRead.started;

  await page.evaluate((nextUser) => {
    window.__mockAuth.switchUser(nextUser);
  }, USER_B);

  await page.waitForFunction(() => location.hash === '#notices');
  slowRead.release();
  await page.waitForTimeout(150);
  assert.doesNotMatch(await page.locator('body').textContent(), /계정A 비공개 보고서 비밀제목/);

  // 계정 B가 계정 A의 보고서 UUID에 직접 접근해도 404 숨김 응답이 반환된다.
  await page.evaluate((id) => {
    location.hash = `#reports/${id}`;
  }, REPORT_A1);
  await page.waitForSelector('.report-empty[role="alert"]');
  assert.doesNotMatch(await page.locator('#report-page-slot').textContent(), /계정A 비공개 보고서 비밀제목/);

  // #reports 목록에서 계정 B의 목록 조회를 지연시킨 상태에서 계정 A로 전환 -> 지연된 계정 B 응답이 A 화면을 덮어쓰지 않아야 한다.
  const slowListB = api.delayNextList(USER_B.id);
  await page.evaluate(() => {
    location.hash = '#reports';
  });
  await slowListB.started;

  await page.evaluate((nextUser) => {
    window.__mockAuth.switchUser(nextUser);
  }, USER_A);
  await page.waitForSelector(`[data-report-card="${REPORT_A1}"]`);
  slowListB.release();
  await page.waitForTimeout(150);
  assert.equal(await page.locator(`[data-report-card="${REPORT_A1}"]`).count(), 1);
  assert.equal(await page.locator(`[data-report-card="${REPORT_B1}"]`).count(), 0);

  // 로그아웃 시 비공개 보고서 UI가 즉시 제거된다.
  await page.evaluate(() => {
    window.__mockAuth.switchUser(null);
  });
  await page.waitForSelector('#report-guest-heading');
  assert.equal(await page.locator(`[data-report-card="${REPORT_A1}"]`).count(), 0);

  await ctx.close();
});

test('createReportPage enter() deduplicates repeated calls with identical context and resets cleanly', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const rA = makeRichSyntheticReport({ reportId: REPORT_A1, version: 1 });
  await installMockAuth(ctx, { user: USER_A });
  const api = createReportApiRouter(ctx, { reportsByOwner: { [USER_A.id]: [rA] } });
  await api.ready;

  const page = await ctx.newPage();
  await page.goto(origin + '/#notices');
  await page.waitForSelector('#main-content');

  const result = await page.evaluate(
    async ({ reportId, user }) => {
      const { createReportPage } = await import('/app/report-page.js');
      const host = document.createElement('div');
      let renders = 0;
      const pageMod = createReportPage({
        root: host,
        render: () => {
          renders += 1;
          host.innerHTML = pageMod.view();
        },
        announce: () => {},
        user: () => user,
        navigate: () => {},
      });
      pageMod.enter({ kind: 'detail', reportId, guest: false });
      pageMod.enter({ kind: 'detail', reportId, guest: false });
      await new Promise((r) => setTimeout(r, 120));
      const htmlBeforeReset = host.innerHTML;
      pageMod.reset();
      const htmlAfterReset = pageMod.view();
      pageMod.enter({ kind: 'detail', reportId, guest: false });
      await new Promise((r) => setTimeout(r, 120));
      return { renders, hasDocBefore: htmlBeforeReset.includes('report-document'), hasDocAfterReset: htmlAfterReset.includes('report-document') };
    },
    { reportId: REPORT_A1, user: USER_A },
  );

  // 중복 enter는 1회만 요청하고, reset 이후 다시 enter하면 재요청한다(총 2회).
  assert.equal(api.calls.filter((c) => c.kind === 'read' && c.reportId === REPORT_A1).length, 2);
  assert.equal(result.hasDocBefore, true);
  assert.equal(result.hasDocAfterReset, false);

  await ctx.close();
});

test('responsive layout has zero horizontal overflow on desktop 1440 and mobile 390 across list, detail, run, and sample', async () => {
  const rich = makeRichSyntheticReport({ reportId: REPORT_A1, version: 2 });

  for (const [label, viewport] of [
    ['desktop-1440', { width: 1440, height: 900 }],
    ['mobile-390', { width: 390, height: 844 }],
  ]) {
    const ctx = await browser.newContext({ viewport });
    await installMockAuth(ctx, { user: USER_A });
    const api = createReportApiRouter(ctx, { reportsByOwner: { [USER_A.id]: [rich] } });
    await api.ready;
    const page = await ctx.newPage();

    for (const [routeName, hash, waitSelector] of [
      ['list', '#reports', `[data-report-card="${REPORT_A1}"]`],
      ['detail', `#reports/${REPORT_A1}`, '.report-document'],
      ['run', `#run/${ANALYSIS_A}/${RUN_A}/report`, '[data-report="save-run"]'],
    ]) {
      await page.goto(origin + '/' + hash);
      await page.waitForSelector(waitSelector);
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        h1Count: document.querySelectorAll('main h1').length,
      }));
      assert.ok(
        metrics.scrollWidth <= metrics.innerWidth,
        `${label} ${routeName}: horizontal overflow ${metrics.scrollWidth} > ${metrics.innerWidth}`,
      );
      assert.equal(metrics.h1Count, 1, `${label} ${routeName}: expected single h1`);
    }

    await ctx.close();
  }

  // 모바일 390에서 게스트 예시 보고서도 가로 넘침 없이 렌더링된다.
  const guestCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await installMockAuth(guestCtx, { user: null });
  const guestApi = createReportApiRouter(guestCtx);
  await guestApi.ready;
  const guestPage = await guestCtx.newPage();
  await guestPage.goto(origin + '/#sample/saved/report');
  await guestPage.waitForSelector('.report-document[data-sample="true"]');
  const guestMetrics = await guestPage.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    summaryLinkBottom: document.querySelector('button[data-section-id="notice"]').getBoundingClientRect().bottom,
    innerHeight: window.innerHeight,
  }));
  assert.ok(guestMetrics.summaryLinkBottom < guestMetrics.innerHeight, '첫 화면에서 공고 요약으로 이동할 수 있어야 한다.');
  assert.equal(
    guestMetrics.scrollWidth <= guestMetrics.innerWidth,
    true,
    `mobile-390 sample: horizontal overflow ${guestMetrics.scrollWidth} > ${guestMetrics.innerWidth}`,
  );
  await guestCtx.close();
});

test('funding room selector: unfixed default, select second room inspects save body, retry reuses UUID and changed room mints fresh UUID', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const twoRoomComparison = structuredClone(comparisonFixture);
  twoRoomComparison.noticePrice.confirmedRooms = [
    ...twoRoomComparison.noticePrice.confirmedRooms,
    {
      room: '101동 102호',
      salePriceWon: '720000000',
      requiredOptionsWon: '10000000',
      subtotalWon: '730000000',
      evidence: twoRoomComparison.noticePrice.confirmedRooms[0].evidence,
    },
  ];
  await installMockAuth(ctx, { user: USER_A });
  const api = createReportApiRouter(ctx, {
    failSaveCount: 2,
    comparisonOverride: twoRoomComparison,
    reportsByOwner: { [USER_A.id]: [] },
  });
  await api.ready;

  const page = await ctx.newPage();
  await page.goto(origin + `/#run/${ANALYSIS_A}/${RUN_A}/report`);
  await page.waitForSelector('#report-funding-room');

  // 라벨과 원래 비교 범위 유지 설명, 기본값(미지정) 확인
  assert.equal(await page.locator('label[for="report-funding-room"]').textContent(), '자금표에 포함할 호실');
  assert.match(await page.locator('#report-funding-room-help').textContent(), /원래 비교 결과의 저장 범위는 바뀌지 않습니다/);
  assert.equal(await page.locator('#report-funding-room').inputValue(), '');
  assert.equal(await page.locator('#report-funding-room').isDisabled(), false);

  // 미지정 기본값 저장 실패 -> body에 fundingRoom 키가 없어야 한다.
  await page.locator('[data-report="save-run"]').click();
  await page.waitForSelector('[data-report="retry-save"]');
  // 같은 미지정 입력으로 재시도 -> 동일 requestId UUID 재사용 (2번째 실패)
  await page.locator('[data-report="retry-save"]').click();
  await page.waitForSelector('[data-report="retry-save"]');

  const callsBeforeChange = api.calls.filter((c) => c.kind === 'save');
  assert.equal(callsBeforeChange.length, 2);
  assert.deepEqual(Object.keys(callsBeforeChange[0].body), ['requestId']);
  assert.equal(callsBeforeChange[0].requestId, callsBeforeChange[1].requestId);

  // 두 번째 호실('101동 102호') 선택 -> 변경된 자금표 호실 선택이므로 새 UUID로 {requestId, fundingRoom} 전송
  await page.locator('#report-funding-room').selectOption('101동 102호');
  await page.locator('[data-report="save-run"]').click();
  await page.waitForFunction(() => /^#reports\/[0-9a-f-]{36}$/i.test(location.hash));

  const saveCalls = api.calls.filter((c) => c.kind === 'save');
  assert.equal(saveCalls.length, 3);
  assert.notEqual(saveCalls[2].requestId, saveCalls[0].requestId);
  assert.deepEqual(saveCalls[2].body, {
    requestId: saveCalls[2].requestId,
    fundingRoom: '101동 102호',
  });

  await ctx.close();
});

test('funding room selector locks single selectedRoom, tolerates restricted/empty rooms, and honors valid fundingRoom preselection', async () => {
  // 1) comparison_source_restricted -> rooms=[] 이지만 저장 CTA 정상 동작 ({requestId}만 전송)
  const restrictedCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await installMockAuth(restrictedCtx, { user: USER_A });
  const restrictedApi = createReportApiRouter(restrictedCtx, {
    resultMode: 'restricted',
    reportsByOwner: { [USER_A.id]: [] },
  });
  await restrictedApi.ready;

  const rPage = await restrictedCtx.newPage();
  await rPage.goto(origin + `/#run/${ANALYSIS_A}/${RUN_A}/report`);
  await rPage.waitForSelector('[data-report="save-run"]');
  assert.equal(await rPage.locator('#report-funding-room').count(), 0);
  await rPage.locator('[data-report="save-run"]').click();
  await rPage.waitForFunction(() => /^#reports\/[0-9a-f-]{36}$/i.test(location.hash));
  const restrictedSave = restrictedApi.calls.find((c) => c.kind === 'save');
  assert.deepEqual(Object.keys(restrictedSave.body), ['requestId']);
  await restrictedCtx.close();

  // 2) 단일 선택 호실(selected_room)은 잠금 표시되고 {requestId}로 원래 호실 고정 유지
  const lockedCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const singleRoomComparison = structuredClone(comparisonFixture);
  singleRoomComparison.noticePrice.scope = 'selected_room';
  singleRoomComparison.noticePrice.room = '101동 101호';
  await installMockAuth(lockedCtx, { user: USER_A });
  const lockedApi = createReportApiRouter(lockedCtx, {
    comparisonOverride: singleRoomComparison,
    reportsByOwner: { [USER_A.id]: [] },
  });
  await lockedApi.ready;

  const lPage = await lockedCtx.newPage();
  await lPage.goto(origin + `/#run/${ANALYSIS_A}/${RUN_A}/report`);
  await lPage.waitForSelector('#report-funding-room');
  assert.equal(await lPage.locator('#report-funding-room').isDisabled(), true);
  assert.equal(await lPage.locator('#report-funding-room').inputValue(), '101동 101호');
  await lPage.locator('[data-report="save-run"]').click();
  await lPage.waitForFunction(() => /^#reports\/[0-9a-f-]{36}$/i.test(location.hash));
  const lockedSave = lockedApi.calls.find((c) => c.kind === 'save');
  assert.deepEqual(Object.keys(lockedSave.body), ['requestId']);

  // 3) 유효한 context.fundingRoom은 사전 선택되고 목록에 없는 값은 무시되어 기본 미지정 유지
  const preselect = await lPage.evaluate(
    async ({ aid, rid, user }) => {
      const { createReportPage } = await import('/app/report-page.js');
      const host = document.createElement('div');
      const mod = createReportPage({
        root: host,
        render: () => {
          host.innerHTML = mod.view();
        },
        announce: () => {},
        user: () => user,
        navigate: () => {},
      });
      mod.enter({
        kind: 'run',
        analysisId: aid,
        runId: rid,
        guest: false,
        rooms: ['101동 101호', '101동 102호'],
        selectedRoom: null,
        fundingRoom: '101동 102호',
      });
      const validVal = host.querySelector('#report-funding-room')?.value;
      mod.enter({
        kind: 'run',
        analysisId: aid,
        runId: rid,
        guest: false,
        rooms: ['101동 101호', '101동 102호'],
        selectedRoom: null,
        fundingRoom: '999동 999호',
      });
      const invalidVal = host.querySelector('#report-funding-room')?.value;
      mod.reset();
      return { validVal, invalidVal };
    },
    { aid: ANALYSIS_A, rid: RUN_A, user: USER_A },
  );
  assert.deepEqual(preselect, { validVal: '101동 102호', invalidVal: '' });

  await lockedCtx.close();
});
