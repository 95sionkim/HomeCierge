# 수집 결과를 분석에 저장하고 다시 읽는다

BE-03은 한 사용자의 분석에 BE-02의 조회 조건과 정규화 결과를 함께 저장한다. 이후 같은 분석을 다시 열면 당시의 공고·주택형, 조건, 문서 버전과 근거 페이지를 확인할 수 있다. 비교 단지의 선정이나 지역 확대 여부는 후속 비교 엔진에서 판정한다. [재생 입력과 출력](ingestion-v0.md)

## 1. 저장과 재시도

1. 로그인한 사용자가 자기 대화에 분석 초안을 만든다. 서버 작업자는 이 분석의 소유자와 분석 ID를 사용한다.
2. 한 번의 수집에 UUID 하나를 붙인다. 수집 작업자가 `save_ingestion_snapshot(p_user_id, p_analysis_id, p_capture_key, p_input, p_result)`를 호출하면 DB가 분석 조건·규칙 버전과 선택한 주택형을 함께 고정하고 스냅샷 UUID를 반환한다. `p_input`은 BE-02의 요청 조건, `p_result`는 버전이 표시된 정규화 결과다.
3. 응답을 받지 못하면 같은 키와 동일한 내용으로 재시도한다. 동일 요청은 처음 저장한 ID를 반환한다. 내용이 달라지면 `23505`로 충돌을 알린다. 이후 시점의 자료를 새로 관측하면 새 키를 사용한다.

기존 분석 하나에 합성 자료를 저장하려면 작업자 프로세스에 `SUPABASE_URL`·`SUPABASE_WORKER_KEY`를 주입하고 아래 명령을 실행한다. 명령은 재생 파일의 원응답을 로컬에서 정규화한 뒤 RPC에 전달하며, 성공 시 `snapshotId`를 반환한다. [작업자 CLI](../../scripts/store_ingestion.py)

```sh
python3 scripts/store_ingestion.py tests/fixtures/ingestion-v0.json \
  --owner-id "$TEST_USER_ID" --analysis-id "$TEST_ANALYSIS_ID" --capture-key "$CAPTURE_KEY"
```

## 2. 사용자 세션으로 근거를 다시 읽는다

화면은 publishable key와 사용자 세션을 사용한다. 단일 캡처는 `analysis_input_snapshots`의 `analysis_id`·`id`로 좁혀 읽는다. 같은 분석의 이전 캡처도 각각 고유한 ID를 가진다. 네 조회 뷰는 `snapshot_id`로 연결하고, 기본 테이블의 행 수준 보안(RLS)을 적용한다.

분석 초안에 공고를 지정할 때 `conditions_snapshot.ingestion_target`에 `noticeSource`, `houseManageNo`, `noticeNo`, `edition`을 담는다. 네 값이 수집 요청과 일치하면 `target_binding_status`는 `matched`가 되고, 다르면 저장을 거부한다. 이전 분석에 공고 ID만 있으면 `unverified`, 대상을 지정하지 않은 초안이면 `unspecified`로 기록한다.

| 무엇을 확인하는가 | 어디에서 읽는가 | 해석할 때 확인할 내용 |
| --- | --- | --- |
| 실행 당시의 입력과 결과 | `analysis_input_snapshots` | `input_snapshot`, `conditions_snapshot`, `rules_version`, `result_snapshot`과 당시 선택한 공고·주택형 |
| 공고·모델·거래 출처별 범위 | `ingestion_collections` | 조회 지역·계약월·보고 건수·수신 행 수·누락·오류. 출처의 빈 응답은 해당 지역의 정상 0개를 증명하지 않는다. |
| 몇 번째 페이지를 받았는가 | `ingestion_collection_pages` | 수집기가 남긴 페이지 계획과 누락을 읽는다. 응답 본문은 보관하지 않는다. |
| 실제로 받은 거래 행 | `ingestion_trade_observations` | 출처·요청 범위와 페이지·행 위치를 보존한다. 같은 값이 두 위치에 등장하면 두 관측으로 남는다. |
| 어느 문서 버전에서 확인했는가 | `ingestion_document_versions`, `result_snapshot.catalog` | 문서 버전·회차·출처 대조 상태, 호실·항목별 원문 페이지, 확정값 또는 보류 사유 |

조회 뷰의 원 단위 금액과 ㎡ 면적은 십진 문자열이다. 화면에서도 긴 값의 자릿수를 보존한다. 수집 시각 `collected_at`에는 원래 UTC 오프셋이 포함된다.

`synthetic`은 합성 시험 자료다. 외부에서 수집한 `collected` 자료는 관련 API·문서 각각의 저장 허용 여부를 점검한다. 출처가 미확인인 실제 자료를 합성으로 표시하지 않는다. 실거래의 공급면적 대응이 미확인이면 저장 후에도 미확인으로 남는다. 다른 계정에서 조회·재사용하거나 보고서로 내보내는 권한은 별도다. [출처별 공식 근거](be-01-evidence.md)

실제 업로드에서 추출한 값은 파일 소유권·버전과 파생 값 삭제를 함께 연결할 때까지 `ingestion_upload_binding_required`로 보류한다. 보관 기한이 있는 출처는 자동 만료를 집행할 수 있을 때까지 `ingestion_retention_enforcement_required`로 보류한다. 두 경우 모두 새 스냅샷을 만들지 않는다.

## 3. 비공개 PDF 파일을 등록하고 삭제한다

사용자 세션으로 다음 순서대로 호출한다. 파일 등록과 바이트 업로드는 별도 단계다. 등록 상태만으로 공식 PDF 대조나 내용 검수가 끝났다고 표시하지 않는다.

| 순서를 따른다 | 호출한다 | 결과를 확인한다 |
| --- | --- | --- |
| 1. 파일을 등록한다 | `register_analysis_upload(analysis_id, upload_id)` | 소유한 분석에 파일 UUID를 등록하고 반환된 `object_path`를 사용한다. |
| 2. 원본을 보낸다 | `storage.from('analysis-uploads').upload(object_path, file, {contentType: 'application/pdf', cacheControl: '0', upsert: false})` | 사용자·분석·파일 UUID로 구분한 비공개 경로에 업로드한다. 정정본은 새 파일 ID로 등록한다. |
| 3. 소유자가 읽는다 | 사용자 JWT로 `GET /api/v1/analyses/{analysisId}/uploads/{uploadId}/content` | 매번 소유권과 등록 상태를 확인한 후 PDF를 스트리밍한다. 미등록·타인·삭제 요청 이후에는 404다. |
| 4. 삭제를 시작한다 | `request_analysis_upload_deletion(analysis_id, upload_id)` | 이 파일의 신규 업로드와 교체를 차단한다. |
| 5. 객체와 등록을 정리한다 | Storage `remove([object_path])` 후 `finalize_analysis_upload_deletion(analysis_id, upload_id)` | 객체가 남아 있으면 완료를 보류한다. 중단되면 같은 파일 ID로 삭제를 재개한다. |

분석·계정 전체를 삭제할 때는 **내 데이터 관리**에서 연관 자료의 영향을 확인한다. 서비스의 파일 삭제와 백업 사본 확인을 각각 기록한다. [개별 자료와 계정 삭제](data-deletion.md) · [Supabase Storage 접근 제어](https://supabase.com/docs/guides/storage/security/access-control)

화면에서 파일을 열거나 다시 받을 때는 3번의 사용자 API 주소를 사용한다. 서울 개발 환경에서는 객체 삭제 후에도 이전에 읽은 Storage 원본 주소가 캐시된 바이트를 반환했다. API는 매 요청에서 등록 상태를 읽고, 접근이 허용된 경우에만 새 `cacheNonce`로 Storage에 요청한다. 원본 주소를 화면에 돌려주지 않는다. 사용자가 이미 내려받은 로컬 사본은 기기에 남을 수 있다. [Supabase CDN 캐시](https://supabase.com/docs/guides/storage/cdn/smart-cdn)

## 4. 실제 자료 검증의 진행 상태

- **거래 공급면적(V1)**. 공식 명세 7개를 검토했고 공고 쪽 공급면적을 직접 제공하는 명세는 1개였다. 실제 거래와 공급면적을 대조한 표본은 0건으로 대응률을 계산할 수 없다. 다음 검증은 단지 하나의 호·주택형별 자료에서 확인·불일치·보류 건수를 기록하는 것이다.
- **공고 문서(V2)**. 같은 회차의 공식 자료와 출처를 확인한 업로드, 다른 회차, 값 충돌, 필수 옵션 누락을 합성 자료로 구분했다. 실제 정정 공고와 원 공고의 첨부 관계, 유형별 서식, 원문 보관 조건은 추가 확인이 필요하다. [V1·V2 후속 조사 항목](be-01-evidence.md)
