import { randomUUID } from 'node:crypto';
import { ApiError, isUuid, readJsonRequest, uuidPattern } from './http-input.js';
import { koreaDate } from './public-fields.js';
import { readLegalEvidence } from './legal-evidence.js';
import { parseNoticeSearchConditions, evaluateNoticeSearch } from './notice-search.js';
import { readAnalysisRunOperation } from './analysis-runs.js';
import type { AnalysisRun, AnalysisRunOperation, ComparisonSnapshot } from './analysis-runs.js';
import { calculateFundingPlan } from './funding-plan.js';
import { readFundingSelection } from './funding-request.js';
import type { FundingSelection } from './funding-request.js';

export type Environment = Record<string, string | undefined>;
export type Backend = {
  getUser: () => Promise<{ id: string; isAnonymous: boolean } | null>;
  getProfile: (id: string) => Promise<unknown>;
  getUploadContent: (target: {
    userId: string;
    analysisId: string;
    uploadId: string;
    signal: AbortSignal;
  }) => Promise<ReadableStream<Uint8Array> | null>;
  runAnalysis: (operation: AnalysisRunOperation, signal: AbortSignal) => Promise<AnalysisRun>;
  getNoticeSearchIndex: (signal: AbortSignal) => Promise<unknown>;
  getFundingInputs: (selection: FundingSelection, signal: AbortSignal) => Promise<unknown>;
  getLegalEvidence: (analysisId: string, snapshotId: string, signal: AbortSignal) => Promise<unknown>;
  getComparison: (analysisId: string, runId: string, signal: AbortSignal) => Promise<ComparisonSnapshot>;
};
export type BackendConfig = { url: string; key: string; token: string };

const uploadContentPath = new RegExp(`^/api/v1/analyses/(${uuidPattern})/uploads/(${uuidPattern})/content$`);
const analysisRunPath = /^\/api\/v1\/analyses\/([^/]+)\/runs(?:\/([^/]+)(?:\/(cancel|result))?)?$/;
const fundingPlanPath = /^\/api\/v1\/analyses\/([^/]+)\/funding-plan$/;
const legalEvidencePath = /^\/api\/v1\/analyses\/([^/]+)\/snapshots\/([^/]+)\/legal-evidence$/;

function readConfig(env: Environment, token: string): BackendConfig {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key?.startsWith('sb_publishable_') || !['development','preview','production'].includes(env.APP_ENV ?? '')) {
    throw new Error('configuration_unavailable');
  }
  // 개발 DB 연결이 Production에 재사용되면 인증 API를 열지 않는다.
  if (env.VERCEL_ENV === 'production' && env.APP_ENV !== 'production') {
    throw new Error('configuration_unavailable');
  }
  const parsed = new URL(url);
  const local = env.APP_ENV === 'development' && ['localhost','127.0.0.1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw new Error('configuration_unavailable');
  return { url, key, token };
}

export function createHandler(deps: {
  env: Environment;
  createBackend: (config: BackendConfig) => Backend;
  now?: () => Date;
  log?: (event: { requestId: string; code: string }) => void;
}) {
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    const url = new URL(request.url);
    const path = url.pathname;
    const upload = path.match(uploadContentPath);
    const run = path.match(analysisRunPath);
    const funding = path.match(fundingPlanPath);
    const legal = path.match(legalEvidencePath);
    const search = path === '/api/v1/notices/search';
    const enqueues = run !== null && !run[2];
    const method = search || funding || enqueues || run?.[3] === 'cancel' ? 'POST' : 'GET';
    const allowedMethods = `${method}, OPTIONS`;
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': requestId,
    });
    if (search || funding || legal || upload || run?.[3] === 'result') {
      headers.set('Cache-Control', 'private, no-store');
      headers.set('Vary', 'Authorization, Origin');
      headers.set('Vercel-CDN-Cache-Control', 'no-store');
    }
    const respond = (body: unknown, status: number) => Response.json(body, { status, headers });
    const origin = request.headers.get('origin');
    const allowed = (deps.env.ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean);
    if (origin) {
      if (!allowed.includes(origin)) return respond({ error: 'origin_not_allowed', requestId }, 403);
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', allowedMethods);
      headers.set('Access-Control-Allow-Headers', enqueues ? 'Authorization, Content-Type, Idempotency-Key' : 'Authorization, Content-Type');
      if (enqueues) headers.set('Access-Control-Expose-Headers', 'Location');
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== method) {
      headers.set('Allow', allowedMethods);
      return respond({ error: 'method_not_allowed', requestId }, 405);
    }
    if (path === '/api/health') return respond({ status: 'ok', service: 'homecierge-api', version: '0.1.0' }, 200);
    if (!upload && !run && !search && !funding && !legal && !['/api/v1/me','/api/ready'].includes(path)) return respond({ error: 'not_found', requestId }, 404);

    const authorization = request.headers.get('authorization');
    const match = authorization?.match(/^Bearer ([^\s]+)$/i);
    if (!match) return respond({ error: 'authentication_required', requestId }, 401);
    let backend: Backend;
    try {
      backend = deps.createBackend(readConfig(deps.env, match[1]!));
    } catch {
      return respond({ error: 'configuration_unavailable', requestId }, 503);
    }
    try {
      const user = await backend.getUser();
      if (!user || user.isAnonymous) return respond({ error: 'authentication_required', requestId }, 401);
      if (legal) {
        if (!isUuid(legal[1]) || !isUuid(legal[2]) || url.search) throw new ApiError('invalid_legal_input');
        const analysisId = legal[1].toLowerCase();
        const snapshotId = legal[2].toLowerCase();
        const context = await backend.getLegalEvidence(analysisId, snapshotId, request.signal);
        return respond(readLegalEvidence(context, analysisId, snapshotId), 200);
      }
      if (funding) {
        const selection = await readFundingSelection(request, funding[1]!);
        const inputs = await backend.getFundingInputs(selection, request.signal);
        return respond(calculateFundingPlan(inputs), 200);
      }
      if (search) {
        const conditions = parseNoticeSearchConditions(await readJsonRequest(request, 'invalid_search_input'));
        if (!conditions) throw new ApiError('invalid_search_input');
        const index = await backend.getNoticeSearchIndex(request.signal);
        if (index === null) throw new ApiError('search_index_not_ready');
        if (typeof index !== 'object' || !('dataOrigin' in index) || index.dataOrigin !== 'collected') {
          throw new Error('invalid_search_index');
        }
        const asOf = koreaDate.format(deps.now?.() ?? new Date());
        return respond(evaluateNoticeSearch(index, conditions, asOf), 200);
      }
      if (run) {
        const operation = await readAnalysisRunOperation(request, run[1], run[2], run[3] === 'cancel');
        if (run[3] === 'result' && operation.action === 'get') {
          return respond(await backend.getComparison(operation.analysisId, operation.runId, request.signal), 200);
        }
        const result = await backend.runAnalysis(operation, request.signal);
        if (operation.action === 'enqueue') {
          headers.set('Location', `/api/v1/analyses/${result.analysisId}/runs/${result.runId}`);
          return respond(result, 202);
        }
        return respond(result, 200);
      }
      if (upload) {
        const content = await backend.getUploadContent({
          userId: user.id, analysisId: upload[1]!, uploadId: upload[2]!, signal: request.signal,
        });
        if (!content) return respond({ error: 'not_found', requestId }, 404);
        headers.set('Content-Type', 'application/pdf');
        headers.set('Content-Disposition', 'attachment; filename="analysis-upload.pdf"');
        return new Response(content, { headers });
      }
      const profile = await backend.getProfile(user.id);
      if (path === '/api/ready') return respond({ status: 'ready', database: 'reachable' }, 200);
      return respond({ user: { id: user.id }, profile }, 200);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'run_rate_limited') {
          headers.set('Retry-After', '60');
          if (origin) headers.set('Access-Control-Expose-Headers', 'Retry-After');
        }
        return respond({ error: error.code, requestId }, error.status);
      }
      // 외부 오류 원문에는 인증값·개인정보가 있을 수 있어 코드만 기록한다.
      (deps.log ?? console.error)({ requestId, code: 'backend_unavailable' });
      return respond({ error: 'backend_unavailable', requestId }, 503);
    }
  };
}
