// 합성 공급자와 사용자 JWT로 실제 핸들러·PostgREST 경로를 검증한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createHandler } from '../../src/server/handler.js';
import { createBackend } from '../../src/server/supabase.js';

const analysisId = 'b1000000-0000-4000-8000-000000000001';
const snapshotId = 'b1000000-0000-4000-8000-000000000002';
const path = `https://home.invalid/api/v1/analyses/${analysisId}/snapshots/${snapshotId}/regional-news`;
const env = { APP_ENV: 'development', SUPABASE_URL: 'https://db.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC', ALLOWED_ORIGINS: 'https://screen.invalid',
  NAVER_API_CLIENT_ID: 'synthetic-id', NAVER_API_CLIENT_SECRET: 'synthetic-secret' };
const headers = { Origin: env.ALLOWED_ORIGINS, Authorization: 'Bearer SYNTHETIC_USER' };
const ready = { analysisId, snapshotId, status: 'ready', region: '서울특별시 광진구' };
const request = (url = path, body?: string) => new Request(url, { method: 'POST', headers, body });

function connect(t: TestContext, rpc: () => Response) {
  let calls = 0;
  let searches = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    assert.equal(url.origin, env.SUPABASE_URL);
    assert.equal(req.headers.get('Authorization'), headers.Authorization);
    if (url.pathname === '/auth/v1/user') return Response.json({ id: 'synthetic-owner', is_anonymous: false });
    assert.equal(url.pathname, '/rest/v1/rpc/prepare_analysis_regional_news');
    assert.deepEqual(await req.json(), { p_analysis_id: analysisId, p_snapshot_id: snapshotId });
    calls++;
    return rpc();
  });
  const newsFetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    assert.equal(url.hostname, 'naverapihub.apigw.ntruss.com');
    assert.equal(url.searchParams.get('query'), '서울특별시 광진구 분양');
    assert.equal(req.headers.get('Authorization'), null);
    assert.equal(req.headers.get('apikey'), null);
    searches++;
    return Response.json({ total: 0, start: 1, display: 0, items: [] });
  };
  return { handle: createHandler({ env, createBackend, newsFetch, log() {} }), counts: () => [calls, searches] };
}

test('request uses only the owner snapshot region and reports verified provider zero with private caching', async t => {
  const { handle, counts } = connect(t, () => Response.json(ready));
  const res = await handle(request());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('vercel-cdn-cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.contractVersion, 'regional-news/v1');
  assert.equal(body.analysisId, analysisId);
  assert.equal(body.snapshotId, snapshotId);
  assert.equal(body.status, 'empty');
  assert.deepEqual(body.search.items, []);
  assert.deepEqual(counts(), [1, 1]);
});

test('holds, invalid backend context, foreign accounts and limits do not trigger a search', async t => {
  let rpc = Response.json(null);
  const { handle, counts } = connect(t, () => rpc);
  for (const status of ['source_restricted', 'selection_unverified', 'region_unverified', 'synthetic_input']) {
    rpc = Response.json({ ...ready, status, region: null, raw: 'internal-only' });
    const res = await handle(request());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { contractVersion: 'regional-news/v1', analysisId, snapshotId, status, search: null });
  }
  for (const bad of [{ ...ready, region: '서울특별시 광진구 합성로 1' }, { ...ready, analysisId: snapshotId },
    { ...ready, status: 'source_restricted' }]) {
    rpc = Response.json(bad);
    assert.equal((await handle(request())).status, 503);
  }
  rpc = Response.json({ code: 'PT404', message: 'private' }, { status: 404 });
  assert.equal((await handle(request())).status, 404);
  rpc = Response.json({ code: 'PT429', message: 'private' }, { status: 429 });
  const limited = await handle(request());
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, 'news_rate_limited');
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.deepEqual(counts(), [9, 0]);
});

test('free text, query overrides, invalid UUID and missing login cannot spend a search attempt', async t => {
  const { handle, counts } = connect(t, () => { throw Error('unexpected_rpc'); });
  assert.equal((await handle(new Request(path, { method: 'POST' }))).status, 401);
  assert.equal((await handle(new Request(path, { headers }))).status, 405);
  assert.equal((await handle(new Request(path, { method: 'OPTIONS', headers }))).headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  for (const req of [request(path, '{"region":"other"}'), request(path + '?query=other'), request(path.replace(snapshotId, 'bad'))]) {
    const res = await handle(req);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_news_input');
  }
  assert.deepEqual(counts(), [0, 0]);
});
