#!/usr/bin/env python3
"""청약홈 공고·주택형 관측 행과 점검된 호실 가격·주택형 공급면적 근거를 한 회차의 카탈로그로 정규화한다.

PDF 파서나 외부 조회가 아니다. 이미 받은 API 행과, 수동·자동 추출 뒤 원문 대조를 마친 값만 받는다.
API의 SUPLY_AR(공고 쪽 공급면적)과 LTTOT_TOP_AMOUNT(주택형 최고금액, 만원)는 API 보고값으로만 두고
PDF에서 확인한 호실 분양가·필수 옵션·소계, 주택형 공급면적(checkedSupplyArea)과 섞지 않는다. 날짜·공고 유형 해석과 정정본 선택 규칙은
D-04 전까지 정하지 않는다: 날짜·유형은 원문 문자열 그대로, 회차는 API에서 추론하지 않고 target으로 받는다.
"""
import re
from decimal import Decimal

CONTRACT = 'applyhome-catalog/v0'
NOTICE_SOURCES = ('applyhome_apt', 'applyhome_remainder')
COLLECTION_STATUSES = ('complete', 'empty', 'partial', 'failed')
# collect_pages가 전달하는 청약홈 공식 필터 키. 다른 조건이 섞인 수집은 범위가 좁을 수 있어 받지 않는다.
SCOPE_KEYS = ('cond[HOUSE_MANAGE_NO::EQ]', 'cond[PBLANC_NO::EQ]')
# probes.json의 공고 조회 필드. 조회 유형마다 의미가 다를 수 있어 API 이름 그대로 보존한다(D-04).
NOTICE_FIELDS = {
    'applyhome_apt': ('HOUSE_NM', 'HSSPLY_ADRES', 'RCRIT_PBLANC_DE', 'RCEPT_BGNDE', 'RCEPT_ENDDE',
                      'MVN_PREARNGE_YM'),
    'applyhome_remainder': ('HOUSE_NM', 'HSSPLY_ADRES', 'RCRIT_PBLANC_DE', 'SUBSCRPT_RCEPT_BGNDE',
                            'SUBSCRPT_RCEPT_ENDDE', 'GNRL_RCEPT_BGNDE', 'SPSPLY_RCEPT_BGNDE', 'MVN_PREARNGE_YM'),
}
TYPE_FIELDS = ('HOUSE_SECD', 'HOUSE_SECD_NM', 'HOUSE_DTL_SECD', 'HOUSE_DTL_SECD_NM')  # 받은 것만 보존
PRICE_ITEMS = ('sale_price', 'required_options')  # required_options: 그 호실에 적용되는 필수 옵션 합계
ITEMS = PRICE_ITEMS + ('supply_area',)  # supply_area는 주택형 단위(room 없음), basis=supply·unit=m2만 받는다
CHECKS = ('confirmed', 'unverified', 'conflict')
DOCUMENT_SOURCES = ('official', 'upload')  # 확보 경로: 자동 확보한 공식 첨부 또는 사용자 업로드
# originCheck: 공식 원문 출처 대조 결과(confirmed|unverified|conflict). 생략하면 official은 confirmed, upload는 unverified.
# 출처를 확인한 업로드는 공식 PDF와 동등하게 쓴다. 원격 검증은 하지 않고 점검 이후의 입력만 받는다.
DOCUMENT_KEYS = ('source', 'originCheck', 'houseManageNo', 'noticeNo', 'edition')
ORIGIN_REASONS = ('document_origin_unverified', 'document_origin_conflict')
# 분석 결과 계약 v0의 공용 형식(won 20자, positiveDecimal 24자)과 거래 정규화의 상한을 그대로 쓴다.
# 길이를 먼저 막아 비정상 입력의 정수 변환 예외가 결과 전체를 버리지 않게 한다.
WON = re.compile(r'0|[1-9][0-9]*')
WON_LENGTH = 20
MANWON = re.compile(r'[1-9][0-9]*|[1-9][0-9]{0,2}(,[0-9]{3})+')  # API 원문은 천 단위 쉼표가 있을 수 있다
MANWON_DIGITS = 16  # 원 단위 20자리 이내
AREA = re.compile(r'[1-9][0-9]*(\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*')
AREA_LENGTH = 24


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _count(value, minimum):
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _scalar(value):
    """원 행의 값을 해석하지 않고 문자열로 보존한다. 중첩 구조는 내보내지 않고 형식 오류로 둔다."""
    if value is None:
        return 'missing', None
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        return 'invalid', None
    try:
        text = value if isinstance(value, str) else str(value)
    except ValueError:  # 변환 자릿수 상한을 넘는 정수
        return 'invalid', None
    return ('reported' if text.strip() else 'blank'), text


def _identity(value):
    """식별 번호는 문자열·정수만 받고 공백 제거 등 보정 없이 비교한다."""
    status, text = _scalar(value)
    return text if status == 'reported' and not isinstance(value, (float, Decimal)) else None


def _merge(outputs, base):
    """같은 키의 여러 행 값이 모두 같을 때만 쓴다. 다르면 대표값을 고르지 않고 충돌로 둔다."""
    distinct = []
    for output in outputs:
        if output not in distinct:
            distinct.append(output)
    return distinct[0] if len(distinct) == 1 else dict(base, status='conflict', values=distinct)


def _field(raw):
    status, text = _scalar(raw)
    return {'status': status, 'value': text}


def _supply_area(raw):
    status, text = _scalar(raw)
    if status == 'reported' and not (len(text) <= AREA_LENGTH and AREA.fullmatch(text)):
        status = 'invalid'
    return {'status': status, 'basis': 'supply', 'm2': text if status == 'reported' else None}


def _top_amount(raw):
    status, text = _scalar(raw)
    if status == 'reported' and not (MANWON.fullmatch(text) and len(text.replace(',', '')) <= MANWON_DIGITS):
        status = 'invalid'
    won = str(int(text.replace(',', '')) * 10000) if status == 'reported' else None
    return {'status': status, 'kind': 'housing_type_top_amount', 'won': won,
            'raw': text if status != 'invalid' else None, 'rawUnit': 'manwon'}


def _area(value):
    return isinstance(value, str) and len(value) <= AREA_LENGTH and AREA.fullmatch(value) is not None


def _won(value, item):
    return (isinstance(value, str) and len(value) <= WON_LENGTH and WON.fullmatch(value) is not None
            and (item != 'sale_price' or value != '0'))


def _ref(role, observation):
    return {'collection': role, 'page': observation['page'], 'position': observation['position']}


def _read_collection(collection, role, target, issues):
    """출처·범위·상태·관측 구조를 검사한 뒤 두 번호가 target과 같은 행만 남긴다."""
    allowed = NOTICE_SOURCES if role == 'notice' else tuple(s + '_model' for s in NOTICE_SOURCES)
    data = collection if isinstance(collection, dict) else {}
    source, declared, observations = data.get('source'), data.get('status'), data.get('observations')
    scope = data.get('scope') if isinstance(data.get('scope'), dict) else {}
    problems = []
    if source not in allowed:
        problems.append('collection_source_invalid')
    if set(scope) != set(SCOPE_KEYS) or tuple(_identity(scope.get(k)) for k in SCOPE_KEYS) != target:
        problems.append('collection_scope_mismatch')
    if declared not in COLLECTION_STATUSES:
        problems.append('collection_status_invalid')
    if not isinstance(observations, list):
        problems.append('collection_malformed')
        observations = []
    elif (declared in ('empty', 'failed') and observations) or (declared == 'complete' and not observations):
        problems.append('collection_inconsistent')
    positions = set()
    for observation in observations:
        if not (isinstance(observation, dict) and isinstance(observation.get('row'), dict)
                and _count(observation.get('page'), 1) and _count(observation.get('position'), 1)):
            problems.append('observation_malformed')
            break
        positions.add((observation['page'], observation['position']))
    if len(positions) < len(observations) and 'observation_malformed' not in problems:
        problems.append('observation_position_repeated')
    summary = {'source': source if isinstance(source, str) else None,
               'declaredStatus': declared if isinstance(declared, str) else None, 'status': 'unusable',
               'observations': len(observations), 'inScope': 0}
    for problem in problems:
        issues.append({'code': problem, 'collection': role})
    if problems:
        return summary, []
    rows, foreign = [], False
    for observation in observations:
        row = observation['row']
        numbers = (_identity(row.get('HOUSE_MANAGE_NO')), _identity(row.get('PBLANC_NO')))
        if numbers == target:
            rows.append(observation)
            continue
        foreign = True
        issues.append(dict(_ref(role, observation), code='row_identity_missing' if None in numbers else 'row_out_of_scope'))
    # 두 번호로 요청한 응답에 다른·번호 없는 행이 있으면 응답 범위가 어긋난 것이다. 완전성을 주장하지 않는다.
    summary.update(status='partial' if foreign and declared == 'complete' else declared, inScope=len(rows))
    if summary['status'] in ('partial', 'failed'):
        issues.append({'code': 'collection_' + summary['status'], 'collection': role})
    return summary, rows


def _merged(rows, name, issues, code, **context):
    value = _merge([_field(o['row'].get(name)) for o in rows], {'value': None})
    if value['status'] == 'conflict':
        issues.append(dict(context, code=code, field=name))
    return value


def _notice(summary, rows, issues):
    status = summary['status']
    if status == 'unusable':
        state = 'unverified'
    elif status == 'failed':
        state = 'lookup_failed'
    elif rows:
        state = 'reported' if status == 'complete' else 'partially_collected'
    else:
        # 공고 미발견은 업무 응답이 명시적으로 빈 결과일 때만이다.
        state = 'not_found' if status == 'empty' else 'partially_collected'
    if state == 'not_found':
        issues.append({'code': 'notice_not_found'})
    notice = {'status': state, 'source': summary['source'], 'fields': None, 'link': None,
              'kind': {'status': 'decision_required', 'decisionId': 'D-04', 'raw': None},
              'evidence': [_ref('notice', o) for o in rows]}
    if rows:
        notice['fields'] = {n: _merged(rows, n, issues, 'notice_field_conflict') for n in NOTICE_FIELDS[summary['source']]}
        notice['kind']['raw'] = {n: _merged(rows, n, issues, 'notice_field_conflict') for n in TYPE_FIELDS
                                 if any(n in o['row'] for o in rows)}
        # PBLANC_URL은 분양정보·모집공고 페이지 링크다. PDF 문서·페이지 근거로 쓰지 않는다.
        notice['link'] = dict(_merged(rows, 'PBLANC_URL', issues, 'notice_field_conflict'), kind='notice_page')
    return notice


def _housing_types(summary, rows, pair_ok, notice_state, issues):
    groups, unattributed = {}, False
    for observation in rows:
        model_no = _identity(observation['row'].get('MODEL_NO'))
        if model_no is None:
            unattributed = True
            issues.append(dict(_ref('model', observation), code='model_no_missing'))
            continue
        groups.setdefault(model_no, []).append(observation)
    types = []
    for model_no in sorted(groups):
        group = groups[model_no]
        house_type = _merged(group, 'HOUSE_TY', issues, 'model_field_conflict', modelNo=model_no)
        supply = _merge([_supply_area(o['row'].get('SUPLY_AR')) for o in group], {'basis': 'supply', 'm2': None})
        top = _merge([_top_amount(o['row'].get('LTTOT_TOP_AMOUNT')) for o in group],
                     {'kind': 'housing_type_top_amount', 'won': None, 'raw': None, 'rawUnit': 'manwon'})
        for name, value in (('SUPLY_AR', supply), ('LTTOT_TOP_AMOUNT', top)):
            if value['status'] == 'conflict':
                issues.append({'code': 'model_field_conflict', 'modelNo': model_no, 'field': name})
        reasons = [] if pair_ok else ['source_pair_mismatch']
        if notice_state == 'not_found':
            reasons.append('notice_not_found')
        if house_type['status'] != 'reported':
            reasons.append('house_type_' + house_type['status'])
        types.append({'modelNo': model_no, 'status': 'held' if reasons else 'linked', 'reasons': reasons,
                      'houseType': house_type, 'supplyArea': supply, 'topAmount': top,
                      'evidence': [_ref('model', o) for o in group]})
    status = 'partial' if unattributed and summary['status'] == 'complete' else summary['status']
    if status in ('unusable', 'failed', 'partial'):
        state = {'unusable': 'unverified', 'failed': 'lookup_failed', 'partial': 'partially_collected'}[status]
    elif types:
        state = 'reported'
    else:
        # 공고 주택형 0개를 정상 0개로 보지 않는다.
        state = 'unverified'
        issues.append({'code': 'no_housing_types_observed'})
    return types, state


def _origin(document):
    origin = document.get('originCheck')
    if origin is None:
        return 'confirmed' if document.get('source') == 'official' else 'unverified'
    return origin


def _record_problem(record):
    """구조가 맞지 않는 첫 필드 이름. 금액 형식은 값 단위로 따로 검사한다."""
    if not isinstance(record, dict):
        return 'record'
    document = record.get('document')
    if not (isinstance(document, dict) and _text(document.get('id')) and _text(document.get('version'))
            and all(document.get(k) is None or isinstance(document.get(k), str) for k in DOCUMENT_KEYS)
            and document.get('originCheck') in (None,) + CHECKS):
        return 'document'
    if not _count(record.get('page'), 1):
        return 'page'
    for name in ('modelNo', 'houseType'):
        if not _text(record.get(name)):
            return name
    item = record.get('item')
    if item not in ITEMS:
        return 'item'
    if item == 'supply_area':
        # 전용면적 등 다른 기준이나 호실 단위 면적은 공급면적 근거로 받지 않는다.
        for name, expected in (('basis', 'supply'), ('unit', 'm2'), ('room', None), ('won', None)):
            if record.get(name) != expected:
                return name
    elif not _text(record.get('room')):
        return 'room'
    if record.get('check') not in CHECKS:
        return 'check'
    if record.get('raw') is not None and not isinstance(record.get('raw'), str):
        return 'raw'
    return None


def _identified(record, target, edition):
    """형식이 틀린 기록도 같은 공고·회차의 주택형·호실·항목을 가리키면 그 항목만 보류할 수 있게 한다."""
    document = record.get('document') if isinstance(record, dict) else None
    if not (isinstance(document, dict) and (document.get('houseManageNo'), document.get('noticeNo')) == target
            and document.get('edition') == edition and document.get('source') in DOCUMENT_SOURCES
            and _origin(document) == 'confirmed'):
        return None  # 출처 미확인 문서의 형식 오류가 다른 공식 근거를 보류시키지 않게 한다
    item = record.get('item')
    if not (_text(record.get('modelNo')) and item in ITEMS):
        return None
    if item == 'supply_area':
        return record['modelNo'], None, item
    return (record['modelNo'], record['room'], item) if _text(record.get('room')) else None


def _document_reasons(meta, conflict, target, edition):
    if conflict:
        return ['document_metadata_conflict']
    source, origin, house, notice_no, document_edition = meta
    reasons = [] if source in DOCUMENT_SOURCES else ['document_source_unverified']
    if None in (house, notice_no, document_edition):
        reasons.append('document_identity_unverified')
    elif (house, notice_no) != target:
        reasons.append('document_notice_mismatch')
    elif document_edition != edition:
        reasons.append('different_notice_round')
    if source in DOCUMENT_SOURCES and origin != 'confirmed':
        reasons.append('document_origin_' + origin)
    return reasons


def _aggregate(contributions, field):
    """한 항목의 모든 기록이 확정이고 같은 값일 때만 채택한다. 같은 값인지는 기록의 key(원 정수·정밀 십진수)로 본다."""
    contributions = sorted(contributions, key=lambda c: c['ref']['evidenceIndex'])
    refs = [c['ref'] for c in contributions]
    if not contributions:
        return {'status': 'unverified', field: None, 'reasons': ['no_checked_value'], 'evidence': refs}
    confirmed = [c for c in contributions if c['check'] == 'confirmed']
    distinct = {}
    for contribution in confirmed:
        distinct.setdefault(contribution['key'], contribution['value'])  # 같은 값의 다른 표기는 처음 원문을 쓴다
    values = [distinct[k] for k in sorted(distinct)]
    if len(values) > 1 or any(c['check'] == 'conflict' for c in contributions):
        if len(values) > 1 and len({c['document'] for c in confirmed}) > 1:
            return {'status': 'conflict', field: None, 'reasons': ['correction_relation_unverified'],
                    'decisionId': 'D-04', 'values': values, 'evidence': refs}
        return {'status': 'conflict', field: None, 'reasons': ['source_value_conflict'], 'values': values,
                'evidence': refs}
    if len(confirmed) == len(contributions):
        return {'status': 'confirmed', field: values[0], 'reasons': [], 'evidence': refs}
    reasons = sorted({c['reason'] for c in contributions if c['check'] == 'unverified'})
    return {'status': 'unverified', field: None, 'reasons': reasons, 'evidence': refs}


def _checked_area(contributions, api):
    """문서 점검 공급면적. API 보고값과 정밀 십진수로 같거나, API 값이 없으면 출처 확인 문서의 점검값을 쓴다."""
    result = dict({'basis': 'supply'}, **_aggregate(contributions, 'm2'))
    if result['status'] != 'confirmed':
        return result
    held = dict(result, m2=None)
    if api['status'] == 'reported':
        if Decimal(api['m2']) == Decimal(result['m2']):
            return result
        return dict(held, status='conflict', reasons=['supply_area_api_mismatch'], values=[api['m2'], result['m2']])
    if api['status'] == 'conflict':
        return dict(held, status='conflict', reasons=['supply_area_api_conflict'])
    return result  # 채택된 문서는 모두 originCheck=confirmed다(업로드라도 공식 PDF와 동등).


def _evidence(evidence, target, edition, types, types_state, issues):
    by_no = {t['modelNo']: t for t in types}
    documents, valid, malformed = {}, [], []
    for index, record in enumerate(evidence):
        problem = _record_problem(record)
        if problem:
            identified = _identified(record, target, edition)
            code = 'area_basis_mixed' if problem == 'basis' else 'evidence_malformed'  # 공급·전용 혼재(A-11)
            issue = {'code': code, 'evidenceIndex': index, 'field': problem}
            if identified:
                issue.update(zip(('modelNo', 'room', 'item'), identified))
                malformed.append((index, identified, code))
            issues.append(issue)
            continue
        key = (record['document']['id'], record['document']['version'])
        meta = tuple(_origin(record['document']) if k == 'originCheck' else record['document'].get(k) for k in DOCUMENT_KEYS)
        entry = documents.setdefault(key, {'meta': meta, 'conflict': False, 'records': 0})
        entry['conflict'] = entry['conflict'] or entry['meta'] != meta
        entry['records'] += 1
        valid.append((index, record, key))
    document_out = []
    for key in sorted(documents):
        entry = documents[key]
        entry['reasons'] = _document_reasons(entry['meta'], entry['conflict'], target, edition)
        for reason in entry['reasons']:
            issues.append({'code': reason, 'document': key[0], 'version': key[1]})
        document_out.append(dict(zip(('id', 'version') + DOCUMENT_KEYS, key + entry['meta']),
                                 status='accepted' if not entry['reasons'] else
                                 'held' if set(entry['reasons']) <= set(ORIGIN_REASONS) else 'rejected',
                                 reasons=entry['reasons'], records=entry['records']))
    accepted = [d['id'] + '@' + d['version'] for d in document_out if d['status'] == 'accepted']
    if len(accepted) > 1:
        issues.append({'code': 'multiple_documents_same_edition', 'decisionId': 'D-04', 'documents': accepted})
    cells, room_models, areas = {}, {}, {}
    # room_flags: 채택 문서가 같은 호실을 다른 주택형으로 가리킨 적용 모순. area_flags: 모델이 명확한 면적 기록의 주택형 모순.
    # origin_rooms: 출처 대조만 보류된 문서가 대상 공고·회차·주택형·호실을 정확히 가리킨 호실과 그 보류 사유.
    room_flags, area_flags, origin_rooms = {}, {}, {}

    def add(model_no, room, item, contribution):
        if item == 'supply_area':
            areas.setdefault(model_no, []).append(contribution)
            return
        room_models.setdefault(room, set()).add(model_no)
        cells.setdefault((model_no, room), {i: [] for i in PRICE_ITEMS})[item].append(contribution)

    for index, (model_no, room, item), reason in malformed:
        if model_no in by_no and by_no[model_no]['status'] == 'linked':
            add(model_no, room, item, {'check': 'unverified', 'value': None, 'key': None, 'document': None,
                                       'reason': reason,
                                       'ref': {'document': None, 'version': None, 'page': None, 'evidenceIndex': index}})
    for index, record, key in valid:
        housing = by_no.get(record['modelNo'])
        linked = housing is not None and housing['status'] == 'linked'
        document_reasons = documents[key]['reasons']
        if document_reasons:
            # 다른 회차·번호 불일치·식별 미확인 문서는 병합하지 않고 호실도 만들지 않는다. 출처 대조만 보류된 문서는
            # 값을 쓰지 않되, 가리킨 호실에 독립 근거가 없을 때 금액 없는 보류 호실로 한 번 남긴다.
            if (set(document_reasons) <= set(ORIGIN_REASONS) and linked and record['item'] != 'supply_area'
                    and record['houseType'] == housing['houseType']['value']):
                origin_rooms.setdefault((record['modelNo'], record['room']), set()).update(document_reasons)
            continue
        if housing is None:
            reason = 'model_not_linked' if types_state == 'reported' else 'model_unverified'
        elif not linked:
            reason = 'model_held'
        elif record['houseType'] != housing['houseType']['value']:
            reason = 'house_type_mismatch'
            # 불일치 기록은 채택하지 않지만, 그 기록이 가리킨 호실·면적의 적용 모순으로 남겨 해당 값만 보류한다.
            if record['item'] == 'supply_area':
                area_flags.setdefault(record['modelNo'], []).append(
                    {'document': key[0], 'version': key[1], 'page': record['page'], 'evidenceIndex': index})
            else:
                room_flags.setdefault(record['room'], set()).add(reason)
        else:
            reason = None
        if reason:
            issues.append({'code': reason, 'evidenceIndex': index, 'modelNo': record['modelNo']})
            continue
        item, check, reason = record['item'], record['check'], 'value_unverified'
        is_area = item == 'supply_area'
        value = record.get('m2') if is_area else record.get('won')
        if check == 'confirmed' and not (_area(value) if is_area else _won(value, item)):
            reason = 'invalid_area' if is_area else 'invalid_amount'
            issues.append({'code': reason, 'evidenceIndex': index})
            check = 'unverified'
        confirmed = check == 'confirmed'
        add(record['modelNo'], record.get('room'), item,
            {'check': check, 'value': value if confirmed else None,
             'key': (Decimal(value) if is_area else (len(value), value)) if confirmed else None,
             'document': key, 'reason': reason,
             'ref': {'document': key[0], 'version': key[1], 'page': record['page'], 'evidenceIndex': index}})
    for housing in types:
        # API SUPLY_AR(supplyArea)은 보고값으로 그대로 두고, 문서 점검값만 따로 판정한다. 면적 보류는 호실 소계와 무관하다.
        checked = _checked_area(areas.get(housing['modelNo'], []), housing['supplyArea'])
        if checked['status'] == 'conflict':
            issues.append({'code': checked['reasons'][0], 'modelNo': housing['modelNo'], 'item': 'supply_area'})
        if housing['modelNo'] in area_flags:
            checked = dict(checked, status='conflict', m2=None,
                           reasons=['house_type_mismatch'] + [r for r in checked['reasons'] if r != 'no_checked_value'],
                           evidence=sorted(checked['evidence'] + area_flags[housing['modelNo']],
                                           key=lambda ref: ref['evidenceIndex']))
        housing['checkedSupplyArea'] = checked
    rooms = []
    for model_no, room in sorted(cells):
        cell = cells[(model_no, room)]
        sale, options = _aggregate(cell['sale_price'], 'won'), _aggregate(cell['required_options'], 'won')
        reasons = ['room_model_conflict'] if len(room_models[room]) > 1 else []
        reasons += sorted(room_flags.get(room, ()))
        reasons += [name + '_' + part['status'] for name, part in (('sale_price', sale), ('required_options', options))
                    if part['status'] != 'confirmed']
        for name, part in (('sale_price', sale), ('required_options', options)):
            if part['status'] == 'conflict':
                issues.append({'code': part['reasons'][0], 'modelNo': model_no, 'room': room, 'item': name})
        # 소계는 분양가+필수 옵션이며 총취득비용이 아니다(세금·금융비용 제외). D-04 전에는 두 항목을
        # 함께 확인한 같은 문서 버전이 있어야 소계를 확정한다. 적용 관계 입력은 아직 없다.
        shared = sorted(({c['document'] for c in cell['sale_price']} & {c['document'] for c in cell['required_options']})
                        - {None})
        subtotal = {'status': 'held', 'won': None, 'basis': 'sale_price_plus_required_options', 'reasons': reasons,
                    'documents': []}
        if not reasons and not shared:
            subtotal.update(reasons=['subtotal_documents_differ'], decisionId='D-04')
        elif not reasons and len(str(int(sale['won']) + int(options['won']))) > WON_LENGTH:
            subtotal['reasons'] = ['subtotal_out_of_range']  # 두 항목은 유지하고 소계만 보류
        elif not reasons:
            subtotal.update(status='confirmed', won=str(int(sale['won']) + int(options['won'])),
                            documents=[{'id': d, 'version': v} for d, v in shared])
        rooms.append({'modelNo': model_no, 'houseType': by_no[model_no]['houseType']['value'], 'room': room,
                      'status': subtotal['status'], 'salePrice': sale, 'requiredOptions': options,
                      'subtotal': subtotal})
    for model_no, room in sorted(origin_rooms):
        if room in room_models:
            continue  # 같은 호실에 독립 근거가 있으면 출처 미확인 문서가 막지 않는다.
        missing = {'status': 'unverified', 'won': None, 'reasons': ['no_checked_value'], 'evidence': []}
        rooms.append({'modelNo': model_no, 'houseType': by_no[model_no]['houseType']['value'], 'room': room,
                      'status': 'held', 'salePrice': dict(missing), 'requiredOptions': dict(missing),
                      'subtotal': {'status': 'held', 'won': None, 'basis': 'sale_price_plus_required_options',
                                   'reasons': sorted(origin_rooms[(model_no, room)]) + sorted(room_flags.get(room, ())),
                                   'documents': []}})
    rooms.sort(key=lambda r: (r['modelNo'], r['room']))
    for room in sorted(r for r, models in room_models.items() if len(models) > 1):
        issues.append({'code': 'room_model_conflict', 'room': room, 'modelNos': sorted(room_models[room])})
    return rooms, document_out


def normalize_catalog(notice_collection, model_collection, *, target, evidence=()):
    """한 공고·회차의 공고 기본 정보, 주택형(점검 공급면적 포함), 확인된 호실 소계와 보류 사유를 돌려준다."""
    if not (isinstance(target, dict) and all(_text(target.get(k)) for k in ('houseManageNo', 'noticeNo', 'edition'))):
        raise ValueError('target needs houseManageNo, noticeNo and edition strings')
    if not isinstance(evidence, (list, tuple)):
        raise TypeError('evidence must be a list or tuple of records')
    numbers = (target['houseManageNo'], target['noticeNo'])
    issues = []
    notice_summary, notice_rows = _read_collection(notice_collection, 'notice', numbers, issues)
    model_summary, model_rows = _read_collection(model_collection, 'model', numbers, issues)
    pair_ok = notice_summary['source'] in NOTICE_SOURCES and model_summary['source'] == str(notice_summary['source']) + '_model'
    if not pair_ok:
        issues.append({'code': 'source_pair_mismatch', 'notice': notice_summary['source'],
                       'model': model_summary['source']})
    notice = _notice(notice_summary, notice_rows, issues)
    types, types_state = _housing_types(model_summary, model_rows, pair_ok, notice['status'], issues)
    rooms, documents = _evidence(evidence, numbers, target['edition'], types, types_state, issues)
    for housing in types:
        own = [r for r in rooms if r['modelNo'] == housing['modelNo']]
        confirmed = [int(r['subtotal']['won']) for r in own if r['status'] == 'confirmed']
        # 확인한 호실만의 범위다. 미확인 호실을 채우거나 전체 주택형의 범위로 표시하지 않는다.
        housing['subtotalRange'] = {'scope': 'confirmed_rooms', 'min': str(min(confirmed)) if confirmed else None,
                                    'max': str(max(confirmed)) if confirmed else None,
                                    'confirmedRooms': len(confirmed), 'heldRooms': len(own) - len(confirmed)}
    return {'contract': CONTRACT, 'target': dict(target),
            'collections': {'notice': notice_summary, 'model': model_summary},
            'notice': notice, 'housingTypes': types, 'housingTypesStatus': types_state,
            'rooms': rooms, 'documents': documents, 'issues': issues}
