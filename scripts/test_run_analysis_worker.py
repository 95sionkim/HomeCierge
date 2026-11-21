"""합성 DB 응답으로 작업 중단·불확실한 커밋·임대 교체 경계를 검증한다."""
import io
import json
from unittest import TestCase
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from uuid import uuid4

from ingestion_pages import loads_source_json
from replay_ingestion import replay
from run_analysis_worker import FIXTURE, run_once
from worker_rpc import WorkerRpc, WorkerRpcError, WorkerRpcResponseTooLarge


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
        for error in (WorkerRpcError(), WorkerRpcError(503), WorkerRpcResponseTooLarge()):
            self.client.post.side_effect = [self.job, self.work, {'status': 'running'}, error]
            with self.assertRaises(WorkerRpcError):
                run_once(self.client)
            self.assertEqual(self.client.post.call_args.args[0], 'finish_analysis_comparison')

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
