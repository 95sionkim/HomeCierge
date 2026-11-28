#!/usr/bin/env python3
"""BE-05 비교 판정의 오프라인 검사. 공고·단지·거래·근거는 모두 합성 자료다."""

import copy
import json
import unittest
from decimal import Context, Decimal, localcontext
from pathlib import Path

from compare_trades import compare_snapshot
from ingestion_trades import trade_period
from replay_ingestion import replay


FIXTURES = Path(__file__).resolve().parents[1] / 'tests' / 'fixtures'
SALE = 'apt_trade'
RIGHTS = 'apt_rights'
DISTRICT = '99999'
PRIORITY = '9999900100'
OTHER_DONG = '9999900200'


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding='utf-8'))


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.bundle = fixture('ingestion-v0.json')
        self.evidence = fixture('comparison-evidence-v1.json')
        page = next(page for page in self.bundle['pages'] if page['source'] == SALE)
        self.sale = page['body']['response']['body']['items']['item'][0]
        self.templates = {page['source']: copy.deepcopy(page) for page in self.bundle['pages']}

    def compare(self, selection=None, ingestion=None):
        return compare_snapshot(replay(self.bundle) if ingestion is None else ingestion,
                                {} if selection is None else selection, self.evidence)

    def rows(self, source, rows, code=DISTRICT, month='202610'):
        scope = {'LAWD_CD': code, 'DEAL_YMD': month}
        self.bundle['pages'] = [
            page for page in self.bundle['pages'] if (page['source'], page['scope']) != (source, scope)
        ]
        size = self.bundle['request']['pageSize']
        for offset in range(0, max(1, len(rows)), size):
            page = copy.deepcopy(self.templates[source])
            number = offset // size + 1
            page.update(scope=scope, page=number, pageSize=size)
            page['body']['response']['body'] = {'pageNo': number, 'numOfRows': size, 'totalCount': len(rows),
                                               'items': {'item': rows[offset:offset + size]}}
            self.bundle['pages'].append(page)

    def sales_only(self):
        self.bundle['request']['tradeKinds'] = ['sale']
        self.evidence['tradeLinks'] = []

    def area(self, value):
        model_page = self.templates['applyhome_apt_model']
        model_page['body']['data'][0]['SUPLY_AR'] = value
        page_index = next(i for i, page in enumerate(self.bundle['pages']) if page['source'] == 'applyhome_apt_model')
        self.bundle['pages'][page_index] = model_page
        area_evidence = next(part for part in self.bundle['evidence'] if part['item'] == 'supply_area')
        area_evidence['m2'] = value

    def region(self, code=OTHER_DONG, name='별빛동', umd='00200', region=DISTRICT, district=DISTRICT):
        self.evidence['regions'].append({
            'localityCode': code, 'localityType': 'dong', 'localityName': name, 'umdCd': umd,
            'requestRegionCode': region, 'districtCode': district, 'municipalityCode': '99990',
            'evidence': {'source': 'synthetic-region-register', 'reference': code},
        })

    def complex(self, identifier, locality=PRIORITY, latitude='37.501'):
        value = {'complexId': identifier, 'name': f'합성 {identifier}', 'localityCode': locality,
                 'evidence': {'source': 'synthetic-complex-register', 'reference': identifier}}
        if latitude is not None:
            value['coordinates'] = {'latitude': latitude, 'longitude': '127.000',
                                    'evidence': {'source': 'synthetic-coordinate-register', 'reference': identifier}}
        self.evidence['complexes'].append(value)

    def sale_row(self, identifier, **fields):
        return dict(self.sale, aptNm=f'합성 {identifier}', aptSeq=f'99999-{identifier}',
                    jibun=f'J-{identifier}') | fields

    def link_sales(self, ingestion, mapping):
        for batch in ingestion['tradeBatches']:
            if batch['record']['source'] != SALE:
                continue
            for row in batch['trades']:
                match = mapping.get((row['identifiers'].get('aptNm'), row['exclusiveArea']['m2']))
                if match:
                    identifier, area = match
                    source = row['provenance']
                    self.evidence['tradeLinks'].append({
                        'recordId': batch['record']['recordId'], 'source': source['source'],
                        'page': source['page'], 'position': source['position'],
                        'identifiers': copy.deepcopy(row['identifiers']), 'exclusiveAreaM2': row['exclusiveArea']['m2'],
                        'complexId': identifier, 'supplyAreaM2': area,
                        'evidence': {'source': 'synthetic-area-register', 'reference': identifier},
                    })

    def test_demo_combines_kinds_without_merging_prices_and_keeps_raw_private(self):
        ingestion = replay(self.bundle)
        ingestion['tradeBatches'][0]['trades'][0]['raw'] = {'body': 'fixture-private-value'}
        result = self.compare(ingestion=ingestion)
        self.assertEqual((result['contractVersion'], result['dataOrigin'], result['completeness'], result['appliedScope']),
                         ('comparison/v1', 'synthetic', 'complete', 'priority'))
        self.assertEqual(result['target']['modelNo'], '01')
        self.assertEqual(result['target']['supplyArea']['m2'], '112.400')
        self.assertEqual([row['complexId'] for row in result['comparables']], ['comparison-a', 'comparison-b'])
        sale = result['comparables'][0]['tradeStats']['sale']
        self.assertEqual((sale['count'], sale['minWon'], sale['maxWon'], sale['medianWon'], sale['smallSample']),
                         (1, '515000000', '515000000', '515000000', True))
        self.assertEqual(sale['observations'][0]['collectedAt'], ingestion['tradeBatches'][0]['record']['collectedAt'])
        rights = result['comparables'][1]['tradeStats']
        self.assertEqual({kind: stats['medianWon'] for kind, stats in rights.items()},
                         {'presale_right': '405000000', 'occupancy_right': '486000000'})
        self.assertEqual(rights['occupancy_right']['priceMeaning'], 'reported_rights_transaction_amount')
        self.assertEqual({item['reasonCode'] for item in result['exclusions']},
                         {'cancelled_trade', 'outside_contract_period'})
        serialized = json.dumps(result, allow_nan=False)
        for private in ('fixture-private-value', 'sourceRaw', '"body"', '"raw"'):
            self.assertNotIn(private, serialized)

    def test_collected_origin_requires_matching_trusted_evidence(self):
        ingestion = replay(self.bundle)
        ingestion['dataOrigin'] = 'collected'
        result = self.compare(ingestion=ingestion)
        self.assertEqual((result['dataOrigin'], result['completeness']), ('collected', 'unavailable'))
        self.evidence['dataOrigin'] = 'collected'
        self.assertEqual(self.compare(ingestion=ingestion)['dataOrigin'], 'collected')

    def test_housing_choice_and_price_hold_are_local(self):
        baseline = self.compare()
        price = baseline['noticePrice']
        self.assertEqual((price['scope'], price['minWon'], price['maxWon']),
                         ('confirmed_rooms', '710000000', '710000000'))
        self.assertEqual(len(price['heldRooms']), 1)
        self.assertEqual(baseline['completeness'], 'complete')
        room = self.compare({'room': '101동 101호'})['noticePrice']
        self.assertEqual((room['scope'], room['won']), ('selected_room', '710000000'))
        rejected = self.compare({'room': '101동 102호'})
        self.assertEqual((rejected['noticePrice']['status'], rejected['noticePrice']['won']), ('held', None))
        self.assertEqual(rejected['completeness'], 'partial')
        self.assertEqual(rejected['comparables'], baseline['comparables'])
        self.assertEqual(rejected['rankingComplete'], baseline['rankingComplete'])
        hold = next(hold for hold in rejected['holds'] if hold['subject'] == 'notice_price')
        self.assertIn('required_options_unverified', hold['reasons'])
        ingestion = replay(self.bundle)
        housing = copy.deepcopy(ingestion['catalog']['housingTypes'][0])
        ingestion['catalog']['housingTypes'].append(dict(housing, modelNo='02'))
        self.assertEqual(self.compare(ingestion=ingestion)['completeness'], 'unavailable')
        self.assertEqual(self.compare({'modelNo': '01'}, ingestion)['target']['modelNo'], '01')
        self.assertEqual(self.compare({'modelNo': '99'}, ingestion)['comparables'], [])

    def test_house_type_with_outer_whitespace_from_api_stays_linked(self):
        # 합성: 청약홈 API는 접미 문자가 없는 주택형을 '102.7700 '처럼 바깥 공백과 함께 준다(2026-11-28 천안 공고).
        # 수집본은 원문을 보존하므로 비교도 같은 원문으로 주택형과 호실 가격을 연결해야 한다.
        baseline = self.compare({'modelNo': '01'})
        ingestion = replay(self.bundle)
        catalog = ingestion['catalog']
        raw = catalog['housingTypes'][0]['houseType']['value'] + ' '
        catalog['housingTypes'][0]['houseType']['value'] = raw
        for room in catalog['rooms']:
            if room['modelNo'] == '01':
                room['houseType'] = raw
        result = self.compare({'modelNo': '01'}, ingestion)
        self.assertEqual((result['target']['modelNo'], result['target']['houseType']), ('01', raw))
        self.assertNotIn('housing_type_unverified', result['noticePrice']['reasons'])
        self.assertEqual((result['noticePrice']['minWon'], result['noticePrice']['maxWon']),
                         (baseline['noticePrice']['minWon'], baseline['noticePrice']['maxWon']))
        self.assertEqual(result['completeness'], baseline['completeness'])
        catalog['housingTypes'][0]['houseType']['value'] = '   '
        self.assertEqual(self.compare({'modelNo': '01'}, ingestion)['noticePrice']['reasons'], ['housing_type_unverified'])

    def test_supply_area_must_be_checked_and_bound_to_same_edition(self):
        # Q-52: PDF 회차 불일치로 target.supplyArea·분양가는 보류되어도 HOUSE_TY 평형이 확인되면 비교는 계속 진행된다.
        ingestion = replay(self.bundle)
        ingestion['catalog']['documents'][0]['edition'] = 'other-edition'
        result = self.compare({'supplyAreaM2': '112.4', 'regionCode': PRIORITY}, ingestion)
        self.assertEqual(result['target']['supplyArea']['status'], 'held')
        self.assertIsNone(result['noticePrice']['minWon'])
        self.assertEqual(result['appliedScope'], 'priority')
        self.assertEqual([row['complexId'] for row in result['comparables']], ['comparison-a', 'comparison-b'])
        self.assertEqual(result['conditions']['area'], {'basis': 'exclusive_area_class', 'class': 84})
        self.assertEqual(result['completeness'], 'complete')
        room_res = self.compare({'room': '101동 101호'}, ingestion)
        self.assertEqual((room_res['completeness'], room_res['noticePrice']['status']), ('partial', 'held'))

        # 대상 주택형의 전용면적 정수부(평형)를 읽을 수 없으면 비교를 보류한다.
        for bad_type in ('특별형', '0.50A', 'ABC'):
            with self.subTest(bad_type=bad_type):
                bad_ing = replay(self.bundle)
                bad_ing['catalog']['housingTypes'][0]['houseType']['value'] = bad_type
                held = self.compare({}, bad_ing)
                self.assertEqual((held['comparables'], held['appliedScope'], held['completeness']), ([], None, 'unavailable'))
                self.assertIn('target_area_class_unverified', {item['reasonCode'] for item in held['holds']})

    def test_missing_partial_and_failed_rights_cannot_trigger_expansion(self):
        self.rows(SALE, [])
        self.evidence['tradeLinks'] = []
        ingestion = replay(self.bundle)
        ingestion['tradeBatches'] = [ingestion['tradeBatches'][0]]
        result = self.compare(ingestion=ingestion)
        self.assertEqual(result['regionDecision']['priority']['conclusion'], 'held')
        self.assertIsNone(result['regionDecision']['expansion'])
        self.assertEqual(result['tradeKinds']['sale']['conclusion'], 'normal_zero')
        self.assertEqual(result['tradeKinds']['presale_right']['conclusion'], 'held')
        rights_page = next(page for page in self.bundle['pages'] if page['source'] == RIGHTS)
        rights_page['body']['response']['header']['resultCode'] = '04'
        result = self.compare()
        self.assertEqual(result['completeness'], 'partial')
        self.assertEqual(result['tradeKinds']['occupancy_right']['conclusion'], 'lookup_failed')
        self.assertIsNone(result['regionDecision']['expansion'])

    def test_priority_holds_known_results_and_reports_empty_kinds(self):
        self.evidence['tradeLinks'] = self.evidence['tradeLinks'][:1]
        self.rows(RIGHTS, [])
        result = self.compare()
        self.assertEqual((result['appliedScope'], len(result['comparables'])), ('priority', 1))
        self.assertEqual(result['tradeKinds']['presale_right']['conclusion'], 'normal_zero')
        ingestion = replay(self.bundle)
        sale = ingestion['tradeBatches'][0]
        sale['trades'].pop()
        self.assertEqual(sale['record']['status'], 'complete')
        result = self.compare(ingestion=ingestion)
        self.assertEqual((result['completeness'], result['appliedScope']), ('partial', 'priority'))
        self.assertEqual(result['comparables'][0]['tradeStats']['sale']['status'], 'provisional')
        self.assertIsNone(result['comparables'][0]['rank'])

    def test_confirmed_zero_expands_only_to_verified_same_district(self):
        self.sales_only()
        self.region()
        self.region('8888800100', '별빛동', '00100', '88888', '88888')
        self.complex('inside', OTHER_DONG)
        self.complex('outside', '8888800100')
        self.bundle['request']['requestRegionCodes'].append('88888')
        self.rows(SALE, [self.sale_row('inside', umdCd='00200', umdNm='별빛동')])
        self.rows(SALE, [self.sale_row('outside', sggCd='88888', umdNm='별빛동')], '88888')
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {('합성 inside', '84.00'): ('inside', '112.4'),
                                   ('합성 outside', '84.00'): ('outside', '112.4')})
        result = self.compare(ingestion=ingestion)
        self.assertEqual(result['regionDecision']['priority']['conclusion'], 'normal_zero')
        self.assertEqual((result['appliedScope'], result['regionDecision']['expansion']['kind']), ('expansion', 'district'))
        self.assertEqual([row['complexId'] for row in result['comparables']], ['inside'])
        self.rows(SALE, [])
        self.evidence['tradeLinks'].pop(0)
        result = self.compare()
        self.assertEqual(result['regionDecision']['expansion']['conclusion'], 'normal_zero')
        self.assertEqual((result['completeness'], result['comparables']), ('complete', []))

    def test_eup_and_municipality_require_all_verified_lawd_coverage(self):
        self.sales_only()
        self.evidence['regions'][0].update(localityType='eup', districtCode=None,
                                          subLocalities=[{'name': '합성리', 'umdCd': '00101'}])
        self.region('9999800200', '솔빛면', '00200', '99998', None)
        self.evidence['regions'][1]['localityType'] = 'myeon'
        self.evidence['scopes']['expansion'].update(kind='municipality', code='99990',
                                                   requestRegionCodes=['99999', '99998'])
        self.complex('inside-ri')
        self.rows(SALE, [self.sale_row('inside-ri', umdNm='합성리', umdCd='00101')])
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {('합성 inside-ri', '84.00'): ('inside-ri', '112.4')})
        self.assertEqual(self.compare(ingestion=ingestion)['regionDecision']['priority']['kind'], 'eup')
        self.rows(SALE, [])
        self.evidence['tradeLinks'] = []
        result = self.compare()
        self.assertEqual(result['regionDecision']['priority']['conclusion'], 'normal_zero')
        self.assertEqual((result['appliedScope'], result['regionDecision']['expansion']['conclusion']), ('expansion', 'held'))
        self.bundle['request']['requestRegionCodes'].append('99998')
        self.rows(SALE, [], '99998')
        result = self.compare()
        self.assertEqual((result['completeness'], result['regionDecision']['expansion']['conclusion']), ('complete', 'normal_zero'))

    def test_region_identifiers_use_exact_strings_separate_from_lawd(self):
        self.sales_only()
        locality, district, municipality, observed_code = 'LOCAL:0001', 'DISTRICT:002', 'MUNI:0003', '0000742'
        self.evidence['regions'][0].update(localityCode=locality, districtCode=district,
                                          municipalityCode=municipality, umdCd=observed_code)
        self.evidence['scopes']['priority']['code'] = locality
        self.evidence['scopes']['expansion']['code'] = district
        self.evidence['complexes'][0]['localityCode'] = locality
        self.complex('match', locality=locality)
        self.rows(SALE, [self.sale_row('match', umdCd=observed_code)])
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {('합성 match', '84.00'): ('match', '112.4')})
        result = self.compare(ingestion=ingestion)
        self.assertEqual(result['appliedScope'], 'priority')
        self.assertEqual([row['localityCode'] for row in result['comparables']], [locality])
        self.assertEqual(result['regionDecision']['priority']['requestRegionCodes'], [DISTRICT])
        self.evidence['regions'][0]['umdCd'] = '742'
        result = self.compare(ingestion=ingestion)
        self.assertEqual(result['regionDecision']['priority']['conclusion'], 'held')
        self.assertFalse(result['comparables'])
        self.evidence['regions'][0]['umdCd'] = observed_code
        self.rows(SALE, [])
        self.evidence['tradeLinks'] = []
        self.assertEqual(self.compare()['regionDecision']['expansion']['code'], district)
        self.evidence['regions'][0]['requestRegionCode'] = observed_code
        self.assertIsNone(self.compare()['appliedScope'])

    def test_incomplete_region_evidence_cannot_shrink_expansion_to_an_empty_request(self):
        self.sales_only()
        self.rows(SALE, [])
        self.region('9999800200', '솔빛리', '00200', '99998', DISTRICT)
        self.evidence['regions'][-1]['localityType'] = 'ri'
        self.bundle['request']['requestRegionCodes'].append('99998')
        self.rows(SALE, [], '99998')
        # 유효한 첫 지역만 고르면 확대 범위가 검증된 것처럼 보인다. 둘째 지역의 소속은 보류 상태다.
        result = self.compare()
        self.assertEqual(result['regionDecision']['priority']['conclusion'], 'normal_zero')
        self.assertEqual(result['regionDecision']['expansion']['conclusion'], 'held')
        self.assertIn('expansion_region_unverified', {hold['reasonCode'] for hold in result['holds']})
        self.evidence['regions'][-1]['localityType'] = 'dong'
        self.evidence['scopes']['expansion']['requestRegionCodes'].append('99998')
        self.assertEqual(self.compare()['regionDecision']['expansion']['conclusion'], 'normal_zero')

    def test_target_transactions_do_not_count_as_neighbors(self):
        self.sales_only()
        self.rows(SALE, [self.sale_row('own')])
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {('합성 own', '84.00'): ('target', '112.4')})
        result = self.compare({'targetComplexId': 'comparison-a', 'isTarget': False}, ingestion)
        self.assertEqual(result['regionDecision']['priority']['conclusion'], 'normal_zero')
        self.assertEqual((result['appliedScope'], result['comparables']), ('expansion', []))
        self.assertEqual([row['complexId'] for row in result['targetReferences']], ['target'])
        # Q-52: 공급면적이 미확인이어도 같은 평형 대상 자체 거래는 targetReferences에 유지하고 참고 공급면적 없음으로 둔다.
        self.evidence['tradeLinks'][0]['supplyAreaM2'] = None
        result = self.compare(ingestion=ingestion)
        self.assertEqual(result['appliedScope'], 'expansion')
        self.assertEqual([row['complexId'] for row in result['targetReferences']], ['target'])
        self.assertEqual(result['targetReferences'][0]['supplyAreaReference']['status'], 'unavailable')

    def test_verified_target_identity_excludes_its_trade_even_when_area_binding_is_missing(self):
        self.sales_only()
        name = self.evidence['complexes'][0]['name']
        self.rows(SALE, [self.sale_row('own', aptNm=name)])
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {(name, '84.00'): ('target', '112.4')})
        self.evidence['tradeLinks'][0]['exclusiveAreaM2'] = None
        result = self.compare(ingestion=ingestion)
        self.assertEqual(result['regionDecision']['priority']['conclusion'], 'normal_zero')
        self.assertEqual(result['appliedScope'], 'expansion')
        self.assertEqual(result['targetReferences'], [])
        self.assertIn('target_complex_trade', {row['reasonCode'] for row in result['exclusions']})
        hold = next(hold for hold in result['holds'] if hold.get('targetReference'))
        self.assertEqual((hold['complexId'], hold['reasonCode']), ('target', 'trade_exclusive_area_binding_unverified'))

        self.complex('conflicting')
        self.rows(SALE, [self.sale_row('own', aptNm=name), self.sale_row('own', aptNm=name, dealDay='21')])
        conflicting_ingestion = replay(self.bundle)
        self.evidence['tradeLinks'] = []
        self.link_sales(conflicting_ingestion, {(name, '84.00'): ('target', '112.4')})
        self.evidence['tradeLinks'][0]['exclusiveAreaM2'] = None
        self.evidence['tradeLinks'][1]['complexId'] = 'conflicting'
        conflict = self.compare(ingestion=conflicting_ingestion)
        self.assertEqual(conflict['regionDecision']['priority']['conclusion'], 'held')
        self.assertNotIn('target_complex_trade', {row['reasonCode'] for row in conflict['exclusions']})
        self.assertEqual(sum(row['reasonCode'] == 'trade_complex_identity_conflict' for row in conflict['holds']), 2)

    def test_trade_evidence_is_bound_to_replayed_identity_area_and_row_position(self):
        baseline = copy.deepcopy(self.evidence)
        for field, new_value in [('identifiers', {'aptNm': '합성 비교 A'}), ('exclusiveAreaM2', '85'),
                                 ('page', 3), ('source', RIGHTS), ('recordId', 'unreplayed')]:
            with self.subTest(field=field):
                self.evidence = copy.deepcopy(baseline)
                self.evidence['tradeLinks'][0][field] = new_value
                result = self.compare({'localityCode': PRIORITY, 'isTarget': False, 'supplyAreaM2': '112.40'})
                self.assertEqual([row['complexId'] for row in result['comparables']], ['comparison-b'])
                self.assertEqual(result['completeness'], 'partial')
                self.assertTrue(result['holds'])
        self.evidence = baseline
        self.evidence['tradeLinks'].append(copy.deepcopy(self.evidence['tradeLinks'][0]))
        self.assertNotIn('comparison-a', {row['complexId'] for row in self.compare()['comparables']})

    def test_a_marked_evidence_conflict_does_not_certify_a_candidate(self):
        self.evidence['tradeLinks'][0]['status'] = 'conflict'
        result = self.compare()
        self.assertEqual([row['complexId'] for row in result['comparables']], ['comparison-b'])
        self.assertEqual(result['completeness'], 'partial')
        self.evidence['scopes']['priority']['status'] = 'unverified'
        self.assertIsNone(self.compare()['appliedScope'])

    def test_duplicate_collection_and_duplicate_row_locations_are_held(self):
        ingestion = replay(self.bundle)
        ingestion['tradeBatches'].append(copy.deepcopy(ingestion['tradeBatches'][0]))
        result = self.compare(ingestion=ingestion)
        self.assertEqual([row['complexId'] for row in result['comparables']], ['comparison-b'])
        self.assertEqual(result['tradeKinds']['sale']['conclusion'], 'held')
        ingestion = replay(self.bundle)
        second = ingestion['tradeBatches'][0]['trades'][1]
        second['provenance']['position'] = 1
        result = self.compare(ingestion=ingestion)
        self.assertEqual([row['complexId'] for row in result['comparables']], ['comparison-b'])
        self.assertEqual(result['completeness'], 'partial')

    def test_independent_exclusions_allow_zero_but_an_unconfirmed_region_does_not(self):
        self.sales_only()
        unverified = self.sale_row('unverified', sggCd=99999, umdNm='', umdCd='')
        self.rows(SALE, [dict(unverified, dealDay='09'), dict(unverified, cdealType='O')])
        self.assertEqual(self.compare()['regionDecision']['expansion']['conclusion'], 'normal_zero')
        self.rows(SALE, [dict(unverified, umdNm='가람동', umdCd='00100')])
        self.complex('unverified')
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {('합성 unverified', '84.00'): ('unverified', '112.4')})
        result = self.compare(ingestion=ingestion)
        self.assertEqual(result['regionDecision']['priority']['conclusion'], 'held')
        self.assertIsNone(result['regionDecision']['expansion'])

    def test_conflicting_complex_ids_are_not_resolved_using_area_availability(self):
        self.sales_only()
        for name in ('first', 'second'):
            self.complex(name)
        self.rows(SALE, [self.sale_row('first', aptSeq='99999-shared'),
                         self.sale_row('second', aptSeq='99999-shared')])
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {('합성 first', '84.00'): ('first', '112.4'),
                                   ('합성 second', '84.00'): ('second', None)})
        self.evidence['tradeLinks'][1]['exclusiveAreaM2'] = '85'
        result = self.compare(ingestion=ingestion)
        self.assertEqual(result['comparables'], [])
        self.assertEqual(sum(item['reasonCode'] == 'trade_complex_identity_conflict' for item in result['holds']), 2)

    def test_db_binding_issue_is_independent_of_client_flags(self):
        ingestion = replay(self.bundle)
        selected = {'binding_issue': 'target_identity_unverified', 'isTarget': True}
        self.assertTrue(self.compare(selected, ingestion)['comparables'])
        for reason in ('target_identity_unverified', 'housing_type_identity_unverified'):
            with self.subTest(reason=reason):
                held = compare_snapshot(ingestion, selected, self.evidence, binding_issue=reason)
                self.assertEqual((held['completeness'], held['comparables'], held['appliedScope']), ('unavailable', [], None))
                self.assertIsNone(held['noticePrice'])
                self.assertIsNone(held['regionDecision']['priority'])
                self.assertIsNone(held['regionDecision']['expansion'])
                self.assertIn(reason, {item['reasonCode'] for item in held['holds']})

    def test_area_class_boundaries_floor_whitespace_and_supply_unverified_still_included(self):
        # Q-52: 평형은 전용면적의 정수부(소수점 버림)이며, 바깥 공백을 무시하고 공급면적 미확인만으로 보류하지 않는다.
        self.sales_only()
        cases = [
            ('below', '83.9999', '104.00', '37.501'),
            ('floor-low', '84.0000', '109.50', '37.502'),
            ('floor-high', '84.9999', None, '37.503'),
            ('above', '85.0000', '112.00', '37.504'),
            ('small', '59.9926', '80.10', '37.505'),
        ]
        self.rows(SALE, [self.sale_row(name, excluUseAr=exclu) for name, exclu, _, _ in cases])
        for name, _, _, lat in cases:
            self.complex(name, latitude=lat)
        ingestion = replay(self.bundle)
        # 바깥 공백이 있는 HOUSE_TY(' 084.9800 ')도 84㎡형으로 해석한다.
        ingestion['catalog']['housingTypes'][0]['houseType']['value'] = ' 084.9800 '
        for room in ingestion['catalog']['rooms']:
            room['houseType'] = ' 084.9800 '
        self.link_sales(ingestion, {(f'합성 {name}', exclu): (name, sup) for name, exclu, sup, _ in cases})
        result = self.compare({'areaTolerancePercent': '3'}, ingestion)
        self.assertEqual(result['conditions']['area'], {'basis': 'exclusive_area_class', 'class': 84})
        self.assertEqual(result['target']['areaClass'], 84)
        self.assertEqual(result['target']['exclusiveAreaM2'], '84.9800')
        self.assertEqual([row['complexId'] for row in result['comparables']], ['floor-low', 'floor-high'])
        self.assertEqual(result['completeness'], 'complete')
        self.assertEqual(result['holds'], [])
        # 공급면적이 None인 floor-high도 포함되고 참고 공급면적은 unavailable로 남는다.
        self.assertEqual(result['comparables'][0]['supplyAreaReference']['status'], 'single')
        self.assertEqual(result['comparables'][0]['supplyAreaReference']['m2'], '109.50')
        self.assertEqual(result['comparables'][1]['supplyAreaReference']['status'], 'unavailable')
        outside_ex = [item for item in result['exclusions'] if item['reasonCode'] == 'outside_area_class']
        self.assertEqual(len(outside_ex), 3)
        self.assertEqual({item['areaClass'] for item in outside_ex}, {59, 83, 85})

        # 102.7700 (바깥 공백 포함) -> 102㎡형, 59.9926A -> 59㎡형 확인
        for raw_ht, expected_cls in (('102.7700 ', 102), ('059.9926A', 59)):
            with self.subTest(raw_ht=raw_ht):
                ing2 = replay(self.bundle)
                ing2['catalog']['housingTypes'][0]['houseType']['value'] = raw_ht
                for room in ing2['catalog']['rooms']:
                    room['houseType'] = raw_ht
                res2 = self.compare({}, ing2)
                self.assertEqual(res2['conditions']['area'], {'basis': 'exclusive_area_class', 'class': expected_cls})
                if expected_cls == 59:
                    self.assertEqual([row['complexId'] for row in res2['comparables']], ['small'])

        # Q-52: 승인 조건에 areaTolerancePercent를 넣으면 거부한다.
        with self.assertRaises(ValueError):
            compare_snapshot(ingestion, {}, self.evidence, comparison_conditions={'areaTolerancePercent': '3'})

    def test_confirmed_out_of_range_area_excludes_an_unpriced_trade(self):
        self.sales_only()
        self.region()
        self.complex('unpriced')
        self.complex('same-district', OTHER_DONG)
        # 우선 지역에 다른 평형(59.90㎡) 미기재 금액 거래만 있으면 outside_area_class로 제외돼 정상 0개로 확대된다.
        unpriced_other_class = self.sale_row('unpriced', excluUseAr='59.90', dealAmount='')
        other_dong = self.sale_row('same-district', umdNm='별빛동', umdCd='00200', excluUseAr='84.50')
        self.rows(SALE, [unpriced_other_class, other_dong])
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {('합성 same-district', '84.50'): ('same-district', '110.0')})
        result = self.compare(ingestion=ingestion)
        self.assertEqual(result['regionDecision']['priority']['conclusion'], 'normal_zero')
        self.assertEqual((result['appliedScope'], [row['complexId'] for row in result['comparables']]),
                         ('expansion', ['same-district']))
        self.assertIn('outside_area_class', {row['reasonCode'] for row in result['exclusions']})

        # 반면 전용면적이 미확인(빈 문자열)이면 정상 0개로 처리하지 않고 우선 지역에서 보류한다.
        self.rows(SALE, [self.sale_row('unpriced', excluUseAr='', dealAmount=''), other_dong])
        bad_exclu_ing = replay(self.bundle)
        self.evidence['tradeLinks'] = []
        self.link_sales(bad_exclu_ing, {('합성 unpriced', None): ('unpriced', None),
                                        ('합성 same-district', '84.50'): ('same-district', '110.0')})
        held = self.compare(ingestion=bad_exclu_ing)
        self.assertEqual(held['regionDecision']['priority']['conclusion'], 'held')
        self.assertIsNone(held['regionDecision']['expansion'])

        # 같은 평형(84.50㎡)의 미기재 금액 거래도 정상 0개가 아니라 보류다.
        self.rows(SALE, [self.sale_row('unpriced', excluUseAr='84.50', dealAmount=''), other_dong])
        same_class_unpriced = replay(self.bundle)
        self.evidence['tradeLinks'] = []
        self.link_sales(same_class_unpriced, {('합성 unpriced', '84.50'): ('unpriced', None),
                                              ('합성 same-district', '84.50'): ('same-district', '110.0')})
        held2 = self.compare(ingestion=same_class_unpriced)
        self.assertEqual(held2['regionDecision']['priority']['conclusion'], 'held')
        self.assertIn('trade_amount_unverified', {h['reasonCode'] for h in held2['holds']})

    def test_decimal_boundaries_do_not_depend_on_context_rounding(self):
        # prec=2 컨텍스트에서도 84.9999999999999999999가 85로 반올림되지 않고 정수부 84로 남는다.
        self.sales_only()
        low_out = '83.' + '9' * 19
        high_in = '84.' + '9' * 19
        high_out = '85.' + '0' * 19
        self.rows(SALE, [
            self.sale_row('low-out', excluUseAr=low_out),
            self.sale_row('inside', excluUseAr=high_in),
            self.sale_row('outside', excluUseAr=high_out),
        ])
        for name in ('low-out', 'inside', 'outside'):
            self.complex(name)
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {('합성 inside', high_in): ('inside', '112.40')})
        with localcontext(Context(prec=2)):
            result = self.compare(ingestion=ingestion)
        self.assertEqual([row['complexId'] for row in result['comparables']], ['inside'])
        self.assertEqual(result['completeness'], 'complete')
        self.assertEqual(sum(item['reasonCode'] == 'outside_area_class' for item in result['exclusions']), 2)

    def test_supply_area_reference_single_range_and_unavailable_do_not_gate_inclusion(self):
        # Q-38·Q-52: 참고 공급면적(단일·범위·없음)은 참고 표시 전용이며 비교 포함 여부나 순위에 영향을 주지 않는다.
        self.sales_only()
        self.rows(SALE, [
            self.sale_row('ref-single', excluUseAr='84.10'),
            self.sale_row('ref-range', excluUseAr='84.20'),
            self.sale_row('ref-none', excluUseAr='84.30'),
        ])
        self.complex('ref-single', latitude='37.501')
        self.complex('ref-range', latitude='37.502')
        self.complex('ref-none', latitude='37.503')
        self.evidence['complexes'][-3]['supplyAreaReferences'] = {
            '84': {'status': 'single', 'm2': '110.50', 'minM2': '110.50', 'maxM2': '110.50',
                   'evidence': {'source': 'synthetic-area-register', 'reference': 'ref-single/84'}},
        }
        self.evidence['complexes'][-2]['supplyAreaReferences'] = {
            '84': {'status': 'range', 'm2': None, 'minM2': '109.63', 'maxM2': '111.20',
                   'evidence': {'source': 'synthetic-area-register', 'reference': 'ref-range/84'}},
        }
        self.evidence['complexes'][-1]['supplyAreaReferences'] = {
            '84': {'status': 'unavailable', 'm2': None, 'minM2': None, 'maxM2': None,
                   'reasonCode': 'notice_not_found'},
        }
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {
            ('합성 ref-single', '84.10'): ('ref-single', None),
            ('합성 ref-range', '84.20'): ('ref-range', None),
            ('합성 ref-none', '84.30'): ('ref-none', None),
        })
        result = self.compare(ingestion=ingestion)
        self.assertEqual([row['complexId'] for row in result['comparables']], ['ref-single', 'ref-range', 'ref-none'])
        self.assertEqual([row['rank'] for row in result['comparables']], [1, 2, 3])
        self.assertEqual(result['completeness'], 'complete')
        self.assertEqual(result['comparables'][0]['supplyAreaReference'], {
            'status': 'single', 'm2': '110.50', 'minM2': '110.50', 'maxM2': '110.50',
            'evidence': {'source': 'synthetic-area-register', 'reference': 'ref-single/84'},
        })
        self.assertEqual(result['comparables'][1]['supplyAreaReference'], {
            'status': 'range', 'm2': None, 'minM2': '109.63', 'maxM2': '111.20',
            'evidence': {'source': 'synthetic-area-register', 'reference': 'ref-range/84'},
        })
        self.assertEqual(result['comparables'][2]['supplyAreaReference'], {
            'status': 'unavailable', 'm2': None, 'minM2': None, 'maxM2': None,
            'reasonCode': 'notice_not_found',
        })

    def test_same_complex_bundles_different_decimals_in_same_area_class_and_keeps_locations(self):
        # Q-52: 같은 단지 안의 같은 평형(84.10·84.98)은 소수점이 달라도 한 묶음으로 집계하고 동일 관측 위치도 보존한다.
        self.sales_only()
        self.complex('bundled')
        type_a = self.sale_row('bundled', excluUseAr='84.10', dealAmount='987654321012345')
        type_b = self.sale_row('bundled', excluUseAr='84.98', dealAmount='12345', dealDay='22')
        other_cls = self.sale_row('bundled', excluUseAr='59.99', dealAmount='50000', dealDay='23')
        self.rows(SALE, [type_a, copy.deepcopy(type_a), type_b, other_cls])
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {
            ('합성 bundled', '84.10'): ('bundled', '110.50'),
            ('합성 bundled', '84.98'): ('bundled', '112.40'),
        })
        result = self.compare(ingestion=ingestion)
        self.assertEqual(result['completeness'], 'complete')
        row = result['comparables'][0]
        self.assertEqual(row['areaClass'], 84)
        self.assertEqual(row['supplyAreaReference']['status'], 'range')
        self.assertEqual((row['supplyAreaReference']['minM2'], row['supplyAreaReference']['maxM2']), ('110.50', '112.40'))
        stats = row['tradeStats']['sale']
        self.assertEqual((stats['count'], stats['smallSample'], stats['minWon'], stats['maxWon'], stats['medianWon']),
                         (3, False, '123450000', '9876543210123450000', '9876543210123450000'))
        self.assertEqual([(obs['page'], obs['position']) for obs in stats['observations']], [(1, 1), (1, 2), (2, 1)])
        self.assertEqual([item['reasonCode'] for item in result['exclusions']], ['outside_area_class'])

    def test_kind_zero_uses_the_selected_area_of_each_complex(self):
        # 같은 단지에 매매는 84㎡형, 분양권·입주권은 59㎡형만 있으면 매매는 확인, 권리는 정상 0건이다.
        rights_page = next(page for page in self.bundle['pages'] if page['source'] == RIGHTS)
        for item in rights_page['body']['response']['body']['items']['item']:
            item['excluUseAr'] = '59.90'
        self.evidence['tradeLinks'] = self.evidence['tradeLinks'][:1]
        result = self.compare()
        sale, presale = (result['tradeKinds'][kind] for kind in ('sale', 'presale_right'))
        self.assertEqual((sale['conclusion'], sale['confirmedCandidateCount']), ('candidates_found', 1))
        self.assertEqual((presale['conclusion'], presale['confirmedCandidateCount'], presale['displayedCandidateCount']),
                         ('normal_zero', 0, 0))
        self.assertEqual(list(result['comparables'][0]['tradeStats']), ['sale'])
        self.assertEqual(result['appliedScope'], 'priority')

    def test_confirmed_kind_count_survives_the_display_limit_and_manual_replacement(self):
        self.evidence['tradeLinks'] = self.evidence['tradeLinks'][1:]
        keys = [f'sale-{n}' for n in range(5)]
        self.rows(SALE, [self.sale_row(key) for key in keys])
        for key in keys:
            self.complex(key)
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {(f'합성 {key}', '84.00'): (key, f'112.{4 + n}') for n, key in enumerate(keys)})
        result = self.compare(ingestion=ingestion)
        presale = result['tradeKinds']['presale_right']
        self.assertEqual((presale['conclusion'], presale['confirmedCandidateCount'], presale['displayedCandidateCount']),
                         ('candidates_found', 1, 0))
        changes = {'replacements': [{'complexId': 'comparison-b', 'replaceComplexId': keys[-1]}]}
        presale = self.compare(changes, ingestion)['tradeKinds']['presale_right']
        self.assertEqual((presale['conclusion'], presale['confirmedCandidateCount'], presale['displayedCandidateCount']),
                         ('candidates_found', 1, 1))

    def test_straight_line_distance_ranking_ties_unverified_conflict_and_manual_replacement(self):
        # Q-52: 같은 평형 후보의 순위는 확인 좌표 간 직선거리순이며, 거리 미확인·좌표 충돌·5위 경계 동률은 D-03 보류로 둔다.
        self.sales_only()
        cases = [('c1', '84.90', '37.501'), ('c2', '84.10', '37.502'), ('c3', '84.50', '37.503'),
                 ('c4', '84.20', '37.504'), ('c5', '84.80', '37.505'), ('c6', '84.00', '37.700'),
                 ('bad-class', '59.90', '37.5005'), ('out-region', '84.00', '37.5005')]
        self.region()
        self.rows(SALE, [self.sale_row(name, excluUseAr=exclu,
                                       **({'umdCd': '00200', 'umdNm': '별빛동'} if name == 'out-region' else {}))
                         for name, exclu, _ in cases])
        for name, _, latitude in cases:
            self.complex(name, OTHER_DONG if name == 'out-region' else PRIORITY, latitude)
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {(f'합성 {name}', exclu): (name, '112.4') for name, exclu, _ in cases})
        result = self.compare(ingestion=ingestion)
        order = ['c1', 'c2', 'c3', 'c4', 'c5']
        self.assertEqual([row['complexId'] for row in result['comparables']], order)
        self.assertEqual([row['rank'] for row in result['comparables']], [1, 2, 3, 4, 5])
        self.assertTrue(all(row['selectionReason'] == 'straight_line_distance' for row in result['comparables']))
        self.assertLess(result['comparables'][0]['distance']['meters'], result['comparables'][1]['distance']['meters'])

        replaced = self.compare({'replacements': [{'complexId': 'c6', 'replaceComplexId': 'c3'}]}, ingestion)
        self.assertEqual([row['complexId'] for row in replaced['comparables']], ['c1', 'c2', 'c6', 'c4', 'c5'])
        for identifier in ('bad-class', 'out-region', 'unknown'):
            failure = self.compare({'replacements': [{'complexId': identifier, 'replaceComplexId': 'c3'}]}, ingestion)
            self.assertEqual([row['complexId'] for row in failure['comparables']], order)
            self.assertIn('replacement_candidate_ineligible', {item['reasonCode'] for item in failure['holds']})
        unclear = self.compare({'replacements': [{'complexId': 'c6'}]}, ingestion)
        self.assertEqual([row['complexId'] for row in unclear['comparables']], order)
        self.assertIn('replacement_target_required', {item['reasonCode'] for item in unclear['holds']})

        # 5위 경계 동률(c5와 c6가 같은 좌표) -> 상위 4곳만 확정하고 경계 동률은 D-03 보류한다.
        c6_complex = next(c for c in self.evidence['complexes'] if c['complexId'] == 'c6')
        c6_complex['coordinates']['latitude'] = '37.505'
        cutoff = self.compare(ingestion=ingestion)
        self.assertEqual([row['complexId'] for row in cutoff['comparables']], ['c1', 'c2', 'c3', 'c4'])
        self.assertFalse(cutoff['rankingComplete'])
        self.assertTrue(any(h['reasonCode'] == 'straight_line_distance_tie' and h.get('affectsSelection') for h in cutoff['holds']))

        # 좌표 미확인 -> 순위 보류(D-03), 좌표 충돌 -> straight_line_coordinate_conflict(D-03)
        c6_complex['coordinates']['latitude'] = '37.700'
        c2_complex = next(c for c in self.evidence['complexes'] if c['complexId'] == 'c2')
        del c2_complex['coordinates']
        unverified = self.compare(ingestion=ingestion)
        self.assertFalse(unverified['rankingComplete'])
        self.assertIn('straight_line_distance_unverified', {h['reasonCode'] for h in unverified['holds']})
        c2_complex['coordinates'] = {'status': 'conflict', 'evidence': {'source': 'synthetic-coordinate-register', 'reference': 'c2'}}
        conflicted = self.compare(ingestion=ingestion)
        self.assertIn('straight_line_coordinate_conflict', {h['reasonCode'] for h in conflicted['holds']})

        # 단독 후보는 좌표 미확인이어도 rank=1로 확정된다.
        self.rows(SALE, [self.sale_row('c2', excluUseAr='84.10')])
        del c2_complex['coordinates']
        self.evidence['tradeLinks'] = []
        sole_ing = replay(self.bundle)
        self.link_sales(sole_ing, {('합성 c2', '84.10'): ('c2', None)})
        sole = self.compare(ingestion=sole_ing)
        self.assertEqual((sole['rankingComplete'], sole['comparables'][0]['rank']), (True, 1))

    def test_default_period_evidence_covers_13_months_and_exact_dates(self):
        self.sales_only()
        del self.bundle['request']['start'], self.bundle['request']['end']
        self.rows(SALE, [], month='202511')
        self.rows(SALE, [], month='202611')
        for month in range(1, 12):
            self.rows(SALE, [], month=f'2026{month:02}')
        self.rows(SALE, [self.sale_row('boundary', dealYear='2025', dealMonth='11', dealDay='10'),
                         self.sale_row('boundary', dealYear='2025', dealMonth='11', dealDay='11')], month='202511')
        self.rows(SALE, [self.sale_row('boundary', dealMonth='11', dealDay='10'),
                         self.sale_row('boundary', dealMonth='11', dealDay='11')], month='202611')
        self.complex('boundary')
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {('합성 boundary', '84.00'): ('boundary', '112.4')})
        result = self.compare(ingestion=ingestion)
        period = result['conditions']['period']
        self.assertEqual((period['start'], period['end'], len(period['months']), period['inProgressMonth']),
                         ('2025-11-11', '2026-11-10', 13, '202611'))
        samples = result['comparables'][0]['tradeStats']['sale']['observations']
        self.assertEqual([row['contractDate'] for row in samples], ['2025-11-11', '2026-11-10'])
        self.assertEqual(result['completeness'], 'partial')  # 2025년 12월 요청이 없음.
        self.rows(SALE, [], month='202512')
        self.assertEqual(self.compare()['completeness'], 'complete')

    def test_equal_straight_line_distances_leave_affected_ranks_pending(self):
        self.sales_only()
        self.area('100')
        self.rows(SALE, [self.sale_row(key) for key in ('north', 'closest', 'south')])
        self.complex('north', latitude='37.5001')
        self.complex('closest', latitude='37.5000')
        self.complex('south', latitude='37.4999')
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {(f'합성 {key}', '84.00'): (key, '100') for key in ('north', 'closest', 'south')})
        result = self.compare(ingestion=ingestion)
        self.assertEqual([row['rank'] for row in result['comparables']], [1, None, None])
        hold = next(hold for hold in result['holds'] if hold['subject'] == 'ranking')
        self.assertEqual(hold['reasonCode'], 'straight_line_distance_tie')
        self.assertEqual({*hold['complexIds']}, {'north', 'south'})

    def test_characteristic_approval_date_must_exist_on_the_calendar(self):
        self.evidence['complexes'][1]['characteristics'] = [
            {'field': 'approvalDate', 'status': 'confirmed', 'value': value,
             'evidence': {'source': 'kapt', 'reference': f'synthetic-approval/{value}'}}
            for value in ('2026-02-29', '2026-04-31', '2024-02-29')
        ]
        info = self.compare()['comparables'][0]['characteristics']
        self.assertEqual([item['value'] for item in info], ['2024-02-29'])

    def test_complex_characteristics_preserve_an_independent_kapt_status(self):
        self.evidence['complexes'][1]['characteristics'] = [
            {'field': 'householdCount', 'status': 'failed', 'errorCode': '04',
             'evidence': {'source': 'kapt', 'reference': 'synthetic-kapt-request-1'}},
            {'field': 'householdCount', 'status': 'conflict',
             'evidence': {'source': 'kapt', 'reference': 'synthetic-kapt-request-2'}},
            {'field': 'householdCount', 'status': 'empty',
             'evidence': {'source': 'kapt', 'reference': 'synthetic-kapt-request-3'}},
        ]
        result = self.compare()
        info = result['comparables'][0]['characteristics']
        self.assertEqual([(item['status'], item.get('errorCode')) for item in info],
                         [('failed', '04'), ('conflict', None), ('empty', None)])
        self.assertTrue(all(item['evidence']['source'] == 'kapt' for item in info))
        self.assertEqual(result['completeness'], 'complete')

    def test_comparison_period_narrows_and_rewidens_against_immutable_capture_without_mutation(self):
        ingestion = replay(self.bundle)
        baseline = compare_snapshot(ingestion, {}, self.evidence)
        before_ingestion = copy.deepcopy(ingestion)
        before_evidence = copy.deepcopy(self.evidence)
        selection = {'modelNo': '01'}
        before_selection = copy.deepcopy(selection)
        narrow_request = {'start': '2026-10-24', 'end': '2026-10-26'}
        before_narrow = copy.deepcopy(narrow_request)

        narrowed = compare_snapshot(ingestion, selection, self.evidence, comparison_period=narrow_request)
        self.assertEqual(narrowed['conditions']['period'], trade_period('2026-11-10', '2026-10-24', '2026-10-26'))
        self.assertEqual(narrowed['conditions']['period']['source'], 'user_confirmed')
        self.assertEqual((narrowed['completeness'], narrowed['appliedScope'], narrowed['rankingComplete']),
                         ('complete', 'priority', True))
        self.assertEqual(narrowed['holds'], [])
        self.assertEqual([row['complexId'] for row in narrowed['comparables']], ['comparison-b'])
        self.assertEqual(narrowed['comparables'][0]['rank'], 1)
        self.assertEqual(narrowed['regionDecision']['priority']['confirmedCandidateCount'], 1)
        rights = narrowed['comparables'][0]['tradeStats']
        self.assertEqual({kind: (stats['count'], stats['medianWon'], stats['observations'][0]['contractDate'])
                          for kind, stats in rights.items()},
                         {'presale_right': (1, '405000000', '2026-10-24'),
                          'occupancy_right': (1, '486000000', '2026-10-26')})
        self.assertEqual(narrowed['tradeKinds']['sale']['conclusion'], 'normal_zero')
        self.assertEqual(narrowed['tradeKinds']['sale']['confirmedCandidateCount'], 0)
        self.assertEqual(narrowed['tradeKinds']['presale_right']['displayedCandidateCount'], 1)
        self.assertEqual(narrowed['tradeKinds']['occupancy_right']['displayedCandidateCount'], 1)
        self.assertEqual([item['reasonCode'] for item in narrowed['exclusions']], ['outside_contract_period'] * 3)

        rewidened = compare_snapshot(ingestion, selection, self.evidence,
                                     comparison_period={'start': '2026-10-20', 'end': '2026-10-24'})
        self.assertEqual(rewidened['conditions']['period'], trade_period('2026-11-10', '2026-10-20', '2026-10-24'))
        self.assertEqual((rewidened['completeness'], rewidened['appliedScope'], rewidened['rankingComplete']),
                         ('complete', 'priority', True))
        self.assertEqual([row['complexId'] for row in rewidened['comparables']], ['comparison-a', 'comparison-b'])
        self.assertEqual(rewidened['comparables'][0]['tradeStats']['sale']['observations'][0]['contractDate'], '2026-10-20')
        self.assertEqual(list(rewidened['comparables'][1]['tradeStats']), ['presale_right'])
        self.assertEqual(rewidened['tradeKinds']['occupancy_right']['conclusion'], 'normal_zero')
        self.assertEqual({item['reasonCode'] for item in rewidened['exclusions']},
                         {'cancelled_trade', 'outside_contract_period'})
        self.assertEqual(sum(item['reasonCode'] == 'outside_contract_period' for item in rewidened['exclusions']), 2)

        single_day = compare_snapshot(ingestion, selection, self.evidence,
                                      comparison_period={'start': '2026-10-24', 'end': '2026-10-24'})
        self.assertEqual([row['complexId'] for row in single_day['comparables']], ['comparison-b'])
        self.assertEqual(list(single_day['comparables'][0]['tradeStats']), ['presale_right'])

        self.assertEqual(ingestion, before_ingestion)
        self.assertEqual(self.evidence, before_evidence)
        self.assertEqual(selection, before_selection)
        self.assertEqual(narrow_request, before_narrow)
        self.assertEqual(compare_snapshot(ingestion, {}, self.evidence), baseline)

    def test_selection_conditions_cannot_override_comparison_period(self):
        ingestion = replay(self.bundle)
        baseline = compare_snapshot(ingestion, {}, self.evidence)
        injected = {
            'comparisonPeriod': {'start': '2026-10-24', 'end': '2026-10-26'},
            'comparison_period': {'start': '2026-10-24', 'end': '2026-10-26'},
            'period': {'start': '2026-10-24', 'end': '2026-10-26'},
            'start': '2026-10-24',
            'end': '2026-10-26',
            'periodChangeConfirmed': True,
        }
        self.assertEqual(compare_snapshot(ingestion, injected, self.evidence), baseline)
        approved = compare_snapshot(ingestion, injected, self.evidence,
                                    comparison_period={'start': '2026-10-24', 'end': '2026-10-26'})
        self.assertEqual(approved['conditions']['period'], trade_period('2026-11-10', '2026-10-24', '2026-10-26'))
        self.assertEqual([row['complexId'] for row in approved['comparables']], ['comparison-b'])

    def test_comparison_period_rejects_malformed_invalid_and_out_of_coverage_requests(self):
        ingestion = replay(self.bundle)
        invalid_requests = [
            '2026-10-24..2026-10-26',
            ['2026-10-24', '2026-10-26'],
            False,
            123,
            {},
            {'start': '2026-10-24'},
            {'end': '2026-10-26'},
            {'start': '2026-10-24', 'end': '2026-10-26', 'asOf': '2026-11-10'},
            {'start': '2026-10-24', 'end': '2026-10-26', 'source': 'default_recent_year'},
            {'start': '2026-10-24', 'end': '2026-10-26', 'extra': None},
            {'start': None, 'end': '2026-10-26'},
            {'start': '2026-10-24', 'end': None},
            {'start': ' 2026-10-24', 'end': '2026-10-26'},
            {'start': '2026-10-24', 'end': '2026-10-26\n'},
            {'start': 20261024, 'end': 20261026},
            {'start': '2026-02-29', 'end': '2026-10-26'},
            {'start': '2026-10-26', 'end': '2026-10-24'},
            {'start': '2026-10-09', 'end': '2026-10-26'},
            {'start': '2026-10-24', 'end': '2026-11-01'},
            {'start': '2026-10-24', 'end': '2026-11-11'},
        ]
        for bad in invalid_requests:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    compare_snapshot(ingestion, {}, self.evidence, comparison_period=bad)
                with self.assertRaises(ValueError):
                    compare_snapshot(ingestion, {}, self.evidence,
                                     binding_issue='target_identity_unverified', comparison_period=bad)

        leap = copy.deepcopy(ingestion)
        leap['asOf'] = '2024-03-01'
        leap['period'] = trade_period('2024-03-01')
        with self.assertRaises(ValueError):
            compare_snapshot(leap, {}, self.evidence, comparison_period={'start': '2024-02-01', 'end': '2024-02-28'})

    def test_comparison_period_sets_canonical_user_confirmed_period_even_when_other_gates_hold(self):
        ingestion = replay(self.bundle)
        override = {'start': '2026-10-24', 'end': '2026-10-26'}
        expected_period = trade_period('2026-11-10', '2026-10-24', '2026-10-26')

        wrong_target = copy.deepcopy(ingestion)
        wrong_target['target'] = {**wrong_target['target'], 'edition': 'different-edition'}
        wrong_catalog = copy.deepcopy(ingestion)
        wrong_catalog['catalog']['contract'] = 'unsupported/v0'
        wrong_kinds = copy.deepcopy(ingestion)
        wrong_kinds['tradeKinds'] = []
        wrong_regions = copy.deepcopy(ingestion)
        wrong_regions['requestRegionCodes'] = ['bad']
        wrong_area_class = copy.deepcopy(ingestion)
        wrong_area_class['catalog']['housingTypes'][0]['houseType']['value'] = '특별형'
        unverified_target_evidence = copy.deepcopy(self.evidence)
        unverified_target_evidence['target']['status'] = 'unverified'
        unverified_priority_evidence = copy.deepcopy(self.evidence)
        unverified_priority_evidence['scopes']['priority']['status'] = 'unverified'

        cases = [
            ('binding', ingestion, {}, self.evidence, 'target_identity_unverified', 'target_identity_unverified'),
            ('notice', wrong_target, {}, self.evidence, None, 'notice_identity_unverified'),
            ('catalog', wrong_catalog, {}, self.evidence, None, 'catalog_version_unsupported'),
            ('selection', ingestion, 'not-a-dict', self.evidence, None, 'selection_invalid'),
            ('kinds', wrong_kinds, {}, self.evidence, None, 'trade_kinds_unverified'),
            ('regions', wrong_regions, {}, self.evidence, None, 'collection_request_regions_unverified'),
            ('model', ingestion, {'modelNo': '99'}, self.evidence, None, 'housing_type_unverified'),
            ('area', wrong_area_class, {}, self.evidence, None, 'target_area_class_unverified'),
            ('evidence', ingestion, {}, None, None, 'comparison_evidence_unverified'),
            ('target_complex', ingestion, {}, unverified_target_evidence, None, 'target_complex_identity_unverified'),
            ('priority_region', ingestion, {}, unverified_priority_evidence, None, 'priority_region_unverified'),
        ]
        for label, cap, sel, ev, binding, expected_reason in cases:
            with self.subTest(case=label):
                result = compare_snapshot(cap, sel, ev, binding_issue=binding, comparison_period=override)
                self.assertEqual(result['conditions']['period'], expected_period)
                self.assertEqual(result['conditions']['period']['source'], 'user_confirmed')
                self.assertIn(expected_reason, {hold['reasonCode'] for hold in result['holds']})

        self.sales_only()
        del self.bundle['request']['start'], self.bundle['request']['end']
        self.rows(SALE, [], month='202511')
        self.rows(SALE, [], month='202512')
        for month in range(1, 12):
            self.rows(SALE, [], month=f'2026{month:02}')
        default_capture = replay(self.bundle)
        self.assertEqual(default_capture['period']['source'], 'default_recent_year')
        oct_only = compare_snapshot(default_capture, {}, None,
                                    comparison_period={'start': '2026-10-01', 'end': '2026-10-31'})
        self.assertEqual(oct_only['conditions']['period'], trade_period('2026-11-10', '2026-10-01', '2026-10-31'))
        self.assertIsNone(oct_only['conditions']['period']['inProgressMonth'])
        self.assertEqual([c['month'] for c in oct_only['collections']], ['2026-10'])
        with_in_progress = compare_snapshot(default_capture, {}, None,
                                            comparison_period={'start': '2026-10-01', 'end': '2026-11-05'})
        self.assertEqual(with_in_progress['conditions']['period'],
                         trade_period('2026-11-10', '2026-10-01', '2026-11-05'))
        self.assertEqual(with_in_progress['conditions']['period']['inProgressMonth'], '202611')

    def test_comparison_period_distinguishes_normal_zero_holds_missing_pages_and_dedupes(self):
        # 완전한 수집에서 기간 내 거래가 0건이면 정상 0개로 확대하고 collections를 중복 없이 유지한다.
        complete_capture = replay(self.bundle)
        empty_range = compare_snapshot(complete_capture, {}, self.evidence,
                                       comparison_period={'start': '2026-10-27', 'end': '2026-10-31'})
        self.assertEqual((empty_range['completeness'], empty_range['appliedScope'], empty_range['comparables']),
                         ('complete', 'expansion', []))
        self.assertEqual(empty_range['regionDecision']['priority']['conclusion'], 'normal_zero')
        self.assertEqual(empty_range['regionDecision']['expansion']['conclusion'], 'normal_zero')
        self.assertEqual(len(empty_range['collections']), 2)
        self.assertEqual(len({c['recordId'] for c in empty_range['collections']}), 2)

        # 관련 월의 누락 페이지는 기간을 좁혀도 정상 0개로 바꾸지 않고 보류·확대 차단을 유지한다.
        missing_page_bundle = copy.deepcopy(self.bundle)
        missing_page_bundle['pages'] = [
            page for page in missing_page_bundle['pages']
            if not (page['source'] == SALE and page['page'] == 2)
        ]
        missing_page_capture = replay(missing_page_bundle)
        narrowed_missing = compare_snapshot(missing_page_capture, {}, self.evidence,
                                            comparison_period={'start': '2026-10-24', 'end': '2026-10-26'})
        self.assertEqual((narrowed_missing['completeness'], narrowed_missing['rankingComplete']), ('partial', False))
        self.assertEqual(narrowed_missing['tradeKinds']['sale']['conclusion'], 'held')
        self.assertEqual(narrowed_missing['comparables'][0]['tradeStats']['presale_right']['status'], 'provisional')
        self.assertIsNone(narrowed_missing['comparables'][0]['rank'])
        zero_with_missing = compare_snapshot(missing_page_capture, {}, self.evidence,
                                             comparison_period={'start': '2026-10-27', 'end': '2026-10-31'})
        self.assertEqual((zero_with_missing['completeness'], zero_with_missing['appliedScope']), ('partial', 'priority'))
        self.assertEqual(zero_with_missing['regionDecision']['priority']['conclusion'], 'held')
        self.assertIsNone(zero_with_missing['regionDecision']['expansion'])

        # 계약일 결측 행은 기간 축소로 제외되지 않고 보류를 유지한다.
        self.sales_only()
        self.bundle['request']['start'] = '2026-09-01'
        self.bundle['request']['end'] = '2026-10-31'
        self.complex('multi')
        self.rows(SALE, [self.sale_row('multi', dealYear='2026', dealMonth='09', dealDay='15', excluUseAr='84.10')], month='202609')
        self.rows(SALE, [self.sale_row('multi', dealYear='2026', dealMonth='10', dealDay='20', excluUseAr='84.10'),
                         self.sale_row('multi', dealYear='2026', dealMonth='10', dealDay='25', excluUseAr='84.90')], month='202610')
        multi_bundle = copy.deepcopy(self.bundle)
        # 2026-09에 누락 페이지(totalCount=3, page 1만 존재)를 만들고 2026-10은 완전 수집으로 둔다.
        for page in multi_bundle['pages']:
            if page['source'] == SALE and page['scope']['DEAL_YMD'] == '202609':
                page['body']['response']['body']['totalCount'] = 3
        multi_capture = replay(multi_bundle)
        self.link_sales(multi_capture, {('합성 multi', '84.10'): ('multi', '112.0'),
                                        ('합성 multi', '84.90'): ('multi', '110.0')})
        full_multi = compare_snapshot(multi_capture, {}, self.evidence)
        self.assertEqual(full_multi['completeness'], 'partial')
        oct_only = compare_snapshot(multi_capture, {}, self.evidence,
                                    comparison_period={'start': '2026-10-24', 'end': '2026-10-26'})
        self.assertEqual(oct_only['completeness'], 'complete')
        self.assertEqual([c['month'] for c in oct_only['collections']], ['2026-10'])
        self.assertEqual(oct_only['comparables'][0]['supplyAreaReference']['status'], 'single')
        self.assertEqual(oct_only['comparables'][0]['supplyAreaReference']['m2'], '110.0')
        oct_rewidened = compare_snapshot(multi_capture, {}, self.evidence,
                                         comparison_period={'start': '2026-10-20', 'end': '2026-10-26'})
        self.assertEqual(oct_rewidened['completeness'], 'complete')
        self.assertEqual(oct_rewidened['comparables'][0]['tradeStats']['sale']['count'], 2)
        self.assertEqual(oct_rewidened['comparables'][0]['supplyAreaReference']['status'], 'range')
        self.assertEqual((oct_rewidened['comparables'][0]['supplyAreaReference']['minM2'],
                          oct_rewidened['comparables'][0]['supplyAreaReference']['maxM2']), ('110.0', '112.0'))
        sept_rewidened = compare_snapshot(multi_capture, {}, self.evidence,
                                          comparison_period={'start': '2026-09-15', 'end': '2026-10-26'})
        self.assertEqual(sept_rewidened['completeness'], 'partial')

        # 계약일이 비어 있는 보류 행은 같은 월에서 기간을 좁혀도 정상 0개가 되지 않는다.
        self.bundle['request']['start'] = '2026-10-10'
        self.bundle['request']['end'] = '2026-10-31'
        self.evidence['tradeLinks'] = []
        self.bundle['pages'] = [p for p in self.bundle['pages'] if p['scope'].get('DEAL_YMD') != '202609']
        self.rows(SALE, [self.sale_row('multi', dealDay='')], month='202610')
        undated_capture = replay(self.bundle)
        self.link_sales(undated_capture, {('합성 multi', '84.00'): ('multi', '112.4')})
        held_undated = compare_snapshot(undated_capture, {}, self.evidence,
                                        comparison_period={'start': '2026-10-24', 'end': '2026-10-26'})
        self.assertEqual(held_undated['regionDecision']['priority']['conclusion'], 'held')
        self.assertEqual(held_undated['tradeKinds']['sale']['conclusion'], 'held')
        self.assertIsNone(held_undated['regionDecision']['expansion'])

    def test_full_year_capture_narrowed_to_one_or_two_months_and_rewidened_uses_original_evidence(self):
        # 기본 1년(13개 계약월) 수집본에 미수집·실패·부분수집·보류·타동 거래가 섞여 있어도
        # 1~2개월 축소 시 요청 월 밖 기록은 outside_applied_region이나 보류로 집계하지 않는다.
        self.sales_only()
        del self.bundle['request']['start'], self.bundle['request']['end']
        self.region()  # OTHER_DONG (별빛동)
        for identifier, locality, lat in [
            ('feb-part', PRIORITY, '37.501'),
            ('mar-held', PRIORITY, '37.502'),
            ('may-garam', PRIORITY, '37.503'),
            ('may-other', OTHER_DONG, '37.504'),
            ('sept-out', PRIORITY, '37.505'),
            ('sept-in', PRIORITY, '37.506'),
            ('oct-in', PRIORITY, '37.507'),
            ('oct-out', PRIORITY, '37.508'),
        ]:
            self.complex(identifier, locality, lat)
        for month in ('202511', '202512', '202601', '202602', '202603', '202604', '202605',
                      '202606', '202607', '202608', '202609', '202610', '202611'):
            self.rows(SALE, [], month=month)
        self.rows(SALE, [self.sale_row('feb-part', dealYear='2026', dealMonth='02', dealDay='10')], month='202602')
        self.rows(SALE, [self.sale_row('mar-held', dealYear='2026', dealMonth='03', dealDay='12')], month='202603')
        self.rows(SALE, [
            self.sale_row('may-garam', dealYear='2026', dealMonth='05', dealDay='15'),
            self.sale_row('may-other', dealYear='2026', dealMonth='05', dealDay='16', umdCd='00200', umdNm='별빛동'),
        ], month='202605')
        self.rows(SALE, [
            self.sale_row('sept-out', dealYear='2026', dealMonth='09', dealDay='10'),
            self.sale_row('sept-in', dealYear='2026', dealMonth='09', dealDay='15'),
        ], month='202609')
        self.rows(SALE, [
            self.sale_row('oct-in', dealYear='2026', dealMonth='10', dealDay='20'),
            self.sale_row('oct-out', dealYear='2026', dealMonth='10', dealDay='25'),
        ], month='202610')
        # 2026-01·2026-11 실패, 2026-02 누락 페이지(totalCount=3) 구성
        for page in self.bundle['pages']:
            if page['source'] == SALE and page['scope']['DEAL_YMD'] in ('202601', '202611'):
                page['body']['response']['header']['resultCode'] = '04'
            elif page['source'] == SALE and page['scope']['DEAL_YMD'] == '202602':
                page['body']['response']['body']['totalCount'] = 3
        full_capture = replay(self.bundle)
        # 2025-12 배치는 수집본에서 아예 빠진 미수집 월로 둔다.
        full_capture['tradeBatches'] = [
            batch for batch in full_capture['tradeBatches'] if batch['record']['month'] != '2025-12'
        ]
        self.link_sales(full_capture, {
            ('합성 feb-part', '84.00'): ('feb-part', '112.40'),
            # mar-held는 단지 연결 근거(tradeLinks)를 의도적으로 빼 trade_link_unverified 보류를 만든다.
            ('합성 may-garam', '84.00'): ('may-garam', '112.40'),
            ('합성 may-other', '84.00'): ('may-other', '112.40'),
            ('합성 sept-out', '84.00'): ('sept-out', '112.50'),
            ('합성 sept-in', '84.00'): ('sept-in', '112.40'),
            ('합성 oct-in', '84.00'): ('oct-in', '112.45'),
            ('합성 oct-out', '84.00'): ('oct-out', '112.60'),
        })
        before_capture = copy.deepcopy(full_capture)
        before_evidence = copy.deepcopy(self.evidence)

        baseline = compare_snapshot(full_capture, {}, self.evidence)
        self.assertEqual((baseline['completeness'], baseline['rankingComplete']), ('partial', False))
        self.assertIn('outside_applied_region', {item['reasonCode'] for item in baseline['exclusions']})

        # 2개월(2026-09-15..2026-10-20) 축소: 2025-12·2026-01·02·03·11 미해소와 2026-05 타동이 집계되지 않는다.
        two_months = compare_snapshot(full_capture, {}, self.evidence,
                                      comparison_period={'start': '2026-09-15', 'end': '2026-10-20'})
        self.assertEqual(two_months['conditions']['period'], trade_period('2026-11-10', '2026-09-15', '2026-10-20'))
        self.assertIsNone(two_months['conditions']['period']['inProgressMonth'])
        self.assertEqual((two_months['completeness'], two_months['rankingComplete'], two_months['holds']),
                         ('complete', True, []))
        self.assertEqual([c['month'] for c in two_months['collections']], ['2026-09', '2026-10'])
        self.assertEqual([row['complexId'] for row in two_months['comparables']], ['sept-in', 'oct-in'])
        self.assertEqual([row['rank'] for row in two_months['comparables']], [1, 2])
        self.assertEqual([(item['reasonCode'], item['reference']['recordId']) for item in two_months['exclusions']], [
            ('outside_contract_period', 'col-apt_trade-99999-202609'),
            ('outside_contract_period', 'col-apt_trade-99999-202610'),
        ])
        self.assertNotIn('outside_applied_region', {item['reasonCode'] for item in two_months['exclusions']})

        # 1개월(2026-10-01..2026-10-20) 축소: 2026-10만 유지하고 10-25만 outside_contract_period로 제외한다.
        one_month = compare_snapshot(full_capture, {}, self.evidence,
                                     comparison_period={'start': '2026-10-01', 'end': '2026-10-20'})
        self.assertEqual((one_month['completeness'], one_month['holds']), ('complete', []))
        self.assertEqual([c['month'] for c in one_month['collections']], ['2026-10'])
        self.assertEqual([row['complexId'] for row in one_month['comparables']], ['oct-in'])
        self.assertEqual([(item['reasonCode'], item['reference']['recordId']) for item in one_month['exclusions']], [
            ('outside_contract_period', 'col-apt_trade-99999-202610'),
        ])

        # 원본 수집본·원본 근거로 2026-05-01..2026-10-31 재확대 시 5월·9월·10월 후보가 모두 복원된다.
        rewidened_clean = compare_snapshot(full_capture, {}, self.evidence,
                                           comparison_period={'start': '2026-05-01', 'end': '2026-10-31'})
        self.assertEqual((rewidened_clean['completeness'], rewidened_clean['holds']), ('complete', []))
        self.assertEqual({row['complexId'] for row in rewidened_clean['comparables']},
                         {'may-garam', 'sept-in', 'oct-in', 'sept-out', 'oct-out'})
        self.assertEqual([(item['reasonCode'], item['reference']['recordId']) for item in rewidened_clean['exclusions']], [
            ('outside_applied_region', 'col-apt_trade-99999-202605'),
        ])

        # 원본 전체(2025-11-11..2026-11-10)로 다시 넓히면 원래 미해소 월·보류 행과 2월 근거가 다시 반영된다.
        rewidened_full = compare_snapshot(full_capture, {}, self.evidence,
                                          comparison_period={'start': '2025-11-11', 'end': '2026-11-10'})
        self.assertEqual(rewidened_full['conditions']['period'],
                         trade_period('2026-11-10', '2025-11-11', '2026-11-10'))
        self.assertEqual(rewidened_full['conditions']['period']['inProgressMonth'], '202611')
        self.assertEqual((rewidened_full['completeness'], rewidened_full['rankingComplete']), ('partial', False))
        hold_reasons = {hold['reasonCode'] for hold in rewidened_full['holds']}
        self.assertTrue({'collection_not_replayed', 'trade_link_unverified'} <= hold_reasons)
        self.assertIn('feb-part', {row['complexId'] for row in rewidened_full['comparables']})
        self.assertEqual(full_capture, before_capture)
        self.assertEqual(self.evidence, before_evidence)

    def test_approved_conditions_keep_area_class_kind_subsets_and_bounded_replacement(self):
        # Q-52: 84㎡형 기준에 다른 평형(59·85)과 같은 평형(84.x) 후보가 있으면 84㎡형만 적격이며 직선거리순 상위 5단지를 선정한다.
        self.sales_only()
        cases = [('low-out', '59.99', '37.5005'), ('high-out', '85.00', '37.5005'),
                 ('near-a', '84.10', '37.501'), ('near-b', '84.50', '37.502'),
                 ('near-c', '84.90', '37.503'), ('near-d', '84.20', '37.504'),
                 ('fifth', '84.99', '37.505'), ('sixth', '84.00', '37.506'),
                 ('unlinked', '84.00', '37.507'), ('out-region', '84.00', '37.5005')]
        self.region()
        self.rows(SALE, [self.sale_row(name, excluUseAr=exclu,
                                       **({'umdCd': '00200', 'umdNm': '별빛동'} if name == 'out-region' else {}))
                         for name, exclu, _ in cases])
        for name, _, lat in cases:
            self.complex(name, OTHER_DONG if name == 'out-region' else PRIORITY, lat)
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {(f'합성 {name}', exclu): (name, '112.4') for name, exclu, _ in cases if name != 'unlinked'})
        before_capture, before_evidence = copy.deepcopy(ingestion), copy.deepcopy(self.evidence)

        def run(conditions=None):
            return compare_snapshot(ingestion, {}, self.evidence, comparison_conditions=conditions)

        base = run()
        self.assertEqual(base['conditions']['area'], {'basis': 'exclusive_area_class', 'class': 84})
        displayed = [row['complexId'] for row in base['comparables']]
        self.assertEqual(displayed, ['near-a', 'near-b', 'near-c', 'near-d', 'fifth'])
        pool = {entry['complexId']: entry for entry in base['candidatePool']}
        self.assertTrue(pool['fifth']['eligible'] and pool['sixth']['eligible'])
        self.assertFalse(pool['sixth']['selected'])
        self.assertEqual(pool['sixth']['areaClass'], 84)
        self.assertIsInstance(pool['sixth']['distanceMeters'], float)
        for name in ('low-out', 'high-out'):
            self.assertEqual((pool[name]['eligible'], pool[name]['reasonCode']), (False, 'outside_area_class'))
        self.assertEqual((pool['out-region']['eligible'], pool['out-region']['reasonCode']),
                         (False, 'outside_applied_region'))
        self.assertFalse(pool['unlinked']['eligible'])
        self.assertNotIn('target', pool)

        # A-54: 적격 후보만 기존 단지와 교체해 고유 5개 이하를 유지하고 선정 이유를 남긴다.
        replaced = run({'replacements': [{'complexId': 'sixth', 'replaceComplexId': 'fifth'}]})
        self.assertEqual([row['complexId'] for row in replaced['comparables']],
                         ['near-a', 'near-b', 'near-c', 'near-d', 'sixth'])
        self.assertEqual((replaced['comparables'][4]['selectionReason'], replaced['comparables'][4]['replacesComplexId']),
                         ('manual_replacement', 'fifth'))
        self.assertEqual(run({'replacements': []})['comparables'], base['comparables'])
        for identifier, cause in [('low-out', 'outside_area_class'), ('out-region', 'outside_applied_region'),
                                  ('unknown', 'candidate_unverified'), ('near-a', 'already_selected')]:
            failure = run({'replacements': [{'complexId': identifier, 'replaceComplexId': 'fifth'}]})
            self.assertEqual([row['complexId'] for row in failure['comparables']], displayed)
            holds = [row for row in failure['holds'] if row['reasonCode'] == 'replacement_candidate_ineligible']
            self.assertEqual([(row['complexId'], row['replaceComplexId'], row['candidateReason']) for row in holds],
                             [(identifier, 'fifth', cause)])
        missing = run({'replacements': [{'complexId': 'sixth', 'replaceComplexId': 'not-displayed'}]})
        self.assertEqual([row['complexId'] for row in missing['comparables']], displayed)
        self.assertIn('replacement_target_required', {row['reasonCode'] for row in missing['holds']})

        # Q-52: 승인 조건에 areaTolerancePercent를 넣거나 형식 오류·수집하지 않은 거래 종류는 결과를 만들지 않는다.
        for bad in [{}, {'areaTolerancePercent': '3'}, {'areaTolerancePercent': '5'}, {'areaTolerancePercent': '0'},
                    {'areaTolerancePercent': '7'}, {'areaTolerancePercent': 3}, {'tradeKinds': []},
                    {'tradeKinds': ['sale', 'sale']}, {'tradeKinds': ['presale_right']},
                    {'replacements': [{'complexId': 'near-a', 'replaceComplexId': 'near-a'}]},
                    {'replacements': [{'complexId': 'sixth', 'replaceComplexId': 'near-a'},
                                      {'complexId': 'near-a', 'replaceComplexId': 'near-b'}]},
                    {'replacements': [{'complexId': 'near-a'}]}, {'unknownKey': True}]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                run(bad)
        self.assertEqual(ingestion, before_capture)
        self.assertEqual(self.evidence, before_evidence)

    def test_approved_trade_kind_subset_keeps_collection_completeness_without_mutation(self):
        ingestion = replay(self.bundle)
        before = copy.deepcopy(ingestion)
        base = compare_snapshot(ingestion, {}, self.evidence)
        rights_only = compare_snapshot(ingestion, {}, self.evidence, comparison_conditions={'tradeKinds': ['presale_right']})
        self.assertEqual(rights_only['conditions']['tradeKinds'], ['presale_right'])
        self.assertEqual(set(rights_only['tradeKinds']), {'presale_right'})
        self.assertEqual({row['source'] for row in rights_only['collections']}, {RIGHTS})
        self.assertTrue(all(row['tradeKinds'] == ['presale_right'] for row in rights_only['collections']))
        self.assertEqual([row['status'] for row in rights_only['collections']],
                         [row['status'] for row in base['collections'] if row['source'] == RIGHTS])
        self.assertEqual([row['complexId'] for row in rights_only['comparables']], ['comparison-b'])
        self.assertEqual(list(rights_only['comparables'][0]['tradeStats']), ['presale_right'])
        sale_only = compare_snapshot(ingestion, {}, self.evidence, comparison_conditions={'tradeKinds': ['sale']})
        self.assertEqual({row['source'] for row in sale_only['collections']}, {SALE})
        self.assertEqual([row['complexId'] for row in sale_only['comparables']], ['comparison-a'])
        self.assertEqual(sale_only['completeness'], base['completeness'])
        # 승인 기간과 함께 전달된 조건의 기간이 다르면 거부한다.
        with self.assertRaises(ValueError):
            compare_snapshot(ingestion, {}, self.evidence, comparison_period={'start': '2026-10-15', 'end': '2026-10-25'},
                             comparison_conditions={'period': {'start': '2026-10-14', 'end': '2026-10-25'}})
        self.assertEqual(ingestion, before)

if __name__ == '__main__':
    unittest.main()
