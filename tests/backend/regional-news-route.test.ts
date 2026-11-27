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
const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
const ready = { analysisId, snapshotId, status: 'ready', region: '서울특별시 광진구' };
const request = (url = path, body?: string, contentType?: string) =>
  new Request(url, {
    method: 'POST',
    headers: contentType ? { ...headers, 'Content-Type': contentType } : headers,
    body,
  });
const jsonRequest = (body: string, url = path) => request(url, body, 'application/json');

function connect(t: TestContext, rpc: () => Response, provider?: (url: URL) => Response) {
  let calls = 0;
  let searches = 0;
  const searchParams: Array<{ display: string | null; start: string | null }> = [];
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
    searchParams.push({ display: url.searchParams.get('display'), start: url.searchParams.get('start') });
    if (provider) return provider(url);
    return Response.json({ total: 0, start: Number(url.searchParams.get('start')), display: 0, items: [] });
  };
  return {
    handle: createHandler({ env, createBackend, newsFetch, log() {} }),
    counts: () => [calls, searches],
    searchParams,
  };
}

test('request uses only the owner snapshot region and reports verified provider zero with private caching', async t => {
  const { handle, counts, searchParams } = connect(t, () => Response.json(ready));
  const res = await handle(request());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('vercel-cdn-cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.contractVersion, 'regional-news/v1');
  assert.equal(body.analysisId, analysisId);
  assert.equal(body.snapshotId, snapshotId);
  assert.equal(body.status, 'empty');
  assert.equal(body.search.conditions.display, 10);
  assert.equal(body.search.conditions.start, 1);
  assert.deepEqual(body.search.page, {
    number: 1, size: 10, total: 0, lastPage: 0, hasPrevious: false, hasNext: false,
  });
  assert.deepEqual(body.search.items, []);
  assert.deepEqual(counts(), [1, 1]);
  assert.deepEqual(searchParams, [{ display: '10', start: '1' }]);
});

test('optional JSON page body defaults empty object to page 1, forwards start offset and never caches pages', async t => {
  const { handle, counts, searchParams } = connect(
    t,
    () => Response.json(ready),
    url => {
      const start = Number(url.searchParams.get('start'));
      const total = 25;
      const count = Math.max(0, Math.min(10, total - start + 1));
      const items = Array.from({ length: count }, (_, idx) => ({
        title: `합성 기사 ${start + idx}`,
        description: `합성 발췌 ${start + idx}`,
        originallink: `https://example.org/news/${start + idx}`,
        pubDate: 'Mon, 02 Nov 2026 09:00:00 +0900',
      }));
      return Response.json({ total, start, display: items.length, items });
    },
  );
  const emptyJson = await handle(jsonRequest('{}'));
  assert.equal(emptyJson.status, 200);
  const page1 = await emptyJson.json();
  assert.equal(page1.status, 'available');
  assert.equal(page1.search.conditions.start, 1);
  assert.equal(page1.search.items.length, 10);
  assert.deepEqual(page1.search.page, {
    number: 1, size: 10, total: 25, lastPage: 3, hasPrevious: false, hasNext: true,
  });

  const page2Res = await handle(jsonRequest('{"page":2}'));
  assert.equal(page2Res.status, 200);
  const page2 = await page2Res.json();
  assert.equal(page2.search.conditions.start, 11);
  assert.equal(page2.search.items[0].title, '합성 기사 11');
  assert.deepEqual(page2.search.page, {
    number: 2, size: 10, total: 25, lastPage: 3, hasPrevious: true, hasNext: true,
  });

  const page3Res = await handle(jsonRequest('{"page":3}'));
  assert.equal(page3Res.status, 200);
  const page3 = await page3Res.json();
  assert.equal(page3.search.conditions.start, 21);
  assert.equal(page3.search.items.length, 5);
  assert.deepEqual(page3.search.page, {
    number: 3, size: 10, total: 25, lastPage: 3, hasPrevious: true, hasNext: false,
  });

  const page1Again = await handle(new Request(path, { method: 'POST', headers: jsonHeaders }));
  assert.equal(page1Again.status, 200);
  assert.deepEqual(counts(), [4, 4]);
  assert.deepEqual(searchParams, [
    { display: '10', start: '1' },
    { display: '10', start: '11' },
    { display: '10', start: '21' },
    { display: '10', start: '1' },
  ]);
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

test('free text, invalid page values, query overrides, invalid UUID and missing login cannot spend a search attempt', async t => {
  const { handle, counts } = connect(t, () => { throw Error('unexpected_rpc'); });
  assert.equal((await handle(new Request(path, { method: 'POST' }))).status, 401);
  assert.equal((await handle(new Request(path, { headers }))).status, 405);
  assert.equal((await handle(new Request(path, { method: 'OPTIONS', headers }))).headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  for (const req of [
    jsonRequest('{"region":"other"}'),
    jsonRequest('{"page":0}'),
    jsonRequest('{"page":-1}'),
    jsonRequest('{"page":1.5}'),
    jsonRequest('{"page":"2"}'),
    jsonRequest('{"page":101}'),
    jsonRequest('{"page":null}'),
    jsonRequest('{"page":true}'),
    jsonRequest('{"page":1,"extra":true}'),
    jsonRequest('[]'),
    jsonRequest('null'),
    jsonRequest('{'),
    request(path + '?query=other'),
    request(path.replace(snapshotId, 'bad')),
  ]) {
    const res = await handle(req);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_news_input');
  }
  const wrongMedia = await handle(request(path, '{"page":1}', 'text/plain'));
  assert.equal(wrongMedia.status, 415);
  assert.equal((await wrongMedia.json()).error, 'unsupported_media_type');
  const tooLarge = await handle(jsonRequest('{"page":1}' + ' '.repeat(5000)));
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error, 'payload_too_large');
  assert.deepEqual(counts(), [0, 0]);
});
