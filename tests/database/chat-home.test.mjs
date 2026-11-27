// S-01 채팅 홈·채팅 화면·S-02 공고 찾기 RPC의 권한, 격리, 멱등성, 삭제 연동을 합성 자료로 검사한다.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { createBe03Db } from './helpers/be03-db.mjs';

const koreanDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });
const sourceIds = [
  'applyhome_apt',
  'applyhome_remainder',
  'applyhome_apt_model',
  'applyhome_remainder_model',
  'mois_legal_region_codes',
  'apt_trade',
  'apt_rights',
];
const regionCode = '11215';
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
    "select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claims',$2,false)",
    [userId, JSON.stringify({ sub: userId, is_anonymous: anonymous })],
  );
  await db.exec(`set role ${role}`);
}

async function rpc(name, ...params) {
  const args = params.map((_, index) => `$${index + 1}`).join(', ');
  return (await one(`select public.${name}(${args}) as value`, params)).value;
}

async function createUser(verified = true) {
  const userId = randomUUID();
  await db.exec('reset role');
  await db.query(
    'insert into auth.users(id,confirmed_at) values ($1,case when $2 then now() end)',
    [userId, verified],
  );
  return userId;
}

function syntheticDirectoryIndex(observed = new Date()) {
  const day = koreanDate.format(observed);
  const start = koreanDate.format(new Date(observed.getTime() - 90 * 24 * 3600 * 1000));
  const earlier = koreanDate.format(new Date(observed.getTime() - 60 * 24 * 3600 * 1000));
  return {
    contractVersion: 'notice-search-index/v1',
    dataOrigin: 'collected',
    observedAt: observed.toISOString(),
    publicationWindow: { start, end: day },
    regionCodes: [regionCode],
    coverage: {
      status: 'complete',
      sources: [
        { source: 'applyhome_apt', status: 'complete' },
        { source: 'applyhome_remainder', status: 'complete' },
      ],
    },
    notices: [
      {
        houseManageNo: '9900000040',
        noticeNo: '9900000040',
        edition: day,
        title: '합성 센트럴 아이파크',
        kind: 'resupply',
        regionCode,
        moveIn: null,
        application: { start: day, end: day },
        inventoryComplete: false,
        models: [{ modelNo: '01', houseType: '084.9811C', supplyAreaM2: null, areaEvidence: [], rooms: [] }],
        sourceIds: ['applyhome_remainder', 'applyhome_remainder_model'],
        reasonCodes: [],
      },
      {
        houseManageNo: '9900000019',
        noticeNo: '9900000019',
        edition: earlier,
        title: '합성 센트럴 아이파크',
        kind: 'resupply',
        regionCode,
        moveIn: null,
        application: { start: earlier, end: earlier },
        inventoryComplete: false,
        models: [],
        sourceIds: ['applyhome_remainder'],
        reasonCodes: ['model_unverified'],
      },
      {
        houseManageNo: '9900000101',
        noticeNo: '9900000101',
        edition: day,
        title: '합성 가람 아파트',
        kind: 'new_sale',
        regionCode,
        moveIn: null,
        application: { start: day, end: day },
        inventoryComplete: false,
        models: [{ modelNo: '01', houseType: '084.0000A', supplyAreaM2: null, areaEvidence: [], rooms: [] }],
        sourceIds: ['applyhome_apt', 'applyhome_apt_model'],
        reasonCodes: [],
      },
      {
        houseManageNo: '9900000999',
        noticeNo: '9900000999',
        edition: day,
        title: '합성 제외 유형 공고',
        kind: 'unsupported',
        regionCode,
        moveIn: null,
        application: { start: day, end: day },
        inventoryComplete: false,
        models: [],
        sourceIds: ['applyhome_apt'],
        reasonCodes: ['notice_kind_unsupported'],
      },
    ],
  };
}

async function publishIndex(index = syntheticDirectoryIndex()) {
  await as('service_role');
  await rpc('publish_notice_directory', JSON.stringify(index), JSON.stringify({ [regionCode]: '서울특별시 광진구' }));
  return index;
}

before(async () => {
  db = await createBe03Db();
  await db.exec(`alter table auth.users add column confirmed_at timestamptz,
    add column is_anonymous boolean not null default false,
    add column banned_until timestamptz, add column deleted_at timestamptz`);
});

beforeEach(async () => {
  await db.exec(`reset role;
    delete from private.notice_search_index;
    delete from private.notice_directory_publication;`);
  await db.query(
    `insert into public.source_registry(id,display_name,storage_permission,reuse_permission,display_permission)
     select id,'합성 출처','allowed','allowed','allowed' from unnest($1::text[]) source(id)
     on conflict (id) do update set storage_permission='allowed', reuse_permission='allowed',
       display_permission='allowed', retention_days=null`,
    [sourceIds],
  );
});

after(async () => db?.close());

test('chat home RPCs enforce narrow security invoker grants, RLS, and block direct assistant inserts', async () => {
  await db.exec('reset role');
  const publicSigs = [
    'public.list_chats(uuid,integer)',
    'public.create_chat(uuid,text)',
    'public.read_chat_detail(uuid)',
    'public.rename_chat(uuid,text)',
    'public.post_chat_message(uuid,uuid,text,text,text,text)',
    'public.start_chat_notice_workspace(uuid,uuid,jsonb)',
  ];
  for (const sig of publicSigs) {
    const def = await one('select prosecdef from pg_proc where oid = $1::regprocedure', [sig]);
    assert.equal(def.prosecdef, false, `${sig} must be security invoker`);
    assert.equal((await one("select has_function_privilege('authenticated', $1, 'EXECUTE') as ok", [sig])).ok, true, sig);
    for (const role of ['public', 'anon', 'service_role']) {
      assert.equal((await one('select has_function_privilege($1, $2, $3) as ok', [role, sig, 'EXECUTE'])).ok, false, `${role} ${sig}`);
    }
  }
  for (const internal of [
    'private.chat_home_owner()',
    'private.normalize_chat_title(text)',
    'private.normalize_chat_message(text)',
    'private.chat_summary_json(uuid,uuid,text,timestamptz,timestamptz)',
  ]) {
    for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
      assert.equal((await one('select has_function_privilege($1, $2, $3) as ok', [role, internal, 'EXECUTE'])).ok, false, `${role} ${internal}`);
    }
  }

  const userA = await createUser();
  await as('anon');
  await assert.rejects(rpc('list_chats', null, 20), forbidden);
  await assert.rejects(rpc('create_chat', randomUUID(), '익명 불가'), forbidden);

  await as('authenticated', userA, true);
  await assert.rejects(rpc('list_chats', null, 20), forbidden);
  await assert.rejects(rpc('create_chat', randomUUID(), '익명 로그인 불가'), forbidden);

  await as('authenticated', userA);
  const created = await rpc('create_chat', randomUUID(), '합성 테스트 채팅');
  await assert.rejects(
    db.query("insert into public.chat_messages(user_id,chat_id,role,content) values ($1,$2,'assistant','위조 응답')", [
      userA,
      created.chat.chatId,
    ]),
    /row-level security/,
  );
});

test('multi-chat creation, idempotency, rename, cursor pagination and recent activity ordering work cleanly', async () => {
  const userA = await createUser();
  await as('authenticated', userA);

  const key1 = randomUUID();
  const c1 = await rpc('create_chat', key1, '첫 번째 합성 채팅');
  assert.equal(c1.contractVersion, 'chat-home/v1');
  assert.equal(c1.chat.title, '첫 번째 합성 채팅');
  assert.equal(c1.chat.analysisCount, 0);
  assert.equal(c1.chat.messageCount, 0);

  // 같은 멱등 키 재요청은 같은 채팅을 돌려준다.
  const replay = await rpc('create_chat', key1, '첫 번째 합성 채팅');
  assert.equal(replay.chat.chatId, c1.chat.chatId);

  // 같은 키에 다른 제목은 PT409 충돌이다.
  await assert.rejects(rpc('create_chat', key1, '다른 제목'), conflict);

  // 잘못된 제목(공백·제어문자·200자 초과)은 거부된다.
  await assert.rejects(rpc('create_chat', randomUUID(), '   '), invalid);
  await assert.rejects(rpc('create_chat', randomUUID(), '줄바꿈\n불가'), invalid);
  await assert.rejects(rpc('create_chat', randomUUID(), '가'.repeat(201)), invalid);

  const c2 = await rpc('create_chat', randomUUID(), null);
  assert.equal(c2.chat.title, '새 채팅');
  const c3 = await rpc('create_chat', randomUUID(), '세 번째 채팅');

  // 제목 변경
  const renamed = await rpc('rename_chat', c2.chat.chatId, '이름 바꾼 합성 채팅');
  assert.equal(renamed.chat.title, '이름 바꾼 합성 채팅');
  await assert.rejects(rpc('rename_chat', c2.chat.chatId, ''), invalid);

  // 페이지네이션 (limit 2 + cursor)
  const page1 = await rpc('list_chats', null, 2);
  assert.equal(page1.contractVersion, 'chat-home/v1');
  assert.equal(page1.chats.length, 2);
  assert.ok(page1.nextCursor);

  const page2 = await rpc('list_chats', page1.nextCursor, 2);
  assert.equal(page2.chats.length, 1);
  assert.equal(page2.nextCursor, null);

  const allIds = [...page1.chats, ...page2.chats].map((c) => c.chatId);
  assert.equal(new Set(allIds).size, 3);
  assert.ok(allIds.includes(c1.chat.chatId));
  assert.ok(allIds.includes(c2.chat.chatId));
  assert.ok(allIds.includes(c3.chat.chatId));

  await assert.rejects(rpc('list_chats', null, 0), invalid);
  await assert.rejects(rpc('list_chats', null, 51), invalid);
  await assert.rejects(rpc('list_chats', randomUUID(), 20), notFound);
});

test('post_chat_message saves user and server-generated assistant replies with same-name edition grounding and idempotency', async () => {
  const userA = await createUser();
  await publishIndex();

  await as('authenticated', userA);
  const chat = (await rpc('create_chat', randomUUID(), '공고 찾기 채팅')).chat;

  // 같은 이름 2개 회차 검색
  const reqKey = randomUUID();
  const res = await rpc('post_chat_message', chat.chatId, reqKey, '합성 센트럴 아이파크', 'lookup', '합성 센트럴 아이파크', 'name');
  assert.equal(res.contractVersion, 'chat-message/v1');
  assert.equal(res.userMessage.role, 'user');
  assert.equal(res.userMessage.content, '합성 센트럴 아이파크');
  assert.equal(res.assistantMessage.role, 'assistant');
  assert.match(res.assistantMessage.content, /총 2건/);
  assert.match(res.assistantMessage.content, /합치지 않았습니다/);
  assert.match(res.assistantMessage.content, /모집공고일/);
  assert.match(res.assistantMessage.content, /관측 시각/);

  // 멱등 재시도 및 충돌
  const retry = await rpc('post_chat_message', chat.chatId, reqKey, '합성 센트럴 아이파크', 'lookup', '합성 센트럴 아이파크', 'name');
  assert.equal(retry.userMessage.id, res.userMessage.id);
  assert.equal(retry.assistantMessage.id, res.assistantMessage.id);
  await assert.rejects(
    rpc('post_chat_message', chat.chatId, reqKey, '다른 메시지', 'help', null, null),
    conflict,
  );

  // 조회 범위 밖 0건 안내 (제외 유형 공고는 매칭하지 않음)
  const zeroRes = await rpc('post_chat_message', chat.chatId, randomUUID(), '합성 제외 유형 공고', 'lookup', '합성 제외 유형 공고', 'name');
  assert.match(zeroRes.assistantMessage.content, /찾지 못했습니다/);
  assert.match(zeroRes.assistantMessage.content, /조회 범위 밖/);

  // 자유 질문 정형 응답 및 PDF 안내
  const helpRes = await rpc('post_chat_message', chat.chatId, randomUUID(), '여기 청약 자격 되나요?', 'help', null, null);
  assert.match(helpRes.assistantMessage.content, /개인 청약 자격 판정이나 가격 전망은 제공하지 않습니다/);

  const pdfRes = await rpc('post_chat_message', chat.chatId, randomUUID(), 'PDF 올리기', 'pdf_guide', null, null);
  assert.match(pdfRes.assistantMessage.content, /공고와 주택형을 먼저 고른 뒤 분석 화면에서/);

  // 출처 표시 권한 회수 시 0건으로 처리하지 않고 보류 안내
  await db.exec("reset role; update public.source_registry set display_permission='denied' where id='applyhome_apt';");
  await as('authenticated', userA);
  const restrictedRes = await rpc('post_chat_message', chat.chatId, randomUUID(), '합성 가람 아파트', 'lookup', '합성 가람 아파트', 'name');
  assert.match(restrictedRes.assistantMessage.content, /표시 권한을 확인 중/);

  // 색인이 72시간 넘게 만료되면 준비 중 안내
  await db.exec("reset role; update public.source_registry set display_permission='allowed' where id='applyhome_apt';");
  await db.query(
    `update private.notice_directory_publication set index_value=jsonb_set(index_value,'{observedAt}',$1)`,
    [JSON.stringify(new Date(Date.now() - 73 * 3600 * 1000).toISOString())],
  );
  await as('authenticated', userA);
  const staleRes = await rpc('post_chat_message', chat.chatId, randomUUID(), '합성 가람 아파트', 'lookup', '합성 가람 아파트', 'name');
  assert.match(staleRes.assistantMessage.content, /색인을 준비 중/);

  // 시간순 복원 확인
  const detail = await rpc('read_chat_detail', chat.chatId);
  assert.equal(detail.messages.length, 12);
  assert.deepEqual(
    detail.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
  );
});

test('post_chat_message never records a confirmed zero or unqualified count from a partially collected index', async () => {
  const userA = await createUser();
  await publishIndex();
  // 합성 색인의 수집 상태만 부분 수집으로 바꿔 공유 검색 색인 대체 경로의 부분 수집을 재현한다.
  await db.exec(`reset role;
    update private.notice_directory_publication
      set index_value = jsonb_set(index_value, '{coverage,status}', '"partial"');`);

  await as('authenticated', userA);
  const chat = (await rpc('create_chat', randomUUID(), '부분 수집 합성 채팅')).chat;

  const zero = await rpc('post_chat_message', chat.chatId, randomUUID(), '합성 없는 단지', 'lookup', '합성 없는 단지', 'name');
  assert.match(zero.assistantMessage.content, /수집이 완전하지 않아/);
  assert.match(zero.assistantMessage.content, /확정할 수 없습니다/);
  assert.doesNotMatch(zero.assistantMessage.content, /찾지 못했습니다/);

  const found = await rpc('post_chat_message', chat.chatId, randomUUID(), '합성 가람 아파트', 'lookup', '합성 가람 아파트', 'name');
  assert.match(found.assistantMessage.content, /1건을 찾았습니다/);
  assert.match(found.assistantMessage.content, /누락된 회차가 있을 수 있습니다/);
});

test('start_chat_notice_workspace attaches analyses to the chosen chat, prevents orphans, and integrates with deletion', async () => {
  const userA = await createUser();
  const userB = await createUser();
  const idx = await publishIndex();
  const day = idx.publicationWindow.end;

  await as('authenticated', userA);
  const chat1 = (await rpc('create_chat', randomUUID(), '내 청약 검토')).chat;
  const chat2 = (await rpc('create_chat', randomUUID(), '두 번째 검토')).chat;
  await rpc('post_chat_message', chat1.chatId, randomUUID(), '합성 센트럴 아이파크', 'lookup', '합성 센트럴 아이파크', 'name');

  const inputA = {
    kind: 'notice',
    noticeSource: 'applyhome_remainder',
    houseManageNo: '9900000040',
    noticeNo: '9900000040',
    edition: day,
    modelNo: '01',
  };
  const runKey = randomUUID();
  const started = await rpc('start_chat_notice_workspace', chat1.chatId, runKey, JSON.stringify(inputA));
  assert.equal(started.chatId, chat1.chatId);
  assert.equal(started.status, 'queued');

  // 같은 키·같은 채팅 재시도는 동일 실행을 복원한다.
  const replayed = await rpc('start_chat_notice_workspace', chat1.chatId, runKey, JSON.stringify(inputA));
  assert.equal(replayed.analysisId, started.analysisId);
  assert.equal(replayed.runId, started.runId);

  // 같은 키를 다른 채팅에 재사용하면 PT409 충돌이다.
  await assert.rejects(
    rpc('start_chat_notice_workspace', chat2.chatId, runKey, JSON.stringify(inputA)),
    conflict,
  );

  // 없는 주택형 선택은 롤백되어 고아 분석을 남기지 않는다.
  await assert.rejects(
    rpc('start_chat_notice_workspace', chat1.chatId, randomUUID(), JSON.stringify({ ...inputA, modelNo: '99' })),
    { code: 'PT409', message: 'notice_model_not_found' },
  );

  const detail = await rpc('read_chat_detail', chat1.chatId);
  assert.equal(detail.analyses.length, 1);
  assert.equal(detail.analyses[0].analysisId, started.analysisId);
  assert.equal(detail.analyses[0].latestRunId, started.runId);
  assert.equal(detail.analyses[0].latestRunStatus, 'queued');
  assert.equal(detail.analyses[0].noticeNo, '9900000040');
  assert.equal(detail.analyses[0].houseType, '084.9811C');

  // 같은 채팅에 두 번째 분석을 연결할 수 있다.
  const inputB = {
    kind: 'notice',
    noticeSource: 'applyhome_apt',
    houseManageNo: '9900000101',
    noticeNo: '9900000101',
    edition: day,
    modelNo: '01',
  };
  const started2 = await rpc('start_chat_notice_workspace', chat1.chatId, randomUUID(), JSON.stringify(inputB));
  assert.equal(started2.chatId, chat1.chatId);
  assert.notEqual(started2.analysisId, started.analysisId);

  const homeList = await rpc('list_chats', null, 20);
  const summary = homeList.chats.find((c) => c.chatId === chat1.chatId);
  assert.equal(summary.analysisCount, 2);
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.latestAnalysis.latestRunStatus, 'queued');

  // 다른 계정(userB)은 목록·상세·이름변경·메시지·분석연결 모두 차단(404/미노출)된다.
  await as('authenticated', userB);
  const listB = await rpc('list_chats', null, 20);
  assert.equal(listB.chats.length, 0);
  await assert.rejects(rpc('read_chat_detail', chat1.chatId), notFound);
  await assert.rejects(rpc('rename_chat', chat1.chatId, '타인 수정'), notFound);
  await assert.rejects(rpc('post_chat_message', chat1.chatId, randomUUID(), '타인 메시지', 'help', null, null), notFound);
  await assert.rejects(
    rpc('start_chat_notice_workspace', chat1.chatId, randomUUID(), JSON.stringify(inputA)),
    notFound,
  );

  // 기존 삭제 범위('chat')가 채팅의 사용자/assistant 메시지와 연결된 분석을 모두 포함해 삭제하고 키를 은퇴시킨다.
  await as('authenticated', userA);
  const impact = await rpc('read_deletion_impact', 'chat', chat1.chatId);
  assert.equal(impact.counts.chats, 1);
  assert.equal(impact.counts.messages, 2);
  assert.equal(impact.counts.analyses, 2);
  assert.equal(impact.counts.runs, 2);

  await rpc('delete_personal_data', 'chat', randomUUID(), chat1.chatId);
  await assert.rejects(rpc('read_chat_detail', chat1.chatId), notFound);

  // 은퇴한 workspace 키의 지연 재시도는 PT409로 거부된다.
  await assert.rejects(
    rpc('start_chat_notice_workspace', chat2.chatId, runKey, JSON.stringify(inputA)),
    { code: 'PT409', message: 'workspace_request_retired' },
  );

  // 계정 삭제 울타리가 활성화되면 모든 채팅 RPC가 42501로 차단된다.
  await rpc('request_account_deletion', randomUUID());
  await assert.rejects(rpc('list_chats', null, 20), forbidden);
  await assert.rejects(rpc('create_chat', randomUUID(), '삭제 후 불가'), forbidden);
  await assert.rejects(rpc('read_chat_detail', chat2.chatId), forbidden);
});
