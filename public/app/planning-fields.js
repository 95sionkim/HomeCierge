import { esc, icon } from './display.js';

export const moneyPattern = /^(?:0|[1-9]\d*)$/;
export function amountInput(value, maxDigits = 20) {
  const raw = value.trim();
  if (!(moneyPattern.test(raw) || /^[1-9]\d{0,2}(?:,\d{3})+$/.test(raw))) return null;
  const digits = raw.replaceAll(',', '');
  return digits.length <= maxDigits ? digits : null;
}

export function evidence(refs, label = '금액 근거') {
  const docs = new Map();
  for (const ref of refs ?? []) {
    if (
      !ref ||
      typeof ref.document !== 'string' ||
      typeof ref.version !== 'string' ||
      !Number.isSafeInteger(ref.page) ||
      ref.page < 1
    )
      continue;
    const key = JSON.stringify([ref.document, ref.version]);
    if (!docs.has(key)) docs.set(key, { document: ref.document, version: ref.version, pages: new Set() });
    docs.get(key).pages.add(ref.page);
  }
  if (!docs.size) return '';
  const summaries = [...docs.values()].map((d) => ({
    ...d,
    pages: [...d.pages].sort((a, b) => a - b).join('·'),
  }));
  const short =
    summaries.length === 1 ? '공고문 ' + summaries[0].pages + '쪽' : '문서 ' + summaries.length + '개';
  return `<details class="evidence-disclosure"><summary aria-label="${esc(label)} · ${esc(short)}">${icon('file-text')}${esc(short)}${icon('chevron-down')}</summary>
    <div class="evidence-content"><strong>${esc(label)}</strong>${summaries.map((d) => `<dl><dt>문서</dt><dd>${esc(d.document)}</dd><dt>판본</dt><dd>${esc(d.version)}</dd><dt>근거 쪽</dt><dd>${esc(d.pages)}쪽</dd></dl>`).join('')}</div></details>`;
}

export const sourceNames = { applyhome_apt: '청약홈 아파트', applyhome_remainder: '청약홈 잔여세대' };
export const collectionLabels = {
  complete: '수집 완료',
  empty: '정상 0건',
  partial: '일부 수집',
  failed: '조회 실패',
  unavailable: '조회 불가',
};
export const planningReasons = {
  price_unverified: '호실 가격을 확인해야 합니다.',
  room_price_unverified: '호실 가격을 확인해야 합니다.',
  inventory_incomplete: '전체 호실을 확인하지 못했습니다.',
  inventory_unverified: '공급 호실을 확인해야 합니다.',
  detail_collection_incomplete: '주택형 수집이 일부만 끝났습니다.',
  detail_budget_exhausted: '주택형을 아직 수집하지 못했습니다.',
  detail_page_limit_reached: '주택형 목록의 일부만 수집했습니다.',
  document_budget_exhausted: '공고문 검수가 남아 있습니다.',
  source_unverified: '출처를 확인해야 합니다.',
  official_document_unverified: '공식 공고문의 확인이 필요합니다.',
  publication_date_unverified: '모집공고일을 확인해야 합니다.',
  application_dates_unverified: '접수일을 확인해야 합니다.',
  application_unverified: '접수일을 확인해야 합니다.',
  application_split: '접수 구간이 나뉘어 있습니다.',
  notice_kind_unsupported: '지원 대상 유형인지 확인해야 합니다.',
  notice_kind_unverified: '공고 유형을 확인해야 합니다.',
  move_in_unverified: '입주 예정월을 확인해야 합니다.',
  supply_area_unverified: '공급면적 근거가 부족합니다.',
  coverage_incomplete: '일부 출처의 수집이 끝나지 않았습니다.',
  region_selection_unverified: '선택한 지역 코드의 확인이 필요합니다.',
  observation_date_mismatch: '목록을 관측한 날과 검색 기준일이 다릅니다.',
  as_of_outside_publication_window: '기준일이 공고 수집 기간 밖에 있습니다.',
  source_restricted: '이 자료의 표시 권한을 확인 중입니다.',
  payment_schedule_incomplete: '분양대금 또는 필수 옵션의 납부 일정이 불완전합니다.',
  payment_date_unverified: '날짜가 확정되지 않은 납부가 있습니다.',
  payment_schedule_missing: '납부 일정을 확인할 자료가 없습니다.',
  opening_balance_missing: '보유 잔액과 기준일을 입력하세요.',
  payment_before_opening: '납부일이 잔액 기준일보다 앞섭니다.',
  opening_date_inflow_overlap: '기준일 입금이 보유 잔액에 포함됐는지 확인해야 합니다.',
  opening_date_payment_order_unverified: '잔액 기준일의 납부와 잔액 확인 순서를 알 수 없습니다.',
  subtotal_documents_differ: '두 항목을 함께 확인한 문서 판본이 없습니다.',
  subtotal_out_of_range: '합산할 수 있는 금액 범위를 넘었습니다.',
};
