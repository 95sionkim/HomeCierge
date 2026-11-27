-- PostgREST는 STABLE·IMMUTABLE 함수를 읽기 전용 트랜잭션에서 실행한다.
-- 업로드 보완 문맥·실행 조회는 공통 로그인 확인(private.require_notice_run_user)이 Auth 사용자 행을
-- FOR SHARE로 잠그므로 실제 Supabase에서 25006(cannot execute SELECT FOR SHARE in a read-only
-- transaction)로 실패했다. PGlite 검사는 SQL을 직접 실행해 이 차이를 드러내지 못했다.
-- 두 공개 RPC를 VOLATILE로 바꿔 읽기·쓰기 트랜잭션에서 실행되게 한다. 동작과 권한은 바꾸지 않는다.

alter function public.read_upload_supplement_context(uuid, uuid) volatile;
alter function public.get_upload_supplement_run(uuid, uuid) volatile;
alter function private.read_upload_supplement_context(uuid, uuid) volatile;
alter function private.get_upload_supplement_run(uuid, uuid) volatile;
