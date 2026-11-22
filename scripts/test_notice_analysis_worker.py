"""공고 실행의 DB·공급기관 경계를 합성 전송과 시계로 재현한다."""
import io
import json
from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
from unittest import TestCase
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from uuid import uuid4

from ingestion_pages import loads_source_json
from notice_run_capture import NoticeTransports
from replay_ingestion import replay
from run_analysis_worker import FIXTURE, NoticeWorkerConfigurationError, main, run_once
from test_notice_pdf_acquisition import DETAIL, PDF, attachment, html_ok, page, pdf_ok
from worker_rpc import WorkerRpc, WorkerRpcError


WORKER_ENV = {'APP_ENV': 'development', 'SUPABASE_URL': 'http://127.0.0.1',
              'SUPABASE_WORKER_KEY': 'sb_secret_synthetic_worker_marker'}


class NoticeAnalysisWorkerTests(TestCase):
    @classmethod
    def setUpClass(cls):
        bundle = loads_source_json(FIXTURE.read_text(encoding='utf-8'))
        cls.fixture_rows = {p['source']: p['body']['data'] for p in bundle['pages']
                            if p['source'].startswith('applyhome')}

    def setUp(self):
        self.target = {'houseManageNo': '9900000001', 'noticeNo': '9900000042', 'edition': '2026-10-05'}
        self.selection = dict(self.target, kind='notice', noticeSource='applyhome_apt', modelNo='01')
        self.work = {'conditions': {'ingestion_target': dict(self.target, noticeSource='applyhome_apt'),
                                    'comparison': {'modelNo': '01', 'room': '101동 101호'}},
                     'evidence': None, 'ingestion': None, 'selectionBindingIssue': None,
                     'useSyntheticFixture': False, 'noticeCapture': {'asOf': '2026-11-10',
                                                                      'requestRegionCodes': ['99999'],
                                                                      'allowOfficialPdf': False}}
        self.job = {'runId': str(uuid4()), 'generation': 1, 'leaseToken': str(uuid4()), 'input': self.selection}
        self.finished = {'status': 'finished', 'runId': self.job['runId'], 'snapshotId': str(uuid4())}
        self.rows = deepcopy(self.fixture_rows)
        self.rows['applyhome_apt'][0]['PBLANC_URL'] = DETAIL
        self.rows['applyhome_apt'][0]['UNUSED_SYNTHETIC_FIELD'] = 'synthetic raw API marker'
        self.attachment = attachment(11)
        self.client = Mock(spec=WorkerRpc)
        self.client.post.side_effect = self.rpc
        self.events = []
        self.seconds = 0
        self.cancelled = False
        self.renew_error = None
        self.fail_read = None
        self.fail_finish = None
        self.business_error = None

    def rpc(self, name, params, **kwargs):
        self.events.append((name, params))
        if name == 'claim_analysis_run':
            return self.job
        self.assertEqual({key: params[key] for key in ('p_run_id', 'p_generation', 'p_lease_token')},
                         {'p_run_id': self.job['runId'], 'p_generation': self.job['generation'],
                          'p_lease_token': self.job['leaseToken']})
        if name == 'read_comparison_work':
            if self.fail_read is not None:
                raise self.fail_read
            return self.work
        if name == 'renew_analysis_run':
            if self.cancelled:
                raise WorkerRpcError(409, 'PT409')
            if self.renew_error is not None:
                raise self.renew_error
            return {'runId': self.job['runId'], 'status': 'running', 'attempt': self.job['generation']}
        if name in ('finish_analysis_comparison', 'finish_notice_with_funding'):
            if self.fail_finish is not None:
                raise self.fail_finish
            return self.finished
        if name == 'fail_notice_analysis_run':
            return {'status': 'retry_wait' if params['p_retryable'] else 'failed', 'runId': self.job['runId']}
        if name == 'fail_analysis_run':
            return {'status': 'failed', 'runId': self.job['runId']}
        self.fail(f'예상하지 않은 RPC {name}')

    def api(self, source, scope, number, size):
        self.events.append(('api', (source, scope, number, size)))
        self.assertEqual((number, size), (1, 100))
        if source == self.business_error:
            body = {'response': {'header': {'resultCode': '30', 'resultMsg': 'synthetic private error payload'}}}
        elif source in self.rows:
            rows = self.rows[source]
            body = {'page': 1, 'perPage': size, 'matchCount': len(rows), 'currentCount': len(rows), 'data': rows}
        else:
            self.assertIn(source, ('apt_trade', 'apt_rights'))
            body = {'response': {'header': {'resultCode': '000'}, 'body': {
                'numOfRows': size, 'pageNo': 1, 'totalCount': 0, 'items': {}}}}
        return {'source': source, 'scope': scope, 'page': number, 'pageSize': size, 'httpStatus': 200,
                'observedAt': '2026-11-12T00:00:00+00:00', 'body': body}

    def pdf(self, url, *, max_bytes, timeout):
        self.events.append(('pdf', url))
        self.assertGreater(timeout, 0)
        if url == DETAIL:
            return html_ok(page([(self.attachment, '모집공고문 보기')]))
        self.assertEqual(url, self.attachment)
        return pdf_ok()

    def inspect(self, content, *, target, catalog, document):
        self.assertEqual(content, PDF)
        self.assertEqual(target, self.target)
        return {'status': 'confirmed', 'issues': [], 'evidence': [
            {'document': document, 'modelNo': '01', 'houseType': '084.0000A', 'item': 'supply_area',
             'basis': 'supply', 'unit': 'm2', 'm2': '112.40', 'check': 'confirmed', 'page': 1}]}

    def advance(self, seconds):
        self.seconds += seconds

    def run_job(self, *, api=None, pdf=None, limits=None):
        transports = NoticeTransports(api or self.api, pdf or self.pdf, clock=lambda: self.seconds,
                                      sleep=self.advance, inspect=self.inspect, limits=limits)
        return run_once(self.client, notice=transports)

    def calls(self, name):
        return [value for event, value in self.events if event == name]

    def assert_failed(self, code):
        failure, = self.calls('fail_notice_analysis_run')
        self.assertEqual((failure['p_error_code'], failure['p_retryable']), (code, False))
        self.assertEqual(self.calls('finish_analysis_comparison'), [])

    def test_fixed_notice_and_default_year_are_captured_once_and_saved_atomically(self):
        self.assertEqual(self.run_job(), self.finished)
        finish, = self.calls('finish_analysis_comparison')
        self.assertEqual(finish['p_input'], {'noticeSource': 'applyhome_apt', 'target': self.target,
                                             'asOf': '2026-11-10', 'requestRegionCodes': ['99999'],
                                             'tradeKinds': ['sale', 'presale_right', 'occupancy_right'], 'pageSize': 100})
        expected_filter = {'cond[HOUSE_MANAGE_NO::EQ]': '9900000001', 'cond[PBLANC_NO::EQ]': '9900000042'}
        calls = self.calls('api')
        self.assertEqual(calls[:2], [('applyhome_apt', expected_filter, 1, 100),
                                     ('applyhome_apt_model', expected_filter, 1, 100)])
        self.assertEqual(len(calls), 28)
        self.assertEqual([scope['DEAL_YMD'] for source, scope, _, _ in calls[2:] if source == 'apt_trade'],
                         ['202511', '202512', *['2026%02d' % n for n in range(1, 12)]])
        self.assertTrue(all(scope['LAWD_CD'] == '99999' for _, scope, _, _ in calls[2:]))
        capture, comparison = finish['p_result'], finish['p_comparison']
        self.assertEqual((capture['period']['start'], capture['period']['end']), ('2025-11-11', '2026-11-10'))
        self.assertEqual((capture['dataOrigin'], comparison['target']['modelNo']), ('collected', '01'))
        self.assertEqual(comparison['noticePrice']['room'], '101동 101호')
        self.assertEqual(comparison['regionDecision'], {'priority': None, 'expansion': None, 'reasonCode': None})
        self.assertEqual(self.calls('pdf'), [])
        self.assertNotIn('synthetic raw API marker', json.dumps(finish))
        self.assertGreater(self.seconds, 5)

    def test_official_pdf_is_checked_only_when_allowed_and_raw_bytes_are_discarded(self):
        self.work['noticeCapture']['allowOfficialPdf'] = True
        self.assertEqual(self.run_job(), self.finished)
        self.assertEqual(self.calls('pdf'), [DETAIL, self.attachment])
        finish, = self.calls('finish_notice_with_funding')
        self.assertEqual(finish['p_schedules'], [])
        capture = finish['p_result']
        self.assertEqual(capture['catalog']['housingTypes'][0]['checkedSupplyArea']['m2'], '112.40')
        document, = capture['catalog']['documents']
        self.assertEqual((document['source'], document['status']), ('official', 'accepted'))
        self.assertNotIn('%PDF', json.dumps(finish))
        self.assertIn('comparison_evidence_unverified', [hold['reasonCode'] for hold in finish['p_comparison']['holds']])
        self.assertIsNone(finish['p_comparison']['appliedScope'])

    def test_fresh_notice_saves_the_checked_payment_schedule_beside_its_comparison(self):
        try:
            import fitz
        except ImportError:
            self.skipTest('PyMuPDF 미설치')
        from notice_pdf_fields import inspect_notice_pdf
        from test_notice_pdf_fields import build_synthetic_notice_pdf
        body = build_synthetic_notice_pdf()
        self.work['noticeCapture']['allowOfficialPdf'] = True
        self.inspect = inspect_notice_pdf
        self.assertEqual(self.run_job(pdf=lambda url, **kw: self.pdf(url, **kw) if url == DETAIL else pdf_ok(body)), self.finished)
        finish, = self.calls('finish_notice_with_funding')
        selected = [s for s in finish['p_schedules'] if s['room'] == '101동 101호']
        self.assertEqual({s['item']: s['totalWon'] for s in selected},
                         {'sale_price': '700000000', 'required_options': '10000000'})
        self.assertTrue(all(s['evidence'] and s['installments'] for s in selected))
        self.assertNotIn('documentReview', finish['p_result'])
        self.assertEqual(self.calls('finish_analysis_comparison'), [])

    def test_inconsistent_fixed_target_and_unverified_region_never_contact_providers(self):
        fixtures = [
            dict(self.work, conditions=dict(self.work['conditions'], ingestion_target=dict(self.target, edition='wrong'))),
            dict(self.work, noticeCapture=dict(self.work['noticeCapture'], requestRegionCodes=[])),
            dict(self.work, noticeCapture=dict(self.work['noticeCapture'], requestRegionCodes=['99999', '99998'])),
        ]
        for work in fixtures:
            with self.subTest(work=work):
                self.events.clear()
                self.work = work
                self.assertEqual(self.run_job()['status'], 'failed')
                self.assert_failed('notice_selection_unverified')
                self.assertEqual(self.calls('api') + self.calls('pdf'), [])

    def test_mismatched_edition_and_missing_model_prevent_document_and_trade_requests(self):
        self.work['noticeCapture']['allowOfficialPdf'] = True
        for source, rows in (('applyhome_apt', [{**self.rows['applyhome_apt'][0], 'RCRIT_PBLANC_DE': '2026-10-06'}]),
                             ('applyhome_apt_model', [])):
            with self.subTest(source=source):
                self.events.clear()
                self.rows = deepcopy(self.fixture_rows)
                self.rows[source] = rows
                self.assertEqual(self.run_job()['status'], 'failed')
                self.assert_failed('notice_selection_unverified')
                self.assertEqual([source for source, *_ in self.calls('api')], ['applyhome_apt', 'applyhome_apt_model'])
                self.assertEqual(self.calls('pdf'), [])

    def test_notice_feed_business_error_is_a_failure_and_protected_from_raw_body_logging(self):
        self.business_error = 'applyhome_apt'
        self.assertEqual(self.run_job()['status'], 'failed')
        self.assert_failed('notice_feed_unavailable')
        self.assertEqual([source for source, *_ in self.calls('api')], ['applyhome_apt', 'applyhome_apt_model'])
        self.assertNotIn('synthetic private error payload', json.dumps(self.events))

    def test_trade_feed_business_error_is_preserved_as_failed_coverage(self):
        self.business_error = 'apt_rights'
        self.assertEqual(self.run_job(), self.finished)
        finish, = self.calls('finish_analysis_comparison')
        captures = [batch['record'] for batch in finish['p_result']['tradeBatches'] if batch['record']['source'] == 'apt_rights']
        self.assertEqual(len(captures), 13)
        self.assertTrue(all((record['status'], record['error']['code']) == ('failed', 'upstream_business_error')
                            for record in captures))
        self.assertNotIn('normal_zero', json.dumps(finish['p_comparison']))
        self.assertNotIn('synthetic private error payload', json.dumps(finish))

    def test_db_errors_preserve_source_restriction_selection_and_internal_failure(self):
        for when in ('fail_read', 'fail_finish'):
            for sqlstate, expected in (('42501', 'notice_source_restricted'), ('PT403', 'notice_source_restricted'),
                                       ('PT422', 'notice_selection_unverified'), ('22023', None)):
                with self.subTest(when=when, sqlstate=sqlstate):
                    self.events.clear()
                    self.fail_read = self.fail_finish = None
                    setattr(self, when, WorkerRpcError(400, sqlstate))
                    self.assertEqual(self.run_job()['status'], 'failed')
                    if expected is None:
                        self.assertEqual(self.calls('fail_notice_analysis_run'), [])
                        failure, = self.calls('fail_analysis_run')
                        self.assertNotIn('p_error_code', failure)
                    else:
                        self.assertEqual(self.calls('fail_analysis_run'), [])
                        failure, = self.calls('fail_notice_analysis_run')
                        self.assertEqual(failure['p_error_code'], expected)
                    self.assertFalse(failure['p_retryable'])
                    if when == 'fail_read':
                        self.assertEqual(self.calls('api') + self.calls('pdf'), [])

    def test_pdf_deadline_uses_injected_time_and_leaves_document_held(self):
        self.work['noticeCapture']['allowOfficialPdf'] = True

        def too_slow(url, **kwargs):
            self.advance(90)
            return self.pdf(url, **kwargs)

        self.assertEqual(self.run_job(pdf=too_slow), self.finished)
        self.assertEqual(self.calls('pdf'), [DETAIL])
        completion, = self.calls('finish_notice_with_funding')
        self.assertEqual(completion['p_schedules'], [])
        capture = completion['p_result']
        self.assertEqual(capture['catalog']['documents'], [])
        self.assertIn('deadline_exceeded', [issue['code'] for issue in capture['catalog']['issues']])

    def test_temporary_trade_failure_retries_and_keeps_the_fixed_basis_on_the_last_attempt(self):
        def unavailable(source, scope, number, size):
            reply = self.api(source, scope, number, size)
            if source == 'apt_trade':
                reply.update(httpStatus=503, body=None)
            return reply

        self.assertEqual(self.run_job(api=unavailable)['status'], 'retry_wait')
        failure, = self.calls('fail_notice_analysis_run')
        first_scopes = self.calls('api')
        self.assertEqual((failure['p_error_code'], failure['p_retryable']), ('notice_feed_unavailable', True))
        self.assertEqual(self.calls('finish_analysis_comparison'), [])

        self.events.clear()
        self.job.update(generation=3, leaseToken=str(uuid4()))
        self.assertEqual(self.run_job(api=unavailable), self.finished)
        self.assertEqual(self.calls('api'), first_scopes)
        finish, = self.calls('finish_analysis_comparison')
        self.assertEqual(finish['p_input']['asOf'], '2026-11-10')
        self.assertNotIn('normal_zero', json.dumps(finish['p_comparison']))

    def test_second_trade_page_failure_preserves_rows_and_partial_coverage(self):
        def incomplete(source, scope, number, size):
            if source != 'apt_trade' or scope['DEAL_YMD'] != '202610':
                return self.api(source, scope, number, size)
            reply = {'source': source, 'scope': scope, 'page': number, 'pageSize': size,
                     'observedAt': '2026-11-12T00:00:00+00:00'}
            if number == 1:
                items = [{'aptNm': '합성 거래 단지', 'dealYear': '2026', 'dealMonth': '10', 'dealDay': '15',
                          'dealAmount': '20000', 'excluUseAr': '84.15'}] * size
                body = {'response': {'header': {'resultCode': '000'}, 'body': {
                    'pageNo': number, 'numOfRows': size, 'totalCount': size + 1, 'items': {'item': items}}}}
                return dict(reply, httpStatus=200, body=body)
            self.assertEqual(number, 2)
            return dict(reply, httpStatus=503, body=None)

        self.assertEqual(self.run_job(api=incomplete), self.finished)
        finish, = self.calls('finish_analysis_comparison')
        batches = finish['p_result']['tradeBatches']
        batch, = (item for item in batches if (item['record']['source'], item['record']['month']) == ('apt_trade', '2026-10'))
        self.assertEqual((batch['record']['status'], batch['record']['missingPages'], len(batch['trades'])),
                         ('partial', [2], 100))
        self.assertNotIn('normal_zero', json.dumps(finish['p_comparison']))

    def test_provider_quota_and_permission_stop_further_trade_calls(self):
        for http_status, code, retryable in ((429, 'notice_feed_unavailable', True),
                                             (403, 'notice_source_restricted', False)):
            with self.subTest(http_status=http_status):
                self.events.clear()

                def reject_trade(source, scope, number, size):
                    reply = self.api(source, scope, number, size)
                    if source == 'apt_trade':
                        reply.update(httpStatus=http_status, body=None)
                    return reply

                self.assertEqual(self.run_job(api=reject_trade)['status'], 'retry_wait' if retryable else 'failed')
                failure, = self.calls('fail_notice_analysis_run')
                self.assertEqual((failure['p_error_code'], failure['p_retryable']), (code, retryable))
                self.assertEqual([source for source, *_ in self.calls('api')],
                                 ['applyhome_apt', 'applyhome_apt_model', 'apt_trade'])

    def test_cancellation_during_pdf_stops_the_next_download_and_any_writes(self):
        self.work['noticeCapture']['allowOfficialPdf'] = True

        def cancelled_after_detail(url, **kwargs):
            self.cancelled = True
            return self.pdf(url, **kwargs)

        self.assertEqual(self.run_job(pdf=cancelled_after_detail),
                         {'status': 'lease_lost', 'runId': self.job['runId']})
        self.assertEqual(self.calls('pdf'), [DETAIL])
        self.assertEqual(len(self.calls('api')), 2)
        self.assertEqual(self.calls('finish_analysis_comparison') + self.calls('fail_notice_analysis_run'), [])

    def test_unconfirmed_renewal_and_finish_do_not_attempt_failure_writes(self):
        for stage, failure in (('renew_error', WorkerRpcError(429)), ('fail_finish', WorkerRpcError())):
            with self.subTest(stage=stage):
                self.events.clear()
                self.renew_error = self.fail_finish = None
                setattr(self, stage, failure)
                with self.assertRaises(WorkerRpcError):
                    self.run_job()
                if stage == 'renew_error':
                    self.assertEqual(self.calls('api') + self.calls('pdf') + self.calls('finish_analysis_comparison'), [])
                self.assertEqual(self.calls('fail_notice_analysis_run'), [])

    def test_request_limit_and_deadline_stop_before_another_call(self):
        for limits, allowed in (({'apiRequests': 2}, 2),
                                ({'deadlineSeconds': 0.1, 'requestIntervalSeconds': 0.2}, 1)):
            with self.subTest(limits=limits):
                self.events.clear()
                self.seconds = 0
                self.assertEqual(self.run_job(limits=limits)['status'], 'failed')
                self.assert_failed('notice_capture_limit')
                self.assertEqual(len(self.calls('api')), allowed)

    def test_notice_without_configured_transport_does_not_write_or_query_providers(self):
        with self.assertRaises(NoticeWorkerConfigurationError):
            run_once(self.client)
        self.assertEqual([name for name, _ in self.events], ['claim_analysis_run'])

    def test_legacy_modes_do_not_load_provider_config_even_with_live_enabled(self):
        stored = replay(loads_source_json(FIXTURE.read_text(encoding='utf-8')))
        for input_, capture in (({'kind': 'synthetic', 'fixture': 'ingestion-v0'}, None),
                                ({'kind': 'snapshot', 'snapshotId': self.finished['snapshotId']}, stored)):
            for flag in ([], ['--live']):
                with self.subTest(input=input_, flag=flag):
                    self.events.clear()
                    self.job['input'] = input_
                    self.work = {'conditions': {}, 'ingestion': capture, 'evidence': None,
                                 'selectionBindingIssue': None, 'useSyntheticFixture': capture is None}
                    with patch.dict('os.environ', WORKER_ENV, clear=True), \
                            patch('sys.argv', ['worker', '--once', *flag]), \
                            patch.object(WorkerRpc, 'post', side_effect=self.rpc), \
                            patch('run_analysis_worker.live_notice_transports') as factory, \
                            redirect_stdout(io.StringIO()) as stdout:
                        self.assertEqual(main(), 0)
                    self.assertEqual(json.loads(stdout.getvalue()), self.finished)
                    factory.assert_not_called()

    def test_only_the_notice_needs_provider_key_and_missing_key_leaves_lease_recoverable(self):
        with patch.dict('os.environ', WORKER_ENV, clear=True), patch('sys.argv', ['worker', '--once', '--live']), \
                patch.object(WorkerRpc, 'post', side_effect=self.rpc), redirect_stderr(io.StringIO()) as stderr:
            with self.assertRaises(SystemExit) as exit_status:
                main()
        self.assertEqual(exit_status.exception.code, 2)
        self.assertEqual([name for name, _ in self.events], ['claim_analysis_run', 'read_comparison_work'])
        self.assertIn('공공데이터포털', stderr.getvalue())
        self.assertNotIn('synthetic_worker_marker', stderr.getvalue())

    def test_live_honors_pdf_permission_and_holds_missing_parser_at_inspection(self):
        for allowed in (False, True):
            with self.subTest(allowed=allowed):
                self.events.clear()
                self.work['noticeCapture']['allowOfficialPdf'] = allowed
                with patch.dict('os.environ', WORKER_ENV, clear=True), patch('sys.argv', ['worker', '--once', '--live']), \
                        patch.dict('sys.modules', {'fitz': None}), \
                        patch.dict('notice_run_capture.LIMITS', {'requestIntervalSeconds': 0}), \
                        patch('review_notice_documents.live_api_transport', return_value=self.api), \
                        patch('notice_pdf_acquisition.make_live_fetch', return_value=self.pdf) as pdf_factory, \
                        patch.object(WorkerRpc, 'post', side_effect=self.rpc), redirect_stdout(io.StringIO()) as stdout:
                    self.assertEqual(main(), 0)
                self.assertEqual(json.loads(stdout.getvalue()), self.finished)
                self.assertEqual(pdf_factory.call_count, int(allowed))
                self.assertEqual(self.calls('pdf'), [DETAIL, self.attachment] if allowed else [])
                completion, = self.calls('finish_notice_with_funding' if allowed else 'finish_analysis_comparison')
                capture = completion['p_result']
                self.assertEqual(capture['dataOrigin'], 'collected')
                if allowed:
                    document, = capture['catalog']['documents']
                    self.assertEqual(document['status'], 'held')
                    self.assertIn('pdf_parser_unavailable', document['reasons'])


class AnalysisWorkerStartupTests(TestCase):
    def test_live_cli_keeps_worker_rpc_development_only(self):
        for override in ({'APP_ENV': 'production', 'SUPABASE_URL': 'https://syntheticprodproject.supabase.co'},
                         {'VERCEL_ENV': 'production'}, {'SUPABASE_URL': 'https://syntheticprodproject.supabase.co'}):
            with self.subTest(override=override), patch.dict('os.environ', {**WORKER_ENV, **override}, clear=True), \
                    patch('sys.argv', ['worker', '--once', '--live']), patch.object(WorkerRpc, 'post') as post, \
                    patch('run_analysis_worker.live_notice_transports') as provider, redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as exit_status:
                    main()
                self.assertEqual(exit_status.exception.code, 2)
                post.assert_not_called()
                provider.assert_not_called()
        self.assertIn('/rest/v1/rpc/', WorkerRpc({**WORKER_ENV, 'VERCEL_ENV': 'preview'}).base)

    def test_rpc_preserves_pt403_without_the_server_error_body(self):
        opener = Mock()
        detail = json.dumps({'code': 'PT403', 'message': 'synthetic private details'}).encode()
        opener.open.side_effect = HTTPError(WORKER_ENV['SUPABASE_URL'], 403, '', {}, io.BytesIO(detail))
        with self.assertRaises(WorkerRpcError) as error:
            WorkerRpc(WORKER_ENV, opener).post('read_comparison_work', {})
        self.assertEqual((error.exception.status, error.exception.code), (403, 'PT403'))
        self.assertNotIn('synthetic private details', str(error.exception))
