#!/usr/bin/env python3
"""합성 공고·주택형 관측과 점검된 문서 근거로 카탈로그 정규화 경계를 검사한다. 모든 번호·금액·문서는 합성 자료다."""
import copy
import unittest
from decimal import Decimal

from ingestion_notices import normalize_catalog

HOUSE, NOTICE, EDITION = '9900000001', '9900000042', 'synthetic-edition-1'
TARGET = {'houseManageNo': HOUSE, 'noticeNo': NOTICE, 'edition': EDITION}
SCOPE = {'cond[HOUSE_MANAGE_NO::EQ]': HOUSE, 'cond[PBLANC_NO::EQ]': NOTICE}
NOTICE_ROW = {'HOUSE_MANAGE_NO': HOUSE, 'PBLANC_NO': NOTICE, 'HOUSE_SECD': '01', 'HOUSE_SECD_NM': '아파트',
              'HOUSE_NM': '합성 가람 아파트', 'HSSPLY_ADRES': '합성구 가람동', 'RCRIT_PBLANC_DE': '2026-10-05',
              'RCEPT_BGNDE': '2026-10-19', 'RCEPT_ENDDE': '2026-10-23', 'MVN_PREARNGE_YM': '202812',
              'PBLANC_URL': 'https://example.invalid/synthetic-notices/42'}
MODEL_A = {'HOUSE_MANAGE_NO': HOUSE, 'PBLANC_NO': NOTICE, 'MODEL_NO': '01', 'HOUSE_TY': '084.0000A',
           'SUPLY_AR': '112.40', 'LTTOT_TOP_AMOUNT': '75,000'}
MODEL_B = {'HOUSE_MANAGE_NO': HOUSE, 'PBLANC_NO': NOTICE, 'MODEL_NO': '02', 'HOUSE_TY': '059.0000B',
           'SUPLY_AR': '80.10', 'LTTOT_TOP_AMOUNT': '52000'}


def collection(source, rows, status='complete', scope=SCOPE):
    return {'source': source, 'scope': dict(scope), 'status': status,
            'observations': [{'row': dict(r), 'page': 1, 'position': i} for i, r in enumerate(rows, 1)]}


def doc(edition=EDITION, *, id='syn-doc-1', version='sha256:aa', source='official', house=HOUSE, notice=NOTICE,
        origin=None):
    document = {'id': id, 'version': version, 'source': source, 'houseManageNo': house, 'noticeNo': notice,
                'edition': edition}
    return document if origin is None else dict(document, originCheck=origin)  # 생략 시 source별 기본값


def value(room, item, won, check='confirmed', *, model='01', house_type='084.0000A', document=None, page=7):
    return {'document': document or doc(), 'page': page, 'modelNo': model, 'houseType': house_type, 'room': room,
            'item': item, 'check': check, 'won': won}


def priced(room, sale, options, **kwargs):
    return [value(room, 'sale_price', sale, **kwargs), value(room, 'required_options', options, **kwargs)]


def area(m2, check='confirmed', *, model='01', house_type='084.0000A', document=None, page=4, **changes):
    record = {'document': document or doc(), 'page': page, 'modelNo': model, 'houseType': house_type,
              'item': 'supply_area', 'basis': 'supply', 'unit': 'm2', 'check': check, 'm2': m2}
    return dict(record, **changes)


def run(evidence=(), notice=None, models=None):
    notice = collection('applyhome_apt', [NOTICE_ROW]) if notice is None else notice
    models = collection('applyhome_apt_model', [MODEL_A, MODEL_B]) if models is None else models
    return normalize_catalog(notice, models, target=TARGET, evidence=evidence)


def room(result, name, model='01'):
    return next(r for r in result['rooms'] if r['room'] == name and r['modelNo'] == model)


def codes(result):
    return [issue['code'] for issue in result['issues']]


class CatalogPricingTests(unittest.TestCase):
    def test_room_subtotals_stay_separate_from_api_top_amount(self):
        # A-02·A-40: 주택형 최고금액은 호실 가격이 아니며, 확인한 호실만 범위에 들어간다.
        evidence = (priced('101동 101호', '700000000', '0') + priced('101동 102호', '720000000', '15000000')
                    + [value('101동 103호', 'sale_price', '690000000'),
                       value('101동 103호', 'required_options', None, 'unverified', page=8)])
        result = run(evidence)
        housing = result['housingTypes'][0]
        self.assertEqual(housing['topAmount'], {'status': 'reported', 'kind': 'housing_type_top_amount',
                                                'won': '750000000', 'raw': '75,000', 'rawUnit': 'manwon'})
        self.assertEqual(housing['supplyArea'], {'status': 'reported', 'basis': 'supply', 'm2': '112.40'})
        self.assertEqual(room(result, '101동 101호')['subtotal']['won'], '700000000')  # 필수 옵션 없음 확인 = 0원
        confirmed = room(result, '101동 102호')['subtotal']
        self.assertEqual((confirmed['won'], confirmed['documents']), ('735000000', [{'id': 'syn-doc-1', 'version': 'sha256:aa'}]))
        held = room(result, '101동 103호')
        self.assertEqual((held['status'], held['subtotal']['won'], held['subtotal']['reasons']),
                         ('held', None, ['required_options_unverified']))
        self.assertEqual(held['salePrice']['won'], '690000000')  # 독립 항목은 유지
        self.assertEqual(held['requiredOptions']['evidence'],
                         [{'document': 'syn-doc-1', 'version': 'sha256:aa', 'page': 8, 'evidenceIndex': 5}])
        self.assertEqual(housing['subtotalRange'], {'scope': 'confirmed_rooms', 'min': '700000000', 'max': '735000000',
                                                    'confirmedRooms': 2, 'heldRooms': 1})
        self.assertEqual(result['housingTypes'][1]['subtotalRange']['confirmedRooms'], 0)
        self.assertEqual((result['housingTypesStatus'], result['issues']), ('reported', []))

    def test_room_without_option_record_is_held_not_zero(self):
        result = run([value('101동 101호', 'sale_price', '700000000')])
        options = room(result, '101동 101호')['requiredOptions']
        self.assertEqual((options['status'], options['won'], options['reasons']), ('unverified', None, ['no_checked_value']))
        self.assertEqual(room(result, '101동 101호')['subtotal']['status'], 'held')

    def test_amounts_must_be_exact_won_strings(self):
        for won in ['835,000,000', '0835', '700000000.0', '', ' 1', 700000000, None, '1' * 21, '0']:
            result = run([value('101동 101호', 'sale_price', won), value('101동 101호', 'required_options', '0')])
            sale = room(result, '101동 101호')['salePrice']
            self.assertEqual((sale['status'], sale['reasons']), ('unverified', ['invalid_amount']), won)
            self.assertEqual(room(result, '101동 101호')['subtotal']['status'], 'held')
        long_option = run(priced('101동 101호', '700000000', '9' * 5000))
        self.assertEqual(room(long_option, '101동 101호')['requiredOptions']['reasons'], ['invalid_amount'])
        # won 최대 20자는 받고, 두 항목의 합이 20자를 넘으면 그 소계만 보류한다.
        self.assertEqual(room(run(priced('101동 101호', '9' * 20, '0')), '101동 101호')['subtotal']['won'], '9' * 20)
        overflow = room(run(priced('101동 101호', '9' * 20, '1')), '101동 101호')
        self.assertEqual((overflow['salePrice']['won'], overflow['requiredOptions']['won'], overflow['subtotal']['status'],
                          overflow['subtotal']['reasons']), ('9' * 20, '1', 'held', ['subtotal_out_of_range']))

    def test_api_amount_and_area_formats(self):
        # BE-01 공용 형식: positiveDecimal 24자, won 20자(만원 16자리). 최대 길이와 하나 초과를 함께 본다.
        area24, area25 = '1.' + '1' * 22, '1.' + '1' * 23
        cases = [('75,00', '0', 'invalid', 'invalid'), ('75000.5', '1e2', 'invalid', 'invalid'),
                 ('0', '0112.4', 'invalid', 'invalid'), ('9' * 17, area25, 'invalid', 'invalid'),
                 (None, '', 'missing', 'blank'), ('9' * 16, area24, 'reported', 'reported'),
                 (75000, Decimal('112.400000000000000001'), 'reported', 'reported'),
                 ('1,234,567,890,123,456', 105.8939, 'reported', 'reported')]
        rows = [dict(MODEL_A, MODEL_NO=str(i), LTTOT_TOP_AMOUNT=a, SUPLY_AR=s) for i, (a, s, _, _) in enumerate(cases)]
        types = run(models=collection('applyhome_apt_model', rows))['housingTypes']
        self.assertEqual([(t['topAmount']['status'], t['supplyArea']['status']) for t in types], [c[2:] for c in cases])
        self.assertEqual([t['topAmount']['won'] for t in types[5:]], ['9' * 16 + '0000', '750000000', '12345678901234560000'])
        self.assertEqual([t['supplyArea']['m2'] for t in types[5:]], [area24, '112.400000000000000001', '105.8939'])
        self.assertIsNone(types[0]['topAmount']['won'])


class CatalogDocumentTests(unittest.TestCase):
    def test_different_round_document_is_not_merged(self):
        # A-01: 같은 공고 번호라도 다른 회차 문서의 값은 병합하지 않고 기존 값을 유지한다.
        old = doc('synthetic-edition-0', id='syn-doc-old')
        result = run(priced('101동 101호', '700000000', '0') + priced('101동 101호', '650000000', '0', document=old))
        self.assertEqual(room(result, '101동 101호')['subtotal']['won'], '700000000')
        rejected = next(d for d in result['documents'] if d['id'] == 'syn-doc-old')
        self.assertEqual((rejected['status'], rejected['reasons'], rejected['records']),
                         ('rejected', ['different_notice_round'], 2))
        only_old = run(priced('101동 101호', '650000000', '0', document=old))
        self.assertEqual(only_old['rooms'], [])

    def test_document_identity_and_source_are_checked(self):
        # A-31·§5.2: 식별 미확인·다른 공고·확보 경로 미확인 문서는 쓰지 않는다.
        documents = [doc(None, id='a'), doc(id='b', notice='9900000043'), doc(id='c', source='mirror')]
        result = run([value('101동 101호', 'sale_price', '700000000', document=d) for d in documents])
        self.assertEqual({d['id']: (d['status'], d['reasons']) for d in result['documents']},
                         {'a': ('rejected', ['document_identity_unverified']), 'b': ('rejected', ['document_notice_mismatch']),
                          'c': ('rejected', ['document_source_unverified'])})
        self.assertEqual(result['rooms'], [])

    def test_origin_check_decides_whether_a_document_is_used(self):
        # §5.2: 업로드 사실만으로 공식성을 인정하지 않는다. 출처 대조가 확인된 문서만 값을 쓴다.
        cases = [(doc(), 'confirmed', 'accepted', []),
                 (doc(origin='confirmed'), 'confirmed', 'accepted', []),
                 (doc(origin='unverified'), 'unverified', 'held', ['document_origin_unverified']),
                 (doc(origin='conflict'), 'conflict', 'held', ['document_origin_conflict']),
                 (doc(source='upload'), 'unverified', 'held', ['document_origin_unverified']),
                 (doc(source='upload', origin='conflict'), 'conflict', 'held', ['document_origin_conflict']),
                 (doc(source='upload', origin='confirmed'), 'confirmed', 'accepted', []),
                 (doc('synthetic-edition-0', source='upload', origin='confirmed'), 'confirmed', 'rejected',
                  ['different_notice_round'])]
        for document, origin, status, reasons in cases:
            result = run(priced('101동 101호', '700000000', '0', document=document))
            out = result['documents'][0]
            self.assertEqual((out['source'], out['originCheck'], out['status'], out['reasons']),
                             (document['source'], origin, status, reasons), document)
            expected = {'accepted': ['confirmed'], 'held': ['held'], 'rejected': []}[status]
            self.assertEqual([r['status'] for r in result['rooms']], expected, document)
        malformed = run([value('101동 101호', 'sale_price', '700000000', document=doc(origin='yes'))])
        self.assertEqual((malformed['issues'][0]['field'], malformed['documents'], malformed['rooms']), ('document', [], []))

    def test_unverified_upload_does_not_override_or_block_official_evidence(self):
        # 출처 미확인 업로드는 채택·충돌·형식 오류 보류에 참여하지 않는다. 공식 근거와 API 관측은 그대로다.
        upload = doc(id='syn-upload', source='upload')
        evidence = (priced('101동 101호', '700000000', '0') + [area('112.40')]
                    + priced('101동 101호', '650000000', '0', document=upload) + [area('99.00', document=upload)]
                    + [dict(value('101동 101호', 'required_options', '0', document=upload), page=0)])
        result = run(evidence)
        self.assertEqual((room(result, '101동 101호')['subtotal']['won'], result['housingTypes'][0]['checkedSupplyArea']['m2']),
                         ('700000000', '112.40'))
        self.assertEqual(room(result, '101동 101호')['salePrice']['evidence'],
                         [{'document': 'syn-doc-1', 'version': 'sha256:aa', 'page': 7, 'evidenceIndex': 0}])
        self.assertEqual(result['housingTypes'][0]['supplyArea']['status'], 'reported')
        self.assertNotIn('multiple_documents_same_edition', codes(result))
        self.assertEqual({d['id']: d['status'] for d in result['documents']}, {'syn-doc-1': 'accepted', 'syn-upload': 'held'})

    def test_same_document_with_changed_metadata_is_rejected(self):
        for other in (doc(source='upload'), doc(origin='unverified')):
            result = run([value('101동 101호', 'sale_price', '700000000'),
                          value('101동 101호', 'required_options', '0', document=other)])
            self.assertEqual(result['documents'][0]['reasons'], ['document_metadata_conflict'])
            self.assertEqual(result['rooms'], [])
        # 생략한 originCheck는 기본값으로 비교하므로 official의 명시 confirmed와 같은 문서다.
        same = run([value('101동 101호', 'sale_price', '700000000'),
                    value('101동 101호', 'required_options', '0', document=doc(origin='confirmed'))])
        self.assertEqual(room(same, '101동 101호')['status'], 'confirmed')

    def test_same_round_versions_with_different_prices_are_held(self):
        # A-59: 정정 적용 관계가 미확인이면 수정 시각·버전만으로 고르지 않고 충돌 항목만 보류한다.
        corrected = doc(version='sha256:bb')
        result = run(priced('101동 101호', '700000000', '0') + priced('101동 102호', '720000000', '0')
                     + [value('101동 101호', 'sale_price', '710000000', document=corrected, page=8),
                        value('101동 101호', 'required_options', '0', document=corrected, page=8)])
        sale = room(result, '101동 101호')['salePrice']
        self.assertEqual((sale['status'], sale['won'], sale['reasons'], sale['decisionId'], sale['values']),
                         ('conflict', None, ['correction_relation_unverified'], 'D-04', ['700000000', '710000000']))
        self.assertEqual([e['version'] for e in sale['evidence']], ['sha256:aa', 'sha256:bb'])
        self.assertEqual(room(result, '101동 101호')['requiredOptions']['status'], 'confirmed')
        self.assertEqual(room(result, '101동 101호')['subtotal']['reasons'], ['sale_price_conflict'])
        self.assertEqual(room(result, '101동 102호')['subtotal']['won'], '720000000')
        self.assertIn('multiple_documents_same_edition', codes(result))
        agreeing = run(priced('101동 101호', '700000000', '0') + priced('101동 101호', '700000000', '0', document=corrected))
        self.assertEqual(room(agreeing, '101동 101호')['subtotal']['documents'],
                         [{'id': 'syn-doc-1', 'version': 'sha256:aa'}, {'id': 'syn-doc-1', 'version': 'sha256:bb'}])

    def test_subtotal_needs_both_items_in_one_document_version(self):
        # 총괄 검토 (1): 분양가와 필수 옵션을 서로 다른 버전에서만 확인하면 소계를 확정하지 않는다(D-04).
        corrected = doc(version='sha256:bb')
        result = run([value('101동 101호', 'sale_price', '700000000'),
                      value('101동 101호', 'required_options', '10000000', document=corrected)])
        held = room(result, '101동 101호')
        self.assertEqual((held['salePrice']['status'], held['requiredOptions']['status']), ('confirmed', 'confirmed'))
        self.assertEqual((held['subtotal']['status'], held['subtotal']['reasons'], held['subtotal']['decisionId']),
                         ('held', ['subtotal_documents_differ'], 'D-04'))

    def test_conflict_within_one_document(self):
        result = run([value('101동 101호', 'sale_price', '700000000'),
                      value('101동 101호', 'sale_price', '700000001', page=9),
                      value('101동 102호', 'sale_price', '720000000'),
                      value('101동 102호', 'required_options', None, 'conflict')])
        self.assertEqual(room(result, '101동 101호')['salePrice']['reasons'], ['source_value_conflict'])
        self.assertEqual(room(result, '101동 102호')['subtotal']['reasons'], ['required_options_conflict'])

    def test_unlinked_model_and_house_type_mismatch_are_not_adopted(self):
        result = run([value('301동 101호', 'sale_price', '500000000', model='09'),
                      value('101동 101호', 'sale_price', '700000000', house_type='84A')])
        self.assertEqual(result['rooms'], [])
        self.assertEqual([(i['code'], i['modelNo']) for i in result['issues']],
                         [('model_not_linked', '09'), ('house_type_mismatch', '01')])
        partial = run([value('301동 101호', 'sale_price', '500000000', model='09')],
                      models=collection('applyhome_apt_model', [MODEL_A], status='partial'))
        self.assertEqual((partial['housingTypesStatus'], partial['housingTypes'][0]['status']),
                         ('partially_collected', 'linked'))
        self.assertIn('model_unverified', codes(partial))

    def test_room_listed_under_two_models_is_held(self):
        result = run(priced('101동 101호', '700000000', '0')
                     + priced('101동 101호', '500000000', '0', model='02', house_type='059.0000B'))
        self.assertEqual({r['subtotal']['status'] for r in result['rooms']}, {'held'})
        self.assertIn({'code': 'room_model_conflict', 'room': '101동 101호', 'modelNos': ['01', '02']}, result['issues'])

    def test_house_type_mismatch_holds_only_the_room_it_points_to(self):
        # 최종 검수 A: 같은 회차 채택 문서가 01/084A 101호를 다른 주택형으로 다시 가리키면 그 호실 소계만 보류한다.
        mismatch = value('101동 101호', 'sale_price', '700000000', house_type='059.0000B')
        evidence = (priced('101동 101호', '700000000', '0') + priced('101동 102호', '720000000', '0')
                    + priced('201동 201호', '500000000', '0', model='02', house_type='059.0000B') + [mismatch])
        result = run(evidence)
        held = room(result, '101동 101호')
        self.assertEqual((held['status'], held['subtotal']['won'], held['subtotal']['reasons']),
                         ('held', None, ['house_type_mismatch']))
        self.assertEqual((held['salePrice']['status'], [e['evidenceIndex'] for e in held['salePrice']['evidence']]),
                         ('confirmed', [0]))  # 불일치 기록은 채택하지 않는다
        self.assertEqual((room(result, '101동 102호')['status'], room(result, '201동 201호', '02')['status']),
                         ('confirmed', 'confirmed'))
        self.assertEqual(result['housingTypes'][0]['subtotalRange']['confirmedRooms'], 1)
        self.assertIn({'code': 'house_type_mismatch', 'evidenceIndex': 6, 'modelNo': '01'}, result['issues'])
        # 다른 근거가 없는 호실을 불일치 기록만으로 만들지 않는다.
        self.assertEqual(run([mismatch])['rooms'], [])

    def test_area_house_type_mismatch_holds_that_area_only(self):
        result = run([area('112.40'), area('80.10', house_type='059.0000B'), area('80.10', model='02', house_type='059.0000B')]
                     + priced('101동 101호', '700000000', '0'))
        first, second = (t['checkedSupplyArea'] for t in result['housingTypes'])
        self.assertEqual((first['status'], first['m2'], first['reasons'], [e['evidenceIndex'] for e in first['evidence']]),
                         ('conflict', None, ['house_type_mismatch'], [0, 1]))
        self.assertEqual((second['status'], second['m2']), ('confirmed', '80.10'))
        self.assertEqual(room(result, '101동 101호')['subtotal']['won'], '700000000')
        only_mismatch = run([area('80.10', house_type='059.0000B')])['housingTypes'][0]['checkedSupplyArea']
        self.assertEqual((only_mismatch['status'], only_mismatch['reasons']), ('conflict', ['house_type_mismatch']))

    def test_origin_held_document_rooms_are_listed_once_without_amounts(self):
        # 최종 검수 B: 출처 대조만 보류된 문서가 대상 공고·회차·주택형·호실을 가리키면 금액 없는 보류 호실로 한 번 남긴다.
        unverified, conflicting = doc(id='syn-upload', source='upload'), doc(id='syn-doc-2', origin='conflict')
        alone = run(priced('101동 101호', '700000000', '0', document=unverified)
                    + priced('101동 102호', '720000000', '0', document=unverified))
        self.assertEqual([(r['room'], r['status'], r['salePrice']['won'], r['requiredOptions']['won'], r['subtotal']['won'],
                           r['subtotal']['reasons']) for r in alone['rooms']],
                         [('101동 101호', 'held', None, None, None, ['document_origin_unverified']),
                          ('101동 102호', 'held', None, None, None, ['document_origin_unverified'])])
        self.assertEqual(alone['housingTypes'][0]['subtotalRange'],
                         {'scope': 'confirmed_rooms', 'min': None, 'max': None, 'confirmedRooms': 0, 'heldRooms': 2})
        both = run(priced('101동 101호', '700000000', '0', document=unverified)
                   + priced('101동 101호', '710000000', '0', document=conflicting))
        self.assertEqual([r['subtotal']['reasons'] for r in both['rooms']],
                         [['document_origin_conflict', 'document_origin_unverified']])

    def test_origin_held_document_does_not_block_independent_evidence(self):
        unverified = doc(id='syn-upload', source='upload')
        result = run(priced('101동 101호', '700000000', '0') + priced('101동 101호', '650000000', '0', document=unverified)
                     + priced('101동 103호', '730000000', '0', document=unverified))
        self.assertEqual([(r['room'], r['status'], r['subtotal']['won']) for r in result['rooms']],
                         [('101동 101호', 'confirmed', '700000000'), ('101동 103호', 'held', None)])
        self.assertEqual(result['housingTypes'][0]['subtotalRange']['heldRooms'], 1)
        # 다른 회차·미연결 모델·주택형 불일치를 가리키는 문서로는 호실을 만들지 않는다.
        for kwargs in ({'document': doc('synthetic-edition-0', source='upload')}, {'document': unverified, 'model': '09'},
                       {'document': unverified, 'house_type': '059.0000B'},
                       {'document': doc(notice='9900000043', source='upload')}):
            self.assertEqual(run(priced('101동 104호', '700000000', '0', **kwargs))['rooms'], [], kwargs)

    def test_malformed_record_holds_only_the_item_it_identifies(self):
        # 총괄 검토 (2): 식별 가능한 형식 오류는 그 항목만 보류하고, 식별 불가 오류는 카탈로그 이슈로만 남긴다.
        evidence = (priced('101동 101호', '700000000', '0') + priced('101동 102호', '720000000', '0')
                    + [dict(value('101동 102호', 'sale_price', '730000000'), page=0), {'won': '1'}, 'not-a-record'])
        result = run(evidence)
        self.assertEqual(room(result, '101동 101호')['subtotal']['won'], '700000000')
        held = room(result, '101동 102호')
        self.assertEqual((held['salePrice']['status'], held['salePrice']['reasons']), ('unverified', ['evidence_malformed']))
        self.assertEqual(held['requiredOptions']['status'], 'confirmed')
        self.assertEqual([(i['evidenceIndex'], i['field'], i.get('room')) for i in result['issues']],
                         [(4, 'page', '101동 102호'), (5, 'document', None), (6, 'record', None)])


class CatalogCollectionTests(unittest.TestCase):
    def test_notice_keeps_raw_fields_and_defers_dates_and_type(self):
        notice = run()['notice']
        self.assertEqual(notice['status'], 'reported')
        self.assertEqual(notice['fields']['RCRIT_PBLANC_DE'], {'status': 'reported', 'value': '2026-10-05'})
        self.assertEqual(notice['kind'], {'status': 'decision_required', 'decisionId': 'D-04', 'raw': {
            'HOUSE_SECD': {'status': 'reported', 'value': '01'},
            'HOUSE_SECD_NM': {'status': 'reported', 'value': '아파트'}}})
        self.assertEqual(notice['link'], {'status': 'reported', 'value': 'https://example.invalid/synthetic-notices/42',
                                          'kind': 'notice_page'})
        self.assertEqual(notice['evidence'], [{'collection': 'notice', 'page': 1, 'position': 1}])
        row = {'HOUSE_MANAGE_NO': int(HOUSE), 'PBLANC_NO': NOTICE, 'RCRIT_PBLANC_DE': '20261005', 'HOUSE_SECD': '04',
               'HOUSE_SECD_NM': '무순위', 'HOUSE_NM': '', 'HSSPLY_ADRES': {'nested': 'x'}}
        remainder = normalize_catalog(collection('applyhome_remainder', [row]),
                                      collection('applyhome_remainder_model', [MODEL_A]), target=TARGET)
        fields = remainder['notice']['fields']
        self.assertEqual(fields['RCRIT_PBLANC_DE']['value'], '20261005')  # 형식 차이를 바꾸지 않음
        self.assertEqual([fields[n]['status'] for n in ('HOUSE_NM', 'HSSPLY_ADRES', 'GNRL_RCEPT_BGNDE')],
                         ['blank', 'invalid', 'missing'])
        self.assertIsNone(fields['HSSPLY_ADRES']['value'])  # 중첩 원문을 내보내지 않음
        self.assertEqual(remainder['notice']['kind']['raw']['HOUSE_SECD_NM']['value'], '무순위')
        self.assertEqual(remainder['housingTypes'][0]['status'], 'linked')

    def test_rows_with_other_numbers_break_scope_not_prove_absence(self):
        # 총괄 재현: 두 번호로 요청했는데 다른 번호가 오면 미발견이 아니라 범위 불일치(부분)다.
        other_round = dict(NOTICE_ROW, PBLANC_NO='9900000043', HOUSE_NM='합성 다른 회차')
        mixed = run(notice=collection('applyhome_apt', [other_round, NOTICE_ROW]))
        self.assertEqual((mixed['collections']['notice']['status'], mixed['notice']['status']),
                         ('partial', 'partially_collected'))
        self.assertEqual(mixed['notice']['fields']['HOUSE_NM']['value'], '합성 가람 아파트')
        self.assertEqual(mixed['notice']['evidence'], [{'collection': 'notice', 'page': 1, 'position': 2}])
        only_other = run(notice=collection('applyhome_apt', [other_round]))
        self.assertEqual(only_other['notice']['status'], 'partially_collected')
        self.assertEqual(only_other['housingTypes'][0]['status'], 'linked')  # 두 번호가 맞는 주택형은 독립 유지
        nameless = dict(NOTICE_ROW)
        del nameless['PBLANC_NO']
        missing = run(notice=collection('applyhome_apt', [nameless]))
        self.assertEqual((missing['notice']['status'], codes(missing)[:2]),
                         ('partially_collected', ['row_identity_missing', 'collection_partial']))

    def test_explicit_empty_notice_is_not_found_and_holds_models(self):
        empty = {'source': 'applyhome_apt', 'scope': SCOPE, 'status': 'empty', 'observations': []}
        result = run(priced('101동 101호', '700000000', '0'), notice=empty)
        self.assertEqual(result['notice']['status'], 'not_found')
        self.assertEqual(result['housingTypes'][0]['reasons'], ['notice_not_found'])
        self.assertEqual(result['rooms'], [])

    def test_failed_notice_keeps_independent_housing_types(self):
        failed = {'source': 'applyhome_apt', 'scope': SCOPE, 'status': 'failed', 'observations': []}
        result = run(priced('101동 101호', '700000000', '0'), notice=failed)
        self.assertEqual((result['notice']['status'], result['notice']['fields'], result['housingTypesStatus']),
                         ('lookup_failed', None, 'reported'))
        self.assertEqual(room(result, '101동 101호')['status'], 'confirmed')

    def test_empty_or_failed_models_are_not_normal_zero(self):
        empty = {'source': 'applyhome_apt_model', 'scope': SCOPE, 'status': 'empty', 'observations': []}
        result = run([value('101동 101호', 'sale_price', '700000000')], models=empty)
        self.assertEqual((result['housingTypesStatus'], result['housingTypes'], result['rooms']), ('unverified', [], []))
        self.assertEqual(codes(result), ['no_housing_types_observed', 'model_unverified'])
        failed = run(models=dict(empty, status='failed'))
        self.assertEqual(failed['housingTypesStatus'], 'lookup_failed')
        nameless = dict(MODEL_B)
        del nameless['MODEL_NO']
        unattributed = run([value('301동 101호', 'sale_price', '1', model='03')],
                           models=collection('applyhome_apt_model', [MODEL_A, nameless]))
        self.assertEqual(unattributed['housingTypesStatus'], 'partially_collected')
        self.assertIn('model_unverified', codes(unattributed))

    def test_inconsistent_or_mismatched_collections_are_unusable(self):
        observations = collection('applyhome_apt_model', [MODEL_A])['observations']
        repeated = collection('applyhome_apt_model', [MODEL_A, MODEL_B])
        repeated['observations'][1]['position'] = 1
        zero_position = copy.deepcopy(collection('applyhome_apt_model', [MODEL_A]))
        zero_position['observations'][0]['position'] = 0
        cases = {
            'collection_inconsistent': [
                {'source': 'applyhome_apt_model', 'scope': SCOPE, 'status': 'empty', 'observations': observations},
                {'source': 'applyhome_apt_model', 'scope': SCOPE, 'status': 'complete', 'observations': []}],
            'collection_status_invalid': [collection('applyhome_apt_model', [MODEL_A], status='ok')],
            'collection_scope_mismatch': [
                collection('applyhome_apt_model', [MODEL_A], scope=dict(SCOPE, **{'cond[PBLANC_NO::EQ]': '9900000043'})),
                collection('applyhome_apt_model', [MODEL_A], scope=dict(SCOPE, **{'cond[MODEL_NO::EQ]': '01'})),
                collection('applyhome_apt_model', [MODEL_A], scope={'houseManageNo': HOUSE, 'noticeNo': NOTICE})],
            'collection_source_invalid': [collection('apt_trade', [MODEL_A])],
            'observation_position_repeated': [repeated],
            'observation_malformed': [zero_position],
        }
        for code, models in cases.items():
            for model in models:
                result = run(models=model)
                self.assertEqual((result['collections']['model']['status'], result['housingTypesStatus']),
                                 ('unusable', 'unverified'), code)
                self.assertIn(code, codes(result))

    def test_source_pair_mismatch_holds_housing_types(self):
        result = run(priced('101동 101호', '700000000', '0'),
                     models=collection('applyhome_remainder_model', [MODEL_A, MODEL_B]))
        self.assertEqual([t['reasons'] for t in result['housingTypes']], [['source_pair_mismatch']] * 2)
        self.assertEqual(result['rooms'], [])
        self.assertIn('model_held', codes(result))

    def test_conflicting_duplicate_rows_keep_independent_fields(self):
        notice = run(notice=collection('applyhome_apt', [NOTICE_ROW, dict(NOTICE_ROW, HOUSE_NM='합성 나래 아파트')]))
        self.assertEqual([notice['notice']['fields'][n]['status'] for n in ('HOUSE_NM', 'HSSPLY_ADRES')],
                         ['conflict', 'reported'])
        area = run(models=collection('applyhome_apt_model', [MODEL_A, dict(MODEL_A, SUPLY_AR='112.41')]))
        housing = area['housingTypes'][0]
        self.assertEqual((housing['status'], housing['supplyArea']['status'], housing['supplyArea']['m2'],
                          housing['topAmount']['won']), ('linked', 'conflict', None, '750000000'))
        house_type = run(models=collection('applyhome_apt_model', [MODEL_A, dict(MODEL_A, HOUSE_TY='084.0000B')]))
        self.assertEqual(house_type['housingTypes'][0]['reasons'], ['house_type_conflict'])
        same = run(models=collection('applyhome_apt_model', [MODEL_A, MODEL_A]))
        self.assertEqual((same['housingTypes'][0]['supplyArea']['status'], len(same['housingTypes'][0]['evidence'])),
                         ('reported', 2))

    def test_target_and_evidence_container_are_required(self):
        notice, models = collection('applyhome_apt', [NOTICE_ROW]), collection('applyhome_apt_model', [MODEL_A])
        for target in [{'houseManageNo': HOUSE, 'noticeNo': NOTICE}, dict(TARGET, edition=''), None]:
            with self.assertRaises(ValueError):
                normalize_catalog(notice, models, target=target)
        with self.assertRaises(TypeError):
            normalize_catalog(notice, models, target=TARGET, evidence={'records': []})


class CatalogSupplyAreaTests(unittest.TestCase):
    def test_document_area_equal_to_api_report_is_confirmed(self):
        # 문서 점검값이 API 보고값과 정밀 십진수로 같으면 확정한다. API 값과 호실 소계는 그대로 둔다.
        result = run([area('112.4')] + priced('101동 101호', '700000000', '0'))
        housing = result['housingTypes'][0]
        self.assertEqual(housing['supplyArea'], {'status': 'reported', 'basis': 'supply', 'm2': '112.40'})
        self.assertEqual(housing['checkedSupplyArea'], {
            'status': 'confirmed', 'm2': '112.4', 'reasons': [], 'basis': 'supply',
            'evidence': [{'document': 'syn-doc-1', 'version': 'sha256:aa', 'page': 4, 'evidenceIndex': 0}]})
        self.assertEqual(result['housingTypes'][1]['checkedSupplyArea']['reasons'], ['no_checked_value'])
        self.assertEqual(room(result, '101동 101호')['subtotal']['won'], '700000000')
        self.assertEqual((result['rooms'][0]['room'], len(result['rooms']), result['issues']), ('101동 101호', 1, []))

    def test_api_or_version_contradiction_holds_only_the_area(self):
        mismatch = run([area('112.41')] + priced('101동 101호', '700000000', '0'))
        checked = mismatch['housingTypes'][0]['checkedSupplyArea']
        self.assertEqual((checked['status'], checked['m2'], checked['reasons'], checked['values']),
                         ('conflict', None, ['supply_area_api_mismatch'], ['112.40', '112.41']))
        self.assertEqual((mismatch['housingTypes'][0]['status'], room(mismatch, '101동 101호')['status']), ('linked', 'confirmed'))
        self.assertIn({'code': 'supply_area_api_mismatch', 'modelNo': '01', 'item': 'supply_area'}, mismatch['issues'])
        corrected = doc(version='sha256:bb')
        versions = run([area('112.40'), area('112.50', document=corrected)])['housingTypes'][0]['checkedSupplyArea']
        self.assertEqual((versions['status'], versions['reasons'], versions['decisionId'], versions['values']),
                         ('conflict', ['correction_relation_unverified'], 'D-04', ['112.40', '112.50']))
        same = run([area('112.40'), area('112.4', document=corrected)])['housingTypes'][0]['checkedSupplyArea']
        self.assertEqual((same['status'], same['m2'], len(same['evidence'])), ('confirmed', '112.40', 2))
        api_conflict = run([area('112.40')], models=collection('applyhome_apt_model', [MODEL_A, dict(MODEL_A, SUPLY_AR='112.41')]))
        self.assertEqual(api_conflict['housingTypes'][0]['checkedSupplyArea']['reasons'], ['supply_area_api_conflict'])

    def test_without_api_value_an_origin_confirmed_document_confirms(self):
        no_api = dict(MODEL_A)
        del no_api['SUPLY_AR']
        models = collection('applyhome_apt_model', [no_api])
        official = run([area('112.40')], models=models)['housingTypes'][0]
        self.assertEqual((official['supplyArea']['status'], official['checkedSupplyArea']['status'],
                          official['checkedSupplyArea']['m2']), ('missing', 'confirmed', '112.40'))
        checked_upload = run([area('112.40', document=doc(source='upload', origin='confirmed'))], models=models)
        self.assertEqual(checked_upload['housingTypes'][0]['checkedSupplyArea']['m2'], '112.40')
        # 출처 미확인 업로드는 API 값과 같아도 면적 근거로 쓰지 않는다.
        for models_case in (models, None):
            upload = run([area('112.40', document=doc(source='upload'))], models=models_case)['housingTypes'][0]
            self.assertEqual((upload['checkedSupplyArea']['status'], upload['checkedSupplyArea']['m2'],
                              upload['checkedSupplyArea']['reasons']), ('unverified', None, ['no_checked_value']))

    def test_origin_confirmed_upload_matches_official_pdf_result(self):
        # 비교 검수: 같은 합성 값이면 출처 확인 업로드와 공식 확보 PDF의 결과는 확보 경로 표시만 다르다.
        no_api = dict(MODEL_A)
        del no_api['SUPLY_AR']
        def build(document):
            evidence = (priced('101동 101호', '700000000', '10000000', document=document)
                        + [value('101동 102호', 'sale_price', '720000000', document=document),
                           value('101동 102호', 'required_options', None, 'unverified', document=document),
                           area('112.40', document=document)])
            return run(evidence, models=collection('applyhome_apt_model', [no_api, MODEL_B]))
        official, upload = build(doc()), build(doc(source='upload', origin='confirmed'))
        for key in ('notice', 'housingTypes', 'housingTypesStatus', 'rooms', 'issues'):
            self.assertEqual(official[key], upload[key], key)
        self.assertEqual([dict(d, source=None) for d in official['documents']],
                         [dict(d, source=None) for d in upload['documents']])
        self.assertEqual((official['documents'][0]['source'], upload['documents'][0]['source']), ('official', 'upload'))
        self.assertEqual((room(upload, '101동 101호')['subtotal']['won'],
                          upload['housingTypes'][0]['checkedSupplyArea']['m2']), ('710000000', '112.40'))

    def test_unchecked_other_round_exclusive_or_misplaced_values_are_not_used(self):
        cases = [
            ([area(None, 'unverified')], ['value_unverified'], None),
            ([area('112.40', 'conflict')], ['source_value_conflict'], None),
            ([area('112.40', document=doc('synthetic-edition-0', id='old'))], ['no_checked_value'], 'different_notice_round'),
            ([area('84.00', basis='exclusive')], ['area_basis_mixed'], 'area_basis_mixed'),
            ([area('34', unit='pyeong')], ['evidence_malformed'], 'evidence_malformed'),
            ([area('112.40', room='101동 101호')], ['evidence_malformed'], 'evidence_malformed'),
            ([area('112.40', model='09')], ['no_checked_value'], 'model_not_linked'),
            ([area('112.40', house_type='084A')], ['house_type_mismatch'], 'house_type_mismatch'),
        ] + [([area(bad)], ['invalid_area'], 'invalid_area') for bad in ['0', '112.4.0', '0112.4', 112.4, '1.' + '1' * 23]]
        for evidence, reasons, code in cases:
            result = run(evidence + priced('101동 101호', '700000000', '0'))
            checked = result['housingTypes'][0]['checkedSupplyArea']
            self.assertEqual((checked['status'] != 'confirmed', checked['m2'], checked['reasons']), (True, None, reasons),
                             evidence)
            if code:
                self.assertIn(code, codes(result))
            self.assertEqual(room(result, '101동 101호')['subtotal']['won'], '700000000')  # 독립 호실 소계 유지
        boundary = run([area('1.' + '1' * 22)], models=collection('applyhome_apt_model', [dict(MODEL_A, SUPLY_AR='1.' + '1' * 22)]))
        self.assertEqual(boundary['housingTypes'][0]['checkedSupplyArea']['status'], 'confirmed')


if __name__ == '__main__':
    unittest.main()
