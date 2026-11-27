import { badge, dateText, errorText, esc, icon, supplyLabel, todayKst, won } from './display.js';
import { halfWon, noticeRange, priceLabel, tradeRange } from './comparison-values.js';
import { evidenceReasonLabel, formatAreaDiff, formatMeters } from './comparison-scope.js';

const tradeNames = { sale: '아파트 매매', presale_right: '분양권', occupancy_right: '입주권' };
const tradeShortNames = { sale: '매매', presale_right: '분양권', occupancy_right: '입주권' };
const sourceLabels = {
  kapt: 'K-apt',
  building_register: '건축물대장',
  apt_trade: '국토부 매매 실거래',
  apt_rights: '국토부 분양·입주권',
  'synthetic-complex-register': '합성 단지 대장',
  'synthetic-region-register': '합성 지역 대장',
  'synthetic-coordinate-register': '합성 좌표 대장',
  'synthetic-area-register': '합성 면적 대응',
};

function labelSource(source) {
  if (typeof source !== 'string' || !source) return '출처 미확인';
  return sourceLabels[source] ?? source;
}

function manwon(value) {
  const amount = halfWon(value);
  if (amount === null) return '—';
  const fraction = ((amount % 20000n) * 5n).toString().padStart(5, '0').replace(/0+$/, '');
  return (amount / 20000n).toLocaleString('ko-KR') + (fraction ? '.' + fraction : '');
}

function locatorKey(ref) {
  if (!ref || typeof ref.recordId !== 'string' || typeof ref.source !== 'string') return null;
  if (!Number.isSafeInteger(ref.page) || !Number.isSafeInteger(ref.position)) return null;
  return `${ref.recordId}\0${ref.source}\0${ref.page}\0${ref.position}`;
}

function observationMap(evidenceDetail) {
  const map = new Map();
  for (const row of evidenceDetail?.tradeObservations ?? []) {
    const key = locatorKey(row);
    if (key) map.set(key, row);
  }
  return map;
}

// R-09: 이름만으로 단지를 연결하지 않는다. 지역코드·단지번호·지번·도로명 식별 키만 대조한다.
function verifiedIdentityKeys(identifiers) {
  if (!identifiers || typeof identifiers !== 'object') return [];
  const keys = [];
  const sgg = identifiers.sggCd;
  const name = identifiers.aptNm;
  const seq = identifiers.aptSeq;
  const umd = identifiers.umdNm;
  const jibun = identifiers.jibun;
  const road = identifiers.roadNm;
  const roadMain = identifiers.roadNmBonbun;
  const roadSub = identifiers.roadNmBubun ?? '';
  if (sgg && seq) keys.push(`seq:${sgg}:${seq}`);
  if (sgg && umd && name && jibun) keys.push(`parcel:${sgg}:${umd}:${name}:${jibun}`);
  if (sgg && name && road && roadMain) keys.push(`road:${sgg}:${name}:${road}:${roadMain}:${roadSub}`);
  return keys;
}

function formatRoadAddress(id) {
  if (!id?.roadNm) return null;
  const main = id.roadNmBonbun ? String(Number(id.roadNmBonbun) || id.roadNmBonbun) : '';
  const sub = id.roadNmBubun && Number(id.roadNmBubun) > 0 ? '-' + String(Number(id.roadNmBubun)) : '';
  return [id.roadNm, main + sub].filter(Boolean).join(' ');
}

function formatJibun(id) {
  if (id?.jibun) return id.jibun;
  if (id?.bonbun) {
    const main = String(Number(id.bonbun) || id.bonbun);
    const sub = id.bubun && Number(id.bubun) > 0 ? '-' + String(Number(id.bubun)) : '';
    return main + sub;
  }
  return null;
}

function emptyCell(statusLabel = '미제공', style = 'unknown', symbol = 'circle-help') {
  return `<span class="hc-cell-empty" aria-label="값 없음">—</span> ${badge(style, symbol, statusLabel)}`;
}

function uniqueValues(items) {
  return [...new Set(items.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()))];
}

function renderCharacteristicField(characteristics, field, formatValue, fallbackObservationValues = null) {
  const matching = (characteristics ?? []).filter((c) => c && c.field === field);
  if (!matching.length) {
    if (fallbackObservationValues?.length) {
      return `<span>${esc(fallbackObservationValues.join(' · '))}</span> <small class="muted">실거래 관측 건축년도</small>`;
    }
    return emptyCell('미확인');
  }
  const confirmed = matching.filter((c) => c.status === 'confirmed' && c.value != null);
  const conflicts = matching.filter((c) => c.status === 'conflict');
  const failed = matching.filter((c) => c.status === 'failed');
  const empty = matching.filter((c) => c.status === 'empty');

  const distinctConfirmed = new Map();
  for (const item of confirmed) {
    const valStr = String(item.value);
    const sources = distinctConfirmed.get(valStr) ?? [];
    sources.push(labelSource(item.evidence?.source));
    distinctConfirmed.set(valStr, sources);
  }
  const valueConflict = distinctConfirmed.size > 1 || conflicts.length > 0;
  const segments = [];

  if (distinctConfirmed.size > 0) {
    const rendered = [...distinctConfirmed.entries()]
      .map(([raw, sources]) => `${formatValue(raw)} (${[...new Set(sources)].join(', ')})`)
      .join(' · ');
    segments.push(`<span class="num">${esc(rendered)}</span>`);
  }
  if (valueConflict) {
    const conflictSources = uniqueValues(conflicts.map((c) => labelSource(c.evidence?.source)));
    segments.push(
      badge(
        'conflict',
        'link-2-off',
        conflictSources.length ? `출처 충돌 (${conflictSources.join('·')})` : '출처 충돌',
      ),
    );
  } else if (distinctConfirmed.size === 1) {
    segments.push(badge('verified', 'circle-check', '확인됨'));
  }
  for (const item of failed) {
    const codeNote = item.errorCode ? ` 오류 ${item.errorCode}` : '';
    const src = labelSource(item.evidence?.source);
    segments.push(
      `<span class="hc-cell-empty" aria-label="값 없음">—</span> ${badge('failed', 'triangle-alert', `${src} 조회 실패${codeNote}`)}`,
    );
  }
  if (!confirmed.length && !conflicts.length && !failed.length && empty.length) {
    const src = uniqueValues(empty.map((c) => labelSource(c.evidence?.source))).join('·');
    segments.push(`<span class="hc-cell-empty" aria-label="값 없음">—</span> ${badge('zero', 'circle-minus', `${src || '출처'} 정상 0건`)}`);
  }

  return `<div class="sheet-inline-list">${segments.join(' ')}</div>`;
}

function renderPriceRange(stat, notice, kind) {
  const range = tradeRange(stat);
  if (!range) {
    return `<div class="sheet-empty-range">
      <span class="hc-cell-empty" aria-label="값 없음">—</span>
      ${badge('unknown', 'circle-help', `${tradeNames[kind] ?? '해당 종류'} 유효 거래 없음`)}
    </div>`;
  }
  const values = [range.min, range.max, ...(notice ? [notice.min, notice.max] : [])]
    .sort((a, b) => (halfWon(a) < halfWon(b) ? -1 : halfWon(a) > halfWon(b) ? 1 : 0));
  const first = halfWon(values[0]);
  const spread = halfWon(values.at(-1)) - first;
  const pos = (v) => (spread === 0n ? 50 : Number(((halfWon(v) - first) * 10000n) / spread) / 100);
  const left = pos(range.min);
  const width = Math.max(2, pos(range.max) - left);
  const medianPos = pos(range.mid);
  const noticeMid = notice ? (halfWon(notice.min) === halfWon(notice.max) ? pos(notice.min) : (pos(notice.min) + pos(notice.max)) / 2) : null;

  return `<div class="sheet-price-range">
    <div class="hc-range">
      <div class="hc-range-track" aria-hidden="true">
        <span class="hc-range-bar" style="left:${left}%;width:${width}%"></span>
        <span class="hc-range-median" style="left:${medianPos}%"></span>
        ${noticeMid !== null ? `<span class="hc-range-notice" style="left:${noticeMid}%"><span class="hc-range-notice-label">공고 소계</span></span>` : ''}
      </div>
      <div class="hc-range-legend num">
        <span><i class="hc-key hc-key-range" aria-hidden="true"></i>최소 ${esc(manwon(range.min))} · 최대 ${esc(manwon(range.max))}만 원</span>
        <span><i class="hc-key hc-key-median" aria-hidden="true"></i>중위 ${esc(manwon(range.mid))}만 원 (${esc(won(range.mid))})</span>
        ${notice ? `<span class="hc-range-legend-notice"><i class="hc-key hc-key-notice" aria-hidden="true"></i>공고 소계 ${esc(priceLabel(notice))}</span>` : ''}
      </div>
    </div>
    <p class="sheet-range-note">
      ${kind === 'sale' ? '실제 신고된 매매 거래가격입니다.' : '신고된 권리 거래금액입니다. 매매가격이나 프리미엄과 같은 뜻이 아닙니다.'}
      ${stat.smallSample ? ` 유효 거래 ${stat.count}건으로 적은 표본입니다.` : ''}
    </p>
  </div>`;
}

function collectComplexTrades(comparison, complex, evidenceDetail) {
  const obsByKey = observationMap(evidenceDetail);
  const includedKeys = new Set();
  const identityKeys = new Set();
  const includedRows = [];
  const matchedIdentifiers = [];
  const buildYears = [];

  for (const kind of Object.keys(tradeNames)) {
    const stat = complex.tradeStats?.[kind];
    if (!stat || !Array.isArray(stat.observations)) continue;
    for (const obs of stat.observations) {
      const key = locatorKey(obs);
      if (key) includedKeys.add(key);
      const snapObs = key ? obsByKey.get(key) : null;
      if (snapObs?.identifiers) {
        matchedIdentifiers.push(snapObs.identifiers);
        for (const idKey of verifiedIdentityKeys(snapObs.identifiers)) identityKeys.add(idKey);
      }
      if (obs.buildYear) buildYears.push(obs.buildYear);
      else if (snapObs?.buildYear) buildYears.push(snapObs.buildYear);
      includedRows.push({
        bucket: 'included',
        kind,
        contractDate: obs.contractDate ?? snapObs?.contractDate ?? null,
        exclusiveAreaM2: obs.exclusiveAreaM2 ?? snapObs?.exclusiveAreaM2 ?? null,
        supplyAreaM2: complex.supplyAreaM2 ?? null,
        floor: obs.floor ?? snapObs?.floor ?? null,
        won: obs.won ?? snapObs?.amountWon ?? null,
        status: stat.status === 'provisional' ? 'provisional' : 'confirmed',
        reasonCode: null,
        cancelled: false,
        cancellationDate: null,
        page: obs.page,
        position: obs.position,
      });
    }
  }

  const excludedRows = [];
  let unattributedScopeExclusions = 0;
  for (const ex of comparison.exclusions ?? []) {
    if (!ex || typeof ex !== 'object') continue;
    const key = locatorKey(ex.reference);
    if (key && includedKeys.has(key)) continue;
    const snapObs = key ? obsByKey.get(key) : null;
    let belongs = ex.complexId === complex.complexId;
    if (!belongs && ex.complexId === null && snapObs?.identifiers && identityKeys.size > 0) {
      const exKeys = verifiedIdentityKeys(snapObs.identifiers);
      belongs = exKeys.some((k) => identityKeys.has(k));
    }
    if (!belongs) {
      if (ex.complexId === null && ex.reasonCode !== 'outside_applied_region') {
        unattributedScopeExclusions += 1;
      }
      continue;
    }
    if (snapObs?.identifiers) matchedIdentifiers.push(snapObs.identifiers);
    excludedRows.push({
      bucket: 'excluded',
      kind: ex.tradeKind ?? snapObs?.tradeKind ?? null,
      contractDate: snapObs?.contractDate ?? null,
      exclusiveAreaM2: snapObs?.exclusiveAreaM2 ?? null,
      supplyAreaM2: ex.supplyAreaM2 ?? null,
      floor: snapObs?.floor ?? null,
      won: snapObs?.amountWon ?? null,
      status: 'excluded',
      reasonCode: ex.reasonCode,
      cancelled: ex.reasonCode === 'cancelled_trade' || snapObs?.cancellationStatus === 'cancelled',
      cancellationDate: snapObs?.cancellationDate ?? null,
      page: ex.reference?.page ?? null,
      position: ex.reference?.position ?? null,
    });
  }

  const heldRows = [];
  for (const hold of comparison.holds ?? []) {
    if (!hold || hold.complexId !== complex.complexId) continue;
    const refs = hold.reference ? [hold.reference] : Array.isArray(hold.references) ? hold.references : [null];
    for (const ref of refs) {
      const key = locatorKey(ref);
      const snapObs = key ? obsByKey.get(key) : null;
      heldRows.push({
        bucket: 'held',
        kind: hold.tradeKind ?? snapObs?.tradeKind ?? null,
        contractDate: snapObs?.contractDate ?? null,
        exclusiveAreaM2: snapObs?.exclusiveAreaM2 ?? null,
        supplyAreaM2: null,
        floor: snapObs?.floor ?? null,
        won: snapObs?.amountWon ?? null,
        status: 'held',
        reasonCode: hold.reasonCode,
        cancelled: false,
        cancellationDate: null,
        page: ref?.page ?? null,
        position: ref?.position ?? null,
      });
    }
  }

  const byDateDesc = (a, b) =>
    (b.contractDate ?? '').localeCompare(a.contractDate ?? '') ||
    (a.page ?? 0) - (b.page ?? 0) ||
    (a.position ?? 0) - (b.position ?? 0);

  return {
    includedRows: includedRows.sort(byDateDesc),
    excludedRows: excludedRows.sort(byDateDesc),
    heldRows: heldRows.sort(byDateDesc),
    matchedIdentifiers,
    buildYears: uniqueValues(buildYears),
    unattributedScopeExclusions,
  };
}

function renderIdentifierValues(values, emptyLabel = '미제공') {
  if (!values.length) return emptyCell(emptyLabel);
  if (values.length === 1) return `<span class="code">${esc(values[0])}</span>`;
  return `<div class="sheet-inline-list"><span class="code">${esc(values.join(' · '))}</span> ${badge('conflict', 'link-2-off', '출처 충돌')}</div>`;
}

function renderTradeRow(row) {
  const kindLabel = row.kind ? tradeShortNames[row.kind] ?? '미확인' : '미확인';
  const areaHtml = row.supplyAreaM2
    ? `공급 ${esc(supplyLabel(row.supplyAreaM2))}${row.exclusiveAreaM2 ? `<small class="hc-cell-sub">전용 ${esc(supplyLabel(row.exclusiveAreaM2))}</small>` : ''}`
    : row.exclusiveAreaM2
      ? `전용 ${esc(supplyLabel(row.exclusiveAreaM2))}<small class="hc-cell-sub">공급 미확인</small>`
      : '<span class="hc-cell-empty" aria-label="값 없음">—</span>';
  const amountText = row.won ? manwon(row.won) : '—';
  const amountHtml =
    row.cancelled && row.won
      ? `<del class="cancelled-amount" title="${esc(won(row.won))} (해제)">${esc(amountText)}</del>`
      : row.won
        ? `<span title="${esc(won(row.won))}">${esc(amountText)}</span>`
        : '<span class="hc-cell-empty" aria-label="값 없음">—</span>';

  let statusHtml;
  if (row.bucket === 'included') {
    statusHtml =
      row.status === 'provisional'
        ? badge('partial', 'chart-pie', '잠정 포함')
        : badge('verified', 'circle-check', '통계 포함');
  } else if (row.cancelled) {
    statusHtml = `${badge('zero', 'circle-minus', '해제 · 통계 제외')}${row.cancellationDate ? `<small class="hc-cell-sub">해제일 ${esc(row.cancellationDate)}</small>` : ''}`;
  } else if (row.bucket === 'excluded') {
    statusHtml = badge('zero', 'circle-minus', evidenceReasonLabel(row.reasonCode));
  } else {
    statusHtml = badge('partial', 'circle-pause', evidenceReasonLabel(row.reasonCode));
  }

  return `<tr class="${row.bucket === 'excluded' ? 'is-muted' : row.bucket === 'held' ? 'is-held-row' : ''}">
    <th scope="row" class="num">${esc(row.contractDate ? dateText(row.contractDate) : '—')}</th>
    <td><span class="mobile-column-label" aria-hidden="true">종류</span>${esc(kindLabel)}</td>
    <td class="num"><span class="mobile-column-label" aria-hidden="true">면적</span>${areaHtml}</td>
    <td class="is-right num"><span class="mobile-column-label" aria-hidden="true">층</span>${row.floor ? esc(row.floor) + '층' : '—'}</td>
    <td class="is-right num"><span class="mobile-column-label" aria-hidden="true">금액(만 원)</span>${amountHtml}</td>
    <td><span class="mobile-column-label" aria-hidden="true">판정</span>${statusHtml}</td>
  </tr>`;
}

export function createComplexDetailSheet({ sheet, announce, loadEvidence }) {
  let state = null;
  let reqToken = 0;

  function close({ restoreFocus = true } = {}) {
    const trigger = state?.trigger;
    ++reqToken;
    state = null;
    if (sheet.dataset.sheet === 'complex') {
      delete sheet.dataset.sheet;
      if (sheet.open) sheet.close();
      sheet.innerHTML = '';
    }
    if (restoreFocus && trigger && trigger.isConnected) {
      trigger.focus({ preventScroll: true });
    }
  }

  function renderSheet() {
    if (!state) return;
    const { comparison, complex, role, activeKind, filter, evidenceDetail, loading, error } = state;
    const isTarget = role === 'target';
    const availableKinds = Object.keys(tradeNames).filter((k) => tradeRange(complex.tradeStats?.[k]));
    const displayKind = availableKinds.includes(activeKind) ? activeKind : (availableKinds[0] ?? activeKind ?? 'sale');
    const stat = complex.tradeStats?.[displayKind] ?? null;
    const notice = noticeRange(comparison.noticePrice);
    const trades = collectComplexTrades(comparison, complex, evidenceDetail);

    const aptSeqs = uniqueValues(trades.matchedIdentifiers.map((i) => i.aptSeq));
    const umdNames = uniqueValues(trades.matchedIdentifiers.map((i) => i.umdNm));
    const umdCodes = uniqueValues(trades.matchedIdentifiers.map((i) => i.umdCd));
    const sggCodes = uniqueValues(trades.matchedIdentifiers.map((i) => i.sggCd));
    const jibuns = uniqueValues(trades.matchedIdentifiers.map(formatJibun));
    const roads = uniqueValues(trades.matchedIdentifiers.map(formatRoadAddress));

    const kaptRefs = uniqueValues([
      ...(complex.identityEvidence?.source === 'kapt' ? [complex.identityEvidence.reference] : []),
      ...(complex.characteristics ?? [])
        .filter((c) => c?.evidence?.source === 'kapt' && c.evidence.reference)
        .map((c) => c.evidence.reference),
    ]);

    const hasCharConflict = (() => {
      const byField = new Map();
      for (const c of complex.characteristics ?? []) {
        if (!c) continue;
        if (c.status === 'conflict') return true;
        if (c.status === 'confirmed' && c.field) {
          const vals = byField.get(c.field) ?? new Set();
          vals.add(String(c.value));
          byField.set(c.field, vals);
          if (vals.size > 1) return true;
        }
      }
      return false;
    })();

    const allRows = [...trades.includedRows, ...trades.excludedRows, ...trades.heldRows];
    const filteredRows =
      filter === 'included'
        ? trades.includedRows
        : filter === 'excluded'
          ? trades.excludedRows
          : filter === 'held'
            ? trades.heldRows
            : allRows;

    const targetArea = comparison.target?.supplyArea;
    const areaCond = comparison.conditions?.area;
    const selectionReasonText =
      {
        area_difference_then_straight_line: '공급면적 차이 우선 · 동률 시 직선거리순',
        area_difference_rank_pending: '동률 또는 좌표 미확인으로 순위 보류 (D-03)',
        manual_replacement: complex.replacesComplexId
          ? `사용자 직접 지정 교체 (기존 ${complex.replacesComplexId} 대체)`
          : '사용자 직접 지정 교체',
        target_reference: '대상 단지 자체 거래 (주변 비교 5단지 집계 제외)',
      }[complex.selectionReason] ?? '선정 근거 미확인';

    const dist = complex.distance;
    const distDisplay =
      dist?.status === 'confirmed' && typeof dist.meters === 'number'
        ? `<span class="num">${esc(formatMeters(dist.meters))}</span> <small class="muted">확인 좌표 간 직선거리</small>`
        : dist?.status === 'conflict'
          ? emptyCell('좌표 출처 충돌', 'conflict', 'link-2-off')
          : emptyCell('거리 미확인');

    // 출처 칩
    const sourceChips = [];
    const seenCollections = new Set();
    for (const c of comparison.collections ?? []) {
      const label = c.source === 'apt_trade' ? '국토부 매매 실거래' : '국토부 분양·입주권';
      const day = dateText(todayKst(c.collectedAt ?? null));
      const key = `${label}:${day}`;
      if (seenCollections.has(key)) continue;
      seenCollections.add(key);
      sourceChips.push(
        `<span class="hc-src">${icon('database')}<span>${esc(label)}</span>${day !== '—' ? `<span class="hc-src-detail">${esc(day)} 수집</span>` : ''}</span>`,
      );
    }
    if (complex.identityEvidence?.source) {
      sourceChips.push(
        `<span class="hc-src">${icon('database')}<span>${esc(labelSource(complex.identityEvidence.source))}</span><span class="hc-src-detail code">${esc(complex.identityEvidence.reference)}</span></span>`,
      );
    }
    const charSources = uniqueValues((complex.characteristics ?? []).map((c) => c?.evidence?.source));
    for (const src of charSources) {
      if (src === complex.identityEvidence?.source) continue;
      sourceChips.push(`<span class="hc-src">${icon('database')}<span>${esc(labelSource(src))}</span></span>`);
    }

    const totalIncluded = trades.includedRows.length;
    const rankChip = isTarget
      ? badge('zero', 'info', '자체 거래 · 별도 참고')
      : Number.isSafeInteger(complex.rank)
        ? `<span class="scope-rank-chip">${complex.rank}순위</span>`
        : badge('partial', 'circle-pause', '순위 보류');

    const subtitleParts = [
      umdNames.length ? umdNames.join('·') : complex.localityCode ? `지역코드 ${complex.localityCode}` : null,
      `공급 ${supplyLabel(complex.supplyAreaM2)}`,
      `유효 거래 ${totalIncluded}건`,
    ].filter(Boolean);

    sheet.dataset.sheet = 'complex';
    sheet.innerHTML = `<div class="hc-sheet-shell">
      <header class="hc-sheet-head">
        <div class="hc-sheet-title-wrap">
          <div class="tag-row">${rankChip}${comparison.dataOrigin === 'synthetic' ? badge('closed', 'layers', '합성 자료') : ''}</div>
          <h2 id="sheet-title">${esc(complex.name || '단지 상세')}</h2>
          <p class="hc-sheet-sub">${esc(subtitleParts.join(' · '))}</p>
        </div>
        <button type="button" class="quiet-icon" data-sheet-close aria-label="단지 상세 닫기">${icon('x')}</button>
      </header>
      <div class="hc-sheet-body">
        ${isTarget ? `<div class="scope-rule-note" role="note">${icon('info')}<span>대상 단지 자체 거래입니다. 주변 비교표와 최대 5단지 집계에서 제외한 별도 참고 자료입니다.</span></div>` : ''}
        ${loading ? `<div class="sheet-status-banner" role="status">${icon('loader-circle', 'spin')}<span>수집본의 식별 근거와 제외 거래를 불러오고 있습니다.</span></div>` : ''}
        ${error ? `<div class="sheet-error-banner" role="alert">${icon('triangle-alert')}<span>${esc(errorText(error))}</span></div>` : ''}

        <section class="sheet-section" aria-label="실거래 범위">
          <div class="sheet-section-head">
            <h3>실거래 범위 · 만 원</h3>
            ${
              availableKinds.length > 1
                ? `<div class="segmented sheet-seg" role="group" aria-label="거래 종류 선택">${availableKinds
                    .map(
                      (k) =>
                        `<button type="button" data-complex-kind="${esc(k)}" aria-pressed="${k === displayKind}">${esc(tradeShortNames[k])}</button>`,
                    )
                    .join('')}</div>`
                : ''
            }
          </div>
          ${renderPriceRange(stat, notice, displayKind)}
        </section>

        <section class="sheet-section" aria-label="선정 면적과 기준 대비 차이">
          <h3>선정 면적과 비교 기준</h3>
          <dl class="hc-detail-dl">
            <div><dt>선정 면적</dt><dd><strong>공급 ${esc(supplyLabel(complex.supplyAreaM2))}</strong> <span class="code muted">(${esc(complex.supplyAreaM2 || '—')}㎡)</span></dd></div>
            <div><dt>공고 기준</dt><dd>${targetArea?.status === 'confirmed' ? `공급 ${esc(supplyLabel(targetArea.m2))}${areaCond?.tolerancePercent != null ? ` <small class="muted">(±${esc(areaCond.tolerancePercent)}% · ${esc(supplyLabel(areaCond.minM2))}–${esc(supplyLabel(areaCond.maxM2))})</small>` : ''}` : emptyCell('면적 미확인')}</dd></div>
            <div><dt>기준 대비 차이</dt><dd class="num">${complex.areaDifferenceM2 != null ? `<strong>${esc(formatAreaDiff(complex.areaDifferenceM2))}</strong> <span class="code muted">(${esc(complex.areaDifferenceM2)}㎡)</span>` : emptyCell('미확인')}</dd></div>
            ${isTarget ? '' : `<div><dt>직선거리</dt><dd>${distDisplay}</dd></div>`}
            <div><dt>선정 근거</dt><dd>${esc(selectionReasonText)}</dd></div>
          </dl>
        </section>

        <section class="sheet-section" aria-label="식별 근거와 단지 특성">
          <h3>식별 근거와 단지 특성</h3>
          <dl class="hc-detail-dl">
            <div><dt>실거래 단지 번호</dt><dd>${renderIdentifierValues(aptSeqs, '미제공')}</dd></div>
            <div><dt>법정동</dt><dd>${
              umdNames.length || complex.localityCode
                ? `${umdNames.length ? `<strong>${esc(umdNames.join(' · '))}</strong> ` : ''}${complex.localityCode ? `<span class="code">${esc(complex.localityCode)}</span>` : ''}${umdCodes.length ? ` <small class="muted code">umdCd ${esc(umdCodes.join('·'))}</small>` : ''}${sggCodes.length ? ` <small class="muted code">sggCd ${esc(sggCodes.join('·'))}</small>` : ''}`
                : emptyCell('미확인')
            }</dd></div>
            <div><dt>지번</dt><dd>${renderIdentifierValues(jibuns, '미제공')}</dd></div>
            <div><dt>도로명</dt><dd>${renderIdentifierValues(roads, '미제공')}</dd></div>
            <div><dt>K-apt 코드</dt><dd>${renderIdentifierValues(kaptRefs, '미확인')}</dd></div>
            <div><dt>단지 연결</dt><dd>${
              complex.identityEvidence?.source
                ? `${badge('verified', 'circle-check', '연결 확인')} <span>${esc(labelSource(complex.identityEvidence.source))}</span> <span class="code muted">${esc(complex.identityEvidence.reference)}</span>`
                : emptyCell('미확인')
            }</dd></div>
            <div><dt>세대수</dt><dd>${renderCharacteristicField(complex.characteristics, 'householdCount', (v) => Number(v).toLocaleString('ko-KR') + '세대')}</dd></div>
            <div><dt>사용승인일</dt><dd>${renderCharacteristicField(complex.characteristics, 'approvalDate', (v) => dateText(v), trades.buildYears.map((y) => y + '년'))}</dd></div>
          </dl>
          <p class="sheet-footnote">${
            hasCharConflict
              ? '출처가 서로 다르면 양쪽 값을 그대로 보여줍니다. 대표값을 임의로 고르지 않습니다.'
              : '결과와 저장 수집본에서 확인된 식별 근거만 표시하며, 없는 항목은 추정해 채우지 않습니다.'
          }</p>
        </section>

        <section class="sheet-section" aria-label="거래 목록">
          <div class="sheet-section-head">
            <h3>거래 목록 <span class="num">${allRows.length}건</span></h3>
            <div class="segmented sheet-seg" role="group" aria-label="거래 목록 필터">
              <button type="button" data-trade-filter="all" aria-pressed="${filter === 'all'}">전체 ${allRows.length}</button>
              <button type="button" data-trade-filter="included" aria-pressed="${filter === 'included'}">포함 ${trades.includedRows.length}</button>
              <button type="button" data-trade-filter="excluded" aria-pressed="${filter === 'excluded'}">제외 ${trades.excludedRows.length}</button>
              ${trades.heldRows.length ? `<button type="button" data-trade-filter="held" aria-pressed="${filter === 'held'}">보류 ${trades.heldRows.length}</button>` : ''}
            </div>
          </div>
          ${
            filteredRows.length
              ? `<div class="hc-table-wrap"><table class="hc-table is-dense sheet-trade-table">
                  <caption class="sr-only">${esc(complex.name)} 거래 목록. 금액 단위는 만 원입니다.</caption>
                  <thead><tr>
                    <th scope="col">계약일</th>
                    <th scope="col">종류</th>
                    <th scope="col">면적</th>
                    <th scope="col" class="is-right">층</th>
                    <th scope="col" class="is-right">금액(만 원)</th>
                    <th scope="col">포함 · 제외 사유</th>
                  </tr></thead>
                  <tbody>${filteredRows.map(renderTradeRow).join('')}</tbody>
                </table></div>`
              : `<p class="sheet-empty-list">선택한 구분에 해당하는 거래 관측이 없습니다.</p>`
          }
          <p class="sheet-footnote">같은 날짜·층·금액의 거래도 관측 위치(쪽·행)별로 모두 표시하며 임의로 합치지 않습니다. 신고 지연·정정·해제로 값이 바뀔 수 있습니다.${
            trades.unattributedScopeExclusions > 0
              ? ` 단지가 특정되지 않은 범위 제외 거래 ${trades.unattributedScopeExclusions}건은 비교 대상 판정 패널에서 확인할 수 있습니다.`
              : ''
          }</p>
        </section>

        ${sourceChips.length ? `<div class="sheet-sources" aria-label="자료 출처">${sourceChips.join('')}</div>` : ''}
      </div>
      <footer class="hc-sheet-foot">
        <button type="button" class="action secondary" data-sheet-close>닫기</button>
      </footer>
    </div>`;
  }

  async function open({ comparison, complexId, role = 'comparable', tradeKind = 'sale', evidenceDetail = null, trigger = null, runContext = null }) {
    if (!comparison || !complexId) return;
    const pool = role === 'target' ? comparison.targetReferences : comparison.comparables;
    const complex = (pool ?? []).find((c) => c.complexId === complexId);
    if (!complex) return;
    const token = ++reqToken;
    state = {
      comparison,
      complex,
      role,
      activeKind: tradeKind,
      filter: 'all',
      evidenceDetail,
      loading: !evidenceDetail && Boolean(loadEvidence && runContext),
      error: null,
      trigger,
    };
    renderSheet();
    if (!sheet.open) sheet.showModal();
    sheet.querySelector('[data-sheet-close]')?.focus({ preventScroll: true });
    announce?.(`${complex.name || '단지'} 상세 정보를 열었습니다.`);

    if (!evidenceDetail && loadEvidence && runContext) {
      try {
        const loaded = await loadEvidence(runContext);
        if (token !== reqToken || !state) return;
        state.evidenceDetail = loaded;
        state.loading = false;
        renderSheet();
      } catch (err) {
        if (token !== reqToken || !state) return;
        state.loading = false;
        state.error = err;
        renderSheet();
      }
    }
  }

  sheet.addEventListener('click', (event) => {
    if (sheet.dataset.sheet !== 'complex' || !state) return;
    if (event.target === sheet) {
      const rect = sheet.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        close();
      }
      return;
    }
    const btn = event.target.closest('button');
    if (!btn) return;
    if (btn.hasAttribute('data-sheet-close')) {
      close();
      return;
    }
    if (btn.dataset.complexKind && Object.hasOwn(tradeNames, btn.dataset.complexKind)) {
      state.activeKind = btn.dataset.complexKind;
      renderSheet();
      sheet.querySelector(`[data-complex-kind="${CSS.escape(state.activeKind)}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (btn.dataset.tradeFilter) {
      state.filter = btn.dataset.tradeFilter;
      renderSheet();
      sheet.querySelector(`[data-trade-filter="${CSS.escape(state.filter)}"]`)?.focus({ preventScroll: true });
    }
  });

  sheet.addEventListener('cancel', (event) => {
    if (sheet.dataset.sheet !== 'complex') return;
    event.preventDefault();
    close();
  });

  return {
    open,
    close,
    reset() {
      close({ restoreFocus: false });
    },
    isOpen() {
      return Boolean(state && sheet.open && sheet.dataset.sheet === 'complex');
    },
  };
}
