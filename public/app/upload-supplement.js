// 공식 PDF 확보 실패·판본 미확인 시 소유자 PDF 업로드 보완 패널.
// 파일 선택·등록·비공개 저장소 업로드·보완 실행 접수·진행 상태 조회를 거쳐 새 결과로 이어진다.
import * as api from './client.js';
import { badge, dateText, errorText, esc, icon, reasonText, runBadge } from './display.js';

const MAX_BYTES = 50 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = new Set(['queued', 'running', 'retry_wait']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function readableReason(code) {
  return reasonText(code) ?? '공고문 원문과 출처를 추가로 확인해야 합니다.';
}

function isPdfCandidate(file, maxBytes = MAX_BYTES) {
  if (!file || typeof file.size !== 'number') return { ok: false, code: 'upload_invalid_file' };
  const name = typeof file.name === 'string' ? file.name.trim().toLowerCase() : '';
  const type = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
  const typeOk = type === 'application/pdf' || (type === '' && name.endsWith('.pdf'));
  if (!typeOk || file.size <= 0) return { ok: false, code: 'upload_invalid_file' };
  if (file.size > maxBytes) return { ok: false, code: 'upload_too_large' };
  return { ok: true, code: null };
}

function validContext(raw, analysisId, runId) {
  if (!isPlainObject(raw) || raw.contractVersion !== 'upload-supplement-context/v1') return null;
  if (raw.analysisId !== analysisId || raw.runId !== runId) return null;
  if (typeof raw.eligible !== 'boolean' || typeof raw.needsSupplement !== 'boolean') return null;
  if (!isPlainObject(raw.target) || !Array.isArray(raw.reasonCodes) || !Array.isArray(raw.documents)) return null;
  if (!isPlainObject(raw.uploadRules)) return null;
  return raw;
}

function validSupplementRun(raw, analysisId) {
  if (!isPlainObject(raw) || raw.contractVersion !== 'upload-supplement-run/v1') return null;
  if (raw.analysisId !== analysisId || !UUID_RE.test(raw.runId ?? '')) return null;
  return raw;
}

function docStatusBadge(doc) {
  if (doc.status === 'accepted' && doc.originCheck === 'confirmed') {
    return badge('verified', 'circle-check', '자동 점검 통과');
  }
  if (doc.originCheck === 'conflict') {
    return badge('conflict', 'link-2-off', '반영 거부');
  }
  if (doc.status === 'rejected') {
    return badge('failed', 'triangle-alert', '반영 거부');
  }
  return badge('partial', 'circle-pause', '반영 보류');
}

function stepLabel(phase, activeRun) {
  if (phase === 'registering') return '비공개 업로드를 등록하고 있습니다.';
  if (phase === 'uploading') return '비공개 저장소에 공고 PDF를 올리고 있습니다.';
  if (phase === 'enqueuing') return '업로드 보완 점검 실행을 접수하고 있습니다.';
  if (phase === 'polling') {
    const status = activeRun?.status;
    if (status === 'running') return '서버 공식 기록과 업로드 PDF를 대조하고 항목을 점검하고 있습니다.';
    if (status === 'retry_wait') return '일시적인 조회 지연이 있어 재시도를 기다리고 있습니다.';
    return '보완 실행을 접수했습니다. 작업자가 점검을 시작하면 자동으로 갱신합니다.';
  }
  return '';
}

function blank() {
  return {
    active: false,
    ownerId: null,
    analysisId: null,
    runId: null,
    loading: false,
    error: null,
    context: null,
    selectedFile: null,
    fileError: null,
    phase: 'idle', // idle | registering | uploading | enqueuing | polling | failed | done
    pendingUpload: null, // { uploadId, idempotencyKey, uploaded: boolean, fileName, fileSize }
    activeRun: null,
    submitError: null,
  };
}

export function createUploadSupplementPanel({
  root,
  render,
  announce = () => {},
  user,
  onRunFinished,
  pollIntervalMs = 3000,
} = {}) {
  let s = blank();
  let generation = 0;
  let contextController = null;
  let actionController = null;
  let pollController = null;
  let pollTimer = null;

  function currentUser() {
    return typeof user === 'function' ? user() : null;
  }

  function clearTimers() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function abortAll() {
    clearTimers();
    contextController?.abort();
    actionController?.abort();
    pollController?.abort();
    contextController = actionController = pollController = null;
  }

  function syncView() {
    const slot = root?.querySelector?.('#upload-supplement-slot');
    if (slot) {
      slot.innerHTML = innerView();
      return;
    }
    render?.();
  }

  function reset() {
    ++generation;
    abortAll();
    s = blank();
  }

  async function loadContext() {
    const owner = currentUser()?.id;
    if (!owner || !s.active || owner !== s.ownerId || !s.analysisId || !s.runId) return;
    const token = generation;
    const { analysisId, runId } = s;
    contextController?.abort();
    const controller = new AbortController();
    contextController = controller;
    s.loading = true;
    s.error = null;
    syncView();

    try {
      const raw = await api.getUploadSupplementContext(analysisId, runId, controller.signal);
      if (token !== generation || contextController !== controller || currentUser()?.id !== owner) return;
      const parsed = validContext(raw, analysisId, runId);
      if (!parsed) throw Object.assign(new Error('backend_unavailable'), { code: 'backend_unavailable' });
      s.context = parsed;
      s.error = null;
      // 이 실행을 기준으로 이미 진행 중인 보완 실행이 있으면 이어서 상태를 추적한다.
      const ongoing = parsed.recentSupplements?.find(
        (item) => item.baseRunId === runId && ACTIVE_STATUSES.has(item.status),
      );
      if (ongoing && s.phase === 'idle') {
        s.activeRun = ongoing;
        s.phase = 'polling';
        schedulePoll(ongoing.runId, token, 50);
      }
    } catch (error) {
      if (token !== generation || contextController !== controller || currentUser()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      s.error = error;
      s.context = null;
    } finally {
      if (token === generation && contextController === controller) {
        contextController = null;
        s.loading = false;
        syncView();
      }
    }
  }

  function schedulePoll(targetRunId, token, delay = pollIntervalMs) {
    clearTimers();
    pollTimer = setTimeout(() => void pollRun(targetRunId, token), delay);
  }

  async function pollRun(targetRunId, token) {
    const owner = currentUser()?.id;
    if (token !== generation || !s.active || owner !== s.ownerId || !s.analysisId) return;
    if (typeof document !== 'undefined' && document.hidden) {
      schedulePoll(targetRunId, token, pollIntervalMs);
      return;
    }
    const analysisId = s.analysisId;
    const baseRunId = s.runId;
    pollController?.abort();
    const controller = new AbortController();
    pollController = controller;

    try {
      const raw = await api.getUploadSupplementRun(analysisId, targetRunId, controller.signal);
      if (token !== generation || pollController !== controller || currentUser()?.id !== owner) return;
      const parsed = validSupplementRun(raw, analysisId);
      if (!parsed) throw Object.assign(new Error('backend_unavailable'), { code: 'backend_unavailable' });
      s.activeRun = parsed;
      s.submitError = null;

      if (ACTIVE_STATUSES.has(parsed.status)) {
        s.phase = 'polling';
        syncView();
        schedulePoll(targetRunId, token, pollIntervalMs);
        return;
      }

      if (parsed.status === 'finished') {
        s.phase = 'done';
        s.selectedFile = null;
        s.pendingUpload = null;
        announce('업로드한 공고 PDF 점검이 완료되어 새 결과로 이동합니다.');
        syncView();
        onRunFinished?.({ analysisId, runId: parsed.runId, fromRunId: baseRunId });
        return;
      }

      s.phase = 'failed';
      s.pendingUpload = null;
      s.submitError = Object.assign(new Error(parsed.errorCode || 'upload_unavailable'), {
        code: parsed.errorCode || (parsed.status === 'cancelled' ? 'run_conflict' : 'upload_unavailable'),
      });
      announce(errorText(s.submitError));
      syncView();
    } catch (error) {
      if (token !== generation || pollController !== controller || currentUser()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      s.submitError = error;
      s.phase = 'failed';
      syncView();
    } finally {
      if (pollController === controller) pollController = null;
    }
  }

  function enter({ ownerId, analysisId, runId }) {
    if (!ownerId || !analysisId || !runId) {
      reset();
      return;
    }
    if (s.active && s.ownerId === ownerId && s.analysisId === analysisId && s.runId === runId) {
      return;
    }
    reset();
    s.active = true;
    s.ownerId = ownerId;
    s.analysisId = analysisId;
    s.runId = runId;
    void loadContext();
  }

  function selectFile(file) {
    if (!s.active || ['registering', 'uploading', 'enqueuing', 'polling'].includes(s.phase)) return;
    s.submitError = null;
    s.pendingUpload = null;
    if (!file) {
      s.selectedFile = null;
      s.fileError = null;
      syncView();
      return;
    }
    const maxBytes = s.context?.uploadRules?.maxBytes ?? MAX_BYTES;
    const check = isPdfCandidate(file, maxBytes);
    if (!check.ok) {
      s.selectedFile = null;
      s.fileError = Object.assign(new Error(check.code), { code: check.code });
      announce(errorText(s.fileError));
      syncView();
      return;
    }
    s.selectedFile = file;
    s.fileError = null;
    s.phase = 'idle';
    syncView();
  }

  function clearFile() {
    if (!s.active || ['registering', 'uploading', 'enqueuing', 'polling'].includes(s.phase)) return;
    s.selectedFile = null;
    s.fileError = null;
    s.submitError = null;
    s.pendingUpload = null;
    s.phase = 'idle';
    const input = root?.querySelector?.('#upload-supplement-file');
    if (input) input.value = '';
    announce('선택한 PDF 파일을 취소했습니다.');
    syncView();
  }

  async function submitSupplement() {
    const owner = currentUser()?.id;
    if (!owner || !s.active || owner !== s.ownerId || !s.context?.eligible) return;
    if (['registering', 'uploading', 'enqueuing', 'polling'].includes(s.phase)) return;

    const retryExisting = Boolean(s.pendingUpload?.uploaded);
    const maxBytes = s.context?.uploadRules?.maxBytes ?? MAX_BYTES;
    if (!retryExisting) {
      const check = isPdfCandidate(s.selectedFile, maxBytes);
      if (!check.ok) {
        s.fileError = Object.assign(new Error(check.code), { code: check.code });
        announce(errorText(s.fileError));
        syncView();
        return;
      }
    }

    const token = generation;
    const { analysisId, runId: baseRunId } = s;
    const file = s.selectedFile;
    actionController?.abort();
    const controller = new AbortController();
    actionController = controller;
    s.submitError = null;
    s.fileError = null;

    let attempt = s.pendingUpload;
    if (!attempt || !attempt.uploaded) {
      attempt = {
        uploadId: crypto.randomUUID().toLowerCase(),
        idempotencyKey: crypto.randomUUID().toLowerCase(),
        uploaded: false,
        fileName: file.name || 'notice.pdf',
        fileSize: file.size,
      };
      s.pendingUpload = attempt;
    }

    try {
      if (!attempt.uploaded) {
        // register_analysis_upload + 비공개 storage 업로드를 기존 계약대로 수행한다.
        await api.uploadAnalysisPdf(analysisId, attempt.uploadId, file, controller.signal, (stage) => {
          if (token !== generation || actionController !== controller || currentUser()?.id !== owner) return;
          s.phase = stage;
          syncView();
        });
        if (token !== generation || actionController !== controller || currentUser()?.id !== owner) return;
        attempt.uploaded = true;
      }

      s.phase = 'enqueuing';
      syncView();
      const queued = await api.enqueueUploadSupplement(
        analysisId,
        baseRunId,
        attempt.uploadId,
        attempt.idempotencyKey,
        controller.signal,
      );
      if (token !== generation || actionController !== controller || currentUser()?.id !== owner) return;
      const parsed = validSupplementRun(queued, analysisId);
      if (!parsed) throw Object.assign(new Error('backend_unavailable'), { code: 'backend_unavailable' });

      actionController = null;
      s.activeRun = parsed;
      s.submitError = null;

      if (parsed.status === 'finished') {
        s.phase = 'done';
        s.selectedFile = null;
        s.pendingUpload = null;
        announce('업로드한 공고 PDF 점검이 완료되어 새 결과로 이동합니다.');
        syncView();
        onRunFinished?.({ analysisId, runId: parsed.runId, fromRunId: baseRunId });
        return;
      }

      if (ACTIVE_STATUSES.has(parsed.status)) {
        s.phase = 'polling';
        announce('공고 PDF 보완 점검을 접수했습니다.');
        syncView();
        schedulePoll(parsed.runId, token, pollIntervalMs);
        return;
      }

      s.phase = 'failed';
      s.pendingUpload = null;
      s.submitError = Object.assign(new Error(parsed.errorCode || 'upload_unavailable'), {
        code: parsed.errorCode || 'upload_unavailable',
      });
      syncView();
    } catch (error) {
      if (token !== generation || actionController !== controller || currentUser()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      actionController = null;
      s.phase = 'failed';
      s.submitError = error;
      if (!attempt.uploaded || ['upload_not_found', 'upload_not_available', 'upload_file_missing'].includes(error?.code)) {
        s.pendingUpload = null;
      }
      announce(errorText(error));
      syncView();
    }
  }

  function renderDocumentsSummary(ctx) {
    const docs = ctx.documents ?? [];
    if (!docs.length) return '';
    return `<div class="upload-supp-docs"><h3>확인된 문서 상태</h3><ul>${docs
      .map((doc) => {
        const isUpload = doc.source === 'upload';
        const fileId = isUpload && doc.id.startsWith('upload:') ? doc.id.slice(7) : doc.id;
        const sourceTitle = isUpload ? '사용자 업로드' : '공식 공고문';
        const reasons = (doc.reasons ?? []).map(readableReason);
        return `<li>
          <div class="upload-supp-doc-head">
            <strong>${esc(sourceTitle)}</strong>
            ${docStatusBadge(doc)}
          </div>
          <p class="upload-supp-doc-meta">
            <span>${isUpload ? '파일 ID' : '문서 ID'} <code class="code">${esc(fileId)}</code></span>
            <span>판본 해시 <code class="code">${esc(doc.version)}</code></span>
          </p>
          ${reasons.length ? `<p class="upload-supp-doc-reason">${esc(reasons.join(' '))}</p>` : ''}
        </li>`;
      })
      .join('')}</ul></div>`;
  }

  function innerView() {
    if (!s.active || !currentUser()) return '';
    if (s.loading && !s.context) {
      return `<section class="panel upload-supp-panel is-loading" aria-busy="true">
        <div class="panel-title">${icon('file-text')}<h2>공고 PDF 보완 상태 확인 중</h2></div>
        <p class="upload-supp-lead">공식 공고문 확보 상태와 판본 확인 결과를 불러오고 있습니다.</p>
      </section>`;
    }
    if (s.error && !s.context) {
      // 권한 제한이나 비대상 실행이 아닌 일시 오류일 때만 재조회 안내를 표시한다.
      if (s.error.code === 'comparison_source_restricted' || s.error.code === 'run_not_found') return '';
      return `<section class="panel upload-supp-panel is-error" role="status">
        <div class="panel-title">${icon('triangle-alert')}<h2>공고 PDF 보완 상태를 불러오지 못했습니다</h2></div>
        <p class="upload-supp-lead">${esc(errorText(s.error))}</p>
        <div class="upload-supp-actions"><button type="button" class="action secondary compact" data-upload-supp="reload">${icon('refresh-cw')}다시 확인</button></div>
      </section>`;
    }
    const ctx = s.context;
    if (!ctx || !ctx.eligible) return '';

    const showForm = ctx.needsSupplement || s.phase !== 'idle';
    const acceptedUpload = (ctx.documents ?? []).find(
      (doc) => doc.source === 'upload' && doc.status === 'accepted' && doc.originCheck === 'confirmed',
    );
    if (!showForm && !ctx.currentSupplement && !acceptedUpload) return '';

    const target = ctx.target ?? {};
    const busy = ['registering', 'uploading', 'enqueuing', 'polling'].includes(s.phase);
    const maxMiB = Math.round((ctx.uploadRules?.maxBytes ?? MAX_BYTES) / (1024 * 1024));
    const reasons = [...new Set((ctx.reasonCodes ?? []).map(readableReason))];
    const hasRetryableEnqueuedUpload = Boolean(s.pendingUpload?.uploaded && s.phase === 'failed');

    if (!showForm && (acceptedUpload || ctx.currentSupplement)) {
      const acceptedOfficial = !acceptedUpload
        ? (ctx.documents ?? []).find(
            (doc) => doc.source === 'official' && doc.status === 'accepted' && doc.originCheck === 'confirmed',
          )
        : null;
      const shownDoc = acceptedUpload ?? acceptedOfficial;
      const isUploadDoc = Boolean(acceptedUpload);
      const fileId = isUploadDoc
        ? (acceptedUpload.id.startsWith('upload:') ? acceptedUpload.id.slice(7) : acceptedUpload.id)
        : (ctx.currentSupplement?.uploadId ?? shownDoc?.id ?? '—');
      return `<section class="panel upload-supp-panel is-verified" aria-label="사용자 업로드 반영 안내">
        <div class="upload-supp-head">
          <div class="panel-title">${icon('file-text')}<h2>${isUploadDoc ? '사용자 업로드 PDF 반영됨' : '공식 공고문 확인 완료'}</h2></div>
          ${badge('verified', 'circle-check', '공식 대조 통과')}
        </div>
        <p class="upload-supp-lead">${
          isUploadDoc
            ? '올려 주신 공고 PDF가 서버 공식 기록 대조와 자동 점검을 통과해 가격·면적·납부 일정에 반영되었습니다.'
            : '업로드한 PDF와 동일한 공식 공고문이 확보되어 공식 판본의 자동 점검 결과가 가격·면적·납부 일정에 반영되었습니다.'
        }</p>
        <dl class="upload-supp-meta">
          <div><dt>출처</dt><dd>${isUploadDoc ? '사용자 업로드' : '공식 공고문 (업로드와 동일 판본)'}</dd></div>
          <div><dt>파일 ID</dt><dd class="code">${esc(fileId)}</dd></div>
          <div><dt>판본 해시</dt><dd class="code">${esc(shownDoc?.version ?? '—')}</dd></div>
          <div><dt>대상 공고·회차</dt><dd>${esc(target.noticeNo ?? '—')} · ${esc(dateText(target.edition) !== '—' ? dateText(target.edition) : (target.edition ?? '—'))}</dd></div>
        </dl>
        <div class="upload-supp-foot">
          <span>업로드 파일과 파생 결과는 언제든 개별 삭제할 수 있습니다.</span>
          <a class="text-button" href="#privacy">내 데이터 관리에서 파일 삭제</a>
        </div>
      </section>`;
    }

    const headerBadge = busy
      ? runBadge(s.activeRun?.status ?? 'running')
      : badge('partial', 'circle-pause', '공고 PDF 보완 필요');

    return `<section class="panel upload-supp-panel" aria-labelledby="upload-supp-title" data-upload-supp-phase="${esc(s.phase)}">
      <div class="upload-supp-head">
        <div class="panel-title">${icon('file-text')}<h2 id="upload-supp-title">공고 PDF로 보완</h2></div>
        ${headerBadge}
      </div>
      <p class="upload-supp-lead">공식 모집공고문을 자동으로 확보하지 못했거나 문서 판본을 확인하지 못해 일부 항목이 보류되었습니다. 같은 공고·회차의 공식 PDF를 올리면 서버가 대조한 뒤 다시 점검합니다.</p>

      <div class="upload-supp-grid">
        <div class="upload-supp-box">
          <h3>확보 실패·보류 사유</h3>
          <ul>${(reasons.length ? reasons : ['공식 공고문 PDF 근거가 확인되지 않아 가격·면적·납부 일정이 보류되었습니다.'])
            .map((text) => `<li>${esc(text)}</li>`)
            .join('')}</ul>
        </div>
        <div class="upload-supp-box">
          <h3>대상 공고·회차</h3>
          <dl class="upload-supp-dl">
            <div><dt>공고명</dt><dd>${esc(target.title || '선택한 공고')}</dd></div>
            <div><dt>주택관리번호</dt><dd class="code">${esc(target.houseManageNo || '—')}</dd></div>
            <div><dt>공고번호</dt><dd class="code">${esc(target.noticeNo || '—')}</dd></div>
            <div><dt>회차(공고일)</dt><dd>${esc(dateText(target.edition) !== '—' ? dateText(target.edition) : (target.edition || '—'))}</dd></div>
            <div><dt>주택형</dt><dd>${esc(target.houseType || (target.modelNo ? '모델 ' + target.modelNo : '—'))}${target.room ? ' · ' + esc(target.room) : ''}</dd></div>
          </dl>
        </div>
      </div>

      ${renderDocumentsSummary(ctx)}

      <div class="upload-supp-rules" role="note">
        ${icon('info')}
        <div>
          <strong>업로드 조건 및 점검 기준</strong>
          <ul>
            <li>같은 공고·회차의 PDF 파일(<code class="code">application/pdf</code>, 최대 ${esc(String(maxMiB))} MiB)만 접수합니다.</li>
            <li>파일을 올렸다는 사실만으로 공식성이나 값의 정확성을 확정하지 않습니다. 서버가 공식 상세·첨부 식별자·공식 해시와 대조하고 자동 점검을 통과한 값만 반영합니다.</li>
            <li>다른 회차이거나 출처를 확인할 수 없는 문서는 해당 값을 보류하며, 독립적으로 확인된 기본 공고 정보는 그대로 유지됩니다.</li>
          </ul>
        </div>
      </div>

      ${
        busy
          ? `<div class="upload-supp-progress" role="status" aria-live="polite">
              ${icon('loader-circle', 'spin')}
              <div>
                <strong>${esc(stepLabel(s.phase, s.activeRun))}</strong>
                <small>${s.activeRun?.runId ? `실행 ID ${esc(s.activeRun.runId)}` : '비공개 저장소와 작업자 큐를 통해 처리하고 있습니다.'}</small>
              </div>
              ${s.phase === 'polling' && s.activeRun?.runId ? `<button type="button" class="text-button" data-upload-supp="refresh-run">${icon('refresh-cw')}상태 새로고침</button>` : ''}
            </div>`
          : `<form class="upload-supp-form" id="upload-supplement-form" novalidate>
              <div class="upload-supp-picker">
                <label class="upload-supp-file-label" for="upload-supplement-file">
                  ${icon('file-text')}
                  <span>보완할 공고 PDF 선택</span>
                </label>
                <input id="upload-supplement-file" name="pdf" type="file" accept="application/pdf,.pdf" class="upload-supp-input" />
                ${
                  s.selectedFile
                    ? `<p class="upload-supp-selected"><strong>${esc(s.selectedFile.name)}</strong><small>${esc(formatBytes(s.selectedFile.size))} · PDF 선택됨</small></p>`
                    : hasRetryableEnqueuedUpload
                      ? `<p class="upload-supp-selected"><strong>${esc(s.pendingUpload.fileName)}</strong><small>${esc(formatBytes(s.pendingUpload.fileSize))} · 저장소 업로드 완료 (점검 요청 재시도 가능)</small></p>`
                      : '<p class="upload-supp-hint">파일을 선택한 뒤 아래 버튼을 눌러 점검을 요청하세요. 파일을 고르거나 취소하는 것만으로는 반영되지 않습니다.</p>'
                }
              </div>
              ${s.fileError ? `<p class="upload-supp-error" role="alert">${icon('triangle-alert')}<span>${esc(errorText(s.fileError))}</span></p>` : ''}
              ${s.submitError ? `<p class="upload-supp-error" role="alert">${icon('triangle-alert')}<span>${esc(errorText(s.submitError))}</span></p>` : ''}
              <div class="upload-supp-actions">
                ${s.selectedFile || hasRetryableEnqueuedUpload ? '<button type="button" class="action secondary compact" data-upload-supp="clear">선택 취소</button>' : ''}
                <button type="submit" class="action primary compact" ${!s.selectedFile && !hasRetryableEnqueuedUpload ? 'disabled' : ''}>
                  ${hasRetryableEnqueuedUpload ? '점검 요청 다시 시도' : 'PDF 올리고 점검 요청'}
                </button>
              </div>
            </form>`
      }

      <div class="upload-supp-foot">
        <span>업로드 파일과 파생 자료는 <a href="#privacy">내 데이터 관리</a>에서 파일 단위로 삭제할 수 있습니다.</span>
      </div>
    </section>`;
  }

  function view() {
    return `<div id="upload-supplement-slot">${innerView()}</div>`;
  }

  root?.addEventListener?.('change', (event) => {
    const input = event.target;
    if (input?.id === 'upload-supplement-file') {
      selectFile(input.files?.[0] ?? null);
    }
  });

  root?.addEventListener?.('click', (event) => {
    const button = event.target.closest?.('[data-upload-supp]');
    if (!button || !s.active) return;
    const action = button.dataset.uploadSupp;
    if (action === 'reload') {
      void loadContext();
    } else if (action === 'clear') {
      clearFile();
    } else if (action === 'refresh-run' && s.activeRun?.runId) {
      void pollRun(s.activeRun.runId, generation);
    }
  });

  root?.addEventListener?.('submit', (event) => {
    if (event.target?.id !== 'upload-supplement-form') return;
    event.preventDefault();
    void submitSupplement();
  });

  return { enter, reset, view };
}
