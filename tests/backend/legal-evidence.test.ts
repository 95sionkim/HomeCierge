// 합성 사용자와 응답으로 화면이 요청한 공고의 과거 판본만 공개되는지 검사한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createHandler } from '../../src/server/handler.js';
import { createBackend } from '../../src/server/supabase.js';
import { readLegalEvidence } from '../../src/server/legal-evidence.js';

const analysisId = 'a1000000-0000-4000-8000-000000000001';
const snapshotId = 'a1000000-0000-4000-8000-000000000002';
const path = `https://api.invalid/api/v1/analyses/${analysisId}/snapshots/${snapshotId}/legal-evidence`;
const env = { APP_ENV: 'development', SUPABASE_URL: 'https://synthetic.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC', ALLOWED_ORIGINS: 'https://screen.invalid' };
const auth = { Authorization: 'Bearer SYNTHETIC_TEST', Origin: env.ALLOWED_ORIGINS };
const article = { number: '21', branch: '2', heading: '합성 모집공고' };
const reference = { contractVersion: 'law-reference/v1', dataOrigin: 'collected', asOf: '2024-02-29',
  observedAt: '2024-02-28T15:05:00Z', title: '주택공급에 관한 규칙', lawId: '000001', mst: '123456789012345678',
  promulgatedOn: '2023-12-15', effectiveOn: '2024-01-01', articles: [article] };
const context = { analysisId, snapshotId, dataOrigin: 'collected', noticeSource: 'applyhome_remainder',
  noticeDate: reference.asOf, status: 'available', reference };

function connect(t: TestContext, response: () => Response, anonymous = false) {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, env.SUPABASE_URL);
    assert.equal(request.headers.get('Authorization'), auth.Authorization);
    assert.equal(request.headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY);
    calls.push(url.pathname);
    if (url.pathname === '/auth/v1/user') return Response.json({ id: 'synthetic-user', is_anonymous: anonymous });
    assert.equal(url.pathname, '/rest/v1/rpc/read_analysis_legal_evidence');
    assert.deepEqual(await request.json(), { p_analysis_id: analysisId, p_snapshot_id: snapshotId });
    return response();
  });
  return { handle: createHandler({ env, createBackend, log() {} }), calls };
}

test('past notice uses its verified version and preserves official identifiers, dates and separate applicability checks', async t => {
  const { handle } = connect(t, () => Response.json({ ...context, reference: { ...reference, raw: 'private' } }));
  const res = await handle(new Request(path, { headers: auth }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(res.headers.get('Vercel-CDN-Cache-Control'), 'no-store');
  const body = await res.json();
  assert.equal(body.contractVersion, 'legal-evidence/v1');
  assert.equal(body.noticeDate, reference.asOf);
  assert.equal(body.reference.lawId, reference.lawId);
  assert.equal(body.reference.articles[0].label, '제21조의2');
  assert.equal(body.reference.sourceUrl, 'https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=123456789012345678&efYd=20240101');
  assert.equal(body.reference.raw, undefined);
  assert.equal(body.personalEligibility, 'not_assessed');
  assert.equal(body.transitionalProvisions, 'requires_review');
  assert.equal(body.exceptions, 'requires_review');
});

test('held dates and sources retain a next action without attaching a law version', () => {
  for (const [status, noticeDate, dataOrigin] of [
    ['selection_unverified', null, 'collected'], ['notice_date_unverified', null, 'collected'],
    ['version_unverified', reference.asOf, 'collected'], ['source_restricted', null, 'collected'],
    ['source_restricted', reference.asOf, 'collected'], ['synthetic_input', null, 'synthetic'],
  ]) {
    const result = readLegalEvidence({ ...context, reference: null, status, noticeDate, dataOrigin }, analysisId, snapshotId);
    assert.equal(result.status, status);
    assert.equal(result.reference, null);
    assert.ok(result.nextActions.length);
  }
});

test('future or invalid dates, another snapshot, duplicate provisions and inconsistent statuses fail closed', () => {
  const invalid = [
    { ...context, dataOrigin: 'synthetic' }, { ...context, analysisId: snapshotId }, { ...context, snapshotId: analysisId },
    { ...context, status: 'source_restricted' }, { ...context, status: 'version_unverified', noticeDate: null, reference: null },
    { ...context, status: 'notice_date_unverified', reference: null },
    ...[ { mst: 'x/1' }, { lawId: 1 }, { asOf: '2024-03-01' }, { promulgatedOn: '2024-03-01' },
      { effectiveOn: '2024-03-01' }, { effectiveOn: '2023-02-29' }, { observedAt: '2024-02-28T14:59:59Z' },
      { observedAt: '2024-02-30T00:00:00Z' }, { articles: [] }, { articles: [article, article] },
      { articles: [{ ...article, branch: '0' }] }, { articles: [{ ...article, heading: 'https://private.invalid' }] },
      { articles: [{ ...article, heading: 'OC=synthetic' }] }, { title: '다른 규칙' } ]
      .map(change => ({ ...context, reference: { ...reference, ...change } })),
  ];
  for (const value of invalid) assert.throws(() => readLegalEvidence(value, analysisId, snapshotId), /invalid_legal_evidence/);
});

test('only the owner-selected analysis and capture are accepted; the client cannot override the date', async t => {
  const { handle, calls } = connect(t, () => { throw new Error('unexpected RPC'); });
  const preflight = await handle(new Request(path, { method: 'OPTIONS', headers: { Origin: env.ALLOWED_ORIGINS } }));
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.equal((await handle(new Request(path))).status, 401);
  assert.equal((await handle(new Request(path, { method: 'POST', headers: auth }))).status, 405);
  for (const url of [path + '?asOf=2030-01-01', path.replace(analysisId, 'invalid'), path.replace(snapshotId, 'invalid')]) {
    assert.equal((await handle(new Request(url, { headers: auth }))).status, 400);
  }
  assert.ok(calls.every(p => p === '/auth/v1/user'));
});

test('another owner, denied session or upstream failure returns only the public HTTP error', async t => {
  let response: Response;
  const { handle } = connect(t, () => response);
  for (const [payload, status, code] of [
    [{ code: 'PT404', message: 'private' }, 404, 'legal_evidence_not_found'],
    [{ code: '42501', message: 'legal_authentication_required' }, 403, 'authentication_required'],
    [{ code: 'XX000', message: 'private' }, 500, 'backend_unavailable'],
    [{ ...context, snapshotId: analysisId }, 200, 'backend_unavailable'],
  ] as const) {
    response = Response.json(payload, { status });
    const res = await handle(new Request(path, { headers: auth }));
    const body = await res.json();
    assert.equal(body.error, code);
    assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId']);
  }
});
