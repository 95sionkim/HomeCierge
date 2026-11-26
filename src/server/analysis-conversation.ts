import type { ComparisonSnapshot } from './analysis-runs.js';
import { ApiError, isUuid, readJsonRequest } from './http-input.js';
import { isDate, isPublicLabel, isTimestamp } from './public-fields.js';

const intents = [
  'inclusion', 'holds', 'scope', 'price', 'period', 'change_period', 'change_conditions', 'help',
] as const;
type Intent = typeof intents[number];
type Decision = 'approve' | 'reject' | 'cancel';
type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
type Period = { start: string; end: string };
export type TradeKind = 'sale' | 'presale_right' | 'occupancy_right';
export type ReplacementPair = { complexId: string; replaceComplexId: string };
export type ConditionPatch = {
  period?: Period;
  areaTolerancePercent?: string;
  tradeKinds?: TradeKind[];
  replacements?: ReplacementPair[];
};
type PeriodProposal = Period & {
  previousStart: string;
  previousEnd: string;
  status: ProposalStatus;
  resultRunId: string | null;
};
type ConditionProposal = {
  kind: 'conditions';
  previous: ConditionPatch;
  proposed: ConditionPatch;
  effective: ConditionPatch;
  status: ProposalStatus;
  resultRunId: string | null;
};
type Proposal = PeriodProposal | ConditionProposal;
export type ConditionBounds = {
  editable: boolean;
  period: (Period & { asOf: string }) | null;
  tradeKinds: TradeKind[];
  areaToleranceMax: string;
  areaEditable: boolean;
  replacementsEditable: boolean;
};
type Result = ComparisonSnapshot['result'];
type Address = { analysisId: string; runId: string };
export type ChatOperation = Address & (
  | { action: 'read' }
  | { action: 'submit'; requestId: string; message: string; intent: Exclude<Intent, 'change_conditions'>; period: Period | null }
  | { action: 'submit_conditions'; requestId: string; message: string; conditions: ConditionPatch }
  | { action: 'decide'; turnId: string; decision: Decision }
);
type ChatBackend = {
  getComparison(analysisId: string, runId: string, signal: AbortSignal): Promise<ComparisonSnapshot>;
  analysisConversation(operation: ChatOperation, signal: AbortSignal): Promise<unknown>;
};

const tradeKinds = [['sale', '매매'], ['presale_right', '분양권'], ['occupancy_right', '입주권']] as const;
const tradeKindOrder: readonly TradeKind[] = ['sale', 'presale_right', 'occupancy_right'];
const tradeKindLabels: Record<TradeKind, string> = {
  sale: '아파트 매매',
  presale_right: '분양권',
  occupancy_right: '입주권',
};
const MAX_AREA_TOLERANCE_SCALED = 50000n; // 5.0000% (10^-4 단위, Q-41)
const ALLOWED_CONDITION_KEYS = new Set(['period', 'areaTolerancePercent', 'tradeKinds', 'replacements']);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function messageValid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && [...value].length <= 800 && !/[\u0000-\u0009\u000b-\u001f\u007f]|\p{Cs}/u.test(value);
}

function complexIdValid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && [...value].length <= 120 && !/[\u0000-\u001f\u007f]|\p{Cs}/u.test(value);
}

function orderedPeriod(start: unknown, end: unknown): Period | null {
  return isDate(start) && isDate(end) && start <= end ? { start, end } : null;
}

export function normalizeAreaTolerance(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,4})?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  const scaled = BigInt(whole) * 10000n + BigInt(frac.padEnd(4, '0'));
  if (scaled <= 0n || scaled > MAX_AREA_TOLERANCE_SCALED) return null;
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

export function normalizeTradeKinds(value: unknown): TradeKind[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return null;
  const seen = new Set<TradeKind>();
  for (const item of value) {
    if (typeof item !== 'string' || !tradeKindOrder.includes(item as TradeKind)) return null;
    if (seen.has(item as TradeKind)) return null;
    seen.add(item as TradeKind);
  }
  return tradeKindOrder.filter(kind => seen.has(kind));
}

export function normalizeReplacements(value: unknown): ReplacementPair[] | null {
  if (!Array.isArray(value) || value.length > 5) return null;
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  const pairs: ReplacementPair[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const keys = Object.keys(raw);
    if (keys.length !== 2) return null;
    const entry = raw as Record<string, unknown>;
    if (!complexIdValid(entry.complexId) || !complexIdValid(entry.replaceComplexId)) return null;
    if (entry.complexId === entry.replaceComplexId) return null;
    if (incoming.has(entry.complexId) || outgoing.has(entry.replaceComplexId)) return null;
    incoming.add(entry.complexId);
    outgoing.add(entry.replaceComplexId);
    pairs.push({ complexId: entry.complexId, replaceComplexId: entry.replaceComplexId });
  }
  for (const id of incoming) {
    if (outgoing.has(id)) return null;
  }
  pairs.sort((a, b) => (a.replaceComplexId < b.replaceComplexId ? -1
    : a.replaceComplexId > b.replaceComplexId ? 1
    : a.complexId < b.complexId ? -1 : a.complexId > b.complexId ? 1 : 0));
  return pairs;
}

export function normalizeConditionPatch(value: unknown): ConditionPatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (!keys.length || keys.some(key => !ALLOWED_CONDITION_KEYS.has(key))) return null;
  const out: ConditionPatch = {};
  if (Object.hasOwn(raw, 'period')) {
    const p = object(raw.period);
    if (Object.keys(p).length !== 2) return null;
    const ordered = orderedPeriod(p.start, p.end);
    if (!ordered) return null;
    out.period = ordered;
  }
  if (Object.hasOwn(raw, 'areaTolerancePercent')) {
    const tol = normalizeAreaTolerance(raw.areaTolerancePercent);
    if (!tol) return null;
    out.areaTolerancePercent = tol;
  }
  if (Object.hasOwn(raw, 'tradeKinds')) {
    const kinds = normalizeTradeKinds(raw.tradeKinds);
    if (!kinds) return null;
    out.tradeKinds = kinds;
  }
  if (Object.hasOwn(raw, 'replacements')) {
    const reps = normalizeReplacements(raw.replacements);
    if (!reps) return null;
    out.replacements = reps;
  }
  return out;
}

function confirmedPeriod(result: Result) {
  const period = object(result.conditions.period);
  return period.status === 'confirmed' ? orderedPeriod(period.start, period.end) : null;
}

function currentAreaTolerance(result: Result): string | null {
  const target = object(result.target);
  const supply = object(target.supplyArea);
  const area = object(result.conditions.area);
  if (supply.status !== 'confirmed' || area.basis !== 'supply') return null;
  return normalizeAreaTolerance(area.tolerancePercent);
}

function currentTradeKinds(result: Result): TradeKind[] | null {
  return normalizeTradeKinds(result.conditions.tradeKinds);
}

function currentReplacements(result: Result): ReplacementPair[] {
  const pairs: ReplacementPair[] = [];
  for (const item of result.comparables) {
    const c = object(item);
    if (c.selectionReason === 'manual_replacement' && complexIdValid(c.complexId) && complexIdValid(c.replacesComplexId)) {
      pairs.push({ complexId: c.complexId, replaceComplexId: c.replacesComplexId });
    }
  }
  return normalizeReplacements(pairs) ?? [];
}

type PoolEntry = {
  complexId: string;
  name: string;
  localityCode: string;
  localityName: string;
  eligible: boolean;
  selected: boolean;
  supplyAreaM2: string | null;
  areaDifferenceM2: string | null;
  tradeKinds: string[];
  reasonCode: string | null;
};

function candidatePoolEntries(result: Result): PoolEntry[] {
  const raw = (result as Record<string, unknown>).candidatePool;
  if (!Array.isArray(raw)) return [];
  const entries: PoolEntry[] = [];
  for (const item of raw) {
    const e = object(item);
    if (!complexIdValid(e.complexId) || typeof e.name !== 'string' || typeof e.eligible !== 'boolean') continue;
    entries.push({
      complexId: e.complexId,
      name: e.name,
      localityCode: typeof e.localityCode === 'string' ? e.localityCode : '',
      localityName: typeof e.localityName === 'string' ? e.localityName : '',
      eligible: e.eligible,
      selected: e.selected === true,
      supplyAreaM2: typeof e.supplyAreaM2 === 'string' ? e.supplyAreaM2 : null,
      areaDifferenceM2: typeof e.areaDifferenceM2 === 'string' ? e.areaDifferenceM2 : null,
      tradeKinds: Array.isArray(e.tradeKinds) ? e.tradeKinds.filter((k): k is string => typeof k === 'string') : [],
      reasonCode: typeof e.reasonCode === 'string' ? e.reasonCode : null,
    });
  }
  return entries;
}

function sameTradeKinds(a: readonly TradeKind[], b: readonly TradeKind[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameReplacements(a: readonly ReplacementPair[], b: readonly ReplacementPair[]): boolean {
  return a.length === b.length && a.every((v, i) =>
    v.complexId === b[i].complexId && v.replaceComplexId === b[i].replaceComplexId);
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
const changeWords = /바꿔|바꾸|변경해|변경하|다시\s*(?:비교|계산|분석|집계)|재(?:계산|분석|비교)|비교해|비교하|줄여|늘려|좁혀|넓혀|조정해|교체해|교체하|대체해/u;
const areaChangeAction = /바꿔|바꾸|변경해|변경하|다시\s*(?:비교|계산|분석|집계)|재(?:계산|분석|비교)|비교해|비교하|줄여|늘려|좁혀|넓혀|조정해|설정해|적용해|맞춰|해\s*줘|해주세요/u;
const negationWords = /하지\s*(?:마|말)|바꾸지|변경하지|원래대로\s*(?:유지|둬)|승인하지|거절할|취소해/u;
const profileScopeWords = /프로필|모든 분석|다른 분석/u;
const ambiguousChoiceWords = /또는|아니면|혹은|중에서/u;

function cleanComplexPhrase(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/^[\s"'‘’“”]+|[\s"'‘’“”.,!?]+$/gu, '')
    .replace(/^(?:현재\s*)?(?:비교표에서|비교표의|비교\s*단지|주변\s*단지|기존\s*단지|기존|주변)\s+/u, '')
    .replace(/\s+(?:으로|로|을|를|은|는|이|가)$/u, '')
    .trim();
}

function normalizeMatchKey(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function stripComplexSuffix(value: string): string {
  return value.replace(/\s*단지$/u, '').trim();
}

function matchComplex<T extends { complexId: string; name?: unknown }>(phrase: string, items: readonly T[]): T | null {
  const cleaned = cleanComplexPhrase(phrase);
  if (!cleaned) return null;
  const key = normalizeMatchKey(cleaned);
  const exact = items.filter(item =>
    normalizeMatchKey(item.complexId) === key
    || (typeof item.name === 'string' && normalizeMatchKey(item.name) === key));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const strippedKey = stripComplexSuffix(key);
  if (!strippedKey) return null;
  const relaxed = items.filter(item =>
    stripComplexSuffix(normalizeMatchKey(item.complexId)) === strippedKey
    || (typeof item.name === 'string' && stripComplexSuffix(normalizeMatchKey(item.name)) === strippedKey));
  return relaxed.length === 1 ? relaxed[0] : null;
}

function parseReplacementPair(plain: string): { outgoing: string; incoming: string } | null {
  const patterns = [
    /^(.+?)\s*(?:을|를)\s+(.+?)\s*(?:으?로)\s*(?:바꿔|바꾸|교체|변경|대체)/u,
    /^(.+?)\s+대신\s+(.+?)\s*(?:으?로|을|를)?\s*(?:바꿔|바꾸|교체|비교|넣어|지정|선택|써|해)/u,
    /^(.+?)\s*(?:빼고|제외하고)\s+(.+?)\s*(?:을|를|으?로)?\s*(?:넣어|추가|교체|비교|지정)/u,
  ];
  for (const pattern of patterns) {
    const m = plain.match(pattern);
    if (m) {
      const outgoing = cleanComplexPhrase(m[1]);
      const incoming = cleanComplexPhrase(m[2]);
      if (outgoing && incoming && outgoing !== incoming) return { outgoing, incoming };
    }
  }
  return null;
}

type ReplacementResolution =
  | { status: 'none' }
  | { status: 'unchanged' }
  | { status: 'reset' }
  | { status: 'replace'; replacements: ReplacementPair[] }
  | { status: 'ambiguous_target' }
  | { status: 'outgoing_not_found'; outgoing: string }
  | { status: 'already_selected'; name: string }
  | { status: 'base_slot_elsewhere'; name: string }
  | { status: 'ineligible'; name: string; reasonCode: string | null }
  | { status: 'incoming_unverified'; incoming: string };

function resolveReplacementIntent(plain: string, result: Result): ReplacementResolution {
  if (negationWords.test(plain) || profileScopeWords.test(plain) || ambiguousChoiceWords.test(plain)) {
    return { status: 'none' };
  }
  if (/^(?:왜|어째서|무슨|어떤)/u.test(plain) || /\?$/u.test(plain)) {
    return { status: 'none' };
  }
  if (/(?:직접\s*(?:지정|교체|선택)|단지\s*(?:지정|교체)|수동\s*교체).*(?:해제|초기화|원래대로|자동|풀어|취소)|자동\s*(?:선정|비교)(?:으로|로)\s*(?:돌려|되돌려|바꿔|변경|복원)/u.test(plain)) {
    return currentReplacements(result).length ? { status: 'reset' } : { status: 'unchanged' };
  }
  if (/기간|계약일|공급\s*면적|전용\s*면적|허용\s*(?:범위|오차)|매매|분양권|입주권|거래\s*(?:종류|유형)/u.test(plain)) {
    return { status: 'none' };
  }
  const pair = parseReplacementPair(plain);
  const comparables = result.comparables.map(c => object(c)).filter(c => complexIdValid(c.complexId)) as Array<{
    complexId: string;
    name?: string;
    replacesComplexId?: string;
  }>;
  const pool = candidatePoolEntries(result);
  if (pair) {
    const out = matchComplex(pair.outgoing, comparables);
    if (!out) return { status: 'outgoing_not_found', outgoing: pair.outgoing };
    const alreadyDisplayed = matchComplex(pair.incoming, comparables);
    if (alreadyDisplayed) {
      return { status: 'already_selected', name: typeof alreadyDisplayed.name === 'string' ? alreadyDisplayed.name : alreadyDisplayed.complexId };
    }
    const candidate = matchComplex(pair.incoming, pool);
    if (!candidate) return { status: 'incoming_unverified', incoming: pair.incoming };
    if (!candidate.eligible) {
      return { status: 'ineligible', name: candidate.name || candidate.complexId, reasonCode: candidate.reasonCode };
    }
    const slotId = complexIdValid(out.replacesComplexId) ? out.replacesComplexId : out.complexId;
    const baseSlots = new Set(comparables.map(c => (complexIdValid(c.replacesComplexId) ? c.replacesComplexId : c.complexId)));
    const base = currentReplacements(result).filter(
      r => r.replaceComplexId !== slotId && r.complexId !== candidate.complexId,
    );
    if (candidate.complexId === slotId) {
      if (sameReplacements(base, currentReplacements(result))) return { status: 'unchanged' };
      return { status: 'replace', replacements: base };
    }
    if (baseSlots.has(candidate.complexId)) {
      return { status: 'base_slot_elsewhere', name: candidate.name || candidate.complexId };
    }
    const merged = normalizeReplacements([...base, { complexId: candidate.complexId, replaceComplexId: slotId }]);
    if (!merged) return { status: 'incoming_unverified', incoming: pair.incoming };
    if (sameReplacements(merged, currentReplacements(result))) return { status: 'unchanged' };
    return { status: 'replace', replacements: merged };
  }
  if (/(?:단지|비교\s*대상).*(?:추가|넣어|포함|직접\s*지정|지정해)|(?:을|를)\s*(?:비교표에\s*)?(?:추가해|넣어\s*줘|포함해\s*줘|직접\s*지정해)/u.test(plain)) {
    return { status: 'ambiguous_target' };
  }
  return { status: 'none' };
}

export type InterpretResult =
  | { intent: Exclude<Intent, 'change_conditions'>; period: Period | null }
  | { intent: 'change_conditions'; period: null; conditions: ConditionPatch };

export function interpretChat(message: string, result: Result): InterpretResult {
  const plain = message.normalize('NFC').replace(/\s+/gu, ' ');
  const explain = (intent: Exclude<Intent, 'change_conditions'>): InterpretResult => ({ intent, period: null });
  if (negationWords.test(plain)) return explain('help');

  const patch: ConditionPatch = {};
  let requestedPeriodSame = false;
  let requestedAreaSame = false;
  let requestedKindsSame = false;

  // 1) 공급면적 허용 범위 변경 (전용면적 요청은 거부하고 안내로 돌려보낸다)
  const mentionsAreaChange = areaChangeAction.test(plain)
    && /(?:공급\s*)?면적|허용\s*(?:범위|오차)|±|\+\/-/u.test(plain)
    && !/^(?:왜|어째서|무슨|어떤)/u.test(plain) && !/\?$/u.test(plain);
  if (mentionsAreaChange) {
    if (profileScopeWords.test(plain) || ambiguousChoiceWords.test(plain) || /말고|~|∼/u.test(plain)) {
      return explain('help');
    }
    if (/전용\s*면적/u.test(plain)) return explain('help');
    const pctMatches = Array.from(plain.matchAll(/(?:±|\+\/-|플마)?\s*(-?\d+(?:\.\d+)?)\s*%/gu));
    if (pctMatches.length === 1) {
      const tolerance = normalizeAreaTolerance(pctMatches[0][1]);
      if (!tolerance) return explain('help');
      const current = currentAreaTolerance(result);
      if (!current) throw new ApiError('conversation_condition_unavailable');
      if (tolerance === current) requestedAreaSame = true;
      else patch.areaTolerancePercent = tolerance;
    } else if (pctMatches.length > 1) {
      return explain('help');
    } else if (/넓혀|넓히|늘려|늘리|확대/u.test(plain) && !/좁혀|좁히|줄여|줄이/u.test(plain)) {
      return explain('help');
    }
  }

  // 2) 거래 종류 변경
  const mentionsTradeKindChange = (
    changeWords.test(plain) || /만\s*(?:비교|볼래|보여|보고|계산|분석|해\s*줘|해주세요)|빼고|제외하고|제외해|포함해서|포함해|추가해서|추가해|전체\s*거래/u.test(plain)
  ) && /(?:매매|분양권|입주권|분양\s*·?\s*입주권|거래\s*(?:종류|유형))/u.test(plain)
    && !/^(?:왜|어째서|무슨|어떤)/u.test(plain) && !/왜\s|몇\s*(?:건|개)|\?$/u.test(plain);
  if (mentionsTradeKindChange) {
    if (profileScopeWords.test(plain) || ambiguousChoiceWords.test(plain)) return explain('help');
    const current = currentTradeKinds(result);
    if (!current) throw new ApiError('conversation_condition_unavailable');
    let nextKinds: TradeKind[] | null = null;
    if (/(?:전체|모든|모두|다).*(?:거래|유형|종류)|거래\s*(?:종류|유형).*(?:전체|모두|다)/u.test(plain)) {
      nextKinds = ['sale', 'presale_right', 'occupancy_right'];
    } else {
      const mentioned: TradeKind[] = [];
      if (/매매/u.test(plain)) mentioned.push('sale');
      if (/분양권/u.test(plain)) mentioned.push('presale_right');
      if (/입주권/u.test(plain)) mentioned.push('occupancy_right');
      if (!mentioned.includes('presale_right') && !mentioned.includes('occupancy_right') && /분양\s*[·・,/]\s*입주권/u.test(plain)) {
        mentioned.push('presale_right', 'occupancy_right');
      }
      if (mentioned.length > 0) {
        if (/(?:빼고|제외하고|제외해|없이)/u.test(plain)) {
          nextKinds = current.filter(k => !mentioned.includes(k));
        } else if (
          !/(?:만\b|만\s)/u.test(plain)
          && /(?:도\s*(?:포함|비교|넣어|추가|같이|함께)|(?:함께|같이)\s*(?:포함|비교|넣어|추가)|(?:포함|추가)(?:해서|해|하고))/u.test(plain)
        ) {
          nextKinds = normalizeTradeKinds([...new Set([...current, ...mentioned])]);
        } else {
          nextKinds = normalizeTradeKinds(mentioned);
        }
      }
    }
    if (!nextKinds || !nextKinds.length) return explain('help');
    if (sameTradeKinds(nextKinds, current)) requestedKindsSame = true;
    else patch.tradeKinds = nextKinds;
  }

  // 3) 계약 기간 변경
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
    if (previous.start === period.start && previous.end === period.end) requestedPeriodSame = true;
    else patch.period = period;
  }

  // 4) 단지 직접 지정·교체 (다른 조건 변경이 없을 때)
  if (!Object.keys(patch).length && !requestedPeriodSame && !requestedAreaSame && !requestedKindsSame) {
    const rep = resolveReplacementIntent(plain, result);
    if (rep.status === 'reset') {
      if (result.appliedScope !== 'priority' && result.appliedScope !== 'expansion') {
        throw new ApiError('conversation_condition_unavailable');
      }
      return { intent: 'change_conditions', period: null, conditions: { replacements: [] } };
    }
    if (rep.status === 'replace') {
      if (result.appliedScope !== 'priority' && result.appliedScope !== 'expansion') {
        throw new ApiError('conversation_condition_unavailable');
      }
      return { intent: 'change_conditions', period: null, conditions: { replacements: rep.replacements } };
    }
    if (rep.status === 'unchanged') return explain('inclusion');
    if (rep.status !== 'none') return explain('help');
  }

  const patchKeys = Object.keys(patch);
  if (patchKeys.length === 1 && patch.period) {
    return { intent: 'change_period', period: patch.period };
  }
  if (patchKeys.length > 0) {
    return { intent: 'change_conditions', period: null, conditions: patch };
  }
  if (requestedPeriodSame) return explain('period');
  if (requestedAreaSame || requestedKindsSame) return explain('inclusion');

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
  outside_applied_region: '적용 지역 밖의 단지여서 비교표에 넣을 수 없습니다.',
  trade_kind_not_included: '선택한 거래 종류에 해당하는 거래가 없어 비교표에 넣을 수 없습니다.',
  comparison_conditions_unmet: '현재 비교 기준을 충족한 거래가 없어 비교표에 넣을 수 없습니다.',
  candidate_unverified: '근거가 확인되지 않아 비교표에 넣을 수 없습니다.',
  replacement_target_required: '교체할 기존 비교 단지를 지정해야 합니다.',
  replacement_candidate_ineligible: '요청한 단지가 현재 비교 기준을 통과하지 못해 교체하지 않았습니다.',
  replacement_request_conflict: '중복되거나 충돌하는 단지 교체 요청을 보류했습니다.',
  target_complex_trade: '대상 단지 자체 거래는 별도로 표시합니다.',
};

function candidateReasonSentence(code: string | null): string {
  if (!code) return '현재 비교 기준을 충족하지 못해';
  const map: Record<string, string> = {
    outside_applied_region: '현재 적용 지역 밖의 단지여서',
    outside_supply_area: '허용 공급면적 범위 밖의 단지여서',
    outside_contract_period: '현재 계약 기간 안의 거래가 없어',
    trade_kind_not_included: '선택한 거래 종류의 거래가 없어',
    cancelled_trade: '유효한 거래가 없어',
    comparison_conditions_unmet: '현재 비교 기준을 충족한 거래가 없어',
    candidate_unverified: '근거가 확인되지 않아',
    trade_supply_area_unverified: '공급면적 근거가 확인되지 않아',
    trade_link_unverified: '단지·주택형 연결 근거가 부족해',
    trade_region_membership_unverified: '법정동·읍·면 소속이 확인되지 않아',
    straight_line_distance_unverified: '좌표 근거가 확인되지 않아',
  };
  return map[code] ?? '현재 비교 기준을 충족하지 못해';
}

function explainReasons(entries: unknown[]): string {
  const lines = new Set<string>();
  for (const entry of entries) {
    const code = object(entry).reasonCode;
    if (typeof code === 'string' && Object.hasOwn(reasons, code)) lines.add(reasons[code]);
    if (lines.size === 3) break;
  }
  return [...lines].join(' ');
}

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
  const configuredKinds = currentTradeKinds(result);
  if (configuredKinds) {
    text.push('비교 거래 종류는 ' + configuredKinds.map(k => tradeKindLabels[k]).join(' · ') + '입니다.');
  }
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

function complexDisplayName(complexId: string, result: Result): string {
  for (const item of result.comparables) {
    const c = object(item);
    if (c.complexId === complexId && isPublicLabel(c.name, 200)) return c.name;
  }
  for (const entry of candidatePoolEntries(result)) {
    if (entry.complexId === complexId && isPublicLabel(entry.name, 200)) return entry.name;
  }
  return complexId;
}

function describeReplacements(pairs: readonly ReplacementPair[], result: Result): string {
  if (!pairs.length) return '자동 선정';
  return pairs
    .map(p => complexDisplayName(p.replaceComplexId, result) + ' → ' + complexDisplayName(p.complexId, result))
    .join(', ');
}

function describeConditionDiff(proposal: ConditionProposal, result: Result): string {
  const parts: string[] = [];
  if (proposal.proposed.period && proposal.previous.period) {
    parts.push(`계약 기간 ${proposal.previous.period.start}~${proposal.previous.period.end} → ${proposal.proposed.period.start}~${proposal.proposed.period.end}`);
  }
  if (proposal.proposed.areaTolerancePercent && proposal.previous.areaTolerancePercent) {
    parts.push(`공급면적 허용 범위 ±${proposal.previous.areaTolerancePercent}% → ±${proposal.proposed.areaTolerancePercent}%`);
  }
  if (proposal.proposed.tradeKinds && proposal.previous.tradeKinds) {
    const fromText = proposal.previous.tradeKinds.map(k => tradeKindLabels[k]).join('·');
    const toText = proposal.proposed.tradeKinds.map(k => tradeKindLabels[k]).join('·');
    parts.push(`거래 종류 ${fromText} → ${toText}`);
  }
  if (proposal.proposed.replacements && proposal.previous.replacements) {
    const next = proposal.proposed.replacements, before = proposal.previous.replacements;
    parts.push(next.length
      ? '비교 단지 교체 ' + describeReplacements(next, result) + (before.length ? '(기존 교체 ' + describeReplacements(before, result) + ')' : '')
      : '비교 단지 직접 교체 해제(' + describeReplacements(before, result) + ' → 자동 선정)');
  }
  return parts.join(', ');
}

function exceedsMaxAreaTolerance(raw: string): boolean {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)) return false;
  const [whole, frac = ''] = raw.split('.');
  const w = BigInt(whole);
  if (w > 5n) return true;
  return w === 5n && /[1-9]/.test(frac);
}

function explainConditionGuidance(message: string, result: Result): string | null {
  const plain = message.normalize('NFC').replace(/\s+/gu, ' ');
  if (negationWords.test(plain) || profileScopeWords.test(plain)) return null;
  if (/전용\s*면적/u.test(plain) && (areaChangeAction.test(plain) || /%/u.test(plain))) {
    return '비교 기준은 전용면적이 아니라 공급면적입니다. 공급면적 허용 범위를 ±3%처럼 0% 초과 5% 이하로 요청해 주세요.';
  }
  if (areaChangeAction.test(plain) && /(?:공급\s*)?면적|허용\s*(?:범위|오차)|±|\+\/-/u.test(plain)) {
    const pctMatches = Array.from(plain.matchAll(/(?:±|\+\/-|플마)?\s*(-?\d+(?:\.\d+)?)\s*%/gu));
    if (pctMatches.length === 1 && !normalizeAreaTolerance(pctMatches[0][1])) {
      if (exceedsMaxAreaTolerance(pctMatches[0][1])) {
        return '공급면적 허용 범위는 기본 ±5%가 상한입니다(Q-41). ±5%보다 넓히면 다른 규모의 주택형이 비교에 섞일 수 있어 확대할 수 없으며, 0% 초과 5% 이하(소수 4자리 이하)로 좁히는 변경만 요청할 수 있습니다.';
      }
      return '공급면적 허용 범위는 0% 초과 5% 이하의 양수(소수 4자리 이하)로 입력해 주세요. 기본 ±5%보다 좁히는 변경만 가능합니다.';
    }
    if (pctMatches.length === 0 && /넓혀|넓히|늘려|늘리|확대/u.test(plain) && !/좁혀|좁히|줄여|줄이/u.test(plain)) {
      return '공급면적 허용 범위는 기본 ±5%가 상한입니다(Q-41). ±5%보다 넓히면 다른 규모의 주택형이 비교에 섞일 수 있어 확대할 수 없으며, 0% 초과 5% 이하(소수 4자리 이하)로 좁히는 변경만 요청할 수 있습니다.';
    }
  }
  const rep = resolveReplacementIntent(plain, result);
  const currentNames = result.comparables
    .map(c => object(c))
    .map(c => (isPublicLabel(c.name, 200) ? c.name : typeof c.complexId === 'string' ? c.complexId : ''))
    .filter(Boolean);
  const nameList = currentNames.length ? currentNames.join(', ') : '없음';
  if (rep.status === 'ambiguous_target') {
    return `어느 기존 비교 단지를 교체할지 확인이 필요합니다. 임의로 기존 단지를 빼지 않습니다. 현재 비교 단지(${nameList}) 중 교체할 단지와 새 단지를 함께 알려주세요.`;
  }
  if (rep.status === 'outgoing_not_found') {
    return `현재 비교표에서 “${rep.outgoing}” 단지를 찾지 못했습니다. 현재 비교 단지(${nameList}) 중 교체할 단지를 지정해 주세요.`;
  }
  if (rep.status === 'already_selected') {
    return `${rep.name}은(는) 이미 현재 비교표에 포함되어 있습니다.`;
  }
  if (rep.status === 'base_slot_elsewhere') {
    return `${rep.name}은(는) 자동 선정 단지입니다. 원래 자리의 직접 교체를 해제해 복원해 주세요.`;
  }
  if (rep.status === 'ineligible') {
    return `${rep.name}은(는) ${candidateReasonSentence(rep.reasonCode)} 비교표에 넣을 수 없습니다. 현재 적용 지역과 비교 기준을 통과한 후보만 기존 단지와 교체할 수 있습니다.`;
  }
  if (rep.status === 'incoming_unverified') {
    return `“${rep.incoming}”은(는) 현재 비교 근거에서 확인된 후보가 아니므로 비교표에 넣을 수 없습니다.`;
  }
  return null;
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
      if (!proposal || 'kind' in proposal) throw new Error('invalid_conversation_response');
      if (proposal.status === 'approved') return '승인한 계약 기간으로 새 비교를 요청했습니다. 기존 결과도 다시 열 수 있습니다.';
      if (proposal.status === 'rejected') return '기간 변경 제안을 거절했습니다.';
      if (proposal.status === 'cancelled') return '기간 변경 제안을 취소했습니다.';
      return '계약 기간을 ' + proposal.start + '부터 ' + proposal.end + '까지로 제안합니다. 승인하면 이 분석에 새 비교 결과가 생깁니다.';
    case 'change_conditions': {
      if (!proposal || !('kind' in proposal) || proposal.kind !== 'conditions') throw new Error('invalid_conversation_response');
      if (proposal.status === 'approved') return '승인한 비교 조건으로 새 비교를 요청했습니다. 기존 결과도 다시 열 수 있습니다.';
      if (proposal.status === 'rejected') return '비교 조건 변경 제안을 거절했습니다. 기존 조건을 유지합니다.';
      if (proposal.status === 'cancelled') return '비교 조건 변경 제안을 취소했습니다. 기존 조건을 유지합니다.';
      const diff = describeConditionDiff(proposal, result);
      return diff + ' 변경을 제안합니다. 승인하면 같은 수집본으로 새 비교를 계산하며, 공유 프로필은 바뀌지 않습니다.';
    }
    case 'help':
      return '이 비교에 포함된 거래, 보류 사유, 비교 지역, 호실 가격이나 계약 기간을 물어보세요. 조건을 바꾸려면 “최근 6개월로 다시 비교해줘”, “공급면적 범위를 ±3%로 좁혀줘”, “매매만 비교해줘”처럼 요청하거나 조건 변경 패널을 여세요.';
  }
}

function explainTurn(message: string, intent: Intent, previous: Intent, result: Result, proposal: Proposal | null) {
  const followUp = intent === 'help' && /^(?:그럼\s*|그런데\s*)?(?:그건\s*)?(?:왜|왜요|왜죠|왜 그래|더 알려줘|자세히 알려줘)[?!. ]*$/u.test(message);
  const topic = followUp && previous !== 'change_period' && previous !== 'change_conditions' ? previous : intent;
  if (topic === 'help' && !followUp) {
    const guidance = explainConditionGuidance(message, result);
    if (guidance) return { topic, answer: guidance };
  }
  const details = topic === 'inclusion' && (followUp || /어떤 거래|거래\s*내역|거래일|구체적/u.test(message))
    ? tradeExamples(result) : '';
  return { topic, answer: details || answer(topic, result, proposal) };
}

function buildGuestConditionProposal(patch: ConditionPatch, result: Result): ConditionProposal | null {
  const previous: ConditionPatch = {};
  const proposed: ConditionPatch = {};
  const effective: ConditionPatch = {};
  const originalPeriod = confirmedPeriod(result);
  const originalArea = currentAreaTolerance(result);
  const originalKinds = currentTradeKinds(result);
  const originalReps = currentReplacements(result);

  if (patch.period) {
    if (!originalPeriod || patch.period.start < originalPeriod.start || patch.period.end > originalPeriod.end) return null;
    if (patch.period.start === originalPeriod.start && patch.period.end === originalPeriod.end) return null;
    previous.period = originalPeriod;
    proposed.period = patch.period;
    effective.period = patch.period;
  }
  if (patch.areaTolerancePercent) {
    if (!originalArea || patch.areaTolerancePercent === originalArea) return null;
    previous.areaTolerancePercent = originalArea;
    proposed.areaTolerancePercent = patch.areaTolerancePercent;
    effective.areaTolerancePercent = patch.areaTolerancePercent;
  }
  if (patch.tradeKinds) {
    if (!originalKinds || patch.tradeKinds.some(k => !originalKinds.includes(k))) return null;
    if (sameTradeKinds(patch.tradeKinds, originalKinds)) return null;
    previous.tradeKinds = originalKinds;
    proposed.tradeKinds = patch.tradeKinds;
    effective.tradeKinds = patch.tradeKinds;
  }
  if (patch.replacements) {
    if (result.appliedScope !== 'priority' && result.appliedScope !== 'expansion') return null;
    if (sameReplacements(patch.replacements, originalReps)) return null;
    previous.replacements = originalReps;
    proposed.replacements = patch.replacements;
    effective.replacements = patch.replacements;
  }
  if (!Object.keys(proposed).length) return null;
  return { kind: 'conditions', previous, proposed, effective, status: 'pending', resultRunId: null };
}

// 브라우저 예제도 같은 의도 해석과 저장값 설명을 사용하되 승인과 쓰기 권한은 갖지 않는다.
export function conversationExample(message: string, result: Result, previousIntent?: string) {
  if (result?.contractVersion !== 'comparison/v1' || result.dataOrigin !== 'synthetic' || !messageValid(message))
    throw new ApiError('invalid_conversation_input');
  const original = confirmedPeriod(result);
  const unavailable = () => ({ intent: 'period' as Intent, proposal: null as Proposal | null,
    answer: original ? '이 예시에서 수집한 계약 기간은 ' + original.start + '부터 ' + original.end + '까지입니다. 이 안의 날짜로 요청해 주세요.'
      : '이 예시에는 날짜를 바꿔 비교할 수 있는 확정 계약 기간이 없습니다.' });
  const conditionUnavailable = () => ({ intent: 'help' as Intent, proposal: null as Proposal | null,
    answer: '이 예시 결과에서는 요청한 비교 조건을 변경할 수 없습니다.' });
  try {
    const parsed = interpretChat(message, result);
    if (parsed.intent === 'change_period' && parsed.period) {
      if (!original || parsed.period.start < original.start || parsed.period.end > original.end) return unavailable();
      const proposal: PeriodProposal = {
        ...parsed.period, previousStart: original.start, previousEnd: original.end, status: 'pending', resultRunId: null,
      };
      return { intent: parsed.intent, proposal, answer: '계약 기간을 ' + parsed.period.start + '부터 ' + parsed.period.end + '까지로 변경하는 예시입니다.' };
    }
    if (parsed.intent === 'change_conditions') {
      const proposal = buildGuestConditionProposal(parsed.conditions, result);
      if (!proposal) return parsed.conditions.period ? unavailable() : conditionUnavailable();
      return {
        intent: parsed.intent,
        proposal,
        answer: describeConditionDiff(proposal, result) + ' 변경을 미리 보는 예시입니다. 로그인 후 내 분석에서 승인하면 새 결과를 계산합니다.',
      };
    }
    const previous = intents.find(i => i === previousIntent) ?? 'help';
    const explanation = explainTurn(message, parsed.intent, previous, result, null);
    return { intent: explanation.topic, proposal: null, answer: explanation.answer };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'conversation_period_unavailable') return unavailable();
    if (error instanceof ApiError && error.code === 'conversation_condition_unavailable') return conditionUnavailable();
    throw error;
  }
}

export function conditionEditExample(conditions: unknown, message: string, result: Result) {
  if (result?.contractVersion !== 'comparison/v1' || result.dataOrigin !== 'synthetic' || !messageValid(message))
    throw new ApiError('invalid_conversation_input');
  const normalized = normalizeConditionPatch(conditions);
  if (!normalized) throw new ApiError('invalid_conversation_input');
  const proposal = buildGuestConditionProposal(normalized, result);
  if (!proposal) throw new ApiError('conversation_condition_unavailable');
  return {
    intent: 'change_conditions' as const,
    proposal,
    answer: describeConditionDiff(proposal, result) + ' 변경을 미리 보는 예시입니다. 로그인 후 내 분석에서 승인하면 새 결과를 계산합니다.',
  };
}

function readProposal(value: unknown, intent: Intent): Proposal | null {
  if (value === null) {
    if (intent === 'change_period' || intent === 'change_conditions') throw new Error('invalid_conversation_response');
    return null;
  }
  const raw = object(value);
  const { status, resultRunId } = raw;
  if ((status !== 'pending' && status !== 'approved' && status !== 'rejected' && status !== 'cancelled')
    || (resultRunId !== null && !isUuid(resultRunId)) || (status === 'approved') !== (resultRunId !== null)) {
    throw new Error('invalid_conversation_response');
  }
  if (intent === 'change_period') {
    const { start, end, previousStart, previousEnd } = raw;
    if (!isDate(start) || !isDate(end) || start > end || !isDate(previousStart) || !isDate(previousEnd) || previousStart > previousEnd) {
      throw new Error('invalid_conversation_response');
    }
    return { start, end, previousStart, previousEnd, status, resultRunId };
  }
  if (intent === 'change_conditions') {
    if (raw.kind !== 'conditions') throw new Error('invalid_conversation_response');
    const previous = normalizeConditionPatch(raw.previous);
    const proposed = normalizeConditionPatch(raw.proposed);
    const effective = normalizeConditionPatch(raw.effective);
    if (!previous || !proposed || !effective) throw new Error('invalid_conversation_response');
    return { kind: 'conditions', previous, proposed, effective, status, resultRunId };
  }
  throw new Error('invalid_conversation_response');
}

function readConditionBounds(value: unknown): ConditionBounds {
  const raw = object(value);
  const { editable, period, tradeKinds: kinds, areaToleranceMax, areaEditable, replacementsEditable } = raw;
  if (typeof editable !== 'boolean' || typeof areaEditable !== 'boolean' || typeof replacementsEditable !== 'boolean') {
    throw new Error('invalid_conversation_response');
  }
  let parsedPeriod: (Period & { asOf: string }) | null = null;
  if (period !== null) {
    const p = object(period);
    const ordered = orderedPeriod(p.start, p.end);
    if (!ordered || !isDate(p.asOf)) throw new Error('invalid_conversation_response');
    parsedPeriod = { ...ordered, asOf: p.asOf };
  }
  let parsedKinds: TradeKind[] = [];
  if (!Array.isArray(kinds)) throw new Error('invalid_conversation_response');
  if (kinds.length > 0) {
    const normalized = normalizeTradeKinds(kinds);
    if (!normalized) throw new Error('invalid_conversation_response');
    parsedKinds = normalized;
  }
  const maxTol = normalizeAreaTolerance(areaToleranceMax);
  if (!maxTol) throw new Error('invalid_conversation_response');
  return {
    editable,
    period: parsedPeriod,
    tradeKinds: parsedKinds,
    areaToleranceMax: maxTol,
    areaEditable,
    replacementsEditable,
  };
}

const agentReplyStatuses = ['queued', 'leased', 'answered', 'rejected', 'failed', 'expired'] as const;
export type AgentReplyStatus = typeof agentReplyStatuses[number];
const citationKinds = new Set([
  'comparison', 'condition', 'hold', 'exclusion', 'document', 'trade', 'region', 'source_restriction',
]);
export type AgentCitation = { kind: string; reference: string; label: string };
export type AgentReply = {
  status: AgentReplyStatus;
  model: string;
  answer: string | null;
  citations: AgentCitation[];
  completedAt: string | null;
};

function agentAnswerValid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && [...value].length <= 2000 && !/[\u0000-\u0009\u000b-\u001f\u007f]|\p{Cs}/u.test(value);
}

function readAgentReply(value: unknown): AgentReply | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_conversation_response');
  const raw = value as Record<string, unknown>;
  const status = agentReplyStatuses.find(s => s === raw.status);
  if (!status) throw new Error('invalid_conversation_response');
  if (typeof raw.model !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(raw.model)) {
    throw new Error('invalid_conversation_response');
  }
  let parsedAnswer: string | null = null;
  if (status === 'answered') {
    if (!agentAnswerValid(raw.answer)) throw new Error('invalid_conversation_response');
    parsedAnswer = raw.answer;
  } else if (raw.answer !== null) {
    throw new Error('invalid_conversation_response');
  }

  const parsedCitations: AgentCitation[] = [];
  if (raw.citations !== undefined) {
    if (!Array.isArray(raw.citations) || raw.citations.length > 20) {
      throw new Error('invalid_conversation_response');
    }
    if (status !== 'answered' && raw.citations.length > 0) {
      throw new Error('invalid_conversation_response');
    }
    for (const item of raw.citations) {
      const c = object(item);
      if (typeof c.kind !== 'string' || !citationKinds.has(c.kind)
        || !isPublicLabel(c.reference, 120) || !isPublicLabel(c.label, 120)) {
        throw new Error('invalid_conversation_response');
      }
      parsedCitations.push({ kind: c.kind, reference: c.reference, label: c.label });
    }
  }

  let completedAt: string | null = null;
  if (status === 'queued' || status === 'leased') {
    if (raw.completedAt !== null && raw.completedAt !== undefined) {
      throw new Error('invalid_conversation_response');
    }
  } else if (status === 'answered') {
    if (!isTimestamp(raw.completedAt)) throw new Error('invalid_conversation_response');
    completedAt = raw.completedAt;
  } else if (raw.completedAt !== null && raw.completedAt !== undefined) {
    if (!isTimestamp(raw.completedAt)) throw new Error('invalid_conversation_response');
    completedAt = raw.completedAt;
  }

  return {
    status,
    model: raw.model,
    answer: parsedAnswer,
    citations: parsedCitations,
    completedAt,
  };
}

function history(raw: unknown, snapshot: ComparisonSnapshot) {
  const record = object(raw);
  const { analysisId, runId, previousRunId = null, turns, hasEarlier } = record;
  if (analysisId !== snapshot.analysisId || runId !== snapshot.runId || !Array.isArray(turns) || turns.length > 30 || typeof hasEarlier !== 'boolean')
    throw new Error('invalid_conversation_response');
  if (previousRunId !== null && (!isUuid(previousRunId) || previousRunId === runId)) throw new Error('invalid_conversation_response');
  const conditionBounds = record.conditionBounds !== undefined ? readConditionBounds(record.conditionBounds) : undefined;
  const ids = new Set<string>();
  let previousIntent: Intent = 'help';
  const rendered = turns.map(rawTurn => {
    const turn = object(rawTurn);
    const { id, message, createdAt } = turn;
    const intent = intents.find(i => i === turn.intent);
    if (!isUuid(id) || ids.has(id) || turn.runId !== runId || !messageValid(message) || !isTimestamp(createdAt) || !intent)
      throw new Error('invalid_conversation_response');
    ids.add(id);
    const proposal = readProposal(turn.proposal, intent);
    const agentReply = readAgentReply(turn.agentReply);
    const explanation = explainTurn(message, intent, previousIntent, snapshot.result, proposal);
    previousIntent = explanation.topic;
    return { id, runId, message, intent, createdAt, proposal, answer: explanation.answer, agentReply };
  });
  return {
    contractVersion: 'analysis-conversation/v1',
    analysisId,
    runId,
    previousRunId,
    ...(conditionBounds !== undefined ? { conditionBounds } : {}),
    hasEarlier,
    turns: rendered,
  };
}

function validateStructuredConditions(conditions: ConditionPatch, result: Result) {
  const asOf = result.conditions.asOf;
  if (conditions.period) {
    const previous = confirmedPeriod(result);
    if (!isDate(asOf) || conditions.period.end > asOf || !previous) {
      throw new ApiError('conversation_period_unavailable');
    }
  }
  if (conditions.areaTolerancePercent) {
    if (!currentAreaTolerance(result)) throw new ApiError('conversation_condition_unavailable');
  }
  if (conditions.tradeKinds) {
    if (!currentTradeKinds(result)) throw new ApiError('conversation_condition_unavailable');
  }
  if (conditions.replacements) {
    if (result.appliedScope !== 'priority' && result.appliedScope !== 'expansion') {
      throw new ApiError('conversation_condition_unavailable');
    }
    const pool = candidatePoolEntries(result);
    if (conditions.replacements.length > 0 && pool.length > 0) {
      const baseSlots = new Set<string>();
      const displayedIds = new Set<string>();
      for (const item of result.comparables) {
        const c = object(item);
        if (!complexIdValid(c.complexId)) continue;
        displayedIds.add(c.complexId);
        baseSlots.add(complexIdValid(c.replacesComplexId) ? c.replacesComplexId : c.complexId);
      }
      const existingBySlot = new Map(currentReplacements(result).map(r => [r.replaceComplexId, r.complexId]));
      const poolById = new Map(pool.map(e => [e.complexId, e]));
      for (const pair of conditions.replacements) {
        if (!baseSlots.has(pair.replaceComplexId)) throw new ApiError('conversation_condition_unavailable');
        if (baseSlots.has(pair.complexId)) throw new ApiError('conversation_condition_unavailable');
        const cand = poolById.get(pair.complexId);
        if (!cand || !cand.eligible) throw new ApiError('conversation_condition_unavailable');
        if (displayedIds.has(pair.complexId) && existingBySlot.get(pair.replaceComplexId) !== pair.complexId) {
          throw new ApiError('conversation_condition_unavailable');
        }
      }
    }
  }
}

export async function readConversation(request: Request, backend: ChatBackend, analysis: string, run: string, turn?: string) {
  const invalid = () => new ApiError('invalid_conversation_input');
  if (!isUuid(analysis) || !isUuid(run) || (turn !== undefined && !isUuid(turn)) || new URL(request.url).search) throw invalid();
  const address = { analysisId: analysis.toLowerCase(), runId: run.toLowerCase() };
  let decision: Decision | undefined;
  let submission: { requestId: string; message: string; conditions?: ConditionPatch } | undefined;
  if (request.method === 'POST') {
    const body = object(await readJsonRequest(request, 'invalid_conversation_input'));
    if (turn) {
      if (Object.keys(body).length !== 1 || (body.decision !== 'approve' && body.decision !== 'reject' && body.decision !== 'cancel')) throw invalid();
      decision = body.decision;
    } else {
      const keys = Object.keys(body);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!isUuid(body.requestId) || !messageValid(message)) throw invalid();
      if (keys.length === 2 && Object.hasOwn(body, 'requestId') && Object.hasOwn(body, 'message')) {
        submission = { requestId: body.requestId.toLowerCase(), message };
      } else if (keys.length === 3 && Object.hasOwn(body, 'requestId') && Object.hasOwn(body, 'message') && Object.hasOwn(body, 'conditions')) {
        const conditions = normalizeConditionPatch(body.conditions);
        if (!conditions) throw invalid();
        submission = { requestId: body.requestId.toLowerCase(), message, conditions };
      } else {
        throw invalid();
      }
    }
  }
  const { signal } = request;
  const snapshot = await backend.getComparison(address.analysisId, address.runId, signal);
  let op: ChatOperation = { ...address, action: 'read' };
  if (turn && decision) op = { ...address, action: 'decide', turnId: turn.toLowerCase(), decision };
  if (submission) {
    if (submission.conditions) {
      validateStructuredConditions(submission.conditions, snapshot.result);
      op = {
        ...address,
        action: 'submit_conditions',
        requestId: submission.requestId,
        message: submission.message,
        conditions: submission.conditions,
      };
    } else {
      const interpreted = interpretChat(submission.message, snapshot.result);
      if (interpreted.intent === 'change_conditions') {
        op = {
          ...address,
          action: 'submit_conditions',
          requestId: submission.requestId,
          message: submission.message,
          conditions: interpreted.conditions,
        };
      } else {
        op = {
          ...address,
          action: 'submit',
          requestId: submission.requestId,
          message: submission.message,
          intent: interpreted.intent,
          period: interpreted.period,
        };
      }
    }
  }
  return history(await backend.analysisConversation(op, signal), snapshot);
}
