"""공고 PDF 필드 점검 경계 검사. 모든 공고·호실·금액은 합성 자료이며 실제 공고가 아니다.

하나의 표 배치 명세(synthetic_notice_spec)에서 실제 PDF 바이트(build_synthetic_notice_pdf, PyMuPDF 필요)와
같은 내용의 추출 결과(synthetic_pages, 표준 라이브러리만)를 만든다. 값은 tests/fixtures/ingestion-v0.json과 맞춘다.
통합 재생 검사도 build_synthetic_notice_pdf·synthetic_document·synthetic_catalog_inputs를 재사용한다.
"""
import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import notice_pdf_fields as fields_module
from extract_notice_pdf import IDENTITY_PATTERN, find_identities
from ingestion_notices import _record_problem, normalize_catalog
from notice_pdf_fields import CONTRACT, STATUSES, inspect_extracted_pages, inspect_notice_pdf, reported_notice_date

FIXTURE = Path(__file__).resolve().parents[1] / 'tests' / 'fixtures' / 'ingestion-v0.json'
HAS_FITZ = importlib.util.find_spec('fitz') is not None
PAGE_WIDTH, PAGE_HEIGHT = 841, 595


def _table(x, y, widths, heights, cells, spans):
    return {'x': x, 'y': y, 'widths': widths, 'heights': heights, 'cells': cells, 'spans': spans}


def synthetic_notice_spec():
    """합성 재공급 공고 3쪽: 식별 문장(최초 공고 번호 포함), 공급대상·공급금액 표, 참고표·옵션표·납부계좌 표."""
    area = _table(40, 80, [50, 70, 40, 90, 70, 70, 70, 70, 80, 70, 70], [14, 14, 16], [
        ['주택구분', '주택관리번호', '모델', '주택형(전용면적기준)', '약식표기(타입)', '주택공급면적(㎡)', None, None,
         '기타공용면적', '계약면적', '일반공급세대수'],
        [None, None, None, None, None, '주거전용면적', '주거공용면적', '소계', None, None, None],
        ['민영', '{houseManageNo}', '01', '084.0000A', '84A', '84.0000', '28.4000', '112.4000', '50.0000', '162.4000', '2'],
    ], [[0, c, 2, 1] for c in (0, 1, 2, 3, 4, 8, 9, 10)] + [[0, 5, 1, 3]])
    price = _table(40, 192, [70, 60, 40, 90, 85, 85, 85, 85, 85], [14, 14, 16, 16], [
        ['약식표기(타입)', '공급세대수', '층', '동 호', '아파트 분양가', None, None, '계약금(10%)', '잔금(90%)'],
        [None, None, None, None, '대지비', '건축비', '합계', '계약 시', '입주 시'],
        ['84A', '2', '1층', '101동 101호', '300,000,000', '400,000,000', '700,000,000', '70,000,000', '630,000,000'],
        [None, None, '2층', '101동 102호', '310,000,000', '410,000,000', '720,000,000', '72,000,000', '648,000,000'],
    ], [[0, c, 2, 1] for c in (0, 1, 2, 3)] + [[0, 4, 1, 3], [2, 0, 2, 1], [2, 1, 2, 1]])
    reference = _table(40, 50, [90, 60, 80, 80, 80, 80, 80], [14, 14, 16], [
        ['주택형(전용면적기준)', '약식표기', '주택공급면적(㎡)', None, None, '토지등소유자', '임대세대'],
        [None, None, '주거전용면적', '주거공용면적', '소계', None, None],
        ['084.0000A', '84A', '84.0000', '30.0000', '114.0000', '10', '3'],
    ], [[0, c, 2, 1] for c in (0, 1, 5, 6)] + [[0, 2, 1, 3]])
    options = _table(40, 162, [70, 80, 50, 90, 140, 80, 80, 80], [14, 14, 16, 16, 16], [
        ['약식표기(타입)', '동 호', '유·무상', '품목', '내용', '금액', '계약금(10%)', '잔금(90%)'],
        [None, None, None, None, None, None, '계약시', '입주시'],
        ['84A', '101동 101호', '유상', '발코니확장', '거실+침실 확장', '10,000,000', '1,000,000', '9,000,000'],
        [None, None, '무상', '현관 수납장', '기본형', '-', None, None],
        [None, '101동 102호', '유상', '시스템에어컨', '합성 품목', '', '', ''],
    ], [[0, c, 2, 1] for c in range(6)] + [[2, 0, 3, 1], [2, 1, 2, 1], [2, 6, 2, 1], [2, 7, 2, 1]])
    bank = _table(40, 300, [200, 150, 150], [14, 16], [
        ['구 분', '금융기관', '계좌번호'], ['공급금액 및 유상옵션', '합성은행', '000-00-000'],
    ], [])
    return {
        'houseManageNo': '9900000001', 'noticeDate': '2026.10.05.(월)', 'labels': True, 'labelOffset': 0,
        'tables': {'area': area, 'price': price, 'reference': reference, 'options': options, 'bank': bank},
        'pages': [
            {'texts': [
                (40, 40, '[합성 시험 자료] 합성 가람 아파트 불법행위 재공급 입주자모집공고 - 실제 공고가 아님'),
                (40, 70, '■ 본 불법행위재공급 입주자모집공고일은 {noticeDate}이며(청약자격 판단기준일), '
                         '주택관리번호는 {houseManageNo}입니다.'),
                (40, 100, '■ 본 주택의 최초 입주자모집공고일은 2024.05.31.(금)이며 최초 주택관리번호는 9900000000이므로 '
                          '최초 공고문을 함께 확인하시기 바랍니다.'),
                (40, 130, '■ 이 문서는 경계 검사를 위한 합성 자료이며 청약 자격이나 금액 판단에 사용할 수 없습니다.'),
            ], 'tables': []},
            {'texts': [
                (40, 40, '1 공급내역 및 공급금액 (합성 자료)'),
                (40, 64, '■ 공급대상'), (690, 76, '[단위: ㎡, 세대]'),
                (40, 142, '※ 상기 면적은 합성 값이며 소수점 넷째 자리까지 표기합니다.'),
                (40, 176, '■ 공급금액'), (690, 188, '[단위: 세대,원]'),
                (40, 272, '※ 상기 공급금액에는 발코니 확장 비용이 미포함된 금액입니다.'),
            ], 'tables': ['area', 'price']},
            {'texts': [
                (40, 40, '■ (참고) 토지등소유자 및 임대 세대 공급내역'),
                (40, 112, '※ 상기 토지등소유자·임대 세대 공급내역은 고지 목적이며 금번 공급되는 주택의 대상이 아님을 '
                          '안내드립니다.'),
                (40, 146, '■ 발코니확장 및 추가선택품목(유·무상옵션) 세부 내역, 금액'),
                (620, 158, '(단위: 원 / 부가가치세 포함)'),
                (40, 256, 'Ÿ 위 항목은 선택 및 변경이 불가한 항목으로 기존 계약을 승계하는 조건입니다.'),
                (40, 290, '■ 공급금액 및 유상옵션 납부계좌'),
            ], 'tables': ['reference', 'options', 'bank']},
        ],
    }


def synthetic_schedule_spec():
    """현재 공고 지정 문장 대신 청약 일정표(입주자모집공고일 열)와 '최초' 문구만 있는 서식."""
    spec = synthetic_notice_spec()
    spec['pages'][0]['texts'][1] = (40, 70, '■ 본 아파트의 최초 입주자모집공고일은 {noticeDate}입니다.(청약자격 판단기준일)')
    del spec['pages'][0]['texts'][2]
    spec['tables']['schedule'] = _table(40, 150, [80, 120, 120, 120], [14, 16], [
        ['구분', '입주자모집공고일', '일반공급 접수일', '당첨자발표일'],
        ['일정', '{noticeDate}', '2026.10.13(화)', '2026.10.20(화)']], [])
    spec['pages'][0]['tables'] = ['schedule']
    return spec


def synthetic_short_schedule_spec(value='26.10.05.(월)'):
    """일정표 머리말 행만 선으로 그려지고 값 행(두 자리 연도)은 그 아래 글자로만 있는 서식."""
    spec = synthetic_schedule_spec()
    spec['tables']['schedule'] = _table(40, 150, [80, 120, 120, 120], [14], [
        ['구분', '입주자모집공고일', '일반공급 접수일', '당첨자발표일']], [])
    spec['pages'][0]['texts'] += [(45, 176, '일정'), (150, 176, value), (270, 176, '26.10.13.(화)'),
                                  (390, 176, '26.10.20.(화)')]
    return spec


def _fill(spec, text):
    return text.replace('{houseManageNo}', spec['houseManageNo']).replace('{noticeDate}', spec['noticeDate'])


def _geometry(table):
    xs, ys = [table['x']], [table['y']]
    for width in table['widths']:
        xs.append(xs[-1] + width)
    for height in table['heights']:
        ys.append(ys[-1] + height)
    spans = {(r, c): (rs, cs) for r, c, rs, cs in table['spans']}
    boxes = {}
    for r, row in enumerate(table['cells']):
        for c, text in enumerate(row):
            if text is not None:
                rs, cs = spans.get((r, c), (1, 1))
                boxes[(r, c)] = [xs[c], ys[r], xs[c + cs], ys[r + rs]]
    return xs, ys, boxes


def _page_texts(spec, number, page):
    texts = [(x, y, _fill(spec, text)) for x, y, text in page['texts']]
    if spec['labels']:
        texts.append((410, 580, '- %d -' % (number + spec['labelOffset'])))
    return texts


def synthetic_pages(spec=None):
    """build_synthetic_notice_pdf와 같은 명세를 PyMuPDF 추출 결과 형식의 쪽 목록으로 만든다(파서 불필요)."""
    spec = spec or synthetic_notice_spec()
    pages = []
    for number, page in enumerate(spec['pages'], 1):
        texts = _page_texts(spec, number, page)
        records = []
        for index, name in enumerate(page['tables']):
            table = spec['tables'][name]
            xs, ys, boxes = _geometry(table)
            rows = [[_fill(spec, text) if text is not None else None for text in row] for row in table['cells']]
            records.append({'id': 'p%dt%d' % (number, index), 'bbox': [xs[0], ys[0], xs[-1], ys[-1]], 'rows': rows,
                            'cell_bboxes': [[boxes.get((r, c)) for c in range(len(row))] for r, row in enumerate(rows)]})
        cell_text = [text for record in records for row in record['rows'] for text in row if text]
        words = [(x, y - 7, x + 6 * len(t), y + 1, t) for x, y, t in texts]
        pages.append({'page': number, 'text': '\n'.join([t for _, _, t in sorted(texts, key=lambda t: t[1])] + cell_text),
                      'tables': records, 'blocks': [(x, y - 8, x + 6 * len(t), y + 2, t) for x, y, t in texts],
                      'words': words,
                      'tableScan': 'scanned' if records else 'not_needed'})
    return pages


def build_synthetic_notice_pdf(spec=None):
    """명세로 실제 PDF 바이트를 만든다. 내장 'korea' 글꼴을 부분 포함하며 네트워크·파일을 쓰지 않는다."""
    import fitz
    spec = spec or synthetic_notice_spec()
    document = fitz.open()
    font = fitz.Font('korea')
    for number, page_spec in enumerate(spec['pages'], 1):
        page = document.new_page(width=PAGE_WIDTH, height=PAGE_HEIGHT)
        page.insert_font(fontname='kr', fontbuffer=font.buffer)
        for x, y, text in _page_texts(spec, number, page_spec):
            page.insert_text((x, y), text, fontname='kr', fontsize=7)
        for name in page_spec['tables']:
            table = spec['tables'][name]
            _, _, boxes = _geometry(table)
            for (r, c), box in boxes.items():
                page.draw_rect(fitz.Rect(*box), color=(0, 0, 0), width=0.5)
                text = _fill(spec, table['cells'][r][c])
                if text:
                    page.insert_text((box[0] + 2, box[1] + (box[3] - box[1]) * 0.7), text, fontname='kr', fontsize=6)
    document.subset_fonts()
    return document.tobytes(garbage=3, deflate=True)


def synthetic_document(**overrides):
    return dict({'id': 'synthetic-notice-pdf', 'version': 'synthetic-v1', 'source': 'official',
                 'houseManageNo': '9900000001', 'noticeNo': '9900000042', 'edition': 'synthetic-edition-1'}, **overrides)


def synthetic_catalog_inputs(*, notice_row=None, model_row=None):
    """픽스처의 합성 공고·주택형 응답을 (target, 공고 수집, 주택형 수집, 픽스처 근거)로 돌려준다."""
    bundle = json.loads(FIXTURE.read_text(encoding='utf-8'))

    def collection(page, override):
        rows = [dict(row, **(override or {})) for row in page['body']['data']]
        return {'source': page['source'], 'scope': page['scope'], 'status': 'complete',
                'observations': [{'page': 1, 'position': i + 1, 'row': row} for i, row in enumerate(rows)]}
    return (bundle['request']['target'], collection(bundle['pages'][0], notice_row),
            collection(bundle['pages'][1], model_row), bundle['evidence'])


def _catalog(**rows):
    target, notice, models, _ = synthetic_catalog_inputs(**rows)
    return target, notice, models, normalize_catalog(notice, models, target=target)


def _run(spec=None, document=None, **rows):
    target, notice, models, catalog = _catalog(**rows)
    result = inspect_extracted_pages(synthetic_pages(spec), target=target, catalog=catalog,
                                     document=document or synthetic_document())
    merged = normalize_catalog(notice, models, target=target, evidence=result['evidence'])
    return result, merged


def _field(result, item, room=None):
    found = [f for f in result['fields'] if f['item'] == item and f['room'] == room]
    assert len(found) == 1, (item, room, found)
    return found[0]


def _room(merged, room):
    return next(r for r in merged['rooms'] if r['room'] == room)


def _codes(result):
    return {issue['code'] for issue in result['issues']}


def _cells(spec, name):
    return spec['tables'][name]['cells']


class SyntheticLayoutTests(unittest.TestCase):
    """표준 라이브러리만으로 실행한다. 쪽·표·셀 좌표는 PyMuPDF 추출 결과 형식이다."""

    def test_checked_values_become_evidence_and_only_the_partial_option_is_held(self):
        result, merged = _run()
        self.assertEqual((result['contract'], result['status']), (CONTRACT, 'checked'))
        self.assertEqual(result['identity']['houseManageNo'], ['9900000001'])  # 최초 공고 번호는 식별에 쓰지 않는다
        self.assertEqual(result['identity']['noticeDate'], ['2026-10-05'])
        self.assertEqual(_field(result, 'supply_area')['value'], '112.4000')
        self.assertEqual(_field(result, 'sale_price', '101동 101호')['value'], '700000000')
        self.assertEqual(_field(result, 'required_options', '101동 101호')['value'], '10000000')
        partial = _field(result, 'required_options', '101동 102호')
        self.assertEqual((partial['status'], partial['classification']), ('unverified', 'partial'))
        self.assertIn('option_amount_missing', partial['reasons'])
        self.assertEqual(result['tables']['area'], ['p2t0'])  # 참고(토지등소유자) 표는 공급면적으로 읽지 않는다
        self.assertIn('p3t0', result['tables']['ignored'])
        for row in result['evidence']:
            self.assertIsNone(_record_problem(row))
            self.assertEqual(row['document'], dict(synthetic_document(), originCheck=None))
        self.assertEqual(_room(merged, '101동 101호')['subtotal'], {
            'status': 'confirmed', 'won': '710000000', 'basis': 'sale_price_plus_required_options', 'reasons': [],
            'documents': [{'id': 'synthetic-notice-pdf', 'version': 'synthetic-v1'}]})
        held = _room(merged, '101동 102호')
        self.assertEqual((held['status'], held['salePrice']['won'], held['subtotal']['reasons']),
                         ('held', '720000000', ['required_options_unverified']))
        self.assertEqual(merged['housingTypes'][0]['checkedSupplyArea']['status'], 'confirmed')

    def test_result_matches_the_fixture_evidence_outcome(self):
        target, notice, models, evidence = synthetic_catalog_inputs()
        expected = normalize_catalog(notice, models, target=target, evidence=evidence)
        _, merged = _run()
        self.assertEqual([(r['room'], r['status'], r['subtotal']['won']) for r in merged['rooms']],
                         [(r['room'], r['status'], r['subtotal']['won']) for r in expected['rooms']])

    def test_other_round_or_mixed_identity_is_rejected_without_values(self):
        cases = []
        other = synthetic_notice_spec()
        other['houseManageNo'] = '9900000002'
        cases.append((other, 'pdf_notice_mismatch'))
        later = synthetic_notice_spec()
        later['noticeDate'] = '2026.10.06.(화)'
        cases.append((later, 'pdf_notice_date_mismatch'))
        weekday = synthetic_notice_spec()
        weekday['noticeDate'] = '2026.10.05.(화)'  # 날짜와 요일이 맞지 않는 원문은 식별에 쓰지 않는다
        cases.append((weekday, 'pdf_notice_weekday_mismatch'))
        mixed = synthetic_notice_spec()
        mixed['pages'][1]['texts'].append((40, 300, '■ 본 입주자모집공고일은 2026.06.12.(금)이며 주택관리번호는 9900000002입니다.'))
        cases.append((mixed, 'pdf_identity_ambiguous'))
        table_only = synthetic_notice_spec()
        _cells(table_only, 'area')[2][1] = '9900000002'  # 본문과 공급대상 표의 번호가 다르면 혼합이다
        cases.append((table_only, 'pdf_identity_ambiguous'))
        for spec, code in cases:
            with self.subTest(code=code):
                result, _ = _run(spec)
                self.assertEqual((result['status'], result['evidence'], result['fields']), ('rejected', [], []))
                self.assertIn(code, _codes(result))

    def test_identity_needs_number_date_and_reported_api_date(self):
        result, _ = _run(notice_row={'RCRIT_PBLANC_DE': None})
        self.assertEqual((result['status'], result['evidence']), ('held', []))
        self.assertIn('api_notice_date_unverified', _codes(result))
        no_sentence = synthetic_notice_spec()
        no_sentence['pages'][0]['texts'][1] = (40, 70, '■ 공고일 안내는 별도 공지합니다.')
        result, _ = _run(no_sentence)
        self.assertEqual(result['status'], 'held')
        self.assertIn('pdf_notice_date_not_found', _codes(result))
        # 공고일만 지정한 다른 서식 문장과 공급대상 표의 주택관리번호로도 식별한다.
        date_only = copy.deepcopy(no_sentence)
        date_only['pages'][0]['texts'].append((40, 160, '■ 본 아파트의 입주자모집공고일은 2026.10.05.(월)입니다.'))
        result, _ = _run(date_only)
        self.assertEqual((result['status'], result['identity']['status']), ('checked', 'confirmed'))

    def test_schedule_table_date_identifies_a_notice_without_the_sentence(self):
        spec = synthetic_schedule_spec()
        result, _ = _run(spec)
        self.assertEqual((result['status'], result['identity']['noticeDate']), ('checked', ['2026-10-05']))
        self.assertIn({'page': 1, 'kind': 'schedule_table'}, result['identity']['locations'])
        self.assertEqual(_field(result, 'supply_area')['status'], 'confirmed')
        first = synthetic_schedule_spec()
        _cells(first, 'schedule')[0][1] = '최초 입주자모집공고일'  # 다른 회차를 가리키는 머리말은 쓰지 않는다
        result, _ = _run(first)
        self.assertEqual((result['status'], result['evidence']), ('held', []))
        self.assertIn('pdf_notice_date_not_found', _codes(result))

    def test_new_sale_first_notice_date_counts_only_when_it_equals_the_api_date(self):
        # 합성: 신규분양 공고는 '본 주택의 최초 입주자모집공고일은 …'로 공고일을 적기도 한다(2026-11-28 천안 공고 서식).
        def new_sale(date_text):
            spec = synthetic_notice_spec()
            spec['pages'][0]['texts'][0] = (40, 40, '[합성 시험 자료] 합성 가람 아파트 입주자모집공고 - 실제 공고가 아님')
            spec['pages'][0]['texts'][1] = (40, 70, '■ 본 주택의 최초 입주자모집공고일은 ' + date_text + '입니다.')
            spec['pages'][0]['texts'][2] = (40, 100, '■ 주택관리번호 : {houseManageNo}')
            return spec
        result, _ = _run(new_sale('{noticeDate}'))
        self.assertEqual((result['status'], result['identity']['noticeDate']), ('checked', ['2026-10-05']))
        self.assertIn({'page': 1, 'kind': 'first_notice_date_sentence'}, result['identity']['locations'])
        result, _ = _run(new_sale('2026.09.07.(월)'))  # API 모집공고일과 다르면 쓰지 않는다
        self.assertEqual((result['status'], result['evidence']), ('held', []))
        self.assertIn('pdf_notice_date_not_found', _codes(result))
        resupply = new_sale('{noticeDate}')
        resupply['pages'][0]['texts'][0] = (40, 40, '[합성 시험 자료] 합성 가람 아파트 재공급 입주자모집공고 - 실제 공고가 아님')
        result, _ = _run(resupply)  # 재공급 제목이면 '최초'는 예전 회차라 쓰지 않는다
        self.assertEqual((result['status'], result['evidence']), ('held', []))
        self.assertIn('pdf_notice_date_not_found', _codes(result))

    def test_two_digit_schedule_year_is_only_matched_against_a_reference_date(self):
        result, _ = _run(synthetic_short_schedule_spec())
        self.assertEqual((result['status'], result['identity']['noticeDate']), ('checked', ['2026-10-05']))
        self.assertIn({'page': 1, 'kind': 'schedule_table_two_digit_year'}, result['identity']['locations'])
        result, _ = _run(synthetic_short_schedule_spec(), notice_row={'RCRIT_PBLANC_DE': None})
        self.assertEqual((result['status'], result['evidence']), ('held', []))  # 세기를 추정하지 않는다
        self.assertIn('pdf_notice_date_two_digit_year', _codes(result))
        for value, code in (('26.10.06.(화)', 'pdf_notice_date_mismatch'), ('26.10.05.(화)', 'pdf_notice_weekday_mismatch')):
            result, _ = _run(synthetic_short_schedule_spec(value))
            self.assertEqual((result['status'], result['evidence']), ('rejected', []))
            self.assertIn(code, _codes(result))

    def test_summary_rows_of_the_supply_table_are_not_models(self):
        spec = synthetic_notice_spec()
        area = spec['tables']['area']
        area['cells'].append(['합계', '', '합계', '합계', '', '84.0000', '28.4000', '112.4000', '50.0000', '162.4000', '2'])
        area['heights'].append(16)
        result, _ = _run(spec)
        self.assertEqual([f['modelNo'] for f in result['fields'] if f['item'] == 'supply_area'], ['01'])

    def test_floor_price_table_without_rooms_is_not_a_room_price(self):
        spec = synthetic_notice_spec()
        spec['tables']['price'] = _table(40, 192, [70, 60, 60, 85, 85, 85, 85, 85], [14, 14, 16], [
            ['약식표기(타입)', '공급세대수', '층', '공급금액', None, None, '계약금(10%)', '잔금(90%)'],
            [None, None, None, '대지비', '건축비', '합계', '계약 시', '입주 시'],
            ['84A', '2', '1~2층', '300,000,000', '400,000,000', '700,000,000', '70,000,000', '630,000,000'],
        ], [[0, c, 2, 1] for c in (0, 1, 2, 6, 7)] + [[0, 3, 1, 3]])
        result, _ = _run(spec)
        self.assertIn('price_rows_not_per_room', _codes(result))
        self.assertFalse([f for f in result['fields'] if f['item'] == 'sale_price'])
        self.assertEqual(_field(result, 'supply_area')['status'], 'confirmed')

    def test_document_metadata_must_match_target_round(self):
        for override, code in (({'edition': 'synthetic-edition-0'}, 'different_notice_round'),
                               ({'noticeNo': '9900000041'}, 'document_notice_mismatch'),
                               ({'houseManageNo': None}, 'document_identity_unverified'),
                               ({'source': 'mirror'}, 'document_source_unverified')):
            with self.subTest(code=code):
                result, _ = _run(document=synthetic_document(**override))
                self.assertEqual((result['status'], result['evidence'], [i['code'] for i in result['issues']]),
                                 ('rejected', [], [code]))

    def test_unverified_upload_keeps_values_for_be02_to_hold(self):
        result, merged = _run(document=synthetic_document(source='upload'))
        self.assertEqual(result['status'], 'checked')
        self.assertEqual(merged['documents'][0]['status'], 'held')
        self.assertFalse([r for r in merged['rooms'] if r['status'] == 'confirmed'])

    def test_area_arithmetic_unit_and_house_type_holds_only_area(self):
        cases = []
        common = synthetic_notice_spec()
        _cells(common, 'area')[2][6] = '28.4001'
        cases.append((common, 'supply_area_sum_mismatch', 'conflict'))
        exclusive = synthetic_notice_spec()
        _cells(exclusive, 'area')[2][5:7] = ['84.1000', '28.3000']
        cases.append((exclusive, 'house_type_area_mismatch', 'conflict'))
        contract = synthetic_notice_spec()
        _cells(contract, 'area')[2][9] = '162.5000'
        cases.append((contract, 'contract_area_sum_mismatch', 'conflict'))
        pyeong = synthetic_notice_spec()
        _cells(pyeong, 'area')[0][5] = '주택공급면적(평)'
        pyeong['pages'][1]['texts'][2] = (690, 76, '[단위: 평, 세대]')
        cases.append((pyeong, 'area_unit_unverified', 'unverified'))
        for spec, code, status in cases:
            with self.subTest(code=code):
                result, merged = _run(spec)
                area = _field(result, 'supply_area')
                self.assertEqual((area['status'], area['value']), (status, None))
                self.assertIn(code, area['reasons'])
                self.assertEqual(_field(result, 'sale_price', '101동 101호')['status'], 'confirmed')
                self.assertEqual(_room(merged, '101동 101호')['subtotal']['won'], '710000000')
                self.assertNotEqual(merged['housingTypes'][0]['checkedSupplyArea']['status'], 'confirmed')

    def test_house_type_mismatch_holds_area_and_rooms_of_that_type(self):
        spec = synthetic_notice_spec()
        _cells(spec, 'area')[2][3] = '084.0000B'
        result, merged = _run(spec)
        self.assertIn('house_type_mismatch', _field(result, 'supply_area')['reasons'])
        self.assertEqual(_field(result, 'sale_price', '101동 101호')['status'], 'conflict')
        self.assertEqual(merged['housingTypes'][0]['checkedSupplyArea']['reasons'][0], 'house_type_mismatch')
        self.assertEqual(merged['rooms'], [])

    def test_api_house_type_outer_whitespace_keeps_the_api_string(self):
        for api in ('084.0000A ', ' 084.0000A', '84.0000A'):
            with self.subTest(api=api):
                result, merged = _run(model_row={'HOUSE_TY': api})
                area = _field(result, 'supply_area')
                self.assertEqual((area['status'], area['houseType'], area['pdfHouseType']), ('confirmed', api, '084.0000A'))
                self.assertEqual({row['houseType'] for row in result['evidence']}, {api})
                self.assertEqual(merged['housingTypes'][0]['checkedSupplyArea']['status'], 'confirmed')
                self.assertEqual(_room(merged, '101동 101호')['subtotal']['won'], '710000000')
        for api in ('084.0000 A', '084.0000AB', '084.0001A'):  # 내부 공백·다른 접미·다른 값은 대응하지 않는다
            with self.subTest(api=api):
                result, merged = _run(model_row={'HOUSE_TY': api})
                area = _field(result, 'supply_area')
                self.assertEqual((area['status'], area['houseType']), ('conflict', '084.0000A'))
                self.assertIn('house_type_mismatch', area['reasons'])
                self.assertEqual(_field(result, 'sale_price', '101동 101호')['status'], 'conflict')
                self.assertEqual(merged['rooms'], [])
                self.assertNotEqual(merged['housingTypes'][0]['checkedSupplyArea']['status'], 'confirmed')

    def test_model_number_normalization_must_identify_one_api_model(self):
        def inspect(pdf_model, api_models, reverse):
            target, notice, models, _ = synthetic_catalog_inputs()
            base = models['observations'][0]['row']
            models['observations'] = [{'page': 1, 'position': i + 1, 'row': dict(base, MODEL_NO=number)}
                                      for i, number in enumerate(api_models)]
            catalog = normalize_catalog(notice, models, target=target)
            if reverse:  # 카탈로그 순서가 바뀌어도 결과가 같아야 한다
                catalog['housingTypes'].reverse()
            spec = synthetic_notice_spec()
            _cells(spec, 'area')[2][2] = pdf_model
            return inspect_extracted_pages(synthetic_pages(spec), target=target, catalog=catalog,
                                           document=synthetic_document())
        for reverse in (False, True):
            with self.subTest(reverse=reverse):
                exact = inspect('01', ['01', '1'], reverse)  # 원형이 유일하게 같으면 그 모델이다
                self.assertEqual((_field(exact, 'supply_area')['status'], _field(exact, 'supply_area')['modelNo']),
                                 ('confirmed', '01'))
                self.assertEqual({row['modelNo'] for row in exact['evidence']}, {'01'})
                ambiguous = inspect('001', ['01', '1'], reverse)  # 정규화로만 맞는 후보가 둘이면 고르지 않는다
                area = _field(ambiguous, 'supply_area')
                self.assertEqual((area['status'], area['modelNo'], area['reasons']),
                                 ('unverified', '001', ['pdf_model_ambiguous']))
                self.assertEqual(ambiguous['evidence'], [])
                self.assertIn('room_type_unmapped', _codes(ambiguous))
                single = inspect('001', ['01'], reverse)
                self.assertEqual((_field(single, 'supply_area')['status'], _field(single, 'supply_area')['modelNo']),
                                 ('confirmed', '01'))

    def test_model_absent_from_catalog_produces_no_evidence(self):
        spec = synthetic_notice_spec()
        _cells(spec, 'area')[2][2] = '02'
        result, _ = _run(spec)
        self.assertEqual((result['status'], result['evidence']), ('checked', []))
        self.assertIn('pdf_model_not_in_catalog', _field(result, 'supply_area')['reasons'])
        self.assertIn('room_type_unmapped', _codes(result))

    def test_sale_price_crosschecks(self):
        cases = []
        land = synthetic_notice_spec()
        _cells(land, 'price')[2][4] = '300,000,001'
        cases.append((land, 'sale_price_component_mismatch', 'conflict'))
        paid = synthetic_notice_spec()
        _cells(paid, 'price')[2][8] = '630,000,001'
        cases.append((paid, 'sale_price_payment_mismatch', 'conflict'))
        bare = synthetic_notice_spec()
        _cells(bare, 'price')[2][4:6] = ['-', '-']
        _cells(bare, 'price')[2][7:9] = ['-', '-']
        cases.append((bare, 'sale_price_uncrosschecked', 'unverified'))
        unit = synthetic_notice_spec()
        unit['pages'][1]['texts'][5] = (690, 188, '[단위: 세대]')
        cases.append((unit, 'amount_unit_unverified', 'unverified'))
        mixed_unit = synthetic_notice_spec()
        mixed_unit['pages'][1]['texts'][5] = (690, 188, '[단위: 원, 천원]')
        cases.append((mixed_unit, 'amount_unit_ambiguous', 'unverified'))
        for spec, code, status in cases:
            with self.subTest(code=code):
                result, merged = _run(spec)
                sale = _field(result, 'sale_price', '101동 101호')
                self.assertEqual((sale['status'], sale['value']), (status, None))
                self.assertIn(code, sale['reasons'])
                self.assertEqual(_field(result, 'supply_area')['status'], 'confirmed')
                self.assertEqual(_room(merged, '101동 101호')['subtotal']['status'], 'held')

    def test_explicit_thousand_won_unit_is_converted(self):
        spec = synthetic_notice_spec()
        spec['pages'][1]['texts'][5] = (690, 188, '[단위: 세대, 천원]')
        for row in _cells(spec, 'price')[2:]:
            row[4:] = [value[:-4] for value in row[4:]]
        result, _ = _run(spec)
        sale = _field(result, 'sale_price', '101동 101호')
        self.assertEqual((sale['status'], sale['value'], sale['raw']), ('confirmed', '700000000', '700,000'))

    def test_api_top_amount_and_room_count_bound_room_prices(self):
        result, _ = _run(model_row={'LTTOT_TOP_AMOUNT': '70,000'})
        self.assertEqual(_field(result, 'sale_price', '101동 101호')['status'], 'confirmed')
        over = _field(result, 'sale_price', '101동 102호')
        self.assertEqual((over['status'], over['reasons']), ('conflict', ['sale_price_exceeds_api_top_amount']))
        spec = synthetic_notice_spec()
        _cells(spec, 'price')[2][1] = '3'
        result, _ = _run(spec)
        for room in ('101동 101호', '101동 102호'):
            self.assertEqual(_field(result, 'sale_price', room)['reasons'], ['room_count_mismatch'])

    def test_option_statement_must_be_bound_positive_and_unnegated(self):
        absent = synthetic_notice_spec()
        del absent['pages'][2]['texts'][4]
        elsewhere = copy.deepcopy(absent)  # 다른 쪽·가격표 아래 문구는 옵션 표의 근거가 아니다
        elsewhere['pages'][1]['texts'].append((40, 290, 'Ÿ 위 항목은 선택 및 변경이 불가한 항목으로 기존 계약을 승계하는 조건입니다.'))
        previous = copy.deepcopy(absent)  # 앞 절(참고표) 안의 문구는 옵션 절 제목 위라서 묶지 않는다
        previous['pages'][2]['texts'].append((40, 124, '※ 위 항목은 선택 및 변경이 불가한 항목으로 기존 계약을 승계하는 조건입니다.'))
        denied = copy.deepcopy(absent)
        denied['pages'][2]['texts'].append((40, 256, 'Ÿ 위 항목은 기존 계약을 승계하지 않아도 됩니다.'))
        both = synthetic_notice_spec()
        both['pages'][2]['texts'].append((40, 270, 'Ÿ 단, 유상옵션은 선택 사항입니다.'))
        for spec, state in ((absent, 'unverified'), (elsewhere, 'unverified'), (previous, 'unverified'),
                            (denied, 'unverified'), (both, 'ambiguous')):
            with self.subTest(state=state):
                result, merged = _run(spec)
                option = _field(result, 'required_options', '101동 101호')
                self.assertEqual((option['status'], option['checks']['required_statement']), ('unverified', state))
                self.assertIn('option_requirement_' + state, option['reasons'])
                self.assertEqual(_field(result, 'sale_price', '101동 101호')['status'], 'confirmed')
                self.assertEqual(_room(merged, '101동 101호')['subtotal']['status'], 'held')

    def test_option_classification_explicit_zero_and_missing(self):
        zero = synthetic_notice_spec()
        _cells(zero, 'options')[4][2:6] = ['무상', '현관 수납장', '기본형', '-']
        result, merged = _run(zero)
        option = _field(result, 'required_options', '101동 102호')
        self.assertEqual((option['status'], option['value'], option['classification']), ('confirmed', '0', 'explicit_zero'))
        self.assertEqual(_room(merged, '101동 102호')['subtotal']['won'], '720000000')
        missing = synthetic_notice_spec()
        options = missing['tables']['options']
        del options['cells'][4]
        options['heights'].pop()
        options['spans'][-4] = [2, 0, 2, 1]
        result, merged = _run(missing)
        option = _field(result, 'required_options', '101동 102호')
        self.assertEqual((option['status'], option['classification'], option['page']), ('unverified', 'missing', None))
        self.assertIn('room_not_in_options_table', _codes(result))
        self.assertFalse([r for r in result['evidence'] if r['item'] == 'required_options' and r['room'] == '101동 102호'])
        self.assertEqual(_room(merged, '101동 102호')['requiredOptions']['reasons'], ['no_checked_value'])
        none = synthetic_notice_spec()
        none['pages'][2]['tables'].remove('options')
        result, _ = _run(none)
        self.assertIn('options_table_not_found', _field(result, 'required_options', '101동 101호')['reasons'])

    def test_option_amount_and_payment_inconsistencies(self):
        cases = []
        free = synthetic_notice_spec()
        _cells(free, 'options')[3][5] = '500,000'
        cases.append((free, 'free_option_with_amount', 'conflict'))
        paid = synthetic_notice_spec()
        _cells(paid, 'options')[2][7] = '8,000,000'
        cases.append((paid, 'option_payment_mismatch', 'conflict'))
        duplicated = synthetic_notice_spec()
        _cells(duplicated, 'options')[3][3] = '발코니확장'
        cases.append((duplicated, 'option_item_duplicated', 'unverified'))
        uncrosschecked = synthetic_notice_spec()
        _cells(uncrosschecked, 'options')[2][6:8] = ['', '']
        cases.append((uncrosschecked, 'required_options_uncrosschecked', 'unverified'))
        charge = synthetic_notice_spec()
        _cells(charge, 'options')[2][2] = '별도'
        cases.append((charge, 'option_charge_unverified', 'unverified'))
        for spec, code, status in cases:
            with self.subTest(code=code):
                result, _ = _run(spec)
                option = _field(result, 'required_options', '101동 101호')
                self.assertEqual((option['status'], option['value']), (status, None))
                self.assertIn(code, option['reasons'])
                self.assertEqual(_field(result, 'sale_price', '101동 101호')['status'], 'confirmed')

    def test_room_in_two_option_tables_is_not_merged_into_one_value(self):
        spec = synthetic_notice_spec()
        second = copy.deepcopy(spec['tables']['options'])
        second['y'] = 60
        second['cells'] = second['cells'][:3]
        second['heights'] = second['heights'][:3]
        second['cells'][2][3] = '시스템에어컨'
        second['spans'] = [s for s in second['spans'] if s[0] == 0]
        spec['tables']['options2'] = second
        spec['pages'].append({'texts': [(40, 40, '■ 추가 선택품목(유·무상옵션) 세부 내역, 금액 (합성 자료 계속)'),
                                        (620, 52, '(단위: 원 / 부가가치세 포함)'),
                                        (40, 120, 'Ÿ 위 항목은 선택 및 변경이 불가한 항목으로 기존 계약을 승계하는 조건입니다.')],
                              'tables': ['options2']})
        result, merged = _run(spec)
        option = _field(result, 'required_options', '101동 101호')
        self.assertEqual((option['status'], option['value'], option['reasons']),
                         ('unverified', None, ['option_room_in_multiple_tables']))
        self.assertIsNone(_room(merged, '101동 101호')['requiredOptions']['won'])
        self.assertEqual(_field(result, 'sale_price', '101동 101호')['status'], 'confirmed')

    def test_unattributed_rows_and_continuations_hold_that_option_table(self):
        unattributed = synthetic_notice_spec()
        options = unattributed['tables']['options']
        options['cells'].append(['', '', '유상', '쿡탑', '합성 품목', '850,000', '', ''])
        options['heights'].append(16)
        options['y'] = 150
        continued = synthetic_notice_spec()
        continued['pages'][2]['tables'].remove('bank')
        continued['tables']['tail'] = _table(40, 40, [70, 80, 50, 90, 140, 80, 80, 80], [16], [
            ['', '101동 102호', '유상', '쿡탑', '합성 품목', '850,000', '', '']], [])
        continued['pages'].append({'texts': [(40, 120, '※ 합성 자료 마지막 쪽입니다. 앞 쪽 표의 계속 여부를 원문으로 확인합니다.')],
                                   'tables': ['tail']})
        for spec, code in ((unattributed, 'option_rows_unattributed'), (continued, 'option_table_continuation_unverified')):
            with self.subTest(code=code):
                result, _ = _run(spec)
                option = _field(result, 'required_options', '101동 101호')
                self.assertEqual((option['status'], option['value']), ('unverified', None))
                self.assertIn(code, option['reasons'])
                self.assertEqual(_field(result, 'supply_area')['status'], 'confirmed')

    def test_incomplete_table_scan_blocks_option_completeness(self):
        pages = synthetic_pages()
        pages.append({'page': 4, 'text': '합성 자료: 표 추출 상한으로 읽지 않은 후보 쪽 ' * 3, 'tables': [], 'blocks': [],
                      'tableScan': 'skipped_limit'})
        target, notice, models, catalog = _catalog()
        result = inspect_extracted_pages(pages, target=target, catalog=catalog, document=synthetic_document())
        self.assertIn('table_scan_incomplete', _codes(result))
        self.assertIn('table_scan_incomplete', _field(result, 'required_options', '101동 101호')['reasons'])
        self.assertEqual(_field(result, 'sale_price', '101동 101호')['status'], 'confirmed')

    def test_page_labels_offset_is_recorded_and_inconsistency_holds_all(self):
        shifted = synthetic_notice_spec()
        shifted['labelOffset'] = 2
        result, _ = _run(shifted)
        self.assertEqual((result['status'], result['pages']['labels']['status'], result['pages']['labels']['offset']),
                         ('checked', 'offset', 2))
        self.assertEqual(_field(result, 'sale_price', '101동 101호')['pageLabel'], 4)
        pages = synthetic_pages()
        pages[2]['text'] = pages[2]['text'].replace('- 3 -', '- 7 -')
        target, notice, models, catalog = _catalog()
        result = inspect_extracted_pages(pages, target=target, catalog=catalog, document=synthetic_document())
        self.assertEqual(result['status'], 'held')
        self.assertEqual({row['check'] for row in result['evidence']}, {'unverified'})
        self.assertIn('page_labels_inconsistent', _codes(result))

    def test_textless_pages_and_invalid_calls(self):
        target, _, _, catalog = _catalog()
        blank = [{'page': 1, 'text': ' ', 'tables': [], 'blocks': [], 'tableScan': 'not_needed'}]
        result = inspect_extracted_pages(blank, target=target, catalog=catalog, document=synthetic_document())
        self.assertEqual((result['status'], result['evidence']), ('ocr_required', []))
        self.assertIn(result['status'], STATUSES)
        with self.assertRaises(ValueError):
            inspect_extracted_pages(blank, target=dict(target, edition='other'), catalog=catalog,
                                    document=synthetic_document())
        with self.assertRaises(ValueError):
            inspect_extracted_pages(blank, target=target, catalog=catalog, document={'id': 'x'})
        with self.assertRaises(TypeError):
            inspect_notice_pdf('not bytes', target=target, catalog=catalog, document=synthetic_document())

    def test_reported_notice_date_accepts_only_full_calendar_dates(self):
        def catalog(value, status='reported'):
            return {'notice': {'fields': {'RCRIT_PBLANC_DE': {'status': status, 'value': value}}}}
        for value in ('2026-10-05', '2026.10.05', '20261005'):
            self.assertEqual(reported_notice_date(catalog(value)), '2026-10-05')
        for value in ('2026-02-30', '공고일 20261005', '2026-10.05', '2026-1-05', ' 2026-10-05', '2026-10-05 '):
            self.assertIsNone(reported_notice_date(catalog(value)))
        self.assertIsNone(reported_notice_date(catalog('2026-10-05', status='conflict')))
        self.assertIsNone(reported_notice_date({}))

    def test_extract_helpers_keep_current_notice_sentence_only(self):
        text = _fill(synthetic_notice_spec(), '\n'.join(t for _, _, t in synthetic_notice_spec()['pages'][0]['texts']))
        self.assertEqual([(x['house_manage_no'], x['notice_date']) for x in find_identities(text, 1)],
                         [('9900000001', '2026-10-05')])
        self.assertEqual(len(IDENTITY_PATTERN.findall(text)), 1)


@unittest.skipUnless(HAS_FITZ, 'PyMuPDF가 없으면 실제 PDF 바이트 검사는 건너뛴다(requirements-pdf.txt)')
class SyntheticPdfBytesTests(unittest.TestCase):
    """합성 명세로 만든 실제 PDF 바이트를 PyMuPDF로 읽는다."""

    @classmethod
    def setUpClass(cls):
        cls.pdf = build_synthetic_notice_pdf()
        cls.target, cls.notice, cls.models, cls.catalog = _catalog()

    def inspect(self, pdf, document=None):
        return inspect_notice_pdf(pdf, target=self.target, catalog=self.catalog, document=document or synthetic_document())

    def test_pdf_bytes_and_extracted_pages_give_the_same_evidence(self):
        result = self.inspect(self.pdf)
        self.assertEqual(result['status'], 'checked')
        self.assertEqual(result['source'], {'sha256': hashlib.sha256(self.pdf).hexdigest(), 'bytes': len(self.pdf),
                                            'pageCount': 3})
        self.assertEqual(result['extractor']['ocrUsed'], False)
        expected, _ = _run()
        self.assertEqual(result['evidence'], expected['evidence'])
        self.assertEqual([(f['item'], f['room'], f['status'], f['value']) for f in result['fields']],
                         [(f['item'], f['room'], f['status'], f['value']) for f in expected['fields']])
        self.assertEqual(result['pages']['labels']['status'], 'matched')
        merged = normalize_catalog(self.notice, self.models, target=self.target, evidence=result['evidence'])
        self.assertEqual(_room(merged, '101동 101호')['subtotal']['won'], '710000000')

    def test_schedule_table_page_is_scanned_from_pdf_bytes(self):
        result = self.inspect(build_synthetic_notice_pdf(synthetic_schedule_spec()))
        self.assertEqual((result['status'], result['identity']['noticeDate']), ('checked', ['2026-10-05']))
        self.assertIn(1, result['pages']['tableScan']['scanned'])

    def test_header_only_schedule_with_words_below_from_pdf_bytes(self):
        result = self.inspect(build_synthetic_notice_pdf(synthetic_short_schedule_spec()))
        self.assertEqual((result['status'], result['identity']['noticeDate']), ('checked', ['2026-10-05']))

    def test_other_round_pdf_bytes_are_rejected(self):
        spec = synthetic_notice_spec()
        spec['houseManageNo'] = '9900000002'
        result = self.inspect(build_synthetic_notice_pdf(spec))
        self.assertEqual((result['status'], result['evidence'], _codes(result)), ('rejected', [], {'pdf_notice_mismatch'}))

    def test_document_hash_is_compared_when_given(self):
        digest = hashlib.sha256(self.pdf).hexdigest()
        self.assertEqual(self.inspect(self.pdf, synthetic_document(sha256=digest.upper()))['status'], 'checked')
        result = self.inspect(self.pdf, synthetic_document(sha256='0' * 64))
        self.assertEqual((result['status'], _codes(result)), ('rejected', {'document_hash_mismatch'}))

    def test_unsupported_documents_report_status_without_parser_text(self):
        import fitz
        blank = fitz.open()
        blank.new_page()
        blank.new_page()
        scanned = blank.tobytes()
        locked = fitz.open(stream=self.pdf, filetype='pdf').tobytes(
            encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw='synthetic-owner', user_pw='synthetic-user')
        cases = [(b'', 'unreadable', {'pdf_empty'}), (b'plain text', 'unreadable', {'pdf_signature_missing'}),
                 (b'%PDF-1.7\n' + b'\x00' * 64, 'unreadable', {'pdf_open_failed', 'pdf_without_pages'}),
                 (locked, 'encrypted', {'pdf_encrypted'}), (scanned, 'ocr_required', {'pdf_text_layer_missing'})]
        for pdf, status, codes in cases:
            with self.subTest(status=status):
                result = self.inspect(pdf)
                self.assertEqual((result['status'], result['evidence']), (status, []))
                self.assertTrue(_codes(result) <= codes and _codes(result))
                for issue in result['issues']:
                    self.assertEqual(set(issue), {'code', 'document', 'version'})
        with mock.patch.object(fields_module, 'MAX_PDF_BYTES', 100):
            self.assertEqual(_codes(self.inspect(self.pdf)), {'pdf_byte_limit_exceeded'})
        with mock.patch.object(fields_module, 'MAX_PAGES', 2):
            self.assertEqual(self.inspect(self.pdf)['status'], 'too_large')

    def test_table_page_limit_is_reported_and_holds_options(self):
        with mock.patch.object(fields_module, 'MAX_TABLE_PAGES', 1):
            result = self.inspect(self.pdf)
        self.assertEqual(result['pages']['tableScan']['skipped_limit'], [3])
        self.assertIn('table_scan_incomplete', _codes(result))
        self.assertEqual(_field(result, 'sale_price', '101동 101호')['status'], 'confirmed')
        self.assertEqual(_field(result, 'required_options', '101동 101호')['status'], 'unverified')

    def test_missing_parser_is_a_status(self):
        with mock.patch.dict('sys.modules', {'fitz': None}):
            result = self.inspect(self.pdf)
        self.assertEqual((result['status'], _codes(result), result['extractor']),
                         ('parser_unavailable', {'pdf_parser_unavailable'}, None))

    def test_extract_cli_reads_the_same_synthetic_pdf(self):
        from extract_notice_pdf import extract
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'synthetic.pdf'
            path.write_bytes(self.pdf)
            extracted = extract(path)
        self.assertEqual((extracted['identity']['house_manage_no'], extracted['identity']['notice_date']),
                         ('9900000001', '2026-10-05'))
        self.assertEqual(extracted['pages'][1]['tables'][0]['id'], 'p2t0')


def _synthetic_band_spec(*, include_optional_statement=True, include_mandatory=False, multi_page=False):
    """합성 신규분양 동·호 라인 × 층 구간 가격표 명세(실제 공고가 아님)."""
    area = _table(40, 80, [50, 70, 40, 90, 60, 70, 70, 70, 70, 70, 60], [14, 14, 16], [
        ['주택구분', '주택관리번호', '모델', '주택형(전용면적기준)', '약식표기', '주택공급면적(㎡)', None, None,
         '기타공용면적', '계약면적', '총공급세대수'],
        [None, None, None, None, None, '주거전용면적', '주거공용면적', '소계', None, None, None],
        ['민영', '{houseManageNo}', '01', '084.0000A', '84A', '84.0000', '28.4000', '112.4000', '50.0000', '162.4000', '5'],
    ], [[0, c, 2, 1] for c in (0, 1, 2, 3, 4, 8, 9, 10)] + [[0, 5, 1, 3]])
    band_rows = [
        ['주택형', '약식표기', '공급세대수', '동호구분', '층구분', '해당세대수',
         '공급금액', None, None, '계약금 1차(10%)', '중도금 1차(60%)', '잔금(30%)'],
        [None, None, None, None, None, None,
         '대지비', '건축비', '계', '계약시', '2027.05.10.', '입주시'],
        ['084.0000A', '84A', '5', '101동 3호, 102동 3호', '11-15층', '3',
         '300,000,000', '400,000,000', '700,000,000', '70,000,000', '420,000,000', '210,000,000'],
        [None, None, None, '101동 3호, 102동 3호', '6-10층', '2',
         '290,000,000', '390,000,000', '680,000,000', '68,000,000', '408,000,000', '204,000,000'],
    ]
    spans = [[0, c, 2, 1] for c in range(6)] + [[0, 6, 1, 3]]
    tables = {'area': area}
    pages = [
        {'texts': [
            (40, 40, '[합성 시험 자료] 합성 가람 아파트 신규분양 입주자모집공고'),
            (40, 70, '입주자모집공고일 : 2026. 10. 5.(월)'),
            (40, 100, '주택관리번호: {houseManageNo}'),
        ], 'tables': []},
    ]
    if multi_page:
        tables['band1'] = _table(40, 192, [65, 45, 45, 110, 55, 45, 70, 70, 70, 65, 65, 65],
                                 [14, 14, 16], band_rows[:3], spans)
        tables['band2'] = _table(40, 80, [65, 45, 45, 110, 55, 45, 70, 70, 70, 65, 65, 65],
                                 [16], [band_rows[3]], [])
        pages.append({'texts': [
            (40, 64, '■ 공급대상'), (690, 76, '[단위: ㎡, 세대]'),
            (40, 176, '■ 공급금액 및 납부일정'), (690, 188, '[단위: 세대, 원]'),
        ], 'tables': ['area', 'band1']})
        p3_texts = [(40, 40, '■ 공급금액(계속)')]
        if include_optional_statement:
            p3_texts.append((40, 140, '※ 발코니 확장 및 추가선택품목은 계약자가 선택하여 별도 계약하는 사항입니다.'))
        if include_mandatory:
            p3_texts.append((40, 170, '※ 발코니 확장형으로만 공급합니다.'))
        pages.append({'texts': p3_texts, 'tables': ['band2']})
    else:
        spans_all = spans + [[2, 0, 2, 1], [2, 1, 2, 1], [2, 2, 2, 1]]
        tables['band'] = _table(40, 192, [65, 45, 45, 110, 55, 45, 70, 70, 70, 65, 65, 65],
                                [14, 14, 16, 16], band_rows, spans_all)
        p2_texts = [
            (40, 64, '■ 공급대상'), (690, 76, '[단위: ㎡, 세대]'),
            (40, 176, '■ 공급금액 및 납부일정'), (690, 188, '[단위: 세대, 원]'),
        ]
        if include_optional_statement:
            p2_texts.append((40, 290, '※ 발코니 확장 및 추가선택품목은 계약자가 선택하여 별도 계약하는 사항입니다.'))
        if include_mandatory:
            p2_texts.append((40, 320, '※ 발코니 확장형으로만 공급합니다.'))
        pages.append({'texts': p2_texts, 'tables': ['area', 'band']})
    return {
        'houseManageNo': '9900000001', 'noticeDate': '2026.10.05.(월)', 'labels': True, 'labelOffset': 0,
        'tables': tables, 'pages': pages,
    }


class NoticeFormatAndCorrectionTests(unittest.TestCase):
    """작업 L 신규분양 가격 구간·식별 변형·재공급 변형·본문 정정 표지(A-59a) 합성 경계 검사."""

    def test_identity_variants_space_stripped_unranked_and_strict_rejections(self):
        spec = synthetic_notice_spec()
        spec['pages'][0]['texts'] = [
            (40, 40, '[합성 시험 자료] 합성 무순위(사후) 입주자모집공고'),
            (40, 70, '무순위(사후)입주자모집공고일:2026.10.5.(월)'),
            (40, 100, '공고번호:9900000001'),
            (40, 130, '최초입주자모집공고일:2024.05.31.(금) 최초주택관리번호:9900000000'),
        ]
        result, _ = _run(spec)
        self.assertEqual((result['status'], result['identity']['status']), ('checked', 'confirmed'))
        self.assertEqual(result['identity']['houseManageNo'], ['9900000001'])
        self.assertEqual(result['identity']['noticeDate'], ['2026-10-05'])

        # 다른 회차 번호가 섞이면 모호함으로 거부한다(완화 금지).
        amb = copy.deepcopy(spec)
        amb['pages'][0]['texts'].append((40, 160, '주택관리번호:9900000099'))
        res_amb, _ = _run(amb)
        self.assertEqual((res_amb['status'], res_amb['identity']['status']), ('rejected', 'ambiguous'))
        self.assertIn('pdf_identity_ambiguous', _codes(res_amb))

        # 공고일이 다른 날이면 불일치로 거부한다.
        mismatch = copy.deepcopy(spec)
        mismatch['pages'][0]['texts'][1] = (40, 70, '입주자모집공고일 : 2026. 10. 6.(화)')
        res_mis, _ = _run(mismatch)
        self.assertEqual((res_mis['status'], res_mis['identity']['status']), ('rejected', 'mismatch'))
        self.assertIn('pdf_notice_date_mismatch', _codes(res_mis))

    def test_band_price_table_confirms_units_timings_optional_zero_and_never_fabricates_rooms(self):
        for multi_page in (False, True):
            with self.subTest(multi_page=multi_page):
                spec = _synthetic_band_spec(include_optional_statement=True, multi_page=multi_page)
                result, merged = _run(spec)
                self.assertEqual(result['status'], 'checked')
                upper = _field(result, 'sale_price', '101동·102동 3호 라인 11~15층')
                lower = _field(result, 'sale_price', '101동·102동 3호 라인 6~10층')
                self.assertEqual((upper['status'], upper['value']), ('confirmed', '700000000'))
                self.assertEqual((lower['status'], lower['value']), ('confirmed', '680000000'))
                self.assertEqual(upper['unit'], {
                    'kind': 'band', 'buildings': ['101동', '102동'], 'lines': ['3호'],
                    'floors': {'from': 11, 'to': 15}, 'households': 3,
                })
                # 호실 번호(1103호·1503호 등)를 추정해 만들지 않는다.
                dumped = json.dumps([result, merged], ensure_ascii=False)
                for fabricated in ('1103호', '1503호', '603호', '1003호'):
                    self.assertNotIn(fabricated, dumped)
                # 선택 품목 명시 → 필수 옵션 0원(optional_only) 및 소계=분양가
                opt = _field(result, 'required_options', '101동·102동 3호 라인 11~15층')
                self.assertEqual((opt['status'], opt['value'], opt['classification']), ('confirmed', '0', 'optional_only'))
                room = _room(merged, '101동·102동 3호 라인 11~15층')
                self.assertEqual((room['subtotal']['won'], room['unit']['kind'], room['unit']['households']),
                                 ('700000000', 'band', 3))
                # 납부 일정: 날짜 있는 중도금은 exact, 계약시·입주시는 relative 유지
                sched = next(s for s in result['paymentSchedules']
                             if s['item'] == 'sale_price' and s['room'] == '101동·102동 3호 라인 11~15층')
                self.assertEqual(sched['status'], 'confirmed')
                self.assertEqual([(i['stage'], i['timing']['dateStatus'], i['timing']['date']) for i in sched['installments']], [
                    ('deposit', 'relative', None),
                    ('interim', 'exact', '2027-05-10'),
                    ('balance', 'relative', None),
                ])
                opt_sched = next(s for s in result['paymentSchedules']
                                 if s['item'] == 'required_options' and s['room'] == '101동·102동 3호 라인 11~15층')
                self.assertEqual((opt_sched['status'], opt_sched['totalWon'], opt_sched['installments']),
                                 ('confirmed', '0', []))

    def test_optional_options_without_statement_or_with_mandatory_phrase_stay_held(self):
        # 선택 품목 명시가 없으면 0원으로 채우지 않고 보류한다.
        res_missing, merged_missing = _run(_synthetic_band_spec(include_optional_statement=False))
        opt = _field(res_missing, 'required_options', '101동·102동 3호 라인 11~15층')
        self.assertEqual((opt['status'], opt['value']), ('unverified', None))
        self.assertIn('options_table_not_found', opt['reasons'])
        self.assertIsNone(_room(merged_missing, '101동·102동 3호 라인 11~15층')['subtotal']['won'])

        # 선택 문구와 필수 확장 문구가 함께 있으면 보류한다.
        res_both, _ = _run(_synthetic_band_spec(include_optional_statement=True, include_mandatory=True))
        opt_both = _field(res_both, 'required_options', '101동·102동 3호 라인 11~15층')
        self.assertEqual((opt_both['status'], opt_both['value']), ('unverified', None))

    def test_band_cross_checks_hold_component_payment_household_and_floor_overlap(self):
        # 1) 대지비+건축비 != 계
        bad_comp = _synthetic_band_spec()
        bad_comp['tables']['band']['cells'][2][6] = '301,000,000'
        res_comp, _ = _run(bad_comp)
        self.assertIn('sale_price_component_mismatch', _field(res_comp, 'sale_price', '101동·102동 3호 라인 11~15층')['reasons'])
        self.assertEqual(_field(res_comp, 'sale_price', '101동·102동 3호 라인 6~10층')['status'], 'confirmed')

        # 2) 납부 단계 합 != 계
        bad_pay = _synthetic_band_spec()
        bad_pay['tables']['band']['cells'][2][9] = '71,000,000'
        res_pay, _ = _run(bad_pay)
        self.assertIn('sale_price_payment_mismatch', _field(res_pay, 'sale_price', '101동·102동 3호 라인 11~15층')['reasons'])

        # 3) 해당세대수 합 != 공급세대수
        bad_hh = _synthetic_band_spec()
        bad_hh['tables']['band']['cells'][2][5] = '4'
        res_hh, _ = _run(bad_hh)
        for room_name in ('101동·102동 3호 라인 11~15층', '101동·102동 3호 라인 6~10층'):
            self.assertIn('band_household_count_mismatch', _field(res_hh, 'sale_price', room_name)['reasons'])

        # 4) 같은 동·라인의 층 구간 겹침(10~15층 vs 6~10층)
        overlap = _synthetic_band_spec()
        overlap['tables']['band']['cells'][2][4] = '10-15층'
        res_ov, _ = _run(overlap)
        for room_name in ('101동·102동 3호 라인 10~15층', '101동·102동 3호 라인 6~10층'):
            f = _field(res_ov, 'sale_price', room_name)
            self.assertEqual(f['status'], 'conflict')
            self.assertIn('band_floor_overlap', f['reasons'])

        # 5) 긴 동 목록은 UTF-16 64자 이내로 결정적 축약된다.
        long_spec = _synthetic_band_spec()
        long_spec['tables']['band']['cells'][2][3] = ', '.join(f'{101 + i}동 1,2,3,4호' for i in range(12))
        res_long, _ = _run(long_spec)
        long_fields = [f for f in res_long['fields'] if f['item'] == 'sale_price' and f['status'] == 'confirmed']
        self.assertEqual(len(long_fields), 2)
        for f in long_fields:
            self.assertLessEqual(len(f['room'].encode('utf-16-le')) // 2, 64)

    def test_resupply_variants_missing_type_col_hyphen_room_and_options_without_charge_col(self):
        # 1) 주택형 열이 없는 단일 주택형 재공급 가격표 + 하이픈 동-호('0202-1501') + 유·무상 열 없는 옵션 표 + 세로 줄바꿈 단위 블록
        spec = synthetic_notice_spec()
        spec['tables']['price'] = _table(40, 192, [60, 40, 90, 85, 85, 85, 85, 85], [14, 14, 16, 16], [
            ['공급세대수', '층', '동·호수', '공급금액', None, None, '계약금(10%)', '잔금(90%)'],
            [None, None, None, '대지비', '건축비', '계', '계약시', '입주시'],
            ['2', '15층', '0202-1501', '300,000,000', '400,000,000', '700,000,000', '70,000,000', '630,000,000'],
            [None, '16층', '0202-1601', '310,000,000', '410,000,000', '720,000,000', '72,000,000', '648,000,000'],
        ], [[0, c, 2, 1] for c in (0, 1, 2)] + [[0, 3, 1, 3], [2, 0, 2, 1]])
        spec['tables']['options'] = _table(40, 162, [80, 90, 100, 80, 80, 80], [14, 14, 16, 16, 16], [
            ['동호수', '구분/품목', '품목(규격)', '공급금액', '계약금(10%)', '잔금(90%)'],
            [None, None, None, None, '계약시', '입주시'],
            ['0202-1501', '발코니확장', '합성규격', '10,000,000', '1,000,000', '9,000,000'],
            ['0202-1501', '소계', '', '10,000,000', None, None],
            ['0202-1601', '발코니확장', '합성규격', '12,000,000', '1,200,000', '10,800,000'],
        ], [[0, c, 2, 1] for c in range(4)])
        spec['pages'][1]['texts'][5] = (690, 188, '단위\n세대\n원\n(\n:\n,\n)')
        result, merged = _run(spec)
        self.assertEqual(_field(result, 'sale_price', '0202동 1501호')['value'], '700000000')
        self.assertEqual(_field(result, 'required_options', '0202동 1501호')['value'], '10000000')
        self.assertEqual(_room(merged, '0202동 1501호')['subtotal']['won'], '710000000')
        self.assertEqual(_room(merged, '0202동 1601호')['subtotal']['won'], '732000000')

        # 2) 복수 주택형 공고에서 주택형 열·제목 모두 없으면 모호하므로 room_type_column_missing으로 보류한다.
        target, notice, models, _ = synthetic_catalog_inputs()
        second = dict(models['observations'][0]['row'], MODEL_NO='02', HOUSE_TY='059.0000A', SUPLY_AR='80.00')
        models['observations'].append({'page': 1, 'position': 2, 'row': second})
        cat_multi = normalize_catalog(notice, models, target=target)
        res_multi = inspect_extracted_pages(synthetic_pages(spec), target=target, catalog=cat_multi,
                                            document=synthetic_document())
        self.assertIn('room_type_column_missing', _codes(res_multi))
        self.assertEqual([f for f in res_multi['fields'] if f['item'] == 'sale_price'], [])

    def test_in_pdf_correction_markers_hold_affected_scopes_unless_full_replacement_declared(self):
        # (a) 표지 정정공고 + 변경 전/후 표(공급금액 대상), 전량 대체 미명시 → 공급금액·납부 보류, 독립 공급면적 유지
        spec = _synthetic_band_spec(include_optional_statement=True)
        spec['pages'][0]['texts'][0] = (40, 40, '[합성 시험 자료] 정정 입주자모집공고')
        spec['tables']['corr'] = _table(40, 140, [100, 180, 180], [14, 16], [
            ['항목', '변경 전', '변경 후'],
            ['공급금액(84A)', '690,000,000원', '700,000,000원'],
        ], [])
        spec['pages'][0]['tables'] = ['corr']
        res, merged = _run(spec)
        self.assertTrue(res['correction']['detected'])
        self.assertFalse(res['correction']['fullReplacementDeclared'])
        self.assertEqual(res['correction']['affectedScopes'], ['sale_price'])
        self.assertEqual(_field(res, 'supply_area')['status'], 'confirmed')
        self.assertEqual(_field(res, 'sale_price', '101동·102동 3호 라인 11~15층')['status'], 'unverified')
        self.assertIn('in_pdf_correction_unverified',
                      _field(res, 'sale_price', '101동·102동 3호 라인 11~15층')['reasons'])
        self.assertIsNone(_room(merged, '101동·102동 3호 라인 11~15층')['subtotal']['won'])
        self.assertEqual(merged['housingTypes'][0]['checkedSupplyArea']['status'], 'confirmed')

        # (b) 긍정 전량 대체 문장이 명시되면 확인 유지
        spec_full = copy.deepcopy(spec)
        spec_full['pages'][0]['texts'].append(
            (40, 220, '기존 입주자모집공고문의 전체를 본 정정공고문으로 대체합니다.'))
        res_full, merged_full = _run(spec_full)
        self.assertTrue(res_full['correction']['fullReplacementDeclared'])
        self.assertEqual(_field(res_full, 'sale_price', '101동·102동 3호 라인 11~15층')['status'], 'confirmed')
        self.assertEqual(_room(merged_full, '101동·102동 3호 라인 11~15층')['subtotal']['won'], '700000000')

        # (c) 부정·제외 문구가 섞이면 전량 대체로 인정하지 않는다.
        spec_neg = copy.deepcopy(spec)
        spec_neg['pages'][0]['texts'].append(
            (40, 220, '단, 일부 항목을 제외하고 기존 입주자모집공고문의 전체를 본 정정공고문으로 대체합니다.'))
        res_neg, _ = _run(spec_neg)
        self.assertFalse(res_neg['correction']['fullReplacementDeclared'])
        self.assertEqual(_field(res_neg, 'sale_price', '101동·102동 3호 라인 11~15층')['status'], 'unverified')

        # (d) 표지 제목만 정정공고이고 범위 표·절이 없으면 전체('all')를 보류한다.
        spec_cover = _synthetic_band_spec(include_optional_statement=True)
        spec_cover['pages'][0]['texts'][0] = (40, 40, '[합성 시험 자료] 정정 입주자모집공고')
        res_cover, _ = _run(spec_cover)
        self.assertEqual(res_cover['correction']['affectedScopes'], ['all'])
        self.assertEqual(_field(res_cover, 'supply_area')['status'], 'unverified')

    @unittest.skipUnless(HAS_FITZ, 'PyMuPDF를 설치한 문서 작업자에서 실행')
    def test_borderless_outer_columns_are_recovered_from_horizontal_rulings_in_synthetic_pdf(self):
        """좌·우 외곽 세로선이 생략된 HWP 변환 PDF 표에서 가로 괘선으로 첫 열·마지막 열을 복구한다(합성)."""
        import fitz
        spec = _synthetic_band_spec(include_optional_statement=True)
        document = fitz.open()
        font = fitz.Font('korea')
        for number, page_spec in enumerate(spec['pages'], 1):
            page = document.new_page(width=PAGE_WIDTH, height=PAGE_HEIGHT)
            page.insert_font(fontname='kr', fontbuffer=font.buffer)
            for x, y, text in _page_texts(spec, number, page_spec):
                page.insert_text((x, y), text, fontname='kr', fontsize=7)
            for name in page_spec['tables']:
                table = spec['tables'][name]
                xs, ys, boxes = _geometry(table)
                # 가로선과 내부 세로선만 그리고 좌·우 외곽 세로선(xs[0], xs[-1])은 생략한다.
                for (r, c), box in boxes.items():
                    x0, y0, x1, y1 = box
                    page.draw_line((x0, y0), (x1, y0), color=(0, 0, 0), width=0.5)
                    page.draw_line((x0, y1), (x1, y1), color=(0, 0, 0), width=0.5)
                    if x0 > xs[0] + 0.1:
                        page.draw_line((x0, y0), (x0, y1), color=(0, 0, 0), width=0.5)
                    if x1 < xs[-1] - 0.1:
                        page.draw_line((x1, y0), (x1, y1), color=(0, 0, 0), width=0.5)
                    text = _fill(spec, table['cells'][r][c])
                    if text:
                        page.insert_text((x0 + 2, y0 + (y1 - y0) * 0.7), text, fontname='kr', fontsize=6)
        document.subset_fonts()
        pdf_bytes = document.tobytes(garbage=3, deflate=True)
        target, _, _, catalog = _catalog()
        result = inspect_notice_pdf(pdf_bytes, target=target, catalog=catalog, document=synthetic_document())
        self.assertEqual(result['status'], 'checked')
        self.assertEqual(_field(result, 'supply_area')['value'], '112.4000')
        self.assertEqual(_field(result, 'sale_price', '101동·102동 3호 라인 11~15층')['value'], '700000000')
        self.assertEqual(_field(result, 'required_options', '101동·102동 3호 라인 11~15층')['value'], '0')


class FullReadAndCheonanFormatTests(unittest.TestCase):
    """작업 R 합성 경계 검사: 전체 쪽 스캔, 쪼개진 단위, 묶음 소계, 쪽 경계 분할 셀, 부가세 '-', N층 이상, 계약면적 0.0001, 옵션 별도 계약."""

    def _cheonan_band_spec(self):
        """합성 천안형 가격표(실제 공고가 아님): 쪼개진 단위, 묶음별 공급세대수, 부가세 '-', N층 이상, 약식표기=동번호, 쪽 경계 분할 셀."""
        area = _table(40, 80, [50, 70, 40, 80, 50, 65, 65, 65, 65, 65, 55], [14, 14, 16, 16], [
            ['주택구분', '주택관리번호', '모델', '주택형(전용면적기준)', '약식표기', '주택공급면적(㎡)', None, None,
             '기타공용면적', '계약면적', '총공급세대수'],
            [None, None, None, None, None, '주거전용면적', '주거공용면적', '소계', None, None, None],
            ['민영', '{houseManageNo}', '01', '084.0000A', '84A', '84.0000', '28.4000', '112.4000', '50.0000', '162.4000', '10'],
            ['민영', '{houseManageNo}', '02', '102.0000', '102', '102.0000', '35.0000', '137.0000', '60.0000', '197.0000', '18'],
        ], [[0, c, 2, 1] for c in (0, 1, 2, 3, 4, 8, 9, 10)] + [[0, 5, 1, 3]])
        # 2쪽 가격표: 84A 두 묶음(6+4=10, 부가세 '-', 26층 이상) + 102 첫 묶음 앞부분(12세대 중 8세대, 동별라인별이 '104,105동'에서 끊김)
        p2_band = _table(40, 232, [45, 45, 105, 55, 40, 70, 70, 55, 70, 60, 60, 60], [14, 14] + [16] * 6, [
            ['약식표기', '공급세대수', '동별 라인별', '층구분', '세대수',
             '공급금액', None, None, None, '계약금(10%)', '중도금(60%)', '잔금(30%)'],
            [None, None, None, None, None,
             '대지비', '건축비', '부가가치세', '계', '계약시', '2027.05.10.', '입주시'],
            ['84A', '6', '101동 1호', '2~25층', '2',
             '280,000,000', '320,000,000', '-', '600,000,000', '60,000,000', '360,000,000', '180,000,000'],
            [None, None, None, '26층 이상', '4',
             '290,000,000', '330,000,000', '-', '620,000,000', '62,000,000', '372,000,000', '186,000,000'],
            [None, '4', '106동 4호', '2~25층', '1',
             '300,000,000', '340,000,000', '-', '640,000,000', '64,000,000', '384,000,000', '192,000,000'],
            [None, None, None, '26층 이상', '3',
             '310,000,000', '350,000,000', '-', '660,000,000', '66,000,000', '396,000,000', '198,000,000'],
            ['102', '12', '101동 1,2호 104,105동', '2층', '4',
             '300,000,000', '400,000,000', '40,000,000', '740,000,000', '74,000,000', '444,000,000', '222,000,000'],
            [None, None, None, '3층', '4',
             '310,000,000', '400,000,000', '40,000,000', '750,000,000', '75,000,000', '450,000,000', '225,000,000'],
        ], [[0, c, 2, 1] for c in range(5)] + [[0, 5, 1, 4], [2, 0, 4, 1], [2, 1, 2, 1], [2, 2, 2, 1],
                                               [4, 1, 2, 1], [4, 2, 2, 1], [6, 0, 2, 1], [6, 1, 2, 1], [6, 2, 2, 1]])
        # 3쪽 머리말 없는 연속 가격표: 102 첫 묶음 나머지('3,4호', 4세대 -> 4+4+4=12) + 102 둘째 묶음('102동 3,4호', 6세대 -> 12+6=18)
        p3_band = _table(40, 80, [45, 45, 105, 55, 40, 70, 70, 55, 70, 60, 60, 60], [16, 16, 16], [
            ['', '', '3,4호', '26층 이상', '4',
             '320,000,000', '400,000,000', '40,000,000', '760,000,000', '76,000,000', '456,000,000', '228,000,000'],
            ['', '6', '102동 3,4호', '11~20층', '2',
             '330,000,000', '400,000,000', '40,000,000', '770,000,000', '77,000,000', '462,000,000', '231,000,000'],
            [None, None, None, '21층 이상', '4',
             '340,000,000', '400,000,000', '40,000,000', '780,000,000', '78,000,000', '468,000,000', '234,000,000'],
        ], [[0, 0, 3, 1], [1, 1, 2, 1], [1, 2, 2, 1]])
        return {
            'houseManageNo': '9900000001', 'noticeDate': '2026.10.05.(월)', 'labels': True, 'labelOffset': 0,
            'tables': {'area': area, 'p2_band': p2_band, 'p3_band': p3_band},
            'pages': [
                {'texts': [
                    (40, 40, '[합성 시험 자료] 합성 천안형 신규분양 입주자모집공고'),
                    (40, 70, '입주자모집공고일 : 2026. 10. 5.(월)'),
                    (40, 100, '주택관리번호: {houseManageNo}'),
                ], 'tables': []},
                {'texts': [
                    (40, 64, '■ 공급대상'), (690, 76, '[단위: ㎡, 세대]'),
                    (40, 178, '■ 공급금액 및 납부일정   단위세대원\n(\n: \n, \n)'),
                ], 'tables': ['area', 'p2_band']},
                {'texts': [
                    (40, 180, '※ 발코니 확장 및 추가선택품목은 계약자가 선택하여 별도 계약하는 사항입니다.'),
                ], 'tables': ['p3_band']},
            ],
        }

    def _two_model_catalog(self):
        target, notice, models, _ = synthetic_catalog_inputs()
        base = models['observations'][0]['row']
        models['observations'] = [
            {'page': 1, 'position': 1, 'row': dict(base, MODEL_NO='01', HOUSE_TY='084.0000A', SUPLY_AR='112.4000', LTTOT_TOP_AMOUNT='70,000')},
            {'page': 1, 'position': 2, 'row': dict(base, MODEL_NO='02', HOUSE_TY='102.0000 ', SUPLY_AR='137.0000', LTTOT_TOP_AMOUNT='80,000')},
        ]
        return target, notice, models, normalize_catalog(notice, models, target=target)

    def test_cheonan_format_split_unit_bundles_vat_open_floor_and_cross_page_location_stitch(self):
        spec = self._cheonan_band_spec()
        target, notice, models, catalog = self._two_model_catalog()
        result = inspect_extracted_pages(synthetic_pages(spec), target=target, catalog=catalog,
                                         document=synthetic_document())
        merged = normalize_catalog(notice, models, target=target, evidence=result['evidence'])
        self.assertEqual(result['status'], 'checked')
        self.assertEqual(result['summary']['byItem']['sale_price'], {'confirmed': 9, 'unverified': 0, 'conflict': 0})
        self.assertEqual(result['summary']['byItem']['required_options'], {'confirmed': 9, 'unverified': 0, 'conflict': 0})
        # 1) N층 이상: 상한 미추정 {from: 26, to: None}, 표시 이름 '… 26층 이상', 확인(보류 아님)
        open_band = _field(result, 'sale_price', '101동 1호 라인 26층 이상')
        self.assertEqual(open_band['status'], 'confirmed')
        self.assertEqual(open_band['unit']['floors'], {'from': 26, 'to': None})
        self.assertEqual(set(open_band['unit']['floors']), {'from', 'to'})
        # 2) 약식표기 '102'와 동별 '102동 3,4호' 열 분리
        same_num = _field(result, 'sale_price', '102동 3호·4호 라인 11~20층')
        self.assertEqual((same_num['status'], same_num['modelNo'], same_num['value']), ('confirmed', '02', '770000000'))
        self.assertEqual(same_num['unit']['buildings'], ['102동'])
        self.assertEqual(same_num['unit']['lines'], ['3호', '4호'])
        # 3) 쪽 경계 분할 병합 셀 이어붙이기: 2쪽('101동 1,2호 104,105동') + 3쪽('3,4호') → 양쪽 근거 쪽 [2, 3] 기록
        for floor_lbl, expected_page in (('2층', 2), ('3층', 2), ('26층 이상', 3)):
            name = f'101동 1호·2호·104동 3호·4호·105동 3호·4호 라인 {floor_lbl}'
            stitched = _field(result, 'sale_price', name)
            self.assertEqual((stitched['status'], stitched['page'], stitched['evidencePages']),
                             ('confirmed', expected_page, [2, 3]))
            self.assertEqual(stitched['unit']['buildings'], ['101동', '104동', '105동'])
            self.assertEqual(stitched['unit']['lines'], ['1호', '2호', '3호', '4호'])
            # evidence와 paymentSchedules, normalize_catalog 모두 2쪽·3쪽 근거를 보존한다.
            ev_pages = sorted(r['page'] for r in result['evidence'] if r['item'] == 'sale_price' and r['room'] == name)
            self.assertEqual(ev_pages, [2, 3])
            sched = next(s for s in result['paymentSchedules'] if s['item'] == 'sale_price' and s['room'] == name)
            self.assertEqual([e['page'] for e in sched['evidence']], [2, 3])
            room_cat = _room(merged, name)
            self.assertEqual(room_cat['subtotal']['status'], 'confirmed')
            self.assertEqual(sorted(e['page'] for e in room_cat['salePrice']['evidence']), [2, 3])
        # 모든 evidence 행이 ingestion_notices 계약을 통과한다.
        for row in result['evidence']:
            self.assertIsNone(_record_problem(row))

    def test_split_unit_note_distinguishes_won_cheonwon_manwon_and_blocks_unsupported_units(self):
        # 1) 쪼개진 천원·만원은 각각 1000·10000으로 환산한다(원으로 오인 금지).
        for label, unit_text, scale in (
            ('split_cheonwon', '■ 공급금액 및 납부일정   단위세대천원\n(\n: \n, \n)', 1000),
            ('split_manwon', '■ 공급금액 및 납부일정   단위세대만원\n(\n: \n, \n)', 10000),
        ):
            with self.subTest(label=label):
                spec = _synthetic_band_spec(include_optional_statement=True)
                spec['pages'][1]['texts'][3] = (40, 188, unit_text)
                for row in spec['tables']['band']['cells'][2:]:
                    for idx in range(6, 12):
                        row[idx] = f'{int(row[idx].replace(",", "")) // scale:,}'
                result, _ = _run(spec)
                sale = _field(result, 'sale_price', '101동·102동 3호 라인 11~15층')
                self.assertEqual((sale['status'], sale['value']), ('confirmed', '700000000'))

        # 2) 미지원 단위(백만원·억원)·혼합(원+천원)·일반 문구(지원금)는 오인하지 않고 보류한다.
        for text, expected_code in (
            ('■ 공급금액   단위세대백만원\n(\n: \n, \n)', 'amount_unit_unverified'),
            ('[단위: 세대, 백만원]', 'amount_unit_unverified'),
            ('■ 공급금액   단위세대억원\n(\n: \n, \n)', 'amount_unit_unverified'),
            ('■ 공급금액   단위원천원\n(\n: \n, \n)', 'amount_unit_ambiguous'),
            ('■ 공급금액   단위: 세대, 지원금', 'amount_unit_unverified'),
        ):
            with self.subTest(text=text):
                spec = _synthetic_band_spec(include_optional_statement=True)
                spec['pages'][1]['texts'][3] = (40, 188, text)
                result, _ = _run(spec)
                sale = _field(result, 'sale_price', '101동·102동 3호 라인 11~15층')
                self.assertEqual((sale['status'], sale['value']), ('unverified', None))
                self.assertIn(expected_code, sale['reasons'])

    def test_bundle_subtotal_mismatches_and_repeated_type_total_boundaries(self):
        target, _, _, catalog = self._two_model_catalog()
        # 1) 묶음 내부 합 불일치(전체 합은 10으로 같더라도 묶음1 2+3=5 != 6, 묶음2 2+3=5 != 4) → 보류
        bad_inner = self._cheonan_band_spec()
        bad_inner['tables']['p2_band']['cells'][3][4] = '3'  # 묶음1: 2+3=5 (표기 6)
        bad_inner['tables']['p2_band']['cells'][4][4] = '2'  # 묶음2: 2+3=5 (표기 4)
        res_inner = inspect_extracted_pages(synthetic_pages(bad_inner), target=target, catalog=catalog,
                                            document=synthetic_document())
        self.assertIn('band_household_count_mismatch', _field(res_inner, 'sale_price', '101동 1호 라인 2~25층')['reasons'])
        # 다른 모델(102)은 영향 없이 확인 유지
        self.assertEqual(_field(res_inner, 'sale_price', '102동 3호·4호 라인 11~20층')['status'], 'confirmed')

        # 2) 묶음 소계 합(10) != 공급대상 표 총공급세대수(12) → 보류
        bad_area = self._cheonan_band_spec()
        bad_area['tables']['area']['cells'][2][10] = '12'
        res_area = inspect_extracted_pages(synthetic_pages(bad_area), target=target, catalog=catalog,
                                           document=synthetic_document())
        self.assertIn('band_household_count_mismatch', _field(res_area, 'sale_price', '101동 1호 라인 2~25층')['reasons'])

        # 3) 기존 서식: 주택형 전체 공급세대수('5')가 다음 쪽 머리말 표에 반복된 경우에도 계속 확인된다.
        rep = _synthetic_band_spec(include_optional_statement=True, multi_page=True)
        head = rep['tables']['band1']['cells'][:2]
        row2 = copy.deepcopy(rep['tables']['band2']['cells'][0])
        row2[0], row2[1], row2[2] = '084.0000A', '84A', '5'
        rep['tables']['band2'] = _table(
            40, 80, [65, 45, 45, 110, 55, 45, 70, 70, 70, 65, 65, 65], [14, 14, 16],
            head + [row2], [[0, c, 2, 1] for c in range(6)] + [[0, 6, 1, 3]],
        )
        res_rep, _ = _run(rep)
        self.assertEqual(_field(res_rep, 'sale_price', '101동·102동 3호 라인 11~15층')['status'], 'confirmed')
        self.assertEqual(_field(res_rep, 'sale_price', '101동·102동 3호 라인 6~10층')['status'], 'confirmed')

    def test_ambiguous_cross_page_location_fragment_is_not_stitched(self):
        # 앞 쪽 마지막 동·라인 셀이 이미 완성('101동 1,2호')되어 있으면 다음 쪽의 '3,4호'를 임의로 이어 붙이지 않고 보류한다.
        spec = self._cheonan_band_spec()
        spec['tables']['p2_band']['cells'][6][2] = '101동 1,2호'
        target, _, _, catalog = self._two_model_catalog()
        result = inspect_extracted_pages(synthetic_pages(spec), target=target, catalog=catalog,
                                         document=synthetic_document())
        orphan = _field(result, 'sale_price', '102 26층 이상')
        self.assertEqual((orphan['status'], orphan['value']), ('unverified', None))
        self.assertIn('band_location_unreadable', orphan['reasons'])
        self.assertNotIn('evidencePages', orphan)

    def test_vat_dash_and_open_floor_overlap_boundaries(self):
        # 1) 부가가치세 '-'는 대지비+건축비=계일 때만 0으로 확인하고, 어긋나거나 판독 불가 문자열이면 보류한다.
        spec = self._cheonan_band_spec()
        spec['tables']['p2_band']['cells'][2][6] = '320,000,001'  # 280M + 320M+1 != 600M
        spec['tables']['p2_band']['cells'][3][7] = '미정'
        target, _, _, catalog = self._two_model_catalog()
        res = inspect_extracted_pages(synthetic_pages(spec), target=target, catalog=catalog,
                                      document=synthetic_document())
        for name in ('101동 1호 라인 2~25층', '101동 1호 라인 26층 이상'):
            f = _field(res, 'sale_price', name)
            self.assertEqual((f['status'], f['value']), ('conflict', None))
            self.assertIn('sale_price_component_mismatch', f['reasons'])

        # 2) N층 이상 겹침 경계: 2~26층과 26층 이상은 26층에서 겹쳐 band_floor_overlap(conflict)로 보류한다.
        overlap = self._cheonan_band_spec()
        overlap['tables']['p2_band']['cells'][2][3] = '2~26층'
        res_ov = inspect_extracted_pages(synthetic_pages(overlap), target=target, catalog=catalog,
                                         document=synthetic_document())
        for name in ('101동 1호 라인 2~26층', '101동 1호 라인 26층 이상'):
            f = _field(res_ov, 'sale_price', name)
            self.assertEqual(f['status'], 'conflict')
            self.assertIn('band_floor_overlap', f['reasons'])

    def test_contract_area_0001_rounding_keeps_supply_area_confirmed_while_larger_or_supply_error_holds(self):
        # 1) 공급면적(전용+주거공용=소계)은 맞고 계약면적만 ±0.0001㎡ 어긋나면 공급면적 확인 + rounding_note
        for contract_val in ('162.3999', '162.4001'):
            with self.subTest(contract_val=contract_val):
                spec = synthetic_notice_spec()
                _cells(spec, 'area')[2][9] = contract_val
                result, merged = _run(spec)
                area = _field(result, 'supply_area')
                self.assertEqual((area['status'], area['value']), ('confirmed', '112.4000'))
                self.assertEqual(area['checks']['contract_equals_supply_plus_other'], 'rounding_note')
                self.assertNotIn('contract_area_sum_mismatch', _codes(result))
                self.assertEqual(merged['housingTypes'][0]['checkedSupplyArea']['status'], 'confirmed')

        # 2) 계약면적이 0.0002㎡ 이상 어긋나면 지금처럼 보류(conflict)
        big = synthetic_notice_spec()
        _cells(big, 'area')[2][9] = '162.3998'
        res_big, _ = _run(big)
        area_big = _field(res_big, 'supply_area')
        self.assertEqual((area_big['status'], area_big['value']), ('conflict', None))
        self.assertIn('contract_area_sum_mismatch', area_big['reasons'])

        # 3) 공급면적 자체가 0.0001㎡ 어긋나면 절대 확인하지 않고 보류(conflict)
        bad_supply = synthetic_notice_spec()
        _cells(bad_supply, 'area')[2][6] = '28.3999'
        _cells(bad_supply, 'area')[2][9] = '162.3999'
        res_sup, _ = _run(bad_supply)
        area_sup = _field(res_sup, 'supply_area')
        self.assertEqual((area_sup['status'], area_sup['value']), ('conflict', None))
        self.assertIn('supply_area_sum_mismatch', area_sup['reasons'])

    def test_separate_contract_option_policy_and_no_mention_hold(self):
        # 1) '공급금액 미포함'·'별도 계약'·'별도 납부계좌' 문구만 있고 필수·승계 문구가 없으면 필수 옵션 0원 + 근거 쪽 기록
        for label, statement in (
            ('excluded', '※ 상기 공급금액에는 발코니 확장비용, 추가선택품목(유상옵션)이 포함되어 있지 않습니다.'),
            ('separate_contract', '※ 발코니 확장공사계약은 아파트 공급계약과 별도로 계약을 진행합니다.'),
            ('separate_account', '※ 분양대금 계약금 납부계좌는 발코니확장 공사대금 및 추가선택품목(유상옵션) 납부계좌와 상이합니다.'),
        ):
            with self.subTest(label=label):
                spec = _synthetic_band_spec(include_optional_statement=False)
                spec['pages'][1]['texts'].append((40, 290, statement))
                # 무관한 기반시설 점용계약 승계 문구는 옵션 필수 승계로 오인하지 않는다.
                spec['pages'][1]['texts'].append(
                    (40, 310, '※ 도시가스 정압기 설치를 위한 부지 점용계약은 계약자가 승계하여야 합니다.'))
                result, merged = _run(spec)
                opt = _field(result, 'required_options', '101동·102동 3호 라인 11~15층')
                self.assertEqual((opt['status'], opt['value'], opt['classification'], opt['page']),
                                 ('confirmed', '0', 'optional_only', 2))
                self.assertEqual(_room(merged, '101동·102동 3호 라인 11~15층')['subtotal']['won'], '700000000')

        # 2) 미포함·별도 문구가 있더라도 필수·승계 문구가 함께 있으면 보류 유지
        for mandatory in (
            '※ 기존 계약을 승계하는 조건으로 발코니 확장 변경이 불가합니다.',
            '※ 발코니 확장은 필수 선택 사항입니다.',
        ):
            with self.subTest(mandatory=mandatory):
                spec = _synthetic_band_spec(include_optional_statement=False)
                spec['pages'][1]['texts'].append(
                    (40, 290, '※ 상기 공급금액에는 발코니 확장비용이 미포함되어 있습니다.'))
                spec['pages'][1]['texts'].append((40, 310, mandatory))
                result, _ = _run(spec)
                opt = _field(result, 'required_options', '101동·102동 3호 라인 11~15층')
                self.assertEqual((opt['status'], opt['value']), ('unverified', None))
                self.assertIn('options_table_not_found', opt['reasons'])

        # 3) 옵션·발코니 언급이 전혀 없는 공고는 필수 옵션 미확인(보류) 유지
        no_mention = _synthetic_band_spec(include_optional_statement=False)
        res_none, merged_none = _run(no_mention)
        opt_none = _field(res_none, 'required_options', '101동·102동 3호 라인 11~15층')
        self.assertEqual((opt_none['status'], opt_none['value']), ('unverified', None))
        self.assertIn('options_table_not_found', opt_none['reasons'])
        self.assertIsNone(_room(merged_none, '101동·102동 3호 라인 11~15층')['subtotal']['won'])

    @unittest.skipUnless(HAS_FITZ, 'PyMuPDF를 설치한 문서 작업자에서 실행')
    def test_full_document_scan_reads_tables_past_page_40_and_cheonan_pdf_bytes(self):
        # 1) 45쪽 합성 PDF에서 42쪽 옵션 표가 MAX_TABLE_PAGES 잘림 없이 읽히는지 검증한다.
        spec = synthetic_notice_spec()
        options_page = spec['pages'].pop(2)  # 원래 3쪽(옵션 표)을 42쪽으로 이동
        for idx in range(39):
            spec['pages'].append({
                'texts': [(40, 40, f'합성 안내 본문 {idx + 1}: 주택형 및 추가선택품목 안내와 입주자모집공고일 기준 일반공급 자격 설명입니다.')],
                'tables': [],
            })
        spec['pages'].append(options_page)  # 42쪽
        for idx in range(3):
            spec['pages'].append({'texts': [(40, 40, f'합성 부록 쪽 {idx + 1}: 일반 유의사항입니다.')], 'tables': []})
        pdf_45 = build_synthetic_notice_pdf(spec)
        target, _, _, catalog = _catalog()
        res_45 = inspect_notice_pdf(pdf_45, target=target, catalog=catalog, document=synthetic_document())
        self.assertEqual(res_45['source']['pageCount'], 45)
        self.assertEqual(res_45['pages']['tableScan']['skipped_limit'], [])
        self.assertNotIn('table_scan_incomplete', _codes(res_45))
        self.assertIn(42, res_45['pages']['tableScan']['scanned'])
        opt = _field(res_45, 'required_options', '101동 101호')
        self.assertEqual((opt['status'], opt['value'], opt['page']), ('confirmed', '10000000', 42))

        # 2) 천안형 합성 PDF 바이트(쪼개진 단위, 묶음 소계, 102형=102동, 부가세 '-', N층 이상, 쪽 경계 분할 셀)
        ch_spec = self._cheonan_band_spec()
        ch_pdf = build_synthetic_notice_pdf(ch_spec)
        ch_target, _, _, ch_catalog = self._two_model_catalog()
        res_ch = inspect_notice_pdf(ch_pdf, target=ch_target, catalog=ch_catalog, document=synthetic_document())
        self.assertEqual(res_ch['status'], 'checked')
        self.assertEqual(res_ch['summary']['byItem']['sale_price'], {'confirmed': 9, 'unverified': 0, 'conflict': 0})
        self.assertEqual(res_ch['summary']['byItem']['required_options'], {'confirmed': 9, 'unverified': 0, 'conflict': 0})
        self.assertEqual(_field(res_ch, 'sale_price', '102동 3호·4호 라인 11~20층')['value'], '770000000')
        stitched = _field(res_ch, 'sale_price', '101동 1호·2호·104동 3호·4호·105동 3호·4호 라인 26층 이상')
        self.assertEqual((stitched['status'], stitched['evidencePages'], stitched['unit']['floors']),
                         ('confirmed', [2, 3], {'from': 26, 'to': None}))


if __name__ == '__main__':
    unittest.main()
