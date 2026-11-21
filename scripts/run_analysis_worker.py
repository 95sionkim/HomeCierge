#!/usr/bin/env python3
"""DB에서 분석 실행을 인수해 수집 입력을 준비한다. 기본은 한 번 실행한 뒤 종료한다."""
import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from uuid import UUID

from ingestion_pages import loads_source_json
from replay_ingestion import replay
from store_ingestion import snapshot_input
from worker_rpc import WorkerRpc, WorkerRpcError


FIXTURE = Path(__file__).resolve().parents[1] / 'tests/fixtures/ingestion-v0.json'
# ingestion-v0로 접수된 실행은 재시작 이후에도 같은 예시를 사용한다.
FIXTURE_SHA256 = '0e7b2f2204c76ceb33d281a36c7569017216cfece81da23e385a1f9ee900a8a2'


def prepare_input(selection):
    if isinstance(selection, dict) and set(selection) == {'kind', 'snapshotId'} and selection['kind'] == 'snapshot':
        UUID(selection['snapshotId'])
        # 이미 저장된 입력은 DB에서 참조한다. 작업자로 개인 자료를 가져올 필요가 없다.
        return None, None
    if selection != {'kind': 'synthetic', 'fixture': 'ingestion-v0'}:
        raise ValueError('지원하지 않는 실행 입력입니다.')
    source = FIXTURE.read_text(encoding='utf-8')
    if hashlib.sha256(source.encode('utf-8')).hexdigest() != FIXTURE_SHA256:
        raise ValueError('합성 자료 버전이 일치하지 않습니다.')
    bundle = loads_source_json(source)
    return snapshot_input(bundle['request']), replay(bundle)


def lease_identity(job, expected_run_id):
    try:
        run_id = str(UUID(job['runId']))
        token = str(UUID(job['leaseToken']))
        generation = job['generation']
        if (type(generation) is not int or generation < 1
                or (expected_run_id is not None and run_id != str(expected_run_id))):
            raise ValueError
        return {'p_run_id': run_id, 'p_generation': generation, 'p_lease_token': token}
    except (KeyError, TypeError, AttributeError, ValueError):
        raise WorkerRpcError() from None


def execute_lease(client, lease, selection, lease_seconds):
    try:
        inputs, result = prepare_input(selection)
    except (AttributeError, KeyError, OSError, TypeError, ValueError):
        return client.post('fail_analysis_run', {**lease, 'p_retryable': False})

    # 정규화 후에 임대를 확인하며 실제 저장 경계에서도 DB가 다시 대조한다.
    client.post('renew_analysis_run', {**lease, 'p_lease_seconds': lease_seconds})
    try:
        return client.post('finish_analysis_run', {**lease, 'p_input': inputs, 'p_result': result})
    except WorkerRpcError as exc:
        if exc.status != 429 and exc.code not in ('22023', '23503', '23505', '42501', 'PT422'):
            raise
        # 명시적으로 거절된 연산만 실패로 기록한다. 응답 유실은 임대 회수에 맡긴다.
        return client.post('fail_analysis_run', {**lease, 'p_retryable': exc.status == 429})


def run_once(client, *, lease_seconds=60, run_id=None):
    if type(lease_seconds) is not int or not 1 <= lease_seconds <= 300:
        raise ValueError('임대 시간은 1~300초여야 합니다.')
    claim = {'p_lease_seconds': lease_seconds}
    if run_id is not None:
        run_id = str(UUID(str(run_id)))
        claim['p_run_id'] = run_id
    job = client.post('claim_analysis_run', claim)
    if job is None:
        return {'status': 'idle'}
    lease = lease_identity(job, run_id)
    run_id = lease['p_run_id']
    selection = job.get('input')
    try:
        reply = execute_lease(client, lease, selection, lease_seconds)
    except WorkerRpcError as exc:
        if exc.code in ('PT404', 'PT409'):
            return {'status': 'lease_lost', 'runId': run_id}
        raise
    if not isinstance(reply, dict) or reply.get('runId') != run_id:
        raise WorkerRpcError()
    status = reply.get('status')
    if status in ('failed', 'retry_wait'):
        return {'status': status, 'runId': run_id}
    if status != 'finished':
        raise WorkerRpcError()
    try:
        snapshot_id = str(UUID(reply['snapshotId']))
        if selection['kind'] == 'snapshot' and snapshot_id != str(UUID(selection['snapshotId'])):
            raise ValueError
    except (KeyError, ValueError, TypeError, AttributeError):
        raise WorkerRpcError() from None
    return {'status': status, 'runId': run_id, 'snapshotId': snapshot_id}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--once', action='store_true', help='작업을 한 건까지 처리하고 종료 (기본)')
    mode.add_argument('--watch', action='store_true', help='중지할 때까지 개발 큐의 작업을 처리')
    parser.add_argument('--run-id', type=UUID, help='지정한 실행 한 건만 인수')
    parser.add_argument('--lease-seconds', type=int, default=60, help='DB 임대 유효 시간, 기본 60초')
    args = parser.parse_args()
    if args.watch and args.run_id is not None:
        parser.error('--run-id는 한 번 실행하는 모드에서 사용하세요.')
    if not 1 <= args.lease_seconds <= 300:
        parser.error('--lease-seconds는 1~300 범위여야 합니다.')
    try:
        client = WorkerRpc(os.environ)
    except ValueError as exc:
        parser.exit(2, f'{exc}\n')
    while True:
        try:
            outcome = run_once(client, lease_seconds=args.lease_seconds, run_id=args.run_id)
        except WorkerRpcError as exc:
            print(str(exc), file=sys.stderr, flush=True)
            if not args.watch:
                return 1
            time.sleep(2)
            continue
        if not args.watch or outcome['status'] != 'idle':
            print(json.dumps(outcome), flush=True)
        if not args.watch:
            return int(outcome['status'] == 'failed')
        if outcome['status'] == 'idle':
            time.sleep(2)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
