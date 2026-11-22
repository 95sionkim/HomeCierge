import {
  esc,
  icon,
  badge,
  kinds,
  scheduleBadge,
  rangesFor,
  rangeLabel,
  publicationText,
  inRange,
  dateText,
  longDate,
  isoDate,
  todayKst,
  errorText,
} from './display.js';

export function sourceChip(synthetic) {
  return `<button type="button" class="source" data-action="source">${icon(synthetic ? 'layers' : 'database')}${synthetic ? '합성 자료' : '청약홈'}</button>`;
}

function verifiedCount(directory, status) {
  const value = directory?.counts?.[status];
  if (!Number.isInteger(value) || (value === 0 && directory.zeroStatus?.[status] === 'indeterminate'))
    return '—';
  return value.toLocaleString('ko-KR');
}

export function hero(state, home = false) {
  const { directory, session } = state;
  const stat = (label, value) =>
    `<span class="hero-stat"><span>${label}</span><b>${esc(value)}</b>${value === '—' ? '' : '<em>건</em>'}</span>`;
  return `<section class="hero" aria-labelledby="page-heading">
    <div class="hero-copy">
      <div class="hero-date">${icon('calendar-days')}<span>${esc(longDate(directory?.asOf))}</span></div>
      <h1 id="page-heading">${home ? '청약 워크스페이스' : '오늘의 청약'}</h1>
      <p>${home ? '살펴본 청약과 내 분석을 한곳에서 확인하세요.' : '접수 중이거나 곧 열리는 공고를 살펴보세요.'}</p>
      ${home ? '<a class="action primary" href="#notices">공고 살펴보기' + icon('arrow-right') + '</a>' : `<div class="hero-stats" aria-label="${session ? '공고 현황' : '예시 공고 현황'}">${stat('접수 중', verifiedCount(directory, 'open'))}${stat('접수 예정', verifiedCount(directory, 'upcoming'))}${stat('일정 확인 필요', verifiedCount(directory, 'unknown'))}</div>`}
    </div><div class="hero-art" aria-hidden="true"><img src="/app/assets/apartment-maquette.jpg" alt="" fetchpriority="high"></div>
  </section>`;
}

function noticeName(n) {
  return n.title || `공고 ${n.noticeNo}`;
}
export { noticeName };

function shownRange(n, asOf) {
  const ranges = rangesFor(n);
  const candidate =
    ranges.find((r) => r.start <= asOf && asOf <= r.end) ??
    ranges.find((r) => r.start >= asOf) ??
    ranges.at(-1);
  return { label: rangeLabel(candidate), split: Array.isArray(n.applicationSegments) };
}

function card(n, index, asOf) {
  const { label, split } = shownRange(n, asOf);
  const deadline = n.applicationStatus === 'open' && rangesFor(n).some((r) => r.end === asOf);
  return `<button type="button" class="notice-card" data-notice="${index}">
    <span class="card-top">${scheduleBadge(n.applicationStatus)}<span class="kind">${esc(kinds[n.kind] ?? '유형 미확인')}</span></span>
    <span class="card-title" role="heading" aria-level="3">${esc(noticeName(n))}</span>
    <span class="card-meta">${icon('map-pin')}${esc(n.regionName ?? '지역 미확인')}</span>
    <span class="card-identity"><span>공고일 ${esc(publicationText(n))}</span><span>공고 <span class="code">${esc(n.noticeNo)}</span></span></span>
    <span class="card-base"><span>${icon('calendar-days')} <strong>${label === '일정 미확인' ? '접수일 미확인' : '접수 ' + esc(label)}</strong>${deadline ? ' <span class="deadline">오늘 마감</span>' : split ? ' <span class="fine muted">분리 접수</span>' : ''}</span>${icon('arrow-up-right')}</span>
  </button>`;
}

function selectedNotices(state) {
  const needle = state.query.trim().toLocaleLowerCase('ko-KR');
  return (state.directory?.notices ?? [])
    .map((notice, index) => ({ notice, index }))
    .filter(
      ({ notice: n }) =>
        (state.filter === 'all' || n.applicationStatus === state.filter) &&
        (!needle ||
          [n.title, n.noticeNo, n.regionName].some(
            (s) => typeof s === 'string' && s.toLocaleLowerCase('ko-KR').includes(needle),
          )) &&
        (state.includeClosed || n.applicationStatus !== 'closed'),
    );
}

function listHTML(state, records) {
  if (state.directoryLoading && !state.directory)
    return emptyState('loader-circle', '공고를 불러오는 중입니다.');
  if (!state.directory && state.dirError)
    return emptyState(
      'triangle-alert',
      '공고를 불러오지 못했습니다.',
      errorText(state.dirError),
      '<button class="action secondary" data-action="reload">다시 조회</button>',
    );
  const matches = records.filter(({ notice }) => !state.day || inRange(notice, state.day));
  if (matches.length) {
    const visible = matches.slice(0, state.visible);
    return `<div class="notice-grid">${visible.map(({ notice, index }) => card(notice, index, state.directory?.asOf)).join('')}</div>${matches.length > visible.length ? `<div class="more-notices"><button type="button" class="action secondary" data-action="more-notices">공고 더 보기 ${icon('chevron-down')}</button><span class="small muted">${visible.length} / ${matches.length}건</span></div>` : ''}`;
  }
  if (state.directoryLoading) return emptyState('loader-circle', '다음 공고를 불러오는 중입니다.');
  const hasFilter = state.filter !== 'all' || state.query || state.day;
  const uncertain =
    state.dirError ||
    state.directory?.scopeIssues?.length ||
    state.directory?.counts?.unknown ||
    Object.values(state.directory?.zeroStatus ?? {}).includes('indeterminate');
  if (hasFilter)
    return emptyState(
      'search',
      '표시할 공고가 없습니다.',
      uncertain
        ? '현재 확인된 일정과 불러온 공고를 기준으로 검색했습니다.'
        : '다른 상태나 날짜, 검색어로 확인해 보세요.',
      '<button class="text-button" data-action="clear-filter">조건 초기화</button>',
    );
  return emptyState(
    uncertain ? 'circle-help' : 'calendar-check',
    uncertain ? '공고 현황을 확인하고 있습니다.' : '표시할 공고가 없습니다.',
    uncertain
      ? '수집 범위와 일정을 확인한 뒤 다시 조회하세요.'
      : '이 조회 범위에서 접수 중이거나 예정된 공고가 없습니다.',
  );
}

export function emptyState(symbol, title, message = '', extra = '') {
  return `<div class="empty-state">${icon(symbol)}<h3>${esc(title)}</h3>${message ? `<p>${esc(message)}</p>` : ''}${extra}</div>`;
}

export function calendar(state, records, large = false) {
  const yearMonth = state.month || (state.directory?.asOf ?? todayKst()).slice(0, 7);
  const [y, m] = yearMonth.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weeks = ['일', '월', '화', '수', '목', '금', '토'];
  const empty = () => '<span class="blank-day" aria-hidden="true"></span>';
  const cells = Array.from({ length: first }, empty);
  for (let d = 1; d <= total; d++) {
    const date = yearMonth + '-' + String(d).padStart(2, '0');
    const count = records.filter(({ notice }) => inRange(notice, date)).length;
    cells.push(
      `<button type="button" data-date="${date}" class="day${date === state.directory?.asOf ? ' current' : ''}${date === state.day ? ' active' : ''}${count ? ' has-events' : ''}" aria-label="${esc(longDate(date))}${count ? ', 확인한 접수 공고 ' + count + '건' : ''}" aria-pressed="${date === state.day}"${date === state.directory?.asOf ? ' aria-current="date"' : ''}>${d}${large && count ? `<small class="day-count">${count}건</small>` : ''}</button>`,
    );
  }
  while (cells.length % 7) cells.push(empty());
  return `<section class="calendar-card${large ? ' big-calendar' : ''}" aria-label="접수 달력"><div class="calendar-head"><strong>${y}년 ${m}월</strong><div class="inline"><button class="quiet-icon" data-month="-1" aria-label="이전 달">${icon('chevron-left')}</button><button class="quiet-icon" data-month="1" aria-label="다음 달">${icon('chevron-right')}</button></div></div>
    <div class="days">${weeks.map((day) => `<span class="weekday">${day}</span>`).join('')}${cells.join('')}</div>
    <div class="calendar-legend"><span class="event-key">확인된 접수일</span><button type="button" class="text-button" data-action="calendar-reset">기준일로 이동</button></div>
  </section>`;
}

function agenda(state, records) {
  const asOf = state.directory?.asOf;
  const upcoming = records
    .flatMap(({ notice, index }) =>
      rangesFor(notice).flatMap((range) => {
        const entries = [];
        if (range.start > asOf)
          entries.push({ index, title: noticeName(notice), date: range.start, label: '접수 시작' });
        if (range.end >= asOf)
          entries.push({ index, title: noticeName(notice), date: range.end, label: '접수 마감' });
        return entries;
      }),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.index - b.index)
    .slice(0, 3);
  return `<section class="panel"><div class="aside-head"><h2>${icon('calendar-clock')}다가오는 일정</h2></div>
    ${upcoming.length ? `<div class="agenda-list">${upcoming.map((x) => `<button type="button" class="agenda-item" data-notice="${x.index}"><span class="date-tile">${Number(x.date.slice(5, 7))}월<b>${Number(x.date.slice(-2))}</b></span><span class="agenda-copy"><strong>${esc(x.title)}</strong><small>${esc(x.label)}</small></span>${icon('chevron-right')}</button>`).join('')}</div>` : '<p class="small muted">확인된 접수 일정이 없습니다.</p>'}
  </section>`;
}

export function directoryPanels(state) {
  const d = state.directory,
    records = selectedNotices(state);
  return {
    results: `${state.view === 'calendar' && d ? calendar(state, records, true) : ''}
    ${state.day ? `<div class="day-selection"><strong>${esc(dateText(state.day))} 접수 일정</strong> <button type="button" class="text-button" data-action="clear-date">날짜 해제 ${icon('x')}</button></div>` : state.view === 'calendar' && d ? '<p class="calendar-caption">날짜를 선택하면 해당일의 접수 공고를 모아 볼 수 있습니다.</p>' : ''}
    ${listHTML(state, records)}`,
    summary: `${d && state.view !== 'calendar' ? calendar(state, records) : ''}${d ? agenda(state, records) : ''}`,
  };
}

export function directoryView(state) {
  const { directory: d } = state;
  const panels = directoryPanels(state);
  const filters = [
    ['all', '전체'],
    ['open', '접수 중'],
    ['upcoming', '접수 예정'],
    ['unknown', '확인 필요'],
  ];
  if (state.includeClosed) filters.push(['closed', '접수 종료']);
  const viewSelector = `<div class="segmented" role="group" data-choice-group aria-label="보기 방식">${[
    ['cards', 'layout-grid', '카드'],
    ['calendar', 'calendar-days', '달력'],
  ]
    .map(
      ([key, symbol, label]) =>
        `<button type="button" data-view="${key}" aria-label="${label} 보기" aria-pressed="${key === state.view}" tabindex="${key === state.view ? 0 : -1}">${icon(symbol)}<span>${label}</span></button>`,
    )
    .join('')}</div>`;
  const coverageIssue = d?.scopeIssues?.length || (d && d.coverage?.status !== 'complete');
  return `${hero(state)}<div class="columns"><section class="main-column" aria-labelledby="listing-title"><div class="section-top"><h2 id="listing-title">공고 목록${d ? `<small>${esc(d.counts?.listed ?? '—')}건</small>` : ''}</h2>${viewSelector}</div>
    <div class="toolbar"><div class="filter-row" role="group" data-choice-group aria-label="접수 상태">${filters.map(([key, label]) => `<button class="filter" data-filter="${key}" aria-pressed="${state.filter === key}" tabindex="${state.filter === key ? 0 : -1}">${label}</button>`).join('')}</div></div>
    <div class="utility-row"><label class="search-box">${icon('search')}<span class="sr-only">공고명, 지역 또는 공고번호 검색</span><input id="notice-search" type="search" placeholder="공고명, 지역 또는 공고번호" value="${esc(state.query)}" autocomplete="off"></label><label class="check-field"><input id="include-closed" type="checkbox"${state.includeClosed ? ' checked' : ''}>종료 공고 포함</label></div>
    ${state.dirError && d ? `<div class="scope-note">${icon('triangle-alert')}<div>목록 일부를 불러오지 못했습니다. ${esc(errorText(state.dirError))} <button type="button" class="text-button" data-action="reload">다시 조회</button></div></div>` : ''}
    ${d && state.directoryLoading && state.session ? `<p class="loading-more" role="status">공고 ${d.notices.length}건을 읽었습니다. 다음 목록을 불러오는 중입니다.</p>` : ''}
    ${coverageIssue ? `<div class="scope-note">${icon('circle-help')}<span>관측일 또는 수집 범위를 확인 중입니다. 현재 건수는 일부 공고만 포함할 수 있습니다.</span></div>` : ''}
    <div id="directory-results">${panels.results}</div>
    ${d ? `<div class="directory-foot">${sourceChip(d.dataOrigin === 'synthetic')}<span>모집공고일 ${esc(rangeLabel(d.publicationWindow, false))} · 한국시간 기준</span></div>` : ''}
  </section><aside id="directory-summary" class="side-stack" aria-label="일정 요약">${panels.summary}</aside></div>`;
}

export function homeView(state, history) {
  return `${hero(state, true)}<section class="home-links" aria-label="워크스페이스 바로가기"><a class="panel home-link" href="#search">${icon('sliders-horizontal')}<strong>맞춤 공고 찾기</strong><span>지역과 예산에 맞는 호실을 찾습니다.</span>${icon('arrow-right')}</a><a class="panel home-link" href="#analyses">${icon('folder-open')}<strong>내 분석 이어보기</strong><span>저장한 공고의 가격과 근거를 다시 확인합니다.</span>${icon('arrow-right')}</a></section><section class="full-section"><div class="section-top"><h2>${state.session ? '최근 분석' : '예시 분석'}</h2><a class="text-button" href="#analyses">전체 보기 ${icon('arrow-right')}</a></div>${history}</section>`;
}
