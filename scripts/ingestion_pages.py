#!/usr/bin/env python3
"""출처·요청 범위 하나의 모든 페이지를 모으고 완전성을 판정한다(BE-02 공통 커넥터).

전송은 호출자가 주입한다. 개발·검사는 합성 재생(ReplayTransport)만 쓰고, 실제 호출 어댑터(LiveProbeTransport)는
수동 호출자가 명세와 키를 직접 넘길 때만 만든다. 이 모듈은 키 파일을 읽거나 네트워크를 열지 않는다.

fetch(source, scope, page, page_size)는 응답 봉투(dict)를 돌려준다.
  source, scope, page, pageSize  요청 단위 반향. 조회와 정확히 같아야 한다(형식 포함).
  httpStatus      정수. 전송 실패면 None
  transportError  None 또는 TRANSPORT_ERRORS 코드
  body            JSON/XML 문자열(권장), JSON 객체·배열 또는 None. 문자열 JSON은 loads_source_json으로 읽는다.
                  객체 본문의 금액·면적 항목이 float이면 자릿수가 이미 사라진 것이므로 ValueError로 거부한다.
  observedAt      RFC 3339 시각(오프셋 필수). 재생 미제공(not_provided)일 때만 None

결과의 status는 이 요청 하나의 수집 상태다. empty는 업무 응답이 정상이고 확인된 전체 건수가 0이라는 뜻이며
지역·단지의 정상 0개 판정이 아니다. 재시도·휴지·요청 상한의 운영값은 정하지 않는다(D-07·BE-04).
"""
import copy
import hashlib
import json
import re
import xml.etree.ElementTree as ET
from datetime import date

from probe_apis import MISSING, api_error, at, parse_payload, run_probe

KINDS = {
    # 청약홈(odcloud). 필터 조회의 totalCount는 전체 데이터 건수이므로 matchCount를 쓴다.
    'odcloud': {'page': 'page', 'size': 'perPage', 'echo_page': 'page', 'echo_size': 'perPage'},
    # 국토교통부 실거래(data.go.kr). response.header.resultCode가 정상 코드여야 한다.
    'rtms': {'page': 'pageNo', 'size': 'numOfRows', 'echo_page': 'response.body.pageNo',
             'echo_size': 'response.body.numOfRows'},
}
SOURCES = {
    'applyhome_apt': 'odcloud', 'applyhome_remainder': 'odcloud',
    'applyhome_apt_model': 'odcloud', 'applyhome_remainder_model': 'odcloud',
    'apt_trade': 'rtms', 'apt_rights': 'rtms',
}
# 전송 실패 코드 → BE-01 upstreamError와 세부 사유
TRANSPORT_ERRORS = {
    'timeout': ('upstream_timeout', 'network', None),
    'connection': ('upstream_unavailable', 'network', None),
    'too_large': ('upstream_response_too_large', 'parse', None),
    'withheld': ('upstream_malformed_response', 'parse', 'response_withheld'),  # 안전한 사본을 만들 수 없어 본문 보류
    'not_provided': ('upstream_unavailable', 'network', 'replay_response_not_provided'),  # 재생 입력에 없음
    # 정제기가 JSON을 다시 직렬화해 금액·면적 실수 토큰의 원래 자릿수를 확인할 수 없음(실호출 어댑터 전용)
    'precision_unverified': ('upstream_malformed_response', 'parse', 'decimal_precision_unverified'),
}
# 정확한 십진값이 필요한 원문 금액·면적 항목(probes.json 명세 기준)
PRECISION_FIELDS = ('dealAmount', 'excluUseAr', 'SUPLY_AR', 'LTTOT_TOP_AMOUNT')
# 앞의 다섯은 BE-01 사유 코드와 같은 이름이다. 사유가 하나라도 있으면 complete/empty가 될 수 없다.
REASON_CODES = (
    'collection_request_failed', 'collection_page_missing', 'collection_total_count_changed',
    'collection_row_count_mismatch', 'collection_page_inconsistent',
    'total_count_unverified', 'response_unmapped', 'response_withheld', 'replay_response_not_provided',
    'page_echo_mismatch', 'repeated_page', 'unrequested_page_supplied', 'page_limit_reached',
    'page_plan_limit_exceeded', 'decimal_precision_unverified',
)
# 표현 상한(기술 한도). 운영 쿼터나 호출자 요청 상한(max_pages)이 아니다. 보고 건수가 이 쪽수를 넘기면
# 계획·누락 목록을 만들지 않고 그 쪽을 실패로 기록한다. 건수 문자열은 int 변환 전에 자릿수로 거른다.
MAX_PLANNED_PAGES = 10000
MAX_COUNT_DIGITS = 15
OVERSIZED = object()
OK_RESULT_CODES = {'0', '00', '000'}
TIMESTAMP = re.compile(r'[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]'
                       r'(\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])\Z')
COND_KEY = re.compile(r'cond\[[A-Za-z0-9_]+::[A-Z]+\]\Z')


def positive_int(value):
    return type(value) is int and value >= 1


def valid_timestamp(value):
    """RFC 3339 형식과 달력 날짜(2026-02-30 거부)를 함께 확인한다."""
    if not isinstance(value, str) or not TIMESTAMP.match(value):
        return False
    try:
        date(int(value[:4]), int(value[5:7]), int(value[8:10]))
    except ValueError:
        return False
    return True


def validate_request(source, scope, page_size):
    """출처·범위·페이지 크기를 확인하고 출처 종류를 돌려준다. 오류 문장에 범위 값을 넣지 않는다."""
    if not isinstance(source, str) or source not in SOURCES:
        raise ValueError('지원하지 않는 출처입니다.')
    if not isinstance(scope, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in scope.items()):
        raise ValueError('scope는 문자열 이름과 문자열 값의 객체여야 합니다.')
    kind = SOURCES[source]
    if kind == 'rtms':
        if (set(scope) != {'LAWD_CD', 'DEAL_YMD'} or not re.fullmatch(r'[0-9]{5}', scope['LAWD_CD'])
                or not re.fullmatch(r'[0-9]{4}(0[1-9]|1[0-2])', scope['DEAL_YMD'])):
            raise ValueError('실거래 scope는 5자리 LAWD_CD와 YYYYMM DEAL_YMD만 가집니다.')
    elif any(not COND_KEY.match(k) or not v.strip() or v != v.strip() for k, v in scope.items()):
        # 페이지·인증·응답형식 인자는 커넥터와 어댑터가 정한다. scope에는 필터 조건만 둔다.
        raise ValueError('청약홈 scope에는 cond[필드::연산] 필터만 둡니다.')
    if not positive_int(page_size):
        raise ValueError('page_size는 1 이상의 정수여야 합니다.')
    return KINDS[kind]


def request_unit(source, scope, page, page_size):
    """요청 단위의 정확한 비교 키. 1과 True, '1'과 1을 서로 다르게 본다. 직렬화할 수 없으면 None."""
    try:
        return json.dumps([source, scope, page, page_size], sort_keys=True, ensure_ascii=False)
    except (TypeError, ValueError):
        return None


def as_count(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return None if value < 0 else OVERSIZED if value >= 10 ** MAX_COUNT_DIGITS else value
    if isinstance(value, str) and re.fullmatch(r'[0-9]+', value.strip()):
        digits = value.strip().lstrip('0') or '0'
        return OVERSIZED if len(digits) > MAX_COUNT_DIGITS else int(digits)
    return None


def precision_float(value):
    """PRECISION_FIELDS 값이 JSON 실수(float)로 해석된 곳이 있는지 본다."""
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            if any(isinstance(item.get(name), float) for name in PRECISION_FIELDS):
                return True
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    return False


def reject_constant(_name):
    raise ValueError('NaN·Infinity는 JSON 수로 받지 않는다.')


class _RealToken(float):
    """JSON 실수 토큰을 원형 그대로 잠시 보관한다(loads_source_json 내부용, 결과에 남지 않음)."""

    def __new__(cls, token):
        value = super().__new__(cls, token)
        value.token = token
        return value


def _plain(value):
    if isinstance(value, _RealToken):
        return float(value)
    return [_plain(item) for item in value] if isinstance(value, list) else value


def _source_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError('JSON 객체에 같은 키가 두 번 있습니다.')  # 앞 값을 조용히 버리지 않는다
        if isinstance(value, _RealToken) and key in PRECISION_FIELDS:
            obj[key] = value.token
        else:
            obj[key] = _plain(value)
    return obj


def loads_source_json(text):
    """원천·재생 JSON을 해석한다. PRECISION_FIELDS의 JSON 실수만 원래 토큰의 십진 문자열로 읽는다.

    다른 실수는 일반 float, 정수는 int로 남아 메타데이터 형식 검사가 그대로 동작한다.
    NaN·Infinity와 같은 객체의 중복 키는 ValueError다.
    """
    return _plain(json.loads(text, parse_float=_RealToken, parse_constant=reject_constant,
                             object_pairs_hook=_source_object))


def failure(code, layer, *reasons):
    return {'error': {'code': code, 'layer': layer},
            'reasons': {'collection_request_failed', *(r for r in reasons if r)}}


def page_rows(source_kind, payload):
    """행 목록. 명시적 빈 컨테이너는 [], 구조를 확인할 수 없으면 None."""
    if source_kind == 'odcloud':
        rows = payload.get('data', MISSING)
        return rows if isinstance(rows, list) else None
    items = at(payload, 'response.body.items')
    if items in ('', None) or items == {}:
        return []
    if not isinstance(items, dict) or 'item' not in items:
        return None
    item = items['item']
    return item if isinstance(item, list) else [item] if isinstance(item, dict) else None


def read_page(source, scope, envelope):
    """봉투 하나를 해석한다. 오류면 {'error', 'reasons'}, 아니면 행·건수·반향을 돌려준다."""
    transport = envelope.get('transportError')
    if transport is not None:
        if not isinstance(transport, str) or transport not in TRANSPORT_ERRORS:
            raise ValueError('알 수 없는 transportError입니다.')
        return failure(*TRANSPORT_ERRORS[transport])
    status = envelope.get('httpStatus')
    if type(status) is not int:
        raise ValueError('httpStatus는 정수여야 합니다.')
    if status != 200:
        # 본문은 해석하지 않는다. 원문 오류 문장은 결과에 남기지 않는다.
        code = ('upstream_auth_rejected' if status in (401, 403) else
                'upstream_rate_limited' if status == 429 else 'upstream_unavailable')
        return failure(code, 'http')
    body = envelope.get('body')
    if precision_float(body):
        raise ValueError('본문 객체의 금액·면적이 float입니다. JSON은 loads_source_json으로 읽어 전달하세요.')
    try:
        payload = parse_payload(body.encode('utf-8'), loads_source_json)[1] if isinstance(body, str) else body
    except (ValueError, ET.ParseError, RecursionError):
        return failure('upstream_malformed_response', 'parse')
    if not isinstance(payload, dict):
        return failure('upstream_malformed_response', 'parse', 'response_unmapped')
    if api_error(payload):
        return failure('upstream_business_error', 'business')
    source_kind = SOURCES[source]
    kind = KINDS[source_kind]
    if source_kind == 'rtms' and str(at(payload, 'response.header.resultCode')).strip() not in OK_RESULT_CODES:
        return failure('upstream_malformed_response', 'parse', 'response_unmapped')
    rows = page_rows(source_kind, payload)
    if rows is None or any(not isinstance(row, dict) for row in rows):
        return failure('upstream_malformed_response', 'parse', 'response_unmapped')
    reasons = set()
    if source_kind == 'rtms':
        raw_count = at(payload, 'response.body.totalCount')
    else:
        raw_count = payload.get('matchCount', MISSING)
        if raw_count is MISSING and not scope:
            raw_count = payload.get('totalCount', MISSING)  # 필터가 없을 때만 전체 건수가 일치 건수다
        current = payload.get('currentCount', MISSING)
        if current is not MISSING and as_count(current) != len(rows):
            reasons.add('collection_row_count_mismatch')
    count = None
    if raw_count is MISSING and source_kind == 'odcloud':
        reasons.add('total_count_unverified')  # 행은 보존하되 완전성을 확정하지 않는다
    else:
        count = as_count(raw_count)
        if count is None:
            return failure('upstream_malformed_response', 'parse', 'total_count_unverified')
    echo = (as_count(at(payload, kind['echo_page'])), as_count(at(payload, kind['echo_size'])))
    return {'error': None, 'reasons': reasons, 'rows': rows, 'count': count, 'echo': echo}


def collect_pages(source, scope, fetch, *, page_size=100, max_pages=None):
    """source·scope의 1쪽부터 보고 건수가 요구하는 마지막 쪽까지 차례로 조회한다.

    문제가 생긴 쪽에서 멈추고 남은 쪽은 missingPages로 남긴다. 받은 행은 중복을 합치지 않고 쪽·위치와 함께 보존한다.
    max_pages는 호출자가 정하는 요청 상한이며 기본은 상한 없음이다. 상한 때문에 받지 못한 쪽도 누락이다.
    보고 건수가 MAX_PLANNED_PAGES쪽을 넘기면 그 쪽을 실패로 기록한다(1쪽이면 failed, 이후 쪽이면 partial).
    """
    validate_request(source, scope, page_size)
    if max_pages is not None and not positive_int(max_pages):
        raise ValueError('max_pages는 None 또는 1 이상의 정수여야 합니다.')
    scope = dict(scope)
    reasons, observations, received, digests = set(), [], set(), set()
    error = reported = expected = collected_at = None
    changed = False
    page = 1
    while True:
        envelope = fetch(source, copy.deepcopy(scope), page, page_size)
        if not isinstance(envelope, dict) or request_unit(
                envelope.get('source'), envelope.get('scope'), envelope.get('page'),
                envelope.get('pageSize')) != request_unit(source, scope, page, page_size):
            raise ValueError('전송 응답의 요청 단위가 조회와 다릅니다.')
        outcome = read_page(source, scope, envelope)
        count = outcome.get('count')
        if count is OVERSIZED or (count is not None and count > page_size * MAX_PLANNED_PAGES):
            outcome = failure('upstream_response_too_large', 'parse', 'page_plan_limit_exceeded')
        if outcome['error']:
            error = outcome['error']
            reasons |= outcome['reasons']
            break
        if not valid_timestamp(envelope.get('observedAt')):
            raise ValueError('observedAt은 오프셋이 있는 RFC 3339 시각이어야 합니다.')
        rows, problems = outcome['rows'], set(outcome['reasons'])
        if page == 1:
            reported = count
            expected = None if count is None else max(1, -(-count // page_size))
        elif count != reported:
            changed = True
            problems.add('collection_total_count_changed')
        if outcome['echo'] != (page, page_size):
            problems |= {'collection_page_inconsistent', 'page_echo_mismatch'}
        if reported is not None and len(rows) != max(0, min(page_size, reported - (page - 1) * page_size)):
            problems.add('collection_row_count_mismatch')
        if rows:
            digest = hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()
            if digest in digests:
                problems |= {'collection_page_inconsistent', 'repeated_page'}
            digests.add(digest)
        observations.extend({'row': copy.deepcopy(row), 'page': page, 'position': position}
                            for position, row in enumerate(rows, 1))
        received.add(page)
        collected_at = envelope['observedAt']
        reasons |= problems
        if problems or expected is None or page >= expected:
            break
        if max_pages is not None and page >= max_pages:
            reasons.add('page_limit_reached')
            break
        page += 1
    supplied = getattr(fetch, 'supplied_pages', None)
    if callable(supplied) and any(size != page_size or (expected is not None and number > expected)
                                  for number, size in supplied(source, scope)):
        # 재생 입력에 계획 밖 쪽(다른 크기, 보고 건수보다 뒤의 쪽)이 있으면 완전성을 확정하지 않는다.
        reasons |= {'collection_page_inconsistent', 'unrequested_page_supplied'}
    if not received:
        return {'source': source, 'scope': scope, 'status': 'failed', 'observations': [],
                'pagesExpected': None, 'missingPages': [], 'reportedTotalCount': None, 'rowsReceived': 0,
                'totalCountChanged': False, 'collectedAt': None, 'error': error, 'reasons': sorted(reasons)}
    missing = [] if expected is None else [n for n in range(1, expected + 1) if n not in received]
    if missing:
        reasons.add('collection_page_missing')
    if not missing and reported is not None and len(observations) != reported:
        reasons.add('collection_row_count_mismatch')
    status = 'partial' if reasons else 'empty' if reported == 0 else 'complete'
    return {'source': source, 'scope': scope, 'status': status, 'observations': observations,
            'pagesExpected': expected, 'missingPages': missing, 'reportedTotalCount': reported,
            'rowsReceived': len(observations), 'totalCountChanged': changed, 'collectedAt': collected_at,
            'error': error, 'reasons': sorted(reasons)}


ENTRY_KEYS = {'source', 'scope', 'page', 'pageSize', 'httpStatus', 'body', 'observedAt', 'transportError', 'note'}


class ReplayTransport:
    """합성 묶음의 pages를 source·scope·page·pageSize가 정확히 같은 조회에만 돌려준다.

    HTTP 실패는 httpStatus(200 외 정수)로, 전송 실패는 httpStatus null과 transportError
    (timeout·connection·too_large·withheld)로 적는다. 묶음에 없는 조회는 not_provided 전송 실패가 된다.
    같은 조회 단위가 두 번 있으면 덮어쓰지 않고 ValueError를 낸다.
    """

    def __init__(self, bundle):
        if not isinstance(bundle, dict) or bundle.get('dataOrigin') != 'synthetic':
            raise ValueError('재생 입력에는 dataOrigin: synthetic이 필요합니다.')
        if not isinstance(bundle.get('pages'), list):
            raise ValueError('재생 입력의 pages는 목록이어야 합니다.')
        self._entries, self.requests = {}, []
        for index, entry in enumerate(bundle['pages']):
            where = 'pages[%d]: ' % index
            if not isinstance(entry, dict) or set(entry) - ENTRY_KEYS:
                raise ValueError(where + '알 수 없는 항목이 있습니다.')
            try:
                validate_request(entry.get('source'), entry.get('scope'), entry.get('pageSize'))
            except ValueError as exc:
                raise ValueError(where + str(exc)) from None
            if not positive_int(entry.get('page')):
                raise ValueError(where + 'page는 1 이상의 정수여야 합니다.')
            if not valid_timestamp(entry.get('observedAt')):
                raise ValueError(where + 'observedAt은 오프셋이 있는 RFC 3339 시각이어야 합니다.')
            transport, status = entry.get('transportError'), entry.get('httpStatus')
            if transport is not None:
                if (not isinstance(transport, str) or transport not in TRANSPORT_ERRORS
                        or transport in ('not_provided', 'precision_unverified') or entry.get('body') is not None):
                    raise ValueError(where + '전송 실패는 지원하는 transportError만 적고 body를 두지 않습니다.')
            elif type(status) is not int or not 100 <= status <= 599:
                raise ValueError(where + 'httpStatus 정수 또는 transportError가 필요합니다.')
            if precision_float(entry.get('body')):
                raise ValueError(where + 'body의 금액·면적 실수는 loads_source_json으로 읽어야 합니다.')
            unit = request_unit(entry['source'], entry['scope'], entry['page'], entry['pageSize'])
            if unit in self._entries:
                raise ValueError(where + '같은 source·scope·page·pageSize 조회가 이미 있습니다.')
            self._entries[unit] = copy.deepcopy(entry)

    def __call__(self, source, scope, page, page_size):
        unit = request_unit(source, scope, page, page_size)
        self.requests.append(unit)
        entry = self._entries.get(unit)
        envelope = {'source': source, 'scope': copy.deepcopy(scope), 'page': page, 'pageSize': page_size}
        if entry is None:
            return {**envelope, 'httpStatus': None, 'transportError': 'not_provided', 'body': None, 'observedAt': None}
        return {**envelope, 'httpStatus': entry.get('httpStatus'), 'transportError': entry.get('transportError'),
                'body': copy.deepcopy(entry.get('body')), 'observedAt': entry['observedAt']}

    def supplied_pages(self, source, scope):
        """이 source·scope에 대해 묶음이 가진 (page, pageSize) 목록."""
        return sorted((entry['page'], entry['pageSize']) for entry in self._entries.values()
                      if entry['source'] == source and entry['scope'] == scope)

    def unused(self):
        """한 번도 조회되지 않은 묶음 항목의 요청 단위."""
        asked = set(self.requests)
        return [{key: entry[key] for key in ('source', 'scope', 'page', 'pageSize')}
                for unit, entry in self._entries.items() if unit not in asked]


NOT_SENT = {'invalid_params', 'missing_key', 'invalid_endpoint', 'missing_request_params'}


class LiveProbeTransport:
    """수동 실호출 어댑터. 기본값으로 만들어지지 않으며 키는 호출자가 직접 읽어 넘긴다.

    요청은 probe_apis.run_probe가 보낸다. 허용 호스트·리다이렉트 차단·제한 시간·응답 크기 상한·인증값 정제는
    그 함수의 현재 규칙을 그대로 따르며 이 어댑터는 그 값을 바꾸지 않는다. 본문은 run_probe가 만든 정제 텍스트
    사본을 넘겨 재생과 같은 파서(loads_source_json)를 거치게 한다. float로 바뀐 해석 사본은 쓰지 않는다.
    정제기가 JSON을 다시 직렬화했고(원 해시≠정제 해시) 금액·면적 항목이 JSON 실수였다면 그 쪽 전체를
    decimal_precision_unverified로 보류한다. 행 값만 바꾸면 결측·오류 값과 섞이므로 쪽 단위로 보류한다.
    요청 전 설정 오류(키 누락·허용 밖 주소 등)는 수집 결과로 바꾸지 않고 RuntimeError로 중단한다.
    """

    def __init__(self, specs, keys, *, probe=run_probe):
        self._specs, self._keys, self._probe = specs, keys, probe

    def __call__(self, source, scope, page, page_size):
        kind = validate_request(source, scope, page_size)
        overrides = {**scope, kind['page']: page, kind['size']: page_size}
        result, safe_text, safe_payload = self._probe(source, self._specs[source], self._keys, overrides)
        status = result.get('status')
        if status in NOT_SENT:
            raise RuntimeError('요청 전 설정 오류: ' + status)
        envelope = {'source': source, 'scope': copy.deepcopy(scope), 'page': page, 'pageSize': page_size,
                    'httpStatus': result.get('http_status'), 'transportError': None, 'body': None,
                    'observedAt': result.get('checked_at')}
        if status == 'network_error':
            # error는 형식 이름만 담는다(error_diagnostic). 시간 초과만 따로 구분한다.
            envelope.update(httpStatus=None, transportError='timeout' if 'timeout' in str(result.get('error', '')).lower() else 'connection')
        elif status == 'response_too_large':
            envelope['transportError'] = 'too_large'
        elif status == 'redaction_failed' and result.get('http_status') == 200:
            envelope['transportError'] = 'withheld'
        elif (result.get('http_status') == 200 and result.get('format') == 'json'
              and result.get('sanitized_response_sha256') != result.get('response_sha256')
              and precision_float(safe_payload)):
            envelope['transportError'] = 'precision_unverified'
        else:
            envelope['body'] = safe_text  # 해석 실패·보류면 None이며 형식 오류로 기록된다
        return envelope
