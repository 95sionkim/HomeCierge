// 네트워크·실제 계정 없이 공고 찾기(S-02), 규칙 기반 채팅 분류, 채팅 API 라우트를 합성 자료로 검사한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from '../../src/server/handler.js';
import type { Backend, Environment } from '../../src/server/handler.js';
import { createBackend } from '../../src/server/supabase.js';
import {
  classifyChatInput,
  evaluateNoticeLookup,
  parseNoticeLookupQuery,
} from '../../src/server/notice-lookup.js';

const env: Environment = {
  SUPABASE_URL: 'https://synthetic.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC_NOT_A_REAL_KEY',
  APP_ENV: 'preview',
  ALLOWED_ORIGINS: 'https://frontend.invalid',
};
const auth = { Authorization: 'Bearer SYNTHETIC_USER_TOKEN' };
const jsonHeaders = { ...auth, 'Content-Type': 'application/json' };
const asOf = '2026-11-22';
const observedAt = '2026-11-22T00:17:00+09:00';
const publicationWindow = { start: '2026-08-25', end: '2026-11-22' };
const chatId = 'c1000000-0000-4000-8000-000000000001';
const requestId = 'c1000000-0000-4000-8000-000000000002';
const analysisId = 'c1000000-0000-4000-8000-000000000003';
const runId = 'c1000000-0000-4000-8000-000000000004';

function syntheticIndex(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 'notice-search-index/v1',
    dataOrigin: 'collected',
    observedAt,
    publicationWindow,
    regionCodes: ['11200', '11215'],
    regionNames: { '11215': '서울특별시 광진구', '11200': '서울특별시 성동구' },
    coverage: {
      status: 'complete',
      sources: [
        { source: 'applyhome_apt', status: 'complete' },
        { source: 'applyhome_remainder', status: 'complete' },
      ],
    },
    notices: [
      {
        houseManageNo: '9900000019',
        noticeNo: '9900000019',
        edition: '2026-09-01',
        title: '합성 센트럴 아이파크',
        kind: 'resupply',
        regionCode: '11215',
        application: { start: '2026-09-05', end: '2026-09-06' },
        moveIn: null,
        inventoryComplete: false,
        models: [],
        sourceIds: ['applyhome_remainder'],
        reasonCodes: ['model_unverified'],
      },
      {
        houseManageNo: '9900000040',
        noticeNo: '9900000040',
        edition: '2026-10-23',
        title: '합성 센트럴 아이파크',
        kind: 'resupply',
        regionCode: '11215',
        application: { start: '2026-10-28', end: '2026-10-29' },
        moveIn: null,
        inventoryComplete: false,
        models: [{ modelNo: '01', houseType: '084.9811C', supplyAreaM2: null, areaEvidence: [], rooms: [] }],
        sourceIds: ['applyhome_remainder', 'applyhome_remainder_model'],
        reasonCodes: [],
      },
      {
        houseManageNo: '9900000101',
        noticeNo: '9900000102',
        edition: '2026-11-10',
        title: '합성 가람 아파트',
        kind: 'new_sale',
        regionCode: '11200',
        application: { start: '2026-11-20', end: '2026-11-24' },
        moveIn: null,
        inventoryComplete: false,
        models: [{ modelNo: '01', houseType: '084.0000A', supplyAreaM2: null, areaEvidence: [], rooms: [] }],
        sourceIds: ['applyhome_apt', 'applyhome_apt_model'],
        reasonCodes: [],
      },
      {
        houseManageNo: '9900000999',
        noticeNo: '9900000999',
        edition: '2026-11-11',
        title: '합성 제외 오피스텔',
        kind: 'unsupported',
        regionCode: '11215',
        application: { start: '2026-11-20', end: '2026-11-22' },
        moveIn: null,
        inventoryComplete: false,
        models: [],
        sourceIds: ['applyhome_apt'],
        reasonCodes: ['notice_kind_unsupported'],
      },
    ],
    ...overrides,
  };
}

function makeBackend(overrides: Partial<Backend> = {}): Backend {
  return {
    getUser: async () => ({ id: 'u1000000-0000-4000-8000-000000000001', isAnonymous: false }),
    getProfile: async () => null,
    getUploadContent: async () => null,
    runAnalysis: async () => { throw new Error('unexpected'); },
    getNoticeSearchIndex: async () => syntheticIndex(),
    getFundingInputs: async () => { throw new Error('unexpected'); },
    getLegalEvidence: async () => { throw new Error('unexpected'); },
    prepareCommute: async () => { throw new Error('unexpected'); },
    prepareRegionalNews: async () => { throw new Error('unexpected'); },
    getComparison: async () => { throw new Error('unexpected'); },
    getComparisonEvidence: async () => { throw new Error('unexpected'); },
    analysisConversation: async () => { throw new Error('unexpected'); },
    savedReport: async () => { throw new Error('unexpected'); },
    dataDeletion: async () => { throw new Error('unexpected'); },
    chatHome: async () => { throw new Error('unexpected_chat_home'); },
    ...overrides,
  };
}

const req = (path: string, init: RequestInit = {}) => new Request(`https://api.invalid${path}`, init);

test('parseNoticeLookupQuery strictly validates query keys, modes, digits and lengths', () => {
  assert.deepEqual(parseNoticeLookupQuery(new URLSearchParams('q=합성 가람')), {
    raw: '합성 가람', normalized: '합성 가람', mode: 'name',
  });
  assert.deepEqual(parseNoticeLookupQuery(new URLSearchParams('q=9900000040')), {
    raw: '9900000040', normalized: '9900000040', mode: 'number',
  });
  assert.deepEqual(parseNoticeLookupQuery(new URLSearchParams('q=9900-000040&mode=number')), {
    raw: '9900-000040', normalized: '9900000040', mode: 'number',
  });
  assert.deepEqual(parseNoticeLookupQuery(new URLSearchParams('q=9900000040&mode=name')), {
    raw: '9900000040', normalized: '9900000040', mode: 'name',
  });
  for (const bad of [
    '',
    'q=',
    'q=%20%20',
    'q=abc&mode=number',
    'q=12345678901&mode=number',
    'q=합성&mode=other',
    'q=합성&q=중복',
    'q=합성&extra=1',
    `q=${'가'.repeat(121)}`,
  ]) {
    assert.equal(parseNoticeLookupQuery(new URLSearchParams(bad)), null, bad);
  }
});

test('classifyChatInput deterministically separates notice number, notice name, PDF guidance and free questions', () => {
  assert.deepEqual(classifyChatInput('9900000040'), {
    message: '9900000040', action: 'lookup', query: '9900000040', mode: 'number',
  });
  assert.deepEqual(classifyChatInput('공고번호 9900000040 찾아줘'), {
    message: '공고번호 9900000040 찾아줘', action: 'lookup', query: '9900000040', mode: 'number',
  });
  assert.deepEqual(classifyChatInput('합성 센트럴 아이파크 찾아주세요'), {
    message: '합성 센트럴 아이파크 찾아주세요', action: 'lookup', query: '합성 센트럴 아이파크', mode: 'name',
  });
  assert.deepEqual(classifyChatInput('공고 PDF 올리기'), {
    message: '공고 PDF 올리기', action: 'pdf_guide', query: null, mode: null,
  });
  for (const freeQuestion of [
    '여기 청약 자격 되나요?',
    '집값 오를까요?',
    '안녕하세요',
    '대출 얼마나 나오나요',
    '합성 센트럴 아이파크 사도 될까요?',
    '공고 찾아줘',
  ]) {
    assert.equal(classifyChatInput(freeQuestion)?.action, 'help', freeQuestion);
  }
  assert.equal(classifyChatInput('   '), null);
  assert.equal(classifyChatInput('가'.repeat(801)), null);
  assert.equal(classifyChatInput('abc', 'number'), null);
});

test('evaluateNoticeLookup never merges same-name editions, distinguishes metadata, and exposes out-of-scope limits', () => {
  const byName = evaluateNoticeLookup(
    syntheticIndex(),
    { raw: '합성센트럴아이파크', normalized: '합성센트럴아이파크', mode: 'name' },
    asOf,
  );
  assert.equal(byName.contractVersion, 'notice-lookup/v1');
  assert.equal(byName.counts.matched, 2);
  assert.equal(byName.counts.returned, 2);
  assert.equal(byName.counts.sameTitleGroups, 1);
  assert.equal(byName.counts.excludedUnsupported, 1);
  assert.deepEqual(byName.publicationWindow, publicationWindow);
  assert.equal(byName.observedAt, observedAt);
  assert.match(byName.outOfScopeNotice, /조회 범위 밖/);

  // 최신 공고일이 먼저 오며 이름만 같은 두 회차가 합쳐지지 않는다.
  assert.deepEqual(
    byName.notices.map((n) => [n.noticeNo, n.houseManageNo, n.edition, n.kind, n.applicationStatus, n.sameTitleCount]),
    [
      ['9900000040', '9900000040', '2026-10-23', 'resupply', 'closed', 2],
      ['9900000019', '9900000019', '2026-09-01', 'resupply', 'closed', 2],
    ],
  );
  assert.ok(byName.notices[0]!.models[0]!.analysisInput);
  assert.equal(byName.notices[1]!.models.length, 0);
  assert.equal(byName.notices[1]!.checks.models, 'unavailable');

  // 공고번호와 주택관리번호가 다른 공고도 두 식별자로 찾을 수 있다.
  const byManageNo = evaluateNoticeLookup(
    syntheticIndex(),
    { raw: '9900000101', normalized: '9900000101', mode: 'number' },
    asOf,
  );
  assert.equal(byManageNo.counts.matched, 1);
  assert.equal(byManageNo.notices[0]!.noticeNo, '9900000102');
  assert.equal(byManageNo.notices[0]!.houseManageNo, '9900000101');
  assert.equal(byManageNo.notices[0]!.applicationStatus, 'open');

  // 조회 범위 밖 번호 검색 시 0건과 범위 안내 반환
  const none = evaluateNoticeLookup(
    syntheticIndex(),
    { raw: '2020000001', normalized: '2020000001', mode: 'number' },
    asOf,
  );
  assert.equal(none.counts.matched, 0);
  assert.deepEqual(none.notices, []);
  assert.match(none.outOfScopeNotice, /조회 범위 밖/);
});

test('lookup and chat HTTP routes enforce authentication, origin, methods, validation, and 404/409/503 semantics', async () => {
  const calls: unknown[] = [];
  let indexBehavior: 'ready' | 'missing' | 'restricted' = 'ready';
  const handler = createHandler({
    env,
    now: () => new Date('2026-11-22T02:00:00Z'),
    createBackend: () =>
      makeBackend({
        getNoticeSearchIndex: async () => {
          if (indexBehavior === 'missing') return null;
          if (indexBehavior === 'restricted') {
            const { ApiError } = await import('../../src/server/http-input.js');
            throw new ApiError('search_source_restricted');
          }
          return syntheticIndex();
        },
        chatHome: async (op) => {
          calls.push(op);
          if (op.action === 'list') return { contractVersion: 'chat-home/v1', chats: [], nextCursor: null };
          if (op.action === 'create') {
            return { contractVersion: 'chat-home/v1', chat: { chatId, title: op.title ?? '새 채팅' } };
          }
          if (op.action === 'detail') {
            return { contractVersion: 'chat-detail/v1', chat: { chatId, title: '합성' }, messages: [], analyses: [] };
          }
          if (op.action === 'rename') {
            return { contractVersion: 'chat-home/v1', chat: { chatId, title: op.title } };
          }
          if (op.action === 'message') {
            return {
              contractVersion: 'chat-message/v1',
              chatId,
              action: op.replyAction,
              userMessage: { id: 'm1', role: 'user', content: op.message, createdAt: observedAt },
              assistantMessage: { id: 'm2', role: 'assistant', content: '합성 응답', createdAt: observedAt },
            };
          }
          return {
            chatId,
            analysisId,
            runId,
            status: 'queued',
            attempt: 0,
            submittedAt: observedAt,
            finishedAt: null,
            snapshotId: null,
            errorCode: null,
            input: op.input,
          };
        },
      }),
  });

  // 비로그인(A-51) 및 미허용 Origin 차단
  for (const path of ['/api/v1/notices/lookup?q=합성', '/api/v1/chats', `/api/v1/chats/${chatId}`]) {
    assert.equal((await handler(req(path))).status, 401, path);
    assert.equal((await handler(req(path, { headers: { ...auth, Origin: 'https://evil.invalid' } }))).status, 403);
  }

  // 허용 메서드 검사
  assert.equal((await handler(req('/api/v1/notices/lookup?q=합성', { method: 'POST', headers: auth }))).status, 405);
  assert.equal((await handler(req(`/api/v1/chats/${chatId}`, { method: 'DELETE', headers: auth }))).status, 405);
  assert.equal((await handler(req(`/api/v1/chats/${chatId}/messages`, { method: 'GET', headers: auth }))).status, 405);

  // S-02 공고 찾기 정상 + 준비 중(503) + 출처 제한(403)
  const okLookup = await handler(req('/api/v1/notices/lookup?q=합성 센트럴 아이파크', {
    headers: { ...auth, Origin: 'https://frontend.invalid' },
  }));
  assert.equal(okLookup.status, 200);
  assert.equal(okLookup.headers.get('cache-control'), 'private, no-store');
  assert.equal((await okLookup.json()).counts.matched, 2);

  assert.equal((await handler(req('/api/v1/notices/lookup?q=abc&mode=number', { headers: auth }))).status, 400);

  indexBehavior = 'missing';
  const missingLookup = await handler(req('/api/v1/notices/lookup?q=합성', { headers: auth }));
  assert.equal(missingLookup.status, 503);
  assert.equal((await missingLookup.json()).error, 'search_index_not_ready');

  indexBehavior = 'restricted';
  const restrictedLookup = await handler(req('/api/v1/notices/lookup?q=합성', { headers: auth }));
  assert.equal(restrictedLookup.status, 403);
  assert.equal((await restrictedLookup.json()).error, 'search_source_restricted');

  // 채팅 생성(201 + Location), 이름 변경(200), 메시지 전송(색인 제한 시에도 메시지 저장 + lookupError 전달)
  const created = await handler(req('/api/v1/chats', {
    method: 'POST',
    headers: { ...jsonHeaders, Origin: 'https://frontend.invalid' },
    body: JSON.stringify({ requestId, title: '새 분석 채팅' }),
  }));
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('location'), `/api/v1/chats/${chatId}`);
  assert.equal(created.headers.get('access-control-expose-headers'), 'Location');

  const renamed = await handler(req(`/api/v1/chats/${chatId}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ title: '변경된 제목' }),
  }));
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).chat.title, '변경된 제목');

  const msgRestricted = await handler(req(`/api/v1/chats/${chatId}/messages`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ requestId, message: '합성 센트럴 아이파크' }),
  }));
  assert.equal(msgRestricted.status, 200);
  const msgBody = await msgRestricted.json();
  assert.equal(msgBody.lookup, null);
  assert.equal(msgBody.lookupError, 'search_source_restricted');

  // 정상 색인일 때 메시지 전송 시 lookup 결과를 함께 반환
  indexBehavior = 'ready';
  const msgOk = await handler(req(`/api/v1/chats/${chatId}/messages`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ requestId, message: '합성 센트럴 아이파크' }),
  }));
  assert.equal(msgOk.status, 200);
  assert.equal((await msgOk.json()).lookup.counts.matched, 2);

  // 채팅에 분석 연결(202 + Location)
  const started = await handler(req(`/api/v1/chats/${chatId}/analyses`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      requestId,
      input: {
        kind: 'notice',
        noticeSource: 'applyhome_remainder',
        houseManageNo: '9900000040',
        noticeNo: '9900000040',
        edition: '2026-10-23',
        modelNo: '01',
      },
    }),
  }));
  assert.equal(started.status, 202);
  assert.equal(started.headers.get('location'), `/api/v1/analyses/${analysisId}/runs/${runId}`);

  // 잘못된 입력(400), 잘못된 Content-Type(415), 본문 초과(413)
  assert.equal((await handler(req('/api/v1/chats/not-a-uuid', { headers: auth }))).status, 400);
  assert.equal((await handler(req('/api/v1/chats', { method: 'POST', headers: auth, body: '{}' }))).status, 415);
  assert.equal((await handler(req('/api/v1/chats', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ requestId, title: '가'.repeat(5000) }),
  }))).status, 413);
  assert.ok(calls.length >= 4);
});

test('createBackend maps PostgREST chat RPC errors to public HTTP codes including 404, 409, and 429', async (t) => {
  let rpcResponse: () => Response = () => Response.json({ contractVersion: 'chat-home/v1', chats: [], nextCursor: null });
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, env.SUPABASE_URL);
    assert.equal(request.headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY);
    if (url.pathname === '/auth/v1/user') {
      return Response.json({ id: 'u1000000-0000-4000-8000-000000000001', is_anonymous: false });
    }
    return rpcResponse();
  });

  const handler = createHandler({ env, createBackend });

  // 타인 채팅 조회 PT404 -> HTTP 404 chat_not_found
  rpcResponse = () => Response.json({ code: 'PT404', message: 'chat_not_found' }, { status: 404 });
  const foreign = await handler(req(`/api/v1/chats/${chatId}`, { headers: auth }));
  assert.equal(foreign.status, 404);
  assert.equal((await foreign.json()).error, 'chat_not_found');

  // 멱등 키 충돌 PT409 -> HTTP 409 chat_conflict
  rpcResponse = () => Response.json({ code: 'PT409', message: 'chat_request_conflict' }, { status: 409 });
  const dupConflict = await handler(req('/api/v1/chats', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ requestId, title: '충돌 제목' }),
  }));
  assert.equal(dupConflict.status, 409);
  assert.equal((await dupConflict.json()).error, 'chat_conflict');

  // 실행 속도 제한 PT429 -> HTTP 429 + Retry-After: 60
  rpcResponse = () => Response.json({ code: 'PT429', message: 'analysis_run_rate_limited' }, { status: 429 });
  const limited = await handler(req(`/api/v1/chats/${chatId}/analyses`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      requestId,
      input: {
        kind: 'notice',
        noticeSource: 'applyhome_apt',
        houseManageNo: '9900000101',
        noticeNo: '9900000102',
        edition: '2026-11-10',
        modelNo: '01',
      },
    }),
  }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await limited.json()).error, 'run_rate_limited');
});
