#!/usr/bin/env python3
"""비교 대화 에이전트 응답 대기열 한 건을 임대·실행·검증·저장한다."""
import argparse
import json
import os
import sys
import time
from uuid import UUID

if __package__:
    from .agent_llm import AgentLLMError, OpenAIResponsesProvider, SUPPORTED_MODELS
    from .agent_orchestrator import run_turn
    from .worker_rpc import WorkerRpc, WorkerRpcError, WorkerRpcResponseTooLarge
else:
    from agent_llm import AgentLLMError, OpenAIResponsesProvider, SUPPORTED_MODELS
    from agent_orchestrator import run_turn
    from worker_rpc import WorkerRpc, WorkerRpcError, WorkerRpcResponseTooLarge


MAX_AGENT_CONTEXT_BYTES = 4 * 1024 * 1024


def _lease_identity(job):
    try:
        reply_id = str(UUID(job['replyId']))
        lease_token = str(UUID(job['leaseToken']))
        generation = job['generation']
        model = job['model']
        if type(generation) is not int or generation < 1 or model not in SUPPORTED_MODELS:
            raise ValueError
        return {
            'p_reply_id': reply_id,
            'p_generation': generation,
            'p_lease_token': lease_token,
        }, model
    except (KeyError, TypeError, AttributeError, ValueError):
        raise WorkerRpcError() from None


def process_once(client, provider_factory, *, lease_seconds=60, reply_id=None):
    """대기열에서 만료된 임대를 정리한 뒤 에이전트 응답 작업 한 건을 처리한다."""
    if type(lease_seconds) is not int or not 1 <= lease_seconds <= 300:
        raise ValueError('임대 시간은 1~300초여야 합니다.')
    claim_args = {'p_lease_seconds': lease_seconds}
    if reply_id is not None:
        claim_args['p_reply_id'] = str(UUID(str(reply_id)))
    job = client.post('claim_agent_reply', claim_args)
    if job is None:
        return {'status': 'idle'}
    lease, model = _lease_identity(job)
    claimed_id = lease['p_reply_id']

    try:
        try:
            context = client.post('read_agent_reply_context', lease, limit=MAX_AGENT_CONTEXT_BYTES)
        except WorkerRpcResponseTooLarge:
            client.post('fail_agent_reply', {**lease, 'p_failure_code': 'context_too_large'})
            return {'status': 'failed', 'replyId': claimed_id, 'failureCode': 'context_too_large'}
        if not isinstance(context, dict) or not isinstance(context.get('message'), str):
            client.post('fail_agent_reply', {**lease, 'p_failure_code': 'invalid_context'})
            return {'status': 'failed', 'replyId': claimed_id, 'failureCode': 'invalid_context'}

        provider = provider_factory(context.get('model') or model)
        result = run_turn(context['message'], context, provider)
        completed = client.post('complete_agent_reply', {
            **lease,
            'p_status': result['status'],
            'p_intent': result['intent'],
            'p_answer': result['answer'],
            'p_citations': result['citations'],
            'p_proposal': result['proposal'],
            'p_usage': result['usage'],
            'p_validation': result['validation'],
            'p_prompt_version': result['promptVersion'],
        })
        if not isinstance(completed, dict) or completed.get('status') not in ('answered', 'rejected'):
            raise WorkerRpcError()
        return {'status': completed['status'], 'replyId': claimed_id}
    except AgentLLMError as exc:
        try:
            client.post('fail_agent_reply', {**lease, 'p_failure_code': exc.code})
        except WorkerRpcError as rpc_exc:
            if rpc_exc.code in ('PT404', 'PT409'):
                return {'status': 'lease_lost', 'replyId': claimed_id}
            raise
        return {'status': 'failed', 'replyId': claimed_id, 'failureCode': exc.code}
    except WorkerRpcError as exc:
        if exc.code in ('PT404', 'PT409'):
            return {'status': 'lease_lost', 'replyId': claimed_id}
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--once', action='store_true', help='작업을 한 건까지 처리하고 종료 (기본)')
    mode.add_argument('--watch', action='store_true', help='중지할 때까지 대기열을 처리')
    parser.add_argument('--lease-seconds', type=int, default=60, help='DB 임대 유효 시간(1~300초)')
    args = parser.parse_args()
    if not 1 <= args.lease_seconds <= 300:
        parser.error('--lease-seconds는 1~300 범위여야 합니다.')
    try:
        client = WorkerRpc(os.environ)
    except ValueError as exc:
        parser.exit(2, f'{exc}\n')

    def factory(model):
        return OpenAIResponsesProvider(model=model, env=os.environ)

    while True:
        try:
            outcome = process_once(client, factory, lease_seconds=args.lease_seconds)
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
