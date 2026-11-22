// 격리된 Supabase의 실제 JWT로 목록·접수·작업자·재조회까지 연결한다. 제공기관 응답은 합성이다.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = new URL('../', import.meta.url);

export async function checkNoticeAnalysis({ config, accounts, admin, requestApi, check, result, userClient, login, apiPort }) {
  check(['localhost', '127.0.0.1'].includes(new URL(config.origin).hostname), 'be11_ephemeral_database_required');
  const [owner, peer] = accounts;
  const now = new Date();
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(now);
  const notice = { houseManageNo: '9900000001', noticeNo: '9900000042', edition: date,
    title: '합성 목록에서 시작하는 공고', regionCode: '11215', kind: 'new_sale',
    application: { start: date, end: date }, moveIn: null, inventoryComplete: false,
    models: [{ modelNo: '01', houseType: '084.0000A', rooms: [], supplyAreaM2: null, areaEvidence: [] }],
    sourceIds: ['applyhome_apt', 'applyhome_apt_model'], reasonCodes: [] };
  const index = { contractVersion: 'notice-search-index/v1', dataOrigin: 'collected', observedAt: now.toISOString(),
    publicationWindow: { start: date, end: date }, regionCodes: ['11215'], coverage: { status: 'complete',
      sources: [{ source: 'applyhome_apt', status: 'complete' }, { source: 'applyhome_remainder', status: 'empty' }] },
    notices: [notice] };
  result(await admin.rpc('publish_notice_directory', { p_index: index, p_regions: { '11215': '서울특별시 광진구' } }),
    'be11_publish_directory');

  const headers = account => ({ Authorization: 'Bearer ' + account.accessToken });
  const page = await requestApi('/api/v1/notices', { headers: headers(owner) });
  check(page.status === 200, 'be11_login_directory');
  const listing = await page.json();
  const selected = listing.notices[0]?.models[0]?.analysisInput;
  check(listing.counts.open === 1 && listing.notices[0].regionName === '서울특별시 광진구'
    && selected?.noticeNo === notice.noticeNo && selected.modelNo === '01', 'be11_select_model');
  const { id } = result(await owner.client.from('analyses').insert({ user_id: owner.id, chat_id: owner.chatId })
    .select('id').single(), 'be11_open_draft');
  const path = `/api/v1/analyses/${id}/runs`;
  const key = randomUUID();
  const start = (user, requestKey) => requestApi(path, { method: 'POST', headers: {
    ...headers(user), 'Content-Type': 'application/json', 'Idempotency-Key': requestKey,
  }, body: JSON.stringify({ input: selected }) });
  check((await start(peer, randomUUID())).status === 404, 'be11_foreign_draft_hidden');
  const accepted = await start(owner, key);
  check(accepted.status === 202, 'be11_enqueue_selected');
  const run = await accepted.json();
  const location = accepted.headers.get('Location');
  check(run.status === 'queued' && location === path + '/' + run.runId, 'be11_observe_acceptance');
  check((await (await start(owner, key)).json()).runId === run.runId, 'be11_same_submission');

  const runWorker = async (runId, mode) => {
    const { stdout } = await exec('python3', ['scripts/smoke_notice_analysis_worker.py', runId, date, mode], {
      cwd: root, timeout: 60_000, maxBuffer: 4096, env: {
        PATH: process.env.PATH, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', APP_ENV: 'development',
        SUPABASE_URL: config.origin, SUPABASE_WORKER_KEY: config.service,
      },
    });
    return JSON.parse(stdout);
  };
  check((await runWorker(run.runId, 'present')).status === 'finished', 'be11_run_fresh_capture');
  const reopened = userClient();
  const session = await login(owner, reopened);
  const restored = result(await reopened.from('analyses').select('latest_run_id').eq('id', id).single(),
    'be11_reopen_analysis');
  check(restored.latest_run_id === run.runId, 'be11_resume_run');
  const response = await requestApi(path + '/' + restored.latest_run_id + '/result', {
    headers: { Authorization: 'Bearer ' + session.access_token },
  });
  check(response.status === 200, 'be11_read_fresh_result');
  const snapshot = await response.json();
  check(snapshot.result.dataOrigin === 'collected' && snapshot.result.comparables.length === 0
    && snapshot.result.holds.length > 0 && snapshot.result.completeness !== 'complete', 'be11_explain_held_comparison');
  check((await requestApi(location + '/result', { headers: headers(peer) })).status === 404, 'be11_owner_result_only');

  const workspaceKey = randomUUID();
  const open = () => owner.client.rpc('start_notice_workspace', { p_request_key: workspaceKey, p_input: selected });
  const second = result(await open(), 'be11_workspace_created');
  const retried = result(await open(), 'be11_workspace_recover');
  check(retried.runId === second.runId && retried.analysisId === second.analysisId && second.analysisId !== id,
    'be11_workspace_atomic_retry');
  check(second.status === 'queued' && second.runId !== run.runId, 'be11_new_selection_attempt');
  check((await runWorker(second.runId, 'missing')).status === 'failed', 'be11_missing_model_failed');
  const missing = await (await requestApi('/api/v1/analyses/' + second.analysisId + '/runs/' + second.runId, { headers: headers(owner) })).json();
  check(missing.status === 'failed' && missing.errorCode === 'notice_selection_unverified' && missing.snapshotId === null,
    'be11_missing_model_explained');
  if (process.env.NOTICE_BROWSER_SMOKE === '1') {
    const { checkWorkspaceInBrowser } = await import('./smoke_workspace_browser.mjs');
    // 이 격리 DB에서만 공개 표지를 준비하고 같은 수집본의 표시 권한 회수까지 검사한다.
    const referenceDisplay = async allowed => {
      const rows = result(await admin.from('source_registry').update({display_permission: allowed ? 'allowed' : 'denied'})
        .in('id', ['law_eflaw','naver_news']).select('id'), 'workspace_reference_permissions');
      check(rows.length === 2, 'workspace_reference_source_count');
      if (allowed) result(await admin.rpc('publish_law_reference', {p_reference: {
        contractVersion:'law-reference/v1', dataOrigin:'collected', asOf:date, observedAt:new Date().toISOString(),
        title:'주택공급에 관한 규칙', lawId:'008243', mst:'99900002', promulgatedOn:'2025-01-01', effectiveOn:'2025-02-01',
        articles:[{number:'21',branch:null,heading:'합성 모집공고 확인'}],
      }}), 'workspace_synthetic_law_version');
    };
    try {
      await checkWorkspaceInBrowser({ apiPort, dbOrigin: config.origin, owner, notice, runWorker, check, referenceDisplay });
    } finally {
      await referenceDisplay(false);
    }
  }
}
