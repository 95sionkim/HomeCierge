import { ApiError, isUuid, readBody, readJsonRequest, uuidPattern } from './http-input.js';
export { uuidPattern };
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
    comparables, targetReferences, candidatePool, holds, exclusions } = value.result;
  if (contractVersion !== 'comparison/v1' || (dataOrigin !== 'synthetic' && dataOrigin !== 'collected')
    || (completeness !== 'complete' && completeness !== 'partial' && completeness !== 'unavailable')
    || (appliedScope !== null && appliedScope !== 'priority' && appliedScope !== 'expansion')
    || typeof rankingComplete !== 'boolean'
    || (target !== null && !isRecord(target)) || !isRecord(conditions)
    || (noticePrice !== null && !isRecord(noticePrice))
    || ((target === null || noticePrice === null) && completeness !== 'unavailable')
    || !isRecord(regionDecision) || !isRecord(tradeKinds) || !Array.isArray(collections)
    || !Array.isArray(comparables) || comparables.length > 5 || !Array.isArray(targetReferences)
    || (candidatePool !== undefined && !Array.isArray(candidatePool))
    || !Array.isArray(holds) || !Array.isArray(exclusions)) return null;
  const candidateIds = new Set<string>();
  for (const candidate of comparables) {
    if (!isRecord(candidate) || typeof candidate.complexId !== 'string' || !candidate.complexId
      || candidateIds.has(candidate.complexId) || appliedScope === null || completeness === 'unavailable') return null;
    candidateIds.add(candidate.complexId);
  }
  if (targetReferences.some(row => !isRecord(row) || typeof row.complexId !== 'string'
    || candidateIds.has(row.complexId))) return null;
  const resolvedOrigin: 'synthetic' | 'collected' = dataOrigin;
  return { analysisId, runId, snapshotId: value.snapshotId, rulesVersion: value.rulesVersion,
    result: { contractVersion: 'comparison/v1' as const, dataOrigin: resolvedOrigin, completeness, appliedScope, rankingComplete, target, conditions, noticePrice,
      regionDecision, tradeKinds, collections, comparables, targetReferences,
      ...(candidatePool !== undefined ? { candidatePool } : {}), holds, exclusions } };
}

export type ComparisonSnapshot = NonNullable<ReturnType<typeof parseComparisonSnapshot>>;

export type EvidenceDocumentDetail = {
  id: string;
  version: string;
  versionShort: string;
  source: 'official' | 'upload' | 'unknown';
  originCheck: 'confirmed' | 'unverified' | 'conflict' | 'unknown';
  status: 'accepted' | 'held' | 'rejected' | 'unknown';
  reasons: string[];
  houseManageNo: string | null;
  noticeNo: string | null;
  edition: string | null;
  officialUrl: string | null;
  uploadId: string | null;
  uploadContentPath: string | null;
  uploadStatus: 'registered' | 'deleted' | 'unavailable' | null;
};

export type EvidenceTradeObservation = {
  recordId: string;
  source: 'apt_trade' | 'apt_rights';
  page: number;
  position: number;
  tradeKind: 'sale' | 'presale_right' | 'occupancy_right' | null;
  contractDate: string | null;
  amountWon: string | null;
  exclusiveAreaM2: string | null;
  floor: string | null;
  buildYear: string | null;
  dealingGbn: string | null;
  cancellationStatus: 'cancelled' | 'not_marked' | 'unverified' | null;
  cancellationDate: string | null;
  identifiers: Record<string, string>;
};

export type ComparisonEvidenceDetail = {
  contractVersion: 'comparison-evidence-detail/v1';
  analysisId: string;
  runId: string;
  snapshotId: string;
  dataOrigin: 'synthetic' | 'collected';
  noticeLink: string | null;
  documents: EvidenceDocumentDetail[];
  tradeObservations: EvidenceTradeObservation[];
};

const officialDocIdPattern = /^applyhome:([0-9]{10}):([0-9]{10}):([0-9]{1,20}):([0-9]{1,20})$/;
const uploadDocIdPattern = new RegExp(`^upload:(${uuidPattern})$`, 'i');
const sha256VersionPattern = /^sha256:([0-9a-f]{13,})$/i;
const hexVersionPattern = /^[0-9a-f]{16,}$/i;
const safeNoticePaths = new Set([
  '/ai/aia/selectAPTLttotPblancDetail.do',
  '/ai/aia/selectAPTRemndrLttotPblancDetailView.do',
]);
const tradeIdentifierAllowlist = [
  'aptNm', 'aptSeq', 'aptDong', 'sggCd', 'sggNm', 'umdCd', 'umdNm',
  'jibun', 'bonbun', 'bubun', 'roadNm', 'roadNmBonbun', 'roadNmBubun',
] as const;

function nonEmptyText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function shortenDocumentVersion(version: string): string {
  const sha = version.match(sha256VersionPattern);
  if (sha) return `sha256:${sha[1]!.slice(0, 12)}…`;
  if (hexVersionPattern.test(version)) return `${version.slice(0, 12)}…`;
  if (version.length > 24) return `${version.slice(0, 20)}…`;
  return version;
}

function safeOfficialNoticeLink(link: unknown, dataOrigin: 'synthetic' | 'collected'): string | null {
  if (dataOrigin !== 'collected' || !isRecord(link)) return null;
  if (link.status !== 'reported' || link.kind !== 'notice_page' || typeof link.value !== 'string') return null;
  try {
    const parsed = new URL(link.value);
    if (parsed.origin !== 'https://www.applyhome.co.kr' || !safeNoticePaths.has(parsed.pathname)
      || parsed.username || parsed.password || parsed.hash) return null;
    return parsed.origin + parsed.pathname + parsed.search;
  } catch {
    return null;
  }
}

function officialAttachmentUrl(
  docId: string,
  dataOrigin: 'synthetic' | 'collected',
  source: EvidenceDocumentDetail['source'],
  originCheck: EvidenceDocumentDetail['originCheck'],
  target: Record<string, unknown> | null,
): string | null {
  if (dataOrigin !== 'collected' || source !== 'official' || originCheck !== 'confirmed' || !target) return null;
  const match = docId.match(officialDocIdPattern);
  if (!match) return null;
  const [, houseManageNo, pblancNo, seqNo, sn] = match;
  if (target.houseManageNo !== houseManageNo || target.noticeNo !== pblancNo) return null;
  const params = new URLSearchParams({
    houseManageNo: houseManageNo!,
    pblancNo: pblancNo!,
    atchmnflSeqNo: seqNo!,
    atchmnflSn: sn!,
  });
  return `https://static.applyhome.co.kr/ai/aia/getAtchmnfl.do?${params.toString()}`;
}

function parseUploadDocId(docId: string): string | null {
  const match = docId.match(uploadDocIdPattern);
  return match ? match[1]!.toLowerCase() : null;
}

function collectCitedDocRefs(result: ComparisonSnapshot['result']): Array<{ document: string; version: string }> {
  const refs: Array<{ document: string; version: string }> = [];
  const pushFrom = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (isRecord(item) && typeof item.document === 'string' && item.document
        && typeof item.version === 'string' && item.version) {
        refs.push({ document: item.document, version: item.version });
      }
    }
  };
  if (isRecord(result.target) && isRecord(result.target.supplyArea)) {
    pushFrom(result.target.supplyArea.evidence);
  }
  if (isRecord(result.noticePrice) && Array.isArray(result.noticePrice.confirmedRooms)) {
    for (const room of result.noticePrice.confirmedRooms) {
      if (isRecord(room) && isRecord(room.evidence)) {
        pushFrom(room.evidence.salePrice);
        pushFrom(room.evidence.requiredOptions);
      }
    }
  }
  return refs;
}

export function extractComparisonUploadIds(snapshot: ComparisonSnapshot, resultSnapshot: unknown): string[] {
  const ids = new Set<string>();
  const maybeAdd = (docId: unknown, source?: unknown) => {
    if (typeof docId !== 'string') return;
    if (source !== undefined && source !== 'upload') return;
    const uploadId = parseUploadDocId(docId);
    if (uploadId) ids.add(uploadId);
  };
  if (isRecord(resultSnapshot) && isRecord(resultSnapshot.catalog) && Array.isArray(resultSnapshot.catalog.documents)) {
    for (const doc of resultSnapshot.catalog.documents) {
      if (isRecord(doc)) maybeAdd(doc.id, doc.source);
    }
  }
  for (const ref of collectCitedDocRefs(snapshot.result)) {
    maybeAdd(ref.document);
  }
  return [...ids];
}

function locatorKey(recordId: unknown, source: unknown, page: unknown, position: unknown): string | null {
  if (typeof recordId !== 'string' || !recordId || (source !== 'apt_trade' && source !== 'apt_rights')
    || typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1
    || typeof position !== 'number' || !Number.isSafeInteger(position) || position < 1) {
    return null;
  }
  return `${recordId}\0${source}\0${page}\0${position}`;
}

function collectReferencedTradeLocators(result: ComparisonSnapshot['result']): Set<string> {
  const keys = new Set<string>();
  const addRef = (ref: unknown) => {
    if (!isRecord(ref)) return;
    const key = locatorKey(ref.recordId, ref.source, ref.page, ref.position);
    if (key) keys.add(key);
  };
  for (const group of [result.comparables, result.targetReferences]) {
    for (const candidate of group) {
      if (!isRecord(candidate) || !isRecord(candidate.tradeStats)) continue;
      for (const stat of Object.values(candidate.tradeStats)) {
        if (!isRecord(stat) || !Array.isArray(stat.observations)) continue;
        for (const obs of stat.observations) addRef(obs);
      }
    }
  }
  for (const row of result.exclusions) {
    if (isRecord(row)) addRef(row.reference);
  }
  for (const hold of result.holds) {
    if (!isRecord(hold)) continue;
    addRef(hold.reference);
    if (Array.isArray(hold.references)) {
      for (const ref of hold.references) addRef(ref);
    }
  }
  return keys;
}

export type SnapshotEvidenceRow = {
  id: string;
  analysis_id: string;
  data_origin: string;
  result_snapshot: unknown;
};

export type UploadRegistrationRow = {
  id: string;
  status: string;
};

export function buildComparisonEvidenceDetail(
  snapshot: ComparisonSnapshot,
  snapRow: SnapshotEvidenceRow | null,
  uploadRows: UploadRegistrationRow[],
): ComparisonEvidenceDetail | null {
  if (snapRow) {
    if (snapRow.id !== snapshot.snapshotId || snapRow.analysis_id !== snapshot.analysisId
      || snapRow.data_origin !== snapshot.result.dataOrigin) {
      return null;
    }
  }
  const resultSnapshot = snapRow && isRecord(snapRow.result_snapshot) ? snapRow.result_snapshot : null;
  const catalog = resultSnapshot && isRecord(resultSnapshot.catalog) ? resultSnapshot.catalog : null;
  const notice = catalog && isRecord(catalog.notice) ? catalog.notice : null;
  const target = isRecord(snapshot.result.target) ? snapshot.result.target : null;
  const uploadMap = new Map<string, string>();
  for (const row of uploadRows) {
    if (isUuid(row.id) && typeof row.status === 'string') {
      uploadMap.set(row.id.toLowerCase(), row.status);
    }
  }

  const documents: EvidenceDocumentDetail[] = [];
  const seenDocs = new Set<string>();
  const addDocument = (
    id: string,
    version: string,
    source: EvidenceDocumentDetail['source'],
    originCheck: EvidenceDocumentDetail['originCheck'],
    status: EvidenceDocumentDetail['status'],
    reasons: string[],
    houseManageNo: string | null,
    noticeNo: string | null,
    edition: string | null,
  ) => {
    const key = `${id}\0${version}`;
    if (seenDocs.has(key)) return;
    seenDocs.add(key);
    const parsedUploadId = source === 'upload' || (source === 'unknown' && uploadDocIdPattern.test(id))
      ? parseUploadDocId(id)
      : null;
    let uploadId: string | null = null;
    let uploadContentPath: string | null = null;
    let uploadStatus: EvidenceDocumentDetail['uploadStatus'] = null;
    if (parsedUploadId) {
      const regStatus = uploadMap.get(parsedUploadId);
      if (regStatus === 'registered') {
        uploadId = parsedUploadId;
        uploadContentPath = `/api/v1/analyses/${snapshot.analysisId}/uploads/${parsedUploadId}/content`;
        uploadStatus = 'registered';
      } else if (regStatus === 'deleted') {
        uploadStatus = 'deleted';
      } else {
        uploadStatus = 'unavailable';
      }
    }
    documents.push({
      id,
      version,
      versionShort: shortenDocumentVersion(version),
      source,
      originCheck,
      status,
      reasons,
      houseManageNo,
      noticeNo,
      edition,
      officialUrl: officialAttachmentUrl(id, snapshot.result.dataOrigin, source, originCheck, target),
      uploadId,
      uploadContentPath,
      uploadStatus,
    });
  };

  if (catalog && Array.isArray(catalog.documents)) {
    for (const rawDoc of catalog.documents) {
      if (!isRecord(rawDoc)) continue;
      const id = nonEmptyText(rawDoc.id);
      const version = nonEmptyText(rawDoc.version);
      if (!id || !version) continue;
      const source = rawDoc.source === 'official' || rawDoc.source === 'upload' ? rawDoc.source : 'unknown';
      const originCheck = rawDoc.originCheck === 'confirmed' || rawDoc.originCheck === 'unverified'
        || rawDoc.originCheck === 'conflict' ? rawDoc.originCheck : 'unknown';
      const status = rawDoc.status === 'accepted' || rawDoc.status === 'held' || rawDoc.status === 'rejected'
        ? rawDoc.status : 'unknown';
      const reasons = Array.isArray(rawDoc.reasons)
        ? rawDoc.reasons.filter((r): r is string => typeof r === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(r))
        : [];
      addDocument(
        id,
        version,
        source,
        originCheck,
        status,
        reasons,
        nonEmptyText(rawDoc.houseManageNo),
        nonEmptyText(rawDoc.noticeNo),
        nonEmptyText(rawDoc.edition),
      );
    }
  }

  for (const ref of collectCitedDocRefs(snapshot.result)) {
    addDocument(
      ref.document,
      ref.version,
      parseUploadDocId(ref.document) ? 'upload' : 'unknown',
      'unknown',
      'unknown',
      [],
      nonEmptyText(target?.houseManageNo),
      nonEmptyText(target?.noticeNo),
      nonEmptyText(target?.edition),
    );
  }

  const wantedLocators = collectReferencedTradeLocators(snapshot.result);
  const tradeObservations: EvidenceTradeObservation[] = [];
  const seenObs = new Set<string>();
  if (resultSnapshot && Array.isArray(resultSnapshot.tradeBatches) && wantedLocators.size > 0) {
    for (const batch of resultSnapshot.tradeBatches) {
      if (!isRecord(batch) || !isRecord(batch.record) || !Array.isArray(batch.trades)) continue;
      const recordId = batch.record.recordId;
      const source = batch.record.source;
      if (typeof recordId !== 'string' || (source !== 'apt_trade' && source !== 'apt_rights')) continue;
      for (const row of batch.trades) {
        if (!isRecord(row) || !isRecord(row.provenance)) continue;
        const page = row.provenance.page;
        const position = row.provenance.position;
        const key = locatorKey(recordId, source, page, position);
        if (!key || !wantedLocators.has(key) || seenObs.has(key)) continue;
        seenObs.add(key);
        const tradeKind = row.tradeKind === 'sale' || row.tradeKind === 'presale_right'
          || row.tradeKind === 'occupancy_right' ? row.tradeKind : null;
        const contractObj = isRecord(row.contractDate) ? row.contractDate : null;
        const contractDate = contractObj?.status === 'parsed' && typeof contractObj.date === 'string'
          ? contractObj.date : null;
        const amountObj = isRecord(row.amount) ? row.amount : null;
        const amountWon = amountObj?.status === 'parsed' && typeof amountObj.won === 'string'
          ? amountObj.won : null;
        const areaObj = isRecord(row.exclusiveArea) ? row.exclusiveArea : null;
        const exclusiveAreaM2 = areaObj?.status === 'parsed' && typeof areaObj.m2 === 'string'
          ? areaObj.m2 : null;
        const attrs = isRecord(row.attributes) ? row.attributes : null;
        const cancelObj = isRecord(row.cancellation) ? row.cancellation : null;
        const cancellationStatus = cancelObj?.status === 'cancelled' || cancelObj?.status === 'not_marked'
          || cancelObj?.status === 'unverified' ? cancelObj.status : null;
        const cdealDay = cancelObj && isRecord(cancelObj.cdealDay) ? cancelObj.cdealDay : null;
        const cancellationDate = cdealDay?.state === 'date' ? nonEmptyText(cdealDay.value) : null;
        const identifiers: Record<string, string> = {};
        if (isRecord(row.identifiers)) {
          for (const field of tradeIdentifierAllowlist) {
            const val = nonEmptyText(row.identifiers[field]);
            if (val !== null) identifiers[field] = val;
          }
        }
        tradeObservations.push({
          recordId,
          source,
          page: page as number,
          position: position as number,
          tradeKind,
          contractDate,
          amountWon,
          exclusiveAreaM2,
          floor: nonEmptyText(attrs?.floor),
          buildYear: nonEmptyText(attrs?.buildYear),
          dealingGbn: nonEmptyText(attrs?.dealingGbn),
          cancellationStatus,
          cancellationDate,
          identifiers,
        });
      }
    }
  }

  return {
    contractVersion: 'comparison-evidence-detail/v1',
    analysisId: snapshot.analysisId,
    runId: snapshot.runId,
    snapshotId: snapshot.snapshotId,
    dataOrigin: snapshot.result.dataOrigin,
    noticeLink: safeOfficialNoticeLink(notice?.link, snapshot.result.dataOrigin),
    documents,
    tradeObservations,
  };
}

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
