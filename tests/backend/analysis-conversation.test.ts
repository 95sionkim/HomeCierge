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
  const sampleProposal = conversationExample('2026-10-12부터 2026-10-25까지로 바꿔줘', snapshot.result).proposal;
  assert.equal(sampleProposal && 'end' in sampleProposal ? sampleProposal.end : null, '2026-10-25');
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

// 교체 후보 목록은 합성 예시에 적격·부적격 후보를 더한 합성 자료다.
const pooled = structuredClone(snapshot);
(pooled.result as Record<string, unknown>).candidatePool = [
  { complexId: 'comparison-a', name: '합성 비교 A', localityCode: '9999900100', localityName: '가람동', eligible: true,
    selected: true, supplyAreaM2: '112.50', areaDifferenceM2: '0.10', tradeKinds: ['sale'], reasonCode: null },
  { complexId: 'comparison-c', name: '합성 비교 C', localityCode: '9999900100', localityName: '가람동', eligible: true,
    selected: false, supplyAreaM2: '113.00', areaDifferenceM2: '0.60', tradeKinds: ['sale'], reasonCode: null },
  { complexId: 'comparison-d', name: '합성 비교 D', localityCode: '9999900200', localityName: '별빛동', eligible: false,
    selected: false, supplyAreaM2: null, areaDifferenceM2: null, tradeKinds: [], reasonCode: 'outside_applied_region' },
];
const conditionTurn = (proposal: unknown, message = '공급면적 범위를 ±7%로 넓혀줘') =>
  ({ id, runId: rid, message, intent: 'change_conditions', createdAt: at, proposal });

test('규칙 기반 해석은 공급면적·거래 종류·단지 교체 요청을 같은 조건 변경 제안으로 만든다', () => {
  const r = pooled.result;
  assert.deepEqual(interpretChat('공급면적 범위를 ±7%로 넓혀줘', r),
    { intent: 'change_conditions', period: null, conditions: { areaTolerancePercent: '7' } });
  assert.deepEqual(interpretChat('허용 범위를 ±4.5%로 좁혀줘', r).intent, 'change_conditions');
  assert.deepEqual(interpretChat('매매만 비교해줘', r),
    { intent: 'change_conditions', period: null, conditions: { tradeKinds: ['sale'] } });
  assert.deepEqual(interpretChat('분양권 빼고 비교해줘', r),
    { intent: 'change_conditions', period: null, conditions: { tradeKinds: ['sale', 'occupancy_right'] } });
  const saleOnlyResult = { ...r, conditions: { ...r.conditions, tradeKinds: ['sale'] } };
  assert.deepEqual(interpretChat('분양권도 포함해서 비교해줘', saleOnlyResult),
    { intent: 'change_conditions', period: null, conditions: { tradeKinds: ['sale', 'presale_right'] } });
  assert.equal(interpretChat('분양권도 포함해서 비교해줘', r).intent, 'inclusion');
  assert.deepEqual(interpretChat('합성 비교 A를 합성 비교 C로 바꿔줘', r), {
    intent: 'change_conditions', period: null,
    conditions: { replacements: [{ complexId: 'comparison-c', replaceComplexId: 'comparison-a' }] },
  });
  // 이미 직접 교체가 적용된 결과에서는 원래 자동 선정 단지로 복원할 수 있고, 다른 자리에 자동 선정 단지를 넣는 요청은 안내한다.
  const replacedResult = structuredClone(r);
  replacedResult.comparables[0] = {
    ...(replacedResult.comparables[0] as Record<string, unknown>),
    complexId: 'comparison-c',
    name: '합성 비교 C',
    selectionReason: 'manual_replacement',
    replacesComplexId: 'comparison-a',
  };
  assert.deepEqual(interpretChat('합성 비교 C를 합성 비교 A로 바꿔줘', replacedResult), {
    intent: 'change_conditions', period: null, conditions: { replacements: [] },
  });
  assert.match(conversationExample('합성 비교 B를 합성 비교 A로 바꿔줘', replacedResult).answer, /자동 선정 단지입니다/);
  const combined = interpretChat('2026-10-15부터 2026-10-31까지로 바꾸고 매매만 비교해줘', r);
  assert.deepEqual(combined, { intent: 'change_conditions', period: null,
    conditions: { tradeKinds: ['sale'], period: { start: '2026-10-15', end: '2026-10-31' } } });
  // 현재와 같은 값·부정·모호한 선택·전용면적·범위 밖 값은 제안을 만들지 않는다.
  for (const message of ['공급면적 ±5%로 바꿔줘', '매매만 비교하지 마', '면적 7% 또는 10%로 바꿔줘', '전용면적 ±7%로 바꿔줘',
    '공급면적 ±60%로 넓혀줘', '공급면적 ±0%로 바꿔줘', '공급면적 범위가 왜 5%야?', '모든 분석에서 매매만 비교해줘',
    '합성 비교 A를 합성 비교 D로 바꿔줘', '합성 비교 C를 비교표에 추가해줘', '합성 비교 A를 합성 비교 B로 바꿔줘',
    '없는단지를 합성 비교 C로 바꿔줘']) {
    assert.notEqual(interpretChat(message, r).intent, 'change_conditions', message);
  }
  const noArea = structuredClone(r);
  (noArea.target as Record<string, Record<string, unknown>>).supplyArea.status = 'held';
  assert.throws(() => interpretChat('공급면적 범위를 ±7%로 넓혀줘', noArea), /conversation_condition_unavailable/);
});

test('교체 대상이 불명확하거나 후보가 기준을 통과하지 못하면 사유를 설명하고 임의로 빼지 않는다', () => {
  const r = pooled.result;
  assert.match(conversationExample('합성 비교 C를 비교표에 추가해줘', r).answer, /어느 기존 비교 단지를 교체할지 확인이 필요합니다.*임의로/);
  assert.match(conversationExample('합성 비교 A를 합성 비교 D로 바꿔줘', r).answer, /적용 지역 밖의 단지여서 비교표에 넣을 수 없습니다/);
  assert.match(conversationExample('합성 비교 A를 없는단지로 바꿔줘', r).answer, /확인된 후보가 아니므로/);
  assert.match(conversationExample('없는단지를 합성 비교 C로 바꿔줘', r).answer, /찾지 못했습니다/);
  assert.match(conversationExample('전용면적 ±7%로 바꿔줘', r).answer, /전용면적이 아니라 공급면적/);
  const preview = conversationExample('합성 비교 A를 합성 비교 C로 바꿔줘', r);
  assert.equal(preview.intent, 'change_conditions');
  assert.match(preview.answer, /비교 단지 교체 합성 비교 A → 합성 비교 C/);
});

test('구조화된 조건 제출은 정규화 후 DB로 전달하고 잘못된 값은 호출 없이 400으로 거부한다', async () => {
  const f = fixture([], { getComparison: async () => pooled });
  const body = { requestId: id, message: '비교 조건 변경', conditions: { areaTolerancePercent: '7.50', tradeKinds: ['presale_right', 'sale'] } };
  const response = await f.send(body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(f.calls[0], { action: 'submit_conditions', analysisId: aid, runId: rid, requestId: id, message: '비교 조건 변경',
    conditions: { areaTolerancePercent: '7.5', tradeKinds: ['sale', 'presale_right'] } });
  // 같은 요청 ID를 다시 보내도 같은 연산으로 전달하고 결과의 동일성은 DB가 보장한다.
  await f.send(body);
  assert.deepEqual(f.calls[1], f.calls[0]);
  // 대화 문장도 같은 조건 변경 연산으로 바뀐다.
  await f.send({ requestId: next, message: '매매만 비교해줘' });
  assert.deepEqual(f.calls[2], { action: 'submit_conditions', analysisId: aid, runId: rid, requestId: next, message: '매매만 비교해줘',
    conditions: { tradeKinds: ['sale'] } });
  const before = f.calls.length;
  for (const conditions of [{}, [], null, { other: '1' }, { areaTolerancePercent: '0' }, { areaTolerancePercent: 7 },
    { areaTolerancePercent: '50.0001' }, { areaTolerancePercent: '1.23456' }, { tradeKinds: [] }, { tradeKinds: ['sale', 'sale'] },
    { replacements: [{ complexId: 'a', replaceComplexId: 'a' }] }, { replacements: [{ complexId: 'a' }] },
    { period: { start: '2026-10-20', end: '2026-10-10' } }, { period: { start: '2026-10-10', end: '2026-10-20', extra: 1 } }]) {
    assert.equal((await f.send({ requestId: id, message: '조건 변경', conditions })).status, 400, JSON.stringify(conditions));
  }
  assert.equal((await f.send({ requestId: id, message: '조건 변경', conditions: { tradeKinds: ['sale'] }, intent: 'x' })).status, 400);
  // 후보 목록에서 적격이 아니거나 비교표에 없는 단지를 교체 대상으로 지정하면 409다.
  for (const replacements of [[{ complexId: 'comparison-d', replaceComplexId: 'comparison-a' }],
    [{ complexId: 'comparison-c', replaceComplexId: 'not-displayed' }], [{ complexId: 'comparison-b', replaceComplexId: 'comparison-a' }]]) {
    assert.equal((await f.send({ requestId: id, message: '단지 교체', conditions: { replacements } })).status, 409);
  }
  assert.equal(f.calls.length, before);
  // 이미 교체로 빠져 있는 원래 자동 선정 단지를 다른 자리에 넣는 구조화 요청도 409로 거부한다.
  const replacedPooled = structuredClone(pooled);
  replacedPooled.result.comparables[0] = {
    ...(replacedPooled.result.comparables[0] as Record<string, unknown>),
    complexId: 'comparison-c', name: '합성 비교 C', selectionReason: 'manual_replacement', replacesComplexId: 'comparison-a',
  };
  const fReplaced = fixture([], { getComparison: async () => replacedPooled });
  assert.equal((await fReplaced.send({
    requestId: id, message: '단지 교체',
    conditions: { replacements: [{ complexId: 'comparison-a', replaceComplexId: 'comparison-b' }] },
  })).status, 409);
  assert.equal(fReplaced.calls.length, 0);
});

test('다른 계정·조건 불가·제안 응답 형식을 검사하고 저장된 조건 제안을 설명한다', async () => {
  const missing = fixture([], { getComparison: async () => { throw new ApiError('run_not_found'); } });
  assert.equal((await missing.send({ requestId: id, message: '매매만 비교해줘' })).status, 404);
  assert.equal(missing.calls.length, 0);
  const unavailable = fixture([], { getComparison: async () => pooled,
    analysisConversation: async () => { throw new ApiError('conversation_condition_unavailable'); } });
  const blocked = await unavailable.send({ requestId: id, message: '매매만 비교해줘' });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, 'conversation_condition_unavailable');

  const pending = { kind: 'conditions', previous: { areaTolerancePercent: '5' }, proposed: { areaTolerancePercent: '7' },
    effective: { areaTolerancePercent: '7' }, status: 'pending', resultRunId: null };
  const bounds = { editable: true, period: { start: '2026-10-10', end: '2026-10-31', asOf: '2026-11-10' },
    tradeKinds: ['sale', 'presale_right', 'occupancy_right'], areaToleranceMax: '50', areaEditable: true, replacementsEditable: true };
  const shown = fixture([], { getComparison: async () => pooled,
    analysisConversation: async () => ({ analysisId: aid, runId: rid, conditionBounds: bounds, hasEarlier: false, turns: [conditionTurn(pending)] }) });
  const data = await (await shown.send()).json();
  assert.deepEqual(data.conditionBounds, bounds);
  assert.match(data.turns[0].answer, /공급면적 허용 범위 ±5% → ±7%.*공유 프로필은 바뀌지 않습니다/);
  for (const [status, pattern] of [['approved', /새 비교를 요청했습니다/], ['rejected', /기존 조건을 유지합니다/], ['cancelled', /취소했습니다/]] as const) {
    const decided = fixture([], { getComparison: async () => pooled, analysisConversation: async () => ({ analysisId: aid, runId: rid,
      hasEarlier: false, turns: [conditionTurn({ ...pending, status, resultRunId: status === 'approved' ? next : null })] }) });
    assert.match((await (await decided.send()).json()).turns[0].answer, pattern);
  }
  for (const proposal of [null, { ...pending, kind: 'period' }, { ...pending, proposed: {} }, { ...pending, status: 'approved' },
    { ...pending, proposed: { areaTolerancePercent: '0' } }]) {
    const broken = fixture([], { getComparison: async () => pooled,
      analysisConversation: async () => ({ analysisId: aid, runId: rid, hasEarlier: false, turns: [conditionTurn(proposal)] }) });
    assert.equal((await broken.send()).status, 503, JSON.stringify(proposal));
  }
  const badBounds = fixture([], { getComparison: async () => pooled,
    analysisConversation: async () => ({ analysisId: aid, runId: rid, conditionBounds: { ...bounds, areaToleranceMax: '0' }, hasEarlier: false, turns: [] }) });
  assert.equal((await badBounds.send()).status, 503);
});
