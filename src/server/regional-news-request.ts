import { ApiError, readBody } from './http-input.js';
import { fetchRegionalNews, isRegionalNewsRegion, maxRegionalNewsPage } from './regional-news.js';
import type { RegionalNewsOptions } from './regional-news.js';

const holds = new Set(['selection_unverified', 'region_unverified', 'source_restricted', 'synthetic_input']);
const maxBodyBytes = 4 * 1024;

// 선택 JSON 본문 {"page": n}을 검증한다. 본문이 없거나 {}이면 1쪽을 사용한다.
export async function readRegionalNewsPage(request: Request): Promise<number> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType && contentType !== 'application/json') throw new ApiError('unsupported_media_type');
  const bytes = await readBody(request, maxBodyBytes, 'invalid_news_input');
  if (bytes === null) throw new ApiError(contentType === 'application/json' ? 'payload_too_large' : 'unsupported_media_type');
  if (bytes.byteLength === 0) return 1;
  if (contentType !== 'application/json') throw new ApiError('unsupported_media_type');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError('invalid_news_input');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('invalid_news_input');
  const keys = Object.keys(value);
  if (keys.length === 0) return 1;
  if (keys.length !== 1 || keys[0] !== 'page') throw new ApiError('invalid_news_input');
  const page = (value as { page: unknown }).page;
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 || page > maxRegionalNewsPage) {
    throw new ApiError('invalid_news_input');
  }
  return page;
}

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
