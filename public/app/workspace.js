import * as api from './client.js';
import { esc, icon, dateText, todayKst, errorText, isoDate } from './display.js';
import { directoryPanels, directoryView, homeView, emptyState } from './directory-view.js';
import { comparisonView, runView, sampleHeld } from './result-view.js';
import { frame, authDialog, noticeDialog, sourceDialog, accountDialog } from './dialogs.js';
import { createSearchPage } from './search-page.js';
import { createFundingPage } from './funding-page.js';
import { createReferencePage } from './reference-page.js';

const root = document.querySelector('#app');
const dialog = document.querySelector('#workspace-dialog');
const announcement = document.querySelector('#announcement');
const state = {
  session: null,
  directory: null,
  analyses: [],
  historyError: null,
  dirError: null,
  run: null,
  comparison: null,
  runError: null,
  sample: null,
  sampleError: null,
  filter: 'all',
  query: '',
  view: 'cards',
  visible: 12,
  month: null,
  day: null,
  includeClosed: false,
  directoryLoading: true,
  historyLoading: false,
  authPending: true,
  suspended: false,
  sessionProblem: null,
};
let epoch = 0,
  dirVersion = 0,
  historyVersion = 0,
  routeVersion = 0,
  restoreVersion = 0,
  pollTimer;
let dialogNotice = null,
  sendingStart = false,
  sessionSubscription;
let demoDirectory, demoComparison;
const searchPage = createSearchPage({ root, render, user: () => state.session, selectNotice: selectSearchNotice });
const fundingPage = createFundingPage({ root, render });
const referencePage = createReferencePage({ root, render });
const resultSections = { comparison: '비교 결과', funding: '호실 자금표', law: '법령 근거', news: '지역 뉴스' };
const navs = [
  ['home', 'house', '홈'],
  ['notices', 'calendar-days', '오늘의 청약'],
  ['search', 'sliders-horizontal', '맞춤 검색'],
  ['analyses', 'folder-open', '내 분석'],
];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function readRoute() {
  const bits = location.hash.replace(/^#\/?/, '').split('/');
  let section = 'comparison';
  const sectionAt = bits[0] === 'sample' && bits[1] === 'saved' ? 2 : 3;
  if (['run', 'sample'].includes(bits[0]) && bits.length === sectionAt + 1 &&
      ['funding', 'law', 'news'].includes(bits.at(-1))) section = bits.pop();
  if (bits[0] === 'run' && bits.length === 3 && uuid.test(bits[1]) && uuid.test(bits[2]))
    return { key: 'run', analysisId: bits[1].toLowerCase(), runId: bits[2].toLowerCase(), section };
  if (bits[0] === 'sample' && bits.length === 2 && bits[1] === 'saved') return { key: 'sample', saved: true, section };
  if (bits[0] === 'sample' && bits.length === 3) {
    try {
      return { key: 'sample', noticeNo: decodeURIComponent(bits[1]), modelNo: decodeURIComponent(bits[2]), section };
    } catch {
      return { key: 'notices' };
    }
  }
  return { key: navs.some((n) => n[0] === bits[0]) ? bits[0] : 'notices' };
}
function announce(message) {
  announcement.textContent = message;
}
function navigate(to) {
  if (location.hash === to) routeChanged();
  else location.hash = to;
}
function resetPrivate() {
  searchPage.reset();
  fundingPage.reset();
  referencePage.reset();
  ++epoch;
  ++dirVersion;
  ++historyVersion;
  ++routeVersion;
  clearTimeout(pollTimer);
  Object.assign(state, {
    directory: null,
    analyses: [],
    dirError: null,
    historyError: null,
    run: null,
    comparison: null,
    runError: null,
    sample: null,
    sampleError: null,
    directoryLoading: false,
    historyLoading: false,
    month: null,
    day: null,
    query: '',
    filter: 'all',
    includeClosed: false,
    visible: 12,
  });
  closeDialog();
}
function setUser(user, force = false) {
  if (
    !force &&
    !state.authPending &&
    !state.suspended &&
    !state.sessionProblem &&
    state.session?.id === user?.id
  )
    return;
  ++restoreVersion;
  const leaving = Boolean(state.session && state.session.id !== user?.id);
  resetPrivate();
  state.authPending = false;
  state.sessionProblem = null;
  state.suspended = false;
  state.session = user;
  const route = readRoute();
  if ((leaving && route.key === 'run') || (user && route.key === 'sample'))
    history.replaceState(null, '', '#notices');
  render();
  void loadDirectory();
  if (user) void loadHistory();
  routeChanged();
}
async function restore(force = false) {
  const version = ++restoreVersion;
  try {
    const user = await api.getSession();
    if (version === restoreVersion) setUser(user, force);
  } catch (error) {
    if (version !== restoreVersion) return;
    if (state.session || state.suspended) {
      resetPrivate();
      state.authPending = false;
      state.suspended = false;
      state.sessionProblem = error;
      render();
    } else setUser(null, force);
  }
}
async function getFixture(type) {
  const url =
    type === 'directory' ? '/app/assets/directory-example.json' : '/app/assets/comparison-example.json';
  let data = type === 'directory' ? demoDirectory : demoComparison;
  if (!data) {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) throw new Error('fixture unavailable');
    data = await response.json();
    if (
      data.dataOrigin !== 'synthetic' ||
      data.contractVersion !== (type === 'directory' ? 'notice-directory/v1' : 'comparison/v1')
    )
      throw new Error('invalid fixture');
    if (type === 'directory') demoDirectory = data;
    else demoComparison = data;
  }
  return data;
}
function validDirectory(d, origin) {
  if (
    d?.contractVersion !== 'notice-directory/v1' ||
    d.dataOrigin !== origin ||
    !isoDate(d.asOf) ||
    !Array.isArray(d.notices) ||
    !d.counts ||
    !d.page
  )
    throw new Error('invalid directory');
}
async function selectSearchNotice(notice, model) {
  const account = epoch, version = routeVersion;
  const feeds = values => values.filter(x => x === 'applyhome_apt' || x === 'applyhome_remainder');
  const source = feeds(notice.sourceIds);
  const fail = () => { throw Object.assign(new Error('selection'), { code: 'search_selection_changed' }); };
  if (source.length !== 1) fail();
  const match = n => n.noticeNo === notice.noticeNo && n.houseManageNo === notice.houseManageNo && n.edition === notice.edition;
  let entry;
  if (!state.session) entry = (await getFixture('directory')).notices.find(match);
  else {
    // 검색과 개별 목록은 별도 관측이므로 선택 시점의 최신 공식 모델을 다시 확인한다.
    let cursor = null, observation;
    const seen = new Set();
    do {
      const page = await api.listNotices({ includeClosed: true, limit: 50, cursor });
      if (epoch !== account || version !== routeVersion) return;
      validDirectory(page, 'collected');
      if (observation && observation !== page.observedAt) fail();
      observation = page.observedAt;
      entry = page.notices.find(match);
      cursor = page.page.nextCursor;
      if (cursor && seen.has(cursor)) fail();
      seen.add(cursor);
    } while (!entry && cursor);
  }
  if (epoch !== account || version !== routeVersion) return;
  const selected = entry?.models.find(m => m.modelNo === model.modelNo && m.houseType === model.houseType
    && m.analysisInput?.noticeSource === source[0] && !m.selectionBlockers?.length);
  if (!selected) fail();
  dialogNotice = { ...entry, models: [selected] };
  openDialog(noticeDialog(dialogNotice, !state.session));
  const radio = dialog.querySelector('input[name=model]:not(:disabled)');
  if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', {bubbles:true})); }
}
async function loadDirectory() {
  const version = ++dirVersion,
    account = epoch;
  const valid = () => version === dirVersion && account === epoch;
  const real = Boolean(state.session);
  state.directoryLoading = true;
  state.dirError = null;
  render();
  let partial = null;
  try {
    if (!real) {
      partial = await getFixture('directory');
      validDirectory(partial, 'synthetic');
    } else {
      const query = { includeClosed: state.includeClosed, limit: 50 };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          partial = null;
          let cursor = null;
          const seen = new Set();
          do {
            const d = await api.listNotices({ ...query, cursor });
            if (!valid()) return;
            validDirectory(d, 'collected');
            if (!partial) partial = { ...d, notices: [...d.notices] };
            else if (
              partial.observedAt === d.observedAt &&
              partial.asOf === d.asOf &&
              d.page.offset === partial.notices.length
            )
              partial.notices.push(...d.notices);
            else throw Object.assign(new Error('changed'), { code: 'directory_page_changed' });
            cursor = d.page.nextCursor;
            if (cursor && seen.has(cursor)) throw new Error('duplicate cursor');
            if (cursor) {
              seen.add(cursor);
              state.directory = partial;
              state.month ??= partial.asOf.slice(0, 7);
              render();
            }
          } while (cursor);
          break;
        } catch (error) {
          if (error.code === 'directory_page_changed' && attempt === 0) continue;
          throw error;
        }
      }
    }
    if (!valid()) return;
    state.directory = partial;
    state.month ??= partial.asOf.slice(0, 7);
  } catch (error) {
    if (!valid()) return;
    const mustDiscard = [
      'authentication_required',
      'search_source_restricted',
      'notice_source_restricted',
      'notice_search_source_use_not_allowed',
      'directory_page_changed',
    ].includes(error?.code);
    state.directory = mustDiscard ? null : partial;
    if (mustDiscard) closeDialog();
    state.dirError = error;
  } finally {
    if (valid()) {
      state.directoryLoading = false;
      render();
    }
  }
}
async function loadHistory() {
  if (!state.session) return;
  const version = ++historyVersion,
    account = epoch;
  state.historyLoading = true;
  state.historyError = null;
  render();
  try {
    const data = await api.listAnalyses();
    if (version === historyVersion && account === epoch) state.analyses = data;
  } catch (error) {
    if (version === historyVersion && account === epoch) state.historyError = error;
  } finally {
    if (version === historyVersion && account === epoch) {
      state.historyLoading = false;
      render();
    }
  }
}
const accountHistoryStates = {
  draft: '초안',
  input_ready: '입력 완료',
  queued: '분석 대기',
  running: '분석 중',
  partial: '부분 결과',
  completed: '분석 완료',
  failed: '분석 실패',
  cancelled: '분석 취소',
};
function historyList(home = false) {
  if (!state.session)
    return `<a class="history-item" href="#sample/saved"><span class="history-icon">${icon('chart-no-axes-combined')}</span><span class="history-body"><strong>합성 가람 아파트</strong><small>비교 근거가 확인된 예시 · 공고 9900000042</small></span>${icon('chevron-right')}</a>`;
  if (state.historyError)
    return emptyState(
      'triangle-alert',
      '분석 목록을 불러오지 못했습니다.',
      errorText(state.historyError),
      '<button class="action secondary" data-action="reload-history">다시 조회</button>',
    );
  if (!state.analyses.length)
    return state.historyLoading
      ? emptyState('loader-circle', '내 분석을 불러오는 중입니다.')
      : emptyState(
          'folder-open',
          '아직 저장된 분석이 없습니다.',
          '공고에서 주택형을 선택하면 내 분석에 저장됩니다.',
          '<a class="action primary" href="#notices">공고 살펴보기</a>',
        );
  return `<div class="listing">${state.analyses
    .slice(0, home ? 3 : state.analyses.length)
    .map(
      (r) =>
        `<a class="history-item" href="#run/${esc(r.analysisId)}/${esc(r.runId)}"><span class="history-icon">${icon('file-text')}</span><span class="history-body"><strong>${esc(r.title ?? '청약 분석')}</strong><small>${esc(dateText(todayKst(r.updatedAt)))} · ${esc(accountHistoryStates[r.status] ?? '상태 확인 필요')}</small></span>${icon('chevron-right')}</a>`,
    )
    .join('')}</div>`;
}
function historyRail() {
  if (state.authPending || state.suspended || state.sessionProblem) return '';
  const links = state.session
    ? state.analyses
        .slice(0, 3)
        .map((r) => ({ title: r.title ?? '청약 분석', href: `#run/${r.analysisId}/${r.runId}` }))
    : [{ title: '합성 가람 아파트', href: '#sample/saved' }];
  return `<section class="rail-history"><h2>${state.session ? '최근 분석' : '예시 분석'}</h2>${links.map((r) => `<a class="rail-history-link" href="${esc(r.href)}">${icon('file-text')}<span>${esc(r.title)}</span></a>`).join('') || '<p class="rail-empty">아직 분석이 없습니다.</p>'}</section>`;
}
function shell(body, route) {
  const active = ['run', 'sample'].includes(route.key) ? 'analyses' : route.key;
  const label = navs.find((n) => n[0] === active)?.[2] ?? '오늘의 청약';
  const nav = (mobile = false) =>
    navs
      .map(
        ([key, symbol, name]) =>
          `<a href="#${key}" class="${mobile ? '' : 'nav-item '}${active === key ? 'active' : ''}"${active === key ? ' aria-current="page"' : ''}>${icon(symbol)}<span>${name}</span></a>`,
      )
      .join('');
  const mode = state.session ? '내 워크스페이스' : state.authPending ? '세션 확인 중' : '예시 둘러보기';
  return `<div class="shell"><aside class="rail"><a class="wordmark rail-brand" href="#home" aria-label="HomeCierge 홈">HomeCierge</a><nav class="rail-menu" aria-label="주 메뉴">${nav()}</nav>${historyRail()}<div class="rail-bottom"><button class="nav-item" data-action="source" type="button">${icon('database')}자료 근거</button><button type="button" class="account-control" data-action="${state.session ? 'account' : 'auth'}"><span class="account-symbol">${icon('user-round')}</span><span>${state.session ? '내 계정' : '게스트'}<small>${esc(state.session?.email ?? '예시 둘러보기')}</small></span>${icon('chevron-right')}</button></div></aside>
    <div class="work"><header class="topbar"><div class="breadcrumb"><a href="#home" aria-label="홈">${icon('house')}</a>${icon('chevron-right')}<strong>${label}${route.key === 'run' || route.key === 'sample' ? ' · 분석 결과' : ''}</strong></div><a class="wordmark mobile-wordmark" href="#home">HomeCierge</a><div class="top-tools"><span class="mode-pill">${icon(state.session ? 'shield-check' : 'layers')}${mode}</span><button type="button" class="action compact ${state.session ? 'secondary' : 'primary'}" data-action="${state.session ? 'account' : 'auth'}">${state.session ? icon('user-round') + '내 계정' : '로그인 ' + icon('arrow-right')}</button></div></header><main id="main-content" tabindex="-1" class="content">${body}</main></div>
    <nav aria-label="모바일 주 메뉴" class="mobile-nav">${nav(true)}<button data-action="${state.session ? 'account' : 'auth'}">${icon('user-round')}계정</button></nav></div>`;
}
function focusedControl(node) {
  if (!node || !root.contains(node)) return null;
  const section = ['.rail', '.topbar', '.mobile-nav', 'main'].find((selector) => node.closest(selector));
  const attribute = [
    'id',
    'data-action',
    'data-notice',
    'data-filter',
    'data-view',
    'data-date',
    'data-month',
    'href',
  ].find((name) => node.hasAttribute(name));
  return section && attribute
    ? `${section} [${attribute}="${CSS.escape(node.getAttribute(attribute))}"]`
    : null;
}
function render() {
  const route = readRoute();
  const focus = document.activeElement;
  const previousControl = focusedControl(focus);
  const searchFocus =
    focus?.id === 'notice-search' ? { start: focus.selectionStart, end: focus.selectionEnd } : null;
  let body;
  if (state.suspended || state.sessionProblem)
    body = emptyState(
      'shield-check',
      state.sessionProblem ? '세션을 확인하지 못했습니다.' : '세션을 확인하고 있습니다.',
      state.sessionProblem ? errorText(state.sessionProblem) : '',
      state.sessionProblem
        ? '<button type="button" class="action secondary" data-action="restore">다시 연결</button>'
        : '',
    );
  else if (route.key === 'home') body = homeView(state, historyList(true));
  else if (route.key === 'search') body = searchPage.view();
  else if (route.key === 'analyses')
    body = `<section class="section-header"><h1>내 분석</h1><p>${state.session ? '계정에 저장된 분석을 최근 순으로 확인하세요.' : '합성 자료로 만든 분석에서 가격과 근거를 살펴보세요.'}</p></section>${historyList()}`;
  else if (route.key === 'run')
    body = state.authPending ? emptyState('loader-circle', '세션을 확인하고 있습니다.') : runView(state);
  else if (route.key === 'sample')
    body = state.session
      ? emptyState(
          'user-round',
          '로그인한 계정의 분석 목록을 확인하세요.',
          '',
          '<a class="action primary" href="#analyses">내 분석</a>',
        )
      : state.sampleError
        ? emptyState(
            'circle-help',
            '예시 결과를 불러올 수 없습니다.',
            '',
            '<a class="action secondary" href="#notices">공고로 돌아가기</a>',
          )
        : state.sample
          ? comparisonView(state.sample)
          : emptyState('loader-circle', '예시 결과를 불러오고 있습니다.');
  else body = directoryView(state);
  const comparison = route.key === 'run' ? state.comparison : route.key === 'sample' ? state.sample : null;
  const finished = route.key === 'run' && state.run?.status === 'finished' && uuid.test(state.run.snapshotId);
  if ((comparison || finished) && !state.suspended && !state.sessionProblem) {
    const base = route.section === 'comparison' ? location.hash : location.hash.slice(0, location.hash.lastIndexOf('/'));
    const tabs = Object.entries(resultSections).map(([key,label]) =>
      `<a href="${esc(base + (key === 'comparison' ? '' : '/' + key))}"${key === route.section ? ' aria-current="page"' : ''}>${label}</a>`).join('');
    if (isReference(route)) body = referencePage.view();
    else if (route.section === 'funding' && comparison && !state.runError) body = fundingPage.view();
    body = `<nav class="analysis-tabs" aria-label="분석 보기">${tabs}</nav>` + body;
  }
  root.innerHTML = shell(body, route);
  document.title =
    (route.section === 'funding' ? '호실별 자금표' : isReference(route) ? resultSections[route.section] : { notices: '오늘의 청약', search: '맞춤 공고 찾기', home: '홈', analyses: '내 분석', run: '분석 결과', sample: '분석 예시' }[
      route.key
    ] ?? '오늘의 청약') + ' | HomeCierge';
  if (searchFocus) {
    const next = document.querySelector('#notice-search');
    next?.focus({ preventScroll: true });
    next?.setSelectionRange(searchFocus.start, searchFocus.end);
  } else if (previousControl) defaultFocus(previousControl);
}
async function readRun(route, version = routeVersion) {
  if (!state.session || state.suspended || document.hidden) return;
  const account = epoch;
  const valid = () => version === routeVersion && account === epoch;
  clearTimeout(pollTimer);
  state.runError = null;
  try {
    const r = await api.getRun(route.analysisId, route.runId);
    if (!valid()) return;
    if (r.analysisId !== route.analysisId || r.runId !== route.runId) throw new Error('unbound result');
    state.run = r;
    if (r.status === 'finished' && isReference(route)) {
      if (!uuid.test(r.snapshotId)) throw new Error('unbound snapshot');
      const title = state.analyses.find(a => a.analysisId === r.analysisId)?.title;
      loadReference(route, title || (r.input?.noticeNo ? '공고 ' + r.input.noticeNo : ''), r.snapshotId);
    } else if (r.status === 'finished') {
      const data = await api.getResult(route.analysisId, route.runId);
      if (!valid()) return;
      if (
        data.analysisId !== route.analysisId ||
        data.runId !== route.runId ||
        data.snapshotId !== r.snapshotId
      )
        throw new Error('unbound result');
      state.comparison = data.result;
      if (route.section === 'funding') void loadFunding(route, data.result, r.snapshotId);
    } else if (['queued', 'running', 'retry_wait'].includes(r.status)) {
      pollTimer = setTimeout(() => void readRun(route, version), 4000);
    }
  } catch (error) {
    if (valid()) state.runError = error;
  }
  if (valid()) render();
}
async function readSample(route, version) {
  try {
    if (route.saved) {
      const d = await getFixture('comparison');
      if (version !== routeVersion) return;
      state.sample = d;
    } else {
      const dir = await getFixture('directory');
      if (version !== routeVersion) return;
      const n = dir.notices.find((x) => x.noticeNo === route.noticeNo),
        m = n?.models.find((x) => x.modelNo === route.modelNo && x.analysisInput);
      if (!m) throw new Error('sample not found');
      state.sample = sampleHeld(n, m, dir.asOf);
    }
  } catch (error) {
    if (version === routeVersion) state.sampleError = error;
  }
  if (version === routeVersion) {
    if (state.sample && isReference(route)) loadReference(route, state.sample.target?.name);
    if (route.section === 'funding' && state.sample) void loadFunding(route, state.sample);
    render();
  }
}
function isReference(route) {
  return route.section === 'law' || route.section === 'news';
}
function loadReference(route, name, snapshotId) {
  referencePage.enter({ section: route.section, guest: route.key === 'sample', saved: route.saved,
    analysisId: route.analysisId, snapshotId, name });
}
function loadFunding(route, result, snapshotId) {
  return fundingPage.enter({
    guest: route.key === 'sample', ownerId: state.session?.id, analysisId: route.analysisId, snapshotId,
    modelNo: result.target?.modelNo, houseType: result.target?.houseType, name: result.target?.name,
    price: result.noticePrice, origin: result.dataOrigin,
  });
}
function routeChanged(focus = false) {
  const route = readRoute();
  const version = ++routeVersion;
  searchPage.reset();
  fundingPage.reset();
  referencePage.reset();
  clearTimeout(pollTimer);
  closeDialog();
  state.run = null;
  state.comparison = null;
  state.runError = null;
  state.sample = null;
  state.sampleError = null;
  if (route.key === 'sample' && !state.session && !state.suspended && !state.authPending)
    void readSample(route, version);
  else if (route.key === 'search' && !state.suspended && !state.authPending && !state.sessionProblem)
    void searchPage.enter();
  else if (route.key === 'run' && state.session && !state.suspended) void readRun(route, version);
  render();
  if (focus) {
    document.querySelector('#main-content')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
}
function openDialog(html, focusSelector = null) {
  dialog.innerHTML = html;
  if (!dialog.open) dialog.showModal();
  if (focusSelector) dialog.querySelector(focusSelector)?.focus();
}
function closeDialog() {
  if (dialog.open) dialog.close();
  dialogNotice = null;
  sendingStart = false;
}
function feedback(text, success = false) {
  const message = dialog.querySelector('#form-message');
  if (message) {
    message.textContent = text;
    message.className = 'form-message' + (success ? ' success' : '');
  }
}
function monthShift(delta) {
  const [year, month] = (state.month ?? todayKst().slice(0, 7)).split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1 + delta));
  if (next.getUTCFullYear() >= 1000 && next.getUTCFullYear() <= 9999)
    state.month = next.toISOString().slice(0, 7);
}
function defaultFocus(selector) {
  document.querySelector(selector)?.focus({ preventScroll: true });
}
function authRetrySubscription() {
  sessionSubscription?.();
  sessionSubscription = api.onSessionChange((user) => {
    if (!document.hidden) setUser(user);
  });
}
root.addEventListener('click', (event) => {
  const control = event.target.closest('button');
  if (!control) return;
  const { action, notice, view, filter, date, month } = control.dataset;
  if (notice !== undefined) {
    const entry = state.directory?.notices[Number(notice)];
    if (!entry) return;
    dialogNotice = entry;
    openDialog(noticeDialog(entry, state.directory.dataOrigin === 'synthetic'));
    return;
  }
  if (view) {
    state.view = view;
    render();
    defaultFocus(`[data-view="${view}"]`);
    return;
  }
  if (filter) {
    state.visible = 12;
    state.filter = filter;
    render();
    defaultFocus(`[data-filter="${filter}"]`);
    return;
  }
  if (date && isoDate(date)) {
    state.visible = 12;
    state.day = state.day === date ? null : date;
    render();
    defaultFocus(`[data-date="${date}"]`);
    announce(state.day ? date + ' 접수 공고를 표시합니다.' : '날짜 선택을 해제했습니다.');
    return;
  }
  if (month) {
    monthShift(Number(month));
    render();
    defaultFocus(`[data-month="${month}"]`);
    return;
  }
  if (action === 'auth') {
    openDialog(authDialog(), '#auth-email');
  } else if (action === 'account' && state.session) openDialog(accountDialog(state.session));
  else if (action === 'source') openDialog(sourceDialog(state.directory));
  else if (action === 'clear-filter') {
    state.filter = 'all';
    state.query = '';
    state.day = null;
    render();
    defaultFocus('#notice-search');
  } else if (action === 'calendar-reset' || action === 'clear-date') {
    state.day = null;
    if (action === 'calendar-reset') state.month = (state.directory?.asOf ?? todayKst()).slice(0, 7);
    render();
    defaultFocus(action === 'calendar-reset' ? '[data-action=calendar-reset]' : '#notice-search');
  } else if (action === 'more-notices') {
    const shown = state.visible;
    state.visible += 12;
    render();
    document.querySelectorAll('.notice-card')[shown]?.focus();
  } else if (action === 'reload') void loadDirectory();
  else if (action === 'reload-run') routeChanged();
  else if (action === 'reload-history') void loadHistory();
  else if (action === 'restore') void restore(true);
  else if (action === 'cancel')
    openDialog(
      frame(
        '실행을 취소할까요?',
        '취소하면 이번 분석의 수집과 계산이 중단됩니다.',
        '<p class="form-message" role="status" id="form-message"></p><div class="form-actions"><button class="action secondary" data-action="close">계속 분석</button><button class="action primary" data-action="confirm-cancel">실행 취소</button></div>',
      ),
    );
});
root.addEventListener('input', (event) => {
  if (event.target.id === 'notice-search') {
    state.query = event.target.value;
    state.visible = 12;
    // 한글을 조합하는 동안 검색 입력과 커서는 유지하고 결과만 갱신한다.
    const panels = directoryPanels(state);
    document.querySelector('#directory-results').innerHTML = panels.results;
    document.querySelector('#directory-summary').innerHTML = panels.summary;
  }
});
root.addEventListener('change', (event) => {
  if (event.target.id !== 'include-closed') return;
  state.includeClosed = event.target.checked;
  if (!state.includeClosed && state.filter === 'closed') state.filter = 'all';
  state.directory = null;
  void loadDirectory();
  defaultFocus('#include-closed');
});
dialog.addEventListener('change', (event) => {
  if (event.target.name === 'model') {
    const submit = dialog.querySelector('[data-action=start]');
    if (submit) submit.disabled = !dialog.querySelector('input[name=model]:checked:not(:disabled)');
  }
});
dialog.addEventListener('cancel', () => {
  dialogNotice = null;
  sendingStart = false;
});
dialog.addEventListener('click', async (event) => {
  if (event.target === dialog) {
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      closeDialog();
    return;
  }
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'close') return closeDialog();
  if (action === 'auth' || action === 'signup') {
    openDialog(authDialog(action === 'signup'), '#auth-email');
    return;
  }
  if (action === 'logout') {
    button.disabled = true;
    resetPrivate();
    state.suspended = true;
    render();
    try {
      await api.signOut();
      setUser(null);
      closeDialog();
      announce('로그아웃했습니다.');
    } catch (error) {
      state.suspended = false;
      state.sessionProblem = error;
      render();
      if (state.session) {
        openDialog(accountDialog(state.session));
        feedback('로그아웃을 마치지 못했습니다. ' + errorText(error));
      }
    }
    return;
  }
  if (action === 'start') {
    const n = dialogNotice,
      m = n?.models?.find(
        (x) => x.modelNo === dialog.querySelector('input[name=model]:checked')?.value && x.analysisInput,
      );
    if (!n || !m || sendingStart) return;
    if (!state.session) {
      if (state.directory?.dataOrigin === 'synthetic')
        navigate('#sample/' + encodeURIComponent(n.noticeNo) + '/' + encodeURIComponent(m.modelNo));
      return;
    }
    const account = epoch;
    sendingStart = true;
    button.disabled = true;
    feedback('분석을 접수하고 있습니다.', true);
    try {
      const r = await api.startAnalysis(n, m);
      if (account !== epoch) return;
      if (!uuid.test(r.analysisId) || !uuid.test(r.runId)) throw new Error('invalid run');
      void loadHistory();
      navigate('#run/' + r.analysisId + '/' + r.runId);
      announce('분석을 접수했습니다.');
    } catch (error) {
      if (account === epoch && dialogNotice === n) {
        feedback(errorText(error));
        button.disabled = false;
      }
    } finally {
      if (account === epoch) sendingStart = false;
    }
  }
  if (action === 'confirm-cancel') {
    const route = readRoute(),
      version = routeVersion;
    button.disabled = true;
    if (route.key !== 'run' || !state.session) return closeDialog();
    try {
      await api.cancelRun(route.analysisId, route.runId);
      if (version === routeVersion) {
        closeDialog();
        routeChanged();
        void loadHistory();
        announce('실행 상태를 갱신했습니다.');
      }
    } catch (error) {
      if (version === routeVersion) {
        feedback(errorText(error));
        button.disabled = false;
      }
    }
  }
});
dialog.addEventListener('submit', async (event) => {
  const form = event.target;
  if (form.id !== 'auth-form') return;
  event.preventDefault();
  const submit = form.querySelector('[type=submit]');
  if (submit.disabled) return;
  const email = form.elements.email.value.trim(),
    password = form.elements.password.value;
  submit.disabled = true;
  feedback('');
  try {
    if (form.dataset.mode === 'signup') {
      const response = await api.signUp(email, password);
      if (!response.signedIn) {
        form.elements.password.value = '';
        feedback('가입 요청을 받았습니다. 이메일의 확인 링크를 열어 주세요.', true);
        return;
      }
      setUser(await api.getSession());
    } else setUser(await api.signIn(email, password));
    closeDialog();
    authRetrySubscription();
    announce('로그인했습니다.');
  } catch (error) {
    if (form.isConnected) feedback(errorText(error));
  } finally {
    if (form.isConnected) submit.disabled = false;
  }
});
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  document.querySelector('#main-content')?.focus();
});
window.addEventListener('hashchange', () => routeChanged(true));
function suspendPrivate() {
  clearTimeout(pollTimer);
  if (!state.session || state.suspended) return;
  resetPrivate();
  state.suspended = true;
  render();
}
window.addEventListener('pagehide', suspendPrivate);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) suspendPrivate();
  else void restore(Boolean(state.suspended));
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    if (state.session) {
      resetPrivate();
      state.suspended = true;
      render();
    }
    void restore(true);
  }
});
authRetrySubscription();
render();
void restore();
