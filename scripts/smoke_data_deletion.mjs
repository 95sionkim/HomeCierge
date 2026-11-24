// 이번 검수에서 생성한 두 계정과 등록된 합성 PDF에만 삭제를 요청한다.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const execute = promisify(execFile);

export async function checkDataDeletion({ accounts, admin, config, apiPort, requestApi, check, result, newClient,
  registerUpload, uploadObject, pdf, saved }) {
  const [owner, peer] = accounts;
  const auth = { Authorization:'Bearer ' + owner.accessToken };
  const post = (path, body, credentials = auth) => requestApi('/api/v1/privacy/' + path, {
    method:'POST', headers:{ ...credentials, 'Content-Type':'application/json' }, body:JSON.stringify(body),
  });
  const act = (scope, targetId, receiptId = randomUUID(), credentials = auth) =>
    post('requests', {scope, targetId, receiptId, confirmed:true}, credentials);

  const savedPath = '/api/v1/analyses/' + owner.analysisId + '/runs/' + saved.runId + '/reports';
  const save = await requestApi(savedPath, { method:'POST', headers:{...auth,'Content-Type':'application/json'},
    body:JSON.stringify({requestId:randomUUID()}) });
  check(save.status === 201,'deletion_synthetic_report');
  const report = await save.json();
  const listed = await requestApi('/api/v1/privacy/items?kind=report',{headers:auth});
  check(listed.ok && (await listed.json()).items.some(x => x.id === report.reportId),'deletion_report_list');
  const foreign = { Authorization:'Bearer ' + peer.accessToken };
  check((await post('impact',{scope:'analysis',targetId:owner.analysisId},foreign)).status === 404,'deletion_foreign_impact');
  check((await act('analysis',owner.analysisId,randomUUID(),foreign)).status === 404,'deletion_foreign_request');
  const fund = result(await owner.client.from('funding_entries').insert({user_id:owner.id,analysis_id:owner.analysisId,
    kind:'additional',amount_won:12345,available_on:'2026-11-23',certainty:'expected'}).select('id').single(),'deletion_seed_fund');
  const separate = await newClient(owner);
  const fundImpact = await post('impact',{scope:'fund',targetId:fund.id});
  check(fundImpact.ok && (await fundImpact.json()).counts.funds === 1,'deletion_fund_impact');
  const fundReceipt = randomUUID();
  const both = await Promise.all([act('fund',fund.id,fundReceipt),act('fund',fund.id,fundReceipt)]);
  for (const reply of both) check(reply.ok && (await reply.json()).status === 'live_deleted','deletion_fund_idempotent');
  const absent = await separate.from('funding_entries').select('id').eq('id',fund.id);
  check(!absent.error && absent.data.length === 0,'deletion_fund_other_device');
  check((await act('analysis',owner.analysisId,fundReceipt)).status === 409,'deletion_receipt_bound');
  check((await post('receipt',{receiptId:randomUUID()},{})).status === 404,'deletion_unknown_receipt');

  const proposal = { p_request_id:randomUUID(), p_base_revision:0, p_patch:{budget_max_won:'700000000'},
    p_reason:'합성 삭제 검수', p_analysis_id:null, p_run_id:null };
  result(await owner.client.rpc('propose_search_profile_change',proposal),'deletion_profile_propose');
  const approved = result(await owner.client.rpc('decide_search_profile_change',{
    p_change_id:proposal.p_request_id, p_decision:'approve'}),'deletion_profile_approve');
  check(approved.conditions.budget_max_won === '700000000','deletion_profile_seeded');
  const profileReceipt = await act('profile',null);
  check(profileReceipt.ok && (await profileReceipt.json()).status === 'live_deleted','deletion_profile_complete');
  const cleared = result(await separate.rpc('read_search_profile',{}),'deletion_profile_other_device');
  check(Object.keys(cleared.conditions).length === 0 && cleared.proposals.length === 0 && cleared.revision > approved.revision,
    'deletion_profile_no_prefill');
  const delayed = await separate.rpc('propose_search_profile_change',proposal);
  check(Boolean(delayed.error),'deletion_profile_delayed_request');

  await registerUpload(owner);
  owner.upload.writeAttempted = true;
  result(await uploadObject(owner.client,owner.upload.path,pdf),'deletion_seed_file');
  const identity = (await separate.auth.getSession()).data.session;
  check(identity?.user.id === owner.id,'deletion_second_session');
  const preview = await post('impact',{scope:'account',targetId:null});
  check(preview.ok,'deletion_account_impact');
  const impact = await preview.json();
  check(impact.counts.analyses >= 1 && impact.counts.uploads >= 1 && impact.storageObjects === 1 &&
    impact.reportsDeleted === impact.counts.reports && impact.reportsDeleted >= 1 && impact.reportsUpdated === 0,'deletion_impact_counts');
  const receiptId = process.env.DELETION_BROWSER_SMOKE === '1'
    ? await submitFromBrowser(owner, apiPort, config.origin, check)
    : await accept(await act('account',null),owner,check);
  const formerAuth = { Authorization:'Bearer ' + identity.access_token };
  const readGone = await requestApi('/api/v1/reports/' + report.reportId,{headers:formerAuth});
  check([401,404].includes(readGone.status),'deletion_report_hidden');
  const direct = await separate.from('chats').select('id').eq('id',owner.chatId);
  check(Boolean(direct.error) || direct.data.length === 0,'deletion_old_jwt_rows_hidden');
  const reinsert = await separate.from('chats').insert({user_id:owner.id,title:'합성 재시도'});
  check(Boolean(reinsert.error),'deletion_old_jwt_write_blocked');
  const file = await separate.storage.from('analysis-uploads').download(owner.upload.path,{cacheNonce:randomUUID()});
  check(Boolean(file.error),'deletion_private_file_hidden');
  const denied = await peer.client.rpc('deletion_work',{p_receipt:receiptId});
  check(Boolean(denied.error),'deletion_service_only');
  await finishTestDeletion(config,receiptId,check,requestApi);
  const status = await post('receipt',{receiptId},{});
  check(status.ok && status.headers.get('cache-control')?.includes('no-store'),'deletion_public_receipt');
  const receipt = await status.json();
  check(receipt.status === 'live_deleted' && receipt.backup.status === 'unverified' && typeof receipt.completedAt === 'string'
    && !('ownerId' in receipt) && !('paths' in receipt),'deletion_receipt_completion');
  const removed = await admin.auth.admin.getUserById(owner.id);
  check(removed.error?.status === 404,'deletion_auth_gone');
  const refreshed = await separate.auth.refreshSession({refresh_token:identity.refresh_token});
  check(Boolean(refreshed.error),'deletion_new_token_rejected');
  const peerRows = result(await peer.client.from('analyses').select('id').eq('id',peer.analysisId),'deletion_peer_analyses');
  check(peerRows.length === 1,'deletion_peer_unchanged');
}

async function accept(reply, owner, check) {
  const receipt = await reply.json();
  check(reply.status === 202 && receipt.scope === 'account' && receipt.status === 'processing' &&
    typeof receipt.receiptId === 'string','deletion_account_accepted');
  // 이후 파일은 삭제 대기열이 소유한다. 중단 시에도 이 접수번호만 재시도한다.
  owner.deletionReceipt = receipt.receiptId;
  owner.upload.finalized = true;
  return receipt.receiptId;
}

async function submitFromBrowser(owner, port, dbOrigin, check) {
  const {chromium} = await import('playwright-core');
  const origin = 'http://127.0.0.1:' + port;
  const executablePath = process.env.CHROME_BIN || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
  const browser = await chromium.launch({executablePath, headless:true});
  let step = 'sign_in';
  try {
    const context = await browser.newContext({viewport:{width:390,height:844}});
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return [origin,dbOrigin].includes(url.origin) || url.protocol === 'data:' ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(18000);
    await page.goto(origin + '/#privacy');
    await page.locator('[data-action=auth]:visible').first().click();
    await page.fill('#auth-email',owner.email);
    await page.fill('#auth-password',owner.password);
    await page.click('#auth-form [type=submit]');
    step = 'review';
    await page.click('[data-privacy=select-scope][data-scope=account]');
    await page.click('[data-privacy=open-confirm]');
    await page.fill('#privacy-account-phrase','계정 삭제');
    const response = page.waitForResponse(r => r.url() === origin + '/api/v1/privacy/requests' && r.request().method() === 'POST');
    await page.click('[data-privacy=confirm-delete]');
    step = 'receipt';
    const reply = await response;
    const id = await accept({status:reply.status(),json:()=>reply.json()},owner,check);
    await page.locator('#privacy-account-receipt article[data-receipt-id="' + id + '"]').waitFor();
    check(await page.locator('[data-privacy=select-scope]').count() === 0,'deletion_browser_signed_out');
    return id;
  } catch {
    check(false,'deletion_browser_' + step);
  } finally {
    await browser.close();
  }
}

export async function finishTestDeletion(config, receiptId, check, requestApi) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const { stdout } = await execute('python3',['-B','scripts/process_data_deletion.py','--once','--receipt',receiptId],{
      cwd:new URL('../',import.meta.url), timeout:45000, maxBuffer:4096,
      env:{ PATH:process.env.PATH, APP_ENV:'development', SUPABASE_URL:config.origin, SUPABASE_WORKER_KEY:config.service },
    });
    const {status} = JSON.parse(stdout);
    if (status === 'live_deleted') return;
    check(status === 'processing' || status === 'idle','deletion_scoped_worker');
    if (status === 'idle') {
      // 같은 접수를 다른 개발 작업자가 인수했을 수 있다. 공개 상태가 완료일 때만 종료한다.
      const reply = await requestApi('/api/v1/privacy/receipt', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({receiptId}),
      });
      check(reply.ok, 'deletion_scoped_receipt');
      if ((await reply.json()).status === 'live_deleted') return;
    }
    await sleep(250);
  }
  check(false,'deletion_worker_deadline');
}
