import * as api from './client.js';
import { badge, errorText, esc, icon } from './display.js';

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SECTION_IDS = new Set(['notice', 'comparison', 'funding', 'law', 'news', 'commute', 'evidence']);
const SECTION_STATES = new Set(['confirmed', 'partial', 'held', 'reference']);
const DATA_ORIGINS = new Set(['collected', 'synthetic']);

const SECTION_META = {
  notice: { icon: 'building-2', fallbackTitle: '공고 요약' },
  comparison: { icon: 'chart-no-axes-combined', fallbackTitle: '비교 결과' },
  funding: { icon: 'calendar-check', fallbackTitle: '호실 자금표' },
  law: { icon: 'library-big', fallbackTitle: '법령 근거' },
  news: { icon: 'file-text', fallbackTitle: '지역 뉴스' },
  commute: { icon: 'map-pin', fallbackTitle: '출퇴근 경로' },
  evidence: { icon: 'database', fallbackTitle: '근거와 수집 시점' },
};

const STATE_META = {
  confirmed: { style: 'verified', symbol: 'circle-check', label: '확인됨', short: '확인' },
  partial: { style: 'partial', symbol: 'chart-pie', label: '일부 확인', short: '일부' },
  held: { style: 'unknown', symbol: 'circle-pause', label: '보류', short: '보류' },
  reference: { style: 'closed', symbol: 'info', label: '참고', short: '참고' },
};

const REPORT_ERRORS = {
  report_not_found: '이 계정에서 조회할 수 있는 저장 보고서가 없습니다. 목록으로 돌아가 다시 확인하세요.',
  report_conflict: '보고서 상태가 변경되었거나 같은 요청이 충돌했습니다. 최신 상태를 확인한 뒤 다시 시도하세요.',
  invalid_report_input: '보고서 요청 정보를 확인할 수 없습니다. 완료된 분석이나 보고서 목록에서 다시 선택하세요.',
  authentication_required: '세션이 만료됐습니다. 다시 로그인하세요.',
  backend_unavailable: '보고서 서비스에 연결할 수 없습니다. 잠시 후 다시 시도하세요.',
};

const kstClock = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const kstShortDate = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null;
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function reportErrorMessage(error) {
  const code = error?.code ?? '';
  if (Object.hasOwn(REPORT_ERRORS, code)) return REPORT_ERRORS[code];
  return errorText(error);
}

function formatKstDateTime(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '시각 미확인';
  const parts = Object.fromEntries(kstClock.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute} KST`;
}

function formatKstDate(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '날짜 미확인';
  const parts = Object.fromEntries(kstShortDate.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}.${parts.month}.${parts.day}`;
}

function timeTag(value) {
  if (!validTimestamp(value)) return '<span>미확인</span>';
  return `<time datetime="${esc(value)}">${esc(formatKstDateTime(value))}</time>`;
}

function buildPdfFilename(reportId, version) {
  const ver = Number.isSafeInteger(version) && version >= 1 ? `v${version}-` : '';
  const suffix = typeof reportId === 'string' ? reportId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) : 'report';
  return `homecierge-report-${ver}${suffix || 'snapshot'}.pdf`;
}

function makeCodeError(code) {
  return Object.assign(new Error(code), { code });
}

function validReportSection(section) {
  if (!isPlainObject(section)) return false;
  if (!SECTION_IDS.has(section.id)) return false;
  if (typeof section.title !== 'string' || !section.title.trim()) return false;
  if (!SECTION_STATES.has(section.state)) return false;
  if (typeof section.exportAllowed !== 'boolean') return false;
  if (!Array.isArray(section.rows)) return false;
  if (
    !section.rows.every(
      (row) => isPlainObject(row) && typeof row.label === 'string' && typeof row.value === 'string',
    )
  )
    return false;
  if (!Array.isArray(section.tables)) return false;
  if (
    !section.tables.every(
      (table) =>
        isPlainObject(table) &&
        Array.isArray(table.headers) &&
        table.headers.every((h) => typeof h === 'string') &&
        Array.isArray(table.rows) &&
        table.rows.every((r) => Array.isArray(r) && r.every((cell) => typeof cell === 'string')),
    )
  )
    return false;
  if (!Array.isArray(section.notes) || !section.notes.every((note) => typeof note === 'string')) return false;
  return true;
}

function validSavedReport(data, { allowSample = false } = {}) {
  if (!isPlainObject(data)) return false;
  if (data.contractVersion !== 'saved-report/v1') return false;
  const idOk = (v) => (allowSample ? typeof v === 'string' && v.length > 0 : Boolean(normalizeUuid(v)));
  const optionalIdOk = (v) => (allowSample ? v === null || (typeof v === 'string' && v.length > 0) : Boolean(normalizeUuid(v)));
  if (!idOk(data.reportId) || !optionalIdOk(data.analysisId) || !optionalIdOk(data.runId) || !optionalIdOk(data.snapshotId))
    return false;
  if (!Number.isSafeInteger(data.version) || data.version < 1) return false;
  if (!validTimestamp(data.createdAt) || !validTimestamp(data.queriedAt)) return false;
  if (!DATA_ORIGINS.has(data.dataOrigin)) return false;
  if (typeof data.title !== 'string' || !data.title.trim()) return false;
  if (!Array.isArray(data.sections) || !data.sections.every(validReportSection)) return false;
  return true;
}

function validListItem(item) {
  if (!isPlainObject(item)) return false;
  if (!normalizeUuid(item.reportId) || !normalizeUuid(item.analysisId) || !normalizeUuid(item.runId)) return false;
  if (!Number.isSafeInteger(item.version) || item.version < 1) return false;
  if (!validTimestamp(item.createdAt)) return false;
  if (!DATA_ORIGINS.has(item.dataOrigin)) return false;
  if (item.title !== undefined && item.title !== null && typeof item.title !== 'string') return false;
  if (item.queriedAt !== undefined && item.queriedAt !== null && !validTimestamp(item.queriedAt)) return false;
  return true;
}

function validListResponse(data) {
  if (!isPlainObject(data)) return false;
  if (!Array.isArray(data.reports) || !data.reports.every(validListItem)) return false;
  if (data.nextCursor !== null && data.nextCursor !== undefined && !normalizeUuid(data.nextCursor)) return false;
  return true;
}

function normalizeListItem(item) {
  return {
    reportId: item.reportId.toLowerCase(),
    analysisId: item.analysisId.toLowerCase(),
    runId: item.runId.toLowerCase(),
    version: item.version,
    createdAt: item.createdAt,
    queriedAt: validTimestamp(item.queriedAt) ? item.queriedAt : null,
    dataOrigin: item.dataOrigin,
    title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : null,
  };
}

function reportSummaryTitle(item) {
  if (item.title) return item.title;
  return `저장 보고서 v${item.version} · ${formatKstDate(item.createdAt)}`;
}

function originBadge(dataOrigin) {
  return dataOrigin === 'synthetic'
    ? badge('closed', 'layers', '합성 자료')
    : badge('verified', 'database', '수집 자료');
}

function sectionStateBadge(state) {
  const meta = STATE_META[state] ?? { style: 'unknown', symbol: 'circle-help', label: '상태 미확인' };
  return badge(meta.style, meta.symbol, meta.label);
}

function permissionChip(exportAllowed) {
  return exportAllowed
    ? `<span class="report-perm is-allowed">${icon('file-text')}PDF 포함</span>`
    : `<span class="report-perm is-excluded">${icon('eye-off')}PDF 제외 · 화면 전용</span>`;
}

function renderSectionTable(table, sectionTitle) {
  const headers = table.headers ?? [];
  const rows = table.rows ?? [];
  if (!headers.length && !rows.length) return '';
  return `<div class="report-table-wrap">
    <table class="report-table" aria-label="${esc(sectionTitle)} 상세 표">
      ${
        headers.length
          ? `<thead><tr>${headers.map((h) => `<th scope="col">${esc(h || '—')}</th>`).join('')}</tr></thead>`
          : ''
      }
      <tbody>
        ${
          rows.length
            ? rows
                .map((cells) => {
                  const colCount = Math.max(headers.length, cells.length);
                  const tds = [];
                  for (let i = 0; i < colCount; i++) {
                    const raw = cells[i];
                    const value = raw !== undefined && raw !== null && raw !== '' ? raw : '—';
                    const label = headers[i] ?? `항목 ${i + 1}`;
                    if (i === 0) {
                      tds.push(`<th scope="row" data-label="${esc(label)}">${esc(value)}</th>`);
                    } else {
                      tds.push(`<td data-label="${esc(label)}">${esc(value)}</td>`);
                    }
                  }
                  return `<tr>${tds.join('')}</tr>`;
                })
                .join('')
            : `<tr><td colspan="${Math.max(1, headers.length)}" class="report-table-empty">기록된 표 항목이 없습니다.</td></tr>`
        }
      </tbody>
    </table>
  </div>`;
}

function safeHttpsUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('https://') || /\s/.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function renderRowValue(value) {
  if (!value) return '—';
  const href = safeHttpsUrl(value);
  if (href) {
    return `<a class="report-ext-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(href)} ${icon('external-link')}</a>`;
  }
  return esc(value);
}

function renderReportSection(section, index, runLinks = null) {
  const meta = SECTION_META[section.id] ?? { icon: 'file-text', fallbackTitle: section.title };
  const headingId = `report-sec-h-${section.id}`;
  const sectionDomId = `report-sec-${section.id}`;
  const hasRows = section.rows.length > 0;
  const hasTables = section.tables.length > 0;
  const hasNotes = section.notes.length > 0;
  const noteIcon = section.state === 'held' ? 'circle-pause' : section.state === 'partial' ? 'chart-pie' : 'info';
  const liveTabLink =
    runLinks && (section.id === 'news' || section.id === 'commute')
      ? `<div class="report-section-foot"><a class="text-button" href="#run/${esc(runLinks.analysisId)}/${esc(runLinks.runId)}/${esc(section.id)}">${section.id === 'news' ? '원래 분석의 지역 뉴스 탭으로 이동' : '원래 분석의 출퇴근 경로 탭으로 이동'} ${icon('arrow-right')}</a></div>`
      : '';

  return `<section id="${esc(sectionDomId)}" class="report-section is-${esc(section.state)}${section.exportAllowed ? '' : ' is-screen-only'}" aria-labelledby="${esc(headingId)}" tabindex="-1" data-section-id="${esc(section.id)}" data-section-state="${esc(section.state)}" data-export-allowed="${section.exportAllowed ? 'true' : 'false'}">
    <header class="report-section-head">
      <div class="report-section-title">
        <span class="report-section-num num" aria-hidden="true">${index + 1}</span>
        ${icon(meta.icon, 'report-section-icon')}
        <h2 id="${esc(headingId)}">${esc(section.title || meta.fallbackTitle)}</h2>
      </div>
      <div class="report-section-badges">
        ${sectionStateBadge(section.state)}
        ${permissionChip(section.exportAllowed)}
      </div>
    </header>

    ${
      !section.exportAllowed
        ? `<p class="report-perm-note">${icon('eye-off')}<span>이 섹션은 출처 이용 조건에 따라 화면에서만 확인하며 PDF 내보내기에는 포함하지 않습니다.</span></p>`
        : ''
    }

    ${
      hasRows
        ? `<dl class="report-dl">${section.rows
            .map(
              (row) => `<div class="report-dl-row">
                <dt>${esc(row.label || '항목')}</dt>
                <dd>${renderRowValue(row.value)}</dd>
              </div>`,
            )
            .join('')}</dl>`
        : ''
    }

    ${hasTables ? section.tables.map((t) => renderSectionTable(t, section.title)).join('') : ''}

    ${
      hasNotes
        ? `<ul class="report-notes">${section.notes
            .map((note) => `<li>${icon(noteIcon)}<span>${esc(note)}</span></li>`)
            .join('')}</ul>`
        : ''
    }

    ${
      !hasRows && !hasTables && !hasNotes
        ? `<p class="report-section-empty">${icon('circle-minus')}<span>이 섹션에 기록된 상세 항목이 없습니다.</span></p>`
        : ''
    }
    ${liveTabLink}
  </section>`;
}

function blank() {
  return {
    active: false,
    ownerId: null,
    ctx: null,
    // 목록 상태
    reports: [],
    nextCursor: null,
    seenCursors: new Set(),
    listLoading: false,
    listError: null,
    loadingMore: false,
    loadMoreError: null,
    // 상세 상태
    detail: null,
    detailLoading: false,
    detailError: null,
    // 저장 상태 (kind === 'run')
    fundingRoom: null,
    saving: false,
    saveError: null,
    saveRetry: null, // { analysisId, runId, fundingRoom, requestId }
    // PDF 내보내기 상태
    exportingId: null,
    exportError: null, // { reportId, error }
    // 개별 보고서 삭제 확인 상태
    confirmDeleteId: null,
    deletingId: null,
    deleteError: null, // { reportId, error }
    // 상단 상태 알림 배너
    banner: null, // { tone, text }
  };
}

export function createReportPage({ root, render, announce = () => {}, user, navigate }) {
  let s = blank();
  let generation = 0;
  let listController = null;
  let moreController = null;
  let detailController = null;
  let saveController = null;
  let exportController = null;
  let deleteController = null;

  function currentUser() {
    return typeof user === 'function' ? user() : user ?? null;
  }

  function go(to) {
    if (typeof navigate === 'function') navigate(to);
    else if (typeof location !== 'undefined') location.hash = to;
  }

  function abortAll() {
    listController?.abort();
    moreController?.abort();
    detailController?.abort();
    saveController?.abort();
    exportController?.abort();
    deleteController?.abort();
    listController = moreController = detailController = saveController = exportController = deleteController = null;
  }

  function reset() {
    ++generation;
    abortAll();
    s = blank();
  }

  function syncView({ focusSelector = null } = {}) {
    const slot = root?.querySelector?.('#report-page-slot');
    if (!slot) {
      render?.();
      if (focusSelector) root?.querySelector?.(focusSelector)?.focus?.({ preventScroll: true });
      return;
    }
    slot.innerHTML = innerView();
    if (focusSelector) {
      slot.querySelector(focusSelector)?.focus?.({ preventScroll: true });
    }
  }

  function normalizeContext(raw) {
    if (!isPlainObject(raw)) return null;
    const kind = ['list', 'detail', 'run'].includes(raw.kind) ? raw.kind : null;
    if (!kind) return null;
    const rooms = Array.isArray(raw.rooms)
      ? [...new Set(raw.rooms.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim()))]
      : [];
    const selectedRoom =
      typeof raw.selectedRoom === 'string' && raw.selectedRoom.trim() ? raw.selectedRoom.trim() : null;
    const fundingRoom =
      typeof raw.fundingRoom === 'string' && raw.fundingRoom.trim() ? raw.fundingRoom.trim() : null;
    return {
      kind,
      reportId: normalizeUuid(raw.reportId),
      rawReportId: typeof raw.reportId === 'string' ? raw.reportId : null,
      analysisId: normalizeUuid(raw.analysisId),
      runId: normalizeUuid(raw.runId),
      guest: Boolean(raw.guest),
      sampleReport: raw.sampleReport ?? null,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : null,
      rooms,
      selectedRoom,
      fundingRoom,
    };
  }

  function isSameContext(next, ownerId) {
    if (!s.active || !s.ctx || !next) return false;
    return (
      s.ownerId === ownerId &&
      s.ctx.kind === next.kind &&
      s.ctx.reportId === next.reportId &&
      s.ctx.rawReportId === next.rawReportId &&
      s.ctx.analysisId === next.analysisId &&
      s.ctx.runId === next.runId &&
      s.ctx.guest === next.guest &&
      s.ctx.sampleReport === next.sampleReport &&
      s.ctx.title === next.title &&
      s.ctx.selectedRoom === next.selectedRoom &&
      s.ctx.fundingRoom === next.fundingRoom &&
      s.ctx.rooms.length === next.rooms.length &&
      s.ctx.rooms.every((room, idx) => room === next.rooms[idx])
    );
  }

  function assertApiMethod(name) {
    if (typeof api[name] !== 'function') throw makeCodeError('backend_unavailable');
    return api[name];
  }

  async function loadList({ silent = false } = {}) {
    const owner = currentUser()?.id;
    if (!owner || !s.active || owner !== s.ownerId) return;
    const token = generation;
    listController?.abort();
    const controller = new AbortController();
    listController = controller;
    s.listLoading = true;
    s.listError = null;
    if (!silent) syncView();
    try {
      const listFn = assertApiMethod('listSavedReports');
      const data = await listFn(controller.signal, null);
      if (token !== generation || listController !== controller || currentUser()?.id !== owner) return;
      if (!validListResponse(data)) throw makeCodeError('backend_unavailable');
      s.reports = data.reports.map(normalizeListItem);
      s.nextCursor = data.nextCursor ? data.nextCursor.toLowerCase() : null;
      s.seenCursors = new Set();
      s.loadMoreError = null;
      s.listError = null;
    } catch (error) {
      if (token !== generation || listController !== controller || currentUser()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      s.listError = error;
    } finally {
      if (token === generation && listController === controller) {
        listController = null;
        s.listLoading = false;
        syncView();
      }
    }
  }

  async function loadMoreReports() {
    const owner = currentUser()?.id;
    if (!owner || !s.active || owner !== s.ownerId || !s.nextCursor || s.loadingMore) return;
    const cursor = s.nextCursor;
    if (s.seenCursors.has(cursor)) {
      s.nextCursor = null;
      syncView();
      return;
    }
    const token = generation;
    moreController?.abort();
    const controller = new AbortController();
    moreController = controller;
    s.loadingMore = true;
    s.loadMoreError = null;
    syncView();
    try {
      const listFn = assertApiMethod('listSavedReports');
      const data = await listFn(controller.signal, cursor);
      if (token !== generation || moreController !== controller || currentUser()?.id !== owner) return;
      if (!validListResponse(data)) throw makeCodeError('backend_unavailable');
      s.seenCursors.add(cursor);
      const existing = new Set(s.reports.map((r) => r.reportId));
      for (const item of data.reports) {
        const normalized = normalizeListItem(item);
        if (!existing.has(normalized.reportId)) {
          s.reports.push(normalized);
          existing.add(normalized.reportId);
        }
      }
      const next = data.nextCursor ? data.nextCursor.toLowerCase() : null;
      s.nextCursor = next && !s.seenCursors.has(next) ? next : null;
      s.loadMoreError = null;
    } catch (error) {
      if (token !== generation || moreController !== controller || currentUser()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      s.loadMoreError = error;
    } finally {
      if (token === generation && moreController === controller) {
        moreController = null;
        s.loadingMore = false;
        syncView();
      }
    }
  }

  async function loadDetail(reportId, { silent = false } = {}) {
    const owner = currentUser()?.id;
    if (!owner || !s.active || owner !== s.ownerId) return;
    const normalizedId = normalizeUuid(reportId);
    if (!normalizedId) {
      s.detailError = makeCodeError('invalid_report_input');
      s.detail = null;
      s.detailLoading = false;
      if (!silent) syncView();
      return;
    }
    const token = generation;
    detailController?.abort();
    const controller = new AbortController();
    detailController = controller;
    s.detailLoading = true;
    s.detailError = null;
    if (!silent) syncView();
    try {
      const readFn = assertApiMethod('readSavedReport');
      const data = await readFn(normalizedId, controller.signal);
      if (token !== generation || detailController !== controller || currentUser()?.id !== owner) return;
      if (!validSavedReport(data) || data.reportId.toLowerCase() !== normalizedId) {
        throw makeCodeError('backend_unavailable');
      }
      s.detail = {
        ...data,
        reportId: data.reportId.toLowerCase(),
        analysisId: data.analysisId.toLowerCase(),
        runId: data.runId.toLowerCase(),
        snapshotId: data.snapshotId.toLowerCase(),
      };
      s.detailError = null;
    } catch (error) {
      if (token !== generation || detailController !== controller || currentUser()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      s.detail = null;
      s.detailError = error;
    } finally {
      if (token === generation && detailController === controller) {
        detailController = null;
        s.detailLoading = false;
        syncView();
      }
    }
  }

  async function saveCurrentRunReport() {
    const owner = currentUser()?.id;
    if (!owner || !s.active || owner !== s.ownerId || s.ctx?.kind !== 'run' || s.ctx.guest || s.saving) return;
    const { analysisId, runId, selectedRoom, rooms } = s.ctx;
    if (!analysisId || !runId) {
      s.saveError = makeCodeError('invalid_report_input');
      syncView();
      return;
    }
    const chosenFundingRoom =
      selectedRoom === null && s.fundingRoom && rooms.includes(s.fundingRoom) ? s.fundingRoom : null;
    const reuse =
      s.saveRetry &&
      s.saveRetry.analysisId === analysisId &&
      s.saveRetry.runId === runId &&
      s.saveRetry.fundingRoom === chosenFundingRoom
        ? s.saveRetry.requestId
        : null;
    const requestId = reuse ?? crypto.randomUUID();
    s.saveRetry = { analysisId, runId, fundingRoom: chosenFundingRoom, requestId };

    const token = generation;
    saveController?.abort();
    const controller = new AbortController();
    saveController = controller;
    s.saving = true;
    s.saveError = null;
    s.banner = null;
    syncView();

    try {
      const saveFn = assertApiMethod('saveAnalysisReport');
      const saved = await saveFn(analysisId, runId, requestId, controller.signal, chosenFundingRoom);
      if (token !== generation || saveController !== controller || currentUser()?.id !== owner) return;
      if (
        !validSavedReport(saved) ||
        saved.analysisId.toLowerCase() !== analysisId ||
        saved.runId.toLowerCase() !== runId
      ) {
        throw makeCodeError('backend_unavailable');
      }
      const savedId = saved.reportId.toLowerCase();
      s.saveRetry = null;
      s.saveError = null;
      s.saving = false;
      saveController = null;
      const summary = normalizeListItem({
        reportId: savedId,
        analysisId,
        runId,
        version: saved.version,
        createdAt: saved.createdAt,
        queriedAt: saved.queriedAt,
        dataOrigin: saved.dataOrigin,
        title: saved.title,
      });
      s.reports = [summary, ...s.reports.filter((item) => item.reportId !== savedId)];
      s.banner = { tone: 'verified', text: `보고서 v${saved.version}을 저장했습니다.` };
      announce(`보고서 v${saved.version}을 저장했습니다.`);
      syncView();
      go(`#reports/${savedId}`);
    } catch (error) {
      if (token !== generation || saveController !== controller || currentUser()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      s.saving = false;
      saveController = null;
      s.saveError = error;
      if (error?.code === 'invalid_report_input' || error?.code === 'report_not_found') {
        s.saveRetry = null;
      }
      announce(reportErrorMessage(error));
      syncView({ focusSelector: '[data-report="retry-save"], [data-report="save-run"]' });
    }
  }

  async function downloadPdf(reportId, version = null) {
    const owner = currentUser()?.id;
    const normalizedId = normalizeUuid(reportId);
    if (!owner || !s.active || owner !== s.ownerId || !normalizedId || s.exportingId) return;
    const token = generation;
    exportController?.abort();
    const controller = new AbortController();
    exportController = controller;
    s.exportingId = normalizedId;
    s.exportError = null;
    syncView();

    try {
      const downloadFn = assertApiMethod('downloadSavedReport');
      const blob = await downloadFn(normalizedId, controller.signal);
      if (token !== generation || exportController !== controller || currentUser()?.id !== owner) return;
      if (!(blob instanceof Blob)) throw makeCodeError('backend_unavailable');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = buildPdfFilename(normalizedId, version);
      link.rel = 'noopener';
      link.style.display = 'none';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      s.banner = { tone: 'verified', text: '보고서 PDF 다운로드를 시작했습니다.' };
      announce('보고서 PDF 다운로드를 시작했습니다.');
    } catch (error) {
      if (token !== generation || exportController !== controller || currentUser()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      s.exportError = { reportId: normalizedId, error };
      announce(reportErrorMessage(error));
    } finally {
      if (token === generation && exportController === controller) {
        exportController = null;
        s.exportingId = null;
        syncView();
      }
    }
  }

  async function executeDelete(reportId) {
    const owner = currentUser()?.id;
    const normalizedId = normalizeUuid(reportId);
    if (!owner || !s.active || owner !== s.ownerId || !normalizedId || s.deletingId) return;
    const token = generation;
    deleteController?.abort();
    const controller = new AbortController();
    deleteController = controller;
    s.deletingId = normalizedId;
    s.deleteError = null;
    syncView();

    try {
      const deleteFn = assertApiMethod('deleteSavedReport');
      await deleteFn(normalizedId, controller.signal);
      if (token !== generation || deleteController !== controller || currentUser()?.id !== owner) return;
      deleteController = null;
      s.deletingId = null;
      s.confirmDeleteId = null;
      s.deleteError = null;
      s.reports = s.reports.filter((item) => item.reportId !== normalizedId);
      if (s.exportError?.reportId === normalizedId) s.exportError = null;
      announce('저장 보고서를 삭제했습니다.');
      if (s.ctx?.kind === 'detail' && s.ctx.reportId === normalizedId) {
        s.detail = null;
        s.banner = { tone: 'verified', text: '저장 보고서를 삭제했습니다. 목록으로 이동합니다.' };
        syncView();
        go('#reports');
      } else {
        s.banner = { tone: 'verified', text: '저장 보고서를 삭제했습니다.' };
        syncView({ focusSelector: '#report-banner' });
      }
    } catch (error) {
      if (token !== generation || deleteController !== controller || currentUser()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      deleteController = null;
      s.deletingId = null;
      s.deleteError = { reportId: normalizedId, error };
      announce(reportErrorMessage(error));
      syncView({ focusSelector: `#delete-confirm-${normalizedId} [data-report="cancel-delete"]` });
    }
  }

  function enter(rawContext) {
    const next = normalizeContext(rawContext);
    if (!next) {
      reset();
      return;
    }
    const owner = currentUser()?.id ?? null;
    if (isSameContext(next, owner)) return;

    reset();
    s.active = true;
    s.ownerId = owner;
    s.ctx = next;

    if (next.kind === 'list') {
      if (owner) void loadList({ silent: true });
    } else if (next.kind === 'detail') {
      if (owner) {
        if (next.reportId) void loadDetail(next.reportId, { silent: true });
        else s.detailError = makeCodeError('invalid_report_input');
      }
    } else if (next.kind === 'run') {
      if (!next.guest && owner) {
        if (!next.selectedRoom && next.fundingRoom && next.rooms.includes(next.fundingRoom)) {
          s.fundingRoom = next.fundingRoom;
        }
        if (next.analysisId && next.runId) {
          void loadList({ silent: true });
        }
      }
    }
    syncView();
  }

  function renderDeleteConfirmation(reportId, label) {
    const busy = s.deletingId === reportId;
    const err = s.deleteError?.reportId === reportId ? s.deleteError.error : null;
    const isAuth = err?.code === 'authentication_required';
    return `<div id="delete-confirm-${esc(reportId)}" class="report-delete-confirm" role="alertdialog" aria-modal="false" aria-labelledby="delete-title-${esc(reportId)}" aria-describedby="delete-desc-${esc(reportId)}" data-delete-confirm="${esc(reportId)}">
      <div class="report-delete-copy">
        ${icon('triangle-alert')}
        <div>
          <h3 id="delete-title-${esc(reportId)}">${esc(label)}을 삭제할까요?</h3>
          <p id="delete-desc-${esc(reportId)}">삭제한 보고서는 저장 목록에서 제거되며 복구할 수 없습니다. 원본 분석 실행과 대화 기록은 유지됩니다.</p>
        </div>
      </div>
      ${
        err
          ? `<div class="report-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(reportErrorMessage(err))}</p>${
              isAuth ? '<button type="button" class="action secondary compact" data-action="auth">다시 로그인</button>' : ''
            }</div></div>`
          : ''
      }
      <div class="report-delete-actions">
        <button type="button" class="action secondary compact" data-report="cancel-delete" data-report-id="${esc(reportId)}"${busy ? ' disabled' : ''}>삭제 취소</button>
        <button type="button" class="action report-danger-solid compact" data-report="confirm-delete" data-report-id="${esc(reportId)}"${busy ? ' disabled' : ''}>${icon(busy ? 'loader-circle' : 'x', busy ? 'spin' : '')}${busy ? '삭제 중' : '이 보고서 삭제'}</button>
      </div>
    </div>`;
  }

  function renderBanner() {
    if (!s.banner) return '';
    const symbol = s.banner.tone === 'verified' ? 'circle-check' : s.banner.tone === 'partial' ? 'triangle-alert' : 'info';
    return `<div id="report-banner" class="report-banner is-${esc(s.banner.tone)}" role="status" tabindex="-1">${icon(symbol)}<span>${esc(s.banner.text)}</span></div>`;
  }

  function renderSavedDocument(report, { sample = false } = {}) {
    const isExporting = !sample && s.exportingId === report.reportId;
    const exportErr = !sample && s.exportError?.reportId === report.reportId ? s.exportError.error : null;
    const isConfirmingDelete = !sample && s.confirmDeleteId === report.reportId;
    const hasRunLink = !sample && Boolean(normalizeUuid(report.analysisId) && normalizeUuid(report.runId));

    const headerActions = sample
      ? `<div class="report-doc-actions">
          <button type="button" class="action primary compact" data-action="auth">${icon('log-in')}로그인하고 보고서 저장</button>
        </div>`
      : `<div class="report-doc-actions">
          ${
            hasRunLink
              ? `<a class="action secondary compact" href="#run/${esc(report.analysisId)}/${esc(report.runId)}">${icon('arrow-left')}원본 분석으로</a>`
              : ''
          }
          <a class="action secondary compact" href="#reports">${icon('list')}보고서 목록</a>
          <button type="button" class="action primary compact" data-report="download-pdf" data-report-id="${esc(report.reportId)}" data-version="${esc(report.version)}"${isExporting || Boolean(s.exportingId) ? ' disabled' : ''}>${icon(isExporting ? 'loader-circle' : 'file-text', isExporting ? 'spin' : '')}${isExporting ? 'PDF 준비 중' : 'PDF 내보내기'}</button>
          <button type="button" class="action report-danger-btn compact" data-report="ask-delete" data-report-id="${esc(report.reportId)}" aria-expanded="${isConfirmingDelete}" aria-controls="delete-confirm-${esc(report.reportId)}"${s.deletingId === report.reportId ? ' disabled' : ''}>${icon('x')}보고서 삭제</button>
        </div>`;

    const tocHtml = report.sections.length
      ? `<nav class="report-toc" aria-label="보고서 섹션 바로가기">
          ${report.sections
            .map((sec, idx) => {
              const st = STATE_META[sec.state] ?? { style: 'unknown', short: '미확인' };
              return `<button type="button" class="report-toc-btn" data-report="jump-section" data-section-id="${esc(sec.id)}">
                <span class="report-toc-num num">${idx + 1}</span>
                <span class="report-toc-label">${esc(sec.title)}</span>
                <span class="report-toc-state is-${esc(st.style)}">${esc(st.short)}</span>
                ${sec.exportAllowed ? '' : '<span class="report-toc-screen" title="PDF 제외">화면 전용</span>'}
              </button>`;
            })
            .join('')}
        </nav>`
      : '';

    const docMetaRow = sample
      ? `<div class="report-sample-strip" role="note">
          ${originBadge('synthetic')}
          <span>로그인하면 실제 분석 보고서를 저장하고 PDF로 내보낼 수 있습니다.</span>
        </div>`
      : `<div class="tag-row report-doc-tags">
          <span class="report-version-pill num">v${esc(report.version)}</span>
          ${originBadge(report.dataOrigin)}
        </div>`;

    return `<article class="report-document" aria-labelledby="report-doc-title" data-report-id="${esc(report.reportId)}" data-report-origin="${esc(report.dataOrigin)}" data-sample="${sample ? 'true' : 'false'}">
        <header class="report-doc-head">
          <div class="report-doc-top">
            <div class="report-doc-copy">
              ${docMetaRow}
              <h1 id="report-doc-title">${esc(report.title)}</h1>
            </div>
            ${headerActions}
          </div>
          <dl class="report-timestamps">
            <div>
              <dt>보고서 저장 시각</dt>
              <dd>${timeTag(report.createdAt)}</dd>
            </div>
            <div>
              <dt>원자료 수집본 저장</dt>
              <dd>${timeTag(report.queriedAt)}</dd>
            </div>
          </dl>
        </header>

        ${
          exportErr
            ? `<div class="report-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(reportErrorMessage(exportErr))}</p><div class="report-error-actions">${
                exportErr.code === 'authentication_required'
                  ? '<button type="button" class="action secondary compact" data-action="auth">다시 로그인</button>'
                  : `<button type="button" class="action secondary compact" data-report="download-pdf" data-report-id="${esc(report.reportId)}" data-version="${esc(report.version)}">PDF 다시 내보내기</button>`
              }</div></div></div>`
            : ''
        }

        ${isConfirmingDelete ? renderDeleteConfirmation(report.reportId, `${report.title} (v${report.version})`) : ''}

        ${tocHtml}

        <div class="report-sections">
          ${
            report.sections.length
              ? report.sections
                  .map((sec, idx) =>
                    renderReportSection(
                      sec,
                      idx,
                      hasRunLink ? { analysisId: report.analysisId, runId: report.runId } : null,
                    ),
                  )
                  .join('')
              : `<div class="report-section-empty">${icon('circle-minus')}<span>표시할 보고서 섹션이 없습니다.</span></div>`
          }
        </div>
      </article>`;
  }

  function renderReportCard(item) {
    const title = reportSummaryTitle(item);
    const isConfirming = s.confirmDeleteId === item.reportId;
    const isExporting = s.exportingId === item.reportId;
    const exportErr = s.exportError?.reportId === item.reportId ? s.exportError.error : null;

    return `<article class="panel report-list-card" data-report-card="${esc(item.reportId)}">
      <div class="report-card-main">
        <div class="report-card-top">
          <span class="report-version-pill num">v${esc(item.version)}</span>
          ${originBadge(item.dataOrigin)}
        </div>
        <h2><a class="report-card-link" href="#reports/${esc(item.reportId)}">${esc(title)}</a></h2>
        <dl class="report-card-meta">
          <div><dt>저장 시각</dt><dd>${timeTag(item.createdAt)}</dd></div>
          ${item.queriedAt ? `<div><dt>원자료 수집본 저장</dt><dd>${timeTag(item.queriedAt)}</dd></div>` : ''}
        </dl>
      </div>
      <div class="report-card-actions">
        <a class="action primary compact" href="#reports/${esc(item.reportId)}">보고서 열기 ${icon('arrow-right')}</a>
        <a class="action secondary compact" href="#run/${esc(item.analysisId)}/${esc(item.runId)}">원본 분석</a>
        <button type="button" class="action secondary compact" data-report="download-pdf" data-report-id="${esc(item.reportId)}" data-version="${esc(item.version)}"${isExporting || Boolean(s.exportingId) ? ' disabled' : ''}>${icon(isExporting ? 'loader-circle' : 'file-text', isExporting ? 'spin' : '')}${isExporting ? 'PDF 준비 중' : 'PDF'}</button>
        <button type="button" class="action report-danger-btn compact" data-report="ask-delete" data-report-id="${esc(item.reportId)}" aria-expanded="${isConfirming}" aria-controls="delete-confirm-${esc(item.reportId)}"${s.deletingId === item.reportId ? ' disabled' : ''}>${icon('x')}삭제</button>
      </div>
      ${
        exportErr
          ? `<div class="report-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(reportErrorMessage(exportErr))}</p><button type="button" class="action secondary compact" data-report="download-pdf" data-report-id="${esc(item.reportId)}" data-version="${esc(item.version)}">PDF 다시 내보내기</button></div></div>`
          : ''
      }
      ${isConfirming ? renderDeleteConfirmation(item.reportId, title) : ''}
    </article>`;
  }

  function renderGuestGate(heading, description, showSampleLink = true) {
    return `<div class="report-page">
      <header class="section-header report-page-header">
        <div>
          <h1>저장 보고서</h1>
          <p>분석 결과를 보고서로 저장해 다시 열고 PDF로 내보낼 수 있습니다.</p>
        </div>
      </header>
      <section class="empty-state report-empty" aria-labelledby="report-guest-heading">
        ${icon('shield-check')}
        <h2 id="report-guest-heading">${esc(heading)}</h2>
        <p>${esc(description)}</p>
        <div class="report-empty-actions">
          <button type="button" class="action primary" data-action="auth">${icon('log-in')}로그인하기</button>
          ${showSampleLink ? '<a class="action secondary" href="#sample/saved/report">예시 보고서 보기</a>' : ''}
          <a class="action secondary" href="#notices">오늘의 청약</a>
        </div>
      </section>
    </div>`;
  }

  function renderListView() {
    const owner = currentUser();
    if (!owner || (s.ownerId && owner.id !== s.ownerId)) {
      return renderGuestGate(
        '로그인 후 저장 보고서를 확인할 수 있습니다',
        '저장 보고서는 계정별로 분리되어 보관됩니다. 로그인하면 내가 저장한 보고서 목록을 보고 PDF로 내보낼 수 있습니다.',
      );
    }

    const header = `<header class="report-page-header">
      <div>
        <h1 id="report-list-heading" tabindex="-1">저장 보고서</h1>
        <p>완료된 분석에서 직접 저장한 보고서 목록입니다. 각 보고서의 버전과 저장 시각을 확인하고 다시 열 수 있습니다.</p>
      </div>
      <div class="report-header-actions">
        <a class="action secondary compact" href="#analyses">${icon('folder-open')}내 분석</a>
        <button type="button" class="action secondary compact" data-report="reload-list"${s.listLoading ? ' disabled' : ''}>${icon(s.listLoading ? 'loader-circle' : 'refresh-cw', s.listLoading ? 'spin' : '')}새로고침</button>
      </div>
    </header>`;

    let body;
    if (s.listLoading && !s.reports.length) {
      body = `<section class="empty-state report-empty" role="status">${icon('loader-circle', 'spin')}<h2>저장 보고서를 불러오고 있습니다</h2><p>계정에 저장된 보고서 목록을 확인하는 중입니다.</p></section>`;
    } else if (s.listError && !s.reports.length) {
      const isAuth = s.listError.code === 'authentication_required';
      body = `<section class="empty-state report-empty" role="alert">
        ${icon('triangle-alert')}
        <h2>저장 보고서 목록을 불러오지 못했습니다</h2>
        <p>${esc(reportErrorMessage(s.listError))}</p>
        <div class="report-empty-actions">
          ${
            isAuth
              ? '<button type="button" class="action primary" data-action="auth">다시 로그인</button>'
              : '<button type="button" class="action secondary" data-report="reload-list">다시 조회</button>'
          }
        </div>
      </section>`;
    } else if (!s.reports.length) {
      body = `<section class="empty-state report-empty">
        ${icon('file-text')}
        <h2>아직 저장된 보고서가 없습니다</h2>
        <p>완료된 분석의 보고서 탭에서 ‘이 분석 결과 보고서로 저장’을 선택하면 여기에 기록됩니다. 보고서는 자동으로 생성되지 않습니다.</p>
        <div class="report-empty-actions">
          <a class="action primary" href="#analyses">내 분석 열기</a>
          <a class="action secondary" href="#notices">오늘의 청약</a>
        </div>
      </section>`;
    } else {
      body = `${
        s.listError
          ? `<div class="report-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(reportErrorMessage(s.listError))}</p><button type="button" class="action secondary compact" data-report="reload-list">다시 조회</button></div></div>`
          : ''
      }
      <div class="report-list-grid" aria-label="저장 보고서 목록">
        ${s.reports.map(renderReportCard).join('')}
      </div>
      ${
        s.loadMoreError
          ? `<div class="report-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(reportErrorMessage(s.loadMoreError))}</p><button type="button" class="action secondary compact" data-report="load-more">다시 불러오기</button></div></div>`
          : ''
      }
      ${
        s.nextCursor
          ? `<div class="report-list-more">
              <button type="button" class="action secondary" data-report="load-more"${s.loadingMore ? ' disabled' : ''}>${icon(s.loadingMore ? 'loader-circle' : 'chevron-down', s.loadingMore ? 'spin' : '')}${s.loadingMore ? '이전 보고서를 불러오는 중' : '이전 보고서 더 불러오기'}</button>
            </div>`
          : ''
      }`;
    }

    return `<div class="report-page">${header}${renderBanner()}${body}</div>`;
  }

  function renderDetailView() {
    const owner = currentUser();
    if (!owner || (s.ownerId && owner.id !== s.ownerId)) {
      return renderGuestGate(
        '로그인 후 저장 보고서를 열 수 있습니다',
        '이 보고서는 저장한 계정에서만 조회할 수 있습니다. 해당 계정으로 로그인하세요.',
      );
    }

    if (s.detailLoading && !s.detail) {
      return `<div class="report-page">
        <div class="report-detail-nav"><a class="action secondary compact" href="#reports">${icon('arrow-left')}저장 보고서 목록</a></div>
        <section class="empty-state report-empty" role="status">${icon('loader-circle', 'spin')}<h2>저장 보고서를 불러오고 있습니다</h2><p>고정된 보고서 스냅샷과 섹션 상태를 확인하는 중입니다.</p></section>
      </div>`;
    }

    if (s.detailError && !s.detail) {
      const code = s.detailError.code;
      const isAuth = code === 'authentication_required';
      const isNotFound = code === 'report_not_found' || code === 'invalid_report_input';
      return `<div class="report-page">
        <div class="report-detail-nav"><a class="action secondary compact" href="#reports">${icon('arrow-left')}저장 보고서 목록</a></div>
        <section class="empty-state report-empty" role="alert">
          ${icon(isNotFound ? 'circle-help' : 'triangle-alert')}
          <h2>${isNotFound ? '저장 보고서를 찾을 수 없습니다' : '저장 보고서를 불러오지 못했습니다'}</h2>
          <p>${esc(reportErrorMessage(s.detailError))}</p>
          <div class="report-empty-actions">
            ${
              isAuth
                ? '<button type="button" class="action primary" data-action="auth">다시 로그인</button>'
                : isNotFound
                  ? '<a class="action primary" href="#reports">저장 보고서 목록으로</a>'
                  : '<button type="button" class="action secondary" data-report="reload-detail">다시 조회</button>'
            }
          </div>
        </section>
      </div>`;
    }

    if (!s.detail) {
      return `<div class="report-page">${renderBanner()}<div class="report-detail-nav"><a class="action primary" href="#reports">저장 보고서 목록으로</a></div></div>`;
    }

    return `<div class="report-page">${renderBanner()}${renderSavedDocument(s.detail, { sample: false })}</div>`;
  }

  function renderRunView() {
    const ctx = s.ctx;
    if (ctx.guest) {
      if (ctx.sampleReport && validSavedReport(ctx.sampleReport, { allowSample: true })) {
        return `<div class="report-page">${renderSavedDocument(ctx.sampleReport, { sample: true })}</div>`;
      }
      return `<div class="report-page">
        <section class="empty-state report-empty" aria-labelledby="report-sample-missing">
          ${icon('file-text')}
          <h2 id="report-sample-missing">예시 보고서를 준비하고 있습니다</h2>
          <p>로그인하고 실제 공고를 분석하면 결과 화면에서 직접 보고서를 저장하고 PDF로 내보낼 수 있습니다.</p>
          <div class="report-empty-actions">
            <button type="button" class="action primary" data-action="auth">${icon('log-in')}로그인하고 분석하기</button>
            <a class="action secondary" href="#notices">오늘의 청약</a>
          </div>
        </section>
      </div>`;
    }

    const owner = currentUser();
    if (!owner || (s.ownerId && owner.id !== s.ownerId)) {
      return renderGuestGate(
        '로그인 후 이 분석의 보고서를 저장할 수 있습니다',
        '분석을 실행한 계정으로 로그인하면 보고서를 저장하고 PDF로 내보낼 수 있습니다.',
        false,
      );
    }

    const validRun = Boolean(ctx.analysisId && ctx.runId);
    const matchingReports = validRun
      ? s.reports.filter((item) => item.analysisId === ctx.analysisId && item.runId === ctx.runId)
      : [];
    const activeFundingRoom =
      ctx.selectedRoom === null && s.fundingRoom && ctx.rooms.includes(s.fundingRoom) ? s.fundingRoom : null;
    const hasRetry = Boolean(
      s.saveRetry &&
        s.saveRetry.analysisId === ctx.analysisId &&
        s.saveRetry.runId === ctx.runId &&
        s.saveRetry.fundingRoom === activeFundingRoom,
    );
    const saveIsAuth = s.saveError?.code === 'authentication_required';
    const hasRoomSelector = Boolean(ctx.selectedRoom || ctx.rooms.length > 0);
    const fundingSelectorHtml = hasRoomSelector
      ? `<div class="report-funding-choice">
          <div class="report-funding-head">
            <label for="report-funding-room">자금표에 포함할 호실</label>
            ${
              ctx.selectedRoom
                ? badge('closed', 'bookmark', '원래 실행 호실 고정')
                : `<span class="report-funding-opt">선택 사항</span>`
            }
          </div>
          ${
            ctx.selectedRoom
              ? `<select id="report-funding-room" name="fundingRoom" data-report-field="funding-room" disabled aria-describedby="report-funding-room-help">
                  <option value="${esc(ctx.selectedRoom)}" selected>${esc(ctx.selectedRoom)}</option>
                </select>
                <p id="report-funding-room-help" class="report-funding-help">이 분석 실행에서 지정한 단일 호실이 그대로 적용됩니다. 원래 비교 결과의 기준과 범위도 저장된 그대로 유지됩니다.</p>`
              : `<select id="report-funding-room" name="fundingRoom" data-report-field="funding-room"${s.saving || !validRun ? ' disabled' : ''} aria-describedby="report-funding-room-help">
                  <option value=""${activeFundingRoom === null ? ' selected' : ''}>선택 안 함 (자금표 호실 미지정)</option>
                  ${ctx.rooms
                    .map(
                      (room) =>
                        `<option value="${esc(room)}"${activeFundingRoom === room ? ' selected' : ''}>${esc(room)}</option>`,
                    )
                    .join('')}
                </select>
                <p id="report-funding-room-help" class="report-funding-help">호실을 고르면 해당 호실의 자금표를 보고서에 함께 저장합니다. 이 선택은 자금표에만 적용되며 원래 비교 결과의 저장 범위는 바뀌지 않습니다.</p>`
          }
        </div>`
      : '';

    return `<div class="report-page">
      ${renderBanner()}
      <section class="panel report-save-card" aria-labelledby="report-save-heading">
        <div class="report-save-head">
          <div class="report-save-copy">
            <h1 id="report-save-heading">${esc(ctx.title ? `${ctx.title} 보고서` : '종합 보고서 저장')}</h1>
            <p>현재 완료된 분석의 공고 요약, 비교 결과, 자금표, 법령, 뉴스, 출퇴근 경로와 수집 근거를 보고서로 저장합니다.</p>
          </div>
          <div class="report-save-cta">
            <button type="button" class="action primary" data-report="save-run"${s.saving || !validRun ? ' disabled' : ''}>${icon(s.saving ? 'loader-circle' : 'file-text', s.saving ? 'spin' : '')}${s.saving ? '보고서 저장 중' : '이 분석 결과 보고서로 저장'}</button>
            <div class="report-save-subactions">
              ${
                validRun
                  ? `<a class="action secondary compact" href="#run/${esc(ctx.analysisId)}/${esc(ctx.runId)}">${icon('arrow-left')}비교 결과로 돌아가기</a>`
                  : ''
              }
              <a class="action secondary compact" href="#reports">${icon('list')}전체 저장 보고서</a>
            </div>
          </div>
        </div>

        ${fundingSelectorHtml}

        <ul class="report-save-facts">
          <li>${icon('circle-check')}<span>보고서는 자동으로 생성되거나 내보내지지 않으며, 위 버튼을 누를 때만 저장합니다.</span></li>
          <li>${icon('shield-check')}<span>공유 프로필 변경이나 실시간 뉴스·경로 조회가 저장한 보고서를 자동으로 덮어쓰지 않습니다.</span></li>
          <li>${icon('eye-off')}<span>출처 이용 조건상 PDF 제외 섹션은 저장 보고서 화면에서만 표시합니다.</span></li>
        </ul>

        ${
          !validRun
            ? `<div class="report-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(REPORT_ERRORS.invalid_report_input)}</p></div></div>`
            : ''
        }

        ${
          s.saveError
            ? `<div class="report-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(reportErrorMessage(s.saveError))}</p><div class="report-error-actions">${
                saveIsAuth
                  ? '<button type="button" class="action secondary compact" data-action="auth">다시 로그인</button>'
                  : hasRetry
                    ? `<button type="button" class="action secondary compact" data-report="retry-save"${s.saving ? ' disabled' : ''}>${icon('refresh-cw')}같은 요청으로 다시 시도</button>`
                    : `<button type="button" class="action secondary compact" data-report="save-run"${s.saving ? ' disabled' : ''}>다시 저장</button>`
              }</div></div></div>`
            : ''
        }
      </section>

      <section class="report-run-existing" aria-labelledby="report-run-list-heading">
        <div class="report-section-bar">
          <div>
            <h2 id="report-run-list-heading">이 실행에서 저장한 보고서</h2>
            <p>이전에 저장한 버전이 있으면 바로 열어보거나 PDF로 내보낼 수 있습니다.</p>
          </div>
          <button type="button" class="action secondary compact" data-report="reload-list"${s.listLoading ? ' disabled' : ''}>${icon(s.listLoading ? 'loader-circle' : 'refresh-cw', s.listLoading ? 'spin' : '')}목록 새로고침</button>
        </div>

        ${
          s.listLoading && !matchingReports.length
            ? `<div class="panel report-quiet-state" role="status">${icon('loader-circle', 'spin')}<span>이 실행의 저장 보고서를 확인하고 있습니다.</span></div>`
            : s.listError && !matchingReports.length
              ? `<div class="report-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(reportErrorMessage(s.listError))}</p><button type="button" class="action secondary compact" data-report="reload-list">목록 다시 조회</button></div></div>`
              : matchingReports.length
                ? `<div class="report-list-grid">${matchingReports.map(renderReportCard).join('')}</div>`
                : `<div class="panel report-quiet-state">${icon('info')}<span>이 실행으로 저장한 보고서가 아직 없습니다. 위 버튼으로 첫 보고서를 저장하세요.</span></div>`
        }
      </section>
    </div>`;
  }

  function innerView() {
    if (!s.active || !s.ctx) return '';
    if (s.ctx.kind === 'list') return renderListView();
    if (s.ctx.kind === 'detail') return renderDetailView();
    if (s.ctx.kind === 'run') return renderRunView();
    return '';
  }

  function view() {
    return `<div id="report-page-slot">${innerView()}</div>`;
  }

  root?.addEventListener?.('click', (event) => {
    if (!s.active) return;
    const btn = event.target?.closest?.('[data-report]');
    if (!btn || !root.contains(btn)) return;
    const action = btn.dataset.report;

    if (action === 'jump-section') {
      const secId = btn.dataset.sectionId;
      if (!secId || !SECTION_IDS.has(secId)) return;
      const target = root.querySelector(`#report-sec-${secId}`);
      if (target) {
        target.scrollIntoView({ behavior: 'auto', block: 'start' });
        target.focus({ preventScroll: true });
      }
      return;
    }

    if (!currentUser()) return;

    if (action === 'reload-list') {
      void loadList();
      return;
    }
    if (action === 'load-more') {
      void loadMoreReports();
      return;
    }
    if (action === 'reload-detail') {
      if (s.ctx?.reportId) void loadDetail(s.ctx.reportId);
      return;
    }
    if (action === 'save-run' || action === 'retry-save') {
      void saveCurrentRunReport();
      return;
    }
    if (action === 'download-pdf') {
      const rid = btn.dataset.reportId;
      const ver = Number(btn.dataset.version);
      if (rid) void downloadPdf(rid, Number.isSafeInteger(ver) ? ver : null);
      return;
    }
    if (action === 'ask-delete') {
      const rid = normalizeUuid(btn.dataset.reportId);
      if (!rid || s.deletingId) return;
      if (s.confirmDeleteId === rid) {
        s.confirmDeleteId = null;
        s.deleteError = null;
        syncView({ focusSelector: `[data-report="ask-delete"][data-report-id="${rid}"]` });
      } else {
        s.confirmDeleteId = rid;
        s.deleteError = null;
        syncView({ focusSelector: `#delete-confirm-${rid} [data-report="cancel-delete"]` });
        announce('보고서 삭제 확인 영역이 열렸습니다. 삭제 취소 또는 이 보고서 삭제를 선택하세요.');
      }
      return;
    }
    if (action === 'cancel-delete') {
      const rid = normalizeUuid(btn.dataset.reportId) ?? s.confirmDeleteId;
      if (!rid || s.deletingId) return;
      s.confirmDeleteId = null;
      s.deleteError = null;
      syncView({ focusSelector: `[data-report="ask-delete"][data-report-id="${rid}"]` });
      announce('보고서 삭제를 취소했습니다.');
      return;
    }
    if (action === 'confirm-delete') {
      const rid = normalizeUuid(btn.dataset.reportId);
      if (rid) void executeDelete(rid);
    }
  });

  root?.addEventListener?.('change', (event) => {
    if (!s.active || s.ctx?.kind !== 'run' || s.ctx.guest || !currentUser() || s.saving) return;
    const select = event.target;
    if (!select?.matches?.('[data-report-field="funding-room"]') || s.ctx.selectedRoom !== null) return;
    const rawValue = typeof select.value === 'string' ? select.value.trim() : '';
    const nextRoom = rawValue && s.ctx.rooms.includes(rawValue) ? rawValue : null;
    if (s.fundingRoom === nextRoom) return;
    s.fundingRoom = nextRoom;
    if (s.saveRetry && s.saveRetry.fundingRoom !== nextRoom) {
      s.saveRetry = null;
    }
    if (s.saveError) {
      s.saveError = null;
      syncView({ focusSelector: '#report-funding-room' });
    }
  });

  root?.addEventListener?.('keydown', (event) => {
    if (!s.active || event.key !== 'Escape' || !s.confirmDeleteId || s.deletingId) return;
    const rid = s.confirmDeleteId;
    event.preventDefault();
    s.confirmDeleteId = null;
    s.deleteError = null;
    syncView({ focusSelector: `[data-report="ask-delete"][data-report-id="${rid}"]` });
    announce('보고서 삭제를 취소했습니다.');
  });

  return { enter, reset, view };
}
