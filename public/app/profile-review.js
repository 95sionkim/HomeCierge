import * as api from './client.js';
import { errorText, esc } from './display.js';
import { frame } from './dialogs.js';
import { parseSharedProfileMessage } from './profile-language.js';
import { renderProfileChangeCard } from './profile-page.js';

// 비교 결과를 열어 둔 채, 다음 검색에 쓸 조건만 별도의 변경안으로 확인한다.
export function createProfileReview({ dialog, openDialog, announce, editProfile }) {
  let active = null;
  function reset() {
    active?.controller.abort();
    active = null;
  }
  function start(draft, proposal = null) {
    reset();
    active = { draft, proposal, requestId: crypto.randomUUID(), controller: new AbortController(),
      baseRevision: null, busy: false, error: null, decision: null, reopening: !draft };
    return active;
  }
  function draw(job) {
    if (job !== active) return;
    const p = job.proposal;
    const disabled = job.busy ? ' disabled' : '';
    const item = p && !job.reopening ? renderProfileChangeCard(p, { showActions: false }) : '';
    const stateLabel = { approved: '다음 맞춤 검색에 적용했습니다.', rejected: '변경안을 거절했습니다.', cancelled: '변경안을 취소했습니다.' };
    let actions = '<button type="button" class="action secondary" data-action="open-profile">공유 프로필 보기</button>';
    if (job.error) {
      if (job.error.code === 'backend_unavailable') actions += '<button type="button" class="action primary" data-review="retry">다시 시도</button>';
      else if (job.draft) actions += '<button type="button" class="action primary" data-review="edit">조건 다시 검토</button>';
    } else if (p?.status === 'pending' && !job.reopening) {
      actions = `<button type="button" class="text-button" data-review="cancel"${disabled}>변경안 취소</button><button type="button" class="action secondary" data-review="reject"${disabled}>거절</button><button type="button" class="action primary" data-review="approve"${disabled}>공유 프로필에 반영</button>`;
    }
    const status = job.error ? errorText(job.error) : job.busy
      ? (job.decision ? '결정을 저장하고 있습니다.' : '현재 값과 변경할 값을 확인하고 있습니다.')
      : (p?.status === 'pending' ? '승인하면 다음 맞춤 검색부터 적용됩니다.' : stateLabel[p?.status] || '');
    const focused = dialog.contains(document.activeElement) ? document.activeElement.dataset.review : null;
    openDialog(frame('공유 프로필 변경안', '현재 분석은 저장된 조건으로 계속 볼 수 있습니다.',
      `<div data-profile-review-dialog>${item}<p class="form-message${job.error ? '' : ' success'}" role="status">${esc(status)}</p><div class="form-actions">${actions}</div></div>`));
    if (dialog.open && !dialog.contains(document.activeElement)) {
      const next = focused && dialog.querySelector(`[data-review="${CSS.escape(focused)}"]:not(:disabled)`);
      (next || dialog.querySelector('[data-action=close]'))?.focus({ preventScroll: true });
    }
  }
  // 같은 변경안을 다른 기기에서 처리했거나 첫 페이지보다 오래된 경우에도 서버의 결정을 읽는다.
  async function findProposal(data, id, signal) {
    const cursors = new Set();
    while (data) {
      const proposal = data.proposals.find(p => p.id === id);
      if (proposal) return proposal;
      if (!data.nextCursor || cursors.has(data.nextCursor)) break;
      cursors.add(data.nextCursor);
      data = await api.readSharedProfile(signal, data.nextCursor);
    }
    throw Object.assign(new Error(), { code: 'profile_proposal_not_found' });
  }
  async function reopen(job) {
    job.error = null;
    job.busy = true;
    draw(job);
    const { signal } = job.controller;
    try {
      const current = await findProposal(await api.readSharedProfile(signal), job.proposal.id, signal);
      if (job !== active) return;
      if (current.analysisId !== job.proposal.analysisId || current.runId !== job.proposal.runId)
        throw Object.assign(new Error(), { code: 'profile_proposal_not_found' });
      job.proposal = current;
      job.reopening = false;
    } catch (error) {
      if (job === active) job.error = error;
    } finally {
      job.busy = false;
      draw(job);
    }
  }
  async function submit(job) {
    job.busy = true;
    job.error = null;
    draw(job);
    const signal = job.controller.signal;
    try {
      if (job.baseRevision === null) {
        const profile = await api.readSharedProfile(signal);
        if (job !== active) return;
        job.baseRevision = profile.revision;
      }
      const { analysisId, runId } = job.draft;
      const data = await api.proposeSearchProfile({ requestId: job.requestId, baseRevision: job.baseRevision,
        patch: job.parsed.patch, reason: job.parsed.reason, analysisId, runId }, signal);
      if (job !== active) return;
      const proposal = await findProposal(data, job.requestId, signal);
      if (proposal.analysisId !== analysisId || proposal.runId !== runId) throw Object.assign(new Error(), { code: 'profile_proposal_not_found' });
      job.proposal = proposal;
    } catch (error) {
      if (job === active) job.error = error;
    } finally {
      job.busy = false;
      draw(job);
    }
  }
  async function decide(job, decision) {
    job.decision = decision;
    job.busy = true;
    job.error = null;
    draw(job);
    try {
      const data = await api.decideSearchProfile(job.proposal.id, decision, job.controller.signal);
      if (job !== active) return;
      const status = { approve: 'approved', reject: 'rejected', cancel: 'cancelled' }[decision];
      const row = data.proposals.find(p => p.id === job.proposal.id);
      if (row && row.status !== status) throw Object.assign(new Error(), { code: 'profile_changed' });
      // 예전 페이지의 변경안도 결정할 수 있다. RPC가 성공한 경우에만 그 결정을 표시한다.
      job.proposal = row ?? { ...job.proposal, status };
      job.decision = null;
      announce(status === 'approved' ? '다음 검색에 쓸 공유 프로필을 변경했습니다.' : '변경안 결정을 저장했습니다.');
    } catch (error) {
      if (job === active) job.error = error;
    } finally {
      job.busy = false;
      draw(job);
    }
  }
  dialog.addEventListener('click', event => {
    const action = event.target.closest('[data-review]')?.dataset.review;
    const job = active;
    if (!action || !job || job.busy) return;
    if (action === 'edit') editProfile(job.draft);
    else if (action === 'retry' && job.error)
      void (job.decision ? decide(job, job.decision) : job.reopening ? reopen(job) : submit(job));
    else if (job.proposal?.status === 'pending' && ['approve', 'reject', 'cancel'].includes(action))
      void decide(job, action);
  });
  return {
    reset,
    begin(draft) {
      const parsed = parseSharedProfileMessage(draft.message);
      if (!parsed?.patch) return editProfile(draft);
      const job = start(draft);
      job.parsed = parsed;
      void submit(job);
    },
    show(proposal) { void reopen(start(null, proposal)); },
  };
}
