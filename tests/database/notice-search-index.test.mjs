// 합성 자료와 PGlite로 SQL 계약을 검증한다. 실제 공고 수집이나 Supabase Auth를 사용하지 않는다.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createBe03Db } from './helpers/be03-db.mjs';

const users = {
  verified: '00000000-0000-4000-8000-000000000001',
  second: '00000000-0000-4000-8000-000000000002',
  anonymous: '00000000-0000-4000-8000-000000000003',
  unconfirmed: '00000000-0000-4000-8000-000000000004',
  banned: '00000000-0000-4000-8000-000000000005',
  deleted: '00000000-0000-4000-8000-000000000006',
  missing: '00000000-0000-4000-8000-000000000007',
};
const feeds = ['applyhome_apt', 'applyhome_remainder'];
const regionSource = 'mois_legal_region_codes';
const sourceIds = [...feeds, regionSource, 'applyhome_apt_model', 'applyhome_remainder_model', 'applyhome_notice_pdf'];
const invalid = { code: '22023' };
const forbidden = { code: '42501' };
const conflict = { code: 'PT409' };
const restricted = { code: 'PT403', message: 'notice_search_source_use_not_allowed' };
const koreaDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });
const hourMs = 60 * 60 * 1000;
let db;

async function as(role, userId = '', anonymous = false) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claims',$2,false)",
    [userId, JSON.stringify({ sub: userId, is_anonymous: anonymous })]);
  await db.exec(`set role ${role}`);
}

const publish = (index) => db.query('select public.publish_notice_search_index($1)',
  [index === null ? null : JSON.stringify(index)]);
const read = async () => (await db.query('select public.read_notice_search_index() as value')).rows[0].value;

function fixture(observedAt = new Date()) {
  const today = koreaDate.format(observedAt);
  const houseManageNo = '9900000001';
  const noticeNo = '9900000002';
  const ref = { document: `applyhome:${houseManageNo}:${noticeNo}:1:1`, version: `sha256:${'a'.repeat(64)}`, page: 2 };
  return {
    contractVersion: 'notice-search-index/v1',
    // RPC에서 출처 권한을 검사하기 위한 합성 표식이다.
    dataOrigin: 'collected',
    observedAt: observedAt.toISOString(),
    publicationWindow: { start: today, end: today },
    regionCodes: ['99990', '99999'],
    coverage: { status: 'complete', sources: [
      { source: feeds[0], status: 'complete' }, { source: feeds[1], status: 'empty' },
    ] },
    notices: [{
      houseManageNo, noticeNo, edition: today, title: '합성 아파트 모집공고', kind: 'new_sale', regionCode: '99999',
      application: { start: today, end: today }, moveIn: { start: '2030-01', end: '2030-02' }, inventoryComplete: true,
      models: [{ modelNo: '01', houseType: '084.0000A', supplyAreaM2: '110.1234', areaEvidence: [ref],
        rooms: [{ room: '101동 101호', subtotalWon: '720000000', priceEvidence: [{ ...ref, page: 5 }] }] }],
      sourceIds: [feeds[0], 'applyhome_apt_model', 'applyhome_notice_pdf'], reasonCodes: [],
    }],
  };
}

function emptyIndex(aptStatus = 'empty', remainderStatus = 'empty', status = 'complete') {
  const index = fixture();
  index.notices = [];
  index.coverage = { status, sources: [{ source: feeds[0], status: aptStatus },
    { source: feeds[1], status: remainderStatus }] };
  return index;
}

before(async () => {
  db = await createBe03Db();
  // Auth 열만 보강한 테스트 모형이다. 요청의 JWT 정보는 각 역할에서 별도로 설정한다.
  await db.exec(`alter table auth.users add column confirmed_at timestamptz,
    add column is_anonymous boolean not null default false,
    add column banned_until timestamptz, add column deleted_at timestamptz`);
  await db.query(`insert into auth.users(id,confirmed_at,is_anonymous,banned_until,deleted_at) values
    ($1,now(),false,null,null), ($2,now(),false,null,null), ($3,now(),true,null,null),
    ($4,null,false,null,null), ($5,now(),false,now() + interval '1 day',null),
    ($6,now(),false,null,now())`, Object.values(users).slice(0, 6));
});

beforeEach(async () => {
  await db.exec('reset role');
  await db.exec('delete from private.notice_search_index');
  await db.query(`insert into public.source_registry(id,display_name,storage_permission,reuse_permission,display_permission)
    select id,'합성 출처','allowed','allowed','allowed' from unnest($1::text[]) as source(id)
    on conflict (id) do update set storage_permission = 'allowed', reuse_permission = 'allowed',
      display_permission = 'allowed', retention_days = null`, [sourceIds]);
});

after(async () => { await db?.close(); });

test('only verified authenticated users can read the same published catalog', async () => {
  const index = fixture();
  await as('authenticated', users.verified);
  assert.equal(await read(), null);
  await assert.rejects(publish(index), forbidden);
  await assert.rejects(db.query('select index_value from private.notice_search_index'), forbidden);

  await as('anon');
  await assert.rejects(read(), forbidden);
  await assert.rejects(publish(index), forbidden);

  await as('service_role');
  await assert.rejects(read(), forbidden);
  await assert.rejects(db.query('delete from private.notice_search_index'), forbidden);
  await publish(index);

  for (const userId of [users.verified, users.second]) {
    await as('authenticated', userId);
    assert.deepEqual(await read(), index);
  }
  for (const userId of ['', users.anonymous, users.unconfirmed, users.banned, users.deleted, users.missing]) {
    await as('authenticated', userId);
    await assert.rejects(read(), forbidden);
  }
  await as('authenticated', users.verified, true);
  await assert.rejects(read(), forbidden);
});

test('a replacement accepts only a newer observation or an equal retry', async () => {
  const older = fixture(new Date(Date.now() - 2000));
  const newer = fixture(new Date());
  await as('service_role');
  await publish(older);
  await publish({ ...older, notices: older.notices });
  const sameInstant = structuredClone(older);
  sameInstant.notices[0].title = '합성 충돌 공고';
  await assert.rejects(publish(sameInstant), conflict);
  await publish(newer);
  await assert.rejects(publish(older), conflict);
  await as('authenticated', users.verified);
  assert.deepEqual(await read(), newer);
});

test('freshness and replacement compare RFC3339 offsets and all fractional digits', async () => {
  const second = new Date(Math.floor(Date.now() / 1000) * 1000);
  const utc = second.toISOString().slice(0, 19);
  const offsetClock = new Date(second.getTime() + 16.5 * hourMs).toISOString().slice(0, 19);
  const old = { ...fixture(second), observedAt: `${offsetClock}.000000001+16:30` };
  const equalInstant = { ...old, observedAt: `${utc}.000000001Z` };
  const next = { ...old, observedAt: `${utc.toLowerCase()}.000000002z` };
  await as('service_role');
  await publish(old);
  await assert.rejects(publish(equalInstant), conflict);
  await publish(next);
  await assert.rejects(publish(old), conflict);
  await as('authenticated', users.verified);
  assert.deepEqual(await read(), next);
});

test('both feed permissions are required for a proven empty catalog and rechecked on read', async () => {
  const index = emptyIndex();
  await db.query('delete from public.source_registry where id = $1', [feeds[1]]);
  await as('service_role');
  await assert.rejects(publish(index), forbidden);
  await db.exec('reset role');
  await db.query(`insert into public.source_registry(id,display_name,storage_permission,reuse_permission,display_permission)
    values ($1,'합성 출처','allowed','allowed','allowed')`, [feeds[1]]);
  await as('service_role');
  await publish(index);

  for (const [column, value] of [['storage_permission', 'denied'], ['reuse_permission', 'unknown'],
    ['display_permission', 'denied'], ['retention_days', 10]]) {
    await db.exec('reset role');
    await db.query(`update public.source_registry set ${column} = $1 where id = $2`, [value, feeds[1]]);
    await as('service_role');
    await assert.rejects(publish(index), forbidden);
    await as('authenticated', users.verified);
    await assert.rejects(read(), restricted);
    await db.exec('reset role');
    await db.query(`update public.source_registry set ${column} = $1 where id = $2`,
      [column === 'retention_days' ? null : 'allowed', feeds[1]]);
  }
  await as('authenticated', users.verified);
  assert.deepEqual(await read(), index);
});

test('the official region dictionary requires permission even with no notices', async () => {
  const index = emptyIndex();
  await db.query("update public.source_registry set display_permission = 'unknown' where id = $1", [regionSource]);
  await as('service_role');
  await assert.rejects(publish(index), forbidden);
  await db.exec('reset role');
  await db.query("update public.source_registry set display_permission = 'allowed' where id = $1", [regionSource]);
  await as('service_role');
  await publish(index);
  await as('authenticated', users.verified);
  assert.deepEqual(await read(), index);

  await db.exec('reset role');
  await db.query("update public.source_registry set reuse_permission = 'denied' where id = $1", [regionSource]);
  await as('service_role');
  await assert.rejects(publish(index), forbidden);
  await as('authenticated', users.verified);
  await assert.rejects(read(), restricted);
});

test('published model and PDF sources are required at write and read time', async () => {
  const index = fixture();
  index.coverage.sources[1].status = 'complete';
  index.notices[0].sourceIds.push('applyhome_remainder', 'applyhome_remainder_model');
  await as('service_role');
  await publish(index);
  for (const sourceId of ['applyhome_apt_model', 'applyhome_remainder_model', 'applyhome_notice_pdf']) {
    await db.exec('reset role');
    await db.query("update public.source_registry set display_permission = 'denied' where id = $1", [sourceId]);
    await as('service_role');
    await assert.rejects(publish(index), forbidden);
    await as('authenticated', users.verified);
    await assert.rejects(read(), restricted);
    await db.exec('reset role');
    await db.query("update public.source_registry set display_permission = 'allowed' where id = $1", [sourceId]);
  }
});

test('feed coverage distinguishes a verified zero from partial or unavailable collection', async () => {
  await as('service_role');
  for (const index of [emptyIndex('empty', 'failed', 'partial'), emptyIndex('failed', 'failed', 'unavailable'),
    emptyIndex('partial', 'empty', 'partial')]) {
    // 각 케이스를 별도 관측으로 기록한다.
    await publish(index);
    await db.exec('reset role');
    await db.exec('delete from private.notice_search_index');
    await as('service_role');
  }
  const good = fixture();
  const duplicateFeed = structuredClone(good);
  duplicateFeed.coverage.sources[1].source = feeds[0];
  const missingFeed = structuredClone(good);
  missingFeed.coverage.sources.pop();
  const emptyFeedWithNotice = structuredClone(good);
  emptyFeedWithNotice.coverage.sources[0].status = 'empty';
  const failedFeedWithNotice = structuredClone(good);
  failedFeedWithNotice.coverage.sources[0].status = 'failed';
  failedFeedWithNotice.coverage.status = 'partial';
  for (const index of [duplicateFeed, missingFeed, emptyFeedWithNotice, failedFeedWithNotice,
    emptyIndex('partial', 'empty', 'complete'), emptyIndex('failed', 'empty', 'unavailable'),
    emptyIndex('complete', 'empty', 'complete'), emptyIndex('failed', 'failed', 'partial')]) {
    await assert.rejects(publish(index), invalid);
  }
});

test('publication accepts only the bounded public contract and an official original for checked values', async () => {
  const corruptions = [
    ['extra top-level data', (index) => { index.ownerId = users.verified; }],
    ['notices object', (index) => { index.notices = {}; }],
    ['unknown schema version', (index) => { index.contractVersion = 'notice-search-index/v2'; }],
    ['synthetic mode', (index) => { index.dataOrigin = 'synthetic'; }],
    ['nested extra data', (index) => { index.coverage.sources[0].response = []; }],
    ['ten-digit strings only', (_, notice) => { notice.noticeNo = Number(notice.noticeNo); }],
    ['wrong district format', (_, notice) => { notice.regionCode = '999'; }],
    ['missing nullable key', (_, notice) => { delete notice.moveIn; }],
    ['bad calendar date', (_, notice) => { notice.application.end = '2026-02-29'; }],
    ['invalid move-in month', (_, notice) => { notice.moveIn.end = '2030-13'; }],
    ['reversed move-in interval', (_, notice) => { notice.moveIn.end = '2029-12'; }],
    ['unstructured reason', (_, notice) => { notice.reasonCodes = ['private_arbitrary_message']; }],
    ['unauthorized trade source', (_, notice) => { notice.sourceIds.push('apt_trade'); }],
    ['user upload source', (_, notice) => { notice.sourceIds.push('user_upload'); }],
    ['region dictionary in per-notice sources', (_, notice) => { notice.sourceIds.push(regionSource); }],
    ['missing model source', (_, notice) => { notice.sourceIds.splice(1, 1); }],
    ['inconsistent model source', (_, notice) => { notice.sourceIds[1] = 'applyhome_remainder_model'; }],
    ['undeclared PDF source', (_, notice) => { notice.sourceIds.pop(); }],
    ['source link field', (_, notice) => { notice.officialUrl = 'https://example.invalid/'; }],
    ['source link in title', (_, notice) => { notice.title = '공고 https://example.invalid'; }],
    ['surrounding nonbreaking space', (_, notice) => { notice.title += '\u00a0'; }],
    ['title over API UTF-16 bound', (_, notice) => { notice.title = '가'.repeat(199) + '😀'; }],
    ['extra model field', (_, _notice, model) => { model.exclusiveAreaM2 = '84'; }],
    ['house type exceeds public limit', (_, _notice, model) => { model.houseType = '가'.repeat(65); }],
    ['missing official area reference', (_, _notice, model) => { model.areaEvidence = []; }],
    ['area JSON number', (_, _notice, model) => { model.supplyAreaM2 = 110.1234; }],
    ['exponent as decimal string', (_, _notice, model) => { model.supplyAreaM2 = '1e2'; }],
    ['unidentified room inventory', (_, _notice, model) => { model.rooms = []; }],
    ['room label exceeds public limit', (_, _notice, _model, room) => { room.room = '가'.repeat(65); }],
    ['room amount as JSON number', (_, _notice, _model, room) => { room.subtotalWon = 720000000; }],
    ['zero subtotal', (_, _notice, _model, room) => { room.subtotalWon = '0'; }],
    ['missing official subtotal reference', (_, _notice, _model, room) => { room.priceEvidence = []; }],
    ['upload reference', (_, _notice, model) => { model.areaEvidence[0].document = 'upload:abc'; }],
    ['wrong notice reference', (_, _notice, model) => { model.areaEvidence[0].document = 'applyhome:9900000001:9900000003:1:1'; }],
    ['reference with source link', (_, _notice, model) => { model.areaEvidence[0].url = 'https://example.invalid'; }],
    ['reference with upload path', (_, _notice, model) => { model.areaEvidence[0].version = 'analysis-uploads/private.pdf'; }],
    ['invalid page number', (_, _notice, model) => { model.areaEvidence[0].page = 0; }],
    ['invalid page type', (_, _notice, model) => { model.areaEvidence[0].page = '2'; }],
    ['page outside public range', (_, _notice, model) => { model.areaEvidence[0].page = 2_147_483_648; }],
    ['duplicate notice', (index, notice) => { index.notices.push({ ...notice, edition: 'correction' }); }],
    ['duplicate model', (_, notice, model) => { notice.models.push(model); }],
    ['duplicate room', (_, _notice, model, room) => { model.rooms.push(room); }],
  ];
  await as('service_role');
  await assert.rejects(publish(null), invalid);
  for (const [name, corrupt] of corruptions) {
    const index = fixture();
    const [notice] = index.notices;
    const [model] = notice.models;
    corrupt(index, notice, model, model.rooms[0]);
    await assert.rejects(publish(index), invalid, name);
  }
});

test('a collected catalog preserves its registered distinct parent municipality', async () => {
  const index = fixture();
  index.notices[0].parentRegionCode = '99990';
  await as('service_role');
  await publish(index);
  await as('authenticated', users.verified);
  assert.deepEqual(await read(), index);
});

test('a region dictionary must be sorted, bounded, unique, and cover every specified district and parent', async () => {
  const corruptions = [
    ['missing dictionary', (index) => { delete index.regionCodes; }],
    ['empty dictionary', (index) => { index.regionCodes = []; }],
    ['nonarray dictionary', (index) => { index.regionCodes = { '99999': true }; }],
    ['unsorted dictionary', (index) => { index.regionCodes.reverse(); }],
    ['duplicate code', (index) => { index.regionCodes.push('99999'); }],
    ['numeric code', (index) => { index.regionCodes[0] = 99990; }],
    ['invalid code length', (index) => { index.regionCodes[0] = '9999'; }],
    ['overlong dictionary', (index) => {
      index.regionCodes = [...Array.from({ length: 1000 }, (_, i) => String(10000 + i)), '99999'];
    }],
    ['unregistered district', (_, notice) => { notice.regionCode = '99998'; }],
    ['unregistered parent', (_, notice) => { notice.parentRegionCode = '99998'; }],
    ['parent equals district', (_, notice) => { notice.parentRegionCode = notice.regionCode; }],
    ['parent given with unknown district', (_, notice) => { notice.regionCode = null; }],
    ['numeric parent', (_, notice) => { notice.parentRegionCode = 99990; }],
  ];
  await as('service_role');
  for (const [name, corrupt] of corruptions) {
    const index = fixture();
    const [notice] = index.notices;
    notice.parentRegionCode = '99990';
    corrupt(index, notice);
    await assert.rejects(publish(index), invalid, name);
  }
});

function splitSchedule(observedAt = new Date()) {
  const index = fixture(observedAt);
  const [notice] = index.notices;
  notice.application = { start: '2030-01-01', end: '2030-01-25' };
  notice.applicationSegments = [{ start: '2030-01-01', end: '2030-01-02' },
    { start: '2030-01-05', end: '2030-01-05' }, { start: '2030-01-24', end: '2030-01-25' }];
  notice.reasonCodes = ['application_split'];
  return index;
}

test('a split schedule preserves the outer dates and each independently confirmed segment', async () => {
  const index = splitSchedule(new Date(Date.now() - 2000));
  await as('service_role');
  await publish(index);
  await as('authenticated', users.verified);
  assert.deepEqual(await read(), index);

  const held = splitSchedule();
  held.notices[0].applicationSegments = [];
  await as('service_role');
  await publish(held);
  await as('authenticated', users.verified);
  assert.deepEqual(await read(), held);
});

test('published segments must be valid inclusive date ranges ordered without overlap inside the outer dates', async () => {
  const corruptions = [
    ['null segments', (notice) => { notice.applicationSegments = null; }],
    ['split outer dates without segments', (notice) => { delete notice.applicationSegments; }],
    ['segments without outer dates', (notice) => { notice.application = null; }],
    ['segments without a split reason', (notice) => { notice.reasonCodes = []; }],
    ['unsorted segments', (notice) => { notice.applicationSegments.reverse(); }],
    ['inclusive overlap', (notice) => { notice.applicationSegments[0].end = notice.applicationSegments[1].start; }],
    ['segment starts before outer dates', (notice) => { notice.applicationSegments[0].start = '2029-12-31'; }],
    ['segment ends after outer dates', (notice) => { notice.applicationSegments[2].end = '2030-01-26'; }],
    ['invalid segment date', (notice) => { notice.applicationSegments[2].start = '2030-02-30'; }],
    ['segment with private field', (notice) => { notice.applicationSegments[0].ownerId = users.verified; }],
    ['too many segments', (notice) => {
      notice.applicationSegments = Array.from({ length: 11 }, (_, i) => {
        const day = `2030-01-${String(2 * i + 1).padStart(2, '0')}`;
        return { start: day, end: day };
      });
    }],
  ];
  await as('service_role');
  for (const [name, corrupt] of corruptions) {
    const index = splitSchedule();
    corrupt(index.notices[0]);
    await assert.rejects(publish(index), invalid, name);
  }
});

test('stable collector reason codes preserve incomplete entries inside a bounded collection window', async () => {
  const now = new Date();
  const index = fixture(now);
  index.publicationWindow.start = koreaDate.format(new Date(now.getTime() - 365 * 24 * hourMs));
  const [notice] = index.notices;
  notice.edition = 'public';
  notice.title = null;
  notice.kind = 'unknown';
  notice.regionCode = null;
  notice.parentRegionCode = null;
  notice.application = null;
  notice.moveIn = null;
  notice.inventoryComplete = false;
  notice.models[0].supplyAreaM2 = null;
  notice.models[0].areaEvidence = [];
  notice.models[0].rooms[0].subtotalWon = null;
  notice.models[0].rooms[0].priceEvidence = [];
  notice.sourceIds.pop();
  notice.reasonCodes = ['application_unverified', 'detail_collection_incomplete', 'inventory_incomplete',
    'inventory_unverified', 'kind_unverified', 'model_unverified', 'move_in_unverified', 'notice_kind_unverified',
    'notice_kind_unsupported', 'official_document_unverified', 'price_unverified', 'publication_date_unverified',
    'region_unverified', 'room_price_unverified', 'source_unverified', 'supply_area_unverified'];
  index.coverage.sources[0].status = 'partial';
  index.coverage.status = 'partial';
  await as('service_role');
  await publish(index);
  await as('authenticated', users.verified);
  assert.deepEqual(await read(), index);
});

test('wide, stale, future or oversized publications fail closed', async () => {
  await as('service_role');
  const malformed = fixture();
  malformed.observedAt = '2026-02-30T12:00:00Z';
  const wide = fixture();
  wide.publicationWindow.start = '2001-01-01';
  const outside = fixture();
  outside.publicationWindow = { start: '2001-01-01', end: '2001-01-02' };
  const futureEnd = fixture();
  futureEnd.publicationWindow.end = koreaDate.format(new Date(Date.now() + 24 * hourMs));
  const oversized = fixture();
  oversized.notices[0].title = 'x'.repeat(2 * 1024 * 1024);
  for (const index of [malformed, wide, outside, futureEnd, oversized, fixture(new Date(Date.now() - 73 * hourMs)),
    fixture(new Date(Date.now() + hourMs))]) {
    await assert.rejects(publish(index), invalid);
  }
});

test('array limits apply below the overall index size limit', async () => {
  const manyNotices = fixture();
  const [notice] = manyNotices.notices;
  manyNotices.notices = Array.from({ length: 1001 }, (_, index) => ({ ...notice,
    noticeNo: String(9_900_000_000 + index), models: [], inventoryComplete: false,
  }));
  const manyModels = fixture();
  const [model] = manyModels.notices[0].models;
  manyModels.notices[0].models = Array.from({ length: 101 }, (_, index) => ({ ...model, modelNo: String(index) }));
  const manyRooms = fixture();
  const room = manyRooms.notices[0].models[0].rooms[0];
  manyRooms.notices[0].models[0].rooms = Array.from({ length: 2001 }, (_, index) => ({ ...room, room: `합성 ${index}호` }));
  const manyRefs = fixture();
  const [area] = manyRefs.notices[0].models[0].areaEvidence;
  manyRefs.notices[0].models[0].areaEvidence = Array.from({ length: 17 }, (_, index) => ({ ...area, page: index + 1 }));
  await as('service_role');
  for (const index of [manyNotices, manyModels, manyRooms, manyRefs]) {
    await assert.rejects(publish(index), invalid);
  }
});

test('an aged publication stops being readable even with all source permissions allowed', async () => {
  await as('service_role');
  await publish(fixture());
  await db.exec('reset role');
  const expired = fixture(new Date(Date.now() - 73 * hourMs));
  await db.query('update private.notice_search_index set index_value = $1', [JSON.stringify(expired)]);
  await as('authenticated', users.verified);
  assert.equal(await read(), null);
});
