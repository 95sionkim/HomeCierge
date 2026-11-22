// 합성 계정으로 HTTP 핸들러와 SDK를 연결해 요청한 호실만 재조회하는지 확인한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createHandler } from '../../src/server/handler.js';
import { createBackend } from '../../src/server/supabase.js';

const env = {
  APP_ENV: 'development', SUPABASE_URL: 'https://synthetic.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC_PUBLIC_TEST', ALLOWED_ORIGINS: 'https://screen.invalid',
};
const analysisId = 'a1100000-0000-4000-8000-000000000001';
const snapshotId = 'a1100000-0000-4000-8000-000000000002';
const selection = { snapshotId, modelNo: '01', room: '101동 101호' };
const empty = { analysisId, ...selection, dataOrigin: 'synthetic', scheduleStatus: 'unavailable', schedules: [], funds: [] };
const path = `https://api.invalid/api/v1/analyses/${analysisId}/funding-plan`;
const token = 'Bearer SYNTHETIC_USER_TEST';
function post(body: unknown = selection, url = path) {
  return new Request(url, { method: 'POST', headers: {
    Authorization: token, Origin: env.ALLOWED_ORIGINS, 'Content-Type': 'application/json',
  }, body: JSON.stringify(body) });
}

function connect(t: TestContext, result: () => Response, anonymous = false) {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, env.SUPABASE_URL);
    assert.equal(request.headers.get('Authorization'), token);
    assert.equal(request.headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY);
    calls.push(url.pathname);
    if (url.pathname === '/auth/v1/user') return Response.json({ id: 'synthetic-user', is_anonymous: anonymous });
    assert.equal(url.pathname, '/rest/v1/rpc/read_analysis_funding_inputs');
    assert.deepEqual(await request.json(), {
      p_analysis_id: analysisId, p_snapshot_id: snapshotId, p_model_no: selection.modelNo, p_room: selection.room,
    });
    return result();
  });
  return { handle: createHandler({ env, createBackend, log() {} }), calls };
}

test('funding uses the user session and marks a legacy capture as missing evidence', async t => {
  const { handle } = connect(t, () => Response.json(empty));
  const res = await handle(post());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).contractVersion, 'funding-plan/v1');
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(res.headers.get('Vercel-CDN-Cache-Control'), 'no-store');
  assert.match(res.headers.get('Vary') ?? '', /Authorization/);
});

test('only the public selection can be submitted and all fields are checked before the funding RPC', async t => {
  const { handle, calls } = connect(t, () => { throw new Error('unexpected RPC'); });
  for (const req of [
    post({ ...selection, funds: [] }), post({ ...selection, schedules: [] }), post({ ...selection, budgetMaxWon: '0' }),
    post({ snapshotId, room: '101호' }), post({ ...selection, snapshotId: 'none' }),
    post({ ...selection, room: ' ' }), post({ ...selection, modelNo: 1 }), post(selection, path.replace(analysisId, 'invalid')),
  ]) {
    const res = await handle(req);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_funding_input');
  }
  assert.equal((await handle(post({ ...selection, room: 'x'.repeat(4097) }))).status, 413);
  assert.equal((await handle(new Request(path, { method: 'POST', headers: { Authorization: token }, body: 'text' }))).status, 415);
  assert.ok(calls.every(p => p === '/auth/v1/user'));
});

test('funding preflight, authentication and method checks use the same private endpoint', async t => {
  const { handle, calls } = connect(t, () => { throw new Error('unexpected RPC'); }, true);
  const options = await handle(new Request(path, { method: 'OPTIONS', headers: { Origin: env.ALLOWED_ORIGINS } }));
  assert.equal(options.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  assert.equal(options.status, 204);
  assert.equal((await handle(new Request(path, { method: 'OPTIONS', headers: { Origin: 'https://other.invalid' } }))).status, 403);
  assert.equal((await handle(new Request(path))).status, 405);
  assert.equal((await handle(new Request(path, { method: 'POST' }))).status, 401);
  assert.equal((await handle(post())).status, 401);
  assert.deepEqual(calls, ['/auth/v1/user']);
});

test('funding never returns a different analysis, snapshot or room, or raw upstream error details', async t => {
  let upstream: () => Response;
  const { handle } = connect(t, () => upstream());
  for (const [payload, status, expected] of [
    [{ code: '42501', message: 'funding_authentication_required' }, 403, 401],
    [{ code: 'PT404', message: 'SYNTHETIC_PRIVATE' }, 404, 404],
    [{ code: 'XX000', message: 'SYNTHETIC_PRIVATE' }, 500, 503],
    [{ ...empty, analysisId: snapshotId }, 200, 503], [{ ...empty, snapshotId: analysisId }, 200, 503],
    [{ ...empty, room: 'another room' }, 200, 503], [{ ...empty, modelNo: '02' }, 200, 503],
    [{ ...empty, funds: null }, 200, 503],
  ] as const) {
    upstream = () => Response.json(payload, { status });
    const res = await handle(post());
    assert.equal(res.status, expected);
    assert.deepEqual(Object.keys(await res.json()).sort(), ['error', 'requestId']);
  }
});
