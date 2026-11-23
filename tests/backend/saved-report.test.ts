// 합성 자료로 실제 HTTP 진입점의 보고서 저장·읽기·PDF 권한과 고정 금액을 검사한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createHandler } from '../../src/server/handler.js';
import type { Backend } from '../../src/server/handler.js';
import type { ReportOperation } from '../../src/server/report-request.js';
import { projectSavedReport } from '../../src/server/saved-report.js';
import { reportExample } from '../../src/demo/planning.js';

const uuid = (n: number) => 'c0000000-0000-4000-8000-' + String(n).padStart(12, '0');
const aid = uuid(1),
  rid = uuid(2),
  snapshotId = uuid(3),
  reportId = uuid(4);
const result = JSON.parse(
  readFileSync(new URL('../../public/app/assets/comparison-example.json', import.meta.url), 'utf8'),
);
const stamp = '2026-11-10T00:00:05+00:00';
function raw() {
  return {
    contractVersion: 'report-snapshot/v1',
    reportId,
    analysisId: aid,
    runId: rid,
    snapshotId,
    version: 2,
    createdAt: stamp,
    queriedAt: stamp,
    rulesVersion: 'comparison/v1',
    dataOrigin: 'synthetic',
    sections: {
      comparison: {
        status: 'available',
        sources: ['applyhome_apt', 'apt_trade'],
        exportAllowed: true,
        value: structuredClone(result),
      },
      funding: { status: 'room_unselected', sources: [], exportAllowed: true, value: null },
      law: {
        status: 'available',
        sources: [],
        exportAllowed: true,
        value: {
          analysisId: aid,
          snapshotId,
          dataOrigin: 'synthetic',
          noticeDate: null,
          noticeSource: 'applyhome_apt',
          status: 'synthetic_input',
          reference: null,
        },
      },
    },
  };
}
function app(operation: (op: ReportOperation) => unknown, isAnonymous = false) {
  const handler = createHandler({
    env: {
      APP_ENV: 'development',
      SUPABASE_URL: 'https://synthetic.invalid',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC',
    },
    createBackend: () =>
      ({
        getUser: async () => ({ id: uuid(9), isAnonymous }),
        savedReport: async (op: ReportOperation) => operation(op),
      }) as unknown as Backend,
    log: () => {},
  });
  return (path: string, method = 'GET', body?: unknown, token = true) =>
    handler(
      new Request('https://example.invalid' + path, {
        method,
        headers: {
          ...(token ? { Authorization: 'Bearer SYNTHETIC' } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
}
const savePath = '/api/v1/analyses/' + aid + '/runs/' + rid + '/reports',
  detail = '/api/v1/reports/' + reportId;

test('S-07 projects the saved selection, per-room evidence and exact trade statistics on both display paths', () => {
  const original = raw();
  const table = original.sections.comparison.value.comparables[0].tradeStats.sale;
  Object.assign(table, {
    count: 2,
    smallSample: true,
    minWon: '515000000',
    medianWon: '515000000.5',
    maxWon: '515000001',
  });
  const report = projectSavedReport(original);
  assert.deepEqual(report, projectSavedReport(original, true));
  assert.deepEqual(
    report.sections.map((s) => s.id),
    ['notice', 'comparison', 'funding', 'law', 'news', 'commute', 'evidence'],
  );
  assert.equal(report.title, '합성 가람 아파트 084.0000A 분석 보고서');
  const list = report.sections[0].tables[0].rows;
  assert.deepEqual(list[0], ['101동 101호', '7억 원', '1,000만 원', '7억 1,000만 원']);
  assert.ok(list[1].includes('필수 옵션 금액을 확인할 수 없습니다.'));
  assert.ok(report.sections[1].tables[0].rows[0].includes('5억 1,500만 0.5원'));
  assert.ok(report.sections[6].rows.some((r) => r.value.includes('synthetic-v1 · 7쪽')));
  assert.equal(report.sections[2].state, 'held');
  assert.deepEqual(reportExample(result).sections[0].tables[0].rows, list);
});
test('S-07 restricted sources withhold names, figures and document references, keeping independent sections', () => {
  const r = raw();
  r.sections.comparison.exportAllowed = false;
  const display = projectSavedReport(r);
  assert.equal(display.sections[0].exportAllowed, false);
  assert.ok(display.title.includes('합성 가람'));
  const pdf = projectSavedReport(r, true);
  assert.equal(pdf.title, '청약 분석 보고서');
  assert.doesNotMatch(JSON.stringify(pdf), /합성 가람|710000000|7억|합성 비교|synthetic-v1|99999/);
  assert.equal(pdf.sections[4].state, 'reference');
  r.sections.comparison.status = 'source_restricted';
  assert.doesNotMatch(JSON.stringify(projectSavedReport(r)), /합성 가람|7억|synthetic-v1/);
});
test('S-07 preserves the selected room and separates same-day funding before and after the deposit', () => {
  const input = raw();
  const selection = { analysisId: aid, snapshotId, modelNo: '01', room: '101동 101호' };
  const evidence = [{ document: 'synthetic-notice-pdf', version: 'synthetic-v1', page: 4 }];
  const common = {
    modelNo: selection.modelNo,
    room: selection.room,
    houseType: '084.0000A',
    status: 'confirmed',
    reasons: [],
    evidence,
  };
  const funding = {
    ...selection,
    dataOrigin: 'synthetic',
    scheduleStatus: 'available',
    schedules: [
      {
        ...common,
        item: 'sale_price',
        totalWon: '100000000',
        installments: [
          {
            stage: 'deposit',
            won: '100000000',
            timing: { trigger: 'calendar_date', dateStatus: 'exact', date: '2026-11-12', evidence },
          },
        ],
      },
      { ...common, item: 'required_options', totalWon: '0', installments: [] },
    ],
    funds: [
      { id: uuid(61), kind: 'current', amountWon: '70000000', availableOn: '2026-11-10', certainty: 'confirmed' },
      {
        id: uuid(62),
        kind: 'additional',
        amountWon: '20000000',
        availableOn: '2026-11-12',
        certainty: 'confirmed',
      },
      {
        id: uuid(63),
        kind: 'additional',
        amountWon: '10000000',
        availableOn: '2026-11-12',
        certainty: 'expected',
      },
    ],
  };
  const record = {
    ...input,
    sections: {
      ...input.sections,
      funding: { status: 'available', value: funding, exportAllowed: true, sources: [] },
    },
  };
  const visible = projectSavedReport(record).sections.find((s) => s.id === 'funding')!;
  assert.deepEqual(
    projectSavedReport(record, true).sections.find((s) => s.id === 'funding'),
    visible,
  );
  assert.deepEqual(visible.tables.find((t) => t.headers.includes('입금 전 부족액'))?.rows, [
    ['2026-11-12', '1억 원', '확정 자금', '3,000만 원', '1,000만 원', '—'],
    ['2026-11-12', '1억 원', '예상 자금 포함', '3,000만 원', '0원', '—'],
  ]);
  assert.ok(visible.rows.some((r) => r.value === selection.room));
});
test('S-07 preserves only checked zero and never counts failed or partial data as a verified empty region', () => {
  const r = raw();
  const c = r.sections.comparison.value;
  c.completeness = 'partial';
  c.rankingComplete = false;
  c.appliedScope = 'priority';
  c.tradeKinds.sale = { conclusion: 'normal_zero', collectionStatus: 'partial', unresolvedRows: 1 };
  c.tradeKinds.presale_right = { conclusion: 'normal_zero', collectionStatus: 'complete', unresolvedRows: 0 };
  c.holds = [{ reasonCode: 'collection_incomplete' }];
  c.exclusions = [{ reasonCode: 'cancelled_trade' }];
  const p = projectSavedReport(r);
  assert.ok(p.sections[1].notes.some((x) => x.includes('분양권') && x.includes('0건')));
  assert.ok(!p.sections[1].notes.some((x) => x.includes('매매') && x.includes('0건')));
  assert.deepEqual(p.sections[6].tables.at(-1)?.rows, [
    ['일부 수집 자료가 도착하지 않았습니다.', '1'],
    ['해제 거래 제외', '1'],
  ]);
});
test('S-07 authenticates every report operation and accepts only IDs from the caller', async () => {
  const seen: ReportOperation[] = [];
  const http = app((op) => {
    seen.push(op);
    return raw();
  });
  assert.equal((await http(savePath, 'POST', { requestId: uuid(8) }, false)).status, 401);
  assert.equal((await app(() => assert.fail('anonymous'), true)(detail + '/pdf')).status, 401);
  for (const body of [{}, { requestId: 'x' }, { requestId: uuid(8), result: {} }])
    assert.equal((await http(savePath, 'POST', body)).status, 400);
  assert.equal((await http(detail + '?user=' + uuid(8))).status, 400);
  assert.equal((await http('/api/v1/reports?before=x')).status, 400);
  assert.equal((await http(detail, 'DELETE', { unconfirmed: true })).status, 400);
  assert.equal(seen.length, 0);
  const saved = await http(savePath, 'POST', { requestId: uuid(8) });
  assert.equal(saved.status, 201);
  assert.equal(saved.headers.get('Location'), detail);
  assert.equal(saved.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await saved.json(), await (await http(detail)).json());
  assert.deepEqual(seen, [
    { action: 'save', analysisId: aid, runId: rid, requestId: uuid(8) },
    { action: 'read', reportId },
  ]);
  const pdf = await http(detail + '/pdf');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('Content-Type'), 'application/pdf');
  assert.match(pdf.headers.get('Content-Disposition') ?? '', /^attachment;/);
  assert.equal(
    Buffer.from(await pdf.arrayBuffer())
      .subarray(0, 5)
      .toString(),
    '%PDF-',
  );
  assert.deepEqual(seen.at(-1), { action: 'export', reportId });
  assert.equal((await http(detail, 'DELETE')).status, 204);
  assert.deepEqual(seen.at(-1), { action: 'delete', reportId });
});
test('S-07 rejects mismatched IDs and projects only owner list metadata in chronological pagination', async () => {
  const bad = app(() => ({ ...raw(), reportId: uuid(98) }));
  assert.equal((await bad(detail)).status, 503);
  const wrongRun = app(() => ({ ...raw(), runId: uuid(98) }));
  assert.equal((await wrongRun(savePath, 'POST', { requestId: uuid(8) })).status, 503);
  const row = {
    reportId,
    analysisId: aid,
    runId: rid,
    version: 1,
    createdAt: stamp,
    dataOrigin: 'synthetic',
    title: '합성 가람',
    privateNotes: 'SYNTHETIC_PRIVATE',
  };
  const list = await app((op) => {
    assert.deepEqual(op, { action: 'list', before: uuid(99) });
    return { reports: [row], nextCursor: reportId };
  })('/api/v1/reports?before=' + uuid(99));
  assert.equal(list.status, 200);
  assert.doesNotMatch(await list.text(), /SYNTHETIC_PRIVATE/);
});
