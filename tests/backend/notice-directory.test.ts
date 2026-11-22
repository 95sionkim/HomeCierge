import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../../src/server/http-input.js';
import { evaluateNoticeDirectory, parseNoticeDirectoryQuery } from '../../src/server/notice-directory.js';
import type { NoticeDirectoryOptions } from '../../src/server/notice-directory.js';

// 모든 식별자, 일정, 지역명, 가격과 원문 참조는 합성 자료다.
const asOf = '2026-07-01';
const observedAt = '2026-06-30T16:15:21.123456Z';
const publicationWindow = { start: '2026-06-01', end: '2026-07-01' };
const catalogRegions = ['11111', '22222', '33333', '44440', '44441'];
const digest = `sha256:${'a'.repeat(64)}`;
const defaults: NoticeDirectoryOptions = { includeClosed: false, limit: 20, cursor: null };

type Range = { start: string; end: string };
type FixtureRef = { document: string; version: string; page: number };
type FixtureModel = {
  modelNo: string; houseType: string | null; supplyAreaM2: string | null; areaEvidence: FixtureRef[];
  rooms: { room: string; subtotalWon: string | null; priceEvidence: FixtureRef[] }[];
};
type FixtureNotice = {
  houseManageNo: string; noticeNo: string; edition: string; title: string | null; kind: string;
  regionCode: string | null; parentRegionCode?: string; application: Range | null; applicationSegments?: Range[];
  moveIn: { start: string; end: string } | null; inventoryComplete: boolean; models: FixtureModel[];
  sourceIds: string[]; reasonCodes: string[];
};

// 지난달 게시한 합성 공고가 기본이다. 모집공고일은 판본 값으로만 남는다.
function notice(sequence: number, changes: Partial<FixtureNotice> = {}): FixtureNotice {
  const number = String(9_900_000_000 + sequence);
  const document = `applyhome:${number}:${number}:8:1`;
  return {
    houseManageNo: number, noticeNo: number, edition: '2026-06-02', title: `합성 공고 ${sequence}`, kind: 'new_sale',
    regionCode: '11111', application: { start: '2026-06-28', end: '2026-07-03' }, moveIn: { start: '2028-01', end: '2028-03' },
    inventoryComplete: true,
    models: [{ modelNo: '01', houseType: '084A', supplyAreaM2: '112.400', areaEvidence: [{ document, version: digest, page: 4 }],
      rooms: [{ room: '101동 101호', subtotalWon: '987654321', priceEvidence: [{ document, version: digest, page: 7 }] }] }],
    sourceIds: ['applyhome_apt', 'applyhome_apt_model', 'applyhome_notice_pdf'], reasonCodes: [], ...changes,
  };
}

// PDF·금액을 제거한 목록 전용 projection도 같은 v1 색인 검사를 통과해야 한다.
function listOnly(sequence: number, changes: Partial<FixtureNotice> = {}): FixtureNotice {
  return notice(sequence, { inventoryComplete: false, reasonCodes: ['inventory_incomplete'],
    models: [{ modelNo: '01', houseType: '084A', supplyAreaM2: null, areaEvidence: [], rooms: [] }],
    sourceIds: ['applyhome_apt', 'applyhome_apt_model'], ...changes });
}

function index(notices: FixtureNotice[] = [], changes: Record<string, unknown> = {}) {
  const status = (source: string) => notices.some(item => item.sourceIds.includes(source)) ? 'complete' : 'empty';
  return {
    contractVersion: 'notice-search-index/v1', dataOrigin: 'synthetic', observedAt, publicationWindow,
    regionCodes: catalogRegions,
    coverage: { status: 'complete', sources: [{ source: 'applyhome_apt', status: status('applyhome_apt') },
      { source: 'applyhome_remainder', status: status('applyhome_remainder') }] },
    notices, ...changes,
  };
}

function list(value: unknown, options: Partial<NoticeDirectoryOptions> = {}, date = asOf) {
  return evaluateNoticeDirectory(value, { ...defaults, ...options }, date);
}

function numbers(result: ReturnType<typeof list>) {
  return result.notices.map(item => item.noticeNo);
}

function apiError(code: string, status: number) {
  return (error: unknown) => error instanceof ApiError && error.code === code && error.status === status;
}

function editCursor(cursor: string, change: Record<string, unknown>) {
  const state = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Buffer.from(JSON.stringify({ ...state, ...change }), 'utf8').toString('base64url');
}

test('reads only the supported query keys once each with explicit defaults', () => {
  assert.deepEqual(parseNoticeDirectoryQuery(new URLSearchParams()), defaults);
  assert.deepEqual(parseNoticeDirectoryQuery(new URLSearchParams('includeClosed=true&limit=50&cursor=eyJ2IjoxfQ')),
    { includeClosed: true, limit: 50, cursor: 'eyJ2IjoxfQ' });
  assert.deepEqual(parseNoticeDirectoryQuery(new URLSearchParams('limit=1&includeClosed=false')),
    { includeClosed: false, limit: 1, cursor: null });
  const invalid = ['includeClosed=true&includeClosed=true', 'limit=20&limit=20', 'cursor=a&cursor=a', 'region=11111',
    'budgetMaxWon=1', 'IncludeClosed=true', 'includeClosed=TRUE', 'includeClosed=1', 'includeClosed=', 'includeClosed',
    'limit=0', 'limit=51', 'limit=01', 'limit=1.0', 'limit=%2B1', 'limit=+1', 'limit=-1', 'limit=', 'limit=1e1',
    'cursor=', 'cursor=a+b', 'cursor=ab%3D', 'cursor=a.b', `cursor=${'a'.repeat(513)}`];
  for (const query of invalid) assert.equal(parseNoticeDirectoryQuery(new URLSearchParams(query)), null, query);
  assert.equal(parseNoticeDirectoryQuery({ limit: '1' } as unknown as URLSearchParams), null);
});

test('lists every supported notice without budget or region and keeps last month notices that accept today', () => {
  const lastMonth = notice(1, { edition: '2026-06-02', regionCode: '33333', kind: 'remaining',
    sourceIds: ['applyhome_remainder', 'applyhome_remainder_model', 'applyhome_notice_pdf'] });
  const elsewhere = notice(2, { regionCode: '22222', kind: 'resupply', application: { start: '2026-07-01', end: '2026-07-02' } });
  const result = list(index([lastMonth, elsewhere]));
  assert.equal(result.contractVersion, 'notice-directory/v1');
  assert.deepEqual(numbers(result), [elsewhere.noticeNo, lastMonth.noticeNo]);
  assert.deepEqual(result.notices.map(item => item.applicationStatus), ['open', 'open']);
  assert.deepEqual(result.counts, { listed: 2, open: 2, upcoming: 0, closed: 0, unknown: 0, kindUnverified: 0,
    excludedClosed: 0, excludedUnsupported: 0 });
  assert.deepEqual(result.zeroStatus, { open: 'not_zero', upcoming: 'confirmed_zero' });
  assert.deepEqual(result.notices[1].sourceIds, ['applyhome_remainder', 'applyhome_remainder_model']);
  assert.deepEqual(result.officialPortal, { name: '청약홈', url: 'https://www.applyhome.co.kr/' });
  assert.deepEqual(result.appliedQuery, { includeClosed: false, limit: 20 });
  assert.equal(result.observedKstDate, asOf);
  assert.deepEqual(result.scopeIssues, []);
});

test('uses KST calendar boundaries for opening, closing, upcoming and closed notices', () => {
  const notices = [
    notice(1, { application: { start: asOf, end: '2026-07-09' } }),
    notice(2, { application: { start: '2026-06-20', end: asOf } }),
    notice(3, { application: { start: asOf, end: asOf } }),
    notice(4, { application: { start: '2026-07-02', end: '2026-07-03' } }),
    notice(5, { application: { start: '2026-06-20', end: '2026-06-30' } }),
    notice(6, { kind: 'unsupported' }),
  ];
  const result = list(index(notices));
  assert.deepEqual(numbers(result), [2, 3, 1, 4].map(n => notices[n - 1].noticeNo));
  assert.deepEqual(result.notices.map(item => item.applicationStatus), ['open', 'open', 'open', 'upcoming']);
  assert.equal(result.counts.excludedClosed, 1);
  assert.equal(result.counts.excludedUnsupported, 1);
  const withClosed = list(index(notices), { includeClosed: true });
  assert.deepEqual(numbers(withClosed), [2, 3, 1, 4, 5].map(n => notices[n - 1].noticeNo));
  assert.equal(withClosed.notices.at(-1)?.applicationStatus, 'closed');
  assert.deepEqual([withClosed.counts.closed, withClosed.counts.excludedClosed, withClosed.counts.listed], [1, 0, 5]);
  // 날짜가 바뀌면 같은 관측에서도 판정이 바뀐다. 관측일 불일치는 범위 사유로 남긴다.
  const nextDay = list(index(notices), {}, '2026-07-02');
  assert.deepEqual(nextDay.notices.map(item => [item.noticeNo, item.applicationStatus]),
    [[notices[3].noticeNo, 'open'], [notices[0].noticeNo, 'open']]);
  assert.deepEqual(nextDay.scopeIssues, ['as_of_outside_publication_window', 'observation_date_mismatch']);
});

test('does not mark days between verified split periods or unverified dates as accepting', () => {
  const split = notice(1, { application: { start: '2026-06-28', end: '2026-07-05' },
    applicationSegments: [{ start: '2026-06-29', end: '2026-06-30' }, { start: '2026-07-03', end: '2026-07-04' }],
    reasonCodes: ['application_split'] });
  const noVerifiedDay = notice(2, { applicationSegments: [], reasonCodes: ['application_split', 'application_unverified'] });
  const noDates = notice(3, { application: null, reasonCodes: ['application_unverified'] });
  const fixture = index([split, noVerifiedDay, noDates]);
  for (const [date, status] of [['2026-06-27', 'upcoming'], ['2026-06-29', 'open'], ['2026-06-30', 'open'],
    ['2026-07-01', 'unknown'], ['2026-07-02', 'unknown'], ['2026-07-03', 'open'], ['2026-07-04', 'open'],
    ['2026-07-05', 'unknown']]) {
    const found = list(fixture, {}, date).notices.find(item => item.noticeNo === split.noticeNo);
    assert.equal(found?.applicationStatus, status, date);
    assert.deepEqual(found?.applicationSegments, split.applicationSegments);
    assert.equal(found?.checks.schedule, status === 'unknown' ? 'unverified' : 'verified');
  }
  const result = list(fixture);
  assert.deepEqual(numbers(result), [split, noVerifiedDay, noDates].map(item => item.noticeNo));
  assert.deepEqual(result.notices.map(item => item.applicationStatus), ['unknown', 'unknown', 'unknown']);
  assert.ok(result.notices[0].reasonCodes.includes('application_split'));
  assert.deepEqual(result.notices[1].applicationSegments, []);
  assert.deepEqual(result.notices[2].reasonCodes, ['application_unverified', 'application_dates_unverified']);
  assert.equal(result.notices[2].applicationSegments, null);
  assert.deepEqual(result.zeroStatus, { open: 'indeterminate', upcoming: 'indeterminate' });
  assert.equal(result.counts.unknown, 3);
});

test('orders accepting notices by closing date and upcoming notices by opening date with stable ties', () => {
  const notices = [
    notice(7, { application: { start: '2026-07-04', end: '2026-07-06' } }),
    notice(6, { application: { start: '2026-06-30', end: '2026-07-02' } }),
    notice(5, { application: { start: '2026-06-01', end: '2026-07-02' } }),
    notice(4, { application: { start: '2026-07-02', end: '2026-07-09' } }),
    notice(3, { application: { start: '2026-07-02', end: '2026-07-03' } }),
    notice(2, { application: null }),
    notice(1, { application: { start: '2026-06-01', end: '2026-06-02' } }),
    // 같은 주택관리번호의 다른 공고번호는 공고번호로 순서를 고정한다.
    { ...listOnly(5, { application: { start: '2026-06-20', end: '2026-07-02' } }), noticeNo: '9900000099' },
  ];
  const expected = [notices[2], notices[7], notices[1], notices[4], notices[3], notices[0], notices[6], notices[5]]
    .map(item => item.noticeNo);
  assert.deepEqual(numbers(list(index(notices), { includeClosed: true })), expected);
  assert.deepEqual(numbers(list(index([...notices].reverse()), { includeClosed: true })), expected);
});

test('scopes a zero to complete feeds, the publication window and the KST observation date', () => {
  const empty = list(index());
  assert.deepEqual(empty.counts.listed, 0);
  assert.deepEqual(empty.notices, []);
  assert.deepEqual(empty.zeroStatus, { open: 'confirmed_zero', upcoming: 'confirmed_zero' });
  assert.deepEqual(empty.page, { offset: 0, returned: 0, nextCursor: null });
  assert.deepEqual(empty.coverage, index().coverage);
  assert.deepEqual(empty.publicationWindow, publicationWindow);

  const closedOnly = list(index([notice(1, { application: { start: '2026-06-01', end: '2026-06-30' } })]));
  assert.deepEqual(closedOnly.zeroStatus, { open: 'confirmed_zero', upcoming: 'confirmed_zero' });
  assert.equal(closedOnly.counts.excludedClosed, 1);
  const upcomingOnly = list(index([notice(1, { application: { start: '2026-07-02', end: '2026-07-03' } })]));
  assert.deepEqual(upcomingOnly.zeroStatus, { open: 'confirmed_zero', upcoming: 'not_zero' });

  const sources = index().coverage.sources;
  const partial = { status: 'partial', sources: [sources[0], { source: 'applyhome_remainder', status: 'failed' }] };
  const unavailable = { status: 'unavailable', sources: sources.map(source => ({ ...source, status: 'failed' })) };
  for (const [changes, date, issue] of [
    [{ coverage: partial }, asOf, 'coverage_incomplete'],
    [{ coverage: unavailable }, asOf, 'coverage_incomplete'],
    [{ observedAt: '2026-06-30T14:59:59Z' }, asOf, 'observation_date_mismatch'],
    [{ publicationWindow: { start: '2026-06-01', end: '2026-06-29' }, observedAt: '2026-06-29T15:00:00Z' },
      '2026-06-30', 'as_of_outside_publication_window'],
  ] as const) {
    const result = list(index([], changes), {}, date);
    assert.deepEqual(result.scopeIssues, [issue]);
    assert.deepEqual(result.zeroStatus, { open: 'indeterminate', upcoming: 'indeterminate' });
  }
  const stale = list(index([], { observedAt: '2026-06-28T03:00:00+09:00' }));
  assert.equal(stale.observedKstDate, '2026-06-28');
  // 알려진 접수 중 공고는 범위가 불완전해도 0건이 아니다.
  const partialOpen = list(index([notice(1)], { coverage: { status: 'partial', sources: [{ source: 'applyhome_apt',
    status: 'partial' }, { source: 'applyhome_remainder', status: 'failed' }] } }));
  assert.deepEqual(partialOpen.zeroStatus, { open: 'not_zero', upcoming: 'indeterminate' });
});

test('treats an unverified type, even with a conflicting value, as unknown for zero claims and selection', () => {
  const unknownKind = notice(1, { kind: 'unknown', reasonCodes: ['kind_unverified'] });
  const conflicted = notice(2, { reasonCodes: ['notice_kind_unverified'] });
  const unsupportedReason = notice(3, { kind: 'resupply', reasonCodes: ['notice_kind_unsupported'] });
  const result = list(index([unknownKind, conflicted, unsupportedReason]));
  assert.equal(result.counts.listed, 3);
  assert.equal(result.counts.kindUnverified, 3);
  assert.deepEqual(result.notices.map(item => item.checks.kind), ['unverified', 'unverified', 'unverified']);
  assert.deepEqual(result.notices.map(item => item.kind), ['unknown', 'new_sale', 'resupply']);
  for (const item of result.notices) {
    assert.deepEqual(item.models[0].selectionBlockers, ['kind_unverified']);
    assert.equal(item.models[0].analysisInput, null);
  }
  assert.deepEqual(result.zeroStatus, { open: 'indeterminate', upcoming: 'confirmed_zero' });
  assert.deepEqual(list(index([unknownKind, notice(4)])).zeroStatus.open, 'not_zero');
});

test('pages the full sorted result with stable cursors for the same observation and query', () => {
  const notices = Array.from({ length: 9 }, (_, i) => notice(i + 1, {
    application: i < 3 ? { start: '2026-06-28', end: '2026-07-0' + (3 + (i % 2)) }
      : i < 5 ? { start: '2026-07-02', end: '2026-07-09' } : i < 7 ? null : { start: '2026-06-01', end: '2026-06-02' },
  }));
  const fixture = index(notices);
  const whole = list(fixture, { includeClosed: true, limit: 50 });
  assert.equal(whole.page.nextCursor, null);
  const seen: string[] = [];
  let cursor: string | null = null;
  const pages = [];
  do {
    const page = list(fixture, { includeClosed: true, limit: 4, cursor });
    assert.deepEqual(page.counts, whole.counts);
    assert.deepEqual(page.zeroStatus, whole.zeroStatus);
    assert.equal(page.page.offset, seen.length);
    assert.deepEqual(list(fixture, { includeClosed: true, limit: 4, cursor }), page);
    seen.push(...numbers(page));
    pages.push(page.page.returned);
    cursor = page.page.nextCursor;
  } while (cursor);
  assert.deepEqual(pages, [4, 4, 1]);
  assert.deepEqual(seen, numbers(whole));
  // 같은 커서로 다른 크기의 다음 페이지를 읽을 수 있다.
  const first = list(fixture, { includeClosed: true, limit: 4 });
  const rest = list(fixture, { includeClosed: true, limit: 50, cursor: first.page.nextCursor });
  assert.deepEqual([...numbers(first), ...numbers(rest)], numbers(whole));
  assert.equal(rest.page.nextCursor, null);
});

test('separates a corrupted cursor (400) from a republished index or a new KST date (409)', () => {
  const notices = Array.from({ length: 5 }, (_, i) => notice(i + 1));
  const fixture = index(notices);
  const cursor = list(fixture, { limit: 2 }).page.nextCursor!;
  assert.ok(cursor);
  assert.throws(() => list(index(notices, { observedAt: '2026-06-30T16:15:22Z' }), { limit: 2, cursor }),
    apiError('directory_page_changed', 409));
  assert.throws(() => list(fixture, { limit: 2, cursor }, '2026-07-02'), apiError('directory_page_changed', 409));
  const corrupted = ['abc', 'eyJ2IjoxfQ', editCursor(cursor, { n: 5 }), editCursor(cursor, { n: 0 }),
    editCursor(cursor, { n: 1.5 }), editCursor(cursor, { k: `${notices[4].houseManageNo}:${notices[4].noticeNo}` }),
    editCursor(cursor, { v: 2 }), editCursor(cursor, { extra: true }), editCursor(cursor, { o: 'yesterday' }),
    editCursor(cursor, { c: 'false' }), Buffer.from('not json').toString('base64url'), `${cursor.slice(0, -1)}_`];
  for (const value of corrupted) {
    assert.throws(() => list(fixture, { limit: 2, cursor: value }), apiError('invalid_directory_input', 400), value);
  }
  // 종료 포함 여부를 바꾼 목록에는 이전 위치를 적용하지 않는다.
  assert.throws(() => list(fixture, { includeClosed: true, limit: 2, cursor }), apiError('invalid_directory_input', 400));
  // 손상 커서는 관측 변경보다 먼저 입력 오류로 판정한다.
  assert.throws(() => list(index(notices, { observedAt: '2026-06-30T16:15:22Z' }), { cursor: 'abc' }),
    apiError('invalid_directory_input', 400));
  for (const options of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { includeClosed: 'true' }, { cursor: '' },
    { cursor: undefined }]) {
    assert.throws(() => evaluateNoticeDirectory(fixture, { ...defaults, ...options } as NoticeDirectoryOptions, asOf),
      apiError('invalid_directory_input', 400), JSON.stringify(options));
  }
  assert.throws(() => evaluateNoticeDirectory(fixture, { ...defaults, region: '11111' } as NoticeDirectoryOptions, asOf),
    apiError('invalid_directory_input', 400));
});

test('bounds each page by bytes and continues the remaining notices through the cursor', () => {
  const notices = Array.from({ length: 12 }, (_, i) => listOnly(i + 1, { title: '합'.repeat(200),
    applicationSegments: [{ start: '2026-06-28', end: '2026-06-28' }], reasonCodes: ['application_split', 'inventory_incomplete'],
    models: Array.from({ length: 100 }, (_, m) => ({ modelNo: String(m + 1).padStart(20, '0'), houseType: '형'.repeat(64),
      supplyAreaM2: null, areaEvidence: [], rooms: [] })) }));
  const fixture = index(notices, { observedAt: '2026-06-27T16:00:00Z', publicationWindow: { start: '2026-06-01', end: '2026-06-28' } });
  const date = '2026-06-28';
  const first = list(fixture, { limit: 50 }, date);
  assert.ok(first.page.returned > 0 && first.page.returned < notices.length);
  assert.ok(Buffer.byteLength(JSON.stringify(first.notices)) <= 256 * 1024);
  assert.equal(first.counts.listed, notices.length);
  const seen = numbers(first);
  let cursor = first.page.nextCursor;
  while (cursor) {
    const page = list(fixture, { limit: 50, cursor }, date);
    assert.ok(page.page.returned > 0);
    seen.push(...numbers(page));
    cursor = page.page.nextCursor;
  }
  assert.deepEqual(seen, notices.map(item => item.noticeNo));
});

test('publishes only notice identity, schedule, location and house type selection fields', () => {
  const result = list(index([notice(1, { parentRegionCode: '44440', regionCode: '44441',
    reasonCodes: ['inventory_incomplete', 'price_unverified', 'move_in_unverified', 'document_budget_exhausted',
      'official_document_unverified', 'source_unverified', 'source_restricted'], inventoryComplete: false })]));
  const [item] = result.notices;
  assert.deepEqual(Object.keys(result), ['contractVersion', 'dataOrigin', 'asOf', 'observedAt', 'observedKstDate',
    'publicationWindow', 'coverage', 'officialPortal', 'appliedQuery', 'scopeIssues', 'counts', 'zeroStatus', 'notices', 'page']);
  assert.deepEqual(Object.keys(item), ['houseManageNo', 'noticeNo', 'edition', 'title', 'kind', 'sourceIds', 'regionCode',
    'regionName', 'parentRegionCode', 'application', 'applicationSegments', 'applicationStatus', 'checks', 'reasonCodes', 'models']);
  assert.deepEqual(Object.keys(item.models[0]), ['modelNo', 'houseType', 'selectionBlockers', 'analysisInput']);
  assert.deepEqual(item.reasonCodes, ['source_restricted']);
  assert.deepEqual(item.sourceIds, ['applyhome_apt', 'applyhome_apt_model']);
  assert.equal(item.parentRegionCode, '44440');
  const text = JSON.stringify(result);
  for (const hidden of ['rooms', 'subtotalWon', 'priceEvidence', 'areaEvidence', 'supplyArea', 'moveIn', 'inventory',
    'applyhome_notice_pdf', 'applyhome:', digest, '987654321', '101동', '2028-01']) {
    assert.ok(!text.includes(hidden), hidden);
  }
});

test('only offers selection for a real publication date inside the published window', () => {
  for (const edition of ['edition-1', '2026-06-31', '2026-05-31', '2026-07-02']) {
    const model = list(index([notice(1, { edition })])).notices[0].models[0];
    assert.deepEqual(model.selectionBlockers, ['edition_unverified'], edition);
    assert.equal(model.analysisInput, null);
  }
  for (const edition of [publicationWindow.start, publicationWindow.end]) {
    assert.equal(list(index([notice(1, { edition })])).notices[0].models[0].analysisInput?.edition, edition);
  }
});

test('builds the analysis input for each model only when the capture identity is verified', () => {
  const apt = notice(1);
  const remainder = listOnly(2, { kind: 'unranked', sourceIds: ['applyhome_remainder', 'applyhome_remainder_model'] });
  const bothFeeds = listOnly(3, { sourceIds: ['applyhome_apt', 'applyhome_remainder', 'applyhome_apt_model'] });
  const unnamed = notice(4);
  unnamed.models.push({ ...unnamed.models[0], modelNo: '02', houseType: null });
  const noRegion = notice(5, { regionCode: null, reasonCodes: ['region_unverified'] });
  const regionConflict = notice(6, { reasonCodes: ['region_unverified'] });
  const noEdition = notice(7, { edition: 'public', application: null, reasonCodes: ['publication_date_unverified'] });
  const conflict = notice(8, { reasonCodes: ['notice_metadata_conflict'] });
  const restricted = listOnly(9, { models: [], sourceIds: ['applyhome_apt'], reasonCodes: ['inventory_incomplete'] });
  const partialModels = listOnly(10, { reasonCodes: ['detail_page_limit_reached', 'inventory_incomplete'] });
  const result = list(index([apt, remainder, bothFeeds, unnamed, noRegion, regionConflict, noEdition, conflict, restricted,
    partialModels], { regionNames: { 11111: '합성시 가구' } }), { includeClosed: true, limit: 50 });
  const byNo = new Map(result.notices.map(item => [item.noticeNo, item]));
  const selection = (item: typeof apt, modelNo = '01') => byNo.get(item.noticeNo)!.models.find(model => model.modelNo === modelNo)!;

  assert.deepEqual(selection(apt).analysisInput, { kind: 'notice', noticeSource: 'applyhome_apt',
    houseManageNo: apt.houseManageNo, noticeNo: apt.noticeNo, edition: '2026-06-02', modelNo: '01' });
  assert.deepEqual(selection(remainder).analysisInput?.noticeSource, 'applyhome_remainder');
  assert.deepEqual(selection(apt).selectionBlockers, []);
  for (const [item, blockers, modelNo] of [
    [bothFeeds, ['notice_source_ambiguous'], '01'], [unnamed, ['house_type_unverified'], '02'],
    [noRegion, ['region_unverified'], '01'], [regionConflict, ['region_unverified'], '01'],
    [noEdition, ['edition_unverified'], '01'], [conflict, ['notice_metadata_conflict'], '01'],
  ] as const) {
    assert.deepEqual(selection(item, modelNo).selectionBlockers, blockers, item.noticeNo);
    assert.equal(selection(item, modelNo).analysisInput, null);
  }
  assert.deepEqual(selection(unnamed).selectionBlockers, []);
  assert.equal(byNo.get(regionConflict.noticeNo)!.checks.region, 'unverified');
  assert.equal(byNo.get(regionConflict.noticeNo)!.regionName, null);
  assert.equal(byNo.get(apt.noticeNo)!.regionName, '합성시 가구');
  assert.equal(byNo.get(noRegion.noticeNo)!.regionName, null);
  assert.deepEqual(byNo.get(restricted.noticeNo)!.models, []);
  assert.equal(byNo.get(restricted.noticeNo)!.checks.models, 'unavailable');
  assert.ok(byNo.get(restricted.noticeNo)!.reasonCodes.includes('model_unverified'));
  assert.equal(byNo.get(partialModels.noticeNo)!.checks.models, 'incomplete');
  assert.equal(byNo.get(apt.noticeNo)!.checks.models, 'listed');

  const { regionCodes: _, ...legacy } = index([apt]);
  const noCatalog = list(legacy).notices[0];
  assert.equal(noCatalog.checks.region, 'unverified');
  assert.deepEqual(noCatalog.models[0].selectionBlockers, ['region_unverified']);
});

test('reads optional region names only for codes in the published catalog', () => {
  for (const regionNames of [undefined, {}]) {
    const result = list(index([notice(1)], regionNames === undefined ? {} : { regionNames }));
    assert.equal(result.notices[0].regionName, null);
  }
  const named = list(index([notice(1, { regionCode: '22222' })], { regionNames: { 11111: '합성시 가구', 22222: '합성도 나군' } }));
  assert.equal(named.notices[0].regionName, '합성도 나군');
  assert.ok(!('regionNames' in named));
  const invalid = [null, [], { 99999: '합성시 없는구' }, { 1111: '합성시' }, { 11111: '' }, { 11111: ' 합성시' },
    { 11111: '합'.repeat(121) }, { 11111: 'https://synthetic.invalid' }, { 11111: 11111 }, Object.create({ 11111: '합성시' })];
  for (const regionNames of invalid) {
    assert.throws(() => list(index([notice(1)], { regionNames })), /^Error: invalid_notice_search_index$/,
      JSON.stringify(regionNames));
  }
  const getter = index([notice(1)]);
  Object.defineProperty(getter, 'regionNames', { enumerable: true, get: () => ({}) });
  assert.throws(() => list(getter), /^Error: invalid_notice_search_index$/);
  const getterRest = { ...index([notice(1)]), regionNames: {} };
  Object.defineProperty(getterRest, 'notices', { enumerable: true, get: () => [] });
  assert.throws(() => list(getterRest), /^Error: invalid_notice_search_index$/);
});

test('rejects malformed indexes, extra index fields and a non-date reference day with a generic error', () => {
  const valid = index([notice(1)]);
  for (const value of [null, [], { ...valid, contractVersion: 'notice-directory/v1' }, { ...valid, ownerId: 'SYNTHETIC_PRIVATE' },
    { ...valid, notices: [{ ...notice(1), models: [{ ...notice(1).models[0], houseType: '084A ' }] }] },
    { ...valid, coverage: { status: 'complete', sources: [valid.coverage.sources[0]] } }]) {
    assert.throws(() => list(value), /^Error: invalid_notice_search_index$/);
  }
  for (const date of ['2026-07-01T00:00:00+09:00', '2026-02-29', '']) {
    assert.throws(() => list(valid, {}, date), /^Error: invalid_notice_search_index$/);
  }
});
