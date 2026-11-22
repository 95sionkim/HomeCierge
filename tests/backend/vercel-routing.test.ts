import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { convertRewrites } from '@vercel/routing-utils';

test('the deployed API rewrite forwards the original query without adding a path parameter', async () => {
  const config = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const routes = convertRewrites(config.rewrites);
  // 이름이 있는 경로 매개변수는 Vercel이 목적지 쿼리에 추가한다. 공고·근거 API는 원래 쿼리를 검사한다.
  for (const request of [
    '/api/v1/notices?limit=20&includeClosed=false',
    '/api/v1/analyses/analysis/snapshots/snapshot/legal-evidence',
    '/api/v1/analyses/analysis/snapshots/snapshot/regional-news',
  ]) {
    const url = new URL(request, 'https://example.invalid');
    const route = routes.find(item => 'src' in item && typeof item.src === 'string' && new RegExp(item.src).test(url.pathname));
    assert.ok(route && 'dest' in route);
    assert.equal(route.dest, '/api');
  }
});
