import {
  areaClassLabel,
  badge,
  comparisonAreaCriterion,
  dateText,
  esc,
  icon,
  isoDate,
  rangeLabel,
  reasonText,
  supplyAreaRefLabel,
  supplyLabel,
} from './display.js';
import { tradeNames } from './trade-comparison.js';

const TRADE_ORDER = ['sale', 'presale_right', 'occupancy_right'];

function parseDecimal(str) {
  if (typeof str !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(str)) return null;
  const [whole, frac = ''] = str.split('.');
  return { digits: BigInt(whole + frac), scale: frac.length };
}

function formatDecimal(digits, scale) {
  const neg = digits < 0n;
  const abs = (neg ? -digits : digits).toString();
  if (scale === 0) return (neg ? '-' : '') + abs;
  const padded = abs.padStart(scale + 1, '0');
  const whole = padded.slice(0, -scale);
  const frac = padded.slice(-scale).replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

export function normalizeToleranceInput(raw, maxText = '5') {
  const trimmed = String(raw ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(trimmed)) return null;
  const [w, f = ''] = trimmed.split('.');
  const scaled = BigInt(w) * 10000n + BigInt(f.padEnd(4, '0'));
  const maxParts = String(maxText || '5').split('.');
  const maxScaled = BigInt(maxParts[0] || '5') * 10000n + BigInt((maxParts[1] || '').padEnd(4, '0'));
  if (scaled <= 0n || scaled > maxScaled) return null;
  return trimmed.includes('.') ? trimmed.replace(/0+$/, '').replace(/\.$/, '') : trimmed;
}

export function computeAreaBounds(targetM2Str, toleranceStr) {
  const t = parseDecimal(targetM2Str);
  const p = parseDecimal(toleranceStr);
  if (!t || !p || p.digits <= 0n) return null;
  const deltaDigits = t.digits * p.digits;
  const deltaScale = t.scale + p.scale + 2;
  const targetScaled = t.digits * 10n ** BigInt(deltaScale - t.scale);
  const minDigits = targetScaled - deltaDigits;
  const maxDigits = targetScaled + deltaDigits;
  if (minDigits < 0n) return null;
  return {
    minM2: formatDecimal(minDigits, deltaScale),
    maxM2: formatDecimal(maxDigits, deltaScale),
  };
}

function recentPeriodFromAsOf(asOf, months) {
  if (!isoDate(asOf)) return null;
  const date = new Date(asOf + 'T00:00:00Z');
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const last = new Date(date);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, last.getUTCDate()) + 1);
  const start = date.toISOString().slice(0, 10);
  return start <= asOf ? { start, end: asOf } : null;
}

function sortReplacements(pairs) {
  return [...pairs].sort((a, b) =>
    a.replaceComplexId < b.replaceComplexId
      ? -1
      : a.replaceComplexId > b.replaceComplexId
        ? 1
        : a.complexId < b.complexId
          ? -1
          : a.complexId > b.complexId
            ? 1
            : 0,
  );
}

function sameArray(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameReplacements(a, b) {
  return (
    a.length === b.length &&
    a.every((v, i) => v.complexId === b[i].complexId && v.replaceComplexId === b[i].replaceComplexId)
  );
}

function deriveFallbackBounds(comparison) {
  const p = comparison?.conditions?.period;
  const hasPeriod = p?.status === 'confirmed' && isoDate(p.start) && isoDate(p.end);
  const asOf = isoDate(comparison?.conditions?.asOf) || (hasPeriod ? p.end : null);
  const kinds = Array.isArray(comparison?.conditions?.tradeKinds)
    ? TRADE_ORDER.filter((k) => comparison.conditions.tradeKinds.includes(k))
    : [];
  const scopeOk = ['priority', 'expansion'].includes(comparison?.appliedScope);
  return {
    editable: true,
    period: hasPeriod && asOf ? { start: p.start, end: p.end, asOf } : null,
    tradeKinds: kinds,
    areaToleranceMax: '5',
    areaEditable: false,
    replacementsEditable: Boolean(hasPeriod && scopeOk),
  };
}

function extractCurrentReplacements(comparison) {
  const pairs = [];
  for (const c of comparison?.comparables ?? []) {
    if (c?.selectionReason === 'manual_replacement' && c.complexId && c.replacesComplexId) {
      pairs.push({ complexId: c.complexId, replaceComplexId: c.replacesComplexId });
    }
  }
  return sortReplacements(pairs);
}

function complexName(comparison, id) {
  for (const c of comparison?.comparables ?? []) {
    if (c?.complexId === id && c.name) return c.name;
  }
  for (const p of comparison?.candidatePool ?? []) {
    if (p?.complexId === id && p.name) return p.name;
  }
  return id;
}

function ineligibleReasonText(reasonCode) {
  const local = {
    outside_applied_region: '현재 적용 지역 밖의 단지입니다.',
    outside_area_class: '대상 주택형과 다른 평형의 단지입니다.',
    outside_supply_area: '허용 공급면적 범위 밖의 단지입니다.',
    outside_contract_period: '현재 계약 기간 안의 거래가 없습니다.',
    trade_kind_not_included: '선택한 거래 종류의 거래가 없습니다.',
    cancelled_trade: '해제된 거래만 있어 유효한 거래가 없습니다.',
    comparison_conditions_unmet: '현재 비교 기준을 충족한 거래가 없습니다.',
    candidate_unverified: '거래 또는 단지 근거가 확인되지 않았습니다.',
  };
  return local[reasonCode] ?? reasonText(reasonCode) ?? '현재 비교 기준을 충족하지 못했습니다.';
}

function ineligibleBadge(reasonCode) {
  if (reasonCode === 'outside_applied_region') return badge('zero', 'map-pin', '적용 지역 밖');
  if (reasonCode === 'outside_area_class') return badge('zero', 'sliders-horizontal', '다른 평형');
  if (reasonCode === 'outside_supply_area') return badge('zero', 'sliders-horizontal', '공급면적 범위 밖');
  if (
    reasonCode === 'outside_contract_period' ||
    reasonCode === 'trade_kind_not_included' ||
    reasonCode === 'cancelled_trade' ||
    reasonCode === 'comparison_conditions_unmet'
  ) {
    return badge('zero', 'circle-minus', '비교 기준 미충족');
  }
  return badge('unknown', 'circle-help', '근거 미확인');
}

function appliedScopeName(comparison) {
  const decision = comparison?.regionDecision;
  if (comparison?.appliedScope === 'expansion' && decision?.expansion?.name) return decision.expansion.name;
  if (decision?.priority?.name) return decision.priority.name;
  return '현재 적용 지역';
}

export function createConditionEditor({ dialog, announce, onSubmit }) {
  let state = null;
  let triggerElement = null;

  function buildInitial(comparison, bounds, guest) {
    const effectiveBounds = bounds ?? deriveFallbackBounds(comparison);
    const p = comparison?.conditions?.period;
    const period =
      p?.status === 'confirmed' && isoDate(p.start) && isoDate(p.end)
        ? { start: p.start, end: p.end }
        : effectiveBounds.period
          ? { start: effectiveBounds.period.start, end: effectiveBounds.period.end }
          : { start: '', end: '' };
    const tradeKinds = Array.isArray(comparison?.conditions?.tradeKinds)
      ? TRADE_ORDER.filter((k) => comparison.conditions.tradeKinds.includes(k))
      : [...effectiveBounds.tradeKinds];
    const replacements = extractCurrentReplacements(comparison);
    const slotOverrides = new Map(replacements.map((r) => [r.replaceComplexId, r.complexId]));

    return {
      comparison,
      bounds: effectiveBounds,
      hasServerBounds: Boolean(bounds),
      guest: Boolean(guest),
      submitting: false,
      submitError: '',
      initial: {
        period: { ...period },
        tradeKinds: [...tradeKinds],
        replacements,
      },
      draft: {
        periodStart: period.start,
        periodEnd: period.end,
        tradeKinds: [...tradeKinds],
        scopeMode: replacements.length > 0 ? 'manual' : 'auto',
        slotOverrides,
      },
    };
  }

  function currentDraftReplacements() {
    if (!state || state.draft.scopeMode !== 'manual') return [];
    const pairs = [];
    for (const [replaceComplexId, complexId] of state.draft.slotOverrides.entries()) {
      if (complexId && complexId !== replaceComplexId) {
        pairs.push({ complexId, replaceComplexId });
      }
    }
    return sortReplacements(pairs);
  }

  function evaluateDraft() {
    if (!state) return { patch: {}, diffRows: [], errors: [], valid: false };
    const { initial, draft, bounds, comparison } = state;
    const errors = [];
    const patch = {};
    const diffRows = [];

    // 1) 거래 종류
    const selectedKinds = TRADE_ORDER.filter((k) => draft.tradeKinds.includes(k));
    if (!selectedKinds.length) {
      errors.push('비교할 거래 종류를 1개 이상 선택하세요.');
    } else if (selectedKinds.some((k) => !bounds.tradeKinds.includes(k))) {
      errors.push('현재 수집 자료에 없는 거래 종류는 선택할 수 없습니다.');
    } else if (!sameArray(selectedKinds, initial.tradeKinds)) {
      patch.tradeKinds = selectedKinds;
      diffRows.push({
        label: '거래 종류',
        from: initial.tradeKinds.map((k) => tradeNames[k]).join(' · '),
        to: selectedKinds.map((k) => tradeNames[k]).join(' · '),
      });
    }

    // 2) 계약 기간
    if (bounds.period) {
      const start = isoDate(draft.periodStart);
      const end = isoDate(draft.periodEnd);
      if (!start || !end) {
        errors.push('계약 기간의 시작일과 종료일을 모두 입력하세요.');
      } else if (start > end) {
        errors.push('계약 기간의 시작일은 종료일보다 앞서거나 같아야 합니다.');
      } else if (start < bounds.period.start || end > bounds.period.end) {
        errors.push(
          `계약 기간은 수집된 범위(${dateText(bounds.period.start, false)} – ${dateText(bounds.period.end, false)}) 안에서만 선택할 수 있습니다.`,
        );
      } else if (start !== initial.period.start || end !== initial.period.end) {
        patch.period = { start, end };
        diffRows.push({
          label: '계약 기간',
          from: rangeLabel(initial.period, false),
          to: rangeLabel(patch.period, false),
        });
      }
    }

    // 3) 단지 직접 교체
    if (bounds.replacementsEditable) {
      const nextReps = currentDraftReplacements();
      if (!sameReplacements(nextReps, initial.replacements)) {
        patch.replacements = nextReps;
        const fmt = (list) =>
          list.length
            ? list.map((r) => `${complexName(comparison, r.replaceComplexId)} → ${complexName(comparison, r.complexId)}`).join(', ')
            : '자동 선정';
        diffRows.push({
          label: '비교 단지',
          from: fmt(initial.replacements),
          to: fmt(nextReps),
        });
      }
    }

    const canEdit = Boolean(bounds.editable);
    const hasChanges = Object.keys(patch).length > 0;
    const valid = canEdit && hasChanges && errors.length === 0;
    return { patch, diffRows, errors, valid, hasChanges };
  }

  function renderFooterHtml() {
    if (!state) return '';
    const { bounds, guest, submitting, submitError } = state;
    const { diffRows, errors, valid, hasChanges } = evaluateDraft();
    const disabledAttr = !valid || submitting ? ' disabled' : '';
    const summaryBody = !bounds.editable
      ? `<p class="cond-no-change">${icon('info')}최신 실행 결과에서만 비교 조건을 편집할 수 있습니다.</p>`
      : errors.length
        ? `<div class="cond-error-box" role="status">${icon('triangle-alert')}<ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
        : !hasChanges
          ? '<p class="cond-no-change" data-cond-no-change>바뀐 조건이 없습니다.</p>'
          : `<div class="cond-summary-block">
              <p class="cond-summary-heading">바뀌는 조건</p>
              <dl class="cond-diff-list">${diffRows
                .map(
                  (row) =>
                    `<div class="cond-diff-row"><dt>${esc(row.label)}</dt><dd><span class="cond-diff-from">${esc(row.from)}</span>${icon('arrow-right', 'cond-diff-arrow')}<span class="cond-diff-to">${esc(row.to)}</span></dd></div>`,
                )
                .join('')}</dl>
              <p class="cond-impact">${
                guest
                  ? '예시 화면에서는 대화 패널에 변경 제안 카드만 미리 표시하며 실행하지 않습니다.'
                  : '확인하면 대화에 승인 카드가 생깁니다. 승인 시 같은 수집본으로 새 실행을 접수하며 공유 프로필은 바뀌지 않습니다.'
              }</p>
            </div>`;
    return `<div class="cond-footer-summary">${summaryBody}${
      submitError ? `<p class="cond-field-error" role="status">${esc(submitError)}</p>` : ''
    }</div>
      <div class="cond-footer-actions">
        <button type="button" class="action secondary" data-cond="cancel"${submitting ? ' disabled' : ''}>취소</button>
        <button type="button" class="action primary" data-cond="confirm"${disabledAttr}>${icon(submitting ? 'loader-circle' : 'check', submitting ? 'spin' : '')}이 조건으로 다시 비교</button>
      </div>`;
  }

  function renderManualSectionHtml() {
    if (!state) return '';
    const { comparison, bounds, draft } = state;
    const comparables = comparison?.comparables ?? [];
    const pool = comparison?.candidatePool ?? [];
    const eligiblePool = pool.filter((p) => p?.eligible === true);
    const ineligiblePool = pool.filter((p) => p?.eligible === false);
    const criterion = comparisonAreaCriterion(comparison);
    const isAreaClass = criterion.basis === 'exclusive_area_class';
    const slotAreaText = (item) =>
      isAreaClass ? supplyAreaRefLabel(item) : `공급 ${supplyLabel(item.supplyAreaM2)}`;
    const baseSlots = comparables.map((c) => ({
      slotId: c.replacesComplexId || c.complexId,
      displayedId: c.complexId,
      displayedName: c.name || c.complexId,
      supplyAreaM2: c.supplyAreaM2,
      supplyAreaReference: c.supplyAreaReference,
      wasManual: c.selectionReason === 'manual_replacement',
      autoName: complexName(comparison, c.replacesComplexId || c.complexId),
    }));
    const baseSlotIds = new Set(baseSlots.map((s) => s.slotId));
    const chosenElsewhere = (thisSlotId) => {
      const taken = new Set();
      for (const [slotId, incoming] of draft.slotOverrides.entries()) {
        if (slotId !== thisSlotId && incoming) taken.add(incoming);
      }
      return taken;
    };

    const availableExtraCount = eligiblePool.filter((p) => !baseSlotIds.has(p.complexId)).length;

    const slotRows = baseSlots
      .map((slot, idx) => {
        const selectedVal = draft.slotOverrides.get(slot.slotId) ?? '';
        const taken = chosenElsewhere(slot.slotId);
        const options = eligiblePool.filter(
          (p) => !baseSlotIds.has(p.complexId) && !taken.has(p.complexId),
        );
        const defaultLabel = slot.wasManual
          ? `자동 선정으로 복원 (${slot.autoName})`
          : `유지 · ${slot.displayedName}`;
        return `<div class="cond-slot-row">
          <label for="cond-slot-${idx}" class="cond-slot-label">
            <strong>비교 단지 ${idx + 1}</strong>
            <span>${esc(slot.displayedName)} · ${esc(slotAreaText(slot))}</span>
          </label>
          <select id="cond-slot-${idx}" class="cond-select" data-cond-slot="${esc(slot.slotId)}"${!bounds.editable ? ' disabled' : ''}>
            <option value="">${esc(defaultLabel)}</option>
            ${options
              .map(
                (opt) =>
                  `<option value="${esc(opt.complexId)}"${selectedVal === opt.complexId ? ' selected' : ''}>${esc(opt.name)} · ${esc(slotAreaText(opt))}</option>`,
              )
              .join('')}
          </select>
        </div>`;
      })
      .join('');

    const ineligibleHtml = ineligiblePool.length
      ? `<div class="cond-ineligible">
          <h4>비교표에 넣을 수 없는 단지</h4>
          <p class="cond-hint">적용 지역 밖이거나 비교 기준을 통과하지 못한 단지는 선택할 수 없습니다.</p>
          <ul class="cond-ineligible-list">${ineligiblePool
            .map(
              (item) =>
                `<li>
                  <div class="cond-ineligible-top">
                    <strong>${esc(item.name || item.complexId)}</strong>
                    ${ineligibleBadge(item.reasonCode)}
                  </div>
                  <small>${esc([item.localityName, item.areaClass ? areaClassLabel(item.areaClass) : item.supplyAreaM2 ? '공급 ' + supplyLabel(item.supplyAreaM2) : '', ineligibleReasonText(item.reasonCode)].filter(Boolean).join(' · '))}</small>
                </li>`,
            )
            .join('')}</ul>
        </div>`
      : '';

    return `<div class="cond-manual-box">
      <p class="cond-hint">현재 적용 지역(<strong>${esc(appliedScopeName(comparison))}</strong>)과 같은 비교 기준을 통과한 후보만 기존 단지와 교체할 수 있습니다. 고유 주변 단지는 5개 이하로 유지합니다.</p>
      ${
        comparables.length
          ? `${availableExtraCount === 0 && !state.initial.replacements.length ? '<p class="cond-empty-note">현재 조건을 통과한 추가 교체 후보 단지가 없습니다. 수집된 기간이나 거래 종류를 먼저 변경해 볼 수 있습니다.</p>' : ''}
             <div class="cond-slot-list">${slotRows}</div>`
          : '<p class="cond-empty-note">현재 비교표에 교체할 주변 단지가 없습니다.</p>'
      }
      ${ineligibleHtml}
    </div>`;
  }

  function renderDialog() {
    if (!state) return;
    const { comparison, bounds, draft, guest } = state;
    const disabledAll = !bounds.editable;
    const hasRights = draft.tradeKinds.includes('presale_right') || draft.tradeKinds.includes('occupancy_right');
    const periodBounds = bounds.period;
    const periodPresets = periodBounds
      ? [
          { id: 'all', label: '수집 전체', start: periodBounds.start, end: periodBounds.end },
          ...[1, 3, 6, 12].map((m) => {
            const p = recentPeriodFromAsOf(periodBounds.asOf, m);
            return {
              id: `m${m}`,
              label: m === 12 ? '최근 1년' : `최근 ${m}개월`,
              start: p?.start ?? null,
              end: p?.end ?? null,
            };
          }),
        ]
      : [];
    const criterion = comparisonAreaCriterion(comparison);
    const manualAllowed = bounds.replacementsEditable && (comparison?.comparables?.length ?? 0) > 0;

    dialog.innerHTML = `<div class="cond-shell">
      <header class="cond-header">
        <div>
          <h2 id="cond-drawer-title">비교 조건</h2>
          <p class="cond-subtitle">이번 분석에만 적용됩니다. 공유 프로필은 바뀌지 않습니다.</p>
        </div>
        <button type="button" class="cond-close" data-cond="cancel" aria-label="비교 조건 패널 닫기">${icon('x')}</button>
      </header>
      <div class="cond-body">
        ${guest ? `<p class="cond-banner">${icon('layers')}합성 예시 화면입니다. 변경 미리보기만 표시하며 실제 실행은 로그인 후 이용할 수 있습니다.</p>` : ''}
        ${!bounds.editable ? `<p class="cond-banner">${icon('info')}이전 실행 결과입니다. 비교 조건은 이 분석의 최신 실행에서만 변경할 수 있습니다.</p>` : ''}

        <fieldset class="cond-section">
          <legend>거래 종류</legend>
          <div class="cond-check-row">
            ${TRADE_ORDER.map((kind) => {
              const available = bounds.tradeKinds.includes(kind);
              const checked = draft.tradeKinds.includes(kind);
              const dis = disabledAll || !available;
              return `<label class="cond-check-pill${checked ? ' is-checked' : ''}${dis ? ' is-disabled' : ''}">
                <input type="checkbox" name="tradeKind" value="${kind}"${checked ? ' checked' : ''}${dis ? ' disabled' : ''} />
                <span>${esc(tradeNames[kind])}</span>
                ${!available ? '<small>수집 없음</small>' : ''}
              </label>`;
            }).join('')}
          </div>
          <p class="cond-hint" id="cond-rights-note"${hasRights ? '' : ' hidden'}>분양권·입주권은 거래신고금액 기준이며, 실제 거래가격(아파트 매매)과 구분해 표시합니다.</p>
        </fieldset>

        <fieldset class="cond-section">
          <legend>계약 기간</legend>
          ${
            periodBounds
              ? `<div class="cond-preset-row">
                  ${periodPresets
                    .map((preset) => {
                      const inRange =
                        preset.start &&
                        preset.end &&
                        preset.start >= periodBounds.start &&
                        preset.end <= periodBounds.end;
                      const active = inRange && draft.periodStart === preset.start && draft.periodEnd === preset.end;
                      return `<button type="button" class="cond-preset${active ? ' is-active' : ''}" data-cond-period-start="${esc(preset.start ?? '')}" data-cond-period-end="${esc(preset.end ?? '')}"${disabledAll || !inRange ? ' disabled' : ''}>${esc(preset.label)}</button>`;
                    })
                    .join('')}
                </div>
                <div class="cond-date-grid">
                  <label class="cond-field">
                    <span>시작일</span>
                    <input type="date" id="cond-period-start" value="${esc(draft.periodStart)}" min="${esc(periodBounds.start)}" max="${esc(periodBounds.end)}"${disabledAll ? ' disabled' : ''} />
                  </label>
                  <label class="cond-field">
                    <span>종료일</span>
                    <input type="date" id="cond-period-end" value="${esc(draft.periodEnd)}" min="${esc(periodBounds.start)}" max="${esc(periodBounds.end)}"${disabledAll ? ' disabled' : ''} />
                  </label>
                </div>
                <p class="cond-hint">수집 자료 범위: <span class="num">${esc(dateText(periodBounds.start, false))} – ${esc(dateText(periodBounds.end, false))}</span> (양 끝 날짜 포함)</p>`
              : '<p class="cond-hint">이 결과에는 확정된 계약 기간이 없어 기간을 변경할 수 없습니다.</p>'
          }
        </fieldset>

        <fieldset class="cond-section">
          <legend>비교 범위 · 단지 지정</legend>
          <div class="cond-radio-grid">
            <label class="cond-radio-card${draft.scopeMode === 'auto' ? ' is-selected' : ''}">
              <input type="radio" name="scopeMode" value="auto"${draft.scopeMode === 'auto' ? ' checked' : ''}${disabledAll ? ' disabled' : ''} />
              <div>
                <strong>자동 선정 · 같은 동(읍·면) 우선</strong>
                <span>같은 평형(전용면적 정수부)의 주변 단지를 확인 좌표 간 직선거리순으로 자동 선정합니다.</span>
              </div>
            </label>
            <label class="cond-radio-card${draft.scopeMode === 'manual' ? ' is-selected' : ''}${!manualAllowed ? ' is-disabled' : ''}">
              <input type="radio" name="scopeMode" value="manual"${draft.scopeMode === 'manual' ? ' checked' : ''}${disabledAll || !manualAllowed ? ' disabled' : ''} />
              <div>
                <strong>단지 직접 지정 · 교체</strong>
                <span>적용 지역과 같은 평형 기준을 통과한 후보로 기존 비교 단지를 교체합니다.</span>
              </div>
            </label>
          </div>
          <div id="cond-manual-slot">${draft.scopeMode === 'manual' ? renderManualSectionHtml() : ''}</div>
        </fieldset>

        <div class="cond-readonly-strip" aria-label="변경할 수 없는 비교 기준">
          <div><small>비교 기준</small><strong>${esc(criterion.full)}</strong></div>
          <div><small>단지 순서</small><strong>확인 좌표 간 직선거리순</strong></div>
          <div><small>층 · 연식</small><strong>비교 표에 표시 (필터 제외)</strong></div>
        </div>
      </div>
      <footer class="cond-footer" id="cond-footer">${renderFooterHtml()}</footer>
    </div>`;
  }

  function syncLiveFeedback() {
    if (!state) return;
    const footer = dialog.querySelector('#cond-footer');
    if (footer) footer.innerHTML = renderFooterHtml();
    const rightsNote = dialog.querySelector('#cond-rights-note');
    if (rightsNote) {
      const hasRights =
        state.draft.tradeKinds.includes('presale_right') || state.draft.tradeKinds.includes('occupancy_right');
      rightsNote.hidden = !hasRights;
    }
    for (const btn of dialog.querySelectorAll('[data-cond-period-start]')) {
      btn.classList.toggle(
        'is-active',
        Boolean(
          btn.dataset.condPeriodStart &&
            btn.dataset.condPeriodStart === state.draft.periodStart &&
            btn.dataset.condPeriodEnd === state.draft.periodEnd,
        ),
      );
    }
    for (const pill of dialog.querySelectorAll('.cond-check-pill')) {
      const input = pill.querySelector('input[type="checkbox"]');
      if (input) pill.classList.toggle('is-checked', input.checked);
    }
    for (const card of dialog.querySelectorAll('.cond-radio-card')) {
      const input = card.querySelector('input[type="radio"]');
      if (input) card.classList.toggle('is-selected', input.checked);
    }
  }

  function open({ comparison, bounds = null, guest = false, trigger = null }) {
    if (!dialog || !comparison) return;
    triggerElement = trigger ?? document.activeElement;
    state = buildInitial(comparison, bounds, guest);
    renderDialog();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('.cond-close')?.focus({ preventScroll: true });
    announce('비교 조건 편집 패널을 열었습니다.');
  }

  function close({ restoreFocus = false } = {}) {
    if (!dialog) return;
    state = null;
    if (dialog.open) dialog.close();
    if (restoreFocus && triggerElement && document.contains(triggerElement)) {
      triggerElement.focus({ preventScroll: true });
    }
    triggerElement = null;
  }

  async function confirm() {
    if (!state || state.submitting) return;
    const { patch, diffRows, valid } = evaluateDraft();
    if (!valid) return;
    const summaryText = diffRows.map((row) => `${row.label} ${row.from} → ${row.to}`).join(', ');
    const message = (`비교 조건 변경: ${summaryText}`).slice(0, 780);
    state.submitting = true;
    state.submitError = '';
    syncLiveFeedback();
    try {
      const ok = await onSubmit({ conditions: patch, message });
      if (ok !== false) {
        close({ restoreFocus: false });
      } else if (state) {
        state.submitting = false;
        state.submitError = '현재 대화 처리가 끝난 뒤 다시 시도하세요.';
        syncLiveFeedback();
      }
    } catch (error) {
      if (state) {
        state.submitting = false;
        state.submitError = error?.message || '조건 변경 요청을 전송하지 못했습니다.';
        syncLiveFeedback();
      }
    }
  }

  dialog?.addEventListener('cancel', (event) => {
    event.preventDefault();
    close({ restoreFocus: true });
  });

  dialog?.addEventListener('click', (event) => {
    if (!state) return;
    if (event.target === dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      ) {
        close({ restoreFocus: true });
      }
      return;
    }
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.cond === 'cancel') {
      close({ restoreFocus: true });
      return;
    }
    if (button.dataset.cond === 'confirm') {
      void confirm();
      return;
    }
    if (button.dataset.condPeriodStart && button.dataset.condPeriodEnd) {
      state.draft.periodStart = button.dataset.condPeriodStart;
      state.draft.periodEnd = button.dataset.condPeriodEnd;
      const startEl = dialog.querySelector('#cond-period-start');
      const endEl = dialog.querySelector('#cond-period-end');
      if (startEl) startEl.value = state.draft.periodStart;
      if (endEl) endEl.value = state.draft.periodEnd;
      syncLiveFeedback();
    }
  });

  dialog?.addEventListener('input', (event) => {
    if (!state) return;
    const target = event.target;
    if (target.id === 'cond-period-start') {
      state.draft.periodStart = target.value;
      syncLiveFeedback();
    } else if (target.id === 'cond-period-end') {
      state.draft.periodEnd = target.value;
      syncLiveFeedback();
    }
  });

  dialog?.addEventListener('change', (event) => {
    if (!state) return;
    const target = event.target;
    if (target.name === 'tradeKind') {
      const checked = Array.from(dialog.querySelectorAll('input[name="tradeKind"]:checked')).map((el) => el.value);
      state.draft.tradeKinds = TRADE_ORDER.filter((k) => checked.includes(k));
      syncLiveFeedback();
      return;
    }
    if (target.name === 'scopeMode') {
      state.draft.scopeMode = target.value === 'manual' ? 'manual' : 'auto';
      const slot = dialog.querySelector('#cond-manual-slot');
      if (slot) slot.innerHTML = state.draft.scopeMode === 'manual' ? renderManualSectionHtml() : '';
      syncLiveFeedback();
      return;
    }
    if (target.dataset.condSlot) {
      const slotId = target.dataset.condSlot;
      const value = target.value;
      if (value) state.draft.slotOverrides.set(slotId, value);
      else state.draft.slotOverrides.delete(slotId);
      const slot = dialog.querySelector('#cond-manual-slot');
      if (slot) slot.innerHTML = renderManualSectionHtml();
      syncLiveFeedback();
      dialog.querySelector(`[data-cond-slot="${CSS.escape(slotId)}"]`)?.focus({ preventScroll: true });
    }
  });

  function syncBounds(nextBounds) {
    if (!state || state.guest || !nextBounds || !dialog?.open) return;
    if (state.hasServerBounds && evaluateDraft().hasChanges) return;
    const hadChanges = evaluateDraft().hasChanges;
    state.bounds = nextBounds;
    state.hasServerBounds = true;
    if (!hadChanges) renderDialog();
    else syncLiveFeedback();
  }

  return {
    open,
    close,
    syncBounds,
    isOpen: () => Boolean(dialog?.open),
  };
}
