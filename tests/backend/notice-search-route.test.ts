// 합성 색인과 로그인 응답으로 실제 HTTP 핸들러와 Supabase SDK의 요청 경계를 검사한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createHandler } from '../../src/server/handler.js';
import { createBackend } from '../../src/server/supabase.js';

const env = {
  SUPABASE_URL: 'https://synthetic.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC_PUBLIC_TEST',
  APP_ENV: 'preview',
  ALLOWED_ORIGINS: 'https://screen.invalid',
};
const token = 'Bearer SYNTHETIC_USER_TEST';
const endpoint = 'https://api.invalid/api/v1/notices/search';
const conditions = { regionCodes: ['11215', '11200'], budgetMaxWon: '1300000000' };
const now = () => new Date('2026-11-21T15:00:01Z');
const emptyIndex = {
  contractVersion: 'notice-search-index/v1', dataOrigin: 'collected',
  observedAt: '2026-11-21T15:00:00Z',
  regionCodes: ['11200', '11215'],
  publicationWindow: { start: '2026-11-01', end: '2026-11-22' },
  coverage: { status: 'complete', sources: ['applyhome_apt', 'applyhome_remainder']
    .map(source => ({ source, status: 'empty' })) }, notices: [],
};

function post(body: BodyInit = JSON.stringify(conditions), type = 'application/json', authorization = token) {
  return new Request(endpoint, { method: 'POST', body, headers: {
    Authorization: authorization, Origin: env.ALLOWED_ORIGINS, 'Content-Type': type,
  } });
}

function installBackend(t: TestContext, read: () => Response, anonymous = false, rpc = 'read_notice_search_index') {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const { origin, pathname } = new URL(request.url);
    assert.equal(origin, env.SUPABASE_URL);
    assert.equal(request.headers.get('authorization'), token);
    assert.equal(request.headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY);
    calls.push(pathname);
    if (pathname === '/auth/v1/user') return Response.json({ id: 'synthetic', is_anonymous: anonymous });
    assert.equal(pathname, '/rest/v1/rpc/' + rpc);
    assert.equal(request.method, 'POST');
    assert.deepEqual(await request.json(), {});
    return read();
  });
  return { handle: createHandler({ env, createBackend, now, log: () => {} }), calls };
}

test('the notice directory accepts a signed-in GET without a budget or region and uses the Korea date', async t => {
  const { handle, calls } = installBackend(t, () => Response.json(emptyIndex), false, 'read_notice_directory_index');
  const url = 'https://api.invalid/api/v1/notices';
  const headers = { Authorization: token, Origin: env.ALLOWED_ORIGINS };
  assert.equal((await handle(new Request(url))).status, 401);
  const preflight = await handle(new Request(url, { method: 'OPTIONS', headers }));
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal((await handle(new Request(url, { method: 'POST', headers }))).status, 405);
  for (const query of ['?asOf=2080-01-01', '?budgetMaxWon=100', '?includeClosed=true&includeClosed=false']) {
    const response = await handle(new Request(url + query, { headers }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_directory_input');
  }
  const response = await handle(new Request(url, { headers }));
  assert.equal(response.status, 200);
  const directory = await response.json();
  assert.equal(directory.contractVersion, 'notice-directory/v1');
  assert.equal(directory.asOf, '2026-11-22');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
  assert.equal(calls.filter(path => path.startsWith('/rest/')).length, 1);
});

test('a directory without a current publication never returns an empty successful list', async t => {
  const { handle } = installBackend(t, () => Response.json(null), false, 'read_notice_directory_index');
  const response = await handle(new Request('https://api.invalid/api/v1/notices', { headers: { Authorization: token } }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'search_index_not_ready');
});

test('search reads the published index using the authenticated caller and Korea calendar date', async t => {
  const { handle, calls } = installBackend(t, () => Response.json(emptyIndex));
  const result = await handle(post());
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.asOf, '2026-11-22');
  assert.deepEqual(body.matched, []);
  assert.deepEqual(body.needsReview, []);
  assert.equal(body.contractVersion, 'notice-search/v1');
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.headers.get('vercel-cdn-cache-control'), 'no-store');
  assert.match(result.headers.get('vary') ?? '', /Authorization/);
  assert.deepEqual(calls, ['/auth/v1/user', '/rest/v1/rpc/read_notice_search_index']);
});

test('only the allowed app origin can preflight, reading search requires a signed-in account', async t => {
  const { handle, calls } = installBackend(t, () => { throw new Error('unexpected search RPC'); }, true);
  const options = await handle(new Request(endpoint, { method: 'OPTIONS', headers: { Origin: env.ALLOWED_ORIGINS } }));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(options.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
  assert.equal((await handle(new Request(endpoint, { method: 'OPTIONS', headers: { Origin: 'https://other.invalid' } }))).status, 403);
  assert.equal((await handle(new Request(endpoint))).status, 405);
  assert.equal((await handle(post('{}', 'application/json', ''))).status, 401);
  assert.equal((await handle(post())).status, 401);
  assert.deepEqual(calls, ['/auth/v1/user']);
});

test('public request accepts only search conditions and bounds the streamed JSON before querying the index', async t => {
  const { handle, calls } = installBackend(t, () => { throw new Error('unexpected search RPC'); });
  for (const [request, status, code] of [
    [post('{}'), 400, 'invalid_search_input'],
    [post(JSON.stringify({ ...conditions, candidates: [] })), 400, 'invalid_search_input'],
    [post(JSON.stringify({ ...conditions, asOf: '2026-01-01' })), 400, 'invalid_search_input'],
    [post(new Uint8Array([255])), 400, 'invalid_search_input'],
    [post('x'.repeat(4097)), 413, 'payload_too_large'],
    [post('{}', 'text/plain'), 415, 'unsupported_media_type'],
  ] as const) {
    const response = await handle(request);
    assert.equal(response.status, status);
    assert.equal((await response.json()).error, code);
  }
  assert.ok(calls.every(path => path === '/auth/v1/user'));
});

test('a missing index, restricted rights and a damaged index have distinct safe responses', async t => {
  const samples = [
    { value: null, status: 200, http: 503, error: 'search_index_not_ready' },
    { value: { message: 'notice_search_authentication_required', code: '42501' }, status: 403, http: 401, error: 'authentication_required' },
    { value: { message: 'SYNTHETIC_PRIVATE', code: 'PT403' }, status: 403, http: 403, error: 'search_source_restricted' },
    { value: { message: 'SYNTHETIC_PRIVATE', code: 'XX000' }, status: 500, http: 503, error: 'backend_unavailable' },
    { value: { ...emptyIndex, dataOrigin: 'synthetic' }, status: 200, http: 503, error: 'backend_unavailable' },
    { value: { ...emptyIndex, notices: null }, status: 200, http: 503, error: 'backend_unavailable' },
  ];
  let upstream: () => Response;
  const { handle } = installBackend(t, () => upstream());
  for (const sample of samples) {
    upstream = () => Response.json(sample.value, { status: sample.status });
    const result = await handle(post());
    assert.equal(result.status, sample.http);
    const data = await result.json();
    assert.equal(data.error, sample.error);
    assert.deepEqual(Object.keys(data).sort(), ['error', 'requestId']);
  }
});
