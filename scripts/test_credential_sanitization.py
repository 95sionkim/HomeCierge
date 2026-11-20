#!/usr/bin/env python3
"""F-11 인증값 정제 회귀 검사(독립 QA, 합성 자료 전용).

인증값·응답·거래는 모두 검사용 합성 값이며 실제 API 응답이나 매물이 아니다. 비밀파일·환경변수의
인증값을 읽지 않고 urllib 전송을 가로채며 소켓 연결은 차단한다. 산출물은 임시 폴더에만 쓴다.

기대 동작(PRD §12·리뷰 F-11·개발팀 BE-01에서 도출):
- 짧은 인증값이 JSON 키·숫자·XML 태그·정상 텍스트 일부와 같아도 응답 구조·값·상태·해시를 보존한다.
- 명시적 자격 필드·URL 매개변수·헤더 형식의 반향은 직접값·퍼센트(이중) 인코딩·JSON/XML 이스케이프
  형태 모두 저장 파일과 표준 출력에서 가린다.
- 정상 0건, HTTP 200 안의 업무 오류, 페이지 누락은 정제 후에도 서로 다른 상태로 남는다.
"""
import builtins
import contextlib
import hashlib
import html
import io
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request
import urllib.response
from email.message import Message
from pathlib import Path
from unittest import mock
from xml.sax.saxutils import escape as xml_escape

import collect_recent_trades
import import_api_response
import probe_apis
import validate_comparable_links

REAL_ROOT = Path(__file__).resolve().parents[1]
REAL_SECRETS = (REAL_ROOT / '.secrets').resolve()
PROBES_FILE = REAL_ROOT / 'docs' / 'api' / 'probes.json'
SPECS = json.loads(PROBES_FILE.read_text(encoding='utf-8'))['probes']
TRADE_URL = SPECS['apt_trade']['url']
CREDENTIAL_ENV = ('DATA_GO_KR_SERVICE_KEY', 'KAKAO_REST_API_KEY', 'LAW_OC',
                  'NAVER_API_CLIENT_ID', 'NAVER_API_CLIENT_SECRET', 'ODSAY_API_KEY')
NO_OVERLAP_KEY = 'QAnoOverlapKEYzz'
LONG_KEY = 'Zq9SYNTHxKEY/v+Ww=='  # 긴 합성 값은 8자 조각까지 남지 않아야 한다.
AUTH_NAMES = ('x-ncp-apigw-api-key-id', 'x-ncp-apigw-api-key', 'client_secret', 'authorization',
              'service_key', 'servicekey', 'client_id', 'api_key', 'apikey', 'oc')
# 해독한 산출물에서 `이름=값`, `"이름": "값"`, `<이름>값`, `이름: [KakaoAK ]값`의 값을 꺼낸다.
CONTEXT = re.compile(r'(?i)(?<![a-z0-9_-])(?:%s)(?:"?\s*[=:]\s*"?|>)\s*(?:(?:kakaoak|bearer|basic)\s+)?'
                     r'([^\s"\'<>&,;]*)' % '|'.join(map(re.escape, AUTH_NAMES)))


def decoded(text):
    """JSON \\uXXXX·\\/, XML 문자 참조, 퍼센트 이중 인코딩을 풀어 반향 형태와 무관하게 비교한다."""
    text = re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), text).replace('\\/', '/')
    return urllib.parse.unquote(urllib.parse.unquote(html.unescape(text)))


def trade_rows(count, start=0, apt='합성테스트아파트'):
    return [{'aptNm': apt, 'aptSeq': 'SYNTHETIC-%04d' % i, 'sggCd': '11215', 'umdCd': '10300', 'umdNm': '구의동',
             'jibun': '999-1', 'landCd': '1', 'bonbun': '0999', 'bubun': '0001', 'dealAmount': '48,000',
             'excluUseAr': '58.43', 'dealYear': '2026', 'dealMonth': '9', 'dealDay': str(10 + i), 'floor': '4',
             'buildYear': '2000', 'cdealType': '', 'cdealDay': ''} for i in range(start, start + count)]


def trade_json(rows, total, page=1, size=5, header=None, raw=None):
    """합성 실거래 JSON. raw는 자리표시자를 이스케이프된 원문 그대로 바꿔 넣는다."""
    text = json.dumps({'fixture_kind': 'synthetic', 'response': {
        'header': {'resultCode': '000', 'resultMsg': 'OK', **(header or {})},
        'body': {'items': {'item': rows}, 'numOfRows': size, 'pageNo': page, 'totalCount': total}}}, ensure_ascii=False)
    for placeholder, value in (raw or {}).items():
        text = text.replace('"%s"' % placeholder, '"%s"' % value)
    json.loads(text)
    return text


def trade_xml(rows, total, header=''):
    items = ''.join('<item>%s</item>' % ''.join('<%s>%s</%s>' % (k, xml_escape(v), k) for k, v in row.items())
                    for row in rows)
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<!-- 합성 응답: 실제 거래 아님 -->\n'
            '<response><header><resultCode>000</resultCode><resultMsg>OK</resultMsg>%s</header><body><items>%s'
            '</items><numOfRows>5</numOfRows><pageNo>1</pageNo><totalCount>%d</totalCount></body></response>'
            % (header, items, total))


def unicode_escaped(value):
    return ''.join('\\u%04x' % ord(c) for c in value)


def respond(body, status=200, content_type='application/json;charset=UTF-8'):
    headers = Message()
    headers['Content-Type'] = content_type
    data = io.BytesIO(body if isinstance(body, bytes) else body.encode('utf-8'))
    if status >= 400:
        raise urllib.error.HTTPError('https://synthetic.invalid/', status, 'synthetic', headers, data)
    return urllib.response.addinfourl(data, headers, 'https://synthetic.invalid/', status)


def query(request):
    return urllib.parse.parse_qs(urllib.parse.urlsplit(request.full_url).query, keep_blank_values=True)


def _blocked_network(*args, **kwargs):
    raise AssertionError('네트워크 차단: 합성 전송을 우회한 연결 시도')


def _guard_secrets(opener):
    def guarded(file, *args, **kwargs):
        if isinstance(file, (str, bytes, os.PathLike)):
            path = Path(os.fsdecode(file)).resolve()
            if path == REAL_SECRETS or REAL_SECRETS in path.parents:
                raise AssertionError('실제 비밀 폴더 접근 차단')
        return opener(file, *args, **kwargs)
    return guarded


class SyntheticEntryPoint(unittest.TestCase):
    """실제 main()을 임시 ROOT·합성 인증값·가로챈 전송으로 실행한다."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='hc-f11-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        (self.tmp / 'docs' / 'api').mkdir(parents=True)
        shutil.copyfile(PROBES_FILE, self.tmp / 'docs' / 'api' / 'probes.json')
        self.keys, self.calls, self.responder = {}, [], None
        patches = [mock.patch.object(socket.socket, 'connect', _blocked_network),
                   mock.patch.object(socket, 'create_connection', _blocked_network),
                   mock.patch.object(socket, 'getaddrinfo', _blocked_network),
                   mock.patch.object(urllib.request.OpenerDirector, 'open', self._intercept),
                   mock.patch.object(io, 'open', _guard_secrets(io.open)),
                   mock.patch.object(builtins, 'open', _guard_secrets(builtins.open)),
                   mock.patch.dict(os.environ)]
        for module in (probe_apis, import_api_response, collect_recent_trades):
            patches += [mock.patch.object(module, 'ROOT', self.tmp),
                        mock.patch.object(module, 'read_keys', lambda: dict(self.keys))]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        for name in CREDENTIAL_ENV:
            os.environ.pop(name, None)

    def _intercept(self, request, data=None, timeout=None):
        self.calls.append(request)
        return self.responder(request)

    def run_main(self, module, argv):
        evidence = self.tmp / 'api-evidence'
        shutil.rmtree(evidence, ignore_errors=True)
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, 'argv', [module.__name__] + argv), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = module.main()
            except SystemExit as exc:
                code = exc.code
        outputs = {'stdout': out.getvalue(), 'stderr': err.getvalue()}
        for path in sorted(evidence.rglob('*')) if evidence.exists() else []:
            if path.is_file():
                outputs[path.relative_to(evidence).as_posix()] = path.read_text(encoding='utf-8', errors='replace')
        return code, outputs

    def probe(self, name, keys, responder):
        self.keys, self.responder = keys, responder
        code, outputs = self.run_main(probe_apis, ['--probe', name])
        pick = lambda pattern: next((v for k, v in outputs.items() if re.search(pattern, k)), None)
        parsed = pick(r'/parsed\.json$')
        return {'code': code, 'outputs': outputs, 'result': json.loads(pick(r'/result\.json$')),
                'raw': pick(r'/response\.\w+$'), 'parsed': json.loads(parsed) if parsed else None}

    def assert_no_context_leak(self, outputs, secrets):
        for name, text in outputs.items():
            for value in CONTEXT.findall(decoded(text)):
                for secret in secrets:
                    self.assertNotIn(secret, value, '%s: 자격 문맥에 합성 인증값 반향이 남음' % name)

    def assert_no_long_key(self, outputs):
        pieces = {LONG_KEY[i:i + 8] for i in range(len(LONG_KEY) - 7)}
        for name, text in outputs.items():
            self.assertEqual(sorted(p for p in pieces if p in decoded(text)), [], '%s: 긴 합성 인증값 조각이 남음' % name)

    def assert_success(self, run, records):
        self.assertEqual((run['code'], run['result']['status'], run['result'].get('record_count')), (0, 'success', records))


class ProbeEntryPointTests(SyntheticEntryPoint):
    OBSERVED = ('status', 'format', 'http_status', 'record_count', 'field_coverage', 'reported_counts')

    def test_short_key_overlapping_structure_keeps_response_and_hashes(self):
        """반향이 없으면 겹치는 짧은 키도 겹치지 않는 키와 같은 상태·원문·해석·해시를 남긴다."""
        cases = [('json_key', 'item', trade_json(trade_rows(5), 5)),
                 ('json_numbers', '5', trade_json(trade_rows(5), 5)),
                 ('xml_tag', 'item', trade_xml(trade_rows(5), 5)),
                 ('normal_text', 'Park', trade_json(trade_rows(5, apt='SyntheticParkView'), 5))]
        for case, key, body in cases:
            with self.subTest(case=case):
                base = self.probe('apt_trade', {'DATA_GO_KR_SERVICE_KEY': NO_OVERLAP_KEY}, lambda r: respond(body))
                run = self.probe('apt_trade', {'DATA_GO_KR_SERVICE_KEY': key}, lambda r: respond(body))
                self.assertEqual(query(self.calls[-1])['serviceKey'], [key])
                self.assert_success(run, 5)
                self.assertEqual({k: run['result'].get(k) for k in self.OBSERVED},
                                 {k: base['result'].get(k) for k in self.OBSERVED})
                self.assertEqual(run['result']['request_params'], SPECS['apt_trade']['params'])
                self.assertEqual(run['raw'], body)
                self.assertEqual(run['parsed'], probe_apis.parse_payload(body.encode('utf-8'))[1])
                digest = hashlib.sha256(body.encode('utf-8')).hexdigest()
                self.assertEqual((run['result']['response_sha256'], run['result']['sanitized_response_sha256']),
                                 (digest, digest))

    def test_normal_url_parameter_ending_in_oc_is_not_credential(self):
        link = 'https://news.example.invalid/article?doc=20261120&page=1'
        body = json.dumps({'fixture_kind': 'synthetic', 'total': 1, 'start': 1, 'display': 1, 'items': [{
            'title': '합성 기사', 'originallink': link, 'link': link, 'description': '합성 발췌',
            'pubDate': 'Fri, 20 Nov 2026 09:00:00 +0900'}]}, ensure_ascii=False)
        run = self.probe('news_search', {'NAVER_API_CLIENT_ID': 'QAsynthNaverID01',
                                         'NAVER_API_CLIENT_SECRET': 'QAsynthNaverSecret01'}, lambda r: respond(body))
        self.assert_success(run, 1)
        self.assertEqual((run['parsed']['items'][0]['originallink'], run['raw']), (link, body))

    def test_short_law_oc_overlapping_text_is_redacted_only_in_detail_link(self):
        """짧은 OC가 호스트·target 값·JSON 키(law)와 같아도 상세링크의 OC 값만 가린다."""
        tail = '&target=eflaw&MST=90000%d&type=HTML&mobileYn=&efYd=20261101'
        records = [{'법령명한글': '주택공급에 관한 규칙', '법령ID': '009999', '시행일자': '20261101', '공포일자': '20261001',
                    '법령일련번호': '90000%d' % n, '현행연혁코드': '시행예정', '법령상세링크': '@@LINK%d@@' % n} for n in (1, 2)]
        body = json.dumps({'fixture_kind': 'synthetic', 'LawSearch': {
            'target': 'eflaw', '키워드': '주택공급에 관한 규칙', 'totalCnt': '2', 'page': '1', 'law': records}},
            ensure_ascii=False)
        body = body.replace('"@@LINK1@@"', '"/DRF/lawService.do?OC=law%s"' % (tail % 1)).replace(
            '"@@LINK2@@"', '"\\/DRF\\/lawService.do?OC=%s%s"' % (unicode_escaped('law'), tail % 2))
        run = self.probe('law_search', {'LAW_OC': 'law'}, lambda r: respond(body))
        self.assertEqual(query(self.calls[-1])['OC'], ['law'])
        self.assert_success(run, 2)
        self.assertEqual((run['result']['endpoint'], run['result']['request_params']['target']),
                         (SPECS['law_search']['url'], 'eflaw'))
        for saved in (run['parsed'], json.loads(run['raw'])):
            self.assertEqual(saved['LawSearch']['target'], 'eflaw')
            for n, record in enumerate(saved['LawSearch']['law'], 1):
                link = urllib.parse.urlsplit(record['법령상세링크'])
                params = urllib.parse.parse_qs(link.query, keep_blank_values=True)
                self.assertEqual((link.path, params['target'], params['MST']), ('/DRF/lawService.do', ['eflaw'], ['90000%d' % n]))
                self.assertNotEqual(params.get('OC'), ['law'])
        self.assert_no_context_leak(run['outputs'], ['law'])

    def test_escaped_encoded_and_explicit_credential_echo_is_not_persisted(self):
        """JSON \\/·\\u 이스케이프, 퍼센트·이중·+ 인코딩, 명시적 serviceKey 필드의 반향을 모두 가린다."""
        quote = lambda value: urllib.parse.quote(value, safe='')
        url = (TRADE_URL + '?serviceKey=' + quote(LONG_KEY) + '&pageNo=1').replace('/', '\\/')
        body = trade_json(trade_rows(5), 5, header={
            'requestUrl': '@URL', 'serviceKey': '@FIELD', 'echo': '@UNICODE',
            'doubleEncoded': 'serviceKey=' + quote(quote(LONG_KEY)), 'plusEncoded': 'serviceKey=' + urllib.parse.quote_plus(LONG_KEY)},
            raw={'@URL': url, '@FIELD': LONG_KEY.replace('/', '\\/'), '@UNICODE': unicode_escaped(LONG_KEY)})
        run = self.probe('apt_trade', {'DATA_GO_KR_SERVICE_KEY': quote(LONG_KEY)}, lambda r: respond(body))
        self.assertEqual(query(self.calls[-1])['serviceKey'], [LONG_KEY])
        self.assert_success(run, 5)
        self.assertEqual(run['parsed']['response']['body']['items']['item'], trade_rows(5))
        self.assert_no_long_key(run['outputs'])

    def test_long_credential_echoed_as_json_object_key_is_not_persisted(self):
        """긴 인증값이 JSON 객체 키로 되돌아와도 저장하지 않는다. 가린 사본 저장·저장 거부 모두 허용한다."""
        body = trade_json(trade_rows(1), 1, header={'rejectedCredentials': {LONG_KEY: 'rejected'}})
        run = self.probe('apt_trade', {'DATA_GO_KR_SERVICE_KEY': LONG_KEY}, lambda r: respond(body))
        self.assert_no_long_key(run['outputs'])

    def test_short_credential_as_standalone_value_in_unknown_field_is_not_persisted(self):
        """짧은 인증값이 미확인 일반 필드의 독립된 값으로 반향되면 가린 사본 저장 또는 저장 보류만 허용한다."""
        cases = [('json', trade_json(trade_rows(1), 1, header={'echoedValue': 'q7Zk'}), 'application/json'),
                 ('xml', trade_xml(trade_rows(1), 1, '<echoedValue>q7Zk</echoedValue>'), 'text/xml')]
        for case, body, content_type in cases:
            with self.subTest(case=case):
                run = self.probe('apt_trade', {'DATA_GO_KR_SERVICE_KEY': 'q7Zk'}, lambda r: respond(body, content_type=content_type))
                for name, text in run['outputs'].items():
                    self.assertNotIn('q7Zk', decoded(text), '%s: 미확인 필드에서 반향된 합성 값이 남음' % name)
                if run['raw'] is not None:  # 가린 사본을 저장했다면 업무 행은 보존한다.
                    self.assert_success(run, 1)
                    items = run['parsed']['response']['body']['items']['item']
                    self.assertEqual(items if isinstance(items, list) else [items], trade_rows(1))

    def test_invalid_utf8_response_is_not_collected_and_body_is_not_stored(self):
        body = trade_json(trade_rows(1), 1).encode('utf-8').replace('합성테스트아파트'.encode('utf-8'), b'\xff\xfe\xfd', 1)
        run = self.probe('apt_trade', {'DATA_GO_KR_SERVICE_KEY': LONG_KEY}, lambda r: respond(body))
        self.assertNotEqual(run['code'], 0)
        self.assertNotIn(run['result']['status'], ('success', 'success_empty'))
        self.assertEqual([k for k in run['outputs'] if re.search(r'/(response\.\w+|parsed\.json)$', k)], [])

    def test_unpaired_unicode_escape_has_no_partial_evidence_files(self):
        body = trade_json(trade_rows(1), 1, header={'note': '@UNICODE'}, raw={'@UNICODE': r'\ud800'})
        run = self.probe('apt_trade', {'DATA_GO_KR_SERVICE_KEY': LONG_KEY}, lambda r: respond(body))
        self.assertEqual(run['result']['status'], 'parse_error')
        self.assertIsNone(run['raw'])
        self.assertIsNone(run['parsed'])

    def test_withheld_error_body_does_not_reappear_in_result_metadata(self):
        body = json.dumps({'error': {'unknownValue': 'q7Zk'}, 'fixture_kind': 'synthetic'})
        run = self.probe('kakao_address', {'KAKAO_REST_API_KEY': 'q7Zk'}, lambda r: respond(body, 401))
        self.assertEqual(run['result']['status'], 'redaction_failed')
        self.assertEqual(run['result']['interpreted_status'], 'api_error')
        self.assertNotIn('api_error', run['result'])
        for output in run['outputs'].values():
            self.assertNotIn('q7Zk', decoded(output))

    def test_xml_character_reference_echo_is_not_persisted(self):
        entity = LONG_KEY.replace('/', '&#x2F;').replace('+', '&#43;').replace('=', '&#x3D;')
        body = trade_xml(trade_rows(5), 5, '<serviceKey>%s</serviceKey><requestUrl>%s?serviceKey=%s&amp;pageNo=1'
                                           '</requestUrl>' % (entity, TRADE_URL, entity))
        run = self.probe('apt_trade', {'DATA_GO_KR_SERVICE_KEY': LONG_KEY}, lambda r: respond(body, content_type='text/xml'))
        self.assert_success(run, 5)
        self.assertEqual(run['parsed']['response']['body']['items']['item'], trade_rows(5))
        self.assert_no_long_key(run['outputs'])

    def test_short_header_credentials_echoed_in_body_are_redacted(self):
        kakao = json.dumps({'fixture_kind': 'synthetic', 'errorType': 'AccessDeniedError',
                            'message': 'synthetic echo Authorization: KakaoAK ka9 not allowed'})
        run = self.probe('kakao_address', {'KAKAO_REST_API_KEY': 'ka9'}, lambda r: respond(kakao, status=401))
        self.assertEqual(self.calls[-1].get_header('Authorization'), 'KakaoAK ka9')
        self.assertEqual((run['result']['status'], run['result']['http_status']), ('api_error', 401))
        self.assert_no_context_leak(run['outputs'], ['ka9'])
        naver = json.dumps({'fixture_kind': 'synthetic', 'errorCode': '024',
                            'detail': 'X-NCP-APIGW-API-KEY-ID: nv5\nX-NCP-APIGW-API-KEY: ns7'})
        run = self.probe('news_search', {'NAVER_API_CLIENT_ID': 'nv5', 'NAVER_API_CLIENT_SECRET': 'ns7'},
                         lambda r: respond(naver, status=401))
        self.assertEqual(self.calls[-1].get_header('X-ncp-apigw-api-key'), 'ns7')
        self.assertEqual(run['result']['status'], 'api_error')
        self.assert_no_context_leak(run['outputs'], ['nv5', 'ns7'])

    def test_error_paths_are_sanitized_without_breaking_result_keys(self):
        """전송 오류 문구와 HTTP 오류 본문의 반향을 가리되, 같은 이름의 결과 키(status)는 보존한다."""
        def fail(request):
            raise urllib.error.URLError('synthetic resolver failure for ' + request.full_url)
        run = self.probe('apt_trade', {'DATA_GO_KR_SERVICE_KEY': 'status'}, fail)
        self.assertEqual((run['code'], run['result']['status'], json.loads(run['outputs']['stdout'])['status']),
                         (1, 'network_error', 'network_error'))
        self.assertIn('error', run['result'])
        self.assert_no_context_leak(run['outputs'], ['status'])
        body = ('<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>synthetic echo '
                'serviceKey=%s</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader>'
                '</OpenAPI_ServiceResponse>' % urllib.parse.quote_plus(LONG_KEY))
        run = self.probe('apt_trade', {'DATA_GO_KR_SERVICE_KEY': LONG_KEY}, lambda r: respond(body, 500, 'text/xml'))
        self.assertEqual((run['result']['status'], run['result']['http_status'], str(run['result']['api_error']['code'])),
                         ('api_error', 500, '30'))
        self.assert_no_long_key(run['outputs'])

    def test_normal_zero_and_http_200_business_error_stay_distinct_with_overlapping_keys(self):
        zero = json.dumps({'fixture_kind': 'synthetic', 'response': {
            'header': {'resultCode': '00', 'resultMsg': 'NORMAL SERVICE.'},
            'body': {'items': '', 'numOfRows': 10, 'pageNo': 1, 'totalCount': 0}}})
        run = self.probe('apt_trade', {'DATA_GO_KR_SERVICE_KEY': '00'}, lambda r: respond(zero))
        self.assertEqual((run['code'], run['result']['status'], run['result'].get('record_count')), (0, 'success_empty', 0))
        self.assertNotIn('api_error', run['result'])
        error = ('<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>'
                 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode>'
                 '</cmmMsgHeader></OpenAPI_ServiceResponse>')
        run = self.probe('apt_trade', {'DATA_GO_KR_SERVICE_KEY': '30'}, lambda r: respond(error, content_type='text/xml'))
        self.assertEqual((run['code'], run['result']['status'], run['result']['http_status']), (1, 'api_error', 200))
        self.assertEqual((str(run['result']['api_error']['code']), run['raw']), ('30', error))


class ImportEntryPointTests(SyntheticEntryPoint):
    def import_file(self, key, body, suffix):
        source = self.tmp / ('synthetic' + suffix)
        source.write_text(body, encoding='utf-8')
        self.keys = {'DATA_GO_KR_SERVICE_KEY': key}
        code, outputs = self.run_main(import_api_response, ['--probe', 'apt_trade', '--input', str(source), '--label', 'qa_synthetic'])
        saved = lambda name: json.loads(next(v for k, v in outputs.items() if k.endswith('/' + name)))
        return code, outputs, saved('result.json'), saved('parsed.json')

    def test_import_keeps_json_records_and_redacts_url_echo_for_key_matching_json_key(self):
        body = trade_json(trade_rows(5), 5, header={'requestUrl': TRADE_URL + '?serviceKey=item&pageNo=1'})
        code, outputs, result, parsed = self.import_file('item', body, '.json')
        self.assertEqual((code, result['status'], result.get('record_count')), (0, 'success', 5))
        self.assertEqual(parsed['response']['body']['items']['item'], trade_rows(5))
        self.assertTrue(result['all_matching_rows_in_snapshot'])
        self.assertEqual(json.loads(outputs['stdout']), {'label': 'qa_synthetic', 'status': 'success', 'records': 5})
        self.assert_no_context_leak(outputs, ['item'])

    def test_import_xml_key_equal_to_result_code_is_not_api_error(self):
        body = trade_xml(trade_rows(5), 5, '<requestUrl>%s?serviceKey=000&amp;pageNo=1</requestUrl>' % TRADE_URL)
        code, outputs, result, parsed = self.import_file('000', body, '.xml')
        self.assertEqual((code, result['status'], result['format'], result.get('record_count')), (0, 'success', 'xml', 5))
        self.assertEqual(parsed['response']['header']['resultCode'], '000')
        self.assertEqual([r['dealAmount'] for r in parsed['response']['body']['items']['item']], ['48,000'] * 5)
        self.assert_no_context_leak(outputs, ['000'])


class CollectEntryPointTests(SyntheticEntryPoint):
    ARGS = ['--probe', 'apt_trade', '--lawd-cd', '11215', '--start', '202609', '--end', '202609', '--page-size', '3']

    def test_saved_collection_with_withheld_and_unattempted_months_can_be_read(self):
        self.keys = {'DATA_GO_KR_SERVICE_KEY': 'q7Zk'}
        body = trade_json(trade_rows(1), 1, header={'unknownValue': 'q7Zk'})
        self.responder = lambda request: respond(body)
        args = ['--probe', 'apt_trade', '--lawd-cd', '11215', '--start', '202609', '--end', '202610']
        code, outputs = self.run_main(collect_recent_trades, args)
        self.assertEqual(code, 1)
        directory = Path(json.loads(outputs['stdout'])['evidence_directory'])
        summary, rows, checks = validate_comparable_links.load_collection(directory)
        self.assertEqual(summary['unattempted_months'], ['202610'])
        self.assertEqual(rows, [])
        self.assertEqual({c['check'] for c in checks if not c['passed']}, {'202609:complete', '202610:complete'})

    def collect(self, key, failing_page=None):
        def responder(request):
            params = query(request)
            page = int(params['pageNo'][0])
            if page == failing_page:
                raise urllib.error.URLError('synthetic timeout for ' + request.full_url)
            echo = TRADE_URL + '?serviceKey=' + urllib.parse.quote_plus(params['serviceKey'][0])
            return respond(trade_json(trade_rows(3, start=(page - 1) * 3), 6, page, 3, {'requestUrl': echo}))
        self.keys, self.responder = {'DATA_GO_KR_SERVICE_KEY': key}, responder
        code, outputs = self.run_main(collect_recent_trades, self.ARGS)
        saved = lambda suffix: json.loads(next(v for k, v in outputs.items() if k.endswith(suffix)))
        return code, outputs, saved('/summary.json'), saved('/202609/normalized.json')

    def test_complete_collection_with_key_matching_json_key(self):
        code, outputs, summary, normalized = self.collect('item')
        self.assertEqual([query(c)['pageNo'] for c in self.calls], [['1'], ['2']])
        self.assertEqual((code, summary['complete'], summary['ready_for_matching']), (0, True, True))
        month = summary['months'][0]
        self.assertEqual((month['collected'], month['reported_total'], month['pages'], month['problems']), (6, 6, [1, 2], []))
        self.assertEqual([(r['price_krw'], r['raw']) for r in normalized], [(480000000, row) for row in trade_rows(6)])
        self.assert_no_context_leak(outputs, ['item'])

    def test_missing_page_stays_incomplete_and_error_is_sanitized(self):
        code, outputs, summary, normalized = self.collect(LONG_KEY, failing_page=2)
        month = summary['months'][0]
        self.assertEqual((code, summary['complete'], summary['ready_for_matching'], month['complete']), (1, False, False, False))
        self.assertIn('network_error', month['problems'])
        self.assertEqual((month['collected'], month['reported_total'], len(normalized)), (3, 6, 3))
        self.assert_no_long_key(outputs)


if __name__ == '__main__':
    unittest.main()
