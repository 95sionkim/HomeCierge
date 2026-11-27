#!/usr/bin/env python3
"""수집본의 주변 실거래에 대해 청약홈 공식 공고·주택형 기준의 단지·공급면적 근거를 자동으로 구성한다(Q-38).

규칙:
- 지역은 공식 법정동코드(mois_legal_region_codes)로 확인한 같은 동·읍·면 우선이며,
  우선 지역이 정상 0개일 때만 확대 지역(구 또는 구 없는 시·군)의 거래 근거를 조회한다.
- 거래는 aptSeq(매매) 또는 검증된 동+지번+단지명(권리)으로 묶고, 같은 aptSeq 안의 식별자 충돌은 보류한다.
- 청약홈 APT·무순위/잔여세대 API에서 후보 공고를 찾되, 이름만으로 연결하지 않고 공고의 공급위치(HSSPLY_ADRES)를
  단지의 소속 시·군·구 + (법정동+지번 본번·부번 또는 도로명+건물번호)와 정규화 대조해 같은 단지로 인정한다.
- 인정된 모든 공고의 주택형 API에서 주택형 문자열(예: 084.7450D -> 84.7450)의 전용면적이 거래 전용면적과
  십진수로 정확히 같은 주택형이 하나뿐이고 확인한 모든 공고에서 공급면적(SUPLY_AR)이 같을 때만 대응을 확인한다.
- 상한 초과·조회 오류·공고 없음·단지 식별 불일치·복수 주택형·공고 간 공급면적 불일치는 정상 0개가 아니라 보류로 구분한다.
"""
import copy
import csv
import io
import re
import unicodedata
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Context, Decimal, InvalidOperation, localcontext
from http.client import HTTPException
from typing import Callable, Optional

from build_notice_search_index import NOTICE_SOURCES, notice_kind
from compare_trades import (
    DEFAULT_TOLERANCE,
    _area,
    _calendar_day,
    _cancellation,
    _checked_target_area,
    _contract_day,
    _documents,
    _known_kind,
    _period,
    _selected_model,
    _won,
)
from complex_coordinates import (
    DEFAULT_KAKAO_CACHE_TTL_DAYS,
    KAKAO_SOURCE_ID,
    canonical_province,
    coordinate_cache_key,
    extract_parcel_spec,
    extract_road_spec,
    is_ambiguous_area_address,
    normalize_road_name,
    normalize_text,
    parse_nonnegative_int,
    parse_positive_int,
    resolve_complex_coordinates,
    strip_kakao_coordinates,
)
from ingestion_notices import AREA as AREA_PATTERN, AREA_LENGTH
from ingestion_pages import collect_pages
from ingestion_trades import IDENTIFIER_FIELDS, SOURCE_KINDS, TRADE_KINDS

DEFAULT_APPLYHOME_REQUEST_LIMIT = 120
DEFAULT_APPLYHOME_MAX_PAGES = 5
DEFAULT_APPLYHOME_PAGE_SIZE = 100
DEFAULT_APPLYHOME_CACHE_TTL_DAYS = 7
DEFAULT_REGION_CACHE_TTL_DAYS = 30
REGION_SOURCE_ID = 'mois_legal_region_codes'
REGION_ARCHIVE_LIMIT = 4 * 1024 * 1024


def _address_tokens(value) -> tuple[str, ...]:
    """시·도 약칭·구 명칭(예: 강원도→강원특별자치도, 전라북도→전북특별자치도, 부산시→부산광역시)을 정규화한 토큰."""
    if not isinstance(value, str):
        return ()
    tokens = unicodedata.normalize('NFC', value).split()
    if tokens:
        tokens[0] = canonical_province(tokens[0])
    return tuple(tokens)


def _nonblank(value) -> bool:
    return value is not None and (not isinstance(value, str) or bool(value.strip()))


def _nonzero_code(value) -> bool:
    if not _nonblank(value):
        return False
    return bool(str(value).strip().lstrip('0'))

# 청약홈 주택형 문자열(예: 084.7450D, 059.9800, 084.9946A1, 084.9500(A))에서 전용면적과 타입을 분리한다.
HOUSE_TYPE_PATTERN = re.compile(
    r'^\s*0*([1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)\s*'
    r'([A-Za-z][A-Za-z0-9_-]*|\([A-Za-z0-9_-]+\))?\s*$'
)
PARCEL_JIBUN_PATTERN = re.compile(r'^\s*(산\s*)?0*([1-9][0-9]*)(?:-0*([0-9]+))?\s*$')
PAREN_CONTENT_PATTERN = re.compile(r'\(([^()]+)\)')


class EvidenceBudgetExceeded(Exception):
    """실행당 청약홈 근거 조회 호출 상한에 도달했다."""


def parse_house_type_exclusive(house_type) -> Optional[tuple[Decimal, str]]:
    """주택형 문자열에서 (정확한 전용면적 Decimal, 정규 타입 접미사)를 추출한다."""
    if not isinstance(house_type, str):
        return None
    match = HOUSE_TYPE_PATTERN.fullmatch(house_type.strip())
    if not match:
        return None
    area_text, suffix = match.group(1), match.group(2) or ''
    if len(area_text) > AREA_LENGTH:
        return None
    try:
        area = Decimal(area_text)
    except InvalidOperation:
        return None
    if area <= 0:
        return None
    clean_suffix = suffix.strip().strip('()').upper()
    return area, clean_suffix


def parse_supply_area_decimal(value) -> Optional[tuple[Decimal, str]]:
    """SUPLY_AR 값을 십진 문자열과 Decimal로 파싱한다. float는 거부한다."""
    if isinstance(value, bool) or isinstance(value, float) or value is None:
        return None
    text = str(value).strip() if isinstance(value, (int, Decimal)) else (value.strip() if isinstance(value, str) else '')
    if not text or len(text) > AREA_LENGTH or not AREA_PATTERN.fullmatch(text):
        return None
    try:
        amount = Decimal(text)
    except InvalidOperation:
        return None
    return (amount, text) if amount > 0 else None


def normalize_complex_name(value) -> str:
    text = normalize_text(value)
    if not text:
        return ''
    return re.sub(r'[\s()\[\]·.,_-]+', '', text).lower()


def parse_jibun_parts(jibun) -> Optional[tuple[bool, int, int]]:
    """지번 문자열('827', '827-3', '산12-1')을 (is_mountain, main, sub)으로 파싱한다."""
    if not isinstance(jibun, str):
        return None
    match = PARCEL_JIBUN_PATTERN.fullmatch(jibun)
    if not match:
        return None
    is_mountain = bool(match.group(1))
    main_no = parse_positive_int(match.group(2))
    sub_no = parse_nonnegative_int(match.group(3))
    if main_no is None or sub_no is None:
        return None
    return is_mountain, main_no, sub_no


def _canonical_decimal_str(value: Decimal) -> str:
    text = format(value, 'f')
    if '.' in text:
        text = text.rstrip('0').rstrip('.')
    return text or '0'


class LegalRegionCatalog:
    """행정안전부 법정동코드 전체자료에서 시·군·구와 하위 법정동·읍·면·리 계층을 제공한다."""

    def __init__(self, sgg_entries: dict, localities_by_sgg: dict):
        # sgg_entries[code5] = {'code': code5, 'name': full_name, 'tokens': tuple, 'hasDistrict': bool,
        #                       'expansionKind': 'district'|'municipality', 'expansionCode': code5}
        self.sgg_entries = sgg_entries
        # localities_by_sgg[code5] = list of compare_trades.py regions[] dicts
        self.localities_by_sgg = localities_by_sgg
        self._by_tokens = defaultdict(set)
        self._parent_tokens = set()
        self._municipal_names = set()
        self._max_depth = 0
        for code5, entry in sgg_entries.items():
            tokens = tuple(entry['tokens'])
            self._by_tokens[tokens].add(code5)
            self._municipal_names.add(tokens[-1])
            self._max_depth = max(self._max_depth, len(tokens))
            for length in range(1, len(tokens)):
                self._parent_tokens.add(tokens[:length])

    @classmethod
    def from_mois_tsv_bytes(cls, data: bytes) -> 'LegalRegionCatalog':
        """행정안전부 법정동코드 전체자료(원본 TSV 또는 download_region_zip의 ZIP 압축본)를 읽는다."""
        if not isinstance(data, (bytes, bytearray)) or not 0 < len(data) <= REGION_ARCHIVE_LIMIT:
            raise ValueError('법정동코드 전체자료의 크기가 허용 범위를 벗어났습니다.')
        raw = bytes(data)
        archive_bytes = io.BytesIO(raw)
        if zipfile.is_zipfile(archive_bytes):
            with zipfile.ZipFile(archive_bytes) as archive:
                files = [item for item in archive.infolist() if not item.is_dir()]
                if (len(files) != 1 or not files[0].filename.lower().endswith('.txt')
                        or files[0].file_size > REGION_ARCHIVE_LIMIT):
                    raise ValueError('법정동코드 ZIP에 전체자료 TXT 한 개가 필요합니다.')
                with archive.open(files[0]) as member:
                    raw = member.read(REGION_ARCHIVE_LIMIT + 1)
            if len(raw) > REGION_ARCHIVE_LIMIT:
                raise ValueError('압축 해제한 법정동코드 자료가 상한을 넘었습니다.')
        try:
            content = raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            content = raw.decode('cp949')
        return cls.from_mois_tsv_text(content)

    @classmethod
    def from_mois_tsv_text(cls, content: str) -> 'LegalRegionCatalog':
        rows = csv.reader(content.splitlines(), delimiter='\t')
        if next(rows, None) != ['법정동코드', '법정동명', '폐지여부']:
            raise ValueError('법정동코드 전체자료의 TSV 머리글을 확인하세요.')
        active_rows = []
        for row in rows:
            if not row:
                continue
            if len(row) != 3 or not re.fullmatch(r'[0-9]{10}', row[0]) or not row[1].strip():
                raise ValueError('법정동코드 전체자료의 행 형식을 확인하세요.')
            if row[2] == '존재':
                active_rows.append((row[0], _address_tokens(row[1])))

        # 1) 시·군·구(앞 5자리)와 상위 시 식별
        raw_sgg = {}
        tokens_to_sgg = defaultdict(set)
        for code, tokens in active_rows:
            if code[2:5] != '000' and code[5:] == '00000' and tokens and tokens[-1].endswith(('시', '군', '구')):
                code5 = code[:5]
                raw_sgg[code5] = tokens
                tokens_to_sgg[tokens].add(code5)

        parent_prefixes = {tokens[:length] for tokens in raw_sgg.values() for length in range(1, len(tokens))}
        sgg_entries = {}
        for code5, tokens in raw_sgg.items():
            if tokens in parent_prefixes:
                # 일반구를 거느린 상위 시(예: 경기도 성남시)는 직접 거래 요청 코드가 아니다.
                continue
            has_district = tokens[-1].endswith('구')
            municipality_code = code5
            if has_district and len(tokens) >= 3 and tokens[-2].endswith('시'):
                parents = tokens_to_sgg.get(tokens[:-1], set())
                if len(parents) == 1:
                    municipality_code = next(iter(parents))
            sgg_entries[code5] = {
                'code': code5,
                'name': ' '.join(tokens),
                'tokens': tokens,
                'hasDistrict': has_district,
                'expansionKind': 'district' if has_district else 'municipality',
                'expansionCode': code5,
                'municipalityCode': municipality_code,
            }

        # 2) 법정동·읍·면(code[5:8] != '000', code[8:] == '00')과 하위 리(code[8:] != '00')
        localities = {}
        ris = defaultdict(list)
        for code, tokens in active_rows:
            code5 = code[:5]
            if code5 not in sgg_entries or code[5:8] == '000':
                continue
            last = tokens[-1]
            if code[8:] == '00':
                if last.endswith('읍'):
                    ltype = 'eup'
                elif last.endswith('면'):
                    ltype = 'myeon'
                elif last.endswith(('동', '가', '로')):
                    ltype = 'dong'
                else:
                    continue
                sgg = sgg_entries[code5]
                localities[code] = {
                    'localityCode': code,
                    'localityType': ltype,
                    'localityName': last,
                    'umdCd': code[5:],
                    'requestRegionCode': code5,
                    'districtCode': code5 if sgg['hasDistrict'] else None,
                    'municipalityCode': sgg['municipalityCode'],
                    'evidence': {'source': REGION_SOURCE_ID, 'reference': code},
                }
            elif last.endswith('리'):
                parent_code = code[:8] + '00'
                ris[parent_code].append({'name': last, 'umdCd': code[5:]})

        localities_by_sgg = defaultdict(list)
        for code in sorted(localities):
            item = localities[code]
            if item['localityType'] in ('eup', 'myeon') and code in ris:
                item['subLocalities'] = sorted(ris[code], key=lambda sub: (sub['umdCd'], sub['name']))
            localities_by_sgg[item['requestRegionCode']].append(item)

        return cls(sgg_entries, dict(localities_by_sgg))

    @classmethod
    def from_cache_record(cls, record: dict) -> 'LegalRegionCatalog':
        """DB 공유 지역 캐시 행 하나에서 단일 시·군·구 LegalRegionCatalog를 복원한다."""
        code5 = record['requestRegionCode']
        name = record['regionName']
        tokens = _address_tokens(name)
        has_district = bool(record['hasDistrict'])
        localities = copy.deepcopy(record['localities'])
        municipality_code = localities[0]['municipalityCode'] if localities else code5
        entry = {
            'code': code5,
            'name': name,
            'tokens': tokens,
            'hasDistrict': has_district,
            'expansionKind': record['expansionKind'],
            'expansionCode': record['expansionCode'],
            'municipalityCode': municipality_code,
        }
        return cls({code5: entry}, {code5: localities})

    def to_cache_record(
        self,
        request_region_code: str,
        observed_at: str,
        *,
        ttl_days: int = DEFAULT_REGION_CACHE_TTL_DAYS,
    ) -> Optional[dict]:
        entry = self.sgg_entries.get(request_region_code)
        localities = self.localities_by_sgg.get(request_region_code)
        if entry is None or not localities:
            return None
        try:
            obs_dt = datetime.fromisoformat(observed_at.replace('Z', '+00:00'))
        except ValueError:
            obs_dt = datetime.now(timezone.utc)
            observed_at = obs_dt.isoformat()
        expires_at = (obs_dt + timedelta(days=max(1, min(90, int(ttl_days))))).isoformat()
        return {
            'requestRegionCode': request_region_code,
            'regionName': entry['name'],
            'hasDistrict': entry['hasDistrict'],
            'expansionKind': entry['expansionKind'],
            'expansionCode': entry['expansionCode'],
            'localities': copy.deepcopy(localities),
            'observedAt': observed_at,
            'expiresAt': expires_at,
        }

    def regions_for(self, request_region_code: str) -> list[dict]:
        return copy.deepcopy(self.localities_by_sgg.get(request_region_code, []))

    def sgg_entry(self, request_region_code: str) -> Optional[dict]:
        return self.sgg_entries.get(request_region_code)

    def resolve_sgg_code(self, address: str) -> Optional[str]:
        """주소 문자열의 시·도 + 시·군·구 접두를 공식 법정동코드 5자리로 판별한다."""
        tokens = _address_tokens(address)
        for length in range(min(len(tokens), self._max_depth), 0, -1):
            prefix = tokens[:length]
            if prefix not in self._by_tokens:
                continue
            codes = self._by_tokens[prefix]
            following = tokens[length] if length < len(tokens) else ''
            next_is_municipality = (
                re.fullmatch(r'[가-힣]+[시군구]', following) is not None
                and (not following.endswith('지구') or following in self._municipal_names)
            )
            if prefix in self._parent_tokens or len(codes) != 1 or next_is_municipality:
                return None
            return next(iter(codes))
        return None

    def resolve_locality_in_sgg(self, request_region_code: str, address: str) -> Optional[dict]:
        """주소 문자열에서 지정 시·군·구 안의 유일한 법정동·읍·면을 찾는다."""
        if not isinstance(address, str) or not address.strip():
            return None
        entry = self.sgg_entries.get(request_region_code)
        localities = self.localities_by_sgg.get(request_region_code, [])
        if entry is None or not localities:
            return None
        # 주소에 시·군·구 접두가 있으면 반드시 같은 시·군·구여야 한다(A-08).
        resolved_sgg = self.resolve_sgg_code(address)
        if resolved_sgg is not None and resolved_sgg != request_region_code:
            return None

        # 괄호 밖 토큰 + 괄호 안 첫 항목(도로명주소 참고항목의 법정동 위치)에서 경계가 맞은 후보 토큰만 모은다.
        normalized = normalize_text(address)
        outside = re.sub(r'\([^()]*\)', ' ', normalized)
        token_pattern = r'(?<![가-힣0-9])([가-힣0-9]+(?:동|가|로|읍|면|리))(?![가-힣0-9])'
        candidate_tokens = set(re.findall(token_pattern, outside))
        for paren in PAREN_CONTENT_PATTERN.findall(normalized):
            first_part = paren.split(',')[0].strip()
            candidate_tokens.update(re.findall(token_pattern, first_part))

        matched = {}
        for region in localities:
            if region['localityName'] in candidate_tokens:
                matched[region['localityCode']] = region
            for sub in region.get('subLocalities', ()):
                if sub['name'] in candidate_tokens:
                    matched[region['localityCode']] = region
        if len(matched) == 1:
            return copy.deepcopy(next(iter(matched.values())))
        return None


def _build_region_index(regions: list[dict]):
    by_code, by_name = defaultdict(set), defaultdict(set)
    by_locality = {}
    for region in regions:
        code = region['localityCode']
        by_locality[code] = region
        req = region['requestRegionCode']
        by_name[req, region['localityName']].add(code)
        if region.get('umdCd'):
            by_code[req, region['umdCd']].add((code, region['localityName']))
        for sub in region.get('subLocalities', ()):
            by_name[req, sub['name']].add(code)
            if sub.get('umdCd'):
                by_code[req, sub['umdCd']].add((code, sub['name']))
    return by_locality, by_code, by_name


def _trade_locality(source: str, request_code: str, identifiers: dict, by_code, by_name) -> tuple[Optional[str], Optional[str]]:
    """거래 행의 (localityCode, subLocalityName_or_None)을 공식 지역 사전으로 판정한다."""
    reported = identifiers.get('sggCd')
    if not isinstance(reported, str) or reported.strip() != request_code:
        return None, None
    umd_nm = identifiers.get('umdNm')
    umd_nm = umd_nm.strip() if isinstance(umd_nm, str) and umd_nm.strip() else None
    umd_cd = identifiers.get('umdCd')
    umd_cd = umd_cd.strip() if isinstance(umd_cd, str) and umd_cd.strip() else None
    if source == 'apt_trade' and umd_cd:
        matches = by_code.get((request_code, umd_cd), ())
        if len(matches) == 1:
            locality_code, expected_name = next(iter(matches))
            if umd_nm is None or umd_nm == expected_name:
                sub = expected_name if expected_name.endswith('리') else None
                return locality_code, sub
        return None, None
    if umd_nm:
        matches = by_name.get((request_code, umd_nm), ())
        if len(matches) == 1:
            locality_code = next(iter(matches))
            sub = umd_nm if umd_nm.endswith('리') else None
            return locality_code, sub
    return None, None


def _extract_trade_parcel(identifiers: dict, locality_code: str, sub_name: Optional[str]) -> Optional[dict]:
    jibun = identifiers.get('jibun')
    parsed_jibun = parse_jibun_parts(jibun) if isinstance(jibun, str) and jibun.strip() else None
    land_cd = identifiers.get('landCd')
    bonbun = identifiers.get('bonbun')
    bubun = identifiers.get('bubun')
    if _nonblank(land_cd) and _nonzero_code(bonbun):
        land_str = str(land_cd).strip()
        main_no = parse_positive_int(bonbun)
        sub_no = parse_nonnegative_int(bubun)
        if land_str not in ('1', '2') or main_no is None or sub_no is None:
            return None
        is_mountain = land_str == '2'
        if parsed_jibun is not None and parsed_jibun != (is_mountain, main_no, sub_no):
            return None  # 같은 행 내부의 jibun과 bonbun/bubun 불일치
        return {
            'localityCode': locality_code,
            'subName': sub_name,
            'isMountain': is_mountain,
            'mainNo': main_no,
            'subNo': sub_no,
        }
    if parsed_jibun is not None:
        is_mountain, main_no, sub_no = parsed_jibun
        return {
            'localityCode': locality_code,
            'subName': sub_name,
            'isMountain': is_mountain,
            'mainNo': main_no,
            'subNo': sub_no,
        }
    return None


def _extract_trade_road(identifiers: dict, expected_sgg: str) -> Optional[dict]:
    road_sgg = identifiers.get('roadNmSggCd')
    if road_sgg is not None and str(road_sgg).strip() and str(road_sgg).strip() != expected_sgg:
        return None
    road_name = normalize_road_name(identifiers.get('roadNm'))
    main_no = parse_positive_int(identifiers.get('roadNmBonbun'))
    sub_no = parse_nonnegative_int(identifiers.get('roadNmBubun'))
    if road_name is None or main_no is None or sub_no is None:
        return None
    return {'sggCd': expected_sgg, 'roadName': road_name, 'mainNo': main_no, 'subNo': sub_no}


def _parcel_tuple(parcel: Optional[dict]):
    if parcel is None:
        return None
    return (parcel['localityCode'], parcel.get('subName'), bool(parcel['isMountain']), parcel['mainNo'], parcel['subNo'])


def _road_tuple(road: Optional[dict]):
    if road is None:
        return None
    return (road['sggCd'], road['roadName'], road['mainNo'], road['subNo'])


def notice_address_matches_complex(
    notice_address: str,
    region_catalog: LegalRegionCatalog,
    *,
    sgg_code: str,
    locality_code: str,
    locality_name: str,
    parcel: Optional[dict],
    road: Optional[dict],
) -> tuple[bool, Optional[str]]:
    """공고 공급위치(HSSPLY_ADRES)가 단지의 법정동+지번 또는 도로명+건물번호와 일치하는지 대조한다.

    이름만으로는 절대 일치시키지 않으며, 다른 시·군·구(A-08)·모호 표기('일원'/'블록')·충돌 주소는 거부한다.
    반환값: (일치 여부, 일치 경로 'road'|'parcel'|'both'|None)
    """
    if not isinstance(notice_address, str) or not notice_address.strip():
        return False, None
    if is_ambiguous_area_address(notice_address):
        return False, None

    # 1. 소속 시·군·구 확인 (필수 — 다른 구의 동명 동·단지 차단, A-08)
    resolved_sgg = region_catalog.resolve_sgg_code(notice_address)
    if resolved_sgg != sgg_code:
        return False, None

    # 2. 주소에 명시된 법정동·읍·면이 있으면 같은 법정동이어야 한다.
    notice_locality = region_catalog.resolve_locality_in_sgg(sgg_code, notice_address)
    if notice_locality is not None and notice_locality['localityCode'] != locality_code:
        return False, None

    notice_road = extract_road_spec(notice_address)
    notice_parcel = extract_parcel_spec(notice_address)

    road_matched = False
    if notice_road is not None and road is not None:
        if (notice_road['roadName'], notice_road['mainNo'], notice_road['subNo']) == (
            road['roadName'], road['mainNo'], road['subNo']
        ):
            road_matched = True
        else:
            # 공고와 단지 모두 도로명주소를 갖고 있는데 다르면 다른 단지다.
            return False, None

    parcel_matched = False
    if notice_parcel is not None and parcel is not None:
        token = notice_parcel['localityToken']
        expected_sub = parcel.get('subName')
        locality_ok = (
            (expected_sub is not None and token == expected_sub)
            or (expected_sub is None and token == locality_name)
        )
        if locality_ok and (
            bool(notice_parcel['isMountain']), notice_parcel['mainNo'], notice_parcel['subNo']
        ) == (bool(parcel['isMountain']), parcel['mainNo'], parcel['subNo']):
            parcel_matched = True
        else:
            # 공고와 단지 모두 지번을 갖고 있는데 다르면 다른 단지다.
            return False, None

    if road_matched and parcel_matched:
        return True, 'both'
    if road_matched:
        return True, 'road'
    if parcel_matched:
        return True, 'parcel'
    return False, None


def _is_supported_apartment_notice(feed: str, row: dict) -> bool:
    """오피스텔·임대·사전청약 등 지원 범위 밖 공고를 제외한다."""
    if not any(row.get(field) for field in ('HOUSE_SECD', 'HOUSE_SECD_NM', 'RENT_SECD', 'RENT_SECD_NM')):
        return True
    kind = notice_kind(feed, row)
    return kind != 'unsupported'


def _candidate_search_scopes(group: dict) -> list[dict]:
    """단지 하나의 후보 공고를 찾기 위한 청약홈 검색 필터 목록(도로명·지번·단지명 순)."""
    scopes = []
    seen = set()

    def add(field: str, value: str):
        clean = normalize_text(value)
        if not clean:
            return
        key = (field, clean)
        if key not in seen:
            seen.add(key)
            scopes.append({f'cond[{field}::LIKE]': clean})

    road = group.get('road')
    if road is not None:
        num = f'{road["mainNo"]}-{road["subNo"]}' if road['subNo'] > 0 else str(road['mainNo'])
        add('HSSPLY_ADRES', f'{road["roadName"]} {num}')

    parcel = group.get('parcel')
    if parcel is not None:
        token = parcel.get('subName') or group['localityName']
        land_tag = '산 ' if parcel['isMountain'] else ''
        num = f'{parcel["mainNo"]}-{parcel["subNo"]}' if parcel['subNo'] > 0 else str(parcel['mainNo'])
        add('HSSPLY_ADRES', f'{token} {land_tag}{num}')

    apt_name = group.get('name')
    if apt_name:
        add('HOUSE_NM', apt_name)
    return scopes


def _apply_q38_rules(
    exclusive_areas: list[tuple[Decimal, str]],
    verified_notices: list[dict],
) -> dict:
    """주소로 확인된 공고 목록의 주택형에 Q-38 규칙을 적용한다.

    verified_notices 원소:
      source, modelSource, houseManageNo, noticeNo, edition, observedAt, models: list[dict]
    반환 딕셔너리는 정확한 십진수 Decimal을 키로 사용한다(예: 84.745와 84.7450은 같은 키).
    """
    # 모든 확인 공고에서 주택형 문자열을 미리 검증한다.
    parsed_notices = []
    for notice in verified_notices:
        parsed_models = []
        for model in notice['models']:
            raw_house_type = model.get('HOUSE_TY')
            parsed_ty = parse_house_type_exclusive(raw_house_type)
            if parsed_ty is None:
                # 주택형 문자열을 읽지 못하면 전용면적 일치의 유일성을 증명할 수 없다.
                return {
                    excl_dec: {
                        'status': 'held', 'reasonCode': 'lookup_failed',
                        'supplyAreaM2': None, 'notices': [],
                    }
                    for excl_dec, _ in exclusive_areas
                }
            parsed_supply = parse_supply_area_decimal(model.get('SUPLY_AR'))
            parsed_models.append({
                'modelNo': str(model.get('MODEL_NO') or '').strip() or None,
                'houseType': str(raw_house_type).strip(),
                'exclusive': parsed_ty[0],
                'typeSuffix': parsed_ty[1],
                'supply': parsed_supply[0] if parsed_supply else None,
                'supplyStr': parsed_supply[1] if parsed_supply else None,
            })
        parsed_notices.append((notice, parsed_models))

    outcomes = {}
    for excl_dec, _ in exclusive_areas:
        matching_records = []
        multi_in_notice = False
        missing_supply = False
        for notice, models in parsed_notices:
            hits = [m for m in models if m['exclusive'] == excl_dec]
            if len(hits) > 1:
                multi_in_notice = True
                break
            if len(hits) == 1:
                hit = hits[0]
                if hit['supply'] is None:
                    missing_supply = True
                matching_records.append({
                    'source': notice['source'],
                    'modelSource': notice['modelSource'],
                    'houseManageNo': notice['houseManageNo'],
                    'noticeNo': notice['noticeNo'],
                    'edition': notice.get('edition'),
                    'modelNo': hit['modelNo'],
                    'houseType': hit['houseType'],
                    'typeKey': (hit['exclusive'], hit['typeSuffix']),
                    'supply': hit['supply'],
                    'supplyAreaM2': hit['supplyStr'],
                    'observedAt': notice.get('observedAt'),
                })

        if multi_in_notice:
            outcomes[excl_dec] = {
                'status': 'held', 'reasonCode': 'multiple_housing_types',
                'supplyAreaM2': None, 'notices': [],
            }
            continue
        if not matching_records:
            outcomes[excl_dec] = {
                'status': 'held', 'reasonCode': 'housing_type_not_found',
                'supplyAreaM2': None, 'notices': [],
            }
            continue
        if missing_supply:
            outcomes[excl_dec] = {
                'status': 'held', 'reasonCode': 'lookup_failed',
                'supplyAreaM2': None, 'notices': [],
            }
            continue

        distinct_types = {rec['typeKey'] for rec in matching_records}
        if len(distinct_types) > 1:
            outcomes[excl_dec] = {
                'status': 'held', 'reasonCode': 'multiple_housing_types',
                'supplyAreaM2': None,
                'notices': [_public_notice_ref(r) for r in matching_records],
            }
            continue

        distinct_supplies = {rec['supply'] for rec in matching_records}
        if len(distinct_supplies) > 1:
            outcomes[excl_dec] = {
                'status': 'held', 'reasonCode': 'supply_area_mismatch_across_notices',
                'supplyAreaM2': None,
                'notices': [_public_notice_ref(r) for r in matching_records],
            }
            continue

        # Q-38 확정: 유일 주택형 + 확인한 모든 공고의 공급면적 일치
        canonical_supply = matching_records[0]['supplyAreaM2']
        outcomes[excl_dec] = {
            'status': 'confirmed',
            'reasonCode': None,
            'supplyAreaM2': canonical_supply,
            'notices': [_public_notice_ref(r) for r in matching_records],
        }
    return outcomes


def _public_notice_ref(record: dict) -> dict:
    return {
        'source': record['source'],
        'modelSource': record['modelSource'],
        'houseManageNo': record['houseManageNo'],
        'noticeNo': record['noticeNo'],
        'edition': record.get('edition'),
        'modelNo': record.get('modelNo'),
        'houseType': record['houseType'],
        'supplyAreaM2': record['supplyAreaM2'],
        'observedAt': record.get('observedAt'),
    }


def _supply_proof(notices: list[dict]) -> tuple[dict, list[str]]:
    """Q-38 확정 공급면적의 comparison-evidence/v1 proof 객체와 참조 출처 목록을 만든다."""
    ordered = sorted(notices, key=lambda n: (n['houseManageNo'], n['noticeNo'], n['modelSource'], n['houseType']))
    parts = [
        f'{n["houseManageNo"]}/{n["noticeNo"]}:{n["houseType"]}:{n["modelSource"]}@{n.get("observedAt") or "unknown"}'
        for n in ordered
    ]
    sources = sorted({n['modelSource'] for n in ordered})
    return {'source': ordered[0]['modelSource'], 'reference': ';'.join(parts)}, sources


def _rights_cache_key(request_code: Optional[str], umd_name: Optional[str], parcel: Optional[dict],
                      norm_name: Optional[str]) -> Optional[str]:
    """단지번호가 없는 권리 거래 단지의 캐시 키. 법정동 사전 없이 거래 행만으로 같은 값을 만든다."""
    umd = normalize_text(umd_name).replace(' ', '')
    if (not isinstance(request_code, str) or not re.fullmatch(r'[0-9]{5}', request_code)
            or not umd or parcel is None or not norm_name):
        return None
    land_tag = '2' if parcel['isMountain'] else '1'
    return f'rights:{request_code}:{umd}:{land_tag}:{parcel["mainNo"]}:{parcel["subNo"]}:{norm_name[:60]}'


def _applyhome_cache_key(group: dict) -> Optional[str]:
    if group.get('aptSeq'):
        return f'aptseq:{group["aptSeq"]}'
    parcel = group.get('parcel')
    if parcel is not None:
        return _rights_cache_key(group.get('requestRegionCode'), parcel.get('subName') or group.get('localityName'),
                                 parcel, group.get('normName'))
    return None


def _address_fingerprint(group: dict) -> dict:
    return {
        'localityCode': group['localityCode'],
        'parcel': list(_parcel_tuple(group.get('parcel'))) if group.get('parcel') else None,
        'road': list(_road_tuple(group.get('road'))) if group.get('road') else None,
    }


def prefetch_cache_keys(capture: dict, *, limit: int = 500) -> list[str]:
    """수집본에서 DB 공유 캐시를 한 번에 조회할 단지·좌표 키 목록을 추출한다."""
    if not isinstance(capture, dict):
        return []
    keys = []
    seen = set()

    def add(key: Optional[str]):
        if key and key not in seen and len(keys) < limit:
            seen.add(key)
            keys.append(key)

    for batch in capture.get('tradeBatches') or []:
        record = batch.get('record') or {}
        source = record.get('source')
        req_code = record.get('requestRegionCode')
        if source not in SOURCE_KINDS or not isinstance(req_code, str) or len(req_code) != 5:
            continue
        for trade in batch.get('trades') or []:
            ids = trade.get('identifiers') or {}
            apt_seq = ids.get('aptSeq')
            if isinstance(apt_seq, str) and apt_seq.strip():
                add(f'aptseq:{apt_seq.strip()}')
            elif source == 'apt_rights':
                add(_rights_cache_key(req_code, ids.get('umdNm'), _extract_trade_parcel(ids, None, None),
                                      normalize_complex_name(ids.get('aptNm'))))
            umd_cd = ids.get('umdCd')
            if isinstance(umd_cd, str) and re.fullmatch(r'[0-9]{5}', umd_cd.strip()):
                b_code = req_code + umd_cd.strip()
                road = _extract_trade_road(ids, req_code)
                if road is not None:
                    add(coordinate_cache_key(b_code, road_name=road['roadName'],
                                             main_no=road['mainNo'], sub_no=road['subNo']))
                    parent_code = b_code[:8] + '00'
                    if parent_code != b_code:
                        add(coordinate_cache_key(parent_code, road_name=road['roadName'],
                                                 main_no=road['mainNo'], sub_no=road['subNo']))
    return keys


def _row_has_non_area_hold(item: dict) -> bool:
    trade = item['trade']
    source = item['source']
    withheld = {f for f in (trade.get('withheldFields') or []) if isinstance(f, str)}
    if withheld & set(IDENTIFIER_FIELDS[source]):
        return True
    if not normalize_text((trade.get('identifiers') or {}).get('aptNm')):
        return True
    if _known_kind(source, trade) is None:
        return True
    day = _contract_day(trade)
    if day is None or day.isoformat()[:7] != item['month']:
        return True
    if _cancellation(trade) != 'not_marked':
        return True
    amount = trade.get('amount') or {}
    if amount.get('status') != 'parsed' or _won(amount.get('won')) is None:
        return True
    return False


def collect_evidence_sources(evidence: dict, extra_sources=()) -> list[str]:
    """comparison-evidence/v1 안의 모든 .source 값과 추가 출처를 중복 없이 정렬해 반환한다."""
    sources = {src for src in extra_sources if isinstance(src, str) and src.strip()}
    stack = [evidence]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            src = item.get('source')
            if isinstance(src, str) and src.strip():
                sources.add(src.strip())
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    return sorted(sources)


def _active_trade_rows(capture: dict, period: dict, trade_kinds: list[str], by_code, by_name):
    """수집본에서 독립 제외(기간 밖·해제·미포함 종류)가 아닌 거래 행과 수집 상태를 추출한다."""
    months = set(period['months'])
    request_codes = set(capture['requestRegionCodes'])
    expected_batches = {
        (source, req_code, f'{ym[:4]}-{ym[4:]}')
        for source, supported in SOURCE_KINDS.items()
        if any(kind in trade_kinds for kind in supported)
        for req_code in request_codes
        for ym in months
    }
    seen_batches = set()
    batches_ok = True
    rows = []
    for batch in capture.get('tradeBatches') or []:
        record = batch.get('record') or {}
        source = record.get('source')
        req_code = record.get('requestRegionCode')
        month = record.get('month', '')
        if source not in SOURCE_KINDS or req_code not in request_codes or month.replace('-', '') not in months:
            continue
        if not any(kind in trade_kinds for kind in SOURCE_KINDS[source]):
            continue
        batch_key = (source, req_code, month)
        if batch_key in seen_batches:
            batches_ok = False
        seen_batches.add(batch_key)
        trades = batch.get('trades')
        if (record.get('status') not in ('complete', 'empty')
                or not isinstance(trades, list)
                or batch.get('reasons')
                or record.get('missingPages') != []
                or record.get('totalCountChanged') is not False
                or record.get('reportedTotalCount') != len(trades)):
            batches_ok = False
        for trade in (trades if isinstance(trades, list) else []):
            day = _contract_day(trade)
            if day is not None and not (period['start'] <= day.isoformat() <= period['end']):
                continue
            if _cancellation(trade) == 'cancelled':
                continue
            kind = _known_kind(source, trade)
            if kind is not None and kind not in trade_kinds:
                continue
            identifiers = trade.get('identifiers') or {}
            locality_code, sub_name = _trade_locality(source, req_code, identifiers, by_code, by_name)
            prov = trade.get('provenance') or {}
            rows.append({
                'recordId': record.get('recordId'),
                'source': source,
                'month': month,
                'page': prov.get('page'),
                'position': prov.get('position'),
                'requestRegionCode': req_code,
                'localityCode': locality_code,
                'subName': sub_name,
                'trade': trade,
                'identifiers': identifiers,
                'exclusiveRaw': (trade.get('exclusiveArea') or {}).get('m2'),
                'exclusiveDec': _area((trade.get('exclusiveArea') or {}).get('m2')),
            })
    if seen_batches != expected_batches:
        batches_ok = False
    return rows, batches_ok


def _group_scope_trades(scope_rows: list[dict], by_locality: dict, target_info: dict):
    """한 지역 범위(우선 또는 확대)의 거래를 aptSeq로 묶고 식별자 일관성과 대상 단지 여부를 판정한다."""
    sale_by_seq = defaultdict(list)
    missing_seq_rows = []
    rights_rows = []

    for item in scope_rows:
        if item['source'] == 'apt_trade':
            apt_seq = item['identifiers'].get('aptSeq')
            apt_seq = apt_seq.strip() if isinstance(apt_seq, str) and apt_seq.strip() else None
            if not apt_seq:
                missing_seq_rows.append(item)
            else:
                sale_by_seq[(item['requestRegionCode'], apt_seq)].append(item)
        else:
            rights_rows.append(item)

    groups = []
    parcel_to_groups = defaultdict(list)
    road_to_groups = defaultdict(list)

    for (req_code, apt_seq), items in sorted(sale_by_seq.items()):
        localities = {item['localityCode'] for item in items}
        raw_names = [normalize_text(item['identifiers'].get('aptNm')) for item in items]
        name_missing = any(not name for name in raw_names)
        names = {name for name in raw_names if name}
        norm_names = {normalize_complex_name(n) for n in names}
        parcels = []
        parcel_invalid = False
        roads = []
        road_invalid = False
        for item in items:
            ids = item['identifiers']
            # 실거래 XML의 공백(' ')·0000/00000은 미기재로 보며 실제 값이 있을 때만 형식·충돌을 판정한다.
            if _nonblank(ids.get('jibun')) or _nonzero_code(ids.get('bonbun')):
                p = _extract_trade_parcel(ids, item['localityCode'], item['subName'])
                if p is None:
                    parcel_invalid = True
                else:
                    parcels.append(p)
            if _nonblank(ids.get('roadNm')) or _nonzero_code(ids.get('roadNmBonbun')):
                r = _extract_trade_road(ids, req_code)
                if r is None:
                    road_invalid = True
                else:
                    roads.append(r)

        distinct_parcels = {_parcel_tuple(p): p for p in parcels}
        distinct_roads = {_road_tuple(r): r for r in roads}

        conflict = (
            len(localities) != 1
            or name_missing
            or len(norm_names) != 1
            or parcel_invalid
            or road_invalid
            or len(distinct_parcels) > 1
            or len(distinct_roads) > 1
            or (not distinct_parcels and not distinct_roads)
        )
        loc_code = next(iter(localities)) if len(localities) == 1 else None
        region = by_locality.get(loc_code) if loc_code else None
        parcel = next(iter(distinct_parcels.values())) if len(distinct_parcels) == 1 else None
        road = next(iter(distinct_roads.values())) if len(distinct_roads) == 1 else None
        display_name = sorted(names)[0] if names else apt_seq

        group = {
            'complexId': f'aptseq:{apt_seq}',
            'aptSeq': apt_seq,
            'requestRegionCode': req_code,
            'localityCode': loc_code,
            'localityName': region['localityName'] if region else None,
            'localityType': region['localityType'] if region else 'dong',
            'subBCode': (req_code + items[0]['identifiers']['umdCd'].strip())
            if (loc_code and region and region['localityType'] in ('eup', 'myeon')
                and isinstance(items[0]['identifiers'].get('umdCd'), str)
                and re.fullmatch(r'[0-9]{5}', items[0]['identifiers']['umdCd'].strip()))
            else None,
            'name': display_name,
            'normName': normalize_complex_name(display_name),
            'parcel': parcel,
            'road': road,
            'rows': list(items),
            'conflict': conflict,
            'isTarget': False,
            'sourceKind': 'apt_trade',
        }
        groups.append(group)
        if not conflict:
            if parcel is not None:
                parcel_to_groups[_parcel_tuple(parcel)].append(group)
            if road is not None:
                road_to_groups[_road_tuple(road)].append(group)

    # 같은 지번 또는 같은 도로명주소를 서로 다른 aptSeq가 공유하면 충돌 표시
    for bucket in (*parcel_to_groups.values(), *road_to_groups.values()):
        if len(bucket) > 1:
            for group in bucket:
                group['addressCollision'] = True

    # 분양권·입주권(apt_rights)은 검증된 동+지번+단지명으로 기존 aptSeq 그룹에 연결하거나 별도 권리 그룹으로 묶는다.
    rights_unlinked = []
    rights_groups_map = defaultdict(list)
    for item in rights_rows:
        ids = item['identifiers']
        name = normalize_text(ids.get('aptNm'))
        norm_name = normalize_complex_name(name)
        parcel = _extract_trade_parcel(ids, item['localityCode'], item['subName'])
        if not norm_name or parcel is None:
            rights_unlinked.append(item)
            continue
        p_key = _parcel_tuple(parcel)
        matched_sale = [g for g in parcel_to_groups.get(p_key, [])
                        if not g.get('conflict') and not g.get('addressCollision') and g['normName'] == norm_name]
        if len(matched_sale) == 1:
            matched_sale[0]['rows'].append(item)
            continue
        rights_groups_map[(item['requestRegionCode'], p_key, norm_name)].append((item, name, parcel))

    for (req_code, p_key, norm_name), entries in sorted(rights_groups_map.items()):
        first_item, display_name, parcel = entries[0]
        loc_code = parcel['localityCode']
        region = by_locality.get(loc_code)
        land_tag = '2' if parcel['isMountain'] else '1'
        cid = f'rights:{loc_code}:{land_tag}-{parcel["mainNo"]}-{parcel["subNo"]}:{norm_name[:40]}'
        group = {
            'complexId': cid,
            'aptSeq': None,
            'requestRegionCode': req_code,
            'localityCode': loc_code,
            'localityName': region['localityName'] if region else None,
            'localityType': region['localityType'] if region else 'dong',
            'subBCode': None,
            'name': display_name,
            'normName': norm_name,
            'parcel': parcel,
            'road': None,
            'rows': [entry[0] for entry in entries],
            'conflict': len(parcel_to_groups.get(p_key, [])) > 0,  # 같은 지번에 다른 이름의 aptSeq가 있으면 충돌
            'isTarget': False,
            'sourceKind': 'apt_rights',
        }
        groups.append(group)

    # 대상 공고 자체 거래 식별(Q-06 / A-22 / A-23): 이름만이나 지번만으로 단정하지 않고 주소+이름 일관성·충돌 부재를 확인한다.
    target_address = target_info.get('address')
    target_norm_name = normalize_complex_name(target_info.get('name'))
    region_catalog = target_info['regionCatalog']
    target_sgg = target_info['sggCode']
    target_loc = target_info['localityCode']
    target_loc_name = target_info['localityName']
    for group in groups:
        if group['conflict'] or group.get('addressCollision') or group['localityCode'] != target_loc:
            continue
        matched, match_kind = notice_address_matches_complex(
            target_address, region_catalog,
            sgg_code=target_sgg, locality_code=target_loc, locality_name=target_loc_name,
            parcel=group.get('parcel'), road=group.get('road'),
        )
        if not matched:
            continue
        # 도로명 일치 또는 (지번 일치 + 단지명 일치)일 때만 대상 단지로 인정한다(PRD §7.2.3).
        if match_kind in ('road', 'both') or (target_norm_name and group['normName'] == target_norm_name):
            group['isTarget'] = True
            group['complexId'] = target_info['complexId']

    return groups, missing_seq_rows + rights_unlinked


def _lookup_complex_notices_and_models(
    group: dict,
    region_catalog: LegalRegionCatalog,
    api_fetch: Callable,
    *,
    allowed_feeds: tuple[str, ...],
    max_pages: int,
    page_size: int,
    memo_list: dict,
    memo_model: dict,
    budget_state: dict,
) -> dict:
    """한 단지의 청약홈 후보 공고 조회, 주소 검증, 주택형 API 조회를 수행한다."""
    if not allowed_feeds:
        return {'status': 'held', 'reasonCode': 'lookup_failed', 'verifiedNotices': []}

    scopes = _candidate_search_scopes(group)
    candidate_rows = {}
    any_candidate_seen = False

    def guarded_collect(source: str, scope: dict, memo: dict):
        key = (source, tuple(sorted(scope.items())))
        if key in memo:
            return memo[key]
        if budget_state['fatalError']:
            return {'status': 'failed', 'observations': [], 'collectedAt': None}

        def counted_fetch(src, sc, page, size):
            if budget_state['calls'] >= budget_state['maxCalls']:
                budget_state['budgetReached'] = True
                raise EvidenceBudgetExceeded()
            budget_state['calls'] += 1
            try:
                envelope = api_fetch(src, sc, page, size)
            except EvidenceBudgetExceeded:
                budget_state['budgetReached'] = True
                budget_state['calls'] -= 1
                raise
            http_status = envelope.get('httpStatus') if isinstance(envelope, dict) else None
            if http_status in (401, 403, 429):
                budget_state['fatalError'] = True
            return envelope

        try:
            result = collect_pages(source, scope, counted_fetch, page_size=page_size, max_pages=max_pages)
        except EvidenceBudgetExceeded:
            return {'status': 'budget_exceeded', 'observations': [], 'collectedAt': None}
        except (AttributeError, HTTPException, KeyError, OSError, RuntimeError, TypeError, ValueError):
            # 근거 조회 응답의 형식·전송 오류는 실행 실패가 아니라 그 단지의 조회 실패 보류로 남긴다.
            # 임대 상실·실행 상한(CaptureStopped, BaseException)은 잡지 않고 그대로 중단한다.
            return {'status': 'failed', 'observations': [], 'collectedAt': None}
        memo[key] = result
        return result

    for feed in allowed_feeds:
        for scope in scopes:
            listing = guarded_collect(feed, scope, memo_list)
            status = listing.get('status')
            if status == 'budget_exceeded':
                return {'status': 'held', 'reasonCode': 'lookup_budget_exceeded', 'verifiedNotices': []}
            if status not in ('complete', 'empty'):
                return {'status': 'held', 'reasonCode': 'lookup_failed', 'verifiedNotices': []}
            for obs in listing.get('observations') or []:
                row = obs.get('row') or {}
                if not _is_supported_apartment_notice(feed, row):
                    continue
                any_candidate_seen = True
                hm_no = str(row.get('HOUSE_MANAGE_NO') or '').strip()
                pb_no = str(row.get('PBLANC_NO') or '').strip()
                if not hm_no or not pb_no:
                    continue
                pair_key = (feed, hm_no, pb_no)
                if pair_key not in candidate_rows:
                    candidate_rows[pair_key] = (row, listing.get('collectedAt'))

    verified_pairs = []
    for (feed, hm_no, pb_no), (row, observed_at) in sorted(candidate_rows.items()):
        addr = row.get('HSSPLY_ADRES')
        matched, _ = notice_address_matches_complex(
            addr,
            region_catalog,
            sgg_code=group['requestRegionCode'],
            locality_code=group['localityCode'],
            locality_name=group['localityName'],
            parcel=group.get('parcel'),
            road=group.get('road'),
        )
        if matched:
            verified_pairs.append((feed, hm_no, pb_no, row, observed_at))

    if not verified_pairs:
        reason = 'complex_identity_mismatch' if any_candidate_seen else 'notice_not_found'
        return {'status': 'held', 'reasonCode': reason, 'verifiedNotices': []}

    verified_notices = []
    for feed, hm_no, pb_no, row, notice_observed_at in verified_pairs:
        model_source = feed + '_model'
        model_scope = {'cond[HOUSE_MANAGE_NO::EQ]': hm_no, 'cond[PBLANC_NO::EQ]': pb_no}
        models_res = guarded_collect(model_source, model_scope, memo_model)
        status = models_res.get('status')
        if status == 'budget_exceeded':
            return {'status': 'held', 'reasonCode': 'lookup_budget_exceeded', 'verifiedNotices': []}
        if status != 'complete':
            return {'status': 'held', 'reasonCode': 'lookup_failed', 'verifiedNotices': []}
        model_rows = [obs['row'] for obs in models_res.get('observations') or []]
        if not model_rows:
            return {'status': 'held', 'reasonCode': 'lookup_failed', 'verifiedNotices': []}
        edition = str(row.get('RCRIT_PBLANC_DE') or '').strip() or None
        verified_notices.append({
            'source': feed,
            'modelSource': model_source,
            'houseManageNo': hm_no,
            'noticeNo': pb_no,
            'edition': edition,
            'observedAt': models_res.get('collectedAt') or notice_observed_at,
            'models': [
                {
                    'MODEL_NO': m.get('MODEL_NO'),
                    'HOUSE_TY': m.get('HOUSE_TY'),
                    'SUPLY_AR': m.get('SUPLY_AR'),
                }
                for m in model_rows
            ],
        })

    return {'status': 'ok', 'reasonCode': None, 'verifiedNotices': verified_notices}


def _target_models_from_capture(capture: dict) -> list[dict]:
    """대상 공고 자체 거래에 사용할 대상 공고 주택형 목록을 수집본 카탈로그에서 추출한다."""
    catalog = capture.get('catalog') or {}
    notice = catalog.get('notice') or {}
    target = capture.get('target') or {}
    source = notice.get('source')
    if source not in NOTICE_SOURCES:
        return []
    models = []
    for m in catalog.get('housingTypes') or []:
        if m.get('status') != 'linked':
            continue
        ht = (m.get('houseType') or {}).get('value')
        sa = (m.get('supplyArea') or {}).get('m2')
        if ht and sa:
            models.append({'MODEL_NO': m.get('modelNo'), 'HOUSE_TY': ht, 'SUPLY_AR': sa})
    if not models:
        return []
    observed_at = None
    for col in capture.get('catalogCollections') or []:
        if col.get('source') == source + '_model' and col.get('collectedAt'):
            observed_at = col['collectedAt']
    return [{
        'source': source,
        'modelSource': source + '_model',
        'houseManageNo': target['houseManageNo'],
        'noticeNo': target['noticeNo'],
        'edition': target['edition'],
        'observedAt': observed_at,
        'models': models,
    }]


def _target_supply_bounds(capture: dict, model_no: Optional[str]) -> Optional[tuple[Decimal, Decimal]]:
    catalog = capture.get('catalog') or {}
    target = capture.get('target') or {}
    selection = {'modelNo': model_no} if model_no is not None else {}
    model, _ = _selected_model(catalog, selection)
    if model is None:
        return None
    documents = _documents(catalog, target)
    _, amount = _checked_target_area(model, documents)
    if amount is None:
        return None
    with localcontext(Context(prec=len(format(amount, 'f')) + len(format(DEFAULT_TOLERANCE, 'f')) + 4)):
        delta = amount * DEFAULT_TOLERANCE / Decimal('100')
        return amount - delta, amount + delta


def build_comparison_evidence(
    capture: dict,
    *,
    region_catalog: Optional[LegalRegionCatalog],
    api_fetch: Callable,
    kakao_fetch: Optional[Callable] = None,
    model_no: Optional[str] = None,
    permissions: Optional[dict] = None,
    applyhome_cache: Optional[dict] = None,
    kakao_cache: Optional[dict] = None,
    max_applyhome_calls: int = DEFAULT_APPLYHOME_REQUEST_LIMIT,
    max_kakao_calls: int = 30,
    max_applyhome_pages: int = DEFAULT_APPLYHOME_MAX_PAGES,
    applyhome_page_size: int = DEFAULT_APPLYHOME_PAGE_SIZE,
    applyhome_cache_ttl_days: int = DEFAULT_APPLYHOME_CACHE_TTL_DAYS,
    kakao_cache_ttl_days: int = DEFAULT_KAKAO_CACHE_TTL_DAYS,
    now: Optional[Callable[[], datetime]] = None,
) -> dict:
    """수집본에서 comparison-evidence/v1 근거(실행용·저장용), 출처 목록, 메타데이터, 새 캐시 항목을 만든다."""
    clock_now = now or (lambda: datetime.now(timezone.utc))
    generated_dt = clock_now()
    generated_at = generated_dt.isoformat()
    applyhome_expires_at = (
        generated_dt + timedelta(days=max(1, min(90, int(applyhome_cache_ttl_days))))
    ).isoformat()
    perms = {
        'applyhomeApt': True,
        'applyhomeRemainder': True,
        'moisRegions': True,
        'kakaoRuntime': True,
        'kakaoStorage': False,
        **(permissions or {}),
    }
    base_meta = {
        'contractVersion': 'comparison-evidence-meta/v1',
        'generatedAt': generated_at,
        'calls': {'applyhome': 0, 'kakao': 0, 'regions': 0},
        'limits': {'applyhome': max_applyhome_calls, 'kakao': max_kakao_calls},
        'cacheHits': {'applyhome': 0, 'kakao': 0, 'regions': 0},
        'budgetReached': {'applyhome': False, 'kakao': False},
        'kakaoStorageAllowed': bool(perms['kakaoStorage']),
        'kakaoRuntimeAllowed': bool(perms['kakaoRuntime']),
        'coordinatesPersisted': False,
        'scopeChecked': None,
        'status': 'held',
        'reasonCode': None,
        'complexSummary': {'confirmed': 0, 'held': 0, 'holdReasons': {}},
        'complexes': [],
    }

    def held_output(reason_code: str):
        base_meta['reasonCode'] = reason_code
        return {
            'status': 'held',
            'reasonCode': reason_code,
            'runtimeEvidence': None,
            'persistedEvidence': None,
            'persistedSourceIds': [],
            'metadata': base_meta,
            'newCacheEntries': [],
        }

    if not isinstance(capture, dict) or capture.get('contractVersion') != 'ingestion/v0':
        return held_output('capture_invalid')
    period = _period(capture)
    if period is None or period.get('status') != 'confirmed':
        return held_output('contract_period_unverified')
    if region_catalog is None or not perms['moisRegions']:
        return held_output('region_catalog_unavailable')

    req_regions = capture.get('requestRegionCodes') or []
    if len(req_regions) != 1:
        return held_output('request_region_unverified')
    sgg_code = req_regions[0]
    sgg_entry = region_catalog.sgg_entry(sgg_code)
    regions = region_catalog.regions_for(sgg_code)
    if sgg_entry is None or not regions:
        return held_output('region_catalog_unavailable')

    catalog = capture.get('catalog') or {}
    notice = catalog.get('notice') or {}
    notice_source = notice.get('source')
    notice_fields = notice.get('fields') or {}
    address_field = notice_fields.get('HSSPLY_ADRES') or {}
    name_field = notice_fields.get('HOUSE_NM') or {}
    notice_address = address_field.get('value') if address_field.get('status') == 'reported' else None
    notice_name = name_field.get('value') if name_field.get('status') == 'reported' else None
    notice_ev = [ref for ref in (notice.get('evidence') or []) if isinstance(ref, dict) and ref.get('collection') == 'notice']
    if notice.get('status') != 'reported' or notice_source not in NOTICE_SOURCES or not notice_address or len(notice_ev) != 1:
        return held_output('target_notice_unverified')

    priority_region = region_catalog.resolve_locality_in_sgg(sgg_code, notice_address)
    if priority_region is None:
        return held_output('priority_region_unverified')

    target = capture['target']
    target_complex_id = f'target:{target["houseManageNo"]}:{target["noticeNo"]}'
    target_info = {
        'complexId': target_complex_id,
        'name': notice_name or target_complex_id,
        'address': notice_address,
        'sggCode': sgg_code,
        'sggFullName': sgg_entry['name'],
        'localityCode': priority_region['localityCode'],
        'localityName': priority_region['localityName'],
        'localityType': priority_region['localityType'],
        'regionCatalog': region_catalog,
    }

    by_locality, by_code, by_name = _build_region_index(regions)
    trade_kinds = list(capture.get('tradeKinds') or TRADE_KINDS)
    all_rows, batches_complete = _active_trade_rows(capture, period, trade_kinds, by_code, by_name)

    allowed_feeds = tuple(
        feed for feed, ok in (('applyhome_apt', perms['applyhomeApt']),
                              ('applyhome_remainder', perms['applyhomeRemainder'])) if ok
    )
    budget_state = {'calls': 0, 'maxCalls': max_applyhome_calls, 'budgetReached': False, 'fatalError': False}
    memo_list, memo_model = {}, {}
    new_cache_entries = []
    usable_applyhome_cache = applyhome_cache if isinstance(applyhome_cache, dict) else {}
    target_bounds = _target_supply_bounds(capture, model_no)

    complexes_map = {
        target_complex_id: {
            'complexId': target_complex_id,
            'name': target_info['name'],
            'localityCode': priority_region['localityCode'],
            'evidence': {
                'source': notice_source,
                'reference': f'{target["houseManageNo"]}/{target["noticeNo"]}:{target["edition"]}',
            },
        }
    }
    trade_links = []
    extra_sources = {notice_source, REGION_SOURCE_ID}
    complex_meta_records = []
    hold_reason_counts = Counter()
    confirmed_complex_count = 0
    held_complex_count = 0
    coord_requests_by_id = {
        target_complex_id: {
            'complexId': target_complex_id,
            'localityCode': priority_region['localityCode'],
            'localityType': priority_region['localityType'],
            'sggFullName': sgg_entry['name'],
            'noticeAddress': notice_address,
        }
    }

    def process_scope(scope_rows: list[dict], role: str) -> dict:
        nonlocal confirmed_complex_count, held_complex_count
        groups, unlinked_rows = _group_scope_trades(scope_rows, by_locality, target_info)
        scope_confirmed_neighbors = 0
        scope_in_range_neighbors = 0
        scope_neighbor_holds = len(unlinked_rows)

        if unlinked_rows:
            hold_reason_counts['complex_identity_mismatch'] += len(unlinked_rows)

        for group in groups:
            cid = group['complexId']
            is_target = group['isTarget']
            cache_key = _applyhome_cache_key(group)
            fingerprint = _address_fingerprint(group)
            excl_by_dec = {}
            for item in group['rows']:
                if item['exclusiveDec'] is not None:
                    excl_by_dec.setdefault(item['exclusiveDec'], _canonical_decimal_str(item['exclusiveDec']))
            excl_pairs = sorted(excl_by_dec.items())

            if group['conflict'] or group.get('addressCollision'):
                if not is_target:
                    scope_neighbor_holds += 1
                    held_complex_count += 1
                    hold_reason_counts['complex_identifier_conflict'] += 1
                for item in group['rows']:
                    trade_links.append({
                        'recordId': item['recordId'],
                        'source': item['source'],
                        'page': item['page'],
                        'position': item['position'],
                        'status': 'conflict',
                    })
                complex_meta_records.append({
                    'complexKey': cache_key,
                    'complexId': cid,
                    'scope': role,
                    'localityCode': group['localityCode'],
                    'isTarget': is_target,
                    'status': 'held',
                    'reasonCode': 'complex_identifier_conflict',
                    'areas': [],
                })
                continue

            # 식별 일관성이 확인된 단지를 complexes에 등록
            if cid not in complexes_map:
                ref_id = f'aptSeq:{group["aptSeq"]}' if group['aptSeq'] else cid
                complexes_map[cid] = {
                    'complexId': cid,
                    'name': group['name'],
                    'localityCode': group['localityCode'],
                    'evidence': {
                        'source': group['sourceKind'],
                        'reference': f'{ref_id}|bjd:{group["localityCode"]}',
                    },
                }

            # 1) 캐시 적중 확인 (청약홈 구조화 자료). 대상 단지 자체 거래도 모든 공고의 Q-38 일치를 확인한다.
            target_capture_notices = _target_models_from_capture(capture) if is_target else []
            verified_notices = []
            lookup_reason = None
            from_cache = False

            if cache_key and cache_key in usable_applyhome_cache:
                cached = usable_applyhome_cache[cache_key]
                if isinstance(cached, dict) and cached.get('addressFingerprint') == fingerprint:
                    cached_status = cached.get('lookupStatus')
                    if cached_status == 'ok' and isinstance(cached.get('verifiedNotices'), list):
                        base_meta['cacheHits']['applyhome'] += 1
                        from_cache = True
                        verified_notices = copy.deepcopy(cached['verifiedNotices'])
                    elif cached_status == 'not_found':
                        base_meta['cacheHits']['applyhome'] += 1
                        from_cache = True
                        lookup_reason = cached.get('reasonCode') or 'notice_not_found'
                        verified_notices = []

            if not from_cache:
                lookup = _lookup_complex_notices_and_models(
                    group, region_catalog, api_fetch,
                    allowed_feeds=allowed_feeds,
                    max_pages=max_applyhome_pages,
                    page_size=applyhome_page_size,
                    memo_list=memo_list,
                    memo_model=memo_model,
                    budget_state=budget_state,
                )
                if lookup['status'] == 'ok':
                    verified_notices = lookup['verifiedNotices']
                    if cache_key and verified_notices:
                        used_sources = sorted(
                            {s for n in verified_notices for s in (n['source'], n['modelSource'])}
                        )
                        new_cache_entries.append({
                            'complexKey': cache_key,
                            'cacheKind': 'applyhome_supply_area',
                            'sourceIds': used_sources,
                            'observedAt': generated_at,
                            'expiresAt': applyhome_expires_at,
                            'entryData': {
                                'addressFingerprint': fingerprint,
                                'lookupStatus': 'ok',
                                'verifiedNotices': copy.deepcopy(verified_notices),
                            },
                        })
                else:
                    lookup_reason = lookup['reasonCode']
                    verified_notices = []
                    # 조회 실패·예산 초과는 캐시하지 않는다. 완전 조회 후 공고 없음만 캐시한다.
                    if (cache_key and lookup_reason in ('notice_not_found', 'complex_identity_mismatch')
                            and len(allowed_feeds) == len(NOTICE_SOURCES)):
                        new_cache_entries.append({
                            'complexKey': cache_key,
                            'cacheKind': 'applyhome_supply_area',
                            'sourceIds': list(NOTICE_SOURCES),
                            'observedAt': generated_at,
                            'expiresAt': applyhome_expires_at,
                            'entryData': {
                                'addressFingerprint': fingerprint,
                                'lookupStatus': 'not_found',
                                'reasonCode': lookup_reason,
                                'verifiedNotices': [],
                            },
                        })

            # 대상 단지 자체 거래는 전체 공고 조회가 실패·예산초과가 아닐 때 대상 수집 공고 주택형도 합쳐 검증한다.
            if is_target and target_capture_notices and lookup_reason not in ('lookup_failed', 'lookup_budget_exceeded'):
                existing_pairs = {(n['source'], n['houseManageNo'], n['noticeNo']) for n in verified_notices}
                for n in target_capture_notices:
                    if (n['source'], n['houseManageNo'], n['noticeNo']) not in existing_pairs:
                        verified_notices.append(n)

            area_outcomes = (
                _apply_q38_rules(excl_pairs, verified_notices)
                if verified_notices else {
                    excl_dec: {'status': 'held', 'reasonCode': lookup_reason or 'notice_not_found',
                               'supplyAreaM2': None, 'notices': []}
                    for excl_dec, _ in excl_pairs
                }
            )

            group_has_confirmed = False
            group_has_in_range = False
            group_has_hold = False
            area_meta = []
            for excl_dec, excl_str in excl_pairs:
                outcome = area_outcomes[excl_dec]
                area_meta.append({
                    'exclusiveAreaM2': excl_str,
                    'status': outcome['status'],
                    'supplyAreaM2': outcome['supplyAreaM2'],
                    'reasonCode': outcome['reasonCode'],
                    'notices': outcome['notices'],
                })
                if outcome['status'] == 'confirmed':
                    group_has_confirmed = True
                    supply_dec = Decimal(outcome['supplyAreaM2'])
                    if target_bounds is None or (target_bounds[0] <= supply_dec <= target_bounds[1]):
                        group_has_in_range = True
                else:
                    group_has_hold = True
                    if not is_target and outcome['reasonCode']:
                        hold_reason_counts[outcome['reasonCode']] += 1

            # 거래 행별 tradeLinks 구성
            for item in group['rows']:
                if item['exclusiveDec'] is None:
                    if not is_target:
                        scope_neighbor_holds += 1
                    continue
                if not is_target and _row_has_non_area_hold(item):
                    scope_neighbor_holds += 1
                outcome = area_outcomes.get(item['exclusiveDec'])
                if outcome and outcome['status'] == 'confirmed':
                    proof, used_model_sources = _supply_proof(outcome['notices'])
                    extra_sources.update(used_model_sources)
                    trade_links.append({
                        'recordId': item['recordId'],
                        'source': item['source'],
                        'page': item['page'],
                        'position': item['position'],
                        'identifiers': copy.deepcopy(item['identifiers']),
                        'exclusiveAreaM2': item['exclusiveRaw'],
                        'complexId': cid,
                        'supplyAreaM2': outcome['supplyAreaM2'],
                        'evidence': proof,
                    })
                else:
                    # 단지 식별은 확인됐으나 공급면적 대응이 보류된 경우 -> compare_trades에서 trade_supply_area_unverified
                    if not is_target:
                        scope_neighbor_holds += 1
                    trade_links.append({
                        'recordId': item['recordId'],
                        'source': item['source'],
                        'page': item['page'],
                        'position': item['position'],
                        'identifiers': copy.deepcopy(item['identifiers']),
                        'exclusiveAreaM2': item['exclusiveRaw'],
                        'complexId': cid,
                        'evidence': {
                            'source': item['source'],
                            'reference': f'{cid}|reason:{(outcome or {}).get("reasonCode") or "unverified"}',
                        },
                    })

            if not is_target:
                if group_has_confirmed:
                    scope_confirmed_neighbors += 1
                    confirmed_complex_count += 1
                if group_has_in_range:
                    scope_in_range_neighbors += 1
                    # ±5% 범위 안에 들어온 비교 후보 단지는 대표 좌표를 조회 대상으로 올린다.
                    road = group.get('road')
                    coord_requests_by_id[cid] = {
                        'complexId': cid,
                        'localityCode': group['localityCode'],
                        'localityType': group['localityType'],
                        'subBCode': group.get('subBCode'),
                        'sggFullName': sgg_entry['name'],
                        'roadName': road['roadName'] if road else None,
                        'roadMain': road['mainNo'] if road else None,
                        'roadSub': road['subNo'] if road else None,
                    }
                if group_has_hold and not group_has_confirmed:
                    held_complex_count += 1

            complex_meta_records.append({
                'complexKey': cache_key,
                'complexId': cid,
                'scope': role,
                'localityCode': group['localityCode'],
                'isTarget': is_target,
                'status': 'confirmed' if group_has_confirmed and not group_has_hold else ('partial' if group_has_confirmed else 'held'),
                'reasonCode': None if group_has_confirmed and not group_has_hold else (
                    next((a['reasonCode'] for a in area_meta if a['reasonCode']), lookup_reason)
                ),
                'areas': area_meta,
            })

        return {
            'confirmedNeighbors': scope_confirmed_neighbors,
            'inRangeNeighbors': scope_in_range_neighbors,
            'neighborHolds': scope_neighbor_holds,
        }

    # 1) 우선 지역(같은 법정동·읍·면) 거래만 먼저 처리한다.
    priority_rows = [row for row in all_rows if row['localityCode'] == priority_region['localityCode']]
    unresolved_region_rows = [row for row in all_rows if row['localityCode'] is None]
    priority_stats = process_scope(priority_rows, 'priority')
    scope_checked = 'priority'

    # 2) 우선 지역이 정상 0개(수집 완료 + 지역 미배정 0건 + 주변 보류 0건 + 범위 안 주변 후보 0개)일 때만 확대 지역 조회!
    can_expand = (
        batches_complete
        and not unresolved_region_rows
        and priority_stats['inRangeNeighbors'] == 0
        and priority_stats['neighborHolds'] == 0
    )
    if can_expand:
        expansion_rows = [
            row for row in all_rows
            if row['localityCode'] is not None and row['localityCode'] != priority_region['localityCode']
        ]
        if expansion_rows:
            process_scope(expansion_rows, 'expansion')
            scope_checked = 'expansion'

    # 3) 대표 좌표 확인(Q-39): 비교 후보가 1개 이상일 때만 대상 공고 + 후보 단지를 조회한다.
    coord_summary = {'results': {}, 'calls': 0, 'cacheHits': 0, 'budgetReached': False, 'newCacheEntries': []}
    if len(coord_requests_by_id) > 1:
        ordered_requests = [coord_requests_by_id[target_complex_id]] + [
            req for cid, req in sorted(coord_requests_by_id.items()) if cid != target_complex_id
        ]
        coord_summary = resolve_complex_coordinates(
            ordered_requests,
            kakao_fetch,
            allow_runtime=bool(perms['kakaoRuntime']),
            allow_storage=bool(perms['kakaoStorage']),
            cache_entries=kakao_cache,
            max_calls=max_kakao_calls,
            cache_ttl_days=kakao_cache_ttl_days,
            now=clock_now,
        )
        new_cache_entries.extend(coord_summary['newCacheEntries'])

    for cid, coord_res in coord_summary['results'].items():
        if coord_res['status'] == 'confirmed' and coord_res['coordinates'] is not None and cid in complexes_map:
            complexes_map[cid]['coordinates'] = coord_res['coordinates']

    for record in complex_meta_records:
        cid = record['complexId']
        if cid in coord_summary['results']:
            cres = coord_summary['results'][cid]
            record['coordinateStatus'] = cres['status']
            record['coordinateReasonCode'] = cres['reasonCode']
            record['coordinateObservedAt'] = cres['observedAt']

    notice_loc = notice_ev[0]
    runtime_evidence = {
        'contractVersion': 'comparison-evidence/v1',
        'dataOrigin': capture['dataOrigin'],
        'target': {
            **target,
            'notice': {
                'source': notice_source,
                'page': notice_loc['page'],
                'position': notice_loc['position'],
                'address': notice_address,
            },
            'complexId': target_complex_id,
            'evidence': {
                'source': notice_source,
                'reference': f'{target["houseManageNo"]}/{target["noticeNo"]}:{target["edition"]}',
            },
        },
        'scopes': {
            'priority': {
                'code': priority_region['localityCode'],
                'requestRegionCodes': [sgg_code],
                'evidence': {'source': REGION_SOURCE_ID, 'reference': priority_region['localityCode']},
            },
            'expansion': {
                'kind': sgg_entry['expansionKind'],
                'code': sgg_entry['expansionCode'],
                'name': sgg_entry['name'],
                'requestRegionCodes': [sgg_code],
                'evidence': {'source': REGION_SOURCE_ID, 'reference': sgg_entry['expansionCode']},
            },
        },
        'regions': regions,
        'complexes': list(complexes_map.values()),
        'tradeLinks': trade_links,
    }

    coordinates_persisted = bool(perms['kakaoStorage']) and any(
        isinstance(c.get('coordinates'), dict) for c in runtime_evidence['complexes']
    )
    persisted_evidence = (
        copy.deepcopy(runtime_evidence)
        if perms['kakaoStorage']
        else strip_kakao_coordinates(runtime_evidence)
    )
    persisted_source_ids = collect_evidence_sources(persisted_evidence, extra_sources)
    if not perms['kakaoStorage']:
        persisted_source_ids = [s for s in persisted_source_ids if s != KAKAO_SOURCE_ID]

    base_meta.update({
        'status': 'ready',
        'reasonCode': None,
        'scopeChecked': scope_checked,
        'coordinatesPersisted': coordinates_persisted,
        'calls': {
            'applyhome': budget_state['calls'],
            'kakao': coord_summary['calls'],
            'regions': 0,
        },
        'cacheHits': {
            'applyhome': base_meta['cacheHits']['applyhome'],
            'kakao': coord_summary['cacheHits'],
            'regions': 0,
        },
        'budgetReached': {
            'applyhome': budget_state['budgetReached'],
            'kakao': coord_summary['budgetReached'],
        },
        'targetCoordinateStatus': (coord_summary['results'].get(target_complex_id) or {}).get('status', 'not_queried'),
        'targetCoordinateReasonCode': (coord_summary['results'].get(target_complex_id) or {}).get('reasonCode'),
        'complexSummary': {
            'confirmed': confirmed_complex_count,
            'held': held_complex_count,
            'holdReasons': dict(sorted(hold_reason_counts.items())),
        },
        'complexes': complex_meta_records,
    })

    return {
        'status': 'ready',
        'reasonCode': None,
        'runtimeEvidence': runtime_evidence,
        'persistedEvidence': persisted_evidence,
        'persistedSourceIds': persisted_source_ids,
        'metadata': base_meta,
        'newCacheEntries': new_cache_entries,
    }
