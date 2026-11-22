export function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
}

export function icon(name, extraClass = '') {
  return `<svg class="icon ${esc(extraClass)}" aria-hidden="true" focusable="false"><use href="/app/assets/icons.svg#${esc(name)}"></use></svg>`;
}

export function badge(style, symbol, label) {
  return `<span class="badge ${esc(style)}">${icon(symbol)}${esc(label)}</span>`;
}

export const kinds = {
  new_sale: '일반분양',
  unranked: '무순위',
  remaining: '잔여세대',
  resupply: '재공급',
  unknown: '유형 확인 필요',
};

export const runLabels = {
  queued: '분석 대기',
  running: '분석 중',
  retry_wait: '다시 시도 대기',
  finished: '분석 완료',
  failed: '분석 실패',
  cancelled: '분석 취소',
};

export const statusLabels = {
  open: '접수 중',
  upcoming: '접수 예정',
  closed: '접수 종료',
  unknown: '일정 확인 필요',
};

export function scheduleBadge(status) {
  const style =
    { open: 'verified', upcoming: 'upcoming', closed: 'closed', unknown: 'unknown' }[status] ?? 'unknown';
  const symbol =
    { open: 'circle-check', upcoming: 'clock-3', closed: 'calendar-check', unknown: 'circle-help' }[status] ??
    'circle-help';
  return badge(style, symbol, statusLabels[status] ?? statusLabels.unknown);
}

export function runBadge(status) {
  const style =
    {
      finished: 'verified',
      failed: 'failed',
      cancelled: 'zero',
      running: 'upcoming',
      queued: 'upcoming',
      retry_wait: 'partial',
    }[status] ?? 'unknown';
  const symbol =
    {
      finished: 'circle-check',
      failed: 'triangle-alert',
      cancelled: 'circle-minus',
      running: 'loader-circle',
      queued: 'clock-3',
      retry_wait: 'clock-3',
    }[status] ?? 'circle-help';
  return badge(style, symbol, runLabels[status] ?? '진행 상태 미확인');
}

export function reasonText(code) {
  const labels = {
    notice_source_ambiguous: '공고 출처를 한 곳으로 식별할 수 없습니다.',
    notice_metadata_conflict: '공고 식별 정보가 출처마다 다릅니다.',
    region_unverified: '공식 소재지를 확인할 수 없습니다.',
    kind_unverified: '공고 유형을 확인할 수 없습니다.',
    edition_unverified: '공고 회차를 확인할 수 없습니다.',
    house_type_unverified: '주택형 표기를 확인할 수 없습니다.',
    model_unverified: '공식 주택형 자료를 확인할 수 없습니다.',
    target_supply_area_unverified: '선택한 주택형의 공급면적 근거가 부족합니다.',
    comparison_evidence_unverified: '주변 거래를 단지와 주택형에 연결하는 근거가 부족합니다.',
    no_confirmed_room_subtotal: '분양가와 필수 옵션을 함께 확인한 호실이 없습니다.',
    notice_room_price_unverified: '선택한 호실의 가격 근거가 부족합니다.',
    required_options_unverified: '필수 옵션 금액을 확인할 수 없습니다.',
    subtotal_documents_differ: '분양가와 옵션이 서로 다른 문서 판본에서 확인됐습니다.',
    notice_identity_unverified: '동일 공고와 회차를 확인할 수 없습니다.',
    target_identity_unverified: '선택한 공고와 수집본의 대응을 확인할 수 없습니다.',
    target_complex_identity_unverified: '대상 공고와 단지의 연결을 확인할 수 없습니다.',
    contract_period_unverified: '계약 기간의 시작일을 확인해야 합니다.',
    trade_supply_area_unverified: '거래 당시 주택형의 공급면적 근거가 필요합니다.',
    trade_link_unverified: '거래가 어느 단지·주택형인지 확인할 근거가 부족합니다.',
    closest_supply_area_tie: '동일하게 가까운 공급면적 후보가 있습니다.',
    housing_type_unverified: '공고와 주택형의 연결을 확인할 수 없습니다.',
    housing_type_conflict: '출처 사이에 주택형 표기가 서로 다릅니다.',
    collection_request_regions_unverified: '수집한 지역의 범위를 확인해야 합니다.',
    collection_incomplete: '일부 수집 자료가 도착하지 않았습니다.',
    collection_not_replayed: '해당 지역·계약월의 수집 기록이 없습니다.',
    priority_region_unverified: '우선 지역의 법정동·읍·면을 확인할 수 없습니다.',
    expansion_region_unverified: '확대할 구 또는 시·군의 소속을 확인할 수 없습니다.',
    trade_region_membership_unverified: '거래가 어느 법정동·읍·면에 속하는지 확인해야 합니다.',
    trade_complex_identity_unverified: '거래와 단지를 연결하는 근거가 부족합니다.',
    trade_exclusive_area_binding_unverified: '거래의 전용면적과 주택형의 대응을 확인해야 합니다.',
    trade_amount_unverified: '거래의 신고금액을 확인해야 합니다.',
    trade_validity_unverified: '거래의 유효 여부를 확인해야 합니다.',
    trade_kinds_unverified: '수집된 거래의 유형을 확인해야 합니다.',
    straight_line_distance_unverified: '단지 좌표가 확인되지 않아 거리 순위를 정할 수 없습니다.',
    straight_line_coordinate_conflict: '출처마다 단지 좌표가 달라 거리 순위를 정할 수 없습니다.',
    straight_line_distance_tie: '직선거리가 같아 단지 순위를 정할 수 없습니다.',
    room_model_conflict: '같은 호실이 서로 다른 주택형에 연결되어 있습니다.',
    house_type_mismatch: '공고문과 API의 주택형 표기가 일치하지 않습니다.',
    sale_price_unverified: '호실의 분양가를 확인할 수 없습니다.',
    required_options_conflict: '필수 옵션 금액이 판본마다 다릅니다.',
    sale_price_conflict: '호실 분양가가 판본마다 다릅니다.',
    room_subtotal_unverified: '같은 판본에서 호실의 분양가와 필수 옵션을 함께 확인해야 합니다.',
    document_origin_unverified: '금액 근거로 쓰인 문서의 출처를 확인해야 합니다.',
    document_origin_conflict: '금액 근거로 쓰인 문서의 출처가 서로 일치하지 않습니다.',
    notice_selection_unverified: '공고와 선택 주택형이 일치하는지 현재 자료로 확인할 수 없습니다.',
    notice_feed_unavailable: '공고 또는 주택형 자료를 수집할 수 없습니다.',
    notice_source_restricted: '해당 출처의 이용 조건을 확인 중입니다.',
    notice_capture_limit: '이번 수집의 시간 또는 조회 횟수 한도에 도달했습니다.',
    run_internal_error: '분석을 마치지 못했습니다. 공고를 다시 선택해 시작하세요.',
    run_deadline_exceeded: '분석 시간이 지나 종료됐습니다. 공고를 다시 선택해 시작하세요.',
  };
  return labels[code] ?? null;
}

export function errorText(error) {
  const code = error?.code ?? '';
  const text = {
    invalid_credentials: '이메일과 비밀번호를 확인하고 다시 입력하세요.',
    invalid_search_input: '지역, 예산, 면적과 입주월 범위를 확인해 주세요.',
    invalid_funding_input: '분석과 호실 정보를 다시 확인해 주세요.',
    funding_not_found: '이 분석의 자금표를 찾을 수 없습니다.',
    fund_changed: '다른 변경이 먼저 저장됐습니다. 최신 자금을 확인하고 다시 수정해 주세요.',
    search_selection_changed: '최신 공고에서 같은 회차와 주택형을 확인할 수 없습니다. 오늘의 청약에서 공고를 다시 확인해 주세요.',
    user_already_exists: '이메일이 이미 등록되어 있습니다. 로그인으로 이동하세요.',
    email_address_invalid: '이메일 주소의 형식을 확인하세요.',
    email_not_confirmed: '가입 확인 메일의 링크를 연 뒤 다시 로그인하세요.',
    weak_password: '더 긴 비밀번호를 입력하세요.',
    signup_disabled: '현재 신규 가입을 이용할 수 없습니다.',
    auth_rate_limited: '요청이 많습니다. 잠시 후 다시 시도하세요.',
    authentication_required: '세션이 만료됐습니다. 다시 로그인하세요.',
    configuration_unavailable: '현재 로그인 연결을 준비 중입니다. 잠시 후 다시 시도하세요.',
    backend_unavailable: '서비스에 연결할 수 없습니다. 잠시 후 다시 시도하세요.',
    search_index_not_ready: '최근 공고 목록을 준비 중입니다. 잠시 후 다시 확인하세요.',
    search_source_restricted: '현재 출처의 공고 목록 표시 조건을 확인 중입니다.',
    notice_search_source_use_not_allowed: '현재 출처의 공고 목록 표시 조건을 확인 중입니다.',
    directory_page_changed: '목록을 읽는 중 기준일이나 자료가 바뀌었습니다. 다시 조회하세요.',
    run_rate_limited: '최근 분석 요청이 많습니다. 1분 뒤 다시 시도하세요.',
    run_conflict: '공고 정보 또는 실행 상태가 달라졌습니다. 최신 목록을 다시 확인하세요.',
    comparison_not_available: '아직 저장된 비교 결과가 없습니다. 실행 상태를 확인하세요.',
    comparison_source_restricted: '이 결과에 사용된 출처의 표시 권한을 확인 중입니다.',
    run_not_found: '이 계정에서 조회할 수 있는 분석이 없습니다.',
    legal_evidence_not_found: '이 계정의 분석에서 해당 공고 수집본을 찾을 수 없습니다.',
    news_snapshot_not_found: '이 계정의 분석에서 해당 공고 수집본을 찾을 수 없습니다.',
    invalid_legal_input: '내 분석에서 법령을 확인할 공고를 다시 선택해 주세요.',
    invalid_news_input: '내 분석에서 뉴스를 확인할 공고를 다시 선택해 주세요.',
    news_rate_limited: '최근 뉴스 요청이 많습니다. 1분 뒤 다시 조회하세요.',
    invalid_run_input: '이 공고의 분석 조건을 확인할 수 없습니다. 목록에서 다시 선택하세요.',
    invalid_directory_input: '목록을 다시 열어 현재 공고를 확인하세요.',
    notice_index_not_ready: '최근 게시된 공고 목록을 준비 중입니다. 다시 조회하세요.',
    notice_not_found: '최신 목록에서 이 공고를 찾을 수 없습니다.',
    notice_source_conflict: '공고 출처가 달라졌습니다. 최신 목록에서 다시 선택하세요.',
    notice_kind_unsupported: '이번 공고 유형은 현재 분석할 수 없습니다.',
    notice_edition_mismatch: '공고 회차가 달라졌습니다. 최신 목록에서 다시 선택하세요.',
    notice_edition_unverified: '공고 회차를 확인한 뒤 분석할 수 있습니다.',
    notice_model_not_found: '최신 공고에서 선택한 주택형을 찾을 수 없습니다.',
    notice_model_unverified: '선택한 주택형을 확인한 뒤 분석할 수 있습니다.',
    notice_region_unverified: '공고의 공식 소재지를 확인한 뒤 분석할 수 있습니다.',
    analysis_notice_selection_conflict: '분석에 저장된 공고 조건과 선택한 주택형이 다릅니다.',
  };
  return text[code] ?? reasonText(code) ?? '요청을 마치지 못했습니다. 연결을 확인하고 다시 시도하세요.';
}

export function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === value ? value : null;
}

export function todayKst(value = new Date()) {
  if (value === null || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? new Date(date.valueOf() + 9 * 3600_000).toISOString().slice(0, 10)
    : null;
}

export function dateText(value, short = false) {
  const d = isoDate(value);
  return d ? (short ? d.slice(5) : d).replaceAll('-', '.') : '—';
}

const koreanDate = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'long',
  timeZone: 'UTC',
});
export function longDate(value) {
  const d = isoDate(value);
  return d ? koreanDate.format(new Date(d + 'T00:00:00Z')) : '기준일 확인 중';
}

const rangeCache = new WeakMap();
export function rangesFor(notice) {
  if (rangeCache.has(notice)) return rangeCache.get(notice);
  const ranges = Array.isArray(notice.applicationSegments)
    ? notice.applicationSegments
    : notice.application && notice.checks?.schedule === 'verified'
      ? [notice.application]
      : [];
  const verified = ranges.filter((r) => isoDate(r?.start) && isoDate(r?.end) && r.start <= r.end);
  rangeCache.set(notice, verified);
  return verified;
}

export function rangeLabel(range, short = true) {
  if (!range || !isoDate(range.start) || !isoDate(range.end)) return '일정 미확인';
  return range.start === range.end
    ? dateText(range.start, short)
    : `${dateText(range.start, short)} – ${dateText(range.end, short)}`;
}

export function supplyLabel(value) {
  if (typeof value !== 'string' || value.length > 24 || !/^\d+(\.\d+)?$/.test(value)) return '면적 미확인';
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0')) +
    (Number(fraction[2] ?? 0) >= 5 ? 1n : 0n);
  if (cents === 0n && /[1-9]/.test(value)) return '0.01㎡ 미만';
  return (cents / 100n).toString() + '.' + (cents % 100n).toString().padStart(2, '0') + '㎡';
}

export function inRange(notice, date) {
  return rangesFor(notice).some((r) => r.start <= date && date <= r.end);
}

export function won(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,20})(\.5)?$/.test(value)) return '—';
  const integer = BigInt(value.split('.')[0]),
    fraction = value.endsWith('.5');
  const parts = [];
  const hundredMillion = integer / 100000000n;
  const tenThousand = (integer % 100000000n) / 10000n;
  const units = integer % 10000n;
  if (hundredMillion) parts.push(hundredMillion.toLocaleString('ko-KR') + '억');
  if (tenThousand) parts.push(tenThousand.toLocaleString('ko-KR') + '만');
  if (units || fraction || !parts.length) parts.push(units.toLocaleString('ko-KR') + (fraction ? '.5' : ''));
  return parts.join(' ') + (units || fraction || (!hundredMillion && !tenThousand) ? '원' : ' 원');
}

export function publicationText(notice) {
  return isoDate(notice.edition) &&
    !notice.reasonCodes?.includes('publication_date_unverified') &&
    !notice.reasonCodes?.includes('notice_metadata_conflict')
    ? dateText(notice.edition)
    : '미확인';
}
