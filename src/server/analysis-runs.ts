import { ApiError, isUuid, readBody, readJsonRequest } from './http-input.js';
export { uuidPattern } from './http-input.js';
const runStatuses = ['queued', 'running', 'retry_wait', 'finished', 'failed', 'cancelled'] as const;

type NoticeInput = {
  kind: 'notice';
  noticeSource: 'applyhome_apt' | 'applyhome_remainder';
  houseManageNo: string;
  noticeNo: string;
  edition: string;
  modelNo: string;
};
type AnalysisRunInput = NoticeInput | { kind: 'snapshot'; snapshotId: string } | { kind: 'synthetic'; fixture: 'ingestion-v0' };
type RunStatus = typeof runStatuses[number];
const noticeFailureCodes = [
  'notice_selection_unverified', 'notice_feed_unavailable', 'notice_source_restricted', 'notice_capture_limit',
] as const;
type RunFailureCode = 'run_internal_error' | 'run_deadline_exceeded' | typeof noticeFailureCodes[number];
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
  if (!isRecord(value)) return null;
  if (value.kind === 'notice') {
    const { noticeSource, houseManageNo, noticeNo, edition, modelNo } = value;
    if (Object.keys(value).length !== 6 || (noticeSource !== 'applyhome_apt' && noticeSource !== 'applyhome_remainder')
      || typeof houseManageNo !== 'string' || !/^[0-9]{10}$/.test(houseManageNo)
      || typeof noticeNo !== 'string' || !/^[0-9]{10}$/.test(noticeNo)
      || typeof edition !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(edition)
      || typeof modelNo !== 'string' || !/^[0-9]{1,20}$/.test(modelNo)) return null;
    return { kind: 'notice', noticeSource, houseManageNo, noticeNo, edition, modelNo };
  }
  if (Object.keys(value).length !== 2) return null;
  if (value.kind === 'synthetic' && value.fixture === 'ingestion-v0') {
    return { kind: value.kind, fixture: value.fixture };
  }
  if (value.kind === 'snapshot' && isUuid(value.snapshotId)) {
    return { kind: value.kind, snapshotId: value.snapshotId.toLowerCase() };
  }
  return null;
}

export async function readAnalysisRunOperation(
  request: Request, analysisId: string, runId: string | undefined, cancel: boolean,
): Promise<AnalysisRunOperation> {
  if (!isUuid(analysisId)) throw new ApiError('invalid_run_input');
  const analysis = { analysisId: analysisId.toLowerCase() };
  if (runId !== undefined) {
    if (!isUuid(runId) || (cancel && await readBody(request, 0, 'invalid_run_input') === null)) {
      throw new ApiError('invalid_run_input');
    }
    return { ...analysis, action: cancel ? 'cancel' : 'get', runId: runId.toLowerCase() };
  }

  const key = request.headers.get('idempotency-key');
  if (!isUuid(key)) throw new ApiError('invalid_run_input');
  const body = await readJsonRequest(request, 'invalid_run_input');
  const input = isRecord(body) && Object.keys(body).length === 1 ? parseInput(body.input) : null;
  if (!input) throw new ApiError('invalid_run_input');
  return { ...analysis, action: 'enqueue', idempotencyKey: key.toLowerCase(), input };
}

function isRunStatus(value: unknown): value is RunStatus {
  return runStatuses.some(status => status === value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isRunFailure(code: unknown, input: AnalysisRunInput): code is RunFailureCode {
  return code === 'run_internal_error' || code === 'run_deadline_exceeded'
    || (input.kind === 'notice' && noticeFailureCodes.some(known => known === code));
}

export function parseAnalysisRun(value: unknown): AnalysisRun | null {
  if (!isRecord(value)) return null;
  const { runId, analysisId, status, attempt, submittedAt, finishedAt, snapshotId, errorCode } = value;
  const input = parseInput(value.input);
  if (!isUuid(runId) || !isUuid(analysisId) || !isRunStatus(status) || !input
    || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 0
    || !isTimestamp(submittedAt) || (finishedAt !== null && !isTimestamp(finishedAt))
    || (snapshotId !== null && !isUuid(snapshotId))
    || (errorCode !== null && !isRunFailure(errorCode, input))) {
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
