#!/usr/bin/env python3
"""BE-02 수집본과 작업자가 대조한 근거로 주변 실거래를 비교한다.

ingestion은 replay()/ingest()가 반환한 ingestion/v0 객체다. selection에는 주택형·호실,
확인한 면적 허용치와 기존 후보를 명시한 교체 요청만 적용한다. evidence는 작업자 전용
comparison-evidence/v1이며 공고·지역·단지·행별 출처와 대응을 담는다. 네트워크나 파일을
읽지 않고 JSON으로 저장 가능한 comparison/v1을 반환한다.
"""

import math
import re
from collections import Counter, defaultdict
from datetime import date
from decimal import Context, Decimal, localcontext
from itertools import groupby
from typing import Optional

if __package__:
    from .ingestion_notices import AREA_LENGTH, CONTRACT as CATALOG_VERSION, NOTICE_SOURCES, normalize_price_unit
    from .ingestion_trades import IDENTIFIER_FIELDS, NORMALIZER_VERSION, SOURCE_KINDS, TRADE_KINDS, trade_period
else:
    from ingestion_notices import AREA_LENGTH, CONTRACT as CATALOG_VERSION, NOTICE_SOURCES, normalize_price_unit
    from ingestion_trades import IDENTIFIER_FIELDS, NORMALIZER_VERSION, SOURCE_KINDS, TRADE_KINDS, trade_period


TARGET_KEYS = ('houseManageNo', 'noticeNo', 'edition')
PRICE_BASIS = 'sale_price_plus_required_options'
DEFAULT_TOLERANCE = Decimal('5')
MAX_AREA_TOLERANCE = Decimal('5')
MAX_COMPLEX_ID_LENGTH = 120
ALLOWED_CONDITION_KEYS = frozenset({'period', 'areaTolerancePercent', 'tradeKinds', 'replacements'})
MAX_COMPARABLES = 5
MEAN_EARTH_RADIUS_M = 6_371_008.8


def _obj(value):
    return value if isinstance(value, dict) else {}


def _items(value):
    return value if isinstance(value, list) else []


def _text(value):
    return value if isinstance(value, str) and value and value == value.strip() else None


def _matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def _number(value, minimum=0):
    return type(value) is int and value >= minimum


def _calendar_day(value):
    if _matches(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value):
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    return None


def _timestamp(value):
    time = r'(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,6})?'
    zone = r'(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])'
    if _matches(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T' + time + zone, value) and _calendar_day(value[:10]):
        return value
    return None


def _decimal(value, *, signed=False):
    pattern = r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?' if signed else r'(?:0|[1-9][0-9]*)(?:\.[0-9]+)?'
    return Decimal(value) if _matches(pattern, value) else None


def _area_decimal(value):
    return _decimal(value) if isinstance(value, str) and len(value) <= AREA_LENGTH else None


def _area(value):
    amount = _area_decimal(value)
    return amount if amount is not None and amount > 0 else None


def _as_decimal_string(value):
    return format(value, 'f')


def _canonical_decimal_string(value):
    text = format(value, 'f')
    if '.' in text:
        text = text.rstrip('0').rstrip('.')
    return text or '0'


def _approved_tolerance_decimal(value):
    if not _matches(r'(?:0|[1-9][0-9]*)(?:\.[0-9]{1,4})?', value):
        return None
    amount = Decimal(value)
    if amount <= 0 or amount > MAX_AREA_TOLERANCE:
        return None
    return Decimal(_canonical_decimal_string(amount))


def _complex_id_text(value):
    if (not isinstance(value, str) or not value or value != value.strip()
            or len(value) > MAX_COMPLEX_ID_LENGTH or re.search(r'[\x00-\x1f\x7f]', value)):
        return None
    return value


def _won(value, *, allow_zero=False):
    if not _matches(r'0|[1-9][0-9]{0,19}', value):
        return None
    return int(value) if allow_zero or value != '0' else None


def _reasons(values):
    return [value for value in _items(values) if _matches(r'[a-z][a-z0-9_]{0,79}', value)]


def _proof(value):
    value = _obj(value)
    if _text(value.get('source')) and _text(value.get('reference')):
        return {key: value[key] for key in ('source', 'reference')}
    return None


def _confirmed_proof(row):
    return _proof(row.get('evidence')) if row.get('status', 'confirmed') == 'confirmed' else None


def _unique(rows, key):
    groups = defaultdict(list)
    for row in rows:
        identifier = key(_obj(row))
        if identifier is not None:
            groups[identifier].append(row)
    return ({identifier: rows[0] for identifier, rows in groups.items() if len(rows) == 1},
            {identifier for identifier, rows in groups.items() if len(rows) > 1})


def _reported(value):
    value = _obj(value)
    return _text(value.get('value')) if value.get('status') == 'reported' else None


def _reported_house_type(value):
    """주택형은 API 원문 표기를 보존한다(예: '102.7700 '). 바깥 공백만 있는 원문도 보고값으로 받는다.

    수집본의 호실·납부 일정과 DB(notice_run_house_type, funding_label_valid)가 같은 원문을 쓰므로 비교도 원문으로 한다.
    """
    value = _obj(value)
    text = value.get('value')
    if value.get('status') != 'reported' or not isinstance(text, str) or not text.strip():
        return None
    return text


def _same_target(value, target):
    return all(_obj(value).get(key) == target[key] for key in TARGET_KEYS)


def _hold(reason, **detail):
    return {'reasonCode': reason, **detail}


def _catalog_position(value, role):
    if (value.get('collection') == role and _number(value.get('page'), 1)
            and _number(value.get('position'), 1)):
        return value['page'], value['position']
    return None


def _selected_model(catalog, selection):
    models, duplicates = _unique(_items(catalog.get('housingTypes')), lambda row: _text(row.get('modelNo')))
    linked = {key: model for key, model in models.items()
              if model.get('status') == 'linked' and _reported_house_type(model.get('houseType'))
              and any(_catalog_position(_obj(ref), 'model') for ref in _items(model.get('evidence')))}
    if 'modelNo' in selection:
        key = _text(selection['modelNo'])
        if key in linked:
            return linked[key], None
        return None, 'housing_type_conflict' if key in duplicates else 'housing_type_unverified'
    if len(linked) == 1 and not duplicates and catalog.get('housingTypesStatus') == 'reported':
        return next(iter(linked.values())), None
    return None, 'housing_type_selection_required'


def _documents(catalog, target):
    def key(document):
        if _text(document.get('id')) and _text(document.get('version')):
            return document['id'], document['version']
        return None

    docs, _ = _unique(_items(catalog.get('documents')), key)
    return {identity for identity, doc in docs.items()
            if doc.get('status') == 'accepted' and doc.get('originCheck') == 'confirmed'
            and doc.get('source') in ('official', 'upload') and _same_target(doc, target)}


def _document_refs(value, documents):
    refs, indices = [], set()
    for ref in _items(_obj(value).get('evidence')):
        ref = _obj(ref)
        key = (_text(ref.get('document')), _text(ref.get('version')))
        index = ref.get('evidenceIndex')
        if key not in documents or not _number(ref.get('page'), 1) or not _number(index) or index in indices:
            return []
        indices.add(index)
        refs.append({field: ref[field] for field in ('document', 'version', 'page', 'evidenceIndex')})
    return refs


def _checked_target_area(model, documents):
    checked = _obj(model.get('checkedSupplyArea'))
    refs = _document_refs(checked, documents)
    amount = _area(checked.get('m2'))
    reported = _obj(model.get('supplyArea'))
    matches_reported = (reported.get('status') != 'conflict'
                        and (reported.get('status') != 'reported'
                             or reported.get('basis') == 'supply' and _area(reported.get('m2')) == amount))
    confirmed = (amount is not None and refs and checked.get('basis') == 'supply'
                 and checked.get('status') == 'confirmed' and matches_reported)
    result = {'status': 'confirmed' if confirmed else 'held', 'basis': 'supply',
              'm2': checked['m2'] if confirmed else None, 'evidence': refs,
              'reasons': _reasons(checked.get('reasons'))}
    return result, amount if confirmed else None


def _room_total(room, house_type, documents):
    subtotal = _obj(room.get('subtotal'))
    if room.get('status') != 'confirmed' or subtotal.get('status') != 'confirmed' or room.get('houseType') != house_type:
        return None
    if subtotal.get('basis') != PRICE_BASIS:
        return None
    sale, options = (_obj(room.get(key)) for key in ('salePrice', 'requiredOptions'))
    prices = (_won(sale.get('won')), _won(options.get('won'), allow_zero=True))
    sale_refs, option_refs = (_document_refs(value, documents) for value in (sale, options))
    common = {(ref['document'], ref['version']) for ref in sale_refs} & {
        (ref['document'], ref['version']) for ref in option_refs
    }
    if (sale.get('status') != 'confirmed' or options.get('status') != 'confirmed' or None in prices
            or not common or sum(prices) != _won(subtotal.get('won'))):
        return None
    entry = {'room': room['room'], 'salePriceWon': sale['won'], 'requiredOptionsWon': options['won'],
             'subtotalWon': subtotal['won'], 'evidence': {'salePrice': sale_refs, 'requiredOptions': option_refs}}
    unit = normalize_price_unit(room.get('unit'))
    if unit is not None:
        entry['unit'] = unit
    return entry


def _notice_price(catalog, model, selection, documents):
    chosen = _text(selection.get('room'))
    explicit = 'room' in selection
    result = {'status': 'held', 'scope': 'selected_room' if explicit else 'confirmed_rooms',
              'basis': PRICE_BASIS, 'room': chosen, 'won': None, 'minWon': None, 'maxWon': None,
              'confirmedRooms': [], 'heldRooms': [], 'reasons': []}
    if model is None:
        result['reasons'] = ['housing_type_unverified']
        return result
    own = [row for row in _items(catalog.get('rooms')) if _obj(row).get('modelNo') == model['modelNo']]
    rooms, duplicates = _unique(own, lambda row: _text(row.get('room')))
    confirmed, held = {}, {name: ['room_identity_conflict'] for name in duplicates}
    held_units = {}
    for name, room in rooms.items():
        total = _room_total(room, _reported_house_type(model.get('houseType')), documents)
        if total is not None:
            confirmed[name] = total
        else:
            held[name] = _reasons(_obj(room.get('subtotal')).get('reasons')) or ['room_subtotal_unverified']
            unit = normalize_price_unit(room.get('unit'))
            if unit is not None:
                held_units[name] = unit
    held_rows = []
    for name, reasons in sorted(held.items()):
        entry = {'room': name, 'reasons': reasons}
        if name in held_units:
            entry['unit'] = held_units[name]
        held_rows.append(entry)
    result['heldRooms'] = held_rows
    if explicit:
        if chosen in confirmed:
            room = confirmed[chosen]
            result.update(status='confirmed', won=room['subtotalWon'], confirmedRooms=[room])
            if 'unit' in room:
                result['unit'] = room['unit']
        else:
            result['reasons'] = held.get(chosen, ['room_unverified'])
            if chosen in held_units:
                result['unit'] = held_units[chosen]
    elif confirmed:
        amounts = [int(room['subtotalWon']) for room in confirmed.values()]
        result.update(status='confirmed', minWon=str(min(amounts)), maxWon=str(max(amounts)),
                      confirmedRooms=list(confirmed.values()))
    else:
        result['reasons'] = ['no_confirmed_room_subtotal']
    return result


def _area_conditions(supply, selection, holds, *, approved_tolerance=None):
    percent = DEFAULT_TOLERANCE
    if approved_tolerance is not None:
        percent = approved_tolerance
    elif 'areaTolerancePercent' in selection:
        proposed = _area_decimal(selection['areaTolerancePercent'])
        if proposed is None or proposed <= 0 or proposed > MAX_AREA_TOLERANCE:
            holds.append(_hold('area_tolerance_invalid', subject='selection'))
        elif proposed == DEFAULT_TOLERANCE or selection.get('areaChangeConfirmed') is True:
            percent = proposed
        else:
            holds.append(_hold('area_change_confirmation_required', subject='selection'))
    # 두 입력의 모든 자릿수와 백분율의 소수 이동을 보존한다.
    with localcontext(Context(prec=len(format(supply, 'f')) + len(format(percent, 'f')) + 4)):
        delta = supply * percent / 100
        lower, upper = supply - delta, supply + delta
    return {'basis': 'supply', 'tolerancePercent': _as_decimal_string(percent),
            'minM2': _as_decimal_string(lower), 'maxM2': _as_decimal_string(upper)}, (lower, upper)


def _period(ingestion):
    stored = _obj(ingestion.get('period'))
    try:
        if stored.get('source') == 'user_confirmed':
            canonical = trade_period(ingestion.get('asOf'), stored.get('start'), stored.get('end'))
        elif stored.get('source') == 'default_recent_year':
            canonical = trade_period(ingestion.get('asOf'))
        else:
            return None
    except (ValueError, OverflowError):
        return None
    return canonical if all(stored.get(key) == value for key, value in canonical.items()) else None


def _comparison_period(ingestion, override):
    if not isinstance(override, dict) or set(override) != {'start', 'end'}:
        raise ValueError('승인된 비교 기간에는 start와 end만 지정해야 합니다.')
    start, end = override['start'], override['end']
    if _text(start) is None or _text(end) is None:
        raise ValueError('승인된 비교 기간의 시작일과 종료일이 올바르지 않습니다.')
    original = _period(ingestion)
    if original is None or original['status'] != 'confirmed':
        raise ValueError('원본 수집본의 확정된 거래 기간을 확인할 수 없습니다.')
    period = trade_period(original['asOf'], start, end)
    if not (original['start'] <= period['start'] and period['end'] <= original['end']):
        raise ValueError('승인된 비교 기간이 원본 수집본의 거래 기간 범위를 벗어났습니다.')
    return period


def _comparison_conditions(ingestion, comparison_period, comparison_conditions):
    override_period = None if comparison_period is None else _comparison_period(ingestion, comparison_period)
    if comparison_conditions is None:
        return {'period': override_period, 'areaTolerancePercent': None, 'tradeKinds': None, 'replacements': None}
    if (not isinstance(comparison_conditions, dict) or not comparison_conditions
            or not set(comparison_conditions) <= ALLOWED_CONDITION_KEYS):
        raise ValueError('승인된 비교 조건 형식이 올바르지 않습니다.')
    if 'period' in comparison_conditions:
        cond_period = _comparison_period(ingestion, comparison_conditions['period'])
        if override_period is not None and override_period != cond_period:
            raise ValueError('승인된 비교 기간과 비교 조건의 기간이 일치하지 않습니다.')
        override_period = cond_period
    area_tolerance = None
    if 'areaTolerancePercent' in comparison_conditions:
        area_tolerance = _approved_tolerance_decimal(comparison_conditions['areaTolerancePercent'])
        if area_tolerance is None:
            raise ValueError('승인된 공급면적 허용 범위가 올바르지 않습니다.')
    trade_kinds = None
    if 'tradeKinds' in comparison_conditions:
        requested_kinds = comparison_conditions['tradeKinds']
        original_kinds = ingestion.get('tradeKinds')
        if (not _unique_values(requested_kinds, lambda kind: kind in TRADE_KINDS)
                or not _unique_values(original_kinds, lambda kind: kind in TRADE_KINDS)
                or not set(requested_kinds) <= set(original_kinds)):
            raise ValueError('승인된 거래 종류가 원본 수집본의 범위를 벗어났습니다.')
        trade_kinds = [kind for kind in TRADE_KINDS if kind in requested_kinds]
    replacements = None
    if 'replacements' in comparison_conditions:
        raw_replacements = comparison_conditions['replacements']
        if not isinstance(raw_replacements, list) or len(raw_replacements) > MAX_COMPARABLES:
            raise ValueError('승인된 단지 교체 목록 형식이 올바르지 않습니다.')
        seen_in, seen_out, normalized = set(), set(), []
        for item in raw_replacements:
            if not isinstance(item, dict) or set(item) != {'complexId', 'replaceComplexId'}:
                raise ValueError('승인된 단지 교체 항목에는 complexId와 replaceComplexId만 지정해야 합니다.')
            incoming = _complex_id_text(item['complexId'])
            outgoing = _complex_id_text(item['replaceComplexId'])
            if (incoming is None or outgoing is None or incoming == outgoing
                    or incoming in seen_in or outgoing in seen_out):
                raise ValueError('승인된 단지 교체 항목이 중복되었거나 올바르지 않습니다.')
            seen_in.add(incoming)
            seen_out.add(outgoing)
            normalized.append({'complexId': incoming, 'replaceComplexId': outgoing})
        if seen_in & seen_out:
            raise ValueError('승인된 단지 교체 항목이 서로 충돌합니다.')
        normalized.sort(key=lambda pair: (pair['replaceComplexId'], pair['complexId']))
        replacements = normalized
    return {
        'period': override_period,
        'areaTolerancePercent': area_tolerance,
        'tradeKinds': trade_kinds,
        'replacements': replacements,
    }


def _unique_values(value, valid):
    return (isinstance(value, list) and bool(value) and all(valid(item) for item in value)
            and len(value) == len(set(value)))


def _lawd(value):
    return _matches(r'[0-9]{5}', value)


def _regions(evidence):
    declarations = [_obj(region) for region in _items(evidence.get('regions'))]
    regions, _ = _unique(declarations, lambda row: _text(row.get('localityCode')))
    accepted, by_code, by_name = {}, defaultdict(set), defaultdict(set)
    for code, region in regions.items():
        district, municipality = region.get('districtCode'), region.get('municipalityCode')
        locality_type = region.get('localityType')
        if (not _lawd(region.get('requestRegionCode')) or not _confirmed_proof(region)
                or locality_type not in ('dong', 'eup', 'myeon') or not _text(region.get('localityName'))
                or 'districtCode' not in region or (district is not None and not _text(district))
                or (municipality is not None and not _text(municipality))
                or (district is None and municipality is None)):
            continue
        subdivisions = region.get('subLocalities', [])
        if not isinstance(subdivisions, list) or (subdivisions and locality_type == 'dong'):
            continue
        members = [{'name': region['localityName'], 'umdCd': region.get('umdCd')}]
        members.extend(_obj(item) for item in subdivisions)
        if any(not _text(item.get('name')) or (item.get('umdCd') is not None and not _text(item['umdCd']))
               or item.get('status', 'confirmed') != 'confirmed' for item in members):
            continue
        accepted[code] = region
        for member in members:
            request = region['requestRegionCode']
            by_name[request, member['name']].add(code)
            if member.get('umdCd') is not None:
                by_code[request, member['umdCd']].add((code, member['name']))
    unresolved = [row for row in declarations if accepted.get(_text(row.get('localityCode'))) is not row]
    return accepted, by_code, by_name, unresolved


def _complexes(evidence, regions):
    complexes, _ = _unique(_items(evidence.get('complexes')), lambda row: _text(row.get('complexId')))
    return {key: value for key, value in complexes.items()
            if _text(value.get('name')) and _text(value.get('localityCode')) in regions
            and _confirmed_proof(value)}


def _target_complex(evidence, catalog, target, complexes):
    link = _obj(evidence.get('target'))
    notice_link, notice = _obj(link.get('notice')), _obj(catalog.get('notice'))
    source, address = notice.get('source'), _reported(_obj(notice.get('fields')).get('HSSPLY_ADRES'))
    proof = _confirmed_proof(link)
    page, position = notice_link.get('page'), notice_link.get('position')
    positions = [_catalog_position(_obj(ref), 'notice') for ref in _items(notice.get('evidence'))]
    complex_ = complexes.get(_text(link.get('complexId')))
    if (complex_ is None or not _same_target(link, target) or not proof
            or notice.get('status') != 'reported' or source not in NOTICE_SOURCES
            or notice_link.get('source') != source or address is None or notice_link.get('address') != address
            or not _number(page, 1) or not _number(position, 1) or positions.count((page, position)) != 1):
        return None, None
    return complex_, {'source': source, 'page': page, 'position': position, 'address': address, 'linkEvidence': proof}


def _scope(evidence, role, target_region, regions, unresolved):
    value = _obj(_obj(evidence.get('scopes')).get(role))
    requests, proof = value.get('requestRegionCodes'), _confirmed_proof(value)
    if role == 'priority':
        field = 'localityCode'
        kind = target_region['localityType']
    else:
        kind, field = ('district', 'districtCode') if target_region['districtCode'] else ('municipality', 'municipalityCode')
    code = target_region[field]
    localities = {key for key, region in regions.items() if region.get(field) == code}
    verified_requests = {regions[key]['requestRegionCode'] for key in localities}
    if (value.get('code') != code or not proof or value.get('kind', kind if role == 'priority' else None) != kind
            or not _unique_values(requests, _lawd) or set(requests) != verified_requests):
        return None
    # 소속이 미확인된 지역을 목록에서 빼면 좁혀진 수집 범위가 전체 범위로 보일 수 있다.
    for region in unresolved:
        membership = _text(region.get(field))
        request = region.get('requestRegionCode')
        if membership == code or (membership is None and (role == 'expansion' or not _lawd(request) or request in requests)):
            return None
    return ({'kind': kind, 'code': code, 'name': target_region['localityName'] if role == 'priority' else _text(value.get('name')),
             'requestRegionCodes': list(requests), 'evidence': proof}, localities)


def _batch_key(record):
    source, code, month = record.get('source'), record.get('requestRegionCode'), record.get('month')
    if _text(source) in SOURCE_KINDS and _lawd(code) and _matches(r'[0-9]{4}-(?:0[1-9]|1[0-2])', month):
        return source, code, month
    return None


def _record_id(key):
    source, code, month = key
    return f'col-{source}-{code}-{month.replace("-", "")}'


def _reference(record, row):
    location = _obj(row.get('provenance'))
    page, position = location.get('page'), location.get('position')
    if (row.get('normalizerVersion') != NORMALIZER_VERSION or location.get('source') != record['source']
            or location.get('request') != {'LAWD_CD': record['requestRegionCode'],
                                           'DEAL_YMD': record['month'].replace('-', '')}
            or not _number(page, 1) or not _number(position, 1)):
        return None
    return {'recordId': record['recordId'], 'source': record['source'], 'page': page, 'position': position}


def _row_key(value):
    source, record = _text(value.get('source')), _text(value.get('recordId'))
    page, position = value.get('page'), value.get('position')
    if record and source in SOURCE_KINDS and _number(page, 1) and _number(position, 1):
        return record, source, page, position
    return None


def _page_layout_matches(positions, expected, total):
    if total == 0:
        return expected == 1 and not positions
    pages = defaultdict(set)
    for page, position in positions:
        pages[page].add(position)
    if len(pages) != expected or min(pages) != 1 or max(pages) != expected:
        return False
    size = len(pages[1])
    return all(min(values) == 1 and max(values) == len(values)
               and (len(values) == size if page < expected else len(values) <= size)
               for page, values in pages.items())


def _collection_entry(key, kinds, record=None, status='missing', reasons=()):
    source, code, month = key
    record = record or {}
    error = _obj(record.get('error'))
    error_code, layer = error.get('code'), error.get('layer')
    return {'recordId': _record_id(key), 'source': source, 'tradeKinds': list(kinds),
            'requestRegionCode': code, 'month': month, 'status': status, 'reasons': list(reasons),
            'reportedTotalCount': record.get('reportedTotalCount') if _number(record.get('reportedTotalCount')) else None,
            'rowsReceived': record.get('rowsReceived') if _number(record.get('rowsReceived')) else None,
            'pagesExpected': record.get('pagesExpected') if _number(record.get('pagesExpected'), 1) else None,
            'totalCountChanged': record.get('totalCountChanged') if isinstance(record.get('totalCountChanged'), bool) else None,
            'missingPages': [page for page in _items(record.get('missingPages')) if _number(page, 1)],
            'collectedAt': _timestamp(record.get('collectedAt')),
            'error': {'code': error_code, 'layer': layer if _matches(r'[a-z_]+', layer) else None}
            if _matches(r'[a-z0-9_]{1,80}', error_code) else None}


def _read_batches(ingestion, period, trade_kinds):
    batches = [(_obj(_obj(batch).get('record')), _obj(batch)) for batch in _items(ingestion.get('tradeBatches'))]
    records = {id_: key for record, _ in batches
               if (id_ := _text(record.get('recordId'))) and (key := _batch_key(record)) and id_ == _record_id(key)}
    ids = Counter(_text(record.get('recordId')) for record, _ in batches)
    groups = defaultdict(list)
    for record, batch in batches:
        key = _batch_key(record)
        if key:
            groups[key].append((record, batch))

    coverage, observations, replayed = {}, [], set()
    months = set(period['months'])
    captured_all = ingestion.get('tradeKinds')
    for key, group in groups.items():
        source, code, month = key
        kinds = [kind for kind in trade_kinds if kind in SOURCE_KINDS[source]]
        captured_kinds = [kind for kind in captured_all if kind in SOURCE_KINDS[source]] if isinstance(captured_all, list) else kinds
        if not kinds or code not in ingestion['requestRegionCodes'] or month.replace('-', '') not in months:
            continue
        record, batch = group[0]
        if len(group) != 1 or record.get('recordId') != _record_id(key) or ids[_record_id(key)] != 1:
            coverage[key] = _collection_entry(key, kinds, status='partial', reasons=['collection_identity_conflict'])
            continue
        rows = _items(batch.get('trades'))
        located = [(_obj(row), _reference(record, _obj(row))) for row in rows]
        locators = Counter(_row_key(ref) for _, ref in located if ref)
        replayed.update(locators)
        if record.get('status') == 'failed' and not rows:
            coverage[key] = _collection_entry(key, kinds, record, 'failed', _reasons(batch.get('reasons')))
            continue
        positions = [(ref['page'], ref['position']) for _, ref in located if ref]
        reported, expected = record.get('reportedTotalCount'), record.get('pagesExpected')
        flags = _reasons(batch.get('reasons'))
        complete = (
            record.get('status') in ('complete', 'empty') and isinstance(batch.get('trades'), list)
            and isinstance(batch.get('reasons'), list) and not batch['reasons'] and record.get('tradeKinds') == captured_kinds
            and type(reported) is int and _number(record.get('rowsReceived')) and reported == record['rowsReceived']
            and reported == len(rows) == len(positions) == len(locators)
            and record.get('totalCountChanged') is False and record.get('missingPages') == []
            and 'error' in record and record['error'] is None and _timestamp(record.get('collectedAt'))
            and _number(expected, 1)
            and (record['status'] == 'empty') == (reported == 0) and _page_layout_matches(positions, expected, reported)
        )
        if not complete:
            flags = flags or ['collection_coverage_unverified']
        entry = _collection_entry(key, kinds, record, record['status'] if complete else 'partial', flags)
        coverage[key] = entry
        for row, ref in located:
            invalid = not ref or locators[_row_key(ref)] != 1 or record.get('status') == 'failed'
            if not invalid and _number(expected, 1) and ref['page'] > expected:
                invalid = True
            observations.append((key, row, ref, entry['collectedAt'], invalid))
    return coverage, observations, replayed, records


def _identifier(value):
    if type(value) is int:
        return str(value)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _observed_region(source, code, identifiers, by_code, by_name):
    reported = identifiers.get('sggCd')
    if not isinstance(reported, str) or reported.strip() != code:
        return None
    name, observed_code = _identifier(identifiers.get('umdNm')), identifiers.get('umdCd')
    if source == 'apt_trade' and observed_code not in (None, ''):
        matches = by_code.get((code, _text(observed_code)), ())
        if len(matches) == 1:
            locality, observed_name = next(iter(matches))
            return locality if name is None or name == observed_name else None
        return None
    matches = by_name.get((code, name), ())
    return next(iter(matches)) if len(matches) == 1 else None


def _address_keys(identifiers, locality, region):
    name, serial, parcel, main, sub, road, road_no, road_sub = (
        _identifier(identifiers.get(field)) for field in
        ('aptNm', 'aptSeq', 'jibun', 'bonbun', 'bubun', 'roadNm', 'roadNmBonbun', 'roadNmBubun')
    )
    keys = []
    if not name:
        return keys
    if parcel:
        keys.append(('parcel', locality, name, parcel))
    if main and sub:
        keys.append(('parcel_parts', locality, name, _identifier(identifiers.get('landCd')), main, sub))
    if road and road_no:
        keys.append(('road', region, name, road, road_no, road_sub))
    if keys and serial:
        keys.append(('apt_seq', region, serial))
    return keys


def _contract_day(row):
    contract = _obj(row.get('contractDate'))
    return _calendar_day(contract.get('date')) if contract.get('status') == 'parsed' else None


def _cancellation(row):
    value = _obj(row.get('cancellation'))
    type_state = _obj(value.get('cdealType')).get('state')
    date_state = _obj(value.get('cdealDay')).get('state')
    if value.get('status') == 'cancelled' and (type_state == 'marked' or date_state == 'date'):
        return 'cancelled'
    if value.get('status') == 'not_marked' and type_state == date_state == 'blank':
        return 'not_marked'
    return None


def _known_kind(source, row):
    kind, state = row.get('tradeKind'), _obj(row.get('tradeKindBasis')).get('state')
    states = {'sale': 'source_service', 'presale_right': 'explicit_blank', 'occupancy_right': 'occupancy_mark'}
    if kind in SOURCE_KINDS[source] and state == states[kind]:
        return kind
    return None


def _identifiers_match(source, identifiers, link):
    recorded = _obj(link.get('identifiers'))
    return (identifiers.keys() == recorded.keys() and all(
        key in IDENTIFIER_FIELDS[source] and type(value) is type(recorded[key]) and value == recorded[key]
        for key, value in identifiers.items()
    ))


def _mark(row, judgment, reason=None):
    row.update(judgment=judgment, reason=reason)
    return row


def _classify(observation, links, duplicate_links, complexes, region_index, period, trade_kinds, target_id):
    (source, request, month), row, reference, collected_at, bad_location = observation
    kind = _known_kind(source, row)
    identifiers = _obj(row.get('identifiers'))
    local = _observed_region(source, request, identifiers, *region_index)
    result = {'scopeKey': (source, request, month), 'reference': reference, 'tradeKind': kind,
              'localityCode': local, 'complexId': None, 'isTarget': False, 'collectedAt': collected_at}
    if bad_location:
        # 원행 위치가 충돌하면 어느 행을 판정했는지 확인할 수 없다.
        result['localityCode'] = None
        result['tradeKind'] = None
        return _mark(result, 'hold', 'trade_row_location_unverified')
    day, cancellation = _contract_day(row), _cancellation(row)
    if day is not None and not period['start'] <= day.isoformat() <= period['end']:
        return _mark(result, 'exclusion', 'outside_contract_period')
    if cancellation == 'cancelled':
        return _mark(result, 'exclusion', 'cancelled_trade')
    if kind is not None and kind not in trade_kinds:
        return _mark(result, 'exclusion', 'trade_kind_not_included')

    key = _row_key(reference)
    if key in duplicate_links:
        return _mark(result, 'hold', 'trade_link_conflict')
    if local is None:
        return _mark(result, 'hold', 'trade_region_membership_unverified')
    link = links.get(key)
    if link is None:
        return _mark(result, 'hold', 'trade_link_unverified')
    if link.get('status') == 'conflict':
        return _mark(result, 'hold', 'trade_link_conflict')
    complex_id = _text(link.get('complexId'))
    complex_ = complexes.get(complex_id)
    proof = _confirmed_proof(link)
    exclusive = _obj(row.get('exclusiveArea'))
    exclusive_m2 = _area(exclusive.get('m2'))
    address_keys = _address_keys(identifiers, local, request)
    if (complex_ is None or complex_['localityCode'] != local or not proof or not address_keys
            or set(IDENTIFIER_FIELDS[source]).intersection(
                field for field in _items(row.get('withheldFields')) if isinstance(field, str))
            or not _identifiers_match(source, identifiers, link)):
        return _mark(result, 'hold', 'trade_complex_identity_unverified')
    result.update(complexId=complex_id, identityKeys=address_keys, evidence=proof, isTarget=complex_id == target_id)
    if (exclusive.get('status') != 'parsed' or exclusive.get('basis') != 'exclusive' or exclusive_m2 is None
            or _area(link.get('exclusiveAreaM2')) != exclusive_m2):
        return _mark(result, 'hold', 'trade_exclusive_area_binding_unverified')
    supply = _area(link.get('supplyAreaM2')) if link.get('supplyAreaBasis', 'supply') == 'supply' else None
    result.update(exclusiveAreaM2=exclusive['m2'], exclusive=exclusive_m2, supply=supply)
    if kind is None or day is None or day.isoformat()[:7] != month or cancellation != 'not_marked':
        return _mark(result, 'hold', 'trade_validity_unverified')
    amount = _obj(row.get('amount'))
    won = _won(amount.get('won'))
    if amount.get('status') != 'parsed' or won is None:
        return _mark(result, 'hold', 'trade_amount_unverified')
    if supply is None:
        return _mark(result, 'hold', 'trade_supply_area_unverified')
    attrs = _obj(row.get('attributes'))
    result.update(amount=won, contractDate=day.isoformat(),
                  floor=_identifier(attrs.get('floor')), buildYear=_identifier(attrs.get('buildYear')))
    return _mark(result, 'eligible')


def _mark_conflicting_links(rows):
    identities, areas = defaultdict(set), defaultdict(set)
    for row in rows:
        for key in row.get('identityKeys', ()):
            identities[key].add(row['complexId'])
        if row.get('supply') is not None:
            areas[row['complexId'], row['exclusive']].add(row['supply'])
    for row in rows:
        if any(len(identities[key]) > 1 for key in row.get('identityKeys', ())):
            row.update(isTarget=False, complexId=None, supply=None)
            _mark(row, 'hold', 'trade_complex_identity_conflict')
        elif row.get('supply') is not None and len(areas[row['complexId'], row['exclusive']]) > 1:
            row['supply'] = None
            _mark(row, 'hold', 'trade_supply_area_conflict')


def _trade_evidence_holds(evidence, replayed, records):
    rows = _items(evidence.get('tradeLinks'))
    links, duplicates = _unique(rows, _row_key)
    extra = []
    for key in (set(links) | duplicates) - replayed:
        record_id, source, page, position = key
        extra.append((records.get(record_id), _hold('trade_evidence_not_replayed', subject='trade_evidence',
                     reference={'recordId': record_id, 'source': source, 'page': page, 'position': position})))
    if any(_row_key(_obj(row)) is None for row in rows):
        extra.append((None, _hold('trade_evidence_locator_invalid', subject='trade_evidence')))
    extra.sort(key=lambda item: str(item[1].get('reference')))
    return links, duplicates, extra


def _coordinates(complex_):
    coord = _obj(complex_.get('coordinates'))
    lat = _decimal(coord.get('latitude'), signed=True)
    lon = _decimal(coord.get('longitude'), signed=True)
    proof = _proof(coord.get('evidence'))
    if (coord.get('status', 'confirmed') == 'confirmed' and lat is not None and lon is not None
            and -90 <= lat <= 90 and -180 <= lon <= 180 and proof):
        return lat, lon, proof
    return None


def _distance(target, candidate):
    first, second = _coordinates(target), _coordinates(candidate)
    if first is None or second is None:
        conflicts = [_proof(coord.get('evidence')) for complex_ in (target, candidate)
                     if (coord := _obj(complex_.get('coordinates'))).get('status') == 'conflict']
        if conflicts:
            return {'kind': 'straight_line', 'status': 'conflict', 'meters': None,
                    'evidence': [proof for proof in conflicts if proof]}
        return {'kind': 'straight_line', 'status': 'unverified', 'meters': None, 'evidence': []}
    lat1, lat2 = (math.radians(point[0]) for point in (first, second))
    d_lat, d_lon = (math.radians(_difference(first[i], second[i])) for i in range(2))
    a = math.sin(d_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(d_lon / 2) ** 2
    meters = 2 * MEAN_EARTH_RADIUS_M * math.asin(math.sqrt(max(0, min(1, a))))
    return {'kind': 'straight_line', 'status': 'confirmed', 'meters': meters, 'evidence': [first[2], second[2]]}


def _difference(area, target):
    with localcontext(Context(prec=len(format(area, 'f')) + len(format(target, 'f')))):
        return (area - target).copy_abs()


def _row_item(row, reason, role, **detail):
    return _hold(reason, scope=role, subject='trade', tradeKind=row['tradeKind'], reference=row['reference'],
                 complexId=row['complexId'], localityCode=row['localityCode'], **detail)


def _nearest_areas(rows, target_area, role):
    by_complex = defaultdict(list)
    for row in rows:
        by_complex[row['complexId']].append(row)
    selected, holds, unresolved = {}, [], []
    for complex_id, group in by_complex.items():
        differences = {area: _difference(area, target_area) for area in {row['supply'] for row in group}}
        closest = min(differences.values())
        areas = [area for area, difference in differences.items() if difference == closest]
        if len(areas) > 1:
            holds.append(_hold('closest_supply_area_tie', scope=role, subject='supply_area', decisionId='D-03',
                               complexId=complex_id, areasM2=[_as_decimal_string(area) for area in sorted(areas)],
                               references=[row['reference'] for row in group if row['supply'] in areas]))
            unresolved.extend(group)
        else:
            selected[complex_id] = (areas[0], closest, [row for row in group if row['supply'] == areas[0]])
    return selected, holds, unresolved


def _collection_status(records):
    if all(record['status'] in ('complete', 'empty') for record in records):
        return 'complete'
    if all(record['status'] == 'failed' for record in records):
        return 'failed'
    if all(record['status'] in ('missing', 'failed') for record in records):
        return 'unavailable'
    return 'partial'


def _screen_scope(role, area_scope, rows, coverage, extra, trade_kinds, period, area, bounds):
    scope, localities = area_scope
    requests = scope['requestRegionCodes']
    records = []
    for request in requests:
        for month in period['months']:
            for source, supported in SOURCE_KINDS.items():
                kinds = [kind for kind in trade_kinds if kind in supported]
                if kinds:
                    key = (source, request, f'{month[:4]}-{month[4:]}')
                    records.append(coverage.get(key) or _collection_entry(key, kinds, reasons=['collection_not_replayed']))
    needed = {_batch_key(record) for record in records}
    holds = [_hold(reason, scope=role, subject='collection', recordId=record['recordId'], source=record['source'],
                   tradeKinds=record['tradeKinds'])
             for record in records if record['status'] not in ('complete', 'empty')
             for reason in (record['reasons'] or ['collection_' + record['status']])]
    relevant_extra = [(key, item) for key, item in extra if key is None or key in needed]
    holds.extend({**item, 'scope': role} for _, item in relevant_extra)
    exclusions, eligible, own_rows, own_holds, unresolved = [], [], [], [], []
    for row in rows:
        if row['scopeKey'] not in needed or (row['localityCode'] and row['localityCode'] not in localities):
            if row['localityCode'] is not None and row['judgment'] != 'exclusion':
                exclusions.append(_row_item(row, 'outside_applied_region', role))
            continue
        if row['judgment'] == 'exclusion':
            exclusions.append(_row_item(row, row['reason'], role))
            continue
        if row['isTarget']:
            exclusions.append(_row_item(row, 'target_complex_trade', role))
        supply = row.get('supply')
        if supply is not None and not bounds[0] <= supply <= bounds[1]:
            exclusions.append(_row_item(row, 'outside_supply_area', role, targetReference=row['isTarget'],
                                        supplyAreaM2=_as_decimal_string(supply), evidence=row['evidence']))
        elif row['judgment'] == 'hold':
            if row['isTarget']:
                own_holds.append(_row_item(row, row['reason'], role, targetReference=True))
            else:
                holds.append(_row_item(row, row['reason'], role))
                unresolved.append(row)
        elif row['isTarget']:
            own_rows.append(row)
        else:
            eligible.append(row)

    selected, area_holds, area_unresolved = _nearest_areas(eligible, area, role)
    target, target_holds, _ = _nearest_areas(own_rows, area, role)
    holds.extend(area_holds)
    unresolved.extend(area_unresolved)
    own_holds.extend({**item, 'targetReference': True} for item in target_holds)
    kind_decisions = {}
    for kind in trade_kinds:
        kind_records = [record for record in records if kind in record['tradeKinds']]
        kind_coverage = _collection_status(kind_records)
        pending = sum(row['tradeKind'] in (None, kind) and kind in SOURCE_KINDS[row['scopeKey'][0]] for row in unresolved)
        pending += sum(key is None or kind in SOURCE_KINDS[key[0]] for key, _ in relevant_extra)
        # 모든 확인 단지의 선정 면적을 확인한 뒤, 종류별 후보 수와 화면에 표시할 후보 수를 따로 센다.
        count = sum(any(row['tradeKind'] == kind for row in group) for _, _, group in selected.values())
        if count:
            conclusion = 'candidates_found'
        elif kind_coverage == 'failed':
            conclusion = 'lookup_failed'
        elif pending or kind_coverage != 'complete':
            conclusion = 'held'
        else:
            conclusion = 'normal_zero'
        kind_decisions[kind] = {'conclusion': conclusion, 'confirmedCandidateCount': count,
                                'unresolvedRows': pending, 'collectionStatus': kind_coverage,
                                'recordIds': [record['recordId'] for record in kind_records]}
    status = _collection_status(records)
    decision = {**scope, 'conclusion': 'candidates_found' if selected else 'held' if holds else 'normal_zero',
                'confirmedCandidateCount': len(selected), 'unresolvedRows': len(unresolved) + len(relevant_extra),
                'collectionStatus': status, 'screeningStatus': 'incomplete' if holds else 'complete',
                'tradeKinds': kind_decisions}
    return {'decision': decision, 'records': records, 'selected': selected, 'target': target, 'holds': holds,
            'ownHolds': own_holds, 'exclusions': exclusions, 'localities': localities}


def _characteristics(complex_):
    results = []
    for item in _items(complex_.get('characteristics')):
        item = _obj(item)
        field, status, proof = item.get('field'), item.get('status'), _proof(item.get('evidence'))
        if field not in ('householdCount', 'approvalDate') or status not in ('confirmed', 'conflict', 'failed', 'empty') or not proof:
            continue
        result = {'field': field, 'status': status, 'evidence': proof}
        value = item.get('value')
        if status == 'confirmed':
            valid = _number(value, 1) if field == 'householdCount' else _calendar_day(value) is not None
            if not valid:
                continue
            result['value'] = value
        elif status == 'failed' and _matches(r'[a-zA-Z0-9_]{1,80}', item.get('errorCode')):
            result['errorCode'] = item['errorCode']
        results.append(result)
    return results


def _median_won(amounts):
    middle = len(amounts) // 2
    if len(amounts) % 2:
        return str(amounts[middle])
    whole, half = divmod(amounts[middle - 1] + amounts[middle], 2)
    return f'{whole}.5' if half else str(whole)


def _statistic(rows, kind, provisional):
    amounts = sorted(row['amount'] for row in rows)
    observations = [{**row['reference'], **{key: row[key] for key in
                     ('contractDate', 'exclusiveAreaM2', 'floor', 'buildYear', 'collectedAt', 'evidence')},
                     'won': str(row['amount'])} for row in rows]
    return {'status': 'provisional' if provisional else 'confirmed',
            'priceMeaning': 'sale_transaction_amount' if kind == 'sale' else 'reported_rights_transaction_amount',
            'count': len(amounts), 'minWon': str(amounts[0]), 'maxWon': str(amounts[-1]),
            'medianWon': _median_won(amounts), 'smallSample': len(amounts) <= 2, 'observations': observations}


def _candidate(complex_, selected, target, region, provisional):
    supply, difference, rows = selected
    grouped = defaultdict(list)
    for row in rows:
        grouped[row['tradeKind']].append(row)
    return {'complexId': complex_['complexId'], 'name': complex_['name'], 'localityCode': complex_['localityCode'],
            'supplyAreaM2': _as_decimal_string(supply), 'areaDifferenceM2': _as_decimal_string(difference),
            'identityEvidence': _proof(complex_['evidence']), 'regionEvidence': _proof(region['evidence']),
            'distance': _distance(target, complex_), 'rank': None,
            'tradeStats': {kind: _statistic(group, kind, provisional) for kind, group in grouped.items()},
            'characteristics': _characteristics(complex_)}


def _rank(candidates, role, provisional):
    ordered = sorted(candidates.values(), key=lambda candidate: Decimal(candidate['areaDifferenceM2']))
    selected, holds = [], []
    for _, area_group in groupby(ordered, key=lambda candidate: Decimal(candidate['areaDifferenceM2'])):
        if len(selected) == MAX_COMPARABLES:
            break
        group = list(area_group)
        if len(group) == 1:
            buckets, hold_reason = [group], None
        elif any(row['distance']['meters'] is None for row in group):
            buckets = [group]
            hold_reason = ('straight_line_coordinate_conflict' if any(row['distance']['status'] == 'conflict' for row in group)
                           else 'straight_line_distance_unverified')
        else:
            by_distance = sorted(group, key=lambda row: row['distance']['meters'])
            buckets = [list(rows) for _, rows in groupby(by_distance, key=lambda row: row['distance']['meters'])]
            hold_reason = 'straight_line_distance_tie'
        for bucket in buckets:
            remaining = MAX_COMPARABLES - len(selected)
            if not remaining:
                break
            tied = len(bucket) > 1
            if tied:
                holds.append(_hold(hold_reason, scope=role, subject='ranking', decisionId='D-03',
                                   complexIds=[row['complexId'] for row in bucket],
                                   affectsSelection=len(bucket) > remaining))
            if len(bucket) > remaining:
                return selected, holds  # 남은 자리를 차순위로 채우면 보류한 동률을 임의로 건너뛰게 된다.
            selection_reason = 'area_difference_rank_pending' if tied else 'area_difference_then_straight_line'
            for row in bucket:
                rank = None if tied or provisional else len(selected) + 1
                selected.append({**row, 'rank': rank, 'selectionReason': selection_reason})
    return selected, holds


def _replace(selected, candidates, selection, complexes, localities, role,
             *, approved_replacements=None, active_holds=(), active_exclusions=()):
    if approved_replacements is not None:
        raw_changes = approved_replacements
    elif 'replacements' in selection:
        if not isinstance(selection['replacements'], list):
            return selected, [_hold('replacement_request_invalid', scope=role, subject='selection')]
        raw_changes = selection['replacements']
    else:
        return selected, []
    if not raw_changes:
        return selected, []
    changes = [_obj(change) for change in raw_changes]
    new_keys = Counter(_text(change.get('complexId')) for change in changes)
    old_keys = Counter(_text(change.get('replaceComplexId')) for change in changes)
    positions = {row['complexId']: index for index, row in enumerate(selected)}
    holds = []
    for change in changes:
        incoming, outgoing = (_text(change.get(key)) for key in ('complexId', 'replaceComplexId'))
        detail = {'scope': role, 'subject': 'selection', 'complexId': incoming, 'replaceComplexId': outgoing}
        if outgoing not in positions:
            holds.append(_hold('replacement_target_required', **detail))
        elif incoming not in candidates or incoming in positions:
            if incoming in positions:
                cause = 'already_selected'
            else:
                locality = _obj(complexes.get(incoming)).get('localityCode')
                if locality and locality not in localities:
                    cause = 'outside_applied_region'
                elif incoming not in complexes or any(
                    h.get('complexId') == incoming or incoming in _items(h.get('complexIds'))
                    for h in active_holds
                ):
                    cause = 'candidate_unverified'
                elif any(
                    e.get('complexId') == incoming and e.get('reasonCode') == 'outside_supply_area'
                    for e in active_exclusions
                ):
                    cause = 'outside_supply_area'
                else:
                    cause = 'comparison_conditions_unmet'
            holds.append(_hold('replacement_candidate_ineligible', candidateReason=cause, **detail))
        elif new_keys[incoming] > 1 or old_keys[outgoing] > 1:
            holds.append(_hold('replacement_request_conflict', **detail))
        else:
            selected[positions[outgoing]] = {**candidates[incoming], 'selectionReason': 'manual_replacement',
                                              'replacesComplexId': outgoing}
    return selected, holds


def _candidate_pool(complexes, regions, candidates, comparables, active, target_complex):
    displayed_ids = {row['complexId'] for row in comparables}
    localities = active['localities']
    active_holds = active['holds']
    active_exclusions = active['exclusions']
    eligible_items, ineligible_items = [], []
    for complex_id, complex_ in complexes.items():
        if complex_id == target_complex['complexId']:
            continue
        locality_code = complex_['localityCode']
        locality_name = regions[locality_code]['localityName']
        if complex_id in candidates:
            cand = candidates[complex_id]
            dist = cand['distance']['meters']
            eligible_items.append((
                (Decimal(cand['areaDifferenceM2']), dist is None, dist if dist is not None else 0.0, complex_id),
                {
                    'complexId': complex_id,
                    'name': complex_['name'],
                    'localityCode': locality_code,
                    'localityName': locality_name,
                    'eligible': True,
                    'selected': complex_id in displayed_ids,
                    'supplyAreaM2': cand['supplyAreaM2'],
                    'areaDifferenceM2': cand['areaDifferenceM2'],
                    'tradeKinds': sorted(cand['tradeStats'].keys(), key=TRADE_KINDS.index),
                    'reasonCode': None,
                },
            ))
            continue
        supply_area_m2 = None
        if locality_code not in localities:
            reason_code = 'outside_applied_region'
        else:
            matched_hold = next(
                (h for h in active_holds
                 if h.get('complexId') == complex_id or complex_id in _items(h.get('complexIds'))),
                None,
            )
            if matched_hold is not None:
                reason_code = matched_hold['reasonCode']
            else:
                area_excl = next(
                    (e for e in active_exclusions
                     if e.get('complexId') == complex_id and e.get('reasonCode') == 'outside_supply_area'),
                    None,
                )
                if area_excl is not None:
                    reason_code = 'outside_supply_area'
                    supply_area_m2 = area_excl.get('supplyAreaM2')
                else:
                    other_excl = next(
                        (e for e in active_exclusions
                         if e.get('complexId') == complex_id
                         and e.get('reasonCode') in ('outside_contract_period', 'trade_kind_not_included', 'cancelled_trade')),
                        None,
                    )
                    reason_code = other_excl['reasonCode'] if other_excl is not None else 'comparison_conditions_unmet'
        ineligible_items.append((
            (reason_code, complex_id),
            {
                'complexId': complex_id,
                'name': complex_['name'],
                'localityCode': locality_code,
                'localityName': locality_name,
                'eligible': False,
                'selected': False,
                'supplyAreaM2': supply_area_m2,
                'areaDifferenceM2': None,
                'tradeKinds': [],
                'reasonCode': reason_code,
            },
        ))
    eligible_items.sort(key=lambda item: item[0])
    ineligible_items.sort(key=lambda item: item[0])
    return [item[1] for item in eligible_items] + [item[1] for item in ineligible_items]


def compare_snapshot(ingestion: dict, selection: dict, evidence: Optional[dict] = None,
                     *, binding_issue: Optional[str] = None,
                     comparison_period: Optional[dict] = None,
                     comparison_conditions: Optional[dict] = None) -> dict:
    """BE-02 수집본의 범위와 행을 검증해 현재 분석에 적용할 비교 결과를 만든다.

    binding_issue는 DB 작업자가 고정된 분석 조건과 수집본의 연결을 검증하며 기록한 사유다.
    comparison_period는 서비스가 승인한 재계산 기간({start, end})이며 원본 수집 기간 안에서만 허용한다.
    comparison_conditions는 서비스가 승인한 비교 조건 재계산 값({period, areaTolerancePercent, tradeKinds, replacements})이다.
    가격·자체 거래·순위의 개별 상태를 함께 반환한다. 필수 수집과 주변 후보 판별의
    완전성이 증명될 때만 정상 0개로 판정하며, 순위에 필요한 미정값은 D-03으로 남긴다.
    """
    if (not isinstance(ingestion, dict) or ingestion.get('contractVersion') != 'ingestion/v0'
            or ingestion.get('dataOrigin') not in ('synthetic', 'collected')):
        raise ValueError('출처가 표시된 ingestion/v0 결과가 필요합니다.')
    approved = _comparison_conditions(ingestion, comparison_period, comparison_conditions)
    override_period = approved['period']
    result = {'contractVersion': 'comparison/v1', 'dataOrigin': ingestion['dataOrigin'],
              'completeness': 'unavailable', 'appliedScope': None, 'comparables': [], 'targetReferences': [],
              'candidatePool': [], 'holds': [], 'exclusions': [], 'target': None, 'noticePrice': None,
              'regionDecision': {'priority': None, 'expansion': None, 'reasonCode': None},
              'conditions': {'asOf': _text(ingestion.get('asOf')), 'period': override_period, 'area': None, 'tradeKinds': [],
                             'maxComparables': MAX_COMPARABLES,
                             'limitations': ['reporting_delays', 'later_corrections_or_cancellations']},
              'tradeKinds': {}, 'collections': [], 'rankingComplete': False}
    holds = result['holds']
    if binding_issue is not None:
        reason = binding_issue if _matches(r'[a-z][a-z0-9_]{0,79}', binding_issue) else 'analysis_binding_unverified'
        holds.append(_hold(reason, subject='analysis_binding'))
        return result
    target, catalog = _obj(ingestion.get('target')), _obj(ingestion.get('catalog'))
    if not all(_text(target.get(key)) for key in TARGET_KEYS) or not _same_target(catalog.get('target'), target):
        holds.append(_hold('notice_identity_unverified', subject='notice'))
        return result
    target = {key: target[key] for key in TARGET_KEYS}
    notice = _obj(catalog.get('notice'))
    result['target'] = {**target, 'name': _reported(_obj(notice.get('fields')).get('HOUSE_NM')),
                        'modelNo': None, 'houseType': None, 'supplyArea': None, 'complexId': None, 'noticeEvidence': None}
    if catalog.get('contract') != CATALOG_VERSION:
        holds.append(_hold('catalog_version_unsupported', subject='notice'))
        return result
    if not isinstance(selection, dict):
        holds.append(_hold('selection_invalid', subject='selection'))
        return result

    model, model_issue = _selected_model(catalog, selection)
    documents = _documents(catalog, target)
    price = _notice_price(catalog, model, selection, documents)
    result['noticePrice'] = price
    price_unresolved = price['scope'] == 'selected_room' and price['status'] == 'held'
    if price_unresolved:
        holds.append(_hold('notice_room_price_unverified', subject='notice_price', room=price['room'], reasons=price['reasons']))
    period = _period(ingestion) if override_period is None else override_period
    captured_kinds = ingestion.get('tradeKinds')
    result['conditions']['period'] = period
    if period is None or period['status'] != 'confirmed':
        decision = _obj(_obj(period).get('decision')).get('decisionId')
        holds.append(_hold('contract_period_unverified', subject='period', decisionId=decision))
        return result
    if not _unique_values(captured_kinds, lambda kind: kind in TRADE_KINDS):
        holds.append(_hold('trade_kinds_unverified', subject='trade_kind'))
        return result
    kinds = list(captured_kinds) if approved['tradeKinds'] is None else list(approved['tradeKinds'])
    result['conditions']['tradeKinds'] = list(kinds)
    if not _unique_values(ingestion.get('requestRegionCodes'), _lawd):
        holds.append(_hold('collection_request_regions_unverified', subject='collection', decisionId='D-02'))
        return result
    coverage, observations, replayed, records = _read_batches(ingestion, period, kinds)
    result['collections'] = list(coverage.values())
    if model is None:
        holds.append(_hold(model_issue, subject='housing_type'))
        return result
    checked, area = _checked_target_area(model, documents)
    result['target'].update(modelNo=model['modelNo'], houseType=_reported_house_type(model['houseType']), supplyArea=checked)
    if area is None:
        holds.append(_hold('target_supply_area_unverified', subject='supply_area', decisionId='D-01',
                           reasons=checked['reasons'], evidence=checked['evidence']))
        return result
    result['conditions']['area'], bounds = _area_conditions(
        area, selection, holds, approved_tolerance=approved['areaTolerancePercent'],
    )
    evidence = _obj(evidence)
    if evidence.get('contractVersion') != 'comparison-evidence/v1' or evidence.get('dataOrigin') != result['dataOrigin']:
        holds.append(_hold('comparison_evidence_unverified', subject='trade_evidence'))
        return result
    regions, by_code, by_name, unresolved_regions = _regions(evidence)
    complexes = _complexes(evidence, regions)
    target_complex, binding = _target_complex(evidence, catalog, target, complexes)
    if target_complex is None:
        holds.append(_hold('target_complex_identity_unverified', subject='region', decisionId='D-02'))
        return result
    result['target'].update(complexId=target_complex['complexId'], noticeEvidence=binding)
    target_region = regions[target_complex['localityCode']]
    priority_scope = _scope(evidence, 'priority', target_region, regions, unresolved_regions)
    if priority_scope is None:
        holds.append(_hold('priority_region_unverified', subject='region', decisionId='D-02'))
        return result

    links, duplicates, extra = _trade_evidence_holds(evidence, replayed, records)
    rows = [_classify(obs, links, duplicates, complexes, (by_code, by_name), period, kinds, target_complex['complexId'])
            for obs in observations]
    _mark_conflicting_links(rows)
    role = 'priority'
    priority = _screen_scope(role, priority_scope, rows, coverage, extra, kinds, period, area, bounds)
    decision = result['regionDecision']
    decision['priority'] = priority['decision']
    decision['reasonCode'] = 'priority_' + priority['decision']['conclusion']
    active = priority
    expansion_unresolved = False
    if priority['decision']['conclusion'] == 'normal_zero':
        expansion_scope = _scope(evidence, 'expansion', target_region, regions, unresolved_regions)
        if expansion_scope is None:
            expansion_unresolved = True
            decision['expansion'] = {'conclusion': 'held'}
            holds.append(_hold('expansion_region_unverified', scope='expansion', subject='region', decisionId='D-02'))
        else:
            role = 'expansion'
            active = _screen_scope(role, expansion_scope, rows, coverage, extra, kinds, period, area, bounds)
            decision['expansion'] = active['decision']

    result['appliedScope'] = role
    result['exclusions'] = active['exclusions']
    result['tradeKinds'] = active['decision']['tradeKinds']
    used = {record['recordId']: record for record in (*priority['records'], *active['records'])}
    result['collections'] = list(used.values())
    provisional = bool(active['holds']) or expansion_unresolved
    candidates = {key: _candidate(complexes[key], selected, target_complex,
                                  regions[complexes[key]['localityCode']], provisional)
                  for key, selected in active['selected'].items()}
    selected, rank_holds = _rank(candidates, role, provisional)
    result['comparables'], replacement_holds = _replace(
        selected, candidates, selection, complexes, active['localities'], role,
        approved_replacements=approved['replacements'],
        active_holds=active['holds'],
        active_exclusions=active['exclusions'],
    )
    result['candidatePool'] = _candidate_pool(
        complexes, regions, candidates, result['comparables'], active, target_complex,
    )
    holds.extend(active['holds'] + active['ownHolds'] + rank_holds + replacement_holds)
    result['rankingComplete'] = not (provisional or rank_holds)
    for kind, summary in result['tradeKinds'].items():
        summary['displayedCandidateCount'] = sum(kind in candidate['tradeStats'] for candidate in result['comparables'])
    for key, selected in active['target'].items():
        reference = _candidate(complexes[key], selected, target_complex, target_region,
                               provisional or bool(active['ownHolds']))
        reference['selectionReason'] = 'target_reference'
        result['targetReferences'].append(reference)
    if not provisional and not rank_holds and not price_unresolved:
        result['completeness'] = 'complete'
    elif candidates or role == 'expansion' or expansion_unresolved or active['decision']['collectionStatus'] in ('complete', 'partial'):
        result['completeness'] = 'partial'
    return result
