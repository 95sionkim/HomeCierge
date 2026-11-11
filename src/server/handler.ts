import { randomUUID } from 'node:crypto';

export type Environment = Record<string, string | undefined>;
export type Backend = {
  getUser: () => Promise<{ id: string; isAnonymous: boolean } | null>;
  getProfile: (id: string) => Promise<unknown>;
};
export type BackendConfig = { url: string; key: string; token: string };

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
  log?: (event: { requestId: string; code: string }) => void;
}) {
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': requestId,
    });
    const respond = (body: unknown, status: number) => Response.json(body, { status, headers });
    const origin = request.headers.get('origin');
    const allowed = (deps.env.ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean);
    if (origin) {
      if (!allowed.includes(origin)) return respond({ error: 'origin_not_allowed', requestId }, 403);
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') {
      headers.set('Allow', 'GET, OPTIONS');
      return respond({ error: 'method_not_allowed', requestId }, 405);
    }
    const path = new URL(request.url).pathname;
    if (path === '/api/health') return respond({ status: 'ok', service: 'homecierge-api', version: '0.1.0' }, 200);
    if (!['/api/v1/me','/api/ready'].includes(path)) return respond({ error: 'not_found', requestId }, 404);

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
      const profile = await backend.getProfile(user.id);
      if (path === '/api/ready') return respond({ status: 'ready', database: 'reachable' }, 200);
      return respond({ user: { id: user.id }, profile }, 200);
    } catch {
      // 외부 오류 원문에는 인증값·개인정보가 있을 수 있어 코드만 기록한다.
      (deps.log ?? console.error)({ requestId, code: 'backend_unavailable' });
      return respond({ error: 'backend_unavailable', requestId }, 503);
    }
  };
}
