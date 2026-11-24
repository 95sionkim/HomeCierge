#!/usr/bin/env python3
"""확인된 삭제 요청 한 건의 비공개 PDF와 Auth 계정을 정리한다."""
import argparse
import http.client
import json
import os
import sys
from urllib import error, parse, request
from uuid import UUID

from worker_rpc import WorkerRpc, WorkerRpcError


SCOPES = {'account', 'chat', 'analysis', 'upload', 'message', 'turn', 'fund', 'profile', 'report'}
MAX_PATHS = 50


def canonical_uuid(value):
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except ValueError:
        return False


def valid_upload_path(path, owner):
    if not isinstance(path, str):
        return False
    parts = path.split('/')
    return (len(parts) == 3 and parts[0] == owner and canonical_uuid(parts[1])
            and parts[2].endswith('.pdf') and canonical_uuid(parts[2][:-4]))


def remove(client, resource, body):
    origin = parse.urlsplit(client.base)
    url = parse.urlunsplit((origin.scheme, origin.netloc, resource, '', ''))
    call = request.Request(url, data=json.dumps(body).encode(), headers=client.headers, method='DELETE')
    try:
        # Storage/Auth의 응답 원문에는 파일 경로나 계정 정보가 포함될 수 있다.
        with client.opener.open(call, timeout=30) as response:
            if response.status not in (200, 204):
                raise WorkerRpcError(response.status)
    except error.HTTPError as exc:
        with exc:
            if exc.code != 404:
                raise WorkerRpcError(exc.code) from None
    except (OSError, http.client.HTTPException):
        raise WorkerRpcError() from None


def process_once(client, receipt=None):
    args = {'p_receipt': receipt} if receipt else {}
    try:
        job = client.post('deletion_work', args)
    except WorkerRpcError as exc:
        if exc.status == 409 and exc.code == 'PT409':
            return 'storage_review_required'
        raise
    if job is None:
        return 'idle'
    if not isinstance(job, dict):
        raise ValueError('invalid_deletion_job')
    owner, job_id, scope = (job.get(k) for k in ('ownerId', 'receiptId', 'scope'))
    paths, delete_auth = job.get('paths'), job.get('deleteAuth')
    if (not canonical_uuid(owner) or not canonical_uuid(job_id) or UUID(job_id).version != 4
            or (receipt is not None and receipt != job_id) or not isinstance(scope, str) or scope not in SCOPES
            or type(delete_auth) is not bool or not isinstance(paths, list) or len(paths) > MAX_PATHS
            or not all(valid_upload_path(path, owner) for path in paths) or len(set(paths)) != len(paths)
            or (delete_auth and (scope != 'account' or paths))):
        raise ValueError('invalid_deletion_job')
    if paths:
        remove(client, '/storage/v1/object/analysis-uploads', {'prefixes': paths})
    elif delete_auth:
        remove(client, '/auth/v1/admin/users/' + owner, {'should_soft_delete': False})
    # 성공 응답이나 404 자체로 완료를 만들지 않는다. DB가 실제 객체와 계정의 부재를 확인한다.
    updated = client.post('advance_deletion_work', {'p_receipt': job_id})
    if (not isinstance(updated, dict) or updated.get('receiptId') != job_id or updated.get('scope') != scope
            or updated.get('status') not in ('processing', 'live_deleted')):
        raise ValueError('invalid_deletion_receipt')
    return updated['status']


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--once', required=True, action='store_true', help='한 번만 처리')
    cli.add_argument('--receipt', help='특정 접수번호의 작업만 처리')
    args = cli.parse_args()
    if args.receipt is not None and (not canonical_uuid(args.receipt) or UUID(args.receipt).version != 4):
        cli.error('올바른 접수번호가 필요합니다.')
    try:
        print(json.dumps({'status': process_once(WorkerRpc(os.environ), args.receipt)}))
        return 0
    except (ValueError, WorkerRpcError):
        print('삭제 작업 상태를 확인하지 못했습니다. 기존 요청은 다시 처리할 수 있습니다.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
