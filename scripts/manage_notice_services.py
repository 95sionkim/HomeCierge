#!/usr/bin/env python3
"""개발 Mac에서 오늘의 청약 갱신, 분석 큐와 데이터 삭제 작업을 실행한다."""
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

from notice_run_capture import NoticeWorkerConfigurationError, live_notice_transports
from process_data_deletion import process_once as process_deletion
from run_analysis_worker import run_once
from worker_rpc import WorkerRpc, WorkerRpcError


ROOT = Path(__file__).resolve().parents[1]
DEV_ORIGIN = 'https://jcaelooqogosbzrfyrhe.supabase.co'
KST = timezone(timedelta(hours=9))
WORKER_KEY = 'SUPABASE_WORKER_KEY'
PROVIDER_KEY = 'DATA_GO_KR_SERVICE_KEY'
LABELS = {role: 'kr.homecierge.development.notice-' + role for role in ('worker', 'directory')}
LABELS['deletion'] = 'kr.homecierge.development.data-deletion'
LAUNCHCTL = '/bin/launchctl'
POLL_SECONDS = 30


def clock():
    return datetime.now(timezone.utc)


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


def worker_env(secret_dir, require_provider=True):
    service = read_field(secret_dir / 'worker.env', WORKER_KEY)
    if not service:
        raise ValueError('waiting_for_worker_key')
    env = {'APP_ENV': 'development', 'SUPABASE_URL': DEV_ORIGIN, WORKER_KEY: service}
    if not require_provider:
        return env
    provider = read_field(secret_dir / (PROVIDER_KEY + '.env'), PROVIDER_KEY)
    if not provider:
        raise ValueError('waiting_for_provider_key')
    return {**env, PROVIDER_KEY: provider}


def verify_worker(client):
    """임의의 비존재 실행을 읽어 개발 작업자 권한만 확인한다. 큐 인수는 하지 않는다."""
    try:
        client.post('read_comparison_work', {'p_run_id': str(uuid4()), 'p_generation': 1,
                                             'p_lease_token': str(uuid4())})
    except WorkerRpcError as exc:
        if exc.status == 404 and exc.code == 'PT404':
            return
        raise
    raise ValueError('unexpected_worker_probe')


def state_file(secret_dir, role):
    return secret_dir / 'notice-services' / (role + '.json')


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


def serve(secret_dir, role):
    path = state_file(secret_dir, role)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with path.with_suffix('.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state = read_state(path)
        if role == 'directory' and state.get('status') == 'refreshing':
            record(path, state, 'publication_unconfirmed', lastPublicationStatus='publication_unconfirmed')
        while True:
            delay = POLL_SECONDS
            try:
                env = worker_env(secret_dir, require_provider=role != 'deletion')
                client = WorkerRpc(env)
                if role == 'directory':
                    directory_tick(path, state, clock(), env, client)
                elif role == 'deletion':
                    outcome = process_deletion(client)
                    record(path, state, outcome)
                    if outcome == 'live_deleted':
                        delay = 0
                else:
                    os.environ[PROVIDER_KEY] = env[PROVIDER_KEY]
                    outcome = run_once(client, notice=live_notice_transports)['status']
                    record(path, state, outcome, **({} if outcome == 'idle' else {'lastJobStatus': outcome}))
                    if outcome != 'idle':
                        delay = 0
            except (UnicodeError, ValueError, NoticeWorkerConfigurationError) as exc:
                code = str(exc)
                status = code if code in ('waiting_for_worker_key', 'waiting_for_provider_key') else 'configuration_error'
                if state.get('status') != status:
                    record(path, state, status)
            except WorkerRpcError as exc:
                record(path, state, 'worker_key_rejected' if exc.status in (401, 403) else 'rpc_unavailable')
                delay = 60
            if delay:
                time.sleep(delay)


def release(root, secret_dir):
    """서비스에는 설치 시점 커밋의 수집기와 합성 예시만 전달한다."""
    revision = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD']).decode().strip()
    launcher = Path(__file__).read_bytes()
    name = revision + '-' + hashlib.sha256(launcher).hexdigest()[:12]
    directory = secret_dir / 'notice-services' / 'releases' / name
    if directory.is_dir():
        return directory
    directory.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
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


def launch_plist(runtime, secret_dir, role):
    return {'Label': LABELS[role], 'ProgramArguments': [sys.executable, '-B',
            str(runtime / 'scripts/manage_notice_services.py'), 'agent', role, str(secret_dir)],
            'KeepAlive': True, 'RunAtLoad': True, 'ThrottleInterval': 30,
            'ProcessType': 'Background', 'WorkingDirectory': str(runtime), 'Umask': 0o077}


def job_state(role):
    target = 'gui/' + str(os.getuid()) + '/' + LABELS[role]
    process = subprocess.run([LAUNCHCTL, 'print', target], capture_output=True, text=True)
    match = re.search(r'^\s*state = (.+)$', process.stdout, re.MULTILINE)
    return match.group(1) if process.returncode == 0 and match else 'not_loaded'


def manage(root, command, api_env=None, requested_role=None):
    if sys.platform != 'darwin':
        raise ValueError('macOS 사용자 로그인 세션이 필요합니다.')
    secrets = root / '.secrets'
    agents = Path.home() / 'Library/LaunchAgents'
    if command == 'status':
        for role in LABELS:
            print(json.dumps({'service': role, 'launchd': job_state(role),
                              **read_state(state_file(secrets, role))}, ensure_ascii=False))
        return
    if command == 'set-key':
        if not sys.stdin.isatty():
            raise ValueError('터미널의 숨김 입력으로 개발 작업자 키를 입력하세요.')
        key = getpass.getpass('HomeCierge 개발 프로젝트의 Supabase secret key (숨김): ').strip()
        verify_worker(WorkerRpc({'APP_ENV': 'development', 'SUPABASE_URL': DEV_ORIGIN, WORKER_KEY: key}))
        write_private(secrets / 'worker.env', (WORKER_KEY + '=' + key + '\n').encode())
        print('개발 작업자 권한을 확인하고 키를 저장했습니다.')
        return
    if command == 'install':
        if api_env is not None:
            provider = read_field(api_env, PROVIDER_KEY, private=False)
            if not provider:
                raise ValueError('지정 파일에 데이터포털 키가 없습니다.')
            write_private(secrets / (PROVIDER_KEY + '.env'), (PROVIDER_KEY + '=' + provider + '\n').encode())
        runtime = release(root, secrets)
        agents.mkdir(parents=True, exist_ok=True)
    domain = 'gui/' + str(os.getuid())
    jobs = []
    for role, label in LABELS.items():
        if requested_role is not None and role != requested_role:
            continue
        plist = agents / (label + '.plist')
        loaded = job_state(role) != 'not_loaded'
        if loaded and not plist.is_file():
            raise ValueError('기존 서비스의 설치 경로를 확인할 수 없습니다.')
        if plist.exists():
            args = plistlib.loads(plist.read_bytes()).get('ProgramArguments', [])
            if args[-1:] != [str(secrets)]:
                raise ValueError('같은 이름의 다른 체크아웃 서비스가 있습니다.')
        jobs.append((role, label, plist, loaded))
    for role, label, plist, loaded in jobs:
        if command == 'install':
            desired = plistlib.dumps(launch_plist(runtime, secrets, role))
            if plist.exists() and plist.read_bytes() == desired and loaded:
                continue
        if loaded:
            subprocess.run([LAUNCHCTL, 'bootout', domain + '/' + label], check=True)
        if command == 'uninstall':
            plist.unlink(missing_ok=True)
        else:
            write_private(plist, desired)
            subprocess.run([LAUNCHCTL, 'bootstrap', domain, str(plist)], check=True)
    manage(root, 'status')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    install = commands.add_parser('install', help='로그인 시 재개되는 개발 서비스를 설치하거나 갱신')
    install.add_argument('--api-env', type=Path, help='데이터포털 키 하나를 가져올 dotenv 파일')
    install.add_argument('--role', choices=LABELS, help='지정한 서비스만 설치하거나 갱신')
    commands.add_parser('set-key', help='서울 개발 프로젝트의 작업자 키를 숨김 입력하고 권한을 확인')
    commands.add_parser('status', help='개발 서비스의 최근 상태를 확인')
    uninstall = commands.add_parser('uninstall', help='설치한 서비스를 종료하고 로그인 실행을 해제')
    uninstall.add_argument('--role', choices=LABELS, help='지정한 서비스만 종료하고 로그인 실행을 해제')
    agent = commands.add_parser('agent', help=argparse.SUPPRESS)
    agent.add_argument('role', choices=LABELS)
    agent.add_argument('secret_dir', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == 'agent':
        serve(args.secret_dir, args.role)
    else:
        manage(ROOT, args.command, getattr(args, 'api_env', None), getattr(args, 'role', None))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, WorkerRpcError, subprocess.SubprocessError) as error:
        # WorkerRpc 출력에는 응답 본문과 헤더가 없고, 파일/프로세스 예외는 분류만 남긴다.
        print(str(error) if type(error) in (ValueError, WorkerRpcError) else type(error).__name__, file=sys.stderr)
        sys.exit(2)
