# 선택한 공고에서 출퇴근 경로를 조회한다

완료된 분석의 **출퇴근 경로**에서 선택한 공고 단지의 출발지 주소와 사용자 지정 목적지 주소(도로명과 건물번호 또는 지번)를 대조해 대중교통·연결 도보·자동차 경로를 조회한다. 출발지 칸에는 공고 번호를 표시하지 않으며, 확인된 단지 주소·공고 공급위치 원문·단지 주소 입력칸만 표시한다.

| 화면에 표시하는 항목 | 조회 기준 | 응답이 부족할 때 |
| --- | --- | --- |
| 출발지 단지 주소 | 청약홈 공고 `HSSPLY_ADRES`(공급위치)에서 단일 지점 주소를 추출하거나 사용자가 직접 입력한 단지 주소 | 자동 추출이 불가하면 공급위치 원문·사유와 입력칸(대표 지번·도로명이 하나 있으면 제안값)을 표시한다. |
| 대중교통 소요시간과 연결 도보 | 브라우저가 ODsay URI(웹) 키로 직접 조회한 도시내 추천 경로의 총시간과 연결 도보 시간·거리. 출발 시각 미지정(Q-47) | 도보 시간이 없으면 거리만 표시할 수 있다. 도시간 터미널까지의 연결이 확인되지 않으면 전체 시간을 보류한다. |
| 자동차 소요시간과 도로 거리 | 서버가 조회한 카카오모빌리티의 현재 출발 추천 경로. 화면에 한국 조회 시각을 표시한다. | 경로 없음, 너무 가까운 지점, 인증 오류, 호출 한도와 일시 오류를 구분한다. |

## 출발지 결정 규칙과 조회 흐름(Q-45·Q-47)

1. **자동 출발지 (`basis: "notice_address"`)**: 공고 공급위치(`HSSPLY_ADRES`)에서 괄호 참고항목(`(동명, 단지명)` 등)을 뗀 뒤, 비교 좌표(Q-39, `scripts/complex_coordinates.py`)와 같은 규칙으로 단일 지점을 가리키는 도로명+건물번호 또는 법정동·읍·면·리+지번이 정확히 하나일 때만 자동 출발지로 확정한다.
2. **보수적 모호 판정**: `일원`, `일대`, `주변`, `부근`, `외 N필지`, `외 필지`, `등 N필지`, `번지 외`, `블록/블럭/BL/구역/공구` 표기가 괄호 밖에 있으면 단일 지점이 아니므로 자동으로 확정하지 않는다(`reason: "ambiguous_area"`).
3. **제안값과 사용자 입력 (`basis: "user_input"`)**: 모호 표기가 있더라도 대표 지번 또는 도로명을 하나로 뽑을 수 있으면(예: `… 28번지 일원` → `… 28`) 입력칸에 **제안값(`suggestion`)으로만** 채우고 확인 문구를 함께 표시한다. 사용자가 제출해야만 사용하며 `basis: "user_input"`으로 구분한다. 자동 출발지가 있어도 화면에서 **출발지 직접 입력**으로 바꿀 수 있다. 사용자 입력 출발지는 DB나 공유 프로필에 저장하지 않고 요청 시점에만 처리한다.
4. **카카오 로컬 구조 비교**: 서버가 출발지·목적지 주소를 카카오 로컬로 확인한다. 결과가 정확히 1건(`total_count === 1`, `is_end === true`, `documents.length === 1`)일 때만 확정한다. 도로명 질의는 `road_address`의 도로명·건물본번·부번(지하 제외)을, 지번 질의는 `address`의 법정동(`region_3depth_name`)·산 여부·본번·부번을 대조하고, 시·도(약칭 정규화)·시·군·구가 질의와 일치하는지 확인한다. 출발지가 확정되어야 목적지를 제공자에게 전송한다.
5. **대중교통 브라우저 직접 조회(Q-47)**: ODsay 서버 플랫폼 키는 등록된 고정 IP(최대 5개)만 허용하는 반면 Vercel Hobby 서버 함수는 송신 IP가 고정되지 않는다. 따라서 서버는 ODsay를 호출하지 않고, `odsay_route` 표시 권한과 `ODSAY_WEB_API_KEY`가 모두 준비된 경우에만 검증된 WGS84 좌표(`origin`, `destination`)와 URI(웹) 키를 POST 응답의 `transitQuery`로 일시 전달하고 `transit.status`를 `"client_query"`로 둔다. 브라우저는 이 값으로 `https://api.odsay.com/v1/api/searchPubTransPathT`를 직접 호출한다. 서버·DB·브라우저 저장소(localStorage 등)에 좌표와 ODsay 결과를 저장하지 않는다(Q-44, ODsay 약관 4.5.10).

## 화면과 API를 연결한다

- **출발지 미리보기** `GET /api/v1/analyses/{analysisId}/snapshots/{snapshotId}/commute`:
  - 로그인 사용자 JWT와 `public.read_analysis_commute_origin(p_analysis_id, p_snapshot_id)`(`VOLATILE`, `authenticated` 전용)로 공고 선택·출처 권한·공급위치를 확인한다. 외부 제공자를 호출하지 않으며 호출 횟수 제한(`private.commute_attempts`)도 늘리지 않는다.
  - 응답 형식(`commute/v1`, `Cache-Control: private, no-store`):
    ```json
    {
      "contractVersion": "commute/v1",
      "analysisId": "…",
      "snapshotId": "…",
      "status": "ready",
      "origin": {
        "noticeAddress": "서울특별시 종로구 합성동 28번지 일원",
        "address": null,
        "basis": null,
        "reason": "ambiguous_area",
        "suggestion": "서울특별시 종로구 합성동 28"
      }
    }
    ```
  - `origin.reason` 값:
    - `ambiguous_area`: `일원`·`블록/BL`·`외 N필지` 등 단일 지점이 아닌 표기
    - `unnumbered`: 건물번호나 지번 없음(지하 표기 포함)
    - `multiple_points`: 도로명·지번 후보가 둘 이상이거나 행정구역 충돌
    - `notice_address_unverified`: 공고 공급위치 필드 미보고·충돌·보류 상태
    - `null`: 출발지가 확정됨
  - 합성 분석(`synthetic_input`), 선택 미확인(`selection_unverified`), 공고 또는 주소 검색 출처 제한(`source_restricted`) 보류 상태는 기존과 같다. 타인·누락 수집본은 404, 미로그인 401, 쿼리·UUID 오류는 400이다.
- **경로 조회** `POST /api/v1/analyses/{analysisId}/snapshots/{snapshotId}/commute`:
  - JSON 본문 `{"destination": "…"}` 또는 `{"destination": "…", "origin": "…"}`를 받는다. `origin`은 선택이며 전달하면 `destination`과 같은 형식 검사(공개 라벨 200자 이하, 단일 번호 주소)를 거쳐 `basis: "user_input"`으로 사용한다. `origin`을 생략하면 자동 출발지를 쓰고, 자동 출발지도 없으면 `status: "origin_unverified"`를 반환한다.
  - `synthetic_input`·`selection_unverified`·`source_restricted` 상태는 사용자 입력 `origin`으로 우회할 수 없다.
  - `public.prepare_analysis_commute(p_analysis_id, p_snapshot_id)`(`VOLATILE`, `authenticated` 전용)가 공고 식별·출처 권한·사용자별 분당 6회 한도를 확인한다. 공급위치 필드가 미보고·충돌이어도 공고 선택이 확인됐다면 `status: "ready"`, `noticeAddress: null`로 넘겨 사용자 입력 출발지 경로를 허용한다.
  - 응답(`commute/v1`, `Cache-Control: private, no-store`)은 `status`, `originAddress`, `origin`, `transit`, `transitQuery`, `driving`을 포함한다. `originAddress`는 `origin.address`와 같은 값을 유지한다.
  - `transit`·`transitQuery` 상태:
    - 출발지·목적지가 모두 확정되고 `odsay_route` 표시 권한과 `ODSAY_WEB_API_KEY`가 있으면 `transit.status`는 `"client_query"`, `transitQuery`는 아래와 같다:
      ```json
      {
        "provider": "odsay_route",
        "origin": { "x": "127.10", "y": "37.4" },
        "destination": { "x": "127.11", "y": "37.5" },
        "apiKey": "…"
      }
      ```
    - `ODSAY_WEB_API_KEY`가 없으면 `transit.status: "not_configured"`, `transitQuery: null`.
    - `odsay_route` 표시 권한이 없으면 `transit.status: "source_restricted"`, `transitQuery: null`.
    - 출발지·목적지 미확인, 보류, 지오코더 오류에서는 `transitQuery: null`.
  - 브라우저는 `transitQuery`를 받았을 때만 `GET https://api.odsay.com/v1/api/searchPubTransPathT?SX=…&SY=…&EX=…&EY=…&OPT=0&apiKey=<encodeURIComponent>`를 호출한다(`credentials: 'omit'`, `cache: 'no-store'`, `redirect: 'error'`, `referrerPolicy: 'strict-origin-when-cross-origin'`, 5초 제한, 응답 크기 1 MiB 상한). 오류 코드 해석은 `-98` → `points_too_close`, `-99` → `no_route`, `500`+인증 문구 또는 `ApiKeyAuthFailed`·HTTP 401/403 → `provider_denied`, `searchType` 1·2 → `connections_unverified`, HTTP 429 → `rate_limited`, 그 외·시간 초과·형식 이상 → `provider_unavailable`이다. 화면에는 `powered by www.ODsay.com` 출처 표기를 유지한다.
  - 타인·누락 수집본은 404, 입력 형식 오류는 400, 지원하지 않는 메서드는 405(`Allow: GET, POST, OPTIONS`), 분당 6회 초과는 429와 `Retry-After: 60`으로 응답한다.
- **공유 목적지 확인**: `confirm_commute_destination`은 소유자·프로필 버전·변경값을 받아 승인과 저장을 한 번에 처리한다. **공유 목적지로 저장**과 **공유 목적지 해제**는 사용자가 현재 값·변경 값을 확인하고 승인했을 때만 프로필에 반영한다.

## ODsay URI(웹) 키 등록

1. ODsay LAB 콘솔에서 애플리케이션의 **URI(웹)** 플랫폼에 서비스 출처 주소를 등록한다(최대 5개, 예: 개발·미리보기·운영 도메인).
2. 발급된 URI(웹) 플랫폼 키를 서버 환경변수 `ODSAY_WEB_API_KEY`에 설정한다(로컬 `.secrets/backend.env` 또는 Vercel Preview·Production 서버 환경). 키가 URL 인코딩된 형태로 복사돼도 서버가 한 번 정규화해 전달하고 브라우저가 `encodeURIComponent`로 전송한다.
3. 기존 서버 플랫폼 키 `ODSAY_API_KEY`는 출퇴근 API 서버에서 사용하지 않는다.

## 검수 범위

2026-11-22 개발 기기에서 서울시청과 강남구청의 공개 주소를 조회해 카카오 주소 일치와 자동차 시간·거리 응답을 확인했다. 같은 요청에서 ODsay 서버 키는 인증 오류를 반환했다. 출발지 추출·미리보기·사용자 입력 출발지·카카오 구조 비교·`client_query`/`transitQuery` 위임·브라우저 ODsay 직접 조회와 상태 해석·좌표 미저장·타 계정 접근·공유 목적지 저장과 취소는 합성 단위·DB(PGlite)·브라우저 검사로 검증하며, Python `complex_coordinates.py`와 TypeScript 추출 규칙의 일치는 공유 합성 사례표(`tests/fixtures/commute-origin-cases.json`)로 함께 확인한다. 이번 변경(Q-45·Q-47)에 대한 실제 카카오·ODsay URI(웹) 키 실호출 검수는 별도 단계다. [카카오 로컬 주소 검색](https://developers.kakao.com/docs/ko/local/dev-guide) · [카카오모빌리티 자동차 길찾기](https://developers.kakaomobility.com/guide/navi-api/directions.html) · [ODsay 경로 문서](https://lab.odsay.com/guide/releaseReference) · [ODsay 플랫폼·상표 가이드](https://lab.odsay.com/guide/guide?platform=web) · [ODsay 플랫폼별 인증 안내](https://lab.odsay.com/community/boardView?seq=597)

2026-11-22 보호된 개발 미리보기에서 시흥 공고 `2026910268`의 실제 청약홈 소재지와 서울시청 공개 주소를 연결했다. 소유자 세션의 HTTP 응답은 200이었고 자동차 시간·도로 거리를 받았다. 같은 분석을 다른 계정에서 조회하면 404였다. 경로 조회만 한 시점에는 공유 목적지가 비어 있었고, 소유자가 확인한 저장과 해제만 프로필에 반영됐다. 시험 계정과 수집본을 정리했다. [검수한 구현](https://github.com/95sionkim/HomeCierge/commit/c86b0a8e72ca0b09a1185d073891c0a4537bb9a3)
