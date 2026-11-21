# 분석 결과 계약 v0 (BE-01)

2026-11-21. 화면팀·QA·후속 백엔드 작업이 같은 의미로 읽을 **분석 결과 응답의 기술 계약 v0**이다. 상태는 설계 제안(P)이다. 제품 구현, 수락 기준(A) 통과, 미정 결정(D)의 확정을 뜻하지 않는다. 제품 기준은 [PRD v1.1](../prd/01-product-prd.md)이고 단계 계획은 [전체 개발 계획](../development-plan.md) §3·5·8을 따른다.

- **기계 판독 기준은 하나다.** [JSON 스키마(draft-07)](analysis-result-v0.schema.json)가 필드·값·불변 조건의 기준이다. 이 문서는 의미와, 스키마로 검사할 수 없는 조건(§10)을 적는다. 둘이 다르면 스키마를 고치고 이 문서를 맞춘다.
- **합성 예시**: [analysis-result-v0.json](../../tests/fixtures/analysis-result-v0.json)의 `normalZero`·`partialCollection`·`upstreamFailure`는 같은 요청의 세 결과이며 각각 루트 스키마를 따른다. 모든 값은 합성 자료다(`dataOrigin: "synthetic"`).
- **실행 상태와 비교 결과를 읽는다.** 실행 주소의 GET은 진행 상태와 수집본 ID를 반환한다. 같은 주소의 `/result`에서 해당 실행이 저장한 가격·단지별 통계·근거를 읽는다. 이 문서의 v0 스키마는 기존 화면용 합성 예시에 적용한다. [비교 결과 v1](comparison-v1.md) · [분석 실행 계약](analysis-runs.md)
- **v0에 넣지 않은 것**: 비교표(선정 단지·순위·직선거리·가격 통계·거래 원장), 분석 접수·취소 요청, 작업 재시도·임대 세부, 대상 단지 자체 거래 표시. 비교 결과는 BE-05, 실행 접수·재시도는 BE-04 실행 계약을 따른다.

## 1. 기존 API와의 호환을 확인한다

기존 세 GET 경로와 오류 형식은 바꾸지 않는다. 아래는 [handler.ts](../../src/server/handler.ts)와 [로컬 실행기](../../dev/server.ts)의 실제 동작이다.

| 요청을 보낸다 | 성공 응답을 확인한다 |
| --- | --- |
| `GET /api/health` | 200 `{ "status": "ok", "service": "homecierge-api", "version": "0.1.0" }`. 인증·DB 연결을 확인하지 않음 |
| `GET /api/ready` | 200 `{ "status": "ready", "database": "reachable" }`. 사용자 권한으로 프로필 조회 성공 |
| `GET /api/v1/me` | 200 `{ "user": { "id" }, "profile" }`. 최초에는 `profile: null` 가능 |

위 세 GET의 처리기 응답에 `Cache-Control: no-store`, `Vary: Origin`, `X-Content-Type-Options: nosniff`, `X-Request-Id`가 붙는다. 허용 origin이면 그 값과 `Access-Control-Allow-Methods: GET, OPTIONS`, `Access-Control-Allow-Headers: Authorization, Content-Type`을 반환하고, `OPTIONS`는 204다. 검사 순서는 origin → `OPTIONS` → 메서드 → 경로 → Bearer 형식 → 설정 → 사용자·DB 조회다.

| HTTP | `error` | 발생 조건 |
| --- | --- | --- |
| 403 | `origin_not_allowed` | `Origin`이 `ALLOWED_ORIGINS`에 없음. 경로·메서드보다 먼저 검사 |
| 405 | `method_not_allowed` | GET·OPTIONS 외 메서드. `Allow: GET, OPTIONS` |
| 404 | `not_found` | 등록되지 않은 경로. 계획 단계 경로도 현재 여기에 해당 |
| 401 | `authentication_required` | Bearer 헤더 없음·형식 오류, 사용자 확인 실패, 익명 사용자 |
| 503 | `configuration_unavailable` | 설정 누락·형식 오류(URL·publishable key·`APP_ENV`), Production 배포에 개발 설정 사용 |
| 503 | `backend_unavailable` | Auth·DB 조회 예외. 원문은 응답·로그에 남기지 않음 |
| 500 | `internal_error` | 로컬 실행기 `dev/server.ts`의 예외에서만. 본문에 `requestId`가 없고 `X-Request-Id`도 없음 |

기존 조회 오류 본문 `{ "error": "<코드>", "requestId": "<UUID v4>" }`은 스키마의 `definitions/httpErrorResponse`에 정의했다. BE-04의 실행 API도 같은 구조를 쓰며 접수·취소에 쓰는 세부 오류와 HTTP 상태는 [실행 계약](analysis-runs.md)을 따른다. 없는 실행과 다른 계정의 실행을 구분하지 않는다. 분석 안의 외부 조회 오류는 HTTP 오류가 아니라 200 본문의 `collections[].error`(`upstream_*`)이고, 실행 자체의 실패는 `run.error`(`run_*`)다. 접두어로 기존 코드와 겹치지 않게 했다. `health`·`ready`의 최상위 `status`와 이 계약의 `run.status`는 서로 다른 값이다.

BE-04의 `analyses.status`는 가장 최근에 접수한 실행을 요약하며, 수집 입력 준비가 끝나면 `input_ready`가 된다. 기존 실행 이전의 분석 상태와 이 문서의 비교 결과 완전성은 각각 보존한다. [실행 상태 대응](analysis-runs.md) `private.ingestion_runs.status`의 `complete`는 건수 정합성이지 정상 0개 판정이 아니다. `housing_types.supply_area_status`의 `unknown/verified/conflict`는 이 계약의 `unverified/confirmed/conflict`에 대응시키는 것을 제안한다.

## 2. 응답의 구성을 읽는다

| 최상위 필드 | 의미 |
| --- | --- |
| `contractVersion` | 항상 `"analysis-result/v0"`. 필드가 바뀌면 버전을 올린다 |
| `dataOrigin` | `synthetic`(합성·모의 응답) 또는 `collected`(실제 수집 자료로 산출) |
| `run` | 실행 상태 축: `runId`, `analysisId`(UUID), `status`, `requestedAt`, `finishedAt`, `error` |
| `input` | 실행 시작 때 고정한 분석 범위와 입력 사실의 검증 상태 |
| `result` | 결과 완전성 축: `completeness`, `regionScopes`, `items`, `collections` |

스키마는 모든 객체 정의에 `additionalProperties: false`를 적용한다. 생산자(API·모의 서버)는 v0에 정의된 필드만 보내고, 소비자는 실행 시 알 수 없는 필드를 무시하도록 만든다.

## 3. 실행 상태와 결과 완전성을 분리한다

| `run.status` | 의미 | 결과 |
| --- | --- | --- |
| `queued`, `running`, `retry_wait` | 대기·진행·재시도 대기 | `not_produced`. `finishedAt: null` |
| `finished` | 실행 절차가 끝남. **성공을 뜻하지 않는다** | `complete`·`partial`·`unavailable` 중 하나 |
| `failed` | 실행 자체가 실패(`run.error.code`: `run_internal_error`, `run_deadline_exceeded`) | `not_produced` |
| `cancelled` | 사용자 실행 취소 | `not_produced` |

| `result.completeness` | 의미 | 스키마가 강제하는 조건 |
| --- | --- | --- |
| `complete` | 결론을 바꿀 보류가 없다. 정상 0개도 근거가 완전하면 complete | 모든 항목이 `confirmed`·`normal_zero`, 모든 수집 기록이 `complete`·`empty`, 적용 범위 결론이 `held`가 아님, 미해결 후보 0 |
| `partial` | 보류가 남았지만 우선 지역의 판별이 시작돼 독립적으로 확인된 내용이 있다 | 미해결 항목 1개 이상, 우선 지역 판별이 `complete`·`incomplete` |
| `unavailable` | 확인된 판별 내용이 없어 비교 결과를 제공할 수 없다 | 모든 항목이 미해결 상태이고 1개 이상 존재. 우선 지역 `held`, 판별 `not_started`, 확대 없음 |
| `not_produced` | 결과를 산출하지 않았다 | `regionScopes`·`items`·`collections`가 모두 `null` |

산출 전에는 빈 배열 대신 `null`을 쓴다. 빈 목록이 정상 0개·보류·조회 실패와 섞이지 않게 하려는 것이다. 산출된 결과에서도 항목 목록이 비는 일은 없고(`items` 1개 이상), 정상 0개 여부는 목록 길이가 아니라 `regionScopes.*.conclusion`으로 읽는다. 실행 실패·취소 때 이미 모은 중간 결과를 보여줄지는 v0에서 정하지 않았다.

```json
{
  "run": { "runId": "syn-run-queued", "analysisId": "00000000-0000-4000-8000-00000000a001", "status": "queued", "requestedAt": "2026-11-10T10:00:00+09:00", "finishedAt": null, "error": null },
  "result": { "completeness": "not_produced", "regionScopes": null, "items": null, "collections": null }
}
```

위는 산출 전 응답의 `run`·`result` 부분이다. `contractVersion`·`dataOrigin`·`input`은 합성 예시와 같다.

## 4. 입력 사실과 그 상태를 고정한다

| `input` 필드 | 표현과 조건 |
| --- | --- |
| `rulesVersion`, `basisDate` | 적용 규칙 버전 문자열, 조회일(날짜) |
| `notice`, `housingType` | 공고·주택형 UUID와 표시 이름. 같은 이름으로 다른 회차를 연결하지 않는다 |
| `housingType.supplyArea` | `{ status, area, evidenceRefs }`. `confirmed`이면 공급면적과 근거 1개 이상, 아니면 `area: null`. `conflict`이면 근거 2개 이상 |
| `housingType.exclusiveArea` | 전용면적 또는 `null`. 표시용이며 비교 범위·판정에 사용하지 않는다 |
| `tradeKinds` | `sale`(매매)·`presale_right`(분양권)·`occupancy_right`(입주권) 중 분석에 포함한 종류 |
| `contractDateRange` | `{ source, start, end }`, 양 끝 포함. `default_recent_year` 또는 `user_confirmed` |
| `supplyAreaRange` | 공급면적이 확인된 경우에만 객체. `{ source, lowerRatio, upperRatio, min, max }`, 양 끝 포함 |
| `regions.priority`, `regions.expansion` | `{ status, id, level, name, evidenceRefs }`. 미확인이면 식별값을 `null`로 둘 수 있다 |

**기간**: 기본은 조회일까지 최근 1년이다. PRD 예시대로 조회일이 2026-11-10이면 2025-11-11~2026-11-10이다. 다른 기간은 사용자가 확인한 경우에만 `user_confirmed`로 쓴다. 합성 예시는 수집 기록을 줄이기 위해 사용자 확인 기간 2026-10-01~2026-10-31을 사용하며, 기본 기간의 예시가 아니다. 윤일·시간대 경계는 D-02에서 정한다.

**면적 범위**: `default`는 확정된 공급면적 ±5%이며 스키마가 `lowerRatio: "0.95"`, `upperRatio: "1.05"`를 강제한다. 예시의 S = 112.40㎡이면 106.78~118.02㎡이고 경계값을 포함한다. 다른 비율은 사용자가 확인한 분석에만 `user_confirmed`로 적용한다.

**지역**: 우선 지역 `level`은 `legal_dong`·`eup`·`myeon`, 확대 지역은 구가 있으면 `gu`, 없으면 `si_gun`이다. `id`는 불투명 식별자이며 코드 길이·체계를 계약에 고정하지 않는다. 법정동코드 등 공식 코드와의 대응, 리→읍·면 소속, 구 존재 여부의 검증은 D-02의 자료 검증 대상이다. 확인 근거는 `evidenceRefs`(`region_reference`)로 둔다. **API 요청 지역은 제품 지역과 다르다.** 국토부 매매 API의 5자리 `LAWD_CD`는 `collections[].requestRegionCode`에만 기록한다. 한 요청 범위가 한 제품 지역과 같다고 가정하지 않는다.

확인된 입력 사실은 `input`에만 둔다. 공급면적이나 우선 지역의 근거가 부족하거나 충돌하면 완료된 실행은 `unavailable`을 반환한다. 해당하는 `target_supply_area` 또는 `region_membership` 항목에 사유와 다음 행동을 담는다. 아직 결과를 산출하지 않은 실행은 `not_produced`이며 `result.items`도 `null`이다. 확대 지역의 소속이 미확인일 때는 그 범위의 결론을 `held`로 둔다.

## 5. 지역 범위 판정과 확대 조건을 표현한다

`result.regionScopes`는 `priority`(같은 동·읍·면)와 `expansion`(같은 구 또는 시·군)을 갖는다. 각 범위는 분석에 포함한 거래 종류를 합친 고유 주변 단지를 기준으로 판정한다.

| 범위 필드 | 의미 |
| --- | --- |
| `conclusion` | `candidates_found`(확인된 후보 1개 이상) · `normal_zero`(정상 0개) · `held`(판정 보류) |
| `confirmedCandidateCount`, `unresolvedCandidateCount` | 확인된 후보 단지 수, 미확인·충돌로 보류한 후보 단지 수 |
| `collection` | `{ status, recordIds }`. 이 범위 판정에 필요한 수집 기록과 그 집계 상태(`complete/partial/failed/not_started`) |
| `screening` | `{ status, rowsInScope, unresolvedRows, exclusions }`. 받은 거래 행의 판별(`complete/incomplete/not_started`) |
| `blockingItemIds` | 결론을 보류시킨 항목. `held`이면 1개 이상 |

스키마가 강제하는 확대 조건은 다음과 같다.

1. `normal_zero`는 범위 수집 `complete`, 판별 `complete`, `unresolvedRows: 0`, 확인·미확인 후보 0, 보류 항목 없음을 함께 요구한다.
2. 범위 수집이 `complete`가 아니면 `normal_zero`가 될 수 없고 판별도 `complete`일 수 없다.
3. 그 범위에 미해결 항목이 하나라도 있으면 `normal_zero`가 될 수 없다.
4. `expansion`은 `priority.conclusion`이 `normal_zero`일 때만 객체이고 그 밖에는 `null`이다. 우선 지역이 정상 0개이면 사용자 확인 없이 항상 확대 범위를 둔다(A-05). 확대 범위가 정상 0개이면 그 범위에서 끝내며 더 넓히지 않는다(A-07).

그래서 **같은 동에서 필요한 페이지가 누락돼 확인된 단지가 0개인 사례**는 `priority.conclusion: "held"`와 `expansion: null`로만 표현된다. 같은 사례를 정상 0개로 쓰거나 확대 범위를 붙이면 스키마 검사에 실패한다(A-06·A-10). 이 사례는 `partial`이며, 받은 행의 제외 근거와 누락 사유·다음 행동을 함께 제공한다.

**응답 0행은 정상 0개의 증명이 아니다.** 정상 0개의 근거는 필요한 요청 전체가 `complete` 또는 `empty`로 끝났다는 수집 기록과, 받은 행을 모두 확인된 규칙으로 제외했다는 판별이다. `empty`는 업무 응답이 정상이고 전체 건수 0을 받은 한 요청의 상태일 뿐이다. 예시의 정상 0개는 우선 지역의 3행을 해제 거래 1행, 공급면적 범위 밖 2행으로 제외해 확정했다. 결측이나 연결 실패는 `exclusions`가 아니라 `unresolvedRows`로 센다. 공급면적 범위 밖 제외는 공급면적 대응이 확인된 행에만 쓴다.

## 6. 항목별 판정에 사유·다음 행동·근거를 붙인다

`result.items[]`는 `{ itemId, subject, scope, judgment, retryable, reasons, nextActions, evidenceRefs }`다. `scope`는 `{ regionRole, tradeKind, candidateId }`이며 해당하지 않는 값은 `null`이다.

| `subject` | 대상 | 생성 조건 |
| --- | --- | --- |
| `trade_kind_scope` | 지역 범위 × 거래 종류의 후보 판정 | 수집을 시도한 범위·종류마다 |
| `candidate` | 주변 후보 단지 하나의 비교 가능성 | 확인·보류한 후보마다 |
| `target_supply_area` | 선택 주택형의 공급면적 | 미해결일 때만 |
| `region_membership` | 우선·확대 지역의 소속 | 미해결일 때만 |

| `judgment` | 의미 | 필수 표현 |
| --- | --- | --- |
| `confirmed` | 출처와 적용 조건을 확인 | 근거 1개 이상, 다음 행동 없음, `retryable: null` |
| `normal_zero` | 필요한 조회·판별을 마쳤고 대상 없음 | `trade_kind_scope`만. 근거에 수집 기록과 판별(`screening`)을 함께 포함 |
| `unverified` | 대응 근거 없음·빈 값 | 사유·다음 행동 1개 이상, `retryable` |
| `partially_collected` | 페이지 누락·반복, 건수나 페이지 정보 불일치 | `trade_kind_scope`에 수집 기록 근거를 남김 |
| `lookup_failed` | 인증·네트워크·업무 오류로 조회 실패 | 근거 1개 이상. 오류 요약은 해당 수집 기록의 `error` |
| `conflict` | 여러 후보·주소 차이·다른 집계 값 | 양쪽 근거 2개 이상, 대표값을 임의로 고르지 않음 |
| `decision_required` | 미정 제품 결정 또는 사용자 확인 필요 | 사유에 `product_decision_pending`(`decisionId` 예: `D-03`) 또는 `user_confirmation_required` |

미해결 판정(아래 다섯 가지)은 사유·다음 행동·`retryable`을 모두 가져야 한다. `retryable`은 같은 조건으로 다시 실행해 해소될 가능성을 뜻한다. 다시 실행하면 새 실행이 만들어지며 기존 결과를 덮어쓰지 않는다.

| 사유 코드 `reasons[].code` | 의미 |
| --- | --- |
| `collection_page_missing`, `collection_total_count_changed`, `collection_row_count_mismatch`, `collection_page_inconsistent` | 필요한 페이지 누락, 조회 중 전체 건수 변동, 수신 행 수와 보고 건수의 불일치, 반복 페이지나 페이지 정보 불일치 |
| `collection_request_failed` | 필요한 요청의 조회 실패 |
| `supply_area_correspondence_missing`, `area_basis_mixed` | 공급면적 대응 근거 없음, 전용·공급 혼재 |
| `complex_link_pending`, `address_conflict`, `source_value_conflict` | 단지 연결 보류, 주소 충돌, 출처 간 값 충돌 |
| `region_membership_unverified`, `region_unassigned_rows` | 지역 소속 미확인, 우선 지역에 속할 수 있는 지역 미배정 행 |
| `cancellation_status_unknown`, `different_notice_round` | 해제 여부 미확인, 다른 회차 문서 |
| `product_decision_pending`, `user_confirmation_required` | 미정 제품 결정, 사용자 확인 필요 |

| 다음 행동 `nextActions[].action` | 수행 주체 `actor` 예 |
| --- | --- |
| `rerun_analysis` | `user` — 새 실행으로 다시 조회 |
| `obtain_supply_area_evidence`, `resolve_complex_link`, `verify_region_membership` | `operator` — 공식 근거 확보·연결·소속 확인 |
| `upload_notice_document`, `confirm_condition_change` | `user` — 문서 보완, 조건 변경 확인 |
| `await_product_decision`, `check_upstream_access` | `operator` — 제품 결정 대기, 외부 API 인증·이용 승인 확인 |

근거 `evidenceRefs[]`는 `{ type, id }`이며 `notice_document_page`만 `page`를 가진다. 종류는 `collection_record`(같은 결과의 `recordId`), `screening`(`priority`·`expansion`), `notice_document_page`, `region_reference`, `complex_link`, `supply_area_correspondence`다. 근거 원문 조회는 후속 API에서 정한다.

## 7. 수집 기록과 조회 오류를 남긴다

`result.collections[]`는 출처·API 요청 지역·월 단위 기록이다: `recordId`, `source`(예: `apt_trade`), `tradeKinds`, `requestRegionCode`, `month`, `status`, `pagesExpected`, `missingPages`, `reportedTotalCount`, `rowsReceived`, `totalCountChanged`, `collectedAt`, `error`.

| `status` | 의미 | 스키마 조건 |
| --- | --- | --- |
| `complete` | 필요한 페이지와 행을 모두 받음 | 누락 페이지 없음, 전체 건수 1 이상, 건수 변경 없음, `error: null` |
| `empty` | 업무 응답 정상, 전체 건수 0 | `pagesExpected: 1`, 건수·행 0, `error: null` |
| `partial` | 일부 응답을 받았으나 완전성 확인이 보류됨 | `pagesExpected`와 `reportedTotalCount`를 기록하고 보류 사유를 항목에 연결 |
| `failed` | 첫 응답부터 받지 못함 | 건수·페이지 `null`, 행 0, `collectedAt: null`, `error` 필수 |

페이지가 빠졌거나 전체 건수가 바뀌면 `partial`이다. 마지막 페이지까지 도착했어도 수신 행 수가 보고 건수보다 적거나 많으면 `collection_row_count_mismatch`를 기록한다. 두 건수가 같아도 같은 페이지가 반복되거나 페이지 번호·크기가 맞지 않으면 `collection_page_inconsistent`로 보류한다. 생산자가 페이지와 건수를 대조한 뒤 상태를 정한다.

`error`는 `{ code, layer }`만 담고 원문 메시지·요청 URL·인증값을 담지 않는다. `layer`는 `network`·`http`·`business`(HTTP 200 안의 업무 오류)·`parse`다. 스키마는 `upstream_business_error`→`business`, `upstream_timeout`→`network`, `upstream_malformed_response`·`upstream_response_too_large`→`parse`를 강제한다. 나머지 `upstream_unavailable`, `upstream_rate_limited`, `upstream_auth_rejected`는 실제 계층을 기록한다. 외부 출처별 재시도와 운영 한도는 D-07에서 정한다. BE-04의 작업 인수 횟수와 지연은 개발용 실행기에 적용한다.

## 8. 금액·면적·날짜를 표현한다

| 값 | 표현 | 예 |
| --- | --- | --- |
| 금액 `definitions/won` | 원 단위 0 이상 정수의 십진 문자열. 쉼표·단위·소수점·앞자리 0 금지 | `"835000000"` |
| 공급면적 `definitions/supplyArea` | `{ "basis": "supply", "m2": "<십진 문자열>" }` | `{ "basis": "supply", "m2": "112.40" }` |
| 전용면적 `definitions/exclusiveArea` | `{ "basis": "exclusive", "m2": "<십진 문자열>" }` | `{ "basis": "exclusive", "m2": "84.97" }` |
| 날짜 | `YYYY-MM-DD`, 시간대 없음 | `"2026-11-10"` |
| 월 | `YYYY-MM` | `"2026-10"` |
| 시각 | RFC 3339, 오프셋 필수 | `"2026-11-10T10:00:06+09:00"` |

v0 결과 본문에는 금액 필드가 아직 없다. 비교 통계는 BE-05에서 이 `won` 형식을 사용하며 지금은 형식만 독립 타입으로 검사한다. 만원 단위 원문은 원으로 바꾸고 변환 근거를 정규화 단계에 보존한다.

면적은 JSON 숫자가 아닌 십진 문자열이다. 경계값 비교를 이진 부동소수점이 아닌 정밀 십진수로 하고 원문 자릿수를 보존하기 위해서다. 공급면적 자리에는 스키마가 `basis: "supply"`만 허용하므로 전용면적을 대입할 수 없다. 표시 반올림·㎡↔평 환산은 D-01에서 정한다. 공유 프로필의 `search_conditions`(`supply_area_min_m2` 등 숫자)는 별도 계약이며 이번에 바꾸지 않았다.

날짜·시각 정의에는 `pattern`과 `format`(`date`, `date-time`)이 함께 있다. 기본 소비자 구성은 **Ajv 8 + ajv-formats**이며 존재하지 않는 날짜(예: `2026-02-30`, `2027-02-29`)를 거부한다. format 플러그인 없이 Ajv strict 모드로 컴파일하면 알 수 없는 format으로 실패한다. Python `jsonschema`는 `FormatChecker`와 `date-time` 검사용 `rfc3339-validator`를 함께 써야 같은 판정이 된다.

## 9. 합성 예시 세 가지를 비교한다

세 예시는 같은 입력을 사용한다. 합성 공고 A의 084A(공급 112.40㎡, 전용 84.97㎡), 우선 지역 합성1동, 확대 지역 합성구, 매매만 분석, 2026-10-01~2026-10-31(사용자 확인 기간), 수집 요청 `apt_trade`·`99999`·2026-10이다. 세 실행 모두 `run.status`는 `finished`다.

| 비교 항목 | `normalZero` | `partialCollection` | `upstreamFailure` |
| --- | --- | --- | --- |
| `completeness` | `complete` | `partial` | `unavailable` |
| 수집 기록 | `complete`, 2/2쪽, 14/14행 | `partial`, `missingPages: [2]`, 10/14행, `upstream_timeout`·`network` | `failed`, `upstream_unavailable`·`http` |
| 우선 지역 결론 | `normal_zero` | `held` | `held` |
| 우선 지역 수집·판별 | `complete`·`complete` | `partial`·`incomplete` | `failed`·`not_started` |
| 우선 지역 행 판별 | 3행: 해제 1, 범위 밖 2, 미해결 0 | 받은 3행: 해제 1, 범위 밖 2 | 없음(`null`) |
| 확대 범위 | 합성구 `candidates_found`, 확인 후보 1 | `null` | `null` |
| 우선 지역 매매 항목 | `normal_zero` | `partially_collected`, 사유 `collection_page_missing` | `lookup_failed`, 사유 `collection_request_failed` |
| 다음 행동 | 없음 | `rerun_analysis`(user), `retryable: true` | `rerun_analysis`(user), `retryable: true` |

부분 수집 사례는 [개발팀 계획](../development-team.md)의 첫 공동 리뷰 사례(같은 동의 확인 단지 0개 + 필요한 거래 페이지 누락)다. 화면은 이 응답을 ‘이 동에는 비교할 단지가 없다’로 표시하면 안 된다. 확인한 내용, 누락 범위, 다시 조회하는 행동을 함께 보여준다.

## 10. 스키마 밖 검산과 생산자 책임을 구분한다

draft-07은 서로 다른 위치의 값 비교와 식별자 참조를 검사하지 못한다. 아래 조건은 생산자(API·모의 응답 작성자)가 지켜야 하며 QA는 별도 검산으로 확인한다.

1. **참조 무결성**: `regionScopes.*.collection.recordIds`와 `evidenceRefs`의 `collection_record`는 같은 결과의 `collections[].recordId`를, `blockingItemIds`는 `items[].itemId`를, `screening` 근거는 존재하는 범위를 가리킨다. `itemId`·`recordId`는 결과 안에서 유일하다.
2. **수집 상태를 집계한다.** 수집에 착수하지 않았으면 `not_started`와 빈 `recordIds`를 쓴다. 하나 이상의 기록이 있고 필요한 요청이 모두 `complete`·`empty`이면 `complete`다. 시도한 요청이 모두 실패하고 사용할 응답이 없으면 `failed`, 일부만 확인했으면 `partial`이다. `blockingItemIds`는 해당 범위에 영향을 주는 미해결 항목을 가리킨다.
3. **기간 전체 수집**: 범위의 `recordIds`는 계약일 범위에 걸친 모든 월과, 분석한 거래 종류와 지역에 필요한 모든 요청을 덮는다. 기록의 `month`는 그 범위 안에 있다.
4. **페이지와 건수를 대조한다.** `complete`는 필요한 페이지가 일관되고 `rowsReceived == reportedTotalCount`일 때 쓴다. 행이 많거나 적은 경우와 페이지가 반복된 경우 모두 `partial`이다. 누락된 페이지 번호는 `pagesExpected` 이하다.
5. **판별 산술**: 제외 행 합계 + `unresolvedRows` ≤ `rowsInScope`이며 `normal_zero`이면 제외 행 합계가 `rowsInScope`와 같다. 제외 사유는 범위 안에서 중복되지 않는다.
6. **면적 범위 산술**: `min = S × lowerRatio`, `max = S × upperRatio`를 정밀 십진수로 계산한다. 표시 반올림으로 범위 안팎을 바꾸지 않는다.
7. **날짜 순서**: `start ≤ end ≤ basisDate`. 기본 기간이면 `end = basisDate`이고 시작일은 PRD §7.2.5 규칙을 따른다.
8. **항목·입력 일치**: 미해결 입력의 항목 판정은 입력 `status`와 같다. 확인 후보 수는 해당 범위의 `confirmed` 후보 항목과 일치한다.

## 11. 열린 결정과 후속 범위를 남긴다

| 남긴 내용 | 다룰 곳 |
| --- | --- |
| 공식 공급면적 대응 경로·복수 대응, 표시 정밀도·평 환산 | D-01 |
| 지역 `id`와 공식 코드의 대응, 리→읍·면 소속, 구 존재 판정, 윤일·시간대 경계, 재수집 주기 | D-02 |
| 면적 차이 동률, 대표 좌표·거리 미확인 처리, 가격 통계·짝수 건수 중위값 표시 | D-03, BE-05 |
| 비교표·자체 거래 참고·종류별 통계의 응답 형식 | BE-05 |
| 입력 준비 진행 상태와 중간 결과 | [BE-04 실행 계약](analysis-runs.md). 비교 단계에서의 중간 결과 노출은 BE-05에서 검토 |
| 근거 원문 조회 API, OpenAPI·공용 타입, 실제 인증 연결 | 계약 v1(M1-b) |
| 재시도 상한·지연·쿼터 | D-07 |

## 12. 저장소에서 계약을 검증한다

저장소 루트에서 개발 의존성을 설치한 뒤 `npm test`를 실행한다. [계약 검사](../../tests/backend/analysis-result-v0.test.ts)는 Ajv 엄격 모드와 날짜·시각 검증기를 사용한다. 세 합성 응답과 식별자 참조를 확인하고, 일부 페이지만 받은 결과를 정상 0개로 표시하거나 조회 실패 결과에 확인된 단지를 붙인 응답을 거부하는지 검사한다. 일부 수집 상태에서 독립적으로 확인된 단지가 남는 경우도 검증한다.

실제 공고·거래의 수집과 비교 결과, 계정별 분석 조회는 후속 단계에서 각각 검증한다. [개발 계획](../development-plan.md)
