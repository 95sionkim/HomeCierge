import { isDeepStrictEqual } from 'node:util';
import { ApiError, isUuid, readJsonRequest } from './http-input.js';
import { isDate, isPublicLabel, koreaDate } from './public-fields.js';
import { applicationStatus, evaluateNoticeSearch, parseNoticeSearchConditions, readIndex } from './notice-search.js';
import type { ApplicationStatus, CollectionSource, DateRange, Notice, NoticeSearchConditions, ReasonCode, SourceId } from './notice-search.js';
import { parseAnalysisRun } from './analysis-runs.js';
import type { AnalysisRun } from './analysis-runs.js';

// 공유 공고 색인에서 공고명·공고번호로 회차를 구분해 찾고, 채팅 홈·메시지 API 입력을 검증한다.
const lookupContractVersion = 'notice-lookup/v1';
const maxReturnedNotices = 50;
const lookupQueryKeys = ['q', 'mode'];
const chatListQueryKeys = ['before', 'limit'];
const limitPattern = /^(?:[1-9]|[1-4][0-9]|50)$/;
const regionCodePattern = /^[0-9]{5}$/;
const noticeNumberPattern = /^[0-9]{10}$/;
const modelNumberPattern = /^[0-9]{1,20}$/;
const editionPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const officialPortal = { name: '청약홈', url: 'https://www.applyhome.co.kr/' } as const;
const outOfScopeNotice =
  '이 검색은 표시된 모집공고일 구간과 관측 시각의 공유 색인 안에서만 조회합니다. 이 기간 밖의 회차는 조회 범위 밖입니다.';

const directoryReasons: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'publication_date_unverified', 'notice_metadata_conflict', 'notice_kind_unverified', 'notice_kind_unsupported',
  'kind_unverified', 'region_unverified', 'application_unverified', 'application_dates_unverified', 'application_split',
  'model_unverified', 'detail_collection_incomplete', 'detail_budget_exhausted', 'detail_page_limit_reached',
  'source_restricted',
]);
const incompleteModelReasons: readonly ReasonCode[] = ['model_unverified', 'detail_collection_incomplete', 'detail_page_limit_reached'];
const kindUnverifiedReasons: readonly ReasonCode[] = ['kind_unverified', 'notice_kind_unverified', 'notice_kind_unsupported'];
const modelSources: Record<CollectionSource, SourceId> = {
  applyhome_apt: 'applyhome_apt_model',
  applyhome_remainder: 'applyhome_remainder_model',
};

export type LookupMode = 'auto' | 'name' | 'number';
export type ResolvedLookupMode = 'name' | 'number';
export type NoticeLookupQuery = { raw: string; normalized: string; mode: ResolvedLookupMode };
export type ChatReplyAction = 'lookup' | 'help' | 'pdf_guide';

export type NoticeAnalysisInput = {
  kind: 'notice';
  noticeSource: CollectionSource;
  houseManageNo: string;
  noticeNo: string;
  edition: string;
  modelNo: string;
};

export type ChatSearchDecision = 'confirm' | 'reject' | 'cancel';

export type ChatSearchSummaryNotice = {
  houseManageNo: string;
  noticeNo: string;
  edition: string;
  title: string | null;
  kind: Exclude<Notice['kind'], 'unsupported'>;
  regionCode: string | null;
  regionName: string | null;
  applicationStatus: ApplicationStatus;
  modelsCount: number;
  matchedRoomsCount: number;
  needsReviewRoomsCount: number;
  minSubtotalWon: string | null;
  maxSubtotalWon: string | null;
  reasonCodes: ReasonCode[];
};

export type ChatSearchResultSummary = {
  contractVersion: 'chat-search-summary/v1';
  asOf: string;
  observedAt: string;
  publicationWindow: DateRange;
  coverage: { status: 'complete' | 'partial' | 'unavailable'; sources: { source: CollectionSource; status: string }[] };
  zeroStatus: 'not_zero' | 'confirmed_zero' | 'indeterminate';
  scopeIssues: string[];
  counts: { matched: number; needsReview: number; excluded: number };
  truncation: { truncated: boolean; matchedOmitted: number; needsReviewOmitted: number };
  appliedConditions: NoticeSearchConditions;
  regionLabels: Record<string, string>;
  matched: ChatSearchSummaryNotice[];
  needsReview: ChatSearchSummaryNotice[];
};

export type ChatHomeOperation =
  | { action: 'list'; before: string | null; limit: number }
  | { action: 'create'; requestId: string; title: string | null }
  | { action: 'detail'; chatId: string }
  | { action: 'rename'; chatId: string; title: string }
  | {
      action: 'message';
      chatId: string;
      requestId: string;
      message: string;
      replyAction: ChatReplyAction;
      query: string | null;
      mode: ResolvedLookupMode | null;
    }
  | { action: 'prepareSearch'; chatId: string; replyId: string }
  | {
      action: 'decideSearch';
      chatId: string;
      replyId: string;
      decision: ChatSearchDecision;
      conditions: NoticeSearchConditions | null;
      resultSummary: ChatSearchResultSummary | null;
    }
  | { action: 'startAnalysis'; chatId: string; requestId: string; input: NoticeAnalysisInput };

type ScopeIssue = 'coverage_incomplete' | 'as_of_outside_publication_window' | 'observation_date_mismatch';
type Verification = 'verified' | 'unverified';
type SelectionBlocker =
  | 'notice_source_ambiguous'
  | 'notice_metadata_conflict'
  | 'region_unverified'
  | 'kind_unverified'
  | 'edition_unverified'
  | 'house_type_unverified';
type LookupModel = {
  modelNo: string;
  houseType: string | null;
  selectionBlockers: SelectionBlocker[];
  analysisInput: NoticeAnalysisInput | null;
};
export type LookupNotice = {
  houseManageNo: string;
  noticeNo: string;
  edition: string;
  title: string | null;
  kind: Exclude<Notice['kind'], 'unsupported'>;
  sourceIds: SourceId[];
  regionCode: string | null;
  regionName: string | null;
  parentRegionCode: string | null;
  application: DateRange | null;
  applicationSegments: DateRange[] | null;
  applicationStatus: ApplicationStatus;
  checks: { schedule: Verification; kind: Verification; region: Verification; models: 'listed' | 'incomplete' | 'unavailable' };
  reasonCodes: ReasonCode[];
  models: LookupModel[];
  sameTitleCount: number;
};

function isDataRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key =>
    typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}

function hasControlChars(value: string, allowNewline = false): boolean {
  return allowNewline
    ? /[\u0000-\u0009\u000b-\u001f\u007f]|\p{Cs}/u.test(value)
    : /[\u0000-\u001f\u007f]|\p{Cs}/u.test(value);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function compactSearchText(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, '').toLowerCase();
}

function normalizeTitleText(value: unknown, maxLength = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const len = codePointLength(trimmed);
  if (len < 1 || len > maxLength || hasControlChars(trimmed, false)) return null;
  return trimmed;
}

function normalizeMessageText(value: unknown): string | null {
  if (typeof value !== 'string' || hasControlChars(value, true)) return null;
  const trimmed = value.trim();
  const len = codePointLength(trimmed);
  if (len < 1 || len > 800) return null;
  return trimmed;
}

function stripNumberSeparators(value: string): string {
  return value.replace(/[\s-]+/g, '');
}

export function parseNoticeLookupQuery(params: URLSearchParams): NoticeLookupQuery | null {
  if (!(params instanceof URLSearchParams)) return null;
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!lookupQueryKeys.includes(key) || seen.has(key)) return null;
    seen.add(key);
  }
  const raw = params.get('q');
  const trimmed = normalizeTitleText(raw, 120);
  if (!trimmed) return null;

  const modeParam = params.get('mode') ?? 'auto';
  if (modeParam !== 'auto' && modeParam !== 'name' && modeParam !== 'number') return null;

  const digits = stripNumberSeparators(trimmed);
  if (modeParam === 'number') {
    if (!/^[0-9]{1,10}$/.test(digits)) return null;
    return { raw: trimmed, normalized: digits, mode: 'number' };
  }
  if (modeParam === 'auto' && /^[0-9]{4,10}$/.test(digits)) {
    return { raw: trimmed, normalized: digits, mode: 'number' };
  }
  const normalized = trimmed.normalize('NFC').replace(/\s+/gu, ' ');
  return { raw: trimmed, normalized, mode: 'name' };
}

const pdfGuidePattern = /pdf|공고문.*(?:올리|업로드|첨부|보완)|파일.*(?:올리|업로드|첨부)/iu;
const greetingOrHelpPattern = /^(?:안녕|안녕하세요|반가워|하이|헬로|도움|도움말|사용법|안내|뭐\s*할\s*수|무엇을\s*할\s*수|기능)/u;
const freeQuestionPattern = /(?:인가요|할까요|될까요|일까요|있나요|없나요|어때요|어떨까요|괜찮나요|얼마인가요|얼마나요|오를까요|떨어질까요|당첨될까요|사도\s*될까요|살까요|추천해|알려\s*줘|알려\s*주세요|설명해|분석해\s*줘|자격|가점|대출|금리|세금|취득세|양도세|청약\s*통장|당첨\s*확률|전망|시세\s*예측)/u;
const searchOrProfileIntentPattern = /(?:[0-9]+(?:\.[0-9]+)?\s*(?:억|천\s*만|만\s*원|㎡|m²|m2|제곱미터|평)|예산|이하|이내|입주\s*(?:시기|월|예정)?|공급\s*면적|전용\s*면적|공유\s*프로필|탐색\s*조건|다음\s*(?:검색)?에도|다음에도|앞으로도|기본\s*조건|조건\s*(?:저장|변경|수정|설정)|(?:^|[\s,])(?:[가-힣]{1,6}(?:시|군|구))(?:랑|이랑|와|과|하고)?\s*(?:에서|쪽|근처))/u;
const numberPrefixPattern = /^(?:청약홈\s*)?(?:공고\s*번호|주택\s*관리\s*번호|번호)\s*[:#]?\s*/u;
const namePrefixPattern = /^(?:공고명|단지명|공고)\s*[:#]?\s*/u;
const lookupSuffixPattern = /\s*(?:공고\s*)?(?:찾아\s*주세요|찾아\s*줘|찾기|검색해\s*주세요|검색해\s*줘|검색|조회해\s*주세요|조회해\s*줘|조회)\s*[.!]?$/u;

export function classifyChatInput(
  rawMessage: unknown,
  explicitMode: LookupMode = 'auto',
): { message: string; action: ChatReplyAction; query: string | null; mode: ResolvedLookupMode | null } | null {
  const message = normalizeMessageText(rawMessage);
  if (!message) return null;
  if (explicitMode !== 'auto' && explicitMode !== 'name' && explicitMode !== 'number') return null;

  const plain = message.normalize('NFC').replace(/\s+/gu, ' ').trim();

  if (explicitMode === 'number') {
    const candidate = stripNumberSeparators(plain.replace(numberPrefixPattern, '').replace(lookupSuffixPattern, '').trim());
    if (!/^[0-9]{1,10}$/.test(candidate)) return null;
    return { message, action: 'lookup', query: candidate, mode: 'number' };
  }

  if (explicitMode === 'name') {
    const cleaned = plain.replace(namePrefixPattern, '').replace(lookupSuffixPattern, '').trim();
    const valid = normalizeTitleText(cleaned, 120);
    if (!valid) return null;
    return { message, action: 'lookup', query: valid, mode: 'name' };
  }

  const tenDigitMatch = /(?<!\d)([0-9]{10})(?!\d)/.exec(plain);
  if (pdfGuidePattern.test(plain) && !tenDigitMatch) {
    return { message, action: 'pdf_guide', query: null, mode: null };
  }

  const unwrappedNumber = stripNumberSeparators(
    plain.replace(numberPrefixPattern, '').replace(lookupSuffixPattern, '').trim(),
  );
  if (/^[0-9]{4,10}$/.test(unwrappedNumber)) {
    return { message, action: 'lookup', query: unwrappedNumber, mode: 'number' };
  }

  const isQuestionOrAdvisory = /[?？]\s*$/.test(plain)
    || greetingOrHelpPattern.test(plain)
    || freeQuestionPattern.test(plain);

  if (tenDigitMatch && !isQuestionOrAdvisory) {
    return { message, action: 'lookup', query: tenDigitMatch[1]!, mode: 'number' };
  }

  if (isQuestionOrAdvisory || searchOrProfileIntentPattern.test(plain)) {
    return { message, action: 'help', query: null, mode: null };
  }

  const cleanedName = plain.replace(namePrefixPattern, '').replace(lookupSuffixPattern, '').trim();
  const validName = normalizeTitleText(cleanedName, 120);
  if (validName && !cleanedName.includes('\n') && /[\p{L}\p{N}]/u.test(validName)) {
    return { message, action: 'lookup', query: validName, mode: 'name' };
  }

  return { message, action: 'help', query: null, mode: null };
}

function indexAssert(condition: unknown): asserts condition {
  if (!condition) throw new Error('invalid_notice_search_index');
}

function splitRegionNames(value: unknown): { index: unknown; names: unknown } {
  if (!isDataRecord(value) || !Object.hasOwn(value, 'regionNames')) return { index: value, names: undefined };
  const { regionNames: names, ...descriptors } = Object.getOwnPropertyDescriptors(value);
  return { index: Object.defineProperties(Object.create(Object.getPrototypeOf(value)), descriptors), names: names.value };
}

function readRegionNames(value: unknown, regionCodes: ReadonlySet<string>): ReadonlyMap<string, string> {
  if (value === undefined) return new Map();
  indexAssert(isDataRecord(value));
  const entries = Object.entries(value);
  indexAssert(entries.length <= regionCodes.size && entries.every(([code, name]) =>
    regionCodePattern.test(code) && regionCodes.has(code) && isPublicLabel(name, 120)));
  return new Map(entries as [string, string][]);
}

function isKindVerified({ kind, reasonCodes }: Notice) {
  return kind !== 'unknown' && !kindUnverifiedReasons.some(code => reasonCodes.includes(code));
}

function compareText(left: string, right: string) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function projectNotice(
  notice: Notice,
  kind: LookupNotice['kind'],
  status: ApplicationStatus,
  regions: { codes: ReadonlySet<string>; names: ReadonlyMap<string, string> },
  publicationWindow: DateRange,
  sameTitleCount: number,
): LookupNotice {
  const { houseManageNo, noticeNo, edition, title, regionCode, application, applicationSegments, models } = notice;
  const kindVerified = isKindVerified(notice);
  const regionVerified = regionCode !== null && regions.codes.size > 0 && !notice.reasonCodes.includes('region_unverified');
  const reasons = new Set(notice.reasonCodes.filter(code => directoryReasons.has(code)));
  if (status === 'unknown') reasons.add(applicationSegments ? 'application_split' : 'application_dates_unverified');
  if (kind === 'unknown') reasons.add('kind_unverified');
  if (regionCode === null) reasons.add('region_unverified');
  if (!models.length) reasons.add('model_unverified');

  const collections = notice.sourceIds.filter((source): source is CollectionSource => Object.hasOwn(modelSources, source));
  const noticeSource = collections.length === 1 && notice.sourceIds.includes(modelSources[collections[0]])
    ? collections[0] : null;
  const blockers: SelectionBlocker[] = [];
  if (!noticeSource) blockers.push('notice_source_ambiguous');
  if (notice.reasonCodes.includes('notice_metadata_conflict')) blockers.push('notice_metadata_conflict');
  if (!regionVerified) blockers.push('region_unverified');
  if (!kindVerified) blockers.push('kind_unverified');
  if (!isDate(edition) || edition < publicationWindow.start || edition > publicationWindow.end
    || notice.reasonCodes.includes('publication_date_unverified')) {
    blockers.push('edition_unverified');
  }
  const lookupModels = models.map(({ modelNo, houseType }): LookupModel => {
    const selectionBlockers = houseType === null ? [...blockers, 'house_type_unverified' as const] : [...blockers];
    const analysisInput = noticeSource && !selectionBlockers.length
      ? { kind: 'notice' as const, noticeSource, houseManageNo, noticeNo, edition, modelNo } : null;
    return { modelNo, houseType, selectionBlockers, analysisInput };
  });

  return {
    houseManageNo, noticeNo, edition, title, kind,
    sourceIds: notice.sourceIds.filter(source => source !== 'applyhome_notice_pdf'),
    regionCode, regionName: regionVerified ? regions.names.get(regionCode) ?? null : null,
    parentRegionCode: notice.parentRegionCode ?? null,
    application: application && { ...application },
    applicationSegments: applicationSegments ? applicationSegments.map(range => ({ ...range })) : null,
    applicationStatus: status,
    checks: {
      schedule: status === 'unknown' ? 'unverified' : 'verified',
      kind: kindVerified ? 'verified' : 'unverified',
      region: regionVerified ? 'verified' : 'unverified',
      models: !models.length ? 'unavailable'
        : incompleteModelReasons.some(code => notice.reasonCodes.includes(code)) ? 'incomplete' : 'listed',
    },
    reasonCodes: [...reasons],
    models: lookupModels,
    sameTitleCount,
  };
}

export function evaluateNoticeLookup(index: unknown, query: NoticeLookupQuery, asOf: string) {
  if (!isDate(asOf)) throw new Error('invalid_notice_search_index');
  const split = splitRegionNames(index);
  const { dataOrigin, observedAt, publicationWindow, regionCodes, coverage, notices } = readIndex(split.index);
  const regions = { codes: regionCodes, names: readRegionNames(split.names, regionCodes) };

  const compactNeedle = query.mode === 'name' ? compactSearchText(query.normalized) : '';
  let excludedUnsupported = 0;
  const matched: Notice[] = [];
  for (const notice of notices) {
    if (notice.kind === 'unsupported') {
      excludedUnsupported += 1;
      continue;
    }
    if (query.mode === 'number') {
      const exact = query.normalized.length === 10
        ? notice.noticeNo === query.normalized || notice.houseManageNo === query.normalized
        : notice.noticeNo.includes(query.normalized) || notice.houseManageNo.includes(query.normalized);
      if (exact) matched.push(notice);
    } else if (notice.title !== null && compactSearchText(notice.title).includes(compactNeedle)) {
      matched.push(notice);
    }
  }

  // 같은 이름의 다른 회차를 합치지 않는다. 대신 같은 공고명 건수를 계산해 구분 안내에 사용한다.
  const titleCounts = new Map<string, number>();
  for (const notice of matched) {
    if (notice.title !== null) {
      const key = notice.title.normalize('NFC').trim();
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
  }
  const sameTitleGroups = [...titleCounts.values()].filter(count => count > 1).length;

  const projected = matched.map(notice => {
    const status = applicationStatus(notice, asOf);
    const titleCount = notice.title !== null ? (titleCounts.get(notice.title.normalize('NFC').trim()) ?? 1) : 1;
    return projectNotice(notice, notice.kind as LookupNotice['kind'], status, regions, publicationWindow, titleCount);
  });

  projected.sort((left, right) => {
    if (query.mode === 'number') {
      const leftExact = left.noticeNo === query.normalized || left.houseManageNo === query.normalized ? 0 : 1;
      const rightExact = right.noticeNo === query.normalized || right.houseManageNo === query.normalized ? 0 : 1;
      if (leftExact !== rightExact) return leftExact - rightExact;
    }
    const leftDate = isDate(left.edition) ? left.edition : '';
    const rightDate = isDate(right.edition) ? right.edition : '';
    if (leftDate !== rightDate) return compareText(rightDate, leftDate);
    return compareText(left.houseManageNo, right.houseManageNo) || compareText(left.noticeNo, right.noticeNo);
  });

  const returned = projected.slice(0, maxReturnedNotices);
  const scopeIssues: ScopeIssue[] = [];
  if (coverage.status !== 'complete') scopeIssues.push('coverage_incomplete');
  if (asOf < publicationWindow.start || asOf > publicationWindow.end) scopeIssues.push('as_of_outside_publication_window');
  const observedKstDate = koreaDate.format(new Date(observedAt));
  if (asOf !== observedKstDate) scopeIssues.push('observation_date_mismatch');

  return {
    contractVersion: lookupContractVersion,
    dataOrigin,
    asOf,
    observedAt,
    observedKstDate,
    publicationWindow: { ...publicationWindow },
    coverage: { status: coverage.status, sources: coverage.sources.map(source => ({ ...source })) },
    officialPortal,
    scopeIssues,
    query: { raw: query.raw, normalized: query.normalized, mode: query.mode },
    counts: {
      matched: matched.length,
      returned: returned.length,
      sameTitleGroups,
      excludedUnsupported,
      totalIndexed: notices.length,
    },
    outOfScopeNotice,
    notices: returned,
  };
}

export type NoticeLookupResult = ReturnType<typeof evaluateNoticeLookup>;

export function parseChatListQuery(params: URLSearchParams): { before: string | null; limit: number } | null {
  if (!(params instanceof URLSearchParams)) return null;
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!chatListQueryKeys.includes(key) || seen.has(key)) return null;
    seen.add(key);
  }
  let before: string | null = null;
  const beforeRaw = params.get('before');
  if (beforeRaw !== null) {
    if (!isUuid(beforeRaw)) return null;
    before = beforeRaw.toLowerCase();
  }
  let limit = 20;
  const limitRaw = params.get('limit');
  if (limitRaw !== null) {
    if (!limitPattern.test(limitRaw)) return null;
    limit = Number(limitRaw);
  }
  return { before, limit };
}

function parseNoticeAnalysisInput(value: unknown): NoticeAnalysisInput | null {
  if (!isDataRecord(value)) return null;
  const keys = Object.keys(value);
  const required = ['kind', 'noticeSource', 'houseManageNo', 'noticeNo', 'edition', 'modelNo'];
  if (keys.length !== required.length || !required.every(k => Object.hasOwn(value, k))) return null;
  const { kind, noticeSource, houseManageNo, noticeNo, edition, modelNo } = value;
  if (kind !== 'notice'
    || (noticeSource !== 'applyhome_apt' && noticeSource !== 'applyhome_remainder')
    || typeof houseManageNo !== 'string' || !noticeNumberPattern.test(houseManageNo)
    || typeof noticeNo !== 'string' || !noticeNumberPattern.test(noticeNo)
    || typeof edition !== 'string' || !editionPattern.test(edition)
    || typeof modelNo !== 'string' || !modelNumberPattern.test(modelNo)) {
    return null;
  }
  return { kind, noticeSource, houseManageNo, noticeNo, edition, modelNo };
}

const maxChatSummaryNotices = 10;

function trimDecimalString(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

function canonicalizeSearchConditions(conditions: NoticeSearchConditions): NoticeSearchConditions {
  return {
    regionCodes: [...conditions.regionCodes].sort(compareText),
    budgetMaxWon: conditions.budgetMaxWon,
    includeClosed: conditions.includeClosed,
    ...(conditions.supplyArea
      ? {
          supplyArea: {
            min: trimDecimalString(conditions.supplyArea.min),
            max: trimDecimalString(conditions.supplyArea.max),
            unit: conditions.supplyArea.unit,
          },
        }
      : {}),
    ...(conditions.moveIn ? { moveIn: { start: conditions.moveIn.start, end: conditions.moveIn.end } } : {}),
  };
}

type EvaluatedNoticeSearch = ReturnType<typeof evaluateNoticeSearch>;

function summarizeSearchNotice(
  notice: EvaluatedNoticeSearch['matched'][number],
  group: 'matched' | 'needsReview',
  regionNames: ReadonlyMap<string, string>,
): ChatSearchSummaryNotice {
  const prices: bigint[] = [];
  for (const model of notice.models) {
    const rooms = group === 'matched' ? model.matchedRooms : model.needsReviewRooms;
    for (const room of rooms) {
      if (room.subtotalWon !== null) prices.push(BigInt(room.subtotalWon));
    }
  }
  let minSubtotalWon: string | null = null;
  let maxSubtotalWon: string | null = null;
  if (prices.length > 0) {
    let min = prices[0]!;
    let max = prices[0]!;
    for (const price of prices) {
      if (price < min) min = price;
      if (price > max) max = price;
    }
    minSubtotalWon = min.toString();
    maxSubtotalWon = max.toString();
  }
  return {
    houseManageNo: notice.houseManageNo,
    noticeNo: notice.noticeNo,
    edition: notice.edition,
    title: notice.title,
    kind: notice.kind as Exclude<Notice['kind'], 'unsupported'>,
    regionCode: notice.regionCode,
    regionName: notice.regionCode ? regionNames.get(notice.regionCode) ?? null : null,
    applicationStatus: notice.applicationStatus,
    modelsCount: notice.models.length,
    matchedRoomsCount: notice.counts.matchedRooms,
    needsReviewRoomsCount: notice.counts.needsReviewRooms,
    minSubtotalWon,
    maxSubtotalWon,
    reasonCodes: notice.reasonCodes.slice(0, 32),
  };
}

export function buildChatSearchSummary(
  result: EvaluatedNoticeSearch,
  regionNames: ReadonlyMap<string, string>,
): ChatSearchResultSummary {
  const appliedConditions = canonicalizeSearchConditions(result.appliedConditions);
  const matched = result.matched.slice(0, maxChatSummaryNotices).map(n => summarizeSearchNotice(n, 'matched', regionNames));
  const needsReview = result.needsReview.slice(0, maxChatSummaryNotices).map(n => summarizeSearchNotice(n, 'needsReview', regionNames));
  const matchedOmitted = Math.max(0, result.counts.matched - matched.length);
  const needsReviewOmitted = Math.max(0, result.counts.needsReview - needsReview.length);
  const regionLabels: Record<string, string> = {};
  for (const code of appliedConditions.regionCodes) {
    const label = regionNames.get(code);
    if (label) regionLabels[code] = label;
  }
  for (const item of [...matched, ...needsReview]) {
    if (item.regionCode) {
      const label = regionNames.get(item.regionCode);
      if (label) regionLabels[item.regionCode] = label;
    }
  }
  return {
    contractVersion: 'chat-search-summary/v1',
    asOf: result.asOf,
    observedAt: result.observedAt,
    publicationWindow: { ...result.publicationWindow },
    coverage: { status: result.coverage.status, sources: result.coverage.sources.map(source => ({ ...source })) },
    zeroStatus: result.zeroStatus as ChatSearchResultSummary['zeroStatus'],
    scopeIssues: [...result.scopeIssues],
    counts: { ...result.counts },
    truncation: {
      truncated: result.truncation.truncated || matchedOmitted > 0 || needsReviewOmitted > 0,
      matchedOmitted,
      needsReviewOmitted,
    },
    appliedConditions,
    regionLabels,
    matched,
    needsReview,
  };
}

export type ChatRouteTarget = {
  chatId?: string;
  sub?: 'messages' | 'analyses' | 'replyDecision';
  replyId?: string;
};

export async function serveChatHome(
  request: Request,
  headers: Headers,
  target: ChatRouteTarget,
  deps: {
    chatHome: (operation: ChatHomeOperation, signal: AbortSignal) => Promise<unknown>;
    getNoticeSearchIndex: (signal: AbortSignal, purpose: 'directory' | 'search') => Promise<unknown>;
    asOf: string;
  },
): Promise<Response> {
  const url = new URL(request.url);
  const respond = (body: unknown, status: number) => Response.json(body, { status, headers });

  if (!target.chatId) {
    if (request.method === 'GET') {
      const options = parseChatListQuery(url.searchParams);
      if (!options) throw new ApiError('invalid_chat_input');
      return respond(await deps.chatHome({ action: 'list', ...options }, request.signal), 200);
    }
    if (url.search) throw new ApiError('invalid_chat_input');
    const body = await readJsonRequest(request, 'invalid_chat_input');
    if (!isDataRecord(body) || !Object.keys(body).every(k => k === 'requestId' || k === 'title')) {
      throw new ApiError('invalid_chat_input');
    }
    if (!isUuid(body.requestId)) throw new ApiError('invalid_chat_input');
    let title: string | null = null;
    if (Object.hasOwn(body, 'title') && body.title !== null && body.title !== undefined) {
      title = normalizeTitleText(body.title, 200);
      if (!title) throw new ApiError('invalid_chat_input');
    }
    const created = await deps.chatHome(
      { action: 'create', requestId: body.requestId.toLowerCase(), title },
      request.signal,
    );
    if (!isDataRecord(created) || !isDataRecord(created.chat) || !isUuid(created.chat.chatId)) {
      throw new Error('invalid_chat_response');
    }
    headers.set('Location', `/api/v1/chats/${created.chat.chatId}`);
    return respond(created, 201);
  }

  if (!isUuid(target.chatId) || url.search) throw new ApiError('invalid_chat_input');
  const chatId = target.chatId.toLowerCase();

  if (!target.sub) {
    if (request.method === 'GET') {
      return respond(await deps.chatHome({ action: 'detail', chatId }, request.signal), 200);
    }
    const body = await readJsonRequest(request, 'invalid_chat_input');
    if (!isDataRecord(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'title')) {
      throw new ApiError('invalid_chat_input');
    }
    const title = normalizeTitleText(body.title, 200);
    if (!title) throw new ApiError('invalid_chat_input');
    return respond(await deps.chatHome({ action: 'rename', chatId, title }, request.signal), 200);
  }

  if (target.sub === 'messages') {
    const body = await readJsonRequest(request, 'invalid_chat_input');
    if (!isDataRecord(body) || !Object.keys(body).every(k => k === 'requestId' || k === 'message' || k === 'mode')) {
      throw new ApiError('invalid_chat_input');
    }
    if (!isUuid(body.requestId)) throw new ApiError('invalid_chat_input');
    const explicitMode = body.mode === undefined ? 'auto' : body.mode;
    if (explicitMode !== 'auto' && explicitMode !== 'name' && explicitMode !== 'number') {
      throw new ApiError('invalid_chat_input');
    }
    const classified = classifyChatInput(body.message, explicitMode);
    if (!classified) throw new ApiError('invalid_chat_input');

    const saved = await deps.chatHome(
      {
        action: 'message',
        chatId,
        requestId: body.requestId.toLowerCase(),
        message: classified.message,
        replyAction: classified.action,
        query: classified.query,
        mode: classified.mode,
      },
      request.signal,
    );
    if (!isDataRecord(saved) || saved.chatId !== chatId) throw new Error('invalid_chat_response');

    let lookup: NoticeLookupResult | null = null;
    let lookupError: string | null = null;
    if (classified.action === 'lookup' && classified.query && classified.mode) {
      try {
        const index = await deps.getNoticeSearchIndex(request.signal, 'directory');
        if (index === null) {
          lookupError = 'search_index_not_ready';
        } else if (typeof index !== 'object' || !('dataOrigin' in index) || index.dataOrigin !== 'collected') {
          lookupError = 'backend_unavailable';
        } else {
          lookup = evaluateNoticeLookup(
            index,
            { raw: classified.query, normalized: classified.query, mode: classified.mode },
            deps.asOf,
          );
        }
      } catch (error) {
        if (error instanceof ApiError && (error.code === 'search_source_restricted' || error.code === 'search_index_not_ready')) {
          lookupError = error.code;
        } else {
          lookupError = 'backend_unavailable';
        }
      }
    }

    return respond({ ...saved, lookup, lookupError }, 200);
  }

  if (target.sub === 'replyDecision') {
    if (!isUuid(target.replyId)) throw new ApiError('invalid_chat_input');
    const replyId = target.replyId.toLowerCase();
    const body = await readJsonRequest(request, 'invalid_chat_input');
    if (!isDataRecord(body) || !Object.keys(body).every(k => k === 'decision' || k === 'conditions')) {
      throw new ApiError('invalid_chat_input');
    }
    const decision = body.decision;
    if (decision !== 'confirm' && decision !== 'reject' && decision !== 'cancel') {
      throw new ApiError('invalid_chat_input');
    }

    if (decision === 'reject' || decision === 'cancel') {
      if (Object.hasOwn(body, 'conditions') && body.conditions !== undefined && body.conditions !== null) {
        throw new ApiError('invalid_chat_input');
      }
      const saved = await deps.chatHome(
        { action: 'decideSearch', chatId, replyId, decision, conditions: null, resultSummary: null },
        request.signal,
      );
      if (!isDataRecord(saved) || saved.chatId !== chatId) throw new Error('invalid_chat_response');
      return respond({ ...saved, searchResult: null }, 200);
    }

    let overrideConditions: NoticeSearchConditions | null = null;
    if (Object.hasOwn(body, 'conditions') && body.conditions !== undefined && body.conditions !== null) {
      overrideConditions = parseNoticeSearchConditions(body.conditions);
      if (!overrideConditions) throw new ApiError('invalid_search_input');
    }

    const prep = await deps.chatHome({ action: 'prepareSearch', chatId, replyId }, request.signal);
    if (!isDataRecord(prep) || prep.chatId !== chatId || typeof prep.status !== 'string') {
      throw new Error('invalid_chat_response');
    }

    const effectiveRaw = overrideConditions ?? parseNoticeSearchConditions(prep.searchProposal);
    if (!effectiveRaw) throw new ApiError('invalid_search_input');
    const effectiveCanonical = canonicalizeSearchConditions(effectiveRaw);

    if (prep.status === 'rejected' || prep.status === 'cancelled') {
      throw new ApiError('chat_conflict');
    }
    if (prep.status === 'confirmed') {
      const confirmedParsed = parseNoticeSearchConditions(prep.confirmedConditions);
      if (!confirmedParsed || !isDeepStrictEqual(canonicalizeSearchConditions(confirmedParsed), effectiveCanonical)) {
        throw new ApiError('chat_conflict');
      }
      return respond(
        {
          contractVersion: 'chat-search-decision/v1',
          chatId,
          replyId,
          agentReply: prep.agentReply ?? null,
          resultMessage: prep.resultMessage ?? null,
          searchResult: null,
        },
        200,
      );
    }
    if (prep.status !== 'pending') {
      throw new ApiError('chat_conflict');
    }

    const searchIndex = await deps.getNoticeSearchIndex(request.signal, 'search');
    if (searchIndex === null) throw new ApiError('search_index_not_ready');
    if (typeof searchIndex !== 'object' || !('dataOrigin' in searchIndex) || searchIndex.dataOrigin !== 'collected') {
      throw new Error('invalid_search_index');
    }

    const searchResult = evaluateNoticeSearch(searchIndex, effectiveCanonical, deps.asOf);
    let regionNames: ReadonlyMap<string, string> = new Map();
    try {
      const dirIndex = await deps.getNoticeSearchIndex(request.signal, 'directory');
      if (dirIndex && typeof dirIndex === 'object' && 'dataOrigin' in dirIndex && dirIndex.dataOrigin === 'collected') {
        const split = splitRegionNames(dirIndex);
        const parsedDir = readIndex(split.index);
        regionNames = readRegionNames(split.names, parsedDir.regionCodes);
      }
    } catch {
      // 디렉터리 표시명 조회는 보조 표시 용도이므로 실패해도 맞춤 검색 실행을 막지 않는다.
    }

    const resultSummary = buildChatSearchSummary(searchResult, regionNames);
    const saved = await deps.chatHome(
      {
        action: 'decideSearch',
        chatId,
        replyId,
        decision: 'confirm',
        conditions: effectiveCanonical,
        resultSummary,
      },
      request.signal,
    );
    if (!isDataRecord(saved) || saved.chatId !== chatId) throw new Error('invalid_chat_response');
    return respond({ ...saved, searchResult }, 200);
  }

  // POST /api/v1/chats/:chatId/analyses
  const body = await readJsonRequest(request, 'invalid_run_input');
  if (!isDataRecord(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'requestId') || !Object.hasOwn(body, 'input')) {
    throw new ApiError('invalid_run_input');
  }
  if (!isUuid(body.requestId)) throw new ApiError('invalid_run_input');
  const input = parseNoticeAnalysisInput(body.input);
  if (!input) throw new ApiError('invalid_run_input');

  const rawResult = await deps.chatHome(
    { action: 'startAnalysis', chatId, requestId: body.requestId.toLowerCase(), input },
    request.signal,
  );
  if (!isDataRecord(rawResult) || rawResult.chatId !== chatId) throw new Error('invalid_run_response');
  const { chatId: returnedChatId, ...runPayload } = rawResult;
  const parsed: AnalysisRun | null = parseAnalysisRun(runPayload);
  if (!parsed || !isDeepStrictEqual(parsed.input, input)) throw new Error('invalid_run_response');

  headers.set('Location', `/api/v1/analyses/${parsed.analysisId}/runs/${parsed.runId}`);
  return respond({ ...parsed, chatId: returnedChatId }, 202);
}
