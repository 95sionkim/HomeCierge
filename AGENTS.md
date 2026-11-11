# HomeCierge 개발 지침

- 한국어 문서를 기본으로 한다. 현재 요구의 기준은 `docs/prd/01-product-prd.md`다.
- R은 확정 요구, P는 설계 제안, D는 미정 결정, E는 기존 검증 근거, A는 구현 후 수락 기준이다. 제안·미정·과거 검사 통과를 제품 구현 완료로 바꾸지 않는다.
- 지역 선택은 같은 동(법정동)·읍·면 우선이다. 전체 정상 0개이면 구가 있는 곳은 같은 구, 없는 곳은 같은 시·군으로 확대한다. 소속 코드를 확인하며 후보가 적다는 이유로 보충하거나 거리 반경으로 대체하지 않는다.
- 면적 대응 미확인·주소 충돌·부분 수집·API 오류를 정상 0개로 처리하지 않는다. 공급면적과 전용면적을 혼용하지 않는다.
- `scripts/validate_comparable_links.py`는 과거 5km 시험을 재현하는 도구다. 현행 검색 기능의 구현으로 사용하지 않는다.
- API 키는 `.secrets/` 또는 실행 환경에만 저장한다. 키·비밀번호·OTP·인증 헤더를 코드, 로그, 테스트 자료, 문서에 넣지 않는다.
- 기본 검사는 네트워크와 인증값을 사용하지 않는다. 실호출은 수동 작업이며 API 이용 조건과 요청 범위를 먼저 확인한다.
- 실제 API/PDF 응답과 계정별 운영 기록은 Git에 추가하지 않는다. 테스트 예시는 합성 자료임을 표시한다.
- 공유 프로필 변경과 분석별 조건 변경을 구분한다. 미응답·거절·취소를 승인으로 해석하지 않는다.
- 제품 로직을 바꾸면 관련 R/D/A와 의미 있는 경계 검사를 함께 확인한다. 확정한 공급면적 ±5%·최근접 면적·직선거리 순서를 유지하며 기술 스택·동률 처리·대표 좌표 등 미정값을 조용히 확정하지 않는다.
- 기본 검사: `python3 -m unittest discover -s scripts -p 'test_*.py' -v`, `python3 scripts/check_repository.py`.
- DB·배포 기반은 Supabase와 Vercel을 사용한다. 화면 제작은 별도 팀이 담당하며 현재 연결 계약은 `docs/infrastructure.md`와 `docs/frontend-handoff.md`를 따른다.
- 사용자 API는 publishable key와 사용자 JWT로 RLS를 유지한다. 관리 키로 사용자 요청의 권한 검사를 우회하지 않으며 Preview/Development에 운영 DB 연결을 복사하지 않는다.
- Node·DB 기반 검사: `npm run build`, `npm test`, `npm run test:db`. PGlite 합성 Auth 검사를 실제 Supabase Auth·배포 통합 검사로 바꾸어 설명하지 않는다.
