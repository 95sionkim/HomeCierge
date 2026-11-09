#!/usr/bin/env python3
"""저장된 실제 응답의 필드·단위·식별자 연결을 재검증한다. 외부 호출은 하지 않는다."""
import csv
import hashlib
import json
from datetime import date, datetime, timezone
from decimal import Decimal

from collect_recent_trades import assess_month, normalize
from probe_apis import ROOT, api_error, field_coverage, parse_payload, records_for, response_status

BASE = ROOT / 'api-evidence' / '20261106_live'


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def announcement_key(row):
    return (row['HOUSE_MANAGE_NO'], row['PBLANC_NO'])


def main():
    if not (BASE / 'case_detail/parsed.json').exists():
        raise SystemExit('역사적 실응답 증거는 별도 로컬 자료입니다. docs/api/README.md의 재현 범위를 확인하세요.')
    manifest = json.loads((ROOT / 'docs/api/live-manifest.json').read_text())
    specs = json.loads((ROOT / 'docs/api/probes.json').read_text())['probes']
    snapshots, checks, coverage = {}, [], []

    def check(name, condition, detail=None):
        checks.append({'check': name, 'passed': bool(condition), 'detail': detail})

    for capture in manifest['captures']:
        label = capture['label']
        directory = BASE / label
        result = json.loads((directory / 'result.json').read_text())
        raw = (directory / ('response.' + result['format'])).read_bytes()
        fmt, data = parse_payload(raw)
        spec = specs[capture['probe']]
        rows = records_for(data, spec['records'])
        actual_coverage = field_coverage(rows, spec['fields'])
        check(label + ': payload_and_status', fmt == result['format'] and api_error(data) is None
              and result['status'] == response_status(data, spec) == capture.get('expected_status', 'success'))
        check(label + ': record_count', len(rows) == result['record_count'] == capture['expected_record_count'])
        check(label + ': saved_hash', hashlib.sha256(raw).hexdigest() == result['sanitized_response_sha256'])
        check(label + ': field_coverage', actual_coverage == result['field_coverage'])
        check(label + ': parsed_matches_raw', data == json.loads((directory / 'parsed.json').read_text()))
        check(label + ': transport', result['http_status'] == capture['http_status'] and result['transport'] == capture['transport'])
        coverage.extend({'capture': label, **row} for row in actual_coverage)
        snapshots[label] = {'rows': rows, 'result': result, 'payload': data}

    # 공고와 모델은 배열 위치가 아니라 두 식별자로 연결한다.
    detail = snapshots['case_detail']['rows'][0]
    model = snapshots['case_model']['rows'][0]
    check('case: announcement_model_join', announcement_key(detail) == announcement_key(model) == ('2026930040', '2026930040'))
    check('case: matching_count_not_dataset_total', all(
        snapshots[label]['result']['all_matching_rows_in_snapshot'] is True
        and snapshots[label]['payload']['matchCount'] == 1
        and snapshots[label]['payload']['totalCount'] > 1
        for label in ['case_detail', 'case_model']))
    supply_total = int(model['SUPLY_HSHLDCO']) + int(model['SPSPLY_HSHLDCO'])
    price_won = int(Decimal(model['LTTOT_TOP_AMOUNT'].replace(',', '')) * 10000)
    check('case: model_supply_reconciles', supply_total == detail['TOT_SUPLY_HSHLDCO'] == 1)
    check('case: highest_price_unit_conversion', price_won == 1222020000)
    check('case: supply_area_preserved', Decimal(model['SUPLY_AR']) == Decimal('105.8939'))
    check('case: dates_parse', date.fromisoformat(detail['SUBSCRPT_RCEPT_BGNDE']) <= date.fromisoformat(detail['SUBSCRPT_RCEPT_ENDDE']))
    check('case: closed_before_validation_day', date.fromisoformat(detail['SUBSCRPT_RCEPT_ENDDE']) < date.fromisoformat(manifest['validation_date']))

    regular_details = {announcement_key(row): row for row in snapshots['applyhome_apt']['rows']}
    regular_matches = [row for row in snapshots['applyhome_apt_model']['rows'] if announcement_key(row) in regular_details]
    check('regular: identifier_join_available', len(regular_matches) > 0, {'matched_models_in_sample': len(regular_matches)})
    first_model = snapshots['applyhome_apt_model']['rows'][0]
    check('regular: zero_general_is_not_zero_total', first_model['SUPLY_HSHLDCO'] == 0 and first_model['SPSPLY_HSHLDCO'] == 18)
    remainder = snapshots['applyhome_remainder']['rows'][0]
    check('remainder: row_order_does_not_join', announcement_key(remainder) != announcement_key(snapshots['applyhome_remainder_model']['rows'][0]))
    check('remainder: generic_dates_present_when_general_dates_null', bool(remainder['SUBSCRPT_RCEPT_BGNDE']) and remainder['GNRL_RCEPT_BGNDE'] is None)

    # 동일 주소의 실제 거래·단지·좌표 응답을 교차 확인한다.
    trade = next(row for row in snapshots['apt_trade']['rows'] if row['aptSeq'] == '11215-87')
    basic = snapshots['apt_basic']['rows'][0]
    listing = next(row for row in snapshots['apt_list']['rows'] if row['kaptCode'] == basic['kaptCode'])
    kakao = snapshots['kakao_address']['rows'][0]
    bjd = trade['sggCd'] + trade['umdCd']
    check('cross_source: legal_dong_codes_equal', bjd == basic['bjdCode'] == listing['bjdCode'] == kakao['address']['b_code'])
    check('cross_source: legal_and_administrative_codes_differ', kakao['address']['b_code'] != kakao['address']['h_code'])
    check('cross_source: parcel_number', int(trade['bonbun']) == int(kakao['address']['main_address_no']) == 292 and int(trade['bubun']) == int(kakao['address']['sub_address_no'] or 0))
    check('cross_source: road_address', trade['roadNm'] == kakao['road_address']['road_name'] and int(trade['roadNmBonbun']) == int(kakao['road_address']['main_building_no']) == 174 and int(trade['roadNmBubun']) == int(kakao['road_address']['sub_building_no'] or 0) and basic['doroJuso'].endswith('용마산로 174'))
    check('cross_source: names_are_not_identical', len({trade['aptNm'], basic['kaptName'], kakao['road_address']['building_name']}) == 3)
    check('cross_source: independent_identifier_systems', trade['aptSeq'] != basic['kaptCode'])
    check('cross_source: numeric_coordinates', -180 <= Decimal(kakao['x']) <= 180 and -90 <= Decimal(kakao['y']) <= 90)
    check('basic: approval_date_and_trade_year', datetime.strptime(basic['kaptUsedate'], '%Y%m%d').year == int(trade['buildYear']) == 1999)
    check('basic: missing_values_distinguished', basic['kaptUrl'].strip() == '' and basic['zipcode'] is None and all(row['present'] == 1 and row['nonempty'] == 0 for row in snapshots['apt_basic']['result']['field_coverage'] if row['path'] in ['kaptUrl', 'zipcode']))
    check('trade: cancellations_empty_not_absent', all('cdealType' in row and 'cdealDay' in row and row['cdealType'] == row['cdealDay'] == '' for row in snapshots['apt_trade']['rows']))
    check('trade: comma_numeric_string', Decimal(trade['dealAmount'].replace(',', '')) == Decimal('62000'))
    check('collection: trade_is_partial', len(snapshots['apt_trade']['rows']) == 5 and int(snapshots['apt_trade']['payload']['response']['body']['totalCount']) == 48 and snapshots['apt_trade']['result']['all_matching_rows_in_snapshot'] is False)
    check('collection: kapt_list_complete_for_query', len(snapshots['apt_list']['rows']) == 97 and snapshots['apt_list']['result']['all_matching_rows_in_snapshot'] is True)
    check('kakao: http_200_and_app_metadata_present', snapshots['kakao_address']['result']['http_status'] == 200 and bool(snapshots['kakao_address']['result'].get('authenticated_app_id')))

    # 신규 실제 응답의 의미와 월별 완전성을 확인한다. 원문은 변경하지 않는다.
    months, all_trades = [], []
    for month in ['202605', '202606', '202607', '202608', '202609', '202610']:
        label = 'apt_trade_11215_' + month
        snap = snapshots[label]
        state, rows = assess_month([(snap['result'], snap['payload'])])
        normalized_rows = [dict(normalize(r, month, '11215', 'apt_trade'), source_capture=label) for r in rows]
        state.update(month=month, source_capture=label,
                     cancelled_count=sum(r['cancellation_status'] == 'cancelled' for r in normalized_rows),
                     rows_with_issues=sum(bool(r['issues']) for r in normalized_rows),
                     eligible_after_matching_count=sum(r['eligible_for_comparison_after_matching'] for r in normalized_rows))
        check('monthly:' + month + ': complete', state['complete'], state)
        check('monthly:' + month + ': data_units_and_dates', state['rows_with_issues'] == 0)
        months.append(state)
        all_trades.extend(normalized_rows)
    check('monthly: six_month_snapshot_size', sum(m['collected'] for m in months) == 504)
    check('monthly: actual_cancellations_excluded',
          sum(r['cancellation_status'] == 'cancelled' for r in all_trades) == 17
          and all(not r['eligible_for_comparison_after_matching'] for r in all_trades if r['raw']['cdealType'] == 'O'))
    recent_summary = {
        'district': '11215', 'completed_range': ['202605', '202610'],
        'planned_range': ['202511', '202610'],
        'uncollected_months': ['202511', '202512', '202601', '202602', '202603', '202604'],
        'six_month_snapshot_complete': all(m['complete'] for m in months), 'twelve_month_snapshot_complete': False,
        'total_records': len(all_trades), 'cancelled_records': 17,
        'eligible_after_matching_count': sum(r['eligible_for_comparison_after_matching'] for r in all_trades),
        'months': months,
        'note': '조회 시점 월별 API 제공 행 전체. 신고·해제·정정으로 이후 값이 바뀔 수 있음. 비교 단지 매칭 전이며 가격 통계 미산출.',
    }
    dump(BASE / 'recent-trades-summary.json', recent_summary)
    dump(BASE / 'recent-trades-normalized.json', all_trades)

    rights = snapshots['apt_rights_41210_202609']
    rights_state, rights_rows = assess_month([(rights['result'], rights['payload'])])
    rights_normalized = [normalize(r, '202609', '41210', 'apt_rights') for r in rights_rows]
    empty_rights = snapshots['apt_rights_11215_202609_empty']
    check('rights: positive_and_empty_results_distinct', rights_state['complete']
          and len(rights_rows) == 21 and empty_rights['result']['status'] == 'success_empty'
          and empty_rights['rows'] == [])
    check('rights: explicit_blank_means_presale_not_missing',
          sum(r['rights_type'] == 'presale_right' for r in rights_normalized) == 3
          and sum(r['rights_type'] == 'occupancy_right' for r in rights_normalized) == 18)
    check('rights: actual_cancelled_records_excluded',
          sum(r['cancellation_status'] == 'cancelled' for r in rights_normalized) == 2
          and sum(r['eligible_for_comparison_after_matching'] for r in rights_normalized) == 19)
    check('rights: price_area_and_date_values', all(not r['issues'] for r in rights_normalized)
          and rights_normalized[0]['price_krw'] == 1250000000
          and rights_normalized[0]['exclusive_area_m2'] == '59.98')
    dump(BASE / 'rights-normalized.json', rights_normalized)

    buildings = snapshots['building_title']['rows']
    apartments = [r for r in buildings if r['etcPurps'] == '공동주택(아파트)']
    shops = [r for r in buildings if r['dongNm'] == '상가동']
    check('building: complete_unique_registers', len(buildings) == 4
          and snapshots['building_title']['result']['all_matching_rows_in_snapshot'] is True
          and len({r['mgmBldrgstPk'] for r in buildings}) == 4)
    check('building: parcel_road_and_approval_match', all(
        r['sigunguCd'] + r['bjdongCd'] == bjd and int(r['bun']) == 292 and int(r['ji']) == 0
        and r['useAprDay'] == basic['kaptUsedate'] and '용마산로 174' in r['newPlatPlc'] for r in buildings))
    check('building: coarse_purpose_is_insufficient', len(apartments) == 3 and len(shops) == 1
          and shops[0]['mainPurpsCdNm'] == '공동주택' and shops[0]['hhldCnt'] == 0 and shops[0]['hoCnt'] == 27)
    household_sum = sum(r['hhldCnt'] for r in apartments)
    check('building: source_households_conflict_preserved', household_sum == 183
          and int(basic['kaptdaCnt']) == 182 and household_sum != int(basic['kaptdaCnt']))
    check('building: gross_area_not_exclusive_unit_area', all(Decimal(str(r['totArea'])) > 1000 for r in buildings))
    additional_findings = {
        'rights': {'record_count': 21, 'presale_rights': 3, 'occupancy_rights': 18, 'cancelled': 2,
                   'meaning_source': 'docs/api/reference/apt-rights-guide.hwp 및 apt-rights-guide-extracted.txt',
                   'note': '광명시는 필드·거래 종류 검증용. 광진구 공고의 가격 비교 단지로 선정한 것이 아님.'},
        'building_households_conflict': {
            'status': 'unresolved_source_conflict', 'kapt_households': int(basic['kaptdaCnt']),
            'building_apartment_households_sum': household_sum,
            'kapt_source': 'api-evidence/20261106_live/apt_basic/response.json',
            'building_source': 'api-evidence/20261106_live/building_title/response.json',
            'policy': '출처·조회시각·집계 범위별 값을 함께 보존. 원인 추정이나 조용한 덮어쓰기 금지.',
        },
        'building_rows': [{k: r[k] for k in ['mgmBldrgstPk', 'bldNm', 'dongNm', 'mainPurpsCdNm',
                          'etcPurps', 'useAprDay', 'grndFlrCnt', 'ugrndFlrCnt', 'hhldCnt', 'hoCnt', 'totArea']} for r in buildings],
    }
    dump(BASE / 'additional-findings.json', additional_findings)

    normalized = {
        'source': 'actual_response_subset_with_derived_fields',
        'announcement_case': {
            'house_manage_no': detail['HOUSE_MANAGE_NO'], 'announcement_no': detail['PBLANC_NO'],
            'name': detail['HOUSE_NM'], 'type': detail['HOUSE_SECD_NM'],
            'model_no': model['MODEL_NO'], 'house_type_raw': model['HOUSE_TY'],
            'supply_area_m2': model['SUPLY_AR'], 'exclusive_area_m2': None,
            'exclusive_area_note': 'API 별도 필드 없음. 주택형 문자열 파싱은 원문 대조 전 미확정.',
            'model_highest_price_10k_krw': model['LTTOT_TOP_AMOUNT'],
            'model_highest_price_krw': price_won, 'exact_unit_price_krw': None,
            'general_units': model['SUPLY_HSHLDCO'], 'special_units': model['SPSPLY_HSHLDCO'],
            'application_start': detail['SUBSCRPT_RCEPT_BGNDE'], 'application_end': detail['SUBSCRPT_RCEPT_ENDDE'],
            'status_on_validation_date': '접수 종료; 데이터 검증 사례',
            'move_in_year_month': detail['MVN_PREARNGE_YM'],
            'announcement_page_url': detail['PBLANC_URL'], 'announcement_pdf_url': None,
        },
        'cross_source_address_case': {
            'note': '강변역 센트럴 아이파크와 다른 단지. 가격 비교 사례가 아닌 식별자 연결 검증 사례.',
            'rtms_apt_seq': trade['aptSeq'], 'rtms_name': trade['aptNm'],
            'kapt_code': basic['kaptCode'], 'kapt_name': basic['kaptName'],
            'kakao_building_name': kakao['road_address']['building_name'],
            'legal_dong_code': bjd, 'administrative_dong_code': kakao['address']['h_code'],
            'road_address': basic['doroJuso'], 'parcel_number': trade['jibun'],
            'longitude': kakao['x'], 'latitude': kakao['y'],
            'trade_amount_raw': trade['dealAmount'], 'trade_amount_number': int(Decimal(trade['dealAmount'].replace(',', ''))),
            'exclusive_area_m2': trade['excluUseAr'], 'floor': int(trade['floor']),
            'contract_date': date(int(trade['dealYear']), int(trade['dealMonth']), int(trade['dealDay'])).isoformat(),
            'use_approval_date': datetime.strptime(basic['kaptUsedate'], '%Y%m%d').date().isoformat(),
            'households': int(basic['kaptdaCnt']),
        },
    }
    dump(BASE / 'normalized-examples.json', normalized)
    dump(BASE / 'cross-source-checks.json', checks)
    with (BASE / 'field-coverage.csv').open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=['capture', 'need', 'path', 'records', 'present', 'nonempty'])
        writer.writeheader()
        writer.writerows(coverage)
    summary = {
        'validated_at': datetime.now(timezone.utc).isoformat(),
        'scope': '2026-11-06 라이브 응답 스냅샷의 오프라인 재검증; 새 외부 호출 없음',
        'captures': len(snapshots), 'unique_operations': len({entry['probe'] for entry in manifest['captures']}),
        'unique_services': len({specs[entry['probe']]['service'] for entry in manifest['captures']}),
        'checks_passed': sum(row['passed'] for row in checks), 'checks_total': len(checks),
        'failed_checks': [row for row in checks if not row['passed']],
        'limitations': ['API 제공 범위 전체·최신 상태·서비스 SLA를 검증한 결과는 아님', '이 스냅샷은 당시 6개월504행·해제17행 범위다. 최신 12개월·연결 결과는 docs/api/validation-20261109.md 참조', '이 검증은 API 스냅샷에 한정. 후속 PDF 보충값은 pdf-evidence/2026930040/combined.json 참조', '이 스냅샷에는 법령·출퇴근·뉴스가 없다. 추가 검증은 별도 manifest에 있으며 호가는 제품 범위 제외', '건축물대장183세대와 K-apt182세대 불일치 원인 미확정'],
    }
    dump(BASE / 'validation-summary.json', summary)
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if all(row['passed'] for row in checks) else 1


if __name__ == '__main__':
    raise SystemExit(main())
