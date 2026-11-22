#!/usr/bin/env python3
"""과천 갈현동의 2026-09-23 매매 1건을 실제 조회해 독립 XML 집계와 비교한다. 저장은 하지 않는다."""
import argparse
import csv
import io
import json
import os
import re
import sys
import zipfile
from collections import Counter
from datetime import date
from decimal import Decimal
from pathlib import Path
from statistics import median
from xml.etree import ElementTree

from compare_trades import compare_snapshot
from ingestion_pages import LiveProbeTransport, collect_pages
from notice_pdf_acquisition import acquire_notice_pdf, make_live_fetch
from probe_apis import run_probe
from refresh_notice_index import REGION_INPUT_LIMIT, download_region_zip
from replay_ingestion import ingest

SPECS = Path(__file__).resolve().parents[1] / 'docs/api/probes.json'
DAY = '2026-09-23'
TARGET = '2024930022'
CITY = '41290'
DONG = '4129010300'
TARGET_COMPLEX = 'A10023264'
NEIGHBOR = 'A10024002'
TRADE_KINDS = ['sale', 'presale_right', 'occupancy_right']
# 사람이 물리 5쪽(최초 공고는 7쪽) 면적표를 대조한 판본. 새 판본은 다시 점검한다.
DOCUMENTS = {
    TARGET: ('applyhome_remainder', '2024-04-18', '93b056ee178d8d1e4bb0e8726dc8437742d31f8eade282005cfb3109572f870c'),
    '2020001181': ('applyhome_apt', '2020-10-22', 'c103a104df1a7c07eb439ffb81f5bf7f48099be381beadcbb479fc4d6cd51668'),
    '2024930021': ('applyhome_remainder', '2024-04-18', '49324b4db387012476cdff7968d6d8802441a2ae5f7f5d5f74c0f8ba19511b3d'),
    '2026930036': ('applyhome_remainder', DAY, 'f4cd78ef9044a11eece348cc70636b1ea0ac93b0cbe49b41cc0a1e7191e4a39c'),
}


class EvidenceUnavailable(ValueError):
    """공개 가능한 검수 사유만 담는다."""


def require(condition, reason):
    if not condition:
        raise EvidenceUnavailable(reason)


def proof(source, reference):
    return {'source': source, 'reference': reference}


def verified_documents(fetch, pdf_fetch):
    target_document = None
    for number, (source, notice_date, fingerprint) in DOCUMENTS.items():
        target = {'houseManageNo': number, 'noticeNo': number, 'edition': notice_date}
        scope = {'cond[HOUSE_MANAGE_NO::EQ]': number, 'cond[PBLANC_NO::EQ]': number}
        listing = collect_pages(source, scope, fetch, page_size=1000)
        require(listing['status'] == 'complete' and len(listing['observations']) == 1, '공고를 1건으로 확인할 수 없습니다.')
        notice = listing['observations'][0]['row']
        require(str(notice['HOUSE_MANAGE_NO']) == number == str(notice['PBLANC_NO'])
                and notice['RCRIT_PBLANC_DE'] == notice_date, '공고번호 또는 공고일이 달라졌습니다.')
        acquired = acquire_notice_pdf(target, notice['PBLANC_URL'], fetch=pdf_fetch, notice_date=notice_date)
        docs = [d for d in acquired['documents'] if d['adoption'] == 'standalone' and d['source'] == 'official']
        require(acquired['status'] == 'acquired' and len(docs) == 1 and docs[0]['sha256'] == fingerprint,
                '공식 PDF 판본 또는 정정 관계를 다시 점검해야 합니다.')
        if number == TARGET:
            target_document = {k: docs[0][k] for k in (*target, 'id', 'source', 'originCheck', 'version')}
        if number == '2020001181':
            models = collect_pages(source + '_model', scope, fetch, page_size=1000)
            rows = [o['row'] for o in models['observations']]
            require(models['status'] == 'complete' and len(rows) == 8, '최초 공고 전체 주택형이 달라졌습니다.')
            matching = [row for row in rows if Decimal(re.sub('[A-Z]+$', '', row['HOUSE_TY'].strip())) == Decimal('84.7450')]
            require(len(matching) == 1 and matching[0]['HOUSE_TY'].strip() == '084.7450D'
                    and Decimal(str(matching[0]['SUPLY_AR'])) == Decimal('110.3239'), '84D 주택형 대응이 유일하지 않습니다.')
    return target_document


def official_regions():
    archive = download_region_zip()
    require(0 < len(archive) <= REGION_INPUT_LIMIT, '법정동 압축자료의 크기를 확인하세요.')
    with zipfile.ZipFile(io.BytesIO(archive)) as packed:
        member, = packed.infolist()
        require(member.filename.lower().endswith('.txt') and member.file_size <= REGION_INPUT_LIMIT, '법정동 자료 형식이 다릅니다.')
        data = packed.read(member)
    try:
        contents = data.decode('utf-8-sig')
    except UnicodeDecodeError:
        contents = data.decode('cp949')
    reader = csv.reader(io.StringIO(contents), delimiter='\t')
    require(next(reader) == ['법정동코드', '법정동명', '폐지여부'], '법정동 자료 머리글이 달라졌습니다.')
    regions = []
    for code, name, state in reader:
        if state != '존재' or not name.startswith('경기도 과천시 '):
            continue
        require(re.fullmatch(CITY + '[0-9]{5}', code) and name.endswith('동'), '과천시 법정동 기준이 달라졌습니다.')
        regions.append(dict(localityCode=code, localityType='dong', localityName=name.split()[-1], umdCd=code[-5:],
                            requestRegionCode=CITY, districtCode=None, municipalityCode=CITY,
                            evidence=proof('mois_legal_region_codes', code)))
    require(any(r['localityCode'] == DONG and r['localityName'] == '갈현동' for r in regions), '갈현동 미확인')
    return regions


def official_complexes(specs, keys):
    complexes = []
    for code, road, households, approved in ((TARGET_COMPLEX, '35', 584, '20230417'), (NEIGHBOR, '15', 679, '20211210')):
        result, _, payload = run_probe('apt_basic', specs['apt_basic'], keys, {'kaptCode': code})
        require(result.get('http_status') == 200 and result['status'] == 'success', 'K-apt 기본정보 조회 실패')
        row = payload['response']['body']['item']
        require(row['kaptCode'] == code and row['bjdCode'] == DONG and row['kaptdaCnt'] == households
                and row['kaptUsedate'] == approved and row['doroJuso'] == '경기도 과천시 과천대로8길 ' + road,
                '단지의 법정동·도로명주소·세대수·사용승인일을 다시 확인하세요.')
        complexes.append(dict(complexId=code, name=row['kaptName'], localityCode=DONG, evidence=proof('kapt_apt_basic', code)))
    return complexes


def xml_rows(fetch, source, month):
    raw = fetch(source, {'LAWD_CD': CITY, 'DEAL_YMD': month}, 1, 1000)
    require(raw['httpStatus'] == 200 and not raw['transportError'] and raw['body'], '실거래 전송 미완료')
    xml = ElementTree.fromstring(raw['body'])
    rows = xml.findall('.//items/item')
    require(xml.findtext('.//resultCode') in ('000', '00') and xml.findtext('.//pageNo') == '1'
            and int(xml.findtext('.//totalCount')) == len(rows), '실거래 페이지 누락 또는 업무 오류')
    return rows


def contract_date(row):
    return date(*(int(row.findtext(key)) for key in ('dealYear', 'dealMonth', 'dealDay'))).isoformat()


def independent_day(fetch):
    """엔진의 정규화·기간·집계 함수를 사용하지 않고 계약 당일 같은 두 XML을 직접 센다."""
    values = []
    for source in ('apt_trade', 'apt_rights'):
        for row in xml_rows(fetch, source, '202609'):
            if contract_date(row) != DAY:
                continue
            require(source == 'apt_trade' and row.findtext('aptSeq') == '41290-455'
                    and row.findtext('sggCd') == CITY and row.findtext('umdCd') == '10300'
                    and row.findtext('aptNm') == '과천푸르지오라비엔오' and row.findtext('umdNm') == '갈현동'
                    and row.findtext('jibun') == '827' and row.findtext('roadNm') == '과천대로8길'
                    and int(row.findtext('roadNmBonbun')) == 15 and Decimal(row.findtext('excluUseAr')) == Decimal('84.7450')
                    and not any((row.findtext(k) or '').strip() for k in ('cdealType', 'cdealDay')), '검산일의 거래 집합이 달라졌습니다.')
            values.append(int(row.findtext('dealAmount').strip().replace(',', '')) * 10000)
    require(len(values) == 1, '검산일의 유효 매매 건수가 달라졌습니다.')
    return dict(count=len(values), minWon=str(min(values)), medianWon=str(median(values)), maxWon=str(max(values)))


def independent_population(fetch, period, regions):
    counts = Counter()
    official_names = {region['localityName'] for region in regions}
    for month in period['months']:
        for source in ('apt_trade', 'apt_rights'):
            for row in xml_rows(fetch, source, month):
                counts[source] += 1
                if not period['start'] <= contract_date(row) <= period['end']:
                    counts['outsidePeriod'] += 1
                    continue
                mark, day = ((row.findtext(k) or '').strip() for k in ('cdealType', 'cdealDay'))
                if mark or day:
                    require(mark == 'O', '해제 표지를 개별적으로 점검하세요.')
                    counts['cancelled'] += 1
                    continue
                name = row.findtext('umdNm')
                require(row.findtext('sggCd') == CITY and name in official_names, '법정동 소속을 확인할 수 없습니다.')
                counts['priorityRows' if name == '갈현동' else 'otherLocalities'] += 1
    return dict(counts)


def run(window, fetch, regions, complexes, document, price):
    target = {k: document[k] for k in ('houseManageNo', 'noticeNo', 'edition')}
    request = dict(noticeSource='applyhome_remainder', target=target, asOf='2026-11-22',
                   requestRegionCodes=[CITY], tradeKinds=TRADE_KINDS, pageSize=1000)
    if window != 'year':
        request.update(start=DAY if window == 'day' else '2026-09-01', end=DAY if window == 'day' else '2026-09-30')
    area = dict(document=document, modelNo='01', houseType='084.8513B', item='supply_area', page=5,
                basis='supply', unit='m2', m2='109.8102', check='confirmed')
    capture = ingest(request, fetch, evidence=[area], data_origin='collected')
    notice = capture['catalog']['notice']
    require(notice['status'] == 'reported' and len(notice['evidence']) == 1, '대상 공고의 행 위치 미확인')
    location = notice['evidence'][0]
    links = []
    for batch in capture['tradeBatches']:
        record = batch['record']
        require(record['status'] in ('complete', 'empty'), '수집하지 못한 실거래 페이지가 있습니다.')
        if record['source'] != 'apt_trade' or record['month'] != '2026-09':
            continue
        for row in batch['trades']:
            if row['contractDate'].get('date') == DAY and row['identifiers'].get('aptSeq') == '41290-455':
                pos = row['provenance']
                links.append(dict(source=record['source'], recordId=record['recordId'], page=pos['page'], position=pos['position'],
                                  identifiers=row['identifiers'], complexId=NEIGHBOR, exclusiveAreaM2='84.7450', supplyAreaM2='110.3239',
                                  evidence=proof('applyhome_notice_pdf', '2020001181:p7/2024930021:p5/2026930036:p5/A10024002')))
    require(len(links) == 1, '국토부 원행과 정규화한 위치 대조 실패')
    notice_binding = dict(source=notice['source'], page=location['page'], position=location['position'],
                          address=notice['fields']['HSSPLY_ADRES']['value'])
    evidence = dict(contractVersion='comparison-evidence/v1', dataOrigin='collected', regions=regions, complexes=complexes,
                    target=dict(target, notice=notice_binding, complexId=TARGET_COMPLEX, evidence=proof('applyhome_notice_pdf', '2024930022:p5/A10023264')),
                    scopes={'priority': dict(code=DONG, requestRegionCodes=[CITY], evidence=proof('mois_legal_region_codes', DONG)),
                            'expansion': dict(kind='municipality', code=CITY, requestRegionCodes=[CITY], evidence=proof('mois_legal_region_codes', CITY))},
                    tradeLinks=links)
    comparison = compare_snapshot(capture, {'modelNo': '01'}, evidence)
    candidates = comparison['comparables']
    require(len(candidates) == 1 and candidates[0]['complexId'] == NEIGHBOR and comparison['appliedScope'] == 'priority'
            and comparison['regionDecision']['expansion'] is None, '단지 선택 또는 적용 범위가 달라졌습니다.')
    bounds = comparison['conditions']['area']
    target_area, neighbor_area = Decimal('109.8102'), Decimal('110.3239')
    require(bounds['basis'] == 'supply' and Decimal(bounds['minM2']) == target_area * Decimal('0.95')
            and Decimal(bounds['maxM2']) == target_area * Decimal('1.05')
            and Decimal(candidates[0]['supplyAreaM2']) == neighbor_area
            and Decimal(candidates[0]['areaDifferenceM2']) == abs(neighbor_area - target_area),
            '원문에서 계산한 공급면적·범위와 엔진이 어긋났습니다.')
    stats = candidates[0]['tradeStats']['sale']
    require(all(stats[k] == v for k, v in price.items()), '수작업 가격·건수와 엔진이 어긋났습니다.')
    kinds = {k: v['conclusion'] for k, v in comparison['tradeKinds'].items()}
    if window == 'day':
        require(stats['status'] == 'confirmed' and comparison['rankingComplete'] and stats['smallSample']
                and kinds['presale_right'] == kinds['occupancy_right'] == 'normal_zero', '검증일 완전성 또는 권리 거래 판정이 달라졌습니다.')
    decision = comparison['regionDecision']['priority']
    population = independent_population(fetch, capture['period'], regions)
    require(population['priorityRows'] == price['count'] + decision['unresolvedRows'], '독립 집계와 우선 범위가 어긋났습니다.')
    return dict(window=capture['period']['source'], start=capture['period']['start'], end=capture['period']['end'],
                rawRows=sum(len(b['trades']) for b in capture['tradeBatches']), population=population, checkedSale=price,
                supplyAreaM2=candidates[0]['supplyAreaM2'], areaDifferenceM2=candidates[0]['areaDifferenceM2'],
                collectionStatus=decision['collectionStatus'], unresolved=decision['unresolvedRows'],
                priceStatus=stats['status'], rankingComplete=comparison['rankingComplete'], tradeKinds=kinds)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', required=True, help='공식 자료를 실제로 조회')
    parser.add_argument('--window', choices=('day', 'month', 'year', 'all'), default='day')
    args = parser.parse_args()
    key = os.environ.get('DATA_GO_KR_SERVICE_KEY')
    if not key:
        parser.error('DATA_GO_KR_SERVICE_KEY 환경변수가 필요합니다.')
    keys = {'DATA_GO_KR_SERVICE_KEY': key}
    specs = json.loads(SPECS.read_text(encoding='utf-8'))['probes']
    transport, download = LiveProbeTransport(specs, keys), make_live_fetch()
    pages, pdf_requests = {}, 0

    def fetch(source, scope, page, size):
        cache_key = source, tuple(sorted(scope.items())), page, size
        if cache_key not in pages:
            require(page == 1 and len(pages) < 36, '검수용 API 호출 범위를 넘었습니다.')
            pages[cache_key] = transport(source, scope, page, size)
        return pages[cache_key]

    def pdf_fetch(url, **options):
        nonlocal pdf_requests
        require(pdf_requests < 12, '검수용 원문 호출 범위를 넘었습니다.')
        pdf_requests += 1
        return download(url, **options)

    try:
        regions = official_regions()
        complexes = official_complexes(specs, keys)
        document = verified_documents(fetch, pdf_fetch)
        price = independent_day(fetch)
        windows = ('day', 'month', 'year') if args.window == 'all' else (args.window,)
        result = [run(window, fetch, regions, complexes, document, price) for window in windows]
    except EvidenceUnavailable as error:
        print(json.dumps({'status': 'held', 'reason': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    except (ValueError, KeyError, TypeError, ArithmeticError, OSError, RuntimeError, ElementTree.ParseError, zipfile.BadZipFile) as error:
        # 전송 예외 메시지에는 URL이 들어갈 수 있다. 원문·인증 정보와 분리한 실패 상태만 출력한다.
        print(json.dumps({'status': 'held', 'errorType': type(error).__name__}), file=sys.stderr)
        return 2
    print(json.dumps(result if args.window == 'all' else result[0], ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
