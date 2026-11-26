// 보관된 보고서 v1의 계산과 문구를 화면과 PDF에서 공유한다.
import { parseComparisonSnapshot } from './analysis-runs.js';
import type { ComparisonSnapshot } from './analysis-runs.js';
import { calculateFundingPlan } from './funding-plan.js';
import { readLegalEvidence } from './legal-evidence.js';
import { isDate, isPublicLabel, isTimestamp } from './public-fields.js';
import { isUuid } from './http-input.js';
import { noticeRange, priceLabel, reasonText, tradeRange, won } from '../../public/app/comparison-values.js';

const titles = {
  notice: '공고 요약',
  comparison: '주변 실거래 비교',
  funding: '호실 자금표',
  law: '법령 근거',
  news: '지역 뉴스',
  commute: '출퇴근 경로',
  evidence: '자료 출처와 확인할 항목',
} as const;
type Id = keyof typeof titles;
type State = 'confirmed' | 'partial' | 'held' | 'reference';
export type ReportSection = {
  id: Id;
  title: string;
  state: State;
  exportAllowed: boolean;
  rows: { label: string; value: string }[];
  tables: { headers: string[]; rows: string[][] }[];
  notes: string[];
};
export type SavedReport = {
  contractVersion: 'saved-report/v1';
  reportId: string;
  analysisId: string;
  runId: string;
  snapshotId: string;
  version: number;
  createdAt: string;
  queriedAt: string;
  dataOrigin: 'synthetic' | 'collected';
  title: string;
  sections: ReportSection[];
};
type Obj = Record<string, unknown>;
type Comparison = ComparisonSnapshot['result'];

const trades: Record<string, string> = { sale: '아파트 매매', presale_right: '분양권', occupancy_right: '입주권' };
const sources: Record<string, string> = {
  applyhome_apt: '청약홈 아파트 공고',
  applyhome_remainder: '청약홈 잔여세대 공고',
  applyhome_apt_model: '청약홈 아파트 주택형',
  applyhome_remainder_model: '청약홈 잔여세대 주택형',
  applyhome_notice_pdf: '청약홈 모집공고문',
  apt_trade: '국토교통부 아파트 매매 실거래',
  apt_rights: '국토교통부 분양권·입주권 실거래',
  law_eflaw: '국가법령정보센터',
  mois_legal_region_codes: '행정안전부 법정동코드',
};
const reasons: Record<string, string> = {
  opening_balance_missing: '보유 잔액과 기준일 확인 필요',
  payment_before_opening: '잔액 기준일보다 이른 납부',
  opening_date_inflow_overlap: '기준일 입금의 잔액 포함 여부 미확인',
  opening_date_payment_order_unverified: '기준일 잔액과 납부 순서 미확인',
  payment_schedule_incomplete: '납부 일정 일부 미확인',
  payment_date_unverified: '납부 날짜 미확인',
  subtotal_out_of_range: '합산할 수 있는 금액 범위 초과',
  cancelled_trade: '해제 거래 제외',
  outside_contract_period: '계약 기간 밖의 거래 제외',
  outside_supply_area: '공급면적 범위 밖의 거래 제외',
  target_complex_trade: '대상 단지 자체 거래 분리',
  version_unverified: '공고일에 시행된 법령 판본 확인 필요',
  synthetic_input: '합성 자료에서는 실제 법령 판본을 조회하지 않습니다.',
  notice_date_unverified: '공고일을 확인해야 합니다.',
  source_restricted: '이 자료의 이용 조건을 확인 중입니다.',
  selection_unverified: '선택한 공고 또는 호실의 연결 근거를 확인해야 합니다.',
};
function obj(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function check(ok: unknown): asserts ok {
  if (!ok) throw new Error('invalid_saved_report');
}
function label(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return isPublicLabel(text, 240) ? text : null;
}
function token(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value) ? value : null;
}
function reason(value: unknown): string | null {
  const code = token(value);
  if (!code) return null;
  return reasonText(code) ?? (Object.hasOwn(reasons, code) ? reasons[code] : '추가 확인 필요 (' + code + ')');
}
function sourceName(value: unknown) {
  const key = token(value);
  return key && (Object.hasOwn(sources, key) ? sources[key] : key);
}
const number = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function area(value: unknown) {
  return typeof value === 'string' && /^\d{1,12}(?:\.\d{1,20})?$/.test(value) ? value + '㎡' : '미확인';
}
function section(id: Id, state: State, exportAllowed = true): ReportSection {
  return { id, title: titles[id], state, exportAllowed, rows: [], tables: [], notes: [] };
}
function field(s: ReportSection, name: string, value: string | null) {
  s.rows.push({ label: name, value: value ?? '미확인' });
}
function table(s: ReportSection, headers: string[], rows: string[][]) {
  if (rows.length) s.tables.push({ headers, rows });
}
function documentPages(items: unknown): string[] {
  return [
    ...new Set(
      array(items).flatMap((v) => {
        const ref = obj(v),
          id = token(ref.document),
          version = token(ref.version);
        if (!id || !version || !number(ref.page) || ref.page <= 0) return [];
        if (id.startsWith('upload:')) {
          return ['사용자 업로드 · ' + id.slice(7) + ' · ' + version + ' · ' + ref.page + '쪽'];
        }
        return [id + ' · ' + version + ' · ' + ref.page + '쪽'];
      }),
    ),
  ];
}

type Part = { status: string; value: unknown; exportAllowed: boolean; sources: string[]; identity: Obj };
function readPart(raw: unknown, forExport: boolean): Part {
  const p = obj(raw);
  check(
    typeof p.status === 'string' &&
      typeof p.exportAllowed === 'boolean' &&
      Array.isArray(p.sources) &&
      p.sources.every((id) => token(id) !== null),
  );
  const status = forExport && !p.exportAllowed && p.status === 'available' ? 'export_restricted' : p.status;
  return {
    status,
    value: status === 'available' ? p.value : null,
    identity: status === 'available' ? obj(p.identity) : {},
    exportAllowed: p.exportAllowed,
    sources: status === 'available' ? p.sources : [],
  };
}
function held(id: Id, p: Part) {
  const s = section(id, 'held', p.exportAllowed);
  s.notes.push(
    p.status === 'export_restricted'
      ? '이 항목은 출처의 PDF 내보내기 권한을 확인해야 합니다.'
      : p.status === 'room_unselected'
        ? '분석에서 호실을 선택하면 해당 호실의 납부 일정과 자금을 대조할 수 있습니다.'
        : p.status === 'selection_unverified'
          ? '선택한 호실의 근거를 확인해야 자금표를 작성할 수 있습니다.'
          : '이 항목은 출처의 이용 조건을 확인해야 열 수 있습니다.',
  );
  return s;
}
function comparisonSections(c: Comparison, p: Part) {
  const target = obj(c.target),
    price = obj(c.noticePrice),
    supply = obj(target.supplyArea);
  const identity = p.identity,
    conditions = c.conditions,
    period = obj(conditions.period);
  const notice = section('notice', 'partial', p.exportAllowed);
  field(notice, '공고', label(target.name) ?? label(identity.title));
  field(notice, '주택관리번호', token(target.houseManageNo) ?? token(identity.houseManageNo));
  field(notice, '공고번호', token(target.noticeNo) ?? token(identity.noticeNo));
  field(notice, '회차', label(target.edition) ?? label(identity.edition));
  if (isDate(identity.noticeDate)) field(notice, '모집공고일', identity.noticeDate);
  field(notice, '주택형', label(target.houseType));
  field(notice, '모델 번호', token(target.modelNo));
  field(notice, '호실', label(price.room) ?? (price.scope === 'confirmed_rooms' ? '호실 미지정' : '선택 미확인'));
  field(notice, '공급면적', supply.status === 'confirmed' ? area(supply.m2) : null);
  const range = noticeRange(price);
  field(
    notice,
    price.scope === 'selected_room' ? '선택 호실 소계' : '확인된 호실 소계 범위',
    range ? priceLabel(range) : null,
  );
  const relevantRooms = (rooms: unknown) =>
    array(rooms)
      .map(obj)
      .filter((r) => price.scope !== 'selected_room' || r.room === price.room);
  const heldRooms = relevantRooms(price.heldRooms);
  const roomRows = relevantRooms(price.confirmedRooms).map((r) => {
    return [label(r.room) ?? '호실 미확인', won(r.salePriceWon), won(r.requiredOptionsWon), won(r.subtotalWon)];
  });
  for (const r of heldRooms) {
    roomRows.push([
      label(r.room) ?? '호실 미확인',
      '—',
      '—',
      array(r.reasons).map(reason).filter(Boolean).join(' · ') || '소계 미확인',
    ]);
  }
  table(notice, ['호실', '분양가', '필수 옵션', '소계 또는 보류 사유'], roomRows);
  notice.notes.push(
    '소계는 분양가와 필수 옵션을 합한 금액입니다. 취득세·등기비·금융비용은 별도로 확인해야 합니다.',
  );
  if (range && supply.status === 'confirmed' && !heldRooms.length) notice.state = 'confirmed';
  if (!range && supply.status !== 'confirmed') notice.state = 'held';

  const market = section(
    'comparison',
    c.completeness === 'complete' ? 'confirmed' : c.completeness === 'partial' ? 'partial' : 'held',
    p.exportAllowed,
  );
  const priority = obj(c.regionDecision.priority),
    expansion = obj(c.regionDecision.expansion);
  const expanded =
    c.appliedScope === 'expansion' &&
    priority.conclusion === 'normal_zero' &&
    priority.collectionStatus === 'complete' &&
    priority.screeningStatus === 'complete' &&
    priority.unresolvedRows === 0;
  field(
    market,
    '적용 지역',
    expanded ? label(expansion.name) : c.appliedScope === 'priority' ? label(priority.name) : '판정 보류',
  );
  if (expanded)
    market.notes.push(
      (label(priority.name) ?? '우선 지역') + '에서 조건에 맞는 주변 단지 0곳을 확인해 범위를 확대했습니다.',
    );
  field(market, '분석 기준일', isDate(conditions.asOf) ? conditions.asOf : null);
  field(
    market,
    '계약 기간',
    period.status === 'confirmed' && isDate(period.start) && isDate(period.end)
      ? period.start + ' ~ ' + period.end
      : null,
  );
  const bounds = obj(conditions.area);
  if (bounds.basis === 'supply')
    field(market, '비교 공급면적 범위', area(bounds.minM2) + ' ~ ' + area(bounds.maxM2));
  if (
    bounds.basis === 'supply' &&
    typeof bounds.tolerancePercent === 'string' &&
    /^\d+(\.\d+)?$/.test(bounds.tolerancePercent)
  )
    field(market, '공급면적 허용 차이', '±' + bounds.tolerancePercent + '%');
  const kinds = array(conditions.tradeKinds).filter(
    (k): k is string => typeof k === 'string' && Object.hasOwn(trades, k),
  );
  field(market, '거래 종류', kinds.map((k) => trades[k]).join(' · ') || null);
  if (!c.rankingComplete) market.notes.push('확인할 자료가 남아 있어 단지 순위를 확정하지 않았습니다.');
  for (const k of kinds) {
    const v = obj(c.tradeKinds[k]);
    if (v.conclusion === 'normal_zero' && v.collectionStatus === 'complete' && v.unresolvedRows === 0)
      market.notes.push(trades[k] + '는 적용한 범위에서 조건에 맞는 주변 거래 0건을 확인했습니다.');
    else if (v.conclusion === 'held' || v.collectionStatus === 'failed' || v.collectionStatus === 'partial')
      market.notes.push(trades[k] + '는 수집 상태 또는 거래 대응 근거를 확인해야 합니다.');
  }
  const stats = (rows: unknown[], kind: string) =>
    rows.flatMap((value) => {
      const cplx = obj(value);
      return kinds.flatMap((k) => {
        const stat = obj(obj(cplx.tradeStats)[k]);
        if (!Object.keys(stat).length) return [];
        const r = tradeRange(stat);
        return [
          [
            kind + ' · ' + (label(cplx.name) ?? '단지명 미확인'),
            area(cplx.supplyAreaM2),
            trades[k],
            r ? String(stat.count) + '건' : '미확인',
            r ? won(r.min) : '—',
            r ? won(r.mid) : '—',
            r ? won(r.max) : '—',
            r
              ? [stat.status === 'provisional' ? '잠정' : '확인', ...(stat.smallSample ? ['소표본'] : [])].join(
                  ' · ',
                )
              : '보류',
          ],
        ];
      });
    });
  table(
    market,
    ['단지', '공급면적', '거래', '건수', '최저', '중위', '최고', '상태'],
    [...stats(c.comparables, '주변'), ...stats(c.targetReferences, '자체 거래')],
  );
  table(
    market,
    ['비교 단지', '공급면적 차이', '대상과의 직선거리', '선정 순위'],
    c.comparables.map((value) => {
      const candidate = obj(value),
        distance = obj(candidate.distance);
      return [
        label(candidate.name) ?? '단지명 미확인',
        area(candidate.areaDifferenceM2),
        distance.status === 'confirmed' &&
        typeof distance.meters === 'number' &&
        Number.isFinite(distance.meters) &&
        distance.meters >= 0
          ? Math.round(distance.meters).toLocaleString('ko-KR') + 'm'
          : '미확인',
        c.rankingComplete && number(candidate.rank) && candidate.rank > 0 ? candidate.rank + '위' : '보류',
      ];
    }),
  );
  const evidence = section(
    'evidence',
    c.holds.length || c.completeness !== 'complete' ? 'partial' : 'confirmed',
    p.exportAllowed,
  );
  for (const source of p.sources) {
    const name = sourceName(source);
    if (name) field(evidence, '자료 출처', name);
  }
  const refs = new Set(documentPages(supply.evidence));
  for (const r of array(price.confirmedRooms))
    for (const group of ['salePrice', 'requiredOptions'])
      for (const ref of documentPages(obj(obj(r).evidence)[group])) refs.add(ref);
  for (const ref of refs) field(evidence, ref.startsWith('사용자 업로드 · ') ? '사용자 업로드 근거' : '공고문 판본·쪽', ref);
  const dataRows = c.collections.map((v) => {
    const item = obj(v);
    const states: Record<string, string> = {
      complete: '수집 완료',
      empty: '정상 빈 응답',
      partial: '부분 수집',
      failed: '수집 실패',
      missing: '미수집',
    };
    const state = String(item.status);
    return [
      sourceName(item.source) ?? '출처 미확인',
      label(item.requestRegionCode) ?? '미확인',
      label(item.month) ?? '미확인',
      isTimestamp(item.collectedAt) ? item.collectedAt : '시각 미확인',
      Object.hasOwn(states, state) ? states[state] : '상태 미확인',
    ];
  });
  table(evidence, ['수집 출처', '요청 지역', '계약월', '조회 시각', '상태'], dataRows);
  const counts = new Map<string, number>();
  for (const entries of [c.holds, c.exclusions])
    for (const v of entries) {
      const r = obj(v);
      const text = reason(r.reasonCode);
      if (text) counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  table(
    evidence,
    ['보류·제외 사유', '기록 수'],
    [...counts].map(([why, n]) => [why, String(n)]),
  );
  evidence.notes.push('거래 신고 지연과 정정·해제에 따라 이후 조회 결과가 달라질 수 있습니다.');
  return { notice, market, evidence };
}

function fundingSection(p: Part, analysisId: string, snapshotId: string): ReportSection {
  if (p.status !== 'available') return held('funding', p);
  const input = obj(p.value);
  check(input.analysisId === analysisId && input.snapshotId === snapshotId);
  const plan = calculateFundingPlan(input);
  const s = section(
    'funding',
    plan.status === 'complete' ? 'confirmed' : plan.status === 'partial' ? 'partial' : 'held',
    p.exportAllowed,
  );
  field(s, '선택 호실', plan.selection.room);
  field(s, '분양가와 필수 옵션 합계', plan.requiredTotalWon === null ? '확인 보류' : won(plan.requiredTotalWon));
  const why = (codes: string[]) => codes.map(reason).filter(Boolean).join(' · ');
  for (const r of plan.subtotalHoldReasons) {
    const msg = reason(r);
    if (msg) s.notes.push(msg);
  }
  table(
    s,
    ['자금', '기준일·입금일', '확정 여부', '금액'],
    plan.userInputs.funds.map((f) => [
      f.kind === 'current' ? '보유 잔액' : '추가 자금',
      f.availableOn,
      f.certainty === 'expected' ? '예상' : '확정',
      won(f.amountWon),
    ]),
  );
  const itemLabel = (s: string) => (s === 'sale_price' ? '분양가' : '필수 옵션');
  const stageNames = { deposit: '계약금', interim: '중도금', balance: '잔금' };
  table(
    s,
    ['항목', '납부 단계', '납부일', '금액'],
    plan.components.flatMap((c) =>
      c.installments.map((i) => [
        itemLabel(c.item),
        stageNames[i.stage],
        i.timing.date ?? '날짜 미확인',
        won(i.won),
      ]),
    ),
  );
  const componentFacts = plan.components.filter((c) => c.status !== 'missing');
  for (const c of componentFacts)
    field(s, itemLabel(c.item), c.totalWon === null ? why(c.reasons) || '확인 보류' : won(c.totalWon));
  for (const ref of documentPages(plan.evidence)) field(s, '납부 근거', ref);
  const rows = plan.rows.flatMap((day) =>
    (['confirmedOnly', 'includingExpected'] as const).map((k) => {
      const before = day.scenarios[k].beforeIncomingFunds,
        after = day.scenarios[k].afterIncomingFunds;
      return [
        day.date,
        won(day.knownDueWon),
        k === 'confirmedOnly' ? '확정 자금' : '예상 자금 포함',
        before.shortfallWon === null ? '보류' : won(before.shortfallWon),
        after.shortfallWon === null ? '보류' : won(after.shortfallWon),
        why([...new Set([...before.holdReasons, ...after.holdReasons])]) || '—',
      ];
    }),
  );
  table(s, ['납부일', '확인 납부액', '자금 기준', '입금 전 부족액', '입금 후 부족액', '보류 사유'], rows);
  if (!plan.userInputs.funds.length) s.notes.push('저장 시점에 입력한 자금이 없습니다.');
  if (plan.scheduleStatus !== 'available') s.notes.push('이 호실의 납부 일정을 확정할 근거가 부족합니다.');
  return s;
}
function lawSection(p: Part, analysisId: string, snapshotId: string) {
  if (p.status !== 'available') return held('law', p);
  const law = readLegalEvidence(p.value, analysisId, snapshotId);
  const s = section('law', law.reference ? 'reference' : 'held', p.exportAllowed);
  if (law.noticeDate) field(s, '공고일', law.noticeDate);
  if (law.reference) {
    const l = law.reference;
    field(s, '법령', l.title);
    field(s, '시행일', l.effectiveOn);
    field(s, '판본', l.mst);
    field(s, '조회 시각', l.observedAt);
    field(s, '법제처 원문', l.sourceUrl);
    table(
      s,
      ['조문', '제목'],
      l.articles.map((a) => [a.label, a.heading]),
    );
    s.notes.push('개인 신청 자격과 경과규정 적용 여부는 공고와 법령 원문에서 확인해야 합니다.');
  } else s.notes.push(reason(law.status) ?? '공고일에 적용되는 법령을 확인해야 합니다.');
  return s;
}
export function projectSavedReport(raw: unknown, forExport = false): SavedReport {
  const r = obj(raw);
  check(
    r.contractVersion === 'report-snapshot/v1' &&
      isUuid(r.reportId) &&
      isUuid(r.analysisId) &&
      isUuid(r.runId) &&
      isUuid(r.snapshotId) &&
      number(r.version) &&
      r.version > 0 &&
      isTimestamp(r.createdAt) &&
      isTimestamp(r.queriedAt) &&
      typeof r.rulesVersion === 'string' &&
      (r.dataOrigin === 'synthetic' || r.dataOrigin === 'collected'),
  );
  const parts = obj(r.sections);
  const part = readPart(parts.comparison, forExport);
  let title = '청약 분석 보고서';
  let notice, market, evidence;
  if (part.status === 'available') {
    const snapshot = parseComparisonSnapshot({ ...r, result: part.value }, r.analysisId, r.runId);
    check(snapshot && snapshot.result.dataOrigin === r.dataOrigin);
    ({ notice, market, evidence } = comparisonSections(snapshot.result, part));
    const name = label(snapshot.result.target?.name) ?? label(part.identity.title);
    if (name)
      title =
        name +
        (label(snapshot.result.target?.houseType) ? ' ' + label(snapshot.result.target?.houseType) : '') +
        ' 분석 보고서';
  } else {
    notice = held('notice', part);
    market = held('comparison', part);
    evidence = held('evidence', part);
  }
  field(evidence, '분석 규칙 버전', label(r.rulesVersion));
  const funding = fundingSection(readPart(parts.funding, forExport), r.analysisId, r.snapshotId);
  const law = lawSection(readPart(parts.law, forExport), r.analysisId, r.snapshotId);
  const news = section('news', 'reference');
  news.notes.push(
    '지역 뉴스는 원래 분석의 뉴스 탭에서 조회할 수 있습니다. 기사와 발췌문은 조회 시점에 제공됩니다.',
  );
  const commute = section('commute', 'reference');
  commute.notes.push(
    '원래 분석의 출퇴근 경로 탭에서 목적지와 교통수단을 선택하면 현재 경로를 조회할 수 있습니다.',
  );
  return {
    contractVersion: 'saved-report/v1',
    reportId: r.reportId,
    analysisId: r.analysisId,
    runId: r.runId,
    snapshotId: r.snapshotId,
    version: r.version,
    createdAt: r.createdAt,
    queriedAt: r.queriedAt,
    dataOrigin: r.dataOrigin,
    title,
    sections: [notice, market, funding, law, news, commute, evidence],
  };
}
