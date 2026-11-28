"""개발 Mac 서비스(개발·운영 분리)의 시각·권한·재시작·RPC 환경 가드를 합성 입력으로 검사한다."""
import base64
import io
import json
import os
import plistlib
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock
from uuid import uuid4

import manage_notice_services as ops
from worker_rpc import ENVIRONMENTS, PROJECT_ORIGINS, WorkerRpc, WorkerRpcError


def synthetic_jwt(role):
    header = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').decode().rstrip('=')
    payload = base64.urlsafe_b64encode(json.dumps({'role': role}).encode()).decode().rstrip('=')
    return f'{header}.{payload}.synthetic-signature'


class WorkerRpcMatrixTests(unittest.TestCase):
    def test_project_origins_are_defined_once_and_shared(self):
        self.assertEqual(ENVIRONMENTS, ('development', 'production'))
        self.assertEqual(PROJECT_ORIGINS['development'], 'https://jcaelooqogosbzrfyrhe.supabase.co')
        self.assertEqual(PROJECT_ORIGINS['production'], 'https://rwomqnyhqpnejytdzwfn.supabase.co')
        self.assertEqual(ops.DEV_ORIGIN, PROJECT_ORIGINS['development'])
        self.assertEqual(ops.PROD_ORIGIN, PROJECT_ORIGINS['production'])

    def test_allowed_environment_and_origin_combinations(self):
        dev_url = PROJECT_ORIGINS['development']
        prod_url = PROJECT_ORIGINS['production']
        allowed = [
            ({'SUPABASE_URL': 'http://127.0.0.1:54321'}, 'http://127.0.0.1:54321/rest/v1/rpc/'),
            ({'APP_ENV': 'development', 'SUPABASE_URL': 'http://localhost'}, 'http://localhost/rest/v1/rpc/'),
            ({'APP_ENV': 'development', 'SUPABASE_URL': 'https://localhost:54321/'}, 'https://localhost:54321/rest/v1/rpc/'),
            ({'APP_ENV': 'development', 'SUPABASE_URL': 'http://[::1]:54321'}, 'http://[::1]:54321/rest/v1/rpc/'),
            ({'APP_ENV': 'development', 'SUPABASE_URL': dev_url}, dev_url + '/rest/v1/rpc/'),
            ({'APP_ENV': 'development', 'SUPABASE_URL': dev_url + ':443'}, dev_url + ':443/rest/v1/rpc/'),
            ({'APP_ENV': 'development', 'SUPABASE_URL': dev_url + '/'}, dev_url + '/rest/v1/rpc/'),
            ({'APP_ENV': 'development', 'NODE_ENV': 'development', 'SUPABASE_URL': dev_url}, dev_url + '/rest/v1/rpc/'),
            ({'APP_ENV': 'production', 'SUPABASE_URL': prod_url}, prod_url + '/rest/v1/rpc/'),
            ({'APP_ENV': 'production', 'SUPABASE_URL': prod_url + ':443'}, prod_url + ':443/rest/v1/rpc/'),
            ({'APP_ENV': 'production', 'SUPABASE_URL': prod_url + '/'}, prod_url + '/rest/v1/rpc/'),
            ({'APP_ENV': 'production', 'NODE_ENV': 'production', 'SUPABASE_URL': prod_url}, prod_url + '/rest/v1/rpc/'),
        ]
        for env_patch, expected_base in allowed:
            for key in ('sb_secret_synthetic', synthetic_jwt('service_role')):
                env = {**env_patch, 'SUPABASE_WORKER_KEY': key}
                with self.subTest(env=env_patch, jwt='.' in key):
                    client = WorkerRpc(env, opener=mock.Mock())
                    self.assertEqual(client.base, expected_base)

    def test_cross_combinations_vercel_envs_and_malformed_urls_are_rejected(self):
        dev_url = PROJECT_ORIGINS['development']
        prod_url = PROJECT_ORIGINS['production']
        rejected = [
            # 교차 조합 전부
            {'APP_ENV': 'production', 'SUPABASE_URL': dev_url},
            {'APP_ENV': 'development', 'SUPABASE_URL': prod_url},
            {'SUPABASE_URL': prod_url},
            {'APP_ENV': 'production', 'SUPABASE_URL': 'http://127.0.0.1:54321'},
            {'APP_ENV': 'production', 'SUPABASE_URL': 'http://localhost'},
            {'APP_ENV': 'production', 'SUPABASE_URL': 'https://localhost'},
            {'APP_ENV': 'production', 'SUPABASE_URL': 'http://[::1]:54321'},
            # 허용되지 않은 APP_ENV
            {'APP_ENV': 'preview', 'SUPABASE_URL': dev_url},
            {'APP_ENV': 'staging', 'SUPABASE_URL': prod_url},
            {'APP_ENV': '', 'SUPABASE_URL': dev_url},
            # 개발 환경에서의 NODE_ENV=production 거부
            {'APP_ENV': 'development', 'NODE_ENV': 'production', 'SUPABASE_URL': dev_url},
            {'APP_ENV': 'development', 'NODE_ENV': 'production', 'SUPABASE_URL': 'http://127.0.0.1:54321'},
            {'NODE_ENV': 'production', 'SUPABASE_URL': 'http://127.0.0.1:54321'},
            # Vercel 함수 환경 변수가 있으면 어떤 조합이든 거부
            {'APP_ENV': 'development', 'SUPABASE_URL': dev_url, 'VERCEL_ENV': 'development'},
            {'APP_ENV': 'development', 'SUPABASE_URL': dev_url, 'VERCEL_ENV': 'preview'},
            {'APP_ENV': 'development', 'SUPABASE_URL': dev_url, 'VERCEL_ENV': 'production'},
            {'APP_ENV': 'development', 'SUPABASE_URL': 'http://127.0.0.1:54321', 'VERCEL_ENV': 'preview'},
            {'APP_ENV': 'development', 'SUPABASE_URL': dev_url, 'VERCEL_TARGET_ENV': 'development'},
            {'APP_ENV': 'development', 'SUPABASE_URL': dev_url, 'VERCEL_TARGET_ENV': 'preview'},
            {'APP_ENV': 'development', 'SUPABASE_URL': dev_url, 'VERCEL_TARGET_ENV': 'production'},
            {'APP_ENV': 'production', 'SUPABASE_URL': prod_url, 'VERCEL_ENV': 'development'},
            {'APP_ENV': 'production', 'SUPABASE_URL': prod_url, 'VERCEL_ENV': 'preview'},
            {'APP_ENV': 'production', 'SUPABASE_URL': prod_url, 'VERCEL_ENV': 'production'},
            {'APP_ENV': 'production', 'SUPABASE_URL': prod_url, 'VERCEL_TARGET_ENV': 'development'},
            {'APP_ENV': 'production', 'SUPABASE_URL': prod_url, 'VERCEL_TARGET_ENV': 'preview'},
            {'APP_ENV': 'production', 'SUPABASE_URL': prod_url, 'VERCEL_TARGET_ENV': 'production'},
            # 운영 주소의 잘못된 스킴·포트·경로·쿼리·프래그먼트·사용자 정보·타 호스트
            {'APP_ENV': 'production', 'SUPABASE_URL': 'http://rwomqnyhqpnejytdzwfn.supabase.co'},
            {'APP_ENV': 'production', 'SUPABASE_URL': prod_url + ':444'},
            {'APP_ENV': 'production', 'SUPABASE_URL': prod_url + ':80'},
            {'APP_ENV': 'production', 'SUPABASE_URL': prod_url + ':bad'},
            {'APP_ENV': 'production', 'SUPABASE_URL': prod_url + ':'},
            {'APP_ENV': 'production', 'SUPABASE_URL': prod_url + '/rest/v1'},
            {'APP_ENV': 'production', 'SUPABASE_URL': prod_url + '?x=1'},
            {'APP_ENV': 'production', 'SUPABASE_URL': prod_url + '?'},
            {'APP_ENV': 'production', 'SUPABASE_URL': prod_url + '#frag'},
            {'APP_ENV': 'production', 'SUPABASE_URL': prod_url + '#'},
            {'APP_ENV': 'production', 'SUPABASE_URL': 'https://user@rwomqnyhqpnejytdzwfn.supabase.co'},
            {'APP_ENV': 'production', 'SUPABASE_URL': 'https://user:pass@rwomqnyhqpnejytdzwfn.supabase.co'},
            {'APP_ENV': 'production', 'SUPABASE_URL': 'https://@rwomqnyhqpnejytdzwfn.supabase.co'},
            {'APP_ENV': 'production', 'SUPABASE_URL': 'https://other.supabase.co'},
            {'APP_ENV': 'production', 'SUPABASE_URL': ' ' + prod_url},
            # 개발 주소의 잘못된 스킴·포트·경로·쿼리·프래그먼트·사용자 정보
            {'APP_ENV': 'development', 'SUPABASE_URL': 'http://jcaelooqogosbzrfyrhe.supabase.co'},
            {'APP_ENV': 'development', 'SUPABASE_URL': dev_url + ':444'},
            {'APP_ENV': 'development', 'SUPABASE_URL': dev_url + ':'},
            {'APP_ENV': 'development', 'SUPABASE_URL': dev_url + '/extra'},
            {'APP_ENV': 'development', 'SUPABASE_URL': dev_url + '?k=v'},
            {'APP_ENV': 'development', 'SUPABASE_URL': dev_url + '#hash'},
            {'APP_ENV': 'development', 'SUPABASE_URL': 'https://user@jcaelooqogosbzrfyrhe.supabase.co'},
            {'APP_ENV': 'development', 'SUPABASE_URL': 'https://other.supabase.co'},
        ]
        for env_patch in rejected:
            env = {**env_patch, 'SUPABASE_WORKER_KEY': 'sb_secret_synthetic'}
            with self.subTest(env=env_patch), self.assertRaises(ValueError):
                WorkerRpc(env, opener=mock.Mock())

    def test_invalid_worker_keys_are_rejected_in_both_environments(self):
        for environment, url in PROJECT_ORIGINS.items():
            for bad_key in ('', 'sb_publishable_synthetic', synthetic_jwt('anon'),
                            synthetic_jwt('authenticated'), 'not.a.valid-jwt'):
                with self.subTest(environment=environment, bad_key=bad_key), self.assertRaises(ValueError):
                    WorkerRpc({'APP_ENV': environment, 'SUPABASE_URL': url, 'SUPABASE_WORKER_KEY': bad_key},
                              opener=mock.Mock())


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

    def test_environment_labels_and_secret_paths_are_isolated(self):
        self.assertEqual(ops.labels_for('development'), {
            'worker': 'kr.homecierge.development.notice-worker',
            'directory': 'kr.homecierge.development.notice-directory',
            'deletion': 'kr.homecierge.development.data-deletion',
            'agent': 'kr.homecierge.development.agent-worker',
        })
        self.assertEqual(ops.labels_for('production'), {
            'worker': 'kr.homecierge.production.notice-worker',
            'directory': 'kr.homecierge.production.notice-directory',
            'deletion': 'kr.homecierge.production.data-deletion',
            'agent': 'kr.homecierge.production.agent-worker',
        })
        self.assertEqual(ops.env_secret_dir(self.secrets, 'development'), self.secrets)
        self.assertEqual(ops.env_secret_dir(self.secrets, 'production'), self.secrets / 'production')
        self.assertEqual(ops.state_file(self.secrets, 'worker', 'development'),
                         self.secrets / 'notice-services' / 'worker.json')
        self.assertEqual(ops.state_file(self.secrets, 'worker', 'production'),
                         self.secrets / 'production' / 'notice-services' / 'worker.json')
        with self.assertRaises(ValueError):
            ops.labels_for('staging')

    def test_production_worker_key_never_falls_back_to_development_and_shared_keys_follow_precedence(self):
        # 개발 키만 있으면 운영 worker_env는 반드시 waiting_for_worker_key로 대기한다.
        self.add_keys()
        ops.write_private(self.secrets / (ops.KAKAO_KEY + '.env'), (ops.KAKAO_KEY + '=shared-kakao\n').encode())
        ops.write_private(self.secrets / (ops.LLM_KEY + '.env'), (ops.LLM_KEY + '=shared-llm\n').encode())
        with self.assertRaisesRegex(ValueError, 'waiting_for_worker_key'):
            ops.worker_env(self.secrets, environment='production')

        # 운영 worker.env를 추가하면 외부 API 키는 .secrets/<이름>.env를 대체로 읽는다.
        prod_dir = self.secrets / 'production'
        ops.write_private(prod_dir / 'worker.env', (ops.WORKER_KEY + '=sb_secret_prod_synthetic\n').encode())
        self.assertEqual(ops.worker_env(self.secrets, environment='production'), {
            'APP_ENV': 'production',
            'SUPABASE_URL': PROJECT_ORIGINS['production'],
            ops.WORKER_KEY: 'sb_secret_prod_synthetic',
            ops.PROVIDER_KEY: 'test-fixture',
            ops.KAKAO_KEY: 'shared-kakao',
        })
        self.assertEqual(
            ops.worker_env(self.secrets, require_provider=False, require_llm=True, environment='production'),
            {
                'APP_ENV': 'production',
                'SUPABASE_URL': PROJECT_ORIGINS['production'],
                ops.WORKER_KEY: 'sb_secret_prod_synthetic',
                ops.LLM_KEY: 'shared-llm',
            },
        )

        # .secrets/production/<이름>.env가 있으면 공용(.secrets/)보다 우선한다.
        ops.write_private(prod_dir / (ops.PROVIDER_KEY + '.env'), (ops.PROVIDER_KEY + '=prod-provider\n').encode())
        ops.write_private(prod_dir / (ops.KAKAO_KEY + '.env'), (ops.KAKAO_KEY + '=prod-kakao\n').encode())
        ops.write_private(prod_dir / (ops.LLM_KEY + '.env'), (ops.LLM_KEY + '=prod-llm\n').encode())
        self.assertEqual(ops.worker_env(self.secrets, environment='production'), {
            'APP_ENV': 'production',
            'SUPABASE_URL': PROJECT_ORIGINS['production'],
            ops.WORKER_KEY: 'sb_secret_prod_synthetic',
            ops.PROVIDER_KEY: 'prod-provider',
            ops.KAKAO_KEY: 'prod-kakao',
        })
        self.assertEqual(
            ops.worker_env(self.secrets, require_provider=False, require_llm=True, environment='production')[ops.LLM_KEY],
            'prod-llm',
        )

        # 개발 환경은 운영 키를 읽지 않는다.
        self.assertEqual(ops.worker_env(self.secrets, environment='development'), {
            'APP_ENV': 'development',
            'SUPABASE_URL': PROJECT_ORIGINS['development'],
            ops.WORKER_KEY: 'test-fixture',
            ops.PROVIDER_KEY: 'test-fixture',
            ops.KAKAO_KEY: 'shared-kakao',
        })

        # 운영 전용 파일의 권한이 잘못되면 공용 키로 조용히 대체하지 않고 즉시 거부한다.
        prod_provider = prod_dir / (ops.PROVIDER_KEY + '.env')
        prod_provider.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'invalid_credential_file'):
            ops.worker_env(self.secrets, environment='production')
        prod_provider.chmod(0o600)

        # 운영 전용 파일이 빈 값이면 파일이 존재하므로 공용 키로 대체하지 않는다.
        ops.write_private(prod_dir / (ops.KAKAO_KEY + '.env'), (ops.KAKAO_KEY + '=\n').encode())
        self.assertNotIn(ops.KAKAO_KEY, ops.worker_env(self.secrets, environment='production'))

        # 운영 전용 파일이 심볼릭 링크이면 거부한다.
        prod_provider.unlink()
        prod_provider.symlink_to(self.secrets / (ops.PROVIDER_KEY + '.env'))
        with self.assertRaisesRegex(ValueError, 'invalid_credential_file'):
            ops.worker_env(self.secrets, environment='production')

    def test_production_serve_isolates_state_and_passes_production_environment(self):
        self.add_keys()
        ops.record(ops.state_file(self.secrets, 'deletion', 'development'), {}, 'idle')
        prod_dir = self.secrets / 'production'
        ops.write_private(prod_dir / 'worker.env', (ops.WORKER_KEY + '=sb_secret_prod_synthetic\n').encode())
        with mock.patch.object(ops, 'WorkerRpc') as rpc, \
                mock.patch.object(ops, 'process_deletion', side_effect=['live_deleted', 'idle']) as process, \
                mock.patch.object(ops.time, 'sleep', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                ops.serve(self.secrets, 'deletion', environment='production')
        self.assertEqual(rpc.call_args.args[0], {
            'APP_ENV': 'production',
            'SUPABASE_URL': PROJECT_ORIGINS['production'],
            ops.WORKER_KEY: 'sb_secret_prod_synthetic',
        })
        self.assertEqual(process.call_count, 2)
        self.assertEqual(prod_dir.stat().st_mode & 0o777, 0o700)
        prod_state = ops.read_state(ops.state_file(self.secrets, 'deletion', 'production'))
        dev_state = ops.read_state(ops.state_file(self.secrets, 'deletion', 'development'))
        self.assertEqual(prod_state['status'], 'idle')
        self.assertEqual(dev_state['status'], 'idle')
        self.assertNotEqual(ops.state_file(self.secrets, 'deletion', 'production'),
                            ops.state_file(self.secrets, 'deletion', 'development'))

        # worker 역할은 실행 중에만 운영 환경 변수를 반영하고 종료 후 원복한다.
        observed_env = {}

        def fake_run_once(client, *, notice=None):
            for key in ('APP_ENV', 'SUPABASE_URL', ops.WORKER_KEY, ops.PROVIDER_KEY, ops.KAKAO_KEY):
                observed_env[key] = os.environ.get(key)
            return {'status': 'idle'}

        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(ops, 'WorkerRpc'), \
                mock.patch.object(ops, 'run_once', side_effect=fake_run_once), \
                mock.patch.object(ops.time, 'sleep', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                ops.serve(self.secrets, 'worker', environment='production')
            self.assertNotIn(ops.WORKER_KEY, os.environ)
            self.assertNotIn('APP_ENV', os.environ)
        self.assertEqual(observed_env, {
            'APP_ENV': 'production',
            'SUPABASE_URL': PROJECT_ORIGINS['production'],
            ops.WORKER_KEY: 'sb_secret_prod_synthetic',
            ops.PROVIDER_KEY: 'test-fixture',
            ops.KAKAO_KEY: None,
        })

    def test_set_key_production_verifies_prod_origin_and_keeps_dev_key_untouched(self):
        checkout = self.secrets / 'checkout'
        dev_key_path = checkout / '.secrets' / 'worker.env'
        prod_key_path = checkout / '.secrets' / 'production' / 'worker.env'
        ops.write_private(dev_key_path, (ops.WORKER_KEY + '=sb_secret_dev_synthetic\n').encode())

        # 권한 검증 성공 시 .secrets/production/worker.env만 저장(0700 폴더, 0600 파일)한다.
        seen_envs = []

        def fake_rpc(env):
            seen_envs.append(env)
            return mock.sentinel.prod_client

        with mock.patch.object(ops.sys, 'platform', 'darwin'), \
                mock.patch.object(ops.sys.stdin, 'isatty', return_value=True), \
                mock.patch.object(ops.getpass, 'getpass', return_value='sb_secret_prod_synthetic') as prompt, \
                mock.patch.object(ops, 'WorkerRpc', side_effect=fake_rpc), \
                mock.patch.object(ops, 'verify_worker') as verify, \
                redirect_stdout(io.StringIO()) as out:
            ops.manage(checkout, 'set-key', environment='production')
        self.assertIn('운영', prompt.call_args.args[0])
        self.assertEqual(seen_envs, [{
            'APP_ENV': 'production',
            'SUPABASE_URL': PROJECT_ORIGINS['production'],
            ops.WORKER_KEY: 'sb_secret_prod_synthetic',
        }])
        verify.assert_called_once_with(mock.sentinel.prod_client)
        self.assertEqual((checkout / '.secrets' / 'production').stat().st_mode & 0o777, 0o700)
        self.assertEqual(prod_key_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(ops.read_field(prod_key_path, ops.WORKER_KEY), 'sb_secret_prod_synthetic')
        self.assertEqual(ops.read_field(dev_key_path, ops.WORKER_KEY), 'sb_secret_dev_synthetic')
        self.assertIn('운영 작업자 권한을 확인하고 키를 저장했습니다.', out.getvalue())

        # verify_worker가 실패하면 기존 운영 키 파일을 덮어쓰지 않는다.
        with mock.patch.object(ops.sys, 'platform', 'darwin'), \
                mock.patch.object(ops.sys.stdin, 'isatty', return_value=True), \
                mock.patch.object(ops.getpass, 'getpass', return_value='sb_secret_bad_key'), \
                mock.patch.object(ops, 'verify_worker', side_effect=WorkerRpcError(401)):
            with self.assertRaises(WorkerRpcError):
                ops.manage(checkout, 'set-key', environment='production')
        self.assertEqual(ops.read_field(prod_key_path, ops.WORKER_KEY), 'sb_secret_prod_synthetic')

        # 비대화형 stdin은 거부한다.
        with mock.patch.object(ops.sys, 'platform', 'darwin'), \
                mock.patch.object(ops.sys.stdin, 'isatty', return_value=False):
            with self.assertRaisesRegex(ValueError, '운영 작업자 키'):
                ops.manage(checkout, 'set-key', environment='production')

    def test_install_status_uninstall_keep_development_and_production_isolated(self):
        checkout = self.secrets / 'checkout'
        service_home = self.secrets / 'mac-user'
        agents = service_home / 'Library/LaunchAgents'
        agents.mkdir(parents=True)
        dev_secrets = checkout / '.secrets'
        ops.write_private(dev_secrets / (ops.PROVIDER_KEY + '.env'), (ops.PROVIDER_KEY + '=dev-provider\n').encode())
        ops.record(ops.state_file(dev_secrets, 'worker', 'development'), {}, 'idle', lastJobStatus='finished')
        ops.record(ops.state_file(dev_secrets, 'worker', 'production'), {}, 'waiting_for_worker_key')

        # 기존 개발 플리스트를 먼저 배치한다(구형 형식 호환 포함).
        dev_plists = {}
        for role, label in ops.labels_for('development').items():
            path = agents / (label + '.plist')
            legacy = {
                'Label': label,
                'ProgramArguments': ['/usr/bin/python3', '-B', str(checkout / 'scripts/manage_notice_services.py'),
                                     'agent', role, str(dev_secrets)],
            }
            path.write_bytes(plistlib.dumps(legacy))
            dev_plists[role] = path
        dev_snapshot = {role: path.read_bytes() for role, path in dev_plists.items()}

        api_env_file = self.secrets / 'prod-api.env'
        api_env_file.write_text(f'{ops.PROVIDER_KEY}=prod-provider\n{ops.KAKAO_KEY}=prod-kakao\n', encoding='utf-8')
        fake_runtime = checkout / '.secrets' / 'production' / 'notice-services' / 'releases' / 'synthetic'

        with mock.patch.object(ops.sys, 'platform', 'darwin'), \
                mock.patch.object(ops.Path, 'home', return_value=service_home), \
                mock.patch.object(ops, 'release', return_value=fake_runtime) as release_mock, \
                mock.patch.object(ops, 'job_state', return_value='not_loaded'), \
                mock.patch.object(ops.subprocess, 'run') as run, \
                redirect_stdout(io.StringIO()) as out:
            ops.manage(checkout, 'install', api_env=api_env_file, environment='production')

        release_mock.assert_called_once_with(checkout, dev_secrets, 'production')
        # 개발 플리스트와 개발 키 파일은 전혀 바뀌지 않는다.
        for role, path in dev_plists.items():
            self.assertEqual(path.read_bytes(), dev_snapshot[role])
        self.assertEqual(ops.read_field(dev_secrets / (ops.PROVIDER_KEY + '.env'), ops.PROVIDER_KEY), 'dev-provider')
        self.assertEqual(
            ops.read_field(dev_secrets / 'production' / (ops.PROVIDER_KEY + '.env'), ops.PROVIDER_KEY),
            'prod-provider',
        )
        self.assertEqual(
            ops.read_field(dev_secrets / 'production' / (ops.KAKAO_KEY + '.env'), ops.KAKAO_KEY),
            'prod-kakao',
        )
        self.assertEqual((dev_secrets / 'production').stat().st_mode & 0o777, 0o700)

        # 운영 플리스트 4개만 생성되고 launchctl bootstrap도 운영 플리스트만 호출된다.
        prod_labels = ops.labels_for('production')
        bootstrapped = [call.args[0] for call in run.call_args_list]
        self.assertEqual(len(bootstrapped), 4)
        for role, label in prod_labels.items():
            plist_path = agents / (label + '.plist')
            self.assertTrue(plist_path.exists())
            parsed = plistlib.loads(plist_path.read_bytes())
            self.assertEqual(parsed['Label'], label)
            self.assertEqual(parsed['ProgramArguments'][-5:],
                             ['agent', '--environment', 'production', role, str(dev_secrets)])
            self.assertIn([ops.LAUNCHCTL, 'bootstrap', f'gui/{os.getuid()}', str(plist_path)], bootstrapped)

        # status 출력은 지정한 운영 환경의 4개 서비스와 운영 상태만 포함한다.
        prod_lines = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual([line['label'] for line in prod_lines], list(prod_labels.values()))
        self.assertTrue(all(line['environment'] == 'production' for line in prod_lines))
        worker_status = next(line for line in prod_lines if line['service'] == 'worker')
        self.assertEqual(worker_status['status'], 'waiting_for_worker_key')
        self.assertNotIn('lastJobStatus', worker_status)

        # development status는 개발 환경의 4개 서비스와 개발 상태만 보인다.
        with mock.patch.object(ops.sys, 'platform', 'darwin'), \
                mock.patch.object(ops.Path, 'home', return_value=service_home), \
                mock.patch.object(ops, 'job_state', return_value='running'), \
                redirect_stdout(io.StringIO()) as dev_out:
            ops.manage(checkout, 'status', environment='development')
        dev_lines = [json.loads(line) for line in dev_out.getvalue().splitlines()]
        self.assertEqual([line['label'] for line in dev_lines], list(ops.labels_for('development').values()))
        self.assertTrue(all(line['environment'] == 'development' for line in dev_lines))
        dev_worker = next(line for line in dev_lines if line['service'] == 'worker')
        self.assertEqual((dev_worker['status'], dev_worker['lastJobStatus']), ('idle', 'finished'))

        # 구형 개발 플리스트로도 개발 uninstall이 정상 동작하며 운영 플리스트는 건드리지 않는다.
        with mock.patch.object(ops.sys, 'platform', 'darwin'), \
                mock.patch.object(ops.Path, 'home', return_value=service_home), \
                mock.patch.object(ops, 'job_state', return_value='running'), \
                mock.patch.object(ops.subprocess, 'run') as dev_run, \
                mock.patch('builtins.print'):
            ops.manage(checkout, 'uninstall', requested_role='directory', environment='development')
        self.assertFalse(dev_plists['directory'].exists())
        self.assertTrue((agents / (prod_labels['directory'] + '.plist')).exists())
        dev_run.assert_called_once_with(
            [ops.LAUNCHCTL, 'bootout', f'gui/{os.getuid()}/' + ops.labels_for('development')['directory']],
            check=True,
        )

        # 운영 uninstall은 운영 플리스트만 제거하고 남은 개발 플리스트는 유지한다.
        with mock.patch.object(ops.sys, 'platform', 'darwin'), \
                mock.patch.object(ops.Path, 'home', return_value=service_home), \
                mock.patch.object(ops, 'job_state', return_value='running'), \
                mock.patch.object(ops.subprocess, 'run') as prod_run, \
                mock.patch('builtins.print'):
            ops.manage(checkout, 'uninstall', environment='production')
        self.assertEqual(prod_run.call_count, 4)
        for label in prod_labels.values():
            self.assertFalse((agents / (label + '.plist')).exists())
        self.assertTrue(dev_plists['worker'].exists())

    def test_plist_checkout_conflict_is_enforced_per_environment(self):
        checkout_a = self.secrets / 'checkout-a'
        checkout_b = self.secrets / 'checkout-b'
        service_home = self.secrets / 'mac-user'
        agents = service_home / 'Library/LaunchAgents'
        agents.mkdir(parents=True)

        # checkout-a의 개발·운영 플리스트를 배치한다.
        dev_label = ops.labels_for('development')['worker']
        prod_label = ops.labels_for('production')['worker']
        (agents / (dev_label + '.plist')).write_bytes(
            plistlib.dumps(ops.launch_plist(checkout_a, checkout_a / '.secrets', 'worker', 'development'))
        )
        (agents / (prod_label + '.plist')).write_bytes(
            plistlib.dumps(ops.launch_plist(checkout_a, checkout_a / '.secrets', 'worker', 'production'))
        )

        # checkout-b가 운영 worker를 설치/제거하려 하면 다른 체크아웃 충돌로 거부된다.
        for cmd in ('install', 'uninstall'):
            with mock.patch.object(ops.sys, 'platform', 'darwin'), \
                    mock.patch.object(ops.Path, 'home', return_value=service_home), \
                    mock.patch.object(ops, 'release', return_value=checkout_b), \
                    mock.patch.object(ops, 'job_state', return_value='running'), \
                    mock.patch.object(ops.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, '같은 이름의 다른 체크아웃 서비스가 있습니다.'):
                    ops.manage(checkout_b, cmd, requested_role='worker', environment='production')
                run.assert_not_called()

        # 운영 플리스트를 제거하면 checkout-a의 개발 플리스트가 있어도 checkout-b는 운영을 설치할 수 있다.
        (agents / (prod_label + '.plist')).unlink()
        with mock.patch.object(ops.sys, 'platform', 'darwin'), \
                mock.patch.object(ops.Path, 'home', return_value=service_home), \
                mock.patch.object(ops, 'release', return_value=checkout_b), \
                mock.patch.object(ops, 'job_state', return_value='not_loaded'), \
                mock.patch.object(ops.subprocess, 'run') as run, \
                mock.patch('builtins.print'):
            ops.manage(checkout_b, 'install', requested_role='worker', environment='production')
        run.assert_called_once()
        self.assertTrue((agents / (dev_label + '.plist')).exists())

        # 운영 플리스트에 --environment development가 들어 있으면 같은 체크아웃이어도 거부한다.
        tampered = ops.launch_plist(checkout_b, checkout_b / '.secrets', 'worker', 'development')
        tampered['Label'] = prod_label
        (agents / (prod_label + '.plist')).write_bytes(plistlib.dumps(tampered))
        with mock.patch.object(ops.sys, 'platform', 'darwin'), \
                mock.patch.object(ops.Path, 'home', return_value=service_home), \
                mock.patch.object(ops, 'job_state', return_value='running'), \
                mock.patch.object(ops.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, '같은 이름의 다른 체크아웃 서비스가 있습니다.'):
                ops.manage(checkout_b, 'uninstall', requested_role='worker', environment='production')
            run.assert_not_called()

    def test_cli_parses_environment_flag_for_all_subcommands_and_agent(self):
        with mock.patch.object(ops, 'serve') as serve_mock:
            ops.main(['agent', '--environment', 'production', 'worker', str(self.secrets)])
            ops.main(['agent', 'deletion', str(self.secrets)])
        self.assertEqual(serve_mock.call_args_list, [
            mock.call(self.secrets, 'worker', 'production'),
            mock.call(self.secrets, 'deletion', 'development'),
        ])

        with mock.patch.object(ops, 'manage') as manage_mock:
            ops.main(['status'])
            ops.main(['status', '--environment', 'production'])
            ops.main(['set-key', '--environment', 'production'])
            ops.main(['install', '--environment', 'production', '--role', 'agent'])
            ops.main(['uninstall', '--environment', 'production', '--role', 'directory'])
            ops.main(['--environment', 'production', 'status'])
        self.assertEqual(manage_mock.call_args_list, [
            mock.call(ops.ROOT, 'status', None, None, 'development'),
            mock.call(ops.ROOT, 'status', None, None, 'production'),
            mock.call(ops.ROOT, 'set-key', None, None, 'production'),
            mock.call(ops.ROOT, 'install', None, 'agent', 'production'),
            mock.call(ops.ROOT, 'uninstall', None, 'directory', 'production'),
            mock.call(ops.ROOT, 'status', None, None, 'production'),
        ])

        with self.assertRaises(SystemExit) as raised:
            ops.main(['--environment', 'development', 'status', '--environment', 'production'])
        self.assertEqual(raised.exception.code, 2)

    def test_role_poll_intervals_and_backoff_constants_are_fixed(self):
        self.assertEqual(ops.ROLE_POLL_SECONDS, {
            'worker': 5,
            'agent': 5,
            'deletion': 30,
            'directory': 30,
        })
        self.assertEqual(ops.AUTH_REJECTED_BACKOFF_SECONDS, 60)
        self.assertEqual(ops.RPC_UNAVAILABLE_BACKOFF_SECONDS, 15)

        self.add_keys()
        ops.write_private(self.secrets / (ops.LLM_KEY + '.env'), (ops.LLM_KEY + '=sk-synthetic-test\n').encode())

        # 각 역할이 대기열이 비었을 때 정해진 주기로만 대기하는지 확인한다.
        for role, expected_sleep, patch_target, return_value in (
            ('worker', 5, 'run_once', {'status': 'idle'}),
            ('agent', 5, 'process_agent_reply', {'status': 'idle'}),
            ('deletion', 30, 'process_deletion', 'idle'),
            ('directory', 30, 'directory_tick', None),
        ):
            with self.subTest(role=role):
                with mock.patch.object(ops, 'WorkerRpc'), \
                        mock.patch.object(ops, patch_target, return_value=return_value), \
                        mock.patch.object(ops.time, 'sleep', side_effect=KeyboardInterrupt) as sleep:
                    with self.assertRaises(KeyboardInterrupt):
                        ops.serve(self.secrets, role)
                sleep.assert_called_once_with(expected_sleep)

    def test_serve_backoff_separates_transient_rpc_errors_from_auth_rejections_and_records_save_retries(self):
        self.add_keys()
        # 일시 오류(503, 57014, 응답 미확인)는 15초 대기하며 저장 재시도 횟수·사유만 안전하게 기록한다.
        exhausted = WorkerRpcError(500, '57014', save_retries=3,
                                   save_retry_reasons=('statement_timeout', 'http_503', 'response_unconfirmed'))
        for exc, expected_status, expected_sleep in (
            (exhausted, 'rpc_unavailable', 15),
            (WorkerRpcError(503), 'rpc_unavailable', 15),
            (WorkerRpcError(), 'rpc_unavailable', 15),
            (WorkerRpcError(401), 'worker_key_rejected', 60),
            (WorkerRpcError(403), 'worker_key_rejected', 60),
        ):
            with self.subTest(status=exc.status, code=exc.code):
                with mock.patch.object(ops, 'WorkerRpc'), \
                        mock.patch.object(ops, 'run_once', side_effect=exc), \
                        mock.patch.object(ops.time, 'sleep', side_effect=KeyboardInterrupt) as sleep:
                    with self.assertRaises(KeyboardInterrupt):
                        ops.serve(self.secrets, 'worker')
                sleep.assert_called_once_with(expected_sleep)
                state = ops.read_state(ops.state_file(self.secrets, 'worker'))
                self.assertEqual(state['status'], expected_status)
                if exc.save_retries:
                    self.assertEqual(state['lastSaveRetries'], 3)
                    self.assertEqual(state['lastSaveRetryReasons'],
                                     ['statement_timeout', 'http_503', 'response_unconfirmed'])
                self.assertNotIn('test-fixture', json.dumps(state))

        # 저장 재시도 후 완료된 실행은 상태 파일에 재시도 횟수와 사유를 남긴다.
        with mock.patch.object(ops, 'WorkerRpc'), \
                mock.patch.object(ops, 'run_once', side_effect=[
                    {'status': 'finished', 'runId': str(uuid4()), 'snapshotId': str(uuid4()),
                     'saveRetries': 2, 'saveRetryReasons': ['statement_timeout', 'http_503']},
                    {'status': 'idle'},
                ]), \
                mock.patch.object(ops.time, 'sleep', side_effect=KeyboardInterrupt) as sleep:
            with self.assertRaises(KeyboardInterrupt):
                ops.serve(self.secrets, 'worker')
        sleep.assert_called_once_with(5)
        state = ops.read_state(ops.state_file(self.secrets, 'worker'))
        self.assertEqual(state['status'], 'idle')
        self.assertEqual(state['lastJobStatus'], 'finished')
        self.assertEqual(state['lastSaveRetries'], 2)
        self.assertEqual(state['lastSaveRetryReasons'], ['statement_timeout', 'http_503'])


if __name__ == '__main__':
    unittest.main()
