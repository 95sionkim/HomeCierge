-- 한 사용자가 같은 자금 추가를 재전송하면 기존 행을 확인할 수 있다.
-- 기존 입력과 다른 클라이언트는 요청 식별자를 생략할 수 있다.
alter table public.funding_entries add column request_key uuid;
create unique index funding_entry_request_once
  on public.funding_entries (user_id, analysis_id, request_key) where request_key is not null;
grant insert (request_key) on public.funding_entries to authenticated;
notify pgrst, 'reload schema';
