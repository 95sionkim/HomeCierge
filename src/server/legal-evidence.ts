import { isDate, isPublicLabel, isTimestamp, koreaDate } from './public-fields.js';

const title = '주택공급에 관한 규칙';
const housingRuleId = '008243';
const holdActions = {
  version_unverified: 'check_historical_version',
  notice_date_unverified: 'verify_notice_date',
  selection_unverified: 'verify_notice_identity',
  source_restricted: 'check_source_permissions',
  synthetic_input: 'select_collected_notice',
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('invalid_legal_evidence_response');
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,20}$/.test(value) && /[1-9]/.test(value);
}

function revisionHistory(lawId: string) {
  const url = new URL('https://www.law.go.kr/LSW/lsRvsDocListP.do');
  url.search = new URLSearchParams({ lsId: lawId, lsRvsGubun: 'all', chrClsCd: '010202' }).toString();
  return url.href;
}

// 공식 법령 화면 주소를 검증된 판본과 시행일로 구성한다.
function readReference(value: unknown, asOf: string) {
  requireValid(isObject(value));
  const { contractVersion, dataOrigin, observedAt, mst, lawId, promulgatedOn, effectiveOn, articles } = value;
  requireValid(contractVersion === 'law-reference/v1' && dataOrigin === 'collected'
    && value.title === title && value.asOf === asOf && isTimestamp(observedAt)
    && asOf <= koreaDate.format(new Date(observedAt)) && identifier(mst) && identifier(lawId)
    && isDate(promulgatedOn) && promulgatedOn <= asOf && isDate(effectiveOn) && effectiveOn <= asOf
    && Array.isArray(articles) && articles.length > 0 && articles.length <= 64);
  const seen = new Set<string>();
  const checked = articles.map((article: unknown) => {
    requireValid(isObject(article));
    const { number, branch, heading } = article;
    requireValid(typeof number === 'string' && /^[1-9][0-9]{0,3}$/.test(number)
      && (branch === null || (typeof branch === 'string' && /^[1-9][0-9]?$/.test(branch)))
      && isPublicLabel(heading, 320) && [...heading].length <= 160 && !/[<>]|\bOC\b\s*[:=]/i.test(heading));
    const label = `제${number}조${branch === null ? '' : '의' + branch}`;
    requireValid(!seen.has(label));
    seen.add(label);
    return { number, branch, label, heading };
  });
  const url = new URL('https://www.law.go.kr/LSW/lsInfoP.do');
  url.searchParams.set('lsiSeq', mst);
  url.searchParams.set('efYd', effectiveOn.replaceAll('-', ''));
  return { title, lawId, mst, promulgatedOn, effectiveOn, observedAt, sourceName: '법제처 국가법령정보센터',
    sourceUrl: url.href, articles: checked };
}

export function readLegalEvidence(value: unknown, analysisId: string, snapshotId: string) {
  requireValid(isObject(value) && value.analysisId === analysisId && value.snapshotId === snapshotId);
  const { dataOrigin, noticeDate, noticeSource, status } = value;
  requireValid((dataOrigin === 'collected' || dataOrigin === 'synthetic')
    && (noticeDate === null || isDate(noticeDate))
    && (noticeSource === 'applyhome_apt' || noticeSource === 'applyhome_remainder'));
  const base = { contractVersion: 'legal-evidence/v1', analysisId, snapshotId, dataOrigin, noticeSource, noticeDate,
    personalEligibility: 'not_assessed', exceptions: 'requires_review', transitionalProvisions: 'requires_review' };
  if (status === 'available') {
    requireValid(dataOrigin === 'collected' && noticeDate !== null);
    const reference = readReference(value.reference, noticeDate);
    const nextActions = ['read_original', 'check_notice_conditions', 'check_supplementary_provisions'];
    if (noticeSource === 'applyhome_remainder') nextActions.push('check_original_and_reissued_notices');
    return { ...base, status, reference, historyUrl: revisionHistory(reference.lawId), nextActions };
  }
  requireValid(typeof status === 'string' && Object.hasOwn(holdActions, status) && value.reference === null);
  if (status === 'version_unverified') requireValid(dataOrigin === 'collected' && noticeDate !== null);
  if (status === 'synthetic_input') requireValid(dataOrigin === 'synthetic');
  if (status === 'notice_date_unverified' || status === 'selection_unverified') requireValid(noticeDate === null);
  return { ...base, status, reference: null, historyUrl: status === 'version_unverified' ? revisionHistory(housingRuleId) : null,
    nextActions: [holdActions[status as keyof typeof holdActions]] };
}
