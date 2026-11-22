# 화면 팀의 데이터·API 연결 계약

2026-11-22. 화면 프레임워크는 고정하지 않는다. [인프라 준비 상태](infrastructure.md)와 [PRD](prd/01-product-prd.md)를 함께 읽는다. 개발 DB와 보호된 Preview API가 생성됐다. 키·인증값은 실행 환경으로 전달한다.

| 연결 대상을 정한다 | 주소·계약을 확인한다 |
| --- | --- |
| Supabase 개발 DB·Auth | `https://jcaelooqogosbzrfyrhe.supabase.co` |
| Vercel Preview API · 개발 브랜치 최신 배포 | `https://homecierge-api-git-codex-backend-b54136-sions-projects-d18fe574.vercel.app` |
| 로컬 API | `npm run dev` → `http://127.0.0.1:3001` |
| 타입 | [원격 DB에서 생성한 Database 타입](../src/db/database.types.ts) |

로컬 API는 `.secrets/backend.env`의 `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `APP_ENV=development`, `ALLOWED_ORIGINS`를 읽는다. 현재 Vercel 허용 origin은 `http://localhost:3000`, `http://127.0.0.1:3000`, `http://localhost:5173`, `http://127.0.0.1:5173`이다. 화면의 실제 origin이 다르면 정확한 값으로 추가한다. 원격 키는 접근 권한이 있는 프로젝트 설정에서 전달받으며 채팅·Git에 붙여 넣지 않는다.

Preview에는 Vercel 배포 보호가 켜져 있다. Vercel 로그인과 Supabase의 서비스 사용자 로그인은 별개이며, 별도 화면의 자동 API 호출에 배포 보호가 추가로 적용될 수 있다. 로컬 API로 먼저 연동하고 화면 배포 때 접근 방식을 함께 검수한다. 보호 우회 값을 화면 코드에 넣지 않는다.

11월 22일 개발 브랜치의 `c325134`에서 공고일 기준 법령 조회를 추가했다. 응답이 `available`이면 모집공고일과 법령 시행일을 따로 표시하고 해당 판본의 원문을 연결한다. 격리된 Supabase에서 두 계정으로 로그인해 본인 분석은 200, 다른 계정의 분석은 404임을 확인했다. 법령 출처의 표시 권한을 회수한 뒤에는 같은 본인 분석에서 `source_restricted`와 빈 참조를 받았다. [법령 조회 계약과 실공고 예시](api/legal-evidence.md) · [인증 통합 검사](https://github.com/95sionkim/HomeCierge/actions/runs/44991331159)

11월 22일 개발 브랜치의 `e2c916a`를 보호된 Preview에 배포했다. 공고 검색, 비공개 PDF, 분석 실행·비교와 함께 선택한 호실의 자금표를 조회할 수 있다. 팀 접근으로 `/api/health`는 200, 자금표 경로의 GET은 405와 `Allow: POST, OPTIONS`를 반환했다. 자금표 응답에는 `private, no-store`가 적용된다. [호실별 자금표와 계산 예](api/funding-plan.md) · [공고 검색 계약](api/notice-search.md)

격리 Supabase에 두 계정으로 로그인해 자금표 POST를 검수했다. 계약금 7,100만 원, 보유 잔액 5천만 원, 당일 예상 입금 400만 원에서 예상 자금 포함 시 부족액은 입금 전 2,100만 원과 입금 후 1,700만 원이었다. 예상액을 500만 원으로 수정하면 입금 후 부족액은 1,600만 원이 됐다. 다른 계정의 같은 조회는 404였다. [인증 통합 검사](https://github.com/95sionkim/HomeCierge/actions/runs/44989806440)

## 1. 인증과 API를 연결한다

사용자는 Supabase Auth로 로그인하고 사용자 access token을 `Authorization: Bearer <access_token>` 헤더로 전달한다. API는 쿠키 기반 인증을 가정하지 않는다. 프레임워크별 로그인·세션 갱신·리다이렉트 화면과 로그인 수단은 화면 통합 단계에서 연결한다. 토큰·비밀번호는 채팅 내용이나 로그에 기록하지 않는다.

| 요청을 보낸다 | 의미를 구분한다 | 응답과 실패를 처리한다 |
| --- | --- | --- |
| `GET /api/health` | API 프로세스의 생존 확인 | 200. DB·로그인·분석 기능 완료를 보장하지 않음 |
| `GET /api/ready` | 인증 후 사용자 권한으로 프로필 테이블 조회 | 200은 해당 DB 조회 성공. 미로그인 401, 설정·백엔드 실패 503 |
| `GET /api/v1/me` | 인증한 사용자의 ID·프로필 조회 | `{ user: { id }, profile }`. 최초에는 `profile: null` 가능 |
| `POST /api/v1/notices/search` | 희망 지역·예산과 선택 면적·입주월로 공고를 탐색 | 200이면 조건 충족·확인 필요 목록과 수집 범위를 표시. 최신 색인 준비 중은 503. [요청 및 응답](api/notice-search.md) |
| `POST /api/v1/analyses/{analysisId}/funding-plan` | 해당 분석의 수집본·주택형·호실을 선택해 납부일별 자금과 부족액을 조회 | 확정 자금과 예상 포함 금액, 날짜를 알 수 없는 납부와 근거를 표시. [요청과 계산 예](api/funding-plan.md) |
| `GET /api/v1/analyses/{analysisId}/snapshots/{snapshotId}/legal-evidence` | 본인 공고의 모집공고일에 시행된 「주택공급에 관한 규칙」을 조회 | 공고일·시행일·법제처 원문을 표시한다. 법령 판본과 개인 자격의 확인 상태를 구분한다. [상태별 표시와 예시](api/legal-evidence.md) |
| `POST /api/v1/analyses/{analysisId}/runs` | 자기 분석에서 수집 자료 준비를 접수 | 202와 조회 주소. 같은 키로 다른 입력을 보내면 409 |
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

- 공고 문서 작업자가 처리한 수집본에서는 호실의 분양가·필수 옵션과 주택형 공급면적 각각의 확인 상태를 읽을 수 있다. 확인한 값은 문서 버전·페이지를, 보류한 값은 사유와 보완 경로를 표시한다. 지원 서식과 실제 검수 범위는 [공고 문서 작업자](api/notice-documents.md)에서 확인한다.
- 현재 비교 작업자는 수집된 거래와 검수된 공급면적 근거를 사용한다. 실거래 공급면적 근거 자동 수집, 지역 뉴스와 출퇴근 경로 API 연결은 후속 개발 범위다.
- 호실별 분양가·필수 옵션 원자료는 `result_snapshot.catalog`, 선택한 호실 또는 주택형의 확인 가격과 보류 사유는 `result.noticePrice`에서 읽는다. 빈 거래 목록의 의미는 `regionDecision`으로 확인한다.
- 비공개 업로드 한 건은 삭제할 수 있다. 계정 전체, 파생 보고서와 백업 정리를 포함한 삭제 완료 화면은 후속 작업이다.
- 실제 로그인 제공자, 화면 도메인, Production DB, 사용자 가치 검증과 59개 제품 수락 기준은 아직 별도 완료 조건이다.
