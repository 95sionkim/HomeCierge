-- 작업자 RPC(service_role)의 실행 제한을 60초로 둔다.
-- service_role에는 역할별 제한이 없어 API 접속 역할(authenticator)의 8초가 적용됐다. 큰 지역의 공고 수집본
-- (거래 수천 건) 저장 RPC가 8초를 넘으면 57014로 취소되고, 작업자는 임대가 끝난 뒤 처음부터 다시 수집했다
-- (2026-11-27 개발 DB 로그: 천안 서북구 분석의 finish_notice_with_funding 3회 모두 statement timeout).
-- 사용자 요청 역할(authenticated 8초, anon 3초)은 바꾸지 않는다. PostgREST는 대리 역할의 설정을 요청마다 적용한다.
alter role service_role set statement_timeout = '60s';

notify pgrst, 'reload config';
