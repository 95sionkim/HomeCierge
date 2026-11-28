"""수집·분석·삭제·에이전트 작업자가 공통으로 사용하는 Supabase RPC 전송."""
import base64
import binascii
import http.client
import json
import re
from urllib import error, parse, request

from probe_apis import NoRedirect

PROJECT_ORIGINS = {
    'development': 'https://jcaelooqogosbzrfyrhe.supabase.co',
    'production': 'https://rwomqnyhqpnejytdzwfn.supabase.co',
}
ENVIRONMENTS = tuple(PROJECT_ORIGINS)


class WorkerRpcError(RuntimeError):
    """응답 본문·인증값 없이 전송 결과만 전달한다. status=None이면 커밋 여부는 미확인이다."""
    def __init__(self, status=None, code=None, *, save_retries=0, save_retry_reasons=()):
        super().__init__('RPC 응답을 확인할 수 없습니다.' if status is None else f'RPC 실패 (HTTP {status})')
        self.status = status
        self.code = code
        self.save_retries = save_retries
        self.save_retry_reasons = tuple(save_retry_reasons)


class WorkerRpcResponseTooLarge(WorkerRpcError):
    """읽기 응답이 호출자가 처리할 수 있는 크기를 넘었다."""


def is_transient_save_error(exc):
    """저장 RPC 재시도 대상 일시 오류(HTTP 5xx, 57014, 연결·시간 초과)인지 판정한다."""
    if not isinstance(exc, WorkerRpcError) or isinstance(exc, WorkerRpcResponseTooLarge):
        return False
    if exc.code == '57014':
        return True
    if exc.status is None:
        return True
    return 500 <= exc.status <= 599


def save_error_reason(exc):
    """상태 기록용 안전한 저장 재시도 사유 코드를 반환한다(원문·키 미포함)."""
    if exc.code == '57014':
        return 'statement_timeout'
    if exc.status is None:
        return 'response_unconfirmed'
    return f'http_{int(exc.status)}'


class WorkerRpc:
    def __init__(self, env, opener=None):
        if env.get('VERCEL_ENV') or env.get('VERCEL_TARGET_ENV'):
            raise ValueError('Vercel 함수 환경에서는 작업자를 실행할 수 없습니다.')
        app_env = env.get('APP_ENV', 'development')
        if app_env not in PROJECT_ORIGINS or (app_env == 'development' and env.get('NODE_ENV') == 'production'):
            raise ValueError('허용된 작업자 실행 환경이 아닙니다.')
        raw_url = env.get('SUPABASE_URL', '')
        if not isinstance(raw_url, str) or raw_url != raw_url.strip():
            raise ValueError('실행 환경과 일치하는 Supabase 주소가 필요합니다.')
        try:
            target = parse.urlsplit(raw_url)
            port = target.port
        except ValueError:
            raise ValueError('실행 환경과 일치하는 Supabase 주소가 필요합니다.') from None
        expected_host = parse.urlsplit(PROJECT_ORIGINS[app_env]).hostname
        local = (app_env == 'development'
                 and target.hostname in ('localhost', '127.0.0.1', '::1')
                 and target.scheme in ('http', 'https'))
        hosted = (target.hostname == expected_host
                  and target.scheme == 'https' and port in (None, 443))
        if (not (local or hosted) or target.username is not None or target.password is not None
                or target.netloc.endswith(':') or target.path not in ('', '/')
                or target.query or target.fragment or '?' in raw_url or '#' in raw_url):
            raise ValueError('실행 환경과 일치하는 Supabase 주소가 필요합니다.')
        key = env.get('SUPABASE_WORKER_KEY', '')
        self.headers = {'Content-Type': 'application/json', 'apikey': key}
        if re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', key):
            claims = key.split('.')[1]
            try:
                role = json.loads(base64.urlsafe_b64decode(claims + '=' * (-len(claims) % 4))).get('role')
            except (binascii.Error, ValueError, AttributeError):
                role = None
            if role != 'service_role':
                raise ValueError('작업자 전용 키를 실행 환경에 설정하세요.')
            self.headers['Authorization'] = 'Bearer ' + key
        elif not re.fullmatch(r'sb_secret_[A-Za-z0-9_-]+', key):
            raise ValueError('작업자 전용 키를 실행 환경에 설정하세요.')
        self.base = parse.urlunsplit((target.scheme, target.netloc, '/rest/v1/rpc/', '', ''))
        self.opener = opener if opener is not None else request.build_opener(NoRedirect)

    def post(self, name, arguments, *, limit=16384, allow_no_content=False, timeout=30):
        if not re.fullmatch(r'[a-z_]+', name):
            raise ValueError('잘못된 RPC 이름입니다.')
        body = json.dumps(arguments, ensure_ascii=False, allow_nan=False).encode()
        call = request.Request(self.base + name, data=body, headers=self.headers, method='POST')
        try:
            with self.opener.open(call, timeout=timeout) as response:
                data = response.read(limit + 1)
                if allow_no_content and response.status == 204 and not data:
                    return None
            if len(data) > limit:
                raise WorkerRpcResponseTooLarge()
            return json.loads(data)
        except error.HTTPError as exc:
            code = None
            with exc:
                try:
                    detail = json.loads(exc.read(2048))
                    if isinstance(detail, dict) and detail.get('code') in (
                            'PT403', 'PT404', 'PT409', 'PT422', '22023', '23503', '23505', '42501', '57014'):
                        code = detail['code']
                except (OSError, http.client.HTTPException, ValueError, TypeError):
                    pass
            raise WorkerRpcError(exc.code, code) from None
        except (OSError, http.client.HTTPException, ValueError, TypeError):
            raise WorkerRpcError() from None
