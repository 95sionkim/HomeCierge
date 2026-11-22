import { commuteProfile, confirmDestination, queryCommute } from './client.js';
import { esc, icon, errorText } from './display.js';

const messages = {
  synthetic_input: '실제 공고를 선택한 뒤 경로를 조회할 수 있습니다.',
  selection_unverified: '선택한 공고와 수집본의 회차를 확인해야 합니다.',
  origin_unverified: '공고 주소를 하나의 출발 지점으로 확인하지 못했습니다.',
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
const stamp = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month:'numeric', day:'numeric',
  hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
const providers = { transit: ['대중교통', 'powered by www.ODsay.com', 'https://lab.odsay.com/'],
  driving: ['자동차', '카카오모빌리티', 'https://developers.kakaomobility.com/product/naviapi.html'] };
const kinds = { subway: '지하철', bus: '버스', mixed: '버스·지하철', car: '승용차' };

function demoResult() {
  const time = '2026-10-27T00:00:00Z';
  return { status:'ready', originAddress:'합성 가람아파트', transit:{ source:'odsay_route', status:'available',
    queriedAt:time, kind:'mixed', durationSeconds:2280, walkMinutes:null, walkMeters:480, distanceMeters:null },
    driving:{ source:'kakao_directions', status:'available', queriedAt:time, kind:'car', durationSeconds:1440,
      distanceMeters:9700, walkMinutes:null, walkMeters:null } };
}
function validRoute(r, mode) {
  if (!r || r.source !== (mode === 'transit' ? 'odsay_route' : 'kakao_directions') ||
      (r.queriedAt !== null && (!r.queriedAt || !Number.isFinite(Date.parse(r.queriedAt))))) return false;
  if (r.status !== 'available') return Object.hasOwn(messages,r.status) &&
    [r.durationSeconds,r.walkMinutes,r.walkMeters,r.distanceMeters,r.kind].every(value => value === null);
  return !!r.queriedAt && Number.isSafeInteger(r.durationSeconds) && r.durationSeconds > 0 &&
    (mode === 'driving' ? r.kind === 'car' && Number.isSafeInteger(r.distanceMeters) && r.distanceMeters > 0 :
      ['subway','bus','mixed'].includes(r.kind) && [r.walkMinutes,r.walkMeters].every(v => v === null || (Number.isSafeInteger(v) && v >= 0)));
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

export function createCommutePage({root, render}) {
  let ctx, profileRequest, routeRequest, profile, profileError, saving, change, draft, result, error, message, edited;
  function reset() {
    profileRequest?.abort();
    routeRequest?.abort();
    ctx = profileRequest = routeRequest = profile = profileError = change = result = error = null;
    saving = edited = false; draft = message = '';
  }
  async function loadProfile() {
    const here = ctx;
    const c = new AbortController();
    profileRequest = c;
    try {
      const current = await commuteProfile(here.ownerId,c.signal);
      if (ctx !== here) return;
      profile = current; profileError = null;
      if (!edited) draft = current.commute_destination ?? '';
    } catch (e) { if (ctx === here) profileError = e; }
    finally { if (ctx === here) { profileRequest = null; render(); } }
  }
  function enter(context) {
    reset(); ctx = context;
    if (ctx.guest) draft = '합성 가람시청';
    else void loadProfile();
  }
  async function query() {
    if (!ctx || routeRequest || saving || document.hidden || !draft.trim()) return;
    const here = ctx, c = new AbortController();
    const destination = draft.trim();
    routeRequest = c; result = error = null; message = ''; render();
    try {
      const data = here.guest ? demoResult() : await queryCommute(here.analysisId,here.snapshotId,destination,c.signal);
      if (routeRequest !== c) return;
      if (!here.guest && (data.contractVersion !== 'commute/v1' || data.analysisId !== here.analysisId ||
          data.snapshotId !== here.snapshotId || (data.status !== 'ready' && !Object.hasOwn(messages,data.status)) ||
          (data.originAddress !== null && typeof data.originAddress !== 'string') ||
          !validRoute(data.transit,'transit') || !validRoute(data.driving,'driving'))) throw new Error('invalid commute response');
      result = data;
    } catch (e) { if (routeRequest === c) error = e; }
    finally { if (routeRequest === c) { routeRequest = null; render(); } }
  }
  async function save() {
    if (!ctx || !change || saving || ctx.guest) return;
    const here = ctx, pending = change;
    saving = true; message = ''; render();
    try {
      await confirmDestination(here.ownerId,pending.revision,pending.value);
      if (ctx !== here) return;
      message = pending.value ? '공유 목적지를 저장했습니다.' : '공유 목적지를 해제했습니다.';
      change = null;
    } catch(e) { if (ctx === here) { message = errorText(e); change = null; } }
    finally {
      if (ctx === here) {
        profile = null;
        await loadProfile();
        if (ctx === here) { saving = false; render(); }
      }
    }
  }
  function view() {
    if (!ctx) return '';
    const demo = ctx.guest;
    const heading = `<section class="section-header ref-heading"><div><h1>출퇴근 경로</h1><p>${esc(ctx.name || '선택한 공고')}${demo ? ' · 합성 예시' : ''}</p></div></section>`;
    if (demo && !ctx.saved) return heading + '<p class="ref-state" role="status">공고의 출발지 주소가 확인되면 경로를 조회할 수 있습니다.</p>';
    const saved = profile?.commute_destination;
    const summary = result && result.status !== 'ready' ? `<p class="ref-state" role="status">${icon('circle-pause')}${esc(messages[result.status])}</p>` : '';
    return heading + `<form id="commute-query" class="panel commute-form">
      <div class="commute-point"><span aria-hidden="true" class="route-dot"></span><div><span class="commute-label">출발지</span><strong>${esc(result?.originAddress || ctx.name || '선택한 공고')}</strong><small>${demo ? '합성 공고 소재지' : '청약홈 공고 소재지 기준'}</small></div></div>
      <div class="commute-point"><span aria-hidden="true" class="route-dot end"></span><div><label for="commute-destination">목적지 주소</label>
      <input id="commute-destination" name="destination" autocomplete="off" maxlength="200" placeholder="도로명과 건물번호 또는 지번" required value="${esc(draft)}" ${demo || saving || change ? 'readonly' : ''}>
      <small>${demo ? '예시 주소와 경로로 살펴봅니다.' : '상세 동·호수는 생략하세요. 조회할 때 카카오 로컬에 주소를 보내고, ODsay와 카카오모빌리티에는 두 지점의 좌표를 보냅니다.'}</small></div></div>
      <div class="commute-actions"><button class="action primary" type="submit" ${routeRequest || saving || change ? 'disabled' : ''}>${icon(routeRequest ? 'loader-circle':'search')}${routeRequest ? '경로 조회 중' : demo ? '예시 경로 보기' : '경로 조회'}</button>
      ${!demo && profile && !change ? '<button class="text-action" type="button" data-commute="review">공유 목적지로 저장</button>' : ''}
      ${!demo && saved && !change ? '<button class="text-action" type="button" data-commute="clear">공유 목적지 해제</button>' : ''}
      ${profileError && !profileRequest ? '<button class="text-action" type="button" data-commute="reload">공유 목적지 다시 읽기</button>' : ''}</div>
      ${profileError ? '<p class="ref-meta">저장한 목적지를 불러오지 못했습니다. 이번 조회에 쓸 주소를 입력할 수 있습니다.</p>' : ''}
      ${!demo && result?.status !== 'ready' ? '<small class="ref-meta">대중교통 · <a class="ref-link" href="https://lab.odsay.com/" target="_blank" rel="noopener noreferrer">powered by www.ODsay.com</a></small>' : ''}</form>
      ${change ? `<section class="panel commute-confirm" aria-labelledby="confirm-destination"><h2 id="confirm-destination" tabindex="-1">공유 목적지 변경 확인</h2><p>다른 분석에서 불러올 목적지가 바뀝니다.</p><dl class="commute-facts"><div><dt>현재</dt><dd>${esc(saved || '미설정')}</dd></div><div><dt>변경 후</dt><dd>${esc(change.value || '미설정')}</dd></div></dl>
        <div class="commute-actions"><button class="action primary compact" data-commute="apply" ${saving ? 'disabled' : ''}>확인하고 반영</button><button class="action secondary compact" data-commute="cancel" ${saving ? 'disabled' : ''}>취소</button></div></section>` : ''}
      <p class="commute-feedback" role="status">${esc(message || (error ? errorText(error) : ''))}</p>${summary}
      ${result?.status === 'ready' ? `<section aria-label="수단별 경로 결과" class="commute-results">${routeCard('transit',result.transit,demo)}${routeCard('driving',result.driving,demo)}</section>` : ''}`;
  }
  root.addEventListener('input', e => {
    if (!ctx || e.target.id !== 'commute-destination') return;
    draft = e.target.value; edited = true;
    const update = result || routeRequest || error || message;
    routeRequest?.abort(); routeRequest = result = error = null; message = '';
    if (update) render();
  });
  root.addEventListener('submit', e => {
    if (e.target.id !== 'commute-query') return;
    e.preventDefault(); void query();
  });
  root.addEventListener('click', e => {
    const action = e.target.closest('[data-commute]')?.dataset.commute;
    if (!ctx || ctx.guest || !action || saving) return;
    if (action === 'reload') { if (!profileRequest) void loadProfile(); return; }
    if (action === 'apply') { void save(); return; }
    if (action === 'cancel') { change = null; message = '목적지 변경을 취소했습니다.'; }
    if (['review','clear'].includes(action) && profile) {
      const value = action === 'clear' ? null : draft.trim();
      if (action === 'review' && !value) { document.querySelector('#commute-destination')?.reportValidity(); return; }
      if (value === profile.commute_destination) message = '이미 같은 목적지가 저장되어 있습니다.';
      else { change = { value, revision:profile.revision }; message = ''; }
    }
    render();
    if (change) document.querySelector('#confirm-destination')?.focus();
    else document.querySelector('#commute-destination')?.focus();
  });
  return {enter, reset, view};
}
