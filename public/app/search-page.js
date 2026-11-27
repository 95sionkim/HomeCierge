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
  profileLoading: false,
  profileLoaded: false,
  coreApplied: false,
  regionApplied: false,
  profileRevision: null,
  pendingProposalCount: 0,
  profileError: null,
  coreNotices: [],
  regionNotices: [],
  userEdited: false,
});
const reason = (code) => planningReasons[code] || reasonText(code) || '추가 근거가 필요합니다.';
const uniqueReasons = (codes) => [...new Set((codes ?? []).map(reason))].join(' ');
const regionCodePattern = /^[0-9]{5}$/;
const wonPattern = /^(?:0|[1-9]\d{0,19})$/;
const monthPattern = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/;
const exactArea = (value) =>
  typeof value === 'string' &&
  /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) &&
  value.length <= 24 &&
  /[1-9]/.test(value);
function areaValue(value, scale) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(scale, '0'));
}
function formatWonInput(value) {
  if (typeof value !== 'string' || !wonPattern.test(value)) return null;
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
    if (!monthPattern.test(s.start) || !monthPattern.test(s.end) || s.start > s.end)
      throw new Error('입주 시작월과 종료월을 순서대로 입력해 주세요.');
    conditions.moveIn = { start: s.start, end: s.end };
  }
  return conditions;
}

function profileStatusMarkup(s) {
  const parts = [];
  const applied = s.coreApplied || s.regionApplied;
  if (s.profileLoading && !s.loading) {
    parts.push('<p id="search-profile-status" class="field-help" role="status">저장된 공유 프로필을 확인하고 있습니다.</p>');
  } else if (s.profileError) {
    parts.push(
      `<p id="search-profile-status" class="hold-note" role="status">저장된 공유 프로필을 불러오지 못했습니다. (${esc(errorText(s.profileError))}) 조건을 직접 입력해 검색할 수 있습니다.</p>`,
    );
  } else if (s.profileLoaded && (applied || s.pendingProposalCount > 0)) {
    const version = Number.isSafeInteger(s.profileRevision) && s.profileRevision > 0 ? ` v${s.profileRevision}` : '';
    const baseText = applied
      ? s.regionError
        ? `승인된 공유 프로필${version}의 예산·면적·입주 조건을 복원했습니다. 지역 목록이 복구된 뒤 검색할 수 있습니다.`
        : `승인된 공유 프로필${version} 조건을 채웠습니다. 바로 검색하지 않으며 여기서 바꿔 검색할 수 있습니다.`
      : '승인된 공유 프로필 조건은 아직 없습니다.';
    const pendingText =
      s.pendingProposalCount > 0
        ? ` 대기 중인 변경안 ${s.pendingProposalCount}건은 승인 전까지 반영하지 않습니다.`
        : '';
    parts.push(`<p id="search-profile-status" class="field-help" role="status">${esc(baseText + pendingText)}</p>`);
  }
  const notices = [...s.regionNotices, ...s.coreNotices];
  if (s.regionError && !s.regionNotices.length) {
    notices.unshift('지역 목록을 불러올 수 없어 희망 지역을 선택할 수 없습니다. 지역 목록이 복구된 뒤 검색할 수 있습니다.');
  }
  for (const notice of notices) {
    parts.push(`<p class="hold-note" role="status">${esc(notice)}</p>`);
  }
  return parts.join('');
}

function searchForm(s) {
  const name = (code) => s.regions.find((r) => r.code === code)?.name || code;
  const regionDisabled = s.regionError ? ' disabled' : '';
  return `<form class="planning-box criteria" id="criteria-form" novalidate>
    <div class="box-heading">${icon('sliders-horizontal')}<h2>검색 조건</h2></div>
    ${profileStatusMarkup(s)}
    <label for="criteria-region">희망 지역</label>
    <div class="input-action"><input id="criteria-region" name="region" list="criteria-regions" value="${esc(s.region)}" placeholder="${s.regionError ? '지역 목록을 불러올 수 없습니다' : '시·군·구 이름 또는 코드'}" autocomplete="off"${regionDisabled}><button class="action secondary compact" type="button" data-search-add${regionDisabled}>추가</button></div>
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
    pending = 0,
    profileController = null;
  function abortProfile() {
    profileController?.abort();
    profileController = null;
  }
  function reset() {
    ++generation;
    ++pending;
    abortProfile();
    s = blank();
  }
  function markEdited() {
    if (s.userEdited) return;
    s.userEdited = true;
    abortProfile();
    if (s.profileLoading) {
      s.profileLoading = false;
      const status = root.querySelector('#search-profile-status');
      if (status) status.remove();
    }
  }
  function showError(message) {
    s.error = message;
    render();
  }
  function applyProfileCore(profile) {
    const c = profile.conditions;
    const notices = [];
    let appliedAny = false;

    if (Object.hasOwn(c, 'budget_max_won') && c.budget_max_won !== undefined && c.budget_max_won !== null) {
      const formatted = formatWonInput(c.budget_max_won);
      if (formatted !== null) {
        s.budget = formatted;
        appliedAny = true;
      } else {
        notices.push('저장된 구매 예산 형식을 확인할 수 없어 적용하지 않았습니다. 예산을 직접 입력하세요.');
      }
    }

    const hasMin = Object.hasOwn(c, 'supply_area_min_m2') && c.supply_area_min_m2 !== undefined && c.supply_area_min_m2 !== null;
    const hasMax = Object.hasOwn(c, 'supply_area_max_m2') && c.supply_area_max_m2 !== undefined && c.supply_area_max_m2 !== null;
    if (hasMin !== hasMax) {
      const side = hasMin ? '최소 면적' : '최대 면적';
      const val = hasMin ? c.supply_area_min_m2 : c.supply_area_max_m2;
      const valText = exactArea(val) ? `(${val}㎡)` : '';
      notices.push(
        `저장된 공급면적에 ${side}${valText}만 있어 적용하지 않았습니다. 면적 조건을 쓰려면 최소·최대 공급면적을 함께 입력하세요.`,
      );
    } else if (hasMin && hasMax) {
      if (exactArea(c.supply_area_min_m2) && exactArea(c.supply_area_max_m2)) {
        const scale = Math.max(
          (c.supply_area_min_m2.split('.')[1] ?? '').length,
          (c.supply_area_max_m2.split('.')[1] ?? '').length,
        );
        if (areaValue(c.supply_area_min_m2, scale) <= areaValue(c.supply_area_max_m2, scale)) {
          s.unit = 'm2';
          s.min = c.supply_area_min_m2;
          s.max = c.supply_area_max_m2;
          s.extra = true;
          appliedAny = true;
        } else {
          notices.push('저장된 공급면적 범위가 올바르지 않아 적용하지 않았습니다. 최소·최대 공급면적을 다시 확인하세요.');
        }
      } else {
        notices.push('저장된 공급면적 형식을 확인할 수 없어 적용하지 않았습니다. 최소·최대 공급면적을 다시 확인하세요.');
      }
    }

    const hasStart = Object.hasOwn(c, 'move_in_start_month') && c.move_in_start_month !== undefined && c.move_in_start_month !== null;
    const hasEnd = Object.hasOwn(c, 'move_in_end_month') && c.move_in_end_month !== undefined && c.move_in_end_month !== null;
    if (hasStart !== hasEnd) {
      const side = hasStart ? '시작월' : '종료월';
      const val = hasStart ? c.move_in_start_month : c.move_in_end_month;
      const valText = typeof val === 'string' && monthPattern.test(val) ? `(${val})` : '';
      notices.push(
        `저장된 입주 예정월에 ${side}${valText}만 있어 적용하지 않았습니다. 입주 시기를 쓰려면 시작월과 종료월을 함께 입력하세요.`,
      );
    } else if (hasStart && hasEnd) {
      if (
        typeof c.move_in_start_month === 'string' &&
        typeof c.move_in_end_month === 'string' &&
        monthPattern.test(c.move_in_start_month) &&
        monthPattern.test(c.move_in_end_month) &&
        c.move_in_start_month <= c.move_in_end_month
      ) {
        s.start = c.move_in_start_month;
        s.end = c.move_in_end_month;
        s.extra = true;
        appliedAny = true;
      } else {
        notices.push('저장된 입주 예정월 범위가 올바르지 않아 적용하지 않았습니다. 시작월과 종료월을 다시 확인하세요.');
      }
    }

    s.coreApplied = appliedAny;
    s.profileRevision = profile.revision;
    s.pendingProposalCount = profile.proposals.filter((p) => p?.status === 'pending').length;
    s.coreNotices = notices;
    s.profileLoaded = true;
    s.profileError = null;
  }
  function applyProfileRegions(profile) {
    const c = profile.conditions;
    const notices = [];
    let applied = false;

    if (s.regionError) {
      if (Array.isArray(c.region_codes) && c.region_codes.length) {
        const saved = [...new Set(c.region_codes.filter((item) => typeof item === 'string' && item.trim()))];
        const shown = saved.length > 5 ? `${saved.slice(0, 5).join(', ')} 외 ${saved.length - 5}건` : saved.join(', ');
        notices.push(
          shown
            ? `지역 목록을 불러올 수 없어 저장된 희망 지역(${shown})을 확인·적용하지 못했습니다. 지역 목록이 복구된 뒤 검색할 수 있습니다.`
            : '지역 목록을 불러올 수 없어 희망 지역을 선택할 수 없습니다. 지역 목록이 복구된 뒤 검색할 수 있습니다.',
        );
      } else {
        notices.push('지역 목록을 불러올 수 없어 희망 지역을 선택할 수 없습니다. 지역 목록이 복구된 뒤 검색할 수 있습니다.');
      }
      s.regionApplied = false;
      s.regionNotices = notices;
      return;
    }

    const validRegionSet = new Set(s.regions.map((r) => r.code));
    if (Object.hasOwn(c, 'region_codes') && c.region_codes !== undefined && c.region_codes !== null) {
      if (!Array.isArray(c.region_codes)) {
        notices.push('저장된 희망 지역 형식을 확인할 수 없어 적용하지 않았습니다. 희망 지역을 직접 선택하세요.');
      } else if (!c.region_codes.length) {
        notices.push('저장된 희망 지역이 비어 있어 적용하지 않았습니다. 희망 지역을 선택하세요.');
      } else {
        const validCodes = [];
        const seenValid = new Set();
        const staleOrInvalid = [];
        const seenInvalid = new Set();
        let overflowed = false;
        for (const item of c.region_codes) {
          if (typeof item === 'string' && regionCodePattern.test(item) && validRegionSet.has(item)) {
            if (!seenValid.has(item)) {
              if (validCodes.length < 50) {
                seenValid.add(item);
                validCodes.push(item);
              } else {
                overflowed = true;
              }
            }
          } else {
            const label = typeof item === 'string' && item.trim() ? item.trim() : '형식 오류';
            if (!seenInvalid.has(label)) {
              seenInvalid.add(label);
              staleOrInvalid.push(label);
            }
          }
        }
        if (validCodes.length) {
          s.codes = validCodes;
          applied = true;
        }
        if (staleOrInvalid.length) {
          const shown =
            staleOrInvalid.length > 5
              ? `${staleOrInvalid.slice(0, 5).join(', ')} 외 ${staleOrInvalid.length - 5}건`
              : staleOrInvalid.join(', ');
          notices.push(
            validCodes.length
              ? `저장된 희망 지역 중 현재 공고 검색 목록에서 확인할 수 없는 코드(${shown})는 제외했습니다. 검색할 지역을 확인하세요.`
              : `저장된 희망 지역 코드(${shown})를 현재 공고 검색 목록에서 확인할 수 없어 적용하지 않았습니다. 희망 지역을 다시 선택하세요.`,
          );
        }
        if (overflowed) {
          notices.push('저장된 희망 지역이 50개를 넘어 앞의 50개만 적용했습니다.');
        }
      }
    }

    s.regionApplied = applied;
    s.regionNotices = notices;
  }
  async function enter() {
    reset();
    const token = generation,
      owner = user()?.id;
    if (!owner) {
      try {
        const data = await import('/vendor/planning-example.js');
        if (token !== generation || owner !== user()?.id) return;
        if (!Array.isArray(data.regions)) throw new Error('invalid regions');
        s.regions = data.regions;
        s.codes = [data.regions[0].code];
        s.budget = '710,000,000';
        s.result = data.searchExample(readConditions(s));
      } catch (e) {
        if (token === generation) s.regionError = e;
      }
      if (token === generation) {
        s.loading = false;
        render();
      }
      return;
    }

    let regionsSettled = false;
    let profileData = null;
    const isAlive = () => token === generation && owner === user()?.id;

    // 지역 목록과 공유 프로필을 독립적으로 불러와 지역 장애 시에도 예산·면적·입주 조건을 복원한다.
    const controller = new AbortController();
    profileController = controller;
    s.profileLoading = true;
    void (async () => {
      try {
        const data = await api.readSharedProfile(controller.signal);
        if (!isAlive() || profileController !== controller || controller.signal.aborted) return;
        profileData = data;
        s.profileLoading = false;
        if (s.userEdited) {
          const status = root.querySelector('#search-profile-status');
          if (status) status.remove();
          return;
        }
        applyProfileCore(profileData);
        if (regionsSettled) applyProfileRegions(profileData);
        render();
      } catch (e) {
        if (!isAlive() || profileController !== controller || controller.signal.aborted || e?.name === 'AbortError')
          return;
        s.profileLoading = false;
        if (!s.userEdited) {
          s.profileError = e;
          if (regionsSettled) render();
        }
      } finally {
        if (profileController === controller) profileController = null;
      }
    })();

    try {
      const data = await api.listSearchRegions();
      if (!isAlive()) return;
      if (
        !Array.isArray(data.regions) ||
        data.dataOrigin !== 'collected' ||
        data.contractVersion !== 'notice-regions/v1'
      )
        throw new Error('invalid regions');
      s.regions = data.regions;
      s.loading = false;
      regionsSettled = true;
      if (profileData && !s.userEdited) applyProfileRegions(profileData);
      render();
    } catch (e) {
      if (!isAlive()) return;
      s.regionError = e;
      s.loading = false;
      regionsSettled = true;
      if (profileData && !s.userEdited) applyProfileRegions(profileData);
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
  const syncField = (e) => {
    const field = e.target;
    if (field.form?.id === 'criteria-form' && Object.hasOwn(s, field.name)) {
      markEdited();
      s[field.name] = field.type === 'checkbox' ? field.checked : field.value;
    }
  };
  root.addEventListener('input', syncField);
  root.addEventListener('change', syncField);
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
      if (s.regionError) return;
      markEdited();
      if (addRegion()) render();
      return;
    }
    if (b.dataset.searchRemove) {
      markEdited();
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
    markEdited();
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
