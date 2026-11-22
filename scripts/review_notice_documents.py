#!/usr/bin/env python3
"""공고와 주택형을 조회한 뒤 공식 PDF의 금액·면적을 점검하는 개발 작업자."""
import argparse
import http.client
import json
import os
import sys
from functools import partial
from pathlib import Path
from urllib import error, request
from uuid import UUID

from ingestion_pages import LiveProbeTransport, loads_source_json
from probe_apis import NoRedirect, ROOT
from replay_ingestion import collect_notice_catalog, ingest
from store_ingestion import save_snapshot


def read_owned_upload(analysis_id, upload_id, token, port=3001, *, opener=None):
    """기존 사용자 API에서 현재 계정이 읽을 수 있는 PDF만 메모리로 받는다."""
    path = f'/api/v1/analyses/{UUID(analysis_id)}/uploads/{UUID(upload_id)}/content'
    if not token or not 1 <= port <= 65535:
        raise ValueError('업로드 보완에 사용자 세션과 로컬 API 포트가 필요합니다.')
    call = request.Request(f'http://127.0.0.1:{port}{path}', headers={
        'Authorization': 'Bearer ' + token, 'Accept': 'application/pdf'})
    transport = opener or request.build_opener(request.ProxyHandler({}), NoRedirect())
    from notice_pdf_acquisition import MAX_PDF_BYTES
    try:
        with transport.open(call, timeout=15) as response:
            if response.status != 200 or response.headers.get_content_type() != 'application/pdf':
                return None
            content = response.read(MAX_PDF_BYTES + 1)
    except error.HTTPError as exc:
        exc.close()
        return None
    except (OSError, http.client.HTTPException):
        return None
    return {'id': upload_id, 'content': content} if 0 < len(content) <= MAX_PDF_BYTES else None


def live_api_transport():
    key = os.environ.get('DATA_GO_KR_SERVICE_KEY')
    if not key:
        raise ValueError('공공데이터포털 키를 작업자 환경에 설정하세요.')
    specs = json.loads((ROOT / 'docs/api/probes.json').read_text(encoding='utf-8'))['probes']
    return LiveProbeTransport(specs, {'DATA_GO_KR_SERVICE_KEY': key})


def review_law_for_notice(catalog, *, publish):
    """법령을 함께 요청한 경우, 완전 수집한 공고의 날짜만 외부 작업자에게 전달한다."""
    from notice_pdf_fields import reported_notice_date
    notice = catalog['notice']
    collection = catalog['collections']['notice']
    as_of = reported_notice_date(catalog)
    if (notice.get('status') != 'reported' or not notice.get('evidence') or not as_of
            or collection.get('status') != 'complete' or collection.get('declaredStatus') != 'complete'):
        return {'status': 'held', 'reasonCodes': ['notice_date_unverified'], 'reference': None}
    try:
        from collect_law_evidence import collect_live_reference
        return collect_live_reference(as_of, publish=publish)
    except (OSError, ValueError, TypeError, RuntimeError):
        # 보조 조회 장애가 앞서 확인·저장한 공고나 납부 일정의 성공을 바꾸지 않는다.
        return {'status': 'held', 'reasonCodes': ['law_lookup_unavailable'], 'reference': None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', required=True, help='명시한 범위의 외부 조회를 실행')
    parser.add_argument('--request', type=Path, required=True, help='작업자가 구성한 공고 수집 요청 JSON')
    parser.add_argument('--official-index', type=Path, help='작업자가 공식 출처에서 대조한 원본 기록 JSON')
    parser.add_argument('--upload-id', help='자동 확보 실패 시 확인할 소유자 PDF의 등록 UUID')
    parser.add_argument('--analysis-id', help='업로드 또는 저장 대상 분석 UUID')
    parser.add_argument('--api-port', type=int, default=3001, help='등록 파일 조회에 쓸 로컬 사용자 API 포트')
    parser.add_argument('--save', action='store_true', help='요청 범위의 거래까지 수집해 소유자 스냅샷으로 저장')
    parser.add_argument('--with-law', action='store_true', help='확인한 공고일의 법령 판본도 조회하고, --save 시 게시')
    parser.add_argument('--owner-id', help='저장 대상 분석 소유자 UUID')
    parser.add_argument('--capture-key', help='저장 재시도에 재사용하는 수집 UUID')
    args = parser.parse_args()
    if args.upload_id and not args.analysis_id:
        parser.error('--upload-id에는 --analysis-id가 필요합니다.')
    if args.upload_id and not os.environ.get('HOMECIERGE_USER_JWT'):
        parser.error('--upload-id에는 파일 소유자의 HOMECIERGE_USER_JWT가 필요합니다.')
    if args.save and not all((args.owner_id, args.analysis_id, args.capture_key)):
        parser.error('--save에는 --owner-id, --analysis-id, --capture-key가 모두 필요합니다.')
    try:
        for value in (args.upload_id, args.analysis_id, args.owner_id, args.capture_key):
            if value is not None:
                UUID(value)
        inputs = loads_source_json(args.request.read_text(encoding='utf-8'))
        if not isinstance(inputs, dict):
            raise ValueError('공고 수집 요청 객체가 필요합니다.')
        index = loads_source_json(args.official_index.read_text(encoding='utf-8')) if args.official_index else None
        read_upload = (partial(read_owned_upload, args.analysis_id, args.upload_id,
                               os.environ.get('HOMECIERGE_USER_JWT'), args.api_port)
                       if args.upload_id else None)
        from notice_document_review import review_catalog_documents
        review = partial(review_catalog_documents, official_index=index, read_upload=read_upload)
        api = live_api_transport()
        if args.save:
            payment_schedules = None

            def review_for_save(target, catalog):
                nonlocal payment_schedules
                checked = review(target, catalog)
                payment_schedules = (checked.get('review') or {}).get('paymentSchedules')
                return checked

            result = ingest(inputs, api, data_origin='collected', review_documents=review_for_save)
            saved = save_snapshot(args.owner_id, args.analysis_id, args.capture_key, inputs, result,
                                  env=os.environ, retry_uncertain=True, payment_schedules=payment_schedules)
            output = {'snapshotId': saved}
            catalog = result['catalog']
        else:
            catalog, _, receipt = collect_notice_catalog(inputs.get('noticeSource'), inputs.get('target'), api,
                                                         page_size=inputs.get('pageSize', 100), review_documents=review)
            output = {'documentReview': receipt, 'catalog': catalog}
        if args.with_law:
            output['lawReview'] = review_law_for_notice(catalog, publish=args.save)
        print(json.dumps(output, ensure_ascii=False, allow_nan=False))
    except (OSError, ValueError, TypeError, RuntimeError) as exc:
        # 경로·인증값·상류 응답과 PDF 내용은 오류 출력에 넣지 않는다.
        if type(exc) is RuntimeError and str(exc).startswith('저장 RPC 실패 (HTTP '):
            print(str(exc), file=sys.stderr)
        else:
            print('공고 문서 작업을 완료하지 못했습니다. 입력·작업자 환경·출처 연결을 확인하세요.', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
