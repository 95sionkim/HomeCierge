// 실제 합성 PDF를 문서 작업자, SQL RPC, 자금표 계산 순서로 통과시킨다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { createBe03Db } from './helpers/be03-db.mjs';

const { calculateFundingPlan } = await tsImport('../../src/server/funding-plan.ts', import.meta.url);
const variants = ['normal', 'house-type-conflict', 'revision-type-conflict'];
const rooms = ['101동 101호', '101동 102호'];
const normal = [
  { knownTotal: '710000000', total: '710000000', due: '70000000', options: ['confirmed', '10000000'],
    undated: [['sale_price', '630000000', 'range'], ['required_options', '1000000', 'unverified'],
      ['required_options', '9000000', 'relative']], holds: ['payment_date_unverified'] },
  { knownTotal: '720000000', total: null, due: '72000000', options: ['unverified', null],
    undated: [['sale_price', '648000000', 'range']], holds: ['payment_schedule_incomplete', 'payment_date_unverified'] },
];

function pdfPayloads() {
  const python = [
    'import json, sys',
    'sys.path.insert(0, "scripts")',
    'from test_funding_capture import HAS_FITZ, synthetic_funding_payload',
    'print(json.dumps([synthetic_funding_payload(variant) for variant in sys.argv[1:]] if HAS_FITZ else None))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-B', '-c', python, ...variants], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8',
  }));
}

function checkNormalPlan(plan, expected, document) {
  assert.equal(plan.scheduleStatus, 'available');
  assert.equal(plan.status, 'partial');
  assert.equal(plan.knownRequiredTotalWon, expected.knownTotal);
  assert.equal(plan.requiredTotalWon, expected.total);
  assert.deepEqual(plan.undatedInstallments.map(i => [i.item, i.won, i.timing.dateStatus]), expected.undated);
  const options = plan.components.find(component => component.item === 'required_options');
  assert.deepEqual([options.status, options.totalWon], expected.options);
  const reference = page => ({ document: document.id, version: document.version, page });
  assert.deepEqual(options.evidence, [reference(3)]);
  assert.deepEqual([...plan.evidence].sort((a, b) => a.page - b.page), [reference(1), reference(2), reference(3)]);
  assert.equal(plan.rows.length, 1);
  const [row] = plan.rows;
  assert.deepEqual([row.date, row.knownDueWon], ['2026-10-27', expected.due]);
  const [deposit] = row.installments;
  assert.deepEqual(deposit.timing.evidence, [reference(1), reference(2)]);
  const afterInflow = row.scenarios.confirmedOnly.afterIncomingFunds;
  assert.deepEqual([afterInflow.fundsWon, afterInflow.shortfallWon, afterInflow.holdReasons],
    ['50000000', null, expected.holds]);
}

test('actual PDF worker captures preserve a room’s checked and held payments through SQL and calculation', async t => {
  const payloads = pdfPayloads();
  if (payloads === null) {
    t.skip('PyMuPDF를 설치한 문서 작업자에서 실행');
    return;
  }
  const db = await createBe03Db();
  try {
    const [{ p_user_id: user, p_analysis_id: analysis, p_input: input }] = payloads;
    const one = async (sql, args) => (await db.query(sql, args)).rows[0];
    await db.exec(`alter table auth.users add column confirmed_at timestamptz,
      add column is_anonymous boolean not null default false,
      add column banned_until timestamptz, add column deleted_at timestamptz;
      insert into public.source_registry(id,display_name,storage_permission,reuse_permission,display_permission)
        select id,'합성 시험 출처','allowed','allowed','allowed'
        from unnest(array['applyhome_apt','applyhome_apt_model','applyhome_notice_pdf','apt_trade','apt_rights']) as s(id)`);
    await db.query('insert into auth.users(id,confirmed_at) values ($1,now())', [user]);
    const chat = await one("insert into public.chats(user_id,title) values ($1,'합성 검수 대화') returning id", [user]);
    const target = { ...input.target, noticeSource: input.noticeSource };
    await db.query('insert into public.analyses(id,user_id,chat_id,conditions_snapshot) values ($1,$2,$3,$4)',
      [analysis, user, chat.id, JSON.stringify({ ingestion_target: target, housingType: { modelNo: '01' } })]);
    await db.query(`insert into public.funding_entries(user_id,analysis_id,kind,amount_won,available_on,certainty)
      values ($1,$2,'current',50000000,'2026-10-01','confirmed')`, [user, analysis]);

    for (const [index, payload] of payloads.entries()) {
      await t.test(variants[index], async () => {
        const { p_user_id, p_analysis_id, p_capture_key, p_input, p_result, p_schedules } = payload;
        await db.exec('reset role; set role service_role');
        const jsonArgs = [p_input, p_result, p_schedules].map(value => JSON.stringify(value));
        const args = [p_user_id, p_analysis_id, p_capture_key, ...jsonArgs];
        const save = async () => {
          try {
            return await one('select public.save_funding_schedule_snapshot($1,$2,$3,$4,$5,$6) as id', args);
          } catch (error) {
            throw new Error(`${error.code} ${error.message}`);
          }
        };
        const { id } = await save();
        assert.equal((await save()).id, id);
        await db.exec('reset role');
        const stored = await one(`select s.input_snapshot, s.result_snapshot, f.schedules from public.analysis_input_snapshots s
          join private.analysis_funding_schedule_snapshots f on f.snapshot_id = s.id where s.id = $1`, [id]);
        assert.deepEqual(stored, { input_snapshot: p_input, result_snapshot: p_result, schedules: p_schedules });
        if (index > 0) {
          assert.equal(stored.schedules.length, index === 1 ? 4 : 8);
          assert.ok(stored.schedules.every(row => row.status === 'conflict' && row.totalWon === null
            && row.installments.length === 0));
        }

        await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
          [user, JSON.stringify({ sub: user, is_anonymous: false })]);
        await db.exec('set role authenticated');
        for (const [roomIndex, room] of rooms.entries()) {
          const { inputs } = await one('select public.read_analysis_funding_inputs($1,$2,$3,$4) as inputs',
            [analysis, id, '01', room]);
          const plan = calculateFundingPlan(inputs);
          assert.deepEqual(plan.selection, { analysisId: analysis, snapshotId: id, modelNo: '01', room });
          assert.equal(plan.userInputs.funds[0].amountWon, '50000000');
          if (index === 0) {
            assert.deepEqual(inputs.schedules, p_schedules.filter(row => row.room === room));
            checkNormalPlan(plan, normal[roomIndex], p_result.catalog.documents[0]);
          } else {
            assert.deepEqual(inputs.schedules, []);
            assert.equal(plan.scheduleStatus, 'selection_unverified');
            assert.equal(plan.status, 'selection_unverified');
            assert.equal(plan.knownRequiredTotalWon, null);
            assert.deepEqual(plan.rows, []);
          }
        }
      });
    }
  } finally {
    await db.close();
  }
});
