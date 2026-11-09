#!/usr/bin/env python3
"""공고 PDF의 페이지·표·식별자를 추출한다. 자격 판단이나 누락값 추정은 하지 않는다."""
import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def compact(value):
    return re.sub(r'\s+', '', value or '')


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
            tables = []
            for table_index, table in enumerate(page.find_tables().tables):
                tables.append({
                    'id': 'p%dt%d' % (index + 1, table_index),
                    'bbox': list(table.bbox), 'rows': table.extract(),
                    'cell_bboxes': [[list(cell) if cell else None for cell in row.cells] for row in table.rows],
                })
            pages.append({'page': index + 1, 'width': page.rect.width, 'height': page.rect.height,
                          'text': text, 'tables': tables, 'text_character_count': len(compact(text))})
            # 과거 최초 공고번호도 본문에 있으므로 현재 공고를 지정하는 문장만 사용한다.
            pattern = (r'본\s*(?:불법행위\s*재공급\s*)?입주자모집공고일은\s*'
                       r'(\d{4})\.(\d{2})\.(\d{2}).{0,240}?'
                       r'주택관리번호는\s*(\d{10})')
            for match in re.finditer(pattern, text, re.S):
                identities.append({'house_manage_no': match[4],
                                   'notice_date': '-'.join(match.group(i) for i in (1, 2, 3)),
                                   'page': index + 1, 'quote': match.group(0)})
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
