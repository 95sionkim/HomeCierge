"""개발 Mac 서비스의 시각·권한·재시작을 합성 입력으로 검사한다."""
import json
import os
import plistlib
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock
from uuid import uuid4

import manage_notice_services as ops
from worker_rpc import WorkerRpcError


class NoticeServiceTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.secrets = Path(tmp.name)
        self.directory_state = ops.state_file(self.secrets, 'directory')
        self.at_deadline = datetime(2026, 11, 22, 0, 17, tzinfo=timezone.utc)

    def add_keys(self):
        for filename, key in [('worker.env', ops.WORKER_KEY), (ops.PROVIDER_KEY + '.env', ops.PROVIDER_KEY)]:
            ops.write_private(self.secrets / filename, (key + '=test-fixture\nOTHER=unused\n').encode())

    def test_limited_environment_and_file_permissions(self):
        self.add_keys()
        self.assertEqual(ops.worker_env(self.secrets), {
            'APP_ENV': 'development', 'SUPABASE_URL': ops.DEV_ORIGIN,
            ops.WORKER_KEY: 'test-fixture', ops.PROVIDER_KEY: 'test-fixture',
        })
        keyfile = self.secrets / 'worker.env'
        self.assertEqual(keyfile.stat().st_mode & 0o777, 0o600)
        keyfile.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'invalid_credential_file'):
            ops.worker_env(self.secrets)
        keyfile.unlink()
        keyfile.symlink_to(self.secrets / (ops.PROVIDER_KEY + '.env'))
        with self.assertRaisesRegex(ValueError, 'invalid_credential_file'):
            ops.worker_env(self.secrets)

    def test_key_probe_only_accepts_nonexistent_lease_and_cannot_claim_jobs(self):
        client = mock.Mock()
        client.post.side_effect = WorkerRpcError(404, 'PT404')
        ops.verify_worker(client)
        name, args = client.post.call_args.args
        self.assertEqual(name, 'read_comparison_work')
        self.assertEqual(set(args), {'p_run_id', 'p_lease_token', 'p_generation'})
        for status, code in [(401, None), (403, '42501'), (404, None), (503, None)]:
            client.post.side_effect = WorkerRpcError(status, code)
            with self.assertRaises(WorkerRpcError):
                ops.verify_worker(client)
        client.post.side_effect = None
        with self.assertRaisesRegex(ValueError, 'unexpected_worker_probe'):
            ops.verify_worker(client)

    def test_deletion_service_uses_only_its_worker_key_and_records_no_identifiers(self):
        ops.write_private(self.secrets / 'worker.env', (ops.WORKER_KEY + '=test-fixture\n').encode())
        with mock.patch.object(ops, 'WorkerRpc') as rpc, \
                mock.patch.object(ops, 'process_deletion', side_effect=['live_deleted', 'idle']) as process, \
                mock.patch.object(ops.time, 'sleep', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                ops.serve(self.secrets, 'deletion')
        self.assertEqual(set(rpc.call_args.args[0]), {'APP_ENV', 'SUPABASE_URL', ops.WORKER_KEY})
        self.assertEqual(process.call_count, 2)
        state = ops.read_state(ops.state_file(self.secrets, 'deletion'))
        self.assertEqual(state['status'], 'idle')
        self.assertEqual(set(state), {'status', 'checkedAt'})

    def test_daily_deadline_uses_korean_date_in_every_timezone(self):
        for tz in (timezone.utc, ops.KST, timezone(timedelta(hours=-8))):
            now = self.at_deadline.astimezone(tz)
            self.assertFalse(ops.refresh_due(now - timedelta(seconds=1), {}))
            self.assertTrue(ops.refresh_due(now, {}))
            old = {'attemptedOn': '2026-11-22'}
            self.assertFalse(ops.refresh_due(now + timedelta(hours=12), old))
            self.assertFalse(ops.refresh_due(now + timedelta(days=1, seconds=-1), old))
            self.assertTrue(ops.refresh_due(now + timedelta(days=1), old))

    @mock.patch.object(ops, 'refresh_once')
    @mock.patch.object(ops, 'verify_worker')
    def test_refresh_catches_up_once_and_preserves_previous_publication(self, verify, refresh):
        state = {}
        refresh.side_effect = [('published', {'noticeCount': 7, 'publishedAt': 'observation'}),
                               ('kept_previous', {})]
        for now in (self.at_deadline - timedelta(minutes=1), self.at_deadline + timedelta(hours=3),
                    self.at_deadline + timedelta(hours=4), self.at_deadline + timedelta(days=1)):
            ops.directory_tick(self.directory_state, state, now, {}, mock.sentinel.client)
            state = ops.read_state(self.directory_state)  # 로그인 재시작을 재현한다.
        self.assertEqual(refresh.call_count, 2)
        self.assertEqual(verify.call_count, 2)
        self.assertEqual((state['status'], state['noticeCount'], state['publishedAt']),
                         ('kept_previous', 7, 'observation'))
        state['status'] = 'waiting_for_worker_key'
        ops.directory_tick(self.directory_state, state, now, {}, mock.sentinel.client)
        self.assertEqual(state['status'], 'kept_previous')

    @mock.patch.object(ops, 'refresh_once')
    @mock.patch.object(ops, 'verify_worker', side_effect=WorkerRpcError(401))
    def test_unverified_key_does_not_use_the_public_api_or_mark_the_day(self, verify, refresh):
        state = {}
        with self.assertRaises(WorkerRpcError):
            ops.directory_tick(self.directory_state, state, self.at_deadline, {}, mock.sentinel.client)
        refresh.assert_not_called()
        self.assertFalse(self.directory_state.exists())
        self.assertTrue(ops.refresh_due(self.at_deadline, state))

    @mock.patch.object(ops.subprocess, 'run')
    def test_refresh_uses_worker_cli_and_retains_only_verified_summary(self, run):
        self.add_keys()
        env = ops.worker_env(self.secrets)
        run.return_value = mock.Mock(returncode=0, stdout=json.dumps({
            'status': 'published', 'noticeCount': 11, 'observedAt': 'observation', 'notices': ['unused'],
        }).encode())
        self.assertEqual(ops.refresh_once(env), ('published', {'noticeCount': 11, 'publishedAt': 'observation'}))
        args, call_env = run.call_args.args[0], run.call_args.kwargs['env']
        self.assertEqual(Path(args[1]).name, 'refresh_notice_index.py')
        self.assertEqual(args[2:], ['--live', '--publish'])
        self.assertNotIn('test-fixture', args)
        self.assertEqual(call_env[ops.PROVIDER_KEY], env[ops.PROVIDER_KEY])
        run.return_value = mock.Mock(returncode=2, stdout=b'{"status":"publication_unconfirmed"}')
        self.assertEqual(ops.refresh_once(env), ('publication_unconfirmed', {}))

    def test_worker_waits_with_no_remote_calls_until_both_keys_exist(self):
        for name in ('waiting_for_worker_key', 'waiting_for_provider_key'):
            with mock.patch.object(ops, 'WorkerRpc') as rpc, mock.patch.object(ops.time, 'sleep', side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    ops.serve(self.secrets, 'worker')
            rpc.assert_not_called()
            self.assertEqual(ops.read_state(ops.state_file(self.secrets, 'worker'))['status'], name)
            ops.write_private(self.secrets / 'worker.env', (ops.WORKER_KEY + '=test-fixture').encode())

    def test_service_runs_real_synthetic_comparison_and_returns_to_idle(self):
        self.add_keys()
        job_id, lease, snapshot = (str(uuid4()) for _ in range(3))
        job = {'runId': job_id, 'leaseToken': lease, 'generation': 1,
               'input': {'kind': 'synthetic', 'fixture': 'ingestion-v0'}}
        client = mock.Mock()
        client.post.side_effect = [job, {'conditions': {}, 'evidence': None, 'ingestion': None,
                                         'useSyntheticFixture': True, 'selectionBindingIssue': None},
                                   {}, {'runId': job_id, 'snapshotId': snapshot, 'status': 'finished'}, None]
        with mock.patch.dict(os.environ), mock.patch.object(ops, 'WorkerRpc', return_value=client), \
                mock.patch.object(ops.time, 'sleep', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                ops.serve(self.secrets, 'worker')
        names = [call.args[0] for call in client.post.call_args_list]
        self.assertEqual(names, ['claim_analysis_run', 'read_comparison_work', 'renew_analysis_run',
                                 'finish_analysis_comparison', 'claim_analysis_run'])
        finished = client.post.call_args_list[3].args[1]
        self.assertEqual(finished['p_comparison']['dataOrigin'], 'synthetic')
        state = ops.read_state(ops.state_file(self.secrets, 'worker'))
        self.assertEqual((state['lastJobStatus'], state['status']), ('finished', 'idle'))
        self.assertEqual(set(state), {'status', 'lastJobStatus', 'checkedAt'})

    def test_removing_directory_schedule_keeps_installed_worker(self):
        checkout = self.secrets / 'checkout'
        service_home = self.secrets / 'mac-user'
        agents = service_home / 'Library/LaunchAgents'
        agents.mkdir(parents=True)
        paths = {}
        for role, label in ops.LABELS.items():
            path = agents / (label + '.plist')
            path.write_bytes(plistlib.dumps(ops.launch_plist(checkout, checkout / '.secrets', role)))
            paths[role] = path
        with mock.patch.object(ops.sys, 'platform', 'darwin'), mock.patch.object(ops.Path, 'home', return_value=service_home), \
                mock.patch.object(ops, 'job_state', return_value='running'), mock.patch.object(ops.subprocess, 'run') as run, \
                mock.patch('builtins.print'):
            ops.manage(checkout, 'uninstall', requested_role='directory')
        self.assertTrue(paths['worker'].exists())
        self.assertFalse(paths['directory'].exists())
        run.assert_called_once_with([ops.LAUNCHCTL, 'bootout', f'gui/{os.getuid()}/' + ops.LABELS['directory']],
                                    check=True)

    def test_agent_role_waits_for_worker_and_llm_keys_and_processes_queue(self):
        self.assertIn('agent', ops.LABELS)
        # 키가 없으면 원격 호출 없이 waiting_for_worker_key -> waiting_for_llm_key로 대기한다.
        for expected_status in ('waiting_for_worker_key', 'waiting_for_llm_key'):
            with mock.patch.object(ops, 'WorkerRpc') as rpc, \
                    mock.patch.object(ops.time, 'sleep', side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    ops.serve(self.secrets, 'agent')
            rpc.assert_not_called()
            self.assertEqual(ops.read_state(ops.state_file(self.secrets, 'agent'))['status'], expected_status)
            ops.write_private(self.secrets / 'worker.env', (ops.WORKER_KEY + '=test-fixture\n').encode())

        # OPENAI_API_KEY만 등록하면 공공데이터 키 없이도 에이전트 대기열을 처리한다.
        ops.write_private(self.secrets / (ops.LLM_KEY + '.env'), (ops.LLM_KEY + '=sk-synthetic-test\n').encode())
        with mock.patch.object(ops, 'WorkerRpc') as rpc, \
                mock.patch.object(ops, 'process_agent_reply', side_effect=[{'status': 'answered'}, {'status': 'idle'}]) as proc, \
                mock.patch.object(ops.time, 'sleep', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                ops.serve(self.secrets, 'agent')
        self.assertEqual(set(rpc.call_args.args[0]), {'APP_ENV', 'SUPABASE_URL', ops.WORKER_KEY, ops.LLM_KEY})
        self.assertEqual(proc.call_count, 2)
        state = ops.read_state(ops.state_file(self.secrets, 'agent'))
        self.assertEqual((state['lastJobStatus'], state['status']), ('answered', 'idle'))
        self.assertEqual(set(state), {'status', 'lastJobStatus', 'checkedAt'})
        self.assertNotIn('sk-synthetic-test', json.dumps(state))


if __name__ == '__main__':
    unittest.main()
