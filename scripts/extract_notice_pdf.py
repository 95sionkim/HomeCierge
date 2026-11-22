#!/usr/bin/env python3
"""공고 PDF의 페이지·표·식별자를 추출한다. 자격 판단이나 누락값 추정은 하지 않는다."""
import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# 과거 최초 공고번호도 본문에 있으므로 현재 공고를 지정하는 문장만 사용한다.
IDENTITY_PATTERN = re.compile(r'본\s*(?:불법행위\s*재공급\s*)?입주자모집공고일은\s*'
                              r'(\d{4})\.(\d{2})\.(\d{2}).{0,240}?'
                              r'주택관리번호는\s*(\d{10})', re.S)


def compact(value):
    return re.sub(r'\s+', '', value or '')


def find_identities(text, page):
    """한 페이지 텍스트에서 현재 공고의 번호·공고일을 함께 지정한 문장을 모두 찾는다."""
    return [{'house_manage_no': match[4], 'notice_date': '-'.join(match.group(i) for i in (1, 2, 3)),
             'page': page, 'quote': match.group(0)} for match in IDENTITY_PATTERN.finditer(text)]


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
