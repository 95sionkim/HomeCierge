-- 비교 대화에서 공급면적 허용 범위·거래 종류·단지 직접 교체(및 기간 변경 조합)를 제안·승인하고
-- 작업자 입력 전달 및 결과 저장 시 승인 조건과의 정합성을 DB에서 검증한다.
-- 기존 private.analysis_chat_turns 테이블을 확장하므로 개별/계정 삭제 범위(resolve_turn_deletion_scope)가 그대로 적용된다.

alter table private.analysis_chat_turns
  add column proposed_conditions jsonb,
  add column previous_conditions jsonb,
  add column effective_conditions jsonb;

do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'private.analysis_chat_turns'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%change_period%'
  loop
    execute format('alter table private.analysis_chat_turns drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table private.analysis_chat_turns
  add constraint analysis_chat_turns_intent_v2_check
    check (intent in ('inclusion','holds','scope','price','period','change_period','change_conditions','help')),
  add constraint analysis_chat_turns_proposal_shape_check
    check (
      (
        intent = 'change_period'
        and proposed_start is not null and proposed_end is not null
        and previous_start is not null and previous_end is not null
        and proposal_status is not null
        and proposed_start <= proposed_end
        and previous_start <= previous_end
        and (proposed_start, proposed_end) is distinct from (previous_start, previous_end)
        and proposed_conditions is null and previous_conditions is null
        and (effective_conditions is null or (jsonb_typeof(effective_conditions) = 'object' and effective_conditions <> '{}'::jsonb))
      ) or (
        intent = 'change_conditions'
        and proposed_start is null and proposed_end is null
        and previous_start is null and previous_end is null
        and proposal_status is not null
        and proposed_conditions is not null and jsonb_typeof(proposed_conditions) = 'object'
        and proposed_conditions <> '{}'::jsonb
        and previous_conditions is not null and jsonb_typeof(previous_conditions) = 'object'
        and previous_conditions <> '{}'::jsonb
        and proposed_conditions is distinct from previous_conditions
        and effective_conditions is not null and jsonb_typeof(effective_conditions) = 'object'
        and effective_conditions <> '{}'::jsonb
      ) or (
        intent not in ('change_period','change_conditions')
        and proposed_start is null and proposed_end is null
        and previous_start is null and previous_end is null
        and proposed_conditions is null and previous_conditions is null and effective_conditions is null
        and proposal_status is null and decided_at is null and result_run_id is null
      )
    );

-- 공급면적 허용 오차는 양수 십진수(0 초과, 50 이하, 소수 4자리 이하)로 정규화한다.
create function private.normalize_area_tolerance(p_value jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare
  raw text;
  amount numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then
    return null;
  end if;
  raw := p_value #>> '{}';
  if raw !~ '\A(?:0|[1-9][0-9]*)(?:\.[0-9]{1,4})?\Z' then
    return null;
  end if;
  amount := raw::numeric;
  if amount <= 0 or amount > 50 then
    return null;
  end if;
  if strpos(raw, '.') > 0 then
    raw := rtrim(rtrim(raw, '0'), '.');
  end if;
  return raw;
end;
$$;

-- 거래 종류는 sale, presale_right, occupancy_right의 비어 있지 않은 중복 없는 부분집합을 고정 순서로 정규화한다.
create function private.normalize_trade_kinds(p_value jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  total_count integer;
  distinct_valid integer;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'array' then
    return null;
  end if;
  total_count := jsonb_array_length(p_value);
  if total_count < 1 or total_count > 3 then
    return null;
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_value) as e(val)
    where jsonb_typeof(e.val) <> 'string'
      or (e.val #>> '{}') not in ('sale','presale_right','occupancy_right')
  ) then
    return null;
  end if;
  select count(distinct e.val #>> '{}')::integer into distinct_valid
    from jsonb_array_elements(p_value) as e(val);
  if distinct_valid <> total_count then
    return null;
  end if;
  return (
    select jsonb_agg(to_jsonb(k.kind) order by k.ord)
    from (values ('sale', 1), ('presale_right', 2), ('occupancy_right', 3)) as k(kind, ord)
    where p_value ? k.kind
  );
end;
$$;

-- 단지 직접 교체 목록은 최대 5쌍이며, 중복·자기 교체·교차 순환을 거부하고 결정적 순서로 정렬한다.
create function private.normalize_replacements(p_value jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  total_count integer;
  normalized jsonb;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'array' then
    return null;
  end if;
  total_count := jsonb_array_length(p_value);
  if total_count = 0 then
    return '[]'::jsonb;
  end if;
  if total_count > 5 then
    return null;
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_value) as e(val)
    where jsonb_typeof(e.val) <> 'object'
      or (select count(*) from jsonb_object_keys(e.val)) <> 2
      or not (e.val ? 'complexId' and e.val ? 'replaceComplexId')
      or jsonb_typeof(e.val->'complexId') <> 'string'
      or jsonb_typeof(e.val->'replaceComplexId') <> 'string'
      or char_length(e.val->>'complexId') not between 1 and 120
      or char_length(e.val->>'replaceComplexId') not between 1 and 120
      or e.val->>'complexId' <> btrim(e.val->>'complexId')
      or e.val->>'replaceComplexId' <> btrim(e.val->>'replaceComplexId')
      or e.val->>'complexId' ~ '[\u0000-\u001F\u007F]'
      or e.val->>'replaceComplexId' ~ '[\u0000-\u001F\u007F]'
      or e.val->>'complexId' = e.val->>'replaceComplexId'
  ) then
    return null;
  end if;

  with pairs as (
    select
      e.val->>'complexId' as incoming,
      e.val->>'replaceComplexId' as outgoing
    from jsonb_array_elements(p_value) as e(val)
  )
  select
    case
      when (select count(distinct incoming) from pairs) <> total_count
        or (select count(distinct outgoing) from pairs) <> total_count
        or exists (select 1 from pairs a join pairs b on a.incoming = b.outgoing)
      then null
      else (
        select jsonb_agg(
          jsonb_build_object('complexId', p.incoming, 'replaceComplexId', p.outgoing)
          order by p.outgoing asc, p.incoming asc
        )
        from pairs p
      )
    end
  into normalized;
  return normalized;
end;
$$;

-- 저장된 비교 결과의 comparables에서 현재 적용 중인 수동 교체 쌍을 추출한다.
create function private.extract_run_replacements(p_comparison jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object('complexId', c.val->>'complexId', 'replaceComplexId', c.val->>'replacesComplexId')
        order by c.val->>'replacesComplexId' asc, c.val->>'complexId' asc
      )
      from jsonb_array_elements(coalesce(p_comparison->'comparables', '[]'::jsonb)) as c(val)
      where jsonb_typeof(c.val) = 'object'
        and c.val->>'selectionReason' = 'manual_replacement'
        and jsonb_typeof(c.val->'complexId') = 'string'
        and jsonb_typeof(c.val->'replacesComplexId') = 'string'
        and btrim(c.val->>'complexId') <> ''
        and btrim(c.val->>'replacesComplexId') <> ''
    ),
    '[]'::jsonb
  );
$$;

-- 해당 실행이 합성 데모 수집본인지 확인한다.
create function private.is_demo_snapshot(p_snapshot public.analysis_input_snapshots)
returns boolean language sql stable set search_path = '' as $$
  select p_snapshot.data_origin = 'synthetic' and exists (
    select 1 from private.analysis_runs original
    join private.comparison_results c on c.run_id = original.id
    where (original.id, original.snapshot_id, original.analysis_id, original.user_id) =
      (p_snapshot.capture_key, p_snapshot.id, p_snapshot.analysis_id, p_snapshot.user_id)
      and original.status = 'finished'
      and original.input = '{"kind":"synthetic","fixture":"ingestion-v0"}'::jsonb
  );
$$;

-- 현재 실행에서 편집 가능한 비교 조건의 범위와 제약을 계산한다.
create function private.analysis_condition_bounds(p_owner_id uuid, p_analysis_id uuid, p_run_id uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  analysis_row public.analyses%rowtype;
  base_run record;
  snapshot_row public.analysis_input_snapshots%rowtype;
  is_editable boolean := false;
  period_bounds jsonb := null;
  snapshot_kinds jsonb := '[]'::jsonb;
  area_editable boolean := false;
  replacements_editable boolean := false;
  demo_capture boolean := false;
begin
  select * into analysis_row from public.analyses a
    where (a.id, a.user_id) = (p_analysis_id, p_owner_id);
  select r.*, c.result as comparison_result into base_run
    from private.analysis_runs r
    join private.comparison_results c on c.run_id = r.id and r.status = 'finished'
    where (r.id, r.analysis_id, r.user_id) = (p_run_id, p_analysis_id, p_owner_id);
  if not found or analysis_row.id is null then
    return jsonb_build_object(
      'editable', false,
      'period', null,
      'tradeKinds', '[]'::jsonb,
      'areaToleranceMax', '50',
      'areaEditable', false,
      'replacementsEditable', false
    );
  end if;

  select * into snapshot_row from public.analysis_input_snapshots s
    where (s.id, s.analysis_id, s.user_id) = (base_run.snapshot_id, p_analysis_id, p_owner_id);
  if found then
    demo_capture := private.is_demo_snapshot(snapshot_row);
    is_editable := analysis_row.latest_run_id = base_run.id
      and base_run.notice_id is null and base_run.housing_type_id is null
      and snapshot_row.notice_id is null and snapshot_row.housing_type_id is null
      and (analysis_row.conditions_snapshot, analysis_row.rules_version, analysis_row.notice_id, analysis_row.housing_type_id)
          is not distinct from (base_run.conditions_snapshot, base_run.rules_version, base_run.notice_id, base_run.housing_type_id)
      and (snapshot_row.conditions_snapshot, snapshot_row.rules_version, snapshot_row.notice_id, snapshot_row.housing_type_id)
          is not distinct from (base_run.conditions_snapshot, base_run.rules_version, base_run.notice_id, base_run.housing_type_id);
    if snapshot_row.period_start is not null and snapshot_row.period_end is not null
      and snapshot_row.result_snapshot#>>'{period,status}' = 'confirmed' then
      period_bounds := jsonb_build_object(
        'start', to_char(snapshot_row.period_start, 'YYYY-MM-DD'),
        'end', to_char(snapshot_row.period_end, 'YYYY-MM-DD'),
        'asOf', to_char(snapshot_row.as_of, 'YYYY-MM-DD')
      );
    end if;
    snapshot_kinds := coalesce(private.normalize_trade_kinds(snapshot_row.result_snapshot->'tradeKinds'), '[]'::jsonb);
    area_editable := period_bounds is not null
      and coalesce(
        base_run.comparison_result#>>'{target,supplyArea,status}' = 'confirmed'
        and base_run.comparison_result#>>'{conditions,area,basis}' = 'supply',
        false
      );
    replacements_editable := period_bounds is not null
      and coalesce(base_run.comparison_result->>'appliedScope' in ('priority','expansion'), false)
      and (base_run.comparison_evidence_pinned or demo_capture);
  end if;

  return jsonb_build_object(
    'editable', is_editable,
    'period', period_bounds,
    'tradeKinds', snapshot_kinds,
    'areaToleranceMax', '50',
    'areaEditable', is_editable and area_editable,
    'replacementsEditable', is_editable and replacements_editable
  );
end;
$$;

-- 동일 분석·소유자의 최근 30개 대화, 직전 결과 실행 ID, 편집 가능 조건 범위를 조합한다.
create or replace function private.analysis_conversation_payload(p_owner_id uuid, p_analysis_id uuid, p_run_id uuid)
returns jsonb language sql stable set search_path = '' set timezone = 'UTC' as $$
  with recent as (
    select t.*
    from private.analysis_chat_turns t
    where (t.analysis_id, t.base_run_id, t.user_id) = (p_analysis_id, p_run_id, p_owner_id)
    order by t.turn_order desc
    limit 31
  ),
  windowed as (
    select r.*
    from recent r
    order by r.turn_order desc
    limit 30
  ),
  prev as (
    select t.base_run_id
    from private.analysis_chat_turns t
    join private.analysis_runs base_r
      on (base_r.id, base_r.analysis_id, base_r.user_id) = (t.base_run_id, t.analysis_id, t.user_id)
      and base_r.status = 'finished'
    join private.comparison_results base_c
      on base_c.run_id = base_r.id
    where (t.result_run_id, t.analysis_id, t.user_id) = (p_run_id, p_analysis_id, p_owner_id)
      and t.proposal_status = 'approved'
      and private.comparison_sources_permitted(base_c.source_ids)
  )
  select jsonb_build_object(
    'analysisId', p_analysis_id,
    'runId', p_run_id,
    'previousRunId', (select prev.base_run_id from prev),
    'conditionBounds', private.analysis_condition_bounds(p_owner_id, p_analysis_id, p_run_id),
    'turns', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', w.id,
            'runId', w.base_run_id,
            'message', w.message,
            'intent', w.intent,
            'createdAt', w.created_at,
            'proposal', case
              when w.intent = 'change_period' then jsonb_build_object(
                'start', to_char(w.proposed_start, 'YYYY-MM-DD'),
                'end', to_char(w.proposed_end, 'YYYY-MM-DD'),
                'previousStart', to_char(w.previous_start, 'YYYY-MM-DD'),
                'previousEnd', to_char(w.previous_end, 'YYYY-MM-DD'),
                'status', w.proposal_status,
                'resultRunId', w.result_run_id
              )
              when w.intent = 'change_conditions' then jsonb_build_object(
                'kind', 'conditions',
                'previous', w.previous_conditions,
                'proposed', w.proposed_conditions,
                'effective', w.effective_conditions,
                'status', w.proposal_status,
                'resultRunId', w.result_run_id
              )
              else null
            end
          )
          order by w.turn_order asc
        )
        from windowed w
      ),
      '[]'::jsonb
    ),
    'hasEarlier', (select count(*) > 30 from recent)
  );
$$;

-- 기간 변경 단독 호출(7인자)도 이전 실행에서 이어진 면적·거래 종류·단지 교체 조건을 보존한다.
create or replace function private.submit_analysis_chat_turn(
  p_analysis_id uuid,
  p_run_id uuid,
  p_request_id uuid,
  p_message text,
  p_intent text,
  p_start date default null,
  p_end date default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  trimmed_message text;
  analysis_row public.analyses%rowtype;
  base_run record;
  existing_turn private.analysis_chat_turns%rowtype;
  snapshot_row public.analysis_input_snapshots%rowtype;
  base_period jsonb;
  previous_start date;
  previous_end date;
  carried jsonb := '{}'::jsonb;
  base_area text;
  base_kinds jsonb;
  snapshot_kinds jsonb;
  base_replacements jsonb;
begin
  perform private.require_notice_run_user(owner_id);
  if p_analysis_id is null or p_run_id is null or p_request_id is null
    or p_intent is null
    or p_intent not in ('inclusion','holds','scope','price','period','change_period','help') then
    raise exception 'invalid_analysis_chat_turn' using errcode = '22023';
  end if;
  trimmed_message := private.normalize_analysis_chat_message(p_message);

  if p_intent <> 'change_period' then
    if p_start is not null or p_end is not null then
      raise exception 'invalid_analysis_chat_period' using errcode = '22023';
    end if;
  else
    if p_start is null or p_end is null or p_start > p_end then
      raise exception 'invalid_analysis_chat_period' using errcode = '22023';
    end if;
  end if;

  select * into analysis_row from public.analyses a
    where (a.id, a.user_id) = (p_analysis_id, owner_id) for no key update;
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;

  select r.*, c.result as comparison_result, c.source_ids as comparison_source_ids
    into base_run
    from private.analysis_runs r
    left join private.comparison_results c on c.run_id = r.id and r.status = 'finished'
    where (r.id, r.analysis_id, r.user_id) = (p_run_id, p_analysis_id, owner_id);
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;
  if base_run.comparison_result is null then
    raise exception 'analysis_comparison_not_ready' using errcode = 'PT409';
  end if;
  perform private.require_comparison_chat_sources(base_run.comparison_source_ids);

  select * into existing_turn from private.analysis_chat_turns t
    where (t.analysis_id, t.base_run_id, t.request_id) = (p_analysis_id, p_run_id, p_request_id);
  if found then
    if (existing_turn.message, existing_turn.intent, existing_turn.proposed_start, existing_turn.proposed_end)
       is distinct from (trimmed_message, p_intent, p_start, p_end) then
      raise exception 'analysis_chat_request_conflict' using errcode = 'PT409';
    end if;
    return private.analysis_conversation_payload(owner_id, p_analysis_id, p_run_id);
  end if;

  if p_intent = 'change_period' then
    if analysis_row.latest_run_id is distinct from base_run.id
      or (analysis_row.conditions_snapshot, analysis_row.rules_version, analysis_row.notice_id, analysis_row.housing_type_id)
         is distinct from (base_run.conditions_snapshot, base_run.rules_version, base_run.notice_id, base_run.housing_type_id) then
      raise exception 'analysis_chat_stale_run' using errcode = 'PT409';
    end if;

    select * into snapshot_row from public.analysis_input_snapshots s
      where (s.id, s.analysis_id, s.user_id) = (base_run.snapshot_id, p_analysis_id, owner_id)
      for key share;
    if not found
      or base_run.notice_id is not null or base_run.housing_type_id is not null
      or snapshot_row.notice_id is not null or snapshot_row.housing_type_id is not null
      or (snapshot_row.conditions_snapshot, snapshot_row.rules_version, snapshot_row.notice_id, snapshot_row.housing_type_id)
         is distinct from (base_run.conditions_snapshot, base_run.rules_version, base_run.notice_id, base_run.housing_type_id)
      or snapshot_row.period_start is null or snapshot_row.period_end is null
      or snapshot_row.result_snapshot#>>'{period,status}' is distinct from 'confirmed' then
      raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
    end if;

    base_period := base_run.comparison_result#>'{conditions,period}';
    if not coalesce(
      jsonb_typeof(base_period) = 'object'
      and base_period->>'status' = 'confirmed'
      and base_period->>'bounds' = 'inclusive'
      and base_period->>'asOf' = to_char(snapshot_row.as_of, 'YYYY-MM-DD')
      and jsonb_typeof(base_period->'start') = 'string'
      and jsonb_typeof(base_period->'end') = 'string',
      false
    ) then
      raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
    end if;
    previous_start := private.law_reference_iso_date(base_period->>'start');
    previous_end := private.law_reference_iso_date(base_period->>'end');
    if previous_start is null or previous_end is null
      or previous_start > previous_end
      or previous_start < snapshot_row.period_start
      or previous_end > snapshot_row.period_end then
      raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
    end if;

    if p_start = previous_start and p_end = previous_end then
      raise exception 'invalid_analysis_chat_period' using errcode = '22023';
    end if;
    if p_start < snapshot_row.period_start or p_end > snapshot_row.period_end then
      raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
    end if;

    base_area := private.normalize_area_tolerance(base_run.comparison_result#>'{conditions,area,tolerancePercent}');
    if base_area is not null
      and (base_area::numeric <> 5 or (base_run.conditions_snapshot#>'{comparison,areaTolerancePercent}') is not null) then
      carried := carried || jsonb_build_object('areaTolerancePercent', base_area);
    end if;
    base_kinds := private.normalize_trade_kinds(base_run.comparison_result#>'{conditions,tradeKinds}');
    snapshot_kinds := private.normalize_trade_kinds(snapshot_row.result_snapshot->'tradeKinds');
    if base_kinds is not null and snapshot_kinds is not null and base_kinds is distinct from snapshot_kinds then
      carried := carried || jsonb_build_object('tradeKinds', base_kinds);
    end if;
    base_replacements := private.extract_run_replacements(base_run.comparison_result);
    if jsonb_array_length(base_replacements) > 0
      or (base_run.conditions_snapshot#>'{comparison,replacements}') is not null then
      carried := carried || jsonb_build_object('replacements', base_replacements);
    end if;
    if carried <> '{}'::jsonb then
      carried := carried || jsonb_build_object(
        'period', jsonb_build_object('start', to_char(p_start, 'YYYY-MM-DD'), 'end', to_char(p_end, 'YYYY-MM-DD'))
      );
    else
      carried := null;
    end if;
  else
    carried := null;
  end if;

  insert into private.analysis_chat_turns(
    analysis_id, base_run_id, user_id, request_id, message, intent,
    proposed_start, proposed_end, previous_start, previous_end,
    effective_conditions, proposal_status
  ) values (
    p_analysis_id, p_run_id, owner_id, p_request_id, trimmed_message, p_intent,
    case when p_intent = 'change_period' then p_start end,
    case when p_intent = 'change_period' then p_end end,
    case when p_intent = 'change_period' then previous_start end,
    case when p_intent = 'change_period' then previous_end end,
    case when p_intent = 'change_period' then carried end,
    case when p_intent = 'change_period' then 'pending' end
  );

  return private.analysis_conversation_payload(owner_id, p_analysis_id, p_run_id);
end;
$$;

-- 공급면적 허용 범위·거래 종류·단지 직접 교체·기간 조합 변경 제안을 검증해 대기 상태로 기록한다.
create function private.submit_analysis_condition_turn(
  p_analysis_id uuid,
  p_run_id uuid,
  p_request_id uuid,
  p_message text,
  p_conditions jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  trimmed_message text;
  analysis_row public.analyses%rowtype;
  base_run record;
  existing_turn private.analysis_chat_turns%rowtype;
  snapshot_row public.analysis_input_snapshots%rowtype;
  demo_capture boolean := false;
  base_period jsonb;
  prev_start date;
  prev_end date;
  prop_start date;
  prop_end date;
  base_area text;
  prop_area text;
  base_kinds jsonb;
  snapshot_kinds jsonb;
  prop_kinds jsonb;
  base_replacements jsonb;
  prop_replacements jsonb;
  norm_proposed jsonb := '{}'::jsonb;
  norm_previous jsonb := '{}'::jsonb;
  norm_effective jsonb := '{}'::jsonb;
  raw_period jsonb;
begin
  perform private.require_notice_run_user(owner_id);
  if p_analysis_id is null or p_run_id is null or p_request_id is null
    or p_conditions is null or jsonb_typeof(p_conditions) <> 'object'
    or p_conditions = '{}'::jsonb
    or private.comparison_contains_raw_payload(p_conditions) then
    raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_conditions) as k(name)
    where k.name not in ('period','areaTolerancePercent','tradeKinds','replacements')
  ) then
    raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
  end if;
  trimmed_message := private.normalize_analysis_chat_message(p_message);

  -- 입력 형식 오류는 잠금 전 사전 검증해 22023으로 즉시 거부한다.
  if p_conditions ? 'period' then
    raw_period := p_conditions->'period';
    if jsonb_typeof(raw_period) <> 'object'
      or (select count(*) from jsonb_object_keys(raw_period)) <> 2
      or jsonb_typeof(raw_period->'start') <> 'string'
      or jsonb_typeof(raw_period->'end') <> 'string' then
      raise exception 'invalid_analysis_chat_period' using errcode = '22023';
    end if;
    prop_start := private.law_reference_iso_date(raw_period->>'start');
    prop_end := private.law_reference_iso_date(raw_period->>'end');
    if prop_start is null or prop_end is null or prop_start > prop_end then
      raise exception 'invalid_analysis_chat_period' using errcode = '22023';
    end if;
    norm_proposed := norm_proposed || jsonb_build_object(
      'period', jsonb_build_object('start', to_char(prop_start, 'YYYY-MM-DD'), 'end', to_char(prop_end, 'YYYY-MM-DD'))
    );
  end if;

  if p_conditions ? 'areaTolerancePercent' then
    prop_area := private.normalize_area_tolerance(p_conditions->'areaTolerancePercent');
    if prop_area is null then
      raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
    end if;
    norm_proposed := norm_proposed || jsonb_build_object('areaTolerancePercent', prop_area);
  end if;

  if p_conditions ? 'tradeKinds' then
    prop_kinds := private.normalize_trade_kinds(p_conditions->'tradeKinds');
    if prop_kinds is null then
      raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
    end if;
    norm_proposed := norm_proposed || jsonb_build_object('tradeKinds', prop_kinds);
  end if;

  if p_conditions ? 'replacements' then
    prop_replacements := private.normalize_replacements(p_conditions->'replacements');
    if prop_replacements is null then
      raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
    end if;
    norm_proposed := norm_proposed || jsonb_build_object('replacements', prop_replacements);
  end if;

  select * into analysis_row from public.analyses a
    where (a.id, a.user_id) = (p_analysis_id, owner_id) for no key update;
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;

  select r.*, c.result as comparison_result, c.source_ids as comparison_source_ids
    into base_run
    from private.analysis_runs r
    left join private.comparison_results c on c.run_id = r.id and r.status = 'finished'
    where (r.id, r.analysis_id, r.user_id) = (p_run_id, p_analysis_id, owner_id);
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;
  if base_run.comparison_result is null then
    raise exception 'analysis_comparison_not_ready' using errcode = 'PT409';
  end if;
  perform private.require_comparison_chat_sources(base_run.comparison_source_ids);

  -- 권한 확인 직후, 오래된 실행 검사보다 먼저 같은 요청 키의 멱등 재전송을 복원한다.
  select * into existing_turn from private.analysis_chat_turns t
    where (t.analysis_id, t.base_run_id, t.request_id) = (p_analysis_id, p_run_id, p_request_id);
  if found then
    if (existing_turn.message, existing_turn.intent, existing_turn.proposed_conditions)
       is distinct from (trimmed_message, 'change_conditions', norm_proposed) then
      raise exception 'analysis_chat_request_conflict' using errcode = 'PT409';
    end if;
    return private.analysis_conversation_payload(owner_id, p_analysis_id, p_run_id);
  end if;

  if analysis_row.latest_run_id is distinct from base_run.id
    or (analysis_row.conditions_snapshot, analysis_row.rules_version, analysis_row.notice_id, analysis_row.housing_type_id)
       is distinct from (base_run.conditions_snapshot, base_run.rules_version, base_run.notice_id, base_run.housing_type_id) then
    raise exception 'analysis_chat_stale_run' using errcode = 'PT409';
  end if;

  select * into snapshot_row from public.analysis_input_snapshots s
    where (s.id, s.analysis_id, s.user_id) = (base_run.snapshot_id, p_analysis_id, owner_id)
    for key share;
  if not found
    or base_run.notice_id is not null or base_run.housing_type_id is not null
    or snapshot_row.notice_id is not null or snapshot_row.housing_type_id is not null
    or (snapshot_row.conditions_snapshot, snapshot_row.rules_version, snapshot_row.notice_id, snapshot_row.housing_type_id)
       is distinct from (base_run.conditions_snapshot, base_run.rules_version, base_run.notice_id, base_run.housing_type_id)
    or snapshot_row.period_start is null or snapshot_row.period_end is null
    or snapshot_row.result_snapshot#>>'{period,status}' is distinct from 'confirmed' then
    if p_conditions ? 'period' then
      raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
    end if;
    raise exception 'analysis_chat_condition_unavailable' using errcode = 'PT409';
  end if;

  demo_capture := private.is_demo_snapshot(snapshot_row);
  base_period := base_run.comparison_result#>'{conditions,period}';
  if not coalesce(
    jsonb_typeof(base_period) = 'object'
    and base_period->>'status' = 'confirmed'
    and base_period->>'bounds' = 'inclusive'
    and base_period->>'asOf' = to_char(snapshot_row.as_of, 'YYYY-MM-DD')
    and jsonb_typeof(base_period->'start') = 'string'
    and jsonb_typeof(base_period->'end') = 'string',
    false
  ) then
    if p_conditions ? 'period' then
      raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
    end if;
    raise exception 'analysis_chat_condition_unavailable' using errcode = 'PT409';
  end if;
  prev_start := private.law_reference_iso_date(base_period->>'start');
  prev_end := private.law_reference_iso_date(base_period->>'end');
  if prev_start is null or prev_end is null
    or prev_start > prev_end
    or prev_start < snapshot_row.period_start
    or prev_end > snapshot_row.period_end then
    if p_conditions ? 'period' then
      raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
    end if;
    raise exception 'analysis_chat_condition_unavailable' using errcode = 'PT409';
  end if;

  snapshot_kinds := private.normalize_trade_kinds(snapshot_row.result_snapshot->'tradeKinds');
  base_kinds := private.normalize_trade_kinds(base_run.comparison_result#>'{conditions,tradeKinds}');
  if base_run.comparison_result#>>'{target,supplyArea,status}' = 'confirmed'
    and base_run.comparison_result#>>'{conditions,area,basis}' = 'supply' then
    base_area := private.normalize_area_tolerance(base_run.comparison_result#>'{conditions,area,tolerancePercent}');
  end if;
  base_replacements := private.extract_run_replacements(base_run.comparison_result);

  if p_conditions ? 'period' then
    if prop_start < snapshot_row.period_start or prop_end > snapshot_row.period_end then
      raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
    end if;
    if prop_start = prev_start and prop_end = prev_end then
      raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
    end if;
    norm_previous := norm_previous || jsonb_build_object(
      'period', jsonb_build_object('start', to_char(prev_start, 'YYYY-MM-DD'), 'end', to_char(prev_end, 'YYYY-MM-DD'))
    );
    norm_effective := norm_effective || jsonb_build_object('period', norm_proposed->'period');
  elsif prev_start <> snapshot_row.period_start or prev_end <> snapshot_row.period_end then
    norm_effective := norm_effective || jsonb_build_object(
      'period', jsonb_build_object('start', to_char(prev_start, 'YYYY-MM-DD'), 'end', to_char(prev_end, 'YYYY-MM-DD'))
    );
  end if;

  if p_conditions ? 'areaTolerancePercent' then
    if base_area is null then
      raise exception 'analysis_chat_condition_unavailable' using errcode = 'PT409';
    end if;
    if prop_area::numeric = base_area::numeric then
      raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
    end if;
    norm_previous := norm_previous || jsonb_build_object('areaTolerancePercent', base_area);
    norm_effective := norm_effective || jsonb_build_object('areaTolerancePercent', prop_area);
  elsif base_area is not null
    and (base_area::numeric <> 5 or (base_run.conditions_snapshot#>'{comparison,areaTolerancePercent}') is not null) then
    norm_effective := norm_effective || jsonb_build_object('areaTolerancePercent', base_area);
  end if;

  if p_conditions ? 'tradeKinds' then
    if snapshot_kinds is null or base_kinds is null
      or exists (
        select 1 from jsonb_array_elements_text(prop_kinds) as req(kind)
        where not (snapshot_kinds ? req.kind)
      ) then
      raise exception 'analysis_chat_condition_unavailable' using errcode = 'PT409';
    end if;
    if prop_kinds = base_kinds then
      raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
    end if;
    norm_previous := norm_previous || jsonb_build_object('tradeKinds', base_kinds);
    norm_effective := norm_effective || jsonb_build_object('tradeKinds', prop_kinds);
  elsif base_kinds is not null and snapshot_kinds is not null and base_kinds is distinct from snapshot_kinds then
    norm_effective := norm_effective || jsonb_build_object('tradeKinds', base_kinds);
  end if;

  if p_conditions ? 'replacements' then
    if not coalesce(base_run.comparison_result->>'appliedScope' in ('priority','expansion'), false)
      or (not base_run.comparison_evidence_pinned and not demo_capture) then
      raise exception 'analysis_chat_condition_unavailable' using errcode = 'PT409';
    end if;
    if prop_replacements = base_replacements then
      raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
    end if;
    norm_previous := norm_previous || jsonb_build_object('replacements', base_replacements);
    norm_effective := norm_effective || jsonb_build_object('replacements', prop_replacements);
  elsif jsonb_array_length(base_replacements) > 0
    or (base_run.conditions_snapshot#>'{comparison,replacements}') is not null then
    norm_effective := norm_effective || jsonb_build_object('replacements', base_replacements);
  end if;

  insert into private.analysis_chat_turns(
    analysis_id, base_run_id, user_id, request_id, message, intent,
    proposed_conditions, previous_conditions, effective_conditions, proposal_status
  ) values (
    p_analysis_id, p_run_id, owner_id, p_request_id, trimmed_message, 'change_conditions',
    norm_proposed, norm_previous, norm_effective, 'pending'
  );

  return private.analysis_conversation_payload(owner_id, p_analysis_id, p_run_id);
end;
$$;

create function public.submit_analysis_condition_turn(
  p_analysis_id uuid,
  p_run_id uuid,
  p_request_id uuid,
  p_message text,
  p_conditions jsonb
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.submit_analysis_condition_turn(p_analysis_id, p_run_id, p_request_id, p_message, p_conditions);
$$;

-- 기간 변경(change_period)과 조건 변경(change_conditions) 제안을 모두 같은 승인·거절·취소 규칙으로 결정한다.
create or replace function private.decide_analysis_chat_turn(
  p_analysis_id uuid,
  p_run_id uuid,
  p_turn_id uuid,
  p_decision text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  target_status text;
  analysis_row public.analyses%rowtype;
  base_run record;
  turn_row private.analysis_chat_turns%rowtype;
  snapshot_row public.analysis_input_snapshots%rowtype;
  demo_capture boolean := false;
  eff_start date;
  eff_end date;
  snapshot_kinds jsonb;
  eff_kinds jsonb;
  new_run_op jsonb;
  new_run_id uuid;
begin
  perform private.require_notice_run_user(owner_id);
  if p_analysis_id is null or p_run_id is null or p_turn_id is null
    or p_decision is null or p_decision not in ('approve','reject','cancel') then
    raise exception 'invalid_analysis_chat_decision' using errcode = '22023';
  end if;
  target_status := case p_decision
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    when 'cancel' then 'cancelled'
  end;

  if p_decision = 'approve' then
    perform pg_advisory_xact_lock(hashtextextended('homecierge:analysis-runs:' || owner_id::text, 0));
  end if;
  select * into analysis_row from public.analyses a
    where (a.id, a.user_id) = (p_analysis_id, owner_id) for no key update;
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;

  select r.*, c.result as comparison_result, c.source_ids as comparison_source_ids
    into base_run
    from private.analysis_runs r
    left join private.comparison_results c on c.run_id = r.id and r.status = 'finished'
    where (r.id, r.analysis_id, r.user_id) = (p_run_id, p_analysis_id, owner_id);
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;
  if base_run.comparison_result is null then
    raise exception 'analysis_comparison_not_ready' using errcode = 'PT409';
  end if;
  perform private.require_comparison_chat_sources(base_run.comparison_source_ids);

  select * into turn_row from private.analysis_chat_turns t
    where (t.id, t.analysis_id, t.base_run_id, t.user_id) = (p_turn_id, p_analysis_id, p_run_id, owner_id)
    for update;
  if not found then
    raise exception 'analysis_chat_turn_not_found' using errcode = 'PT404';
  end if;
  if turn_row.intent not in ('change_period', 'change_conditions') then
    raise exception 'analysis_chat_decision_conflict' using errcode = 'PT409';
  end if;

  if turn_row.proposal_status = target_status then
    return private.analysis_conversation_payload(owner_id, p_analysis_id, p_run_id);
  end if;
  if turn_row.proposal_status <> 'pending' then
    raise exception 'analysis_chat_decision_conflict' using errcode = 'PT409';
  end if;

  if p_decision in ('reject', 'cancel') then
    update private.analysis_chat_turns
      set proposal_status = target_status, decided_at = clock_timestamp()
      where id = turn_row.id;
    return private.analysis_conversation_payload(owner_id, p_analysis_id, p_run_id);
  end if;

  if analysis_row.latest_run_id is distinct from base_run.id
    or (analysis_row.conditions_snapshot, analysis_row.rules_version, analysis_row.notice_id, analysis_row.housing_type_id)
       is distinct from (base_run.conditions_snapshot, base_run.rules_version, base_run.notice_id, base_run.housing_type_id) then
    raise exception 'analysis_chat_stale_run' using errcode = 'PT409';
  end if;

  select * into snapshot_row from public.analysis_input_snapshots s
    where (s.id, s.analysis_id, s.user_id) = (base_run.snapshot_id, p_analysis_id, owner_id)
    for key share;
  if not found
    or base_run.notice_id is not null or base_run.housing_type_id is not null
    or snapshot_row.notice_id is not null or snapshot_row.housing_type_id is not null
    or (snapshot_row.conditions_snapshot, snapshot_row.rules_version, snapshot_row.notice_id, snapshot_row.housing_type_id)
       is distinct from (base_run.conditions_snapshot, base_run.rules_version, base_run.notice_id, base_run.housing_type_id)
    or snapshot_row.period_start is null or snapshot_row.period_end is null
    or snapshot_row.result_snapshot#>>'{period,status}' is distinct from 'confirmed' then
    if turn_row.intent = 'change_period' or coalesce(turn_row.proposed_conditions ? 'period', false) then
      raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
    end if;
    raise exception 'analysis_chat_condition_unavailable' using errcode = 'PT409';
  end if;

  demo_capture := private.is_demo_snapshot(snapshot_row);
  if turn_row.intent = 'change_period' then
    if turn_row.proposed_start < snapshot_row.period_start
      or turn_row.proposed_end > snapshot_row.period_end then
      raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
    end if;
  else
    if turn_row.effective_conditions ? 'period' then
      eff_start := private.law_reference_iso_date(turn_row.effective_conditions#>>'{period,start}');
      eff_end := private.law_reference_iso_date(turn_row.effective_conditions#>>'{period,end}');
      if eff_start is null or eff_end is null or eff_start > eff_end
        or eff_start < snapshot_row.period_start or eff_end > snapshot_row.period_end then
        raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
      end if;
    end if;
    if turn_row.effective_conditions ? 'areaTolerancePercent' then
      if private.normalize_area_tolerance(turn_row.effective_conditions->'areaTolerancePercent') is null
        or base_run.comparison_result#>>'{target,supplyArea,status}' is distinct from 'confirmed'
        or base_run.comparison_result#>>'{conditions,area,basis}' is distinct from 'supply' then
        raise exception 'analysis_chat_condition_unavailable' using errcode = 'PT409';
      end if;
    end if;
    if turn_row.effective_conditions ? 'tradeKinds' then
      snapshot_kinds := private.normalize_trade_kinds(snapshot_row.result_snapshot->'tradeKinds');
      eff_kinds := private.normalize_trade_kinds(turn_row.effective_conditions->'tradeKinds');
      if snapshot_kinds is null or eff_kinds is null
        or exists (
          select 1 from jsonb_array_elements_text(eff_kinds) as req(kind)
          where not (snapshot_kinds ? req.kind)
        ) then
        raise exception 'analysis_chat_condition_unavailable' using errcode = 'PT409';
      end if;
    end if;
    if turn_row.effective_conditions ? 'replacements' then
      if private.normalize_replacements(turn_row.effective_conditions->'replacements') is null
        or not coalesce(base_run.comparison_result->>'appliedScope' in ('priority','expansion'), false)
        or (not base_run.comparison_evidence_pinned and not demo_capture) then
        raise exception 'analysis_chat_condition_unavailable' using errcode = 'PT409';
      end if;
    end if;
  end if;

  if snapshot_row.data_origin = 'collected' then
    perform private.require_comparison_chat_sources(private.comparison_sources(
      snapshot_row.id,
      (select e.source_ids from private.comparison_evidence e
        where e.snapshot_id = snapshot_row.id and base_run.comparison_evidence_pinned)
    ));
  end if;

  new_run_op := private.enqueue_analysis_run(
    p_analysis_id,
    gen_random_uuid(),
    jsonb_build_object('kind', 'snapshot', 'snapshotId', base_run.snapshot_id)
  );
  new_run_id := (new_run_op->>'runId')::uuid;
  update private.analysis_runs
    set comparison_evidence_pinned = base_run.comparison_evidence_pinned
    where id = new_run_id
      and comparison_evidence_pinned is distinct from base_run.comparison_evidence_pinned;

  update private.analysis_chat_turns
    set proposal_status = 'approved',
        decided_at = clock_timestamp(),
        result_run_id = new_run_id
    where id = turn_row.id;

  return private.analysis_conversation_payload(owner_id, p_analysis_id, p_run_id);
end;
$$;

-- 승인된 기간·면적·거래 종류·단지 교체 실행의 저장 결과가 승인 내용과 정확히 일치하는지 검사한다.
create function private.check_approved_condition_comparison(
  p_job private.analysis_runs,
  p_snapshot public.analysis_input_snapshots,
  p_turn private.analysis_chat_turns,
  p_comparison jsonb
) returns void language plpgsql set search_path = '' as $$
declare
  base_run record;
  eff jsonb := coalesce(p_turn.effective_conditions, '{}'::jsonb);
  expected_start date;
  expected_end date;
  expected_period jsonb;
  expected_months jsonb;
  expected_kinds jsonb;
  expected_tolerance text;
  target_supply numeric;
  expected_min numeric;
  expected_max numeric;
  expected_replacements jsonb;
  demo_capture boolean;
  orig_notice_run private.analysis_runs%rowtype;
  expected_batch_count integer;
begin
  select r.*, c.result as comparison_result into base_run
    from private.analysis_runs r
    join private.comparison_results c on c.run_id = r.id and r.status = 'finished'
    where (r.id, r.analysis_id, r.user_id) = (p_turn.base_run_id, p_job.analysis_id, p_job.user_id);

  if not found
    or p_turn.intent not in ('change_period', 'change_conditions')
    or p_job.input->>'kind' is distinct from 'snapshot'
    or p_snapshot.id is distinct from base_run.snapshot_id
    or p_job.notice_id is not null or p_job.housing_type_id is not null
    or p_snapshot.notice_id is not null or p_snapshot.housing_type_id is not null
    or p_job.comparison_evidence_pinned is distinct from base_run.comparison_evidence_pinned
    or (p_job.conditions_snapshot, p_job.rules_version, p_job.notice_id, p_job.housing_type_id)
       is distinct from (p_snapshot.conditions_snapshot, p_snapshot.rules_version, p_snapshot.notice_id, p_snapshot.housing_type_id)
    or (p_job.conditions_snapshot, p_job.rules_version, p_job.notice_id, p_job.housing_type_id)
       is distinct from (base_run.conditions_snapshot, base_run.rules_version, base_run.notice_id, base_run.housing_type_id)
    or p_snapshot.period_start is null or p_snapshot.period_end is null
    or p_snapshot.result_snapshot#>>'{period,status}' is distinct from 'confirmed' then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  -- 1) 기대 기간 계산
  if p_turn.intent = 'change_period' then
    expected_start := p_turn.proposed_start;
    expected_end := p_turn.proposed_end;
    if expected_start is null or expected_end is null or expected_start > expected_end
      or expected_start < p_snapshot.period_start or expected_end > p_snapshot.period_end then
      raise exception 'invalid_comparison_result' using errcode = '22023';
    end if;
    expected_period := private.expected_comparison_period(p_snapshot.as_of, expected_start, expected_end);
  elsif eff ? 'period' then
    expected_start := private.law_reference_iso_date(eff#>>'{period,start}');
    expected_end := private.law_reference_iso_date(eff#>>'{period,end}');
    if expected_start is null or expected_end is null or expected_start > expected_end
      or expected_start < p_snapshot.period_start or expected_end > p_snapshot.period_end then
      raise exception 'invalid_comparison_result' using errcode = '22023';
    end if;
    expected_period := private.expected_comparison_period(p_snapshot.as_of, expected_start, expected_end);
  else
    expected_period := base_run.comparison_result#>'{conditions,period}';
    expected_start := private.law_reference_iso_date(expected_period->>'start');
    expected_end := private.law_reference_iso_date(expected_period->>'end');
    if expected_start is null or expected_end is null or expected_start > expected_end then
      raise exception 'invalid_comparison_result' using errcode = '22023';
    end if;
  end if;
  expected_months := expected_period->'months';

  -- 2) 기대 거래 종류 계산
  if eff ? 'tradeKinds' then
    expected_kinds := private.normalize_trade_kinds(eff->'tradeKinds');
  else
    expected_kinds := private.normalize_trade_kinds(base_run.comparison_result#>'{conditions,tradeKinds}');
  end if;
  if expected_kinds is null then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  -- 3) 공통 조건·대상 공고·호실 가격 고정 검증
  if not coalesce(
    p_comparison#>'{conditions,asOf}' = to_jsonb(to_char(p_snapshot.as_of, 'YYYY-MM-DD'))
    and p_comparison#>'{conditions,period}' = expected_period
    and p_comparison#>'{conditions,tradeKinds}' = expected_kinds
    and p_comparison#>'{conditions,maxComparables}' is not distinct from base_run.comparison_result#>'{conditions,maxComparables}'
    and p_comparison#>'{conditions,limitations}' is not distinct from base_run.comparison_result#>'{conditions,limitations}'
    and ((p_comparison->'conditions') - array['asOf','period','area','tradeKinds','maxComparables','limitations']) = '{}'::jsonb
    and jsonb_typeof(p_comparison->'target') = 'object'
    and p_comparison->'target' @> jsonb_build_object(
      'houseManageNo', p_snapshot.house_manage_no,
      'noticeNo', p_snapshot.notice_no,
      'edition', p_snapshot.edition
    )
    and p_comparison->'target' is not distinct from base_run.comparison_result->'target'
    and p_comparison->'noticePrice' is not distinct from base_run.comparison_result->'noticePrice',
    false
  ) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  -- 4) 공급면적 허용 범위와 정확한 경계값(반올림 금지, 양 끝 포함) 검증
  if base_run.comparison_result#>>'{target,supplyArea,status}' = 'confirmed'
    and base_run.comparison_result#>>'{conditions,area,basis}' = 'supply' then
    if eff ? 'areaTolerancePercent' then
      expected_tolerance := private.normalize_area_tolerance(eff->'areaTolerancePercent');
    else
      expected_tolerance := private.normalize_area_tolerance(base_run.comparison_result#>'{conditions,area,tolerancePercent}');
    end if;
    if expected_tolerance is null
      or jsonb_typeof(p_comparison#>'{conditions,area}') <> 'object'
      or p_comparison#>>'{conditions,area,basis}' is distinct from 'supply'
      or (select count(*) from jsonb_object_keys(p_comparison#>'{conditions,area}')) <> 4
      or p_comparison#>>'{conditions,area,tolerancePercent}' !~ '\A(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\Z'
      or (p_comparison#>>'{conditions,area,tolerancePercent}')::numeric <> expected_tolerance::numeric
      or p_comparison#>>'{target,supplyArea,m2}' !~ '\A(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\Z'
      or p_comparison#>>'{conditions,area,minM2}' !~ '\A(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\Z'
      or p_comparison#>>'{conditions,area,maxM2}' !~ '\A(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\Z' then
      raise exception 'invalid_comparison_result' using errcode = '22023';
    end if;
    target_supply := (p_comparison#>>'{target,supplyArea,m2}')::numeric;
    expected_min := target_supply - (target_supply * expected_tolerance::numeric * 0.01::numeric);
    expected_max := target_supply + (target_supply * expected_tolerance::numeric * 0.01::numeric);
    if (p_comparison#>>'{conditions,area,minM2}')::numeric <> expected_min
      or (p_comparison#>>'{conditions,area,maxM2}')::numeric <> expected_max then
      raise exception 'invalid_comparison_result' using errcode = '22023';
    end if;
  else
    if p_comparison#>'{conditions,area}' is distinct from 'null'::jsonb then
      raise exception 'invalid_comparison_result' using errcode = '22023';
    end if;
  end if;

  -- 5) 수집 기록은 승인 기간의 계약월 및 승인 거래 종류와 정확히 일치해야 한다.
  if exists (
    select 1 from jsonb_array_elements(p_comparison->'collections') as c(value)
    where not coalesce(
      jsonb_typeof(c.value) = 'object'
      and jsonb_typeof(c.value->'month') = 'string'
      and c.value->>'month' ~ '\A[0-9]{4}-(0[1-9]|1[0-2])\Z'
      and expected_months ? replace(c.value->>'month', '-', '')
      and jsonb_typeof(c.value->'source') = 'string'
      and (
        (c.value->>'source' = 'apt_trade' and expected_kinds ? 'sale'
          and c.value->'tradeKinds' = '["sale"]'::jsonb)
        or (c.value->>'source' = 'apt_rights'
          and private.normalize_trade_kinds(c.value->'tradeKinds') is not null
          and (
            select jsonb_agg(to_jsonb(k.kind) order by k.ord)
            from (values ('presale_right', 1), ('occupancy_right', 2)) as k(kind, ord)
            where expected_kinds ? k.kind
          ) = c.value->'tradeKinds')
      ),
      false
    )
  ) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  -- 6) tradeKinds 요약은 승인된 거래 종류만 포함해야 한다.
  if exists (
    select 1 from jsonb_object_keys(p_comparison->'tradeKinds') as tk(kind)
    where not (expected_kinds ? tk.kind)
  ) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;
  if p_comparison->>'appliedScope' in ('priority','expansion')
    and (select count(*) from jsonb_object_keys(p_comparison->'tradeKinds')) <> jsonb_array_length(expected_kinds) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  -- 7) 포함된 모든 주변 단지·자체 거래는 승인 기간·거래 종류·면적 경계(양 끝 포함)를 만족해야 한다.
  if exists (
    select 1
    from (
      select value from jsonb_array_elements(p_comparison->'comparables')
      union all
      select value from jsonb_array_elements(p_comparison->'targetReferences')
    ) as item(entry)
    where jsonb_typeof(item.entry) <> 'object'
      or jsonb_typeof(item.entry->'complexId') <> 'string'
      or btrim(item.entry->>'complexId') = ''
      or (expected_min is not null and (
        jsonb_typeof(item.entry->'supplyAreaM2') <> 'string'
        or item.entry->>'supplyAreaM2' !~ '\A(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\Z'
        or (item.entry->>'supplyAreaM2')::numeric < expected_min
        or (item.entry->>'supplyAreaM2')::numeric > expected_max
      ))
      or jsonb_typeof(item.entry->'tradeStats') <> 'object'
      or item.entry->'tradeStats' = '{}'::jsonb
      or exists (
        select 1 from jsonb_each(item.entry->'tradeStats') as ts(kind, stat)
        where not (expected_kinds ? ts.kind)
          or jsonb_typeof(ts.stat) <> 'object'
          or jsonb_typeof(ts.stat->'observations') <> 'array'
          or jsonb_array_length(ts.stat->'observations') = 0
          or ts.stat->'count' is distinct from to_jsonb(jsonb_array_length(ts.stat->'observations'))
          or exists (
            select 1 from jsonb_array_elements(ts.stat->'observations') as o(obs)
            where jsonb_typeof(o.obs) <> 'object'
              or jsonb_typeof(o.obs->'contractDate') <> 'string'
              or private.law_reference_iso_date(o.obs->>'contractDate') is null
              or private.law_reference_iso_date(o.obs->>'contractDate') < expected_start
              or private.law_reference_iso_date(o.obs->>'contractDate') > expected_end
          )
      )
  ) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  -- 8) 고유 주변 단지 5개 이하·대상 단지 제외·직접 교체(manual_replacement) 승인 일치 검증
  if (
    select count(distinct c.val->>'complexId') from jsonb_array_elements(p_comparison->'comparables') as c(val)
  ) <> jsonb_array_length(p_comparison->'comparables') then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;
  if p_comparison#>>'{target,complexId}' is not null and exists (
    select 1 from jsonb_array_elements(p_comparison->'comparables') as c(val)
    where c.val->>'complexId' = p_comparison#>>'{target,complexId}'
  ) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  if eff ? 'replacements' then
    expected_replacements := private.normalize_replacements(eff->'replacements');
    if expected_replacements is null then
      raise exception 'invalid_comparison_result' using errcode = '22023';
    end if;
  else
    expected_replacements := private.extract_run_replacements(base_run.comparison_result);
  end if;

  -- 승인되지 않은 manual_replacement 선정 이유나 교체 대상 불일치를 거부한다.
  if exists (
    select 1 from jsonb_array_elements(p_comparison->'comparables') as c(val)
    where (
      c.val->>'selectionReason' = 'manual_replacement'
      and not exists (
        select 1 from jsonb_array_elements(expected_replacements) as r(pair)
        where r.pair->>'complexId' = c.val->>'complexId'
          and r.pair->>'replaceComplexId' = c.val->>'replacesComplexId'
      )
    ) or (
      c.val->>'selectionReason' is distinct from 'manual_replacement'
      and c.val ? 'replacesComplexId'
    )
  ) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  -- 교체로 빠진 기존 단지가 비교표에 동시에 남아 있으면 거부한다.
  if exists (
    select 1 from jsonb_array_elements(p_comparison->'comparables') as m(val)
    where m.val->>'selectionReason' = 'manual_replacement'
      and exists (
        select 1 from jsonb_array_elements(p_comparison->'comparables') as c(val)
        where c.val->>'complexId' = m.val->>'replacesComplexId'
      )
  ) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  if p_comparison->>'appliedScope' in ('priority','expansion')
    and exists (
      select 1 from jsonb_array_elements(p_comparison->'comparables') as c(val)
      where jsonb_typeof(c.val->'localityCode') <> 'string'
        or btrim(c.val->>'localityCode') = ''
    ) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  -- 우선 지역(동·읍·면) 적용 시 교체 단지도 같은 우선 지역 소속이어야 한다.
  if p_comparison->>'appliedScope' = 'priority'
    and jsonb_typeof(p_comparison#>'{regionDecision,priority,code}') = 'string'
    and exists (
      select 1 from jsonb_array_elements(p_comparison->'comparables') as c(val)
      where c.val->>'localityCode' is distinct from p_comparison#>>'{regionDecision,priority,code}'
    ) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  -- 확대 지역(구·시·군) 적용 시 등록 근거가 있으면 모든 비교 단지가 같은 확대 지역 소속이어야 한다.
  if p_comparison->>'appliedScope' = 'expansion'
    and p_job.comparison_evidence_pinned
    and jsonb_typeof(p_comparison#>'{regionDecision,expansion,code}') = 'string'
    and p_comparison#>>'{regionDecision,expansion,kind}' in ('district','municipality')
    and exists (
      select 1 from jsonb_array_elements(p_comparison->'comparables') as c(val)
      where not exists (
        select 1
        from private.comparison_evidence e,
             jsonb_array_elements(coalesce(e.evidence->'regions', '[]'::jsonb)) as reg(val)
        where e.snapshot_id = p_snapshot.id
          and reg.val->>'localityCode' = c.val->>'localityCode'
          and (
            (p_comparison#>>'{regionDecision,expansion,kind}' = 'district'
              and reg.val->>'districtCode' = p_comparison#>>'{regionDecision,expansion,code}')
            or (p_comparison#>>'{regionDecision,expansion,kind}' = 'municipality'
              and reg.val->>'municipalityCode' = p_comparison#>>'{regionDecision,expansion,code}')
          )
      )
    ) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  -- 승인된 모든 교체 요청은 comparables에 manual_replacement로 반영되었거나 holds에 사유가 기록되어야 한다.
  if p_comparison->>'appliedScope' in ('priority','expansion')
    and jsonb_array_length(expected_replacements) > 0
    and exists (
      select 1 from jsonb_array_elements(expected_replacements) as r(pair)
      where not exists (
        select 1 from jsonb_array_elements(p_comparison->'comparables') as c(val)
        where c.val->>'selectionReason' = 'manual_replacement'
          and c.val->>'complexId' = r.pair->>'complexId'
          and c.val->>'replacesComplexId' = r.pair->>'replaceComplexId'
      )
      and not exists (
        select 1 from jsonb_array_elements(p_comparison->'holds') as h(val)
        where jsonb_typeof(h.val) = 'object'
          and h.val->>'reasonCode' in (
            'replacement_target_required',
            'replacement_candidate_ineligible',
            'replacement_request_conflict'
          )
          and h.val->>'complexId' = r.pair->>'complexId'
          and h.val->>'replaceComplexId' = r.pair->>'replaceComplexId'
      )
    ) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  -- 9) 근거 없는 실행에서의 권한 상승(허위 후보·완료 승격) 차단
  demo_capture := private.is_demo_snapshot(p_snapshot);
  if not demo_capture and not p_job.comparison_evidence_pinned then
    if not coalesce(
      p_comparison->>'completeness' <> 'complete'
      and p_comparison->'appliedScope' = 'null'::jsonb
      and p_comparison->'rankingComplete' = 'false'::jsonb
      and p_comparison->'comparables' = '[]'::jsonb
      and p_comparison->'targetReferences' = '[]'::jsonb
      and coalesce(p_comparison->'candidatePool', '[]'::jsonb) = '[]'::jsonb
      and p_comparison->'tradeKinds' = '{}'::jsonb
      and p_comparison->'exclusions' = '[]'::jsonb
      and p_comparison#>'{regionDecision,priority}' = 'null'::jsonb
      and p_comparison#>'{regionDecision,expansion}' = 'null'::jsonb,
      false
    ) then
      raise exception 'invalid_comparison_result' using errcode = '22023';
    end if;

    select * into orig_notice_run from private.analysis_runs r
      where (r.id, r.analysis_id, r.user_id) = (p_snapshot.capture_key, p_job.analysis_id, p_job.user_id)
        and r.input->>'kind' = 'notice';
    if found then
      select count(*)::integer into expected_batch_count
        from jsonb_array_elements(p_snapshot.result_snapshot->'tradeBatches') as b(batch)
        where expected_months ? replace(b.batch#>>'{record,month}', '-', '')
          and (
            (b.batch#>>'{record,source}' = 'apt_trade' and expected_kinds ? 'sale')
            or (b.batch#>>'{record,source}' = 'apt_rights'
              and (expected_kinds ? 'presale_right' or expected_kinds ? 'occupancy_right'))
          );

      if not coalesce(
        p_comparison#>'{target,modelNo}' = orig_notice_run.input->'modelNo'
        and jsonb_typeof(p_comparison#>'{target,houseType}') = 'string'
        and private.notice_run_house_type(p_comparison#>>'{target,houseType}') = orig_notice_run.notice_house_type,
        false
      )
        or jsonb_array_length(p_comparison->'collections') <> expected_batch_count
        or exists (
          select 1 from jsonb_array_elements(p_snapshot.result_snapshot->'tradeBatches') as b(batch)
          cross join lateral (select b.batch->'record' as record) as capture
          where expected_months ? replace(capture.record->>'month', '-', '')
            and (
              (capture.record->>'source' = 'apt_trade' and expected_kinds ? 'sale')
              or (capture.record->>'source' = 'apt_rights'
                and (expected_kinds ? 'presale_right' or expected_kinds ? 'occupancy_right'))
            )
            and not exists (
              select 1 from jsonb_array_elements(p_comparison->'collections') as c(value)
              where (c.value->'source', c.value->'requestRegionCode', c.value->'month')
                = (capture.record->'source', capture.record->'requestRegionCode', capture.record->'month')
                and (c.value->'status' = capture.record->'status'
                  or (c.value->>'status' = 'partial' and capture.record->>'status' in ('complete','empty')))
            )
        ) then
        raise exception 'invalid_comparison_result' using errcode = '22023';
      end if;
    end if;
  end if;
end;
$$;

-- 작업자에게 승인된 기간 및 조건 변경 사항을 전달한다. 일반 실행은 기존 응답 키를 그대로 유지한다.
create or replace function public.read_comparison_work(p_run_id uuid, p_generation integer, p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id, p_generation, p_lease_token);
  synthetic_selection constant jsonb := '{"kind":"synthetic","fixture":"ingestion-v0"}';
  saved record;
  ingestion jsonb;
  evidence jsonb;
  notice_capture jsonb;
  approved_turn private.analysis_chat_turns%rowtype;
  comparison_period jsonb;
  comparison_conditions jsonb;
  eff_start date;
  eff_end date;
  snapshot_kinds jsonb;
  eff_kinds jsonb;
  payload jsonb;
  use_synthetic_fixture boolean := job.input = synthetic_selection;
  binding_issue text := case
    when job.notice_id is not null then 'target_identity_unverified'
    when job.housing_type_id is not null then 'housing_type_identity_unverified'
  end;
begin
  select * into approved_turn from private.analysis_chat_turns t
    where (t.result_run_id, t.analysis_id, t.user_id) = (job.id, job.analysis_id, job.user_id)
      and t.proposal_status = 'approved';

  if approved_turn.id is not null and job.input->>'kind' is distinct from 'snapshot' then
    raise exception 'invalid_analysis_chat_period' using errcode = '22023';
  end if;

  if job.input->>'kind' = 'notice' then
    perform private.require_unchanged_run_inputs(job);
    perform private.require_notice_run_sources(private.notice_run_capture_sources(job.input->>'noticeSource'));
    notice_capture := jsonb_build_object('asOf', job.notice_request->'asOf',
      'requestRegionCodes', job.notice_request->'requestRegionCodes',
      'allowOfficialPdf', private.comparison_sources_permitted(array['applyhome_notice_pdf']));
  elsif job.input->>'kind' = 'snapshot' then
    select s.id, s.data_origin, s.result_snapshot, s.period_start, s.period_end, e.evidence, e.source_ids,
      s.data_origin = 'synthetic' and exists (
        select 1 from private.analysis_runs original
        join private.comparison_results c on c.run_id = original.id
        where (original.id, original.snapshot_id, original.analysis_id, original.user_id) =
          (s.capture_key, s.id, s.analysis_id, s.user_id)
          and original.status = 'finished' and original.input = synthetic_selection
      ) as demo_capture into saved
      from public.analysis_input_snapshots s
      left join private.comparison_evidence e on job.comparison_evidence_pinned and e.snapshot_id = s.id
      where (s.id, s.analysis_id, s.user_id) = ((job.input->>'snapshotId')::uuid, job.analysis_id, job.user_id)
      for key share of s;
    if not found then
      raise exception 'analysis_run_snapshot_missing' using errcode = '22023';
    end if;
    if saved.data_origin = 'collected' then
      perform private.require_comparison_sources(private.comparison_sources(saved.id, saved.source_ids));
    end if;
    if approved_turn.id is not null then
      if saved.period_start is null or saved.period_end is null
        or saved.result_snapshot#>>'{period,status}' is distinct from 'confirmed' then
        raise exception 'invalid_analysis_chat_period' using errcode = '22023';
      end if;
      if approved_turn.intent = 'change_period' then
        if approved_turn.proposed_start < saved.period_start
          or approved_turn.proposed_end > saved.period_end
          or approved_turn.proposed_start > approved_turn.proposed_end then
          raise exception 'invalid_analysis_chat_period' using errcode = '22023';
        end if;
        comparison_period := jsonb_build_object(
          'start', to_char(approved_turn.proposed_start, 'YYYY-MM-DD'),
          'end', to_char(approved_turn.proposed_end, 'YYYY-MM-DD')
        );
        if approved_turn.effective_conditions is not null then
          comparison_conditions := approved_turn.effective_conditions;
        end if;
      elsif approved_turn.intent = 'change_conditions' then
        if approved_turn.effective_conditions is null
          or jsonb_typeof(approved_turn.effective_conditions) <> 'object'
          or approved_turn.effective_conditions = '{}'::jsonb then
          raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
        end if;
        if approved_turn.effective_conditions ? 'period' then
          eff_start := private.law_reference_iso_date(approved_turn.effective_conditions#>>'{period,start}');
          eff_end := private.law_reference_iso_date(approved_turn.effective_conditions#>>'{period,end}');
          if eff_start is null or eff_end is null or eff_start > eff_end
            or eff_start < saved.period_start or eff_end > saved.period_end then
            raise exception 'invalid_analysis_chat_period' using errcode = '22023';
          end if;
          comparison_period := jsonb_build_object(
            'start', to_char(eff_start, 'YYYY-MM-DD'),
            'end', to_char(eff_end, 'YYYY-MM-DD')
          );
        end if;
        if approved_turn.effective_conditions ? 'areaTolerancePercent'
          and private.normalize_area_tolerance(approved_turn.effective_conditions->'areaTolerancePercent') is null then
          raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
        end if;
        if approved_turn.effective_conditions ? 'tradeKinds' then
          snapshot_kinds := private.normalize_trade_kinds(saved.result_snapshot->'tradeKinds');
          eff_kinds := private.normalize_trade_kinds(approved_turn.effective_conditions->'tradeKinds');
          if snapshot_kinds is null or eff_kinds is null
            or exists (
              select 1 from jsonb_array_elements_text(eff_kinds) as req(kind)
              where not (snapshot_kinds ? req.kind)
            ) then
            raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
          end if;
        end if;
        if approved_turn.effective_conditions ? 'replacements'
          and private.normalize_replacements(approved_turn.effective_conditions->'replacements') is null then
          raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
        end if;
        comparison_conditions := approved_turn.effective_conditions;
      end if;
    end if;
    ingestion := saved.result_snapshot;
    evidence := saved.evidence;
    use_synthetic_fixture := saved.demo_capture;
  end if;

  if job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;
  if notice_capture is not null then
    return jsonb_build_object('conditions', job.conditions_snapshot, 'ingestion', null, 'evidence', null,
      'useSyntheticFixture', false, 'selectionBindingIssue', null, 'noticeCapture', notice_capture);
  end if;
  payload := jsonb_build_object('conditions', job.conditions_snapshot, 'ingestion', ingestion, 'evidence', evidence,
    'useSyntheticFixture', use_synthetic_fixture, 'selectionBindingIssue', binding_issue);
  if comparison_period is not null then
    payload := payload || jsonb_build_object('comparisonPeriod', comparison_period);
  end if;
  if comparison_conditions is not null then
    payload := payload || jsonb_build_object('comparisonConditions', comparison_conditions);
  end if;
  return payload;
end;
$$;

-- 승인된 비교 조건 변경 실행 완료 시 private.check_approved_condition_comparison으로 전체 정합성을 검증한다.
create or replace function public.finish_analysis_comparison(
  p_run_id uuid, p_generation integer, p_lease_token uuid, p_input jsonb, p_result jsonb, p_comparison jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id, p_generation, p_lease_token);
  operation jsonb;
  captured_id uuid;
  snapshot public.analysis_input_snapshots%rowtype;
  approved_turn private.analysis_chat_turns%rowtype;
  sources text[] := '{}';
begin
  if not coalesce(jsonb_typeof(p_comparison) = 'object'
    and p_comparison->>'contractVersion' = 'comparison/v1'
    and p_comparison->>'dataOrigin' in ('synthetic','collected')
    and p_comparison->>'completeness' in ('complete','partial','unavailable')
    and (p_comparison->'appliedScope' = 'null'::jsonb or p_comparison->>'appliedScope' in ('priority','expansion'))
    and jsonb_typeof(p_comparison->'target') in ('object','null')
    and jsonb_typeof(p_comparison->'conditions') = 'object'
    and jsonb_typeof(p_comparison->'noticePrice') in ('object','null')
    and jsonb_typeof(p_comparison->'regionDecision') = 'object'
    and jsonb_typeof(p_comparison->'tradeKinds') = 'object'
    and jsonb_typeof(p_comparison->'collections') = 'array'
    and jsonb_typeof(p_comparison->'comparables') = 'array'
    and jsonb_typeof(p_comparison->'targetReferences') = 'array'
    and (not (p_comparison ? 'candidatePool') or jsonb_typeof(p_comparison->'candidatePool') = 'array')
    and jsonb_typeof(p_comparison->'holds') = 'array'
    and jsonb_typeof(p_comparison->'exclusions') = 'array'
    and jsonb_typeof(p_comparison->'rankingComplete') = 'boolean'
    and not private.comparison_contains_raw_payload(p_comparison), false) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;
  if jsonb_array_length(p_comparison->'comparables') > 5 then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  operation := private.finish_analysis_run_core(p_run_id, p_generation, p_lease_token, p_input, p_result, true);
  captured_id := (operation->>'snapshotId')::uuid;
  select * into strict snapshot from public.analysis_input_snapshots s
    where (s.id, s.analysis_id, s.user_id) = (captured_id, job.analysis_id, job.user_id);
  if p_comparison->>'dataOrigin' is distinct from snapshot.data_origin then
    raise exception 'comparison_snapshot_origin_mismatch' using errcode = '22023';
  end if;

  select * into approved_turn from private.analysis_chat_turns t
    where (t.result_run_id, t.analysis_id, t.user_id) = (job.id, job.analysis_id, job.user_id)
      and t.proposal_status = 'approved';
  if found then
    perform private.check_approved_condition_comparison(job, snapshot, approved_turn, p_comparison);
  end if;

  if snapshot.data_origin = 'collected' then
    sources := private.comparison_sources(captured_id, (select e.source_ids from private.comparison_evidence e
      where e.snapshot_id = captured_id and job.comparison_evidence_pinned));
    perform private.require_comparison_sources(sources);
  end if;
  insert into private.comparison_results(run_id, result, source_ids) values (job.id, p_comparison, sources);
  if job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;
  return operation;
end;
$$;

revoke all on function
  private.normalize_area_tolerance(jsonb),
  private.normalize_trade_kinds(jsonb),
  private.normalize_replacements(jsonb),
  private.extract_run_replacements(jsonb),
  private.is_demo_snapshot(public.analysis_input_snapshots),
  private.analysis_condition_bounds(uuid,uuid,uuid),
  private.analysis_conversation_payload(uuid,uuid,uuid),
  private.submit_analysis_chat_turn(uuid,uuid,uuid,text,text,date,date),
  private.submit_analysis_condition_turn(uuid,uuid,uuid,text,jsonb),
  private.decide_analysis_chat_turn(uuid,uuid,uuid,text),
  private.check_approved_condition_comparison(private.analysis_runs,public.analysis_input_snapshots,private.analysis_chat_turns,jsonb),
  public.submit_analysis_condition_turn(uuid,uuid,uuid,text,jsonb),
  public.read_comparison_work(uuid,integer,uuid),
  public.finish_analysis_comparison(uuid,integer,uuid,jsonb,jsonb,jsonb)
from public, anon, authenticated, service_role;

grant execute on function
  private.submit_analysis_chat_turn(uuid,uuid,uuid,text,text,date,date),
  private.submit_analysis_condition_turn(uuid,uuid,uuid,text,jsonb),
  private.decide_analysis_chat_turn(uuid,uuid,uuid,text),
  public.submit_analysis_condition_turn(uuid,uuid,uuid,text,jsonb)
to authenticated;

grant execute on function
  public.read_comparison_work(uuid,integer,uuid),
  public.finish_analysis_comparison(uuid,integer,uuid,jsonb,jsonb,jsonb)
to service_role;

notify pgrst, 'reload schema';
