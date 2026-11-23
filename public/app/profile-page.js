import * as api from './client.js';
import { badge, errorText, esc, icon, won } from './display.js';
import { amountInput } from './planning-fields.js';
import { parseSharedProfileMessage } from './profile-language.js';

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const REGION_CODE_RE = /^\d{5}$/;
const MONTH_RE = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/;
const ANY_BUDGET_RE = /^(?:0|[1-9]\d*)$/;
const NEW_BUDGET_MAX_DIGITS = 20;
const AREA_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const PUBLIC_KEYS = [
  'region_codes',
  'budget_max_won',
  'supply_area_min_m2',
  'supply_area_max_m2',
  'move_in_start_month',
  'move_in_end_month',
];
const PUBLIC_KEY_SET = new Set(PUBLIC_KEYS);
const MAX_REASON_CODE_POINTS = 800;
const MAX_REGIONS = 50;

const stampShort = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
});
const stampFull = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function codePointLength(value) {
  return Array.from(String(value ?? '')).length;
}

function sliceCodePoints(value, max) {
  return Array.from(String(value ?? '')).slice(0, max).join('');
}

function exactArea(value) {
  return typeof value === 'string' && AREA_RE.test(value) && value.length <= 24 && /[1-9]/.test(value);
}

function compareDecimals(a, b) {
  const [aWhole, aFrac = ''] = a.split('.');
  const [bWhole, bFrac = ''] = b.split('.');
  const scale = Math.max(aFrac.length, bFrac.length);
  const av = BigInt(aWhole + aFrac.padEnd(scale, '0'));
  const bv = BigInt(bWhole + bFrac.padEnd(scale, '0'));
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function formatWonExact(value) {
  if (typeof value !== 'string' || !ANY_BUDGET_RE.test(value)) return '—';
  if (value.length <= 21) return won(value);
  const integer = BigInt(value);
  const parts = [];
  const hundredMillion = integer / 100000000n;
  const tenThousand = (integer % 100000000n) / 10000n;
  const units = integer % 10000n;
  if (hundredMillion) parts.push(hundredMillion.toLocaleString('ko-KR') + '억');
  if (tenThousand) parts.push(tenThousand.toLocaleString('ko-KR') + '만');
  if (units || !parts.length) parts.push(units.toLocaleString('ko-KR'));
  return parts.join(' ') + (units || (!hundredMillion && !tenThousand) ? '원' : ' 원');
}

function toPyeongHint(minStr, maxStr) {
  if (minStr && maxStr) {
    const min = Number(minStr);
    const max = Number(maxStr);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return '';
    const pMin = (min / 3.305785).toFixed(1);
    const pMax = (max / 3.305785).toFixed(1);
    return minStr === maxStr ? `약 ${pMin}평` : `약 ${pMin}–${pMax}평`;
  }
  const single = minStr || maxStr;
  if (!single) return '';
  const num = Number(single);
  if (!Number.isFinite(num) || num <= 0) return '';
  return `약 ${(num / 3.305785).toFixed(1)}평`;
}

function formatMonth(value) {
  return typeof value === 'string' && MONTH_RE.test(value) ? value.replace('-', '.') : '—';
}

function formatShortStamp(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? stampShort.format(ms) : '';
}

function formatFullStamp(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? stampFull.format(ms) : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 기존 저장 프로필의 한쪽 범위 값이나 긴 유효 예산 문자열을 유실하지 않고 그대로 보존한다.
function readStoredConditions(raw) {
  const c = isPlainObject(raw) ? raw : {};
  const regions =
    Array.isArray(c.region_codes) &&
    c.region_codes.length > 0 &&
    c.region_codes.every((code) => typeof code === 'string' && REGION_CODE_RE.test(code))
      ? [...new Set(c.region_codes)]
      : null;
  const budget =
    typeof c.budget_max_won === 'string' && ANY_BUDGET_RE.test(c.budget_max_won)
      ? c.budget_max_won
      : null;
  const areaMin =
    c.supply_area_min_m2 != null && exactArea(String(c.supply_area_min_m2))
      ? String(c.supply_area_min_m2)
      : null;
  const areaMax =
    c.supply_area_max_m2 != null && exactArea(String(c.supply_area_max_m2))
      ? String(c.supply_area_max_m2)
      : null;
  const moveStart =
    typeof c.move_in_start_month === 'string' && MONTH_RE.test(c.move_in_start_month)
      ? c.move_in_start_month
      : null;
  const moveEnd =
    typeof c.move_in_end_month === 'string' && MONTH_RE.test(c.move_in_end_month)
      ? c.move_in_end_month
      : null;
  return {
    region_codes: regions,
    budget_max_won: budget,
    supply_area_min_m2: areaMin,
    supply_area_max_m2: areaMax,
    move_in_start_month: moveStart,
    move_in_end_month: moveEnd,
  };
}

function sanitizeDraftPatch(rawPatch) {
  if (!isPlainObject(rawPatch)) return null;
  const clean = {};
  for (const [key, value] of Object.entries(rawPatch)) {
    if (!PUBLIC_KEY_SET.has(key)) return null;
    if (value === undefined) continue;
    if (value === null) {
      clean[key] = null;
      continue;
    }
    if (key === 'region_codes') {
      if (
        !Array.isArray(value) ||
        value.length < 1 ||
        value.length > MAX_REGIONS ||
        !value.every((code) => typeof code === 'string' && REGION_CODE_RE.test(code))
      )
        return null;
      const distinct = [...new Set(value)];
      if (distinct.length !== value.length) return null;
      clean[key] = distinct;
    } else if (key === 'budget_max_won') {
      if (typeof value !== 'string' || !ANY_BUDGET_RE.test(value) || value.length > NEW_BUDGET_MAX_DIGITS)
        return null;
      clean[key] = value;
    } else if (key === 'supply_area_min_m2' || key === 'supply_area_max_m2') {
      const str = typeof value === 'string' ? value : null;
      if (!exactArea(str)) return null;
      clean[key] = str;
    } else if (key === 'move_in_start_month' || key === 'move_in_end_month') {
      if (typeof value !== 'string' || !MONTH_RE.test(value)) return null;
      clean[key] = value;
    }
  }
  const hasAreaMin = Object.hasOwn(clean, 'supply_area_min_m2');
  const hasAreaMax = Object.hasOwn(clean, 'supply_area_max_m2');
  if (hasAreaMin !== hasAreaMax) return null;
  if (hasAreaMin) {
    const minVal = clean.supply_area_min_m2;
    const maxVal = clean.supply_area_max_m2;
    if ((minVal === null) !== (maxVal === null)) return null;
    if (minVal !== null && compareDecimals(minVal, maxVal) > 0) return null;
  }
  const hasMoveStart = Object.hasOwn(clean, 'move_in_start_month');
  const hasMoveEnd = Object.hasOwn(clean, 'move_in_end_month');
  if (hasMoveStart !== hasMoveEnd) return null;
  if (hasMoveStart) {
    const startVal = clean.move_in_start_month;
    const endVal = clean.move_in_end_month;
    if ((startVal === null) !== (endVal === null)) return null;
    if (startVal !== null && startVal > endVal) return null;
  }
  return Object.keys(clean).length ? clean : null;
}

function canonicalSignature(baseRevision, patch, reason, scope) {
  const ordered = {};
  for (const key of PUBLIC_KEYS) {
    if (Object.hasOwn(patch, key)) ordered[key] = patch[key];
  }
  return JSON.stringify({
    baseRevision,
    patch: ordered,
    reason,
    analysisId: scope?.analysisId ?? null,
    runId: scope?.runId ?? null,
  });
}

function toRegionMap(regions) {
  if (regions instanceof Map) return regions;
  const map = new Map();
  if (Array.isArray(regions)) {
    for (const r of regions) {
      if (r && typeof r.code === 'string' && typeof r.name === 'string') map.set(r.code, r.name);
    }
  }
  return map;
}

function formatRegionList(codes, regionMap) {
  if (!Array.isArray(codes) || !codes.length) return '미설정';
  return codes.map((code) => regionMap.get(code) || `코드 ${code}`).join(' · ');
}

function formatAreaDisplay(min, max) {
  if (!min && !max) return '미설정';
  if (min && max) return min === max ? `${min}㎡` : `${min}㎡ – ${max}㎡`;
  return min ? `${min}㎡ 이상` : `${max}㎡ 이하`;
}

function formatMoveInDisplay(start, end) {
  if (!start && !end) return '미설정';
  if (start && end) return start === end ? formatMonth(start) : `${formatMonth(start)} – ${formatMonth(end)}`;
  return start ? `${formatMonth(start)} 이후` : `${formatMonth(end)} 이전`;
}

function sameBound(a, b) {
  return (a ?? null) === (b ?? null);
}

// 저장된 previous/patch는 실제 바뀐 한쪽 경계만 담을 수 있으므로 실제 변경된 항목만 표시한다.
function buildDiffRows(previous, patch, regionMap) {
  const prev = isPlainObject(previous) ? previous : {};
  const next = isPlainObject(patch) ? patch : {};
  const rows = [];

  if (Object.hasOwn(next, 'region_codes')) {
    const fromVal =
      Array.isArray(prev.region_codes) && prev.region_codes.length
        ? formatRegionList(prev.region_codes, regionMap)
        : '미설정';
    const toVal = next.region_codes === null ? '설정 해제' : formatRegionList(next.region_codes, regionMap);
    rows.push({ field: '희망 지역', from: fromVal, to: toVal, clearing: next.region_codes === null });
  }

  if (Object.hasOwn(next, 'budget_max_won')) {
    const fromVal =
      typeof prev.budget_max_won === 'string' && ANY_BUDGET_RE.test(prev.budget_max_won)
        ? formatWonExact(prev.budget_max_won)
        : '미설정';
    const toVal =
      next.budget_max_won === null
        ? '설정 해제'
        : typeof next.budget_max_won === 'string' && ANY_BUDGET_RE.test(next.budget_max_won)
          ? formatWonExact(next.budget_max_won)
          : String(next.budget_max_won);
    rows.push({ field: '최대 구매 예산', from: fromVal, to: toVal, clearing: next.budget_max_won === null });
  }

  const hasAreaMin = Object.hasOwn(next, 'supply_area_min_m2');
  const hasAreaMax = Object.hasOwn(next, 'supply_area_max_m2');
  if (hasAreaMin || hasAreaMax) {
    const prevMin = prev.supply_area_min_m2 != null ? String(prev.supply_area_min_m2) : null;
    const prevMax = prev.supply_area_max_m2 != null ? String(prev.supply_area_max_m2) : null;
    const nextMin = next.supply_area_min_m2 != null ? String(next.supply_area_min_m2) : null;
    const nextMax = next.supply_area_max_m2 != null ? String(next.supply_area_max_m2) : null;
    const minChanged = hasAreaMin && !sameBound(prevMin, nextMin);
    const maxChanged = hasAreaMax && !sameBound(prevMax, nextMax);

    if (hasAreaMin && hasAreaMax && minChanged && maxChanged) {
      const clearing = next.supply_area_min_m2 === null && next.supply_area_max_m2 === null;
      rows.push({
        field: '희망 공급면적',
        from: formatAreaDisplay(prevMin, prevMax),
        to: clearing ? '설정 해제' : formatAreaDisplay(nextMin, nextMax),
        clearing,
      });
    } else {
      if (minChanged || (hasAreaMin && !hasAreaMax)) {
        rows.push({
          field: '최소 공급면적',
          from: prevMin ? `${prevMin}㎡` : '미설정',
          to: next.supply_area_min_m2 === null ? '설정 해제' : `${nextMin}㎡`,
          clearing: next.supply_area_min_m2 === null,
        });
      }
      if (maxChanged || (hasAreaMax && !hasAreaMin)) {
        rows.push({
          field: '최대 공급면적',
          from: prevMax ? `${prevMax}㎡` : '미설정',
          to: next.supply_area_max_m2 === null ? '설정 해제' : `${nextMax}㎡`,
          clearing: next.supply_area_max_m2 === null,
        });
      }
    }
  }

  const hasMoveStart = Object.hasOwn(next, 'move_in_start_month');
  const hasMoveEnd = Object.hasOwn(next, 'move_in_end_month');
  if (hasMoveStart || hasMoveEnd) {
    const prevStart = typeof prev.move_in_start_month === 'string' ? prev.move_in_start_month : null;
    const prevEnd = typeof prev.move_in_end_month === 'string' ? prev.move_in_end_month : null;
    const nextStart = typeof next.move_in_start_month === 'string' ? next.move_in_start_month : null;
    const nextEnd = typeof next.move_in_end_month === 'string' ? next.move_in_end_month : null;
    const startChanged = hasMoveStart && !sameBound(prevStart, nextStart);
    const endChanged = hasMoveEnd && !sameBound(prevEnd, nextEnd);

    if (hasMoveStart && hasMoveEnd && startChanged && endChanged) {
      const clearing = next.move_in_start_month === null && next.move_in_end_month === null;
      rows.push({
        field: '희망 입주월',
        from: formatMoveInDisplay(prevStart, prevEnd),
        to: clearing ? '설정 해제' : formatMoveInDisplay(nextStart, nextEnd),
        clearing,
      });
    } else {
      if (startChanged || (hasMoveStart && !hasMoveEnd)) {
        rows.push({
          field: '입주 시작월',
          from: prevStart ? formatMonth(prevStart) : '미설정',
          to: next.move_in_start_month === null ? '설정 해제' : formatMonth(nextStart),
          clearing: next.move_in_start_month === null,
        });
      }
      if (endChanged || (hasMoveEnd && !hasMoveStart)) {
        rows.push({
          field: '입주 종료월',
          from: prevEnd ? formatMonth(prevEnd) : '미설정',
          to: next.move_in_end_month === null ? '설정 해제' : formatMonth(nextEnd),
          clearing: next.move_in_end_month === null,
        });
      }
    }
  }

  return rows;
}

function renderDiffList(rows) {
  if (!rows.length) return '<p class="field-help">변경 항목이 없습니다.</p>';
  return `<dl class="profile-diff">${rows
    .map(
      (row) => `<div class="profile-diff-row">
        <dt>${esc(row.field)}</dt>
        <dd>
          <span class="profile-diff-from"><span class="sr-only">이전 </span>${esc(row.from)}</span>
          ${icon('arrow-right', 'profile-diff-arrow')}
          <span class="profile-diff-to${row.clearing ? ' is-clearing' : ''}"><span class="sr-only">변경 후 </span>${esc(row.to)}</span>
        </dd>
      </div>`,
    )
    .join('')}</dl>`;
}

export function renderProfileChangeCard(
  proposal,
  {
    regions = [],
    busy = false,
    showActions = true,
    currentRevision = null,
    busyDecision = null,
    locked = false,
    error = null,
    showReviewButton = false,
  } = {},
) {
  if (!proposal || typeof proposal !== 'object') return '';
  const regionMap = toRegionMap(regions);
  const rows = buildDiffRows(proposal.previous, proposal.patch, regionMap);
  const pending = proposal.status === 'pending';
  const hasCurrentRev = Number.isSafeInteger(currentRevision);
  const stale = pending && hasCurrentRev && proposal.baseRevision !== currentRevision;
  const stamp = formatFullStamp(proposal.createdAt);
  const hasOrigin = UUID_RE.test(proposal.analysisId) && UUID_RE.test(proposal.runId);
  const statusMap = {
    approved: badge('verified', 'circle-check', '반영됨'),
    rejected: badge('closed', 'x', '거절 · 프로필 유지'),
    cancelled: badge('closed', 'circle-minus', '취소 · 프로필 유지'),
  };
  const errCode = error?.error?.code ?? '';
  const reviewButton =
    showActions && showReviewButton && pending && hasOrigin
      ? `<button type="button" class="action secondary compact profile-review-link" data-profile-review="${esc(proposal.id)}">대화에서 검토하기</button>`
      : '';
  const originLink =
    showActions && hasOrigin
      ? `<a class="text-button profile-ref-link" href="#run/${esc(proposal.analysisId)}/${esc(proposal.runId)}">관련 분석 보기 ${icon('arrow-right')}</a>`
      : '';

  const footnote = stale
    ? `기준 v${esc(proposal.baseRevision)} 변경안입니다. 현재 저장값은 v${esc(currentRevision)}이므로 바로 반영할 수 없으며 거절하거나 취소할 수 있습니다.`
    : hasCurrentRev
      ? `반영 전까지 현재 저장값(v${esc(currentRevision)})을 유지합니다. 기존 분석과 보고서는 바뀌지 않습니다.`
      : '승인하면 다음 맞춤 검색부터 적용됩니다. 기존 분석과 보고서는 바뀌지 않습니다.';

  return `<article class="profile-change-card is-${esc(proposal.status)}${stale ? ' is-stale' : ''}${showActions ? '' : ' is-embedded'}" data-proposal-card="${esc(proposal.id)}" aria-label="공유 프로필 변경안">
    <header class="profile-change-head">
      <span class="profile-change-icon" aria-hidden="true">${icon('user-round')}</span>
      <h3>공유 프로필 변경안</h3>
      <span class="profile-scope-pill">다음 맞춤 검색에 적용</span>
      <span class="profile-rev-pill">기준 v${esc(proposal.baseRevision)}</span>
      ${!pending ? statusMap[proposal.status] ?? '' : ''}
      ${reviewButton}
    </header>
    <div class="profile-change-body">
      ${
        stale
          ? `<div class="profile-stale-note" role="status">${icon('triangle-alert')}<span>현재 프로필은 v${esc(currentRevision)}입니다. v${esc(proposal.baseRevision)} 기준으로 만든 변경안은 바로 반영할 수 없습니다.</span></div>`
          : ''
      }
      ${renderDiffList(rows)}
      <div class="profile-change-evidence">
        <p><strong>근거</strong> ${esc(proposal.reason || '사유 미기재')}</p>
        <div class="profile-change-meta">
          ${stamp ? `<time datetime="${esc(proposal.createdAt)}">${esc(stamp)} KST</time>` : ''}
          ${originLink}
        </div>
      </div>
      ${
        showActions && error
          ? `<div class="profile-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(errorText(error.error))}</p><div class="profile-error-actions">${
              errCode === 'authentication_required'
                ? '<button type="button" class="action secondary compact" data-action="auth">로그인</button>'
                : '<button type="button" class="action secondary compact" data-profile="reload">최신 프로필 불러오기</button>'
            }</div></div></div>`
          : ''
      }
      ${
        showActions && pending
          ? `<div class="profile-change-actions">
              <button type="button" class="action profile-apply compact" data-profile="decide" data-change-id="${esc(proposal.id)}" data-decision="approve"${locked || busy ? ' disabled' : ''}>${icon(busy && busyDecision === 'approve' ? 'loader-circle' : 'check', busy && busyDecision === 'approve' ? 'spin' : '')}프로필에 반영</button>
              <button type="button" class="action secondary compact" data-profile="decide" data-change-id="${esc(proposal.id)}" data-decision="reject"${locked || busy ? ' disabled' : ''}>거절</button>
              <button type="button" class="text-button" data-profile="decide" data-change-id="${esc(proposal.id)}" data-decision="cancel"${locked || busy ? ' disabled' : ''}>취소</button>
            </div>
            <p class="profile-footnote">${footnote}</p>`
          : ''
      }
    </div>
  </article>`;
}

function previewPreviousForPatch(savedConditions, patch) {
  const prev = {};
  for (const key of Object.keys(patch)) {
    prev[key] = savedConditions[key] ?? null;
  }
  return prev;
}

function blank() {
  return {
    active: false,
    ownerId: null,
    scope: null,
    loading: false,
    loadError: null,
    profile: null,
    proposals: [],
    nextCursor: null,
    seenCursors: new Set(),
    loadingMore: false,
    loadMoreError: null,
    regions: [],
    regionsLoading: false,
    regionsError: null,
    // 직접 수정 폼 펼침 상태와 작성 중 초안 상태 (리렌더에도 유지)
    editOpen: false,
    formCodes: [],
    formRegionInput: '',
    formBudget: '',
    formAreaMin: '',
    formAreaMax: '',
    formMoveInStart: '',
    formMoveInEnd: '',
    formReason: '',
    formEdited: false,
    formError: '',
    formSubmitting: false,
    formRetry: null,
    // 자연어 변경 초안 상태
    draftOpen: false,
    draftMessage: '',
    draftFromComparison: false,
    draftAutoParse: false,
    draftParseState: null, // null | { kind: 'ordinary' } | { kind: 'error', message } | { kind: 'parsed', patch, reason }
    draftSubmitting: false,
    draftRetry: null,
    // 결정 상태
    decidingId: null,
    decidingAction: null,
    decisionError: null,
    banner: null,
  };
}

export function createProfilePage({ root, render, announce = () => {}, user }) {
  let s = blank();
  let generation = 0;
  let profileController = null;
  let moreController = null;
  let proposeController = null;
  let decideController = null;

  function abortAll() {
    profileController?.abort();
    moreController?.abort();
    proposeController?.abort();
    decideController?.abort();
    profileController = moreController = proposeController = decideController = null;
  }

  function reset() {
    ++generation;
    abortAll();
    s = blank();
  }

  function syncView({ focusSelector = null } = {}) {
    const slot = root.querySelector('#profile-page-slot');
    if (!slot) {
      render();
      if (focusSelector) root.querySelector(focusSelector)?.focus({ preventScroll: true });
      return;
    }
    slot.innerHTML = innerView();
    if (focusSelector) {
      slot.querySelector(focusSelector)?.focus({ preventScroll: true });
    }
  }

  function regionLookup() {
    return toRegionMap(s.regions);
  }

  function hydrateFormFromProfile(conditions) {
    const c = readStoredConditions(conditions);
    s.formCodes = c.region_codes ? c.region_codes.slice() : [];
    s.formRegionInput = '';
    s.formBudget = c.budget_max_won ?? '';
    s.formAreaMin = c.supply_area_min_m2 ?? '';
    s.formAreaMax = c.supply_area_max_m2 ?? '';
    s.formMoveInStart = c.move_in_start_month ?? '';
    s.formMoveInEnd = c.move_in_end_month ?? '';
    s.formReason = '';
    s.formEdited = false;
    s.formError = '';
    s.formRetry = null;
  }

  function computeFormDiffMeta() {
    if (!s.profile) return { dirtyCount: 0, groups: {} };
    const saved = readStoredConditions(s.profile.conditions);
    const savedCodes = saved.region_codes ?? [];
    const regionChanged =
      s.formCodes.length !== savedCodes.length ||
      s.formCodes.some((code, idx) => code !== savedCodes[idx]);

    const budgetRaw = s.formBudget.trim();
    const budgetSameLegacy = budgetRaw === (saved.budget_max_won ?? '');
    const budgetNorm = budgetRaw ? amountInput(budgetRaw, NEW_BUDGET_MAX_DIGITS) : null;
    const budgetChanged = budgetSameLegacy
      ? false
      : budgetRaw
        ? budgetNorm !== saved.budget_max_won
        : saved.budget_max_won !== null;

    const areaMin = s.formAreaMin.trim();
    const areaMax = s.formAreaMax.trim();
    const areaChanged =
      areaMin !== (saved.supply_area_min_m2 ?? '') || areaMax !== (saved.supply_area_max_m2 ?? '');

    const moveStart = s.formMoveInStart.trim();
    const moveEnd = s.formMoveInEnd.trim();
    const moveChanged =
      moveStart !== (saved.move_in_start_month ?? '') || moveEnd !== (saved.move_in_end_month ?? '');

    const groups = {
      region: regionChanged ? (s.formCodes.length === 0 ? 'clear' : 'change') : null,
      budget: budgetChanged ? (!budgetRaw ? 'clear' : 'change') : null,
      area: areaChanged ? (!areaMin && !areaMax ? 'clear' : 'change') : null,
      moveIn: moveChanged ? (!moveStart && !moveEnd ? 'clear' : 'change') : null,
    };
    const dirtyCount = Object.values(groups).filter(Boolean).length;
    return { dirtyCount, groups };
  }

  function updateLightweightFormIndicators() {
    const slot = root.querySelector('#profile-page-slot');
    if (!slot || !s.profile) return;
    const saved = readStoredConditions(s.profile.conditions);
    const { dirtyCount } = computeFormDiffMeta();
    const badgeEl = slot.querySelector('#profile-draft-indicator');
    if (badgeEl) {
      badgeEl.textContent = dirtyCount > 0 ? `편집 초안 · ${dirtyCount}개 항목 변경됨` : '저장값과 같음';
      badgeEl.className = 'badge ' + (dirtyCount > 0 ? 'upcoming' : 'closed');
    }
    const resetBtn = slot.querySelector('[data-profile="reset-form"]');
    if (resetBtn) resetBtn.disabled = s.formSubmitting || dirtyCount === 0;
    const budgetPreview = slot.querySelector('#profile-budget-preview');
    if (budgetPreview) {
      const raw = s.formBudget.trim();
      const digits = raw ? amountInput(raw, NEW_BUDGET_MAX_DIGITS) : null;
      budgetPreview.textContent = !raw
        ? '비워 두면 기존 예산을 해제합니다.'
        : raw === saved.budget_max_won && ANY_BUDGET_RE.test(raw)
          ? formatWonExact(raw)
          : digits !== null
            ? formatWonExact(digits)
            : '20자리 이하의 원 단위 정수로 입력하세요.';
    }
    const reasonCount = slot.querySelector('#profile-reason-count');
    if (reasonCount) {
      const len = codePointLength(s.formReason.trim());
      reasonCount.textContent = `${len} / ${MAX_REASON_CODE_POINTS}`;
      reasonCount.classList.toggle('is-over', len > MAX_REASON_CODE_POINTS);
    }
  }

  function runDraftParse({ silent = false } = {}) {
    const text = s.draftMessage.trim();
    if (!text) {
      s.draftParseState = null;
      s.draftRetry = null;
      if (!silent) syncView();
      return;
    }
    let parsed;
    try {
      parsed = parseSharedProfileMessage(text, s.regions);
    } catch {
      parsed = { error: '문장을 해석하지 못했습니다. 직접 수정 폼을 사용해 주세요.' };
    }
    if (parsed === null) {
      s.draftParseState = { kind: 'ordinary' };
      s.draftRetry = null;
      if (!silent) announce('공유 프로필 변경 요청이 감지되지 않았습니다.');
    } else if (isPlainObject(parsed) && typeof parsed.error === 'string') {
      s.draftParseState = { kind: 'error', message: parsed.error };
      s.draftRetry = null;
      if (!silent) announce(parsed.error);
    } else if (isPlainObject(parsed) && isPlainObject(parsed.patch)) {
      const cleanPatch = sanitizeDraftPatch(parsed.patch);
      if (!cleanPatch) {
        s.draftParseState = {
          kind: 'error',
          message: '공유 프로필에서 지원하는 탐색 조건 형식으로 해석하지 못했습니다. 직접 수정 폼을 사용해 주세요.',
        };
        s.draftRetry = null;
      } else {
        const rawReason =
          typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : text;
        const reason = sliceCodePoints(rawReason, MAX_REASON_CODE_POINTS);
        s.draftParseState = { kind: 'parsed', patch: cleanPatch, reason };
        if (!silent) announce('변경 초안을 해석했습니다. 확인 후 변경안으로 등록하세요.');
      }
    } else {
      s.draftParseState = {
        kind: 'error',
        message: '문장을 해석하지 못했습니다. 직접 수정 폼을 사용해 주세요.',
      };
      s.draftRetry = null;
    }
    if (!silent) syncView();
  }

  async function loadProfile({ preserveForm = false, silent = false } = {}) {
    const owner = user()?.id;
    if (!owner || !s.active || owner !== s.ownerId) return;
    const token = generation;
    profileController?.abort();
    const controller = new AbortController();
    profileController = controller;
    s.loading = true;
    s.loadError = null;
    if (!silent) syncView();
    try {
      const data = await api.readSharedProfile(controller.signal, null);
      if (token !== generation || profileController !== controller || user()?.id !== owner) return;
      s.profile = {
        revision: data.revision,
        updatedAt: data.updatedAt,
        conditions: readStoredConditions(data.conditions),
        destination: data.destination,
      };
      s.proposals = data.proposals.slice();
      s.nextCursor = data.nextCursor;
      s.seenCursors = new Set();
      s.loadMoreError = null;
      s.loadError = null;
      if (!preserveForm || !s.formEdited) {
        hydrateFormFromProfile(s.profile.conditions);
      }
    } catch (error) {
      if (token !== generation || profileController !== controller || user()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      s.loadError = error;
    } finally {
      if (token === generation && profileController === controller) {
        profileController = null;
        s.loading = false;
        syncView();
      }
    }
  }

  async function loadRegions({ silent = false } = {}) {
    const owner = user()?.id;
    if (!owner || !s.active || owner !== s.ownerId) return;
    const token = generation;
    s.regionsLoading = true;
    s.regionsError = null;
    if (!silent) syncView();
    try {
      const data = await api.listSearchRegions();
      if (token !== generation || user()?.id !== owner) return;
      if (
        !data ||
        data.contractVersion !== 'notice-regions/v1' ||
        data.dataOrigin !== 'collected' ||
        !Array.isArray(data.regions)
      ) {
        throw Object.assign(new Error('profile_regions_unavailable'), {
          code: 'profile_regions_unavailable',
        });
      }
      s.regions = data.regions.filter(
        (r) => r && typeof r.code === 'string' && REGION_CODE_RE.test(r.code) && typeof r.name === 'string',
      );
      s.regionsError = null;
    } catch (error) {
      if (token !== generation || user()?.id !== owner) return;
      s.regions = [];
      s.regionsError = error;
    } finally {
      if (token === generation) {
        s.regionsLoading = false;
        if (s.draftAutoParse && s.draftMessage.trim()) {
          s.draftAutoParse = false;
          runDraftParse({ silent: true });
        }
        syncView();
      }
    }
  }

  function enter(draft = null) {
    reset();
    const owner = user()?.id;
    if (!owner) {
      syncView();
      return;
    }
    s.active = true;
    s.ownerId = owner;
    if (isPlainObject(draft)) {
      const aid =
        typeof draft.analysisId === 'string' && UUID_RE.test(draft.analysisId)
          ? draft.analysisId.toLowerCase()
          : null;
      const rid =
        typeof draft.runId === 'string' && UUID_RE.test(draft.runId) ? draft.runId.toLowerCase() : null;
      if (aid && rid) s.scope = { analysisId: aid, runId: rid };
      if (typeof draft.message === 'string' && draft.message.trim()) {
        s.draftMessage = draft.message;
        s.draftFromComparison = true;
        s.draftOpen = true;
        s.draftAutoParse = true;
      }
    }
    void loadProfile({ silent: true });
    void loadRegions({ silent: true });
    syncView();
  }

  function addRegionFromInput() {
    if (s.regionsError || s.regionsLoading) {
      s.formError = '공식 지역 목록을 불러온 뒤 지역을 추가할 수 있습니다.';
      return false;
    }
    const term = s.formRegionInput.trim();
    if (!term) {
      s.formError = '추가할 시·군·구 이름이나 5자리 공식 코드를 입력하세요.';
      return false;
    }
    const found = s.regions.filter(
      (r) => r.code === term || r.name === term || (term && r.name.split(' ').at(-1) === term),
    );
    if (found.length !== 1) {
      s.formError = '목록에서 시·군·구 전체 이름이나 5자리 공식 코드 하나를 선택해 주세요.';
      return false;
    }
    if (!s.formCodes.includes(found[0].code)) {
      if (s.formCodes.length >= MAX_REGIONS) {
        s.formError = `희망 지역은 최대 ${MAX_REGIONS}개까지 선택할 수 있습니다.`;
        return false;
      }
      s.formCodes = [...s.formCodes, found[0].code];
      s.formEdited = true;
    }
    s.formRegionInput = '';
    s.formError = '';
    return true;
  }

  function buildFormPatch() {
    if (!s.profile) throw new Error('저장된 프로필을 먼저 불러와 주세요.');
    const saved = readStoredConditions(s.profile.conditions);
    const patch = {};

    // 1. 희망 지역 (바뀐 경우만 포함)
    const savedCodes = saved.region_codes ?? [];
    const distinctCodes = [...new Set(s.formCodes)];
    if (distinctCodes.length > MAX_REGIONS) {
      throw new Error(`희망 지역은 최대 ${MAX_REGIONS}개까지 선택할 수 있습니다.`);
    }
    if (!distinctCodes.every((code) => REGION_CODE_RE.test(code))) {
      throw new Error('희망 지역 코드는 5자리 숫자여야 합니다.');
    }
    const regionChanged =
      distinctCodes.length !== savedCodes.length ||
      distinctCodes.some((code, idx) => code !== savedCodes[idx]);
    if (regionChanged) {
      patch.region_codes = distinctCodes.length ? distinctCodes : null;
    }

    // 2. 최대 구매 예산 (기존 긴 유효 예산을 건드리지 않았으면 그대로 보존)
    const budgetRaw = s.formBudget.trim();
    if (budgetRaw !== (saved.budget_max_won ?? '')) {
      if (!budgetRaw) {
        if (saved.budget_max_won !== null) patch.budget_max_won = null;
      } else {
        const digits = amountInput(budgetRaw, NEW_BUDGET_MAX_DIGITS);
        if (digits === null) {
          throw new Error('최대 구매 예산은 20자리 이하의 원 단위 정수로 입력해 주세요.');
        }
        if (digits !== saved.budget_max_won) patch.budget_max_won = digits;
      }
    }

    // 3. 희망 공급면적 (한쪽만 저장된 기존 값을 건드리지 않았으면 그대로 보존, 수정 시 양쪽 함께 제출)
    const minStr = s.formAreaMin.trim();
    const maxStr = s.formAreaMax.trim();
    const areaTouched =
      minStr !== (saved.supply_area_min_m2 ?? '') || maxStr !== (saved.supply_area_max_m2 ?? '');
    if (areaTouched) {
      if (!minStr && !maxStr) {
        if (saved.supply_area_min_m2 !== null || saved.supply_area_max_m2 !== null) {
          patch.supply_area_min_m2 = null;
          patch.supply_area_max_m2 = null;
        }
      } else {
        if (!minStr || !maxStr) {
          throw new Error('공급면적은 최소·최대 값을 함께 입력하거나 둘 다 비워 해제해 주세요.');
        }
        if (!exactArea(minStr) || !exactArea(maxStr)) {
          throw new Error('공급면적은 0보다 큰 소수 또는 정수(㎡)로 입력해 주세요.');
        }
        if (compareDecimals(minStr, maxStr) > 0) {
          throw new Error('최대 공급면적은 최소 공급면적 이상이어야 합니다.');
        }
        patch.supply_area_min_m2 = minStr;
        patch.supply_area_max_m2 = maxStr;
      }
    }

    // 4. 희망 입주월 (한쪽만 저장된 기존 값을 건드리지 않았으면 그대로 보존, 수정 시 양쪽 함께 제출)
    const startStr = s.formMoveInStart.trim();
    const endStr = s.formMoveInEnd.trim();
    const moveTouched =
      startStr !== (saved.move_in_start_month ?? '') || endStr !== (saved.move_in_end_month ?? '');
    if (moveTouched) {
      if (!startStr && !endStr) {
        if (saved.move_in_start_month !== null || saved.move_in_end_month !== null) {
          patch.move_in_start_month = null;
          patch.move_in_end_month = null;
        }
      } else {
        if (!startStr || !endStr) {
          throw new Error('입주 예정월은 시작월과 종료월을 함께 입력하거나 둘 다 비워 해제해 주세요.');
        }
        if (!MONTH_RE.test(startStr) || !MONTH_RE.test(endStr) || startStr > endStr) {
          throw new Error('입주 시작월과 종료월을 YYYY-MM 형식으로 순서대로 입력해 주세요.');
        }
        patch.move_in_start_month = startStr;
        patch.move_in_end_month = endStr;
      }
    }

    if (!Object.keys(patch).length) {
      throw new Error('저장된 공유 프로필과 바뀐 항목이 없습니다.');
    }

    const reasonInput = s.formReason.trim();
    if (codePointLength(reasonInput) > MAX_REASON_CODE_POINTS) {
      throw new Error(`변경 사유는 ${MAX_REASON_CODE_POINTS}자(유니코드 문자 기준) 이하로 입력해 주세요.`);
    }
    const reason = reasonInput || '공유 프로필 화면에서 직접 변경안 제안';
    return { patch, reason };
  }

  function applyProfileSnapshot(data, { preserveForm = false } = {}) {
    s.profile = {
      revision: data.revision,
      updatedAt: data.updatedAt,
      conditions: readStoredConditions(data.conditions),
      destination: data.destination,
    };
    s.proposals = data.proposals.slice();
    s.nextCursor = data.nextCursor;
    s.seenCursors = new Set();
    s.loadMoreError = null;
    if (!preserveForm) hydrateFormFromProfile(s.profile.conditions);
  }

  async function submitProposal({ source, patch, reason, scope = null }) {
    const owner = user()?.id;
    if (!owner || !s.active || owner !== s.ownerId || !s.profile) return;
    if (s.formSubmitting || s.draftSubmitting || s.decidingId) return;

    const cleanPatch = sanitizeDraftPatch(patch);
    if (!cleanPatch) {
      if (source === 'form') {
        s.formError = '지원하는 탐색 조건 형식을 확인해 주세요.';
        syncView();
      }
      return;
    }

    const baseRevision = s.profile.revision;
    const signature = canonicalSignature(baseRevision, cleanPatch, reason, scope);
    const existingRetry = source === 'form' ? s.formRetry : s.draftRetry;
    const requestId =
      existingRetry && existingRetry.signature === signature
        ? existingRetry.requestId
        : crypto.randomUUID();

    const token = generation;
    proposeController?.abort();
    const controller = new AbortController();
    proposeController = controller;

    if (source === 'form') {
      s.formSubmitting = true;
      s.formError = '';
    } else {
      s.draftSubmitting = true;
    }
    s.banner = null;
    syncView();

    try {
      const payload = {
        requestId,
        baseRevision,
        patch: cleanPatch,
        reason,
        ...(scope?.analysisId ? { analysisId: scope.analysisId } : {}),
        ...(scope?.runId ? { runId: scope.runId } : {}),
      };
      const data = await api.proposeSearchProfile(payload, controller.signal);
      if (token !== generation || proposeController !== controller || user()?.id !== owner) return;

      applyProfileSnapshot(data, { preserveForm: source !== 'form' && s.formEdited });
      if (source === 'form') {
        s.formRetry = null;
        s.formError = '';
        s.editOpen = false;
      } else {
        s.draftRetry = null;
        s.draftMessage = '';
        s.draftFromComparison = false;
        s.draftOpen = false;
        s.draftParseState = null;
      }
      s.banner = {
        tone: 'info',
        text: '변경안을 등록했습니다. 대기 중인 변경안에서 반영 여부를 선택하세요.',
      };
      announce('공유 프로필 변경안을 등록했습니다. 대기 중인 변경안에서 반영 여부를 선택하세요.');
    } catch (error) {
      if (token !== generation || proposeController !== controller || user()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      const isStale = error?.code === 'profile_changed';
      if (source === 'form') {
        s.formRetry = isStale ? null : { signature, requestId, error };
        s.formError = errorText(error);
      } else {
        s.draftRetry = isStale ? null : { signature, requestId, error };
      }
      if (isStale) {
        s.banner = { tone: 'partial', text: errorText(error) };
        announce(errorText(error));
        proposeController = null;
        s.formSubmitting = false;
        s.draftSubmitting = false;
        await loadProfile({ preserveForm: true });
        return;
      }
      announce(errorText(error));
    } finally {
      if (token === generation && proposeController === controller) {
        proposeController = null;
        s.formSubmitting = false;
        s.draftSubmitting = false;
        syncView({
          focusSelector:
            s.banner?.tone === 'info' ? '[data-proposal-card] [data-decision="approve"], #profile-banner' : null,
        });
      }
    }
  }

  async function decide(changeId, decision) {
    const owner = user()?.id;
    if (!owner || !s.active || owner !== s.ownerId || !s.profile) return;
    if (s.decidingId || s.formSubmitting || s.draftSubmitting) return;
    if (!UUID_RE.test(changeId) || !['approve', 'reject', 'cancel'].includes(decision)) return;
    const target = s.proposals.find((p) => p.id === changeId && p.status === 'pending');
    if (!target) return;

    const token = generation;
    decideController?.abort();
    const controller = new AbortController();
    decideController = controller;
    s.decidingId = changeId;
    s.decidingAction = decision;
    s.decisionError = null;
    s.banner = null;
    syncView();

    try {
      const data = await api.decideSearchProfile(changeId, decision, controller.signal);
      if (token !== generation || decideController !== controller || user()?.id !== owner) return;
      applyProfileSnapshot(data, { preserveForm: s.formEdited });
      s.decisionError = null;
      const doneText =
        decision === 'approve'
          ? `공유 프로필 v${data.revision}에 반영했습니다. 다음 맞춤 검색부터 적용되며 기존 분석은 바뀌지 않습니다.`
          : decision === 'reject'
            ? `변경안을 거절했습니다. 공유 프로필 v${data.revision} 상태를 유지합니다.`
            : `변경안을 취소했습니다. 공유 프로필 v${data.revision} 상태를 유지합니다.`;
      s.banner = { tone: decision === 'approve' ? 'verified' : 'info', text: doneText };
      announce(doneText);
    } catch (error) {
      if (token !== generation || decideController !== controller || user()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      const code = error?.code ?? '';
      s.decisionError = { changeId, decision, error };
      announce(errorText(error));
      if (code === 'profile_changed' || code === 'profile_proposal_not_found') {
        s.banner = { tone: 'partial', text: errorText(error) };
        decideController = null;
        s.decidingId = null;
        s.decidingAction = null;
        await loadProfile({ preserveForm: true });
        return;
      }
    } finally {
      if (token === generation && decideController === controller) {
        decideController = null;
        s.decidingId = null;
        s.decidingAction = null;
        syncView({ focusSelector: s.banner ? '#profile-banner' : null });
      }
    }
  }

  async function loadOlderHistory() {
    const owner = user()?.id;
    if (!owner || !s.active || owner !== s.ownerId || !s.nextCursor || s.loadingMore) return;
    const cursor = s.nextCursor;
    if (s.seenCursors.has(cursor)) {
      s.nextCursor = null;
      syncView();
      return;
    }

    const token = generation;
    moreController?.abort();
    const controller = new AbortController();
    moreController = controller;
    s.loadingMore = true;
    s.loadMoreError = null;
    syncView();

    try {
      const data = await api.readSharedProfile(controller.signal, cursor);
      if (token !== generation || moreController !== controller || user()?.id !== owner) return;
      s.seenCursors.add(cursor);
      const byId = new Map(s.proposals.map((p) => [p.id, p]));
      for (const item of data.proposals) {
        if (!byId.has(item.id)) byId.set(item.id, item);
      }
      s.proposals = [...byId.values()];
      s.nextCursor =
        data.nextCursor && !s.seenCursors.has(data.nextCursor) && data.nextCursor !== cursor
          ? data.nextCursor
          : null;
      s.loadMoreError = null;
      announce(`이전 변경 이력 ${data.proposals.length}건을 더 불러왔습니다.`);
    } catch (error) {
      if (token !== generation || moreController !== controller || user()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      s.loadMoreError = error;
      announce(errorText(error));
    } finally {
      if (token === generation && moreController === controller) {
        moreController = null;
        s.loadingMore = false;
        syncView();
      }
    }
  }

  function renderDraftSection(regionMap) {
    const parsed = s.draftParseState;
    const saved = s.profile ? readStoredConditions(s.profile.conditions) : null;
    const hasMessage = Boolean(s.draftMessage.trim());
    const busy = s.draftSubmitting || s.formSubmitting || Boolean(s.decidingId);

    let parseOutput = '';
    if (s.draftAutoParse && s.regionsLoading) {
      parseOutput = `<p class="profile-draft-status" role="status">${icon('loader-circle', 'spin')}공식 지역 목록을 불러와 초안을 해석하고 있습니다.</p>`;
    } else if (parsed?.kind === 'ordinary') {
      parseOutput = `<div class="profile-draft-note" role="status">${icon('info')}<p>입력한 문장에서 공유 프로필 변경 요청을 찾지 못했습니다. 희망 지역·최대 예산·공급면적·입주 예정월 변경 문장을 입력하거나 직접 수정 폼을 사용해 주세요.</p></div>`;
    } else if (parsed?.kind === 'error') {
      parseOutput = `<div class="profile-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(parsed.message)}</p></div></div>`;
    } else if (parsed?.kind === 'parsed' && saved) {
      const prev = previewPreviousForPatch(saved, parsed.patch);
      const rows = buildDiffRows(prev, parsed.patch, regionMap);
      const retryErr = s.draftRetry?.error ?? null;
      const errCode = retryErr?.code ?? '';
      parseOutput = `<div class="profile-draft-preview" data-draft-preview>
        <div class="profile-draft-preview-head">
          <strong>변경안 초안 미리보기</strong>
          ${badge('partial', 'clock-3', '미제출 · 반영 전')}
        </div>
        ${renderDiffList(rows)}
        <p class="profile-draft-reason"><strong>근거</strong> ${esc(parsed.reason)}</p>
        ${
          retryErr
            ? `<div class="profile-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(errorText(retryErr))}</p>${
                errCode === 'authentication_required'
                  ? '<button type="button" class="action secondary compact" data-action="auth">로그인</button>'
                  : `<button type="button" class="action secondary compact" data-profile="retry-draft"${busy ? ' disabled' : ''}>같은 요청으로 다시 시도</button>`
              }</div></div>`
            : ''
        }
        <div class="profile-draft-actions">
          <button type="button" class="action primary compact" data-profile="submit-draft"${busy || !s.profile ? ' disabled' : ''}>${icon(s.draftSubmitting ? 'loader-circle' : 'check', s.draftSubmitting ? 'spin' : '')}${s.draftSubmitting ? '변경안 등록 중' : '변경안으로 등록'}</button>
          <button type="button" class="action secondary compact" data-profile="clear-draft"${busy ? ' disabled' : ''}>초안 지우기</button>
        </div>
      </div>`;
    }

    return `<section id="profile-draft-panel" class="panel profile-draft-card is-highlighted" aria-labelledby="profile-draft-heading">
      <div class="profile-card-head">
        <div class="profile-title-group">
          <span class="profile-avatar" aria-hidden="true">${icon('message-square')}</span>
          <div>
            <h2 id="profile-draft-heading">${s.draftFromComparison ? '비교 대화에서 가져온 변경 초안' : '문장으로 변경안 초안 만들기'}</h2>
          </div>
        </div>
        <div class="profile-head-controls">
          ${badge('unknown', 'circle-dashed', '임시 초안 · 미반영')}
          ${!s.draftFromComparison ? `<button type="button" class="text-button" data-profile="toggle-draft">닫기</button>` : ''}
        </div>
      </div>
      <form id="profile-draft-form" class="profile-draft-form" novalidate>
        <label for="profile-draft-message">변경 요청 문장</label>
        <textarea id="profile-draft-message" name="draftMessage" rows="2" placeholder="예: 공유 프로필 희망 지역 서울특별시 성동구, 예산 8억으로 바꿔줘"${busy ? ' readonly' : ''}>${esc(s.draftMessage)}</textarea>
        <div class="profile-draft-bar">
          <span class="field-help">보유 자금·전용면적·출퇴근 목적지 변경은 지원하지 않습니다.</span>
          <div class="profile-draft-bar-actions">
            ${hasMessage ? `<button type="button" class="text-button" data-profile="clear-draft"${busy ? ' disabled' : ''}>비우기</button>` : ''}
            <button type="submit" class="action secondary compact" data-profile="parse-draft"${busy || s.regionsLoading ? ' disabled' : ''}>${icon('sliders-horizontal')}초안 해석</button>
          </div>
        </div>
      </form>
      ${parseOutput}
    </section>`;
  }

  function renderPendingSection(pendingList, regionMap) {
    if (!pendingList.length) return '';
    const rev = s.profile.revision;
    const locked = Boolean(s.decidingId) || s.formSubmitting || s.draftSubmitting;
    const cards = pendingList
      .map((p) =>
        renderProfileChangeCard(p, {
          showActions: true,
          regions: regionMap,
          currentRevision: rev,
          busy: s.decidingId === p.id,
          busyDecision: s.decidingId === p.id ? s.decidingAction : null,
          locked,
          error: s.decisionError?.changeId === p.id ? s.decisionError : null,
          showReviewButton: true,
        }),
      )
      .join('');

    return `<section class="profile-pending-group" aria-labelledby="profile-pending-heading">
      <div class="profile-section-title">
        <h2 id="profile-pending-heading">대기 중인 변경안 <span class="count-pill">${esc(pendingList.length)}</span></h2>
      </div>
      <div class="profile-pending-list">${cards}</div>
    </section>`;
  }

  function renderSavedCard(regionMap) {
    const c = readStoredConditions(s.profile.conditions);
    const { dirtyCount } = computeFormDiffMeta();
    const hasRegions = Boolean(c.region_codes?.length);
    const hasBudget = c.budget_max_won !== null;
    const hasAreaMin = Boolean(c.supply_area_min_m2);
    const hasAreaMax = Boolean(c.supply_area_max_m2);
    const hasAnyArea = hasAreaMin || hasAreaMax;
    const areaPartial = hasAreaMin !== hasAreaMax;
    const hasMoveStart = Boolean(c.move_in_start_month);
    const hasMoveEnd = Boolean(c.move_in_end_month);
    const hasAnyMove = hasMoveStart || hasMoveEnd;
    const movePartial = hasMoveStart !== hasMoveEnd;
    const pyeong = hasAnyArea ? toPyeongHint(c.supply_area_min_m2, c.supply_area_max_m2) : '';

    const editLabel = s.editOpen
      ? '수정 닫기'
      : dirtyCount > 0
        ? `수정 이어하기 (${dirtyCount}건)`
        : '직접 수정';

    return `<section class="panel profile-saved-card" aria-labelledby="profile-saved-heading">
      <div class="profile-card-head">
        <div>
          <h2 id="profile-saved-heading">탐색 조건</h2>
          <p class="profile-card-sub">다음 맞춤 검색에 쓰이는 확인된 조건입니다.</p>
        </div>
        <div class="profile-head-controls">
          <button type="button" class="action secondary compact" data-profile="toggle-edit" aria-expanded="${s.editOpen}" aria-controls="profile-edit-panel">${icon('sliders-horizontal')}${esc(editLabel)}</button>
        </div>
      </div>
      <dl class="profile-saved-list">
        <div class="profile-saved-row">
          <dt>희망 지역</dt>
          <dd>
            <strong class="${hasRegions ? '' : 'is-empty'}">${hasRegions ? esc(formatRegionList(c.region_codes, regionMap)) : '—'}</strong>
            ${hasRegions && s.regionsError ? '<small>공식 지역명을 불러오지 못해 5자리 코드로 표시합니다.</small>' : ''}
          </dd>
          <span class="profile-row-badge">${hasRegions ? '' : badge('unknown', 'circle-help', '미설정')}</span>
        </div>
        <div class="profile-saved-row">
          <dt>최대 구매 예산</dt>
          <dd>
            <strong class="num${hasBudget ? '' : ' is-empty'}">${hasBudget ? esc(formatWonExact(c.budget_max_won)) : '—'}</strong>
            <small>분양가 + 필수 옵션 호실 소계 상한</small>
          </dd>
          <span class="profile-row-badge">${hasBudget ? '' : badge('unknown', 'circle-help', '미설정')}</span>
        </div>
        <div class="profile-saved-row">
          <dt>희망 공급면적</dt>
          <dd>
            <strong class="num${hasAnyArea ? '' : ' is-empty'}">${hasAnyArea ? esc(formatAreaDisplay(c.supply_area_min_m2, c.supply_area_max_m2)) : '—'}</strong>
            <small>${areaPartial ? '한쪽 값만 저장되어 있습니다. 직접 수정에서 양쪽을 채우거나 둘 다 비울 수 있습니다.' : `${hasAnyArea && pyeong ? esc(pyeong) + ' · ' : ''}공급면적 기준 (전용면적과 구분)`}</small>
          </dd>
          <span class="profile-row-badge">${areaPartial ? badge('partial', 'triangle-alert', '한쪽만 저장됨 · 범위 확인') : hasAnyArea ? '' : badge('unknown', 'circle-help', '미설정')}</span>
        </div>
        <div class="profile-saved-row">
          <dt>희망 입주월</dt>
          <dd>
            <strong class="num${hasAnyMove ? '' : ' is-empty'}">${hasAnyMove ? esc(formatMoveInDisplay(c.move_in_start_month, c.move_in_end_month)) : '—'}</strong>
            <small>${movePartial ? '한쪽 값만 저장되어 있습니다. 직접 수정에서 양쪽을 채우거나 둘 다 비울 수 있습니다.' : '공식 입주 예정월 범위 기준'}</small>
          </dd>
          <span class="profile-row-badge">${movePartial ? badge('partial', 'triangle-alert', '한쪽만 저장됨 · 범위 확인') : hasAnyMove ? '' : badge('unknown', 'circle-help', '미설정')}</span>
        </div>
      </dl>
      <p class="profile-scope-notice">${icon('info')}<span>보유 현금·추가 자금 등 상세 자금은 공유 프로필에 넣지 않고 각 분석의 호실 자금표에 따로 저장합니다.</span></p>
    </section>`;
  }

  function renderFormPanel(regionMap) {
    if (!s.editOpen) return '';
    const saved = readStoredConditions(s.profile.conditions);
    const { dirtyCount, groups } = computeFormDiffMeta();
    const busy = s.formSubmitting || s.draftSubmitting || Boolean(s.decidingId);
    const rawBudget = s.formBudget.trim();
    const budgetDigits = rawBudget ? amountInput(rawBudget, NEW_BUDGET_MAX_DIGITS) : null;
    const budgetHint = !rawBudget
      ? '비워 두면 기존 예산을 해제합니다.'
      : rawBudget === saved.budget_max_won && ANY_BUDGET_RE.test(rawBudget)
        ? formatWonExact(rawBudget)
        : budgetDigits !== null
          ? formatWonExact(budgetDigits)
          : '20자리 이하의 원 단위 정수로 입력하세요.';

    const areaPartial = Boolean(saved.supply_area_min_m2) !== Boolean(saved.supply_area_max_m2);
    const movePartial = Boolean(saved.move_in_start_month) !== Boolean(saved.move_in_end_month);
    const reasonLen = codePointLength(s.formReason.trim());

    const groupStatusTag = (kind) =>
      kind === 'clear'
        ? '<span class="profile-group-tag is-clear">해제 예정</span>'
        : kind === 'change'
          ? '<span class="profile-group-tag is-change">변경 예정</span>'
          : '';

    const retryErr = s.formRetry?.error ?? null;
    const retryCode = retryErr?.code ?? '';

    return `<section id="profile-edit-panel" class="panel profile-form-card" aria-labelledby="profile-form-heading">
      <div class="profile-card-head">
        <div>
          <h2 id="profile-form-heading">탐색 조건 변경안 만들기</h2>
          <p class="profile-card-sub">바꾸거나 비울 항목만 편집해 변경안으로 등록합니다.</p>
        </div>
        <div class="profile-head-controls">
          <span id="profile-draft-indicator" class="badge ${dirtyCount > 0 ? 'upcoming' : 'closed'}">${dirtyCount > 0 ? `편집 초안 · ${dirtyCount}개 항목 변경됨` : '저장값과 같음'}</span>
          <button type="button" class="text-button" data-profile="toggle-edit">닫기</button>
        </div>
      </div>
      <form id="profile-edit-form" class="profile-edit-form" novalidate>
        <div class="profile-field-group">
          <div class="profile-field-head">
            <label for="profile-region-input">희망 지역 (시·군·구, 최대 50곳) ${groupStatusTag(groups.region)}</label>
            ${s.formCodes.length ? `<button type="button" class="text-action" data-profile="clear-regions"${busy ? ' disabled' : ''}>희망 지역 비우기</button>` : ''}
          </div>
          ${
            s.regionsError
              ? `<div class="profile-region-warn" role="status">${icon('triangle-alert')}<div><p>${esc(errorText(s.regionsError))} 예산·공급면적·입주 예정월 변경안은 그대로 제안할 수 있습니다.</p><button type="button" class="text-action" data-profile="retry-regions"${s.regionsLoading ? ' disabled' : ''}>${icon('refresh-cw')}지역 목록 다시 불러오기</button></div></div>`
              : ''
          }
          <div class="input-action">
            <input id="profile-region-input" name="formRegionInput" list="profile-region-options" value="${esc(s.formRegionInput)}" placeholder="${s.regionsLoading ? '공식 지역 목록을 불러오는 중...' : s.regionsError ? '지역 목록 확인 후 추가 가능' : '시·군·구 이름 또는 5자리 코드'}" autocomplete="off"${busy || s.regionsLoading || Boolean(s.regionsError) ? ' disabled' : ''}>
            <button type="button" class="action secondary compact" data-profile="add-region"${busy || s.regionsLoading || Boolean(s.regionsError) ? ' disabled' : ''}>추가</button>
          </div>
          <datalist id="profile-region-options">${s.regions
            .filter((r) => !s.formCodes.includes(r.code))
            .map((r) => `<option value="${esc(r.name)}">${esc(r.code)}</option>`)
            .join('')}</datalist>
          <div class="region-chips" aria-label="선택한 희망 지역">${s.formCodes
            .map(
              (code) =>
                `<button type="button" data-profile="remove-region" data-code="${esc(code)}" aria-label="${esc(regionMap.get(code) || code)} 제외"${busy ? ' disabled' : ''}>${esc(regionMap.get(code) || `코드 ${code}`)} ${icon('x')}</button>`,
            )
            .join('')}</div>
          <p class="field-help">선택됨 ${esc(s.formCodes.length)} / ${MAX_REGIONS}곳 · 모두 제외하면 희망 지역 설정을 해제합니다.</p>
        </div>

        <div class="profile-field-group">
          <div class="profile-field-head">
            <label for="profile-budget">최대 구매 예산 (원) ${groupStatusTag(groups.budget)}</label>
            ${s.formBudget.trim() ? `<button type="button" class="text-action" data-profile="clear-budget"${busy ? ' disabled' : ''}>예산 비우기</button>` : ''}
          </div>
          <div class="unit-input">
            <input id="profile-budget" name="formBudget" inputmode="numeric" autocomplete="off" placeholder="예: 700,000,000" value="${esc(s.formBudget)}" aria-describedby="profile-budget-preview"${busy ? ' readonly' : ''}>
            <span>원</span>
          </div>
          <p id="profile-budget-preview" class="field-help num">${esc(budgetHint)}</p>
        </div>

        <fieldset class="profile-field-group">
          <div class="profile-field-head">
            <legend>희망 공급면적 (㎡) ${groupStatusTag(groups.area)}</legend>
            ${s.formAreaMin.trim() || s.formAreaMax.trim() ? `<button type="button" class="text-action" data-profile="clear-area"${busy ? ' disabled' : ''}>공급면적 모두 비우기</button>` : ''}
          </div>
          ${areaPartial ? '<p class="profile-partial-hint">한쪽 값만 저장되어 있습니다. 다른 항목만 바꾸면 그대로 유지되며, 수정할 때는 양쪽을 채우거나 둘 다 비울 수 있습니다.</p>' : ''}
          <div class="paired">
            <label for="profile-area-min">최소 (㎡)
              <input id="profile-area-min" name="formAreaMin" inputmode="decimal" autocomplete="off" placeholder="예: 84.5" value="${esc(s.formAreaMin)}" aria-describedby="profile-area-help"${busy ? ' readonly' : ''}>
            </label>
            <label for="profile-area-max">최대 (㎡)
              <input id="profile-area-max" name="formAreaMax" inputmode="decimal" autocomplete="off" placeholder="예: 115" value="${esc(s.formAreaMax)}" aria-describedby="profile-area-help"${busy ? ' readonly' : ''}>
            </label>
          </div>
          <p id="profile-area-help" class="field-help">전용면적이 아닌 공급면적 기준입니다. 최소·최대를 함께 입력하거나 둘 다 비워 해제합니다.</p>
        </fieldset>

        <fieldset class="profile-field-group">
          <div class="profile-field-head">
            <legend>희망 입주월 (YYYY-MM) ${groupStatusTag(groups.moveIn)}</legend>
            ${s.formMoveInStart.trim() || s.formMoveInEnd.trim() ? `<button type="button" class="text-action" data-profile="clear-move-in"${busy ? ' disabled' : ''}>입주월 모두 비우기</button>` : ''}
          </div>
          ${movePartial ? '<p class="profile-partial-hint">한쪽 값만 저장되어 있습니다. 다른 항목만 바꾸면 그대로 유지되며, 수정할 때는 양쪽을 채우거나 둘 다 비울 수 있습니다.</p>' : ''}
          <div class="paired months">
            <label for="profile-move-in-start">시작월
              <input id="profile-move-in-start" name="formMoveInStart" type="month" placeholder="YYYY-MM" value="${esc(s.formMoveInStart)}" aria-describedby="profile-move-in-help"${busy ? ' readonly' : ''}>
            </label>
            <label for="profile-move-in-end">종료월
              <input id="profile-move-in-end" name="formMoveInEnd" type="month" placeholder="YYYY-MM" value="${esc(s.formMoveInEnd)}" aria-describedby="profile-move-in-help"${busy ? ' readonly' : ''}>
            </label>
          </div>
          <p id="profile-move-in-help" class="field-help">시작월과 종료월을 함께 입력하거나 둘 다 비워 해제합니다.</p>
        </fieldset>

        <div class="profile-field-group">
          <div class="profile-field-head">
            <label for="profile-reason">변경 사유 (선택)</label>
            <span id="profile-reason-count" class="field-help num${reasonLen > MAX_REASON_CODE_POINTS ? ' is-over' : ''}">${esc(reasonLen)} / ${MAX_REASON_CODE_POINTS}</span>
          </div>
          <input id="profile-reason" name="formReason" autocomplete="off" placeholder="예: 희망 지역과 예산 상한 조정" value="${esc(s.formReason)}"${busy ? ' readonly' : ''}>
        </div>

        ${
          s.formError
            ? `<div class="profile-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(s.formError)}</p>${
                retryErr
                  ? `<div class="profile-error-actions">${
                      retryCode === 'authentication_required'
                        ? '<button type="button" class="action secondary compact" data-action="auth">로그인</button>'
                        : `<button type="button" class="action secondary compact" data-profile="retry-form"${busy ? ' disabled' : ''}>같은 요청으로 다시 시도</button>`
                    }</div>`
                  : ''
              }</div></div>`
            : ''
        }

        <div class="profile-form-actions">
          <button type="button" class="action secondary" data-profile="reset-form"${busy || dirtyCount === 0 ? ' disabled' : ''}>저장값으로 되돌리기</button>
          <button type="submit" class="action primary" data-profile="submit-form"${busy ? ' disabled' : ''}>${icon(s.formSubmitting ? 'loader-circle' : 'sliders-horizontal', s.formSubmitting ? 'spin' : '')}${s.formSubmitting ? '변경안 등록 중' : '변경안 만들기'}</button>
        </div>
      </form>
    </section>`;
  }

  function renderDestinationCard() {
    const dest = s.profile?.destination ?? null;
    const commuteHref = s.scope ? `#run/${s.scope.analysisId}/${s.scope.runId}/commute` : '#analyses';
    const commuteLabel = s.scope ? '이 분석의 출퇴근 경로로 이동' : '내 분석에서 출퇴근 경로 열기';

    return `<section class="panel profile-destination-card" aria-labelledby="profile-dest-heading">
      <div class="profile-card-head">
        <div class="profile-title-group">
          <span class="profile-avatar" aria-hidden="true">${icon('map-pin')}</span>
          <div>
            <h2 id="profile-dest-heading">출퇴근 목적지</h2>
            <p class="profile-card-sub">완료된 분석의 출퇴근 경로 탭에서 저장·해제합니다.</p>
          </div>
        </div>
        ${badge('closed', 'info', '읽기 전용')}
      </div>
      <div class="profile-dest-body">
        <div class="profile-dest-value">
          <span class="profile-dest-label">저장된 목적지</span>
          <strong class="${dest ? '' : 'is-empty'}">${dest ? esc(dest) : '—'}</strong>
          ${dest ? '' : badge('unknown', 'circle-help', '미설정')}
        </div>
        <a class="action secondary compact" href="${esc(commuteHref)}">${esc(commuteLabel)} ${icon('arrow-right')}</a>
      </div>
    </section>`;
  }

  function renderHistorySection(historyList, regionMap) {
    const statusBadge = (status) => {
      if (status === 'approved') return badge('verified', 'circle-check', '반영됨');
      if (status === 'rejected') return badge('closed', 'x', '거절 · 프로필 유지');
      if (status === 'cancelled') return badge('closed', 'circle-minus', '취소 · 프로필 유지');
      return badge('unknown', 'circle-help', '상태 확인 필요');
    };

    const rowsHtml = historyList
      .map((p) => {
        const diffs = buildDiffRows(p.previous, p.patch, regionMap);
        const summary = diffs.map((d) => `${d.field}: ${d.from} → ${d.to}`).join(' / ') || '변경 내용 확인 필요';
        const when = p.decidedAt || p.createdAt;
        const whenText = formatFullStamp(when);
        const muted = p.status !== 'approved';
        const runLink =
          p.analysisId && p.runId
            ? `<a class="text-button profile-history-link" href="#run/${esc(p.analysisId)}/${esc(p.runId)}">관련 분석 ${icon('arrow-right')}</a>`
            : '';
        return `<tr class="${muted ? 'is-muted' : ''}" data-history-id="${esc(p.id)}">
          <th scope="row" class="num" data-label="기준 버전">v${esc(p.baseRevision)}</th>
          <td class="num" data-label="처리 시각">${whenText ? `<time datetime="${esc(when)}">${esc(whenText)}</time>` : '—'}</td>
          <td data-label="바뀐 내용"><span class="profile-history-diff">${esc(summary)}</span></td>
          <td data-label="근거"><span class="profile-history-reason">${esc(p.reason || '—')}</span>${runLink}</td>
          <td data-label="결과">${statusBadge(p.status)}</td>
        </tr>`;
      })
      .join('');

    return `<section class="profile-history-section" aria-labelledby="profile-history-heading">
      <div class="profile-section-title">
        <h2 id="profile-history-heading">변경 이력</h2>
      </div>
      <div class="panel profile-history-panel">
        ${
          historyList.length
            ? `<div class="profile-table-wrap"><table class="profile-history-table">
                <thead>
                  <tr>
                    <th scope="col">기준 버전</th>
                    <th scope="col">처리 시각 (KST)</th>
                    <th scope="col">바뀐 내용</th>
                    <th scope="col">근거</th>
                    <th scope="col">결과</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
              </table></div>`
            : '<p class="profile-history-empty">아직 처리된 변경 이력이 없습니다.</p>'
        }
        ${
          s.loadMoreError
            ? `<div class="profile-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(errorText(s.loadMoreError))}</p><button type="button" class="action secondary compact" data-profile="load-more">다시 불러오기</button></div></div>`
            : ''
        }
        ${
          s.nextCursor
            ? `<div class="profile-history-more">
                <button type="button" class="action secondary compact" data-profile="load-more"${s.loadingMore ? ' disabled' : ''}>${icon(s.loadingMore ? 'loader-circle' : 'chevron-down', s.loadingMore ? 'spin' : '')}${s.loadingMore ? '이전 이력을 불러오는 중' : '이전 이력 더 불러오기'}</button>
              </div>`
            : ''
        }
        <p class="profile-history-foot">거절·취소·무응답은 반영하지 않으며 기존 분석과 보고서 조건은 따로 유지됩니다.</p>
      </div>
    </section>`;
  }

  function innerView() {
    const currentUser = user();
    if (!currentUser) {
      return `<div class="profile-page">
        <header class="section-header profile-header">
          <div class="profile-header-copy">
            <h1>공유 프로필</h1>
            <p>희망 지역, 최대 구매 예산, 공급면적, 입주 예정월을 계정에 저장해 다음 맞춤 검색에 사용합니다.</p>
          </div>
        </header>
        <section class="empty-state profile-guest" aria-labelledby="profile-guest-heading">
          ${icon('shield-check')}
          <h2 id="profile-guest-heading">로그인 후 공유 프로필을 관리할 수 있습니다</h2>
          <p>비로그인 상태에서는 개인 탐색 조건이나 변경 초안을 표시하거나 보관하지 않습니다. 로그인하고 내 공유 프로필을 확인하세요.</p>
          <div class="profile-guest-actions">
            <button type="button" class="action primary" data-action="auth">${icon('log-in')}로그인하기</button>
            <a class="action secondary" href="#notices">오늘의 청약 보기</a>
          </div>
        </section>
      </div>`;
    }

    const regionMap = regionLookup();
    const returnLink = s.scope
      ? `<a class="action secondary compact profile-return-link" href="#run/${esc(s.scope.analysisId)}/${esc(s.scope.runId)}">${icon('arrow-left')}비교 결과로 돌아가기</a>`
      : '';

    const versionPill = s.profile
      ? `<span class="profile-version-pill num">v${esc(s.profile.revision)}${s.profile.updatedAt ? ` · ${esc(formatShortStamp(s.profile.updatedAt))} 반영` : ' · 설정 전'}</span>`
      : '';

    const header = `<header class="profile-header">
      <div class="profile-header-copy">
        <div class="profile-header-title">
          <h1>공유 프로필</h1>
          ${versionPill}
        </div>
        <p>다음 맞춤 검색에 쓰는 공유 탐색 조건입니다. 변경안은 승인할 때만 반영되며 기존 분석과 보고서는 바뀌지 않습니다.</p>
      </div>
      <div class="profile-header-actions">
        ${returnLink}
        ${s.profile && !s.draftOpen ? `<button type="button" class="action secondary compact" data-profile="toggle-draft" aria-expanded="${s.draftOpen}" aria-controls="profile-draft-panel">${icon('message-square')}문장으로 제안</button>` : ''}
        ${s.profile && !s.loading ? `<button type="button" class="action secondary compact" data-profile="reload">${icon('refresh-cw')}새로고침</button>` : ''}
      </div>
    </header>`;

    if (s.loading && !s.profile) {
      return `<div class="profile-page">${header}<section class="empty-state" role="status">${icon('loader-circle', 'spin')}<h2>공유 프로필을 불러오고 있습니다</h2><p>저장된 탐색 조건과 변경 이력을 확인하는 중입니다.</p></section></div>`;
    }

    if (s.loadError && !s.profile) {
      const isAuth = s.loadError.code === 'authentication_required';
      return `<div class="profile-page">${header}<section class="empty-state" role="alert">
        ${icon('triangle-alert')}
        <h2>공유 프로필을 불러오지 못했습니다</h2>
        <p>${esc(errorText(s.loadError))}</p>
        <div class="profile-guest-actions">
          ${
            isAuth
              ? '<button type="button" class="action primary" data-action="auth">다시 로그인</button>'
              : '<button type="button" class="action secondary" data-profile="reload">다시 조회</button>'
          }
        </div>
      </section></div>`;
    }

    if (!s.profile) return `<div class="profile-page">${header}</div>`;

    const pendingList = s.proposals.filter((p) => p.status === 'pending');
    const historyList = s.proposals.filter((p) => p.status !== 'pending');

    const bannerHtml = s.banner
      ? `<div id="profile-banner" class="profile-banner is-${esc(s.banner.tone)}" role="status" tabindex="-1">${icon(
          s.banner.tone === 'verified' ? 'circle-check' : s.banner.tone === 'partial' ? 'triangle-alert' : 'info',
        )}<span>${esc(s.banner.text)}</span></div>`
      : '';

    const loadWarnHtml = s.loadError
      ? `<div class="profile-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(errorText(s.loadError))}</p><button type="button" class="action secondary compact" data-profile="reload">다시 조회</button></div></div>`
      : '';

    return `<div class="profile-page">
      ${header}
      ${bannerHtml}
      ${loadWarnHtml}
      ${s.draftOpen ? renderDraftSection(regionMap) : ''}
      ${renderPendingSection(pendingList, regionMap)}
      <div class="profile-summary-grid">
        ${renderSavedCard(regionMap)}
        ${renderDestinationCard()}
      </div>
      ${renderFormPanel(regionMap)}
      ${renderHistorySection(historyList, regionMap)}
    </div>`;
  }

  function view() {
    return `<div id="profile-page-slot">${innerView()}</div>`;
  }

  root.addEventListener('input', (event) => {
    if (!s.active || !user()) return;
    const field = event.target;
    if (field.id === 'profile-draft-message') {
      s.draftMessage = field.value;
      s.draftRetry = null;
      return;
    }
    if (field.form?.id === 'profile-edit-form' && Object.hasOwn(s, field.name)) {
      s[field.name] = field.value;
      if (field.name !== 'formRegionInput') {
        s.formEdited = true;
        s.formError = '';
        s.formRetry = null;
        updateLightweightFormIndicators();
      }
    }
  });

  root.addEventListener('submit', (event) => {
    if (!s.active || !user()) return;
    if (event.target.id === 'profile-draft-form') {
      event.preventDefault();
      if (s.draftSubmitting || s.regionsLoading) return;
      runDraftParse();
      return;
    }
    if (event.target.id === 'profile-edit-form') {
      event.preventDefault();
      if (s.formSubmitting || s.draftSubmitting || s.decidingId) return;
      if (s.formRegionInput.trim() && !addRegionFromInput()) {
        syncView({ focusSelector: '#profile-region-input' });
        return;
      }
      let built;
      try {
        built = buildFormPatch();
      } catch (err) {
        s.formError = err.message;
        s.formRetry = null;
        syncView();
        return;
      }
      void submitProposal({ source: 'form', patch: built.patch, reason: built.reason, scope: s.scope });
    }
  });

  root.addEventListener('click', (event) => {
    if (!s.active || !user()) return;
    const btn = event.target.closest('[data-profile]');
    if (!btn) return;
    const action = btn.dataset.profile;

    if (action === 'toggle-edit') {
      s.editOpen = !s.editOpen;
      syncView({ focusSelector: s.editOpen ? '#profile-region-input, #profile-budget' : '[data-profile="toggle-edit"]' });
      return;
    }
    if (action === 'toggle-draft') {
      s.draftOpen = !s.draftOpen;
      syncView({ focusSelector: s.draftOpen ? '#profile-draft-message' : '[data-profile="toggle-draft"]' });
      return;
    }
    if (action === 'reload') {
      void loadProfile({ preserveForm: s.formEdited });
      return;
    }
    if (action === 'retry-regions') {
      void loadRegions();
      return;
    }
    if (action === 'add-region') {
      if (addRegionFromInput()) {
        s.formRetry = null;
      }
      syncView({ focusSelector: '#profile-region-input' });
      return;
    }
    if (action === 'remove-region') {
      const code = btn.dataset.code;
      if (!code) return;
      s.formCodes = s.formCodes.filter((c) => c !== code);
      s.formEdited = true;
      s.formError = '';
      s.formRetry = null;
      syncView();
      return;
    }
    if (action === 'clear-regions') {
      s.formCodes = [];
      s.formRegionInput = '';
      s.formEdited = true;
      s.formError = '';
      s.formRetry = null;
      syncView();
      return;
    }
    if (action === 'clear-budget') {
      s.formBudget = '';
      s.formEdited = true;
      s.formError = '';
      s.formRetry = null;
      syncView({ focusSelector: '#profile-budget' });
      return;
    }
    if (action === 'clear-area') {
      s.formAreaMin = '';
      s.formAreaMax = '';
      s.formEdited = true;
      s.formError = '';
      s.formRetry = null;
      syncView({ focusSelector: '#profile-area-min' });
      return;
    }
    if (action === 'clear-move-in') {
      s.formMoveInStart = '';
      s.formMoveInEnd = '';
      s.formEdited = true;
      s.formError = '';
      s.formRetry = null;
      syncView({ focusSelector: '#profile-move-in-start' });
      return;
    }
    if (action === 'reset-form') {
      if (s.profile) hydrateFormFromProfile(s.profile.conditions);
      syncView();
      announce('작성 중인 초안을 저장된 공유 프로필 값으로 되돌렸습니다.');
      return;
    }
    if (action === 'retry-form') {
      let built;
      try {
        built = buildFormPatch();
      } catch (err) {
        s.formError = err.message;
        syncView();
        return;
      }
      void submitProposal({ source: 'form', patch: built.patch, reason: built.reason, scope: s.scope });
      return;
    }
    if (action === 'clear-draft') {
      s.draftMessage = '';
      s.draftFromComparison = false;
      s.draftAutoParse = false;
      s.draftParseState = null;
      s.draftRetry = null;
      syncView({ focusSelector: '#profile-draft-message' });
      return;
    }
    if (action === 'submit-draft' || action === 'retry-draft') {
      if (s.draftParseState?.kind !== 'parsed') return;
      void submitProposal({
        source: 'draft',
        patch: s.draftParseState.patch,
        reason: s.draftParseState.reason,
        scope: s.scope,
      });
      return;
    }
    if (action === 'decide') {
      const changeId = btn.dataset.changeId;
      const decision = btn.dataset.decision;
      if (changeId && decision) void decide(changeId, decision);
      return;
    }
    if (action === 'load-more') {
      void loadOlderHistory();
    }
  });

  function getProposal(id) {
    if (!s.active || !user() || user().id !== s.ownerId || typeof id !== 'string') return null;
    return s.proposals.find((p) => p.id === id) ?? null;
  }

  return { enter, reset, view, getProposal };
}
