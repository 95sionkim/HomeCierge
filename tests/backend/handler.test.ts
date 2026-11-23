// 네트워크·실제 계정·인증값을 사용하지 않는 합성 경계 검사.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../src/server/handler.js';
import type { Backend, Environment } from '../../src/server/handler.js';
import { createBackend } from '../../src/server/supabase.js';

const env: Environment = {
  SUPABASE_URL: 'https://synthetic.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC_NOT_A_REAL_KEY',
  APP_ENV: 'preview',
  ALLOWED_ORIGINS: 'https://frontend.invalid',
};
const backend: Backend = {
  getUser: async () => ({ id: 'synthetic-user', isAnonymous: false }),
  getProfile: async id => ({ user_id: id, revision: 0 }),
  getUploadContent: async () => null,
  runAnalysis: async () => { throw new Error('unexpected_run_operation'); },
  getNoticeSearchIndex: async () => { throw new Error('unexpected_search'); },
  getFundingInputs: async () => { throw new Error('unexpected_funding_read'); },
  getLegalEvidence: async () => { throw new Error('unexpected_legal_read'); },
  prepareCommute: async () => { throw new Error('unexpected_commute_request'); },
  prepareRegionalNews: async () => { throw new Error('unexpected_news_request'); },
  getComparison: async () => { throw new Error('unexpected_comparison_read'); },
  analysisConversation: async () => { throw new Error('unexpected_conversation_request'); },
};
const req = (path: string, headers: Record<string,string> = {}, method = 'GET') =>
  new Request(`https://api.invalid${path}`, { method, headers });
const auth = { Authorization: 'Bearer SYNTHETIC_TEST_TOKEN' };
const otherAuth = { Authorization: 'Bearer SYNTHETIC_OTHER_TEST_TOKEN' };
const ownerId = 'a1100000-0000-4000-8000-000000000001';
const otherId = 'a1100000-0000-4000-8000-000000000002';
const analysisId = 'a1100000-0000-4000-8000-000000000003';
const uploadId = 'a1100000-0000-4000-8000-000000000004';
const contentPath = `/api/v1/analyses/${analysisId}/uploads/${uploadId}/content`;
const objectPath = `${ownerId}/${analysisId}/${uploadId}.pdf`;
const storagePath = `/storage/v1/object/analysis-uploads/${objectPath}`;
const syntheticPdf = '%PDF-1.7\n% synthetic fixture\n%%EOF\n';

function mockUploadDependencies(t: TestContext, options: {
  registration?: () => string;
  lookupError?: () => Response | undefined;
  openFile: (signal: AbortSignal) => Response | Promise<Response>;
}) {
  const calls: string[] = [];
  const nonces: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, env.SUPABASE_URL);
    assert.equal(request.headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(request.method, 'GET');
    const token = request.headers.get('authorization');
    assert.ok(token === auth.Authorization || token === otherAuth.Authorization);
    const userId = token === auth.Authorization ? ownerId : otherId;
    calls.push(url.pathname);
    if (url.pathname === '/auth/v1/user') return Response.json({ id: userId, is_anonymous: false });
    if (url.pathname === '/rest/v1/analysis_uploads') {
      assert.equal(url.searchParams.get('select'), 'object_path');
      assert.equal(url.searchParams.get('user_id'), `eq.${userId}`);
      assert.equal(url.searchParams.get('status'), 'eq.registered');
      const currentStatus = options.registration?.() ?? 'registered';
      const found = userId === ownerId && currentStatus === 'registered'
        && url.searchParams.get('analysis_id') === `eq.${analysisId}` && url.searchParams.get('id') === `eq.${uploadId}`;
      return options.lookupError?.() ?? Response.json(found ? [{ object_path: objectPath }] : []);
    }
    assert.equal(userId, ownerId);
    assert.equal(url.pathname, storagePath);
    assert.equal(init?.cache, 'no-store');
    const nonce = url.searchParams.get('cacheNonce');
    assert.ok(nonce);
    assert.match(nonce, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    nonces.push(nonce);
    return options.openFile(request.signal);
  });
  return { calls, nonces };
}

test('liveness does not claim a DB connection and works without secrets', async () => {
  const handler = createHandler({ env: {}, createBackend: () => { throw Error('must not connect'); } });
  const res = await handler(req('/api/health'));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).database, undefined);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});
test('profile and readiness require a bearer token before configuration access', async () => {
  const handler = createHandler({ env: {}, createBackend: () => backend });
  for (const path of ['/api/v1/me','/api/ready']) assert.equal((await handler(req(path))).status,401);
});
test('unlisted origins are rejected, exact origin receives CORS headers', async () => {
  const handler = createHandler({ env, createBackend: () => backend });
  assert.equal((await handler(req('/api/v1/me',{...auth, Origin:'https://evil.invalid'}))).status,403);
  const res = await handler(req('/api/v1/me',{...auth, Origin:'https://frontend.invalid'}));
  assert.equal(res.status,200);
  assert.equal(res.headers.get('access-control-allow-origin'),'https://frontend.invalid');
  assert.equal(res.headers.get('access-control-allow-credentials'),null);
});
test('missing config and development DB on production fail closed', async () => {
  for (const config of [{}, {...env, VERCEL_ENV:'production'}]) {
    const handler = createHandler({ env: config, createBackend: () => backend });
    assert.equal((await handler(req('/api/v1/me',auth))).status,503);
  }
});
test('invalid and anonymous sessions are rejected', async () => {
  for (const user of [null,{id:'synthetic-user',isAnonymous:true}]) {
    const handler = createHandler({ env, createBackend: () => ({...backend,getUser:async()=>user}) });
    assert.equal((await handler(req('/api/v1/me',auth))).status,401);
  }
});
test('validated identity selects its own profile', async () => {
  const handler = createHandler({ env, createBackend: () => backend });
  const res = await handler(req('/api/v1/me',auth));
  assert.equal(res.status,200);
  assert.equal((await res.json()).profile.user_id,'synthetic-user');
});
test('backend failure is unavailable and does not disclose error or token', async () => {
  const logs: unknown[]=[];
  const handler = createHandler({ env, createBackend: () => ({...backend,getProfile:async()=>{throw Error('SYNTHETIC_PRIVATE_DETAIL');}}),log:e=>logs.push(e) });
  const res = await handler(req('/api/ready',auth));
  assert.equal(res.status,503);
  assert.doesNotMatch(await res.text(),/SYNTHETIC/);
  assert.doesNotMatch(JSON.stringify(logs),/SYNTHETIC/);
});
test('unsupported methods and paths cannot execute data operations', async () => {
  const handler = createHandler({ env, createBackend: () => {throw Error('must not connect');} });
  assert.equal((await handler(req('/api/v1/me',auth,'POST'))).status,405);
  assert.equal((await handler(req('/api/other',auth))).status,404);
});

test('each upload content GET streams a private attachment with a fresh upstream nonce', async t => {
  const upstreams: Response[] = [];
  const { calls, nonces } = mockUploadDependencies(t, {
    openFile: () => {
      const upstream = new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(syntheticPdf));
        controller.close();
      } }), { headers: { Location: 'https://synthetic.invalid/hidden-storage-path' } });
      upstreams.push(upstream);
      return upstream;
    },
  });
  const handle = createHandler({ env, createBackend });
  const sameUrl = `${contentPath}?cacheNonce=caller-supplied`;
  for (let i = 0; i < 2; i++) {
    const response = await handle(req(sameUrl, { ...auth, Origin: 'https://frontend.invalid' }));
    assert.equal(response.status, 200);
    assert.equal(response.body, upstreams[i]?.body);
    assert.equal(upstreams[i]?.bodyUsed, false);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="analysis-upload.pdf"');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
    assert.equal(response.headers.get('vary'), 'Authorization, Origin');
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://frontend.invalid');
    assert.equal(response.headers.get('location'), null);
    assert.equal(await response.text(), syntheticPdf);
  }
  assert.deepEqual(calls, ['/auth/v1/user', '/rest/v1/analysis_uploads', storagePath,
    '/auth/v1/user', '/rest/v1/analysis_uploads', storagePath]);
  assert.equal(new Set(nonces).size, 2);
});

test('the same content URL cannot reach storage for foreign, pending, or deleted uploads', async t => {
  let registration = 'registered';
  const { calls, nonces } = mockUploadDependencies(t, {
    registration: () => registration,
    // 이전 응답이 여전히 캐시에 남아 있는 상황을 합성한다.
    openFile: () => new Response(syntheticPdf),
  });
  const handle = createHandler({ env, createBackend });
  const first = await handle(req(contentPath, auth));
  assert.equal(first.status, 200);
  assert.equal(await first.text(), syntheticPdf);
  const foreign = await handle(req(contentPath, otherAuth));
  assert.equal(foreign.status, 404);
  for (const status of ['deletion_requested', 'deleted', 'missing']) {
    registration = status;
    const response = await handle(req(contentPath, auth));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.json()).error, 'not_found');
  }
  assert.equal(calls.filter(path => path === '/auth/v1/user').length, 5);
  assert.equal(calls.filter(path => path === '/rest/v1/analysis_uploads').length, 5);
  assert.equal(nonces.length, 1);
});

test('upload storage misses and denials return 404 while infrastructure failures return 503', async t => {
  let lookupError: Response | undefined;
  let openFile: () => Response;
  const { nonces } = mockUploadDependencies(t, { lookupError: () => lookupError, openFile: () => openFile() });
  const logs: unknown[] = [];
  const handle = createHandler({ env, createBackend, log: event => logs.push(event) });
  const statusCases = [
    [403, {}, 404], [404, {}, 404], [400, { code: 'NoSuchKey' }, 404], [400, { statusCode: '404' }, 404],
    [400, { code: 'AccessDenied' }, 404], [400, { code: 'InvalidRequest' }, 503], [429, {}, 503],
    [502, { code: 'NoSuchKey' }, 503],
  ] as const;
  for (const [upstreamStatus, details, expectedStatus] of statusCases) {
    openFile = () => Response.json({ ...details, message: 'SYNTHETIC_PRIVATE_DETAIL' }, { status: upstreamStatus });
    const response = await handle(req(contentPath, auth));
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get('vary'), 'Authorization, Origin');
    assert.equal((await response.json()).error, expectedStatus === 404 ? 'not_found' : 'backend_unavailable');
  }
  openFile = () => { throw new TypeError('SYNTHETIC_STORAGE_NETWORK_FAILURE'); };
  assert.equal((await handle(req(contentPath, auth))).status, 503);
  lookupError = Response.json({ code: 'XX000', message: 'SYNTHETIC_DATABASE_ERROR' }, { status: 500 });
  assert.equal((await handle(req(contentPath, auth))).status, 503);
  assert.equal(nonces.length, statusCases.length + 1);
  assert.equal(logs.length, 5);
  assert.doesNotMatch(JSON.stringify(logs), /SYNTHETIC|analysis-uploads/);
});

test('upload route shares the CORS and auth gates and accepts only GET with two valid UUIDs', async () => {
  let backendCalls = 0;
  const handle = createHandler({ env, createBackend: () => { backendCalls++; throw Error('must not connect'); } });
  assert.equal((await handle(req(contentPath))).status, 401);
  assert.equal((await handle(req(contentPath, { ...auth, Origin: 'https://evil.invalid' }))).status, 403);
  assert.equal((await handle(req(contentPath.replace(analysisId, 'invalid-id'), auth))).status, 404);
  assert.equal((await handle(req(contentPath.replace(uploadId, 'not-a-uuid'), auth))).status, 404);
  const refused = await handle(req(contentPath, auth, 'POST'));
  assert.equal(refused.status, 405);
  assert.equal(refused.headers.get('allow'), 'GET, OPTIONS');
  const preflight = await handle(req(contentPath, { Origin: 'https://frontend.invalid' }, 'OPTIONS'));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(backendCalls, 0);
});

test('download opening has a deadline while the opened stream follows the caller cancellation', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let markWaiting!: (signal: AbortSignal) => void;
  const waiting = new Promise<AbortSignal>(resolve => { markWaiting = resolve; });
  let opened: AbortSignal | undefined;
  mockUploadDependencies(t, {
    openFile: signal => {
      if (!opened) {
        opened = signal;
        return new Response(new ReadableStream<Uint8Array>());
      }
      markWaiting(signal);
      return new Promise<Response>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const handle = createHandler({ env, createBackend, log: () => {} });
  const caller = new AbortController();
  const response = await handle(new Request(req(contentPath, auth), { signal: caller.signal }));
  assert.equal(response.status, 200);
  assert.ok(opened);
  t.mock.timers.tick(8_001);
  assert.equal(opened.aborted, false);
  caller.abort();
  assert.equal(opened.aborted, true);
  await response.body?.cancel();

  const pending = handle(req(contentPath, auth));
  const openingSignal = await waiting;
  t.mock.timers.tick(7_999);
  assert.equal(openingSignal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(openingSignal.aborted, true);
  assert.equal((await pending).status, 503);
});

test('the same-origin app receives only a public Supabase configuration and can navigate from its own origin', async () => {
  const handler = createHandler({ env: {...env, SUPABASE_WORKER_KEY:'test-only-server-value'}, createBackend:() => backend });
  const path = '/api/v1/client-config';
  const response = await handler(req(path, {Origin:'https://api.invalid'}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {supabaseUrl:env.SUPABASE_URL, publishableKey:env.SUPABASE_PUBLISHABLE_KEY});
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await handler(req(path,{Origin:'https://third.invalid'}))).status,403);
  assert.equal((await handler(req(path,{},'POST'))).status,405);
  for (const patch of [{VERCEL_ENV:'production'}, {SUPABASE_PUBLISHABLE_KEY:'sb_secret_test'},
    {SUPABASE_URL:'https://reader:password@wrong.invalid/'}, {SUPABASE_URL:'https://wrong.invalid/?token=test'}]) {
    const closed = createHandler({ env: {...env,...patch}, createBackend: () => backend });
    assert.equal((await closed(req(path))).status,503);
  }
});
