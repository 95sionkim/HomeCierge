#!/usr/bin/env python3
"""로컬 공고 표본 디렉토리에서 공고 PDF 서식 점검을 오프라인으로 재실행한다.

외부 네트워크를 호출하지 않으며 기본 테스트 스위트(test_*.py)에 포함되지 않는다.
공고별 상태·사유 코드·확인 항목 수·가격 단위 종류 건수만 출력하며, 원문 문구·금액·주소는 출력하지 않는다.
"""
import argparse
import hashlib
import json
import sys
import time
from collections import Counter
from pathlib import Path

from notice_pdf_fields import inspect_notice_pdf


def _notice_kind_label(catalog):
    raw = ((catalog.get('notice') or {}).get('kind') or {}).get('raw') or {}
    parts = []
    for key in ('HOUSE_SECD_NM', 'HOUSE_DTL_SECD_NM'):
        field = raw.get(key)
        if isinstance(field, dict) and field.get('status') == 'reported' and field.get('value'):
            parts.append(str(field['value']).strip())
    return '/'.join(parts) if parts else 'unknown'


def _document_meta(notice_dir, catalog, pdf_bytes):
    target = catalog['target']
    digest = hashlib.sha256(pdf_bytes).hexdigest()
    doc_id = f"applyhome:{target['houseManageNo']}:{target['noticeNo']}:0:0"
    review_path = notice_dir / 'review.json'
    if review_path.is_file():
        try:
            review = json.loads(review_path.read_text(encoding='utf-8'))
            docs = ((review.get('relation') or {}).get('documents') or [])
            if docs and isinstance(docs[0], str):
                doc_id = docs[0]
        except (OSError, json.JSONDecodeError):
            pass
    return {
        'id': doc_id,
        'version': 'sha256:' + digest,
        'sha256': digest,
        'source': 'official',
        'originCheck': 'confirmed',
        'houseManageNo': target['houseManageNo'],
        'noticeNo': target['noticeNo'],
        'edition': target['edition'],
    }


def _baseline_summary(notice_dir):
    review_path = notice_dir / 'review.json'
    if not review_path.is_file():
        return None
    try:
        review = json.loads(review_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None
    reasons = sorted({
        *(review.get('reasons') or ()),
        *((review.get('relation') or {}).get('reasons') or ()),
        *(issue.get('code') for issue in (review.get('issues') or ()) if isinstance(issue, dict) and issue.get('code')),
    })
    return {'status': review.get('acquisitionStatus') or review.get('status'), 'reasons': reasons}


def verify_sample(notice_dir):
    catalog_path = notice_dir / 'catalog.json'
    if not catalog_path.is_file():
        return None
    catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    target = catalog.get('target') or {}
    notice_no = target.get('noticeNo') or notice_dir.name
    kind = _notice_kind_label(catalog)
    pdfs = sorted(notice_dir.glob('*.pdf'))
    baseline = _baseline_summary(notice_dir)
    if not pdfs:
        return {
            'noticeNo': notice_no,
            'kind': kind,
            'models': len(catalog.get('housingTypes') or ()),
            'status': 'attachment_not_found',
            'identityStatus': None,
            'tables': {},
            'byItem': {item: {'confirmed': 0, 'unverified': 0, 'conflict': 0}
                       for item in ('supply_area', 'sale_price', 'required_options')},
            'unitKinds': {},
            'paymentSchedules': {'confirmed': 0, 'unverified': 0, 'conflict': 0},
            'correction': {'detected': False, 'fullReplacementDeclared': False, 'affectedScopes': []},
            'pages': {'total': 0, 'scanned': 0, 'incomplete': 0},
            'elapsedSec': 0.0,
            'reasons': ['attachment_not_found'],
            'baseline': baseline,
        }
    pdf_bytes = pdfs[0].read_bytes()
    doc_meta = _document_meta(notice_dir, catalog, pdf_bytes)
    t0 = time.perf_counter()
    result = inspect_notice_pdf(pdf_bytes, target=target, catalog=catalog, document=doc_meta)
    elapsed_sec = round(time.perf_counter() - t0, 3)
    unit_kinds = Counter()
    for field in result.get('fields') or ():
        if field.get('item') == 'sale_price':
            unit = field.get('unit')
            unit_kinds[(unit.get('kind') if isinstance(unit, dict) else 'unknown')] += 1
    schedule_counts = Counter(s.get('status') for s in (result.get('paymentSchedules') or ()))
    reasons = sorted({issue['code'] for issue in (result.get('issues') or ()) if isinstance(issue, dict) and issue.get('code')})
    tables = result.get('tables') or {}
    corr = result.get('correction') or {}
    page_info = result.get('pages') or {}
    scan_info = page_info.get('tableScan') or {}
    incomplete_count = sum(len(scan_info.get(k) or ()) for k in ('skipped_limit', 'failed', 'text_failed'))
    return {
        'noticeNo': notice_no,
        'kind': kind,
        'models': len(catalog.get('housingTypes') or ()),
        'status': result.get('status'),
        'identityStatus': (result.get('identity') or {}).get('status'),
        'tables': {k: len(v) for k, v in tables.items() if v},
        'byItem': (result.get('summary') or {}).get('byItem') or {},
        'unitKinds': dict(sorted(unit_kinds.items())),
        'paymentSchedules': {s: schedule_counts.get(s, 0) for s in ('confirmed', 'unverified', 'conflict')},
        'correction': {
            'detected': bool(corr.get('detected')),
            'fullReplacementDeclared': bool(corr.get('fullReplacementDeclared')),
            'affectedScopes': list(corr.get('affectedScopes') or ()),
        },
        'pages': {
            'total': int((result.get('source') or {}).get('pageCount') or 0),
            'scanned': len(scan_info.get('scanned') or ()),
            'incomplete': incomplete_count,
        },
        'elapsedSec': elapsed_sec,
        'reasons': reasons,
        'baseline': baseline,
    }


def _format_table(rows):
    header = (
        '| 공고 | 유형 | 상태 | 식별 | 공급면적(확/보/충) | 분양가(확/보/충) | 필수옵션(확/보/충) | 단위 | 납부일정(확/보/충) | 스캔(쪽) | 시간(초) | 사유 코드 |'
    )
    sep = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
    lines = [header, sep]
    for row in rows:
        by = row['byItem']
        fmt = lambda item: f"{by.get(item, {}).get('confirmed', 0)}/{by.get(item, {}).get('unverified', 0)}/{by.get(item, {}).get('conflict', 0)}"
        ps = row['paymentSchedules']
        ps_text = f"{ps.get('confirmed', 0)}/{ps.get('unverified', 0)}/{ps.get('conflict', 0)}"
        units_text = ', '.join(f'{k}:{v}' for k, v in row['unitKinds'].items()) or '-'
        pages = row.get('pages') or {}
        scan_text = f"{pages.get('scanned', 0)}/{pages.get('total', 0)}" if pages.get('total') else '-'
        elapsed_text = f"{row.get('elapsedSec', 0.0):.3f}"
        reasons_text = ', '.join(row['reasons']) or '-'
        lines.append(
            f"| {row['noticeNo']} | {row['kind']} | {row['status']} | {row['identityStatus'] or '-'} "
            f"| {fmt('supply_area')} | {fmt('sale_price')} | {fmt('required_options')} "
            f"| {units_text} | {ps_text} | {scan_text} | {elapsed_text} | {reasons_text} |"
        )
    return '\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--samples-dir', type=Path, required=True, help='로컬 표본 공고 디렉토리')
    parser.add_argument('--json', action='store_true', help='요약 표 대신 JSON 배열 출력')
    args = parser.parse_args(argv)
    if not args.samples_dir.is_dir():
        print('표본 디렉토리를 찾을 수 없습니다.', file=sys.stderr)
        return 2
    rows = []
    for entry in sorted(args.samples_dir.iterdir()):
        if not entry.is_dir() or entry.name.startswith('_'):
            continue
        summary = verify_sample(entry)
        if summary is not None:
            rows.append(summary)
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print(_format_table(rows))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
