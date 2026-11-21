import { randomUUID } from 'node:crypto';
import { createClient, StorageApiError } from '@supabase/supabase-js';
import type { Database } from '../db/database.types.js';
import type { Backend, BackendConfig } from './handler.js';

const uploadBucket = 'analysis-uploads';
const backendTimeoutMs = 8000;

export function createBackend(config: BackendConfig): Backend {
  const baseUrl = `${config.url.trim().replace(/\/+$/, '')}/`;
  const uploadDownloadPrefix = new URL(`storage/v1/object/${uploadBucket}/`, baseUrl).href;
  // 요청마다 클라이언트를 만들어 다른 사용자의 인증 상태를 공유하지 않는다.
  const client = createClient<Database>(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { Authorization: `Bearer ${config.token}` },
      fetch: (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        // PDF 열기 제한은 getUploadContent에서 해제한다. 연결 종료 신호는 본문까지 전달한다.
        if (init?.method === 'GET' && url.startsWith(uploadDownloadPrefix)) return fetch(input, init);
        const timeout = AbortSignal.timeout(backendTimeoutMs);
        return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
      },
    },
  });
  return {
    async getUser() {
      const { data, error } = await client.auth.getUser(config.token);
      if (error) {
        if (error.status && error.status < 500 && error.status !== 429) return null;
        throw new Error('auth_unavailable');
      }
      return data.user ? { id: data.user.id, isAnonymous: data.user.is_anonymous === true } : null;
    },
    async getProfile(id) {
      const { data, error } = await client.from('user_profiles')
        .select('user_id,search_conditions,commute_destination,revision,updated_at')
        .eq('user_id', id).maybeSingle();
      if (error) throw new Error('database_unavailable');
      return data;
    },
    async getUploadContent({ userId, analysisId, uploadId, signal }) {
      const { data: upload, error: lookupError } = await client.from('analysis_uploads')
        .select('object_path').eq('user_id', userId).eq('analysis_id', analysisId)
        .eq('id', uploadId).eq('status', 'registered').abortSignal(signal).maybeSingle();
      if (lookupError) throw new Error('database_unavailable');
      if (!upload?.object_path) return null;

      const opening = new AbortController();
      const timer = setTimeout(() => opening.abort(), backendTimeoutMs);
      try {
        // 매 조회마다 새 URL을 요청해 이전 Storage 응답이 재사용되지 않게 한다.
        const { data, error } = await client.storage.from(uploadBucket)
          .download(upload.object_path, { cacheNonce: randomUUID() }, {
            cache: 'no-store', signal: AbortSignal.any([signal, opening.signal]),
          }).asStream();
        if (error instanceof StorageApiError && (error.status === 403 || error.status === 404
          || (error.status === 400 && [error.statusCode, error.code].some(code =>
            ['403', '404', 'AccessDenied', 'NoSuchKey'].includes(String(code)))))) return null;
        if (error || !data) throw new Error('storage_unavailable');
        return data;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
