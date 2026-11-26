import * as api from './client.js';
import {
  esc,
  icon,
  badge,
  scheduleBadge,
  runBadge,
  runLabels,
  publicationText,
  rangesFor,
  rangeLabel,
  dateText,
  errorText,
} from './display.js';

const lookupKinds = {
  new_sale: '신규분양',
  unranked: '무순위',
  remaining: '잔여세대',
  resupply: '재공급',
  unknown: '유형 확인 필요',
};

const analysisStatusLabels = {
  draft: '초안',
  input_ready: '분석 완료',
  queued: '분석 대기',
  running: '분석 중',
  retry_wait: '다시 시도 대기',
  partial: '부분 결과',
  completed: '분석 완료',
  finished: '분석 완료',
  failed: '분석 실패',
  cancelled: '분석 취소',
};

const sourceLabels = {
  applyhome_apt: '청약홈 아파트 공고',
  applyhome_remainder: '청약홈 잔여세대·무순위 공고',
};

const coverageLabels = {
  complete: '수집 완료',
  empty: '정상 0건',
  partial: '부분 수집',
  failed: '조회 실패',
};

const kstStamp = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const kstTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatStamp(value, short = false) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  return (short ? kstTime : kstStamp).format(ms);
}

function noticeKey(notice) {
  return `${notice.houseManageNo}:${notice.noticeNo}`;
}

function analysisStatusBadge(analysis) {
  if (analysis.latestRunStatus) return runBadge(analysis.latestRunStatus);
  const label = analysisStatusLabels[analysis.status] ?? runLabels[analysis.status] ?? '상태 확인 필요';
  const style = {
    completed: 'verified',
    input_ready: 'verified',
    partial: 'partial',
    failed: 'failed',
    cancelled: 'zero',
    running: 'upcoming',
    queued: 'upcoming',
  }[analysis.status] ?? 'unknown';
  const symbol = {
    completed: 'circle-check',
    input_ready: 'circle-check',
    partial: 'chart-pie',
    failed: 'triangle-alert',
    cancelled: 'circle-minus',
    running: 'loader-circle',
    queued: 'clock-3',
  }[analysis.status] ?? 'circle-help';
  return badge(style, symbol, label);
}

function loginGateView(mode) {
  const heading = mode === 'lookup' ? '로그인한 뒤 공고 찾기를 이용할 수 있습니다.' : '로그인한 뒤 채팅을 열 수 있습니다.';
  return `<div class="chat-gate-wrap">
    <div class="empty-state chat-gate-card">
      ${icon('shield-check')}
      <h1>${esc(heading)}</h1>
      <p>비로그인 상태에서는 공고 탐색과 채팅·분석을 실행하지 않습니다. 로그인하면 이 계정의 채팅과 분석 결과를 기기 간에 복원합니다.</p>
      <div class="chat-empty-actions">
        <button type="button" class="action primary" data-action="auth">${icon('log-in')}로그인</button>
        <a class="action secondary" href="#home">채팅 홈으로</a>
        <a class="action secondary" href="#notices">오늘의 청약 예시</a>
      </div>
    </div>
  </div>`;
}

function lookupScopeBanner(lookup) {
  const windowLabel = rangeLabel(lookup.publicationWindow, false);
  const observedLabel = formatStamp(lookup.observedAt);
  const sources = (lookup.coverage?.sources ?? [])
    .map((src) => `${sourceLabels[src.source] ?? src.source} · ${coverageLabels[src.status] ?? '확인 필요'}`)
    .join(' / ');
  const incomplete = lookup.scopeIssues?.length || lookup.coverage?.status !== 'complete';
  return `<div class="lookup-scope-box" aria-label="조회 범위와 관측 시각">
    <div class="lookup-scope-meta">
      <span>${icon('database')}모집공고일 범위 <strong>${esc(windowLabel)}</strong></span>
      <span>관측 시각 <strong>${esc(observedLabel)} KST</strong></span>
    </div>
    ${sources ? `<p class="small muted">${esc(sources)}</p>` : ''}
    <p class="lookup-scope-limit">${esc(lookup.outOfScopeNotice)}</p>
    ${incomplete ? `<p class="hold-note">${icon('circle-help')}관측일 또는 수집 범위를 확인 중입니다. 누락된 회차가 있을 수 있어 0건으로 단정하지 않습니다.</p>` : ''}
  </div>`;
}

function lookupCardMarkup(notice, selectedKey) {
  const key = noticeKey(notice);
  const checked = key === selectedKey;
  const ranges = rangesFor(notice);
  const scheduleSummary = ranges.length ? ranges.map((r) => rangeLabel(r, false)).join(', ') : '접수일 미확인';
  const verifiedModels = (notice.models ?? []).filter((m) => m.analysisInput && !m.selectionBlockers?.length).length;
  const modelNote = !notice.models?.length
    ? '주택형 확인 필요'
    : verifiedModels === notice.models.length
      ? `주택형 ${notice.models.length}개 확인`
      : `주택형 ${notice.models.length}개 (선택 가능 ${verifiedModels}개)`;
  return `<label class="lookup-edition-card${checked ? ' selected' : ''}">
    <input type="radio" name="lookup-edition" value="${esc(key)}"${checked ? ' checked' : ''}>
    <span class="lookup-edition-body">
      <span class="lookup-edition-head">
        <strong>${esc(notice.title || `공고 ${notice.noticeNo}`)}</strong>
        <span class="lookup-edition-badges">
          ${scheduleBadge(notice.applicationStatus)}
          <span class="lookup-kind-pill">${esc(lookupKinds[notice.kind] ?? '유형 확인 필요')}</span>
        </span>
      </span>
      <span class="lookup-edition-ids">
        <span>공고일 <strong>${esc(publicationText(notice))}</strong></span>
        <span>공고번호 <span class="code">${esc(notice.noticeNo)}</span></span>
        <span>주택관리번호 <span class="code">${esc(notice.houseManageNo)}</span></span>
      </span>
      <span class="lookup-edition-meta">
        <span>${icon('map-pin')}${esc(notice.regionName ?? '지역 미확인')}</span>
        <span>${icon('calendar-days')}${esc(scheduleSummary)}</span>
        <span>${esc(modelNote)}</span>
      </span>
      ${
        notice.sameTitleCount > 1
          ? '<span class="lookup-edition-warn">같은 이름의 다른 회차 공고입니다. 공고일·공고번호·주택관리번호를 확인해 구분하세요.</span>'
          : ''
      }
    </span>
  </label>`;
}

function lookupPanelMarkup(s, inChat) {
  const modeOptions = [
    ['auto', '자동 판별'],
    ['name', '공고명'],
    ['number', '공고번호'],
  ];
  const placeholder =
    s.lookupMode === 'number'
      ? '청약홈 공고번호(최대 10자리 숫자)를 입력하세요.'
      : s.lookupMode === 'name'
        ? '공고명이나 단지명 일부를 입력하세요.'
        : '공고명 또는 공고번호를 입력하세요.';
  const selected = s.lookup?.notices?.find((n) => noticeKey(n) === s.selectedKey) ?? null;
  const pubLabel = selected ? publicationText(selected) : null;
  const ctaLabel = selected
    ? `${pubLabel && pubLabel !== '미확인' ? pubLabel + ' ' : ''}공고 주택형 선택`
    : '공고를 먼저 선택하세요';

  let resultsBody = '';
  if (s.lookupLoading) {
    resultsBody = `<div class="empty-state compact-empty">${icon('loader-circle')}<h3>공유 색인에서 공고를 찾고 있습니다.</h3></div>`;
  } else if (s.lookupError) {
    resultsBody = `<div class="empty-state compact-empty">${icon('triangle-alert')}<h3>공고를 조회하지 못했습니다.</h3><p>${esc(errorText(s.lookupError))}</p><button type="button" class="action secondary compact" data-chat-view="retry-lookup">다시 찾기</button></div>`;
  } else if (s.lookup) {
    const notices = s.lookup.notices ?? [];
    if (!notices.length) {
      const windowLabel = rangeLabel(s.lookup.publicationWindow, false);
      const observedLabel = formatStamp(s.lookup.observedAt);
      // 부분 수집·조회 불가 색인의 0건은 정상 0건으로 표시하지 않는다.
      resultsBody =
        s.lookup.coverage?.status === 'complete'
          ? `${lookupScopeBanner(s.lookup)}
        <div class="empty-state compact-empty">
          ${icon('search')}
          <h3>조회 범위 안에서 일치하는 공고를 찾지 못했습니다.</h3>
          <p>모집공고일 ${esc(windowLabel)} (관측 시각 ${esc(observedLabel)} KST) 기준 공유 색인에 해당하는 회차가 없습니다. 이 기간 밖의 회차는 조회 범위 밖입니다.</p>
        </div>`
          : `${lookupScopeBanner(s.lookup)}
        <div class="empty-state compact-empty" data-lookup-hold="coverage">
          ${icon('circle-help')}
          <h3>수집이 완전하지 않아 0건으로 확정하지 않습니다.</h3>
          <p>모집공고일 ${esc(windowLabel)} (관측 시각 ${esc(observedLabel)} KST) 공유 색인의 공고 수집이 완전하지 않습니다. 누락된 회차가 있을 수 있으니 수집 상태를 확인한 뒤 다시 찾아 주세요.</p>
        </div>`;
    } else {
      const truncated = s.lookup.counts.matched > s.lookup.counts.returned;
      resultsBody = `${lookupScopeBanner(s.lookup)}
        <div class="lookup-results-head">
          <h3>검색 결과 <small>${esc(s.lookup.counts.matched)}건${truncated ? ` (상위 ${s.lookup.counts.returned}건 표시)` : ''}</small></h3>
          ${s.lookup.counts.sameTitleGroups > 0 ? badge('partial', 'info', '같은 이름 회차 구분') : ''}
        </div>
        ${
          s.lookup.counts.sameTitleGroups > 0
            ? '<p class="lookup-dup-banner" role="note">같은 이름의 공고가 여러 회차 존재합니다. 이름만 같은 다른 회차를 합치지 않았으므로 공고일·공고번호·주택관리번호를 확인해 고르세요.</p>'
            : ''
        }
        <div class="lookup-radio-list" role="radiogroup" aria-label="검토할 공고 회차">
          ${notices.map((n) => lookupCardMarkup(n, s.selectedKey)).join('')}
        </div>
        <div class="lookup-actions-bar">
          <button type="button" class="action primary" data-chat-view="select-edition"${selected ? '' : ' disabled'}>${esc(ctaLabel)} ${icon('arrow-right')}</button>
          ${
            !inChat
              ? `<button type="button" class="action secondary" data-chat-view="open-in-new-chat"${s.creatingChat ? ' disabled' : ''}>${icon('message-square')}${s.creatingChat ? '채팅 생성 중' : '새 채팅에 기록하고 이어가기'}</button>`
              : ''
          }
        </div>`;
    }
  } else {
    resultsBody = `<div class="empty-state compact-empty">
      ${icon('search')}
      <h3>검토할 공고를 찾아 보세요.</h3>
      <p>공고명이나 공고번호를 입력하면 같은 이름의 회차를 공고일·공고번호·주택관리번호·유형·접수 상태로 구분해 보여줍니다.</p>
    </div>`;
  }

  return `<section class="lookup-panel" aria-labelledby="lookup-heading">
    <div class="lookup-panel-head">
      <h2 id="lookup-heading">공고 찾기</h2>
      <p class="small muted">회차를 하나 고르면 주택형 선택(S-03)과 분석 시작으로 이어집니다.</p>
    </div>
    <form id="notice-lookup-form" class="lookup-form" novalidate>
      <div class="lookup-mode-row" role="group" aria-label="찾기 기준">
        ${modeOptions
          .map(
            ([value, label]) =>
              `<button type="button" class="filter" data-lookup-mode="${value}" aria-pressed="${s.lookupMode === value}">${label}</button>`,
          )
          .join('')}
      </div>
      <div class="lookup-input-row">
        <label class="sr-only" for="lookup-query">공고명 또는 공고번호</label>
        <input id="lookup-query" name="q" type="search" maxlength="120" value="${esc(s.lookupQuery)}" placeholder="${esc(placeholder)}" autocomplete="off">
        <button type="submit" class="action primary compact" ${s.lookupLoading ? 'disabled' : ''}>${icon('search')}${s.lookupLoading ? '찾는 중' : '찾기'}</button>
      </div>
      ${s.lookupFormError ? `<p class="plan-error" role="alert">${esc(s.lookupFormError)}</p>` : ''}
    </form>
    ${resultsBody}
    <div class="lookup-pdf-note" role="note">
      ${icon('file-text')}
      <span><strong>PDF 보완 안내:</strong> 공고를 먼저 고른 뒤 분석 화면에서 PDF로 보완할 수 있습니다.</span>
    </div>
  </section>`;
}

function mergedTimeline(messages, analyses) {
  const items = [];
  messages.forEach((m, index) => {
    const ms = Date.parse(m.createdAt);
    items.push({ kind: 'message', sortMs: Number.isFinite(ms) ? ms : 0, tie: 0, order: index, data: m });
  });
  analyses.forEach((a, index) => {
    const ms = Date.parse(a.createdAt);
    items.push({ kind: 'analysis', sortMs: Number.isFinite(ms) ? ms : 0, tie: 1, order: index, data: a });
  });
  items.sort((left, right) => left.sortMs - right.sortMs || left.tie - right.tie || left.order - right.order);
  return items;
}

function renderMultiline(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => `<p>${esc(line)}</p>`)
    .join('');
}

function timelineItemMarkup(item) {
  if (item.kind === 'message') {
    const m = item.data;
    const isUser = m.role === 'user';
    return `<article class="chat-bubble ${isUser ? 'chat-bubble-user' : 'chat-bubble-assistant'}">
      <header class="chat-bubble-meta">
        <strong>${isUser ? '나' : 'HomeCierge'}</strong>
        <time datetime="${esc(m.createdAt)}">${esc(formatStamp(m.createdAt, true))}</time>
      </header>
      <div class="chat-bubble-body">${renderMultiline(m.content)}</div>
    </article>`;
  }
  const a = item.data;
  const runHref = a.latestRunId ? `#run/${esc(a.analysisId)}/${esc(a.latestRunId)}` : null;
  const details = [
    a.noticeNo ? `공고 ${a.noticeNo}` : null,
    a.edition ? `공고일 ${dateText(a.edition)}` : null,
    a.houseType ? `주택형 ${a.houseType}` : a.modelNo ? `모델 ${a.modelNo}` : null,
  ].filter(Boolean);
  return `<article class="chat-analysis-card" aria-label="연결된 분석">
    <div class="chat-analysis-top">
      <div>
        <span class="chat-analysis-eyebrow">${icon('building-2')}연결된 분석</span>
        <h3>${esc(a.title)}</h3>
      </div>
      ${analysisStatusBadge(a)}
    </div>
    ${details.length ? `<p class="chat-analysis-meta">${esc(details.join(' · '))}</p>` : ''}
    <div class="chat-analysis-foot">
      <time class="small muted" datetime="${esc(a.updatedAt)}">갱신 ${esc(formatStamp(a.updatedAt, true))}</time>
      ${
        runHref
          ? `<a class="action secondary compact" href="${runHref}">결과 열기 ${icon('arrow-right')}</a>`
          : '<span class="small muted">실행 접수 전</span>'
      }
    </div>
  </article>`;
}

function chatDetailMarkup(s) {
  // 세션 복원 직후 경로 진입 전에도 렌더될 수 있으므로 채팅이 없으면 불러오는 중으로 표시한다.
  if (!s.chat && !s.error) {
    return `<div class="empty-state">${icon('loader-circle')}<h3>채팅을 불러오는 중입니다.</h3></div>`;
  }
  if (s.error && !s.chat) {
    const isNotFound = s.error.code === 'chat_not_found' || s.error.code === 'invalid_chat_input';
    return `<div class="empty-state">
      ${icon(isNotFound ? 'circle-help' : 'triangle-alert')}
      <h1>${isNotFound ? '채팅을 찾을 수 없습니다.' : '채팅을 불러오지 못했습니다.'}</h1>
      <p>${esc(errorText(s.error))}</p>
      <div class="chat-empty-actions">
        <a class="action primary" href="#home">채팅 홈으로</a>
        ${!isNotFound ? '<button type="button" class="action secondary" data-chat-view="reload-chat">다시 조회</button>' : ''}
      </div>
    </div>`;
  }
  const chat = s.chat;
  const timeline = mergedTimeline(s.messages, s.analyses);
  return `<div class="chat-page-wrap">
    <header class="chat-detail-header">
      <div class="chat-header-main">
        <a class="text-button compact-back" href="#home">${icon('arrow-left')}채팅 홈</a>
        ${
          s.editingTitle
            ? `<form id="chat-rename-form" class="chat-rename-form" novalidate>
                <label class="sr-only" for="chat-title-input">채팅 제목</label>
                <input id="chat-title-input" name="title" type="text" maxlength="200" value="${esc(s.titleDraft)}" autocomplete="off" ${s.renaming ? 'disabled' : ''}>
                <button type="submit" class="action primary compact" ${s.renaming ? 'disabled' : ''}>${icon('check')}저장</button>
                <button type="button" class="action secondary compact" data-chat-view="cancel-rename" ${s.renaming ? 'disabled' : ''}>취소</button>
              </form>`
            : `<div class="chat-title-bar">
                <h1 id="page-heading">${esc(chat.title)}</h1>
                <button type="button" class="action secondary compact" data-chat-view="start-rename">제목 변경</button>
              </div>`
        }
        ${s.renameError ? `<p class="plan-error" role="alert">${esc(s.renameError)}</p>` : ''}
        <p class="chat-header-meta">
          <span>최근 활동 ${esc(formatStamp(chat.lastActivityAt))}</span>
          <span>연결된 분석 ${esc(s.analyses.length)}건</span>
          <span>메시지 ${esc(s.messages.length)}건</span>
        </p>
      </div>
    </header>

    <div class="chat-workspace-grid">
      <section class="chat-thread-panel" aria-label="대화 및 분석 시간순 기록">
        <div class="chat-timeline" id="chat-timeline">
          ${
            timeline.length
              ? timeline.map(timelineItemMarkup).join('')
              : `<div class="empty-state compact-empty">${icon('message-square')}<h3>대화를 시작해 보세요.</h3><p>아래 입력창에 공고명이나 10자리 공고번호를 입력하면 회차를 찾아 드립니다. 자유 질문에는 지원하는 기능을 안내합니다.</p></div>`
          }
        </div>
        <form id="chat-message-form" class="chat-composer-card compact-composer" novalidate>
          <label class="sr-only" for="chat-message-input">채팅 메시지 입력</label>
          <textarea id="chat-message-input" name="message" rows="2" maxlength="800" placeholder="공고명 또는 공고번호를 입력하세요. (Enter 전송, Shift+Enter 줄바꿈)" ${s.sendingMessage ? 'disabled' : ''}>${esc(s.messageDraft)}</textarea>
          ${s.messageError ? `<p class="plan-error" role="alert">${esc(s.messageError)}</p>` : ''}
          <div class="chat-composer-foot">
            <span class="small muted">규칙 기반 공고 찾기 · 자유 질문에는 지원 동작 안내</span>
            <button type="submit" class="action primary compact" ${s.sendingMessage ? 'disabled' : ''}>${icon('send')}${s.sendingMessage ? '전송 중' : '전송'}</button>
          </div>
        </form>
      </section>

      <aside class="chat-lookup-column" aria-label="공고 찾기 및 연결된 분석">
        ${lookupPanelMarkup(s, true)}
        ${
          s.analyses.length
            ? `<section class="chat-linked-panel" aria-labelledby="chat-linked-heading">
                <h2 id="chat-linked-heading">이 채팅의 분석 <small>${s.analyses.length}건</small></h2>
                <div class="chat-linked-list">
                  ${s.analyses
                    .map((a) => {
                      const href = a.latestRunId ? `#run/${esc(a.analysisId)}/${esc(a.latestRunId)}` : null;
                      return `<div class="chat-linked-row">
                        <div class="chat-linked-copy">
                          <strong>${esc(a.title)}</strong>
                          <small>${esc([a.noticeNo ? `공고 ${a.noticeNo}` : null, a.houseType || (a.modelNo ? `모델 ${a.modelNo}` : null)].filter(Boolean).join(' · ') || '상세 확인')}</small>
                        </div>
                        <div class="chat-linked-actions">
                          ${analysisStatusBadge(a)}
                          ${href ? `<a class="text-button" href="${href}">결과 ${icon('arrow-right')}</a>` : ''}
                        </div>
                      </div>`;
                    })
                    .join('')}
                </div>
              </section>`
            : ''
        }
      </aside>
    </div>
  </div>`;
}

function standaloneLookupMarkup(s) {
  return `<div class="chat-page-wrap">
    <header class="chat-detail-header">
      <div class="chat-header-main">
        <a class="text-button compact-back" href="#home">${icon('arrow-left')}채팅 홈</a>
        <h1 id="page-heading">공고 찾기</h1>
        <p class="chat-header-meta">공고명이나 공고번호로 같은 이름의 회차를 구분해 선택한 뒤 주택형 선택과 분석 시작으로 이어집니다.</p>
      </div>
    </header>
    <div class="standalone-lookup-wrap">
      ${lookupPanelMarkup(s, false)}
    </div>
  </div>`;
}

function initialState() {
  return {
    routeKind: 'chat',
    chatId: null,
    chat: null,
    messages: [],
    analyses: [],
    loading: false,
    error: null,
    editingTitle: false,
    titleDraft: '',
    renaming: false,
    renameError: '',
    messageDraft: '',
    sendingMessage: false,
    messageError: '',
    pendingMessageKey: null,
    lookupMode: 'auto',
    lookupQuery: '',
    lookupLoading: false,
    lookupError: null,
    lookupFormError: '',
    lookup: null,
    selectedKey: null,
    creatingChat: false,
    pendingNewChatKey: null,
    pendingNewMsgKey: null,
  };
}

export function createChatView({ root, render, announce, user, navigate, openAuth, openNoticeModels, onOpenChat, onChatsChanged }) {
  let s = initialState();
  let generation = 0;
  let detailController = null;
  let lookupController = null;

  function abortAll() {
    detailController?.abort();
    detailController = null;
    lookupController?.abort();
    lookupController = null;
  }

  function reset() {
    ++generation;
    abortAll();
    s = initialState();
  }

  function applyLookupResult(lookup, lookupError = null) {
    s.lookup = lookup ?? null;
    s.lookupError = lookupError ? (typeof lookupError === 'string' ? { code: lookupError } : lookupError) : null;
    if (lookup?.query) {
      s.lookupQuery = lookup.query.raw;
      s.lookupMode = lookup.query.mode;
    }
    const notices = lookup?.notices ?? [];
    if (!notices.length) {
      s.selectedKey = null;
    } else if (!notices.some((n) => noticeKey(n) === s.selectedKey)) {
      s.selectedKey = noticeKey(notices[0]);
    }
  }

  async function loadChatDetail(chatId) {
    const owner = user();
    if (!owner) return;
    const token = generation;
    const ownerId = owner.id;
    detailController?.abort();
    detailController = new AbortController();
    s.loading = true;
    s.error = null;
    render();
    try {
      const detail = await api.getChat(chatId, detailController.signal);
      if (token !== generation || user()?.id !== ownerId) return;
      s.chat = detail.chat;
      s.messages = detail.messages;
      s.analyses = detail.analyses;
      s.titleDraft = detail.chat.title;
    } catch (error) {
      if (error?.name === 'AbortError' || token !== generation || user()?.id !== ownerId) return;
      s.error = error;
    } finally {
      if (token === generation && user()?.id === ownerId) {
        s.loading = false;
        render();
      }
    }
  }

  async function runLookup(queryText, mode) {
    const owner = user();
    if (!owner) {
      openAuth();
      return;
    }
    const trimmed = String(queryText ?? '').trim();
    if (!trimmed) {
      s.lookupFormError = mode === 'number' ? '공고번호 숫자를 입력해 주세요.' : '공고명 또는 공고번호를 입력해 주세요.';
      render();
      return;
    }
    if (mode === 'number' && !/^[0-9]{1,10}$/.test(trimmed.replace(/[\s-]+/g, ''))) {
      s.lookupFormError = '공고번호는 최대 10자리 숫자로 입력해 주세요.';
      render();
      return;
    }
    const token = generation;
    const ownerId = owner.id;
    lookupController?.abort();
    lookupController = new AbortController();
    s.lookupFormError = '';
    s.lookupLoading = true;
    s.lookupError = null;
    render();
    try {
      const result = await api.lookupNotices({ q: trimmed, mode }, lookupController.signal);
      if (token !== generation || user()?.id !== ownerId) return;
      applyLookupResult(result, null);
      announce(
        result.counts.matched > 0
          ? `공고 ${result.counts.matched}건을 찾았습니다.`
          : '조회 범위 안에서 일치하는 공고를 찾지 못했습니다.',
      );
    } catch (error) {
      if (error?.name === 'AbortError' || token !== generation || user()?.id !== ownerId) return;
      s.lookup = null;
      s.selectedKey = null;
      s.lookupError = error;
    } finally {
      if (token === generation && user()?.id === ownerId) {
        s.lookupLoading = false;
        render();
      }
    }
  }

  async function submitRename() {
    const owner = user();
    if (!owner || !s.chat || s.renaming) return;
    const trimmed = s.titleDraft.trim();
    if (!trimmed || Array.from(trimmed).length > 200) {
      s.renameError = '채팅 제목은 1~200자 이내로 입력해 주세요.';
      render();
      return;
    }
    const token = generation;
    const ownerId = owner.id;
    s.renaming = true;
    s.renameError = '';
    render();
    try {
      const updated = await api.renameChat(s.chat.chatId, trimmed);
      if (token !== generation || user()?.id !== ownerId) return;
      s.chat = { ...s.chat, title: updated.chat.title, updatedAt: updated.chat.updatedAt, lastActivityAt: updated.chat.lastActivityAt };
      s.titleDraft = updated.chat.title;
      s.editingTitle = false;
      s.renaming = false;
      onChatsChanged?.();
      announce('채팅 제목을 변경했습니다.');
      render();
    } catch (error) {
      if (token !== generation || user()?.id !== ownerId) return;
      s.renaming = false;
      s.renameError = errorText(error);
      render();
    }
  }

  async function submitMessage() {
    const owner = user();
    if (!owner || !s.chat || s.sendingMessage) return;
    const text = s.messageDraft.trim();
    if (!text) {
      s.messageError = '공고명, 공고번호 또는 질문을 입력해 주세요.';
      render();
      return;
    }
    if (Array.from(text).length > 800) {
      s.messageError = '메시지는 800자 이내로 입력해 주세요.';
      render();
      return;
    }
    const token = generation;
    const ownerId = owner.id;
    s.sendingMessage = true;
    s.messageError = '';
    s.pendingMessageKey ??= crypto.randomUUID();
    render();
    try {
      const reply = await api.sendChatMessage(s.chat.chatId, {
        requestId: s.pendingMessageKey,
        message: text,
        mode: 'auto',
      });
      if (token !== generation || user()?.id !== ownerId) return;
      s.pendingMessageKey = null;
      s.messageDraft = '';
      s.sendingMessage = false;
      const appendUnique = (msg) => {
        if (msg && !s.messages.some((m) => m.id === msg.id)) s.messages.push(msg);
      };
      appendUnique(reply.userMessage);
      appendUnique(reply.assistantMessage);
      if (reply.assistantMessage?.createdAt) {
        s.chat = { ...s.chat, lastActivityAt: reply.assistantMessage.createdAt, messageCount: s.messages.length };
      }
      if (reply.action === 'lookup') {
        applyLookupResult(reply.lookup, reply.lookupError);
      }
      onChatsChanged?.();
      announce('응답을 기록했습니다.');
      render();
    } catch (error) {
      if (token !== generation || user()?.id !== ownerId) return;
      s.sendingMessage = false;
      if (error?.code !== 'backend_unavailable') s.pendingMessageKey = null;
      s.messageError = errorText(error);
      render();
    }
  }

  async function openLookupInNewChat() {
    const owner = user();
    if (!owner || !s.lookup || s.creatingChat) return;
    const token = generation;
    const ownerId = owner.id;
    s.creatingChat = true;
    s.pendingNewChatKey ??= crypto.randomUUID();
    s.pendingNewMsgKey ??= crypto.randomUUID();
    render();
    try {
      const q = s.lookup.query.raw;
      const mode = s.lookup.query.mode;
      const created = await api.createChat({
        requestId: s.pendingNewChatKey,
        title: Array.from(q).slice(0, 60).join('') || '새 채팅',
      });
      if (token !== generation || user()?.id !== ownerId) return;
      const reply = await api.sendChatMessage(created.chat.chatId, {
        requestId: s.pendingNewMsgKey,
        message: q,
        mode,
      });
      if (token !== generation || user()?.id !== ownerId) return;
      const handoffLookup = reply.lookup ?? s.lookup;
      const handoffError = reply.lookupError ?? null;
      s.pendingNewChatKey = null;
      s.pendingNewMsgKey = null;
      s.creatingChat = false;
      onChatsChanged?.();
      onOpenChat?.(created.chat.chatId, { lookup: handoffLookup, lookupError: handoffError });
      navigate('#chat/' + created.chat.chatId);
    } catch (error) {
      if (token !== generation || user()?.id !== ownerId) return;
      s.creatingChat = false;
      if (error?.code !== 'backend_unavailable') {
        s.pendingNewChatKey = null;
        s.pendingNewMsgKey = null;
      }
      s.lookupFormError = errorText(error);
      render();
    }
  }

  function enter({ kind, chatId = null, mode = 'auto', invalid = false, initialLookup = null }) {
    ++generation;
    abortAll();
    s = initialState();
    s.routeKind = kind;
    s.chatId = chatId;
    s.lookupMode = mode === 'name' || mode === 'number' ? mode : 'auto';
    if (initialLookup) {
      applyLookupResult(initialLookup.lookup, initialLookup.lookupError);
    }
    if (!user()) {
      render();
      return;
    }
    if (kind === 'chat') {
      if (invalid || !chatId) {
        s.error = { code: 'chat_not_found' };
        render();
        return;
      }
      void loadChatDetail(chatId);
    } else {
      render();
    }
  }

  root.addEventListener('click', (event) => {
    const modeBtn = event.target.closest('[data-lookup-mode]');
    if (modeBtn) {
      const next = modeBtn.dataset.lookupMode;
      if (['auto', 'name', 'number'].includes(next)) {
        s.lookupMode = next;
        s.lookupFormError = '';
        render();
      }
      return;
    }
    const control = event.target.closest('[data-chat-view]');
    if (!control) return;
    const action = control.dataset.chatView;
    if (action === 'reload-chat' && s.chatId) {
      void loadChatDetail(s.chatId);
    } else if (action === 'start-rename' && s.chat) {
      s.editingTitle = true;
      s.titleDraft = s.chat.title;
      s.renameError = '';
      render();
      document.getElementById('chat-title-input')?.focus();
    } else if (action === 'cancel-rename') {
      s.editingTitle = false;
      s.renameError = '';
      s.titleDraft = s.chat?.title ?? '';
      render();
    } else if (action === 'retry-lookup') {
      void runLookup(s.lookupQuery, s.lookupMode);
    } else if (action === 'select-edition') {
      const selected = s.lookup?.notices?.find((n) => noticeKey(n) === s.selectedKey);
      if (selected) {
        openNoticeModels(selected, s.routeKind === 'chat' ? s.chat?.chatId ?? null : null);
      }
    } else if (action === 'open-in-new-chat') {
      void openLookupInNewChat();
    }
  });

  root.addEventListener('change', (event) => {
    if (event.target.name === 'lookup-edition') {
      s.selectedKey = event.target.value;
      render();
    }
  });

  root.addEventListener('input', (event) => {
    if (event.target.id === 'chat-title-input') {
      s.titleDraft = event.target.value;
      if (s.renameError) s.renameError = '';
    } else if (event.target.id === 'chat-message-input') {
      s.messageDraft = event.target.value;
      s.pendingMessageKey = null;
      if (s.messageError) s.messageError = '';
    } else if (event.target.id === 'lookup-query') {
      s.lookupQuery = event.target.value;
      if (s.lookupFormError) s.lookupFormError = '';
    }
  });

  root.addEventListener('keydown', (event) => {
    if (event.target.id === 'chat-message-input') {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        void submitMessage();
      }
    } else if (event.target.id === 'chat-title-input' && event.key === 'Escape') {
      event.preventDefault();
      s.editingTitle = false;
      s.renameError = '';
      s.titleDraft = s.chat?.title ?? '';
      render();
    }
  });

  root.addEventListener('submit', (event) => {
    if (event.target.id === 'chat-rename-form') {
      event.preventDefault();
      void submitRename();
    } else if (event.target.id === 'chat-message-form') {
      event.preventDefault();
      void submitMessage();
    } else if (event.target.id === 'notice-lookup-form') {
      event.preventDefault();
      void runLookup(s.lookupQuery, s.lookupMode);
    }
  });

  return {
    enter,
    reset,
    currentChatId() {
      return s.routeKind === 'chat' ? s.chat?.chatId ?? null : null;
    },
    // 현재 화면 경로(chat·lookup)를 받아 초기화 직후에도 경로와 다른 화면을 그리지 않는다.
    view(routeKind = s.routeKind) {
      const kind = routeKind === 'lookup' ? 'lookup' : 'chat';
      if (!user()) return loginGateView(kind);
      return kind === 'lookup' ? standaloneLookupMarkup(s) : chatDetailMarkup(s);
    },
  };
}
