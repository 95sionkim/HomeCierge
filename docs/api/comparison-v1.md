# 한 공고와 주변 단지의 실거래를 비교한다

로그인한 사용자가 선택한 한 분석의 수집본, 주택형, 거래 기간과 검수된 근거를 사용한다. 같은 실행을 다시 열면 당시에 저장한 결과를 반환한다. 2026-11-28 사용자 결정(Q-52)에 따라 비교 대상은 선택한 주택형과 **같은 평형(주거전용면적 정수부, 소수점 버림)** 의 거래로 정하며, 주변 단지의 공급면적은 참고 표시 전용으로만 붙인다(공급면적 미확인만으로 거래를 보류하지 않는다). [제품 비교 규칙](../prd/01-product-prd.md#72-지역-검색과-비교-규칙)

## 합성 공고 한 건을 재현한다

```sh
python3 scripts/run_analysis_worker.py --demo
```

예시는 2026년 10월 10일부터 31일까지로 사용자가 지정한 기간을 사용한다. 공고 주택형(`084.0000A`)의 대상 평형은 `84㎡형`(전용면적 정수부 `84`)이며 확인된 공고 공급면적은 참고용 `112.400㎡`다. 101호의 분양가와 필수 옵션 소계는 7억 1천만 원이고, 102호의 필수 옵션은 미확인이다. 비교 A(`excluUseAr` `84.00㎡`, 참고 공급면적 `112.50㎡`)와 B(`excluUseAr` `84.50㎡`, 참고 공급면적 `110.00㎡`) 모두 같은 법정동(`가람동`)의 `84㎡형` 거래로 확인 좌표 간 직선거리순으로 A, B 순으로 표시한다. B의 분양권과 입주권은 따로 읽는다. 이 예시의 위치·거래·면적 대응은 모두 합성이다. [수집 입력](../../tests/fixtures/ingestion-v0.json) · [단지·면적 대응 근거](../../tests/fixtures/comparison-evidence-v1.json)

## 결과를 조회한다

1. 자기 분석 초안을 만들 때 `conditions_snapshot.comparison`에 선택한 `modelNo`와 필요한 경우 `room`을 넣는다. 예를 들어 `{"comparison":{"modelNo":"01","room":"101동 101호"}}`다. `room`을 생략하면 확인된 호실 소계의 범위와 보류 호실 수를 사용한다.
2. 실행을 접수하고 반환된 `Location`에서 상태를 확인한다. 작업자가 실행을 인수해 비교와 수집본 연결을 마치면 같은 주소에 `/result`를 붙여 GET으로 요청한다. 사용자 세션의 Bearer 토큰을 사용한다. [분석 접수와 취소](analysis-runs.md)
3. 결과 응답의 `analysisId`, `runId`, `snapshotId`, `rulesVersion`으로 당시 분석·실행·수집본·조건에 연결한다. 비교 내용은 `result.contractVersion = "comparison/v1"`에 따른다. 다른 기기에서는 자기 분석의 `latest_run_id`로 해당 주소를 복원한다.

| 응답을 받는다 | 화면에서 처리한다 |
| --- | --- |
| 200 | `result.completeness`는 `complete`, `partial`, `unavailable` 중 하나다. 확인된 가격과 표본 수, 보류·제외 근거를 함께 표시한다. |
| 401 | 사용자 로그인을 다시 확인한다. |
| 403 `comparison_source_restricted` | 소유한 결과에 사용된 자료의 현재 이용 조건으로 표시할 수 없다. 허용 상태를 확인해야 다시 볼 수 있다. |
| 404 `run_not_found` | 계정에서 읽을 수 있는 해당 분석·실행이 없다. |
| 409 `comparison_not_available` | 실행 상태를 확인한다. 아직 진행 중이면 나중에 다시 읽는다. 취소·실패하거나 과거 실행기에 비교 결과가 저장되지 않은 경우에는 새 실행을 접수할 수 있다. |
| 503 | 저장소 응답을 확인할 수 없다. 같은 결과 주소로 다시 조회한다. |

## 가격과 지역의 근거를 읽는다

| 결과 필드를 읽는다 | 사용자에게 설명한다 |
| --- | --- |
| `target`, `conditions`, `noticePrice` | 선택 주택형·대상 평형(`target.exclusiveAreaM2`, `target.areaClass`, 표시 `84㎡형`)·참고 공고 공급면적(`target.supplyArea`)·비교 기준(`conditions.area`: `{"basis":"exclusive_area_class","class":84}`)·기간과 분양가+필수 옵션 소계를 읽는다. 확인된 호실·가격 구간만 가격 계산에 사용한다. 이전에 저장된 공급면적 ±5% 결과(`conditions.area.basis = "supply"`)도 읽기 호환을 유지한다. |
| `regionDecision`, `appliedScope`, `collections` | 같은 법정동·읍·면을 먼저 판정한다. 필요한 범위·월·출처의 조회와 후보 판별이 끝나 대상 평형 주변 후보 0개를 입증한 때만 구 또는 구 없는 시·군으로 넓힌다. 수집 실패·부분 수집·전용면적 미확인·단지 식별 미확인·지역 미확인 거래는 정상 0개 근거가 아니다. |
| `comparables`, `tradeKinds` | 매매·분양권·입주권을 합쳐 고유 주변 최대 5단지다. 단지 안의 같은 평형(`areaClass`) 거래는 전용면적 소수점이 달라도 한 묶음으로 종류별 건수·최소·중위·최대로 읽는다. 1~2건은 적은 표본으로 표시한다. 단지 순서는 확인 좌표 간 직선거리순(`selectionReason`: `"straight_line_distance"` / `"straight_line_rank_pending"` / `"manual_replacement"`)이다. `supplyAreaReference`(`status`: `"single"` | `"range"` | `"unavailable"`, `m2`, `minM2`, `maxM2`, `evidence` 또는 `reasonCode`)는 참고 표시 전용이며 포함 여부·순위에 쓰지 않는다. |
| `candidatePool` | 적용 범위 판정에 사용한 주변 단지 후보 목록이다. 현재 적용 지역과 같은 평형 기준을 통과한 후보(`eligible: true`, `areaClass`, `supplyAreaReference`, `distanceMeters`)와 범위 밖(`outside_applied_region`)·다른 평형(`outside_area_class`)·미확인 후보(`eligible: false`, `reasonCode`)를 구분해 O-1 단지 교체 편집과 대화 안내에 사용한다. |
| `rankingComplete` | 수집이나 동률·좌표 미확인 판정이 남으면 `false`다. 확인한 후보를 보여주되 최종 순위로 안내하지 않는다. |
| `targetReferences`, `holds`, `exclusions` | 대상 단지 자체 거래(`target_complex_trade`), 결론을 유보한 관측과 사유(`target_area_class_unverified`, `trade_link_unverified`, `trade_complex_identity_unverified`, `straight_line_distance_tie`, `straight_line_distance_unverified` 등), 근거를 갖춰 제외한 관측(`outside_area_class`, `cancelled_trade`, `outside_contract_period`, `outside_applied_region` 등)을 구분한다. |

금액은 원 단위 십진 문자열이다. 유효 거래가 짝수인 경우 두 가운데 값의 평균이 반 원이면 `medianWon`에 `.5`가 붙는다. `tradeStats.sale`의 매매가격과 두 권리 종류의 신고 거래금액은 따로 표시한다. 권리 신고금액을 프리미엄으로 해석하지 않는다. 호실·가격 구간 가격에는 분양가와 필수 옵션을 분리한 원문 페이지가 들어간다. `noticePrice.heldRooms`로 가격 범위에서 빠진 호실 또는 가격 구간을 확인한다.

신규분양·무순위처럼 동·호 라인 × 층 구간 단위로 가격이 정해지는 공고에서는 `room` 문자열 자리에 구간 표시 이름(예: `"101동·102동 3호 라인 11~15층"`)을 그대로 사용하고, `noticePrice.confirmedRooms[]`, `noticePrice.heldRooms[]`, 선택 시 `noticePrice.unit`에 구조화된 단위 정보(`unit: {kind: "room" | "band", buildings: string[], lines: string[], floors: {from: number | null, to: number | null}, households: number}`)를 함께 전달한다. 층·라인 정보로 개별 호실 번호를 추정해 생성하지 않으며, 기존 호실별 표는 `unit.kind = "room"`으로 유지한다. `conditions_snapshot.comparison.room`에도 같은 표시 이름을 지정할 수 있다.

2026-11-28 사용자 결정 Q-52에 따라 비교 기준은 선택한 주택형(`HOUSE_TY`, 바깥 공백 무시)의 전용면적 정수부(소수점 버림, 예: `84.9800` → `84`, `102.7700 ` → `102`, `59.9926` → `59`)와 거래의 전용면적(`excluUseAr`) 정수부가 같은 **같은 평형**으로 고정한다. 기존 공급면적 ±5%와 허용 범위 변경(Q-41)을 대체하며, 주변 단지 공급면적 미확인만으로 거래를 보류하지 않는다. 직접 지정은 `replacements`에 같은 범위·같은 평형의 `complexId`와 사용자가 교체하기로 한 `replaceComplexId`를 연결한다. 단지 순서는 확인된 단지 좌표 사이의 **직선거리순**이며, 동률·좌표 미확인·좌표 충돌 등 미정 조건(D-03)이 선정이나 순위에 영향을 주면 해당 항목에 사유를 표시하고 `rankingComplete = false`로 둔다. 이전에 저장된 `conditions.area.basis = "supply"`(±5%) 결과는 화면·저장 보고서·PDF·대화·에이전트에서 계속 읽을 수 있도록 읽기 호환을 유지한다.

## 입력과 결과를 보관한다

현재 실행 API는 분석 초안에 지정한 호실·교체 요청을 읽는다. 기존 수집본으로 다시 실행하면 그때의 조건을 재사용한다. 완료된 실행의 비교 대화와 O-1 비교 조건 편집 패널에서는 계약 기간·거래 종류·단지 직접 교체를 제안할 수 있다(공급면적 허용 범위 변경은 Q-52로 폐지). 사용자가 승인한 변경은 같은 수집본으로 접수하는 해당 분석의 새 실행에만 적용하며 공유 프로필은 바꾸지 않는다. [조건 변경 개발 순서](../development-plan.md)

수집한 자료와 지역·단지·면적을 대조한 근거는 별개다. 사용자의 분석 조건은 모델과 호실 등을 선택하는 데 사용한다. 작업자는 서버에서 등록한 근거, 출처·페이지·행 위치와 식별 정보를 해당 수집본에 대조한다. 공고 실행(`kind = "notice"`)과 업로드 보완 실행(`kind = "upload_supplement"`)에서 대상 주택형의 평형(`HOUSE_TY` 전용면적 정수부)과 계약 기간이 확인되고 기존 등록 근거가 없으면, 작업자는 행정안전부 법정동코드·청약홈 공고/주택형 참고 공급면적(Q-38·Q-52)·카카오 로컬 도로명주소 좌표(Q-39)로 `comparison-evidence/v1`을 자동 구성해 `finish_notice_with_evidence`로 수집본·비교 결과와 원자 저장한다. 저장된 근거는 같은 수집본의 기간·조건 변경 재계산(`kind = "snapshot"`)에서 외부 재조회 없이 그대로 재사용한다. 카카오 좌표의 저장·재사용이 `source_registry`에 허용되지 않은 상태에서는 원좌표를 저장하거나 캐시하지 않고 실행 중에만 직선거리를 계산한다. 합성 데모의 대응 자료는 그 버전으로 만든 수집본에만 재사용한다. 실자료 판단에는 출처별 이용 범위와 조사 기록을 적용한다. [자동 비교 근거 계약](auto-comparison-evidence.md) · [대표 단지 실자료 검증](be-05-real-case.md)

공고 번호쌍·회차로 지정한 수집본을 사용한다. 분석에 카탈로그 UUID가 지정된 경우 해당 UUID와 외부 공고·주택형 사이의 연결 근거가 필요하다. 현 버전에서 그 연결을 입증할 수 없으면 `target`과 `noticePrice`는 `null`이고 `holds`에 식별 보류 사유가 남는다. 작업자는 접수 때 등록돼 있던 근거만 사용한다. 실자료의 수집·보강 출처에는 저장·재사용·화면 표시 허용이 모두 필요하다. 허용이 철회되면 소유자가 저장된 결과를 다시 읽을 때도 403을 받는다.

기존 수집본으로 실행하면 같은 저장본을 참조하고 새 실행의 비교 결과를 기록한다. 수집본 연결과 비교 결과, 실행 완료는 같은 DB 트랜잭션에서 확정한다. 작업자가 취소되거나 임대를 잃으면 새 결과를 기록할 수 없다. 사용자 API에서 비교 결과는 `private, no-store`로 응답한다. 개발 실행기는 수집본과 근거를 합친 RPC 응답을 최대 32 MiB까지 읽는다. 이 크기를 넘기는 자료의 분할 처리는 후속 운영 과제다.

## 단지 식별 근거와 문서 원문 정보를 읽는다

완료된 실행의 O-4 단지 상세와 O-5 원문 근거 시트는 `GET /api/v1/analyses/{analysisId}/runs/{runId}/evidence`로 저장 수집본(`analysis_input_snapshots`)의 참조 메타데이터를 읽는다. 요청은 사용자 세션의 Bearer 토큰을 사용하며 `private, no-store`로 응답한다. 응답을 구성하기 전에 `/result`와 같은 `get_analysis_comparison` 권한 검사를 먼저 통과하므로, 다른 계정의 실행은 404 `run_not_found`, 저장된 결과가 없으면 409 `comparison_not_available`, 출처 표시 권한이 제한되면 403 `comparison_source_restricted`를 반환한다.

| 응답 필드 (`comparison-evidence-detail/v1`) | 화면에서 사용하는 용도 |
| --- | --- |
| `analysisId`, `runId`, `snapshotId`, `dataOrigin` | 열어 둔 실행·수집본과 합성(`synthetic`)/수집(`collected`) 구분을 대조한다. |
| `noticeLink` | `dataOrigin = "collected"`이고 청약홈 공식 상세 주소 형식이 검증된 경우에만 반환한다. |
| `documents[]` | 문서 식별자(`id`), 전체·단축 판본(`version`, `versionShort`), 확보 경로(`source`: `official`/`upload`/`unknown`), 회차 검증(`originCheck`), 채택 상태(`status`: `accepted`/`held`/`rejected`)와 사유(`reasons`)를 제공한다. 공식 공고 첨부는 재호스팅하지 않고 검증된 청약홈 공식 URL(`officialUrl`)만 제공하며, 본인 계정에 `registered` 상태로 등록된 업로드 문서에만 `/api/v1/analyses/{analysisId}/uploads/{uploadId}/content` 경로(`uploadContentPath`)를 제공한다. 삭제되었거나 미등록인 업로드에는 다운로드 경로를 내보내지 않는다. |
| `tradeObservations[]` | `comparables`, `targetReferences`, `exclusions`, `holds`에서 참조한 거래 위치(`recordId`, `source`, `page`, `position`)에 한해 계약일·신고금액·전용면적·층·건축년도·해제 여부와 허용된 식별 근거(`aptNm`, `aptSeq`, `sggCd`, `umdCd`, `umdNm`, `jibun`, `roadNm` 등)만 반환한다. 비교 결과에서 참조하지 않은 원거래나 내부 필드는 포함하지 않는다. |

합성 브라우저와 백엔드 테스트는 비로그인 예시(`#sample/saved`, `#sample/expanded`, `#sample/held`)와 모의 세션으로 S-04·O-4·O-5 동작과 권한 경계를 확인한다. 실제 공고·실거래의 수락 기준 검증은 별도 검수 단계에 해당한다.

## 비교 결과에 질문하고 계약 기간을 변경한다

로그인한 사용자는 비교표에서 “왜 이 거래만 포함됐어?”라고 묻고, “더 알려줘”로 해당 결과에 포함된 거래의 종류·계약일·신고금액을 확인할 수 있다. 답변은 열어 둔 실행의 저장값을 읽는다. 비교 단지 수와 거래 건수를 구분하고, 보류 사유와 출처의 현재 표시 권한을 확인한다.

| 요청한다 | 응답을 사용한다 |
| --- | --- |
| 실행 주소의 `/conversation`에 GET | `analysis-conversation/v1`의 최근 대화 30개를 시간순으로 읽는다. `hasEarlier`는 앞선 대화가 더 있는지를, `previousRunId`는 이 결과를 요청한 이전 실행을 가리키고, `conditionBounds`는 이 실행에서 편집 가능한 기간·거래 종류·단지 교체 가능 여부(`areaEditable: false`)를 제공한다. 각 턴에는 비동기 LLM 에이전트 응답 상태(`agentReply`: `null` 또는 `queued`/`leased`/`answered`/`rejected`/`failed`/`expired`)가 포함된다. |
| 같은 주소에 POST `{requestId, message}` | 질문을 보낸 뒤 응답을 받지 못하면 같은 요청 UUID로 재시도한다. 비교 기간·지역·대상 거래·보류 사유·호실 소계에 답하고, 규칙 기반 분류로 기간·거래 종류·단지 교체 변경 제안을 즉시 생성한다(공급면적 허용 범위 변경 요청은 Q-52 평형 기준을 안내하고 제안을 만들지 않는다). `private.agent_settings.enabled = true`이면 비동기 에이전트 대기열(`private.analysis_agent_replies`)도 함께 생성되며, 꺼져 있으면 규칙 기반 동작 그대로다. |
| 같은 주소에 POST `{requestId, message, conditions}` | O-1 비교 조건 편집 패널에서 구조화된 조건 변경(`period`, `tradeKinds`, `replacements` 중 1개 이상)을 제안한다. `areaTolerancePercent`는 400으로 거부한다. 같은 요청 UUID로 같은 내용을 재전송하면 동일한 결과를 반환한다. |
| `/conversation/{turnId}/decision`에 POST `{decision}` | `approve`는 제안한 조건의 실행을 같은 수집본으로 접수한다(과거 저장된 `areaTolerancePercent` 대기 턴 승인은 409로 차단, 거절·취소 허용). 같은 제안을 중복 승인해도 새 실행은 하나다. `reject`와 `cancel`은 기존 조건을 유지한 채 사용자의 결정만 기록한다. 승인된 `proposal.resultRunId`로 실행 상태와 새 비교표를 연다. LLM이 제안한 조건 변경도 같은 서버 검증을 거쳐 `pending` 제안으로만 첨부되며 사용자가 직접 승인해야 적용된다. |

비교 대화 화면은 항상 규칙 기반 답변을 먼저 보여준다. 에이전트 기능이 켜져 `agentReply.status = "answered"`가 도착하면 **AI 설명**과 모델 이름을 함께 표시하고 규칙 기반 답변도 유지한다. `rejected`·`failed`·`expired` 또는 대기열이 없는(`null`) 턴은 규칙 기반 답변만 보이고 `작성 중`을 표시하지 않는다(A-58). 자세한 검증·출처 권한·비용 기록은 [LLM 에이전트 코어 계약](agent-core.md)을 따른다.

“최근 6개월로 다시 비교해줘”의 기준은 이 분석의 저장된 기준일이다. 제안에는 이전 기간과 새 기간의 시작일·종료일이 표시된다. 실제 수집한 날짜 범위 안에서 “2026-10-24부터 2026-10-26까지”처럼 양 끝을 지정할 수도 있다. 수집 범위 밖이면 `409 conversation_period_unavailable`을 반환한다. 다른 기기에서도 원래 실행을 열면 당시의 비교표, 질문과 결정이 표시된다.

### 계약 기간·거래 종류·단지 교체를 변경한다

완료된 최신 실행의 비교표(S-05)에서는 O-1 비교 조건 편집 패널이나 대화 입력(“최근 6개월로 다시 비교해줘”, “매매만 비교해줘”, “합성 비교 A를 합성 비교 C로 바꿔줘” 등)으로 조건 변경을 제안할 수 있다. 제안은 `intent = "change_conditions"`와 `proposal.kind = "conditions"`(`previous`, `proposed`, `effective`, `status`, `resultRunId`)로 기존 분석 대화 턴(`private.analysis_chat_turns`)에 저장되므로 기존 개별·계정 삭제 범위(‘메시지·비교 대화 한 건’)가 그대로 적용된다. 모든 응답에는 `Cache-Control: private, no-store`를 적용하고, 다른 계정의 조회·제출·결정은 404를 반환한다.

- **비교 평형 기준 고정 (Q-52)**: 비교 대상은 선택한 주택형과 같은 평형(`exclusive_area_class`, 전용면적 정수부)으로 고정하며 공급면적 허용 범위(`areaTolerancePercent`) 변경은 지원하지 않는다(`conditionBounds.areaEditable = false`). 구조화 요청에 `areaTolerancePercent`가 들어오면 400(DB `22023`)으로 거부하고, 자연어 면적 범위 변경 요청에는 같은 평형 기준을 안내하며 제안을 만들지 않는다. 과거 ±5% 결과와 턴 기록은 계속 읽을 수 있으며, 과거 ±5% 기준 실행 위에서 기간·거래 종류·단지 교체를 승인하면 새 Q-52 평형 결과로 재계산한다.
- **거래 종류 (`tradeKinds`)**: 현재 수집본에 포함된 거래 종류(`sale`, `presale_right`, `occupancy_right`)의 비어 있지 않은 부분집합만 선택할 수 있다. 수집하지 않은 거래 종류를 요청하거나 적용 조건을 확인할 수 없으면 `409 conversation_condition_unavailable`을 반환한다.
- **비교 단지 직접 지정·교체 (`replacements`)**: 현재 적용 지역(같은 동·읍·면 또는 자동 확대된 구·시·군)과 같은 평형 기준을 통과한 후보(`candidatePool`의 `eligible: true`)만 기존 비교 단지와 교체해 고유 주변 단지 5개 이하를 유지한다. 범위 밖·다른 평형(`outside_area_class`)·미확인 후보는 사유를 표시하고 비교표에 넣지 않으며, 교체할 기존 단지가 불명확하면 임의로 빼지 않고 확인을 요청한다.
- **승인과 작업자 검증**: 거절·취소·미응답은 기존 조건을 유지하며 공유 프로필은 변경하지 않는다. 승인 시 `read_comparison_work`가 승인된 조건(`comparisonConditions` 및 기간 포함 시 `comparisonPeriod`)을 작업자에게 전달하고, `finish_analysis_comparison`은 저장 결과가 승인된 기간·대상 평형(`exclusive_area_class` 및 관측 전용면적 정수부 일치)·거래 종류·`manual_replacement` 선정 이유(교체된 기존 단지 배제 및 적용 지역 소속 포함)와 일치하는지 DB에서 검사해 불일치 결과를 거부한다.

합성 PGlite·백엔드·Python·브라우저 테스트에서 평형 경계(`84.9999`→`84`, `85.0000`→`85`, 바깥 공백), 같은 단지 내 소수점 다른 같은 평형 묶음, 다른 평형 제외, 정상 0개와 수집 실패·보류 구분, 직선거리 순서·동률·거리 미확인, 참고 공급면적(단일·범위·없음), 이전 ±5% 결과·턴 읽기 호환, 거래 종류 부분집합, 적격·부적격 단지 교체, 중복 승인 단일 실행, 거절·취소·미응답 불변, 타 계정 404와 1440px/390px 화면 동작을 확인했다. 실제 공고·실거래의 수락 기준 검수와 원격 DB 적용은 별도 단계다. [평형 비교 DB 마이그레이션](../../supabase/migrations/20261128100000_area_class_comparison.sql) · [비교 조건 편집 테스트](../../tests/browser/condition-editor.test.mjs)

2026-11-23 서울 개발 Supabase에 두 시험 계정으로 로그인해 합성 비교표로 검수했다. 동일한 기간 제안을 동시에 두 번 승인했을 때 새 실행은 하나였다. 10월 24~26일로 다시 계산한 결과에는 24일 분양권과 26일 입주권이 각각 1건 남았다. 재로그인 후 같은 수집본, 이전 결과와 승인 기록을 다시 읽었고 다른 계정의 조회와 승인은 404였다. 휴대전화와 데스크톱 화면 검사는 로컬 브라우저에서 수행했다. [DB 변경](../../supabase/migrations/20261123081319_analysis_conversations.sql) · [인증 검수](../../scripts/smoke_be04_runs.mjs)
