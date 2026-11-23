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
from notice_run_capture import (
    CaptureStopped, NoticeRunFailure, NoticeWorkerConfigurationError, live_notice_transports, prepare_notice_comparison,
)
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


def _is_snapshot_selection(selection):
    if (not isinstance(selection, dict) or set(selection) != {'kind', 'snapshotId'}
            or selection['kind'] != 'snapshot' or not isinstance(selection['snapshotId'], str)):
        return False
    try:
        UUID(selection['snapshotId'])
    except ValueError:
        return False
    return True


def _approved_comparison_period(selection, work):
    # 정상 실행은 comparisonPeriod 필드를 생략한다. 필드가 존재하면 스냅샷의 유효한 {start, end}여야 한다.
    if 'comparisonPeriod' not in work:
        return None
    if not _is_snapshot_selection(selection):
        raise ValueError('비교 기간 재계산은 저장된 수집본 실행에서만 사용할 수 있습니다.')
    period = work['comparisonPeriod']
    if (not isinstance(period, dict) or set(period) != {'start', 'end'}
            or not isinstance(period['start'], str) or not isinstance(period['end'], str)):
        raise ValueError('승인된 비교 기간에는 start와 end만 지정해야 합니다.')
    return period


def prepare_comparison(selection, work):
    # 사용자에게 허용한 선택과 서비스가 검수한 지역·단지·면적 근거는 별개의 입력이다.
    if not isinstance(work, dict):
        raise ValueError('비교 입력을 확인할 수 없습니다.')
    comparison_period = _approved_comparison_period(selection, work)
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
    if new_capture is None and not _is_snapshot_selection(selection):
        raise ValueError('저장된 수집본 식별자가 필요합니다.')
    if not isinstance(ingestion, dict) or ingestion.get('contractVersion') != 'ingestion/v0':
        raise ValueError('수집본 버전을 확인할 수 없습니다.')
    comparison = compare_snapshot(
        ingestion, conditions.get('comparison', {}), evidence,
        binding_issue=binding_issue, comparison_period=comparison_period,
    )
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


def finish_comparison(client, lease, inputs, capture, comparison, schedules=None):
    payload = {**lease, 'p_input': inputs, 'p_result': capture, 'p_comparison': comparison}
    if schedules is not None:
        return client.post('finish_notice_with_funding', dict(payload, p_schedules=schedules))
    return client.post('finish_analysis_comparison', payload)


def execute_notice_lease(client, lease, selection, lease_seconds, transports):
    if transports is None:
        raise NoticeWorkerConfigurationError('공고 실행을 처리하려면 --live 또는 공고 조회 전송이 필요합니다.')

    def renew(seconds):
        reply = client.post('renew_analysis_run', {**lease, 'p_lease_seconds': seconds})
        if (not isinstance(reply, dict) or reply.get('runId') != lease['p_run_id']
                or reply.get('status') != 'running' or type(reply.get('attempt')) is not int
                or reply['attempt'] != lease['p_generation']):
            raise WorkerRpcError()

    try:
        try:
            work = client.post('read_comparison_work', lease, limit=MAX_COMPARISON_INPUT_BYTES)
        except WorkerRpcResponseTooLarge:
            raise NoticeRunFailure('notice_capture_limit', False) from None
        if not isinstance(work, dict) or 'comparisonPeriod' in work:
            raise NoticeRunFailure('notice_selection_unverified', False)
        inputs, capture, comparison, schedules = prepare_notice_comparison(
            selection, work, generation=lease['p_generation'], transports=transports,
            renew=renew, lease_seconds=lease_seconds,
        )
        return finish_comparison(client, lease, inputs, capture, comparison, schedules)
    except CaptureStopped as exc:
        if exc.rpc_error is not None:
            # 갱신 응답이 유실된 경우도 새 RPC로 현재 세대의 상태를 쓰지 않는다.
            raise exc.rpc_error from None
        code, retryable = 'notice_capture_limit', False
    except NoticeRunFailure as exc:
        code, retryable = exc.code, exc.retryable
    except WorkerRpcError as exc:
        if exc.code in ('42501', 'PT403') or exc.status == 403:
            code, retryable = 'notice_source_restricted', False
        elif exc.code == 'PT422':
            code, retryable = 'notice_selection_unverified', False
        elif exc.code == '22023':
            return client.post('fail_analysis_run', {**lease, 'p_retryable': False})
        elif exc.status == 413:
            code, retryable = 'notice_capture_limit', False
        elif exc.status == 429:
            code, retryable = 'notice_feed_unavailable', True
        else:
            # 완료 응답 유실 등 커밋 여부를 모르면 다른 쓰기를 시도하지 않는다.
            raise
    return client.post('fail_notice_analysis_run', {**lease, 'p_error_code': code, 'p_retryable': retryable})


def execute_lease(client, lease, selection, lease_seconds, notice=None):
    if isinstance(selection, dict) and selection.get('kind') == 'notice':
        return execute_notice_lease(client, lease, selection, lease_seconds, notice)
    try:
        try:
            work = client.post('read_comparison_work', lease, limit=MAX_COMPARISON_INPUT_BYTES)
        except WorkerRpcResponseTooLarge:
            # 읽기에서만 크기 초과를 확정할 수 있다. 완료 응답 유실은 임대 회수에 맡긴다.
            raise ValueError('비교 입력 크기를 확인하세요.') from None
        inputs, capture, comparison = prepare_comparison(selection, work)
        client.post('renew_analysis_run', {**lease, 'p_lease_seconds': lease_seconds})
        return finish_comparison(client, lease, inputs, capture, comparison)
    except (AttributeError, KeyError, OSError, TypeError, ValueError):
        retryable = False
    except WorkerRpcError as exc:
        if exc.status != 429 and exc.code not in ('22023', '23503', '23505', '42501', 'PT422'):
            raise
        retryable = exc.status == 429
    return client.post('fail_analysis_run', {**lease, 'p_retryable': retryable})


def run_once(client, *, lease_seconds=60, run_id=None, notice=None):
    """큐 한 건을 처리한다. 공고 실행에만 주입 전송이나 전송 생성 함수를 사용한다."""
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
        reply = execute_lease(client, lease, selection, lease_seconds, notice)
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
    parser.add_argument('--live', action='store_true', help='선택한 공고에 청약홈·실거래·허용된 공식 PDF 조회를 사용')
    parser.add_argument('--run-id', type=UUID, help='지정한 실행 한 건만 인수')
    parser.add_argument('--lease-seconds', type=int, default=60, help='DB 임대 유효 시간, 기본 60초')
    args = parser.parse_args()
    if (args.watch or args.demo) and args.run_id is not None:
        parser.error('--run-id는 한 번 실행하는 모드에서 사용하세요.')
    if not 1 <= args.lease_seconds <= 300:
        parser.error('--lease-seconds는 1~300 범위여야 합니다.')
    if args.demo:
        if args.live:
            parser.error('--demo는 --live와 함께 사용할 수 없습니다.')
        work = {'conditions': {}, 'ingestion': None, 'evidence': None,
                'selectionBindingIssue': None, 'useSyntheticFixture': True}
        _, _, comparison = prepare_comparison({'kind': 'synthetic', 'fixture': 'ingestion-v0'}, work)
        print(json.dumps(comparison, ensure_ascii=False, indent=2, allow_nan=False))
        return 0
    try:
        client = WorkerRpc(os.environ)
    except ValueError as exc:
        parser.exit(2, f'{exc}\n')
    notice = live_notice_transports if args.live else None
    while True:
        try:
            outcome = run_once(client, lease_seconds=args.lease_seconds, run_id=args.run_id, notice=notice)
        except NoticeWorkerConfigurationError as exc:
            parser.exit(2, f'{exc}\n')
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
