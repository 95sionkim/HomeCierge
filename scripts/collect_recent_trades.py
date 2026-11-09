#!/usr/bin/env python3
"""실거래를 계약월별 전체 페이지로 수집한다. 불완전 수집은 분석 가능으로 표시하지 않는다."""
import argparse
import hashlib
import json
import math
import re
from datetime import date, datetime, timezone, timedelta
from decimal import Decimal

from probe_apis import ROOT, at, read_keys, records_for, run_probe, sanitize


def months_between(start, end):
    def number(value):
        if not re.fullmatch(r'\d{6}', value):
            raise ValueError('월은 YYYYMM 형식이어야 합니다.')
        parsed = datetime.strptime(value, '%Y%m')
        return parsed.year * 12 + parsed.month - 1
    first, last = number(start), number(end)
    if first > last or last - first > 120:
        raise ValueError('수집 기간은 순방향 121개월 이내로 지정하세요.')
    return [f'{n // 12:04d}{n % 12 + 1:02d}' for n in range(first, last + 1)]


def default_range():
    today = datetime.now(timezone(timedelta(hours=9))).date()
    last = today.year * 12 + today.month - 2
    first = last - 11
    return f'{first // 12:04d}{first % 12 + 1:02d}', f'{last // 12:04d}{last % 12 + 1:02d}'


def assess_month(pages):
    """각 페이지의 개수·번호·전체 건수를 대조한다. 거래 행 자체는 임의 중복 제거하지 않는다."""
    problems, records, totals, page_numbers, page_sizes = [], [], [], [], []
    page_hashes = []
    for result, payload in pages:
        if result.get('status') not in {'success', 'success_empty'} or payload is None:
            problems.append(result.get('status', 'missing_response'))
            continue
        rows = records_for(payload, ['response.body.items.item'])
        try:
            total = int(at(payload, 'response.body.totalCount'))
            page = int(at(payload, 'response.body.pageNo'))
            size = int(at(payload, 'response.body.numOfRows'))
            if total < 0 or page < 1 or size < 1:
                raise ValueError()
        except (TypeError, ValueError):
            problems.append('invalid_pagination')
            continue
        expected = max(0, min(size, total - (page - 1) * size))
        if len(rows) != expected:
            problems.append('page_record_count_mismatch')
        totals.append(total)
        page_numbers.append(page)
        page_sizes.append(size)
        if rows:
            page_hashes.append(hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False).encode()).hexdigest())
        records.extend(rows)
    total = totals[0] if totals else None
    if not pages:
        problems.append('no_pages')
    if totals and len(set(totals)) != 1:
        problems.append('total_changed_during_collection')
    if len(set(page_sizes)) > 1:
        problems.append('page_size_changed')
    if len(page_numbers) != len(set(page_numbers)) or len(page_hashes) != len(set(page_hashes)):
        problems.append('repeated_page')
    if total is not None and page_sizes:
        expected_pages = max(1, math.ceil(total / page_sizes[0]))
        if sorted(page_numbers) != list(range(1, expected_pages + 1)):
            problems.append('missing_or_unexpected_pages')
        if len(records) != total:
            problems.append('total_record_count_mismatch')
    return {'complete': bool(pages) and not problems, 'reported_total': total,
            'collected': len(records), 'pages': page_numbers, 'problems': sorted(set(problems))}, records


def normalize(row, month, lawd_cd, probe):
    """만원을 원으로 바꾸고 해제·날짜·단위 오류를 보수적으로 표시한다."""
    issues = []
    amount = area = deal_date = None
    try:
        value = Decimal(str(row['dealAmount']).replace(',', '').strip()) * 10000
        if not value.is_finite() or value <= 0 or value != value.to_integral_value():
            raise ValueError()
        amount = int(value)
    except (KeyError, ValueError, ArithmeticError):
        issues.append('invalid_price')
    try:
        value = Decimal(str(row['excluUseAr']).strip())
        if not value.is_finite() or value <= 0:
            raise ValueError()
        area = str(value)
    except (KeyError, ValueError, ArithmeticError):
        issues.append('invalid_exclusive_area')
    try:
        deal_date = date(int(row['dealYear']), int(row['dealMonth']), int(row['dealDay'])).isoformat()
        if deal_date[:7].replace('-', '') != month:
            issues.append('contract_month_mismatch')
    except (KeyError, TypeError, ValueError):
        issues.append('invalid_contract_date')
    if str(row.get('sggCd', '')).strip() != lawd_cd:
        issues.append('district_mismatch_or_missing')
    if not str(row.get('aptNm') or '').strip():
        issues.append('missing_apartment_name')
    cancel_mark = str(row.get('cdealType') or '').strip().upper()
    cancel_date = str(row.get('cdealDay') or '').strip()
    if cancel_mark in {'Y', 'O'} or cancel_date:
        cancellation = 'cancelled'
    elif 'cdealType' not in row or 'cdealDay' not in row or cancel_mark not in {'', 'N'}:
        cancellation = 'unknown'
        issues.append('unknown_cancellation_state')
    else:
        cancellation = 'not_marked_cancelled'
    rights_type = None
    if probe == 'apt_rights':
        # 공식 기술문서: 입주권일 때만 '입' 표기. 필드의 명시적 공백은 분양권이다.
        rights_raw = row.get('ownershipGbn')
        if rights_raw is None:
            issues.append('missing_rights_type')
        elif str(rights_raw).strip() == '입':
            rights_type = 'occupancy_right'
        elif str(rights_raw).strip() == '':
            rights_type = 'presale_right'
        else:
            issues.append('unknown_rights_type')
    return {'apartment_name': row.get('aptNm'), 'apartment_id': row.get('aptSeq'),
            'contract_date': deal_date, 'price_krw': amount, 'exclusive_area_m2': area,
            'floor': row.get('floor'), 'build_year': row.get('buildYear'),
            'district_code': row.get('sggCd'), 'legal_dong': row.get('umdNm'), 'lot': row.get('jibun'),
            'trade_kind': probe, 'rights_type': rights_type, 'rights_type_raw': row.get('ownershipGbn'),
            'cancellation_status': cancellation, 'cancellation_date_raw': cancel_date or None,
            'issues': issues, 'eligible_for_comparison_after_matching': cancellation == 'not_marked_cancelled' and not issues,
            'raw': row}


def write_json(path, value, keys):
    path.write_text(sanitize(json.dumps(value, ensure_ascii=False, indent=2), keys) + '\n')


def main():
    start, end = default_range()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe', choices=['apt_trade', 'apt_rights'], default='apt_trade')
    parser.add_argument('--lawd-cd', default='11215')
    parser.add_argument('--start', default=start)
    parser.add_argument('--end', default=end)
    parser.add_argument('--page-size', type=int, default=1000)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    try:
        months = months_between(args.start, args.end)
    except ValueError as exc:
        parser.error(str(exc))
    if not re.fullmatch(r'\d{5}', args.lawd_cd) or not 1 <= args.page_size <= 1000:
        parser.error('5자리 지역코드와 1~1000 페이지 크기를 지정하세요.')
    current = datetime.now(timezone(timedelta(hours=9))).strftime('%Y%m')
    if args.end > current:
        parser.error('미래 계약월은 수집하지 않습니다.')
    if args.dry_run:
        print(json.dumps({'probe': args.probe, 'district': args.lawd_cd, 'months': months,
                          'page_size': args.page_size, 'mode': 'plan_only_no_network'}, ensure_ascii=False, indent=2))
        return 0
    specs = json.loads((ROOT / 'docs/api/probes.json').read_text())['probes']
    keys = read_keys()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    root = ROOT / 'api-evidence' / (stamp + '_recent_' + args.probe)
    root.mkdir(parents=True)
    summary = {'probe': args.probe, 'district': args.lawd_cd, 'requested_months': months,
               'started_at': datetime.now(timezone.utc).isoformat(), 'months': [],
               'scope_note': '수집 시점 신고 데이터의 계약월별 스냅샷. 향후 정정·해제 가능. 현재월은 진행 중.'}
    for month in months:
        pages, page = [], 1
        directory = root / month
        directory.mkdir()
        while True:
            result, raw, payload = run_probe(args.probe, specs[args.probe], keys,
                {'LAWD_CD': args.lawd_cd, 'DEAL_YMD': month, 'pageNo': page, 'numOfRows': args.page_size})
            result['collection_scope'] = 'monthly_snapshot_page'
            write_json(directory / f'page_{page:04d}_result.json', result, keys)
            if raw is not None:
                (directory / f'page_{page:04d}_response.{result.get("format", "txt")}').write_text(raw)
            pages.append((result, payload))
            state, records = assess_month(pages)
            fatal = set(state['problems']) - {'missing_or_unexpected_pages', 'total_record_count_mismatch'}
            if state['complete'] or fatal or page >= 1000:
                break
            page += 1
        if page >= 1000 and not state['complete']:
            state['problems'].append('page_limit')
        normalized = [normalize(r, month, args.lawd_cd, args.probe) for r in records]
        state.update(month=month, current_month_in_progress=month == current,
                     cancelled_count=sum(r['cancellation_status'] == 'cancelled' for r in normalized),
                     rows_with_issues=sum(bool(r['issues']) for r in normalized))
        # 전체 수집과 행 검증이 모두 끝나야 비교 단지 연결에 사용할 수 있다.
        state['ready_for_matching'] = state['complete'] and not state['rows_with_issues']
        write_json(directory / 'normalized.json', normalized, keys)
        write_json(directory / 'coverage.json', state, keys)
        summary['months'].append(state)
        if not state['complete']:
            break  # 인증/네트워크 실패를 나머지 월에 반복하지 않는다.
    summary['unattempted_months'] = months[len(summary['months']):]
    summary['complete'] = not summary['unattempted_months'] and all(m['complete'] for m in summary['months'])
    summary['ready_for_matching'] = summary['complete'] and all(m['ready_for_matching'] for m in summary['months'])
    write_json(root / 'summary.json', summary, keys)
    print(json.dumps({'evidence_directory': str(root), 'complete': summary['complete'],
                      'attempted_months': len(summary['months']), 'unattempted_months': len(summary['unattempted_months'])}, ensure_ascii=False))
    return 0 if summary['complete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
