"""LLM 공급자 인터페이스, OpenAI Responses API 어댑터, 단가 추정과 합성 대역."""
import http.client
import json
import os
import stat
import time
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from urllib import error, parse, request


ROOT = Path(__file__).resolve().parents[1]
OPENAI_KEY_NAME = 'OPENAI_API_KEY'
OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
# 2026-11-26 사용자 결정 Q-43: 기준 모델을 gpt-6.1-sol에서 gpt-6.2-sol로 바꿨다.
DEFAULT_MODEL = 'gpt-6.2-sol'
PRICING_AS_OF = '2026-11-12'

# PRD §7.6.1 기준 단가표 (USD, 100만 토큰당 Standard·Short 기준). asOf는 모델별 공식 가격 확인일이다.
MODEL_PRICING = {
    'gpt-6.2-sol': {'input': Decimal('2'), 'output': Decimal('10'), 'asOf': '2026-11-26'},
    'gpt-6.1-terra': {'input': Decimal('1'), 'output': Decimal('5'), 'asOf': PRICING_AS_OF},
    'gpt-6-luna': {'input': Decimal('0.10'), 'output': Decimal('0.50'), 'asOf': PRICING_AS_OF},
    'gpt-6-astra': {'input': Decimal('10'), 'output': Decimal('50'), 'asOf': PRICING_AS_OF},
}
SUPPORTED_MODELS = tuple(MODEL_PRICING.keys())
TOKENS_PER_UNIT = Decimal('1000000')
COST_QUANT = Decimal('0.00000001')
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class _NoRedirect(request.HTTPRedirectHandler):
    """인증 헤더가 다른 호스트로 전달되지 않도록 리디렉션을 차단한다."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise error.HTTPError(req.full_url, code, 'redirect_blocked', headers, fp)


class AgentLLMError(RuntimeError):
    """인증값·응답 원문을 노출하지 않고 오류 분류 코드만 전달한다."""

    def __init__(self, code, message=None, *, retryable=False, http_status=None):
        super().__init__(message or code)
        self.code = code
        self.retryable = bool(retryable)
        self.http_status = http_status


class LLMUnavailableError(AgentLLMError):
    def __init__(self, message='OPENAI_API_KEY가 설정되지 않았습니다.'):
        super().__init__('llm_unavailable', message, retryable=False)


class LLMAuthError(AgentLLMError):
    def __init__(self, http_status=401):
        super().__init__('llm_auth_error', 'LLM API 인증에 실패했습니다.', retryable=False, http_status=http_status)


class LLMRateLimitError(AgentLLMError):
    def __init__(self, http_status=429):
        super().__init__('llm_rate_limited', 'LLM API 요청 한도에 도달했습니다.', retryable=True, http_status=http_status)


class LLMUpstreamError(AgentLLMError):
    def __init__(self, http_status=503):
        super().__init__('llm_upstream_error', 'LLM API 서버 응답에 실패했습니다.', retryable=True, http_status=http_status)


class LLMTimeoutError(AgentLLMError):
    def __init__(self):
        super().__init__('llm_timeout', 'LLM API 응답 시간이 초과됐습니다.', retryable=False)


class LLMBadResponseError(AgentLLMError):
    def __init__(self, code='llm_bad_response', message='LLM 응답 형식을 확인할 수 없습니다.', *, http_status=None):
        super().__init__(code, message, retryable=False, http_status=http_status)


class LLMRefusalError(AgentLLMError):
    def __init__(self):
        super().__init__('llm_refused', 'LLM이 응답을 거절했습니다.', retryable=False)


def _read_secret_field(path, name, *, private=True):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if (not stat.S_ISREG(info.st_mode) or info.st_size > 64 * 1024
            or (private and (info.st_uid != os.getuid() or info.st_mode & 0o077))):
        raise LLMUnavailableError('OPENAI_API_KEY 파일 권한 또는 형식이 올바르지 않습니다.')
    entries = [
        value.strip().strip('"').strip("'")
        for line in path.read_text(encoding='utf-8').splitlines()
        if line.strip() and not line.lstrip().startswith('#')
        for key, sep, value in [line.partition('=')]
        if sep and key.strip() == name
    ]
    if len(entries) > 1:
        raise LLMUnavailableError('OPENAI_API_KEY 설정이 중복됐습니다.')
    return entries[0] if entries and entries[0] else None


def load_openai_api_key(*, env=None, secret_dir=None, private=True):
    """실행 환경의 OPENAI_API_KEY 또는 .secrets/OPENAI_API_KEY.env에서만 키를 읽는다."""
    source_env = os.environ if env is None else env
    raw = source_env.get(OPENAI_KEY_NAME)
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    secrets = (ROOT / '.secrets') if secret_dir is None else Path(secret_dir)
    key = _read_secret_field(secrets / (OPENAI_KEY_NAME + '.env'), OPENAI_KEY_NAME, private=private)
    if not key:
        raise LLMUnavailableError()
    return key


def validate_model(model):
    if not isinstance(model, str) or model not in MODEL_PRICING:
        raise ValueError('지원하지 않는 모델입니다: ' + str(model))
    return model


def estimate_cost_usd(model, input_tokens, output_tokens):
    """PRD §7.6.1·§12.5.3 단가표 기준으로 단일 호출의 추정 비용(USD)을 계산한다.

    OpenAI Responses API의 output_tokens에는 reasoning_tokens가 포함되므로 중복 합산하지 않는다.
    """
    rates = MODEL_PRICING.get(model)
    if rates is None:
        return None
    if type(input_tokens) is not int or input_tokens < 0 or type(output_tokens) is not int or output_tokens < 0:
        return None
    cost = (Decimal(input_tokens) * rates['input'] + Decimal(output_tokens) * rates['output']) / TOKENS_PER_UNIT
    return format(cost.quantize(COST_QUANT, rounding=ROUND_HALF_UP), 'f')


def build_usage_record(
    provider_name,
    model,
    *,
    input_tokens=0,
    output_tokens=0,
    reasoning_tokens=0,
    cached_input_tokens=0,
    latency_ms=0,
    attempts=1,
    synthetic=False,
):
    in_tok = max(0, int(input_tokens))
    out_tok = max(0, int(output_tokens))
    reason_tok = max(0, int(reasoning_tokens))
    cached_tok = max(0, int(cached_input_tokens))
    lat_ms = max(0, int(latency_ms))
    att = max(1, int(attempts))
    return {
        'provider': str(provider_name),
        'model': str(model),
        'synthetic': bool(synthetic),
        'inputTokens': in_tok,
        'outputTokens': out_tok,
        'reasoningTokens': reason_tok,
        'cachedInputTokens': cached_tok,
        'totalTokens': in_tok + out_tok,
        'latencyMs': lat_ms,
        'attempts': att,
        'estimatedCostUsd': estimate_cost_usd(model, in_tok, out_tok),
        'pricingAsOf': MODEL_PRICING.get(str(model), {}).get('asOf', PRICING_AS_OF),
        'currency': 'USD',
    }


def merge_usage_records(records):
    if not records:
        return build_usage_record('unknown', DEFAULT_MODEL, attempts=1, synthetic=False)
    first = records[0]
    in_tok = sum(int(r.get('inputTokens', 0)) for r in records)
    out_tok = sum(int(r.get('outputTokens', 0)) for r in records)
    reason_tok = sum(int(r.get('reasoningTokens', 0)) for r in records)
    cached_tok = sum(int(r.get('cachedInputTokens', 0)) for r in records)
    lat_ms = sum(int(r.get('latencyMs', 0)) for r in records)
    attempts = sum(int(r.get('attempts', 1)) for r in records)
    return build_usage_record(
        first.get('provider', 'unknown'),
        first.get('model', DEFAULT_MODEL),
        input_tokens=in_tok,
        output_tokens=out_tok,
        reasoning_tokens=reason_tok,
        cached_input_tokens=cached_tok,
        latency_ms=lat_ms,
        attempts=attempts,
        synthetic=bool(first.get('synthetic', False)),
    )


def _retry_delay(headers, attempt, base_backoff, max_backoff):
    if headers is not None:
        raw_after = headers.get('Retry-After')
        if isinstance(raw_after, str) and raw_after.strip().isdigit():
            return min(float(int(raw_after.strip())), float(max_backoff))
    return min(float(base_backoff) * (2 ** attempt), float(max_backoff))


def _is_retryable_status(status):
    return status == 429 or (500 <= status <= 599)


def _parse_responses_payload(data, *, provider_name, model, latency_ms, attempts, synthetic=False):
    if not isinstance(data, dict):
        raise LLMBadResponseError()
    status = data.get('status')
    if status == 'incomplete':
        raise LLMBadResponseError('llm_incomplete_response', 'LLM 응답이 출력 한도 등으로 미완료 상태입니다.')
    if status not in (None, 'completed'):
        raise LLMBadResponseError('llm_bad_response', 'LLM 응답 상태가 완료가 아닙니다.')

    raw_usage = data.get('usage') if isinstance(data.get('usage'), dict) else {}
    in_tok = raw_usage.get('input_tokens', 0)
    out_tok = raw_usage.get('output_tokens', 0)
    out_details = raw_usage.get('output_tokens_details') if isinstance(raw_usage.get('output_tokens_details'), dict) else {}
    in_details = raw_usage.get('input_tokens_details') if isinstance(raw_usage.get('input_tokens_details'), dict) else {}
    reason_tok = out_details.get('reasoning_tokens', 0)
    cached_tok = in_details.get('cached_tokens', 0)
    if any(type(v) is not int or v < 0 for v in (in_tok, out_tok, reason_tok, cached_tok)):
        raise LLMBadResponseError()

    usage = build_usage_record(
        provider_name,
        model,
        input_tokens=in_tok,
        output_tokens=out_tok,
        reasoning_tokens=reason_tok,
        cached_input_tokens=cached_tok,
        latency_ms=latency_ms,
        attempts=attempts,
        synthetic=synthetic,
    )

    output_items = data.get('output')
    if not isinstance(output_items, list):
        raise LLMBadResponseError()

    tool_calls = []
    text_parts = []
    for item in output_items:
        if not isinstance(item, dict):
            continue
        item_type = item.get('type')
        if item_type == 'function_call':
            call_id = item.get('call_id')
            name = item.get('name')
            raw_args = item.get('arguments', '{}')
            if not isinstance(call_id, str) or not call_id or not isinstance(name, str) or not name:
                raise LLMBadResponseError()
            if isinstance(raw_args, str):
                try:
                    parsed_args = json.loads(raw_args) if raw_args.strip() else {}
                except ValueError:
                    raise LLMBadResponseError() from None
            elif isinstance(raw_args, dict):
                parsed_args = raw_args
            else:
                raise LLMBadResponseError()
            if not isinstance(parsed_args, dict):
                raise LLMBadResponseError()
            tool_calls.append({'call_id': call_id, 'name': name, 'arguments': parsed_args})
        elif item_type == 'message':
            content = item.get('content')
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get('type')
                if btype == 'refusal':
                    raise LLMRefusalError()
                if btype == 'output_text' and isinstance(block.get('text'), str):
                    text_parts.append(block['text'])

    parsed = None
    if text_parts and not tool_calls:
        combined = ''.join(text_parts).strip()
        try:
            parsed = json.loads(combined)
        except ValueError:
            raise LLMBadResponseError('llm_invalid_json', 'LLM 구조화 출력 JSON을 해석할 수 없습니다.') from None
        if not isinstance(parsed, dict):
            raise LLMBadResponseError('llm_invalid_json', 'LLM 구조화 출력은 JSON 객체여야 합니다.')
    elif not tool_calls:
        raise LLMBadResponseError('llm_empty_output', 'LLM 응답에 출력 텍스트나 도구 호출이 없습니다.')

    return {
        'outputItems': output_items,
        'toolCalls': tool_calls,
        'parsed': parsed,
        'usage': usage,
    }


class LLMProvider:
    """에이전트 오케스트레이터가 사용하는 공급자 인터페이스."""

    name = 'base'
    synthetic = False

    def __init__(self, model=DEFAULT_MODEL):
        self.model = validate_model(model)

    def generate(self, *, instructions, input_items, response_schema, schema_name, tools=None, max_output_tokens=1200):
        raise NotImplementedError


class OpenAIResponsesProvider(LLMProvider):
    """OpenAI Responses API(HTTPS, 구조화 출력 JSON 스키마, 제한된 재시도) 어댑터."""

    name = 'openai'
    synthetic = False

    def __init__(
        self,
        *,
        model=DEFAULT_MODEL,
        api_key=None,
        env=None,
        secret_dir=None,
        endpoint=OPENAI_RESPONSES_URL,
        timeout_seconds=30.0,
        max_retries=2,
        base_backoff_seconds=0.5,
        max_backoff_seconds=8.0,
        opener=None,
        sleep=None,
        monotonic=None,
    ):
        super().__init__(model=model)
        parsed_url = parse.urlsplit(endpoint)
        if parsed_url.scheme != 'https' or not parsed_url.netloc or parsed_url.username or parsed_url.password:
            raise ValueError('OpenAI Responses API 주소는 HTTPS여야 합니다.')
        if timeout_seconds <= 0 or timeout_seconds > 120:
            raise ValueError('시간 제한은 0초 초과 120초 이하여야 합니다.')
        if type(max_retries) is not int or not 0 <= max_retries <= 5:
            raise ValueError('재시도 횟수는 0~5 범위여야 합니다.')

        if api_key is not None:
            if not isinstance(api_key, str) or not api_key.strip():
                raise LLMUnavailableError()
            self._api_key = api_key.strip()
        else:
            self._api_key = load_openai_api_key(env=env, secret_dir=secret_dir)

        self.endpoint = endpoint
        self.timeout_seconds = float(timeout_seconds)
        self.max_retries = max_retries
        self.base_backoff_seconds = float(base_backoff_seconds)
        self.max_backoff_seconds = float(max_backoff_seconds)
        self._opener = opener if opener is not None else request.build_opener(_NoRedirect)
        self._sleep = time.sleep if sleep is None else sleep
        self._monotonic = time.monotonic if monotonic is None else monotonic

    def __repr__(self):
        return f'OpenAIResponsesProvider(model={self.model!r}, endpoint={self.endpoint!r})'

    def generate(self, *, instructions, input_items, response_schema, schema_name, tools=None, max_output_tokens=1200):
        payload = {
            'model': self.model,
            'instructions': instructions,
            'input': input_items,
            'store': False,
            'max_output_tokens': int(max_output_tokens),
            'text': {
                'format': {
                    'type': 'json_schema',
                    'name': schema_name,
                    'strict': True,
                    'schema': response_schema,
                }
            },
        }
        if tools:
            payload['tools'] = tools

        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode('utf-8')
        headers = {
            'Authorization': 'Bearer ' + self._api_key,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        }

        started = self._monotonic()
        attempts = 0
        for attempt in range(self.max_retries + 1):
            attempts = attempt + 1
            req = request.Request(self.endpoint, data=body, headers=headers, method='POST')
            try:
                with self._opener.open(req, timeout=self.timeout_seconds) as resp:
                    raw = resp.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise LLMBadResponseError('llm_response_too_large', 'LLM 응답 크기가 허용 한도를 넘었습니다.')
                try:
                    data = json.loads(raw.decode('utf-8'))
                except (UnicodeDecodeError, ValueError):
                    raise LLMBadResponseError('llm_invalid_json', 'LLM 응답 JSON을 읽을 수 없습니다.') from None
                latency_ms = int((self._monotonic() - started) * 1000)
                return _parse_responses_payload(
                    data,
                    provider_name=self.name,
                    model=self.model,
                    latency_ms=latency_ms,
                    attempts=attempts,
                    synthetic=False,
                )
            except error.HTTPError as exc:
                status = exc.code
                resp_headers = exc.headers
                try:
                    exc.close()
                except Exception:
                    pass
                if _is_retryable_status(status) and attempt < self.max_retries:
                    delay = _retry_delay(resp_headers, attempt, self.base_backoff_seconds, self.max_backoff_seconds)
                    if delay > 0:
                        self._sleep(delay)
                    continue
                if status in (401, 403):
                    raise LLMAuthError(http_status=status) from None
                if status == 429:
                    raise LLMRateLimitError(http_status=status) from None
                if 500 <= status <= 599:
                    raise LLMUpstreamError(http_status=status) from None
                raise LLMBadResponseError('llm_bad_response', f'LLM 요청이 거부됐습니다 (HTTP {status}).',
                                          http_status=status) from None
            except TimeoutError:
                raise LLMTimeoutError() from None
            except error.URLError as exc:
                if isinstance(exc.reason, TimeoutError) or 'timed out' in str(exc.reason).lower():
                    raise LLMTimeoutError() from None
                raise LLMBadResponseError('llm_network_error', 'LLM API에 연결하지 못했습니다.') from None
            except (OSError, http.client.HTTPException):
                raise LLMBadResponseError('llm_network_error', 'LLM API 전송 중 오류가 발생했습니다.') from None


def _extract_tag(text, tag):
    start_marker = f'<{tag}>\n'
    end_marker = f'\n</{tag}>'
    start = text.rfind(start_marker)
    end = text.rfind(end_marker)
    if start < 0 or end < 0 or end <= start:
        return None
    return text[start + len(start_marker):end].strip()


def _synthetic_default_turn(input_items):
    """오프라인 회귀·CLI 재현용 합성 응답을 생성한다. 실제 LLM 판단을 대신하지 않는다."""
    user_text = ''
    for item in input_items:
        if isinstance(item, dict) and item.get('role') == 'user':
            content = item.get('content')
            if isinstance(content, str):
                user_text = content
            elif isinstance(content, list):
                user_text = '\n'.join(
                    b.get('text', '') for b in content if isinstance(b, dict) and isinstance(b.get('text'), str)
                )
    raw_data = _extract_tag(user_text, 'DATA_JSON')
    question = _extract_tag(user_text, 'USER_QUESTION') or ''
    context = {}
    if raw_data:
        try:
            context = json.loads(raw_data)
        except ValueError:
            context = {}

    comparison = context.get('comparison') if isinstance(context.get('comparison'), dict) else {}
    policy = context.get('llmSourcePolicy') if isinstance(context.get('llmSourcePolicy'), dict) else {}
    restricted = bool(policy.get('hasRestrictedSources'))
    comparables = comparison.get('comparables') if isinstance(comparison.get('comparables'), list) else []
    holds = comparison.get('holds') if isinstance(comparison.get('holds'), list) else []
    exclusions = comparison.get('exclusions') if isinstance(comparison.get('exclusions'), list) else []
    conditions = comparison.get('conditions') if isinstance(comparison.get('conditions'), dict) else {}
    period = conditions.get('period') if isinstance(conditions.get('period'), dict) else {}
    area = conditions.get('area') if isinstance(conditions.get('area'), dict) else {}
    region = comparison.get('regionDecision') if isinstance(comparison.get('regionDecision'), dict) else {}
    applied_scope = comparison.get('appliedScope')
    notice_price = comparison.get('noticePrice') if isinstance(comparison.get('noticePrice'), dict) else {}
    existing_proposal = context.get('existingProposal')

    citations = [{'kind': 'comparison', 'reference': 'comparison/v1', 'label': '비교 결과 요약'}]
    if restricted:
        citations.append({'kind': 'source_restriction', 'reference': 'llm_permission', 'label': 'LLM 입력 제한 출처 제외'})

    if isinstance(existing_proposal, dict):
        if existing_proposal.get('kind') == 'conditions':
            intent = 'change_conditions'
            proposal = {
                'kind': 'conditions',
                'period': existing_proposal.get('proposed', {}).get('period'),
                'areaTolerancePercent': existing_proposal.get('proposed', {}).get('areaTolerancePercent'),
                'tradeKinds': existing_proposal.get('proposed', {}).get('tradeKinds'),
                'replacements': existing_proposal.get('proposed', {}).get('replacements'),
            }
            answer = '요청하신 비교 조건 변경 제안을 확인했습니다. 사용자가 승인하면 같은 수집본으로 다시 비교하며, 공유 프로필은 변경되지 않습니다.'
            return {'intent': intent, 'proposal': proposal, 'answer': answer, 'citations': citations}
        if 'start' in existing_proposal and 'end' in existing_proposal:
            intent = 'change_period'
            proposal = {
                'kind': 'period',
                'period': {'start': existing_proposal['start'], 'end': existing_proposal['end']},
                'areaTolerancePercent': None,
                'tradeKinds': None,
                'replacements': None,
            }
            answer = (
                f"계약 기간을 {existing_proposal['start']}부터 {existing_proposal['end']}까지로 "
                '변경하는 제안을 확인했습니다. 승인하시면 같은 수집본으로 새 비교를 계산합니다.'
            )
            return {'intent': intent, 'proposal': proposal, 'answer': answer, 'citations': citations}

    if '보류' in question or '미확인' in question or '제외' in question:
        parts = []
        if holds:
            parts.append(f'보류 항목은 {len(holds)}건입니다.')
        if exclusions:
            parts.append(f'근거를 확인해 제외한 항목은 {len(exclusions)}건입니다.')
        if not parts:
            if comparison.get('completeness') == 'complete':
                parts.append('기록된 보류 또는 제외 항목은 없습니다.')
            else:
                parts.append('일부 근거가 확인되지 않아 비교 판정이 보류된 상태입니다.')
        if restricted:
            parts.append('LLM 입력이 허용되지 않은 출처의 값은 제외하고 설명했습니다.')
        return {'intent': 'holds', 'proposal': None, 'answer': ' '.join(parts), 'citations': citations}

    if '분양가' in question or '가격' in question or '소계' in question or '옵션' in question:
        if notice_price.get('status') == 'restricted_for_llm':
            answer = '공고 가격 자료는 LLM 입력 허용이 확인되지 않아 금액을 제외했습니다. 비교표 원문 근거에서 확인해 주세요.'
        elif notice_price.get('status') == 'confirmed' and isinstance(notice_price.get('won'), str):
            won_text = f"{int(notice_price['won']):,}원"
            answer = f'선택한 호실의 분양가와 필수 옵션 소계는 {won_text}입니다. 세금과 금융비용은 별도입니다.'
        elif (notice_price.get('status') == 'confirmed' and isinstance(notice_price.get('minWon'), str)
              and isinstance(notice_price.get('maxWon'), str)):
            low = f"{int(notice_price['minWon']):,}원"
            high = f"{int(notice_price['maxWon']):,}원"
            confirmed_n = len(notice_price.get('confirmedRooms') or [])
            held_n = len(notice_price.get('heldRooms') or [])
            range_str = low if low == high else f'{low}부터 {high}까지'
            answer = f'분양가와 필수 옵션을 함께 확인한 {confirmed_n}개 호실의 소계는 {range_str}입니다.'
            if held_n:
                answer += f' 확인이 필요한 호실은 {held_n}개입니다.'
            answer += ' 이 소계는 세금·금융비용을 포함하지 않은 값입니다.'
        else:
            answer = '이 결과에는 분양가와 필수 옵션을 함께 확인한 호실 소계가 없습니다.'
        return {'intent': 'price', 'proposal': None, 'answer': answer, 'citations': citations}

    if '기간' in question or '언제' in question or '계약일' in question:
        if period.get('status') == 'confirmed' and period.get('start') and period.get('end'):
            answer = f"적용된 계약 기간은 {period['start']}부터 {period['end']}까지 양 끝 날짜 포함입니다."
        else:
            answer = '이 결과의 계약 기간은 확정되지 않았습니다.'
        if restricted:
            answer += ' LLM 입력이 허용되지 않은 출처의 상세 값은 제외했습니다.'
        return {'intent': 'period', 'proposal': None, 'answer': answer, 'citations': citations}

    if '지역' in question or '범위' in question or '법정동' in question or '같은 동' in question or '확대' in question:
        pri = region.get('priority') if isinstance(region.get('priority'), dict) else {}
        exp = region.get('expansion') if isinstance(region.get('expansion'), dict) else {}
        if applied_scope == 'expansion' and pri.get('conclusion') == 'normal_zero':
            p_name = pri.get('name') or '우선 지역'
            e_name = exp.get('name') or '확대 지역'
            answer = f'{p_name}에서 주변 후보가 정상 0개로 확인되어 {e_name}까지 비교했습니다.'
        elif applied_scope == 'priority':
            p_name = pri.get('name') or '같은 법정동·읍·면'
            answer = f'적용된 비교 범위는 {p_name}입니다.'
        else:
            answer = '저장된 근거로는 비교 지역 범위를 확정할 수 없어 보류 상태입니다.'
        if restricted:
            answer += ' LLM 입력이 허용되지 않은 출처의 값은 제외했습니다.'
        return {'intent': 'scope', 'proposal': None, 'answer': answer, 'citations': citations}

    parts = []
    if comparables:
        parts.append(f'비교표에 포함된 주변 단지는 {len(comparables)}곳입니다.')
    else:
        scope_obj = region.get(applied_scope) if isinstance(applied_scope, str) else None
        if isinstance(scope_obj, dict) and scope_obj.get('conclusion') == 'normal_zero':
            parts.append('적용 범위에서 조건을 충족한 주변 단지가 0개로 확인됐습니다.')
        else:
            parts.append('현재 비교표에 표시된 주변 단지는 없으며, 미확인 사항이 남아 0건으로 확정하지 않았습니다.')
    if area.get('basis') == 'supply' and area.get('tolerancePercent'):
        parts.append(f"공급면적 허용 범위는 ±{area['tolerancePercent']}%입니다.")
    if period.get('status') == 'confirmed' and period.get('start') and period.get('end'):
        parts.append(f"계약 기간은 {period['start']}부터 {period['end']}까지입니다.")
    if exclusions:
        parts.append(f'제외된 기록은 {len(exclusions)}건입니다.')
    if restricted:
        parts.append('LLM 입력이 허용되지 않은 출처의 값은 제외하고 안내했습니다.')
    return {'intent': 'inclusion', 'proposal': None, 'answer': ' '.join(parts), 'citations': citations}


class StubProvider(LLMProvider):
    """네트워크 없이 테스트·오프라인 회귀에 쓰는 합성 LLM 공급자."""

    name = 'stub'
    synthetic = True

    def __init__(self, *, model=DEFAULT_MODEL, scripted=None, input_tokens=320, output_tokens=140, reasoning_tokens=0):
        super().__init__(model=model)
        self._scripted = list(scripted) if scripted is not None else None
        self._default_in = int(input_tokens)
        self._default_out = int(output_tokens)
        self._default_reason = int(reasoning_tokens)
        self.calls = []

    def generate(self, *, instructions, input_items, response_schema, schema_name, tools=None, max_output_tokens=1200):
        self.calls.append({
            'model': self.model,
            'instructions': instructions,
            'input': list(input_items),
            'schemaName': schema_name,
            'tools': tools,
            'maxOutputTokens': max_output_tokens,
        })
        if self._scripted is not None:
            if not self._scripted:
                raise LLMBadResponseError('stub_exhausted', 'StubProvider에 준비된 합성 응답이 없습니다.')
            entry = self._scripted.pop(0)
            if callable(entry):
                entry = entry(instructions=instructions, input_items=input_items, tools=tools)
            if isinstance(entry, Exception):
                raise entry
            if isinstance(entry, dict) and 'output' in entry:
                return _parse_responses_payload(
                    entry,
                    provider_name=self.name,
                    model=self.model,
                    latency_ms=entry.get('latencyMs', 5),
                    attempts=1,
                    synthetic=True,
                )
            parsed = entry
        else:
            parsed = _synthetic_default_turn(input_items)

        text = json.dumps(parsed, ensure_ascii=False, allow_nan=False)
        usage = build_usage_record(
            self.name,
            self.model,
            input_tokens=self._default_in,
            output_tokens=self._default_out,
            reasoning_tokens=self._default_reason,
            latency_ms=5,
            attempts=1,
            synthetic=True,
        )
        return {
            'outputItems': [
                {
                    'type': 'message',
                    'role': 'assistant',
                    'content': [{'type': 'output_text', 'text': text}],
                }
            ],
            'toolCalls': [],
            'parsed': parsed,
            'usage': usage,
        }
