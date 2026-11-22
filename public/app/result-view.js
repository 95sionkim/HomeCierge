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
} from './display.js';
import { emptyState } from './directory-view.js';

const tradeNames = { sale: '아파트 매매', presale_right: '분양권', occupancy_right: '입주권' };
const descriptions = {
  complete: '필요한 근거를 확인했습니다.',
  partial: '확인된 항목과 보류 항목이 함께 있습니다.',
  unavailable: '비교에 필요한 근거를 확인 중입니다.',
};

function sourcePages(evidence) {
  const rows = Array.isArray(evidence) ? evidence : [];
  const labels = [
    ...new Set(rows.filter((x) => Number.isInteger(x?.page) && x.page > 0).map((x) => x.page)),
  ].sort((a, b) => a - b);
  return labels.length ? '공고문 ' + labels.join('·') + '쪽' : '문서 쪽수 미확인';
}
function priceRange(p) {
  if (p?.status !== 'confirmed') return '—';
  if (p.won !== null && p.won !== undefined) return won(p.won);
  if (p.minWon && p.maxWon)
    return p.minWon === p.maxWon ? won(p.minWon) : `${won(p.minWon)} – ${won(p.maxWon)}`;
  return '—';
}
function readableReasons(values) {
  return [...new Set((values ?? []).map((c) => reasonText(c)).filter(Boolean))];
}
function priceView(data) {
  const p = data.noticePrice ?? {};
  const confirmed = p.confirmedRooms ?? [],
    held = p.heldRooms ?? [];
  return `<section class="panel" aria-label="공고 호실 가격"><div class="aside-head"><h2>호실별 공고 가격</h2>${p.status === 'confirmed' ? badge('verified', 'circle-check', '근거 확인') : badge('unknown', 'circle-pause', '판정 보류')}</div>
    <p class="muted small">${p.scope === 'selected_room' ? '선택한 호실 소계' : '확인된 호실 소계'}</p><p class="big-price">${esc(priceRange(p))}</p>
    <p class="narrative">분양가와 해당 호실의 필수 옵션을 합한 금액입니다.</p>
    ${confirmed.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>호실</th><th>분양가</th><th>필수 옵션</th><th>소계</th></tr></thead><tbody>${confirmed.map((r) => `<tr><td>${esc(r.room)}</td><td>${esc(won(r.salePriceWon))}<small>${esc(sourcePages(r.evidence?.salePrice))}</small></td><td>${esc(won(r.requiredOptionsWon))}<small>${esc(sourcePages(r.evidence?.requiredOptions))}</small></td><td>${esc(won(r.subtotalWon))}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${held.map((r) => `<div class="state-box">${icon('circle-pause')}<div><strong>${esc(r.room)} · 소계 보류</strong><p>${esc(readableReasons(r.reasons).join(' ') || '호실별 금액 근거를 확인 중입니다.')}</p></div></div>`).join('')}
    ${p.status !== 'confirmed' ? `<p class="narrative">${esc(readableReasons(p.reasons).join(' ') || '같은 문서 판본에서 분양가와 필수 옵션을 확인한 뒤 표시합니다.')}</p>` : ''}
  </section>`;
}
function tradeStatsRow(kind, label, candidate) {
  const statistic = candidate.tradeStats?.[kind];
  const available = statistic?.status === 'confirmed' || statistic?.status === 'provisional';
  const tag =
    statistic?.status === 'confirmed'
      ? badge('verified', 'circle-check', '확정')
      : statistic?.status === 'provisional'
        ? badge('partial', 'circle-pause', '잠정')
        : badge('unknown', 'circle-help', '미확인');
  return `<tr><th scope="row">${label}</th><td>${tag}${statistic?.smallSample ? '<small>소표본</small>' : ''}</td><td>${available && Number.isInteger(statistic.count) ? statistic.count + '건' : '—'}</td>
    ${['minWon', 'medianWon', 'maxWon'].map((key) => `<td>${available ? esc(won(statistic[key])) : '—'}</td>`).join('')}</tr>`;
}

function candidateTable(c) {
  return `<div class="detail-block"><h3>${esc(c.name ?? '단지명 미확인')}</h3><p class="muted small">공급면적 ${esc(c.supplyAreaM2 ? c.supplyAreaM2 + '㎡' : '—')}</p><div class="trade-scroll" tabindex="0" role="region" aria-label="${esc(c.name ?? '비교 단지')} 거래 통계"><table class="data-table trade-table"><thead><tr><th scope="col">거래 유형</th><th scope="col">확인 상태</th><th scope="col">건수</th><th scope="col">최저</th><th scope="col">중위</th><th scope="col">최고</th></tr></thead><tbody>${Object.entries(
    tradeNames,
  )
    .map(([k, label]) => tradeStatsRow(k, label, c))
    .join('')}</tbody></table></div></div>`;
}

function ownReferences(data) {
  const own = data.targetReferences ?? [];
  return own.length
    ? `<section class="panel"><div class="aside-head"><h2>대상 단지 자체 거래</h2></div><p class="narrative">선택한 공고 단지에서 확인한 참고 거래입니다.</p>${own.map(candidateTable).join('')}</section>`
    : '';
}

function tradesView(data) {
  const comparables = data.comparables ?? [];
  const verifiedZero = Object.entries(tradeNames).filter(([key]) => {
    const scope = data.tradeKinds?.[key];
    return (
      scope?.conclusion === 'normal_zero' &&
      scope.collectionStatus === 'complete' &&
      scope.unresolvedRows === 0
    );
  });
  const zeroSummary = verifiedZero.length
    ? `<div class="trade-summary">${verifiedZero.map(([, label]) => badge('zero', 'circle-minus', label + ' · 해당 범위 0건')).join('')}</div>`
    : '';
  if (!comparables.length) {
    const allZero = verifiedZero.length === Object.keys(tradeNames).length;
    return `<section class="panel"><div class="aside-head"><h2>주변 실거래</h2>${allZero ? badge('zero', 'circle-minus', '정상 0건') : badge('unknown', 'circle-pause', '확인 필요')}</div><p class="narrative">${allZero ? '확인한 조건과 지역에서 비교 가능한 거래가 0건입니다.' : '현재 자료로 비교 가격을 산출할 수 없습니다.'}</p>${zeroSummary}</section>`;
  }
  const hasProvisional = comparables.some((c) =>
    Object.values(c.tradeStats ?? {}).some((t) => t?.status === 'provisional'),
  );
  return `<section class="panel"><div class="aside-head"><h2>주변 실거래</h2><span class="small muted">${comparables.length}개 단지</span></div>
    ${hasProvisional ? `<div class="scope-note">${icon('circle-pause')}<span>잠정 통계에는 근거를 확인한 거래만 포함합니다. 아직 확인 중인 거래에 따라 값과 순위가 달라질 수 있습니다.</span></div>` : ''}
    ${comparables.map(candidateTable).join('')}
    ${zeroSummary}<p class="trade-note">매매는 거래가격, 분양권과 입주권은 신고된 권리 거래금액입니다. 1~2건은 소표본으로 표시합니다.</p></section>`;
}
function relations(data) {
  const t = data.target ?? {},
    c = data.conditions ?? {},
    r = data.regionDecision ?? {};
  const rows = [
    ['주택형', t.houseType ?? '—'],
    [
      '공급면적',
      t.supplyArea?.status === 'confirmed' && t.supplyArea?.m2 ? t.supplyArea.m2 + '㎡' : '확인 필요',
    ],
    ['계약 기간', c.period?.status === 'confirmed' ? rangeLabel(c.period, false) : '확인 필요'],
    ['우선 지역', r.priority?.name ?? '확인 필요'],
    [
      '확대 지역',
      r.expansion?.name ?? (r.reasonCode === 'priority_candidates_found' ? '확대 없음' : '미판정'),
    ],
  ];
  return `<section class="panel"><div class="aside-head"><h2>적용 조건</h2></div><ul class="detail-list">${rows.map(([k, v]) => `<li><span>${k}</span><strong>${esc(v)}</strong></li>`).join('')}</ul></section>`;
}
function evidenceView(data) {
  const refs = [
    ...(data.target?.supplyArea?.evidence ?? []),
    ...(data.noticePrice?.confirmedRooms ?? []).flatMap((r) => [
      ...(r.evidence?.salePrice ?? []),
      ...(r.evidence?.requiredOptions ?? []),
    ]),
  ];
  const sources = new Map(),
    count = data.collections?.length ?? 0;
  for (const r of refs) {
    if (!r?.document || !r.version || !Number.isInteger(r.page)) continue;
    const key = r.document + '\n' + r.version;
    if (!sources.has(key)) sources.set(key, { ...r, pages: new Set() });
    sources.get(key).pages.add(r.page);
  }
  return `<section class="panel"><div class="aside-head"><h2>${icon('file-text')}자료 근거</h2></div>
    <p class="small muted">${data.dataOrigin === 'synthetic' ? '합성 자료로 계산한 예시입니다.' : '이번 분석에서 사용한 수집 기록입니다.'}</p><p class="small muted">분석 기준일 ${esc(dateText(data.conditions?.asOf))}</p>
    ${sources.size ? `<ul class="source-list">${[...sources.values()].map((r) => `<li>공고문 ${[...r.pages].sort((a, b) => a - b).join('·')}쪽<small>판본 <span class="code">${esc(r.version)}</span></small></li>`).join('')}</ul>` : '<p class="narrative">호실 가격과 면적을 확인할 문서 근거가 없습니다.</p>'}
    ${count ? `<p class="small muted">실거래 수집 범위 ${count}개</p>` : ''}</section>`;
}

export function comparisonView(data, title) {
  if (!data || data.contractVersion !== 'comparison/v1')
    return emptyState(
      'circle-help',
      '결과를 표시할 수 없습니다.',
      '확인 가능한 분석 결과 형식이 필요합니다.',
    );
  const holds = readableReasons((data.holds ?? []).map((h) => h.reasonCode));
  const completeness = data.completeness;
  const label =
    completeness === 'complete' ? '검산 완료' : completeness === 'partial' ? '일부 보류' : '비교 보류';
  return `<section data-run-status="finished" data-result-status="${esc(completeness)}"><div class="section-header"><div class="tag-row">${badge(completeness === 'complete' ? 'verified' : completeness === 'partial' ? 'partial' : 'unknown', completeness === 'complete' ? 'shield-check' : 'circle-pause', label)}${data.dataOrigin === 'synthetic' ? badge('closed', 'layers', '합성 자료') : ''}</div><h1>${esc(data.target?.name || title || '분석 결과')}</h1><p>${esc(descriptions[completeness] ?? '분석 결과의 확인 상태를 살펴보세요.')}</p></div>
    <div class="result-layout"><div class="result-stack">${holds.length ? `<section class="panel hold-panel"><h2>확인이 필요한 근거</h2><ul class="source-list">${holds.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}${priceView(data)}${tradesView(data)}${ownReferences(data)}</div><aside class="result-stack">${relations(data)}${evidenceView(data)}</aside></div></section>`;
}

export function sampleHeld(n, m, asOf) {
  return {
    contractVersion: 'comparison/v1',
    dataOrigin: 'synthetic',
    completeness: 'unavailable',
    target: {
      name: n.title,
      noticeNo: n.noticeNo,
      modelNo: m.modelNo,
      houseType: m.houseType,
      supplyArea: null,
    },
    conditions: { asOf },
    noticePrice: {
      status: 'unverified',
      reasons: ['no_confirmed_room_subtotal'],
      confirmedRooms: [],
      heldRooms: [],
    },
    holds: [{ reasonCode: 'target_supply_area_unverified' }, { reasonCode: 'no_confirmed_room_subtotal' }],
    comparables: [],
    collections: [],
  };
}

export function runView(state) {
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
  if (run.status === 'finished' && comparison) return comparisonView(comparison, title);
  const active = ['queued', 'running', 'retry_wait'].includes(run.status);
  const caption =
    {
      queued: '실행을 접수했습니다. 작업자가 수집을 시작하면 자동으로 갱신합니다.',
      running: '공고와 주택형, 공식 출처를 확인하고 있습니다.',
      retry_wait: '일시적인 수집 오류가 있어 다음 시도를 기다리고 있습니다.',
      finished: '저장된 결과를 불러오고 있습니다.',
      cancelled: '요청에 따라 실행을 취소했습니다.',
      failed: reasonText(run.errorCode) ?? '실행을 마치지 못했습니다.',
    }[run.status] ?? '현재 실행 상태를 확인할 수 없습니다.';
  return `<section data-run-status="${esc(run.status)}"><div class="section-header"><div class="tag-row">${runBadge(run.status)}</div><h1>${esc(title)}</h1><p>${esc(caption)}</p></div><div class="result-layout"><section class="panel"><h2>실행 상태</h2><ul class="detail-list"><li><span>접수일</span><strong>${esc(dateText(todayKst(run.submittedAt)))}</strong></li><li><span>공고 번호</span><strong class="code">${esc(run.input?.noticeNo ?? '—')}</strong></li><li><span>모델 번호</span><strong class="code">${esc(run.input?.modelNo ?? '—')}</strong></li></ul><div class="form-actions">${active ? '<button class="action secondary" data-action="cancel">실행 취소</button>' : ''}<button class="text-button" data-action="reload-run">${icon('refresh-cw')}상태 새로고침</button></div></section></div></section>`;
}
