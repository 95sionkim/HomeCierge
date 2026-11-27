#!/usr/bin/env python3
"""공고일의 법령 버전과 탐색용 조문 제목을 확인한다. 기본 실행은 합성 응답을 사용한다."""
import argparse
import http.client
import json
import os
import re
from datetime import date, datetime, timedelta, timezone
from typing import NamedTuple
from urllib import error, parse, request

from credential_redaction import redact_text
from ingestion_pages import OK_RESULT_CODES, loads_source_json
from probe_apis import ROOT, NoRedirect, api_error, read_keys
from worker_rpc import WorkerRpc, WorkerRpcError, WorkerRpcResponseTooLarge


TITLE = '주택공급에 관한 규칙'
PAGE_SIZE = 100
MAX_PAGES = 5
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_ARTICLES = 64
SEOUL = timezone(timedelta(hours=9))
FIXTURE = ROOT / 'tests/fixtures/law-evidence-synthetic.json'
HEADING_TERMS = re.compile(r'공고|공급계약|공급대상|공급자격|(?:입주(?:대상)?자|청약|신청)자격|재공급')
NONPUBLIC_HEADING = re.compile(r'[<>@]|://|www\.', re.IGNORECASE)


class LawEvidenceHold(ValueError):
    """상류 응답이나 인증값 대신 고정된 보류 코드만 전달한다."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class Version(NamedTuple):
    mst: str
    law_id: str
    promulgated_on: date
    effective_on: date
    promulgation_number: str


def decimal_text(value):
    if type(value) is int and 0 <= value < 10 ** 20:
        value = str(value)
    return value if isinstance(value, str) and re.fullmatch(r'[0-9]{1,20}', value) else None


def same_number(value, expected):
    digits = decimal_text(value)
    return digits is not None and int(digits) == int(expected)


def source_date(value):
    digits = decimal_text(value)
    if digits is not None and len(digits) == 8:
        try:
            return date(int(digits[:4]), int(digits[4:6]), int(digits[6:]))
        except ValueError:
            pass
    return None


def rows_at(value, reason):
    # 공식 JSON의 반복 항목은 한 건일 때 객체일 수 있다.
    rows = [value] if isinstance(value, dict) else value
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise LawEvidenceHold(reason)
    return rows


def select_version(as_of, fetch):
    """전체 페이지를 검산한 뒤 시행일이 가장 늦은 후보의 유일성을 확인한다."""
    total = None
    seen = set()
    eligible = []
    for page in range(1, MAX_PAGES + 1):
        payload = fetch('law_search', {'page': page})
        result = payload.get('LawSearch') if isinstance(payload, dict) else None
        if (not isinstance(result, dict) or api_error(payload) or api_error(result) or result.get('target') != 'eflaw'
                or str(result.get('resultCode')) not in OK_RESULT_CODES
                or result.get('키워드', TITLE) != TITLE):
            raise LawEvidenceHold('law_search_unverified')

        count = decimal_text(result.get('totalCnt'))
        if (count is None or (total is not None and int(count) != total)
                or decimal_text(result.get('page')) != str(page)):
            raise LawEvidenceHold('law_search_incomplete')
        total = int(count)
        if total > PAGE_SIZE * MAX_PAGES:
            raise LawEvidenceHold('law_search_limit')
        entries = result.get('law')
        rows = rows_at([] if entries is None and total == 0 else entries, 'law_search_incomplete')
        expected = min(PAGE_SIZE, total - (page - 1) * PAGE_SIZE)
        if (len(rows) != expected or ('numOfRows' in result
                and decimal_text(result['numOfRows']) != str(expected))):
            raise LawEvidenceHold('law_search_incomplete')

        for row in rows:
            title = row.get('법령명한글')
            mst = decimal_text(row.get('법령일련번호'))
            effective = source_date(row.get('시행일자'))
            if (not isinstance(title, str) or not title.strip() or not mst or not mst.lstrip('0')
                    or effective is None):
                raise LawEvidenceHold('law_search_incomplete')
            # 같은 MST에 시행일이 여러 개일 수 있다. 두 값의 조합이 버전을 식별한다.
            key = (int(mst), effective)
            if key in seen:
                raise LawEvidenceHold('law_search_incomplete')
            seen.add(key)
            if title != TITLE:
                continue

            law_id = decimal_text(row.get('법령ID'))
            promulgated = source_date(row.get('공포일자'))
            promulgation_number = decimal_text(row.get('공포번호'))
            if not law_id or not law_id.lstrip('0') or promulgated is None or not promulgation_number:
                raise LawEvidenceHold('law_version_unverified')
            if effective <= as_of and promulgated <= as_of:
                eligible.append(Version(mst, law_id, promulgated, effective, promulgation_number))
        if len(seen) == total:
            break

    if not eligible:
        raise LawEvidenceHold('law_version_not_found')
    latest = max(version.effective_on for version in eligible)
    matches = [version for version in eligible if version.effective_on == latest]
    if len(matches) != 1 or len({int(version.law_id) for version in eligible}) != 1:
        raise LawEvidenceHold('law_version_ambiguous')
    return matches[0]


def confirm_body(version, fetch):
    effective = version.effective_on.isoformat().replace('-', '')
    payload = fetch('law_body', {'MST': version.mst, 'efYd': effective})
    law = payload.get('법령') if isinstance(payload, dict) else None
    basic = law.get('기본정보') if isinstance(law, dict) else None
    if (not isinstance(basic, dict) or api_error(payload) or api_error(law)
            or basic.get('법령명_한글') != TITLE
            or not same_number(basic.get('법령ID'), version.law_id)
            or source_date(basic.get('공포일자')) != version.promulgated_on
            or not same_number(basic.get('공포번호'), version.promulgation_number)
            or source_date(basic.get('시행일자')) != version.effective_on):
        raise LawEvidenceHold('law_body_unverified')

    # E-05 본문은 MST를 반향하지 않는다. 요청에 MST·시행일을 고정하고 공식 기본정보를 대조한다.
    for metadata in (payload, law, basic):
        for field in ('MST', '법령일련번호'):
            if field in metadata and not same_number(metadata[field], version.mst):
                raise LawEvidenceHold('law_body_unverified')
    return law


def navigation_articles(law, as_of):
    section = law.get('조문')
    if section is not None and not isinstance(section, dict):
        raise LawEvidenceHold('law_articles_unverified')
    units = section.get('조문단위') if section is not None else None
    rows = rows_at([] if units is None else units, 'law_articles_unverified')
    articles = {}
    for row in rows:
        kind = row.get('조문여부')
        if kind == '전문':
            continue
        heading = row.get('조문제목')
        if kind != '조문' or not isinstance(heading, str):
            raise LawEvidenceHold('law_articles_unverified')
        if not HEADING_TERMS.search(''.join(heading.split())):
            continue
        effective = source_date(row.get('조문시행일자'))
        if effective is None:
            raise LawEvidenceHold('law_articles_unverified')
        if effective > as_of:
            continue

        raw_branch = row.get('조문가지번호')
        number = decimal_text(row.get('조문번호'))
        branch = '0' if raw_branch is None or raw_branch == '' else decimal_text(raw_branch)
        if (not number or not 1 <= int(number) <= 9999 or branch is None or int(branch) > 99
                or NONPUBLIC_HEADING.search(heading) or not heading.isprintable()
                or not 1 <= len(heading.strip()) <= 160):
            raise LawEvidenceHold('law_articles_unverified')
        key = (int(number), int(branch))
        if key in articles or len(articles) >= MAX_ARTICLES:
            raise LawEvidenceHold('law_articles_unverified')
        articles[key] = {'number': str(key[0]), 'branch': str(key[1]) if key[1] else None,
                         'heading': heading.strip()}
    if not articles:
        raise LawEvidenceHold('law_articles_not_found')
    return [articles[key] for key in sorted(articles)]


def collect_law_reference(as_of, fetch, *, observed_at, data_origin):
    """검증된 경우에만 게시 계약에 담을 키를 구성한다."""
    if not isinstance(as_of, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', as_of):
        raise LawEvidenceHold('invalid_date')
    try:
        cutoff = date.fromisoformat(as_of)
    except ValueError:
        raise LawEvidenceHold('invalid_date') from None
    if (data_origin not in ('collected', 'synthetic') or not isinstance(observed_at, datetime)
            or observed_at.utcoffset() is None):
        raise LawEvidenceHold('observation_unverified')
    if cutoff > observed_at.astimezone(SEOUL).date():
        raise LawEvidenceHold('notice_date_future')

    version = select_version(cutoff, fetch)
    articles = navigation_articles(confirm_body(version, fetch), cutoff)
    return {'contractVersion': 'law-reference/v1', 'dataOrigin': data_origin, 'asOf': as_of,
            'observedAt': observed_at.astimezone(timezone.utc).isoformat(),
            'title': TITLE, 'mst': version.mst, 'lawId': version.law_id,
            'promulgatedOn': version.promulgated_on.isoformat(), 'effectiveOn': version.effective_on.isoformat(),
            'articles': articles}


def live_transport(oc, *, opener=None):
    """probes.json의 두 공식 주소만 조회하며 응답은 메모리에서 확인한다."""
    endpoints = {'law_search': '/DRF/lawSearch.do', 'law_body': '/DRF/lawService.do'}
    client = opener if opener is not None else request.build_opener(NoRedirect)

    def fetch(probe, params):
        query = {**params, 'OC': oc, 'target': 'eflaw', 'type': 'JSON'}
        if probe == 'law_search':
            query.update(query=TITLE, display=PAGE_SIZE, nw='1,2,3')
        url = 'https://www.law.go.kr' + endpoints[probe] + '?' + parse.urlencode(query)
        try:
            with client.open(request.Request(url, headers={'Accept': 'application/json'}), timeout=15) as response:
                if response.status != 200:
                    raise LawEvidenceHold('law_source_unavailable')
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except error.HTTPError as exc:
            exc.close()
            raise LawEvidenceHold('law_source_unavailable') from None
        except (OSError, http.client.HTTPException):
            raise LawEvidenceHold('law_source_unavailable') from None
        if len(raw) > MAX_RESPONSE_BYTES:
            raise LawEvidenceHold('law_response_limit')
        try:
            return loads_source_json(raw.decode('utf-8-sig'))
        except (ValueError, RecursionError):
            raise LawEvidenceHold('law_response_unverified') from None

    return fetch


def publish_reference(client, reference):
    arguments = {'p_reference': reference}
    # 응답이 유실되면 같은 관측을 한 번만 재전송한다. RPC는 동일한 관측의 재전송을 허용한다.
    for attempt in (1, 2):
        try:
            acknowledgement = client.post('publish_law_reference', arguments, allow_no_content=True)
        except WorkerRpcResponseTooLarge:
            raise LawEvidenceHold('law_publish_response_invalid') from None
        except WorkerRpcError as exc:
            if exc.code == '42501' or exc.status in (401, 403):
                raise LawEvidenceHold('law_publish_forbidden') from None
            if exc.code in ('22023', 'PT422') or exc.status in (400, 422):
                raise LawEvidenceHold('law_publish_invalid_reference') from None
            if exc.code in ('PT409', '23505') or exc.status == 409:
                raise LawEvidenceHold('law_publish_conflict') from None
            if exc.status in (None, 502, 503, 504):
                if attempt == 1:
                    continue
                raise LawEvidenceHold('law_publish_unconfirmed') from None
            raise LawEvidenceHold('law_publish_failed') from None
        if acknowledgement is not None:
            raise LawEvidenceHold('law_publish_response_invalid')
        return


def held(reason):
    return {'status': 'held', 'reasonCodes': [reason], 'reference': None}


def collect_live_reference(as_of: str, *, publish: bool = False) -> dict:
    """실조회하거나 개발 DB에 게시하고, 보류 시 사유 코드만 돌려준다."""
    try:
        oc = read_keys().get('LAW_OC')
        if not oc:
            raise LawEvidenceHold('law_credentials_missing')
        client = WorkerRpc(os.environ) if publish else None
        reference = collect_law_reference(as_of, live_transport(oc), observed_at=datetime.now(timezone.utc),
                                          data_origin='collected')
        if any(redact_text(item['heading'], {'LAW_OC': oc}) != item['heading'] for item in reference['articles']):
            raise LawEvidenceHold('law_articles_unverified')
        if client is not None:
            publish_reference(client, reference)
    except LawEvidenceHold as exc:
        return held(exc.reason)
    except (OSError, ValueError):
        return held('law_config_unverified')
    return {'status': 'published' if publish else 'verified', 'reasonCodes': [], 'reference': reference}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--live', action='store_true', help='국가법령정보센터 실조회 (목록 5페이지와 본문 1회 이내)')
    parser.add_argument('--date', help='모집공고일 (YYYY-MM-DD)')
    parser.add_argument('--publish', action='store_true', help='검증한 실조회 결과를 개발 DB에 게시')
    args = parser.parse_args(argv)
    if args.publish and not args.live:
        parser.error('--publish에는 --live가 필요합니다.')
    if args.live and not args.date:
        parser.error('--live에는 --date가 필요합니다.')

    if args.live:
        result = collect_live_reference(args.date, publish=args.publish)
    else:
        try:
            fixture = loads_source_json(FIXTURE.read_text(encoding='utf-8'))
            replay = {'law_search': fixture['search'], 'law_body': fixture['body']}
            reference = collect_law_reference(args.date or fixture['asOf'], lambda probe, _params: replay[probe],
                                              observed_at=datetime.fromisoformat(fixture['observedAt']),
                                              data_origin='synthetic')
            result = {'status': 'verified', 'reasonCodes': [], 'reference': reference}
        except LawEvidenceHold as exc:
            result = held(exc.reason)
        except (OSError, ValueError):
            result = held('law_config_unverified')

    print(json.dumps(result, ensure_ascii=False))
    return 2 if result['status'] == 'held' else 0


if __name__ == '__main__':
    raise SystemExit(main())
