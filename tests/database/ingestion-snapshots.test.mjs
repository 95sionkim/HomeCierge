// BE-02의 합성 replay 결과를 실제 SQL 저장 경로에 넣어 검사한다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBe03Db } from './helpers/be03-db.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = JSON.parse(readFileSync(new URL('../fixtures/ingestion-v0.json', import.meta.url), 'utf8'));
const input = bundle.request;
const conditions = { housingType: { modelNo: '01' }, room: '101동 101호', budget_max_won: '750000000' };
const captureSql = 'select public.save_ingestion_snapshot($1, $2, $3, $4, $5) as id';
const relations = [
  'analysis_input_snapshots', 'ingestion_collections', 'ingestion_collection_pages',
  'ingestion_trade_observations', 'ingestion_document_versions',
];

let db;
let ownerA;
let ownerB;
let noticeId;
let housingTypeId;
let result;

function replay(edit = () => {}) {
  const fixture = structuredClone(bundle);
  edit(fixture);
  const json = execFileSync('python3', ['-c', [
    'import json, sys',
    'sys.path.insert(0, "scripts")',
    'from replay_ingestion import loads_source_json, replay',
    'print(json.dumps(replay(loads_source_json(sys.stdin.read())), ensure_ascii=False))',
  ].join('\n')], { cwd: root, encoding: 'utf8', input: JSON.stringify(fixture) });
  return { request: fixture.request, result: JSON.parse(json) };
}

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function setRole(role, userId = null, isAnonymous = false) {
  await db.exec('reset role');
  if (userId !== null) {
    await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)",
      [userId, JSON.stringify({ sub: userId, is_anonymous: isAnonymous })]);
  }
  await db.exec(`set role ${role}`);
}

async function newAnalysis({ selectedNotice = true, conditionsSnapshot = conditions } = {}) {
  const userId = randomUUID();
  await db.query('insert into auth.users(id) values ($1)', [userId]);
  const chat = await one('insert into public.chats(user_id, title) values ($1, $2) returning id', [userId, '합성 대화']);
  const analysis = await one(`insert into public.analyses
    (user_id, chat_id, notice_id, housing_type_id, conditions_snapshot, rules_version)
    values ($1, $2, $3, $4, $5, 'synthetic-rules-1') returning id`,
  [userId, chat.id, selectedNotice ? noticeId : null, selectedNotice ? housingTypeId : null, JSON.stringify(conditionsSnapshot)]);
  return { userId, analysisId: analysis.id };
}

async function save(owner = ownerA, key = randomUUID(), snapshot = result, request = input) {
  return (await one(captureSql, [owner.userId, owner.analysisId, key, JSON.stringify(request), JSON.stringify(snapshot)])).id;
}

function edited(fn) {
  const snapshot = structuredClone(result);
  fn(snapshot);
  return snapshot;
}

async function allowSyntheticSources() {
  // 권한 분기만 시험하는 레지스트리 행이다. 실제 출처의 저장 허용을 의미하지 않는다.
  await db.exec(`insert into public.source_registry(id, display_name, storage_permission) values
    ('applyhome_apt', '합성 공고 출처', 'allowed'),
    ('applyhome_apt_model', '합성 모델 출처', 'allowed'),
    ('apt_trade', '합성 거래 출처', 'allowed'),
    ('apt_rights', '합성 권리 출처', 'allowed'),
    ('applyhome_notice_pdf', '합성 PDF 출처', 'allowed'),
    ('user_upload', '합성 업로드 출처', 'allowed')
    on conflict (id) do update set storage_permission = 'allowed', retention_days = null`);
}

before(async () => {
  result = replay().result;
  db = await createBe03Db();
  await db.exec("insert into public.source_registry(id, display_name) values ('synthetic', '합성 카탈로그')");
  noticeId = (await one(`insert into public.notices(source_id, external_id, title, notice_kind, collected_at)
    values ('synthetic', 'synthetic-notice', '합성 공고', 'unknown', now()) returning id`)).id;
  housingTypeId = (await one(`insert into public.housing_types(notice_id, external_type_id, label)
    values ($1, '01', '합성 주택형') returning id`, [noticeId])).id;
  ownerA = await newAnalysis();
  ownerB = await newAnalysis();
});

after(async () => { await db?.close(); });

test('a replay capture fixes the exact request, result, and selected analysis inputs', async () => {
  await setRole('service_role');
  const key = randomUUID();
  const id = await save(ownerA, key);
  await db.query(`update public.analyses set conditions_snapshot = $1, rules_version = 'synthetic-rules-2',
    housing_type_id = null where id = $2`, [JSON.stringify({ room: '101동 102호' }), ownerA.analysisId]);
  assert.equal(await save(ownerA, key), id);
  const original = await one(`select user_id, analysis_id, capture_key, input_snapshot, result_snapshot,
    conditions_snapshot, rules_version, notice_id, housing_type_id, as_of::text from public.analysis_input_snapshots
    where id = $1`, [id]);
  assert.deepEqual(original, {
    user_id: ownerA.userId, analysis_id: ownerA.analysisId, capture_key: key,
    input_snapshot: input, result_snapshot: result, conditions_snapshot: conditions,
    rules_version: 'synthetic-rules-1', notice_id: noticeId, housing_type_id: housingTypeId, as_of: input.asOf,
  });
  const secondId = await save();
  assert.notEqual(secondId, id);
  assert.deepEqual(await one(`select conditions_snapshot, rules_version, housing_type_id
    from public.analysis_input_snapshots where id = $1`, [secondId]), {
    conditions_snapshot: { room: '101동 102호' }, rules_version: 'synthetic-rules-2', housing_type_id: null,
  });
});

test('owner and key scope allow identical retries and reject a change to either input or result', async () => {
  await setRole('service_role');
  const key = randomUUID();
  const [first, retry] = await Promise.all([save(ownerA, key), save(ownerA, key)]);
  assert.equal(first, retry);
  const sameKeyOtherOwner = await save(ownerB, key);
  assert.notEqual(sameKeyOtherOwner, first);
  const differentObservation = edited(snapshot => { snapshot.tradeBatches[0].record.collectedAt = '2026-11-10T01:00:03Z'; });
  await assert.rejects(save(ownerA, key, differentObservation), { code: '23505', message: 'ingestion_capture_conflict' });
  await assert.rejects(save(ownerA, key, result, { ...input, pageSize: 3 }), { code: '23505', message: 'ingestion_capture_conflict' });
  assert.equal(await save(ownerA, key), first);
});

test('the declared analysis target binds all four identity fields and freezes them at first capture', async () => {
  const target = { noticeSource: input.noticeSource, ...input.target };
  const declared = { ...conditions, ingestion_target: target };
  await db.exec('reset role');
  const owner = await newAnalysis({ conditionsSnapshot: declared });
  await setRole('service_role');
  const key = randomUUID();
  const id = await save(owner, key);
  const mismatch = { code: '22023', message: 'ingestion_analysis_target_mismatch' };
  for (const [field, value] of Object.entries({
    noticeSource: 'applyhome_remainder', houseManageNo: '9900000999', noticeNo: '9900000998', edition: 'synthetic-edition-2',
  })) {
    await db.query('update public.analyses set conditions_snapshot = $1 where id = $2',
      [JSON.stringify({ ingestion_target: { ...target, [field]: value } }), owner.analysisId]);
    await assert.rejects(save(owner), mismatch, field);
  }
  await db.query('update public.analyses set conditions_snapshot = $1 where id = $2',
    [JSON.stringify({ ingestion_target: null }), owner.analysisId]);
  await assert.rejects(save(owner), mismatch);
  assert.equal(await save(owner, key), id);
  assert.deepEqual(await one('select target_binding_status, conditions_snapshot from public.analysis_input_snapshots where id = $1', [id]), {
    target_binding_status: 'matched', conditions_snapshot: declared,
  });
});

test('legacy and untargeted analyses can retain observations while their selected housing evidence is unavailable', async () => {
  await db.exec('reset role');
  const untargeted = await newAnalysis({ selectedNotice: false, conditionsSnapshot: {} });
  await setRole('service_role');
  const partial = replay(fixture => {
    fixture.pages = fixture.pages.filter(page => page.source !== 'applyhome_apt_model');
  });
  const legacyId = await save(ownerB, randomUUID(), partial.result, partial.request);
  const draftId = await save(untargeted);
  assert.deepEqual(await one(`select target_binding_status, housing_type_id, conditions_snapshot->>'room' as room,
    result_snapshot#>>'{catalog,housingTypesStatus}' as model_status
    from public.analysis_input_snapshots where id = $1`, [legacyId]), {
    target_binding_status: 'unverified', housing_type_id: housingTypeId, room: conditions.room, model_status: 'lookup_failed',
  });
  assert.equal((await one('select count(*)::int as n from public.ingestion_trade_observations where snapshot_id = $1', [legacyId])).n, 5);
  assert.equal((await one('select target_binding_status from public.analysis_input_snapshots where id = $1', [draftId])).target_binding_status,
    'unspecified');
});

test('distinct positions preserve duplicate values and link collection, page, trade, and document views', async () => {
  await setRole('service_role');
  const data = replay(fixture => {
    const rows = fixture.pages.find(page => page.source === 'apt_trade' && page.page === 1).body.response.body.items.item;
    rows[1] = structuredClone(rows[0]);
    const [last] = fixture.pages.find(page => page.source === 'apt_trade' && page.page === 2).body.response.body.items.item;
    last.dealAmount = '9,999,999,999,999,999';
    last.excluUseAr = '84.000000000000000001';
  });
  const id = await save(ownerA, randomUUID(), data.result, data.request);
  const collection = await one(`select collection_kind, source_id, request_region_code, contract_month::text, status,
    pages_expected, missing_pages, rows_received::int from public.ingestion_collections
    where snapshot_id = $1 and source_id = 'apt_trade'`, [id]);
  assert.deepEqual(collection, {
    collection_kind: 'trade', source_id: 'apt_trade', request_region_code: '99999', contract_month: '2026-10-01',
    status: 'complete', pages_expected: 2, missing_pages: [], rows_received: 3,
  });
  const pages = await db.query(`select page, page_status from public.ingestion_collection_pages
    where snapshot_id = $1 and source_id = 'apt_trade' order by page`, [id]);
  assert.deepEqual(pages.rows, [{ page: 1, page_status: 'received' }, { page: 2, page_status: 'received' }]);
  const observations = await db.query(`select page, row_position, contract_date::text, amount_won,
    exclusive_area_m2, supply_area_m2, disposition from public.ingestion_trade_observations
    where snapshot_id = $1 and source_id = 'apt_trade' and page = 1 order by row_position`, [id]);
  assert.deepEqual(observations.rows, [1, 2].map(row_position => ({
    page: 1, row_position, contract_date: '2026-10-20', amount_won: '515000000',
    exclusive_area_m2: '84.00', supply_area_m2: null, disposition: 'follow_up_required',
  })));
  const exact = await one(`select jsonb_build_object('amount_won',amount_won,'exclusive_area_m2',exclusive_area_m2) as values
    from public.ingestion_trade_observations where snapshot_id = $1 and source_id = 'apt_trade' and page = 2`, [id]);
  assert.deepEqual(exact.values, {
    amount_won: '99999999999999990000', exclusive_area_m2: '84.000000000000000001',
  });
  assert.deepEqual(await one(`select document_id, version, acquisition_source, status
    from public.ingestion_document_versions where snapshot_id = $1`, [id]), {
    document_id: 'synthetic-notice-pdf', version: 'synthetic-v1', acquisition_source: 'official', status: 'accepted',
  });
});

test('the owner can read their upload-derived evidence and clients cannot write a capture', async () => {
  await setRole('service_role');
  const uploaded = replay(fixture => {
    for (const evidence of fixture.evidence) {
      evidence.document.source = 'upload';
      evidence.document.originCheck = 'confirmed';
    }
  });
  const id = await save(ownerA, randomUUID(), uploaded.result, uploaded.request);
  for (const relation of relations) {
    const column = relation === 'analysis_input_snapshots' ? 'id' : 'snapshot_id';
    const query = `select count(*)::int as count from public.${relation} where ${column} = $1`;
    await setRole('authenticated', ownerA.userId);
    assert.ok((await one(query, [id])).count > 0, relation);
    await setRole('authenticated', ownerB.userId);
    assert.equal((await one(query, [id])).count, 0, relation);
    await setRole('authenticated', ownerA.userId, true);
    assert.equal((await one(query, [id])).count, 0, relation);
    await setRole('anon');
    await assert.rejects(one(query, [id]), { code: '42501' });
  }
  await setRole('authenticated', ownerA.userId);
  await assert.rejects(save(), { code: '42501' });
  await assert.rejects(db.query('insert into public.analysis_input_snapshots(user_id) values ($1)', [ownerA.userId]), { code: '42501' });
  await assert.rejects(db.query("update public.analysis_input_snapshots set result_snapshot = '{}'"), { code: '42501' });
  await assert.rejects(db.query('delete from public.analysis_input_snapshots'), { code: '42501' });
  await setRole('service_role');
  await assert.rejects(db.query('delete from public.analysis_input_snapshots'), { code: '42501' });
  await assert.rejects(save({ userId: ownerA.userId, analysisId: ownerB.analysisId }), { code: '23503' });
  const policy = await one(`select prosecdef, proconfig from pg_proc
    where oid = 'public.save_ingestion_snapshot(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure`);
  assert.equal(policy.prosecdef, false);
  assert.ok(policy.proconfig.includes('search_path=""'));
});

test('storage permission for collected input requires each API and a separately approved document source', async () => {
  // 합성 replay를 collected 경로로 흘려보내 권한 분기만 검사한다.
  await setRole('service_role');
  const collected = edited(snapshot => { snapshot.dataOrigin = 'collected'; });
  const key = randomUUID();
  const blocked = { code: '42501', message: 'ingestion_storage_not_allowed' };
  await assert.rejects(save(ownerA, key, collected), blocked);
  await assert.rejects(db.query(`insert into public.analysis_input_snapshots
    (user_id, analysis_id, capture_key, input_snapshot, result_snapshot) values ($1, $2, $3, $4, $5)`,
    [ownerA.userId, ownerA.analysisId, key, JSON.stringify(input), JSON.stringify(collected)]), blocked);
  await allowSyntheticSources();
  await db.exec("update public.source_registry set storage_permission = 'denied' where id = 'applyhome_notice_pdf'");
  await assert.rejects(save(ownerA, key, collected), blocked);
  await db.exec("update public.source_registry set storage_permission = 'allowed' where id = 'applyhome_notice_pdf'");
  await db.exec("update public.source_registry set storage_permission = 'unknown' where id = 'apt_rights'");
  await assert.rejects(save(ownerA, key, collected), blocked);
  await db.exec("update public.source_registry set storage_permission = 'allowed' where id = 'apt_rights'");
  const id = await save(ownerA, key, collected);
  await db.exec("update public.source_registry set storage_permission = 'denied' where id = 'applyhome_notice_pdf'");
  assert.equal(await save(ownerA, key, collected), id);
  await assert.rejects(save(ownerA, randomUUID(), collected), blocked);
});

test('collected uploads are held even when every source permits storage', async () => {
  await setRole('service_role');
  await allowSyntheticSources();
  for (const originCheck of ['confirmed', 'unverified']) {
    const uploaded = replay(fixture => {
      // 공식 근거와 함께 남긴 별도의 업로드 버전이다.
      const record = structuredClone(fixture.evidence[0]);
      Object.assign(record.document, { id: 'synthetic-upload', source: 'upload', originCheck });
      fixture.evidence.push(record);
    });
    const key = randomUUID();
    const collected = { ...uploaded.result, dataOrigin: 'collected' };
    await assert.rejects(save(ownerA, key, collected, uploaded.request), {
      code: '42501', message: 'ingestion_upload_binding_required',
    });
    const id = await save(ownerA, key, uploaded.result, uploaded.request);
    assert.equal((await one(`select acquisition_source from public.ingestion_document_versions
      where snapshot_id = $1 and document_id = 'synthetic-upload'`, [id])).acquisition_source, 'upload');
  }
});

test('a retention limit on any collected source holds the whole new capture', async () => {
  await setRole('service_role');
  await allowSyntheticSources();
  const collected = edited(snapshot => { snapshot.dataOrigin = 'collected'; });
  const key = randomUUID();
  const blocked = { code: '42501', message: 'ingestion_retention_enforcement_required' };
  for (const source of ['applyhome_apt', 'applyhome_apt_model', 'apt_trade', 'apt_rights', 'applyhome_notice_pdf']) {
    await db.query('update public.source_registry set retention_days = 1 where id = $1', [source]);
    await assert.rejects(save(ownerA, key, collected), blocked, source);
    await db.query('update public.source_registry set retention_days = null where id = $1', [source]);
  }
  assert.ok(await save(ownerA, key, collected));
});

test('collection time preserves BE-02 offsets verbatim and rejects invalid calendar or clock values', async () => {
  await setRole('service_role');
  const stamps = {
    applyhome_apt: '2026-11-10T20:00:00+16:00',
    applyhome_apt_model: '2024-02-29T00:00:00-23:59',
    apt_trade: '2026-11-10T23:59:59.123456+23:59',
    apt_rights: '2026-11-10T00:00:00-00:00',
  };
  const captured = replay(fixture => {
    for (const page of fixture.pages) page.observedAt = stamps[page.source];
  });
  const id = await save(ownerA, randomUUID(), captured.result, captured.request);
  const { timestamp_strings } = await one(`select jsonb_object_agg(source_id,collected_at) as timestamp_strings
    from public.ingestion_collections where snapshot_id = $1`, [id]);
  assert.deepEqual(timestamp_strings, stamps);
  const invalid = [
    '0000-11-10T20:00:00Z', '2026-02-29T20:00:00Z', '2026-11-10T24:00:00+16:00', '2026-11-10T20:60:00+16:00',
    '2026-11-10T20:00:60Z', '2026-11-10T20:00:00+24:00', '2026-11-10T20:00:00+16:60',
    '2026-11-10T20:00:00.1234567Z', '2026-11-10T20:00:00', '2026-11-10T20:00:00Z\n',
  ];
  for (const stamp of invalid) {
    const malformed = edited(snapshot => { snapshot.tradeBatches[0].record.collectedAt = stamp; });
    await assert.rejects(save(ownerA, randomUUID(), malformed), { code: '22023' }, JSON.stringify(stamp));
  }
});

test('shape and scope failures leave no snapshot and allow a valid retry of the same key', async () => {
  await setRole('service_role');
  const key = randomUUID();
  const invalid = {
    'different target': snapshot => { snapshot.target.edition = 'different'; },
    'missing month': snapshot => { snapshot.period.months = []; },
    'missing batch': snapshot => { snapshot.tradeBatches.pop(); },
    'wrong row count': snapshot => { snapshot.tradeBatches[0].record.rowsReceived++; },
    'different trade scope': snapshot => { snapshot.tradeBatches[0].trades[0].provenance.request.LAWD_CD = '99998'; },
    'duplicate ordinal': snapshot => { snapshot.tradeBatches[0].trades[1].provenance.position = 1; },
    'raw API body': snapshot => { snapshot.tradeBatches[0].trades[0].body = { SYNTHETIC_RAW_RESPONSE: true }; },
    'nested raw API body': snapshot => { snapshot.catalog.notice.fields.HOUSE_NM.body = { data: [] }; },
    'raw PDF': snapshot => { snapshot.catalog.documents[0].pdfBytes = 'SYNTHETIC_RAW_PDF'; },
    'different document version': snapshot => { snapshot.catalog.rooms[0].salePrice.evidence[0].version = 'different'; },
    'unlinked catalog observation': snapshot => { snapshot.catalog.housingTypes[0].evidence[0].page = 2; },
    'unchecked supply area': snapshot => { snapshot.catalog.housingTypes[0].checkedSupplyArea.evidence = []; },
    'wrong subtotal': snapshot => { snapshot.catalog.rooms[0].subtotal.won = '700000000'; },
  };
  for (const [reason, change] of Object.entries(invalid)) {
    await assert.rejects(save(ownerA, key, edited(change)), { code: '22023' }, reason);
  }
  await assert.rejects(save(ownerA, key, result, { ...input, body: {} }), { code: '22023' });
  assert.equal((await one('select count(*)::int as count from public.analysis_input_snapshots where capture_key = $1', [key])).count, 0);
  assert.ok(await save(ownerA, key));
});

test('deleting an analysis removes its capture and projected upload evidence', async () => {
  await db.exec('reset role');
  const owner = await newAnalysis();
  await setRole('service_role');
  const id = await save(owner);
  await db.exec('reset role');
  await db.query('delete from auth.users where id = $1', [owner.userId]);
  for (const relation of relations) {
    const column = relation === 'analysis_input_snapshots' ? 'id' : 'snapshot_id';
    assert.equal((await one(`select count(*)::int as count from public.${relation} where ${column} = $1`, [id])).count, 0);
  }
});

test('partial, failed, confirmed empty, and undecided date windows remain distinguishable', async () => {
  await setRole('service_role');
  const mixed = replay(fixture => {
    fixture.pages = fixture.pages.filter(page =>
      !(page.source === 'apt_trade' && page.page === 2) && page.source !== 'apt_rights');
  });
  const mixedId = await save(ownerA, randomUUID(), mixed.result, mixed.request);
  assert.deepEqual((await db.query(`select source_id, page, page_status from public.ingestion_collection_pages
    where snapshot_id = $1 and collection_kind = 'trade' order by source_id, page`, [mixedId])).rows, [
    { source_id: 'apt_rights', page: 1, page_status: 'failed' },
    { source_id: 'apt_trade', page: 1, page_status: 'received' },
    { source_id: 'apt_trade', page: 2, page_status: 'missing' },
  ]);
  const empty = replay(fixture => {
    fixture.request.tradeKinds = ['sale'];
    fixture.pages = fixture.pages.filter(page => !(page.source === 'apt_trade' && page.page === 2));
    Object.assign(fixture.pages.find(page => page.source === 'apt_trade').body.response.body,
      { totalCount: 0, items: { item: [] } });
  });
  const emptyId = await save(ownerA, randomUUID(), empty.result, empty.request);
  assert.deepEqual(await one(`select status, rows_received::int from public.ingestion_collections
    where snapshot_id = $1 and collection_kind = 'trade'`, [emptyId]), { status: 'empty', rows_received: 0 });
  const undecided = replay(fixture => {
    fixture.request.asOf = '2028-02-29';
    delete fixture.request.start;
    delete fixture.request.end;
  });
  const undecidedId = await save(ownerA, randomUUID(), undecided.result, undecided.request);
  assert.equal((await one(`select count(*)::int as count from public.ingestion_collections
    where snapshot_id = $1 and collection_kind = 'trade'`, [undecidedId])).count, 0);
});
