# API 호출 시점과 에이전트 판단 흐름

2026-11-13 · 설계 보완 · [전체 구성도](agent-architecture.md)

## 1. 기준과 구현 상태

첨부 이미지의 판단 루프·데이터 확보·단일 공고 검증 구조를 반영하되 제품 범위는 최신 [PRD](prd/01-product-prd.md)를 따른다. API 이름과 경로는 [조회 설정](api/probes.json), 호출 시점은 [서비스 흐름](service-flow.md), 데이터 한계는 [확보 대응표](api/data-requirements.md)를 대조했다. 경로는 저장소 등록 기준이며 이번에 외부 API를 실호출하거나 운영 가용성을 재검증하지 않았다. 과거 10서비스·14조회 확인은 제품 통합 완료가 아니다. 호출 시점은 설계 제안이다.

## 2. 총괄 판단 루프

요청·승인된 조건 확인 → 필요한 자료와 부족한 근거 판단 → 조회/검색/계산 도구 선택 → 코드로 수집 완전성·적용 대상·비교 적절성 검증 → 추가 조회 / 사용자 질문 / 해당 판정 보류 / 종료 → 출처·가정·미확인·다음 행동 정리.

지역 확대·금액 계산·승인·권한은 코드가 통제한다. 부족한 후보 수나 오류 때문에 조건을 조용히 완화하지 않는다. 일시 오류만 제한 재시도하며 인증 오류·공급면적 근거 부재·출처 충돌을 무한 호출이나 모델 추측으로 해결하지 않는다. 호출 상한·시간/비용 예산은 D-07에서 정한다.

## 3. 외부 API 14개: 언제·무엇을 호출하는가

인증값은 포함하지 않는다. 파라미터는 저장소 진단 설정에 등장하는 이름이며 제품 요청의 전체 명세를 뜻하지 않는다. 공고·주택관리·모델 식별자의 연결 검증은 별도로 수행한다.

| API 이름 / 조회 ID | 호출 계기 | 주요 설정 파라미터 | 사용하는 반환값 |
| --- | --- | --- | --- |
| 청약홈 APT 분양정보 상세조회 · `applyhome_apt` | 공고 수집·갱신 | page · perPage · returnType | 공고번호 · 주택관리번호 · 주택명 · 주소 · 공고일 · 접수시작 |
| 청약홈 잔여세대 분양정보 상세조회 · `applyhome_remainder` | 공고 수집·갱신 | page · perPage · returnType | 공고번호 · 주택관리번호 · 주택명 · 주소 · 공고일 · 공고링크 |
| 청약홈 APT 주택형 조회 · `applyhome_apt_model` | 공고 수집·갱신 | page · perPage · returnType | 공고번호 · 주택관리번호 · 모델번호 · 주택형 · 공급면적 · 주택형별_분양최고금액_만원 |
| 청약홈 잔여세대 주택형 조회 · `applyhome_remainder_model` | 공고 수집·갱신 | page · perPage · returnType | 공고번호 · 주택관리번호 · 모델번호 · 주택형 · 공급면적 · 주택형별_분양최고금액_만원 |
| 국토교통부 아파트 매매 실거래가 상세 자료 · `apt_trade` | 비교 실행: 부족한 지역·월·페이지 수집 | LAWD_CD · DEAL_YMD · pageNo · numOfRows | 단지명 · 거래단지식별자 · 가격 · 전용면적 · 계약년 · 계약월 |
| 국토교통부 아파트 분양권전매 실거래가 자료 · `apt_rights` | 비교 실행: 부족한 지역·월·페이지 수집 | LAWD_CD · DEAL_YMD · pageNo · numOfRows | 단지명 · 가격 · 전용면적 · 계약년 · 계약월 · 계약일 |
| 카카오 로컬 주소 검색 · `kakao_address` | 공고·후보·목적지 주소 확인 | query · analyze_type · page · size | 주소 · 경도 · 위도 · 법정동코드 · 행정동코드 |
| K-apt 시군구별 공동주택 목록 · `apt_list` | 단지 식별·특성 보완: 목록→기본정보 | sigunguCode · pageNo · numOfRows | 단지코드 · 단지명 · 법정동코드 · 시도 · 시군구 · 법정동 |
| K-apt 공동주택 기본 정보 · `apt_basic` | 단지 식별·특성 보완: 목록→기본정보 | kaptCode | 단지코드 · 단지명 · 법정동주소 · 도로명주소 · 법정동코드 · 사용승인일 |
| 건축HUB 건축물대장 표제부 · `building_title` | K-apt 누락·특성 충돌 보완 | sigunguCd · bjdongCd · platGbCd · bun · ji · _type · numOfRows · pageNo | 대장식별자 · 건물명 · 동명 · 지번주소 · 도로명주소 · 대장종류 |
| 국가법령정보센터 법령 검색 · `law_search` | 공고 조건·적용 시점 확보: 검색→본문 | target · type · query · display · nw · page | 법령명 · 법령ID · 시행일 · 상세링크 · 법령일련번호 · 현행연혁코드 |
| 국가법령정보센터 법령 본문 · `law_body` | 공고 조건·적용 시점 확보: 검색→본문 | target · type | 조문번호 · 조문제목 · 조문내용 · 조문시행일 |
| NAVER API HUB 뉴스 검색 · `news_search` | 공고 지역·단지 검색어 확보 | query · display · sort · format | 제목 · 발췌 · 원문링크 · 제공시각 |
| ODsay 대중교통 길찾기 · `odsay_route` | 목적지·좌표·수단 확인 후 경로 요청 | SX · SY · EX · EY · output | 경로유형 · 소요시간 · 도보거리 · 요금 |

### 등록 엔드포인트

- **청약홈 APT 분양정보 상세조회** (`applyhome_apt`): [`/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail`](https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail)
- **청약홈 잔여세대 분양정보 상세조회** (`applyhome_remainder`): [`/api/ApplyhomeInfoDetailSvc/v1/getRemndrLttotPblancDetail`](https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getRemndrLttotPblancDetail)
- **청약홈 APT 주택형 조회** (`applyhome_apt_model`): [`/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancMdl`](https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancMdl)
- **청약홈 잔여세대 주택형 조회** (`applyhome_remainder_model`): [`/api/ApplyhomeInfoDetailSvc/v1/getRemndrLttotPblancMdl`](https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/getRemndrLttotPblancMdl)
- **국토교통부 아파트 매매 실거래가 상세 자료** (`apt_trade`): [`/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev`](https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev)
- **국토교통부 아파트 분양권전매 실거래가 자료** (`apt_rights`): [`/1613000/RTMSDataSvcSilvTrade/getRTMSDataSvcSilvTrade`](https://apis.data.go.kr/1613000/RTMSDataSvcSilvTrade/getRTMSDataSvcSilvTrade)
- **카카오 로컬 주소 검색** (`kakao_address`): [`/v2/local/search/address.json`](https://dapi.kakao.com/v2/local/search/address.json)
- **K-apt 시군구별 공동주택 목록** (`apt_list`): [`/1613000/AptListService4/getSigunguAptList4`](https://apis.data.go.kr/1613000/AptListService4/getSigunguAptList4)
- **K-apt 공동주택 기본 정보** (`apt_basic`): [`/1613000/AptBasisInfoServiceV5/getAphusBassInfoV5`](https://apis.data.go.kr/1613000/AptBasisInfoServiceV5/getAphusBassInfoV5)
- **건축HUB 건축물대장 표제부** (`building_title`): [`/1613000/BldRgstHubService/getBrTitleInfo`](https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo)
- **국가법령정보센터 법령 검색** (`law_search`): [`/DRF/lawSearch.do`](https://www.law.go.kr/DRF/lawSearch.do)
- **국가법령정보센터 법령 본문** (`law_body`): [`/DRF/lawService.do`](https://www.law.go.kr/DRF/lawService.do)
- **NAVER API HUB 뉴스 검색** (`news_search`): [`/search/v1/news`](https://naverapihub.apigw.ntruss.com/search/v1/news)
- **ODsay 대중교통 길찾기** (`odsay_route`): [`/v1/api/searchPubTransPathT`](https://api.odsay.com/v1/api/searchPubTransPathT)

## 4. 단계별 호출과 재사용

1. **탐색 전 공통 준비 / 누락 보완:** 청약홈 공고 → 해당 주택형 → 공식 상세 페이지의 PDF 확보·추출·점검. 매 검색마다 4개 조회를 무조건 실행하지 않는다. 자동 PDF 확보 실패 시 사용자 업로드로 보완하며 회차·정정·호실·가격·옵션·페이지를 동일하게 점검한다.
2. **선택 공고·주택형 분석:** 조건 고정 → 필요한 매매/권리 거래의 지역·월·전체 페이지 수집 → 해제·계약일 확인 → 카카오·K-apt·대장으로 필요한 후보의 식별/특성 보완 → 공식 공급면적 대응 확인 → 지역 판정·5단지 선정·종류별 통계. K-apt는 목록의 kaptCode를 확인한 뒤 기본정보를 조회한다.
3. **법령:** 공고 조건과 적용 기준시점 확보 → lawSearch.do → 시행 버전 선택 → lawService.do. 본문에는 선택한 MST·efYd 등 버전 조건을 적용하며 ID만으로 현행 본문을 받아 과거 공고에 적용하지 않는다.
4. **뉴스:** 공고 지역·단지·검색어 확보 후 조회. 법령·뉴스는 비교 완료를 기다릴 필요 없이 독립 실행 가능하다.
5. **교통:** 목적지·출발/도착 좌표·수단별 요청 조건 확보 후 조회. 목적지 변경은 주소/경로만 갱신하며 실거래 전체를 다시 조회하지 않는다.
6. **저장·재열기·PDF:** 같은 결과 버전을 복원하며 이 동작만으로 외부 부동산 API를 다시 호출하지 않는다.
7. **조건 변경·최신 재분석:** 사용자 확인 후 새 실행. 기존 자료가 덮지 못하는 범위·종류·갱신 대상만 조회한다. 자금만 변경하면 자체 재계산한다.

재사용은 출처별 이용 허용 + 수집 완전성 + 입력/자료 버전 일치 + 정해질 최신성 기준을 모두 충족할 때만 한다. 수집 주기·TTL은 미정이다. 같은 구 자료가 이미 완전하면 동→구 확대는 새 API 호출 없이 판정 범위만 바꾼다. 전체 정상 0개일 때만 확대하고 자체 거래는 주변 후보 수에서 제외한다.

## 5. API가 아닌 처리·미확보 경로

| 항목 | 경계 |
| --- | --- |
| 공식 PDF | 전용 PDF API가 아니라 공식 상세 페이지·첨부 확보 경로. 추출 성공과 자동 점검 통과는 다름 |
| 공급면적 대응 | 공식 자료 경로 미정. 실거래 전용면적·K-apt·건축물대장 표제부를 공급면적 대응 API로 취급하지 않음 |
| 자동차 경로 | 초기 기능이지만 제공자·API 미선정. 카카오 로컬 주소 검색이나 ODsay 대중교통으로 대체하지 않음 |
| 예산·자금·통계·직선거리 | 자체 코드 계산. 은행·대출심사·세금 API가 연결된 것으로 표시하지 않음 |
| RAG | 채택 시 이용 가능한 PDF/법령을 회차·시행일·계정 권한으로 필터하고 페이지/조항 근거를 반환 |
| LLM | 조건 추출·계획·근거 설명 시 호출. PRD §7.6의 기준 모델 선정 제안과 실호출 검증을 구분. 호출 API/SDK 계약은 구현 시 확정 |
| 뉴스 | 현재 제목·발췌·링크 검색. 전문 수집·LLM 요약·보관은 이용 조건 확인 필요 |

주택형 API 최고금액은 호실 가격이 아니다. 예산은 확인된 분양가+필수 옵션으로 판정한다. 권리 거래금액은 프리미엄이 아니며 매매와 합산하지 않는다. K-apt 세대수와 대장 세대수가 충돌하면 양쪽 출처·집계 범위를 보존한다. ODsay 오류나 도보시간 -1을 정상 0분으로 표시하지 않는다.

## 6. 서비스 내부 API와 Colab

| 호출 | 시점·용도 | 상태 |
| --- | --- | --- |
| Supabase Auth | 로그인·세션 | 기존 기반, 실제 제품 로그인 통합 검수 별도 |
| GET /api/v1/me | 로그인 후 프로필 확인 | 문서상 기존 조회 API |
| GET /api/health · GET /api/ready | 서버 생존·인증된 준비 상태 확인 | 분석 성공을 뜻하지 않음 |
| Supabase Data API | 허용된 자기 대화·분석·자금 자료 접근 | 사용자 JWT·RLS 유지 |
| decide_profile_change RPC | 명시적 프로필 승인/거절/취소 | 기존 계약. 기준 버전 충돌 시 재검토 |
| POST /api/v1/notice-searches 및 결과 조회 | 조건 기반 탐색 요청 | 개발 계획의 제안, 미구현 |
| POST /api/v1/analyses/{id}/runs · GET /api/v1/runs/{id} | 분석 접수·진행/결과 조회 | 개발 계획의 제안, 미구현 |
| POST /api/v1/runs/{id}/cancel | 사용자 취소 | 개발 계획의 제안, 미구현 |
| Colab 공통 코어 직접 실행 | 고정 자료 재현·평가 | 계획, 미구현. 고정 자료 모드는 데이터 API 대신 자료 어댑터 사용 |

업로드·보고서·삭제의 상세 API 경로는 확정 전이다. Colab 실제 LLM 실행과 무인증 응답 대역 검사를 구분하며 서비스 Auth·RLS·영속 실행 검증을 대체하지 않는다.

## 7. 첨부 이미지 반영과 범위 차이

| 첨부 내용 | 반영 또는 보류 |
| --- | --- |
| 자료 충분성·비교 적절성 확인과 추가 조회/질문 | 총괄 판단 루프·다음 행동으로 추가 |
| 현금·최대 구매금액·입주시점 | 예산 상한과 보유/추가 자금을 분리. 상세 자금은 분석별 저장 |
| 총취득비용·하락 가정·희망 보유기간·거래 회전율 | 신규 확정 기능으로 승격하지 않음. 제품 결정·계산식·분모/기간 정의와 검증 필요 |
| 개인 자격·제한 | 공고·법령 근거 및 미확인 예외 제공. 개인 적격 자동 확정 금지 |
| 출퇴근을 후속으로 표시 | 최신 PRD에서는 대중교통·연결 도보·자동차 모두 초기 범위 |
| 한 공고 전용 84.9811㎡·호실 가격 확인 | 과거 한 사례로 취급. 공급면적 비교와 혼용하지 않고 필수 옵션을 별도 확인 |
| 공고 API→PDF→동일 단지 권리→주변 매매 | 검증 추적 순서로 활용. 자체 거래는 별도 참고이며 주변의 거래 종류들도 구분 수집 |

각 실행에 공고/모델 식별, 회차·정정 PDF, 호실·필수 옵션, 거래 지역/월/페이지 완전성, 해제 제외, 주소·단지 연결, 공급면적 대응, 법령 버전, 경로 수단별 상태, 출처별 이용 허용을 기록한다. 필드 존재·값 보유·단위·적용 대상 확인을 구분한다. 한 공고 성공을 전체 확보 보장으로 확대하지 않는다.

첨부 캡처 자체는 Git에 올리지 않는다. 실제 API 응답·PDF·개인 자료의 비공개 정책을 유지하며 설정과 검증 요약만 참조한다.
