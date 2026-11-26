#!/usr/bin/env python3
"""카카오 로컬 주소 검색으로 단지 도로명주소와 공고 소재지의 대표 좌표를 확인한다(Q-39).

외부 전송과 시계는 주입받으며 기본 네트워크 호출을 스스로 실행하지 않는다.
결과가 정확히 하나이고 법정동 코드·도로명·건물번호가 단지와 일치할 때만 좌표를 확정한다.
키 누락·복수 결과·주소 불일치·일원/블록 표기·조회 실패·호출 상한은 예외 대신 좌표 미확인으로 둔다.
"""
import copy
import http.client
import json
import os
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Callable, Optional
from urllib import error as urllib_error, parse as urllib_parse, request as urllib_request

from probe_apis import NoRedirect

KAKAO_LOCAL_ADDRESS_URL = 'https://dapi.kakao.com/v2/local/search/address.json'
KAKAO_ALLOWED_HOST = 'dapi.kakao.com'
KAKAO_SOURCE_ID = 'kakao_address'
MAX_KAKAO_RESPONSE_BYTES = 64 * 1024
DEFAULT_KAKAO_TIMEOUT = 10
DEFAULT_KAKAO_REQUEST_LIMIT = 30
DEFAULT_KAKAO_CACHE_TTL_DAYS = 7

PROVINCE_ALIASES = {
    '서울': '서울특별시', '서울시': '서울특별시',
    '부산': '부산광역시', '부산시': '부산광역시',
    '대구': '대구광역시', '대구시': '대구광역시',
    '인천': '인천광역시', '인천시': '인천광역시',
    '광주': '광주광역시', '광주시': '광주광역시',
    '대전': '대전광역시', '대전시': '대전광역시',
    '울산': '울산광역시', '울산시': '울산광역시',
    '세종': '세종특별자치시', '세종시': '세종특별자치시',
    '경기': '경기도',
    '강원': '강원특별자치도', '강원도': '강원특별자치도',
    '충북': '충청북도', '충남': '충청남도',
    '전북': '전북특별자치도', '전라북도': '전북특별자치도',
    '전남': '전라남도',
    '경북': '경상북도', '경남': '경상남도',
    '제주': '제주특별자치도', '제주도': '제주특별자치도',
}

# 여러 지점이나 미분할 필지군을 가리키는 공고 주소 표기(Q-39).
AMBIGUOUS_ADDRESS_PATTERN = re.compile(
    r'(?:일원|일대|주변|부근|외\s*[0-9]+\s*필지|외\s*필지|등\s*[0-9]+\s*필지|번지\s*외|'
    r'[0-9A-Za-z가-힣]+\s*(?:블록|블럭|BL|블록내|구역|공구)(?=[\s,()·]|$))',
    re.IGNORECASE,
)
# 도로명 + 건물본번(-건물부번) 추출. 괄호 안 참고항목은 호출 전에 분리한다.
# 4.19로·3.1대로·G밸리로 등 실제 도로명 표기를 허용하되 한글을 1자 이상 포함해야 하며 지하 주소는 제외한다.
ROAD_ADDRESS_PATTERN = re.compile(
    r'(?:^|[\s,])((?=[가-힣A-Za-z0-9·.]*[가-힣])[가-힣A-Za-z0-9·.]+(?:대로|로|길))\s+0*([1-9][0-9]*)(?:-0*([0-9]+))?(?=[\s,(]|$)'
)
# 법정동·읍·면·리 + 지번 추출.
PARCEL_ADDRESS_PATTERN = re.compile(
    r'(?:^|[\s,])([가-힣0-9]+(?:동|가|읍|면|리))\s+(산\s*)?0*([1-9][0-9]*)(?:-0*([0-9]+))?(?:번지)?(?=[\s,(]|$)'
)
COORD_DECIMAL_PATTERN = re.compile(r'[0-9]{2,3}(?:\.[0-9]{1,16})?')
B_CODE_PATTERN = re.compile(r'[0-9]{10}')


class KakaoCoordinateBudgetExceeded(Exception):
    """실행당 카카오 로컬 호출 상한에 도달했다."""


def normalize_text(value) -> str:
    if not isinstance(value, str):
        return ''
    return ' '.join(unicodedata.normalize('NFC', value).strip().split())


def canonical_province(token: str) -> str:
    return PROVINCE_ALIASES.get(token, token)


def normalize_road_name(value) -> Optional[str]:
    text = normalize_text(value)
    if not text:
        return None
    compact = text.replace(' ', '')
    if not re.fullmatch(r'(?=[가-힣A-Za-z0-9·.]*[가-힣])[가-힣A-Za-z0-9·.]+(?:대로|로|길)', compact):
        return None
    return compact


def parse_positive_int(value) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str):
        text = value.strip()
        if re.fullmatch(r'[0-9]{1,10}', text):
            number = int(text)
            return number if number > 0 else None
    return None


def parse_nonnegative_int(value) -> Optional[int]:
    if value is None or (isinstance(value, str) and not value.strip()):
        return 0
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, str):
        text = value.strip()
        if re.fullmatch(r'[0-9]{1,10}', text):
            return int(text)
    return None


def strip_parenthetical_notes(address: str) -> str:
    """도로명주소 뒤의 괄호 참고항목('(갈현동, 단지명)')을 제거한다."""
    text = normalize_text(address)
    cleaned = re.sub(r'\([^()]*\)', ' ', text)
    return ' '.join(cleaned.split())


def is_ambiguous_area_address(address: str) -> bool:
    """'일원'·'블록'·'외 N필지'처럼 단일 지점이 아닌 주소인지 판정한다.

    도로명주소 뒤의 괄호 참고항목('(갈현동, S6블록)')은 단일 건물 주소를 무효화하지 않는다.
    """
    text = strip_parenthetical_notes(address)
    if not text:
        return True
    return AMBIGUOUS_ADDRESS_PATTERN.search(text) is not None


def extract_road_spec(address: str) -> Optional[dict]:
    """주소 문자열에서 유일한 도로명·건물번호를 추출한다. 복수 후보나 모호 표기는 None."""
    if is_ambiguous_area_address(address):
        return None
    core = strip_parenthetical_notes(address)
    matches = list(ROAD_ADDRESS_PATTERN.finditer(core))
    if len(matches) != 1:
        return None
    match = matches[0]
    road_name = normalize_road_name(match.group(1))
    main_no = parse_positive_int(match.group(2))
    sub_no = parse_nonnegative_int(match.group(3))
    if road_name is None or main_no is None or sub_no is None:
        return None
    return {'roadName': road_name, 'mainNo': main_no, 'subNo': sub_no}


def extract_parcel_spec(address: str) -> Optional[dict]:
    """주소 문자열에서 유일한 법정동·지번(본번·부번)을 추출한다. 복수 후보나 모호 표기는 None."""
    if is_ambiguous_area_address(address):
        return None
    core = strip_parenthetical_notes(address)
    matches = list(PARCEL_ADDRESS_PATTERN.finditer(core))
    if len(matches) != 1:
        return None
    match = matches[0]
    locality_token = match.group(1)
    is_mountain = bool(match.group(2))
    main_no = parse_positive_int(match.group(3))
    sub_no = parse_nonnegative_int(match.group(4))
    if not locality_token or main_no is None or sub_no is None:
        return None
    return {
        'localityToken': locality_token,
        'isMountain': is_mountain,
        'mainNo': main_no,
        'subNo': sub_no,
    }


def format_road_query(sgg_full_name: str, road_name: str, main_no: int, sub_no: int = 0) -> Optional[str]:
    """카카오 로컬 조회용 정규 도로명주소 문자열('시·군·구 + 도로명 + 건물번호')을 만든다."""
    prefix = normalize_text(sgg_full_name)
    road = normalize_road_name(road_name)
    if not prefix or road is None or not isinstance(main_no, int) or main_no <= 0:
        return None
    if not isinstance(sub_no, int) or sub_no < 0:
        return None
    tokens = prefix.split()
    tokens[0] = canonical_province(tokens[0])
    number = f'{main_no}-{sub_no}' if sub_no > 0 else str(main_no)
    return f'{" ".join(tokens)} {road} {number}'


def coordinate_cache_key(
    locality_code: str,
    *,
    road_name: Optional[str] = None,
    main_no: Optional[int] = None,
    sub_no: int = 0,
    parcel_key: Optional[str] = None,
) -> Optional[str]:
    if not isinstance(locality_code, str) or not B_CODE_PATTERN.fullmatch(locality_code):
        return None
    if road_name is not None and main_no is not None:
        road = normalize_road_name(road_name)
        if road is None or main_no <= 0 or sub_no < 0:
            return None
        return f'road:{locality_code}:{road}:{main_no}:{sub_no}'
    if parcel_key:
        return f'parcel:{locality_code}:{parcel_key}'
    return None


def _parse_wgs84_point(item) -> Optional[tuple[str, str]]:
    if not isinstance(item, dict):
        return None
    x_raw, y_raw = item.get('x'), item.get('y')
    if not isinstance(x_raw, str) or not isinstance(y_raw, str):
        return None
    x, y = x_raw.strip(), y_raw.strip()
    if not (COORD_DECIMAL_PATTERN.fullmatch(x) and COORD_DECIMAL_PATTERN.fullmatch(y)):
        return None
    try:
        lon, lat = Decimal(x), Decimal(y)
    except InvalidOperation:
        return None
    if not (Decimal('124') <= lon <= Decimal('132') and Decimal('33') <= lat <= Decimal('39.5')):
        return None
    return y, x  # (latitude, longitude)


def _b_code_matches(observed_b_code: str, expected_locality_code: str, *, expected_locality_type: str = 'dong',
                    expected_sub_b_code: Optional[str] = None) -> bool:
    if not isinstance(observed_b_code, str) or not B_CODE_PATTERN.fullmatch(observed_b_code):
        return False
    if not isinstance(expected_locality_code, str) or not B_CODE_PATTERN.fullmatch(expected_locality_code):
        return False
    if expected_sub_b_code is not None:
        return observed_b_code == expected_sub_b_code
    if expected_locality_type == 'dong':
        return observed_b_code == expected_locality_code
    if expected_locality_type in ('eup', 'myeon'):
        return observed_b_code == expected_locality_code or observed_b_code[:8] + '00' == expected_locality_code
    return False


def verify_kakao_response(
    envelope: dict,
    *,
    expected_locality_code: str,
    expected_locality_type: str = 'dong',
    expected_sub_b_code: Optional[str] = None,
    expected_road: Optional[dict] = None,
    expected_parcel: Optional[dict] = None,
) -> dict:
    """카카오 로컬 주소 검색 응답 봉투를 Q-39 기준으로 엄격히 검증한다."""
    if not isinstance(envelope, dict):
        return {'status': 'failed', 'reasonCode': 'coordinate_lookup_failed', 'coordinates': None, 'observedAt': None}
    observed_at = envelope.get('observedAt') if isinstance(envelope.get('observedAt'), str) else None
    transport_error = envelope.get('transportError')
    if transport_error is not None:
        return {'status': 'failed', 'reasonCode': 'coordinate_lookup_failed', 'coordinates': None, 'observedAt': observed_at}
    http_status = envelope.get('httpStatus')
    if http_status in (401, 403):
        return {'status': 'failed', 'reasonCode': 'coordinate_auth_rejected', 'coordinates': None, 'observedAt': observed_at}
    if http_status == 429:
        return {'status': 'failed', 'reasonCode': 'coordinate_rate_limited', 'coordinates': None, 'observedAt': observed_at}
    if http_status != 200:
        return {'status': 'failed', 'reasonCode': 'coordinate_lookup_failed', 'coordinates': None, 'observedAt': observed_at}

    body = envelope.get('body')
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except ValueError:
            return {'status': 'failed', 'reasonCode': 'coordinate_lookup_failed', 'coordinates': None, 'observedAt': observed_at}
    if not isinstance(body, dict):
        return {'status': 'failed', 'reasonCode': 'coordinate_lookup_failed', 'coordinates': None, 'observedAt': observed_at}

    meta = body.get('meta')
    documents = body.get('documents')
    if (not isinstance(meta, dict) or not isinstance(documents, list)
            or type(meta.get('total_count')) is not int or meta['total_count'] < 0
            or type(meta.get('is_end')) is not bool):
        return {'status': 'failed', 'reasonCode': 'coordinate_lookup_failed', 'coordinates': None, 'observedAt': observed_at}

    if meta['total_count'] == 0 or len(documents) == 0:
        return {'status': 'unverified', 'reasonCode': 'coordinate_not_found', 'coordinates': None, 'observedAt': observed_at}
    if meta['total_count'] != 1 or not meta['is_end'] or len(documents) != 1:
        return {'status': 'unverified', 'reasonCode': 'coordinate_ambiguous_multiple', 'coordinates': None, 'observedAt': observed_at}

    doc = documents[0]
    if not isinstance(doc, dict) or doc.get('address_type') not in ('ROAD_ADDR', 'REGION_ADDR'):
        return {'status': 'unverified', 'reasonCode': 'coordinate_type_unverified', 'coordinates': None, 'observedAt': observed_at}

    addr = doc.get('address') if isinstance(doc.get('address'), dict) else None
    road = doc.get('road_address') if isinstance(doc.get('road_address'), dict) else None

    b_code = addr.get('b_code') if addr else None
    if not _b_code_matches(b_code, expected_locality_code, expected_locality_type=expected_locality_type,
                           expected_sub_b_code=expected_sub_b_code):
        return {'status': 'unverified', 'reasonCode': 'coordinate_region_mismatch', 'coordinates': None, 'observedAt': observed_at}

    if expected_road is not None:
        if road is None or road.get('underground_yn') == 'Y':
            return {'status': 'unverified', 'reasonCode': 'coordinate_building_mismatch', 'coordinates': None, 'observedAt': observed_at}
        obs_road = normalize_road_name(road.get('road_name'))
        obs_main = parse_positive_int(road.get('main_building_no'))
        obs_sub = parse_nonnegative_int(road.get('sub_building_no'))
        if (obs_road != expected_road['roadName']
                or obs_main != expected_road['mainNo']
                or obs_sub != expected_road['subNo']):
            return {'status': 'unverified', 'reasonCode': 'coordinate_building_mismatch', 'coordinates': None, 'observedAt': observed_at}
        point = _parse_wgs84_point(road) or _parse_wgs84_point(doc)
        ref_part = f'road:{obs_road}:{obs_main}-{obs_sub}'
    elif expected_parcel is not None:
        if addr is None:
            return {'status': 'unverified', 'reasonCode': 'coordinate_parcel_mismatch', 'coordinates': None, 'observedAt': observed_at}
        obs_mountain = addr.get('mountain_yn')
        obs_main = parse_positive_int(addr.get('main_address_no'))
        obs_sub = parse_nonnegative_int(addr.get('sub_address_no'))
        if (obs_mountain not in ('Y', 'N')
                or (obs_mountain == 'Y') != bool(expected_parcel['isMountain'])
                or obs_main != expected_parcel['mainNo']
                or obs_sub != expected_parcel['subNo']):
            return {'status': 'unverified', 'reasonCode': 'coordinate_parcel_mismatch', 'coordinates': None, 'observedAt': observed_at}
        point = _parse_wgs84_point(addr) or _parse_wgs84_point(doc)
        land_tag = '산' if expected_parcel['isMountain'] else ''
        ref_part = f'parcel:{land_tag}{obs_main}-{obs_sub}'
    else:
        return {'status': 'unverified', 'reasonCode': 'coordinate_target_unverified', 'coordinates': None, 'observedAt': observed_at}

    if point is None:
        return {'status': 'unverified', 'reasonCode': 'coordinate_invalid', 'coordinates': None, 'observedAt': observed_at}

    latitude, longitude = point
    stamp = observed_at or datetime.now(timezone.utc).isoformat()
    reference = f'bjd:{b_code}|{ref_part}|observedAt:{stamp}'
    return {
        'status': 'confirmed',
        'reasonCode': None,
        'observedAt': stamp,
        'bCode': b_code,
        'coordinates': {
            'latitude': latitude,
            'longitude': longitude,
            'evidence': {'source': KAKAO_SOURCE_ID, 'reference': reference},
        },
    }


def live_kakao_transport(api_key: Optional[str] = None, *, opener=None, timeout: int = DEFAULT_KAKAO_TIMEOUT) -> Optional[Callable]:
    """카카오 로컬 주소 검색 실호출 전송을 만든다. 키가 없으면 예외 대신 None을 돌려준다."""
    key = (api_key if api_key is not None else os.environ.get('KAKAO_REST_API_KEY') or '').strip()
    if not key:
        return None
    parsed = urllib_parse.urlsplit(KAKAO_LOCAL_ADDRESS_URL)
    if parsed.scheme != 'https' or parsed.hostname != KAKAO_ALLOWED_HOST:
        raise ValueError('허용되지 않은 카카오 로컬 엔드포인트입니다.')
    transport = opener or urllib_request.build_opener(urllib_request.ProxyHandler({}), NoRedirect())

    def fetch(query: str) -> dict:
        observed_at = datetime.now(timezone.utc).isoformat()
        clean = normalize_text(query)
        if not clean:
            return {'httpStatus': None, 'transportError': 'invalid_query', 'body': None, 'observedAt': observed_at}
        qs = urllib_parse.urlencode({'query': clean, 'analyze_type': 'exact', 'size': 2})
        req = urllib_request.Request(
            f'{KAKAO_LOCAL_ADDRESS_URL}?{qs}',
            method='GET',
            headers={
                'Authorization': 'KakaoAK ' + key,
                'Accept': 'application/json',
                'User-Agent': 'HomeCierge-Worker/0.1',
            },
        )
        try:
            with transport.open(req, timeout=timeout) as response:
                status = response.status
                raw = response.read(MAX_KAKAO_RESPONSE_BYTES + 1)
                if len(raw) > MAX_KAKAO_RESPONSE_BYTES:
                    return {'httpStatus': status, 'transportError': 'too_large', 'body': None, 'observedAt': observed_at}
                text = raw.decode('utf-8-sig')
                return {'httpStatus': status, 'transportError': None, 'body': text, 'observedAt': observed_at}
        except urllib_error.HTTPError as exc:
            code = exc.code
            exc.close()
            return {'httpStatus': code, 'transportError': None, 'body': None, 'observedAt': observed_at}
        except TimeoutError:
            return {'httpStatus': None, 'transportError': 'timeout', 'body': None, 'observedAt': observed_at}
        except (OSError, http.client.HTTPException, ValueError):
            return {'httpStatus': None, 'transportError': 'connection', 'body': None, 'observedAt': observed_at}

    return fetch


def resolve_complex_coordinates(
    requests: list[dict],
    kakao_fetch: Optional[Callable],
    *,
    allow_runtime: bool = True,
    allow_storage: bool = False,
    cache_entries: Optional[dict] = None,
    max_calls: int = DEFAULT_KAKAO_REQUEST_LIMIT,
    cache_ttl_days: int = DEFAULT_KAKAO_CACHE_TTL_DAYS,
    now: Optional[Callable[[], datetime]] = None,
) -> dict:
    """대상 공고와 주변 단지 목록의 대표 좌표를 Q-39 규칙으로 확인한다.

    각 request 항목:
      complexId, localityCode, localityType('dong'|'eup'|'myeon'), subBCode(선택),
      sggFullName, roadName/roadMain/roadSub 또는 noticeAddress.
    allow_storage=False이면 공유 캐시를 읽거나 쓰지 않고 실행 메모리에서만 좌표를 반환한다.
    """
    clock_now = now or (lambda: datetime.now(timezone.utc))
    usable_cache = cache_entries if (allow_storage and isinstance(cache_entries, dict)) else {}
    results = {}
    new_cache_entries = []
    calls = 0
    cache_hits = 0
    budget_reached = False
    stopped_error = None
    memo = {}

    for item in requests:
        complex_id = item['complexId']
        locality_code = item.get('localityCode')
        locality_type = item.get('localityType', 'dong')
        sub_b_code = item.get('subBCode')
        sgg_full_name = item.get('sggFullName') or ''

        expected_road = None
        expected_parcel = None
        query = None

        if item.get('roadName') is not None and item.get('roadMain') is not None:
            road_name = normalize_road_name(item['roadName'])
            main_no = parse_positive_int(item['roadMain'])
            sub_no = parse_nonnegative_int(item.get('roadSub'))
            if road_name and main_no is not None and sub_no is not None:
                expected_road = {'roadName': road_name, 'mainNo': main_no, 'subNo': sub_no}
                query = format_road_query(sgg_full_name, road_name, main_no, sub_no)
        elif item.get('noticeAddress'):
            notice_addr = item['noticeAddress']
            if is_ambiguous_area_address(notice_addr):
                results[complex_id] = {
                    'status': 'unverified', 'reasonCode': 'address_ambiguous_area',
                    'coordinates': None, 'observedAt': None, 'cacheHit': False,
                }
                continue
            expected_road = extract_road_spec(notice_addr)
            if expected_road is not None:
                query = format_road_query(sgg_full_name, expected_road['roadName'],
                                          expected_road['mainNo'], expected_road['subNo'])
            else:
                expected_parcel = extract_parcel_spec(notice_addr)
                if expected_parcel is not None and sgg_full_name:
                    land_tag = '산 ' if expected_parcel['isMountain'] else ''
                    num = (f'{expected_parcel["mainNo"]}-{expected_parcel["subNo"]}'
                           if expected_parcel['subNo'] > 0 else str(expected_parcel['mainNo']))
                    tokens = normalize_text(sgg_full_name).split()
                    if tokens:
                        tokens[0] = canonical_province(tokens[0])
                        query = f'{" ".join(tokens)} {expected_parcel["localityToken"]} {land_tag}{num}'

        if query is None or not locality_code:
            reason = 'address_ambiguous_area' if item.get('noticeAddress') else 'road_address_missing'
            results[complex_id] = {
                'status': 'unverified', 'reasonCode': reason,
                'coordinates': None, 'observedAt': None, 'cacheHit': False,
            }
            continue

        parcel_tag = None
        if expected_parcel is not None:
            land_prefix = '산' if expected_parcel['isMountain'] else ''
            parcel_tag = f'{land_prefix}{expected_parcel["mainNo"]}-{expected_parcel["subNo"]}'
        cache_key = coordinate_cache_key(
            locality_code,
            road_name=expected_road['roadName'] if expected_road else None,
            main_no=expected_road['mainNo'] if expected_road else None,
            sub_no=expected_road['subNo'] if expected_road else 0,
            parcel_key=parcel_tag,
        )

        # 1. 저장·재사용이 허용된 경우에만 공유 캐시 적중을 확인한다.
        if allow_storage and cache_key and cache_key in usable_cache:
            cached = usable_cache[cache_key]
            cached_coord = cached.get('coordinates') if isinstance(cached, dict) else None
            if (isinstance(cached_coord, dict) and isinstance(cached_coord.get('latitude'), str)
                    and isinstance(cached_coord.get('longitude'), str)
                    and isinstance(cached_coord.get('evidence'), dict)):
                cache_hits += 1
                results[complex_id] = {
                    'status': 'confirmed', 'reasonCode': None,
                    'coordinates': copy.deepcopy(cached_coord),
                    'observedAt': cached.get('observedAt'),
                    'cacheHit': True,
                }
                continue

        # 2. 런타임 권한 및 키 확인. 키 없음은 실패가 아니라 좌표 미확인 상태다.
        if not allow_runtime:
            results[complex_id] = {
                'status': 'unverified', 'reasonCode': 'coordinate_source_restricted',
                'coordinates': None, 'observedAt': None, 'cacheHit': False,
            }
            continue
        if kakao_fetch is None:
            results[complex_id] = {
                'status': 'unverified', 'reasonCode': 'kakao_key_missing',
                'coordinates': None, 'observedAt': None, 'cacheHit': False,
            }
            continue

        # 3. 같은 실행 안의 동일 질의 메모이제이션
        memo_key = (query, locality_code, locality_type, sub_b_code,
                    tuple(sorted(expected_road.items())) if expected_road else None,
                    tuple(sorted(expected_parcel.items())) if expected_parcel else None)
        if memo_key in memo:
            results[complex_id] = copy.deepcopy(memo[memo_key])
            continue

        if stopped_error is not None:
            results[complex_id] = {
                'status': 'failed', 'reasonCode': stopped_error,
                'coordinates': None, 'observedAt': None, 'cacheHit': False,
            }
            continue

        if calls >= max_calls:
            budget_reached = True
            results[complex_id] = {
                'status': 'unverified', 'reasonCode': 'coordinate_budget_exceeded',
                'coordinates': None, 'observedAt': None, 'cacheHit': False,
            }
            continue

        try:
            calls += 1
            envelope = kakao_fetch(query)
        except KakaoCoordinateBudgetExceeded:
            budget_reached = True
            calls -= 1
            results[complex_id] = {
                'status': 'unverified', 'reasonCode': 'coordinate_budget_exceeded',
                'coordinates': None, 'observedAt': None, 'cacheHit': False,
            }
            continue
        except (AttributeError, KeyError, OSError, RuntimeError, TypeError, ValueError, http.client.HTTPException):
            # 전송 오류는 좌표 미확인(조회 실패)으로 남긴다. 임대 상실 등 BaseException 계열 중단 신호는 잡지 않는다.
            envelope = {'httpStatus': None, 'transportError': 'connection', 'body': None, 'observedAt': None}

        verified = verify_kakao_response(
            envelope,
            expected_locality_code=locality_code,
            expected_locality_type=locality_type,
            expected_sub_b_code=sub_b_code,
            expected_road=expected_road,
            expected_parcel=expected_parcel,
        )
        verified['cacheHit'] = False
        if verified['reasonCode'] in ('coordinate_auth_rejected', 'coordinate_rate_limited'):
            stopped_error = verified['reasonCode']
        memo[memo_key] = verified
        results[complex_id] = copy.deepcopy(verified)

        if allow_storage and verified['status'] == 'confirmed' and cache_key:
            observed_dt = clock_now()
            observed_iso = verified['observedAt'] or observed_dt.isoformat()
            try:
                parsed_obs = datetime.fromisoformat(observed_iso.replace('Z', '+00:00'))
            except ValueError:
                parsed_obs = observed_dt
                observed_iso = observed_dt.isoformat()
            expires_iso = (parsed_obs + timedelta(days=max(1, min(90, int(cache_ttl_days))))).isoformat()
            new_cache_entries.append({
                'complexKey': cache_key,
                'cacheKind': 'kakao_road_coordinate',
                'sourceIds': [KAKAO_SOURCE_ID],
                'observedAt': observed_iso,
                'expiresAt': expires_iso,
                'entryData': {
                    'coordinates': copy.deepcopy(verified['coordinates']),
                    'bCode': verified.get('bCode'),
                    'observedAt': observed_iso,
                },
            })

    return {
        'results': results,
        'calls': calls,
        'cacheHits': cache_hits,
        'budgetReached': budget_reached,
        'newCacheEntries': new_cache_entries,
    }


def strip_kakao_coordinates(evidence: dict) -> dict:
    """카카오 좌표의 저장·재사용이 허용되지 않을 때 저장용 근거에서 좌표를 제거한다."""
    cleaned = copy.deepcopy(evidence)
    for complex_row in cleaned.get('complexes') or []:
        coord = complex_row.get('coordinates') if isinstance(complex_row, dict) else None
        source = (coord.get('evidence') or {}).get('source') if isinstance(coord, dict) else None
        if source == KAKAO_SOURCE_ID:
            complex_row.pop('coordinates', None)
    return cleaned
