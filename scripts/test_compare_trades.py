#!/usr/bin/env python3
"""BE-05 비교 판정의 오프라인 검사. 공고·단지·거래·근거는 모두 합성 자료다."""

import copy
import json
import unittest
from decimal import Context, Decimal, localcontext
from pathlib import Path

from compare_trades import compare_snapshot
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

    def test_supply_area_must_be_checked_and_bound_to_same_edition(self):
        ingestion = replay(self.bundle)
        ingestion['catalog']['documents'][0]['edition'] = 'other-edition'
        result = self.compare({'supplyAreaM2': '112.4', 'regionCode': PRIORITY}, ingestion)
        self.assertEqual((result['comparables'], result['appliedScope']), ([], None))
        self.assertIn('target_supply_area_unverified', {item['reasonCode'] for item in result['holds']})
        self.assertIsNone(result['noticePrice']['minWon'])

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
        self.evidence['tradeLinks'][0]['supplyAreaM2'] = None
        result = self.compare(ingestion=ingestion)
        self.assertEqual(result['appliedScope'], 'expansion')
        self.assertEqual(result['targetReferences'], [])

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

    def test_area_limits_are_inclusive_and_a_changed_limit_needs_confirmation(self):
        self.sales_only()
        self.area('100')
        areas = ['94.99', '95', '105', '105.01', None]
        self.rows(SALE, [self.sale_row(str(i)) for i in range(len(areas))])
        for i in range(len(areas)):
            self.complex(str(i), latitude=f'37.50{i}')
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {(f'합성 {i}', '84.00'): (str(i), area) for i, area in enumerate(areas)})
        result = self.compare({'areaTolerancePercent': '6'}, ingestion)
        self.assertEqual({row['complexId'] for row in result['comparables']}, {'1', '2'})
        self.assertEqual(result['conditions']['area']['tolerancePercent'], '5')
        self.assertEqual(result['completeness'], 'partial')
        self.assertEqual(sum(item['reasonCode'] == 'outside_supply_area' for item in result['exclusions']), 2)
        changed = self.compare({'areaTolerancePercent': '6', 'areaChangeConfirmed': True}, ingestion)
        self.assertEqual({row['complexId'] for row in changed['comparables']}, {'0', '1', '2', '3'})

    def test_confirmed_out_of_range_area_excludes_an_unpriced_trade(self):
        self.sales_only()
        self.area('100')
        self.region()
        self.complex('unpriced')
        self.complex('same-district', OTHER_DONG)
        unpriced = self.sale_row('unpriced', dealAmount='')
        other_dong = self.sale_row('same-district', umdNm='별빛동', umdCd='00200')
        self.rows(SALE, [unpriced, other_dong])
        ingestion = replay(self.bundle)
        mapping = {('합성 unpriced', '84.00'): ('unpriced', '106'),
                   ('합성 same-district', '84.00'): ('same-district', '100')}
        self.link_sales(ingestion, mapping)
        result = self.compare(ingestion=ingestion)
        self.assertEqual(result['regionDecision']['priority']['conclusion'], 'normal_zero')
        self.assertEqual((result['appliedScope'], [row['complexId'] for row in result['comparables']]),
                         ('expansion', ['same-district']))
        self.assertIn('outside_supply_area', {row['reasonCode'] for row in result['exclusions']})
        self.evidence['tradeLinks'][0]['supplyAreaM2'] = None
        self.assertEqual(self.compare(ingestion=ingestion)['regionDecision']['priority']['conclusion'], 'held')
        self.rows(SALE, [unpriced, self.sale_row('unpriced', dealDay='21'), other_dong])
        conflicting_ingestion = replay(self.bundle)
        self.evidence['tradeLinks'] = []
        self.link_sales(conflicting_ingestion, mapping)
        self.evidence['tradeLinks'][1]['supplyAreaM2'] = '107'
        conflict = self.compare(ingestion=conflicting_ingestion)
        self.assertEqual(conflict['regionDecision']['priority']['conclusion'], 'held')
        self.assertEqual(sum(row['reasonCode'] == 'trade_supply_area_conflict' for row in conflict['holds']), 2)

    def test_decimal_boundaries_do_not_depend_on_context_rounding(self):
        self.sales_only()
        self.area('100')
        self.rows(SALE, [self.sale_row('inside'), self.sale_row('outside')])
        self.complex('inside')
        self.complex('outside')
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {('합성 inside', '84.00'): ('inside', '105'),
                                   ('합성 outside', '84.00'): ('outside', '105.' + '0' * 19 + '1')})
        with localcontext(Context(prec=2)):
            result = self.compare(ingestion=ingestion)
        self.assertEqual([row['complexId'] for row in result['comparables']], ['inside'])
        self.assertEqual(result['completeness'], 'complete')
        self.assertIn('outside_supply_area', {row['reasonCode'] for row in result['exclusions']})

    def test_area_and_user_tolerance_follow_the_be02_decimal_length(self):
        self.evidence['tradeLinks'][0]['supplyAreaM2'] = '112.' + '4' * 21
        result = self.compare({'areaTolerancePercent': '5.' + '0' * 22 + '1', 'areaChangeConfirmed': True})
        self.assertEqual([row['complexId'] for row in result['comparables']], ['comparison-b'])
        self.assertEqual(result['conditions']['area']['tolerancePercent'], '5')
        self.assertTrue({'area_tolerance_invalid', 'trade_supply_area_unverified'}
                        <= {row['reasonCode'] for row in result['holds']})
        accepted = '5.' + '0' * 21 + '1'
        self.assertEqual(self.compare({'areaTolerancePercent': accepted, 'areaChangeConfirmed': True})
                         ['conditions']['area']['tolerancePercent'], accepted)

    def test_closest_area_only_and_equal_observations_keep_their_locations(self):
        self.sales_only()
        self.area('100')
        self.complex('nearest')
        closer = self.sale_row('nearest', excluUseAr='81', dealAmount='987654321012345')
        further = self.sale_row('nearest', excluUseAr='84', dealAmount='12345')
        self.rows(SALE, [closer, copy.deepcopy(closer), further, dict(further, dealDay='22')])
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {('합성 nearest', '81'): ('nearest', '101'),
                                   ('합성 nearest', '84'): ('nearest', '104')})
        row = self.compare(ingestion=ingestion)['comparables'][0]
        self.assertEqual(Decimal(row['supplyAreaM2']), Decimal('101'))
        self.assertEqual(Decimal(row['areaDifferenceM2']), Decimal('1'))
        stats = row['tradeStats']['sale']
        self.assertEqual((stats['medianWon'], stats['count'], stats['smallSample']), ('9876543210123450000', 2, True))
        self.assertEqual([(obs['page'], obs['position']) for obs in stats['observations']], [(1, 1), (1, 2)])
        self.evidence['tradeLinks'][2]['supplyAreaM2'] = '99'
        self.evidence['tradeLinks'][3]['supplyAreaM2'] = '99'
        tied = self.compare(ingestion=ingestion)
        self.assertIsNone(tied['regionDecision']['expansion'])
        self.assertFalse(tied['comparables'])
        self.assertIn('D-03', {hold.get('decisionId') for hold in tied['holds']})

    def test_kind_zero_uses_the_selected_area_of_each_complex(self):
        self.evidence['tradeLinks'][0]['supplyAreaM2'] = '112.400'
        for link in self.evidence['tradeLinks'][1:]:
            link.update(complexId='comparison-a', supplyAreaM2='112.0')
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

    def test_distance_only_breaks_area_ties_and_manual_replacement_is_bounded(self):
        self.sales_only()
        self.area('100')
        cases = [('best-far', '100', '37.700'), ('close', '101', '37.501'), ('far', '101', '37.502'),
                 ('fourth', '102', '37.501'), ('fifth', '103', '37.501'), ('sixth', '104', '37.501'),
                 ('bad-area', '106', '37.501'), ('out-region', '100', '37.501')]
        self.region()
        self.rows(SALE, [self.sale_row(name, **({'umdCd': '00200', 'umdNm': '별빛동'} if name == 'out-region' else {}))
                         for name, _, _ in cases])
        for name, _, latitude in cases:
            self.complex(name, OTHER_DONG if name == 'out-region' else PRIORITY, latitude)
        ingestion = replay(self.bundle)
        self.link_sales(ingestion, {(f'합성 {name}', '84.00'): (name, area) for name, area, _ in cases})
        result = self.compare(ingestion=ingestion)
        order = ['best-far', 'close', 'far', 'fourth', 'fifth']
        self.assertEqual([row['complexId'] for row in result['comparables']], order)
        best, close = result['comparables'][:2]
        self.assertEqual(close['distance']['kind'], 'straight_line')
        self.assertGreater(best['distance']['meters'], 5000)
        self.assertLess(close['distance']['meters'], best['distance']['meters'])
        replaced = self.compare({'replacements': [{'complexId': 'sixth', 'replaceComplexId': 'far'}]}, ingestion)
        self.assertEqual([row['complexId'] for row in replaced['comparables']], ['best-far', 'close', 'sixth', 'fourth', 'fifth'])
        for identifier in ('bad-area', 'out-region', 'unknown'):
            failure = self.compare({'replacements': [{'complexId': identifier, 'replaceComplexId': 'far'}]}, ingestion)
            self.assertEqual([row['complexId'] for row in failure['comparables']], order)
            self.assertIn('replacement_candidate_ineligible', {item['reasonCode'] for item in failure['holds']})
        unclear = self.compare({'replacements': [{'complexId': 'sixth'}]}, ingestion)
        self.assertEqual([row['complexId'] for row in unclear['comparables']], order)
        self.assertIn('replacement_target_required', {item['reasonCode'] for item in unclear['holds']})
        del self.evidence['complexes'][4]['coordinates']  # 'close' shares an area difference with 'far'.
        tied = self.compare(ingestion=ingestion)
        self.assertIsNone(tied['comparables'][1]['rank'])
        self.assertEqual(tied['comparables'][0]['rank'], 1)
        self.assertIn('D-03', {item.get('decisionId') for item in tied['holds']})
        self.evidence['tradeLinks'][-3]['supplyAreaM2'] = '103'  # 'sixth' ties at the fifth slot.
        cutoff = self.compare(ingestion=ingestion)
        self.assertEqual(len(cutoff['comparables']), 4)

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


if __name__ == '__main__':
    unittest.main()
