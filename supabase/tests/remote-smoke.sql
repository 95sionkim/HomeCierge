-- 수동 검사 전용: 개발 프로젝트를 확인한 뒤 실행한다. 기본 CI에서 실행하지 않는다.
-- 합성 사용자와 데이터는 한 트랜잭션 안에서 만들고 반드시 롤백한다.
begin;
select set_config('homecierge.smoke_a', gen_random_uuid()::text, true),
       set_config('homecierge.smoke_b', gen_random_uuid()::text, true),
       set_config('homecierge.smoke_chat_b', gen_random_uuid()::text, true);
insert into auth.users(id) values
  (current_setting('homecierge.smoke_a')::uuid),
  (current_setting('homecierge.smoke_b')::uuid);
insert into public.user_profiles(user_id) values
  (current_setting('homecierge.smoke_a')::uuid),
  (current_setting('homecierge.smoke_b')::uuid);
insert into public.chats(id,user_id,title) values
  (current_setting('homecierge.smoke_chat_b')::uuid,
   current_setting('homecierge.smoke_b')::uuid,'합성 롤백 검사');

select set_config('request.jwt.claim.sub',current_setting('homecierge.smoke_a'),true),
       set_config('request.jwt.claims',jsonb_build_object(
         'sub',current_setting('homecierge.smoke_a'),
         'role','authenticated','is_anonymous',false)::text,true);
set local role authenticated;
do $$
declare proposal_id uuid;
begin
  if (select count(*) from public.user_profiles) <> 1 then
    raise exception 'owner_read_isolation_failed';
  end if;
  if exists (select 1 from public.chats where id=current_setting('homecierge.smoke_chat_b')::uuid) then
    raise exception 'foreign_chat_visible';
  end if;
  begin
    insert into public.chats(user_id,title) values
      (current_setting('homecierge.smoke_b')::uuid,'합성 차단 검사');
    raise exception 'foreign_owner_insert_allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.chat_messages(user_id,chat_id,role,content) values
      (current_setting('homecierge.smoke_a')::uuid,
       current_setting('homecierge.smoke_chat_b')::uuid,'user','합성 차단 검사');
    raise exception 'foreign_parent_reference_allowed';
  exception when foreign_key_violation then null;
  end;
  begin
    update public.user_profiles set commute_destination='합성 차단 검사';
    raise exception 'unapproved_profile_update_allowed';
  exception when insufficient_privilege then null;
  end;
  insert into public.profile_change_requests(user_id,base_revision,proposed_changes)
    values(current_setting('homecierge.smoke_a')::uuid,0,
      '{"search_conditions":{"region_codes":["11215"],"budget_max_won":"1000000000"}}')
    returning id into proposal_id;
  if (select revision from public.user_profiles) <> 0 then
    raise exception 'pending_proposal_changed_profile';
  end if;
  perform public.decide_profile_change(proposal_id,'approved');
  if (select revision from public.user_profiles) <> 1 or
     (select search_conditions->>'budget_max_won' from public.user_profiles) <> '1000000000' then
    raise exception 'profile_approval_failed';
  end if;
  begin
    perform public.decide_profile_change(proposal_id,'approved');
    raise exception 'duplicate_decision_allowed';
  exception when invalid_parameter_value then null;
  end;
end;
$$;

reset role;
select set_config('request.jwt.claims',jsonb_build_object(
  'sub',current_setting('homecierge.smoke_a'),
  'role','authenticated','is_anonymous',true)::text,true);
set local role authenticated;
do $$ begin
  if exists (select 1 from public.user_profiles) then
    raise exception 'anonymous_signin_read_allowed';
  end if;
end $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform 1 from public.user_profiles;
    raise exception 'anon_read_allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
rollback;
select 'passed_and_rolled_back' as remote_smoke_result;
