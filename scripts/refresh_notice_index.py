#!/usr/bin/env python3
"""개발 작업자가 청약홈 공고 목록과 공개 주택형을 갱신한다."""
import argparse
import hashlib
import http.client
import io
import json
import os
import re
import zipfile
import zlib
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from time import sleep
from urllib import error, request
from urllib.parse import urlencode

from build_notice_search_index import (
    CONTRACT_VERSION, MAX_INDEX_BYTES, MAX_NOTICES, NOTICE_SOURCES, PDF_SOURCE, SEOUL,
    build_notice_search_index, index_summary, json_size, read_region_codes_bytes,
)
from probe_apis import NoRedirect
from review_notice_documents import live_api_transport
from worker_rpc import WorkerRpc, WorkerRpcError

PUBLICATION_DAYS = 90  # 시작일과 종료일을 모두 포함한다.
PAGE_SIZE = 100
LIST_PAGE_LIMIT = 10  # 두 피드 각각
DETAIL_NOTICE_LIMIT = 40  # 접수 중 → 예정 → 일정 미확인, 종료 공고는 생략
DETAIL_PAGE_LIMIT = 2  # 공고 재대조와 주택형 조회 각각
REFRESH_TIME_LIMIT = timedelta(minutes=30)
REGION_INPUT_LIMIT = 4 * 1024 * 1024
REGION_DOWNLOAD_URL = 'https://www.code.go.kr/etc/codeFullDown.do'
REGION_REFERER = 'https://www.code.go.kr/stdcode/regCodeL.do'
RETRY_DELAYS = (2, 4, None)  # 최초 요청 포함 최대 3회
RPC = 'publish_notice_directory'


def transient_http(status):
    return isinstance(status, int) and (status in (408, 429) or 500 <= status < 600)


def download_region_zip():
    """행정표준코드관리시스템의 법정동 전체자료 다운로드 폼을 사용한다."""
    opener = request.build_opener(request.ProxyHandler({}), NoRedirect())
    call = request.Request(REGION_DOWNLOAD_URL, data=urlencode({'codeseId': '법정동코드'}).encode('ascii'),
                           headers={'Content-Type': 'application/x-www-form-urlencoded', 'Referer': REGION_REFERER},
                           method='POST')
    for delay in RETRY_DELAYS:
        try:
            with opener.open(call, timeout=25) as response:
                if response.status != 200:
                    raise ValueError('지역코드 파일의 전체 응답이 필요합니다.')
                return response.read(REGION_INPUT_LIMIT + 1)
        except (OSError, http.client.HTTPException) as exc:
            if isinstance(exc, error.HTTPError):
                exc.close()
                if not transient_http(exc.code):
                    raise
            if delay is None:
                raise
            sleep(delay)


def load_regions(path=None, digest=None):
    """공식 최신 ZIP 또는 작업자가 현행본과 대조한 TXT·ZIP의 코드를 읽는다."""
    if path is None:
        data = download_region_zip()
    else:
        if not re.fullmatch(r'[0-9a-fA-F]{64}', digest or ''):
            raise ValueError('지역코드 파일의 SHA-256 지문이 필요합니다.')
        with path.open('rb') as source:
            data = source.read(REGION_INPUT_LIMIT + 1)
        if hashlib.sha256(data).hexdigest() != digest.lower():
            raise ValueError('지역코드 파일의 SHA-256 지문이 일치하지 않습니다.')
    if not 0 < len(data) <= REGION_INPUT_LIMIT:
        raise ValueError('지역코드 파일의 크기가 허용 범위를 벗어났습니다.')
    archive_bytes = io.BytesIO(data)
    if path is None or zipfile.is_zipfile(archive_bytes):
        with zipfile.ZipFile(archive_bytes) as archive:
            files = [item for item in archive.infolist() if not item.is_dir()]
            if (len(files) != 1 or not files[0].filename.lower().endswith('.txt')
                    or files[0].file_size > REGION_INPUT_LIMIT):
                raise ValueError('지역코드 ZIP에 전체자료 TXT 한 개가 필요합니다.')
            with archive.open(files[0]) as member:
                data = member.read(REGION_INPUT_LIMIT + 1)
    if len(data) > REGION_INPUT_LIMIT:
        raise ValueError('압축 해제한 지역코드 파일이 상한을 넘었습니다.')
    return read_region_codes_bytes(data)


def retrying_transport(fetch, attempts):
    def get_page(source, scope, page, size):
        for delay in RETRY_DELAYS:
            attempts[source] += 1
            try:
                response = fetch(source, scope, page, size)
            except (OSError, http.client.HTTPException):
                response = {'source': source, 'scope': scope, 'page': page, 'pageSize': size, 'httpStatus': None,
                            'transportError': 'connection', 'observedAt': None, 'body': None}
            if (delay is None or not isinstance(response, dict)
                    or not (transient_http(response.get('httpStatus'))
                            or response.get('transportError') in ('connection', 'timeout'))):
                return response
            sleep(delay)

    return get_page


def publish_directory(index, names, client, report):
    if (index.get('contractVersion') != CONTRACT_VERSION or index.get('dataOrigin') != 'collected'
            or index['coverage']['status'] != 'complete'):
        raise ValueError('두 공식 목록을 모두 확인한 실수집 색인만 게시할 수 있습니다.')
    if not names or sorted(names) != index['regionCodes']:
        raise ValueError('지역코드와 공식 지역명 목록이 일치해야 합니다.')
    report['indexBytes'] = json_size(index)
    if report['indexBytes'] > MAX_INDEX_BYTES:
        report['reason'] = 'index_size_limit_reached'
        raise ValueError('공고 목록 색인이 게시 크기 상한을 넘었습니다.')
    if any(PDF_SOURCE in notice['sourceIds'] or any(model['rooms'] or model['areaEvidence']
           or model['supplyAreaM2'] is not None for model in notice['models']) for notice in index['notices']):
        raise ValueError('공고 목록에는 공개 주택형 식별 정보만 게시할 수 있습니다.')

    # 목록 전용 RPC로만 게시해 맞춤 검색의 호실·가격·공식 원문 근거를 보존한다.
    arguments = {'p_index': index, 'p_regions': names}
    for attempt, delay in enumerate(RETRY_DELAYS, 1):
        report['publicationAttempts'] = attempt
        try:
            if client.post(RPC, arguments, allow_no_content=True) is not None:
                raise WorkerRpcError()
        except WorkerRpcError as exc:
            if exc.status is None or exc.status == 408 or 500 <= exc.status < 600:
                report['publicationUnconfirmed'] = True
            if delay is None or not (exc.status is None or transient_http(exc.status)):
                raise
            # 응답을 잃었을 수 있으므로 같은 관측 시각과 동일한 본문으로만 재시도한다.
            sleep(delay)
        else:
            report.pop('publicationUnconfirmed', None)
            return


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--live', action='store_true', required=True, help='두 청약홈 목록과 주택형 API 실조회')
    parser.add_argument('--publish', action='store_true', required=True, help='실수집한 목록을 개발 DB에 게시')
    parser.add_argument('--region-codes', type=Path, help='현행 공식 법정동 전체자료로 확인한 로컬 TXT 또는 ZIP')
    parser.add_argument('--region-codes-sha256', help='로컬 전체자료 파일의 SHA-256 지문')
    args = parser.parse_args(argv)
    if (args.region_codes is None) != (args.region_codes_sha256 is None):
        parser.error('--region-codes와 --region-codes-sha256를 함께 사용하세요.')
    observed_at = datetime.now(timezone.utc)
    today = observed_at.astimezone(SEOUL).date()
    start, end = (today - timedelta(days=PUBLICATION_DAYS - 1)).isoformat(), today.isoformat()
    max_api_pages = len(NOTICE_SOURCES) * LIST_PAGE_LIMIT + 2 * DETAIL_NOTICE_LIMIT * DETAIL_PAGE_LIMIT
    report = {
        'stage': 'worker_configuration', 'observedAt': observed_at.isoformat(),
        'publicationWindow': {'start': start, 'end': end}, 'listDiagnostics': {}, 'apiAttempts': Counter(),
        'budget': {'publicationDays': PUBLICATION_DAYS, 'rowsPerPage': PAGE_SIZE, 'listPagesPerFeed': LIST_PAGE_LIMIT,
                   'notices': MAX_NOTICES, 'detailNotices': DETAIL_NOTICE_LIMIT, 'pagesPerDetailRequest': DETAIL_PAGE_LIMIT,
                   'attemptsPerRequest': len(RETRY_DELAYS), 'maxApplyhomeAttempts': max_api_pages * len(RETRY_DELAYS),
                   'pdfGets': 0},
    }
    try:
        client = WorkerRpc(os.environ)
        report['stage'] = 'api_configuration'
        fetch = retrying_transport(live_api_transport(), report['apiAttempts'])
        report['stage'] = 'region_input'
        regions = load_regions(args.region_codes, args.region_codes_sha256)
        names = regions.names()
        report['stage'] = 'collect'
        index = build_notice_search_index(
            start, end, regions, fetch, data_origin='collected', observed_at=report['observedAt'],
            page_size=PAGE_SIZE, max_pages=LIST_PAGE_LIMIT, max_detail_notices=DETAIL_NOTICE_LIMIT,
            max_detail_pages=DETAIL_PAGE_LIMIT, max_document_requests=0, detail_active_only=True,
            details_require_complete_lists=True, model_diagnostics=True, list_diagnostics=report['listDiagnostics'],
        )
        report.update(index_summary(index, published=False))
        report['reasonCounts'] = Counter(reason for notice in index['notices'] for reason in notice['reasonCodes'])
        completed_at = datetime.now(timezone.utc)
        if index['coverage']['status'] != 'complete':
            report.update(status='kept_previous', reason='list_collection_incomplete')
        elif completed_at.astimezone(SEOUL).date() != today or completed_at - observed_at >= REFRESH_TIME_LIMIT:
            report.update(status='kept_previous', reason='observation_expired')
        else:
            report['stage'] = 'publish_directory'
            publish_directory(index, names, client, report)
            report['status'] = 'published'
    except WorkerRpcError as exc:
        report.update(status='publication_unconfirmed' if report.get('publicationUnconfirmed') else 'kept_previous',
                      rpcHttpStatus=exc.status, rpcCode=exc.code)
    except (OSError, TypeError, ValueError, RuntimeError, http.client.HTTPException, zipfile.BadZipFile, EOFError, zlib.error):
        # 인증값·URL·자료 원문·공고 식별자는 예외 문장에서 읽거나 출력하지 않는다.
        report['status'] = 'refused' if report['stage'] == 'worker_configuration' else 'kept_previous'
    print(json.dumps(report, ensure_ascii=False, allow_nan=False))
    return 0 if report['status'] == 'published' else 2


if __name__ == '__main__':
    raise SystemExit(main())
