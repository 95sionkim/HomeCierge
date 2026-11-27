// 합성 수집본과 PGlite에서 납부 일정 저장 및 사용자별 자금 조회를 검사한다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { createBe03Db } from './helpers/be03-db.mjs';

const fixture = readFileSync(new URL('../fixtures/ingestion-v0.json', import.meta.url), 'utf8');
const input = JSON.parse(fixture).request;
const declaredTarget = { noticeSource: input.noticeSource, ...input.target };
const modelNo = '01';
const houseType = '084.0000A';
const firstRoom = '101동 101호';
const secondRoom = '101동 102호';
const proof = { document: 'synthetic-notice-pdf', version: 'synthetic-v1', page: 7 };
const revisedProof = { document: 'synthetic-revision-pdf', version: 'synthetic-v2', page: 8 };
const ownerConditions = { ingestion_target: declaredTarget, budget_max_won: '750000000' };
const relevantSources = ['applyhome_apt', 'applyhome_apt_model', 'applyhome_notice_pdf'];
const forbidden = { code: '42501' };
const invalid = { code: '22023' };
const conflict = { code: '23505' };
const notFound = { code: 'PT404' };
let db;
let result;

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function as(role, userId = '', anonymous = false) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub',$1,false),
    set_config('request.jwt.claims',$2,false)`, [userId, JSON.stringify({ sub: userId, is_anonymous: anonymous })]);
  await db.exec(`set role ${role}`);
}

async function analysis({ userId, conditions = ownerConditions, noticeId = null } = {}) {
  await db.exec('reset role');
  if (!userId) {
    userId = randomUUID();
    await db.query('insert into auth.users(id,confirmed_at) values ($1,now())', [userId]);
  }
  const chat = await one("insert into public.chats(user_id,title) values ($1,'합성 대화') returning id", [userId]);
  const row = await one(`insert into public.analyses(user_id,chat_id,conditions_snapshot,notice_id)
    values ($1,$2,$3,$4) returning id`, [userId, chat.id, JSON.stringify(conditions), noticeId]);
  return { userId, analysisId: row.id };
}

function fixtureSchedules() {
  return [
    { modelNo, houseType, room: firstRoom, item: 'sale_price', status: 'confirmed', totalWon: '700000000',
      reasons: [], evidence: [proof], installments: [
        { stage: 'deposit', won: '70000000', timing: { trigger: 'contract_signing', dateStatus: 'exact',
          date: '2026-10-23', evidence: [{ ...proof, page: 2 }, proof] } },
        { stage: 'balance', won: '630000000', timing: { trigger: 'deadline', dateStatus: 'exact',
          date: '2026-11-30', evidence: [proof] } },
      ] },
    { modelNo, houseType, room: firstRoom, item: 'required_options', status: 'confirmed', totalWon: '10000000',
      reasons: [], evidence: [{ ...proof, page: 8 }], installments: [
        { stage: 'balance', won: '10000000', timing: { trigger: 'move_in', dateStatus: 'relative', date: null, evidence: [] } },
      ] },
    { modelNo, houseType, room: secondRoom, item: 'sale_price', status: 'confirmed', totalWon: '720000000',
      reasons: [], evidence: [proof], installments: [
        { stage: 'balance', won: '720000000', timing: { trigger: null, dateStatus: 'missing', date: null, evidence: [] } },
      ] },
    { modelNo, houseType, room: secondRoom, item: 'required_options', status: 'unverified', totalWon: null,
      reasons: ['payment_evidence_missing'], evidence: [], installments: [] },
  ];
}

function heldSchedule(schedule, overrides = {}) {
  return { ...schedule, status: 'conflict', totalWon: null, installments: [], reasons: ['payment_scope_unverified'], ...overrides };
}

function addRevision(snapshot) {
  snapshot.catalog.documents.push({ ...snapshot.catalog.documents[0], id: revisedProof.document, version: revisedProof.version, records: 1 });
}

function holdSubtotal(room, reason) {
  room.status = 'held';
  room.subtotal = { ...room.subtotal, status: 'held', won: null, reasons: [reason], documents: [] };
}

async function save(owner, { key = randomUUID(), request = input, snapshot = result, schedules = fixtureSchedules() } = {}) {
  const params = [owner.userId, owner.analysisId, key, JSON.stringify(request), JSON.stringify(snapshot), JSON.stringify(schedules)];
  return (await one('select public.save_funding_schedule_snapshot($1,$2,$3,$4,$5,$6) as id', params)).id;
}

async function saveLegacy(owner, key = randomUUID()) {
  return (await one('select public.save_ingestion_snapshot($1,$2,$3,$4,$5) as id',
    [owner.userId, owner.analysisId, key, JSON.stringify(input), JSON.stringify(result)])).id;
}

async function read(owner, snapshotId, room = firstRoom, model = modelNo) {
  return (await one('select public.read_analysis_funding_inputs($1,$2,$3,$4) as value',
    [owner.analysisId, snapshotId, model, room])).value;
}

async function addFunds(owner, amount = '9223372036854775807') {
  const { id } = await one(`insert into public.funding_entries(user_id,analysis_id,kind,amount_won,available_on,certainty,note)
    values ($1,$2,'current',$3,'2026-10-20','confirmed','계정 합성 메모') returning id`, [owner.userId, owner.analysisId, amount]);
  return { id, kind: 'current', amountWon: amount, availableOn: '2026-10-20', certainty: 'confirmed' };
}

async function assertNoCapture(owner, key) {
  assert.equal((await one(`select count(*)::int as count from public.analysis_input_snapshots
    where analysis_id = $1 and capture_key = $2`, [owner.analysisId, key])).count, 0);
}

test('fund entry retries stay unique per owner and analysis while legacy inputs and precise won are preserved', async () => {
  const a = await analysis(), b = await analysis(), another = await analysis({userId:a.userId}), key = randomUUID();
  const insert = target => db.query(`insert into public.funding_entries
    (user_id,analysis_id,kind,amount_won,available_on,certainty,request_key)
    values ($1,$2,'additional',9007199254740993,'2026-10-20','expected',$3) returning id,amount_won::text as won`,
    [target.userId,target.analysisId,key]);
  await as('authenticated',a.userId);
  const first = (await insert(a)).rows[0];
  assert.equal(first.won, '9007199254740993');
  await assert.rejects(insert(a), conflict);
  assert.ok((await insert(another)).rows[0].id);
  await assert.rejects(db.query('update public.funding_entries set request_key=null where id=$1',[first.id]), forbidden);
  await as('authenticated',b.userId);
  assert.equal((await db.query('select id from public.funding_entries where request_key=$1',[key])).rows.length, 0);
  assert.ok((await insert(b)).rows[0].id);
  await addFunds(b);
});

before(async () => {
  const command = ['import json, sys', 'sys.path.insert(0, "scripts")',
    'from replay_ingestion import loads_source_json, replay',
    'print(json.dumps(replay(loads_source_json(sys.stdin.read())), ensure_ascii=False))'].join('\n');
  result = JSON.parse(execFileSync('python3', ['-B', '-c', command],
    { cwd: new URL('../../', import.meta.url), input: fixture, encoding: 'utf8' }));
  db = await createBe03Db();
  await db.exec(`alter table auth.users add column confirmed_at timestamptz,
    add column is_anonymous boolean not null default false,
    add column banned_until timestamptz, add column deleted_at timestamptz`);
});

after(async () => { await db?.close(); });

test('the public RPCs run as invokers with explicitly scoped private execution', async () => {
  await db.exec('reset role');
  const { rows } = await db.query(`select n.nspname as schema, p.proname as name, p.prosecdef as definer,
    has_function_privilege('anon',p.oid,'execute') as anon,
    has_function_privilege('authenticated',p.oid,'execute') as authenticated,
    has_function_privilege('service_role',p.oid,'execute') as service_role
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private') and p.proname in ('read_analysis_funding_inputs','save_funding_schedule_snapshot')
    order by n.nspname,p.proname`);
  assert.deepEqual(rows, [
    { schema: 'private', name: 'read_analysis_funding_inputs', definer: true, anon: false, authenticated: true, service_role: false },
    { schema: 'private', name: 'save_funding_schedule_snapshot', definer: true, anon: false, authenticated: false, service_role: true },
    { schema: 'public', name: 'read_analysis_funding_inputs', definer: false, anon: false, authenticated: true, service_role: false },
    { schema: 'public', name: 'save_funding_schedule_snapshot', definer: false, anon: false, authenticated: false, service_role: true },
  ]);
});

test('a service capture is atomic, immutable and idempotent over the full payload', async () => {
  const owner = await analysis();
  const key = randomUUID();
  await as('authenticated', owner.userId);
  await assert.rejects(save(owner, { key }), forbidden);
  await as('anon');
  await assert.rejects(save(owner, { key }), forbidden);

  await as('service_role');
  const [snapshotId, retryId] = await Promise.all([save(owner, { key }), save(owner, { key })]);
  assert.equal(snapshotId, retryId);
  const changed = fixtureSchedules();
  changed[0].installments[0].timing = { trigger: null, dateStatus: 'missing', date: null, evidence: [] };
  await assert.rejects(save(owner, { key, schedules: changed }), conflict);
  await assert.rejects(save(owner, { key, request: { ...input, pageSize: 3 } }), conflict);
  const snapshot = structuredClone(result);
  snapshot.tradeBatches[0].record.collectedAt = '2026-11-10T01:00:03Z';
  await assert.rejects(save(owner, { key, snapshot }), conflict);
  await assert.rejects(db.query('select schedules from private.analysis_funding_schedule_snapshots'), forbidden);
  await assert.rejects(db.query("update private.analysis_funding_schedule_snapshots set schedules = '[]'"), forbidden);
  await assert.rejects(read(owner, snapshotId), forbidden);
  assert.equal(await save(owner, { key }), snapshotId);

  await as('authenticated', owner.userId);
  await assert.rejects(db.query('select schedules from private.analysis_funding_schedule_snapshots'), forbidden);
  assert.deepEqual((await read(owner, snapshotId)).schedules, fixtureSchedules().slice(0, 2));

  await db.exec('reset role');
  await db.query('delete from public.analyses where id = $1', [owner.analysisId]);
  assert.equal(await one('select id from public.analysis_input_snapshots where id = $1', [snapshotId]), undefined);
  assert.equal(await one('select snapshot_id from private.analysis_funding_schedule_snapshots where snapshot_id = $1', [snapshotId]), undefined);
});

test('a funding capture cannot use a run ID to bypass the analysis-run lease', async () => {
  const owner = await analysis();
  await as('authenticated', owner.userId);
  const { run } = await one('select public.enqueue_analysis_run($1,$2,$3) as run',
    [owner.analysisId, randomUUID(), '{"kind":"synthetic","fixture":"ingestion-v0"}']);
  await as('service_role');
  await assert.rejects(save(owner, { key: run.runId }), { ...forbidden, message: 'analysis_run_fence_required' });
  await assertNoCapture(owner, run.runId);
});

test('malformed and ungrounded schedules roll back the capture and leave its key reusable', async () => {
  const owner = await analysis();
  await as('service_role');
  const badSchedules = [
    ['raw header text', (s) => { s[0].installments[0].timing.text = '합성 문구'; }],
    ['extra raw payload', (s) => { s[3].reasons.push({ rawPdf: 'synthetic' }); }],
    ['unbounded reason code', (s) => { s[3].reasons.push('x'.repeat(81)); }],
    ['null field omitted', (s) => { delete s[3].totalWon; }],
    ['duplicate item', (s) => { s.push(s[0]); }],
    ['unknown model', (s) => { s[0].modelNo = '99'; }],
    ['invalid model in held scope', (s) => { s[3].modelNo = 'synthetic-model'; }],
    ['model scope exceeds 20 digits', (s) => { s[3].modelNo = '1'.repeat(21); }],
    ['wrong house type', (s) => { s[0].houseType = '099.0000A'; }],
    ['unknown room', (s) => { s[0].room = '103동 101호'; }],
    ['held room has surrounding whitespace', (s) => { s[3].room = ` ${secondRoom}`; }],
    ['held room exceeds 120 UTF-16 units', (s) => { s[3].room = '😀'.repeat(61); }],
    ['held house type has no label', (s) => { s[3].houseType = '\u00a0'; }],
    ['held schedule cites an unknown version', (s) => { s[3].evidence = [{ ...proof, version: 'unregistered' }]; }],
    ['wrong item', (s) => { s[0].item = 'supply_area'; }],
    ['wrong price evidence page', (s) => { s[0].evidence = [{ ...proof, page: 8 }]; }],
    ['unaccepted version', (s) => { s[0].evidence = [{ ...proof, version: 'synthetic-v2' }]; }],
    ['zero page', (s) => { s[0].installments[0].timing.evidence = [{ ...proof, page: 0 }]; }],
    ['inexact page through JSON', (s) => { s[0].installments[0].timing.evidence = [{ ...proof, page: 9007199254740992 }]; }],
    ['exact without date evidence', (s) => { s[0].installments[0].timing.evidence = []; }],
    ['wrong calendar date', (s) => { s[0].installments[0].timing.date = '2026-02-29'; }],
    ['date on relative timing', (s) => { s[1].installments[0].timing.date = '2026-10-23'; }],
    ['numeric amount', (s) => { s[0].installments[0].won = 70000000; }],
    ['decimal fractional won', (s) => { s[0].installments[0].won = '70000000.00'; }],
    ['exceeds precision', (s) => { s[0].installments[0].won = '9'.repeat(21); }],
    ['wrong installment sum', (s) => { s[0].installments[1].won = '629999999'; }],
    ['total conflicts with checked price', (s) => { s[0].totalWon = '699999999'; s[0].installments[1].won = '629999999'; }],
    ['amount in held item', (s) => { s[3].totalWon = '0'; }],
  ];
  const key = randomUUID();
  for (const [label, edit] of badSchedules) {
    const schedules = fixtureSchedules();
    edit(schedules);
    await assert.rejects(save(owner, { key, schedules }), invalid, label);
    await assertNoCapture(owner, key);
  }
  for (const schedules of [null, { schedules: [] }, [1]]) {
    await assert.rejects(save(owner, { key, schedules }), invalid);
  }
  await assertNoCapture(owner, key);
  assert.match(await save(owner, { key }), /^[0-9a-f-]{36}$/);
});

test('a checked item survives the other item being held and preserves precise, repeated installments', async () => {
  const owner = await analysis();
  const snapshot = structuredClone(result);
  snapshot.catalog.rooms[1].salePrice.won = '99999999999999999999';
  const schedules = fixtureSchedules();
  const large = schedules[2];
  large.totalWon = '99999999999999999999';
  large.installments = ['9007199254740993', '99990992800745259006'].map(won =>
    ({ stage: 'interim', won, timing: { trigger: null, dateStatus: 'missing', date: null, evidence: [] } }));
  await as('service_role');
  const snapshotId = await save(owner, { snapshot, schedules });
  await as('authenticated', owner.userId);
  assert.deepEqual(await read(owner, snapshotId, secondRoom), {
    analysisId: owner.analysisId, snapshotId, modelNo, room: secondRoom, dataOrigin: 'synthetic', scheduleStatus: 'available',
    schedules: schedules.slice(2), funds: [],
  });
});

test('a checked zero for required options has no installments', async () => {
  const owner = await analysis();
  const snapshot = structuredClone(result);
  snapshot.catalog.rooms[0].requiredOptions.won = '0';
  snapshot.catalog.rooms[0].subtotal.won = '700000000';
  const [, options] = fixtureSchedules();
  options.totalWon = '0';
  options.installments = [];
  await as('service_role');
  const snapshotId = await save(owner, { snapshot, schedules: [options] });
  await as('authenticated', owner.userId);
  assert.deepEqual((await read(owner, snapshotId)).schedules, [options]);
  assert.equal((await read(owner, snapshotId, secondRoom)).scheduleStatus, 'unavailable');
});

test('nonofficial versions and conflicting room application cannot ground confirmed schedules', async () => {
  const owner = await analysis();
  await as('service_role');
  for (const source of ['upload', 'unknown']) {
    const snapshot = structuredClone(result);
    snapshot.catalog.documents[0].source = source;
    await assert.rejects(save(owner, { snapshot }), invalid);
  }
  const otherRound = structuredClone(result);
  otherRound.catalog.documents[0].edition = 'different-round';
  await assert.rejects(save(owner, { snapshot: otherRound }), invalid);

  const noModelObservation = structuredClone(result);
  noModelObservation.catalog.housingTypes[0].evidence = [];
  await assert.rejects(save(owner, { snapshot: noModelObservation }), invalid);

  const duplicatedApplication = structuredClone(result);
  const { housingTypes, rooms } = duplicatedApplication.catalog;
  housingTypes.push({ ...housingTypes[0], modelNo: '02', evidence: [] });
  rooms.push({ ...rooms[0], modelNo: '02' });
  await assert.rejects(save(owner, { snapshot: duplicatedApplication }), invalid);

  const snapshot = structuredClone(result);
  holdSubtotal(snapshot.catalog.rooms[0], 'house_type_mismatch');
  await assert.rejects(save(owner, { snapshot }), invalid);

  const held = heldSchedule(fixtureSchedules()[0]);
  const snapshotId = await save(owner, { snapshot, schedules: [held] });
  await as('authenticated', owner.userId);
  assert.equal((await read(owner, snapshotId)).scheduleStatus, 'selection_unverified');
  assert.deepEqual((await read(owner, snapshotId)).schedules, []);
});

test('a PDF housing-type conflict with zero catalog rooms remains captured as held evidence', async () => {
  const owner = await analysis();
  const snapshot = structuredClone(result);
  snapshot.catalog.rooms = [];
  const schedules = fixtureSchedules().map(row => heldSchedule(row, { houseType: '085.0000B', evidence: [proof] }));
  const key = randomUUID();
  await as('service_role');
  const snapshotId = await save(owner, { key, snapshot, schedules });
  assert.equal(await save(owner, { key, snapshot, schedules }), snapshotId);
  await assert.rejects(save(owner, { key, snapshot, schedules: schedules.slice(0, 1) }), conflict);
  await db.exec('reset role');
  assert.deepEqual((await one(`select schedules from private.analysis_funding_schedule_snapshots where snapshot_id = $1`,
    [snapshotId])).schedules, schedules);
  await as('authenticated', owner.userId);
  const funds = [await addFunds(owner, '123')];
  assert.deepEqual(await read(owner, snapshotId), { analysisId: owner.analysisId, snapshotId, modelNo, room: firstRoom,
    dataOrigin: 'synthetic', scheduleStatus: 'selection_unverified', schedules: [], funds });
});

test('held revisions can coexist by housing type while another room keeps only its verified type', async () => {
  const owner = await analysis();
  const snapshot = structuredClone(result);
  addRevision(snapshot);
  holdSubtotal(snapshot.catalog.rooms[0], 'house_type_mismatch');
  const [sale, options, independentSale, independentOptions] = fixtureSchedules();
  const originalHolds = [sale, options].map(row => heldSchedule(row));
  const revisedHolds = [sale, options, independentOptions].map(row =>
    heldSchedule(row, { houseType: '085.0000B', evidence: [revisedProof] }));
  const schedules = [...originalHolds, ...revisedHolds, independentSale];
  const key = randomUUID();
  await as('service_role');
  await assert.rejects(save(owner, { key, snapshot, schedules: [...schedules, revisedHolds[0]] }), invalid);
  await assertNoCapture(owner, key);
  const snapshotId = await save(owner, { key, snapshot, schedules });
  await as('authenticated', owner.userId);
  assert.deepEqual((await read(owner, snapshotId)).schedules, []);
  assert.equal((await read(owner, snapshotId)).scheduleStatus, 'selection_unverified');
  assert.deepEqual((await read(owner, snapshotId, secondRoom)).schedules, [independentSale]);
  assert.equal((await read(owner, snapshotId, secondRoom)).scheduleStatus, 'available');
});

test('disjoint accepted item versions remain independently confirmed when BE-02 holds the subtotal', async () => {
  const owner = await analysis({ conditions: { ...ownerConditions, comparison: { modelNo, room: firstRoom, subtotalWon: '0' } } });
  const snapshot = structuredClone(result);
  addRevision(snapshot);
  const room = snapshot.catalog.rooms[0];
  holdSubtotal(room, 'subtotal_documents_differ');
  room.requiredOptions.evidence = [{ ...revisedProof, evidenceIndex: 1 }];
  const [sale, options] = fixtureSchedules();
  const schedules = [sale, { ...options, evidence: [revisedProof] }];
  await as('service_role');
  await assert.rejects(save(owner, { snapshot, schedules: [sale, options] }), invalid);
  const snapshotId = await save(owner, { snapshot, schedules });
  await as('authenticated', owner.userId);
  const output = await read(owner, snapshotId);
  assert.deepEqual(output, { analysisId: owner.analysisId, snapshotId, modelNo, room: firstRoom, dataOrigin: 'synthetic',
    scheduleStatus: 'available', schedules, funds: [] });
});

test('an exact date uses the same checked versions as its item amount', async () => {
  const owner = await analysis();
  const snapshot = structuredClone(result);
  const revised = { ...proof, version: 'synthetic-v2' };
  snapshot.catalog.documents.push({ ...snapshot.catalog.documents[0], version: revised.version, records: 1 });
  const [sale] = fixtureSchedules();
  sale.installments[0].timing.evidence.push(revised);
  await as('service_role');
  await assert.rejects(save(owner, { snapshot, schedules: [sale] }), {
    ...invalid, message: 'funding_installment_document_mismatch',
  });

  snapshot.catalog.rooms[0].salePrice.evidence.push({ ...revised, evidenceIndex: 5 });
  sale.evidence = [proof, revised];
  sale.installments[1].timing.evidence.push(revised);
  const snapshotId = await save(owner, { snapshot, schedules: [sale] });
  await as('authenticated', owner.userId);
  assert.deepEqual((await read(owner, snapshotId)).schedules, [sale]);
});

test('the RPC enforces verified ownership and returns every exact fund scoped to the analysis', async () => {
  const owner = await analysis();
  const sibling = await analysis({ userId: owner.userId });
  const stranger = await analysis();
  await as('service_role');
  const snapshotId = await save(owner);
  const siblingId = await save(sibling);
  await as('authenticated', owner.userId);
  const current = await addFunds(owner);
  await addFunds(sibling, '99');
  await db.query(`insert into public.funding_entries(user_id,analysis_id,kind,amount_won,available_on,certainty,note)
    select $1,$2,'additional',n,'2026-11-30'::date + n,'expected','일괄 합성 메모' from generate_series(1,120) as n`,
  [owner.userId, owner.analysisId]);
  const outputs = await read(owner, snapshotId);
  assert.deepEqual(outputs.funds[0], current);
  assert.equal(outputs.funds.length, 121);
  assert.deepEqual(outputs.funds.slice(1).map(({ id, ...fund }) => fund),
    Array.from({ length: 120 }, (_, i) => ({ kind: 'additional', amountWon: String(i + 1),
      availableOn: new Date(Date.UTC(2026, 10, 31 + i)).toISOString().slice(0, 10), certainty: 'expected' })));
  await db.query('update public.funding_entries set amount_won = $1 where id = $2', ['9007199254740993', current.id]);
  assert.equal((await read(owner, snapshotId)).funds[0].amountWon, '9007199254740993');
  await assert.rejects(read(owner, siblingId), notFound);
  await assert.rejects(read(owner, randomUUID()), notFound);
  await as('authenticated', stranger.userId);
  await assert.rejects(read(owner, snapshotId), notFound);
  await as('authenticated', owner.userId, true);
  await assert.rejects(read(owner, snapshotId), forbidden);
  await as('authenticated', randomUUID());
  await assert.rejects(read(owner, snapshotId), forbidden);
  await as('anon');
  await assert.rejects(read(owner, snapshotId), forbidden);

  for (const flag of ['confirmed_at = null', 'is_anonymous = true', 'banned_until = now() + interval \'1 day\'', 'deleted_at = now()']) {
    await db.exec('reset role');
    await db.query(`update auth.users set ${flag} where id = $1`, [owner.userId]);
    await as('authenticated', owner.userId);
    await assert.rejects(read(owner, snapshotId), forbidden, flag);
    await db.exec('reset role');
    await db.query(`update auth.users set confirmed_at = now(),is_anonymous = false,banned_until = null,deleted_at = null where id = $1`,
      [owner.userId]);
  }
});

test('empty and legacy captures retain own funds and never accept a schedule backfill', async () => {
  const owner = await analysis({ conditions: {} });
  const key = randomUUID();
  await as('service_role');
  const legacyId = await saveLegacy(owner, key);
  assert.equal(await save(owner, { key, schedules: [] }), legacyId);
  await assert.rejects(save(owner, { key }), conflict);
  const emptyId = await save(owner, { schedules: [] });
  await as('authenticated', owner.userId);
  const current = await addFunds(owner, '1000');
  for (const id of [legacyId, emptyId]) {
    const output = await read(owner, id);
    assert.equal(output.scheduleStatus, 'unavailable');
    assert.deepEqual(output.schedules, []);
    assert.deepEqual(output.funds, [current]);
  }
});

test('unresolved or stale selection holds only the schedule and honors explicit analysis conditions', async () => {
  const declared = { ...ownerConditions, comparison: { modelNo, room: firstRoom }, housingType: { modelNo }, room: firstRoom };
  const owner = await analysis({ conditions: declared });
  const unspecified = await analysis({ conditions: {} });
  await db.exec("insert into public.source_registry(id,display_name) values ('synthetic','합성 카탈로그')");
  const notice = await one(`insert into public.notices(source_id,external_id,title,notice_kind,collected_at)
    values ('synthetic','synthetic-legacy-notice','합성 공고','unknown',now()) returning id`);
  const conflicted = await analysis({ conditions: declared, noticeId: notice.id });
  await as('service_role');
  const unresolvedId = await save(unspecified);
  const conflictingId = await save(conflicted);
  const snapshotId = await save(owner);
  for (const [subject, id] of [[unspecified, unresolvedId], [conflicted, conflictingId]]) {
    await as('authenticated', subject.userId);
    assert.equal((await read(subject, id)).scheduleStatus, 'selection_unverified');
  }

  await as('authenticated', owner.userId);
  const current = await addFunds(owner, '4000');
  assert.equal((await read(owner, snapshotId)).scheduleStatus, 'available');
  for (const [room, model] of [[null, modelNo], [firstRoom, null], [firstRoom, '1'], [firstRoom, '99'], [secondRoom, modelNo]]) {
    const output = await read(owner, snapshotId, room, model);
    assert.equal(output.scheduleStatus, 'selection_unverified');
    assert.deepEqual(output.schedules, []);
    assert.deepEqual(output.funds, [current]);
  }

  for (const [conditions, status] of [
    [{ ...declared, budget_max_won: '100000000' }, 'available'],
    [{ ...declared, room: secondRoom }, 'selection_unverified'],
    [{ ...declared, comparison: { modelNo: '99' } }, 'selection_unverified'],
    [{ ...declared, housingType: { modelNo: '99' } }, 'selection_unverified'],
    [{ ...declared, ingestion_target: { ...declaredTarget, edition: 'different-round' } }, 'selection_unverified'],
  ]) {
    await as('service_role');
    await db.query('update public.analyses set conditions_snapshot = $1 where id = $2', [JSON.stringify(conditions), owner.analysisId]);
    await as('authenticated', owner.userId);
    const output = await read(owner, snapshotId);
    assert.equal(output.scheduleStatus, status);
    assert.deepEqual(output.funds, [current]);
  }
});

test('a supplied selection follows the route bounds without changing model numbers or Unicode labels', async () => {
  const owner = await analysis();
  await as('service_role');
  const snapshotId = await save(owner);
  await as('authenticated', owner.userId);
  for (const [room, model] of [
    [firstRoom, ''], [firstRoom, '1'.repeat(21)], [firstRoom, '01\n'], ['', modelNo],
    [`\u00a0${firstRoom}`, modelNo], [`${firstRoom}\u3000`, modelNo], [`101\u0085호`, modelNo], ['😀'.repeat(61), modelNo],
  ]) {
    await assert.rejects(read(owner, snapshotId, room, model), invalid);
  }
  const label = '😀'.repeat(60);
  const output = await read(owner, snapshotId, label, '0'.repeat(20));
  assert.equal(output.scheduleStatus, 'selection_unverified');
  assert.equal(output.room, label);
  assert.equal(output.modelNo, '0'.repeat(20));
});

test('collected schedules require permitted relevant sources and preserve funds after revocation', async () => {
  const owner = await analysis();
  const snapshot = { ...result, dataOrigin: 'collected' };
  const key = randomUUID();
  await as('service_role');
  await assert.rejects(save(owner, { key, snapshot }), forbidden);
  await assertNoCapture(owner, key);
  // 레지스트리 권한 분기를 실행하기 위한 합성 행이다.
  await db.query(`insert into public.source_registry(id,display_name,storage_permission,reuse_permission,display_permission)
    select id,'합성 출처','allowed','allowed','allowed' from unnest($1::text[]) as source(id)`,
  [[...relevantSources, 'apt_trade', 'apt_rights', 'user_upload']]);

  for (const [source, field, restricted, allowed] of [
    ['applyhome_apt', 'storage_permission', 'denied', 'allowed'],
    ['applyhome_apt_model', 'reuse_permission', 'unknown', 'allowed'],
    ['applyhome_notice_pdf', 'display_permission', 'denied', 'allowed'],
    ['applyhome_notice_pdf', 'retention_days', 30, null],
  ]) {
    await db.query(`update public.source_registry set ${field} = $1 where id = $2`, [restricted, source]);
    await assert.rejects(save(owner, { key, snapshot }), forbidden);
    await assertNoCapture(owner, key);
    await db.query(`update public.source_registry set ${field} = $1 where id = $2`, [allowed, source]);
  }

  const uploaded = structuredClone(snapshot);
  uploaded.catalog.documents[0].source = 'upload';
  await assert.rejects(save(owner, { key, snapshot: uploaded }), { ...forbidden, message: 'ingestion_upload_binding_required' });
  await assertNoCapture(owner, key);
  const snapshotId = await save(owner, { key, snapshot });
  await db.exec(`update public.source_registry set storage_permission = 'denied',reuse_permission = 'denied',
    display_permission = 'denied',retention_days = 1 where id in ('apt_trade','apt_rights')`);
  await as('authenticated', owner.userId);
  const current = await addFunds(owner, '1234');
  assert.equal((await read(owner, snapshotId)).scheduleStatus, 'available');
  assert.equal((await read(owner, snapshotId)).dataOrigin, 'collected');

  for (const [source, field, restricted] of [
    ['applyhome_apt', 'storage_permission', 'denied'],
    ['applyhome_apt_model', 'reuse_permission', 'denied'],
    ['applyhome_notice_pdf', 'display_permission', 'denied'],
    ['applyhome_notice_pdf', 'retention_days', 1],
  ]) {
    await as('service_role');
    await db.query(`update public.source_registry set ${field} = $1 where id = $2`, [restricted, source]);
    assert.equal(await save(owner, { key, snapshot }), snapshotId);
    await as('authenticated', owner.userId);
    assert.deepEqual(await read(owner, snapshotId), { analysisId: owner.analysisId, snapshotId, modelNo, room: firstRoom,
      dataOrigin: 'collected', scheduleStatus: 'source_restricted', schedules: [], funds: [current] });
    assert.deepEqual(await read(owner, snapshotId, '999동 999호', '99'), { analysisId: owner.analysisId, snapshotId,
      modelNo: '99', room: '999동 999호', dataOrigin: 'collected', scheduleStatus: 'source_restricted', schedules: [], funds: [current] });
    await as('service_role');
    await db.query(`update public.source_registry set ${field} = $1 where id = $2`, [field === 'retention_days' ? null : 'allowed', source]);
  }
});
