# 주변 실거래의 단지·공급면적 근거와 대표 좌표를 자동으로 확보한다

2026-11-26 사용자 결정 Q-38·Q-39·Q-41을 공고 실행(`kind = "notice"`)과 업로드 보완 실행(`kind = "upload_supplement"`)의 작업자 수집 경로에 연결한 계약이다. [PRD §7.2.3](../prd/01-product-prd.md#723-후보를-선정하고-대상-단지-자체-거래를-구분한다) · [결정 기록](../prd/02-decision-log.md) · [비교 결과 계약](comparison-v1.md)

**이 문서는 구현 계약과 합성 오프라인 검수 범위를 기록한다.** 실제 외부 API를 호출하는 실자료 정확도·연결 가능률 검증과 PRD 수락 기준(A-06~A-57) 통과는 별도 수동 검수 단계다.

## 1. 처리 순서와 지역 경계

공고 수집본(`ingestion/v0`)에서 대상 주택형의 공급면적이 원문 대조까지 확정(`checkedSupplyArea.status = "confirmed"`)되었고 기존 등록 근거가 없으면, 작업자는 비교 계산 직전에 자동 근거를 구성한다. 대상 주택형 공급면적이 미확정이면 불필요한 외부 근거 조회를 수행하지 않고 기존 보류 흐름을 유지한다.

1. **출처 권한 조회**: `read_auto_evidence_permissions`로 `public.source_registry`의 현재 허용 상태(`applyhomeApt`, `applyhomeRemainder`, `moisRegions`, `kakaoRuntime`, `kakaoStorage`)를 읽기 전용으로 확인한다. 레지스트리 값은 변경하지 않는다.
2. **공유 캐시 우선 조회**: `read_auto_evidence_cache`로 유효 기한이 남아 있고 출처 권한을 통과한 시·군·구 법정동 사전과 단지·좌표 캐시를 먼저 읽는다. 법정동 사전이 캐시에 없을 때만 행정안전부 법정동코드 전체자료(ZIP/TSV)를 적재한다.
3. **우선 지역 거래 묶기**: 공식 법정동코드로 대상 공고가 속한 같은 법정동·읍·면 거래만 먼저 묶는다. 아파트 매매(`apt_trade`)는 `aptSeq` 기준으로 묶고 같은 `aptSeq` 안의 법정동·단지명·지번·도로명 충돌은 `complex_identifier_conflict`로 보류한다. `aptSeq`가 없는 분양권·입주권(`apt_rights`)은 검증된 법정동·지번·단지명이 일치하는 매매 단지에 합쳐 고유 단지로 집계하거나 별도 권리 그룹으로 묶는다.
4. **청약홈 공고·주택형 대조(Q-38)**: 단지별로 청약홈 APT 분양정보(`applyhome_apt`)와 무순위·잔여세대(`applyhome_remainder`)에서 도로명+건물번호, 법정동+지번, 단지명 순으로 후보 공고를 조회한다. **단지명 검색은 후보 탐색에만 사용하며**, 공고의 공급위치(`HSSPLY_ADRES`)가 행정안전부 법정동코드 기준 같은 시·군·구·법정동에 속하고 단지의 도로명+건물번호 또는 법정동+지번(본번·부번)과 정규화 일치할 때만 같은 단지로 인정한다(A-08).
5. **확대 지역 조건부 조회**: 모든 월·출처 수집이 완전하고(`complete`/`empty`), 지역 미배정 행이 없고, 우선 지역의 주변 보류가 0건이며 ±5% 범위 안 주변 후보가 0개일 때만 확대 지역(구가 있으면 같은 구, 없으면 같은 시·군)의 거래 근거를 추가 조회한다(A-05·A-06·A-55).
6. **대표 좌표 확인(Q-39)**: ±5% 범위 안에 들어온 비교 후보가 1개 이상일 때 대상 공고 소재지와 후보 단지의 도로명주소를 카카오 로컬 주소 검색으로 확인한다.
7. **원자 저장과 재계산 재사용**: `finish_notice_with_evidence`가 수집본, `comparison-evidence/v1`, 근거 메타데이터(`comparison-evidence-meta/v1`), 비교 결과(`comparison/v1`), 납부 일정을 한 트랜잭션에 저장하고 `comparison_evidence_pinned = true`로 고정한다. 이후 같은 수집본의 기간·조건 변경 재계산(`kind = "snapshot"`)은 외부 API를 다시 호출하지 않고 저장된 `comparison_evidence`를 재사용한다.

## 2. 공급면적 대응 규칙과 보류 사유(Q-38)

구현: [complex_evidence.py](../../scripts/complex_evidence.py)

인정된 모든 공고의 주택형 API(`applyhome_apt_model`, `applyhome_remainder_model`)에서 `HOUSE_TY`(예: `084.7450D` → `84.7450`)와 `SUPLY_AR`를 십진수(`Decimal`)로 읽는다. 전용면적 반올림·근사 매칭(±1㎡ 등)은 사용하지 않는다.

- 거래의 전용면적과 **십진수로 정확히 같은** 주택형이 공고 안에서 하나뿐이고, 확인한 모든 공고에서 같은 주택형·같은 공급면적(`SUPLY_AR`)을 보고할 때만 공급면적 대응을 `confirmed`로 확정한다.
- 확정된 거래 행의 `tradeLinks[].evidence`에는 대조한 모든 공고 번호쌍(`HOUSE_MANAGE_NO/PBLANC_NO`), 주택형, 출처 API, 관측 시각이 남는다.
- 대상 단지 자체 거래도 같은 Q-38 규칙을 적용하며, 주변 비교 단지 수와 우선 지역 정상 0개 판정에서 분리해 `targetReferences`로 보낸다.

| 근거 보류 사유 코드(`metadata.complexes[].reasonCode`) | 의미 | `comparison/v1` 결과에서의 처리 |
| --- | --- | --- |
| `notice_not_found` | 청약홈 APT·잔여세대 조회에서 해당 단지의 후보 공고를 찾지 못함 | `trade_supply_area_unverified` 보류 (정상 0개 아님) |
| `complex_identity_mismatch` | 이름 등 후보 공고는 있으나 시·군·구·법정동·지번·도로명이 일치하지 않음 | `trade_supply_area_unverified` 보류 (이름만으로 연결 금지) |
| `housing_type_not_found` | 공고는 일치하지만 거래 전용면적과 십진수로 정확히 같은 주택형이 없음 | `trade_supply_area_unverified` 보류 |
| `multiple_housing_types` | 같은 전용면적에 서로 다른 주택형이 2개 이상 존재함 | `trade_supply_area_unverified` 보류 |
| `supply_area_mismatch_across_notices` | 같은 단지의 여러 공고에서 해당 주택형의 공급면적이 서로 다름 | `trade_supply_area_unverified` 보류 |
| `complex_identifier_conflict` | 같은 `aptSeq` 안의 주소·단지명 충돌 또는 서로 다른 `aptSeq`의 주소 충돌 | `trade_link_conflict` 보류 |
| `lookup_failed` | 청약홈 조회 실패·부분 응답·주택형 문자열/공급면적 파싱 실패 | `trade_supply_area_unverified` 보류 · 확대 중단 |
| `lookup_budget_exceeded` | 실행당 청약홈 호출 상한 도달 | `trade_supply_area_unverified` 보류 · 확대 중단 |

청약홈 공고가 존재하지 않는 구축 단지 등의 다른 공식 공급면적 경로는 D-01 미정 사항으로 남기며, 공고 부재를 정상 0개나 면적 범위 밖으로 분류하지 않는다. [구의동 보류 검산](be-06-area-case.md)

## 3. 단지 대표 좌표와 출처 권한(Q-39)

구현: [complex_coordinates.py](../../scripts/complex_coordinates.py)

- 대상 공고 소재지와 ±5% 범위 안 비교 후보 단지의 도로명주소(`시·군·구 + 도로명 + 건물번호`)를 `https://dapi.kakao.com/v2/local/search/address.json`에 `analyze_type=exact`, `size=2`로 조회한다.
- 응답의 `meta.total_count == 1`, `meta.is_end == true`, `documents.length == 1`이고 `address.b_code`가 공식 법정동코드와 일치하며 `road_address`의 도로명·건물본번·부번(지하 주소 제외)이 일치할 때만 WGS84 좌표를 확정한다.
- 공고 주소가 `일원`, `일대`, `S6블록`, `외 N필지`처럼 여러 지점을 가리키면 호출하지 않고 `address_ambiguous_area` 미확인으로 둔다.
- `KAKAO_REST_API_KEY`가 없으면 실행 오류가 아니라 `kakao_key_missing` 좌표 미확인으로 둔다. 미확인 거리는 0으로 채우지 않으며, 면적 차이가 같은 두 단지의 순위를 거리가 정해야 하면 `compare_trades.py`가 `straight_line_distance_unverified` 보류와 `rankingComplete = false`를 반환한다.

| `source_registry`의 `kakao_address` 상태 | 실행 중 거리 계산 | 공유 캐시(`complex_evidence_cache`) 및 `comparison_evidence` 저장 |
| --- | --- | --- |
| `display_permission = 'allowed'`, `storage/reuse != 'allowed'` (기본 보수 상태) | 실행 메모리 안에서만 좌표를 사용해 직선거리(출처·조회 시각 포함)를 `comparison/v1`에 기록 | 원좌표(위·경도)를 저장하지 않음(`strip_kakao_coordinates`), 캐시 저장은 DB가 `42501`로 차단 |
| `storage = reuse = display = 'allowed'` (별도 약관 확인·승인 후) | 실행 중 거리 계산 | `comparison_evidence`와 공유 캐시(`kakao_road_coordinate`, 관측 시각·만료 기한 포함)에 저장·재사용 |
| `display_permission != 'allowed'` | 조회하지 않음(`coordinate_source_restricted`) | 저장하지 않음 |

> **재계산 시 주의**: `kakao_address`의 저장·재사용이 허용되지 않은 상태에서는 `private.comparison_evidence`에 원좌표가 남지 않는다. 따라서 같은 수집본으로 조건 변경 재계산(`kind = "snapshot"`)을 수행할 때 외부 API를 다시 호출하지 않으므로, 면적 차이가 같은 단지의 거리 순위는 `straight_line_distance_unverified`(`rankingComplete = false`)로 보류된다. 2026-11-27 카카오 개발자 운영정책(2026-04-20 시행) 제5조 제20호·제30호를 확인해 좌표를 저장·재사용하지 않기로 했다(Q-44, D-07 일부 결정). 그래서 `kakao_address`의 저장·재사용 권한은 바꾸지 않는다. [출처별 약관 검토](be-01-evidence.md#5-v4--출처별-이용-조건) · [데이터 관리](../data-handling.md)

## 4. 호출 상한·공유 캐시·DB 계약

마이그레이션: [20261126150000_auto_comparison_evidence.sql](../../supabase/migrations/20261126150000_auto_comparison_evidence.sql)

- **기본 호출 상한**: 공고 실행당 청약홈 근거 조회 최대 120회(`evidenceApplyhomeRequests`, 요청당 최대 5페이지), 카카오 로컬 주소 검색 최대 30회(`evidenceKakaoRequests`). 상한 도달 시 실행을 실패시키지 않고 미확인 단지를 보류(`lookup_budget_exceeded`·`coordinate_budget_exceeded`)하며, 실제 호출 수·캐시 적중 수·상한 도달 여부는 `private.comparison_evidence.metadata`(`comparison-evidence-meta/v1`)에 기록한다.
- **공유 캐시 테이블**: `private.legal_region_locality_cache`(행안부 법정동 사전, 기본 TTL 30일)와 `private.complex_evidence_cache`(단지별 `applyhome_supply_area`·허용 시 `kakao_road_coordinate`, 기본 TTL 7일, 최대 90일 제한). 두 테이블 모두 `user_id`·`analysis_id` 등 사용자 식별자를 두지 않고 RLS를 활성화하며 `service_role` 전용 RPC(`read_auto_evidence_cache`, `upsert_auto_evidence_cache`)로만 접근한다. 조회·저장 시마다 `source_registry`의 저장·재사용·표시 허용과 만료 기한(`expires_at > now()`)을 다시 검사하며 원문 페이로드 키는 차단한다.
- **원자 저장과 삭제 연쇄**: `finish_notice_with_evidence`는 수집본·`comparison_evidence`·`comparison_results`·납부 일정을 한 트랜잭션에 기록한다. 사용자가 업로드 보완 파일 1건을 삭제하면(A-56) 파생 스냅샷·비교 근거·비교 결과는 외래 키로 연쇄 삭제되지만, 사용자 식별자가 없는 공유 캐시는 영향받지 않는다.

## 5. 수동 실검수 도구 (기본 검사에서 실행하지 않음)

실제 공공데이터·카카오 API를 호출하는 수동 검수 도구로 [verify_auto_evidence.py](../../scripts/verify_auto_evidence.py)를 제공한다. 기본 테스트와 CI에서는 실행하지 않으며, 총괄이 사용자 승인과 이용 조건·호출 상한을 확인한 뒤 수동 실행한다.

```sh
# 과천 갈현동 사례 공고(2024930022, 모집공고일 2024-04-18, 지역코드 41290) 수동 실검수 예시
python3 scripts/verify_auto_evidence.py --live \
  --max-applyhome-calls 40 \
  --max-kakao-calls 15
```

- **필수 환경변수**: `DATA_GO_KR_SERVICE_KEY` (청약홈·실거래 API).
- **선택 환경변수**: `KAKAO_REST_API_KEY` (없으면 좌표 미확인 상태로 검수 요약만 출력).
- **호출 상한**: 기본 청약홈 40회(허용 범위 1~120), 카카오 15회(허용 범위 0~30). `--live` 없이는 외부 요청을 보내지 않는다.
- **출력 정제**: 응답 원문, API 키, 인증 헤더, 원좌표(위·경도)를 출력하지 않고 호출 수, 단지별 Q-38/Q-39 상태·사유 코드, 비교 통계 요약(`auto-evidence-verification/v1`)만 JSON으로 출력한다.
- 공식 공고 PDF 대조까지 포함할 때는 `--allow-official-pdf`, 미리 내려받은 행안부 법정동 파일을 쓸 때는 `--region-codes-file`과 `--region-codes-sha256`을 지정한다.

### 과천 갈현동 실검수 (2026-11-27)

사용자 승인을 받아 총괄이 개발 Mac에서 `--live --allow-official-pdf --max-applyhome-calls 40 --max-kakao-calls 15`로 한 번 실행했다(PDF 대조 없이 먼저 한 번 실행했을 때는 대상 공급면적이 확인되지 않아 비교가 `unavailable`이었다). 대상은 과천 르센토 데시앙 84B(공고 `2024930022`), 기준일 2026-11-27, 계약일 2025-11-28~2026-11-27이다. 응답 원문·키·원좌표는 저장하지 않았다.

| 항목 | 결과 |
| --- | --- |
| 호출 | 청약홈 40회(상한 도달), 카카오 3회, 행안부 법정동 자료 1회 |
| 우선 지역 판정 | 갈현동 `4129010300`, 매매 후보 확인(`candidates_found`), 분양권·입주권 정상 0개, 확대 없음 |
| Q-38 자동 대응 | 단지 2곳에서 공급면적 확인. `41290-455`(과천 푸르지오 라비엔오)의 전용 84.745㎡ → 공급 110.3239㎡는 공고 `2022930014`·`2023930016`에서 같은 값이며 2026-11-22 수작업 검산값과 같다 |
| 비교 단지 | `41290-480` 공급 109.6339㎡(차이 0.1763㎡, 직선 275.0m), 매매 4건 최저 19억·중위 19억·최고 19억 1천만 원 / `41290-455` 공급 110.3239㎡(차이 0.5137㎡, 직선 285.4m), 매매 4건 최저 20억 5천만·중위 20억 7천만·최고 21억 원 |
| 남은 보류 | 공급면적 미확인 거래 12건(공고 없음·주택형 없음), 호출 상한으로 보류한 단지 1곳. 그래서 결과는 `partial`이고 순위는 미완료(통계는 잠정)다 |
| 좌표 | 대상과 두 비교 단지 좌표 확인(카카오 3회). 운영정책에 따라 저장하지 않았다(Q-44) |

이전 수작업 검산은 같은 동 매매 25건 중 1건만 연결했다. 이번 자동 실행은 두 단지 8건을 연결했다. 두 단지의 거래별 가격·건수는 원문과 따로 수작업 대조하지 않았으며, 한 사례의 결과로 다른 지역의 연결률을 일반화하지 않는다.

## 6. 오프라인 합성 검수 범위

네트워크와 인증값 없이 아래 합성 검사를 제공한다. 실제 API 응답 원문은 저장소에 넣지 않는다.

- 합성 픽스처: [auto-evidence-gwacheon-synthetic.json](../../tests/fixtures/auto-evidence-gwacheon-synthetic.json) (과천 갈현동 84D 전용 84.7450㎡ → 공급 110.3239㎡ 3개 공고 일치 사례를 본뜬 합성 자료)
- Python 단위·작업자 검사: [test_auto_evidence.py](../../scripts/test_auto_evidence.py) (Q-38 전 분기, Q-39 전 분기, A-05·A-06·A-08·A-21·A-22·A-23·A-53·A-55 경계, 행안부 ZIP/CP949 적재, RTMS 공백 필드, 권리 거래 합산, 호출 상한·캐시 적중, 공고·업로드 보완·스냅샷 재계산, 작업자 선택 카카오 키, 수동 CLI 가드)
- DB(PGlite) 권한·캐시·원자 저장·A-56 연쇄 삭제 검사: [auto-comparison-evidence.test.mjs](../../tests/database/auto-comparison-evidence.test.mjs)
