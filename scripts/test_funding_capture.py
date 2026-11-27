"""합성 PDF의 BE-07 납부 일정을 수집 작업자의 RPC 요청까지 확인한다."""
import hashlib
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch
from uuid import uuid4

from ingestion_pages import ReplayTransport, loads_source_json
from replay_ingestion import replay
from review_notice_documents import main
from store_ingestion import save_snapshot
from test_notice_payment_schedules import _contract_date
from test_notice_pdf_fields import FIXTURE, HAS_FITZ, build_synthetic_notice_pdf, synthetic_notice_spec


NUMBERS = 'houseManageNo=9900000001&pblancNo=9900000042'
DETAIL_URL = 'https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?' + NUMBERS
ATTACHMENT_BASE = ('https://static.applyhome.co.kr/ai/aia/getAtchmnfl.do?' + NUMBERS
                   + '&atchmnflSeqNo=5555&atchmnflSn=')
ATTACHMENT_URL = ATTACHMENT_BASE + '1'


def _pdf_responses(bundle, variant):
    spec = synthetic_notice_spec()
    _contract_date(spec)
    spec['tables']['price']['cells'][1][7:9] = ['계약 시 (‘26.10.27.)', '2026.12.01.~2026.12.07.']
    spec['tables']['options']['cells'][1][6] = '추후 안내'
    if variant == 'house-type-conflict':
        spec['tables']['area']['cells'][2][3] = '085.0000B'
    attachments = [(ATTACHMENT_URL, '모집공고문 보기', build_synthetic_notice_pdf(spec))]
    if variant == 'revision-type-conflict':
        spec['tables']['area']['cells'][2][3] = '085.0000B'
        attachments.append((ATTACHMENT_BASE + '2', '정정공고문', build_synthetic_notice_pdf(spec)))
    html = ''.join(f'<a href="{url.replace("&", "&amp;")}">{label}</a>' for url, label, _ in attachments)
    responses = {url: ('application/pdf', pdf) for url, _, pdf in attachments}
    responses[DETAIL_URL] = ('text/html; charset=utf-8', html.encode())
    bundle['pages'][0]['body']['data'][0]['PBLANC_URL'] = DETAIL_URL
    return responses


def _fetch_pdf_response(responses, url):
    mime, content = responses[url]
    return {'status': 200, 'headers': {'content-type': mime}, 'body': content}


def synthetic_funding_payload(variant):
    """로컬 SQL 통합 검사에 쓸 정상 저장 워커의 합성 RPC 요청을 만든다."""
    if variant not in ('normal', 'house-type-conflict', 'revision-type-conflict'):
        raise ValueError('지원하는 합성 PDF 유형을 지정하세요.')
    case = FundingCaptureTests()
    case.setUp()
    case.ids[2] = str(uuid4())
    responses = _pdf_responses(case.bundle, variant)

    def fetch(url, *, max_bytes, timeout):
        return _fetch_pdf_response(responses, url)

    case.opener.open.return_value = case.response()
    case.run_worker(fetch, save=True)
    outgoing = case.opener.open.call_args.args[0]
    return json.loads(outgoing.data)


class FundingCaptureTests(unittest.TestCase):
    def setUp(self):
        self.bundle = loads_source_json(FIXTURE.read_text(encoding='utf-8'))
        self.inputs = self.bundle['request']
        self.env = {'SUPABASE_URL': 'http://127.0.0.1:54321', 'SUPABASE_WORKER_KEY': 'sb_secret_synthetic'}
        self.ids = ['10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002',
                    '10000000-0000-0000-0000-000000000003']
        self.snapshot_id = '10000000-0000-0000-0000-000000000004'
        self.opener = Mock()

    def response(self):
        return io.BytesIO(json.dumps(self.snapshot_id).encode())

    def run_worker(self, fetch, *, save):
        transport = ReplayTransport(self.bundle)
        stdout = io.StringIO()
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / 'synthetic-request.json'
            input_path.write_text(json.dumps(self.inputs), encoding='utf-8')
            args = ['worker', '--live', '--request', str(input_path)]
            if save:
                owner_id, analysis_id, capture_key = self.ids
                args.extend(['--save', '--owner-id', owner_id, '--analysis-id', analysis_id, '--capture-key', capture_key])
            with patch('sys.argv', args), redirect_stdout(stdout), patch.dict('os.environ', self.env, clear=True), \
                    patch('review_notice_documents.live_api_transport', return_value=transport), \
                    patch('notice_document_review.make_live_fetch', return_value=fetch), \
                    patch('worker_rpc.request.build_opener', return_value=self.opener):
                self.assertEqual(main(), 0)
        return json.loads(stdout.getvalue()), transport

    def test_omitted_schedules_use_legacy_rpc_and_empty_schedules_use_atomic_rpc(self):
        result = replay(self.bundle)
        self.opener.open.side_effect = [self.response(), self.response()]
        for options in ({}, {'payment_schedules': []}):
            self.assertEqual(save_snapshot(*self.ids, self.inputs, result, env=self.env,
                                           opener=self.opener, **options), self.snapshot_id)
        legacy, funding = [call.args[0] for call in self.opener.open.call_args_list]
        self.assertTrue(legacy.full_url.endswith('/rest/v1/rpc/save_ingestion_snapshot'))
        self.assertTrue(funding.full_url.endswith('/rest/v1/rpc/save_funding_schedule_snapshot'))
        self.assertNotIn('p_schedules', json.loads(legacy.data))
        self.assertEqual(json.loads(funding.data), dict(json.loads(legacy.data), p_schedules=[]))

    def test_capture_projects_nested_schedule_fields(self):
        reference = {'document': 'synthetic-notice', 'version': 'synthetic-v1', 'page': 2}
        timing = {'trigger': 'contract_signing', 'dateStatus': 'exact', 'date': '2026-10-27', 'evidence': [reference]}
        schedule = {'modelNo': '01', 'houseType': '084.0000A', 'room': '101동 101호', 'item': 'sale_price',
                    'status': 'confirmed', 'totalWon': '700000000', 'reasons': []}
        evidence = [dict(reference, url='https://synthetic.invalid/original.pdf')]
        installment = {'stage': 'deposit', 'won': '700000000',
                       'timing': dict(timing, text='2026.10.27.', rawPdf=b'%PDF synthetic', evidence=evidence)}
        supplied = dict(schedule, installments=[dict(installment, unexpected='discard')],
                        evidence=evidence, sourceUrl='https://synthetic.invalid/notice')
        self.opener.open.return_value = self.response()
        save_snapshot(*self.ids, self.inputs, replay(self.bundle), env=self.env, opener=self.opener,
                      payment_schedules=[supplied])
        payload = json.loads(self.opener.open.call_args.args[0].data)
        self.assertEqual(payload['p_schedules'], [dict(schedule, evidence=[reference], installments=[
            {'stage': 'deposit', 'won': '700000000', 'timing': timing}])])
        self.assertEqual(supplied['installments'][0]['timing']['text'], '2026.10.27.')

    def test_capture_rejects_nested_content_in_scalar_fields_before_sending(self):
        schedule = {'modelNo': '01', 'houseType': '084.0000A', 'room': '101동 101호', 'item': 'sale_price',
                    'status': 'unverified', 'totalWon': {'url': 'https://synthetic.invalid/original.pdf'},
                    'reasons': ['payment_amount_missing'], 'evidence': [], 'installments': []}
        with self.assertRaises(ValueError):
            save_snapshot(*self.ids, self.inputs, replay(self.bundle), env=self.env, opener=self.opener,
                          payment_schedules=[schedule])
        self.opener.open.assert_not_called()

    def test_live_save_keeps_empty_document_review_distinct_from_omitted_schedules(self):
        fetch = Mock(side_effect=AssertionError('합성 공고의 비공식 상세 주소는 조회하지 않습니다.'))
        preview, transport = self.run_worker(fetch, save=False)
        self.assertEqual(set(preview), {'documentReview', 'catalog'})
        self.assertEqual(preview['documentReview']['paymentSchedules'], [])
        self.assertEqual(len(transport.requests), 2)
        self.opener.open.assert_not_called()

        self.opener.open.return_value = self.response()
        saved, _ = self.run_worker(fetch, save=True)
        self.assertEqual(saved, {'snapshotId': self.snapshot_id})
        request = self.opener.open.call_args.args[0]
        self.assertTrue(request.full_url.endswith('/rest/v1/rpc/save_funding_schedule_snapshot'))
        payload = json.loads(request.data)
        self.assertEqual(payload['p_schedules'], [])
        self.assertEqual(payload['p_result']['catalog'], preview['catalog'])
        fetch.assert_not_called()

    @unittest.skipUnless(HAS_FITZ, 'PyMuPDF를 설치한 문서 작업자에서 실행')
    def test_live_save_reads_real_synthetic_pdf_once_and_retries_same_atomic_payload(self):
        responses = _pdf_responses(self.bundle, 'normal')
        pdf = responses[ATTACHMENT_URL][1]
        document_id, version = 'applyhome:9900000001:9900000042:5555:1', 'sha256:' + hashlib.sha256(pdf).hexdigest()
        visited = []

        def fetch(url, *, max_bytes, timeout):
            visited.append(url)
            return _fetch_pdf_response(responses, url)

        self.opener.open.side_effect = [TimeoutError(), self.response()]
        saved, transport = self.run_worker(fetch, save=True)

        self.assertEqual(saved, {'snapshotId': self.snapshot_id})
        self.assertEqual(visited, [DETAIL_URL, ATTACHMENT_URL])
        self.assertEqual(len(transport.requests), 5)
        self.assertFalse(transport.unused())
        first, second = [call.args[0] for call in self.opener.open.call_args_list]
        self.assertEqual(first.full_url, self.env['SUPABASE_URL'] + '/rest/v1/rpc/save_funding_schedule_snapshot')
        self.assertEqual((first.full_url, first.data), (second.full_url, second.data))
        payload = json.loads(first.data)
        self.assertEqual(set(payload), {'p_user_id', 'p_analysis_id', 'p_capture_key', 'p_input', 'p_result', 'p_schedules'})
        self.assertEqual((payload['p_user_id'], payload['p_analysis_id'], payload['p_capture_key']), tuple(self.ids))
        self.assertEqual(payload['p_input'], self.inputs)
        result = payload['p_result']
        self.assertEqual((result['contractVersion'], result['dataOrigin']), ('ingestion/v0', 'collected'))
        self.assertEqual(result['tradeBatches'], replay(self.bundle)['tradeBatches'])
        self.assertEqual(result['catalog']['rooms'][0]['subtotal']['won'], '710000000')
        self.assertEqual(result['catalog']['documents'][0]['version'], version)
        self.assertEqual(result['catalog']['notice']['link']['value'], DETAIL_URL)
        self.assertNotIn('paymentSchedules', json.dumps(result))

        self.assertEqual(len(payload['p_schedules']), 4)
        schedules = {(row['room'], row['item']): row for row in payload['p_schedules']}
        self.assertEqual(len(schedules), 4)
        sale = schedules['101동 101호', 'sale_price']

        def ref(page):
            return {'document': document_id, 'version': version, 'page': page}

        self.assertEqual(sale, {'modelNo': '01', 'houseType': '084.0000A', 'room': '101동 101호', 'item': 'sale_price',
                                'status': 'confirmed', 'totalWon': '700000000', 'reasons': [], 'evidence': [ref(2)],
                                'installments': [
            {'stage': 'deposit', 'won': '70000000', 'timing': {
                'trigger': 'contract_signing', 'dateStatus': 'exact', 'date': '2026-10-27', 'evidence': [ref(1), ref(2)]}},
            {'stage': 'balance', 'won': '630000000', 'timing': {
                'trigger': None, 'dateStatus': 'range', 'date': None, 'evidence': []}},
        ]})
        options = schedules['101동 101호', 'required_options']
        self.assertEqual(options['installments'][0]['timing'],
                         {'trigger': None, 'dateStatus': 'unverified', 'date': None, 'evidence': []})
        held = schedules['101동 102호', 'required_options']
        self.assertEqual((held['status'], held['totalWon'], held['installments']), ('unverified', None, []))
        self.assertTrue(held['reasons'])
        for excluded in ('추후 안내', '2026.12.01.~2026.12.07.', '000-00-000', '%PDF', ATTACHMENT_URL):
            self.assertNotIn(excluded, first.data.decode())
