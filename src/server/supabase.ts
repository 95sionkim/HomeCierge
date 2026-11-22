import { randomUUID } from 'node:crypto';
import { createClient, StorageApiError } from '@supabase/supabase-js';
import type { Database } from '../db/database.types.js';
import { ApiError } from './http-input.js';
import { parseAnalysisRun, parseComparisonSnapshot } from './analysis-runs.js';
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
    async runAnalysis(operation, signal) {
      const args = { p_analysis_id: operation.analysisId };
      const rpc = operation.action === 'enqueue'
        ? client.rpc('enqueue_analysis_run', { ...args, p_idempotency_key: operation.idempotencyKey, p_input: operation.input })
        : client.rpc(operation.action === 'get' ? 'get_analysis_run' : 'cancel_analysis_run', {
          ...args, p_run_id: operation.runId,
        });
      const { data, error } = await rpc.abortSignal(signal);
      if (error?.code === 'PT404') throw new ApiError('run_not_found');
      if (error?.code === 'PT409') throw new ApiError('run_conflict');
      if (error?.code === '22023') throw new ApiError('invalid_run_input');
      if (operation.action === 'enqueue' && error?.code === 'PT429') throw new ApiError('run_rate_limited');
      if (error) throw new Error('database_unavailable');

      const run = parseAnalysisRun(data);
      if (!run || run.analysisId !== operation.analysisId) throw new Error('invalid_run_response');
      let matches: boolean;
      if (operation.action === 'enqueue') {
        const input = operation.input;
        matches = input.kind === 'snapshot'
          ? run.input.kind === 'snapshot' && run.input.snapshotId === input.snapshotId
          : run.input.kind === 'synthetic' && run.input.fixture === input.fixture;
      } else {
        matches = run.runId === operation.runId && (operation.action !== 'cancel' || run.status === 'cancelled');
      }
      if (!matches) throw new Error('invalid_run_response');
      return run;
    },
    async getNoticeSearchIndex(signal) {
      const { data, error } = await client.rpc('read_notice_search_index').abortSignal(signal);
      if (error?.code === '42501' && error.message === 'notice_search_authentication_required') {
        throw new ApiError('authentication_required');
      }
      if (error?.code === 'PT403') throw new ApiError('search_source_restricted');
      if (error) throw new Error('database_unavailable');
      return data;
    },
    async getFundingInputs({ analysisId, snapshotId, modelNo, room }, signal) {
      const { data, error } = await client.rpc('read_analysis_funding_inputs', {
        p_analysis_id: analysisId, p_snapshot_id: snapshotId, p_model_no: modelNo, p_room: room,
      }).abortSignal(signal);
      if (error?.code === '42501' && error.message === 'funding_authentication_required') {
        throw new ApiError('authentication_required');
      }
      if (error?.code === 'PT404') throw new ApiError('funding_not_found');
      if (error?.code === '22023') throw new ApiError('invalid_funding_input');
      if (error) throw new Error('database_unavailable');
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || data.analysisId !== analysisId || data.snapshotId !== snapshotId
        || data.modelNo !== modelNo || data.room !== room) throw new Error('invalid_funding_response');
      return data;
    },
    async getComparison(analysisId, runId, signal) {
      const { data, error } = await client.rpc('get_analysis_comparison', {
        p_analysis_id: analysisId, p_run_id: runId,
      }).abortSignal(signal);
      if (error?.code === 'PT403') throw new ApiError('comparison_source_restricted');
      if (error?.code === 'PT404') throw new ApiError('run_not_found');
      if (error?.code === 'PT409') throw new ApiError('comparison_not_available');
      if (error) throw new Error('database_unavailable');
      const snapshot = parseComparisonSnapshot(data, analysisId, runId);
      if (!snapshot) throw new Error('invalid_comparison_response');
      return snapshot;
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
