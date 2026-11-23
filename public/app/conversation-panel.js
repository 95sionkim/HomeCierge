import {
  decideConversationProposal,
  getConversation,
  sendConversationMessage,
} from './client.js';
import {
  badge,
  errorText,
  esc,
  icon,
  isoDate,
  rangeLabel,
} from './display.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PUBLIC_INTENTS = new Set(['inclusion', 'holds', 'scope', 'price', 'period', 'change_period', 'help']);
const MAX_CODE_POINTS = 800;
const EXAMPLES = [
  '왜 이 거래만 포함됐어?',
  '최근 6개월로 다시 비교해줘',
  '2026-10-12부터 2026-10-25까지로 바꿔줘',
];
const clock = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function codePointLength(value) {
  return Array.from(String(value ?? '')).length;
}

function formatStamp(value) {
  const instant = Date.parse(value);
  return Number.isFinite(instant)
    ? `<time datetime="${esc(value)}">${esc(clock.format(instant))}</time>`
    : '';
}

function renderParagraphs(text) {
  const blocks = String(text ?? '')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!blocks.length) return '';
  return blocks
    .map((block) => `<p>${block.split('\n').map((line) => esc(line)).join('<br>')}</p>`)
    .join('');
}

function periodText(start, end, fallback = '기존 기간 미확인') {
  return isoDate(start) && isoDate(end) ? rangeLabel({ start, end }, false) : fallback;
}

function validProposal(proposal) {
  if (proposal === null) return true;
  if (!proposal || typeof proposal !== 'object') return false;
  if (!isoDate(proposal.start) || !isoDate(proposal.end)) return false;
  if (proposal.previousStart !== null && !isoDate(proposal.previousStart)) return false;
  if (proposal.previousEnd !== null && !isoDate(proposal.previousEnd)) return false;
  if (!['pending', 'approved', 'rejected', 'cancelled'].includes(proposal.status)) return false;
  if (proposal.resultRunId !== null && !uuid.test(proposal.resultRunId)) return false;
  return true;
}

function validConversation(data, ctx) {
  if (
    !data ||
    data.contractVersion !== 'analysis-conversation/v1' ||
    typeof data.analysisId !== 'string' ||
    data.analysisId.toLowerCase() !== ctx.analysisId ||
    typeof data.runId !== 'string' ||
    data.runId.toLowerCase() !== ctx.runId ||
    (data.previousRunId !== undefined &&
      data.previousRunId !== null &&
      (!uuid.test(data.previousRunId) || data.previousRunId.toLowerCase() === ctx.runId)) ||
    typeof data.hasEarlier !== 'boolean' ||
    !Array.isArray(data.turns)
  )
    return false;
  return data.turns.every(
    (turn) =>
      turn &&
      typeof turn.id === 'string' &&
      turn.id.length > 0 &&
      typeof turn.runId === 'string' &&
      turn.runId.toLowerCase() === ctx.runId &&
      typeof turn.message === 'string' &&
      PUBLIC_INTENTS.has(turn.intent) &&
      typeof turn.createdAt === 'string' &&
      Number.isFinite(Date.parse(turn.createdAt)) &&
      typeof turn.answer === 'string' &&
      validProposal(turn.proposal),
  );
}

let guestModulePromise = null;
function loadGuestConversation() {
  guestModulePromise ??= import('/vendor/planning-example.js').catch((error) => {
    guestModulePromise = null;
    throw error;
  });
  return guestModulePromise;
}

export function createConversationPanel({ root, render, announce, onApprovedRun }) {
  let ctx = null;
  let turns = [];
  let hasEarlier = false;
  let previousRunId = null;
  let loading = false;
  let loadError = null;
  let draft = '';
  let sending = false;
  let failedSubmission = null;
  let validationError = '';
  let pendingDecision = null;
  let decisionError = null;
  let statusMessage = '';
  let composing = false;
  let guestSeq = 0;
  let loadController = null;
  let sendController = null;
  let decisionController = null;

  function abortAll() {
    loadController?.abort();
    sendController?.abort();
    decisionController?.abort();
    loadController = sendController = decisionController = null;
  }

  function reset() {
    abortAll();
    ctx = null;
    turns = [];
    hasEarlier = false;
    previousRunId = null;
    loading = false;
    loadError = null;
    draft = '';
    sending = false;
    failedSubmission = null;
    validationError = '';
    pendingDecision = null;
    decisionError = null;
    statusMessage = '';
    composing = false;
    guestSeq = 0;
  }

  function isSameContext(next) {
    return (
      ctx &&
      Boolean(ctx.guest) === Boolean(next.guest) &&
      (ctx.ownerId ?? null) === (next.ownerId ?? null) &&
      (ctx.analysisId ?? null) === (next.analysisId ?? null) &&
      (ctx.runId ?? null) === (next.runId ?? null) &&
      (ctx.sampleKey ?? null) === (next.sampleKey ?? null)
    );
  }

  function syncPanel({ scrollBottom = false, focusSelector = null } = {}) {
    const slot = root.querySelector('#conversation-panel-slot');
    if (!slot) {
      render();
      return;
    }
    slot.innerHTML = innerView();
    if (scrollBottom) {
      const thread = slot.querySelector('.conv-thread');
      if (thread) thread.scrollTop = thread.scrollHeight;
    }
    if (focusSelector) {
      const target = slot.querySelector(focusSelector);
      target?.focus({ preventScroll: true });
    }
  }

  function updateComposerControls() {
    const slot = root.querySelector('#conversation-panel-slot');
    if (!slot) return;
    const trimmed = draft.trim();
    const count = codePointLength(trimmed);
    const over = count > MAX_CODE_POINTS;
    const counter = slot.querySelector('#conversation-count');
    if (counter) {
      counter.textContent = `${count} / ${MAX_CODE_POINTS}`;
      counter.classList.toggle('is-over', over);
    }
    const sendBtn = slot.querySelector('#conversation-send-btn');
    if (sendBtn) {
      sendBtn.disabled = sending || Boolean(pendingDecision) || count < 1 || over;
    }
    const validation = slot.querySelector('#conversation-validation');
    if (validation) {
      validation.textContent = validationError;
    }
    const submitErrorBox = slot.querySelector('#conversation-submit-error');
    if (submitErrorBox && !failedSubmission) {
      submitErrorBox.remove();
    }
  }

  async function loadHistory({ preserveDraft = true, silent = false } = {}) {
    if (!ctx || ctx.guest || document.hidden) return;
    const here = ctx;
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    loading = true;
    loadError = null;
    if (!preserveDraft) draft = '';
    if (!silent) syncPanel();
    try {
      const data = await getConversation(here.analysisId, here.runId, controller.signal);
      if (loadController !== controller || ctx !== here) return;
      if (!validConversation(data, here))
        throw Object.assign(new Error('backend_unavailable'), { code: 'backend_unavailable' });
      turns = data.turns;
      hasEarlier = data.hasEarlier;
      previousRunId = data.previousRunId ? data.previousRunId.toLowerCase() : null;
      loadError = null;
      if (decisionError) {
        const target = turns.find((t) => t.id === decisionError.turnId);
        if (!target || target.proposal?.status !== 'pending') decisionError = null;
      }
    } catch (error) {
      if (loadController !== controller || ctx !== here) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      loadError = error;
    } finally {
      if (loadController === controller && ctx === here) {
        loadController = null;
        loading = false;
        syncPanel({ scrollBottom: turns.length > 0 && !loadError });
      }
    }
  }

  function enter(context) {
    if (isSameContext(context)) {
      ctx = { ...ctx, ...context };
      return;
    }
    reset();
    ctx = context;
    if (!ctx.guest) void loadHistory({ silent: true });
  }

  async function submit({ retry = false } = {}) {
    if (!ctx || sending || pendingDecision || document.hidden) return;
    const message = retry && failedSubmission ? failedSubmission.message : draft.trim();
    const count = codePointLength(message);
    if (count < 1) {
      validationError = '질문을 입력하세요.';
      updateComposerControls();
      root.querySelector('#conversation-input')?.focus({ preventScroll: true });
      return;
    }
    if (count > MAX_CODE_POINTS) {
      validationError = `질문은 ${MAX_CODE_POINTS}자(유니코드 문자 기준) 이하로 입력하세요.`;
      updateComposerControls();
      root.querySelector('#conversation-input')?.focus({ preventScroll: true });
      return;
    }
    validationError = '';

    if (ctx.guest) {
      const here = ctx;
      sending = true;
      statusMessage = '합성 예시 답변을 준비하고 있습니다.';
      syncPanel();
      try {
        const { conversationExample } = await loadGuestConversation();
        if (ctx !== here) return;
        const previousIntent = turns.at(-1)?.intent;
        const computed = conversationExample(message, here.comparison, previousIntent);
        const turn = {
          id: 'guest-turn-' + ++guestSeq,
          runId: 'sample',
          message,
          intent: computed.intent,
          createdAt: new Date().toISOString(),
          answer: computed.answer,
          proposal: computed.proposal ? { ...computed.proposal, preview: true } : null,
        };
        turns = [...turns, turn];
        draft = '';
        failedSubmission = null;
        statusMessage = '';
        announce(
          turn.proposal
            ? '합성 예시 답변과 기간 변경 제안 미리보기를 표시했습니다.'
            : '합성 예시 답변을 표시했습니다.',
        );
      } catch (error) {
        if (ctx !== here) return;
        statusMessage = '';
        const code =
          error?.code === 'invalid_conversation_input'
            ? 'invalid_conversation_input'
            : 'backend_unavailable';
        validationError = errorText({ code });
        announce(validationError);
      } finally {
        if (ctx === here) {
          sending = false;
          syncPanel({ scrollBottom: true, focusSelector: '#conversation-input' });
        }
      }
      return;
    }

    const here = ctx;
    const reuse = failedSubmission && failedSubmission.message === message;
    const requestId = reuse ? failedSubmission.requestId : crypto.randomUUID();
    const controller = new AbortController();
    sendController = controller;
    sending = true;
    statusMessage = '질문을 확인하고 있습니다.';
    syncPanel();
    try {
      const data = await sendConversationMessage(
        here.analysisId,
        here.runId,
        requestId,
        message,
        controller.signal,
      );
      if (sendController !== controller || ctx !== here) return;
      if (!validConversation(data, here))
        throw Object.assign(new Error('backend_unavailable'), { code: 'backend_unavailable' });
      turns = data.turns;
      hasEarlier = data.hasEarlier;
      previousRunId = data.previousRunId ? data.previousRunId.toLowerCase() : null;
      draft = '';
      failedSubmission = null;
      loadError = null;
      decisionError = null;
      statusMessage = '';
      const latest = turns.at(-1);
      announce(
        latest?.proposal?.status === 'pending'
          ? '답변과 기간 변경 제안이 도착했습니다. 승인 여부를 선택하세요.'
          : '답변이 도착했습니다.',
      );
    } catch (error) {
      if (sendController !== controller || ctx !== here) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      failedSubmission = { requestId, message, error };
      statusMessage = '';
      announce(errorText(error));
    } finally {
      if (sendController === controller && ctx === here) {
        sendController = null;
        sending = false;
        syncPanel({
          scrollBottom: true,
          focusSelector: failedSubmission ? '[data-conv="retry-send"], #conversation-input' : '#conversation-input',
        });
      }
    }
  }

  async function decide(turnId, decision) {
    if (!ctx || ctx.guest || pendingDecision || sending || document.hidden) return;
    if (!['approve', 'reject', 'cancel'].includes(decision)) return;
    const targetTurn = turns.find((t) => t.id === turnId);
    if (!targetTurn || targetTurn.proposal?.status !== 'pending') return;

    const here = ctx;
    const controller = new AbortController();
    decisionController = controller;
    pendingDecision = { turnId, decision };
    decisionError = null;
    statusMessage = '결정을 반영하고 있습니다.';
    syncPanel();
    try {
      const data = await decideConversationProposal(
        here.analysisId,
        here.runId,
        turnId,
        decision,
        controller.signal,
      );
      if (decisionController !== controller || ctx !== here) return;
      if (!validConversation(data, here))
        throw Object.assign(new Error('backend_unavailable'), { code: 'backend_unavailable' });
      turns = data.turns;
      hasEarlier = data.hasEarlier;
      previousRunId = data.previousRunId ? data.previousRunId.toLowerCase() : null;
      loadError = null;
      decisionError = null;
      statusMessage = '';
      decisionController = null;
      pendingDecision = null;
      const updated = turns.find((t) => t.id === turnId);
      if (
        decision === 'approve' &&
        updated?.proposal?.status === 'approved' &&
        uuid.test(updated.proposal.resultRunId)
      ) {
        onApprovedRun({
          analysisId: here.analysisId,
          resultRunId: updated.proposal.resultRunId.toLowerCase(),
          fromRunId: here.runId,
        });
        return;
      }
      announce(
        decision === 'reject'
          ? '기간 변경 제안을 거절했습니다. 기존 조건을 유지합니다.'
          : decision === 'cancel'
            ? '기간 변경 제안을 취소했습니다. 기존 조건을 유지합니다.'
            : '승인했습니다. 이번 분석에만 적용합니다.',
      );
      syncPanel({
        focusSelector: `[data-turn-card="${CSS.escape(turnId)}"] .conv-approve-result, #conversation-input`,
      });
    } catch (error) {
      if (decisionController !== controller || ctx !== here) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      decisionError = { turnId, decision, error };
      statusMessage = '';
      decisionController = null;
      pendingDecision = null;
      announce(errorText(error));
      syncPanel({
        focusSelector: `[data-turn-card="${CSS.escape(turnId)}"] [data-conv="retry-decision"], [data-turn-card="${CSS.escape(turnId)}"] [data-conv="reload"], #conversation-input`,
      });
    }
  }

  function renderProposal(turn) {
    const p = turn.proposal;
    if (!p) return '';
    const isPreview = Boolean(p.preview || ctx.guest);
    const busy = pendingDecision?.turnId === turn.id;
    const err = decisionError?.turnId === turn.id ? decisionError : null;
    const fromText = periodText(p.previousStart, p.previousEnd);
    const toText = periodText(p.start, p.end, '미확인');
    const resolvedMap = {
      approved: ['circle-check', '승인했습니다. 이번 분석에만 적용합니다.'],
      rejected: ['x', '거절했습니다. 기존 조건을 유지합니다.'],
      cancelled: [
        'x',
        isPreview ? '미리보기를 닫았습니다. 예시 조건을 유지합니다.' : '취소했습니다. 기존 조건을 유지합니다.',
      ],
    };
    let footer = '';
    if (p.status === 'pending') {
      if (isPreview) {
        footer = `<div class="conv-approve-actions">
          <button type="button" class="action primary compact" data-action="auth">${icon('log-in')}로그인하고 내 분석 열기</button>
          <button type="button" class="text-button" data-conv="guest-dismiss" data-turn-id="${esc(turn.id)}">미리보기 닫기</button>
        </div>
        <p class="conv-approve-foot">내 분석에서 기간을 승인하면 새 결과를 계산합니다.</p>`;
      } else {
        const disabled = busy || sending || Boolean(pendingDecision) ? ' disabled' : '';
        const errCode = err?.error?.code ?? '';
        const canRetry = err && !['authentication_required', 'comparison_source_restricted', 'run_not_found'].includes(errCode);
        const approving = busy && pendingDecision.decision === 'approve';
        footer = `<div class="conv-approve-actions">
          <button type="button" class="action primary compact" data-conv="decision" data-turn-id="${esc(turn.id)}" data-decision="approve"${disabled}>${icon(approving ? 'loader-circle' : 'check', approving ? 'spin' : '')}이 조건으로 다시 비교</button>
          <button type="button" class="action secondary compact" data-conv="decision" data-turn-id="${esc(turn.id)}" data-decision="reject"${disabled}>거절</button>
          <button type="button" class="text-button" data-conv="decision" data-turn-id="${esc(turn.id)}" data-decision="cancel"${disabled}>취소</button>
        </div>
        ${
          err
            ? `<div class="conv-inline-error" role="status">${icon('triangle-alert')}<div><p>${esc(errorText(err.error))}</p><div class="conv-error-actions">${
                errCode === 'authentication_required'
                  ? '<button type="button" class="action secondary compact" data-action="auth">로그인</button>'
                  : `${canRetry ? `<button type="button" class="action secondary compact" data-conv="retry-decision" data-turn-id="${esc(turn.id)}" data-decision="${esc(err.decision)}">다시 시도</button>` : ''}${errCode === 'conversation_conflict' || err.error?.status === 409 ? '<button type="button" class="text-button" data-conv="reload">최신 대화 불러오기</button>' : ''}`
              }</div></div></div>`
            : ''
        }
        <p class="conv-approve-foot">응답하지 않으면 기존 조건을 유지합니다. 공유 프로필은 바뀌지 않습니다.</p>`;
      }
    } else {
      const [sym, label] = resolvedMap[p.status] || ['info', '처리 상태를 확인하세요.'];
      const runLink =
        !isPreview && p.status === 'approved' && uuid.test(p.resultRunId)
          ? `<a class="text-button conv-result-link" href="#run/${esc(ctx.analysisId)}/${esc(p.resultRunId)}">새 실행 결과 보기 ${icon('arrow-right')}</a>`
          : '';
      footer = `<div class="conv-approve-resolved">
        <p class="conv-approve-result" role="status" tabindex="-1">${icon(sym)}<span>${esc(label)}</span></p>${runLink}
      </div>`;
    }
    return `<section class="conv-approve is-${esc(p.status)}${isPreview ? ' is-preview' : ''}" data-turn-card="${esc(turn.id)}" aria-label="${isPreview ? '조건 변경 제안 미리보기' : '조건 변경 확인'}">
      <header class="conv-approve-head">
        ${icon('sliders-horizontal')}
        <h3>${isPreview ? '조건 변경 제안 미리보기' : '조건 변경 확인'}</h3>
        <span class="conv-approve-scope">${isPreview ? '예시 미리보기 · 실행 안 함' : '이번 분석에만 적용'}</span>
      </header>
      <div class="conv-approve-body">
        <dl class="conv-diff">
          <div class="conv-diff-row">
            <dt>계약 기간</dt>
            <dd>
              <span class="conv-diff-from"><span class="sr-only">기존 </span>${esc(fromText)}</span>
              ${icon('arrow-right', 'conv-diff-arrow')}
              <span class="conv-diff-to"><span class="sr-only">제안 </span>${esc(toText)}</span>
            </dd>
          </div>
        </dl>
        ${footer}
      </div>
    </section>`;
  }

  function renderTurn(turn) {
    const time = formatStamp(turn.createdAt);
    return `<div class="conv-turn" data-turn-id="${esc(turn.id)}">
      <article class="conv-msg conv-msg-user" aria-label="내 메시지">
        <div class="conv-msg-body">${esc(turn.message)}</div>
        ${time ? `<div class="conv-msg-meta conv-msg-meta-user">${time}</div>` : ''}
      </article>
      <article class="conv-msg conv-msg-agent" aria-label="HomeCierge 메시지">
        <div class="conv-msg-meta"><span class="conv-msg-author">HomeCierge</span>${time}</div>
        <div class="conv-msg-body">${renderParagraphs(turn.answer)}</div>
      </article>
      ${renderProposal(turn)}
    </div>`;
  }

  function renderSubmitError() {
    if (!failedSubmission) return '';
    const err = failedSubmission.error;
    const code = err?.code ?? '';
    const isAuth = code === 'authentication_required';
    const isConflict = code === 'conversation_conflict' || err?.status === 409;
    const canRetry = !isAuth && !['comparison_source_restricted', 'run_not_found'].includes(code);
    return `<div id="conversation-submit-error" class="conv-inline-error" role="status">
      ${icon('triangle-alert')}
      <div>
        <p>${esc(errorText(err))}</p>
        <div class="conv-error-actions">
          ${isAuth ? '<button type="button" class="action secondary compact" data-action="auth">로그인</button>' : ''}
          ${canRetry ? '<button type="button" class="action secondary compact" data-conv="retry-send">다시 시도</button>' : ''}
          ${isConflict ? '<button type="button" class="text-button" data-conv="reload">최신 대화 불러오기</button>' : ''}
        </div>
      </div>
    </div>`;
  }

  function innerView() {
    if (!ctx) return '';
    const demo = Boolean(ctx.guest);
    const hardLoadError =
      !demo &&
      !turns.length &&
      loadError &&
      ['authentication_required', 'comparison_source_restricted', 'run_not_found', 'comparison_not_available'].includes(
        loadError.code,
      );
    const trimmedCount = codePointLength(draft.trim());
    const over = trimmedCount > MAX_CODE_POINTS;
    const composerLocked = hardLoadError || sending || Boolean(pendingDecision);
    const sendDisabled = composerLocked || trimmedCount < 1 || over;
    const backRunId =
      previousRunId ||
      (ctx.originRun && ctx.originRun.analysisId === ctx.analysisId && ctx.originRun.toRunId === ctx.runId
        ? ctx.originRun.fromRunId
        : null);
    const originLink =
      !demo && backRunId
        ? `<a class="text-button origin-run-link" href="#run/${esc(ctx.analysisId)}/${esc(backRunId)}">${icon('arrow-left')}이전 결과와 대화 보기</a>`
        : '';

    let threadContent = '';
    if (loading && !turns.length) {
      threadContent = `<div class="conv-state" role="status">${icon('loader-circle', 'spin')}<span>이 실행의 대화 내역을 불러오고 있습니다.</span></div>`;
    } else if (loadError && !turns.length) {
      const isAuth = loadError.code === 'authentication_required';
      threadContent = `<div class="conv-inline-error" role="status">${icon('triangle-alert')}<div><p>${esc(errorText(loadError))}</p><div class="conv-error-actions">${
        isAuth
          ? '<button type="button" class="action secondary compact" data-action="auth">로그인</button>'
          : '<button type="button" class="action secondary compact" data-conv="reload">다시 불러오기</button>'
      }</div></div></div>`;
    } else {
      const earlierBanner = hasEarlier
        ? `<p class="conv-earlier">${icon('info')}이전 대화가 더 있습니다. 이 실행의 최근 대화를 표시합니다.</p>`
        : '';
      const loadWarn = loadError
        ? `<div class="conv-inline-error" role="status">${icon('triangle-alert')}<div><p>${esc(errorText(loadError))}</p><div class="conv-error-actions"><button type="button" class="action secondary compact" data-conv="reload">다시 불러오기</button></div></div></div>`
        : '';
      const intro = !turns.length
        ? `<div class="conv-empty">
            <p>${
              demo
                ? '합성 예시 결과에 포함된 거래와 제외 사유를 질문하거나 기간 변경 제안 카드를 미리 볼 수 있습니다.'
                : '이 실행에 포함된 거래 근거를 묻거나 계약 기간 변경을 요청해 보세요. 조건 변경은 승인할 때만 새 실행으로 접수합니다.'
            }</p>
          </div>`
        : '';
      threadContent = `${earlierBanner}${loadWarn}${intro}${turns.map(renderTurn).join('')}`;
    }

    const subtitle = demo
      ? '예시 대화는 이 화면에서만 볼 수 있어요.'
      : '이 실행에 저장된 결과로 답합니다.';

    return `<section class="panel conversation-panel" aria-labelledby="conversation-heading">
      <header class="conv-head">
        <div class="conv-head-top">
          <div class="panel-title">${icon('message-square')}<h2 id="conversation-heading">비교 대화</h2></div>
          ${demo ? badge('closed', 'layers', '합성 예시 대화') : ''}
        </div>
        <div class="conv-head-meta">
          <span>${esc(subtitle)}</span>
          ${demo ? `<button type="button" class="text-button" data-action="auth">로그인하고 내 분석 시작 ${icon('arrow-right')}</button>` : ''}
          ${originLink}
        </div>
      </header>
      <div class="conv-thread" aria-label="비교 대화 내역">${threadContent}</div>
      <div class="conv-footer">
        ${statusMessage ? `<p class="conv-status" role="status">${icon('loader-circle', 'spin')}<span>${esc(statusMessage)}</span></p>` : ''}
        ${renderSubmitError()}
        <div class="conv-examples" aria-label="질문 예시">
          ${EXAMPLES.map(
            (text) =>
              `<button type="button" class="conv-example" data-conv="example" data-message="${esc(text)}"${composerLocked ? ' disabled' : ''}>${esc(text)}</button>`,
          ).join('')}
        </div>
        <form id="conversation-form" class="conv-composer" novalidate>
          <label class="sr-only" for="conversation-input">비교 결과에 대해 질문하기</label>
          <textarea id="conversation-input" name="message" class="conv-input" rows="2" placeholder="왜 이 거래만 포함됐어? 또는 기간 변경을 요청해 보세요" aria-describedby="conversation-hint conversation-validation"${composerLocked ? ' readonly' : ''}>${esc(draft)}</textarea>
          <div class="conv-composer-bar">
            <span id="conversation-hint" class="conv-hint"><span id="conversation-count" class="num${over ? ' is-over' : ''}">${trimmedCount} / ${MAX_CODE_POINTS}</span> · Enter 전송 · Shift+Enter 줄바꿈</span>
            <button type="submit" id="conversation-send-btn" class="action primary compact conv-send" aria-label="보내기"${sendDisabled ? ' disabled' : ''}>${icon(sending ? 'loader-circle' : 'send', sending ? 'spin' : '')}<span>보내기</span></button>
          </div>
        </form>
        <p id="conversation-validation" class="conv-validation" role="status">${esc(validationError)}</p>
      </div>
    </section>`;
  }

  function view() {
    if (!ctx) return '';
    return `<div id="conversation-panel-slot">${innerView()}</div>`;
  }

  root.addEventListener('compositionstart', (event) => {
    if (event.target.id === 'conversation-input') composing = true;
  });

  root.addEventListener('compositionend', (event) => {
    if (event.target.id === 'conversation-input') composing = false;
  });

  root.addEventListener('input', (event) => {
    if (!ctx || event.target.id !== 'conversation-input') return;
    draft = event.target.value;
    const trimmed = draft.trim();
    if (failedSubmission && trimmed !== failedSubmission.message) {
      failedSubmission = null;
    }
    const count = codePointLength(trimmed);
    validationError =
      count > MAX_CODE_POINTS
        ? `질문은 ${MAX_CODE_POINTS}자(유니코드 문자 기준) 이하로 입력하세요.`
        : '';
    updateComposerControls();
  });

  root.addEventListener('keydown', (event) => {
    if (!ctx || event.target.id !== 'conversation-input') return;
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.isComposing &&
      !composing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      void submit();
    }
  });

  root.addEventListener('submit', (event) => {
    if (!ctx || event.target.id !== 'conversation-form') return;
    event.preventDefault();
    void submit();
  });

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-conv]');
    if (!ctx || !button) return;
    const action = button.dataset.conv;
    if (action === 'jump-composer') {
      const input = root.querySelector('#conversation-input');
      const panel = root.querySelector('.conversation-panel');
      panel?.scrollIntoView({ behavior: 'auto', block: 'nearest' });
      if (input) {
        input.scrollIntoView({ behavior: 'auto', block: 'center' });
        input.focus({ preventScroll: true });
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
      announce('비교 대화 입력란으로 이동했습니다.');
      return;
    }
    if (action === 'example') {
      const message = button.dataset.message ?? '';
      if (!message || sending || pendingDecision) return;
      draft = message;
      validationError = '';
      if (failedSubmission && failedSubmission.message !== message) failedSubmission = null;
      const input = root.querySelector('#conversation-input');
      if (input) {
        input.value = draft;
        input.focus({ preventScroll: true });
        input.setSelectionRange(draft.length, draft.length);
      }
      updateComposerControls();
      return;
    }
    if (action === 'reload') {
      void loadHistory();
      return;
    }
    if (action === 'retry-send') {
      void submit({ retry: true });
      return;
    }
    if (action === 'decision' || action === 'retry-decision') {
      const turnId = button.dataset.turnId;
      const decision = button.dataset.decision;
      if (turnId && decision) void decide(turnId, decision);
      return;
    }
    if (action === 'guest-dismiss' && ctx.guest) {
      const turnId = button.dataset.turnId;
      turns = turns.map((turn) =>
        turn.id === turnId && turn.proposal?.status === 'pending'
          ? { ...turn, proposal: { ...turn.proposal, status: 'cancelled' } }
          : turn,
      );
      announce('예시 조건 변경 미리보기를 닫았습니다.');
      syncPanel({
        focusSelector: `[data-turn-card="${CSS.escape(turnId)}"] .conv-approve-result, #conversation-input`,
      });
    }
  });

  return { enter, reset, view };
}
