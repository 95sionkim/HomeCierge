"""합성 DB 응답으로 작업 중단·불확실한 커밋·임대 교체 경계를 검증한다."""
import copy
import io
import json
from unittest import TestCase
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from uuid import uuid4

from ingestion_pages import loads_source_json
from ingestion_trades import trade_period
from notice_run_capture import NoticeTransports
from replay_ingestion import replay
from run_analysis_worker import FINISH_RPC_TIMEOUT_SECONDS, FIXTURE, SAVE_RETRY_DELAYS, run_once
from worker_rpc import (
    WorkerRpc, WorkerRpcError, WorkerRpcResponseTooLarge,
    is_transient_save_error, save_error_reason,
)


class AnalysisWorkerTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.capture = replay(loads_source_json(FIXTURE.read_text(encoding='utf-8')))

    def setUp(self):
        self.run_id = str(uuid4())
        self.snapshot_id = str(uuid4())
        self.job = {'runId': self.run_id, 'generation': 2, 'leaseToken': str(uuid4()),
                    'input': {'kind': 'synthetic', 'fixture': 'ingestion-v0'}}
        self.finished = {'runId': self.run_id, 'status': 'finished', 'snapshotId': self.snapshot_id}
        self.client = Mock(spec=WorkerRpc)
        self.work = {'conditions': {}, 'ingestion': None, 'evidence': None,
                     'useSyntheticFixture': True, 'selectionBindingIssue': None}

    def test_scoped_claim_and_atomic_finish_use_one_generation(self):
        self.client.post.side_effect = [self.job, self.work, {'status': 'running'}, self.finished]
        self.assertEqual(run_once(self.client, run_id=self.run_id), self.finished)
        claim, read, renew, finish = [call.args for call in self.client.post.call_args_list]
        self.assertEqual(claim, ('claim_analysis_run', {'p_lease_seconds': 60, 'p_run_id': self.run_id}))
        self.assertEqual(renew[0], 'renew_analysis_run')
        self.assertEqual(read[0], 'read_comparison_work')
        self.assertEqual(finish[0], 'finish_analysis_comparison')
        for key in ('p_run_id', 'p_generation', 'p_lease_token'):
            self.assertEqual(renew[1][key], finish[1][key])
            self.assertEqual(read[1][key], finish[1][key])
        self.assertEqual(finish[1]['p_result']['dataOrigin'], 'synthetic')
        self.assertEqual(finish[1]['p_comparison']['contractVersion'], 'comparison/v1')
        self.assertTrue(finish[1]['p_comparison']['comparables'])
        self.assertNotIn('pages', finish[1]['p_input'])

    def test_existing_snapshot_needs_no_local_fixture_or_new_capture(self):
        self.job['input'] = {'kind': 'snapshot', 'snapshotId': self.snapshot_id}
        stored = {**self.work, 'ingestion': self.capture, 'useSyntheticFixture': False}
        self.client.post.side_effect = [self.job, stored, {'status': 'running'}, self.finished]
        with patch('run_analysis_worker.FIXTURE') as fixture:
            self.assertEqual(run_once(self.client), self.finished)
            fixture.read_bytes.assert_not_called()
        params = self.client.post.call_args.args[1]
        self.assertEqual((params['p_input'], params['p_result']), (None, None))
        self.assertEqual(params['p_comparison']['comparables'], [])
        self.assertIsNone(params['p_comparison']['appliedScope'])

    def test_rejected_failure_write_is_not_sent_again_in_the_same_attempt(self):
        self.client.post.side_effect = [self.job, {}, WorkerRpcError(429)]
        with self.assertRaises(WorkerRpcError):
            run_once(self.client)
        self.assertEqual([call.args[0] for call in self.client.post.call_args_list], [
            'claim_analysis_run', 'read_comparison_work', 'fail_analysis_run',
        ])

    def test_different_snapshot_in_completion_is_not_reported_as_the_requested_input(self):
        self.job['input'] = {'kind': 'snapshot', 'snapshotId': str(uuid4())}
        stored = {**self.work, 'ingestion': self.capture, 'useSyntheticFixture': False}
        self.client.post.side_effect = [self.job, stored, {}, self.finished]
        with self.assertRaises(WorkerRpcError):
            run_once(self.client)

    def test_mismatched_claim_never_acts_on_another_run_and_idle_performs_no_writes(self):
        self.client.post.side_effect = [self.job, None]
        with self.assertRaises(WorkerRpcError):
            run_once(self.client, run_id=uuid4())
        self.assertEqual(run_once(self.client), {'status': 'idle'})
        self.assertEqual([call.args[0] for call in self.client.post.call_args_list], ['claim_analysis_run'] * 2)

    def test_fenced_lease_stops_at_renew_or_finish(self):
        for stage, code in (('read', 'PT409'), ('renew', 'PT404'), ('renew', 'PT409'), ('finish', 'PT409')):
            with self.subTest(stage=stage, code=code):
                self.client.reset_mock()
                replies = [self.job] + ([] if stage == 'read' else [self.work])
                if stage == 'finish':
                    replies.append({'status': 'running'})
                self.client.post.side_effect = replies + [WorkerRpcError(409, code)]
                self.assertEqual(run_once(self.client), {'status': 'lease_lost', 'runId': self.run_id})
                self.assertEqual(self.client.post.call_count, len(replies) + 1)

    def test_uncertain_finish_never_rewrites_or_declares_failure(self):
        # 응답 크기 초과는 재시도나 실패 기록 없이 종료한다.
        self.client.post.side_effect = [self.job, self.work, {'status': 'running'}, WorkerRpcResponseTooLarge()]
        with patch('run_analysis_worker.time.sleep') as sleep, self.assertRaises(WorkerRpcError):
            run_once(self.client)
        self.assertEqual([call.args[0] for call in self.client.post.call_args_list], [
            'claim_analysis_run', 'read_comparison_work', 'renew_analysis_run', 'finish_analysis_comparison',
        ])
        sleep.assert_not_called()

        # 응답 유실(status=None) 뒤 상태 확인도 계속 미확인이면 무작정 다시 쓰거나 fail_analysis_run을 호출하지 않는다.
        self.client.reset_mock()
        self.client.post.side_effect = [
            self.job, self.work, {'status': 'running'},
            WorkerRpcError(),
            WorkerRpcError(), WorkerRpcError(), WorkerRpcError(), WorkerRpcError(),
        ]
        with patch('run_analysis_worker.time.sleep') as sleep, self.assertRaises(WorkerRpcError) as raised:
            run_once(self.client)
        names = [call.args[0] for call in self.client.post.call_args_list]
        self.assertEqual(names.count('finish_analysis_comparison'), 1)
        self.assertEqual(names.count('read_analysis_run_status'), 4)
        self.assertNotIn('fail_analysis_run', names)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], list(SAVE_RETRY_DELAYS))
        self.assertEqual(raised.exception.save_retries, 3)
        self.assertEqual(raised.exception.save_retry_reasons, ('response_unconfirmed',) * 3)

    def test_worker_rpc_parses_statement_timeout_57014_and_classifies_save_errors(self):
        opener = Mock()
        env = {'SUPABASE_URL': 'http://127.0.0.1', 'SUPABASE_WORKER_KEY': 'sb_secret_synthetic'}
        client = WorkerRpc(env, opener)
        detail = json.dumps({'code': '57014', 'message': 'canceling statement due to statement timeout'}).encode()
        opener.open.side_effect = HTTPError('http://localhost', 500, '', {}, io.BytesIO(detail))
        with self.assertRaises(WorkerRpcError) as raised:
            client.post('finish_analysis_comparison', {}, timeout=FINISH_RPC_TIMEOUT_SECONDS)
        self.assertEqual((raised.exception.status, raised.exception.code), (500, '57014'))
        self.assertNotIn('canceling statement', str(raised.exception))
        self.assertEqual(opener.open.call_args.kwargs['timeout'], FINISH_RPC_TIMEOUT_SECONDS)

        self.assertTrue(is_transient_save_error(raised.exception))
        self.assertEqual(save_error_reason(raised.exception), 'statement_timeout')
        self.assertTrue(is_transient_save_error(WorkerRpcError()))
        self.assertEqual(save_error_reason(WorkerRpcError()), 'response_unconfirmed')
        self.assertTrue(is_transient_save_error(WorkerRpcError(503)))
        self.assertEqual(save_error_reason(WorkerRpcError(503)), 'http_503')
        for non_transient in (
            WorkerRpcError(401), WorkerRpcError(403, '42501'), WorkerRpcError(403, 'PT403'),
            WorkerRpcError(400, '22023'), WorkerRpcError(409, 'PT409'), WorkerRpcError(413),
            WorkerRpcError(422, 'PT422'), WorkerRpcError(429), WorkerRpcResponseTooLarge(),
        ):
            self.assertFalse(is_transient_save_error(non_transient))

    def test_transient_save_errors_retry_with_same_capture_and_lease_renewal(self):
        self.client.post.side_effect = [
            self.job, self.work, {'status': 'running'},
            WorkerRpcError(500, '57014'),
            {'status': 'running', 'runId': self.run_id, 'attempt': 2},
            WorkerRpcError(502),
            {'status': 'running', 'runId': self.run_id, 'attempt': 2},
            WorkerRpcError(503),
            {'status': 'running', 'runId': self.run_id, 'attempt': 2},
            self.finished,
        ]
        with patch('run_analysis_worker.time.sleep') as sleep, \
                patch('run_analysis_worker.replay', wraps=replay) as replay_spy:
            outcome = run_once(self.client)
        self.assertEqual(outcome, {
            **self.finished,
            'saveRetries': 3,
            'saveRetryReasons': ['statement_timeout', 'http_502', 'http_503'],
        })
        self.assertEqual(replay_spy.call_count, 1)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2, 5, 10])
        names = [call.args[0] for call in self.client.post.call_args_list]
        self.assertEqual(names, [
            'claim_analysis_run', 'read_comparison_work', 'renew_analysis_run',
            'finish_analysis_comparison', 'renew_analysis_run',
            'finish_analysis_comparison', 'renew_analysis_run',
            'finish_analysis_comparison', 'renew_analysis_run',
            'finish_analysis_comparison',
        ])
        finish_calls = [c for c in self.client.post.call_args_list if c.args[0] == 'finish_analysis_comparison']
        self.assertTrue(all(c.kwargs.get('timeout') == FINISH_RPC_TIMEOUT_SECONDS for c in finish_calls))
        for call in finish_calls[1:]:
            self.assertEqual(call.args[1], finish_calls[0].args[1])

    def test_transient_save_exhausting_three_retries_raises_without_declaring_failure(self):
        self.client.post.side_effect = [
            self.job, self.work, {'status': 'running'},
            WorkerRpcError(500, '57014'),
            {'status': 'running', 'runId': self.run_id, 'attempt': 2},
            WorkerRpcError(503),
            {'status': 'running', 'runId': self.run_id, 'attempt': 2},
            WorkerRpcError(500),
            {'status': 'running', 'runId': self.run_id, 'attempt': 2},
            WorkerRpcError(504),
        ]
        with patch('run_analysis_worker.time.sleep') as sleep, self.assertRaises(WorkerRpcError) as raised:
            run_once(self.client)
        self.assertEqual(raised.exception.status, 504)
        self.assertEqual(raised.exception.save_retries, 3)
        self.assertEqual(raised.exception.save_retry_reasons, ('statement_timeout', 'http_503', 'http_500'))
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2, 5, 10])
        names = [call.args[0] for call in self.client.post.call_args_list]
        self.assertEqual(names.count('finish_analysis_comparison'), 4)
        self.assertEqual(names.count('renew_analysis_run'), 4)
        self.assertNotIn('fail_analysis_run', names)

    def test_uncertain_finish_checks_run_status_for_already_finished_retry_and_lease_lost(self):
        # 1) 응답은 못 받았지만 DB에 이미 완료된 경우 재전송 없이 완료를 반환한다.
        self.client.post.side_effect = [
            self.job, self.work, {'status': 'running'},
            WorkerRpcError(),
            {'runId': self.run_id, 'status': 'finished', 'attempt': 2,
             'snapshotId': self.snapshot_id, 'leaseActive': False},
        ]
        with patch('run_analysis_worker.time.sleep') as sleep:
            self.assertEqual(run_once(self.client), self.finished)
        sleep.assert_not_called()
        self.assertEqual([call.args[0] for call in self.client.post.call_args_list], [
            'claim_analysis_run', 'read_comparison_work', 'renew_analysis_run',
            'finish_analysis_comparison', 'read_analysis_run_status',
        ])

        # 2) 아직 running이고 현재 임대가 살아 있으면 갱신 후 같은 수집본으로 저장만 재시도한다.
        self.client.reset_mock()
        self.client.post.side_effect = [
            self.job, self.work, {'status': 'running'},
            WorkerRpcError(),
            {'runId': self.run_id, 'status': 'running', 'attempt': 2, 'leaseActive': True},
            {'runId': self.run_id, 'status': 'running', 'attempt': 2},
            self.finished,
        ]
        with patch('run_analysis_worker.time.sleep') as sleep:
            outcome = run_once(self.client)
        self.assertEqual(outcome, {
            **self.finished, 'saveRetries': 1, 'saveRetryReasons': ['response_unconfirmed'],
        })
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2])
        self.assertEqual([call.args[0] for call in self.client.post.call_args_list], [
            'claim_analysis_run', 'read_comparison_work', 'renew_analysis_run',
            'finish_analysis_comparison', 'read_analysis_run_status',
            'renew_analysis_run', 'finish_analysis_comparison',
        ])

        # 3) 취소되었거나 세대·임대가 이미 넘어갔으면 다시 쓰지 않고 lease_lost로 멈춘다.
        for probe in (
            {'runId': self.run_id, 'status': 'cancelled', 'attempt': 2, 'leaseActive': False},
            {'runId': self.run_id, 'status': 'running', 'attempt': 2, 'leaseActive': False},
            {'runId': self.run_id, 'status': 'running', 'attempt': 3, 'leaseActive': False},
            {'runId': self.run_id, 'status': 'finished', 'attempt': 3,
             'snapshotId': self.snapshot_id, 'leaseActive': False},
        ):
            with self.subTest(probe=probe):
                self.client.reset_mock()
                self.client.post.side_effect = [
                    self.job, self.work, {'status': 'running'},
                    WorkerRpcError(),
                    probe,
                ]
                with patch('run_analysis_worker.time.sleep') as sleep:
                    self.assertEqual(run_once(self.client), {'status': 'lease_lost', 'runId': self.run_id})
                sleep.assert_not_called()
                names = [call.args[0] for call in self.client.post.call_args_list]
                self.assertEqual(names.count('finish_analysis_comparison'), 1)
                self.assertNotIn('fail_analysis_run', names)

        # 4) 상태 조회 자체가 일시 오류로 실패한 뒤 다음 조회에서 완료를 확인하면 재전송 없이 완료한다.
        self.client.reset_mock()
        self.client.post.side_effect = [
            self.job, self.work, {'status': 'running'},
            WorkerRpcError(),
            WorkerRpcError(503),
            {'runId': self.run_id, 'status': 'finished', 'attempt': 2,
             'snapshotId': self.snapshot_id, 'leaseActive': False},
        ]
        with patch('run_analysis_worker.time.sleep') as sleep:
            outcome = run_once(self.client)
        self.assertEqual(outcome, {**self.finished, 'saveRetries': 1, 'saveRetryReasons': ['http_503']})
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2])
        self.assertEqual([call.args[0] for call in self.client.post.call_args_list].count('finish_analysis_comparison'), 1)

    def test_non_retryable_save_errors_and_renewal_loss_do_not_retry(self):
        # 401/403 인증 거절과 4xx 업무 오류는 저장 재시도를 하지 않는다.
        for error, expected_outcome in (
            (WorkerRpcError(401), 'raise'),
            (WorkerRpcError(403), 'raise'),
            (WorkerRpcError(403, '42501'), 'failed'),
            (WorkerRpcError(400, '22023'), 'failed'),
            (WorkerRpcError(422, 'PT422'), 'failed'),
            (WorkerRpcError(409, 'PT409'), 'lease_lost'),
            (WorkerRpcError(429), 'retry_wait'),
        ):
            with self.subTest(status=error.status, code=error.code):
                self.client.reset_mock()
                replies = [self.job, self.work, {'status': 'running'}, error]
                if expected_outcome in ('failed', 'retry_wait'):
                    replies.append({'runId': self.run_id, 'status': expected_outcome})
                self.client.post.side_effect = replies
                with patch('run_analysis_worker.time.sleep') as sleep:
                    if expected_outcome == 'raise':
                        with self.assertRaises(WorkerRpcError):
                            run_once(self.client)
                    else:
                        self.assertEqual(run_once(self.client)['status'], expected_outcome)
                sleep.assert_not_called()
                names = [call.args[0] for call in self.client.post.call_args_list]
                self.assertEqual(names.count('finish_analysis_comparison'), 1)
                self.assertEqual(names.count('renew_analysis_run'), 1)

        # 재시도 직전 임대 갱신이 PT409로 거절되면 추가 저장 없이 lease_lost로 끝낸다.
        self.client.reset_mock()
        self.client.post.side_effect = [
            self.job, self.work, {'status': 'running'},
            WorkerRpcError(503),
            WorkerRpcError(409, 'PT409'),
        ]
        with patch('run_analysis_worker.time.sleep') as sleep:
            self.assertEqual(
                run_once(self.client),
                {'status': 'lease_lost', 'runId': self.run_id, 'saveRetries': 1, 'saveRetryReasons': ['http_503']},
            )
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2])
        self.assertEqual([call.args[0] for call in self.client.post.call_args_list].count('finish_analysis_comparison'), 1)

    def test_only_explicit_failures_are_reported_with_retry_intent(self):
        for error, retryable in ((WorkerRpcError(429), True), (WorkerRpcError(400, '22023'), False)):
            status = 'retry_wait' if retryable else 'failed'
            self.client.post.side_effect = [self.job, self.work, {}, error, {'runId': self.run_id, 'status': status}]
            self.assertEqual(run_once(self.client)['status'], status)
            name, args = self.client.post.call_args.args
            self.assertEqual((name, args['p_retryable']), ('fail_analysis_run', retryable))

    def test_changed_or_unknown_fixture_fails_without_saving(self):
        with patch('run_analysis_worker.FIXTURE') as fixture:
            fixture.read_bytes.return_value = b'fixture changed'
            for name in ('ingestion-v0', 'unknown'):
                self.job['input']['fixture'] = name
                self.client.post.side_effect = [self.job, self.work, {'runId': self.run_id, 'status': 'failed'}]
                self.assertEqual(run_once(self.client)['status'], 'failed')
                self.assertEqual(self.client.post.call_args.args[0], 'fail_analysis_run')

    def test_only_trusted_pinned_snapshots_reuse_the_demo_evidence(self):
        self.job['input'] = {'kind': 'snapshot', 'snapshotId': self.snapshot_id}
        self.work['ingestion'] = self.capture
        self.client.post.side_effect = [self.job, self.work, {}, self.finished]
        self.assertEqual(run_once(self.client), self.finished)
        params = self.client.post.call_args.args[1]
        self.assertIsNone(params['p_result'])
        self.assertTrue(params['p_comparison']['comparables'])
        self.work['ingestion'] = {**self.capture, 'dataOrigin': 'collected'}
        self.client.post.side_effect = [self.job, self.work, {'runId': self.run_id, 'status': 'failed'}]
        self.assertEqual(run_once(self.client)['status'], 'failed')
        self.assertEqual(self.client.post.call_args.args[0], 'fail_analysis_run')

    def test_user_conditions_cannot_supply_evidence_or_override_binding(self):
        self.job['input'] = {'kind': 'snapshot', 'snapshotId': self.snapshot_id}
        self.work.update(ingestion=self.capture, useSyntheticFixture=False,
                         selectionBindingIssue='target_identity_unverified',
                         conditions={'comparison': {'modelNo': '01'}, 'evidence': {'tradeLinks': ['private']}})
        self.client.post.side_effect = [self.job, self.work, {}, self.finished]
        run_once(self.client)
        comparison = self.client.post.call_args.args[1]['p_comparison']
        self.assertEqual(comparison['comparables'], [])
        self.assertIsNone(comparison['appliedScope'])
        self.assertNotIn('private', json.dumps(comparison))

    def test_rpc_suppresses_provider_detail_and_limits_responses(self):
        opener = Mock()
        env = {'SUPABASE_URL': 'http://127.0.0.1', 'SUPABASE_WORKER_KEY': 'sb_secret_synthetic'}
        client = WorkerRpc(env, opener)
        detail = json.dumps({'code': 'PT409', 'message': 'synthetic private detail'}).encode()
        opener.open.side_effect = HTTPError('http://localhost', 409, '', {}, io.BytesIO(detail))
        with self.assertRaises(WorkerRpcError) as raised:
            client.post('renew_analysis_run', {})
        self.assertEqual((raised.exception.status, raised.exception.code), (409, 'PT409'))
        self.assertNotIn('private detail', str(raised.exception))
        opener.open.side_effect = None
        opener.open.return_value = io.BytesIO(b'null ' * 100)
        with self.assertRaises(WorkerRpcError):
            client.post('claim_analysis_run', {}, limit=20)

    def test_void_publication_accepts_http_204_without_treating_empty_json_as_success(self):
        opener = Mock()
        client = WorkerRpc({'SUPABASE_URL': 'http://127.0.0.1', 'SUPABASE_WORKER_KEY': 'sb_secret_synthetic'}, opener)
        for status, accepts_void, succeeds in [(204, True, True), (204, False, False), (200, True, False)]:
            with self.subTest(status=status, accepts_void=accepts_void):
                response = io.BytesIO(b'')
                response.status = status
                opener.open.return_value = response
                if succeeds:
                    self.assertIsNone(client.post('publish_notice_search_index', {}, allow_no_content=accepts_void))
                else:
                    with self.assertRaises(WorkerRpcError):
                        client.post('publish_notice_search_index', {}, allow_no_content=accepts_void)

    def test_snapshot_comparison_period_narrows_and_rewidens_without_new_capture_or_mutation(self):
        self.job['input'] = {'kind': 'snapshot', 'snapshotId': self.snapshot_id}
        capture = copy.deepcopy(self.capture)
        narrow_work = {**self.work, 'ingestion': capture,
                       'comparisonPeriod': {'start': '2026-10-24', 'end': '2026-10-26'}}
        before_work = copy.deepcopy(narrow_work)
        before_job = copy.deepcopy(self.job)
        self.client.post.side_effect = [self.job, narrow_work, {'status': 'running'}, self.finished]
        self.assertEqual(run_once(self.client), self.finished)
        narrow_params = self.client.post.call_args.args[1]
        self.assertEqual((narrow_params['p_input'], narrow_params['p_result']), (None, None))
        narrowed = narrow_params['p_comparison']
        self.assertEqual(narrowed['conditions']['period'], trade_period('2026-11-10', '2026-10-24', '2026-10-26'))
        self.assertEqual([row['complexId'] for row in narrowed['comparables']], ['comparison-b'])
        self.assertEqual(set(narrowed['comparables'][0]['tradeStats']), {'presale_right', 'occupancy_right'})
        self.assertEqual(narrowed['tradeKinds']['sale']['conclusion'], 'normal_zero')
        self.assertEqual(narrow_work, before_work)
        self.assertEqual(self.job, before_job)

        # 같은 원본 스냅샷에 다시 넓힌 기간을 적용하면 비교 A가 복원되고 입주권이 제외된다.
        rewiden_work = {**self.work, 'ingestion': capture,
                        'comparisonPeriod': {'start': '2026-10-20', 'end': '2026-10-24'}}
        self.client.post.side_effect = [self.job, rewiden_work, {'status': 'running'}, self.finished]
        self.assertEqual(run_once(self.client), self.finished)
        rewiden_params = self.client.post.call_args.args[1]
        self.assertEqual((rewiden_params['p_input'], rewiden_params['p_result']), (None, None))
        rewidened = rewiden_params['p_comparison']
        self.assertEqual(rewidened['conditions']['period'], trade_period('2026-11-10', '2026-10-20', '2026-10-24'))
        self.assertEqual([row['complexId'] for row in rewidened['comparables']], ['comparison-a', 'comparison-b'])
        self.assertEqual(list(rewidened['comparables'][1]['tradeStats']), ['presale_right'])
        self.assertEqual(rewidened['tradeKinds']['occupancy_right']['conclusion'], 'normal_zero')
        self.assertEqual(capture, self.capture)

        # 근거 없는 저장 수집본(collected)도 로컬 고정 자료 없이 새 기간과 보류를 기록한다.
        collected = {**self.capture, 'dataOrigin': 'collected'}
        stored = {**self.work, 'ingestion': collected, 'useSyntheticFixture': False,
                  'comparisonPeriod': {'start': '2026-10-24', 'end': '2026-10-26'}}
        self.client.post.side_effect = [self.job, stored, {'status': 'running'}, self.finished]
        with patch('run_analysis_worker.FIXTURE') as fixture:
            self.assertEqual(run_once(self.client), self.finished)
            fixture.read_bytes.assert_not_called()
        params = self.client.post.call_args.args[1]
        self.assertEqual((params['p_input'], params['p_result']), (None, None))
        self.assertEqual(params['p_comparison']['conditions']['period'],
                         trade_period('2026-11-10', '2026-10-24', '2026-10-26'))
        self.assertIn('comparison_evidence_unverified', {h['reasonCode'] for h in params['p_comparison']['holds']})

        # 정상 실행은 comparisonPeriod 필드를 생략한다. 생략된 경우에는 원본 기간 비교를 유지한다.
        absent_period_work = {**self.work, 'ingestion': capture}
        self.assertNotIn('comparisonPeriod', absent_period_work)
        self.client.post.side_effect = [self.job, absent_period_work, {'status': 'running'}, self.finished]
        self.assertEqual(run_once(self.client), self.finished)
        baseline = self.client.post.call_args.args[1]['p_comparison']
        self.assertEqual([row['complexId'] for row in baseline['comparables']], ['comparison-a', 'comparison-b'])

    def test_user_conditions_cannot_override_comparison_period_and_binding_hold_keeps_period(self):
        self.job['input'] = {'kind': 'snapshot', 'snapshotId': self.snapshot_id}
        injected = {
            **self.work,
            'ingestion': self.capture,
            'conditions': {
                'comparisonPeriod': {'start': '2026-10-24', 'end': '2026-10-26'},
                'comparison': {'comparisonPeriod': {'start': '2026-10-24', 'end': '2026-10-26'},
                               'period': {'start': '2026-10-24', 'end': '2026-10-26'}},
            },
        }
        self.client.post.side_effect = [self.job, injected, {'status': 'running'}, self.finished]
        self.assertEqual(run_once(self.client), self.finished)
        comparison = self.client.post.call_args.args[1]['p_comparison']
        self.assertEqual(comparison['conditions']['period'], trade_period('2026-11-10', '2026-10-10', '2026-10-31'))
        self.assertEqual([row['complexId'] for row in comparison['comparables']], ['comparison-a', 'comparison-b'])

        held_work = {**self.work, 'ingestion': self.capture, 'useSyntheticFixture': False,
                     'selectionBindingIssue': 'target_identity_unverified',
                     'comparisonPeriod': {'start': '2026-10-24', 'end': '2026-10-26'}}
        self.client.post.side_effect = [self.job, held_work, {'status': 'running'}, self.finished]
        self.assertEqual(run_once(self.client), self.finished)
        held = self.client.post.call_args.args[1]['p_comparison']
        self.assertEqual(held['conditions']['period'], trade_period('2026-11-10', '2026-10-24', '2026-10-26'))
        self.assertEqual(held['comparables'], [])
        self.assertIn('target_identity_unverified', {hold['reasonCode'] for hold in held['holds']})

    def test_comparison_period_fails_without_writing_on_wrong_kind_or_invalid_request(self):
        valid_override = {'start': '2026-10-24', 'end': '2026-10-26'}
        # synthetic 실행에 comparisonPeriod(명시적 null 포함)가 오면 고정 자료 읽기나 저장 없이 실패한다.
        for candidate in (valid_override, None, {}):
            with self.subTest(kind='synthetic', comparison_period=candidate):
                self.client.reset_mock()
                synthetic_work = {**self.work, 'comparisonPeriod': candidate}
                self.client.post.side_effect = [self.job, synthetic_work, {'runId': self.run_id, 'status': 'failed'}]
                with patch('run_analysis_worker.FIXTURE') as fixture:
                    self.assertEqual(run_once(self.client), {'status': 'failed', 'runId': self.run_id})
                    fixture.read_bytes.assert_not_called()
                self.assertEqual([call.args[0] for call in self.client.post.call_args_list],
                                 ['claim_analysis_run', 'read_comparison_work', 'fail_analysis_run'])
                self.assertFalse(self.client.post.call_args.args[1]['p_retryable'])

        # notice 실행에 comparisonPeriod(명시적 null·형식 오류 포함)가 오면 외부 조회나 저장 없이 실패한다.
        notice_job = {
            'runId': self.run_id, 'generation': 1, 'leaseToken': str(uuid4()),
            'input': {'kind': 'notice', 'noticeSource': 'applyhome_apt', 'houseManageNo': '9900000001',
                      'noticeNo': '9900000042', 'edition': '2026-10-05', 'modelNo': '01'},
        }
        base_notice_work = {
            'conditions': {'ingestion_target': {'noticeSource': 'applyhome_apt', 'houseManageNo': '9900000001',
                                                'noticeNo': '9900000042', 'edition': '2026-10-05'},
                           'comparison': {'modelNo': '01'}},
            'ingestion': None, 'evidence': None, 'useSyntheticFixture': False, 'selectionBindingIssue': None,
            'noticeCapture': {'asOf': '2026-11-10', 'requestRegionCodes': ['99999'], 'allowOfficialPdf': False},
        }
        for candidate in (valid_override, None, {}, '2026-10-24..2026-10-26'):
            with self.subTest(kind='notice', comparison_period=candidate):
                api, pdf = Mock(), Mock()
                self.client.reset_mock()
                notice_work = {**base_notice_work, 'comparisonPeriod': candidate}
                self.client.post.side_effect = [notice_job, notice_work, {'runId': self.run_id, 'status': 'failed'}]
                self.assertEqual(run_once(self.client, notice=NoticeTransports(api=api, pdf=pdf)),
                                 {'status': 'failed', 'runId': self.run_id})
                api.assert_not_called()
                pdf.assert_not_called()
                self.assertEqual([call.args[0] for call in self.client.post.call_args_list],
                                 ['claim_analysis_run', 'read_comparison_work', 'fail_notice_analysis_run'])
                self.assertEqual(self.client.post.call_args.args[1]['p_error_code'], 'notice_selection_unverified')
                self.assertFalse(self.client.post.call_args.args[1]['p_retryable'])

        # snapshot 실행이라도 명시적 null·잘못된·모호한·원본 범위 밖의 comparisonPeriod는 쓰기 없이 실패한다.
        self.job['input'] = {'kind': 'snapshot', 'snapshotId': self.snapshot_id}
        bad_periods = [
            None,
            {},
            {'start': '2026-10-24'},
            {'start': None, 'end': '2026-10-26'},
            {'start': '2026-10-24', 'end': '2026-10-26', 'extra': '1'},
            '2026-10-24..2026-10-26',
            False,
            {'start': '2026-10-26', 'end': '2026-10-24'},
            {'start': '2026-10-09', 'end': '2026-10-26'},
            {'start': '2026-10-24', 'end': '2026-11-01'},
        ]
        for bad in bad_periods:
            with self.subTest(kind='snapshot', bad=bad):
                self.client.reset_mock()
                bad_work = {**self.work, 'ingestion': self.capture, 'useSyntheticFixture': True,
                            'selectionBindingIssue': 'target_identity_unverified', 'comparisonPeriod': bad}
                self.client.post.side_effect = [self.job, bad_work, {'runId': self.run_id, 'status': 'failed'}]
                with patch('run_analysis_worker.FIXTURE') as fixture:
                    if not (isinstance(bad, dict) and set(bad) == {'start', 'end'}
                            and isinstance(bad['start'], str) and isinstance(bad['end'], str)):
                        self.assertEqual(run_once(self.client), {'status': 'failed', 'runId': self.run_id})
                        fixture.read_bytes.assert_not_called()
                    else:
                        bad_work['useSyntheticFixture'] = False
                        self.assertEqual(run_once(self.client), {'status': 'failed', 'runId': self.run_id})
                        fixture.read_bytes.assert_not_called()
                self.assertEqual([call.args[0] for call in self.client.post.call_args_list],
                                 ['claim_analysis_run', 'read_comparison_work', 'fail_analysis_run'])
                self.assertFalse(self.client.post.call_args.args[1]['p_retryable'])

    def test_approved_comparison_conditions_on_snapshot_and_rejection_on_other_kinds(self):
        self.job['input'] = {'kind': 'snapshot', 'snapshotId': self.snapshot_id}
        capture = copy.deepcopy(self.capture)
        cond_work = {
            **self.work,
            'ingestion': capture,
            'comparisonPeriod': {'start': '2026-10-15', 'end': '2026-10-25'},
            'comparisonConditions': {
                'period': {'start': '2026-10-15', 'end': '2026-10-25'},
                'tradeKinds': ['sale'],
            },
        }
        self.client.post.side_effect = [self.job, cond_work, {'status': 'running'}, self.finished]
        self.assertEqual(run_once(self.client), self.finished)
        comparison = self.client.post.call_args.args[1]['p_comparison']
        self.assertEqual(comparison['conditions']['area'], {'basis': 'exclusive_area_class', 'class': 84})
        self.assertEqual(comparison['conditions']['tradeKinds'], ['sale'])
        self.assertEqual(comparison['conditions']['period']['start'], '2026-10-15')
        self.assertEqual(comparison['conditions']['period']['end'], '2026-10-25')
        self.assertEqual([row['complexId'] for row in comparison['comparables']], ['comparison-a'])
        self.assertIsInstance(comparison.get('candidatePool'), list)
        self.assertEqual(capture, self.capture)

        # synthetic 및 notice 실행에서는 comparisonConditions를 거부한다.
        self.job['input'] = {'kind': 'synthetic', 'fixture': 'ingestion-v0'}
        self.client.reset_mock()
        self.client.post.side_effect = [
            self.job,
            {**self.work, 'comparisonConditions': {'tradeKinds': ['sale']}},
            {'runId': self.run_id, 'status': 'failed'},
        ]
        with patch('run_analysis_worker.FIXTURE') as fixture:
            self.assertEqual(run_once(self.client), {'status': 'failed', 'runId': self.run_id})
            fixture.read_bytes.assert_not_called()
        self.assertFalse(self.client.post.call_args.args[1]['p_retryable'])

        notice_job = {
            'runId': self.run_id, 'generation': 1, 'leaseToken': str(uuid4()),
            'input': {'kind': 'notice', 'noticeSource': 'applyhome_apt', 'houseManageNo': '9900000001',
                      'noticeNo': '9900000042', 'edition': '2026-10-05', 'modelNo': '01'},
        }
        notice_work = {
            'conditions': {'ingestion_target': {'noticeSource': 'applyhome_apt', 'houseManageNo': '9900000001',
                                                'noticeNo': '9900000042', 'edition': '2026-10-05'},
                           'comparison': {'modelNo': '01'}},
            'ingestion': None, 'evidence': None, 'useSyntheticFixture': False, 'selectionBindingIssue': None,
            'noticeCapture': {'asOf': '2026-11-10', 'requestRegionCodes': ['99999'], 'allowOfficialPdf': False},
            'comparisonConditions': {'tradeKinds': ['sale']},
        }
        api, pdf = Mock(), Mock()
        self.client.reset_mock()
        self.client.post.side_effect = [notice_job, notice_work, {'runId': self.run_id, 'status': 'failed'}]
        self.assertEqual(run_once(self.client, notice=NoticeTransports(api=api, pdf=pdf)),
                         {'status': 'failed', 'runId': self.run_id})
        api.assert_not_called()
        pdf.assert_not_called()

        # Q-52: 공급면적 허용 범위(areaTolerancePercent)·충돌하는 기간·잘못된 형식의 comparisonConditions는 쓰기 없이 실패한다.
        self.job['input'] = {'kind': 'snapshot', 'snapshotId': self.snapshot_id}
        for bad in [
            None,
            {},
            {'areaTolerancePercent': '3'},
            {'areaTolerancePercent': '5'},
            {'areaTolerancePercent': '0'},
            {'areaTolerancePercent': '7'},
            {'tradeKinds': []},
            {'replacements': [{'complexId': 'a', 'replaceComplexId': 'a'}]},
            {'replacements': [{'complexId': 'x', 'replaceComplexId': 'a'}, {'complexId': 'a', 'replaceComplexId': 'b'}]},
            {'period': {'start': '2026-10-12', 'end': '2026-10-20'}},
        ]:
            self.client.reset_mock()
            bad_work = {**self.work, 'ingestion': capture, 'comparisonConditions': bad}
            if isinstance(bad, dict) and 'period' in bad:
                bad_work['comparisonPeriod'] = {'start': '2026-10-15', 'end': '2026-10-25'}
            self.client.post.side_effect = [self.job, bad_work, {'runId': self.run_id, 'status': 'failed'}]
            self.assertEqual(run_once(self.client), {'status': 'failed', 'runId': self.run_id})
            self.assertEqual(self.client.post.call_args.args[0], 'fail_analysis_run')
            self.assertFalse(self.client.post.call_args.args[1]['p_retryable'])
