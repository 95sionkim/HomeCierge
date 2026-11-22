-- 수집본과 같은 트랜잭션에서 원문 없는 납부 일정을 고정한다.
create table private.analysis_funding_schedule_snapshots (
  snapshot_id uuid primary key references public.analysis_input_snapshots(id) on delete cascade,
  schedules jsonb not null check (jsonb_typeof(schedules) = 'array')
);
alter table private.analysis_funding_schedule_snapshots enable row level security;
revoke all on private.analysis_funding_schedule_snapshots from public, anon, authenticated, service_role;

create function private.funding_label_valid(value text, is_room boolean)
returns boolean language sql immutable strict set search_path = '' as $$
  -- 호실은 API와 같은 UTF-16 길이·공백 기준을 적용한다. 주택형은 API 원문 표기를 보존한다.
  select value !~ '[\u0001-\u001F\u007F-\u009F]' and trimmed <> ''
    and case when is_room then
      value = trimmed and length(regexp_replace(value,'[\U00010000-\U0010FFFF]','aa','g')) <= 120
    else length(value) <= 120 end
  from (select btrim(value,U&' \00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') as trimmed) as label;
$$;

create function private.funding_schedule_refs_valid(refs jsonb, official_documents jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(refs) = 'array' then not exists (
    select 1 from jsonb_array_elements(refs) as r(value)
    where not coalesce(private.ingestion_v0_object(r.value,array['document','version','page'])
      and r.value->>'document' ~ '\A[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z'
      and r.value->>'version' ~ '\A[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z'
      and private.ingestion_v0_count(r.value->'page',1,9007199254740991)
      and official_documents @> jsonb_build_array(jsonb_build_object('document',r.value->'document','version',r.value->'version')),
      false)
  ) else false end;
$$;

-- 주택형과 호실의 적용 문제를 확인한다. 면적·소계의 다른 보류 사유는 항목별 검수에 맡긴다.
create function private.funding_room_application_verified(catalog jsonb, room jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select exists (
    select 1 from jsonb_array_elements(catalog->'housingTypes') as m(value)
    where m.value->'modelNo' = room->'modelNo' and m.value->>'status' = 'linked'
      and m.value#>>'{houseType,status}' = 'reported' and m.value#>'{houseType,value}' = room->'houseType'
      and m.value->'evidence' <> '[]'::jsonb
  ) and not exists (
    select 1 from jsonb_array_elements(catalog->'rooms') as r(value)
    where r.value->'room' = room->'room' and r.value->'modelNo' is distinct from room->'modelNo'
  ) and not coalesce(room#>'{subtotal,reasons}' ?| array['room_model_conflict','house_type_mismatch'],false)
    and not exists (
      select 1 from jsonb_array_elements(catalog->'issues') as i(value)
      where i.value->'room' = room->'room' and i.value->>'code' in ('room_model_conflict','house_type_mismatch')
    );
$$;

create function private.check_funding_schedules(p_snapshot public.analysis_input_snapshots, p_schedules jsonb)
returns void language plpgsql stable set search_path = '' as $$
declare
  catalog jsonb := p_snapshot.result_snapshot->'catalog';
  official_documents jsonb;
  schedule jsonb;
  room jsonb;
  price jsonb;
  price_evidence jsonb;
  installment jsonb;
  timing jsonb;
  date_status text;
  trigger_kind text;
  timing_refs jsonb;
  installment_sum numeric;
begin
  if jsonb_typeof(p_schedules) is distinct from 'array' then
    raise exception 'invalid_funding_schedules' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_schedules) as s(value)
    group by s.value->'modelNo',s.value->'houseType',s.value->'room',s.value->'item' having count(*) > 1
  ) then
    raise exception 'duplicate_funding_schedule_scope' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('document',d.document_id,'version',d.version)),'[]'::jsonb)
    into official_documents from public.ingestion_document_versions d
    where d.snapshot_id = p_snapshot.id and d.status = 'accepted'
      and d.acquisition_source = 'official' and d.origin_check = 'confirmed'
      and (d.house_manage_no,d.notice_no,d.edition) = (p_snapshot.house_manage_no,p_snapshot.notice_no,p_snapshot.edition);

  for schedule in select value from jsonb_array_elements(p_schedules) loop
    if not coalesce(private.ingestion_v0_object(schedule,array['modelNo','houseType','room','item','status',
        'totalWon','reasons','evidence','installments'])
      and jsonb_typeof(schedule->'modelNo') = 'string' and schedule->>'modelNo' ~ '\A[0-9]{1,20}\Z'
      and jsonb_typeof(schedule->'houseType') = 'string' and private.funding_label_valid(schedule->>'houseType',false)
      and jsonb_typeof(schedule->'room') = 'string' and private.funding_label_valid(schedule->>'room',true)
      and schedule->>'item' in ('sale_price','required_options')
      and schedule->>'status' in ('confirmed','unverified','conflict')
      and jsonb_typeof(schedule->'reasons') = 'array' and jsonb_typeof(schedule->'installments') = 'array'
      and private.funding_schedule_refs_valid(schedule->'evidence',official_documents),false) then
      raise exception 'invalid_funding_schedule' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(schedule->'reasons') as r(value)
      where jsonb_typeof(r.value) <> 'string' or r.value#>>'{}' !~ '\A[a-z][a-z0-9_]{0,79}\Z') then
      raise exception 'invalid_funding_schedule_reasons' using errcode = '22023';
    end if;

    -- 보류된 PDF 표기도 수집본에 남긴다. 확정 일정에만 카탈로그의 적용 대상과 금액을 요구한다.
    if schedule->>'status' <> 'confirmed' then
      if schedule->'totalWon' is distinct from 'null'::jsonb
        or schedule->'installments' <> '[]'::jsonb or schedule->'reasons' = '[]'::jsonb then
        raise exception 'invalid_held_funding_schedule' using errcode = '22023';
      end if;
      continue;
    end if;

    select r.value into room from jsonb_array_elements(catalog->'rooms') as r(value)
      where (r.value->'modelNo',r.value->'houseType',r.value->'room') =
        (schedule->'modelNo',schedule->'houseType',schedule->'room');
    if room is null then
      raise exception 'funding_schedule_room_mismatch' using errcode = '22023';
    end if;
    if not private.funding_room_application_verified(catalog,room) then
      raise exception 'funding_schedule_room_unverified' using errcode = '22023';
    end if;
    price := case schedule->>'item' when 'sale_price' then room->'salePrice' else room->'requiredOptions' end;
    select jsonb_agg(r.value - 'evidenceIndex') into price_evidence
      from jsonb_array_elements(price->'evidence') as r(value);
    if not coalesce(price->>'status' = 'confirmed' and price->'won' = schedule->'totalWon'
      and schedule->'reasons' = '[]'::jsonb and schedule->'evidence' <> '[]'::jsonb
      and price_evidence @> (schedule->'evidence') and (schedule->'evidence') @> price_evidence,false) then
      raise exception 'funding_schedule_price_mismatch' using errcode = '22023';
    end if;

    installment_sum := 0;
    for installment in select value from jsonb_array_elements(schedule->'installments') loop
      timing := installment->'timing';
      date_status := timing->>'dateStatus';
      trigger_kind := timing->>'trigger';
      timing_refs := timing->'evidence';
      if not coalesce(private.ingestion_v0_object(installment,array['stage','won','timing'])
        and installment->>'stage' in ('deposit','interim','balance')
        and jsonb_typeof(installment->'won') = 'string' and installment->>'won' ~ '\A[1-9][0-9]{0,19}\Z'
        and private.ingestion_v0_object(timing,array['trigger','dateStatus','date','evidence'])
        and timing ? 'trigger' and private.funding_schedule_refs_valid(timing_refs,official_documents)
        and (case date_status
          when 'exact' then trigger_kind in ('calendar_date','deadline','contract_signing','move_in')
            and jsonb_typeof(timing->'date') = 'string' and timing->>'date' ~ '\A[0-9]{4}-[0-9]{2}-[0-9]{2}\Z'
            and pg_input_is_valid(timing->>'date','date') and timing_refs <> '[]'::jsonb
          when 'relative' then trigger_kind in ('contract_signing','move_in')
          when 'range' then trigger_kind is null or trigger_kind in ('contract_signing','move_in')
          when 'unverified' then trigger_kind is null or trigger_kind in ('contract_signing','move_in')
          when 'missing' then trigger_kind is null
          else false end)
        and (date_status = 'exact' or (timing->'date' = 'null'::jsonb and timing_refs = '[]'::jsonb)),false) then
        raise exception 'invalid_funding_installment' using errcode = '22023';
      end if;
      -- 같은 판본에서 검산한 일정만 조합한다. 날짜는 같은 판본의 다른 쪽도 인용할 수 있다.
      if date_status = 'exact' and exists (
        (select r.value - 'page' from jsonb_array_elements(schedule->'evidence') as r(value)
          except select r.value - 'page' from jsonb_array_elements(timing_refs) as r(value))
        union all
        (select r.value - 'page' from jsonb_array_elements(timing_refs) as r(value)
          except select r.value - 'page' from jsonb_array_elements(schedule->'evidence') as r(value))
      ) then
        raise exception 'funding_installment_document_mismatch' using errcode = '22023';
      end if;
      installment_sum := installment_sum + (installment->>'won')::numeric;
    end loop;
    if installment_sum <> (schedule->>'totalWon')::numeric then
      raise exception 'funding_installment_sum_mismatch' using errcode = '22023';
    end if;
  end loop;
end;
$$;

create function private.funding_schedule_sources(notice_source text)
returns text[] language sql immutable set search_path = '' as $$
  select array[notice_source,notice_source || '_model','applyhome_notice_pdf'];
$$;

create function private.save_funding_schedule_snapshot(
  p_user_id uuid, p_analysis_id uuid, p_capture_key uuid, p_input jsonb, p_result jsonb, p_schedules jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  existing_id uuid;
  snapshot_id uuid;
  snapshot public.analysis_input_snapshots%rowtype;
  saved_schedules jsonb;
begin
  -- 기존 저장 경로와 같은 부모 잠금을 사용해 이전 캡처 확인부터 일정 저장까지 직렬화한다.
  perform 1 from public.analyses a where (a.id,a.user_id) = (p_analysis_id,p_user_id) for no key update;
  if not found then
    raise exception 'ingestion_analysis_owner_mismatch' using errcode = '23503';
  end if;
  select s.id into existing_id from public.analysis_input_snapshots s
    where (s.user_id,s.analysis_id,s.capture_key) = (p_user_id,p_analysis_id,p_capture_key);
  -- SECURITY DEFINER에서도 실행 ID 캡처는 임대 검증을 하는 finish RPC에 한정한다.
  if existing_id is null and exists (select 1 from private.analysis_runs r where r.id = p_capture_key) then
    raise exception 'analysis_run_fence_required' using errcode = '42501';
  end if;

  snapshot_id := public.save_ingestion_snapshot(p_user_id,p_analysis_id,p_capture_key,p_input,p_result);
  if existing_id is not null then
    select s.schedules into saved_schedules from private.analysis_funding_schedule_snapshots s where s.snapshot_id = existing_id;
    if coalesce(saved_schedules,'[]'::jsonb) is distinct from p_schedules then
      raise exception 'funding_schedule_capture_conflict' using errcode = '23505';
    end if;
    return snapshot_id;
  end if;

  select * into snapshot from public.analysis_input_snapshots s where s.id = snapshot_id;
  perform private.check_funding_schedules(snapshot,p_schedules);
  if snapshot.data_origin = 'collected' and p_schedules <> '[]'::jsonb then
    perform private.require_comparison_sources(private.funding_schedule_sources(snapshot.notice_source));
  end if;
  insert into private.analysis_funding_schedule_snapshots(snapshot_id,schedules) values (snapshot_id,p_schedules);
  return snapshot_id;
end;
$$;

create function public.save_funding_schedule_snapshot(
  p_user_id uuid, p_analysis_id uuid, p_capture_key uuid, p_input jsonb, p_result jsonb, p_schedules jsonb
) returns uuid language sql security invoker set search_path = '' as $$
  select private.save_funding_schedule_snapshot(p_user_id,p_analysis_id,p_capture_key,p_input,p_result,p_schedules);
$$;

-- 분석에 명시한 모델·호실이 있으면 조회에서 다시 선택해 덮어쓸 수 없다.
create function private.funding_selection_matches(conditions jsonb, model_no text, room text)
returns boolean language sql immutable set search_path = '' as $$
  select not exists (
    select 1 from (values
      (conditions->'modelNo',to_jsonb(model_no)),
      (conditions#>'{housingType,modelNo}',to_jsonb(model_no)),
      (conditions#>'{comparison,modelNo}',to_jsonb(model_no)),
      (conditions->'room',to_jsonb(room)),
      (conditions#>'{comparison,room}',to_jsonb(room))
    ) as selection(declared,requested)
    where selection.declared is not null and selection.declared is distinct from selection.requested
  );
$$;

create function private.read_analysis_funding_inputs(
  p_analysis_id uuid, p_snapshot_id uuid, p_model_no text, p_room text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  caller_id uuid := auth.uid();
  snapshot record;
  catalog jsonb;
  selected_room jsonb;
  schedule_status text := 'unavailable';
  schedules jsonb := '[]'::jsonb;
  funds jsonb;
begin
  if caller_id is null or coalesce(auth.jwt()->'is_anonymous','false'::jsonb) <> 'false'::jsonb
    or not exists (select 1 from auth.users u where u.id = caller_id and u.confirmed_at is not null
      and u.is_anonymous is false and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= statement_timestamp())) then
    raise exception 'funding_authentication_required' using errcode = '42501';
  end if;

  select s.*,a.conditions_snapshot as current_conditions,a.notice_id as current_notice_id,
    a.housing_type_id as current_housing_type_id,f.schedules as saved_schedules into snapshot
    from public.analysis_input_snapshots s
    join public.analyses a on (a.id,a.user_id) = (s.analysis_id,s.user_id)
    left join private.analysis_funding_schedule_snapshots f on f.snapshot_id = s.id
    where (s.id,s.analysis_id,s.user_id) = (p_snapshot_id,p_analysis_id,caller_id);
  if not found then
    raise exception 'analysis_snapshot_not_found' using errcode = 'PT404';
  end if;
  if p_model_no !~ '\A[0-9]{1,20}\Z' or not private.funding_label_valid(p_room,true) then
    raise exception 'invalid_funding_selection' using errcode = '22023';
  end if;

  -- 실수집 자료의 이용 허가부터 확인해 호실 존재나 일치 여부가 제한 상태를 드러내지 않게 한다.
  if snapshot.saved_schedules <> '[]'::jsonb and snapshot.data_origin = 'collected'
    and not private.comparison_sources_permitted(private.funding_schedule_sources(snapshot.notice_source)) then
    schedule_status := 'source_restricted';
  elsif snapshot.saved_schedules <> '[]'::jsonb then
    catalog := snapshot.result_snapshot->'catalog';
    select r.value into selected_room from jsonb_array_elements(catalog->'rooms') as r(value)
      where (r.value->>'modelNo',r.value->>'room') = (p_model_no,p_room);
    -- 기존 카탈로그 UUID를 공고 번호쌍·회차에 대응시키는 근거는 별도로 확인해야 한다.
    if snapshot.target_binding_status <> 'matched'
      or snapshot.notice_id is not null or snapshot.housing_type_id is not null
      or snapshot.current_notice_id is not null or snapshot.current_housing_type_id is not null
      or snapshot.current_conditions->'ingestion_target' is distinct from snapshot.conditions_snapshot->'ingestion_target'
      or not private.funding_selection_matches(snapshot.conditions_snapshot,p_model_no,p_room)
      or not private.funding_selection_matches(snapshot.current_conditions,p_model_no,p_room)
      or selected_room is null or not private.funding_room_application_verified(catalog,selected_room) then
      schedule_status := 'selection_unverified';
    else
      select coalesce(jsonb_agg(s.value order by s.position),'[]'::jsonb) into schedules
        from jsonb_array_elements(snapshot.saved_schedules) with ordinality as s(value,position)
        where (s.value->>'modelNo',s.value->>'room') = (p_model_no,p_room)
          and s.value->'houseType' = selected_room->'houseType';
      if schedules <> '[]'::jsonb then
        schedule_status := 'available';
      end if;
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'kind',f.kind,'amountWon',f.amount_won::text,
    'availableOn',f.available_on,'certainty',f.certainty) order by f.available_on,f.id),'[]'::jsonb)
    into funds from public.funding_entries f where (f.analysis_id,f.user_id) = (p_analysis_id,caller_id);
  return jsonb_build_object('analysisId',p_analysis_id,'snapshotId',p_snapshot_id,'modelNo',p_model_no,'room',p_room,
    'dataOrigin',snapshot.data_origin,'scheduleStatus',schedule_status,'schedules',schedules,'funds',funds);
end;
$$;

create function public.read_analysis_funding_inputs(
  p_analysis_id uuid, p_snapshot_id uuid, p_model_no text, p_room text
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.read_analysis_funding_inputs(p_analysis_id,p_snapshot_id,p_model_no,p_room);
$$;

revoke all on function private.funding_label_valid(text,boolean), private.funding_schedule_refs_valid(jsonb,jsonb),
  private.funding_room_application_verified(jsonb,jsonb),
  private.check_funding_schedules(public.analysis_input_snapshots,jsonb), private.funding_schedule_sources(text),
  private.funding_selection_matches(jsonb,text,text),
  private.save_funding_schedule_snapshot(uuid,uuid,uuid,jsonb,jsonb,jsonb),
  public.save_funding_schedule_snapshot(uuid,uuid,uuid,jsonb,jsonb,jsonb),
  private.read_analysis_funding_inputs(uuid,uuid,text,text),
  public.read_analysis_funding_inputs(uuid,uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function private.save_funding_schedule_snapshot(uuid,uuid,uuid,jsonb,jsonb,jsonb),
  public.save_funding_schedule_snapshot(uuid,uuid,uuid,jsonb,jsonb,jsonb) to service_role;
grant execute on function private.read_analysis_funding_inputs(uuid,uuid,text,text),
  public.read_analysis_funding_inputs(uuid,uuid,text,text) to authenticated;
