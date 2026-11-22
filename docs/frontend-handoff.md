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
| S-01 채팅 홈에서 시작하거나 돌아온다 | 재로그인한 사용자의 분석 목록과 `latest_run_id`로 작업을 복원한다. 와이어프레임의 시작 카드는 공고명·번호·PDF 세 가지다. 추가로 요청한 **오늘의 청약**은 이 홈에서 예산 입력 없이 들어가는 진입점으로 제안한다. |
| 오늘 접수 중·예정인 공고를 훑는다 | `GET /api/v1/notices`의 접수 구간·한국 기준일·관측 시각을 카드와 달력이 같이 쓴다. S-02는 이름이 같은 공고의 회차를 고르는 화면이다. 오늘 개발 화면은 이 공고 목록을 카드·달력으로 제공하고 로그인·작은 화면 배치까지 연결했다. |
| S-02에서 회차를 구분하고 S-03에서 주택형을 고른다 | 공고 식별은 주택관리번호·공고번호·판본, 주택형 선택은 `models[].analysisInput`을 쓴다. 선택이 보류된 항목은 `selectionBlockers`를 안내한다. 해당 공고명의 과거 전체 회차 검색, PDF 동일 회차 표시, 호실 가격에는 각각 별도 조회와 근거가 필요하다. |
| 맞춤 공고를 찾는다 | 메뉴의 **맞춤 검색**에서 공식 시·군·구와 원 단위 예산을 입력한다. 공급면적(㎡·평), 입주 예정월, 접수 종료 포함은 선택 조건이다. 확인 필요 호실에는 보류 사유를, 금액과 면적에는 공식 문서의 판본과 쪽을 표시한다. 분석을 시작할 때는 최신 공고 목록에서 회차와 주택형을 다시 대조한다. [검색 계약](api/notice-search.md) |
| 자금과 납부 근거를 확인한다 | **내 분석 → 완료된 분석 → 호실 자금표**에서 호실을 바꾸고, 보유 잔액과 추가 입금의 날짜·확정 여부를 저장한다. 날짜별 입금 전·후 부족액을 나란히 보며, 날짜 미확정 납부는 따로 확인한다. 호실·일정 자료가 부족해도 자기 분석의 자금 입력은 열려 있다. [자금표 계약](api/funding-plan.md) |
| S-04·S-05에서 비교 범위·가격·보류를 표시한다 | `comparison/v1`의 `regionDecision`, `noticePrice`, `holds`, 수집 상태를 읽는다. 비교 보류 화면의 세 칸에 빠진 근거, 다시 비교할 조건, 계속 볼 수 있는 값을 채운다. 개별 작업 시각이 없으면 실제로 받은 실행 상태까지만 표시한다. [비교 응답](api/comparison-v1.md) |
| 공고일에 적용된 법령을 연다 | **내 분석 → 완료된 분석 → 법령 근거**에서 모집공고일과 시행일을 대조하고 법제처의 해당 판본을 연다. 개별 조문은 번호와 제목으로 찾는다. 부칙·경과규정, 개인별 자격과 예외는 추가 확인 대상이다. [법령 계약](api/legal-evidence.md) |
| S-06에서 지역 뉴스를 조회한다 | **지역 뉴스 → 지역 뉴스 보기**를 누르면 해당 공고의 시·군·구로 최신순 검색을 요청한다. 제목·검색 발췌·원문 링크와 제공 시각을 보여준다. 탭을 떠나면 기사 목록을 지우며 다시 열 때 새로 조회할 수 있다. [뉴스](api/regional-news.md) |
| S-07~08과 확인·근거 패널을 연다 | O-3의 공유 프로필 승인은 이번 분석의 조건 변경과 구분한다. O-5 원문은 접근 허용된 파일·판본·쪽으로만 연결한다. S-07 보고서 생성·내보내기는 후속 구현이다. [비공개 파일](api/ingestion-storage.md) |

전달본은 1440px 데스크톱 예시이며 최소 너비는 1280px다. 본문은 Pretendard, 식별자는 Roboto Mono를 사용한다. `StatusBadge`는 확인됨·정상 0건·일부 수집·미확인·조회 실패·연결 보류를 아이콘과 낱말로 함께 구분한다. 값이 없으면 `—`를 표시하고, 확인한 수치에는 `SourceChip`으로 출처와 시각 또는 쪽을 연결한다. 예를 들어 접수 중으로 확인한 공고가 0개여도 `zeroStatus.open = indeterminate`이면 ‘일정 확인 필요’를 표시한다.

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

지역 뉴스는 개발 브랜치 `8f0f012`의 Preview에 배포했다. 현재 서울 개발 DB는 실제 뉴스 표시를 보류하므로, 화면 팀은 합성 응답으로 목록과 보류 상태를 연결할 수 있다. 격리된 Supabase에서 두 계정으로 로그인해 소유자의 검색결과 표시, 타인 조회 404, 출처 권한 회수 직후 같은 공고의 `source_restricted` 응답을 확인했다. 이 검사의 뉴스는 합성이며, 실제 네이버 검색 검수는 API 문서에 기록했다. [뉴스 조회 계약](api/regional-news.md) · [합성 응답 예시](../scripts/smoke_regional_news.mjs) · [인증 통합 검사](https://github.com/95sionkim/HomeCierge/actions/runs/44993607803)

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
| `POST /api/v1/notices/search` | 희망 지역·예산과 선택 면적·입주월로 공고를 탐색 | 200이면 조건 충족·확인 필요 목록과 수집 범위를 표시. 최신 색인 준비 중은 503. [요청 및 응답](api/notice-search.md) |
| `POST /api/v1/analyses/{analysisId}/funding-plan` | 해당 분석의 수집본·주택형·호실을 선택해 납부일별 자금과 부족액을 조회 | 확정 자금과 예상 포함 금액, 날짜를 알 수 없는 납부와 근거를 표시. [요청과 계산 예](api/funding-plan.md) |
| `GET /api/v1/analyses/{analysisId}/snapshots/{snapshotId}/legal-evidence` | 본인 공고의 모집공고일에 시행된 「주택공급에 관한 규칙」을 조회 | 공고일·시행일·법제처 원문을 표시한다. 법령 판본과 개인 자격의 확인 상태를 구분한다. [상태별 표시와 예시](api/legal-evidence.md) |
| `POST /api/v1/analyses/{analysisId}/snapshots/{snapshotId}/regional-news` | 사용자가 지역 뉴스 보기를 선택하면 공고 소재지로 최신순 검색 | 본문 없이 호출한다. 네이버 검색결과를 독립된 영역에서 원래 순서로 표시하고 기사별 원 출처·원문 링크, 검색 발췌, API 제공 시각, 지역 관련성 미확인을 안내한다. [상태와 표시 계약](api/regional-news.md) |
| `POST /api/v1/analyses/{analysisId}/runs` | 선택한 공고·주택형의 자료 수집이나 기존 수집본의 분석을 접수 | 목록에서 받은 `analysisInput`을 보내면 202와 조회 주소를 받는다. 같은 키로 다른 입력을 보내면 409 |
| `GET /api/v1/analyses/{analysisId}/runs/{runId}` | 실행 상태를 다시 읽음 | 200. 자료가 준비되면 `snapshotId` 제공 |
| `GET /api/v1/analyses/{analysisId}/runs/{runId}/result` | 선택한 주택형과 주변 실거래의 저장된 비교 결과를 읽음 | 200이면 완전성·가격 상태·보류 사유를 표시. 출처 표시 권한이 철회되면 403, 다른 계정이면 404, 저장된 결과가 없으면 409 |
| `POST /api/v1/analyses/{analysisId}/runs/{runId}/cancel` | 해당 실행을 취소 | 200. 이미 준비 또는 실패로 끝났으면 409 |
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
5. `reports`는 서버가 기록한 스냅샷만 조회한다. 프로필 변경으로 이전 보고서를 조용히 덮어쓰지 않는다.
6. 이전에 저장한 분석의 조회 조건과 수집 근거는 `analysis_input_snapshots`를 분석 ID로 조회해 표시한다. 비공개 PDF는 등록 시 받은 경로로 업로드하고, 사용자 API의 `/content` 경로로 다운로드한다. 삭제는 요청·객체 제거·완료 확인 순서로 진행한다. [스냅샷 조회와 파일 호출 예시](api/ingestion-storage.md)

## 3. 공유 프로필 변경을 승인한다

변경안의 `proposed_changes`에는 `search_conditions`와 `commute_destination`만 허용한다. `search_conditions`는 부분 필드 병합이 아닌 해당 객체의 새 전체 값이다. 기존 조건을 유지하려면 화면에서 기존 값과 변경 값을 합쳐 사용자에게 확인받고 전달한다. 공유 프로필에 상세 자금 항목을 넣을 수 없다.

| 탐색 조건의 키를 정한다 | 값의 형식을 정한다 |
| --- | --- |
| `region_codes` | 시·군·구 코드 문자열 배열. 형식 검사는 5자리, 실제 지역 대응 검증은 별도 |
| `budget_max_won` | 원 단위 0 이상 정수의 십진 문자열. 예: 합성 값 `"1000000000"` |
| `supply_area_min_m2`, `supply_area_max_m2` | 0보다 큰 숫자. 전용면적을 대입하지 않음 |
| `move_in_start_month`, `move_in_end_month` | `YYYY-MM` 문자열 |

공유 목적지는 사용자가 지정한 문자열이며 `null`로 삭제하는 변경안을 낼 수 있다. 이 문자열을 검증된 좌표로 취급하지 않는다. `base_revision`에는 화면이 읽은 현재 프로필 버전을 넣는다.

```ts
// 사용자에게 이전 값·새 값·근거를 보여준 뒤에만 명시적으로 호출한다.
const { data, error } = await supabase.rpc('decide_profile_change', {
  request_id: selectedChangeId,
  decision: 'approved', // 거절: rejected, 취소: cancelled
});
```

버전 충돌(`40001`)이면 최신 프로필을 다시 읽고 변경안을 다시 검토한다. 과거 승인을 자동 재전송하지 않는다. 미응답 상태에서는 호출하지 않으며 같은 변경안의 중복 결정도 허용하지 않는다. 이 함수는 프로필만 갱신하고 기존 분석·보고서의 스냅샷을 바꾸지 않는다.

## 4. 구현 전인 기능을 구분한다

- **진행 중인 청약 목록 페이지**는 B7 화면 통합 대상으로 등록했다. 로그인한 사용자가 예산 입력 전에도 오늘 접수 중인 공고를 열 수 있게 한다. 화면 착수 전 백엔드가 공고 일정과 범위를 받는 전용 조회 계약을 인계한다. 현재 `POST /api/v1/notices/search`는 지역·예산을 요구하는 맞춤 검색용이다. 카드·달력 시안과 검수 사례는 [개발 계획](development-plan.md#진행-중인-청약-목록-페이지를-준비한다)에서 확인한다.
- 공고 문서 작업자가 처리한 수집본에서는 호실의 분양가·필수 옵션과 주택형 공급면적 각각의 확인 상태를 읽을 수 있다. 확인한 값은 문서 버전·페이지를, 보류한 값은 사유와 보완 경로를 표시한다. 지원 서식과 실제 검수 범위는 [공고 문서 작업자](api/notice-documents.md)에서 확인한다.
- 현재 비교 작업자는 수집된 거래와 검수된 공급면적 근거를 사용한다. 실거래 공급면적 근거 자동 수집과 출퇴근 경로 API 연결은 후속 개발 범위다.
- 호실별 분양가·필수 옵션 원자료는 `result_snapshot.catalog`, 선택한 호실 또는 주택형의 확인 가격과 보류 사유는 `result.noticePrice`에서 읽는다. 빈 거래 목록의 의미는 `regionDecision`으로 확인한다.
- 비공개 업로드 한 건은 삭제할 수 있다. 계정 전체, 파생 보고서와 백업 정리를 포함한 삭제 완료 화면은 후속 작업이다.
- 실제 로그인 제공자, 화면 도메인, Production DB, 사용자 가치 검증과 59개 제품 수락 기준은 아직 별도 완료 조건이다.
