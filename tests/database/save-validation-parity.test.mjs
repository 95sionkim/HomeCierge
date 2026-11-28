// 합성 자료(거래·카탈로그·납부 일정·실행 상태)로 집합 연산 기반 저장 검증의 규칙 동등성,
// read_analysis_run_status RPC 경계, 합성 대용량(6,000건 거래·26개 묶음) 저장 경로를 PGlite에서 검증한다.
// 실제 외부 API·PDF 응답이 아닌 합성 테스트 데이터다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBe03Db } from './helpers/be03-db.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = JSON.parse(readFileSync(new URL('../fixtures/ingestion-v0.json', import.meta.url), 'utf8'));
const baseInput = bundle.request;
const baseResult = JSON.parse(execFileSync('python3', ['scripts/replay_ingestion.py', 'tests/fixtures/ingestion-v0.json'], {
  cwd: root,
  encoding: 'utf8',
}));
const baseComparison = JSON.parse(execFileSync('python3', ['scripts/run_analysis_worker.py', '--demo'], {
  cwd: root,
  encoding: 'utf8',
}));

const baseProof = [{ document: 'synthetic-notice-pdf', version: 'synthetic-v1', page: 7 }];
const baseSchedule = {
  modelNo: '01',
  houseType: '084.0000A',
  room: '101동 101호',
  item: 'sale_price',
  status: 'confirmed',
  totalWon: '700000000',
  reasons: [],
  evidence: baseProof,
  installments: [
    { stage: 'deposit', won: '70000000', timing: { trigger: 'contract_signing', dateStatus: 'exact', date: '2026-10-23', evidence: baseProof } },
    { stage: 'interim', won: '420000000', timing: { trigger: 'calendar_date', dateStatus: 'exact', date: '2027-03-23', evidence: baseProof } },
    { stage: 'balance', won: '210000000', timing: { trigger: 'move_in', dateStatus: 'relative', date: null, evidence: [] } },
  ],
};

let db;
let owner;

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function setRole(role, userId = null) {
  await db.exec('reset role');
  if (userId !== null) {
    await db.query(
      "select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)",
      [userId, JSON.stringify({ sub: userId, is_anonymous: false })],
    );
  }
  await db.exec(`set role ${role}`);
}

async function createOwner() {
  await db.exec('reset role');
  const userId = randomUUID();
  await db.query('insert into auth.users(id) values ($1)', [userId]);
  const chat = await one('insert into public.chats(user_id, title) values ($1, $2) returning id', [userId, '합성 저장 검증']);
  const analysis = await one(
    `insert into public.analyses(user_id, chat_id, conditions_snapshot, rules_version)
     values ($1, $2, '{}'::jsonb, 'synthetic-rules-1') returning id`,
    [userId, chat.id],
  );
  return { userId, chatId: chat.id, analysisId: analysis.id };
}

function cloneResult(mutator) {
  const copy = structuredClone(baseResult);
  mutator(copy);
  return copy;
}

async function saveSnapshot(snapshot, input = baseInput) {
  await setRole('service_role');
  return (await one(
    'select public.save_ingestion_snapshot($1, $2, $3, $4, $5) as id',
    [owner.userId, owner.analysisId, randomUUID(), JSON.stringify(input), JSON.stringify(snapshot)],
  )).id;
}

async function saveWithSchedules(schedules, snapshot = baseResult, input = baseInput) {
  await setRole('service_role');
  return (await one(
    'select public.save_funding_schedule_snapshot($1, $2, $3, $4, $5, $6) as id',
    [owner.userId, owner.analysisId, randomUUID(), JSON.stringify(input), JSON.stringify(snapshot), JSON.stringify(schedules)],
  )).id;
}

before(async () => {
  db = await createBe03Db();
  owner = await createOwner();
});

after(async () => {
  await db?.close();
});

test('read_analysis_run_status enforces service_role boundary and reports exact lease/completion state', async () => {
  const fakeRun = randomUUID();
  const fakeToken = randomUUID();

  // anon·authenticated는 호출 자체가 차단된다.
  await setRole('anon');
  await assert.rejects(
    db.query('select public.read_analysis_run_status($1, $2, $3)', [fakeRun, 1, fakeToken]),
    { code: '42501' },
  );
  await setRole('authenticated', owner.userId);
  await assert.rejects(
    db.query('select public.read_analysis_run_status($1, $2, $3)', [fakeRun, 1, fakeToken]),
    { code: '42501' },
  );

  // service_role의 잘못된 인자·미존재 실행은 정확한 코드로 거절한다.
  await setRole('service_role');
  await assert.rejects(
    db.query('select public.read_analysis_run_status($1, $2, $3)', [null, 1, fakeToken]),
    { code: '22023', message: 'invalid_analysis_run_lookup' },
  );
  await assert.rejects(
    db.query('select public.read_analysis_run_status($1, $2, $3)', [fakeRun, 0, fakeToken]),
    { code: '22023', message: 'invalid_analysis_run_lookup' },
  );
  await assert.rejects(
    db.query('select public.read_analysis_run_status($1, $2, $3)', [fakeRun, 1, null]),
    { code: '22023', message: 'invalid_analysis_run_lookup' },
  );
  await assert.rejects(
    db.query('select public.read_analysis_run_status($1, $2, $3)', [fakeRun, 1, fakeToken]),
    { code: 'PT404', message: 'analysis_run_not_found' },
  );

  // 실행 접수 -> 인수 -> 상태 조회(leaseActive true/false) -> 완료 후 상태 조회(finished)
  await setRole('authenticated', owner.userId);
  const queued = (await one(
    'select public.enqueue_analysis_run($1, $2, $3) as value',
    [owner.analysisId, randomUUID(), JSON.stringify({ kind: 'synthetic', fixture: 'ingestion-v0' })],
  )).value;

  await setRole('service_role');
  const claimed = (await one(
    'select public.claim_analysis_run($1, $2) as value',
    [60, queued.runId],
  )).value;

  const active = (await one(
    'select public.read_analysis_run_status($1, $2, $3) as value',
    [claimed.runId, claimed.generation, claimed.leaseToken],
  )).value;
  assert.equal(active.runId, claimed.runId);
  assert.equal(active.status, 'running');
  assert.equal(active.attempt, claimed.generation);
  assert.equal(active.leaseActive, true);
  assert.equal('leaseToken' in active, false);
  assert.equal('lease_token' in active, false);

  // 다른 임대 토큰이나 세대에서는 leaseActive=false를 반환한다.
  const wrongToken = (await one(
    'select public.read_analysis_run_status($1, $2, $3) as value',
    [claimed.runId, claimed.generation, randomUUID()],
  )).value;
  assert.equal(wrongToken.status, 'running');
  assert.equal(wrongToken.leaseActive, false);

  const wrongGen = (await one(
    'select public.read_analysis_run_status($1, $2, $3) as value',
    [claimed.runId, claimed.generation + 1, claimed.leaseToken],
  )).value;
  assert.equal(wrongGen.leaseActive, false);

  // 완료 후 read_analysis_run_status는 finished와 snapshotId, leaseActive=false를 돌려준다.
  const finished = (await one(
    'select public.finish_analysis_comparison($1, $2, $3, $4, $5, $6) as value',
    [
      claimed.runId, claimed.generation, claimed.leaseToken,
      JSON.stringify(baseInput), JSON.stringify(baseResult), JSON.stringify(baseComparison),
    ],
  )).value;
  const afterFinish = (await one(
    'select public.read_analysis_run_status($1, $2, $3) as value',
    [claimed.runId, claimed.generation, claimed.leaseToken],
  )).value;
  assert.equal(afterFinish.status, 'finished');
  assert.equal(afterFinish.attempt, claimed.generation);
  assert.equal(afterFinish.snapshotId, finished.snapshotId);
  assert.equal(afterFinish.leaseActive, false);

  // 임대 만료 및 취소된 실행은 leaseActive=false를 반환한다.
  await setRole('authenticated', owner.userId);
  const queued2 = (await one(
    'select public.enqueue_analysis_run($1, $2, $3) as value',
    [owner.analysisId, randomUUID(), JSON.stringify({ kind: 'synthetic', fixture: 'ingestion-v0' })],
  )).value;
  await setRole('service_role');
  const claimed2 = (await one('select public.claim_analysis_run($1, $2) as value', [60, queued2.runId])).value;
  await db.exec('reset role');
  await db.query(
    "update private.analysis_runs set next_claim_at = clock_timestamp() - interval '1 second' where id = $1",
    [claimed2.runId],
  );
  await setRole('service_role');
  const afterExpire = (await one(
    'select public.read_analysis_run_status($1, $2, $3) as value',
    [claimed2.runId, claimed2.generation, claimed2.leaseToken],
  )).value;
  assert.equal(afterExpire.status, 'running');
  assert.equal(afterExpire.leaseActive, false);

  await setRole('authenticated', owner.userId);
  await db.query('select public.cancel_analysis_run($1, $2)', [owner.analysisId, queued2.runId]);
  await setRole('service_role');
  const afterCancel = (await one(
    'select public.read_analysis_run_status($1, $2, $3) as value',
    [claimed2.runId, claimed2.generation, claimed2.leaseToken],
  )).value;
  assert.equal(afterCancel.status, 'cancelled');
  assert.equal(afterCancel.leaseActive, false);
});

test('set-based trade validation rejects every individual trade-row rule violation with the exact error code', async () => {
  // 각 거래 행 규칙을 하나씩 위반한 합성 사례 표 (22023 + 정확한 오류 메시지 확인)
  const cases = [
    ['non-object trade (number)', s => { s.tradeBatches[0].trades[0] = 123; }, 'invalid_ingestion_trade_observation'],
    ['non-object trade (null)', s => { s.tradeBatches[0].trades[0] = null; }, 'invalid_ingestion_trade_observation'],
    ['unexpected key on trade', s => { s.tradeBatches[0].trades[0].unexpectedField = true; }, 'invalid_ingestion_trade_observation'],
    ['wrong normalizerVersion', s => { s.tradeBatches[0].trades[0].normalizerVersion = 'ingestion-trades/v99'; }, 'invalid_ingestion_trade_observation'],
    ['non-object provenance (null)', s => { s.tradeBatches[0].trades[0].provenance = null; }, 'invalid_ingestion_trade_observation'],
    ['non-object provenance (scalar)', s => { s.tradeBatches[0].trades[0].provenance = 'bad'; }, 'invalid_ingestion_trade_observation'],
    ['extra key on provenance', s => { s.tradeBatches[0].trades[0].provenance.extra = 1; }, 'invalid_ingestion_trade_observation'],
    ['mismatched provenance.source', s => { s.tradeBatches[0].trades[0].provenance.source = 'apt_rights'; }, 'invalid_ingestion_trade_observation'],
    ['mismatched provenance.request LAWD_CD', s => { s.tradeBatches[0].trades[0].provenance.request.LAWD_CD = '00000'; }, 'invalid_ingestion_trade_observation'],
    ['mismatched provenance.request DEAL_YMD', s => { s.tradeBatches[0].trades[0].provenance.request.DEAL_YMD = '202601'; }, 'invalid_ingestion_trade_observation'],
    ['provenance.page zero', s => { s.tradeBatches[0].trades[0].provenance.page = 0; }, 'invalid_ingestion_trade_observation'],
    ['provenance.page exceeds pagesExpected', s => { s.tradeBatches[0].trades[0].provenance.page = 3; }, 'invalid_ingestion_trade_observation'],
    ['provenance.page string', s => { s.tradeBatches[0].trades[0].provenance.page = '1'; }, 'invalid_ingestion_trade_observation'],
    ['provenance.page float', s => { s.tradeBatches[0].trades[0].provenance.page = 1.5; }, 'invalid_ingestion_trade_observation'],
    ['provenance.position zero', s => { s.tradeBatches[0].trades[0].provenance.position = 0; }, 'invalid_ingestion_trade_observation'],
    ['provenance.position string', s => { s.tradeBatches[0].trades[0].provenance.position = '1'; }, 'invalid_ingestion_trade_observation'],
    ['provenance.position negative', s => { s.tradeBatches[0].trades[0].provenance.position = -1; }, 'invalid_ingestion_trade_observation'],
    ['provenance.page in missingPages', s => {
      // missingPages는 2..pagesExpected 범위여야 하며, 2쪽에 속한 trades[2]가 누락 쪽으로 표기되면 거절된다.
      const b = s.tradeBatches[0];
      b.record.status = 'partial';
      b.record.missingPages = [2];
      b.reasons = ['page_failed'];
    }, 'invalid_ingestion_trade_observation'],
    ['apt_trade non-sale tradeKind', s => { s.tradeBatches[0].trades[0].tradeKind = 'presale_right'; }, 'invalid_ingestion_trade_observation'],
    ['apt_trade null tradeKind', s => { s.tradeBatches[0].trades[0].tradeKind = null; }, 'invalid_ingestion_trade_observation'],
    ['apt_rights sale tradeKind', s => { s.tradeBatches[1].trades[0].tradeKind = 'sale'; }, 'invalid_ingestion_trade_observation'],
    ['apt_rights unknown tradeKind', s => { s.tradeBatches[1].trades[0].tradeKind = 'other'; }, 'invalid_ingestion_trade_observation'],
    ['invalid disposition', s => { s.tradeBatches[0].trades[0].disposition = 'included'; }, 'invalid_ingestion_trade_observation'],
    ['invalid cancellation.status', s => { s.tradeBatches[0].trades[0].cancellation.status = 'active'; }, 'invalid_ingestion_trade_observation'],
    ['invalid contractDate.date leap day', s => { s.tradeBatches[0].trades[0].contractDate.date = '2026-02-29'; }, 'invalid_ingestion_trade_observation'],
    ['invalid contractDate.date format', s => { s.tradeBatches[0].trades[0].contractDate.date = '20261010'; }, 'invalid_ingestion_trade_observation'],
    ['invalid contractDate.date number', s => { s.tradeBatches[0].trades[0].contractDate.date = 20261010; }, 'invalid_ingestion_trade_observation'],
    ['invalid amount.won zero', s => { s.tradeBatches[0].trades[0].amount.won = '0'; }, 'invalid_ingestion_trade_observation'],
    ['invalid amount.won number', s => { s.tradeBatches[0].trades[0].amount.won = 10000; }, 'invalid_ingestion_trade_observation'],
    ['invalid amount.won >20 digits', s => { s.tradeBatches[0].trades[0].amount.won = '1' + '0'.repeat(20); }, 'invalid_ingestion_trade_observation'],
    ['invalid exclusiveArea.basis', s => { s.tradeBatches[0].trades[0].exclusiveArea.basis = 'supply'; }, 'invalid_ingestion_trade_observation'],
    ['invalid exclusiveArea.m2 zero', s => { s.tradeBatches[0].trades[0].exclusiveArea.m2 = '0.00'; }, 'invalid_ingestion_trade_observation'],
    ['invalid exclusiveArea.m2 number', s => { s.tradeBatches[0].trades[0].exclusiveArea.m2 = 84.1; }, 'invalid_ingestion_trade_observation'],
    ['invalid exclusiveArea.m2 >24 chars', s => { s.tradeBatches[0].trades[0].exclusiveArea.m2 = '1' + '0'.repeat(24); }, 'invalid_ingestion_trade_observation'],
    ['invalid supplyArea.basis', s => { s.tradeBatches[0].trades[0].supplyArea.basis = 'exclusive'; }, 'invalid_ingestion_trade_observation'],
    ['invalid supplyArea.status confirmed', s => { s.tradeBatches[0].trades[0].supplyArea.status = 'confirmed'; }, 'invalid_ingestion_trade_observation'],
    ['invalid supplyArea.m2 non-null', s => { s.tradeBatches[0].trades[0].supplyArea.m2 = '112.50'; }, 'invalid_ingestion_trade_observation'],
    ['complete batch position overflow', s => {
      // pageSize=2, reportedTotalCount=3인 complete 묶음의 2쪽 최대 위치는 1이므로 position=2는 범위 초과다.
      s.tradeBatches[0].trades[2].provenance.position = 2;
    }, 'invalid_ingestion_trade_position'],
    ['duplicate (page, position) in batch', s => {
      const b = s.tradeBatches[1];
      b.trades[1].provenance.position = b.trades[0].provenance.position;
    }, 'invalid_ingestion_trade_locations'],
    ['nested raw key inside trade attributes', s => {
      s.tradeBatches[0].trades[0].attributes.rawPdf = 'forbidden';
    }, 'invalid_ingestion_result'],
  ];

  for (const [label, mutator, expectedMessage] of cases) {
    const mutated = cloneResult(mutator);
    await assert.rejects(
      saveSnapshot(mutated),
      err => err.code === '22023' && err.message === expectedMessage,
      `case "${label}" should reject with 22023/${expectedMessage}`,
    );
  }

  // 허용 경계 확인: null 가능한 거래 필드(contractDate.date, amount.won, exclusiveArea.m2, apt_rights tradeKind)와
  // 객체 키가 아닌 문자열 값 안의 '"body":' 패턴은 정상 저장된다(텍스트 사전 검사 오탐 없음 확인).
  const accepted = cloneResult(s => {
    s.tradeBatches[0].trades[0].contractDate.date = null;
    s.tradeBatches[0].trades[0].amount.won = null;
    s.tradeBatches[0].trades[0].exclusiveArea.m2 = null;
    s.tradeBatches[0].trades[0].attributes.syntheticNote = 'text with "body": value is not an object key';
    s.tradeBatches[1].trades[0].tradeKind = null;
  });
  const savedId = await saveSnapshot(accepted);
  assert.ok(savedId);
});

test('set-based catalog and funding schedule validation rejects every rule violation with the exact error code', async () => {
  // 1) check_ingestion_v0_catalog 규칙 표
  const catalogCases = [
    ['non-object housingType', s => { s.catalog.housingTypes[0] = 42; }, 'invalid_ingestion_housing_type'],
    ['non-array checkedSupplyArea.evidence', s => { s.catalog.housingTypes[0].checkedSupplyArea.evidence = 'not-array'; }, 'invalid_ingestion_housing_type'],
    ['non-object room', s => { s.catalog.rooms[0] = null; }, 'invalid_ingestion_room'],
    ['non-array salePrice.evidence', s => { s.catalog.rooms[0].salePrice.evidence = 123; }, 'invalid_ingestion_room_price'],
    ['salePrice won=0', s => { s.catalog.rooms[0].salePrice.won = '0'; }, 'invalid_ingestion_room_price'],
    ['subtotal sum mismatch', s => { s.catalog.rooms[0].subtotal.won = '700000001'; }, 'invalid_ingestion_room_subtotal'],
    ['subtotal document ref mismatch', s => {
      s.catalog.rooms[0].subtotal.documents = [{ id: 'other-doc', version: 'synthetic-v1' }];
    }, 'invalid_ingestion_subtotal_reference'],
    ['document reference invalid page', s => {
      s.catalog.housingTypes[0].checkedSupplyArea.evidence[0].page = 0;
    }, 'invalid_ingestion_document_reference'],
  ];
  for (const [label, mutator, expectedMessage] of catalogCases) {
    const mutated = cloneResult(mutator);
    await assert.rejects(
      saveSnapshot(mutated),
      err => err.code === '22023' && err.message === expectedMessage,
      `catalog case "${label}" should reject with 22023/${expectedMessage}`,
    );
  }

  // 2) check_funding_schedules 규칙 표
  const scheduleCases = [
    ['non-object schedule', () => [123], 'invalid_funding_schedule'],
    ['non-array schedule evidence', () => [{ ...structuredClone(baseSchedule), evidence: 'not-array' }], 'invalid_funding_schedule'],
    ['non-string evidence document number', () => [{
      ...structuredClone(baseSchedule),
      evidence: [{ document: 123, version: 'synthetic-v1', page: 7 }],
    }], 'invalid_funding_schedule'],
    ['invalid reason code format', () => [{
      ...structuredClone(baseSchedule),
      status: 'unverified', totalWon: null, installments: [], reasons: ['INVALID-CODE'],
    }], 'invalid_funding_schedule_reasons'],
    ['held schedule with totalWon', () => [{
      ...structuredClone(baseSchedule),
      status: 'unverified', totalWon: '100', installments: [], reasons: ['payment_schedule_missing'],
    }], 'invalid_held_funding_schedule'],
    ['room mismatch', () => [{ ...structuredClone(baseSchedule), room: '999동 999호' }], 'funding_schedule_room_mismatch'],
    ['price mismatch', () => [{ ...structuredClone(baseSchedule), totalWon: '700000001' }], 'funding_schedule_price_mismatch'],
    ['non-object installment', () => [{ ...structuredClone(baseSchedule), installments: [null] }], 'invalid_funding_installment'],
    ['non-array timing.evidence', () => {
      const sc = structuredClone(baseSchedule);
      sc.installments[0].timing.evidence = 'bad';
      return [sc];
    }, 'invalid_funding_installment'],
    ['invalid exact date', () => {
      const sc = structuredClone(baseSchedule);
      sc.installments[0].timing.date = '2026-02-30';
      return [sc];
    }, 'invalid_funding_installment'],
    ['installment sum mismatch', () => {
      const sc = structuredClone(baseSchedule);
      sc.installments[2].won = '210000001';
      return [sc];
    }, 'funding_installment_sum_mismatch'],
  ];
  for (const [label, makeSchedules, expectedMessage] of scheduleCases) {
    await assert.rejects(
      saveWithSchedules(makeSchedules()),
      err => err.code === '22023' && err.message === expectedMessage,
      `schedule case "${label}" should reject with 22023/${expectedMessage}`,
    );
  }

  // room_model_conflict가 있는 카탈로그 호실은 funding_schedule_room_unverified로 거절한다.
  const conflictCatalog = cloneResult(s => {
    s.catalog.issues.push({ code: 'room_model_conflict', room: '101동 101호' });
  });
  await assert.rejects(
    saveWithSchedules([baseSchedule], conflictCatalog),
    { code: '22023', message: 'funding_schedule_room_unverified' },
  );

  // 정상 납부 일정은 저장된다.
  const okId = await saveWithSchedules([baseSchedule]);
  assert.ok(okId);
});

test('synthetic 6,000-trade (26 batches) and 500-room schedule save succeeds and catches a late invalid row', async () => {
  // 합성 자료: 천안 서북구 규모에 맞춘 13개월 × 2출처 = 26개 묶음, 총 6,000건 거래, 500호실, 500개 납부 일정.
  const months = [
    '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04',
    '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11',
  ];
  const monthsYmd = months.map(m => m.replace('-', ''));
  const sampleSale = baseResult.tradeBatches[0].trades[0];
  const sampleRight = baseResult.tradeBatches[1].trades[0];
  const bigInput = {
    noticeSource: 'applyhome_apt',
    target: baseInput.target,
    asOf: '2026-11-10',
    start: '2025-11-11',
    end: '2026-11-10',
    requestRegionCodes: ['99999'],
    tradeKinds: ['sale', 'presale_right', 'occupancy_right'],
    pageSize: 100,
  };
  const tradeBatches = [];
  let totalTrades = 0;
  for (const [mIdx, month] of months.entries()) {
    const ymd = monthsYmd[mIdx];
    for (const [src, kinds, sample, count] of [
      ['apt_trade', ['sale'], sampleSale, 400],
      ['apt_rights', ['presale_right', 'occupancy_right'], sampleRight, mIdx < 7 ? 62 : 61],
    ]) {
      const trades = [];
      for (let i = 0; i < count; i++) {
        trades.push({
          ...sample,
          provenance: {
            source: src,
            request: { LAWD_CD: '99999', DEAL_YMD: ymd },
            page: Math.floor(i / 100) + 1,
            position: (i % 100) + 1,
          },
          contractDate: { ...sample.contractDate, date: `${month}-10` },
        });
      }
      totalTrades += trades.length;
      tradeBatches.push({
        record: {
          recordId: `${src}:99999:${ymd}`,
          source: src,
          tradeKinds: kinds,
          requestRegionCode: '99999',
          month,
          status: 'complete',
          pagesExpected: Math.ceil(count / 100),
          missingPages: [],
          reportedTotalCount: count,
          rowsReceived: count,
          totalCountChanged: false,
          collectedAt: '2026-11-10T01:00:00Z',
          error: null,
        },
        reasons: [],
        trades,
      });
    }
  }
  assert.equal(tradeBatches.length, 26);
  assert.equal(totalTrades, 6000);

  const baseRoom = baseResult.catalog.rooms[0];
  const rooms = [];
  const schedules = [];
  for (let r = 0; r < 500; r++) {
    const roomName = `${101 + Math.floor(r / 20)}동 ${(r % 20) + 1}01호`;
    rooms.push({ ...baseRoom, room: roomName });
    schedules.push({ ...baseSchedule, room: roomName });
  }
  const bigResult = {
    ...baseResult,
    asOf: '2026-11-10',
    period: {
      status: 'confirmed',
      source: 'user_confirmed',
      asOf: '2026-11-10',
      start: '2025-11-11',
      end: '2026-11-10',
      bounds: 'inclusive',
      months: monthsYmd,
      inProgressMonth: '202611',
      decision: null,
    },
    catalog: { ...baseResult.catalog, rooms },
    tradeBatches,
  };

  const savedId = await saveWithSchedules(schedules, bigResult, bigInput);
  assert.ok(savedId);

  // 26번째 묶음의 마지막(6,000번째) 거래 한 건만 어겨도 정확히 거절한다.
  const lastBatch = bigResult.tradeBatches[25];
  const lastTrade = lastBatch.trades[lastBatch.trades.length - 1];
  lastTrade.amount = { ...lastTrade.amount, won: '0' };
  await assert.rejects(
    saveWithSchedules(schedules, bigResult, bigInput),
    { code: '22023', message: 'invalid_ingestion_trade_observation' },
  );
});
