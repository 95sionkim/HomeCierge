// 공식 PDF 확보 실패·판본 미확인 분석을 소유자 업로드 PDF로 보완하는 사용자 API 계약.
// 브라우저가 보낸 해시·채택 상태·공고 판정은 일절 받지 않으며 업로드 UUID만 검증한다.
import { ApiError, isUuid, readJsonRequest } from './http-input.js';

const runStatuses = ['queued', 'running', 'retry_wait', 'finished', 'failed', 'cancelled'] as const;
const failureCodes = [
  'run_internal_error',
  'run_deadline_exceeded',
  'notice_selection_unverified',
  'notice_feed_unavailable',
  'notice_source_restricted',
  'notice_capture_limit',
  'upload_unavailable',
] as const;

type RunStatus = (typeof runStatuses)[number];
type SupplementFailureCode = (typeof failureCodes)[number];

export type UploadSupplementOperation =
  | { action: 'context'; analysisId: string; runId: string }
  | { action: 'enqueue'; analysisId: string; baseRunId: string; uploadId: string; idempotencyKey: string }
  | { action: 'get'; analysisId: string; runId: string };

export type UploadSupplementDocument = {
  id: string;
  version: string;
  source: 'official' | 'upload';
  originCheck: 'confirmed' | 'unverified' | 'conflict';
  status: 'accepted' | 'held' | 'rejected';
  reasons: string[];
  houseManageNo: string;
  noticeNo: string;
  edition: string;
};

export type UploadSupplementIssue = {
  code: string;
  stage: string | null;
  modelNo: string | null;
  houseType: string | null;
  room: string | null;
  item: string | null;
};

export type UploadSupplementRunSummary = {
  runId: string;
  baseRunId: string | null;
  uploadId: string;
  status: RunStatus;
  submittedAt: string;
  finishedAt: string | null;
  snapshotId: string | null;
  errorCode: SupplementFailureCode | null;
};

export type UploadSupplementInput = {
  kind: 'upload_supplement';
  baseRunId: string;
  uploadId: string;
  noticeSource: 'applyhome_apt' | 'applyhome_remainder';
  houseManageNo: string;
  noticeNo: string;
  edition: string;
  modelNo: string;
};

export type UploadSupplementRun = {
  contractVersion: 'upload-supplement-run/v1';
  runId: string;
  analysisId: string;
  baseRunId: string | null;
  uploadId: string;
  status: RunStatus;
  attempt: number;
  submittedAt: string;
  finishedAt: string | null;
  snapshotId: string | null;
  errorCode: SupplementFailureCode | null;
  input: UploadSupplementInput;
  documents: UploadSupplementDocument[];
  issues: UploadSupplementIssue[];
};

export type UploadSupplementContext = {
  contractVersion: 'upload-supplement-context/v1';
  analysisId: string;
  runId: string;
  runStatus: RunStatus;
  snapshotId: string | null;
  eligible: boolean;
  needsSupplement: boolean;
  target: {
    title: string | null;
    noticeSource: 'applyhome_apt' | 'applyhome_remainder' | null;
    houseManageNo: string | null;
    noticeNo: string | null;
    edition: string | null;
    modelNo: string | null;
    houseType: string | null;
    room: string | null;
  };
  reasonCodes: string[];
  documents: UploadSupplementDocument[];
  issues: UploadSupplementIssue[];
  currentSupplement: { uploadId: string; baseRunId: string | null } | null;
  recentSupplements: UploadSupplementRunSummary[];
  uploadRules: {
    bucket: 'analysis-uploads';
    accept: 'application/pdf';
    maxBytes: number;
    sameNoticeRequired: true;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isRunStatus(value: unknown): value is RunStatus {
  return runStatuses.some(status => status === value);
}

function isFailureCode(value: unknown): value is SupplementFailureCode {
  return failureCodes.some(code => code === value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function optionalString(value: unknown, maxLen = 240): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > maxLen) return undefined;
  return value;
}

function parseCodeList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(item)) return null;
    out.push(item);
  }
  return out;
}

function parseDocuments(value: unknown): UploadSupplementDocument[] | null {
  if (!Array.isArray(value)) return null;
  const out: UploadSupplementDocument[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const { id, version, source, originCheck, status, reasons, houseManageNo, noticeNo, edition } = raw;
    const parsedReasons = parseCodeList(reasons);
    if (typeof id !== 'string' || !id || id.length > 160
      || typeof version !== 'string' || !version || version.length > 160
      || (source !== 'official' && source !== 'upload')
      || (originCheck !== 'confirmed' && originCheck !== 'unverified' && originCheck !== 'conflict')
      || (status !== 'accepted' && status !== 'held' && status !== 'rejected')
      || !parsedReasons
      || typeof houseManageNo !== 'string' || typeof noticeNo !== 'string' || typeof edition !== 'string') {
      return null;
    }
    out.push({ id, version, source, originCheck, status, reasons: parsedReasons, houseManageNo, noticeNo, edition });
  }
  return out;
}

function parseIssues(value: unknown): UploadSupplementIssue[] | null {
  if (!Array.isArray(value)) return null;
  const out: UploadSupplementIssue[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.code !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(raw.code)) return null;
    const stage = optionalString(raw.stage, 80);
    const modelNo = optionalString(raw.modelNo, 40);
    const houseType = optionalString(raw.houseType, 120);
    const room = optionalString(raw.room, 120);
    const item = optionalString(raw.item, 80);
    if (stage === undefined || modelNo === undefined || houseType === undefined || room === undefined || item === undefined) {
      return null;
    }
    out.push({ code: raw.code, stage, modelNo, houseType, room, item });
  }
  return out;
}

export function parseUploadSupplementInput(value: unknown): UploadSupplementInput | null {
  if (!isRecord(value) || Object.keys(value).length !== 8 || value.kind !== 'upload_supplement') return null;
  const { baseRunId, uploadId, noticeSource, houseManageNo, noticeNo, edition, modelNo } = value;
  if (!isUuid(baseRunId) || !isUuid(uploadId)
    || (noticeSource !== 'applyhome_apt' && noticeSource !== 'applyhome_remainder')
    || typeof houseManageNo !== 'string' || !/^[0-9]{10}$/.test(houseManageNo)
    || typeof noticeNo !== 'string' || !/^[0-9]{10}$/.test(noticeNo)
    || typeof edition !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(edition)
    || typeof modelNo !== 'string' || !/^[0-9]{1,20}$/.test(modelNo)) {
    return null;
  }
  return {
    kind: 'upload_supplement',
    baseRunId: baseRunId.toLowerCase(),
    uploadId: uploadId.toLowerCase(),
    noticeSource,
    houseManageNo,
    noticeNo,
    edition,
    modelNo,
  };
}

export function parseUploadSupplementRun(value: unknown): UploadSupplementRun | null {
  if (!isRecord(value) || value.contractVersion !== 'upload-supplement-run/v1') return null;
  const { runId, analysisId, baseRunId, uploadId, status, attempt, submittedAt, finishedAt, snapshotId, errorCode } = value;
  const input = parseUploadSupplementInput(value.input);
  const documents = parseDocuments(value.documents);
  const issues = parseIssues(value.issues);
  if (!isUuid(runId) || !isUuid(analysisId) || (baseRunId !== null && !isUuid(baseRunId)) || !isUuid(uploadId)
    || !isRunStatus(status) || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 0
    || !isTimestamp(submittedAt) || (finishedAt !== null && !isTimestamp(finishedAt))
    || (snapshotId !== null && !isUuid(snapshotId))
    || (errorCode !== null && !isFailureCode(errorCode))
    || !input || !documents || !issues) {
    return null;
  }
  const terminal = status === 'finished' || status === 'failed' || status === 'cancelled';
  if ((finishedAt !== null) !== terminal
    || (snapshotId !== null) !== (status === 'finished')
    || (errorCode !== null) !== (status === 'failed')) {
    return null;
  }
  return {
    contractVersion: 'upload-supplement-run/v1',
    runId: runId.toLowerCase(),
    analysisId: analysisId.toLowerCase(),
    baseRunId: baseRunId ? baseRunId.toLowerCase() : null,
    uploadId: uploadId.toLowerCase(),
    status,
    attempt,
    submittedAt,
    finishedAt,
    snapshotId: snapshotId ? snapshotId.toLowerCase() : null,
    errorCode,
    input,
    documents,
    issues,
  };
}

export function parseUploadSupplementContext(value: unknown): UploadSupplementContext | null {
  if (!isRecord(value) || value.contractVersion !== 'upload-supplement-context/v1') return null;
  const { analysisId, runId, runStatus, snapshotId, eligible, needsSupplement, target, uploadRules } = value;
  const reasonCodes = parseCodeList(value.reasonCodes);
  const documents = parseDocuments(value.documents);
  const issues = parseIssues(value.issues);
  if (!isUuid(analysisId) || !isUuid(runId) || !isRunStatus(runStatus)
    || (snapshotId !== null && !isUuid(snapshotId))
    || typeof eligible !== 'boolean' || typeof needsSupplement !== 'boolean'
    || !isRecord(target) || !reasonCodes || !documents || !issues || !isRecord(uploadRules)
    || !Array.isArray(value.recentSupplements)) {
    return null;
  }
  const noticeSource = target.noticeSource === null ? null
    : target.noticeSource === 'applyhome_apt' || target.noticeSource === 'applyhome_remainder'
      ? target.noticeSource : undefined;
  const title = optionalString(target.title, 240);
  const houseManageNo = optionalString(target.houseManageNo, 40);
  const noticeNo = optionalString(target.noticeNo, 40);
  const edition = optionalString(target.edition, 64);
  const modelNo = optionalString(target.modelNo, 40);
  const houseType = optionalString(target.houseType, 120);
  const room = optionalString(target.room, 120);
  if (noticeSource === undefined || title === undefined || houseManageNo === undefined || noticeNo === undefined
    || edition === undefined || modelNo === undefined || houseType === undefined || room === undefined) {
    return null;
  }
  let currentSupplement: { uploadId: string; baseRunId: string | null } | null = null;
  if (value.currentSupplement !== null) {
    if (!isRecord(value.currentSupplement) || !isUuid(value.currentSupplement.uploadId)
      || (value.currentSupplement.baseRunId !== null && !isUuid(value.currentSupplement.baseRunId))) {
      return null;
    }
    currentSupplement = {
      uploadId: value.currentSupplement.uploadId.toLowerCase(),
      baseRunId: value.currentSupplement.baseRunId ? value.currentSupplement.baseRunId.toLowerCase() : null,
    };
  }
  const recentSupplements: UploadSupplementRunSummary[] = [];
  for (const item of value.recentSupplements) {
    if (!isRecord(item) || !isUuid(item.runId) || (item.baseRunId !== null && !isUuid(item.baseRunId))
      || !isUuid(item.uploadId) || !isRunStatus(item.status) || !isTimestamp(item.submittedAt)
      || (item.finishedAt !== null && !isTimestamp(item.finishedAt))
      || (item.snapshotId !== null && !isUuid(item.snapshotId))
      || (item.errorCode !== null && !isFailureCode(item.errorCode))) {
      return null;
    }
    recentSupplements.push({
      runId: item.runId.toLowerCase(),
      baseRunId: item.baseRunId ? item.baseRunId.toLowerCase() : null,
      uploadId: item.uploadId.toLowerCase(),
      status: item.status,
      submittedAt: item.submittedAt,
      finishedAt: item.finishedAt,
      snapshotId: item.snapshotId ? item.snapshotId.toLowerCase() : null,
      errorCode: item.errorCode,
    });
  }
  if (uploadRules.bucket !== 'analysis-uploads' || uploadRules.accept !== 'application/pdf'
    || typeof uploadRules.maxBytes !== 'number' || !Number.isSafeInteger(uploadRules.maxBytes) || uploadRules.maxBytes <= 0
    || uploadRules.sameNoticeRequired !== true) {
    return null;
  }
  return {
    contractVersion: 'upload-supplement-context/v1',
    analysisId: analysisId.toLowerCase(),
    runId: runId.toLowerCase(),
    runStatus,
    snapshotId: snapshotId ? snapshotId.toLowerCase() : null,
    eligible,
    needsSupplement,
    target: { title, noticeSource, houseManageNo, noticeNo, edition, modelNo, houseType, room },
    reasonCodes,
    documents,
    issues,
    currentSupplement,
    recentSupplements,
    uploadRules: {
      bucket: 'analysis-uploads',
      accept: 'application/pdf',
      maxBytes: uploadRules.maxBytes,
      sameNoticeRequired: true,
    },
  };
}

export async function readUploadSupplementOperation(
  request: Request,
  target: { kind: 'base'; analysisId: string; runId: string } | { kind: 'run'; analysisId: string; runId: string },
): Promise<UploadSupplementOperation> {
  const url = new URL(request.url);
  if (url.search || !isUuid(target.analysisId) || !isUuid(target.runId)) {
    throw new ApiError('invalid_upload_supplement_input');
  }
  const analysisId = target.analysisId.toLowerCase();
  const runId = target.runId.toLowerCase();
  if (target.kind === 'run') {
    return { action: 'get', analysisId, runId };
  }
  if (request.method === 'GET') {
    return { action: 'context', analysisId, runId };
  }
  const key = request.headers.get('idempotency-key');
  if (!isUuid(key)) throw new ApiError('invalid_upload_supplement_input');
  const body = await readJsonRequest(request, 'invalid_upload_supplement_input');
  // 브라우저가 보낸 해시·채택 상태·공고 정보 등 추가 필드는 모두 거부한다.
  if (!isRecord(body) || Object.keys(body).length !== 1 || !isUuid(body.uploadId)) {
    throw new ApiError('invalid_upload_supplement_input');
  }
  return {
    action: 'enqueue',
    analysisId,
    baseRunId: runId,
    uploadId: body.uploadId.toLowerCase(),
    idempotencyKey: key.toLowerCase(),
  };
}
