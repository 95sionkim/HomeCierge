import * as api from './client.js';
import { esc, icon, kinds, won, reasonText, dateText, scheduleBadge, errorText } from './display.js';
import { amountInput, evidence, sourceNames, collectionLabels, planningReasons } from './planning-fields.js';

const blank = () => ({
  regions: [],
  codes: [],
  region: '',
  budget: '',
  min: '',
  max: '',
  unit: 'm2',
  start: '',
  end: '',
  closed: false,
  extra: false,
  loading: true,
  busy: false,
  regionError: null,
  error: '',
  result: null,
});
const reason = (code) => planningReasons[code] || reasonText(code) || '추가 근거가 필요합니다.';
const uniqueReasons = (codes) => [...new Set((codes ?? []).map(reason))].join(' ');
const exactArea = (value) =>
  /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && value.length <= 24 && /[1-9]/.test(value);
function areaValue(value, scale) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(scale, '0'));
}
function readConditions(s) {
  if (!s.codes.length) throw new Error('검색할 지역을 하나 이상 추가해 주세요.');
  const budgetMaxWon = amountInput(s.budget);
  if (budgetMaxWon === null) throw new Error('예산을 원 단위의 정수로 입력해 주세요.');
  const conditions = { regionCodes: s.codes.slice(), budgetMaxWon, includeClosed: s.closed };
  if (s.min || s.max) {
    if (!exactArea(s.min) || !exactArea(s.max))
      throw new Error('최소·최대 공급면적을 양수로 모두 입력해 주세요.');
    const scale = Math.max((s.min.split('.')[1] ?? '').length, (s.max.split('.')[1] ?? '').length);
    if (areaValue(s.min, scale) > areaValue(s.max, scale))
      throw new Error('최대 공급면적은 최소 면적 이상이어야 합니다.');
    conditions.supplyArea = { min: s.min, max: s.max, unit: s.unit };
  }
  if (s.start || s.end) {
    const month = /^\d{4}-(?:0[1-9]|1[0-2])$/;
    if (!month.test(s.start) || !month.test(s.end) || s.start > s.end)
      throw new Error('입주 시작월과 종료월을 순서대로 입력해 주세요.');
    conditions.moveIn = { start: s.start, end: s.end };
  }
  return conditions;
}

function searchForm(s) {
  const name = (code) => s.regions.find((r) => r.code === code)?.name || code;
  return `<form class="planning-box criteria" id="criteria-form" novalidate>
    <div class="box-heading">${icon('sliders-horizontal')}<h2>검색 조건</h2></div>
    <label for="criteria-region">희망 지역</label>
    <div class="input-action"><input id="criteria-region" name="region" list="criteria-regions" value="${esc(s.region)}" placeholder="시·군·구 이름 또는 코드" autocomplete="off"><button class="action secondary compact" type="button" data-search-add>추가</button></div>
    <datalist id="criteria-regions">${s.regions
      .filter((r) => !s.codes.includes(r.code))
      .map((r) => `<option value="${esc(r.name || r.code)}">${esc(r.code)}</option>`)
      .join('')}</datalist>
    <div class="region-chips">${s.codes.map((c) => `<button type="button" data-search-remove="${esc(c)}" aria-label="${esc(name(c))} 제외">${esc(name(c))} ${icon('x')}</button>`).join('')}</div>
    <label for="criteria-budget">최대 예산</label>
    <div class="unit-input"><input id="criteria-budget" name="budget" inputmode="numeric" autocomplete="off" placeholder="예: 700,000,000" value="${esc(s.budget)}"><span>원</span></div>
    <p class="field-help">분양가와 필수 옵션을 합한 호실 소계에 적용합니다.</p>
    <details class="criteria-extra" ${s.extra ? 'open' : ''}><summary>면적·입주 시기 ${icon('chevron-down')}</summary>
      <fieldset><legend>공급면적</legend><label class="sr-only" for="criteria-unit">면적 단위</label><select id="criteria-unit" name="unit"><option value="m2">㎡</option><option value="pyeong" ${s.unit === 'pyeong' ? 'selected' : ''}>평</option></select><div class="paired"><label>최소<input name="min" id="criteria-min" inputmode="decimal" value="${esc(s.min)}"></label><label>최대<input id="criteria-max" name="max" inputmode="decimal" value="${esc(s.max)}"></label></div></fieldset>
      <fieldset><legend>입주 예정월</legend><div class="paired months"><label>시작월<input type="month" name="start" id="criteria-start" value="${esc(s.start)}"></label><label>종료월<input type="month" name="end" id="criteria-end" value="${esc(s.end)}"></label></div></fieldset>
    </details>
    <label class="checkline"><input type="checkbox" name="closed" id="criteria-closed" ${s.closed ? 'checked' : ''}>접수 종료 공고 포함</label>
    ${s.error ? `<p class="plan-error" role="alert">${esc(s.error)}</p>` : ''}
    <button type="submit" class="action primary wide" ${s.busy || s.loading || s.regionError ? 'disabled' : ''}>${icon('search')}${s.busy ? '검색 중' : '이 조건으로 검색'}</button></form>`;
}

function noticeCard(n, group, index, regions) {
  const region = regions.find((r) => r.code === n.regionCode)?.name ?? n.regionCode;
  const roomRow = (room, reviewed) =>
    `<div class="search-room"><div><strong>${esc(room.room)}</strong><small>${reviewed ? esc(uniqueReasons(room.reasonCodes) || '추가 근거 확인 필요') : '예산 충족'}</small></div><div><strong class="money">${room.subtotalWon == null ? '가격 미확인' : esc(won(room.subtotalWon))}</strong>${evidence(room.priceEvidence, '호실 가격 근거')}</div></div>`;
  const modelCard = (
    m,
    i,
  ) => `<div class="search-model"><div class="model-heading"><span><strong>${esc(m.houseType || '주택형 미확인')}</strong> · 모델 ${esc(m.modelNo)}</span>
    ${m.houseType ? `<button class="text-action" type="button" data-search-select="${group}/${index}/${i}">주택형 선택 ${icon('chevron-right')}</button>` : ''}</div>
    <div class="model-area">공급면적 ${m.supplyAreaM2 == null ? '미확인' : esc(m.supplyAreaM2) + '㎡'}${evidence(m.areaEvidence, '공급면적 근거')}</div>
    ${m.matchedRooms.map((r) => roomRow(r, false)).join('')}${m.needsReviewRooms.map((r) => roomRow(r, true)).join('')}
    ${!m.matchedRooms.length && !m.needsReviewRooms.length ? '<p class="field-help">확인된 호실 자료가 없습니다.</p>' : ''}</div>`;
  const omitted = Object.values(n.truncation ?? {}).reduce((total, value) => total + value, 0);
  const roomReasons = new Set(n.models.flatMap(m => m.needsReviewRooms.flatMap(r => r.reasonCodes)));
  const noticeReasons = n.reasonCodes.filter(code => !roomReasons.has(code));
  return `<article class="planning-box search-card"><div class="search-card-meta">${scheduleBadge(n.applicationStatus)} <span>${esc(region || '지역 확인 필요')} · ${esc(kinds[n.kind] || kinds.unknown)}</span></div><h3>${esc(n.title || '공고명 확인 필요')}</h3>
    <p class="search-card-id">공고 ${esc(n.noticeNo)} · ${esc(n.edition)}</p>
    ${n.models.map(modelCard).join('')}${noticeReasons.length ? `<p class="field-help">${esc(uniqueReasons(noticeReasons))}</p>` : ''}
    ${omitted ? `<p class="field-help">상세 ${esc(omitted)}건이 더 있습니다.</p>` : ''}</article>`;
}
function resultPanel(s) {
  const r = s.result;
  if (s.regionError)
    return `<div class="planning-box plan-empty">${icon('triangle-alert')}<h2>지역 목록을 불러올 수 없습니다</h2><p>${esc(errorText(s.regionError))}</p><button class="action secondary" data-search-retry>다시 조회</button></div>`;
  if (!r)
    return `<div class="planning-box plan-empty">${icon(s.loading || s.busy ? 'loader-circle' : 'search')}<h2>${s.loading ? '지역을 불러오는 중입니다' : s.busy ? '조건을 대조하고 있습니다' : '어떤 공고를 찾고 계신가요?'}</h2><p>희망 지역과 예산을 선택하면 호실별로 확인된 금액을 대조합니다.</p></div>`;
  const c = r.appliedConditions,
    parts = [
      c.regionCodes.map((code) => s.regions.find((row) => row.code === code)?.name || code).join(' · '),
      '최대 ' + won(c.budgetMaxWon),
    ];
  if (c.supplyArea)
    parts.push(c.supplyArea.min + '–' + c.supplyArea.max + (c.supplyArea.unit === 'm2' ? '㎡' : '평'));
  if (c.moveIn) parts.push('입주 ' + c.moveIn.start + '–' + c.moveIn.end);
  if (c.includeClosed) parts.push('접수 종료 포함');
  const group = (
    key,
    label,
    count,
  ) => `<section aria-label="${label}" class="search-group"><div class="group-heading"><h2>${label}</h2><span class="count-pill">${esc(count)}</span></div>
    ${r[key].map((n, i) => noticeCard(n, key, i, s.regions)).join('') || `<p class="group-empty">${key === 'matched' && r.zeroStatus === 'indeterminate' ? '현재 자료로 조건을 충족한다고 확정한 공고가 없습니다.' : label + ' 공고가 없습니다.'}</p>`}</section>`;
  return `<div class="search-results"><div class="planning-box search-summary"><div class="summary-caption">적용한 조건</div><h2>${esc(parts.join(' · '))}</h2><p>기준일 ${esc(dateText(r.asOf))} · 모집공고일 ${esc(dateText(r.publicationWindow.start))} – ${esc(dateText(r.publicationWindow.end))}</p>
    <div class="source-line">${r.coverage.sources.map((x) => `<span>${esc(sourceNames[x.source] || x.source)} · ${esc(collectionLabels[x.status] || '확인 필요')}</span>`).join('')}</div>
    ${r.scopeIssues.length ? `<p class="hold-note">${esc(uniqueReasons(r.scopeIssues))}</p>` : ''}
    ${r.zeroStatus === 'confirmed_zero' ? '<p class="zero-note">수집 범위에서 조건을 충족한 공고는 0건입니다.</p>' : ''}
    </div>${group('matched', '조건 충족', r.counts.matched)}${group('needsReview', '확인 필요', r.counts.needsReview)}
    ${r.truncation.truncated ? `<p class="field-help">표시 한도로 충족 ${r.truncation.matchedOmitted}건과 확인 필요 ${r.truncation.needsReviewOmitted}건이 생략됐습니다.</p>` : ''}</div>`;
}

export function createSearchPage({ root, render, user, selectNotice }) {
  let s = blank(),
    generation = 0,
    pending = 0;
  function reset() {
    ++generation;
    ++pending;
    s = blank();
  }
  function showError(message) {
    s.error = message;
    render();
  }
  async function enter() {
    reset();
    const token = generation,
      owner = user()?.id;
    try {
      const data = owner ? await api.listSearchRegions() : await import('/vendor/planning-example.js');
      if (token !== generation || owner !== user()?.id) return;
      if (
        !Array.isArray(data.regions) ||
        (owner && (data.dataOrigin !== 'collected' || data.contractVersion !== 'notice-regions/v1'))
      )
        throw new Error('invalid regions');
      s.regions = data.regions;
      if (!owner) {
        s.codes = [data.regions[0].code];
        s.budget = '710,000,000';
        s.result = data.searchExample(readConditions(s));
      }
    } catch (e) {
      if (token === generation) s.regionError = e;
    }
    if (token === generation) {
      s.loading = false;
      render();
    }
  }
  function addRegion() {
    const term = s.region.trim();
    const found = s.regions.filter(
      (r) => r.code === term || r.name === term || (term && r.name?.split(' ').at(-1) === term),
    );
    if (found.length !== 1) {
      showError('목록에서 시·군·구 전체 이름이나 공식 코드 하나를 선택해 주세요.');
      return false;
    }
    if (!s.codes.includes(found[0].code)) {
      if (s.codes.length >= 50) {
        showError('지역은 50개까지 선택할 수 있습니다.');
        return false;
      }
      s.codes.push(found[0].code);
    }
    s.region = '';
    s.error = '';
    return true;
  }
  root.addEventListener('input', (e) => {
    const field = e.target;
    if (field.form?.id === 'criteria-form' && Object.hasOwn(s, field.name))
      s[field.name] = field.type === 'checkbox' ? field.checked : field.value;
  });
  root.addEventListener(
    'toggle',
    (e) => {
      if (e.target.matches?.('.criteria-extra')) s.extra = e.target.open;
    },
    true,
  );
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-search-retry')) {
      void enter();
      return;
    }
    if (b.hasAttribute('data-search-add')) {
      if (addRegion()) render();
      return;
    }
    if (b.dataset.searchRemove) {
      s.codes = s.codes.filter((c) => c !== b.dataset.searchRemove);
      render();
      return;
    }
    if (b.dataset.searchSelect) {
      const [group, i, j] = b.dataset.searchSelect.split('/'),
        n = s.result?.[group]?.[i],
        m = n?.models?.[j];
      if (!m) return;
      const token = generation;
      b.disabled = true;
      try {
        await selectNotice(n, m);
      } catch (err) {
        if (token === generation) showError(errorText(err));
      } finally {
        if (b.isConnected) b.disabled = false;
      }
    }
  });
  root.addEventListener('submit', async (e) => {
    if (e.target.id !== 'criteria-form') return;
    e.preventDefault();
    if (s.loading || s.regionError || s.busy) return;
    if (s.region.trim() && !addRegion()) return;
    let conditions;
    try {
      conditions = readConditions(s);
    } catch (err) {
      showError(err.message);
      return;
    }
    const owner = user()?.id,
      token = ++pending;
    s.busy = true;
    s.result = null;
    s.error = '';
    render();
    try {
      const result = owner
        ? await api.searchNotices(conditions)
        : (await import('/vendor/planning-example.js')).searchExample(conditions);
      if (token !== pending || owner !== user()?.id) return;
      if (
        result?.contractVersion !== 'notice-search/v1' ||
        result.dataOrigin !== (owner ? 'collected' : 'synthetic')
      )
        throw new Error('invalid search result');
      s.result = result;
    } catch (err) {
      if (token === pending) s.error = errorText(err);
    } finally {
      if (token === pending) {
        s.busy = false;
        render();
      }
    }
  });
  return {
    reset,
    enter,
    view: () => `<section class="section-header"><h1>맞춤 공고 찾기</h1><p>희망 지역과 예산으로 청약할 호실을 찾아보세요.${user() ? '' : ' 합성 예시로 조건을 바꿔 볼 수 있습니다.'}</p></section>
    <div class="planning-layout">${searchForm(s)}${resultPanel(s)}</div>`,
  };
}
