// 공개 공고 색인에서만 조건을 판정한다. 원응답과 사용자별 문서 근거는 이 계약에 없다.
const collectionSources = ['applyhome_apt', 'applyhome_remainder'] as const;
const sourceIds = [...collectionSources, 'applyhome_apt_model', 'applyhome_remainder_model', 'applyhome_notice_pdf'] as const;
const sourceStatuses = ['complete', 'empty', 'partial', 'failed'] as const;
const coverageStatuses = ['complete', 'partial', 'unavailable'] as const;
const noticeKinds = ['new_sale', 'unranked', 'remaining', 'resupply', 'unknown', 'unsupported'] as const;
const dataOrigins = ['collected', 'synthetic'] as const;
const reasonCodes = [
  'publication_date_unverified', 'notice_metadata_conflict', 'notice_kind_unverified', 'notice_kind_unsupported',
  'kind_unverified', 'region_unverified', 'application_unverified', 'application_dates_unverified', 'application_split',
  'move_in_unverified', 'model_unverified', 'detail_collection_incomplete', 'detail_budget_exhausted',
  'detail_page_limit_reached', 'document_budget_exhausted', 'official_document_unverified', 'source_restricted',
  'source_unverified', 'inventory_unverified', 'inventory_incomplete', 'supply_area_unverified', 'room_price_unverified',
  'price_unverified',
] as const;

const regionCodePattern = /^[0-9]{5}$/;
const noticeNumberPattern = /^[0-9]{10}$/;
const editionPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const modelNumberPattern = /^[0-9]{1,20}$/;
const officialDocumentPattern = /^applyhome:([0-9]{10}):([0-9]{10}):[0-9]{1,20}:[0-9]{1,20}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const nonPublicLabelPattern = /\p{Cc}|\p{Cs}|:\/\/|\/\/[a-z0-9]|www\.|https?:|ftp:|file:|javascript:|data:|blob:|mailto:|tel:|analysis-uploads|upload[:/]|@/iu;
const wonPattern = /^(?:0|[1-9][0-9]{0,19})$/;
const positiveAreaPattern = /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/;
const monthPattern = /^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])$/;
const timestampPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt](?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,9})?(?:[Zz]|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/;

const pyeongM2Numerator = 400n;
const pyeongM2Denominator = 121n;
const koreaDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });
const maxIndexBytes = 2 * 1024 * 1024;
const maxNoticesPerList = 50;
// 세 그룹을 12개씩 담으면 모델 최대 36개와 호실 최대 24개에 근거를 붙인다.
// 근거(960×191B), 모델·호실의 나머지 필드(60×600B), 공고 공통 필드(4 KiB)를 합쳐도 250 KiB 이내다.
const maxRowsPerDetailGroup = 12;
// 목록별 한도로 두 집계의 상세를 함께 제공한다. 512 KiB 중 나머지는 조건·범위·건수에 사용한다.
const maxBytesPerList = 250 * 1024;

type DateRange = { start: string; end: string };
type AreaRange = { min: string; max: string; unit: 'm2' | 'pyeong' };
export type NoticeSearchConditions = {
  regionCodes: string[];
  budgetMaxWon: string;
  supplyArea?: AreaRange;
  moveIn?: DateRange;
  includeClosed: boolean;
};

type CollectionSource = typeof collectionSources[number];
type SourceId = typeof sourceIds[number];
type ReasonCode = typeof reasonCodes[number];
type Coverage = {
  status: typeof coverageStatuses[number];
  sources: { source: CollectionSource; status: typeof sourceStatuses[number] }[];
};
type EvidenceRef = { document: string; version: string; page: number };
type Room = { room: string; subtotalWon: string | null; priceEvidence: EvidenceRef[] };
type Model = {
  modelNo: string; houseType: string | null; supplyAreaM2: string | null; areaEvidence: EvidenceRef[]; rooms: Room[];
};
type Notice = {
  houseManageNo: string; noticeNo: string; edition: string; title: string | null;
  kind: typeof noticeKinds[number]; regionCode: string | null; parentRegionCode?: string;
  application: DateRange | null; applicationSegments?: DateRange[]; moveIn: DateRange | null;
  inventoryComplete: boolean; models: Model[]; sourceIds: SourceId[]; reasonCodes: ReasonCode[];
};
type Index = {
  dataOrigin: typeof dataOrigins[number]; observedAt: string; publicationWindow: DateRange;
  regionCodes: ReadonlySet<string>; coverage: Coverage; notices: Notice[];
};

function hasShape(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && required.every(key => Object.hasOwn(value, key))
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key))
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function isDate(value: unknown): value is string {
  if (!matches(value, /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function isMonth(value: unknown): value is string {
  return matches(value, monthPattern);
}

function isArea(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 24 && positiveAreaPattern.test(value);
}

function readRange(value: unknown, isBound: (value: unknown) => value is string): DateRange | null {
  if (!hasShape(value, ['start', 'end'])) return null;
  const { start, end } = value;
  return isBound(start) && isBound(end) && start <= end ? { start, end } : null;
}

type Decimal = { units: bigint; scale: bigint };

function decimal(value: string): Decimal {
  const [whole, fraction = ''] = value.split('.');
  return { units: BigInt(whole + fraction), scale: 10n ** BigInt(fraction.length) };
}

function atMost(left: Decimal, right: Decimal): boolean {
  return left.units * right.scale <= right.units * left.scale;
}

export function parseNoticeSearchConditions(input: unknown): NoticeSearchConditions | null {
  if (!hasShape(input, ['regionCodes', 'budgetMaxWon'], ['supplyArea', 'moveIn', 'includeClosed'])) return null;
  const { regionCodes, budgetMaxWon } = input;
  if (!Array.isArray(regionCodes) || regionCodes.length === 0 || regionCodes.length > 50
    || !matches(budgetMaxWon, wonPattern)) return null;
  const regions = new Set<string>();
  for (const code of regionCodes) {
    if (!matches(code, regionCodePattern) || regions.has(code)) return null;
    regions.add(code);
  }

  const conditions: NoticeSearchConditions = { regionCodes: [...regions], budgetMaxWon, includeClosed: false };
  if (Object.hasOwn(input, 'includeClosed')) {
    if (typeof input.includeClosed !== 'boolean') return null;
    conditions.includeClosed = input.includeClosed;
  }
  if (Object.hasOwn(input, 'supplyArea')) {
    if (!hasShape(input.supplyArea, ['min', 'max', 'unit'])) return null;
    const { min, max, unit } = input.supplyArea;
    if (!isArea(min) || !isArea(max) || (unit !== 'm2' && unit !== 'pyeong')
      || !atMost(decimal(min), decimal(max))) return null;
    conditions.supplyArea = { min, max, unit };
  }
  if (Object.hasOwn(input, 'moveIn')) {
    const range = readRange(input.moveIn, isMonth);
    if (!range) return null;
    conditions.moveIn = range;
  }
  return conditions;
}

function indexAssert(condition: unknown): asserts condition {
  if (!condition) throw new Error('invalid_notice_search_index');
}

function isChoice<T extends string>(choices: readonly T[], value: unknown): value is T {
  return choices.some(choice => choice === value);
}

function readList<T>(value: unknown, maxLength: number, read: (value: unknown) => T): T[] {
  indexAssert(Array.isArray(value) && value.length <= maxLength);
  return Array.from(value, read);
}

function assertUnique(keys: readonly string[]) {
  indexAssert(new Set(keys).size === keys.length);
}

function isPublicLabel(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && value === value.trim() && !nonPublicLabelPattern.test(value);
}

function readEvidence(value: unknown, houseManageNo: string, noticeNo: string): EvidenceRef {
  indexAssert(hasShape(value, ['document', 'version', 'page']));
  const { document, version, page } = value;
  indexAssert(typeof document === 'string' && document.length <= 73);
  const identity = officialDocumentPattern.exec(document);
  indexAssert(identity && identity[1] === houseManageNo && identity[2] === noticeNo
    && matches(version, digestPattern) && typeof page === 'number'
    && Number.isInteger(page) && page > 0 && page <= 2_147_483_647);
  return { document, version, page };
}

function readRoom(value: unknown, readRef: (value: unknown) => EvidenceRef): Room {
  indexAssert(hasShape(value, ['room', 'subtotalWon', 'priceEvidence']));
  const { room, subtotalWon } = value;
  const priceEvidence = readList(value.priceEvidence, 16, readRef);
  indexAssert(isPublicLabel(room, 64) && (subtotalWon === null
    || (matches(subtotalWon, wonPattern) && subtotalWon !== '0' && priceEvidence.length > 0)));
  return { room, subtotalWon, priceEvidence };
}

function readModel(value: unknown, readRef: (value: unknown) => EvidenceRef): Model {
  indexAssert(hasShape(value, ['modelNo', 'houseType', 'supplyAreaM2', 'areaEvidence', 'rooms']));
  const { modelNo, houseType, supplyAreaM2 } = value;
  const areaEvidence = readList(value.areaEvidence, 16, readRef);
  indexAssert(matches(modelNo, modelNumberPattern) && (houseType === null || isPublicLabel(houseType, 64))
    && (supplyAreaM2 === null || (isArea(supplyAreaM2) && areaEvidence.length > 0)));
  const rooms = readList(value.rooms, 2000, room => readRoom(room, readRef));
  assertUnique(rooms.map(room => room.room));
  return { modelNo, houseType, supplyAreaM2, areaEvidence, rooms };
}

function readApplicationSegments(value: unknown, application: DateRange | null): DateRange[] {
  indexAssert(application);
  let previousEnd = '';
  return readList(value, 10, entry => {
    const range = readRange(entry, isDate);
    indexAssert(range && application.start <= range.start && range.end <= application.end && previousEnd < range.start);
    previousEnd = range.end;
    return range;
  });
}

function readNotice(value: unknown): Notice {
  indexAssert(hasShape(value, ['houseManageNo', 'noticeNo', 'edition', 'title', 'kind', 'regionCode', 'application',
    'moveIn', 'inventoryComplete', 'models', 'sourceIds', 'reasonCodes'], ['parentRegionCode', 'applicationSegments']));
  const { houseManageNo, noticeNo, edition, title, kind, regionCode, inventoryComplete } = value;
  indexAssert(matches(houseManageNo, noticeNumberPattern) && matches(noticeNo, noticeNumberPattern)
    && matches(edition, editionPattern) && (title === null || isPublicLabel(title, 200))
    && isChoice(noticeKinds, kind) && (regionCode === null || matches(regionCode, regionCodePattern))
    && typeof inventoryComplete === 'boolean');
  const parentRegionCode = Object.hasOwn(value, 'parentRegionCode') ? value.parentRegionCode : null;
  indexAssert(parentRegionCode === null || (regionCode !== null && matches(parentRegionCode, regionCodePattern)
    && parentRegionCode !== regionCode));
  const application = readRange(value.application, isDate);
  const moveIn = readRange(value.moveIn, isMonth);
  indexAssert((value.application === null || application) && (value.moveIn === null || moveIn));
  const applicationSegments = Object.hasOwn(value, 'applicationSegments')
    ? readApplicationSegments(value.applicationSegments, application) : undefined;
  const sources = readList(value.sourceIds, sourceIds.length, source => {
    indexAssert(isChoice(sourceIds, source));
    return source;
  });
  assertUnique(sources);
  const reasons = readList(value.reasonCodes, reasonCodes.length, code => {
    indexAssert(isChoice(reasonCodes, code));
    return code;
  });
  assertUnique(reasons);
  indexAssert(!applicationSegments || reasons.includes('application_split'));
  const readRef = (ref: unknown) => readEvidence(ref, houseManageNo, noticeNo);
  const models = readList(value.models, 100, model => readModel(model, readRef));
  assertUnique(models.map(model => model.modelNo));
  indexAssert(sources.some(source => isChoice(collectionSources, source))
    && (!sources.includes('applyhome_apt_model') || sources.includes('applyhome_apt'))
    && (!sources.includes('applyhome_remainder_model') || sources.includes('applyhome_remainder'))
    && (!models.length || sources.includes('applyhome_apt_model') || sources.includes('applyhome_remainder_model'))
    && (!inventoryComplete || (models.length > 0 && models.every(model => model.rooms.length > 0)))
    && (sources.includes('applyhome_notice_pdf')
      || models.every(model => !model.areaEvidence.length && model.rooms.every(room => !room.priceEvidence.length))));
  return { houseManageNo, noticeNo, edition, title, kind, regionCode, application, moveIn,
    inventoryComplete, models, sourceIds: sources, reasonCodes: reasons,
    ...(parentRegionCode !== null ? { parentRegionCode } : {}), ...(applicationSegments ? { applicationSegments } : {}) };
}

function readIndex(value: unknown): Index {
  indexAssert(hasShape(value, ['contractVersion', 'dataOrigin', 'observedAt', 'publicationWindow', 'coverage', 'notices'], ['regionCodes']));
  const { contractVersion, dataOrigin, observedAt, coverage } = value;
  const publicationWindow = readRange(value.publicationWindow, isDate);
  indexAssert(contractVersion === 'notice-search-index/v1' && isChoice(dataOrigins, dataOrigin)
    && matches(observedAt, timestampPattern) && isDate(observedAt.slice(0, 10)) && Number.isFinite(Date.parse(observedAt))
    && publicationWindow && hasShape(coverage, ['status', 'sources']));
  const { status } = coverage;
  indexAssert(isChoice(coverageStatuses, status));
  const sources = readList(coverage.sources, collectionSources.length, entry => {
    indexAssert(hasShape(entry, ['source', 'status']) && isChoice(collectionSources, entry.source)
      && isChoice(sourceStatuses, entry.status));
    return { source: entry.source, status: entry.status };
  });
  indexAssert(sources.length === collectionSources.length);
  assertUnique(sources.map(source => source.source));
  const expectedCoverage = sources.every(source => source.status === 'complete' || source.status === 'empty') ? 'complete'
    : sources.every(source => source.status === 'failed') ? 'unavailable' : 'partial';
  indexAssert(status === expectedCoverage);

  const catalogCodes = Object.hasOwn(value, 'regionCodes') ? readList(value.regionCodes, 1000, code => {
    indexAssert(matches(code, regionCodePattern));
    return code;
  }) : [];
  indexAssert((dataOrigin === 'synthetic' || catalogCodes.length > 0)
    && catalogCodes.every((code, i) => i === 0 || catalogCodes[i - 1] < code));
  const regionCodes = new Set(catalogCodes);
  const notices = readList(value.notices, 1000, readNotice);
  assertUnique(notices.map(notice => `${notice.houseManageNo}:${notice.noticeNo}`));
  if (regionCodes.size) {
    indexAssert(notices.every(({ regionCode, parentRegionCode }) => (regionCode === null || regionCodes.has(regionCode))
      && (parentRegionCode === undefined || regionCodes.has(parentRegionCode))));
  }
  for (const { source, status: sourceStatus } of sources) {
    const hasNotices = notices.some(notice => notice.sourceIds.includes(source));
    indexAssert(sourceStatus === 'partial' || hasNotices === (sourceStatus === 'complete'));
  }
  indexAssert(Buffer.byteLength(JSON.stringify(value)) <= maxIndexBytes);
  return { dataOrigin, observedAt, publicationWindow, regionCodes, coverage: { status, sources }, notices };
}

type ApplicationStatus = 'open' | 'upcoming' | 'closed' | 'unknown';
type ReviewRoom = Room & { reasonCodes: ReasonCode[] };
type ModelResult = Omit<Model, 'rooms'> & {
  supplyAreaPyeong: string | null; matchedRooms: Room[]; needsReviewRooms: ReviewRoom[];
};
type NoticeResult = Omit<Notice, 'models'> & {
  applicationStatus: ApplicationStatus; models: ModelResult[];
  counts: { matchedRooms: number; needsReviewRooms: number; modelsWithoutRooms: number };
  truncation: { matchedRoomsOmitted: number; needsReviewRoomsOmitted: number; modelsWithoutRoomsOmitted: number };
};

function applicationStatus({ application, applicationSegments }: Notice, asOf: string): ApplicationStatus {
  if (!application) return 'unknown';
  if (asOf < application.start) return 'upcoming';
  if (asOf > application.end) return 'closed';
  if (!applicationSegments || applicationSegments.some(({ start, end }) => start <= asOf && asOf <= end)) return 'open';
  return 'unknown';
}

function displayPyeong(areaM2: string | null): string | null {
  if (areaM2 === null) return null;
  const { units, scale } = decimal(areaM2);
  const divisor = scale * pyeongM2Numerator;
  // 정수 연산으로 표시용 소수 둘째 자리까지 반올림한다. 판정은 아래의 정확한 비율을 쓴다.
  const hundredths = (units * pyeongM2Denominator * 100n + divisor / 2n) / divisor;
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
}

function makeAreaFilter(range: AreaRange) {
  const min = decimal(range.min);
  const max = decimal(range.max);
  return (areaM2: string) => {
    const area = decimal(areaM2);
    const comparable = range.unit === 'm2' ? area :
      { units: area.units * pyeongM2Denominator, scale: area.scale * pyeongM2Numerator };
    return atMost(min, comparable) && atMost(comparable, max);
  };
}

type Filters = {
  regions: ReadonlySet<string>; budget: bigint; includesArea: ((m2: string) => boolean) | null;
  moveIn?: DateRange; includeClosed: boolean;
};

function assessNotice(notice: Notice, filters: Filters, asOf: string): NoticeResult | null {
  const { models, ...details } = notice;
  const { regionCode, parentRegionCode, kind, moveIn, inventoryComplete } = details;
  const status = applicationStatus(notice, asOf);
  const regionMismatch = regionCode !== null && !filters.regions.has(regionCode)
    && (parentRegionCode === undefined || !filters.regions.has(parentRegionCode));
  if (regionMismatch || kind === 'unsupported'
    || (status === 'closed' && !filters.includeClosed)
    || (filters.moveIn && moveIn && (moveIn.end < filters.moveIn.start || moveIn.start > filters.moveIn.end))) return null;

  const noticeReasons: ReasonCode[] = [];
  if (regionCode === null) noticeReasons.push('region_unverified');
  if (kind === 'unknown') noticeReasons.push('kind_unverified');
  if (status === 'unknown') noticeReasons.push(details.applicationSegments ? 'application_split' : 'application_dates_unverified');
  if (filters.moveIn && !moveIn) noticeReasons.push('move_in_unverified');
  const noticeHeld = noticeReasons.length > 0;
  if (!inventoryComplete) noticeReasons.push('inventory_incomplete');

  const reasons = new Set([...details.reasonCodes, ...noticeReasons]);
  const resultModels: ModelResult[] = [];
  const counts = { matchedRooms: 0, needsReviewRooms: 0, modelsWithoutRooms: 0 };
  const truncation = { matchedRoomsOmitted: 0, needsReviewRoomsOmitted: 0, modelsWithoutRoomsOmitted: 0 };
  for (const { rooms, ...model } of models) {
    const { supplyAreaM2 } = model;
    if (filters.includesArea && supplyAreaM2 !== null && !filters.includesArea(supplyAreaM2)) continue;
    const areaMissing = filters.includesArea !== null && supplyAreaM2 === null;
    const matchedRooms: Room[] = [];
    const needsReviewRooms: ReviewRoom[] = [];
    for (const room of rooms) {
      if (room.subtotalWon !== null && BigInt(room.subtotalWon) > filters.budget) continue;
      const reasonCodes: ReasonCode[] = [];
      if (areaMissing) reasonCodes.push('supply_area_unverified');
      if (room.subtotalWon === null) reasonCodes.push('price_unverified');
      if (!noticeHeld && reasonCodes.length === 0) {
        counts.matchedRooms += 1;
        if (counts.matchedRooms <= maxRowsPerDetailGroup) matchedRooms.push(room);
        else truncation.matchedRoomsOmitted += 1;
      } else {
        for (const code of reasonCodes) reasons.add(code);
        counts.needsReviewRooms += 1;
        if (counts.needsReviewRooms <= maxRowsPerDetailGroup) needsReviewRooms.push({ ...room, reasonCodes });
        else truncation.needsReviewRoomsOmitted += 1;
      }
    }
    if (!rooms.length) {
      if (areaMissing) reasons.add('supply_area_unverified');
      counts.modelsWithoutRooms += 1;
      if (counts.modelsWithoutRooms > maxRowsPerDetailGroup) {
        truncation.modelsWithoutRoomsOmitted += 1;
        continue;
      }
    } else if (!matchedRooms.length && !needsReviewRooms.length) {
      continue;
    }
    resultModels.push({ ...model, supplyAreaPyeong: displayPyeong(supplyAreaM2), matchedRooms, needsReviewRooms });
  }
  if (inventoryComplete && counts.matchedRooms === 0 && counts.needsReviewRooms === 0) return null;
  return { ...details, applicationStatus: status, reasonCodes: [...reasons], models: resultModels, counts, truncation };
}

const statusRank: Record<ApplicationStatus, number> = { open: 0, upcoming: 1, closed: 2, unknown: 3 };

function compareText(left: string, right: string) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function compareNotices(left: NoticeResult, right: NoticeResult): number {
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
  // 종료·미확인 배치와 동률은 전송 순서를 고정하기 위한 기술 순서로만 사용한다(D-04).
  return compareText(left.houseManageNo, right.houseManageNo) || compareText(left.noticeNo, right.noticeNo);
}

function limitProjection(results: NoticeResult[]): NoticeResult[] {
  results.sort(compareNotices);
  const shown: NoticeResult[] = [];
  let bytes = 2;
  for (const result of results.slice(0, maxNoticesPerList)) {
    bytes += Buffer.byteLength(JSON.stringify(result)) + 1;
    if (bytes > maxBytesPerList) break;
    shown.push(result);
  }
  return shown;
}

export function evaluateNoticeSearch(index: unknown, conditions: NoticeSearchConditions, asOf: string) {
  indexAssert(isDate(asOf));
  const { dataOrigin, observedAt, publicationWindow, regionCodes, coverage, notices } = readIndex(index);
  const appliedConditions = parseNoticeSearchConditions(conditions);
  indexAssert(appliedConditions);
  const unverifiedRegionCodes = appliedConditions.regionCodes.filter(code => !regionCodes.has(code));
  // 기존 합성 자료는 후보 판정을 재생하되 검증된 지역 범위의 0건 결론을 내릴 수 없다.
  const selectedRegions = regionCodes.size ? appliedConditions.regionCodes.filter(code => regionCodes.has(code))
    : appliedConditions.regionCodes;
  const filters: Filters = {
    regions: new Set(selectedRegions), budget: BigInt(appliedConditions.budgetMaxWon),
    includesArea: appliedConditions.supplyArea ? makeAreaFilter(appliedConditions.supplyArea) : null,
    moveIn: appliedConditions.moveIn, includeClosed: appliedConditions.includeClosed,
  };
  const allMatched: NoticeResult[] = [];
  const allNeedsReview: NoticeResult[] = [];
  const assessedNotices = selectedRegions.length ? notices : [];
  for (const notice of assessedNotices) {
    const assessment = assessNotice(notice, filters, asOf);
    if (!assessment) continue;
    const group = assessment.counts.matchedRooms > 0 ? allMatched : allNeedsReview;
    group.push(assessment);
  }
  const counts = { matched: allMatched.length, needsReview: allNeedsReview.length,
    excluded: assessedNotices.length - allMatched.length - allNeedsReview.length };
  const matched = limitProjection(allMatched);
  const needsReview = limitProjection(allNeedsReview);
  const matchedOmitted = counts.matched - matched.length;
  const needsReviewOmitted = counts.needsReview - needsReview.length;
  const detailTruncatedNotices = [...matched, ...needsReview].filter(notice => Object.values(notice.truncation).some(Boolean)).length;
  const truncation = { truncated: matchedOmitted + needsReviewOmitted + detailTruncatedNotices > 0,
    matchedOmitted, needsReviewOmitted, detailTruncatedNotices };

  const scopeIssues: string[] = [];
  if (coverage.status !== 'complete') scopeIssues.push('coverage_incomplete');
  if (asOf < publicationWindow.start || asOf > publicationWindow.end) scopeIssues.push('as_of_outside_publication_window');
  const observedKstDate = koreaDate.format(new Date(observedAt));
  if (asOf !== observedKstDate) scopeIssues.push('observation_date_mismatch');
  if (unverifiedRegionCodes.length) scopeIssues.push('region_selection_unverified');
  const zeroStatus = counts.matched ? 'not_zero'
    : counts.needsReview || scopeIssues.length || truncation.truncated ? 'indeterminate' : 'confirmed_zero';
  return {
    contractVersion: 'notice-search/v1' as const, dataOrigin, asOf, observedAt, publicationWindow, coverage, appliedConditions,
    priceBasis: { subtotal: 'sale_price_plus_required_options', taxes: 'unverified', financingCosts: 'unverified' } as const,
    areaConversion: { pyeongToM2: { numerator: Number(pyeongM2Numerator), denominator: Number(pyeongM2Denominator) },
      displayPyeongDecimals: 2 },
    scopeIssues, unverifiedRegionCodes, matched, needsReview, counts, zeroStatus, truncation,
  };
}
