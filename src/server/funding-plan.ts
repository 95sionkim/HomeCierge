import { isUuid } from './http-input.js';

const items = ['sale_price', 'required_options'] as const;
const scheduleStatuses = ['available', 'unavailable', 'selection_unverified', 'source_restricted'] as const;
const componentStatuses = ['confirmed', 'unverified', 'conflict'] as const;
const stages = ['deposit', 'interim', 'balance'] as const;
const dateStatuses = ['exact', 'relative', 'range', 'missing', 'unverified'] as const;
const eventTriggers = ['contract_signing', 'move_in'] as const;
const triggers = ['calendar_date', 'deadline', ...eventTriggers] as const;
const wonPattern = /^(?:0|[1-9][0-9]{0,19})$/;
const maxFundWon = 9223372036854775807n;
const tokenPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

type Item = typeof items[number];
type ScheduleStatus = typeof scheduleStatuses[number];
type DataOrigin = 'synthetic' | 'collected';
type Selection = { analysisId: string; snapshotId: string; modelNo: string; room: string };
type EvidenceRef = { document: string; version: string; page: number };
type Fund = {
  id: string;
  kind: 'current' | 'additional';
  amountWon: string;
  availableOn: string;
  certainty: 'confirmed' | 'expected';
};
type Component = {
  item: Item;
  status: typeof componentStatuses[number] | 'missing';
  totalWon: string | null;
  reasons: string[];
  evidence: EvidenceRef[];
  installments: Installment[];
};
type Installment = {
  item: Item;
  stage: typeof stages[number];
  won: string;
  timing: {
    trigger: typeof triggers[number] | null;
    dateStatus: typeof dateStatuses[number];
    date: string | null;
    evidence: EvidenceRef[];
  };
};
type HoldReason = 'opening_balance_missing' | 'payment_before_opening' | 'opening_date_inflow_overlap'
  | 'opening_date_payment_order_unverified' | 'payment_schedule_incomplete' | 'payment_date_unverified';
type SubtotalHoldReason = 'subtotal_documents_differ' | 'subtotal_out_of_range';
type Checkpoint = {
  fundsWon: string | null;
  knownFundsWon: string | null;
  shortfallWon: string | null;
  holdReasons: HoldReason[];
};
type TimingScenarios = { beforeIncomingFunds: Checkpoint; afterIncomingFunds: Checkpoint };
type Day = {
  date: string;
  installments: Installment[];
  knownDueWon: string;
  knownCumulativeDueWon: string;
  knownCumulativeDueSinceOpeningWon: string | null;
  scenarios: { confirmedOnly: TimingScenarios; includingExpected: TimingScenarios };
};

export type FundingPlanResult = {
  contractVersion: 'funding-plan/v1';
  selection: Selection;
  dataOrigin: DataOrigin;
  scheduleStatus: ScheduleStatus;
  status: 'complete' | 'partial' | Exclude<ScheduleStatus, 'available'>;
  evidence: EvidenceRef[];
  userInputs: { funds: Fund[]; openingBalanceStatus: 'provided' | 'missing' };
  assumptions: {
    expectedFunds: 'only_in_including_expected';
    sameDayTiming: 'before_and_after_incoming_funds';
    openingBalance: 'as_of_available_on';
    openingDayPayments: 'hold_if_order_unverified';
    earlierAdditionalFundIds: string[];
    openingDateAdditionalFundIds: string[];
  };
  components: Component[];
  knownRequiredTotalWon: string | null;
  requiredTotalWon: string | null;
  subtotalHoldReasons: SubtotalHoldReason[];
  undatedInstallments: Installment[];
  rows: Day[];
};

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('invalid_funding_response');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function oneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return choices.some(choice => choice === value);
}

function isDate(value: unknown): value is string {
  if (!matches(value, /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\p{Cc}\p{Cs}]/u.test(value);
}

function readEvidence(value: unknown): EvidenceRef[] {
  requireValid(Array.isArray(value));
  return Array.from(value, row => {
    requireValid(isRecord(row));
    const { document, version, page } = row;
    requireValid(matches(document, tokenPattern) && matches(version, tokenPattern)
      && typeof page === 'number' && Number.isSafeInteger(page) && page > 0);
    return { document, version, page };
  });
}

function documentVersionKey(ref: EvidenceRef) {
  return JSON.stringify([ref.document, ref.version]);
}

function readInstallment(value: unknown, item: Item, amountDocuments: ReadonlySet<string>): Installment {
  requireValid(isRecord(value));
  const { stage, won, timing } = value;
  requireValid(oneOf(stage, stages) && matches(won, wonPattern) && won !== '0' && isRecord(timing));
  const { trigger, dateStatus, date } = timing;
  const evidence = readEvidence(timing.evidence);
  requireValid((trigger === null || oneOf(trigger, triggers)) && oneOf(dateStatus, dateStatuses));
  requireValid(date === null || isDate(date));
  if (dateStatus === 'exact') {
    const dateDocuments = new Set(evidence.map(documentVersionKey));
    requireValid(trigger !== null && date !== null && dateDocuments.size > 0
      && dateDocuments.size === amountDocuments.size && [...dateDocuments].every(ref => amountDocuments.has(ref)));
  } else {
    requireValid(date === null && evidence.length === 0);
    const eventTrigger = oneOf(trigger, eventTriggers);
    if (dateStatus === 'missing') requireValid(trigger === null);
    else if (dateStatus === 'relative') requireValid(eventTrigger);
    else requireValid(trigger === null || eventTrigger);
  }
  return { item, stage, won, timing: { trigger, dateStatus, date, evidence } };
}

function readSchedules(value: unknown, selection: Selection) {
  requireValid(Array.isArray(value));
  const schedules = new Map<Item, Component>();
  const houseTypes = new Set<string>();
  for (const row of value) {
    requireValid(isRecord(row));
    const { modelNo, houseType, room, item, status, totalWon, reasons, installments } = row;
    requireValid(modelNo === selection.modelNo && room === selection.room && isLabel(houseType) && [...houseType].length <= 120
      && oneOf(item, items) && !schedules.has(item) && oneOf(status, componentStatuses)
      && Array.isArray(reasons) && Array.isArray(installments));
    const reasonCodes = Array.from(reasons, reason => {
      requireValid(matches(reason, /^[a-z][a-z0-9_]{0,79}$/));
      return reason;
    });
    houseTypes.add(houseType);
    const evidence = readEvidence(row.evidence);
    const amountDocuments = new Set(evidence.map(documentVersionKey));
    const parsed = Array.from(installments, installment => readInstallment(installment, item, amountDocuments));
    if (status === 'confirmed') {
      requireValid(reasonCodes.length === 0 && evidence.length > 0 && matches(totalWon, wonPattern)
        && (item !== 'sale_price' || totalWon !== '0'));
      requireValid(parsed.reduce((sum, installment) => sum + BigInt(installment.won), 0n) === BigInt(totalWon));
    } else {
      requireValid(totalWon === null && parsed.length === 0 && reasonCodes.length > 0);
    }
    schedules.set(item, { item, status, totalWon, reasons: reasonCodes, evidence, installments: parsed });
  }
  requireValid(houseTypes.size <= 1);
  return schedules;
}

function readFunds(value: unknown): Fund[] {
  requireValid(Array.isArray(value));
  const funds = Array.from(value, row => {
    requireValid(isRecord(row));
    const { id, kind, amountWon, availableOn, certainty } = row;
    requireValid(isUuid(id) && oneOf(kind, ['current', 'additional']) && matches(amountWon, wonPattern)
      && BigInt(amountWon) <= maxFundWon && isDate(availableOn) && oneOf(certainty, ['confirmed', 'expected']));
    return { id, kind, amountWon, availableOn, certainty };
  });
  requireValid(new Set(funds.map(fund => fund.id.toLowerCase())).size === funds.length
    && funds.filter(fund => fund.kind === 'current').length <= 1);
  return funds;
}

function sumKnown(a: bigint | null, b: bigint | null): bigint | null {
  return a === null ? b : a + (b ?? 0n);
}

function checkpoint(knownFunds: bigint | null, due: bigint | null,
  fundingHolds: HoldReason[], shortfallHolds: HoldReason[]): Checkpoint {
  const funds = fundingHolds.length === 0 ? knownFunds : null;
  const holdReasons = [...fundingHolds, ...shortfallHolds];
  const gap = funds !== null && due !== null && holdReasons.length === 0 ? due - funds : null;
  return {
    fundsWon: funds?.toString() ?? null,
    knownFundsWon: knownFunds?.toString() ?? null,
    shortfallWon: gap === null ? null : (gap > 0n ? gap : 0n).toString(),
    holdReasons,
  };
}

type FundTotals = Record<Fund['certainty'], bigint | null>;

function totalFor(totals: FundTotals, includeExpected: boolean): bigint | null {
  return includeExpected ? sumKnown(totals.confirmed, totals.expected) : totals.confirmed;
}

function buildRows(paymentsByDate: Map<string, Installment[]>, incomingByDate: Map<string, FundTotals>,
  opening: Fund | null, overlaps: Set<Fund['certainty']>, scheduleHolds: HoldReason[]): Day[] {
  const rows: Day[] = [];
  const dates = new Set([...paymentsByDate.keys(), ...incomingByDate.keys()]);
  const carried: FundTotals = { confirmed: null, expected: null };
  const openingAmount = opening === null ? null : BigInt(opening.amountWon);
  const paymentOnOpeningDate = opening !== null && paymentsByDate.has(opening.availableOn);
  let cumulativeDue = 0n;
  let cumulativeSinceOpening = 0n;
  for (const date of [...dates].sort()) {
    const today = incomingByDate.get(date) ?? { confirmed: null, expected: null };
    const installments = paymentsByDate.get(date);
    if (installments) {
      const due = installments.reduce((sum, installment) => sum + BigInt(installment.won), 0n);
      cumulativeDue += due;
      const beforeOpening = opening !== null && date < opening.availableOn;
      const openingDay = date === opening?.availableOn;
      const openingHold = opening === null ? 'opening_balance_missing' : beforeOpening ? 'payment_before_opening' : null;
      // 관측일에 납부했다면 이미 잔액에 반영된 금액일 수 있다. 이후 누적 부담도 관측 순서에 달려 있다.
      const paymentOrderHold = paymentOnOpeningDate && !beforeOpening ? 'opening_date_payment_order_unverified' : null;
      const canAccumulate = openingHold === null && paymentOrderHold === null;
      if (canAccumulate) cumulativeSinceOpening += due;
      const comparableDue = canAccumulate ? cumulativeSinceOpening : null;
      const fundingHold = openingDay ? paymentOrderHold : openingHold;
      const fundingHolds: HoldReason[] = fundingHold === null ? [] : [fundingHold];
      const shortfallHolds: HoldReason[] = !openingDay && paymentOrderHold !== null
        ? [paymentOrderHold, ...scheduleHolds] : scheduleHolds;

      function scenarios(includeExpected: boolean): TimingScenarios {
        const balance = !includeExpected && opening?.certainty === 'expected' ? 0n : openingAmount;
        const before = beforeOpening ? null : sumKnown(balance, totalFor(carried, includeExpected));
        const after = beforeOpening ? null : sumKnown(before, totalFor(today, includeExpected));
        const overlap = overlaps.has('confirmed') || (includeExpected && overlaps.has('expected'));
        const afterHolds: HoldReason[] = overlap && !beforeOpening
          ? [...fundingHolds, 'opening_date_inflow_overlap'] : fundingHolds;
        const beforeHolds = openingDay ? fundingHolds : afterHolds;
        return {
          beforeIncomingFunds: checkpoint(before, comparableDue, beforeHolds, shortfallHolds),
          afterIncomingFunds: checkpoint(after, comparableDue, afterHolds, shortfallHolds),
        };
      }

      rows.push({ date, installments, knownDueWon: due.toString(), knownCumulativeDueWon: cumulativeDue.toString(),
        knownCumulativeDueSinceOpeningWon: comparableDue?.toString() ?? null,
        scenarios: { confirmedOnly: scenarios(false), includingExpected: scenarios(true) } });
    }
    carried.confirmed = sumKnown(carried.confirmed, today.confirmed);
    carried.expected = sumKnown(carried.expected, today.expected);
  }
  return rows;
}

// 같은 분석과 호실의 공고 근거를 사용자가 입력한 날짜별 자금과 대조한다.
export function calculateFundingPlan(input: unknown): FundingPlanResult {
  requireValid(isRecord(input));
  const { analysisId, snapshotId, modelNo, room, dataOrigin, scheduleStatus } = input;
  requireValid(isUuid(analysisId) && isUuid(snapshotId) && matches(modelNo, /^[0-9]{1,20}$/)
    && isLabel(room) && room.length <= 120 && room === room.trim() && oneOf(dataOrigin, ['synthetic', 'collected'])
    && oneOf(scheduleStatus, scheduleStatuses));
  const selection = { analysisId, snapshotId, modelNo, room };
  const schedules = readSchedules(input.schedules, selection);
  const funds = readFunds(input.funds);
  const opening = funds.find(fund => fund.kind === 'current') ?? null;
  const earlierAdditionalFundIds: string[] = [];
  const openingDateAdditionalFundIds: string[] = [];
  const overlaps = new Set<Fund['certainty']>();
  const incomingByDate = new Map<string, FundTotals>();
  for (const fund of funds) {
    if (fund.kind === 'current') continue;
    const { id, amountWon, availableOn, certainty } = fund;
    // 잔액 관측 전의 유입은 다시 더하지 않는다. 같은 날의 양수 유입은 포함 관계 확인이 필요하다.
    if (opening && availableOn < opening.availableOn) {
      earlierAdditionalFundIds.push(id);
    } else if (opening && availableOn === opening.availableOn && amountWon !== '0') {
      openingDateAdditionalFundIds.push(id);
      overlaps.add(certainty);
    } else {
      const totals = incomingByDate.get(availableOn) ?? { confirmed: null, expected: null };
      totals[certainty] = sumKnown(totals[certainty], BigInt(amountWon));
      incomingByDate.set(availableOn, totals);
    }
  }

  const result: FundingPlanResult = {
    contractVersion: 'funding-plan/v1', selection, dataOrigin, scheduleStatus,
    status: scheduleStatus === 'available' ? 'partial' : scheduleStatus,
    userInputs: { funds, openingBalanceStatus: opening === null ? 'missing' : 'provided' },
    assumptions: { expectedFunds: 'only_in_including_expected', sameDayTiming: 'before_and_after_incoming_funds',
      openingBalance: 'as_of_available_on', openingDayPayments: 'hold_if_order_unverified',
      earlierAdditionalFundIds, openingDateAdditionalFundIds },
    evidence: [], components: [], knownRequiredTotalWon: null, requiredTotalWon: null, subtotalHoldReasons: [],
    undatedInstallments: [], rows: [],
  };
  if (scheduleStatus !== 'available') return result;

  const byDate = new Map<string, Installment[]>();
  const evidence = new Map<string, EvidenceRef>();
  function addEvidence(refs: EvidenceRef[]) {
    for (const ref of refs) evidence.set(JSON.stringify([ref.document, ref.version, ref.page]), ref);
  }

  for (const item of items) {
    const component = schedules.get(item);
    if (!component) {
      result.components.push({ item, status: 'missing', totalWon: null, reasons: ['payment_schedule_missing'],
        evidence: [], installments: [] });
      continue;
    }
    result.components.push(component);
    addEvidence(component.evidence);
    for (const installment of component.installments) {
      const { date, evidence: timingEvidence } = installment.timing;
      addEvidence(timingEvidence);
      if (date === null) {
        result.undatedInstallments.push(installment);
      } else {
        const dated = byDate.get(date) ?? [];
        dated.push(installment);
        byDate.set(date, dated);
      }
    }
  }

  result.evidence = [...evidence.values()];
  const [sale, options] = result.components;
  if (sale.totalWon !== null && options.totalWon !== null) {
    // BE-02과 같은 판본 범위·합계 한도를 써야 검수에서 보류한 두 항목을 다시 합산하지 않는다.
    const saleDocuments = new Set(sale.evidence.map(documentVersionKey));
    if (!options.evidence.some(ref => saleDocuments.has(documentVersionKey(ref)))) {
      result.subtotalHoldReasons.push('subtotal_documents_differ');
      return result;
    }
    const total = (BigInt(sale.totalWon) + BigInt(options.totalWon)).toString();
    if (!wonPattern.test(total)) {
      result.subtotalHoldReasons.push('subtotal_out_of_range');
      return result;
    }
    result.requiredTotalWon = total;
  }
  result.knownRequiredTotalWon = result.requiredTotalWon ?? sale.totalWon ?? options.totalWon;
  const scheduleHolds: HoldReason[] = [];
  if (result.requiredTotalWon === null) scheduleHolds.push('payment_schedule_incomplete');
  if (result.undatedInstallments.length > 0) scheduleHolds.push('payment_date_unverified');
  result.rows = buildRows(byDate, incomingByDate, opening, overlaps, scheduleHolds);
  if (opening && scheduleHolds.length === 0
    && result.rows.every(row => row.scenarios.includingExpected.afterIncomingFunds.shortfallWon !== null)) {
    result.status = 'complete';
  }
  return result;
}
