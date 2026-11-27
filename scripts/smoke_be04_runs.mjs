// BE-03에서 만든 두 계정과 캡처를 사용해 실행 API와 작업자 RPC를 검수한다.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, promisify } from 'node:util';

const ROOT = new URL('../', import.meta.url);
const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SYNTHETIC = { kind: 'synthetic', fixture: 'ingestion-v0' };
const SNAPSHOTS = 'analysis_input_snapshots';
const LEASE_SECONDS = 60;
const SHORT_LEASE_SECONDS = 1;

function submit(account, input, key = randomUUID()) {
  return { account, method: 'POST', key, body: { input } };
}

function cancel(account, runId) {
  return { account, runId, method: 'POST', cancel: true };
}

function readComparison(requestApi, account, runId, analysisId = account.analysisId) {
  return requestApi(`/api/v1/analyses/${analysisId}/runs/${runId}/result`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
  });
}

function requestRun(requestApi, { account, analysisId = account.analysisId, runId, method = 'GET',
  cancel = false, key, body, authorized = true }) {
  const route = `/api/v1/analyses/${analysisId}/runs${runId ? `/${runId}` : ''}${cancel ? '/cancel' : ''}`;
  const headers = new Headers();
  if (authorized) headers.set('Authorization', `Bearer ${account.accessToken}`);
  if (key) headers.set('Idempotency-Key', key);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return requestApi(route, { method, headers, body: JSON.stringify(body) });
}

async function readRunResponse(reply, check, step, status) {
  check(reply.status === status, `${step}_status`);
  let data;
  try {
    data = await reply.json();
  } catch {
    check(false, `${step}_json`);
  }
  if (status >= 400) {
    check(typeof data?.error === 'string' && UUID.test(data.requestId) && Object.keys(data).length === 2,
      `${step}_error`);
  }
  return data;
}

async function concurrent(first, second) {
  // 한 요청이 실패해도 다른 요청까지 끝난 뒤 계정 정리를 시작한다.
  const replies = await Promise.allSettled([first, second]);
  for (const reply of replies) {
    if (reply.status === 'rejected') throw reply.reason;
  }
  return replies.map(reply => reply.value);
}

function checkOperation(check, operation, { analysisId, status, input, runId = operation?.runId, snapshotId = null }, step) {
  const isTerminal = ['finished', 'failed', 'cancelled'].includes(status);
  check(operation && UUID.test(operation.runId) && operation.runId === runId && operation.analysisId === analysisId
    && operation.status === status && Number.isSafeInteger(operation.attempt) && operation.attempt >= 0
    && typeof operation.submittedAt === 'string' && Number.isFinite(Date.parse(operation.submittedAt))
    && (isTerminal ? typeof operation.finishedAt === 'string' && Number.isFinite(Date.parse(operation.finishedAt))
      : operation.finishedAt === null)
    && isDeepStrictEqual(operation.input, input) && operation.snapshotId === snapshotId
    && (status === 'failed' ? typeof operation.errorCode === 'string' : operation.errorCode === null)
    && !Object.hasOwn(operation, 'leaseToken') && !Object.hasOwn(operation, 'generation')
    && operation.result?.completeness !== 'not_produced' && operation.completeness !== 'not_produced', step);
}

function claim(client, runId, check, leaseSeconds = LEASE_SECONDS) {
  // 선택 인자가 빠진 요청이 공유 개발 큐의 다른 실행을 인수할 수 있다.
  check(typeof runId === 'string' && UUID.test(runId), 'be04_claim_scope');
  return client.rpc('claim_analysis_run', { p_lease_seconds: leaseSeconds, p_run_id: runId });
}

function workerIdentity(job) {
  return { p_run_id: job.runId, p_generation: job.generation, p_lease_token: job.leaseToken };
}

function checkClaim(check, job, run, account, step) {
  check(job?.runId === run.runId && job.analysisId === account.analysisId && job.userId === account.id
    && isDeepStrictEqual(job.input, run.input) && Number.isSafeInteger(job.generation) && job.generation > 0
    && UUID.test(job.leaseToken), step);
}

function checkWorkerDenied(check, response, step) {
  check((response.status === 403 && response.error?.code === '42501')
    || (response.status === 404 && response.error?.code === 'PGRST202'), step);
}

function checkStale(check, response, step, deleted = false) {
  check((response.status === 409 && response.error?.code === 'PT409')
    || (deleted && response.status === 404 && response.error?.code === 'PT404'), step);
}

export async function workerOnce(config, runId, check, step) {
  check(typeof runId === 'string' && UUID.test(runId), 'be04_worker_scope');
  let output;
  try {
    const { stdout } = await execFileAsync('python3', [
      'scripts/run_analysis_worker.py', '--once', '--run-id', runId,
    ], {
      cwd: ROOT, encoding: 'utf8', timeout: 45_000, maxBuffer: 4096,
      env: {
        PATH: process.env.PATH, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1',
        APP_ENV: 'development', SUPABASE_URL: config.origin, SUPABASE_WORKER_KEY: config.service,
      },
    });
    output = JSON.parse(stdout);
  } catch {
    check(false, `${step}_cli`);
  }
  return output;
}

async function checkComparisonConversation({ requestApi, config, owner, other, saved, check, freshToken }) {
  const base = '/api/v1/analyses/' + owner.analysisId + '/runs/' + saved.runId + '/conversation';
  async function chat(token, path, body, status) {
    const reply = await requestApi(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return readRunResponse(reply, check, 'comparison_chat', status);
  }
  const ask = { requestId: randomUUID(), message: '왜 이 거래만 포함됐어?' };
  const question = await chat(owner.accessToken, '', ask, 200);
  check(question.turns.length === 1 && question.turns[0].answer.includes('매매 1건'), 'chat_grounded_counts');
  await chat(other.accessToken, '', undefined, 404);
  const change = { requestId: randomUUID(), message: '2026-10-24부터 2026-10-26까지로 바꿔줘' };
  const proposed = await chat(owner.accessToken, '', change, 200);
  const pending = proposed.turns.at(-1);
  check(pending?.proposal?.status === 'pending' && pending.proposal.resultRunId === null, 'chat_not_applied_yet');
  check(isDeepStrictEqual(proposed, await chat(owner.accessToken, '', change, 200)), 'chat_submit_idempotent');
  const decision = '/' + pending.id + '/decision';
  await chat(other.accessToken, decision, { decision: 'approve' }, 404);
  const [approved, retried] = await concurrent(
    chat(owner.accessToken, decision, { decision: 'approve' }, 200),
    chat(owner.accessToken, decision, { decision: 'approve' }, 200),
  );
  const rerunId = approved.turns.at(-1)?.proposal?.resultRunId;
  check(UUID.test(rerunId) && rerunId !== saved.runId && isDeepStrictEqual(approved, retried), 'chat_one_approved_run');
  const outcome = await workerOnce(config, rerunId, check, 'chat_recalculate');
  check(outcome?.status === 'finished' && outcome.snapshotId === saved.snapshotId, 'chat_same_capture');
  const relogged = { ...owner, accessToken: await freshToken(owner) };
  const history = await readRunResponse(await requestApi('/api/v1/analyses/' + owner.analysisId + '/runs/' + rerunId + '/conversation',
    { headers: { Authorization: 'Bearer ' + relogged.accessToken } }), check, 'chat_parent_navigation', 200);
  check(history.previousRunId === saved.runId, 'chat_reopened_previous_link');
  const updated = await readRunResponse(await readComparison(requestApi, relogged, rerunId), check, 'chat_changed_result', 200);
  const p = updated.result.conditions.period;
  check(p.source === 'user_confirmed' && p.start === '2026-10-24' && p.end === '2026-10-26'
    && isDeepStrictEqual(updated.result.comparables.map(c => c.complexId), ['comparison-b'])
    && updated.result.comparables[0].tradeStats.presale_right.count === 1
    && updated.result.comparables[0].tradeStats.occupancy_right.count === 1, 'chat_inclusive_subset');
  check(isDeepStrictEqual(saved, await readRunResponse(await readComparison(requestApi, relogged, saved.runId),
    check, 'chat_original_result', 200)), 'chat_original_unchanged');
  check(isDeepStrictEqual(approved, await chat(relogged.accessToken, '', undefined, 200)), 'chat_reopen_history');
}

async function checkCaptureIds(account, ids, check, result, step) {
  const rows = result(await account.client.from(SNAPSHOTS).select('id').eq('analysis_id', account.analysisId), `${step}_read`);
  check(rows.length === ids.length && isDeepStrictEqual(new Set(rows.map(row => row.id)), new Set(ids)), step);
}

async function checkRunCapture(owner, operation, capture, check, result, step) {
  const rows = result(await owner.client.from(SNAPSHOTS)
    .select('id,user_id,analysis_id,capture_key,input_snapshot,result_snapshot')
    .eq('analysis_id', owner.analysisId).eq('capture_key', operation.runId), `${step}_read`);
  check(rows.length === (operation.snapshotId === null ? 0 : 1), `${step}_count`);
  if (!rows.length) return;
  const [snapshot] = rows;
  check(snapshot.id === operation.snapshotId && snapshot.user_id === owner.id
    && snapshot.analysis_id === owner.analysisId && snapshot.capture_key === operation.runId
    && isDeepStrictEqual(snapshot.input_snapshot, capture.input)
    && isDeepStrictEqual(snapshot.result_snapshot, capture.original), `${step}_content`);
}

async function checkSyntheticCapture(owner, other, operation, capture, check, result) {
  await checkRunCapture(owner, operation, capture, check, result, 'be04_capture');
  const peerRows = result(await other.client.from(SNAPSHOTS).select('id')
    .in('id', [operation.snapshotId, other.snapshotId]), 'be04_capture_foreign_read');
  check(peerRows.length === 1 && peerRows[0].id === other.snapshotId, 'be04_capture_owner_isolation');
}

async function checkRunIsolation(api, owner, other, side, runId, check) {
  const missing = await api('be04_missing_run', 404, { account: owner, runId: randomUUID() });
  const foreign = await api('be04_foreign_run', 404, { account: other, analysisId: owner.analysisId, runId });
  const different = await api('be04_different_analysis_run', 404, { account: side, runId });
  check(foreign.error === missing.error && different.error === missing.error, 'be04_run_404_equivalence');

  await api('be04_foreign_cancel', 404, { ...cancel(other, runId), analysisId: owner.analysisId });
  await api('be04_different_analysis_cancel', 404, cancel(side, runId));
  await api('be04_foreign_submit', 404, { ...submit(other, SYNTHETIC), analysisId: owner.analysisId });
  await api('be04_foreign_snapshot_submit', 404, submit(owner, { kind: 'snapshot', snapshotId: other.snapshotId }));
  await api('be04_different_analysis_snapshot_submit', 404, submit(side, { kind: 'snapshot', snapshotId: owner.snapshotId }));
}

async function checkLeaseRecovery(api, admin, owner, check, result) {
  const input = { kind: 'snapshot', snapshotId: owner.snapshotId };
  const queued = await api('be04_recovery_submit', 202, submit(owner, input));
  checkOperation(check, queued, { analysisId: owner.analysisId, status: 'queued', input }, 'be04_recovery_queued');
  const { runId } = queued;
  const oldJob = result(await claim(admin, runId, check, SHORT_LEASE_SECONDS), 'be04_old_claim');
  checkClaim(check, oldJob, queued, owner, 'be04_old_claim_identity');
  const oldWorker = workerIdentity(oldJob);
  const oldFinish = { ...oldWorker, p_input: null, p_result: null };
  const running = await api('be04_old_running', 200, { account: owner, runId });
  checkOperation(check, running, { analysisId: owner.analysisId, runId, status: 'running', input }, 'be04_old_running_shape');

  // 첫 작업자가 갱신 없이 중단한 뒤, 실제 Postgres 임대가 끝나기를 기다린다.
  await delay(SHORT_LEASE_SECONDS * 1000 + 100);
  checkStale(check, await admin.rpc('finish_analysis_run', oldFinish), 'be04_expired_finish');
  const job = result(await claim(admin, runId, check), 'be04_reclaim');
  checkClaim(check, job, queued, owner, 'be04_reclaim_identity');
  check(job.generation > oldJob.generation && job.leaseToken !== oldJob.leaseToken, 'be04_reclaim_fencing');
  const reclaimed = await api('be04_reclaimed_running', 200, { account: owner, runId });
  checkOperation(check, reclaimed, { analysisId: owner.analysisId, runId, status: 'running', input }, 'be04_reclaimed_shape');
  check(running.attempt > queued.attempt && reclaimed.attempt > running.attempt, 'be04_reclaimed_attempt');

  const identity = workerIdentity(job);
  const renew = { ...identity, p_lease_seconds: LEASE_SECONDS };
  const finish = { ...identity, p_input: null, p_result: null };
  const fail = { ...identity, p_retryable: true };
  checkWorkerDenied(check, await owner.client.rpc('renew_analysis_run', renew), 'be04_renew_service_only');
  checkWorkerDenied(check, await owner.client.rpc('finish_analysis_run', finish), 'be04_finish_service_only');
  checkWorkerDenied(check, await owner.client.rpc('fail_analysis_run', fail), 'be04_fail_service_only');
  result(await admin.rpc('renew_analysis_run', renew), 'be04_current_renew');
  checkStale(check, await admin.rpc('renew_analysis_run', { ...oldWorker, p_lease_seconds: LEASE_SECONDS }), 'be04_stale_renew');
  checkStale(check, await admin.rpc('finish_analysis_run', oldFinish), 'be04_stale_finish');
  checkStale(check, await admin.rpc('finish_analysis_run', { ...finish, p_generation: oldJob.generation }), 'be04_stale_generation');
  checkStale(check, await admin.rpc('finish_analysis_run', { ...finish, p_lease_token: oldJob.leaseToken }), 'be04_stale_token');
  result(await admin.rpc('finish_analysis_run', finish), 'be04_current_finish');

  const finished = await api('be04_reused_snapshot', 200, { account: owner, runId });
  checkOperation(check, finished, { analysisId: owner.analysisId, runId, status: 'finished', input,
    snapshotId: owner.snapshotId }, 'be04_reused_snapshot_shape');
  await api('be04_finished_cancel_conflict', 409, cancel(owner, runId));
}

async function checkCancelledAndDeleted(api, admin, owner, side, capture, check, result) {
  const queued = await api('be04_cancel_submit', 202, submit(owner, SYNTHETIC));
  checkOperation(check, queued, { analysisId: owner.analysisId, status: 'queued', input: SYNTHETIC }, 'be04_cancel_queued');
  const { runId } = queued;
  const job = result(await claim(admin, runId, check), 'be04_cancel_claim');
  checkClaim(check, job, queued, owner, 'be04_cancel_claim_identity');
  const request = cancel(owner, runId);
  await api('be04_cancel_body', 400, { ...request, body: {} });
  const cancelled = await api('be04_cancel_running', 200, request);
  checkOperation(check, cancelled, { analysisId: owner.analysisId, runId, status: 'cancelled', input: SYNTHETIC },
    'be04_cancelled_shape');
  const repeated = await api('be04_cancel_repeat', 200, request);
  check(isDeepStrictEqual(repeated, cancelled), 'be04_cancel_idempotent');
  checkStale(check, await admin.rpc('finish_analysis_run', {
    ...workerIdentity(job), p_input: capture.input, p_result: capture.original,
  }), 'be04_cancelled_finish');
  checkStale(check, await admin.rpc('renew_analysis_run', {
    ...workerIdentity(job), p_lease_seconds: LEASE_SECONDS,
  }), 'be04_cancelled_renew');
  check(result(await claim(admin, runId, check), 'be04_cancelled_reclaim') === null, 'be04_cancelled_unclaimable');

  const removable = await api('be04_delete_submit', 202, submit(side, SYNTHETIC));
  checkOperation(check, removable, { analysisId: side.analysisId, status: 'queued', input: SYNTHETIC }, 'be04_delete_queued');
  const pending = result(await claim(admin, removable.runId, check), 'be04_delete_claim');
  checkClaim(check, pending, removable, side, 'be04_delete_claim_identity');
  const removed = result(await admin.from('analyses').delete().eq('id', side.analysisId).eq('user_id', side.id)
    .select('id,user_id').single(), 'be04_delete_parent');
  check(removed?.id === side.analysisId && removed.user_id === side.id, 'be04_delete_parent_identity');
  await api('be04_deleted_read', 404, { account: side, runId: removable.runId });
  await api('be04_deleted_cancel', 404, cancel(side, removable.runId));
  await api('be04_deleted_submit', 404, submit(side, SYNTHETIC));
  checkStale(check, await admin.rpc('finish_analysis_run', {
    ...workerIdentity(pending), p_input: capture.input, p_result: capture.original,
  }), 'be04_deleted_finish', true);
  checkStale(check, await admin.rpc('fail_analysis_run', {
    ...workerIdentity(pending), p_retryable: true,
  }), 'be04_deleted_fail', true);
  check(result(await claim(admin, removable.runId, check), 'be04_deleted_reclaim') === null, 'be04_deleted_unclaimable');
  const captures = result(await admin.from(SNAPSHOTS).select('id')
    .eq('analysis_id', side.analysisId).eq('user_id', side.id), 'be04_deleted_capture_read');
  check(captures.length === 0, 'be04_deleted_no_capture');
}

async function checkFailures(api, admin, owner, check, result) {
  for (const [retryable, status] of [[true, 'retry_wait'], [false, 'failed']]) {
    const step = `be04_${status}`;
    const queued = await api(`${step}_submit`, 202, submit(owner, SYNTHETIC));
    checkOperation(check, queued, { analysisId: owner.analysisId, status: 'queued', input: SYNTHETIC }, `${step}_queued`);
    const { runId } = queued;
    const job = result(await claim(admin, runId, check), `${step}_claim`);
    checkClaim(check, job, queued, owner, `${step}_identity`);
    result(await admin.rpc('fail_analysis_run', { ...workerIdentity(job), p_retryable: retryable }), `${step}_fail`);
    const operation = await api(`${step}_read`, 200, { account: owner, runId });
    checkOperation(check, operation, { analysisId: owner.analysisId, runId, status, input: SYNTHETIC }, `${step}_shape`);
    await api(`${step}_cancel`, retryable ? 200 : 409, cancel(owner, runId));
    check(result(await claim(admin, runId, check), `${step}_reclaim`) === null, `${step}_unclaimable`);
  }
}

async function checkConcurrentTerminal({ api, requestApi, admin, secondWorker, account, capture, check, result }) {
  const queued = await api('be04_race_submit', 202, submit(account, SYNTHETIC));
  checkOperation(check, queued, { analysisId: account.analysisId, status: 'queued', input: SYNTHETIC }, 'be04_race_queued');
  const { runId } = queued;
  const claims = await concurrent(claim(admin, runId, check), claim(secondWorker, runId, check));
  const jobs = claims.map(reply => result(reply, 'be04_race_claim'));
  check(jobs.filter(job => job === null).length === 1, 'be04_race_single_claim');
  const job = jobs.find(job => job !== null);
  checkClaim(check, job, queued, account, 'be04_race_claim_identity');

  // 작업자 완료와 사용자 취소를 독립 연결로 보내고 실제 종료값과 저장 내역을 대조한다.
  const finish = { ...workerIdentity(job), p_input: capture.input, p_result: capture.original };
  const [finishReply, cancelReply] = await concurrent(
    admin.rpc('finish_analysis_run', finish), requestRun(requestApi, cancel(account, runId)),
  );
  const read = { account, runId };
  const final = await api('be04_race_read', 200, read);
  const expected = { analysisId: account.analysisId, runId, input: SYNTHETIC };
  if (final?.status === 'finished') {
    const saved = result(finishReply, 'be04_race_finish');
    check(finishReply.status === 200 && UUID.test(saved?.snapshotId), 'be04_race_finish_response');
    checkOperation(check, final, { ...expected, status: 'finished', snapshotId: saved.snapshotId }, 'be04_race_finished_shape');
    check(isDeepStrictEqual(saved, final), 'be04_race_finish_same_operation');
    await readRunResponse(cancelReply, check, 'be04_race_cancel_conflict', 409);
  } else {
    checkOperation(check, final, { ...expected, status: 'cancelled' }, 'be04_race_cancelled_shape');
    const stopped = await readRunResponse(cancelReply, check, 'be04_race_cancel', 200);
    check(isDeepStrictEqual(stopped, final), 'be04_race_cancel_same_operation');
    checkStale(check, finishReply, 'be04_race_finish_conflict');
  }
  check(final.attempt === 1, 'be04_race_one_attempt');
  checkStale(check, await secondWorker.rpc('finish_analysis_run', finish), 'be04_race_late_finish');
  check(result(await claim(secondWorker, runId, check), 'be04_race_reclaim') === null, 'be04_race_unclaimable');
  check(isDeepStrictEqual(await api('be04_race_terminal_read', 200, read), final), 'be04_race_terminal_preserved');
  await checkRunCapture(account, final, capture, check, result, 'be04_race_capture');
}

export async function runBe04Smoke({ requestApi, admin, secondWorker, accounts, capture, config, check, result, freshToken }) {
  const [owner, other] = accounts;
  const api = async (step, status, request) => readRunResponse(await requestRun(requestApi, request), check, step, status);
  const extra = result(await owner.client.from('analyses').insert({ user_id: owner.id, chat_id: owner.chatId })
    .select('id').single(), 'be04_second_analysis');
  check(UUID.test(extra?.id), 'be04_second_analysis_identity');
  const side = { ...owner, analysisId: extra.id };

  // 먼저 접수한 다른 계정의 실행은 CLI에 지정한 실행 ID의 범위를 검증하는 데 사용한다.
  const otherInput = { kind: 'snapshot', snapshotId: other.snapshotId };
  const otherRun = await api('be04_other_submit', 202, submit(other, otherInput));
  checkOperation(check, otherRun, { analysisId: other.analysisId, status: 'queued', input: otherInput }, 'be04_other_queued');
  const request = submit(owner, SYNTHETIC);
  await api('be04_unauthenticated', 401, { ...request, authorized: false });
  await api('be04_bad_idempotency_key', 400, { ...request, key: 'synthetic-invalid-uuid' });
  await api('be04_bad_input', 400, submit(owner, { kind: 'synthetic', fixture: 'tests/fixtures/ingestion-v0.json' }));
  const [queued, retry] = await concurrent(
    api('be04_parallel_submit', 202, request), api('be04_parallel_retry', 202, request),
  );
  const { runId } = queued;
  const expected = { analysisId: owner.analysisId, runId, status: 'queued', input: SYNTHETIC };
  checkOperation(check, queued, expected, 'be04_submitted_shape');
  const waiting = await readRunResponse(await readComparison(requestApi, owner, runId), check, 'be05_pending', 409);
  check(waiting.error === 'comparison_not_available', 'be05_pending_reason');
  check(queued.attempt === 0 && isDeepStrictEqual(queued, retry), 'be04_parallel_identity');
  await api('be04_idempotency_conflict', 409, submit(owner, { kind: 'snapshot', snapshotId: owner.snapshotId }, request.key));
  await checkRunIsolation(api, owner, other, side, runId, check);
  checkOperation(check, await api('be04_queued_read', 200, { account: owner, runId }), expected, 'be04_queued_shape');
  checkWorkerDenied(check, await claim(owner.client, runId, check), 'be04_claim_service_only');

  const outcome = await workerOnce(config, runId, check, 'be04_synthetic');
  check(outcome?.status === 'finished' && outcome.runId === runId && UUID.test(outcome.snapshotId), 'be04_synthetic_cli_result');
  const finished = await api('be04_synthetic_finished', 200, { account: owner, runId });
  checkOperation(check, finished, { ...expected, status: 'finished', snapshotId: outcome.snapshotId }, 'be04_synthetic_finished_shape');
  await checkSyntheticCapture(owner, other, finished, capture, check, result);
  const saved = await readRunResponse(await readComparison(requestApi, owner, runId), check, 'be05_result', 200);
  check(saved.runId === runId && saved.analysisId === owner.analysisId && saved.snapshotId === finished.snapshotId
    && saved.result?.contractVersion === 'comparison/v1' && saved.result.dataOrigin === 'synthetic'
    && saved.result.appliedScope === 'priority' && saved.result.completeness === 'complete'
    && isDeepStrictEqual(saved.result.comparables.map(item => item.complexId), ['comparison-a', 'comparison-b'])
    && saved.result.noticePrice.minWon === '710000000'
    && saved.result.comparables[0].tradeStats.sale.medianWon === '515000000'
    && saved.result.comparables[1].tradeStats.presale_right.medianWon === '405000000'
    && saved.result.comparables[1].tradeStats.occupancy_right.medianWon === '486000000', 'be05_demo_comparison');
  await readRunResponse(await readComparison(requestApi, other, runId, owner.analysisId), check, 'be05_foreign_result', 404);
  const reusedInput = { kind: 'snapshot', snapshotId: finished.snapshotId };
  const pinned = await api('be05_reuse_submit', 202, submit(owner, reusedInput));
  await workerOnce(config, pinned.runId, check, 'be05_reuse');
  const restored = await readRunResponse(await readComparison(requestApi, owner, pinned.runId), check, 'be05_reuse_read', 200);
  check(restored.snapshotId === saved.snapshotId && restored.runId === pinned.runId
    && isDeepStrictEqual(saved.result, restored.result), 'be05_same_inputs_same_comparison');
  await checkComparisonConversation({ requestApi, config, owner, other, saved: restored, check, freshToken });
  const currentReplay = await api('be04_finished_replay', 202, request);
  check(isDeepStrictEqual(currentReplay, finished), 'be04_replay_current_state');
  const idle = await workerOnce(config, runId, check, 'be04_repeat');
  check(idle?.status === 'idle', 'be04_repeat_cli_idle');
  await checkCaptureIds(owner, [owner.snapshotId, finished.snapshotId], check, result, 'be04_single_synthetic_capture');

  const otherQueued = await api('be04_other_still_queued', 200, { account: other, runId: otherRun.runId });
  check(isDeepStrictEqual(otherQueued, otherRun), 'be04_scoped_claim');
  const reused = await workerOnce(config, otherRun.runId, check, 'be04_snapshot');
  check(reused?.status === 'finished' && reused.runId === otherRun.runId && reused.snapshotId === other.snapshotId,
    'be04_snapshot_cli_result');
  const otherFinished = await api('be04_snapshot_finished', 200, { account: other, runId: otherRun.runId });
  checkOperation(check, otherFinished, { analysisId: other.analysisId, runId: otherRun.runId, status: 'finished',
    input: otherInput, snapshotId: other.snapshotId }, 'be04_snapshot_finished_shape');
  await checkCaptureIds(other, [other.snapshotId], check, result, 'be04_existing_snapshot_only');
  const withoutEvidence = await readRunResponse(
    await readComparison(requestApi, other, otherRun.runId), check, 'be05_no_evidence', 200);
  check(withoutEvidence.snapshotId === other.snapshotId && withoutEvidence.result?.appliedScope === null
    && withoutEvidence.result.comparables.length === 0 && withoutEvidence.result.holds.length > 0,
  'be05_no_evidence_stays_held');

  await checkLeaseRecovery(api, admin, owner, check, result);
  await checkFailures(api, admin, owner, check, result);
  await checkConcurrentTerminal({ api, requestApi, admin, secondWorker, account: side, capture, check, result });
  await checkCancelledAndDeleted(api, admin, owner, side, capture, check, result);
  await checkCaptureIds(owner, [owner.snapshotId, finished.snapshotId], check, result, 'be04_terminal_capture_count');
  return withoutEvidence;
}

export async function checkBe04Cleanup(admin, accounts, check, result) {
  if (!accounts.length) return;
  for (const table of ['analyses', SNAPSHOTS]) {
    const remaining = result(await admin.from(table).select('id').in('user_id', accounts.map(account => account.id)),
      'be04_cleanup_read');
    check(remaining.length === 0, 'be04_cleanup_cascade');
  }
}
