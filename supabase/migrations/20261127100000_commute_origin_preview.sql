-- 출퇴근 출발지 미리보기(호출 횟수 미증가)와 공급위치 미보고 시 사용자 입력 출발지 경로를 지원한다.
-- 직전 정의: supabase/migrations/20261122124510_analysis_commute.sql

create function private.load_analysis_commute(p_analysis_id uuid, p_snapshot_id uuid, p_consume_quota boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  s public.analysis_input_snapshots%rowtype;
  catalog jsonb; notice jsonb; collection jsonb; target jsonb; field jsonb;
  state text := 'ready'; notice_address text;
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
  else
    if coalesce(field->>'status' = 'reported' and jsonb_typeof(field->'value') = 'string'
      and length(field->>'value') between 1 and 240 and length(btrim(field->>'value')) >= 1
      and field->>'value' !~ '[[:cntrl:]]'
      and coalesce(field->'reasons','[]'::jsonb) = '[]'::jsonb
      and not catalog->'issues' @> '[{"code":"notice_field_conflict","field":"HSSPLY_ADRES"}]'::jsonb,false) then
      notice_address := btrim(field->>'value');
    end if;
    select exists(select 1 from public.source_registry where id='kakao_address'
             and reuse_permission='allowed' and display_permission='allowed'),
           exists(select 1 from public.source_registry where id='odsay_route' and display_permission='allowed'),
           exists(select 1 from public.source_registry where id='kakao_directions' and display_permission='allowed')
      into geocode,transit,driving;
    if coalesce(p_consume_quota, true) and geocode and (transit or driving) then
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
    'noticeAddress',notice_address,'geocode',geocode,'transit',transit,'driving',driving);
end;
$$;

create or replace function private.prepare_analysis_commute(p_analysis_id uuid, p_snapshot_id uuid)
returns jsonb language sql volatile security definer set search_path = '' as $$
  select private.load_analysis_commute(p_analysis_id, p_snapshot_id, true);
$$;

create function private.read_analysis_commute_origin(p_analysis_id uuid, p_snapshot_id uuid)
returns jsonb language sql volatile security definer set search_path = '' as $$
  select private.load_analysis_commute(p_analysis_id, p_snapshot_id, false);
$$;

create or replace function public.prepare_analysis_commute(p_analysis_id uuid, p_snapshot_id uuid)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select private.prepare_analysis_commute(p_analysis_id, p_snapshot_id);
$$;

create function public.read_analysis_commute_origin(p_analysis_id uuid, p_snapshot_id uuid)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select private.read_analysis_commute_origin(p_analysis_id, p_snapshot_id);
$$;

revoke all on function private.load_analysis_commute(uuid,uuid,boolean),
  private.prepare_analysis_commute(uuid,uuid),
  private.read_analysis_commute_origin(uuid,uuid),
  public.prepare_analysis_commute(uuid,uuid),
  public.read_analysis_commute_origin(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.prepare_analysis_commute(uuid,uuid),
  private.read_analysis_commute_origin(uuid,uuid),
  public.prepare_analysis_commute(uuid,uuid),
  public.read_analysis_commute_origin(uuid,uuid)
  to authenticated;
