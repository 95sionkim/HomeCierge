"""출퇴근 출발지 추출 합성 사례표가 complex_coordinates.py(Q-39)의 규칙과 일치하는지 확인한다."""
import json
import unittest
from pathlib import Path

from complex_coordinates import (
    extract_parcel_spec,
    extract_road_spec,
    is_ambiguous_area_address,
    strip_parenthetical_notes,
)

FIXTURE = Path(__file__).resolve().parents[1] / 'tests' / 'fixtures' / 'commute-origin-cases.json'


class CommuteOriginParityTests(unittest.TestCase):
    def test_shared_commute_origin_cases_match_complex_coordinates(self):
        payload = json.loads(FIXTURE.read_text(encoding='utf-8'))
        self.assertEqual(payload['dataOrigin'], 'synthetic')
        self.assertGreaterEqual(len(payload['cases']), 15)
        for item in payload['cases']:
            case_id = item['id']
            address = item['noticeAddress']
            with self.subTest(case=case_id):
                self.assertEqual(strip_parenthetical_notes(address), item['stripped'])
                self.assertEqual(is_ambiguous_area_address(address), item['ambiguous'])
                self.assertEqual(extract_road_spec(address), item['road'])
                self.assertEqual(extract_parcel_spec(address), item['parcel'])


if __name__ == '__main__':
    unittest.main()
