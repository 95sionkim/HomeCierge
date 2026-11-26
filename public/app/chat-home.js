import * as api from './client.js';
import { esc, icon, badge, runLabels, errorText, won } from './display.js';

const kstStamp = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

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

function formatActivity(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? kstStamp.format(ms) : '시각 확인 중';
}

function statusPill(latestAnalysis) {
  if (!latestAnalysis) return badge('zero', 'message-square', '탐색 중');
  const raw = latestAnalysis.latestRunStatus || latestAnalysis.status;
  const label = runLabels[raw] ?? analysisStatusLabels[raw] ?? '상태 확인 필요';
  const style = {
    finished: 'verified',
    completed: 'verified',
    input_ready: 'verified',
    failed: 'failed',
    cancelled: 'zero',
    running: 'upcoming',
    queued: 'upcoming',
    retry_wait: 'partial',
    partial: 'partial',
    draft: 'unknown',
  }[raw] ?? 'unknown';
  const symbol = {
    finished: 'circle-check',
    completed: 'circle-check',
    input_ready: 'circle-check',
    failed: 'triangle-alert',
    cancelled: 'circle-minus',
    running: 'loader-circle',
    queued: 'clock-3',
    retry_wait: 'clock-3',
    partial: 'chart-pie',
    draft: 'circle-help',
  }[raw] ?? 'circle-help';
  return badge(style, symbol, label);
}

function summarizeProfile(profile) {
  if (!profile) return null;
  const c = profile.conditions ?? {};
  const parts = [];
  if (Array.isArray(c.region_codes) && c.region_codes.length) parts.push(`희망 지역 ${c.region_codes.length}곳`);
  if (typeof c.budget_max_won === 'string' && /^(?:0|[1-9]\d*)$/.test(c.budget_max_won)) {
    const label = c.budget_max_won.length <= 20 ? won(c.budget_max_won) : `${c.budget_max_won}원`;
    parts.push(`예산 상한 ${label}`);
  }
  if (c.supply_area_min_m2 && c.supply_area_max_m2) {
    parts.push(`공급 ${c.supply_area_min_m2}–${c.supply_area_max_m2}㎡`);
  }
  if (c.move_in_start_month && c.move_in_end_month) {
    parts.push(`입주 ${c.move_in_start_month}–${c.move_in_end_month}`);
  }
  if (typeof profile.destination === 'string' && profile.destination) {
    parts.push(`목적지 ${profile.destination}`);
  }
  const pending = (profile.proposals ?? []).filter((p) => p.status === 'pending').length;
  return {
    revision: Number.isSafeInteger(profile.revision) ? profile.revision : 0,
    summary: parts.length ? parts.join(' · ') : '승인된 탐색 조건이 아직 없습니다.',
    pending,
  };
}

function pdfGuideMarkup(open, signedIn) {
  if (!open) return '';
  return `<div class="chat-info-banner" id="pdf-supplement-guide" role="region" aria-label="PDF 보완 안내">
    <div class="chat-info-head">
      <strong>${icon('file-text')}공고 PDF 보완 안내</strong>
      <button type="button" class="quiet-icon" data-chat-home="close-pdf" aria-label="PDF 안내 닫기">${icon('x')}</button>
    </div>
    <p>공고를 먼저 고른 뒤 분석 화면에서 PDF로 보완할 수 있습니다. 같은 이름의 공고는 공고일·공고번호·주택관리번호로 회차를 구분해 선택한 뒤 진행해 주세요.</p>
    <div class="chat-info-actions">
      ${
        signedIn
          ? `<a class="action secondary compact" href="#lookup/name">${icon('building-2')}공고명으로 찾기</a>
             <a class="action secondary compact" href="#analyses">${icon('folder-open')}내 분석 열기</a>`
          : `<button type="button" class="action primary compact" data-action="auth">${icon('log-in')}로그인하고 공고 찾기</button>`
      }
    </div>
  </div>`;
}

function startCardsMarkup(pdfOpen, signedIn) {
  return `<section class="chat-start-grid" aria-label="시작 방법">
    <button type="button" class="chat-start-card" data-chat-home="start-name">
      <span class="chat-start-icon">${icon('building-2')}</span>
      <strong>공고명으로 찾기</strong>
      <span>같은 이름의 공고가 여러 건이면 공고일·공고번호·유형으로 회차를 구분해 고릅니다.</span>
    </button>
    <button type="button" class="chat-start-card" data-chat-home="start-number">
      <span class="chat-start-icon">${icon('database')}</span>
      <strong>공고번호로 찾기</strong>
      <span>청약홈 공고번호(최대 10자리 숫자)로 공유 색인에서 바로 찾습니다.</span>
    </button>
    <button type="button" class="chat-start-card${pdfOpen ? ' active' : ''}" data-chat-home="start-pdf" aria-expanded="${pdfOpen}" aria-controls="pdf-supplement-guide">
      <span class="chat-start-icon">${icon('file-text')}</span>
      <strong>PDF로 보완</strong>
      <span>공고를 먼저 고른 뒤 분석 화면에서 PDF로 보완할 수 있습니다.</span>
    </button>
  </section>${pdfGuideMarkup(pdfOpen, signedIn)}`;
}

function guestView(s) {
  return `<div class="chat-home-wrap">
    <header class="chat-home-head">
      <div class="chat-home-title-row">
        <div>
          <div class="chat-eyebrow">${badge('closed', 'layers', '합성 자료')}<span>로그인 전 예시 화면</span></div>
          <h1 id="page-heading">어떤 청약 공고를 검토할까요?</h1>
          <p class="chat-home-sub">공고와 주택형을 정하면 같은 법정동·읍·면 아파트 실거래부터 같은 기준으로 비교합니다. 확인하지 못한 내용은 이유와 함께 따로 보여줍니다.</p>
        </div>
        <div class="chat-head-actions">
          <button type="button" class="action primary" data-action="auth">${icon('log-in')}로그인</button>
          <a class="action secondary" href="#notices">${icon('calendar-days')}오늘의 청약</a>
        </div>
      </div>
    </header>

    <div class="chat-auth-notice" role="note">
      <div>
        <strong>${icon('shield-check')}로그인 후 탐색과 채팅을 시작합니다</strong>
        <p>비로그인 상태에서는 공고 찾기·채팅 저장·분석을 실행하지 않습니다. 로그인하면 여러 채팅과 분석 결과를 다른 기기에서도 이어서 볼 수 있습니다.</p>
      </div>
      <button type="button" class="action primary compact" data-action="auth">로그인하기</button>
    </div>

    <form id="chat-home-form" class="chat-composer-card" novalidate>
      <label class="sr-only" for="chat-home-input">공고명 또는 공고번호 입력</label>
      <textarea id="chat-home-input" name="message" rows="2" placeholder="로그인 후 공고명이나 10자리 공고번호를 입력하세요." autocomplete="off">${esc(s.composerText)}</textarea>
      <div class="chat-composer-foot">
        <span class="small muted">로그인한 뒤 공고명·공고번호 찾기와 채팅 저장을 시작합니다.</span>
        <button type="submit" class="action primary compact">${icon('log-in')}로그인하고 시작</button>
      </div>
    </form>

    ${s.guestNotice ? `<p class="chat-inline-feedback" role="status">${esc(s.guestNotice)}</p>` : ''}

    ${startCardsMarkup(s.pdfNoticeOpen, false)}

    <section class="chat-home-section" aria-labelledby="guest-chat-heading">
      <div class="section-top">
        <h2 id="guest-chat-heading">예시 채팅 <small>합성 자료</small></h2>
        <a class="text-button" href="#notices">오늘의 청약 보기 ${icon('arrow-right')}</a>
      </div>
      <div class="chat-list-grid">
        <a class="chat-list-card synthetic" href="#sample/saved">
          <div class="chat-card-top">
            <strong>합성 가람 아파트 · 084.0000A</strong>
            ${badge('closed', 'layers', '합성 자료')}
          </div>
          <p class="chat-card-preview">합성 자료로 구성한 비교 결과 예시입니다. 실제 공고 탐색과 채팅 저장은 로그인 후 이용하세요.</p>
          <div class="chat-card-meta">
            <span>예시 분석 1건</span>
            <span>비교 결과 예시 보기</span>
          </div>
        </a>
      </div>
    </section>

    <section class="home-links" aria-label="다른 탐색 진입점">
      <a class="panel home-link" href="#notices">${icon('calendar-days')}<strong>오늘의 청약</strong><span>오늘 접수 중·예정인 공고 일정을 카드와 달력으로 확인합니다.</span>${icon('arrow-right')}</a>
      <a class="panel home-link" href="#search">${icon('sliders-horizontal')}<strong>맞춤 공고 찾기</strong><span>희망 지역과 예산 조건에 맞는 공고를 살펴봅니다.</span>${icon('arrow-right')}</a>
    </section>
  </div>`;
}

function recentChatsMarkup(s) {
  if (s.loading && !s.chats.length) {
    return `<div class="empty-state">${icon('loader-circle')}<h3>최근 채팅을 불러오는 중입니다.</h3></div>`;
  }
  if (s.error && !s.chats.length) {
    return `<div class="empty-state">${icon('triangle-alert')}<h3>채팅 목록을 불러오지 못했습니다.</h3><p>${esc(errorText(s.error))}</p><button type="button" class="action secondary" data-chat-home="reload">다시 조회</button></div>`;
  }
  if (!s.chats.length) {
    return `<div class="empty-state">${icon('message-square')}<h3>아직 저장된 채팅이 없습니다.</h3><p>새 채팅을 만들거나 위 입력창에 공고명·공고번호를 입력해 시작해 보세요.</p><div class="chat-empty-actions"><button type="button" class="action primary" data-chat-home="new-chat">${icon('message-square')}새 채팅 만들기</button><a class="action secondary" href="#notices">${icon('calendar-days')}오늘의 청약</a></div></div>`;
  }
  return `${s.error ? `<div class="scope-note">${icon('triangle-alert')}<span>일부 목록을 갱신하지 못했습니다. ${esc(errorText(s.error))} <button type="button" class="text-button" data-chat-home="reload">다시 조회</button></span></div>` : ''}
    <div class="chat-list-grid" role="list">
      ${s.chats
        .map((chat) => {
          const analysisText = chat.analysisCount > 0 ? `연결된 분석 ${chat.analysisCount}건` : '연결된 분석 없음';
          const detailLine = chat.latestAnalysis
            ? `최근 분석: ${chat.latestAnalysis.title}${chat.latestAnalysis.houseType ? ` (${chat.latestAnalysis.houseType})` : ''}`
            : chat.lastMessagePreview || '대화를 이어서 공고를 찾을 수 있습니다.';
          return `<a class="chat-list-card" role="listitem" href="#chat/${esc(chat.chatId)}">
            <div class="chat-card-top">
              <strong>${esc(chat.title)}</strong>
              ${statusPill(chat.latestAnalysis)}
            </div>
            <p class="chat-card-preview">${esc(detailLine)}</p>
            <div class="chat-card-meta">
              <span>${esc(analysisText)}</span>
              <time datetime="${esc(chat.lastActivityAt)}">${esc(formatActivity(chat.lastActivityAt))}</time>
            </div>
          </a>`;
        })
        .join('')}
    </div>
    ${
      s.nextCursor
        ? `<div class="more-notices"><button type="button" class="action secondary" data-chat-home="load-more" ${s.loadingMore ? 'disabled' : ''}>${s.loadingMore ? '불러오는 중' : '채팅 더 보기'}</button></div>`
        : ''
    }`;
}

function signedInView(s) {
  const profile = summarizeProfile(s.profile);
  return `<div class="chat-home-wrap">
    <header class="chat-home-head">
      <div class="chat-home-title-row">
        <div>
          <h1 id="page-heading">어떤 청약 공고를 검토할까요?</h1>
          <p class="chat-home-sub">공고명이나 공고번호로 회차를 구분해 고르고, 같은 동 실거래 비교와 구매 준비 검토를 채팅별로 이어서 관리합니다.</p>
        </div>
        <div class="chat-head-actions">
          <button type="button" class="action primary" data-chat-home="new-chat" ${s.busy ? 'disabled' : ''}>${icon('message-square')}${s.busy ? '생성 중' : '새 채팅'}</button>
          <a class="action secondary" href="#notices">${icon('calendar-days')}오늘의 청약</a>
        </div>
      </div>
    </header>

    <form id="chat-home-form" class="chat-composer-card" novalidate>
      <label class="sr-only" for="chat-home-input">공고명, 공고번호 또는 탐색 조건 입력</label>
      <textarea id="chat-home-input" name="message" rows="2" maxlength="800" placeholder="공고명·10자리 공고번호 또는 탐색 조건(예: 광진구랑 성동구에서 7억 이하, 84㎡ 정도로 찾아줘)을 입력하세요." ${s.busy ? 'disabled' : ''}>${esc(s.composerText)}</textarea>
      <div class="chat-composer-foot">
        <span class="small muted">${profile ? `확인된 프로필 v${profile.revision}${profile.pending ? ` · 변경안 ${profile.pending}건 대기` : ''}` : '공고명·공고번호 또는 지역·예산 조건을 입력하면 새 채팅에서 확인 후 검색합니다.'}</span>
        <button type="submit" class="action primary compact" ${s.busy ? 'disabled' : ''}>${icon('send')}${s.busy ? '시작 중' : '채팅 시작'}</button>
      </div>
    </form>
    ${s.submitError ? `<p class="plan-error" role="alert">${esc(s.submitError)}</p>` : ''}

    ${startCardsMarkup(s.pdfNoticeOpen, true)}

    <section class="chat-home-section" aria-labelledby="recent-chats-heading">
      <div class="section-top">
        <h2 id="recent-chats-heading">최근 채팅${s.chats.length ? `<small>${s.chats.length}건</small>` : ''}</h2>
        <div class="inline">
          <button type="button" class="text-button" data-chat-home="reload" ${s.loading ? 'disabled' : ''}>${icon('refresh-cw')}새로고침</button>
          <a class="text-button" href="#analyses">전체 분석 보기 ${icon('arrow-right')}</a>
        </div>
      </div>
      ${recentChatsMarkup(s)}
    </section>

    <section class="home-links" aria-label="다른 탐색 진입점">
      <a class="panel home-link" href="#notices">${icon('calendar-days')}<strong>오늘의 청약</strong><span>오늘 접수 중·예정인 공고 일정을 카드와 달력으로 확인합니다.</span>${icon('arrow-right')}</a>
      <a class="panel home-link" href="#search">${icon('sliders-horizontal')}<strong>맞춤 공고 찾기</strong><span>희망 지역과 예산 조건에 맞는 호실을 찾습니다.</span>${icon('arrow-right')}</a>
    </section>

    <aside class="chat-profile-bar" aria-label="공유 프로필 요약">
      <div class="chat-profile-copy">
        <strong>${profile ? `확인된 프로필 v${profile.revision}` : '공유 프로필'}</strong>
        <span>${esc(profile ? profile.summary : '희망 지역·예산·출퇴근 목적지를 확인 후 저장할 수 있습니다.')}</span>
        ${profile?.pending ? badge('partial', 'clock-3', `변경안 ${profile.pending}건 대기`) : ''}
      </div>
      <a class="text-button" href="#profile">프로필 보기 ${icon('arrow-right')}</a>
    </aside>
  </div>`;
}

function initialState() {
  return {
    chats: [],
    nextCursor: null,
    loading: false,
    loadingMore: false,
    error: null,
    profile: null,
    composerText: '',
    busy: false,
    submitError: '',
    pdfNoticeOpen: false,
    guestNotice: '',
    pendingCreateKey: null,
    pendingQuickCreateKey: null,
    pendingQuickMessageKey: null,
  };
}

export function createChatHome({ root, render, announce, user, navigate, openAuth, onOpenChat }) {
  let s = initialState();
  let generation = 0;
  let listController = null;
  let profileController = null;

  function abortRequests() {
    listController?.abort();
    listController = null;
    profileController?.abort();
    profileController = null;
  }

  function reset() {
    ++generation;
    abortRequests();
    s = initialState();
  }

  async function loadChats({ append = false } = {}) {
    const owner = user();
    if (!owner) return;
    if (append && (!s.nextCursor || s.loadingMore)) return;
    const token = generation;
    const ownerId = owner.id;
    if (!append) {
      listController?.abort();
      listController = new AbortController();
      s.loading = true;
      s.error = null;
    } else {
      s.loadingMore = true;
      s.error = null;
    }
    const signal = listController?.signal;
    render();
    try {
      const data = await api.listChats({ before: append ? s.nextCursor : null, limit: 20 }, signal);
      if (token !== generation || user()?.id !== ownerId) return;
      if (append) {
        const seen = new Set(s.chats.map((c) => c.chatId));
        for (const item of data.chats) if (!seen.has(item.chatId)) s.chats.push(item);
      } else {
        s.chats = data.chats;
      }
      s.nextCursor = data.nextCursor;
    } catch (error) {
      if (error?.name === 'AbortError' || token !== generation || user()?.id !== ownerId) return;
      s.error = error;
    } finally {
      if (token === generation && user()?.id === ownerId) {
        s.loading = false;
        s.loadingMore = false;
        render();
      }
    }
  }

  async function loadProfileSummary() {
    const owner = user();
    if (!owner) return;
    const token = generation;
    const ownerId = owner.id;
    profileController?.abort();
    profileController = new AbortController();
    try {
      const data = await api.readSharedProfile(profileController.signal);
      if (token !== generation || user()?.id !== ownerId) return;
      s.profile = data;
      render();
    } catch {
      // 프로필 요약 조회 실패가 채팅 홈 사용을 막지 않는다.
    }
  }

  function enter() {
    s.submitError = '';
    s.guestNotice = '';
    if (!user()) {
      render();
      return;
    }
    void loadChats();
    void loadProfileSummary();
  }

  async function handleNewChat() {
    const owner = user();
    if (!owner) {
      s.guestNotice = '새 채팅을 만들려면 먼저 로그인해 주세요.';
      render();
      openAuth();
      return;
    }
    if (s.busy) return;
    const token = generation;
    const ownerId = owner.id;
    s.busy = true;
    s.submitError = '';
    s.pendingCreateKey ??= crypto.randomUUID();
    render();
    try {
      const created = await api.createChat({ requestId: s.pendingCreateKey, title: '새 채팅' });
      if (token !== generation || user()?.id !== ownerId) return;
      s.pendingCreateKey = null;
      s.busy = false;
      announce('새 채팅을 만들었습니다.');
      onOpenChat(created.chat.chatId, null);
      navigate('#chat/' + created.chat.chatId);
    } catch (error) {
      if (token !== generation || user()?.id !== ownerId) return;
      s.busy = false;
      if (error?.code !== 'backend_unavailable') s.pendingCreateKey = null;
      s.submitError = errorText(error);
      render();
    }
  }

  async function handleQuickSubmit() {
    const owner = user();
    if (!owner) {
      s.guestNotice = '비로그인 상태에서는 공고 찾기와 채팅을 실행하지 않습니다. 로그인해 주세요.';
      render();
      openAuth();
      return;
    }
    const text = s.composerText.trim();
    if (!text) {
      s.submitError = '공고명 또는 공고번호를 입력해 주세요.';
      render();
      return;
    }
    if (Array.from(text).length > 800) {
      s.submitError = '메시지는 800자 이내로 입력해 주세요.';
      render();
      return;
    }
    if (s.busy) return;
    const token = generation;
    const ownerId = owner.id;
    s.busy = true;
    s.submitError = '';
    s.pendingQuickCreateKey ??= crypto.randomUUID();
    s.pendingQuickMessageKey ??= crypto.randomUUID();
    render();
    try {
      const initialTitle = Array.from(text.replace(/\s+/gu, ' ')).slice(0, 60).join('');
      const created = await api.createChat({ requestId: s.pendingQuickCreateKey, title: initialTitle || '새 채팅' });
      if (token !== generation || user()?.id !== ownerId) return;
      const reply = await api.sendChatMessage(created.chat.chatId, {
        requestId: s.pendingQuickMessageKey,
        message: text,
        mode: 'auto',
      });
      if (token !== generation || user()?.id !== ownerId) return;
      s.pendingQuickCreateKey = null;
      s.pendingQuickMessageKey = null;
      s.composerText = '';
      s.busy = false;
      announce('새 채팅에서 공고 찾기를 실행했습니다.');
      onOpenChat(created.chat.chatId, { lookup: reply.lookup ?? null, lookupError: reply.lookupError ?? null });
      navigate('#chat/' + created.chat.chatId);
    } catch (error) {
      if (token !== generation || user()?.id !== ownerId) return;
      s.busy = false;
      if (error?.code !== 'backend_unavailable') {
        s.pendingQuickCreateKey = null;
        s.pendingQuickMessageKey = null;
      }
      s.submitError = errorText(error);
      render();
    }
  }

  root.addEventListener('click', (event) => {
    const control = event.target.closest('[data-chat-home]');
    if (!control) return;
    const action = control.dataset.chatHome;
    if (action === 'new-chat') {
      void handleNewChat();
    } else if (action === 'reload') {
      void loadChats();
    } else if (action === 'load-more') {
      void loadChats({ append: true });
    } else if (action === 'start-pdf') {
      s.pdfNoticeOpen = !s.pdfNoticeOpen;
      render();
    } else if (action === 'close-pdf') {
      s.pdfNoticeOpen = false;
      render();
    } else if (action === 'start-name' || action === 'start-number') {
      if (!user()) {
        s.guestNotice = '공고 찾기는 로그인한 뒤 이용할 수 있습니다.';
        render();
        openAuth();
        return;
      }
      navigate(action === 'start-number' ? '#lookup/number' : '#lookup/name');
    }
  });

  root.addEventListener('input', (event) => {
    if (event.target.id === 'chat-home-input') {
      s.composerText = event.target.value;
      s.pendingQuickCreateKey = null;
      s.pendingQuickMessageKey = null;
      if (s.submitError) {
        s.submitError = '';
      }
    }
  });

  root.addEventListener('keydown', (event) => {
    if (event.target.id !== 'chat-home-input') return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void handleQuickSubmit();
    }
  });

  root.addEventListener('submit', (event) => {
    if (event.target.id !== 'chat-home-form') return;
    event.preventDefault();
    void handleQuickSubmit();
  });

  return {
    enter,
    reset,
    refresh() {
      if (user()) void loadChats();
    },
    view() {
      return user() ? signedInView(s) : guestView(s);
    },
  };
}
