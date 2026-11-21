#!/usr/bin/env python3
"""BE-02가 정규화한 수집 결과와 조회 조건을 개발 DB의 한 분석에 저장한다."""
import argparse
import json
import os
import sys
from pathlib import Path
from uuid import UUID

from ingestion_pages import loads_source_json
from replay_ingestion import replay
from worker_rpc import WorkerRpc, WorkerRpcError


def snapshot_input(inputs):
    # 재생 봉투(페이지 원문·문서 입력)와 호출자가 덧붙인 필드를 DB로 넘기지 않는다.
    input_snapshot = {key: inputs[key] for key in (
        'noticeSource', 'asOf', 'start', 'end', 'requestRegionCodes', 'tradeKinds', 'pageSize'
    ) if key in inputs}
    input_snapshot['target'] = {key: inputs['target'][key] for key in ('houseManageNo', 'noticeNo', 'edition')}
    return input_snapshot


def save_snapshot(user_id, analysis_id, capture_key, inputs, result, *, env, opener=None):
    """수집 작업의 고정 입력과 결과를 보낸다. 응답 유실 시 같은 키로 재시도한다."""
    client = WorkerRpc(env, opener)
    payload = {'p_user_id': str(UUID(str(user_id))), 'p_analysis_id': str(UUID(str(analysis_id))),
               'p_capture_key': str(UUID(str(capture_key))), 'p_input': snapshot_input(inputs), 'p_result': result}
    try:
        return str(UUID(client.post('save_ingestion_snapshot', payload, limit=128)))
    except WorkerRpcError as exc:
        if exc.status is not None:
            raise RuntimeError(f'저장 RPC 실패 (HTTP {exc.status})') from None
    except (ValueError, TypeError, AttributeError):
        pass
    raise RuntimeError('저장 응답을 확인하지 못했습니다. 같은 수집 키로 재시도하세요.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path, help='BE-02 합성 재생 JSON')
    parser.add_argument('--owner-id', required=True, type=UUID)
    parser.add_argument('--analysis-id', required=True, type=UUID)
    parser.add_argument('--capture-key', required=True, type=UUID, help='재시도할 때 유지하는 수집 UUID')
    args = parser.parse_args()
    try:
        bundle = loads_source_json(args.bundle.read_text(encoding='utf-8'))
        result = replay(bundle)
    except (OSError, ValueError, TypeError):
        parser.exit(2, '합성 재생 입력을 읽거나 정규화할 수 없습니다.\n')
    try:
        snapshot_id = save_snapshot(args.owner_id, args.analysis_id, args.capture_key, bundle['request'],
                                    result, env=os.environ)
    except (ValueError, RuntimeError) as exc:
        print(exc, file=sys.stderr)
        return 1
    print(json.dumps({'snapshotId': snapshot_id}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
