// D-06 / A-56 내 데이터 관리(#privacy): src/server/data-deletion.ts 계약에 맞춰
// 범위별 단계 확인, 실제 영향·백업 분리 표시, 삭제 접수번호 조회를 제공한다.
import * as api from './client.js';
import { badge, errorText, esc, icon } from './display.js';

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const RECEIPT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_CONFIRM_PHRASE = '계정 삭제';
const FILE_BEARING_SCOPES = new Set(['chat', 'analysis', 'upload', 'account']);

const SCOPES = [
  {
    id: 'chat',
    group: 'item',
    singleton: false,
    icon: 'message-square',
    label: '채팅',
    shortDesc: '선택한 채팅과 연결된 대화·분석 영향 확인',
    detail: '선택한 채팅과 연결된 메시지·비교 대화·분석 등 삭제·변경될 건수를 먼저 확인합니다.',
    confirmAction: '선택한 채팅 삭제',
  },
  {
    id: 'message',
    group: 'item',
    singleton: false,
    icon: 'send',
    label: '채팅 메시지',
    shortDesc: '특정 채팅의 개별 메시지 한 건',
    detail: '선택한 메시지 한 건을 삭제합니다. 같은 채팅의 다른 메시지는 유지됩니다.',
    confirmAction: '선택한 메시지 삭제',
  },
  {
    id: 'turn',
    group: 'item',
    singleton: false,
    icon: 'rows-3',
    label: '비교 대화 한 건',
    shortDesc: '비교 화면의 질문·응답 기록 한 건',
    detail: '선택한 비교 대화 한 건의 질문·응답·조건 제안 기록을 삭제합니다.',
    confirmAction: '선택한 비교 대화 삭제',
  },
  {
    id: 'analysis',
    group: 'item',
    singleton: false,
    icon: 'folder-open',
    label: '분석',
    shortDesc: '공고 분석과 실행·자금·업로드 파일·보고서 영향 확인',
    detail: '선택한 공고 분석과 연결된 실행, 분석별 자금, 업로드 파일, 저장 보고서의 영향 건수를 먼저 확인합니다.',
    confirmAction: '선택한 분석 삭제',
  },
  {
    id: 'fund',
    group: 'item',
    singleton: false,
    icon: 'calendar-check',
    label: '분석별 자금 항목',
    shortDesc: '한 분석에 입력한 보유·추가 자금 한 건',
    detail: '선택한 분석의 자금 항목을 삭제합니다. 다른 분석과 공유 프로필 예산은 바뀌지 않으며, 저장 보고서에 반영된 금액의 변경 여부는 아래 영향 확인에서 확인할 수 있습니다.',
    confirmAction: '선택한 자금 항목 삭제',
  },
  {
    id: 'upload',
    group: 'item',
    singleton: false,
    icon: 'file-text',
    label: '업로드 파일',
    shortDesc: '직접 올린 비공개 공고 PDF 파일',
    detail: '직접 올린 비공개 공고 PDF와 파일 등록 정보를 삭제합니다. 공식 공고 기본 정보는 유지됩니다.',
    confirmAction: '선택한 업로드 파일 삭제',
  },
  {
    id: 'report',
    group: 'item',
    singleton: false,
    icon: 'bookmark',
    label: '저장 보고서',
    shortDesc: '저장한 보고서 스냅샷 한 건',
    detail: '선택한 저장 보고서 한 건을 삭제합니다. 아래 영향 건수에서 바뀔 항목을 확인하세요.',
    confirmAction: '선택한 저장 보고서 삭제',
  },
  {
    id: 'profile',
    group: 'profile',
    singleton: true,
    icon: 'user-round',
    label: '공유 프로필',
    shortDesc: '탐색 조건·출퇴근 목적지와 변경 이력',
    detail: '공유 프로필을 지우면 모든 채팅에서 프로필 없이 분석합니다. 기존 분석과 저장 보고서의 조건은 유지됩니다.',
    confirmAction: '공유 프로필 삭제',
  },
  {
    id: 'account',
    group: 'account',
    singleton: true,
    strongConfirm: true,
    icon: 'shield-check',
    label: '계정 전체 삭제',
    shortDesc: '모든 사용자 입력 자료와 계정 삭제 요청',
    detail: '계정의 채팅, 메시지, 비교 대화, 분석, 자금, 업로드 파일, 저장 보고서, 공유 프로필과 계정을 삭제 요청합니다. 접수 후 로그아웃되며 삭제 접수번호로 처리 상태를 조회할 수 있습니다.',
    confirmAction: '계정 삭제 요청',
  },
];

const SCOPE_MAP = new Map(SCOPES.map((item) => [item.id, item]));
const SCOPE_SET = new Set(SCOPES.map((item) => item.id));

const COUNT_KEYS = [
  { key: 'chats', label: '채팅' },
  { key: 'messages', label: '채팅 메시지' },
  { key: 'analyses', label: '분석' },
  { key: 'runs', label: '분석 실행' },
  { key: 'turns', label: '비교 대화' },
  { key: 'funds', label: '분석별 자금' },
  { key: 'reports', label: '저장 보고서' },
  { key: 'uploads', label: '업로드 파일' },
  { key: 'profileChanges', label: '프로필 변경 이력' },
];

const kstClock = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim()) ? value.trim().toLowerCase() : null;
}

function normalizeReceiptId(value) {
  return typeof value === 'string' && RECEIPT_UUID_RE.test(value.trim()) ? value.trim().toLowerCase() : null;
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function formatKstDateTime(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  const parts = Object.fromEntries(kstClock.formatToParts(ms).map((p) => [p.type, p.value]));
  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute} KST`;
}

function timeTag(value, emptyLabel = '—') {
  if (!validTimestamp(value)) return `<span class="privacy-muted-val">${esc(emptyLabel)}</span>`;
  return `<time datetime="${esc(value)}">${esc(formatKstDateTime(value))}</time>`;
}

function makeCodeError(code) {
  return Object.assign(new Error(code), { code });
}

function privacyErrorMessage(error, { context = 'default' } = {}) {
  const code = error?.code ?? '';
  if (code === 'invalid_receipt_format') {
    return '삭제 접수번호는 UUID v4 형식(예: 00000000-0000-4000-8000-000000000000)으로 입력하세요.';
  }
  if (code === 'deletion_confirmation_required') {
    return `‘${ACCOUNT_CONFIRM_PHRASE}’를 정확히 입력해야 요청할 수 있습니다.`;
  }
  if (context === 'receipt' && code === 'deletion_not_found') {
    return '입력한 접수번호와 일치하는 삭제 기록을 찾지 못했습니다. 번호를 다시 확인해 주세요.';
  }
  if (code === 'deletion_not_found') {
    return '이 계정에서 선택한 항목을 찾지 못했습니다. 목록을 새로고침한 뒤 다시 확인하세요.';
  }
  return errorText(error);
}

function isRetryableError(error) {
  const code = error?.code ?? '';
  return code === 'backend_unavailable' || !code;
}

// src/server/data-deletion.ts project()와 동일한 고정 필드·불변식을 검증한다.
function parseItemsResponse(data) {
  if (!isPlainObject(data) || !Array.isArray(data.items) || data.items.length > 100) return null;
  if (data.nextCursor !== null && !normalizeUuid(data.nextCursor)) return null;
  const seen = new Set();
  const items = [];
  for (const row of data.items) {
    if (!isPlainObject(row)) return null;
    const id = normalizeUuid(row.id);
    if (!id || seen.has(id)) return null;
    if (typeof row.label !== 'string' || !row.label.trim() || row.label.length > 1000) return null;
    if (row.detail !== null && row.detail !== undefined && (typeof row.detail !== 'string' || row.detail.length > 2000)) {
      return null;
    }
    seen.add(id);
    items.push({
      id,
      label: row.label.trim(),
      detail: typeof row.detail === 'string' && row.detail.trim() ? row.detail.trim() : null,
    });
  }
  const nextCursor = data.nextCursor === null ? null : normalizeUuid(data.nextCursor);
  if (nextCursor !== null && nextCursor !== items.at(-1)?.id) return null;
  return { items, nextCursor };
}

function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseImpactResponse(data, expectedScope, expectedTargetId) {
  if (!isPlainObject(data)) return null;
  if (data.scope !== expectedScope) return null;
  const targetId = data.targetId === null ? null : normalizeUuid(data.targetId);
  if (expectedTargetId === null ? targetId !== null : targetId !== expectedTargetId) return null;
  if (!isPlainObject(data.counts)) return null;
  const counts = {};
  for (const { key } of COUNT_KEYS) {
    const n = data.counts[key];
    if (!isCount(n)) return null;
    counts[key] = n;
  }
  const { profileCleared, reportsDeleted, reportsUpdated, storageObjects } = data;
  if (
    typeof profileCleared !== 'boolean' ||
    !isCount(reportsDeleted) ||
    !isCount(reportsUpdated) ||
    !isCount(storageObjects) ||
    reportsDeleted + reportsUpdated !== counts.reports
  ) {
    return null;
  }
  if (!isPlainObject(data.backup) || data.backup.status !== 'unverified') return null;
  return {
    scope: expectedScope,
    targetId,
    counts,
    profileCleared,
    reportsDeleted,
    reportsUpdated,
    storageObjects,
    backup: { status: 'unverified' },
  };
}

function parsePublicReceipt(data, { expectedReceiptId = null, expectedScope = null } = {}) {
  if (!isPlainObject(data)) return null;
  const receiptId = normalizeReceiptId(data.receiptId);
  if (!receiptId) return null;
  if (expectedReceiptId && receiptId !== expectedReceiptId) return null;
  if (!SCOPE_SET.has(data.scope)) return null;
  if (expectedScope && data.scope !== expectedScope) return null;
  if (!validTimestamp(data.requestedAt)) return null;

  let completedAt = null;
  if (data.status === 'processing') {
    if (data.completedAt !== null) return null;
  } else if (data.status === 'live_deleted') {
    if (!validTimestamp(data.completedAt) || Date.parse(data.completedAt) < Date.parse(data.requestedAt)) return null;
    completedAt = data.completedAt;
  } else {
    return null;
  }

  let backup;
  if (data.backup === undefined) {
    backup = { status: 'unverified' };
  } else if (!isPlainObject(data.backup)) {
    return null;
  } else if (data.backup.status === 'unverified') {
    backup = { status: 'unverified' };
  } else if (
    data.backup.status === 'verified' &&
    data.status === 'live_deleted' &&
    completedAt !== null &&
    validTimestamp(data.backup.verifiedAt) &&
    Date.parse(data.backup.verifiedAt) >= Date.parse(completedAt)
  ) {
    backup = { status: 'verified', verifiedAt: data.backup.verifiedAt };
  } else {
    return null;
  }

  return {
    receiptId,
    scope: data.scope,
    status: data.status,
    requestedAt: data.requestedAt,
    completedAt,
    backup,
  };
}

function impactHighlights(impact) {
  const notes = [];
  if (impact.counts.reports > 0) {
    const del = impact.reportsDeleted.toLocaleString('ko-KR');
    const upd = impact.reportsUpdated.toLocaleString('ko-KR');
    if (impact.reportsDeleted > 0 && impact.reportsUpdated > 0) {
      notes.push({
        kind: 'reports',
        icon: 'bookmark',
        text: `저장 보고서 ${del}건이 삭제되고, ${upd}건에서는 관련 금액·입력 항목이 지워집니다.`,
      });
    } else if (impact.reportsDeleted > 0) {
      notes.push({
        kind: 'reports',
        icon: 'bookmark',
        text: `저장 보고서 ${del}건이 삭제됩니다.`,
      });
    } else if (impact.reportsUpdated > 0) {
      notes.push({
        kind: 'reports',
        icon: 'bookmark',
        text: `저장 보고서 ${upd}건은 삭제되지 않고, 보고서 안의 관련 금액·입력 항목만 지워집니다.`,
      });
    }
  }
  if (impact.profileCleared) {
    notes.push({
      kind: 'profile',
      icon: 'user-round',
      text: '승인된 공유 프로필 조건(희망 지역·예산·면적·입주월)과 출퇴근 목적지도 함께 삭제됩니다.',
    });
  }
  if (impact.storageObjects > 0) {
    notes.push({
      kind: 'storage',
      icon: 'file-text',
      text: `확인 시점 기준 정리 대상 업로드 파일 ${impact.storageObjects.toLocaleString('ko-KR')}건이 포함되어 있습니다. 요청 직후 잠시 ‘처리 중’으로 표시될 수 있습니다.`,
    });
  }
  return notes;
}

function renderStatusBadge(status) {
  return status === 'live_deleted'
    ? badge('verified', 'circle-check', '서비스에서 삭제 완료')
    : badge('partial', 'clock-3', '처리 중');
}

function renderBackupBadge(backup) {
  return backup.status === 'verified'
    ? badge('verified', 'circle-check', '백업 정리 확인됨')
    : badge('unknown', 'circle-help', '백업 미확인');
}

function backupCopy(backup) {
  if (backup.status === 'verified') {
    return `${formatKstDateTime(backup.verifiedAt)} 기준으로 백업 정리가 확인되었습니다.`;
  }
  return '서비스 삭제와 백업 사본 정리는 별개이며, 백업 사본의 삭제 여부나 만료 시점은 확인되지 않았습니다.';
}

function processingCopy(scope) {
  return FILE_BEARING_SCOPES.has(scope)
    ? '업로드 파일을 포함한 삭제 처리 중일 수 있습니다. 잠시 후 상태를 다시 확인하세요.'
    : '서비스에서 삭제를 처리 중입니다. 잠시 후 상태를 다시 확인하세요.';
}

function generateReceiptId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().toLowerCase();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function blank() {
  return {
    active: false,
    ownerId: null,
    selectedScope: null,
    items: [],
    nextCursor: null,
    seenCursors: new Set(),
    itemsLoading: false,
    itemsError: null,
    loadingMore: false,
    loadMoreError: null,
    selectedItemId: null,
    impact: null,
    impactLoading: false,
    impactError: null,
    confirmOpen: false,
    confirmPhrase: '',
    submitting: false,
    submitError: null,
    pendingRequest: null, // { scope, targetId, receiptId }
    recentReceipts: [],
    signedOutReceipt: null,
    lookupInput: '',
    lookupLoading: false,
    lookupError: null,
    lookupResult: null,
    refreshingReceiptId: null,
    refreshError: null, // { receiptId, error }
    copiedReceiptId: null,
    copyFailedReceiptId: null,
    banner: null, // { tone, text }
  };
}

export function createPrivacyPage({ root, render, announce = () => {}, user, onDeleted, onAccountRequested } = {}) {
  let s = blank();
  let generation = 0;
  let itemsController = null;
  let moreController = null;
  let impactController = null;
  let submitController = null;
  let lookupController = null;
  let refreshController = null;

  function currentUser() {
    return typeof user === 'function' ? user() : null;
  }

  function abortAll() {
    itemsController?.abort();
    moreController?.abort();
    impactController?.abort();
    submitController?.abort();
    lookupController?.abort();
    refreshController?.abort();
    itemsController = moreController = impactController = submitController = lookupController = refreshController = null;
  }

  function abortSelectionWork() {
    itemsController?.abort();
    moreController?.abort();
    impactController?.abort();
    submitController?.abort();
    itemsController = moreController = impactController = submitController = null;
  }

  function reset() {
    ++generation;
    abortAll();
    s = blank();
  }

  function syncView({ focusSelector = null } = {}) {
    const slot = root?.querySelector?.('#privacy-page-slot');
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

  function enter(receipt = null) {
    const owner = currentUser();
    const ownerId = owner?.id ?? null;

    if (ownerId) {
      if (!s.active || s.ownerId !== ownerId) {
        ++generation;
        abortAll();
        s = blank();
        s.active = true;
        s.ownerId = ownerId;
      } else {
        s.signedOutReceipt = null;
      }
      syncView();
      return;
    }

    const incomingReceipt = receipt === null ? null : parsePublicReceipt(receipt);
    if (!s.active || s.ownerId !== null) {
      ++generation;
      abortAll();
      s = blank();
      s.active = true;
      s.ownerId = null;
    }
    if (incomingReceipt) {
      s.signedOutReceipt = incomingReceipt;
    }
    syncView({ focusSelector: incomingReceipt ? '#privacy-account-receipt' : null });
  }

  async function selectScope(scopeId) {
    const owner = currentUser();
    if (!owner || !s.active || owner.id !== s.ownerId || !SCOPE_SET.has(scopeId) || s.submitting) return;
    abortSelectionWork();
    s.selectedScope = scopeId;
    s.items = [];
    s.nextCursor = null;
    s.seenCursors = new Set();
    s.itemsLoading = false;
    s.itemsError = null;
    s.loadingMore = false;
    s.loadMoreError = null;
    s.selectedItemId = null;
    s.impact = null;
    s.impactLoading = false;
    s.impactError = null;
    s.confirmOpen = false;
    s.confirmPhrase = '';
    s.submitError = null;
    s.pendingRequest = null;

    const meta = SCOPE_MAP.get(scopeId);
    syncView();
    if (meta.singleton) {
      await loadImpact(scopeId, null);
    } else {
      await loadItems(scopeId);
    }
  }

  async function loadItems(kind) {
    const owner = currentUser()?.id;
    if (!owner || !s.active || owner !== s.ownerId || s.selectedScope !== kind) return;
    const token = generation;
    itemsController?.abort();
    const controller = new AbortController();
    itemsController = controller;
    s.itemsLoading = true;
    s.itemsError = null;
    s.loadMoreError = null;
    syncView();

    try {
      const parsed = parseItemsResponse(await api.listDeletionItems(kind, null, controller.signal));
      if (token !== generation || itemsController !== controller || currentUser()?.id !== owner || s.selectedScope !== kind) {
        return;
      }
      if (!parsed) throw makeCodeError('backend_unavailable');
      s.items = parsed.items;
      s.nextCursor = parsed.nextCursor;
      s.seenCursors = new Set();
      s.itemsError = null;
    } catch (error) {
      if (token !== generation || itemsController !== controller || currentUser()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      s.itemsError = error;
    } finally {
      if (token === generation && itemsController === controller) {
        itemsController = null;
        s.itemsLoading = false;
        syncView();
      }
    }
  }

  async function loadMoreItems() {
    const owner = currentUser()?.id;
    const kind = s.selectedScope;
    const cursor = s.nextCursor;
    if (!owner || !s.active || owner !== s.ownerId || !kind || !cursor || s.loadingMore) return;
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
      const parsed = parseItemsResponse(await api.listDeletionItems(kind, cursor, controller.signal));
      if (token !== generation || moreController !== controller || currentUser()?.id !== owner || s.selectedScope !== kind) {
        return;
      }
      if (!parsed) throw makeCodeError('backend_unavailable');
      s.seenCursors.add(cursor);
      const existing = new Set(s.items.map((item) => item.id));
      for (const item of parsed.items) {
        if (!existing.has(item.id)) {
          existing.add(item.id);
          s.items.push(item);
        }
      }
      s.nextCursor = parsed.nextCursor && !s.seenCursors.has(parsed.nextCursor) ? parsed.nextCursor : null;
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

  async function selectTargetItem(itemId) {
    const owner = currentUser()?.id;
    const scope = s.selectedScope;
    const cleanId = normalizeUuid(itemId);
    if (!owner || !s.active || owner !== s.ownerId || !scope || !cleanId || s.submitting) return;
    const meta = SCOPE_MAP.get(scope);
    if (!meta || meta.singleton || !s.items.some((entry) => entry.id === cleanId)) return;

    impactController?.abort();
    impactController = null;
    s.selectedItemId = cleanId;
    s.impact = null;
    s.impactError = null;
    s.confirmOpen = false;
    s.confirmPhrase = '';
    s.submitError = null;
    s.pendingRequest = null;
    syncView();
    await loadImpact(scope, cleanId);
  }

  async function loadImpact(scope, targetId) {
    const owner = currentUser()?.id;
    if (!owner || !s.active || owner !== s.ownerId || s.selectedScope !== scope) return;
    const meta = SCOPE_MAP.get(scope);
    const expectedTarget = meta?.singleton ? null : normalizeUuid(targetId);
    if (!meta || (!meta.singleton && !expectedTarget)) return;

    const token = generation;
    impactController?.abort();
    const controller = new AbortController();
    impactController = controller;
    s.impactLoading = true;
    s.impactError = null;
    s.impact = null;
    s.confirmOpen = false;
    s.confirmPhrase = '';
    s.submitError = null;
    s.pendingRequest = null;
    syncView();

    try {
      const parsed = parseImpactResponse(
        await api.readDeletionImpact(scope, expectedTarget, controller.signal),
        scope,
        expectedTarget,
      );
      if (
        token !== generation ||
        impactController !== controller ||
        currentUser()?.id !== owner ||
        s.selectedScope !== scope ||
        (meta.singleton ? s.selectedItemId !== null : s.selectedItemId !== expectedTarget)
      ) {
        return;
      }
      if (!parsed) throw makeCodeError('backend_unavailable');
      s.impact = parsed;
      s.impactError = null;
      announce(`${meta.label} 삭제 영향 건수를 확인했습니다.`);
    } catch (error) {
      if (token !== generation || impactController !== controller || currentUser()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      s.impactError = error;
    } finally {
      if (token === generation && impactController === controller) {
        impactController = null;
        s.impactLoading = false;
        syncView();
      }
    }
  }

  function openConfirmation() {
    if (!s.active || !currentUser() || s.submitting || s.impactLoading || !s.impact) return;
    const meta = SCOPE_MAP.get(s.selectedScope);
    if (!meta) return;
    s.confirmOpen = true;
    s.confirmPhrase = '';
    s.submitError = null;
    s.pendingRequest = null;
    syncView({
      focusSelector: meta.strongConfirm ? '#privacy-account-phrase' : '[data-privacy="cancel-confirm"]',
    });
    announce(
      meta.strongConfirm
        ? '계정 삭제 최종 확인 영역이 열렸습니다. 확인 문구를 입력한 뒤 요청할 수 있습니다.'
        : `${meta.label} 최종 삭제 확인 영역이 열렸습니다.`,
    );
  }

  function cancelConfirmation() {
    if (!s.active || s.submitting || !s.confirmOpen) return;
    s.confirmOpen = false;
    s.confirmPhrase = '';
    s.submitError = null;
    s.pendingRequest = null;
    syncView({ focusSelector: '[data-privacy="open-confirm"]' });
    announce('삭제 확인을 취소했습니다.');
  }

  function updateAccountPhraseControl() {
    const ready = s.confirmPhrase.trim() === ACCOUNT_CONFIRM_PHRASE && !s.submitting && Boolean(s.impact);
    const btn = root?.querySelector?.('[data-privacy="confirm-delete"]');
    if (btn) btn.disabled = !ready;
    const hint = root?.querySelector?.('#privacy-phrase-status');
    if (hint) {
      hint.textContent = ready
        ? '확인 문구가 일치합니다.'
        : `‘${ACCOUNT_CONFIRM_PHRASE}’를 입력하면 요청 버튼이 열립니다.`;
      hint.className = 'privacy-phrase-status' + (ready ? ' is-ready' : '');
    }
  }

  function upsertReceipt(clean) {
    const idx = s.recentReceipts.findIndex((entry) => entry.receiptId === clean.receiptId);
    if (idx >= 0) s.recentReceipts[idx] = clean;
    else s.recentReceipts = [clean, ...s.recentReceipts].slice(0, 10);
    if (s.signedOutReceipt?.receiptId === clean.receiptId) s.signedOutReceipt = clean;
    if (s.lookupResult?.receiptId === clean.receiptId) s.lookupResult = clean;
  }

  async function submitDeletion() {
    const owner = currentUser()?.id;
    if (!owner || !s.active || owner !== s.ownerId || s.submitting || !s.confirmOpen || !s.impact) return;
    const scope = s.selectedScope;
    const meta = SCOPE_MAP.get(scope);
    if (!meta) return;
    const targetId = meta.singleton ? null : s.selectedItemId;
    if (!meta.singleton && !targetId) return;
    if (meta.strongConfirm && s.confirmPhrase.trim() !== ACCOUNT_CONFIRM_PHRASE) {
      s.submitError = makeCodeError('deletion_confirmation_required');
      syncView({ focusSelector: '#privacy-account-phrase' });
      return;
    }

    const receiptId =
      s.pendingRequest &&
      s.pendingRequest.scope === scope &&
      s.pendingRequest.targetId === targetId
        ? s.pendingRequest.receiptId
        : generateReceiptId();

    s.pendingRequest = { scope, targetId, receiptId };
    const token = generation;
    submitController?.abort();
    const controller = new AbortController();
    submitController = controller;
    s.submitting = true;
    s.submitError = null;
    syncView();

    try {
      const raw = await api.requestDataDeletion(scope, targetId, receiptId, controller.signal);
      if (token !== generation || submitController !== controller || currentUser()?.id !== owner) return;
      const cleanReceipt = parsePublicReceipt(raw, { expectedReceiptId: receiptId, expectedScope: scope });
      if (!cleanReceipt) throw makeCodeError('backend_unavailable');
      submitController = null;
      s.submitting = false;
      s.pendingRequest = null;

      if (scope === 'account') {
        // 계정 삭제 접수 후 개인 상태는 즉시 비우고 로그아웃·세션 정리는 부모 onAccountRequested가 1회 수행한다.
        s = { ...blank(), active: true, ownerId: null, signedOutReceipt: cleanReceipt };
        syncView();
        await onAccountRequested?.(cleanReceipt);
        return;
      }

      upsertReceipt(cleanReceipt);
      s.confirmOpen = false;
      s.confirmPhrase = '';
      s.impact = null;
      s.selectedItemId = null;
      s.submitError = null;
      s.banner = {
        tone: cleanReceipt.status === 'live_deleted' ? 'verified' : 'partial',
        text:
          cleanReceipt.status === 'live_deleted'
            ? `${meta.label} 항목을 서비스에서 삭제했습니다.`
            : `${meta.label} 삭제가 접수되어 처리 중입니다.`,
      };
      onDeleted?.();
      announce(s.banner.text);
      syncView({ focusSelector: '#privacy-latest-receipt' });
      if (!meta.singleton) {
        void loadItems(scope);
      }
    } catch (error) {
      if (token !== generation || submitController !== controller || currentUser()?.id !== owner) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      submitController = null;
      s.submitting = false;
      s.submitError = error;
      if (!isRetryableError(error) && error?.code !== 'authentication_required') {
        s.pendingRequest = null;
      }
      announce(privacyErrorMessage(error));
      syncView({ focusSelector: '#privacy-submit-error' });
    }
  }

  async function lookupReceipt(rawCode) {
    if (!s.active || s.lookupLoading) return;
    const normalized = normalizeReceiptId(rawCode);
    if (!normalized) {
      s.lookupError = makeCodeError('invalid_receipt_format');
      s.lookupResult = null;
      syncView({ focusSelector: '#privacy-receipt-input' });
      return;
    }

    const token = generation;
    lookupController?.abort();
    const controller = new AbortController();
    lookupController = controller;
    s.lookupLoading = true;
    s.lookupError = null;
    syncView();

    try {
      const clean = parsePublicReceipt(await api.readDeletionReceipt(normalized, controller.signal), {
        expectedReceiptId: normalized,
      });
      if (token !== generation || lookupController !== controller) return;
      if (!clean) throw makeCodeError('backend_unavailable');
      s.lookupResult = clean;
      if (s.signedOutReceipt?.receiptId === clean.receiptId) s.signedOutReceipt = clean;
      const existingIdx = s.recentReceipts.findIndex((r) => r.receiptId === clean.receiptId);
      if (existingIdx >= 0) s.recentReceipts[existingIdx] = clean;
      s.lookupError = null;
      announce(
        clean.status === 'live_deleted'
          ? '삭제 접수 상태가 서비스에서 삭제 완료로 확인되었습니다.'
          : '삭제 요청이 현재 처리 중입니다.',
      );
    } catch (error) {
      if (token !== generation || lookupController !== controller) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      s.lookupResult = null;
      s.lookupError = error;
      announce(privacyErrorMessage(error, { context: 'receipt' }));
    } finally {
      if (token === generation && lookupController === controller) {
        lookupController = null;
        s.lookupLoading = false;
        syncView({ focusSelector: s.lookupResult ? '#privacy-lookup-result' : '#privacy-lookup-error' });
      }
    }
  }

  async function refreshReceipt(receiptId) {
    const cleanId = normalizeReceiptId(receiptId);
    if (!s.active || !cleanId || s.refreshingReceiptId) return;
    const token = generation;
    refreshController?.abort();
    const controller = new AbortController();
    refreshController = controller;
    s.refreshingReceiptId = cleanId;
    s.refreshError = null;
    syncView();

    try {
      const clean = parsePublicReceipt(await api.readDeletionReceipt(cleanId, controller.signal), {
        expectedReceiptId: cleanId,
      });
      if (token !== generation || refreshController !== controller) return;
      if (!clean) throw makeCodeError('backend_unavailable');
      if (s.signedOutReceipt?.receiptId === clean.receiptId) s.signedOutReceipt = clean;
      if (s.lookupResult?.receiptId === clean.receiptId) s.lookupResult = clean;
      const idx = s.recentReceipts.findIndex((entry) => entry.receiptId === clean.receiptId);
      if (idx >= 0) s.recentReceipts[idx] = clean;
      s.refreshError = null;
      announce(
        clean.status === 'live_deleted'
          ? '삭제 상태가 서비스에서 삭제 완료로 갱신되었습니다.'
          : '삭제 요청이 아직 처리 중입니다.',
      );
    } catch (error) {
      if (token !== generation || refreshController !== controller) return;
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      s.refreshError = { receiptId: cleanId, error };
    } finally {
      if (token === generation && refreshController === controller) {
        refreshController = null;
        s.refreshingReceiptId = null;
        syncView({ focusSelector: `[data-privacy="refresh-receipt"][data-receipt-id="${cleanId}"]` });
      }
    }
  }

  async function copyReceiptCode(receiptId) {
    const cleanId = normalizeReceiptId(receiptId);
    if (!s.active || !cleanId) return;
    s.copiedReceiptId = null;
    s.copyFailedReceiptId = null;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(cleanId);
      if (!s.active) return;
      s.copiedReceiptId = cleanId;
      announce('삭제 접수번호를 클립보드에 복사했습니다.');
    } catch {
      if (!s.active) return;
      s.copyFailedReceiptId = cleanId;
      announce('자동 복사를 사용할 수 없습니다. 표시된 접수번호를 직접 선택해 복사해 주세요.');
    }
    syncView({ focusSelector: `[data-privacy="copy-receipt"][data-receipt-id="${cleanId}"]` });
  }

  function renderReceiptCard(receipt, { id = null, title = '삭제 접수 내역', headingLevel = 'h3', showClear = false } = {}) {
    const scopeMeta = SCOPE_MAP.get(receipt.scope);
    const refreshing = s.refreshingReceiptId === receipt.receiptId;
    const copied = s.copiedReceiptId === receipt.receiptId;
    const copyFailed = s.copyFailedReceiptId === receipt.receiptId;
    const refreshErr = s.refreshError?.receiptId === receipt.receiptId ? s.refreshError.error : null;
    const Tag = headingLevel;

    return `<article${id ? ` id="${esc(id)}"` : ''} class="panel privacy-receipt-card is-${esc(receipt.status)}" tabindex="-1" data-receipt-id="${esc(receipt.receiptId)}" data-receipt-status="${esc(receipt.status)}">
      <div class="privacy-receipt-head">
        <${Tag}>${esc(title)}</${Tag}>
        ${renderStatusBadge(receipt.status)}
      </div>

      <div class="privacy-code-box">
        <div class="privacy-code-copy">
          <span class="privacy-code-label">삭제 접수번호</span>
          <code class="code privacy-receipt-code" data-receipt-code="${esc(receipt.receiptId)}">${esc(receipt.receiptId)}</code>
        </div>
        <div class="privacy-code-actions">
          <button type="button" class="action secondary compact" data-privacy="copy-receipt" data-receipt-id="${esc(receipt.receiptId)}">${icon(copied ? 'check' : 'file-text')}${copied ? '복사됨' : '접수번호 복사'}</button>
          <button type="button" class="action secondary compact" data-privacy="refresh-receipt" data-receipt-id="${esc(receipt.receiptId)}"${refreshing ? ' disabled' : ''}>${icon(refreshing ? 'loader-circle' : 'refresh-cw', refreshing ? 'spin' : '')}${refreshing ? '조회 중' : '상태 새로고침'}</button>
        </div>
      </div>

      ${
        copyFailed
          ? '<p class="privacy-copy-hint" role="status">클립보드 복사가 차단되었습니다. 위 접수번호를 직접 선택해 보관하세요.</p>'
          : ''
      }

      ${
        receipt.status === 'processing'
          ? `<p class="privacy-processing-note">${icon('clock-3')}<span>${esc(processingCopy(receipt.scope))}</span></p>`
          : ''
      }

      <dl class="privacy-meta-grid">
        <div>
          <dt>삭제 범위</dt>
          <dd>${esc(scopeMeta?.label ?? receipt.scope)}</dd>
        </div>
        <div>
          <dt>요청 시각</dt>
          <dd>${timeTag(receipt.requestedAt)}</dd>
        </div>
        <div>
          <dt>완료 시각</dt>
          <dd>${timeTag(receipt.completedAt, receipt.status === 'processing' ? '처리 중' : '—')}</dd>
        </div>
      </dl>

      <div class="privacy-backup-box" data-backup-status="${esc(receipt.backup.status)}">
        <div class="privacy-backup-head">
          <strong>백업 사본</strong>
          ${renderBackupBadge(receipt.backup)}
        </div>
        <p>${esc(backupCopy(receipt.backup))}</p>
      </div>

      ${
        refreshErr
          ? `<div class="privacy-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(privacyErrorMessage(refreshErr, { context: 'receipt' }))}</p></div></div>`
          : ''
      }

      ${
        showClear
          ? `<div class="privacy-receipt-foot"><button type="button" class="text-button" data-privacy="clear-account-receipt">화면에서 접수번호 닫기</button></div>`
          : ''
      }
    </article>`;
  }

  function renderLookupSection({ guest = false } = {}) {
    const errText = s.lookupError ? privacyErrorMessage(s.lookupError, { context: 'receipt' }) : '';

    return `<section class="panel privacy-lookup-card" aria-labelledby="privacy-lookup-heading">
      <div class="privacy-card-head">
        <div>
          <h2 id="privacy-lookup-heading">삭제 접수 상태 조회</h2>
          <p class="privacy-card-sub">로그아웃한 상태에서도 삭제 접수번호로 범위·처리 상태·시각·백업 확인 여부를 조회할 수 있습니다. 계정 정보나 입력 원문은 표시하지 않으며 번호를 브라우저에 저장하지 않습니다.</p>
        </div>
      </div>

      <form id="privacy-receipt-form" class="privacy-lookup-form" novalidate>
        <div class="privacy-lookup-field">
          <label for="privacy-receipt-input">삭제 접수번호</label>
          <div class="privacy-lookup-row">
            <input
              id="privacy-receipt-input"
              name="receiptId"
              type="text"
              class="code"
              autocomplete="off"
              spellcheck="false"
              placeholder="예: 123e4567-e89b-42d3-a456-426614174000"
              value="${esc(s.lookupInput)}"
            />
            <button type="submit" class="action ${guest ? 'primary' : 'secondary'}"${s.lookupLoading ? ' disabled' : ''}>${icon(s.lookupLoading ? 'loader-circle' : 'search', s.lookupLoading ? 'spin' : '')}${s.lookupLoading ? '조회 중' : '상태 조회'}</button>
          </div>
        </div>
      </form>

      ${
        errText
          ? `<div id="privacy-lookup-error" class="privacy-inline-error" role="alert" tabindex="-1">${icon('triangle-alert')}<div><p>${esc(errText)}</p></div></div>`
          : ''
      }

      ${
        s.lookupResult
          ? renderReceiptCard(s.lookupResult, {
              id: 'privacy-lookup-result',
              title: '조회된 삭제 접수 내역',
              headingLevel: 'h3',
            })
          : ''
      }
    </section>`;
  }

  function renderSignedOutReceiptPanel() {
    if (!s.signedOutReceipt) return '';
    return `<section id="privacy-account-receipt" class="privacy-account-result" tabindex="-1" aria-labelledby="privacy-account-receipt-heading">
      <div class="privacy-banner is-verified" role="status">
        ${icon('circle-check')}
        <div>
          <strong id="privacy-account-receipt-heading">계정 삭제 요청이 접수되었으며 로그아웃 상태로 전환했습니다.</strong>
          <p>개인 자료 화면은 비웠습니다. 아래 접수번호는 새로고침하거나 다른 계정으로 로그인하면 사라지므로 필요하면 복사해 보관하세요.</p>
        </div>
      </div>
      ${renderReceiptCard(s.signedOutReceipt, {
        title: '접수된 계정 삭제 내역',
        headingLevel: 'h3',
        showClear: true,
      })}
    </section>`;
  }

  function renderGuestView() {
    return `<div class="privacy-page">
      <header class="privacy-header">
        <div class="privacy-header-copy">
          <h1>내 데이터 관리</h1>
          <p>계정에 저장된 대화, 분석, 자금, 업로드 파일, 저장 보고서, 공유 프로필의 개별 삭제와 계정 삭제를 요청하고 접수번호로 처리 상태를 확인합니다.</p>
        </div>
      </header>

      ${renderSignedOutReceiptPanel()}

      <section class="panel privacy-guest-card" aria-labelledby="privacy-guest-heading">
        <div class="privacy-guest-copy">
          ${icon('shield-check')}
          <div>
            <h2 id="privacy-guest-heading">로그인하면 내 계정의 자료를 선택해 삭제할 수 있습니다</h2>
            <p>비로그인 상태에서는 개인 목록과 삭제 요청을 열지 않습니다. 발급받은 삭제 접수번호는 아래에서 바로 조회할 수 있습니다.</p>
          </div>
        </div>
        <div class="privacy-guest-actions">
          <button type="button" class="action primary" data-action="auth">${icon('log-in')}로그인하기</button>
          <a class="action secondary" href="#notices">오늘의 청약 보기</a>
        </div>
      </section>

      ${renderLookupSection({ guest: true })}
    </div>`;
  }

  function renderScopeSelector() {
    const itemScopes = SCOPES.filter((sc) => sc.group === 'item');
    const singletonScopes = SCOPES.filter((sc) => sc.group !== 'item');

    const card = (sc) => {
      const selected = s.selectedScope === sc.id;
      return `<button
        type="button"
        class="privacy-scope-btn${selected ? ' is-selected' : ''}"
        data-privacy="select-scope"
        data-scope="${esc(sc.id)}"
        aria-pressed="${selected ? 'true' : 'false'}"
        ${s.submitting ? 'disabled' : ''}
      >
        <span class="privacy-scope-icon" aria-hidden="true">${icon(sc.icon)}</span>
        <span class="privacy-scope-text">
          <strong>${esc(sc.label)}</strong>
          <small>${esc(sc.shortDesc)}</small>
        </span>
      </button>`;
    };

    return `<section class="panel privacy-stage" aria-labelledby="privacy-stage1-heading">
      <div class="privacy-stage-head">
        <span class="privacy-step-num num">1단계</span>
        <div>
          <h2 id="privacy-stage1-heading">삭제 범위 선택</h2>
          <p class="privacy-card-sub">범위를 선택해도 바로 삭제되지 않으며, 삭제·변경될 영향 건수와 백업 상태를 먼저 확인합니다.</p>
        </div>
      </div>

      <div class="privacy-scope-group">
        <h3 class="privacy-group-label">개별 자료 삭제</h3>
        <div class="privacy-scope-grid">${itemScopes.map(card).join('')}</div>
      </div>

      <div class="privacy-scope-group">
        <h3 class="privacy-group-label">공유 프로필 및 계정</h3>
        <div class="privacy-scope-grid privacy-scope-grid-wide">${singletonScopes.map(card).join('')}</div>
      </div>
    </section>`;
  }

  function renderItemPicker(meta) {
    if (meta.singleton) return '';

    let body;
    if (s.itemsLoading && !s.items.length) {
      body = `<div class="privacy-quiet-state" role="status">${icon('loader-circle', 'spin')}<span>${esc(meta.label)} 목록을 불러오고 있습니다.</span></div>`;
    } else if (s.itemsError && !s.items.length) {
      const isAuth = s.itemsError.code === 'authentication_required';
      body = `<div class="privacy-inline-error" role="alert">
        ${icon('triangle-alert')}
        <div>
          <p>${esc(privacyErrorMessage(s.itemsError))}</p>
          <div class="privacy-error-actions">
            ${
              isAuth
                ? '<button type="button" class="action primary compact" data-action="auth">다시 로그인</button>'
                : '<button type="button" class="action secondary compact" data-privacy="reload-items">다시 불러오기</button>'
            }
          </div>
        </div>
      </div>`;
    } else if (!s.items.length) {
      body = `<div class="privacy-quiet-state">${icon('circle-minus')}<span>삭제할 ${esc(meta.label)} 항목이 없습니다.</span></div>`;
    } else {
      body = `${
        s.itemsError
          ? `<div class="privacy-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(privacyErrorMessage(s.itemsError))}</p><button type="button" class="action secondary compact" data-privacy="reload-items">목록 새로고침</button></div></div>`
          : ''
      }
      <div class="privacy-item-list" role="radiogroup" aria-label="삭제할 ${esc(meta.label)} 선택">
        ${s.items
          .map((item) => {
            const checked = s.selectedItemId === item.id;
            return `<button
              type="button"
              role="radio"
              aria-checked="${checked ? 'true' : 'false'}"
              class="privacy-item-row${checked ? ' is-selected' : ''}"
              data-privacy="select-item"
              data-item-id="${esc(item.id)}"
              ${s.submitting ? 'disabled' : ''}
            >
              <span class="privacy-radio-dot" aria-hidden="true"></span>
              <span class="privacy-item-copy">
                <strong>${esc(item.label)}</strong>
                ${item.detail ? `<small>${esc(item.detail)}</small>` : ''}
              </span>
              <span class="code privacy-item-id">${esc(item.id.slice(0, 8))}</span>
            </button>`;
          })
          .join('')}
      </div>
      ${
        s.loadMoreError
          ? `<div class="privacy-inline-error" role="alert">${icon('triangle-alert')}<div><p>${esc(privacyErrorMessage(s.loadMoreError))}</p><button type="button" class="action secondary compact" data-privacy="load-more-items">다시 불러오기</button></div></div>`
          : ''
      }
      ${
        s.nextCursor
          ? `<div class="privacy-list-more">
              <button type="button" class="action secondary compact" data-privacy="load-more-items"${s.loadingMore ? ' disabled' : ''}>${icon(s.loadingMore ? 'loader-circle' : 'chevron-down', s.loadingMore ? 'spin' : '')}${s.loadingMore ? '불러오는 중' : '항목 더 불러오기'}</button>
            </div>`
          : ''
      }`;
    }

    return `<div class="privacy-subblock">
      <div class="privacy-subhead">
        <h3>삭제할 ${esc(meta.label)} 선택</h3>
        <button type="button" class="action secondary compact" data-privacy="reload-items"${s.itemsLoading || s.submitting ? ' disabled' : ''}>${icon(s.itemsLoading ? 'loader-circle' : 'refresh-cw', s.itemsLoading ? 'spin' : '')}목록 새로고침</button>
      </div>
      ${body}
    </div>`;
  }

  function renderImpactPreview(meta) {
    if (!meta.singleton && !s.selectedItemId) {
      return `<div class="privacy-quiet-state">${icon('info')}<span>항목을 선택하면 삭제·변경될 영향 건수와 백업 상태를 조회합니다.</span></div>`;
    }

    if (s.impactLoading) {
      return `<div class="privacy-quiet-state" role="status">${icon('loader-circle', 'spin')}<span>삭제·변경 영향 건수와 백업 상태를 확인하고 있습니다.</span></div>`;
    }

    if (s.impactError) {
      const isAuth = s.impactError.code === 'authentication_required';
      return `<div class="privacy-inline-error" role="alert">
        ${icon('triangle-alert')}
        <div>
          <p>${esc(privacyErrorMessage(s.impactError))}</p>
          <div class="privacy-error-actions">
            ${
              isAuth
                ? '<button type="button" class="action primary compact" data-action="auth">다시 로그인</button>'
                : '<button type="button" class="action secondary compact" data-privacy="reload-impact">영향 다시 조회</button>'
            }
          </div>
        </div>
      </div>`;
    }

    if (!s.impact) {
      return `<div class="privacy-quiet-state privacy-quiet-action">
        ${icon('info')}
        <span>이 범위의 최신 영향 건수를 다시 확인할 수 있습니다.</span>
        <button type="button" class="action secondary compact" data-privacy="reload-impact">영향 다시 확인</button>
      </div>`;
    }

    const selectedItem = !meta.singleton ? s.items.find((entry) => entry.id === s.selectedItemId) : null;
    const totalAffected = COUNT_KEYS.reduce((sum, { key }) => sum + s.impact.counts[key], 0);
    const highlights = impactHighlights(s.impact);

    return `<div class="privacy-impact-box" data-impact-scope="${esc(s.impact.scope)}">
      <div class="privacy-impact-head">
        <div>
          <h3>삭제·변경 영향 확인</h3>
          <p class="privacy-card-sub">${
            selectedItem
              ? `선택 대상: ${esc(selectedItem.label)}`
              : '선택한 범위에서 삭제되거나 변경될 사용자 자료 건수입니다.'
          }</p>
        </div>
        <span class="privacy-impact-total num">영향 합계 ${totalAffected.toLocaleString('ko-KR')}건</span>
      </div>

      <dl class="privacy-counts-grid">
        ${COUNT_KEYS.map(({ key, label }) => {
          const count = s.impact.counts[key];
          return `<div class="privacy-count-cell${count > 0 ? ' is-affected' : ''}" data-count-key="${esc(key)}">
            <dt>${esc(label)}</dt>
            <dd class="num">${count.toLocaleString('ko-KR')}건</dd>
          </div>`;
        }).join('')}
      </dl>

      ${
        highlights.length
          ? `<ul class="privacy-impact-details" aria-label="세부 영향 안내">${highlights
              .map(
                (item) =>
                  `<li class="privacy-impact-detail is-${esc(item.kind)}" data-impact-detail="${esc(item.kind)}">${icon(item.icon)}<span>${esc(item.text)}</span></li>`,
              )
              .join('')}</ul>`
          : ''
      }

      <div class="privacy-backup-box" data-backup-status="${esc(s.impact.backup.status)}">
        <div class="privacy-backup-head">
          <strong>백업 사본</strong>
          ${renderBackupBadge(s.impact.backup)}
        </div>
        <p>${esc(backupCopy(s.impact.backup))}</p>
      </div>

      <p class="privacy-policy-note">${icon('info')}<span>제3자 공고·실거래·법령·뉴스 원자료의 보관 조건은 사용자 입력 삭제 정책과 별개로 관리됩니다.</span></p>

      ${
        !s.confirmOpen
          ? `<div class="privacy-impact-actions">
              <button type="button" class="action secondary compact" data-privacy="reload-impact">영향 다시 확인</button>
              <button type="button" class="action primary" data-privacy="open-confirm">최종 삭제 확인 단계로 이동 ${icon('arrow-right')}</button>
            </div>`
          : ''
      }
    </div>`;
  }

  function renderConfirmationStage(meta) {
    if (!s.confirmOpen || !s.impact) return '';
    const selectedItem = !meta.singleton ? s.items.find((entry) => entry.id === s.selectedItemId) : null;
    const isAccount = Boolean(meta.strongConfirm);
    const phraseMatches = !isAccount || s.confirmPhrase.trim() === ACCOUNT_CONFIRM_PHRASE;
    const hasRetry = Boolean(
      s.submitError &&
        s.pendingRequest &&
        s.pendingRequest.scope === meta.id &&
        s.pendingRequest.targetId === (meta.singleton ? null : s.selectedItemId) &&
        isRetryableError(s.submitError),
    );

    return `<section id="privacy-confirm-stage" class="panel privacy-confirm-card" aria-labelledby="privacy-stage3-heading">
      <div class="privacy-stage-head">
        <span class="privacy-step-num num">3단계</span>
        <div>
          <h2 id="privacy-stage3-heading">${esc(meta.label)} 최종 확인</h2>
          <p class="privacy-card-sub">${
            isAccount
              ? '계정 삭제는 되돌릴 수 없으며 접수 후 로그아웃됩니다. 삭제된 사용자 입력은 다른 기기나 새 분석에서 다시 복원되지 않습니다.'
              : `${
                  selectedItem ? `‘${esc(selectedItem.label)}’ 항목과 ` : ''
                }위 영향 범위의 사용자 자료를 서비스에서 삭제합니다. 삭제된 입력은 다른 기기나 새 분석에서 재사용되지 않습니다.`
          }</p>
        </div>
      </div>

      ${
        isAccount
          ? `<div class="privacy-phrase-field">
              <label for="privacy-account-phrase">확인 문구 입력 (<span class="code">${esc(ACCOUNT_CONFIRM_PHRASE)}</span>)</label>
              <input
                id="privacy-account-phrase"
                name="confirmPhrase"
                type="text"
                autocomplete="off"
                placeholder="${esc(ACCOUNT_CONFIRM_PHRASE)}"
                value="${esc(s.confirmPhrase)}"
                aria-describedby="privacy-phrase-status"
                ${s.submitting ? 'disabled' : ''}
              />
              <p id="privacy-phrase-status" class="privacy-phrase-status${phraseMatches ? ' is-ready' : ''}">${
                phraseMatches
                  ? '확인 문구가 일치합니다.'
                  : `‘${ACCOUNT_CONFIRM_PHRASE}’를 입력하면 요청 버튼이 열립니다.`
              }</p>
            </div>`
          : ''
      }

      ${
        s.submitError
          ? `<div id="privacy-submit-error" class="privacy-inline-error" role="alert" tabindex="-1">
              ${icon('triangle-alert')}
              <div>
                <p>${esc(privacyErrorMessage(s.submitError))}</p>
                ${s.pendingRequest ? `<p>처리 여부를 확인할 접수번호 <code>${esc(s.pendingRequest.receiptId)}</code></p>` : ''}
                <div class="privacy-error-actions">
                  ${
                    s.submitError.code === 'authentication_required'
                      ? '<button type="button" class="action primary compact" data-action="auth">다시 로그인</button>'
                      : hasRetry
                        ? `<button type="button" class="action secondary compact" data-privacy="retry-delete"${s.submitting ? ' disabled' : ''}>${icon('refresh-cw')}같은 접수번호로 다시 시도</button>`
                        : '<button type="button" class="action secondary compact" data-privacy="reload-impact">최신 영향 다시 확인</button>'
                  }
                </div>
              </div>
            </div>`
          : ''
      }

      <div class="privacy-confirm-actions">
        <button type="button" class="action secondary" data-privacy="cancel-confirm"${s.submitting ? ' disabled' : ''}>삭제 취소</button>
        <button
          type="button"
          class="action privacy-destructive-btn"
          data-privacy="confirm-delete"
          ${s.submitting || !phraseMatches ? 'disabled' : ''}
        >${icon(s.submitting ? 'loader-circle' : 'triangle-alert', s.submitting ? 'spin' : '')}${
          s.submitting ? '삭제 요청 처리 중' : esc(meta.confirmAction)
        }</button>
      </div>
    </section>`;
  }

  function renderAuthenticatedView() {
    const meta = s.selectedScope ? SCOPE_MAP.get(s.selectedScope) : null;

    return `<div class="privacy-page">
      <header class="privacy-header">
        <div class="privacy-header-copy">
          <h1>내 데이터 관리</h1>
          <p>계정에 저장된 대화, 분석, 자금, 업로드 파일, 보고서, 공유 프로필은 삭제할 때까지 보관됩니다. 삭제 범위를 선택하고 영향 건수와 백업 상태를 확인한 뒤 진행하세요.</p>
        </div>
        <div class="privacy-header-actions">
          <a class="action secondary compact" href="#profile">${icon('arrow-left')}공유 프로필로 돌아가기</a>
        </div>
      </header>

      ${
        s.banner
          ? `<div class="privacy-banner is-${esc(s.banner.tone)}" role="status">${icon(
              s.banner.tone === 'verified' ? 'circle-check' : 'clock-3',
            )}<span>${esc(s.banner.text)}</span></div>`
          : ''
      }

      ${renderScopeSelector()}

      ${
        meta
          ? `<section class="panel privacy-stage" aria-labelledby="privacy-stage2-heading">
              <div class="privacy-stage-head">
                <span class="privacy-step-num num">2단계</span>
                <div>
                  <h2 id="privacy-stage2-heading">${esc(meta.label)} ${meta.singleton ? '영향 확인' : '대상 선택 및 영향 확인'}</h2>
                  <p class="privacy-card-sub">${esc(meta.detail)}</p>
                </div>
              </div>
              ${renderItemPicker(meta)}
              ${renderImpactPreview(meta)}
            </section>`
          : ''
      }

      ${meta ? renderConfirmationStage(meta) : ''}

      ${
        s.recentReceipts.length
          ? `<section class="privacy-receipts-section" aria-labelledby="privacy-recent-receipts-heading">
              <div class="privacy-section-title">
                <h2 id="privacy-recent-receipts-heading">이번 화면에서 발급된 삭제 접수번호</h2>
                <p>현재 화면 메모리에만 표시되며 브라우저 저장소나 주소에 남기지 않습니다.</p>
              </div>
              <div class="privacy-receipt-list">
                ${s.recentReceipts
                  .map((receipt, index) =>
                    renderReceiptCard(receipt, {
                      id: index === 0 ? 'privacy-latest-receipt' : null,
                      title: `${SCOPE_MAP.get(receipt.scope)?.label ?? receipt.scope} 삭제 접수 내역`,
                      headingLevel: 'h3',
                    }),
                  )
                  .join('')}
              </div>
            </section>`
          : ''
      }

      ${renderLookupSection({ guest: false })}
    </div>`;
  }

  function innerView() {
    if (!s.active) return '';
    const owner = currentUser();
    if (!owner) return renderGuestView();
    if (s.ownerId && owner.id !== s.ownerId) return renderGuestView();
    return renderAuthenticatedView();
  }

  function view() {
    return `<div id="privacy-page-slot">${innerView()}</div>`;
  }

  root?.addEventListener?.('input', (event) => {
    if (!s.active) return;
    const field = event.target;
    if (field?.id === 'privacy-receipt-input') {
      s.lookupInput = field.value;
      if (s.lookupError?.code === 'invalid_receipt_format') {
        s.lookupError = null;
        root.querySelector('#privacy-lookup-error')?.remove();
      }
      return;
    }
    if (field?.id === 'privacy-account-phrase') {
      s.confirmPhrase = field.value;
      if (s.submitError?.code === 'deletion_confirmation_required') {
        s.submitError = null;
      }
      updateAccountPhraseControl();
    }
  });

  root?.addEventListener?.('compositionend', (event) => {
    if (!s.active || event.target?.id !== 'privacy-account-phrase') return;
    s.confirmPhrase = event.target.value;
    updateAccountPhraseControl();
  });

  root?.addEventListener?.('submit', (event) => {
    if (!s.active) return;
    if (event.target?.id === 'privacy-receipt-form') {
      event.preventDefault();
      void lookupReceipt(s.lookupInput);
    }
  });

  root?.addEventListener?.('click', (event) => {
    if (!s.active) return;
    const btn = event.target?.closest?.('[data-privacy]');
    if (!btn || !root.contains(btn)) return;
    const action = btn.dataset.privacy;

    if (action === 'copy-receipt') {
      void copyReceiptCode(btn.dataset.receiptId);
      return;
    }
    if (action === 'refresh-receipt') {
      void refreshReceipt(btn.dataset.receiptId);
      return;
    }
    if (action === 'clear-account-receipt') {
      s.signedOutReceipt = null;
      syncView({ focusSelector: '#privacy-receipt-input' });
      announce('화면에 표시된 삭제 접수번호를 닫았습니다.');
      return;
    }

    if (!currentUser() || (s.ownerId && currentUser().id !== s.ownerId)) return;

    if (action === 'select-scope') {
      void selectScope(btn.dataset.scope);
      return;
    }
    if (action === 'reload-items') {
      if (s.selectedScope) void loadItems(s.selectedScope);
      return;
    }
    if (action === 'load-more-items') {
      void loadMoreItems();
      return;
    }
    if (action === 'select-item') {
      void selectTargetItem(btn.dataset.itemId);
      return;
    }
    if (action === 'reload-impact') {
      if (s.selectedScope) {
        const meta = SCOPE_MAP.get(s.selectedScope);
        void loadImpact(s.selectedScope, meta?.singleton ? null : s.selectedItemId);
      }
      return;
    }
    if (action === 'open-confirm') {
      openConfirmation();
      return;
    }
    if (action === 'cancel-confirm') {
      cancelConfirmation();
      return;
    }
    if (action === 'confirm-delete' || action === 'retry-delete') void submitDeletion();
  });

  root?.addEventListener?.('keydown', (event) => {
    if (!s.active) return;
    if (event.key === 'Escape' && s.confirmOpen && !s.submitting) {
      event.preventDefault();
      cancelConfirmation();
    }
  });

  return { enter, reset, view };
}
