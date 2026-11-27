import { fetchRegionalNews, isRegionalNewsRegion } from './regional-news.js';
import type { RegionalNewsOptions } from './regional-news.js';

const holds = new Set(['selection_unverified', 'region_unverified', 'source_restricted', 'synthetic_input']);

// 사용자 DB가 확인한 공고 지역만 제공자에게 전달한다.
export async function readRegionalNews(context: unknown, analysisId: string, snapshotId: string, options: RegionalNewsOptions) {
  if (!context || typeof context !== 'object' || !('analysisId' in context) || context.analysisId !== analysisId
    || !('snapshotId' in context) || context.snapshotId !== snapshotId || !('status' in context)
    || typeof context.status !== 'string' || !('region' in context)) throw new Error('invalid_news_context');
  const identity = { contractVersion: 'regional-news/v1', analysisId, snapshotId };
  if (context.status === 'ready' && isRegionalNewsRegion(context.region)) {
    const { status, ...search } = await fetchRegionalNews(context.region, options);
    return { ...identity, status, search };
  }
  if (holds.has(context.status) && context.region === null) {
    return { ...identity, status: context.status, search: null };
  }
  throw new Error('invalid_news_context');
}
