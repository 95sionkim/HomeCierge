// 합성 Auth·수집본·비교·자금·법령 자료와 PGlite로 S-07 저장 보고서 RPC와 권한 계약을 검사한다.
// 실제 인증·Storage·외부 API는 호출하지 않으며 모든 사용자·공고·거래·자금·법령은 합성 자료다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBe03Db } from './helpers/be03-db.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRaw = JSON.parse(readFileSync(new URL('../fixtures/ingestion-v0.json', import.meta.url), 'utf8'));
const fixtureEvidence = JSON.parse(readFileSync(new URL('../fixtures/comparison-evidence-v1.json', import.meta.url), 'utf8'));
const syntheticInput = { kind: 'synthetic', fixture: 'ingestion-v0' };

const apt = 'applyhome_apt';
const remainder = 'applyhome_remainder';
const pdfSource = 'applyhome_notice_pdf';
const lawSource = 'law_eflaw';
const supplementalSources = [
  'synthetic-area-register',
  'synthetic-complex-register',
  'synthetic-coordinate-register',
  'synthetic-region-register',
];
const modelNo = '01';
const houseType = '084.0000A';
const firstRoom = '101동 101호';
const secondRoom = '101동 102호';
const noticeDate = '2026-10-05';
const proof = { document: 'synthetic-notice-pdf', version: 'synthetic-v1', page: 7 };

const lawReference = {
  contractVersion: 'law-reference/v1',
  dataOrigin: 'collected',
  title: '주택공급에 관한 규칙',
  asOf: noticeDate,
  observedAt: '2026-11-12T11:12:13.123456789+09:00',
  mst: '90071992547409931234',
  lawId: '00090071992547409931',
  promulgatedOn: '2026-09-02',
  effectiveOn: '2026-09-05',
  articles: [
    { number: '2', branch: null, heading: '합성 조문 제목' },
    { number: '2', branch: '1', heading: '합성 가지 조문 제목' },
  ],
};
const laterLawReference = {
  ...lawReference,
  observedAt: '2026-11-12T02:12:13.123456790Z',
  mst: '90071992547409931235',
};

const authRequired = { code: '42501', message: 'authentication_required' };
const forbidden = { code: '42501' };
const invalidRequest = { code: '22023', message: 'invalid_report_request' };
const invalidLookup = { code: '22023', message: 'invalid_report_lookup' };
const runNotFound = { code: 'PT404', message: 'analysis_run_not_found' };
const reportNotFound = { code: 'PT404', message: 'report_not_found' };
const cursorNotFound = { code: 'PT404', message: 'report_cursor_not_found' };
const notReady = { code: 'PT409', message: 'analysis_comparison_not_ready' };
const requestConflict = { code: 'PT409', message: 'report_request_conflict' };

const replays = new Map();
let db;

function fixtureSchedules() {
  return [
    {
      modelNo,
      houseType,
      room: firstRoom,
      item: 'sale_price',
      status: 'confirmed',
      totalWon: '700000000',
      reasons: [],
      evidence: [proof],
      installments: [
        {
          stage: 'deposit',
          won: '70000000',
          timing: {
            trigger: 'contract_signing',
            dateStatus: 'exact',
            date: '2026-10-23',
            evidence: [{ ...proof, page: 2 }, proof],
          },
        },
        {
          stage: 'balance',
          won: '630000000',
          timing: {
            trigger: 'deadline',
            dateStatus: 'exact',
            date: '2026-11-30',
            evidence: [proof],
          },
        },
      ],
    },
    {
      modelNo,
      houseType,
      room: firstRoom,
      item: 'required_options',
      status: 'confirmed',
      totalWon: '10000000',
      reasons: [],
      evidence: [{ ...proof, page: 8 }],
      installments: [
        {
          stage: 'balance',
          won: '10000000',
          timing: { trigger: 'move_in', dateStatus: 'relative', date: null, evidence: [] },
        },
      ],
    },
    {
      modelNo,
      houseType,
      room: secondRoom,
      item: 'sale_price',
      status: 'confirmed',
      totalWon: '720000000',
      reasons: [],
      evidence: [proof],
      installments: [
        {
          stage: 'balance',
          won: '720000000',
          timing: { trigger: null, dateStatus: 'missing', date: null, evidence: [] },
        },
      ],
    },
    {
      modelNo,
      houseType,
      room: secondRoom,
      item: 'required_options',
      status: 'unverified',
      totalWon: null,
      reasons: ['payment_evidence_missing'],
      evidence: [],
      installments: [],
    },
  ];
}

function runCompare(ingestion, selection, evidence = fixtureEvidence, comparisonPeriod = null) {
  const python = `
import json, sys
sys.path.insert(0, 'scripts')
from compare_trades import compare_snapshot

ingestion, selection, evidence, period = json.load(sys.stdin)
print(json.dumps(compare_snapshot(ingestion, selection, evidence, comparison_period=period), ensure_ascii=False))
`;
  return JSON.parse(execFileSync('python3', ['-B', '-c', python], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify([ingestion, selection, evidence, comparisonPeriod]),
  }));
}

const json = value => (value === null ? null : JSON.stringify(value));

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function as(role, userId = '', claims = { is_anonymous: false }) {
  await db.exec('reset role');
  const jwt = { ...(userId ? { sub: userId } : {}), ...claims };
  await db.query(
    "select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)",
    [userId, JSON.stringify(jwt)],
  );
  await db.exec(`set role ${role}`);
}

async function rpc(name, ...params) {
  const args = params.map((_, index) => `$${index + 1}`).join(', ');
  return (await one(`select public.${name}(${args}) as reply`, params)).reply;
}

const saveReport = (analysisId, runId, requestId = randomUUID(), fundingRoom = null) =>
  rpc('save_analysis_report', analysisId, runId, requestId, fundingRoom);

const readReport = (reportId, forExport = undefined) => (
  forExport === undefined
    ? rpc('read_saved_analysis_report', reportId)
    : rpc('read_saved_analysis_report', reportId, forExport)
);

const listReports = (beforeId = undefined) => (
  beforeId === undefined
    ? rpc('list_saved_analysis_reports')
    : rpc('list_saved_analysis_reports', beforeId)
);

const deleteReport = reportId => rpc('delete_saved_analysis_report', reportId);

async function allowSources(sources, { exportPermission = 'allowed', retentionDays = null } = {}) {
  await db.exec('reset role');
  await db.query(
    `insert into public.source_registry(
       id, display_name, storage_permission, reuse_permission, display_permission, export_permission, retention_days
     )
     select id, '합성 출처', 'allowed', 'allowed', 'allowed', $2, $3
     from unnest($1::text[]) as source(id)
     on conflict (id) do update set
       storage_permission = 'allowed',
       reuse_permission = 'allowed',
       display_permission = 'allowed',
       export_permission = excluded.export_permission,
       retention_days = excluded.retention_days`,
    [sources, exportPermission, retentionDays],
  );
}

async function updateSource(id, patch) {
  await db.exec('reset role');
  const entries = Object.entries(patch);
  const sets = entries.map(([col], idx) => `${col} = $${idx + 2}`).join(', ');
  await db.query(
    `update public.source_registry set ${sets} where id = $1`,
    [id, ...entries.map(([, val]) => val)],
  );
}

async function createUser({ verified = true, anonymous = false, bannedUntil = null, deletedAt = null } = {}) {
  await db.exec('reset role');
  const userId = randomUUID();
  await db.query(
    `insert into auth.users(id, confirmed_at, is_anonymous, banned_until, deleted_at)
     values ($1, case when $2 then now() end, $3, $4, $5)`,
    [userId, verified, anonymous, bannedUntil, deletedAt],
  );
  return userId;
}

async function createAnalysis(userId, {
  source = apt,
  conditions,
  room = firstRoom,
  noticeId = null,
  housingTypeId = null,
  extraConditions = {},
} = {}) {
  await db.exec('reset role');
  const { input } = replays.get(source);
  const comparisonCond = room === null
    ? { modelNo }
    : { modelNo, room };
  const snapshotConditions = conditions ?? {
    ingestion_target: { noticeSource: source, ...input.target },
    comparison: comparisonCond,
    ...extraConditions,
  };
  const chat = await one("insert into public.chats(user_id, title) values ($1, '합성 대화') returning id", [userId]);
  const row = await one(
    `insert into public.analyses(user_id, chat_id, conditions_snapshot, notice_id, housing_type_id)
     values ($1, $2, $3, $4, $5) returning id`,
    [userId, chat.id, JSON.stringify(snapshotConditions), noticeId, housingTypeId],
  );
  return { chatId: chat.id, analysisId: row.id };
}

async function addFund(userId, analysisId, {
  kind = 'current',
  amountWon = '300000000',
  availableOn = '2026-10-20',
  certainty = 'confirmed',
  note = '합성 비공개 자금 메모',
} = {}) {
  await as('authenticated', userId);
  const row = await one(
    `insert into public.funding_entries(user_id, analysis_id, kind, amount_won, available_on, certainty, note)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [userId, analysisId, kind, amountWon, availableOn, certainty, note],
  );
  return { id: row.id, kind, amountWon: String(amountWon), availableOn, certainty };
}

async function finishSyntheticRun(userId, analysisId, {
  selection = { modelNo, room: firstRoom },
  withSchedules = true,
  schedules = fixtureSchedules(),
} = {}) {
  const { input, result } = replays.get(apt);
  if (withSchedules) {
    await as('service_role');
    const snapshotId = await rpc(
      'save_funding_schedule_snapshot',
      userId, analysisId, randomUUID(), json(input), json(result), json(schedules),
    );
    await as('authenticated', userId);
    const run = await rpc('enqueue_analysis_run', analysisId, randomUUID(), json({ kind: 'snapshot', snapshotId }));
    await as('service_role');
    const job = await rpc('claim_analysis_run', 300, run.runId);
    const comp = runCompare(result, selection, fixtureEvidence);
    const finished = await rpc(
      'finish_analysis_comparison',
      job.runId, job.generation, job.leaseToken, null, null, json(comp),
    );
    return { runId: finished.runId, snapshotId: finished.snapshotId, comparison: comp, finishedAt: finished.finishedAt };
  }
  await as('authenticated', userId);
  const run = await rpc('enqueue_analysis_run', analysisId, randomUUID(), json(syntheticInput));
  await as('service_role');
  const job = await rpc('claim_analysis_run', 300, run.runId);
  const comp = runCompare(result, selection, fixtureEvidence);
  const finished = await rpc(
    'finish_analysis_comparison',
    job.runId, job.generation, job.leaseToken, json(input), json(result), json(comp),
  );
  return { runId: finished.runId, snapshotId: finished.snapshotId, comparison: comp, finishedAt: finished.finishedAt };
}

async function finishCollectedRun(userId, analysisId, {
  source = apt,
  selection = { modelNo, room: firstRoom },
  withEvidence = true,
  withSchedules = true,
  withOfficialPdf = true,
  withLaw = true,
  exportPermission = 'allowed',
  adjustIngestion = () => {},
} = {}) {
  const { input, result: baseResult } = replays.get(source);
  const result = structuredClone(baseResult);
  result.dataOrigin = 'collected';
  if (!withOfficialPdf) {
    result.catalog.documents = [];
    for (const m of result.catalog.housingTypes) {
      m.checkedSupplyArea = { ...m.checkedSupplyArea, status: 'unverified', m2: null, evidence: [], reasons: ['pdf_missing'] };
    }
    result.catalog.rooms = [];
  }
  adjustIngestion(result);

  const feedSources = [source, `${source}_model`, 'apt_trade', 'apt_rights'];
  const allSources = [
    ...feedSources,
    ...(withOfficialPdf || withSchedules ? [pdfSource] : []),
    ...(withEvidence ? supplementalSources : []),
    ...(withLaw ? [lawSource] : []),
  ];
  await allowSources(allSources, { exportPermission });

  await as('service_role');
  let snapshotId;
  if (withSchedules) {
    snapshotId = await rpc(
      'save_funding_schedule_snapshot',
      userId, analysisId, randomUUID(), json(input), json(result), json(fixtureSchedules()),
    );
  } else {
    snapshotId = await rpc(
      'save_ingestion_snapshot',
      userId, analysisId, randomUUID(), json(input), json(result),
    );
  }

  let ev = null;
  if (withEvidence) {
    ev = structuredClone(fixtureEvidence);
    ev.dataOrigin = 'collected';
    ev.target.notice.source = source;
    const evSources = [source, 'apt_trade', 'apt_rights', ...supplementalSources];
    await rpc('register_comparison_evidence', snapshotId, json(ev), evSources);
  }

  if (withLaw) {
    await rpc('publish_law_reference', json(lawReference));
  }

  await as('authenticated', userId);
  const run = await rpc('enqueue_analysis_run', analysisId, randomUUID(), json({ kind: 'snapshot', snapshotId }));
  await as('service_role');
  const job = await rpc('claim_analysis_run', 300, run.runId);
  const comp = runCompare(result, selection, ev);
  const finished = await rpc(
    'finish_analysis_comparison',
    job.runId, job.generation, job.leaseToken, null, null, json(comp),
  );
  return { runId: finished.runId, snapshotId: finished.snapshotId, comparison: comp, finishedAt: finished.finishedAt };
}

before(async () => {
  const command = [
    'import json, sys',
    'sys.path.insert(0, "scripts")',
    'from replay_ingestion import loads_source_json, replay',
    'print(json.dumps(replay(loads_source_json(sys.stdin.read())), ensure_ascii=False))',
  ].join('\n');
  for (const source of [apt, remainder]) {
    const replayFixture = structuredClone(fixtureRaw);
    replayFixture.request.noticeSource = source;
    for (const page of replayFixture.pages) {
      if (page.source === apt) page.source = source;
      if (page.source === `${apt}_model`) page.source = `${source}_model`;
    }
    const result = JSON.parse(execFileSync('python3', ['-B', '-c', command], {
      cwd: root,
      input: JSON.stringify(replayFixture),
      encoding: 'utf8',
    }));
    replays.set(source, { input: replayFixture.request, result });
  }
  db = await createBe03Db();
  await db.exec(`alter table auth.users add column confirmed_at timestamptz,
    add column is_anonymous boolean not null default false,
    add column banned_until timestamptz, add column deleted_at timestamptz`);
});

beforeEach(async () => {
  await db.exec('reset role');
  await db.exec(`truncate private.saved_report_funding_refs, private.saved_analysis_reports,
    private.analysis_report_versions, private.law_references, private.analysis_funding_schedule_snapshots,
    private.analysis_chat_turns, private.comparison_results, private.comparison_evidence,
    private.analysis_runs, public.reports, public.funding_entries, public.analysis_input_snapshots,
    public.analyses, public.chats, public.user_profiles, public.notices, public.source_registry,
    auth.users cascade`);
});

after(async () => {
  await db?.close();
});

test('private tables enable RLS with zero grants, FKs cascade consumed rows, and public RPCs are narrow invokers', async () => {
  await db.exec('reset role');
  for (const table of [
    'private.saved_analysis_reports',
    'private.saved_report_funding_refs',
    'private.analysis_report_versions',
    'private.deleted_report_requests',
  ]) {
    const row = await one(
      `select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname || '.' || c.relname = $1`,
      [table],
    );
    assert.equal(row.relrowsecurity, true, `${table} must enable RLS`);
    for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        assert.equal(
          (await one('select has_table_privilege($1, $2, $3) as ok', [role, table, priv])).ok,
          false,
          `${role} ${priv} on ${table}`,
        );
      }
    }
  }

  // 소비된 소유자·분석·보고서·실행·비교결과·수집본 FK가 모두 ON DELETE CASCADE임을 확인한다.
  const { rows: fks } = await db.query(
    `select con.conname, ns.nspname || '.' || rel.relname as target, con.confdeltype
     from pg_constraint con
     join pg_class rel on rel.oid = con.confrelid
     join pg_namespace ns on ns.oid = rel.relnamespace
     where con.conrelid = 'private.saved_analysis_reports'::regclass and con.contype = 'f'
     order by target`,
  );
  const targets = fks.map(r => r.target);
  for (const expectedTarget of [
    'auth.users',
    'public.analyses',
    'public.reports',
    'private.analysis_runs',
    'private.comparison_results',
    'public.analysis_input_snapshots',
  ]) {
    assert.ok(targets.includes(expectedTarget), `missing FK to ${expectedTarget}`);
  }
  for (const fk of fks) {
    assert.equal(fk.confdeltype, 'c', `${fk.conname} -> ${fk.target} must cascade`);
  }

  const publicRpcs = [
    { sig: 'public.save_analysis_report(uuid,uuid,uuid,text)', ret: 'jsonb' },
    { sig: 'public.read_saved_analysis_report(uuid,boolean)', ret: 'jsonb' },
    { sig: 'public.list_saved_analysis_reports(uuid)', ret: 'jsonb' },
    { sig: 'public.delete_saved_analysis_report(uuid)', ret: 'void' },
  ];
  for (const { sig, ret } of publicRpcs) {
    const def = await one('select prosecdef, prorettype::regtype::text as ret from pg_proc where oid = $1::regprocedure', [sig]);
    assert.equal(def.prosecdef, false, `${sig} must be security invoker`);
    assert.equal(def.ret, ret, `${sig} return type`);
    assert.equal((await one("select has_function_privilege('authenticated', $1, 'EXECUTE') as ok", [sig])).ok, true, sig);
    for (const role of ['public', 'anon', 'service_role']) {
      assert.equal((await one('select has_function_privilege($1, $2, $3) as ok', [role, sig, 'EXECUTE'])).ok, false, `${role} ${sig}`);
    }
  }

  const privateBackings = [
    'private.save_analysis_report(uuid,uuid,uuid,text)',
    'private.read_saved_analysis_report(uuid,boolean)',
    'private.list_saved_analysis_reports(uuid)',
    'private.delete_saved_analysis_report(uuid)',
  ];
  for (const sig of privateBackings) {
    const def = await one('select prosecdef from pg_proc where oid = $1::regprocedure', [sig]);
    assert.equal(def.prosecdef, true, `${sig} must be security definer`);
    assert.equal((await one("select has_function_privilege('authenticated', $1, 'EXECUTE') as ok", [sig])).ok, true, sig);
    for (const role of ['public', 'anon', 'service_role']) {
      assert.equal((await one('select has_function_privilege($1, $2, $3) as ok', [role, sig, 'EXECUTE'])).ok, false, `${role} ${sig}`);
    }
  }

  const internalHelpers = [
    'private.cleanup_deleted_saved_report()',
    'private.prune_deleted_funding_entry_from_reports()',
    'private.require_saved_report_read_user()',
    'private.report_sources_allowed(boolean,text[],boolean)',
    'private.report_snapshot_notice_date(jsonb)',
    'private.report_snapshot_identity(public.analysis_input_snapshots)',
    'private.saved_report_payload(public.reports,private.saved_analysis_reports,boolean)',
    'private.saved_reports_list_payload(uuid,bigint)',
  ];
  for (const sig of internalHelpers) {
    for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
      assert.equal((await one('select has_function_privilege($1, $2, $3) as ok', [role, sig, 'EXECUTE'])).ok, false, `${role} ${sig}`);
    }
  }
});

test('two users are strictly isolated, role bypass and unverified/anonymous callers are blocked, and managed reports are hidden from direct public.reports reads', async () => {
  const userA = await createUser();
  const userB = await createUser();
  const { analysisId: analysisA } = await createAnalysis(userA);
  const { analysisId: analysisB } = await createAnalysis(userB);
  const runA = await finishSyntheticRun(userA, analysisA);
  const runB = await finishSyntheticRun(userB, analysisB);

  const sharedReqId = randomUUID();
  await as('authenticated', userA);
  const reportA = await saveReport(analysisA, runA.runId, sharedReqId);

  // 다른 소유자는 같은 요청 UUID를 독립적으로 사용할 수 있다.
  await as('authenticated', userB);
  const reportB = await saveReport(analysisB, runB.runId, sharedReqId);
  assert.notEqual(reportA.reportId, reportB.reportId);

  // 직접 public.reports SELECT는 관리 보고서를 노출하지 않고, private 테이블과 쓰기는 거부된다.
  await as('authenticated', userA);
  assert.equal((await db.query('select * from public.reports')).rows.length, 0);
  await assert.rejects(db.query('select * from private.saved_analysis_reports'), forbidden);
  await assert.rejects(db.query('delete from public.reports where id = $1', [reportA.reportId]), forbidden);
  await assert.rejects(db.query("update public.reports set result_snapshot = '{}' where id = $1", [reportA.reportId]), forbidden);

  // 타인의 보고서·분석·실행·커서 접근은 모두 PT404이며 존재 여부를 노출하지 않는다.
  await as('authenticated', userB);
  await assert.rejects(saveReport(analysisA, runA.runId, randomUUID()), runNotFound);
  await assert.rejects(saveReport(analysisB, runA.runId, randomUUID()), runNotFound);
  await assert.rejects(saveReport(analysisA, runB.runId, randomUUID()), runNotFound);
  await assert.rejects(saveReport(analysisA, runA.runId, sharedReqId), runNotFound);
  await assert.rejects(readReport(reportA.reportId), reportNotFound);
  await assert.rejects(readReport(reportA.reportId, true), reportNotFound);
  await assert.rejects(listReports(reportA.reportId), cursorNotFound);
  await assert.rejects(deleteReport(reportA.reportId), reportNotFound);
  // RLS 보조 함수 직접 호출도 타인 보고서 존재 여부 오라클이 되지 않는다.
  assert.equal(
    (await one('select private.report_direct_select_allowed($1, $2) as ok', [reportA.reportId, userA])).ok,
    false,
  );
  assert.equal(
    (await one('select private.report_direct_select_allowed($1, $2) as ok', [randomUUID(), userA])).ok,
    false,
  );
  assert.equal(
    (await one('select private.report_direct_select_allowed($1, $2) as ok', [reportA.reportId, userB])).ok,
    true,
  );
  assert.equal(
    (await one('select private.report_direct_select_allowed($1, $2) as ok', [randomUUID(), userB])).ok,
    true,
  );

  // anon과 service_role은 모든 보고서 RPC와 private 테이블을 호출할 수 없다.
  for (const role of ['anon', 'service_role']) {
    await as(role, userA);
    await assert.rejects(saveReport(analysisA, runA.runId, randomUUID()), forbidden);
    await assert.rejects(readReport(reportA.reportId), forbidden);
    await assert.rejects(listReports(), forbidden);
    await assert.rejects(deleteReport(reportA.reportId), forbidden);
    await assert.rejects(db.query('select * from private.saved_analysis_reports'), forbidden);
  }
  // service_role이 public.reports를 읽어도 제3자 자료·수치·식별 정보는 복제되어 있지 않다.
  await as('service_role');
  const publicStub = await one(
    'select result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot from public.reports where id = $1',
    [reportA.reportId],
  );
  assert.deepEqual(publicStub, {
    result_snapshot: { contractVersion: 'report-snapshot/v1' },
    conditions_snapshot: {},
    sources_snapshot: [],
    unknowns_snapshot: [],
  });

  // 미인증·익명 JWT·미존재 사용자·미확인·익명 계정·정지·삭제 계정은 모두 42501이다.
  for (const [uid, claims] of [
    ['', { is_anonymous: false }],
    [randomUUID(), { is_anonymous: false }],
    [userA, { is_anonymous: true }],
    [userA, { is_anonymous: 'true' }],
  ]) {
    await as('authenticated', uid, claims);
    await assert.rejects(saveReport(analysisA, runA.runId, randomUUID()), authRequired);
    await assert.rejects(readReport(reportA.reportId), authRequired);
    await assert.rejects(listReports(), authRequired);
    await assert.rejects(deleteReport(reportA.reportId), authRequired);
  }

  for (const [restriction, restore] of [
    ['confirmed_at = null', 'confirmed_at = now()'],
    ['is_anonymous = true', 'is_anonymous = false'],
    ["banned_until = now() + interval '1 day'", 'banned_until = null'],
    ['deleted_at = now()', 'deleted_at = null'],
  ]) {
    await db.exec('reset role');
    await db.query(`update auth.users set ${restriction} where id = $1`, [userA]);
    await as('authenticated', userA);
    await assert.rejects(saveReport(analysisA, runA.runId, randomUUID()), authRequired, restriction);
    await assert.rejects(readReport(reportA.reportId), authRequired, restriction);
    await assert.rejects(listReports(), authRequired, restriction);
    await assert.rejects(deleteReport(reportA.reportId), authRequired, restriction);
    await db.exec('reset role');
    await db.query(`update auth.users set ${restore} where id = $1`, [userA]);
  }

  // NULL 매개변수는 22023이다.
  await as('authenticated', userA);
  await assert.rejects(saveReport(null, runA.runId, randomUUID()), invalidRequest);
  await assert.rejects(saveReport(analysisA, null, randomUUID()), invalidRequest);
  await assert.rejects(saveReport(analysisA, runA.runId, null), invalidRequest);
  await assert.rejects(readReport(null), invalidLookup);
  await assert.rejects(readReport(reportA.reportId, null), invalidLookup);
  await assert.rejects(deleteReport(null), invalidLookup);
});

test('synthetic reports require no external rights, freeze exact sections without notes or raw conditions, and handle room selection states', async () => {
  const user = await createUser();

  // 1) 호실이 명시된 합성 실행 + 자금 항목(메모 포함) + 통제되지 않은 임의 조건 키
  const { analysisId: selectedAnalysis } = await createAnalysis(user, {
    room: firstRoom,
    extraConditions: {
      uncontrolledNote: '임의 비공개 조건',
      liveCommute: { minutes: 25 },
      regionalNews: [{ title: '합성 뉴스' }],
    },
  });
  const fundCurrent = await addFund(user, selectedAnalysis, {
    kind: 'current',
    amountWon: '9007199254740993',
    availableOn: '2026-10-20',
    certainty: 'confirmed',
    note: '절대 저장하면 안 되는 합성 메모',
  });
  const fundExtra = await addFund(user, selectedAnalysis, {
    kind: 'additional',
    amountWon: '50000000',
    availableOn: '2026-11-01',
    certainty: 'expected',
    note: '두 번째 합성 메모',
  });
  const runSelected = await finishSyntheticRun(user, selectedAnalysis, {
    selection: { modelNo, room: firstRoom },
    withSchedules: true,
  });

  // source_registry가 완전히 비어 있어도 합성 보고서는 저장·조회·내보내기 모두 허용된다.
  await as('authenticated', user);
  const saved = await saveReport(selectedAnalysis, runSelected.runId, randomUUID());
  assert.equal(saved.contractVersion, 'report-snapshot/v1');
  assert.equal(saved.analysisId, selectedAnalysis);
  assert.equal(saved.runId, runSelected.runId);
  assert.equal(saved.snapshotId, runSelected.snapshotId);
  assert.equal(saved.version, 1);
  assert.equal(saved.rulesVersion, 'prd-1.0');
  assert.equal(saved.dataOrigin, 'synthetic');
  const capture = await one('select created_at from public.analysis_input_snapshots where id = $1', [runSelected.snapshotId]);
  assert.equal(new Date(saved.queriedAt).getTime(), new Date(capture.created_at).getTime());
  assert.ok(!Number.isNaN(new Date(saved.createdAt).getTime()));

  assert.deepEqual(saved.sections.comparison, {
    status: 'available',
    sources: [],
    exportAllowed: true,
    value: runSelected.comparison,
    identity: {
      houseManageNo: '9900000001',
      noticeNo: '9900000042',
      edition: 'synthetic-edition-1',
      noticeSource: apt,
      noticeDate,
      title: '합성 가람 아파트',
    },
  });
  assert.deepEqual(saved.sections.funding, {
    status: 'available',
    sources: [],
    exportAllowed: true,
    value: {
      analysisId: selectedAnalysis,
      snapshotId: runSelected.snapshotId,
      modelNo,
      room: firstRoom,
      dataOrigin: 'synthetic',
      scheduleStatus: 'available',
      schedules: fixtureSchedules().slice(0, 2),
      funds: [fundCurrent, fundExtra],
    },
  });
  assert.deepEqual(saved.sections.law, {
    status: 'available',
    sources: [],
    exportAllowed: true,
    value: {
      analysisId: selectedAnalysis,
      snapshotId: runSelected.snapshotId,
      dataOrigin: 'synthetic',
      noticeDate: null,
      noticeSource: apt,
      status: 'synthetic_input',
      reference: null,
    },
  });

  // 저장 본문에 자금 메모·뉴스·출퇴근·임의 조건이 포함되지 않는다.
  const serialized = JSON.stringify(saved);
  assert.ok(!serialized.includes('절대 저장하면 안 되는 합성 메모'));
  assert.ok(!serialized.includes('uncontrolledNote'));
  assert.ok(!serialized.includes('liveCommute'));
  assert.ok(!serialized.includes('regionalNews'));
  assert.deepEqual(await readReport(saved.reportId, false), saved);
  assert.deepEqual(await readReport(saved.reportId, true), saved);

  // 2) 호실 미선택 실행은 추측하지 않고 funding.status = 'room_unselected'를 반환한다.
  const { analysisId: unselectedAnalysis } = await createAnalysis(user, { room: null });
  await addFund(user, unselectedAnalysis);
  const runUnselected = await finishSyntheticRun(user, unselectedAnalysis, {
    selection: { modelNo },
    withSchedules: true,
  });
  await as('authenticated', user);
  const savedUnselected = await saveReport(unselectedAnalysis, runUnselected.runId, randomUUID());
  assert.deepEqual(savedUnselected.sections.funding, {
    status: 'room_unselected',
    sources: [],
    exportAllowed: true,
    value: null,
  });
  assert.equal((await readReport(savedUnselected.reportId, true)).sections.funding.status, 'room_unselected');

  const choiceKey = randomUUID();
  const roomReport = await saveReport(unselectedAnalysis, runUnselected.runId, choiceKey, secondRoom);
  assert.equal(roomReport.sections.funding.value.room, secondRoom);
  assert.equal(roomReport.sections.funding.value.scheduleStatus, 'available');
  assert.deepEqual(roomReport.sections.funding.value.schedules, fixtureSchedules().filter(row => row.room === secondRoom));
  assert.deepEqual(await saveReport(unselectedAnalysis, runUnselected.runId, choiceKey, secondRoom), roomReport);
  await assert.rejects(saveReport(unselectedAnalysis, runUnselected.runId, choiceKey, firstRoom), requestConflict);
  await assert.rejects(saveReport(unselectedAnalysis, runUnselected.runId, choiceKey), requestConflict);
  await assert.rejects(saveReport(unselectedAnalysis, runUnselected.runId, randomUUID(), '999동 999호'), { code: '22023' });
  await assert.rejects(saveReport(selectedAnalysis, runSelected.runId, randomUUID(), secondRoom), { code: '22023' });
  const fixedKey = randomUUID();
  const fixed = await saveReport(selectedAnalysis, runSelected.runId, fixedKey);
  assert.deepEqual(await saveReport(selectedAnalysis, runSelected.runId, fixedKey, firstRoom), fixed);

  // 3) 조건 간 호실 충돌은 funding.status = 'selection_unverified'로 보류한다.
  const { input } = replays.get(apt);
  const { analysisId: conflictedAnalysis } = await createAnalysis(user, {
    conditions: {
      ingestion_target: { noticeSource: apt, ...input.target },
      comparison: { modelNo, room: firstRoom },
      room: secondRoom,
    },
  });
  const runConflicted = await finishSyntheticRun(user, conflictedAnalysis, {
    selection: { modelNo, room: firstRoom },
    withSchedules: true,
  });
  await as('authenticated', user);
  const savedConflicted = await saveReport(conflictedAnalysis, runConflicted.runId, randomUUID());
  assert.deepEqual(savedConflicted.sections.funding, {
    status: 'selection_unverified',
    sources: [],
    exportAllowed: true,
    value: null,
  });
});

test('collected sections enforce independent source rights, revocation/restore, export-only denial, save-time non-storage, remainder feeds, and non-empty comparison sources', async () => {
  const user = await createUser();
  const { analysisId } = await createAnalysis(user, { source: apt, room: firstRoom });
  const fund = await addFund(user, analysisId, { amountWon: '250000000' });
  const run = await finishCollectedRun(user, analysisId, {
    source: apt,
    selection: { modelNo, room: firstRoom },
    withEvidence: true,
    withSchedules: true,
    withOfficialPdf: true,
    withLaw: true,
    exportPermission: 'allowed',
  });

  await as('authenticated', user);
  const report = await saveReport(analysisId, run.runId, randomUUID());
  assert.equal(report.dataOrigin, 'collected');
  assert.equal(report.sections.comparison.status, 'available');
  assert.equal(report.sections.comparison.exportAllowed, true);
  assert.deepEqual(report.sections.comparison.identity, {
    houseManageNo: '9900000001',
    noticeNo: '9900000042',
    edition: 'synthetic-edition-1',
    noticeSource: apt,
    noticeDate,
    title: '합성 가람 아파트',
  });
  assert.deepEqual(report.sections.comparison.sources, [
    apt, `${apt}_model`, pdfSource, 'apt_rights', 'apt_trade', ...supplementalSources,
  ].sort());
  assert.equal(report.sections.funding.status, 'available');
  assert.equal(report.sections.funding.exportAllowed, true);
  assert.deepEqual(report.sections.funding.sources, [apt, `${apt}_model`, pdfSource].sort());
  assert.deepEqual(report.sections.funding.value.funds, [fund]);
  assert.equal(report.sections.funding.value.scheduleStatus, 'available');
  assert.equal(report.sections.law.status, 'available');
  assert.equal(report.sections.law.exportAllowed, true);
  assert.deepEqual(report.sections.law.sources, [apt, lawSource]);
  assert.deepEqual(report.sections.law.value, {
    analysisId,
    snapshotId: run.snapshotId,
    dataOrigin: 'collected',
    noticeDate,
    noticeSource: apt,
    status: 'available',
    reference: lawReference,
  });

  // 1) 비교 전용 출처(apt_trade, 보강 근거) 철회 -> comparison만 제한, funding·law는 유지.
  for (const [source, patch] of [
    ['apt_trade', { display_permission: 'denied' }],
    ['apt_trade', { storage_permission: 'unknown' }],
    ['apt_trade', { reuse_permission: 'denied' }],
    [supplementalSources[0], { retention_days: 30 }],
  ]) {
    await updateSource(source, patch);
    await as('authenticated', user);
    const read = await readReport(report.reportId, false);
    assert.deepEqual(read.sections.comparison, {
      status: 'source_restricted',
      sources: report.sections.comparison.sources,
      exportAllowed: false,
      value: null,
      identity: null,
    });
    assert.equal(read.sections.funding.status, 'available');
    assert.deepEqual(read.sections.funding.value, report.sections.funding.value);
    assert.equal(read.sections.law.status, 'available');
    assert.deepEqual(read.sections.law.value, report.sections.law.value);
    // 직접 public.reports SELECT는 철회 상태에서도 0건을 유지한다.
    assert.equal((await db.query('select * from public.reports')).rows.length, 0);

    await allowSources([source]);
  }
  await as('authenticated', user);
  assert.deepEqual(await readReport(report.reportId, true), report);

  // 2) 공식 PDF 출처 철회 -> comparison과 funding만 제한, law는 계속 이용 가능.
  await updateSource(pdfSource, { display_permission: 'denied' });
  await as('authenticated', user);
  const pdfRestricted = await readReport(report.reportId, false);
  assert.equal(pdfRestricted.sections.comparison.status, 'source_restricted');
  assert.equal(pdfRestricted.sections.comparison.value, null);
  assert.equal(pdfRestricted.sections.comparison.identity, null);
  assert.equal((await listReports()).reports.find(item => item.reportId === report.reportId).title, null);
  assert.equal(pdfRestricted.sections.funding.status, 'source_restricted');
  assert.equal(pdfRestricted.sections.funding.value, null);
  assert.equal(pdfRestricted.sections.law.status, 'available');
  assert.deepEqual(pdfRestricted.sections.law.value, report.sections.law.value);
  await allowSources([pdfSource]);

  // 3) 법령 출처(law_eflaw) 삭제(unknown) -> law만 제한, comparison·funding은 계속 이용 가능.
  await db.exec('reset role');
  await db.query('delete from public.source_registry where id = $1', [lawSource]);
  await as('authenticated', user);
  const lawRestricted = await readReport(report.reportId, false);
  assert.equal(lawRestricted.sections.comparison.status, 'available');
  assert.equal(lawRestricted.sections.funding.status, 'available');
  assert.deepEqual(lawRestricted.sections.law, {
    status: 'source_restricted',
    sources: [apt, lawSource],
    exportAllowed: false,
    value: null,
  });

  // 제한된 상태에서 새로 저장한 보고서는 law 본문을 저장하지 않는다(권한 복구 뒤에도 null 유지).
  const savedWhileLawRestricted = await saveReport(analysisId, run.runId, randomUUID());
  assert.equal(savedWhileLawRestricted.version, 2);
  assert.equal(savedWhileLawRestricted.sections.comparison.status, 'available');
  assert.equal(savedWhileLawRestricted.sections.funding.status, 'available');
  assert.equal(savedWhileLawRestricted.sections.law.status, 'source_restricted');
  assert.equal(savedWhileLawRestricted.sections.law.value, null);

  await db.exec('reset role');
  assert.equal(
    (await one('select law_value from private.saved_analysis_reports where report_id = $1', [savedWhileLawRestricted.reportId])).law_value,
    null,
  );
  await allowSources([lawSource]);
  await as('authenticated', user);
  // 기존 허용 시 저장한 v1은 복구되고, 제한 시 저장한 v2는 저장하지 않았으므로 계속 restricted다.
  assert.equal((await readReport(report.reportId)).sections.law.status, 'available');
  assert.equal((await readReport(savedWhileLawRestricted.reportId)).sections.law.status, 'source_restricted');
  assert.equal((await readReport(savedWhileLawRestricted.reportId)).sections.law.value, null);

  // 4) export_permission 단독 거부(unknown/denied) -> 일반 읽기는 available + exportAllowed:false, 내보내기 읽기는 export_restricted + null.
  for (const deniedExport of ['unknown', 'denied']) {
    await updateSource('apt_trade', { export_permission: deniedExport });
    await as('authenticated', user);
    const viewRead = await readReport(report.reportId, false);
    assert.equal(viewRead.sections.comparison.status, 'available');
    assert.equal(viewRead.sections.comparison.exportAllowed, false);
    assert.deepEqual(viewRead.sections.comparison.value, report.sections.comparison.value);
    assert.deepEqual(viewRead.sections.comparison.identity, report.sections.comparison.identity);
    assert.equal(viewRead.sections.funding.exportAllowed, true);
    assert.equal(viewRead.sections.law.exportAllowed, true);

    const exportRead = await readReport(report.reportId, true);
    assert.deepEqual(exportRead.sections.comparison, {
      status: 'export_restricted',
      sources: report.sections.comparison.sources,
      exportAllowed: false,
      value: null,
      identity: null,
    });
    assert.equal(exportRead.sections.funding.status, 'available');
    assert.equal(exportRead.sections.funding.exportAllowed, true);
    assert.deepEqual(exportRead.sections.funding.value, report.sections.funding.value);
    assert.equal(exportRead.sections.law.status, 'available');
    assert.equal(exportRead.sections.law.exportAllowed, true);
    assert.deepEqual(exportRead.sections.law.value, report.sections.law.value);
  }
  await allowSources(['apt_trade']);

  // law_eflaw만 export 거부
  await updateSource(lawSource, { export_permission: 'denied' });
  await as('authenticated', user);
  const lawExportOnly = await readReport(report.reportId, true);
  assert.equal(lawExportOnly.sections.comparison.status, 'available');
  assert.equal(lawExportOnly.sections.funding.status, 'available');
  assert.equal(lawExportOnly.sections.law.status, 'export_restricted');
  assert.equal(lawExportOnly.sections.law.exportAllowed, false);
  assert.equal(lawExportOnly.sections.law.value, null);
  await allowSources([lawSource]);

  // 5) 공식 PDF가 없는 실수집 수집본은 funding 출처에 applyhome_notice_pdf를 요구하지 않는다.
  const { analysisId: noPdfAnalysis } = await createAnalysis(user, { source: remainder, room: firstRoom });
  const noPdfRun = await finishCollectedRun(user, noPdfAnalysis, {
    source: remainder,
    selection: { modelNo, room: firstRoom },
    withEvidence: false,
    withSchedules: false,
    withOfficialPdf: false,
    withLaw: true,
  });
  await updateSource(apt, { display_permission: 'denied' });
  await updateSource(pdfSource, { display_permission: 'denied' });
  await as('authenticated', user);
  const noPdfReport = await saveReport(noPdfAnalysis, noPdfRun.runId, randomUUID());
  assert.equal(noPdfReport.sections.comparison.status, 'available');
  assert.equal(noPdfReport.sections.funding.status, 'available');
  assert.deepEqual(noPdfReport.sections.funding.sources, [remainder, `${remainder}_model`]);
  assert.equal(noPdfReport.sections.funding.value.scheduleStatus, 'unavailable');
  assert.equal(noPdfReport.sections.law.status, 'available');
  assert.deepEqual(noPdfReport.sections.law.sources, [lawSource, remainder].sort());
  await allowSources([apt, pdfSource]);

  // 6) 실수집 비교에서 source_ids가 비어 있으면 절대 허용으로 처리하지 않는다.
  await db.exec('reset role');
  await db.query("update private.comparison_results set source_ids = '{}'::text[] where run_id = $1", [run.runId]);
  await as('authenticated', user);
  const emptySourceReport = await saveReport(analysisId, run.runId, randomUUID());
  assert.deepEqual(emptySourceReport.sections.comparison, {
    status: 'source_restricted',
    sources: [],
    exportAllowed: false,
    value: null,
    identity: null,
  });
  assert.equal(emptySourceReport.sections.funding.status, 'available');
  assert.equal(emptySourceReport.sections.law.status, 'available');
  // 테이블 제약 자체가 실수집 빈 출처 목록 + comparison_value 저장을 차단한다.
  await db.exec('reset role');
  await assert.rejects(
    db.query(
      `update private.saved_analysis_reports
       set comparison_value = $2, comparison_identity = $3
       where report_id = $1`,
      [
        emptySourceReport.reportId,
        JSON.stringify(report.sections.comparison.value),
        JSON.stringify(report.sections.comparison.identity),
      ],
    ),
    /check constraint/,
  );
});

test('immutable snapshots preserve edits and historical periods, prune deleted funding entries, coexist with legacy reports, and cascade cleanly', async () => {
  const user = await createUser();
  const { analysisId } = await createAnalysis(user, { source: apt, room: firstRoom });
  const fundKeep = await addFund(user, analysisId, {
    kind: 'current',
    amountWon: '300000000',
    availableOn: '2026-10-20',
    certainty: 'confirmed',
  });
  const fundDelete = await addFund(user, analysisId, {
    kind: 'additional',
    amountWon: '100000000',
    availableOn: '2026-11-05',
    certainty: 'expected',
  });

  // 기존 public.reports 레거시 행(버전 1)을 먼저 삽입한다.
  await db.exec('reset role');
  const legacyRow = await one(
    `insert into public.reports(
       user_id, analysis_id, snapshot_version,
       result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot, queried_at
     ) values ($1, $2, 1, '{"legacy":true}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, now())
     returning id`,
    [user, analysisId],
  );

  // 첫 번째 실수집 실행(원래 기간 2026-10-10~2026-10-31)을 완료한다.
  const baseRun = await finishCollectedRun(user, analysisId, {
    source: apt,
    selection: { modelNo, room: firstRoom },
    withEvidence: true,
    withSchedules: true,
    withOfficialPdf: true,
    withLaw: true,
  });

  // 대화 기간 변경(2026-10-24~2026-10-26)을 승인해 동일 수집본의 역사적 실행(run2)을 생성한다.
  await as('authenticated', user);
  const conv = await rpc(
    'submit_analysis_chat_turn',
    analysisId, baseRun.runId, randomUUID(),
    '2026-10-24부터 2026-10-26까지 다시 비교해줘', 'change_period', '2026-10-24', '2026-10-26',
  );
  const decided = await rpc(
    'decide_analysis_chat_turn',
    analysisId, baseRun.runId, conv.turns[0].id, 'approve',
  );
  const narrowedRunId = decided.turns[0].proposal.resultRunId;
  await as('service_role');
  const narrowedJob = await rpc('claim_analysis_run', 300, narrowedRunId);
  const work = await rpc('read_comparison_work', narrowedJob.runId, narrowedJob.generation, narrowedJob.leaseToken);
  const narrowedComparison = runCompare(
    work.ingestion,
    work.conditions.comparison,
    work.evidence,
    work.comparisonPeriod,
  );
  await rpc(
    'finish_analysis_comparison',
    narrowedJob.runId, narrowedJob.generation, narrowedJob.leaseToken,
    null, null, json(narrowedComparison),
  );

  // 레거시 버전 1이 있으므로 첫 관리 저장은 버전 2, 역사적 기간 실행은 버전 3이 된다.
  await as('authenticated', user);
  const reportV2 = await saveReport(analysisId, baseRun.runId, randomUUID());
  const reportV3 = await saveReport(analysisId, narrowedRunId, randomUUID());
  assert.equal(reportV2.version, 2);
  assert.equal(reportV3.version, 3);
  assert.equal(reportV2.sections.comparison.value.conditions.period.start, '2026-10-10');
  assert.equal(reportV2.sections.comparison.value.conditions.period.end, '2026-10-31');
  assert.equal(reportV3.sections.comparison.value.conditions.period.start, '2026-10-24');
  assert.equal(reportV3.sections.comparison.value.conditions.period.end, '2026-10-26');
  assert.equal(reportV2.snapshotId, reportV3.snapshotId);

  // 레거시 행은 직접 SELECT에 보존되고 관리 RPC에서는 PT404며 목록에 섞이지 않는다.
  const directRows = (await db.query('select id, result_snapshot from public.reports')).rows;
  assert.deepEqual(directRows, [{ id: legacyRow.id, result_snapshot: { legacy: true } }]);
  await assert.rejects(readReport(legacyRow.id), reportNotFound);
  await assert.rejects(deleteReport(legacyRow.id), reportNotFound);
  await assert.rejects(listReports(legacyRow.id), cursorNotFound);

  // 이후 분석 조건·규칙 버전·법령 판본·자금 수정·자금 추가가 발생해도 기존 저장 보고서는 불변이다.
  await db.exec('reset role');
  await db.query(
    "update public.analyses set conditions_snapshot = '{}'::jsonb, rules_version = 'prd-2.0' where id = $1",
    [analysisId],
  );
  await as('service_role');
  await rpc('publish_law_reference', json(laterLawReference));
  await as('authenticated', user);
  await db.query('update public.funding_entries set amount_won = 999999999 where id = $1', [fundKeep.id]);
  await addFund(user, analysisId, {
    kind: 'additional',
    amountWon: '777000000',
    availableOn: '2026-12-01',
    certainty: 'confirmed',
  });

  const rereadV2 = await readReport(reportV2.reportId);
  assert.equal(rereadV2.rulesVersion, 'prd-1.0');
  assert.deepEqual(rereadV2.sections.law.value.reference, lawReference);
  assert.deepEqual(rereadV2.sections.funding.value.funds, [fundKeep, fundDelete]);

  // 개별 자금 항목 삭제 시 해당 항목만 고정 보고서에서 정리되고, 수정된 다른 항목의 원래 고정 금액은 유지된다.
  await db.exec('reset role');
  await db.query('delete from public.funding_entries where id = $1', [fundDelete.id]);
  await as('authenticated', user);
  const afterFundDeleteV2 = await readReport(reportV2.reportId);
  const afterFundDeleteV3 = await readReport(reportV3.reportId);
  assert.deepEqual(afterFundDeleteV2.sections.funding.value.funds, [fundKeep]);
  assert.deepEqual(afterFundDeleteV3.sections.funding.value.funds, [fundKeep]);
  assert.equal(afterFundDeleteV2.sections.funding.value.funds[0].amountWon, '300000000');

  // 실행 삭제 시 해당 실행의 보고서만 public.reports까지 고아 없이 연쇄 정리되고 다른 실행 보고서는 보존된다.
  await db.exec('reset role');
  await db.query('delete from private.analysis_runs where id = $1', [narrowedRunId]);
  assert.equal(await one('select id from public.reports where id = $1', [reportV3.reportId]), undefined);
  assert.equal(await one('select report_id from private.saved_analysis_reports where report_id = $1', [reportV3.reportId]), undefined);
  assert.ok(await one('select id from public.reports where id = $1', [reportV2.reportId]));
  assert.ok(await one('select id from public.reports where id = $1', [legacyRow.id]));

  // 분석 삭제 시 레거시·관리 보고서 모두 연쇄 삭제된다.
  await db.query('delete from public.analyses where id = $1', [analysisId]);
  assert.equal((await one('select count(*)::int as n from public.reports where analysis_id = $1', [analysisId])).n, 0);
  assert.equal((await one('select count(*)::int as n from private.saved_analysis_reports where analysis_id = $1', [analysisId])).n, 0);
});

test('idempotency, request conflicts, explicit new versions, unfinished runs, deletion, and latest-first metadata-only paging work cleanly', async () => {
  const userA = await createUser();
  const userB = await createUser();
  const { analysisId: analysisA } = await createAnalysis(userA);
  const { analysisId: analysisA2 } = await createAnalysis(userA);
  const { analysisId: analysisB } = await createAnalysis(userB);

  // 미완료(queued) 및 BE-04 단독 완료(비교 결과 없음) 실행은 PT409다.
  await as('authenticated', userA);
  const queued = await rpc('enqueue_analysis_run', analysisA, randomUUID(), json(syntheticInput));
  const noComp = await rpc('enqueue_analysis_run', analysisA, randomUUID(), json(syntheticInput));
  await as('service_role');
  const noCompJob = await rpc('claim_analysis_run', 300, noComp.runId);
  const { input, result } = replays.get(apt);
  await rpc('finish_analysis_run', noCompJob.runId, noCompJob.generation, noCompJob.leaseToken, json(input), json(result));

  await as('authenticated', userA);
  await assert.rejects(saveReport(analysisA, queued.runId, randomUUID()), notReady);
  await assert.rejects(saveReport(analysisA, noComp.runId, randomUUID()), notReady);

  const run1 = await finishSyntheticRun(userA, analysisA, { withSchedules: false });
  const run2 = await finishSyntheticRun(userA, analysisA2, { withSchedules: false });
  const runB = await finishSyntheticRun(userB, analysisB, { withSchedules: false });

  // 동일 request_id의 동시·순차 재시도는 멱등하게 동일 보고서를 반환한다.
  await as('authenticated', userA);
  const req1 = randomUUID();
  const [first, retry] = await Promise.all([
    saveReport(analysisA, run1.runId, req1),
    saveReport(analysisA, run1.runId, req1),
  ]);
  assert.deepEqual(first, retry);
  assert.equal(first.version, 1);

  // 같은 request_id를 다른 본인 실행에 재사용하면 PT409다.
  await assert.rejects(saveReport(analysisA2, run2.runId, req1), requestConflict);
  await assert.rejects(saveReport(analysisA, queued.runId, req1), requestConflict);
  // 타인 실행에 같은 request_id를 쓰면 충돌이 아니라 PT404가 먼저 반환된다.
  await assert.rejects(saveReport(analysisB, runB.runId, req1), runNotFound);

  // 두 번째 명시적 저장(새 request_id)은 새 버전(v2)을 발급한다.
  const secondRequest = randomUUID();
  const second = await saveReport(analysisA, run1.runId, secondRequest);
  assert.equal(second.version, 2);
  assert.notEqual(second.reportId, first.reportId);

  // 삭제는 void 반환이며, 삭제 후 재조회·재삭제는 PT404이고 이후 새 저장은 버전 3으로 단조 증가한다.
  assert.equal(await deleteReport(second.reportId), null);
  await assert.rejects(saveReport(analysisA, run1.runId, secondRequest), { code: 'PT409', message: 'report_request_retired' });
  await assert.rejects(readReport(second.reportId), reportNotFound);
  await assert.rejects(deleteReport(second.reportId), reportNotFound);
  const third = await saveReport(analysisA, run1.runId, randomUUID());
  assert.equal(third.version, 3);
  // 보고서 삭제는 원본 분석·실행·수집본을 지우지 않는다.
  assert.equal((await rpc('get_analysis_run', analysisA, run1.runId)).status, 'finished');

  // 출처가 철회된 실수집 보고서도 소유자가 삭제할 수 있다.
  const { analysisId: collectedAnalysis } = await createAnalysis(userA, { source: apt, room: firstRoom });
  const collectedRun = await finishCollectedRun(userA, collectedAnalysis);
  await as('authenticated', userA);
  const collectedReport = await saveReport(collectedAnalysis, collectedRun.runId, randomUUID());
  await updateSource(apt, { display_permission: 'denied' });
  await as('authenticated', userA);
  assert.equal((await readReport(collectedReport.reportId)).sections.comparison.status, 'source_restricted');
  assert.equal(await deleteReport(collectedReport.reportId), null);
  await assert.rejects(readReport(collectedReport.reportId), reportNotFound);

  // 35건 저장 후 최신순 30건 커서 페이징과 메타데이터 전용 목록 계약을 검증한다.
  const createdIds = [first.reportId, third.reportId];
  for (let i = 0; i < 33; i += 1) {
    const targetAnalysis = i % 2 === 0 ? analysisA : analysisA2;
    const targetRun = i % 2 === 0 ? run1.runId : run2.runId;
    const item = await saveReport(targetAnalysis, targetRun, randomUUID());
    createdIds.push(item.reportId);
  }
  const expectedOrder = [...createdIds].reverse();

  const page1 = await listReports();
  assert.equal(page1.reports.length, 30);
  assert.equal(page1.nextCursor, page1.reports[29].reportId);
  assert.deepEqual(page1.reports.map(r => r.reportId), expectedOrder.slice(0, 30));
  for (const item of page1.reports) {
    assert.deepEqual(Object.keys(item).sort(), [
      'analysisId', 'createdAt', 'dataOrigin', 'queriedAt', 'reportId', 'runId', 'title', 'version',
    ]);
  }
  const listText = JSON.stringify(page1);
  assert.ok(!listText.includes('9900000001'));
  assert.ok(page1.reports.every(row => row.title === '합성 가람 아파트'));
  assert.ok(!listText.includes('700000000'));

  const page2 = await listReports(page1.nextCursor);
  assert.equal(page2.reports.length, 5);
  assert.equal(page2.nextCursor, null);
  assert.deepEqual(page2.reports.map(r => r.reportId), expectedOrder.slice(30));

  // 사용자 B 목록은 비어 있다.
  await as('authenticated', userB);
  assert.deepEqual(await listReports(), { reports: [], nextCursor: null });
});

test('save-time restriction on comparison/funding, idempotent retry under revocation, missing law/date/title metadata, export PDF-only denial, and user deletion cascade', async () => {
  const userA = await createUser();
  const userB = await createUser();
  const { analysisId: analysisA } = await createAnalysis(userA, { source: apt, room: firstRoom });
  const { analysisId: analysisB } = await createAnalysis(userB, { source: apt, room: firstRoom });
  const fundA = await addFund(userA, analysisA, { amountWon: '180000000' });

  // 법령 미게시(version_unverified) 상태의 실수집 실행을 완료한다.
  const runA = await finishCollectedRun(userA, analysisA, {
    source: apt,
    selection: { modelNo, room: firstRoom },
    withEvidence: true,
    withSchedules: true,
    withOfficialPdf: true,
    withLaw: false,
  });
  await allowSources([lawSource]);

  // 1) 법령 판본 미게시 상태에서 저장 -> law.status = 'available', value.status = 'version_unverified'.
  //    이후 법령이 게시돼도 기존 보고서는 불변이다.
  await as('authenticated', userA);
  const reqV1 = randomUUID();
  const r1 = await saveReport(analysisA, runA.runId, reqV1);
  assert.equal(r1.sections.law.status, 'available');
  assert.equal(r1.sections.law.value.status, 'version_unverified');
  assert.equal(r1.sections.law.value.reference, null);

  const runB = await finishCollectedRun(userB, analysisB, {
    source: apt,
    selection: { modelNo, room: firstRoom },
    withEvidence: true,
    withSchedules: true,
    withOfficialPdf: true,
    withLaw: true,
  });
  await as('authenticated', userA);
  assert.equal((await readReport(r1.reportId)).sections.law.value.status, 'version_unverified');

  // 2) 자금 수정 + apt_trade 철회 뒤 동일 reqV1 재시도는 새 버전을 만들지 않고 현재 권한으로 고정본을 반환한다.
  await db.query('update public.funding_entries set amount_won = 444000000 where id = $1', [fundA.id]);
  await updateSource('apt_trade', { display_permission: 'denied' });
  await as('authenticated', userA);
  const retried = await saveReport(analysisA, runA.runId, reqV1);
  assert.equal(retried.reportId, r1.reportId);
  assert.equal(retried.version, 1);
  assert.equal(retried.sections.comparison.status, 'source_restricted');
  assert.equal(retried.sections.comparison.value, null);
  assert.equal(retried.sections.comparison.identity, null);
  assert.equal(retried.sections.funding.status, 'available');
  assert.equal(retried.sections.funding.value.funds[0].amountWon, '180000000');

  // 3) apt_trade와 applyhome_notice_pdf가 철회된 상태에서 새 저장 -> comparison·funding은 저장하지 않고 law만 저장한다.
  await updateSource(pdfSource, { display_permission: 'denied' });
  await as('authenticated', userA);
  const r2 = await saveReport(analysisA, runA.runId, randomUUID());
  assert.equal(r2.version, 2);
  assert.equal(r2.sections.comparison.status, 'source_restricted');
  assert.equal(r2.sections.comparison.value, null);
  assert.equal(r2.sections.funding.status, 'source_restricted');
  assert.equal(r2.sections.funding.value, null);
  assert.equal(r2.sections.law.status, 'available');
  assert.equal(r2.sections.law.value.status, 'available');
  assert.deepEqual(r2.sections.law.value.reference, lawReference);

  await db.exec('reset role');
  const rawR2 = await one(
    'select comparison_value, comparison_identity, funding_value, funding_state from private.saved_analysis_reports where report_id = $1',
    [r2.reportId],
  );
  assert.deepEqual(rawR2, {
    comparison_value: null,
    comparison_identity: null,
    funding_value: null,
    funding_state: 'source_restricted',
  });
  // 권한 복구 후에도 제한 시점에 저장된 r2의 comparison·funding은 계속 source_restricted다.
  await allowSources(['apt_trade', pdfSource]);
  await as('authenticated', userA);
  const r2AfterRestore = await readReport(r2.reportId);
  assert.equal(r2AfterRestore.sections.comparison.status, 'source_restricted');
  assert.equal(r2AfterRestore.sections.funding.status, 'source_restricted');
  assert.equal(r2AfterRestore.sections.law.status, 'available');

  // 4) applyhome_notice_pdf만 export_permission 거부 -> 내보내기에서 comparison·funding은 export_restricted, law는 available.
  await updateSource(pdfSource, { export_permission: 'denied' });
  await as('authenticated', userA);
  const r1View = await readReport(r1.reportId);
  assert.equal(r1View.sections.comparison.status, 'available');
  assert.equal(r1View.sections.comparison.exportAllowed, false);
  assert.equal(r1View.sections.funding.status, 'available');
  assert.equal(r1View.sections.funding.exportAllowed, false);
  assert.equal(r1View.sections.law.status, 'available');
  assert.equal(r1View.sections.law.exportAllowed, true);
  const r1Export = await readReport(r1.reportId, true);
  assert.equal(r1Export.sections.comparison.status, 'export_restricted');
  assert.equal(r1Export.sections.comparison.value, null);
  assert.equal(r1Export.sections.comparison.identity, null);
  assert.equal(r1Export.sections.funding.status, 'export_restricted');
  assert.equal(r1Export.sections.funding.value, null);
  assert.equal(r1Export.sections.law.status, 'available');
  assert.equal(r1Export.sections.law.exportAllowed, true);
  await allowSources([pdfSource]);

  // 5) 공고일·공고명이 누락된 실수집 수집본은 identity에 null을 보존하고 law는 law_eflaw 없이 공고 피드만 요구한다.
  const { analysisId: untimedAnalysis } = await createAnalysis(userA, { source: apt, room: null });
  const untimedRun = await finishCollectedRun(userA, untimedAnalysis, {
    source: apt,
    selection: { modelNo },
    withEvidence: false,
    withSchedules: false,
    withOfficialPdf: false,
    withLaw: false,
    adjustIngestion: snap => {
      delete snap.catalog.notice.fields.RCRIT_PBLANC_DE;
      delete snap.catalog.notice.fields.HOUSE_NM;
    },
  });
  await updateSource(lawSource, { display_permission: 'denied' });
  await as('authenticated', userA);
  const untimedReport = await saveReport(untimedAnalysis, untimedRun.runId, randomUUID());
  assert.equal(untimedReport.sections.comparison.identity.noticeDate, null);
  assert.equal(untimedReport.sections.comparison.identity.title, null);
  assert.equal(untimedReport.sections.law.status, 'available');
  assert.deepEqual(untimedReport.sections.law.sources, [apt]);
  assert.equal(untimedReport.sections.law.value.status, 'notice_date_unverified');
  assert.equal(untimedReport.sections.law.value.noticeDate, null);
  await allowSources([lawSource]);

  // 6) comparison_results 삭제 시 고아 없이 정리되고, 계정 삭제는 타인의 보고서를 건드리지 않고 본인 행만 연쇄 삭제한다.
  await as('authenticated', userB);
  const reportB = await saveReport(analysisB, runB.runId, randomUUID());

  await db.exec('reset role');
  await db.query('delete from private.comparison_results where run_id = $1', [untimedRun.runId]);
  assert.equal(await one('select id from public.reports where id = $1', [untimedReport.reportId]), undefined);
  assert.equal(await one('select report_id from private.saved_analysis_reports where report_id = $1', [untimedReport.reportId]), undefined);

  await db.query('delete from auth.users where id = $1', [userA]);
  for (const tbl of [
    'public.reports',
    'private.saved_analysis_reports',
    'private.saved_report_funding_refs',
  ]) {
    assert.equal((await one(`select count(*)::int as n from ${tbl} where user_id = $1`, [userA])).n, 0, tbl);
  }
  await as('authenticated', userB);
  assert.deepEqual(await readReport(reportB.reportId), reportB);
});
