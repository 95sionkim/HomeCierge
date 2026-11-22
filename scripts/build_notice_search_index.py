#!/usr/bin/env python3
"""공개 청약홈 공고 목록과 공식 원문 점검 결과로 탐색 색인을 만든다."""
import argparse
import csv
import json
import os
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from ingestion_notices import NOTICE_SOURCES
from ingestion_pages import ReplayTransport, collect_pages, loads_source_json, read_page, valid_timestamp
from notice_document_review import review_catalog_documents
from notice_pdf_acquisition import OFFICIAL_ID, make_live_fetch
from replay_ingestion import collect_notice_catalog
from review_notice_documents import live_api_transport
from worker_rpc import WorkerRpc, WorkerRpcError

CONTRACT_VERSION = 'notice-search-index/v1'
PUBLIC_EDITION = 'public'
PUBLISH_RPC = 'publish_notice_search_index'
PDF_SOURCE = 'applyhome_notice_pdf'
# 게시 RPC의 JSON과 배열 상한. 잘라낸 목록 범위와 확인되지 않은 상세는 보류로 표시한다.
MAX_NOTICES, MAX_MODELS, MAX_ROOMS, MAX_REFS = 1000, 100, 2000, 16
MAX_REGION_CODES = 1000
MAX_INDEX_BYTES = 2 * 1024 * 1024
NONPUBLIC_LABEL = re.compile(r'://|//[a-z0-9]|www[.]|mailto:|tel:|analysis-uploads|upload[:/]|@', re.I)
APT, REMAINDER = NOTICE_SOURCES
SUPPORTED_KINDS = {'new_sale', 'unranked', 'remaining', 'resupply'}
IDENTITY_FIELDS = ('HOUSE_MANAGE_NO', 'PBLANC_NO')
PUBLIC_FIELDS = ('title', 'kind', 'regionCode', 'application', 'moveIn')
SEOUL = timezone(timedelta(hours=9))
PROVINCE_ALIASES = {
    '서울': '서울특별시', '서울시': '서울특별시', '부산': '부산광역시', '대구': '대구광역시',
    '인천': '인천광역시', '광주': '광주광역시', '대전': '대전광역시', '울산': '울산광역시',
    '세종': '세종특별자치시', '세종시': '세종특별자치시', '경기': '경기도', '강원': '강원특별자치도',
    '충북': '충청북도', '충남': '충청남도', '전북': '전북특별자치도', '전남': '전라남도',
    '경북': '경상북도', '경남': '경상남도', '제주': '제주특별자치도',
}
# 청약홈 공식 API 명세 15098547의 응답 항목. 순위별 RCPTDE는 API에 날짜 하나만 있다.
APT_RANK_DATES = tuple(f'GNRL_RNK{rank}_{area}_RCPTDE'
                       for rank in (1, 2) for area in ('CRSPAREA', 'ETC_GG', 'ETC_AREA'))
APPLICATION_FIELDS = {
    APT: ('RCEPT_BGNDE', 'RCEPT_ENDDE'),
    REMAINDER: ('SUBSCRPT_RCEPT_BGNDE', 'SUBSCRPT_RCEPT_ENDDE'),
}
SPECIAL_DATES = ('SPSPLY_RCEPT_BGNDE', 'SPSPLY_RCEPT_ENDDE')
GENERAL_DATES = ('GNRL_RCEPT_BGNDE', 'GNRL_RCEPT_ENDDE')
OTHER_HOUSING = {
    '01': {'도시형생활주택', '도시형'}, '02': {'오피스텔'}, '03': {'민간임대'},
    '04': {'생활형숙박시설', '생활숙박시설'},
}
OTHER_HOUSING_LABELS = {'도시형/오피스텔', '도시형/오피스텔/생활숙박시설/민간임대',
                        '오피스텔/도시형/민간임대/생활숙박시설'}


def address_tokens(value):
    if not isinstance(value, str):
        return ()
    tokens = unicodedata.normalize('NFC', value).split()
    if tokens:
        tokens[0] = PROVINCE_ALIASES.get(tokens[0], tokens[0])
    return tuple(tokens)


class RegionCodes:
    def __init__(self, codes):
        self.codes = codes
        self.parents = {name[:length] for name in codes for length in range(1, len(name))}
        self.municipal_names = {name[-1] for name in codes}
        self.max_depth = max(map(len, codes), default=0)
        self.active_codes = sorted({code for matches in codes.values() for code in matches})
        if len(self.active_codes) > MAX_REGION_CODES:
            raise ValueError('현존 시·군·구 코드 수가 게시 가능한 상한을 넘었습니다.')

    def resolve(self, address):
        return self.match(address_tokens(address))[0]

    def names(self):
        """현존 코드별 공식 전체 명칭. 일반구는 상위 시를 포함한 경로를 그대로 쓴다."""
        names = {}
        for tokens, matches in self.codes.items():
            name = ' '.join(tokens)
            for code in matches:
                if names.setdefault(code, name) != name:
                    raise ValueError('한 시·군·구 코드에 서로 다른 공식 명칭이 있습니다.')
        return {code: names[code] for code in self.active_codes}

    def match(self, tokens):
        # 일반구의 상위 시 또는 명칭이 겹치는 행에서 다른 범위로 내려가지 않는다.
        for length in range(min(len(tokens), self.max_depth), 0, -1):
            prefix = tokens[:length]
            if prefix not in self.codes:
                continue
            codes = self.codes[prefix]
            following = tokens[length] if length < len(tokens) else ''
            # 시·군·구 이름과 겹치지 않는 사업지구 표기는 이미 확인된 지역 안의 지점이다.
            next_is_municipality = (re.fullmatch(r'[가-힣]+[시군구]', following)
                                    and (not following.endswith('지구') or following in self.municipal_names))
            if prefix in self.parents or len(codes) != 1 or next_is_municipality:
                return None, None
            code = next(iter(codes))
            parent = None
            # 일반구의 상위 시는 현존하는 공식 전체 경로 행에서만 가져온다.
            if length >= 3 and prefix[-1].endswith('구') and prefix[-2].endswith('시'):
                parent_codes = self.codes.get(prefix[:-1], ())
                if len(parent_codes) == 1 and code not in parent_codes:
                    parent = next(iter(parent_codes))
            return code, parent
        return None, None


def read_region_codes(path):
    """행정표준코드관리시스템의 법정동 코드 전체자료에서 현존 시·군·구를 읽는다."""
    return read_region_codes_bytes(Path(path).read_bytes())


def read_region_codes_bytes(data):
    """압축을 푼 법정동 코드 전체자료 TXT의 바이트를 읽는다."""
    try:
        content = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        content = data.decode('cp949')
    rows = csv.reader(content.splitlines(), delimiter='\t')
    if next(rows, None) != ['법정동코드', '법정동명', '폐지여부']:
        raise ValueError('법정동코드 전체자료의 TSV 머리글을 확인하세요.')
    codes = defaultdict(set)
    for row in rows:
        if not row:
            continue
        if len(row) != 3 or not re.fullmatch(r'[0-9]{10}', row[0]) or not row[1].strip():
            raise ValueError('법정동코드 전체자료의 행 형식을 확인하세요.')
        code, name, status = row
        if status == '존재' and code[2:5] != '000' and code[5:] == '00000' and name.strip().endswith(('시', '군', '구')):
            codes[address_tokens(name)].add(code[:5])
    if not codes:
        raise ValueError('법정동코드 전체자료에 현존 시·군·구가 없습니다.')
    return RegionCodes(codes)


def iso_date(value):
    if isinstance(value, str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value):
        try:
            date.fromisoformat(value)
        except ValueError:
            return None
        return value
    return None


def move_in(value):
    if isinstance(value, str) and re.fullmatch(r'[0-9]{4}-?[0-9]{2}', value):
        month = value[:4] + '-' + value[-2:]
        if iso_date(month + '-01') is not None:
            return {'start': month, 'end': month}
    return None


def compact_label(value):
    return ''.join(unicodedata.normalize('NFC', value).split()).upper() if isinstance(value, str) else ''


def code_text(value, width):
    return str(value).zfill(width) if type(value) is int and 0 <= value < 10 ** width else value


def notice_kind(source, row):
    code = code_text(row.get('HOUSE_SECD'), 2)
    label = compact_label(row.get('HOUSE_SECD_NM'))
    subtype = code_text(row.get('HOUSE_DTL_SECD'), 2)
    detail_label = compact_label(row.get('HOUSE_DTL_SECD_NM'))
    if code == '02':
        grouped = label in OTHER_HOUSING_LABELS
        if any((grouped or label in labels) and (subtype in (None, '', number))
               and detail_label in labels | {''} for number, labels in OTHER_HOUSING.items()):
            return 'unsupported'
    if code == '03' and label == '공공지원민간임대':
        return 'unsupported'
    if source == APT:
        if code == '09' and label == '민간사전청약':
            return 'unsupported'
        if code == '01' and label in ('APT', '아파트'):
            rent = code_text(row.get('RENT_SECD'), 1)
            rent_label = compact_label(row.get('RENT_SECD_NM'))
            if rent == '1' and rent_label == '분양전환가능임대':
                return 'unsupported'
            if (rent in (None, '', '0') and rent_label in ('', '분양주택')
                    and (subtype, detail_label) in ((None, ''), ('', ''), ('01', '민영'), ('03', '국민'))):
                return 'new_sale'
    if source == REMAINDER:
        if code == '04' and label in ('무순위', '잔여세대'):
            return 'unranked' if label == '무순위' else 'remaining'
        if code == '06' and label in ('불법행위재공급', '계약취소주택'):
            return 'resupply'
    return 'unknown'


def application_period(source, row):
    raw_start, raw_end = (row.get(key) for key in APPLICATION_FIELDS[source])
    start, end = iso_date(raw_start), iso_date(raw_end)
    if start is None or end is None or start > end:
        return None, None, {'application_unverified'}
    overall = {'start': start, 'end': end}
    phases = ([SPECIAL_DATES, *((key, key) for key in APT_RANK_DATES)]
              if source == APT else [SPECIAL_DATES, GENERAL_DATES])
    spans, reasons = [], set()
    for first, last in phases:
        a, b = row.get(first), row.get(last)
        if all(value is None or (isinstance(value, str) and not value.strip()) for value in (a, b)):
            continue
        a, b = iso_date(a), iso_date(b)
        if a is None or b is None or a > b or a < start or b > end:
            reasons.add('application_unverified')
            continue
        spans.append((a, b))

    segments = []
    for a, b in sorted(spans):
        if segments and date.fromisoformat(a).toordinal() <= date.fromisoformat(segments[-1]['end']).toordinal() + 1:
            segments[-1]['end'] = max(segments[-1]['end'], b)
        else:
            segments.append({'start': a, 'end': b})
    if segments == [overall] or (not segments and not reasons):
        return overall, None, reasons
    # 빈 배열이면 전체 시작·종료는 확인됐지만 기간 안에 확정할 수 있는 접수일이 없다.
    return overall, segments, reasons | {'application_split'}


def public_text(value, limit):
    if isinstance(value, str):
        value = value.strip()
        if (value and len(value.encode('utf-16-le', errors='surrogatepass')) <= 2 * limit
                and not NONPUBLIC_LABEL.search(value)
                and not any(unicodedata.category(char) in ('Cc', 'Cs') for char in value)):
            return value
    return None


def numeric_identifier(value, digits):
    if type(value) is int and 0 <= value < 10 ** digits:
        value = str(value)
    if isinstance(value, str) and re.fullmatch(r'[0-9]{1,%d}' % digits, value):
        return value
    return None


def number_pair(row):
    numbers = tuple(numeric_identifier(row.get(key), 10) for key in IDENTITY_FIELDS)
    return numbers if all(number is not None and len(number) == 10 for number in numbers) else None


def household_count(value):
    number = numeric_identifier(value, 9)
    return int(number) if number is not None else None


def listing_facts(source, row, regions):
    address = address_tokens(row.get('HSSPLY_ADRES'))
    region, parent = regions.match(address)
    kind = notice_kind(source, row)
    application, segments, reasons = application_period(source, row)
    move = move_in(row.get('MVN_PREARNGE_YM'))
    publication = iso_date(row.get('RCRIT_PBLANC_DE'))
    reasons.update(reason for reason, needed in (
        ('kind_unverified', kind == 'unknown'),
        ('region_unverified', region is None),
        ('move_in_unverified', move is None), ('publication_date_unverified', publication is None),
    ) if needed)
    return {
        'title': public_text(row.get('HOUSE_NM'), 200), 'kind': kind, 'regionCode': region,
        'parentRegionCode': parent, 'application': application, 'applicationSegments': segments,
        'moveIn': move, 'address': address, 'publication': publication,
        'link': row.get('PBLANC_URL'), 'total': household_count(row.get('TOT_SUPLY_HSHLDCO')),
        'reasons': reasons,
    }


def merge_facts(records, candidate):
    facts, *others = records
    reasons = candidate['reasonCodes']
    for entry in records:
        reasons.update(entry['reasons'])
    conflicts = {key for key in facts if key != 'reasons' and any(entry[key] != facts[key] for entry in others)}
    for key in PUBLIC_FIELDS:
        if key in conflicts or (key == 'regionCode' and 'address' in conflicts):
            candidate[key] = 'unknown' if key == 'kind' else None
        else:
            candidate[key] = facts[key]
    publication = facts['publication'] if 'publication' not in conflicts else None
    candidate['edition'] = publication or PUBLIC_EDITION
    if publication is None:
        candidate['application'] = None
    candidate.pop('parentRegionCode', None)
    if candidate['regionCode'] is not None and 'parentRegionCode' not in conflicts and facts['parentRegionCode']:
        candidate['parentRegionCode'] = facts['parentRegionCode']
    candidate.pop('applicationSegments', None)
    if candidate['application'] is not None:
        if 'applicationSegments' in conflicts:
            candidate['applicationSegments'] = []
            reasons.add('application_split')
        elif facts['applicationSegments'] is not None:
            candidate['applicationSegments'] = facts['applicationSegments']
    if conflicts:
        reasons.add('notice_metadata_conflict')
    return not conflicts


def search_priority(candidate, today):
    period = candidate['application']
    segments = candidate.get('applicationSegments')
    if period is None:
        return (2, '', candidate['houseManageNo'], candidate['noticeNo'])
    if period['end'] < today:
        return (3, period['end'], candidate['houseManageNo'], candidate['noticeNo'])
    if today < period['start']:
        return (1, period['start'], candidate['houseManageNo'], candidate['noticeNo'])
    if segments is not None and not any(part['start'] <= today <= part['end'] for part in segments):
        return (2, '', candidate['houseManageNo'], candidate['noticeNo'])
    return (0, period['end'], candidate['houseManageNo'], candidate['noticeNo'])


def official_document(document, target):
    doc_id, version = document.get('id'), document.get('version')
    match = OFFICIAL_ID.fullmatch(doc_id) if isinstance(doc_id, str) else None
    if (match and match.groups() == (target['houseManageNo'], target['noticeNo'])
            and isinstance(version, str) and re.fullmatch(r'sha256:[0-9a-f]{64}', version)
            and document.get('source') == 'official' and document.get('originCheck') == 'confirmed'
            and all(document.get(key) == value for key, value in target.items())):
        return doc_id, version
    return None


def public_refs(records, allowed):
    refs = {(ref['document'], ref['version'], ref['page']) for ref in records
            if (ref.get('document'), ref.get('version')) in allowed
            and type(ref.get('page')) is int and 0 < ref['page'] <= 2_147_483_647}
    return [{'document': doc, 'version': version, 'page': page} for doc, version, page in sorted(refs)]


def public_models(catalog, allowed, reasons):
    rooms = defaultdict(list)
    for room in catalog['rooms']:
        name = public_text(room['room'], 64)
        model_rooms = rooms[room['modelNo']]
        if name is None or name != room['room'] or len(model_rooms) >= MAX_ROOMS:
            reasons.add('inventory_incomplete')
            continue
        subtotal = room['subtotal']
        shared = {(doc['id'], doc['version']) for doc in subtotal['documents']} & allowed
        sale = public_refs(room['salePrice']['evidence'], shared)
        options = public_refs(room['requiredOptions']['evidence'], shared)
        price_refs = {(ref['document'], ref['version'], ref['page']): ref for ref in sale + options}
        confirmed = (subtotal['status'] == 'confirmed' and sale and options and len(price_refs) <= MAX_REFS
                     and re.fullmatch(r'[1-9][0-9]{0,19}', subtotal['won']))
        model_rooms.append({'room': name, 'subtotalWon': subtotal['won'] if confirmed else None,
                            'priceEvidence': [price_refs[key] for key in sorted(price_refs)] if confirmed else []})
    models = []
    for model in catalog['housingTypes'][:MAX_MODELS]:
        model_no = model['modelNo']
        if not numeric_identifier(model_no, 20):
            reasons.add('source_unverified')
            continue
        house_type = public_text(model['houseType']['value'], 64)
        value = model['checkedSupplyArea']
        area_refs = public_refs(value['evidence'], allowed) if value['status'] == 'confirmed' else []
        if len(area_refs) > MAX_REFS:
            area_refs = []
        if not area_refs:
            reasons.add('supply_area_unverified')
        model_rooms = rooms[model_no]
        if not model_rooms or any(room['subtotalWon'] is None for room in model_rooms):
            reasons.add('price_unverified')
        models.append({'modelNo': model_no, 'houseType': house_type,
                       'supplyAreaM2': value['m2'] if area_refs else None, 'areaEvidence': area_refs,
                       'rooms': model_rooms})
    return models


def inventory_complete(facts, rows, models, catalog, receipt):
    # API의 공고 총량과 각 주택형의 일반·특별공급 합계가 모두 PDF의 확인된 고유 호실 수와 일치해야 한다.
    if (not receipt or receipt.get('acquisitionStatus') != 'acquired'
            or receipt['relation']['kind'] not in ('sole', 'full_replacement')
            or not receipt['relation']['allDocumentsAvailable']
            or catalog['issues'] or not facts['total'] or not models or len(rows) != len(models)):
        return False
    expected = {}
    for row in rows:
        number = numeric_identifier(row.get('MODEL_NO'), 20)
        general = household_count(row.get('SUPLY_HSHLDCO'))
        special = household_count(row.get('SPSPLY_HSHLDCO'))
        if number is None or number in expected or general is None or special is None or general + special < 1:
            return False
        expected[number] = general + special
    rooms = [room['room'] for model in models for room in model['rooms']]
    return (len(rooms) == len(set(rooms)) == facts['total'] == sum(expected.values())
            and all(model['houseType'] and model['supplyAreaM2']
                    and expected.get(model['modelNo']) == len(model['rooms'])
                    and all(room['subtotalWon'] is not None for room in model['rooms']) for model in models))


def enrich_notice(candidate, facts, source, fetch, regions, page_size, max_pages, review, *, model_diagnostics):
    target = {key: candidate[key] for key in ('houseManageNo', 'noticeNo', 'edition')}
    matching = (target['houseManageNo'], target['noticeNo'])
    reasons = candidate['reasonCodes']
    rows = defaultdict(list)
    official = set()
    exact_ready = False

    def bounded(source_id, scope, page, size):
        if page > max_pages:
            reasons.add('detail_page_limit_reached')
            return {'source': source_id, 'scope': scope, 'page': page, 'pageSize': size,
                    'httpStatus': None, 'transportError': 'not_provided', 'observedAt': None, 'body': None}
        envelope = fetch(source_id, scope, page, size)
        if not isinstance(envelope, dict):
            return envelope  # 공통 수집기의 응답 봉투 검사로 넘긴다.
        result = read_page(source_id, scope, envelope)
        if result['error'] is None:
            rows[source_id].extend(result['rows'])
        return envelope

    if hasattr(fetch, 'supplied_pages'):
        bounded.supplied_pages = fetch.supplied_pages

    def check_documents(target, catalog):
        nonlocal exact_ready
        detail = [listing_facts(source, row, regions) for row in rows[source] if number_pair(row) == matching]
        if detail and not merge_facts([facts, *detail], candidate):
            return {'evidence': [], 'issues': []}
        if catalog['notice']['status'] != 'reported' or catalog['housingTypesStatus'] != 'reported':
            reasons.add('source_unverified')
            return {'evidence': [], 'issues': []}
        exact_ready = True
        checked = review(target, catalog)
        for document in checked['review']['documents']:
            key = official_document(document, target)
            if (key is not None and document['adoption'] in ('standalone', 'with_set')
                    and document['inspectionStatus'] == 'checked'):
                official.add(key)
        return {**checked, 'evidence': [
            item for item in checked['evidence'] if official_document(item['document'], target) in official
        ]}

    try:
        catalog, _, receipt = collect_notice_catalog(source, target, bounded, page_size=page_size,
                                                     review_documents=check_documents)
    except (OSError, ValueError):
        reasons.add('source_unverified')
        if model_diagnostics:
            reasons.add('detail_collection_incomplete')
        return
    if 'notice_metadata_conflict' in reasons:
        return
    if catalog['notice']['status'] != 'reported':
        if model_diagnostics:
            reasons.add('detail_collection_incomplete')
        return
    if not official:
        reasons.add('source_unverified')
    models = candidate['models'] = public_models(catalog, official, reasons)
    if model_diagnostics and (catalog['housingTypesStatus'] != 'reported'
                              or len(models) != len(rows[source + '_model'])
                              or any(model['houseType'] is None for model in models)):
        reasons.add('model_unverified')
    if models:
        candidate['sourceIds'].append(source + '_model')
    if any(model['areaEvidence'] or model['rooms'] for model in candidate['models']):
        candidate['sourceIds'].append(PDF_SOURCE)
    candidate['inventoryComplete'] = (exact_ready and 'inventory_incomplete' not in reasons and
                                       inventory_complete(facts, rows[source + '_model'],
                                                          candidate['models'], catalog, receipt))


def publication_scope(start, end):
    if iso_date(start) is None or iso_date(end) is None or start > end:
        raise ValueError('모집공고일 시작일과 종료일을 YYYY-MM-DD 순서로 입력하세요.')
    return {'cond[RCRIT_PBLANC_DE::GTE]': start, 'cond[RCRIT_PBLANC_DE::LTE]': end}


def json_size(value):
    return len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8'))


def limit_index_details(index, details_in_priority_order):
    # 목록은 그대로 보존하고 뒤쪽 공고의 상세만 게시 크기에 맞춰 보류한다.
    size = json_size(index)
    for candidate in reversed(details_in_priority_order):
        if size <= MAX_INDEX_BYTES:
            break
        if not candidate['models']:
            continue
        previous = json_size(candidate)
        candidate.update(models=[], inventoryComplete=False,
                         sourceIds=[source for source in candidate['sourceIds'] if source in NOTICE_SOURCES],
                         reasonCodes=sorted(set(candidate['reasonCodes']) |
                                            {'detail_budget_exhausted', 'inventory_incomplete'}))
        size += json_size(candidate) - previous


def build_notice_search_index(start, end, regions, fetch, *, data_origin='synthetic', observed_at=None,
                              page_size=100, max_pages=5, max_detail_notices=10, max_detail_pages=2,
                              max_document_requests=20, document_fetch=None, document_inspect=None,
                              detail_active_only=False, details_require_complete_lists=False,
                              model_diagnostics=False, list_diagnostics=None):
    """두 공식 목록에서 시작하고, 기술 한도 안에서 같은 공고의 주택형과 공식 PDF를 점검한다.

    detail_active_only는 관측일에 접수가 끝난 공고의 상세 조회를 생략한다. details_require_complete_lists는
    두 목록 중 하나라도 완료·정상 빈 응답이 아니면 상세를 조회하지 않는다. 생략한 공고에는 상세 예산 사유를 남긴다.
    model_diagnostics는 목록 화면에 필요한 주택형 미확인 사유를 추가한다.
    list_diagnostics에는 게시 JSON 밖에서 확인할 출처별 건수·누락 사유만 기록한다.
    """
    scope = publication_scope(start, end)
    if data_origin not in ('synthetic', 'collected'):
        raise ValueError('자료 출처를 확인하세요.')
    if observed_at is None:
        observed_at = datetime.now(timezone.utc).isoformat()
    if not valid_timestamp(observed_at):
        raise ValueError('관측 시각에는 RFC 3339 오프셋이 필요합니다.')
    today = datetime.fromisoformat(observed_at.replace('Z', '+00:00')).astimezone(SEOUL).date().isoformat()
    for value, low, high in ((page_size, 1, 100), (max_pages, 1, 20), (max_detail_notices, 0, 100),
                             (max_detail_pages, 1, 10), (max_document_requests, 0, 100)):
        if type(value) is not int or not low <= value <= high:
            raise ValueError('페이지 또는 상세 조회의 기술 한도를 확인하세요.')

    sources, groups = [], defaultdict(list)
    for source in NOTICE_SOURCES:
        try:
            collection = collect_pages(source, scope, fetch, page_size=page_size, max_pages=max_pages)
        except (OSError, ValueError):
            collection = {'status': 'failed', 'observations': [], 'reasons': ['list_read_failed']}
        status = collection['status']
        reasons = set(collection['reasons'])
        if collection.get('error'):
            reasons.add(collection['error']['code'])
        seen = set()
        for observation in collection['observations']:
            row = observation['row']
            numbers = number_pair(row)
            publication = iso_date(row.get('RCRIT_PBLANC_DE'))
            if numbers is None:
                reasons.add('notice_identity_missing')
            elif numbers in seen:
                reasons.add('notice_identity_repeated')
            if publication is None or not start <= publication <= end:
                reasons.add('publication_scope_unverified')
            if numbers is not None:
                seen.add(numbers)
                groups[numbers].append((source, listing_facts(source, row, regions)))
        if status == 'complete' and reasons:
            status = 'partial'
        sources.append({'source': source, 'status': status})
        if list_diagnostics is not None:
            list_diagnostics[source] = {'reportedTotalCount': collection.get('reportedTotalCount'),
                                        'rowsReceived': len(collection['observations']),
                                        'missingPageCount': len(collection.get('missingPages', ())),
                                        'reasonCodes': sorted(reasons)}

    candidates, queued = [], []
    for (house, notice), group in sorted(groups.items()):
        all_facts = [facts for _, facts in group]
        if all(facts['publication'] is not None and not start <= facts['publication'] <= end for facts in all_facts):
            continue
        candidate = {'houseManageNo': house, 'noticeNo': notice,
                     'inventoryComplete': False, 'models': [], 'reasonCodes': set(),
                     'sourceIds': sorted({source for source, _ in group})}
        coherent = merge_facts(all_facts, candidate)
        candidates.append(candidate)
        if coherent and all_facts[0]['publication'] is not None and candidate['kind'] in SUPPORTED_KINDS:
            queued.append((candidate, group[0]))

    if len(candidates) > MAX_NOTICES:
        priority = sorted(candidates, key=lambda candidate: search_priority(candidate, today))
        omitted = {id(candidate) for candidate in priority[MAX_NOTICES:]}
        omitted_sources = {source for candidate in priority[MAX_NOTICES:] for source in candidate['sourceIds']}
        for entry in sources:
            if entry['source'] in omitted_sources:
                entry['status'] = 'partial'
                if list_diagnostics is not None:
                    list_diagnostics[entry['source']]['reasonCodes'].append('notice_limit_reached')
        candidates = [candidate for candidate in candidates if id(candidate) not in omitted]
        queued = [item for item in queued if id(item[0]) not in omitted]
    statuses = {entry['status'] for entry in sources}
    lists_complete = statuses <= {'complete', 'empty'}

    remaining_requests = max_document_requests
    detailed = []
    for candidate, (source, facts) in sorted(queued, key=lambda item: search_priority(item[0], today)):
        if (len(detailed) >= max_detail_notices or (details_require_complete_lists and not lists_complete)
                or (detail_active_only and search_priority(candidate, today)[0] == 3)):
            candidate['reasonCodes'].add('detail_budget_exhausted')
            continue

        def review(target, catalog):
            def bounded_document(url, *, max_bytes, timeout):
                nonlocal remaining_requests
                if remaining_requests <= 0:
                    candidate['reasonCodes'].add('document_budget_exhausted')
                    return {'error': 'connection'}
                remaining_requests -= 1
                return document_fetch(url, max_bytes=max_bytes, timeout=timeout)

            options = {'inspect': document_inspect} if document_inspect is not None else {}
            if document_fetch is None or remaining_requests <= 0:
                if remaining_requests <= 0:
                    candidate['reasonCodes'].add('document_budget_exhausted')
                return {'evidence': [], 'issues': [], 'review': {'documents': []}}
            return review_catalog_documents(target, catalog, fetch=bounded_document, **options)

        enrich_notice(candidate, facts, source, fetch, regions, page_size, max_detail_pages, review,
                      model_diagnostics=model_diagnostics)
        detailed.append(candidate)

    for candidate in candidates:
        if not candidate['inventoryComplete']:
            candidate['reasonCodes'].add('inventory_incomplete')
        candidate['reasonCodes'] = sorted(candidate['reasonCodes'])
    coverage = ('complete' if lists_complete else
                'unavailable' if statuses == {'failed'} else 'partial')
    index = {'contractVersion': CONTRACT_VERSION, 'dataOrigin': data_origin, 'observedAt': observed_at,
             'publicationWindow': {'start': start, 'end': end},
             'coverage': {'status': coverage, 'sources': sources},
             'regionCodes': list(regions.active_codes), 'notices': candidates}
    limit_index_details(index, detailed)
    return index


def publish_index(index, client):
    if index.get('contractVersion') != CONTRACT_VERSION or index.get('dataOrigin') != 'collected':
        raise ValueError('실수집한 공고 탐색 색인만 게시할 수 있습니다.')
    regions = index.get('regionCodes')
    if (not isinstance(regions, list) or not 1 <= len(regions) <= MAX_REGION_CODES
            or any(not isinstance(code, str) or not re.fullmatch(r'[0-9]{5}', code) for code in regions)
            or regions != sorted(set(regions))):
        raise ValueError('게시할 색인에 현존 시·군·구 코드가 필요합니다.')
    return client.post(PUBLISH_RPC, {'p_index': index}, allow_no_content=True)


def empty_fixture(scope, page_size):
    """별도 파일 없이 실행할 때 쓰는 정상 0건 합성 응답."""
    return {'dataOrigin': 'synthetic', 'pages': [
        {'source': source, 'scope': scope, 'page': 1, 'pageSize': page_size, 'httpStatus': 200,
         'observedAt': '2026-10-01T00:00:00Z',
         'body': {'page': 1, 'perPage': page_size, 'matchCount': 0, 'currentCount': 0, 'data': []}}
        for source in NOTICE_SOURCES
    ]}


def index_summary(index, *, published):
    return {
        'status': 'published' if published else 'built', 'dataOrigin': index['dataOrigin'],
        'observedAt': index['observedAt'], 'publicationWindow': index['publicationWindow'],
        'coverage': index['coverage'], 'noticeCount': len(index['notices']), 'regionCodeCount': len(index['regionCodes']),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--start', required=True, help='모집공고일 범위 시작 (YYYY-MM-DD, 포함)')
    parser.add_argument('--end', required=True, help='모집공고일 범위 종료 (YYYY-MM-DD, 포함)')
    parser.add_argument('--region-codes', type=Path, help='법정동코드 전체자료의 압축 해제한 TXT')
    parser.add_argument('--fixture', type=Path, help='dataOrigin: synthetic 및 pages가 있는 오프라인 JSON')
    parser.add_argument('--live', action='store_true', help='공식 청약홈 API와 상세·첨부를 실조회')
    parser.add_argument('--publish', action='store_true', help='실수집 색인을 작업자 RPC로 게시')
    output = parser.add_mutually_exclusive_group()
    output.add_argument('--summary', action='store_true', help='건수·수집 범위·상태만 출력 (기본값)')
    output.add_argument('--full-index', action='store_true', help='게시 없이 검산할 전체 색인 JSON 출력')
    parser.add_argument('--page-size', type=int, default=100, help='API 페이지 크기 (1~100)')
    parser.add_argument('--max-pages', type=int, default=5, help='출처별 목록 페이지 상한 (1~20)')
    parser.add_argument('--max-detail-notices', type=int, default=10, help='상세 조회 공고 수 상한 (0~100)')
    parser.add_argument('--max-detail-pages', type=int, default=2, help='공고·주택형 조회별 페이지 상한 (1~10)')
    parser.add_argument('--max-document-requests', type=int, default=20,
                        help='상세 HTML 및 PDF GET 총 상한 (0~100, 리디렉션 포함)')
    args = parser.parse_args(argv)
    if args.publish and not args.live:
        parser.error('--publish에는 --live가 필요합니다.')
    if args.publish and args.full_index:
        parser.error('게시할 때는 건수·범위·상태 요약을 출력합니다.')
    if args.live and (args.fixture or not args.region_codes):
        parser.error('--live에는 공식 --region-codes TXT가 필요하며 --fixture는 사용할 수 없습니다.')
    try:
        scope = publication_scope(args.start, args.end)
        regions = read_region_codes(args.region_codes) if args.region_codes else RegionCodes({})
        observed_at = datetime.now(timezone.utc)
        if args.publish:
            today = observed_at.astimezone(SEOUL).date()
            start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
            if end != today or (end - start).days >= 366:
                parser.error('--publish 종료일은 한국의 오늘이어야 하며 시작일과의 차이는 366일 미만이어야 합니다.')
        client = WorkerRpc(os.environ) if args.publish else None
        if args.live:
            fetch, docs = live_api_transport(), make_live_fetch()
        else:
            fixture = (loads_source_json(args.fixture.read_text(encoding='utf-8')) if args.fixture
                       else empty_fixture(scope, args.page_size))
            fetch, docs = ReplayTransport(fixture), None
        index = build_notice_search_index(
            args.start, args.end, regions, fetch, data_origin='collected' if args.live else 'synthetic',
            observed_at=observed_at.isoformat(),
            page_size=args.page_size, max_pages=args.max_pages, max_detail_notices=args.max_detail_notices,
            max_detail_pages=args.max_detail_pages, max_document_requests=args.max_document_requests,
            document_fetch=docs,
        )
        if client is not None:
            publish_index(index, client)
        result = index if args.full_index else index_summary(index, published=client is not None)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    except WorkerRpcError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except (OSError, TypeError, ValueError, RuntimeError):
        # 상류 응답이나 인증 설정의 원문은 출력하지 않는다.
        print('공고 탐색 색인을 완료하지 못했습니다. 날짜·기술 한도·출처 및 작업자 환경을 확인하세요.', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
