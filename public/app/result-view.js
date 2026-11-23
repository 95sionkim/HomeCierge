import {
  esc,
  icon,
  badge,
  runBadge,
  won,
  reasonText,
  dateText,
  todayKst,
  errorText,
  rangeLabel,
  supplyLabel,
} from './display.js';
import { emptyState } from './directory-view.js';
import { evidence } from './planning-fields.js';
import { marketView, noticeRange, priceLabel, tradeNames } from './trade-comparison.js';

function readableReasons(values) {
  return [...new Set((values ?? []).map(reasonText).filter(Boolean))];
}

function scopeLabel(data) {
  const { priority, expansion } = data?.regionDecision ?? {};
  if (data?.appliedScope === 'expansion' && priority?.conclusion === 'normal_zero' &&
      priority.collectionStatus === 'complete' && priority.screeningStatus === 'complete' &&
      priority.unresolvedRows === 0 && expansion?.name)
    return { name: expansion.name, detail: (priority.name || '우선 지역') + '에서 정상 0건 확인 후 확대', expanded: true };
  if (priority?.name) {
    const pending = data?.appliedScope === 'expansion' || priority.conclusion === 'held' || expansion?.conclusion === 'held';
    return { name: priority.name, detail: pending ? '지역 판정 보류' : '우선 지역', pending };
  }
  return { name: '범위 미판정', detail: '' };
}

export function analysisConditionBar(data, input, open, lookup = null) {
  const target = data?.target;
  const notice = target?.noticeNo || input?.noticeNo;
  const model = target?.houseType || (input?.modelNo ? '모델 ' + input.modelNo : '주택형 미확인');
  const scope = scopeLabel(data);
  const c = data?.conditions;
  const period = c?.period?.status === 'confirmed' ? rangeLabel(c.period, false) : '기간 미확인';
  const area = target?.supplyArea?.status === 'confirmed' ? supplyLabel(target.supplyArea.m2) : '면적 미확인';
  const kinds = (c?.tradeKinds ?? []).map(k => tradeNames[k]).filter(Boolean).join(' · ');
  const cell = (label, value, cls = '') => `<span class="condition-item ${cls}"><small>${label}</small><strong>${esc(value)}</strong></span>`;
  if (!data) {
    const known = notice ? cell('공고 번호', notice) + cell('주택형', model) :
      cell('분석 입력', input?.kind === 'synthetic' ? '합성 분석' : '저장된 수집본');
    const note = lookup?.error ? errorText(lookup.error) : lookup?.loading ? '분석 조건을 불러오고 있습니다.' :
      lookup ? '펼치면 이 결과에 적용한 비교 조건을 조회합니다.' : '현재 확인할 수 있는 비교 조건이 없습니다.';
    return `<details class="condition-bar"${open ? ' open' : ''}><summary id="analysis-conditions">
      <span class="condition-key">${icon('sliders-horizontal')}분석 조건</span>${known}${icon('chevron-down', 'condition-chevron')}</summary>
      <div class="condition-message" role="status">${esc(note)}${lookup?.error && lookup.error.code !== 'comparison_source_restricted' ? '<button type="button" class="text-button" data-action="reload-conditions">조건 다시 조회</button>' : ''}</div></details>`;
  }
  return `<details class="condition-bar"${open ? ' open' : ''}><summary id="analysis-conditions">
    <span class="condition-key">${icon('sliders-horizontal')}분석 조건</span>
    ${cell('공고 번호', notice || '미확인', 'condition-notice')}${cell('주택형', model, 'condition-model')}${cell('비교 범위', scope.name + (scope.expanded ? ' · 확대' : scope.pending ? ' · 판정 보류' : ''), 'condition-scope')}${cell('계약 기간', period, 'condition-period')}${cell('공급면적', area, 'condition-area')}${icon('chevron-down', 'condition-chevron')}</summary>
    <dl class="condition-detail">
      ${[['공고 번호', notice || '미확인'], ['주택형', model], ['지역', [scope.name, scope.detail].filter(Boolean).join(' · ')], ['계약 기간', period], ['공급면적', area], ['면적 허용 범위', c?.area?.tolerancePercent != null ? '±' + c.area.tolerancePercent + '%' : '미확인'], ['거래 유형', kinds || '미확인']].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}
    </dl></details>`;
}

function priceView(data) {
  const p = data.noticePrice ?? {};
  const range = noticeRange(p);
  const confirmed = p.confirmedRooms ?? [], held = p.heldRooms ?? [];
  const label = p.scope === 'selected_room' ? (p.room || '선택한 호실') + ' 소계' :
    range ? (confirmed.length > 1 ? '호실별 소계 범위' : '호실 소계') + ' · ' + confirmed.length + '개 호실 확인' : '호실 소계 미확인';
  return `<section class="panel price-panel" aria-label="공고 호실 가격">
    <div class="panel-title">${icon('building-2')}<h2>호실별 공고 가격</h2></div>
    <div class="price-highlight${range ? '' : ' price-unverified'}"><span>${esc(label)}</span><strong class="big-price">${esc(priceLabel(range))}</strong>
    <p>각 호실의 분양가와 필수 옵션을 더한 금액입니다. 세금·등기 비용은 별도입니다.</p></div>
    ${confirmed.map(r => `<div class="room-breakdown"><h3>${esc(r.room)}${badge('verified', 'circle-check', '소계 확인')}</h3>
      <dl>${[['분양가', r.salePriceWon, r.evidence?.salePrice], ['필수 옵션', r.requiredOptionsWon, r.evidence?.requiredOptions]].map(([label, value, refs]) => `<div><dt>${label}</dt><dd><strong>${esc(won(value))}</strong>${evidence(refs, r.room + ' ' + label + ' 근거') || '<small>문서 쪽수 미확인</small>'}</dd></div>`).join('')}
      <div class="subtotal-line"><dt>소계</dt><dd>${esc(won(r.subtotalWon))}</dd></div></dl></div>`).join('')}
    ${held.map(r => `<div class="held-room">${icon('circle-pause')}<div><strong>${esc(r.room)} · 소계 보류</strong><p>${esc(readableReasons(r.reasons).join(' ') || '같은 판본에서 호실의 두 금액을 확인해야 합니다.')}</p></div></div>`).join('')}
    ${!range && !held.length ? `<p class="narrative">${esc(readableReasons(p.reasons).join(' ') || '같은 판본에서 호실별 분양가와 필수 옵션을 확인해야 합니다.')}</p>` : ''}
    </section>`;
}

function evidenceView(data) {
  const target = data.target;
  const supply = target?.supplyArea;
  const records = data.collections ?? [];
  const feed = { apt_trade: '아파트 매매', apt_rights: '분양·입주권' };
  const states = {
    complete: ['verified', 'circle-check', '수집 완료'], empty: ['zero', 'circle-minus', '정상 0건'],
    partial: ['partial', 'circle-pause', '일부 수집'], failed: ['failed', 'triangle-alert', '조회 실패'],
  };
  return `<section class="panel result-evidence"><div class="panel-title">${icon('file-text')}<h2>자료 근거</h2></div>
    <dl><div><dt>공급면적</dt><dd>${supply?.status === 'confirmed' ? `<strong>${esc(supplyLabel(supply.m2))}</strong>${evidence(supply.evidence, '공급면적 근거')}` : '근거 미확인'}</dd></div>
    <div><dt>분석 기준일</dt><dd>${esc(dateText(data.conditions?.asOf))}</dd></div>
    </dl>${records.length ? `<details class="collection-disclosure"><summary>${icon('database')}실거래 수집 기록 ${records.length}개${icon('chevron-down')}</summary><ul>${records.map(record => {
      const status = states[record.status] || ['unknown', 'circle-help', '미확인'];
      const observed = dateText(todayKst(record.collectedAt ?? null));
      return `<li><div><strong>${esc(feed[record.source] || '출처 미확인')}</strong>${badge(...status)}</div><small>계약월 ${esc(record.month)} · 지역 ${esc(record.requestRegionCode)}${observed === '—' ? '' : ' · ' + observed + ' 수집'}</small></li>`;
    }).join('')}</ul></details>` : ''}</section>`;
}

function holdPanel(data) {
  const holds = data.holds ?? [];
  if (!holds.length && data.completeness === 'complete') return '';
  const subjects = {
    collection: '요청한 지역·계약월의 거래 자료를 모두 확인하지 못했습니다.',
    trade: '거래의 유효성 또는 단지 대응을 확인해야 합니다.',
    selection: '선택한 분석 조건을 확인해야 합니다.',
    ranking: '비교 단지의 순위를 확정할 수 없습니다.',
  };
  const reasons = [...new Set(holds.map(h => reasonText(h.reasonCode) || subjects[h.subject] ||
    '비교에 필요한 근거 중 확인하지 못한 항목이 있습니다.'))];
  const codes = new Set(holds.map(h => h.reasonCode));
  const needed = [];
  if (codes.has('target_supply_area_unverified') || codes.has('trade_supply_area_unverified'))
    needed.push('해당 주택형의 전용면적과 주거공용면적을 확인할 수 있는 공급면적 자료');
  if (codes.has('no_confirmed_room_subtotal') || codes.has('notice_room_price_unverified'))
    needed.push('같은 회차·판본에서 같은 호실의 분양가와 필수 옵션을 확인할 수 있는 공고문');
  if (codes.has('trade_link_unverified') || codes.has('comparison_evidence_unverified'))
    needed.push('거래 당시의 단지와 주택형을 연결하는 자료');
  if (holds.some(h => h.subject === 'collection')) needed.push('누락된 지역·계약월의 수집 자료');
  if (codes.has('contract_period_unverified')) needed.push('양 끝 날짜가 확인된 계약 기간');
  const kept = [];
  if (data.target?.houseType) kept.push('선택 주택형 ' + data.target.houseType);
  if (noticeRange(data.noticePrice)) kept.push('근거가 확인된 호실 소계');
  if (data.target?.supplyArea?.status === 'confirmed') kept.push('확인된 공급면적');
  if (data.comparables?.length) kept.push('근거가 확인된 거래 통계');
  return `<section class="panel hold-panel"><div class="panel-title">${icon('circle-pause')}<h2>${data.completeness === 'unavailable' ? '가격 비교를 보류했습니다' : '일부 항목의 비교를 보류했습니다'}</h2></div>
    <div class="hold-columns"><div><h3>확인하지 못한 항목</h3><ul>${(reasons.length ? reasons : ['현재 자료로 비교에 필요한 근거를 모두 확인할 수 없습니다.']).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
    <div><h3>다시 비교하려면</h3><ul>${(needed.length ? needed : ['보류된 항목을 확인할 수 있는 수집 자료 또는 공고 근거']).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
    ${kept.length ? `<div><h3>지금 확인할 수 있는 결과</h3><ul>${kept.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}</div></section>`;
}

export function comparisonView(data, title, tradeKind = 'sale', conversationHtml = '') {
  if (!data || data.contractVersion !== 'comparison/v1')
    return emptyState('circle-help', '결과를 표시할 수 없습니다.', '확인 가능한 분석 결과 형식이 필요합니다.');
  const complete = data.completeness === 'complete', partial = data.completeness === 'partial';
  const scope = scopeLabel(data);
  const verifiedScope = (data.appliedScope === 'priority' || scope.expanded) && scope.name !== '범위 미판정' &&
    data.regionDecision?.[data.appliedScope]?.conclusion === 'candidates_found';
  const summary = verifiedScope && data.comparables?.length
    ? scope.name + '에서 비교 단지 ' + data.comparables.length + '곳을 확인했습니다.'
    : complete ? '적용한 조건으로 가격과 거래 근거를 확인했습니다.' : partial ? '확인된 값과 근거가 부족한 항목을 함께 표시합니다.' : '저장된 분석에서 확인하지 못한 항목을 살펴보세요.';
  const jumpButton = conversationHtml
    ? `<button type="button" class="action secondary compact conv-jump-btn" data-conv="jump-composer">${icon('message-square')}대화로 질문하기</button>`
    : '';
  const stage = `<div class="comparison-stage"><header class="section-header result-heading"><div><h1>${esc(data.target?.name || title || '분석 결과')}</h1><p>${esc(summary)}</p></div>
    <div class="tag-row">${badge(complete ? 'verified' : partial ? 'partial' : 'unknown', complete ? 'shield-check' : 'circle-pause', complete ? '비교 검산 완료' : partial ? '일부 보류' : '비교 보류')}${data.dataOrigin === 'synthetic' ? badge('closed', 'layers', '합성 자료') : ''}${jumpButton}</div></header>
    ${holdPanel(data)}<div class="comparison-layout"><div id="market-view">${marketView(data, tradeKind)}</div><aside class="result-stack" aria-label="선택 공고의 금액과 근거">${priceView(data)}${evidenceView(data)}</aside></div></div>`;
  return `<section data-run-status="finished" data-result-status="${esc(data.completeness)}"${conversationHtml ? ' class="comparison-workspace"' : ''}>${stage}${conversationHtml}</section>`;
}

export function sampleHeld(n, m, asOf) {
  return {
    contractVersion: 'comparison/v1',
    dataOrigin: 'synthetic',
    completeness: 'unavailable',
    appliedScope: null,
    target: {
      name: n.title,
      noticeNo: n.noticeNo,
      houseManageNo: n.houseManageNo,
      edition: n.edition,
      modelNo: m.modelNo,
      houseType: m.houseType,
      supplyArea: null,
    },
    conditions: { asOf },
    regionDecision: { priority: null, expansion: null },
    noticePrice: {
      status: 'unverified',
      reasons: ['no_confirmed_room_subtotal'],
      confirmedRooms: [],
      heldRooms: [],
    },
    holds: [{ reasonCode: 'target_supply_area_unverified' }, { reasonCode: 'no_confirmed_room_subtotal' }],
    exclusions: [],
    comparables: [],
    collections: [],
  };
}

export function runView(state, conversationHtml = '', originRun = null) {
  const { run, comparison, runError, session } = state;
  if (!session)
    return emptyState(
      'log-in',
      '로그인이 필요한 분석입니다.',
      '접수할 때 사용한 계정으로 로그인하세요.',
      '<button class="action primary" data-action="auth">로그인</button>',
    );
  if (runError)
    return emptyState(
      'triangle-alert',
      '분석을 불러오지 못했습니다.',
      errorText(runError),
      '<button class="action secondary" data-action="reload-run">다시 조회</button>',
    );
  if (!run) return emptyState('loader-circle', '실행 상태를 확인하고 있습니다.');
  const n = state.directory?.notices?.find(
    (x) =>
      x.houseManageNo === run.input?.houseManageNo &&
      x.noticeNo === run.input?.noticeNo &&
      x.edition === run.input?.edition,
  );
  const title = n?.title ?? state.analyses?.find((x) => x.runId === run.runId)?.title ?? '청약 분석';
  if (run.status === 'finished' && comparison) return comparisonView(comparison, title, state.tradeKind, conversationHtml);
  const active = ['queued', 'running', 'retry_wait'].includes(run.status);
  const originLink =
    originRun && originRun.analysisId === run.analysisId && originRun.toRunId === run.runId
      ? `<a class="text-button origin-run-link" href="#run/${esc(originRun.analysisId)}/${esc(originRun.fromRunId)}">${icon('arrow-left')}이전 결과와 대화 보기</a>`
      : '';
  const caption =
    {
      queued: '실행을 접수했습니다. 작업자가 수집을 시작하면 자동으로 갱신합니다.',
      running: '공고와 주택형, 공식 출처를 확인하고 있습니다.',
      retry_wait: '일시적인 수집 오류가 있어 다음 시도를 기다리고 있습니다.',
      finished: '저장된 결과를 불러오고 있습니다.',
      cancelled: '요청에 따라 실행을 취소했습니다.',
      failed: reasonText(run.errorCode) ?? '실행을 마치지 못했습니다.',
    }[run.status] ?? '현재 실행 상태를 확인할 수 없습니다.';
  return `<section data-run-status="${esc(run.status)}"><div class="section-header"><div class="tag-row">${runBadge(run.status)}</div><h1>${esc(title)}</h1><p>${esc(caption)}</p></div><div class="result-layout"><section class="panel"><h2>실행 상태</h2><ul class="detail-list"><li><span>접수일</span><strong>${esc(dateText(todayKst(run.submittedAt)))}</strong></li><li><span>공고 번호</span><strong class="code">${esc(run.input?.noticeNo ?? '—')}</strong></li><li><span>모델 번호</span><strong class="code">${esc(run.input?.modelNo ?? '—')}</strong></li></ul><div class="form-actions">${active ? '<button class="action secondary" data-action="cancel">실행 취소</button>' : ''}${originLink}<button class="text-button" data-action="reload-run">${icon('refresh-cw')}상태 새로고침</button></div></section></div></section>`;
}
