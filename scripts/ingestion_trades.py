#!/usr/bin/env python3
"""국토교통부 아파트 매매·분양권·입주권 거래행을 정규화하고 계약일 범위를 정한다(BE-02).

순수 함수만 둔다. 네트워크·인증값·파일·현재 시계를 사용하지 않으며 수집과 CLI 조합은 호출자가 맡는다.

계약일 범위 — trade_period(as_of, start=None, end=None)
    as_of는 조회일(YYYY-MM-DD)이며 필수다. 기준일을 현재 시계에서 추정하지 않는다.
    시작·종료일을 모두 생략하면 PRD §7.2.5의 '조회일까지 최근 1년'(양 끝 포함)이다.
    예: 2026-11-10 → 2025-11-11~2026-11-10, 2025-11~2026-11의 13개 계약월(진행 중인 당월 포함).
    달력 1년(전년 같은 날짜의 다음 날)과 고정 365일(조회일 − 364일)이 다른 시작일을 내면
    윤일 규칙(D-02)에 따라 결과가 달라지므로 값 없이 decision_required로 보류한다.
    조회일이 2월 29일이어서 전년 같은 날짜가 없는 경우도 같다. 두 방식이 같은 날을 내면 진행한다.
    시작·종료일을 함께 넘기면 사용자가 확인한 기간(user_confirmed)으로 처리한다. 윤일이 걸쳐도 쓴다.
    존재하지 않는 날짜, 한쪽만 지정, 시작>종료, 종료>조회일은 ValueError다.

거래행 — normalize_trade(source, observation, region_code, month, period, trade_kinds)
    source는 'apt_trade'(매매) 또는 'apt_rights'(분양권전매: 분양권·입주권)이다.
    observation은 {'row': dict, 'page': int, 'position': int(1부터)}이고 행 하나를 정규화한다.
    region_code·month는 이 행을 받은 요청의 LAWD_CD(5자리)·DEAL_YMD(YYYYMM)이며 제품 지역이 아니다.
    period는 status가 confirmed인 trade_period 결과, trade_kinds는 분석에 포함한 거래 종류다.
    호출 계약 위반은 ValueError이고, 행 자체의 결측·오류는 결과의 issues로 기록한다.
    같은 값의 행도 위치별로 따로 정규화한다. 중복 제거·병합을 하지 않는다.

행 처리 결과(disposition)는 다음 셋이다. 어느 것도 비교 승인이 아니다.
    excluded            제외. 합의된 근거로 증명된 독립 제외 사유가 있다: 확인된 계약일 범위 밖
                        (outside_contract_period), 해제 표시 'O' 또는 날짜 형식의 해제일(cancelled_trade),
                        분석에 포함하지 않은 종류(trade_kind_not_included). 다른 값의 결측·오류가 있어도
                        제외를 번복하지 않으며 그 결측은 issues에 함께 남긴다.
    held                보류. 제외 사유가 증명되지 않았고 이 단계에서 판정할 수 없다. 필수값 결측·형식 오류,
                        요청 지역·계약월과 행 값의 불일치, 해제 여부·권리 구분 미확인이 issues에 있다.
    follow_up_required  후속대응 필요. 이 단계의 검사는 통과했으나 지역 소속·단지 연결·공급면적 대응을
                        후속 단계에서 확인해야 한다(pendingReasons). 비교 후보로 승인된 것이 아니다.

전용면적(excluUseAr)은 exclusiveArea로만 두고 공급면적으로 대체하지 않는다. supplyArea는 항상
unverified다. 금액은 만원 원문을 원 단위 십진 문자열로 바꾸고 원문·단위를 함께 남긴다.
식별자는 출처 명세에 있는 필드 중 실제 행에 있는 값만 그대로 옮긴다. 코드를 이어 붙이거나 이름으로
새 식별자를 만들지 않는다. 층·건축년·거래유형은 표시용 attributes이며 판정에 쓰지 않는다.
원문 행 전체는 복제하지 않는다. 허용 목록의 필드만, JSON 스칼라(문자열·정수·유한 실수·참거짓·null) 원값만
내보낸다. 객체·배열·유한하지 않은 실수는 값을 내보내지 않고 withheldFields(식별자·표시 필드), 상태
non_scalar, 또는 issues의 detail(non_scalar_value)로 남긴다. 쪽·행 위치는 provenance에 남긴다.

해제는 해제여부 'O' 또는 실제 날짜 형식의 해제일(YY.MM.DD, YYYY-MM-DD)로만 확정한다. 'O'는 해제일 형식과
무관한 독립 제외 근거다. 'O'가 없고 해제일이 공백이 아닌데 날짜로 읽히지 않으면 해제 여부를 미확인으로 보류한다.
"""
import math
import re
from datetime import date, timedelta

NORMALIZER_VERSION = 'ingestion-trades/v0'
TRADE_KINDS = ('sale', 'presale_right', 'occupancy_right')
SOURCE_KINDS = {'apt_trade': ('sale',), 'apt_rights': ('presale_right', 'occupancy_right')}
PERIOD_SOURCES = ('default_recent_year', 'user_confirmed')
DEFAULT_PERIOD_DAYS = 365
LEAP_DAY_DECISION = 'D-02'

# 공식 명세 출력 목록(docs/api/be-01-evidence.md §2.3·§6)의 단지·위치 필드. 행에 있는 것만 옮긴다.
IDENTIFIER_FIELDS = {
    'apt_trade': ('aptNm', 'aptSeq', 'aptDong', 'sggCd', 'umdCd', 'umdNm', 'landCd', 'bonbun', 'bubun',
                  'jibun', 'roadNm', 'roadNmSggCd', 'roadNmCd', 'roadNmSeq', 'roadNmbCd',
                  'roadNmBonbun', 'roadNmBubun'),
    'apt_rights': ('aptNm', 'sggCd', 'sggNm', 'umdNm', 'jibun'),
}
ATTRIBUTE_FIELDS = {
    'apt_trade': ('floor', 'buildYear', 'rgstDate', 'dealingGbn'),
    'apt_rights': ('floor', 'dealingGbn'),
}
DATE_FIELDS = ('dealYear', 'dealMonth', 'dealDay')
# 정규화 단계에서 확인하지 않는 후속 판정. 값은 분석 결과 계약 v0의 사유 코드다.
PENDING_REASONS = ('region_membership_unverified', 'complex_link_pending', 'supply_area_correspondence_missing')
WON_PER_MAN_WON = 10000

_ISO_DATE = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')
_YEAR_MONTH = re.compile(r'[0-9]{4}(?:0[1-9]|1[0-2])')
_REGION = re.compile(r'[0-9]{5}')
# 만원 단위 양의 정수. 쉼표는 세 자리 묶음일 때만 허용하며 앞자리 0·소수·부호·지수 표기는 거부한다.
_MAN_WON = re.compile(r'[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+')
# 분석 결과 계약 v0의 positiveDecimal과 같은 형식.
_POSITIVE_DECIMAL = re.compile(r'[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*')
# 해제일: 기존 실응답 확인 형식 YY.MM.DD(예 26.10.29)와 ISO 날짜. 세기 추정 값은 내보내지 않는다.
_CANCEL_DATE_SHORT = re.compile(r'([0-9]{2})\.([0-9]{2})\.([0-9]{2})')
_MAX_MAN_WON_DIGITS = 16  # 원 단위 20자리(계약 v0 won의 maxLength) 이내
_MAX_AREA_LENGTH = 24
_ABSENT = object()


def _parse_iso_date(value, name):
    if not isinstance(value, str) or not _ISO_DATE.fullmatch(value):
        raise ValueError(f'{name}는 YYYY-MM-DD 형식의 문자열이어야 합니다.')
    try:
        return date(int(value[:4]), int(value[5:7]), int(value[8:]))
    except ValueError:
        raise ValueError(f'{name}가 달력에 없는 날짜입니다.') from None


def _months(first, last):
    start, end = first.year * 12 + first.month - 1, last.year * 12 + last.month - 1
    return [f'{n // 12:04d}{n % 12 + 1:02d}' for n in range(start, end + 1)]


def _period(status, source, basis, first, last, decision):
    months = _months(first, last) if first is not None else None
    basis_month = f'{basis.year:04d}{basis.month:02d}'
    return {'status': status, 'source': source, 'asOf': basis.isoformat(),
            'start': first.isoformat() if first is not None else None,
            'end': last.isoformat() if last is not None else None,
            'bounds': 'inclusive', 'months': months,
            'inProgressMonth': basis_month if months and basis_month in months else None,
            'decision': decision}


def trade_period(as_of, start=None, end=None):
    """조회일과 선택 기간으로 양 끝 포함 계약일 범위와 요청할 계약월을 만든다."""
    basis = _parse_iso_date(as_of, 'as_of')
    if basis.year < 2:
        raise ValueError('as_of가 지원하는 연도 범위 밖입니다.')
    if start is None and end is None:
        fixed_start = basis - timedelta(days=DEFAULT_PERIOD_DAYS - 1)
        try:
            calendar_start = date(basis.year - 1, basis.month, basis.day) + timedelta(days=1)
        except ValueError:  # 2월 29일: 전년에 같은 날짜가 없다
            calendar_start = None
        if calendar_start is None:
            reason = 'basis_date_is_leap_day'
        elif calendar_start != fixed_start:
            reason = 'calendar_year_and_365_day_starts_differ'
        else:
            return _period('confirmed', 'default_recent_year', basis, calendar_start, basis, None)
        # 어느 방식을 택할지는 D-02다. 후보 날짜를 값으로 내보내지 않는다.
        return _period('decision_required', 'default_recent_year', basis, None, None,
                       {'decisionId': LEAP_DAY_DECISION, 'reasonCode': reason})
    if start is None or end is None:
        raise ValueError('계약일 범위는 시작일과 종료일을 함께 지정하세요.')
    first, last = _parse_iso_date(start, 'start'), _parse_iso_date(end, 'end')
    if first > last:
        raise ValueError('계약일 범위의 시작일이 종료일보다 늦습니다.')
    if last > basis:
        raise ValueError('계약일 범위의 종료일이 조회일보다 늦습니다.')
    return _period('confirmed', 'user_confirmed', basis, first, last, None)


def _confirmed_period(period):
    if not isinstance(period, dict) or period.get('status') != 'confirmed':
        raise ValueError('확정된 계약일 범위(trade_period의 confirmed 결과)가 필요합니다.')
    if period.get('source') not in PERIOD_SOURCES:
        raise ValueError('계약일 범위의 출처가 올바르지 않습니다.')
    first = _parse_iso_date(period.get('start'), 'period.start')
    last = _parse_iso_date(period.get('end'), 'period.end')
    if first > last or period.get('months') != _months(first, last):
        raise ValueError('계약일 범위와 계약월 목록이 일치하지 않습니다.')
    return first, last, period['source']


def _selected_kinds(trade_kinds):
    if isinstance(trade_kinds, (str, bytes)) or not isinstance(trade_kinds, (list, tuple, set, frozenset)):
        raise ValueError('trade_kinds는 거래 종류의 목록이어야 합니다.')
    kinds = list(trade_kinds)
    if not kinds or any(not isinstance(kind, str) or kind not in TRADE_KINDS for kind in kinds) \
            or len(set(kinds)) != len(kinds):
        raise ValueError('trade_kinds에는 sale·presale_right·occupancy_right를 중복 없이 지정하세요.')
    return [kind for kind in TRADE_KINDS if kind in kinds]


def _observation(observation):
    if not isinstance(observation, dict) or not isinstance(observation.get('row'), dict):
        raise ValueError('observation에는 거래행 dict(row)가 필요합니다.')
    page, position = observation.get('page'), observation.get('position')
    if type(page) is not int or page < 1 or type(position) is not int or position < 1:
        raise ValueError('observation의 page와 position은 1 이상의 정수여야 합니다.')
    return observation['row'], page, position


def _scalar(value):
    """내보낼 수 있는 원값이면 (True, 값). JSON 스칼라(문자열·정수·유한 실수·참거짓·null)만 허용한다."""
    if value is None or isinstance(value, (str, bool, int)):
        return True, value
    if isinstance(value, float) and math.isfinite(value):
        return True, value
    return False, None


def _raw(value):
    """허용된 원값 또는 None. 누락·허용 밖 형태는 None이며 상태·사유로 구분한다."""
    return None if value is _ABSENT else _scalar(value)[1]


def _withheld(value):
    return value is not _ABSENT and not _scalar(value)[0]


def _field_state(row, field):
    """누락·null·명시적 공백·값·문자열 아닌 값·내보낼 수 없는 값을 구분한다."""
    value = row.get(field, _ABSENT)
    if value is _ABSENT:
        return 'absent', None
    if value is None:
        return 'null', None
    if _withheld(value):
        return 'non_scalar', None
    if not isinstance(value, str):
        return 'non_string', value
    return ('blank' if not value.strip() else 'value'), value


def _is_missing(value):
    return value is _ABSENT or value is None or (isinstance(value, str) and not value.strip())


def _issue(code, category, fields, detail=None):
    issue = {'code': code, 'category': category, 'fields': list(fields)}
    if detail is not None:
        issue['detail'] = detail
    return issue


def _present(row, fields):
    """허용 목록 필드 중 행에 있는 원값. 내보낼 수 없는 형태의 필드 이름은 따로 돌려준다."""
    values, withheld = {}, []
    for field in fields:
        if field in row:
            allowed, value = _scalar(row[field])
            if allowed:
                values[field] = value
            else:
                withheld.append(field)
    return values, withheld


def _date_part(value, max_digits, exact=False):
    if _is_missing(value):
        return 'missing', None
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        return 'invalid', None  # 실수·참거짓은 날짜 부분으로 해석하지 않는다
    text = str(value).strip()
    if re.fullmatch(r'[0-9]+', text) and (len(text) == max_digits if exact else len(text) <= max_digits):
        return 'ok', int(text)
    return 'invalid', None


def _contract_date(row, issues):
    states = [_date_part(row.get('dealYear', _ABSENT), 4, exact=True),
              _date_part(row.get('dealMonth', _ABSENT), 2),
              _date_part(row.get('dealDay', _ABSENT), 2)]
    status, parsed = 'parsed', None
    if any(state == 'invalid' for state, _ in states):
        status = 'invalid'
    elif any(state == 'missing' for state, _ in states):
        status = 'missing'
    else:
        try:
            parsed = date(*(value for _, value in states))
        except (ValueError, OverflowError):
            status = 'invalid'
    values, withheld = _present(row, DATE_FIELDS)
    if status != 'parsed':
        issues.append(_issue('contract_date_' + status, 'required_value', DATE_FIELDS,
                             'non_scalar_value' if withheld else None))
    return {'status': status, 'date': parsed.isoformat() if parsed else None,
            'sourceFields': list(DATE_FIELDS), 'sourceRaw': values}, parsed


def _amount(row, issues):
    raw = row.get('dealAmount', _ABSENT)
    digits = None
    if _is_missing(raw):
        status = 'missing'
    elif isinstance(raw, bool) or not isinstance(raw, (int, str)):
        status = 'invalid'  # 실수·기타 형식은 만원 정수로 해석하지 않는다
    elif isinstance(raw, int):
        status, digits = ('parsed', str(raw)) if raw > 0 else ('invalid', None)
    else:
        text = raw.strip()
        status, digits = ('parsed', text.replace(',', '')) if _MAN_WON.fullmatch(text) else ('invalid', None)
    if digits is not None and len(digits) > _MAX_MAN_WON_DIGITS:
        status, digits = 'invalid', None
    if status != 'parsed':
        issues.append(_issue('amount_' + status, 'required_value', ['dealAmount'],
                             'non_scalar_value' if _withheld(raw) else None))
    return {'status': status, 'won': str(int(digits) * WON_PER_MAN_WON) if digits else None,
            'sourceField': 'dealAmount', 'sourceRaw': _raw(raw),
            'sourceUnit': 'man_won', 'sourceAmount': digits, 'wonPerSourceUnit': WON_PER_MAN_WON}


def _exclusive_area(row, issues):
    raw = row.get('excluUseAr', _ABSENT)
    text = None
    if _is_missing(raw):
        status = 'missing'
    elif isinstance(raw, bool):
        status = 'invalid'
    else:
        if isinstance(raw, int):
            text = str(raw)
        elif isinstance(raw, float) and math.isfinite(raw):
            text = repr(raw)
        elif isinstance(raw, str):
            text = raw.strip()
        valid = text is not None and len(text) <= _MAX_AREA_LENGTH and _POSITIVE_DECIMAL.fullmatch(text)
        status, text = ('parsed', text) if valid else ('invalid', None)
    if status != 'parsed':
        issues.append(_issue('exclusive_area_' + status, 'required_value', ['excluUseAr'],
                             'non_scalar_value' if _withheld(raw) else None))
    return {'status': status, 'basis': 'exclusive', 'm2': text, 'sourceField': 'excluUseAr', 'sourceRaw': _raw(raw)}


def _request_region(row, region_code, issues):
    state, raw = _field_state(row, 'sggCd')
    if state in ('absent', 'null', 'blank'):
        status = 'missing'
    elif state in ('non_string', 'non_scalar') or not _REGION.fullmatch(raw.strip()):
        status = 'invalid'
    else:
        status = 'match' if raw.strip() == region_code else 'mismatch'
    if status in ('missing', 'invalid'):
        issues.append(_issue('request_region_' + status, 'required_value', ['sggCd'],
                             'non_scalar_value' if state == 'non_scalar' else None))
    elif status == 'mismatch':
        issues.append(_issue('request_region_mismatch', 'request_mismatch', ['sggCd']))
    return {'status': status, 'requested': region_code, 'observed': raw}


def _is_cancel_date(text):
    """해제일이 실제 달력 날짜인지 본다. YY는 달력 검사(윤일)에만 20YY로 두고 값으로 내보내지 않는다."""
    text = text.strip()
    short = _CANCEL_DATE_SHORT.fullmatch(text)
    if short:
        year, month, day = 2000 + int(short.group(1)), int(short.group(2)), int(short.group(3))
    elif _ISO_DATE.fullmatch(text):
        year, month, day = int(text[:4]), int(text[5:7]), int(text[8:])
    else:
        return False
    try:
        date(year, month, day)
    except ValueError:
        return False
    return True


def _cancellation(row, issues):
    """해제 판정은 합의된 근거(해제여부 'O', 날짜 형식의 해제일)만 사용한다."""
    type_state, type_raw = _field_state(row, 'cdealType')
    date_state, date_raw = _field_state(row, 'cdealDay')
    marked = type_state == 'value' and type_raw.strip() == 'O'
    if marked:
        type_state = 'marked'
    elif type_state in ('value', 'non_string'):
        type_state = 'unrecognized'
    if date_state == 'value':
        date_state = 'date' if _is_cancel_date(date_raw) else 'unrecognized'
    elif date_state == 'non_string':
        date_state = 'unrecognized'
    evidence = [field for field, proved in (('cdealType', marked), ('cdealDay', date_state == 'date')) if proved]
    date_unclear = date_state in ('unrecognized', 'non_scalar')
    if evidence:
        status = 'cancelled'
        if date_unclear:  # 'O'는 독립 근거다. 읽지 못한 해제일은 사유로만 남긴다
            issues.append(_issue('cancellation_date_unrecognized', 'unknown_state', ['cdealDay'], date_state))
    elif type_state == 'blank' and date_state == 'blank':
        status = 'not_marked'  # 수집 시점에 해제 표시가 없을 뿐이며 이후 바뀔 수 있다
    else:
        status = 'unknown'
        if date_unclear:
            detail = 'cancellation_date_unrecognized'
        elif type_state in ('unrecognized', 'non_scalar'):
            detail = 'cancellation_type_unrecognized'
        else:
            detail = 'cancellation_field_absent_or_null'
        issues.append(_issue('cancellation_status_unknown', 'unknown_state', ['cdealType', 'cdealDay'], detail))
    return {'status': status, 'evidence': evidence,
            'cdealType': {'state': type_state, 'raw': type_raw},
            'cdealDay': {'state': date_state, 'raw': date_raw}}


def _trade_kind(source, row, issues):
    if source == 'apt_trade':
        return 'sale', {'field': None, 'state': 'source_service', 'raw': None}
    # 공식 기술문서 항목표: 입주권일 때만 '입'. 명시적 공백은 분양권이며 누락·null과 구분한다.
    state, raw = _field_state(row, 'ownershipGbn')
    kind = None
    if state == 'absent':
        state = 'field_absent'
    elif state == 'null':
        state = 'null_value'
    elif state == 'blank':
        kind, state = 'presale_right', 'explicit_blank'
    elif state == 'value' and raw.strip() == '입':
        kind, state = 'occupancy_right', 'occupancy_mark'
    elif state != 'non_scalar':
        state = 'unrecognized'
    if kind is None:
        issues.append(_issue('rights_type_unknown', 'unknown_state', ['ownershipGbn'], state))
    return kind, {'field': 'ownershipGbn', 'state': state, 'raw': raw}


def normalize_trade(source, observation, region_code, month, period, trade_kinds):
    """국토교통부 거래행 하나를 JSON 직렬화 가능한 정규화 결과로 만든다. 비교 승인은 하지 않는다."""
    if source not in SOURCE_KINDS:
        raise ValueError('source는 apt_trade 또는 apt_rights여야 합니다.')
    row, page, position = _observation(observation)
    if not isinstance(region_code, str) or not _REGION.fullmatch(region_code):
        raise ValueError('region_code는 요청한 5자리 LAWD_CD여야 합니다.')
    first, last, period_source = _confirmed_period(period)
    if not isinstance(month, str) or not _YEAR_MONTH.fullmatch(month) or month not in period['months']:
        raise ValueError('month는 계약일 범위에 포함된 요청 계약월(YYYYMM)이어야 합니다.')
    selected = _selected_kinds(trade_kinds)

    issues = []
    contract, contract_date = _contract_date(row, issues)
    amount = _amount(row, issues)
    exclusive = _exclusive_area(row, issues)
    region_check = _request_region(row, region_code, issues)
    cancellation = _cancellation(row, issues)
    kind, kind_basis = _trade_kind(source, row, issues)
    identifiers, withheld_identifiers = _present(row, IDENTIFIER_FIELDS[source])
    attributes, withheld_attributes = _present(row, ATTRIBUTE_FIELDS[source])

    if contract_date is None:
        month_check = {'status': 'not_evaluated', 'requested': month, 'observed': None}
        period_status = 'not_evaluated'
    else:
        observed = f'{contract_date.year:04d}{contract_date.month:02d}'
        month_check = {'status': 'match' if observed == month else 'mismatch', 'requested': month, 'observed': observed}
        if observed != month:
            issues.append(_issue('request_month_mismatch', 'request_mismatch', ['dealYear', 'dealMonth']))
        period_status = 'inside' if first <= contract_date <= last else 'outside'

    if not any(candidate in selected for candidate in SOURCE_KINDS[source]):
        kind_status = 'not_included'  # 이 출처의 어떤 종류도 분석 대상이 아니면 세부 구분과 무관하다
    elif kind is None:
        kind_status = 'not_evaluated'
    else:
        kind_status = 'included' if kind in selected else 'not_included'

    exclusions = [reason for reason, proved in (
        ('outside_contract_period', period_status == 'outside'),
        ('cancelled_trade', cancellation['status'] == 'cancelled'),
        ('trade_kind_not_included', kind_status == 'not_included'),
    ) if proved]
    if exclusions:
        disposition = 'excluded'
    elif issues:
        disposition = 'held'
    else:
        disposition = 'follow_up_required'

    return {
        'normalizerVersion': NORMALIZER_VERSION,
        'provenance': {'source': source, 'request': {'LAWD_CD': region_code, 'DEAL_YMD': month},
                       'page': page, 'position': position},
        'tradeKind': kind,
        'tradeKindBasis': kind_basis,
        'contractDate': contract,
        'amount': amount,
        'exclusiveArea': exclusive,
        'supplyArea': {'status': 'unverified', 'basis': 'supply', 'm2': None,
                       'reasonCode': 'supply_area_correspondence_missing'},
        'cancellation': cancellation,
        'identifiers': identifiers,
        'attributes': attributes,
        'withheldFields': withheld_identifiers + withheld_attributes,
        'checks': {
            'requestRegion': region_check,
            'requestMonth': month_check,
            'contractPeriod': {'status': period_status, 'source': period_source,
                               'start': first.isoformat(), 'end': last.isoformat()},
            'tradeKind': {'status': kind_status, 'selected': selected},
        },
        'disposition': disposition,
        'exclusionReason': exclusions[0] if exclusions else None,
        'exclusionReasons': exclusions,
        'issues': issues,
        'pendingReasons': [] if exclusions else list(PENDING_REASONS),
    }
