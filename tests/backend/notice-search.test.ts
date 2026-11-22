import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateNoticeSearch, parseNoticeSearchConditions } from '../../src/server/notice-search.js';

// 모든 식별자, 일정, 가격과 원문 참조는 합성 자료다.
const asOf = '2026-07-01';
const observedAt = '2026-06-30T16:15:21.123456Z';
const publicationWindow = { start: '2026-06-01', end: '2026-07-01' };
const minimal = { regionCodes: ['11111', '22222'], budgetMaxWon: '900000000' };
const catalogRegions = ['11111', '22222', '33333', '44440', '44441', '44442'];
const application = { start: '2026-06-28', end: asOf };
const digest = `sha256:${'a'.repeat(64)}`;

type FixtureRef = { document: string; version: string; page: number };
type FixtureRoom = { room: string; subtotalWon: string | null; priceEvidence: FixtureRef[] };
type FixtureModel = {
  modelNo: string; houseType: string | null; supplyAreaM2: string | null;
  areaEvidence: FixtureRef[]; rooms: FixtureRoom[];
};
type FixtureNotice = {
  houseManageNo: string; noticeNo: string; edition: string; title: string | null; kind: string;
  regionCode: string | null; parentRegionCode?: string | null; application: typeof application | null;
  applicationSegments?: { start: string; end: string }[]; moveIn: { start: string; end: string } | null;
  inventoryComplete: boolean; models: FixtureModel[]; sourceIds: string[]; reasonCodes: string[];
};

function candidate(sequence: number, changes: Partial<FixtureNotice> = {}): FixtureNotice {
  const number = String(9_900_000_000 + sequence);
  const document = `applyhome:${number}:${number}:8:1`;
  return {
    houseManageNo: number, noticeNo: number, edition: 'synthetic-edition-1', title: '합성 공고',
    kind: 'new_sale', regionCode: '11111', application, moveIn: null, inventoryComplete: true,
    models: [{ modelNo: '01', houseType: '084A', supplyAreaM2: '112.400',
      areaEvidence: [{ document, version: digest, page: 4 }],
      rooms: [{ room: '101동 101호', subtotalWon: '900000000', priceEvidence: [{ document, version: digest, page: 7 }] }],
    }],
    sourceIds: ['applyhome_apt', 'applyhome_apt_model', 'applyhome_notice_pdf'], reasonCodes: [], ...changes,
  };
}

function index(notices: FixtureNotice[] = [], regionCodes = catalogRegions) {
  return {
    contractVersion: 'notice-search-index/v1', dataOrigin: 'synthetic', observedAt, publicationWindow, regionCodes,
    coverage: { status: 'complete', sources: [{ source: 'applyhome_apt', status: notices.length ? 'complete' : 'empty' },
      { source: 'applyhome_remainder', status: 'empty' }] },
    notices,
  };
}

function search(notices: FixtureNotice[], input: unknown = minimal) {
  const conditions = parseNoticeSearchConditions(input);
  assert.ok(conditions);
  return evaluateNoticeSearch(index(notices), conditions, asOf);
}

test('accepts required conditions alone and preserves provided optional units and precision', () => {
  assert.deepEqual(parseNoticeSearchConditions(minimal), { ...minimal, includeClosed: false });
  const full = { ...minimal, supplyArea: { min: '1.0000000000000000000000', max: '1.00', unit: 'pyeong' },
    moveIn: { start: '2026-02', end: '2026-02' }, includeClosed: true };
  assert.deepEqual(parseNoticeSearchConditions(full), full);
  assert.ok(parseNoticeSearchConditions({ ...minimal, budgetMaxWon: '0' }));
});

test('rejects missing, ambiguous, extra and oversized HTTP body fields', () => {
  const invalid: unknown[] = [
    [], null, {}, { budgetMaxWon: '900000000' }, { regionCodes: ['11111'] },
    { ...minimal, index: index() }, { ...minimal, regionCodes: [] }, { ...minimal, regionCodes: ['11111', '11111'] },
    { ...minimal, regionCodes: ['11111\n'] }, { ...minimal, regionCodes: [11111] },
    { ...minimal, regionCodes: Array.from({ length: 51 }, (_, i) => String(i + 11_000)) },
    ...[900000000, null, '-1', '0900', '9e8', '900.0', '900\n', '9'.repeat(21)].map(budgetMaxWon => ({ ...minimal, budgetMaxWon })),
    ...[null, undefined, 'true', 0].map(includeClosed => ({ ...minimal, includeClosed })),
    { ...minimal, supplyArea: { min: '1', max: '2' } },
    { ...minimal, supplyArea: { min: '1', max: '2', unit: '㎡' } },
    { ...minimal, supplyArea: { min: '1.000000000000000000001', max: '1', unit: 'm2' } },
    { ...minimal, supplyArea: { min: '0.0', max: '2', unit: 'm2' } },
    { ...minimal, supplyArea: { min: '1', max: '2', unit: 'm2', basis: 'exclusive' } },
    { ...minimal, moveIn: { start: '2026-00', end: '2026-01' } },
    { ...minimal, moveIn: { start: '2026-12', end: '2026-01' } },
    { ...minimal, moveIn: { start: '2027-02-01', end: '2027-02-28' } },
  ];
  for (const input of invalid) assert.equal(parseNoticeSearchConditions(input), null, JSON.stringify(input));
});

test('sorts active notices by inclusive closing date then upcoming notices by start date', () => {
  const notices = [
    candidate(1, { application: { start: '2026-07-04', end: '2026-07-05' }, kind: 'unranked' }),
    candidate(2, { application: { start: asOf, end: '2026-07-03' }, kind: 'remaining' }),
    candidate(3, { kind: 'resupply', regionCode: '22222' }),
    candidate(4, { application: { start: '2026-07-02', end: '2026-07-08' } }),
    candidate(5, { application: { start: '2026-06-27', end: '2026-06-30' } }),
    candidate(6, { application: null }),
    candidate(7, { application: { start: asOf, end: asOf } }),
  ];
  const result = search(notices);
  const ordered = [3, 7, 2, 4, 1].map(n => notices[n - 1].noticeNo);
  assert.deepEqual(result.matched.map(notice => notice.noticeNo), ordered);
  assert.deepEqual(search([...notices].reverse()).matched.map(notice => notice.noticeNo), ordered);
  assert.deepEqual(result.matched.map(notice => notice.applicationStatus), ['open', 'open', 'open', 'upcoming', 'upcoming']);
  assert.deepEqual(result.needsReview.map(notice => notice.applicationStatus), ['unknown']);
  assert.ok(result.needsReview[0].reasonCodes.includes('application_dates_unverified'));
  const withClosed = search(notices, { ...minimal, includeClosed: true });
  assert.equal(withClosed.matched.find(notice => notice.noticeNo === notices[4].noticeNo)?.applicationStatus, 'closed');
});

test('excludes known listing mismatches independently of missing dates, price or inventory', () => {
  const match = candidate(5, { regionCode: '22222' });
  const notices = [
    candidate(1, { regionCode: '33333', kind: 'unknown', application: null, inventoryComplete: false, models: [] }),
    candidate(2, { regionCode: null, kind: 'unsupported', application: null, inventoryComplete: false, models: [] }),
    candidate(3, { regionCode: null }), candidate(4, { kind: 'unknown' }), match,
  ];
  const result = search(notices);
  assert.deepEqual(result.counts, { matched: 1, needsReview: 2, excluded: 2 });
  assert.equal(result.matched[0].noticeNo, match.noticeNo);
  assert.ok(result.needsReview.find(notice => notice.noticeNo === notices[2].noticeNo)?.reasonCodes.includes('region_unverified'));
  assert.ok(result.needsReview.find(notice => notice.noticeNo === notices[3].noticeNo)?.reasonCodes.includes('kind_unverified'));
});

test('checks the parent city as an alternative to its district and counts each notice once', () => {
  const confirmed = candidate(1, { regionCode: '44441', parentRegionCode: '44440' });
  const unchecked = candidate(2, { regionCode: '44442', parentRegionCode: null });
  for (const regionCodes of [['44440'], ['44441'], ['44440', '44441']]) {
    const result = search([confirmed, unchecked], { ...minimal, regionCodes });
    assert.deepEqual(result.matched.map(notice => notice.noticeNo), [confirmed.noticeNo]);
    assert.equal(result.matched[0].parentRegionCode, '44440');
    assert.deepEqual(result.counts, { matched: 1, needsReview: 0, excluded: 1 });
  }
});

test('keeps the verified selections when another region is missing from the official index', () => {
  const result = search([candidate(1)], { ...minimal, regionCodes: ['11111', '99999'] });
  assert.equal(result.counts.matched, 1);
  assert.ok(result.scopeIssues.includes('region_selection_unverified'));
  assert.deepEqual(result.unverifiedRegionCodes, ['99999']);
  const unresolved = search([candidate(2, { regionCode: null })], { ...minimal, regionCodes: ['99999'] });
  assert.deepEqual(unresolved.counts, { matched: 0, needsReview: 0, excluded: 0 });
  assert.equal(unresolved.zeroStatus, 'indeterminate');
  const emptyVerifiedRegion = search([], { ...minimal, regionCodes: ['11111', '99999'] });
  assert.equal(emptyVerifiedRegion.zeroStatus, 'indeterminate');
});

test('runs legacy synthetic fixtures while withholding a zero without a verified region catalog', () => {
  const { regionCodes: _, ...legacy } = index();
  const conditions = parseNoticeSearchConditions(minimal)!;
  for (const value of [legacy, index([], [])]) {
    const result = evaluateNoticeSearch(value, conditions, asOf);
    assert.deepEqual(result.scopeIssues, ['region_selection_unverified']);
    assert.equal(result.zeroStatus, 'indeterminate');
  }
  const { regionCodes: _catalog, ...withNotice } = index([candidate(1)]);
  assert.equal(evaluateNoticeSearch(withNotice, conditions, asOf).counts.matched, 1);
  for (const value of [legacy, index([], [])]) {
    assert.throws(() => evaluateNoticeSearch({ ...value, dataOrigin: 'collected' }, conditions, asOf),
      /^Error: invalid_notice_search_index$/);
  }
});

test('uses documented application segments within the overall application dates', () => {
  const notice = candidate(1, { application: { start: '2026-06-28', end: '2026-07-05' },
    applicationSegments: [{ start: '2026-06-29', end: '2026-06-30' }, { start: '2026-07-03', end: '2026-07-04' }],
    reasonCodes: ['application_split'] });
  const conditions = parseNoticeSearchConditions(minimal)!;
  const fixture = index([notice]);
  for (const [date, status] of [['2026-06-27', 'upcoming'], ['2026-06-29', 'open'], ['2026-06-30', 'open'],
    ['2026-07-03', 'open'], ['2026-07-04', 'open']]) {
    const result = evaluateNoticeSearch(fixture, conditions, date);
    assert.equal(result.matched[0].applicationStatus, status);
    assert.deepEqual(result.matched[0].applicationSegments, notice.applicationSegments);
  }
  for (const date of ['2026-06-28', '2026-07-01', '2026-07-05']) {
    const result = evaluateNoticeSearch(fixture, conditions, date);
    assert.equal(result.counts.needsReview, 1);
    assert.equal(result.needsReview[0].applicationStatus, 'unknown');
    assert.ok(result.needsReview[0].reasonCodes.includes('application_split'));
  }
  const earlierClose = candidate(2, { application: { start: '2026-06-28', end: '2026-07-02' } });
  const ordered = evaluateNoticeSearch(index([notice, earlierClose]), conditions, '2026-06-30');
  assert.deepEqual(ordered.matched.map(result => result.noticeNo), [earlierClose.noticeNo, notice.noticeNo]);
  const unresolved = evaluateNoticeSearch(index([{ ...notice, applicationSegments: [] }]), conditions, asOf);
  assert.equal(unresolved.needsReview[0].applicationStatus, 'unknown');
  const closed = evaluateNoticeSearch(fixture, conditions, '2026-07-06');
  assert.deepEqual(closed.counts, { matched: 0, needsReview: 0, excluded: 1 });
  assert.equal(evaluateNoticeSearch(fixture, { ...conditions, includeClosed: true }, '2026-07-06')
    .matched[0].applicationStatus, 'closed');
});

test('rejects a region catalog or application segments that contradict the published fields', () => {
  const valid = candidate(1, { parentRegionCode: '44440' });
  const split = { ...valid, reasonCodes: ['application_split'] };
  const conditions = parseNoticeSearchConditions(minimal)!;
  const malformed = [index([], ['11111', '11111']), index([], ['22222', '11111']),
    index([], ['1111']), index([], Array(1001).fill('11111')),
    index([valid], ['11111']), index([valid], ['44440']),
    index([{ ...valid, parentRegionCode: '11111' }]), index([{ ...valid, regionCode: null }]),
    index([{ ...valid, applicationSegments: [application] }]),
    index([{ ...split, application: null, applicationSegments: [] }]),
    index([{ ...split, applicationSegments: [{ ...application, start: '2026-06-27' }] }]),
    index([{ ...split, applicationSegments: [application, application] }]),
    index([{ ...split, applicationSegments: [{ start: asOf, end: asOf }, { start: '2026-06-28', end: '2026-06-28' }] }]),
    index([{ ...split, applicationSegments: Array(11).fill(application) }]),
  ];
  for (const value of malformed) {
    assert.throws(() => evaluateNoticeSearch(value, conditions, asOf), /^Error: invalid_notice_search_index$/);
  }
});

test('uses an exact budget subtotal and preserves independent official evidence and unknown rooms', () => {
  const first = candidate(1);
  const model = first.models[0];
  model.rooms[0].subtotalWon = '99999999999999999998';
  model.rooms.push({ ...model.rooms[0], room: '101동 102호', subtotalWon: '99999999999999999999' },
    { room: '101동 103호', subtotalWon: null, priceEvidence: [] });
  const result = search([first], { ...minimal, budgetMaxWon: '99999999999999999998' });
  assert.equal(result.counts.matched, 1);
  assert.equal(result.counts.needsReview, 0);
  assert.deepEqual(result.needsReview, []);
  const matched = result.matched[0];
  assert.deepEqual(matched.sourceIds, first.sourceIds);
  assert.equal(matched.edition, first.edition);
  assert.deepEqual(matched.models[0].areaEvidence, model.areaEvidence);
  assert.deepEqual(matched.models[0].matchedRooms, [model.rooms[0]]);
  assert.deepEqual(matched.models[0].needsReviewRooms, [{ ...model.rooms[2], reasonCodes: ['price_unverified'] }]);
  assert.deepEqual(result.priceBasis, { subtotal: 'sale_price_plus_required_options', taxes: 'unverified', financingCosts: 'unverified' });
});

test('never combines affordable rooms with another model that meets the area range', () => {
  const notice = candidate(1);
  const affordable = notice.models[0];
  affordable.supplyAreaM2 = '99.9999';
  const smallUnknownPrice = { room: '101동 102호', subtotalWon: null, priceEvidence: [] };
  affordable.rooms.push(smallUnknownPrice);
  notice.models.push({ ...affordable, modelNo: '02', houseType: '084B', supplyAreaM2: '100.00',
    rooms: [{ ...affordable.rooms[0], room: '102동 101호', subtotalWon: '900000001' }] });
  const result = search([notice], { ...minimal, supplyArea: { min: '100', max: '110', unit: 'm2' } });
  assert.deepEqual(result.counts, { matched: 0, needsReview: 0, excluded: 1 });
  assert.equal(result.zeroStatus, 'confirmed_zero');
});

test('compares m² and pyeong exactly before display rounding', () => {
  const notices = [candidate(1), candidate(2), candidate(3)];
  notices[0].models[0].supplyAreaM2 = '400.0000';
  notices[1].models[0].supplyAreaM2 = '399.99999999999999999999';
  notices[2].models[0].supplyAreaM2 = '400.00000000000000000001';
  for (const [unit, boundary] of [['pyeong', '121'], ['m2', '400']]) {
    const result = search(notices, { ...minimal, supplyArea: { min: boundary, max: boundary, unit } });
    assert.deepEqual(result.counts, { matched: 1, needsReview: 0, excluded: 2 });
    assert.equal(result.matched[0].models[0].supplyAreaM2, '400.0000');
    assert.equal(result.matched[0].models[0].supplyAreaPyeong, '121.00');
    assert.equal(result.appliedConditions.supplyArea?.unit, unit);
    assert.deepEqual(result.areaConversion, { pyeongToM2: { numerator: 400, denominator: 121 }, displayPyeongDecimals: 2 });
  }
});

test('ignores unapplied optional conditions and preserves inclusive move-in month overlap', () => {
  const unknown = candidate(1);
  unknown.models[0].supplyAreaM2 = null;
  unknown.models[0].areaEvidence = [];
  assert.equal(search([unknown]).counts.matched, 1);
  const candidates = [unknown, candidate(2, { moveIn: { start: '2028-02', end: '2028-04' } }),
    candidate(3, { moveIn: { start: '2027-09', end: '2027-12' } }),
    candidate(4, { moveIn: { start: '2028-03', end: '2028-04' }, regionCode: null })];
  const input = { ...minimal, moveIn: { start: '2027-12', end: '2028-02' }, supplyArea: { min: '100', max: '120', unit: 'm2' } };
  const result = search(candidates, input);
  assert.deepEqual(result.counts, { matched: 2, needsReview: 1, excluded: 1 });
  assert.deepEqual(result.matched.map(notice => notice.moveIn), [candidates[1].moveIn, candidates[2].moveIn]);
  const [review] = result.needsReview;
  assert.ok(review.reasonCodes.includes('move_in_unverified'));
  assert.ok(review.models[0].needsReviewRooms[0].reasonCodes.includes('supply_area_unverified'));
  assert.equal(review.models[0].supplyAreaPyeong, null);
});

test('needs complete room inventory to exclude a candidate on budget', () => {
  const incomplete = candidate(1, { inventoryComplete: false });
  incomplete.models[0].rooms[0].subtotalWon = '900000001';
  const incompleteResult = search([incomplete]);
  assert.equal(incompleteResult.zeroStatus, 'indeterminate');
  assert.ok(incompleteResult.needsReview[0].reasonCodes.includes('inventory_incomplete'));
  assert.equal(search([{ ...incomplete, inventoryComplete: true }]).zeroStatus, 'confirmed_zero');
  incomplete.models[0].rooms[0].subtotalWon = '900000000';
  assert.ok(search([incomplete]).matched[0].reasonCodes.includes('inventory_incomplete'));
});

test('does not turn unknown price or restricted sources into a zero price or an exclusion', () => {
  const notices = [candidate(1, { sourceIds: ['applyhome_apt', 'applyhome_apt_model'], reasonCodes: ['source_restricted'] }),
    candidate(2, { sourceIds: ['applyhome_apt', 'applyhome_apt_model'], reasonCodes: ['source_unverified'] })];
  for (const notice of notices) {
    const model = notice.models[0];
    model.supplyAreaM2 = null;
    model.areaEvidence = [];
    model.rooms = [{ room: '101동 102호', subtotalWon: null, priceEvidence: [] }];
  }
  const result = search(notices, { ...minimal, budgetMaxWon: '0' });
  assert.deepEqual(result.counts, { matched: 0, needsReview: 2, excluded: 0 });
  assert.ok(result.needsReview[0].reasonCodes.includes('source_restricted'));
  assert.ok(result.needsReview[1].reasonCodes.includes('source_unverified'));
  assert.equal(result.needsReview[0].models[0].needsReviewRooms[0].subtotalWon, null);
  assert.equal(result.zeroStatus, 'indeterminate');
});

test('preserves the published reasons for incomplete source, document and room inventory checks', () => {
  const reasons = ['notice_kind_unverified', 'detail_collection_incomplete', 'official_document_unverified',
    'model_unverified', 'room_price_unverified', 'inventory_unverified'];
  const result = search([candidate(1, { kind: 'unknown', models: [], inventoryComplete: false,
    sourceIds: ['applyhome_apt'], reasonCodes: reasons })]);
  assert.equal(result.counts.needsReview, 1);
  assert.deepEqual(result.needsReview[0].reasonCodes.slice(0, reasons.length), reasons);
});

test('a zero is scoped to complete coverage, the publication window and the KST observation date', () => {
  const conditions = parseNoticeSearchConditions(minimal)!;
  const good = index();
  const complete = evaluateNoticeSearch(good, conditions, asOf);
  assert.equal(complete.contractVersion, 'notice-search/v1');
  assert.equal(complete.dataOrigin, 'synthetic');
  assert.equal(complete.observedAt, observedAt);
  assert.deepEqual(complete.publicationWindow, publicationWindow);
  assert.equal(complete.zeroStatus, 'confirmed_zero');
  assert.equal(evaluateNoticeSearch({ ...good, coverage: { status: 'partial', sources: [good.coverage.sources[0],
    { source: 'applyhome_remainder', status: 'failed' }] } }, conditions, asOf).zeroStatus, 'indeterminate');
  assert.equal(evaluateNoticeSearch({ ...good, coverage: { status: 'unavailable', sources: good.coverage.sources.map(source => ({ ...source,
    status: 'failed' })) } }, conditions, asOf).zeroStatus, 'indeterminate');
  assert.equal(evaluateNoticeSearch({ ...good, publicationWindow: { ...publicationWindow, end: '2026-06-30' } }, conditions, asOf).zeroStatus, 'indeterminate');
  assert.equal(evaluateNoticeSearch({ ...good, observedAt: '2026-06-30T14:59:59Z' }, conditions, asOf).zeroStatus, 'indeterminate');
});

test('rejects malformed and non-public server index fields with a generic error', () => {
  const notice = candidate(1);
  const model = notice.models[0];
  const room = model.rooms[0];
  const conditions = parseNoticeSearchConditions(minimal)!;
  const bad = [null, { ...index(), contractVersion: 'notice-search-index/v2' }, { ...index(), ownerId: 'SYNTHETIC_PRIVATE' },
    { ...index(), observation: observedAt }, { ...index(), observedAt: '2026-02-29T03:15:00+09:00' },
    { ...index(), observedAt: '2026-07-01T03:15:00' },
    { ...index(), publicationWindow: { start: '2026-06-31', end: '2026-07-01' } },
    { ...index(), coverage: { status: 'complete', sources: [index().coverage.sources[0]] } },
    { ...index(), coverage: { status: 'complete', sources: [index().coverage.sources[0], index().coverage.sources[0]] } },
    { ...index(), coverage: { status: 'complete', sources: [index().coverage.sources[0], { source: 'applyhome_remainder', status: 'partial' }] } },
    index([notice, { ...notice, edition: 'synthetic-other-edition' }]),
    index([{ ...notice, noticeNo: '999' }]),
    index([{ ...notice, title: '합성 공고 https://synthetic.invalid' }]),
    index([{ ...notice, reasonCodes: ['private_arbitrary_message'] }]),
    index([{ ...notice, sourceIds: ['user_upload'] }]),
    index([{ ...notice, sourceIds: ['applyhome_apt', 'applyhome_notice_pdf'] }]),
    index([{ ...notice, application: { start: '2026-07-02', end: '2026-07-01' } }]),
    index([{ ...notice, models: [model, model] }]),
    index([{ ...notice, models: [{ ...model, houseType: '084A ' }] }]),
    index([{ ...notice, models: [{ ...model, houseType: '🏠'.repeat(33) }] }]),
    index([{ ...notice, title: '합성 공고 javascript:합성' }]),
    index([{ ...notice, models: [{ ...model, rooms: [room, room] }] }]),
    index([{ ...notice, models: [{ ...model, rooms: [{ ...room, subtotalWon: '0' }] }] }]),
    index([{ ...notice, models: [{ ...model, rooms: [{ ...room, priceEvidence: [] }] }] }]),
    index([{ ...notice, models: [{ ...model, areaEvidence: [{ ...model.areaEvidence[0], page: 0 }] }] }]),
    index([{ ...notice, models: [{ ...model, areaEvidence: [{ ...model.areaEvidence[0], document: 'upload:SYNTHETIC_PRIVATE' }] }] }]),
    index([{ ...notice, models: [{ ...model, areaEvidence: [{ ...model.areaEvidence[0], document: 'applyhome:9999999999:9999999999:8:1' }] }] }]),
  ];
  for (const value of bad) assert.throws(() => evaluateNoticeSearch(value, conditions, asOf), /^Error: invalid_notice_search_index$/);
  assert.throws(() => evaluateNoticeSearch(index(), conditions, '2026-07-01T00:00:00+09:00'), /^Error: invalid_notice_search_index$/);
});

test('truncates list and room detail only after evaluating the full index', () => {
  const many = Array.from({ length: 111 }, (_, i) => candidate(i + 1, i < 53 ? {} : { application: null }));
  const first = many[0].models[0];
  first.rooms = Array.from({ length: 45 }, (_, i) => i < 23
    ? { ...first.rooms[0], room: `합성 ${i}호` }
    : { room: `합성 ${i}호`, subtotalWon: null, priceEvidence: [] });
  const result = search(many);
  assert.deepEqual(result.counts, { matched: 53, needsReview: 58, excluded: 0 });
  assert.equal(result.matched.length, 50);
  assert.equal(result.needsReview.length, 50);
  assert.equal(result.truncation.matchedOmitted, 3);
  assert.equal(result.truncation.needsReviewOmitted, 8);
  const [summary] = result.matched;
  assert.equal(summary.counts.matchedRooms, 23);
  assert.equal(summary.counts.needsReviewRooms, 22);
  assert.equal(summary.truncation.matchedRoomsOmitted, 11);
  assert.equal(summary.truncation.needsReviewRoomsOmitted, 10);
  assert.equal(result.zeroStatus, 'not_zero');
  const reviewOnly = search(many.slice(53));
  assert.equal(reviewOnly.truncation.needsReviewOmitted, 8);
  assert.equal(reviewOnly.zeroStatus, 'indeterminate');
});

test('bounds serialized output with multibyte names and rich evidence without losing accurate counts', () => {
  const notices = Array.from({ length: 40 }, (_, i) => candidate(i + 1,
    { title: '합'.repeat(190), application: i < 20 ? application : null }));
  for (const notice of notices) {
    const model = notice.models[0];
    const refs = Array.from({ length: 8 }, (_, i) => ({ ...model.areaEvidence[0], page: i + 1 }));
    model.rooms = Array.from({ length: 20 }, (_, i) => ({ ...model.rooms[0], room: `${'호'.repeat(60)}${i}`, priceEvidence: refs }));
  }
  const result = search(notices);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 512 * 1024);
  assert.deepEqual(result.counts, { matched: 20, needsReview: 20, excluded: 0 });
  assert.ok(result.matched.length > 0 && result.needsReview.length > 0);
  assert.ok(result.truncation.matchedOmitted > 0 && result.truncation.needsReviewOmitted > 0);
});

test('keeps a first result with dense official references and its unresolved inventory', () => {
  const notice = candidate(1, { title: '합'.repeat(200), inventoryComplete: false, parentRegionCode: '44440',
    application: { start: '2026-06-12', end: '2026-07-01' },
    applicationSegments: [...Array.from({ length: 9 }, (_, i) => {
      const date = `2026-06-${12 + i * 2}`;
      return { start: date, end: date };
    }), { start: asOf, end: asOf }], reasonCodes: ['application_split'] });
  const refs = Array.from({ length: 16 }, (_, i) => ({
    document: `applyhome:${notice.houseManageNo}:${notice.noticeNo}:${'9'.repeat(20)}:${'8'.repeat(20)}`,
    version: digest, page: 2_147_483_647 - i,
  }));
  notice.models = Array.from({ length: 39 }, (_, i) => ({
    modelNo: String(10_000 + i).padStart(20, '0'), houseType: '형'.repeat(64),
    supplyAreaM2: '9'.repeat(24), areaEvidence: refs,
    rooms: i < 26 ? [{ room: '호'.repeat(64), subtotalWon: i < 13 ? '900000000' : null, priceEvidence: refs }] : [],
  }));
  const result = search([notice]);
  assert.equal(result.matched.length, 1);
  assert.deepEqual(result.matched[0].counts, { matchedRooms: 13, needsReviewRooms: 13, modelsWithoutRooms: 13 });
  assert.equal(result.matched[0].models[0].houseType, '형'.repeat(64));
  assert.equal(result.matched[0].models[0].matchedRooms[0].priceEvidence.length, 16);
  assert.equal(result.matched[0].models.length, 36);
  assert.equal(result.truncation.detailTruncatedNotices, 1);
});

test('rejects an oversized index with individually valid public rows', () => {
  const notices = Array.from({ length: 32 }, (_, i) => candidate(i + 1));
  for (const notice of notices) {
    const model = notice.models[0];
    const refs = Array.from({ length: 16 }, (_, i) => ({ ...model.areaEvidence[0], page: i + 1 }));
    model.rooms = Array.from({ length: 32 }, (_, i) => ({ ...model.rooms[0], room: `합성 ${i}호`, priceEvidence: refs }));
  }
  const large = index(notices);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 2 * 1024 * 1024);
  assert.throws(() => evaluateNoticeSearch(large, parseNoticeSearchConditions(minimal)!, asOf), /^Error: invalid_notice_search_index$/);
});
