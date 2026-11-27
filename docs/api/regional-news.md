# 선택한 공고 지역의 뉴스를 조회한다

로그인한 사용자가 분석에서 **지역 뉴스 보기** 또는 쪽 이동을 선택하면 서버가 그 공고의 공식 소재지에서 확인한 시·군·구로 네이버 뉴스를 한 쪽(10건)씩 조회한다. 조회 시점의 검색결과를 보여주는 기능이다. 검색어와 일치하는 기사가 실제 단지에 영향을 주는지, 기사 내용이 사실인지는 확인되지 않았다. [PRD R-10·A-14](../prd/01-product-prd.md) · [검색 제공 조건과 출처](be-10-news-sources.md)

## 화면에서 요청한다

`POST /api/v1/analyses/{analysisId}/snapshots/{snapshotId}/regional-news`에 사용자 JWT를 보낸다. 쿼리는 비워 둔다. 요청 본문은 선택이며, JSON 객체 `{"page": n}`(정수 `1`~`100`)으로 조회할 쪽을 지정할 수 있다. 본문이 없거나 `{}`이면 1쪽을 조회한다. 본문을 보낼 때는 `Content-Type: application/json`을 사용한다.

한 쪽은 10건(`display=10`), 시작 위치는 `start=(page-1)*10+1`, 정렬은 최신순(`sort=date`) 고정이다. NAVER API HUB의 `start` 상한(1~1000)에 맞춰 마지막으로 요청할 수 있는 쪽은 `min(ceil(total/10), 100)`이다. `page`가 1~100 범위의 정수가 아니거나 허용되지 않은 본문 키가 있으면 400 `invalid_news_input`을 반환한다. 서버는 사용자가 소유한 분석과 수집본의 공고 식별자를 대조한 뒤, 청약홈에 보고된 주소의 행정구역만 검색한다. 예를 들어 서울특별시 광진구 소재 공고의 검색어는 `서울특별시 광진구 분양`이다. 상세 주소·사용자 목적지·자금·계정 식별자는 외부 요청에 포함하지 않는다.

응답의 `contractVersion`은 `regional-news/v1`이다. `analysisId`와 `snapshotId`는 선택한 수집본을 식별한다. 2026-11-27 쪽 단위 조회를 도입하면서 `search.conditions.display`를 `3`에서 `10`으로 변경하고, `search.conditions.start`와 `search.page`(`{ number, size: 10, total, lastPage, hasPrevious, hasNext }`, 제공자 미응답·미설정·오류 상태에서는 `null`)를 추가했다.

**내 분석 → 완료된 분석 → 지역 뉴스**에서 사용자가 **지역 뉴스 보기**를 눌러 1쪽을 조회하고, 10건 목록 아래의 쪽 이동(이전·다음, `n / 마지막`)으로 다음·이전 쪽을 조회한다. 뒤로 가거나 분석을 다시 열어도 새 요청은 버튼을 눌러야 발생한다. 결과·오류는 해당 탭에 표시하고, 현재 쪽 기사만 메모리에 두며 쪽 이동·재조회·탭 이동·계정 전환 때 이전 목록을 지우고 브라우저 저장소에 남기지 않는다.

| `status`를 읽는다 | 화면에 표시한다 |
| --- | --- |
| `available` | `search.source`의 네이버 검색 출처, `search.conditions`의 검색어·정렬·`display`(10)·`start`, `search.page`(`number`·`size`·`total`·`lastPage`·`hasPrevious`·`hasNext`), `queriedAt`을 표시한다. `items`는 제공된 순서로 최대 10건이다. |
| `empty` | 출처가 정상 응답했고 이 검색어 또는 요청한 쪽에서 제공된 기사가 0건이다. `search.page`에 `total`과 `lastPage`를 함께 반환한다. |
| `partial` | 제공자가 보낸 결과 중 요청 쪽 기대 건수(`min(10, total - start + 1)`) 대비 빠졌거나 판독할 수 없는 항목이 있다. 목록 전체를 보류하고 `omittedCount`에 해당 항목 수를 표시한다(`search.page` 포함). |
| `region_unverified`, `selection_unverified`, `synthetic_input` | 공고의 행정구역·분석과 공고의 연결·실공고 수집 여부 중 해당 항목을 안내한다. `search`는 `null`이다. |
| `source_restricted` | 출처 이용 조건을 확인 중이다. 외부 검색을 실행하지 않는다. `search`는 `null`이다. |
| `not_configured`, `provider_unavailable`, `rate_limited` | 서버 뉴스 키, 제공자 응답, 제공자 이용 한도 중 해당 상태를 안내한다. `search.page`는 `null`이다. 응답 `start`가 요청 `start`와 다르거나 항목 수가 `min(10, total - start + 1)`을 초과하면 `provider_unavailable`로 처리한다. 다른 분석 기능은 그대로 열 수 있다. |

정상 항목의 `title`과 `snippet`은 제목과 검색 발췌다. 화면에서 일반 텍스트로 출력하고 `originalHost`와 `originalUrl`로 원 출처와 원문 링크를 함께 표시한다. `publishedAt`은 네이버에 기사가 제공된 시각이며 미제휴 기사는 원문이 제공된 시각이다. `geographicRelevance`와 `factVerification`은 모두 `unverified`이다. 검색조건과 이 안내는 기사 목록 밖에 둔다.

네이버 검색결과는 별도 영역에서 제공 순서와 내용을 유지하고, 공식 브랜드 가이드에 맞게 출처를 표시한다. 이 영역에 광고·추천 문구를 섞지 않는다. 화면을 다시 열면 사용자가 새로 조회한다. 서비스는 뉴스 결과를 서버에 저장·캐시하지 않으며 대화·AI 입력·분석 스냅샷·저장 보고서·PDF에 담지 않는다. [NAVER API HUB 브랜드 가이드](https://guide.ncloud-docs.com/docs/apihub-brandguide)

## 서버에서 출처와 호출을 관리한다

- 사용자 JWT로 `prepare_analysis_regional_news`를 호출해 소유권·공고·지역과 출처 이용 상태를 확인한다. 청약홈과 지역코드 자료는 저장·재사용·표시 조건을 확인하며, 뉴스 조회에는 `naver_news`의 표시 허용이 필요하다. 등록 누락과 권한 철회는 `source_restricted`다.
- 사용자별 외부 조회 준비는 1분당 12회로 제한한다(쪽 넘김마다 1회로 집계한다). 한국 내 검색 제공자의 계약 한도와는 별개의 서비스 설정이다. 초과하면 HTTP 429 `news_rate_limited`와 `Retry-After: 60`을 보낸다. DB에는 계정별 제한 시간과 횟수를 한 행으로 유지하며 계정 삭제 때 함께 제거한다.
- 미로그인 401, 잘못된 식별자·`page` 범위·본문·쿼리 400(`invalid_news_input`), 다른 사용자 또는 분석에 속한 수집본 404, 4KiB 초과 본문 413(`payload_too_large`), `application/json` 외 본문 415(`unsupported_media_type`)다. 응답에는 `private, no-store`가 적용된다. 서버는 쪽마다 한 페이지를 새로 요청하며 결과를 저장·캐시하지 않고 검색 결과로 연결되는 기사 본문은 요청하지 않는다.
- `NAVER_API_CLIENT_ID`와 `NAVER_API_CLIENT_SECRET`은 해당 서비스를 등록한 서버 환경에 둔다. 화면 팀은 개발용 합성 응답으로 먼저 연결하고, 실제 화면에서 네이버·원 출처 표시와 광고·수익화 조건을 확인한 뒤 해당 환경을 연다.

## 검수 결과

2026년 11월 22일 15시 20분(한국 시각), 개발 커넥터에서 `서울특별시 광진구 분양`을 최신순으로 한 번 요청했다. 결과 3건 모두 제목·발췌·원문 URL·API 제공 시각을 갖췄다. 기사별 값은 출력하거나 저장하지 않았다. 이 검수는 검색 응답의 형식과 전달 경로를 확인한 것이다.

PostgreSQL 17의 독립 연결 12개로 한 계정의 두 분석에서 동시에 조회를 준비했을 때 당시 한도인 6건이 허용되고 6건이 제한됐다. 다른 계정의 한도는 독립적이었고 계정 삭제 뒤에는 횟수 기록도 제거됐다. 서울 개발 DB에서는 사용자·익명 역할의 실행 권한과 광진구 주소 판정을 확인했다. [개발 DB 적용 기록](../infrastructure.md)

11월 22일 서울 개발 DB의 실제 논산 공고 분석에서 탭을 열었을 때 뉴스 요청은 0회였고 버튼을 누르면 1회였다. 해당 환경의 뉴스 표시 권한이 등록되기 전이라 화면은 ‘출처 표시 보류’를 표시했다. 같은 수집본에 대한 다른 계정의 요청은 404였다. 기사 표시 순서, 정상 0건, 불완전한 응답, 한도 초과 및 화면 전환 후 제거는 합성 기사로 검사했다. [화면 검사](../../tests/browser/workspace.test.mjs)

같은 날 애플리케이션 등록과 개발 미리보기 연결 승인을 확인한 뒤, 보호된 Vercel Preview에서 논산 공고 2026000540의 01형 분석을 열었다. 버튼을 누르기 전 뉴스 요청은 0회였고 한 번 눌러 `충청남도 논산시 분양`의 실제 검색결과 3건을 받았다. 화면의 순서·제목·발췌·원문 링크·제공 시각이 응답과 일치했다. 다른 탭에서 뒤로 돌아오면 기사 목록은 비어 있었고 브라우저 저장소에도 기사 텍스트가 남지 않았다. 같은 수집본으로 법령·뉴스를 요청한 다른 계정은 두 요청 모두 404를 받았다. [검수한 화면과 배포 경로](https://github.com/95sionkim/HomeCierge/commit/a80febe2873cf9d5b877ff1aa6a151d4b85101e8)

2026-11-27 10건 단위 쪽 이동과 분당 12회 한도 변경은 오프라인 합성 검사(백엔드·PGlite DB·합성 브라우저)로 `page` 기본값·범위(1~100)·`start` 계산·`lastPage` 상한(100)·`hasNext`·응답 `start` 불일치·부분 응답·분당 12회 허용 및 13번째 거절·끝 쪽 버튼 비활성·저장소 미사용을 확인했다. 원격 DB 마이그레이션 적용과 실제 NAVER API HUB 다중 쪽 실호출 검수는 별도 절차다.
