// 두 시험 계정의 실제 세션으로 합성 납부 일정의 저장, 재계산, 소유권을 검사한다.
import { randomUUID } from 'node:crypto';

const modelNo = '01';
const room = '101동 101호';

function schedule(item, totalWon, deposit, balance, page) {
  const evidence = [{ document: 'synthetic-notice-pdf', version: 'synthetic-v1', page }];
  const installment = (stage, won, date) => ({
    stage, won, timing: { trigger: 'calendar_date', dateStatus: 'exact', date, evidence },
  });
  return {
    modelNo, houseType: '084.0000A', room, item, status: 'confirmed', totalWon, reasons: [], evidence,
    installments: [installment('deposit', deposit, '2026-10-20'), installment('balance', balance, '2026-11-30')],
  };
}

export async function checkFundingPlan({ admin, accounts, capture, requestApi, check, result }) {
  const [owner, peer] = accounts;
  const target = { ...capture.input.target, noticeSource: capture.input.noticeSource };
  const analysis = result(await owner.client.from('analyses').insert({
    user_id: owner.id, chat_id: owner.chatId,
    conditions_snapshot: { ingestion_target: target, comparison: { modelNo, room } },
  }).select('id').single(), 'be08_analysis');
  const base = { user_id: owner.id, analysis_id: analysis.id };
  const entries = result(await owner.client.from('funding_entries').insert([
    { ...base, kind: 'current', certainty: 'confirmed', amount_won: '50000000', available_on: '2026-10-01' },
    { ...base, kind: 'additional', certainty: 'expected', amount_won: '4000000', available_on: '2026-10-20' },
    { ...base, kind: 'additional', certainty: 'confirmed', amount_won: '100000000', available_on: '2026-11-05' },
  ]).select('id,certainty'), 'be08_enter_funds');
  const expectedId = entries.find((entry) => entry.certainty === 'expected')?.id;
  check(typeof expectedId === 'string', 'be08_expected_fund_identity');

  const payload = {
    p_user_id: owner.id, p_analysis_id: analysis.id, p_capture_key: randomUUID(), p_input: capture.input,
    p_result: capture.original, p_schedules: [
      schedule('sale_price', '700000000', '70000000', '630000000', 7),
      schedule('required_options', '10000000', '1000000', '9000000', 8),
    ],
  };
  const save = () => admin.rpc('save_funding_schedule_snapshot', payload);
  const snapshotId = result(await save(), 'be08_snapshot');
  check(result(await save(), 'be08_snapshot_retry') === snapshotId, 'be08_snapshot_idempotent');
  const route = `/api/v1/analyses/${analysis.id}/funding-plan`;
  const read = (account, selected = snapshotId) => requestApi(route, {
    method: 'POST', headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshotId: selected, modelNo, room }),
  });
  const response = await read(owner);
  check(response.status === 200 && response.headers.get('cache-control') === 'private, no-store', 'be08_read');
  const plan = await response.json();
  check(plan.contractVersion === 'funding-plan/v1' && plan.dataOrigin === 'synthetic'
    && plan.status === 'complete' && plan.selection.snapshotId === snapshotId, 'be08_version');
  const [deposit, balance] = plan.rows;
  check(plan.assumptions.sameDayTiming === 'before_and_after_incoming_funds' && plan.requiredTotalWon === '710000000'
    && deposit.date === '2026-10-20' && deposit.knownDueWon === '71000000'
    && deposit.scenarios.confirmedOnly.beforeIncomingFunds.shortfallWon === '21000000'
    && deposit.scenarios.confirmedOnly.afterIncomingFunds.shortfallWon === '21000000'
    && deposit.scenarios.includingExpected.beforeIncomingFunds.shortfallWon === '21000000'
    && deposit.scenarios.includingExpected.afterIncomingFunds.shortfallWon === '17000000', 'be08_deposit');
  check(balance.date === '2026-11-30' && balance.knownCumulativeDueWon === '710000000'
    && balance.scenarios.confirmedOnly.afterIncomingFunds.shortfallWon === '560000000'
    && balance.scenarios.includingExpected.afterIncomingFunds.shortfallWon === '556000000', 'be08_balance');
  check((await read(peer)).status === 404 && (await read(owner, peer.snapshotId)).status === 404, 'be08_isolation');
  // 같은 키로 읽었을 때 자금 입력의 수정이 반영돼야 한다. 공고/PDF의 수집을 다시 시작하지 않는다.
  result(await owner.client.from('funding_entries').update({ amount_won: '5000000' }).eq('id', expectedId), 'be08_update');
  const changed = await read(owner);
  check(changed.status === 200, 'be08_recalculate_status');
  const update = await changed.json();
  check(update.selection.snapshotId === snapshotId
    && update.rows[0].scenarios.includingExpected.beforeIncomingFunds.shortfallWon === '21000000'
    && update.rows[0].scenarios.includingExpected.afterIncomingFunds.shortfallWon === '16000000'
    && update.rows[0].scenarios.confirmedOnly.afterIncomingFunds.shortfallWon === '21000000', 'be08_recalculation');
  return { analysisId: analysis.id, snapshotId };
}
