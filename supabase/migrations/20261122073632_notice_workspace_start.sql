-- 목록에서 누른 한 번의 분석 시작을 대화·분석·실행으로 함께 저장한다.
alter table public.analyses add column directory_request_key uuid;
create unique index analyses_directory_request_idx on public.analyses(user_id, directory_request_key)
  where directory_request_key is not null;
grant insert(directory_request_key) on public.analyses to authenticated;

create function public.start_notice_workspace(p_request_key uuid, p_input jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  new_chat_id uuid;
  workspace_id uuid;
  label text;
begin
  if owner_id is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if p_request_key is null or p_input->>'kind' is distinct from 'notice'
    or (p_input->>'noticeNo') is null or (p_input->>'noticeNo') !~ '^[0-9]{10}$'
    or (p_input->>'modelNo') is null or (p_input->>'modelNo') !~ '^[0-9]{1,20}$' then
    raise exception 'invalid_analysis_run_input' using errcode = '22023';
  end if;

  -- 기존 접수 함수와 잠금 순서를 공유한다. 응답이 유실돼도 같은 계정·키면 기존 실행을 읽는다.
  perform pg_advisory_xact_lock(hashtextextended('homecierge:analysis-runs:' || owner_id::text, 0));
  select a.id into workspace_id from public.analyses a
    where a.user_id = owner_id and a.directory_request_key = p_request_key;
  if workspace_id is null then
    label := '공고 ' || (p_input->>'noticeNo') || ' · 주택형 ' || (p_input->>'modelNo');
    insert into public.chats(user_id, title) values(owner_id, label) returning id into new_chat_id;
    insert into public.analyses(user_id, chat_id, title, directory_request_key)
      values(owner_id, new_chat_id, label, p_request_key) returning id into workspace_id;
  end if;
  -- 확인된 계정·공고 회차·주택형·출처·계정 한도 검사를 한 트랜잭션 안에서 적용한다.
  return public.enqueue_analysis_run(workspace_id, p_request_key, p_input);
end;
$$;
revoke all on function public.start_notice_workspace(uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.start_notice_workspace(uuid,jsonb) to authenticated;
