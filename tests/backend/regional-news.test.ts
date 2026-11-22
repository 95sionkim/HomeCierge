// 합성 응답과 주입한 fetch로 네이버 뉴스의 요청 경계와 제공 상태를 검증한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchRegionalNews, isRegionalNewsRegion } from '../../src/server/regional-news.js';
import type { RegionalNewsOptions } from '../../src/server/regional-news.js';

const region = '서울특별시 광진구';
const checkedAt = '2026-11-22T01:00:00.000Z';
const syntheticId = 'synthetic-navertest-client-id';
const syntheticSecret = 'synthetic-navertest-client-secret';
const item = {
  title: '<b>광진구</b> &quot;합성 분양&quot;',
  description: '합성 발췌 &amp; 추가 소식 &#x2026; &#39;인용&#39;',
  originallink: 'http://publisher.invalid/news/%61?category=A%2Fb#item',
  link: 'https://naver.invalid/synthetic-redirect',
  pubDate: 'Fri, 20 Nov 2026 09:00:00 +0900',
};

function page(items: unknown[], total = items.length) {
  return { lastBuildDate: 'Sun, 22 Nov 2026 10:00:00 +0900', total, start: 1, display: items.length, items };
}

function options(fetch: typeof globalThis.fetch, overrides: Partial<RegionalNewsOptions> = {}): RegionalNewsOptions {
  return { clientId: syntheticId, clientSecret: syntheticSecret, signal: new AbortController().signal,
    fetch, now: () => new Date(checkedAt), ...overrides };
}

test('canonical city and county labels exclude street addresses and ambiguous aliases', async () => {
  for (const value of [region, '부산광역시 기장군', '경기도 수원시 영통구', '제주특별자치도 제주시',
    '세종특별자치시', '강원특별자치도 횡성군', '전북특별자치도 전주시 덕진구',
    '전남광주통합특별시 순천시', '전남광주통합특별시 광산구']) {
    assert.equal(isRegionalNewsRegion(value), true, value);
  }
  let calls = 0;
  const provider = options(async () => { calls++; return Response.json(page([])); });
  for (const invalid of ['광진구', '경기도', '서울시 광진구', '서울특별시 광진구 구의동', '서울특별시 광진구 123',
    '서울특별시  광진구', '서울특별시 광진구\n', '서울특별시 광진구\u200b', '세종특별자치시 조치원읍',
    '전라남도 순천시', '광주광역시 광산구', 'https://synthetic.invalid', '경기도 합성군 합성구']) {
    assert.equal(isRegionalNewsRegion(invalid), false, invalid);
    await assert.rejects(fetchRegionalNews(invalid, provider), { message: 'invalid_news_region' });
  }
  assert.equal(calls, 0);
});

test('only the fixed provider receives the regional query and the response keeps provider order', async () => {
  const requests: Request[] = [];
  const second = { ...item, title: '합성 제2기사', pubDate: 'Sat, 21 Nov 2026 20:30:00 -0330' };
  const third = { ...item, title: '합성 제3기사' };
  const result = await fetchRegionalNews(region, options(async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ ...page([item, second, third], 42), private: syntheticSecret });
  }));
  assert.equal(requests.length, 1);
  const [request] = requests;
  const url = new URL(request.url);
  assert.equal(url.origin, 'https://naverapihub.apigw.ntruss.com');
  assert.equal(url.pathname, '/search/v1/news');
  assert.equal(url.searchParams.size, 4);
  assert.equal(url.searchParams.get('query'), '서울특별시 광진구 분양');
  assert.equal(url.searchParams.get('display'), '3');
  assert.equal(url.searchParams.get('sort'), 'date');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(request.method, 'GET');
  assert.equal(request.redirect, 'error');
  assert.equal(request.cache, 'no-store');
  assert.equal(request.body, null);
  assert.equal(request.headers.get('X-NCP-APIGW-API-KEY-ID'), syntheticId);
  assert.equal(request.headers.get('X-NCP-APIGW-API-KEY'), syntheticSecret);
  assert.equal(request.headers.get('Authorization'), null);
  assert.equal(request.headers.get('Cookie'), null);
  assert.deepEqual(result, {
    status: 'available', queriedAt: checkedAt,
    conditions: { region, query: '서울특별시 광진구 분양', sort: 'date', display: 3, format: 'json' },
    source: { provider: 'naver_api_hub', name: '네이버 검색결과',
      url: 'https://www.ncloud.com/product/applicationService/NAVERAPIHUB' },
    textFormat: 'plain_text', geographicRelevance: 'unverified', factVerification: 'unverified',
    items: [
      { title: '광진구 "합성 분양"', snippet: "합성 발췌 & 추가 소식 … '인용'",
        originalUrl: item.originallink, originalHost: 'publisher.invalid', publishedAt: '2026-11-20T00:00:00.000Z' },
      { title: '합성 제2기사', snippet: "합성 발췌 & 추가 소식 … '인용'",
        originalUrl: item.originallink, originalHost: 'publisher.invalid', publishedAt: '2026-11-22T00:00:00.000Z' },
      { title: '합성 제3기사', snippet: "합성 발췌 & 추가 소식 … '인용'",
        originalUrl: item.originallink, originalHost: 'publisher.invalid', publishedAt: '2026-11-20T00:00:00.000Z' },
    ],
    omittedCount: 0,
  });
});

test('a complete zero is empty and an incomplete page withholds every record', async () => {
  for (const [payload, status, omittedCount] of [
    [page([]), 'empty', 0], [{ ...page([]), start: 0, display: 3 }, 'empty', 0],
    [page([], 2), 'partial', 2], [page([item], 10), 'partial', 2],
    [page([item, { ...item, originallink: '' }]), 'partial', 1],
    [page([{ ...item, pubDate: 'Fri, 30 Feb 2026 09:00:00 +0900' }]), 'partial', 1],
    [page([{ ...item, pubDate: 'Fri, 20 Nov 2026 09:00:00' }]), 'partial', 1],
    [page([{ ...item, title: '   ' }]), 'partial', 1],
    [page([{ ...item, description: 7 }]), 'partial', 1],
  ] as const) {
    const result = await fetchRegionalNews(region, options(async () => Response.json(payload)));
    assert.equal(result.status, status);
    assert.equal(result.omittedCount, omittedCount);
    assert.equal(result.queriedAt, checkedAt);
    assert.deepEqual(result.items, []);
  }
});

test('unexpected markup, unusable original links and echoed credentials cannot become a display page', async () => {
  for (const changed of [
    { title: '<a>합성 제목</a>' }, { description: '&lt;p&gt;합성 발췌&lt;/p&gt;' },
    { description: '합성 &#0; 발췌' }, { title: syntheticSecret }, { title: '&eacute; 합성 제목' },
    { originallink: 'mailto:synthetic@publisher.invalid' }, { originallink: '//publisher.invalid/article' },
    { originallink: 'https://reader@publisher.invalid/article' }, { originallink: 'https://@publisher.invalid/article' },
    { originallink: 'https://publisher.invalid/with space' }, { originallink: 'https:/publisher.invalid/article' },
    { originallink: 'http://localhost./article' }, { originallink: 'https://publisher.internal/article' },
    { originallink: 'http://127.0.0.1/article' }, { originallink: 'http://192.168.1.2/article' },
    { originallink: 'http://[::1]/article' },
  ]) {
    const result = await fetchRegionalNews(region, options(async () => Response.json(page([item, { ...item, ...changed }]))));
    assert.equal(result.status, 'partial');
    assert.equal(result.omittedCount, 1);
    assert.deepEqual(result.items, []);
  }
});

test('an omitted credential or a pre-aborted request produces no attempt', async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; return Response.json(page([])); };
  for (const override of [{ clientId: undefined }, { clientSecret: undefined }, { clientSecret: ' ' }]) {
    const result = await fetchRegionalNews(region, options(fetch, override));
    assert.equal(result.status, 'not_configured');
    assert.equal(result.queriedAt, null);
  }
  const result = await fetchRegionalNews(region, options(fetch, { signal: AbortSignal.abort() }));
  assert.equal(result.status, 'provider_unavailable');
  assert.equal(result.queriedAt, null);
  assert.equal(calls, 0);
});

test('provider errors and invalid envelopes never appear as zero or trigger retries', async () => {
  const cases = [
    [() => Response.json({ error: { detail: syntheticSecret } }, { status: 429 }), 'rate_limited'],
    [() => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.invalid/' } }), 'provider_unavailable'],
    [() => new Response(null, { status: 401 }), 'provider_unavailable'],
    [() => Response.json({ errorMessage: syntheticSecret }, { status: 503 }), 'provider_unavailable'],
    [() => { throw new Error(syntheticSecret); }, 'provider_unavailable'],
    [() => Response.json(page([]), { status: 206 }), 'provider_unavailable'],
    [() => new Response('{', { headers: { 'Content-Type': 'application/json' } }), 'provider_unavailable'],
    [() => Response.json({ items: [] }), 'provider_unavailable'],
    [() => Response.json({ total: 0 }), 'provider_unavailable'],
    [() => Response.json({ ...page([]), total: '0' }), 'provider_unavailable'],
    [() => Response.json({ ...page([]), errorCode: 'SE99' }), 'provider_unavailable'],
    [() => Response.json({ ...page([]), start: 4 }), 'provider_unavailable'],
    [() => Response.json({ ...page([item], 1), start: 0 }), 'provider_unavailable'],
    [() => Response.json({ ...page([item], 1), display: 0 }), 'provider_unavailable'],
    [() => Response.json({ ...page([]), display: 5 }), 'provider_unavailable'],
    [() => Response.json(page([item], 0)), 'provider_unavailable'],
    [() => Response.json(page([item, item, item, item])), 'provider_unavailable'],
  ] as const;
  for (const [response, status] of cases) {
    let calls = 0;
    const result = await fetchRegionalNews(region, options(async () => { calls++; return response(); }));
    assert.equal(calls, 1);
    assert.equal(result.status, status);
    assert.equal(result.queriedAt, checkedAt);
    assert.deepEqual(result.items, []);
    assert.equal(JSON.stringify(result).includes(syntheticSecret), false);
  }
});

test('the streamed response size is bounded despite a smaller advertised length', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(64 * 1024)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  });
  const result = await fetchRegionalNews(region, options(async () => new Response(body, {
    headers: { 'Content-Type': 'application/json', 'Content-Length': '10' },
  })));
  assert.equal(result.status, 'provider_unavailable');
  assert.equal(cancelled, true);
});

test('the provider deadline cancels a stalled response body', async t => {
  const deadline = new AbortController();
  const timeout = t.mock.method(AbortSignal, 'timeout', (_milliseconds: number) => deadline.signal);
  let markReading: () => void;
  const reading = new Promise<void>(resolve => { markReading = resolve; });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() { markReading(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const request = fetchRegionalNews(region, options(async () => new Response(body, {
    headers: { 'Content-Type': 'application/json' },
  })));
  await reading;
  deadline.abort();
  assert.equal((await request).status, 'provider_unavailable');
  assert.equal(timeout.mock.calls.length, 1);
  assert.equal(timeout.mock.calls[0].arguments[0], 5_000);
  assert.equal(cancelled, true);
});
