import * as api from './client.js';
import { esc, icon, won, dateText, isoDate, errorText, reasonText } from './display.js';
import { amountInput, evidence, planningReasons } from './planning-fields.js';

const items = { sale_price: '분양대금', required_options: '필수 옵션' };
const stages = { deposit: '계약금', interim: '중도금', balance: '잔금' };
const statusText = {
  unavailable: '이 수집본에 확인된 납부 일정이 없습니다.',
  selection_unverified: '공고와 호실의 대응을 확인해야 합니다.',
  source_restricted: '현재 출처 권한으로 납부 일정을 표시할 수 없습니다.',
};
const reasons = (list) =>
  [
    ...new Set(
      (list ?? []).map(
        (code) => planningReasons[code] || reasonText(code) || '공고문 추가 확인이 필요합니다.',
      ),
    ),
  ].join(' ');
const amount = (v) => (v == null ? '미확인' : won(v));
const flag = (value, other) => (value === other ? ' selected' : '');
const newDraft = (kind) => ({
  kind,
  amountWon: '',
  availableOn: '',
  certainty: 'confirmed',
  requestKey: crypto.randomUUID(),
});
function sourceAmount(component) {
  return `<section class="component"><div><h3>${items[component.item]}</h3><strong>${esc(amount(component.totalWon))}</strong></div>
    ${component.status !== 'confirmed' ? `<p class="field-help">${esc(reasons(component.reasons) || '이 항목의 공식 납부 근거가 필요합니다.')}</p>` : ''}
    ${evidence(component.evidence, items[component.item] + ' 근거')}
    ${component.installments.length ? `<details class="payment-parts"><summary>납부 항목 ${component.installments.length}건</summary>${component.installments.map(paymentLine).join('')}</details>` : ''}</section>`;
}
function paymentLine(p) {
  const t = p.timing;
  const when = t.date
    ? dateText(t.date)
    : { contract_signing: '계약 시', move_in: '입주 시' }[t.trigger] || '정확한 날짜 미확인';
  return `<div class="payment-line"><div>${esc(items[p.item])} · ${esc(stages[p.stage])}<small>${esc(when)}</small></div><div>${esc(amount(p.won))}${evidence(t.evidence, '납부일 근거')}</div></div>`;
}
function checkpoint(label, cp) {
  return `<div class="checkpoint"><span>${label} 부족액</span><strong>${cp.shortfallWon == null ? '판정 보류' : esc(won(cp.shortfallWon))}</strong>
    <small>가용 자금 ${esc(amount(cp.fundsWon))}</small>${cp.holdReasons.length ? `<p>${esc(reasons(cp.holdReasons))}</p>` : ''}</div>`;
}
function timeline(plan, scenario) {
  if (plan.scheduleStatus !== 'available')
    return `<div class="planning-box plan-empty">${icon('calendar-clock')}<h2>납부 일정 확인 필요</h2><p>${esc(statusText[plan.scheduleStatus])}</p></div>`;
  return `<div class="fund-total"><div><p>분양대금 + 필수 옵션</p><h2>${plan.requiredTotalWon == null ? '합계 확인 필요' : esc(won(plan.requiredTotalWon))}</h2></div>
    <div>${plan.requiredTotalWon == null && plan.knownRequiredTotalWon != null ? `<p>확인한 항목 ${esc(won(plan.knownRequiredTotalWon))}</p>` : ''}<small>세금·금융비용 제외</small></div></div>
    ${plan.subtotalHoldReasons.length ? `<p class="hold-note">${esc(reasons(plan.subtotalHoldReasons))}</p>` : ''}
    <div class="component-grid">${plan.components.map(sourceAmount).join('')}</div>
    <section class="planning-box schedule-box"><div class="box-heading">${icon('calendar-days')}<h2>날짜별 납부와 부족액</h2></div>
    <div class="scenario-switch" role="group" data-choice-group aria-label="자금 계산 시나리오">${[
      ['confirmedOnly', '확정 자금만'],
      ['includingExpected', '예상 자금 포함'],
    ]
      .map(
        ([key, label]) =>
          `<button data-fund-scenario="${key}" aria-pressed="${scenario === key}" tabindex="${scenario === key ? 0 : -1}">${label}</button>`,
      )
      .join('')}</div>
    ${
      plan.rows
        .map(
          (
            row,
          ) => `<article class="fund-day"><div class="fund-day-top"><div><time datetime="${esc(row.date)}">${esc(dateText(row.date))}</time><small>${esc([...new Set(row.installments.map((p) => stages[p.stage]))].join(' · ') || '자금 변동일')}</small></div><div><small>확인 납부액</small><strong>${esc(won(row.knownDueWon))}</strong></div></div>
      <div class="checkpoints">${checkpoint('입금 전', row.scenarios[scenario].beforeIncomingFunds)}${checkpoint('입금 후', row.scenarios[scenario].afterIncomingFunds)}</div>
      <p class="day-total">이 날까지 확인된 누적 납부액 ${esc(won(row.knownCumulativeDueWon))}</p></article>`,
        )
        .join('') || '<p class="group-empty">날짜별로 합산할 수 있는 납부 일정이 없습니다.</p>'
    }
    </section>
    ${plan.undatedInstallments.length ? `<section class="planning-box undated"><div class="box-heading">${icon('calendar-clock')}<h2>날짜 미확정 납부</h2></div>${plan.undatedInstallments.map(paymentLine).join('')}</section>` : ''}`;
}
function fundsPanel(s) {
  const d = s.draft;
  return `<aside class="planning-box personal-funds" aria-labelledby="funds-heading"><div class="box-heading">${icon('layers')}<h2 id="funds-heading" tabindex="-1">내 자금</h2></div>
    <p class="field-help">${s.ctx.guest ? '합성 예시입니다. 변경한 금액은 이 화면에서만 사용합니다.' : '이 분석에 입력한 보유 잔액과 추가 자금입니다.'}</p>
    ${
      s.fundsError
        ? `<p class="plan-error" role="alert">${esc(errorText(s.fundsError))}</p><button class="action secondary" data-fund-reload>다시 조회</button>`
        : s.funds === null
          ? '<p class="field-help">자금을 불러오는 중입니다.</p>'
          : `<div class="fund-entries">
      ${s.funds.map((f) => `<div class="fund-entry"><div><small>${f.certainty === 'expected' ? '예상' : '확정'} ${f.kind === 'current' ? '보유 잔액' : '추가 자금'}</small><strong>${esc(won(f.amountWon))}</strong><span>${esc(dateText(f.availableOn))} ${f.kind === 'current' ? '기준' : '입금'}</span></div><button class="text-action" aria-label="${esc(dateText(f.availableOn))} ${esc(won(f.amountWon))} 수정" data-fund-edit="${esc(f.id)}">수정</button></div>`).join('') || '<p class="field-help">등록된 자금이 없습니다.</p>'}</div>
      ${!d ? `<button class="action secondary wide" data-fund-new>자금 입력</button>` : ''}`
    }
    ${
      d
        ? `<form id="fund-form" novalidate><label for="fund-kind">자금 구분</label><select id="fund-kind" name="kind"><option value="current"${flag(d.kind, 'current')} ${s.funds.some((f) => f.kind === 'current' && f.id !== d.id) ? 'disabled' : ''}>보유 잔액</option><option value="additional"${flag(d.kind, 'additional')}>추가 자금</option></select>
    <label for="fund-amount">금액</label><div class="unit-input"><input id="fund-amount" name="amountWon" inputmode="numeric" value="${esc(d.amountWon)}" autocomplete="off"><span>원</span></div>
    <label for="fund-date">${d.kind === 'current' ? '잔액 기준일' : '입금일'}</label><input id="fund-date" name="availableOn" type="date" value="${esc(d.availableOn)}">
    <label for="fund-certainty">자금 확실성</label><select id="fund-certainty" name="certainty"><option value="confirmed"${flag(d.certainty, 'confirmed')}>확정</option><option value="expected"${flag(d.certainty, 'expected')}>예상</option></select>
    <div class="fund-actions"><button type="button" class="action secondary compact" data-fund-discard ${s.saving ? 'disabled' : ''}>취소</button><button type="submit" class="action primary compact" ${s.saving ? 'disabled' : ''}>${s.saving ? '저장 중' : s.ctx.guest ? '예시에 적용' : '이 분석에 저장'}</button></div></form>`
        : ''
    }
    ${s.message ? `<p class="${s.problem ? 'plan-error' : 'field-help'}" role="status">${esc(s.message)}</p>` : ''}</aside>`;
}
export function createFundingPage({ root, render }) {
  let s = {},
    generation = 0,
    readVersion = 0;
  function reset() {
    ++generation;
    ++readVersion;
    s = {};
  }
  async function fetchPlan() {
    if (!s.ctx || !s.room) return;
    const token = ++readVersion,
      { ctx, room } = s;
    s.plan = null;
    s.planError = null;
    render();
    try {
      const p = ctx.guest
        ? ctx.example.fundingExample(room, s.funds)
        : await api.readFundingPlan(ctx.analysisId, ctx.snapshotId, ctx.modelNo, room);
      if (token !== readVersion) return;
      if (
        p.contractVersion !== 'funding-plan/v1' ||
        p.dataOrigin !== ctx.origin ||
        p.selection.room !== room ||
        p.selection.modelNo !== ctx.modelNo ||
        p.selection.analysisId !== ctx.analysisId ||
        p.selection.snapshotId !== ctx.snapshotId
      )
        throw new Error('invalid funding result');
      s.plan = p;
    } catch (err) {
      if (token === readVersion) s.planError = err;
    }
    if (token === readVersion) render();
  }
  async function fetchFunds() {
    const token = generation,
      ctx = s.ctx;
    s.fundsError = null;
    try {
      const funds = ctx.guest
        ? (s.funds ?? ctx.example.sampleFunds.map((f) => ({ ...f })))
        : await api.listFunds(ctx.analysisId, ctx.ownerId);
      if (token === generation) s.funds = funds;
    } catch (err) {
      if (token === generation) {
        s.funds = null;
        s.draft = null;
        s.fundsError = err;
      }
    }
    if (token === generation) render();
  }
  async function enter(ctx) {
    reset();
    const token = generation;
    const rooms = [
      ...new Set(
        [...(ctx.price?.confirmedRooms ?? []), ...(ctx.price?.heldRooms ?? [])]
          .map((r) => r.room)
          .filter((r) => typeof r === 'string' && r.trim()),
      ),
    ];
    s = {
      ctx,
      rooms,
      room: ctx.modelNo ? (rooms[0] ?? '') : '',
      funds: null,
      scenario: 'confirmedOnly',
      draft: null,
      message: '',
      saving: false,
    };
    if (ctx.guest) {
      try {
        const example = await import('/vendor/planning-example.js');
        if (token !== generation) return;
        Object.assign(ctx, {
          example,
          analysisId: example.sampleAnalysis,
          snapshotId: example.sampleSnapshot,
        });
      } catch (err) {
        if (token === generation) {
          s.planError = s.fundsError = err;
          render();
        }
        return;
      }
      await fetchFunds();
      if (token === generation) await fetchPlan();
    } else await Promise.all([fetchFunds(), fetchPlan()]);
  }
  function view() {
    if (!s.ctx) return '<p class="planning-box plan-empty" role="status">자금표를 준비하고 있습니다.</p>';
    const { ctx } = s;
    let panel;
    if (!s.room)
      panel = `<div class="planning-box plan-empty">${icon('circle-help')}<h2>호실 확인이 필요합니다</h2><p>선택한 주택형의 공식 호실 근거가 들어오면 납부 일정을 볼 수 있습니다.</p></div>`;
    else if (s.planError)
      panel = `<div class="planning-box plan-empty"><h2>자금표를 불러올 수 없습니다</h2><p>${esc(errorText(s.planError))}</p><button class="action secondary" data-plan-reload>다시 조회</button></div>`;
    else if (!s.plan)
      panel = '<p class="planning-box plan-empty" role="status">납부 일정을 불러오는 중입니다.</p>';
    else panel = timeline(s.plan, s.scenario);
    return `<section class="section-header"><h1>호실별 자금표</h1><p>${esc(ctx.name || '선택한 공고')}${ctx.houseType ? ' · ' + esc(ctx.houseType) : ''}${ctx.guest ? ' · 합성 예시' : ctx.origin === 'synthetic' ? ' · 합성 수집본' : ''}</p><button type="button" class="text-action fund-jump" data-fund-jump>내 자금 보기 ${icon('chevron-down')}</button></section>
      <div class="fund-layout"><div class="fund-main">${s.rooms.length && ctx.modelNo ? `<div class="room-control"><label for="fund-room">납부 일정을 볼 호실</label><select id="fund-room">${s.rooms.map((r) => `<option${flag(s.room, r)}>${esc(r)}</option>`).join('')}</select></div>` : ''}${panel}</div>${fundsPanel(s)}</div>`;
  }
  root.addEventListener('change', (e) => {
    const f = e.target;
    if (!s.ctx) return;
    if (f.id === 'fund-room' && s.rooms.includes(f.value)) {
      s.room = f.value;
      void fetchPlan();
    }
    if (f.id === 'fund-kind' && s.draft) {
      s.draft.kind = f.value;
      render();
    }
  });
  root.addEventListener('input', (e) => {
    const f = e.target;
    if (
      f.form?.id === 'fund-form' &&
      s.draft &&
      ['amountWon', 'availableOn', 'kind', 'certainty'].includes(f.name)
    )
      s.draft[f.name] = f.value;
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !s.ctx) return;
    if (b.hasAttribute('data-fund-jump')) {
      document.getElementById('funds-heading')?.focus();
      return;
    }
    if (b.dataset.fundScenario) {
      s.scenario = b.dataset.fundScenario;
      render();
      return;
    }
    if (b.hasAttribute('data-plan-reload')) {
      void fetchPlan();
      return;
    }
    if (b.hasAttribute('data-fund-reload')) {
      void fetchFunds();
      return;
    }
    if (!s.funds || s.saving) return;
    if (b.hasAttribute('data-fund-new')) {
      s.draft = newDraft(s.funds.some((f) => f.kind === 'current') ? 'additional' : 'current');
    } else if (b.dataset.fundEdit) {
      const row = s.funds.find((f) => f.id === b.dataset.fundEdit);
      if (!row) return;
      s.draft = { ...row };
    } else if (b.hasAttribute('data-fund-discard')) s.draft = null;
    else return;
    s.message = '';
    render();
    if (s.draft) document.getElementById('fund-amount')?.focus();
  });
  root.addEventListener('submit', async (e) => {
    if (e.target.id !== 'fund-form') return;
    e.preventDefault();
    if (s.saving || !s.draft || !s.ctx) return;
    const d = { ...s.draft },
      digits = amountInput(d.amountWon, 19),
      token = generation;
    if (digits === null || BigInt(digits) > 9223372036854775807n || !isoDate(d.availableOn)) {
      s.problem = true;
      s.message = '원 단위의 유효한 금액과 날짜를 입력해 주세요.';
      render();
      return;
    }
    d.amountWon = digits;
    s.saving = true;
    s.message = '';
    render();
    try {
      if (s.ctx.guest) {
        const id = d.id || d.requestKey;
        s.funds = [
          ...s.funds.filter((f) => f.id !== id),
          { id, kind: d.kind, amountWon: digits, availableOn: d.availableOn, certainty: d.certainty },
        ].sort((a, b) => a.availableOn.localeCompare(b.availableOn));
      } else await api.saveFund(s.ctx.analysisId, s.ctx.ownerId, d);
      if (token !== generation) return;
      s.draft = null;
      s.problem = false;
      s.message = s.ctx.guest ? '예시 자금표에 적용했습니다.' : '이 분석에 자금을 저장했습니다.';
      await Promise.all([fetchFunds(), fetchPlan()]);
    } catch (err) {
      if (token !== generation) return;
      s.problem = true;
      s.message = errorText(err);
      if (err?.code === 'fund_changed') {
        s.draft = null;
        await Promise.all([fetchFunds(), fetchPlan()]);
      }
    } finally {
      if (token === generation) {
        s.saving = false;
        render();
      }
    }
  });
  return { reset, enter, view };
}
