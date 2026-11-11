-- HomeCierge 기반 스키마. 실제 공고·개인정보·API 인증값을 포함하지 않는다.
-- 공개 API 권한과 행 소유권을 함께 제한한다. 분석 결과는 서버 작업만 기록한다.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

create function private.valid_search_conditions(value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare item text;
begin
  if jsonb_typeof(value) <> 'object' or
     value - array['region_codes','budget_max_won','supply_area_min_m2',
       'supply_area_max_m2','move_in_start_month','move_in_end_month'] <> '{}'::jsonb then
    return false;
  end if;
  if value ? 'region_codes' then
    if jsonb_typeof(value->'region_codes') <> 'array' then return false; end if;
    if exists (select 1 from jsonb_array_elements(value->'region_codes') code
      where jsonb_typeof(code) <> 'string' or code #>> '{}' !~ '^[0-9]{5}$') then return false; end if;
  end if;
  -- 원 단위 금액은 JSON에서 십진 문자열로 보존한다.
  if value ? 'budget_max_won' and (jsonb_typeof(value->'budget_max_won') <> 'string'
      or value->>'budget_max_won' !~ '^(0|[1-9][0-9]*)$') then return false; end if;
  foreach item in array array['supply_area_min_m2','supply_area_max_m2'] loop
    if value ? item and (jsonb_typeof(value->item) <> 'number'
        or (value->>item)::numeric <= 0) then return false; end if;
  end loop;
  if value ? 'supply_area_min_m2' and value ? 'supply_area_max_m2'
      and (value->>'supply_area_min_m2')::numeric > (value->>'supply_area_max_m2')::numeric then return false; end if;
  foreach item in array array['move_in_start_month','move_in_end_month'] loop
    if value ? item and (jsonb_typeof(value->item) <> 'string'
        or value->>item !~ '^[0-9]{4}-(0[1-9]|1[0-2])$') then return false; end if;
  end loop;
  if value ? 'move_in_start_month' and value ? 'move_in_end_month'
      and value->>'move_in_start_month' > value->>'move_in_end_month' then return false; end if;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end;
$$;

create table public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  search_conditions jsonb not null default '{}' check (private.valid_search_conditions(search_conditions)),
  commute_destination text check (char_length(commute_destination) between 1 and 2000),
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '새 대화' check (char_length(title) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id, user_id)
);
create index chats_owner_created_idx on public.chats(user_id, created_at desc, id);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chat_id uuid not null,
  role text not null check (role in ('user','assistant','system')),
  content text not null check (char_length(content) between 1 and 100000),
  created_at timestamptz not null default now(),
  foreign key(chat_id,user_id) references public.chats(id,user_id) on delete cascade
);
create index messages_owner_chat_created_idx on public.chat_messages(user_id,chat_id,created_at,id);
create index messages_chat_owner_idx on public.chat_messages(chat_id,user_id);

create table public.profile_change_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles(user_id) on delete cascade,
  base_revision bigint not null check (base_revision >= 0),
  proposed_changes jsonb not null check (
    jsonb_typeof(proposed_changes) = 'object' and proposed_changes <> '{}'::jsonb
    and proposed_changes - array['search_conditions','commute_destination'] = '{}'::jsonb
    and (not (proposed_changes ? 'search_conditions') or private.valid_search_conditions(proposed_changes->'search_conditions'))
    and (not (proposed_changes ? 'commute_destination') or proposed_changes->'commute_destination' = 'null'::jsonb
      or (jsonb_typeof(proposed_changes->'commute_destination') = 'string'
        and char_length(proposed_changes->>'commute_destination') between 1 and 2000))
  ),
  reason text check (char_length(reason) <= 4000),
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check ((status = 'pending') = (decided_at is null))
);
create index profile_changes_owner_status_idx on public.profile_change_requests(user_id,status,created_at desc);

-- 외부 자료는 메타데이터부터 관리한다. 허용 여부의 기본값은 unknown이다.
create table public.source_registry (
  id text primary key,
  display_name text not null,
  documentation_url text,
  storage_permission text not null default 'unknown' check (storage_permission in ('unknown','allowed','denied')),
  reuse_permission text not null default 'unknown' check (reuse_permission in ('unknown','allowed','denied')),
  llm_permission text not null default 'unknown' check (llm_permission in ('unknown','allowed','denied')),
  export_permission text not null default 'unknown' check (export_permission in ('unknown','allowed','denied')),
  retention_days integer check (retention_days > 0),
  reviewed_at timestamptz
);
create table public.notices (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references public.source_registry(id),
  external_id text not null,
  title text not null,
  notice_kind text not null check (notice_kind in ('new_sale','unranked','remaining','resupply','unknown')),
  official_url text,
  address text,
  region_code text check (region_code ~ '^[0-9]{5}$'),
  verification_status text not null default 'unknown' check (verification_status in ('unknown','verified','conflict')),
  collected_at timestamptz not null,
  unique(source_id,external_id)
);
create index notices_region_idx on public.notices(region_code,id);
create table public.notice_documents (
  id uuid primary key default gen_random_uuid(),
  notice_id uuid not null references public.notices(id) on delete cascade,
  official_url text not null,
  sha256 text check (sha256 ~ '^[a-f0-9]{64}$'),
  edition_label text,
  verification_status text not null default 'unknown' check (verification_status in ('unknown','verified','conflict')),
  collected_at timestamptz not null,
  unique(id,notice_id)
);
create index notice_documents_notice_idx on public.notice_documents(notice_id);
create table public.housing_types (
  id uuid primary key default gen_random_uuid(),
  notice_id uuid not null references public.notices(id) on delete cascade,
  external_type_id text not null,
  label text not null,
  exclusive_area_m2 numeric(12,4) check (exclusive_area_m2 > 0),
  supply_area_m2 numeric(12,4) check (supply_area_m2 > 0),
  supply_area_status text not null default 'unknown' check (supply_area_status in ('unknown','verified','conflict')),
  source_document_id uuid,
  source_page integer check (source_page > 0),
  foreign key(source_document_id,notice_id) references public.notice_documents(id,notice_id),
  check (supply_area_status <> 'verified' or (supply_area_m2 is not null and source_document_id is not null and source_page is not null)),
  unique(notice_id,external_type_id),
  unique(id,notice_id)
);
create index housing_document_notice_idx on public.housing_types(source_document_id,notice_id);

create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chat_id uuid not null,
  notice_id uuid references public.notices(id),
  housing_type_id uuid,
  title text not null default '새 분석' check (char_length(title) between 1 and 200),
  conditions_snapshot jsonb not null default '{}' check (jsonb_typeof(conditions_snapshot) = 'object'),
  status text not null default 'draft' check (status in ('draft','queued','running','partial','completed','failed')),
  rules_version text not null default 'prd-1.0',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(chat_id,user_id) references public.chats(id,user_id) on delete cascade,
  foreign key(housing_type_id,notice_id) references public.housing_types(id,notice_id),
  check (housing_type_id is null or notice_id is not null),
  unique(id,user_id)
);
create index analyses_owner_created_idx on public.analyses(user_id,created_at desc,id);
create index analyses_chat_owner_idx on public.analyses(chat_id,user_id);
create index analyses_notice_idx on public.analyses(notice_id);
create index analyses_housing_notice_idx on public.analyses(housing_type_id,notice_id);

create table public.funding_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  analysis_id uuid not null,
  kind text not null check (kind in ('current','additional')),
  amount_won bigint not null check (amount_won >= 0),
  available_on date not null,
  certainty text not null check (certainty in ('confirmed','expected')),
  note text check (char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(analysis_id,user_id) references public.analyses(id,user_id) on delete cascade
);
create index funding_owner_analysis_idx on public.funding_entries(user_id,analysis_id,available_on);
create index funding_analysis_owner_idx on public.funding_entries(analysis_id,user_id);
create unique index funding_one_current_idx on public.funding_entries(analysis_id) where kind = 'current';

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  analysis_id uuid not null,
  snapshot_version integer not null check (snapshot_version > 0),
  result_snapshot jsonb not null check (jsonb_typeof(result_snapshot) = 'object'),
  conditions_snapshot jsonb not null check (jsonb_typeof(conditions_snapshot) = 'object'),
  sources_snapshot jsonb not null check (jsonb_typeof(sources_snapshot) = 'array'),
  unknowns_snapshot jsonb not null check (jsonb_typeof(unknowns_snapshot) = 'array'),
  queried_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key(analysis_id,user_id) references public.analyses(id,user_id) on delete cascade,
  unique(analysis_id,snapshot_version)
);
create index reports_owner_created_idx on public.reports(user_id,created_at desc,id);
create index reports_analysis_owner_idx on public.reports(analysis_id,user_id);

create table private.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references public.source_registry(id),
  request_scope jsonb not null check (jsonb_typeof(request_scope) = 'object'),
  status text not null check (status in ('pending','collecting','complete','partial','failed')),
  total_count integer check (total_count >= 0),
  collected_count integer not null default 0 check (collected_count >= 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  check (status <> 'complete' or (total_count is not null and total_count = collected_count and completed_at is not null))
);
create index ingestion_source_started_idx on private.ingestion_runs(source_id,started_at desc);
alter table private.ingestion_runs enable row level security;
revoke all on private.ingestion_runs from public, anon, authenticated;
grant all on private.ingestion_runs to service_role;

-- 소유자 테이블은 작업 권한과 사용자 ID를 함께 확인한다.
do $$
declare name text;
begin
  foreach name in array array['user_profiles','chats','chat_messages','profile_change_requests','analyses','funding_entries','reports'] loop
    execute format('alter table public.%I enable row level security', name);
    execute format('revoke all on public.%I from public, anon, authenticated', name);
    execute format('grant select on public.%I to authenticated', name);
    execute format('grant all on public.%I to service_role', name);
    execute format('create policy owner_access on public.%I for all to authenticated using ((select auth.uid()) = user_id and coalesce((select auth.jwt()->>''is_anonymous''),''false'') = ''false'') with check ((select auth.uid()) = user_id and coalesce((select auth.jwt()->>''is_anonymous''),''false'') = ''false'')', name);
  end loop;
  foreach name in array array['source_registry','notices','notice_documents','housing_types'] loop
    execute format('alter table public.%I enable row level security', name);
    execute format('revoke all on public.%I from public, anon, authenticated', name);
    execute format('grant select on public.%I to authenticated', name);
    execute format('grant all on public.%I to service_role', name);
    execute format('create policy signed_in_read on public.%I for select to authenticated using ((select auth.uid()) is not null and coalesce((select auth.jwt()->>''is_anonymous''),''false'') = ''false'')', name);
  end loop;
end;
$$;

grant insert(user_id) on public.user_profiles to authenticated;
grant insert(user_id,title), update(title) on public.chats to authenticated;
grant insert(user_id,chat_id,role,content) on public.chat_messages to authenticated;
-- 클라이언트가 assistant/system 메시지를 생성하지 못하게 한다.
create policy user_message_only on public.chat_messages as restrictive for insert to authenticated with check (role = 'user');
grant insert(user_id,base_revision,proposed_changes,reason) on public.profile_change_requests to authenticated;
grant insert(user_id,chat_id,notice_id,housing_type_id,title,conditions_snapshot) on public.analyses to authenticated;
grant insert(user_id,analysis_id,kind,amount_won,available_on,certainty,note),
  update(kind,amount_won,available_on,certainty,note) on public.funding_entries to authenticated;
-- 개별 삭제 API는 연관 보고서·Storage·백업 계약이 정해진 뒤 추가한다.
-- 따라서 직접 DELETE 권한을 열어 삭제 완료를 가장하지 않는다.

create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end;
$$;
do $$
declare name text;
begin
  foreach name in array array['user_profiles','chats','analyses','funding_entries'] loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function private.set_updated_at()', name);
  end loop;
end;
$$;

-- 직접 UPDATE 권한 없이 명시한 판단만 하나의 트랜잭션으로 반영한다.
create function private.decide_profile_change(request_id uuid, decision text)
returns public.profile_change_requests
language plpgsql security definer set search_path = '' as $$
declare who uuid := auth.uid(); proposal public.profile_change_requests; current_revision bigint;
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
  update public.profile_change_requests set status = decision, decided_at = now()
    where id = proposal.id returning * into proposal;
  return proposal;
end;
$$;
create function public.decide_profile_change(request_id uuid, decision text)
returns public.profile_change_requests language sql security invoker set search_path = ''
as $$ select private.decide_profile_change(request_id, decision); $$;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.valid_search_conditions(jsonb) to authenticated, service_role;
grant execute on function private.decide_profile_change(uuid,text) to authenticated;
revoke all on function public.decide_profile_change(uuid,text) from public, anon, authenticated;
grant execute on function public.decide_profile_change(uuid,text) to authenticated;
