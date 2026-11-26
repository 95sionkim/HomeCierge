-- 채팅 홈(S-01) 자유 대화를 LLM 총괄 에이전트에 연결하는 대기열, 작업자 RPC,
-- 탐색 조건 확인·실행 결정 RPC 및 공유 프로필 변경안(O-3) 연동을 추가한다.
-- 프롬프트 원문과 공고 색인 전체는 따로 저장하지 않으며,
-- user_message_id / (chat_id, user_id) FK on delete cascade로 메시지·채팅·계정 삭제 시 함께 정리된다.

create table private.chat_agent_replies (
  id uuid primary key default gen_random_uuid(),
  user_message_id uuid not null unique references public.chat_messages(id) on delete cascade,
  assistant_message_id uuid references public.chat_messages(id) on delete set null,
  chat_id uuid not null,
  user_id uuid not null,
  original_action text not null
    check (original_action in ('lookup', 'help', 'pdf_guide')),
  status text not null default 'queued'
    check (status in ('queued', 'leased', 'answered', 'rejected', 'failed', 'expired')),
  model text not null
    check (model in ('gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-astra')),
  prompt_version text check (prompt_version is null or char_length(prompt_version) between 1 and 80),
  generation integer not null default 0 check (generation >= 0),
  lease_token uuid,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  resolved_intent text
    check (
      resolved_intent is null
      or resolved_intent in ('search_confirm', 'search_clarify', 'profile_proposal', 'lookup', 'help', 'pdf_guide')
    ),
  answer_text text
    check (
      answer_text is null or (
        char_length(answer_text) between 1 and 2000
        and answer_text !~ '[\u0001-\u0009\u000B-\u001F\u007F]'
        and answer_text = btrim(answer_text)
      )
    ),
  citations jsonb not null default '[]'::jsonb check (jsonb_typeof(citations) = 'array'),
  search_proposal jsonb,
  search_proposal_status text
    check (
      search_proposal_status is null
      or search_proposal_status in ('pending', 'confirmed', 'rejected', 'cancelled')
    ),
  search_confirmed_conditions jsonb,
  search_result_summary jsonb,
  search_result_message_id uuid references public.chat_messages(id) on delete set null,
  search_decided_at timestamptz,
  profile_proposal jsonb,
  profile_change_request_id uuid,
  lookup_query jsonb,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  reasoning_tokens integer check (reasoning_tokens is null or reasoning_tokens >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  estimated_cost_usd numeric(14,8) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  pricing_as_of date,
  validation_status text check (validation_status is null or validation_status in ('passed', 'rejected')),
  validation_reasons text[] not null default '{}',
  failure_code text check (failure_code is null or char_length(failure_code) between 1 and 80),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  foreign key (chat_id, user_id) references public.chats(id, user_id) on delete cascade,
  check ((status = 'leased') = (lease_token is not null and lease_expires_at is not null)),
  check ((status = 'answered') = (answer_text is not null)),
  check (status <> 'answered' or validation_status = 'passed'),
  check (status <> 'rejected' or (answer_text is null and validation_status = 'rejected')),
  check ((status in ('answered', 'rejected', 'failed', 'expired')) = (completed_at is not null)),
  check ((search_proposal is not null) = (search_proposal_status is not null)),
  check (search_proposal is null or status = 'answered'),
  check ((search_proposal_status in ('confirmed', 'rejected', 'cancelled')) = (search_decided_at is not null)),
  check (search_result_summary is null or search_proposal_status = 'confirmed'),
  check (search_confirmed_conditions is null or search_proposal_status = 'confirmed'),
  check (profile_proposal is null or status = 'answered'),
  check (profile_change_request_id is null or profile_proposal is not null),
  check (lookup_query is null or status = 'answered')
);

create index chat_agent_replies_queue_idx
  on private.chat_agent_replies(created_at asc, id asc) where status = 'queued';
create index chat_agent_replies_lease_idx
  on private.chat_agent_replies(lease_expires_at asc) where status = 'leased';
create index chat_agent_replies_owner_chat_idx
  on private.chat_agent_replies(user_id, chat_id, created_at asc);

alter table private.chat_agent_replies enable row level security;
revoke all on private.chat_agent_replies from public, anon, authenticated, service_role;

-- 채팅 에이전트 인용 형식을 검사한다.
create function private.valid_chat_agent_citations(p_citations jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_citations) = 'array'
    and jsonb_array_length(p_citations) <= 20
    and not exists (
      select 1 from jsonb_array_elements(p_citations) as c(val)
      where jsonb_typeof(c.val) <> 'object'
        or (select count(*) from jsonb_object_keys(c.val)) <> 3
        or jsonb_typeof(c.val->'kind') <> 'string'
        or (c.val->>'kind') not in ('region', 'search_condition', 'notice', 'profile', 'capability', 'source_restriction')
        or jsonb_typeof(c.val->'reference') <> 'string'
        or char_length(btrim(c.val->>'reference')) not between 1 and 120
        or jsonb_typeof(c.val->'label') <> 'string'
        or char_length(btrim(c.val->>'label')) not between 1 and 120
    );
$$;

-- 채팅 탐색 조건(regionCodes·budgetMaxWon 필수, supplyArea·moveIn·includeClosed 선택)을 정규화·검증한다.
create function private.normalize_chat_search_conditions(
  p_conditions jsonb,
  p_require_official_regions boolean default true
) returns jsonb language plpgsql set search_path = '' as $$
declare
  allowed_keys constant text[] := array['regionCodes', 'budgetMaxWon', 'supplyArea', 'moveIn', 'includeClosed'];
  raw_regions jsonb;
  sorted_regions jsonb;
  raw_budget jsonb;
  raw_closed jsonb;
  include_closed boolean := false;
  raw_area jsonb;
  area_unit text;
  min_num numeric;
  max_num numeric;
  raw_move jsonb;
  start_m text;
  end_m text;
  normalized jsonb;
begin
  if p_conditions is null or jsonb_typeof(p_conditions) <> 'object'
    or p_conditions - allowed_keys <> '{}'::jsonb
    or private.comparison_contains_raw_payload(p_conditions) then
    raise exception 'invalid_chat_search_conditions' using errcode = '22023';
  end if;

  if not (p_conditions ? 'regionCodes') or not (p_conditions ? 'budgetMaxWon') then
    raise exception 'invalid_chat_search_conditions' using errcode = '22023';
  end if;

  raw_regions := p_conditions->'regionCodes';
  if jsonb_typeof(raw_regions) <> 'array'
    or jsonb_array_length(raw_regions) not between 1 and 50
    or exists (
      select 1 from jsonb_array_elements(raw_regions) as r(val)
      where jsonb_typeof(r.val) <> 'string' or (r.val #>> '{}') !~ '\A[0-9]{5}\Z'
    )
    or (select count(distinct val) from jsonb_array_elements_text(raw_regions) as r(val)) <> jsonb_array_length(raw_regions) then
    raise exception 'invalid_chat_search_conditions' using errcode = '22023';
  end if;

  select jsonb_agg(code order by code collate "C") into sorted_regions
    from jsonb_array_elements_text(raw_regions) as r(code);

  if p_require_official_regions then
    perform private.require_search_profile_regions(sorted_regions);
  end if;

  raw_budget := p_conditions->'budgetMaxWon';
  if jsonb_typeof(raw_budget) <> 'string'
    or (raw_budget #>> '{}') !~ '\A(0|[1-9][0-9]{0,19})\Z' then
    raise exception 'invalid_chat_search_conditions' using errcode = '22023';
  end if;

  if p_conditions ? 'includeClosed' then
    raw_closed := p_conditions->'includeClosed';
    if jsonb_typeof(raw_closed) <> 'boolean' then
      raise exception 'invalid_chat_search_conditions' using errcode = '22023';
    end if;
    include_closed := (raw_closed = 'true'::jsonb);
  end if;

  normalized := jsonb_build_object(
    'regionCodes', sorted_regions,
    'budgetMaxWon', raw_budget,
    'includeClosed', include_closed
  );

  if p_conditions ? 'supplyArea' and p_conditions->'supplyArea' <> 'null'::jsonb then
    raw_area := p_conditions->'supplyArea';
    if jsonb_typeof(raw_area) <> 'object'
      or (select count(*) from jsonb_object_keys(raw_area)) <> 3
      or not (raw_area ? 'min' and raw_area ? 'max' and raw_area ? 'unit')
      or jsonb_typeof(raw_area->'min') <> 'string'
      or jsonb_typeof(raw_area->'max') <> 'string'
      or jsonb_typeof(raw_area->'unit') <> 'string' then
      raise exception 'invalid_chat_search_conditions' using errcode = '22023';
    end if;
    area_unit := raw_area->>'unit';
    if area_unit not in ('m2', 'pyeong')
      or char_length(raw_area->>'min') > 24
      or char_length(raw_area->>'max') > 24
      or (raw_area->>'min') !~ '\A([1-9][0-9]*(\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)\Z'
      or (raw_area->>'max') !~ '\A([1-9][0-9]*(\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)\Z' then
      raise exception 'invalid_chat_search_conditions' using errcode = '22023';
    end if;
    min_num := trim_scale((raw_area->>'min')::numeric);
    max_num := trim_scale((raw_area->>'max')::numeric);
    if min_num <= 0 or max_num <= 0 or min_num > max_num then
      raise exception 'invalid_chat_search_conditions' using errcode = '22023';
    end if;
    normalized := normalized || jsonb_build_object(
      'supplyArea', jsonb_build_object(
        'min', min_num::text,
        'max', max_num::text,
        'unit', area_unit
      )
    );
  end if;

  if p_conditions ? 'moveIn' and p_conditions->'moveIn' <> 'null'::jsonb then
    raw_move := p_conditions->'moveIn';
    if jsonb_typeof(raw_move) <> 'object'
      or (select count(*) from jsonb_object_keys(raw_move)) <> 2
      or not (raw_move ? 'start' and raw_move ? 'end')
      or jsonb_typeof(raw_move->'start') <> 'string'
      or jsonb_typeof(raw_move->'end') <> 'string' then
      raise exception 'invalid_chat_search_conditions' using errcode = '22023';
    end if;
    start_m := raw_move->>'start';
    end_m := raw_move->>'end';
    if start_m !~ '\A[0-9]{4}-(0[1-9]|1[0-2])\Z'
      or end_m !~ '\A[0-9]{4}-(0[1-9]|1[0-2])\Z'
      or left(start_m, 4) = '0000'
      or left(end_m, 4) = '0000'
      or start_m collate "C" > end_m collate "C" then
      raise exception 'invalid_chat_search_conditions' using errcode = '22023';
    end if;
    normalized := normalized || jsonb_build_object(
      'moveIn', jsonb_build_object('start', start_m, 'end', end_m)
    );
  end if;

  return normalized;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'invalid_chat_search_conditions' using errcode = '22023';
end;
$$;

-- 채팅 에이전트가 제안한 공유 프로필 변경안을 기존 O-3 승인 대기(pending) 행으로 생성한다.
-- 에이전트는 절대 승인하지 않으며, 사용자는 기존 O-3(decide_search_profile_change)에서만 결정한다.
create function private.create_chat_profile_proposal(
  p_owner_id uuid,
  p_patch jsonb,
  p_reason text
) returns uuid language plpgsql set search_path = '' as $$
declare
  normalized_reason text;
  normalized_patch jsonb;
  request_digest bytea;
  profile public.user_profiles%rowtype;
  current_revision bigint;
  current_conditions jsonb;
  next_conditions jsonb;
  previous_values jsonb := '{}'::jsonb;
  patch_values jsonb := '{}'::jsonb;
  had_key boolean;
  old_region_set jsonb;
  key_name text;
  old_area_num numeric;
  new_area_num numeric;
  new_change_id uuid;
  new_request_id uuid := gen_random_uuid();
begin
  if p_owner_id is null
    or exists (select 1 from private.account_deletion_fences f where f.user_id = p_owner_id)
    or not exists (
      select 1 from auth.users u
      where u.id = p_owner_id
        and u.confirmed_at is not null
        and u.is_anonymous is false
        and u.deleted_at is null
        and (u.banned_until is null or u.banned_until <= statement_timestamp())
    ) then
    raise exception 'chat_agent_reply_not_found' using errcode = 'PT404';
  end if;

  normalized_reason := private.normalize_search_profile_reason(p_reason);
  normalized_patch := private.normalize_search_profile_patch(p_patch);
  request_digest := sha256(convert_to(normalized_patch::text, 'UTF8'));

  perform pg_advisory_xact_lock(hashtextextended('homecierge:search-profile:' || p_owner_id::text, 0));
  select * into profile from public.user_profiles p where p.user_id = p_owner_id for update;
  current_revision := coalesce(profile.revision, 0);
  current_conditions := coalesce(profile.search_conditions, '{}'::jsonb);
  next_conditions := current_conditions;

  if normalized_patch ? 'region_codes' then
    had_key := current_conditions ? 'region_codes';
    if normalized_patch->'region_codes' = 'null'::jsonb then
      if had_key then
        previous_values := previous_values || jsonb_build_object('region_codes', current_conditions->'region_codes');
        patch_values := patch_values || '{"region_codes": null}'::jsonb;
        next_conditions := next_conditions - 'region_codes';
      end if;
    else
      if had_key then
        select coalesce(jsonb_agg(code order by code collate "C"), '[]'::jsonb) into old_region_set
          from (
            select distinct elem as code
            from jsonb_array_elements_text(current_conditions->'region_codes') as r(elem)
          ) as distinct_old;
        if old_region_set is distinct from normalized_patch->'region_codes' then
          previous_values := previous_values || jsonb_build_object('region_codes', current_conditions->'region_codes');
          patch_values := patch_values || jsonb_build_object('region_codes', normalized_patch->'region_codes');
          next_conditions := jsonb_set(next_conditions, array['region_codes'], normalized_patch->'region_codes', true);
        end if;
      else
        previous_values := previous_values || '{"region_codes": null}'::jsonb;
        patch_values := patch_values || jsonb_build_object('region_codes', normalized_patch->'region_codes');
        next_conditions := jsonb_set(next_conditions, array['region_codes'], normalized_patch->'region_codes', true);
      end if;
    end if;
  end if;

  if normalized_patch ? 'budget_max_won' then
    had_key := current_conditions ? 'budget_max_won';
    if normalized_patch->'budget_max_won' = 'null'::jsonb then
      if had_key then
        previous_values := previous_values || jsonb_build_object('budget_max_won', current_conditions->'budget_max_won');
        patch_values := patch_values || '{"budget_max_won": null}'::jsonb;
        next_conditions := next_conditions - 'budget_max_won';
      end if;
    elsif not had_key or (current_conditions->>'budget_max_won') is distinct from (normalized_patch->>'budget_max_won') then
      previous_values := previous_values || jsonb_build_object(
        'budget_max_won',
        case when had_key then current_conditions->'budget_max_won' else 'null'::jsonb end
      );
      patch_values := patch_values || jsonb_build_object('budget_max_won', normalized_patch->'budget_max_won');
      next_conditions := jsonb_set(next_conditions, array['budget_max_won'], normalized_patch->'budget_max_won', true);
    end if;
  end if;

  foreach key_name in array array['supply_area_min_m2', 'supply_area_max_m2'] loop
    if normalized_patch ? key_name then
      had_key := current_conditions ? key_name;
      if normalized_patch->key_name = 'null'::jsonb then
        if had_key then
          previous_values := previous_values || jsonb_build_object(
            key_name, to_jsonb(private.format_search_area(current_conditions->key_name))
          );
          patch_values := patch_values || jsonb_build_object(key_name, 'null'::jsonb);
          next_conditions := next_conditions - key_name;
        end if;
      else
        new_area_num := trim_scale((normalized_patch->>key_name)::numeric);
        old_area_num := case when had_key then trim_scale((current_conditions->>key_name)::numeric) else null end;
        if not had_key or old_area_num is distinct from new_area_num then
          previous_values := previous_values || jsonb_build_object(
            key_name,
            case when had_key then to_jsonb(old_area_num::text) else 'null'::jsonb end
          );
          patch_values := patch_values || jsonb_build_object(key_name, to_jsonb(new_area_num::text));
          next_conditions := jsonb_set(next_conditions, array[key_name], to_jsonb(new_area_num), true);
        end if;
      end if;
    end if;
  end loop;

  foreach key_name in array array['move_in_start_month', 'move_in_end_month'] loop
    if normalized_patch ? key_name then
      had_key := current_conditions ? key_name;
      if normalized_patch->key_name = 'null'::jsonb then
        if had_key then
          previous_values := previous_values || jsonb_build_object(key_name, current_conditions->key_name);
          patch_values := patch_values || jsonb_build_object(key_name, 'null'::jsonb);
          next_conditions := next_conditions - key_name;
        end if;
      elsif not had_key or (current_conditions->>key_name) is distinct from (normalized_patch->>key_name) then
        previous_values := previous_values || jsonb_build_object(
          key_name,
          case when had_key then current_conditions->key_name else 'null'::jsonb end
        );
        patch_values := patch_values || jsonb_build_object(key_name, normalized_patch->key_name);
        next_conditions := jsonb_set(next_conditions, array[key_name], normalized_patch->key_name, true);
      end if;
    end if;
  end loop;

  if patch_values = '{}'::jsonb then
    raise exception 'search_profile_unchanged' using errcode = '22023';
  end if;
  if not private.valid_search_conditions(next_conditions) then
    raise exception 'invalid_search_profile_patch' using errcode = '22023';
  end if;

  if patch_values ? 'region_codes' and patch_values->'region_codes' <> 'null'::jsonb then
    perform private.require_search_profile_regions(patch_values->'region_codes');
  end if;

  if profile.user_id is null then
    insert into public.user_profiles(user_id) values (p_owner_id) on conflict (user_id) do nothing;
    select * into strict profile from public.user_profiles p where p.user_id = p_owner_id for update;
    current_revision := profile.revision;
  end if;

  insert into public.profile_change_requests(user_id, base_revision, proposed_changes, reason, status, created_at)
  values (
    p_owner_id,
    current_revision,
    jsonb_build_object('search_conditions', next_conditions),
    normalized_reason,
    'pending',
    clock_timestamp()
  )
  returning id into new_change_id;

  insert into private.search_profile_proposals(
    change_id, user_id, request_id, previous_values, patch_values, request_patch_digest, analysis_id, run_id
  ) values (
    new_change_id, p_owner_id, new_request_id, previous_values, patch_values, request_digest, null, null
  );

  return new_request_id;
end;
$$;

-- 채팅 검색 실행 결과 요약(chat-search-summary/v1)의 형식과 정합성을 검사한다.
create function private.validate_chat_search_result_summary(p_summary jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare
  required_keys constant text[] := array[
    'contractVersion', 'asOf', 'observedAt', 'publicationWindow', 'coverage',
    'zeroStatus', 'scopeIssues', 'counts', 'truncation', 'appliedConditions',
    'regionLabels', 'matched', 'needsReview'
  ];
  item_keys constant text[] := array[
    'houseManageNo', 'noticeNo', 'edition', 'title', 'kind', 'regionCode', 'regionName',
    'applicationStatus', 'modelsCount', 'matchedRoomsCount', 'needsReviewRoomsCount',
    'minSubtotalWon', 'maxSubtotalWon', 'reasonCodes'
  ];
  cnt_matched integer;
  cnt_review integer;
  cnt_excluded integer;
  zero_st text;
  cov_st text;
  group_name text;
  entry jsonb;
begin
  if p_summary is null or jsonb_typeof(p_summary) <> 'object'
    or octet_length(p_summary::text) > 65536
    or private.comparison_contains_raw_payload(p_summary)
    or not private.ingestion_v0_object(p_summary, required_keys) then
    raise exception 'invalid_chat_search_summary' using errcode = '22023';
  end if;

  if p_summary->>'contractVersion' is distinct from 'chat-search-summary/v1'
    or private.law_reference_iso_date(p_summary->>'asOf') is null
    or jsonb_typeof(p_summary->'observedAt') <> 'string'
    or private.notice_search_epoch(p_summary->>'observedAt') is null
    or not private.notice_search_period(p_summary->'publicationWindow', false) then
    raise exception 'invalid_chat_search_summary' using errcode = '22023';
  end if;

  if jsonb_typeof(p_summary->'coverage') <> 'object'
    or (p_summary#>>'{coverage,status}') not in ('complete', 'partial', 'unavailable')
    or jsonb_typeof(p_summary#>'{coverage,sources}') <> 'array' then
    raise exception 'invalid_chat_search_summary' using errcode = '22023';
  end if;
  cov_st := p_summary#>>'{coverage,status}';

  zero_st := p_summary->>'zeroStatus';
  if zero_st is null or zero_st not in ('not_zero', 'confirmed_zero', 'indeterminate') then
    raise exception 'invalid_chat_search_summary' using errcode = '22023';
  end if;

  if jsonb_typeof(p_summary->'scopeIssues') <> 'array'
    or jsonb_array_length(p_summary->'scopeIssues') > 20
    or exists (
      select 1 from jsonb_array_elements(p_summary->'scopeIssues') as si(val)
      where jsonb_typeof(si.val) <> 'string' or char_length(si.val #>> '{}') not between 1 and 80
    ) then
    raise exception 'invalid_chat_search_summary' using errcode = '22023';
  end if;

  if jsonb_typeof(p_summary->'counts') <> 'object'
    or not private.ingestion_v0_object(p_summary->'counts', array['matched', 'needsReview', 'excluded'])
    or not private.ingestion_v0_count(p_summary#>'{counts,matched}', 0, 10000)
    or not private.ingestion_v0_count(p_summary#>'{counts,needsReview}', 0, 10000)
    or not private.ingestion_v0_count(p_summary#>'{counts,excluded}', 0, 10000) then
    raise exception 'invalid_chat_search_summary' using errcode = '22023';
  end if;
  cnt_matched := (p_summary#>>'{counts,matched}')::integer;
  cnt_review := (p_summary#>>'{counts,needsReview}')::integer;
  cnt_excluded := (p_summary#>>'{counts,excluded}')::integer;

  if (cnt_matched > 0 and zero_st <> 'not_zero')
    or (cnt_matched = 0 and zero_st = 'not_zero')
    or (zero_st = 'confirmed_zero' and (cnt_review > 0 or cov_st <> 'complete' or jsonb_array_length(p_summary->'scopeIssues') > 0)) then
    raise exception 'invalid_chat_search_summary' using errcode = '22023';
  end if;

  if jsonb_typeof(p_summary->'truncation') <> 'object'
    or not private.ingestion_v0_object(p_summary->'truncation', array['truncated', 'matchedOmitted', 'needsReviewOmitted'])
    or jsonb_typeof(p_summary#>'{truncation,truncated}') <> 'boolean'
    or not private.ingestion_v0_count(p_summary#>'{truncation,matchedOmitted}', 0, 10000)
    or not private.ingestion_v0_count(p_summary#>'{truncation,needsReviewOmitted}', 0, 10000) then
    raise exception 'invalid_chat_search_summary' using errcode = '22023';
  end if;

  if jsonb_typeof(p_summary->'appliedConditions') <> 'object' then
    raise exception 'invalid_chat_search_summary' using errcode = '22023';
  end if;

  if jsonb_typeof(p_summary->'regionLabels') <> 'object'
    or exists (
      select 1 from jsonb_each(p_summary->'regionLabels') as rl(code, label)
      where rl.code !~ '\A[0-9]{5}\Z' or not private.notice_search_label(rl.label, 120)
    ) then
    raise exception 'invalid_chat_search_summary' using errcode = '22023';
  end if;

  foreach group_name in array array['matched', 'needsReview'] loop
    if jsonb_typeof(p_summary->group_name) <> 'array'
      or jsonb_array_length(p_summary->group_name) > 10 then
      raise exception 'invalid_chat_search_summary' using errcode = '22023';
    end if;
    for entry in select value from jsonb_array_elements(p_summary->group_name) loop
      if not coalesce(
        private.ingestion_v0_object(entry, item_keys)
        and jsonb_typeof(entry->'houseManageNo') = 'string' and (entry->>'houseManageNo') ~ '\A[0-9]{10}\Z'
        and jsonb_typeof(entry->'noticeNo') = 'string' and (entry->>'noticeNo') ~ '\A[0-9]{10}\Z'
        and jsonb_typeof(entry->'edition') = 'string' and (entry->>'edition') ~ '\A[0-9a-zA-Z][0-9a-zA-Z._-]{0,63}\Z'
        and (entry->'title' = 'null'::jsonb or private.notice_search_label(entry->'title', 200))
        and (entry->>'kind') in ('new_sale', 'unranked', 'remaining', 'resupply', 'unknown')
        and (entry->'regionCode' = 'null'::jsonb or (jsonb_typeof(entry->'regionCode') = 'string' and (entry->>'regionCode') ~ '\A[0-9]{5}\Z'))
        and (entry->'regionName' = 'null'::jsonb or private.notice_search_label(entry->'regionName', 120))
        and (entry->>'applicationStatus') in ('open', 'upcoming', 'closed', 'unknown')
        and private.ingestion_v0_count(entry->'modelsCount', 0, 1000)
        and private.ingestion_v0_count(entry->'matchedRoomsCount', 0, 100000)
        and private.ingestion_v0_count(entry->'needsReviewRoomsCount', 0, 100000)
        and (entry->'minSubtotalWon' = 'null'::jsonb or (jsonb_typeof(entry->'minSubtotalWon') = 'string' and (entry->>'minSubtotalWon') ~ '\A(0|[1-9][0-9]{0,19})\Z'))
        and (entry->'maxSubtotalWon' = 'null'::jsonb or (jsonb_typeof(entry->'maxSubtotalWon') = 'string' and (entry->>'maxSubtotalWon') ~ '\A(0|[1-9][0-9]{0,19})\Z'))
        and jsonb_typeof(entry->'reasonCodes') = 'array'
        and jsonb_array_length(entry->'reasonCodes') <= 32,
        false
      ) then
        raise exception 'invalid_chat_search_summary' using errcode = '22023';
      end if;
    end loop;
  end loop;
end;
$$;

-- 확인 후 실행한 맞춤 검색 결과를 채팅 타임라인용 정형 한국어 요약 문장으로 구성한다.
create function private.format_chat_search_summary_text(p_conditions jsonb, p_summary jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare
  regions_text text;
  budget_won text := p_conditions->>'budgetMaxWon';
  parts text[];
  matched_n integer := (p_summary#>>'{counts,matched}')::integer;
  review_n integer := (p_summary#>>'{counts,needsReview}')::integer;
  zero_st text := p_summary->>'zeroStatus';
  cov_st text := p_summary#>>'{coverage,status}';
  win_start text := replace(p_summary#>>'{publicationWindow,start}', '-', '.');
  win_end text := replace(p_summary#>>'{publicationWindow,end}', '-', '.');
  as_of_text text := replace(p_summary->>'asOf', '-', '.');
  summary_line text;
begin
  select string_agg(coalesce(p_summary->'regionLabels'->>code, code), ' · ' order by pos)
    into regions_text
    from jsonb_array_elements_text(p_conditions->'regionCodes') with ordinality as r(code, pos);

  parts := array[
    coalesce(regions_text, ''),
    '최대 ' || budget_won || '원(분양가+필수 옵션 기준)'
  ];
  if p_conditions ? 'supplyArea' then
    parts := array_append(
      parts,
      '공급면적 ' || (p_conditions#>>'{supplyArea,min}') || '–' || (p_conditions#>>'{supplyArea,max}')
        || case when p_conditions#>>'{supplyArea,unit}' = 'pyeong' then '평' else '㎡' end
    );
  end if;
  if p_conditions ? 'moveIn' then
    parts := array_append(
      parts,
      '입주 ' || (p_conditions#>>'{moveIn,start}') || '–' || (p_conditions#>>'{moveIn,end}')
    );
  end if;
  if coalesce((p_conditions->>'includeClosed')::boolean, false) then
    parts := array_append(parts, '접수 종료 포함');
  end if;

  summary_line := '확인한 조건(' || array_to_string(parts, ' · ') || ')으로 맞춤 검색을 실행했습니다. '
    || '조건 충족 ' || matched_n || '건, 확인 필요 ' || review_n || '건입니다. '
    || '(기준일 ' || as_of_text || ', 모집공고일 ' || win_start || '–' || win_end || ')';

  if matched_n = 0 and zero_st = 'confirmed_zero' then
    summary_line := summary_line || ' 수집 범위 안에서 조건을 충족한 공고는 0건으로 확인됐습니다.';
  elsif matched_n = 0 then
    summary_line := summary_line || ' 확인 필요 공고 또는 수집 범위 제한이 남아 있어 조건에 맞는 공고가 0건이라고 확정하지 않았습니다.';
  elsif cov_st <> 'complete' then
    summary_line := summary_line || ' 일부 출처 수집이 완전하지 않아 누락된 공고가 있을 수 있습니다.';
  end if;

  summary_line := summary_line || ' 세금과 금융비용은 별도이며, 공고를 선택하면 최신 목록에서 회차와 주택형을 다시 대조합니다.';
  return summary_line;
end;
$$;

-- 채팅 에이전트 응답 행을 소유자 API 응답 JSON으로 변환한다.
-- 만료된 임대는 즉시 expired로 표시해 대기 작업 없이 '작성 중'이 보이지 않게 한다(A-58).
create function private.chat_agent_reply_json(
  p_reply private.chat_agent_replies,
  p_owner_id uuid
) returns jsonb language plpgsql stable set search_path = '' set timezone = 'UTC' as $$
declare
  effective_status text;
  dir_names jsonb;
  region_labels jsonb := '{}'::jsonb;
  profile_change_json jsonb := null;
  search_prop_json jsonb := null;
begin
  if p_reply.id is null then
    return null;
  end if;

  effective_status := case
    when p_reply.status = 'leased' and p_reply.lease_expires_at <= clock_timestamp() then 'expired'
    else p_reply.status
  end;

  if effective_status <> 'answered' then
    return jsonb_build_object(
      'id', p_reply.id,
      'userMessageId', p_reply.user_message_id,
      'assistantMessageId', p_reply.assistant_message_id,
      'status', effective_status,
      'model', p_reply.model,
      'intent', null,
      'answer', null,
      'citations', '[]'::jsonb,
      'searchProposal', null,
      'profileProposal', null,
      'lookupQuery', null,
      'completedAt', case
        when p_reply.status = 'leased' and p_reply.lease_expires_at <= clock_timestamp() then p_reply.lease_expires_at
        else p_reply.completed_at
      end
    );
  end if;

  if p_reply.search_proposal is not null then
    select p.region_names into dir_names from private.notice_directory_publication p limit 1;
    if dir_names is not null and jsonb_typeof(dir_names) = 'object' then
      select coalesce(jsonb_object_agg(c.code, dir_names->>c.code), '{}'::jsonb)
        into region_labels
        from (
          select distinct elem as code
          from jsonb_array_elements_text(coalesce(p_reply.search_proposal->'regionCodes', '[]'::jsonb)) as r1(elem)
          union
          select distinct elem as code
          from jsonb_array_elements_text(coalesce(p_reply.search_confirmed_conditions->'regionCodes', '[]'::jsonb)) as r2(elem)
        ) as c
        where dir_names ? c.code;
    end if;

    search_prop_json := jsonb_build_object(
      'status', p_reply.search_proposal_status,
      'conditions', p_reply.search_proposal,
      'regionLabels', region_labels,
      'confirmedConditions', p_reply.search_confirmed_conditions,
      'resultSummary', p_reply.search_result_summary,
      'resultMessageId', p_reply.search_result_message_id,
      'decidedAt', p_reply.search_decided_at
    );
  end if;

  if p_reply.profile_change_request_id is not null then
    select jsonb_build_object(
        'changeId', sp.request_id,
        'baseRevision', pr.base_revision,
        'previous', sp.previous_values,
        'patch', sp.patch_values,
        'reason', pr.reason,
        'status', pr.status,
        'createdAt', pr.created_at,
        'decidedAt', pr.decided_at
      )
      into profile_change_json
      from private.search_profile_proposals sp
      join public.profile_change_requests pr
        on (pr.id, pr.user_id) = (sp.change_id, sp.user_id)
      where sp.user_id = p_owner_id
        and sp.request_id = p_reply.profile_change_request_id;
  end if;

  return jsonb_build_object(
    'id', p_reply.id,
    'userMessageId', p_reply.user_message_id,
    'assistantMessageId', p_reply.assistant_message_id,
    'status', 'answered',
    'model', p_reply.model,
    'intent', p_reply.resolved_intent,
    'answer', p_reply.answer_text,
    'citations', p_reply.citations,
    'searchProposal', search_prop_json,
    'profileProposal', profile_change_json,
    'lookupQuery', p_reply.lookup_query,
    'completedAt', p_reply.completed_at
  );
end;
$$;

-- 기존 read_chat_detail에 메시지별 agentReply를 함께 반환하도록 갱신한다.
create or replace function private.read_chat_detail(p_chat_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' set timezone = 'UTC' as $$
declare
  owner_id uuid := private.chat_home_owner();
  chat_row public.chats%rowtype;
  messages_json jsonb;
  analyses_json jsonb;
begin
  if p_chat_id is null then
    raise exception 'chat_id_required' using errcode = '22023';
  end if;

  select * into chat_row
    from public.chats c
    where (c.id, c.user_id) = (p_chat_id, owner_id);
  if not found then
    raise exception 'chat_not_found' using errcode = 'PT404';
  end if;

  select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', m.id,
          'role', m.role,
          'content', m.content,
          'createdAt', m.created_at,
          'agentReply', case
            when ar.id is not null then private.chat_agent_reply_json(ar, owner_id)
            else null
          end
        )
        order by m.created_at asc, m.message_order asc, m.id asc
      ),
      '[]'::jsonb
    )
    into messages_json
    from public.chat_messages m
    left join private.chat_agent_replies ar
      on ar.user_message_id = m.id
     and ar.user_id = owner_id
    where (m.chat_id, m.user_id) = (p_chat_id, owner_id);

  select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'analysisId', a.id,
          'title', a.title,
          'status', a.status,
          'latestRunId', a.latest_run_id,
          'latestRunStatus', r.status,
          'latestRunErrorCode', r.error_code,
          'noticeNo', a.conditions_snapshot#>>'{ingestion_target,noticeNo}',
          'houseManageNo', a.conditions_snapshot#>>'{ingestion_target,houseManageNo}',
          'edition', a.conditions_snapshot#>>'{ingestion_target,edition}',
          'modelNo', a.conditions_snapshot#>>'{comparison,modelNo}',
          'houseType', r.notice_house_type,
          'createdAt', a.created_at,
          'updatedAt', a.updated_at
        )
        order by a.created_at asc, a.id asc
      ),
      '[]'::jsonb
    )
    into analyses_json
    from public.analyses a
    left join private.analysis_runs r
      on (r.id, r.analysis_id, r.user_id) = (a.latest_run_id, a.id, a.user_id)
    where (a.chat_id, a.user_id) = (p_chat_id, owner_id);

  return jsonb_build_object(
    'contractVersion', 'chat-detail/v1',
    'chat', private.chat_summary_json(owner_id, chat_row.id, chat_row.title, chat_row.created_at, chat_row.updated_at),
    'messages', messages_json,
    'analyses', analyses_json
  );
end;
$$;

-- 기존 post_chat_message가 기능 설정(private.agent_settings.enabled)이 켜진 경우에만
-- 채팅 에이전트 응답 대기열 행을 함께 적재하고 규칙 기반 응답을 즉시 반환한다.
create or replace function private.post_chat_message(
  p_chat_id uuid,
  p_request_key uuid,
  p_message text,
  p_action text,
  p_query text default null,
  p_mode text default null
)
returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  owner_id uuid := private.chat_home_owner();
  clean_message text;
  clean_query text;
  compact_query text;
  chat_row public.chats%rowtype;
  existing_user public.chat_messages%rowtype;
  existing_assistant public.chat_messages%rowtype;
  existing_reply private.chat_agent_replies%rowtype;
  user_row public.chat_messages%rowtype;
  assistant_row public.chat_messages%rowtype;
  queued_reply private.chat_agent_replies%rowtype;
  cfg private.agent_settings%rowtype;
  assistant_text text;
  published jsonb;
  window_start text;
  window_end text;
  observed_kst text;
  match_count integer := 0;
  same_title_groups integer := 0;
  query_label text;
  coverage_complete boolean := false;
  scope_label text;
  user_ts timestamptz;
  assistant_ts timestamptz;
  reply_json jsonb := null;
begin
  if p_chat_id is null or p_request_key is null then
    raise exception 'invalid_chat_message_input' using errcode = '22023';
  end if;
  clean_message := private.normalize_chat_message(p_message);

  if p_action is null or p_action not in ('lookup', 'help', 'pdf_guide') then
    raise exception 'invalid_chat_message_action' using errcode = '22023';
  end if;

  if p_action = 'lookup' then
    if p_mode is null or p_mode not in ('name', 'number') then
      raise exception 'invalid_chat_lookup_mode' using errcode = '22023';
    end if;
    clean_query := private.normalize_chat_title(p_query);
    if char_length(clean_query) > 120 then
      raise exception 'invalid_chat_lookup_query' using errcode = '22023';
    end if;
    if p_mode = 'number' and clean_query !~ '\A[0-9]{1,10}\Z' then
      raise exception 'invalid_chat_lookup_query' using errcode = '22023';
    end if;
  else
    if p_query is not null or p_mode is not null then
      raise exception 'invalid_chat_message_input' using errcode = '22023';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('homecierge:chats:' || owner_id::text, 0));

  select * into chat_row
    from public.chats c
    where (c.id, c.user_id) = (p_chat_id, owner_id)
    for update;
  if not found then
    raise exception 'chat_not_found' using errcode = 'PT404';
  end if;

  select * into existing_user
    from public.chat_messages m
    where (m.user_id, m.chat_id, m.role, m.request_key) = (owner_id, p_chat_id, 'user', p_request_key);
  if found then
    if existing_user.content is distinct from clean_message then
      raise exception 'chat_request_conflict' using errcode = 'PT409';
    end if;
    select * into existing_assistant
      from public.chat_messages m
      where (m.user_id, m.chat_id, m.role, m.request_key) = (owner_id, p_chat_id, 'assistant', p_request_key);
    select * into existing_reply
      from private.chat_agent_replies ar
      where ar.user_message_id = existing_user.id and ar.user_id = owner_id;
    reply_json := case when existing_reply.id is not null then private.chat_agent_reply_json(existing_reply, owner_id) else null end;
    return jsonb_build_object(
      'contractVersion', 'chat-message/v1',
      'chatId', p_chat_id,
      'action', p_action,
      'userMessage', jsonb_build_object(
        'id', existing_user.id,
        'role', existing_user.role,
        'content', existing_user.content,
        'createdAt', existing_user.created_at,
        'agentReply', reply_json
      ),
      'assistantMessage', case when existing_assistant.id is not null then jsonb_build_object(
        'id', existing_assistant.id,
        'role', existing_assistant.role,
        'content', existing_assistant.content,
        'createdAt', existing_assistant.created_at
      ) else null end,
      'agentReply', reply_json
    );
  end if;

  if exists (
    select 1 from public.chat_messages m
    where (m.user_id, m.chat_id, m.request_key) = (owner_id, p_chat_id, p_request_key)
  ) then
    raise exception 'chat_request_conflict' using errcode = 'PT409';
  end if;

  if p_action = 'help' then
    assistant_text := '공고명이나 10자리 공고번호를 입력하시면 게시된 청약홈 공유 색인에서 회차를 구별해 찾아 드립니다. 접수 중인 공고는 오늘의 청약에서, 희망 지역·예산 조건 탐색은 맞춤 검색에서 이용하실 수 있습니다. 개인 청약 자격 판정이나 가격 전망은 제공하지 않습니다.';
  elsif p_action = 'pdf_guide' then
    assistant_text := '공고 PDF 보완은 공고와 주택형을 먼저 고른 뒤 분석 화면에서 진행할 수 있습니다. 먼저 공고명이나 10자리 공고번호를 입력해 검토할 회차를 찾아 주세요.';
  else
    published := private.notice_directory_index_value();
    if not private.comparison_sources_permitted(array['applyhome_apt', 'applyhome_remainder', 'mois_legal_region_codes']) then
      assistant_text := '현재 공고 목록 출처의 표시 권한을 확인 중이어서 공고 찾기를 보류했습니다. 출처 권한이 확인된 뒤 다시 시도해 주세요.';
    elsif published is null
      or not coalesce(private.notice_search_is_fresh(private.notice_search_epoch(published->>'observedAt')), false) then
      assistant_text := '최근 게시된 공고 색인을 준비 중이어서 공고 찾기를 실행할 수 없습니다. 잠시 후 다시 시도하거나 오늘의 청약에서 수집 상태를 확인해 주세요.';
    else
      window_start := replace(published#>>'{publicationWindow,start}', '-', '.');
      window_end := replace(published#>>'{publicationWindow,end}', '-', '.');
      observed_kst := to_char((published->>'observedAt')::timestamptz at time zone 'Asia/Seoul', 'YYYY.MM.DD HH24:MI') || ' KST';
      query_label := case when p_mode = 'number' then '공고번호 ' || clean_query else '‘' || clean_query || '’' end;
      coverage_complete := published#>>'{coverage,status}' = 'complete';
      scope_label := '모집공고일 ' || window_start || '–' || window_end || ', 관측 시각 ' || observed_kst;

      if p_mode = 'number' then
        with matched as (
          select n.value as item
          from jsonb_array_elements(published->'notices') as n(value)
          where n.value->>'kind' is distinct from 'unsupported'
            and (
              (char_length(clean_query) = 10 and (n.value->>'noticeNo' = clean_query or n.value->>'houseManageNo' = clean_query))
              or (char_length(clean_query) < 10 and (
                strpos(coalesce(n.value->>'noticeNo', ''), clean_query) > 0
                or strpos(coalesce(n.value->>'houseManageNo', ''), clean_query) > 0
              ))
            )
        )
        select
          count(*)::integer,
          (select count(*)::integer from (
            select item->>'title' as t from matched where item->>'title' is not null group by item->>'title' having count(*) > 1
          ) dup)
          into match_count, same_title_groups
          from matched;
      else
        compact_query := lower(regexp_replace(clean_query, '[[:space:]]+', '', 'g'));
        with matched as (
          select n.value as item
          from jsonb_array_elements(published->'notices') as n(value)
          where n.value->>'kind' is distinct from 'unsupported'
            and n.value->>'title' is not null
            and strpos(lower(regexp_replace(n.value->>'title', '[[:space:]]+', '', 'g')), compact_query) > 0
        )
        select
          count(*)::integer,
          (select count(*)::integer from (
            select item->>'title' as t from matched where item->>'title' is not null group by item->>'title' having count(*) > 1
          ) dup)
          into match_count, same_title_groups
          from matched;
      end if;

      if match_count = 0 and not coverage_complete then
        assistant_text := '공유 색인(' || scope_label || ')의 공고 수집이 완전하지 않아 ' || query_label
          || '에 해당하는 공고가 없다고 확정할 수 없습니다. 누락된 회차가 있을 수 있으니 오늘의 청약에서 수집 상태를 확인하거나 잠시 후 다시 찾아 주세요.';
      elsif match_count = 0 then
        assistant_text := '조회 범위(' || scope_label || ') 안에서 '
          || query_label || '에 해당하는 공고를 찾지 못했습니다. 이 기간 밖의 회차는 현재 조회 범위 밖입니다.';
      elsif same_title_groups > 0 then
        assistant_text := query_label || ' 검색 결과 총 ' || match_count
          || '건을 찾았습니다. 같은 이름의 다른 회차가 포함되어 있어 합치지 않았습니다. 공고일·공고번호·주택관리번호·유형·접수 상태를 확인해 회차를 고르세요. (조회 범위: '
          || scope_label || ')';
      else
        assistant_text := query_label || ' 검색 결과 ' || match_count
          || '건을 찾았습니다. 공고일·공고번호·유형을 확인해 검토할 회차를 고른 뒤 주택형을 선택하세요. (조회 범위: '
          || scope_label || ')';
      end if;
      if match_count > 0 and not coverage_complete then
        assistant_text := assistant_text || ' 공유 색인의 공고 수집이 완전하지 않아 누락된 회차가 있을 수 있습니다.';
      end if;
    end if;
  end if;

  user_ts := clock_timestamp();
  insert into public.chat_messages(user_id, chat_id, role, content, created_at, request_key)
    values (owner_id, p_chat_id, 'user', clean_message, user_ts, p_request_key)
    returning * into user_row;

  assistant_ts := greatest(clock_timestamp(), user_ts);
  insert into public.chat_messages(user_id, chat_id, role, content, created_at, request_key)
    values (owner_id, p_chat_id, 'assistant', assistant_text, assistant_ts, p_request_key)
    returning * into assistant_row;

  select * into cfg from private.agent_settings where singleton is true;
  if found and cfg.enabled is true then
    insert into private.chat_agent_replies(
      user_message_id, assistant_message_id, chat_id, user_id, original_action, status, model
    ) values (
      user_row.id, assistant_row.id, p_chat_id, owner_id, p_action, 'queued', cfg.model
    )
    returning * into queued_reply;
    reply_json := private.chat_agent_reply_json(queued_reply, owner_id);
  end if;

  update public.chats c
    set updated_at = assistant_ts
    where (c.id, c.user_id) = (p_chat_id, owner_id);

  return jsonb_build_object(
    'contractVersion', 'chat-message/v1',
    'chatId', p_chat_id,
    'action', p_action,
    'userMessage', jsonb_build_object(
      'id', user_row.id,
      'role', user_row.role,
      'content', user_row.content,
      'createdAt', user_row.created_at,
      'agentReply', reply_json
    ),
    'assistantMessage', jsonb_build_object(
      'id', assistant_row.id,
      'role', assistant_row.role,
      'content', assistant_row.content,
      'createdAt', assistant_row.created_at
    ),
    'agentReply', reply_json
  );
end;
$$;

-- 소유자 확인 카드 준비(소유권·상태 검증 후 기존 맞춤 검색 경로로 실행할 조건을 읽는다).
create function private.prepare_chat_search_confirmation(
  p_chat_id uuid,
  p_reply_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' set timezone = 'UTC' as $$
declare
  owner_id uuid := private.chat_home_owner();
  reply_row private.chat_agent_replies%rowtype;
  msg_row public.chat_messages%rowtype;
begin
  if p_chat_id is null or p_reply_id is null then
    raise exception 'invalid_chat_search_decision' using errcode = '22023';
  end if;

  select ar.* into reply_row
    from private.chat_agent_replies ar
    where (ar.id, ar.chat_id, ar.user_id) = (p_reply_id, p_chat_id, owner_id);
  if not found then
    raise exception 'chat_not_found' using errcode = 'PT404';
  end if;

  if reply_row.search_proposal is null then
    raise exception 'chat_search_proposal_missing' using errcode = 'PT409';
  end if;

  if reply_row.search_result_message_id is not null then
    select * into msg_row
      from public.chat_messages m
      where m.id = reply_row.search_result_message_id and m.user_id = owner_id;
  end if;

  return jsonb_build_object(
    'chatId', p_chat_id,
    'replyId', p_reply_id,
    'status', reply_row.search_proposal_status,
    'searchProposal', reply_row.search_proposal,
    'confirmedConditions', reply_row.search_confirmed_conditions,
    'resultSummary', reply_row.search_result_summary,
    'agentReply', private.chat_agent_reply_json(reply_row, owner_id),
    'resultMessage', case when msg_row.id is not null then jsonb_build_object(
      'id', msg_row.id,
      'role', msg_row.role,
      'content', msg_row.content,
      'createdAt', msg_row.created_at
    ) else null end
  );
end;
$$;

-- 소유자의 탐색 조건 확인·거절·취소를 기록한다.
-- 거절·취소는 아무 검색도 실행하지 않으며, 확인 시에만 검증된 조건과 결과 요약을 채팅에 기록한다.
create function private.decide_chat_search_proposal(
  p_chat_id uuid,
  p_reply_id uuid,
  p_decision text,
  p_conditions jsonb default null,
  p_result_summary jsonb default null
) returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  owner_id uuid := private.chat_home_owner();
  reply_row private.chat_agent_replies%rowtype;
  target_status text;
  effective_conditions jsonb;
  summary_text text;
  msg_row public.chat_messages%rowtype;
  now_ts timestamptz;
begin
  if p_chat_id is null or p_reply_id is null
    or p_decision is null or p_decision not in ('confirm', 'reject', 'cancel') then
    raise exception 'invalid_chat_search_decision' using errcode = '22023';
  end if;

  if p_decision in ('reject', 'cancel') and (p_conditions is not null or p_result_summary is not null) then
    raise exception 'invalid_chat_search_decision' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('homecierge:chats:' || owner_id::text, 0));

  perform 1 from public.chats c
    where (c.id, c.user_id) = (p_chat_id, owner_id)
    for update;
  if not found then
    raise exception 'chat_not_found' using errcode = 'PT404';
  end if;

  select ar.* into reply_row
    from private.chat_agent_replies ar
    where (ar.id, ar.chat_id, ar.user_id) = (p_reply_id, p_chat_id, owner_id)
    for update;
  if not found then
    raise exception 'chat_not_found' using errcode = 'PT404';
  end if;

  if reply_row.search_proposal is null then
    raise exception 'chat_search_proposal_missing' using errcode = 'PT409';
  end if;

  if p_decision in ('reject', 'cancel') then
    target_status := case when p_decision = 'reject' then 'rejected' else 'cancelled' end;
    if reply_row.search_proposal_status = target_status then
      return jsonb_build_object(
        'contractVersion', 'chat-search-decision/v1',
        'chatId', p_chat_id,
        'replyId', p_reply_id,
        'agentReply', private.chat_agent_reply_json(reply_row, owner_id),
        'resultMessage', null
      );
    end if;
    if reply_row.search_proposal_status <> 'pending' then
      raise exception 'chat_request_conflict' using errcode = 'PT409';
    end if;

    update private.chat_agent_replies
      set search_proposal_status = target_status,
          search_decided_at = clock_timestamp()
      where id = reply_row.id
      returning * into reply_row;

    return jsonb_build_object(
      'contractVersion', 'chat-search-decision/v1',
      'chatId', p_chat_id,
      'replyId', p_reply_id,
      'agentReply', private.chat_agent_reply_json(reply_row, owner_id),
      'resultMessage', null
    );
  end if;

  -- p_decision = 'confirm'
  if p_result_summary is null then
    raise exception 'invalid_chat_search_summary' using errcode = '22023';
  end if;

  if not private.comparison_sources_permitted(array['applyhome_apt', 'applyhome_remainder', 'mois_legal_region_codes']) then
    raise exception 'search_source_restricted' using errcode = 'PT403';
  end if;

  effective_conditions := private.normalize_chat_search_conditions(
    coalesce(p_conditions, reply_row.search_proposal),
    true
  );

  if reply_row.search_proposal_status = 'confirmed' then
    if reply_row.search_confirmed_conditions is distinct from effective_conditions then
      raise exception 'chat_request_conflict' using errcode = 'PT409';
    end if;
    if reply_row.search_result_message_id is not null then
      select * into msg_row
        from public.chat_messages m
        where m.id = reply_row.search_result_message_id and m.user_id = owner_id;
    end if;
    return jsonb_build_object(
      'contractVersion', 'chat-search-decision/v1',
      'chatId', p_chat_id,
      'replyId', p_reply_id,
      'agentReply', private.chat_agent_reply_json(reply_row, owner_id),
      'resultMessage', case when msg_row.id is not null then jsonb_build_object(
        'id', msg_row.id,
        'role', msg_row.role,
        'content', msg_row.content,
        'createdAt', msg_row.created_at
      ) else null end
    );
  end if;

  if reply_row.search_proposal_status <> 'pending' then
    raise exception 'chat_request_conflict' using errcode = 'PT409';
  end if;

  perform private.validate_chat_search_result_summary(p_result_summary);
  if private.normalize_chat_search_conditions(p_result_summary->'appliedConditions', false) is distinct from effective_conditions then
    raise exception 'invalid_chat_search_summary' using errcode = '22023';
  end if;
  summary_text := private.format_chat_search_summary_text(effective_conditions, p_result_summary);

  now_ts := clock_timestamp();
  insert into public.chat_messages(user_id, chat_id, role, content, created_at, request_key)
    values (owner_id, p_chat_id, 'assistant', summary_text, now_ts, null)
    returning * into msg_row;

  update private.chat_agent_replies
    set search_proposal_status = 'confirmed',
        search_confirmed_conditions = effective_conditions,
        search_result_summary = p_result_summary,
        search_result_message_id = msg_row.id,
        search_decided_at = now_ts
    where id = reply_row.id
    returning * into reply_row;

  update public.chats c
    set updated_at = greatest(c.updated_at, now_ts)
    where (c.id, c.user_id) = (p_chat_id, owner_id);

  return jsonb_build_object(
    'contractVersion', 'chat-search-decision/v1',
    'chatId', p_chat_id,
    'replyId', p_reply_id,
    'agentReply', private.chat_agent_reply_json(reply_row, owner_id),
    'resultMessage', jsonb_build_object(
      'id', msg_row.id,
      'role', msg_row.role,
      'content', msg_row.content,
      'createdAt', msg_row.created_at
    )
  );
end;
$$;

-- 만료된 채팅 에이전트 임대를 expired 상태로 정리한다.
create function private.expire_stale_chat_agent_replies_core()
returns integer language plpgsql set search_path = '' as $$
declare
  affected integer;
begin
  update private.chat_agent_replies
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

create function private.lock_leased_chat_agent_reply(
  p_reply_id uuid,
  p_generation integer,
  p_lease_token uuid
) returns private.chat_agent_replies language plpgsql set search_path = '' as $$
declare
  reply_row private.chat_agent_replies%rowtype;
begin
  if p_reply_id is null or p_generation is null or p_generation < 1 or p_lease_token is null then
    raise exception 'invalid_chat_agent_lease' using errcode = '22023';
  end if;

  select * into reply_row
    from private.chat_agent_replies ar
    where ar.id = p_reply_id
    for update;
  if not found then
    raise exception 'chat_agent_reply_not_found' using errcode = 'PT404';
  end if;
  if exists (select 1 from private.account_deletion_fences f where f.user_id = reply_row.user_id) then
    raise exception 'chat_agent_reply_not_found' using errcode = 'PT404';
  end if;
  if reply_row.status <> 'leased'
    or reply_row.generation <> p_generation
    or reply_row.lease_token is distinct from p_lease_token
    or reply_row.lease_expires_at <= clock_timestamp() then
    raise exception 'chat_agent_reply_stale_lease' using errcode = 'PT409';
  end if;
  return reply_row;
end;
$$;

-- 작업자용 RPC (service_role 전용)
create function public.expire_stale_chat_agent_replies()
returns integer language plpgsql security definer set search_path = '' as $$
begin
  return private.expire_stale_chat_agent_replies_core();
end;
$$;

create function public.claim_chat_agent_reply(
  p_lease_seconds integer default 60,
  p_reply_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  claimed private.chat_agent_replies%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds not between 1 and 300 then
    raise exception 'invalid_chat_agent_lease' using errcode = '22023';
  end if;

  perform private.expire_stale_chat_agent_replies_core();

  select ar.* into claimed
    from private.chat_agent_replies ar
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

  update private.chat_agent_replies
    set status = 'leased',
        generation = generation + 1,
        lease_token = gen_random_uuid(),
        leased_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    where id = claimed.id
    returning * into claimed;

  return jsonb_build_object(
    'replyId', claimed.id,
    'userMessageId', claimed.user_message_id,
    'chatId', claimed.chat_id,
    'generation', claimed.generation,
    'leaseToken', claimed.lease_token,
    'model', claimed.model,
    'leaseExpiresAt', claimed.lease_expires_at
  );
end;
$$;

-- 작업자가 임대 중인 채팅 메시지의 문맥을 읽는다.
-- Q-42: source_registry.llm_permission = 'allowed'인 출처의 지역·공고 목록만 포함하며, 네이버 뉴스·업로드는 항상 제외한다.
create function public.read_chat_agent_reply_context(
  p_reply_id uuid,
  p_generation integer,
  p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  reply_row private.chat_agent_replies%rowtype := private.lock_leased_chat_agent_reply(p_reply_id, p_generation, p_lease_token);
  msg_row public.chat_messages%rowtype;
  recent_json jsonb;
  profile_row public.user_profiles%rowtype;
  published jsonb;
  dir_names jsonb;
  index_fresh boolean := false;
  checked_sources constant text[] := array[
    'mois_legal_region_codes',
    'applyhome_apt',
    'applyhome_remainder',
    'applyhome_apt_model',
    'applyhome_remainder_model'
  ];
  allowed_sources text[];
  restricted_sources text[];
  regions_ok boolean;
  apt_ok boolean;
  rem_ok boolean;
  apt_model_ok boolean;
  rem_model_ok boolean;
  regions_json jsonb := '[]'::jsonb;
  directory_json jsonb := null;
  filtered_notices jsonb := '[]'::jsonb;
  as_of_kst text;
begin
  select * into msg_row
    from public.chat_messages m
    where m.id = reply_row.user_message_id and m.user_id = reply_row.user_id;
  if not found then
    raise exception 'chat_agent_reply_not_found' using errcode = 'PT404';
  end if;

  select coalesce(
      jsonb_agg(
        jsonb_build_object('role', sub.role, 'content', sub.content, 'createdAt', sub.created_at)
        order by sub.created_at asc, sub.message_order asc, sub.id asc
      ),
      '[]'::jsonb
    )
    into recent_json
    from (
      select m.id, m.role, m.content, m.created_at, m.message_order
      from public.chat_messages m
      where (m.chat_id, m.user_id) = (reply_row.chat_id, reply_row.user_id)
        and (m.created_at, m.message_order, m.id) < (msg_row.created_at, msg_row.message_order, msg_row.id)
      order by m.created_at desc, m.message_order desc, m.id desc
      limit 10
    ) as sub;

  select * into profile_row
    from public.user_profiles p
    where p.user_id = reply_row.user_id;

  select
    coalesce(
      array_agg(s.id order by s.id)
        filter (where private.source_llm_allowed(s.id) and private.comparison_sources_permitted(array[s.id])),
      '{}'::text[]
    ),
    coalesce(
      array_agg(s.id order by s.id)
        filter (where not (private.source_llm_allowed(s.id) and private.comparison_sources_permitted(array[s.id]))),
      '{}'::text[]
    )
    into allowed_sources, restricted_sources
    from unnest(checked_sources) as s(id);

  regions_ok := 'mois_legal_region_codes' = any(allowed_sources);
  apt_ok := 'applyhome_apt' = any(allowed_sources);
  rem_ok := 'applyhome_remainder' = any(allowed_sources);
  apt_model_ok := 'applyhome_apt_model' = any(allowed_sources);
  rem_model_ok := 'applyhome_remainder_model' = any(allowed_sources);

  select p.index_value, p.region_names into published, dir_names
    from private.notice_directory_publication p
    limit 1;
  if not found then
    select i.index_value into published from private.notice_search_index i limit 1;
    dir_names := '{}'::jsonb;
  end if;

  if published is not null then
    index_fresh := coalesce(private.notice_search_is_fresh(private.notice_search_epoch(published->>'observedAt')), false);
  end if;

  if published is not null and index_fresh and regions_ok and jsonb_typeof(published->'regionCodes') = 'array' then
    select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'code', r.code,
            'name', case when dir_names ? r.code then dir_names->>r.code else null end
          )
          order by r.code collate "C"
        ),
        '[]'::jsonb
      )
      into regions_json
      from jsonb_array_elements_text(published->'regionCodes') as r(code);
  end if;

  if published is not null and index_fresh and (apt_ok or rem_ok) and jsonb_typeof(published->'notices') = 'array' then
    select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'houseManageNo', n.val->>'houseManageNo',
            'noticeNo', n.val->>'noticeNo',
            'edition', n.val->>'edition',
            'title', n.val->'title',
            'kind', n.val->>'kind',
            'regionCode', n.val->'regionCode',
            'regionName', case
              when regions_ok and n.val->>'regionCode' is not null and dir_names ? (n.val->>'regionCode')
                then to_jsonb(dir_names->>(n.val->>'regionCode'))
              else 'null'::jsonb
            end,
            'application', n.val->'application',
            'applicationSegments', coalesce(n.val->'applicationSegments', 'null'::jsonb),
            'models', case
              when (
                (n.val->'sourceIds' ? 'applyhome_apt_model' and not apt_model_ok)
                or (n.val->'sourceIds' ? 'applyhome_remainder_model' and not rem_model_ok)
              ) then '[]'::jsonb
              else coalesce(
                (
                  select jsonb_agg(
                    jsonb_build_object('modelNo', m.val->>'modelNo', 'houseType', m.val->'houseType')
                    order by m.pos
                  )
                  from jsonb_array_elements(coalesce(n.val->'models', '[]'::jsonb)) with ordinality as m(val, pos)
                ),
                '[]'::jsonb
              )
            end,
            'reasonCodes', coalesce(n.val->'reasonCodes', '[]'::jsonb)
          )
          order by n.pos
        ),
        '[]'::jsonb
      )
      into filtered_notices
      from jsonb_array_elements(published->'notices') with ordinality as n(val, pos)
      where n.val->>'kind' is distinct from 'unsupported'
        and (
          (n.val->'sourceIds' ? 'applyhome_apt' and apt_ok)
          or (n.val->'sourceIds' ? 'applyhome_remainder' and rem_ok)
        )
        and not (n.val->'sourceIds' ? 'applyhome_apt' and not apt_ok)
        and not (n.val->'sourceIds' ? 'applyhome_remainder' and not rem_ok);

    directory_json := jsonb_build_object(
      'observedAt', published->>'observedAt',
      'publicationWindow', published->'publicationWindow',
      'coverage', published->'coverage',
      'notices', filtered_notices
    );
  end if;

  as_of_kst := to_char((clock_timestamp() at time zone 'Asia/Seoul')::date, 'YYYY-MM-DD');

  return jsonb_build_object(
    'replyId', reply_row.id,
    'userMessageId', reply_row.user_message_id,
    'chatId', reply_row.chat_id,
    'model', reply_row.model,
    'asOf', as_of_kst,
    'message', msg_row.content,
    'originalAction', reply_row.original_action,
    'recentMessages', recent_json,
    'sharedProfile', jsonb_build_object(
      'revision', coalesce(profile_row.revision, 0),
      'conditions', private.format_search_conditions(profile_row.search_conditions)
    ),
    'regions', regions_json,
    'directoryIndex', directory_json,
    'llmSourcePolicy', jsonb_build_object(
      'allowedSources', to_jsonb(allowed_sources),
      'restrictedSources', to_jsonb(restricted_sources),
      'hasRestrictedSources', cardinality(restricted_sources) > 0,
      'newsExcluded', true
    )
  );
end;
$$;

-- 작업자가 검증을 마친 채팅 에이전트 응답을 기록한다.
-- 탐색 조건 제안은 확인 대기(pending)로만 저장하고 실행하지 않으며,
-- 공유 프로필 변경안은 기존 O-3 승인 대기(pending) 행으로만 생성한다.
create function public.complete_chat_agent_reply(
  p_reply_id uuid,
  p_generation integer,
  p_lease_token uuid,
  p_status text,
  p_intent text default null,
  p_answer text default null,
  p_citations jsonb default '[]'::jsonb,
  p_search_proposal jsonb default null,
  p_profile_proposal jsonb default null,
  p_lookup_query jsonb default null,
  p_usage jsonb default '{}'::jsonb,
  p_validation jsonb default '{}'::jsonb,
  p_prompt_version text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  lookup_chat uuid;
  lookup_user uuid;
  lookup_msg uuid;
  reply_row private.chat_agent_replies%rowtype;
  final_status text := p_status;
  trimmed_answer text := null;
  clean_citations jsonb := '[]'::jsonb;
  norm_search jsonb := null;
  norm_profile jsonb := null;
  norm_lookup jsonb := null;
  created_profile_req uuid := null;
  val_status text;
  val_reasons text[] := '{}';
  in_tok integer := null;
  out_tok integer := null;
  reason_tok integer := null;
  lat_ms integer := null;
  est_cost numeric(14,8) := null;
  price_date date := null;
  lq_query text;
  lq_mode text;
begin
  if p_reply_id is null or p_generation is null or p_generation < 1 or p_lease_token is null
    or p_status is null or p_status not in ('answered', 'rejected') then
    raise exception 'invalid_chat_agent_completion' using errcode = '22023';
  end if;
  if p_prompt_version is not null and char_length(p_prompt_version) not between 1 and 80 then
    raise exception 'invalid_chat_agent_completion' using errcode = '22023';
  end if;
  if (p_citations is not null and private.comparison_contains_raw_payload(p_citations))
    or (p_search_proposal is not null and private.comparison_contains_raw_payload(p_search_proposal))
    or (p_profile_proposal is not null and private.comparison_contains_raw_payload(p_profile_proposal))
    or (p_lookup_query is not null and private.comparison_contains_raw_payload(p_lookup_query))
    or (p_usage is not null and private.comparison_contains_raw_payload(p_usage))
    or (p_validation is not null and private.comparison_contains_raw_payload(p_validation)) then
    raise exception 'invalid_chat_agent_completion' using errcode = '22023';
  end if;

  -- 교착 방지를 위해 chats -> chat_messages -> chat_agent_replies 순으로 잠근다.
  select ar.chat_id, ar.user_id, ar.user_message_id into lookup_chat, lookup_user, lookup_msg
    from private.chat_agent_replies ar
    where ar.id = p_reply_id;
  if not found then
    raise exception 'chat_agent_reply_not_found' using errcode = 'PT404';
  end if;

  perform 1 from public.chats c
    where (c.id, c.user_id) = (lookup_chat, lookup_user)
    for no key update;
  if not found then
    raise exception 'chat_agent_reply_not_found' using errcode = 'PT404';
  end if;

  perform 1 from public.chat_messages m
    where m.id = lookup_msg and m.user_id = lookup_user
    for no key update;
  if not found then
    raise exception 'chat_agent_reply_not_found' using errcode = 'PT404';
  end if;

  reply_row := private.lock_leased_chat_agent_reply(p_reply_id, p_generation, p_lease_token);

  if p_usage is not null and jsonb_typeof(p_usage) = 'object' then
    if jsonb_typeof(p_usage->'inputTokens') = 'number' then in_tok := (p_usage->>'inputTokens')::integer; end if;
    if jsonb_typeof(p_usage->'outputTokens') = 'number' then out_tok := (p_usage->>'outputTokens')::integer; end if;
    if jsonb_typeof(p_usage->'reasoningTokens') = 'number' then reason_tok := (p_usage->>'reasoningTokens')::integer; end if;
    if jsonb_typeof(p_usage->'latencyMs') = 'number' then lat_ms := (p_usage->>'latencyMs')::integer; end if;
    if jsonb_typeof(p_usage->'estimatedCostUsd') in ('string', 'number')
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
    if p_intent is null
      or p_intent not in ('search_confirm', 'search_clarify', 'profile_proposal', 'lookup', 'help', 'pdf_guide')
      or p_answer is null or p_answer ~ '[\u0001-\u0009\u000B-\u001F\u007F]' then
      raise exception 'invalid_chat_agent_completion' using errcode = '22023';
    end if;
    trimmed_answer := btrim(p_answer);
    if char_length(trimmed_answer) not between 1 and 2000 then
      raise exception 'invalid_chat_agent_completion' using errcode = '22023';
    end if;
    if p_citations is not null then
      if not private.valid_chat_agent_citations(p_citations) then
        raise exception 'invalid_chat_agent_completion' using errcode = '22023';
      end if;
      clean_citations := p_citations;
    end if;
    val_status := 'passed';

    -- 1) 탐색 조건 제안 검증 (search_confirm에서만 허용·필수)
    if p_intent = 'search_confirm' then
      if p_search_proposal is null or p_search_proposal = 'null'::jsonb then
        final_status := 'rejected';
        val_status := 'rejected';
        val_reasons := array_append(val_reasons, 'server_missing_search_proposal');
      else
        begin
          norm_search := private.normalize_chat_search_conditions(p_search_proposal, true);
        exception when others then
          final_status := 'rejected';
          val_status := 'rejected';
          val_reasons := array_append(val_reasons, 'server_search_proposal_validation_failed');
        end;
      end if;
    elsif p_search_proposal is not null and p_search_proposal <> 'null'::jsonb then
      final_status := 'rejected';
      val_status := 'rejected';
      val_reasons := array_append(val_reasons, 'server_unexpected_search_proposal');
    end if;

    -- 2) 공고 찾기 쿼리 검증 (lookup에서만 선택 허용 — 프로필 변경안 생성 전에 검증해 거부 시 고아 행을 남기지 않는다)
    if final_status = 'answered' and p_lookup_query is not null and p_lookup_query <> 'null'::jsonb then
      if p_intent <> 'lookup' or jsonb_typeof(p_lookup_query) <> 'object'
        or not (p_lookup_query ? 'query' and p_lookup_query ? 'mode')
        or jsonb_typeof(p_lookup_query->'query') <> 'string'
        or jsonb_typeof(p_lookup_query->'mode') <> 'string' then
        final_status := 'rejected';
        val_status := 'rejected';
        val_reasons := array_append(val_reasons, 'server_invalid_lookup_query');
      else
        lq_mode := p_lookup_query->>'mode';
        lq_query := btrim(p_lookup_query->>'query');
        if lq_mode not in ('name', 'number')
          or char_length(lq_query) not between 1 and 120
          or lq_query ~ '[[:cntrl:]]'
          or (lq_mode = 'number' and lq_query !~ '\A[0-9]{1,10}\Z') then
          final_status := 'rejected';
          val_status := 'rejected';
          val_reasons := array_append(val_reasons, 'server_invalid_lookup_query');
        else
          norm_lookup := jsonb_build_object('query', lq_query, 'mode', lq_mode);
        end if;
      end if;
    end if;

    -- 3) 공유 프로필 변경안 검증 및 pending 생성 (profile_proposal 필수, search_confirm 선택)
    if final_status = 'answered' then
      if p_intent = 'profile_proposal' and (p_profile_proposal is null or p_profile_proposal = 'null'::jsonb) then
        final_status := 'rejected';
        val_status := 'rejected';
        val_reasons := array_append(val_reasons, 'server_missing_profile_proposal');
      elsif p_profile_proposal is not null and p_profile_proposal <> 'null'::jsonb then
        if p_intent not in ('profile_proposal', 'search_confirm')
          or jsonb_typeof(p_profile_proposal) <> 'object'
          or not (p_profile_proposal ? 'patch' and p_profile_proposal ? 'reason')
          or jsonb_typeof(p_profile_proposal->'patch') <> 'object'
          or jsonb_typeof(p_profile_proposal->'reason') <> 'string' then
          final_status := 'rejected';
          val_status := 'rejected';
          val_reasons := array_append(val_reasons, 'server_profile_proposal_validation_failed');
        else
          begin
            created_profile_req := private.create_chat_profile_proposal(
              reply_row.user_id,
              p_profile_proposal->'patch',
              p_profile_proposal->>'reason'
            );
            norm_profile := jsonb_build_object(
              'patch', private.normalize_search_profile_patch(p_profile_proposal->'patch'),
              'reason', private.normalize_search_profile_reason(p_profile_proposal->>'reason')
            );
          exception when others then
            final_status := 'rejected';
            val_status := 'rejected';
            val_reasons := array_append(val_reasons, 'server_profile_proposal_validation_failed');
          end;
        end if;
      end if;
    end if;

    if final_status = 'rejected' then
      trimmed_answer := null;
      clean_citations := '[]'::jsonb;
      norm_search := null;
      norm_profile := null;
      norm_lookup := null;
      created_profile_req := null;
    end if;
  else
    val_status := 'rejected';
    trimmed_answer := null;
    clean_citations := '[]'::jsonb;
  end if;

  update private.chat_agent_replies
    set status = final_status,
        prompt_version = coalesce(p_prompt_version, prompt_version),
        lease_token = null,
        lease_expires_at = null,
        resolved_intent = case when final_status = 'answered' then p_intent else null end,
        answer_text = trimmed_answer,
        citations = clean_citations,
        search_proposal = norm_search,
        search_proposal_status = case when norm_search is not null then 'pending' else null end,
        profile_proposal = norm_profile,
        profile_change_request_id = created_profile_req,
        lookup_query = norm_lookup,
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
    'userMessageId', reply_row.user_message_id,
    'chatId', reply_row.chat_id,
    'status', final_status,
    'searchProposalAttached', norm_search is not null,
    'profileChangeRequestId', created_profile_req,
    'validationStatus', val_status,
    'validationReasons', to_jsonb(val_reasons)
  );
end;
$$;

create function public.fail_chat_agent_reply(
  p_reply_id uuid,
  p_generation integer,
  p_lease_token uuid,
  p_failure_code text,
  p_usage jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  reply_row private.chat_agent_replies%rowtype := private.lock_leased_chat_agent_reply(p_reply_id, p_generation, p_lease_token);
  lat_ms integer := null;
begin
  if p_failure_code is null or char_length(btrim(p_failure_code)) not between 1 and 80
    or p_failure_code ~ '[\u0001-\u001F\u007F]' then
    raise exception 'invalid_chat_agent_failure' using errcode = '22023';
  end if;
  if p_usage is not null and jsonb_typeof(p_usage) = 'object' and jsonb_typeof(p_usage->'latencyMs') = 'number' then
    lat_ms := (p_usage->>'latencyMs')::integer;
  end if;

  update private.chat_agent_replies
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
    'userMessageId', reply_row.user_message_id,
    'chatId', reply_row.chat_id,
    'status', 'failed',
    'failureCode', btrim(p_failure_code)
  );
end;
$$;

-- 소유자 공개 RPC 래퍼 (security invoker, authenticated 전용)
create function public.prepare_chat_search_confirmation(p_chat_id uuid, p_reply_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.prepare_chat_search_confirmation(p_chat_id, p_reply_id);
$$;

create function public.decide_chat_search_proposal(
  p_chat_id uuid,
  p_reply_id uuid,
  p_decision text,
  p_conditions jsonb default null,
  p_result_summary jsonb default null
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.decide_chat_search_proposal(p_chat_id, p_reply_id, p_decision, p_conditions, p_result_summary);
$$;

revoke all on function
  private.valid_chat_agent_citations(jsonb),
  private.normalize_chat_search_conditions(jsonb, boolean),
  private.create_chat_profile_proposal(uuid, jsonb, text),
  private.validate_chat_search_result_summary(jsonb),
  private.format_chat_search_summary_text(jsonb, jsonb),
  private.chat_agent_reply_json(private.chat_agent_replies, uuid),
  private.read_chat_detail(uuid),
  private.post_chat_message(uuid, uuid, text, text, text, text),
  private.prepare_chat_search_confirmation(uuid, uuid),
  private.decide_chat_search_proposal(uuid, uuid, text, jsonb, jsonb),
  private.expire_stale_chat_agent_replies_core(),
  private.lock_leased_chat_agent_reply(uuid, integer, uuid),
  public.prepare_chat_search_confirmation(uuid, uuid),
  public.decide_chat_search_proposal(uuid, uuid, text, jsonb, jsonb),
  public.expire_stale_chat_agent_replies(),
  public.claim_chat_agent_reply(integer, uuid),
  public.read_chat_agent_reply_context(uuid, integer, uuid),
  public.complete_chat_agent_reply(uuid, integer, uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text),
  public.fail_chat_agent_reply(uuid, integer, uuid, text, jsonb)
from public, anon, authenticated, service_role;

grant execute on function
  private.read_chat_detail(uuid),
  private.post_chat_message(uuid, uuid, text, text, text, text),
  private.prepare_chat_search_confirmation(uuid, uuid),
  private.decide_chat_search_proposal(uuid, uuid, text, jsonb, jsonb),
  public.prepare_chat_search_confirmation(uuid, uuid),
  public.decide_chat_search_proposal(uuid, uuid, text, jsonb, jsonb)
to authenticated;

grant execute on function
  public.expire_stale_chat_agent_replies(),
  public.claim_chat_agent_reply(integer, uuid),
  public.read_chat_agent_reply_context(uuid, integer, uuid),
  public.complete_chat_agent_reply(uuid, integer, uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, text),
  public.fail_chat_agent_reply(uuid, integer, uuid, text, jsonb)
to service_role;

notify pgrst, 'reload schema';
