// 공고, 판본, 호실, 자금과 일정은 모두 합성 자료다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateFundingPlan } from '../../src/server/funding-plan.js';

const selection = {
  analysisId: 'a1100000-0000-4000-8000-000000000001',
  snapshotId: 'a1100000-0000-4000-8000-000000000002',
  modelNo: '01', room: '101동 101호',
};
const houseType = '084.0000A';
const saleRef = { document: 'synthetic-notice-pdf', version: 'synthetic-v1', page: 2 };
const optionsRef = { ...saleRef, page: 3 };
const contractRef = { ...saleRef, page: 1 };

function payment(stage: string, won: string, date: string | null, dateStatus = 'exact', evidence = [saleRef]) {
  return { stage, won, timing: {
    trigger: dateStatus === 'relative' ? 'move_in' : date ? 'calendar_date' : null,
    dateStatus, date, evidence: date ? evidence : [], text: 'SYNTHETIC_PRIVATE_TIMING_TEXT',
  } };
}

function sale(totalWon: string, installments: ReturnType<typeof payment>[]) {
  return { modelNo: selection.modelNo, houseType, room: selection.room, item: 'sale_price', status: 'confirmed',
    totalWon, reasons: [], evidence: [saleRef], installments };
}

const freeOptions = { ...sale('0', []), item: 'required_options', evidence: [optionsRef] };
const regularSale = sale('100', [payment('deposit', '100', '2027-01-10')]);

function fundId(index: number) {
  return `b1100000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function fund(index: number, kind: 'current' | 'additional', amountWon: string, availableOn: string,
  certainty: 'confirmed' | 'expected' = 'confirmed') {
  return { id: fundId(index), kind, amountWon, availableOn, certainty, note: 'SYNTHETIC_PRIVATE_FUND_NOTE' };
}

const opening = fund(1, 'current', '70', '2027-01-01');

function envelope(overrides: Record<string, unknown> = {}) {
  return { ...selection, dataOrigin: 'synthetic', scheduleStatus: 'available',
    schedules: [regularSale, freeOptions], funds: [opening], ...overrides };
}

test('groups sale and mandatory options by exact date and returns projected amounts and evidence', () => {
  const plan = calculateFundingPlan(envelope({
    schedules: [
      { ...freeOptions, totalWon: '20', installments: [payment('deposit', '20', '2027-01-10', 'exact', [optionsRef])] },
      sale('180', [payment('balance', '80', '2027-02-10'), payment('deposit', '100', '2027-01-10', 'exact', [contractRef, saleRef])]),
    ],
    budgetMaxWon: '99999999', loanApproval: '9999', taxWon: '9999',
  }));
  assert.equal(plan.contractVersion, 'funding-plan/v1');
  assert.deepEqual(plan.selection, selection);
  assert.equal(plan.dataOrigin, 'synthetic');
  assert.equal(plan.status, 'complete');
  assert.equal(plan.knownRequiredTotalWon, '200');
  assert.equal(plan.requiredTotalWon, '200');
  assert.deepEqual(plan.rows.map(row => [row.date, row.knownDueWon, row.knownCumulativeDueWon]), [
    ['2027-01-10', '120', '120'], ['2027-02-10', '80', '200'],
  ]);
  assert.deepEqual(plan.rows[0].installments.map(i => i.item), ['sale_price', 'required_options']);
  assert.deepEqual(plan.rows[0].installments[0].timing.evidence, [contractRef, saleRef]);
  assert.deepEqual(new Set(plan.evidence), new Set([contractRef, saleRef, optionsRef]));
  assert.deepEqual(plan.undatedInstallments, []);
  assert.doesNotMatch(JSON.stringify(plan), /SYNTHETIC_PRIVATE|budgetMaxWon|loanApproval|taxWon/);
});

test('returns before- and after-inflow conditions and never revises a prior shortfall with later funds', () => {
  const plan = calculateFundingPlan(envelope({
    schedules: [sale('180', [payment('deposit', '100', '2027-01-10'), payment('balance', '80', '2027-02-10')]), freeOptions],
    funds: [fund(2, 'additional', '500', '2027-02-11'), fund(3, 'additional', '40', '2027-01-11'),
      fund(4, 'additional', '30', '2027-01-10', 'expected'), opening,
      fund(5, 'additional', '20', '2027-01-10')],
  }));
  const [first, second] = plan.rows;
  assert.equal(plan.assumptions.sameDayTiming, 'before_and_after_incoming_funds');
  for (const [actual, fundsWon, shortfallWon] of [
    [first.scenarios.confirmedOnly.beforeIncomingFunds, '70', '30'],
    [first.scenarios.confirmedOnly.afterIncomingFunds, '90', '10'],
    [first.scenarios.includingExpected.beforeIncomingFunds, '70', '30'],
    [first.scenarios.includingExpected.afterIncomingFunds, '120', '0'],
    [second.scenarios.confirmedOnly.afterIncomingFunds, '130', '50'],
    [second.scenarios.includingExpected.afterIncomingFunds, '160', '20'],
  ] as const) {
    assert.equal(actual.fundsWon, fundsWon);
    assert.equal(actual.shortfallWon, shortfallWon);
  }
});

test('starts the comparison at the opening balance date and leaves earlier outcomes unknown', () => {
  const plan = calculateFundingPlan(envelope({
    schedules: [sale('140', [payment('deposit', '50', '2027-01-01'), payment('balance', '90', '2027-02-10')]), freeOptions],
    funds: [fund(2, 'additional', '100', '2026-12-31'), fund(1, 'current', '80', '2027-01-10')],
  }));
  const [earlier, afterOpening] = plan.rows;
  assert.equal(plan.status, 'partial');
  assert.equal(earlier.knownDueWon, '50');
  assert.equal(earlier.knownCumulativeDueSinceOpeningWon, null);
  assert.deepEqual(earlier.scenarios.confirmedOnly.afterIncomingFunds,
    { fundsWon: null, knownFundsWon: null, shortfallWon: null, holdReasons: ['payment_before_opening'] });
  assert.equal(afterOpening.knownCumulativeDueWon, '140');
  assert.equal(afterOpening.knownCumulativeDueSinceOpeningWon, '90');
  assert.equal(afterOpening.scenarios.confirmedOnly.afterIncomingFunds.fundsWon, '80');
  assert.equal(afterOpening.scenarios.confirmedOnly.afterIncomingFunds.shortfallWon, '10');
  assert.deepEqual(plan.assumptions.earlierAdditionalFundIds, [fundId(2)]);
});

test('holds the opening date and later shortfalls when a positive payment may already be in the opening balance', () => {
  const plan = calculateFundingPlan(envelope({
    schedules: [sale('160', [payment('deposit', '70', '2027-01-10'), payment('balance', '90', '2027-02-10')]), freeOptions],
    funds: [fund(1, 'current', '80', '2027-01-10')],
  }));
  const [sameDay, later] = plan.rows;
  const holdReasons = ['opening_date_payment_order_unverified'];
  assert.equal(plan.status, 'partial');
  assert.equal(plan.assumptions.openingDayPayments, 'hold_if_order_unverified');
  assert.deepEqual([sameDay.knownDueWon, later.knownCumulativeDueWon], ['70', '160']);
  assert.deepEqual([sameDay.knownCumulativeDueSinceOpeningWon, later.knownCumulativeDueSinceOpeningWon], [null, null]);
  for (const scenario of Object.values(sameDay.scenarios)) {
    for (const checkpoint of Object.values(scenario)) {
      assert.deepEqual(checkpoint, { fundsWon: null, knownFundsWon: '80', shortfallWon: null, holdReasons });
    }
  }
  for (const scenario of Object.values(later.scenarios)) {
    for (const checkpoint of Object.values(scenario)) {
      assert.deepEqual(checkpoint, { fundsWon: '80', knownFundsWon: '80', shortfallWon: null, holdReasons });
    }
  }
});

test('an opening date without a positive payment leaves later shortfalls calculable', () => {
  const plan = calculateFundingPlan(envelope({ funds: [opening, fund(2, 'additional', '0', opening.availableOn)] }));
  assert.equal(plan.status, 'complete');
  assert.equal(plan.components[1].totalWon, '0');
  assert.deepEqual(plan.rows.map(row => row.date), ['2027-01-10']);
  assert.equal(plan.rows[0].knownCumulativeDueSinceOpeningWon, '100');
  assert.deepEqual(plan.rows[0].scenarios.confirmedOnly.afterIncomingFunds,
    { fundsWon: '70', knownFundsWon: '70', shortfallWon: '30', holdReasons: [] });
});

test('retains independent funds when a receipt may already be in the opening balance', () => {
  const plan = calculateFundingPlan(envelope({
    schedules: [sale('270', [payment('deposit', '120', '2027-01-10'), payment('balance', '150', '2027-02-10')]), freeOptions],
    funds: [fund(1, 'current', '100', '2027-01-10'), fund(2, 'additional', '45', '2027-01-10', 'expected'),
      fund(3, 'additional', '70', '2027-01-11'), fund(4, 'additional', '0', '2027-01-10')],
  }));
  const [first, later] = plan.rows;
  assert.deepEqual(plan.assumptions.openingDateAdditionalFundIds, [fundId(2)]);
  assert.deepEqual(first.scenarios.includingExpected.beforeIncomingFunds.holdReasons, ['opening_date_payment_order_unverified']);
  assert.deepEqual(first.scenarios.confirmedOnly.afterIncomingFunds.holdReasons, ['opening_date_payment_order_unverified']);
  for (const [checkpoint, knownFundsWon] of [
    [first.scenarios.includingExpected.afterIncomingFunds, '100'],
    [later.scenarios.includingExpected.beforeIncomingFunds, '170'],
  ] as const) {
    assert.equal(checkpoint.fundsWon, null);
    assert.equal(checkpoint.knownFundsWon, knownFundsWon);
    assert.equal(checkpoint.shortfallWon, null);
    assert.deepEqual(new Set(checkpoint.holdReasons), new Set(['opening_date_payment_order_unverified', 'opening_date_inflow_overlap']));
  }
  assert.deepEqual(later.scenarios.confirmedOnly.beforeIncomingFunds, {
    fundsWon: '170', knownFundsWon: '170', shortfallWon: null, holdReasons: ['opening_date_payment_order_unverified'],
  });
});

test('confirmed opening-date overlap also holds the confirmed scenarios after that inflow', () => {
  const plan = calculateFundingPlan(envelope({ funds: [
    fund(1, 'current', '70', '2027-01-01'), fund(2, 'additional', '100', '2027-01-01'),
  ] }));
  for (const scenario of Object.values(plan.rows[0].scenarios)) {
    assert.equal(scenario.beforeIncomingFunds.shortfallWon, null);
    assert.deepEqual(scenario.afterIncomingFunds,
      { fundsWon: null, knownFundsWon: '70', shortfallWon: null, holdReasons: ['opening_date_inflow_overlap'] });
  }
});

test('zero opening, missing opening, and expected opening have different shortfall results', () => {
  const additional = fund(2, 'additional', '60', '2027-01-02');
  const missing = calculateFundingPlan(envelope({ funds: [additional] }));
  assert.equal(missing.userInputs.openingBalanceStatus, 'missing');
  assert.deepEqual(missing.rows[0].scenarios.confirmedOnly.afterIncomingFunds,
    { fundsWon: null, knownFundsWon: '60', shortfallWon: null, holdReasons: ['opening_balance_missing'] });

  const zero = calculateFundingPlan(envelope({ funds: [fund(1, 'current', '0', '2027-01-01')] }));
  assert.equal(zero.userInputs.openingBalanceStatus, 'provided');
  assert.equal(zero.rows[0].scenarios.confirmedOnly.afterIncomingFunds.fundsWon, '0');
  assert.equal(zero.rows[0].scenarios.confirmedOnly.afterIncomingFunds.shortfallWon, '100');

  const expected = calculateFundingPlan(envelope({
    funds: [fund(1, 'current', '40', '2027-01-01', 'expected'), additional],
  }));
  assert.equal(expected.rows[0].scenarios.confirmedOnly.afterIncomingFunds.shortfallWon, '40');
  assert.equal(expected.rows[0].scenarios.includingExpected.afterIncomingFunds.shortfallWon, '0');
});

test('does not carry a preceding analysis’s funds into another analysis', () => {
  assert.equal(calculateFundingPlan(envelope()).rows[0].scenarios.confirmedOnly.afterIncomingFunds.fundsWon, '70');
  const analysisId = 'a1100000-0000-4000-8000-000000000003';
  const plan = calculateFundingPlan(envelope({ analysisId, funds: [] }));
  assert.equal(plan.selection.analysisId, analysisId);
  assert.deepEqual(plan.userInputs.funds, []);
  assert.deepEqual(plan.rows[0].scenarios.confirmedOnly.afterIncomingFunds,
    { fundsWon: null, knownFundsWon: null, shortfallWon: null, holdReasons: ['opening_balance_missing'] });
});

test('keeps exact date rows and confirmed totals when other payments lack an exact date', () => {
  const plan = calculateFundingPlan(envelope({ schedules: [sale('140', [
    payment('deposit', '100', '2027-01-10'), payment('interim', '10', null, 'range'),
    payment('interim', '10', null, 'unverified'), payment('interim', '10', null, 'missing'),
    payment('balance', '10', null, 'relative'),
  ]), freeOptions] }));
  assert.equal(plan.status, 'partial');
  assert.equal(plan.requiredTotalWon, '140');
  assert.equal(plan.rows[0].knownDueWon, '100');
  assert.equal(plan.rows.length, 1);
  assert.deepEqual(plan.undatedInstallments.map(i => [i.won, i.timing.dateStatus, i.timing.date]), [
    ['10', 'range', null], ['10', 'unverified', null], ['10', 'missing', null], ['10', 'relative', null],
  ]);
  assert.deepEqual(plan.rows[0].scenarios.confirmedOnly.afterIncomingFunds,
    { fundsWon: '70', knownFundsWon: '70', shortfallWon: null, holdReasons: ['payment_date_unverified'] });
});

test('treats absent options, explicit free options and conflicting options as distinct states', () => {
  const conflict = { ...freeOptions, status: 'conflict', totalWon: null, reasons: ['payment_amount_mismatch'] };
  for (const [schedules, expectedStatus] of [[[regularSale], 'missing'], [[regularSale, conflict], 'conflict']] as const) {
    const held = calculateFundingPlan(envelope({ schedules }));
    assert.equal(held.status, 'partial');
    assert.equal(held.components[1].status, expectedStatus);
    assert.equal(held.components[1].totalWon, null);
    assert.equal(held.knownRequiredTotalWon, '100');
    assert.equal(held.requiredTotalWon, null);
    assert.equal(held.rows[0].knownDueWon, '100');
    assert.equal(held.rows[0].scenarios.confirmedOnly.afterIncomingFunds.shortfallWon, null);
    assert.deepEqual(held.rows[0].scenarios.confirmedOnly.afterIncomingFunds.holdReasons, ['payment_schedule_incomplete']);
  }
  const free = calculateFundingPlan(envelope());
  assert.equal(free.components[1].status, 'confirmed');
  assert.equal(free.components[1].totalWon, '0');
  assert.equal(free.requiredTotalWon, '100');
  assert.equal(free.rows[0].scenarios.confirmedOnly.afterIncomingFunds.shortfallWon, '30');
});

test('keeps an independently verified option when the sale schedule is unverified', () => {
  const plan = calculateFundingPlan(envelope({ schedules: [
    { ...regularSale, status: 'unverified', totalWon: null, installments: [], reasons: ['payment_amount_missing'] },
    { ...freeOptions, totalWon: '20', installments: [payment('deposit', '20', '2027-01-10', 'exact', [optionsRef])] },
  ] }));
  assert.equal(plan.status, 'partial');
  assert.deepEqual(plan.components[0].reasons, ['payment_amount_missing']);
  assert.deepEqual(plan.components[0].evidence, [saleRef]);
  assert.equal(plan.knownRequiredTotalWon, '20');
  assert.equal(plan.requiredTotalWon, null);
  assert.equal(plan.rows[0].installments[0].item, 'required_options');
  assert.equal(plan.rows[0].scenarios.confirmedOnly.afterIncomingFunds.shortfallWon, null);
});

test('returns independent user inputs while suppressing schedules and evidence under a source or selection hold', () => {
  for (const scheduleStatus of ['unavailable', 'selection_unverified', 'source_restricted'] as const) {
    const plan = calculateFundingPlan(envelope({ dataOrigin: 'collected', scheduleStatus }));
    assert.equal(plan.scheduleStatus, scheduleStatus);
    assert.equal(plan.status, scheduleStatus);
    assert.equal(plan.dataOrigin, 'collected');
    assert.deepEqual(plan.rows, []);
    assert.deepEqual(plan.evidence, []);
    assert.deepEqual(plan.components, []);
    assert.deepEqual(plan.undatedInstallments, []);
    assert.equal(plan.knownRequiredTotalWon, null);
    assert.equal(plan.requiredTotalWon, null);
    assert.equal(plan.userInputs.funds[0].amountWon, '70');
  }
});

test('uses exact integer amounts beyond Number precision and canonical dates including leap days', () => {
  const plan = calculateFundingPlan(envelope({
    schedules: [sale('18014398509481992', [payment('deposit', '9007199254740993', '2028-02-29'),
      payment('balance', '9007199254740999', '2028-03-01')]), freeOptions],
    funds: [fund(1, 'current', '9007199254740992', '2028-02-01')],
  }));
  assert.equal(plan.rows[0].scenarios.confirmedOnly.afterIncomingFunds.shortfallWon, '1');
  assert.equal(plan.rows[1].scenarios.confirmedOnly.afterIncomingFunds.shortfallWon, '9007199254741000');
  assert.equal(plan.rows[1].knownCumulativeDueWon, '18014398509481992');
});

test('rejects malformed and cross-room RPC payloads with a single error code', () => {
  const bad = [
    null, {}, envelope({ analysisId: 'SYNTHETIC_PRIVATE_DETAIL' }), envelope({ dataOrigin: 'other' }),
    envelope({ scheduleStatus: 'unknown' }), envelope({ schedules: {} }),
    envelope({ schedules: [{ ...regularSale, room: '101동 102호' }] }),
    envelope({ schedules: [{ ...regularSale, modelNo: '1' }] }),
    envelope({ schedules: [regularSale, { ...freeOptions, houseType: '059.0000A' }] }),
    envelope({ schedules: [regularSale, regularSale] }),
    envelope({ schedules: [{ ...regularSale, totalWon: '101' }] }),
    envelope({ schedules: [{ ...regularSale, evidence: [] }] }),
    envelope({ schedules: [{ ...regularSale, status: 'unverified' }] }),
    envelope({ schedules: [sale('100', [payment('deposit', '100', '2027-01-10', 'exact', [])])] }),
    envelope({ schedules: [sale('100', [payment('deposit', '100', '2027-01-10', 'exact',
      [{ ...saleRef, version: 'synthetic-v2' }])])] }),
    envelope({ schedules: [sale('100', [payment('deposit', '100', '2027-02-29')])] }),
    envelope({ schedules: [sale('100', [payment('deposit', '100', '2027-01-10', 'relative')])] }),
    envelope({ funds: [opening, fund(2, 'current', '70', '2027-01-10')] }),
    envelope({ funds: [opening, fund(1, 'additional', '70', '2027-01-10')] }),
    envelope({ funds: [{ ...opening, amountWon: 0 }] }), envelope({ funds: [{ ...opening, amountWon: null }] }),
    envelope({ funds: [{ ...opening, amountWon: '-1' }] }), envelope({ funds: [{ ...opening, amountWon: '1.5' }] }),
    envelope({ funds: [{ ...opening, availableOn: '2027-01-10T00:00:00Z' }] }),
  ];
  for (const input of bad) {
    assert.throws(() => calculateFundingPlan(input), { message: 'invalid_funding_response' });
  }
});

test('enforces source won bounds while retaining explicit free options and large computed fund sums', () => {
  const maxFundWon = '9223372036854775807';
  const oversized = '1' + '0'.repeat(20);
  const invalid = [
    envelope({ schedules: [sale('0', []), freeOptions] }),
    envelope({ schedules: [sale(oversized, [payment('deposit', oversized, '2027-01-10')]), freeOptions] }),
    envelope({ schedules: [sale('100', [payment('deposit', '100', '2027-01-10'), payment('interim', '0', '2027-02-10')]), freeOptions] }),
    envelope({ funds: [{ ...opening, amountWon: '9223372036854775808' }] }),
    envelope({ funds: [{ ...opening, amountWon: oversized }] }),
    envelope({ funds: [{ ...opening, id: 'synthetic-non-uuid' }] }),
  ];
  for (const input of invalid) assert.throws(() => calculateFundingPlan(input), { message: 'invalid_funding_response' });

  const plan = calculateFundingPlan(envelope({ funds: [fund(1, 'current', maxFundWon, '2027-01-01'),
    ...Array.from({ length: 11 }, (_, index) => fund(index + 2, 'additional', maxFundWon, '2027-01-02'))] }));
  assert.equal(plan.components[1].totalWon, '0');
  assert.equal(plan.rows[0].scenarios.confirmedOnly.afterIncomingFunds.fundsWon, '110680464442257309684');
});

test('requires BE-07 stage and trigger combinations and exact date evidence from every amount version', () => {
  const dated = payment('deposit', '100', '2027-01-10');
  const error = { message: 'invalid_funding_response' };
  const invalid = [
    { ...dated, stage: 'unknown' },
    { ...dated, timing: { ...dated.timing, trigger: null } },
    { ...dated, timing: { ...payment('deposit', '100', null, 'relative').timing, trigger: null } },
    { ...dated, timing: { ...payment('deposit', '100', null, 'range').timing, trigger: 'deadline' } },
    { ...dated, timing: { ...payment('deposit', '100', null, 'unverified').timing, trigger: 'calendar_date' } },
    { ...dated, timing: { ...payment('deposit', '100', null, 'missing').timing, trigger: 'contract_signing' } },
    { ...dated, timing: { ...payment('deposit', '100', null, 'unverified').timing, evidence: [saleRef] } },
  ];
  for (const installment of invalid) {
    assert.throws(() => calculateFundingPlan(envelope({ schedules: [sale('100', [installment]), freeOptions] })), error);
  }
  assert.throws(() => calculateFundingPlan(envelope({ schedules: [
    { ...regularSale, evidence: [saleRef, { ...saleRef, version: 'synthetic-v2' }] }, freeOptions,
  ] })), error);
});

test('keeps API house type trailing spaces as part of the room identity', () => {
  const originalHouseType = `${houseType} `;
  const saleWithSpace = { ...regularSale, houseType: originalHouseType };
  const optionsWithSpace = { ...freeOptions, houseType: originalHouseType };
  const plan = calculateFundingPlan(envelope({ schedules: [saleWithSpace, optionsWithSpace] }));
  assert.equal(plan.requiredTotalWon, '100');
  assert.throws(() => calculateFundingPlan(envelope({ schedules: [saleWithSpace, freeOptions] })),
    { message: 'invalid_funding_response' });
});

test('holds a subtotal across disjoint document versions and preserves each component and installment', () => {
  const disjointRefs = [
    { ...optionsRef, version: 'synthetic-v2' },
    { ...optionsRef, document: 'synthetic-different-notice-pdf' },
  ];
  for (const otherRef of disjointRefs) {
    const options = { ...freeOptions, totalWon: '20', evidence: [otherRef], installments: [
      payment('deposit', '10', '2027-01-10', 'exact', [otherRef]), payment('balance', '10', null, 'relative'),
    ] };
    const plan = calculateFundingPlan(envelope({ schedules: [regularSale, options] }));
    assert.equal(plan.status, 'partial');
    assert.equal(plan.knownRequiredTotalWon, null);
    assert.equal(plan.requiredTotalWon, null);
    assert.deepEqual(plan.subtotalHoldReasons, ['subtotal_documents_differ']);
    assert.deepEqual(plan.rows, []);
    assert.deepEqual(plan.components.map(component => [component.status, component.totalWon, component.evidence]), [
      ['confirmed', '100', [saleRef]], ['confirmed', '20', [otherRef]],
    ]);
    const [saleItem, optionsItem] = plan.components;
    assert.deepEqual(saleItem.installments.map(i => [i.won, i.timing.date]), [['100', '2027-01-10']]);
    assert.deepEqual(optionsItem.installments.map(i => [i.won, i.timing.date]), [['10', '2027-01-10'], ['10', null]]);
    assert.deepEqual(optionsItem.installments[0].timing.evidence, [otherRef]);
    assert.deepEqual(plan.undatedInstallments, [optionsItem.installments[1]]);
    assert.deepEqual(plan.evidence, [saleRef, otherRef]);
  }
});

test('combines payments with one shared document version across different pages and extra cited versions', () => {
  const otherSaleRef = { ...saleRef, version: 'synthetic-sale-v2' };
  const otherOptionsRef = { ...optionsRef, version: 'synthetic-options-v2' };
  const saleItem = { ...regularSale, evidence: [saleRef, otherSaleRef], installments: [
    payment('deposit', '100', '2027-01-10', 'exact', [contractRef, otherSaleRef]),
  ] };
  const optionsItem = { ...freeOptions, totalWon: '20', evidence: [optionsRef, otherOptionsRef], installments: [
    payment('deposit', '20', '2027-01-10', 'exact', [optionsRef, otherOptionsRef]),
  ] };
  const plan = calculateFundingPlan(envelope({ schedules: [saleItem, optionsItem] }));
  assert.equal(plan.status, 'complete');
  assert.deepEqual(plan.subtotalHoldReasons, []);
  assert.equal(plan.requiredTotalWon, '120');
  assert.equal(plan.rows[0].knownDueWon, '120');
  assert.equal(plan.rows[0].scenarios.confirmedOnly.afterIncomingFunds.shortfallWon, '50');
});

test('holds a sum outside the BE-02 subtotal bound while keeping both component amounts', () => {
  const maxSubtotal = '9'.repeat(20);
  const options = { ...freeOptions, totalWon: '1', installments: [payment('deposit', '1', '2027-01-10', 'exact', [optionsRef])] };
  const withSale = (amount: string) => calculateFundingPlan(envelope({
    schedules: [sale(amount, [payment('deposit', amount, '2027-01-10')]), options],
  }));
  const overflow = withSale(maxSubtotal);
  assert.equal(overflow.status, 'partial');
  assert.deepEqual(overflow.subtotalHoldReasons, ['subtotal_out_of_range']);
  assert.equal(overflow.knownRequiredTotalWon, null);
  assert.equal(overflow.requiredTotalWon, null);
  assert.deepEqual(overflow.rows, []);
  assert.deepEqual(overflow.components.map(component => [component.totalWon, component.installments[0].won]), [
    [maxSubtotal, maxSubtotal], ['1', '1'],
  ]);

  const atLimit = withSale('9'.repeat(19) + '8');
  assert.equal(atLimit.status, 'complete');
  assert.deepEqual(atLimit.subtotalHoldReasons, []);
  assert.equal(atLimit.requiredTotalWon, maxSubtotal);
  assert.equal(atLimit.rows[0].knownDueWon, maxSubtotal);
});

test('accepts band display names in funding request and computes optional-only band funding plan (synthetic)', async () => {
  const { readFundingSelection } = await import('../../src/server/funding-request.js');
  const bandName = '101동·102동 3호 라인 11~15층';
  const req = new Request('https://example.invalid/api/v1/analyses/' + selection.analysisId + '/funding-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshotId: selection.snapshotId, modelNo: '01', room: bandName }),
  });
  const parsed = await readFundingSelection(req, selection.analysisId);
  assert.equal(parsed.room, bandName);

  for (const badRoom of ['가'.repeat(121), '101동\n1층', ' 101동 1층 ']) {
    const badReq = new Request('https://example.invalid/api/v1/analyses/' + selection.analysisId + '/funding-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotId: selection.snapshotId, modelNo: '01', room: badRoom }),
    });
    await assert.rejects(() => readFundingSelection(badReq, selection.analysisId));
  }

  const bandSale = { ...sale('700000000', [payment('deposit', '70000000', '2027-01-10'), payment('balance', '630000000', null, 'relative')]), room: bandName };
  const bandOpt = { ...freeOptions, room: bandName };
  const plan = calculateFundingPlan(envelope({ room: bandName, schedules: [bandSale, bandOpt] }));
  assert.equal(plan.selection.room, bandName);
  assert.equal(plan.requiredTotalWon, '700000000');
  assert.equal(plan.components[1].status, 'confirmed');
  assert.equal(plan.components[1].totalWon, '0');
  assert.equal(plan.undatedInstallments.length, 1);
});
