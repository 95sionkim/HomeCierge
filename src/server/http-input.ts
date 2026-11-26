// 인증 API는 요청 본문의 바이트 수를 제한하고 정해진 오류 코드만 반환한다.
export const uuidPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const uuid = new RegExp(`^${uuidPattern}$`);

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

const errorStatuses = {
  authentication_required: 401,
  invalid_deletion_input: 400,
  deletion_not_found: 404,
  deletion_conflict: 409,
  deletion_upload_scope_unverified: 409,
  invalid_report_input: 400,
  report_not_found: 404,
  report_conflict: 409,
  invalid_run_input: 400,
  invalid_search_input: 400,
  invalid_directory_input: 400,
  invalid_lookup_input: 400,
  invalid_chat_input: 400,
  chat_not_found: 404,
  chat_conflict: 409,
  directory_page_changed: 409,
  notice_source_restricted: 403,
  notice_index_not_ready: 409,
  notice_not_found: 409,
  notice_source_conflict: 409,
  notice_kind_unsupported: 409,
  notice_edition_mismatch: 409,
  notice_edition_unverified: 409,
  notice_model_not_found: 409,
  notice_model_unverified: 409,
  notice_region_unverified: 409,
  analysis_notice_selection_conflict: 409,
  invalid_funding_input: 400,
  funding_not_found: 404,
  invalid_legal_input: 400,
  legal_evidence_not_found: 404,
  invalid_commute_input: 400,
  commute_snapshot_not_found: 404,
  commute_rate_limited: 429,
  invalid_news_input: 400,
  news_snapshot_not_found: 404,
  news_rate_limited: 429,
  search_source_restricted: 403,
  search_index_not_ready: 503,
  comparison_source_restricted: 403,
  run_not_found: 404,
  run_conflict: 409,
  comparison_not_available: 409,
  invalid_conversation_input: 400,
  conversation_period_unavailable: 409,
  conversation_conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  run_rate_limited: 429,
} as const;

export class ApiError extends Error {
  constructor(readonly code: keyof typeof errorStatuses) {
    super(code);
  }

  get status() { return errorStatuses[this.code]; }
}

type InputError = 'invalid_run_input' | 'invalid_search_input' | 'invalid_funding_input' | 'invalid_news_input' | 'invalid_commute_input' | 'invalid_conversation_input' | 'invalid_report_input' | 'invalid_deletion_input' | 'invalid_chat_input';

export async function readBody(request: Request, limit: number, invalid: InputError): Promise<Uint8Array | null> {
  if (Number(request.headers.get('content-length')) > limit) return null;
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const bytes = new Uint8Array(limit);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return bytes.subarray(0, length);
      if (length + value.byteLength > limit) {
        void reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } catch {
    throw new ApiError(invalid);
  } finally {
    reader.releaseLock();
  }
}

export async function readJsonRequest(request: Request, invalid: InputError): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new ApiError('unsupported_media_type');
  const bytes = await readBody(request, 4 * 1024, invalid);
  if (bytes === null) throw new ApiError('payload_too_large');

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(invalid);
  }
}
