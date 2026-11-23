import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createHandler } from '../../src/server/handler.js';
import type { Backend } from '../../src/server/handler.js';
import { interpretChat, conversationExample } from '../../src/server/analysis-conversation.js';
import type { ChatOperation } from '../../src/server/analysis-conversation.js';
import { parseComparisonSnapshot } from '../../src/server/analysis-runs.js';
import { ApiError } from '../../src/server/http-input.js';

const aid = '00000000-0000-4000-8000-000000000001';
const rid = '00000000-0000-4000-8000-000000000002';
const id = '00000000-0000-4000-8000-000000000003';
const next = '00000000-0000-4000-8000-000000000004';
const raw = JSON.parse(readFileSync(new URL('../../public/app/assets/comparison-example.json', import.meta.url), 'utf8'));
const snapshot = parseComparisonSnapshot({ analysisId: aid, runId: rid, snapshotId: id, rulesVersion: 'example', result: raw }, aid, rid)!;
const at = '2026-11-10T00:01:02+00:00';
const path = 'https://home.invalid/api/v1/analyses/' + aid + '/runs/' + rid + '/conversation';

function fixture(turns: unknown[] = [], overrides: Partial<Backend> = {}) {
  const calls: ChatOperation[] = [];
  const handler = createHandler({
    env: { APP_ENV: 'development', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC_TEST' },
    createBackend: () => ({
      getUser: async () => ({ id, isAnonymous: false }), getComparison: async () => snapshot,
      analysisConversation: async (op: ChatOperation) => {
        calls.push(op);
        return { analysisId: aid, runId: rid, hasEarlier: false, turns };
      }, ...overrides,
    } as Backend),
    log: () => {},
  });
  const send = (body?: unknown, suffix = '', method = body === undefined ? 'GET' : 'POST') => handler(new Request(path + suffix, {
    method, headers: { Authorization: 'Bearer synthetic', 'Content-Type': 'application/json', Origin: 'https://home.invalid' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  }));
  return { send, calls };
}

test('저장된 기준일과 실제 달력으로 기간을 제안한다', () => {
  assert.deepEqual(interpretChat('최근 6개월로 다시 비교해줘', snapshot.result),
    { intent: 'change_period', period: { start: '2026-05-11', end: '2026-11-10' } });
  for (const question of ['2026-10-24부터 2026-10-26까지로 바꿔줘', '2026년 10월 24일부터 2026년 10월 26일까지 다시 비교해줘']) {
    assert.deepEqual(interpretChat(question, snapshot.result).period, { start: '2026-10-24', end: '2026-10-26' });
  }
  const leap = { ...snapshot.result, conditions: { ...snapshot.result.conditions, asOf: '2024-08-31' } };
  assert.deepEqual(interpretChat('최근 6개월로 바꿔줘', leap).period, { start: '2024-03-01', end: '2024-08-31' });
  for (const message of ['3~6개월로 바꿔줘', '최근 3개월 또는 6개월로 바꿔줘', '최근 6개월로 변경하지 마',
    '2026-02-30부터 2026-03-10까지로 바꿔줘', '승인', '잔액은 3000만원이야']) {
    assert.equal(interpretChat(message, snapshot.result).period, null);
  }
  assert.throws(() => interpretChat('2026-11-01부터 2026-12-10까지 바꿔줘', snapshot.result), /conversation_period_unavailable/);
});

test('질문의 가정과 다른 실제 건수로 답하고 같은 실행에 대한 후속 질문을 복원한다', async () => {
  const f = fixture([
    { id, runId: rid, message: '25건 중 왜 1건만 썼어?', intent: 'inclusion', createdAt: at, proposal: null },
    { id: next, runId: rid, message: '더 알려줘', intent: 'help', createdAt: at, proposal: null },
  ]);
  const response = await f.send();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const data = await response.json();
  assert.equal(data.contractVersion, 'analysis-conversation/v1');
  assert.match(data.turns[0].answer, /매매 1건, 분양권 1건, 입주권 1건/);
  assert.match(data.turns[0].answer, /2곳/);
  assert.doesNotMatch(data.turns[0].answer, /25건/);
  assert.match(data.turns[1].answer, /합성 비교 A의 2026-10-20 매매 신고금액은 515,000,000원/);
  assert.equal(f.calls[0].action, 'read');
});

test('표에 표시할 거래가 없고 범위가 미확인이면 정상 0건으로 답하지 않는다', async () => {
  const f = fixture([{ id, runId: rid, message: '어떤 거래를 포함했어?', intent: 'inclusion', createdAt: at, proposal: null }], {
    getComparison: async () => ({ ...snapshot, result: { ...snapshot.result, completeness: 'unavailable', appliedScope: null, comparables: [], holds: [{reasonCode: 'target_supply_area_unverified'}], exclusions: [] } }),
  });
  const data = await (await f.send()).json();
  assert.match(data.turns[0].answer, /0건이라고 확정할 수는 없습니다/);
  assert.match(data.turns[0].answer, /공급면적/);
});

test('게스트 예시는 같은 저장값으로 답하고 실제 예시 수집 범위 안에서만 카드를 미리 보여준다', () => {
  assert.match(conversationExample('어떤 거래가 포함됐어?', snapshot.result).answer, /2026-10-20 매매 신고금액/);
  const first = conversationExample('왜 이 거래만 포함됐어?', snapshot.result);
  const followUp = conversationExample('더 알려줘', snapshot.result, first.intent);
  assert.match(conversationExample('왜요?', snapshot.result, followUp.intent).answer, /2026-10-20 매매 신고금액/);
  const provisional = structuredClone(raw);
  provisional.comparables[0].tradeStats.sale.status = 'provisional';
  assert.match(conversationExample('몇 건이야?', provisional).answer, /잠정값/);
  assert.equal(conversationExample('최근 6개월로 다시 비교해줘', snapshot.result).proposal, null);
  assert.equal(conversationExample('2026-10-12부터 2026-10-25까지로 바꿔줘', snapshot.result).proposal?.end, '2026-10-25');
  assert.equal(interpretChat('2026-10-10부터 2026-10-31까지 다시 비교해줘', snapshot.result).intent, 'period');
});

test('본문 질문과 실제 승인 동작은 다른 요청이며 입력 변경은 DB에서만 결정한다', async () => {
  const f = fixture();
  assert.equal((await f.send({ requestId: id, message: '최근 6개월로 다시 비교해줘' })).status, 200);
  assert.deepEqual(f.calls[0], { action: 'submit', analysisId: aid, runId: rid, requestId: id, message: '최근 6개월로 다시 비교해줘', intent: 'change_period',
    period: { start: '2026-05-11', end: '2026-11-10' } });
  await f.send({ requestId: next, message: '좋아 승인해' });
  assert.equal(f.calls[1].action, 'submit');
  for (const decision of ['approve', 'reject', 'cancel']) {
    assert.equal((await f.send({ decision }, '/' + id + '/decision')).status, 200);
    assert.deepEqual(f.calls.at(-1), { action: 'decide', analysisId: aid, runId: rid, turnId: id, decision });
  }
});

test('소유권·출처 제한 및 잘못된 응답은 대화의 내용과 관계없이 검사한다', async () => {
  const forbidden = fixture([], { getComparison: async () => { throw new ApiError('comparison_source_restricted'); } });
  assert.equal((await forbidden.send()).status, 403);
  assert.equal(forbidden.calls.length, 0);
  const anonymous = fixture([], { getUser: async () => ({ id, isAnonymous: true }) });
  assert.equal((await anonymous.send({ decision: 'approve' }, '/' + id + '/decision')).status, 401);
  const invalid = fixture([{ id, runId: next, message: '다른 실행', intent: 'scope', createdAt: at, proposal: null }]);
  assert.equal((await invalid.send()).status, 503);
});

test('허용된 메서드, 쿼리, 텍스트 및 결정 본문의 경계를 검사한다', async () => {
  const f = fixture();
  assert.equal((await f.send(undefined, '', 'OPTIONS')).headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
  assert.equal((await f.send(undefined, '/' + id + '/decision')).status, 405);
  for (const body of [{ requestId: 'bad', message: '질문' }, { requestId: id, message: '안'.repeat(801) },
    { requestId: id, message: 'a\u0000b' }, { requestId: id, message: '왜?', p_intent: 'change_period' }]) {
    assert.equal((await f.send(body)).status, 400);
  }
  assert.equal((await f.send({ decision: 'approve', start: '2026-10-01' }, '/' + id + '/decision')).status, 400);
  assert.equal((await f.send(undefined, '?user=other')).status, 400);
  assert.equal(f.calls.length, 0);
});
