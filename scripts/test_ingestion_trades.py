#!/usr/bin/env python3
"""BE-02 거래 정규화·계약일 범위의 경계 검사. 모든 행은 합성 자료이며 네트워크·인증값을 쓰지 않는다."""
import copy
import json
import unittest
from pathlib import Path

from collect_recent_trades import normalize as reference_normalize
from ingestion_trades import PENDING_REASONS, normalize_trade, trade_period

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROWS = json.loads((ROOT / 'tests/fixtures/apt_trade_page.json').read_text(encoding='utf-8'))[
    'response']['body']['items']['item']

# 합성 매매·권리 행(실제 거래가 아님).
SALE = {'aptNm': '합성테스트아파트', 'aptSeq': 'SYNTHETIC-0000', 'sggCd': '11215', 'umdCd': '10300',
        'umdNm': '구의동', 'jibun': '999-1', 'landCd': '1', 'bonbun': '0999', 'bubun': '0001',
        'dealAmount': '48,000', 'excluUseAr': '58.43', 'dealYear': '2026', 'dealMonth': '9',
        'dealDay': '15', 'floor': '4', 'buildYear': '2000', 'cdealType': '', 'cdealDay': ''}
RIGHTS = {'aptNm': '합성권리아파트', 'sggCd': '11215', 'sggNm': '합성구', 'umdNm': '구의동', 'jibun': '1',
          'dealAmount': '40,500', 'excluUseAr': '82.50', 'dealYear': '2026', 'dealMonth': '9',
          'dealDay': '24', 'floor': '5', 'cdealType': '', 'cdealDay': '', 'ownershipGbn': '',
          'dealingGbn': '중개거래'}
PERIOD = trade_period('2026-11-10')
ALL_KINDS = ['sale', 'presale_right', 'occupancy_right']


def run(row, source='apt_trade', month='202609', kinds=None, period=PERIOD, page=1, position=1, region='11215'):
    kinds = kinds or (['sale'] if source == 'apt_trade' else ['presale_right', 'occupancy_right'])
    return normalize_trade(source, {'row': row, 'page': page, 'position': position}, region, month, period, kinds)


def without(row, *fields):
    return {key: value for key, value in row.items() if key not in fields}


def codes(result):
    return [issue['code'] for issue in result['issues']]


class TradePeriodTests(unittest.TestCase):
    def test_agreed_default_example_spans_thirteen_months_with_current_month(self):
        period = trade_period('2026-11-10')
        self.assertEqual((period['status'], period['source']), ('confirmed', 'default_recent_year'))
        self.assertEqual((period['start'], period['end'], period['bounds']), ('2025-11-11', '2026-11-10', 'inclusive'))
        self.assertEqual(len(period['months']), 13)
        self.assertEqual((period['months'][0], period['months'][-1]), ('202511', '202611'))
        self.assertEqual(period['inProgressMonth'], '202611')
        self.assertIsNone(period['decision'])
        self.assertEqual(json.loads(json.dumps(period, allow_nan=False)), period)

    def test_evidence_document_example(self):
        period = trade_period('2026-11-21')
        self.assertEqual((period['start'], period['end'], len(period['months'])), ('2025-11-22', '2026-11-21', 13))

    def test_leap_day_basis_is_held_without_values(self):
        period = trade_period('2028-02-29')
        self.assertEqual((period['status'], period['source']), ('decision_required', 'default_recent_year'))
        self.assertEqual(period['decision'], {'decisionId': 'D-02', 'reasonCode': 'basis_date_is_leap_day'})
        self.assertEqual((period['start'], period['end'], period['months'], period['inProgressMonth']),
                         (None, None, None, None))

    def test_default_range_is_held_when_calendar_year_and_365_days_differ(self):
        # 2025-02-28: 달력 1년은 2024-02-29, 고정 365일은 2024-03-01부터다.
        for basis in ('2025-02-28', '2024-03-01', '2028-03-01', '2028-12-31'):
            period = trade_period(basis)
            self.assertEqual(period['status'], 'decision_required', basis)
            self.assertEqual(period['decision']['reasonCode'], 'calendar_year_and_365_day_starts_differ')
            self.assertIsNone(period['start'])

    def test_non_leap_boundaries_where_both_methods_agree_proceed(self):
        for basis, start, months in [('2025-03-01', '2024-03-02', 13), ('2024-02-28', '2023-03-01', 12),
                                     ('2027-02-28', '2026-03-01', 12), ('2029-03-01', '2028-03-02', 13),
                                     ('2026-01-01', '2025-01-02', 13), ('2025-12-31', '2025-01-01', 12)]:
            period = trade_period(basis)
            self.assertEqual((period['status'], period['start'], period['end']), ('confirmed', start, basis))
            self.assertEqual(len(period['months']), months, basis)

    def test_explicit_range_is_used_even_on_leap_basis(self):
        period = trade_period('2028-02-29', '2027-03-01', '2028-02-29')
        self.assertEqual((period['status'], period['source']), ('confirmed', 'user_confirmed'))
        self.assertEqual((period['months'][0], period['months'][-1], len(period['months'])), ('202703', '202802', 12))
        self.assertEqual(period['inProgressMonth'], '202802')
        past = trade_period('2026-11-10', '2026-10-01', '2026-10-31')
        self.assertEqual((past['months'], past['inProgressMonth']), (['202610'], None))
        single = trade_period('2026-11-10', '2026-11-10', '2026-11-10')
        self.assertEqual(single['months'], ['202611'])

    def test_invalid_reversed_future_and_partial_ranges_raise(self):
        bad = [('2026-11-10', '2026-10-31', '2026-10-01'), ('2026-11-10', '2026-11-01', '2026-11-11'),
               ('2026-11-10', '2026-11-01', None), ('2026-11-10', None, '2026-11-01'),
               ('2026-11-10', '2026-02-30', '2026-03-01'), ('2026-11-10', '2026-1-01', '2026-03-01'),
               ('2026-11-10', '', '2026-03-01')]
        for args in bad:
            with self.assertRaises(ValueError, msg=args):
                trade_period(*args)

    def test_basis_date_is_required_and_strict(self):
        for basis in (None, '', '20261110', '2026-11-1', '2026-13-01', '2027-02-29', '２０２６-11-10',
                      '2026-11-10\n', True, 20261110, '0001-06-01'):
            with self.assertRaises(ValueError, msg=repr(basis)):
                trade_period(basis)


class NormalizeTradeTests(unittest.TestCase):
    def test_synthetic_sale_row_is_normalized_but_not_approved(self):
        result = run(SALE)
        self.assertEqual(result['disposition'], 'follow_up_required')
        self.assertEqual((result['exclusionReason'], result['exclusionReasons'], result['issues']), (None, [], []))
        self.assertEqual(result['pendingReasons'], list(PENDING_REASONS))
        self.assertEqual(result['tradeKind'], 'sale')
        self.assertEqual(result['provenance'], {'source': 'apt_trade', 'request': {'LAWD_CD': '11215', 'DEAL_YMD': '202609'},
                                                'page': 1, 'position': 1})
        self.assertEqual(result['amount']['won'], '480000000')
        self.assertEqual((result['amount']['sourceRaw'], result['amount']['sourceAmount'], result['amount']['sourceUnit']),
                         ('48,000', '48000', 'man_won'))
        self.assertEqual(result['contractDate']['date'], '2026-09-15')
        self.assertEqual(result['cancellation']['status'], 'not_marked')
        self.assertEqual({key: check['status'] for key, check in result['checks'].items()},
                         {'requestRegion': 'match', 'requestMonth': 'match', 'contractPeriod': 'inside', 'tradeKind': 'included'})
        self.assertNotIn('raw', result)
        self.assertEqual(result['withheldFields'], [])
        text = json.dumps(result, ensure_ascii=False, allow_nan=False)
        for marker in ('eligible', 'approved', 'Approved'):
            self.assertNotIn(marker, text)

    def test_exclusive_area_is_never_used_as_supply_area(self):
        result = run(SALE)
        self.assertEqual(result['exclusiveArea'], {'status': 'parsed', 'basis': 'exclusive', 'm2': '58.43',
                                                   'sourceField': 'excluUseAr', 'sourceRaw': '58.43'})
        self.assertEqual(result['supplyArea'], {'status': 'unverified', 'basis': 'supply', 'm2': None,
                                                'reasonCode': 'supply_area_correspondence_missing'})
        self.assertIn('supply_area_correspondence_missing', result['pendingReasons'])

    def test_duplicate_rows_are_kept_with_their_positions(self):
        results = [run(dict(SALE), page=2, position=position) for position in (1, 2)]
        self.assertEqual([r['provenance']['position'] for r in results], [1, 2])
        strip = [{k: v for k, v in r.items() if k != 'provenance'} for r in results]
        self.assertEqual(strip[0], strip[1])

    def test_input_row_is_not_mutated(self):
        row = copy.deepcopy(SALE)
        run(row)
        self.assertEqual(row, SALE)

    def test_amount_boundaries(self):
        for raw, won in [('48000', '480000000'), (' 48,000 ', '480000000'), (48000, '480000000'),
                         ('1,234,567', '12345670000'), ('1', '10000')]:
            result = run({**SALE, 'dealAmount': raw})
            self.assertEqual((result['amount']['status'], result['amount']['won']), ('parsed', won), raw)
        for raw in ['NaN', 'Infinity', '-48,000', '0', '4,8000', '48,00', ',48000', '48.5', '1e5', '048000',
                    '４８０００', True, False, 48000.0, float('nan'), -5, 0, '12345678901234567', ['48000']]:
            result = run({**SALE, 'dealAmount': raw})
            self.assertEqual((result['amount']['status'], result['amount']['won']), ('invalid', None), repr(raw))
            self.assertEqual((result['disposition'], codes(result)), ('held', ['amount_invalid']), repr(raw))
            json.dumps(result, allow_nan=False)
        nested = run({**SALE, 'dealAmount': {'value': '48,000'}})
        self.assertEqual((nested['amount']['sourceRaw'], nested['issues'][0].get('detail')), (None, 'non_scalar_value'))
        for row in [without(SALE, 'dealAmount'), {**SALE, 'dealAmount': None}, {**SALE, 'dealAmount': '  '}]:
            result = run(row)
            self.assertEqual((result['amount']['status'], codes(result)), ('missing', ['amount_missing']))

    def test_area_boundaries(self):
        for raw, m2 in [('84.970', '84.970'), (' 59.9 ', '59.9'), (84.97, '84.97'), (60, '60'), ('0.5', '0.5')]:
            self.assertEqual(run({**SALE, 'excluUseAr': raw})['exclusiveArea']['m2'], m2)
        for raw in ['0', '0.0', '-1', 'NaN', 'inf', '84,97', '84.', '.5', True, float('inf'), 0, 1e300]:
            result = run({**SALE, 'excluUseAr': raw})
            self.assertEqual((result['exclusiveArea']['status'], codes(result)), ('invalid', ['exclusive_area_invalid']), repr(raw))
        self.assertEqual(codes(run(without(SALE, 'excluUseAr'))), ['exclusive_area_missing'])

    def test_contract_date_boundaries(self):
        self.assertEqual(run({**SALE, 'dealYear': 2026, 'dealMonth': 9, 'dealDay': 5})['contractDate']['date'], '2026-09-05')
        self.assertEqual(run({**SALE, 'dealMonth': '09', 'dealDay': '05'})['contractDate']['date'], '2026-09-05')
        for change in [{'dealDay': '32'}, {'dealDay': '31'}, {'dealMonth': '13'}, {'dealMonth': '2', 'dealDay': '29'},
                       {'dealYear': '26'}, {'dealYear': 26}, {'dealDay': True}, {'dealDay': 15.0}, {'dealDay': '-1'},
                       {'dealDay': '１５'}, {'dealDay': '015'}]:
            result = run({**SALE, **change})
            self.assertEqual((result['contractDate']['status'], result['contractDate']['date']), ('invalid', None), change)
            self.assertEqual(result['checks']['contractPeriod']['status'], 'not_evaluated')
            self.assertEqual((result['disposition'], codes(result)), ('held', ['contract_date_invalid']), change)
        for row in [without(SALE, 'dealDay'), {**SALE, 'dealMonth': ''}, {**SALE, 'dealYear': None}]:
            self.assertEqual(codes(run(row)), ['contract_date_missing'])

    def test_contract_period_is_inclusive_at_both_ends(self):
        inside_start = run({**SALE, 'dealYear': '2025', 'dealMonth': '11', 'dealDay': '11'}, month='202511')
        before_start = run({**SALE, 'dealYear': '2025', 'dealMonth': '11', 'dealDay': '10'}, month='202511')
        inside_end = run({**SALE, 'dealMonth': '11', 'dealDay': '10'}, month='202611')
        after_end = run({**SALE, 'dealMonth': '11', 'dealDay': '11'}, month='202611')
        self.assertEqual([r['checks']['contractPeriod']['status'] for r in (inside_start, before_start, inside_end, after_end)],
                         ['inside', 'outside', 'inside', 'outside'])
        self.assertEqual([r['disposition'] for r in (inside_start, before_start, inside_end, after_end)],
                         ['follow_up_required', 'excluded', 'follow_up_required', 'excluded'])
        self.assertEqual(before_start['exclusionReason'], 'outside_contract_period')
        self.assertEqual(before_start['pendingReasons'], [])

    def test_proven_exclusion_is_not_overturned_by_other_missing_values(self):
        outside = run({**without(SALE, 'cdealType', 'dealAmount', 'sggCd'), 'dealYear': '2025', 'dealMonth': '11',
                       'dealDay': '1'}, month='202511')
        self.assertEqual((outside['disposition'], outside['exclusionReasons']), ('excluded', ['outside_contract_period']))
        self.assertEqual(codes(outside), ['amount_missing', 'request_region_missing', 'cancellation_status_unknown'])
        cancelled = run({**without(SALE, 'dealAmount', 'excluUseAr'), 'cdealType': 'O', 'dealDay': '40'})
        self.assertEqual((cancelled['disposition'], cancelled['exclusionReasons']), ('excluded', ['cancelled_trade']))
        self.assertIn('contract_date_invalid', codes(cancelled))
        rights = run(without(RIGHTS, 'ownershipGbn', 'dealAmount'), source='apt_rights', kinds=['sale'])
        self.assertEqual((rights['disposition'], rights['exclusionReasons']), ('excluded', ['trade_kind_not_included']))
        self.assertEqual(rights['tradeKind'], None)
        self.assertIn('rights_type_unknown', codes(rights))

    def test_multiple_exclusions_have_a_deterministic_primary_reason(self):
        result = run({**SALE, 'cdealType': 'O', 'dealYear': '2025', 'dealMonth': '11', 'dealDay': '1'},
                     month='202511', kinds=['presale_right'])
        self.assertEqual(result['exclusionReasons'], ['outside_contract_period', 'cancelled_trade', 'trade_kind_not_included'])
        self.assertEqual(result['exclusionReason'], 'outside_contract_period')

    def test_cancellation_uses_only_the_agreed_marks(self):
        for change, evidence in [({'cdealType': 'O'}, ['cdealType']), ({'cdealType': ' O '}, ['cdealType']),
                                 ({'cdealDay': '26.10.29'}, ['cdealDay']), ({'cdealDay': '2026-10-29'}, ['cdealDay']),
                                 ({'cdealDay': '28.02.29'}, ['cdealDay']),
                                 ({'cdealType': 'O', 'cdealDay': '26.10.29'}, ['cdealType', 'cdealDay']),
                                 ({'cdealType': 'Y', 'cdealDay': '26.10.29'}, ['cdealDay']),
                                 ({'cdealType': None, 'cdealDay': '26.10.29'}, ['cdealDay'])]:
            result = run({**SALE, **change})
            self.assertEqual((result['cancellation']['status'], result['cancellation']['evidence']), ('cancelled', evidence), change)
            self.assertEqual(result['exclusionReasons'], ['cancelled_trade'])
            self.assertEqual(result['cancellation']['cdealDay']['raw'], change.get('cdealDay', ''))
            self.assertEqual(codes(result), [])
        unknown = [({'cdealType': 'Y'}, 'cancellation_type_unrecognized'),
                   ({'cdealType': 'N'}, 'cancellation_type_unrecognized'),
                   ({'cdealType': 'o'}, 'cancellation_type_unrecognized'),
                   ({'cdealType': 1}, 'cancellation_type_unrecognized'),
                   ({'cdealType': ['O']}, 'cancellation_type_unrecognized'),
                   ({'cdealType': None}, 'cancellation_field_absent_or_null'),
                   ({'cdealDay': None}, 'cancellation_field_absent_or_null'),
                   ({'cdealDay': 261029}, 'cancellation_date_unrecognized'),
                   ({'cdealDay': '-'}, 'cancellation_date_unrecognized'),
                   ({'cdealDay': '해제'}, 'cancellation_date_unrecognized'),
                   ({'cdealDay': '26.13.01'}, 'cancellation_date_unrecognized'),
                   ({'cdealDay': '27.02.29'}, 'cancellation_date_unrecognized'),
                   ({'cdealDay': '2026-02-30'}, 'cancellation_date_unrecognized'),
                   ({'cdealDay': '20261029'}, 'cancellation_date_unrecognized'),
                   ({'cdealDay': '26.10.29 ?'}, 'cancellation_date_unrecognized'),
                   ({'cdealDay': {'d': '26.10.29'}}, 'cancellation_date_unrecognized')]
        for change, detail in unknown:
            result = run({**SALE, **change})
            self.assertEqual((result['cancellation']['status'], result['disposition']), ('unknown', 'held'), change)
            self.assertEqual(result['issues'], [{'code': 'cancellation_status_unknown', 'category': 'unknown_state',
                                                 'fields': ['cdealType', 'cdealDay'], 'detail': detail}], change)
            self.assertEqual(result['exclusionReasons'], [])
        garbled = run({**SALE, 'cdealDay': '-'})
        self.assertEqual(garbled['cancellation']['cdealDay'], {'state': 'unrecognized', 'raw': '-'})
        nested = run({**SALE, 'cdealDay': {'d': '26.10.29'}})
        self.assertEqual(nested['cancellation']['cdealDay'], {'state': 'non_scalar', 'raw': None})
        for value, state in [('-', 'unrecognized'), ({'d': 1}, 'non_scalar')]:
            marked = run({**SALE, 'cdealType': 'O', 'cdealDay': value})
            self.assertEqual((marked['disposition'], marked['exclusionReason']), ('excluded', 'cancelled_trade'))
            self.assertEqual(marked['cancellation']['evidence'], ['cdealType'])
            self.assertEqual(marked['issues'], [{'code': 'cancellation_date_unrecognized', 'category': 'unknown_state',
                                                 'fields': ['cdealDay'], 'detail': state}])
        for fields in [('cdealType',), ('cdealDay',), ('cdealType', 'cdealDay')]:
            result = run(without(SALE, *fields))
            self.assertEqual((result['cancellation']['status'], result['disposition']), ('unknown', 'held'), fields)
            self.assertEqual(result['cancellation'][fields[0]]['state'], 'absent')
        explicit = run({**SALE, 'cdealType': ' ', 'cdealDay': ''})
        self.assertEqual((explicit['cancellation']['status'], explicit['disposition']), ('not_marked', 'follow_up_required'))

    def test_rights_type_distinguishes_absent_null_blank_and_occupancy_mark(self):
        for value, kind, state in [('', 'presale_right', 'explicit_blank'), ('  ', 'presale_right', 'explicit_blank'),
                                   ('입', 'occupancy_right', 'occupancy_mark'), (' 입 ', 'occupancy_right', 'occupancy_mark')]:
            result = run({**RIGHTS, 'ownershipGbn': value}, source='apt_rights')
            self.assertEqual((result['tradeKind'], result['tradeKindBasis']['state'], result['disposition']),
                             (kind, state, 'follow_up_required'), value)
            self.assertEqual(result['tradeKindBasis']['raw'], value)
        for row, state in [(without(RIGHTS, 'ownershipGbn'), 'field_absent'), ({**RIGHTS, 'ownershipGbn': None}, 'null_value'),
                           ({**RIGHTS, 'ownershipGbn': '?'}, 'unrecognized'), ({**RIGHTS, 'ownershipGbn': '입주권'}, 'unrecognized'),
                           ({**RIGHTS, 'ownershipGbn': 0}, 'unrecognized')]:
            result = run(row, source='apt_rights')
            self.assertEqual((result['tradeKind'], result['tradeKindBasis']['state']), (None, state))
            self.assertEqual((result['disposition'], result['checks']['tradeKind']['status']), ('held', 'not_evaluated'))
            self.assertEqual(result['issues'], [{'code': 'rights_type_unknown', 'category': 'unknown_state',
                                                 'fields': ['ownershipGbn'], 'detail': state}])
            one_kind = run(row, source='apt_rights', kinds=['presale_right'])
            self.assertEqual(one_kind['disposition'], 'held')

    def test_trade_kind_selection_excludes_other_kinds(self):
        occupancy = run({**RIGHTS, 'ownershipGbn': '입'}, source='apt_rights', kinds=['presale_right'])
        self.assertEqual((occupancy['disposition'], occupancy['exclusionReason']), ('excluded', 'trade_kind_not_included'))
        presale = run(RIGHTS, source='apt_rights', kinds=['occupancy_right'])
        self.assertEqual(presale['exclusionReason'], 'trade_kind_not_included')
        sale = run(SALE, kinds=['presale_right', 'occupancy_right'])
        self.assertEqual(sale['exclusionReason'], 'trade_kind_not_included')
        both = run(RIGHTS, source='apt_rights', kinds=ALL_KINDS)
        self.assertEqual((both['checks']['tradeKind']['selected'], both['disposition']), (ALL_KINDS, 'follow_up_required'))

    def test_request_region_and_month_mismatches_are_held_not_excluded(self):
        region = run({**SALE, 'sggCd': '11230'})
        self.assertEqual((region['disposition'], region['checks']['requestRegion']['status']), ('held', 'mismatch'))
        self.assertEqual(region['issues'], [{'code': 'request_region_mismatch', 'category': 'request_mismatch', 'fields': ['sggCd']}])
        month = run({**SALE, 'dealMonth': '10', 'dealDay': '1'})
        self.assertEqual((month['disposition'], codes(month)), ('held', ['request_month_mismatch']))
        self.assertEqual(month['checks']['requestMonth'], {'status': 'mismatch', 'requested': '202609', 'observed': '202610'})
        self.assertEqual(month['exclusionReasons'], [])
        for value, code in [(None, 'request_region_missing'), ('', 'request_region_missing'), (11215, 'request_region_invalid'),
                            ('1121', 'request_region_invalid'), ('11215-1', 'request_region_invalid')]:
            self.assertEqual(codes(run({**SALE, 'sggCd': value})), [code], value)
        self.assertEqual(codes(run(without(SALE, 'sggCd'))), ['request_region_missing'])
        self.assertEqual(run({**SALE, 'sggCd': ' 11215 '})['checks']['requestRegion']['status'], 'match')

    def test_source_identifiers_are_copied_without_synthesis(self):
        sale = run(SALE)
        self.assertEqual(sale['identifiers'], {key: SALE[key] for key in (
            'aptNm', 'aptSeq', 'sggCd', 'umdCd', 'umdNm', 'landCd', 'bonbun', 'bubun', 'jibun')})
        rights = run({**RIGHTS, 'umdCd': '10300', 'aptSeq': 'UNLISTED'}, source='apt_rights')
        self.assertEqual(rights['identifiers'], {key: RIGHTS[key] for key in ('aptNm', 'sggCd', 'sggNm', 'umdNm', 'jibun')})
        self.assertNotIn('10300', json.dumps(rights, ensure_ascii=False))  # 명세 밖 필드는 내보내지 않는다
        self.assertNotIn('UNLISTED', json.dumps(rights, ensure_ascii=False))
        bare = run(without(SALE, 'aptNm', 'aptSeq', 'umdCd', 'umdNm', 'jibun', 'landCd', 'bonbun', 'bubun'))
        self.assertEqual(bare['identifiers'], {'sggCd': '11215'})
        self.assertEqual(bare['disposition'], 'follow_up_required')
        self.assertIn('complex_link_pending', bare['pendingReasons'])
        self.assertEqual(rights['attributes'], {'floor': '5', 'dealingGbn': '중개거래'})

    def test_only_allowlisted_scalar_values_leave_the_normalizer(self):
        row = {**SALE, 'extra': float('nan'), 'nested': {'secretish': 'SYNTHETIC-UNLISTED-VALUE'},
               'aptSeq': {'inner': 'SYNTHETIC-NESTED-ID'}, 'jibun': ['999', '1'], 'floor': float('inf'),
               'umdNm': float('nan'), 'bonbun': 999, 'buildYear': 2000.0}
        result = run(row)
        text = json.dumps(result, ensure_ascii=False, allow_nan=False)
        for leaked in ('SYNTHETIC-UNLISTED-VALUE', 'SYNTHETIC-NESTED-ID', 'secretish', 'extra', 'nested'):
            self.assertNotIn(leaked, text)
        self.assertEqual(result['withheldFields'], ['aptSeq', 'umdNm', 'jibun', 'floor'])
        self.assertEqual((result['identifiers']['bonbun'], result['attributes']['buildYear']), (999, 2000.0))
        self.assertNotIn('aptSeq', result['identifiers'])
        self.assertEqual(result['disposition'], 'follow_up_required')
        region = run({**SALE, 'sggCd': {'code': '11215'}})
        self.assertEqual((region['checks']['requestRegion']['observed'], region['issues'][0]),
                         (None, {'code': 'request_region_invalid', 'category': 'required_value',
                                 'fields': ['sggCd'], 'detail': 'non_scalar_value'}))
        rights = run({**RIGHTS, 'ownershipGbn': {'v': '입'}}, source='apt_rights')
        self.assertEqual(rights['tradeKindBasis'], {'field': 'ownershipGbn', 'state': 'non_scalar', 'raw': None})
        self.assertEqual(rights['disposition'], 'held')
        dated = run({**SALE, 'dealDay': ['15']})
        self.assertEqual((dated['contractDate']['sourceRaw'], dated['issues'][0]['detail']),
                         ({'dealYear': '2026', 'dealMonth': '9'}, 'non_scalar_value'))

    def test_caller_contract_errors_raise(self):
        obs = {'row': SALE, 'page': 1, 'position': 1}
        held = trade_period('2028-02-29')
        cases = [
            ('apt_other', obs, '11215', '202609', PERIOD, ['sale']),
            ('apt_trade', {'row': SALE, 'page': 0, 'position': 1}, '11215', '202609', PERIOD, ['sale']),
            ('apt_trade', {'row': SALE, 'page': True, 'position': 1}, '11215', '202609', PERIOD, ['sale']),
            ('apt_trade', {'row': SALE, 'page': 1, 'position': 0}, '11215', '202609', PERIOD, ['sale']),
            ('apt_trade', {'row': SALE, 'page': 1}, '11215', '202609', PERIOD, ['sale']),
            ('apt_trade', {'row': [SALE], 'page': 1, 'position': 1}, '11215', '202609', PERIOD, ['sale']),
            ('apt_trade', obs, '1121', '202609', PERIOD, ['sale']),
            ('apt_trade', obs, 11215, '202609', PERIOD, ['sale']),
            ('apt_trade', obs, '11215', '202510', PERIOD, ['sale']),
            ('apt_trade', obs, '11215', '202612', PERIOD, ['sale']),
            ('apt_trade', obs, '11215', '2026-09', PERIOD, ['sale']),
            ('apt_trade', obs, '11215', '202609', held, ['sale']),
            ('apt_trade', obs, '11215', '202609', {**PERIOD, 'months': PERIOD['months'][1:]}, ['sale']),
            ('apt_trade', obs, '11215', '202609', {**PERIOD, 'source': 'guessed'}, ['sale']),
            ('apt_trade', obs, '11215', '202609', PERIOD, []),
            ('apt_trade', obs, '11215', '202609', PERIOD, 'sale'),
            ('apt_trade', obs, '11215', '202609', PERIOD, ['sale', 'sale']),
            ('apt_trade', obs, '11215', '202609', PERIOD, ['rent']),
        ]
        for args in cases:
            with self.assertRaises(ValueError, msg=repr(args[1:])):
                normalize_trade(*args)


class ReferenceComparisonTests(unittest.TestCase):
    """기존 collect_recent_trades.normalize와 합의된 의미가 같은지, 의도한 차이가 무엇인지 고정한다."""

    def test_agreed_conversions_match_reference(self):
        for row in FIXTURE_ROWS:
            old, new = reference_normalize(row, '202609', '11215', 'apt_trade'), run(row)
            self.assertEqual(str(old['price_krw']), new['amount']['won'])
            self.assertEqual(old['exclusive_area_m2'], new['exclusiveArea']['m2'])
            self.assertEqual(old['contract_date'], new['contractDate']['date'])
            self.assertEqual(old['apartment_id'], new['identifiers']['aptSeq'])

    def test_agreed_cancellation_and_rights_marks_match_reference(self):
        for change in [{'cdealType': 'O'}, {'cdealDay': '26.10.01'}]:
            old = reference_normalize({**SALE, **change}, '202609', '11215', 'apt_trade')
            self.assertEqual((old['cancellation_status'], run({**SALE, **change})['cancellation']['status']),
                             ('cancelled', 'cancelled'))
        for value in ['', ' ', '입']:
            old = reference_normalize({**SALE, 'ownershipGbn': value}, '202609', '11215', 'apt_rights')
            new = run({**RIGHTS, 'ownershipGbn': value}, source='apt_rights')
            self.assertEqual(old['rights_type'], new['tradeKind'])

    def test_intended_differences_from_reference(self):
        # 'Y'·'N'은 합의된 해제 표기가 아니므로 해제 또는 미표시로 단정하지 않는다.
        for value, old_status in [('Y', 'cancelled'), ('N', 'not_marked_cancelled')]:
            old = reference_normalize({**SALE, 'cdealType': value}, '202609', '11215', 'apt_trade')
            self.assertEqual(old['cancellation_status'], old_status)
            self.assertEqual(run({**SALE, 'cdealType': value})['cancellation']['status'], 'unknown')
        # 기존 도구는 쉼표 위치를 확인하지 않고 사전 자격 플래그를 둔다. 새 결과에는 승인 플래그가 없다.
        old = reference_normalize({**SALE, 'dealAmount': '4,8000'}, '202609', '11215', 'apt_trade')
        self.assertEqual(old['price_krw'], 480000000)
        self.assertEqual(run({**SALE, 'dealAmount': '4,8000'})['amount']['status'], 'invalid')
        self.assertTrue(reference_normalize(SALE, '202609', '11215', 'apt_trade')['eligible_for_comparison_after_matching'])
        self.assertEqual(run(SALE)['disposition'], 'follow_up_required')
        # 기존 기본 기간은 완료된 12개월이다. 현행 기본 기간은 진행 중인 당월을 포함한 13개 계약월이다.
        self.assertEqual(len(trade_period('2026-11-10')['months']), 13)


if __name__ == '__main__':
    unittest.main()
