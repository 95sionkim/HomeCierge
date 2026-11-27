import { badge, errorText, esc, icon } from './display.js';
import { evidenceReasonLabel } from './comparison-scope.js';

const sha256Re = /^sha256:([0-9a-f]{13,})$/i;
const hexRe = /^[0-9a-f]{16,}$/i;

export function shortenVersion(version) {
  if (typeof version !== 'string' || !version) return '—';
  const sha = version.match(sha256Re);
  if (sha) return `sha256:${sha[1].slice(0, 12)}…`;
  if (hexRe.test(version)) return `${version.slice(0, 12)}…`;
  if (version.length > 24) return `${version.slice(0, 20)}…`;
  return version;
}

export function normalizeDocRefs(refs) {
  const docs = new Map();
  for (const ref of refs ?? []) {
    if (
      !ref ||
      typeof ref.document !== 'string' ||
      !ref.document ||
      typeof ref.version !== 'string' ||
      !ref.version ||
      !Number.isSafeInteger(ref.page) ||
      ref.page < 1
    ) {
      continue;
    }
    const key = `${ref.document}\0${ref.version}`;
    if (!docs.has(key)) {
      docs.set(key, { document: ref.document, version: ref.version, pages: new Set() });
    }
    docs.get(key).pages.add(ref.page);
  }
  return [...docs.values()].map((d) => ({
    document: d.document,
    version: d.version,
    pages: [...d.pages].sort((a, b) => a - b),
  }));
}

export function evidenceChip(refs, itemId, label) {
  const normalized = normalizeDocRefs(refs);
  if (!normalized.length) return '';
  const allPages = [...new Set(normalized.flatMap((d) => d.pages))].sort((a, b) => a - b);
  const pageSummary = allPages.map((p) => 'p.' + p).join('·');
  const docLabel = normalized.length === 1 && normalized[0].document.startsWith('upload:')
    ? '업로드 PDF'
    : '공고 PDF';
  return `<button type="button" class="hc-src evidence-source-chip" data-open-evidence="${esc(itemId)}" aria-label="${esc(label)} 원문 근거 보기 (${esc(pageSummary)})">${icon('file-text')}<span>${esc(docLabel)}</span><span class="hc-src-detail">${esc(pageSummary)}</span></button>`;
}

function docStatusBadge(doc, itemStatus = 'confirmed') {
  if (itemStatus === 'conflict' || doc?.originCheck === 'conflict') {
    return badge('conflict', 'link-2-off', '출처·값 충돌');
  }
  if (doc?.status === 'rejected') {
    return badge('failed', 'triangle-alert', '반려 · 병합 제외');
  }
  if (doc?.status === 'held' || itemStatus === 'held' || itemStatus === 'unverified') {
    return badge('partial', 'circle-pause', '점검 보류');
  }
  if (doc?.status === 'accepted' && doc?.originCheck === 'confirmed') {
    return badge('verified', 'circle-check', '자동 점검 통과 · 같은 회차');
  }
  if (itemStatus === 'confirmed') {
    return badge('verified', 'circle-check', '자동 점검 통과');
  }
  return badge('unknown', 'circle-help', '점검 상태 미확인');
}

function acquisitionLabel(source) {
  if (source === 'official') return '공식 공고 첨부';
  if (source === 'upload') return '본인 업로드 문서';
  return '확보 경로 미확인';
}

function safeApplyhomeUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      !['www.applyhome.co.kr', 'static.applyhome.co.kr'].includes(parsed.hostname)
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function createEvidenceViewerSheet({ sheet, announce, loadEvidence, downloadUpload }) {
  let state = null;
  let reqToken = 0;

  function close({ restoreFocus = true } = {}) {
    const trigger = state?.trigger;
    ++reqToken;
    state = null;
    if (sheet.dataset.sheet === 'evidence') {
      delete sheet.dataset.sheet;
      if (sheet.open) sheet.close();
      sheet.innerHTML = '';
    }
    if (restoreFocus && trigger && trigger.isConnected) {
      trigger.focus({ preventScroll: true });
    }
  }

  function findDocMeta(docId, version, evidenceDetail) {
    return (
      (evidenceDetail?.documents ?? []).find((d) => d.id === docId && d.version === version) ??
      (evidenceDetail?.documents ?? []).find((d) => d.id === docId) ??
      null
    );
  }

  function renderDocAction(docMeta, ref, dataOrigin, noticeLink, downloadingId, downloadError) {
    const isUpload = docMeta?.source === 'upload' || ref.document.startsWith('upload:');
    if (isUpload) {
      if (docMeta?.uploadContentPath && docMeta?.uploadId) {
        const busy = downloadingId === docMeta.uploadId;
        return `<div class="ev-doc-actions">
          <button type="button" class="action primary compact" data-download-upload="${esc(docMeta.uploadId)}"${busy ? ' disabled' : ''}>
            ${icon(busy ? 'loader-circle' : 'file-text', busy ? 'spin' : '')}${busy ? '문서 여는 중…' : '본인 업로드 PDF 열기'}
          </button>
          <p class="ev-policy-note">본인 계정에 등록된 비공개 PDF를 소유권 확인 후 내려받습니다.</p>
          ${downloadError?.uploadId === docMeta.uploadId ? `<p class="ev-inline-error" role="alert">${esc(errorText(downloadError.error))}</p>` : ''}
        </div>`;
      }
      const statusText =
        docMeta?.uploadStatus === 'deleted'
          ? '삭제된 업로드 문서'
          : dataOrigin === 'synthetic'
            ? '합성 업로드 예시'
            : '열 수 없는 업로드 문서';
      const hint =
        docMeta?.uploadStatus === 'deleted'
          ? '삭제된 본인 업로드 문서는 다시 열 수 없습니다.'
          : dataOrigin === 'synthetic'
            ? '합성 예시입니다. 로그인 후 본인 분석에서 등록한 PDF를 열 수 있습니다.'
            : '등록이 해지되었거나 접근 권한을 확인할 수 없는 업로드 문서입니다.';
      return `<div class="ev-doc-actions">
        ${badge('unknown', 'circle-help', statusText)}
        <p class="ev-policy-note">${esc(hint)}</p>
      </div>`;
    }

    const officialUrl = safeApplyhomeUrl(docMeta?.officialUrl);
    const detailLink = safeApplyhomeUrl(noticeLink);
    if (officialUrl || detailLink) {
      return `<div class="ev-doc-actions">
        <div class="ev-link-row">
          ${
            officialUrl
              ? `<a class="action secondary compact" href="${esc(officialUrl)}" target="_blank" rel="noopener noreferrer">공식 출처에서 PDF 열기 ${icon('external-link')}</a>`
              : ''
          }
          ${
            detailLink
              ? `<a class="${officialUrl ? 'text-button' : 'action secondary compact'}" href="${esc(detailLink)}" target="_blank" rel="noopener noreferrer">청약홈 공고 상세 페이지 ${icon('external-link')}</a>`
              : ''
          }
        </div>
        <p class="ev-policy-note">공식 공고 PDF는 재호스팅하지 않고 공식 게시처로만 연결합니다.</p>
      </div>`;
    }

    if (dataOrigin === 'synthetic') {
      return `<div class="ev-doc-actions">
        ${badge('closed', 'layers', '합성 예시 문서')}
        <p class="ev-policy-note">합성 시험 자료입니다. 실제 공고 분석에서는 공식 출처 링크 또는 본인 업로드 PDF 열기를 제공합니다. 공식 PDF는 재호스팅하지 않습니다.</p>
      </div>`;
    }

    return `<div class="ev-doc-actions">
      ${badge('unknown', 'circle-help', '공식 출처 링크 미확인')}
      <p class="ev-policy-note">공식 공고 PDF는 재호스팅하지 않습니다. 청약홈 공고 상세에서 원본 문서를 직접 확인하세요.</p>
    </div>`;
  }

  function renderSheet() {
    if (!state) return;
    const { items, activeId, target, dataOrigin, evidenceDetail, loading, error, downloadingId, downloadError } = state;
    const active = items.find((i) => i.id === activeId) ?? items[0];
    if (!active) return;

    const normalizedRefs = normalizeDocRefs(active.refs);
    const firstMeta = normalizedRefs.length
      ? findDocMeta(normalizedRefs[0].document, normalizedRefs[0].version, evidenceDetail)
      : null;
    const noticeLink = evidenceDetail?.noticeLink ?? null;
    const nonAcceptedDocs = (evidenceDetail?.documents ?? []).filter(
      (d) => d.status === 'held' || d.status === 'rejected',
    );

    const metaParts = [
      target?.noticeNo ? `<span class="code">${esc(target.noticeNo)}</span>` : null,
      target?.edition ? `회차 ${esc(target.edition)}` : null,
      target?.houseType ? `주택형 ${esc(target.houseType)}` : null,
    ].filter(Boolean);

    sheet.dataset.sheet = 'evidence';
    sheet.innerHTML = `<div class="hc-sheet-shell">
      <header class="hc-sheet-head">
        <div class="hc-sheet-title-wrap">
          <div class="tag-row">
            ${docStatusBadge(firstMeta, active.status)}
            ${dataOrigin === 'synthetic' ? badge('closed', 'layers', '합성 자료') : ''}
          </div>
          <h2 id="sheet-title">원문 근거 · ${esc(active.label)}</h2>
          ${metaParts.length ? `<p class="hc-sheet-sub">${metaParts.join(' · ')}</p>` : ''}
        </div>
        <button type="button" class="quiet-icon" data-sheet-close aria-label="원문 근거 닫기">${icon('x')}</button>
      </header>
      <div class="hc-sheet-body">
        ${loading ? `<div class="sheet-status-banner" role="status">${icon('loader-circle', 'spin')}<span>문서 판본과 공식 출처 정보를 불러오고 있습니다.</span></div>` : ''}
        ${error ? `<div class="sheet-error-banner" role="alert">${icon('triangle-alert')}<span>${esc(errorText(error))}</span></div>` : ''}

        <section class="ev-fact-card" aria-label="선택한 값의 원문 근거">
          <span class="ev-fact-label">${esc(active.label)}</span>
          <strong class="ev-fact-value num">${esc(active.displayValue || '—')}</strong>
          ${active.rawValue ? `<span class="ev-fact-raw code">원문 단위 ${esc(active.rawValue)}</span>` : ''}
        </section>

        <section class="sheet-section" aria-label="근거 문서 정보">
          <h3>근거 문서 · 판본 · 쪽</h3>
          ${
            normalizedRefs.length
              ? normalizedRefs
                  .map((ref) => {
                    const meta = findDocMeta(ref.document, ref.version, evidenceDetail);
                    const shortVer = meta?.versionShort || shortenVersion(ref.version);
                    const truncated = shortVer !== ref.version;
                    const pagesText = ref.pages.map((p) => p + '쪽').join(', ');
                    const reasons = (meta?.reasons ?? []).map(evidenceReasonLabel);
                    return `<article class="ev-doc-card">
                      <dl class="hc-detail-dl">
                        <div><dt>문서 식별자</dt><dd><span class="code">${esc(ref.document)}</span></dd></div>
                        <div><dt>판본 해시</dt><dd><span class="code" title="${esc(ref.version)}">${esc(shortVer)}</span>${
                          truncated
                            ? `<details class="ev-full-hash"><summary>전체 판본 보기</summary><span class="code">${esc(ref.version)}</span></details>`
                            : ''
                        }</dd></div>
                        <div><dt>근거 쪽</dt><dd><strong class="num">${esc(pagesText)}</strong></dd></div>
                        <div><dt>확보 경로</dt><dd>${esc(acquisitionLabel(meta?.source ?? (ref.document.startsWith('upload:') ? 'upload' : 'unknown')))}</dd></div>
                        <div><dt>점검 상태</dt><dd>${docStatusBadge(meta, active.status)}${reasons.length ? `<small class="ev-reason-text">${esc(reasons.join(' · '))}</small>` : ''}</dd></div>
                      </dl>
                      ${renderDocAction(meta, ref, dataOrigin, noticeLink, downloadingId, downloadError)}
                    </article>`;
                  })
                  .join('')
              : `<div class="ev-doc-card"><p class="sheet-empty-list">이 값에 연결된 문서 판본·쪽 근거가 없습니다.</p></div>`
          }
        </section>

        ${
          items.length > 1
            ? `<section class="sheet-section" aria-label="이 화면의 다른 근거 항목">
                <h3>이 화면의 다른 근거 항목</h3>
                <div class="ev-sibling-list">${items
                  .map((item) => {
                    const pages = [...new Set(normalizeDocRefs(item.refs).flatMap((d) => d.pages))]
                      .sort((a, b) => a - b)
                      .map((p) => 'p.' + p)
                      .join('·');
                    return `<button type="button" class="ev-sibling-btn" data-evidence-item="${esc(item.id)}" aria-pressed="${item.id === active.id}">
                      <span class="ev-sibling-name">${esc(item.label)}</span>
                      <span class="ev-sibling-meta num">${esc(item.displayValue || '—')}${pages ? ' · ' + esc(pages) : ''}</span>
                    </button>`;
                  })
                  .join('')}</div>
              </section>`
            : ''
        }

        ${
          nonAcceptedDocs.length
            ? `<section class="sheet-section" aria-label="채택되지 않은 문서 기록">
                <h3>채택되지 않은 문서 기록</h3>
                <ul class="scope-reason-list">${nonAcceptedDocs
                  .map(
                    (doc) => `<li>
                      <div class="scope-reason-copy">
                        ${docStatusBadge(doc, doc.status)}
                        <span class="code">${esc(doc.id)}</span>
                        <span class="code muted">${esc(doc.versionShort || shortenVersion(doc.version))}</span>
                      </div>
                      <small class="muted">${esc((doc.reasons ?? []).map(evidenceReasonLabel).join(' · ') || '병합 제외')}</small>
                    </li>`,
                  )
                  .join('')}</ul>
              </section>`
            : ''
        }
      </div>
      <footer class="hc-sheet-foot">
        <button type="button" class="action secondary" data-sheet-close>닫기</button>
      </footer>
    </div>`;
  }

  async function open({ items, activeId, target = null, dataOrigin = 'synthetic', analysisId = null, evidenceDetail = null, trigger = null, runContext = null }) {
    if (!Array.isArray(items) || !items.length) return;
    const token = ++reqToken;
    state = {
      items,
      activeId: items.some((i) => i.id === activeId) ? activeId : items[0].id,
      target,
      dataOrigin,
      analysisId,
      evidenceDetail,
      loading: !evidenceDetail && Boolean(loadEvidence && runContext),
      error: null,
      downloadingId: null,
      downloadError: null,
      trigger,
    };
    renderSheet();
    if (!sheet.open) sheet.showModal();
    sheet.querySelector('[data-sheet-close]')?.focus({ preventScroll: true });
    const active = state.items.find((i) => i.id === state.activeId);
    announce?.(`${active?.label ?? '원문'} 근거를 열었습니다.`);

    if (!evidenceDetail && loadEvidence && runContext) {
      try {
        const loaded = await loadEvidence(runContext);
        if (token !== reqToken || !state) return;
        state.evidenceDetail = loaded;
        state.loading = false;
        renderSheet();
      } catch (err) {
        if (token !== reqToken || !state) return;
        state.loading = false;
        state.error = err;
        renderSheet();
      }
    }
  }

  sheet.addEventListener('click', async (event) => {
    if (sheet.dataset.sheet !== 'evidence' || !state) return;
    if (event.target === sheet) {
      const rect = sheet.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        close();
      }
      return;
    }
    const btn = event.target.closest('button');
    if (!btn) return;
    if (btn.hasAttribute('data-sheet-close')) {
      close();
      return;
    }
    if (btn.dataset.evidenceItem) {
      const next = state.items.find((i) => i.id === btn.dataset.evidenceItem);
      if (!next) return;
      state.activeId = next.id;
      state.downloadError = null;
      renderSheet();
      sheet.querySelector(`[data-evidence-item="${CSS.escape(next.id)}"]`)?.focus({ preventScroll: true });
      announce?.(`${next.label} 근거로 전환했습니다.`);
      return;
    }
    if (btn.dataset.downloadUpload && state.analysisId && downloadUpload && !state.downloadingId) {
      const uploadId = btn.dataset.downloadUpload;
      const token = reqToken;
      state.downloadingId = uploadId;
      state.downloadError = null;
      renderSheet();
      try {
        const blob = await downloadUpload(state.analysisId, uploadId);
        if (token !== reqToken || !state) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `analysis-upload-${uploadId.slice(0, 8)}.pdf`;
        link.rel = 'noopener';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        announce?.('본인 업로드 PDF를 내려받았습니다.');
      } catch (err) {
        if (token !== reqToken || !state) return;
        state.downloadError = { uploadId, error: err };
      } finally {
        if (token === reqToken && state) {
          state.downloadingId = null;
          renderSheet();
        }
      }
    }
  });

  sheet.addEventListener('cancel', (event) => {
    if (sheet.dataset.sheet !== 'evidence') return;
    event.preventDefault();
    close();
  });

  return {
    open,
    close,
    reset() {
      close({ restoreFocus: false });
    },
    isOpen() {
      return Boolean(state && sheet.open && sheet.dataset.sheet === 'evidence');
    },
  };
}
