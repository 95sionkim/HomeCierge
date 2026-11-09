#!/usr/bin/env python3
"""같은 지번의 다른 지역, 산번지, 모호한 좌표 결과의 잘못된 연결을 차단한다."""
import unittest

from validate_comparable_links import distance_m, parcel_from_kakao, parcel_from_kapt, parcel_from_trade, unique_geocode, road_from_kapt, road_identity


class LinkTests(unittest.TestCase):
    def setUp(self):
        self.trade = {'sggCd': '11215', 'umdCd': '10300', 'landCd': '1', 'bonbun': '0592', 'bubun': '0039'}
        self.geo = {'address': {'b_code': '1121510300', 'mountain_yn': 'N', 'main_address_no': '592', 'sub_address_no': '39'}}

    def test_leading_zero_numbers_join_across_sources(self):
        basic = {'bjdCode': '1121510300', 'kaptAddr': '서울특별시 광진구 구의동 592-39 별도표기단지'}
        self.assertEqual(parcel_from_trade(self.trade), parcel_from_kakao(self.geo))
        self.assertEqual(parcel_from_trade(self.trade), parcel_from_kapt(basic))

    def test_same_name_and_lot_in_other_district_do_not_join(self):
        other = {'address': {**self.geo['address'], 'b_code': '1174010300'}}
        self.assertIsNone(unique_geocode([other], parcel_from_trade(self.trade)))

    def test_mountain_and_normal_lot_are_different(self):
        mountain = {'address': {**self.geo['address'], 'mountain_yn': 'Y'}}
        self.assertIsNone(unique_geocode([mountain], parcel_from_trade(self.trade)))

    def test_duplicate_matching_geocodes_are_ambiguous(self):
        self.assertIsNone(unique_geocode([self.geo, self.geo], parcel_from_trade(self.trade)))

    def test_missing_land_type_is_not_assumed_normal(self):
        self.assertIsNone(parcel_from_trade({**self.trade, 'landCd': ''}))
        self.assertIsNone(parcel_from_kakao({'address': {**self.geo['address'], 'mountain_yn': ''}}))

    def test_address_without_parcel_is_not_name_matched(self):
        self.assertIsNone(parcel_from_kapt({'bjdCode': '1121510300', 'kaptAddr': '서울 광진구 구의동 이름만있는단지'}))

    def test_distance_and_invalid_coordinates(self):
        self.assertEqual(distance_m(127, 37, 127, 37), 0)
        self.assertAlmostEqual(distance_m(0, 0, 0, 1), 111195.08, places=1)
        with self.assertRaises(ValueError):
            distance_m('nan', 37, 127, 37)

    def test_same_road_different_building_number_is_not_equal(self):
        self.assertNotEqual(road_from_kapt('서울특별시 광진구 구의강변로3가길 39'), road_identity('구의강변로3가길', '00033', '00000'))
        self.assertEqual(road_from_kapt('서울특별시 광진구 아차산로 431'), road_identity('아차산로', '00431', '00000'))


if __name__ == '__main__':
    unittest.main()
