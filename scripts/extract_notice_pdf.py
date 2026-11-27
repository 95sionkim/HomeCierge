#!/usr/bin/env python3
"""공고 PDF의 페이지·표·식별자를 추출한다. 자격 판단이나 누락값 추정은 하지 않는다."""
import argparse
import hashlib
import json
import re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRIOR_ROUND_MARKER = re.compile(r'(?:최초|당초|종전|기존|이전|직전)\s*$')
PRIOR_NUMBER_MARKER = re.compile(r'(?:최초|당초|종전|기존|이전|직전)\s*(?:주택\s*관리\s*번호|공고\s*번호)')
_CURRENT_QUALIFIER = (
    r'(?:(?:주택|아파트|공고|단지)\s*의\s*)?'
    r'(?:(?:무순위\s*(?:\(\s*사후\s*\)\s*)?|불법행위\s*재공급\s*|계약취소(?:주택|세대)?\s*(?:재공급\s*)?|'
    r'재공급\s*|잔여세대\s*|임의공급\s*))?'
)
_DATE_PART = r'(\d{4})\s*(?:[.\-]|년)\s*(\d{1,2})\s*(?:[.\-]|월)\s*(\d{1,2})\s*(?:일|\.)?'
# 과거 최초 공고번호도 본문에 있으므로 현재 공고를 지정하는 문장만 사용한다.
# 띄어쓰기가 추출되지 않은 PDF와 줄바꿈·무순위(사후)·공고번호 표기를 함께 수용한다.
IDENTITY_PATTERN = re.compile(
    r'본\s*' + _CURRENT_QUALIFIER + r'입주자\s*모집\s*공고일\s*(?:은|는|:|：)\s*'
    + _DATE_PART
    + r'.{0,260}?(?:주택\s*관리\s*번호|공고\s*번호)\s*(?:는|은|:|：)\s*(\d{10})',
    re.S,
)
# 공고일 문장과 별도 문장으로 적힌 현재 공고의 주택관리번호·공고번호.
NOTICE_NUMBER_SENTENCE = re.compile(
    r'본\s*' + _CURRENT_QUALIFIER + r'(?:주택\s*관리\s*번호|공고\s*번호)\s*(?:는|은|:|：)\s*(\d{10})',
    re.S,
)
NOTICE_NUMBER_LABEL = re.compile(
    r'(?:^|[■□◆◇▣•※\n])\s*(?:금회\s*)?(?:주택\s*관리\s*번호|입주자\s*모집\s*공고\s*번호|모집\s*공고\s*번호|공고\s*번호)\s*[:：]\s*(\d{10})',
    re.M,
)


def compact(value):
    return re.sub(r'\s+', '', value or '')


def _iso_date(year, month, day):
    try:
        return date(int(year), int(month), int(day)).isoformat()
    except ValueError:
        return None


def find_identities(text, page):
    """한 페이지 텍스트에서 현재 공고의 번호·공고일을 함께 지정한 문장을 모두 찾는다."""
    found = []
    for match in IDENTITY_PATTERN.finditer(text or ''):
        quote = match.group(0)
        if PRIOR_NUMBER_MARKER.search(quote):
            continue
        iso = _iso_date(match.group(1), match.group(2), match.group(3))
        if iso is None:
            continue
        found.append({'house_manage_no': match.group(4), 'notice_date': iso, 'page': page, 'quote': quote})
    return found


def find_notice_numbers(text, page):
    """한 페이지 텍스트에서 현재 공고를 가리키는 단독 주택관리번호·공고번호 표기를 찾는다.

    '최초 주택관리번호'처럼 다른 회차를 가리키는 표기는 제외한다.
    """
    source = text or ''
    found, seen = [], set()
    for kind, pattern in (('notice_number_sentence', NOTICE_NUMBER_SENTENCE),
                          ('notice_number_label', NOTICE_NUMBER_LABEL)):
        for match in pattern.finditer(source):
            before = source[max(0, match.start() - 16):match.start()]
            if PRIOR_ROUND_MARKER.search(before):
                continue
            number = match.group(1)
            key = (number, kind)
            if key in seen:
                continue
            seen.add(key)
            found.append({'houseManageNo': number, 'page': page, 'kind': kind})
    return found


def table_record(page, table_index, table):
    """PyMuPDF 표 하나를 셀 문자열과 셀 좌표로 옮긴다. 병합으로 가려진 셀은 None이다."""
    return {'id': 'p%dt%d' % (page, table_index), 'bbox': list(table.bbox), 'rows': table.extract(),
            'cell_bboxes': [[list(cell) if cell else None for cell in row.cells] for row in table.rows]}


def extract(pdf_path):
    try:
        import fitz
    except ImportError as exc:
        raise SystemExit('PDF 추출에는 PyMuPDF가 필요합니다. docs/api/pdf-supplement-validation.md 참조.') from exc
    raw = pdf_path.read_bytes()
    pages, identities = [], []
    with fitz.open(pdf_path) as document:
        for index, page in enumerate(document):
            text = page.get_text(sort=True)
            tables = [table_record(index + 1, table_index, table)
                      for table_index, table in enumerate(page.find_tables().tables)]
            pages.append({'page': index + 1, 'width': page.rect.width, 'height': page.rect.height,
                          'text': text, 'tables': tables, 'text_character_count': len(compact(text))})
            identities.extend(find_identities(text, index + 1))
    unique = {(x['house_manage_no'], x['notice_date']) for x in identities}
    return {
        'schema_version': 1, 'source_sha256': hashlib.sha256(raw).hexdigest(),
        'source_bytes': len(raw), 'page_count': len(pages),
        'extractor': {'name': 'PyMuPDF', 'version': fitz.VersionBind, 'ocr_used': False},
        'identity': identities[0] if len(unique) == 1 else None,
        'identity_candidates': identities,
        'review_required': True,
        'pages_needing_ocr_review': [p['page'] for p in pages if p['text_character_count'] < 50],
        'pages': pages,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pdf', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = extract(args.pdf)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: result[k] for k in ['source_sha256', 'page_count', 'identity', 'pages_needing_ocr_review']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
