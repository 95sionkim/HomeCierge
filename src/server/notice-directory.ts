import { ApiError } from './http-input.js';
import { isDate, isPublicLabel, isTimestamp, koreaDate } from './public-fields.js';
import { applicationStatus, readIndex } from './notice-search.js';
import type { ApplicationStatus, CollectionSource, DateRange, Notice, ReasonCode, SourceId } from './notice-search.js';

// 예산·지역 없이 게시된 공고 색인에서 오늘(KST)의 접수 상태만 판정한다. 호실·가격·문서 근거는 싣지 않는다.
const contractVersion = 'notice-directory/v1';
const defaultLimit = 20;
const queryKeys = ['includeClosed', 'limit', 'cursor'];
const limitPattern = /^(?:[1-9]|[1-4][0-9]|50)$/;
const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/;
const noticeKeyPattern = /^[0-9]{10}:[0-9]{10}$/;
// 한 공고의 최대 직렬화(주택형 100개, 원형명 64자)는 64 KiB 미만이므로 한 페이지에 적어도 네 공고가 들어간다.
const maxPageBytes = 256 * 1024;
// 공고별 개별 URL은 색인에 없어 추측하지 않는다. 공식 포털만 연결한다.
const officialPortal = { name: '청약홈', url: 'https://www.applyhome.co.kr/' } as const;

// 목록 화면과 관계없는 호실·가격·면적·입주·문서 사유는 공개 결과에서 뺀다.
const directoryReasons: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'publication_date_unverified', 'notice_metadata_conflict', 'notice_kind_unverified', 'notice_kind_unsupported',
  'kind_unverified', 'region_unverified', 'application_unverified', 'application_dates_unverified', 'application_split',
  'model_unverified', 'detail_collection_incomplete', 'detail_budget_exhausted', 'detail_page_limit_reached',
  'source_restricted',
]);
const incompleteModelReasons: readonly ReasonCode[] = ['model_unverified', 'detail_collection_incomplete', 'detail_page_limit_reached'];
// 값이 있어도 같은 공고에 미확인 사유가 있으면 함께 미확인으로 본다. 분석 접수 검사와 같은 기준이다.
const kindUnverifiedReasons: readonly ReasonCode[] = ['kind_unverified', 'notice_kind_unverified', 'notice_kind_unsupported'];
const regionCodePattern = /^[0-9]{5}$/;
const modelSources: Record<CollectionSource, SourceId> = {
  applyhome_apt: 'applyhome_apt_model', applyhome_remainder: 'applyhome_remainder_model',
};

export type NoticeDirectoryOptions = { includeClosed: boolean; limit: number; cursor: string | null };
type ScopeIssue = 'coverage_incomplete' | 'as_of_outside_publication_window' | 'observation_date_mismatch';
type ZeroStatus = 'not_zero' | 'confirmed_zero' | 'indeterminate';
type Verification = 'verified' | 'unverified';
type SelectionBlocker = 'notice_source_ambiguous' | 'notice_metadata_conflict' | 'region_unverified' | 'kind_unverified'
  | 'edition_unverified' | 'house_type_unverified';
type AnalysisInput = {
  kind: 'notice'; noticeSource: CollectionSource; houseManageNo: string; noticeNo: string; edition: string; modelNo: string;
};
type DirectoryModel = {
  modelNo: string; houseType: string | null; selectionBlockers: SelectionBlocker[]; analysisInput: AnalysisInput | null;
};
type DirectoryNotice = {
  houseManageNo: string; noticeNo: string; edition: string; title: string | null;
  kind: Exclude<Notice['kind'], 'unsupported'>; sourceIds: SourceId[];
  regionCode: string | null; regionName: string | null; parentRegionCode: string | null;
  application: DateRange | null; applicationSegments: DateRange[] | null; applicationStatus: ApplicationStatus;
  checks: { schedule: Verification; kind: Verification; region: Verification; models: 'listed' | 'incomplete' | 'unavailable' };
  reasonCodes: ReasonCode[]; models: DirectoryModel[];
};
type Cursor = { v: 1; o: string; d: string; c: boolean; n: number; k: string };

export function parseNoticeDirectoryQuery(params: URLSearchParams): NoticeDirectoryOptions | null {
  if (!(params instanceof URLSearchParams)) return null;
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!queryKeys.includes(key) || seen.has(key)) return null;
    seen.add(key);
  }
  const options: NoticeDirectoryOptions = { includeClosed: false, limit: defaultLimit, cursor: null };
  const includeClosed = params.get('includeClosed');
  if (includeClosed !== null) {
    if (includeClosed !== 'true' && includeClosed !== 'false') return null;
    options.includeClosed = includeClosed === 'true';
  }
  const limit = params.get('limit');
  if (limit !== null) {
    if (!limitPattern.test(limit)) return null;
    options.limit = Number(limit);
  }
  const cursor = params.get('cursor');
  if (cursor !== null) {
    if (!cursorPattern.test(cursor)) return null;
    options.cursor = cursor;
  }
  return options;
}

function readOptions(value: unknown): NoticeDirectoryOptions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !['includeClosed', 'limit', 'cursor'].every(key => Object.hasOwn(value, key))) return null;
  const { includeClosed, limit, cursor } = value as Record<string, unknown>;
  if (typeof includeClosed !== 'boolean' || typeof limit !== 'number' || !limitPattern.test(String(limit))
    || (cursor !== null && (typeof cursor !== 'string' || !cursorPattern.test(cursor)))) return null;
  return { includeClosed, limit, cursor };
}

function indexAssert(condition: unknown): asserts condition {
  if (!condition) throw new Error('invalid_notice_search_index');
}

function isDataRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key =>
    typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}

// 목록 전용 projection의 지역명은 맞춤 검색 색인 계약에 넣지 않고 분리한 뒤 나머지를 기존 검사에 맡긴다.
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

function noticeKey({ houseManageNo, noticeNo }: { houseManageNo: string; noticeNo: string }) {
  return `${houseManageNo}:${noticeNo}`;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

// 커서는 서명하지 않는 공개 위치 정보다. 변조하면 손상 입력으로, 다른 관측·날짜의 것이면 갱신 충돌로 구분한다.
function decodeCursor(value: string): Cursor | null {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return null;
  let cursor: unknown;
  try {
    cursor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
  const keys = Object.keys(cursor);
  if (keys.length !== 6 || !['v', 'o', 'd', 'c', 'n', 'k'].every(key => Object.hasOwn(cursor, key))) return null;
  const { v, o, d, c, n, k } = cursor as Record<string, unknown>;
  if (v !== 1 || !isTimestamp(o) || !isDate(d) || typeof c !== 'boolean'
    || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > 1000
    || typeof k !== 'string' || !noticeKeyPattern.test(k)) return null;
  return { v, o, d, c, n, k };
}

function compareText(left: string, right: string) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

const statusRank: Record<ApplicationStatus, number> = { open: 0, upcoming: 1, closed: 2, unknown: 3 };

// 맞춤 검색과 같은 순서다. 종료·미확인 배치와 동률은 전송 순서를 고정하는 기술 순서다(D-04).
function compareNotices(left: DirectoryNotice, right: DirectoryNotice): number {
  const status = statusRank[left.applicationStatus] - statusRank[right.applicationStatus];
  if (status) return status;
  if (left.application && right.application) {
    if (left.applicationStatus === 'open') {
      const closing = compareText(left.application.end, right.application.end);
      if (closing) return closing;
    }
    if (left.applicationStatus === 'upcoming') {
      const opening = compareText(left.application.start, right.application.start);
      if (opening) return opening;
    }
  }
  return compareText(left.houseManageNo, right.houseManageNo) || compareText(left.noticeNo, right.noticeNo);
}

type RegionCatalog = { codes: ReadonlySet<string>; names: ReadonlyMap<string, string> };

function isKindVerified({ kind, reasonCodes }: Notice) {
  return kind !== 'unknown' && !kindUnverifiedReasons.some(code => reasonCodes.includes(code));
}

function project(notice: Notice, kind: DirectoryNotice['kind'], status: ApplicationStatus, regions: RegionCatalog,
  publicationWindow: DateRange): DirectoryNotice {
  const { houseManageNo, noticeNo, edition, title, regionCode, application, applicationSegments, models } = notice;
  const kindVerified = isKindVerified(notice);
  const regionVerified = regionCode !== null && regions.codes.size > 0 && !notice.reasonCodes.includes('region_unverified');
  const reasons = new Set(notice.reasonCodes.filter(code => directoryReasons.has(code)));
  if (status === 'unknown') reasons.add(applicationSegments ? 'application_split' : 'application_dates_unverified');
  if (kind === 'unknown') reasons.add('kind_unverified');
  if (regionCode === null) reasons.add('region_unverified');
  if (!models.length) reasons.add('model_unverified');

  // 분석 접수와 같은 기준이다. 식별 가능한 목록 출처 하나, 확인된 지역·유형·판본과 주택형이 있어야 한다.
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
  const directoryModels = models.map(({ modelNo, houseType }): DirectoryModel => {
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
    reasonCodes: [...reasons], models: directoryModels,
  };
}

export function evaluateNoticeDirectory(index: unknown, options: NoticeDirectoryOptions, asOf: string) {
  if (!isDate(asOf)) throw new Error('invalid_notice_search_index');
  const query = readOptions(options);
  if (!query) throw new ApiError('invalid_directory_input');
  const cursor = query.cursor === null ? null : decodeCursor(query.cursor);
  if (query.cursor !== null && (!cursor || cursor.c !== query.includeClosed)) throw new ApiError('invalid_directory_input');

  const split = splitRegionNames(index);
  const { dataOrigin, observedAt, publicationWindow, regionCodes, coverage, notices } = readIndex(split.index);
  const regions = { codes: regionCodes, names: readRegionNames(split.names, regionCodes) };
  const counts = { listed: 0, open: 0, upcoming: 0, closed: 0, unknown: 0, kindUnverified: 0,
    excludedClosed: 0, excludedUnsupported: 0 };
  const listed: DirectoryNotice[] = [];
  for (const notice of notices) {
    const { kind } = notice;
    if (kind === 'unsupported') {
      counts.excludedUnsupported += 1;
      continue;
    }
    const status = applicationStatus(notice, asOf);
    if (status === 'closed' && !query.includeClosed) {
      counts.excludedClosed += 1;
      continue;
    }
    listed.push(project(notice, kind, status, regions, publicationWindow));
    counts[status] += 1;
    if (!isKindVerified(notice)) counts.kindUnverified += 1;
  }
  counts.listed = listed.length;
  listed.sort(compareNotices);

  const scopeIssues: ScopeIssue[] = [];
  if (coverage.status !== 'complete') scopeIssues.push('coverage_incomplete');
  if (asOf < publicationWindow.start || asOf > publicationWindow.end) scopeIssues.push('as_of_outside_publication_window');
  const observedKstDate = koreaDate.format(new Date(observedAt));
  if (asOf !== observedKstDate) scopeIssues.push('observation_date_mismatch');
  // 0건은 응답의 공고일 구간과 두 목록 범위에서만 확정한다. 일정 미확인 공고는 접수 중·예정 어느 쪽일 수도 있다.
  const zeroStatus = (status: 'open' | 'upcoming'): ZeroStatus => {
    const group = listed.filter(notice => notice.applicationStatus === status);
    if (group.some(notice => notice.checks.kind === 'verified')) return 'not_zero';
    return group.length || counts.unknown || scopeIssues.length ? 'indeterminate' : 'confirmed_zero';
  };

  let offset = 0;
  if (cursor) {
    if (cursor.o !== observedAt || cursor.d !== asOf) throw new ApiError('directory_page_changed');
    if (cursor.n >= listed.length || noticeKey(listed[cursor.n - 1]) !== cursor.k) {
      throw new ApiError('invalid_directory_input');
    }
    offset = cursor.n;
  }
  const page: DirectoryNotice[] = [];
  let bytes = 2;
  for (const notice of listed.slice(offset, offset + query.limit)) {
    const size = Buffer.byteLength(JSON.stringify(notice)) + 1;
    if (page.length && bytes + size > maxPageBytes) break;
    bytes += size;
    page.push(notice);
  }
  const next = offset + page.length;
  const nextCursor = next < listed.length ? encodeCursor({
    v: 1, o: observedAt, d: asOf, c: query.includeClosed, n: next, k: noticeKey(listed[next - 1]),
  }) : null;

  return {
    contractVersion, dataOrigin, asOf, observedAt, observedKstDate, publicationWindow: { ...publicationWindow },
    coverage: { status: coverage.status, sources: coverage.sources.map(source => ({ ...source })) },
    officialPortal, appliedQuery: { includeClosed: query.includeClosed, limit: query.limit },
    scopeIssues, counts, zeroStatus: { open: zeroStatus('open'), upcoming: zeroStatus('upcoming') },
    notices: page, page: { offset, returned: page.length, nextCursor },
  };
}

export type NoticeDirectory = ReturnType<typeof evaluateNoticeDirectory>;
