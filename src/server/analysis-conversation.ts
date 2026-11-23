import type { ComparisonSnapshot } from './analysis-runs.js';
import { ApiError, isUuid, readJsonRequest } from './http-input.js';
import { isDate, isPublicLabel, isTimestamp } from './public-fields.js';

const intents = ['inclusion', 'holds', 'scope', 'price', 'period', 'change_period', 'help'] as const;
type Intent = typeof intents[number];
type Decision = 'approve' | 'reject' | 'cancel';
type Period = { start: string; end: string };
type Proposal = Period & {
  previousStart: string;
  previousEnd: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  resultRunId: string | null;
};
type Result = ComparisonSnapshot['result'];
type Address = { analysisId: string; runId: string };
export type ChatOperation = Address & (
  | { action: 'read' }
  | { action: 'submit'; requestId: string; message: string; intent: Intent; period: Period | null }
  | { action: 'decide'; turnId: string; decision: Decision }
);
type ChatBackend = {
  getComparison(analysisId: string, runId: string, signal: AbortSignal): Promise<ComparisonSnapshot>;
  analysisConversation(operation: ChatOperation, signal: AbortSignal): Promise<unknown>;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function messageValid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && [...value].length <= 800 && !/[\u0000-\u0009\u000b-\u001f\u007f]|\p{Cs}/u.test(value);
}

function orderedPeriod(start: unknown, end: unknown): Period | null {
  return isDate(start) && isDate(end) && start <= end ? { start, end } : null;
}

function confirmedPeriod(result: Result) {
  const period = object(result.conditions.period);
  return period.status === 'confirmed' ? orderedPeriod(period.start, period.end) : null;
}

// 월 단위 계약 기간은 기준일에서 달력상 같은 날까지 거슬러 간 다음 날부터 양끝을 포함한다.
function recentPeriod(asOf: string, amount: number, unit: string): Period | null {
  if (!Number.isSafeInteger(amount) || amount < 1) return null;
  const date = new Date(asOf + 'T00:00:00Z');
  if (unit === '일') {
    date.setUTCDate(date.getUTCDate() - amount + 1);
  } else {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - amount * (unit === '년' ? 12 : 1));
    const last = new Date(date);
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    date.setUTCDate(Math.min(day, last.getUTCDate()) + 1);
  }
  return orderedPeriod(date.toISOString().slice(0, 10), asOf);
}

const explicitDate = /(?<!\d)(\d{4})(?:-(\d{1,2})-(\d{1,2})|\.(\d{1,2})\.(\d{1,2})\.?|년\s*(\d{1,2})월\s*(\d{1,2})일)(?!\d)/gu;
const relativeDate = /(?:최근|지난|직전)\s*(\d{1,3})\s*(개월|달|일|년)/gu;
const changeWords = /바꿔|바꾸|변경해|변경하|다시\s*(?:비교|계산|분석|집계)|재(?:계산|분석|비교)|비교해|비교하|줄여|늘려|좁혀|넓혀|조정해/u;

export function interpretChat(message: string, result: Result): { intent: Intent; period: Period | null } {
  const plain = message.normalize('NFC').replace(/\s+/gu, ' ');
  const explain = (intent: Intent) => ({ intent, period: null });
  if (/하지\s*(?:마|말)|바꾸지|변경하지|원래대로\s*(?:유지|둬)|승인하지|거절할|취소해/u.test(plain)) return explain('help');
  if (changeWords.test(plain) && /기간|계약일|최근|지난|직전|개월|\d{4}[-.년]/u.test(plain)) {
    const dates = Array.from(plain.matchAll(explicitDate), m => [m[1], m[2] ?? m[4] ?? m[6], m[3] ?? m[5] ?? m[7]]
      .map((n, i) => i ? n.padStart(2, '0') : n).join('-'));
    const offsets = Array.from(plain.matchAll(relativeDate));
    let period: Period | null = null;
    if (/또는|아니면|혹은|중에서|말고|프로필|모든 분석|다른 분석/u.test(plain)) return explain('help');
    if (dates.length === 2 && offsets.length === 0) period = orderedPeriod(dates[0], dates[1]);
    const asOf = result.conditions.asOf;
    if (!dates.length && offsets.length === 1 && isDate(asOf)
      && (plain.match(/\d+\s*(?:개월|달|일|년)/gu) ?? []).length === 1) {
      period = recentPeriod(asOf, Number(offsets[0][1]), offsets[0][2]);
    }
    if (!period) return explain('help');
    const previous = confirmedPeriod(result);
    if (!isDate(asOf) || period.end > asOf || !previous) throw new ApiError('conversation_period_unavailable');
    if (previous.start === period.start && previous.end === period.end) return explain('period');
    return { intent: 'change_period', period };
  }
  if (/보류|미확인|누락|미해결|불완전|빠졌|빠진|제외/u.test(plain)) return explain('holds');
  if (/분양가|필수\s*옵션|소계|공고\s*가격|호실\s*(?:가격|금액)|분양\s*가격/u.test(plain)) return explain('price');
  if (/언제부터|언제까지|기간|기준일|몇\s*개월|계약일/u.test(plain)) return explain('period');
  if (/범위|지역|법정동|같은 동|동네|확대|반경|거리순/u.test(plain) && !/면적/u.test(plain)) return explain('scope');
  if (/포함|선정|선택|비교\s*(?:근거|대상|기준)|거래|몇\s*건|몇\s*개|왜.*(?:건|개|썼|썼어|썼나|썼지|사용)|면적/u.test(plain)) return explain('inclusion');
  return explain('help');
}

const reasons: Record<string, string> = {
  target_supply_area_unverified: '선택한 주택형의 공급면적을 공고문에서 확인해야 합니다.',
  trade_supply_area_unverified: '거래 당시 주택형의 공급면적을 확인해야 합니다.',
  trade_link_unverified: '거래를 해당 단지·주택형에 연결할 근거가 부족합니다.',
  comparison_evidence_unverified: '주변 거래의 단지와 주택형을 연결할 근거가 부족합니다.',
  trade_region_membership_unverified: '거래가 속한 법정동·읍·면을 확인해야 합니다.',
  contract_period_unverified: '계약 기간이 확정되지 않았습니다.',
  no_confirmed_room_subtotal: '분양가와 필수 옵션을 함께 확인한 호실이 없습니다.',
  subtotal_documents_differ: '분양가와 필수 옵션의 문서 판본이 서로 다릅니다.',
  cancelled_trade: '해제된 거래를 제외했습니다.',
  outside_contract_period: '계약 기간 밖의 거래를 제외했습니다.',
  outside_supply_area: '허용 공급면적 범위 밖의 거래를 제외했습니다.',
  target_complex_trade: '대상 단지 자체 거래는 별도로 표시합니다.',
};

function explainReasons(entries: unknown[]): string {
  const lines = new Set<string>();
  for (const entry of entries) {
    const code = object(entry).reasonCode;
    if (typeof code === 'string' && Object.hasOwn(reasons, code)) lines.add(reasons[code]);
    if (lines.size === 3) break;
  }
  return [...lines].join(' ');
}

const tradeKinds = [['sale', '매매'], ['presale_right', '분양권'], ['occupancy_right', '입주권']] as const;
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const won = (n: unknown) => typeof n === 'string' && /^(?:0|[1-9]\d{0,19})$/.test(n) ? BigInt(n).toLocaleString('ko-KR') + '원' : null;

function explainScope(result: Result) {
  const priority = object(result.regionDecision.priority);
  const expansion = object(result.regionDecision.expansion);
  const name = isPublicLabel(priority.name, 120) ? priority.name : '같은 법정동·읍·면';
  if (result.appliedScope === 'expansion' && priority.conclusion === 'normal_zero') {
    return name + '에서 조건에 맞는 주변 단지가 0개로 확인되어 '
      + (isPublicLabel(expansion.name, 120) ? expansion.name : '상위 지역') + '까지 비교했습니다.';
  }
  if (result.appliedScope !== 'priority') return '저장된 근거로는 비교 지역을 확정할 수 없습니다.';
  if (priority.conclusion === 'normal_zero') return name + '에서 후보가 0개로 확인됐고, 확대할 지역은 추가 확인이 필요합니다.';
  return '이번 비교 범위는 ' + name + '입니다. 우선 지역에서 후보가 0개로 확인될 때만 상위 지역을 조회합니다.';
}

function explainInclusion(result: Result) {
  const scope = object(result.appliedScope ? result.regionDecision[result.appliedScope] : null);
  const text: string[] = [];
  if (result.comparables.length) {
    let provisional = false;
    const totalsByKind = tradeKinds.flatMap(([kind, label]) => {
      const stats = result.comparables.map(c => object(object(object(c).tradeStats)[kind]));
      if (stats.some(stat => stat.status === 'provisional')) provisional = true;
      const counts = stats.map(stat => stat.count).filter(integer);
      return counts.length ? [label + ' ' + counts.reduce((total, count) => total + count, 0) + '건'] : [];
    });
    text.push('비교표에 포함된 주변 단지는 ' + result.comparables.length + '곳입니다.'
      + (totalsByKind.length ? ' 이 단지들의 가격 통계에 사용된 거래는 ' + totalsByKind.join(', ') + '입니다.' : ''));
    if (provisional) text.push('비교 범위나 거래에 확인할 항목이 남아 현재 가격 통계는 잠정값입니다.');
  } else {
    text.push(scope.conclusion === 'normal_zero' ? '적용 범위에서 조건을 충족한 주변 단지가 0개로 확인됐습니다.'
      : '현재 비교표에 표시할 주변 단지는 없습니다. 이 결과로 조건에 맞는 거래가 0건이라고 확정할 수는 없습니다.');
  }
  const area = object(result.conditions.area);
  if (area.basis === 'supply' && typeof area.tolerancePercent === 'string' && /^\d{1,3}(?:\.\d+)?$/.test(area.tolerancePercent))
    text.push('대상 주택형의 공급면적 ±' + area.tolerancePercent + '% 안에서 단지별로 가장 가까운 공급면적을 비교합니다.');
  if (integer(scope.unresolvedRows) && scope.unresolvedRows > 0)
    text.push('적용 지역에서 확인이 더 필요한 기록은 ' + scope.unresolvedRows + '건입니다.');
  text.push(explainReasons([...result.holds, ...result.exclusions]));
  return text.filter(Boolean).join(' ');
}

function tradeExamples(result: Result) {
  const examples: string[] = [];
  for (const candidate of result.comparables) {
    const { name, tradeStats } = object(candidate);
    if (!isPublicLabel(name, 200)) continue;
    for (const [kind, label] of tradeKinds) {
      const observations = object(object(tradeStats)[kind]).observations;
      if (!Array.isArray(observations)) continue;
      const row = observations.map(object).find(entry => isDate(entry.contractDate) && won(entry.won));
      if (!row) continue;
      examples.push(name + '의 ' + String(row.contractDate) + ' ' + label + ' 신고금액은 ' + won(row.won) + '입니다.');
      if (examples.length === 3) return examples.join(' ');
    }
  }
  return examples.join(' ');
}

function explainPrice(result: Result) {
  const price = object(result.noticePrice);
  const selected = won(price.won), low = won(price.minWon), high = won(price.maxWon);
  if (price.status === 'confirmed' && selected)
    return '선택한 호실의 분양가와 필수 옵션을 더한 금액은 ' + selected + '입니다.';
  if (price.status === 'confirmed' && price.scope === 'confirmed_rooms' && low && high && Array.isArray(price.confirmedRooms) && price.confirmedRooms.length) {
    const range = low === high ? low : low + '부터 ' + high + '까지';
    return '분양가와 필수 옵션을 함께 확인한 ' + price.confirmedRooms.length + '개 호실의 소계는 ' + range + '입니다.'
      + (Array.isArray(price.heldRooms) && price.heldRooms.length ? ' 다른 ' + price.heldRooms.length + '개 호실은 금액을 확인 중입니다.' : '');
  }
  return '이 결과에는 분양가와 필수 옵션을 함께 확인한 호실 소계가 없습니다.';
}

function answer(intent: Intent, result: Result, proposal: Proposal | null): string {
  switch (intent) {
    case 'inclusion': return explainInclusion(result);
    case 'holds': {
      const holds = explainReasons(result.holds), exclusions = explainReasons(result.exclusions);
      if (result.holds.length || result.exclusions.length)
        return [holds || (result.holds.length ? '확인이 필요한 항목은 비교표의 보류 사유에서 볼 수 있습니다.' : ''), exclusions]
          .filter(Boolean).join(' ') || '제외한 항목의 근거는 비교표에서 볼 수 있습니다.';
      return result.completeness === 'complete' ? '이 결과에 보류 또는 제외로 기록된 항목은 없습니다.' : '저장된 결과에서 보류와 제외의 세부 근거를 확인하기 어렵습니다.';
    }
    case 'scope': return explainScope(result);
    case 'price': return explainPrice(result);
    case 'period': {
      const p = confirmedPeriod(result);
      return p ? '이번 비교에는 ' + p.start + '부터 ' + p.end + '까지 양 끝 날짜의 계약을 포함합니다.' : '이 결과의 계약 기간은 확정되지 않았습니다.';
    }
    case 'change_period':
      if (!proposal) throw new Error('invalid_conversation_response');
      if (proposal.status === 'approved') return '승인한 계약 기간으로 새 비교를 요청했습니다. 기존 결과도 다시 열 수 있습니다.';
      if (proposal.status === 'rejected') return '기간 변경 제안을 거절했습니다.';
      if (proposal.status === 'cancelled') return '기간 변경 제안을 취소했습니다.';
      return '계약 기간을 ' + proposal.start + '부터 ' + proposal.end + '까지로 제안합니다. 승인하면 이 분석에 새 비교 결과가 생깁니다.';
    case 'help': return '이 비교에 포함된 거래, 보류 사유, 비교 지역, 호실 가격이나 계약 기간을 물어보세요. 기간을 바꾸려면 “최근 6개월로 다시 비교해줘”처럼 범위를 하나 알려주세요.';
  }
}

function explainTurn(message: string, intent: Intent, previous: Intent, result: Result, proposal: Proposal | null) {
  const followUp = intent === 'help' && /^(?:그럼\s*|그런데\s*)?(?:그건\s*)?(?:왜|왜요|왜죠|왜 그래|더 알려줘|자세히 알려줘)[?!. ]*$/u.test(message);
  const topic = followUp && previous !== 'change_period' ? previous : intent;
  const details = topic === 'inclusion' && (followUp || /어떤 거래|거래\s*내역|거래일|구체적/u.test(message))
    ? tradeExamples(result) : '';
  return { topic, answer: details || answer(topic, result, proposal) };
}

// 브라우저 예제도 같은 의도 해석과 저장값 설명을 사용하되 승인과 쓰기 권한은 갖지 않는다.
export function conversationExample(message: string, result: Result, previousIntent?: string) {
  if (result?.contractVersion !== 'comparison/v1' || result.dataOrigin !== 'synthetic' || !messageValid(message))
    throw new ApiError('invalid_conversation_input');
  const original = confirmedPeriod(result);
  const unavailable = () => ({ intent: 'period', proposal: null,
    answer: original ? '이 예시에서 수집한 계약 기간은 ' + original.start + '부터 ' + original.end + '까지입니다. 이 안의 날짜로 요청해 주세요.'
      : '이 예시에는 날짜를 바꿔 비교할 수 있는 확정 계약 기간이 없습니다.' });
  try {
    const { intent, period } = interpretChat(message, result);
    let proposal: Proposal | null = null;
    if (period) {
      if (!original || period.start < original.start || period.end > original.end) return unavailable();
      proposal = { ...period, previousStart: original.start, previousEnd: original.end, status: 'pending', resultRunId: null };
      return { intent, proposal, answer: '계약 기간을 ' + period.start + '부터 ' + period.end + '까지로 변경하는 예시입니다.' };
    }
    const previous = intents.find(i => i === previousIntent) ?? 'help';
    const explanation = explainTurn(message, intent, previous, result, proposal);
    return { intent: explanation.topic, proposal, answer: explanation.answer };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'conversation_period_unavailable') return unavailable();
    throw error;
  }
}

function readProposal(value: unknown): Proposal | null {
  if (value === null) return null;
  const { start, end, previousStart, previousEnd, status, resultRunId } = object(value);
  if (!isDate(start) || !isDate(end) || start > end || !isDate(previousStart) || !isDate(previousEnd) || previousStart > previousEnd
    || (status !== 'pending' && status !== 'approved' && status !== 'rejected' && status !== 'cancelled')
    || (resultRunId !== null && !isUuid(resultRunId)) || (status === 'approved') !== (resultRunId !== null))
    throw new Error('invalid_conversation_response');
  return { start, end, previousStart, previousEnd, status, resultRunId };
}

function history(raw: unknown, snapshot: ComparisonSnapshot) {
  const { analysisId, runId, previousRunId = null, turns, hasEarlier } = object(raw);
  if (analysisId !== snapshot.analysisId || runId !== snapshot.runId || !Array.isArray(turns) || turns.length > 30 || typeof hasEarlier !== 'boolean')
    throw new Error('invalid_conversation_response');
  if (previousRunId !== null && (!isUuid(previousRunId) || previousRunId === runId)) throw new Error('invalid_conversation_response');
  const ids = new Set<string>();
  let previousIntent: Intent = 'help';
  const rendered = turns.map(rawTurn => {
    const turn = object(rawTurn);
    const { id, message, createdAt } = turn;
    const intent = intents.find(i => i === turn.intent);
    if (!isUuid(id) || ids.has(id) || turn.runId !== runId || !messageValid(message) || !isTimestamp(createdAt) || !intent)
      throw new Error('invalid_conversation_response');
    ids.add(id);
    const proposal = readProposal(turn.proposal);
    if ((intent === 'change_period') !== (proposal !== null)) throw new Error('invalid_conversation_response');
    const explanation = explainTurn(message, intent, previousIntent, snapshot.result, proposal);
    previousIntent = explanation.topic;
    return { id, runId, message, intent, createdAt, proposal, answer: explanation.answer };
  });
  return { contractVersion: 'analysis-conversation/v1', analysisId, runId, previousRunId, hasEarlier, turns: rendered };
}

export async function readConversation(request: Request, backend: ChatBackend, analysis: string, run: string, turn?: string) {
  const invalid = () => new ApiError('invalid_conversation_input');
  if (!isUuid(analysis) || !isUuid(run) || (turn !== undefined && !isUuid(turn)) || new URL(request.url).search) throw invalid();
  const address = { analysisId: analysis.toLowerCase(), runId: run.toLowerCase() };
  let decision: Decision | undefined;
  let submission: { requestId: string; message: string } | undefined;
  if (request.method === 'POST') {
    const body = object(await readJsonRequest(request, 'invalid_conversation_input'));
    if (turn) {
      if (Object.keys(body).length !== 1 || (body.decision !== 'approve' && body.decision !== 'reject' && body.decision !== 'cancel')) throw invalid();
      decision = body.decision;
    } else {
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (Object.keys(body).length !== 2 || !isUuid(body.requestId) || !messageValid(message)) throw invalid();
      submission = { requestId: body.requestId.toLowerCase(), message };
    }
  }
  const { signal } = request;
  const snapshot = await backend.getComparison(address.analysisId, address.runId, signal);
  let op: ChatOperation = { ...address, action: 'read' };
  if (turn && decision) op = { ...address, action: 'decide', turnId: turn.toLowerCase(), decision };
  if (submission) op = { ...address, action: 'submit', ...submission, ...interpretChat(submission.message, snapshot.result) };
  return history(await backend.analysisConversation(op, signal), snapshot);
}
