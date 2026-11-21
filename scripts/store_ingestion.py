#!/usr/bin/env python3
"""BE-02가 정규화한 수집 결과와 조회 조건을 개발 DB의 한 분석에 저장한다."""
import argparse
import base64
import binascii
import http.client
import json
import os
import re
import sys
from pathlib import Path
from urllib import error, parse, request
from uuid import UUID

from ingestion_pages import loads_source_json
from probe_apis import NoRedirect
from replay_ingestion import replay


def save_snapshot(user_id, analysis_id, capture_key, inputs, result, *, env, opener=None):
    """신뢰하는 수집 작업에서 호출한다. 응답 본문이나 작업자 키를 오류 메시지에 넣지 않는다."""
    if env.get('APP_ENV', 'development') != 'development' or env.get('VERCEL_ENV') == 'production':
        raise ValueError('개발 환경에서만 수집을 저장할 수 있습니다.')
    try:
        target = parse.urlsplit(env.get('SUPABASE_URL', ''))
        port = target.port
    except ValueError:
        raise ValueError('개발 Supabase의 주소가 필요합니다.') from None
    local = target.hostname in ('localhost', '127.0.0.1', '::1') and target.scheme in ('http', 'https')
    hosted = (target.hostname == 'jcaelooqogosbzrfyrhe.supabase.co'
              and target.scheme == 'https' and port in (None, 443))
    if (not (local or hosted) or target.username is not None or target.password is not None
            or target.path not in ('', '/') or target.query or target.fragment):
        raise ValueError('개발 Supabase의 주소가 필요합니다.')
    worker_key = env.get('SUPABASE_WORKER_KEY', '')
    headers = {'Content-Type': 'application/json', 'apikey': worker_key}
    if re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', worker_key):
        claims = worker_key.split('.')[1]
        try:
            role = json.loads(base64.urlsafe_b64decode(claims + '=' * (-len(claims) % 4))).get('role')
        except (binascii.Error, ValueError, AttributeError):
            role = None
        if role != 'service_role':
            raise ValueError('작업자 전용 키를 실행 환경에 설정하세요.')
        headers['Authorization'] = 'Bearer ' + worker_key
    elif not re.fullmatch(r'sb_secret_[A-Za-z0-9_-]+', worker_key):
        raise ValueError('작업자 전용 키를 실행 환경에 설정하세요.')

    # 재생 봉투(페이지 원문·문서 입력)와 호출자가 덧붙인 필드를 DB로 넘기지 않는다.
    input_snapshot = {key: inputs[key] for key in (
        'noticeSource', 'asOf', 'start', 'end', 'requestRegionCodes', 'tradeKinds', 'pageSize'
    ) if key in inputs}
    input_snapshot['target'] = {key: inputs['target'][key] for key in ('houseManageNo', 'noticeNo', 'edition')}
    payload = {'p_user_id': str(UUID(str(user_id))), 'p_analysis_id': str(UUID(str(analysis_id))),
               'p_capture_key': str(UUID(str(capture_key))), 'p_input': input_snapshot, 'p_result': result}
    url = parse.urlunsplit((target.scheme, target.netloc, '/rest/v1/rpc/save_ingestion_snapshot', '', ''))
    req = request.Request(url, data=json.dumps(payload, ensure_ascii=False, allow_nan=False).encode(),
                          headers=headers, method='POST')
    if opener is None:
        opener = request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=30) as response:
            body = response.read(129)
            if len(body) > 128:
                raise ValueError('unexpected_rpc_response')
            return str(UUID(json.loads(body)))
    except error.HTTPError as exc:
        with exc:
            status = exc.code
        raise RuntimeError(f'저장 RPC 실패 (HTTP {status})') from None
    except (OSError, http.client.HTTPException, ValueError, TypeError, AttributeError):
        raise RuntimeError('저장 응답을 확인하지 못했습니다. 같은 수집 키로 재시도하세요.') from None


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
