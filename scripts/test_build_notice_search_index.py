"""공고 탐색 색인 검사는 합성 응답·주소·공식 경로 모형만 사용한다."""
import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta
from email.message import Message
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.request import HTTPHandler, build_opener
from urllib.response import addinfourl

from build_notice_search_index import SEOUL, build_notice_search_index, main, publish_index, read_region_codes
from ingestion_pages import ReplayTransport
from notice_pdf_fields import inspect_extracted_pages
from test_notice_pdf_fields import synthetic_pages
from worker_rpc import WorkerRpc

APT = 'applyhome_apt'
REMAINDER = 'applyhome_remainder'
HOUSE = '9900000001'
NOTICE = '9900000042'
START, END = '2026-10-01', '2026-10-31'
OBSERVED = '2026-10-05T19:00:00Z'  # 서울 기준 10월 6일
SCOPE = {'cond[RCRIT_PBLANC_DE::GTE]': START, 'cond[RCRIT_PBLANC_DE::LTE]': END}
REGION_TSV = """법정동코드\t법정동명\t폐지여부
1100000000\t서울특별시\t존재
1199100000\t서울특별시 합성구\t존재
1199110100\t서울특별시 합성구 가람동\t존재
1199200000\t서울특별시 경계구\t폐지
1199300000\t서울특별시 모호구\t존재
1199400000\t서울특별시 모호구\t존재
1199500000\t서울특별시 보류구\t
4100000000\t경기도\t존재
4188800000\t경기도 합성시\t존재
4199100000\t경기도 합성시 합성구\t존재
4199100100\t경기도 합성시 합성구 가람동\t존재
4198100000\t경기도 혼합시\t존재
4198200000\t경기도 혼합시\t존재
4198300000\t경기도 혼합시 다중구\t존재
4198400000\t경기도 혼합시 신축지구\t존재
4199700000\t경기도 합성군\t존재
4199731000\t경기도 합성군 실험면\t존재
4199600000\t경기도 미분류권역\t존재
3611000000\t세종특별자치시\t존재
3611010100\t세종특별자치시 예시동\t존재
"""


def endpoint_row(source=APT, **changes):
    fields = {'HOUSE_MANAGE_NO': HOUSE, 'PBLANC_NO': NOTICE,
              'HOUSE_NM': '[합성] 가람 아파트', 'HSSPLY_ADRES': '서울 합성구 가람동 123번지',
              'HOUSE_SECD': '01', 'HOUSE_SECD_NM': 'APT', 'RENT_SECD': '0', 'RENT_SECD_NM': '분양주택',
              'RCRIT_PBLANC_DE': '2026-10-05', 'RCEPT_BGNDE': '2026-10-06', 'RCEPT_ENDDE': '2026-10-06',
              'MVN_PREARNGE_YM': '202812', 'TOT_SUPLY_HSHLDCO': 2}
    if source == REMAINDER:
        fields.update(HOUSE_SECD='06', HOUSE_SECD_NM='불법행위 재공급',
                      SUBSCRPT_RCEPT_BGNDE=fields.pop('RCEPT_BGNDE'),
                      SUBSCRPT_RCEPT_ENDDE=fields.pop('RCEPT_ENDDE'),
                      MVN_PREARNGE_YM='2028-12')
    return dict(fields, **changes)


def model(**changes):
    return dict({'HOUSE_MANAGE_NO': HOUSE, 'PBLANC_NO': NOTICE, 'MODEL_NO': '01', 'HOUSE_TY': '084.0000A',
                 'SUPLY_AR': '112.40', 'LTTOT_TOP_AMOUNT': '75,000', 'SUPLY_HSHLDCO': 2, 'SPSPLY_HSHLDCO': 0},
                **changes)


def page(source, rows, *, scope=SCOPE, number=1, size=10, count=None):
    return {'source': source, 'scope': scope, 'page': number, 'pageSize': size, 'httpStatus': 200,
            'observedAt': OBSERVED, 'body': {'page': number, 'perPage': size, 'currentCount': len(rows),
                                             'matchCount': len(rows) if count is None else count,
                                             'totalCount': 800, 'data': rows}}


def detail(row, models, *, source=APT, size=10):
    scope = {'cond[HOUSE_MANAGE_NO::EQ]': str(row['HOUSE_MANAGE_NO']), 'cond[PBLANC_NO::EQ]': str(row['PBLANC_NO'])}
    return [page(source, [row], scope=scope, size=size),
            page(source + '_model', models, scope=scope, size=size)]


def official_paths():
    query = f'houseManageNo={HOUSE}&pblancNo={NOTICE}'
    return (
        f'https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?{query}',
        f'https://static.applyhome.co.kr/ai/aia/getAtchmnfl.do?{query}&atchmnflSeqNo=5555&atchmnflSn=1',
    )


def get_synthetic_documents(url, *, max_bytes, timeout):
    detail_url, pdf_url = official_paths()
    if url == detail_url:
        html = '<a href="' + pdf_url.replace('&', '&amp;') + '">모집공고문 보기</a>'
        return {'status': 200, 'headers': {'content-type': 'text/html; charset=utf-8'}, 'body': html.encode()}
    if url == pdf_url:
        return {'status': 200, 'headers': {'content-type': 'application/pdf'},
                'body': b'%PDF-1.4\nsynthetic\n%%EOF\n'}
    raise AssertionError('합성 공식 문서의 주소가 다릅니다.')


def inspect_synthetic_pages(content, **kwargs):
    return inspect_extracted_pages(synthetic_pages(), **kwargs)


def inspect_two_complete_rooms(content, *, target, catalog, document):
    evidence = [{'document': document, 'page': 2, 'modelNo': '01', 'houseType': '084.0000A',
                 'item': 'supply_area', 'check': 'confirmed', 'basis': 'supply', 'unit': 'm2', 'm2': '112.4000'}]
    for room in ('101동 101호', '101동 102호'):
        for item, amount, page_no in [('sale_price', '700000000', 2), ('required_options', '10000000', 3)]:
            evidence.append({'document': document, 'page': page_no, 'modelNo': '01', 'houseType': '084.0000A',
                             'item': item, 'check': 'confirmed', 'room': room, 'won': amount})
    return {'status': 'checked', 'evidence': evidence, 'issues': []}


class NoticeSearchIndexTests(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.region_file = Path(work.name) / '법정동코드 전체자료.txt'
        self.region_file.write_bytes(REGION_TSV.encode('cp949'))
        self.regions = read_region_codes(self.region_file)

    def build(self, entries, **kwargs):
        fetch = ReplayTransport({'dataOrigin': 'synthetic', 'pages': entries})
        budget = {'page_size': 10, 'max_detail_notices': 0, 'observed_at': OBSERVED, **kwargs}
        result = build_notice_search_index(START, END, self.regions, fetch, **budget)
        return result, fetch

    def test_official_tsv_requires_active_full_name_prefix(self):
        cases = {
            '서울특별시 합성구 가람동 10': '11991',
            '서울  합성구\t가람로 12': '11991',
            '세종 예시동 1': '36110',
            '경기 합성군 실험면 1': '41997',
            '경기 합성군 합성택지지구 B1블록': '41997',
            '서울 합성구 신규지구 1': '11991',
            '경기 합성군 신축지구 1': None,
            '경기도 합성시 합성택지지구 1': None,
            '인천 합성신도시 1': None,
            '경기도 합성시 합성구 가람동 1': '41991',
            '경기도 합성시 가람동 1': None,
            '경기도 합성시 합성구역 1': None,
            '서울 경계구 가람동 1': None,
            '서울 보류구 가람동 1': None,
            '서울 모호구 가람동 1': None,
            '서울 합성구역 1': None,
            '서울 합성구 경계구 가람동 1': None,
            '합성구 가람동 1': None,
        }
        self.region_file.write_bytes(REGION_TSV.encode('utf-8-sig'))
        for regions in (self.regions, read_region_codes(self.region_file)):
            for address, expected in cases.items():
                with self.subTest(address=address):
                    self.assertEqual(regions.resolve(address), expected)

    def test_empty_requires_normal_zero_from_both_official_list_scopes(self):
        index, fetch = self.build([page(s, []) for s in (APT, REMAINDER)])
        self.assertEqual(index, {
            'contractVersion': 'notice-search-index/v1', 'dataOrigin': 'synthetic', 'observedAt': OBSERVED,
            'publicationWindow': {'start': START, 'end': END}, 'coverage': {
                'status': 'complete', 'sources': [{'source': s, 'status': 'empty'} for s in (APT, REMAINDER)]},
            'regionCodes': ['11991', '11993', '11994', '36110', '41888', '41981', '41982', '41983', '41984',
                            '41991', '41997'],
            'notices': [],
        })
        self.assertEqual([json.loads(call) for call in fetch.requests], [[s, SCOPE, 1, 10] for s in (APT, REMAINDER)])
        partial, _ = self.build([page(APT, [])])
        unavailable, _ = self.build([])
        self.assertEqual(partial['coverage']['status'], 'partial')
        self.assertEqual(unavailable['coverage']['status'], 'unavailable')

    def test_caps_missing_ids_and_wrong_publication_scope_leave_partial_coverage(self):
        row = endpoint_row(RCRIT_PBLANC_DE=START)
        capped, fetch = self.build([page(APT, [row], size=1, count=2), page(REMAINDER, [], size=1)],
                                   page_size=1, max_pages=1)
        self.assertEqual(len(fetch.requests), 2)
        self.assertEqual(capped['coverage']['sources'][0]['status'], 'partial')
        self.assertEqual(len(capped['notices']), 1)
        bad_date = endpoint_row(PBLANC_NO='9900000043', RCRIT_PBLANC_DE=None)
        wrong_scope = endpoint_row(PBLANC_NO='9900000044', RCRIT_PBLANC_DE='2026-11-01')
        result, _ = self.build([page(APT, [row, endpoint_row(PBLANC_NO=True), bad_date, wrong_scope]),
                                page(REMAINDER, [endpoint_row(REMAINDER, RCRIT_PBLANC_DE=END, PBLANC_NO='9900000045')])])
        self.assertEqual(result['coverage']['status'], 'partial')
        self.assertEqual([n['noticeNo'] for n in result['notices']], [NOTICE, '9900000043', '9900000045'])
        held = result['notices'][1]
        self.assertIn('publication_date_unverified', held['reasonCodes'])
        self.assertEqual(held['edition'], 'public')
        self.assertFalse(held['inventoryComplete'])

    def test_general_district_parent_comes_from_unique_active_full_path(self):
        district = endpoint_row(HSSPLY_ADRES='경기 합성시 합성구 가람동 1')
        ambiguous = endpoint_row(PBLANC_NO='9900000043', HSSPLY_ADRES='경기 혼합시 다중구 다중로 1')
        no_district = endpoint_row(PBLANC_NO='9900000044', HSSPLY_ADRES='경기 합성군 실험면 1')
        result, _ = self.build([page(APT, [district, ambiguous, no_district]), page(REMAINDER, [])])
        district, ambiguous, county = result['notices']
        self.assertEqual((district['regionCode'], district['parentRegionCode']), ('41991', '41888'))
        self.assertEqual(ambiguous['regionCode'], '41983')
        self.assertNotIn('parentRegionCode', ambiguous)
        self.assertNotIn('parentRegionCode', county)
        self.assertTrue({district['regionCode'], district['parentRegionCode']} <= set(result['regionCodes']))
        self.assertNotIn('합성시', json.dumps(result, ensure_ascii=False))

    def test_pair_deduplicates_integer_and_string_and_holds_cross_source_conflicts(self):
        apt = endpoint_row()
        same = dict(apt, HOUSE_MANAGE_NO=int(HOUSE), PBLANC_NO=int(NOTICE))
        result, _ = self.build([page(APT, [apt, same]), page(REMAINDER, [])])
        self.assertEqual(len(result['notices']), 1)
        self.assertEqual(result['notices'][0]['kind'], 'new_sale')
        self.assertEqual(result['notices'][0]['edition'], '2026-10-05')
        remainder = endpoint_row(REMAINDER, RCRIT_PBLANC_DE='2026-10-07', HOUSE_NM='[합성] 다른 공고',
                                 HSSPLY_ADRES='경기도 합성시 합성구 가람동 123')
        result, fetch = self.build([page(APT, [apt]), page(REMAINDER, [remainder])], max_detail_notices=5)
        held, = result['notices']
        self.assertEqual(held['sourceIds'], [APT, REMAINDER])
        self.assertEqual((held['kind'], held['title'], held['regionCode']), ('unknown', None, None))
        self.assertEqual(held['edition'], 'public')
        self.assertNotIn('parentRegionCode', held)
        self.assertIn('notice_metadata_conflict', held['reasonCodes'])
        self.assertFalse(held['inventoryComplete'])
        self.assertEqual(len(fetch.requests), 2)

    def test_type_and_schedules_are_verified_per_endpoint(self):
        rows = [
            (APT, {}, 'new_sale'),
            (APT, {'HOUSE_SECD': '02', 'HOUSE_SECD_NM': '오피스텔', 'HOUSE_DTL_SECD': '02',
                   'HOUSE_DTL_SECD_NM': '오피스텔'}, 'unsupported'),
            (APT, {'HOUSE_SECD': '02', 'HOUSE_SECD_NM': '도시형생활주택', 'HOUSE_DTL_SECD': '01',
                   'HOUSE_DTL_SECD_NM': '도시형생활주택'}, 'unsupported'),
            (APT, {'HOUSE_SECD': '02', 'HOUSE_SECD_NM': '도시형', 'HOUSE_DTL_SECD': '01',
                   'HOUSE_DTL_SECD_NM': '도시형생활주택'}, 'unsupported'),
            (APT, {'HOUSE_SECD': '02', 'HOUSE_SECD_NM': '오피스텔'}, 'unsupported'),
            (APT, {'HOUSE_SECD': '02', 'HOUSE_SECD_NM': '오피스텔', 'HOUSE_DTL_SECD': '01',
                   'HOUSE_DTL_SECD_NM': '도시형생활주택'}, 'unknown'),
            (APT, {'HOUSE_SECD_NM': '오피스텔'}, 'unknown'),
            (APT, {'RENT_SECD': 1, 'RENT_SECD_NM': '분양전환 가능임대'}, 'unsupported'),
            (REMAINDER, {'HOUSE_SECD': 4, 'HOUSE_SECD_NM': '무순위'}, 'unranked'),
            (REMAINDER, {'HOUSE_SECD': '04', 'HOUSE_SECD_NM': '잔여세대'}, 'remaining'),
            (REMAINDER, {'HOUSE_SECD': '04', 'HOUSE_SECD_NM': 'APT 무순위/잔여세대'}, 'unknown'),
            (REMAINDER, {'HOUSE_SECD': '04', 'HOUSE_SECD_NM': '불법행위 재공급'}, 'unknown'),
            (REMAINDER, {'HOUSE_SECD_NM': '계약취소주택'}, 'resupply'),
        ]
        for source, values, kind in rows:
            with self.subTest(kind=kind, values=values):
                source_rows = {s: [endpoint_row(s, **values)] if s == source else [] for s in (APT, REMAINDER)}
                result, _ = self.build([page(s, records) for s, records in source_rows.items()])
                self.assertEqual(result['notices'][0]['kind'], kind)
                self.assertEqual(result['notices'][0]['moveIn'], {'start': '2028-12', 'end': '2028-12'})
        apt = endpoint_row(RCEPT_ENDDE='2026-10-08', GNRL_RNK1_CRSPAREA_RCPTDE='2026-10-06',
                           GNRL_RNK2_CRSPAREA_RCPTDE='2026-10-08')
        rem = endpoint_row(REMAINDER, PBLANC_NO='9900000043', GNRL_RCEPT_BGNDE='2026-10-06')
        title_only = endpoint_row(REMAINDER, PBLANC_NO='9900000044', SUBSCRPT_RCEPT_ENDDE='',
                                  HOUSE_NM='[합성] 2026-10-05~2026-10-08 청약')
        index, _ = self.build([page(APT, [apt]), page(REMAINDER, [rem, title_only])])
        split, partial, unreported = index['notices']
        self.assertEqual(split['application'], {'start': '2026-10-06', 'end': '2026-10-08'})
        self.assertEqual(split['applicationSegments'], [{'start': day, 'end': day}
                                                        for day in ('2026-10-06', '2026-10-08')])
        self.assertIn('application_split', split['reasonCodes'])
        self.assertEqual(partial['application'], {'start': '2026-10-06', 'end': '2026-10-06'})
        self.assertEqual(partial['applicationSegments'], [])
        self.assertIn('application_unverified', partial['reasonCodes'])
        self.assertIsNone(unreported['application'])
        self.assertNotIn('applicationSegments', unreported)

    def test_application_ranges_merge_adjacent_phases_and_discard_outside_dates(self):
        merged = endpoint_row(RCEPT_ENDDE='2026-10-08', SPSPLY_RCEPT_BGNDE='2026-10-06',
                              SPSPLY_RCEPT_ENDDE='2026-10-07', GNRL_RNK1_CRSPAREA_RCPTDE='2026-10-07',
                              GNRL_RNK2_CRSPAREA_RCPTDE='2026-10-08')
        outside = endpoint_row(REMAINDER, PBLANC_NO='9900000043', SUBSCRPT_RCEPT_ENDDE='2026-10-08',
                               SPSPLY_RCEPT_BGNDE='2026-10-04', SPSPLY_RCEPT_ENDDE='2026-10-06',
                               GNRL_RCEPT_BGNDE='2026-10-07', GNRL_RCEPT_ENDDE='2026-10-08')
        index, _ = self.build([page(APT, [merged]), page(REMAINDER, [outside])])
        continuous, held = index['notices']
        self.assertEqual(continuous['application'], {'start': '2026-10-06', 'end': '2026-10-08'})
        self.assertNotIn('applicationSegments', continuous)
        self.assertNotIn('application_split', continuous['reasonCodes'])
        self.assertEqual(held['application'], continuous['application'])
        self.assertEqual(held['applicationSegments'], [{'start': '2026-10-07', 'end': '2026-10-08'}])
        self.assertIn('application_unverified', held['reasonCodes'])

    def test_conflicting_segment_dates_hold_open_days_and_keep_matching_outer_dates(self):
        one = endpoint_row(RCEPT_ENDDE='2026-10-08', GNRL_RNK1_CRSPAREA_RCPTDE='2026-10-06')
        other = dict(one, GNRL_RNK1_CRSPAREA_RCPTDE='2026-10-07')
        index, _ = self.build([page(APT, [one, other]), page(REMAINDER, [])])
        candidate, = index['notices']
        self.assertEqual(candidate['application'], {'start': '2026-10-06', 'end': '2026-10-08'})
        self.assertEqual(candidate['applicationSegments'], [])
        self.assertIn('notice_metadata_conflict', candidate['reasonCodes'])

    def test_detail_priority_keeps_closed_and_unknown_notices_in_the_index(self):
        closed = endpoint_row(PBLANC_NO='9900000040', RCEPT_BGNDE='2026-10-05', RCEPT_ENDDE='2026-10-05')
        unknown = endpoint_row(PBLANC_NO='9900000041', RCEPT_ENDDE=None)
        opens = endpoint_row()
        routes = [page(APT, [closed, unknown, opens]), page(REMAINDER, []), *detail(opens, [model()])]
        index, fetch = self.build(routes, max_detail_notices=1)
        self.assertEqual([n['noticeNo'] for n in index['notices']], ['9900000040', '9900000041', NOTICE])
        self.assertEqual(index['notices'][0]['application']['end'], '2026-10-05')
        self.assertIsNone(index['notices'][1]['application'])
        self.assertEqual([json.loads(call)[1].get('cond[PBLANC_NO::EQ]') for call in fetch.requests[2:]],
                         [NOTICE, NOTICE])
        self.assertIn('detail_budget_exhausted', index['notices'][0]['reasonCodes'])

    def test_checked_item_pages_stay_with_exact_model_and_room(self):
        row = endpoint_row(PBLANC_URL=official_paths()[0])
        routes = [page(APT, [row]), page(REMAINDER, []), *detail(row, [model()])]
        index, _ = self.build(routes, max_detail_notices=1, document_fetch=get_synthetic_documents,
                              document_inspect=inspect_synthetic_pages)
        notice, = index['notices']
        housing, = notice['models']
        self.assertEqual(notice['sourceIds'], [APT, APT + '_model', 'applyhome_notice_pdf'])
        good, held = housing['rooms']
        self.assertEqual(housing['supplyAreaM2'], '112.4000')
        self.assertEqual([ref['page'] for ref in housing['areaEvidence']], [2])
        self.assertEqual((good['room'], good['subtotalWon']), ('101동 101호', '710000000'))
        self.assertEqual([ref['page'] for ref in good['priceEvidence']], [2, 3])
        self.assertEqual((held['room'], held['subtotalWon'], held['priceEvidence']), ('101동 102호', None, []))
        for ref in housing['areaEvidence'] + good['priceEvidence']:
            self.assertEqual(set(ref), {'document', 'version', 'page'})
            self.assertTrue(ref['document'].startswith(f'applyhome:{HOUSE}:{NOTICE}:'))
            self.assertTrue(ref['version'].startswith('sha256:'))
        self.assertFalse(notice['inventoryComplete'])
        self.assertNotIn('https://', json.dumps(index))

    def test_inventory_requires_all_matching_model_counts_and_official_item_refs(self):
        row = endpoint_row(PBLANC_URL=official_paths()[0])
        options = {'max_detail_notices': 1, 'document_fetch': get_synthetic_documents,
                   'document_inspect': inspect_two_complete_rooms}
        for count, expected in [(2, True), (3, False), (None, False)]:
            candidate = dict(row, TOT_SUPLY_HSHLDCO=count)
            result, _ = self.build([page(APT, [candidate]), page(REMAINDER, []),
                                    *detail(candidate, [model()])], **options)
            self.assertEqual(result['notices'][0]['inventoryComplete'], expected)

        def inspect_with_upload(content, **kwargs):
            result = inspect_two_complete_rooms(content, **kwargs)
            for evidence in result['evidence']:
                if evidence.get('item') == 'required_options':
                    evidence['document'] = dict(evidence['document'], id='upload:synthetic', source='upload')
            return result

        options['document_inspect'] = inspect_with_upload
        result, _ = self.build([page(APT, [row]), page(REMAINDER, []), *detail(row, [model()])], **options)
        candidate, = result['notices']
        self.assertFalse(candidate['inventoryComplete'])
        self.assertTrue(all(room['subtotalWon'] is None for room in candidate['models'][0]['rooms']))
        self.assertNotIn('upload:', json.dumps(result))

    def test_detail_pages_and_document_requests_are_bounded(self):
        row = endpoint_row(PBLANC_URL=official_paths()[0])
        exact = detail(row, [model()])
        exact[1]['body'].update(data=[model(MODEL_NO=f'{n:02}') for n in range(1, 11)],
                                matchCount=11, currentCount=10)
        docs = Mock(side_effect=get_synthetic_documents)
        result, fetch = self.build([page(APT, [row]), page(REMAINDER, []), *exact],
                                   max_detail_notices=1, max_detail_pages=1, document_fetch=docs)
        self.assertEqual(len(fetch.requests), 4)
        self.assertFalse(result['notices'][0]['inventoryComplete'])
        self.assertIn('detail_page_limit_reached', result['notices'][0]['reasonCodes'])
        docs.assert_not_called()
        result, _ = self.build([page(APT, [row]), page(REMAINDER, []), *detail(row, [model()])],
                               max_detail_notices=1, max_document_requests=1, document_fetch=docs)
        self.assertEqual(docs.call_count, 1)
        self.assertFalse(result['notices'][0]['inventoryComplete'])
        self.assertIn('document_budget_exhausted', result['notices'][0]['reasonCodes'])

    def test_changed_exact_scope_metadata_is_held_before_reading_documents(self):
        row = endpoint_row(PBLANC_URL=official_paths()[0])
        changed = dict(row, HSSPLY_ADRES='경기도 합성시 합성구 가람동 10')
        docs = Mock()
        result, _ = self.build([page(APT, [row]), page(REMAINDER, []), *detail(changed, [model()])],
                               max_detail_notices=1, document_fetch=docs)
        candidate, = result['notices']
        self.assertIsNone(candidate['regionCode'])
        self.assertFalse(candidate['inventoryComplete'])
        self.assertEqual(candidate['models'], [])
        self.assertIn('notice_metadata_conflict', candidate['reasonCodes'])
        docs.assert_not_called()

    def test_public_labels_and_reasons_fit_the_publication_contract(self):
        row = endpoint_row(PBLANC_URL=official_paths()[0], HOUSE_NM='합성 거주지 www.example.invalid')
        result, _ = self.build([page(APT, [row]), page(REMAINDER, []),
                                *detail(row, [model(HOUSE_TY='합성@문자열')])], max_detail_notices=1)
        candidate, = result['notices']
        self.assertIsNone(candidate['title'])
        self.assertIsNone(candidate['models'][0]['houseType'])
        self.assertEqual(candidate['sourceIds'], [APT, APT + '_model'])
        self.assertEqual(candidate['reasonCodes'],
                         ['inventory_incomplete', 'price_unverified', 'source_unverified', 'supply_area_unverified'])

    def test_publication_accepts_postgrest_void_response_through_worker_rpc(self):
        requests = []

        class VoidTransport(HTTPHandler):
            def http_open(self, call):
                requests.append((call.method, call.selector, json.loads(call.data)))
                response = addinfourl(io.BytesIO(b''), Message(), call.full_url, code=204)
                response.msg = 'No Content'
                return response

        client = WorkerRpc({'SUPABASE_URL': 'http://127.0.0.1:54321',
                            'SUPABASE_WORKER_KEY': 'sb_secret_' + 'synthetic'}, opener=build_opener(VoidTransport()))
        index = {'contractVersion': 'notice-search-index/v1', 'dataOrigin': 'collected', 'regionCodes': ['11991']}
        self.assertIsNone(publish_index(index, client))
        self.assertEqual(requests, [('POST', '/rest/v1/rpc/publish_notice_search_index', {'p_index': index})])

    def test_publication_size_caps_keep_priority_and_mark_missing_search_scope(self):
        row = endpoint_row(PBLANC_URL=official_paths()[0])
        closed = endpoint_row(PBLANC_NO='9900000040', RCEPT_BGNDE='2026-10-05', RCEPT_ENDDE='2026-10-05')
        routes = [page(APT, [closed, row]), page(REMAINDER, []), *detail(row, [model()])]
        with patch('build_notice_search_index.MAX_NOTICES', 1):
            index, _ = self.build(routes)
        self.assertEqual([candidate['noticeNo'] for candidate in index['notices']], [NOTICE])
        self.assertEqual(index['coverage']['status'], 'partial')
        with patch('build_notice_search_index.MAX_INDEX_BYTES', 1600):
            index, _ = self.build(routes, max_detail_notices=1, document_fetch=get_synthetic_documents,
                                  document_inspect=inspect_two_complete_rooms)
        enriched = index['notices'][1]
        self.assertEqual(enriched['models'], [])
        self.assertEqual(enriched['sourceIds'], [APT])
        self.assertIn('inventory_incomplete', enriched['reasonCodes'])
        self.assertEqual(index['coverage']['status'], 'complete')

    def test_cli_is_offline_and_synthetic_cannot_be_published(self):
        with (redirect_stdout(io.StringIO()) as stdout,
              patch('build_notice_search_index.live_api_transport') as live):
            self.assertEqual(main(['--start', START, '--end', END]), 0)
        summary = json.loads(stdout.getvalue())
        self.assertEqual((summary['dataOrigin'], summary['status'], summary['noticeCount']), ('synthetic', 'built', 0))
        self.assertNotIn('notices', summary)
        live.assert_not_called()
        with redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(main(['--start', START, '--end', END, '--full-index']), 0)
        self.assertEqual(json.loads(stdout.getvalue())['regionCodes'], [])
        self.assertEqual(json.loads(stdout.getvalue())['notices'], [])
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            main(['--start', START, '--end', END, '--publish'])
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            main(['--live', '--start', START, '--end', END, '--region-codes', str(self.region_file),
                  '--publish', '--full-index'])
        rpc = Mock()
        index, _ = self.build([page(APT, []), page(REMAINDER, [])])
        with self.assertRaises(ValueError):
            publish_index(index, rpc)
        rpc.post.assert_not_called()
        collected = dict(index, dataOrigin='collected')
        with self.assertRaises(ValueError):
            publish_index(dict(collected, regionCodes=[]), rpc)
        rpc.post.assert_not_called()
        publish_index(collected, rpc)
        rpc.post.assert_called_once_with('publish_notice_search_index', {'p_index': collected}, allow_no_content=True)

    def test_historical_live_build_and_successful_publication_use_summary_only(self):
        args = ['--live', '--region-codes', str(self.region_file), '--summary', '--page-size', '10']
        old = ReplayTransport({'dataOrigin': 'synthetic', 'pages': [page(s, []) for s in (APT, REMAINDER)]})
        with (patch('build_notice_search_index.live_api_transport', return_value=old),
              patch('build_notice_search_index.make_live_fetch'),
              patch('build_notice_search_index.WorkerRpc') as client, redirect_stdout(io.StringIO()) as stdout):
            self.assertEqual(main([*args, '--start', START, '--end', END]), 0)
        client.assert_not_called()
        summary = json.loads(stdout.getvalue())
        self.assertEqual(summary['publicationWindow'], {'start': START, 'end': END})
        self.assertEqual((summary['dataOrigin'], summary['status']), ('collected', 'built'))
        self.assertNotIn('notices', summary)

        today_date = datetime.now(SEOUL).date()
        today = today_date.isoformat()
        tomorrow = (today_date + timedelta(days=1)).isoformat()
        with (patch('build_notice_search_index.live_api_transport') as live, redirect_stderr(io.StringIO()),
              self.assertRaises(SystemExit)):
            main([*args, '--start', today, '--end', tomorrow, '--publish'])
        live.assert_not_called()
        scope = {'cond[RCRIT_PBLANC_DE::GTE]': today, 'cond[RCRIT_PBLANC_DE::LTE]': today}
        current = ReplayTransport({'dataOrigin': 'synthetic',
                                   'pages': [page(s, [], scope=scope) for s in (APT, REMAINDER)]})
        with (patch('build_notice_search_index.live_api_transport', return_value=current),
              patch('build_notice_search_index.make_live_fetch'),
              patch('build_notice_search_index.WorkerRpc') as client, redirect_stdout(io.StringIO()) as stdout):
            self.assertEqual(main([*args, '--start', today, '--end', today, '--publish']), 0)
        sent = client.return_value.post.call_args.args[1]['p_index']
        self.assertTrue(sent['regionCodes'])
        self.assertEqual(client.return_value.post.call_args.kwargs, {'allow_no_content': True})
        summary = json.loads(stdout.getvalue())
        self.assertEqual((summary['status'], summary['noticeCount']), ('published', 0))
        self.assertNotIn('notices', summary)
        self.assertNotIn('regionCodes', summary)


if __name__ == '__main__':
    unittest.main()
