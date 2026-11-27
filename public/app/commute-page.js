import { commuteProfile, confirmDestination, queryCommute, readCommuteOrigin } from './client.js';
import { esc, icon, errorText } from './display.js';

const messages = {
  synthetic_input: '실제 공고를 선택한 뒤 경로를 조회할 수 있습니다.',
  selection_unverified: '선택한 공고와 수집본의 회차를 확인해야 합니다.',
  origin_unverified: '출발지를 하나의 지점으로 확인하지 못했습니다. 단지 주소의 도로명과 건물번호 또는 지번을 확인하세요.',
  destination_unverified: '목적지를 한 지점으로 찾지 못했습니다. 도로명과 건물번호 또는 지번을 확인하세요.',
  source_restricted: '이 자료를 경로 조회에 사용할 수 있는지 확인 중입니다.',
  not_configured: '제공자 연결을 준비 중입니다.',
  geocoder_unavailable: '주소 검색이 응답하지 않았습니다. 잠시 후 다시 조회하세요.',
  geocoder_denied: '주소 검색 제공자가 이 환경의 요청을 승인하지 않았습니다.',
  geocoder_rate_limited: '주소 검색 한도에 도달했습니다. 잠시 후 다시 조회하세요.',
  not_queried: '조회를 진행하지 않았습니다.',
  provider_unavailable: '제공자의 경로 응답을 확인하지 못했습니다. 잠시 후 다시 조회하세요.',
  provider_denied: '제공자가 이 환경의 요청을 승인하지 않았습니다.',
  rate_limited: '제공자의 조회 한도에 도달했습니다.',
  no_route: '제공자가 이 조건에서 찾은 경로가 없습니다.',
  points_too_close: '출발지와 목적지가 너무 가까워 이 수단의 경로를 조회할 수 없습니다.',
  connections_unverified: '도시간 경로의 터미널 연결 구간이 확인되지 않아 전체 소요시간을 표시할 수 없습니다.',
};
const originReasons = {
  ambiguous_area: '공고 공급위치에 ‘일원’·‘블록’·‘외 필지’처럼 여러 지점을 가리키는 표기가 있어 출발지를 자동으로 정하지 않았습니다.',
  unnumbered: '공고 공급위치에 건물번호나 지번이 없어 출발지를 자동으로 정하지 않았습니다.',
  multiple_points: '공고 공급위치에 둘 이상의 주소 후보가 있어 출발지를 자동으로 정하지 않았습니다.',
  notice_address_unverified: '공고의 공급위치 주소가 확인되지 않아 출발지를 자동으로 정하지 않았습니다.',
};
const submitOriginReasons = {
  ambiguous_area: '‘일원’·‘블록’·‘외 필지’ 표기는 단일 지점이 아닙니다. 단지 주소의 도로명과 건물번호 또는 지번을 입력하세요.',
  unnumbered: '출발지에 건물번호나 지번이 없습니다. 도로명과 건물번호 또는 지번을 입력하세요.',
  multiple_points: '출발지에 둘 이상의 주소가 포함되어 있습니다. 단지 주소 하나만 입력하세요.',
  notice_address_unverified: '공고의 공급위치 주소를 확인하지 못했습니다. 단지 주소를 직접 입력하세요.',
};
const stamp = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const providers = {
  transit: ['대중교통', 'powered by www.ODsay.com', 'https://lab.odsay.com/'],
  driving: ['자동차', '카카오모빌리티', 'https://developers.kakaomobility.com/product/naviapi.html'],
};
const kinds = { subway: '지하철', bus: '버스', mixed: '버스·지하철', car: '승용차' };

function demoOrigin() {
  return {
    noticeAddress: '합성시 가람구 가람로 10 (가람동, 합성 가람아파트)',
    address: '합성시 가람구 가람로 10',
    basis: 'notice_address',
    reason: null,
    suggestion: null,
  };
}
function demoPreview() {
  return {
    contractVersion: 'commute/v1',
    status: 'ready',
    origin: demoOrigin(),
  };
}
function demoResult() {
  const time = '2026-10-27T00:00:00Z';
  const origin = demoOrigin();
  return {
    status: 'ready',
    originAddress: origin.address,
    origin,
    transit: {
      source: 'odsay_route',
      status: 'available',
      queriedAt: time,
      kind: 'mixed',
      durationSeconds: 2280,
      walkMinutes: null,
      walkMeters: 480,
      distanceMeters: null,
    },
    driving: {
      source: 'kakao_directions',
      status: 'available',
      queriedAt: time,
      kind: 'car',
      durationSeconds: 1440,
      distanceMeters: 9700,
      walkMinutes: null,
      walkMeters: null,
    },
  };
}
function validOrigin(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (o.noticeAddress !== null && typeof o.noticeAddress !== 'string') return false;
  if (o.address !== null && typeof o.address !== 'string') return false;
  if (o.basis !== null && !['notice_address', 'user_input'].includes(o.basis)) return false;
  if (o.reason !== null && !Object.hasOwn(originReasons, o.reason)) return false;
  if (o.suggestion !== null && typeof o.suggestion !== 'string') return false;
  return true;
}
function validRoute(r, mode) {
  if (!r || r.source !== (mode === 'transit' ? 'odsay_route' : 'kakao_directions') ||
      (r.queriedAt !== null && (!r.queriedAt || !Number.isFinite(Date.parse(r.queriedAt))))) return false;
  if (r.status !== 'available') {
    return Object.hasOwn(messages, r.status) &&
      [r.durationSeconds, r.walkMinutes, r.walkMeters, r.distanceMeters, r.kind].every(value => value === null);
  }
  return !!r.queriedAt && Number.isSafeInteger(r.durationSeconds) && r.durationSeconds > 0 &&
    (mode === 'driving'
      ? r.kind === 'car' && Number.isSafeInteger(r.distanceMeters) && r.distanceMeters > 0
      : ['subway', 'bus', 'mixed'].includes(r.kind) && [r.walkMinutes, r.walkMeters].every(v => v === null || (Number.isSafeInteger(v) && v >= 0)));
}
function isRoadSuggestion(text) {
  return /(?:대로|로|길)\s+[1-9][0-9]*(?:-[0-9]+)?$/u.test(String(text ?? '').trim());
}
function resultHoldMessage(data) {
  if (data.status === 'origin_unverified' && data.origin?.reason && Object.hasOwn(submitOriginReasons, data.origin.reason)) {
    return submitOriginReasons[data.origin.reason];
  }
  return messages[data.status];
}
function routeCard(mode, r, demo) {
  const [name, source, url] = providers[mode];
  const value = r.status === 'available';
  const duration = r.durationSeconds < 60 ? r.durationSeconds : Math.ceil(r.durationSeconds / 60);
  const detail = mode === 'transit'
    ? `<div><dt>이용 수단</dt><dd>${kinds[r.kind]}</dd></div><div><dt>연결 도보</dt><dd>${r.walkMinutes === null ? '시간 미제공' : r.walkMinutes + '분'}${r.walkMeters === null ? '' : ' · ' + r.walkMeters.toLocaleString('ko-KR') + ' m'}</dd></div>`
    : `<div><dt>경로 조건</dt><dd>현재 출발 · 추천 경로</dd></div><div><dt>도로 거리</dt><dd>${value ? r.distanceMeters.toLocaleString('ko-KR') : ''} m</dd></div>`;
  return `<article class="panel commute-mode"><header><h3>${name}</h3><span class="ref-meta">${demo ? '합성 예시' : `<a class="ref-link" href="${url}" target="_blank" rel="noopener noreferrer">${source} ${icon('external-link')}</a>`}</span></header>
    ${value ? `<p class="commute-time"><b>${duration}</b> ${r.durationSeconds < 60 ? '초' : '분'}</p>
      <dl class="commute-facts">${detail}</dl>` : `<p class="commute-hold">${icon('circle-pause')}${esc(messages[r.status])}</p>`}
    <footer>${mode === 'transit' ? '도시내 추천 경로 · 출발 시각 미지정' : '승용차 · 조회 시점 교통 기준'}
    ${r.queriedAt ? `<br>조회 <time datetime="${esc(r.queriedAt)}">${esc(stamp.format(new Date(r.queriedAt)))} KST</time>` : ''}</footer></article>`;
}

export function createCommutePage({ root, render }) {
  let ctx, previewRequest, preview, previewError, originEditing, originDraft, originEdited;
  let profileRequest, routeRequest, profile, profileError, saving, change, draft, result, error, message, edited;

  function reset() {
    previewRequest?.abort();
    profileRequest?.abort();
    routeRequest?.abort();
    ctx = previewRequest = preview = previewError = profileRequest = routeRequest = profile = profileError = change = result = error = null;
    originEditing = originEdited = saving = edited = false;
    originDraft = draft = message = '';
  }

  async function loadOrigin() {
    const here = ctx;
    const c = new AbortController();
    previewRequest = c;
    previewError = null;
    try {
      const data = await readCommuteOrigin(here.analysisId, here.snapshotId, c.signal);
      if (ctx !== here || previewRequest !== c) return;
      if (data.contractVersion !== 'commute/v1' || data.analysisId !== here.analysisId ||
          data.snapshotId !== here.snapshotId ||
          (data.status !== 'ready' && !Object.hasOwn(messages, data.status)) ||
          !validOrigin(data.origin)) {
        throw new Error('invalid commute preview');
      }
      preview = data;
      previewError = null;
      if (!originEdited) {
        originDraft = data.origin.address === null ? (data.origin.suggestion ?? '') : '';
      }
    } catch (e) {
      if (ctx === here && previewRequest === c) previewError = e;
    } finally {
      if (ctx === here && previewRequest === c) {
        previewRequest = null;
        render();
      }
    }
  }

  async function loadProfile() {
    const here = ctx;
    const c = new AbortController();
    profileRequest = c;
    try {
      const current = await commuteProfile(here.ownerId, c.signal);
      if (ctx !== here) return;
      profile = current;
      profileError = null;
      if (!edited) draft = current.commute_destination ?? '';
    } catch (e) {
      if (ctx === here) profileError = e;
    } finally {
      if (ctx === here) {
        profileRequest = null;
        render();
      }
    }
  }

  function enter(context) {
    reset();
    ctx = context;
    if (ctx.guest) {
      draft = '합성시 가람구 시청대로 110';
      preview = demoPreview();
    } else {
      void loadOrigin();
      void loadProfile();
    }
  }

  function isManualOrigin() {
    return Boolean(ctx && !ctx.guest && preview?.status === 'ready' && (preview.origin.address === null || originEditing));
  }

  async function query() {
    if (!ctx || !preview || preview.status !== 'ready' || routeRequest || saving || change || document.hidden) return;
    const destination = draft.trim();
    const manual = isManualOrigin();
    const originInput = manual ? originDraft.trim() : null;
    if (!destination || (manual ? !originInput : !preview.origin.address)) return;
    const here = ctx;
    const c = new AbortController();
    routeRequest = c;
    result = error = null;
    message = '';
    render();
    try {
      const data = here.guest
        ? demoResult()
        : await queryCommute(here.analysisId, here.snapshotId, destination, c.signal, originInput);
      if (routeRequest !== c) return;
      if (!here.guest && (data.contractVersion !== 'commute/v1' || data.analysisId !== here.analysisId ||
          data.snapshotId !== here.snapshotId || (data.status !== 'ready' && !Object.hasOwn(messages, data.status)) ||
          (data.originAddress !== null && typeof data.originAddress !== 'string') ||
          !validOrigin(data.origin) ||
          !validRoute(data.transit, 'transit') || !validRoute(data.driving, 'driving'))) {
        throw new Error('invalid commute response');
      }
      result = data;
    } catch (e) {
      if (routeRequest === c) error = e;
    } finally {
      if (routeRequest === c) {
        routeRequest = null;
        render();
      }
    }
  }

  async function save() {
    if (!ctx || !change || saving || ctx.guest) return;
    const here = ctx;
    const pending = change;
    saving = true;
    message = '';
    render();
    try {
      await confirmDestination(here.ownerId, pending.revision, pending.value);
      if (ctx !== here) return;
      message = pending.value ? '공유 목적지를 저장했습니다.' : '공유 목적지를 해제했습니다.';
      change = null;
    } catch (e) {
      if (ctx === here) {
        message = errorText(e);
        change = null;
      }
    } finally {
      if (ctx === here) {
        profile = null;
        await loadProfile();
        if (ctx === here) {
          saving = false;
          render();
        }
      }
    }
  }

  function renderOriginPoint(demo) {
    if (!demo && !preview) {
      return `<div class="commute-point"><span aria-hidden="true" class="route-dot"></span><div><span class="commute-label">출발지</span><p class="commute-origin-loading">${icon('loader-circle')}공고 공급위치를 확인하고 있습니다.</p></div></div>`;
    }
    const origin = preview.origin;
    const manual = isManualOrigin();
    if (!manual) {
      const showRaw = origin.noticeAddress && origin.noticeAddress !== origin.address;
      return `<div class="commute-point"><span aria-hidden="true" class="route-dot"></span><div>
        <span class="commute-label">출발지</span>
        <strong>${esc(origin.address)}</strong>
        <small>${demo ? '합성 공고 공급위치 기준' : '청약홈 공고 공급위치 기준'}</small>
        ${showRaw ? `<small class="commute-notice-raw">공고 공급위치 원문: ${esc(origin.noticeAddress)}</small>` : ''}
        ${!demo ? `<button class="text-action commute-inline-action" type="button" data-commute="edit-origin" ${routeRequest || saving || change ? 'disabled' : ''}>출발지 직접 입력</button>` : ''}
      </div></div>`;
    }
    const suggestionNote = origin.address === null && origin.suggestion
      ? (isRoadSuggestion(origin.suggestion)
        ? '공고 공급위치의 대표 도로명주소입니다. 단지 주소가 맞는지 확인하세요.'
        : '공고 공급위치의 대표 지번입니다. 단지 주소가 맞는지 확인하세요.')
      : null;
    return `<div class="commute-point"><span aria-hidden="true" class="route-dot"></span><div>
      <label for="commute-origin">출발지 단지 주소</label>
      ${origin.noticeAddress ? `<p class="commute-notice-raw"><span class="commute-raw-label">공고 공급위치</span> ${esc(origin.noticeAddress)}</p>` : ''}
      ${origin.address === null && origin.reason ? `<p class="commute-origin-reason">${icon('circle-help')}<span>${esc(originReasons[origin.reason])}</span></p>` : ''}
      <input id="commute-origin" name="origin" autocomplete="off" maxlength="200" placeholder="단지 주소(도로명과 건물번호 또는 지번)" required value="${esc(originDraft)}" ${saving || change ? 'readonly' : ''}>
      ${suggestionNote ? `<small class="commute-suggestion-note">${esc(suggestionNote)}</small>` : ''}
      <small>상세 동·호수는 생략하세요. 입력한 출발지 주소는 프로필이나 DB에 저장하지 않고 이번 조회에만 사용합니다.</small>
      ${origin.address !== null ? `<button class="text-action commute-inline-action" type="button" data-commute="use-auto-origin" ${routeRequest || saving || change ? 'disabled' : ''}>공고 자동 출발지 사용</button>` : ''}
    </div></div>`;
  }

  function view() {
    if (!ctx) return '';
    const demo = ctx.guest;
    const heading = `<section class="section-header ref-heading"><div><h1>출퇴근 경로</h1><p>${esc(ctx.name || '선택한 공고')}${demo ? ' · 합성 예시' : ''}</p></div></section>`;
    if (demo && !ctx.saved) {
      return heading + '<p class="ref-state" role="status">공고의 출발지 주소가 확인되면 경로를 조회할 수 있습니다.</p>';
    }
    if (!demo && previewError && !preview) {
      return heading + `<section class="panel ref-held"><p class="ref-state" role="status">${icon('triangle-alert')}${esc(errorText(previewError))}</p><button class="action secondary compact" type="button" data-commute="reload-origin">출발지 다시 확인</button></section>`;
    }
    if (!demo && preview && preview.status !== 'ready') {
      return heading + `<p class="ref-state" role="status">${icon('circle-pause')}${esc(messages[preview.status])}</p>`;
    }
    const saved = profile?.commute_destination;
    const manual = isManualOrigin();
    const hasOrigin = Boolean(preview?.status === 'ready' && (manual ? originDraft.trim() : preview.origin.address));
    const hasDestination = Boolean(draft.trim());
    const canSubmit = hasOrigin && hasDestination && !routeRequest && !saving && !change;
    const summary = result && result.status !== 'ready'
      ? `<p class="ref-state" role="status">${icon('circle-pause')}${esc(resultHoldMessage(result))}</p>`
      : '';
    const resultAddress = result?.origin?.address || result?.originAddress || '';
    const resultBasis = demo
      ? '합성 공고 공급위치 기준'
      : result?.origin?.basis === 'user_input'
        ? '입력한 단지 주소 기준'
        : '청약홈 공고 공급위치 기준';
    return heading + `<form id="commute-query" class="panel commute-form">
      ${renderOriginPoint(demo)}
      <div class="commute-point"><span aria-hidden="true" class="route-dot end"></span><div><label for="commute-destination">목적지 주소</label>
      <input id="commute-destination" name="destination" autocomplete="off" maxlength="200" placeholder="도로명과 건물번호 또는 지번" required value="${esc(draft)}" ${demo || saving || change ? 'readonly' : ''}>
      <small>${demo ? '예시 주소와 경로로 살펴봅니다.' : '상세 동·호수는 생략하세요. 조회할 때 카카오 로컬에 주소를 보내고, ODsay와 카카오모빌리티에는 두 지점의 좌표를 보냅니다.'}</small></div></div>
      <div class="commute-actions"><button class="action primary" type="submit" ${canSubmit ? '' : 'disabled'}>${icon(routeRequest ? 'loader-circle' : 'search')}${routeRequest ? '경로 조회 중' : demo ? '예시 경로 보기' : '경로 조회'}</button>
      ${!demo && profile && !change ? '<button class="text-action" type="button" data-commute="review">공유 목적지로 저장</button>' : ''}
      ${!demo && saved && !change ? '<button class="text-action" type="button" data-commute="clear">공유 목적지 해제</button>' : ''}
      ${profileError && !profileRequest ? '<button class="text-action" type="button" data-commute="reload">공유 목적지 다시 읽기</button>' : ''}</div>
      ${profileError ? '<p class="ref-meta">저장한 목적지를 불러오지 못했습니다. 이번 조회에 쓸 주소를 입력할 수 있습니다.</p>' : ''}
      ${!demo && result?.status !== 'ready' ? '<small class="ref-meta">대중교통 · <a class="ref-link" href="https://lab.odsay.com/" target="_blank" rel="noopener noreferrer">powered by www.ODsay.com</a></small>' : ''}</form>
      ${change ? `<section class="panel commute-confirm" aria-labelledby="confirm-destination"><h2 id="confirm-destination" tabindex="-1">공유 목적지 변경 확인</h2><p>다른 분석에서 불러올 목적지가 바뀝니다.</p><dl class="commute-facts"><div><dt>현재</dt><dd>${esc(saved || '미설정')}</dd></div><div><dt>변경 후</dt><dd>${esc(change.value || '미설정')}</dd></div></dl>
        <div class="commute-actions"><button class="action primary compact" data-commute="apply" ${saving ? 'disabled' : ''}>확인하고 반영</button><button class="action secondary compact" data-commute="cancel" ${saving ? 'disabled' : ''}>취소</button></div></section>` : ''}
      <p class="commute-feedback" role="status">${esc(message || (error ? errorText(error) : ''))}</p>${summary}
      ${result?.status === 'ready' ? `<section aria-label="수단별 경로 결과" class="commute-results-wrap">
        <div class="commute-result-origin"><span class="commute-label">출발지</span><strong>${esc(resultAddress)}</strong><span class="ref-meta">${esc(resultBasis)}</span></div>
        <div class="commute-results">${routeCard('transit', result.transit, demo)}${routeCard('driving', result.driving, demo)}</div>
      </section>` : ''}`;
  }

  root.addEventListener('input', e => {
    if (!ctx) return;
    if (e.target.id === 'commute-destination') {
      const hadValue = Boolean(draft.trim());
      draft = e.target.value;
      edited = true;
      const hasValue = Boolean(draft.trim());
      const update = Boolean(result || routeRequest || error || message || hadValue !== hasValue);
      routeRequest?.abort();
      routeRequest = result = error = null;
      message = '';
      if (update) render();
      return;
    }
    if (e.target.id === 'commute-origin') {
      const hadValue = Boolean(originDraft.trim());
      originDraft = e.target.value;
      originEdited = true;
      const hasValue = Boolean(originDraft.trim());
      const update = Boolean(result || routeRequest || error || message || hadValue !== hasValue);
      routeRequest?.abort();
      routeRequest = result = error = null;
      message = '';
      if (update) render();
    }
  });

  root.addEventListener('submit', e => {
    if (e.target.id !== 'commute-query') return;
    e.preventDefault();
    void query();
  });

  root.addEventListener('click', e => {
    const action = e.target.closest('[data-commute]')?.dataset.commute;
    if (!ctx || ctx.guest || !action || saving) return;
    if (action === 'reload-origin') {
      if (!previewRequest) {
        void loadOrigin();
        render();
      }
      return;
    }
    if (action === 'reload') {
      if (!profileRequest) void loadProfile();
      return;
    }
    if (action === 'edit-origin' && preview?.status === 'ready') {
      originEditing = true;
      if (!originEdited) originDraft = preview.origin.address ?? '';
      routeRequest?.abort();
      routeRequest = result = error = null;
      message = '';
      render();
      document.querySelector('#commute-origin')?.focus();
      return;
    }
    if (action === 'use-auto-origin' && preview?.status === 'ready' && preview.origin.address !== null) {
      originEditing = false;
      routeRequest?.abort();
      routeRequest = result = error = null;
      message = '';
      render();
      return;
    }
    if (action === 'apply') {
      void save();
      return;
    }
    if (action === 'cancel') {
      change = null;
      message = '목적지 변경을 취소했습니다.';
    }
    if (['review', 'clear'].includes(action) && profile) {
      const value = action === 'clear' ? null : draft.trim();
      if (action === 'review' && !value) {
        document.querySelector('#commute-destination')?.reportValidity();
        return;
      }
      if (value === profile.commute_destination) message = '이미 같은 목적지가 저장되어 있습니다.';
      else {
        change = { value, revision: profile.revision };
        message = '';
      }
    }
    render();
    if (change) document.querySelector('#confirm-destination')?.focus();
    else document.querySelector('#commute-destination')?.focus();
  });

  return { enter, reset, view };
}
