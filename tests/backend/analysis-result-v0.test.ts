// 분석 결과 계약 v0의 기계 판독 검사(독립 QA). 계약의 합성 예시와 이 파일의 합성 모순 사례만 사용하며
// 네트워크·실제 계정·인증값을 쓰지 않는다. 검사 대상은 제품 불변 조건이다: 같은 요청의 정상 0개·부분 수집·조회 실패
// 구분, 미수집 시 확대 보류, 실행 상태와 결과 완전성의 분리, 단위·근거·보류·다음 행동, 스키마 밖 교차 참조.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import formats from 'ajv-formats';

// 합성 사례를 자유롭게 편집하기 위한 테스트 전용 형식.
type Json = any;
const load = (path: string): Json => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const schema = load('../../docs/api/analysis-result-v0.schema.json');
const fixture = load('../fixtures/analysis-result-v0.json');
const NAMES = ['normalZero', 'partialCollection', 'upstreamFailure'] as const;
type Name = (typeof NAMES)[number];

// 대체 컴파일 경로를 두지 않는다. strict 검사(알 수 없는 키워드·형식, 타입·required 누락)나 형식 검사 실패는
// 이 파일 전체의 실패로 드러난다.
const ajv = new Ajv({ allErrors: true, strict: true });
formats.default(ajv);
ajv.addSchema(schema, 'contract');
const validate = ajv.getSchema('contract')!;
const errorsOf = (value: Json) =>
  validate(value) ? [] : (validate.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message}`);

const UNRESOLVED = ['unverified', 'partially_collected', 'lookup_failed', 'conflict', 'decision_required'];
const sample = (name: Name): Json => structuredClone(fixture[name]);
const priorityTrade = (s: Json) =>
  s.result.items.find((i: Json) => i.subject === 'trade_kind_scope' && i.scope.regionRole === 'priority');
const notProduced = (s: Json) =>
  Object.assign(s.result, { completeness: 'not_produced', regionScopes: null, items: null, collections: null });
const asNormalZeroScope = (scope: Json) => Object.assign(scope, {
  conclusion: 'normal_zero', blockingItemIds: [], screening: { ...scope.screening, status: 'complete', unresolvedRows: 0 },
});

function assertRejected(base: Name, cases: Record<string, (s: Json) => void>) {
  assert.deepEqual(errorsOf(sample(base)), [], `${base}: 기준 예시가 유효해야 모순 사례의 거부가 의미 있다`);
  for (const [label, edit] of Object.entries(cases)) {
    const value = sample(base);
    edit(value);
    assert.equal(validate(value), false, `${base} → ${label}: 모순 사례가 스키마를 통과함`);
  }
}

test('schema is draft-07 and the fixture holds exactly three valid synthetic samples', () => {
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.deepEqual(Object.keys(fixture).sort(), [...NAMES].sort());
  for (const name of NAMES) {
    assert.equal(fixture[name].dataOrigin, 'synthetic', `${name}: 합성 예시 표시`);
    assert.deepEqual(errorsOf(fixture[name]), [], name);
  }
});

test('one request yields three distinguishable results instead of one empty list', () => {
  const [zero, partial, failure] = NAMES.map(name => fixture[name]);
  for (const s of [partial, failure]) {
    assert.deepEqual(s.input, zero.input, '같은 요청 조건');
    assert.equal(s.run.analysisId, zero.run.analysisId, '같은 분석');
  }
  // 실행 종료(finished)는 성공을 뜻하지 않는다. 결과 완전성은 별도 축이다.
  assert.deepEqual(NAMES.map(n => fixture[n].run.status), ['finished', 'finished', 'finished']);
  assert.deepEqual(NAMES.map(n => fixture[n].result.completeness), ['complete', 'partial', 'unavailable']);

  // 정상 0개(A-05): 우선 지역의 필요한 수집·판별이 끝나 0개가 확정됐고 같은 구로 확대했다.
  const zeroScopes = zero.result.regionScopes;
  assert.equal(zeroScopes.priority.conclusion, 'normal_zero');
  assert.equal(zeroScopes.priority.collection.status, 'complete');
  assert.equal(zeroScopes.priority.screening.status, 'complete');
  assert.notEqual(zeroScopes.expansion, null, '정상 0개이면 확대 범위 판정을 둔다');
  assert.equal(zero.input.regions.expansion.status, 'confirmed', '확대 지역은 확인된 경우만 사용');
  assert.deepEqual(zero.result.items.filter((i: Json) => UNRESOLVED.includes(i.judgment)), []);

  // 부분 수집·조회 실패는 후보 0개여도 정상 0개가 아니며 우선 지역에서 보류하고 확대하지 않는다(A-06·A-10).
  for (const [label, s] of [['partialCollection', partial], ['upstreamFailure', failure]] as const) {
    const priority = s.result.regionScopes.priority;
    assert.equal(priority.confirmedCandidateCount, 0, label);
    assert.equal(priority.conclusion, 'held', label);
    assert.equal(s.result.regionScopes.expansion, null, `${label}: 자동 확대 금지`);
    const blocking = priorityTrade(s);
    assert.deepEqual(priority.blockingItemIds, [blocking.itemId], `${label}: 보류 항목 연결`);
    assert.equal(blocking.retryable, true, label);
    assert.ok(blocking.reasons.length > 0 && blocking.nextActions.length > 0, `${label}: 사유·다음 행동`);
  }
  assert.equal(priorityTrade(partial).judgment, 'partially_collected');
  assert.ok(priorityTrade(partial).reasons.some((r: Json) => r.code === 'collection_page_missing'));
  assert.ok(partial.result.collections.some((c: Json) => c.status === 'partial' && c.missingPages.length > 0));
  assert.equal(priorityTrade(failure).judgment, 'lookup_failed');
  assert.ok(priorityTrade(failure).reasons.some((r: Json) => r.code === 'collection_request_failed'));
  assert.ok(failure.result.collections.every((c: Json) => c.status === 'failed' && c.error));
});

// draft-07은 다른 위치의 식별자·필드 값을 서로 비교하지 못한다. 예시가 그 연결 조건을 지키는지 확인한다.
test('scope conclusions resolve to consistent collection records, screening and unresolved items', () => {
  for (const name of NAMES) {
    const { result } = fixture[name];
    const records = new Map<string, Json>(result.collections.map((c: Json) => [c.recordId, c]));
    const items = new Map<string, Json>(result.items.map((i: Json) => [i.itemId, i]));
    assert.equal(records.size, result.collections.length, '수집 기록 식별자는 유일하다');
    assert.equal(items.size, result.items.length, '항목 식별자는 유일하다');
    for (const record of result.collections) {
      const label = `${name}/${record.recordId}`;
      if (record.status === 'complete') assert.equal(record.rowsReceived, record.reportedTotalCount, `${label}: 완료는 보고 건수 전부 수신`);
      if (record.status === 'partial') {
        assert.ok(record.missingPages.every((p: number) => p <= record.pagesExpected), `${label}: 누락 페이지는 기대 범위 안`);
      }
    }
    for (const [role, scope] of Object.entries(result.regionScopes) as [string, Json][]) {
      if (!scope) continue;
      const label = `${name}/${role}`;
      const linked: Json[] = scope.collection.recordIds.map((id: string) => records.get(id));
      assert.ok(linked.every(Boolean), `${label}: 판정 근거 수집 기록이 결과에 존재`);
      const statuses = new Set(linked.map(r => r.status));
      let expected = 'partial';
      if (linked.length === 0) expected = 'not_started';
      else if (linked.every(r => r.status === 'complete' || r.status === 'empty')) expected = 'complete';
      else if (statuses.size === 1 && statuses.has('failed')) expected = 'failed';
      assert.equal(scope.collection.status, expected, `${label}: 범위 수집 상태와 기록 상태 일치`);
      const scoped = result.items.filter((i: Json) => i.scope.regionRole === role);
      const candidates = scoped.filter((i: Json) => i.subject === 'candidate' && i.judgment === 'confirmed');
      assert.equal(scope.confirmedCandidateCount, new Set(candidates.map((i: Json) => i.scope.candidateId)).size);
      if (scope.conclusion === 'normal_zero') {
        assert.deepEqual(scoped.filter((i: Json) => UNRESOLVED.includes(i.judgment)), [], `${label}: 정상 0개 범위에 미해결 없음`);
      }
      assert.ok(scope.blockingItemIds.every((id: string) => {
        const item = items.get(id);
        return item && UNRESOLVED.includes(item.judgment) && (item.scope.regionRole === role || item.scope.regionRole === null);
      }), `${label}: 보류 항목은 이 지역 또는 분석 전체에 영향을 준다`);
    }
    for (const item of result.items) {
      for (const ref of item.evidenceRefs) {
        if (ref.type === 'collection_record') assert.ok(records.has(ref.id), `${name}/${item.itemId}: 근거 기록 ${ref.id}`);
        if (ref.type === 'screening') assert.ok(result.regionScopes[ref.id], `${name}/${item.itemId}: 근거 판별 범위 ${ref.id}`);
      }
      if (item.judgment === 'normal_zero') {
        assert.ok(item.evidenceRefs.filter((r: Json) => r.type === 'collection_record')
          .every((r: Json) => ['complete', 'empty'].includes(records.get(r.id)?.status)), `${name}/${item.itemId}: 정상 0 근거는 완료 기록`);
      }
    }
  }
});

test('partial collection cannot be declared normal zero, complete, or trigger automatic expansion', () => {
  const zeroScopes = fixture.normalZero.result.regionScopes;
  assertRejected('normalZero', {
    'partial record inside a complete normal-zero result': s => { s.result.collections = structuredClone(fixture.partialCollection.result.collections); },
    'failed record inside a complete normal-zero result': s => { s.result.collections = structuredClone(fixture.upstreamFailure.result.collections); },
    'unresolved candidate while priority claims normal zero': s => { s.result.regionScopes.priority.unresolvedCandidateCount = 1; },
    'unresolved screening rows while priority claims normal zero': s => { s.result.regionScopes.priority.screening.unresolvedRows = 1; },
    'normal zero without expansion judgment': s => {
      s.result.regionScopes.expansion = null;
      s.result.items = s.result.items.filter((i: Json) => i.scope.regionRole !== 'expansion');
    },
    'expansion used although expansion region is unverified': s => {
      Object.assign(s.input.regions.expansion, { status: 'unverified', id: null, level: null, name: null, evidenceRefs: [] });
    },
  });
  assertRejected('partialCollection', {
    'priority relabelled normal zero while collection is partial': s => {
      asNormalZeroScope(s.result.regionScopes.priority);
      s.result.regionScopes.expansion = structuredClone(zeroScopes.expansion);
    },
    'trade item relabelled normal zero while collection is partial': s => {
      Object.assign(priorityTrade(s), { judgment: 'normal_zero', retryable: null, reasons: [], nextActions: [] });
    },
    'result marked complete while a page is missing': s => { s.result.completeness = 'complete'; },
    'automatic expansion while priority is held': s => { s.result.regionScopes.expansion = structuredClone(zeroScopes.expansion); },
    'screening marked complete while collection is partial': s => { s.result.regionScopes.priority.screening.status = 'complete'; },
    'collection record hides its missing page as complete': s => Object.assign(s.result.collections[0], { status: 'complete', error: null }),
  });
});

test('partial results can retain a verified candidate while page or row counts are inconsistent', () => {
  const candidate = structuredClone(fixture.normalZero.result.items.find((i: Json) => i.subject === 'candidate'));
  candidate.scope.regionRole = 'priority';
  for (const [rowsReceived, code] of [
    [12, 'collection_row_count_mismatch'], [16, 'collection_row_count_mismatch'], [14, 'collection_page_inconsistent'],
  ] as const) {
    const s = sample('partialCollection');
    Object.assign(s.result.collections[0], { missingPages: [], rowsReceived, error: null });
    Object.assign(s.result.regionScopes.priority, { conclusion: 'candidates_found', confirmedCandidateCount: 1 });
    s.result.regionScopes.priority.screening.rowsInScope = 4;
    priorityTrade(s).reasons = [{ code }];
    s.result.items.push(candidate);
    assert.deepEqual(errorsOf(s), [], `목록에는 확인된 단지를 보존한다 (${code}, ${rowsReceived}/14행)`);
    assert.equal(s.result.regionScopes.expansion, null);
  }
});

test('upstream failure cannot present completeness, screening results or normal zero', () => {
  assertRejected('upstreamFailure', {
    'confirmed candidate without usable comparison data': s => {
      const candidate = structuredClone(fixture.normalZero.result.items.find((i: Json) => i.subject === 'candidate'));
      candidate.scope.regionRole = 'priority';
      s.result.items.push(candidate);
    },
    'marked complete': s => { s.result.completeness = 'complete'; },
    'marked partial without any screening': s => { s.result.completeness = 'partial'; },
    'failed lookup relabelled normal zero': s => {
      asNormalZeroScope(s.result.regionScopes.priority);
      s.result.regionScopes.expansion = structuredClone(fixture.normalZero.result.regionScopes.expansion);
    },
    'screening counts reported although screening never started': s => {
      Object.assign(s.result.regionScopes.priority.screening, { rowsInScope: 0, unresolvedRows: 0 });
    },
    'lookup_failed item without evidence': s => { priorityTrade(s).evidenceRefs = []; },
    'failed record without error summary': s => { s.result.collections[0].error = null; },
    'upstream error carrying raw message or request URL': s => {
      s.result.collections[0].error.message = 'synthetic raw echo serviceKey=SYNTHETIC';
    },
  });
});

test('upstream error layer matches its code so HTTP-200 business errors stay distinct', () => {
  assertRejected('upstreamFailure', {
    'business error reported as an HTTP failure': s => { s.result.collections[0].error = { code: 'upstream_business_error', layer: 'http' }; },
    'timeout reported as a business error': s => { s.result.collections[0].error = { code: 'upstream_timeout', layer: 'business' }; },
    'malformed response reported as a network failure': s => { s.result.collections[0].error = { code: 'upstream_malformed_response', layer: 'network' }; },
  });
});

test('run state and result completeness are separate axes', () => {
  const running = sample('normalZero');
  Object.assign(running.run, { status: 'running', finishedAt: null });
  notProduced(running);
  assert.deepEqual(errorsOf(running), [], '진행 중 실행은 산출 전 결과(null)로 표현한다');
  const failed = sample('normalZero');
  Object.assign(failed.run, { status: 'failed', error: { code: 'run_internal_error' } });
  notProduced(failed);
  assert.deepEqual(errorsOf(failed), [], '실행 실패는 결과 없이 실행 오류로 표현한다');

  assertRejected('normalZero', {
    'running run with a complete result': s => Object.assign(s.run, { status: 'running', finishedAt: null }),
    'queued run with a complete result': s => Object.assign(s.run, { status: 'queued', finishedAt: null }),
    'finished run without a produced result': s => notProduced(s),
    'finished run carrying a run error': s => { s.run.error = { code: 'run_internal_error' }; },
    'failed run without run error': s => { s.run.status = 'failed'; notProduced(s); },
    'failed run with a partial result': s => {
      Object.assign(s.run, { status: 'failed', error: { code: 'run_internal_error' } });
      s.result.completeness = 'partial';
    },
    'not produced result using empty lists instead of null': s => {
      Object.assign(s.run, { status: 'running', finishedAt: null });
      notProduced(s);
      Object.assign(s.result, { items: [], collections: [] });
    },
  });
});

test('area units, input facts, evidence and next actions are machine-checked', () => {
  const unverifiedArea = (s: Json) => {
    s.input.housingType.supplyArea = { status: 'unverified', area: null, evidenceRefs: [] };
    s.input.supplyAreaRange = null;
  };
  assertRejected('normalZero', {
    'exclusive area supplied as the target supply area': s => { s.input.housingType.supplyArea.area.basis = 'exclusive'; },
    'exclusive area used as a supply range bound': s => { s.input.supplyAreaRange.min.basis = 'exclusive'; },
    'supply area as JSON number': s => { s.input.housingType.supplyArea.area.m2 = 112.4; },
    'supply area with decimal comma': s => { s.input.housingType.supplyArea.area.m2 = '112,40'; },
    'default supply range other than ±5%': s => { s.input.supplyAreaRange.lowerRatio = '0.90'; },
    'confirmed supply area without value': s => { s.input.housingType.supplyArea.area = null; },
    'confirmed supply area without evidence': s => { s.input.housingType.supplyArea.evidenceRefs = []; },
    'unverified supply area with a complete comparison (A-11)': unverifiedArea,
    'unverified priority region with a complete comparison': s => {
      Object.assign(s.input.regions.priority, { status: 'unverified', id: null, level: null, name: null, evidenceRefs: [] });
    },
    'priority region at gu level': s => { s.input.regions.priority.level = 'gu'; },
    'normal-zero item without collection evidence': s => {
      priorityTrade(s).evidenceRefs = priorityTrade(s).evidenceRefs.filter((r: Json) => r.type !== 'collection_record');
    },
    'normal-zero item without screening evidence': s => {
      priorityTrade(s).evidenceRefs = priorityTrade(s).evidenceRefs.filter((r: Json) => r.type !== 'screening');
    },
  });
  const held = sample('normalZero');
  unverifiedArea(held);
  notProduced(held);
  Object.assign(held.result, {
    completeness: 'unavailable', collections: [],
    regionScopes: { priority: { conclusion: 'held', confirmedCandidateCount: 0, unresolvedCandidateCount: 0,
      collection: { status: 'not_started', recordIds: [] },
      screening: { status: 'not_started', rowsInScope: null, unresolvedRows: null, exclusions: [] },
      blockingItemIds: ['item-target-supply-area'] }, expansion: null },
    items: [{ itemId: 'item-target-supply-area', subject: 'target_supply_area',
      scope: { regionRole: null, tradeKind: null, candidateId: null }, judgment: 'unverified', retryable: false,
      reasons: [{ code: 'supply_area_correspondence_missing' }],
      nextActions: [{ action: 'obtain_supply_area_evidence', actor: 'operator' }], evidenceRefs: [] }],
  });
  assert.deepEqual(errorsOf(held), [], '공급면적 미확인은 비교 없이 근거 필요·다음 행동으로 보류한다');
  assertRejected('partialCollection', {
    'unresolved item without next action': s => { priorityTrade(s).nextActions = []; },
    'unresolved item without reason': s => { priorityTrade(s).reasons = []; },
    'unresolved item without retryability': s => { priorityTrade(s).retryable = null; },
    'partially collected item without collection evidence': s => {
      priorityTrade(s).evidenceRefs = priorityTrade(s).evidenceRefs.filter((r: Json) => r.type !== 'collection_record');
    },
  });
});

test('shared won format is an integer decimal string without separators or units', () => {
  const won = ajv.getSchema('contract#/definitions/won')!;
  for (const value of ['0', '480000000']) assert.equal(won(value), true, value);
  for (const value of [480000000, '480,000,000', '48000만', '0480', '4.8e8', '480000000.0', '-1']) {
    assert.equal(won(value), false, String(value));
  }
});

test('date and timestamp formats reject impossible calendar values', () => {
  const leap = sample('normalZero');
  leap.input.basisDate = '2028-02-29';
  assert.deepEqual(errorsOf(leap), [], '윤년 2월 29일은 유효');
  assertRejected('normalZero', {
    'February 30 basis date': s => { s.input.basisDate = '2026-02-30'; },
    'non-leap February 29 contract end': s => { s.input.contractDateRange.end = '2027-02-29'; },
    'November 31 contract start': s => { s.input.contractDateRange.start = '2025-11-31'; },
    'February 30 timestamp': s => { s.run.requestedAt = '2026-02-30T09:00:00+09:00'; },
    'timestamp without offset': s => { s.run.requestedAt = '2026-11-10T09:00:00'; },
  });
});
