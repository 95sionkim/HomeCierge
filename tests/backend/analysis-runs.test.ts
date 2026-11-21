// 합성 세션과 RPC 응답으로 공개 실행 API를 검사한다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createDevServer } from '../../dev/server.js';
import { createHandler } from '../../src/server/handler.js';
import { createBackend } from '../../src/server/supabase.js';

const env = {
  SUPABASE_URL: 'https://synthetic.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC_NOT_A_REAL_KEY',
  APP_ENV: 'preview',
  ALLOWED_ORIGINS: 'https://frontend.invalid',
};
const analysisId = 'a1100000-0000-4000-8000-000000000001';
const runId = 'a1100000-0000-4000-8000-000000000002';
const snapshotId = 'a1100000-0000-4000-8000-000000000003';
const idempotencyKey = 'a1100000-0000-4000-8000-000000000004';
const userId = 'a1100000-0000-4000-8000-000000000005';
const runsPath = `/api/v1/analyses/${analysisId}/runs`;
const runPath = `${runsPath}/${runId}`;
const auth = { Authorization: 'Bearer SYNTHETIC_TEST_TOKEN', Origin: env.ALLOWED_ORIGINS };
const submitHeaders = { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey };
const syntheticInput = { kind: 'synthetic', fixture: 'ingestion-v0' };
const snapshotInput = { kind: 'snapshot', snapshotId };
const queued = {
  runId, analysisId, status: 'queued', attempt: 0, submittedAt: '2026-11-21T00:00:00+00:00',
  finishedAt: null, input: syntheticInput, snapshotId: null, errorCode: null,
};
const finished = { ...queued, status: 'finished', attempt: 1, finishedAt: '2026-11-21T00:00:02+00:00', snapshotId };
const cancelled = { ...queued, status: 'cancelled', finishedAt: '2026-11-21T00:00:01+00:00' };

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://api.invalid${path}`, init);
}

function enqueue(body = JSON.stringify({ input: syntheticInput }), headers: HeadersInit = submitHeaders) {
  return request(runsPath, { method: 'POST', headers, body });
}

function mockRpc(t: TestContext, respond: (rpc: string) => Response | Promise<Response>, user: unknown = { id: userId }) {
  const calls: { rpc: string; args: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const upstream = new Request(input, init);
    const url = new URL(upstream.url);
    assert.equal(url.origin, env.SUPABASE_URL);
    assert.equal(upstream.headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(upstream.headers.get('authorization'), auth.Authorization);
    if (url.pathname === '/auth/v1/user') return Response.json(user);
    assert.equal(upstream.method, 'POST');
    assert.match(url.pathname, /^\/rest\/v1\/rpc\//);
    const rpc = url.pathname.split('/').at(-1)!;
    calls.push({ rpc, args: await upstream.json() });
    return respond(rpc);
  });
  return calls;
}

test('enqueue waits for the database and replays the persisted current state with a Location', async t => {
  let release!: () => void;
  let notify!: () => void;
  const commit = new Promise<void>(resolve => { release = resolve; });
  const rpcStarted = new Promise<void>(resolve => { notify = resolve; });
  let state: typeof queued | typeof finished = queued;
  const calls = mockRpc(t, async () => {
    notify();
    await commit;
    return Response.json({ ...state, leaseToken: 'SYNTHETIC_PRIVATE_DETAIL' });
  });
  const handle = createHandler({ env, createBackend });
  let completed = false;
  const pending = handle(enqueue()).then(response => { completed = true; return response; });
  try {
    // Race also terminates when running against a handler without the route.
    assert.equal(await Promise.race([rpcStarted.then(() => 'rpc'), pending.then(() => 'response')]), 'rpc');
    await setImmediate();
    assert.equal(completed, false);
  } finally {
    release();
  }
  const response = await pending;
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('location'), runPath);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-expose-headers'), 'Location');
  assert.deepEqual(await response.json(), queued);

  state = finished;
  const replay = await handle(enqueue());
  assert.equal(replay.status, 202);
  assert.equal(replay.headers.get('location'), runPath);
  assert.deepEqual(await replay.json(), finished);
  assert.deepEqual(calls, [0, 1].map(() => ({ rpc: 'enqueue_analysis_run', args: {
    p_analysis_id: analysisId, p_idempotency_key: idempotencyKey, p_input: syntheticInput,
  } })));
});

test('snapshot enqueue, state GET and repeat cancellation send only the public RPC arguments', async t => {
  const calls = mockRpc(t, rpc => Response.json(rpc === 'cancel_analysis_run' ? cancelled : { ...queued, input: snapshotInput }));
  const handle = createHandler({ env, createBackend });
  const snapshot = await handle(enqueue(JSON.stringify({ input: { ...snapshotInput, snapshotId: snapshotId.toUpperCase() } }), {
    ...submitHeaders, 'Content-Type': 'Application/JSON; charset=utf-8', 'Idempotency-Key': idempotencyKey.toUpperCase(),
  }));
  assert.equal(snapshot.status, 202);
  assert.deepEqual((await snapshot.json()).input, snapshotInput);
  const get = await handle(request(runPath, { headers: auth }));
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await get.json(), { ...queued, input: snapshotInput });
  for (let i = 0; i < 2; i++) {
    const cancel = await handle(request(`${runPath}/cancel`, { method: 'POST', headers: auth }));
    assert.equal(cancel.status, 200);
    assert.equal(cancel.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await cancel.json(), cancelled);
  }
  const runArgs = { p_analysis_id: analysisId, p_run_id: runId };
  assert.deepEqual(calls, [
    { rpc: 'enqueue_analysis_run', args: { p_analysis_id: analysisId, p_idempotency_key: idempotencyKey, p_input: snapshotInput } },
    { rpc: 'get_analysis_run', args: runArgs },
    { rpc: 'cancel_analysis_run', args: runArgs },
    { rpc: 'cancel_analysis_run', args: runArgs },
  ]);
});

test('entire JSON and cancellation body are checked before dispatching an RPC', async t => {
  const calls = mockRpc(t, () => Response.json(queued));
  const handle = createHandler({ env, createBackend });
  const bodies = ['', '{', 'null', '[]', '{}', JSON.stringify({ input: syntheticInput, status: 'finished' }),
    ...[
      { kind: 'synthetic', fixture: 'other-version' },
      { kind: 'synthetic', fixture: 'ingestion-v0', url: 'https://synthetic.invalid/raw' },
      { kind: 'snapshot', snapshotId: '../synthetic.json' },
      { kind: 'snapshot', snapshotId, file: 'synthetic.json' },
    ].map(input => JSON.stringify({ input }))];
  for (const body of bodies) {
    const response = await handle(enqueue(body));
    assert.equal(response.status, 400, body);
    assert.equal((await response.json()).error, 'invalid_run_input');
  }
  const invalidRequests = [
    enqueue(undefined, { ...submitHeaders, 'Idempotency-Key': `${idempotencyKey}, ${idempotencyKey}` }),
    enqueue(undefined, { ...auth, 'Content-Type': 'application/json' }),
    request(runsPath.replace(analysisId, 'invalid'), { method: 'POST', headers: submitHeaders }),
    request(runPath.replace(runId, 'invalid'), { headers: auth }),
    request(`${runPath}/cancel`, { method: 'POST', headers: auth, body: ' ' }),
    request(`${runPath}/cancel`, { method: 'POST', headers: { ...auth, 'Content-Length': '3' } }),
  ];
  for (const invalid of invalidRequests) assert.equal((await handle(invalid)).status, 400);

  const wrongMedia = await handle(enqueue(undefined, { ...submitHeaders, 'Content-Type': 'text/plain' }));
  assert.equal(wrongMedia.status, 415);
  assert.equal((await wrongMedia.json()).error, 'unsupported_media_type');
  const oversized = await handle(enqueue(' '.repeat(4097)));
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error, 'payload_too_large');
  assert.equal((await handle(enqueue(undefined, { ...submitHeaders, 'Content-Length': '4097' }))).status, 413);
  assert.deepEqual(calls, []);
});

test('execution routes preserve exact-origin and authenticated-user gates', async t => {
  const calls = mockRpc(t, () => Response.json(queued), { id: userId, is_anonymous: true });
  const handle = createHandler({ env, createBackend });
  const preflight = await handle(request(runsPath, { method: 'OPTIONS', headers: { Origin: env.ALLOWED_ORIGINS } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), env.ALLOWED_ORIGINS);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Authorization, Content-Type, Idempotency-Key');
  assert.equal((await handle(enqueue(undefined, { ...submitHeaders, Origin: `${env.ALLOWED_ORIGINS}.invalid` }))).status, 403);
  for (const path of [runsPath, `${runPath}/cancel`]) {
    const unsupported = await handle(request(path));
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get('allow'), 'POST, OPTIONS');
  }
  const unsupported = await handle(request(runPath, { method: 'POST' }));
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get('allow'), 'GET, OPTIONS');
  assert.equal((await handle(enqueue(undefined, { 'Content-Type': 'application/json' }))).status, 401);
  assert.equal((await handle(enqueue())).status, 401);
  assert.deepEqual(calls, []);
});

test('run errors use stable public codes without exposing database details', async t => {
  const get = request(runPath, { headers: auth });
  const cancel = request(`${runPath}/cancel`, { method: 'POST', headers: auth });
  const databaseCases = [
    [get, 404, 'PT404', 404, 'run_not_found'], [cancel, 409, 'PT409', 409, 'run_conflict'],
    [enqueue(), 409, 'PT409', 409, 'run_conflict'], [enqueue(), 400, '22023', 400, 'invalid_run_input'],
    [enqueue(), 500, 'XX000', 503, 'backend_unavailable'],
  ] as const;
  let upstream: () => Response;
  mockRpc(t, () => upstream());
  const logs: unknown[] = [];
  const handle = createHandler({ env, createBackend, log: event => logs.push(event) });
  for (const [input, status, code, expectedStatus, expectedError] of databaseCases) {
    upstream = () => Response.json({ code, message: 'SYNTHETIC_PRIVATE_DETAIL' }, { status });
    const response = await handle(input);
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get('location'), null);
    assert.deepEqual(await response.json(), { error: expectedError, requestId: response.headers.get('x-request-id') });
  }
  upstream = () => Response.json({ ...queued, finishedAt: undefined });
  const malformed = await handle(enqueue());
  assert.equal(malformed.status, 503);
  assert.equal(malformed.headers.get('location'), null);
  assert.doesNotMatch(JSON.stringify(logs), /SYNTHETIC/);
});

test('comparison GET reads a frozen result with the user session and preserves held versus complete', async t => {
  const resultPath = `${runPath}/result`;
  const result = { contractVersion: 'comparison/v1', dataOrigin: 'synthetic', completeness: 'partial', rankingComplete: false,
    target: {}, conditions: {}, noticePrice: {}, regionDecision: {}, tradeKinds: {}, collections: [],
    appliedScope: null, comparables: [], targetReferences: [], holds: [{ reasonCode: 'trade_supply_area_unverified' }],
    exclusions: [] };
  const saved = { analysisId, runId, snapshotId, rulesVersion: 'synthetic-v1', result };
  let response = () => Response.json(saved);
  const calls = mockRpc(t, () => response());
  const handle = createHandler({ env, createBackend, log: () => {} });
  const read = () => handle(request(resultPath, { headers: auth }));
  assert.equal((await handle(request(resultPath))).status, 401);
  assert.equal((await handle(request(resultPath, { method: 'POST', headers: auth }))).status, 405);
  assert.equal((await handle(request(resultPath.replace(runId, 'invalid'), { headers: auth }))).status, 400);
  const ok = await read();
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await ok.json(), saved);
  assert.deepEqual(calls, [{ rpc: 'get_analysis_comparison', args: { p_analysis_id: analysisId, p_run_id: runId } }]);
  const held = { ...saved, result: { ...result, completeness: 'unavailable', target: null, noticePrice: null } };
  response = () => Response.json(held);
  assert.deepEqual(await (await read()).json(), held);
  for (const [code, status, expected] of [
    ['PT403', 403, 'comparison_source_restricted'], ['PT404', 404, 'run_not_found'], ['PT409', 409, 'comparison_not_available'],
  ] as const) {
    response = () => Response.json({ code, message: 'synthetic database detail' }, { status });
    const failure = await read();
    assert.equal(failure.status, status);
    assert.deepEqual(await failure.json(), { error: expected, requestId: failure.headers.get('x-request-id') });
  }
  for (const invalid of [{ ...saved, runId: userId }, { ...saved, snapshotId: null },
    { ...saved, result: { ...result, dataOrigin: 'unknown' } },
    { ...saved, result: { ...result, collections: undefined } },
    { ...saved, result: { ...result, rankingComplete: undefined } },
    { ...saved, result: { ...result, target: null } },
    { ...saved, result: { ...result, comparables: [{ complexId: 'a' }] } },
    { ...saved, result: { ...result, appliedScope: 'priority', comparables: [{ complexId: 'a' }, { complexId: 'a' }] } },
    { ...saved, result: { ...result, appliedScope: 'priority', comparables: [{ complexId: 'a' }],
      targetReferences: [{ complexId: 'a' }] } },
    { ...saved, result: { ...result, comparables: Array.from({ length: 6 }, () => ({})) } }]) {
    response = () => Response.json(invalid);
    assert.equal((await read()).status, 503);
  }
});

test('only an enqueue PT429 exposes the public retry delay', async t => {
  let code = 'PT429';
  const calls = mockRpc(t, () => Response.json({ code, message: 'SYNTHETIC_PRIVATE_DETAIL' }, {
    status: 429, headers: { 'Retry-After': '999' },
  }));
  const handle = createHandler({ env, createBackend, log: () => {} });
  const limited = await handle(enqueue());
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(limited.headers.get('access-control-expose-headers'), 'Retry-After');
  assert.equal(limited.headers.get('cache-control'), 'no-store');
  assert.equal(limited.headers.get('location'), null);
  assert.deepEqual(await limited.json(), { error: 'run_rate_limited', requestId: limited.headers.get('x-request-id') });
  for (const input of [request(runPath, { headers: auth }), request(`${runPath}/cancel`, { method: 'POST', headers: auth })]) {
    const response = await handle(input);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), null);
  }
  code = 'SYNTHETIC_UPSTREAM_THROTTLING';
  assert.equal((await handle(enqueue())).status, 503);
  assert.deepEqual(calls.map(({ rpc }) => rpc), [
    'enqueue_analysis_run', 'get_analysis_run', 'cancel_analysis_run', 'enqueue_analysis_run',
  ]);
});

test('public run status and terminal fields agree in both directions', async t => {
  const failed = { ...queued, status: 'failed', attempt: 3, finishedAt: finished.finishedAt, errorCode: 'run_internal_error' };
  const invalidResults = [
    ['terminal result missing its timestamp', { ...cancelled, finishedAt: null }],
    ['active run with a terminal timestamp', { ...queued, finishedAt: finished.finishedAt }],
    ['finished run without a snapshot', { ...finished, snapshotId: null }],
    ['cancelled run with a snapshot', { ...cancelled, snapshotId }],
    ['failed run without an error code', { ...failed, errorCode: null }],
    ['failed run with an unexpected error code', { ...failed, errorCode: 'synthetic_private_detail' }],
    ['finished run with an error code', { ...finished, errorCode: failed.errorCode }],
    ['finished snapshot run returns a different snapshot', { ...finished, input: { ...snapshotInput, snapshotId: userId } }],
  ] as const;
  let data: unknown;
  mockRpc(t, () => Response.json(data));
  const handle = createHandler({ env, createBackend, log: () => {} });
  for (const [description, result] of invalidResults) {
    data = result;
    const response = await handle(request(runPath, { headers: auth }));
    assert.equal(response.status, 503, description);
    assert.deepEqual(await response.json(), { error: 'backend_unavailable', requestId: response.headers.get('x-request-id') });
  }
  for (const result of [queued, { ...queued, status: 'running', attempt: 1 }, { ...queued, status: 'retry_wait', attempt: 1 },
    finished, { ...finished, input: snapshotInput }, cancelled, failed, { ...failed, errorCode: 'run_deadline_exceeded' }]) {
    data = result;
    const response = await handle(request(runPath, { headers: auth }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
  }
});

test('the RPC response must match the requested analysis, run and submitted input', async t => {
  const get = request(runPath, { headers: auth });
  const cancel = request(`${runPath}/cancel`, { method: 'POST', headers: auth });
  const mismatches = [
    [enqueue(), { ...queued, analysisId: userId }],
    [get, { ...queued, runId: userId }],
    [cancel, { ...cancelled, runId: userId }],
    [cancel, queued],
    [enqueue(), { ...queued, input: snapshotInput }],
    [enqueue(JSON.stringify({ input: snapshotInput })), { ...queued, input: { ...snapshotInput, snapshotId: userId } }],
  ] as const;
  let data: unknown;
  mockRpc(t, () => Response.json(data));
  const handle = createHandler({ env, createBackend, log: () => {} });
  for (const [input, result] of mismatches) {
    data = result;
    const response = await handle(input);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('location'), null);
    assert.deepEqual(await response.json(), { error: 'backend_unavailable', requestId: response.headers.get('x-request-id') });
  }
});

test('a lost save response returns 503 and a caller retry uses the original idempotency key', async t => {
  let lost = true;
  const calls = mockRpc(t, () => {
    if (lost) {
      lost = false;
      throw new TypeError('SYNTHETIC_NETWORK_FAILURE');
    }
    return Response.json(queued);
  });
  const handle = createHandler({ env, createBackend, log: () => {} });
  const failure = await handle(enqueue());
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get('location'), null);
  assert.equal((await failure.json()).error, 'backend_unavailable');
  assert.equal(calls.length, 1);
  const retry = await handle(enqueue());
  assert.equal(retry.status, 202);
  assert.equal(retry.headers.get('location'), runPath);
  assert.deepEqual(calls, [0, 1].map(() => ({ rpc: 'enqueue_analysis_run', args: {
    p_analysis_id: analysisId, p_idempotency_key: idempotencyKey, p_input: syntheticInput,
  } })));
});

async function listen(t: TestContext) {
  const server = createDevServer(createHandler({ env, createBackend }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, port: address.port };
}

function post(port: number, path: string, headers: Record<string, string> = submitHeaders) {
  const client = httpRequest({ hostname: '127.0.0.1', port, path, method: 'POST', headers });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    client.once('response', resolve);
    client.once('error', reject);
  }).then(async incoming => {
    incoming.setEncoding('utf8');
    let body = '';
    for await (const chunk of incoming) body += chunk;
    const payload: unknown = JSON.parse(body);
    return { status: incoming.statusCode, headers: incoming.headers, body: payload };
  });
  return { client, response };
}

test('Node HTTP submits a complete chunked body and accepts only an empty cancellation', { timeout: 5000 }, async t => {
  const calls = mockRpc(t, rpc => Response.json(rpc === 'cancel_analysis_run' ? cancelled : queued));
  const { port } = await listen(t);
  const submission = post(port, runsPath);
  const json = JSON.stringify({ input: syntheticInput });
  const maxSizeBody = json.padEnd(4096);
  submission.client.write(maxSizeBody.slice(0, 20));
  submission.client.end(maxSizeBody.slice(20));
  const accepted = await submission.response;
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.location, runPath);
  assert.deepEqual(accepted.body, queued);

  const badCancel = post(port, `${runPath}/cancel`, auth);
  badCancel.client.end('{}');
  assert.equal((await badCancel.response).status, 400);
  const cancel = post(port, `${runPath}/cancel`, auth);
  cancel.client.end();
  const response = await cancel.response;
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, cancelled);
  assert.deepEqual(calls.map(({ rpc }) => rpc), ['enqueue_analysis_run', 'cancel_analysis_run']);
});

test('Node HTTP rejects an oversized chunk before upload completion and ignores a disconnected partial body', { timeout: 5000 }, async t => {
  const calls = mockRpc(t, () => Response.json(queued));
  const { server, port } = await listen(t);
  const oversized = post(port, runsPath, { ...submitHeaders, Connection: 'keep-alive' });
  oversized.client.write(' '.repeat(4097));
  // 본문 종료를 기다리지 않고, 제한을 넘긴 즉시 응답해야 한다.
  const response = await oversized.response;
  assert.equal(response.status, 413);
  assert.deepEqual(response.body, { error: 'payload_too_large', requestId: response.headers['x-request-id'] });
  assert.equal(response.headers.connection, 'close');

  const arrived = new Promise<IncomingMessage>(resolve => server.once('request', resolve));
  const partial = post(port, runsPath);
  partial.client.write(JSON.stringify({ input: syntheticInput }));
  const incoming = await arrived;
  const closed = new Promise<void>(resolve => incoming.once('close', resolve));
  partial.client.destroy();
  await assert.rejects(partial.response);
  await closed;

  const complete = post(port, runsPath);
  complete.client.end(JSON.stringify({ input: syntheticInput }));
  assert.equal((await complete.response).status, 202);
  assert.equal(calls.length, 1);
});
