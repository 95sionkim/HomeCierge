#!/usr/bin/env python3
"""개발 Mac에서 개발·운영 환경별 청약 목록 갱신, 분석 큐, 데이터 삭제, 에이전트 작업을 실행한다."""
import argparse
import fcntl
import getpass
import hashlib
import io
import json
import os
import plistlib
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from agent_llm import OpenAIResponsesProvider
from agent_worker import process_once as process_agent_reply
from notice_run_capture import NoticeWorkerConfigurationError, live_notice_transports
from process_data_deletion import process_once as process_deletion
from run_analysis_worker import run_once
from worker_rpc import ENVIRONMENTS, PROJECT_ORIGINS, WorkerRpc, WorkerRpcError


ROOT = Path(__file__).resolve().parents[1]
DEV_ORIGIN = PROJECT_ORIGINS['development']
PROD_ORIGIN = PROJECT_ORIGINS['production']
KST = timezone(timedelta(hours=9))
WORKER_KEY = 'SUPABASE_WORKER_KEY'
PROVIDER_KEY = 'DATA_GO_KR_SERVICE_KEY'
KAKAO_KEY = 'KAKAO_REST_API_KEY'
LLM_KEY = 'OPENAI_API_KEY'
ROLE_SUFFIXES = {
    'worker': 'notice-worker',
    'directory': 'notice-directory',
    'deletion': 'data-deletion',
    'agent': 'agent-worker',
}
ROLES = tuple(ROLE_SUFFIXES)


def validate_environment(environment):
    if environment not in PROJECT_ORIGINS:
        raise ValueError('허용된 서비스 환경은 development 또는 production입니다.')
    return environment


def labels_for(environment='development'):
    environment = validate_environment(environment)
    return {role: f'kr.homecierge.{environment}.{suffix}' for role, suffix in ROLE_SUFFIXES.items()}


LABELS = labels_for('development')
LAUNCHCTL = '/bin/launchctl'
POLL_SECONDS = 30
ROLE_POLL_SECONDS = {
    'worker': 5,
    'agent': 5,
    'deletion': 30,
    'directory': 30,
}
AUTH_REJECTED_BACKOFF_SECONDS = 60
RPC_UNAVAILABLE_BACKOFF_SECONDS = 15


def clock():
    return datetime.now(timezone.utc)


def ensure_private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)
    return path


def env_secret_dir(secret_dir, environment='development'):
    environment = validate_environment(environment)
    return secret_dir if environment == 'development' else secret_dir / environment


def write_private(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def read_field(path, name, private=True):
    """셸을 실행하지 않고 요청한 설정 하나만 읽는다."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if (not stat.S_ISREG(info.st_mode) or info.st_size > 64 * 1024 or
            (private and (info.st_uid != os.getuid() or info.st_mode & 0o077))):
        raise ValueError('invalid_credential_file')
    entries = [value.strip().strip('"').strip("'")
               for line in path.read_text(encoding='utf-8').splitlines()
               for key, sep, value in [line.partition('=')] if sep and key.strip() == name]
    if len(entries) > 1:
        raise ValueError('duplicate_credential')
    return entries[0] if entries and entries[0] else None


def read_env_field(secret_dir, name, fallback_dir=None):
    """환경 전용 키 파일이 있으면 그것을 읽고, 파일이 없을 때만 공용 비밀 폴더에서 읽는다."""
    primary = secret_dir / (name + '.env')
    try:
        primary.lstat()
    except FileNotFoundError:
        if fallback_dir is not None and fallback_dir != secret_dir:
            return read_field(fallback_dir / (name + '.env'), name)
        return None
    return read_field(primary, name)


def worker_env(secret_dir, require_provider=True, require_llm=False, environment='development'):
    environment = validate_environment(environment)
    env_dir = env_secret_dir(secret_dir, environment)
    if env_dir != secret_dir:
        try:
            dir_info = env_dir.lstat()
        except FileNotFoundError:
            dir_info = None
        if dir_info is not None and not stat.S_ISDIR(dir_info.st_mode):
            raise ValueError('invalid_credential_file')
    fallback_dir = secret_dir if environment == 'production' else None
    # 운영 worker.env는 .secrets/production/에서만 읽으며 개발 키로 대체하지 않는다.
    service = read_field(env_dir / 'worker.env', WORKER_KEY)
    if not service:
        raise ValueError('waiting_for_worker_key')
    env = {'APP_ENV': environment, 'SUPABASE_URL': PROJECT_ORIGINS[environment], WORKER_KEY: service}
    if require_provider:
        provider = read_env_field(env_dir, PROVIDER_KEY, fallback_dir)
        if not provider:
            raise ValueError('waiting_for_provider_key')
        env[PROVIDER_KEY] = provider
        # 카카오 로컬 키는 선택 항목이다. 없어도 작업자 기동을 막지 않으며 단지 대표 좌표만 미확인으로 둔다.
        kakao = read_env_field(env_dir, KAKAO_KEY, fallback_dir)
        if kakao:
            env[KAKAO_KEY] = kakao
    if require_llm:
        llm_key = read_env_field(env_dir, LLM_KEY, fallback_dir)
        if not llm_key:
            raise ValueError('waiting_for_llm_key')
        env[LLM_KEY] = llm_key
    return env


def verify_worker(client):
    """임의의 비존재 실행을 읽어 작업자 권한만 확인한다. 큐 인수는 하지 않는다."""
    try:
        client.post('read_comparison_work', {'p_run_id': str(uuid4()), 'p_generation': 1,
                                             'p_lease_token': str(uuid4())})
    except WorkerRpcError as exc:
        if exc.status == 404 and exc.code == 'PT404':
            return
        raise
    raise ValueError('unexpected_worker_probe')


def state_file(secret_dir, role, environment='development'):
    return env_secret_dir(secret_dir, environment) / 'notice-services' / (role + '.json')


def read_state(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}


def record(path, state, status, **fields):
    state.update(fields, status=status, checkedAt=clock().isoformat())
    write_private(path, json.dumps(state, sort_keys=True).encode())


def refresh_due(now, state):
    local = now.astimezone(KST)
    return ((local.hour, local.minute) >= (9, 17)
            and state.get('attemptedOn') != local.date().isoformat())


def refresh_once(env):
    safe_env = {**env, 'PATH': '/usr/bin:/bin', 'PYTHONUTF8': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
    result = subprocess.run([sys.executable, str(ROOT / 'scripts/refresh_notice_index.py'), '--live', '--publish'],
                            env=safe_env, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=31 * 60)
    report = json.loads(result.stdout)
    if result.returncode == 0 and report.get('status') == 'published':
        return 'published', {'publishedAt': report['observedAt'], 'noticeCount': report['noticeCount']}
    return ('publication_unconfirmed' if report.get('status') == 'publication_unconfirmed'
            else 'kept_previous'), {}


def directory_tick(path, state, now, env, client):
    if not refresh_due(now, state):
        if state.get('status') in (None, 'waiting_for_worker_key', 'waiting_for_provider_key',
                                   'configuration_error', 'worker_key_rejected', 'rpc_unavailable'):
            record(path, state, state.get('lastPublicationStatus', 'scheduled'))
        return
    verify_worker(client)
    # 커밋 응답 유실·재시작 직후에도 같은 날 회차의 실조회를 중복 실행하지 않는다.
    record(path, state, 'refreshing', attemptedOn=now.astimezone(KST).date().isoformat())
    try:
        status, fields = refresh_once(env)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        status, fields = 'publication_unconfirmed', {}
    record(path, state, status, lastPublicationStatus=status, **fields)


def serve(secret_dir, role, environment='development'):
    environment = validate_environment(environment)
    if role not in ROLE_SUFFIXES:
        raise ValueError('허용된 서비스 역할이 아닙니다.')
    ensure_private_dir(secret_dir)
    env_dir = env_secret_dir(secret_dir, environment)
    if env_dir != secret_dir:
        ensure_private_dir(env_dir)
    path = state_file(secret_dir, role, environment)
    ensure_private_dir(path.parent)
    with path.with_suffix('.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state = read_state(path)
        if role == 'directory' and state.get('status') == 'refreshing':
            record(path, state, 'publication_unconfirmed', lastPublicationStatus='publication_unconfirmed')
        while True:
            delay = ROLE_POLL_SECONDS[role]
            try:
                env = worker_env(
                    secret_dir,
                    require_provider=role in ('worker', 'directory'),
                    require_llm=role == 'agent',
                    environment=environment,
                )
                client = WorkerRpc(env)
                if role == 'directory':
                    directory_tick(path, state, clock(), env, client)
                elif role == 'deletion':
                    outcome = process_deletion(client)
                    record(path, state, outcome)
                    if outcome == 'live_deleted':
                        delay = 0
                elif role == 'agent':
                    llm_key = env[LLM_KEY]
                    outcome = process_agent_reply(
                        client,
                        lambda model: OpenAIResponsesProvider(model=model, api_key=llm_key),
                    )['status']
                    record(path, state, outcome, **({} if outcome == 'idle' else {'lastJobStatus': outcome}))
                    if outcome != 'idle':
                        delay = 0
                else:
                    scoped_keys = ('APP_ENV', 'SUPABASE_URL', WORKER_KEY, PROVIDER_KEY, KAKAO_KEY)
                    previous = {key: os.environ.get(key) for key in scoped_keys}
                    try:
                        os.environ['APP_ENV'] = env['APP_ENV']
                        os.environ['SUPABASE_URL'] = env['SUPABASE_URL']
                        os.environ[WORKER_KEY] = env[WORKER_KEY]
                        os.environ[PROVIDER_KEY] = env[PROVIDER_KEY]
                        if KAKAO_KEY in env:
                            os.environ[KAKAO_KEY] = env[KAKAO_KEY]
                        else:
                            os.environ.pop(KAKAO_KEY, None)
                        job_result = run_once(client, notice=live_notice_transports)
                    finally:
                        for key, old in previous.items():
                            if old is None:
                                os.environ.pop(key, None)
                            else:
                                os.environ[key] = old
                    outcome = job_result['status']
                    extra = {} if outcome == 'idle' else {'lastJobStatus': outcome}
                    if job_result.get('saveRetries'):
                        extra['lastSaveRetries'] = job_result['saveRetries']
                        extra['lastSaveRetryReasons'] = list(job_result.get('saveRetryReasons', ()))
                    record(path, state, outcome, **extra)
                    if outcome != 'idle':
                        delay = 0
            except (UnicodeError, ValueError, NoticeWorkerConfigurationError) as exc:
                code = str(exc)
                status = (code if code in ('waiting_for_worker_key', 'waiting_for_provider_key', 'waiting_for_llm_key')
                          else 'configuration_error')
                if state.get('status') != status:
                    record(path, state, status)
            except WorkerRpcError as exc:
                rejected = exc.status in (401, 403)
                extra = {}
                if exc.save_retries:
                    extra['lastSaveRetries'] = exc.save_retries
                    extra['lastSaveRetryReasons'] = list(exc.save_retry_reasons)
                record(path, state, 'worker_key_rejected' if rejected else 'rpc_unavailable', **extra)
                delay = AUTH_REJECTED_BACKOFF_SECONDS if rejected else RPC_UNAVAILABLE_BACKOFF_SECONDS
            if delay:
                time.sleep(delay)


def release(root, secret_dir, environment='development'):
    """서비스에는 설치 시점 커밋의 수집기와 합성 예시만 전달한다."""
    environment = validate_environment(environment)
    base = env_secret_dir(secret_dir, environment)
    ensure_private_dir(secret_dir)
    if base != secret_dir:
        ensure_private_dir(base)
    revision = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD']).decode().strip()
    launcher = Path(__file__).read_bytes()
    name = revision + '-' + hashlib.sha256(launcher).hexdigest()[:12]
    directory = base / 'notice-services' / 'releases' / name
    if directory.is_dir():
        return directory
    ensure_private_dir(directory.parent)
    fixtures = ['tests/fixtures/ingestion-v0.json', 'tests/fixtures/comparison-evidence-v1.json', 'docs/api/probes.json']
    packed = subprocess.check_output(['git', '-C', str(root), 'archive', revision, 'scripts', *fixtures])
    with tempfile.TemporaryDirectory(dir=directory.parent) as staging:
        target = Path(staging) / 'release'
        with tarfile.open(fileobj=io.BytesIO(packed)) as archive:
            for member in archive:
                file = Path(member.name)
                use_script = (file.parent == Path('scripts') and file.suffix == '.py'
                              and not file.name.startswith(('test_', 'smoke_')))
                if member.isfile() and (use_script or member.name in fixtures):
                    destination = target / file
                    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    destination.write_bytes(archive.extractfile(member).read())
        (target / 'scripts' / Path(__file__).name).write_bytes(launcher)
        target.rename(directory)
    return directory


def launch_plist(runtime, secret_dir, role, environment='development'):
    labels = labels_for(environment)
    return {
        'Label': labels[role],
        'ProgramArguments': [
            sys.executable, '-B',
            str(runtime / 'scripts/manage_notice_services.py'),
            'agent', '--environment', environment, role, str(secret_dir),
        ],
        'KeepAlive': True,
        'RunAtLoad': True,
        'ThrottleInterval': 30,
        'ProcessType': 'Background',
        'WorkingDirectory': str(runtime),
        'Umask': 0o077,
    }


def plist_owned_by_checkout(program_args, secrets, role, environment='development'):
    environment = validate_environment(environment)
    if not isinstance(program_args, list) or 'agent' not in program_args:
        return False
    tail = program_args[program_args.index('agent') + 1:]
    if len(tail) == 2 and environment == 'development':
        # 기존 개발 플리스트([..., 'agent', role, secret_dir])와의 호환을 유지한다.
        return tail == [role, str(secrets)]
    if len(tail) == 4:
        return tail == ['--environment', environment, role, str(secrets)]
    return False


BOOTSTRAP_ATTEMPTS = 5
BOOTSTRAP_RETRY_SECONDS = 1.0


def bootstrap_job(domain, plist):
    """launchd는 bootout 직후의 bootstrap을 'Bootstrap failed: 5: Input/output error'로 가끔 거절한다.

    2026-11-28 재설치에서 이 오류로 설치가 중간에 멈춰 일부 서비스가 이전 릴리스에 남았다. 잠시 쉬고 다시 시도한다.
    """
    for attempt in range(BOOTSTRAP_ATTEMPTS):
        try:
            subprocess.run([LAUNCHCTL, 'bootstrap', domain, str(plist)], check=True)
            return
        except subprocess.CalledProcessError:
            if attempt == BOOTSTRAP_ATTEMPTS - 1:
                raise
            time.sleep(BOOTSTRAP_RETRY_SECONDS)


def job_state(role, environment='development'):
    label = labels_for(environment)[role]
    target = 'gui/' + str(os.getuid()) + '/' + label
    process = subprocess.run([LAUNCHCTL, 'print', target], capture_output=True, text=True)
    match = re.search(r'^\s*state = (.+)$', process.stdout, re.MULTILINE)
    return match.group(1) if process.returncode == 0 and match else 'not_loaded'


def manage(root, command, api_env=None, requested_role=None, environment='development'):
    environment = validate_environment(environment)
    if requested_role is not None and requested_role not in ROLE_SUFFIXES:
        raise ValueError('허용된 서비스 역할이 아닙니다.')
    if sys.platform != 'darwin':
        raise ValueError('macOS 사용자 로그인 세션이 필요합니다.')
    secrets = root / '.secrets'
    env_secrets = env_secret_dir(secrets, environment)
    labels = labels_for(environment)
    env_label = '운영' if environment == 'production' else '개발'
    agents = Path.home() / 'Library/LaunchAgents'
    if command == 'status':
        for role, label in labels.items():
            print(json.dumps({
                'environment': environment,
                'service': role,
                'label': label,
                'launchd': job_state(role, environment),
                **read_state(state_file(secrets, role, environment)),
            }, ensure_ascii=False))
        return
    if command == 'set-key':
        if not sys.stdin.isatty():
            raise ValueError(f'터미널의 숨김 입력으로 {env_label} 작업자 키를 입력하세요.')
        key = getpass.getpass(f'HomeCierge {env_label} 프로젝트의 Supabase secret key (숨김): ').strip()
        verify_worker(WorkerRpc({
            'APP_ENV': environment,
            'SUPABASE_URL': PROJECT_ORIGINS[environment],
            WORKER_KEY: key,
        }))
        ensure_private_dir(secrets)
        if env_secrets != secrets:
            ensure_private_dir(env_secrets)
        write_private(env_secrets / 'worker.env', (WORKER_KEY + '=' + key + '\n').encode())
        print(f'{env_label} 작업자 권한을 확인하고 키를 저장했습니다.')
        return
    if command == 'install':
        ensure_private_dir(secrets)
        if env_secrets != secrets:
            ensure_private_dir(env_secrets)
        if api_env is not None:
            provider = read_field(api_env, PROVIDER_KEY, private=False)
            if not provider:
                raise ValueError('지정 파일에 데이터포털 키가 없습니다.')
            write_private(env_secrets / (PROVIDER_KEY + '.env'), (PROVIDER_KEY + '=' + provider + '\n').encode())
            kakao = read_field(api_env, KAKAO_KEY, private=False)
            if kakao:
                write_private(env_secrets / (KAKAO_KEY + '.env'), (KAKAO_KEY + '=' + kakao + '\n').encode())
        runtime = release(root, secrets, environment)
        agents.mkdir(parents=True, exist_ok=True)
    domain = 'gui/' + str(os.getuid())
    jobs = []
    for role, label in labels.items():
        if requested_role is not None and role != requested_role:
            continue
        plist = agents / (label + '.plist')
        loaded = job_state(role, environment) != 'not_loaded'
        if loaded and not plist.is_file():
            raise ValueError('기존 서비스의 설치 경로를 확인할 수 없습니다.')
        if plist.exists():
            args = plistlib.loads(plist.read_bytes()).get('ProgramArguments', [])
            if not plist_owned_by_checkout(args, secrets, role, environment):
                raise ValueError('같은 이름의 다른 체크아웃 서비스가 있습니다.')
        jobs.append((role, label, plist, loaded))
    for role, label, plist, loaded in jobs:
        if command == 'install':
            desired = plistlib.dumps(launch_plist(runtime, secrets, role, environment))
            if plist.exists() and plist.read_bytes() == desired and loaded:
                continue
        if loaded:
            subprocess.run([LAUNCHCTL, 'bootout', domain + '/' + label], check=True)
        if command == 'uninstall':
            plist.unlink(missing_ok=True)
        else:
            write_private(plist, desired)
            bootstrap_job(domain, plist)
    manage(root, 'status', environment=environment)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment', choices=ENVIRONMENTS, default=None, help='대상 환경 (기본: development)')
    commands = parser.add_subparsers(dest='command', required=True)
    install = commands.add_parser('install', help='로그인 시 재개되는 서비스를 설치하거나 갱신')
    install.add_argument('--environment', dest='sub_environment', choices=ENVIRONMENTS, default=None,
                         help='대상 환경 (기본: development)')
    install.add_argument('--api-env', type=Path, help='데이터포털 키 하나를 가져올 dotenv 파일')
    install.add_argument('--role', choices=ROLES, help='지정한 서비스만 설치하거나 갱신')
    set_key = commands.add_parser('set-key', help='지정 환경 프로젝트의 작업자 키를 숨김 입력하고 권한을 확인')
    set_key.add_argument('--environment', dest='sub_environment', choices=ENVIRONMENTS, default=None,
                         help='대상 환경 (기본: development)')
    status = commands.add_parser('status', help='지정 환경 서비스의 최근 상태를 확인')
    status.add_argument('--environment', dest='sub_environment', choices=ENVIRONMENTS, default=None,
                        help='대상 환경 (기본: development)')
    uninstall = commands.add_parser('uninstall', help='설치한 서비스를 종료하고 로그인 실행을 해제')
    uninstall.add_argument('--environment', dest='sub_environment', choices=ENVIRONMENTS, default=None,
                           help='대상 환경 (기본: development)')
    uninstall.add_argument('--role', choices=ROLES, help='지정한 서비스만 종료하고 로그인 실행을 해제')
    agent = commands.add_parser('agent', help=argparse.SUPPRESS)
    agent.add_argument('--environment', dest='sub_environment', choices=ENVIRONMENTS, default=None)
    agent.add_argument('role', choices=ROLES)
    agent.add_argument('secret_dir', type=Path)
    args = parser.parse_args(argv)
    if args.environment and args.sub_environment and args.environment != args.sub_environment:
        parser.error('서로 다른 --environment 값을 함께 지정할 수 없습니다.')
    environment = args.sub_environment or args.environment or 'development'
    os.umask(0o077)
    if args.command == 'agent':
        serve(args.secret_dir, args.role, environment)
    else:
        manage(ROOT, args.command, getattr(args, 'api_env', None), getattr(args, 'role', None), environment)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, WorkerRpcError, subprocess.SubprocessError) as error:
        # WorkerRpc 출력에는 응답 본문과 헤더가 없고, 파일/프로세스 예외는 분류만 남긴다.
        print(str(error) if type(error) in (ValueError, WorkerRpcError) else type(error).__name__, file=sys.stderr)
        sys.exit(2)
