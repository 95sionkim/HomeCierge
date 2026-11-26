// 합성 수집본·근거와 PGlite로 에이전트 응답 대기열, 임대 만료, 출처 llm_permission 필터,
// LLM 제안 서버 검증·승인 경계, 타 계정 404, 턴·계정 삭제 cascade, 기능 꺼짐 동작을 검증한다.
// 실제 인증·Storage·외부 API는 호출하지 않으며 모든 자료는 합성이다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBe03Db } from './helpers/be03-db.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixturePath = 'tests/fixtures/ingestion-v0.json';
const { request: fixtureRequest } = JSON.parse(readFileSync(new URL('../fixtures/ingestion-v0.json', import.meta.url), 'utf8'));
const fixtureEvidence = JSON.parse(readFileSync(new URL('../fixtures/comparison-evidence-v1.json', import.meta.url), 'utf8'));
const collectedEvidence = { ...fixtureEvidence, dataOrigin: 'collected' };
const syntheticInput = { kind: 'synthetic', fixture: 'ingestion-v0' };
const defaultConditions = { comparison: { modelNo: '01' } };
const supplementalSources = [
  'synthetic-area-register', 'synthetic-complex-register',
  'synthetic-coordinate-register', 'synthetic-region-register',
];
const collectedCaptureSources = [
  'applyhome_apt', 'applyhome_apt_model', 'apt_trade', 'apt_rights', 'applyhome_notice_pdf',
];
const evidenceSourceIds = ['applyhome_apt', 'apt_trade', 'apt_rights', ...supplementalSources];

const forbidden = { code: '42501' };
const runNotFound = { code: 'PT404', message: 'analysis_run_not_found' };
const replyNotFound = { code: 'PT404', message: 'agent_reply_not_found' };
const staleLease = { code: 'PT409', message: 'agent_reply_stale_lease' };

let db;
let syntheticIngestion;
let collectedIngestion;

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function as(role, userId = '', claims = { is_anonymous: false }) {
  await db.exec('reset role');
  const jwt = { ...(userId ? { sub: userId } : {}), ...claims };
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)",
    [userId, JSON.stringify(jwt)]);
  await db.exec(`set role ${role}`);
}

async function rpc(name, ...params) {
  const args = params.map((_, index) => `$${index + 1}`).join(', ');
  return (await one(`select public.${name}(${args}) as reply`, params)).reply;
}

const json = value => (value === null ? null : JSON.stringify(value));

function runCompare(ingestion, selection = { modelNo: '01' }, evidence = null) {
  const python = `
import json, sys
sys.path.insert(0, 'scripts')
from compare_trades import compare_snapshot
ingestion, selection, evidence = json.load(sys.stdin)
print(json.dumps(compare_snapshot(ingestion, selection, evidence), ensure_ascii=False))
`;
  return JSON.parse(execFileSync('python3', ['-c', python], {
    cwd: root, encoding: 'utf8', input: JSON.stringify([ingestion, selection, evidence]),
  }));
}

async function createOwner() {
  await db.exec('reset role');
  const userId = randomUUID();
  await db.query('insert into auth.users(id, confirmed_at) values ($1, now())', [userId]);
  await db.query('insert into public.user_profiles(user_id, search_conditions, revision) values ($1, $2, 1)',
    [userId, JSON.stringify({ region_codes: ['11215'], budget_max_won: '900000000' })]);
  const chat = await one("insert into public.chats(user_id, title) values ($1, '합성 대화') returning id", [userId]);
  const analysis = await one(
    'insert into public.analyses(user_id, chat_id, conditions_snapshot) values ($1, $2, $3) returning id',
    [userId, chat.id, JSON.stringify(defaultConditions)],
  );
  return { userId, chatId: chat.id, analysisId: analysis.id };
}

async function finishSyntheticRun(owner) {
  await as('authenticated', owner.userId);
  const run = await rpc('enqueue_analysis_run', owner.analysisId, randomUUID(), json(syntheticInput));
  await as('service_role');
  const job = await rpc('claim_analysis_run', 300, run.runId);
  const comparison = runCompare(syntheticIngestion, { modelNo: '01' }, fixtureEvidence);
  const finished = await rpc('finish_analysis_comparison', job.runId, job.generation, job.leaseToken,
    json(fixtureRequest), json(syntheticIngestion), json(comparison));
  return { runId: finished.runId, snapshotId: finished.snapshotId, comparison };
}

async function finishCollectedRun(owner, llmAllowedSources = []) {
  await db.exec('reset role');
  const allSources = [...collectedCaptureSources, ...supplementalSources, 'naver_news'];
  await db.query(`insert into public.source_registry(id, display_name, storage_permission, reuse_permission, display_permission, llm_permission)
    select id, '합성 출처', 'allowed', 'allowed', 'allowed',
      case when id = 'naver_news' then 'denied' when id = any($2::text[]) then 'allowed' else 'unknown' end
    from unnest($1::text[]) as source(id)
    on conflict (id) do update set
      storage_permission = 'allowed', reuse_permission = 'allowed', display_permission = 'allowed',
      llm_permission = excluded.llm_permission, retention_days = null`,
  [allSources, llmAllowedSources]);

  await as('service_role');
  const snapshotId = await rpc('save_ingestion_snapshot', owner.userId, owner.analysisId, randomUUID(),
    json(fixtureRequest), json(collectedIngestion));
  await rpc('register_comparison_evidence', snapshotId, json(collectedEvidence), evidenceSourceIds);

  await as('authenticated', owner.userId);
  const run = await rpc('enqueue_analysis_run', owner.analysisId, randomUUID(), json({ kind: 'snapshot', snapshotId }));
  await as('service_role');
  const job = await rpc('claim_analysis_run', 300, run.runId);
  const comparison = runCompare(collectedIngestion, { modelNo: '01' }, collectedEvidence);
  const finished = await rpc('finish_analysis_comparison', job.runId, job.generation, job.leaseToken,
    null, null, json(comparison));
  return { runId: finished.runId, snapshotId, comparison };
}

before(async () => {
  db = await createBe03Db();
  await db.exec(`
    alter table auth.users add column confirmed_at timestamptz,
      add column is_anonymous boolean not null default false,
      add column banned_until timestamptz, add column deleted_at timestamptz;
    create table if not exists auth.sessions (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references auth.users(id) on delete cascade
    );
  `);
  syntheticIngestion = JSON.parse(execFileSync('python3', ['scripts/replay_ingestion.py', fixturePath], {
    cwd: root, encoding: 'utf8',
  }));
  collectedIngestion = { ...structuredClone(syntheticIngestion), dataOrigin: 'collected' };
});

beforeEach(async () => {
  await db.exec('reset role');
  await db.exec(`truncate
    private.retired_deletion_keys, private.data_deletion_objects, private.account_deletion_fences,
    private.data_deletion_requests, private.analysis_agent_replies, private.analysis_chat_turns,
    private.saved_report_funding_refs, private.saved_analysis_reports, private.deleted_report_requests,
    private.analysis_report_versions, private.comparison_results, private.comparison_evidence,
    private.analysis_funding_schedule_snapshots, private.analysis_runs, public.analysis_input_snapshots,
    public.reports, public.funding_entries, public.analyses, public.chat_messages, public.chats,
    public.profile_change_requests, public.user_profiles, public.source_registry, auth.users cascade;
    update private.agent_settings set enabled = false, model = 'gpt-6.1-sol';`);
});

after(async () => {
  await db?.close();
});

test('private agent tables enable RLS with zero grants, store no raw prompt/result, and worker RPCs are service_role only', async () => {
  await db.exec('reset role');
  for (const tbl of ['private.agent_settings', 'private.analysis_agent_replies']) {
    const info = await one(`select relrowsecurity as rls,
      has_table_privilege('public', $1, 'SELECT') as pub_sel,
      has_table_privilege('anon', $1, 'SELECT') as anon_sel,
      has_table_privilege('authenticated', $1, 'SELECT') as auth_sel,
      has_table_privilege('service_role', $1, 'SELECT') as svc_sel
      from pg_class where oid = $1::regclass`, [tbl]);
    assert.deepEqual(info, { rls: true, pub_sel: false, anon_sel: false, auth_sel: false, svc_sel: false }, tbl);
  }
  const cols = (await db.query(`select column_name from information_schema.columns
    where table_schema = 'private' and table_name = 'analysis_agent_replies'`)).rows.map(r => r.column_name);
  assert.ok(!cols.includes('prompt'));
  assert.ok(!cols.includes('prompt_text'));
  assert.ok(!cols.includes('raw_result'));
  assert.ok(!cols.includes('comparison_result'));

  const owner = await createOwner();
  for (const role of ['anon', 'authenticated']) {
    await as(role, role === 'authenticated' ? owner.userId : '');
    await assert.rejects(rpc('configure_agent_settings', true, 'gpt-6.1-sol'), forbidden);
    await assert.rejects(rpc('claim_agent_reply', 60), forbidden);
    await assert.rejects(rpc('expire_stale_agent_replies'), forbidden);
    await assert.rejects(rpc('read_agent_reply_context', randomUUID(), 1, randomUUID()), forbidden);
    await assert.rejects(rpc('complete_agent_reply', randomUUID(), 1, randomUUID(), 'rejected'), forbidden);
    await assert.rejects(rpc('fail_agent_reply', randomUUID(), 1, randomUUID(), 'llm_timeout'), forbidden);
  }
});

test('feature disabled by default creates no agent queue rows and preserves rule-based conversation behavior', async () => {
  const owner = await createOwner();
  const { runId } = await finishSyntheticRun(owner);

  await as('authenticated', owner.userId);
  const conv = await rpc('submit_analysis_chat_turn', owner.analysisId, runId, randomUUID(), '왜 이 거래만 포함됐어?', 'inclusion');
  assert.equal(conv.turns.length, 1);
  assert.equal(conv.turns[0].agentReply, null);

  await as('service_role');
  assert.equal(await rpc('claim_agent_reply', 60), null);
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from private.analysis_agent_replies')).n, 0);
});

test('queue, lease, answer/reject/fail, lease expiration, and cross-account 404 work accurately', async () => {
  const owner = await createOwner();
  const peer = await createOwner();
  const { runId } = await finishSyntheticRun(owner);

  await as('service_role');
  const settings = await rpc('configure_agent_settings', true, 'gpt-6.1-sol');
  assert.equal(settings.enabled, true);
  assert.equal(settings.model, 'gpt-6.1-sol');

  // 1) 질문 제출 시 queued 대기열 생성 -> 작업자 임대 -> 완료
  await as('authenticated', owner.userId);
  const t1 = await rpc('submit_analysis_chat_turn', owner.analysisId, runId, randomUUID(), '왜 이 거래만 포함됐어?', 'inclusion');
  assert.equal(t1.turns[0].agentReply.status, 'queued');
  assert.equal(t1.turns[0].agentReply.model, 'gpt-6.1-sol');
  assert.equal(t1.turns[0].agentReply.answer, null);

  // 다른 계정의 조회는 404다.
  await as('authenticated', peer.userId);
  await assert.rejects(rpc('read_analysis_conversation', owner.analysisId, runId), runNotFound);

  await as('service_role');
  const claimed1 = await rpc('claim_agent_reply', 60);
  assert.equal(claimed1.turnId, t1.turns[0].id);
  assert.equal(claimed1.generation, 1);
  assert.equal(await rpc('claim_agent_reply', 60), null);

  const ctx1 = await rpc('read_agent_reply_context', claimed1.replyId, claimed1.generation, claimed1.leaseToken);
  assert.equal(ctx1.message, '왜 이 거래만 포함됐어?');
  assert.equal(ctx1.comparison.contractVersion, 'comparison/v1');

  const done1 = await rpc(
    'complete_agent_reply',
    claimed1.replyId, claimed1.generation, claimed1.leaseToken,
    'answered', 'inclusion', '비교표에 포함된 주변 단지는 2곳입니다.',
    json([{ kind: 'comparison', reference: 'comparison/v1', label: '비교 결과 요약' }]),
    null,
    json({ inputTokens: 320, outputTokens: 120, reasoningTokens: 40, latencyMs: 510, estimatedCostUsd: '0.00184000', pricingAsOf: '2026-11-12' }),
    json({ status: 'passed', reasons: [] }),
    'agent-core-v1',
  );
  assert.equal(done1.status, 'answered');

  await as('authenticated', owner.userId);
  const afterDone = await rpc('read_analysis_conversation', owner.analysisId, runId);
  assert.equal(afterDone.turns[0].agentReply.status, 'answered');
  assert.equal(afterDone.turns[0].agentReply.model, 'gpt-6.1-sol');
  assert.equal(afterDone.turns[0].agentReply.answer, '비교표에 포함된 주변 단지는 2곳입니다.');
  assert.equal(afterDone.turns[0].agentReply.citations.length, 1);

  // 2) 임대 만료: 만료 시각을 지난 leased 행은 즉시 expired로 조회되고 오래된 작업자 쓰기가 거부된다(A-58).
  const t2 = await rpc('submit_analysis_chat_turn', owner.analysisId, runId, randomUUID(), '보류 사유 알려줘', 'holds');
  const turn2Id = t2.turns[1].id;
  await as('service_role');
  const claimed2 = await rpc('claim_agent_reply', 60);
  assert.equal(claimed2.turnId, turn2Id);
  await db.exec('reset role');
  await db.query("update private.analysis_agent_replies set lease_expires_at = clock_timestamp() - interval '5 seconds' where id = $1",
    [claimed2.replyId]);

  // 정리 RPC 실행 전에도 소유자 조회는 'leased'가 아닌 'expired'를 반환한다.
  await as('authenticated', owner.userId);
  const expiredView = await rpc('read_analysis_conversation', owner.analysisId, runId);
  assert.equal(expiredView.turns[1].agentReply.status, 'expired');
  assert.equal(expiredView.turns[1].agentReply.answer, null);

  // 만료된 임대로 읽기·완료·실패 시 PT409 stale lease
  await as('service_role');
  await assert.rejects(rpc('read_agent_reply_context', claimed2.replyId, claimed2.generation, claimed2.leaseToken), staleLease);
  await assert.rejects(rpc('complete_agent_reply', claimed2.replyId, claimed2.generation, claimed2.leaseToken, 'rejected'), staleLease);
  await assert.rejects(rpc('fail_agent_reply', claimed2.replyId, claimed2.generation, claimed2.leaseToken, 'llm_timeout'), staleLease);
  assert.equal(await rpc('expire_stale_agent_replies'), 1);

  await db.exec('reset role');
  const expiredRow = await one('select status, lease_token, failure_code from private.analysis_agent_replies where id = $1', [claimed2.replyId]);
  assert.deepEqual(expiredRow, { status: 'expired', lease_token: null, failure_code: 'lease_expired' });
});

test('read_agent_reply_context enforces source_registry.llm_permission = allowed and excludes restricted sources', async () => {
  const owner = await createOwner();
  // 기본 상태: 모든 출처의 llm_permission = 'unknown' (naver_news = 'denied')
  const { runId: restrictedRunId } = await finishCollectedRun(owner, []);

  await as('service_role');
  await rpc('configure_agent_settings', true, 'gpt-6.1-sol');

  await as('authenticated', owner.userId);
  await rpc('submit_analysis_chat_turn', owner.analysisId, restrictedRunId, randomUUID(), '분양가와 비교 거래 알려줘', 'price');

  await as('service_role');
  const job1 = await rpc('claim_agent_reply', 60);
  const ctx1 = await rpc('read_agent_reply_context', job1.replyId, job1.generation, job1.leaseToken);
  assert.equal(ctx1.llmSourcePolicy.hasRestrictedSources, true);
  assert.equal(ctx1.llmSourcePolicy.newsExcluded, true);
  assert.equal(ctx1.llmSourcePolicy.allowedSources.length, 0);
  assert.ok(ctx1.llmSourcePolicy.restrictedSources.includes('applyhome_apt'));
  assert.ok(ctx1.llmSourcePolicy.restrictedSources.includes('apt_trade'));
  assert.ok(ctx1.llmSourcePolicy.restrictedSources.includes('applyhome_notice_pdf'));
  // 미허용 출처 값은 문맥에서 제거된다.
  assert.equal(ctx1.comparison.noticePrice.status, 'restricted_for_llm');
  assert.equal(ctx1.comparison.target.name, null);
  assert.deepEqual(ctx1.comparison.comparables, []);
  assert.deepEqual(ctx1.comparison.collections, []);
  await rpc('complete_agent_reply', job1.replyId, job1.generation, job1.leaseToken, 'rejected',
    null, null, json([]), null, json({}), json({ status: 'rejected', reasons: ['source_restricted'] }), 'agent-core-v1');

  // 일부 출처만 llm_permission = 'allowed'인 경우 허용 출처의 값만 포함된다.
  const owner2 = await createOwner();
  const { runId: partialRunId } = await finishCollectedRun(owner2, ['applyhome_apt', 'apt_trade']);
  await as('authenticated', owner2.userId);
  await rpc('submit_analysis_chat_turn', owner2.analysisId, partialRunId, randomUUID(), '수집 출처 알려줘', 'inclusion');
  await as('service_role');
  const job2 = await rpc('claim_agent_reply', 60);
  const ctx2 = await rpc('read_agent_reply_context', job2.replyId, job2.generation, job2.leaseToken);
  assert.equal(ctx2.llmSourcePolicy.hasRestrictedSources, true);
  assert.deepEqual(ctx2.llmSourcePolicy.allowedSources, ['applyhome_apt', 'apt_trade']);
  assert.equal(ctx2.comparison.target.name, '합성 가람 아파트');
  assert.equal(ctx2.comparison.noticePrice.status, 'restricted_for_llm');
  assert.equal(ctx2.comparison.collections.length, 1);
  assert.equal(ctx2.comparison.collections[0].source, 'apt_trade');
});

test('LLM condition proposal uses shared server validation, attaches strictly as pending, and invalid proposals are rejected', async () => {
  const owner = await createOwner();
  const { runId } = await finishSyntheticRun(owner);

  await as('service_role');
  await rpc('configure_agent_settings', true, 'gpt-6.1-sol');

  // 1) 규칙 기반이 help로 분류한 자연어 턴에 LLM이 유효한 조건 변경 제안(±3%, Q-41 상한 이내)을 첨부한다.
  await as('authenticated', owner.userId);
  const reqId = randomUUID();
  const submitted = await rpc('submit_analysis_chat_turn', owner.analysisId, runId, reqId, '면적 범위를 3퍼센트 정도로 좁혀줄래?', 'help');
  const turnId = submitted.turns[0].id;
  assert.equal(submitted.turns[0].proposal, null);

  await as('service_role');
  const job = await rpc('claim_agent_reply', 60);
  const completed = await rpc(
    'complete_agent_reply',
    job.replyId, job.generation, job.leaseToken,
    'answered', 'change_conditions',
    '공급면적 허용 범위를 ±5%에서 ±3%로 좁히는 제안을 준비했습니다. 승인하시면 같은 수집본으로 다시 계산합니다.',
    json([{ kind: 'condition', reference: 'areaTolerancePercent', label: '공급면적 ±3%' }]),
    json({ kind: 'conditions', conditions: { areaTolerancePercent: '3' } }),
    json({ inputTokens: 400, outputTokens: 150, latencyMs: 600, estimatedCostUsd: '0.00230000', pricingAsOf: '2026-11-12' }),
    json({ status: 'passed', reasons: [] }),
    'agent-core-v1',
  );
  assert.equal(completed.status, 'answered');
  assert.equal(completed.proposalAttached, true);

  // LLM은 승인하지 않으며 proposal_status = 'pending'으로만 생성된다.
  await as('authenticated', owner.userId);
  const afterAttach = await rpc('read_analysis_conversation', owner.analysisId, runId);
  assert.equal(afterAttach.turns[0].intent, 'change_conditions');
  assert.equal(afterAttach.turns[0].proposal.status, 'pending');
  assert.equal(afterAttach.turns[0].proposal.resultRunId, null);
  assert.deepEqual(afterAttach.turns[0].proposal.proposed, { areaTolerancePercent: '3' });
  assert.deepEqual(afterAttach.turns[0].proposal.previous, { areaTolerancePercent: '5' });

  // 원래 요청의 멱등 재전송도 충돌 없이 같은 대화 내역을 반환한다.
  const replayed = await rpc('submit_analysis_chat_turn', owner.analysisId, runId, reqId, '면적 범위를 3퍼센트 정도로 좁혀줄래?', 'help');
  assert.equal(replayed.turns.length, 1);
  assert.equal(replayed.turns[0].proposal.status, 'pending');

  // 2) Q-41 상한(±5%)을 넘는 잘못된 LLM 제안(±7%)은 서버 검증이 거부하고 답변을 폐기한다.
  const badTurn = await rpc('submit_analysis_chat_turn', owner.analysisId, runId, randomUUID(), '면적 범위를 7퍼센트로', 'help');
  await as('service_role');
  const badJob = await rpc('claim_agent_reply', 60);
  const badDone = await rpc(
    'complete_agent_reply',
    badJob.replyId, badJob.generation, badJob.leaseToken,
    'answered', 'change_conditions', '공급면적 허용 범위를 ±7%로 제안합니다.',
    json([]),
    json({ kind: 'conditions', conditions: { areaTolerancePercent: '7' } }),
    json({}),
    json({ status: 'passed', reasons: [] }),
    'agent-core-v1',
  );
  assert.equal(badDone.status, 'rejected');
  assert.equal(badDone.proposalAttached, false);
  assert.ok(badDone.validationReasons.includes('server_proposal_validation_failed'));

  await as('authenticated', owner.userId);
  const afterBad = await rpc('read_analysis_conversation', owner.analysisId, runId);
  assert.equal(afterBad.turns[1].id, badTurn.turns[1].id);
  assert.equal(afterBad.turns[1].proposal, null);
  assert.equal(afterBad.turns[1].agentReply.status, 'rejected');
  assert.equal(afterBad.turns[1].agentReply.answer, null);

  // 사용자가 승인한 경우에만 새 실행이 접수되고 공유 프로필은 유지된다.
  const approved = await rpc('decide_analysis_chat_turn', owner.analysisId, runId, turnId, 'approve');
  assert.equal(approved.turns[0].proposal.status, 'approved');
  assert.ok(approved.turns[0].proposal.resultRunId);
  await db.exec('reset role');
  const prof = await one('select revision from public.user_profiles where user_id = $1', [owner.userId]);
  assert.equal(prof.revision, 1);

  // 거절·취소한 LLM 제안은 새 실행을 만들지 않고 기존 조건을 유지한다.
  const { runId: freshRunId } = await finishSyntheticRun(owner);
  for (const decision of ['reject', 'cancel']) {
    await as('authenticated', owner.userId);
    const turnRes = await rpc('submit_analysis_chat_turn', owner.analysisId, freshRunId, randomUUID(), `면적 2.5퍼센트(${decision})`, 'help');
    const tid = turnRes.turns.at(-1).id;
    await db.exec('reset role');
    const { id: targetReplyId } = await one('select id from private.analysis_agent_replies where turn_id = $1', [tid]);
    await as('service_role');
    const j = await rpc('claim_agent_reply', 60, targetReplyId);
    assert.equal(j.turnId, tid);
    await rpc(
      'complete_agent_reply',
      j.replyId, j.generation, j.leaseToken,
      'answered', 'change_conditions', '공급면적 허용 범위를 ±2.5%로 제안합니다.',
      json([]), json({ kind: 'conditions', conditions: { areaTolerancePercent: '2.5' } }),
      json({}), json({ status: 'passed', reasons: [] }), 'agent-core-v1',
    );
    await as('authenticated', owner.userId);
    const decided = await rpc('decide_analysis_chat_turn', owner.analysisId, freshRunId, tid, decision);
    const updatedTurn = decided.turns.find(t => t.id === tid);
    assert.equal(updatedTurn.proposal.status, decision === 'reject' ? 'rejected' : 'cancelled');
    assert.equal(updatedTurn.proposal.resultRunId, null);
  }
});

test('turn deletion cascade via resolve_turn_deletion_scope and account deletion remove agent replies and block stale workers', async () => {
  const owner = await createOwner();
  const peer = await createOwner();
  const { runId } = await finishSyntheticRun(owner);
  const { runId: peerRunId } = await finishSyntheticRun(peer);

  await as('service_role');
  await rpc('configure_agent_settings', true, 'gpt-6.1-sol');

  await as('authenticated', owner.userId);
  const t1 = await rpc('submit_analysis_chat_turn', owner.analysisId, runId, randomUUID(), '삭제할 턴 질문', 'scope');
  const turnId = t1.turns[0].id;
  await as('authenticated', peer.userId);
  await rpc('submit_analysis_chat_turn', peer.analysisId, peerRunId, randomUUID(), '타 계정 턴 질문', 'scope');

  // 소유자 턴을 작업자가 임대 중인 상태에서 소유자가 턴을 개별 삭제한다.
  await as('service_role');
  const leased = await rpc('claim_agent_reply', 60);
  assert.equal(leased.turnId, turnId);

  await as('authenticated', owner.userId);
  const impact = await rpc('read_deletion_impact', 'turn', turnId);
  assert.equal(impact.scope, 'turn');
  await rpc('delete_personal_data', 'turn', randomUUID(), turnId);

  // 턴 삭제 시 analysis_agent_replies도 FK cascade로 즉시 삭제되고, 임대 보유 작업자의 쓰기는 PT404로 차단된다.
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from private.analysis_agent_replies where user_id = $1', [owner.userId])).n, 0);
  assert.equal((await one('select count(*)::int as n from private.analysis_agent_replies where user_id = $1', [peer.userId])).n, 1);

  await as('service_role');
  await assert.rejects(rpc('read_agent_reply_context', leased.replyId, leased.generation, leased.leaseToken), replyNotFound);
  await assert.rejects(rpc('complete_agent_reply', leased.replyId, leased.generation, leased.leaseToken, 'rejected'), replyNotFound);

  // 계정 전체 삭제 시에도 해당 계정의 에이전트 응답이 전부 삭제되고 타 계정은 보존된다.
  await as('authenticated', owner.userId);
  await rpc('submit_analysis_chat_turn', owner.analysisId, runId, randomUUID(), '계정 삭제 전 질문', 'help');
  await rpc('request_account_deletion', randomUUID());
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from private.analysis_agent_replies where user_id = $1', [owner.userId])).n, 0);
  assert.equal((await one('select count(*)::int as n from private.analysis_agent_replies where user_id = $1', [peer.userId])).n, 1);

  // 승인된 제안으로 파생된 후속 실행의 턴·에이전트 응답도 부모 턴 삭제 시 함께 정리된다.
  const chainOwner = await createOwner();
  const { runId: baseRunId } = await finishSyntheticRun(chainOwner);
  await as('authenticated', chainOwner.userId);
  const parentTurn = await rpc('submit_analysis_chat_turn', chainOwner.analysisId, baseRunId, randomUUID(), '면적 ±4%로 좁혀줘', 'help');
  const parentTurnId = parentTurn.turns[0].id;
  await db.exec('reset role');
  const { id: parentReplyId } = await one('select id from private.analysis_agent_replies where turn_id = $1', [parentTurnId]);
  await as('service_role');
  const pj = await rpc('claim_agent_reply', 60, parentReplyId);
  assert.equal(pj.turnId, parentTurnId);
  await rpc('complete_agent_reply', pj.replyId, pj.generation, pj.leaseToken,
    'answered', 'change_conditions', '공급면적 허용 범위를 ±4%로 제안합니다.',
    json([]), json({ kind: 'conditions', conditions: { areaTolerancePercent: '4' } }),
    json({}), json({ status: 'passed', reasons: [] }), 'agent-core-v1');
  await as('authenticated', chainOwner.userId);
  const approvedParent = await rpc('decide_analysis_chat_turn', chainOwner.analysisId, baseRunId, parentTurnId, 'approve');
  const childRunId = approvedParent.turns[0].proposal.resultRunId;
  await as('service_role');
  const childJob = await rpc('claim_analysis_run', 300, childRunId);
  const childWork = await rpc('read_comparison_work', childJob.runId, childJob.generation, childJob.leaseToken);
  const childComp = JSON.parse(execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, 'scripts')
from run_analysis_worker import prepare_comparison
selection, work = json.load(sys.stdin)
_, _, comp = prepare_comparison(selection, work)
print(json.dumps(comp, ensure_ascii=False))
`], { cwd: root, encoding: 'utf8', input: JSON.stringify([{ kind: 'snapshot', snapshotId: childJob.input.snapshotId }, childWork]) }));
  await rpc('finish_analysis_comparison', childJob.runId, childJob.generation, childJob.leaseToken, null, null, json(childComp));
  await as('authenticated', chainOwner.userId);
  await rpc('submit_analysis_chat_turn', chainOwner.analysisId, childRunId, randomUUID(), '후속 실행 질문', 'scope');
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from private.analysis_agent_replies where user_id = $1', [chainOwner.userId])).n, 2);

  await as('authenticated', chainOwner.userId);
  await rpc('delete_personal_data', 'turn', randomUUID(), parentTurnId);
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from private.analysis_agent_replies where user_id = $1', [chainOwner.userId])).n, 0);
});
