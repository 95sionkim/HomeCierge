#!/usr/bin/env python3
"""한 공고와 요청 지역·계약월의 자료를 수집·정규화한다. CLI는 합성 응답만 재생한다."""
import argparse
import json
import re
from pathlib import Path

from ingestion_notices import normalize_catalog
from ingestion_pages import ReplayTransport, collect_pages, loads_source_json
from ingestion_trades import SOURCE_KINDS, TRADE_KINDS, normalize_trade, trade_period


COVERAGE_FIELDS = ('status', 'pagesExpected', 'missingPages', 'reportedTotalCount',
                   'rowsReceived', 'totalCountChanged', 'collectedAt', 'error')


def nonempty_strings(request, field):
    values = request.get(field)
    if (not isinstance(values, list) or not values
            or any(not isinstance(value, str) or not value.strip() for value in values)
            or len(values) != len(set(values))):
        raise ValueError(f'{field}에 중복 없는 문자열 목록이 필요합니다.')
    return values


def collect_notice_catalog(notice_source, target, fetch, *, page_size, evidence=(), review_documents=None):
    """같은 두 번호로 공고와 주택형을 수집하고, 선택한 작업 경로에서 원문을 대조한다."""
    if notice_source not in ('applyhome_apt', 'applyhome_remainder'):
        raise ValueError('지원하는 청약홈 공고 출처를 지정하세요.')
    target_fields = ('houseManageNo', 'noticeNo', 'edition')
    if not isinstance(target, dict) or any(
        not isinstance(target.get(key), str) or not target[key] or target[key] != target[key].strip()
        for key in target_fields
    ):
        raise ValueError('대상 공고의 주택관리번호·공고번호와 문서 대조 회차가 필요합니다.')
    target = {key: target[key] for key in target_fields}
    if review_documents is not None and evidence:
        raise ValueError('문서 자동 점검과 사전 입력 근거를 한 수집본에 섞을 수 없습니다.')
    scope = {'cond[HOUSE_MANAGE_NO::EQ]': target['houseManageNo'],
             'cond[PBLANC_NO::EQ]': target['noticeNo']}
    notice = collect_pages(notice_source, scope, fetch, page_size=page_size)
    models = collect_pages(notice_source + '_model', scope, fetch, page_size=page_size)
    catalog = normalize_catalog(notice, models, target=target, evidence=evidence)
    receipt = None
    if review_documents is not None:
        checked = review_documents(target, catalog)
        if checked['evidence']:
            catalog = normalize_catalog(notice, models, target=target, evidence=checked['evidence'])
        referenced = {(d['id'], d['version']) for d in catalog['documents']}
        for doc in checked.get('documentVersions', ()):
            key = (doc['id'], doc['version'])
            if key not in referenced:
                catalog['documents'].append(doc)
                referenced.add(key)
        catalog['issues'].extend(checked['issues'])
        receipt = checked.get('review')
    collections = [
        {key: collection[key] for key in ('source', 'scope', *COVERAGE_FIELDS, 'reasons')}
        for collection in (notice, models)
    ]
    return catalog, collections, receipt


def ingest(request, fetch, *, evidence=(), data_origin, review_documents=None):
    """전송을 주입받아 같은 범위를 한 번씩 조회한다. 지역 확대·가격 비교 이전의 입력을 반환한다."""
    if not isinstance(request, dict) or data_origin not in ('synthetic', 'collected'):
        raise ValueError('요청 객체와 자료 출처 구분이 필요합니다.')
    notice_source = request.get('noticeSource')
    regions = nonempty_strings(request, 'requestRegionCodes')
    if any(not re.fullmatch(r'[0-9]{5}', code) for code in regions):
        raise ValueError('국토교통부 요청 지역코드에는 5자리 LAWD_CD를 사용하세요.')
    trade_kinds = nonempty_strings(request, 'tradeKinds')
    if not set(trade_kinds).issubset(TRADE_KINDS):
        raise ValueError('지원하는 거래 종류를 지정하세요.')
    page_size = request.get('pageSize', 100)
    if type(page_size) is not int or page_size < 1:
        raise ValueError('pageSize는 양의 정수여야 합니다.')
    period = trade_period(request.get('asOf'), request.get('start'), request.get('end'))

    catalog, catalog_collections, _ = collect_notice_catalog(
        notice_source, request.get('target'), fetch, page_size=page_size, evidence=evidence,
        review_documents=review_documents)

    trade_batches = []
    months = period['months'] if period['status'] == 'confirmed' else ()
    for region in regions:
        for month in months:
            for source, supported_kinds in SOURCE_KINDS.items():
                kinds = [kind for kind in trade_kinds if kind in supported_kinds]
                if not kinds:
                    continue
                scope = {'LAWD_CD': region, 'DEAL_YMD': month}
                batch = collect_pages(source, scope, fetch, page_size=page_size)
                # 이 기록은 BE-01의 collectionRecord다. 수집 완료 여부와 후보 판별은 별개다.
                record = {
                    'recordId': f'col-{source}-{region}-{month}',
                    'source': source, 'tradeKinds': kinds, 'requestRegionCode': region,
                    'month': month[:4] + '-' + month[4:],
                    **{key: batch[key] for key in COVERAGE_FIELDS},
                }
                trades = [
                    normalize_trade(source, obs, region, month, period, kinds)
                    for obs in batch['observations']
                ]
                trade_batches.append({'record': record, 'reasons': batch['reasons'], 'trades': trades})
    return {'contractVersion': 'ingestion/v0', 'dataOrigin': data_origin, 'target': catalog['target'],
            'asOf': request['asOf'], 'period': period, 'requestRegionCodes': regions, 'tradeKinds': trade_kinds,
            'catalogCollections': catalog_collections, 'catalog': catalog, 'tradeBatches': trade_batches}


def replay(bundle):
    if not isinstance(bundle, dict) or bundle.get('dataOrigin') != 'synthetic':
        raise ValueError('재생 파일에 synthetic 표시가 필요합니다.')
    evidence = bundle.get('evidence', [])
    if not isinstance(evidence, list):
        raise ValueError('문서 근거를 목록으로 입력하세요.')
    return ingest(bundle.get('request'), ReplayTransport(bundle), evidence=evidence, data_origin='synthetic')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path, help='요청·출처별 페이지·문서 근거를 담은 합성 JSON')
    args = parser.parse_args()
    try:
        # 원천에서 숫자로 준 면적도 소수 자릿수를 보존한다.
        result = replay(loads_source_json(args.bundle.read_text(encoding='utf-8')))
    except (OSError, ValueError) as exc:
        parser.exit(2, f'재생 입력 오류: {exc}\n')
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
