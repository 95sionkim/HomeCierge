-- Q-52(2026-11-28): 주변 실거래 비교 기준을 공급면적 ±5%에서 같은 평형(전용면적 정수부)으로 전환한다.
-- 신규 조건 변경에서 areaTolerancePercent(Q-41)를 제거하고, 새 비교 결과(conditions.area.basis = 'exclusive_area_class')와
-- 기존에 저장된 공급면적 ±5% 기록의 읽기·검증 호환을 함께 유지한다.

-- 주택형(HOUSE_TY) 또는 전용면적 문자열에서 평형(주거전용면적의 정수부, 소수점 버림)을 추출한다.
create or replace function private.exclusive_area_class(p_value text)
returns integer language plpgsql immutable set search_path = '' as $$
declare
  matched text[];
  area_text text;
  amount numeric;
  cls integer;
begin
  if p_value is null or char_length(p_value) > 64 then
    return null;
  end if;
  matched := regexp_match(
    p_value,
    '\A\s*0*([1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)\s*(?:[A-Za-z][A-Za-z0-9_-]*|\([A-Za-z0-9_-]+\))?\s*\Z'
  );
  if matched is null then
    return null;
  end if;
  area_text := matched[1];
  if char_length(area_text) > 24 then
    return null;
  end if;
  amount := area_text::numeric;
  if amount <= 0 then
    return null;
  end if;
  cls := floor(amount)::integer;
  if cls < 1 then
    return null;
  end if;
  return cls;
end;
$$;

-- 직전 정의: 20261126100000_comparison_condition_changes.sql
-- Q-52: 공급면적 허용 범위 편집을 비활성화한다(areaEditable = false).
create or replace function private.analysis_condition_bounds(p_owner_id uuid, p_analysis_id uuid, p_run_id uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  analysis_row public.analyses%rowtype;
  base_run record;
  snapshot_row public.analysis_input_snapshots%rowtype;
  is_editable boolean := false;
  period_bounds jsonb := null;
  snapshot_kinds jsonb := '[]'::jsonb;
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
      'areaToleranceMax', '5',
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
    replacements_editable := period_bounds is not null
      and coalesce(base_run.comparison_result->>'appliedScope' in ('priority','expansion'), false)
      and (base_run.comparison_evidence_pinned or demo_capture);
  end if;

  return jsonb_build_object(
    'editable', is_editable,
    'period', period_bounds,
    'tradeKinds', snapshot_kinds,
    'areaToleranceMax', '5',
    'areaEditable', false,
    'replacementsEditable', is_editable and replacements_editable
  );
end;
$$;

-- 직전 정의: 20261126140000_analysis_agent_replies.sql
-- Q-52: exclusive_area_class 조건은 PDF 미허용 시에도 유지하고, 참고 공급면적(supplyAreaReference)의 출처 권한을 점검한다.
create or replace function private.filter_comparison_for_llm(p_result jsonb, p_source_ids text[])
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  data_origin text := coalesce(p_result->>'dataOrigin', 'synthetic');
  filtered jsonb := coalesce(p_result, '{}'::jsonb) - array['regionalNews', 'news', 'newsArticles', 'naverNews'];
  all_sources text[];
  allowed_sources text[];
  restricted_sources text[];
  pdf_allowed boolean := false;
  target_obj jsonb;
  notice_src text;
  rd_obj jsonb;
  scope_key text;
  scope_obj jsonb;
  group_key text;
  new_group jsonb;
  comp_item jsonb;
  id_src text;
  reg_src text;
  id_ok boolean;
  dist_obj jsonb;
  sref_obj jsonb;
  stats_obj jsonb;
  allowed_stats jsonb;
  kind_key text;
  stat_val jsonb;
  obs_ok boolean;
  area_ok boolean;
begin
  -- 합성 자료이며 등록 출처가 없는 경우에만 합성 데모 문맥을 그대로 전달한다(뉴스 키는 항상 제외).
  if data_origin = 'synthetic' and coalesce(cardinality(p_source_ids), 0) = 0 then
    return jsonb_build_object(
      'comparison', filtered,
      'llmSourcePolicy', jsonb_build_object(
        'dataOrigin', 'synthetic',
        'allowedSources', '[]'::jsonb,
        'restrictedSources', '[]'::jsonb,
        'hasRestrictedSources', false,
        'newsExcluded', true
      )
    );
  end if;

  select coalesce(array_agg(distinct s.id order by s.id), '{}'::text[])
    into all_sources
  from (
    select unnest(coalesce(p_source_ids, '{}'::text[])) as id
    union
    select c.val->>'source'
      from jsonb_array_elements(coalesce(filtered->'collections', '[]'::jsonb)) as c(val)
      where jsonb_typeof(c.val->'source') = 'string'
    union
    select filtered#>>'{target,noticeEvidence,source}'
      where jsonb_typeof(filtered#>'{target,noticeEvidence,source}') = 'string'
    union
    select filtered#>>'{target,noticeEvidence,linkEvidence,source}'
      where jsonb_typeof(filtered#>'{target,noticeEvidence,linkEvidence,source}') = 'string'
    union
    select 'applyhome_notice_pdf'
      where (
        jsonb_typeof(filtered#>'{target,supplyArea,evidence}') = 'array'
        and jsonb_array_length(filtered#>'{target,supplyArea,evidence}') > 0
      ) or (
        jsonb_typeof(filtered#>'{noticePrice,confirmedRooms}') = 'array'
        and jsonb_array_length(filtered#>'{noticePrice,confirmedRooms}') > 0
      )
    union
    select filtered#>>'{regionDecision,priority,evidence,source}'
      where jsonb_typeof(filtered#>'{regionDecision,priority,evidence,source}') = 'string'
    union
    select filtered#>>'{regionDecision,expansion,evidence,source}'
      where jsonb_typeof(filtered#>'{regionDecision,expansion,evidence,source}') = 'string'
    union
    select ref.val #>> '{}'
      from jsonb_path_query(
        jsonb_build_object(
          'comparables', coalesce(filtered->'comparables', '[]'::jsonb),
          'targetReferences', coalesce(filtered->'targetReferences', '[]'::jsonb)
        ),
        'strict $.** ? (@.type() == "object" && exists(@.source)).source'
      ) as ref(val)
      where jsonb_typeof(ref.val) = 'string'
  ) as s
  where s.id is not null and btrim(s.id) <> '';

  select
    coalesce(array_agg(s.id order by s.id) filter (where private.source_llm_allowed(s.id)), '{}'::text[]),
    coalesce(array_agg(s.id order by s.id) filter (where not private.source_llm_allowed(s.id)), '{}'::text[])
    into allowed_sources, restricted_sources
  from unnest(all_sources) as s(id);

  if cardinality(restricted_sources) = 0 then
    return jsonb_build_object(
      'comparison', filtered,
      'llmSourcePolicy', jsonb_build_object(
        'dataOrigin', data_origin,
        'allowedSources', to_jsonb(allowed_sources),
        'restrictedSources', '[]'::jsonb,
        'hasRestrictedSources', false,
        'newsExcluded', true
      )
    );
  end if;

  pdf_allowed := private.source_llm_allowed('applyhome_notice_pdf');

  -- 1) 대상 공고·가격(PDF·공고 목록)
  if jsonb_typeof(filtered->'target') = 'object' then
    target_obj := filtered->'target';
    notice_src := target_obj#>>'{noticeEvidence,source}';
    if notice_src is not null and not private.source_llm_allowed(notice_src) then
      target_obj := target_obj || jsonb_build_object(
        'name', null,
        'houseManageNo', null,
        'noticeNo', null,
        'noticeEvidence', jsonb_build_object('status', 'restricted_for_llm')
      );
    elsif jsonb_typeof(target_obj#>'{noticeEvidence,linkEvidence,source}') = 'string'
      and not private.source_llm_allowed(target_obj#>>'{noticeEvidence,linkEvidence,source}') then
      target_obj := jsonb_set(target_obj, '{noticeEvidence,linkEvidence}', '{"status":"restricted_for_llm"}'::jsonb, false);
    end if;
    if not pdf_allowed and jsonb_typeof(target_obj->'supplyArea') = 'object' then
      target_obj := jsonb_set(
        target_obj,
        '{supplyArea}',
        jsonb_build_object(
          'status', 'restricted_for_llm',
          'basis', 'supply',
          'm2', null,
          'reasons', jsonb_build_array('source_llm_permission_not_allowed')
        ),
        false
      );
      if jsonb_typeof(filtered->'conditions') = 'object'
        and filtered#>>'{conditions,area,basis}' = 'supply' then
        filtered := jsonb_set(filtered, '{conditions,area}', 'null'::jsonb, false);
      end if;
    end if;
    filtered := jsonb_set(filtered, '{target}', target_obj, false);
  end if;

  if not pdf_allowed and jsonb_typeof(filtered->'noticePrice') = 'object' then
    filtered := jsonb_set(
      filtered,
      '{noticePrice}',
      jsonb_build_object(
        'status', 'restricted_for_llm',
        'reasons', jsonb_build_array('source_llm_permission_not_allowed')
      ),
      false
    );
  end if;

  -- 2) 지역 결정 근거
  if jsonb_typeof(filtered->'regionDecision') = 'object' then
    rd_obj := filtered->'regionDecision';
    foreach scope_key in array array['priority', 'expansion'] loop
      if jsonb_typeof(rd_obj->scope_key) = 'object' then
        scope_obj := rd_obj->scope_key;
        if jsonb_typeof(scope_obj#>'{evidence,source}') = 'string'
          and not private.source_llm_allowed(scope_obj#>>'{evidence,source}') then
          scope_obj := scope_obj || jsonb_build_object(
            'name', null,
            'code', null,
            'requestRegionCodes', '[]'::jsonb,
            'evidence', jsonb_build_object('status', 'restricted_for_llm'),
            'restrictedForLlm', true
          );
          rd_obj := jsonb_set(rd_obj, array[scope_key], scope_obj, false);
        end if;
      end if;
    end loop;
    filtered := jsonb_set(filtered, '{regionDecision}', rd_obj, false);
  end if;

  -- 3) 수집 기록
  if jsonb_typeof(filtered->'collections') = 'array' then
    filtered := jsonb_set(
      filtered,
      '{collections}',
      coalesce(
        (
          select jsonb_agg(c.val)
          from jsonb_array_elements(filtered->'collections') as c(val)
          where jsonb_typeof(c.val) = 'object'
            and private.source_llm_allowed(c.val->>'source')
        ),
        '[]'::jsonb
      ),
      false
    );
  end if;

  -- 4) 비교 단지 및 대상 단지 자체 거래
  foreach group_key in array array['comparables', 'targetReferences'] loop
    if jsonb_typeof(filtered->group_key) = 'array' then
      new_group := '[]'::jsonb;
      for comp_item in select val from jsonb_array_elements(filtered->group_key) as g(val) loop
        if jsonb_typeof(comp_item) <> 'object' then
          continue;
        end if;
        id_src := comp_item#>>'{identityEvidence,source}';
        reg_src := comp_item#>>'{regionEvidence,source}';
        id_ok := (id_src is null) or private.source_llm_allowed(id_src);
        if not id_ok then
          comp_item := comp_item || jsonb_build_object(
            'name', null,
            'identityEvidence', jsonb_build_object('status', 'restricted_for_llm')
          );
        end if;
        if reg_src is not null and not private.source_llm_allowed(reg_src) then
          comp_item := comp_item || jsonb_build_object(
            'localityCode', null,
            'regionEvidence', jsonb_build_object('status', 'restricted_for_llm')
          );
        end if;
        if jsonb_typeof(comp_item->'distance') = 'object' then
          dist_obj := comp_item->'distance';
          if exists (
            select 1 from jsonb_array_elements(coalesce(dist_obj->'evidence', '[]'::jsonb)) as de(val)
            where jsonb_typeof(de.val) = 'object'
              and not private.source_llm_allowed(de.val->>'source')
          ) then
            comp_item := jsonb_set(
              comp_item,
              '{distance}',
              jsonb_build_object('kind', coalesce(dist_obj->>'kind', 'straight_line'), 'status', 'restricted_for_llm'),
              false
            );
          end if;
        end if;

        if jsonb_typeof(comp_item->'supplyAreaReference') = 'object' then
          sref_obj := comp_item->'supplyAreaReference';
          if jsonb_typeof(sref_obj#>'{evidence,source}') = 'string'
            and not private.source_llm_allowed(sref_obj#>>'{evidence,source}') then
            comp_item := comp_item || jsonb_build_object(
              'supplyAreaM2', null,
              'supplyAreaReference', jsonb_build_object(
                'status', 'restricted_for_llm',
                'm2', null,
                'minM2', null,
                'maxM2', null
              )
            );
          end if;
        end if;

        allowed_stats := '{}'::jsonb;
        area_ok := true;
        if jsonb_typeof(comp_item->'tradeStats') = 'object' then
          stats_obj := comp_item->'tradeStats';
          for kind_key, stat_val in select key, value from jsonb_each(stats_obj) loop
            if jsonb_typeof(stat_val) <> 'object'
              or jsonb_typeof(stat_val->'observations') <> 'array'
              or jsonb_array_length(stat_val->'observations') = 0 then
              continue;
            end if;
            select not exists (
              select 1 from jsonb_array_elements(stat_val->'observations') as o(obs)
              where jsonb_typeof(o.obs) <> 'object'
                or not private.source_llm_allowed(o.obs->>'source')
                or (jsonb_typeof(o.obs->'evidence') = 'object'
                  and not private.source_llm_allowed(o.obs#>>'{evidence,source}'))
            ) into obs_ok;
            if obs_ok then
              allowed_stats := allowed_stats || jsonb_build_object(kind_key, stat_val);
            elsif exists (
              select 1 from jsonb_array_elements(stat_val->'observations') as o(obs)
              where jsonb_typeof(o.obs->'evidence') = 'object'
                and not private.source_llm_allowed(o.obs#>>'{evidence,source}')
            ) then
              area_ok := false;
            end if;
          end loop;
        end if;

        if not area_ok then
          comp_item := comp_item || jsonb_build_object('supplyAreaM2', null, 'areaDifferenceM2', null);
          if jsonb_typeof(comp_item->'supplyAreaReference') = 'object'
            and comp_item#>>'{supplyAreaReference,status}' in ('single', 'range') then
            comp_item := jsonb_set(
              comp_item,
              '{supplyAreaReference}',
              jsonb_build_object('status', 'restricted_for_llm', 'm2', null, 'minM2', null, 'maxM2', null),
              false
            );
          end if;
        end if;
        comp_item := jsonb_set(comp_item, '{tradeStats}', allowed_stats, false);

        if id_ok and allowed_stats <> '{}'::jsonb then
          new_group := new_group || jsonb_build_array(comp_item);
        end if;
      end loop;
      filtered := jsonb_set(filtered, array[group_key], new_group, false);
    end if;
  end loop;

  -- 5) 후보 풀은 관련 출처가 제한되면 비워 둔다.
  if filtered ? 'candidatePool' then
    filtered := jsonb_set(filtered, '{candidatePool}', '[]'::jsonb, false);
  end if;

  return jsonb_build_object(
    'comparison', filtered,
    'llmSourcePolicy', jsonb_build_object(
      'dataOrigin', data_origin,
      'allowedSources', to_jsonb(allowed_sources),
      'restrictedSources', to_jsonb(restricted_sources),
      'hasRestrictedSources', true,
      'newsExcluded', true
    )
  );
end;
$$;

-- 직전 정의: 20261126140000_analysis_agent_replies.sql
-- Q-52: 신규 조건 변경 제안에서 areaTolerancePercent를 허용하지 않고 기간·거래 종류·단지 교체만 검증한다.
create or replace function private.prepare_validated_condition_proposal(
  p_owner_id uuid,
  p_analysis_row public.analyses,
  p_base_run private.analysis_runs,
  p_comparison_result jsonb,
  p_conditions jsonb,
  out norm_proposed jsonb,
  out norm_previous jsonb,
  out norm_effective jsonb
) returns record language plpgsql set search_path = '' as $$
declare
  snapshot_row public.analysis_input_snapshots%rowtype;
  demo_capture boolean := false;
  base_period jsonb;
  prev_start date;
  prev_end date;
  prop_start date;
  prop_end date;
  base_kinds jsonb;
  snapshot_kinds jsonb;
  prop_kinds jsonb;
  base_replacements jsonb;
  prop_replacements jsonb;
  raw_period jsonb;
begin
  norm_proposed := '{}'::jsonb;
  norm_previous := '{}'::jsonb;
  norm_effective := '{}'::jsonb;

  if p_conditions is null or jsonb_typeof(p_conditions) <> 'object'
    or p_conditions = '{}'::jsonb
    or private.comparison_contains_raw_payload(p_conditions) then
    raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_conditions) as k(name)
    where k.name not in ('period','tradeKinds','replacements')
  ) then
    raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
  end if;

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

  if p_analysis_row.latest_run_id is distinct from p_base_run.id
    or (p_analysis_row.conditions_snapshot, p_analysis_row.rules_version, p_analysis_row.notice_id, p_analysis_row.housing_type_id)
       is distinct from (p_base_run.conditions_snapshot, p_base_run.rules_version, p_base_run.notice_id, p_base_run.housing_type_id) then
    raise exception 'analysis_chat_stale_run' using errcode = 'PT409';
  end if;

  select * into snapshot_row from public.analysis_input_snapshots s
    where (s.id, s.analysis_id, s.user_id) = (p_base_run.snapshot_id, p_analysis_row.id, p_owner_id)
    for key share;
  if not found
    or p_base_run.notice_id is not null or p_base_run.housing_type_id is not null
    or snapshot_row.notice_id is not null or snapshot_row.housing_type_id is not null
    or (snapshot_row.conditions_snapshot, snapshot_row.rules_version, snapshot_row.notice_id, snapshot_row.housing_type_id)
       is distinct from (p_base_run.conditions_snapshot, p_base_run.rules_version, p_base_run.notice_id, p_base_run.housing_type_id)
    or snapshot_row.period_start is null or snapshot_row.period_end is null
    or snapshot_row.result_snapshot#>>'{period,status}' is distinct from 'confirmed' then
    if p_conditions ? 'period' then
      raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
    end if;
    raise exception 'analysis_chat_condition_unavailable' using errcode = 'PT409';
  end if;

  demo_capture := private.is_demo_snapshot(snapshot_row);
  base_period := p_comparison_result#>'{conditions,period}';
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
  base_kinds := private.normalize_trade_kinds(p_comparison_result#>'{conditions,tradeKinds}');
  base_replacements := private.extract_run_replacements(p_comparison_result);

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
    if not coalesce(p_comparison_result->>'appliedScope' in ('priority','expansion'), false)
      or (not p_base_run.comparison_evidence_pinned and not demo_capture) then
      raise exception 'analysis_chat_condition_unavailable' using errcode = 'PT409';
    end if;
    if prop_replacements = base_replacements then
      raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
    end if;
    norm_previous := norm_previous || jsonb_build_object('replacements', base_replacements);
    norm_effective := norm_effective || jsonb_build_object('replacements', prop_replacements);
  elsif jsonb_array_length(base_replacements) > 0
    or (p_base_run.conditions_snapshot#>'{comparison,replacements}') is not null then
    norm_effective := norm_effective || jsonb_build_object('replacements', base_replacements);
  end if;
end;
$$;

-- 직전 정의: 20261126140000_analysis_agent_replies.sql
-- Q-52: 신규 조건 변경 제출에서 areaTolerancePercent를 허용하지 않는다.
create or replace function private.submit_analysis_condition_turn(
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
  base_run private.analysis_runs%rowtype;
  comparison_result jsonb;
  comparison_source_ids text[];
  existing_turn private.analysis_chat_turns%rowtype;
  norm_check jsonb := '{}'::jsonb;
  raw_period jsonb;
  prop_start date;
  prop_end date;
  prop_kinds jsonb;
  prop_replacements jsonb;
  prepared record;
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
    where k.name not in ('period','tradeKinds','replacements')
  ) then
    raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
  end if;
  trimmed_message := private.normalize_analysis_chat_message(p_message);

  -- 입력 형식 오류는 잠금·멱등 비교 전에 사전 검증하고 정규화 형태를 확정한다.
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
    norm_check := norm_check || jsonb_build_object(
      'period', jsonb_build_object('start', to_char(prop_start, 'YYYY-MM-DD'), 'end', to_char(prop_end, 'YYYY-MM-DD'))
    );
  end if;
  if p_conditions ? 'tradeKinds' then
    prop_kinds := private.normalize_trade_kinds(p_conditions->'tradeKinds');
    if prop_kinds is null then
      raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
    end if;
    norm_check := norm_check || jsonb_build_object('tradeKinds', prop_kinds);
  end if;
  if p_conditions ? 'replacements' then
    prop_replacements := private.normalize_replacements(p_conditions->'replacements');
    if prop_replacements is null then
      raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
    end if;
    norm_check := norm_check || jsonb_build_object('replacements', prop_replacements);
  end if;

  select * into analysis_row from public.analyses a
    where (a.id, a.user_id) = (p_analysis_id, owner_id) for no key update;
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;

  select r.* into base_run
    from private.analysis_runs r
    where (r.id, r.analysis_id, r.user_id) = (p_run_id, p_analysis_id, owner_id);
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;
  select c.result, c.source_ids into comparison_result, comparison_source_ids
    from private.comparison_results c
    where c.run_id = base_run.id and base_run.status = 'finished';
  if comparison_result is null then
    raise exception 'analysis_comparison_not_ready' using errcode = 'PT409';
  end if;
  perform private.require_comparison_chat_sources(comparison_source_ids);

  select * into existing_turn from private.analysis_chat_turns t
    where (t.analysis_id, t.base_run_id, t.request_id) = (p_analysis_id, p_run_id, p_request_id);
  if found then
    if (existing_turn.message, existing_turn.intent, existing_turn.proposed_conditions)
       is distinct from (trimmed_message, 'change_conditions', norm_check) then
      raise exception 'analysis_chat_request_conflict' using errcode = 'PT409';
    end if;
    return private.analysis_conversation_payload(owner_id, p_analysis_id, p_run_id);
  end if;

  select * into prepared from private.prepare_validated_condition_proposal(
    owner_id, analysis_row, base_run, comparison_result, p_conditions
  );

  insert into private.analysis_chat_turns(
    analysis_id, base_run_id, user_id, request_id, message, intent,
    proposed_conditions, previous_conditions, effective_conditions, proposal_status
  ) values (
    p_analysis_id, p_run_id, owner_id, p_request_id, trimmed_message, 'change_conditions',
    prepared.norm_proposed, prepared.norm_previous, prepared.norm_effective, 'pending'
  );

  return private.analysis_conversation_payload(owner_id, p_analysis_id, p_run_id);
end;
$$;

-- 직전 정의: 20261126140000_analysis_agent_replies.sql
-- Q-52: 기간 단독 변경 턴의 effective_conditions에서 areaTolerancePercent를 승계하지 않는다.
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
  existing_reply private.analysis_agent_replies%rowtype;
  snapshot_row public.analysis_input_snapshots%rowtype;
  base_period jsonb;
  previous_start date;
  previous_end date;
  carried jsonb := '{}'::jsonb;
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
      select * into existing_reply from private.analysis_agent_replies ar
        where ar.turn_id = existing_turn.id;
      if not (
        found
        and existing_reply.proposal_attached is true
        and existing_turn.message = trimmed_message
        and existing_reply.original_intent = p_intent
        and p_start is null and p_end is null
      ) then
        raise exception 'analysis_chat_request_conflict' using errcode = 'PT409';
      end if;
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

-- 직전 정의: 20261126100000_comparison_condition_changes.sql
-- Q-52: 이전 공급면적 허용 범위(areaTolerancePercent) 대기 제안은 거절·취소만 가능하고 신규 승인 실행은 차단한다.
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

  if coalesce(turn_row.effective_conditions ? 'areaTolerancePercent', false) then
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

-- 직전 정의: 20261127150000_set_based_save_validation.sql
-- Q-52: 새 평형 기준(exclusive_area_class)과 이전 공급면적 기준(supply) 결과를 모두 검증한다.
create or replace function private.check_approved_condition_comparison(
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
  result_area_basis text;
  expected_area_class integer;
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
  -- 기존 supply 결과에서 새 평형 기준으로 재계산할 때 target의 exclusiveAreaM2·areaClass 추가를 허용하되
  -- 나머지 대상 공고 필드는 그대로 유지되어야 한다.
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
    and ((p_comparison->'target') - array['exclusiveAreaM2','areaClass'])
        is not distinct from ((base_run.comparison_result->'target') - array['exclusiveAreaM2','areaClass'])
    and (
      not (base_run.comparison_result->'target' ? 'areaClass')
      or p_comparison#>'{target,areaClass}' is not distinct from base_run.comparison_result#>'{target,areaClass}'
    )
    and (
      not (base_run.comparison_result->'target' ? 'exclusiveAreaM2')
      or p_comparison#>'{target,exclusiveAreaM2}' is not distinct from base_run.comparison_result#>'{target,exclusiveAreaM2}'
    )
    and p_comparison->'noticePrice' is not distinct from base_run.comparison_result->'noticePrice',
    false
  ) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  -- 4) 비교 면적 조건 검증: Q-52 평형 기준(exclusive_area_class)과 이전 공급면적 기준(supply)을 함께 지원한다.
  result_area_basis := p_comparison#>>'{conditions,area,basis}';
  if result_area_basis = 'exclusive_area_class' then
    expected_area_class := private.exclusive_area_class(base_run.comparison_result#>>'{target,houseType}');
    if expected_area_class is null
      or eff ? 'areaTolerancePercent'
      or jsonb_typeof(p_comparison#>'{conditions,area}') <> 'object'
      or (select count(*) from jsonb_object_keys(p_comparison#>'{conditions,area}')) <> 2
      or p_comparison#>'{conditions,area,class}' is distinct from to_jsonb(expected_area_class)
      or (
        p_comparison->'target' ? 'areaClass'
        and p_comparison#>'{target,areaClass}' is distinct from to_jsonb(expected_area_class)
      ) then
      raise exception 'invalid_comparison_result' using errcode = '22023';
    end if;
  elsif base_run.comparison_result#>>'{target,supplyArea,status}' = 'confirmed'
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

  -- 7) 포함된 모든 주변 단지·자체 거래는 승인 기간·거래 종류·평형 또는 공급면적 경계를 만족해야 한다.
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
      or (expected_area_class is not null and (
        item.entry->'areaClass' is distinct from to_jsonb(expected_area_class)
        or (
          item.entry ? 'supplyAreaReference'
          and item.entry->'supplyAreaReference' <> 'null'::jsonb
          and (
            jsonb_typeof(item.entry->'supplyAreaReference') <> 'object'
            or item.entry#>>'{supplyAreaReference,status}' not in ('single', 'range', 'unavailable')
          )
        )
      ))
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
            where not coalesce(
              jsonb_typeof(o.obs) = 'object'
              and jsonb_typeof(o.obs->'contractDate') = 'string'
              and (case
                when o.obs->>'contractDate' ~ '\A[0-9]{4}-[0-9]{2}-[0-9]{2}\Z'
                  and pg_input_is_valid(o.obs->>'contractDate', 'date')
                then (o.obs->>'contractDate')::date between expected_start and expected_end
                else false end)
              and (
                expected_area_class is null
                or (
                  jsonb_typeof(o.obs->'exclusiveAreaM2') = 'string'
                  and private.exclusive_area_class(o.obs->>'exclusiveAreaM2') = expected_area_class
                )
              ),
              false
            )
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
        and r.input->>'kind' in ('notice', 'upload_supplement');
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

revoke all on function private.exclusive_area_class(text) from public, anon, authenticated;

notify pgrst, 'reload schema';
