#!/usr/bin/env python3
"""5/48건 구조의 합성 자료와 경계 사례로 불완전 거래 수집 차단을 검증한다."""
import json
import unittest

from collect_recent_trades import assess_month, months_between, normalize
from probe_apis import ROOT, api_error, response_status, run_probe, sanitize

SPEC = json.loads((ROOT / 'docs/api/probes.json').read_text())['probes']['apt_trade']
PAYLOAD = json.loads((ROOT / 'tests/fixtures/apt_trade_page.json').read_text())
ROW = PAYLOAD['response']['body']['items']['item'][0]


def fixture(rows, total, page=1, size=5):
    return {'response': {'header': {'resultCode': '000'}, 'body': {
        'items': {'item': rows}, 'totalCount': total, 'pageNo': page, 'numOfRows': size}}}


class CollectionTests(unittest.TestCase):
    def test_synthetic_partial_response_is_rejected(self):
        state, rows = assess_month([({'status': 'success'}, PAYLOAD)])
        self.assertEqual((state['collected'], state['reported_total']), (5, 48))
        self.assertFalse(state['complete'])

    def test_complete_two_page_snapshot(self):
        pages = [({'status': 'success'}, fixture([{'id': i} for i in range(5)], 6)),
                 ({'status': 'success'}, fixture([{'id': 5}], 6, page=2))]
        self.assertTrue(assess_month(pages)[0]['complete'])

    def test_changed_total_is_rejected(self):
        pages = [({'status': 'success'}, fixture([{'id': i} for i in range(5)], 6)),
                 ({'status': 'success'}, fixture([{'id': 5}, {'id': 6}], 7, page=2))]
        self.assertIn('total_changed_during_collection', assess_month(pages)[0]['problems'])

    def test_repeated_page_is_rejected(self):
        page = ({'status': 'success'}, fixture([{'id': i} for i in range(5)], 10))
        self.assertIn('repeated_page', assess_month([page, page])[0]['problems'])

    def test_normal_zero_records(self):
        payload = fixture([], 0)
        self.assertEqual(response_status(payload, SPEC), 'success_empty')
        self.assertTrue(assess_month([({'status': 'success_empty'}, payload)])[0]['complete'])

    def test_unmapped_payload_is_not_empty_success(self):
        self.assertEqual(response_status({'unexpected': []}, SPEC), 'empty_or_unmapped')
        self.assertEqual(response_status(fixture([], 48), SPEC), 'empty_or_unmapped')

    def test_root_header_error_is_detected(self):
        self.assertIsNotNone(api_error({'header': {'resultCode': '30'}, 'body': {}}))

    def test_network_failure_is_not_complete(self):
        state, _ = assess_month([({'status': 'network_error'}, None)])
        self.assertFalse(state['complete'])

    def test_amount_unit(self):
        result = normalize(ROW, '202609', '11215', 'apt_trade')
        self.assertEqual(result['price_krw'], 480000000)
        self.assertEqual(result['exclusive_area_m2'], '58.43')
        self.assertTrue(result['eligible_for_comparison_after_matching'])

    def test_cancelled_trade_is_excluded(self):
        for change in [{'cdealType': 'Y'}, {'cdealDay': '26.10.01'}]:
            result = normalize({**ROW, **change}, '202609', '11215', 'apt_trade')
            self.assertEqual(result['cancellation_status'], 'cancelled')
            self.assertFalse(result['eligible_for_comparison_after_matching'])

    def test_unknown_cancellation_is_not_usable(self):
        result = normalize({**ROW, 'cdealType': '?'}, '202609', '11215', 'apt_trade')
        self.assertFalse(result['eligible_for_comparison_after_matching'])

    def test_o_cancellation_is_excluded(self):
        row = {**ROW, 'sggCd': '41210', 'cdealType': 'O', 'ownershipGbn': '입'}
        result = normalize(row, '202609', '41210', 'apt_rights')
        self.assertEqual(result['cancellation_status'], 'cancelled')
        self.assertFalse(result['eligible_for_comparison_after_matching'])

    def test_rights_explicit_blank_differs_from_missing(self):
        for value, expected in [('', 'presale_right'), (' ', 'presale_right'), ('입', 'occupancy_right')]:
            result = normalize({**ROW, 'ownershipGbn': value}, '202609', '11215', 'apt_rights')
            self.assertEqual(result['rights_type'], expected)
            self.assertTrue(result['eligible_for_comparison_after_matching'])
        for change in [{}, {'ownershipGbn': None}, {'ownershipGbn': '?'}]:
            result = normalize({**ROW, **change}, '202609', '11215', 'apt_rights')
            self.assertIsNone(result['rights_type'])
            self.assertFalse(result['eligible_for_comparison_after_matching'])

    def test_bad_price_and_date_are_not_usable(self):
        result = normalize({**ROW, 'dealAmount': 'NaN', 'dealDay': '32'}, '202609', '11215', 'apt_trade')
        self.assertIsNone(result['price_krw'])
        self.assertIn('invalid_contract_date', result['issues'])
        self.assertFalse(result['eligible_for_comparison_after_matching'])

    def test_month_boundary(self):
        months = months_between('202511', '202610')
        self.assertEqual(len(months), 12)
        self.assertEqual(months[:3], ['202511', '202512', '202601'])
        with self.assertRaises(ValueError):
            months_between('202613', '202701')

    def test_auth_values_are_never_request_overrides(self):
        result, _, _ = run_probe('apt_trade', SPEC, {}, {'serviceKey': 'fake-secret'})
        self.assertEqual(result['status'], 'invalid_params')
        self.assertNotIn('fake-secret', json.dumps(result))

    def test_law_body_requires_version_inputs_without_network(self):
        spec = json.loads((ROOT / 'docs/api/probes.json').read_text())['probes']['law_body']
        result, _, _ = run_probe('law_body', spec, {'LAW_OC': 'test'}, {'MST': '123'})
        self.assertEqual(result['status'], 'missing_request_params')

    def test_encoded_secret_sanitization(self):
        self.assertNotIn('abc', sanitize('https://example.invalid/?serviceKey=abc%2F123', {'K': 'abc/123'}))


if __name__ == '__main__':
    unittest.main()
