# 분석을 접수하고 수집 입력을 준비한다

로그인한 사용자는 자기 분석에서 실행을 시작하고, 페이지를 벗어났다가 돌아와 진행 상태를 조회하거나 취소할 수 있다. `finished`이면 당시의 수집본을 열 수 있다. BE-05 실행기는 같은 트랜잭션에서 비교 결과도 저장한다. 실행 조회 주소에 `/result`를 붙이면 확인한 가격·단지·거래 통계와 보류 근거를 읽을 수 있다. [비교 결과 읽기](comparison-v1.md) · [수집본 읽기](ingestion-storage.md)

## 화면에서 호출한다

분석 초안을 만든 뒤 아래 요청에 사용자의 Supabase 세션을 전달한다. 화면은 사용자가 실행을 시작할 때 UUID 하나를 발급하고, 응답 유실·재전송·중복 클릭에는 같은 UUID와 입력을 사용한다. 새 실행을 의도할 때만 키를 바꾼다.

| 사용자 행동 | HTTP 요청 | 화면에서 처리할 응답 |
| --- | --- | --- |
| 실행을 접수한다 | `POST /api/v1/analyses/{analysisId}/runs`, `Idempotency-Key: <UUID>`, `Content-Type: application/json` | DB에 실행을 기록한 뒤 202, 현재 실행 객체와 조회용 `Location`을 반환한다. 재전송 시 실행 ID가 같다. |
| 진행 상태를 조회한다 | `GET /api/v1/analyses/{analysisId}/runs/{runId}` | 200. 재접속 후에도 같은 주소에서 최신 상태를 읽는다. |
| 실행을 취소한다 | `POST /api/v1/analyses/{analysisId}/runs/{runId}/cancel`, 본문 없음 | 200. 이미 취소된 실행에 다시 요청해도 `cancelled`다. 먼저 성공·실패로 종료한 실행에는 409가 온다. |

새 기기에서 로그인하면 본인의 `analyses`에서 `id`, `latest_run_id`를 읽는다. `latest_run_id`가 있으면 두 ID로 조회 주소를 복원한다. 값이 `null`인 분석에는 이 방식으로 접수한 실행이 없다. 이전 실행이 늦게 종료되더라도 가장 최근에 접수한 실행 ID는 유지된다.

기존 수집본을 선택하는 본문은 다음과 같다. 아래 UUID는 합성 예시다.

```json
{
  "input": {
    "kind": "snapshot",
    "snapshotId": "00000000-0000-4000-8000-000000000001"
  }
}
```

이 경우 같은 계정·같은 분석에 저장한 수집본을 그대로 참조한다. 개발용 시연에는 `{"input":{"kind":"synthetic","fixture":"ingestion-v0"}}`를 보낸다. 작업자가 버전을 고정한 합성 공고와 거래 페이지를 재생해 새 스냅샷을 만든다. 두 입력 모두 작업 중 외부 공고·실거래 API를 호출하지 않는다. [합성 수집 자료](../../tests/fixtures/ingestion-v0.json)

새 공고는 목록의 선택 가능한 주택형이 제공하는 `analysisInput`을 그대로 전달한다. 예시는 합성 식별자다.

```json
{
  "input": {
    "kind": "notice",
    "noticeSource": "applyhome_apt",
    "houseManageNo": "9900000101",
    "noticeNo": "9900000101",
    "edition": "2026-10-30",
    "modelNo": "01"
  }
}
```

접수 시점의 한국 날짜, 공고·주택형과 공식 지역이 실행에 고정된다. 작업자는 해당 공고와 주택형을 확인한 뒤 그 지역의 기본 최근 1년 매매·분양권·입주권을 수집한다. PDF 이용 조건이 확인된 환경에서만 문서를 요청한다. 공식 모델을 다시 확인할 수 없으면 작업을 마치고 그 이유를 기록한다. 거래를 조회했더라도 공급면적 근거가 부족하면 결과에 보류를 표시한다. [오늘 목록과 선택 규칙](notice-directory.md)

### 상태와 오류를 표시한다

세 경로는 `runId`, `analysisId`, `input`, `status`, `attempt`, `submittedAt`, `finishedAt`, `snapshotId`, `errorCode`를 같은 형태로 반환한다. 접수 시 `attempt`는 0이다. 종료 전의 `finishedAt`, 자료가 준비되기 전의 `snapshotId`, 실패 사유가 없는 `errorCode`는 모두 `null`이다.

| 받은 상태 | 사용자에게 표시할 내용 |
| --- | --- |
| `queued` / `running` / `retry_wait` | 접수됨 / 수집 입력 준비 중 / 재시도 대기 중 |
| `finished` | “수집 자료 준비됨”과 `snapshotId`로 연결한 당시의 근거 |
| `failed` | 실행 실패. `run_internal_error` 또는 `run_deadline_exceeded`를 읽고 새 실행을 제안할 수 있다. |
| `cancelled` | 사용자가 취소함. 이전에 저장해 둔 다른 실행의 수집본은 계속 읽을 수 있다. |

공고 선택 실행에서 `failed`이면 `errorCode`도 읽는다. `notice_selection_unverified`는 공고나 주택형을 다시 확인해야 한다는 뜻이다. `notice_feed_unavailable`은 제공기관 조회 실패, `notice_source_restricted`는 사용 권한 보류, `notice_capture_limit`은 수집 시간·요청 한도 도달이다. 접수 자체가 409이면 `notice_index_not_ready`, `notice_edition_mismatch`, `notice_model_not_found` 등 응답 사유에 따라 목록을 갱신해 다시 선택한다. `analysis_notice_selection_conflict`일 때는 이전 분석의 선택을 유지하고 새 초안에서 시작한다.

현재 실행기의 `finished`는 수집본과 비교 결과가 저장됐다는 뜻이다. 실거래의 공급면적 대응, 지역 확대와 자료의 완전성은 결과 주소에서 확인한다. 이전 실행기가 수집본만 저장한 경우 같은 주소에서 409가 반환된다. [저장된 비교 결과](comparison-v1.md)

오류 본문은 `{error, requestId}`다. 로그인·세션 오류는 401, 다른 계정·다른 분석·없는 자료는 404다. 같은 멱등 키를 다른 입력에 사용하거나 종료한 실행을 취소하면 409가 온다. 본문과 식별자 오류는 400, 4 KiB를 넘는 접수 본문은 413, 지원하지 않는 미디어 형식은 415다. 새 실행 요청이 계정당 60초에 12건을 넘으면 429와 `Retry-After`가 온다. 같은 요청의 상태 재확인과 취소는 이 한도에 포함되지 않는다. 503 또는 연결 끊김으로 접수 여부가 모호하면 같은 키와 본문을 다시 보낸다.

## 개발 작업자를 실행한다

별도 작업자 프로세스에 개발 DB의 `SUPABASE_URL`, `SUPABASE_WORKER_KEY`, `APP_ENV=development`를 주입한다. 선택한 공고를 실제 수집할 때는 이 프로세스에 공공데이터포털의 `DATA_GO_KR_SERVICE_KEY`를 제공한다. 사용자 HTTP 서버는 publishable key와 사용자 세션만 사용한다.

```sh
# 선택한 공고 한 건을 실제 제공기관에서 수집한다.
python3 scripts/run_analysis_worker.py --once --live --run-id "$RUN_ID"
```

이 명령은 지정한 실행만 인수한다. 이미 처리했거나 아직 인수할 수 없으면 `{"status":"idle"}`이다. 기존 수집본이나 합성 예시 한 건은 `--live` 없이 실행할 수 있다. 개발 큐에서 새 공고와 기존 입력을 함께 처리하는 상시 명령은 `python3 scripts/run_analysis_worker.py --watch --live`다. 개발 Mac 로그인 서비스도 같은 작업자 진입점을 사용하며, 프로세스가 종료되면 `launchd`가 다시 띄운다. [Python 실행기](../../scripts/run_analysis_worker.py) · [개발 Mac 서비스 운영](notice-operations.md)

DB의 실행 행은 대기열 역할도 한다. 접수 때 조건·규칙 버전과 기준 시점을 고정하고, 작업자 인수 때 시도 번호와 임대 정보를 갱신한다. 기본 임대는 60초이며 개발 검사에서는 1~300초로 지정할 수 있다. DB는 현재 세대와 임대 토큰·유효 시간을 확인한 뒤 스냅샷 연결과 실행 종료를 한 트랜잭션으로 기록한다. 응답이 끊겨도 수집본을 덮어쓰지 않는다. 재시도 가능한 실패에는 1초·2초 대기를 적용하고, 최대 세 번째 인수까지 허용한다. 작업자가 중단되면 임대 만료 후 다른 작업자가 이어받는다. 취소되거나 부모 분석이 삭제되면 이전 작업자가 결과를 쓸 수 없다.

기존 분석은 이전 상태를 보존한다. 새 실행이 있는 분석의 요약 상태는 가장 최근에 접수한 실행을 따른다. 재시도 대기는 `queued`, 입력 준비 완료는 `input_ready`, 취소는 `cancelled`다. 각 실행의 상세 이력은 해당 실행 ID로 조회한다. 처리량·외부 API 비용·PDF 작업 시간을 측정한 뒤 운영 실행 환경과 한도를 정한다. [개발 계획](../development-plan.md)
