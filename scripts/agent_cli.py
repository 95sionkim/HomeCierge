#!/usr/bin/env python3
"""합성 또는 고정 비교 결과 JSON으로 에이전트 한 턴을 실행해 JSON을 출력한다(Colab·평가 공용)."""
import argparse
import json
import sys
from pathlib import Path

if __package__:
    from .agent_llm import (
        AgentLLMError,
        DEFAULT_MODEL,
        OpenAIResponsesProvider,
        SUPPORTED_MODELS,
        StubProvider,
    )
    from .agent_orchestrator import run_turn
else:
    from agent_llm import (
        AgentLLMError,
        DEFAULT_MODEL,
        OpenAIResponsesProvider,
        SUPPORTED_MODELS,
        StubProvider,
    )
    from agent_orchestrator import run_turn


def _load_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def run_cli(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--comparison', required=True, type=Path, help='comparison/v1 JSON 파일 경로')
    parser.add_argument('--message', required=True, help='사용자 질문 또는 조건 변경 요청 문장')
    parser.add_argument('--provider', choices=('stub', 'openai'), default='stub', help='LLM 공급자(stub|openai)')
    parser.add_argument('--model', choices=SUPPORTED_MODELS, default=DEFAULT_MODEL, help='사용할 모델 ID')
    parser.add_argument('--bounds', type=Path, help='선택 conditionBounds JSON 파일 경로')
    parser.add_argument('--source-permissions', type=Path, help='선택 source_id -> llm_permission JSON 파일 경로')
    parser.add_argument('--timeout', type=float, default=30.0, help='OpenAI 요청 시간 제한(초)')
    parser.add_argument('--output', type=Path, help='결과 JSON을 저장할 파일 경로')
    args = parser.parse_args(argv)

    comparison = _load_json(args.comparison)
    context = {'comparison': comparison}
    if args.bounds is not None:
        context['conditionBounds'] = _load_json(args.bounds)
    if args.source_permissions is not None:
        context['sourcePermissions'] = _load_json(args.source_permissions)

    try:
        if args.provider == 'stub':
            provider = StubProvider(model=args.model)
        else:
            provider = OpenAIResponsesProvider(model=args.model, timeout_seconds=args.timeout)
        result = run_turn(args.message.strip(), context, provider)
    except AgentLLMError as exc:
        payload = {'error': exc.code, 'message': str(exc), 'provider': args.provider, 'model': args.model}
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 2
    except (OSError, ValueError) as exc:
        payload = {'error': 'invalid_cli_input', 'message': str(exc)}
        print(json.dumps(payload, ensure_ascii=False, indent=2), file=sys.stderr)
        return 2

    rendered = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)
    if args.output is not None:
        args.output.write_text(rendered + '\n', encoding='utf-8')
    print(rendered)
    return 0


if __name__ == '__main__':
    sys.exit(run_cli())
