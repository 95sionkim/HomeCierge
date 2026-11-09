#!/usr/bin/env python3
"""법령·교통·뉴스의 저장된 실응답과 실패 응답을 재검증한다. 외부 호출·인증값 읽기는 하지 않는다."""
import hashlib
import html
import json
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

from probe_apis import ROOT, api_error, field_coverage, parse_payload, records_for, response_status


def read(path):
    return json.loads(path.read_text())


def main():
    if not (ROOT / 'api-evidence/20261109T064211210287Z_law_search/result.json').exists():
        raise SystemExit('역사적 실응답 증거는 별도 로컬 자료입니다. docs/api/README.md의 재현 범위를 확인하세요.')
    manifest = read(ROOT / 'docs/api/live-manifest-20261109.json')
    specs = read(ROOT / 'docs/api/probes.json')['probes']
    checks, captures = [], {}

    def check(name, passed, detail=None):
        checks.append({'check': name, 'passed': bool(passed), 'detail': detail})

    for item in manifest['captures']:
        base = ROOT / item['path']
        result = read(base / 'result.json')
        raw = (base / ('response.' + result['format'])).read_bytes()
        fmt, payload = parse_payload(raw)
        spec = specs[item['probe']]
        rows = records_for(payload, spec['records'])
        label = item['label']
        check(label + ':sanitized_hash', hashlib.sha256(raw).hexdigest() == result['sanitized_response_sha256'])
        check(label + ':parsed_matches_raw', fmt == result['format'] and payload == read(base / 'parsed.json'))
        check(label + ':http_and_transport', result['http_status'] == 200 and result['transport'] == 'python_urllib')
        check(label + ':expected_status', result['status'] == item['expected_status'])
        if item['expected_status'] == 'success':
            check(label + ':recognized_response', api_error(payload) is None and response_status(payload, spec) == 'success')
            check(label + ':count_and_fields', len(rows) == result['record_count'] and field_coverage(rows, spec['fields']) == result['field_coverage'])
        else:
            check(label + ':error_not_success', api_error(payload) is not None and not rows)
        captures[label] = {'result': result, 'data': payload, 'rows': rows}

    lists = [captures[k]['data']['LawSearch'] for k in ['law_list_page1', 'law_list_page2']]
    law_rows = [r for page in lists for r in page['law']]
    check('law:complete_pages', [int(p['page']) for p in lists] == [1, 2] and len(law_rows) == int(lists[0]['totalCnt']) == int(lists[1]['totalCnt']))
    check('law:unique_version_records', len({(r['법령일련번호'], r['시행일자']) for r in law_rows}) == len(law_rows))
    cutoff = manifest['reference_announcement_date'].replace('-', '')
    eligible = [r for r in law_rows if r['법령명한글'] == '주택공급에 관한 규칙' and r['시행일자'] <= cutoff and r['공포일자'] <= cutoff]
    latest_effective = max(r['시행일자'] for r in eligible)
    latest = [r for r in eligible if r['시행일자'] == latest_effective]
    check('law:unambiguous_as_of_version', len(latest) == 1)
    selected = latest[0]
    body = captures['law_body']['data']['법령']
    basic = body['기본정보']
    params = captures['law_body']['result']['request_params']
    check('law:requested_mst_and_effective_date', params.get('MST') == selected['법령일련번호'] and params.get('efYd') == selected['시행일자'] and not params.get('ID'))
    check('law:body_identity', basic['법령명_한글'] == selected['법령명한글'] and basic['법령ID'] == selected['법령ID'] and basic['시행일자'] == selected['시행일자'] and basic['공포일자'] == selected['공포일자'])
    articles = body['조문']['조문단위']
    supplements = body['부칙']['부칙단위']
    appendices = body['별표']['별표단위']
    check('law:articles_supplements_appendices', bool(articles) and bool(supplements) and bool(appendices))
    nesting = {'항': 0, '호': 0, '목': 0}

    def walk(value):
        if isinstance(value, dict):
            for k, v in value.items():
                if k in nesting:
                    nesting[k] += len(v) if isinstance(v, list) else 1
                walk(v)
        elif isinstance(value, list):
            for v in value:
                walk(v)
    walk(body['조문'])
    check('law:nested_clause_levels', all(nesting.values()))
    check('law:appendix_links_preserved', all(any(row.get(k) for k in ['별표서식파일링크', '별표서식PDF파일링크', '별표서식이미지파일링크']) for row in appendices))

    routes = captures['transit']['rows']
    check('transit:multiple_routes', len(routes) > 0)
    for index, row in enumerate(routes):
        info = row['info']
        check(f'transit:{index}:numeric_summary', isinstance(info['totalTime'], (int, float)) and info['totalTime'] > 0 and all(isinstance(info[k], (int, float)) and info[k] >= 0 for k in ['totalWalk', 'payment', 'busTransitCount', 'subwayTransitCount']))
        check(f'transit:{index}:segments', bool(row['subPath']) and all(s['trafficType'] in [1, 2, 3] for s in row['subPath']))
    negative = captures['transit_same_point']['data']
    check('transit:near_route_error', str(negative['error']['code']) == '-98' and 'result' not in negative)
    walk_unknown = sum(r['info'].get('totalWalkTime') == -1 for r in routes)

    news = captures['news']['data']
    check('news:requested_page_count', len(news['items']) == news['display'] == 3 and news['start'] == 1 and news['total'] >= 3)
    normalized_news, dates = [], []
    for index, row in enumerate(news['items']):
        pub_date = parsedate_to_datetime(row['pubDate'])
        dates.append(pub_date)
        check(f'news:{index}:timezone_and_links', pub_date.tzinfo is not None and all(urlsplit(row[k]).scheme in {'http', 'https'} and urlsplit(row[k]).netloc for k in ['originallink', 'link']))
        title = html.unescape(re.sub(r'<[^>]*>', '', row['title']))
        description = html.unescape(re.sub(r'<[^>]*>', '', row['description']))
        check(f'news:{index}:title_and_excerpt', bool(title.strip()) and bool(description.strip()))
        normalized_news.append({'title': title, 'excerpt': description, 'original_url': row['originallink'], 'provided_at': pub_date.isoformat(), 'content_scope': 'search_excerpt_not_full_article'})
    check('news:descending_dates', dates == sorted(dates, reverse=True))
    check('news:distinct_original_urls', len({r['originallink'] for r in news['items']}) == len(news['items']))
    report = {
        'validated_at': datetime.now(timezone.utc).isoformat(),
        'scope': '저장된 실제 3서비스·4조회와 교통 오류 응답 재검증',
        'captures': manifest['captures'], 'checks_total': len(checks), 'checks_passed': sum(c['passed'] for c in checks),
        'failed_checks': [c for c in checks if not c['passed']], 'checks': checks,
        'law': {'list_records': len(law_rows), 'exact_title_as_of_candidates': len(eligible), 'mst': selected['법령일련번호'], 'effective_date': selected['시행일자'], 'article_units': len(articles), 'supplement_units': len(supplements), 'appendix_units': len(appendices), 'nesting': nesting, 'application_note': '시행 버전과 문서 구조를 확인했다. 개별 조항·경과규정의 적용과 개인 자격을 판정하지 않았다.'},
        'transit': {'routes': len(routes), 'same_point_error_code': '-98', 'unknown_total_walk_time_minus_one': walk_unknown, 'note': 'totalWalkTime=-1은 도보시간 미제공 상태로 보존. 이 값으로 음수 시간이나 0분을 출력하지 않음.'},
        'news': {'items': len(normalized_news), 'unique_original_urls': len({r['originallink'] for r in news['items']}), 'normalized': normalized_news, 'note': '본문 수집·LLM 요약·사실성/지역 적합성 평가는 미실시.'},
        'limitations': ['별표 링크 확보와 첨부 파일 전문 검토는 별도', 'ODsay는 등록된 호출 환경과 무료 개발 범위에서만 실험', '법령과 ODsay 인증값 교체 후 정상·오류 실응답 재검증 완료', '배포 환경의 IP·이용 조건·저장/재사용 허용 범위는 운영 전에 별도 확인'],
    }
    destination = ROOT / 'api-evidence/20261109_additional_services'
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ['checks_total', 'checks_passed', 'failed_checks', 'law', 'transit']}, ensure_ascii=False))
    return 0 if not report['failed_checks'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
