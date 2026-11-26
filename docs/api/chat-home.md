# 채팅 홈(S-01)과 공고 찾기(S-02) 계약

로그인한 사용자가 여러 채팅을 만들고 이어서 검토하며, 채팅 안에서 공고명이나 공고번호로 같은 이름의 회차를 구분해 고르는 계약이다. 비로그인 상태에서는 탐색과 분석을 실행하지 않고 로그인으로 안내하며, 예시 화면은 합성 자료임을 표시한다. [제품 기준](../prd/01-product-prd.md) · [오늘의 청약 목록](notice-directory.md) · [분석 실행 계약](analysis-runs.md)

## 1. HTTP 경로와 권한을 확인한다

모든 경로는 사용자 세션의 `Authorization: Bearer <access_token>`과 publishable key를 사용해 행 수준 보안(RLS)을 유지한다. 관리 키로 사용자 요청의 권한 검사를 우회하지 않는다. 응답에는 `Cache-Control: private, no-store`와 `Vary: Authorization, Origin`을 적용한다.

| 요청 | 동작 | 응답과 주요 오류 |
| --- | --- | --- |
| `GET /api/v1/chats?before=<UUID>&limit=<1..50>` | 최근 활동 시각 내림차순으로 본인 채팅 목록을 조회 | 200 `chat-home/v1`. 제목, 최근 활동 시각(`lastActivityAt`), 연결된 분석 수(`analysisCount`), 최신 분석·실행 상태(`latestAnalysis`), 다음 커서(`nextCursor`). 잘못된 커서 404 |
| `POST /api/v1/chats` | 멱등 키(`requestId`)와 선택 제목(`title`, 생략 시 `새 채팅`)으로 새 채팅 생성 | 201 `chat-home/v1` + `Location`. 같은 키·같은 제목 재시도는 같은 채팅 반환, 같은 키·다른 제목은 409 `chat_conflict` |
| `GET /api/v1/chats/{chatId}` | 본인 채팅의 메타데이터, 메시지(`messages`), 연결된 분석(`analyses`) 조회 | 200 `chat-detail/v1`. 에이전트 기능이 켜진 메시지는 `agentReply`(`status`, `model`, `intent`, `answer`, `citations`, `searchProposal`, `profileProposal`, `lookupQuery`, `completedAt`)를 함께 반환. 없거나 다른 계정의 채팅은 404 `chat_not_found` |
| `PATCH /api/v1/chats/{chatId}` | 본인 채팅 제목(`title`, 1~200자) 변경 | 200 `chat-home/v1`. 빈 문자열·제어문자는 400 `invalid_chat_input`, 타인·없는 채팅은 404 `chat_not_found` |
| `POST /api/v1/chats/{chatId}/messages` | 규칙 기반 분류로 사용자 메시지(`role: user`)와 정형 응답(`role: assistant`)을 즉시 기록하고, 공고 찾기 의도면 조회 결과를 함께 반환. `private.agent_settings.enabled = true`면 채팅 에이전트 대기열(`queued`)을 함께 적재 | 200 `chat-message/v1`. `{ userMessage, assistantMessage, agentReply, action, lookup, lookupError }`. 기능이 꺼져 있으면 `agentReply: null`. 같은 `requestId` 재전송은 멱등 복원, 본문 불일치는 409 `chat_conflict` |
| `POST /api/v1/chats/{chatId}/replies/{replyId}/decision` | 채팅 에이전트가 제안한 탐색 조건 확인 카드를 `confirm`·`reject`·`cancel`로 결정. `confirm`일 때만 선택 수정 조건(`conditions`)을 포함해 기존 맞춤 검색 경로(`read_notice_search_index` + `evaluateNoticeSearch`)를 실행하고 결과 요약을 채팅에 기록 | 200 `chat-search-decision/v1` + `searchResult`. `reject`·`cancel`은 검색 색인을 조회하지 않고 미실행으로 기록. 잘못된 수정 조건 400 `invalid_search_input`, 타인·없는 채팅/응답 404 `chat_not_found`, 이미 다른 상태로 결정·조건 충돌 409 `chat_conflict`, 출처 제한 403 `search_source_restricted`, 색인 미준비 503 `search_index_not_ready` |
| `POST /api/v1/chats/{chatId}/analyses` | 선택한 공고·회차·주택형(`input`)의 분석을 현재 채팅에 연결해 실행 접수 | 202 + `Location: /api/v1/analyses/{analysisId}/runs/{runId}`. 타인 채팅 404, 다른 채팅으로 같은 키 재사용 409 `chat_conflict`, 공고·주택형 검증 실패 409, 속도 제한 429 `Retry-After: 60` |
| `GET /api/v1/notices/lookup?q=<질의>&mode=<auto\|name\|number>` | 공유 공고 색인에서 공고명·공고번호로 회차를 구분해 검색 | 200 `notice-lookup/v1`. 잘못된 질의 400 `invalid_lookup_input`, 출처 제한 403 `search_source_restricted`, 색인 미준비·만료 503 `search_index_not_ready` |

미로그인·만료·익명 세션은 모든 경로에서 401 `authentication_required`를 반환한다. 허용 목록에 없는 `Origin`은 403 `origin_not_allowed`, 허용하지 않는 메서드는 405 `method_not_allowed`와 `Allow` 헤더를 반환한다.

## 2. 규칙 기반 즉시 응답과 LLM 총괄 에이전트를 구분한다

채팅 입력창(`POST /api/v1/chats/{chatId}/messages`)은 먼저 결정적 규칙으로 동작을 분류해 정형 응답을 즉시 기록한다.

- **공고번호 찾기(`lookup` / `number`)**: 10자리 숫자 또는 `공고번호 9900000040 찾아줘` 같은 숫자 질의. `noticeNo`와 `houseManageNo`를 대조한다.
- **공고명 찾기(`lookup` / `name`)**: 공백·NFC 정규화 기준으로 게시된 공고명을 부분 일치 검색한다.
- **PDF 보완 안내(`pdf_guide`)**: `PDF 올리기`·`공고문 업로드` 등 PDF 보완 질문에는 공고를 먼저 고른 뒤 분석 화면에서 PDF로 보완할 수 있다는 정형 안내를 반환한다.
- **자유 대화·탐색 조건·안내(`help`)**: 자연어 탐색 조건("광진구랑 성동구에서 7억 이하, 84㎡ 정도로 찾아줘"), 공유 프로필 반영 요청("다음에도 이 조건으로 써줘"), `?`로 끝나는 질문, 청약 자격·가점·대출·시세 전망·매수 여부 등 지원 범위 밖 질문에는 규칙 기반 안내를 즉시 반환한다.

`private.agent_settings.enabled = true`이면 같은 메시지에 대해 비동기 에이전트 응답 작업(`private.chat_agent_replies`, 기준 모델 `gpt-6.2-sol`)을 대기열에 적재한다. [에이전트 코어](agent-core.md) · [맞춤 검색 계약](notice-search.md)

- **확인 전 미실행(R-12·A-15·A-16)**: 에이전트는 맞춤 검색을 직접 실행하지 않는다. 공식 5자리 지역 코드·원 단위 예산(필수, A-19)과 공급면적·입주 시기(선택, A-18)를 추출해 확인 대기(`searchProposal.status = 'pending'`) 카드만 만든다. 동명 지역(예: 중구)이나 목록에 없는 지역은 코드를 지어내지 않고 확인 질문을 만든다. 공급면적과 전용면적을 섞지 않는다.
- **확인 시 기존 맞춤 검색 실행**: 사용자가 확인 카드에서 확인(또는 인라인 수정 후 확인)을 누르면 `POST /api/v1/chats/{chatId}/replies/{replyId}/decision`이 기존 `read_notice_search_index` + `evaluateNoticeSearch`를 실행해 결과 요약(`chat-search-summary/v1`, 조건 충족·확인 필요 건수 및 공고 카드 최대 10건씩)을 저장하고 채팅에 요약 메시지를 기록한다. 거절·취소·미응답은 아무것도 실행하지 않는다.
- **공유 프로필 변경안(R-13·A-28)**: "다음에도 이 조건으로" 같은 요청은 `private.create_chat_profile_proposal`로 기존 `public.profile_change_requests`·`private.search_profile_proposals`에 `status = 'pending'`(`analysis_id = null`, `run_id = null`) 행만 생성한다. 승인은 기존 O-3(`decide_search_profile_change`)에서만 하며 에이전트는 승인하지 않는다.
- **화면 표시와 폴백(A-58)**: 대기열 작업이 `queued`·`leased`일 때만 `AI 응답 작성 중`을 표시하고 폴링한다. `answered`가 도착하면 `AI 응답` 배지와 모델 이름을 표시하고, `null`·`rejected`·`failed`·`expired`에서는 `작성 중`을 표시하지 않고 규칙 기반 응답만 유지한다.

클라이언트는 `public.chat_messages`에 `role: 'user'`만 직접 삽입할 수 있도록 기존 RLS 정책(`user_message_only`)을 유지한다. `role: 'assistant'` 응답은 `security definer` 서버 함수(`private.post_chat_message`, `private.decide_chat_search_proposal`)가 정형 문구와 검증된 조회·검색 결과로만 생성·기록한다.

## 3. 같은 이름 회차 구분과 조회 범위 밖을 표시한다

`GET /api/v1/notices/lookup`과 채팅 안의 공고 찾기는 게시된 공유 색인의 **접수 중·접수 예정·접수 종료·일정 확인 필요** 공고를 모두 조회한다(지원 대상 외 `unsupported` 유형은 제외하고 건수를 `counts.excludedUnsupported`에 남긴다).

- **미병합 원칙**: 공고명이 같은 여러 회차를 하나로 합치지 않는다. 각 항목마다 `edition`(모집공고일), `noticeNo`(공고번호), `houseManageNo`(주택관리번호), `kind`(`new_sale` 신규분양·`unranked` 무순위·`remaining` 잔여세대·`resupply` 재공급·`unknown` 유형 확인 필요), `applicationStatus`(접수 상태), `regionName`, `models`와 `sameTitleCount`를 함께 반환한다.
- **조회 범위·관측 시각**: 응답의 `publicationWindow`, `observedAt`, `coverage`, `scopeIssues`, `outOfScopeNotice`를 화면에 표시한다. 일치하는 항목이 없으면 해당 모집공고일 구간과 관측 시각 안에서 찾지 못했으며 그 밖의 회차는 **조회 범위 밖**임을 안내한다.
- **부분 수집 보류**: 색인의 `coverage.status`가 `complete`가 아니면 0건을 정상 0건으로 확정하지 않는다. 화면은 "수집이 완전하지 않아 0건으로 확정하지 않습니다"로 보류하고, 서버 함수가 기록하는 assistant 응답도 0건 확정 문구 대신 누락 가능성을 안내하며 찾은 건수에도 같은 단서를 붙인다.
- **S-03 및 채팅 연결**: 사용자가 회차를 고르면 기존 주택형 선택 다이얼로그(`models[].analysisInput`·`selectionBlockers`)로 이어진다. 채팅 화면에서 분석을 시작하면 `start_chat_notice_workspace(p_chat_id, p_request_key, p_input)`가 새 분석을 해당 채팅에 연결하고 `enqueue_analysis_run`을 같은 트랜잭션에서 실행한다.

## 4. DB 영속 구조와 삭제 범위 연동을 확인한다

[채팅 홈·공고 찾기 마이그레이션](../../supabase/migrations/20261126080318_chat_home_and_lookup.sql)은 기존 `public.chats`, `public.chat_messages`, `public.analyses`를 사용하고, [채팅 에이전트 마이그레이션](../../supabase/migrations/20261126160000_chat_agent_replies.sql)은 비공개 대기열 테이블 `private.chat_agent_replies`(RLS 활성, 직접 권한 0건, 프롬프트 원문·색인 원문 비저장)와 작업자·확인 RPC를 추가한다.

- `public.chats.request_key`, `public.chat_messages.request_key`, `public.chat_messages.message_order`를 추가해 중복 요청 멱등성과 동일 시각 메시지의 시간순 정렬을 보장한다.
- `private.chat_agent_replies`는 `user_message_id -> public.chat_messages(id)`와 `(chat_id, user_id) -> public.chats(id, user_id)`에 `on delete cascade`로 연결돼 있어, 기존 개인 자료 삭제 범위(`chat`, `analysis`, `message`, `account`)와 계정 삭제 시 함께 삭제되며 진행 중 작업자의 쓰기는 `PT404`로 차단된다.
- 로컬 검사는 합성 자료와 `StubProvider`·PGlite·로컬 HTTP 서버·Playwright 브라우저에서 수행한다. 실제 OpenAI 실호출, 원격 Supabase 적용, 실제 Auth 기기 전환 통합 검수, PRD 수락 기준 최종 검수는 별도 절차다. [DB 검사](../../tests/database/chat-home.test.mjs) · [채팅 에이전트 DB 검사](../../tests/database/chat-agent.test.mjs) · [채팅 에이전트 Python 검사](../../scripts/test_chat_agent.py) · [API 검사](../../tests/backend/notice-lookup.test.ts) · [브라우저 검사](../../tests/browser/chat-home.test.mjs) · [채팅 에이전트 브라우저 검사](../../tests/browser/chat-agent.test.mjs)
