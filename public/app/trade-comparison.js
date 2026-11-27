import { badge, dateText, esc, icon, supplyLabel, todayKst, won } from './display.js';
import { halfWon, noticeRange, priceLabel, tradeRange } from './comparison-values.js';
export { noticeRange, priceLabel } from './comparison-values.js';

export const tradeNames = { sale: '아파트 매매', presale_right: '분양권', occupancy_right: '입주권' };

function manwon(value) {
  const amount = halfWon(value);
  if (amount === null) return '—';
  const fraction = ((amount % 20000n) * 5n).toString().padStart(5, '0').replace(/0+$/, '');
  return (amount / 20000n).toLocaleString('ko-KR') + (fraction ? '.' + fraction : '');
}

function rangeChart(price, rows) {
  const trades = rows.filter(row => row.range);
  if (!trades.length) return '';
  const series = [...(price ? [{ name: '공고 소계', range: price, notice: true }] : []), ...trades];
  const edges = series.flatMap(row => [row.range.min, row.range.max])
    .sort((a, b) => halfWon(a) < halfWon(b) ? -1 : halfWon(a) > halfWon(b) ? 1 : 0);
  const first = halfWon(edges[0]), spread = halfWon(edges.at(-1)) - first;
  const position = value => spread === 0n ? 50 : Number((halfWon(value) - first) * 10000n / spread) / 100;
  return `<figure class="market-chart"><figcaption>가격 분포</figcaption>
    <div class="chart-legend">${price ? '<span class="legend-notice">공고 소계</span>' : ''}<span class="legend-trade">실거래 최저–최고 · 중위값</span></div>
    ${series.map(({ name, range, notice }) => `<div class="chart-series${notice ? ' notice-series' : ''}">
      <span class="series-name">${esc(name)}</span><span class="series-track" aria-hidden="true"><i style="left:${position(range.min)}%;right:${100 - position(range.max)}%"></i>
      ${range.mid ? `<b style="left:${position(range.mid)}%"></b>` : ''}</span><strong>${esc(range.mid ? won(range.mid) : priceLabel(range))}</strong></div>`).join('')}
    <div class="chart-axis" aria-hidden="true"><div><span>${esc(won(edges[0]))}</span>${spread ? `<span>${esc(won(edges.at(-1)))}</span>` : ''}</div></div>
    </figure>`;
}

function observationSource(stat, records) {
  const seen = new Map();
  for (const row of stat?.observations ?? []) {
    const record = records.get(row.recordId);
    if (!record || record.source !== row.source || !['apt_trade', 'apt_rights'].includes(record.source)) continue;
    seen.set(record.recordId, record);
  }
  if (!seen.size) return '';
  return `<details class="evidence-disclosure trade-source"><summary>${icon('database')}실거래 근거${icon('chevron-down')}</summary><ul>${Array.from(seen.values(), r => {
    const name = r.source === 'apt_trade' ? '아파트 매매' : '분양·입주권';
    const date = dateText(todayKst(r.collectedAt ?? null));
    return `<li>국토교통부 ${name} · 계약월 ${esc(r.month)}${date === '—' ? '' : ' · ' + date + ' 수집'}</li>`;
  }).join('')}</ul></details>`;
}

function statsTable(rows, records, name, price) {
  return `<div class="trade-scroll" role="region" tabindex="0" aria-label="${esc(name)}"><table role="table" class="data-table trade-table comparison-table">
    <caption class="sr-only">${esc(name)}. 가격 단위는 만 원입니다.</caption><thead><tr><th scope="col">단지 · 공급면적</th><th scope="col">확인 상태</th><th scope="col">건수</th><th scope="col">최저</th><th scope="col">중위</th><th scope="col">최고</th></tr></thead>
    <tbody>${price ? `<tr class="notice-price-row"><th scope="row">공고 소계</th><td colspan="5">분양가 + 필수 옵션 <strong>${esc(priceLabel(price))}</strong></td></tr>` : ''}
    ${rows.map(({ complexId, role, name, area, stat, range, manual }) => `<tr><th scope="row">${
      complexId
        ? `<button type="button" class="complex-row-trigger" data-open-complex="${esc(complexId)}" data-complex-role="${esc(role)}"><span>${esc(name)}</span><span class="complex-row-hint">상세</span></button>`
        : esc(name)
    }${manual ? '<span class="manual-replace-tag">직접 교체</span>' : ''}<small>공급 ${esc(supplyLabel(area))}</small></th>
      <td>${!range ? badge('unknown', 'circle-help', '미확인') : stat.status === 'provisional' ? badge('partial', 'circle-pause', '잠정') : badge('verified', 'circle-check', '확정')}${range ? observationSource(stat, records) : ''}</td>
      <td><span class="mobile-column-label" aria-hidden="true">건수</span>${range ? stat.count + '건' : '—'}${range && stat.smallSample ? '<small>소표본</small>' : ''}</td>
      ${['min', 'mid', 'max'].map((k, index) => `<td${range ? ' title="' + esc(won(range[k])) + '"' : ''}><span class="mobile-column-label" aria-hidden="true">${['최저', '중위', '최고'][index]}</span>${range ? manwon(range[k]) : '—'}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;
}

function rowsFor(candidates, kind, role) {
  return (candidates ?? []).map(c => ({
    complexId: typeof c.complexId === 'string' && c.complexId ? c.complexId : null,
    role,
    name: c.name || '단지명 미확인',
    area: c.supplyAreaM2,
    stat: c.tradeStats?.[kind],
    range: tradeRange(c.tradeStats?.[kind]),
    manual: c.selectionReason === 'manual_replacement',
  }));
}

export function marketView(data, kind) {
  const configured = Array.isArray(data.conditions?.tradeKinds) ? data.conditions.tradeKinds : Object.keys(tradeNames);
  const kinds = Object.keys(tradeNames).filter(key => configured.includes(key));
  const active = kinds.includes(kind) ? kind : kinds[0];
  const rows = rowsFor(data.comparables, active, 'comparable');
  const own = rowsFor(data.targetReferences, active, 'target');
  const price = noticeRange(data.noticePrice);
  const records = new Map((data.collections ?? []).map(r => [r.recordId, r]));
  const verifiedZero = kinds.filter(k => {
    const scope = data.tradeKinds?.[k];
    return scope?.conclusion === 'normal_zero' && scope.collectionStatus === 'complete' && scope.unresolvedRows === 0;
  });
  const hasStats = rows.some(row => row.range);
  const name = tradeNames[active] ?? '거래';
  const emptyText = verifiedZero.includes(active) ? '적용한 범위에서 ' + name + ' 거래가 0건으로 확인됐습니다.' :
    rows.length || own.length ? '현재 자료로 ' + name + ' 비교 가격을 산출할 수 없습니다.' : '현재 자료로 주변 실거래 가격을 비교할 수 없습니다.';
  return `<section class="panel market-panel" aria-label="주변 실거래 비교">
    <div class="market-head"><div class="panel-title">${icon('chart-no-axes-combined')}<h2>주변 실거래 비교</h2></div>${rows.length ? `<span class="small muted">비교 단지 ${rows.length}곳</span>` : ''}</div>
    ${(rows.length || own.length) && kinds.length ? `<div class="segmented trade-selector" aria-label="거래 유형" role="group" data-choice-group>${kinds.map(k => `<button type="button" data-trade-kind="${k}" aria-pressed="${k === active}" tabindex="${k === active ? 0 : -1}">${tradeNames[k]}</button>`).join('')}</div>` : ''}
    ${rangeChart(price, rows)}
    ${rows.some(r => r.range && r.stat.status === 'provisional') ? `<p class="scope-note">${icon('circle-pause')}잠정 통계에는 근거를 확인한 거래만 포함합니다. 추가 확인에 따라 값과 순위가 달라질 수 있습니다.</p>` : ''}
    ${!hasStats ? `<p class="market-empty">${icon(verifiedZero.includes(active) ? 'circle-minus' : 'circle-pause')}${esc(emptyText)}</p>` : ''}
    ${rows.length ? `<div class="table-heading"><h3>단지별 거래 통계</h3><span>단위 만 원</span></div>${statsTable(rows, records, name + ' 단지별 통계', price)}` : ''}
    ${verifiedZero.length ? `<div class="trade-summary">${verifiedZero.map(k => badge('zero', 'circle-minus', tradeNames[k] + ' · 해당 범위 0건')).join('')}</div>` : ''}
    ${(rows.length || own.length) && active ? `<p class="trade-note">${active === 'sale' ? '매매는 실제 신고된 거래가격입니다.' : '권리는 신고된 거래금액입니다.'} 거래가 1~2건이면 소표본으로 표시합니다.</p>` : ''}
    ${own.length ? `<div class="own-trades"><div class="table-heading"><h3>대상 단지 자체 거래</h3><span>단위 만 원</span></div>${statsTable(own, records, '대상 단지 자체 거래 통계', null)}</div>` : ''}
    </section>`;
}
