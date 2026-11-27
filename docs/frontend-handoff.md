# 화면 팀의 데이터·API 연결 계약

2026-11-22. 화면 프레임워크는 고정하지 않는다. [인프라 준비 상태](infrastructure.md)와 [PRD](prd/01-product-prd.md)를 함께 읽는다. 개발 DB와 보호된 Preview API가 생성됐다. 키·인증값은 실행 환경으로 전달한다.

**첫 연결 범위는 로그인 → 오늘의 청약 목록 → 공고·주택형 선택 → 분석 진행·재조회다.** `today` 예시에는 오늘 마감·접수 예정·분리 접수 사이의 공고가 함께 있다. `confirmedEmpty`는 조사 범위의 정상 빈 목록이고, `delayed`는 이전 관측과 부분 수집이 겹친 사례다. [목록·선택 계약](api/notice-directory.md) · [디자인·개발용 합성 응답](../tests/fixtures/notice-directory-v1.json) · [진행 상태와 결과](api/analysis-runs.md)

## 오늘의 청약을 실행한다

`npm ci`와 `npm run dev`로 [로컬 화면](http://127.0.0.1:3001/)을 엽니다. 처음 방문하면 합성 공고가 표시됩니다. 이메일로 로그인하면 청약홈의 관측 시각과 함께 공식 목록을 읽습니다. 카드와 달력은 같은 공고의 확인된 접수 구간을 사용합니다. 로그인한 상태에서 목록을 불러오지 못하면 다시 조회할 수 있습니다.

주택형을 선택하고 분석 시작을 누르면 `start_notice_workspace(p_request_key, p_input)`가 사용자의 대화·분석·실행을 한 트랜잭션에 저장합니다. 같은 계정에서 재시도하면 처음 실행을 복원하고 선택이 거부되면 새 대화도 저장되지 않습니다. **내 분석**은 현재 계정의 최근 실행 30개를 보여줍니다. 진행·취소와 가격·비교 보류는 기존 실행 API 응답을 따릅니다.

`GET /api/v1/client-config`는 해당 배포의 Supabase 주소와 publishable key를 돌려줍니다. 사용자 인증은 이메일과 비밀번호를 사용하며 이메일 확인이 켜진 프로젝트에서는 인증 메일을 거칩니다. 개발자가 호스팅 설정을 준비할 때는 사용할 개발 화면 주소를 Supabase Auth의 허용 리디렉션 URL에 등록합니다. 발행 전 검수 명령은 `npm run build`와 격리된 Supabase의 `NOTICE_BROWSER_SMOKE=1 BE07_EPHEMERAL_SEARCH_FIXTURE=1 npm run test:auth`입니다.

11월 22일 개발 커밋 `aab6254`의 보호된 미리보기에서 상태 조회는 200, 사용자 세션이 없는 공고 목록 조회는 401 `authentication_required`와 `private, no-store`를 반환했다. 격리된 Supabase에서 두 계정으로 로그인해 목록 선택·분석 실행·소유자의 재로그인 후 결과 조회와 타인 조회 404를 확인했다. 이 인증 검사의 제공기관 응답은 합성이며, 논산 공고의 실제 수집과 저장 검수는 목록 계약에 기록했다. [인증 통합 검사](https://github.com/95sionkim/HomeCierge/actions/runs/44997598855) · [논산 공고 검산](api/notice-directory.md#수집한-범위와-근거를-읽는다)

### 전달받은 화면을 API에 연결한다

2026-11-22 전달본은 원 프로젝트의 `wireframe/homecierge-wireframe-handoff/`와 `HomeCierge-design_system/`에 있다. 와이어프레임 v0.1은 클릭 화면 14개와 상태를 포함한 캡처 18장을 제공한다. 디자인 시스템에는 컴포넌트 18개가 있다. 두 묶음의 `tokens.json`과 컴포넌트 타입 선언은 일치한다. 화면 팀은 독립 디자인 시스템의 토큰과 컴포넌트 문서를 기준으로 삼고, 클릭 동선은 와이어프레임의 `prototype/index.html`에서 확인한다.

| 화면에서 할 일 | 지금 연결할 데이터와 남은 화면 작업 |
| --- | --- |
| S-01 채팅 홈에서 시작하거나 돌아온다 | `#home`에서 `GET /api/v1/chats`로 최근 채팅(제목·최근 활동 시각·연결된 분석 수·최신 실행 상태)을 복원하고 `POST /api/v1/chats`로 새 채팅을 만든다. 시작 카드 세 가지(공고명으로 찾기·공고번호로 찾기·PDF로 보완)와 **오늘의 청약** 진입점을 제공하며, PDF 카드는 공고를 먼저 고른 뒤 분석 화면에서 보완할 수 있다는 안내를 표시한다. `#chat/{chatId}`에서는 규칙 기반 응답을 즉시 표시하고, `private.agent_settings.enabled = true`일 때 비동기 에이전트(`gpt-6.2-sol`)가 자유 대화에서 추출한 탐색 조건을 **AI 응답** 배지·모델 이름·확인 카드("이 조건으로 공고를 찾을까요?")로 보여준다. 사용자가 확인(또는 인라인 수정 후 확인)하면 `POST /api/v1/chats/{chatId}/replies/{replyId}/decision`으로 기존 맞춤 검색 경로를 실행해 결과 요약(조건 충족·확인 필요 건수, 공고 카드 링크)을 기록하고, 거절·취소·미응답은 아무것도 실행하지 않는다. "다음에도 이 조건으로" 요청은 공유 프로필 변경안(`pending`)으로 만들어 기존 O-3 승인 흐름으로 넘긴다. 대기열 작업이 없거나(`null`) `rejected`·`failed`·`expired`이면 `작성 중`을 표시하지 않는다. 비로그인 예시 화면은 합성 자료임을 표시하고 로그인 전 탐색·분석을 실행하지 않는다. [채팅 홈·공고 찾기 계약](api/chat-home.md) · [에이전트 코어](api/agent-core.md) |
| 오늘 접수 중·예정인 공고를 훑는다 | `GET /api/v1/notices`의 접수 구간·한국 기준일·관측 시각을 카드와 달력이 같이 쓴다. 오늘 개발 화면은 이 공고 목록을 카드·달력으로 제공하고 로그인·작은 화면 배치까지 연결했다. |
| S-02에서 회차를 구분하고 S-03에서 주택형을 고른다 | `#chat/{chatId}`와 `#lookup`에서 `GET /api/v1/notices/lookup` 및 `POST /api/v1/chats/{chatId}/messages`로 공유 색인을 검색해 같은 이름의 회차를 공고일·공고번호·주택관리번호·유형(신규분양·무순위·잔여세대·재공급)·접수 상태로 구분한다. 색인의 모집공고일 범위와 관측 시각을 표시하고 그 밖의 회차는 조회 범위 밖으로 안내하며, 이름만 같은 다른 회차를 합치지 않는다. 회차를 고르면 기존 S-03 주택형 선택(`models[].analysisInput`·`selectionBlockers`)으로 이어지고, 채팅 안에서는 `POST /api/v1/chats/{chatId}/analyses`(`start_chat_notice_workspace`)로 현재 채팅에 분석을 연결한다. 색인 구간 밖의 과거 전체 회차 검색과 PDF 업로드·호실 가격 대조는 별도 작업이다. |
| 맞춤 공고를 찾는다 | 메뉴의 **맞춤 검색**에서 공식 시·군·구와 원 단위 예산을 입력한다. 공급면적(㎡·평), 입주 예정월, 접수 종료 포함은 선택 조건이다. 확인 필요 호실에는 보류 사유를, 금액과 면적에는 공식 문서의 판본과 쪽을 표시한다. 분석을 시작할 때는 최신 공고 목록에서 회차와 주택형을 다시 대조한다. [검색 계약](api/notice-search.md) |
| 자금과 납부 근거를 확인한다 | **내 분석 → 완료된 분석 → 호실 자금표**에서 호실을 바꾸고, 보유 잔액과 추가 입금의 날짜·확정 여부를 저장한다. 날짜별 입금 전·후 부족액을 나란히 보며, 날짜 미확정 납부는 따로 확인한다. 호실·일정 자료가 부족해도 자기 분석의 자금 입력은 열려 있다. [자금표 계약](api/funding-plan.md) |
| S-04·S-05에서 비교 범위·가격·보류를 표시한다 | `comparison/v1`의 `regionDecision`, `tradeKinds`, `noticePrice`, `comparables`, `targetReferences`, `candidatePool`, `holds`, `exclusions`, `collections`를 읽는다. S-04 패널은 적용 지역(`ScopeBadge`), 확인·보류·제외 건수와 사유별 내역, 우선 지역 전체 정상 0건일 때의 확인 질문 없는 자동 확대 알림, 보류 잔존 시 `'정상 0개 아님 · 확대 보류'`, 거래 종류별 정상 0건·보류·실패를 구분해 표시한다. 비교 보류 화면의 세 칸에 빠진 근거, 다시 비교할 조건, 계속 볼 수 있는 값을 채운다. 비로그인 합성 예시(`#sample/saved`, `#sample/expanded`, `#sample/held`)에서도 같은 동·구 자동 확대·확대 보류 화면을 확인할 수 있다. [비교 응답](api/comparison-v1.md) |
| 공식 PDF 확보 실패 시 업로드로 보완한다 | 완료된 실수집 분석에서 문서 확보 실패·판본 미확인·업로드 보완 필요 사유가 있으면 결과 화면에 **공고 PDF로 보완** 패널을 연다. `GET /api/v1/analyses/{analysisId}/runs/{runId}/upload-supplement`로 사유와 대상 공고·회차를 안내하고, 기존 비공개 버킷 등록·업로드 계약(`register_analysis_upload` → `analysis-uploads`) 후 `POST .../upload-supplement`로 점검 실행을 접수한다. 통과한 값의 근거는 `사용자 업로드 · 파일 ID · 판본 해시 · 쪽`으로 표시하고, 다른 회차·출처 미확인 문서는 보류 사유를 남기며 독립 확인된 기본 정보를 유지한다. 업로드 한 건을 `#privacy`에서 삭제하면 파생 수집본·실행·보고서가 영향 미리보기에 나타나고 함께 정리된다. [업로드 보완 계약](api/notice-documents.md#화면에서-업로드-보완을-접수하고-점검한다) |
| O-1 비교 조건 편집과 S-05 비교 대화에서 조건을 바꾼다 | S-05 분석 조건 바의 **조건 변경** 버튼(또는 비교 보류 패널의 **비교 조건 변경**)에서 O-1 편집 시트를 연다. 거래 종류·계약 기간·공급면적 허용 범위(기본 ±5%, Q-41에 따라 0 초과 5 이하 양수 십진수로 좁히는 변경만 허용, 반올림 없는 양 끝 경계 미리보기)·단지 직접 교체(`candidatePool`의 적격 후보만 선택, 범위 밖·미충족·미확인 사유 별도 표시)를 편집하면 이전 값→새 값과 영향을 보여주고 바뀐 조건이 없으면 확인 버튼을 끈다. 확인 시 `POST /api/v1/analyses/{analysisId}/runs/{runId}/conversation`에 `{requestId, message, conditions}`를 보내 대화 패널에 승인 카드를 생성하고, 대화 입력(“공급면적 범위를 ±3%로 좁혀줘”, “매매만 비교해줘”, “A단지를 B단지로 바꿔줘”)도 규칙 기반으로 같은 승인 카드를 만든다. 5%를 넘는 면적 확대 요청에는 상한과 이유를 안내하고 제안을 만들지 않는다. 승인 시에만 같은 수집본으로 새 실행을 접수해 이동하며, 거절·취소·미응답은 기존 조건을 유지하고 공유 프로필은 바꾸지 않는다. 데스크톱 560px 시트와 모바일 전체 시트를 모두 지원한다. [조건 변경 계약](api/comparison-v1.md#공급면적-허용-범위거래-종류단지-교체를-변경한다) |
| O-4 단지 상세와 O-5 원문 근거 시트를 연다 | 비교 단지 카드·비교표 행·대상 단지 자체 거래(별도 참고)를 누르면 O-4 시트가 열려 식별 근거(실거래 단지 번호·법정동·지번·도로명·K-apt 코드 등), 출처 충돌(양쪽 값 병기), 선정 공급면적과 기준 대비 차이, 포함·제외(기간 밖·해제·다른 면적)·보류 거래 목록을 보여준다. 분양가·필수 옵션·공급면적·호실 자금표 납부 일정 옆의 `SourceChip`을 누르면 O-5 시트가 열려 문서 식별자·판본 해시 앞부분·쪽·점검 상태·공식 출처 링크를 표시한다. 본인 업로드 PDF는 기존 `/content` 경로로 내려받고, 공식 공고 PDF는 재호스팅하지 않고 청약홈 공식 주소로만 연결한다. 상세 메타와 원거래 식별 근거는 `GET /api/v1/analyses/{analysisId}/runs/{runId}/evidence`에서 읽는다. [비교 근거 상세](api/comparison-v1.md#단지-식별-근거와-문서-원문-정보를-읽는다) |
| 공고일에 적용된 법령을 연다 | **내 분석 → 완료된 분석 → 법령 근거**에서 모집공고일과 시행일을 대조하고 법제처의 해당 판본을 연다. 개별 조문은 번호와 제목으로 찾는다. 부칙·경과규정, 개인별 자격과 예외는 추가 확인 대상이다. [법령 계약](api/legal-evidence.md) |
| S-06에서 지역 뉴스를 조회한다 | **지역 뉴스 → 지역 뉴스 보기**를 누르면 해당 공고의 시·군·구로 최신순 1쪽(10건)을 조회한다. 제목·검색 발췌·원문 링크·제공 시각·지역 관련성 미확인 안내와 목록 아래 쪽 이동(이전·다음, `n / 마지막`)을 표시하며, 쪽을 넘길 때마다 해당 쪽을 새로 조회한다. 현재 쪽 기사만 메모리에 두고 브라우저 저장소에 남기지 않으며, 탭을 떠나면 기사 목록을 지운다. 게스트 합성 예시(`#sample/saved/news`)도 10건씩 여러 쪽으로 살펴볼 수 있다. [뉴스](api/regional-news.md) |
| 선택한 공고 단지의 출퇴근 경로를 조회한다 | **출퇴근 경로** 진입 시 `GET /api/v1/analyses/{analysisId}/snapshots/{snapshotId}/commute`로 공고 공급위치(`HSSPLY_ADRES`)에서 추출한 자동 출발지 또는 보류 사유·제안값을 먼저 불러온다(외부 제공자 미호출, 횟수 미증가). 출발지 칸에는 공고 번호를 표시하지 않으며, 자동 출발지면 주소와 **청약홈 공고 공급위치 기준**(원문과 다르면 원문 병기)을, `일원`·`블록`·미보고 등으로 자동 확정이 불가하면 공급위치 원문·사유·`#commute-origin` 입력칸(대표 지번·도로명이 하나 있으면 제안값)을 표시한다. 자동 출발지가 있어도 **출발지 직접 입력**으로 전환할 수 있다. `POST .../commute`는 `{destination}` 또는 `{destination, origin}`을 받아 서버에서 좌표 확인과 자동차 경로 조회를 마치고, 대중교통 권한과 `ODSAY_WEB_API_KEY`가 있으면 `transit.status: "client_query"`와 `transitQuery`를 반환한다(Q-47). 화면은 `transitQuery`의 좌표 범위와 `provider: "odsay_route"`를 검증한 뒤 `GET https://api.odsay.com/v1/api/searchPubTransPathT?SX=…&SY=…&EX=…&EY=…&OPT=0&apiKey=<encodeURIComponent>`를 `credentials: 'omit'`, `cache: 'no-store'`, `redirect: 'error'`, `referrerPolicy: 'strict-origin-when-cross-origin'`, 5초 제한·응답 크기 상한으로 직접 호출한다. 조회 중 대중교통 카드에 진행 상태를 보이고 `powered by www.ODsay.com` 표기를 유지한다. 좌표·ODsay 결과·사용자 입력 출발지는 DB나 `localStorage` 등에 저장하지 않고, 공유 목적지 저장·해제는 기존 확인 흐름을 유지한다. [출퇴근 계약](api/commute.md) |
| S-07 보고서를 보관한다 | 완료된 분석의 보고서 탭에서 호실과 결과를 저장한다. 내 분석의 저장 보고서에서 다시 열고, PDF로 받거나 한 건을 삭제한다. [저장 보고서](api/saved-reports.md) |
| S-08과 확인·근거 패널을 연다 | O-3에서 공유 프로필의 변경 값을 승인하고 S-08에서 검색 조건과 이력을 확인한다. O-4 단지 상세와 O-5 원문 근거는 위 `/evidence`와 `/content` 계약으로 접근 허용된 파일·판본·쪽과 공식 출처에 연결한다. [공유 프로필](#3-공유-프로필-변경을-승인한다) · [비공개 파일](api/ingestion-storage.md) |

전달본은 1440px 데스크톱 예시이며 최소 너비는 1280px다. 본문은 Pretendard, 식별자는 Roboto Mono를 사용한다. `StatusBadge`는 확인됨·정상 0건·일부 수집·미확인·조회 실패·연결 보류를 아이콘과 낱말로 함께 구분한다. 값이 없으면 `—`를 표시하고, 확인한 수치에는 `SourceChip`으로 출처와 시각 또는 쪽을 연결한다. 예를 들어 접수 중으로 확인한 공고가 0개여도 `zeroStatus.open = indeterminate`이면 ‘일정 확인 필요’를 표시한다.

공고 카드에는 공고일·공고번호와 접수 기간을 구분해 표시한다. 분석 조건 바를 펼치면 저장된 공고·주택형·지역·계약 기간·거래 종류·공급면적 기준을 확인할 수 있다. 비교표는 거래 유형별로 공고의 확인된 호실 소계와 주변 단지의 최저·중위·최고가를 같은 축에 놓는다. 한 호실을 지정하지 않았을 때 공고 표식은 확인된 호실들의 범위다. 화면의 만 원 표기는 중위값의 0.5원까지 보존한다. 작은 화면은 단지별로 표를 재배치한다. 금액·공급면적의 문서 근거를 펼치면 해당 판본과 쪽수가 나오며, 거래의 수집 기록에서는 계약월과 수집 상태를 확인한다. [비교 계약](api/comparison-v1.md) · [합성 브라우저 검사](../tests/browser/workspace.test.mjs)

법령·뉴스 탭은 완료된 실행에 고정된 수집본을 사용한다. 가격 비교의 근거가 부족하거나 비교 출처가 제한되어도 두 탭은 독립적으로 열린다. 로그인 없이 확인할 수 있는 합성 화면은 로컬 또는 개발 미리보기의 `/#sample/saved/law`와 `/#sample/saved/news`다. [브라우저 회귀 검사](../tests/browser/workspace.test.mjs)

시안의 12개 완료월과 예시 단지의 금액은 고정 화면 값이다. 서비스에서는 실행 기준일과 실제 조사 기간을 표시한다. 공급면적 기본 허용 범위는 ±5%이고, 같은 법정동·읍·면이 정상 0건일 때만 같은 구 또는 구 없는 시·군으로 확대한다. 호실 자금표에서 입금 시각을 모르면 같은 날 입금 전·후 부족액을 함께 보여준다. [제품 기준](prd/01-product-prd.md) · [자금표 계약](api/funding-plan.md)

| 연결 대상을 정한다 | 주소·계약을 확인한다 |
| --- | --- |
| Supabase 개발 DB·Auth | `https://jcaelooqogosbzrfyrhe.supabase.co` |
| Vercel Preview API · 개발 브랜치 최신 배포 | `https://homecierge-api-git-codex-backend-b54136-sions-projects-d18fe574.vercel.app` |
| 로컬 API | `npm run dev` → `http://127.0.0.1:3001` |
| 타입 | [원격 DB에서 생성한 Database 타입](../src/db/database.types.ts) |

로컬 API는 `.secrets/backend.env`의 `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `APP_ENV=development`, `ALLOWED_ORIGINS`를 읽는다. 현재 Vercel 허용 origin은 `http://localhost:3000`, `http://127.0.0.1:3000`, `http://localhost:5173`, `http://127.0.0.1:5173`이다. 같은 배포에서 제공하는 화면은 그 배포의 API를 호출한다. 별도 화면을 연결할 때는 정확한 origin을 추가한다. 원격 키는 접근 권한이 있는 프로젝트 설정에서 전달받으며 채팅·Git에 붙여 넣지 않는다.

Preview에는 Vercel 배포 보호가 켜져 있다. Vercel 로그인과 Supabase의 서비스 사용자 로그인은 별개이며, 별도 화면의 자동 API 호출에 배포 보호가 추가로 적용될 수 있다. 로컬 API로 먼저 연동하고 화면 배포 때 접근 방식을 함께 검수한다. 보호 우회 값을 화면 코드에 넣지 않는다.

지역 뉴스 API는 개발 브랜치 `8f0f012`의 Preview에 배포했고, `f62dbeb`에서 요청 버튼과 검색결과 화면을 연결했다. 사용자가 애플리케이션 등록을 확인한 개발 브랜치의 Preview에는 뉴스 검색 키를 설정했다. 격리된 Supabase에서는 두 계정으로 소유자의 검색결과 표시, 타인 조회 404, 출처 권한 회수 직후 같은 공고의 기사 제거를 합성 자료로 검사했다. [개발 미리보기 실조회](api/regional-news.md#검수-결과) · [인증과 브라우저 통합 검사](https://github.com/95sionkim/HomeCierge/actions/runs/45005003148)

11월 22일 개발 브랜치의 `c325134`에서 공고일 기준 법령 조회를 추가했다. 응답이 `available`이면 모집공고일과 법령 시행일을 따로 표시하고 해당 판본의 원문을 연결한다. 격리된 Supabase에서 두 계정으로 로그인해 본인 분석은 200, 다른 계정의 분석은 404임을 확인했다. 법령 출처의 표시 권한을 회수한 뒤에는 같은 본인 분석에서 `source_restricted`와 빈 참조를 받았다. [법령 조회 계약과 실공고 예시](api/legal-evidence.md) · [인증 통합 검사](https://github.com/95sionkim/HomeCierge/actions/runs/44991331159)

11월 22일 개발 브랜치의 `e2c916a`를 보호된 Preview에 배포했다. 공고 검색, 비공개 PDF, 분석 실행·비교와 함께 선택한 호실의 자금표를 조회할 수 있다. 팀 접근으로 `/api/health`는 200, 자금표 경로의 GET은 405와 `Allow: POST, OPTIONS`를 반환했다. 자금표 응답에는 `private, no-store`가 적용된다. [호실별 자금표와 계산 예](api/funding-plan.md) · [공고 검색 계약](api/notice-search.md)

격리 Supabase에 두 계정으로 로그인해 자금표 POST를 검수했다. 계약금 7,100만 원, 보유 잔액 5천만 원, 당일 예상 입금 400만 원에서 예상 자금 포함 시 부족액은 입금 전 2,100만 원과 입금 후 1,700만 원이었다. 예상액을 500만 원으로 수정하면 입금 후 부족액은 1,600만 원이 됐다. 다른 계정의 같은 조회는 404였다. [인증 통합 검사](https://github.com/95sionkim/HomeCierge/actions/runs/44989806440)

## 1. 인증과 API를 연결한다

사용자는 Supabase Auth로 로그인하고 사용자 access token을 `Authorization: Bearer <access_token>` 헤더로 전달한다. API는 쿠키 기반 인증을 가정하지 않는다. 개발 화면은 공식 브라우저 SDK로 이메일 로그인과 세션 갱신을 처리한다. 출시 환경의 인증 수단과 메일 설정은 운영 검수에서 확정한다. 토큰·비밀번호는 채팅 내용이나 로그에 기록하지 않는다.

| 요청을 보낸다 | 의미를 구분한다 | 응답과 실패를 처리한다 |
| --- | --- | --- |
| `GET /api/health` | API 프로세스의 생존 확인 | 200. DB·로그인·분석 기능 완료를 보장하지 않음 |
| `GET /api/ready` | 인증 후 사용자 권한으로 프로필 테이블 조회 | 200은 해당 DB 조회 성공. 미로그인 401, 설정·백엔드 실패 503 |
| `GET /api/v1/me` | 인증한 사용자의 ID·프로필 조회 | `{ user: { id }, profile }`. 최초에는 `profile: null` 가능 |
| `GET /api/v1/notices` | 지역·예산 입력 전 접수 중·예정 공고와 확인된 주택형을 조회 | 카드와 달력은 같은 접수 구간을 사용한다. 마지막 관측 시각, 일정 확인 필요, 다음 페이지를 표시한다. [목록 응답과 선택](api/notice-directory.md) |
| `GET /api/v1/notices/lookup` | 공고명 또는 공고번호로 공유 색인의 회차를 구분해 조회 | 같은 이름의 회차를 합치지 않고 공고일·공고번호·주택관리번호·유형·접수 상태와 조회 범위·관측 시각을 표시한다. [채팅 홈·공고 찾기](api/chat-home.md) |
| `GET/POST /api/v1/chats`, `GET/PATCH /api/v1/chats/{chatId}`, `POST /api/v1/chats/{chatId}/messages`, `POST /api/v1/chats/{chatId}/replies/{replyId}/decision`, `POST /api/v1/chats/{chatId}/analyses` | 본인 계정의 다중 채팅 목록·생성·복원·제목 변경·메시지 기록·탐색 조건 확인 카드 결정(확인 시 기존 맞춤 검색 실행)·채팅 연결 분석 접수 | 다른 계정의 채팅은 404. 비로그인 401. assistant 응답은 서버 함수로만 기록하며, `agentReply`는 `answered`일 때만 ‘AI 응답’과 모델 이름·확인 카드·O-3 변경안을 표시하고 `rejected`/`failed`/`expired`/`null`에서는 `작성 중` 없이 규칙 기반 응답만 유지(A-58). [채팅 홈·공고 찾기](api/chat-home.md) · [에이전트 코어](api/agent-core.md) |
| `POST /api/v1/notices/search` | 희망 지역·예산과 선택 면적·입주월로 공고를 탐색 | 200이면 조건 충족·확인 필요 목록과 수집 범위를 표시. 최신 색인 준비 중은 503. [요청 및 응답](api/notice-search.md) |
| `POST /api/v1/analyses/{analysisId}/funding-plan` | 해당 분석의 수집본·주택형·호실을 선택해 납부일별 자금과 부족액을 조회 | 확정 자금과 예상 포함 금액, 날짜를 알 수 없는 납부와 근거를 표시. [요청과 계산 예](api/funding-plan.md) |
| `GET /api/v1/analyses/{analysisId}/snapshots/{snapshotId}/legal-evidence` | 본인 공고의 모집공고일에 시행된 「주택공급에 관한 규칙」을 조회 | 공고일·시행일·법제처 원문을 표시한다. 법령 판본과 개인 자격의 확인 상태를 구분한다. [상태별 표시와 예시](api/legal-evidence.md) |
| `POST /api/v1/analyses/{analysisId}/snapshots/{snapshotId}/regional-news` | 사용자가 지역 뉴스 보기 또는 쪽 이동을 선택하면 공고 소재지로 최신순 10건 단위 검색 | 본문 없이 호출하거나 JSON 본문 `{"page": n}`(정수 1~100, `{}`는 1쪽)을 보낸다. `search.conditions`(`display: 10`, `start`)와 `search.page`(`number`, `size`, `total`, `lastPage`, `hasPrevious`, `hasNext`)를 반환하며 서버에 저장·캐시하지 않는다. 분당 12회 초과 시 429 `news_rate_limited`(`Retry-After: 60`), 범위 밖·잘못된 본문은 400 `invalid_news_input`. 네이버 검색결과를 독립된 영역에서 원래 순서로 표시하고 기사별 원 출처·원문 링크, 검색 발췌, API 제공 시각, 지역 관련성 미확인을 안내한다. [상태와 표시 계약](api/regional-news.md) |
| `GET/POST /api/v1/analyses/{analysisId}/snapshots/{snapshotId}/commute` | 공고 공급위치 출발지 미리보기(GET)와 출발지·목적지 좌표 확인·자동차 조회·대중교통 위임(POST) | GET은 외부 API를 호출하거나 분당 한도를 쓰지 않고 `commute/v1`의 `origin`(`noticeAddress`, `address`, `basis`, `reason`, `suggestion`)을 반환한다. POST는 `{destination}` 또는 선택 `origin`을 포함한 `{destination, origin}`을 받아 구조 비교로 지점을 확인하고 `origin`·`originAddress`·`transit`·`transitQuery`·`driving`을 반환한다(`private, no-store`). `transit.status === "client_query"`이면 브라우저가 `transitQuery`로 ODsay를 직접 호출한다(Q-47). 타인 404, 입력 오류 400, 분당 6회 초과 429(`Retry-After: 60`). [출퇴근 계약](api/commute.md) |
| `POST /api/v1/analyses/{analysisId}/runs` | 선택한 공고·주택형의 자료 수집이나 기존 수집본의 분석을 접수 | 목록에서 받은 `analysisInput`을 보내면 202와 조회 주소를 받는다. 같은 키로 다른 입력을 보내면 409 |
| `GET /api/v1/analyses/{analysisId}/runs/{runId}` | 실행 상태를 다시 읽음 | 200. 자료가 준비되면 `snapshotId` 제공 |
| `GET /api/v1/analyses/{analysisId}/runs/{runId}/result` | 선택한 주택형과 주변 실거래의 저장된 비교 결과를 읽음 | 200이면 완전성·가격 상태·보류 사유를 표시. 출처 표시 권한이 철회되면 403, 다른 계정이면 404, 저장된 결과가 없으면 409 |
| `GET /api/v1/analyses/{analysisId}/runs/{runId}/evidence` | 비교 결과에 참조된 문서 판본·출처 링크와 거래 식별 근거를 읽음 | 200이면 O-4 단지 상세·O-5 원문 근거 시트에 연결. `/result`와 같은 소유권·출처 표시 권한(403/404/409)과 `private, no-store`를 적용 |
| `GET/POST /api/v1/analyses/{analysisId}/runs/{runId}/conversation`, `POST .../conversation/{turnId}/decision` | 완료된 실행의 비교 대화 조회·질문·조건 변경 제안(자연어 또는 `conditions`)과 승인·거절·취소 | `analysis-conversation/v1`과 `conditionBounds`를 반환(`private, no-store`). 규칙 기반 `answer`를 즉시 반환하며, 에이전트 기능이 켜진 턴에는 `agentReply`(`status`, `model`, `answer`, `citations`, `completedAt`)를 함께 전달한다. 화면은 `answered`일 때만 ‘AI 설명’과 모델 이름을 규칙 기반 답변과 함께 표시하고 `rejected`/`failed`/`expired`/`null`에서는 규칙 기반 답변만 보인다(A-58). 타 계정 404, 조건 불가 409(`conversation_period_unavailable`·`conversation_condition_unavailable`). 같은 요청 ID 재전송은 동일 결과, 중복 승인 시 단일 실행. [에이전트 코어](api/agent-core.md) |
| `POST /api/v1/analyses/{analysisId}/runs/{runId}/cancel` | 해당 실행을 취소 | 200. 이미 준비 또는 실패로 끝났으면 409 |
| `GET/POST /api/v1/analyses/{analysisId}/runs/{runId}/upload-supplement` | 보완 필요 상태·사유·대상 공고 조회(GET)와 등록된 본인 PDF의 보완 점검 실행 접수(POST) | POST는 `Idempotency-Key`와 `{"uploadId"}`만 허용하며 202와 조회 `Location` 반환. 브라우저 해시·채택 필드는 400, 미적재 파일 409, 타 계정 404, `private, no-store` |
| `GET /api/v1/analyses/{analysisId}/upload-supplements/{runId}` | 업로드 보완 실행의 진행 상태와 문서 대조·점검 요약 조회 | 200 `upload-supplement-run/v1`. 완료되면 `snapshotId`와 새 실행 결과로 연결, 타 계정 404, `private, no-store` |
| `GET /api/v1/analyses/{analysisId}/uploads/{uploadId}/content` | 본인 분석의 등록된 PDF 다운로드 | 200은 PDF 본문, 미로그인 401, 타인·미등록·삭제 중 또는 완료 404, 서비스 오류 503 |

분석의 `runs` 경로는 접수와 취소 시 POST, 상태 조회 시 GET을 사용한다. 재전송할 때는 같은 멱등 키를 보낸다. 응답의 `Location`이 해당 실행의 조회 주소다. 허용한 화면 origin만 `ALLOWED_ORIGINS`에 등록한다. 오류 문의에는 응답의 `requestId`를 사용한다. [요청 본문·상태별 표시·재시도 방법](api/analysis-runs.md)

### 수집 진행과 실거래 비교를 표시한다

실행이 `finished`이면 `/result`를 조회한다. 저장된 `comparison/v1`의 `result.completeness`와 `appliedScope`를 읽고, 확인한 범위·가격·건수 옆에 보류 근거를 표시한다. 기존 v0의 세 합성 예시는 정상 0개·부분 수집·실패 문구를 연습할 때 계속 사용할 수 있다. v0의 지역 판정 필드는 `result.regionScopes`다. [저장된 비교 결과 v1](api/comparison-v1.md) · [화면용 합성 예시 v0](../tests/fixtures/analysis-result-v0.json)

| 예시를 선택한다 | 화면에서 전달할 내용 |
| --- | --- |
| `normalZero` (`complete`) | 필요한 조회와 판별을 마친 같은 동에서 비교 단지가 0개다. 이 예시에서는 같은 구로 확대해 확인한 1단지와, 우선 지역의 거래가 제외된 이유를 함께 표시한다. |
| `partialCollection` (`partial`) | 거래 14건 중 10건을 받았고 2페이지가 누락됐다. 확인한 내용과 누락 사유를 표시하고, 현재 지역의 단지 수 확정과 자동 확대는 보류한다. |
| `upstreamFailure` (`unavailable`) | 출처 조회에 실패해 비교 결과를 제공할 수 없다. 실패한 항목과 응답에 명시된 재조회 행동을 표시한다. |

수집 기록의 출처·월·누락 사유가 어떻게 만들어지는지는 [BE-02 재생 명령](api/ingestion-v0.md)으로 확인한다. 출력의 `tradeBatches[].record`는 위 계약의 `collections[]` 원소와 같은 형식이다. 프론트엔드는 한 출처의 빈 응답만으로 지역 확대를 결정하지 않는다.

## 2. Supabase Data API로 사용자 자료를 다룬다

SDK에 publishable key와 로그인 세션을 사용한다. 테이블·열별 허용 작업은 [인프라 권한표](infrastructure.md)의 제한을 따른다. 직접 SQL 관리 권한이나 service-role key를 화면에 전달하지 않는다.

TypeScript 화면에서는 `createClient<Database>(url, publishableKey)`로 생성 타입을 연결한다. 로그인 제공자·이메일 전달·리다이렉트 설정은 아직 화면 팀과 통합하지 않았다. 임시 SQL 역할 검사를 실제 가입·로그인 성공으로 표시하지 않는다.

1. `user_profiles`에 로그인 사용자의 `user_id`만 넣어 빈 프로필을 최초 생성한다. 이미 있으면 기존 프로필을 조회한다.
2. `chats` 생성 뒤 해당 ID로 사용자 메시지를 저장한다. `role: 'user'`만 클라이언트에서 생성 가능하다.
3. 분석은 `analyses`에 자기 `chat_id`를 연결해 `draft`로 만든다. 다른 기기에서 로그인하면 본인의 분석을 읽고 `latest_run_id`가 있는 항목에 실행 조회 주소를 연결한다. `null`이면 실행 접수를 안내한다.
4. 자금은 해당 `analysis_id`의 `funding_entries`에 저장한다. `current`는 분석당 하나이며 추가 자금은 `additional`, 상태는 `confirmed` 또는 `expected`다. 저장 후 같은 분석의 자금표를 조회하면 수정한 금액이 반영된다. 자금 유입과 납부가 같은 날이고 입금 시각을 모르면 입금 전·후 부족액을 모두 표시한다. [호실별 자금표](api/funding-plan.md)
5. 저장 보고서의 목록·본문·PDF는 사용자 API에서 읽는다. 계정별 소유권과 출처 권한을 요청마다 확인한다. [HTTP 요청과 버전](api/saved-reports.md)
6. 이전에 저장한 분석의 조회 조건과 수집 근거는 `analysis_input_snapshots`를 분석 ID로 조회해 표시한다. 비공개 PDF는 등록 시 받은 경로로 업로드하고, 사용자 API의 `/content` 경로로 다운로드한다. 삭제는 요청·객체 제거·완료 확인 순서로 진행한다. [스냅샷 조회와 파일 호출 예시](api/ingestion-storage.md)

## 3. 공유 프로필 변경을 승인한다

데스크톱 메뉴의 **공유 프로필** 또는 모바일의 **계정 → 공유 프로필 열기**에서 확인된 검색 조건과 대기 중인 변경안을 본다. 원 단위 최대 구매 예산, 희망 지역, 공급면적 범위와 입주 월 범위를 지정할 수 있다. 출퇴근 목적지의 저장·해제는 해당 분석의 출퇴근 경로에서 확인한다. 보유 자금과 추가 입금은 원래 분석의 자금표에서 관리한다. [출퇴근 계약](api/commute.md) · [자금표 계약](api/funding-plan.md)

완료된 분석의 비교 대화에 “다음 검색부터 구매 예산을 7억 원으로 바꿔줘”라고 입력하면 이전 값과 제안 값, 근거 문장이 담긴 변경안이 열린다. 사용자가 **공유 프로필에 반영**을 누른 뒤 맞춤 검색을 열면 승인한 값으로 시작한다. 검색 버튼을 눌러 결과를 조회한다. 계약 기간·공급면적 허용 범위·거래 종류·단지 교체 변경은 같은 분석의 새 실행으로 기록하며 공유 프로필을 바꾸지 않는다. [비교 대화 계약](api/comparison-v1.md#비교-결과에-질문하고-계약-기간을-변경한다)

세 함수는 publishable key와 로그인한 사용자 세션으로 호출한다.

| 동작 | 호출과 결과 |
| --- | --- |
| 현재 값과 이력 읽기 | `read_search_profile(p_before)`가 버전, 검색 조건, 목적지와 검색 변경안을 최신 순으로 30개까지 반환한다. 다음 페이지는 `nextCursor`를 사용한다. |
| 변경안 만들기 | `propose_search_profile_change(p_request_id, p_base_revision, p_patch, p_reason, p_analysis_id, p_run_id)`에 바꿀 키만 넣는다. 비교 대화에서는 출발한 분석과 실행을 함께 지정한다. 프로필에서 직접 작성하면 둘 다 `null`이다. 같은 요청을 재시도할 때는 UUID와 내용을 유지한다. |
| 결정하기 | `decide_search_profile_change(p_change_id, p_decision)`은 `approve`, `reject`, `cancel`을 받는다. 버전이 달라진 변경안은 최신 값을 보며 다시 검토한다. 같은 변경안을 다시 승인해도 프로필 버전은 한 번만 오른다. |

세 응답의 `contractVersion`은 `shared-profile/v1`이다. `conditions`에는 확인된 값이, `proposals[].previous`와 `patch`에는 바꿀 값이 들어간다. 삭제할 키는 변경안에 `null`로 표시한다. 현재 프로필에서 설정하지 않은 값은 `conditions`에 키가 없다.

| 검색 조건 | 화면과 RPC의 값 |
| --- | --- |
| `region_codes` | 공식 지역 목록에서 선택한 5자리 코드 배열 |
| `budget_max_won` | 원 단위 정수 문자열. 예를 들어 7억 원은 `"700000000"` |
| `supply_area_min_m2`, `supply_area_max_m2` | ㎡ 단위의 양수 십진 문자열로 두 끝값을 전달 |
| `move_in_start_month`, `move_in_end_month` | `YYYY-MM` 형식으로 첫 달과 마지막 달을 전달 |

대화에서 면적 범위를 제안하려면 “공급면적을 84㎡에서 100㎡로”처럼 기준을 지정한다. 희망 지역은 공식 지역 목록과 대조한다. 목록을 불러오지 못하면 지역 검색을 보류하고, 이미 승인한 구매 예산·공급면적·입주 월은 입력란에 복원한다.

결정 전 대기·거절·취소 상태는 현재 조건을 유지한다. 프로필을 승인한 뒤에도 저장된 분석의 조건·결과와 자금 항목은 그 분석에서 그대로 복원된다.

2026-11-23 서울 Supabase 개발 프로젝트에서 임시 계정 두 개로 검수했다. 한 계정이 공식 목록의 지역을 승인하고 같은 예산 변경안을 동시에 두 번 승인했을 때 버전은 변경안마다 한 번씩 올랐다. 다른 계정의 결정 요청은 거부됐으며 다시 로그인해 승인·거절·취소 이력과 원래 비교 결과를 조회했다. 실제 개발 인증에 연결한 로컬 브라우저에서는 합성 비교 결과의 대화에서 예산 8억 원을 승인하고 다음 검색을 열어 입력값을 확인했다. [마이그레이션](../supabase/migrations/20261123133946_shared_search_profile.sql) · [인증 검수](../scripts/smoke_shared_profile.mjs)

## 4. 화면별 구현 범위와 남은 검수를 확인한다

- **진행 중인 청약 목록 페이지**는 B7 화면 통합 대상으로 등록했다. 로그인한 사용자가 예산 입력 전에도 오늘 접수 중인 공고를 열 수 있게 한다. 화면 착수 전 백엔드가 공고 일정과 범위를 받는 전용 조회 계약을 인계한다. 현재 `POST /api/v1/notices/search`는 지역·예산을 요구하는 맞춤 검색용이다. 카드·달력 시안과 검수 사례는 [개발 계획](development-plan.md#진행-중인-청약-목록-페이지를-준비한다)에서 확인한다.
- 공고 문서 작업자가 처리한 수집본에서는 호실 또는 동·호 라인 × 층 구간(`unit.kind`: `"room"` | `"band"`) 단위로 분양가·필수 옵션과 주택형 공급면적 각각의 확인 상태를 읽을 수 있다. 비교 결과·자금표·보고서·비교 대화 화면은 `unit.kind === "band"`일 때 `'가격 구간'`, 그 외에는 `'호실'` 문구를 표시하고, 개별 호실 번호를 추정하지 않는다. 본문 정정 표지(`in_pdf_correction_unverified`), 공식 색인 해시 변경(`official_document_hash_changed`), 구간 검산 보류(`band_household_count_mismatch`·`band_floor_overlap`) 등 보류 사유와 후속 행동을 함께 표시한다. 지원 서식, LH 외부 첨부 한계와 오프라인 표본 관측 범위는 [공고 문서 작업자](api/notice-documents.md)에서 확인한다.
- 비교 작업자는 공고 실행·업로드 보완 실행에서 대상 주택형 공급면적이 원문 대조까지 확인되면 행정안전부 법정동코드·청약홈 공고/주택형(Q-38)·카카오 로컬 도로명주소 좌표(Q-39)로 `comparison-evidence/v1`을 자동 구성해 수집본과 함께 원자 저장한다. 이후 같은 수집본의 기간·조건 변경 재계산은 외부 재조회 없이 저장된 근거를 재사용하며, 공고 부재·복수 주택형·공고 간 불일치·식별자 충돌·좌표 미확인 항목은 보류 사유를 표시한다. 이 경로는 오프라인 합성 검수까지 마쳤으며, 실제 공고 실검수(`scripts/verify_auto_evidence.py --live`)·개발 DB 마이그레이션 적용·공고 없는 단지의 보완 근거(D-01)는 별도 단계다. [자동 비교 근거 계약](api/auto-comparison-evidence.md)
- 호실별 분양가·필수 옵션 원자료는 `result_snapshot.catalog`, 선택한 호실 또는 주택형의 확인 가격과 보류 사유는 `result.noticePrice`에서 읽는다. 빈 거래 목록의 의미는 `regionDecision`으로 확인한다.
- `#privacy`에서 로그인한 사용자가 삭제할 자료와 영향을 확인한다. 로그아웃 후에도 접수번호로 서비스 삭제와 백업 확인 상태를 따로 읽을 수 있다. [내 데이터 관리 계약](api/data-deletion.md)
- 실제 로그인 제공자, 화면 도메인, Production DB, 사용자 가치 검증과 59개 제품 수락 기준은 아직 별도 완료 조건이다.
