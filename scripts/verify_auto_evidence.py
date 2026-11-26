#!/usr/bin/env python3
"""실공고·실거래에 대해 자동 비교 근거(Q-38·Q-39)를 수동 검수한다.

주의:
- 기본 검사와 CI에서는 실행하지 않으며 `--live` 플래그가 있을 때만 외부 공식 API를 호출한다.
- 실행 전 호출 상한(`--max-applyhome-calls`, `--max-kakao-calls`)과 API 이용 조건을 확인한다.
- 응답 원문, API 키, 인증 헤더, 원좌표(위·경도)는 표준출력이나 파일에 기록하지 않고 요약 수치와 사유 코드만 출력한다.
"""
import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from compare_trades import compare_snapshot
from complex_coordinates import (
    DEFAULT_KAKAO_REQUEST_LIMIT,
    live_kakao_transport,
)
from complex_evidence import (
    DEFAULT_APPLYHOME_REQUEST_LIMIT,
    LegalRegionCatalog,
    build_comparison_evidence,
)
from ingestion_notices import NOTICE_SOURCES
from ingestion_trades import TRADE_KINDS
from replay_ingestion import ingest

KST = timezone(timedelta(hours=9))
MAX_ALLOWED_APPLYHOME_CALLS = 120
MAX_ALLOWED_KAKAO_CALLS = 30
DEFAULT_LIVE_APPLYHOME_CALLS = 40
DEFAULT_LIVE_KAKAO_CALLS = 15
DEFAULT_TARGET = {
    'noticeSource': 'applyhome_remainder',
    'houseManageNo': '2024930022',
    'noticeNo': '2024930022',
    'edition': '2024-04-18',
    'regionCode': '41290',
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='실공고·실거래의 자동 단지·공급면적 근거(Q-38)와 대표 좌표(Q-39)를 수동 검수한다.',
    )
    parser.add_argument('--live', action='store_true', help='실제 공식 API 호출을 명시적으로 허용한다.')
    parser.add_argument('--notice-source', choices=NOTICE_SOURCES, default=DEFAULT_TARGET['noticeSource'],
                        help='대상 공고 API 출처 (기본: applyhome_remainder)')
    parser.add_argument('--house-manage-no', default=DEFAULT_TARGET['houseManageNo'],
                        help='대상 공고 주택관리번호 10자리 (기본: 2024930022)')
    parser.add_argument('--notice-no', default=DEFAULT_TARGET['noticeNo'],
                        help='대상 공고 공고번호 10자리 (기본: 2024930022)')
    parser.add_argument('--edition', default=DEFAULT_TARGET['edition'],
                        help='대상 공고 모집공고일 YYYY-MM-DD (기본: 2024-04-18)')
    parser.add_argument('--region-code', default=DEFAULT_TARGET['regionCode'],
                        help='대상 시·군·구 5자리 법정동코드 (기본: 41290 과천시)')
    parser.add_argument('--model-no', default=None, help='대상 주택형 MODEL_NO (생략 시 첫 연결 주택형)')
    parser.add_argument('--as-of', default=None, help='조회 기준일 YYYY-MM-DD (기본: 오늘 한국 날짜)')
    parser.add_argument('--start-date', default=None, help='사용자 지정 거래 시작일 YYYY-MM-DD (선택)')
    parser.add_argument('--end-date', default=None, help='사용자 지정 거래 종료일 YYYY-MM-DD (선택)')
    parser.add_argument('--max-applyhome-calls', type=int, default=DEFAULT_LIVE_APPLYHOME_CALLS,
                        help=f'청약홈 근거 조회 호출 상한 (1~{MAX_ALLOWED_APPLYHOME_CALLS}, 기본 {DEFAULT_LIVE_APPLYHOME_CALLS})')
    parser.add_argument('--max-kakao-calls', type=int, default=DEFAULT_LIVE_KAKAO_CALLS,
                        help=f'카카오 로컬 주소 검색 호출 상한 (0~{MAX_ALLOWED_KAKAO_CALLS}, 기본 {DEFAULT_LIVE_KAKAO_CALLS})')
    parser.add_argument('--allow-official-pdf', action='store_true',
                        help='청약홈 공식 공고 PDF 점검을 함께 수행해 대상 공급면적과 호실가를 대조한다.')
    parser.add_argument('--kakao-storage-allowed', action='store_true',
                        help='source_registry에서 카카오 좌표 저장·재사용이 허용된 경우에만 지정한다 (기본: 미허용·실행 메모리 전용).')
    parser.add_argument('--region-codes-file', type=Path, default=None,
                        help='미리 내려받은 행정안전부 법정동코드 전체자료 TSV 파일 경로 (선택)')
    parser.add_argument('--region-codes-sha256', default=None,
                        help='--region-codes-file 지정 시 검증할 SHA-256 해시')
    return parser


def validate_args(args) -> None:
    if not args.live:
        raise ValueError('실외부 API 호출을 수행하려면 --live 옵션을 명시하세요.')
    if not re.fullmatch(r'[0-9]{10}', args.house_manage_no) or not re.fullmatch(r'[0-9]{10}', args.notice_no):
        raise ValueError('주택관리번호와 공고번호는 10자리 숫자여야 합니다.')
    date.fromisoformat(args.edition)
    if not re.fullmatch(r'[0-9]{5}', args.region_code):
        raise ValueError('지역 코드는 5자리 시·군·구 법정동코드여야 합니다.')
    if args.as_of is not None:
        date.fromisoformat(args.as_of)
    if (args.start_date is None) != (args.end_date is None):
        raise ValueError('--start-date와 --end-date는 함께 지정해야 합니다.')
    if args.start_date is not None:
        date.fromisoformat(args.start_date)
        date.fromisoformat(args.end_date)
    if not 1 <= args.max_applyhome_calls <= MAX_ALLOWED_APPLYHOME_CALLS:
        raise ValueError(f'--max-applyhome-calls는 1~{MAX_ALLOWED_APPLYHOME_CALLS} 범위여야 합니다.')
    if not 0 <= args.max_kakao_calls <= MAX_ALLOWED_KAKAO_CALLS:
        raise ValueError(f'--max-kakao-calls는 0~{MAX_ALLOWED_KAKAO_CALLS} 범위여야 합니다.')
    if args.region_codes_file is not None and not args.region_codes_sha256:
        raise ValueError('--region-codes-file에는 --region-codes-sha256을 함께 지정해야 합니다.')


def summarize_verification(capture: dict, built: dict, comparison: Optional[dict], *, kakao_key_present: bool) -> dict:
    """원문·키·원좌표 없이 검수 요약 JSON만 구성한다."""
    meta = built['metadata']
    hold_counts = Counter()
    if comparison:
        for h in comparison.get('holds') or []:
            hold_counts[h.get('reasonCode') or 'unknown'] += 1

    comparables_summary = []
    if comparison:
        for comp in comparison.get('comparables') or []:
            dist = comp.get('distance') or {}
            stats = {
                kind: {
                    'status': st.get('status'),
                    'count': st.get('count'),
                    'minWon': st.get('minWon'),
                    'medianWon': st.get('medianWon'),
                    'maxWon': st.get('maxWon'),
                }
                for kind, st in (comp.get('tradeStats') or {}).items()
            }
            comparables_summary.append({
                'complexId': comp.get('complexId'),
                'rank': comp.get('rank'),
                'supplyAreaM2': comp.get('supplyAreaM2'),
                'areaDifferenceM2': comp.get('areaDifferenceM2'),
                'distanceStatus': dist.get('status'),
                'distanceMeters': round(dist['meters'], 1) if isinstance(dist.get('meters'), (int, float)) else None,
                'selectionReason': comp.get('selectionReason'),
                'tradeStats': stats,
            })

    complex_outcomes = [
        {
            'complexId': c.get('complexId'),
            'scope': c.get('scope'),
            'isTarget': c.get('isTarget'),
            'status': c.get('status'),
            'reasonCode': c.get('reasonCode'),
            'coordinateStatus': c.get('coordinateStatus', 'not_queried'),
            'coordinateReasonCode': c.get('coordinateReasonCode'),
            'areas': [
                {
                    'exclusiveAreaM2': a.get('exclusiveAreaM2'),
                    'status': a.get('status'),
                    'supplyAreaM2': a.get('supplyAreaM2'),
                    'reasonCode': a.get('reasonCode'),
                    'noticePairs': [
                        f'{n["houseManageNo"]}/{n["noticeNo"]}:{n["houseType"]}'
                        for n in (a.get('notices') or [])
                    ],
                }
                for a in (c.get('areas') or [])
            ],
        }
        for c in (meta.get('complexes') or [])
    ]

    return {
        'contractVersion': 'auto-evidence-verification/v1',
        'dataOrigin': capture.get('dataOrigin'),
        'target': capture.get('target'),
        'period': capture.get('period'),
        'kakaoKeyPresent': kakao_key_present,
        'evidenceStatus': built.get('status'),
        'evidenceReasonCode': built.get('reasonCode'),
        'scopeChecked': meta.get('scopeChecked'),
        'calls': meta.get('calls'),
        'limits': meta.get('limits'),
        'budgetReached': meta.get('budgetReached'),
        'kakaoStorageAllowed': meta.get('kakaoStorageAllowed'),
        'coordinatesPersisted': meta.get('coordinatesPersisted'),
        'targetCoordinateStatus': meta.get('targetCoordinateStatus'),
        'targetCoordinateReasonCode': meta.get('targetCoordinateReasonCode'),
        'complexSummary': meta.get('complexSummary'),
        'complexes': complex_outcomes,
        'comparison': None if comparison is None else {
            'completeness': comparison.get('completeness'),
            'appliedScope': comparison.get('appliedScope'),
            'rankingComplete': comparison.get('rankingComplete'),
            'regionDecision': comparison.get('regionDecision'),
            'holdCounts': dict(sorted(hold_counts.items())),
            'comparables': comparables_summary,
        },
    }


def _load_region_catalog(args) -> LegalRegionCatalog:
    if args.region_codes_file is not None:
        raw = args.region_codes_file.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest != args.region_codes_sha256.lower():
            raise ValueError('법정동코드 파일의 SHA-256 해시가 일치하지 않습니다.')
        return LegalRegionCatalog.from_mois_tsv_bytes(raw)
    from refresh_notice_index import download_region_zip
    return LegalRegionCatalog.from_mois_tsv_bytes(download_region_zip())


def run_live_verification(args) -> dict:
    validate_args(args)
    if not (os.environ.get('DATA_GO_KR_SERVICE_KEY') or '').strip():
        raise ValueError('DATA_GO_KR_SERVICE_KEY 환경변수가 필요합니다.')

    from review_notice_documents import live_api_transport
    api = live_api_transport()
    kakao = live_kakao_transport() if args.max_kakao_calls > 0 else None
    kakao_key_present = bool((os.environ.get('KAKAO_REST_API_KEY') or '').strip())
    region_catalog = _load_region_catalog(args)

    as_of = args.as_of or datetime.now(KST).date().isoformat()
    request = {
        'noticeSource': args.notice_source,
        'target': {
            'houseManageNo': args.house_manage_no,
            'noticeNo': args.notice_no,
            'edition': args.edition,
        },
        'asOf': as_of,
        'requestRegionCodes': [args.region_code],
        'tradeKinds': list(TRADE_KINDS),
        'pageSize': 100,
    }
    if args.start_date is not None:
        request['start'] = args.start_date
        request['end'] = args.end_date

    review_fn = None
    if args.allow_official_pdf:
        from notice_document_review import review_catalog_documents
        from notice_pdf_acquisition import make_live_fetch
        pdf_fetch = make_live_fetch()
        review_fn = lambda target, current: review_catalog_documents(target, current, fetch=pdf_fetch)

    capture = ingest(request, api, data_origin='collected', review_documents=review_fn)
    models = [m for m in (capture.get('catalog') or {}).get('housingTypes') or [] if m.get('status') == 'linked']
    model_no = args.model_no or (models[0]['modelNo'] if models else None)

    built = build_comparison_evidence(
        capture,
        region_catalog=region_catalog,
        api_fetch=api,
        kakao_fetch=kakao,
        model_no=model_no,
        permissions={
            'applyhomeApt': True,
            'applyhomeRemainder': True,
            'moisRegions': True,
            'kakaoRuntime': True,
            'kakaoStorage': bool(args.kakao_storage_allowed),
        },
        max_applyhome_calls=args.max_applyhome_calls,
        max_kakao_calls=args.max_kakao_calls,
    )
    built['metadata']['calls']['regions'] = 0 if args.region_codes_file else 1

    selection = {'modelNo': model_no} if model_no else {}
    comparison = compare_snapshot(capture, selection, built['runtimeEvidence'])
    return summarize_verification(capture, built, comparison, kakao_key_present=kakao_key_present)


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        summary = run_live_verification(args)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
