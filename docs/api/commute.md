# 선택한 공고에서 출퇴근 경로를 조회한다

완료된 분석의 **출퇴근 경로**에서 목적지의 도로명·건물번호 또는 지번을 입력한다. 출발지는 해당 분석의 청약홈 공고에서 확인한 소재지다. 공고 주소가 ‘일원’처럼 여러 지점을 가리키거나 주소 검색 결과가 하나로 확인되지 않으면 출발지 확인을 요청한다.

| 화면에 표시하는 항목 | 조회 기준 | 응답이 부족할 때 |
| --- | --- | --- |
| 대중교통 소요시간과 연결 도보 | ODsay 도시내 추천 경로의 총시간과 연결 도보 시간·거리. 출발 시각 미지정 | 도보 시간이 없으면 거리만 표시할 수 있다. 도시간 터미널까지의 연결이 확인되지 않으면 전체 시간을 보류한다. |
| 자동차 소요시간과 도로 거리 | 카카오모빌리티의 현재 출발 추천 경로. 화면에 한국 조회 시각을 표시한다. | 경로 없음, 너무 가까운 지점, 인증 오류, 호출 한도와 일시 오류를 구분한다. |

목적지 입력 후 **경로 조회**를 누르면 카카오 로컬에 두 주소를 보내고, 출발지와 목적지를 각각 확인한 뒤 이용이 허용된 교통 제공자에 좌표를 보낸다. 출발지를 확인하지 못하면 목적지 전송을 중단한다. 각 수단은 독립적으로 응답한다. **공유 목적지로 저장**과 **공유 목적지 해제**는 현재 값·변경 값을 확인하고 승인했을 때만 프로필에 반영한다.

## 화면과 API를 연결한다

- `POST /api/v1/analyses/{analysisId}/snapshots/{snapshotId}/commute`는 사용자 인증과 JSON 본문 `{"destination":"서울특별시 중구 세종대로 110"}`을 받는다. 타인·누락 수집본은 404, 입력 오류는 400, 사용자별 분당 6회 초과는 429와 `Retry-After`로 응답한다.
- `commute/v1`은 `status`, `originAddress`, `transit`, `driving`을 제공한다. 수단마다 `status`, `source`, `queriedAt`, `durationSeconds`, `distanceMeters`, `walkMinutes`, `walkMeters`, `kind`가 있다. 미제공 수치는 `null`이다. 합성 분석은 `synthetic_input`으로 종료한다. 비로그인 예시 화면은 고정된 합성 시간을 표시한다.
- 사용자 JWT로 `prepare_analysis_commute`가 공고 식별·수집 완전성·출처 권한을 확인한다. `confirm_commute_destination`은 소유자·프로필 버전·변경값을 받아 승인과 저장을 한 번에 처리한다. 프로필 버전 충돌 시 최신 값을 다시 읽는다.
- 개발 미리보기는 카카오 로컬·자동차와 ODsay의 등록된 서버 환경변수를 사용한다. 이동 자료는 요청 중에만 처리하고 HTTP 응답은 `private, no-store`다. DB에 남는 조회 기록은 분당 호출 횟수다. 운영 호출량·비용 및 장기 보관은 D-07에서 다룬다.

## 검수 범위

2026-11-22 개발 기기에서 서울시청과 강남구청의 공개 주소를 조회해 카카오 주소 일치와 자동차 시간·거리 응답을 확인했다. 같은 요청에서 ODsay는 인증 오류를 반환했다. 대중교통 정상 경로, 도보 시간 미제공, 수단별 오류, 타 계정 접근과 공유 목적지 저장·취소는 합성 검사로 재현한다. [카카오 로컬 주소 검색](https://developers.kakao.com/docs/ko/local/dev-guide) · [카카오모빌리티 자동차 길찾기](https://developers.kakaomobility.com/guide/navi-api/directions.html) · [ODsay 경로 문서](https://lab.odsay.com/guide/releaseReference) · [ODsay 플랫폼·상표 가이드](https://lab.odsay.com/guide/guide?platform=web)
