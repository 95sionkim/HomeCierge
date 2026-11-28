"""큐에서 고른 공고·회차·주택형 하나를 BE-02·BE-06 경로로 수집해 작업자가 원자 저장할 캡처와 비교 결과를 만든다.

외부 전송(청약홈·실거래 API, 공식 PDF)·단조 시계·대기는 NoticeTransports로 주입한다. 이 모듈은 기본 전송을
스스로 만들지 않는다. 수동 실조회에서는 공고의 고정 입력을 검증한 뒤에만 키를 읽는다.

순서: 큐 선택·고정 조건 확인 → 공고·주택형 수집과 선택 입증 → 허용 시 공식 PDF 점검 → 실거래 수집 → 비교.
선택을 입증하지 못하거나 공고 조회가 실패하면 비싼 실거래 조회 없이 NoticeRunFailure로 종결 사유를 돌려준다.
외부 호출 직전마다 작업 시간·호출 예산과 임대를 확인한다.
"""
import copy
import hashlib
import os
import re
import time
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import InvalidOperation
from http.client import HTTPException
from typing import Callable, Optional
from urllib import error as urllib_error, parse as urllib_parse, request as urllib_request
from uuid import UUID

from compare_trades import _checked_target_area, _documents, _selected_model, compare_snapshot
from complex_coordinates import KakaoCoordinateBudgetExceeded, live_kakao_transport
from complex_evidence import (
    DEFAULT_APPLYHOME_REQUEST_LIMIT,
    EvidenceBudgetExceeded,
    LegalRegionCatalog,
    build_comparison_evidence,
    prefetch_cache_keys,
)
from ingestion_notices import NOTICE_SOURCES
from ingestion_pages import request_unit
from ingestion_trades import SOURCE_KINDS, TRADE_KINDS, trade_period
from replay_ingestion import collect_notice_catalog, ingest
from store_ingestion import payment_schedule_snapshot, snapshot_input
from worker_rpc import WorkerRpcError, WorkerRpcResponseTooLarge


SELECTION_KEYS = frozenset(('kind', 'noticeSource', 'houseManageNo', 'noticeNo', 'edition', 'modelNo'))
UPLOAD_SUPPLEMENT_SELECTION_KEYS = frozenset((
    'kind', 'baseRunId', 'uploadId', 'noticeSource', 'houseManageNo', 'noticeNo', 'edition', 'modelNo',
))
CAPTURE_KEYS = frozenset(('asOf', 'requestRegionCodes', 'allowOfficialPdf'))
MAX_UPLOAD_SUPPLEMENT_WORK_BYTES = 32 * 1024 * 1024
UPLOAD_BUCKET = 'analysis-uploads'
UPLOAD_OBJECT_PATH = re.compile(
    r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf'
)
PAGE_SIZE = 100
MAX_ATTEMPTS = 3  # DB claim_analysis_run의 최대 인수 횟수와 같다.
# 한 번 더 조회하면 해소될 수 있는 상류 장애. 인증 거절·업무 오류·형식 오류는 재시도하지 않는다.
TRANSIENT_ERRORS = frozenset(('upstream_timeout', 'upstream_unavailable'))
# 개발 실행 한도. PDF 상한은 상세 1쪽과 첨부 5개의 리디렉션 3회까지를 포함한다.
LIMITS = {'deadlineSeconds': 900, 'apiRequests': 400, 'pdfRequests': 24,
          'evidenceApplyhomeRequests': DEFAULT_APPLYHOME_REQUEST_LIMIT, 'evidenceKakaoRequests': 30,
          'requestIntervalSeconds': 0.2, 'leaseSeconds': 120}
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
    upload: Optional[Callable] = None  # read(upload_id, object_path) -> {'id': upload_id, 'content': bytes} | None
    regions: Optional[Callable] = None  # load(sgg_code) -> LegalRegionCatalog | None
    kakao: Optional[Callable] = None  # fetch(query) -> 카카오 로컬 응답 봉투 (키 없으면 None)


class CaptureGuard:
    """외부 호출과 저장 직전에 시간 예산과 현재 임대를 확인한다."""

    def __init__(self, renew, *, lease_seconds, clock, sleep, limits):
        self._renew, self._clock, self._sleep, self.limits = renew, clock, sleep, limits
        # 실조회 한 건(최대 25초)이 끝나기 전에 임대가 만료되지 않도록 공고 수집은 더 긴 임대로 갱신한다.
        self.lease_seconds = min(300, max(lease_seconds, limits['leaseSeconds']))
        self._deadline = clock() + limits['deadlineSeconds']
        self.requests = {'api': 0, 'pdf': 0, 'evidenceApplyhome': 0, 'evidenceKakao': 0}
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

    def _evidence_request(self, channel, budget_error_cls):
        remaining = self.remaining()
        if self.requests[channel] >= self.limits[channel + 'Requests']:
            raise budget_error_cls()
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

    def evidence_api(self, transport):
        """비교 근거 자동 조회용 청약홈 전송. 상한 도달 시 실행을 중단하지 않고 미확인 단지를 보류한다."""
        def fetch(source, scope, page, page_size):
            self._evidence_request('evidenceApplyhome', EvidenceBudgetExceeded)
            return transport(source, scope, page, page_size)
        return _with_supplied_pages(fetch, transport)

    def kakao(self, transport):
        """단지 대표 좌표용 카카오 로컬 전송. 키 누락(None)과 상한 도달은 좌표 미확인으로 처리한다."""
        if transport is None:
            return None

        def fetch(query):
            self._evidence_request('evidenceKakao', KakaoCoordinateBudgetExceeded)
            return transport(query)
        return fetch

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
    official_revisions = work.get('officialRevisions', [])
    if not isinstance(official_revisions, list):
        raise NoticeRunFailure('notice_selection_unverified')
    request = {'noticeSource': source, 'target': target,
               'asOf': capture['asOf'], 'requestRegionCodes': list(regions), 'tradeKinds': list(TRADE_KINDS),
               'pageSize': PAGE_SIZE}
    return {'request': request, 'modelNo': selection['modelNo'], 'allowOfficialPdf': capture['allowOfficialPdf'],
            'comparison': comparison, 'evidence': evidence, 'officialRevisions': list(official_revisions)}


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


def _canonical_uuid(value):
    if not isinstance(value, str):
        raise ValueError('UUID 문자열이 필요합니다.')
    parsed = str(UUID(value))
    if parsed != value.lower():
        raise ValueError('정규 UUID 형식이 아닙니다.')
    return parsed


def upload_supplement_plan(selection, work):
    """업로드 보완 큐 선택과 DB가 고정한 업로드·조건·공식 해시 색인을 대조한다."""
    if (not isinstance(selection, dict) or set(selection) != UPLOAD_SUPPLEMENT_SELECTION_KEYS
            or selection['kind'] != 'upload_supplement'
            or selection['noticeSource'] not in NOTICE_SOURCES
            or not _matches(selection['edition'], EDITION) or not _matches(selection['modelNo'], MODEL_NO)
            or not all(_matches(selection[key], NOTICE_NO) for key in ('houseManageNo', 'noticeNo'))):
        raise NoticeRunFailure('notice_selection_unverified')
    base_run_id = _canonical_uuid(selection['baseRunId'])
    upload_id = _canonical_uuid(selection['uploadId'])
    date.fromisoformat(selection['edition'])
    if not isinstance(work, dict):
        raise NoticeRunFailure('notice_selection_unverified')
    capture, conditions = work.get('noticeCapture'), work.get('conditions')
    upload = work.get('upload')
    official_index = work.get('officialIndex')
    regions = capture.get('requestRegionCodes') if isinstance(capture, dict) else None
    if (not isinstance(capture, dict) or set(capture) != CAPTURE_KEYS
            or type(capture['allowOfficialPdf']) is not bool or not isinstance(regions, list)
            or len(regions) != 1 or not _matches(regions[0], LAWD)):
        raise NoticeRunFailure('notice_selection_unverified')
    if (not isinstance(upload, dict) or set(upload) != {'uploadId', 'objectPath'}
            or upload.get('uploadId') != upload_id
            or not _matches(upload.get('objectPath'), UPLOAD_OBJECT_PATH)
            or not upload['objectPath'].endswith('/' + upload_id + '.pdf')):
        raise NoticeRunFailure('upload_unavailable')
    if not isinstance(official_index, list):
        raise NoticeRunFailure('notice_selection_unverified')
    trade_period(capture['asOf'])
    evidence = work.get('evidence')
    if (not isinstance(conditions, dict) or work.get('useSyntheticFixture') is not False
            or (evidence is not None and not isinstance(evidence, dict))):
        raise NoticeRunFailure('notice_selection_unverified')
    source = selection['noticeSource']
    target = {key: selection[key] for key in ('houseManageNo', 'noticeNo', 'edition')}
    comparison = conditions.get('comparison')
    housing_type = conditions.get('housingType')
    declared_models = [conditions.get('modelNo', selection['modelNo'])]
    if isinstance(housing_type, dict) and 'modelNo' in housing_type:
        declared_models.append(housing_type['modelNo'])
    if (work.get('selectionBindingIssue') is not None
            or conditions.get('ingestion_target') != dict(target, noticeSource=source)
            or not isinstance(comparison, dict) or comparison.get('modelNo') != selection['modelNo']
            or any(model_no != selection['modelNo'] for model_no in declared_models)):
        raise NoticeRunFailure('notice_selection_unverified')
    official_revisions = work.get('officialRevisions', [])
    if not isinstance(official_revisions, list):
        raise NoticeRunFailure('notice_selection_unverified')
    request = {'noticeSource': source, 'target': target,
               'asOf': capture['asOf'], 'requestRegionCodes': list(regions), 'tradeKinds': list(TRADE_KINDS),
               'pageSize': PAGE_SIZE}
    return {
        'request': request, 'modelNo': selection['modelNo'], 'allowOfficialPdf': capture['allowOfficialPdf'],
        'comparison': comparison, 'evidence': evidence, 'baseRunId': base_run_id,
        'upload': {'uploadId': upload_id, 'objectPath': upload['objectPath']},
        'officialIndex': list(official_index),
        'officialRevisions': list(official_revisions),
    }


def _detail_only_pdf_transport(transport):
    """공식 PDF 저장 권한이 없을 때 상세 페이지 첨부 목록만 확인하고 공식 첨부 바이트는 내려받지 않는다."""
    def fetch(url, *, max_bytes, timeout):
        parsed = urllib_parse.urlsplit(url)
        if parsed.path.lower().endswith('/getatchmnfl.do'):
            return {'status': 403, 'headers': {}, 'body': b''}
        return transport(url, max_bytes=max_bytes, timeout=timeout)
    return fetch


def capture_notice(plan, transports, guard, generation, *, official_index=(), read_upload=None):
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
    if plan['allowOfficialPdf'] or read_upload is not None:
        from notice_document_review import review_catalog_documents
        pdf_source = transports.pdf if plan['allowOfficialPdf'] else _detail_only_pdf_transport(transports.pdf)
        pdf = guard.pdf(pdf_source)
        options = {} if transports.inspect is None else {'inspect': transports.inspect}
        prior_revisions = plan.get('officialRevisions') or ()

        def review(target, current):
            nonlocal schedules
            checked = review_catalog_documents(
                target, current, official_index=official_index, prior_revisions=prior_revisions,
                read_upload=read_upload, fetch=pdf, monotonic=transports.clock, **options,
            )
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


def has_confirmed_target_area(capture, selection):
    """비교 엔진과 같은 기준으로 대상 주택형의 공급면적이 문서 대조까지 확정되었는지 판정한다."""
    if not isinstance(capture, dict) or capture.get('dataOrigin') != 'collected':
        return False
    period = capture.get('period')
    if not isinstance(period, dict) or period.get('status') != 'confirmed':
        return False
    catalog = capture.get('catalog')
    target = capture.get('target')
    if not isinstance(catalog, dict) or not isinstance(target, dict):
        return False
    model, _ = _selected_model(catalog, selection if isinstance(selection, dict) else {})
    if model is None:
        return False
    documents = _documents(catalog, target)
    _, area = _checked_target_area(model, documents)
    return area is not None


def build_capture_auto_evidence(
    capture, plan, transports, guard,
    *, read_permissions=None, read_cache=None, upsert_cache=None,
):
    """거래 수집 뒤 comparison-evidence/v1 근거를 자동으로 구성하고 공유 캐시를 갱신한다.

    기존 근거가 이미 있거나 대상 공급면적이 미확정이거나 지역 로더가 없으면 외부 조회 없이 (plan['evidence'], None)을 돌려준다.
    """
    if plan['evidence'] is not None:
        return plan['evidence'], None
    if transports.regions is None or not has_confirmed_target_area(capture, plan['comparison']):
        return None, None

    guard.confirm_lease()
    if read_permissions is not None:
        try:
            perms = read_permissions()
        except WorkerRpcError as exc:
            raise CaptureStopped(exc) from None
        if not isinstance(perms, dict):
            return None, None
    else:
        perms = {
            'applyhomeApt': True,
            'applyhomeRemainder': True,
            'moisRegions': True,
            'kakaoRuntime': True,
            'kakaoStorage': False,
        }
    if not perms.get('moisRegions'):
        return None, None

    req_regions = capture.get('requestRegionCodes') or []
    if len(req_regions) != 1:
        return None, None
    sgg_code = req_regions[0]
    cache_keys = prefetch_cache_keys(capture)

    cached_region = None
    applyhome_cache = {}
    kakao_cache = {}
    if read_cache is not None:
        guard.confirm_lease()
        try:
            cache_reply = read_cache(sgg_code, cache_keys)
        except WorkerRpcError as exc:
            raise CaptureStopped(exc) from None
        if isinstance(cache_reply, dict):
            cached_region = cache_reply.get('region')
            if isinstance(cache_reply.get('applyhome'), dict):
                applyhome_cache = cache_reply['applyhome']
            if perms.get('kakaoStorage') and isinstance(cache_reply.get('kakao'), dict):
                kakao_cache = cache_reply['kakao']

    region_catalog = None
    region_calls = 0
    region_cache_hits = 0
    new_region_record = None
    if isinstance(cached_region, dict):
        try:
            region_catalog = LegalRegionCatalog.from_cache_record(cached_region)
            region_cache_hits = 1
        except (KeyError, TypeError, ValueError):
            region_catalog = None
    if region_catalog is None:
        guard.confirm_lease()
        try:
            region_catalog = transports.regions(sgg_code)
        except CaptureStopped:
            raise
        except Exception:
            region_catalog = None
        if region_catalog is not None:
            region_calls = 1
            observed_iso = datetime.now(timezone.utc).isoformat()
            new_region_record = region_catalog.to_cache_record(sgg_code, observed_iso)

    if region_catalog is None:
        return None, None

    try:
        built = build_comparison_evidence(
            capture,
            region_catalog=region_catalog,
            api_fetch=guard.evidence_api(transports.api),
            kakao_fetch=guard.kakao(transports.kakao),
            model_no=plan['modelNo'],
            permissions=perms,
            applyhome_cache=applyhome_cache,
            kakao_cache=kakao_cache if perms.get('kakaoStorage') else None,
            max_applyhome_calls=guard.limits['evidenceApplyhomeRequests'],
            max_kakao_calls=guard.limits['evidenceKakaoRequests'],
        )
    except (AttributeError, HTTPException, InvalidOperation, KeyError, OSError, RuntimeError, TypeError, ValueError):
        # 근거 구성의 예기치 않은 자료 형식은 수집 실패가 아니라 근거 미등록(비교 보류)으로 남긴다.
        return None, None
    meta = built['metadata']
    meta['calls']['regions'] = region_calls
    meta['cacheHits']['regions'] = region_cache_hits

    if built['status'] != 'ready' or built['persistedEvidence'] is None:
        return None, None

    if upsert_cache is not None:
        entries = [
            entry for entry in built['newCacheEntries']
            if entry.get('cacheKind') != 'kakao_road_coordinate' or perms.get('kakaoStorage')
        ]
        if new_region_record is not None or entries:
            guard.confirm_lease()
            try:
                upsert_cache(new_region_record, entries)
            except WorkerRpcError as exc:
                if exc.code in ('PT404', 'PT409'):
                    raise CaptureStopped(exc) from None

    return built['runtimeEvidence'], {
        'evidence': built['persistedEvidence'],
        'sources': built['persistedSourceIds'],
        'metadata': meta,
    }


def prepare_notice_comparison(
    selection, work, *, generation, transports, renew, lease_seconds,
    read_permissions=None, read_cache=None, upsert_cache=None, return_evidence=False,
):
    """read_comparison_work 응답으로 공고 캡처, 자동 비교 근거와 comparison/v1을 만든다. renew(seconds)는 임대 갱신 RPC다."""
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
        runtime_evidence, evidence_bundle = build_capture_auto_evidence(
            capture, plan, transports, guard,
            read_permissions=read_permissions, read_cache=read_cache, upsert_cache=upsert_cache,
        )
        comparison = compare_snapshot(capture, plan['comparison'], runtime_evidence)
    except (AttributeError, HTTPException, KeyError, OSError, RuntimeError, TypeError, ValueError):
        raise NoticeRunFailure('notice_feed_unavailable') from None
    guard.confirm_lease()
    if return_evidence:
        return inputs, capture, comparison, schedules, evidence_bundle
    return inputs, capture, comparison, schedules


def _merge_official_index(*groups):
    merged, seen = [], set()
    for rows in groups:
        if not isinstance(rows, (list, tuple)):
            continue
        for row in rows:
            key = (row.get('id'), row.get('sha256'), row.get('edition')) if isinstance(row, dict) else None
            if key is not None and key[0] is not None and key in seen:
                continue
            if key is not None and key[0] is not None:
                seen.add(key)
            merged.append(row)
    return merged


def prepare_upload_supplement_comparison(
    selection, work, *, generation, transports, renew, lease_seconds, lookup_index=None,
    read_permissions=None, read_cache=None, upsert_cache=None, return_evidence=False,
):
    """read_upload_supplement_work 응답으로 업로드 대조·점검, 자동 비교 근거와 comparison/v1을 만든다."""
    try:
        plan = upload_supplement_plan(selection, work)
    except (KeyError, TypeError, ValueError):
        raise NoticeRunFailure('notice_selection_unverified') from None
    if callable(transports):
        transports = transports()
    if not isinstance(transports, NoticeTransports) or not callable(transports.upload):
        raise NoticeWorkerConfigurationError('업로드 보완 수집 전송을 확인할 수 없습니다.')
    limits = dict(LIMITS, **(transports.limits or {}))
    guard = CaptureGuard(renew, lease_seconds=lease_seconds, clock=transports.clock, sleep=transports.sleep,
                         limits=limits)
    guard.confirm_lease()
    upload_meta = plan['upload']
    try:
        received = transports.upload(upload_meta['uploadId'], upload_meta['objectPath'])
    except CaptureStopped:
        raise
    except Exception:
        raise NoticeRunFailure('upload_unavailable') from None
    if (not isinstance(received, dict) or set(received) != {'id', 'content'}
            or received.get('id') != upload_meta['uploadId']
            or not isinstance(received.get('content'), bytes) or len(received['content']) == 0):
        raise NoticeRunFailure('upload_unavailable')

    from notice_pdf_acquisition import MAX_PDF_BYTES
    content = received['content']
    official_index = list(plan['officialIndex'])
    if lookup_index is not None and len(content) <= MAX_PDF_BYTES:
        # 브라우저가 보낸 해시는 신뢰하지 않고 작업자가 바이트에서 직접 계산한 SHA-256으로 공식 색인을 대조한다.
        digest = hashlib.sha256(content).hexdigest()
        guard.confirm_lease()
        try:
            extra = lookup_index(digest)
        except WorkerRpcError as exc:
            raise CaptureStopped(exc) from None
        official_index = _merge_official_index(official_index, extra)

    try:
        inputs, capture, schedules = capture_notice(
            plan, transports, guard, generation,
            official_index=official_index, read_upload={'id': upload_meta['uploadId'], 'content': content},
        )
        runtime_evidence, evidence_bundle = build_capture_auto_evidence(
            capture, plan, transports, guard,
            read_permissions=read_permissions, read_cache=read_cache, upsert_cache=upsert_cache,
        )
        comparison = compare_snapshot(capture, plan['comparison'], runtime_evidence)
    except (AttributeError, HTTPException, KeyError, OSError, RuntimeError, TypeError, ValueError):
        raise NoticeRunFailure('notice_feed_unavailable') from None
    guard.confirm_lease()
    if return_evidence:
        return inputs, capture, comparison, schedules, evidence_bundle
    return inputs, capture, comparison, schedules


def execute_upload_supplement_lease(
    client, lease, selection, lease_seconds, transports, *, finish=None, retry_log=None,
):
    """업로드 보완 실행 한 건을 작업자 임대 안에서 검증·점검·원자 저장한다."""
    if transports is None:
        raise NoticeWorkerConfigurationError('업로드 보완 실행을 처리하려면 --live 또는 공고·업로드 전송이 필요합니다.')

    def renew(seconds):
        reply = client.post('renew_analysis_run', {**lease, 'p_lease_seconds': seconds})
        if (not isinstance(reply, dict) or reply.get('runId') != lease['p_run_id']
                or reply.get('status') != 'running' or type(reply.get('attempt')) is not int
                or reply['attempt'] != lease['p_generation']):
            raise WorkerRpcError()

    def lookup_index(sha256_hex):
        return client.post('lookup_official_notice_document_index', {**lease, 'p_sha256': sha256_hex})

    def read_permissions():
        return client.post('read_auto_evidence_permissions', lease)

    def read_cache(region_code, complex_keys):
        return client.post('read_auto_evidence_cache', {
            **lease, 'p_region_code': region_code, 'p_complex_keys': complex_keys,
        })

    def upsert_cache(region_record, entries):
        return client.post('upsert_auto_evidence_cache', {
            **lease, 'p_region': region_record, 'p_entries': entries,
        })

    if isinstance(transports, NoticeTransports):
        limits = dict(LIMITS, **(transports.limits or {}))
        save_lease_seconds = min(300, max(lease_seconds, limits['leaseSeconds']))
        save_sleep = transports.sleep
    else:
        save_lease_seconds = min(300, max(lease_seconds, LIMITS['leaseSeconds']))
        save_sleep = None

    try:
        try:
            work = client.post('read_upload_supplement_work', lease, limit=MAX_UPLOAD_SUPPLEMENT_WORK_BYTES)
        except WorkerRpcResponseTooLarge:
            raise NoticeRunFailure('notice_capture_limit', False) from None
        inputs, capture, comparison, schedules, evidence_bundle = prepare_upload_supplement_comparison(
            selection, work, generation=lease['p_generation'], transports=transports,
            renew=renew, lease_seconds=lease_seconds, lookup_index=lookup_index,
            read_permissions=read_permissions, read_cache=read_cache, upsert_cache=upsert_cache,
            return_evidence=True,
        )
        if finish is not None:
            return finish(
                client, lease, inputs, capture, comparison, schedules, evidence_bundle,
                lease_seconds=save_lease_seconds, renew=renew, sleep=save_sleep, retry_log=retry_log,
            )
        payload = {**lease, 'p_input': inputs, 'p_result': capture, 'p_comparison': comparison}
        if evidence_bundle is not None:
            body = dict(
                payload,
                p_evidence=evidence_bundle['evidence'],
                p_evidence_sources=evidence_bundle['sources'],
                p_evidence_metadata=evidence_bundle['metadata'],
            )
            if schedules is not None:
                body['p_schedules'] = schedules
            return client.post('finish_notice_with_evidence', body)
        if schedules is not None:
            return client.post('finish_notice_with_funding', dict(payload, p_schedules=schedules))
        return client.post('finish_analysis_comparison', payload)
    except CaptureStopped as exc:
        if exc.rpc_error is not None:
            raise exc.rpc_error from None
        code, retryable = 'notice_capture_limit', False
    except NoticeRunFailure as exc:
        code, retryable = exc.code, exc.retryable
    except WorkerRpcError as exc:
        if exc.code in ('42501', 'PT403') or exc.status == 403:
            code, retryable = 'notice_source_restricted', False
        elif exc.code == 'PT422':
            code, retryable = 'upload_unavailable', False
        elif exc.code == '22023':
            return client.post('fail_analysis_run', {**lease, 'p_retryable': False})
        elif exc.status == 413:
            code, retryable = 'notice_capture_limit', False
        elif exc.status == 429:
            code, retryable = 'notice_feed_unavailable', True
        else:
            raise
    return client.post('fail_notice_analysis_run', {**lease, 'p_error_code': code, 'p_retryable': retryable})


def read_worker_storage_upload(env, upload_id, object_path, *, opener=None, timeout=20):
    """DB가 검증한 비공개 analysis-uploads 경로에서 작업자 키로 소유자 PDF 바이트를 읽는다."""
    from notice_pdf_acquisition import MAX_PDF_BYTES
    from probe_apis import NoRedirect
    from worker_rpc import WorkerRpc

    uid = _canonical_uuid(upload_id)
    if not _matches(object_path, UPLOAD_OBJECT_PATH) or not object_path.endswith('/' + uid + '.pdf'):
        return None
    rpc_cfg = WorkerRpc(env)
    url = urllib_parse.urljoin(rpc_cfg.base, f'/storage/v1/object/{UPLOAD_BUCKET}/{object_path}')
    headers = {k: v for k, v in rpc_cfg.headers.items() if k != 'Content-Type'}
    headers['Cache-Control'] = 'no-store'
    req = urllib_request.Request(url, method='GET', headers=headers)
    transport = opener or urllib_request.build_opener(urllib_request.ProxyHandler({}), NoRedirect())
    try:
        with transport.open(req, timeout=timeout) as response:
            if response.status != 200:
                return None
            content = response.read(MAX_PDF_BYTES + 1)
    except urllib_error.HTTPError as exc:
        exc.close()
        return None
    except (OSError, HTTPException):
        return None
    return {'id': uid, 'content': content} if len(content) > 0 else None


def live_notice_transports():
    """선택된 공고의 공공데이터 전송을 만들고, 공식 문서·업로드·법정동·카카오 전송은 첫 필요 시점까지 미룬다."""
    from review_notice_documents import live_api_transport
    try:
        api = live_api_transport()
    except ValueError as exc:
        raise NoticeWorkerConfigurationError(str(exc)) from None
    except (KeyError, OSError):
        raise NoticeWorkerConfigurationError('공고·거래 API 명세를 작업자에서 읽을 수 없습니다.') from None
    pdf = None
    region_cache = {}

    def fetch_pdf(url, *, max_bytes, timeout):
        nonlocal pdf
        if pdf is None:
            from notice_pdf_acquisition import make_live_fetch
            pdf = make_live_fetch()
        return pdf(url, max_bytes=max_bytes, timeout=timeout)

    def fetch_upload(upload_id, object_path):
        return read_worker_storage_upload(os.environ, upload_id, object_path)

    def fetch_regions(sgg_code):
        if 'catalog' not in region_cache:
            from refresh_notice_index import download_region_zip
            region_cache['catalog'] = LegalRegionCatalog.from_mois_tsv_bytes(download_region_zip())
        return region_cache['catalog']

    kakao = live_kakao_transport()
    return NoticeTransports(api=api, pdf=fetch_pdf, upload=fetch_upload, regions=fetch_regions, kakao=kakao)
