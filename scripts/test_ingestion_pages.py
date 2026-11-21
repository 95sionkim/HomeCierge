#!/usr/bin/env python3
"""합성 재생만으로 페이지 수집의 완전성·실패·경계 판정을 검사한다. 네트워크와 실제 인증값을 쓰지 않는다."""
import json
import unittest

import ingestion_pages
from ingestion_pages import REASON_CODES, LiveProbeTransport, ReplayTransport, collect_pages, loads_source_json
from probe_apis import ROOT, parse_payload, run_probe

OBSERVED = '2026-11-10T00:00:00Z'
SCOPE = {'LAWD_CD': '99999', 'DEAL_YMD': '202610'}
NOTICE = {'cond[HOUSE_MANAGE_NO::EQ]': '9900000001', 'cond[PBLANC_NO::EQ]': '9900000042'}
LAYERS = {'upstream_business_error': 'business', 'upstream_timeout': 'network',
          'upstream_malformed_response': 'parse', 'upstream_response_too_large': 'parse'}


def trade(day, floor='7'):
    """합성 거래 행(실제 거래 아님)."""
    return {'sggCd': '99999', 'aptNm': '합성 비교 A', 'dealYear': '2026', 'dealMonth': '10', 'dealDay': str(day),
            'dealAmount': '51,500', 'excluUseAr': '84.00', 'floor': floor, 'cdealType': '', 'cdealDay': ''}


def rtms(rows, total, page=1, size=2, code='000'):
    return {'response': {'header': {'resultCode': code, 'resultMsg': 'OK'}, 'body': {
        'pageNo': page, 'numOfRows': size, 'totalCount': total, 'items': {'item': rows} if rows else ''}}}


def odcloud(rows, match=None, total=90, page=1, size=2):
    body = {'page': page, 'perPage': size, 'currentCount': len(rows), 'totalCount': total, 'data': rows}
    if match is not None:
        body['matchCount'] = match
    return body


def entry(body=None, page=1, size=2, source='apt_trade', scope=SCOPE, status=200, **extra):
    return {'source': source, 'scope': scope, 'page': page, 'pageSize': size, 'httpStatus': status,
            'body': body, 'observedAt': OBSERVED, **extra}


def bundle(*pages):
    return {'dataOrigin': 'synthetic', 'pages': list(pages)}


class PageCollectionTests(unittest.TestCase):
    def collect(self, *pages, source='apt_trade', scope=SCOPE, page_size=2, **options):
        transport = ReplayTransport(bundle(*pages))
        result = collect_pages(source, scope, transport, page_size=page_size, **options)
        self.check_common(result)
        if source in ('apt_trade', 'apt_rights'):
            self.check_collection_record(result)
        return result, transport

    def check_common(self, result):
        self.assertEqual(result['rowsReceived'], len(result['observations']))
        self.assertTrue(set(result['reasons']) <= set(REASON_CODES), result['reasons'])
        if result['error'] is not None:
            self.assertEqual(set(result['error']), {'code', 'layer'})
            expected = LAYERS.get(result['error']['code'])
            if expected:
                self.assertEqual(result['error']['layer'], expected)

    def check_collection_record(self, r):
        """BE-01 collectionRecord의 상태별 조건(analysis-result-v0.schema.json)을 실거래 결과에 적용한다."""
        status = r['status']
        if status in ('complete', 'empty'):
            self.assertEqual((r['missingPages'], r['totalCountChanged'], r['error'], r['reasons']), ([], False, None, []))
            self.assertIsInstance(r['collectedAt'], str)
        if status == 'complete':
            self.assertIsInstance(r['pagesExpected'], int)
            self.assertGreaterEqual(r['reportedTotalCount'], 1)
            self.assertEqual(r['rowsReceived'], r['reportedTotalCount'])
        elif status == 'empty':
            self.assertEqual((r['pagesExpected'], r['reportedTotalCount'], r['rowsReceived']), (1, 0, 0))
        elif status == 'partial':
            self.assertIsInstance(r['pagesExpected'], int)
            self.assertIsInstance(r['reportedTotalCount'], int)
            self.assertIsInstance(r['collectedAt'], str)
            self.assertTrue(r['reasons'])
            self.assertTrue(all(1 <= n <= r['pagesExpected'] for n in r['missingPages']))
        else:
            self.assertEqual(status, 'failed')
            self.assertEqual((r['pagesExpected'], r['missingPages'], r['reportedTotalCount'], r['rowsReceived'],
                              r['totalCountChanged'], r['collectedAt']), (None, [], None, 0, False, None))
            self.assertIsNotNone(r['error'])

    def test_complete_pages_keep_duplicate_rows_and_positions(self):
        result, transport = self.collect(entry(rtms([trade(20), trade(20)], 3)),
                                         entry(rtms([trade(9)], 3, page=2), page=2))
        self.assertEqual(result['status'], 'complete')
        self.assertEqual((result['pagesExpected'], result['reportedTotalCount'], result['rowsReceived']), (2, 3, 3))
        self.assertEqual([(o['page'], o['position']) for o in result['observations']], [(1, 1), (1, 2), (2, 1)])
        self.assertEqual(result['observations'][0]['row'], result['observations'][1]['row'])  # 같은 행 2건 보존
        self.assertEqual(result['scope'], SCOPE)
        self.assertEqual((len(transport.requests), transport.unused()), (2, []))

    def test_explicit_normal_empty_json_and_xml(self):
        xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><response><header><resultCode>000</resultCode>'
               '</header><body><items/><numOfRows>2</numOfRows><pageNo>1</pageNo><totalCount>0</totalCount></body></response>')
        for body in (rtms([], 0), json.dumps(rtms([], 0)), xml):
            result, _ = self.collect(entry(body))
            self.assertEqual((result['status'], result['pagesExpected']), ('empty', 1))

    def test_xml_single_item_is_one_row(self):
        xml = ('<response><header><resultCode>000</resultCode></header><body><items><item><aptNm>합성</aptNm>'
               '<dealDay>3</dealDay></item></items><numOfRows>2</numOfRows><pageNo>1</pageNo>'
               '<totalCount>1</totalCount></body></response>')
        result, _ = self.collect(entry(xml))
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['observations'][0]['row'], {'aptNm': '합성', 'dealDay': '3'})

    def test_unverified_zero_is_not_empty(self):
        missing_items = rtms([], 0)
        del missing_items['response']['body']['items']
        missing_total = rtms([], 0)
        del missing_total['response']['body']['totalCount']
        no_header = rtms([], 0)
        del no_header['response']['header']
        for body in (missing_items, missing_total, no_header, rtms([], '-1'), rtms([], 'abc'), rtms([], 0.0),
                     rtms(['문자열 행'], 1)):
            result, _ = self.collect(entry(body))
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['error'], {'code': 'upstream_malformed_response', 'layer': 'parse'})

    def test_business_error_inside_http_200_hides_message(self):
        secret_like = '합성-원문-오류-문장'
        xml = ('<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>%s</errMsg><returnReasonCode>30</returnReasonCode>'
               '</cmmMsgHeader></OpenAPI_ServiceResponse>' % secret_like)
        cases = [('apt_trade', SCOPE, rtms([trade(1)], 1, code='22')), ('apt_trade', SCOPE, xml),
                 ('applyhome_apt', NOTICE, {'code': -4, 'msg': secret_like})]
        for source, scope, body in cases:
            result, _ = self.collect(entry(body, source=source, scope=scope), source=source, scope=scope)
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['error'], {'code': 'upstream_business_error', 'layer': 'business'})
            self.assertNotIn(secret_like, json.dumps(result, ensure_ascii=False))

    def test_http_and_transport_failures(self):
        http = {401: 'upstream_auth_rejected', 403: 'upstream_auth_rejected', 429: 'upstream_rate_limited',
                503: 'upstream_unavailable', 301: 'upstream_unavailable', 204: 'upstream_unavailable'}
        for status, code in http.items():
            result, _ = self.collect(entry(rtms([trade(1)], 1), status=status))  # 오류 응답의 본문은 해석하지 않는다
            self.assertEqual((result['status'], result['error']), ('failed', {'code': code, 'layer': 'http'}))
        transport = {'timeout': ('upstream_timeout', 'network'), 'connection': ('upstream_unavailable', 'network'),
                     'too_large': ('upstream_response_too_large', 'parse'),
                     'withheld': ('upstream_malformed_response', 'parse')}
        for name, (code, layer) in transport.items():
            result, _ = self.collect(entry(status=None, transportError=name))
            self.assertEqual((result['status'], result['error']), ('failed', {'code': code, 'layer': layer}))
            self.assertIn('collection_request_failed', result['reasons'])

    def test_malformed_body(self):
        for body in ('not json', '<response><unclosed>', '{"response": ', [], None, '\ud800'):
            result, _ = self.collect(entry(body))
            self.assertEqual(result['error'], {'code': 'upstream_malformed_response', 'layer': 'parse'})

    def test_missing_middle_page_keeps_received_rows(self):
        first = entry(rtms([trade(1), trade(2)], 5))
        result, transport = self.collect(first, entry(rtms([trade(5)], 5, page=3), page=3))
        self.assertEqual(result['status'], 'partial')
        self.assertEqual((result['missingPages'], result['rowsReceived'], result['pagesExpected']), ([2, 3], 2, 3))
        self.assertEqual(result['error'], {'code': 'upstream_unavailable', 'layer': 'network'})
        self.assertTrue({'collection_page_missing', 'collection_request_failed',
                         'replay_response_not_provided'} <= set(result['reasons']))
        self.assertEqual(len(transport.requests), 2)  # 실패한 쪽 다음은 조회하지 않는다
        result, _ = self.collect(first, entry(page=2, status=None, transportError='timeout'))
        self.assertEqual((result['status'], result['error']['code']), ('partial', 'upstream_timeout'))

    def test_total_count_change_is_partial(self):
        result, _ = self.collect(entry(rtms([trade(1), trade(2)], 3)), entry(rtms([trade(3), trade(4)], 4, page=2), page=2))
        self.assertEqual((result['status'], result['totalCountChanged'], result['reportedTotalCount']), ('partial', True, 3))
        self.assertIn('collection_total_count_changed', result['reasons'])

    def test_repeated_page_is_partial_even_when_counts_match(self):
        rows = [trade(1), trade(2)]
        result, _ = self.collect(entry(rtms(rows, 4)), entry(rtms(rows, 4, page=2), page=2))
        self.assertEqual((result['status'], result['rowsReceived'], result['reportedTotalCount']), ('partial', 4, 4))
        self.assertTrue({'repeated_page', 'collection_page_inconsistent'} <= set(result['reasons']))

    def test_short_or_excess_rows_are_partial(self):
        short, _ = self.collect(entry(rtms([trade(1)], 3)), entry(rtms([trade(3)], 3, page=2), page=2))
        self.assertEqual((short['status'], short['missingPages']), ('partial', [2]))
        excess, _ = self.collect(entry(rtms([trade(1), trade(2)], 3)), entry(rtms([trade(3), trade(4)], 3, page=2), page=2))
        zero_total, _ = self.collect(entry(rtms([trade(1)], 0)))
        for result in (short, excess, zero_total):
            self.assertEqual(result['status'], 'partial')
            self.assertIn('collection_row_count_mismatch', result['reasons'])

    def test_page_echo_mismatch_is_partial(self):
        wrong_page = entry(rtms([trade(3)], 3, page=1), page=2)
        result, _ = self.collect(entry(rtms([trade(1), trade(2)], 3)), wrong_page)
        clamped, _ = self.collect(entry(rtms([trade(1), trade(2)], 2, size=10)))
        for item in (result, clamped):
            self.assertEqual(item['status'], 'partial')
            self.assertIn('page_echo_mismatch', item['reasons'])

    def test_pages_outside_requested_range_block_completion(self):
        pages = [entry(rtms([trade(1), trade(2)], 3)), entry(rtms([trade(3)], 3, page=2), page=2)]
        beyond, transport = self.collect(*pages, entry(rtms([trade(4)], 3, page=3), page=3))
        other_size, _ = self.collect(*pages, entry(rtms([trade(1)], 3, size=1), size=1))
        for result in (beyond, other_size):
            self.assertEqual((result['status'], result['rowsReceived']), ('partial', 3))
            self.assertIn('unrequested_page_supplied', result['reasons'])
        self.assertEqual(transport.unused(), [{'source': 'apt_trade', 'scope': SCOPE, 'page': 3, 'pageSize': 2}])

    def test_request_unit_must_match_exactly(self):
        page = entry(rtms([trade(1)], 1))
        other_size, _ = self.collect(page, page_size=3)
        other_month, _ = self.collect(page, scope={'LAWD_CD': '99999', 'DEAL_YMD': '202609'})
        other_source, _ = self.collect(page, source='apt_rights')
        for result in (other_size, other_month, other_source):
            self.assertEqual(result['status'], 'failed')
            self.assertIn('replay_response_not_provided', result['reasons'])
        with self.assertRaises(ValueError):
            ReplayTransport(bundle(entry(scope={'LAWD_CD': 99999, 'DEAL_YMD': '202610'})))
        with self.assertRaises(ValueError):
            collect_pages('apt_trade', {'LAWD_CD': 99999, 'DEAL_YMD': '202610'}, ReplayTransport(bundle(page)))

    def test_replay_input_errors_are_not_overwritten(self):
        page = entry(rtms([trade(1)], 1))
        invalid = [
            bundle(page, entry(rtms([trade(2)], 1))),  # 같은 조회 단위 중복
            {'dataOrigin': 'collected', 'pages': [page]},
            {'pages': [page]},
            bundle({**page, 'httpstatus': 200}),
            bundle(entry(rtms([], 0), status=None, transportError='timeout')),
            bundle(entry(status=None, transportError='not_provided')),
            bundle(entry(status=None, transportError='dns')),
            bundle(entry(status=None)),
            bundle({**page, 'observedAt': '2026-11-10T00:00:00'}),
            bundle({**page, 'page': True}),
            bundle({**page, 'source': 'kakao_address'}),
        ]
        for value in invalid:
            with self.assertRaises(ValueError):
                ReplayTransport(value)

    def test_envelope_must_echo_the_request(self):
        def wrong(source, scope, page, page_size):
            return {'source': source, 'scope': scope, 'page': page + 1, 'pageSize': page_size,
                    'httpStatus': 200, 'transportError': None, 'body': rtms([], 0), 'observedAt': OBSERVED}
        with self.assertRaises(ValueError):
            collect_pages('apt_trade', SCOPE, wrong, page_size=2)

    def test_applyhome_filter_prefers_match_count(self):
        row = {'HOUSE_MANAGE_NO': '9900000001', 'PBLANC_NO': '9900000042'}
        kwargs = {'source': 'applyhome_apt', 'scope': NOTICE}
        page = lambda body, **extra: entry(body, source='applyhome_apt', scope=NOTICE, **extra)
        result, _ = self.collect(page(odcloud([row], match=1, total=90)), **kwargs)
        self.assertEqual((result['status'], result['reportedTotalCount'], result['pagesExpected']), ('complete', 1, 1))
        unverified, _ = self.collect(page(odcloud([row], total=1)), **kwargs)  # 전체 데이터 건수로 확정하지 않는다
        self.assertEqual((unverified['status'], unverified['reportedTotalCount'], unverified['pagesExpected']),
                         ('partial', None, None))
        self.assertEqual((unverified['reasons'], unverified['rowsReceived']), (['total_count_unverified'], 1))
        empty, _ = self.collect(page(odcloud([], match='0')), **kwargs)
        self.assertEqual(empty['status'], 'empty')
        unfiltered, _ = self.collect(entry(odcloud([row], total=1), source='applyhome_apt', scope={}),
                                     source='applyhome_apt', scope={})
        self.assertEqual((unfiltered['status'], unfiltered['reportedTotalCount']), ('complete', 1))
        invalid, _ = self.collect(page(odcloud([row], match='한 건')), **kwargs)
        self.assertEqual((invalid['status'], invalid['error']['code']), ('failed', 'upstream_malformed_response'))
        current = odcloud([row], match=1)
        current['currentCount'] = 2
        mismatch, _ = self.collect(page(current), **kwargs)
        self.assertIn('collection_row_count_mismatch', mismatch['reasons'])

    def test_model_sources_share_the_filter_rules(self):
        for source in ('applyhome_apt_model', 'applyhome_remainder_model', 'applyhome_remainder'):
            result, _ = self.collect(entry(odcloud([{'MODEL_NO': '01'}], match=1), source=source, scope=NOTICE),
                                     source=source, scope=NOTICE)
            self.assertEqual(result['status'], 'complete')

    def test_max_pages_is_an_explicit_caller_limit(self):
        pages = [entry(rtms([trade(1), trade(2)], 5)), entry(rtms([trade(3), trade(4)], 5, page=2), page=2),
                 entry(rtms([trade(5)], 5, page=3), page=3)]
        limited, transport = self.collect(*pages, max_pages=2)
        self.assertEqual((limited['status'], limited['missingPages'], len(transport.requests)), ('partial', [3], 2))
        self.assertIn('page_limit_reached', limited['reasons'])
        self.assertEqual(self.collect(*pages)[0]['status'], 'complete')
        for value in (0, True, 1.5):
            with self.assertRaises(ValueError):
                collect_pages('apt_trade', SCOPE, ReplayTransport(bundle(*pages)), page_size=2, max_pages=value)

    def test_extreme_counts_fail_before_planning(self):
        limit = ingestion_pages.MAX_PLANNED_PAGES
        for total in ('9' * 40, 10 ** 400, 2 * limit + 1):  # 2쪽 크기로 limit+1쪽
            result, transport = self.collect(entry(rtms([trade(1), trade(2)], total)))
            self.assertEqual((result['status'], len(transport.requests)), ('failed', 1))
            self.assertEqual(result['error'], {'code': 'upstream_response_too_large', 'layer': 'parse'})
            self.assertIn('page_plan_limit_exceeded', result['reasons'])
        boundary, _ = self.collect(entry(rtms([trade(1), trade(2)], 2 * limit)))  # 상한과 같은 계획은 표현한다
        self.assertEqual((boundary['status'], boundary['pagesExpected'], len(boundary['missingPages'])),
                         ('partial', limit, limit - 1))
        huge = 10 ** ingestion_pages.MAX_COUNT_DIGITS  # 페이지 크기가 커도 자릿수 상한은 같다
        oversized = collect_pages('apt_trade', SCOPE, ReplayTransport(bundle(entry(rtms([trade(1)], huge), size=huge))),
                                  page_size=huge)
        self.assertIn('page_plan_limit_exceeded', oversized['reasons'])
        padded, _ = self.collect(entry(rtms([trade(1)], '0' * 40 + '1')))
        self.assertEqual((padded['status'], padded['reportedTotalCount']), ('complete', 1))
        later, _ = self.collect(entry(rtms([trade(1), trade(2)], 3)), entry(rtms([trade(3)], '9' * 40, page=2), page=2))
        self.assertEqual((later['status'], later['missingPages'], later['rowsReceived']), ('partial', [2], 2))
        self.assertEqual(later['error']['code'], 'upstream_response_too_large')
        self.assertIn('page_plan_limit_exceeded', later['reasons'])

    def test_observed_at_requires_a_calendar_date(self):
        for value in ('2026-02-30T00:00:00Z', '2027-02-29T00:00:00+09:00', '2026-04-31T00:00:00Z'):
            with self.assertRaises(ValueError):
                ReplayTransport(bundle(entry(rtms([], 0), observedAt=value)))
        leap, _ = self.collect(entry(rtms([], 0), observedAt='2028-02-29T23:59:59.5+09:00'))
        self.assertEqual((leap['status'], leap['collectedAt']), ('empty', '2028-02-29T23:59:59.5+09:00'))

        def bad_date(source, scope, page, page_size):
            return {'source': source, 'scope': scope, 'page': page, 'pageSize': page_size, 'httpStatus': 200,
                    'transportError': None, 'body': rtms([], 0), 'observedAt': '2026-02-30T00:00:00Z'}
        with self.assertRaises(ValueError):
            collect_pages('apt_trade', SCOPE, bad_date, page_size=2)

    def test_unhashable_or_unserializable_inputs_raise_value_error(self):
        for value in (bundle(entry(source=['apt_trade'])), bundle(entry(status=None, transportError=['timeout'])),
                      bundle(entry(status=None, transportError={'code': 'timeout'}))):
            with self.assertRaises(ValueError):
                ReplayTransport(value)
        with self.assertRaises(ValueError):
            collect_pages(['apt_trade'], SCOPE, ReplayTransport(bundle()), page_size=2)
        for override in ({'transportError': ['timeout']}, {'scope': {'LAWD_CD': object()}}, {'page': [1]}):
            def fetch(source, scope, page, page_size, override=override):
                return {'source': source, 'scope': scope, 'page': page, 'pageSize': page_size, 'httpStatus': 200,
                        'transportError': None, 'body': rtms([], 0), 'observedAt': OBSERVED, **override}
            with self.assertRaises(ValueError):
                collect_pages('apt_trade', SCOPE, fetch, page_size=2)

    def test_source_json_keeps_decimal_tokens_only_for_amount_and_area(self):
        text = ('{"excluUseAr": 84.970000000000000001, "SUPLY_AR": 112.40, "edition": 1.5, "floor": 7,'
                ' "nested": {"dealAmount": 51500.50}, "list": [1.25, {"LTTOT_TOP_AMOUNT": 7.5e4}], "name": "84.97"}')
        value = loads_source_json(text)
        self.assertEqual((value['excluUseAr'], value['SUPLY_AR'], value['nested']['dealAmount']),
                         ('84.970000000000000001', '112.40', '51500.50'))
        self.assertEqual(value['list'][1]['LTTOT_TOP_AMOUNT'], '7.5e4')
        self.assertEqual([type(value['edition']), type(value['list'][0]), type(value['floor'])], [float, float, int])
        self.assertEqual((type(loads_source_json('2.5')), type(loads_source_json('[[2.5]]')[0][0])), (float, float))
        for invalid in ('{"excluUseAr": NaN}', '{"a": Infinity}', '{"a": 1, "a": 2}', '{"a": {"b": 1, "b": 1}}'):
            with self.assertRaises(ValueError):
                loads_source_json(invalid)
        self.assertEqual(parse_payload(b'{"excluUseAr": 84.10}')[1], {'excluUseAr': 84.1})  # 기존 기본값 유지

    def test_text_bodies_keep_decimal_tokens_through_collection(self):
        body = json.dumps(rtms([trade(1)], 1)).replace('"84.00"', '84.970000000000000001')
        result, _ = self.collect(entry(body))
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['observations'][0]['row']['excluUseAr'], '84.970000000000000001')
        nan, _ = self.collect(entry(body.replace('84.970000000000000001', 'NaN')))
        self.assertEqual(nan['error'], {'code': 'upstream_malformed_response', 'layer': 'parse'})

    def test_object_bodies_with_float_amount_or_area_are_rejected(self):
        lossy = rtms([{**trade(1), 'excluUseAr': 84.97}], 1)
        with self.assertRaises(ValueError):
            ReplayTransport(bundle(entry(lossy)))

        def fetch(source, scope, page, page_size):
            return {'source': source, 'scope': scope, 'page': page, 'pageSize': page_size, 'httpStatus': 200,
                    'transportError': None, 'body': lossy, 'observedAt': OBSERVED}
        with self.assertRaises(ValueError):
            collect_pages('apt_trade', SCOPE, fetch, page_size=2)
        other_float, _ = self.collect(entry(rtms([{**trade(1), 'lat': 37.5}], 1)))  # 금액·면적 외 실수는 허용
        self.assertEqual(other_float['status'], 'complete')

    def test_invalid_requests_are_rejected_before_fetch(self):
        def never(*_):
            raise AssertionError('조회하면 안 됨')
        invalid = [('kakao_address', SCOPE, 2), ('apt_trade', {**SCOPE, 'serviceKey': 'x'}, 2),
                   ('apt_trade', {'LAWD_CD': '9999', 'DEAL_YMD': '202610'}, 2),
                   ('apt_trade', {'LAWD_CD': '99999', 'DEAL_YMD': '202613'}, 2),
                   ('applyhome_apt', {**NOTICE, 'page': '1'}, 2), ('applyhome_apt', {'cond[X::EQ]': ' 1'}, 2),
                   ('apt_trade', SCOPE, 0), ('apt_trade', SCOPE, True)]
        for source, scope, size in invalid:
            with self.assertRaises(ValueError):
                collect_pages(source, scope, never, page_size=size)


def probe_result(status, **extra):
    return {'probe': 'synthetic', 'status': status, 'checked_at': '2026-11-10T00:00:00.123456+00:00', **extra}


def probe_success(text, rewritten=False):
    """run_probe 반환 형태의 합성 성공 결과: (결과, 정제 텍스트, float 해석 사본)."""
    hashes = {'response_sha256': 'a' * 64, 'sanitized_response_sha256': ('b' if rewritten else 'a') * 64}
    return probe_result('success', http_status=200, format='json', **hashes), text, json.loads(text)


class LiveAdapterTests(unittest.TestCase):
    """실제 호출 어댑터를 가짜 probe로 검사한다. 네트워크·키 파일을 쓰지 않는다."""

    def fake(self, *results):
        calls = []
        queue = list(results)

        def probe(name, spec, keys, overrides):
            calls.append((name, spec, keys, overrides))
            return queue.pop(0)
        return probe, calls

    def test_success_uses_scope_and_paging_overrides(self):
        probe, calls = self.fake(probe_success(json.dumps(rtms([trade(1)], 1))))
        transport = LiveProbeTransport({'apt_trade': {'name': 'spec'}}, {'K': 'synthetic'}, probe=probe)
        result = collect_pages('apt_trade', SCOPE, transport, page_size=2)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['collectedAt'], '2026-11-10T00:00:00.123456+00:00')
        self.assertEqual(calls[0][0], 'apt_trade')
        self.assertEqual(calls[0][3], {'LAWD_CD': '99999', 'DEAL_YMD': '202610', 'pageNo': 1, 'numOfRows': 2})
        probe, calls = self.fake(probe_success(json.dumps(odcloud([{}], match=1))))
        collect_pages('applyhome_apt', NOTICE, LiveProbeTransport({'applyhome_apt': {}}, {}, probe=probe), page_size=2)
        self.assertEqual(calls[0][3], {**NOTICE, 'page': 1, 'perPage': 2})

    def test_probe_statuses_map_to_upstream_errors(self):
        cases = [
            (probe_result('network_error', error='URLError(timeout)'), None, ('upstream_timeout', 'network')),
            (probe_result('network_error', error='URLError(ConnectionRefusedError) errno=61'), None,
             ('upstream_unavailable', 'network')),
            (probe_result('http_error', http_status=401), '{"code": -4, "msg": "합성"}', ('upstream_auth_rejected', 'http')),
            (probe_result('api_error', http_status=200), json.dumps(rtms([], 0, code='30')),
             ('upstream_business_error', 'business')),
            (probe_result('response_too_large', http_status=200), None, ('upstream_response_too_large', 'parse')),
            (probe_result('redaction_failed', http_status=200), None, ('upstream_malformed_response', 'parse')),
            (probe_result('parse_error', http_status=200), None, ('upstream_malformed_response', 'parse')),
        ]
        for result, text, (code, layer) in cases:
            probe, _ = self.fake((result, text, None if text is None or not text.startswith('{') else json.loads(text)))
            collected = collect_pages('apt_trade', SCOPE, LiveProbeTransport({'apt_trade': {}}, {}, probe=probe), page_size=2)
            self.assertEqual((collected['status'], collected['error']), ('failed', {'code': code, 'layer': layer}))

    def test_safe_text_keeps_decimal_tokens_and_rewritten_json_is_held(self):
        text = json.dumps(rtms([trade(1)], 1)).replace('"84.00"', '84.970000000000000001')
        cases = [(probe_success(text), 'complete'),  # 원문 그대로인 정제 사본: 토큰 보존
                 (probe_success(text, rewritten=True), 'failed'),  # 재직렬화된 JSON의 면적 실수: 쪽 보류
                 (probe_success(json.dumps(rtms([trade(1)], 1)), rewritten=True), 'complete'),  # 문자열 면적
                 (probe_success(json.dumps(rtms([{**trade(1), 'lat': 37.5}], 1)), rewritten=True), 'complete')]
        for returned, status in cases:
            probe, _ = self.fake(returned)
            result = collect_pages('apt_trade', SCOPE, LiveProbeTransport({'apt_trade': {}}, {}, probe=probe), page_size=2)
            self.assertEqual(result['status'], status)
        self.assertEqual(result['observations'][0]['row']['lat'], 37.5)
        probe, _ = self.fake(probe_success(text))
        kept = collect_pages('apt_trade', SCOPE, LiveProbeTransport({'apt_trade': {}}, {}, probe=probe), page_size=2)
        self.assertEqual(kept['observations'][0]['row']['excluUseAr'], '84.970000000000000001')
        probe, _ = self.fake(probe_success(text, rewritten=True))
        held = collect_pages('apt_trade', SCOPE, LiveProbeTransport({'apt_trade': {}}, {}, probe=probe), page_size=2)
        self.assertEqual(held['error'], {'code': 'upstream_malformed_response', 'layer': 'parse'})
        self.assertIn('decimal_precision_unverified', held['reasons'])
        with self.assertRaises(ValueError):  # 재생 입력은 이 보류 코드를 직접 쓰지 않는다
            ReplayTransport(bundle(entry(status=None, transportError='precision_unverified')))

    def test_real_probe_config_error_stops_without_network(self):
        specs = json.loads((ROOT / 'docs/api/probes.json').read_text())['probes']
        self.assertIs(LiveProbeTransport(specs, {})._probe, run_probe)
        with self.assertRaises(RuntimeError) as raised:  # 키가 없으면 run_probe가 요청 전에 돌아온다
            collect_pages('apt_trade', SCOPE, LiveProbeTransport(specs, {}), page_size=2)
        self.assertIn('missing_key', str(raised.exception))
        self.assertFalse(hasattr(ingestion_pages, 'read_keys'))


if __name__ == '__main__':
    unittest.main()
