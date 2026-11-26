-- 2026-11-26 사용자 결정 Q-43: 에이전트 기준 모델을 gpt-6.1-sol에서 gpt-6.2-sol로 바꾼다.
-- 비교 후보(gpt-6.1-terra, gpt-6-luna, 선택 gpt-6-astra)는 그대로 둔다.
-- 이미 저장된 응답 기록의 모델 이름을 보존하도록 응답 테이블은 gpt-6.1-sol도 계속 허용한다.

alter table private.agent_settings drop constraint agent_settings_model_check;

update private.agent_settings
  set model = 'gpt-6.2-sol', updated_at = clock_timestamp()
  where model = 'gpt-6.1-sol';

alter table private.agent_settings
  alter column model set default 'gpt-6.2-sol',
  add constraint agent_settings_model_check
    check (model in ('gpt-6.2-sol','gpt-6.1-terra','gpt-6-luna','gpt-6-astra'));

alter table private.analysis_agent_replies drop constraint analysis_agent_replies_model_check;

alter table private.analysis_agent_replies
  add constraint analysis_agent_replies_model_check
    check (model in ('gpt-6.2-sol','gpt-6.1-sol','gpt-6.1-terra','gpt-6-luna','gpt-6-astra'));

create or replace function public.configure_agent_settings(
  p_enabled boolean,
  p_model text default 'gpt-6.2-sol'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  updated_row private.agent_settings%rowtype;
begin
  if p_enabled is null or p_model is null
    or p_model not in ('gpt-6.2-sol','gpt-6.1-terra','gpt-6-luna','gpt-6-astra') then
    raise exception 'invalid_agent_settings' using errcode = '22023';
  end if;
  update private.agent_settings
    set enabled = p_enabled,
        model = p_model,
        updated_at = clock_timestamp()
    where singleton is true
    returning * into updated_row;
  return jsonb_build_object(
    'enabled', updated_row.enabled,
    'model', updated_row.model,
    'updatedAt', updated_row.updated_at
  );
end;
$$;

revoke all on function public.configure_agent_settings(boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.configure_agent_settings(boolean, text) to service_role;
