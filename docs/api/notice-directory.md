# 오늘 접수하는 청약 공고에서 분석을 시작한다

로그인 직후 지역이나 예산을 입력하기 전에 오늘 접수하는 공고와 접수 예정 공고를 살펴본다. 지역·예산으로 호실을 찾는 맞춤 검색은 별도 경로를 사용한다. 화면은 청약홈의 두 구조화 목록에서 가져온 같은 일정으로 카드와 달력을 구성할 수 있다. [맞춤 검색](notice-search.md) · [화면용 합성 응답 세 가지](../../tests/fixtures/notice-directory-v1.json)

## 공고 목록을 읽는다

`GET /api/v1/notices`에 사용자 세션의 Bearer 토큰을 전달한다. 정상 응답은 `notice-directory/v1`이다. `asOf`는 서버가 정한 한국 날짜이고, `observedAt`은 실제로 자료를 확인한 시각이다. `publicationWindow`는 조사한 **모집공고일** 구간이다. 예를 들어 10월에 게시해 11월 22일까지 접수하는 공고도 이 구간에 들어 있으면 11월 22일 목록에 나타난다.

| 화면에서 할 일 | 읽을 값과 동작 |
| --- | --- |
| 접수 중·예정을 표시한다 | `notices[].applicationStatus`의 `open`을 마감일순으로, `upcoming`을 시작일순으로 받는다. ‘접수 중만’ 보기에서는 `open` 구간을 사용한다. 종료 공고를 포함할 때는 `?includeClosed=true`로 처음부터 읽는다. |
| 달력에 표시한다 | `application`에는 첫날과 마지막 날, `applicationSegments`에는 확인한 개별 구간이 있다. 분리 구간에서는 해당 날짜에만 표시한다. 빈 구간 배열이거나 상태가 `unknown`인 날은 ‘일정 확인 필요’로 표시한다. |
| 공고와 소재지를 식별한다 | 공고명·유형·`regionName`을 표시한다. 이름이 미확인이면 사유를 함께 표시한다. 두 번호와 `edition`은 표기가 같은 공고나 정정 회차를 구분하는 데 사용한다. `officialPortal`은 청약홈 공식 포털 링크다. |
| 빈 결과를 설명한다 | `counts`와 `zeroStatus.open`·`zeroStatus.upcoming`은 전체 조회 결과를 기준으로 한다. `confirmed_zero`일 때만 두 출처의 표시된 모집공고일 구간에서 접수 건수가 0이라고 안내한다. `indeterminate`면 `coverage`, `scopeIssues`, 공고의 일정·유형 사유를 표시한다. |
| 다음 페이지를 읽는다 | 기본 20개이며 `limit=1..50`을 지원한다. `page.nextCursor`를 그대로 `cursor`에 보내고 같은 `includeClosed` 설정을 유지한다. 조회 중 한국 날짜나 게시본이 바뀌어 409 `directory_page_changed`가 오면 첫 페이지부터 다시 읽는다. |
| 목록을 열 수 없는 경우를 표시한다 | 세션이 없거나 만료되면 401, 목록 출처가 제한되면 403, 게시본이 없거나 72시간을 넘기면 503 `search_index_not_ready`가 온다. 다음날에도 이전 관측이 남아 있다면 기준일·마지막 관측 시각과 확인 중 상태를 함께 표시한다. |

## 고른 주택형의 분석을 시작한다

1. 공고의 `models`에서 한 주택형을 고른다. `analysisInput`이 있으면 그 객체를 사용한다. 값이 `null`이면 `selectionBlockers`를 표시하며, 모델 목록이 비면 주택형 확인을 기다린다.
2. 로그인한 계정에 분석 초안을 만들고 `POST /api/v1/analyses/{analysisId}/runs`로 `{"input": …}`를 보낸다. 같은 클릭의 재전송에는 같은 `Idempotency-Key`를 사용한다. 서버가 최신 공고·회차·모델·지역과 출처 권한을 다시 확인한다.
3. 202 응답의 `Location`에서 상태를 읽는다. 재로그인한 기기에서는 분석의 `latest_run_id`로 같은 주소를 복원한다. `finished`이면 `/result`에서 실제 가격·면적·비교 가능 여부와 보류 사유를 읽는다. 작업 도중 주택형이 바뀌어 확인할 수 없게 되면 `failed`와 `notice_selection_unverified`를 표시하고 목록에서 다시 선택할 수 있게 한다. [실행·재조회·취소 계약](analysis-runs.md)

## 수집한 범위와 근거를 읽는다

디렉터리는 공고 일정·지역·공식 주택형 식별자를 독립적으로 게시한다. 호실 가격과 PDF 근거를 사용하는 맞춤 검색의 발행본은 별도로 보관한다. 두 목록 중 한 피드가 실패하거나 페이지가 누락되면 마지막으로 완전히 수집한 목록과 그 관측 시각을 유지한다. 모델 출처의 사용 권한이 철회되면 공고 일정은 볼 수 있고 그 출처의 주택형은 보류한다. [청약홈 분양정보 서비스](https://www.data.go.kr/data/15098547/openapi.do) · [행정표준코드관리시스템 법정동 자료](https://www.code.go.kr/stdcode/regCodeL.do)

개발 작업자는 `python3 scripts/refresh_notice_index.py --live --publish`로 한국 날짜 기준 최근 90일을 갱신한다. 법정동 자료는 행정표준코드관리시스템에서 받아 확인하고, 접수 중·예정을 우선해 최대 40개 공고의 주택형을 조회한다. 이 작업의 PDF 요청은 0회다. 개발 Mac의 목록 서비스는 매일 09:17 KST에 갱신한다. GitHub Actions를 쓰는 경우에는 기본 브랜치의 워크플로, 개발 환경 `notice-refresh-development`의 데이터포털 키와 개발 DB 주소·작업자 키, `NOTICE_REFRESH_ENABLED=true`를 설정하고 Mac의 목록 예약을 해제한다. 11월 22일 검수는 수동 게시로 진행했다. [개발 Mac 서비스 설치와 상태 확인](notice-operations.md) · [갱신 작업](../../scripts/refresh_notice_index.py) · [GitHub 예약 설정](../../.github/workflows/notice-refresh.yml)

서울 개발 환경에서 2026-11-22 15:51 KST에 8월 25일~11월 22일의 모집공고를 조회했다. 두 피드에서 198건을 수집했고, 우선 조회한 16개 공고에서 주택형 62개를 읽었다. 오늘 목록에는 접수 예정 28건과 일정 미확인 2건이 표시됐다. 확인된 접수 중 공고는 0건이었고 미확인 일정이 있어 `zeroStatus.open`은 `indeterminate`였다. 종료 167건과 지원 대상 외 1건은 기본 목록에서 제외했다. 이후 갱신 시 건수는 달라질 수 있다.

같은 날 목록에서 고른 충청남도 논산시 공고 `2026000540`의 11월 13일 회차, 주택형 `01`을 별도로 검산했다. 청약홈이 반환한 공고 1행·주택형 3행에서 `084.9946A`를 확인한 뒤 2025-11-23~2026-11-22의 매매와 권리를 조회했다. 공식 API 29회로 13개월의 두 피드 26개를 모두 수집했다. 매매 736행 중 574행, 권리 74행 중 70행이 기간·해제 등 기본 검사를 통과했다. 이 수치는 단지·공급면적 대조 전 거래 수다. 공식 PDF 조회는 0회였고 호실 소계와 공급면적을 입증할 근거가 없어 가격과 비교 결과는 보류됐다. 공식 응답을 사용한 로컬 DB 검사에서 작업자가 수집본과 비교 결과를 한 번에 저장했다. 소유자가 다시 읽은 결과의 `target_supply_area_unverified`와 `no_confirmed_room_subtotal`도 일치했다. 이때 화면에서 ‘주변 거래 0건’이라고 표시하면 안 된다. [국토교통부 아파트 매매 자료](https://www.data.go.kr/data/15126468/openapi.do) · [분양권·입주권 거래 자료](https://www.data.go.kr/data/15126471/openapi.do)
