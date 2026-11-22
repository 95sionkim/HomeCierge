// 합성 청약홈·실거래 응답과 PGlite로 실행 및 권한 경계를 검사한다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBe03Db } from './helpers/be03-db.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const koreanDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });
const noticeFeeds = ['applyhome_apt', 'applyhome_remainder'];
const sourceIds = [...noticeFeeds, ...noticeFeeds.map(feed => `${feed}_model`),
  'mois_legal_region_codes', 'apt_trade', 'apt_rights', 'applyhome_notice_pdf'];
const tradeKinds = ['sale', 'presale_right', 'occupancy_right'];
const regionCode = '99999';
const modelNo = '01';
const houseType = '084.0000A';
const fixtureBasis = '2026-11-10';
const identity = { houseManageNo: '9900000001', noticeNo: '9900000042' };
const forbidden = { code: '42501' };
const missing = { code: 'PT404' };
const staleLease = { code: 'PT409', message: 'analysis_run_stale_lease' };
const restricted = { code: 'PT403', message: 'notice_source_restricted' };
const invalidComparison = { code: '22023', message: 'invalid_notice_comparison_result' };
let db;

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function as(role, userId = '', anonymous = false) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claims',$2,false)",
    [userId, JSON.stringify({ sub: userId, is_anonymous: anonymous })]);
  await db.exec(`set role ${role}`);
}

async function rpc(name, ...params) {
  const args = params.map((_, position) => `$${position + 1}`).join(', ');
  return (await one(`select public.${name}(${args}) as value`, params)).value;
}

async function createAnalysis(conditions = {}, verified = true) {
  const userId = randomUUID();
  await db.exec('reset role');
  await db.query('insert into auth.users(id,confirmed_at) values ($1,case when $2 then now() end)', [userId, verified]);
  await as('authenticated', userId);
  const chat = await one('insert into public.chats(user_id) values ($1) returning id', [userId]);
  const analysis = await one(`insert into public.analyses (user_id,chat_id,conditions_snapshot)
    values ($1,$2,$3) returning id`, [userId, chat.id, JSON.stringify(conditions)]);
  return { userId, analysisId: analysis.id };
}

function listing(feed = noticeFeeds[0], observed = new Date()) {
  const day = koreanDate.format(observed);
  return {
    contractVersion: 'notice-search-index/v1', dataOrigin: 'collected', observedAt: observed.toISOString(),
    publicationWindow: { start: day, end: day }, regionCodes: [regionCode],
    coverage: { status: 'complete', sources: noticeFeeds.map(source => ({ source,
      status: source === feed ? 'complete' : 'empty' })) },
    notices: [{ ...identity, edition: day, title: '합성 가람 아파트', kind: feed === noticeFeeds[0] ? 'new_sale' : 'resupply',
      regionCode, moveIn: null, application: { start: day, end: day }, inventoryComplete: false,
      models: [{ modelNo, houseType, supplyAreaM2: null, areaEvidence: [], rooms: [] }],
      sourceIds: [feed, `${feed}_model`], reasonCodes: [],
    }],
  };
}

function choice(index) {
  const { houseManageNo, noticeNo, edition, sourceIds: [noticeSource] } = index.notices[0];
  return { kind: 'notice', noticeSource, houseManageNo, noticeNo, edition, modelNo };
}

const publish = index => rpc('publish_notice_directory', JSON.stringify(index), JSON.stringify({ [regionCode]: '합성 가람구' }));
const enqueue = (owner, input, key = randomUUID()) => rpc('enqueue_analysis_run', owner.analysisId, key, JSON.stringify(input));
const cancel = (owner, run) => rpc('cancel_analysis_run', owner.analysisId, run.runId);
const claim = run => rpc('claim_analysis_run', 300, run.runId);
const lease = job => [job.runId, job.generation, job.leaseToken];
const work = job => rpc('read_comparison_work', ...lease(job));
const fail = (job, retryable, code) => rpc('fail_notice_analysis_run', ...lease(job), retryable, code);
const finish = (job, request, result) => rpc('finish_analysis_run', ...lease(job),
  request === null ? null : JSON.stringify(request), result === null ? null : JSON.stringify(result));
const finishComparison = (job, { request, result, comparison }) => rpc('finish_analysis_comparison', ...lease(job),
  JSON.stringify(request), JSON.stringify(result), JSON.stringify(comparison));
const getComparison = (owner, run) => rpc('get_analysis_comparison', owner.analysisId, run.runId);
const getRun = (owner, run) => rpc('get_analysis_run', owner.analysisId, run.runId);
const analysisRow = owner => one('select status,latest_run_id,conditions_snapshot from public.analyses where id=$1', [owner.analysisId]);
const captureCount = async owner => (await one(`select count(*)::int as n from public.analysis_input_snapshots
  where analysis_id=$1`, [owner.analysisId])).n;

async function start(owner, index = listing(), basisDate = null) {
  await as('service_role');
  await publish(index);
  const input = choice(index);
  const key = randomUUID();
  await as('authenticated', owner.userId);
  const run = await enqueue(owner, input, key);
  if (basisDate !== null) {
    // 캡처 회귀는 연도와 무관하게 같은 계약월을 사용한다. 접수일 고정 자체는 별도로 검사한다.
    await db.exec('reset role');
    await db.query(`update private.analysis_runs set basis_date=$2::text::date,
      notice_request=jsonb_set(notice_request,'{asOf}',to_jsonb($2::text)) where id=$1`, [run.runId, basisDate]);
  }
  await as('service_role');
  const job = await claim(run);
  return { input, run, key, job, captureWork: await work(job) };
}

function capture(input, captureWork, { pdf = false, failedTrade = false, period = {} } = {}) {
  const { kind, modelNo, noticeSource, ...target } = input;
  const { asOf, requestRegionCodes } = captureWork.noticeCapture;
  const request = { noticeSource, target, asOf, requestRegionCodes, tradeKinds, pageSize: 100, ...period };
  const python = `
import json
import sys
from pathlib import Path
sys.path.insert(0, 'scripts')
from compare_trades import compare_snapshot
from replay_ingestion import ingest

request, model_no, use_pdf, failed_trade = json.load(sys.stdin)
sample = json.loads(Path('tests/fixtures/ingestion-v0.json').read_text())
feed, target = request['noticeSource'], request['target']
notice, model = [dict(p['body']['data'][0], HOUSE_MANAGE_NO=target['houseManageNo'], PBLANC_NO=target['noticeNo'])
                 for p in sample['pages'][:2]]
notice['RCRIT_PBLANC_DE'] = target['edition']
model['MODEL_NO'] = model_no

def fetch(source, scope, page, page_size):
    entry = dict(source=source, scope=scope, page=page, pageSize=page_size,
                 observedAt=request['asOf'] + 'T00:00:00Z', httpStatus=200)
    if source in (feed, feed + '_model'):
        entry['body'] = dict(page=page, perPage=page_size, currentCount=1, matchCount=1, totalCount=1,
                             data=[notice if source == feed else model])
    elif failed_trade and source == 'apt_trade':
        entry.update(httpStatus=503, body=None)
    else:
        entry['body'] = {'response': {'header': {'resultCode': '000', 'resultMsg': 'OK'},
            'body': {'pageNo': page, 'numOfRows': page_size, 'totalCount': 0, 'items': {}}}}
    return entry

evidence = [dict(item, document={**item['document'], **target}) for item in sample['evidence']] if use_pdf else []
# 테스트의 권한 분기를 실행하는 합성 값이다. 실제 제공기관 응답이나 계정 자료는 사용하지 않는다.
result = ingest(request, fetch, data_origin='collected', evidence=evidence)
comparison = compare_snapshot(result, {'modelNo': model_no}, evidence=None)
print(json.dumps({'result': result, 'comparison': comparison}, ensure_ascii=False))
`;
  const json = execFileSync('python3', ['-c', python], {
    cwd: root, encoding: 'utf8', input: JSON.stringify([request, modelNo, pdf, failedTrade]),
  });
  return { request, ...JSON.parse(json) };
}

async function setPermission(source, column, value) {
  await db.query(`update public.source_registry set ${column}=$2 where id=$1`, [source, value]);
}

before(async () => {
  db = await createBe03Db();
  await db.exec(`alter table auth.users add column confirmed_at timestamptz,
    add column is_anonymous boolean not null default false,
    add column banned_until timestamptz, add column deleted_at timestamptz`);
});

beforeEach(async () => {
  await db.exec('reset role; delete from private.notice_search_index; delete from private.notice_directory_publication;');
  await db.query(`insert into public.source_registry(id,display_name,storage_permission,reuse_permission,display_permission)
    select id,'합성 출처','allowed','allowed','allowed' from unnest($1::text[]) source(id)
    on conflict (id) do update set storage_permission='allowed', reuse_permission='allowed',
      display_permission='allowed', retention_days=null`, [sourceIds]);
});

after(async () => db?.close());

test('a leased notice stores validated payments and its comparison atomically for the owner', async () => {
  const owner = await createAnalysis(), peer = await createAnalysis();
  const {input,job,captureWork} = await start(owner,listing(),fixtureBasis);
  const {request,result,comparison} = capture(input,captureWork,{pdf:true});
  const room = '101동 101호';
  const schedules = [['sale_price','700000000',7],['required_options','10000000',8]].map(([item,won,page]) => {
    const evidence = [{document:'synthetic-notice-pdf',version:'synthetic-v1',page}];
    return {item,room,modelNo,houseType,status:'confirmed',totalWon:won,reasons:[],evidence,
      installments:[{stage:'balance',won,timing:{trigger:'calendar_date',dateStatus:'exact',date:'2026-11-30',evidence}}]};
  });
  const finishScheduled = rows => rpc('finish_notice_with_funding', ...lease(job), JSON.stringify(request), JSON.stringify(result),
    JSON.stringify(comparison),JSON.stringify(rows));
  await as('authenticated',owner.userId);
  await assert.rejects(finishScheduled(schedules),forbidden);
  await as('service_role');
  await assert.rejects(finishScheduled([{...schedules[0],totalWon:'1'}]),{code:'22023'});
  assert.equal(await captureCount(owner),0);
  const saved = await finishScheduled(schedules);
  assert.equal(saved.status,'finished');
  await assert.rejects(finishScheduled(schedules),staleLease);
  const read = () => rpc('read_analysis_funding_inputs',owner.analysisId,saved.snapshotId,modelNo,room);
  await as('authenticated',owner.userId);
  const planInput = await read();
  assert.equal(planInput.scheduleStatus,'available');
  assert.deepEqual(planInput.schedules,schedules);
  await as('authenticated',peer.userId);
  await assert.rejects(read(),missing);
});

test('a verified owner pins the chosen remainder notice and model on an unlinked draft', async () => {
  const original = { comparison: { room: '101동 101호' }, budget_max_won: '800000000' };
  const owner = await createAnalysis(original);
  assert.deepEqual(await analysisRow(owner), { status: 'draft', latest_run_id: null, conditions_snapshot: original });
  await as('service_role');
  await setPermission('applyhome_notice_pdf', 'display_permission', 'unknown');
  const { captureWork, input, job, run } = await start(owner, listing(noticeFeeds[1]));
  const pinned = { ...original, ingestion_target: { noticeSource: input.noticeSource, ...identity, edition: input.edition },
    comparison: { ...original.comparison, modelNo } };
  assert.equal(run.status, 'queued');
  assert.equal(run.snapshotId, null);
  assert.deepEqual(job.input, input);
  assert.deepEqual(captureWork, { conditions: pinned, ingestion: null, evidence: null,
    useSyntheticFixture: false, selectionBindingIssue: null, noticeCapture: {
      asOf: koreanDate.format(new Date(run.submittedAt)), requestRegionCodes: [regionCode], allowOfficialPdf: false,
    } });
  await as('authenticated', owner.userId);
  assert.deepEqual(await analysisRow(owner), { status: 'running', latest_run_id: run.runId, conditions_snapshot: pinned });
});

test('JWT ownership and verified login guard notice submissions and worker operations', async () => {
  const owner = await createAnalysis();
  const peer = await createAnalysis();
  const unconfirmed = await createAnalysis({}, false);
  const index = listing();
  const input = choice(index);
  await as('service_role');
  await publish(index);
  await assert.rejects(enqueue(owner, input), forbidden);
  await as('anon');
  await assert.rejects(enqueue(owner, input), forbidden);
  await as('authenticated', unconfirmed.userId);
  await assert.rejects(enqueue(unconfirmed, input), forbidden);
  await as('authenticated', owner.userId, true);
  await assert.rejects(enqueue(owner, input), forbidden);
  await as('authenticated', peer.userId);
  await assert.rejects(enqueue(owner, input), missing);
  await as('authenticated', owner.userId);
  const run = await enqueue(owner, input);
  const guessed = { ...run, generation: 1, leaseToken: randomUUID() };
  await assert.rejects(claim(run), forbidden);
  await assert.rejects(work(guessed), forbidden);
  await assert.rejects(finish(guessed, null, null), forbidden);
  await assert.rejects(finishComparison(guessed, { request: null, result: null, comparison: null }), forbidden);
  await assert.rejects(fail(guessed, false, 'notice_feed_unavailable'), forbidden);
  await assert.rejects(rpc('save_ingestion_snapshot', owner.userId, owner.analysisId, run.runId, null, null), forbidden);
  await assert.rejects(db.query('update public.analyses set conditions_snapshot=$2 where id=$1', [owner.analysisId, '{}']),
    forbidden);
  await as('authenticated', peer.userId);
  await assert.rejects(getRun(owner, run), missing);
  await assert.rejects(cancel(owner, run), missing);
  await assert.rejects(getComparison(owner, run), missing);
});

test('only a verifiable selection in the available published index can create a run', async () => {
  const owner = await createAnalysis();
  const index = listing();
  const input = choice(index);
  await assert.rejects(enqueue(owner, input), { code: 'PT409', message: 'notice_index_not_ready' });
  await as('service_role');
  await publish(index);
  await as('authenticated', owner.userId);
  for (const [change, message] of [
    [{ houseManageNo: '9900000002' }, 'notice_not_found'],
    [{ noticeNo: '9900000043' }, 'notice_not_found'],
    [{ noticeSource: noticeFeeds[1] }, 'notice_source_conflict'],
    [{ edition: '2000-01-01' }, 'notice_edition_mismatch'],
    [{ modelNo: '02' }, 'notice_model_not_found'],
  ]) {
    await assert.rejects(enqueue(owner, { ...input, ...change }), { code: 'PT409', message });
  }
  for (const change of [{ modelNo: 1 }, { houseManageNo: '9900000001\n' }, { requestRegionCodes: [regionCode] }]) {
    await assert.rejects(enqueue(owner, { ...input, ...change }), { code: '22023' });
  }
  const replacePublished = async (next, message, selection = input) => {
    await db.exec('reset role; delete from private.notice_directory_publication;');
    await as('service_role');
    await publish(next);
    await as('authenticated', owner.userId);
    await assert.rejects(enqueue(owner, selection), { code: 'PT409', message });
  };
  await replacePublished({ ...index, notices: [{ ...index.notices[0], regionCode: null }] }, 'notice_region_unverified');
  await replacePublished({ ...index, notices: [{ ...index.notices[0], kind: 'unsupported' }] }, 'notice_kind_unsupported');
  await replacePublished({ ...index, notices: [{ ...index.notices[0], edition: 'public' }] },
    'notice_edition_unverified', { ...input, edition: 'public' });
  await replacePublished({ ...index, notices: [{ ...index.notices[0], models: [{ ...index.notices[0].models[0], houseType: null }] }] },
    'notice_model_unverified');
  await db.exec('reset role');
  await db.query(`update private.notice_directory_publication set index_value=jsonb_set(index_value,'{observedAt}',$1)`,
    [JSON.stringify(new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString())]);
  await as('authenticated', owner.userId);
  await assert.rejects(enqueue(owner, input), { code: 'PT409', message: 'notice_index_not_ready' });
  assert.deepEqual(await analysisRow(owner), { status: 'draft', latest_run_id: null, conditions_snapshot: {} });
});

test('the same key restores its run after replacement while a conflicting explicit choice stays intact', async () => {
  const index = listing();
  const input = choice(index);
  const chosen = { housingType: { modelNo: '02' }, comparison: { room: '101동 101호' } };
  const conflicting = await createAnalysis(chosen);
  const otherTarget = { ingestion_target: { ...identity, noticeSource: noticeFeeds[0], edition: '2000-01-01' } };
  const conflictingTarget = await createAnalysis(otherTarget);
  const owner = await createAnalysis();
  await as('service_role');
  await publish(index);
  await as('authenticated', conflicting.userId);
  await assert.rejects(enqueue(conflicting, input), { code: 'PT409', message: 'analysis_notice_selection_conflict' });
  assert.deepEqual(await analysisRow(conflicting), { status: 'draft', latest_run_id: null, conditions_snapshot: chosen });
  await as('authenticated', conflictingTarget.userId);
  await assert.rejects(enqueue(conflictingTarget, input), { code: 'PT409', message: 'analysis_notice_selection_conflict' });
  assert.deepEqual(await analysisRow(conflictingTarget), { status: 'draft', latest_run_id: null, conditions_snapshot: otherTarget });

  await as('authenticated', owner.userId);
  const key = randomUUID();
  const run = await enqueue(owner, input, key);
  assert.deepEqual(await enqueue(owner, input, key), run);
  const replacement = listing(noticeFeeds[0], new Date(Date.now() + 1000));
  replacement.notices[0].models[0].modelNo = '02';
  await as('service_role');
  await publish(replacement);
  await setPermission('apt_trade', 'reuse_permission', 'denied');
  await as('authenticated', owner.userId);
  assert.deepEqual(await enqueue(owner, input, key), run);
  await assert.rejects(enqueue(owner, { ...input, modelNo: '02' }, key),
    { code: 'PT409', message: 'analysis_run_idempotency_conflict' });
  await assert.rejects(enqueue(owner, input), restricted);
  assert.equal((await analysisRow(owner)).latest_run_id, run.runId);
});

test('the fresh capture is checked against the frozen request and the real notice and model observations', async () => {
  const owner = await createAnalysis();
  await as('service_role');
  await setPermission('applyhome_notice_pdf', 'storage_permission', 'unknown');
  const { input, run, key, job, captureWork } = await start(owner, listing(), fixtureBasis);
  assert.equal(captureWork.noticeCapture.allowOfficialPdf, false);
  const valid = capture(input, captureWork, { failedTrade: true });
  const invalid = { code: '22023' };
  await assert.rejects(rpc('save_ingestion_snapshot', owner.userId, owner.analysisId, run.runId,
    JSON.stringify(valid.request), JSON.stringify(valid.result)), { code: '42501', message: 'analysis_run_fence_required' });
  for (const request of [
    { ...valid.request, asOf: '2000-01-01' },
    { ...valid.request, target: { ...valid.request.target, edition: '2000-01-01' } },
    { ...valid.request, noticeSource: noticeFeeds[1] },
    { ...valid.request, requestRegionCodes: ['99998'] },
    { ...valid.request, tradeKinds: ['sale'] },
    { ...valid.request, start: '2000-01-01', end: '2000-01-02' },
  ]) {
    await assert.rejects(finish(job, request, valid.result), invalid);
  }
  await assert.rejects(finish(job, valid.request, { ...valid.result, dataOrigin: 'synthetic' }), invalid);

  const swappedRegion = structuredClone(valid.result);
  swappedRegion.tradeBatches[0].record.requestRegionCode = '99998';
  await assert.rejects(finish(job, valid.request, swappedRegion), invalid);
  const swappedMonth = structuredClone(valid.result);
  swappedMonth.tradeBatches[0].record.month = '1999-01';
  await assert.rejects(finish(job, valid.request, swappedMonth), invalid);

  const shortPeriod = capture(input, captureWork, { period: { start: valid.request.asOf, end: valid.request.asOf } }).result;
  shortPeriod.period.source = 'default_recent_year';
  await assert.rejects(finish(job, valid.request, shortPeriod), invalid);
  const alteredEdition = structuredClone(valid.result);
  alteredEdition.catalog.notice.fields.RCRIT_PBLANC_DE.value = '2000-01-01';
  await assert.rejects(finish(job, valid.request, alteredEdition), { code: 'PT422' });
  const partialNotice = structuredClone(valid.result);
  partialNotice.catalog.collections.notice.status = 'partial';
  await assert.rejects(finish(job, valid.request, partialNotice), { code: 'PT422' });
  const missingModelProof = structuredClone(valid.result);
  missingModelProof.catalog.housingTypes[0].evidence = [];
  await assert.rejects(finish(job, valid.request, missingModelProof), { code: 'PT422' });
  const alteredModel = structuredClone(valid.result);
  alteredModel.catalog.housingTypes[0].houseType.value = '059.0000B';
  await assert.rejects(finish(job, valid.request, alteredModel),
    { code: 'PT422', message: 'notice_capture_model_mismatch' });

  for (const selection of [{ modelNo: '02' }, { houseType: '059.0000B' }, { modelNo: null, houseType: null }]) {
    const alteredComparison = structuredClone(valid);
    Object.assign(alteredComparison.comparison.target, selection);
    await assert.rejects(finishComparison(job, alteredComparison), invalidComparison);
  }
  const falseZero = structuredClone(valid);
  falseZero.comparison.regionDecision.priority = { conclusion: 'normal_zero' };
  await assert.rejects(finishComparison(job, falseZero), invalid);
  const falseCoverage = structuredClone(valid);
  falseCoverage.comparison.collections.find(entry => entry.status === 'failed').status = 'empty';
  await assert.rejects(finishComparison(job, falseCoverage), invalid);
  assert.equal(await captureCount(owner), 0);

  const saved = await finishComparison(job, valid);
  assert.equal(saved.status, 'finished');
  assert.equal(await captureCount(owner), 1);
  await assert.rejects(finishComparison(job, valid), staleLease);
  await as('authenticated', owner.userId);
  assert.deepEqual(await enqueue(owner, input, key), saved);
  const snapshot = await one(`select as_of::text,target_binding_status,conditions_snapshot,result_snapshot
    from public.analysis_input_snapshots where id=$1`, [saved.snapshotId]);
  assert.equal(snapshot.as_of, captureWork.noticeCapture.asOf);
  assert.equal(snapshot.target_binding_status, 'matched');
  assert.deepEqual(snapshot.conditions_snapshot, captureWork.conditions);
  assert.ok(snapshot.result_snapshot.tradeBatches.some(batch => batch.record.status === 'failed'));
  const comparison = (await getComparison(owner, run)).result;
  assert.equal(comparison.target.modelNo, modelNo);
  assert.equal(comparison.target.houseType, houseType);
  assert.notEqual(comparison.completeness, 'complete');
  assert.equal(comparison.regionDecision.priority, null);
  assert.deepEqual(comparison.comparables, []);
});

test('a leap-day default period keeps the unresolved scope and the pinned housing choice', async () => {
  const owner = await createAnalysis();
  const { input, run, job, captureWork } = await start(owner, listing(), '2028-02-29');
  const unresolved = capture(input, captureWork);
  assert.equal(unresolved.result.period.status, 'decision_required');
  const invented = capture(input, captureWork, { period: { start: '2027-03-01', end: '2028-02-29' } });
  invented.result.period.source = 'default_recent_year';
  await assert.rejects(finish(job, unresolved.request, invented.result), { code: '22023' });
  const withOtherModel = structuredClone(unresolved);
  Object.assign(withOtherModel.comparison.target, { modelNo: '02', houseType: '059.0000B' });
  await assert.rejects(finishComparison(job, withOtherModel), invalidComparison);
  const withUnboundHouseType = structuredClone(unresolved);
  withUnboundHouseType.comparison.target.houseType = '059.0000B';
  await assert.rejects(finishComparison(job, withUnboundHouseType), invalidComparison);
  assert.equal(await captureCount(owner), 0);

  const saved = await finishComparison(job, unresolved);
  await as('authenticated', owner.userId);
  const comparison = (await getComparison(owner, run)).result;
  assert.equal(comparison.conditions.period.decision.decisionId, 'D-02');
  assert.equal(comparison.target.modelNo, null);
  assert.equal(comparison.target.houseType, null);
  assert.ok(comparison.holds.some(hold => hold.reasonCode === 'contract_period_unverified'));
  const snapshot = await one("select conditions_snapshot#>>'{comparison,modelNo}' as model_no from public.analysis_input_snapshots where id=$1",
    [saved.snapshotId]);
  assert.equal(snapshot.model_no, modelNo);
});

test('changing a pinned condition blocks the worker before it can create a snapshot', async () => {
  const owner = await createAnalysis();
  const { input, run, job, captureWork } = await start(owner);
  const captureData = capture(input, captureWork);
  await db.query(`update public.analyses set conditions_snapshot=jsonb_set(conditions_snapshot,'{comparison,modelNo}','"02"')
    where id=$1`, [owner.analysisId]);
  const error = { code: '22023', message: 'analysis_run_input_changed' };
  await assert.rejects(work(job), error);
  await assert.rejects(finish(job, captureData.request, captureData.result), error);
  await assert.rejects(finishComparison(job, captureData), error);
  assert.equal(await captureCount(owner), 0);
  await as('authenticated', owner.userId);
  assert.equal((await getRun(owner, run)).status, 'running');
});

test('a worker cannot replace the previous result after the analysis is removed', async () => {
  const owner = await createAnalysis();
  const first = await start(owner, listing(), fixtureBasis);
  const saved = await finishComparison(first.job, capture(first.input, first.captureWork));
  await as('authenticated', owner.userId);
  assert.equal((await getComparison(owner, first.run)).snapshotId, saved.snapshotId);
  const replacement = await enqueue(owner, first.input);
  await as('service_role');
  const job = await claim(replacement);
  const replacementCapture = capture(first.input, await work(job));

  await db.query('delete from public.analyses where id=$1', [owner.analysisId]);
  await assert.rejects(work(job), missing);
  await assert.rejects(finishComparison(job, replacementCapture), missing);
  assert.equal(await captureCount(owner), 0);
  await as('authenticated', owner.userId);
  await assert.rejects(getComparison(owner, first.run), missing);
  await assert.rejects(getComparison(owner, replacement), missing);
});

test('retry and cancellation fence all generations and create no partial capture', async () => {
  const owner = await createAnalysis();
  const { input, run, job, captureWork } = await start(owner);
  const { request, result } = capture(input, captureWork);
  const cause = 'notice_feed_unavailable';
  const retrying = await fail(job, true, cause);
  assert.equal(retrying.status, 'retry_wait');
  assert.equal(retrying.errorCode, null);
  await assert.rejects(work(job), staleLease);
  await db.exec('reset role');
  await db.query(`update private.analysis_runs set next_claim_at=clock_timestamp()-interval '1 second' where id=$1`,
    [run.runId]);
  await as('service_role');
  const retry = await claim(run);
  assert.equal(retry.generation, 2);
  assert.notEqual(retry.leaseToken, job.leaseToken);
  assert.deepEqual(await work(retry), captureWork);
  await assert.rejects(finish(job, request, result), staleLease);
  await as('authenticated', owner.userId);
  assert.equal((await cancel(owner, run)).status, 'cancelled');
  assert.equal((await cancel(owner, run)).status, 'cancelled');
  await as('service_role');
  await assert.rejects(fail(retry, false, cause), staleLease);
  await assert.rejects(finish(retry, request, result), staleLease);
  assert.equal(await captureCount(owner), 0);
});

test('source revocation is checked at lease read, atomic save, reuse, and owner display', async () => {
  const owner = await createAnalysis();
  const { input, run, job, captureWork } = await start(owner, listing(), fixtureBasis);
  const { request, result, comparison } = capture(input, captureWork, { pdf: true });
  assert.equal(captureWork.noticeCapture.allowOfficialPdf, true);
  await setPermission('apt_rights', 'storage_permission', 'unknown');
  await assert.rejects(work(job), restricted);
  await assert.rejects(finish(job, request, result), restricted);
  await setPermission('apt_rights', 'storage_permission', 'allowed');
  await setPermission('mois_legal_region_codes', 'reuse_permission', 'denied');
  await assert.rejects(work(job), restricted);
  await assert.rejects(finish(job, request, result), restricted);
  await setPermission('mois_legal_region_codes', 'reuse_permission', 'allowed');
  await setPermission('applyhome_notice_pdf', 'display_permission', 'denied');
  assert.equal((await work(job)).noticeCapture.allowOfficialPdf, false);
  await assert.rejects(finish(job, request, result), restricted);
  assert.equal(await captureCount(owner), 0);
  await setPermission('applyhome_notice_pdf', 'display_permission', 'allowed');
  const saved = await finishComparison(job, { request, result, comparison });
  assert.equal(saved.status, 'finished');

  const peer = await createAnalysis();
  await assert.rejects(getComparison(owner, run), missing);
  assert.equal(await captureCount(owner), 0);
  await assert.rejects(enqueue(peer, { kind: 'snapshot', snapshotId: saved.snapshotId }), missing);
  await as('authenticated', owner.userId);
  assert.equal((await getComparison(owner, run)).snapshotId, saved.snapshotId);
  assert.equal(await captureCount(owner), 1);
  const reuse = await enqueue(owner, { kind: 'snapshot', snapshotId: saved.snapshotId });
  await as('service_role');
  const reused = await claim(reuse);
  assert.equal((await work(reused)).ingestion.dataOrigin, 'collected');
  await setPermission('mois_legal_region_codes', 'display_permission', 'denied');
  await assert.rejects(work(reused), { code: '42501', message: 'comparison_source_use_not_allowed' });
  await assert.rejects(finish(reused, null, null), { code: '42501', message: 'comparison_source_use_not_allowed' });

  await as('authenticated', owner.userId);
  await assert.rejects(getComparison(owner, run), { code: 'PT403', message: 'comparison_source_restricted' });
  assert.equal(await captureCount(owner), 0);
  assert.equal((await one(`select count(*)::int as n from public.ingestion_collections where snapshot_id=$1`,
    [saved.snapshotId])).n, 0);
});

test('directory start creates one owned workspace, reopens on retry, and isolates the same key between users', async () => {
  const owner = await createAnalysis(), peer = await createAnalysis();
  const index = listing(), input = choice(index), key = randomUUID();
  const open = selected => rpc('start_notice_workspace', key, JSON.stringify(selected));
  await as('service_role');
  await publish(index);
  await as('authenticated', owner.userId);
  const run = await open(input);
  assert.equal(run.status, 'queued');
  assert.deepEqual(run.input, input);
  assert.equal((await open(input)).runId, run.runId);
  await assert.rejects(open({ ...input, modelNo: '02' }), { code: 'PT409' });
  const workspace = await one('select latest_run_id, title from public.analyses where directory_request_key=$1', [key]);
  assert.equal(workspace.latest_run_id, run.runId);
  assert.match(workspace.title, /9900000042/);
  assert.equal((await one('select count(*)::int as n from public.chats')).n, 2);
  await as('authenticated', peer.userId);
  assert.equal(await one('select id from public.analyses where id=$1', [run.analysisId]), undefined);
  const peerRun = await open(input);
  assert.notEqual(peerRun.analysisId, run.analysisId);
  assert.notEqual(peerRun.runId, run.runId);
});

test('refused notice selection rolls back both drafts and requires a verified authenticated owner', async () => {
  const owner = await createAnalysis(), unverified = await createAnalysis({}, false);
  const index = listing(), input = choice(index);
  const open = value => rpc('start_notice_workspace', randomUUID(), JSON.stringify(value));
  await as('service_role');
  await publish(index);
  await as('anon');
  await assert.rejects(open(input), forbidden);
  await as('authenticated', unverified.userId);
  await assert.rejects(open(input), forbidden);
  await as('authenticated', owner.userId);
  await assert.rejects(open({ kind: 'synthetic', fixture:'ingestion-v0' }), { code:'22023' });
  await assert.rejects(open({ ...input, modelNo:'02' }), { code:'PT409' });
  const counts = await one('select (select count(*)::int from public.chats) as chats, (select count(*)::int from public.analyses) as analyses');
  assert.deepEqual(counts, { chats:1, analyses:1 });
});
