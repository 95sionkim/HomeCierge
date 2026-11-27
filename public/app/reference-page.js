import { readSnapshotReference } from './client.js';
import { badge, dateText, errorText, esc, icon, isoDate } from './display.js';

const lawBase = 'https://www.law.go.kr/LSW/';
const newsSource = 'https://www.ncloud.com/product/applicationService/NAVERAPIHUB';
const clock = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const holds = {
  notice_date_unverified: [
    '모집공고일 확인 필요',
    '공고일이 확인되면 그날 시행 중이던 법령을 찾을 수 있습니다.',
  ],
  version_unverified: [
    '당시 시행본 확인 필요',
    '공식 개정 이력에서 모집공고일에 시행 중이던 판본을 확인하세요.',
  ],
  selection_unverified: ['공고 회차 확인 필요', '이 수집본이 선택한 공고와 같은 회차인지 확인해야 합니다.'],
  region_unverified: [
    '공고 소재지 확인 필요',
    '공고의 주소에서 시·군·구를 확인한 뒤 지역 뉴스를 조회할 수 있습니다.',
  ],
  source_restricted: ['출처 표시 보류', '이 자료를 표시할 수 있는 이용 조건을 확인 중입니다.'],
  synthetic_input: ['실제 공고 선택 필요', '합성 수집본입니다. 내 분석에서 실제 공고를 선택해 확인하세요.'],
  not_configured: ['뉴스 연결 준비 중', '뉴스 제공자 연결이 준비되면 여기서 조회할 수 있습니다.'],
  provider_unavailable: ['뉴스 조회 실패', '제공자의 응답을 확인하지 못했습니다. 잠시 후 다시 조회하세요.'],
  rate_limited: ['뉴스 조회 한도 도달', '제공자의 이용 한도에 도달했습니다. 잠시 후 다시 조회하세요.'],
};

function stamp(value) {
  const instant = Date.parse(value);
  return Number.isFinite(instant)
    ? `<time datetime="${esc(value)}">${esc(clock.format(instant))} KST</time>`
    : '미확인';
}
function day(value) {
  return isoDate(value) ? `<time datetime="${esc(value)}">${esc(dateText(value))}</time>` : '미확인';
}
function link(url, label, style = 'ref-link') {
  return `<a class="${style}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ${icon('external-link')}</a>`;
}
function noticeState(symbol, heading, body) {
  return `<div class="ref-state" role="status">${icon(symbol)}<div><strong>${esc(heading)}</strong>${body ? `<p>${esc(body)}</p>` : ''}</div></div>`;
}
function historyFor(id) {
  return (
    lawBase + 'lsRvsDocListP.do?' + new URLSearchParams({ lsId: id, lsRvsGubun: 'all', chrClsCd: '010202' })
  );
}
function originalLink(item) {
  try {
    const url = new URL(item.originalUrl);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.hostname === item.originalHost
    );
  } catch {
    return false;
  }
}

// 공개 링크·전체 목록을 묶어서 검사해 잘못 연결된 판본이나 일부 기사만 표시하지 않도록 한다.
function validResponse(data, ctx) {
  if (!data || data.analysisId !== ctx.analysisId || data.snapshotId !== ctx.snapshotId) return false;
  if (ctx.section === 'law') {
    if (
      data.contractVersion !== 'legal-evidence/v1' ||
      !['collected', 'synthetic'].includes(data.dataOrigin) ||
      data.personalEligibility !== 'not_assessed' ||
      data.transitionalProvisions !== 'requires_review' ||
      data.exceptions !== 'requires_review' ||
      (data.noticeDate !== null && !isoDate(data.noticeDate))
    )
      return false;
    if (data.status !== 'available') {
      return (
        [
          'notice_date_unverified',
          'version_unverified',
          'selection_unverified',
          'source_restricted',
          'synthetic_input',
        ].includes(data.status) &&
        data.reference === null &&
        (data.status === 'version_unverified'
          ? data.historyUrl === historyFor('008243') && !!data.noticeDate
          : data.historyUrl === null)
      );
    }
    const r = data.reference;
    return (
      data.dataOrigin === 'collected' &&
      !!data.noticeDate &&
      r &&
      /^[0-9]{1,20}$/.test(r.mst) &&
      /^[0-9]{1,20}$/.test(r.lawId) &&
      isoDate(r.effectiveOn) &&
      r.effectiveOn <= data.noticeDate &&
      r.sourceUrl ===
        lawBase +
          'lsInfoP.do?' +
          new URLSearchParams({ lsiSeq: r.mst, efYd: r.effectiveOn.replaceAll('-', '') }) &&
      data.historyUrl === historyFor(r.lawId) &&
      Array.isArray(r.articles) &&
      r.articles.length > 0 &&
      r.articles.every((a) => typeof a?.label === 'string' && typeof a.heading === 'string')
    );
  }
  if (data.contractVersion !== 'regional-news/v1') return false;
  const s = data.search;
  if (!s)
    return (
      s === null &&
      ['source_restricted', 'region_unverified', 'selection_unverified', 'synthetic_input'].includes(
        data.status,
      )
    );
  if (
    s.source?.url !== newsSource ||
    s.source?.provider !== 'naver_api_hub' ||
    s.textFormat !== 'plain_text' ||
    s.geographicRelevance !== 'unverified' ||
    s.factVerification !== 'unverified' ||
    typeof s.conditions?.region !== 'string' ||
    s.conditions.query !== s.conditions.region + ' 분양' ||
    s.conditions.sort !== 'date' ||
    s.conditions.display !== 3 ||
    !Array.isArray(s.items)
  )
    return false;
  if (data.status === 'available')
    return (
      s.omittedCount === 0 &&
      s.items.length > 0 &&
      s.items.length <= s.conditions.display &&
      Number.isFinite(Date.parse(s.queriedAt)) &&
      s.items.every(
        (i) =>
          typeof i?.title === 'string' &&
          typeof i.snippet === 'string' &&
          Number.isFinite(Date.parse(i.publishedAt)) &&
          originalLink(i),
      )
    );
  return (
    s.items.length === 0 &&
    (data.status === 'partial'
      ? Number.isInteger(s.omittedCount) && s.omittedCount > 0 && s.omittedCount <= s.conditions.display
      : ['empty', 'not_configured', 'provider_unavailable', 'rate_limited'].includes(data.status) &&
        s.omittedCount === 0)
  );
}
function reviewSteps(remainder) {
  const steps = [
    ['공고 조건', '공고문에서 공급 유형과 신청 조건을 확인하세요.'],
    ['부칙·경과규정', '최초 모집공고일이나 이전 규정을 따르는 조건이 있는지 원문을 확인하세요.'],
    ['개인별 자격과 예외', '세대 구성, 주택 소유 등 본인에게 해당하는 조건은 별도 확인이 필요합니다.'],
  ];
  if (remainder) steps.push(['최초·재공급 공고', '두 공고의 적용 조건과 변경 사항을 함께 확인하세요.']);
  return `<aside class="panel ref-review"><h2>${icon('shield-check')} 적용 전 확인할 사항</h2><dl>${steps.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></aside>`;
}
function lawView(data, demo) {
  if (data.status !== 'available') {
    const [title, body] = holds[data.status];
    return `<section class="panel ref-held">${noticeState('circle-pause', title, body)}
      ${data.noticeDate ? `<p class="ref-meta">모집공고일 ${day(data.noticeDate)}</p>` : ''}
      ${data.historyUrl ? link(data.historyUrl, '법령 개정 이력 열기') : ''}</section>`;
  }
  const r = data.reference;
  return `<div class="ref-law-grid"><div class="ref-law-main"><section class="ref-version">
    <div class="ref-section-line">${badge(demo ? 'closed' : 'verified', demo ? 'layers' : 'circle-check', demo ? '판본 표시 예시' : '시행본 확인')}
      <span>${esc(demo ? '합성 자료' : r.sourceName)}</span></div><h2>${esc(r.title)}</h2>
    <dl class="ref-dates"><div><dt>모집공고일</dt><dd>${day(data.noticeDate)}</dd></div><div><dt>법령 시행일</dt><dd>${day(r.effectiveOn)}</dd></div></dl>
    <div class="ref-meta">공포일 ${day(r.promulgatedOn)}<span>법령일련번호 <b class="code">${esc(r.mst)}</b></span></div>
    ${demo ? '' : `<div class="ref-links">${link(r.sourceUrl, '당시 시행본 원문', 'action primary')}${link(data.historyUrl, '개정 이력')}</div>`}
    </section><section class="panel ref-articles"><h2>확인할 조문 <span>${r.articles.length}개</span></h2>
    <ul>${r.articles.map((a) => `<li><strong>${esc(a.label)}</strong><span>${esc(a.heading)}</span></li>`).join('')}</ul>
    <p class="ref-meta">법령 조회 ${stamp(r.observedAt)}</p></section></div>${reviewSteps(data.noticeSource === 'applyhome_remainder')}</div>`;
}
function newsConditions(s, demo) {
  return `<div class="ref-query"><dl><div><dt>검색어</dt><dd>${esc(s.conditions.query)}</dd></div>
    <div><dt>검색 조건</dt><dd>최신순 · 최대 ${s.conditions.display}건</dd></div>
    ${s.queriedAt ? `<div><dt>조회 시각</dt><dd>${stamp(s.queriedAt)}</dd></div>` : ''}</dl>
    ${demo ? '<span class="ref-meta">합성 검색 예시</span>' : link(s.source.url, s.source.name)}</div>`;
}
function newsView(data, demo) {
  const s = data.search;
  let content;
  if (data.status === 'available') {
    content = `<ol class="ref-news-list">${s.items
      .map(
        (i) => `<li><article>
      <h3>${demo ? esc(i.title) : link(i.originalUrl, i.title, 'ref-headline')}</h3>
      <p><span class="ref-excerpt">검색 발췌</span> ${esc(i.snippet)}</p>
      <div class="ref-item-meta"><span>원문 도메인 <b>${esc(i.originalHost)}</b></span><span>제공 시각 ${stamp(i.publishedAt)}</span></div>
      </article></li>`,
      )
      .join('')}</ol>`;
  } else if (data.status === 'empty')
    content = noticeState('circle-minus', '검색 결과 0건', '이 검색어로 제공된 기사가 없습니다.');
  else if (data.status === 'partial')
    content = noticeState(
      'circle-pause',
      '검색 결과 일부 누락',
      `${s.omittedCount}건을 확인하지 못해 이번 기사 목록은 보류했습니다.`,
    );
  else {
    const [title, body] = holds[data.status];
    content = noticeState(
      ['rate_limited', 'provider_unavailable'].includes(data.status) ? 'triangle-alert' : 'circle-pause',
      title,
      body,
    );
  }
  return `${s ? newsConditions(s, demo) : ''}<section class="panel ref-news" aria-label="지역 뉴스 검색 결과">${content}</section>
    ${data.status === 'available' ? '<p class="ref-note">' + icon('info') + '기사의 지역 관련성과 사실 여부는 원문에서 확인하세요.</p>' : ''}
    ${s && !demo ? '<p class="ref-credit">네이버™는 NAVER®의 등록상표입니다.</p>' : ''}`;
}

export function createReferencePage({ root, render }) {
  let context = null,
    request = null,
    data = null,
    error = null;
  function reset() {
    request?.abort();
    context = request = data = error = null;
  }
  async function load() {
    if (!context || request || document.hidden) return;
    const ctx = context,
      controller = new AbortController();
    request = controller;
    data = error = null;
    render();
    try {
      let value;
      if (ctx.guest) {
        if (ctx.saved) {
          const examples = await import('./reference-examples.js');
          value = ctx.section === 'law' ? examples.lawExample : examples.newsExample;
        } else value = { status: 'synthetic_input', search: null };
      } else {
        value = await readSnapshotReference(ctx.section, ctx.analysisId, ctx.snapshotId, controller.signal);
        if (!validResponse(value, ctx)) throw new Error('invalid reference');
      }
      if (request === controller) data = value;
    } catch (err) {
      if (request === controller) error = err;
    } finally {
      if (request === controller) {
        request = null;
        render();
      }
    }
  }
  function enter(ctx) {
    reset();
    context = ctx;
    if (ctx.section === 'law') void load();
  }
  function view() {
    if (!context) return '';
    const { section, guest, saved, name } = context,
      law = section === 'law',
      demo = guest && saved;
    const title = law ? '공고일 기준 법령' : '지역 뉴스';
    const desc = demo
      ? law
        ? '날짜와 조문 제목은 화면을 살펴보기 위한 합성 예시입니다.'
        : '가상의 지역과 기사로 검색 결과를 살펴보세요.'
      : law
        ? '모집공고일에 시행된 규칙과 확인할 조문을 살펴보세요.'
        : '공고 소재지의 시·군·구와 ‘분양’으로 검색해 최신 기사 최대 3건을 보여줍니다.';
    let content;
    if (request)
      content = noticeState(
        'loader-circle',
        law ? '공고일의 법령을 확인하고 있습니다.' : '뉴스를 조회하고 있습니다.',
        '',
      );
    else if (error)
      content = noticeState('triangle-alert', law ? '법령 조회 실패' : '뉴스 조회 실패', errorText(error));
    else if (data) content = law ? lawView(data, demo) : newsView(data, demo);
    else content = '';
    const action = request
      ? '조회 중'
      : law
        ? '다시 확인'
        : data || error
          ? '다시 조회'
          : demo
            ? '예시 기사 보기'
            : '지역 뉴스 보기';
    const symbol = request ? 'loader-circle' : law || data || error ? 'refresh-cw' : 'search';
    return `<section class="section-header ref-heading"><div><h1>${title}</h1>${name ? `<p>${esc(name)}</p>` : ''}</div></section>
      <div class="ref-intro"><p>${desc}</p><button type="button" id="ref-query-action" class="action ${law || data ? 'secondary compact' : 'primary'}"${request ? ' aria-disabled="true"' : ''}>${icon(symbol)}${action}</button></div>
      ${data?.status === 'available' ? `<p class="sr-only" role="status">${law ? '법령 판본을 표시했습니다.' : data.search.items.length + '건의 검색 결과를 표시했습니다.'}</p>` : ''}${content}`;
  }
  root.addEventListener('click', (e) => {
    if (e.target.closest('#ref-query-action')) void load();
  });
  return { reset, enter, view };
}
