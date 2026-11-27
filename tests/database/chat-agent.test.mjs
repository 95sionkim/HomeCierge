// 합성 공고 색인과 PGlite로 채팅 홈 에이전트 응답 대기열, 임대 만료, Q-42 출처 llm_permission 필터,
// 확인 카드 결정(확인 실행·거절·취소 미실행), O-3 공유 프로필 변경안(pending), 타 계정 404,
// 메시지·채팅·계정 삭제 cascade, 기능 꺼짐 동작을 검증한다.
// 실제 인증·Storage·외부 API는 호출하지 않으며 모든 자료는 합성이다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { createBe03Db } from './helpers/be03-db.mjs';

const koreanDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });
const allSources = [
  'applyhome_apt',
  'applyhome_remainder',
  'applyhome_apt_model',
  'applyhome_remainder_model',
  'mois_legal_region_codes',
  'naver_news',
];
const forbidden = { code: '42501' };
const notFound = { code: 'PT404' };
const conflict = { code: 'PT409' };
const invalid = { code: '22023' };

let db;

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function as(role, userId = '', anonymous = false) {
  await db.exec('reset role');
  await db.query(
    "select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)",
    [userId, JSON.stringify({ ...(userId ? { sub: userId } : {}), is_anonymous: anonymous })],
  );
  await db.exec(`set role ${role}`);
}

async function rpc(name, ...params) {
  const args = params.map((_, index) => `$${index + 1}`).join(', ');
  return (await one(`select public.${name}(${args}) as reply`, params)).reply;
}

const json = (value) => (value === null ? null : JSON.stringify(value));

async function createOwner() {
  await db.exec('reset role');
  const userId = randomUUID();
  await db.query('insert into auth.users(id, confirmed_at) values ($1, now())', [userId]);
  await db.query(
    'insert into public.user_profiles(user_id, search_conditions, revision) values ($1, $2, 1)',
    [userId, JSON.stringify({ region_codes: ['11215'], budget_max_won: '900000000' })],
  );
  return userId;
}

async function configureSources(llmAllowedSources = [
  'applyhome_apt',
  'applyhome_remainder',
  'applyhome_apt_model',
  'applyhome_remainder_model',
  'mois_legal_region_codes',
]) {
  await db.exec('reset role');
  await db.query(
    `insert into public.source_registry(id, display_name, storage_permission, reuse_permission, display_permission, llm_permission)
     select id, '합성 출처', 'allowed', 'allowed', 'allowed',
       case when id = 'naver_news' then 'denied' when id = any($2::text[]) then 'allowed' else 'unknown' end
     from unnest($1::text[]) as source(id)
     on conflict (id) do update set
       storage_permission = 'allowed', reuse_permission = 'allowed', display_permission = 'allowed',
       llm_permission = excluded.llm_permission, retention_days = null`,
    [allSources, llmAllowedSources],
  );
}

function makeSyntheticDirectory(observed = new Date()) {
  const day = koreanDate.format(observed);
  const start = koreanDate.format(new Date(observed.getTime() - 90 * 24 * 3600 * 1000));
  return {
    contractVersion: 'notice-search-index/v1',
    dataOrigin: 'collected',
    observedAt: observed.toISOString(),
    publicationWindow: { start, end: day },
    regionCodes: ['11200', '11215'],
    coverage: {
      status: 'complete',
      sources: [
        { source: 'applyhome_apt', status: 'complete' },
        { source: 'applyhome_remainder', status: 'complete' },
      ],
    },
    notices: [
      {
        houseManageNo: '9900000101',
        noticeNo: '9900000101',
        edition: day,
        title: '합성 가람 아파트',
        kind: 'new_sale',
        regionCode: '11200',
        moveIn: { start: '2027-06', end: '2027-06' },
        application: { start: day, end: day },
        inventoryComplete: false,
        models: [{ modelNo: '01', houseType: '084.0000A', supplyAreaM2: null, areaEvidence: [], rooms: [] }],
        sourceIds: ['applyhome_apt', 'applyhome_apt_model'],
        reasonCodes: [],
      },
      {
        houseManageNo: '9900000040',
        noticeNo: '9900000040',
        edition: day,
        title: '합성 센트럴 아이파크',
        kind: 'resupply',
        regionCode: '11215',
        moveIn: null,
        application: { start: day, end: day },
        inventoryComplete: false,
        models: [{ modelNo: '01', houseType: '084.9811C', supplyAreaM2: null, areaEvidence: [], rooms: [] }],
        sourceIds: ['applyhome_remainder', 'applyhome_remainder_model'],
        reasonCodes: [],
      },
    ],
  };
}

async function publishSyntheticDirectory() {
  const idx = makeSyntheticDirectory();
  await as('service_role');
  await rpc(
    'publish_notice_directory',
    json(idx),
    json({ '11200': '서울특별시 성동구', '11215': '서울특별시 광진구' }),
  );
  return idx;
}

function makeSummary(index, appliedConditions, { matchedCount = 1, needsReviewCount = 1, zeroStatus = 'not_zero' } = {}) {
  const day = index.publicationWindow.end;
  return {
    contractVersion: 'chat-search-summary/v1',
    asOf: day,
    observedAt: index.observedAt,
    publicationWindow: index.publicationWindow,
    coverage: index.coverage,
    zeroStatus,
    scopeIssues: [],
    counts: { matched: matchedCount, needsReview: needsReviewCount, excluded: 0 },
    truncation: { truncated: false, matchedOmitted: 0, needsReviewOmitted: 0 },
    appliedConditions,
    regionLabels: { '11200': '서울특별시 성동구', '11215': '서울특별시 광진구' },
    matched: matchedCount
      ? [
          {
            houseManageNo: '9900000101',
            noticeNo: '9900000101',
            edition: day,
            title: '합성 가람 아파트',
            kind: 'new_sale',
            regionCode: '11200',
            regionName: '서울특별시 성동구',
            applicationStatus: 'open',
            modelsCount: 1,
            matchedRoomsCount: 2,
            needsReviewRoomsCount: 0,
            minSubtotalWon: '650000000',
            maxSubtotalWon: '680000000',
            reasonCodes: [],
          },
        ]
      : [],
    needsReview: needsReviewCount
      ? [
          {
            houseManageNo: '9900000040',
            noticeNo: '9900000040',
            edition: day,
            title: '합성 센트럴 아이파크',
            kind: 'resupply',
            regionCode: '11215',
            regionName: '서울특별시 광진구',
            applicationStatus: 'open',
            modelsCount: 1,
            matchedRoomsCount: 0,
            needsReviewRoomsCount: 1,
            minSubtotalWon: null,
            maxSubtotalWon: null,
            reasonCodes: ['price_unverified'],
          },
        ]
      : [],
  };
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
});

beforeEach(async () => {
  await db.exec('reset role');
  await db.exec(`truncate
    private.retired_deletion_keys, private.data_deletion_objects, private.account_deletion_fences,
    private.data_deletion_requests, private.chat_agent_replies, private.analysis_agent_replies,
    private.analysis_chat_turns, private.search_profile_proposals, private.notice_directory_publication,
    private.notice_search_index, public.chat_messages, public.chats, public.profile_change_requests,
    public.user_profiles, public.source_registry, auth.users cascade;
    update private.agent_settings set enabled = false, model = 'gpt-6.2-sol';`);
  await configureSources();
});

after(async () => {
  await db?.close();
});

test('chat_agent_replies enables RLS with zero grants, stores no raw prompt/index, and enforces strict RPC grants', async () => {
  await db.exec('reset role');
  const tbl = await one(`select relrowsecurity as rls,
    has_table_privilege('public', 'private.chat_agent_replies', 'SELECT') as pub_sel,
    has_table_privilege('anon', 'private.chat_agent_replies', 'SELECT') as anon_sel,
    has_table_privilege('authenticated', 'private.chat_agent_replies', 'SELECT') as auth_sel,
    has_table_privilege('service_role', 'private.chat_agent_replies', 'SELECT') as svc_sel
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and c.relname = 'chat_agent_replies'`);
  assert.equal(tbl.rls, true);
  assert.equal(tbl.pub_sel, false);
  assert.equal(tbl.anon_sel, false);
  assert.equal(tbl.auth_sel, false);
  assert.equal(tbl.svc_sel, false);

  const cols = (
    await db.query(
      `select column_name from information_schema.columns
       where table_schema = 'private' and table_name = 'chat_agent_replies'`,
    )
  ).rows.map((r) => r.column_name);
  for (const forbiddenCol of ['prompt_text', 'raw_prompt', 'raw_response', 'directory_index', 'raw_context']) {
    assert.ok(!cols.includes(forbiddenCol), forbiddenCol);
  }

  // service_role 전용 작업자 RPC를 authenticated/anon이 호출하면 42501로 차단된다.
  const owner = await createOwner();
  for (const role of ['anon', 'authenticated']) {
    await as(role, role === 'authenticated' ? owner : '');
    await assert.rejects(() => rpc('claim_chat_agent_reply', 60, null), forbidden);
    await assert.rejects(() => rpc('expire_stale_chat_agent_replies'), forbidden);
    await assert.rejects(() => rpc('read_chat_agent_reply_context', randomUUID(), 1, randomUUID()), forbidden);
    await assert.rejects(() => rpc('fail_chat_agent_reply', randomUUID(), 1, randomUUID(), 'err', '{}'), forbidden);
  }

  // 소유자 확인 RPC는 anon 차단
  await as('anon');
  await assert.rejects(() => rpc('prepare_chat_search_confirmation', randomUUID(), randomUUID()), forbidden);
  await assert.rejects(() => rpc('decide_chat_search_proposal', randomUUID(), randomUUID(), 'reject', null, null), forbidden);
});

test('feature disabled creates no chat agent queue rows and returns null agentReply', async () => {
  const owner = await createOwner();
  await as('authenticated', owner);
  const created = await rpc('create_chat', randomUUID(), '비활성 채팅');
  const posted = await rpc('post_chat_message', created.chat.chatId, randomUUID(), '광진구 7억 이하 찾아줘', 'help', null, null);
  assert.equal(posted.agentReply, null);
  assert.equal(posted.userMessage.agentReply, null);

  await db.exec('reset role');
  const count = await one('select count(*)::int as n from private.chat_agent_replies');
  assert.equal(count.n, 0);

  await as('authenticated', owner);
  const detail = await rpc('read_chat_detail', created.chat.chatId);
  assert.equal(detail.messages[0].agentReply, null);
});

test('queue, Q-42 llm_permission context filtering, lease expiry, fail, and cross-account 404 work accurately', async () => {
  const ownerA = await createOwner();
  const ownerB = await createOwner();
  await publishSyntheticDirectory();

  await as('service_role');
  await rpc('configure_agent_settings', true, 'gpt-6.2-sol');

  await as('authenticated', ownerA);
  const chat = (await rpc('create_chat', randomUUID(), '탐색 채팅')).chat;
  const posted = await rpc(
    'post_chat_message',
    chat.chatId,
    randomUUID(),
    '광진구랑 성동구에서 7억 이하, 84㎡ 정도로 찾아줘',
    'help',
    null,
    null,
  );
  assert.equal(posted.agentReply.status, 'queued');
  assert.equal(posted.agentReply.model, 'gpt-6.2-sol');
  const replyId = posted.agentReply.id;

  // 타 계정(ownerB)은 read_chat_detail, prepare, decide 모두 PT404
  await as('authenticated', ownerB);
  await assert.rejects(() => rpc('read_chat_detail', chat.chatId), notFound);
  await assert.rejects(() => rpc('prepare_chat_search_confirmation', chat.chatId, replyId), notFound);
  await assert.rejects(() => rpc('decide_chat_search_proposal', chat.chatId, replyId, 'reject', null, null), notFound);

  // Q-42: applyhome_remainder를 미허용(unknown)으로 제한하면 context에서 제외된다.
  await configureSources(['mois_legal_region_codes', 'applyhome_apt', 'applyhome_apt_model']);
  await as('service_role');
  const job = await rpc('claim_chat_agent_reply', 60, replyId);
  assert.equal(job.replyId, replyId);
  assert.equal(job.generation, 1);
  assert.equal(job.model, 'gpt-6.2-sol');

  const ctx = await rpc('read_chat_agent_reply_context', job.replyId, job.generation, job.leaseToken);
  assert.equal(ctx.llmSourcePolicy.newsExcluded, true);
  assert.equal(ctx.llmSourcePolicy.hasRestrictedSources, true);
  assert.ok(ctx.llmSourcePolicy.restrictedSources.includes('applyhome_remainder'));
  assert.equal(ctx.regions.length, 2);
  assert.equal(ctx.directoryIndex.notices.length, 1);
  assert.equal(ctx.directoryIndex.notices[0].noticeNo, '9900000101');

  // 임대 만료 시 소유자 조회는 즉시 expired를 반환하고(작성 중 미표시), stale worker는 PT409로 차단된다.
  await db.exec('reset role');
  await db.query(
    "update private.chat_agent_replies set lease_expires_at = clock_timestamp() - interval '5 seconds' where id = $1",
    [replyId],
  );
  await as('authenticated', ownerA);
  const expiredDetail = await rpc('read_chat_detail', chat.chatId);
  assert.equal(expiredDetail.messages[0].agentReply.status, 'expired');

  await as('service_role');
  await assert.rejects(
    () => rpc('fail_chat_agent_reply', job.replyId, job.generation, job.leaseToken, 'llm_timeout', '{}'),
    conflict,
  );
  const expiredCount = await rpc('expire_stale_chat_agent_replies');
  assert.equal(expiredCount, 1);

  // 새 메시지의 실패 기록 확인
  await as('authenticated', ownerA);
  const posted2 = await rpc('post_chat_message', chat.chatId, randomUUID(), '두 번째 질문', 'help', null, null);
  await as('service_role');
  const job2 = await rpc('claim_chat_agent_reply', 60, posted2.agentReply.id);
  const failed = await rpc('fail_chat_agent_reply', job2.replyId, job2.generation, job2.leaseToken, 'llm_rate_limited', json({ latencyMs: 120 }));
  assert.equal(failed.status, 'failed');
  await as('authenticated', ownerA);
  const detail2 = await rpc('read_chat_detail', chat.chatId);
  const found2 = detail2.messages.find((m) => m.id === posted2.userMessage.id);
  assert.equal(found2.agentReply.status, 'failed');
  assert.equal(found2.agentReply.answer, null);
});

test('confirm executes and records summary idempotently, reject/cancel execute nothing, and O-3 profile proposal stays pending', async () => {
  const owner = await createOwner();
  const idx = await publishSyntheticDirectory();

  await as('service_role');
  await rpc('configure_agent_settings', true, 'gpt-6.2-sol');

  await as('authenticated', owner);
  const chat = (await rpc('create_chat', randomUUID(), '확인 카드 채팅')).chat;
  const p1 = await rpc('post_chat_message', chat.chatId, randomUUID(), '광진구랑 성동구 7억 이하 84㎡ 다음에도 써줘', 'help', null, null);
  const p2 = await rpc('post_chat_message', chat.chatId, randomUUID(), '광진구 6억 이하 찾아줘', 'help', null, null);
  const p3 = await rpc('post_chat_message', chat.chatId, randomUUID(), '성동구 5억 이하 찾아줘', 'help', null, null);

  // 1) p1 완료: searchProposal + profileProposal(O-3 pending) 동시 첨부
  await as('service_role');
  const job1 = await rpc('claim_chat_agent_reply', 60, p1.agentReply.id);
  const searchConditions = {
    regionCodes: ['11200', '11215'],
    budgetMaxWon: '700000000',
    supplyArea: { min: '84', max: '84', unit: 'm2' },
    includeClosed: false,
  };
  const comp1 = await rpc(
    'complete_chat_agent_reply',
    job1.replyId,
    job1.generation,
    job1.leaseToken,
    'answered',
    'search_confirm',
    '희망 지역과 예산 700,000,000원, 공급면적 84㎡로 확인 카드를 준비했습니다. 공유 프로필 변경안은 O-3에서 승인해 주세요.',
    json([{ kind: 'region', reference: '11200,11215', label: '공식 지역 코드' }]),
    json(searchConditions),
    json({ patch: { region_codes: ['11200', '11215'], budget_max_won: '700000000' }, reason: '채팅 탐색 조건 재사용' }),
    null,
    json({ inputTokens: 400, outputTokens: 120, latencyMs: 300, estimatedCostUsd: '0.00200000', pricingAsOf: '2026-11-26' }),
    json({ status: 'passed', reasons: [] }),
    'chat-agent-v1',
  );
  assert.equal(comp1.status, 'answered');
  assert.equal(comp1.searchProposalAttached, true);
  assert.ok(comp1.profileChangeRequestId);

  // 공유 프로필은 절대 자동 승인되지 않으며 revision은 여전히 1이다.
  await as('authenticated', owner);
  const profBefore = await rpc('read_search_profile', null);
  assert.equal(profBefore.revision, 1);
  assert.equal(profBefore.conditions.budget_max_won, '900000000');
  const pendingProp = profBefore.proposals.find((p) => p.id === comp1.profileChangeRequestId);
  assert.equal(pendingProp.status, 'pending');
  assert.equal(pendingProp.analysisId, null);
  assert.equal(pendingProp.runId, null);

  // 확인 전 준비 RPC -> pending
  const prep = await rpc('prepare_chat_search_confirmation', chat.chatId, p1.agentReply.id);
  assert.equal(prep.status, 'pending');
  assert.deepEqual(prep.searchProposal.regionCodes, ['11200', '11215']);

  // appliedConditions 불일치 요약은 22023 거부
  const wrongSummary = makeSummary(idx, { ...searchConditions, budgetMaxWon: '800000000' });
  await assert.rejects(
    () => rpc('decide_chat_search_proposal', chat.chatId, p1.agentReply.id, 'confirm', json(searchConditions), json(wrongSummary)),
    invalid,
  );

  // 확인 실행 -> 결과 요약 저장 + chat_messages에 assistant 요약 메시지 기록
  const summary = makeSummary(idx, searchConditions);
  const confirmed = await rpc(
    'decide_chat_search_proposal',
    chat.chatId,
    p1.agentReply.id,
    'confirm',
    json(searchConditions),
    json(summary),
  );
  assert.equal(confirmed.agentReply.searchProposal.status, 'confirmed');
  assert.equal(confirmed.agentReply.searchProposal.resultSummary.counts.matched, 1);
  assert.equal(confirmed.agentReply.searchProposal.resultSummary.counts.needsReview, 1);
  assert.ok(confirmed.resultMessage.id);
  assert.match(confirmed.resultMessage.content, /조건 충족 1건, 확인 필요 1건/);

  // 같은 조건으로 멱등 재확인 -> 중복 메시지 생성 없이 같은 resultMessage 반환
  const replayed = await rpc(
    'decide_chat_search_proposal',
    chat.chatId,
    p1.agentReply.id,
    'confirm',
    json(searchConditions),
    json(summary),
  );
  assert.equal(replayed.resultMessage.id, confirmed.resultMessage.id);

  // 다른 조건으로 재확인 -> PT409
  await assert.rejects(
    () => rpc('decide_chat_search_proposal', chat.chatId, p1.agentReply.id, 'confirm', json({ ...searchConditions, budgetMaxWon: '800000000' }), json(wrongSummary)),
    conflict,
  );

  // O-3에서 사용자가 직접 승인 -> user_profiles 갱신 + read_chat_detail에 approved 반영
  const profAfter = await rpc('decide_search_profile_change', comp1.profileChangeRequestId, 'approve');
  assert.equal(profAfter.revision, 2);
  assert.equal(profAfter.conditions.budget_max_won, '700000000');
  const detailAfterO3 = await rpc('read_chat_detail', chat.chatId);
  const m1 = detailAfterO3.messages.find((m) => m.id === p1.userMessage.id);
  assert.equal(m1.agentReply.profileProposal.status, 'approved');

  // 2) p2 거절 -> 검색 결과 메시지 미생성, 이후 확인 시 PT409
  await as('service_role');
  const job2 = await rpc('claim_chat_agent_reply', 60, p2.agentReply.id);
  await rpc(
    'complete_chat_agent_reply',
    job2.replyId, job2.generation, job2.leaseToken,
    'answered', 'search_confirm', '광진구 600,000,000원으로 확인 카드를 준비했습니다.',
    '[]', json({ regionCodes: ['11215'], budgetMaxWon: '600000000', includeClosed: false }),
    null, null, '{}', json({ status: 'passed', reasons: [] }), 'chat-agent-v1',
  );
  await as('authenticated', owner);
  const msgCountBeforeReject = (await rpc('read_chat_detail', chat.chatId)).messages.length;
  const rejected = await rpc('decide_chat_search_proposal', chat.chatId, p2.agentReply.id, 'reject', null, null);
  assert.equal(rejected.agentReply.searchProposal.status, 'rejected');
  assert.equal(rejected.resultMessage, null);
  assert.equal((await rpc('read_chat_detail', chat.chatId)).messages.length, msgCountBeforeReject);
  await assert.rejects(
    () => rpc('decide_chat_search_proposal', chat.chatId, p2.agentReply.id, 'confirm', json({ regionCodes: ['11215'], budgetMaxWon: '600000000', includeClosed: false }), json(makeSummary(idx, { regionCodes: ['11215'], budgetMaxWon: '600000000', includeClosed: false }))),
    conflict,
  );

  // 3) p3 취소 -> 미실행 + 잘못된 서버 제안(미확인 지역 코드 99999)은 rejected 처리되고 고아 프로필 행이 남지 않는다.
  await as('service_role');
  const job3 = await rpc('claim_chat_agent_reply', 60, p3.agentReply.id);
  const badComp = await rpc(
    'complete_chat_agent_reply',
    job3.replyId, job3.generation, job3.leaseToken,
    'answered', 'search_confirm', '확인 카드입니다.',
    '[]', json({ regionCodes: ['99999'], budgetMaxWon: '500000000', includeClosed: false }),
    json({ patch: { budget_max_won: '500000000' }, reason: '고아 방지 확인' }),
    null, '{}', json({ status: 'passed', reasons: [] }), 'chat-agent-v1',
  );
  assert.equal(badComp.status, 'rejected');
  assert.equal(badComp.profileChangeRequestId, null);
  await db.exec('reset role');
  const orphanProps = await one("select count(*)::int as n from public.profile_change_requests where reason = '고아 방지 확인'");
  assert.equal(orphanProps.n, 0);
});

test('message, chat, and account deletion cascade chat_agent_replies and block in-flight workers with PT404', async () => {
  const ownerA = await createOwner();
  const ownerB = await createOwner();
  await publishSyntheticDirectory();

  await as('service_role');
  await rpc('configure_agent_settings', true, 'gpt-6.2-sol');

  await as('authenticated', ownerA);
  const chat1 = (await rpc('create_chat', randomUUID(), '삭제 테스트 1')).chat;
  const chat2 = (await rpc('create_chat', randomUUID(), '삭제 테스트 2')).chat;
  const msg1 = await rpc('post_chat_message', chat1.chatId, randomUUID(), '메시지 삭제 대상', 'help', null, null);
  const msg2 = await rpc('post_chat_message', chat1.chatId, randomUUID(), '채팅 삭제 대상', 'help', null, null);
  const msg3 = await rpc('post_chat_message', chat2.chatId, randomUUID(), '계정 삭제 대상', 'help', null, null);

  await as('authenticated', ownerB);
  const chatB = (await rpc('create_chat', randomUUID(), '타인 채팅')).chat;
  const msgB = await rpc('post_chat_message', chatB.chatId, randomUUID(), '타인 메시지', 'help', null, null);

  // 모든 작업을 임대해 둔 상태에서 각각 삭제해 cascade 및 작업자 PT404 차단을 검증한다.
  await as('service_role');
  const job1 = await rpc('claim_chat_agent_reply', 60, msg1.agentReply.id);
  const job2 = await rpc('claim_chat_agent_reply', 60, msg2.agentReply.id);
  const job3 = await rpc('claim_chat_agent_reply', 60, msg3.agentReply.id);

  // 1) 개별 메시지 삭제
  await as('authenticated', ownerA);
  await rpc('delete_personal_data', 'message', randomUUID(), msg1.userMessage.id);
  await as('service_role');
  await assert.rejects(
    () => rpc('complete_chat_agent_reply', job1.replyId, job1.generation, job1.leaseToken, 'answered', 'help', '답변', '[]', null, null, null, '{}', '{}', 'chat-agent-v1'),
    notFound,
  );

  // 2) 채팅 삭제
  await as('authenticated', ownerA);
  await rpc('delete_personal_data', 'chat', randomUUID(), chat1.chatId);
  await as('service_role');
  await assert.rejects(
    () => rpc('complete_chat_agent_reply', job2.replyId, job2.generation, job2.leaseToken, 'answered', 'help', '답변', '[]', null, null, null, '{}', '{}', 'chat-agent-v1'),
    notFound,
  );

  // 3) 계정 삭제 -> ownerA 잔여 응답 삭제·차단, ownerB 응답은 그대로 유지
  await as('authenticated', ownerA);
  await rpc('request_account_deletion', randomUUID());
  await as('service_role');
  await assert.rejects(
    () => rpc('complete_chat_agent_reply', job3.replyId, job3.generation, job3.leaseToken, 'answered', 'help', '답변', '[]', null, null, null, '{}', '{}', 'chat-agent-v1'),
    notFound,
  );

  await db.exec('reset role');
  const leftA = await one('select count(*)::int as n from private.chat_agent_replies where user_id = $1', [ownerA]);
  const leftB = await one('select count(*)::int as n from private.chat_agent_replies where user_id = $1 and id = $2', [ownerB, msgB.agentReply.id]);
  assert.equal(leftA.n, 0);
  assert.equal(leftB.n, 1);
});
