-- 비교 대화의 비동기 LLM 에이전트 응답 대기열, 출처별 llm_permission 필터링,
-- 작업자 임대/완료/실패/만료 RPC 및 승인 대기 제안 검증을 추가한다.
-- 프롬프트 원문과 결과 전체 스냅샷은 따로 저장하지 않는다.
-- 기존 private.analysis_chat_turns 테이블 열은 변경하지 않으며 turn_id FK on delete cascade로
-- 개별 턴·분석·계정 삭제 시 에이전트 응답도 함께 정리된다.

create table private.agent_settings (
  singleton boolean primary key default true check (singleton is true),
  enabled boolean not null default false,
  model text not null default 'gpt-6.1-sol'
    check (model in ('gpt-6.1-sol','gpt-6.1-terra','gpt-6-luna','gpt-6-astra')),
  updated_at timestamptz not null default clock_timestamp()
);

insert into private.agent_settings(singleton, enabled, model)
values (true, false, 'gpt-6.1-sol');

alter table private.agent_settings enable row level security;
revoke all on private.agent_settings from public, anon, authenticated, service_role;

create table private.analysis_agent_replies (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null unique references private.analysis_chat_turns(id) on delete cascade,
  analysis_id uuid not null,
  base_run_id uuid not null,
  user_id uuid not null,
  original_intent text not null
    check (original_intent in ('inclusion','holds','scope','price','period','change_period','change_conditions','help')),
  status text not null default 'queued'
    check (status in ('queued','leased','answered','rejected','failed','expired')),
  model text not null
    check (model in ('gpt-6.1-sol','gpt-6.1-terra','gpt-6-luna','gpt-6-astra')),
  prompt_version text check (prompt_version is null or char_length(prompt_version) between 1 and 80),
  generation integer not null default 0 check (generation >= 0),
  lease_token uuid,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  resolved_intent text
    check (resolved_intent is null or resolved_intent in ('inclusion','holds','scope','price','period','change_period','change_conditions','help')),
  answer_text text
    check (
      answer_text is null or (
        char_length(answer_text) between 1 and 2000
        and answer_text !~ '[\u0001-\u0009\u000B-\u001F\u007F]'
        and answer_text = btrim(answer_text)
      )
    ),
  citations jsonb not null default '[]'::jsonb check (jsonb_typeof(citations) = 'array'),
  proposal_attached boolean not null default false,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  reasoning_tokens integer check (reasoning_tokens is null or reasoning_tokens >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  estimated_cost_usd numeric(14,8) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  pricing_as_of date,
  validation_status text check (validation_status is null or validation_status in ('passed','rejected')),
  validation_reasons text[] not null default '{}',
  failure_code text check (failure_code is null or char_length(failure_code) between 1 and 80),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  foreign key (analysis_id, user_id) references public.analyses(id, user_id) on delete cascade,
  foreign key (base_run_id, analysis_id, user_id) references private.analysis_runs(id, analysis_id, user_id) on delete cascade,
  check ((status = 'leased') = (lease_token is not null and lease_expires_at is not null)),
  check ((status = 'answered') = (answer_text is not null)),
  check (status <> 'answered' or validation_status = 'passed'),
  check (status <> 'rejected' or (answer_text is null and validation_status = 'rejected')),
  check ((status in ('answered','rejected','failed','expired')) = (completed_at is not null)),
  check (not proposal_attached or status = 'answered')
);

create index analysis_agent_replies_queue_idx
  on private.analysis_agent_replies(created_at asc, id asc) where status = 'queued';
create index analysis_agent_replies_lease_idx
  on private.analysis_agent_replies(lease_expires_at asc) where status = 'leased';
create index analysis_agent_replies_owner_idx
  on private.analysis_agent_replies(user_id, analysis_id, base_run_id);

alter table private.analysis_agent_replies enable row level security;
revoke all on private.analysis_agent_replies from public, anon, authenticated, service_role;

-- 기능 설정이 켜진 경우에만 새 대화 턴에 에이전트 응답 대기열 행을 만든다.
create function private.enqueue_agent_reply_for_turn()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  cfg private.agent_settings%rowtype;
begin
  select * into cfg from private.agent_settings where singleton is true;
  if found and cfg.enabled is true then
    insert into private.analysis_agent_replies(
      turn_id, analysis_id, base_run_id, user_id, original_intent, status, model
    ) values (
      new.id, new.analysis_id, new.base_run_id, new.user_id, new.intent, 'queued', cfg.model
    ) on conflict (turn_id) do nothing;
  end if;
  return new;
end;
$$;

create trigger enqueue_agent_reply_on_turn
  after insert on private.analysis_chat_turns
  for each row execute function private.enqueue_agent_reply_for_turn();

-- 출처별 LLM 입력 허용 여부를 확인한다. 지역 뉴스와 사용자 업로드는 어떤 경우에도 LLM 입력에서 제외한다.
create function private.source_llm_allowed(p_source_id text)
returns boolean language sql stable set search_path = '' as $$
  select p_source_id is not null
    and p_source_id not in ('naver_news', 'user_upload', 'upload')
    and exists (
      select 1 from public.source_registry r
      where r.id = p_source_id and r.llm_permission = 'allowed'
    );
$$;

-- 비교 결과에서 llm_permission = 'allowed'인 출처의 값만 남기고 미허용 출처·뉴스를 제외한다.
create function private.filter_comparison_for_llm(p_result jsonb, p_source_ids text[])
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
      if jsonb_typeof(filtered->'conditions') = 'object' then
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

-- 조건 변경 제안을 검증하고 정규화된 proposed/previous/effective 조건을 계산한다.
-- 사용자 직접 제출(submit_analysis_condition_turn)과 에이전트 제안 첨부(complete_agent_reply)가 같은 검증을 공유한다.
create function private.prepare_validated_condition_proposal(
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
  base_area text;
  prop_area text;
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
    where k.name not in ('period','areaTolerancePercent','tradeKinds','replacements')
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
  if p_comparison_result#>>'{target,supplyArea,status}' = 'confirmed'
    and p_comparison_result#>>'{conditions,area,basis}' = 'supply' then
    base_area := private.normalize_area_tolerance(p_comparison_result#>'{conditions,area,tolerancePercent}');
  end if;
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
    and (base_area::numeric <> 5 or (p_base_run.conditions_snapshot#>'{comparison,areaTolerancePercent}') is not null) then
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

-- 기존 submit_analysis_condition_turn이 공통 검증 함수(prepare_validated_condition_proposal)를 사용하도록 연결한다.
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
  prop_area text;
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
    where k.name not in ('period','areaTolerancePercent','tradeKinds','replacements')
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
  if p_conditions ? 'areaTolerancePercent' then
    prop_area := private.normalize_area_tolerance(p_conditions->'areaTolerancePercent');
    if prop_area is null then
      raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
    end if;
    norm_check := norm_check || jsonb_build_object('areaTolerancePercent', prop_area);
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

-- 에이전트가 검증된 조건 제안을 기존 턴에 첨부한 뒤에도 동일 request_id 재전송이 멱등하게 동작하도록 보완한다.
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

-- 소유자 대화 조회 응답에 검증된 에이전트 응답(agentReply)을 포함한다.
-- 만료된 임대는 즉시 expired로 표시해 대기 작업 없이 '작성 중'이 보이지 않게 한다(A-58).
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
            end,
            'agentReply', case
              when ar.id is null then null
              else jsonb_build_object(
                'status', case
                  when ar.status = 'leased' and ar.lease_expires_at <= clock_timestamp() then 'expired'
                  else ar.status
                end,
                'model', ar.model,
                'answer', case when ar.status = 'answered' then ar.answer_text else null end,
                'citations', case when ar.status = 'answered' then ar.citations else '[]'::jsonb end,
                'completedAt', case
                  when ar.status = 'leased' and ar.lease_expires_at <= clock_timestamp() then ar.lease_expires_at
                  else ar.completed_at
                end
              )
            end
          )
          order by w.turn_order asc
        )
        from windowed w
        left join private.analysis_agent_replies ar on ar.turn_id = w.id
      ),
      '[]'::jsonb
    ),
    'hasEarlier', (select count(*) > 30 from recent)
  );
$$;

-- 만료된 에이전트 임대를 expired 상태로 정리한다.
create function private.expire_stale_agent_replies_core()
returns integer language plpgsql set search_path = '' as $$
declare
  affected integer;
begin
  update private.analysis_agent_replies
    set status = 'expired',
        lease_token = null,
        lease_expires_at = null,
        failure_code = 'lease_expired',
        completed_at = clock_timestamp()
    where status = 'leased'
      and lease_expires_at <= clock_timestamp();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- 작업자용 기능 설정 변경(service_role 전용).
create function public.configure_agent_settings(
  p_enabled boolean,
  p_model text default 'gpt-6.1-sol'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  updated_row private.agent_settings%rowtype;
begin
  if p_enabled is null or p_model is null
    or p_model not in ('gpt-6.1-sol','gpt-6.1-terra','gpt-6-luna','gpt-6-astra') then
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

create function public.expire_stale_agent_replies()
returns integer language plpgsql security definer set search_path = '' as $$
begin
  return private.expire_stale_agent_replies_core();
end;
$$;

create function public.claim_agent_reply(
  p_lease_seconds integer default 60,
  p_reply_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  claimed private.analysis_agent_replies%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds not between 1 and 300 then
    raise exception 'invalid_agent_lease' using errcode = '22023';
  end if;

  perform private.expire_stale_agent_replies_core();

  select ar.* into claimed
    from private.analysis_agent_replies ar
    where ar.status = 'queued'
      and (p_reply_id is null or ar.id = p_reply_id)
      and not exists (
        select 1 from private.account_deletion_fences f where f.user_id = ar.user_id
      )
    order by ar.created_at asc, ar.id asc
    limit 1
    for update skip locked;

  if not found then
    return null;
  end if;

  update private.analysis_agent_replies
    set status = 'leased',
        generation = generation + 1,
        lease_token = gen_random_uuid(),
        leased_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    where id = claimed.id
    returning * into claimed;

  return jsonb_build_object(
    'replyId', claimed.id,
    'turnId', claimed.turn_id,
    'analysisId', claimed.analysis_id,
    'runId', claimed.base_run_id,
    'generation', claimed.generation,
    'leaseToken', claimed.lease_token,
    'model', claimed.model,
    'leaseExpiresAt', claimed.lease_expires_at
  );
end;
$$;

create function private.lock_leased_agent_reply(
  p_reply_id uuid,
  p_generation integer,
  p_lease_token uuid
) returns private.analysis_agent_replies language plpgsql set search_path = '' as $$
declare
  reply_row private.analysis_agent_replies%rowtype;
begin
  if p_reply_id is null or p_generation is null or p_generation < 1 or p_lease_token is null then
    raise exception 'invalid_agent_lease' using errcode = '22023';
  end if;

  select * into reply_row
    from private.analysis_agent_replies ar
    where ar.id = p_reply_id
    for update;
  if not found then
    raise exception 'agent_reply_not_found' using errcode = 'PT404';
  end if;
  if exists (select 1 from private.account_deletion_fences f where f.user_id = reply_row.user_id) then
    raise exception 'agent_reply_not_found' using errcode = 'PT404';
  end if;
  if reply_row.status <> 'leased'
    or reply_row.generation <> p_generation
    or reply_row.lease_token is distinct from p_lease_token
    or reply_row.lease_expires_at <= clock_timestamp() then
    raise exception 'agent_reply_stale_lease' using errcode = 'PT409';
  end if;
  return reply_row;
end;
$$;

-- 작업자가 임대 중인 턴의 문맥을 읽는다. llm_permission = 'allowed' 출처의 값만 포함한다.
create function public.read_agent_reply_context(
  p_reply_id uuid,
  p_generation integer,
  p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  reply_row private.analysis_agent_replies%rowtype := private.lock_leased_agent_reply(p_reply_id, p_generation, p_lease_token);
  turn_row private.analysis_chat_turns%rowtype;
  comp_row private.comparison_results%rowtype;
  filtered_bundle jsonb;
  existing_proposal jsonb := null;
begin
  select * into turn_row from private.analysis_chat_turns t where t.id = reply_row.turn_id;
  if not found then
    raise exception 'agent_reply_not_found' using errcode = 'PT404';
  end if;
  select * into comp_row from private.comparison_results c where c.run_id = reply_row.base_run_id;
  if not found then
    raise exception 'agent_reply_not_found' using errcode = 'PT404';
  end if;

  if turn_row.intent = 'change_period' then
    existing_proposal := jsonb_build_object(
      'start', to_char(turn_row.proposed_start, 'YYYY-MM-DD'),
      'end', to_char(turn_row.proposed_end, 'YYYY-MM-DD'),
      'previousStart', to_char(turn_row.previous_start, 'YYYY-MM-DD'),
      'previousEnd', to_char(turn_row.previous_end, 'YYYY-MM-DD'),
      'status', turn_row.proposal_status
    );
  elsif turn_row.intent = 'change_conditions' then
    existing_proposal := jsonb_build_object(
      'kind', 'conditions',
      'previous', turn_row.previous_conditions,
      'proposed', turn_row.proposed_conditions,
      'effective', turn_row.effective_conditions,
      'status', turn_row.proposal_status
    );
  end if;

  filtered_bundle := private.filter_comparison_for_llm(comp_row.result, comp_row.source_ids);

  return jsonb_build_object(
    'replyId', reply_row.id,
    'turnId', reply_row.turn_id,
    'analysisId', reply_row.analysis_id,
    'runId', reply_row.base_run_id,
    'model', reply_row.model,
    'message', turn_row.message,
    'existingIntent', turn_row.intent,
    'existingProposal', existing_proposal,
    'comparison', filtered_bundle->'comparison',
    'llmSourcePolicy', filtered_bundle->'llmSourcePolicy',
    'conditionBounds', private.analysis_condition_bounds(reply_row.user_id, reply_row.analysis_id, reply_row.base_run_id)
  );
end;
$$;

create function private.valid_agent_citations(p_citations jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_citations) = 'array'
    and jsonb_array_length(p_citations) <= 20
    and not exists (
      select 1 from jsonb_array_elements(p_citations) as c(val)
      where jsonb_typeof(c.val) <> 'object'
        or (select count(*) from jsonb_object_keys(c.val)) <> 3
        or jsonb_typeof(c.val->'kind') <> 'string'
        or (c.val->>'kind') not in ('comparison','condition','hold','exclusion','document','trade','region','source_restriction')
        or jsonb_typeof(c.val->'reference') <> 'string'
        or char_length(btrim(c.val->>'reference')) not between 1 and 120
        or jsonb_typeof(c.val->'label') <> 'string'
        or char_length(btrim(c.val->>'label')) not between 1 and 120
    );
$$;

-- 작업자가 검증을 마친 에이전트 응답을 기록한다.
-- 제안 초안이 있으면 기존 조건 변경 검증 함수(prepare_validated_condition_proposal)로 검증해
-- 사용자의 승인 대기(pending) 제안으로만 첨부하며, 검증 실패 시 답변을 버리고 rejected로 기록한다.
create function public.complete_agent_reply(
  p_reply_id uuid,
  p_generation integer,
  p_lease_token uuid,
  p_status text,
  p_intent text default null,
  p_answer text default null,
  p_citations jsonb default '[]'::jsonb,
  p_proposal jsonb default null,
  p_usage jsonb default '{}'::jsonb,
  p_validation jsonb default '{}'::jsonb,
  p_prompt_version text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  lookup_analysis uuid;
  lookup_user uuid;
  lookup_turn uuid;
  analysis_row public.analyses%rowtype;
  turn_row private.analysis_chat_turns%rowtype;
  reply_row private.analysis_agent_replies%rowtype;
  base_run private.analysis_runs%rowtype;
  comp_row private.comparison_results%rowtype;
  final_status text := p_status;
  trimmed_answer text := null;
  clean_citations jsonb := '[]'::jsonb;
  val_status text;
  val_reasons text[] := '{}';
  in_tok integer := null;
  out_tok integer := null;
  reason_tok integer := null;
  lat_ms integer := null;
  est_cost numeric(14,8) := null;
  price_date date := null;
  proposal_patch jsonb := null;
  prepared record;
  attached boolean := false;
begin
  if p_reply_id is null or p_generation is null or p_generation < 1 or p_lease_token is null
    or p_status is null or p_status not in ('answered','rejected') then
    raise exception 'invalid_agent_completion' using errcode = '22023';
  end if;
  if p_prompt_version is not null and char_length(p_prompt_version) not between 1 and 80 then
    raise exception 'invalid_agent_completion' using errcode = '22023';
  end if;
  if (p_citations is not null and private.comparison_contains_raw_payload(p_citations))
    or (p_proposal is not null and private.comparison_contains_raw_payload(p_proposal))
    or (p_usage is not null and private.comparison_contains_raw_payload(p_usage))
    or (p_validation is not null and private.comparison_contains_raw_payload(p_validation)) then
    raise exception 'invalid_agent_completion' using errcode = '22023';
  end if;

  -- 교착 방지를 위해 analyses -> analysis_chat_turns -> analysis_agent_replies 순으로 잠근다.
  select ar.analysis_id, ar.user_id, ar.turn_id into lookup_analysis, lookup_user, lookup_turn
    from private.analysis_agent_replies ar
    where ar.id = p_reply_id;
  if not found then
    raise exception 'agent_reply_not_found' using errcode = 'PT404';
  end if;

  select * into analysis_row from public.analyses a
    where (a.id, a.user_id) = (lookup_analysis, lookup_user) for no key update;
  if not found then
    raise exception 'agent_reply_not_found' using errcode = 'PT404';
  end if;

  select * into turn_row from private.analysis_chat_turns t
    where t.id = lookup_turn for update;
  if not found then
    raise exception 'agent_reply_not_found' using errcode = 'PT404';
  end if;

  reply_row := private.lock_leased_agent_reply(p_reply_id, p_generation, p_lease_token);

  -- 사용량 메타데이터 추출
  if p_usage is not null and jsonb_typeof(p_usage) = 'object' then
    if jsonb_typeof(p_usage->'inputTokens') = 'number' then in_tok := (p_usage->>'inputTokens')::integer; end if;
    if jsonb_typeof(p_usage->'outputTokens') = 'number' then out_tok := (p_usage->>'outputTokens')::integer; end if;
    if jsonb_typeof(p_usage->'reasoningTokens') = 'number' then reason_tok := (p_usage->>'reasoningTokens')::integer; end if;
    if jsonb_typeof(p_usage->'latencyMs') = 'number' then lat_ms := (p_usage->>'latencyMs')::integer; end if;
    if jsonb_typeof(p_usage->'estimatedCostUsd') in ('string','number')
      and (p_usage->>'estimatedCostUsd') ~ '\A(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?\Z' then
      est_cost := (p_usage->>'estimatedCostUsd')::numeric(14,8);
    end if;
    if jsonb_typeof(p_usage->'pricingAsOf') = 'string' then
      price_date := private.law_reference_iso_date(p_usage->>'pricingAsOf');
    end if;
  end if;

  if p_validation is not null and jsonb_typeof(p_validation) = 'object'
    and jsonb_typeof(p_validation->'reasons') = 'array' then
    select coalesce(array_agg(r.val), '{}'::text[]) into val_reasons
      from jsonb_array_elements_text(p_validation->'reasons') as r(val)
      where char_length(r.val) between 1 and 120;
  end if;

  if final_status = 'answered' then
    if p_intent is null or p_intent not in ('inclusion','holds','scope','price','period','change_period','change_conditions','help')
      or p_answer is null or p_answer ~ '[\u0001-\u0009\u000B-\u001F\u007F]' then
      raise exception 'invalid_agent_completion' using errcode = '22023';
    end if;
    trimmed_answer := btrim(p_answer);
    if char_length(trimmed_answer) not between 1 and 2000 then
      raise exception 'invalid_agent_completion' using errcode = '22023';
    end if;
    if p_citations is not null then
      if not private.valid_agent_citations(p_citations) then
        raise exception 'invalid_agent_completion' using errcode = '22023';
      end if;
      clean_citations := p_citations;
    end if;
    val_status := 'passed';

    -- LLM 제안이 포함된 경우 서버 조건 변경 검증 함수를 그대로 거쳐 승인 대기(pending)로만 첨부한다.
    if p_proposal is not null and p_proposal <> 'null'::jsonb then
      if jsonb_typeof(p_proposal) <> 'object' then
        final_status := 'rejected';
        val_status := 'rejected';
        val_reasons := array_append(val_reasons, 'server_invalid_proposal_shape');
      else
        if p_proposal->>'kind' = 'period' and jsonb_typeof(p_proposal->'period') = 'object' then
          proposal_patch := jsonb_build_object('period', p_proposal->'period');
        elsif p_proposal->>'kind' = 'conditions' and jsonb_typeof(p_proposal->'conditions') = 'object' then
          proposal_patch := p_proposal->'conditions';
        else
          final_status := 'rejected';
          val_status := 'rejected';
          val_reasons := array_append(val_reasons, 'server_invalid_proposal_shape');
        end if;
      end if;

      if final_status = 'answered' and proposal_patch is not null then
        if turn_row.proposal_status is not null then
          -- 기존 턴에 이미 사용자/규칙 기반 제안이 있으면 덮어쓰지 않고 일치 여부만 확인한다.
          if not (
            (turn_row.intent = 'change_period'
              and proposal_patch = jsonb_build_object(
                'period', jsonb_build_object(
                  'start', to_char(turn_row.proposed_start, 'YYYY-MM-DD'),
                  'end', to_char(turn_row.proposed_end, 'YYYY-MM-DD')
                )
              ))
            or (turn_row.intent = 'change_conditions' and proposal_patch = turn_row.proposed_conditions)
          ) then
            final_status := 'rejected';
            val_status := 'rejected';
            val_reasons := array_append(val_reasons, 'proposal_conflict_with_existing_turn');
          end if;
        else
          select * into base_run from private.analysis_runs r where r.id = reply_row.base_run_id;
          select * into comp_row from private.comparison_results c where c.run_id = reply_row.base_run_id;
          begin
            select * into prepared from private.prepare_validated_condition_proposal(
              reply_row.user_id, analysis_row, base_run, comp_row.result, proposal_patch
            );
            update private.analysis_chat_turns
              set intent = 'change_conditions',
                  proposed_conditions = prepared.norm_proposed,
                  previous_conditions = prepared.norm_previous,
                  effective_conditions = prepared.norm_effective,
                  proposal_status = 'pending'
              where id = turn_row.id;
            attached := true;
          exception when others then
            final_status := 'rejected';
            val_status := 'rejected';
            val_reasons := array_append(val_reasons, 'server_proposal_validation_failed');
          end;
        end if;
      end if;
    end if;

    if final_status = 'rejected' then
      trimmed_answer := null;
      clean_citations := '[]'::jsonb;
      attached := false;
    end if;
  else
    val_status := 'rejected';
    trimmed_answer := null;
    clean_citations := '[]'::jsonb;
  end if;

  update private.analysis_agent_replies
    set status = final_status,
        prompt_version = coalesce(p_prompt_version, prompt_version),
        lease_token = null,
        lease_expires_at = null,
        resolved_intent = case when final_status = 'answered' then p_intent else null end,
        answer_text = trimmed_answer,
        citations = clean_citations,
        proposal_attached = attached,
        input_tokens = in_tok,
        output_tokens = out_tok,
        reasoning_tokens = reason_tok,
        latency_ms = lat_ms,
        estimated_cost_usd = est_cost,
        pricing_as_of = price_date,
        validation_status = val_status,
        validation_reasons = val_reasons,
        completed_at = clock_timestamp()
    where id = reply_row.id;

  return jsonb_build_object(
    'replyId', reply_row.id,
    'turnId', reply_row.turn_id,
    'status', final_status,
    'proposalAttached', attached,
    'validationStatus', val_status,
    'validationReasons', to_jsonb(val_reasons)
  );
end;
$$;

create function public.fail_agent_reply(
  p_reply_id uuid,
  p_generation integer,
  p_lease_token uuid,
  p_failure_code text,
  p_usage jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  reply_row private.analysis_agent_replies%rowtype := private.lock_leased_agent_reply(p_reply_id, p_generation, p_lease_token);
  lat_ms integer := null;
begin
  if p_failure_code is null or char_length(btrim(p_failure_code)) not between 1 and 80
    or p_failure_code ~ '[\u0001-\u001F\u007F]' then
    raise exception 'invalid_agent_failure' using errcode = '22023';
  end if;
  if p_usage is not null and jsonb_typeof(p_usage) = 'object' and jsonb_typeof(p_usage->'latencyMs') = 'number' then
    lat_ms := (p_usage->>'latencyMs')::integer;
  end if;

  update private.analysis_agent_replies
    set status = 'failed',
        lease_token = null,
        lease_expires_at = null,
        answer_text = null,
        citations = '[]'::jsonb,
        failure_code = btrim(p_failure_code),
        latency_ms = coalesce(lat_ms, latency_ms),
        completed_at = clock_timestamp()
    where id = reply_row.id;

  return jsonb_build_object(
    'replyId', reply_row.id,
    'turnId', reply_row.turn_id,
    'status', 'failed',
    'failureCode', btrim(p_failure_code)
  );
end;
$$;

revoke all on function
  private.enqueue_agent_reply_for_turn(),
  private.source_llm_allowed(text),
  private.filter_comparison_for_llm(jsonb,text[]),
  private.prepare_validated_condition_proposal(uuid,public.analyses,private.analysis_runs,jsonb,jsonb),
  private.submit_analysis_condition_turn(uuid,uuid,uuid,text,jsonb),
  private.submit_analysis_chat_turn(uuid,uuid,uuid,text,text,date,date),
  private.analysis_conversation_payload(uuid,uuid,uuid),
  private.expire_stale_agent_replies_core(),
  private.lock_leased_agent_reply(uuid,integer,uuid),
  private.valid_agent_citations(jsonb),
  public.configure_agent_settings(boolean,text),
  public.expire_stale_agent_replies(),
  public.claim_agent_reply(integer,uuid),
  public.read_agent_reply_context(uuid,integer,uuid),
  public.complete_agent_reply(uuid,integer,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,text),
  public.fail_agent_reply(uuid,integer,uuid,text,jsonb)
from public, anon, authenticated, service_role;

grant execute on function
  private.submit_analysis_chat_turn(uuid,uuid,uuid,text,text,date,date),
  private.submit_analysis_condition_turn(uuid,uuid,uuid,text,jsonb)
to authenticated;

grant execute on function
  public.configure_agent_settings(boolean,text),
  public.expire_stale_agent_replies(),
  public.claim_agent_reply(integer,uuid),
  public.read_agent_reply_context(uuid,integer,uuid),
  public.complete_agent_reply(uuid,integer,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb,text),
  public.fail_agent_reply(uuid,integer,uuid,text,jsonb)
to service_role;

notify pgrst, 'reload schema';
