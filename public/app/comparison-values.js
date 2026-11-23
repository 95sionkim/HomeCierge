// 비교 화면과 저장 보고서는 같은 근거와 원 단위 금액을 표시한다.
// 짝수 건의 중위값은 0.5원까지 보존한다. 표와 차트는 같은 원 단위 값을 읽는다.
export function halfWon(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})(\.5)?$/.test(value)) return null;
  return BigInt(value.split('.')[0]) * 2n + (value.endsWith('.5') ? 1n : 0n);
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

export function noticeRange(price) {
  if (price?.status !== 'confirmed' || price.basis !== 'sale_price_plus_required_options' ||
      !['selected_room', 'confirmed_rooms'].includes(price.scope)) return null;
  const min = price.scope === 'selected_room' ? price.won : price.minWon;
  const max = price.scope === 'selected_room' ? price.won : price.maxWon;
  if (halfWon(min) === null || halfWon(max) === null || halfWon(min) > halfWon(max)) return null;
  return { min, max };
}

export function priceLabel(range) {
  if (!range) return '—';
  return range.min === range.max ? won(range.min) : won(range.min) + ' – ' + won(range.max);
}

export function tradeRange(stat) {
  if (!['confirmed', 'provisional'].includes(stat?.status) || !Number.isSafeInteger(stat.count) || stat.count < 1) return null;
  const values = [stat.minWon, stat.medianWon, stat.maxWon].map(halfWon);
  if (values.some(v => v === null) || values[0] > values[1] || values[1] > values[2]) return null;
  return { min: stat.minWon, mid: stat.medianWon, max: stat.maxWon };
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
  return typeof code === 'string' && Object.hasOwn(labels, code) ? labels[code] : null;
}
