"""큐에서 고른 공고·회차·주택형 하나를 BE-02·BE-06 경로로 수집해 작업자가 원자 저장할 캡처와 비교 결과를 만든다.

외부 전송(청약홈·실거래 API, 공식 PDF)·단조 시계·대기는 NoticeTransports로 주입한다. 이 모듈은 기본 전송을
스스로 만들지 않는다. 수동 실조회에서는 공고의 고정 입력을 검증한 뒤에만 키를 읽는다.

순서: 큐 선택·고정 조건 확인 → 공고·주택형 수집과 선택 입증 → 허용 시 공식 PDF 점검 → 실거래 수집 → 비교.
선택을 입증하지 못하거나 공고 조회가 실패하면 비싼 실거래 조회 없이 NoticeRunFailure로 종결 사유를 돌려준다.
외부 호출 직전마다 작업 시간·호출 예산과 임대를 확인한다.
"""
import copy
import re
import time
from dataclasses import dataclass
from datetime import date
from http.client import HTTPException
from typing import Callable, Optional

from compare_trades import compare_snapshot
from ingestion_notices import NOTICE_SOURCES
from ingestion_pages import request_unit
from ingestion_trades import SOURCE_KINDS, TRADE_KINDS, trade_period
from replay_ingestion import collect_notice_catalog, ingest
from store_ingestion import payment_schedule_snapshot, snapshot_input
from worker_rpc import WorkerRpcError


SELECTION_KEYS = frozenset(('kind', 'noticeSource', 'houseManageNo', 'noticeNo', 'edition', 'modelNo'))
CAPTURE_KEYS = frozenset(('asOf', 'requestRegionCodes', 'allowOfficialPdf'))
PAGE_SIZE = 100
MAX_ATTEMPTS = 3  # DB claim_analysis_run의 최대 인수 횟수와 같다.
# 한 번 더 조회하면 해소될 수 있는 상류 장애. 인증 거절·업무 오류·형식 오류는 재시도하지 않는다.
TRANSIENT_ERRORS = frozenset(('upstream_timeout', 'upstream_unavailable'))
# 개발 실행 한도. PDF 상한은 상세 1쪽과 첨부 5개의 리디렉션 3회까지를 포함한다.
LIMITS = {'deadlineSeconds': 900, 'apiRequests': 400, 'pdfRequests': 24, 'requestIntervalSeconds': 0.2,
          'leaseSeconds': 120}
EDITION = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')
MODEL_NO = re.compile(r'[0-9]{1,20}')
NOTICE_NO = re.compile(r'[0-9]{10}')
LAWD = re.compile(r'[0-9]{5}')


class NoticeRunFailure(Exception):
    """사용자에게 남길 종결·재시도 사유. 원문·주소·인증값은 담지 않는다."""

    def __init__(self, code, retryable=False):
        super().__init__(code)
        self.code, self.retryable = code, retryable


class NoticeWorkerConfigurationError(RuntimeError):
    """실조회 전송을 준비하지 못하면 현재 임대를 남기고 작업자를 중단한다."""


class CaptureStopped(BaseException):
    """임대 상실·갱신 응답 불명·작업 상한으로 수집을 멈춘다.

    청약홈 PDF 수집기는 주입 전송의 Exception을 형식 오류로 바꿔 계속 진행한다. 중단 신호가 그 처리에
    흡수되지 않도록 BaseException을 쓴다.
    """

    def __init__(self, rpc_error=None):
        super().__init__()
        self.rpc_error = rpc_error


@dataclass(frozen=True)
class NoticeTransports:
    api: Callable  # fetch(source, scope, page, page_size) -> ingestion_pages 응답 봉투
    pdf: Callable  # fetch(url, *, max_bytes, timeout) -> notice_pdf_acquisition 전송 응답
    clock: Callable = time.monotonic
    sleep: Callable = time.sleep
    inspect: Optional[Callable] = None  # 검사용 PDF 판독기. None이면 inspect_notice_pdf
    limits: Optional[dict] = None  # LIMITS 일부를 덮어쓴다


class CaptureGuard:
    """외부 호출과 저장 직전에 시간 예산과 현재 임대를 확인한다."""

    def __init__(self, renew, *, lease_seconds, clock, sleep, limits):
        self._renew, self._clock, self._sleep, self.limits = renew, clock, sleep, limits
        # 실조회 한 건(최대 25초)이 끝나기 전에 임대가 만료되지 않도록 공고 수집은 더 긴 임대로 갱신한다.
        self.lease_seconds = min(300, max(lease_seconds, limits['leaseSeconds']))
        self._deadline = clock() + limits['deadlineSeconds']
        self.requests = {'api': 0, 'pdf': 0}
        self._last = None

    def remaining(self):
        remaining = self._deadline - self._clock()
        if remaining <= 0:
            raise CaptureStopped()
        return remaining

    def confirm_lease(self):
        self.remaining()
        try:
            self._renew(self.lease_seconds)
        except WorkerRpcError as exc:
            raise CaptureStopped(exc) from None
        return self.remaining()

    def _request(self, channel):
        remaining = self.remaining()
        if self.requests[channel] >= self.limits[channel + 'Requests']:
            raise CaptureStopped()
        if self._last is not None:
            wait = self.limits['requestIntervalSeconds'] - (self._clock() - self._last)
            if wait >= remaining:
                raise CaptureStopped()
            if wait > 0:
                self._sleep(wait)
        remaining = self.confirm_lease()
        self.requests[channel] += 1
        self._last = self._clock()
        return remaining

    def api(self, transport):
        def fetch(source, scope, page, page_size):
            self._request('api')
            envelope = transport(source, scope, page, page_size)
            status = envelope.get('httpStatus') if isinstance(envelope, dict) else None
            # 권한 또는 호출 한도를 명시적으로 거절한 기관에 다음 쪽·월을 요청하지 않는다.
            if status in (401, 403):
                raise NoticeRunFailure('notice_source_restricted')
            if status == 429:
                raise NoticeRunFailure('notice_feed_unavailable', True)
            return envelope
        return _with_supplied_pages(fetch, transport)

    def pdf(self, transport):
        def fetch(url, *, max_bytes, timeout):
            remaining = self._request('pdf')
            return transport(url, max_bytes=max_bytes, timeout=min(timeout, remaining))
        return fetch


def _with_supplied_pages(fetch, transport):
    # 재생 전송의 계획 밖 쪽 검사를 감싼 전송에서도 유지한다.
    supplied = getattr(transport, 'supplied_pages', None)
    if callable(supplied):
        fetch.supplied_pages = supplied
    return fetch


def _matches(value, pattern):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def notice_plan(selection, work):
    """큐 선택과 DB가 고정한 조건·수집 범위를 대조한다."""
    if (not isinstance(selection, dict) or set(selection) != SELECTION_KEYS or selection['kind'] != 'notice'
            or selection['noticeSource'] not in NOTICE_SOURCES
            or not _matches(selection['edition'], EDITION) or not _matches(selection['modelNo'], MODEL_NO)
            or not all(_matches(selection[key], NOTICE_NO) for key in ('houseManageNo', 'noticeNo'))):
        raise NoticeRunFailure('notice_selection_unverified')
    date.fromisoformat(selection['edition'])
    capture, conditions = work['noticeCapture'], work['conditions']
    regions = capture.get('requestRegionCodes') if isinstance(capture, dict) else None
    if (not isinstance(capture, dict) or set(capture) != CAPTURE_KEYS
            or type(capture['allowOfficialPdf']) is not bool or not isinstance(regions, list)
            or len(regions) != 1 or not _matches(regions[0], LAWD)):
        raise NoticeRunFailure('notice_selection_unverified')
    trade_period(capture['asOf'])  # 잘못된 기준일은 외부 요청 전 거부한다.
    evidence = work['evidence']
    if (not isinstance(conditions, dict) or work['useSyntheticFixture'] is not False or work['ingestion'] is not None
            or (evidence is not None and not isinstance(evidence, dict))):
        raise NoticeRunFailure('notice_selection_unverified')
    source = selection['noticeSource']
    target = {key: selection[key] for key in ('houseManageNo', 'noticeNo', 'edition')}
    comparison = conditions.get('comparison')
    housing_type = conditions.get('housingType')
    declared_models = [conditions.get('modelNo', selection['modelNo'])]
    if isinstance(housing_type, dict) and 'modelNo' in housing_type:
        declared_models.append(housing_type['modelNo'])
    if (work['selectionBindingIssue'] is not None or conditions.get('ingestion_target') != dict(target, noticeSource=source)
            or not isinstance(comparison, dict) or comparison.get('modelNo') != selection['modelNo']
            or any(model_no != selection['modelNo'] for model_no in declared_models)):
        raise NoticeRunFailure('notice_selection_unverified')
    request = {'noticeSource': source, 'target': target,
               'asOf': capture['asOf'], 'requestRegionCodes': list(regions), 'tradeKinds': list(TRADE_KINDS),
               'pageSize': PAGE_SIZE}
    return {'request': request, 'modelNo': selection['modelNo'], 'allowOfficialPdf': capture['allowOfficialPdf'],
            'comparison': comparison, 'evidence': evidence}


def _matches_catalog(catalog, edition, model_no):
    # 진행 목록의 edition은 원천에서 확인한 모집공고일이다. 번호쌍이 같아도 날짜가 다르면 같은 회차가 아니다.
    notice = catalog['notice']
    publication = (notice['fields'] or {}).get('RCRIT_PBLANC_DE', {})
    if (any(collection['status'] != 'complete' for collection in catalog['collections'].values())
            or notice['status'] != 'reported' or publication.get('status') != 'reported'
            or publication.get('value') != edition
            or catalog['housingTypesStatus'] != 'reported'):
        return False
    models = [model for model in catalog['housingTypes'] if model['modelNo'] == model_no]
    return (len(models) == 1 and models[0]['status'] == 'linked'
            and models[0]['houseType']['status'] == 'reported' and bool(models[0]['evidence']))


def _retryable_gap(record):
    error = record.get('error')
    return error is None or (isinstance(error, dict) and error.get('code') in TRANSIENT_ERRORS)


def _gaps(records):
    return [record for record in records if record.get('status') not in ('complete', 'empty')]


def capture_notice(plan, transports, guard, generation):
    """선택 공고의 고정 요청, 수집본과 같은 판본에서 점검한 납부 일정을 돌려준다."""
    request, model_no = plan['request'], plan['modelNo']
    api = guard.api(transports.api)
    recorded = {}

    def catalog_fetch(source, scope, page, page_size):
        envelope = api(source, scope, page, page_size)
        recorded[request_unit(source, scope, page, page_size)] = copy.deepcopy(envelope)
        return envelope

    catalog, collections, _ = collect_notice_catalog(
        request['noticeSource'], request['target'], _with_supplied_pages(catalog_fetch, transports.api),
        page_size=request['pageSize'])
    guard.remaining()
    gaps = _gaps(collections)
    if gaps:
        raise NoticeRunFailure('notice_feed_unavailable', all(_retryable_gap(record) for record in gaps))
    if not _matches_catalog(catalog, request['target']['edition'], model_no):
        raise NoticeRunFailure('notice_selection_unverified')

    review = None
    schedules = None
    if plan['allowOfficialPdf']:
        from notice_document_review import review_catalog_documents
        pdf = guard.pdf(transports.pdf)
        options = {} if transports.inspect is None else {'inspect': transports.inspect}

        def review(target, current):
            nonlocal schedules
            checked = review_catalog_documents(target, current, fetch=pdf, monotonic=transports.clock, **options)
            schedules = payment_schedule_snapshot(checked['review']['paymentSchedules'])
            return checked

    def capture_fetch(source, scope, page, page_size):
        # 같은 BE-02 수집 함수를 다시 거치되 공고·주택형은 위에서 받은 응답만 재사용한다.
        unit = request_unit(source, scope, page, page_size)
        if unit in recorded:
            return recorded.pop(unit)
        if source not in SOURCE_KINDS:
            raise ValueError('확인한 공고 범위 밖의 조회입니다.')
        return api(source, scope, page, page_size)

    capture = ingest(request, _with_supplied_pages(capture_fetch, transports.api), data_origin='collected',
                     review_documents=review)
    if recorded or capture['catalogCollections'] != collections:
        raise ValueError('공고 확인 결과와 수집본이 일치하지 않습니다.')
    guard.remaining()
    gaps = _gaps(batch['record'] for batch in capture['tradeBatches'])
    if gaps and generation < MAX_ATTEMPTS and all(
            record['status'] == 'failed' and _retryable_gap(record) for record in gaps):
        # 첫 쪽부터 실패한 일시 장애는 재시도한다. 쪽을 일부 받았다면 확보한 행과 누락 범위를 저장한다.
        raise NoticeRunFailure('notice_feed_unavailable', True)
    return snapshot_input(request), capture, schedules


def prepare_notice_comparison(selection, work, *, generation, transports, renew, lease_seconds):
    """read_comparison_work 응답으로 공고 캡처와 comparison/v1을 만든다. renew(seconds)는 임대 갱신 RPC다."""
    try:
        plan = notice_plan(selection, work)
    except (KeyError, TypeError, ValueError):
        raise NoticeRunFailure('notice_selection_unverified') from None
    if callable(transports):
        transports = transports()
    if not isinstance(transports, NoticeTransports):
        raise NoticeWorkerConfigurationError('공고 수집 전송을 확인할 수 없습니다.')
    limits = dict(LIMITS, **(transports.limits or {}))
    guard = CaptureGuard(renew, lease_seconds=lease_seconds, clock=transports.clock, sleep=transports.sleep,
                         limits=limits)
    try:
        inputs, capture, schedules = capture_notice(plan, transports, guard, generation)
        comparison = compare_snapshot(capture, plan['comparison'], plan['evidence'])
    except (AttributeError, HTTPException, KeyError, OSError, RuntimeError, TypeError, ValueError):
        raise NoticeRunFailure('notice_feed_unavailable') from None
    guard.confirm_lease()
    return inputs, capture, comparison, schedules


def live_notice_transports():
    """선택된 공고의 공공데이터 전송을 만들고, 공식 문서 전송은 첫 허용 요청까지 미룬다."""
    from review_notice_documents import live_api_transport
    try:
        api = live_api_transport()
    except ValueError as exc:
        raise NoticeWorkerConfigurationError(str(exc)) from None
    except (KeyError, OSError):
        raise NoticeWorkerConfigurationError('공고·거래 API 명세를 작업자에서 읽을 수 없습니다.') from None
    pdf = None

    def fetch_pdf(url, *, max_bytes, timeout):
        nonlocal pdf
        if pdf is None:
            from notice_pdf_acquisition import make_live_fetch
            pdf = make_live_fetch()
        return pdf(url, max_bytes=max_bytes, timeout=timeout)

    return NoticeTransports(api=api, pdf=fetch_pdf)
