-- 목적지와 경로는 조회 기록에 쓰지 않는다. 계정별 호출 횟수만 제한한다.
create table private.commute_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  attempts integer not null check (attempts between 1 and 6)
);
alter table private.commute_attempts enable row level security;
revoke all on private.commute_attempts from public, anon, authenticated, service_role;

create function private.prepare_analysis_commute(p_analysis_id uuid, p_snapshot_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  s public.analysis_input_snapshots%rowtype;
  catalog jsonb; notice jsonb; collection jsonb; target jsonb; field jsonb;
  state text := 'ready'; origin_address text;
  geocode boolean := false; transit boolean := false; driving boolean := false;
begin
  if caller is null or coalesce(auth.jwt()->>'is_anonymous','false') <> 'false'
    or not exists (select 1 from auth.users u where u.id = caller and u.confirmed_at is not null
      and u.is_anonymous is false and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= statement_timestamp()) for share) then
    raise exception 'commute_authentication_required' using errcode = '42501';
  end if;
  select * into s from public.analysis_input_snapshots
    where (id,analysis_id,user_id) = (p_snapshot_id,p_analysis_id,caller) for key share;
  if not found then raise exception 'analysis_snapshot_not_found' using errcode = 'PT404'; end if;
  catalog := s.result_snapshot->'catalog';
  notice := catalog->'notice';
  collection := catalog#>'{collections,notice}';
  target := jsonb_build_object('houseManageNo',s.house_manage_no,'noticeNo',s.notice_no,'edition',s.edition);
  field := notice#>'{fields,HSSPLY_ADRES}';
  if s.data_origin = 'synthetic' then
    state := 'synthetic_input';
  elsif not private.comparison_sources_permitted(array[s.notice_source]) then
    state := 'source_restricted';
  elsif not coalesce(s.target_binding_status = 'matched' and s.notice_id is null and s.housing_type_id is null
    and s.notice_source in ('applyhome_apt','applyhome_remainder')
    and s.conditions_snapshot->'ingestion_target' = (target || jsonb_build_object('noticeSource',s.notice_source))
    and s.input_snapshot->'target' = target and s.input_snapshot->>'noticeSource' = s.notice_source
    and s.result_snapshot->'target' = target and s.result_snapshot->>'dataOrigin' = 'collected'
    and catalog->>'contract' = 'applyhome-catalog/v0' and catalog->'target' = target
    and notice->>'source' = s.notice_source and notice->>'status' = 'reported'
    and coalesce(notice->'reasons','[]'::jsonb) = '[]'::jsonb
    and collection @> jsonb_build_object('source',s.notice_source,'status','complete','declaredStatus','complete')
    and collection->'observations' = collection->'inScope'
    and case when jsonb_typeof(notice->'evidence') = 'array' then
      notice->'evidence' @> '[{"collection":"notice"}]'::jsonb
      and collection->'inScope' = to_jsonb(jsonb_array_length(notice->'evidence')) else false end
    and s.result_snapshot->'catalogCollections' @> jsonb_build_array(jsonb_build_object(
      'source',s.notice_source,'status','complete','reasons','[]'::jsonb,'rowsReceived',collection->'inScope',
      'scope',jsonb_build_object('cond[HOUSE_MANAGE_NO::EQ]',s.house_manage_no,'cond[PBLANC_NO::EQ]',s.notice_no)))
    and not catalog->'issues' @> '[{"collection":"notice"}]'::jsonb,false) then
    state := 'selection_unverified';
  elsif not coalesce(field->>'status' = 'reported' and jsonb_typeof(field->'value') = 'string'
    and length(field->>'value') between 1 and 240 and field->>'value' !~ '[[:cntrl:]]'
    and coalesce(field->'reasons','[]'::jsonb) = '[]'::jsonb
    and not catalog->'issues' @> '[{"code":"notice_field_conflict","field":"HSSPLY_ADRES"}]'::jsonb,false) then
    state := 'origin_unverified';
  else
    origin_address := field->>'value';
    select exists(select 1 from public.source_registry where id='kakao_address'
             and reuse_permission='allowed' and display_permission='allowed'),
           exists(select 1 from public.source_registry where id='odsay_route' and display_permission='allowed'),
           exists(select 1 from public.source_registry where id='kakao_directions' and display_permission='allowed')
      into geocode,transit,driving;
    if geocode and (transit or driving) then
      insert into private.commute_attempts as counter(user_id,window_start,attempts)
        values (caller,date_trunc('minute',clock_timestamp(),'UTC'),1)
        on conflict (user_id) do update set window_start = excluded.window_start,
          attempts = case when counter.window_start = excluded.window_start then counter.attempts + 1 else 1 end
        where counter.window_start < excluded.window_start
          or (counter.window_start = excluded.window_start and counter.attempts < 6);
      if not found then raise exception 'commute_rate_limited' using errcode = 'PT429'; end if;
    end if;
  end if;
  return jsonb_build_object('analysisId',p_analysis_id,'snapshotId',p_snapshot_id,'status',state,
    'originAddress',origin_address,'geocode',geocode,'transit',transit,'driving',driving);
end;
$$;

create function public.prepare_analysis_commute(p_analysis_id uuid, p_snapshot_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.prepare_analysis_commute(p_analysis_id,p_snapshot_id);
$$;

-- 화면에서 이전 값과 새 값을 확인한 뒤에만 호출한다. 기존 프로필 버전 검사와 승인을 재사용한다.
create function public.confirm_commute_destination(p_user_id uuid, p_base_revision bigint, p_destination text)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  caller uuid := auth.uid(); profile public.user_profiles%rowtype; proposal uuid;
begin
  if caller is null or caller is distinct from p_user_id or coalesce(auth.jwt()->>'is_anonymous','false') <> 'false' then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if p_base_revision is null or p_base_revision < 0 or (p_destination is not null and
    (length(p_destination) not between 1 and 200 or btrim(p_destination) <> p_destination or p_destination ~ '[[:cntrl:]]')) then
    raise exception 'invalid_destination' using errcode = '22023';
  end if;
  insert into public.user_profiles(user_id) values (caller) on conflict (user_id) do nothing;
  select * into strict profile from public.user_profiles where user_id = caller;
  if profile.commute_destination is not distinct from p_destination then return; end if;
  if profile.revision <> p_base_revision then raise exception 'profile_revision_conflict' using errcode = '40001'; end if;
  insert into public.profile_change_requests(user_id,base_revision,proposed_changes,reason)
    values(caller,p_base_revision,jsonb_build_object('commute_destination',p_destination),'출퇴근 화면에서 변경 확인')
    returning id into proposal;
  perform public.decide_profile_change(proposal,'approved');
end;
$$;
revoke all on function private.prepare_analysis_commute(uuid,uuid), public.prepare_analysis_commute(uuid,uuid),
  public.confirm_commute_destination(uuid,bigint,text) from public, anon, authenticated, service_role;
grant execute on function private.prepare_analysis_commute(uuid,uuid), public.prepare_analysis_commute(uuid,uuid),
  public.confirm_commute_destination(uuid,bigint,text) to authenticated;
