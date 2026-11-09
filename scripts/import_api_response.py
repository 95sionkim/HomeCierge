#!/usr/bin/env python3
"""공식 브라우저 호출에서 저장한 실제 JSON/XML을 검증용 증거로 등록한다."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from probe_apis import (ROOT, MISSING, AUTH_PARAMS, COUNT_PATHS, api_error, at,
                        field_coverage, parse_payload, read_keys, records_for,
                        response_status, sanitize)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe', required=True)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--param', action='append', default=[])
    parser.add_argument('--transport', choices=['browser_saved_response', 'official_test_tool_copy'],
                        default='browser_saved_response')
    parser.add_argument('--http-status', type=int)
    parser.add_argument('--app-id')
    args = parser.parse_args()
    specs = json.loads((ROOT / 'docs/api/probes.json').read_text())['probes']
    if args.probe not in specs:
        parser.error('등록되지 않은 probe입니다.')
    if not args.label.replace('_', '').replace('-', '').isalnum():
        parser.error('label에는 영문·숫자·밑줄·하이픈만 사용하세요.')
    spec = specs[args.probe]
    params = dict(spec['params'])
    for argument in args.param:
        key, separator, value = argument.partition('=')
        if not separator or key.lower() in AUTH_PARAMS:
            parser.error('요청 조건만 지정하세요. 인증값은 기록하지 않습니다.')
        params[key] = value
    keys = read_keys()
    source = args.input.read_bytes()
    raw = sanitize(source.decode('utf-8-sig'), keys)
    fmt, data = parse_payload(raw.encode('utf-8'))
    error = api_error(data)
    rows = records_for(data, spec['records'])
    result = {
        'probe': args.probe, 'label': args.label, 'service': spec['service'],
        'endpoint': spec['url'], 'request_params': params,
        'captured_at': datetime.fromtimestamp(args.input.stat().st_mtime, timezone.utc).isoformat(),
        'captured_at_note': '원본 저장 파일의 수정시각; 네트워크 요청 시작 시각은 아님',
        'imported_at': datetime.now(timezone.utc).isoformat(),
        'transport': args.transport, 'http_status': args.http_status,
        'http_status_note': '공식 테스트 도구 화면에서 확인' if args.http_status else '브라우저 응답 본문만 확보; HTTP 상태코드는 별도 관찰하지 않음',
        'format': fmt, 'status': 'api_error' if error else ('http_error' if args.http_status and args.http_status >= 400 else response_status(data, spec)),
        'record_count': len(rows), 'response_sha256': hashlib.sha256(source).hexdigest(),
        'sanitized_response_sha256': hashlib.sha256(raw.encode('utf-8')).hexdigest(),
        'field_coverage': field_coverage(rows, spec['fields']),
        'collection_scope': 'single_page_diagnostic',
        'source_file_name': args.input.name,
    }
    if error:
        result['api_error'] = error
    if args.app_id:
        result['authenticated_app_id'] = args.app_id
    counts = {}
    for path in COUNT_PATHS:
        value = at(data, path)
        if value is not MISSING:
            counts[path] = value
    result['reported_counts'] = counts
    # 필터가 있는 청약 응답은 전체 데이터셋의 totalCount보다 matchCount를 우선한다.
    target = counts.get('matchCount', counts.get('response.body.totalCount', counts.get('meta.total_count')))
    result['all_matching_rows_in_snapshot'] = int(target) == len(rows) if target is not None else None
    destination = ROOT / 'api-evidence' / (datetime.now(timezone.utc).strftime('%Y%m%d') + '_live') / args.label
    if destination.exists():
        parser.error('기존 증거를 덮어쓸 수 없습니다. 새 label을 지정하세요.')
    destination.mkdir(parents=True, exist_ok=False)
    (destination / ('response.' + fmt)).write_text(raw)
    (destination / 'parsed.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    (destination / 'result.json').write_text(sanitize(json.dumps(result, ensure_ascii=False, indent=2), keys) + '\n')
    print(json.dumps({'label': args.label, 'status': result['status'], 'records': len(rows)}, ensure_ascii=False))
    return 0 if result['status'] in {'success', 'success_empty'} else 1


if __name__ == '__main__':
    raise SystemExit(main())
