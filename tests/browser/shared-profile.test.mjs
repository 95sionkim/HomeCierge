// 공유 프로필(#profile) 화면과 O-3 변경안 카드의 데스크톱·모바일, 승인 경계, 한쪽 저장값·긴 예산, 800코드포인트 사유, 재시도·충돌·커서·지역 장애·대화 O-3 연계를 검증한다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { createDevServer } from '../../dev/server.ts';
import { serveWorkspace } from '../../dev/static.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_KEYS = [
  'region_codes',
  'budget_max_won',
  'supply_area_min_m2',
  'supply_area_max_m2',
  'move_in_start_month',
  'move_in_end_month',
];

const OFFICIAL_REGIONS = [
  { code: '11215', name: '서울특별시 광진구' },
  { code: '11200', name: '서울특별시 성동구' },
  { code: '11680', name: '서울특별시 강남구' },
  { code: '41135', name: '경기도 성남시 분당구' },
];

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

/**
 * Supabase SDK의 .rpc(name, args).setHeader(...).abortSignal(signal) thenable 빌더를 모의한다.
 */
async function installMockBackend(context, initialState) {
  await context.addInitScript((init) => {
    let currentUser = init.user;
    let listeners = [];
    let analyses = init.analyses ?? [];
    const profiles = new Map();
    const calls = [];
    let nextFailure = null;
    let proposalClock = Date.parse('2026-11-22T01:00:00Z');

    for (const [uid, prof] of Object.entries(init.profiles ?? {})) {
      profiles.set(uid, structuredClone(prof));
    }

    function ensureProfile(uid) {
      if (!profiles.has(uid)) {
        profiles.set(uid, {
          revision: 0,
          updatedAt: null,
          conditions: {},
          destination: null,
          proposals: [],
        });
      }
      return profiles.get(uid);
    }

    function cloneConditions(c) {
      const out = {};
      for (const k of [
        'region_codes',
        'budget_max_won',
        'supply_area_min_m2',
        'supply_area_max_m2',
        'move_in_start_month',
        'move_in_end_month',
      ]) {
        if (c[k] !== undefined && c[k] !== null) out[k] = structuredClone(c[k]);
      }
      return out;
    }

    function formatPayload(prof, beforeId = null, pageSize = init.pageSize ?? 30) {
      const list = prof.proposals;
      let start = 0;
      if (beforeId) {
        const idx = list.findIndex((p) => p.id === beforeId);
        if (idx < 0) {
          return { data: null, error: { code: 'PT404', message: 'cursor_not_found' } };
        }
        start = idx + 1;
      }
      const slice = list.slice(start, start + pageSize);
      const nextCursor = start + pageSize < list.length ? slice.at(-1).id : null;
      return {
        data: {
          contractVersion: 'shared-profile/v1',
          revision: prof.revision,
          updatedAt: prof.updatedAt,
          conditions: cloneConditions(prof.conditions),
          destination: prof.destination,
          proposals: structuredClone(slice),
          nextCursor,
        },
        error: null,
      };
    }

    function sameValue(a, b) {
      return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    }

    function handleRpc(name, args, headers) {
      const authHeader = headers.Authorization || headers.authorization || '';
      calls.push({ name, args: structuredClone(args), authHeader });
      if (!currentUser || authHeader !== 'Bearer TOKEN_' + currentUser.id) {
        return { data: null, error: { code: '42501', message: 'authentication_required' } };
      }
      if (nextFailure && (!nextFailure.name || nextFailure.name === name)) {
        const fail = nextFailure;
        nextFailure = null;
        return { data: null, error: fail.error };
      }

      const prof = ensureProfile(currentUser.id);

      if (name === 'read_search_profile') {
        return formatPayload(prof, args?.p_before ?? null);
      }

      if (name === 'propose_search_profile_change') {
        const reqId = args?.p_request_id;
        const baseRev = args?.p_base_revision;
        const patch = args?.p_patch;
        const reason = args?.p_reason;
        const analysisId = args?.p_analysis_id ?? null;
        const runId = args?.p_run_id ?? null;

        const existing = prof.proposals.find((p) => p.id === reqId);
        if (existing) return formatPayload(prof, null);

        if (baseRev !== prof.revision) {
          return { data: null, error: { code: '40001', message: 'profile_changed' } };
        }
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
          return { data: null, error: { code: '22023', message: 'invalid_profile_input' } };
        }
        if (typeof reason !== 'string' || Array.from(reason).length > 800) {
          return { data: null, error: { code: '22023', message: 'invalid_reason_length' } };
        }

        const previous = {};
        const effectivePatch = {};
        for (const [key, val] of Object.entries(patch)) {
          const prevVal = prof.conditions[key] ?? null;
          if (!sameValue(prevVal, val)) {
            previous[key] = prevVal;
            effectivePatch[key] = val;
          }
        }
        if (!Object.keys(effectivePatch).length) {
          return { data: null, error: { code: '22023', message: 'no_change' } };
        }

        proposalClock += 60_000;
        const created = {
          id: reqId,
          baseRevision: baseRev,
          previous,
          patch: effectivePatch,
          reason,
          status: 'pending',
          createdAt: new Date(proposalClock).toISOString(),
          decidedAt: null,
          analysisId,
          runId,
        };
        prof.proposals.unshift(created);
        return formatPayload(prof, null);
      }

      if (name === 'decide_search_profile_change') {
        const changeId = args?.p_change_id;
        const decision = args?.p_decision;
        const item = prof.proposals.find((p) => p.id === changeId);
        if (!item) {
          return { data: null, error: { code: 'PT404', message: 'profile_proposal_not_found' } };
        }
        const targetStatus = { approve: 'approved', reject: 'rejected', cancel: 'cancelled' }[decision];
        if (!targetStatus) {
          return { data: null, error: { code: '22023', message: 'invalid_decision' } };
        }
        if (item.status !== 'pending') {
          if (item.status === targetStatus) return formatPayload(prof, null);
          return { data: null, error: { code: 'PT409', message: 'already_decided' } };
        }
        if (decision === 'approve') {
          if (item.baseRevision !== prof.revision) {
            return { data: null, error: { code: '40001', message: 'stale_revision' } };
          }
          for (const [k, v] of Object.entries(item.patch)) {
            if (v === null) delete prof.conditions[k];
            else prof.conditions[k] = structuredClone(v);
          }
          prof.revision += 1;
          proposalClock += 60_000;
          prof.updatedAt = new Date(proposalClock).toISOString();
        } else {
          proposalClock += 60_000;
        }
        item.status = targetStatus;
        item.decidedAt = new Date(proposalClock).toISOString();
        return formatPayload(prof, null);
      }

      return { data: null, error: { code: 'PT404', message: 'unknown_rpc' } };
    }

    function makeRpcBuilder(name, args) {
      const headers = {};
      let signal = null;
      const builder = {
        setHeader(k, v) {
          headers[k] = v;
          return builder;
        },
        abortSignal(sig) {
          signal = sig;
          return builder;
        },
        then(resolve, reject) {
          return Promise.resolve()
            .then(() => {
              if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
              return handleRpc(name, args, headers);
            })
            .then(resolve, reject);
        },
        catch(reject) {
          return builder.then(undefined, reject);
        },
      };
      return builder;
    }

    window.__mockControl = {
      getCalls() {
        return calls.slice();
      },
      clearCalls() {
        calls.length = 0;
      },
      failNext(name, error) {
        nextFailure = { name, error };
      },
      advanceRemoteRevision(uid, conditionsPatch) {
        const prof = ensureProfile(uid);
        for (const [k, v] of Object.entries(conditionsPatch)) {
          if (v === null) delete prof.conditions[k];
          else prof.conditions[k] = v;
        }
        prof.revision += 1;
        prof.updatedAt = '2026-11-23T00:30:00Z';
      },
      switchUser(nextUser) {
        currentUser = nextUser;
        for (const cb of listeners) {
          cb(
            nextUser ? 'SIGNED_IN' : 'SIGNED_OUT',
            nextUser ? { user: nextUser, access_token: 'TOKEN_' + nextUser.id } : null,
          );
        }
      },
      getProfile(uid) {
        return structuredClone(ensureProfile(uid));
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
        const matched = Object.values(init.usersByEmail ?? {}).find((u) => u.email === email);
        currentUser = matched ?? { id: 'b2000000-0000-4000-8000-000000000099', email };
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
      limit: async () => ({ data: analyses, error: null }),
    };

    globalThis.supabase = {
      createClient: () => ({
        auth,
        from: () => tableQuery,
        rpc: (name, args) => makeRpcBuilder(name, args),
      }),
    };
  }, initialState);
}

async function routeApi(context, { regionsMode = 'ok', aid = null, rid = null, snap = null } = {}) {
  let regionRequests = 0;
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    const p = url.pathname;

    if (p === '/api/v1/notices') {
      return route.fulfill({
        json: {
          contractVersion: 'notice-directory/v1',
          dataOrigin: 'collected',
          asOf: '2026-11-22',
          observedAt: '2026-11-22T01:00:00Z',
          publicationWindow: { start: '2026-10-22', end: '2026-11-22' },
          counts: { open: 0, upcoming: 0, closed: 0, unknown: 0 },
          zeroStatus: { open: 'confirmed_zero', upcoming: 'confirmed_zero', closed: 'confirmed_zero', unknown: 'confirmed_zero' },
          coverage: { sources: [{ source: 'applyhome_apt', status: 'empty' }] },
          notices: [],
          page: { offset: 0, limit: 50, nextCursor: null },
        },
      });
    }

    if (p === '/api/v1/notices/regions') {
      regionRequests += 1;
      if (regionsMode === 'fail') {
        return route.fulfill({ status: 503, json: { error: 'search_index_not_ready' } });
      }
      return route.fulfill({
        json: {
          contractVersion: 'notice-regions/v1',
          dataOrigin: 'collected',
          asOf: '2026-11-22',
          regions: OFFICIAL_REGIONS,
        },
      });
    }

    if (aid && rid && snap) {
      if (p === `/api/v1/analyses/${aid}/runs/${rid}`) {
        return route.fulfill({
          json: { analysisId: aid, runId: rid, snapshotId: snap, status: 'finished', input: { kind: 'snapshot' } },
        });
      }
      if (p === `/api/v1/analyses/${aid}/runs/${rid}/result`) {
        return route.fulfill({
          json: { analysisId: aid, runId: rid, snapshotId: snap, result: comparisonFixture },
        });
      }
      if (p === `/api/v1/analyses/${aid}/runs/${rid}/conversation` && req.method() === 'GET') {
        return route.fulfill({
          json: {
            contractVersion: 'analysis-conversation/v1',
            analysisId: aid,
            runId: rid,
            hasEarlier: false,
            turns: [],
          },
        });
      }
    }

    return route.continue();
  });
  return { getRegionRequests: () => regionRequests };
}

test('guest #profile requires login, leaks no private data/draft, and isolates accounts on switch', async () => {
  const userA = { id: 'a1000000-0000-4000-8000-000000000001', email: 'alice@example.invalid' };
  const userB = { id: 'b2000000-0000-4000-8000-000000000002', email: 'bob@example.invalid' };

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await installMockBackend(ctx, {
    user: null,
    profiles: {
      [userA.id]: {
        revision: 2,
        updatedAt: '2026-11-20T03:00:00Z',
        conditions: { region_codes: ['11215'], budget_max_won: '700000000' },
        destination: '서울특별시 광진구 아차산로 400',
        proposals: [],
      },
      [userB.id]: {
        revision: 1,
        updatedAt: '2026-11-21T03:00:00Z',
        conditions: { region_codes: ['11680'], budget_max_won: '1200000000' },
        destination: null,
        proposals: [],
      },
    },
  });
  const apiTracker = await routeApi(ctx);

  const page = await ctx.newPage();
  await page.goto(`${origin}/#profile`);

  await page.getByRole('heading', { name: '로그인 후 공유 프로필을 관리할 수 있습니다' }).waitFor();
  assert.equal(await page.locator('#profile-edit-form').count(), 0);
  assert.equal(await page.locator('#profile-draft-form').count(), 0);
  assert.equal(await page.getByRole('button', { name: '로그인하기' }).isVisible(), true);

  const guestCalls = await page.evaluate(() => window.__mockControl.getCalls());
  assert.equal(guestCalls.length, 0);
  assert.equal(apiTracker.getRegionRequests(), 0);

  // 사용자 A로 로그인 전환 -> 사용자 A 프로필 표시
  await page.evaluate((u) => window.__mockControl.switchUser(u), userA);
  await page.locator('.profile-version-pill').getByText('v2').waitFor();
  assert.ok((await page.locator('.profile-saved-card').innerText()).includes('서울특별시 광진구'));
  assert.ok((await page.locator('.profile-destination-card').innerText()).includes('아차산로 400'));

  // 사용자 A가 직접 수정 폼을 열고 작성 중 -> 사용자 B 전환 시 A의 초안/데이터 완전 초기화
  await page.locator('[data-profile="toggle-edit"]').click();
  await page.locator('#profile-budget').fill('999000000');
  await page.evaluate((u) => window.__mockControl.switchUser(u), userB);
  await page.locator('.profile-version-pill').getByText('v1').waitFor();
  const savedTextB = await page.locator('.profile-saved-card').innerText();
  assert.ok(savedTextB.includes('서울특별시 강남구'));
  assert.ok(!savedTextB.includes('광진구'));
  // 전환 후 수정 패널은 닫힌 초기 상태로 복원되고 B의 저장값으로 채워짐
  assert.equal(await page.locator('#profile-edit-panel').count(), 0);
  await page.locator('[data-profile="toggle-edit"]').click();
  assert.equal(await page.locator('#profile-budget').inputValue(), '1200000000');

  // 로그아웃 -> 다시 게스트 안내 화면, 개인 정보 비노출
  await page.evaluate(() => window.__mockControl.switchUser(null));
  await page.getByRole('heading', { name: '로그인 후 공유 프로필을 관리할 수 있습니다' }).waitFor();
  assert.equal(await page.locator('.profile-saved-card').count(), 0);

  await ctx.close();
});

for (const width of [1440, 390]) {
  test(`S-08 expandable edit form, accurate scope copy, propose/approve/reject/cancel, pair clearing & responsive layout at ${width}px`, async () => {
    const owner = { id: 'a1000000-0000-4000-8000-000000000010', email: 'buyer@example.invalid' };
    const histId = '11111111-1111-4111-8111-111111111111';

    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await installMockBackend(ctx, {
      user: owner,
      profiles: {
        [owner.id]: {
          revision: 3,
          updatedAt: '2026-11-21T02:00:00Z',
          conditions: {
            region_codes: ['11215'],
            budget_max_won: '700000000',
            supply_area_min_m2: '84.5',
            supply_area_max_m2: '105.0',
            move_in_start_month: '2027-01',
            move_in_end_month: '2027-06',
          },
          destination: '서울특별시 중구 세종대로 110',
          proposals: [
            {
              id: histId,
              baseRevision: 2,
              previous: { supply_area_max_m2: '100.0' },
              patch: { supply_area_max_m2: '105.0' },
              reason: '최대 면적만 상향',
              status: 'approved',
              createdAt: '2026-11-21T01:50:00Z',
              decidedAt: '2026-11-21T02:00:00Z',
              analysisId: null,
              runId: null,
            },
          ],
        },
      },
    });
    await routeApi(ctx);

    const page = await ctx.newPage();
    await page.goto(`${origin}/#profile`);
    await page.locator('.profile-version-pill').getByText('v3').waitFor();

    // 초기 화면에서 직접 수정 폼은 접혀 있어 저장 조건·출퇴근 목적지·변경 이력이 바로 보임
    assert.equal(await page.locator('#profile-edit-panel').count(), 0);
    assert.equal(await page.locator('.profile-saved-card').isVisible(), true);
    assert.equal(await page.locator('.profile-destination-card').isVisible(), true);
    assert.equal(await page.locator('.profile-history-table').isVisible(), true);

    // 한쪽만 변경된 이력은 실제 변경된 최대 공급면적만 정확히 표시
    assert.ok((await page.locator('.profile-history-table').innerText()).includes('최대 공급면적: 100.0㎡ → 105.0㎡'));

    // '모든 채팅' 과장 문구 없음 & 채워진 항목 옆 중복 '설정됨' 배지 없음
    const fullText = await page.locator('#profile-page-slot').innerText();
    assert.ok(!fullText.includes('모든 채팅'));
    assert.ok(fullText.includes('다음 맞춤 검색'));
    assert.equal(await page.locator('.profile-saved-card .badge.verified').count(), 0);

    // 가로 스크롤 없음 확인
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert.ok(overflow.scrollWidth <= overflow.innerWidth, `horizontal overflow at ${width}px: ${JSON.stringify(overflow)}`);

    // 출퇴근 목적지는 읽기 전용 카드에 별도 표시되고 수정 입력이 없음
    const destCard = page.locator('.profile-destination-card');
    assert.ok((await destCard.innerText()).includes('서울특별시 중구 세종대로 110'));
    assert.ok((await destCard.innerText()).includes('읽기 전용'));
    assert.equal(await destCard.locator('input, textarea').count(), 0);
    assert.equal(await destCard.locator('a[href="#analyses"]').count(), 1);

    // 직접 수정 열기 -> 값 입력 후 닫았다가 다시 열어도 작성 중인 초안 보존
    await page.locator('[data-profile="toggle-edit"]').click();
    await page.locator('#profile-edit-panel').waitFor();
    await page.locator('#profile-budget').fill('850,000,000');
    await page.locator('.profile-saved-card [data-profile="toggle-edit"]').click();
    assert.equal(await page.locator('#profile-edit-panel').count(), 0);
    assert.ok((await page.locator('.profile-saved-card [data-profile="toggle-edit"]').innerText()).includes('수정 이어하기'));
    await page.locator('.profile-saved-card [data-profile="toggle-edit"]').click();
    assert.equal(await page.locator('#profile-budget').inputValue(), '850,000,000');

    // 반쪽 공급면적 검증 차단
    await page.locator('#profile-area-max').fill('');
    await page.locator('[data-profile="submit-form"]').click();
    assert.ok((await page.locator('#profile-edit-form [role="alert"]').innerText()).includes('함께 입력'));

    // 반쪽 입주월 검증 차단
    await page.locator('#profile-area-max').fill('105.0');
    await page.locator('#profile-move-in-end').fill('');
    await page.locator('[data-profile="submit-form"]').click();
    assert.ok((await page.locator('#profile-edit-form [role="alert"]').innerText()).includes('함께 입력'));

    // 801 코드포인트 사유 차단, 800 코드포인트(이모지 포함, UTF-16 > 800) 허용 검증
    await page.locator('#profile-move-in-end').fill('2027-09');
    await page.locator('#profile-move-in-start').fill('2027-03');
    await page.locator('#profile-reason').fill('🏠'.repeat(401) + '가'.repeat(400));
    await page.locator('[data-profile="submit-form"]').click();
    assert.ok((await page.locator('#profile-edit-form [role="alert"]').innerText()).includes('800자'));

    const reason800 = '🏠'.repeat(400) + '가'.repeat(400);
    await page.locator('#profile-region-input').fill('서울특별시 성동구');
    await page.locator('[data-profile="add-region"]').click();
    await page.locator('#profile-area-min').fill('90');
    await page.locator('#profile-area-max').fill('115.5');
    await page.locator('#profile-reason').fill(reason800);

    await page.locator('[data-profile="submit-form"]').click();
    const pendingCard = page.locator('.profile-change-card.is-pending').first();
    await pendingCard.waitFor();

    // 등록 후 폼은 접히고 저장 프로필 v3은 유지, 대기 카드에 다음 맞춤 검색 범위 표시
    assert.equal(await page.locator('#profile-edit-panel').count(), 0);
    assert.ok((await page.locator('.profile-version-pill').innerText()).includes('v3'));
    assert.ok((await page.locator('.profile-saved-card').innerText()).includes('7억 원'));
    const diffText = await pendingCard.innerText();
    assert.ok(diffText.includes('다음 맞춤 검색에 적용'));
    assert.ok(!diffText.includes('모든 채팅'));
    assert.ok(diffText.includes('서울특별시 광진구 · 서울특별시 성동구'));
    assert.ok(diffText.includes('8억 5,000만 원'));
    assert.ok(diffText.includes('90㎡ – 115.5㎡'));
    assert.ok(diffText.includes('2027.03 – 2027.09'));

    // 명시적 승인 -> v4 반영
    await pendingCard.locator('[data-decision="approve"]').click();
    await page.locator('.profile-version-pill').getByText('v4').waitFor();
    assert.equal(await page.locator('.profile-change-card.is-pending').count(), 0);
    const savedV4 = await page.locator('.profile-saved-card').innerText();
    assert.ok(savedV4.includes('8억 5,000만 원'));
    assert.ok(savedV4.includes('90㎡ – 115.5㎡'));

    // 예산 해제 제안 후 거절 -> v4 유지
    await page.locator('[data-profile="toggle-edit"]').click();
    await page.locator('[data-profile="clear-budget"]').click();
    await page.locator('#profile-reason').fill('예산 상한 제거 테스트');
    await page.locator('[data-profile="submit-form"]').click();
    await page.locator('.profile-change-card.is-pending [data-decision="reject"]').click();
    await page.locator('#profile-banner').getByText('변경안을 거절했습니다.').waitFor();
    assert.ok((await page.locator('.profile-version-pill').innerText()).includes('v4'));

    // 공급면적·입주월 쌍 동시 해제 제안 후 취소 -> v4 유지
    await page.locator('[data-profile="toggle-edit"]').click();
    await page.locator('[data-profile="clear-area"]').click();
    await page.locator('[data-profile="clear-move-in"]').click();
    await page.locator('[data-profile="submit-form"]').click();
    await page.locator('.profile-change-card.is-pending [data-decision="cancel"]').click();
    await page.locator('#profile-banner').getByText('변경안을 취소했습니다.').waitFor();
    assert.ok((await page.locator('.profile-version-pill').innerText()).includes('v4'));

    // 공급면적 쌍 + 입주월 쌍 + 지역 해제 제안 후 승인 -> 미설정 배지 표시
    await page.locator('[data-profile="toggle-edit"]').click();
    await page.locator('[data-profile="clear-area"]').click();
    await page.locator('[data-profile="clear-move-in"]').click();
    await page.locator('[data-profile="clear-regions"]').click();
    await page.locator('[data-profile="submit-form"]').click();
    await page.locator('.profile-change-card.is-pending [data-decision="approve"]').click();
    await page.locator('.profile-version-pill').getByText('v5').waitFor();

    const finalProfile = await page.evaluate((uid) => window.__mockControl.getProfile(uid), owner.id);
    assert.equal(finalProfile.revision, 5);
    assert.equal(finalProfile.conditions.region_codes, undefined);
    assert.equal(finalProfile.conditions.supply_area_min_m2, undefined);
    assert.equal(finalProfile.conditions.supply_area_max_m2, undefined);
    assert.equal(finalProfile.conditions.move_in_start_month, undefined);
    assert.equal(finalProfile.conditions.move_in_end_month, undefined);
    assert.equal(finalProfile.conditions.budget_max_won, '850000000');

    // 모든 RPC 호출 검증
    const rpcCalls = await page.evaluate(() => window.__mockControl.getCalls());
    assert.ok(rpcCalls.length >= 6);
    for (const c of rpcCalls) {
      assert.equal(c.authHeader, 'Bearer TOKEN_' + owner.id);
      if (c.name === 'propose_search_profile_change') {
        assert.match(c.args.p_request_id, UUID_RE);
        for (const k of Object.keys(c.args.p_patch)) {
          assert.ok(PUBLIC_KEYS.includes(k), `unexpected patch key: ${k}`);
        }
      }
    }

    const overflowEnd = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    assert.ok(overflowEnd.scrollWidth <= overflowEnd.innerWidth, `end overflow at ${width}px`);

    await ctx.close();
  });
}

test('legacy one-sided area/month bounds and long valid budget are preserved visibly and untouched by unrelated edits', async () => {
  const owner = { id: 'a1000000-0000-4000-8000-000000000018', email: 'legacy@example.invalid' };
  const longBudget = '1234567890123456789012'; // 22-digit valid legacy won string

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await installMockBackend(ctx, {
    user: owner,
    profiles: {
      [owner.id]: {
        revision: 1,
        updatedAt: '2026-11-18T02:00:00Z',
        conditions: {
          budget_max_won: longBudget,
          supply_area_min_m2: '84.5',
          move_in_end_month: '2027-06',
        },
        destination: null,
        proposals: [],
      },
    },
  });
  await routeApi(ctx);

  const page = await ctx.newPage();
  await page.goto(`${origin}/#profile`);
  await page.locator('.profile-version-pill').getByText('v1').waitFor();

  // 한쪽만 저장된 값과 22자리 예산을 미설정으로 떨어뜨리지 않고 명확히 표시
  const savedText = await page.locator('.profile-saved-card').innerText();
  assert.ok(savedText.includes('84.5㎡ 이상'));
  assert.ok(savedText.includes('2027.06 이전'));
  assert.ok(savedText.includes('한쪽만 저장됨 · 범위 확인'));
  assert.ok(savedText.includes('7,890만 1,234') || savedText.includes('원'));
  assert.ok(!savedText.includes('최대 구매 예산\n—'));

  // 무관한 희망 지역만 추가 제안 -> 한쪽 면적·입주월·긴 예산을 지우거나 막지 않고 region_codes만 patch
  await page.locator('[data-profile="toggle-edit"]').click();
  await page.locator('#profile-region-input').fill('서울특별시 광진구');
  await page.locator('[data-profile="add-region"]').click();
  await page.locator('[data-profile="submit-form"]').click();
  await page.locator('.profile-change-card.is-pending [data-decision="approve"]').click();
  await page.locator('.profile-version-pill').getByText('v2').waitFor();

  const afterRegion = await page.evaluate((uid) => window.__mockControl.getProfile(uid), owner.id);
  assert.deepEqual(afterRegion.conditions.region_codes, ['11215']);
  assert.equal(afterRegion.conditions.budget_max_won, longBudget);
  assert.equal(afterRegion.conditions.supply_area_min_m2, '84.5');
  assert.equal(afterRegion.conditions.move_in_end_month, '2027-06');

  // 사용자가 원하면 한쪽 공급면적을 양쪽으로 보완하고, 한쪽 입주월은 모두 비우기 가능
  await page.locator('[data-profile="toggle-edit"]').click();
  await page.locator('#profile-area-max').fill('105.0');
  await page.locator('[data-profile="clear-move-in"]').click();
  await page.locator('[data-profile="submit-form"]').click();
  const pending = page.locator('.profile-change-card.is-pending').first();
  await pending.waitFor();
  // 실제 변경된 최대 공급면적(미설정→105.0㎡)과 입주 종료월(2027.06→설정 해제) 표시
  const pendingText = await pending.innerText();
  assert.ok(pendingText.includes('최대 공급면적'));
  assert.ok(pendingText.includes('105.0㎡'));
  assert.ok(pendingText.includes('입주 종료월'));
  assert.ok(pendingText.includes('설정 해제'));

  await pending.locator('[data-decision="approve"]').click();
  await page.locator('.profile-version-pill').getByText('v3').waitFor();

  const afterComplete = await page.evaluate((uid) => window.__mockControl.getProfile(uid), owner.id);
  assert.equal(afterComplete.conditions.supply_area_min_m2, '84.5');
  assert.equal(afterComplete.conditions.supply_area_max_m2, '105.0');
  assert.equal(afterComplete.conditions.move_in_start_month, undefined);
  assert.equal(afterComplete.conditions.move_in_end_month, undefined);
  assert.equal(afterComplete.conditions.budget_max_won, longBudget);

  await ctx.close();
});

test('same-requestId retry, stale revision handling, unavailable regions tolerance, and cursor pagination', async () => {
  const owner = { id: 'a1000000-0000-4000-8000-000000000020', email: 'retry@example.invalid' };
  const olderProposals = [
    {
      id: '22222222-2222-4222-8222-222222222201',
      baseRevision: 1,
      previous: { budget_max_won: '500000000' },
      patch: { budget_max_won: '600000000' },
      reason: '1페이지 최신 이력',
      status: 'approved',
      createdAt: '2026-11-20T01:00:00Z',
      decidedAt: '2026-11-20T01:05:00Z',
      analysisId: null,
      runId: null,
    },
    {
      id: '22222222-2222-4222-8222-222222222202',
      baseRevision: 0,
      previous: { budget_max_won: null },
      patch: { budget_max_won: '500000000' },
      reason: '2페이지 이전 이력',
      status: 'approved',
      createdAt: '2026-11-19T01:00:00Z',
      decidedAt: '2026-11-19T01:05:00Z',
      analysisId: null,
      runId: null,
    },
  ];

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await installMockBackend(ctx, {
    user: owner,
    pageSize: 1,
    profiles: {
      [owner.id]: {
        revision: 2,
        updatedAt: '2026-11-20T01:05:00Z',
        conditions: { region_codes: ['11215'], budget_max_won: '600000000' },
        destination: null,
        proposals: olderProposals,
      },
    },
  });
  await routeApi(ctx, { regionsMode: 'fail' });

  const page = await ctx.newPage();
  await page.goto(`${origin}/#profile`);
  await page.locator('.profile-version-pill').getByText('v2').waitFor();

  // 커서 기반 이전 이력 로드
  assert.ok((await page.locator('.profile-saved-card').innerText()).includes('코드 11215'));
  assert.ok((await page.locator('.profile-history-table').innerText()).includes('1페이지 최신 이력'));
  assert.ok(!(await page.locator('.profile-history-table').innerText()).includes('2페이지 이전 이력'));
  await page.locator('[data-profile="load-more"]').click();
  await page.getByText('2페이지 이전 이력').waitFor();
  assert.equal(await page.locator('[data-profile="load-more"]').count(), 0);

  // 지역 목록 실패 환경에서도 예산·입주월 변경안 제안 가능 + 일시 실패 후 동일 requestId 재시도
  await page.locator('[data-profile="toggle-edit"]').click();
  await page.locator('.profile-region-warn').waitFor();
  assert.equal(await page.locator('#profile-region-input').isDisabled(), true);

  await page.locator('#profile-budget').fill('750000000');
  await page.locator('#profile-move-in-start').fill('2027-01');
  await page.locator('#profile-move-in-end').fill('2027-06');
  await page.evaluate(() =>
    window.__mockControl.failNext('propose_search_profile_change', { code: '57014', message: 'timeout' }),
  );
  await page.locator('[data-profile="submit-form"]').click();
  await page.locator('[data-profile="retry-form"]').waitFor();
  await page.locator('[data-profile="retry-form"]').click();
  await page.locator('.profile-change-card.is-pending').waitFor();

  const proposeCalls = await page.evaluate(() =>
    window.__mockControl.getCalls().filter((c) => c.name === 'propose_search_profile_change'),
  );
  assert.equal(proposeCalls.length, 2);
  assert.equal(proposeCalls[0].args.p_request_id, proposeCalls[1].args.p_request_id);

  // 다른 화면에서 프로필이 v3으로 먼저 변경됨 -> 대기 카드 승인 시 40001 충돌 + 구버전을 현재 버전으로 오표시하지 않음
  await page.evaluate(
    (uid) => window.__mockControl.advanceRemoteRevision(uid, { budget_max_won: '720000000' }),
    owner.id,
  );
  await page.locator('.profile-change-card.is-pending [data-decision="approve"]').click();
  await page.locator('.profile-version-pill').getByText('v3').waitFor();
  const staleCard = page.locator('.profile-change-card.is-pending').first();
  await staleCard.locator('.profile-stale-note').waitFor();
  const staleText = await staleCard.innerText();
  assert.ok(staleText.includes('현재 저장값은 v3'));
  assert.ok(!staleText.includes('v2 프로필을 씁니다'));

  await staleCard.locator('[data-decision="cancel"]').click();
  await page.locator('#profile-banner').getByText('변경안을 취소했습니다.').waitFor();

  await ctx.close();
});

test('direct O-3 modal on original comparison run and region-needed handoff to #profile with roundtrip review', async () => {
  const owner = { id: 'a1000000-0000-4000-8000-000000000030', email: 'draft@example.invalid' };
  const aid = 'c3000000-0000-4000-8000-000000000031';
  const rid = 'c3000000-0000-4000-8000-000000000032';
  const snap = 'c3000000-0000-4000-8000-000000000033';

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockBackend(ctx, {
    user: owner,
    analyses: [
      { id: aid, latest_run_id: rid, title: '합성 가람 아파트', status: 'completed', updated_at: '2026-11-22T01:00:00Z' },
    ],
    profiles: {
      [owner.id]: {
        revision: 1,
        updatedAt: '2026-11-20T01:00:00Z',
        conditions: { region_codes: ['11215'], budget_max_won: '700000000' },
        destination: '안전한 목적지 <img src=x onerror="window.__xss=1">',
        proposals: [],
      },
    },
  });
  await routeApi(ctx, { aid, rid, snap });

  const page = await ctx.newPage();
  await page.goto(`${origin}/#run/${aid}/${rid}`);
  await page.locator('#conversation-input').waitFor();

  // 1) 지역 목록 없이 바로 해석되는 요청 -> 원래 비교 화면(#run/...)에서 O-3 모달이 직접 열림
  await page.locator('#conversation-input').fill('공유 프로필 예산을 8억으로 바꿔줘');
  await page.locator('#conversation-send-btn').click();

  const directDialog = page.locator('#workspace-dialog[open] [data-profile-review-dialog]');
  await directDialog.waitFor();
  assert.equal(await page.evaluate(() => location.hash), `#run/${aid}/${rid}`);
  const directText = await directDialog.innerText();
  assert.ok(directText.includes('7억 원'));
  assert.ok(directText.includes('8억 원'));
  assert.ok(directText.includes('다음 맞춤 검색에 적용'));
  assert.ok(!directText.includes('모든 채팅'));
  // showActions:false로 렌더된 카드에는 내부 결정 버튼이 중복되지 않고 모달 actions만 표시됨
  assert.equal(await directDialog.locator('[data-profile="decide"]').count(), 0);
  await directDialog.locator('[data-review="approve"]').click();
  await directDialog.getByText('다음 맞춤 검색에 적용했습니다.').waitFor();
  await page.locator('#workspace-dialog [data-action="close"]').click();

  // 원래 비교 결과는 바뀌지 않고 유지됨
  assert.equal(await page.evaluate(() => location.hash), `#run/${aid}/${rid}`);
  assert.equal((await page.evaluate((uid) => window.__mockControl.getProfile(uid), owner.id)).revision, 2);

  // 2) 지역명이 포함된 요청 -> #profile 초안으로 이동해 공식 지역 목록으로 해석
  await page
    .locator('#conversation-input')
    .fill('공유 프로필 희망 지역 서울특별시 성동구, 예산 8억 5천만으로 바꿔줘');
  await page.locator('#conversation-send-btn').click();

  await page.waitForFunction(() => location.hash === '#profile');
  await page.locator('[data-draft-preview]').waitFor();
  assert.equal(await page.locator(`a.profile-return-link[href="#run/${aid}/${rid}"]`).count(), 1);
  assert.equal(await page.locator(`.profile-destination-card a[href="#run/${aid}/${rid}/commute"]`).count(), 1);

  const previewText = await page.locator('[data-draft-preview]').innerText();
  assert.ok(previewText.includes('서울특별시 성동구'));
  assert.ok(previewText.includes('8억 5,000만 원'));
  assert.ok((await page.locator('.profile-version-pill').innerText()).includes('v2'));
  assert.equal(await page.evaluate(() => window.__xss ?? null), null);

  // 변경안 등록 -> S-08 대기 카드 생성 -> '대화에서 검토하기'로 O-3 모달 복귀 후 승인
  await page.locator('[data-profile="submit-draft"]').click();
  const pending = page.locator('.profile-change-card.is-pending').first();
  await pending.waitFor();
  assert.ok((await page.locator('.profile-version-pill').innerText()).includes('v2'));

  await pending.locator('[data-profile-review]').click();
  await page.waitForFunction((expected) => location.hash === expected, `#run/${aid}/${rid}`);
  const reviewDialog = page.locator('#workspace-dialog[open] [data-profile-review-dialog]');
  await reviewDialog.waitFor();
  assert.ok((await reviewDialog.innerText()).includes('8억 5,000만 원'));
  await reviewDialog.locator('[data-review="approve"]').click();
  await reviewDialog.getByText('다음 맞춤 검색에 적용했습니다.').waitFor();

  // 공유 프로필로 돌아와 v3 반영 및 지원하지 않는 요청(보유 현금) 차단 + XSS 방지 확인
  await reviewDialog.locator('[data-action="open-profile"]').click();
  await page.waitForFunction(() => location.hash === '#profile');
  await page.locator('.profile-version-pill').getByText('v3').waitFor();
  assert.ok((await page.locator('.profile-saved-card').innerText()).includes('서울특별시 성동구'));
  assert.ok((await page.locator('.profile-saved-card').innerText()).includes('8억 5,000만 원'));

  await page.locator('[data-profile="toggle-draft"]').click();
  await page.locator('#profile-draft-message').fill('공유 프로필 보유 현금을 4억으로 바꿔줘 <script>window.__xss=2</script>');
  await page.locator('[data-profile="parse-draft"]').click();
  await page.locator('.profile-draft-card [role="alert"]').waitFor();
  assert.equal(await page.locator('[data-draft-preview]').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss ?? null), null);

  await ctx.close();
});
