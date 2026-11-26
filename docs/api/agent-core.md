# LLM 총괄 에이전트 코어와 비교 대화 연결

2026-11-26 작성. 사용자 결정(Q-40, [결정 기록](../prd/02-decision-log.md))에 따라 비교 대화에 연결하는 Python 기반 LLM 총괄 에이전트 코어, 검증기, 비동기 작업자 대기열, 비용 기록 및 운영 키 관리 계약을 기록한다. 이 문서는 구현 구조와 오프라인 합성 검수 범위를 설명하며, 실제 OpenAI 호출 품질 평가와 운영 모델 채택·제품 수락 기준(A-01~A-59) 통과를 뜻하지 않는다.

## 1. 구조와 모듈 구성

서비스 작업자(`manage_notice_services.py`의 `release()`)와 Colab 재현 제출본([Colab 재현 계획](../colab-reproducibility.md))이 같은 코어를 실행할 수 있도록 Python 3.9 표준 라이브러리만 사용하는 평면 모듈을 `scripts/` 바로 아래에 둔다.

| 모듈 | 역할 |
| --- | --- |
| [`scripts/agent_llm.py`](../../scripts/agent_llm.py) | 공급자 인터페이스(`LLMProvider`), OpenAI Responses API(`POST https://api.openai.com/v1/responses`) 어댑터(`OpenAIResponsesProvider`), PRD §7.6.1 단가표 기반 비용 추정, 테스트·오프라인 회귀용 합성 대역(`StubProvider`) |
| [`scripts/agent_prompts.py`](../../scripts/agent_prompts.py) | 한국어 시스템 프롬프트(`PROMPT_VERSION = "agent-core-v1"`), 외부 자료·질문 구분 태그(`<DATA_JSON>`, `<USER_QUESTION>`), OpenAI Structured Outputs용 엄격 JSON 스키마(`AGENT_TURN_OUTPUT_SCHEMA`) |
| [`scripts/agent_tools.py`](../../scripts/agent_tools.py) | 도구 계약 4종(`read_comparison_summary`, `explain_holds`, `propose_period_change`, `propose_condition_change`)과 출처별 `llm_permission` 필터(`filter_comparison_for_llm`). 제안 도구는 초안만 만들며 검증·저장은 DB가 수행 |
| [`scripts/agent_orchestrator.py`](../../scripts/agent_orchestrator.py) | 한 턴 실행(`run_turn(message, context, provider)`)과 출력 검증기(`validate_turn_output`). 도구 호출 루프, A-58 근거 일치·금지 표현·제안 형식 검증 |
| [`scripts/agent_cli.py`](../../scripts/agent_cli.py) | 합성 또는 고정 `comparison/v1` 파일로 한 턴을 실행해 JSON을 출력하는 CLI(`--provider stub|openai`, `--model`). Colab과 평가셋 비교에서 직접 재사용 |
| [`scripts/agent_worker.py`](../../scripts/agent_worker.py) | DB 대기열에서 에이전트 응답을 임대·실행·검증·저장하는 작업자 모듈(`manage_notice_services.py`의 `agent` 역할이 호출) |

금액·면적·지역·통계·권한·승인 여부는 기존과 동일하게 서버 코드가 판정한다. LLM은 의도 해석, 조건 변경 제안 초안, 구조화 근거를 연결한 한국어 설명만 맡는다.

## 2. 검증 규칙과 거절 처리 (A-58)

`agent_orchestrator.validate_turn_output`는 다음 조건 중 하나라도 실패하면 LLM 답변과 제안 초안을 모두 버리고 `status = "rejected"`와 사유 코드만 기록한다.

1. **의도 허용 목록**: `inclusion`, `holds`, `scope`, `price`, `period`, `change_period`, `change_conditions`, `help` 외의 의도를 거부한다.
2. **제안 형식·경계**: `change_period`·`change_conditions` 외 의도에 제안이 붙으면 거부한다. 기간·공급면적 허용 범위(`0 < x <= 5`, 소수 4자리 이하, Q-41)·거래 종류 부분집합·단지 교체(적격 후보·5쌍 이하·충돌 없음)를 검사한다.
3. **숫자·날짜·건수·금액·면적 일치(A-58)**: 답변 문장의 모든 날짜, 원/만 원/억 원 금액, 공급·전용면적(`㎡`), 퍼센트(`%`), 거리(`m`/`km`), 쪽수(`p.N`/`쪽`), 층·순위, 구분된 건수(단지 수·호실 수·거래 건수)와 단독 숫자가 구조화 결과나 검증된 제안 값에 존재하는지 대조한다. 근거에 없는 값이 하나라도 있으면 거절한다.
4. **금지 표현 차단**: 구매 권유(추천·사세요·싸다·저렴하다), 수익·시세 차익 예측, 개인 청약 자격·대출 승인 판정, 공유 프로필·조건 자동 승인 사칭, 분양가+필수 옵션 소계의 총취득비용 오표기, 작업이 없는데 조회·분석 중이라고 쓰는 표현을 차단한다.
5. **보류·순위 정합성**: 보류·일부 수집·미확인 행이 남아 있는데 `정상 0건`으로 단정하거나 `rankingComplete = false`인데 `완전한 순위`라고 쓰면 거절한다.
6. **프롬프트 주입 방어**: 시스템 프롬프트에 결과·문서·사용자 질문 안의 문장이 지시가 아닌 자료임을 명시하고 `<DATA_JSON>`·`<USER_QUESTION>`으로 분리한다. 모델이 주입된 지시에 따르더라도 검증기가 근거 없는 금액·금지 표현·허용 밖 의도를 차단한다.
7. **서버 조건 변경 재검증**: LLM이 만든 조건·기간 제안은 DB `complete_agent_reply` 안에서 기존 사용자·O-1 제출과 같은 서버 검증 함수(`private.prepare_validated_condition_proposal`)를 거친다. 통과한 제안만 사용자의 승인 대기(`proposal_status = 'pending'`)로 첨부되며, LLM은 승인할 수 없다. 서버 검증에 실패하면 답변을 버리고 `rejected`로 기록한다.

## 3. DB 대기열, 출처 권한 및 삭제 연계

[에이전트 응답 마이그레이션](../../supabase/migrations/20261126140000_analysis_agent_replies.sql)은 두 개의 비공개 테이블을 추가한다(RLS 활성, 직접 테이블 권한 전부 회수).

- `private.agent_settings`: 기능 사용 여부(`enabled`, 기본 `false`)와 모델(`model`, 기본 `gpt-6.1-sol`). 꺼져 있으면 기존 규칙 기반 비교 대화와 완전히 동일하게 동작하며 대기열 행을 만들지 않는다.
- `private.analysis_agent_replies`: `turn_id`(FK `private.analysis_chat_turns(id) on delete cascade`), 상태(`queued`/`leased`/`answered`/`rejected`/`failed`/`expired`), 임대 정보, 검증된 `answer_text`와 `citations`, 사용량·비용·지연, 검증 결과(`validation_status`, `validation_reasons`)만 저장한다. **프롬프트 원문과 비교 결과 전체는 따로 저장하지 않는다.**
- 작업자 RPC(`configure_agent_settings`, `claim_agent_reply`, `read_agent_reply_context`, `complete_agent_reply`, `fail_agent_reply`, `expire_stale_agent_replies`)는 `service_role` 전용이다.
- `read_agent_reply_context`는 `public.source_registry.llm_permission = 'allowed'`인 출처의 값만 문맥에 포함하고, 허용되지 않은 출처의 값은 제외한 뒤 `llmSourcePolicy.restrictedSources`에 표시한다. `naver_news`와 사용자 업로드(`user_upload`)는 항상 LLM 입력에서 제외한다.
- 임대가 만료된 행은 소유자 조회(`read_analysis_conversation`) 시 즉시 `expired`로 표시하고, 작업자 정리(`expire_stale_agent_replies`·`claim_agent_reply`)로 `expired` 상태로 확정한다.
- `turn_id`가 `on delete cascade`로 연결돼 있어 기존 개별 턴 삭제(`delete_personal_data('turn', ...)`·`resolve_turn_deletion_scope`)와 계정 삭제 시 에이전트 응답 및 파생 턴의 응답도 함께 삭제되며, 삭제된 턴을 임대하던 작업자의 쓰기는 `PT404`로 차단된다.

## 4. 모델·비용 기록과 운영 키 관리

OpenAI Responses API 호출은 `store: false`, HTTPS 고정, 리디렉션 차단, 시간 제한(기본 30초), HTTP `429`·`5xx`에 한정한 재시도(기본 최대 2회)를 적용한다. 호출마다 입력·출력·추론 토큰(`usage.output_tokens_details.reasoning_tokens`), 지연(`latencyMs`), 시도 횟수와 함께 PRD §7.6.1 단가표(기준일 `2026-11-12`, Standard·Short 100만 토큰당 USD)로 추정 비용을 기록한다. OpenAI의 `output_tokens`에는 `reasoning_tokens`가 이미 포함되므로 중복 합산하지 않는다.

| 모델 ID | 입력 단가 (USD / 1M) | 출력 단가 (USD / 1M) | 비고 |
| --- | --- | --- | --- |
| `gpt-6.1-sol` | $2 | $10 | 기본 기준 모델 (Q-40) |
| `gpt-6.1-terra` | $1 | $5 | 비용·속도 비교군 |
| `gpt-6-luna` | $0.10 | $0.50 | 저비용 비교군 |
| `gpt-6-astra` | $10 | $50 | 선택적 품질 비교군 |

- 운영 키는 실행 환경의 `OPENAI_API_KEY` 또는 소유자 전용 권한(`0600`)의 `.secrets/OPENAI_API_KEY.env`에서만 읽는다. `python3 scripts/store_api_key.py OPENAI_API_KEY`로 숨김 입력해 저장할 수 있다.
- 키가 없으면 `llm_unavailable`로 명확하게 실패하며, 대역 응답(`StubProvider`)으로 조용히 바꾸지 않는다. 키와 응답 원문은 로그·예외·상태 파일·DB에 남기지 않는다.
- 개발 Mac에서는 `manage_notice_services.py`의 `agent` 역할(`kr.homecierge.development.agent-worker`)이 대기열을 처리한다. 키가 없으면 원격 호출 없이 `waiting_for_llm_key` 상태로 대기한다. [개발 Mac 작업 운영](notice-operations.md)

## 5. 화면 표시와 CLI 재현

- 비교 대화 화면은 기존처럼 규칙 기반 답변을 즉시 보여준다. `agentReply.status = "answered"`가 도착하면 규칙 기반 답변을 유지한 채 **AI 설명** 배지와 모델 이름을 함께 표시한다.
- `queued`·`leased` 상태일 때만 `AI 설명 작성 중`을 표시하고 폴링하며, 대기열 행이 없거나(`null`) `rejected`·`failed`·`expired`이면 규칙 기반 답변만 보이고 `작성 중`을 표시하지 않는다(A-58).

오프라인 합성 실행 예:

```sh
python3 scripts/agent_cli.py \
  --comparison public/app/assets/comparison-example.json \
  --message "왜 이 거래만 포함됐어?" \
  --provider stub \
  --model gpt-6.1-sol
```

## 6. 현재 검수 범위와 한계

- 이번 작업은 합성 비교 결과, `StubProvider`, 모의 HTTP 응답, PGlite DB, 합성 브라우저 세션으로 검증했다. 실제 OpenAI API 실호출, 모델 4종(`gpt-6.1-sol`/`terra`/`luna`/`astra`) 비교 평가, 원격 Supabase 마이그레이션 적용 및 실제 Auth 통합 검수는 별도 단계다.
- 2026-11-26 총괄이 개발 Mac에서 합성 `comparison-example.json`과 질문 "왜 이 거래만 포함됐어?"로 `--provider openai --model gpt-6.1-sol`을 한 번 실행했다. 상태 `answered`, 의도 `inclusion`, 검증 `passed`(날짜·면적·비율·건수 7개 대조), 입력 3,496·출력 460(추론 74) 토큰, 지연 11.3초, 추정 비용 US$0.0116이었다. 한 번의 합성 실행이며 모델 품질·지연·비용의 평가 결과가 아니다.
- 같은 날 사용자 결정(Q-42)으로 서울 개발 DB에서 `naver_news`를 뺀 11개 출처의 `llm_permission`을 `allowed`로 바꾸고 `configure_agent_settings(true, 'gpt-6.1-sol')`로 기능을 켰다. 아래 문장은 작업 당시 상태다.
- 기존 `public.source_registry.llm_permission` 값은 이번 작업에서 바꾸지 않았다(기본 `unknown`, `naver_news`는 `denied`). 실제 수집 공고·실거래 결과에 LLM 설명을 켜려면 운영 전 출처별 약관 근거를 확인하고 허용할 출처 목록을 사용자 결정으로 확정해야 한다.
