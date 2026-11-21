export const uuidPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const uuid = new RegExp(`^${uuidPattern}$`);
const maxSubmitBytes = 4 * 1024;
const runStatuses = ['queued', 'running', 'retry_wait', 'finished', 'failed', 'cancelled'] as const;

type AnalysisRunInput = { kind: 'snapshot'; snapshotId: string } | { kind: 'synthetic'; fixture: 'ingestion-v0' };
type RunStatus = typeof runStatuses[number];
type RunFailureCode = 'run_internal_error' | 'run_deadline_exceeded';
export type AnalysisRunOperation =
  | { action: 'enqueue'; analysisId: string; idempotencyKey: string; input: AnalysisRunInput }
  | { action: 'get' | 'cancel'; analysisId: string; runId: string };
export type AnalysisRun = {
  runId: string;
  analysisId: string;
  status: RunStatus;
  attempt: number;
  submittedAt: string;
  finishedAt: string | null;
  input: AnalysisRunInput;
  snapshotId: string | null;
  errorCode: RunFailureCode | null;
};

const runErrorStatuses = {
  invalid_run_input: 400,
  comparison_source_restricted: 403,
  run_not_found: 404,
  run_conflict: 409,
  comparison_not_available: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  run_rate_limited: 429,
} as const;

export class AnalysisRunError extends Error {
  constructor(readonly code: keyof typeof runErrorStatuses) {
    super(code);
  }

  get status() { return runErrorStatuses[this.code]; }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// 결과는 저장된 버전으로 읽는다. 실행 상태만으로 비교 가능 여부를 결정하지 않는다.
export function parseComparisonSnapshot(value: unknown, analysisId: string, runId: string) {
  if (!isRecord(value) || value.analysisId !== analysisId || value.runId !== runId
    || !isUuid(value.snapshotId) || typeof value.rulesVersion !== 'string' || !value.rulesVersion
    || !isRecord(value.result)) return null;
  const { contractVersion, dataOrigin, completeness, appliedScope, rankingComplete,
    target, conditions, noticePrice, regionDecision, tradeKinds, collections,
    comparables, targetReferences, holds, exclusions } = value.result;
  if (contractVersion !== 'comparison/v1' || (dataOrigin !== 'synthetic' && dataOrigin !== 'collected')
    || (completeness !== 'complete' && completeness !== 'partial' && completeness !== 'unavailable')
    || (appliedScope !== null && appliedScope !== 'priority' && appliedScope !== 'expansion')
    || typeof rankingComplete !== 'boolean'
    || (target !== null && !isRecord(target)) || !isRecord(conditions)
    || (noticePrice !== null && !isRecord(noticePrice))
    || ((target === null || noticePrice === null) && completeness !== 'unavailable')
    || !isRecord(regionDecision) || !isRecord(tradeKinds) || !Array.isArray(collections)
    || !Array.isArray(comparables) || comparables.length > 5 || !Array.isArray(targetReferences)
    || !Array.isArray(holds) || !Array.isArray(exclusions)) return null;
  const candidateIds = new Set<string>();
  for (const candidate of comparables) {
    if (!isRecord(candidate) || typeof candidate.complexId !== 'string' || !candidate.complexId
      || candidateIds.has(candidate.complexId) || appliedScope === null || completeness === 'unavailable') return null;
    candidateIds.add(candidate.complexId);
  }
  if (targetReferences.some(row => !isRecord(row) || typeof row.complexId !== 'string'
    || candidateIds.has(row.complexId))) return null;
  return { analysisId, runId, snapshotId: value.snapshotId, rulesVersion: value.rulesVersion,
    result: { contractVersion, dataOrigin, completeness, appliedScope, rankingComplete, target, conditions, noticePrice,
      regionDecision, tradeKinds, collections, comparables, targetReferences, holds, exclusions } };
}

export type ComparisonSnapshot = NonNullable<ReturnType<typeof parseComparisonSnapshot>>;

function parseInput(value: unknown): AnalysisRunInput | null {
  if (!isRecord(value) || Object.keys(value).length !== 2) return null;
  if (value.kind === 'synthetic' && value.fixture === 'ingestion-v0') {
    return { kind: value.kind, fixture: value.fixture };
  }
  if (value.kind === 'snapshot' && isUuid(value.snapshotId)) {
    return { kind: value.kind, snapshotId: value.snapshotId.toLowerCase() };
  }
  return null;
}

async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
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
    throw new AnalysisRunError('invalid_run_input');
  } finally {
    reader.releaseLock();
  }
}

export async function readAnalysisRunOperation(
  request: Request, analysisId: string, runId: string | undefined, cancel: boolean,
): Promise<AnalysisRunOperation> {
  if (!isUuid(analysisId)) throw new AnalysisRunError('invalid_run_input');
  const analysis = { analysisId: analysisId.toLowerCase() };
  if (runId !== undefined) {
    if (!isUuid(runId) || (cancel && await readBody(request, 0) === null)) {
      throw new AnalysisRunError('invalid_run_input');
    }
    return { ...analysis, action: cancel ? 'cancel' : 'get', runId: runId.toLowerCase() };
  }

  const key = request.headers.get('idempotency-key');
  if (!isUuid(key)) throw new AnalysisRunError('invalid_run_input');
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new AnalysisRunError('unsupported_media_type');
  const bytes = await readBody(request, maxSubmitBytes);
  if (bytes === null) throw new AnalysisRunError('payload_too_large');

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AnalysisRunError('invalid_run_input');
  }
  const input = isRecord(body) && Object.keys(body).length === 1 ? parseInput(body.input) : null;
  if (!input) throw new AnalysisRunError('invalid_run_input');
  return { ...analysis, action: 'enqueue', idempotencyKey: key.toLowerCase(), input };
}

function isRunStatus(value: unknown): value is RunStatus {
  return runStatuses.some(status => status === value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function parseAnalysisRun(value: unknown): AnalysisRun | null {
  if (!isRecord(value)) return null;
  const { runId, analysisId, status, attempt, submittedAt, finishedAt, snapshotId, errorCode } = value;
  const input = parseInput(value.input);
  if (!isUuid(runId) || !isUuid(analysisId) || !isRunStatus(status) || !input
    || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 0
    || !isTimestamp(submittedAt) || (finishedAt !== null && !isTimestamp(finishedAt))
    || (snapshotId !== null && !isUuid(snapshotId))
    || (errorCode !== null && errorCode !== 'run_internal_error' && errorCode !== 'run_deadline_exceeded')) {
    return null;
  }
  const terminal = status === 'finished' || status === 'failed' || status === 'cancelled';
  if ((finishedAt !== null) !== terminal
    || (snapshotId !== null) !== (status === 'finished')
    || (errorCode !== null) !== (status === 'failed')
    || (status === 'finished' && input.kind === 'snapshot' && snapshotId !== input.snapshotId)) {
    return null;
  }
  // 공개 응답에는 DB가 추가로 반환한 작업자 필드가 포함되지 않는다.
  return { runId, analysisId, status, attempt, submittedAt, finishedAt, input, snapshotId, errorCode };
}
