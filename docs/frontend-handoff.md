# 화면 팀의 데이터·API 연결 계약

2026-11-11. 화면 프레임워크는 고정하지 않는다. [인프라 준비 상태](infrastructure.md)와 [PRD](prd/01-product-prd.md)를 함께 읽는다. 개발 DB와 보호된 Preview API가 생성됐다. 키·인증값은 문서에 기록하지 않고 실행 환경으로 전달한다.

| 연결 대상을 정한다 | 주소·계약을 확인한다 |
| --- | --- |
| Supabase 개발 DB·Auth | `https://jcaelooqogosbzrfyrhe.supabase.co` |
| Vercel Preview API | `https://homecierge-i5h481o7w-sions-projects-d18fe574.vercel.app` |
| 로컬 API | `npm run dev` → `http://127.0.0.1:3001` |
| 타입 | [원격 DB에서 생성한 Database 타입](../src/db/database.types.ts) |

로컬 API는 `.secrets/backend.env`의 `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `APP_ENV=development`, `ALLOWED_ORIGINS`를 읽는다. 현재 Vercel 허용 origin은 `http://localhost:3000`, `http://127.0.0.1:3000`, `http://localhost:5173`, `http://127.0.0.1:5173`이다. 화면의 실제 origin이 다르면 정확한 값으로 추가한다. 원격 키는 접근 권한이 있는 프로젝트 설정에서 전달받으며 채팅·Git에 붙여 넣지 않는다.

Preview에는 Vercel 배포 보호가 켜져 있다. Vercel 로그인과 Supabase의 서비스 사용자 로그인은 별개이며, 별도 화면의 자동 API 호출에 배포 보호가 추가로 적용될 수 있다. 로컬 API로 먼저 연동하고 화면 배포 때 접근 방식을 함께 검수한다. 보호 우회 값을 화면 코드에 넣지 않는다.

## 1. 인증과 API를 연결한다

사용자는 Supabase Auth로 로그인하고 사용자 access token을 `Authorization: Bearer <access_token>` 헤더로 전달한다. API는 쿠키 기반 인증을 가정하지 않는다. 프레임워크별 로그인·세션 갱신·리다이렉트 화면과 로그인 수단은 화면 통합 단계에서 연결한다. 토큰·비밀번호는 채팅 내용이나 로그에 기록하지 않는다.

| 요청을 보낸다 | 의미를 구분한다 | 응답과 실패를 처리한다 |
| --- | --- | --- |
| `GET /api/health` | API 프로세스의 생존 확인 | 200. DB·로그인·분석 기능 완료를 보장하지 않음 |
| `GET /api/ready` | 인증 후 사용자 권한으로 프로필 테이블 조회 | 200은 해당 DB 조회 성공. 미로그인 401, 설정·백엔드 실패 503 |
| `GET /api/v1/me` | 인증한 사용자의 ID·프로필 조회 | `{ user: { id }, profile }`. 최초에는 `profile: null` 가능 |

허용하지 않은 origin은 403이며 정확한 화면 origin을 `ALLOWED_ORIGINS`에 등록해야 한다. 응답은 캐시하지 않는다. 실패 응답의 `requestId`로 문제를 추적하며 인증값·외부 오류 원문을 화면에 노출하지 않는다. 현재 API는 조회용이며 분석 생성·삭제·공고 탐색 엔진을 구현한 API가 아니다.

## 2. Supabase Data API로 사용자 자료를 다룬다

SDK에 publishable key와 로그인 세션을 사용한다. 테이블·열별 허용 작업은 [인프라 권한표](infrastructure.md)의 제한을 따른다. 직접 SQL 관리 권한이나 service-role key를 화면에 전달하지 않는다.

TypeScript 화면에서는 `createClient<Database>(url, publishableKey)`로 생성 타입을 연결한다. 로그인 제공자·이메일 전달·리다이렉트 설정은 아직 화면 팀과 통합하지 않았다. 임시 SQL 역할 검사를 실제 가입·로그인 성공으로 표시하지 않는다.

1. `user_profiles`에 로그인 사용자의 `user_id`만 넣어 빈 프로필을 최초 생성한다. 이미 있으면 기존 프로필을 조회한다.
2. `chats` 생성 뒤 해당 ID로 사용자 메시지를 저장한다. `role: 'user'`만 클라이언트에서 생성 가능하다.
3. 분석은 `analyses`에 자기 `chat_id`를 연결해 `draft`로 만든다. 조건 스냅샷이 비어 있는 초안을 완성된 분석처럼 표시하지 않는다.
4. 자금은 해당 `analysis_id`의 `funding_entries`에 저장한다. `current`는 분석당 하나이며 추가 자금은 `additional`, 상태는 `confirmed` 또는 `expected`다. 현재는 계산 결과를 생성하지 않는다.
5. `reports`는 서버가 기록한 스냅샷만 조회한다. 프로필 변경으로 이전 보고서를 조용히 덮어쓰지 않는다.

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

- 공고 검색·PDF 자동 확보·공급면적 매칭·실거래 통계·법령·뉴스·경로·자금 계산은 이 인프라 API에서 아직 실행하지 않는다.
- 가격·필수 옵션·거래 상세 테이블은 자료 계약과 수집기 검증 후 후속 마이그레이션으로 추가한다. 빈 테이블을 정상 0개 결과로 표시하지 않는다.
- 개별·계정 삭제와 PDF Storage는 후속 작업이다. 직접 DELETE는 차단돼 있으며 삭제·다운로드 완료 화면을 미리 연결하지 않는다.
- 실제 로그인 제공자, 화면 도메인, Production DB, 사용자 가치 검증과 59개 제품 수락 기준은 아직 별도 완료 조건이다.
