#!/usr/bin/env python3
"""DB에서 실행을 인수해 수집본과 그 근거로 계산한 비교 결과를 함께 저장한다."""
import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from uuid import UUID

from compare_trades import compare_snapshot
from ingestion_pages import loads_source_json
from replay_ingestion import replay
from store_ingestion import snapshot_input
from worker_rpc import WorkerRpc, WorkerRpcError, WorkerRpcResponseTooLarge


FIXTURE = Path(__file__).resolve().parents[1] / 'tests/fixtures/ingestion-v0.json'
# ingestion-v0로 접수된 실행은 재시작 이후에도 같은 예시를 사용한다.
FIXTURE_SHA256 = '0e7b2f2204c76ceb33d281a36c7569017216cfece81da23e385a1f9ee900a8a2'
EVIDENCE_FIXTURE = FIXTURE.with_name('comparison-evidence-v1.json')
# comparison/v1에서 사용한 합성 근거와 수집본 버전을 함께 고정한다.
EVIDENCE_SHA256 = '4773237d773f7437aa476d2dfe6d16de4408481b348c311b2a6980abc67591df'
MAX_COMPARISON_INPUT_BYTES = 32 * 1024 * 1024


def pinned_fixture(path, expected_sha256):
    source = path.read_bytes()
    if hashlib.sha256(source).hexdigest() != expected_sha256:
        raise ValueError('합성 자료 버전이 일치하지 않습니다.')
    return loads_source_json(source.decode('utf-8'))


def prepare_comparison(selection, work):
    # 사용자에게 허용한 선택과 서비스가 검수한 지역·단지·면적 근거는 별개의 입력이다.
    conditions = work['conditions']
    evidence = work['evidence']
    ingestion = work['ingestion']
    use_fixture = work['useSyntheticFixture']
    binding_issue = work['selectionBindingIssue']
    if (not isinstance(conditions, dict) or type(use_fixture) is not bool
            or (evidence is not None and not isinstance(evidence, dict))):
        raise ValueError('비교 입력을 확인할 수 없습니다.')
    inputs, new_capture = None, None
    if use_fixture:
        bundle = pinned_fixture(FIXTURE, FIXTURE_SHA256)
        expected_capture = replay(bundle)
        if evidence is not None:
            raise ValueError('합성 재생과 등록 근거가 충돌합니다.')
        evidence = pinned_fixture(EVIDENCE_FIXTURE, EVIDENCE_SHA256)
        if selection == {'kind': 'synthetic', 'fixture': 'ingestion-v0'} and ingestion is None:
            inputs, new_capture = snapshot_input(bundle['request']), expected_capture
            ingestion = new_capture
        elif ingestion != expected_capture:
            raise ValueError('고정한 합성 수집본과 일치하지 않습니다.')
    if new_capture is None:
        if not isinstance(selection, dict) or set(selection) != {'kind', 'snapshotId'} or selection['kind'] != 'snapshot':
            raise ValueError('저장된 수집본 식별자가 필요합니다.')
        UUID(selection['snapshotId'])
    if not isinstance(ingestion, dict) or ingestion.get('contractVersion') != 'ingestion/v0':
        raise ValueError('수집본 버전을 확인할 수 없습니다.')
    comparison = compare_snapshot(ingestion, conditions.get('comparison', {}), evidence, binding_issue=binding_issue)
    return inputs, new_capture, comparison


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
        try:
            work = client.post('read_comparison_work', lease, limit=MAX_COMPARISON_INPUT_BYTES)
        except WorkerRpcResponseTooLarge:
            # 읽기에서만 크기 초과를 확정할 수 있다. 완료 응답 유실은 임대 회수에 맡긴다.
            raise ValueError('비교 입력 크기를 확인하세요.') from None
        inputs, capture, comparison = prepare_comparison(selection, work)
        client.post('renew_analysis_run', {**lease, 'p_lease_seconds': lease_seconds})
        return client.post('finish_analysis_comparison', {
            **lease, 'p_input': inputs, 'p_result': capture, 'p_comparison': comparison,
        })
    except (AttributeError, KeyError, OSError, TypeError, ValueError):
        retryable = False
    except WorkerRpcError as exc:
        if exc.status != 429 and exc.code not in ('22023', '23503', '23505', '42501', 'PT422'):
            raise
        retryable = exc.status == 429
    return client.post('fail_analysis_run', {**lease, 'p_retryable': retryable})


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
    mode.add_argument('--demo', action='store_true', help='고정 합성 공고 한 건의 비교 결과를 DB 없이 출력')
    parser.add_argument('--run-id', type=UUID, help='지정한 실행 한 건만 인수')
    parser.add_argument('--lease-seconds', type=int, default=60, help='DB 임대 유효 시간, 기본 60초')
    args = parser.parse_args()
    if (args.watch or args.demo) and args.run_id is not None:
        parser.error('--run-id는 한 번 실행하는 모드에서 사용하세요.')
    if not 1 <= args.lease_seconds <= 300:
        parser.error('--lease-seconds는 1~300 범위여야 합니다.')
    if args.demo:
        work = {'conditions': {}, 'ingestion': None, 'evidence': None,
                'selectionBindingIssue': None, 'useSyntheticFixture': True}
        _, _, comparison = prepare_comparison({'kind': 'synthetic', 'fixture': 'ingestion-v0'}, work)
        print(json.dumps(comparison, ensure_ascii=False, indent=2, allow_nan=False))
        return 0
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
