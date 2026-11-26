"""주변 실거래의 자동 단지·공급면적 근거(Q-38)와 대표 좌표(Q-39), 작업자 연결을 합성 자료로 오프라인 검사한다."""
import copy
import hashlib
import io
import json
import os
import tempfile
import unittest
import zipfile
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch
from uuid import uuid4

import manage_notice_services as ops
import verify_auto_evidence
from compare_trades import compare_snapshot
from complex_coordinates import (
    KAKAO_SOURCE_ID,
    extract_parcel_spec,
    extract_road_spec,
    is_ambiguous_area_address,
    live_kakao_transport,
    resolve_complex_coordinates,
    strip_kakao_coordinates,
    verify_kakao_response,
)
from complex_evidence import (
    LegalRegionCatalog,
    build_comparison_evidence,
    notice_address_matches_complex,
    parse_house_type_exclusive,
    prefetch_cache_keys,
)
from notice_run_capture import NoticeTransports
from replay_ingestion import ingest
from run_analysis_worker import run_once
from test_notice_pdf_acquisition import DETAIL, PDF, attachment, html_ok, page, pdf_ok
from worker_rpc import WorkerRpc


ROOT = Path(__file__).resolve().parents[1]
SYNTHETIC_FIXTURE = ROOT / 'tests/fixtures/auto-evidence-gwacheon-synthetic.json'
OBSERVED_AT = '2026-10-20T09:00:00+00:00'


def fixed_now():
    return datetime(2026, 10, 20, 9, 0, 0, tzinfo=timezone.utc)


def kakao_ok_envelope(record: dict, *, observed_at: str = OBSERVED_AT) -> dict:
    return {
        'httpStatus': 200,
        'transportError': None,
        'observedAt': observed_at,
        'body': {
            'meta': {'total_count': 1, 'pageable_count': 1, 'is_end': True},
            'documents': [{
                'address_type': 'ROAD_ADDR',
                'x': record['x'],
                'y': record['y'],
                'address': {
                    'b_code': record['b_code'],
                    'mountain_yn': 'N',
                    'main_address_no': record.get('main_address_no', '827'),
                    'sub_address_no': record.get('sub_address_no', ''),
                    'x': record['x'],
                    'y': record['y'],
                },
                'road_address': {
                    'road_name': record['road_name'],
                    'main_building_no': record['main_building_no'],
                    'sub_building_no': record.get('sub_building_no', ''),
                    'x': record['x'],
                    'y': record['y'],
                },
            }],
        },
    }


def make_synthetic_harness(fixture: dict, *, applyhome_override=None, trade_override=None, rights_override=None,
                           kakao_override=None, failed_feeds=()):
    """합성 픽스처로 청약홈·실거래·카카오 전송 함수와 PDF 점검기를 구성한다."""
    directory = copy.deepcopy(fixture['applyhomeDirectory'])
    if applyhome_override is not None:
        directory = applyhome_override(directory)
    trades_by_month = copy.deepcopy(fixture['tradeRows'])
    if trade_override is not None:
        trades_by_month = trade_override(trades_by_month)
    rights_by_month = copy.deepcopy(rights_override or {})
    kakao_map = copy.deepcopy(fixture['kakaoResponses'])
    if kakao_override is not None:
        kakao_map = kakao_override(kakao_map)

    target_notice = copy.deepcopy(fixture['targetNotice'])
    target_models = copy.deepcopy(fixture['targetModels'])
    api_calls = []
    kakao_calls = []

    def filter_rows(rows, scope):
        matched = []
        for row in rows:
            ok = True
            for key, expected in scope.items():
                if not key.startswith('cond[') or not key.endswith(']'):
                    continue
                inner = key[5:-1]
                field, op = inner.split('::', 1)
                actual = str(row.get(field) or '')
                if op == 'EQ' and actual != str(expected):
                    ok = False
                    break
                if op == 'LIKE' and str(expected) not in actual:
                    ok = False
                    break
            if ok:
                matched.append(row)
        return matched

    def api_fetch(source, scope, page_no, page_size):
        api_calls.append((source, dict(scope), page_no, page_size))
        if source in failed_feeds:
            return {'source': source, 'scope': scope, 'page': page_no, 'pageSize': page_size,
                    'httpStatus': 500, 'observedAt': OBSERVED_AT, 'body': None}

        if source in ('applyhome_apt', 'applyhome_remainder'):
            all_rows = list(directory.get(source, []))
            if source == fixture['request']['noticeSource']:
                all_rows = [target_notice] + all_rows
            rows = filter_rows(all_rows, scope)
            body = {'page': page_no, 'perPage': page_size, 'matchCount': len(rows),
                    'currentCount': len(rows), 'data': rows if page_no == 1 else []}
            return {'source': source, 'scope': scope, 'page': page_no, 'pageSize': page_size,
                    'httpStatus': 200, 'observedAt': OBSERVED_AT, 'body': body}

        if source in ('applyhome_apt_model', 'applyhome_remainder_model'):
            hm = scope.get('cond[HOUSE_MANAGE_NO::EQ]')
            pb = scope.get('cond[PBLANC_NO::EQ]')
            pair = f'{hm}/{pb}'
            if source == fixture['request']['noticeSource'] + '_model' and pair == f'{target_notice["HOUSE_MANAGE_NO"]}/{target_notice["PBLANC_NO"]}':
                rows = list(target_models)
            else:
                rows = list(directory.get(source, {}).get(pair, []))
            body = {'page': page_no, 'perPage': page_size, 'matchCount': len(rows),
                    'currentCount': len(rows), 'data': rows if page_no == 1 else []}
            return {'source': source, 'scope': scope, 'page': page_no, 'pageSize': page_size,
                    'httpStatus': 200, 'observedAt': OBSERVED_AT, 'body': body}

        if source in ('apt_trade', 'apt_rights'):
            ym = scope.get('DEAL_YMD')
            src_map = trades_by_month if source == 'apt_trade' else rights_by_month
            rows = list(src_map.get(ym, [])) if page_no == 1 else []
            items = {'item': rows} if rows else {}
            body = {'response': {'header': {'resultCode': '000'}, 'body': {
                'numOfRows': page_size, 'pageNo': page_no, 'totalCount': len(rows), 'items': items}}}
            return {'source': source, 'scope': scope, 'page': page_no, 'pageSize': page_size,
                    'httpStatus': 200, 'observedAt': OBSERVED_AT, 'body': body}

        raise AssertionError(f'예상하지 않은 API 출처: {source}')

    def kakao_fetch(query):
        kakao_calls.append(query)
        record = kakao_map.get(query)
        if record is None:
            return {'httpStatus': 200, 'transportError': None, 'observedAt': OBSERVED_AT,
                    'body': {'meta': {'total_count': 0, 'pageable_count': 0, 'is_end': True}, 'documents': []}}
        if isinstance(record, dict) and 'httpStatus' in record:
            return record
        return kakao_ok_envelope(record)

    pdf_spec = fixture['pdfReviewEvidence']

    def review_documents(target, catalog):
        doc_id = 'synthetic-official-doc-1'
        doc_ver = 'a' * 64
        doc_meta = {
            'id': doc_id, 'version': doc_ver, 'source': 'official', 'originCheck': 'confirmed',
            'status': 'accepted', 'houseManageNo': target['houseManageNo'], 'noticeNo': target['noticeNo'],
            'edition': target['edition'], 'role': 'original',
        }
        return {
            'documentVersions': [doc_meta],
            'issues': [],
            'evidence': [
                {'document': doc_meta, 'modelNo': pdf_spec['modelNo'],
                 'houseType': pdf_spec['houseType'], 'item': 'supply_area', 'basis': 'supply',
                 'unit': 'm2', 'm2': pdf_spec['supplyAreaM2'], 'check': 'confirmed', 'page': 4},
                {'document': doc_meta, 'modelNo': pdf_spec['modelNo'],
                 'houseType': pdf_spec['houseType'], 'room': pdf_spec['room'], 'item': 'sale_price',
                 'unit': 'won', 'won': pdf_spec['salePriceWon'], 'check': 'confirmed', 'page': 4},
                {'document': doc_meta, 'modelNo': pdf_spec['modelNo'],
                 'houseType': pdf_spec['houseType'], 'room': pdf_spec['room'], 'item': 'required_options',
                 'unit': 'won', 'won': pdf_spec['requiredOptionsWon'], 'check': 'confirmed', 'page': 5},
            ],
        }

    return api_fetch, kakao_fetch, review_documents, api_calls, kakao_calls


class AutoEvidenceCoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(SYNTHETIC_FIXTURE.read_text(encoding='utf-8'))
        cls.catalog = LegalRegionCatalog.from_mois_tsv_text(cls.fixture['regionTsv'])

    def _capture(self, **kwargs):
        api_fetch, kakao_fetch, review_documents, api_calls, kakao_calls = make_synthetic_harness(self.fixture, **kwargs)
        cap = ingest(self.fixture['request'], api_fetch, data_origin='collected', review_documents=review_documents)
        api_calls.clear()
        return cap, api_fetch, kakao_fetch, api_calls, kakao_calls

    def test_gwacheon_synthetic_fixture_end_to_end_multi_notice_and_distance_ranking(self):
        """과천 갈현동 84D(전용 84.7450 -> 공급 110.3239, 3개 공고 일치) 합성 픽스처 종단 비교와 거리순 순위(A-21·A-53)."""
        self.assertEqual(self.fixture['dataOrigin'], 'synthetic')
        cap, api_fetch, kakao_fetch, api_calls, kakao_calls = self._capture()

        built = build_comparison_evidence(
            cap, region_catalog=self.catalog, api_fetch=api_fetch, kakao_fetch=kakao_fetch,
            model_no='01',
            permissions={'applyhomeApt': True, 'applyhomeRemainder': True, 'moisRegions': True,
                         'kakaoRuntime': True, 'kakaoStorage': False},
            now=fixed_now,
        )
        self.assertEqual(built['status'], 'ready')
        self.assertGreater(len(api_calls), 0)
        self.assertEqual(built['metadata']['calls']['applyhome'], len(api_calls))
        self.assertEqual(built['metadata']['calls']['kakao'], len(kakao_calls))
        # 카카오 저장 미허용 시 저장용 근거에는 좌표·kakao_address를 넣지 않고 실행용 근거에만 둔다.
        self.assertFalse(built['metadata']['coordinatesPersisted'])
        self.assertNotIn(KAKAO_SOURCE_ID, built['persistedSourceIds'])
        self.assertTrue(all('coordinates' not in c for c in built['persistedEvidence']['complexes']))
        self.assertTrue(all('coordinates' in c for c in built['runtimeEvidence']['complexes']))
        self.assertTrue(all(e['cacheKind'] != 'kakao_road_coordinate' for e in built['newCacheEntries']))

        # 3개 공고(최초 APT + 무순위 2회차) 모두 근거 reference에 남는다.
        bellarte_links = [l for l in built['runtimeEvidence']['tradeLinks'] if l['complexId'] == 'aptseq:91290-101']
        self.assertEqual(len(bellarte_links), 3)
        for link in bellarte_links:
            self.assertEqual(link['supplyAreaM2'], '110.3239')
            ref = link['evidence']['reference']
            self.assertIn('9129010001/9129010001:084.7450D', ref)
            self.assertIn('9129010002/9129010002:084.7450D', ref)
            self.assertIn('9129010003/9129010003:084.7450D', ref)
            # 분당구 갈현동 동명 단지(9113599001, 공급면적 118.9999)는 시·군·구 불일치로 섞이지 않는다(A-08).
            self.assertNotIn('9113599001', ref)

        comparison = compare_snapshot(cap, {'modelNo': '01', 'room': '101동 101호'}, built['runtimeEvidence'])
        self.assertEqual(comparison['completeness'], 'complete')
        self.assertEqual(comparison['appliedScope'], 'priority')
        self.assertTrue(comparison['rankingComplete'])
        self.assertEqual(comparison['holds'], [])
        # 두 단지 모두 면적 차이 0㎡ 동률 -> 직선거리가 더 가까운 합성제이드(91290-102)가 1위, 합성벨라르테(91290-101)가 2위!
        self.assertEqual([c['complexId'] for c in comparison['comparables']], ['aptseq:91290-102', 'aptseq:91290-101'])
        self.assertEqual([c['rank'] for c in comparison['comparables']], [1, 2])
        self.assertLess(comparison['comparables'][0]['distance']['meters'], comparison['comparables'][1]['distance']['meters'])
        self.assertEqual(comparison['comparables'][0]['distance']['evidence'][0]['source'], KAKAO_SOURCE_ID)
        # 합성벨라르테 매매 통계(해제 1건 제외, 유효 3건: 13.2억·13.5억·13.8억)
        bellarte_sale = comparison['comparables'][1]['tradeStats']['sale']
        self.assertEqual((bellarte_sale['status'], bellarte_sale['count'], bellarte_sale['minWon'],
                          bellarte_sale['medianWon'], bellarte_sale['maxWon']),
                         ('confirmed', 3, '1320000000', '1350000000', '1380000000'))
        # 합성제이드 매매 통계(유효 2건: 12.9억·13.1억 -> 중위 13.0억, 적은 표본)
        jade_sale = comparison['comparables'][0]['tradeStats']['sale']
        self.assertEqual((jade_sale['count'], jade_sale['medianWon'], jade_sale['smallSample']),
                         (2, '1300000000', True))

    def test_q38_exact_decimal_and_all_hold_branches(self):
        """Q-38: 유일 십진 일치, 복수 주택형 보류, 공고 간 공급면적 불일치 보류, 공고 없음 보류, 동명·다른 지번 미연결(A-08), aptSeq 충돌."""
        self.assertEqual(parse_house_type_exclusive('084.7450D'), (Decimal('84.7450'), 'D'))
        self.assertEqual(parse_house_type_exclusive('059.9800'), (Decimal('59.9800'), ''))
        self.assertIsNone(parse_house_type_exclusive('특별형'))

        # 1) 같은 전용면적의 복수 주택형(084.7450A, 084.7450B) -> multiple_housing_types 보류
        def add_multi_type(directory):
            directory['applyhome_apt_model']['9129020001/9129020001'].append({
                'HOUSE_MANAGE_NO': '9129020001', 'PBLANC_NO': '9129020001',
                'MODEL_NO': '05', 'HOUSE_TY': '084.7450B', 'SUPLY_AR': '110.9000',
            })
            return directory

        cap, api_fetch, _, _, _ = self._capture(applyhome_override=add_multi_type)
        built = build_comparison_evidence(cap, region_catalog=self.catalog, api_fetch=api_fetch, model_no='01', now=fixed_now)
        jade_meta = next(c for c in built['metadata']['complexes'] if c['complexId'] == 'aptseq:91290-102')
        self.assertEqual((jade_meta['status'], jade_meta['reasonCode']), ('held', 'multiple_housing_types'))
        comp = compare_snapshot(cap, {'modelNo': '01', 'room': '101동 101호'}, built['runtimeEvidence'])
        self.assertTrue(any(h.get('complexId') == 'aptseq:91290-102' and h.get('reasonCode') == 'trade_supply_area_unverified'
                            for h in comp['holds']))

        # 2) 공고 간 공급면적 불일치 -> supply_area_mismatch_across_notices 보류
        def mismatch_supply(directory):
            directory['applyhome_remainder_model']['9129010002/9129010002'][0]['SUPLY_AR'] = '111.0000'
            return directory

        cap, api_fetch, _, _, _ = self._capture(applyhome_override=mismatch_supply)
        built = build_comparison_evidence(cap, region_catalog=self.catalog, api_fetch=api_fetch, model_no='01', now=fixed_now)
        bell_meta = next(c for c in built['metadata']['complexes'] if c['complexId'] == 'aptseq:91290-101')
        self.assertEqual((bell_meta['status'], bell_meta['reasonCode']), ('held', 'supply_area_mismatch_across_notices'))

        # 3) 공고 없음 -> notice_not_found 보류
        def remove_jade_notice(directory):
            directory['applyhome_apt'] = [r for r in directory['applyhome_apt'] if r['HOUSE_MANAGE_NO'] != '9129020001']
            return directory

        cap, api_fetch, _, _, _ = self._capture(applyhome_override=remove_jade_notice)
        built = build_comparison_evidence(cap, region_catalog=self.catalog, api_fetch=api_fetch, model_no='01', now=fixed_now)
        jade_meta = next(c for c in built['metadata']['complexes'] if c['complexId'] == 'aptseq:91290-102')
        self.assertEqual((jade_meta['status'], jade_meta['reasonCode']), ('held', 'notice_not_found'))

        # 4) 이름은 같지만 지번·도로명이 다른 단지 -> 미연결(complex_identity_mismatch, A-08)
        def same_name_wrong_jibun(directory):
            for row in directory['applyhome_apt']:
                if row['HOUSE_MANAGE_NO'] == '9129020001':
                    row['HSSPLY_ADRES'] = '경기도 합성과천시 갈현동 999'
            return directory

        cap, api_fetch, _, _, _ = self._capture(applyhome_override=same_name_wrong_jibun)
        built = build_comparison_evidence(cap, region_catalog=self.catalog, api_fetch=api_fetch, model_no='01', now=fixed_now)
        jade_meta = next(c for c in built['metadata']['complexes'] if c['complexId'] == 'aptseq:91290-102')
        self.assertEqual((jade_meta['status'], jade_meta['reasonCode']), ('held', 'complex_identity_mismatch'))

        # 5) 전용면적 반올림·±1㎡ 미적용: 84.75는 084.7450D와 일치하지 않는다.
        def rounded_exclusive(trades):
            trades['202609'][3]['excluUseAr'] = '84.75'
            trades['202610'][1]['excluUseAr'] = '84.75'
            return trades

        cap, api_fetch, _, _, _ = self._capture(trade_override=rounded_exclusive)
        built = build_comparison_evidence(cap, region_catalog=self.catalog, api_fetch=api_fetch, model_no='01', now=fixed_now)
        jade_meta = next(c for c in built['metadata']['complexes'] if c['complexId'] == 'aptseq:91290-102')
        self.assertEqual((jade_meta['status'], jade_meta['reasonCode']), ('held', 'housing_type_not_found'))

        # 6) 같은 aptSeq 안의 지번 충돌 -> complex_identifier_conflict -> trade_link_conflict
        def conflicting_aptseq(trades):
            trades['202610'][1]['jibun'] = '832'
            trades['202610'][1]['bonbun'] = '0832'
            return trades

        cap, api_fetch, _, _, _ = self._capture(trade_override=conflicting_aptseq)
        built = build_comparison_evidence(cap, region_catalog=self.catalog, api_fetch=api_fetch, model_no='01', now=fixed_now)
        jade_meta = next(c for c in built['metadata']['complexes'] if c['complexId'] == 'aptseq:91290-102')
        self.assertEqual((jade_meta['status'], jade_meta['reasonCode']), ('held', 'complex_identifier_conflict'))
        comp = compare_snapshot(cap, {'modelNo': '01', 'room': '101동 101호'}, built['runtimeEvidence'])
        self.assertTrue(any(h['reasonCode'] == 'trade_link_conflict' for h in comp['holds']))

    def test_q38_target_self_trade_separated_and_eup_myeon_region_catalog(self):
        """대상 단지 자체 거래는 targetReferences로 분리(A-22·A-23)하고 읍·면·리/구 없는 시·군 체계를 보존한다(A-55)."""
        # 구 없는 시·군과 일반구 시·읍·면·리 확인
        self.assertEqual(self.catalog.sgg_entry('91290')['expansionKind'], 'municipality')
        self.assertEqual(self.catalog.sgg_entry('91135')['expansionKind'], 'district')
        self.assertIsNone(self.catalog.sgg_entry('91130'))  # 일반구 상위 시는 제외
        gapyeong_loc = self.catalog.resolve_locality_in_sgg('91820', '경기도 합성가평군 가평읍 대곡리 123')
        self.assertEqual((gapyeong_loc['localityCode'], gapyeong_loc['localityType']), ('9182025000', 'eup'))
        matched, kind = notice_address_matches_complex(
            '경기도 합성가평군 가평읍 대곡리 123', self.catalog,
            sgg_code='91820', locality_code='9182025000', locality_name='가평읍',
            parcel={'localityCode': '9182025000', 'subName': '대곡리', 'isMountain': False, 'mainNo': 123, 'subNo': 0},
            road=None,
        )
        self.assertEqual((matched, kind), (True, 'parcel'))

        # 대상 단지(갈현로 10)의 자체 거래 추가
        def add_target_self_trade(trades):
            trades['202610'].append({
                'aptSeq': '91290-001', 'aptNm': '합성과천 갈현타운 대상단지', 'sggCd': '91290', 'umdCd': '10600',
                'umdNm': '갈현동', 'jibun': '810', 'landCd': '1', 'bonbun': '0810', 'bubun': '0000',
                'roadNmSggCd': '91290', 'roadNm': '갈현로', 'roadNmBonbun': '00010', 'roadNmBubun': '00000',
                'excluUseAr': '84.7450', 'dealAmount': '128,000', 'dealYear': '2026', 'dealMonth': '10',
                'dealDay': '15', 'floor': '5', 'buildYear': '2026', 'cdealType': '', 'cdealDay': '',
            })
            return trades

        cap, api_fetch, kakao_fetch, _, _ = self._capture(trade_override=add_target_self_trade)
        built = build_comparison_evidence(cap, region_catalog=self.catalog, api_fetch=api_fetch,
                                          kakao_fetch=kakao_fetch, model_no='01', now=fixed_now)
        comp = compare_snapshot(cap, {'modelNo': '01', 'room': '101동 101호'}, built['runtimeEvidence'])
        self.assertEqual(len(comp['targetReferences']), 1)
        self.assertEqual(comp['targetReferences'][0]['tradeStats']['sale']['medianWon'], '1280000000')
        self.assertNotIn(comp['target']['complexId'], [c['complexId'] for c in comp['comparables']])

    def test_q39_coordinate_branches_and_unverified_distance_never_zero(self):
        """Q-39: 유일·법정동 일치, 복수 결과, 법정동·건물번호 불일치, '일원'/'블록', 키 없음, 저장 허용/미허용, 동률 보류."""
        # 주소 모호 표기 판정
        self.assertTrue(is_ambiguous_area_address('경기도 합성과천시 갈현동 일원'))
        self.assertTrue(is_ambiguous_area_address('경기도 합성과천시 지식정보타운 S6블록'))
        self.assertTrue(is_ambiguous_area_address('경기도 합성과천시 갈현동 827 외 3필지'))
        # 괄호 참고항목 안의 블록 표기는 단일 도로명주소를 무효화하지 않는다.
        self.assertFalse(is_ambiguous_area_address('경기도 합성과천시 갈현로 15 (갈현동, S6블록)'))
        self.assertEqual(extract_road_spec('경기도 합성과천시 갈현로 15 (갈현동, S6블록)'),
                         {'roadName': '갈현로', 'mainNo': 15, 'subNo': 0})
        self.assertEqual(extract_parcel_spec('경기도 합성과천시 갈현동 827-3'),
                         {'localityToken': '갈현동', 'isMountain': False, 'mainNo': 827, 'subNo': 3})
        self.assertIsNone(live_kakao_transport(''))

        expected_road = {'roadName': '갈현로', 'mainNo': 15, 'subNo': 0}
        # 1) 유일·법정동·건물번호 일치 -> confirmed
        ok_env = kakao_ok_envelope({'b_code': '9129010600', 'road_name': '갈현로', 'main_building_no': '15',
                                    'sub_building_no': '', 'x': '126.985000', 'y': '37.415000'})
        res_ok = verify_kakao_response(ok_env, expected_locality_code='9129010600', expected_road=expected_road)
        self.assertEqual(res_ok['status'], 'confirmed')
        self.assertEqual(res_ok['coordinates']['evidence']['source'], KAKAO_SOURCE_ID)

        # 2) 복수 결과 -> coordinate_ambiguous_multiple
        multi_env = copy.deepcopy(ok_env)
        multi_env['body']['meta']['total_count'] = 2
        self.assertEqual(
            verify_kakao_response(multi_env, expected_locality_code='9129010600', expected_road=expected_road)['reasonCode'],
            'coordinate_ambiguous_multiple',
        )
        # 3) 법정동 불일치 -> coordinate_region_mismatch
        wrong_bcode = copy.deepcopy(ok_env)
        wrong_bcode['body']['documents'][0]['address']['b_code'] = '9129010200'
        self.assertEqual(
            verify_kakao_response(wrong_bcode, expected_locality_code='9129010600', expected_road=expected_road)['reasonCode'],
            'coordinate_region_mismatch',
        )
        # 4) 건물번호 불일치 -> coordinate_building_mismatch
        wrong_bldg = copy.deepcopy(ok_env)
        wrong_bldg['body']['documents'][0]['road_address']['main_building_no'] = '16'
        self.assertEqual(
            verify_kakao_response(wrong_bldg, expected_locality_code='9129010600', expected_road=expected_road)['reasonCode'],
            'coordinate_building_mismatch',
        )

        # 5) 공고 주소 '일원'은 카카오를 호출하지 않고 미확인
        called = []
        ambig = resolve_complex_coordinates(
            [{'complexId': 'target:1', 'localityCode': '9129010600', 'localityType': 'dong',
              'sggFullName': '경기도 합성과천시', 'noticeAddress': '경기도 합성과천시 갈현동 일원'}],
            lambda q: called.append(q) or ok_env,
            allow_runtime=True, allow_storage=False, now=fixed_now,
        )
        self.assertEqual(called, [])
        self.assertEqual(ambig['results']['target:1']['reasonCode'], 'address_ambiguous_area')

        # 6) 키 없음(kakao_fetch=None) -> 실패가 아니라 좌표 미확인, 동률 순위는 rankingComplete=False(거리 0 채움 금지)
        cap, api_fetch, _, _, _ = self._capture()
        built = build_comparison_evidence(
            cap, region_catalog=self.catalog, api_fetch=api_fetch, kakao_fetch=None,
            model_no='01', now=fixed_now,
        )
        self.assertEqual(built['status'], 'ready')
        self.assertEqual(built['metadata']['targetCoordinateReasonCode'], 'kakao_key_missing')
        comp = compare_snapshot(cap, {'modelNo': '01', 'room': '101동 101호'}, built['runtimeEvidence'])
        self.assertFalse(comp['rankingComplete'])
        self.assertTrue(any(h['reasonCode'] == 'straight_line_distance_unverified' for h in comp['holds']))
        for row in comp['comparables']:
            self.assertEqual(row['distance']['status'], 'unverified')
            self.assertIsNone(row['distance']['meters'])

        # 7) allow_storage=True이면 좌표가 persistedEvidence와 newCacheEntries(expiresAt 포함)에 저장된다.
        cap, api_fetch, kakao_fetch, _, _ = self._capture()
        built_stored = build_comparison_evidence(
            cap, region_catalog=self.catalog, api_fetch=api_fetch, kakao_fetch=kakao_fetch,
            model_no='01',
            permissions={'applyhomeApt': True, 'applyhomeRemainder': True, 'moisRegions': True,
                         'kakaoRuntime': True, 'kakaoStorage': True},
            now=fixed_now,
        )
        self.assertTrue(built_stored['metadata']['coordinatesPersisted'])
        self.assertIn(KAKAO_SOURCE_ID, built_stored['persistedSourceIds'])
        kakao_cache_items = [e for e in built_stored['newCacheEntries'] if e['cacheKind'] == 'kakao_road_coordinate']
        self.assertEqual(len(kakao_cache_items), 3)
        self.assertTrue(all('expiresAt' in e and 'entryData' in e and 'payload' not in e for e in kakao_cache_items))
        stripped = strip_kakao_coordinates(built_stored['persistedEvidence'])
        self.assertTrue(all('coordinates' not in c for c in stripped['complexes']))

    def test_lookup_failure_holds_priority_without_expanding_a06(self):
        """청약홈 근거 조회 실패 시 정상 0개로 처리하지 않고 우선 지역에서 보류하며 확대하지 않는다(A-06)."""
        def add_expansion_trade(trades):
            trades['202610'].append({
                'aptSeq': '91290-901', 'aptNm': '합성별양단지', 'sggCd': '91290', 'umdCd': '10200',
                'umdNm': '별양동', 'jibun': '50', 'landCd': '1', 'bonbun': '0050', 'bubun': '0000',
                'roadNmSggCd': '91290', 'roadNm': '별양로', 'roadNmBonbun': '00050', 'roadNmBubun': '00000',
                'excluUseAr': '84.7450', 'dealAmount': '140,000', 'dealYear': '2026', 'dealMonth': '10',
                'dealDay': '10', 'floor': '10', 'buildYear': '2020', 'cdealType': '', 'cdealDay': '',
            })
            return trades

        cap, api_fetch, _, api_calls, _ = self._capture(trade_override=add_expansion_trade)

        def failing_evidence_api(source, scope, page_no, page_size):
            if source == 'applyhome_apt':
                return {'source': source, 'scope': scope, 'page': page_no, 'pageSize': page_size,
                        'httpStatus': 503, 'observedAt': OBSERVED_AT, 'body': None}
            return api_fetch(source, scope, page_no, page_size)

        built = build_comparison_evidence(
            cap, region_catalog=self.catalog, api_fetch=failing_evidence_api,
            model_no='01', now=fixed_now,
        )
        self.assertEqual(built['metadata']['scopeChecked'], 'priority')
        self.assertEqual(built['metadata']['complexSummary']['holdReasons'].get('lookup_failed'), 2)
        comp = compare_snapshot(cap, {'modelNo': '01', 'room': '101동 101호'}, built['runtimeEvidence'])
        self.assertEqual(comp['appliedScope'], 'priority')
        self.assertIsNone(comp['regionDecision']['expansion'])
        self.assertEqual(comp['regionDecision']['priority']['conclusion'], 'held')

    def test_priority_normal_zero_expands_automatically_a05(self):
        """우선 지역이 ±5% 밖 확인 거래만 있어 정상 0개이면 같은 시·군 확대 지역 근거를 자동 조회한다(A-05)."""
        def add_byeolyang(directory):
            directory['applyhome_apt'].append({
                'HOUSE_MANAGE_NO': '9129090001', 'PBLANC_NO': '9129090001', 'HOUSE_NM': '합성별양단지',
                'HOUSE_SECD': '01', 'HOUSE_SECD_NM': 'APT',
                'HSSPLY_ADRES': '경기도 합성과천시 별양동 50', 'RCRIT_PBLANC_DE': '2021-04-01',
            })
            directory['applyhome_apt_model']['9129090001/9129090001'] = [{
                'HOUSE_MANAGE_NO': '9129090001', 'PBLANC_NO': '9129090001',
                'MODEL_NO': '01', 'HOUSE_TY': '084.7450D', 'SUPLY_AR': '110.3239',
            }]
            return directory

        def priority_outside_area_and_expansion_match(trades):
            # 갈현동에는 59.9100(공급 79.8000㎡, ±5% 범위 밖) 거래만 있고, 별양동에 84.7450(공급 110.3239㎡) 거래가 있다.
            return {
                '202609': [{
                    'aptSeq': '91290-101', 'aptNm': '합성과천 벨라르테', 'sggCd': '91290', 'umdCd': '10600',
                    'umdNm': '갈현동', 'jibun': '827', 'landCd': '1', 'bonbun': '0827', 'bubun': '0000',
                    'roadNmSggCd': '91290', 'roadNm': '갈현로', 'roadNmBonbun': '00015', 'roadNmBubun': '00000',
                    'excluUseAr': '59.9100', 'dealAmount': '98,000', 'dealYear': '2026', 'dealMonth': '9',
                    'dealDay': '12', 'floor': '6', 'buildYear': '2023', 'cdealType': '', 'cdealDay': '',
                }],
                '202610': [{
                    'aptSeq': '91290-901', 'aptNm': '합성별양단지', 'sggCd': '91290', 'umdCd': '10200',
                    'umdNm': '별양동', 'jibun': '50', 'landCd': '1', 'bonbun': '0050', 'bubun': '0000',
                    'roadNmSggCd': '91290', 'roadNm': '별양로', 'roadNmBonbun': '00050', 'roadNmBubun': '00000',
                    'excluUseAr': '84.7450', 'dealAmount': '142,000', 'dealYear': '2026', 'dealMonth': '10',
                    'dealDay': '08', 'floor': '11', 'buildYear': '2021', 'cdealType': '', 'cdealDay': '',
                }],
            }

        cap, api_fetch, _, _, _ = self._capture(
            applyhome_override=add_byeolyang,
            trade_override=priority_outside_area_and_expansion_match,
        )
        built = build_comparison_evidence(cap, region_catalog=self.catalog, api_fetch=api_fetch, model_no='01', now=fixed_now)
        self.assertEqual(built['metadata']['scopeChecked'], 'expansion')
        comp = compare_snapshot(cap, {'modelNo': '01', 'room': '101동 101호'}, built['runtimeEvidence'])
        self.assertEqual(comp['appliedScope'], 'expansion')
        self.assertEqual(comp['regionDecision']['priority']['conclusion'], 'normal_zero')
        self.assertEqual(comp['regionDecision']['expansion']['conclusion'], 'candidates_found')
        self.assertEqual([c['complexId'] for c in comp['comparables']], ['aptseq:91290-901'])
        self.assertEqual(comp['comparables'][0]['tradeStats']['sale']['medianWon'], '1420000000')

    def test_call_limits_and_cache_hits_priority(self):
        """호출 상한 초과 시 정상 0개가 아니라 보류하며, 캐시 적중 시 외부 호출 없이 0회로 재사용한다."""
        cap, api_fetch, kakao_fetch, api_calls, kakao_calls = self._capture()
        # 1) 청약홈 호출 상한 1회 -> 예산 초과 보류
        limited = build_comparison_evidence(
            cap, region_catalog=self.catalog, api_fetch=api_fetch, kakao_fetch=kakao_fetch,
            model_no='01', max_applyhome_calls=1, max_kakao_calls=1, now=fixed_now,
        )
        self.assertTrue(limited['metadata']['budgetReached']['applyhome'])
        self.assertEqual(limited['metadata']['calls']['applyhome'], 1)
        self.assertGreaterEqual(limited['metadata']['complexSummary']['holdReasons'].get('lookup_budget_exceeded', 0), 1)
        comp_limited = compare_snapshot(cap, {'modelNo': '01', 'room': '101동 101호'}, limited['runtimeEvidence'])
        self.assertEqual(comp_limited['regionDecision']['priority']['conclusion'], 'held')

        # 2) 카카오 호출 상한 1회 -> 대상 1건 후 후보 2건은 coordinate_budget_exceeded 보류
        api_calls.clear()
        kakao_calls.clear()
        kakao_limited = build_comparison_evidence(
            cap, region_catalog=self.catalog, api_fetch=api_fetch, kakao_fetch=kakao_fetch,
            model_no='01', max_kakao_calls=1, now=fixed_now,
        )
        self.assertTrue(kakao_limited['metadata']['budgetReached']['kakao'])
        self.assertEqual(kakao_limited['metadata']['calls']['kakao'], 1)

        # 3) 첫 실행이 생성한 캐시 항목으로 두 번째 실행은 외부 호출 0회!
        full = build_comparison_evidence(
            cap, region_catalog=self.catalog, api_fetch=api_fetch, kakao_fetch=kakao_fetch,
            model_no='01',
            permissions={'applyhomeApt': True, 'applyhomeRemainder': True, 'moisRegions': True,
                         'kakaoRuntime': True, 'kakaoStorage': True},
            now=fixed_now,
        )
        applyhome_cache = {e['complexKey']: e['entryData'] for e in full['newCacheEntries']
                           if e['cacheKind'] == 'applyhome_supply_area'}
        kakao_cache = {e['complexKey']: e['entryData'] for e in full['newCacheEntries']
                       if e['cacheKind'] == 'kakao_road_coordinate'}
        self.assertTrue(set(prefetch_cache_keys(cap)) >= set(applyhome_cache))

        api_calls.clear()
        kakao_calls.clear()
        cached_run = build_comparison_evidence(
            cap, region_catalog=self.catalog, api_fetch=api_fetch, kakao_fetch=kakao_fetch,
            model_no='01',
            permissions={'applyhomeApt': True, 'applyhomeRemainder': True, 'moisRegions': True,
                         'kakaoRuntime': True, 'kakaoStorage': True},
            applyhome_cache=applyhome_cache, kakao_cache=kakao_cache, now=fixed_now,
        )
        self.assertEqual((len(api_calls), len(kakao_calls)), (0, 0))
        self.assertEqual((cached_run['metadata']['calls']['applyhome'], cached_run['metadata']['calls']['kakao']), (0, 0))
        self.assertEqual(cached_run['metadata']['cacheHits']['applyhome'], 2)
        self.assertEqual(cached_run['metadata']['cacheHits']['kakao'], 3)

    def test_mois_zip_archive_province_aliases_token_boundaries_and_rtms_blanks(self):
        """법정동 ZIP 압축본(UTF-8/CP949), 구 시·도 명칭, 동 토큰 경계, RTMS 공백/00000, 특수 도로명·지하 주소를 검증한다."""
        # 1) download_region_zip()과 같은 ZIP 압축본(UTF-8 및 CP949) 정상 적재 + 잘못된 ZIP 거부
        extra_tsv = (
            self.fixture['regionTsv']
            + '9200000000\t강원특별자치도\t존재\n'
            + '9211000000\t강원특별자치도 합성춘천시\t존재\n'
            + '9211010100\t강원특별자치도 합성춘천시 중앙동\t존재\n'
        )
        for enc in ('utf-8-sig', 'cp949'):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
                zf.writestr('법정동코드 전체자료.txt', extra_tsv.encode(enc))
            loaded = LegalRegionCatalog.from_mois_tsv_bytes(buf.getvalue())
            self.assertEqual(loaded.resolve_sgg_code('강원도 합성춘천시 중앙동 12'), '92110')
            self.assertEqual(loaded.resolve_sgg_code('강원 합성춘천시 중앙동 12'), '92110')
            self.assertEqual(loaded.resolve_locality_in_sgg('91290', '경기도 합성과천시 별양동길 10 (갈현동)')['localityCode'],
                             '9129010600')

        bad_zip = io.BytesIO()
        with zipfile.ZipFile(bad_zip, 'w') as zf:
            zf.writestr('a.txt', b'x')
            zf.writestr('b.txt', b'y')
        with self.assertRaises(ValueError):
            LegalRegionCatalog.from_mois_tsv_bytes(bad_zip.getvalue())

        # 2) 특수 도로명(4.19로, G밸리로) 파싱 및 지하 주소·underground_yn='Y' 차단
        self.assertEqual(extract_road_spec('서울특별시 강북구 4.19로 15'), {'roadName': '4.19로', 'mainNo': 15, 'subNo': 0})
        self.assertEqual(extract_road_spec('서울특별시 금천구 G밸리로 20-3'), {'roadName': 'G밸리로', 'mainNo': 20, 'subNo': 3})
        self.assertIsNone(extract_road_spec('경기도 합성과천시 갈현로 지하 15'))
        ug_env = kakao_ok_envelope({'b_code': '9129010600', 'road_name': '갈현로', 'main_building_no': '15',
                                    'sub_building_no': '', 'x': '126.985000', 'y': '37.415000'})
        ug_env['body']['documents'][0]['road_address']['underground_yn'] = 'Y'
        self.assertEqual(
            verify_kakao_response(ug_env, expected_locality_code='9129010600',
                                  expected_road={'roadName': '갈현로', 'mainNo': 15, 'subNo': 0})['reasonCode'],
            'coordinate_building_mismatch',
        )

        # 3) RTMS XML의 공백(' ')·00000 미기재 필드는 충돌이 아니라 미기재로 처리한다.
        def rtms_blank_road(trades):
            for row in trades['202609'] + trades['202610']:
                if row['aptSeq'] == '91290-101':
                    row['roadNm'] = ' '
                    row['roadNmBonbun'] = '00000'
                    row['roadNmBubun'] = '00000'
                    row['landCd'] = ' '
                    row['bonbun'] = '0000'
            return trades

        cap, api_fetch, kakao_fetch, _, _ = self._capture(trade_override=rtms_blank_road)
        built = build_comparison_evidence(cap, region_catalog=self.catalog, api_fetch=api_fetch,
                                          kakao_fetch=kakao_fetch, model_no='01', now=fixed_now)
        bell_meta = next(c for c in built['metadata']['complexes'] if c['complexId'] == 'aptseq:91290-101')
        self.assertEqual(bell_meta['status'], 'confirmed')
        self.assertEqual(bell_meta['coordinateReasonCode'], 'road_address_missing')

    def test_rights_merges_with_sale_complex_and_missing_batch_blocks_expansion_and_target_q38(self):
        """권리 거래 동일 단지 합산(Q-08), 누락 수집 배치 시 확대 차단(A-06), 대상 자체 거래의 과거 공고 불일치 보류(Q-38)."""
        # 1) 분양권 거래가 같은 지번·단지명의 매매 단지에 합쳐져 고유 단지 1개·거래 종류별 분리 통계로 집계된다.
        rights_rows = {
            '202610': [{
                'aptNm': '합성과천 벨라르테', 'sggCd': '91290', 'sggNm': '합성과천시', 'umdNm': '갈현동', 'jibun': '827',
                'excluUseAr': '84.7450', 'dealAmount': '136,000', 'dealYear': '2026', 'dealMonth': '10', 'dealDay': '14',
                'floor': '9', 'ownershipGbn': ' ', 'cdealType': '', 'cdealDay': '',
            }],
        }
        cap, api_fetch, kakao_fetch, _, _ = self._capture(rights_override=rights_rows)
        built = build_comparison_evidence(cap, region_catalog=self.catalog, api_fetch=api_fetch,
                                          kakao_fetch=kakao_fetch, model_no='01', now=fixed_now)
        comp = compare_snapshot(cap, {'modelNo': '01', 'room': '101동 101호'}, built['runtimeEvidence'])
        self.assertEqual(len(comp['comparables']), 2)
        bell = next(c for c in comp['comparables'] if c['complexId'] == 'aptseq:91290-101')
        self.assertEqual(bell['tradeStats']['sale']['count'], 3)
        self.assertEqual(bell['tradeStats']['presale_right']['count'], 1)
        self.assertEqual(bell['tradeStats']['presale_right']['medianWon'], '1360000000')

        # 2) 대상 공고와 같은 주소의 과거 APT 공고에 같은 전용면적의 다른 공급면적이 있으면 대상 자체 거래도 보류한다(Q-38).
        def target_with_earlier_mismatch(directory):
            directory['applyhome_apt'].append({
                'HOUSE_MANAGE_NO': '9129000099', 'PBLANC_NO': '9129000099', 'HOUSE_NM': '합성과천 갈현타운 대상단지',
                'HOUSE_SECD': '01', 'HOUSE_SECD_NM': 'APT',
                'HSSPLY_ADRES': '경기도 합성과천시 갈현로 10 (갈현동)', 'RCRIT_PBLANC_DE': '2023-05-01',
            })
            directory['applyhome_apt_model']['9129000099/9129000099'] = [{
                'HOUSE_MANAGE_NO': '9129000099', 'PBLANC_NO': '9129000099',
                'MODEL_NO': '01', 'HOUSE_TY': '084.7450D', 'SUPLY_AR': '112.0000',
            }]
            return directory

        def add_target_self(trades):
            trades['202610'].append({
                'aptSeq': '91290-001', 'aptNm': '합성과천 갈현타운 대상단지', 'sggCd': '91290', 'umdCd': '10600',
                'umdNm': '갈현동', 'jibun': '810', 'landCd': '1', 'bonbun': '0810', 'bubun': '0000',
                'roadNmSggCd': '91290', 'roadNm': '갈현로', 'roadNmBonbun': '00010', 'roadNmBubun': '00000',
                'excluUseAr': '84.7450', 'dealAmount': '128,000', 'dealYear': '2026', 'dealMonth': '10',
                'dealDay': '15', 'floor': '5', 'buildYear': '2026', 'cdealType': '', 'cdealDay': '',
            })
            return trades

        cap_t, api_t, kakao_t, _, _ = self._capture(
            applyhome_override=target_with_earlier_mismatch, trade_override=add_target_self,
        )
        built_t = build_comparison_evidence(cap_t, region_catalog=self.catalog, api_fetch=api_t,
                                            kakao_fetch=kakao_t, model_no='01', now=fixed_now)
        target_meta = next(c for c in built_t['metadata']['complexes'] if c['isTarget'])
        self.assertEqual((target_meta['status'], target_meta['reasonCode']),
                         ('held', 'supply_area_mismatch_across_notices'))

        # 3) 우선 지역이 범위 밖 거래뿐이어도 월 배치가 하나라도 누락되면 확대 지역 조회로 넘어가지 않는다(A-06).
        def priority_outside_only(trades):
            return {
                '202609': [{
                    'aptSeq': '91290-101', 'aptNm': '합성과천 벨라르테', 'sggCd': '91290', 'umdCd': '10600',
                    'umdNm': '갈현동', 'jibun': '827', 'landCd': '1', 'bonbun': '0827', 'bubun': '0000',
                    'roadNmSggCd': '91290', 'roadNm': '갈현로', 'roadNmBonbun': '00015', 'roadNmBubun': '00000',
                    'excluUseAr': '59.9100', 'dealAmount': '98,000', 'dealYear': '2026', 'dealMonth': '9',
                    'dealDay': '12', 'floor': '6', 'buildYear': '2023', 'cdealType': '', 'cdealDay': '',
                }],
                '202610': [{
                    'aptSeq': '91290-901', 'aptNm': '합성별양단지', 'sggCd': '91290', 'umdCd': '10200',
                    'umdNm': '별양동', 'jibun': '50', 'landCd': '1', 'bonbun': '0050', 'bubun': '0000',
                    'roadNmSggCd': '91290', 'roadNm': '별양로', 'roadNmBonbun': '00050', 'roadNmBubun': '00000',
                    'excluUseAr': '84.7450', 'dealAmount': '142,000', 'dealYear': '2026', 'dealMonth': '10',
                    'dealDay': '08', 'floor': '11', 'buildYear': '2021', 'cdealType': '', 'cdealDay': '',
                }],
            }

        cap_m, api_m, _, _, _ = self._capture(trade_override=priority_outside_only)
        # 2026-10 apt_rights 배치를 고의로 제거해 불완전 수집본을 만든다.
        cap_m['tradeBatches'] = [
            b for b in cap_m['tradeBatches']
            if not (b['record']['source'] == 'apt_rights' and b['record']['month'] == '2026-10')
        ]
        built_m = build_comparison_evidence(cap_m, region_catalog=self.catalog, api_fetch=api_m,
                                            model_no='01', now=fixed_now)
        self.assertEqual(built_m['metadata']['scopeChecked'], 'priority')


class AutoEvidenceWorkerAndCliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(SYNTHETIC_FIXTURE.read_text(encoding='utf-8'))
        cls.catalog = LegalRegionCatalog.from_mois_tsv_text(cls.fixture['regionTsv'])

    def _run_worker_flow(self, kind: str):
        api_fetch, kakao_fetch, _, _, kakao_calls = make_synthetic_harness(self.fixture)
        req = self.fixture['request']
        target = req['target']
        run_id = str(uuid4())
        snap_id = str(uuid4())
        upload_id = str(uuid4())
        base_run_id = str(uuid4())
        if kind == 'notice':
            selection = dict(target, kind='notice', noticeSource=req['noticeSource'], modelNo='01')
        else:
            selection = dict(target, kind='upload_supplement', baseRunId=base_run_id, uploadId=upload_id,
                             noticeSource=req['noticeSource'], modelNo='01')
        job = {'runId': run_id, 'generation': 1, 'leaseToken': str(uuid4()), 'input': selection}
        work = {
            'conditions': {
                'ingestion_target': dict(target, noticeSource=req['noticeSource']),
                'comparison': {'modelNo': '01', 'room': '101동 101호'},
            },
            'evidence': None, 'ingestion': None, 'selectionBindingIssue': None, 'useSyntheticFixture': False,
            'noticeCapture': {'asOf': req['asOf'], 'requestRegionCodes': ['91290'], 'allowOfficialPdf': kind == 'notice'},
        }
        if kind == 'upload_supplement':
            work['upload'] = {'uploadId': upload_id, 'objectPath': f'{uuid4()}/{uuid4()}/{upload_id}.pdf'}
            work['officialIndex'] = [{
                'id': f'applyhome:{target["houseManageNo"]}:{target["noticeNo"]}:21:1',
                **target,
                'sha256': hashlib.sha256(PDF).hexdigest(),
                'role': 'notice',
                'source': 'official',
                'originCheck': 'confirmed',
            }]

        events = []
        stored = {}

        def rpc(name, params, **kwargs):
            events.append((name, params))
            if name == 'claim_analysis_run':
                return job
            if name in ('read_comparison_work', 'read_upload_supplement_work'):
                return work
            if name == 'renew_analysis_run':
                return {'runId': run_id, 'status': 'running', 'attempt': 1}
            if name == 'lookup_official_notice_document_index':
                return []
            if name == 'read_auto_evidence_permissions':
                return {'applyhomeApt': True, 'applyhomeRemainder': True, 'moisRegions': True,
                        'kakaoRuntime': True, 'kakaoStorage': False}
            if name == 'read_auto_evidence_cache':
                return {'region': None, 'applyhome': {}, 'kakao': {}}
            if name == 'upsert_auto_evidence_cache':
                stored['cache'] = params
                return {'regionStored': params['p_region'] is not None, 'entriesStored': len(params['p_entries'])}
            if name == 'finish_notice_with_evidence':
                stored['finish'] = params
                return {'status': 'finished', 'runId': run_id, 'snapshotId': snap_id}
            self.fail(f'예상하지 않은 RPC: {name}')

        client = Mock(spec=WorkerRpc)
        client.post.side_effect = rpc
        detail_url = (
            f'https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do'
            f'?houseManageNo={target["houseManageNo"]}&pblancNo={target["noticeNo"]}'
        )
        att_url = (
            f'https://static.applyhome.co.kr/ai/aia/getAtchmnfl.do'
            f'?houseManageNo={target["houseManageNo"]}&pblancNo={target["noticeNo"]}&atchmnflSeqNo=21&atchmnflSn=1'
        )

        def pdf_fetch(url, *, max_bytes, timeout):
            if url == detail_url:
                return html_ok(page([(att_url, '모집공고문 보기')],
                                    numbers=(target['houseManageNo'],), date=target['edition']))
            self.assertEqual(url, att_url)
            return pdf_ok()

        spec = self.fixture['pdfReviewEvidence']

        def inspect_pdf(content, *, target, catalog, document):
            return {
                'status': 'confirmed', 'issues': [],
                'evidence': [
                    {'document': document, 'modelNo': spec['modelNo'], 'houseType': spec['houseType'],
                     'item': 'supply_area', 'basis': 'supply', 'unit': 'm2', 'm2': spec['supplyAreaM2'],
                     'check': 'confirmed', 'page': 4},
                    {'document': document, 'modelNo': spec['modelNo'], 'houseType': spec['houseType'],
                     'room': spec['room'], 'item': 'sale_price', 'unit': 'won', 'won': spec['salePriceWon'],
                     'check': 'confirmed', 'page': 4},
                    {'document': document, 'modelNo': spec['modelNo'], 'houseType': spec['houseType'],
                     'room': spec['room'], 'item': 'required_options', 'unit': 'won', 'won': spec['requiredOptionsWon'],
                     'check': 'confirmed', 'page': 5},
                ],
                'paymentSchedules': [],
            }

        def read_upload(uid, path):
            return {'id': uid, 'content': PDF}

        # 대상 공고의 상세 주소를 테스트용 공식 첨부 페이지로 맞춘다.
        def api_with_detail(source, scope, page_no, page_size):
            env = api_fetch(source, scope, page_no, page_size)
            if source == req['noticeSource'] and env['body']['data']:
                for row in env['body']['data']:
                    if row.get('HOUSE_MANAGE_NO') == target['houseManageNo']:
                        row['PBLANC_URL'] = detail_url
            return env

        transports = NoticeTransports(
            api=api_with_detail, pdf=pdf_fetch, clock=lambda: 0.0, sleep=lambda s: None,
            inspect=inspect_pdf, limits={'requestIntervalSeconds': 0},
            upload=read_upload if kind == 'upload_supplement' else None,
            regions=lambda sgg: self.catalog, kakao=kakao_fetch,
        )
        outcome = run_once(client, notice=transports)
        return outcome, events, stored, snap_id, kakao_calls

    def test_worker_notice_upload_supplement_and_snapshot_recalculation_reuse(self):
        """공고 실행·업로드 보완 실행이 자동 근거를 원자 저장하고, 이후 스냅샷 재계산은 외부 조회 없이 저장 근거를 재사용한다."""
        for kind in ('notice', 'upload_supplement'):
            with self.subTest(kind=kind):
                outcome, events, stored, snap_id, _ = self._run_worker_flow(kind)
                self.assertEqual(outcome['status'], 'finished')
                self.assertIn('finish', stored)
                self.assertIn('cache', stored)
                fin = stored['finish']
                self.assertEqual(fin['p_comparison']['appliedScope'], 'priority')
                self.assertEqual(len(fin['p_comparison']['comparables']), 2)
                self.assertNotIn(KAKAO_SOURCE_ID, fin['p_evidence_sources'])
                self.assertGreater(fin['p_evidence_metadata']['calls']['applyhome'], 0)
                self.assertEqual(fin['p_evidence_metadata']['calls']['regions'], 1)
                self.assertTrue(all(e['cacheKind'] != 'kakao_road_coordinate' for e in stored['cache']['p_entries']))

                # 같은 수집본의 기간 변경 재계산(kind='snapshot')은 외부 전송 없이 저장된 p_evidence를 그대로 재사용한다.
                recalc_run_id = str(uuid4())
                recalc_job = {'runId': recalc_run_id, 'generation': 1, 'leaseToken': str(uuid4()),
                              'input': {'kind': 'snapshot', 'snapshotId': snap_id}}
                recalc_work = {
                    'conditions': {'comparison': {'modelNo': '01', 'room': '101동 101호'}},
                    'ingestion': fin['p_result'],
                    'evidence': fin['p_evidence'],
                    'useSyntheticFixture': False,
                    'selectionBindingIssue': None,
                    'comparisonPeriod': {'start': '2026-10-01', 'end': '2026-10-20'},
                }
                recalc_stored = {}

                def recalc_rpc(name, params, **kwargs):
                    if name == 'claim_analysis_run':
                        return recalc_job
                    if name == 'read_comparison_work':
                        return recalc_work
                    if name == 'renew_analysis_run':
                        return {'runId': recalc_run_id, 'status': 'running', 'attempt': 1}
                    if name == 'finish_analysis_comparison':
                        recalc_stored['comparison'] = params['p_comparison']
                        return {'status': 'finished', 'runId': recalc_run_id, 'snapshotId': snap_id}
                    self.fail(f'재계산에서 예상하지 않은 RPC: {name}')

                recalc_client = Mock(spec=WorkerRpc)
                recalc_client.post.side_effect = recalc_rpc
                # notice=None(외부 전송 없음!)으로 실행해도 저장 근거로 10월 거래만 정확히 재계산한다.
                recalc_out = run_once(recalc_client, notice=None)
                self.assertEqual(recalc_out['status'], 'finished')
                recalc_comp = recalc_stored['comparison']
                self.assertEqual(recalc_comp['appliedScope'], 'priority')
                by_id = {c['complexId']: c for c in recalc_comp['comparables']}
                self.assertEqual(by_id['aptseq:91290-101']['tradeStats']['sale']['count'], 1)
                self.assertEqual(by_id['aptseq:91290-101']['tradeStats']['sale']['medianWon'], '1380000000')
                self.assertEqual(by_id['aptseq:91290-102']['tradeStats']['sale']['count'], 1)
                self.assertEqual(by_id['aptseq:91290-102']['tradeStats']['sale']['medianWon'], '1310000000')

    def test_manage_notice_services_optional_kakao_key(self):
        """작업자 카카오 키는 선택 항목이며, 있으면 환경에 전달하고 없어도 실패하지 않는다."""
        with tempfile.TemporaryDirectory() as tmp:
            secrets = Path(tmp)
            ops.write_private(secrets / 'worker.env', f'{ops.WORKER_KEY}=synthetic-worker\n'.encode())
            ops.write_private(secrets / f'{ops.PROVIDER_KEY}.env', f'{ops.PROVIDER_KEY}=synthetic-provider\n'.encode())
            env_without = ops.worker_env(secrets)
            self.assertNotIn(ops.KAKAO_KEY, env_without)

            ops.write_private(secrets / f'{ops.KAKAO_KEY}.env', f'{ops.KAKAO_KEY}=synthetic-kakao\n'.encode())
            ops.write_private(secrets / f'{ops.LLM_KEY}.env', f'{ops.LLM_KEY}=sk-synthetic\n'.encode())
            env_with = ops.worker_env(secrets)
            self.assertEqual(env_with[ops.KAKAO_KEY], 'synthetic-kakao')
            # deletion·agent 역할에는 카카오 키가 주입되지 않는다.
            self.assertNotIn(ops.KAKAO_KEY, ops.worker_env(secrets, require_provider=False))
            self.assertNotIn(ops.KAKAO_KEY, ops.worker_env(secrets, require_provider=False, require_llm=True))

            # serve()가 카카오 키를 환경에 반영했다가 키 파일 제거 시 환경에서 정리하는지 확인
            seen_kakao = []

            def fake_run_once(client, *, notice=None):
                seen_kakao.append(os.environ.get(ops.KAKAO_KEY))
                return {'status': 'idle'}

            with patch.object(ops, 'WorkerRpc'), patch.object(ops, 'run_once', side_effect=fake_run_once), \
                    patch.object(ops.time, 'sleep', side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    ops.serve(secrets, 'worker')
            self.assertEqual(seen_kakao, ['synthetic-kakao'])

    def test_verify_auto_evidence_cli_guards_and_sanitized_summary(self):
        """수동 실검수 CLI는 --live 필수, 호출 상한 검사, 원문·원좌표 미노출을 지킨다."""
        parser = verify_auto_evidence.build_parser()
        with self.assertRaises(ValueError):
            verify_auto_evidence.validate_args(parser.parse_args([]))
        with self.assertRaises(ValueError):
            verify_auto_evidence.validate_args(parser.parse_args(['--live', '--max-applyhome-calls', '999']))
        with self.assertRaises(ValueError):
            verify_auto_evidence.validate_args(parser.parse_args(['--live', '--max-kakao-calls', '99']))
        verify_auto_evidence.validate_args(parser.parse_args(['--live', '--max-applyhome-calls', '20', '--max-kakao-calls', '5']))
        self.assertEqual(verify_auto_evidence.DEFAULT_TARGET['edition'], '2024-04-18')

        api_fetch, kakao_fetch, review_documents, _, _ = make_synthetic_harness(self.fixture)
        cap = ingest(self.fixture['request'], api_fetch, data_origin='collected', review_documents=review_documents)
        built = build_comparison_evidence(
            cap, region_catalog=self.catalog, api_fetch=api_fetch, kakao_fetch=kakao_fetch,
            model_no='01', now=fixed_now,
        )
        comp = compare_snapshot(cap, {'modelNo': '01', 'room': '101동 101호'}, built['runtimeEvidence'])
        summary = verify_auto_evidence.summarize_verification(cap, built, comp, kakao_key_present=True)
        dumped = json.dumps(summary, ensure_ascii=False)
        self.assertEqual(summary['contractVersion'], 'auto-evidence-verification/v1')
        self.assertNotIn('37.410000', dumped)
        self.assertNotIn('126.980000', dumped)
        self.assertNotIn('latitude', dumped)
        self.assertNotIn('longitude', dumped)


if __name__ == '__main__':
    unittest.main()
