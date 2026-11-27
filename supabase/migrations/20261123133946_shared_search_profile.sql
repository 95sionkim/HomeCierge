-- 공유 탐색 프로필(6개 공개 조건 키)의 조회·변경안 제안·명시적 결정 RPC를 추가한다.
-- 기존 profile_change_requests와 decide_profile_change를 재사용하되 관리 대상 변경안의 우회를 차단한다.
alter table public.profile_change_requests
  add constraint profile_change_requests_id_user_key unique (id, user_id);

create table private.search_profile_proposals (
  change_id uuid primary key,
  user_id uuid not null,
  request_id uuid not null,
  proposal_order bigint generated always as identity not null unique,
  previous_values jsonb not null,
  patch_values jsonb not null,
  request_patch_digest bytea not null check (octet_length(request_patch_digest) = 32),
  analysis_id uuid,
  run_id uuid,
  unique (user_id, request_id),
  foreign key (change_id, user_id)
    references public.profile_change_requests(id, user_id) on delete cascade,
  foreign key (run_id, analysis_id, user_id)
    references private.analysis_runs(id, analysis_id, user_id) on delete set null (run_id, analysis_id),
  check ((analysis_id is null) = (run_id is null)),
  check (
    jsonb_typeof(previous_values) = 'object'
    and jsonb_typeof(patch_values) = 'object'
    and patch_values <> '{}'::jsonb
    and previous_values - array[
      'region_codes','budget_max_won','supply_area_min_m2','supply_area_max_m2',
      'move_in_start_month','move_in_end_month'
    ] = '{}'::jsonb
    and patch_values - array[
      'region_codes','budget_max_won','supply_area_min_m2','supply_area_max_m2',
      'move_in_start_month','move_in_end_month'
    ] = '{}'::jsonb
  )
);

create index search_profile_proposals_owner_order_idx
  on private.search_profile_proposals(user_id, proposal_order desc);
create index search_profile_proposals_origin_idx
  on private.search_profile_proposals(run_id, analysis_id, user_id) where run_id is not null;

alter table private.search_profile_proposals enable row level security;
revoke all on private.search_profile_proposals from public, anon, authenticated, service_role;

-- SQL 저장 면적(numeric)을 부동소수점 변환 없이 정밀 십진 문자열로 변환한다.
create function private.format_search_area(p_value jsonb)
returns text language sql immutable strict set search_path = '' as $$
  select trim_scale((p_value #>> '{}')::numeric)::text;
$$;

-- 공유 프로필의 6개 공개 조건 키만 투영한다. 미설정 키는 생략하고 면적은 십진 문자열로 출력한다.
create function private.format_search_conditions(p_value jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case
    when p_value is null or jsonb_typeof(p_value) <> 'object' then '{}'::jsonb
    else
      (case when p_value ? 'region_codes'
        then jsonb_build_object('region_codes', p_value->'region_codes') else '{}'::jsonb end)
      || (case when p_value ? 'budget_max_won'
        then jsonb_build_object('budget_max_won', p_value->'budget_max_won') else '{}'::jsonb end)
      || (case when p_value ? 'supply_area_min_m2'
        then jsonb_build_object('supply_area_min_m2', to_jsonb(private.format_search_area(p_value->'supply_area_min_m2')))
        else '{}'::jsonb end)
      || (case when p_value ? 'supply_area_max_m2'
        then jsonb_build_object('supply_area_max_m2', to_jsonb(private.format_search_area(p_value->'supply_area_max_m2')))
        else '{}'::jsonb end)
      || (case when p_value ? 'move_in_start_month'
        then jsonb_build_object('move_in_start_month', p_value->'move_in_start_month') else '{}'::jsonb end)
      || (case when p_value ? 'move_in_end_month'
        then jsonb_build_object('move_in_end_month', p_value->'move_in_end_month') else '{}'::jsonb end)
  end;
$$;

-- 사유 문자열은 기존 비교 대화 검증(줄바꿈 외 제어 문자 거부, 앞뒤 공백 정리, 1~800 코드 포인트)을 재사용한다.
create function private.normalize_search_profile_reason(p_reason text)
returns text language plpgsql immutable set search_path = '' as $$
begin
  return private.normalize_analysis_chat_message(p_reason);
exception when invalid_parameter_value then
  raise exception 'invalid_search_profile_reason' using errcode = '22023';
end;
$$;

-- 변경안 패치의 6개 공개 키·쌍 규칙·정밀 십진 문자열·정렬 지역 코드를 정규화해 검증한다.
create function private.normalize_search_profile_patch(p_patch jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  allowed_keys constant text[] := array[
    'region_codes','budget_max_won','supply_area_min_m2','supply_area_max_m2',
    'move_in_start_month','move_in_end_month'
  ];
  normalized jsonb := '{}'::jsonb;
  raw_regions jsonb;
  sorted_regions jsonb;
  raw_budget jsonb;
  raw_min jsonb;
  raw_max jsonb;
  min_num numeric;
  max_num numeric;
  raw_start jsonb;
  raw_end jsonb;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object'
    or p_patch = '{}'::jsonb
    or p_patch - allowed_keys <> '{}'::jsonb then
    raise exception 'invalid_search_profile_patch' using errcode = '22023';
  end if;

  if (p_patch ? 'supply_area_min_m2') <> (p_patch ? 'supply_area_max_m2')
    or (p_patch ? 'move_in_start_month') <> (p_patch ? 'move_in_end_month') then
    raise exception 'invalid_search_profile_patch' using errcode = '22023';
  end if;

  if p_patch ? 'region_codes' then
    raw_regions := p_patch->'region_codes';
    if raw_regions = 'null'::jsonb then
      normalized := normalized || '{"region_codes": null}'::jsonb;
    else
      if jsonb_typeof(raw_regions) <> 'array'
        or jsonb_array_length(raw_regions) not between 1 and 50
        or exists (
          select 1 from jsonb_array_elements(raw_regions) as r(value)
          where jsonb_typeof(r.value) <> 'string' or r.value #>> '{}' !~ '\A[0-9]{5}\Z'
        )
        or (select count(distinct value) from jsonb_array_elements_text(raw_regions)) <> jsonb_array_length(raw_regions) then
        raise exception 'invalid_search_profile_patch' using errcode = '22023';
      end if;
      select jsonb_agg(code order by code collate "C") into sorted_regions
        from jsonb_array_elements_text(raw_regions) as r(code);
      normalized := normalized || jsonb_build_object('region_codes', sorted_regions);
    end if;
  end if;

  if p_patch ? 'budget_max_won' then
    raw_budget := p_patch->'budget_max_won';
    if raw_budget = 'null'::jsonb then
      normalized := normalized || '{"budget_max_won": null}'::jsonb;
    else
      if jsonb_typeof(raw_budget) <> 'string'
        or raw_budget #>> '{}' !~ '\A(0|[1-9][0-9]{0,19})\Z' then
        raise exception 'invalid_search_profile_patch' using errcode = '22023';
      end if;
      normalized := normalized || jsonb_build_object('budget_max_won', raw_budget);
    end if;
  end if;

  if p_patch ? 'supply_area_min_m2' then
    raw_min := p_patch->'supply_area_min_m2';
    raw_max := p_patch->'supply_area_max_m2';
    if raw_min = 'null'::jsonb and raw_max = 'null'::jsonb then
      normalized := normalized || '{"supply_area_min_m2": null, "supply_area_max_m2": null}'::jsonb;
    elsif jsonb_typeof(raw_min) = 'string' and jsonb_typeof(raw_max) = 'string'
      and char_length(raw_min #>> '{}') <= 24 and char_length(raw_max #>> '{}') <= 24
      and (raw_min #>> '{}') ~ '\A([1-9][0-9]*(\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)\Z'
      and (raw_max #>> '{}') ~ '\A([1-9][0-9]*(\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)\Z' then
      min_num := trim_scale((raw_min #>> '{}')::numeric);
      max_num := trim_scale((raw_max #>> '{}')::numeric);
      if min_num <= 0 or max_num <= 0 or min_num > max_num then
        raise exception 'invalid_search_profile_patch' using errcode = '22023';
      end if;
      normalized := normalized || jsonb_build_object(
        'supply_area_min_m2', to_jsonb(min_num::text),
        'supply_area_max_m2', to_jsonb(max_num::text)
      );
    else
      raise exception 'invalid_search_profile_patch' using errcode = '22023';
    end if;
  end if;

  if p_patch ? 'move_in_start_month' then
    raw_start := p_patch->'move_in_start_month';
    raw_end := p_patch->'move_in_end_month';
    if raw_start = 'null'::jsonb and raw_end = 'null'::jsonb then
      normalized := normalized || '{"move_in_start_month": null, "move_in_end_month": null}'::jsonb;
    elsif jsonb_typeof(raw_start) = 'string' and jsonb_typeof(raw_end) = 'string'
      and (raw_start #>> '{}') ~ '\A[0-9]{4}-(0[1-9]|1[0-2])\Z'
      and (raw_end #>> '{}') ~ '\A[0-9]{4}-(0[1-9]|1[0-2])\Z'
      and left(raw_start #>> '{}', 4) <> '0000'
      and left(raw_end #>> '{}', 4) <> '0000'
      and (raw_start #>> '{}') collate "C" <= (raw_end #>> '{}') collate "C" then
      normalized := normalized || jsonb_build_object(
        'move_in_start_month', raw_start,
        'move_in_end_month', raw_end
      );
    else
      raise exception 'invalid_search_profile_patch' using errcode = '22023';
    end if;
  end if;

  return normalized;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'invalid_search_profile_patch' using errcode = '22023';
end;
$$;

-- 실제 새 지역 선택은 인증 지역 선택기와 같은 게시 사전(신선도·출처 권한 포함)에 대조한다.
create function private.require_search_profile_regions(p_codes jsonb)
returns void language plpgsql set search_path = '' as $$
declare
  required_sources constant text[] := array['applyhome_apt','applyhome_remainder','mois_legal_region_codes'];
  locked_sources integer;
  published jsonb;
  allowed_codes jsonb;
begin
  perform 1 from public.source_registry r where r.id = any(required_sources) order by r.id for share;
  get diagnostics locked_sources = row_count;

  published := private.notice_directory_index_value();
  if locked_sources <> cardinality(required_sources)
    or not private.comparison_sources_permitted(required_sources)
    or published is null
    or published->>'contractVersion' is distinct from 'notice-search-index/v1'
    or published->>'dataOrigin' is distinct from 'collected'
    or jsonb_typeof(published->'regionCodes') is distinct from 'array'
    or not coalesce(private.notice_search_is_fresh(private.notice_search_epoch(published->>'observedAt')), false) then
    raise exception 'profile_regions_unavailable' using errcode = 'PT403';
  end if;

  allowed_codes := published->'regionCodes';
  if exists (
    select 1 from jsonb_array_elements_text(p_codes) as c(code)
    where not (allowed_codes ? c.code)
  ) then
    raise exception 'invalid_search_profile_region' using errcode = '22023';
  end if;
end;
$$;

-- 관리 대상 변경안의 사유는 확인된 비익명 소유자만 조회할 수 있게 제한한다. 기존 행은 유지한다.
create function private.managed_profile_change_visible(p_change_id uuid, p_user_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is distinct from p_user_id then
    return false;
  end if;
  if not exists (
    select 1 from private.search_profile_proposals sp
    where sp.change_id = p_change_id and sp.user_id = p_user_id
  ) then
    return true;
  end if;
  return coalesce(auth.jwt()->'is_anonymous', 'false'::jsonb) = 'false'::jsonb
    and exists (
      select 1 from auth.users u
      where u.id = p_user_id
        and u.confirmed_at is not null
        and u.is_anonymous is false
        and u.deleted_at is null
        and (u.banned_until is null or u.banned_until <= statement_timestamp())
    );
end;
$$;

create policy managed_profile_change_verified_owner on public.profile_change_requests
  as restrictive for select to authenticated
  using (private.managed_profile_change_visible(id, user_id));

-- 기존 decide_profile_change 경로로 관리 대상 변경안의 추가 검증을 우회하지 못하게 차단한다.
create function private.decide_profile_change_core(request_id uuid, decision text, allow_managed boolean)
returns public.profile_change_requests
language plpgsql security definer set search_path = '' as $$
declare
  who uuid := auth.uid();
  proposal public.profile_change_requests;
  current_revision bigint;
begin
  if who is null or coalesce(auth.jwt()->>'is_anonymous','false') <> 'false'
     or not exists (select 1 from auth.users where id = who) then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if decision not in ('approved','rejected','cancelled') or decision is null then
    raise exception 'invalid_decision' using errcode = '22023';
  end if;
  select revision into current_revision from public.user_profiles where user_id = who for update;
  select * into proposal from public.profile_change_requests where id = request_id and user_id = who for update;
  if not found then raise exception 'proposal_not_found' using errcode = 'P0002'; end if;
  if not allow_managed and exists (
    select 1 from private.search_profile_proposals sp where sp.change_id = proposal.id
  ) then
    raise exception 'managed_profile_change_requires_rpc' using errcode = '42501';
  end if;
  if proposal.status <> 'pending' then raise exception 'proposal_already_decided' using errcode = '22023'; end if;
  if decision = 'approved' then
    if proposal.base_revision <> current_revision then
      raise exception 'profile_revision_conflict' using errcode = '40001';
    end if;
    update public.user_profiles set
      search_conditions = case when proposal.proposed_changes ? 'search_conditions'
        then proposal.proposed_changes->'search_conditions' else search_conditions end,
      commute_destination = case when proposal.proposed_changes ? 'commute_destination'
        then proposal.proposed_changes->>'commute_destination' else commute_destination end,
      revision = revision + 1
    where user_id = who;
  end if;
  update public.profile_change_requests set status = decision, decided_at = clock_timestamp()
    where id = proposal.id returning * into proposal;
  return proposal;
end;
$$;

create or replace function private.decide_profile_change(request_id uuid, decision text)
returns public.profile_change_requests
language sql security definer set search_path = '' as $$
  select private.decide_profile_change_core(request_id, decision, false);
$$;

-- 공유 프로필 현재 상태와 관리 대상 변경안 최신 30건(커서 포함)을 조합한다.
create function private.search_profile_payload(p_owner_id uuid, p_before_order bigint default null)
returns jsonb language sql stable set search_path = '' set timezone = 'UTC' as $$
  with profile as (
    select p.user_id, p.search_conditions, p.commute_destination, p.revision, p.updated_at
    from public.user_profiles p
    where p.user_id = p_owner_id
  ),
  fetched as (
    select
      sp.request_id,
      sp.proposal_order,
      pr.base_revision,
      sp.previous_values,
      sp.patch_values,
      pr.reason,
      pr.status,
      pr.created_at,
      pr.decided_at,
      sp.analysis_id,
      sp.run_id
    from private.search_profile_proposals sp
    join public.profile_change_requests pr
      on (pr.id, pr.user_id) = (sp.change_id, sp.user_id)
    where sp.user_id = p_owner_id
      and (p_before_order is null or sp.proposal_order < p_before_order)
    order by sp.proposal_order desc
    limit 31
  ),
  page as (
    select *
    from fetched
    order by proposal_order desc
    limit 30
  )
  select jsonb_build_object(
    'contractVersion', 'shared-profile/v1',
    'revision', coalesce((select p.revision from profile p), 0),
    'updatedAt', (
      select case
        when p.revision = 0 and p.search_conditions = '{}'::jsonb and p.commute_destination is null then null
        else p.updated_at
      end
      from profile p
    ),
    'conditions', private.format_search_conditions((select p.search_conditions from profile p)),
    'destination', (select p.commute_destination from profile p),
    'proposals', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', w.request_id,
            'baseRevision', w.base_revision,
            'previous', w.previous_values,
            'patch', w.patch_values,
            'reason', w.reason,
            'status', w.status,
            'createdAt', w.created_at,
            'decidedAt', w.decided_at,
            'analysisId', w.analysis_id,
            'runId', w.run_id
          )
          order by w.proposal_order desc
        )
        from page w
      ),
      '[]'::jsonb
    ),
    'nextCursor', case
      when (select count(*) > 30 from fetched) then (
        select w.request_id
        from page w
        order by w.proposal_order asc
        limit 1
      )
      else null
    end
  );
$$;

create function private.read_search_profile(p_before uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  before_order bigint;
begin
  if owner_id is null or coalesce(auth.jwt()->'is_anonymous', 'false'::jsonb) <> 'false'::jsonb
    or not exists (
      select 1 from auth.users u
      where u.id = owner_id
        and u.confirmed_at is not null
        and u.is_anonymous is false
        and u.deleted_at is null
        and (u.banned_until is null or u.banned_until <= statement_timestamp())
    ) then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  if p_before is not null then
    select sp.proposal_order into before_order
    from private.search_profile_proposals sp
    where sp.user_id = owner_id and sp.request_id = p_before;
    if not found then
      raise exception 'search_profile_cursor_not_found' using errcode = 'PT404';
    end if;
  end if;

  return private.search_profile_payload(owner_id, before_order);
end;
$$;

create function private.propose_search_profile_change(
  p_request_id uuid,
  p_base_revision bigint,
  p_patch jsonb,
  p_reason text,
  p_analysis_id uuid default null,
  p_run_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  normalized_reason text;
  normalized_patch jsonb;
  request_digest bytea;
  origin_run record;
  profile public.user_profiles%rowtype;
  current_revision bigint;
  current_conditions jsonb;
  existing record;
  next_conditions jsonb;
  previous_values jsonb := '{}'::jsonb;
  patch_values jsonb := '{}'::jsonb;
  had_key boolean;
  old_region_set jsonb;
  key_name text;
  old_area_num numeric;
  new_area_num numeric;
  new_change_id uuid;
begin
  perform private.require_notice_run_user(owner_id);
  if p_request_id is null or p_base_revision is null or p_base_revision < 0 then
    raise exception 'invalid_search_profile_request' using errcode = '22023';
  end if;
  if (p_analysis_id is null) <> (p_run_id is null) then
    raise exception 'invalid_search_profile_origin' using errcode = '22023';
  end if;

  normalized_reason := private.normalize_search_profile_reason(p_reason);
  normalized_patch := private.normalize_search_profile_patch(p_patch);
  request_digest := sha256(convert_to(normalized_patch::text, 'UTF8'));

  if p_analysis_id is not null then
    select r.id, c.run_id as result_run_id into origin_run
    from private.analysis_runs r
    left join private.comparison_results c on c.run_id = r.id and r.status = 'finished'
    where (r.id, r.analysis_id, r.user_id) = (p_run_id, p_analysis_id, owner_id)
    for key share of r;
    if not found then
      raise exception 'search_profile_origin_not_found' using errcode = 'PT404';
    end if;
    if origin_run.result_run_id is null then
      raise exception 'search_profile_origin_not_ready' using errcode = 'PT409';
    end if;
  end if;

  -- 계정 단위로 제안·결정을 직렬화해 동시 멱등 재시도와 동시 승인을 보호한다.
  perform pg_advisory_xact_lock(hashtextextended('homecierge:search-profile:' || owner_id::text, 0));
  select * into profile from public.user_profiles p where p.user_id = owner_id for update;
  current_revision := coalesce(profile.revision, 0);
  current_conditions := coalesce(profile.search_conditions, '{}'::jsonb);

  -- 버전·지역 사전 재검사보다 먼저 같은 요청 ID의 멱등 재전송을 복원한다.
  select pr.base_revision, pr.reason, sp.request_patch_digest, sp.analysis_id, sp.run_id
    into existing
    from private.search_profile_proposals sp
    join public.profile_change_requests pr on (pr.id, pr.user_id) = (sp.change_id, sp.user_id)
    where sp.user_id = owner_id and sp.request_id = p_request_id;
  if found then
    if (existing.base_revision, existing.request_patch_digest, existing.reason, existing.analysis_id, existing.run_id)
       is distinct from (p_base_revision, request_digest, normalized_reason, p_analysis_id, p_run_id) then
      raise exception 'search_profile_request_conflict' using errcode = 'PT409';
    end if;
    return private.search_profile_payload(owner_id, null);
  end if;

  if p_base_revision <> current_revision then
    raise exception 'search_profile_revision_conflict' using errcode = 'PT409';
  end if;

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

  foreach key_name in array array['supply_area_min_m2','supply_area_max_m2'] loop
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

  foreach key_name in array array['move_in_start_month','move_in_end_month'] loop
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
    insert into public.user_profiles(user_id) values (owner_id) on conflict (user_id) do nothing;
    select * into strict profile from public.user_profiles p where p.user_id = owner_id for update;
    if profile.revision <> p_base_revision then
      raise exception 'search_profile_revision_conflict' using errcode = 'PT409';
    end if;
  end if;

  insert into public.profile_change_requests(user_id, base_revision, proposed_changes, reason, created_at)
  values (
    owner_id,
    p_base_revision,
    jsonb_build_object('search_conditions', next_conditions),
    normalized_reason,
    clock_timestamp()
  )
  returning id into new_change_id;

  insert into private.search_profile_proposals(
    change_id, user_id, request_id, previous_values, patch_values, request_patch_digest, analysis_id, run_id
  ) values (
    new_change_id, owner_id, p_request_id, previous_values, patch_values, request_digest, p_analysis_id, p_run_id
  );

  return private.search_profile_payload(owner_id, null);
end;
$$;

create function private.decide_search_profile_change(p_change_id uuid, p_decision text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  target_status text;
  profile public.user_profiles%rowtype;
  proposal record;
begin
  perform private.require_notice_run_user(owner_id);
  if p_change_id is null or p_decision is null or p_decision not in ('approve','reject','cancel') then
    raise exception 'invalid_search_profile_decision' using errcode = '22023';
  end if;

  target_status := case p_decision
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    when 'cancel' then 'cancelled'
  end;

  perform pg_advisory_xact_lock(hashtextextended('homecierge:search-profile:' || owner_id::text, 0));
  select * into profile from public.user_profiles p where p.user_id = owner_id for update;

  select pr.id, pr.base_revision, pr.status, sp.patch_values
    into proposal
    from private.search_profile_proposals sp
    join public.profile_change_requests pr on (pr.id, pr.user_id) = (sp.change_id, sp.user_id)
    where sp.user_id = owner_id and sp.request_id = p_change_id
    for update of pr;
  if not found then
    raise exception 'search_profile_change_not_found' using errcode = 'PT404';
  end if;

  -- 같은 결정의 재전송·동시 호출은 멱등하게 현재 상태를 반환하고 다른 결정은 충돌로 거부한다.
  if proposal.status = target_status then
    return private.search_profile_payload(owner_id, null);
  end if;
  if proposal.status <> 'pending' then
    raise exception 'search_profile_decision_conflict' using errcode = 'PT409';
  end if;

  if p_decision = 'approve' then
    if profile.user_id is null or proposal.base_revision <> profile.revision then
      raise exception 'search_profile_revision_conflict' using errcode = 'PT409';
    end if;
    if proposal.patch_values ? 'region_codes' and proposal.patch_values->'region_codes' <> 'null'::jsonb then
      perform private.require_search_profile_regions(proposal.patch_values->'region_codes');
    end if;
  end if;

  perform private.decide_profile_change_core(proposal.id, target_status, true);
  return private.search_profile_payload(owner_id, null);
end;
$$;

create function public.read_search_profile(p_before uuid default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.read_search_profile(p_before);
$$;

create function public.propose_search_profile_change(
  p_request_id uuid,
  p_base_revision bigint,
  p_patch jsonb,
  p_reason text,
  p_analysis_id uuid default null,
  p_run_id uuid default null
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.propose_search_profile_change(
    p_request_id, p_base_revision, p_patch, p_reason, p_analysis_id, p_run_id
  );
$$;

create function public.decide_search_profile_change(p_change_id uuid, p_decision text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.decide_search_profile_change(p_change_id, p_decision);
$$;

revoke all on function
  private.format_search_area(jsonb),
  private.format_search_conditions(jsonb),
  private.normalize_search_profile_reason(text),
  private.normalize_search_profile_patch(jsonb),
  private.require_search_profile_regions(jsonb),
  private.managed_profile_change_visible(uuid,uuid),
  private.decide_profile_change_core(uuid,text,boolean),
  private.decide_profile_change(uuid,text),
  private.search_profile_payload(uuid,bigint),
  private.read_search_profile(uuid),
  private.propose_search_profile_change(uuid,bigint,jsonb,text,uuid,uuid),
  private.decide_search_profile_change(uuid,text),
  public.read_search_profile(uuid),
  public.propose_search_profile_change(uuid,bigint,jsonb,text,uuid,uuid),
  public.decide_search_profile_change(uuid,text)
from public, anon, authenticated, service_role;

grant execute on function
  private.managed_profile_change_visible(uuid,uuid),
  private.decide_profile_change(uuid,text),
  private.read_search_profile(uuid),
  private.propose_search_profile_change(uuid,bigint,jsonb,text,uuid,uuid),
  private.decide_search_profile_change(uuid,text),
  public.read_search_profile(uuid),
  public.propose_search_profile_change(uuid,bigint,jsonb,text,uuid,uuid),
  public.decide_search_profile_change(uuid,text)
to authenticated;

notify pgrst, 'reload schema';
