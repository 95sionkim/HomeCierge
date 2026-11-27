// 맞춤 검색의 공유 프로필 초기값 채우기, 지역 장애 시 독립 복원, 비동기 편집 보호, 소유자·게스트 격리, 비교 대화의 프로필 분리를 공개 진입점에서 검증한다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { createDevServer } from '../../dev/server.ts';
import { serveWorkspace } from '../../dev/static.ts';

let server, browser, origin, comparisonFixture;

const REGIONS = [
  { code: '11215', name: '서울특별시 광진구' },
  { code: '11200', name: '서울특별시 성동구' },
];

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

async function installMockSupabase(context, initialUser, profilesByUser) {
  await context.addInitScript(
    ({ user, profiles }) => {
      let current = user;
      let listeners = [];
      const profileMap = structuredClone(profiles);
      const delayQueue = [];
      const releasedGates = [];
      window.__profileCalls = [];
      window.__mockAuth = {
        switchUser(nextUser) {
          current = nextUser;
          for (const cb of listeners) {
            cb(
              nextUser ? 'SIGNED_IN' : 'SIGNED_OUT',
              nextUser ? { user: nextUser, access_token: 'TOKEN_' + nextUser.id } : null,
            );
          }
        },
        setProfile(userId, payload) {
          profileMap[userId] = structuredClone(payload);
        },
        delayNextProfileRead() {
          let release;
          const gate = new Promise((resolve) => {
            release = resolve;
          });
          const item = { gate, release };
          delayQueue.push(item);
          releasedGates.push(item);
          return releasedGates.length - 1;
        },
        releaseProfileRead(index = 0) {
          releasedGates[index]?.release?.();
        },
      };
      const auth = {
        getSession: async () => ({
          data: { session: current ? { user: current, access_token: 'TOKEN_' + current.id } : null },
          error: null,
        }),
        signInWithPassword: async ({ email }) => {
          current =
            current && current.email === email ? current : { id: 'b2000000-0000-4000-8000-000000000099', email };
          return { data: { session: { user: current, access_token: 'TOKEN_' + current.id } }, error: null };
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
        limit: async () => ({ data: [], error: null }),
      };
      const rpc = (name, args) => {
        const headers = {};
        let abortSig = null;
        const entry = { name, args, ownerId: null, authHeader: null, aborted: false, settled: false };
        window.__profileCalls.push(entry);
        const pending = name === 'read_search_profile' ? delayQueue.shift() : null;
        const execute = async () => {
          try {
            const authHeader = headers.Authorization ?? headers.authorization ?? '';
            entry.authHeader = authHeader;
            const ownerId = authHeader.startsWith('Bearer TOKEN_')
              ? authHeader.slice('Bearer TOKEN_'.length)
              : (current?.id ?? null);
            entry.ownerId = ownerId;
            if (abortSig) {
              abortSig.addEventListener('abort', () => {
                entry.aborted = true;
              });
            }
            if (pending) await pending.gate;
            if (abortSig?.aborted) throw new DOMException('Aborted', 'AbortError');
            const profile = ownerId ? profileMap[ownerId] : null;
            if (!profile) return { data: null, error: { code: '42501', message: 'authentication_required' } };
            if (profile.__error) return { data: null, error: profile.__error };
            if (name === 'read_search_profile') {
              return { data: structuredClone(profile), error: null };
            }
            if (name === 'propose_search_profile_change') {
              const previous = {};
              for (const key of Object.keys(args.p_patch ?? {})) {
                previous[key] = Object.hasOwn(profile.conditions, key) ? structuredClone(profile.conditions[key]) : null;
              }
              const proposal = {
                id: args.p_request_id,
                baseRevision: args.p_base_revision,
                previous,
                patch: structuredClone(args.p_patch),
                reason: args.p_reason,
                status: 'pending',
                createdAt: '2026-11-22T01:00:00Z',
                decidedAt: null,
                analysisId: args.p_analysis_id ?? null,
                runId: args.p_run_id ?? null,
              };
              profile.proposals = [proposal, ...profile.proposals];
              return { data: structuredClone(profile), error: null };
            }
            return { data: null, error: { code: '42883', message: 'unknown rpc' } };
          } finally {
            entry.settled = true;
          }
        };
        const builder = {
          setHeader(key, value) {
            headers[key] = value;
            return builder;
          },
          abortSignal(sig) {
            abortSig = sig;
            if (sig?.aborted) entry.aborted = true;
            return builder;
          },
          then(resolve, reject) {
            return execute().then(resolve, reject);
          },
          catch(reject) {
            return execute().catch(reject);
          },
          finally(onFinally) {
            return execute().finally(onFinally);
          },
        };
        return builder;
      };
      globalThis.supabase = { createClient: () => ({ auth, from: () => query, rpc }) };
    },
    { user: initialUser, profiles: profilesByUser },
  );
}

function emptySearchResult(conditions) {
  return {
    contractVersion: 'notice-search/v1',
    dataOrigin: 'collected',
    asOf: '2026-11-22',
    publicationWindow: { start: '2026-10-01', end: '2026-11-22' },
    appliedConditions: conditions,
    coverage: {
      status: 'complete',
      sources: [
        { source: 'applyhome_apt', status: 'complete' },
        { source: 'applyhome_remainder', status: 'empty' },
      ],
    },
    counts: { matched: 0, needsReview: 0, excluded: 0 },
    zeroStatus: 'confirmed_zero',
    scopeIssues: [],
    truncation: { truncated: false, matchedOmitted: 0, needsReviewOmitted: 0 },
    matched: [],
    needsReview: [],
  };
}

for (const width of [1440, 390]) {
  test(`authenticated #search prefills exact BigInt won and approved profile without auto-submit at ${width}px`, async () => {
    const userA = { id: 'a3000000-0000-4000-8000-000000000001', email: 'buyer-a@example.invalid' };
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await installMockSupabase(ctx, userA, {
      [userA.id]: {
        contractVersion: 'shared-profile/v1',
        revision: 3,
        updatedAt: '2026-11-20T09:00:00Z',
        conditions: {
          region_codes: ['11215'],
          budget_max_won: '9007199254740993',
          supply_area_min_m2: '84.5',
          supply_area_max_m2: '115.25',
          move_in_start_month: '2027-01',
          move_in_end_month: '2027-06',
        },
        destination: '서울특별시 강남구 합성로 1',
        proposals: [
          {
            id: 'a3000000-0000-4000-8000-000000000099',
            baseRevision: 3,
            previous: { budget_max_won: '9007199254740993' },
            patch: { budget_max_won: '500000000' },
            reason: '미승인 변경안',
            status: 'pending',
            createdAt: '2026-11-21T09:00:00Z',
            decidedAt: null,
            analysisId: null,
            runId: null,
          },
        ],
        nextCursor: null,
      },
    });

    const submittedSearches = [];
    await ctx.route('**/*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/api/v1/notices/regions') {
        return route.fulfill({
          json: { contractVersion: 'notice-regions/v1', dataOrigin: 'collected', regions: REGIONS },
        });
      }
      if (url.pathname === '/api/v1/notices/search' && req.method() === 'POST') {
        const body = req.postDataJSON();
        submittedSearches.push(body);
        return route.fulfill({ json: emptySearchResult(body) });
      }
      return route.continue();
    });

    try {
      const page = await ctx.newPage();
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));

      await page.goto(`${origin}/#search`);
      await page
        .locator('#search-profile-status')
        .getByText(/승인된 공유 프로필 v3 조건을 채웠습니다.*대기 중인 변경안 1건은 승인 전까지 반영하지 않습니다/)
        .waitFor();
      await page.getByRole('button', { name: '서울특별시 광진구 제외' }).waitFor();

      // 2^53 초과 원 단위 문자열이 정밀도 손실 없이 쉼표 표기로 채워지고 자동 검색하지 않는다.
      assert.equal(await page.locator('#criteria-budget').inputValue(), '9,007,199,254,740,993');
      assert.deepEqual(
        (await page.locator('.region-chips button').allInnerTexts()).map((x) => x.trim()),
        ['서울특별시 광진구'],
      );
      assert.equal(await page.locator('.criteria-extra').evaluate((el) => el.open), true);
      assert.equal(await page.locator('#criteria-unit').inputValue(), 'm2');
      assert.equal(await page.locator('#criteria-min').inputValue(), '84.5');
      assert.equal(await page.locator('#criteria-max').inputValue(), '115.25');
      assert.equal(await page.locator('#criteria-start').inputValue(), '2027-01');
      assert.equal(await page.locator('#criteria-end').inputValue(), '2027-06');
      assert.equal(submittedSearches.length, 0, 'profile prefill must never auto-submit search');

      // 사용자가 직접 검색 버튼을 누를 때만 정확한 원 단위 문자열이 전송된다.
      await page.getByRole('button', { name: '이 조건으로 검색' }).click();
      await page.getByText('수집 범위에서 조건을 충족한 공고는 0건입니다.').waitFor();
      assert.equal(submittedSearches.length, 1);
      assert.deepEqual(submittedSearches[0], {
        regionCodes: ['11215'],
        budgetMaxWon: '9007199254740993',
        includeClosed: false,
        supplyArea: { min: '84.5', max: '115.25', unit: 'm2' },
        moveIn: { start: '2027-01', end: '2027-06' },
      });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
    } finally {
      await ctx.close();
    }
  });
}

test('authenticated #search restores approved budget/area/month independently during region outage and preserves forward edits', async () => {
  const user = { id: 'a3500000-0000-4000-8000-000000000001', email: 'outage@example.invalid' };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockSupabase(ctx, user, {
    [user.id]: {
      contractVersion: 'shared-profile/v1',
      revision: 5,
      updatedAt: '2026-11-21T09:00:00Z',
      conditions: {
        region_codes: ['11215'],
        budget_max_won: '750000000',
        supply_area_min_m2: '84.5',
        supply_area_max_m2: '115.25',
        move_in_start_month: '2027-01',
        move_in_end_month: '2027-06',
      },
      destination: null,
      proposals: [],
      nextCursor: null,
    },
  });

  let regionsFail = true;
  let delayRegionResponse = false;
  let releaseRegions = null;
  let searchCalls = 0;

  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/v1/notices/regions') {
      if (delayRegionResponse) {
        await new Promise((resolve) => {
          releaseRegions = resolve;
        });
      }
      if (regionsFail) {
        return route.fulfill({ status: 503, json: { error: 'search_index_not_ready' } });
      }
      return route.fulfill({
        json: { contractVersion: 'notice-regions/v1', dataOrigin: 'collected', regions: REGIONS },
      });
    }
    if (url.pathname === '/api/v1/notices/search') {
      searchCalls++;
      return route.fulfill({ json: emptySearchResult({}) });
    }
    return route.continue();
  });

  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // 1) 지역 목록이 먼저 실패하고 프로필이 늦게 도착해도 예산·면적·입주월을 복원하고 지역 불가·검색 비활성을 유지한다.
    await page.addInitScript(() => {
      window.__mockAuth.delayNextProfileRead();
    });
    await page.goto(`${origin}/#search`);
    await page.getByRole('heading', { name: '지역 목록을 불러올 수 없습니다' }).waitFor();
    await page.locator('#search-profile-status').getByText('저장된 공유 프로필을 확인하고 있습니다.').waitFor();
    await page.evaluate(() => window.__mockAuth.releaseProfileRead(0));

    await page
      .locator('#search-profile-status')
      .getByText(/승인된 공유 프로필 v5의 예산·면적·입주 조건을 복원했습니다/)
      .waitFor();
    await page.locator('.hold-note').getByText(/지역 목록을 불러올 수 없어 저장된 희망 지역\(11215\)/).waitFor();
    assert.equal(await page.locator('#criteria-budget').inputValue(), '750,000,000');
    assert.equal(await page.locator('#criteria-min').inputValue(), '84.5');
    assert.equal(await page.locator('#criteria-max').inputValue(), '115.25');
    assert.equal(await page.locator('#criteria-start').inputValue(), '2027-01');
    assert.equal(await page.locator('#criteria-end').inputValue(), '2027-06');
    assert.equal(await page.locator('.region-chips button').count(), 0);
    assert.equal(await page.locator('#criteria-region').isDisabled(), true);
    assert.equal(await page.locator('[data-search-add]').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '이 조건으로 검색' }).isDisabled(), true);

    // 2) 지역 장애 상태에서 프로필이 늦게 도착하기 전에 사용자가 예산을 수정하면 수정값을 보존한다.
    await page.evaluate(() => window.__mockAuth.delayNextProfileRead());
    await page.getByRole('button', { name: '다시 조회' }).click();
    await page.locator('#search-profile-status').getByText('저장된 공유 프로필을 확인하고 있습니다.').waitFor();
    await page.locator('#criteria-budget').fill('620,000,000');
    await page.evaluate(() => window.__mockAuth.releaseProfileRead(1));
    await page.waitForFunction(() => window.__profileCalls.at(-1)?.settled === true);
    assert.equal(await page.locator('#criteria-budget').inputValue(), '620,000,000');
    assert.equal(await page.locator('#criteria-min').inputValue(), '');
    assert.equal(await page.getByRole('button', { name: '이 조건으로 검색' }).isDisabled(), true);

    // 3) 프로필이 먼저 완료되고 지역 목록이 나중에 실패해도 복원된 예산·면적·입주월을 유지한다.
    delayRegionResponse = true;
    await page.getByRole('button', { name: '다시 조회' }).click();
    await page.waitForFunction(() => document.querySelector('#criteria-budget')?.value === '750,000,000');
    releaseRegions?.();
    delayRegionResponse = false;
    await page.locator('.hold-note').getByText(/지역 목록을 불러올 수 없어 저장된 희망 지역\(11215\)/).waitFor();
    assert.equal(await page.locator('#criteria-budget').inputValue(), '750,000,000');
    assert.equal(await page.locator('#criteria-min').inputValue(), '84.5');
    assert.equal(await page.getByRole('button', { name: '이 조건으로 검색' }).isDisabled(), true);

    // 4) 지역 목록이 복구되면 다시 조회로 지역·예산·면적·입주월이 모두 채워지고 검색이 활성화된다.
    regionsFail = false;
    await page.getByRole('button', { name: '다시 조회' }).click();
    await page.getByRole('button', { name: '서울특별시 광진구 제외' }).waitFor();
    await page.locator('#search-profile-status').getByText(/승인된 공유 프로필 v5 조건을 채웠습니다/).waitFor();
    assert.equal(await page.locator('#criteria-budget').inputValue(), '750,000,000');
    assert.equal(await page.getByRole('button', { name: '이 조건으로 검색' }).isDisabled(), false);
    assert.equal(searchCalls, 0);
    assert.deepEqual(errors, []);
  } finally {
    releaseRegions?.();
    await ctx.close();
  }
});

test('authenticated #search honestly reports stale region codes and partially-specified legacy conditions', async () => {
  const userLegacy = { id: 'a4000000-0000-4000-8000-000000000001', email: 'legacy@example.invalid' };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockSupabase(ctx, userLegacy, {
    [userLegacy.id]: {
      contractVersion: 'shared-profile/v1',
      revision: 1,
      updatedAt: '2026-11-11T09:00:00Z',
      conditions: {
        region_codes: ['11215', '99123'],
        budget_max_won: '750000000',
        supply_area_min_m2: '84',
        move_in_end_month: '2027-12',
      },
      destination: null,
      proposals: [],
      nextCursor: null,
    },
  });

  let searchCalls = 0;
  await ctx.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/v1/notices/regions') {
      return route.fulfill({
        json: { contractVersion: 'notice-regions/v1', dataOrigin: 'collected', regions: REGIONS },
      });
    }
    if (url.pathname === '/api/v1/notices/search') {
      searchCalls++;
      return route.fulfill({ json: emptySearchResult({}) });
    }
    return route.continue();
  });

  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(7000);
    await page.goto(`${origin}/#search`);

    await page.getByRole('button', { name: '서울특별시 광진구 제외' }).waitFor();
    await page.locator('.hold-note').getByText(/99123/).waitFor();
    await page.locator('.hold-note').getByText(/최소 면적\(84㎡\)만 있어 적용하지 않았습니다/).waitFor();
    await page.locator('.hold-note').getByText(/종료월\(2027-12\)만 있어 적용하지 않았습니다/).waitFor();

    // 유효한 지역과 예산만 채우고, 불완전한 반쪽 면적·입주월은 임의 생성하지 않는다.
    assert.deepEqual(
      (await page.locator('.region-chips button').allInnerTexts()).map((x) => x.trim()),
      ['서울특별시 광진구'],
    );
    assert.equal(await page.locator('#criteria-budget').inputValue(), '750,000,000');
    assert.equal(await page.locator('#criteria-min').inputValue(), '');
    assert.equal(await page.locator('#criteria-max').inputValue(), '');
    assert.equal(await page.locator('#criteria-start').inputValue(), '');
    assert.equal(await page.locator('#criteria-end').inputValue(), '');
    assert.equal(searchCalls, 0);
  } finally {
    await ctx.close();
  }
});

test('async profile load never overwrites forward edits, nor leaks across switch, logout/guest, relogin, or profile failure', async () => {
  const userA = { id: 'a5000000-0000-4000-8000-000000000001', email: 'alice@example.invalid' };
  const userB = { id: 'a5000000-0000-4000-8000-000000000002', email: 'bob@example.invalid' };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockSupabase(ctx, userA, {
    [userA.id]: {
      contractVersion: 'shared-profile/v1',
      revision: 2,
      updatedAt: '2026-11-20T09:00:00Z',
      conditions: { region_codes: ['11215'], budget_max_won: '700000000' },
      destination: null,
      proposals: [],
      nextCursor: null,
    },
    [userB.id]: {
      contractVersion: 'shared-profile/v1',
      revision: 4,
      updatedAt: '2026-11-21T09:00:00Z',
      conditions: { region_codes: ['11200'], budget_max_won: '500000000' },
      destination: null,
      proposals: [],
      nextCursor: null,
    },
  });

  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/v1/notices/regions') {
      return route.fulfill({
        json: { contractVersion: 'notice-regions/v1', dataOrigin: 'collected', regions: REGIONS },
      });
    }
    if (url.pathname === '/api/v1/notices/search' && req.method() === 'POST') {
      return route.fulfill({ json: emptySearchResult(req.postDataJSON()) });
    }
    return route.continue();
  });

  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(7000);

    // 1) 비동기 프로필 조회 중 사용자가 먼저 예산을 입력하면 늦게 도착한 프로필이 입력을 덮어쓰지 않는다.
    await page.addInitScript(() => {
      window.__mockAuth.delayNextProfileRead();
    });
    await page.goto(`${origin}/#search`);
    await page.locator('#search-profile-status').getByText('저장된 공유 프로필을 확인하고 있습니다.').waitFor();
    await page.locator('#criteria-budget').fill('650,000,000');
    await page.evaluate(() => window.__mockAuth.releaseProfileRead(0));
    await page.waitForFunction(() => window.__profileCalls[0]?.settled === true);
    assert.equal(await page.locator('#criteria-budget').inputValue(), '650,000,000');
    assert.equal(await page.locator('.region-chips button').count(), 0);

    // 2) #search 재진입 시 사용자 A의 프로필을 정상 채운다.
    await page.goto(`${origin}/#notices`);
    await page.goto(`${origin}/#search`);
    await page.locator('#search-profile-status').getByText(/승인된 공유 프로필 v2/).waitFor();
    await page.getByRole('button', { name: '서울특별시 광진구 제외' }).waitFor();
    assert.equal(await page.locator('#criteria-budget').inputValue(), '700,000,000');
    assert.deepEqual(
      (await page.locator('.region-chips button').allInnerTexts()).map((x) => x.trim()),
      ['서울특별시 광진구'],
    );

    // 3) 계정 전환 (A -> B): A의 조건은 즉시 사라지고 B의 조건만 채워진다.
    await page.evaluate((nextUser) => window.__mockAuth.switchUser(nextUser), userB);
    await page.locator('#search-profile-status').getByText(/승인된 공유 프로필 v4/).waitFor();
    await page.getByRole('button', { name: '서울특별시 성동구 제외' }).waitFor();
    assert.equal(await page.locator('#criteria-budget').inputValue(), '500,000,000');
    assert.deepEqual(
      (await page.locator('.region-chips button').allInnerTexts()).map((x) => x.trim()),
      ['서울특별시 성동구'],
    );

    // 4) 로그아웃 -> 게스트: 프로필 RPC를 호출하지 않고 합성 예시만 표시한다.
    const callsBeforeLogout = await page.evaluate(() => window.__profileCalls.length);
    await page.evaluate(() => window.__mockAuth.switchUser(null));
    await page.getByRole('button', { name: '합성시 가람구 제외' }).waitFor();
    assert.equal(await page.locator('#criteria-budget').inputValue(), '710,000,000');
    assert.equal(await page.evaluate(() => window.__profileCalls.length), callsBeforeLogout);

    // 5) 재로그인 (userA): 최신 승인 프로필을 다시 채우고 자동 검색하지 않는다.
    await page.evaluate((sameUser) => window.__mockAuth.switchUser(sameUser), userA);
    await page.locator('#search-profile-status').getByText(/승인된 공유 프로필 v2/).waitFor();
    await page.getByRole('button', { name: '서울특별시 광진구 제외' }).waitFor();
    assert.equal(await page.locator('#criteria-budget').inputValue(), '700,000,000');

    // 6) 프로필 조회 오류 시 안내를 표시하고 수동 입력 검색은 계속 가능하다.
    await page.evaluate((uid) => {
      window.__mockAuth.setProfile(uid, { __error: { code: 'XX000', message: 'unavailable' } });
    }, userA.id);
    await page.goto(`${origin}/#notices`);
    await page.goto(`${origin}/#search`);
    await page.locator('#search-profile-status').getByText(/저장된 공유 프로필을 불러오지 못했습니다/).waitFor();
    await page.locator('#criteria-region').fill('11215');
    await page.locator('#criteria-budget').fill('600,000,000');
    await page.getByRole('button', { name: '이 조건으로 검색' }).click();
    await page.getByText('수집 범위에서 조건을 충족한 공고는 0건입니다.').waitFor();
  } finally {
    await ctx.close();
  }
});

test('comparison chat separates explicit shared profile requests for guests and authenticated users without posting to comparison API', async () => {
  const aid = 'a6000000-0000-4000-8000-000000000001';
  const rid = 'a6000000-0000-4000-8000-000000000002';
  const snap = 'a6000000-0000-4000-8000-000000000003';
  const user = { id: 'a6000000-0000-4000-8000-000000000004', email: 'chat@example.invalid' };

  // Part 1: 게스트 예시 비교 대화
  const guestCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guestForbidden = [];
  await guestCtx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/v1/analyses/')) guestForbidden.push(url.pathname);
    return route.continue();
  });
  try {
    const page = await guestCtx.newPage();
    page.setDefaultTimeout(7000);
    await page.goto(`${origin}/#sample/saved`);
    await page.getByText('합성 예시 대화', { exact: true }).waitFor();

    const input = page.locator('#conversation-input');
    await input.fill('다음 검색부터 구매 예산을 7억 원으로 바꿔줘');
    await input.press('Enter');

    const card = page.locator('[data-profile-guest]').last();
    await card.getByText('로그인 필요 · 저장 안 함', { exact: true }).waitFor();
    await card.getByRole('button', { name: '로그인하고 공유 프로필 열기' }).click();
    await page.locator('dialog[open] #auth-email').waitFor();
    await page.keyboard.press('Escape');

    // 일반 비교 질문은 그대로 동작한다.
    await input.fill('왜 이 거래만 포함됐어?');
    await input.press('Enter');
    await page.locator('.conv-msg-agent').last().getByText(/비교표에 포함된 주변 단지는 2곳입니다/).waitFor();
    assert.deepEqual(guestForbidden, []);
  } finally {
    await guestCtx.close();
  }

  // Part 2: 로그인 사용자 비교 대화 — 프로필 초안은 기존 비교 엔드포인트로 절대 전송하지 않는다.
  const authCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockSupabase(authCtx, user, {
    [user.id]: {
      contractVersion: 'shared-profile/v1',
      revision: 1,
      updatedAt: '2026-11-20T09:00:00Z',
      conditions: { region_codes: ['11215'], budget_max_won: '700000000' },
      destination: null,
      proposals: [],
      nextCursor: null,
    },
  });
  const postedToComparison = [];
  const turns = [];
  await authCtx.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/v1/notices/regions') {
      return route.fulfill({
        json: { contractVersion: 'notice-regions/v1', dataOrigin: 'collected', regions: REGIONS },
      });
    }
    if (url.pathname === `/api/v1/analyses/${aid}/runs/${rid}`) {
      return route.fulfill({
        json: { analysisId: aid, runId: rid, snapshotId: snap, status: 'finished', input: { kind: 'snapshot' } },
      });
    }
    if (url.pathname === `/api/v1/analyses/${aid}/runs/${rid}/result`) {
      return route.fulfill({ json: { analysisId: aid, runId: rid, snapshotId: snap, result: comparisonFixture } });
    }
    if (url.pathname === `/api/v1/analyses/${aid}/runs/${rid}/conversation`) {
      if (req.method() === 'POST') {
        const body = req.postDataJSON();
        postedToComparison.push(body.message);
        turns.push({
          id: 'turn-' + turns.length,
          runId: rid,
          message: body.message,
          intent: 'inclusion',
          createdAt: '2026-11-10T01:05:00Z',
          answer: '일반 비교 대화 응답입니다.',
          proposal: null,
        });
      }
      return route.fulfill({
        json: { contractVersion: 'analysis-conversation/v1', analysisId: aid, runId: rid, hasEarlier: false, turns },
      });
    }
    return route.continue();
  });

  try {
    const page = await authCtx.newPage();
    page.setDefaultTimeout(7000);
    await page.goto(`${origin}/#run/${aid}/${rid}`);
    await page.getByRole('heading', { name: '비교 대화' }).waitFor();

    const input = page.locator('#conversation-input');
    // 명확한 예산 변경안은 O-3 대화상자로 분기하며 기존 비교 엔드포인트에 POST하지 않는다.
    await input.fill('공유 프로필의 구매 예산을 7억 5천만 원으로 바꿔줘');
    await input.press('Enter');
    const reviewDialog = page.locator('dialog[open] [data-profile-review-dialog]');
    await reviewDialog.waitFor();
    await reviewDialog.getByRole('button', { name: '공유 프로필에 반영' }).waitFor();
    assert.deepEqual(postedToComparison, []);
    await page.keyboard.press('Escape');

    // 일반 질문과 부정은 기존 비교 대화로 정상 전달된다.
    for (const normalMsg of ['왜 이 거래만 포함됐어?', '공유 프로필 예산이 얼마야?', '다음 검색부터 구매 예산을 바꾸지 마']) {
      await input.fill(normalMsg);
      await input.press('Enter');
      await page.locator('.conv-msg-user').getByText(normalMsg, { exact: true }).waitFor();
    }
    assert.deepEqual(postedToComparison, [
      '왜 이 거래만 포함됐어?',
      '공유 프로필 예산이 얼마야?',
      '다음 검색부터 구매 예산을 바꾸지 마',
    ]);

    // 기준 불명확 면적 요청도 기존 비교 엔드포인트로 보내지 않고 #profile 초안으로 분기한다.
    await input.fill('다음 검색부터 면적을 84㎡~100㎡로 바꿔줘');
    await input.press('Enter');
    await page.waitForFunction(() => location.hash === '#profile');
    assert.equal(postedToComparison.includes('다음 검색부터 면적을 84㎡~100㎡로 바꿔줘'), false);

    // 다시 분석 화면에서 보유 현금 요청도 비교 엔드포인트로 보내지 않고 #profile 초안으로 분기한다.
    await page.goto(`${origin}/#run/${aid}/${rid}`);
    await page.getByRole('heading', { name: '비교 대화' }).waitFor();
    await page.locator('#conversation-input').fill('공유 프로필의 보유 현금을 3억으로 바꿔줘');
    await page.locator('#conversation-input').press('Enter');
    await page.waitForFunction(() => location.hash === '#profile');
    assert.equal(postedToComparison.includes('공유 프로필의 보유 현금을 3억으로 바꿔줘'), false);

    // Part 3: createConversationPanel의 onSharedProfile({ message, analysisId, runId }) 콜백 계약 직접 검증.
    const handoffs = await page.evaluate(
      async ({ analysisId, runId, ownerId }) => {
        const { createConversationPanel } = await import('/app/conversation-panel.js');
        const host = document.createElement('div');
        document.body.append(host);
        const received = [];
        const panel = createConversationPanel({
          root: host,
          render() { host.innerHTML = panel.view(); },
          announce() {},
          onApprovedRun() {},
          onSharedProfile(payload) { received.push(payload); },
        });
        panel.enter({ guest: false, ownerId, analysisId, runId, comparison: null, originRun: null });
        host.innerHTML = panel.view();
        const box = host.querySelector('#conversation-input');
        box.value = '다음 검색부터 구매 예산을 7억 원으로 바꿔줘';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        host.querySelector('#conversation-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
        panel.reset();
        host.remove();
        return received;
      },
      { analysisId: aid, runId: rid, ownerId: user.id },
    );

    assert.deepEqual(handoffs, [
      { message: '다음 검색부터 구매 예산을 7억 원으로 바꿔줘', analysisId: aid, runId: rid },
    ]);
    assert.equal(postedToComparison.includes('다음 검색부터 구매 예산을 7억 원으로 바꿔줘'), false);
  } finally {
    await authCtx.close();
  }
});
