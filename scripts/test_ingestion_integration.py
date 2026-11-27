#!/usr/bin/env python3
"""BE-02 재생 진입점(replay)의 통합 회귀 검사. 모든 공고 번호·주택형·호실·금액·문서는 합성 자료다.

단위 검사(test_ingestion_*)가 덮지 않은, 진입점에서 관측한 호실 연결·보류 문서 경계만 둔다.
"""
import copy
import json
import unittest
from pathlib import Path

from ingestion_pages import loads_source_json
from replay_ingestion import replay

FIXTURE = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'ingestion-v0.json'
TYPE_A, TYPE_B = '084.0000A', '114.0000A'


def bundle_with_two_models():
    """합성 예시에 두 번째 주택형(02, 114.0000A)을 같은 공고의 주택형 조회 1쪽에 더한다."""
    bundle = loads_source_json(FIXTURE.read_text(encoding='utf-8'))
    page = next(p for p in bundle['pages'] if p['source'] == 'applyhome_apt_model')
    second = dict(page['body']['data'][0], MODEL_NO='02', HOUSE_TY=TYPE_B, SUPLY_AR='140.10',
                  LTTOT_TOP_AMOUNT='99,000')
    page['body']['data'].append(second)
    page['body'].update(matchCount=2, currentCount=2)
    return bundle


def document(**changes):
    base = {'id': 'synthetic-notice-pdf', 'version': 'synthetic-v1', 'source': 'official',
            'houseManageNo': '9900000001', 'noticeNo': '9900000042', 'edition': 'synthetic-edition-1'}
    return dict(base, **changes)


def price(room, item, won, *, model='01', house_type=TYPE_A, doc=None):
    return {'document': doc or document(), 'page': 7, 'modelNo': model, 'houseType': house_type, 'room': room,
            'item': item, 'check': 'confirmed', 'won': won}


def rooms_named(catalog, name):
    return [r for r in catalog['rooms'] if r['room'] == name]


class RoomLinkageIntegrationTests(unittest.TestCase):
    def test_room_attributed_to_another_housing_type_holds_only_that_subtotal(self):
        # QA 발견 A: 01호실 기록 둘(084.0000A)과, 같은 호실을 02의 주택형(114.0000A)으로 가리키는 기록 하나.
        # modelNo가 01이어도 houseType이 다른 주택형이면 연결이 모순이므로 그 호실 소계를 확정하지 않는다.
        bundle = bundle_with_two_models()
        bundle['evidence'] = [
            price('101동 101호', 'sale_price', '700000000'),
            price('101동 101호', 'required_options', '10000000'),
            price('101동 101호', 'sale_price', '900000000', house_type=TYPE_B),
            price('101동 102호', 'sale_price', '720000000'),
            price('101동 102호', 'required_options', '10000000'),
        ]
        catalog = replay(bundle)['catalog']
        contested = rooms_named(catalog, '101동 101호')
        self.assertTrue(contested, catalog['issues'])
        for room in contested:
            self.assertEqual((room['subtotal']['status'], room['subtotal']['won']), ('held', None), room)
        independent = rooms_named(catalog, '101동 102호')
        self.assertEqual([(r['modelNo'], r['subtotal']['status'], r['subtotal']['won']) for r in independent],
                         [('01', 'confirmed', '730000000')])
        model = next(t for t in catalog['housingTypes'] if t['modelNo'] == '01')
        self.assertEqual((model['subtotalRange']['min'], model['subtotalRange']['max'],
                          model['subtotalRange']['confirmedRooms']), ('730000000', '730000000', 1))

    def test_identified_held_document_reports_held_rooms_without_amounts(self):
        # QA 발견 B: 같은 회차·API 모델·주택형까지 식별된 출처 미확인 업로드의 호실은 금액 없이 held로 남긴다.
        # 같은 호실의 독립 공식 근거는 그대로 확정하고, 다른 회차·미귀속 문서로는 호실을 만들지 않는다.
        bundle = bundle_with_two_models()
        upload = document(id='synthetic-upload-pdf', version='synthetic-u1', source='upload')  # originCheck 없음
        bundle['evidence'] = [
            price('101동 101호', 'sale_price', '700000000'),
            price('101동 101호', 'required_options', '10000000'),
            price('101동 101호', 'sale_price', '700000000', doc=upload),
            price('101동 103호', 'sale_price', '730000000', doc=upload),
            price('101동 103호', 'required_options', '0', doc=upload),
            price('101동 104호', 'sale_price', '800000000', doc=document(id='synthetic-other-round',
                                                                          edition='synthetic-edition-2')),
            price('101동 104호', 'required_options', '0', doc=document(id='synthetic-other-round',
                                                                        edition='synthetic-edition-2')),
            price('101동 105호', 'sale_price', '810000000', model='09', doc=upload),
        ]
        catalog = replay(bundle)['catalog']
        official = rooms_named(catalog, '101동 101호')
        self.assertEqual([(r['modelNo'], r['subtotal']['status'], r['subtotal']['won']) for r in official],
                         [('01', 'confirmed', '710000000')])
        held = rooms_named(catalog, '101동 103호')
        self.assertEqual([(r['modelNo'], r['status']) for r in held], [('01', 'held')], catalog['rooms'])
        room = held[0]
        self.assertEqual((room['salePrice']['won'], room['requiredOptions']['won'], room['subtotal']['won']),
                         (None, None, None))
        self.assertTrue(room['subtotal']['reasons'])
        self.assertNotIn('730000000', json.dumps(room, ensure_ascii=False))  # 보류 문서 금액을 내보내지 않음
        self.assertEqual(rooms_named(catalog, '101동 104호') + rooms_named(catalog, '101동 105호'), [])
        model = next(t for t in catalog['housingTypes'] if t['modelNo'] == '01')
        self.assertEqual((model['subtotalRange']['confirmedRooms'], model['subtotalRange']['heldRooms']), (1, 1))


if __name__ == '__main__':
    unittest.main()
