# 선택한 공고의 공식 PDF와 호실별 가격·면적

문서 작업자는 공고를 선택한 뒤 청약홈 상세 페이지의 첨부를 읽는다. 같은 공고·주택형·호실의 근거가 맞을 때 분양가, 필수 옵션 합계, 주택형 공급면적을 분석에 넘긴다. 이 값들은 예산 비교의 입력이며 세금·금융비용은 별도다. [제품 요구와 수락 기준](../prd/01-product-prd.md)

## 언제 무엇을 조회하는가

| 사용자 단계 | 작업자가 읽는 자료 | 화면에서 사용할 결과 |
| --- | --- | --- |
| 공고 선택 | 서버가 선택한 주택관리번호·공고번호로 청약홈 공고와 주택형을 각각 조회한다. | 공고명·접수 일정·API 보고 면적과 최고금액. 최고금액을 특정 호실의 가격으로 사용하지 않는다. |
| 상세 가격 확인 | API가 준 상세 페이지에서 해당 공고의 공식 첨부를 찾아 PDF 바이트와 판본 해시를 확인한다. | 원본의 출처와 버전, 확보 실패 사유, 재시도·업로드 같은 후속 행동. |
| 정정 공고 확인 | 원본·정정·참고의 적용 관계를 확인하고, 복수 판본의 우선순위가 불명확하면 같은 항목을 대조한다. | 판본 간 금액이 다르면 해당 금액과 소계를 보류한다. 공급면적 등 독립적으로 확인한 항목은 사용할 수 있다. |
| 업로드로 보완 | 분석 소유자 세션으로 등록된 비공개 PDF를 읽는다. 서버가 독립적으로 확보한 같은 공고·회차의 공식 기록과 내용 해시를 대조한다. | 출처 확인을 통과한 파일만 원문 검수로 이어진다. 타인·삭제된 파일은 읽을 수 없다. [업로드 연결 방법](ingestion-storage.md) |
| 값별 근거 확인 | 공식 상세와 첨부 주소의 번호쌍을 먼저 대조한다. PDF에서는 주택관리번호·해당 회차의 공고일, 표의 단위·공급대상, 호실·납부 금액과 필수 옵션 적용 문구를 확인한다. | 값별 상태와 문서 식별자·버전·원문 페이지. 옵션이 누락되면 소계는 보류한다. [공고·호실 결과 형식](ingestion-v0.md) |

## 작업자를 실행한다

PDF 파서는 Python 작업자에 설치한다. 기본 검사는 합성 자료를 사용한다.

```sh
python3 -m pip install -r requirements-pdf.txt
python3 -m unittest discover -s scripts -p 'test_notice_*.py' -v
```

수동 실조회에는 작업자 환경의 `DATA_GO_KR_SERVICE_KEY`와 서버가 선택한 공고가 필요하다. 요청 JSON의 최소 항목은 `noticeSource`와 `target`이다. `target`에는 `houseManageNo`, `noticeNo`, `edition`을 넣는다. `edition`은 선택 시 고정한 회차 식별자다. 공고 번호와 원문 공고일도 대조한다.

```sh
python3 scripts/review_notice_documents.py --live --request /path/to/selected-notice.json
```

기본 실행은 공고·주택형·문서만 읽고 `documentReview`와 `catalog`를 반환한다. 업로드를 보완하려면 `--analysis-id`, `--upload-id`와 작업자 환경의 `HOMECIERGE_USER_JWT`를 사용한다. 작업자는 기존 로컬 사용자 API에서 PDF를 읽으며 기본 포트는 3001이다. `--official-index`는 서버가 공식 원본에서 확인한 버전 기록을 읽는 옵션이다. 브라우저에서 보낸 해시·채택 상태를 이 입력에 연결하지 않는다.

공식 색인의 각 행에는 이전 공식 첨부의 `id`, `sha256`, `houseManageNo`, `noticeNo`, `edition`, `role`이 필요하다. 보관이 허용된 서버 기록 중 `source=official`, `originCheck=confirmed`이고 해시가 있는 행을 사용한다. 현재 첨부 목록 자체를 확인할 수 없어 정정 적용 여부가 미확인인 경우, 이전 판과 해시가 맞는 업로드도 단독으로 채택하지 않는다.

주변 실거래와 문서 점검 결과를 함께 저장하려면 전체 BE-02 요청에 `--save --owner-id … --analysis-id … --capture-key …`를 지정한다. 문서 점검에서 납부 일정 목록을 받으면 `save_funding_schedule_snapshot`이 같은 트랜잭션에서 BE-03 수집본과 해당 일정을 저장한다. 근거 버전과 값별 페이지는 `catalog`에서 확인한다. 실사용자 업로드에서 파생된 값은 같은 소유자·분석의 `registered` 업로드에 `upload:<uploadId>`로 바인딩되고 파생 자료 삭제(`private.snapshot_upload_bindings`, `private.upload_supplement_runs`)에 연결된 경우에만 영속 저장할 수 있다. 미바인딩·삭제 요청·타인 업로드는 `ingestion_upload_binding_required`로 계속 차단한다. [수집본 보관 조건](ingestion-storage.md)

저장 응답이 유실되면 작업자는 이미 읽은 조건·결과·수집 키를 그대로 한 번 다시 전송한다. 작업자가 종료된 뒤에는 소유자의 분석과 수집 키로 기존 스냅샷을 먼저 확인한다. 새로 실조회하면 수집 시각이 바뀌므로 새 수집 키를 사용한다.

## 화면에서 업로드 보완을 접수하고 점검한다

완료된 실수집 공고 분석에서 공식 PDF 확보 실패·판본 미확인·가격/면적/일정 보류 사유가 있으면 결과 화면에 **공고 PDF로 보완** 패널을 표시한다. 사용자는 기존 비공개 버킷 계약(`register_analysis_upload` → `analysis-uploads` 업로드)으로 PDF(`application/pdf`, 최대 50MiB)를 올린 뒤 보완 실행을 접수한다. 브라우저가 보낸 해시·채택 상태·공고 판정 필드는 API가 400으로 거부한다.

| 요청 | 역할과 응답 |
| --- | --- |
| `GET /api/v1/analyses/{analysisId}/runs/{runId}/upload-supplement` | 해당 실행의 보완 필요 여부, 확보 실패·보류 사유, 대상 공고·회차·주택형·호실, 문서 대조 상태와 최근 보완 이력을 조회(`upload-supplement-context/v1`). |
| `POST /api/v1/analyses/{analysisId}/runs/{baseRunId}/upload-supplement` | `Idempotency-Key: <UUID>`와 `{"uploadId":"<UUID>"}`만 받아 같은 공고·주택형·호실의 새 `upload_supplement` 실행을 접수. 202와 `Location`, `upload-supplement-run/v1` 반환. 같은 키·입력 재전송은 같은 실행 반환, 충돌 409, 미적재 파일 409(`upload_file_missing`), 타 계정 404. |
| `GET /api/v1/analyses/{analysisId}/upload-supplements/{runId}` | 보완 실행의 진행 상태(`queued`/`running`/`retry_wait`/`finished`/`failed`/`cancelled`)와 문서 대조·점검 요약을 조회. |

모든 경로는 사용자 JWT와 RLS를 유지하고 `Cache-Control: private, no-store`로 응답한다. 작업자는 `read_upload_supplement_work`와 `lookup_official_notice_document_index`로 고정된 업로드 경로와 서버 공식 해시 색인(`private.official_notice_document_index`)을 읽고, 비공개 버킷에서 직접 읽은 PDF 바이트의 SHA-256을 공식 상세·첨부 식별자·이전 공식 해시와 대조한다. 공식 대조와 자동 점검을 통과한 값만 수집본·납부 일정·비교 재계산에 반영하고 값별 출처를 `사용자 업로드 · 파일 ID · 판본 해시 · 쪽` 형식으로 표시한다. 다른 회차·해시 불일치·출처 미확인·정정 판본 미확인은 해당 값을 보류하고 독립 확인된 공고 기본 정보는 유지한다. 보완 실행과 작업자 경로는 합성 PDF·모의 전송·PGlite·로컬 브라우저에서 검사했으며, 실제 청약홈·운영 인증 통합 검수나 PRD 수락 기준 최종 통과를 뜻하지 않는다. [실행 계약](analysis-runs.md) · [업로드 개별 삭제](data-deletion.md)

## 화면이 읽을 값을 구분한다

- `catalog.rooms[].salePrice`와 `requiredOptions`는 호실별 금액이다. 두 값의 근거가 호환될 때만 `subtotal.won`을 사용한다. 금액은 원 단위 십진 문자열이다.
- `catalog.housingTypes[].checkedSupplyArea`는 문서와 대조한 주택형 공급면적이다. 미확인 값은 `null`이며 전용면적을 대신 사용하지 않는다.
- `catalog.issues`와 각 항목의 `reasons`에 보류 사유가 남는다. `documentReview.acquisitionStatus`는 첨부 확보 상태이므로 개별 값의 `status`와 함께 읽는다. 공식 파일을 받았더라도 복잡한 표나 판본 충돌로 확인하지 못한 값이 있을 수 있다.
- 공식 첨부 본문이 다른 회차를 가리키면 상세 값을 보류한다. `check_notice_edition`과 `review_original_document`를 표시해 선택한 회차와 청약홈 원문을 확인하도록 한다. 파일 전송 실패나 누락으로 업로드가 필요한 경우는 확보 단계에서 안내한다.
- 즉시 조회에서는 `documentReview.documents[]`의 판본과 공식 `sourceUrl`, `inspectionStatus`를 확인할 수 있다. 첨부 간 관계, 누락 목록과 참고 문서 목록은 이 응답에서 제공한다. 저장된 분석에서는 `catalog.notice.link.value`, 값별 `evidence[]`의 문서 식별자·버전·페이지, `catalog.issues`의 보류 사유와 후속 행동을 읽는다.

## 실제 공식 첨부를 확인한 범위

2026-11-22에 강변역 센트럴 아이파크의 서로 다른 공고 3건을 각각 조회했다. 세 건 모두 청약홈 상세 HTML에서 해당 번호쌍의 첨부 링크를 발견했고, 쿠키 없는 요청으로 PDF를 받았다. 상세 페이지와 첨부에 각 한 번씩 요청했다. 같은 단지의 최초 공고와 재공급 공고를 서로 다른 회차로 처리했다.

| 공고 | 공고일 | 공식 첨부를 읽은 결과 |
| --- | --- | --- |
| [최초 모집 2024000226](https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?houseManageNo=2024000226&pblancNo=2024000226) | 2024-05-31 | 820,004바이트 |
| [6월 재공급 2026930019](https://www.applyhome.co.kr/ai/aia/selectAPTRemndrLttotPblancDetailView.do?houseManageNo=2026930019&pblancNo=2026930019) | 2026-06-12 | 368,490바이트 |
| [9월 재공급 2026930040](https://www.applyhome.co.kr/ai/aia/selectAPTRemndrLttotPblancDetailView.do?houseManageNo=2026930040&pblancNo=2026930040) | 2026-09-23 | 367,120바이트 |

세 첨부의 HTTP 본문 유형은 `application/octet-stream`이었다. 커넥터는 파일의 PDF 형식도 확인한다. 사업주체 상세 페이지의 다른 회차 공고는 파일명이나 단지명만으로 채택하지 않는다. 추가 서식, 스캔 문서, 실제 정정 공고의 적용 관계는 각 사례의 검수가 필요하다.

최초 일반분양의 공고 API는 1행, 주택형 API는 4행을 반환했다. PDF 1쪽 일정표의 공고일 `24.05.31.(금)`을 API의 2024-05-31 및 달력 요일과 대조했다. 5쪽에서 84A 106.7260㎡, 84B 106.7190㎡, 84C 105.8736㎡, 130형 165.2993㎡를 확인했다. 가격표는 층별, 옵션표는 주택형별로 작성되어 개별 호실의 가격과 소계는 보류했다.

9월 재공급은 청약홈 공고·주택형 API를 각 1회 실제 조회했다. 두 응답 모두 대상 1행이었고, 상세 페이지에서 받은 PDF의 SHA-256이 이전에 검수한 원본과 일치했다. 84C의 101동 402호에서 **분양가 1,222,020,000원(4쪽) + 필수 옵션 21,780,000원(5쪽) = 1,243,800,000원**, 공급면적 **105.8939㎡(4쪽)**를 자동 확인했다. 공고의 공급면적은 이 주택형에 해당한다. 실거래 후보의 공급면적 대응은 별도 근거로 판단한다. [원문 수작업 검수 기록](pdf-supplement-validation.md)

구의동 주변 거래 319행 중 그랜드파크 27행은 단지 식별까지 검수했다. 계약일에 적용되는 주택형별 공급면적 근거를 확보하지 못해 27행 모두 면적 보류였고, 나머지 292행은 단지 연결 보류였다. 조회 범위는 구의동을 유지했다. [거래별 보류 사유와 비교 엔진 검산](be-06-area-case.md)

6월 재공급에서도 공고·주택형 API가 각각 대상 1행을 반환했다. 이 회차의 청약홈 첨부로 주택형 공급면적 1건과 두 호실 각각의 분양가·필수 옵션을 확인해 두 소계를 계산했다. 같은 공고의 사업주체 보관본(`fd38036dc4fe…`)과 이번 청약홈 첨부(`6d73c2a93f6c…`)는 SHA-256이 달랐다. 따라서 사업주체 사본을 업로드하는 경우에는 그 판본의 독립적인 출처 근거가 필요하다. 두 재공급 사례는 같은 단지에서 나온 자료다.

보완 경로는 보관된 같은 공식 PDF와 모의 전송으로 재검사했다. 첨부 전송이 실패해도 현재 상세에 표시된 첨부 식별자와 서버의 이전 공식 해시가 모두 맞는 업로드는 같은 소계를 냈다. 6월 문서를 9월 업로드로 주거나 9월 첨부 위치에서 6월 문서를 반환한 경우에는 모두 소계를 보류했다. 이 검사는 판본 대조를 검증한 것이며, 실제 계정의 업로드·삭제 권한은 [BE-03 인증·저장 검수](ingestion-storage.md)에서 다룬다.

## 호실별 납부 금액과 시점을 읽는다

즉시 조회 응답의 `documentReview.paymentSchedules[]`는 주택형·호실마다 분양대금(`sale_price`)과 필수 옵션(`required_options`)의 납부 방식을 각각 반환한다. `totalWon`은 그 항목의 확인 총액, `installments[]`는 계약금·중도금·잔금과 각 금액이다. 한 항목의 금액 합과 총액이 대조되고 해당 판본의 근거가 있을 때만 확인 처리한다.

`status`가 `confirmed`인 일정에서도 날짜는 회차별로 확인한다. `timing.dateStatus`가 `exact`인 경우에만 `date`를 확정일로 사용할 수 있다. ‘계약 시’나 ‘입주 시’처럼 사건만 지정한 문구는 상대 시점으로 남긴다. `timing.text`와 `evidence`에서 판본과 페이지를 함께 확인한다. 서로 다른 판본의 계약금과 잔금을 합치지 않는다. 문서 작업자의 `--save`는 호실별 금액과 근거를 담은 `ingestion/v0`와 검산한 일정을 함께 저장한다. 이전에 일정 없이 저장한 수집본은 자금표에서 납부 근거 미확보로 표시한다. [기초 자금표](funding-plan.md)

9월 재공급 101동 402호에서는 분양대금의 계약금 122,202,000원과 잔금 1,099,818,000원, 필수 옵션의 계약금 2,178,000원과 잔금 19,602,000원을 원문과 대조했다. 9월 4쪽 분양대금 계약일은 1·3쪽의 날짜와 대조해 2026년 10월 23일로, 잔금 기한은 2026년 11월 30일로 확인했다. 5쪽 필수 옵션의 납부 시점은 계약 시·입주 시로 남겼다. 6월 재공급은 청약홈의 공식 첨부에서 두 호실의 분양대금·필수 옵션 일정 네 건을 확인했다. 분양대금 계약일은 모두 2026년 7월 1일, 잔금은 입주지정일이다. 2024년 최초 공고의 층별 공급가격표로는 개별 호실의 납부 일정을 구성하지 않았다. [청약홈 9월 재공급 상세](https://www.applyhome.co.kr/ai/aia/selectAPTRemndrLttotPblancDetailView.do?houseManageNo=2026930040&pblancNo=2026930040)

## 신규분양·무순위·잔여세대·재공급 서식 대응과 정정 공고 처리

### 유형별 서식 해석과 보류 기준

| 공고·표 서식 | 해석 단위와 검증 규칙 | 보류·한계 조건 |
| --- | --- | --- |
| 문서 전체 스캔 | `MAX_PAGES = 150` 안에서 후보 쪽 상한 절단 없이 끝까지 표를 스캔한다(`MAX_TABLE_PAGES = MAX_PAGES`). 면적·가격·옵션·납부·일정·정정 머리말 조합으로 후보 쪽을 선별하고, 쪽 끝 가격·구간·옵션 표가 다음 여러 쪽에 머리말 없이 같은 열 수로 이어지면 연속 스캔한다. | 문서가 150쪽을 넘거나 표 추출 예외·제한이 걸리면 `pdf_page_limit_exceeded` 또는 `table_scan_incomplete`로 보류한다. |
| 공고 식별(번호·공고일) | 띄어쓰기 누락·줄바꿈·`주택관리번호`/`공고번호`·`입주자모집공고일 : YYYY. MM. DD.(요일)`·`무순위(사후)` 일정표 변형을 읽는다. | 출처 경로만으로 확인하지 않는다. `최초`·`당초` 등 이전 회차 표기는 제외하고, 복수 번호·날짜가 섞이거나 불일치하면 거부(`rejected`)한다. |
| 공급면적 표 | `주거전용 + 주거공용 = 공급면적 소계`와 면적 단위(`㎡`)를 검산한다. 공급면적 합이 정확히 일치하고 계약면적(`공급 + 기타공용`)만 `0.0001㎡` 반올림 차이가 나면 공급면적은 확인하고 `checks.contract_equals_supply_plus_other = "rounding_note"` 참고 표시만 남긴다. | 공급면적 합 자체의 불일치(`supply_area_sum_mismatch`), 계약면적 `0.0002㎡` 이상 불일치(`contract_area_sum_mismatch`), 면적 단위 미확인은 보류한다. |
| 단위 문구 | 일반 표기(`[단위: 세대, 원]`)와 글자·기호가 쪼개진 표기(`단위세대원 ( : , )` 등)를 공백·괄호·쉼표·콜론과 무관하게 판정해 `원`·`천원`·`만원`을 구분한다. | `천원`·`만원`을 `원`으로 오인하지 않으며, 미지원 단위(`백만원`·`억원` 등)나 복수 단위 혼재는 `amount_unit_unverified`·`amount_unit_ambiguous`로 보류한다. |
| 호실별 가격표 (`unit.kind = "room"`) | 기존 호실 표기(`101동 101호`)와 하이픈 표기(`0202-1501`), 좌·우 외곽 세로선이 생략된 HWP 변환 표(가로 괘선 복구), 표 제목·단일 주택형의 모호하지 않은 주택형 연결을 지원한다. | 복수 주택형에서 주택형 열과 제목 연결이 모두 없으면 `room_type_column_missing`으로 보류한다. 호실이 아닌 행은 `price_row_not_per_room`으로 남긴다. |
| 동·호 라인 × 층 구간 가격표 (`unit.kind = "band"`) | `주택형`/`약식표기` 열과 `동별·라인별` 열을 열 위치로 구분한다. `공급세대수`가 주택형 전체 소계인 서식과 동·라인 묶음별 소계인 서식(천안형)을 모두 지원해 묶음 소계=묶음 내 구간 세대수 합과 주택형별 총합=공급대상 표 세대수를 교차 검산한다. 부가가치세 `-` 칸은 `대지비+건축비=계`가 일치할 때만 0원으로 확인한다. `N층 이상` 구간은 상한을 추정하지 않고 `floors: {from: N, to: null}`·표시 이름 `… N층 이상`으로 확인하며 같은 `(동, 라인)` 층 겹침을 검산한다. 같은 열 구조로 이어진 다음 쪽 첫 묶음의 `동별·라인별` 셀이 앞 쪽 미완성 표기를 완성할 때만 보수적으로 이어 붙여 양쪽 근거 쪽(`evidencePages`, `evidence[]`, `paymentSchedules[].evidence`)을 모두 남긴다. | 검산 불일치(`sale_price_component_mismatch`, `sale_price_payment_mismatch`, `band_household_count_mismatch`, `band_floor_overlap`), 애매한 쪽 경계 위치 조각(`band_location_unreadable`), 동·호 라인 및 세대수 근거가 없는 층별 요약표(`price_rows_not_per_room`)는 보류한다. |
| 필수 옵션과 선택 품목 | 공고 본문이 발코니 확장·추가선택품목의 계약자 선택 명시 또는 `공급금액 미포함`·`별도 계약`/`별도 납부계좌` 안내를 두고 필수·승계 문구 및 별도 필수 옵션표가 없을 때만 `required_options = "0"`(`optional_only`)과 근거 문장 쪽·빈 납부 일정을 확정한다. | 옵션·발코니 언급이 전혀 없는 공고, 필수 승계·강제 확장 문구가 있는 공고, 복수 옵션표가 있는 공고는 `0`원으로 채우지 않고 `options_table_not_found`·`option_requirement_unverified`·`option_room_in_multiple_tables`로 보류한다. |
| 외부 첨부 미제공(예: LH 신혼희망타운) | 청약홈 상세 HTML에 공식 PDF 첨부가 없으면 `attachment_not_found`로 기록하고 업로드 보완 흐름으로 안내한다. | 현재 단계에서는 LH 청약센터 등 외부 사이트를 직접 조회하지 않는다(한계로 유지). |

### 정정 공고 처리(A-59)

- **PDF 본문 정정 표지(A-59a)**: 표지 제목의 `정정공고`, 본문 `정정 내용` 절, `변경 전/변경 후` 표를 탐지하면 `documentReview.documents[].correction`과 `relation.kind = "correction_included"`를 기록한다. 기존 공고문 전체를 대체한다는 긍정 문장이 명시되지 않으면 정정 대상 항목과 그에 의존하는 소계·납부 일정을 `in_pdf_correction_unverified`로 보류하고 `check_correction_relation` 후속 행동을 남긴다. 정정 범위 밖의 독립 확인 항목(예: 공급금액만 정정된 경우의 공급면적)은 유지한다.
- **같은 공고·회차의 공식 색인 복수 해시(A-59b)**: `private.official_notice_document_index`는 같은 `(house_manage_no, notice_no, edition)`에서 관측된 서로 다른 공식 SHA-256을 덮어쓰지 않고 모두 보존한다. `read_comparison_work`와 `read_upload_supplement_work`는 이전 공식 해시 이력을 `officialRevisions`로 작업자에 전달한다(단건 대조용 `officialIndex`는 기존처럼 모호 슬롯을 제외). 최신 수집 시각만으로 정정본을 선택하지 않고 `official_document_hash_changed`·`correction_relation_unverified`로 보류하며, 이전 판본 바이트가 함께 확보되면 두 판본을 병렬 대조해 불일치 금액은 `conflict`로, 일치하는 독립 항목은 `confirmed`로 남긴다.

### 오프라인 서식 회귀 점검 도구와 표본 13건 관측

실제 수집 표본 디렉터리(Git 제외)에서 네트워크 호출 없이 서식 해석 결과만 재현하려면 `scripts/verify_notice_formats.py`를 사용한다. 출력에는 상태·건수·스캔 쪽수·처리 시간·사유 코드만 포함하며 공고 원문·발췌·구체 금액은 출력하지 않는다.

```sh
python3 scripts/verify_notice_formats.py --samples-dir /path/to/notice-format-samples
```

아래 표는 2026-11-28 로컬 보관 표본 13건(기존 12건 + 천안 `2026000521`)에 대한 작업 R 전(`MAX_TABLE_PAGES = 40` 기준)과 작업 R 후(전체 쪽 스캔·천안형 서식·확정 판정 반영)의 오프라인 관측 비교다. 이 결과는 보관 표본의 서식 파서 관측이며 전체 서식 검증 완료나 PRD 수락 기준 최종 통과를 뜻하지 않는다(D-04 미정 유지).

| 공고 | 유형 | 작업 R 전 사유(시간) | 작업 R 후 상태(식별) | 면적(확/보/충) | 분양가(확/보/충) | 옵션(확/보/충) | 단위 | 스캔(쪽) | 시간(초) | 작업 R 후 사유 코드 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026000472 | APT/민영 | `table_scan_incomplete` (2.954초) | checked (`confirmed`) | 2/0/0 | 12/0/0 | 12/0/0 | band:12 | 24/70 | 1.962 | - |
| 2026000499 | APT/민영 | `table_scan_incomplete` (6.481초) | checked (`confirmed`) | 5/0/0 | 214/0/0 | 214/0/0 | band:214 | 28/67 | 5.272 | - |
| 2026000505 | APT/민영 | `options_table_not_found`, `table_scan_incomplete` (3.917초) | checked (`confirmed`) | 4/0/0 | 32/0/0 | 32/0/0 | band:32 | 22/65 | 2.664 | - |
| 2026000515 | APT/민영 | `table_scan_incomplete` (4.583초) | checked (`confirmed`) | 10/0/0 | 46/0/0 | 46/0/0 | band:46 | 22/71 | 2.949 | - |
| 2026000521 | APT/민영 | `amount_unit_unverified`, `band_household_count_mismatch`, `band_location_unreadable`, `table_scan_incomplete` (4.330초) | checked (`confirmed`) | 4/0/0 | 63/0/0 | 63/0/0 | band:63 | 24/77 | 3.032 | - |
| 2026000560 | APT/민영 | `contract_area_sum_mismatch` (3.516초) | checked (`confirmed`) | 3/0/0 | 13/0/0 | 13/0/0 | band:13 | 20/66 | 2.271 | - |
| 2026820014 | 신혼희망타운/국민 | `attachment_not_found` (0.003초) | `attachment_not_found` | 0/0/0 | 0/0/0 | 0/0/0 | - | - | 0.000 | `attachment_not_found` |
| 2026910292 | 무순위 | `options_table_not_found` (3.603초) | checked (`confirmed`) | 2/0/0 | 5/0/0 | 5/0/0 | band:5 | 11/14 | 3.327 | - |
| 2026910300 | 무순위 | - (1.351초) | checked (`confirmed`) | 0/0/0 | 55/0/0 | 55/0/0 | band:55 | 8/13 | 1.268 | - |
| 2026910306 | 무순위 | `options_table_not_found` (0.669초) | checked (`confirmed`) | 0/0/0 | 24/0/0 | 0/24/0 | band:24 | 6/10 | 0.597 | `options_table_not_found` |
| 2026930043 | 불법행위 재공급 | `option_item_duplicated`, `option_requirement_unverified`, `option_room_in_multiple_tables`, `option_table_continuation_unverified`, `required_options_uncrosschecked`, `room_not_in_options_table` (0.971초) | checked (`confirmed`) | 1/0/0 | 2/0/0 | 0/2/0 | room:2 | 8/15 | 0.705 | `option_item_duplicated`, `option_requirement_unverified`, `option_room_in_multiple_tables`, `option_table_continuation_unverified`, `required_options_uncrosschecked`, `room_not_in_options_table` |
| 2026930045 | 불법행위 재공급 | - (1.214초) | checked (`confirmed`) | 3/0/0 | 3/0/0 | 3/0/0 | room:3 | 9/20 | 0.910 | - |
| 2026930046 | 불법행위 재공급 | `contract_area_sum_mismatch`, `option_requirement_unverified` (0.485초) | checked (`confirmed`) | 2/0/0 | 2/0/0 | 0/2/0 | room:2 | 6/10 | 0.494 | `option_requirement_unverified` |

13건 전체 오프라인 PDF 처리 시간은 작업 R 전 34.077초(`MAX_TABLE_PAGES = 40` 절단 포함)에서 작업 R 후 25.451초(전체 쪽 스캔, 미완료 0건)로 줄었고, 전 표본에서 모든 쪽을 강제 전수 스캔한 결과와 필드·근거·납부 일정·사유 코드가 일치함을 확인했다. `2026910306`은 공고 전체에 발코니·옵션 언급이 없어 `options_table_not_found` 보류를 유지하고, `2026930043`·`2026930046`은 필수 승계 문구와 복수 옵션표·이어진 표 조건 때문에 옵션 보류를 유지한다. `2026000560`의 2개 주택형과 `2026930046`의 2개 주택형은 공급면적 합이 일치하고 계약면적만 `0.0001㎡` 반올림 차이가 있어 공급면적을 확인하되 `rounding_note` 참고 표시를 남긴다.
