// Python 수집기가 출력한 실제 기록을 화면팀이 쓰는 BE-01 JSON Schema로 확인한다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const bundle = read('tests/fixtures/ingestion-v0.json');
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(read('docs/api/analysis-result-v0.schema.json'), 'analysis');
const validate = ajv.getSchema('analysis#/definitions/collectionRecord');

function runCli(t, edit, encode = JSON.stringify) {
  const input = structuredClone(bundle);
  if (edit) edit(input);
  const folder = mkdtempSync(join(tmpdir(), 'homecierge-replay-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'synthetic.json');
  writeFileSync(path, encode(input));
  return spawnSync('python3', ['scripts/replay_ingestion.py', path], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONUTF8: '1' },
  });
}

function replay(t, edit, encode) {
  const proc = runCli(t, edit, encode);
  assert.equal(proc.status, 0, proc.stderr);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.contractVersion, 'ingestion/v0');
  assert.equal(result.dataOrigin, 'synthetic');
  for (const { record } of result.tradeBatches) {
    assert.ok(validate(record), JSON.stringify(validate.errors));
  }
  return result;
}

test('a notice, its housing model, and two trade sources are read under the same request', (t) => {
  const result = replay(t);
  assert.deepEqual(result.catalogCollections.map(c => [c.source, c.status, c.rowsReceived]), [
    ['applyhome_apt', 'complete', 1], ['applyhome_apt_model', 'complete', 1],
  ]);
  const [sale, rights] = result.tradeBatches;
  assert.deepEqual(result.tradeBatches.map(b => [b.record.status, b.record.pagesExpected, b.trades.length]), [
    ['complete', 2, 3], ['complete', 1, 2],
  ]);
  assert.deepEqual(sale.record.tradeKinds, ['sale']);
  assert.deepEqual(rights.record.tradeKinds, ['presale_right', 'occupancy_right']);
  assert.equal(sale.record.requestRegionCode, '99999');
  assert.deepEqual(sale.trades.map(t => [t.contractDate.date, t.amount.won, t.disposition, t.exclusionReason]), [
    ['2026-10-20', '515000000', 'follow_up_required', null],
    ['2026-10-21', '515000000', 'excluded', 'cancelled_trade'],
    ['2026-10-09', '515000000', 'excluded', 'outside_contract_period'],
  ]);
  assert.deepEqual(rights.trades.map(t => [t.tradeKind, t.exclusiveArea.m2, t.supplyArea.m2]), [
    ['presale_right', '84.50', null], ['occupancy_right', '84.50', null],
  ]);
});

test('the model maximum, checked room subtotal, and an unverified option stay distinct', (t) => {
  const { catalog } = replay(t);
  const [model] = catalog.housingTypes;
  assert.equal(model.topAmount.won, '750000000');
  assert.equal(model.supplyArea.m2, '112.40');
  assert.deepEqual(catalog.rooms.map(r => [r.room, r.salePrice.won, r.requiredOptions.won, r.subtotal.won]), [
    ['101동 101호', '700000000', '10000000', '710000000'],
    ['101동 102호', '720000000', null, null],
  ]);
  assert.deepEqual([model.subtotalRange.min, model.subtotalRange.max], ['710000000', '710000000']);
  assert.deepEqual(catalog.rooms[0].requiredOptions.evidence.map(e => [e.document, e.version, e.page]), [
    ['synthetic-notice-pdf', 'synthetic-v1', 8],
  ]);
  assert.equal(model.checkedSupplyArea.status, 'confirmed');
  assert.ok(model.checkedSupplyArea.evidence.some(e => e.page === 4));
});

test('source JSON numeric areas retain their decimal digits through the CLI', (t) => {
  const result = replay(t, undefined, input => JSON.stringify(input)
    .replace('"112.40"', '112.400000000000000001')
    .replace('"84.00"', '84.000000000000000001'));
  assert.equal(result.catalog.housingTypes[0].supplyArea.m2, '112.400000000000000001');
  assert.equal(result.tradeBatches[0].trades[0].exclusiveArea.m2, '84.000000000000000001');
  assert.equal(result.catalog.housingTypes[0].checkedSupplyArea.status, 'conflict');
  assert.equal(result.catalog.rooms[0].subtotal.status, 'confirmed');
});

test('a missing sale page and an HTTP-200 rights error produce separate partial and failed records', (t) => {
  const result = replay(t, input => {
    input.pages = input.pages.filter(p => !(p.source === 'apt_trade' && p.page === 2));
    input.pages.find(p => p.source === 'apt_rights').body = {
      response: { header: { resultCode: '30', resultMsg: 'SYNTHETIC_PROVIDER_DETAIL' } },
    };
  });
  const [sale, rights] = result.tradeBatches;
  assert.deepEqual([sale.record.status, sale.record.missingPages, sale.trades.length], ['partial', [2], 2]);
  assert.deepEqual([rights.record.status, rights.record.error.layer, rights.trades.length], ['failed', 'business', 0]);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PROVIDER_DETAIL'));
});

test('a verified empty source page remains an empty collection for this scope', (t) => {
  const result = replay(t, input => {
    input.request.tradeKinds = ['occupancy_right'];
    input.pages = input.pages.filter(p => p.source !== 'apt_trade');
    const body = input.pages.find(p => p.source === 'apt_rights').body.response.body;
    Object.assign(body, { totalCount: 0, items: { item: [] } });
  });
  assert.equal(result.tradeBatches.length, 1);
  const [{ record, trades }] = result.tradeBatches;
  assert.deepEqual([record.status, record.reportedTotalCount, trades.length], ['empty', 0, 0]);
  assert.equal(result.regionScopes, undefined);
});

test('a rolling year requests each covered contract month once per API region', (t) => {
  const result = replay(t, input => {
    delete input.request.start;
    delete input.request.end;
    input.request.tradeKinds = ['sale'];
    input.request.requestRegionCodes.push('99998');
  });
  assert.deepEqual([result.period.start, result.period.end], ['2025-11-11', '2026-11-10']);
  const keys = result.tradeBatches.map(({ record }) => record.requestRegionCode + '/' + record.month);
  assert.equal(keys.length, 26);
  assert.equal(new Set(keys).size, 26);
  assert.ok(keys.includes('99998/2026-11') && keys.includes('99999/2025-11'));
  assert.equal(result.tradeBatches.filter(b => b.record.status === 'complete').length, 1);
  assert.equal(result.tradeBatches.filter(b => b.record.status === 'failed').length, 25);
});

test('an undecided leap-day window still returns the independently collected notice', (t) => {
  const result = replay(t, input => {
    input.request.asOf = '2028-02-29';
    delete input.request.start;
    delete input.request.end;
  });
  assert.equal(result.period.status, 'decision_required');
  assert.deepEqual(result.tradeBatches, []);
  assert.deepEqual(result.catalogCollections.map(c => c.status), ['complete', 'complete']);
});

test('invalid request scope and a non-synthetic replay end with a CLI input error', (t) => {
  for (const edit of [
    input => { input.dataOrigin = 'collected'; },
    input => { input.request.requestRegionCodes = ['9999900000']; },
    input => { input.request.target.edition = 1.5; },
    input => { input.request.end = '2026-11-11'; },
  ]) {
    const proc = runCli(t, edit);
    assert.equal(proc.status, 2);
    assert.equal(proc.stdout, '');
    assert.match(proc.stderr, /재생 입력 오류/);
  }
});
