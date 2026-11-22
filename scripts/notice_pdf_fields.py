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

from extract_notice_pdf import compact, find_identities, table_record
from ingestion_notices import AREA, AREA_LENGTH, DOCUMENT_KEYS, DOCUMENT_SOURCES, WON, WON_LENGTH

CONTRACT = 'notice-pdf-fields/v0'
MAX_PDF_BYTES = 50 * 1024 * 1024  # 공식 첨부 확보 상한과 같다
MAX_PAGES = 150  # 표 추출 전에 확인하는 전체 쪽 상한
MAX_TABLE_PAGES = 40  # 표를 추출하는 후보 쪽(머리말 단어가 있는 쪽과 그 다음 쪽) 상한
MAX_TABLE_CELLS = 4000
OCR_TEXT_MIN = 50  # extract_notice_pdf의 OCR 검토 기준과 같다(공백 제외 글자 수)
STATUSES = ('parser_unavailable', 'unreadable', 'encrypted', 'too_large', 'ocr_required', 'rejected', 'held',
            'unsupported_layout', 'checked')
TABLE_TRIGGERS = ('주택형', '동호', '동·호', '품목')
INCOMPLETE_SCANS = ('skipped_limit', 'failed', 'text_failed')
# 현재 공고의 공고일만 지정하는 문장. '본 주택의 최초 입주자모집공고일은'처럼 다른 회차를 가리키는 문장은 맞지 않는다.
NOTICE_DATE = re.compile(r'본\s*(?:불법행위\s*재공급\s*|재공급\s*|아파트의\s*|주택의\s*)?입주자\s*모집\s*공고일은\s*'
                         r'(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})\.?\s*(?:\(\s*([월화수목금토일])\s*\))?')
# 청약 일정표의 머리말이 정확히 '입주자모집공고일'인 열·행의 날짜 셀. '최초 입주자모집공고일' 같은 다른 회차 표기는 맞지 않는다.
SCHEDULE_HEADERS = ('입주자모집공고일', '모집공고일')
SCHEDULE_DATE = re.compile(r'(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})\.?(?:\(([월화수목금토일])\))?')
# 두 자리 연도 일정값. 세기를 추정하지 않고 API 공고일(또는 원문의 유일한 전체 날짜)과 같을 때만 그 날짜로 본다.
SHORT_DATE = re.compile(r'(\d{2})\.(\d{1,2})\.(\d{1,2})\.?(?:\(([월화수목금토일])\))?')
SCHEDULE_TRIGGER = re.compile(r'입주자모집공고일.{0,80}?당첨자발표')
CONTRACT_SCHEDULE_TRIGGER = re.compile(r'당첨자발표.{0,80}?(?:계약체결|정당계약)')
CONTRACT_SCHEDULE_HEADERS = ('계약체결', '계약체결일', '정당계약', '정당계약일')
AWARD_SCHEDULE_HEADERS = ('당첨자발표', '당첨자발표일')
SCHEDULE_BELOW = 20  # 머리말 행만 표로 잡힌 일정표에서 값 행으로 보는 아래 거리(pt)
PAYMENT_STAGES = {'계약금': 'deposit', '중도금': 'interim', '잔금': 'balance'}
PAYMENT_HEADING = re.compile(r'\s*(계\s*약\s*금|중\s*도\s*금|잔\s*금)')
PAYMENT_HEADING_DETAIL = re.compile(r'^\s*(?:(?:제\s*)?\d+\s*(?:차|회)\s*|[(\[]?\s*\d+(?:\.\d+)?\s*%\s*[)\]]?\s*)+')
PAYMENT_CONTRACT = re.compile(r'^(?:정당)?계약(?:체결)?(?:시|일|기간|때)?')
PAYMENT_MOVE_IN = re.compile(r'^입주(?:지정기간(?:종료일)?|지정일|시|때)?')
PAYMENT_RELATIVE = re.compile(r'(?:로부터|부터|후|이후|전|이전)?(?:\d+(?:일|주|개월))?(?:내|이내|까지|후|이후|전|이전)?')
PAYMENT_RANGE = re.compile(r'[~～∼–—]|(?:(?<=[0-9.)])|(?<=\d일))부터.+까지|(?<=[0-9.)일])-(?=\d{4}[.-]\d{1,2}[.-])')
PAYMENT_SHORT_DATE = re.compile(r"[‘’']?" + SHORT_DATE.pattern)
KOREAN_DATE = re.compile(r'(\d{4})년(\d{1,2})월(\d{1,2})일(?:\(([월화수목금토일])\))?')
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
DASHES = ('-', '–', '—', '－')
MONEY_UNITS = {'원': 1, '천원': 1000, '만원': 10000}
AREA_UNITS = {'㎡': 'm2', 'm²': 'm2', 'm2': 'm2', '평': 'pyeong'}
# 옵션 표 바로 위·아래 문장에서만 찾는 승계(선택·변경 불가) 명시 문구와, 같은 근처에 있으면 적용을 단정하지 않는 부정·선택 문구.
REQUIRED_OPTION_PHRASES = ('선택및변경이불가', '기존계약을승계', '기존내용을승계', '승계하는조건')
OPTION_NEGATIONS = ('승계하지', '승계되지', '승계대상이아', '않아도', '아님', '아닙니다', '선택가능', '선택이가능',
                    '선택할수있', '선택하실수있', '선택사항', '변경가능', '변경이가능')
OPTION_TOPICS = ('승계', '선택', '옵션', '품목', '확장', '변경')  # 옵션 적용과 관련된 부정 문장만 센다
HEADING = re.compile(r'\s*[■□◆◇▣]')  # 절 제목 표시. 다른 절의 문구를 옵션 표에 묶지 않는다
SENTENCE_BREAK = re.compile(r'(?<=다\.)|[•Ÿ※■▪]')
NOTE_ABOVE, NOTE_BELOW = 80, 120  # 표와 같은 쪽에서 문구를 표에 묶는 거리(pt)


def _issue(document, code, **context):
    return dict(context, code=code, document=document['id'], version=document['version'])


# ---------------------------------------------------------------- PDF 읽기 (선택 의존성)

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
                entry = {'page': index + 1, 'text': '', 'tables': [], 'blocks': [], 'tableScan': 'not_needed'}
                try:
                    entry['text'] = document[index].get_text(sort=True)
                except Exception:  # noqa: BLE001
                    entry['tableScan'] = 'text_failed'
                pages.append(entry)
            scanned = []

            def scan(number):
                entry = pages[number - 1]
                if entry['tableScan'] != 'not_needed':
                    return
                if len(scanned) >= MAX_TABLE_PAGES:
                    entry['tableScan'] = 'skipped_limit'
                    return
                scanned.append(number)
                try:
                    page = document[number - 1]
                    entry['tables'] = [table_record(number, i, table) for i, table in enumerate(page.find_tables().tables)]
                    entry['blocks'] = [tuple(block[:5]) for block in page.get_text('blocks') if block[6] == 0]
                    entry['words'] = [tuple(word[:5]) for word in page.get_text('words')]
                    entry['tableScan'] = 'scanned'
                except Exception:  # noqa: BLE001
                    entry['tables'], entry['blocks'], entry['tableScan'] = [], [], 'failed'

            for entry in pages:
                key = compact(entry['text'])
                if (any(word in key for word in TABLE_TRIGGERS) or SCHEDULE_TRIGGER.search(key)
                        or CONTRACT_SCHEDULE_TRIGGER.search(key)):
                    scan(entry['page'])
            # 쪽 끝의 가격·옵션 표는 다음 쪽에 머리말 없이 이어질 수 있어 그 다음 쪽까지 읽는다.
            for number in list(scanned):
                tables = sorted(pages[number - 1]['tables'], key=lambda t: t['bbox'][1])
                if number < len(pages) and tables and _kind(tables[-1]) in ('price', 'options'):
                    scan(number + 1)
            return 'read', None, pages, extractor
    finally:
        fitz.TOOLS.mupdf_display_errors(shown)


# ---------------------------------------------------------------- 표 구조

def _grid(table):
    """병합으로 가려진 셀을 그 셀을 덮는 원래 셀로 푼다. 원래 셀을 찾지 못하면 None으로 둔다."""
    rows, boxes = table['rows'], table['cell_bboxes']
    height = len(rows)
    width = max((len(row) for row in rows), default=0)
    if not height or not width or height * width > MAX_TABLE_CELLS:
        return None

    def box(r, c):
        return boxes[r][c] if r < len(boxes) and c < len(boxes[r]) and boxes[r][c] else None

    col_x0 = [min((box(r, c)[0] for r in range(height) if box(r, c)), default=None) for c in range(width)]
    row_y0 = [min((box(r, c)[1] for c in range(width) if box(r, c)), default=None) for r in range(height)]

    def span(edges, end, index):
        following = [edge for edge in edges[index + 1:] if edge is not None]
        return edges[index], following[0] if following else end

    def covering(r, c):
        if col_x0[c] is None or row_y0[r] is None:
            return None
        x0, x1 = span(col_x0, table['bbox'][2], c)
        y0, y1 = span(row_y0, table['bbox'][3], r)
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
    """앞쪽의 숫자 없는 행(최대 3행)을 머리말로 보고 열마다 위에서 아래로 이름 조각을 모은다."""
    count = 0
    while count < len(grid) and count < 3 and not _is_data_row(grid[count]):
        count += 1
    if count == 0 or count == len(grid):
        return None, None
    labels = [tuple(map(compact, _header_cells(grid, count, column))) for column in range(len(grid[0]))]
    return count, labels


def _first(parts):
    return PAREN.sub('', parts[0])


def _last(parts):
    return PAREN.sub('', parts[-1])


def _columns(labels, rules):
    """역할별 열 번호. 한 역할에 열이 여럿이면 표 해석이 모호하므로 그 역할을 _ambiguous에 남긴다."""
    found = {}
    for role, test in rules.items():
        matched = [c for c, parts in enumerate(labels) if parts and test(parts)]
        if role == 'payments':
            found[role] = matched
        elif len(matched) == 1:
            found[role] = matched[0]
        elif matched:
            found.setdefault('_ambiguous', []).append(role)
    return found


ROOM_NAMES = ('동호', '동·호', '동,호', '동/호', '동호수')
COMMON_RULES = {
    'label': lambda p: _first(p).startswith(('약식표기', '타입')),
    'houseType': lambda p: _first(p).startswith('주택형'),
}
AREA_RULES = dict(COMMON_RULES, **{
    'model': lambda p: _first(p).startswith('모델'),
    'houseManageNo': lambda p: _first(p).startswith('주택관리번호'),
    'exclusive': lambda p: len(p) > 1 and _last(p) in ('주거전용면적', '주거전용', '전용면적'),
    'common': lambda p: len(p) > 1 and _last(p) in ('주거공용면적', '주거공용'),
    'supply': lambda p: ((len(p) > 1 and '공급면적' in p[0] and _last(p) in ('소계', '계', '합계'))
                         or (len(p) == 1 and _last(p).endswith('공급면적'))),
    'otherCommon': lambda p: _first(p).startswith('기타공용'),
    'contract': lambda p: _first(p).startswith('계약면적'),
    'landlords': lambda p: _first(p).startswith(('토지등소유자', '임대세대')),
})
PAYMENT_RULE = {'payments': lambda p: _first(p).startswith(tuple(PAYMENT_STAGES))}
ROOM_RULES = {
    'room': lambda p: _last(p) in ROOM_NAMES,
    'dong': lambda p: _last(p) == '동',
    'ho': lambda p: _last(p) in ('호', '호수'),
    'item': lambda p: _first(p).startswith('품목'),
}
PRICE_RULES = dict(COMMON_RULES, **ROOM_RULES, **PAYMENT_RULE, **{
    'count': lambda p: _first(p).startswith('공급세대수'),
    'land': lambda p: _last(p) == '대지비',
    'building': lambda p: _last(p) == '건축비',
    'total': lambda p: ((len(p) > 1 and any(w in p[0] for w in ('분양가', '공급금액', '공급가격'))
                         and _last(p) in ('합계', '계', '소계'))
                        or (len(p) == 1 and _last(p).endswith(('분양가', '공급금액', '공급가격')))),
})
OPTION_RULES = dict(COMMON_RULES, **ROOM_RULES, **PAYMENT_RULE, **{
    'amount': lambda p: _last(p).startswith('금액'),
    'charge': lambda p: re.sub(r'[·/,]', '', _first(p)) in ('유무상', '유상무상'),
})


def _classify(labels):
    area, price, option = (_columns(labels, rules) for rules in (AREA_RULES, PRICE_RULES, OPTION_RULES))
    if all(k in area for k in ('model', 'houseType', 'exclusive', 'common', 'supply')) and 'landlords' not in area:
        return 'area', area
    if ('room' in price or ('dong' in price and 'ho' in price)) and 'item' not in price and 'total' in price:
        return 'price', price
    if ('room' in option or ('dong' in option and 'ho' in option)) and all(k in option for k in ('item', 'amount')):
        return 'options', option
    if 'total' in price and 'item' not in price and (price.get('payments') or 'land' in price):
        return 'price_without_rooms', price  # 층·타입별 가격처럼 특정 호실 근거가 없는 표
    return None, None


def _kind(table):
    grid = _grid(table)
    header = _header(grid)[1] if grid else None
    return _classify(header)[0] if header else None


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
    for inner in UNIT_NOTE.findall(note or ''):
        tokens.update(t for t in re.split(r'[,/·\s]+', inner) if t)
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


# ---------------------------------------------------------------- 값 해석

def _text(cell):
    return compact(cell['text']) if cell else ''


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
        match = ROOM.fullmatch(_text(row[cols['room']]))
    else:
        dong, ho = _text(row[cols['dong']]), _text(row[cols['ho']])
        dong, ho = (dong[:-1] if dong.endswith('동') else dong), (ho[:-1] if ho.endswith('호') else ho)
        match = ROOM.fullmatch(dong + '동' + ho + '호') if dong and ho else None
    return '%s동 %s호' % (match[1], match[2]) if match else None


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


def _area_fields(table, rows, cols, units, page, types, numbers):
    fields, labels = [], []
    for index, row in rows:
        if 'houseManageNo' in cols and HOUSE_MANAGE_NO.fullmatch(_text(row[cols['houseManageNo']])):
            numbers.append({'houseManageNo': _text(row[cols['houseManageNo']]), 'page': page['page'],
                            'kind': 'supply_table'})
        model, house_type = _text(row[cols['model']]), _text(row[cols['houseType']])
        if not model or not house_type or model in SUMMARY_ROWS or house_type in SUMMARY_ROWS:
            continue
        api, unlinked = _model_link(model, types)
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
    return fields, labels


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


def _map_type(row, cols, labels, types):
    """가격·옵션 행의 타입 표기를 공급대상 표의 약식표기 또는 주택형으로 API 주택형에 잇는다."""
    if 'label' in cols and _text(row[cols['label']]):
        text = _text(row[cols['label']])
        found = {(x['modelNo'], x['houseType'], x['typeReason']) for x in labels if x['label'] == text}
    elif 'houseType' in cols and _text(row[cols['houseType']]):
        text = _text(row[cols['houseType']])
        found = {(x['modelNo'], x['houseType'], x['typeReason']) for x in labels
                 if _house_type_match(text, x['pdfHouseType'])}
        found |= {(t['modelNo'], t['houseType'], None) for t in types
                  if t['houseType'] and _house_type_match(text, t['houseType'])}
    else:
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
        heading, *parts = _header_cells(grid, count, column)
        stage = PAYMENT_HEADING.match(heading)
        if not stage:
            return []
        terms = PAYMENT_HEADING_DETAIL.sub('', ' '.join([heading[stage.end():], *parts]))
        result.append((PAYMENT_STAGES[compact(stage[1])], _payment_timing(terms, page, document, contract_dates)))
    return result


def _ambiguous_amount_cells(rows, cols):
    """같은 원본 금액 셀이 여러 호실이나 금액 열에 걸치면 적용 범위가 불명확하다."""
    total = cols['amount' if 'amount' in cols else 'total']
    placements = {}
    for _, row in rows:
        room = _room(row, cols)
        for column in [total, *cols['payments']]:
            cell = row[column]
            if cell:
                placements.setdefault(cell['origin'], set()).add((room, column))
    return {origin for origin, owners in placements.items() if len(owners) > 1}


def _installment_amounts(rows, cols, ambiguous):
    """같은 납부 셀 묶음이 적용되는 옵션 행을 검산하고 단계별 원문 금액을 한 번씩 센다."""
    columns, groups, free_cells = cols['payments'], {}, []
    total_column = cols['amount' if 'amount' in cols else 'total']
    seen_totals = set()
    for _, row in rows:
        cells = [row[column] for column in columns]
        if 'charge' in cols and _text(row[cols['charge']]) == '무상':
            free_cells.extend(cell for cell in cells if not _blank(cell))
            continue
        amounts = [_amount(cell) for cell in cells]
        total_cell = row[total_column]
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
    return dict(schedule, status=status, totalWon=field.value if status == 'confirmed' else None,
                installments=installments if status == 'confirmed' else [], reasons=problems, evidence=evidence)


def _payment_details(rows, entry, *reasons):
    totals, reason = _installment_amounts(rows, entry['cols'], entry['ambiguousAmountCells'])
    units = entry['units'][0]
    unit = next(iter(units)) if len(units) == 1 else None
    amounts = [str(amount * unit) for amount in totals] if totals is not None and unit is not None else None
    if not reason and entry['cols']['payments'] and not entry['paymentTimings']:
        reason = 'payment_evidence_missing'
    return {'amounts': amounts, 'timings': entry['paymentTimings'], 'reasons': reasons + ((reason,) if reason else ())}


def _price_fields(table, rows, cols, units, page, labels, types, document):
    fields, issues, groups = [], [], {}
    multiplier = next(iter(units[0])) if len(units[0]) == 1 else None
    for index, row in rows:
        room = _room(row, cols)
        if room is None:
            if any(_text(cell) for cell in row):
                issues.append(_issue(document, 'price_row_not_per_room', page=page['page'], table=table['id'], row=index))
            continue
        mapped, reason = _map_type(row, cols, labels, types)
        if mapped is None:
            issues.append(_issue(document, reason, page=page['page'], table=table['id'], row=index, room=room))
            continue
        field = _Field('sale_price', page['page'], table['id'], index, modelNo=mapped[0], houseType=mapped[1], room=room)
        field.mapped = mapped
        if mapped[2]:
            field.hold(mapped[2], 'conflict' if mapped[2] == 'house_type_mismatch' else 'unverified')
        total_cell = row[cols['total']]
        field.raw, field.data['cell'] = _text(total_cell) or None, total_cell['bbox'] if total_cell else None
        total, land, building = (_amount(row[cols[k]]) if k in cols else None for k in ('total', 'land', 'building'))
        field.check('unit', 'pass' if multiplier else 'fail',
                    'amount_unit_ambiguous' if units[0] else 'amount_unit_unverified', 'unverified')
        if not total:
            field.hold('sale_price_unreadable')
        else:
            crosschecked = False
            if land is not None and building is not None:
                field.check('total_equals_land_plus_building', 'pass' if land + building == total else 'fail',
                            'sale_price_component_mismatch')
                crosschecked = land + building == total
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
        if 'count' in cols and row[cols['count']]:
            group['counts'][row[cols['count']]['origin']] = _amount(row[cols['count']])
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


def _option_groups(table, rows, cols, page, labels, types):
    """옵션 표를 호실별로 묶는다. 병합된 동·호/유·무상/납부 셀은 원래 셀로 풀린 상태다."""
    groups, unattributed = {}, False
    for index, row in rows:
        room = _room(row, cols)
        if room is None:
            # 호실을 알 수 없는 행이 남으면 이 표의 어떤 호실 옵션도 완전하다고 볼 수 없다.
            unattributed = unattributed or any(_text(cell) for cell in row)
            continue
        group = groups.setdefault(room, {'page': page['page'], 'table': table['id'], 'rows': [], 'types': set(),
                                         'typeReasons': set()})
        group['rows'].append((index, row))
        if 'label' in cols or 'houseType' in cols:
            mapped, reason = _map_type(row, cols, labels, types)
            if mapped:
                group['types'].add(mapped)
            elif reason != 'room_type_column_missing':
                group['typeReasons'].add(reason)
    return groups, unattributed


def _option_field(room, mapped, group):
    cols, units = group['cols'], group['units']
    index = group['rows'][0][0]
    field = _Field('required_options', group['page'], group['table'], index, modelNo=mapped[0], houseType=mapped[1],
                   room=room)
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
    paid_total, raws, partial, names = 0, [], False, []
    for _, row in group['rows']:
        charge = _text(row[cols['charge']]) if 'charge' in cols else ''
        name = _text(row[cols['item']])
        if name:
            names.append(name)
        amount_cell = row[cols['amount']]
        amount = _amount(amount_cell)
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
    if len(names) != len(set(names)):
        field.hold('option_item_duplicated')  # 추출 중복인지 별개 품목인지 원문만으로 가리지 않는다
    field.raw = '+'.join(raws) if raws else (_text(first_amount) or None)
    paid = _payments(group['rows'], cols, ignore_free_blanks=True)
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


def _identity(pages, numbers, schedule, target, catalog):
    sentences = [x for page in pages for x in find_identities(page['text'], page['page'])]
    found = [{'houseManageNo': x['house_manage_no'], 'page': x['page'], 'kind': 'notice_sentence'}
             for x in sentences] + numbers
    dates = [{'date': x['notice_date'], 'page': x['page'], 'kind': 'notice_sentence', 'weekday': None}
             for x in sentences] + [d for d in schedule if d and 'date' in d]
    for page in pages:
        dates.extend(d for d in (_dated(m.groups(), page['page'], 'notice_date_sentence')
                                 for m in NOTICE_DATE.finditer(page['text'])) if d)
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
            'pages': None, 'tables': None, 'fields': [], 'summary': None, 'evidence': [], 'issues': [], 'paymentSchedules': []}


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
    recognized = {'area': [], 'price': [], 'options': [], 'ignored': [], 'unsupported': []}
    parsed, ignored, schedule, contract_dates = [], {}, [], []
    for page in pages:
        tables = sorted(page.get('tables') or [], key=lambda t: t['bbox'][1])
        for position, table in enumerate(tables):
            grid = _grid(table)
            words = page.get('words') or []
            schedule.extend(_schedule_dates(grid, words, page['page']))
            contract_dates.extend(_contract_dates(grid, words, page['page']))
            count, header = _header(grid) if grid else (None, None)
            kind, cols = _classify(header) if header else (None, None)
            if kind == 'price_without_rooms':
                # 특정 호실 근거가 없는 가격은 호실 분양가로 쓰지 않는다(층·타입별 범위를 호실 값으로 확대하지 않음).
                recognized['unsupported'].append(table['id'])
                issues.append(_issue(document, 'price_rows_not_per_room', page=page['page'], table=table['id']))
                continue
            if kind is None:
                recognized['ignored'].append(table['id'])
                ignored.setdefault(page['page'], []).append((position, len(grid[0]) if grid else 0))
                continue
            if cols.get('_ambiguous'):
                recognized['unsupported'].append(table['id'])
                issues.append(_issue(document, 'table_columns_ambiguous', page=page['page'], table=table['id'],
                                     roles=sorted(cols['_ambiguous'])))
                continue
            recognized[kind].append(table['id'])
            parsed.append({'kind': kind, 'page': page, 'table': table, 'tables': tables, 'cols': cols,
                           'width': len(grid[0]), 'rows': [(i, grid[i]) for i in range(count, len(grid))],
                           'grid': grid, 'headerCount': count,
                           'units': _units(header, _unit_note(page, table, tables)), 'last': position == len(tables) - 1})
    result['tables'] = recognized
    numbers, fields, label_map = [], [], []
    for entry in parsed:
        if entry['kind'] == 'area':
            found, mapped = _area_fields(entry['table'], entry['rows'], entry['cols'], entry['units'], entry['page'],
                                         types, numbers)
            fields.extend(found)
            label_map.extend(mapped)
    identity = _identity(pages, numbers, schedule, target, catalog)
    result['identity'] = identity
    if identity['status'] in ('ambiguous', 'mismatch'):
        return _finish(result, document, 'rejected', *identity['reasons'])
    if identity['status'] != 'confirmed':
        return _finish(result, document, 'held', *identity['reasons'])
    if not any(recognized[k] for k in ('area', 'price', 'options')):
        return _finish(result, document, 'unsupported_layout', 'pdf_tables_not_recognized')
    if incomplete:
        issues.append(_issue(document, 'table_scan_incomplete', pages=incomplete))
    option_groups, payments = {}, {}
    for entry in parsed:
        if entry['kind'] == 'area':
            continue
        page, table = entry['page'], entry['table']
        entry['paymentTimings'] = _payment_columns(entry['grid'], entry['headerCount'], entry['cols']['payments'],
                                                  page['page'], document, contract_dates)
        entry['ambiguousAmountCells'] = _ambiguous_amount_cells(entry['rows'], entry['cols'])
        # 다음 쪽 첫 표가 머리말 없이 같은 열 수면 이 표가 이어진 것일 수 있다.
        continued = entry['last'] and (0, entry['width']) in ignored.get(page['page'] + 1, [])
        if entry['kind'] == 'price':
            found, found_issues = _price_fields(table, entry['rows'], entry['cols'], entry['units'], page, label_map,
                                                types, document)
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
            groups, unattributed = _option_groups(table, entry['rows'], entry['cols'], page, label_map, types)
            scope = _option_scope(page, table, entry['tables'])
            table_reasons = {reason for reason, flag in (('option_rows_unattributed', unattributed),
                                                         ('option_table_continuation_unverified', continued),
                                                         ('table_scan_incomplete', bool(incomplete))) if flag}
            for room, group in groups.items():
                group.update(cols=entry['cols'], units=entry['units'], scope=scope[0], tableReasons=table_reasons,
                             paymentTable=entry)
                option_groups.setdefault(room, []).append(group)
    rooms = {}
    for field in fields:
        if field.data['item'] == 'sale_price':
            rooms.setdefault(field.data['room'], []).append(field.mapped)
    for room in sorted(rooms):
        if len({m[:2] for m in rooms[room]}) != 1:
            continue  # 같은 호실이 여러 주택형에 연결되면 normalize_catalog가 room_model_conflict로 보류한다
        mapped = rooms[room][0][:2] + (next((m[2] for m in rooms[room] if m[2]), None),)
        groups = option_groups.get(room, [])
        if len(groups) == 1:
            group = groups[0]
            field = _option_field(room, mapped, group)
            fields.append(field)
            payments[field] = _payment_details(group['rows'], group['paymentTable'])
            continue
        if groups:
            # 여러 옵션 표에 나온 호실은 완전성·중복을 확인하지 않고 합산하거나 한 표 값으로 확정하지 않는다.
            field = _Field('required_options', groups[0]['page'], groups[0]['table'], groups[0]['rows'][0][0],
                           modelNo=mapped[0], houseType=mapped[1], room=room)
            field.data['classification'] = 'partial'
            field.hold('option_room_in_multiple_tables')
            fields.append(field)
            continue
        # 옵션 근거가 없으면 0원이 아니라 미확인이다. 근거 쪽이 없으므로 evidence 행을 만들지 않는다.
        code = 'room_not_in_options_table' if recognized['options'] else 'options_table_not_found'
        missing = _Field('required_options', None, None, None, modelNo=mapped[0], houseType=mapped[1], room=room)
        missing.hold(code)
        result['fields'].append(dict(missing.data, pageLabel=None, classification='missing',
                                     status=missing.status, value=None, raw=None))
        result['paymentSchedules'].append(_payment_schedule(missing, document, reasons=['payment_evidence_missing']))
        issues.append(_issue(document, code, item='required_options', modelNo=mapped[0], room=room))
    for room in sorted(set(option_groups) - set(rooms)):
        issues.append(_issue(document, 'option_room_not_in_price_table', room=room))
    hold_all = label_summary['status'] == 'inconsistent'
    if hold_all:
        issues.append(_issue(document, 'page_labels_inconsistent'))
    linked = {(h['modelNo'], h['houseType']['value']) for h in catalog['housingTypes'] if h['status'] == 'linked'}
    origin = document.get('originCheck')
    trusted = origin == 'confirmed' or (origin is None and document.get('source') == 'official')
    for field in fields:
        if hold_all:
            field.hold('page_labels_inconsistent')
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
