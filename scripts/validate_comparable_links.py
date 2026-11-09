#!/usr/bin/env python3
"""정책 변경 전 5km 주소 연결 시험을 재현한다. 현행 동→구 규칙은 docs/prd/01-product-prd.md 참조.

이 스크립트와 저장 증거는 역사적 검증용이며, 현행 지역 선택 기능의 구현이 아니다.
면적 허용치도 제품 결정이 아닌 시험 조건이다.
"""
import argparse
import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from statistics import median

from collect_recent_trades import assess_month, normalize
from probe_apis import ROOT, at, parse_payload, read_keys, records_for, run_probe, sanitize


def read(path):
    return json.loads(path.read_text())


def dump(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def parcel_from_trade(row):
    try:
        code = str(row['sggCd']) + str(row['umdCd'])
        land = str(row['landCd'])
        if not re.fullmatch(r'\d{10}', code) or land not in {'1', '2'}:
            return None
        return code, land, int(row['bonbun']), int(row['bubun'])
    except (KeyError, TypeError, ValueError):
        return None


def parcel_from_kakao(row):
    address = row.get('address') or {}
    try:
        code = str(address['b_code'])
        mountain = address['mountain_yn']
        if not re.fullmatch(r'\d{10}', code) or mountain not in {'N', 'Y'}:
            return None
        return code, '2' if mountain == 'Y' else '1', int(address['main_address_no']), int(address.get('sub_address_no') or 0)
    except (KeyError, TypeError, ValueError):
        return None


def parcel_from_kapt(row):
    # 이름이 아닌 법정동코드와 지번을 비교한다. 주소 형식이 불명확하면 보류한다.
    matches = re.findall(r'(?:동|리|가)\s+(산)?(\d+)(?:-(\d+))?(?=\s|$)', row.get('kaptAddr') or '')
    code = str(row.get('bjdCode') or '')
    if len(matches) != 1 or not re.fullmatch(r'\d{10}', code):
        return None
    mountain, main, sub = matches[0]
    return code, '2' if mountain else '1', int(main), int(sub or 0)


def unique_geocode(rows, parcel):
    matches = [row for row in rows if parcel is not None and parcel_from_kakao(row) == parcel]
    return matches[0] if len(matches) == 1 else None


def road_identity(name, main, sub):
    try:
        if not name or main in ('', None):
            return None
        return name.strip(), int(main), int(sub or 0)
    except (TypeError, ValueError):
        return None


def road_from_kapt(address):
    matches = re.findall(r'(\S+(?:로|길))\s+(\d+)(?:-(\d+))?(?=\s|$)', address or '')
    return road_identity(*matches[0]) if len(matches) == 1 else None


def distance_m(lon1, lat1, lon2, lat2):
    values = [float(x) for x in (lon1, lat1, lon2, lat2)]
    if not all(math.isfinite(x) for x in values) or not (-180 <= values[0] <= 180 and -180 <= values[2] <= 180 and -90 <= values[1] <= 90 and -90 <= values[3] <= 90):
        raise ValueError('invalid_coordinates')
    lon1, lat1, lon2, lat2 = map(math.radians, values)
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371008.8 * 2 * math.asin(math.sqrt(min(1.0, a)))


class CaptureUnavailable(ValueError):
    pass


class Captures:
    """키를 기록하지 않고 요청 조건·실응답·해시를 보존하며 오프라인 재검증을 지원한다."""
    def __init__(self, path, collect):
        self.path, self.collect = path, collect
        self.specs = read(ROOT / 'docs/api/probes.json')['probes']
        self.keys = read_keys() if collect else {}
        self.entries = []

    def get(self, name, params):
        spec = self.specs[name]
        key = name + '_' + digest(json.dumps(params, sort_keys=True, ensure_ascii=False).encode())[:16]
        directory = self.path / 'captures' / key
        if not (directory / 'result.json').exists():
            if not self.collect:
                raise ValueError('missing_capture: ' + key)
            result, raw, payload = run_probe(name, spec, self.keys, params)
            directory.mkdir(parents=True, exist_ok=True)
            if raw is not None:
                result['sanitized_response_sha256'] = digest(raw.encode())
                (directory / ('response.' + result['format'])).write_text(raw)
            dump(directory / 'result.json', json.loads(sanitize(json.dumps(result), self.keys)))
            if payload is not None:
                dump(directory / 'parsed.json', payload)
        result = read(directory / 'result.json')
        if result['request_params'] != {**spec['params'], **params} or result['endpoint'] != spec['url']:
            raise ValueError('capture_request_mismatch: ' + key)
        if result['status'] not in {'success', 'success_empty'}:
            self.entries.append({'id': key, 'status': result['status'], 'http_status': result.get('http_status'),
                                 'probe': name, 'error': result.get('api_error')})
            raise CaptureUnavailable('capture_failed: ' + key + ':' + result['status'])
        raw = (directory / ('response.' + result['format'])).read_bytes()
        fmt, payload = parse_payload(raw)
        if digest(raw) != result['sanitized_response_sha256'] or payload != read(directory / 'parsed.json'):
            raise ValueError('capture_integrity_mismatch: ' + key)
        self.entries.append({'id': key, 'status': result['status'], 'http_status': result.get('http_status'),
                             'records': result['record_count'], 'sha256': digest(raw), 'probe': name})
        return records_for(payload, spec['records']), payload, key


def load_collection(directory):
    summary = read(directory / 'summary.json')
    checks, all_rows = [], []
    for month in summary['requested_months']:
        pages = []
        for file in sorted((directory / month).glob('page_*_result.json')):
            result = read(file)
            rawfile = file.with_name(file.name.replace('_result.json', '_response.' + result.get('format', 'txt')))
            raw = rawfile.read_bytes()
            _, payload = parse_payload(raw)
            # 기존 수집기는 정제 전 해시를 기록한다. 인증값이 없는 거래 응답은 같은 해시다.
            checks.append({'check': f'{directory.name}/{month}/{file.stem}:raw_hash',
                           'passed': digest(raw) == result.get('sanitized_response_sha256', result['response_sha256'])})
            pages.append((result, payload))
        state, records = assess_month(pages)
        normalized = [normalize(row, month, summary['district'], summary['probe']) for row in records]
        checks.extend([
            {'check': month + ':complete', 'passed': state['complete']},
            {'check': month + ':normalization', 'passed': normalized == read(directory / month / 'normalized.json')},
            {'check': month + ':valid_rows', 'passed': all(not row['issues'] for row in normalized)},
        ])
        for index, row in enumerate(normalized):
            all_rows.append({**row, 'evidence_ref': str((directory / month).relative_to(ROOT)) + '#' + str(index)})
    return summary, all_rows, checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--collection', type=Path, required=True)
    parser.add_argument('--rights-collection', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--collect', action='store_true')
    parser.add_argument('--test-area-tolerance-m2', type=Decimal, default=Decimal('1.0'))
    args = parser.parse_args()
    collection = args.collection.resolve()
    rights = args.rights_collection.resolve()
    output = args.output.resolve()
    if not args.test_area_tolerance_m2.is_finite() or args.test_area_tolerance_m2 < 0:
        parser.error('시험 면적 허용치는 유한한 비음수여야 합니다.')
    summary, all_trades, checks = load_collection(collection)
    rights_summary, rights_trades, rights_checks = load_collection(rights)
    checks += rights_checks
    if not all(c['passed'] for c in checks):
        raise ValueError('source_collection_failed_validation')
    cap = Captures(output, args.collect)
    detail = read(ROOT / 'api-evidence/20261106_live/case_detail/parsed.json')['data'][0]
    reviewed = read(ROOT / 'pdf-evidence/2026930040/reviewed-facts.json')
    # 대상 면적은 검수한 PDF에서 읽는다. 최종 PRD의 유사 면적 기준을 결정하지 않는다.
    if reviewed['house_manage_no'] != detail['HOUSE_MANAGE_NO']:
        raise ValueError('target_pdf_announcement_mismatch')
    target_area = Decimal(str(reviewed['fields']['exclusive_area_m2']['value']))
    target_supply = Decimal(str(reviewed['fields']['supply_area_m2']['value']))
    target_parcel = ('1121510300', '1', 592, 39)
    target_query = '서울특별시 광진구 구의동 592-39'
    target_rows, _, target_source = cap.get('kakao_address', {'query': target_query, 'analyze_type': 'exact'})
    target_geo = unique_geocode(target_rows, target_parcel)
    if target_geo is None:
        raise ValueError('target_geocode_unresolved')
    listings, listing_payload, listing_source = cap.get('apt_list', {'sigunguCode': summary['district'], 'numOfRows': 1000, 'pageNo': 1})
    list_total = int(at(listing_payload, 'response.body.totalCount'))
    if list_total != len(listings) or len({r['kaptCode'] for r in listings}) != len(listings):
        raise ValueError('incomplete_or_duplicate_kapt_list')
    basic_index = defaultdict(list)
    unavailable_basics = []
    for listing in listings:
        try:
            basic_rows, _, source = cap.get('apt_basic', {'kaptCode': listing['kaptCode']})
        except CaptureUnavailable as exc:
            unavailable_basics.append({'code': listing['kaptCode'], 'name': listing['kaptName'], 'reason': str(exc)})
            continue
        if len(basic_rows) != 1 or basic_rows[0]['kaptCode'] != listing['kaptCode'] or basic_rows[0]['bjdCode'] != listing['bjdCode']:
            raise ValueError('kapt_list_detail_mismatch')
        basic_index[parcel_from_kapt(basic_rows[0])].append((basic_rows[0], source))
    groups = defaultdict(list)
    for row in all_trades:
        if row['eligible_for_comparison_after_matching'] and abs(Decimal(row['exclusive_area_m2']) - target_area) <= args.test_area_tolerance_m2:
            groups[row['apartment_id']].append(row)
    candidates = []
    for apt_id, rows in sorted(groups.items()):
        parcels = {parcel_from_trade(r['raw']) for r in rows}
        candidate = {'apartment_id': apt_id, 'name': rows[0]['apartment_name'], 'trade_count': len(rows),
                     'trade_refs': [r['evidence_ref'] for r in rows], 'status': 'review_required', 'issues': []}
        candidates.append(candidate)
        if apt_id is None or len(parcels) != 1 or None in parcels:
            candidate['issues'].append('missing_or_conflicting_trade_identity')
            continue
        parcel = next(iter(parcels))
        candidate['parcel_identity'] = list(parcel)
        query = f"서울특별시 광진구 {rows[0]['legal_dong']} {rows[0]['lot']}"
        try:
            geo_rows, _, geo_source = cap.get('kakao_address', {'query': query, 'analyze_type': 'exact'})
        except CaptureUnavailable:
            candidate['issues'].append('geocode_request_failed')
            continue
        geo = unique_geocode(geo_rows, parcel)
        candidate['geocode_source'] = geo_source
        if geo is None:
            candidate['issues'].append('unresolved_or_ambiguous_geocode')
            continue
        dist = distance_m(target_geo['x'], target_geo['y'], geo['x'], geo['y'])
        candidate.update(longitude=geo['x'], latitude=geo['y'], distance_m=round(dist, 2), within_5km=dist <= 5000)
        basics = basic_index.get(parcel, [])
        candidate['kapt_matches'] = [{'code': b['kaptCode'], 'name': b['kaptName'], 'source': src} for b, src in basics]
        if len(basics) != 1:
            candidate['issues'].append('kapt_link_unresolved' if not basics else 'multiple_kapt_matches')
        else:
            basic, source = basics[0]
            candidate.update(kapt_code=basic['kaptCode'], kapt_name=basic['kaptName'],
                             use_approval_date=basic.get('kaptUsedate'), households=basic.get('kaptdaCnt'))
            # 같은 지번도 여러 동·단지를 포함할 수 있으므로 건물번호까지 대조한다.
            road = geo.get('road_address') or {}
            geo_road = road_identity(road.get('road_name'), road.get('main_building_no'), road.get('sub_building_no'))
            kapt_road = road_from_kapt(basic.get('doroJuso'))
            trade_roads = {road_identity(r['raw'].get('roadNm'), r['raw'].get('roadNmBonbun'), r['raw'].get('roadNmBubun')) for r in rows}
            candidate['road_identities'] = {'kakao': geo_road, 'kapt': kapt_road, 'trade': sorted((list(r) if r else None for r in trade_roads), key=str)}
            if None in trade_roads or geo_road is None or kapt_road is None:
                candidate['issues'].append('road_address_unverified')
            elif trade_roads != {geo_road} or geo_road != kapt_road:
                candidate['issues'].append('road_address_conflict')
        if parcel == target_parcel:
            candidate['issues'].append('same_site_as_target')
        if not candidate['within_5km']:
            candidate['issues'].append('outside_radius')
        if not candidate['issues']:
            candidate['status'] = 'linked_for_validation'
        # 시험 조건의 기술통계이며 공급면적 동등성이나 최종 비교 단지 채택을 뜻하지 않는다.
        candidate['exclusive_areas_m2'] = sorted({r['exclusive_area_m2'] for r in rows}, key=Decimal)
        candidate['price_krw'] = {'median': median(r['price_krw'] for r in rows), 'min': min(r['price_krw'] for r in rows), 'max': max(r['price_krw'] for r in rows)}
        candidate['supply_area_mapping'] = 'not_verified'
    linked = sorted((r for r in candidates if r['status'] == 'linked_for_validation'), key=lambda r: (r['distance_m'], r['apartment_id']))
    selected = linked[:5]
    checks.extend([
        {'check': 'twelve_completed_months', 'passed': len(summary['requested_months']) == 12 and summary['requested_months'] == rights_summary['requested_months']},
        {'check': 'trade_types_separate', 'passed': all(r['trade_kind'] == 'apt_trade' for r in all_trades) and all(r['trade_kind'] == 'apt_rights' for r in rights_trades)},
        {'check': 'five_address_linked_candidates', 'passed': len(selected) == 5},
        {'check': 'selected_within_radius', 'passed': all(r['within_5km'] for r in selected)},
        {'check': 'selected_distinct_rtms_and_kapt', 'passed': len({r['apartment_id'] for r in selected}) == len({r['kapt_code'] for r in selected}) == len(selected)},
        {'check': 'selected_no_cancelled_or_unverified_trade', 'passed': all(row['eligible_for_comparison_after_matching'] for r in selected for row in groups[r['apartment_id']])},
    ])
    old = read(ROOT / 'api-evidence/20261106_live/recent-trades-normalized.json')
    # 원문 행의 다중집합으로 비교해 값이 같은 별도 거래를 임의로 통합하지 않는다.
    signature = lambda r: json.dumps(r['raw'], sort_keys=True, ensure_ascii=False)
    prior_rows = Counter(signature(r) for r in old)
    fresh_rows = Counter(signature(r) for r in all_trades if r['contract_date'] >= '2026-05-01')
    report = {
        'validated_at': datetime.now(timezone.utc).isoformat(),
        'scope': '광진구 12개월 실거래와 검증 공고의 단지 연결 실증. 주변 전체 지역의 최종 비교 선정은 아님.',
        'source_collections': {'sale': str(collection.relative_to(ROOT)), 'rights': str(rights.relative_to(ROOT))},
        'target': {'announcement': detail['HOUSE_MANAGE_NO'], 'address': detail['HSSPLY_ADRES'], 'exclusive_area_m2': str(target_area), 'supply_area_m2': str(target_supply), 'geocode_source': target_source, 'coordinate_precision': 'parcel_address_point'},
        'test_policy': {'exclusive_area_tolerance_m2': str(args.test_area_tolerance_m2), 'radius_m': 5000, 'maximum_example_complexes': 5, 'product_policy_confirmed': False, 'district_scope': [summary['district']], 'cross_boundary_coverage_verified': False, 'supply_area_equivalence_verified': False},
        'sale': {'records': len(all_trades), 'cancelled': sum(r['cancellation_status'] == 'cancelled' for r in all_trades), 'usable_before_matching': sum(r['eligible_for_comparison_after_matching'] for r in all_trades)},
        'rights': {'records': len(rights_trades), 'cancelled': sum(r['cancellation_status'] == 'cancelled' for r in rights_trades), 'types': dict(Counter(r['rights_type'] for r in rights_trades))},
        'six_month_resnapshot': {'old_rows': len(old), 'new_rows': sum(fresh_rows.values()), 'added_or_changed_rows': sum((fresh_rows - prior_rows).values()), 'removed_or_changed_rows': sum((prior_rows - fresh_rows).values())},
        'candidate_counts': {'area_test_groups': len(groups), 'linked': len(linked), 'review_required': len(candidates) - len(linked), 'issue_counts': dict(Counter(issue for r in candidates for issue in r['issues']))},
        'kapt_details_unavailable': unavailable_basics,
        'selected_examples': selected, 'candidates': candidates, 'captures': cap.entries,
        'checks_passed': sum(c['passed'] for c in checks), 'checks_total': len(checks), 'checks': checks,
        'limitations': ['공급면적 대응표는 미확보이며 전용면적 시험 결과로 대체하지 않음', '인접 시군구를 포함한 5km 전체 탐색 완전성은 미검증', '사례 공고는 접수 종료된 검증용 공고', '최종 가격 비교·개인 자금 판단·수익 추정은 수행하지 않음'],
    }
    dump(output / 'validation.json', report)
    print(json.dumps({k: report[k] for k in ['sale', 'rights', 'six_month_resnapshot', 'candidate_counts', 'checks_passed', 'checks_total']}, ensure_ascii=False))
    return 0 if all(c['passed'] for c in checks) else 1


if __name__ == '__main__':
    raise SystemExit(main())
