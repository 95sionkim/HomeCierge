import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createClient, StorageApiError } from '@supabase/supabase-js';
import type { Database } from '../db/database.types.js';
import { ApiError } from './http-input.js';
import {
  buildComparisonEvidenceDetail,
  extractComparisonUploadIds,
  parseAnalysisRun,
  parseComparisonSnapshot,
} from './analysis-runs.js';
import { parseUploadSupplementContext, parseUploadSupplementRun } from './upload-supplement.js';
import type { Backend, BackendConfig } from './handler.js';

const uploadBucket = 'analysis-uploads';
const backendTimeoutMs = 8000;
const noticeConflicts = [
  'notice_index_not_ready', 'notice_not_found', 'notice_source_conflict', 'notice_kind_unsupported',
  'notice_edition_mismatch', 'notice_edition_unverified', 'notice_model_not_found', 'notice_model_unverified',
  'notice_region_unverified', 'analysis_notice_selection_conflict',
] as const;

export function createBackend(config: BackendConfig): Backend {
  const baseUrl = `${config.url.trim().replace(/\/+$/, '')}/`;
  const uploadDownloadPrefix = new URL(`storage/v1/object/${uploadBucket}/`, baseUrl).href;
  // 요청마다 클라이언트를 만들어 다른 사용자의 인증 상태를 공유하지 않는다.
  const client = createClient<Database>(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
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
      if (!data.user || data.user.banned_until === 'infinity' ||
          (data.user.banned_until && Date.parse(data.user.banned_until) > Date.now())) return null;
      return { id: data.user.id, isAnonymous: data.user.is_anonymous === true };
    },
    async getProfile(id) {
      const { data, error } = await client.from('user_profiles')
        .select('user_id,search_conditions,commute_destination,revision,updated_at')
        .eq('user_id', id).maybeSingle();
      if (error) throw new Error('database_unavailable');
      return data;
    },
    async chatHome(op, signal) {
      const rpc = op.action === 'list'
        ? client.rpc('list_chats', { ...(op.before ? { p_before: op.before } : {}), p_limit: op.limit })
        : op.action === 'create'
          ? client.rpc('create_chat', { p_request_key: op.requestId, ...(op.title !== null ? { p_title: op.title } : {}) })
          : op.action === 'detail'
            ? client.rpc('read_chat_detail', { p_chat_id: op.chatId })
            : op.action === 'rename'
              ? client.rpc('rename_chat', { p_chat_id: op.chatId, p_title: op.title })
              : op.action === 'message'
                ? client.rpc('post_chat_message', {
                    p_chat_id: op.chatId,
                    p_request_key: op.requestId,
                    p_message: op.message,
                    p_action: op.replyAction,
                    ...(op.query !== null ? { p_query: op.query } : {}),
                    ...(op.mode !== null ? { p_mode: op.mode } : {}),
                  })
                : op.action === 'prepareSearch'
                  ? client.rpc('prepare_chat_search_confirmation', {
                      p_chat_id: op.chatId,
                      p_reply_id: op.replyId,
                    })
                  : op.action === 'decideSearch'
                    ? client.rpc('decide_chat_search_proposal', {
                        p_chat_id: op.chatId,
                        p_reply_id: op.replyId,
                        p_decision: op.decision,
                        ...(op.conditions !== null ? { p_conditions: op.conditions } : {}),
                        ...(op.resultSummary !== null ? { p_result_summary: op.resultSummary } : {}),
                      })
                    : client.rpc('start_chat_notice_workspace', {
                        p_chat_id: op.chatId,
                        p_request_key: op.requestId,
                        p_input: op.input,
                      });
      const { data, error } = await rpc.abortSignal(signal);
      if (error) {
        if (error.code === '42501') throw new ApiError('authentication_required');
        if (error.code === 'PT404') throw new ApiError('chat_not_found');
        if (error.code === 'PT403') {
          throw new ApiError(error.message === 'search_source_restricted' ? 'search_source_restricted' : 'notice_source_restricted');
        }
        if (error.code === 'PT429') throw new ApiError('run_rate_limited');
        if (error.code === 'PT409') {
          if (op.action === 'startAnalysis') {
            const cause = noticeConflicts.find(code => code === error.message);
            if (cause) throw new ApiError(cause);
          }
          throw new ApiError(op.action === 'startAnalysis' && error.message !== 'chat_request_conflict' ? 'run_conflict' : 'chat_conflict');
        }
        if (error.code === '22023') {
          if (op.action === 'startAnalysis') throw new ApiError('invalid_run_input');
          if (error.message === 'invalid_chat_search_conditions' || error.message === 'invalid_search_profile_region') {
            throw new ApiError('invalid_search_input');
          }
          throw new ApiError('invalid_chat_input');
        }
        throw new Error('database_unavailable');
      }
      return data;
    },
    async dataDeletion(op, signal) {
      const query = op.action === 'items'
        ? client.rpc('list_deletion_items', { p_kind:op.kind, ...(op.before ? { p_before:op.before } : {}) })
        : op.action === 'receipt' ? client.rpc('read_deletion_receipt', { p_receipt:op.receiptId })
        : op.action === 'impact' ? client.rpc('read_deletion_impact', { p_scope:op.scope, ...(op.targetId ? { p_target:op.targetId } : {}) })
        : op.scope === 'account' ? client.rpc('request_account_deletion', { p_receipt:op.receiptId })
        : client.rpc('delete_personal_data', { p_scope:op.scope, p_receipt:op.receiptId, ...(op.targetId ? { p_target:op.targetId } : {}) });
      const { data, error } = await query.abortSignal(signal);
      if (error?.code === 'PT404') throw new ApiError('deletion_not_found');
      if (error?.code === 'PT409' && error.message === 'deletion_upload_scope_unverified')
        throw new ApiError('deletion_upload_scope_unverified');
      if (error?.code === 'PT409') throw new ApiError('deletion_conflict');
      if (error?.code === '22023') throw new ApiError('invalid_deletion_input');
      if (error?.code === '42501') throw new ApiError('authentication_required');
      if (error) throw new Error('database_unavailable');
      return data;
    },
    async savedReport(operation, signal) {
      const rpc = operation.action === 'save' ? client.rpc('save_analysis_report', {
        p_analysis_id: operation.analysisId, p_run_id: operation.runId, p_request_id: operation.requestId,
        ...(operation.fundingRoom ? { p_funding_room: operation.fundingRoom } : {}),
      }) : operation.action === 'list' ? client.rpc('list_saved_analysis_reports', operation.before ? { p_before: operation.before } : {})
        : operation.action === 'delete' ? client.rpc('delete_saved_analysis_report', { p_report_id: operation.reportId })
        : client.rpc('read_saved_analysis_report', { p_report_id: operation.reportId, p_for_export: operation.action === 'export' });
      const { data, error } = await rpc.abortSignal(signal);
      if (error?.code === 'PT404') throw new ApiError('report_not_found');
      if (error?.code === 'PT409') throw new ApiError('report_conflict');
      if (error?.code === '22023') throw new ApiError('invalid_report_input');
      if (error?.code === '42501' && error.message.includes('authentication_required')) throw new ApiError('authentication_required');
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
      if (operation.action === 'enqueue' && operation.input.kind === 'notice' && error) {
        if (error.code === 'PT403') throw new ApiError('notice_source_restricted');
        if (error.code === '42501' && error.message === 'authentication_required') throw new ApiError('authentication_required');
        if (error.code === 'PT409') {
          const cause = noticeConflicts.find(code => code === error.message);
          if (cause) throw new ApiError(cause);
        }
      }
      if (error?.code === 'PT404') throw new ApiError('run_not_found');
      if (error?.code === 'PT409') throw new ApiError('run_conflict');
      if (error?.code === '22023') throw new ApiError('invalid_run_input');
      if (operation.action === 'enqueue' && error?.code === 'PT429') throw new ApiError('run_rate_limited');
      if (error) throw new Error('database_unavailable');

      const run = parseAnalysisRun(data);
      if (!run || run.analysisId !== operation.analysisId) throw new Error('invalid_run_response');
      let matches: boolean;
      if (operation.action === 'enqueue') {
        matches = isDeepStrictEqual(run.input, operation.input);
      } else {
        matches = run.runId === operation.runId && (operation.action !== 'cancel' || run.status === 'cancelled');
      }
      if (!matches) throw new Error('invalid_run_response');
      return run;
    },
    async uploadSupplement(operation, signal) {
      const rpc = operation.action === 'context'
        ? client.rpc('read_upload_supplement_context', {
          p_analysis_id: operation.analysisId,
          p_run_id: operation.runId,
        })
        : operation.action === 'enqueue'
          ? client.rpc('enqueue_upload_supplement_run', {
            p_analysis_id: operation.analysisId,
            p_base_run_id: operation.baseRunId,
            p_upload_id: operation.uploadId,
            p_idempotency_key: operation.idempotencyKey,
          })
          : client.rpc('get_upload_supplement_run', {
            p_analysis_id: operation.analysisId,
            p_run_id: operation.runId,
          });
      const { data, error } = await rpc.abortSignal(signal);
      if (error) {
        if (error.code === '42501' && error.message === 'authentication_required') throw new ApiError('authentication_required');
        if (error.code === 'PT403') {
          throw new ApiError(error.message === 'notice_source_restricted'
            ? 'notice_source_restricted' : 'comparison_source_restricted');
        }
        if (error.code === 'PT404') {
          throw new ApiError(error.message === 'upload_not_found' ? 'upload_not_found' : 'run_not_found');
        }
        if (error.code === 'PT409') {
          if (error.message === 'upload_not_available') throw new ApiError('upload_not_available');
          if (error.message === 'upload_file_missing') throw new ApiError('upload_file_missing');
          if (error.message === 'upload_supplement_base_not_ready') throw new ApiError('upload_supplement_base_not_ready');
          if (error.message === 'upload_supplement_not_eligible') throw new ApiError('upload_supplement_not_eligible');
          throw new ApiError('upload_supplement_conflict');
        }
        if (error.code === 'PT429') throw new ApiError('run_rate_limited');
        if (error.code === '22023') throw new ApiError('invalid_upload_supplement_input');
        throw new Error('database_unavailable');
      }
      if (operation.action === 'context') {
        const parsed = parseUploadSupplementContext(data);
        if (!parsed || parsed.analysisId !== operation.analysisId || parsed.runId !== operation.runId) {
          throw new Error('invalid_upload_supplement_response');
        }
        return parsed;
      }
      const parsed = parseUploadSupplementRun(data);
      if (!parsed || parsed.analysisId !== operation.analysisId) {
        throw new Error('invalid_upload_supplement_response');
      }
      if (operation.action === 'enqueue') {
        if (parsed.baseRunId !== operation.baseRunId || parsed.uploadId !== operation.uploadId) {
          throw new Error('invalid_upload_supplement_response');
        }
      } else if (parsed.runId !== operation.runId) {
        throw new Error('invalid_upload_supplement_response');
      }
      return parsed;
    },
    async getNoticeSearchIndex(signal, purpose) {
      const rpc = purpose === 'directory' ? 'read_notice_directory_index' : 'read_notice_search_index';
      const { data, error } = await client.rpc(rpc).abortSignal(signal);
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
    async prepareCommute(analysisId, snapshotId, signal) {
      const { data, error } = await client.rpc('prepare_analysis_commute', {
        p_analysis_id: analysisId, p_snapshot_id: snapshotId,
      }).abortSignal(signal);
      if (error?.code === '42501' && error.message === 'commute_authentication_required') throw new ApiError('authentication_required');
      if (error?.code === 'PT404') throw new ApiError('commute_snapshot_not_found');
      if (error?.code === 'PT429') throw new ApiError('commute_rate_limited');
      if (error) throw new Error('database_unavailable');
      return data;
    },
    async prepareRegionalNews(analysisId, snapshotId, signal) {
      const { data, error } = await client.rpc('prepare_analysis_regional_news', {
        p_analysis_id: analysisId, p_snapshot_id: snapshotId,
      }).abortSignal(signal);
      if (error?.code === '42501' && error.message === 'regional_news_authentication_required') {
        throw new ApiError('authentication_required');
      }
      if (error?.code === 'PT404') throw new ApiError('news_snapshot_not_found');
      if (error?.code === 'PT429') throw new ApiError('news_rate_limited');
      if (error) throw new Error('database_unavailable');
      return data;
    },
    async getLegalEvidence(analysisId, snapshotId, signal) {
      const { data, error } = await client.rpc('read_analysis_legal_evidence', {
        p_analysis_id: analysisId, p_snapshot_id: snapshotId,
      }).abortSignal(signal);
      if (error?.code === '42501' && error.message === 'legal_authentication_required') {
        throw new ApiError('authentication_required');
      }
      if (error?.code === 'PT404') throw new ApiError('legal_evidence_not_found');
      if (error?.code === '22023') throw new ApiError('invalid_legal_input');
      if (error) throw new Error('database_unavailable');
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
    async getComparisonEvidence(analysisId, runId, signal) {
      // 소유권·완료 상태와 출처 표시 권한을 기존 비교 RPC로 먼저 검증한다.
      const { data, error } = await client.rpc('get_analysis_comparison', {
        p_analysis_id: analysisId, p_run_id: runId,
      }).abortSignal(signal);
      if (error?.code === 'PT403') throw new ApiError('comparison_source_restricted');
      if (error?.code === 'PT404') throw new ApiError('run_not_found');
      if (error?.code === 'PT409') throw new ApiError('comparison_not_available');
      if (error) throw new Error('database_unavailable');
      const snapshot = parseComparisonSnapshot(data, analysisId, runId);
      if (!snapshot) throw new Error('invalid_comparison_response');

      const { data: snapRow, error: snapError } = await client.from('analysis_input_snapshots')
        .select('id,analysis_id,data_origin,result_snapshot')
        .eq('id', snapshot.snapshotId)
        .eq('analysis_id', analysisId)
        .abortSignal(signal)
        .maybeSingle();
      if (snapError) throw new Error('database_unavailable');

      const uploadIds = extractComparisonUploadIds(snapshot, snapRow?.result_snapshot ?? null);
      let uploadRows: Array<{ id: string; status: string }> = [];
      if (uploadIds.length > 0) {
        const { data: rows, error: uploadError } = await client.from('analysis_uploads')
          .select('id,status')
          .eq('analysis_id', analysisId)
          .in('id', uploadIds)
          .abortSignal(signal);
        if (uploadError) throw new Error('database_unavailable');
        uploadRows = rows ?? [];
      }

      const detail = buildComparisonEvidenceDetail(snapshot, snapRow, uploadRows);
      if (!detail) throw new Error('invalid_comparison_response');
      return detail;
    },
    async analysisConversation(op, signal) {
      const target = { p_analysis_id: op.analysisId, p_run_id: op.runId };
      const rpc = op.action === 'read' ? client.rpc('read_analysis_conversation', target)
        : op.action === 'decide' ? client.rpc('decide_analysis_chat_turn', {
          ...target, p_turn_id: op.turnId, p_decision: op.decision,
        }) : op.action === 'submit_conditions' ? client.rpc('submit_analysis_condition_turn', {
          ...target, p_request_id: op.requestId, p_message: op.message, p_conditions: op.conditions,
        }) : client.rpc('submit_analysis_chat_turn', {
          ...target, p_request_id: op.requestId, p_message: op.message, p_intent: op.intent,
          ...(op.period && { p_start: op.period.start, p_end: op.period.end }),
        });
      const { data, error } = await rpc.abortSignal(signal);
      if (error?.code === '42501' && error.message === 'authentication_required') throw new ApiError('authentication_required');
      if (error?.code === 'PT403') throw new ApiError('comparison_source_restricted');
      if (error?.code === 'PT404') throw new ApiError('run_not_found');
      if (error?.code === 'PT409') {
        if (error.message === 'analysis_comparison_not_ready') throw new ApiError('comparison_not_available');
        if (error.message === 'analysis_chat_period_unavailable') throw new ApiError('conversation_period_unavailable');
        if (error.message === 'analysis_chat_condition_unavailable') throw new ApiError('conversation_condition_unavailable');
        throw new ApiError('conversation_conflict');
      }
      if (error?.code === 'PT429') throw new ApiError('run_rate_limited');
      if (error?.code === '22023') throw new ApiError('invalid_conversation_input');
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
