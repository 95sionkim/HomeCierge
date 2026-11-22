"""격리된 Auth 검수에서 제공기관 전송만 합성하고 실제 큐·수집·저장 경로를 실행한다."""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

from notice_run_capture import NoticeTransports
from run_analysis_worker import run_once
from worker_rpc import WorkerRpc


def run_sample(run_id, edition, mode):
    if urlsplit(os.environ.get('SUPABASE_URL', '')).hostname not in ('localhost', '127.0.0.1'):
        raise ValueError('격리된 로컬 DB가 필요합니다.')
    if mode not in ('present', 'missing'):
        raise ValueError('합성 주택형 사례가 필요합니다.')
    samples = json.loads((Path(__file__).resolve().parents[1] / 'tests/fixtures/ingestion-v0.json').read_text())
    records = {p['source']: p['body']['data'][0] for p in samples['pages'] if p['source'].startswith('applyhome')}
    records['applyhome_apt']['RCRIT_PBLANC_DE'] = edition
    records['applyhome_apt']['HSSPLY_ADRES'] = '서울특별시 광진구 합성로 1'

    def provider(source, scope, page, size):
        if page != 1:
            raise AssertionError('합성 응답은 한 페이지입니다.')
        if source in records:
            rows = [] if source == 'applyhome_apt_model' and mode == 'missing' else [records[source]]
            body = {'page': page, 'perPage': size, 'currentCount': len(rows), 'matchCount': len(rows),
                    'totalCount': len(rows), 'data': rows}
        elif source in ('apt_trade', 'apt_rights'):
            if mode == 'missing':
                raise AssertionError('주택형 확인 전 실거래를 요청했습니다.')
            body = {'response': {'header': {'resultCode': '000', 'resultMsg': 'OK'},
                                 'body': {'pageNo': page, 'numOfRows': size, 'totalCount': 0, 'items': {}}}}
        else:
            raise AssertionError('허용한 합성 출처가 아닙니다.')
        return {'source': source, 'scope': scope, 'page': page, 'pageSize': size, 'httpStatus': 200,
                'observedAt': datetime.now(timezone.utc).isoformat(), 'body': body}

    def pdf(*args, **kwargs):
        raise AssertionError('공식 PDF 사용 보류를 무시했습니다.')

    return run_once(WorkerRpc(os.environ), run_id=UUID(run_id), notice=NoticeTransports(provider, pdf))


if __name__ == '__main__':
    print(json.dumps(run_sample(*sys.argv[1:]), ensure_ascii=False))
