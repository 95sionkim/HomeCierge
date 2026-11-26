// 게스트용 합성 공고와 납부 기준. 판정과 금액 계산은 로그인 경로와 같은 함수를 사용한다.
import { evaluateNoticeSearch, parseNoticeSearchConditions } from '../server/notice-search.js';
import { calculateFundingPlan } from '../server/funding-plan.js';
import { projectSavedReport } from '../server/saved-report.js';
export { conversationExample, conditionEditExample } from '../server/analysis-conversation.js';

export const regions = [
  { code: '99999', name: '합성시 가람구' },
  { code: '99998', name: '합성시 누리구' },
];
const first = '9900000101';
const period = { start: '2026-10-01', end: '2026-11-22' };
const documentRef = (page: number) => ({
  document: 'applyhome:' + first + ':' + first + ':1:1',
  version: 'sha256:' + 'a'.repeat(64),
  page,
});
const base = {
  edition: '2026-10-30',
  regionCode: '99999',
  application: { start: '2026-11-20', end: '2026-11-22' },
  moveIn: { start: '2028-02', end: '2028-03' },
};
const index = {
  contractVersion: 'notice-search-index/v1',
  dataOrigin: 'synthetic',
  observedAt: '2026-11-22T09:00:00+09:00',
  publicationWindow: period,
  regionCodes: ['99998', '99999'],
  coverage: {
    status: 'complete',
    sources: [
      { source: 'applyhome_apt', status: 'complete' },
      { source: 'applyhome_remainder', status: 'complete' },
    ],
  },
  notices: [
    {
      ...base,
      houseManageNo: first,
      noticeNo: first,
      title: '합성 가람 아파트',
      kind: 'new_sale',
      inventoryComplete: true,
      models: [
        {
          modelNo: '01',
          houseType: '084.0000A',
          supplyAreaM2: '112.40',
          areaEvidence: [documentRef(4)],
          rooms: [
            {
              room: '101동 101호',
              subtotalWon: '710000000',
              priceEvidence: [documentRef(7), documentRef(8)],
            },
            { room: '101동 102호', subtotalWon: null, priceEvidence: [] },
          ],
        },
      ],
      sourceIds: ['applyhome_apt', 'applyhome_apt_model', 'applyhome_notice_pdf'],
      reasonCodes: [],
    },
    {
      ...base,
      houseManageNo: '9900000102',
      noticeNo: '9900000102',
      title: '합성 누리 잔여세대',
      application: { start: '2026-11-24', end: '2026-11-25' },
      kind: 'remaining',
      inventoryComplete: false,
      models: [],
      sourceIds: ['applyhome_remainder'],
      reasonCodes: ['model_unverified', 'inventory_incomplete'],
    },
  ],
};
export function searchExample(input: unknown) {
  const conditions = parseNoticeSearchConditions(input);
  if (!conditions) throw new Error('invalid_search_input');
  return evaluateNoticeSearch(index, conditions, period.end);
}

export const sampleAnalysis = 'b0000000-0000-4000-8000-000000000001';
export const sampleSnapshot = 'b0000000-0000-4000-8000-000000000002';
// 로그인 전 보고서도 같은 화면 변환을 거치며 합성 분석의 수치와 보류 상태를 보존한다.
export function reportExample(comparison: { dataOrigin?: unknown; conditions?: { asOf?: string }; collections?: { collectedAt?: string }[] }) {
  if (comparison.dataOrigin !== 'synthetic') throw new Error('expected_synthetic_report');
  const queriedAt = comparison.collections?.map(row => row.collectedAt).filter((v): v is string => !!v).sort().at(-1)
    ?? (comparison.conditions?.asOf ?? '2026-11-10') + 'T00:00:00Z';
  return projectSavedReport({ contractVersion:'report-snapshot/v1',analysisId:sampleAnalysis,snapshotId:sampleSnapshot,
    runId:'b0000000-0000-4000-8000-000000000005',reportId:'b0000000-0000-4000-8000-000000000006',
    version:1,dataOrigin:'synthetic',createdAt:queriedAt,queriedAt,rulesVersion:'comparison/v1',
    sections:{
      comparison:{status:'available',sources:[],exportAllowed:true,value:comparison},
      funding:{status:'room_unselected',sources:[],exportAllowed:true,value:null},
      law:{status:'available',sources:[],exportAllowed:true,value:{analysisId:sampleAnalysis,snapshotId:sampleSnapshot,
        dataOrigin:'synthetic',noticeDate:null,noticeSource:'applyhome_apt',status:'synthetic_input',reference:null}},
    } });
}
export const sampleFunds = [
  {
    id: 'b0000000-0000-4000-8000-000000000003',
    kind: 'current',
    amountWon: '50000000',
    availableOn: '2026-10-01',
    certainty: 'confirmed',
  },
  {
    id: 'b0000000-0000-4000-8000-000000000004',
    kind: 'additional',
    amountWon: '4000000',
    availableOn: '2026-10-20',
    certainty: 'expected',
  },
];
function schedule(room: string, item: string, totalWon: string, page: number) {
  const evidence = [{ document: 'synthetic-notice-pdf', version: 'synthetic-v1', page }];
  const deposit = BigInt(totalWon) / 10n;
  const exact = (date: string) => ({ date, trigger: 'calendar_date', dateStatus: 'exact', evidence });
  const balanceTiming =
    room === '101동 102호'
      ? {
          date: null,
          trigger: 'move_in',
          dateStatus: 'relative',
          evidence: [],
        }
      : exact('2026-11-30');
  return {
    room,
    modelNo: '01',
    houseType: '084.0000A',
    item,
    status: 'confirmed',
    totalWon,
    reasons: [],
    evidence,
    installments: [
      { stage: 'deposit', won: deposit.toString(), timing: exact('2026-10-20') },
      { stage: 'balance', won: (BigInt(totalWon) - deposit).toString(), timing: balanceTiming },
    ],
  };
}
export function fundingExample(room: string, funds: unknown) {
  const firstRoom = room === '101동 101호';
  const known = firstRoom || room === '101동 102호';
  const schedules = known ? [schedule(room, 'sale_price', firstRoom ? '700000000' : '720000000', 7)] : [];
  if (firstRoom) schedules.push(schedule(room, 'required_options', '10000000', 8));
  return calculateFundingPlan({
    analysisId: sampleAnalysis,
    snapshotId: sampleSnapshot,
    modelNo: '01',
    room,
    dataOrigin: 'synthetic',
    scheduleStatus: known ? 'available' : 'unavailable',
    schedules,
    funds,
  });
}
