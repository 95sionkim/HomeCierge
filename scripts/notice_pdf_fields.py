#!/usr/bin/env python3
"""공식 공고 PDF에서 주택형 공급면적·호실 가격·필수 옵션과 항목별 납부 일정을 점검한다.

공고 식별(현재 공고 지정 문장·공급대상 표의 주택관리번호, 공고일과 API RCRIT_PBLANC_DE), API 주택형(modelNo·houseType),
원문 쪽·표 셀·단위와 산술(공급=주거전용+주거공용, 분양가=대지비+건축비=납부 합계, 유상 옵션 합=납부 합계)을 대조한다.
점검을 모두 통과한 값만 confirmed다. 불일치는 conflict, 불명확·부분은 unverified로 금액 없이 남겨 normalize_catalog가
그 항목만 보류하게 한다. 근거 자체가 없는 항목(표에 없는 주택형·옵션 표에 없는 호실)은 쪽을 만들어 넣지 않고 행을 내지 않는다.
OCR·모델 추출·공식 PDF 확보·정정본 선택(D-04)은 하지 않는다. PyMuPDF는 호출 시점에만 불러오는 선택 의존성이다.
납부 일정은 BE-02 근거 행과 별도로 제공한다. 납부 금액은 호실별로 검산하고 기한과 사건 기준은 원문 표에 묶는다.
"""
import argparse
import hashlib
import json
import re
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

from extract_notice_pdf import PRIOR_ROUND_MARKER, compact, find_identities, find_notice_numbers, table_record
from ingestion_notices import AREA, AREA_LENGTH, DOCUMENT_KEYS, DOCUMENT_SOURCES, WON, WON_LENGTH

CONTRACT = 'notice-pdf-fields/v0'
MAX_PDF_BYTES = 50 * 1024 * 1024  # 공식 첨부 확보 상한과 같다
MAX_PAGES = 150  # 표 추출 전에 확인하는 전체 쪽 상한
MAX_TABLE_PAGES = 40  # 표를 추출하는 후보 쪽(머리말 단어가 있는 쪽과 그 다음 쪽) 상한
MAX_TABLE_CELLS = 4000
MAX_BAND_LABEL_UTF16 = 64  # 공개 탐색 색인(64)과 자금표(120) 상한을 모두 만족한다
OCR_TEXT_MIN = 50  # extract_notice_pdf의 OCR 검토 기준과 같다(공백 제외 글자 수)
STATUSES = ('parser_unavailable', 'unreadable', 'encrypted', 'too_large', 'ocr_required', 'rejected', 'held',
            'unsupported_layout', 'checked')
TABLE_TRIGGERS = ('주택형', '동호', '동·호', '동라인', '동·라인', '동별라인', '동별/라인별', '동별(라인별)',
                  '품목', '대지비', '정정내용', '변경전', '정정전')
INCOMPLETE_SCANS = ('skipped_limit', 'failed', 'text_failed')
_CURRENT_ROUND_QUALIFIER = (
    r'(?:(?:주택|아파트|공고|단지)\s*의\s*)?'
    r'(?:(?:무순위\s*(?:\(\s*사후\s*\)\s*)?|불법행위\s*재공급\s*|계약취소(?:주택|세대)?\s*(?:재공급\s*)?|'
    r'재공급\s*|잔여세대\s*|임의공급\s*))?'
)
_DATE_WITH_WEEKDAY = (
    r'(\d{4})\s*(?:[.\-]|년)\s*(\d{1,2})\s*(?:[.\-]|월)\s*(\d{1,2})\s*(?:일|\.)?\s*'
    r'(?:\(\s*([월화수목금토일])\s*\))?'
)
# 현재 공고의 공고일만 지정하는 문장. '본 주택의 최초 입주자모집공고일은'처럼 다른 회차를 가리키는 문장은 맞지 않는다.
NOTICE_DATE = re.compile(
    r'본\s*' + _CURRENT_ROUND_QUALIFIER + r'입주자\s*모집\s*공고일\s*(?:은|는|:|：)\s*' + _DATE_WITH_WEEKDAY
)
# 줄·항목 시작의 '입주자모집공고일 : 2026. 11. 13.(목)' 형태. 앞에 '최초·당초·이전·종전·기존'이 있으면 제외한다.
NOTICE_DATE_LABEL = re.compile(
    r'(?:^|[■□◆◇▣•※\n])\s*(?:금회\s*|무순위\s*(?:\(\s*사후\s*\)\s*)?|불법행위\s*재공급\s*|재공급\s*|잔여세대\s*|임의공급\s*)?'
    r'입주자\s*모집\s*공고일\s*[:：]\s*' + _DATE_WITH_WEEKDAY,
    re.M,
)
# 청약 일정표의 현재 회차 모집공고일 머리말. '최초 입주자모집공고일' 같은 다른 회차 표기는 맞지 않는다.
SCHEDULE_HEADERS = (
    '입주자모집공고일', '모집공고일', '무순위(사후)입주자모집공고일', '무순위입주자모집공고일',
    '재공급입주자모집공고일', '불법행위재공급입주자모집공고일', '계약취소주택입주자모집공고일',
    '잔여세대입주자모집공고일', '임의공급입주자모집공고일',
)
SCHEDULE_DATE = re.compile(r'(\d{4})\s*[.\-]\s*(\d{1,2})\s*[.\-]\s*(\d{1,2})\.?\s*(?:\(\s*([월화수목금토일])\s*\))?')
# 두 자리 연도 일정값. 세기를 추정하지 않고 API 공고일(또는 원문의 유일한 전체 날짜)과 같을 때만 그 날짜로 본다.
SHORT_DATE = re.compile(r'(\d{2})\.(\d{1,2})\.(\d{1,2})\.?(?:\(([월화수목금토일])\))?')
SCHEDULE_TRIGGER = re.compile(r'(?:입주자)?모집공고일.{0,120}?(?:당첨자발표|청약접수|일반공급|특별공급|무순위)')
CONTRACT_SCHEDULE_TRIGGER = re.compile(r'당첨자발표.{0,80}?(?:계약체결|정당계약)')
CONTRACT_SCHEDULE_HEADERS = ('계약체결', '계약체결일', '정당계약', '정당계약일')
AWARD_SCHEDULE_HEADERS = ('당첨자발표', '당첨자발표일')
SCHEDULE_BELOW = 20  # 머리말 행만 표로 잡힌 일정표에서 값 행으로 보는 아래 거리(pt)
PAYMENT_STAGES = {'계약금': 'deposit', '중도금': 'interim', '잔금': 'balance'}
PAYMENT_HEADING = re.compile(r'\s*(계\s*약\s*금|중\s*도\s*금|잔\s*금)')
PAYMENT_HEADING_DETAIL = re.compile(r'^\s*(?:(?:제\s*)?\d+\s*(?:차|회)\s*|[(\[]?\s*\d+(?:\.\d+)?\s*%\s*[)\]]?\s*)+')
PAYMENT_CONTRACT = re.compile(r'^(?:정당)?계약(?:체결)?(?:시|일|기간|때)?')
PAYMENT_MOVE_IN = re.compile(r'^입주(?:지정기간(?:종료일)?|지정일|지정시|시|때)?')
PAYMENT_RELATIVE = re.compile(r'(?:로부터|부터|후|이후|전|이전)?(?:\d+(?:일|주|개월))?(?:내|이내|까지|후|이후|전|이전)?')
PAYMENT_RANGE = re.compile(r'[~～∼–—]|(?:(?<=[0-9.)])|(?<=\d일))부터.+까지|(?<=[0-9.)일])-(?=\d{4}[.-]\d{1,2}[.-])')
PAYMENT_SHORT_DATE = re.compile(r"[‘’']?" + SHORT_DATE.pattern)
KOREAN_DATE = re.compile(r'(\d{4})년(\d{1,2})월(\d{1,2})일(?:\(([월화수목금토일])\))?')
PAYMENT_SUBLABEL_STRIP = re.compile(r'(?:주택도시기금제외금액|주택도시기금|기금융자금|자납금액)$')
MAX_PAYMENT_TIMING_TEXT = 160  # 즉시 응답에는 머리말의 짧은 납부 문구만 남긴다.
SUMMARY_ROWS = ('합계', '계', '소계', '총계')
WEEKDAYS = '월화수목금토일'
# API 공고일의 전체 형식(구분자는 한 종류). 달력 검사는 _iso가 한다.
API_DATE = re.compile(r'(\d{4})-(\d{2})-(\d{2})|(\d{4})\.(\d{2})\.(\d{2})|(\d{4})(\d{2})(\d{2})')
PAGE_LABEL = re.compile(r'^\s*-\s*(\d{1,4})\s*-\s*$', re.M)
UNIT_NOTE = re.compile(r'단위\s*[:：]?\s*([^\]\)\n]*)')
PAREN = re.compile(r'[(\[]([^()\[\]]*)[)\]]')
NUMBER = re.compile(r'[0-9][0-9,]*(?:\.[0-9]+)?')
HOUSE_MANAGE_NO = re.compile(r'[0-9]{10}')
AMOUNT = re.compile(r'0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+')
DECIMAL = re.compile(r'[0-9]+(?:\.[0-9]+)?')
HOUSE_TYPE = re.compile(r'([0-9]+(?:\.[0-9]+)?)([A-Za-z가-힣]*)')
ROOM = re.compile(r'([0-9A-Za-z가-힣]+?)동([0-9]+)호')
ROOM_HYPHEN = re.compile(r'([0-9A-Za-z]+)-([0-9]+)')
FLOOR_SINGLE = re.compile(r'^(\d{1,3})층$')
FLOOR_RANGE = re.compile(r'^(\d{1,3})[~～∼\-–—](\d{1,3})층$')
FLOOR_ABOVE = re.compile(r'^(\d{1,3})층이상$')
FLOOR_BELOW = re.compile(r'^(\d{1,3})층이하$')
SYMBOLIC_FLOORS = ('기준층', '전층', '최상층', '옥탑', '복층', '펜트하우스', '저층', '중층', '고층')
BUILDING_LINE_SEGMENT = re.compile(
    r'([^,··∙/\s()\[\]동호]+(?:[,··∙/][^,··∙/\s()\[\]동호]+)*)동'
    r'(?:([0-9]+(?:(?:[,··∙/~～∼\-–—])[0-9]+)*)호(?:라인)?)?'
)
DASHES = ('-', '–', '—', '－')
MONEY_UNITS = {'원': 1, '천원': 1000, '만원': 10000}
AREA_UNITS = {'㎡': 'm2', 'm²': 'm2', 'm2': 'm2', '평': 'pyeong'}
# 옵션 표 바로 위·아래 문장에서만 찾는 승계(필수) 명시 문구와, 같은 근처에 있으면 적용을 단정하지 않는 부정·선택 문구.
REQUIRED_OPTION_PHRASES = (
    '선택및변경이불가', '선택이불가', '선택불가', '변경취소이불가', '변경취소가불가', '변경및취소가불가',
    '기존계약을승계', '기존옵션계약을승계', '기존계약조건을승계', '기존내용을승계', '승계하는조건',
    '유상옵션을승계', '추가선택품목을승계', '승계하여야하며', '발코니확장형으로만공급',
    '비확장을별도로신청할수없',
)
# 문서 전체에서 '선택 품목 명시' 적용을 막는 필수 승계·강제 확장 문구(계약 후 변경 불가·실별 선택 불가 같은 일반 안내 제외).
MANDATORY_SUCCESSION_PHRASES = (
    '기존계약을승계', '기존옵션계약을승계', '기존계약조건을승계', '기존내용을승계', '승계하는조건',
    '유상옵션을승계', '추가선택품목을승계', '승계하여야하며', '발코니확장형으로만공급',
    '비확장을별도로신청할수없', '선택및변경이불가하며기존', '별도로선택이불가하며기존',
    '유상옵션의변경취소이불가', '유상옵션의변경및취소가불가',
)
OPTION_NEGATIONS = ('승계하지', '승계되지', '승계대상이아', '않아도', '아님', '아닙니다', '선택가능', '선택이가능',
                    '선택할수있', '선택하실수있', '선택사항', '변경가능', '변경이가능')
OPTION_TOPICS = ('승계', '선택', '옵션', '품목', '확장', '변경')  # 옵션 적용과 관련된 부정 문장만 센다
# 신규분양·무순위에서 발코니 확장 및 추가선택품목이 계약자 선택 품목임을 명시하는 긍정 문구.
OPTIONAL_OPTION_TOPICS = ('발코니확장', '추가선택품목', '유상옵션', '선택품목')
OPTIONAL_OPTION_PHRASES = (
    '계약자가선택하여계약', '분양계약자가선택계약', '세대별로선택하여계약', '별도의계약을통해선택',
    '별도계약을통해선택', '선택하여계약하는사항', '선택하여계약하는별도계약품목', '선택계약하는사항',
    '선택하여계약할수있', '계약자의선택에따라', '계약자선택품목으로', '선택품목이며계약자가선택',
    '계약자가선택하여별도계약', '계약자가선택하는별도계약', '선택품목으로별도계약',
)
OPTION_TABLE_HEADINGS = ('발코니확장', '추가선택품목', '유상옵션', '시스템에어컨', '가전옵션', '플러스옵션')
# PDF 본문 정정 표지(A-59a). 공고문 일반 유의사항의 '정정공고할 수 있습니다' 같은 상투 문구는 제외한다.
IN_PDF_CORRECTION_TITLE = re.compile(
    r'(?:^|[■□◆◇▣\s\[(<【])'
    r'(?:정정\s*(?:입주자\s*)?모집\s*공고(?:문)?|입주자\s*모집\s*공고\s*[\(\[（]?\s*정정\s*[\)\]）]?|정정\s*공고(?:문)?)'
    r'(?!\s*(?:할\s*수|시|등|하|예정|되|가\s*있|를\s*통해))'
)
IN_PDF_CORRECTION_HEADING = re.compile(
    r'(?:^|[■□◆◇▣•※\n])\s*(?:\d+\s*[.)]\s*)?'
    r'(?:정정\s*(?:내용|사항|내역|사유)|공고\s*정정\s*(?:내용|사항|내역)|변경\s*내역)'
)
IN_PDF_FULL_REPLACEMENT = re.compile(
    r'(기존|당초|최초|종전|앞선|원)\s*(입주자\s*)?모집\s*공고(문)?\s*(의\s*)?(전부|전체|전문)\s*'
    r'(를|을)?\s*(본|이)\s*(정정\s*)?(공고|문서)(문)?\s*(으로|로)\s*대체(합니다|함|한다|됩니다|됨)'
)
IN_PDF_NOT_FULL = re.compile(r'않|아니|불가|미대체|제외|일부|부분|별도|단,')
CORRECTION_SCOPE_KEYWORDS = {
    'supply_area': ('공급면적', '전용면적', '주거공용', '계약면적', '주택공급면적'),
    'sale_price': ('공급금액', '분양가', '분양가격', '대지비', '건축비', '공급가격'),
    'required_options': ('발코니', '유상옵션', '추가선택품목', '선택품목', '확장비', '확장금액', '옵션금액'),
    'payment_schedule': ('납부일정', '납부기한', '계약금', '중도금', '잔금', '납부비율'),
}
CORRECTION_BEFORE_HEADERS = ('변경전', '정정전', '당초', '정정전내용', '변경전내용')
CORRECTION_AFTER_HEADERS = ('변경후', '정정후', '변경', '정정후내용', '변경후내용')
HEADING = re.compile(r'\s*[■□◆◇▣]')  # 절 제목 표시. 다른 절의 문구를 옵션 표에 묶지 않는다
SENTENCE_BREAK = re.compile(r'(?<=다\.)|[•Ÿ※■▪]')
NOTE_ABOVE, NOTE_BELOW = 80, 120  # 표와 같은 쪽에서 문구를 표에 묶는 거리(pt)


def _issue(document, code, **context):
    return dict(context, code=code, document=document['id'], version=document['version'])


# ---------------------------------------------------------------- PDF 읽기 (선택 의존성)

def _extract_hlines(page):
    """벡터 표의 가로 괘선(x0, x1, y)을 뽑아 좌·우 외곽선이 없는 병합 셀 경계를 복구한다."""
    hlines = []
    for drawing in page.get_drawings():
        rect = drawing.get('rect')
        if rect is not None and abs(rect.y1 - rect.y0) <= 2.5 and (rect.x1 - rect.x0) >= 10:
            hlines.append((float(rect.x0), float(rect.x1), float((rect.y0 + rect.y1) / 2)))
        for item in drawing.get('items', ()):
            if item[0] == 'l':
                p1, p2 = item[1], item[2]
                if abs(p1.y - p2.y) <= 1.5 and abs(p1.x - p2.x) >= 10:
                    hlines.append((float(min(p1.x, p2.x)), float(max(p1.x, p2.x)), float((p1.y + p2.y) / 2)))
    return hlines


def _read_pdf(raw):
    """(상태, 오류 코드, 쪽 목록, 추출기 정보). 파서 예외 문구는 원문 조각을 담을 수 있어 버린다."""
    try:
        import fitz
    except ImportError:
        return 'parser_unavailable', 'pdf_parser_unavailable', None, None
    extractor = {'name': 'PyMuPDF', 'version': fitz.VersionBind, 'ocrUsed': False}
    shown = fitz.TOOLS.mupdf_display_errors()
    fitz.TOOLS.mupdf_display_errors(False)
    try:
        try:
            document = fitz.open(stream=raw, filetype='pdf')
        except Exception:  # noqa: BLE001 - 손상·비PDF 입력은 상태로만 돌려준다
            return 'unreadable', 'pdf_open_failed', None, extractor
        with document:
            if document.needs_pass:
                return 'encrypted', 'pdf_encrypted', None, extractor
            if document.page_count < 1:
                return 'unreadable', 'pdf_without_pages', None, extractor
            if document.page_count > MAX_PAGES:
                return 'too_large', 'pdf_page_limit_exceeded', None, extractor
            pages = []
            for index in range(document.page_count):
                entry = {'page': index + 1, 'text': '', 'tables': [], 'blocks': [], 'words': [], 'hlines': [],
                         'tableScan': 'not_needed'}
                try:
                    entry['text'] = document[index].get_text(sort=True)
                except Exception:  # noqa: BLE001
                    entry['tableScan'] = 'text_failed'
                pages.append(entry)
            scanned = []

            def scan(number):
                entry = pages[number - 1]
                if entry['tableScan'] != 'not_needed':
                    return False
                if len(scanned) >= MAX_TABLE_PAGES:
                    entry['tableScan'] = 'skipped_limit'
                    return False
                scanned.append(number)
                try:
                    page = document[number - 1]
                    entry['tables'] = [table_record(number, i, table) for i, table in enumerate(page.find_tables().tables)]
                    entry['blocks'] = [tuple(block[:5]) for block in page.get_text('blocks') if block[6] == 0]
                    entry['words'] = [tuple(word[:5]) for word in page.get_text('words')]
                    entry['hlines'] = _extract_hlines(page)
                    entry['tableScan'] = 'scanned'
                except Exception:  # noqa: BLE001
                    entry['tables'], entry['blocks'], entry['words'], entry['hlines'], entry['tableScan'] = (
                        [], [], [], [], 'failed')
                return True

            for entry in pages:
                key = compact(entry['text'])
                if (any(word in key for word in TABLE_TRIGGERS) or SCHEDULE_TRIGGER.search(key)
                        or CONTRACT_SCHEDULE_TRIGGER.search(key)):
                    if scan(entry['page']):
                        # 쪽 끝의 가격·구간 가격·옵션 표는 다음 쪽에 머리말 없이 이어질 수 있어 바로 다음 쪽을 이어 스캔한다.
                        cur = entry['page']
                        while cur < len(pages):
                            cur_entry = pages[cur - 1]
                            tables = sorted(cur_entry['tables'], key=lambda t: t['bbox'][1])
                            if tables and _kind(tables[-1], cur_entry, tables) in ('price', 'band_price', 'options'):
                                if not scan(cur + 1):
                                    break
                                cur += 1
                            else:
                                break
            return 'read', None, pages, extractor
    finally:
        fitz.TOOLS.mupdf_display_errors(shown)


# ---------------------------------------------------------------- 표 구조

def _clean_header(text):
    return re.sub(r'[··∙•,/\-\s]', '', text or '')


def _words_in_box(words, x0, y0, x1, y1):
    hits = [w for w in words
            if x0 - 1.5 <= (w[0] + w[2]) / 2 <= x1 + 1.5 and y0 - 1.0 <= (w[1] + w[3]) / 2 <= y1 + 1.0]
    if not hits:
        return ''
    hits.sort(key=lambda w: (round(w[1] / 3.0), w[0]))
    return ' '.join(w[4] for w in hits)


def _table_overlaps(box, tables, current):
    x0, y0, x1, y1 = box
    for other in tables or ():
        if other is current:
            continue
        ox0, oy0, ox1, oy1 = other['bbox']
        if min(x1, ox1) - max(x0, ox0) > 2 and min(y1, oy1) - max(y0, oy0) > 2:
            return True
    return False


def _extended_outer_edges(table, words, hlines, other_tables):
    """좌·우 외곽 세로선이 생략돼 PyMuPDF가 바깥 한 열을 누락한 경우 가로 괘선으로 원래 외곽 x를 찾는다."""
    tx0, ty0, tx1, ty1 = table['bbox']
    top_lines = [h for h in hlines if abs(h[2] - ty0) <= 3.5 and h[1] >= tx0 - 2 and h[0] <= tx1 + 2]
    bot_lines = [h for h in hlines if abs(h[2] - ty1) <= 3.5 and h[1] >= tx0 - 2 and h[0] <= tx1 + 2]
    left_ext = right_ext = None
    if top_lines and bot_lines:
        top_min, bot_min = min(h[0] for h in top_lines), min(h[0] for h in bot_lines)
        cand_left = max(top_min, bot_min)
        if tx0 - cand_left >= 15 and abs(top_min - bot_min) <= 6:
            if (not _table_overlaps((cand_left, ty0, tx0, ty1), other_tables, table)
                    and _words_in_box(words, cand_left, ty0, tx0 - 1, ty1)):
                left_ext = cand_left
        top_max, bot_max = max(h[1] for h in top_lines), max(h[1] for h in bot_lines)
        cand_right = min(top_max, bot_max)
        if cand_right - tx1 >= 15 and abs(top_max - bot_max) <= 6:
            if (not _table_overlaps((tx1, ty0, cand_right, ty1), other_tables, table)
                    and _words_in_box(words, tx1 + 1, ty0, cand_right, ty1)):
                right_ext = cand_right
    return left_ext, right_ext


def _grid(table, words=None, hlines=None, other_tables=None):
    """병합으로 가려진 셀을 원래 셀로 풀고, 외곽 세로선 생략으로 빈 경계 셀은 가로 괘선·단어 좌표로 복구한다."""
    rows = [list(row) for row in table['rows']]
    boxes = [list(row) for row in table['cell_bboxes']]
    height = len(rows)
    width = max((len(row) for row in rows), default=0)
    if not height or not width or height * width > MAX_TABLE_CELLS:
        return None
    tx0, ty0, tx1, ty1 = table['bbox']
    left_ext = right_ext = None
    if words and hlines:
        left_ext, right_ext = _extended_outer_edges(table, words, hlines, other_tables)
        if left_ext is not None:
            for r in range(height):
                rows[r].insert(0, None)
                boxes[r].insert(0, None)
            width += 1
            tx0 = left_ext
        if right_ext is not None:
            for r in range(height):
                rows[r].append(None)
                boxes[r].append(None)
            width += 1
            tx1 = right_ext
    if height * width > MAX_TABLE_CELLS:
        return None

    def box(r, c):
        return boxes[r][c] if r < len(boxes) and c < len(boxes[r]) and boxes[r][c] else None

    col_x0 = [min((box(r, c)[0] for r in range(height) if box(r, c)), default=None) for c in range(width)]
    if left_ext is not None and col_x0[0] is None:
        col_x0[0] = left_ext
    if right_ext is not None and col_x0[-1] is None:
        col_x0[-1] = table['bbox'][2]
    row_y0 = [min((box(r, c)[1] for c in range(width) if box(r, c)), default=None) for r in range(height)]

    # 글자 일부가 왼쪽 외곽선을 몇 pt 넘겨 PyMuPDF가 얇은 중복 첫 열을 만든 경우(예: 4pt) 첫 두 열을 합친다.
    if (width >= 2 and col_x0[0] is not None and col_x0[1] is not None
            and col_x0[1] - col_x0[0] < 10
            and all(box(r, 0) is None for r in range(1, height))
            and rows[0][0] and rows[0][1] and compact(rows[0][1]) in compact(rows[0][0])):
        col_x0[1] = col_x0[0]
        del col_x0[0]
        for r in range(height):
            del rows[r][0]
            del boxes[r][0]
        width -= 1

    def span(edges, end, index):
        following = [edge for edge in edges[index + 1:] if edge is not None]
        return edges[index], following[0] if following else end

    def covering(r, c):
        if col_x0[c] is None or row_y0[r] is None:
            return None
        x0, x1 = span(col_x0, tx1, c)
        y0, y1 = span(row_y0, ty1, r)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        return next(((rr, cc) for rr in range(r, -1, -1) for cc in range(c, -1, -1)
                     if (rr, cc) != (r, c) and box(rr, cc)
                     and box(rr, cc)[0] <= cx <= box(rr, cc)[2] and box(rr, cc)[1] <= cy <= box(rr, cc)[3]), None)

    grid = []
    for r in range(height):
        line = []
        for c in range(width):
            origin = (r, c) if box(r, c) else covering(r, c)
            if origin is None:
                line.append(None)
                continue
            text = rows[origin[0]][origin[1]] if origin[1] < len(rows[origin[0]]) else None
            line.append({'text': text if isinstance(text, str) else '', 'origin': origin, 'bbox': box(*origin)})
        grid.append(line)

    # 외곽 세로선이 생략돼 None으로 남은 셀을 가로 괘선으로 나눈 실제 병합 구간과 단어 좌표로 채운다.
    if words and hlines:
        for c in range(width):
            if col_x0[c] is None or not any(grid[r][c] is None for r in range(height)):
                continue
            x0, x1 = span(col_x0, tx1, c)
            if x1 - x0 < 3:
                continue
            cx = (x0 + x1) / 2
            ys = [ty0, ty1]
            for hx0, hx1, hy in hlines:
                if hx0 - 2 <= cx <= hx1 + 2 and ty0 - 3 <= hy <= ty1 + 3:
                    ys.append(hy)
            ys.sort()
            dedup = []
            for y in ys:
                if not dedup or y - dedup[-1] > 1.5:
                    dedup.append(y)
            if len(dedup) < 2:
                continue
            bands = {}
            for r in range(height):
                if grid[r][c] is not None or row_y0[r] is None:
                    continue
                ry0, ry1 = span(row_y0, ty1, r)
                rcy = (ry0 + ry1) / 2
                band_idx = None
                for k in range(len(dedup) - 1):
                    if dedup[k] - 1.5 <= rcy <= dedup[k + 1] + 1.5:
                        band_idx = k
                        break
                if band_idx is not None:
                    bands.setdefault(band_idx, []).append(r)
            for band_idx, row_indices in bands.items():
                by0, by1 = dedup[band_idx], dedup[band_idx + 1]
                text = _words_in_box(words, x0, by0, x1, by1)
                origin = (row_indices[0], c)
                cell = {'text': text, 'origin': origin, 'bbox': [x0, by0, x1, by1]}
                for rr in row_indices:
                    grid[rr][c] = cell
    return grid


def _is_data_row(line):
    return any(cell and NUMBER.fullmatch(compact(cell['text'])) for cell in line)


def _header_cells(grid, count, column):
    seen = set()
    for row in grid[:count]:
        cell = row[column]
        if cell and cell['origin'] not in seen and compact(cell['text']):
            seen.add(cell['origin'])
            yield cell['text']


def _header(grid):
    """앞쪽의 숫자 없는 행(최대 6행)을 머리말로 보고 열마다 위에서 아래로 이름 조각을 모은다."""
    count = 0
    while count < len(grid) and count < 6 and not _is_data_row(grid[count]):
        count += 1
    if count == 0 or count == len(grid):
        return None, None
    labels = [tuple(map(compact, _header_cells(grid, count, column))) for column in range(len(grid[0]))]
    return count, labels


def _first(parts):
    return PAREN.sub('', parts[0])


def _last(parts):
    return PAREN.sub('', parts[-1])


def _raw_header(parts):
    return re.sub(r'[··∙•,/\-\s()\[\]]', '', ''.join(parts))


def _same_top_span(grid, matched):
    if not grid or not matched:
        return False
    if matched != list(range(min(matched), max(matched) + 1)):
        return False
    origins = {grid[0][c]['origin'] for c in matched if grid[0][c] is not None}
    return len(origins) == 1


def _columns(labels, rules, grid=None):
    """역할별 열 번호. 한 역할에 서로 다른 열이 여럿이면 표 해석이 모호하므로 그 역할을 _ambiguous에 남긴다.

    단, 첫 행에서 하나의 병합된 머리말 셀이 여러 하위 열을 덮는 경우(예: '층별'·'구분/품목')는 한 역할의 열 묶음으로 합친다.
    """
    found = {}
    for role, test in rules.items():
        matched = [c for c, parts in enumerate(labels) if parts and test(parts)]
        if role == 'item' and len(matched) > 1:
            non_spec = [c for c in matched if '규격' not in ''.join(labels[c])]
            if non_spec:
                matched = non_spec
        if role == 'payments':
            found[role] = matched
        elif len(matched) == 1:
            found[role] = matched[0]
        elif matched and role in ('floor', 'item', 'line') and _same_top_span(grid, matched):
            found[role] = matched[0]
            found[role + 'Cols'] = matched
        elif matched:
            found.setdefault('_ambiguous', []).append(role)
    return found


ROOM_NAMES_CLEAN = ('동호', '동호수')
LINE_NAMES_CLEAN = ('동호구분', '동별라인별', '동라인', '동호라인', '동별라인', '동라인별', '동별호별', '해당동라인', '동호별')
COMMON_RULES = {
    'label': lambda p: _first(p).startswith(('약식표기', '타입')),
    'houseType': lambda p: _first(p).startswith('주택형'),
}
SUPPLY_COUNT_NAMES = ('총공급세대수', '공급세대수', '잔여세대수', '금회공급세대수', '총세대수')
AREA_RULES = dict(COMMON_RULES, **{
    'model': lambda p: _first(p).startswith('모델'),
    'houseManageNo': lambda p: _first(p).startswith('주택관리번호'),
    'exclusive': lambda p: len(p) > 1 and _last(p) in ('주거전용면적', '주거전용', '전용면적'),
    'common': lambda p: len(p) > 1 and _last(p) in ('주거공용면적', '주거공용'),
    'supply': lambda p: ((len(p) > 1 and '공급면적' in p[0] and _last(p) in ('소계', '계', '합계'))
                         or (len(p) == 1 and _last(p).endswith('공급면적'))),
    'otherCommon': lambda p: _first(p).startswith('기타공용'),
    'contract': lambda p: _first(p).startswith('계약면적'),
    'supplyCount': lambda p: _first(p) in SUPPLY_COUNT_NAMES,
    'landlords': lambda p: _first(p).startswith(('토지등소유자', '임대세대')),
})
SUPPLY_TABLE_RULES = dict(COMMON_RULES, **{
    'model': lambda p: _first(p).startswith('모델'),
    'houseManageNo': lambda p: _first(p).startswith('주택관리번호'),
    'supplyCount': lambda p: _first(p) in SUPPLY_COUNT_NAMES or _first(p).startswith('일반공급세대수'),
    'landlords': lambda p: _first(p).startswith(('토지등소유자', '임대세대')),
})
PAYMENT_RULE = {'payments': lambda p: _first(p).startswith(tuple(PAYMENT_STAGES))}
ROOM_RULES = {
    'room': lambda p: _clean_header(_last(p)) in ROOM_NAMES_CLEAN,
    'dong': lambda p: _last(p) == '동',
    'ho': lambda p: _last(p) in ('호', '호수'),
    'item': lambda p: ('품목' in _first(p) or _last(p) in ('품목', '품목명')),
}
PRICE_RULES = dict(COMMON_RULES, **ROOM_RULES, **PAYMENT_RULE, **{
    'line': lambda p: _raw_header(p) in LINE_NAMES_CLEAN or _clean_header(_first(p)) in LINE_NAMES_CLEAN,
    'floor': lambda p: _first(p) in ('층', '층구분', '층별', '해당층', '층수') or _last(p) in ('층', '층구분', '층별'),
    'count': lambda p: _first(p) in SUPPLY_COUNT_NAMES,
    'bandCount': lambda p: _first(p) in ('해당세대수', '세대수'),
    'land': lambda p: _last(p) == '대지비',
    'building': lambda p: _last(p) == '건축비',
    'vat': lambda p: _last(p) in ('부가세', '부가가치세'),
    'extraCost': lambda p: _last(p) in ('재분양비',),
    'total': lambda p: ((len(p) > 1 and any(w in p[0] for w in ('분양가', '공급금액', '공급가격'))
                         and _last(p) in ('합계', '계', '소계', '총분양가', '분양가', '공급금액'))
                        or (len(p) == 1 and _last(p).endswith(('분양가', '공급금액', '공급가격')))),
})
OPTION_RULES = dict(COMMON_RULES, **ROOM_RULES, **PAYMENT_RULE, **{
    'amount': lambda p: (_last(p) in ('금액', '공급금액', '옵션금액', '확장금액', '발코니확장금액', '추가선택품목금액')
                         or _last(p).startswith('금액')),
    'subtotal': lambda p: _last(p) in ('합계금액', '총합계금액'),
    'charge': lambda p: re.sub(r'[·/,]', '', _first(p)) in ('유무상', '유상무상'),
})


def _is_option_heading(heading_text):
    key = compact(heading_text or '')
    return bool(key) and any(word in key for word in OPTION_TABLE_HEADINGS)


def _classify(labels, grid=None, *, option_heading=False):
    area, price, option, supply = (
        _columns(labels, rules, grid) for rules in (AREA_RULES, PRICE_RULES, OPTION_RULES, SUPPLY_TABLE_RULES)
    )
    if all(k in area for k in ('model', 'houseType', 'exclusive', 'common', 'supply')) and 'landlords' not in area:
        return 'area', area
    if ('room' in option or ('dong' in option and 'ho' in option)) and all(k in option for k in ('item', 'amount')):
        return 'options', option
    if not option_heading and ('room' in price or ('dong' in price and 'ho' in price)) and 'item' not in price and 'total' in price:
        return 'price', price
    if (not option_heading and 'floor' in price and 'total' in price and 'item' not in price
            and ('line' in price or 'bandCount' in price)
            and (price.get('payments') or 'land' in price)):
        return 'band_price', price
    is_option_catalog = (any('세부내용' in part for parts in labels for part in parts)
                         and 'land' not in price and 'floor' not in price)
    if (not option_heading and not is_option_catalog and 'total' in price and 'item' not in price
            and (price.get('payments') or 'land' in price)):
        return 'price_without_rooms', price  # 층·타입별 가격처럼 동·호 라인이나 세대수 교차 근거가 없는 표
    if 'model' in supply and 'houseType' in supply and 'landlords' not in supply:
        return 'supply', supply
    if ('amount' in option and any(
            any(w in part for w in ('발코니확장', '확장금액', '옵션금액')) for parts in labels for part in parts)):
        return 'non_room_options', option
    return None, None


def _table_heading(page, table, tables):
    """표 바로 위(직전 표 아래 ~ 현재 표 위)의 절 제목 또는 안내 문구."""
    if not page or not page.get('blocks'):
        return ''
    top = table['bbox'][1]
    floor, _ = _bounds(table, tables)
    blocks = [b for b in page['blocks'] if floor - 1 <= b[1] and b[3] <= top + 3 and top - b[3] <= NOTE_ABOVE]
    blocks.sort(key=lambda b: b[1])
    return ' '.join(b[4] for b in blocks[-3:])


def _kind(table, page=None, tables=None):
    grid = _grid(table, (page or {}).get('words'), (page or {}).get('hlines'), tables)
    header = _header(grid)[1] if grid else None
    if not header:
        return None
    opt_heading = _is_option_heading(_table_heading(page, table, tables or [table])) if page else False
    return _classify(header, grid, option_heading=opt_heading)[0]


def _schedule_values(grid, words, headers=SCHEDULE_HEADERS, *, alongside=()):
    """일정표에서 머리말 셀이 정확히 입주자모집공고일인 칸의 값: 같은 열 아래 셀, 표가 머리말 행에서 끝나면
    그 셀 바로 아래 같은 가로 범위의 글자, 첫 열 머리말이면 오른쪽 셀."""
    found = []
    for r, line in enumerate(grid or []):
        if alongside and not any(_text(cell) in alongside for cell in line):
            continue
        for c, cell in enumerate(line):
            if not cell or cell['origin'] != (r, c) or _text(cell) not in headers:
                continue
            below = [grid[rr][c] for rr in range(r + 1, len(grid))]
            value = next((_text(o) for o in below if o and o['origin'] != cell['origin'] and _text(o)), None)
            if value is None and r == len(grid) - 1 and cell['bbox']:
                x0, _, x1, y1 = cell['bbox']
                near = [w for w in words if y1 - 1 <= w[1] <= y1 + SCHEDULE_BELOW and x0 <= (w[0] + w[2]) / 2 <= x1]
                if near:
                    first = min(w[1] for w in near)
                    value = compact(''.join(w[4] for w in sorted(near, key=lambda w: w[0]) if w[1] <= first + 3))
            if value is None and c == 0:
                value = next((_text(o) for o in line[1:] if o and o['origin'] != cell['origin'] and _text(o)), None)
            if value:
                found.append(value)
    return found


def _schedule_dates(grid, words, page):
    dates = []
    for value in _schedule_values(grid, words):
        full, short = SCHEDULE_DATE.fullmatch(value), SHORT_DATE.fullmatch(value)
        if full:
            dates.append(_dated(full.groups(), page, 'schedule_table'))
        elif short:
            dates.append({'short': short.groups(), 'page': page, 'kind': 'schedule_table_two_digit_year'})
    return dates


def _contract_dates(grid, words, page):
    # 계약금 칸의 두 자리 연도는 같은 공고의 당첨자·계약체결 일정표에서 날짜 전체가 일치할 때만 푼다.
    values = _schedule_values(grid, words, CONTRACT_SCHEDULE_HEADERS, alongside=AWARD_SCHEDULE_HEADERS)
    return [value for text in values if (match := SCHEDULE_DATE.fullmatch(text) or KOREAN_DATE.fullmatch(text))
            and (value := _dated(match.groups(), page, 'contract_schedule_table'))]


def _units(labels, note):
    """머리말 괄호와 표 바로 위 단위 표기에서 금액·면적 단위를 모은다."""
    tokens = set()
    for parts in labels:
        for part in parts:
            for inner in PAREN.findall(part):
                tokens.update(t for t in re.split(r'[,/·:：\s]+', inner) if t)
    note_tokens = set()
    for inner in UNIT_NOTE.findall(note or ''):
        note_tokens.update(t for t in re.split(r'[,/·\s]+', inner) if t)
    if (note and '단위' in note and len(compact(note)) <= 32
            and not any(t in MONEY_UNITS or t in AREA_UNITS for t in note_tokens)):
        # 세로로 줄바꿈된 짧은 단위 표기(예: '단위\n세대\n원\n(\n:\n,\n)')에서 단위 토큰을 복구한다.
        note_tokens.update(t for t in re.split(r'[,/·:：\s()\[\]]+', note) if t)
    tokens.update(note_tokens)
    return ({MONEY_UNITS[t] for t in tokens if t in MONEY_UNITS}, {AREA_UNITS[t] for t in tokens if t in AREA_UNITS})


def _bounds(table, tables, page_height=None):
    """같은 쪽에서 표 바로 위 앞 표의 아래쪽과 바로 아래 다음 표의 위쪽."""
    top, bottom = table['bbox'][1], table['bbox'][3]
    above = [t['bbox'][3] for t in tables if t is not table and t['bbox'][3] <= top + 1]
    below = [t['bbox'][1] for t in tables if t is not table and t['bbox'][1] >= bottom - 1]
    return max(above, default=0), min(below, default=page_height or float('inf'))


def _unit_note(page, table, tables):
    top = table['bbox'][1]
    floor, _ = _bounds(table, tables)
    notes = [b for b in page['blocks'] if '단위' in b[4] and floor - 1 <= b[1] and b[3] <= top + 3
             and top - b[3] <= NOTE_ABOVE]
    return max(notes, key=lambda b: b[3])[4] if notes else None


def _near_blocks(page, table, tables):
    """표에 묶이는 문구 블록: 바로 위 절 제목(■ 등)부터 표까지, 표 아래부터 다음 절 제목·다음 표 전까지."""
    top, bottom = table['bbox'][1], table['bbox'][3]
    floor, ceiling = _bounds(table, tables)
    blocks = sorted(page['blocks'], key=lambda b: b[1])
    headings_above = [b[1] for b in blocks if HEADING.match(b[4]) and floor - 1 <= b[1] and b[3] <= top + 3]
    start = max(headings_above) if headings_above else max(floor - 1, top - NOTE_ABOVE)
    headings_below = [b[1] for b in blocks if HEADING.match(b[4]) and b[1] >= bottom - 3]
    end = min([ceiling, bottom + NOTE_BELOW] + headings_below)
    return [b[4] for b in blocks if (start <= b[1] and b[3] <= top + 3) or (bottom - 3 <= b[1] < end)]


def _option_scope(page, table, tables):
    """옵션 표에 묶인 문장만으로 승계(필수) 적용을 판정한다: required|ambiguous|unverified와 긍정·부정 문장 수."""
    positive = negative = 0
    for text in _near_blocks(page, table, tables):
        for sentence in SENTENCE_BREAK.split(text):
            key = compact(sentence)
            denies = any(word in key for word in OPTION_NEGATIONS)
            if any(phrase in key for phrase in REQUIRED_OPTION_PHRASES) and not denies:
                positive += 1
            elif denies and any(word in key for word in OPTION_TOPICS):
                negative += 1
    state = 'ambiguous' if positive and negative else 'required' if positive else 'unverified'
    return state, positive, negative


def _doc_option_policy(pages):
    """문서 전체에서 발코니 확장·추가선택품목의 선택 품목 명시와 필수 승계 문구를 구분해 찾는다."""
    mandatory_pages, optional_pages = set(), set()
    for page in pages:
        for sentence in SENTENCE_BREAK.split(page.get('text') or ''):
            key = compact(sentence)
            if not key:
                continue
            has_topic = any(topic in key for topic in OPTIONAL_OPTION_TOPICS)
            if not has_topic:
                continue
            denies = any(word in key for word in OPTION_NEGATIONS)
            if any(phrase in key for phrase in MANDATORY_SUCCESSION_PHRASES) and not denies:
                mandatory_pages.add(page['page'])
            if any(phrase in key for phrase in OPTIONAL_OPTION_PHRASES):
                optional_pages.add(page['page'])
    return sorted(mandatory_pages), sorted(optional_pages)


def _is_correction_table(grid):
    """변경 전/변경 후·정정 전/정정 후 표를 찾는다. 문자 중심 정정 표는 숫자 행이 없으므로 앞 1~2행을 직접 확인한다."""
    if not grid or len(grid) < 2:
        return False
    for head_rows in (1, 2):
        if head_rows >= len(grid):
            continue
        cleaned = [_clean_header(''.join(compact(c) for c in _header_cells(grid, head_rows, col)))
                   for col in range(len(grid[0]))]
        has_before = any(any(token in col for token in CORRECTION_BEFORE_HEADERS) for col in cleaned)
        has_after = any(any(token in col for token in CORRECTION_AFTER_HEADERS) for col in cleaned)
        if has_before and has_after:
            return True
    return False


def _detect_in_pdf_correction(pages, correction_tables):
    """PDF 본문의 정정 표지(표지 제목·정정 내용 절·변경 전/후 표)와 전량 대체 명시 여부를 판정한다(A-59a)."""
    markers, marker_pages, scope_texts, full_texts = [], set(), [], []
    for page in pages:
        pno = page['page']
        text = page.get('text') or ''
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        if pno <= 2:
            head_block = '\n'.join(lines[:25])
            if IN_PDF_CORRECTION_TITLE.search(head_block):
                markers.append({'kind': 'cover_title', 'page': pno})
                marker_pages.add(pno)
                full_texts.append(text)
        blocks = sorted(page.get('blocks') or [], key=lambda b: b[1])
        block_texts = [b[4] for b in blocks] if blocks else lines
        for idx, block in enumerate(block_texts):
            if IN_PDF_CORRECTION_HEADING.search(block):
                markers.append({'kind': 'section_heading', 'page': pno})
                marker_pages.add(pno)
                section = [block]
                for following in block_texts[idx + 1:]:
                    if HEADING.match(following) and not IN_PDF_CORRECTION_HEADING.search(following):
                        break
                    section.append(following)
                joined = '\n'.join(section)
                scope_texts.append(joined)
                full_texts.append(joined)
    for entry in correction_tables:
        pno = entry['page']['page']
        markers.append({'kind': 'before_after_table', 'page': pno, 'table': entry['table']['id']})
        marker_pages.add(pno)
        cell_text = ' '.join(cell['text'] for row in entry['grid'] for cell in row if cell and cell['text'])
        scope_texts.append(cell_text)
        full_texts.append(entry['page'].get('text') or '')

    if not markers:
        return {'detected': False, 'fullReplacementDeclared': False, 'affectedScopes': [], 'pages': [], 'markers': []}

    # 전량 대체는 짧은 긍정 문장으로 명시되고 부정·일부·제외 조건이 없을 때만 인정한다.
    full_declared = False
    for text in full_texts:
        for sentence in SENTENCE_BREAK.split(text):
            cleaned = ' '.join(sentence.split())
            if (cleaned and len(cleaned) <= 160 and IN_PDF_FULL_REPLACEMENT.search(cleaned)
                    and IN_PDF_NOT_FULL.search(cleaned) is None):
                full_declared = True
                break
        if full_declared:
            break

    affected = set()
    has_structured_scope = bool(scope_texts)
    if has_structured_scope:
        merged_scope = compact(' '.join(scope_texts))
        for scope, keywords in CORRECTION_SCOPE_KEYWORDS.items():
            if any(word in merged_scope for word in keywords):
                affected.add(scope)
        if not affected:
            # 변경 전/후 표나 정정 내용 절이 있으나 가격·면적·옵션·납부 외 항목(예: 청약 일정·자격)만 다룬 경우
            # 구체 항목이 전혀 확인되지 않으면 보수적으로 전체를 보류하고, 일정·자격 등 비가격 항목이 명시되면 other로 둔다.
            non_price_hints = ('청약일정', '접수일', '당첨자발표', '청약자격', '구비서류', '문의처', '견본주택', '특별공급', '가점', '예치금')
            if any(hint in merged_scope for hint in non_price_hints):
                affected.add('other')
            else:
                affected.add('all')
    else:
        # 표지 제목만 정정공고이고 정정 범위 표·절이 없으면 어느 항목이 바뀌었는지 증명할 수 없다.
        affected.add('all')

    return {
        'detected': True,
        'fullReplacementDeclared': full_declared,
        'affectedScopes': sorted(affected),
        'pages': sorted(marker_pages),
        'markers': markers,
    }


# ---------------------------------------------------------------- 값 해석

def _text(cell):
    return compact(cell['text']) if cell else ''


def _raw_text(cell):
    return ' '.join((cell['text'] or '').split()) if cell else ''


def _col_text(row, cols, role):
    """병합 머리말 아래 여러 하위 열로 나뉜 역할을 하나의 문자열로 합친다."""
    indices = cols.get(role + 'Cols') or ([cols[role]] if role in cols else [])
    seen, parts = set(), []
    for c in indices:
        cell = row[c] if c < len(row) else None
        if cell and cell['origin'] not in seen:
            seen.add(cell['origin'])
            txt = _text(cell)
            if txt:
                parts.append(txt)
    return ''.join(parts)


def _col_raw_text(row, cols, role):
    indices = cols.get(role + 'Cols') or ([cols[role]] if role in cols else [])
    seen, parts = set(), []
    for c in indices:
        cell = row[c] if c < len(row) else None
        if cell and cell['origin'] not in seen:
            seen.add(cell['origin'])
            txt = _raw_text(cell)
            if txt:
                parts.append(txt)
    return ' '.join(parts)


def _amount(cell):
    text = _text(cell)
    return int(text.replace(',', '')) if len(text) <= WON_LENGTH + 6 and AMOUNT.fullmatch(text) else None


def _decimal(cell):
    text = _text(cell)
    return Decimal(text) if len(text) <= AREA_LENGTH and DECIMAL.fullmatch(text) else None


def _blank(cell):
    return not _text(cell) or _text(cell) in DASHES


def _room(row, cols):
    if 'room' in cols:
        text = _text(row[cols['room']])
        match = ROOM.fullmatch(text)
        if match:
            return '%s동 %s호' % (match[1], match[2])
        hyphen = ROOM_HYPHEN.fullmatch(text)
        if hyphen:
            return '%s동 %s호' % (hyphen[1], hyphen[2])
        return None
    dong, ho = _text(row[cols['dong']]), _text(row[cols['ho']])
    dong, ho = (dong[:-1] if dong.endswith('동') else dong), (ho[:-1] if ho.endswith('호') else ho)
    match = ROOM.fullmatch(dong + '동' + ho + '호') if dong and ho else None
    return '%s동 %s호' % (match[1], match[2]) if match else None


def _room_unit(room, row=None, cols=None):
    match = ROOM.fullmatch(compact(room))
    buildings = [match[1] + '동'] if match else []
    floors = {'from': None, 'to': None}
    if row is not None and cols is not None and 'floor' in cols:
        parsed = _parse_floor_band(_col_text(row, cols, 'floor'))
        if parsed and parsed['from'] is not None:
            floors = {'from': parsed['from'], 'to': parsed['to']}
    return {'kind': 'room', 'buildings': buildings, 'lines': [], 'floors': floors, 'households': 1}


def _expand_line_spec(spec):
    lines = []
    for part in re.split(r'[,··∙/]+', spec):
        if not part:
            continue
        rng = re.fullmatch(r'(\d+)[~～∼\-–—](\d+)', part)
        if rng:
            a, b = int(rng[1]), int(rng[2])
            if a <= b and b - a <= 50:
                lines.extend(f'{n}호' for n in range(a, b + 1))
            else:
                return None
        elif part.isdigit():
            lines.append(f'{part}호')
        else:
            return None
    return lines


def _parse_building_lines(raw):
    """동·호 라인 셀을 (동 목록, 호 라인 목록, (동, 라인) 쌍 목록)으로 파싱한다. 해석 불가면 None."""
    text = compact(raw)
    if not text or text in DASHES:
        return None
    # '101동 1,2호 102동 3호', '101,102동 3호', '120동 2,3,4,5호' 등의 형식을 모두 읽는다.
    cleaned = re.sub(r'[()\[\]]', '', text)
    pos, buildings, lines, pairs = 0, [], [], []
    seen_b, seen_l, seen_p = set(), set(), set()
    for match in BUILDING_LINE_SEGMENT.finditer(cleaned):
        gap = cleaned[pos:match.start()]
        if gap and not re.fullmatch(r'[,··∙/&및]+', gap):
            return None
        pos = match.end()
        b_list = [f'{b}동' for b in re.split(r'[,··∙/]+', match[1]) if b]
        if not b_list:
            return None
        if match[2]:
            l_list = _expand_line_spec(match[2])
            if not l_list:
                return None
        else:
            l_list = [None]
        for b in b_list:
            if b not in seen_b:
                seen_b.add(b)
                buildings.append(b)
            for ln in l_list:
                if ln is not None and ln not in seen_l:
                    seen_l.add(ln)
                    lines.append(ln)
                pair = (b, ln)
                if pair not in seen_p:
                    seen_p.add(pair)
                    pairs.append(pair)
    tail = cleaned[pos:]
    if tail and not re.fullmatch(r'(?:전라인|전체|라인|[,··∙/])+', tail):
        return None
    if not pairs:
        return None
    return buildings, lines, pairs


def _parse_floor_band(text):
    """층 구간 문자열을 구조화한다. 숫자를 지어내지 않고 '기준층'·'6층 이상' 등은 열린 경계로 유지한다."""
    key = compact(text)
    if not key or key in DASHES:
        return None
    m = FLOOR_SINGLE.fullmatch(key)
    if m:
        n = int(m[1])
        if 1 <= n <= 300:
            return {'from': n, 'to': n, 'label': f'{n}층', 'interval': (n, n), 'symbolic': None}
        return None
    m = FLOOR_RANGE.fullmatch(key)
    if m:
        a, b = int(m[1]), int(m[2])
        if 1 <= a <= b <= 300:
            return {'from': a, 'to': b, 'label': f'{a}~{b}층', 'interval': (a, b), 'symbolic': None}
        return None
    m = FLOOR_ABOVE.fullmatch(key)
    if m:
        a = int(m[1])
        if 1 <= a <= 300:
            return {'from': a, 'to': None, 'label': f'{a}층 이상', 'interval': (a, None), 'symbolic': None}
        return None
    m = FLOOR_BELOW.fullmatch(key)
    if m:
        b = int(m[1])
        if 1 <= b <= 300:
            return {'from': None, 'to': b, 'label': f'{b}층 이하', 'interval': (None, b), 'symbolic': None}
        return None
    if key in SYMBOLIC_FLOORS:
        return {'from': None, 'to': None, 'label': key, 'interval': None, 'symbolic': key}
    return None


def _floors_overlap(first, second):
    if first['symbolic'] == '전층' or second['symbolic'] == '전층':
        return True
    if first['interval'] is not None and second['interval'] is not None:
        a1, b1 = first['interval']
        a2, b2 = second['interval']
        lo1, hi1 = (a1 if a1 is not None else 1), (b1 if b1 is not None else 10 ** 9)
        lo2, hi2 = (a2 if a2 is not None else 1), (b2 if b2 is not None else 10 ** 9)
        return max(lo1, lo2) <= min(hi1, hi2)
    if first['symbolic'] is not None and second['symbolic'] is not None:
        return first['symbolic'] == second['symbolic']
    return False


def _utf16_len(value):
    return len(value.encode('utf-16-le')) // 2


def _truncate_utf16(value, limit):
    if _utf16_len(value) <= limit:
        return value
    out = []
    used = 0
    for ch in value:
        w = len(ch.encode('utf-16-le')) // 2
        if used + w > limit:
            break
        out.append(ch)
        used += w
    return ''.join(out).rstrip()


def _band_display_name(buildings, lines, pairs, floor_label, type_label=None):
    """동·호 라인 × 층 구간의 결정적 표시 이름을 만든다. 호실 번호는 절대 추정하지 않는다."""
    if not pairs:
        base = f'{type_label} {floor_label}' if type_label else floor_label
        return _truncate_utf16(base.strip(), MAX_BAND_LABEL_UTF16)

    by_building = {}
    for b, ln in pairs:
        by_building.setdefault(b, [])
        if ln is not None and ln not in by_building[b]:
            by_building[b].append(ln)
    line_sets = {tuple(ls) for ls in by_building.values()}
    if len(line_sets) == 1:
        shared = next(iter(line_sets))
        b_part = '·'.join(buildings)
        if shared:
            candidate = f'{b_part} {"·".join(shared)} 라인 {floor_label}'
        else:
            candidate = f'{b_part} {floor_label}'
    else:
        parts = [f'{b} {"·".join(ls)}' if ls else b for b, ls in by_building.items()]
        candidate = f'{"·".join(parts)} 라인 {floor_label}'
    if _utf16_len(candidate) <= MAX_BAND_LABEL_UTF16:
        return candidate

    b_short = f'{buildings[0]} 외 {len(buildings) - 1}개동' if len(buildings) > 1 else buildings[0]
    if lines:
        l_short = '·'.join(lines[:3]) + (f' 외 {len(lines) - 3}' if len(lines) > 3 else '')
        candidate = f'{b_short} {l_short} 라인 {floor_label}'
        if _utf16_len(candidate) <= MAX_BAND_LABEL_UTF16:
            return candidate
    candidate = f'{b_short} {floor_label}'
    return _truncate_utf16(candidate, MAX_BAND_LABEL_UTF16)


def _same_model(pdf, api):
    return pdf == api or (pdf.isdigit() and api.isdigit() and int(pdf) == int(api))


def _house_type_match(pdf, api):
    """PDF 주택형과 API HOUSE_TY 원문의 대응. 근거 행에는 언제나 API 원문 문자열을 쓴다.

    API 값의 바깥 공백만 다르면 outer_whitespace, 숫자 앞자리 0 등 표기만 다르면 normalized다.
    내부 공백·접미 문자·숫자 값이 다르면 대응하지 않는다(유사값으로 바꾸지 않음).
    """
    if pdf == api:
        return 'exact'
    core = api.strip()
    if pdf == core:
        return 'outer_whitespace'
    a, b = HOUSE_TYPE.fullmatch(pdf), HOUSE_TYPE.fullmatch(core)
    if a and b and Decimal(a[1]) == Decimal(b[1]) and a[2] == b[2]:
        return 'normalized'
    return None


def _decimals(value):
    exponent = value.as_tuple().exponent
    return -exponent if exponent < 0 else 0


def _iso(year, month, day):
    try:
        return date(int(year), int(month), int(day)).isoformat()
    except ValueError:
        return None


def reported_notice_date(catalog):
    """카탈로그의 API 공고일(RCRIT_PBLANC_DE)이 보고됐고 전체 날짜 형식이며 실제 달력 날짜일 때만 ISO 문자열.

    YYYY-MM-DD, YYYY.MM.DD, YYYYMMDD 전체 일치만 받는다. 설명 문구가 섞이거나 일부만 있는 값은 None이다.
    """
    notice = catalog.get('notice') if isinstance(catalog, dict) else None
    field = ((notice.get('fields') if isinstance(notice, dict) else None) or {}).get('RCRIT_PBLANC_DE')
    if not (isinstance(field, dict) and field.get('status') == 'reported' and isinstance(field.get('value'), str)):
        return None
    match = API_DATE.fullmatch(field['value'])
    parts = [part for part in match.groups() if part is not None] if match else []
    return _iso(*parts) if len(parts) == 3 else None


def _catalog_types(catalog):
    types = []
    for housing in catalog.get('housingTypes') or []:
        if not (isinstance(housing, dict) and isinstance(housing.get('modelNo'), str)):
            continue
        house_type, top, supply = (housing.get(k) or {} for k in ('houseType', 'topAmount', 'supplyArea'))
        types.append({'modelNo': housing['modelNo'],
                      'houseType': house_type.get('value') if house_type.get('status') == 'reported' else None,
                      'topWon': int(top['won']) if top.get('status') == 'reported' and top.get('won') else None,
                      'apiSupply': supply.get('m2') if supply.get('status') == 'reported' else None})
    return types


# ---------------------------------------------------------------- 필드 점검

class _Field:
    """한 항목의 점검 기록. 실패한 점검이 하나라도 있으면 그 항목만 보류한다."""

    def __init__(self, item, page, table, row, **context):
        self.data = dict(context, item=item, page=page, table=table, row=row, cell=None, checks={}, reasons=[])
        self.value, self.raw, self.held = None, None, None  # held: None|'unverified'|'conflict'

    def check(self, name, result, reason, severity='conflict'):
        self.data['checks'][name] = result
        if result == 'fail':
            self.hold(reason, severity)

    def hold(self, reason, severity='unverified'):
        if reason not in self.data['reasons']:
            self.data['reasons'].append(reason)
        self.held = 'conflict' if 'conflict' in (self.held, severity) else 'unverified'

    @property
    def status(self):
        return self.held or ('confirmed' if self.value is not None else 'unverified')


def _area_fields(table, rows, cols, units, page, types, numbers, supply_counts):
    fields, labels = [], []
    seen_rows = set()
    table_counts = {}
    for index, row in rows:
        if 'houseManageNo' in cols and HOUSE_MANAGE_NO.fullmatch(_text(row[cols['houseManageNo']])):
            numbers.append({'houseManageNo': _text(row[cols['houseManageNo']]), 'page': page['page'],
                            'kind': 'supply_table'})
        model, house_type = _text(row[cols['model']]), _text(row[cols['houseType']])
        if not model or not house_type or model in SUMMARY_ROWS or house_type in SUMMARY_ROWS:
            continue
        api, unlinked = _model_link(model, types)
        if api is not None and 'supplyCount' in cols and row[cols['supplyCount']]:
            cnt = _amount(row[cols['supplyCount']])
            if cnt and cnt > 0:
                table_counts.setdefault(api['modelNo'], {})[row[cols['supplyCount']]['origin']] = cnt
        row_sig = (
            row[cols['model']]['origin'] if row[cols['model']] else (index, cols['model']),
            row[cols['houseType']]['origin'] if row[cols['houseType']] else (index, cols['houseType']),
            row[cols['supply']]['origin'] if row[cols['supply']] else (index, cols['supply']),
        )
        if row_sig in seen_rows:
            continue
        seen_rows.add(row_sig)
        field = _Field('supply_area', page['page'], table['id'], index,
                       modelNo=api['modelNo'] if api else model, houseType=house_type, room=None,
                       pdfHouseType=house_type)
        supply_cell = row[cols['supply']]
        field.raw, field.data['cell'] = _text(supply_cell) or None, supply_cell['bbox'] if supply_cell else None
        if api is None:
            field.hold(unlinked)
            fields.append(field)
            continue
        if api['houseType'] is None:
            field.hold('api_house_type_unverified')
            match = None
        else:
            match = _house_type_match(house_type, api['houseType'])
            field.check('api_house_type', ('pass' if match == 'exact' else 'normalized') if match else 'fail',
                        'house_type_mismatch')
        if match:
            field.data['houseType'] = api['houseType']
        # typeReason: 이 주택형에 연결된 가격·옵션 행도 같은 사유로 보류한다.
        labels.append({'label': _text(row[cols['label']]) if 'label' in cols else '', 'pdfHouseType': house_type,
                       'modelNo': api['modelNo'], 'houseType': field.data['houseType'],
                       'typeReason': None if match else field.data['reasons'][-1]})
        exclusive, common, supply = (_decimal(row[cols[k]]) for k in ('exclusive', 'common', 'supply'))
        field.check('unit', 'pass' if units[1] == {'m2'} else 'fail', 'area_unit_unverified', 'unverified')
        if None in (exclusive, common, supply) or not AREA.fullmatch(_text(supply_cell)):
            field.hold('area_cells_unreadable')
        else:
            field.check('supply_equals_exclusive_plus_common', 'pass' if exclusive + common == supply else 'fail',
                        'supply_area_sum_mismatch')
            prefix = HOUSE_TYPE.fullmatch(house_type)
            if prefix and _decimals(Decimal(prefix[1])) >= _decimals(exclusive):
                field.check('house_type_equals_exclusive', 'pass' if Decimal(prefix[1]) == exclusive else 'fail',
                            'house_type_area_mismatch')
            else:  # 반올림 규칙 없이 비교할 수 없는 표기다
                field.data['checks']['house_type_equals_exclusive'] = 'not_applicable'
            other = _decimal(row[cols['otherCommon']]) if 'otherCommon' in cols else None
            contract = _decimal(row[cols['contract']]) if 'contract' in cols else None
            if other is not None and contract is not None:
                field.check('contract_equals_supply_plus_other', 'pass' if supply + other == contract else 'fail',
                            'contract_area_sum_mismatch')
            field.value = _text(supply_cell)
            if api['apiSupply'] is not None:
                # 정보용. API SUPLY_AR와의 불일치 보류는 normalize_catalog가 판정한다.
                field.data['checks']['api_supply_area'] = 'pass' if Decimal(api['apiSupply']) == supply else 'fail'
        fields.append(field)
    for model_no, origins in table_counts.items():
        supply_counts.setdefault(model_no, set()).add(sum(origins.values()))
    return fields, labels


def _supply_fields(rows, cols, page, types, numbers, supply_counts):
    """면적 열이 없는 공급대상(잔여세대) 표에서 주택관리번호·약식표기 대응·공급세대수만 추출한다."""
    labels = []
    table_counts = {}
    for _, row in rows:
        if 'houseManageNo' in cols and HOUSE_MANAGE_NO.fullmatch(_text(row[cols['houseManageNo']])):
            numbers.append({'houseManageNo': _text(row[cols['houseManageNo']]), 'page': page['page'],
                            'kind': 'supply_table'})
        model, house_type = _text(row[cols['model']]), _text(row[cols['houseType']])
        if not model or not house_type or model in SUMMARY_ROWS or house_type in SUMMARY_ROWS:
            continue
        api, _ = _model_link(model, types)
        if api is None:
            continue
        match = _house_type_match(house_type, api['houseType']) if api['houseType'] else None
        if 'supplyCount' in cols and row[cols['supplyCount']]:
            cnt = _amount(row[cols['supplyCount']])
            if cnt and cnt > 0:
                table_counts.setdefault(api['modelNo'], {})[row[cols['supplyCount']]['origin']] = cnt
        labels.append({
            'label': _text(row[cols['label']]) if 'label' in cols else '',
            'pdfHouseType': house_type,
            'modelNo': api['modelNo'],
            'houseType': api['houseType'] if match else house_type,
            'typeReason': None if match else ('api_house_type_unverified' if api['houseType'] is None else 'house_type_mismatch'),
        })
    for model_no, origins in table_counts.items():
        supply_counts.setdefault(model_no, set()).add(sum(origins.values()))
    return labels


def _model_link(model, types):
    """PDF 모델 표기에 대응하는 API 주택형 하나. 원형이 유일하게 같으면 그것을, 아니면 숫자 정규화가 유일할 때만 쓴다.

    정규화(예: 001→01·1)로만 맞는 후보가 둘 이상이면 순서로 고르지 않고 연결을 보류한다.
    """
    exact = [t for t in types if t['modelNo'] == model]
    if len(exact) == 1:
        return exact[0], None
    candidates = exact or [t for t in types if _same_model(model, t['modelNo'])]
    if len(candidates) == 1:
        return candidates[0], None
    return None, 'pdf_model_ambiguous' if candidates else 'pdf_model_not_in_catalog'


def _heading_type(heading_text, labels, types):
    """표 제목·구역 제목에서 모호하지 않게 단일 주택형을 식별할 수 있을 때만 반환한다."""
    key = compact(heading_text or '')
    if not key:
        return None, None
    found = set()
    for item in labels:
        if item['pdfHouseType'] and item['pdfHouseType'] in key:
            found.add((item['modelNo'], item['houseType'], item['typeReason']))
        elif item['label'] and re.search(rf'(?<![0-9A-Za-z]){re.escape(item["label"])}(?:타입|형|㎡)?(?![0-9A-Za-z])', key):
            found.add((item['modelNo'], item['houseType'], item['typeReason']))
    for t in types:
        core = (t['houseType'] or '').strip()
        if core and core in key:
            found.add((t['modelNo'], t['houseType'], None))
    if len(found) == 1:
        return next(iter(found)), None
    if len(found) > 1:
        return None, 'room_type_ambiguous'
    return None, None


def _map_type(row, cols, labels, types, *, heading_text=None, fallback_mapped=None):
    """가격·옵션 행의 타입 표기를 공급대상 표의 약식표기 또는 주택형으로 API 주택형에 잇는다."""
    label_val = _text(row[cols['label']]) if 'label' in cols else ''
    type_val = _text(row[cols['houseType']]) if 'houseType' in cols else ''
    if label_val:
        found = {(x['modelNo'], x['houseType'], x['typeReason']) for x in labels if x['label'] == label_val}
    elif type_val:
        found = {(x['modelNo'], x['houseType'], x['typeReason']) for x in labels
                 if _house_type_match(type_val, x['pdfHouseType'])}
        found |= {(t['modelNo'], t['houseType'], None) for t in types
                  if t['houseType'] and _house_type_match(type_val, t['houseType'])}
    elif fallback_mapped is not None:
        return fallback_mapped, None
    else:
        # 주택형·약식표기 열이 아예 없거나 비어 있으면 표 제목·단일 주택형 공고에서 모호하지 않을 때만 잇는다.
        if 'label' not in cols and 'houseType' not in cols:
            if heading_text:
                hm, hreason = _heading_type(heading_text, labels, types)
                if hm is not None or hreason is not None:
                    return hm, hreason
            if len(types) == 1 and types[0]['houseType']:
                # 공급대상 표에 주택형 불일치 사유가 있으면 함께 전달한다.
                reason = next((x['typeReason'] for x in labels if x['modelNo'] == types[0]['modelNo'] and x['typeReason']), None)
                return (types[0]['modelNo'], types[0]['houseType'], reason), None
        return None, 'room_type_column_missing'
    if len(found) == 1:
        return next(iter(found)), None
    return None, 'room_type_ambiguous' if found else 'room_type_unmapped'


def _payments(row_list, cols, *, ignore_free_blanks=False):
    """납부 열의 서로 다른 원래 셀만 더한다. 하나라도 빈칸·대시·판독 불가면 합계 점검을 하지 않는다."""
    cells = {}
    for _, row in row_list:
        free = ignore_free_blanks and 'charge' in cols and _text(row[cols['charge']]) == '무상'
        for column in cols.get('payments', []):
            if row[column] and (not free or not _blank(row[column])):
                cells[row[column]['origin']] = row[column]
    values = [_amount(cell) for cell in cells.values()]
    if not values or None in values:
        return None
    return sum(values)


def _page_ref(document, page):
    return {'document': document['id'], 'version': document['version'], 'page': page}


def _unwrap(text):
    return text[1:-1] if text.startswith('(') and text.endswith(')') else text


def _payment_timing(text, page, document, contract_dates):
    """납부 열의 머리말에 붙은 일정만 사용한다. 날짜 범위·사건 기준은 원문 표현을 유지한다."""
    text = ' '.join(text.split())
    timing = {'trigger': None, 'date': None, 'text': None, 'dateStatus': 'missing', 'evidence': []}
    if not text or compact(text) in DASHES:
        return timing
    timing['dateStatus'] = 'unverified'
    if len(text) > MAX_PAYMENT_TIMING_TEXT or not text.isprintable():
        return timing
    timing['text'] = text
    key = compact(text)
    contract, move_in = PAYMENT_CONTRACT.match(key), PAYMENT_MOVE_IN.match(key)
    event = 'contract_signing' if contract else 'move_in' if move_in else None
    event_match = contract or move_in
    term = _unwrap(key[event_match.end():] if event_match else key)
    if event == 'move_in' and term:
        stripped = PAYMENT_SUBLABEL_STRIP.sub('', term)
        if not stripped:
            term = ''
    if PAYMENT_RANGE.search(term):
        return dict(timing, trigger=event, dateStatus='range')
    deadline = term.endswith(('까지', '이전'))
    if deadline and not PAYMENT_RELATIVE.fullmatch(term):
        term = _unwrap(term[:-2])
    full = SCHEDULE_DATE.fullmatch(term) or KOREAN_DATE.fullmatch(term)
    short = PAYMENT_SHORT_DATE.fullmatch(term) if event == 'contract_signing' else None
    dates = {entry['date'] for entry in contract_dates}
    pages = [page]
    if full:
        dated = _dated(full.groups(), page, 'payment_header')
    elif short and len(dates) == 1 and all(entry['weekday'] != 'mismatch' for entry in contract_dates):
        year, month, day, weekday = short.groups()
        reference = next(iter(dates))
        dated = _dated((reference[:4], month, day, weekday), page, 'payment_header')
        if year != reference[2:4] or dated is None or dated['date'] != reference:
            dated = None
        else:
            pages.extend(entry['page'] for entry in contract_dates)
    else:
        dated = None
    if dated and dated['weekday'] != 'mismatch':
        return dict(timing, trigger='deadline' if deadline else event or 'calendar_date', date=dated['date'],
                    dateStatus='exact', evidence=[_page_ref(document, n) for n in sorted(set(pages))])
    if event and (PAYMENT_RELATIVE.fullmatch(term) or term == '납부'):
        return dict(timing, trigger=event, dateStatus='relative')
    return dict(timing, trigger=event if full or short else None)


def _payment_columns(grid, count, columns, page, document, contract_dates):
    result = []
    for column in columns:
        cells = list(_header_cells(grid, count, column))
        if not cells:
            return []
        heading, *parts = cells
        stage = PAYMENT_HEADING.match(heading)
        if not stage:
            return []
        terms = PAYMENT_HEADING_DETAIL.sub('', ' '.join([heading[stage.end():], *parts]))
        result.append((PAYMENT_STAGES[compact(stage[1])], _payment_timing(terms, page, document, contract_dates)))
    return result


def _ambiguous_amount_cells(rows, cols, *, key_fn=None):
    """같은 원본 금액 셀이 여러 호실·구간이나 금액 열에 걸치면 적용 범위가 불명확하다."""
    total = cols['amount' if 'amount' in cols else 'total']
    placements = {}
    for index, row in rows:
        owner = key_fn(index, row) if key_fn else _room(row, cols)
        for column in [total, *cols['payments']]:
            cell = row[column]
            if cell:
                placements.setdefault(cell['origin'], set()).add((owner, column))
    return {origin for origin, owners in placements.items() if len(owners) > 1}


def _is_option_summary_row(row, cols):
    item_text = _col_text(row, cols, 'item')
    return item_text in SUMMARY_ROWS


def _installment_amounts(rows, cols, ambiguous):
    """같은 납부 셀 묶음이 적용되는 옵션·가격 행을 검산하고 단계별 원문 금액을 한 번씩 센다."""
    columns, groups, free_cells = cols['payments'], {}, []
    total_column = cols['amount' if 'amount' in cols else 'total']
    seen_totals = set()
    has_charge = 'charge' in cols
    is_option_table = 'item' in cols
    for _, row in rows:
        if is_option_table and _is_option_summary_row(row, cols):
            continue
        cells = [row[column] for column in columns]
        if has_charge and _text(row[cols['charge']]) == '무상':
            free_cells.extend(cell for cell in cells if not _blank(cell))
            continue
        total_cell = row[total_column]
        if is_option_table and not has_charge and _blank(total_cell) and all(_blank(c) for c in cells):
            continue
        amounts = [0 if (is_option_table and not has_charge and _blank(cell)) else _amount(cell) for cell in cells]
        total = _amount(total_cell)
        if not columns:
            return None, 'payment_evidence_missing'
        if total is None or None in amounts:
            return None, 'payment_amount_missing'
        total_origin = total_cell['origin']
        if total_origin in ambiguous or total_origin in seen_totals:
            return None, 'payment_scope_unverified'
        seen_totals.add(total_origin)
        origins = tuple(cell['origin'] for cell in cells)
        group = groups.setdefault(origins, {'total': 0, 'amounts': amounts})
        group['total'] += total
    # 병합된 계약금과 잔금의 적용 행이 서로 다르면 품목별 금액을 묶어 검산할 수 없다.
    seen = set()
    totals = [0] * len(columns)
    for origins, group in groups.items():
        if set(origins) & (seen | ambiguous):
            return None, 'payment_scope_unverified'
        seen.update(origins)
        if sum(group['amounts']) != group['total']:
            return None, 'payment_amount_mismatch'
        totals = [total + amount for total, amount in zip(totals, group['amounts'])]
    for cell in free_cells:
        if cell['origin'] not in seen:
            amount = _amount(cell)
            if amount != 0:
                return None, 'payment_amount_missing' if amount is None else 'payment_amount_mismatch'
    return totals, None


def _payment_schedule(field, document, *, timings=(), amounts=None, reasons=()):
    data = field.data
    schedule = {key: data[key] for key in ('modelNo', 'houseType', 'room', 'item')}
    evidence = [_page_ref(document, data['page'])] if data['page'] else []
    problems = list(dict.fromkeys([*reasons, *data['reasons']]))
    status = field.status
    if status == 'confirmed' and 'payment_amount_mismatch' in problems:
        status = 'conflict'
    if status == 'confirmed' and (amounts is None or problems):
        status = 'unverified'
    installments = [{'stage': stage, 'won': amount, 'timing': timing}
                    for (stage, timing), amount in zip(timings, amounts or ()) if amount != '0']
    if status == 'confirmed' and sum(int(i['won']) for i in installments) != int(field.value):
        status = 'conflict'
        problems.append('payment_amount_mismatch')
    if status != 'confirmed' and not problems:
        problems.append('payment_total_unverified')
    out = dict(schedule, status=status, totalWon=field.value if status == 'confirmed' else None,
               installments=installments if status == 'confirmed' else [], reasons=problems, evidence=evidence)
    if 'unit' in data and data['unit'] is not None:
        out['unit'] = data['unit']
    return out


def _payment_details(rows, entry, *reasons):
    totals, reason = _installment_amounts(rows, entry['cols'], entry['ambiguousAmountCells'])
    units = entry['units'][0]
    unit = next(iter(units)) if len(units) == 1 else None
    amounts = [str(amount * unit) for amount in totals] if totals is not None and unit is not None else None
    if not reason and entry['cols']['payments'] and not entry['paymentTimings']:
        reason = 'payment_evidence_missing'
    return {'amounts': amounts, 'timings': entry['paymentTimings'], 'reasons': reasons + ((reason,) if reason else ())}


def _component_sum(row, cols):
    """대지비 + 건축비 (+ 부가세/재분양비) 산술 합. 열이 있는데 읽을 수 없으면 (None, 'unreadable')을 돌려준다."""
    land = _amount(row[cols['land']]) if 'land' in cols else None
    building = _amount(row[cols['building']]) if 'building' in cols else None
    if land is None or building is None:
        return None, 'missing'
    total = land + building
    for extra_key in ('vat', 'extraCost'):
        if extra_key not in cols:
            continue
        cell = row[cols[extra_key]]
        if _blank(cell):
            continue
        val = _amount(cell)
        if val is None:
            return None, 'unreadable'
        total += val
    return total, 'ok'


def _price_fields(table, rows, cols, units, page, labels, types, document, *, heading_text=''):
    fields, issues, groups = [], [], {}
    multiplier = next(iter(units[0])) if len(units[0]) == 1 else None
    count_col = cols.get('count', cols.get('bandCount'))
    for index, row in rows:
        if any(_text(cell) in SUMMARY_ROWS for cell in row[:4]):
            continue
        room = _room(row, cols)
        if room is None:
            if any(_text(cell) for cell in row):
                issues.append(_issue(document, 'price_row_not_per_room', page=page['page'], table=table['id'], row=index))
            continue
        mapped, reason = _map_type(row, cols, labels, types, heading_text=heading_text)
        if mapped is None:
            issues.append(_issue(document, reason, page=page['page'], table=table['id'], row=index, room=room))
            continue
        field = _Field('sale_price', page['page'], table['id'], index, modelNo=mapped[0], houseType=mapped[1],
                       room=room, unit=_room_unit(room, row, cols))
        field.mapped = mapped
        if mapped[2]:
            field.hold(mapped[2], 'conflict' if mapped[2] == 'house_type_mismatch' else 'unverified')
        total_cell = row[cols['total']]
        field.raw, field.data['cell'] = _text(total_cell) or None, total_cell['bbox'] if total_cell else None
        total = _amount(total_cell)
        field.check('unit', 'pass' if multiplier else 'fail',
                    'amount_unit_ambiguous' if units[0] else 'amount_unit_unverified', 'unverified')
        if not total:
            field.hold('sale_price_unreadable')
        else:
            crosschecked = False
            comp_sum, comp_state = _component_sum(row, cols)
            if comp_state == 'ok':
                field.check('total_equals_land_plus_building', 'pass' if comp_sum == total else 'fail',
                            'sale_price_component_mismatch')
                crosschecked = comp_sum == total
            elif comp_state == 'unreadable':
                field.check('total_equals_land_plus_building', 'fail', 'sale_price_component_mismatch')
            paid = _payments([(index, row)], cols)
            if paid is not None:
                field.check('total_equals_payment_schedule', 'pass' if paid == total else 'fail',
                            'sale_price_payment_mismatch')
                crosschecked = crosschecked or paid == total
            if not crosschecked and not field.held:
                field.hold('sale_price_uncrosschecked')
            won = total * (multiplier or 1)
            top = next((t['topWon'] for t in types if t['modelNo'] == mapped[0]), None)
            if top is not None:
                # API 최고금액은 만원 단위다. 반올림 방식과 무관하게 넘을 수 없는 경우만 불일치로 본다.
                field.check('within_api_top_amount', 'pass' if won // 10000 <= top // 10000 else 'fail',
                            'sale_price_exceeds_api_top_amount')
            if len(str(won)) <= WON_LENGTH and WON.fullmatch(str(won)):
                field.value = str(won)
        group = groups.setdefault(mapped[:2], {'fields': [], 'counts': {}})
        group['fields'].append(field)
        if count_col is not None and row[count_col]:
            group['counts'][row[count_col]['origin']] = _amount(row[count_col])
        fields.append(field)
    for group in groups.values():
        counts = list(group['counts'].values())
        if not counts or None in counts:
            continue
        # 공급 세대수와 읽은 호실 행이 다르면 표가 잘렸거나 호실 연결이 어긋났을 수 있다.
        result = 'pass' if sum(counts) == len(group['fields']) else 'fail'
        for field in group['fields']:
            field.check('room_rows_equal_supply_count', result, 'room_count_mismatch', 'unverified')
    return fields, issues


def _band_price_fields(stitched_entries, labels, types, supply_counts, document):
    """동·호 라인 × 층 구간 가격표 묶음(여러 쪽 이어짐 포함)을 가격 단위로 읽고 교차 검산한다."""
    fields, issues, payment_map = [], [], {}
    model_groups = {}  # (modelNo, houseType) -> {'fields': [], 'type_counts': {}, 'bad_households': bool, 'bands': []}
    all_records = []  # (field, entry, row_index, row, pairs, floor_info, type_label)

    carry_mapped = None
    carry_type_label = None
    carry_line_raw = None
    carry_type_count = None

    for entry in stitched_entries:
        page, table, cols, units = entry['page'], entry['table'], entry['cols'], entry['units']
        multiplier = next(iter(units[0])) if len(units[0]) == 1 else None
        has_line = 'line' in cols
        has_band_count = 'bandCount' in cols
        # 해당세대수 열이 별도로 있으면 bandCount, 없으면(무순위·공공분양 구간표) count 열이 구간 세대수다.
        hh_col = cols['bandCount'] if has_band_count else cols.get('count')
        type_count_col = cols.get('count') if has_band_count else None
        heading_text = entry.get('headingText', '')

        for index, row in entry['rows']:
            if any(_text(cell) in SUMMARY_ROWS for cell in row[:4]):
                continue
            floor_text = _col_text(row, cols, 'floor')
            total_cell = row[cols['total']]
            if not floor_text and _blank(total_cell):
                continue

            row_label_val = _text(row[cols['label']]) if 'label' in cols else ''
            row_type_val = _text(row[cols['houseType']]) if 'houseType' in cols else ''
            explicit_type = bool(row_label_val or row_type_val)
            mapped, reason = _map_type(
                row, cols, labels, types,
                heading_text=heading_text,
                fallback_mapped=None if explicit_type else carry_mapped,
            )
            if mapped is None:
                issues.append(_issue(document, reason, page=page['page'], table=table['id'], row=index))
                carry_mapped = None
                carry_line_raw = None
                carry_type_count = None
                continue
            if explicit_type:
                if carry_mapped is None or mapped[:2] != carry_mapped[:2]:
                    carry_line_raw = None
                    carry_type_count = None
                carry_mapped = mapped
                carry_type_label = row_label_val or row_type_val
            type_label = row_label_val or row_type_val or carry_type_label or mapped[1].strip()

            if type_count_col is not None and row[type_count_col] and _text(row[type_count_col]):
                tc = _amount(row[type_count_col])
                carry_type_count = (page['page'], table['id'], row[type_count_col]['origin'], tc)

            if has_line:
                line_raw = _col_raw_text(row, cols, 'line')
                if line_raw and compact(line_raw) not in DASHES:
                    carry_line_raw = line_raw
                else:
                    line_raw = carry_line_raw
                parsed_loc = _parse_building_lines(line_raw) if line_raw else None
            else:
                parsed_loc = ([], [], [])

            floor_info = _parse_floor_band(floor_text)
            households = _amount(row[hh_col]) if hh_col is not None else None
            if households is not None and households <= 0:
                households = None

            buildings, lines, pairs = parsed_loc if parsed_loc is not None else ([], [], [])
            floor_label = floor_info['label'] if floor_info else (floor_text or f'행{index}')
            display_name = _band_display_name(buildings, lines, pairs, floor_label, type_label=type_label)
            unit = {
                'kind': 'band',
                'buildings': buildings,
                'lines': lines,
                'floors': {'from': floor_info['from'], 'to': floor_info['to']} if floor_info else {'from': None, 'to': None},
                'households': households if households is not None else 1,
            }
            field = _Field('sale_price', page['page'], table['id'], index,
                           modelNo=mapped[0], houseType=mapped[1], room=display_name, unit=unit)
            field.mapped = mapped
            if mapped[2]:
                field.hold(mapped[2], 'conflict' if mapped[2] == 'house_type_mismatch' else 'unverified')
            if has_line and parsed_loc is None:
                field.hold('band_location_unreadable')
            if floor_info is None:
                field.hold('band_floor_unreadable')
            if households is None:
                field.hold('band_households_unreadable')

            field.raw, field.data['cell'] = _text(total_cell) or None, total_cell['bbox'] if total_cell else None
            total = _amount(total_cell)
            field.check('unit', 'pass' if multiplier else 'fail',
                        'amount_unit_ambiguous' if units[0] else 'amount_unit_unverified', 'unverified')
            if not total:
                field.hold('sale_price_unreadable')
            else:
                crosschecked = False
                comp_sum, comp_state = _component_sum(row, cols)
                if comp_state == 'ok':
                    field.check('total_equals_land_plus_building', 'pass' if comp_sum == total else 'fail',
                                'sale_price_component_mismatch')
                    crosschecked = comp_sum == total
                elif comp_state == 'unreadable':
                    field.check('total_equals_land_plus_building', 'fail', 'sale_price_component_mismatch')
                paid = _payments([(index, row)], cols)
                if paid is not None:
                    field.check('total_equals_payment_schedule', 'pass' if paid == total else 'fail',
                                'sale_price_payment_mismatch')
                    crosschecked = crosschecked or paid == total
                if not crosschecked and not field.held:
                    field.hold('sale_price_uncrosschecked')
                won = total * (multiplier or 1)
                top = next((t['topWon'] for t in types if t['modelNo'] == mapped[0]), None)
                if top is not None:
                    field.check('within_api_top_amount', 'pass' if won // 10000 <= top // 10000 else 'fail',
                                'sale_price_exceeds_api_top_amount')
                if len(str(won)) <= WON_LENGTH and WON.fullmatch(str(won)):
                    field.value = str(won)

            group = model_groups.setdefault(mapped[:2], {
                'fields': [], 'sub_groups': {}, 'bad_households': False, 'bands': [],
            })
            group['fields'].append(field)
            if households is None:
                group['bad_households'] = True
            sub = group['sub_groups'].setdefault(type_label, {'fields': [], 'type_counts': {}, 'households': 0})
            sub['fields'].append(field)
            if households is not None:
                sub['households'] += households
            if carry_type_count is not None:
                tc_key = carry_type_count[:3]
                sub['type_counts'][tc_key] = carry_type_count[3]
            group['bands'].append((field, pairs, floor_info, households, has_line))
            all_records.append((field, entry, index, row, pairs, floor_info, type_label))
            fields.append(field)

    # 교차 검사 1: 주택형별(하위 타입 포함) 해당세대수 합 == 공급세대수 (가격표 공급세대수 및 공급대상 표 세대수 모두 확인)
    for (model_no, _), group in model_groups.items():
        sub_expected_total = 0
        sub_all_have_counts = True
        sub_any_failed = False
        for sub in group['sub_groups'].values():
            if not sub['type_counts']:
                sub_all_have_counts = False
                continue
            vals = list(sub['type_counts'].values())
            if None in vals:
                sub_any_failed = True
                for field in sub['fields']:
                    field.check('band_households_equal_supply_count', 'fail', 'band_household_count_mismatch', 'unverified')
                continue
            distinct_tc = set(vals)
            if len(distinct_tc) != 1:
                sub_any_failed = True
                for field in sub['fields']:
                    field.check('band_households_equal_supply_count', 'fail', 'band_household_count_mismatch', 'unverified')
                continue
            sub_expected = next(iter(distinct_tc))
            sub_expected_total += sub_expected
            if sub['households'] != sub_expected:
                sub_any_failed = True
                for field in sub['fields']:
                    field.check('band_households_equal_supply_count', 'fail', 'band_household_count_mismatch', 'unverified')

        expected_set = set()
        if sub_all_have_counts and group['sub_groups'] and not sub_any_failed:
            expected_set.add(sub_expected_total)
        if model_no in supply_counts:
            expected_set |= set(supply_counts[model_no])

        if group['bad_households'] or sub_any_failed:
            for field in group['fields']:
                field.check('band_households_equal_supply_count', 'fail', 'band_household_count_mismatch', 'unverified')
        elif len(expected_set) > 1:
            for field in group['fields']:
                field.check('band_households_equal_supply_count', 'fail', 'band_household_count_mismatch', 'unverified')
        elif len(expected_set) == 1:
            expected = next(iter(expected_set))
            actual = sum(hh for _, _, _, hh, _ in group['bands'])
            ok = actual == expected
            for field in group['fields']:
                field.check('band_households_equal_supply_count', 'pass' if ok else 'fail',
                            'band_household_count_mismatch', 'unverified')

        # 교차 검사 2: 같은 (동, 라인)의 층 구간 겹침 없음 (동·라인 열 없는 층 구간 표는 같은 주택형 내 층 겹침 검사)
        bands = group['bands']
        for i in range(len(bands)):
            f_i, pairs_i, fl_i, _, has_line_i = bands[i]
            if fl_i is None:
                continue
            set_i = set(pairs_i) if has_line_i else {('__all__', None)}
            for j in range(i + 1, len(bands)):
                f_j, pairs_j, fl_j, _, has_line_j = bands[j]
                if fl_j is None:
                    continue
                set_j = set(pairs_j) if has_line_j else {('__all__', None)}
                if (set_i & set_j) and _floors_overlap(fl_i, fl_j):
                    f_i.check('band_floor_no_overlap', 'fail', 'band_floor_overlap', 'conflict')
                    f_j.check('band_floor_no_overlap', 'fail', 'band_floor_overlap', 'conflict')

    # 표시 이름 유일성 보장: 긴 동 목록 축약이나 다른 주택형 간 우연한 이름 충돌만 결정적으로 구분한다.
    # (실제 층 겹침은 위에서 이미 band_floor_overlap으로 보류된다.)
    by_name = {}
    for rec in all_records:
        by_name.setdefault(rec[0].data['room'], []).append(rec)
    for name, recs in by_name.items():
        if len(recs) <= 1:
            continue
        models_here = {r[0].data['modelNo'] for r in recs}
        if len(models_here) > 1:
            for rec in recs:
                field, _, _, _, _, _, type_label = rec
                prefix = f'{type_label} '
                max_rest = MAX_BAND_LABEL_UTF16 - _utf16_len(prefix)
                field.data['room'] = prefix + _truncate_utf16(field.data['room'], max(1, max_rest))
        # 같은 모델 안에서 축약 이름이 겹친 경우(서로 다른 동·라인 묶음) 순서대로 구간 번호를 붙인다.
        still = {}
        for rec in recs:
            still.setdefault((rec[0].data['modelNo'], rec[0].data['room']), []).append(rec)
        for (_, current_name), same_model_recs in still.items():
            if len(same_model_recs) <= 1:
                continue
            for idx, rec in enumerate(same_model_recs, 1):
                suffix = f' (구간{idx})'
                max_base = MAX_BAND_LABEL_UTF16 - _utf16_len(suffix)
                rec[0].data['room'] = _truncate_utf16(current_name, max(1, max_base)) + suffix

    for field, entry, index, row, _, _, _ in all_records:
        payment_map[field] = _payment_details([(index, row)], entry)

    return fields, issues, payment_map


def _option_groups(table, rows, cols, page, labels, types, *, heading_text=''):
    """옵션 표를 호실별로 묶는다. 병합된 동·호/유·무상/납부 셀은 원래 셀로 풀린 상태다."""
    groups, unattributed = {}, False
    last_room = None
    for index, row in rows:
        room = _room(row, cols)
        if room is None:
            if _is_option_summary_row(row, cols) and last_room is not None:
                groups[last_room]['rows'].append((index, row))
                continue
            # 호실을 알 수 없는 행이 남으면 이 표의 어떤 호실 옵션도 완전하다고 볼 수 없다.
            unattributed = unattributed or any(_text(cell) for cell in row)
            continue
        last_room = room
        group = groups.setdefault(room, {'page': page['page'], 'table': table['id'], 'rows': [], 'types': set(),
                                         'typeReasons': set(), 'unit': _room_unit(room, row, cols)})
        group['rows'].append((index, row))
        if 'label' in cols or 'houseType' in cols:
            mapped, reason = _map_type(row, cols, labels, types, heading_text=heading_text)
            if mapped:
                group['types'].add(mapped)
            elif reason != 'room_type_column_missing':
                group['typeReasons'].add(reason)
    return groups, unattributed


def _option_field(room, mapped, group, *, unit=None):
    cols, units = group['cols'], group['units']
    index = group['rows'][0][0]
    field = _Field('required_options', group['page'], group['table'], index, modelNo=mapped[0], houseType=mapped[1],
                   room=room, unit=unit or group.get('unit') or _room_unit(room))
    first_amount = group['rows'][0][1][cols['amount']]
    field.data['cell'] = first_amount['bbox'] if first_amount else None
    for reason in sorted(group['tableReasons']):
        field.hold(reason)
    if mapped[2]:
        field.hold(mapped[2], 'conflict' if mapped[2] == 'house_type_mismatch' else 'unverified')
    multiplier = next(iter(units[0])) if len(units[0]) == 1 else None
    field.check('unit', 'pass' if multiplier else 'fail',
                'amount_unit_ambiguous' if units[0] else 'amount_unit_unverified', 'unverified')
    if {t[:2] for t in group['types']} - {mapped[:2]} or group['typeReasons']:
        field.check('option_room_type', 'fail', 'option_room_type_mismatch')
    elif group['types']:
        field.data['checks']['option_room_type'] = 'pass'
    field.data['checks']['required_statement'] = group['scope']
    if group['scope'] != 'required':
        field.hold('option_requirement_' + group['scope'])

    has_charge = 'charge' in cols
    paid_total, raws, partial, names = 0, [], False, []
    summary_amounts, col_subtotals = [], {}
    item_rows = []
    for row_idx, row in group['rows']:
        if _is_option_summary_row(row, cols):
            s_val = _amount(row[cols['amount']])
            if s_val is not None:
                summary_amounts.append(s_val)
            continue
        item_rows.append((row_idx, row))
        if 'subtotal' in cols and row[cols['subtotal']] and not _blank(row[cols['subtotal']]):
            col_subtotals[row[cols['subtotal']]['origin']] = _amount(row[cols['subtotal']])
        charge = _text(row[cols['charge']]) if has_charge else ''
        name = _col_text(row, cols, 'item')
        if name:
            names.append(name)
        amount_cell = row[cols['amount']]
        amount = _amount(amount_cell)
        if has_charge:
            if charge == '유상' and amount:
                paid_total += amount
                raws.append(_text(amount_cell))
            elif charge == '유상':
                partial = True
                field.hold('option_amount_missing')
            elif charge == '무상':
                if not (_blank(amount_cell) or amount == 0):
                    field.check('free_option_without_amount', 'fail', 'free_option_with_amount')
            else:
                partial = True
                field.hold('option_charge_unverified')
        else:
            # 유·무상 열이 없는 재공급 유상옵션 표: 금액이 명시된 품목만 더하고 합계/납부 교차 검산으로 확인한다.
            if amount is not None and amount > 0:
                paid_total += amount
                raws.append(_text(amount_cell))
            elif _blank(amount_cell) or amount == 0:
                pass
            else:
                partial = True
                field.hold('option_amount_missing')
    if len(names) != len(set(names)):
        field.hold('option_item_duplicated')  # 추출 중복인지 별개 품목인지 원문만으로 가리지 않는다
    field.raw = '+'.join(raws) if raws else (_text(first_amount) or None)

    if summary_amounts:
        if len(summary_amounts) == 1:
            field.check('options_equal_summary_row', 'pass' if summary_amounts[0] == paid_total else 'fail',
                        'option_payment_mismatch')
        else:
            field.hold('option_payment_mismatch', 'conflict')
    if col_subtotals:
        sub_vals = list(col_subtotals.values())
        if len(sub_vals) == 1 and sub_vals[0] is not None:
            field.check('options_equal_subtotal_column', 'pass' if sub_vals[0] == paid_total else 'fail',
                        'option_payment_mismatch')
        else:
            field.hold('option_payment_mismatch', 'conflict')

    paid = _payments(item_rows, cols, ignore_free_blanks=True)
    if partial:
        field.data['checks']['options_equal_payment_schedule'] = 'not_applicable'
    elif paid_total and paid is not None:
        field.check('options_equal_payment_schedule', 'pass' if paid == paid_total else 'fail', 'option_payment_mismatch')
    elif paid_total:
        field.hold('required_options_uncrosschecked')
    elif paid:
        field.check('options_equal_payment_schedule', 'fail', 'option_payment_mismatch')
    field.data['classification'] = 'partial' if partial else 'explicit' if paid_total else 'explicit_zero'
    won = paid_total * (multiplier or 1)
    if not partial and len(str(won)) <= WON_LENGTH:
        field.value = str(won)
    return field


# ---------------------------------------------------------------- 식별·쪽 표기

def _dated(parts, page, kind):
    """(연, 월, 일, 요일) 후보. 요일이 함께 적혀 있으면 실제 달력 요일과 같아야 한다."""
    value = _iso(*parts[:3])
    if value is None:
        return None
    weekday = parts[3] if len(parts) > 3 else None
    consistent = weekday is None or WEEKDAYS[date.fromisoformat(value).weekday()] == weekday
    return {'date': value, 'page': page, 'kind': kind, 'weekday': 'mismatch' if not consistent else weekday and 'matched'}


def _notice_date_labels(text, page):
    found = []
    source = text or ''
    for match in NOTICE_DATE_LABEL.finditer(source):
        before = source[max(0, match.start() - 16):match.start()]
        if PRIOR_ROUND_MARKER.search(before):
            continue
        dated = _dated(match.groups(), page, 'notice_date_label')
        if dated:
            found.append(dated)
    return found


def _identity(pages, numbers, schedule, target, catalog):
    sentences = [x for page in pages for x in find_identities(page['text'], page['page'])]
    standalone_numbers = [x for page in pages for x in find_notice_numbers(page['text'], page['page'])]
    found = [{'houseManageNo': x['house_manage_no'], 'page': x['page'], 'kind': 'notice_sentence'}
             for x in sentences] + standalone_numbers + numbers
    dates = [{'date': x['notice_date'], 'page': x['page'], 'kind': 'notice_sentence', 'weekday': None}
             for x in sentences] + [d for d in schedule if d and 'date' in d]
    for page in pages:
        dates.extend(d for d in (_dated(m.groups(), page['page'], 'notice_date_sentence')
                                 for m in NOTICE_DATE.finditer(page['text'])) if d)
        dates.extend(_notice_date_labels(page['text'], page['page']))
    api_date = reported_notice_date(catalog)
    full_dates = sorted({x['date'] for x in dates})
    reference = api_date or (full_dates[0] if len(full_dates) == 1 else None)
    unresolved = []
    for short in (d for d in schedule if d and 'short' in d):
        yy, month, day, weekday = short['short']
        if reference is None:
            unresolved.append(short)
            continue
        same = (reference[2:4], int(reference[5:7]), int(reference[8:10])) == (yy, int(month), int(day))
        resolved = _dated((reference[:4], reference[5:7], reference[8:10], weekday), short['page'], short['kind'])
        dates.append(resolved if same else {'date': '%s.%s.%s' % (yy, month, day), 'page': short['page'],
                                            'kind': short['kind'], 'weekday': None})
    numbers_found = sorted({x['houseManageNo'] for x in found})
    dates_found = sorted({x['date'] for x in dates})
    result = {'status': 'confirmed', 'reasons': [], 'houseManageNo': numbers_found, 'noticeDate': dates_found,
              'apiNoticeDate': api_date,
              'locations': [{'page': p, 'kind': k} for p, k in sorted({(x['page'], x['kind']) for x in found + dates})]}
    if any(d['weekday'] == 'mismatch' for d in dates):
        result.update(status='ambiguous', reasons=['pdf_notice_weekday_mismatch'])  # 원문 날짜·요일이 서로 맞지 않는다
    elif len(numbers_found) > 1 or len(dates_found) > 1:
        result.update(status='ambiguous', reasons=['pdf_identity_ambiguous'])  # 여러 회차가 섞였거나 식별이 모호하다
    elif numbers_found and numbers_found[0] != target['houseManageNo']:
        result.update(status='mismatch', reasons=['pdf_notice_mismatch'])
    elif dates_found and api_date and dates_found[0] != api_date:
        result.update(status='mismatch', reasons=['pdf_notice_date_mismatch'])
    else:
        missing_date = 'pdf_notice_date_two_digit_year' if unresolved else 'pdf_notice_date_not_found'
        reasons = ([] if numbers_found else ['pdf_notice_number_not_found']) + (
            [missing_date] if not dates_found else [] if api_date else ['api_notice_date_unverified'])
        if reasons:
            result.update(status='unverified', reasons=reasons)
    return result


def _page_labels(pages):
    labels = {}
    for page in pages:
        found = PAGE_LABEL.findall(page['text'])
        if found:
            labels[page['page']] = int(found[-1])
    offsets = {label - number for number, label in labels.items()}
    status = 'absent' if not labels else 'inconsistent' if len(offsets) > 1 else 'matched' if offsets == {0} else 'offset'
    return {'status': status, 'offset': next(iter(offsets)) if len(offsets) == 1 else None,
            'labeled': len(labels)}, labels


# ---------------------------------------------------------------- 조립

def _evidence_row(meta, field):
    data, status = field.data, field.status
    row = {'document': dict(meta), 'page': data['page'], 'modelNo': data['modelNo'], 'houseType': data['houseType'],
           'item': data['item'], 'check': status}
    if data['item'] == 'supply_area':
        row.update(basis='supply', unit='m2', m2=field.value if status == 'confirmed' else None)
    else:
        row.update(room=data['room'], won=field.value if status == 'confirmed' else None)
        if data.get('unit') is not None:
            row['unit'] = data['unit']
    if field.raw is not None:
        row['raw'] = field.raw
    return row


def _validate(target, catalog, document):
    if not (isinstance(target, dict) and all(isinstance(target.get(k), str) and target[k].strip()
                                             for k in ('houseManageNo', 'noticeNo', 'edition'))):
        raise ValueError('target needs houseManageNo, noticeNo and edition strings')
    if not (isinstance(catalog, dict) and catalog.get('target') == target):
        raise ValueError('catalog must be the normalize_catalog output for the same target')
    if not (isinstance(document, dict) and all(isinstance(document.get(k), str) and document[k].strip()
                                               for k in ('id', 'version'))
            and all(document.get(k) is None or isinstance(document.get(k), str) for k in DOCUMENT_KEYS + ('sha256',))):
        raise ValueError('document needs id and version strings and string-or-null metadata')


def _document_reasons(document, target, digest):
    claims = (document.get('houseManageNo'), document.get('noticeNo'), document.get('edition'))
    if document.get('source') not in DOCUMENT_SOURCES:
        return ['document_source_unverified']
    if None in claims:
        return ['document_identity_unverified']
    if claims[:2] != (target['houseManageNo'], target['noticeNo']):
        return ['document_notice_mismatch']
    if claims[2] != target['edition']:
        return ['different_notice_round']
    if digest and document.get('sha256') is not None and document['sha256'].lower() != digest:
        return ['document_hash_mismatch']
    return []


def _new_result(document, digest, size):
    return {'contract': CONTRACT, 'status': None, 'document': {'id': document['id'], 'version': document['version']},
            'source': {'sha256': digest, 'bytes': size, 'pageCount': None}, 'extractor': None, 'identity': None,
            'correction': None, 'pages': None, 'tables': None, 'fields': [], 'summary': None, 'evidence': [],
            'issues': [], 'paymentSchedules': []}


def _finish(result, document, status, *codes, **context):
    result['status'] = status
    result['issues'].extend(_issue(document, code, **context) for code in codes)
    fields = result['fields']
    result['summary'] = {'fields': len(fields), 'evidence': len(result['evidence']),
                         **{s: sum(1 for f in fields if f['status'] == s) for s in ('confirmed', 'unverified', 'conflict')},
                         'byItem': {item: {s: sum(1 for f in fields if f['item'] == item and f['status'] == s)
                                           for s in ('confirmed', 'unverified', 'conflict')}
                                    for item in ('supply_area', 'sale_price', 'required_options')}}
    return result


def inspect_notice_pdf(pdf_bytes, *, target, catalog, document):
    """공식·업로드 PDF 한 판본을 읽어 점검 결과와 BE-02 evidence 행, 보류 사유를 돌려준다."""
    _validate(target, catalog, document)
    if not isinstance(pdf_bytes, (bytes, bytearray, memoryview)):
        raise TypeError('pdf_bytes must be bytes')
    raw = bytes(pdf_bytes)
    digest = hashlib.sha256(raw).hexdigest()
    result = _new_result(document, digest, len(raw))
    reasons = _document_reasons(document, target, digest)
    if reasons:
        return _finish(result, document, 'rejected', *reasons)
    if not raw:
        return _finish(result, document, 'unreadable', 'pdf_empty')
    if len(raw) > MAX_PDF_BYTES:
        return _finish(result, document, 'too_large', 'pdf_byte_limit_exceeded')
    if b'%PDF-' not in raw[:1024]:
        return _finish(result, document, 'unreadable', 'pdf_signature_missing')
    state, code, pages, extractor = _read_pdf(raw)
    result['extractor'] = extractor
    if state != 'read':
        return _finish(result, document, state, code)
    return _inspect(pages, target, catalog, document, result)


def inspect_extracted_pages(pages, *, target, catalog, document):
    """PDF 파서 없이 이미 읽은 쪽 목록({page,text,tables,blocks,tableScan})을 같은 규칙으로 점검한다.

    tables는 extract_notice_pdf.table_record 형식, blocks는 (x0, y0, x1, y1, text) 목록이다. 바이트 해시는 없다.
    """
    _validate(target, catalog, document)
    result = _new_result(document, None, None)
    reasons = _document_reasons(document, target, None)
    if reasons:
        return _finish(result, document, 'rejected', *reasons)
    if not pages:
        return _finish(result, document, 'unreadable', 'pdf_without_pages')
    return _inspect(pages, target, catalog, document, result)


def _inspect(pages, target, catalog, document, result):
    meta = {key: document.get(key) for key in ('id', 'version') + DOCUMENT_KEYS}
    result['source']['pageCount'] = len(pages)
    textless = [p['page'] for p in pages if len(compact(p['text'])) < OCR_TEXT_MIN]
    label_summary, labels = _page_labels(pages)
    incomplete = [p['page'] for p in pages if p.get('tableScan') in INCOMPLETE_SCANS]
    result['pages'] = {'count': len(pages), 'ocrRequired': textless, 'labels': label_summary,
                       'tableScan': {state: [p['page'] for p in pages if p.get('tableScan') == state]
                                     for state in ('scanned',) + INCOMPLETE_SCANS}}
    if len(textless) == len(pages):
        return _finish(result, document, 'ocr_required', 'pdf_text_layer_missing')
    types, issues = _catalog_types(catalog), result['issues']
    recognized = {'area': [], 'price': [], 'band_price': [], 'options': [], 'supply': [], 'ignored': [], 'unsupported': []}
    parsed, ignored, schedule, contract_dates = [], {}, [], []
    headerless_candidates = {}  # page_num -> {position: {'page', 'table', 'tables', 'grid', 'width', 'last'}}
    correction_tables = []
    mandatory_non_room_options = False
    for page in pages:
        tables = sorted(page.get('tables') or [], key=lambda t: t['bbox'][1])
        words = page.get('words') or []
        hlines = page.get('hlines') or []
        for position, table in enumerate(tables):
            grid = _grid(table, words, hlines, tables)
            schedule.extend(_schedule_dates(grid, words, page['page']))
            contract_dates.extend(_contract_dates(grid, words, page['page']))
            if grid and _is_correction_table(grid):
                correction_tables.append({'page': page, 'table': table, 'grid': grid})
                recognized['ignored'].append(table['id'])
                continue
            count, header = _header(grid) if grid else (None, None)
            heading_text = _table_heading(page, table, tables)
            kind, cols = _classify(header, grid, option_heading=_is_option_heading(heading_text)) if header else (None, None)
            if kind == 'price_without_rooms':
                # 특정 호실이나 동·호 라인×층 구간 교차 근거가 없는 가격은 쓰지 않는다.
                recognized['unsupported'].append(table['id'])
                issues.append(_issue(document, 'price_rows_not_per_room', page=page['page'], table=table['id']))
                continue
            if kind == 'non_room_options':
                recognized['ignored'].append(table['id'])
                if _option_scope(page, table, tables)[0] == 'required':
                    mandatory_non_room_options = True
                continue
            if kind is None:
                recognized['ignored'].append(table['id'])
                width = len(grid[0]) if grid else 0
                ignored.setdefault(page['page'], []).append((position, width))
                if grid and count is None:
                    headerless_candidates.setdefault(page['page'], {})[position] = {
                        'page': page, 'table': table, 'tables': tables, 'grid': grid, 'width': width,
                        'last': position == len(tables) - 1,
                    }
                continue
            if cols.get('_ambiguous'):
                recognized['unsupported'].append(table['id'])
                issues.append(_issue(document, 'table_columns_ambiguous', page=page['page'], table=table['id'],
                                     roles=sorted(cols['_ambiguous'])))
                continue
            recognized[kind].append(table['id'])
            parsed.append({'kind': kind, 'page': page, 'table': table, 'tables': tables, 'cols': cols,
                           'width': len(grid[0]), 'rows': [(i, grid[i]) for i in range(count, len(grid))],
                           'grid': grid, 'headerCount': count, 'headingText': heading_text,
                           'units': _units(header, _unit_note(page, table, tables)), 'last': position == len(tables) - 1})

    correction = _detect_in_pdf_correction(pages, correction_tables)
    result['correction'] = correction
    if correction['detected'] and not correction['fullReplacementDeclared']:
        issues.append(_issue(document, 'in_pdf_correction_unverified',
                             scopes=correction['affectedScopes'], pages=correction['pages']))

    result['tables'] = recognized
    numbers, fields, label_map, supply_counts = [], [], [], {}
    for entry in parsed:
        if entry['kind'] == 'area':
            found, mapped = _area_fields(entry['table'], entry['rows'], entry['cols'], entry['units'], entry['page'],
                                         types, numbers, supply_counts)
            fields.extend(found)
            label_map.extend(mapped)
        elif entry['kind'] == 'supply':
            label_map.extend(_supply_fields(entry['rows'], entry['cols'], entry['page'], types, numbers, supply_counts))
    identity = _identity(pages, numbers, schedule, target, catalog)
    result['identity'] = identity
    if identity['status'] in ('ambiguous', 'mismatch'):
        return _finish(result, document, 'rejected', *identity['reasons'])
    if identity['status'] != 'confirmed':
        return _finish(result, document, 'held', *identity['reasons'])
    if not any(recognized[k] for k in ('area', 'price', 'band_price', 'options')):
        return _finish(result, document, 'unsupported_layout', 'pdf_tables_not_recognized')
    if incomplete:
        issues.append(_issue(document, 'table_scan_incomplete', pages=incomplete))

    # 동·호 라인 × 층 구간 가격표가 다음 쪽으로 이어지면(머리말 반복 또는 머리말 없는 동일 열 수) 단위를 이어 붙여 검산한다.
    band_chains = []
    consumed_headerless = set()
    for entry in parsed:
        if entry['kind'] != 'band_price':
            continue
        entry['paymentTimings'] = _payment_columns(entry['grid'], entry['headerCount'], entry['cols']['payments'],
                                                   entry['page']['page'], document, contract_dates)
        entry['ambiguousAmountCells'] = _ambiguous_amount_cells(
            entry['rows'], entry['cols'], key_fn=lambda idx, _row: idx)
        # 직전 체인의 마지막 표가 앞 쪽 끝이고 이번 표가 다음 쪽 첫 표이면 같은 구간 가격표의 연속이다.
        if (band_chains and band_chains[-1][-1]['last']
                and entry['page']['page'] == band_chains[-1][-1]['page']['page'] + 1
                and entry['tables'][0] is entry['table']):
            prev = band_chains[-1][-1]
            if not entry['units'][0] and prev['units'][0]:
                entry['units'] = (set(prev['units'][0]), entry['units'][1])
            band_chains[-1].append(entry)
        else:
            band_chains.append([entry])
        # 머리말 없이 다음 쪽 첫 표로 이어진 구간 가격표 조각(예: 마지막 몇 층 행)을 이어 붙인다.
        tail = band_chains[-1][-1]
        while tail['last']:
            next_p = tail['page']['page'] + 1
            cand = (headerless_candidates.get(next_p) or {}).get(0)
            if cand is None or cand['width'] != tail['width'] or (next_p, 0) in consumed_headerless:
                break
            consumed_headerless.add((next_p, 0))
            stitched = {
                'kind': 'band_price', 'page': cand['page'], 'table': cand['table'], 'tables': cand['tables'],
                'cols': tail['cols'], 'width': cand['width'],
                'rows': [(i, cand['grid'][i]) for i in range(len(cand['grid']))],
                'grid': cand['grid'], 'headerCount': 0, 'headingText': tail['headingText'],
                'units': tail['units'], 'last': cand['last'],
                'paymentTimings': tail['paymentTimings'],
                'ambiguousAmountCells': _ambiguous_amount_cells(
                    [(i, cand['grid'][i]) for i in range(len(cand['grid']))], tail['cols'], key_fn=lambda idx, _row: idx),
            }
            recognized['band_price'].append(cand['table']['id'])
            if cand['table']['id'] in recognized['ignored']:
                recognized['ignored'].remove(cand['table']['id'])
            band_chains[-1].append(stitched)
            tail = stitched

    option_groups, payments = {}, {}
    for chain in band_chains:
        found, found_issues, chain_payments = _band_price_fields(chain, label_map, types, supply_counts, document)
        fields.extend(found)
        issues.extend(found_issues)
        payments.update(chain_payments)

    for entry in parsed:
        if entry['kind'] in ('area', 'supply', 'band_price'):
            continue
        page, table = entry['page'], entry['table']
        entry['paymentTimings'] = _payment_columns(entry['grid'], entry['headerCount'], entry['cols']['payments'],
                                                   page['page'], document, contract_dates)
        entry['ambiguousAmountCells'] = _ambiguous_amount_cells(entry['rows'], entry['cols'])
        # 다음 쪽 첫 표가 머리말 없이 같은 열 수면 이 표가 이어진 것일 수 있다.
        continued = (entry['last'] and (0, entry['width']) in ignored.get(page['page'] + 1, [])
                     and (page['page'] + 1, 0) not in consumed_headerless)
        if entry['kind'] == 'price':
            found, found_issues = _price_fields(table, entry['rows'], entry['cols'], entry['units'], page, label_map,
                                                types, document, heading_text=entry.get('headingText', ''))
            fields.extend(found)
            issues.extend(found_issues)
            table_rows = dict(entry['rows'])
            payment_reasons = ('payment_scope_unverified',) if continued else ()
            for field in found:
                index = field.data['row']
                payments[field] = _payment_details([(index, table_rows[index])], entry, *payment_reasons)
            if continued:
                issues.append(_issue(document, 'price_table_continuation_unverified', page=page['page'], table=table['id']))
        elif entry['kind'] == 'options':
            groups, unattributed = _option_groups(table, entry['rows'], entry['cols'], page, label_map, types,
                                                  heading_text=entry.get('headingText', ''))
            scope = _option_scope(page, table, entry['tables'])
            table_reasons = {reason for reason, flag in (('option_rows_unattributed', unattributed),
                                                         ('option_table_continuation_unverified', continued),
                                                         ('table_scan_incomplete', bool(incomplete))) if flag}
            for room, group in groups.items():
                group.update(cols=entry['cols'], units=entry['units'], scope=scope[0], tableReasons=table_reasons,
                             paymentTable=entry)
                option_groups.setdefault(room, []).append(group)

    mandatory_pages, optional_pages = _doc_option_policy(pages)
    # 발코니 확장·추가선택품목이 계약자 선택 품목임이 명시되고, 필수 승계 문구·별도 필수 옵션표가 없을 때만 필수 옵션 0원이다.
    explicit_optional_page = (optional_pages[0]
                              if optional_pages and not mandatory_pages and not recognized['options']
                              and not mandatory_non_room_options else None)

    rooms = {}
    room_units = {}
    for field in fields:
        if field.data['item'] == 'sale_price':
            rooms.setdefault(field.data['room'], []).append(field.mapped)
            if field.data.get('unit') is not None:
                room_units[field.data['room']] = field.data['unit']
    for room in sorted(rooms):
        if len({m[:2] for m in rooms[room]}) != 1:
            continue  # 같은 호실이 여러 주택형에 연결되면 normalize_catalog가 room_model_conflict로 보류한다
        mapped = rooms[room][0][:2] + (next((m[2] for m in rooms[room] if m[2]), None),)
        unit = room_units.get(room)
        groups = option_groups.get(room, [])
        if len(groups) == 1:
            group = groups[0]
            field = _option_field(room, mapped, group, unit=unit)
            if mandatory_non_room_options:
                # 별도 필수 발코니 확장 표가 따로 있으면 중복·합산 범위를 임의로 추정하지 않고 보류한다.
                field.hold('option_room_in_multiple_tables')
            fields.append(field)
            payments[field] = _payment_details(group['rows'], group['paymentTable'])
            continue
        if groups:
            # 여러 옵션 표에 나온 호실은 완전성·중복을 확인하지 않고 합산하거나 한 표 값으로 확정하지 않는다.
            field = _Field('required_options', groups[0]['page'], groups[0]['table'], groups[0]['rows'][0][0],
                           modelNo=mapped[0], houseType=mapped[1], room=room, unit=unit)
            field.data['classification'] = 'partial'
            field.hold('option_room_in_multiple_tables')
            fields.append(field)
            continue
        if explicit_optional_page is not None:
            field = _Field('required_options', explicit_optional_page, None, None,
                           modelNo=mapped[0], houseType=mapped[1], room=room, unit=unit)
            if mapped[2]:
                field.hold(mapped[2], 'conflict' if mapped[2] == 'house_type_mismatch' else 'unverified')
            field.data['checks']['optional_statement'] = 'pass'
            field.data['classification'] = 'optional_only'
            field.value, field.raw = '0', '0'
            fields.append(field)
            payments[field] = {'amounts': [], 'timings': [], 'reasons': ()}
            continue
        # 옵션 근거가 없으면 0원이 아니라 미확인이다. 근거 쪽이 없으므로 evidence 행을 만들지 않는다.
        code = 'room_not_in_options_table' if recognized['options'] else 'options_table_not_found'
        missing = _Field('required_options', None, None, None, modelNo=mapped[0], houseType=mapped[1], room=room, unit=unit)
        missing.hold(code)
        result['fields'].append(dict(missing.data, pageLabel=None, classification='missing',
                                     status=missing.status, value=None, raw=None))
        result['paymentSchedules'].append(_payment_schedule(missing, document, reasons=['payment_evidence_missing']))
        issues.append(_issue(document, code, item='required_options', modelNo=mapped[0], room=room))
    for room in sorted(set(option_groups) - set(rooms)):
        issues.append(_issue(document, 'option_room_not_in_price_table', room=room))

    # 본문 정정 표지가 있고 전량 대체 문장이 없으면 정정 대상 항목과 의존 납부 일정만 보류하고 독립 항목은 유지한다(A-59a).
    hold_scopes = set(correction['affectedScopes']) if (correction['detected'] and not correction['fullReplacementDeclared']) else set()
    hold_all = label_summary['status'] == 'inconsistent'
    if hold_all:
        issues.append(_issue(document, 'page_labels_inconsistent'))
    linked = {(h['modelNo'], h['houseType']['value']) for h in catalog['housingTypes'] if h['status'] == 'linked'}
    origin = document.get('originCheck')
    trusted = origin == 'confirmed' or (origin is None and document.get('source') == 'official')
    for field in fields:
        if hold_all:
            field.hold('page_labels_inconsistent')
        item_name = field.data['item']
        if 'all' in hold_scopes or item_name in hold_scopes:
            field.hold('in_pdf_correction_unverified')
        entry = dict(field.data, pageLabel=labels.get(field.data['page']), status=field.status,
                     value=field.value if field.status == 'confirmed' else None, raw=field.raw)
        result['fields'].append(entry)
        for reason in field.data['reasons']:
            issues.append(_issue(document, reason, item=entry['item'], modelNo=entry['modelNo'], room=entry['room'],
                                 page=entry['page']))
        if not {'pdf_model_not_in_catalog', 'pdf_model_ambiguous'} & set(field.data['reasons']):
            result['evidence'].append(_evidence_row(meta, field))
        if entry['item'] in ('sale_price', 'required_options'):
            payment = payments.get(field, {'reasons': ('payment_evidence_missing',)})
            reasons = list(payment['reasons'])
            if 'all' in hold_scopes or 'payment_schedule' in hold_scopes or entry['item'] in hold_scopes:
                reasons.append('in_pdf_correction_unverified')
            if not trusted:
                reasons.append('payment_document_origin_unverified')
            if ((entry['modelNo'], entry['houseType']) not in linked
                    or len({m[:2] for m in rooms[entry['room']]}) != 1):
                reasons.append('payment_scope_unverified')
            result['paymentSchedules'].append(_payment_schedule(field, document, **dict(payment, reasons=reasons)))
    result['fields'].sort(key=lambda f: (f['item'], f['modelNo'], f['room'] or '', f['page'] or 0))
    result['paymentSchedules'].sort(key=lambda s: (s['modelNo'], s['room'], s['item']))
    return _finish(result, document, 'held' if hold_all else 'checked')


def main():
    parser = argparse.ArgumentParser(description='로컬 PDF 한 판본을 카탈로그와 대조해 점검 결과 JSON을 출력한다.')
    parser.add_argument('pdf', type=Path)
    parser.add_argument('--catalog', type=Path, required=True, help='normalize_catalog 출력 JSON')
    parser.add_argument('--document', type=Path, required=True, help='판본 메타데이터 JSON')
    args = parser.parse_args()
    try:
        catalog = json.loads(args.catalog.read_text(encoding='utf-8'))
        document = json.loads(args.document.read_text(encoding='utf-8'))
        result = inspect_notice_pdf(args.pdf.read_bytes(), target=catalog.get('target'), catalog=catalog,
                                    document=document)
    except (OSError, ValueError, TypeError, AttributeError):
        print('PDF 점검을 시작하지 못했습니다. 입력 파일과 카탈로그·판본 형식을 확인하세요.', file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
