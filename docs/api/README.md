# API 설정과 검증 도구

10서비스·14조회 설정은 [probes.json](probes.json)에 있다. `params`의 지역·날짜·좌표는 진단 예시이며 제품 기본값이나 사용자 위치가 아니다. 실제 응답 확인 날짜는 각 항목의 `live_verified_date`로 관리한다. [검증 보고서](validation-20261109.md)와 [데이터 대응표](data-requirements.md)를 함께 읽는다.

## 인증값을 설정한다

키는 다음 중 한 곳에서 읽는다. 뒤 항목이 앞 항목을 덮어쓴다.

1. `.secrets/api.env`
2. `.secrets/KEY_NAME.env` 형태의 키별 파일
3. 실행 프로세스의 환경변수

루트 `.env`는 읽지 않는다. 빈 템플릿을 사용할 때는 아래처럼 로컬 비밀 폴더에 복사하고 편집기로 값을 입력한다.

```sh
mkdir -p .secrets
chmod 700 .secrets
cp -n .env.example .secrets/api.env
chmod 600 .secrets/api.env
```

대화형 터미널에서 키 하나를 숨김 입력으로 저장할 수도 있다.

```sh
python3 scripts/store_api_key.py DATA_GO_KR_SERVICE_KEY
python3 scripts/probe_apis.py --check-config
```

`--check-config`는 키 이름별 설정 여부만 출력하며 실제 인증 호출을 하지 않는다. 키를 명령 인자·`--param`·문서·이슈에 넣지 않는다. OpenAI 키는 현재 도구가 읽거나 사용하지 않는다.

| 서비스 묶음을 구분한다 | 설정할 변수 이름을 적는다 | 사용할 조회 이름을 적는다 |
| --- | --- | --- |
| 청약홈 | `DATA_GO_KR_SERVICE_KEY` | `applyhome_apt`, `applyhome_apt_model`, `applyhome_remainder`, `applyhome_remainder_model` |
| 아파트 매매·권리 거래 | 같은 공공 API 키, 서비스별 활용 승인 필요 | `apt_trade`, `apt_rights` |
| K-apt 목록·기본정보 | 같은 공공 API 키, 서비스별 활용 승인 필요 | `apt_list`, `apt_basic` |
| 건축물대장 | 같은 공공 API 키, 서비스별 활용 승인 필요 | `building_title` |
| 카카오 주소 | `KAKAO_REST_API_KEY` | `kakao_address` |
| 국가법령정보 | `LAW_OC` | `law_search`, `law_body` |
| ODsay | `ODSAY_API_KEY` | `odsay_route` |
| NAVER API HUB 뉴스 | `NAVER_API_CLIENT_ID`, `NAVER_API_CLIENT_SECRET` | `news_search` |

NAVER 예제는 API HUB의 `X-NCP-APIGW-API-KEY-ID`·`X-NCP-APIGW-API-KEY` 방식이다. 다른 네이버 API 인증방식의 키와 혼동하지 않는다. 다른 개발자/배포 환경은 본인의 승인·도메인/IP·이용 범위를 확인해야 한다.

## 필요한 범위만 수동 호출한다

아래 명령은 실제 API를 호출하고 `api-evidence/`에 응답을 저장한다. 보관·이용 조건과 인증값을 확인한 다음 실행한다. CI에는 넣지 않는다.

2026-11-09 리뷰에서 인증값 정제의 조건부 응답 손상·이스케이프 제거 누락을 재현했으며 현재 PRD 작업에서는 수정하지 않았다. **추가 실호출 전에 해당 결함을 수정하고 회귀검사한다.** 실제 인증값을 사용하지 않는 기본 검사와 구분한다. [리뷰 보완 추적표](../prd/03-review-resolution.md)

```sh
python3 scripts/probe_apis.py --probe applyhome_remainder --param 'cond[HOUSE_MANAGE_NO::EQ]=2026930040' --param 'cond[PBLANC_NO::EQ]=2026930040'
python3 scripts/probe_apis.py --probe apt_trade --param LAWD_CD=11215 --param DEAL_YMD=202610 --param numOfRows=5
```

단일 조회는 진단용 한 페이지다. 전체 거래 수집 완료로 간주하지 않는다. 법령 본문을 MST로 조회할 때는 시행일 `efYd`가 함께 필요하며 과거 공고의 시점을 맞춰야 한다. ODsay·뉴스는 결과 보관 조건이 미확인인 상태이므로 현재 문서에서 바로 실행할 저장 명령을 제공하지 않는다. [데이터 관리](../data-handling.md) 참조.

월별 수집은 먼저 계획을 확인한다.

```sh
python3 scripts/collect_recent_trades.py --probe apt_trade --lawd-cd 11215 --start 202511 --end 202610 --dry-run
```

`--dry-run`을 제거하면 해당 12개월의 모든 페이지를 실제 수집한다. 권리 거래는 `--probe apt_rights`로 별도 수집한다. `summary.json`·월별 `coverage.json`·`normalized.json`에 페이지 완전성·단위·날짜·해제 상태를 기록한다. 인증/통신/업무 오류와 부분 수집을 정상 0건으로 처리하지 않는다. `ready_for_matching`은 후속 주소·면적 연결 준비 상태이며 최종 비교 승인 상태가 아니다.

도구의 기본 월 범위는 진단 편의값이다. 현행 [PRD §6.5](../prd/01-product-prd.md)의 기본은 조회일까지 최근 1년이며 당월도 포함한다. 필요한 월을 수집한 뒤 실제 계약일로 걸러야 하며, 2026-11-10 조회 예시는 2025-11-11~2026-11-10 양 끝 날짜를 포함한다. 도구의 월 기본값이나 과거 12개월 명령을 제품 기간으로 대체하지 않는다. 윤일·시간대 경계와 갱신 주기는 D-02에서 구체화한다.

## 기본 테스트와 역사적 검증을 구분한다

새 체크아웃에서 바로 실행할 검사:

```sh
python3 -m unittest discover -s scripts -p 'test_*.py' -v
python3 scripts/check_repository.py
```

아래 도구는 원 프로젝트의 비공개 자료가 있어야 실행할 수 있다. 원문이 없는 상태에서 통과 또는 생략 성공으로 표시하지 않는다.

| 도구를 선택한다 | 별도로 필요한 로컬 경로를 확인한다 |
| --- | --- |
| `validate_api_evidence.py` | `api-evidence/20261106_live/`, 기존 manifest의 응답·결과 파일 |
| `validate_pdf_supplement.py` | 위 API 자료, `pdf-evidence/2026930040/`·`2026930019/`의 PDF·출처·추출·검수 자료 |
| `validate_additional_services.py` | 추가 manifest의 6개 실응답 경로. 원문 처리 허용 확인 필요 |
| `validate_comparable_links.py` | 매매·권리 수집 폴더, 대상 공고/PDF, 기존 연결 캡처. 과거 5km 시험 전용 |

과거 연결 시험의 인자는 `--collection`, `--rights-collection`, `--output`이다. 기본은 저장 자료를 재검사하며 `--collect`를 명시하면 누락 캡처를 실제 호출한다. 이 도구로 현행 동→구 검색 검증을 대신하지 않는다. 공개판의 카카오 검사는 계정 ID 상수 대신 증거 내 앱 메타데이터 존재를 검사한다. 원 프로젝트의 과거 검사 결과와 공개 코드의 재실행을 구분한다. 일부 역사적 검증기는 실행 시 정규화 파일·검사 보고서를 다시 쓰므로 보존할 원자료는 별도 복사본에서 다룬다.

PDF를 새로 추출할 때만 선택 의존성을 설치한다.

```sh
python3 -m pip install -r requirements-pdf.txt
python3 scripts/extract_notice_pdf.py pdf-evidence/2026930040/notice.pdf --output pdf-evidence/2026930040/extracted.json
```

이는 이미 로컬에 확보한 PDF를 읽는 예시다. 추출기는 자동 다운로드하거나 46개 항목의 의미 검수를 대신하지 않는다. [PDF 검증](pdf-supplement-validation.md)의 회차·페이지·추출 해시 검수 원칙을 따른다.
