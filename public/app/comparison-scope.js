import { badge, esc, icon, reasonText, supplyLabel } from './display.js';
import { tradeRange } from './comparison-values.js';

const tradeNames = { sale: '아파트 매매', presale_right: '분양권', occupancy_right: '입주권' };
const regionKindLabels = {
  dong: '같은 동',
  eup: '같은 읍',
  myeon: '같은 면',
  district: '같은 구',
  municipality: '같은 시·군',
};
const regionUnitLabels = {
  dong: '법정동',
  eup: '읍',
  myeon: '면',
  district: '구',
  municipality: '시·군',
};

const EXTRA_REASON_LABELS = {
  cancelled_trade: '해제 거래 제외',
  outside_contract_period: '계약 기간 밖 제외',
  outside_supply_area: '공급면적 허용 범위 밖 제외',
  outside_applied_region: '적용 지역 밖 제외',
  trade_kind_not_included: '분석 대상 외 거래 종류 제외',
  target_complex_trade: '대상 단지 자체 거래 (주변 집계 제외)',
  trade_supply_area_conflict: '거래 공급면적 출처 충돌',
  trade_link_conflict: '거래 단지 연결 출처 충돌',
  trade_complex_identity_conflict: '단지 식별 근거 충돌',
  trade_row_location_unverified: '거래 관측 위치 미확인',
  trade_evidence_not_replayed: '대응 근거의 원거래 미수집',
  trade_evidence_locator_invalid: '거래 대응 위치 형식 오류',
  collection_partial: '일부 페이지 누락·불완전 수집',
  collection_failed: '실거래 출처 조회 실패',
  collection_missing: '필요한 계약월 미수집',
  collection_identity_conflict: '수집 기록 식별 충돌',
  collection_coverage_unverified: '수집 완전성 미확인',
  area_tolerance_invalid: '면적 허용 범위 형식 오류',
  area_change_confirmation_required: '면적 범위 변경 확인 필요',
  replacement_target_required: '교체할 기존 단지 지정 필요',
  replacement_candidate_ineligible: '직접 지정 단지가 현재 범위·기준 미충족',
  replacement_request_conflict: '직접 지정 요청 충돌',
  replacement_request_invalid: '직접 지정 요청 형식 오류',
  housing_type_selection_required: '주택형 선택 필요',
  analysis_binding_unverified: '분석과 수집본 연결 미확인',
  catalog_version_unsupported: '지원하지 않는 공고 수집 형식',
  selection_invalid: '분석 선택 조건 형식 오류',
  different_notice_round: '선택 공고와 다른 회차 문서',
  document_notice_mismatch: '다른 공고의 문서',
  document_identity_unverified: '문서 공고·회차 식별 미확인',
  document_metadata_conflict: '문서 메타정보 충돌',
  document_source_unverified: '문서 확보 출처 미확인',
  source_value_conflict: '같은 문서 내 값 충돌',
  correction_relation_unverified: '정정 공고 적용 관계 미확인',
  supply_area_api_mismatch: '공고문과 API 공급면적 불일치',
  supply_area_api_conflict: 'API 공급면적 보고값 충돌',
  no_checked_value: '원문 대조 확인값 없음',
  area_basis_mixed: '공급면적과 전용면적 혼재',
  evidence_malformed: '원문 근거 형식 오류',
};

export function evidenceReasonLabel(code) {
  if (typeof code !== 'string' || !code) return '추가 확인 필요';
  if (Object.hasOwn(EXTRA_REASON_LABELS, code)) return EXTRA_REASON_LABELS[code];
  return reasonText(code) ?? '추가 확인 필요';
}

export function formatMeters(meters) {
  if (typeof meters !== 'number' || !Number.isFinite(meters) || meters < 0) return '—';
  if (meters >= 1000) return (meters / 1000).toFixed(2) + 'km';
  return Math.round(meters).toLocaleString('ko-KR') + 'm';
}

export function formatAreaDiff(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return '—';
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0')) +
    (Number(fraction[2] ?? 0) >= 5 ? 1n : 0n);
  if (cents === 0n && /[1-9]/.test(value)) return '0.01㎡ 미만';
  return (cents / 100n).toString() + '.' + (cents % 100n).toString().padStart(2, '0') + '㎡';
}

export function isSubstantiatedZero(scope) {
  return (
    scope?.conclusion === 'normal_zero' &&
    scope.collectionStatus === 'complete' &&
    scope.screeningStatus === 'complete' &&
    scope.unresolvedRows === 0
  );
}

export function scopeInfo(data) {
  const { priority, expansion } = data?.regionDecision ?? {};
  const priorityKindLabel = regionKindLabels[priority?.kind] ?? '우선 지역';
  const expansionKindLabel = regionKindLabels[expansion?.kind] ?? '확대 지역';
  const substantiatedPriorityZero = isSubstantiatedZero(priority);
  const expanded =
    data?.appliedScope === 'expansion' &&
    substantiatedPriorityZero &&
    Boolean(expansion?.name);
  const substantiatedExpansionZero = expanded && isSubstantiatedZero(expansion);
  const expansionRegionHeld =
    substantiatedPriorityZero &&
    expansion?.conclusion === 'held' &&
    !expansion?.name;
  const expansionScopeHeld =
    expanded &&
    (expansion?.conclusion === 'held' ||
      (expansion?.confirmedCandidateCount === 0 && !substantiatedExpansionZero));

  if (expanded) {
    return {
      level: 'expansion',
      name: expansion.name,
      code: expansion.code ?? null,
      kindLabel: expansionKindLabel,
      unitLabel: regionUnitLabels[expansion.kind] ?? '확대 지역',
      priorityName: priority.name || '우선 지역',
      priorityCode: priority.code ?? null,
      priorityKindLabel,
      detail: `${priority.name || '우선 지역'}에서 정상 0건 확인 후 확대`,
      expanded: true,
      pending: expansionScopeHeld,
      priorityHeld: false,
      expansionHeld: false,
      expansionRegionHeld: false,
      substantiatedPriorityZero: true,
      substantiatedExpansionZero,
    };
  }

  if (priority?.name) {
    const confirmedCount = Number.isSafeInteger(priority.confirmedCandidateCount)
      ? priority.confirmedCandidateCount
      : 0;
    const priorityHeld =
      data?.appliedScope === 'expansion' ||
      priority.conclusion === 'held' ||
      (confirmedCount === 0 && !substantiatedPriorityZero);
    const expansionHeld = priorityHeld && confirmedCount === 0;
    const pending = priorityHeld || expansionRegionHeld;
    return {
      level: pending ? 'held' : 'priority',
      name: priority.name,
      code: priority.code ?? null,
      kindLabel: priorityKindLabel,
      unitLabel: regionUnitLabels[priority.kind] ?? '우선 지역',
      priorityName: priority.name,
      priorityCode: priority.code ?? null,
      priorityKindLabel,
      detail: expansionHeld
        ? '정상 0개 아님 · 확대 보류'
        : expansionRegionHeld
          ? '확대 지역 판정 보류'
          : priorityHeld
            ? '지역 판정 보류'
            : priorityKindLabel,
      expanded: false,
      pending,
      priorityHeld,
      expansionHeld,
      expansionRegionHeld,
      substantiatedPriorityZero,
      substantiatedExpansionZero: false,
    };
  }

  return {
    level: 'unidentified',
    name: '범위 미판정',
    code: null,
    kindLabel: '범위 미판정',
    unitLabel: '지역',
    priorityName: null,
    priorityCode: null,
    priorityKindLabel: '우선 지역',
    detail: '소속 지역 확인 필요',
    expanded: false,
    pending: true,
    priorityHeld: true,
    expansionHeld: false,
    expansionRegionHeld: false,
    substantiatedPriorityZero: false,
    substantiatedExpansionZero: false,
  };
}

export function scopeBadge(data) {
  const info = scopeInfo(data);
  if (info.expanded) {
    return `<span class="hc-scope hc-scope-gu">${icon('arrow-up-right')}<span class="hc-scope-name">${esc(info.name)}</span><span class="hc-scope-note">${esc(info.priorityName)} 정상 0개 · ${esc(info.kindLabel)}로 확대</span></span>`;
  }
  if (info.level === 'unidentified') {
    return badge('unknown', 'circle-help', '비교 범위 미판정');
  }
  const note = info.expansionHeld
    ? `${info.kindLabel} · 확대 보류`
    : info.expansionRegionHeld
      ? `${info.kindLabel} · 확대 지역 확인 필요`
      : info.pending
        ? `${info.kindLabel} · 판정 보류`
        : info.kindLabel;
  return `<span class="hc-scope hc-scope-dong${info.pending ? ' is-held' : ''}">${icon('map-pin')}<span class="hc-scope-name">${esc(info.name)}</span><span class="hc-scope-note">${esc(note)}</span></span>`;
}

function holdStatusStyle(code) {
  if (typeof code !== 'string') return ['unknown', 'circle-help'];
  if (code.includes('conflict') || code.includes('mismatch')) return ['conflict', 'link-2-off'];
  if (code.includes('failed')) return ['failed', 'triangle-alert'];
  if (code.includes('partial') || code.includes('incomplete') || code.includes('tie')) return ['partial', 'chart-pie'];
  return ['unknown', 'circle-help'];
}

function groupByReason(items) {
  const map = new Map();
  for (const item of items ?? []) {
    if (!item || typeof item.reasonCode !== 'string') continue;
    const entry = map.get(item.reasonCode) ?? {
      code: item.reasonCode,
      count: 0,
      decisionId: null,
    };
    entry.count += 1;
    if (!entry.decisionId && typeof item.decisionId === 'string') entry.decisionId = item.decisionId;
    map.set(item.reasonCode, entry);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function tradeKindVerdict(kind, summary) {
  const name = tradeNames[kind] ?? kind;
  if (!summary) {
    return {
      name,
      style: 'unknown',
      symbol: 'circle-help',
      label: '판정 미확인',
      detail: '조회·판별 결과를 확인할 수 없습니다.',
    };
  }
  const count = Number.isSafeInteger(summary.confirmedCandidateCount) ? summary.confirmedCandidateCount : 0;
  const displayed = Number.isSafeInteger(summary.displayedCandidateCount) ? summary.displayedCandidateCount : count;
  const unresolved = Number.isSafeInteger(summary.unresolvedRows) ? summary.unresolvedRows : 0;
  const verifiedZero =
    summary.conclusion === 'normal_zero' &&
    summary.collectionStatus === 'complete' &&
    unresolved === 0;

  if (summary.conclusion === 'candidates_found' && count > 0) {
    const detail =
      displayed !== count
        ? `전체 확인 ${count}단지 중 ${displayed}단지 표시`
        : unresolved > 0
          ? `확인 ${count}단지 · 미확인 ${unresolved}건 남음`
          : `확인된 비교 단지 ${count}곳`;
    return { name, style: 'verified', symbol: 'circle-check', label: `확인 ${count}단지`, detail };
  }
  if (summary.conclusion === 'lookup_failed' || summary.collectionStatus === 'failed') {
    return {
      name,
      style: 'failed',
      symbol: 'triangle-alert',
      label: '조회 실패',
      detail: '정상 0건 아님 · 출처 조회 오류',
    };
  }
  if (verifiedZero) {
    return {
      name,
      style: 'zero',
      symbol: 'circle-minus',
      label: '정상 0건',
      detail: '수집·판별 완료 · 현재 범위 자료 없음',
    };
  }
  const holdDetail =
    unresolved > 0
      ? `정상 0건 아님 · 보류 관측 ${unresolved}건`
      : summary.collectionStatus === 'partial'
        ? '정상 0건 아님 · 일부 수집 누락'
        : '정상 0건 아님 · 확인 보류';
  return {
    name,
    style: summary.collectionStatus === 'partial' ? 'partial' : 'unknown',
    symbol: summary.collectionStatus === 'partial' ? 'chart-pie' : 'circle-help',
    label: '확인 보류',
    detail: holdDetail,
  };
}

function candidateTradeSummary(candidate) {
  const parts = [];
  let totalValid = 0;
  let hasProvisional = false;
  let hasSmallSample = false;
  for (const [kind, label] of Object.entries(tradeNames)) {
    const stat = candidate?.tradeStats?.[kind];
    const range = tradeRange(stat);
    if (!range) continue;
    totalValid += stat.count;
    if (stat.status === 'provisional') hasProvisional = true;
    if (stat.smallSample) hasSmallSample = true;
    parts.push(`${label.replace('아파트 ', '')} ${stat.count}건`);
  }
  return { parts, totalValid, hasProvisional, hasSmallSample };
}

function characteristicStatusChips(characteristics) {
  const list = Array.isArray(characteristics) ? characteristics : [];
  const chips = [];
  const confirmedByField = new Map();
  let hasConflict = false;
  let hasFailure = false;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.status === 'conflict') hasConflict = true;
    if (item.status === 'failed') hasFailure = true;
    if (item.status === 'confirmed' && item.field) {
      const seen = confirmedByField.get(item.field) ?? new Set();
      seen.add(String(item.value));
      confirmedByField.set(item.field, seen);
      if (seen.size > 1) hasConflict = true;
    }
  }
  if (hasConflict) chips.push(badge('conflict', 'link-2-off', '특성 출처 충돌'));
  if (hasFailure) chips.push(badge('failed', 'triangle-alert', '특성 조회 실패'));
  return chips.join('');
}

function renderCandidateCard(candidate, role, targetAreaM2) {
  const isTarget = role === 'target';
  const trade = candidateTradeSummary(candidate);
  const rankLabel = isTarget
    ? badge('zero', 'info', '자체 거래 · 별도 참고')
    : Number.isSafeInteger(candidate.rank)
      ? `<span class="scope-rank-chip">${candidate.rank}순위</span>`
      : badge('partial', 'circle-pause', '순위 보류');
  const cardStatus = isTarget
    ? ''
    : trade.hasProvisional
      ? badge('partial', 'chart-pie', '잠정 · 일부 확인')
      : badge('verified', 'circle-check', '비교 가능');
  const dist = candidate.distance;
  const distHtml =
    dist?.status === 'confirmed' && typeof dist.meters === 'number'
      ? `<span class="num">${esc(formatMeters(dist.meters))}</span> <small class="muted">직선거리</small>`
      : dist?.status === 'conflict'
        ? `<span class="hc-cell-empty" aria-label="값 없음">—</span> ${badge('conflict', 'link-2-off', '좌표 충돌')}`
        : `<span class="hc-cell-empty" aria-label="값 없음">—</span> ${badge('unknown', 'circle-help', '거리 미확인')}`;
  const diffHtml =
    candidate.areaDifferenceM2 != null
      ? `<small class="muted">기준 대비 ${esc(formatAreaDiff(candidate.areaDifferenceM2))} 차이</small>`
      : targetAreaM2
        ? ''
        : '';
  const charChips = characteristicStatusChips(candidate.characteristics);
  return `<article class="scope-candidate-card${isTarget ? ' is-target-ref' : ''}" data-complex-card="${esc(candidate.complexId)}">
    <div class="scope-card-head">
      <div class="scope-card-title">
        <div class="scope-card-tags">${rankLabel}${cardStatus}${charChips}</div>
        <h3>${esc(candidate.name || '단지명 미확인')}</h3>
        <span class="scope-card-meta code">${esc(candidate.localityCode || '지역코드 미확인')}</span>
      </div>
    </div>
    <dl class="scope-card-dl">
      <div><dt>선정 면적</dt><dd><strong>공급 ${esc(supplyLabel(candidate.supplyAreaM2))}</strong>${diffHtml}</dd></div>
      ${isTarget ? '' : `<div><dt>거리</dt><dd>${distHtml}</dd></div>`}
      <div><dt>유효 거래</dt><dd><strong>${esc(trade.parts.join(' · ') || '—')}</strong>${trade.hasSmallSample ? ' <small class="muted">소표본</small>' : ''}</dd></div>
    </dl>
    <div class="scope-card-foot">
      <button type="button" class="text-button scope-detail-btn" data-open-complex="${esc(candidate.complexId)}" data-complex-role="${esc(role)}">
        ${icon('building-2')}단지 상세 · 거래 목록 ${icon('chevron-right')}
      </button>
    </div>
  </article>`;
}

export function comparisonScopeView(data) {
  if (!data || data.contractVersion !== 'comparison/v1') return '';
  const info = scopeInfo(data);
  const priority = data.regionDecision?.priority ?? null;
  const expansion = data.regionDecision?.expansion ?? null;
  const activeScopeObj = info.expanded ? expansion : priority;
  const comparables = Array.isArray(data.comparables) ? data.comparables : [];
  const targetRefs = Array.isArray(data.targetReferences) ? data.targetReferences : [];
  const holds = Array.isArray(data.holds) ? data.holds : [];
  const exclusions = Array.isArray(data.exclusions) ? data.exclusions : [];
  const configuredKinds = Array.isArray(data.conditions?.tradeKinds) && data.conditions.tradeKinds.length
    ? data.conditions.tradeKinds
    : Object.keys(tradeNames);
  const activeTradeKinds = data.tradeKinds ?? activeScopeObj?.tradeKinds ?? {};
  const priorityTradeKinds = priority?.tradeKinds ?? {};
  const holdsByReason = groupByReason(holds);
  const exclusionsByReason = groupByReason(exclusions);

  const priorityConfirmed = Number.isSafeInteger(priority?.confirmedCandidateCount)
    ? priority.confirmedCandidateCount
    : 0;
  const priorityUnresolved = Number.isSafeInteger(priority?.unresolvedRows)
    ? priority.unresolvedRows
    : holds.length;
  const activeConfirmed = Number.isSafeInteger(activeScopeObj?.confirmedCandidateCount)
    ? activeScopeObj.confirmedCandidateCount
    : comparables.length;
  const activeUnresolved = Number.isSafeInteger(activeScopeObj?.unresolvedRows)
    ? activeScopeObj.unresolvedRows
    : holds.length;

  // 자동 확대 알림 박스 (확인 질문 없음, A-05)
  const priorityExclusions = exclusions.filter((e) => e?.scope === 'priority');
  let noticeHtml = '';
  if (info.expanded) {
    const expansionZeroMsg = info.substantiatedExpansionZero
      ? `<p class="scope-notice-sub">현재 기간·면적 조건에서 ${esc(info.name)}의 비교 자료를 찾지 못했습니다. 인접 시·군·구, 기간, 면적을 자동으로 넓히지 않습니다.</p>`
      : info.pending
        ? `<p class="scope-notice-sub">${esc(info.name)} 판정이 완료되지 않아 ‘이 지역에도 없음’으로 확정하지 않습니다.</p>`
        : '';
    noticeHtml = `<div class="scope-expansion-notice" role="status" aria-label="자동 지역 확대 알림">
      <div class="scope-notice-head">${icon('arrow-up-right')}<strong>${esc(info.priorityName)} 내 비교 가능한 단지가 없어 ${esc(info.name)}(으)로 확대했습니다.</strong></div>
      <div class="scope-proof-row">
        <span>${esc(info.priorityName)} 판정</span>
        ${badge('zero', 'circle-minus', '정상 0건')}
        <span>수집 완료</span>
        <span>미확인 후보 없음</span>
        <span>조회 오류 없음</span>
        ${priorityExclusions.length ? `<span>우선 지역 제외 ${priorityExclusions.length}건</span>` : ''}
      </div>
      <p class="scope-notice-sub">조회와 판별을 모두 마치고 비교 대상이 정상 0건일 때만 확인 질문 없이 기본 규칙(${esc(info.kindLabel)})으로 확대합니다. 미확인 후보나 오류가 남으면 확대하지 않고 우선 지역 판정을 보류합니다.</p>
      ${expansionZeroMsg}
    </div>`;
  } else if (info.expansionHeld) {
    const failedKinds = configuredKinds.filter(
      (k) => priorityTradeKinds[k]?.conclusion === 'lookup_failed' || priorityTradeKinds[k]?.collectionStatus === 'failed',
    );
    const reasonHint = failedKinds.length
      ? `${failedKinds.map((k) => tradeNames[k] ?? k).join('·')} 조회 실패 또는 보류 항목이 남아 있어 전체 정상 0개로 판정할 수 없습니다.`
      : `${info.priorityName}에 미확인·보류 항목 또는 미완료 수집이 남아 있어 정상 0개로 확정할 수 없습니다.`;
    noticeHtml = `<div class="scope-hold-notice" role="status" aria-label="지역 확대 보류 안내">
      <div class="scope-notice-head">
        ${badge('partial', 'circle-pause', '정상 0개 아님 · 확대 보류')}
        <strong>${esc(info.priorityName)} 판정이 완료되지 않아 상위 구·시·군으로 확대하지 않았습니다.</strong>
      </div>
      <p class="scope-notice-sub">${esc(reasonHint)} 확인된 후보가 0개인 것과 비교 대상이 없는 것(정상 0개)은 다릅니다.</p>
    </div>`;
  } else if (info.expansionRegionHeld) {
    noticeHtml = `<div class="scope-hold-notice" role="status" aria-label="확대 지역 판정 보류">
      <div class="scope-notice-head">
        ${badge('unknown', 'circle-help', '확대 지역 판정 보류')}
        <strong>${esc(info.priorityName)}은 정상 0건이지만 확대할 구 또는 시·군의 소속을 확인하지 못했습니다.</strong>
      </div>
      <p class="scope-notice-sub">이름 추측이나 거리 반경으로 대체하지 않고 지역 소속 근거를 확인한 뒤 확대합니다.</p>
    </div>`;
  }

  // 거래 종류별 판정 상태 (A-24 · A-25)
  const kindCards = configuredKinds
    .map((kind) => {
      const verdict = tradeKindVerdict(kind, activeTradeKinds[kind]);
      return `<div class="scope-kind-card" data-kind-verdict="${esc(kind)}">
        <div class="scope-kind-top">
          <strong>${esc(verdict.name)}</strong>
          ${badge(verdict.style, verdict.symbol, verdict.label)}
        </div>
        <p>${esc(verdict.detail)}</p>
      </div>`;
    })
    .join('');

  const hasFoundKind = configuredKinds.some((k) => activeTradeKinds[k]?.conclusion === 'candidates_found');
  const hasZeroKind = configuredKinds.some(
    (k) =>
      activeTradeKinds[k]?.conclusion === 'normal_zero' &&
      activeTradeKinds[k]?.collectionStatus === 'complete' &&
      activeTradeKinds[k]?.unresolvedRows === 0,
  );
  const kindFootnote =
    !info.expanded && hasFoundKind && hasZeroKind
      ? '한 거래 종류라도 우선 지역에 확인된 후보가 있으면 전체 범위를 유지합니다. 자료가 없는 거래 종류만 상위 지역에서 보충하지 않습니다.'
      : info.expansionHeld
        ? '모든 거래 종류의 조회·판별이 완료돼 전체 정상 0건일 때만 상위 구·시·군으로 확대합니다.'
        : '매매·분양권·입주권은 같은 지역 범위에서 각각 분리해 판정합니다.';

  // 후보 건수 요약
  const countMetrics = `<div class="scope-counts" aria-label="후보 판정 건수 요약">
    <div class="scope-metric">
      <span class="scope-metric-label">${esc(info.expanded ? `${info.name} 확인 후보` : `${info.priorityName || '우선 지역'} 확인 후보`)}</span>
      <strong class="num">${activeConfirmed}단지</strong>
      <small class="muted">${info.expanded ? `${esc(info.priorityName)} 확인 ${priorityConfirmed}단지(정상 0건)` : `주변 최대 ${data.conditions?.maxComparables ?? 5}단지 · 자체 거래 제외`}</small>
    </div>
    <div class="scope-metric">
      <span class="scope-metric-label">보류 관측 · 항목</span>
      <strong class="num">${Math.max(activeUnresolved, holds.length)}건</strong>
      <small class="muted">${holds.length ? `${holdsByReason.length}개 사유로 보류` : '결론을 바꿀 보류 없음'}</small>
    </div>
    <div class="scope-metric">
      <span class="scope-metric-label">근거 제외 관측</span>
      <strong class="num">${exclusions.length}건</strong>
      <small class="muted">${exclusions.length ? `${exclusionsByReason.length}개 사유로 제외` : '제외된 관측 없음'}</small>
    </div>
  </div>`;

  // 확인된 비교 단지 카드 + 자체 거래 카드
  const targetAreaM2 = data.target?.supplyArea?.status === 'confirmed' ? data.target.supplyArea.m2 : null;
  const candidateCardsHtml = comparables.length
    ? `<div class="scope-candidates-wrap">
        <div class="scope-subhead">
          <h3>확인된 비교 단지 <span class="num">${comparables.length}곳</span></h3>
          <span class="small muted">카드를 누르면 식별 근거와 제외 거래까지 확인할 수 있습니다.</span>
        </div>
        <div class="scope-candidate-grid">${comparables.map((c) => renderCandidateCard(c, 'comparable', targetAreaM2)).join('')}</div>
      </div>`
    : '';

  const targetRefHtml = targetRefs.length
    ? `<div class="scope-target-refs">
        <div class="scope-subhead">
          <h3>대상 단지 자체 거래 <span class="num">${targetRefs.length}곳</span></h3>
          ${badge('zero', 'info', '별도 참고 · 주변 5단지 집계 제외')}
        </div>
        <div class="scope-candidate-grid">${targetRefs.map((c) => renderCandidateCard(c, 'target', targetAreaM2)).join('')}</div>
      </div>`
    : '';

  // 사유별 보류/제외 내역
  const breakdownHtml =
    holdsByReason.length || exclusionsByReason.length
      ? `<details class="scope-breakdown"${holdsByReason.length ? ' open' : ''}>
          <summary>${icon('list')}보류·제외 사유별 건수 보기 (보류 ${holds.length}건 · 제외 ${exclusions.length}건)${icon('chevron-down')}</summary>
          <div class="scope-breakdown-grid">
            <div class="scope-breakdown-col">
              <h4>보류 사유별 건수</h4>
              ${
                holdsByReason.length
                  ? `<ul class="scope-reason-list">${holdsByReason
                      .map((entry) => {
                        const [style, symbol] = holdStatusStyle(entry.code);
                        return `<li>
                          <div class="scope-reason-copy">
                            ${badge(style, symbol, evidenceReasonLabel(entry.code))}
                            ${entry.decisionId ? `<span class="code scope-decision-tag">${esc(entry.decisionId)}</span>` : ''}
                          </div>
                          <strong class="num">${entry.count}건</strong>
                        </li>`;
                      })
                      .join('')}</ul>`
                  : '<p class="small muted">보류된 항목이 없습니다.</p>'
              }
            </div>
            <div class="scope-breakdown-col">
              <h4>제외 사유별 건수</h4>
              ${
                exclusionsByReason.length
                  ? `<ul class="scope-reason-list">${exclusionsByReason
                      .map(
                        (entry) => `<li>
                          <div class="scope-reason-copy">${badge('zero', 'circle-minus', evidenceReasonLabel(entry.code))}</div>
                          <strong class="num">${entry.count}건</strong>
                        </li>`,
                      )
                      .join('')}</ul>`
                  : '<p class="small muted">근거에 따라 제외된 관측이 없습니다.</p>'
              }
            </div>
          </div>
        </details>`
      : '';

  // 규칙 안내 (A-03 · A-04 · A-07)
  let ruleNote = '';
  if (info.expanded) {
    ruleNote = `${info.name}에도 비교 대상이 없으면 현재 조건의 비교 자료 부족으로 안내하고 멈춥니다. 인접 시·군·구, 기간, 면적을 자동으로 넓히지 않습니다.`;
  } else if (comparables.length > 0 && (!data.rankingComplete || priorityUnresolved > 0)) {
    ruleNote = `확인된 후보만 보여줍니다. 보류 항목이 남아 있어 완전한 후보 목록이나 순위가 아닙니다. 최대 5단지를 채우려고 상위 구·시·군에서 단지를 더하지 않습니다.`;
  } else if (comparables.length > 0) {
    ruleNote = `${info.name}에서 확인된 ${comparables.length}개 단지만 비교합니다. 최대 5단지를 채우려고 상위 구·시·군에서 단지를 더하지 않습니다.`;
  }

  return `<section class="panel scope-panel" aria-label="비교 대상 판정" data-scope-level="${esc(info.level)}">
    <div class="scope-head">
      <div class="scope-head-main">
        <div class="panel-title">${icon('map-pin')}<h2>비교 대상 판정</h2></div>
        ${scopeBadge(data)}
      </div>
      ${info.code ? `<span class="scope-code-chip code" title="적용 지역 코드">코드 ${esc(info.code)}</span>` : ''}
    </div>
    ${noticeHtml}
    ${countMetrics}
    <div class="scope-kinds-wrap" aria-label="거래 종류별 판정">
      <div class="scope-subhead">
        <h3>거래 종류별 판정 상태</h3>
        <span class="small muted">${esc(info.expanded ? `${info.name} 기준` : `${info.priorityName || '현재 범위'} 기준`)}</span>
      </div>
      <div class="scope-kind-grid">${kindCards}</div>
      <p class="scope-kind-note">${icon('info')}${esc(kindFootnote)}</p>
    </div>
    ${candidateCardsHtml}
    ${targetRefHtml}
    ${breakdownHtml}
    ${ruleNote ? `<p class="scope-rule-note" role="note">${icon('info')}<span>${esc(ruleNote)}</span></p>` : ''}
  </section>`;
}
