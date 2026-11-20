#!/usr/bin/env python3
"""공식 API 실제 응답과 필드 충족도를 기록한다. 인증키는 출력하지 않는다."""
import argparse
import hashlib
import http.client
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

from credential_redaction import (RedactionError, error_diagnostic, new_stats, redact_structure,
                                  redact_text, redactor_for, same_structure)

ROOT = Path(__file__).resolve().parents[1]
KEY_FILE = ROOT / '.secrets' / 'api.env'
AUTH_KEYS = {
    'data_go': ['DATA_GO_KR_SERVICE_KEY'],
    'kakao': ['KAKAO_REST_API_KEY'],
    'law': ['LAW_OC'],
    'naver': ['NAVER_API_CLIENT_ID', 'NAVER_API_CLIENT_SECRET'],
    'odsay': ['ODSAY_API_KEY'],
}
HOSTS = {
    'data_go': {'api.odcloud.kr', 'apis.data.go.kr'},
    'kakao': {'dapi.kakao.com'},
    'law': {'www.law.go.kr'},
    'naver': {'naverapihub.apigw.ntruss.com'},
    'odsay': {'api.odsay.com'},
}
COUNT_PATHS = ['currentCount', 'totalCount', 'matchCount', 'page', 'perPage',
               'response.body.totalCount', 'response.body.pageNo', 'response.body.numOfRows',
               'body.totalCount', 'body.pageNo', 'body.numOfRows',
               'LawSearch.totalCnt', 'meta.total_count', 'meta.pageable_count', 'meta.is_end']
AUTH_PARAMS = {'servicekey', 'apikey', 'api_key', 'oc', 'authorization',
               'client_secret', 'client_id', 'x-ncp-apigw-api-key', 'x-ncp-apigw-api-key-id'}
ERROR_CODE_PATHS = ['response.header.resultCode', 'header.resultCode',
                    'OpenAPI_ServiceResponse.cmmMsgHeader.returnReasonCode']
ERROR_NAMES = ['error', 'errorType', 'errorCode']


def read_keys():
    """검증 대상 키만 읽는다. OpenAI 키와 다른 환경변수는 읽지 않는다."""
    allowed = {k for group in AUTH_KEYS.values() for k in group}
    keys = {}
    credential_files = [KEY_FILE] + [KEY_FILE.parent / (key + '.env') for key in sorted(allowed)]
    for credential_file in credential_files:
        if not credential_file.is_file():
            continue
        for line in credential_file.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            if key.strip() in allowed:
                keys[key.strip()] = value.strip().strip('"').strip("'")
    for key in allowed:
        if os.environ.get(key):
            keys[key] = os.environ[key]
    return keys


def sanitize(value, keys):
    """로그·저장용 문자열 사본에서 인증값 반향을 가린다.

    JSON/XML로 해석되는 문자열은 키·태그·숫자를 보존하고 문자열 값만 바꾼다. 해석에는 쓰지 않는다.
    규칙은 credential_redaction 모듈 설명을 따른다.
    """
    return redact_text(value, keys)


def known_fields(spec):
    """정상 업무값 근거가 있는 항목 이름: 서비스 명세(probes.json) 필드와 건수·상태 코드 공통 메타데이터."""
    paths = list(spec.get('fields', {}).values()) + COUNT_PATHS + ERROR_CODE_PATHS + ERROR_NAMES + ['code']
    return frozenset(path.split('.')[-1] for path in paths)


def storage_copy(text, fmt, payload, keys, known=frozenset()):
    """원문 해석 결과(payload)에 대응하는 저장용 원문 텍스트·parsed 구조·정제 진단을 만든다.

    known(known_fields(spec))에 없는 일반 항목에서 짧은 인증값이 값 전체·독립 토큰으로 나타나면 저장을 보류한다.

    가릴 값이 없으면 원문과 payload를 그대로 돌려준다. 있으면 정제 구조의 직렬화를 다시 해석해 parsed로 쓰므로
    저장 원문 해시·재해석 무결성 검사가 그대로 성립한다. 해석되지 않은 본문, 구조가 달라지는 사본, 구조 위치에
    남은 반향은 RedactionError(값 없는 사유 코드)로 저장을 막는다.
    """
    if payload is None:
        raise RedactionError('unparsed_body')
    stats = new_stats()
    try:
        safe_text = redactor_for(keys).redact_document(text, fmt, stats, known)
        if safe_text == text:
            return text, payload, stats
        safe_fmt, safe_payload = parse_payload(safe_text.encode('utf-8'))
        if safe_fmt != fmt or not same_structure(payload, safe_payload):
            raise RedactionError('structure_changed')
    except RedactionError:
        raise
    except (ValueError, ET.ParseError, RecursionError):
        raise RedactionError('redacted_copy_unparseable') from None
    return safe_text, safe_payload, stats


def xml_value(node):
    children = list(node)
    if not children:
        return (node.text or '').strip()
    result = {}
    for child in children:
        tag = child.tag.split('}')[-1]
        value = xml_value(child)
        if tag not in result:
            result[tag] = value
        elif isinstance(result[tag], list):
            result[tag].append(value)
        else:
            result[tag] = [result[tag], value]
    return result


def parse_payload(raw):
    text = raw.decode('utf-8-sig')
    if text.lstrip().startswith(('{', '[')):
        payload = json.loads(text)
        if '\\ud' in text or '\\uD' in text:
            # JSON 문자열의 단독 서로게이트는 해석돼도 UTF-8 파일로 보관할 수 없다.
            json.dumps(payload, ensure_ascii=False).encode('utf-8')
        return 'json', payload
    if text.lstrip().startswith('<'):
        root = ET.fromstring(text)
        return 'xml', {root.tag.split('}')[-1]: xml_value(root)}
    raise ValueError('응답이 JSON/XML이 아님')


MISSING = object()


def at(data, path):
    value = data
    for part in path.split('.'):
        if not isinstance(value, dict) or part not in value:
            return MISSING
        value = value[part]
    return value


def records_for(data, paths):
    for path in paths:
        value = at(data, path)
        if value is not MISSING:
            if isinstance(value, list):
                return value
            if isinstance(value, dict):
                return [value]
            if value in ('', None):
                return []
    return []


def api_error(data):
    if not isinstance(data, dict):
        return None
    for path in ERROR_CODE_PATHS:
        value = at(data, path)
        if value is not MISSING and str(value) not in {'0', '00', '000'}:
            return {'code': value, 'reason': 'API 응답의 오류 코드'}
    for name in ERROR_NAMES:
        if data.get(name):
            return {'code': name, 'reason': data[name]}
    if 'code' in data and str(data['code']) not in {'0', '00', '200'}:
        return {'code': data['code'], 'reason': data.get('msg') or data.get('message')}
    return None


def response_status(data, spec):
    """정상 0건과 잘못된 응답 경로를 구분한다. 0건 자체는 필드 검증 성공이 아니다."""
    rows = records_for(data, spec['records'])
    if rows:
        return 'success' if all(isinstance(row, dict) for row in rows) else 'empty_or_unmapped'
    totals = [at(data, p) for p in ['matchCount', 'response.body.totalCount',
              'body.totalCount', 'LawSearch.totalCnt', 'meta.total_count', 'totalCount']]
    zero_total = any(v is not MISSING and str(v).strip() == '0' for v in totals)
    known_container = any(at(data, p) is not MISSING for p in spec['records'])
    valid_header = any(str(at(data, p)) in {'0', '00', '000'}
                       for p in ['response.header.resultCode', 'header.resultCode'])
    return 'success_empty' if zero_total and (known_container or valid_header) else 'empty_or_unmapped'


def field_coverage(records, fields):
    rows = []
    for label, path in fields.items():
        values = [at(record, path) for record in records]
        present = sum(v is not MISSING for v in values)
        # 공백 문자열도 결측값으로 본다. 실제 K-apt 응답의 kaptUrl=' ' 사례 반영.
        filled = sum(v is not MISSING and v is not None and
                     (not isinstance(v, str) or bool(v.strip())) for v in values)
        rows.append({'need': label, 'path': path, 'records': len(records), 'present': present, 'nonempty': filled})
    return rows


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # 인증정보가 임의의 다른 주소로 전달되지 않도록 재지정은 별도 확인한다.
        return None


def run_probe(name, spec, keys, overrides):
    timestamp = datetime.now(timezone.utc)
    if any(k.lower() in AUTH_PARAMS for k in {**spec['params'], **overrides}):
        return {'probe': name, 'status': 'invalid_params', 'reason': '인증값은 비밀파일에 저장'}, None, None
    result = {'probe': name, 'service': spec['service'], 'checked_at': timestamp.isoformat(), 'endpoint': spec['url'],
              'transport': 'python_urllib', 'request_params': {**spec['params'], **overrides}, 'collection_scope': 'single_page_diagnostic'}
    required = AUTH_KEYS[spec['auth']]
    absent = [key for key in required if not keys.get(key)]
    if absent:
        return {**result, 'status': 'missing_key', 'missing_key_names': absent}, None, None
    parsed = urllib.parse.urlsplit(spec['url'])
    if parsed.scheme != 'https' or parsed.hostname not in HOSTS[spec['auth']]:
        return {**result, 'status': 'invalid_endpoint'}, None, None
    params = dict(result['request_params'])
    if spec.get('required_one_of') and not any(params.get(p) for p in spec['required_one_of']):
        return {**result, 'status': 'missing_request_params', 'required_one_of': spec['required_one_of']}, None, None
    if spec['auth'] == 'law' and params.get('MST') and not params.get('ID'):
        if not params.get('efYd'):
            return {**result, 'status': 'missing_request_params', 'required': ['efYd']}, None, None
    headers = {'User-Agent': 'CheongyakAgent-DataValidation/0.1', 'Accept': 'application/json, application/xml, text/xml'}
    auth = spec['auth']
    if auth == 'data_go':
        params['serviceKey'] = urllib.parse.unquote(keys['DATA_GO_KR_SERVICE_KEY'])
    elif auth == 'kakao':
        headers['Authorization'] = 'KakaoAK ' + keys['KAKAO_REST_API_KEY']
    elif auth == 'law':
        params['OC'] = keys['LAW_OC']
    elif auth == 'odsay':
        params['apiKey'] = urllib.parse.unquote(keys['ODSAY_API_KEY'])
    elif auth == 'naver':
        headers['X-NCP-APIGW-API-KEY-ID'] = keys['NAVER_API_CLIENT_ID']
        headers['X-NCP-APIGW-API-KEY'] = keys['NAVER_API_CLIENT_SECRET']
    opener = urllib.request.build_opener(NoRedirect)
    try:
        request = urllib.request.Request(spec['url'] + '?' + urllib.parse.urlencode(params), headers=headers)
        with opener.open(request, timeout=25) as response:
            raw = response.read(10 * 1024 * 1024 + 1)
            result.update(http_status=response.status, content_type=response.headers.get('Content-Type'))
            if len(raw) > 10 * 1024 * 1024:
                return {**result, 'status': 'response_too_large'}, None, None
    except urllib.error.HTTPError as exc:
        raw = exc.read(1024 * 1024)
        result.update(http_status=exc.code, status='http_error')
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException, ValueError) as exc:
        # 예외 문장은 요청 URL·헤더를 담을 수 있으므로 형식 이름만 기록한다.
        result.update(status='network_error', error=error_diagnostic(exc))
        return result, None, None
    result['response_sha256'] = hashlib.sha256(raw).hexdigest()
    try:
        # 해석은 원문 바이트를 엄격한 UTF-8(BOM 허용)로 한다. 손상된 바이트를 대체 문자로 바꿔 수집하지 않는다.
        fmt, payload = parse_payload(raw)
        text = raw.decode('utf-8-sig')  # 저장 사본의 기준 텍스트. 정제는 아래 저장 사본에만 적용한다.
        result['format'] = fmt
        error = api_error(payload)
        if error:
            result.update(status='api_error', api_error=error)
        elif result.get('status') != 'http_error':
            records = records_for(payload, spec['records'])
            result.update(status=response_status(payload, spec), record_count=len(records), field_coverage=field_coverage(records, spec['fields']))
            for path in COUNT_PATHS:
                value = at(payload, path)
                if value is not MISSING:
                    result.setdefault('reported_counts', {})[path] = value
    except (ValueError, ET.ParseError, RecursionError) as exc:
        # 판별되지 않은 본문은 반향 여부를 확인할 수 없으므로 저장하지 않고 원 해시와 값 없는 진단만 남긴다.
        result.update(status=result.get('status', 'parse_error'), parse_error=type(exc).__name__,
                      response_bytes=len(raw), response_withheld='unparsed_body')
        return redact_structure(result, keys), None, None
    try:
        safe_raw, safe_payload, stats = storage_copy(text, fmt, payload, keys, known_fields(spec))
    except RedactionError as exc:
        # 해석 상태는 interpreted_status로 남기되 안전한 저장 사본이 없으므로 수집 완료로 쓰지 않는다.
        # 보류한 본문에서 추출한 오류 객체와 건수 필드도 그대로 보관할 수 없다.
        result.pop('api_error', None)
        result.pop('reported_counts', None)
        result.update(interpreted_status=result.get('status'), status='redaction_failed',
                      response_bytes=len(raw), response_withheld=str(exc))
        if exc.stats:
            result['response_redaction'] = exc.stats  # 값 없는 건수만
        return redact_structure(result, keys), None, None
    # 법령 상세 링크처럼 반향을 가린 사본은 원 해시와 정제 해시가 달라진다.
    result.update(sanitized_response_sha256=hashlib.sha256(safe_raw.encode('utf-8')).hexdigest(), response_redaction=stats)
    return redact_structure(result, keys), safe_raw, safe_payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-config', action='store_true')
    parser.add_argument('--probe')
    parser.add_argument('--param', action='append', default=[])
    args = parser.parse_args()
    probes = json.loads((ROOT / 'docs/api/probes.json').read_text())['probes']
    keys = read_keys()
    if args.check_config:
        print(json.dumps({'credential_file_exists': KEY_FILE.exists(), 'key_configured': {k: bool(keys.get(k)) for group in AUTH_KEYS.values() for k in group}, 'probes': list(probes)}, ensure_ascii=False, indent=2))
        return 0
    if args.probe not in probes:
        parser.error('--probe 에 등록된 시나리오 이름을 지정하세요.')
    overrides = {}
    for entry in args.param:
        if '=' not in entry:
            parser.error('--param 은 이름=값 형식입니다.')
        key, value = entry.split('=', 1)
        if key.lower() in AUTH_PARAMS:
            parser.error('인증값은 --param 대신 비밀파일에 저장하세요.')
        overrides[key] = value
    result, raw, payload = run_probe(args.probe, probes[args.probe], keys, overrides)
    # 비밀값을 최종 산출 직전에 한 번 더 제거한다. 키·숫자를 보존하는 구조 단위 정제다.
    result = redact_structure(result, keys)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    directory = ROOT / 'api-evidence' / (stamp + '_' + args.probe)
    directory.mkdir(parents=True, exist_ok=False)
    (directory / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    if raw is not None:
        # sanitized_response_sha256과 같은 바이트를 그대로 쓴다(로캘·줄바꿈 변환 없음).
        (directory / ('response.' + result.get('format', 'txt'))).write_bytes(raw.encode('utf-8'))
    if payload is not None:
        (directory / 'parsed.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'probe': args.probe, 'record_count': result.get('record_count'), 'evidence_directory': str(directory)}, ensure_ascii=False))
    return 0 if result['status'] in {'success', 'success_empty'} else 1


if __name__ == '__main__':
    sys.exit(main())
