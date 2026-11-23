// 검수에서 만든 두 계정과 완료된 합성 분석으로 실제 Auth·PostgREST의 승인 경계를 확인한다.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export async function checkSharedProfile({ owner, peer, reopened, openNewOwnerSession, saved, check, result }) {
  const read = (client) => client.rpc('read_search_profile', { p_before: null });
  const decide = (client, id, decision) => client.rpc('decide_search_profile_change', { p_change_id: id, p_decision: decision });
  const original = result(await read(reopened), 'shared_profile_read');
  const otherOriginal = result(await read(peer.client), 'shared_profile_other_read');
  const resultArgs = { p_analysis_id: owner.analysisId, p_run_id: saved.runId };
  const stored = result(await reopened.rpc('get_analysis_comparison', resultArgs), 'shared_profile_before_result');
  check(stored.snapshotId === saved.snapshotId, 'shared_profile_source_capture');
  const input = {
    p_request_id: randomUUID(), p_base_revision: original.revision,
    p_patch: { budget_max_won: '750000000' }, p_reason: '합성 검수 · 다음 검색의 구매 예산 변경',
    p_analysis_id: owner.analysisId, p_run_id: saved.runId,
  };
  const propose = (client, args) => client.rpc('propose_search_profile_change', args);
  const pending = result(await propose(reopened, input), 'shared_profile_propose');
  const change = pending.proposals.find(row => row.id === input.p_request_id);
  check(change?.status === 'pending' && change.previous.budget_max_won === (original.conditions.budget_max_won ?? null)
    && change.patch.budget_max_won === '750000000' && change.analysisId === owner.analysisId && change.runId === saved.runId
    && isDeepStrictEqual(pending.conditions, original.conditions) && pending.revision === original.revision, 'shared_profile_pending');
  check((await propose(peer.client, { ...input, p_request_id: randomUUID(), p_base_revision: otherOriginal.revision })).error?.code === 'PT404',
    'shared_profile_foreign_origin');
  check((await decide(peer.client, input.p_request_id, 'approve')).error?.code === 'PT404', 'shared_profile_other_decision_hidden');

  const second = { ...input, p_request_id: randomUUID(), p_patch: { budget_max_won: '760000000' } };
  result(await propose(reopened, second), 'shared_profile_parallel_draft');
  const approved = await Promise.all([decide(reopened, input.p_request_id, 'approve'), decide(owner.client, input.p_request_id, 'approve')]);
  for (const reply of approved) {
    const current = result(reply, 'shared_profile_parallel_approve');
    check(current.revision === original.revision + 1 && current.conditions.budget_max_won === '750000000', 'shared_profile_applied_once');
  }
  const stale = await decide(reopened, second.p_request_id, 'approve');
  check(['40001', 'PT409'].includes(stale.error?.code), 'shared_profile_stale');
  result(await decide(reopened, second.p_request_id, 'cancel'), 'shared_profile_cancel');
  const retry = result(await propose(reopened, input), 'shared_profile_submit_retry');
  const rejectedId = randomUUID();
  result(await propose(reopened, { ...input, p_request_id: rejectedId, p_base_revision: retry.revision,
    p_analysis_id: null, p_run_id: null, p_patch: { budget_max_won: null } }), 'shared_profile_stage_clear');
  result(await decide(reopened, rejectedId, 'reject'), 'shared_profile_reject');

  const after = result(await read(await openNewOwnerSession()), 'shared_profile_relogin');
  const status = id => after.proposals.find(row => row.id === id)?.status;
  check(status(input.p_request_id) === 'approved' && status(second.p_request_id) === 'cancelled' && status(rejectedId) === 'rejected'
    && after.revision === original.revision + 1 && after.conditions.budget_max_won === '750000000', 'shared_profile_history');
  check(isDeepStrictEqual(result(await read(peer.client), 'shared_profile_other_after'), otherOriginal), 'shared_profile_isolated');
  const comparison = result(await reopened.rpc('get_analysis_comparison', resultArgs), 'shared_profile_saved_result');
  check(isDeepStrictEqual(comparison, stored), 'shared_profile_original_comparison');
}

export async function checkProfileRegion({ owner, requestApi, check, result }) {
  const regionReply = await requestApi('/api/v1/notices/regions', {
    headers: { Authorization: 'Bearer ' + owner.accessToken },
  });
  if (!regionReply.ok) {
    const failure = await regionReply.json();
    if (failure.error === 'search_index_not_ready' || failure.error === 'search_source_restricted') return 'directory unavailable';
  }
  check(regionReply.ok, 'shared_profile_region_list');
  const catalog = await regionReply.json();
  const code = catalog.regions?.[0]?.code;
  check(catalog.contractVersion === 'notice-regions/v1' && /^[0-9]{5}$/.test(code), 'shared_profile_published_region');
  const current = result(await owner.client.rpc('read_search_profile', { p_before: null }), 'shared_profile_region_before');
  const id = randomUUID();
  const proposal = result(await owner.client.rpc('propose_search_profile_change', { p_request_id: id,
    p_base_revision: current.revision, p_patch: { region_codes: [code] },
    p_reason: '합성 검수 · 공식 목록에서 희망 지역 선택', p_analysis_id: null, p_run_id: null }), 'shared_profile_region_propose');
  check(isDeepStrictEqual(proposal.conditions, current.conditions), 'shared_profile_region_pending');
  const approved = result(await owner.client.rpc('decide_search_profile_change', { p_change_id: id, p_decision: 'approve' }),
    'shared_profile_region_approve');
  check(isDeepStrictEqual(approved.conditions, { ...current.conditions, region_codes: [code] }), 'shared_profile_region_preserve');
  return 'published region approved';
}

// 실제로 로그인한 브라우저에서 비교 대화 → 승인 → 다음 검색을 거친다.
export async function checkProfileInBrowser({ owner, saved, apiPort, dbOrigin, check, afterProfile }) {
  const { chromium } = await import('playwright-core');
  const origin = 'http://127.0.0.1:' + apiPort;
  const executablePath = process.env.CHROME_BIN || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
  let browser, step = 'open';
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return [origin, dbOrigin].includes(url.origin) || url.protocol === 'data:' ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(origin + '/#profile');
    step = 'sign_in';
    await page.locator('[data-action=auth]:visible').first().click();
    await page.locator('#auth-email').fill(owner.email);
    await page.locator('#auth-password').fill(owner.password);
    await page.locator('#auth-form [type=submit]').click();
    await page.locator('[data-action=account]:visible').first().waitFor();
    const hash = '#run/' + owner.analysisId + '/' + saved.runId;
    await page.goto(origin + '/' + hash);
    step = 'ask';
    const input = page.locator('#conversation-input');
    await input.fill('다음 검색부터 구매 예산을 8억 원으로 바꿔줘');
    await page.locator('#conversation-send-btn').click();
    const review = page.getByRole('dialog', { name: '공유 프로필 변경안' });
    step = 'preview';
    await review.locator('[data-review=approve]').waitFor();
    check(new URL(page.url()).hash === hash, 'shared_profile_browser_origin');
    step = 'approve';
    await review.locator('[data-review=approve]').click();
    await review.getByText('다음 맞춤 검색에 적용했습니다.', { exact: true }).waitFor();
    await review.locator('[data-action=open-profile]').click();
    await page.getByRole('heading', { name: '공유 프로필', exact: true }).waitFor();
    step = 'search';
    let submissions = 0;
    page.on('request', req => { if (new URL(req.url()).pathname === '/api/v1/notices/search' && req.method() === 'POST') submissions++; });
    await page.goto(origin + '/#search');
    await page.waitForFunction(() => document.querySelector('#criteria-budget')?.value.replaceAll(',', '') === '800000000');
    check(submissions === 0, 'shared_profile_browser_search_on_demand');
    if (afterProfile) {
      step = 'reopen_saved_report';
      await afterProfile(page);
    }
  } catch {
    check(false, 'shared_profile_browser_' + step);
  } finally {
    await browser?.close();
  }
}
