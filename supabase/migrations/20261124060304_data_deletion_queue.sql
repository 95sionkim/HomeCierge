-- D-06/A-56: 내구성 있는 개인자료 삭제 대기열, 계정 삭제, 비공개 업로드 스테이징,
-- 영수증·백업 확인 조회, 서비스 작업자 계약을 추가한다.
-- 개인 데이터와 영수증 원시 식별자는 완료 후 제거·익명화하며, Storage 객체는 DB에서 직접 삭제하지 않는다.

-- UUID v4 형식의 무작위 영수증 식별자만 허용한다.
create function private.valid_deletion_receipt_id(p_receipt uuid)
returns boolean language sql immutable set search_path = '' as $$
  select p_receipt is not null
    and (p_receipt::text) collate "C" ~ '\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z';
$$;

-- analysis-uploads 버킷의 소유자 정규 경로({owner}/{analysis}/{upload}.pdf)만 허용한다.
create function private.valid_deletion_upload_path(p_owner uuid, p_path text)
returns boolean language sql immutable set search_path = '' as $$
  select p_owner is not null
    and p_path is not null
    and p_path collate "C" ~ (
      '\A' || p_owner::text
      || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
      || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf\Z'
    );
$$;

-- 영수증 ID를 솔트로 결합해 소유자·범위·대상 일치 여부를 원시 식별자 없이 대조한다.
create function private.deletion_request_digest(
  p_owner uuid,
  p_receipt uuid,
  p_scope text,
  p_target uuid
) returns bytea language sql immutable set search_path = '' as $$
  select sha256(
    uuid_send(p_receipt)
    || uuid_send(p_owner)
    || convert_to(p_scope || ':' || coalesce(p_target::text, ''), 'UTF8')
  );
$$;

-- 삭제 요청과 비공개 작업 상태. 완료 후에도 공개 영수증 상태 조회가 가능하도록 auth.users와 연쇄 삭제하지 않는다.
create table private.data_deletion_requests (
  receipt_id uuid primary key,
  job_order bigint generated always as identity not null unique,
  scope text not null check (
    scope in ('account','chat','analysis','upload','message','turn','fund','profile','report')
  ),
  status text not null default 'processing' check (status in ('processing','live_deleted')),
  requested_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  backup_verified_at timestamptz,
  -- 처리 중에만 원시 owner_id·target_id를 유지하고 live_deleted 완료 시 NULL로 익명화한다.
  owner_id uuid,
  target_id uuid,
  -- 비계정 완료 영수증의 동일 소유 재시도 수렴과 타인·타대상 재사용 차단에 사용한다.
  -- 계정 삭제 완료 시에는 NULL로 지워 삭제된 계정과의 연결을 남기지 않는다.
  request_digest bytea check (request_digest is null or octet_length(request_digest) = 32),
  attempt_count bigint not null default 0 check (attempt_count >= 0),
  last_claimed_at timestamptz,
  blocked_reason text check (
    blocked_reason is null or blocked_reason in ('foreign_storage_object')
  ),
  blocked_at timestamptz,
  check (private.valid_deletion_receipt_id(receipt_id)),
  check ((status = 'live_deleted') = (completed_at is not null)),
  check (completed_at is null or completed_at >= requested_at),
  check (
    backup_verified_at is null
    or (status = 'live_deleted' and completed_at is not null and backup_verified_at >= completed_at)
  ),
  check (status = 'live_deleted' or owner_id is not null),
  check (status <> 'live_deleted' or (owner_id is null and target_id is null)),
  check (status <> 'live_deleted' or scope <> 'account' or request_digest is null),
  check (status = 'live_deleted' or request_digest is not null),
  check (scope not in ('account','profile') or target_id is null),
  check (status = 'live_deleted' or scope in ('account','profile') or target_id is not null),
  check ((blocked_reason is null) = (blocked_at is null))
);

create index data_deletion_requests_work_idx
  on private.data_deletion_requests(
    (blocked_reason is not null),
    attempt_count,
    last_claimed_at nulls first,
    job_order
  )
  where status = 'processing';

create index data_deletion_requests_owner_pending_idx
  on private.data_deletion_requests(owner_id, job_order)
  where status = 'processing';

alter table private.data_deletion_requests enable row level security;
revoke all on private.data_deletion_requests from public, anon, authenticated, service_role;

-- 계정 삭제가 접수된 계정의 기존 JWT·PostgREST·레거시 RPC·동시 쓰기를 즉시 차단한다.
-- Auth Admin이 auth.users를 하드 삭제하면 이 울타리 행도 함께 연쇄 삭제된다.
create table private.account_deletion_fences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  receipt_id uuid not null unique references private.data_deletion_requests(receipt_id),
  fenced_at timestamptz not null default clock_timestamp(),
  check (private.valid_deletion_receipt_id(receipt_id))
);

alter table private.account_deletion_fences enable row level security;
revoke all on private.account_deletion_fences from public, anon, authenticated, service_role;

-- Storage API로 삭제할 소유자 정규 PDF 경로만 보관한다. 영수증이 live_deleted가 되면 행을 제거한다.
create table private.data_deletion_objects (
  id bigint generated always as identity primary key,
  receipt_id uuid not null references private.data_deletion_requests(receipt_id) on delete cascade,
  owner_id uuid not null,
  bucket_id text not null default 'analysis-uploads' check (bucket_id = 'analysis-uploads'),
  object_path text collate "C" not null,
  staged_at timestamptz not null default clock_timestamp(),
  removed_at timestamptz,
  unique (receipt_id, bucket_id, object_path),
  check (private.valid_deletion_upload_path(owner_id, object_path))
);

create index data_deletion_objects_pending_idx
  on private.data_deletion_objects(receipt_id, object_path)
  where removed_at is null;

create index data_deletion_objects_owner_pending_idx
  on private.data_deletion_objects(owner_id, object_path)
  where removed_at is null;

alter table private.data_deletion_objects enable row level security;
revoke all on private.data_deletion_objects from public, anon, authenticated, service_role;

-- 호출자 본인만 확인하는 무인자 접근 울타리. 다른 사용자 ID 존재 여부를 탐색할 수 없다.
create function private.current_account_access_active()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and exists (select 1 from auth.users u where u.id = auth.uid())
    and not exists (select 1 from private.account_deletion_fences f where f.user_id = auth.uid());
$$;

-- 모든 공개 테이블과 비공개 업로드 버킷에 계정 삭제 울타리를 제한 정책으로 적용한다.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'user_profiles','chats','chat_messages','profile_change_requests',
    'analyses','funding_entries','reports','analysis_input_snapshots','analysis_uploads'
  ] loop
    execute format(
      'create policy account_deletion_fence on public.%I as restrictive for all to authenticated using ((select private.current_account_access_active())) with check ((select private.current_account_access_active()))',
      table_name
    );
  end loop;

  foreach table_name in array array[
    'source_registry','notices','notice_documents','housing_types'
  ] loop
    execute format(
      'create policy account_deletion_fence on public.%I as restrictive for select to authenticated using ((select private.current_account_access_active()))',
      table_name
    );
  end loop;
end;
$$;

create policy analysis_upload_objects_account_fence on storage.objects
  as restrictive for all to authenticated
  using (bucket_id <> 'analysis-uploads' or (select private.current_account_access_active()))
  with check (bucket_id <> 'analysis-uploads' or (select private.current_account_access_active()));

-- Read Committed 동시 트랜잭션에서 삭제 중인 계정의 루트 행이 재생성되지 않도록 auth.users FOR SHARE로 직렬화한다.
create function private.guard_root_account_not_deleting()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- 기존 행 수정은 이미 해당 프로필·채팅을 잠갔다. 삭제도 그 행을 잠그므로
  -- 여기서 Auth 행을 되짚어 잠그면 두 요청이 서로 기다리게 된다.
  if tg_op = 'INSERT' then
    perform 1 from auth.users u where u.id = new.user_id for share;
  end if;
  if exists (select 1 from private.account_deletion_fences f where f.user_id = new.user_id) then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- 자식 테이블과 비공개 카운터는 부모 잠금과 교착을 피하기 위해 auth.users 잠금 없이 울타리만 확인한다.
create function private.guard_child_account_not_deleting()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from private.account_deletion_fences f where f.user_id = new.user_id) then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger guard_user_profiles_not_deleting
  before insert or update on public.user_profiles
  for each row execute function private.guard_root_account_not_deleting();

create trigger guard_chats_not_deleting
  before insert or update on public.chats
  for each row execute function private.guard_root_account_not_deleting();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'chat_messages','profile_change_requests','analyses','funding_entries',
    'reports','analysis_input_snapshots','analysis_uploads'
  ] loop
    execute format(
      'create trigger guard_%I_not_deleting before insert or update on public.%I for each row execute function private.guard_child_account_not_deleting()',
      table_name, table_name
    );
  end loop;
end;
$$;

create trigger guard_regional_news_attempts_not_deleting
  before insert or update on private.regional_news_attempts
  for each row execute function private.guard_child_account_not_deleting();

create trigger guard_commute_attempts_not_deleting
  before insert or update on private.commute_attempts
  for each row execute function private.guard_child_account_not_deleting();

-- 기존 SECURITY DEFINER RPC들도 계정 삭제 울타리를 즉시 따르도록 보강한다.
create or replace function private.analysis_run_owner()
returns uuid language plpgsql stable set search_path = '' as $$
declare owner_id uuid := auth.uid();
begin
  if owner_id is null or coalesce(auth.jwt()->>'is_anonymous','false') <> 'false'
    or not private.current_account_access_active() then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  return owner_id;
end;
$$;

create or replace function private.decide_profile_change_core(request_id uuid, decision text, allow_managed boolean)
returns public.profile_change_requests
language plpgsql security definer set search_path = '' as $$
declare
  who uuid := auth.uid();
  proposal public.profile_change_requests;
  current_revision bigint;
begin
  if who is null or coalesce(auth.jwt()->>'is_anonymous','false') <> 'false'
     or not private.current_account_access_active() then
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

create or replace function private.register_analysis_upload(target_analysis_id uuid, target_upload_id uuid)
returns public.analysis_uploads
language plpgsql security definer set search_path = '' as $$
declare
  caller_id uuid := auth.uid();
  upload public.analysis_uploads;
begin
  if caller_id is null or coalesce(auth.jwt()->>'is_anonymous', 'false') <> 'false'
     or not private.current_account_access_active() then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if target_analysis_id is null or target_upload_id is null then
    raise exception 'analysis_upload_ids_required' using errcode = '22023';
  end if;

  -- 등록과 상위 분석 삭제를 직렬화한다.
  perform 1 from public.analyses
  where id = target_analysis_id and user_id = caller_id
  for key share;
  if not found then
    raise exception 'analysis_not_found' using errcode = 'P0002';
  end if;

  insert into public.analysis_uploads (user_id, analysis_id, id)
  values (caller_id, target_analysis_id, target_upload_id)
  on conflict (user_id, analysis_id, id) do nothing;

  -- 동일한 등록 키는 삭제 처리 중이거나 마쳤어도 다시 활성화하지 않는다.
  select * into upload from public.analysis_uploads
  where user_id = caller_id and analysis_id = target_analysis_id and id = target_upload_id;
  return upload;
end;
$$;

create or replace function private.change_analysis_upload_deletion(
  target_analysis_id uuid, target_upload_id uuid, finalize boolean
)
returns public.analysis_uploads
language plpgsql security definer set search_path = '' as $$
declare
  caller_id uuid := auth.uid();
  upload public.analysis_uploads;
begin
  if caller_id is null or coalesce(auth.jwt()->>'is_anonymous', 'false') <> 'false'
     or not private.current_account_access_active() then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select * into upload from public.analysis_uploads
  where user_id = caller_id and analysis_id = target_analysis_id and id = target_upload_id
  for update;
  if not found then
    raise exception 'analysis_upload_not_found' using errcode = 'P0002';
  end if;

  if finalize then
    if upload.status not in ('deletion_requested', 'deleted') then
      raise exception 'analysis_upload_deletion_required' using errcode = '55000';
    end if;
    -- 파일은 호출자 또는 삭제 작업자가 Storage API로 지운다. 객체가 남아 있으면 완료를 반환하지 않는다.
    if exists (
      select 1 from storage.objects
      where bucket_id = 'analysis-uploads' and name collate "C" = upload.object_path
    ) then
      raise exception 'analysis_upload_object_exists' using errcode = '55000';
    end if;
  end if;

  if upload.status = 'deleted' or (not finalize and upload.status = 'deletion_requested') then
    return upload;
  end if;

  update public.analysis_uploads
  set status = case when finalize then 'deleted' else 'deletion_requested' end
  where user_id = caller_id and analysis_id = target_analysis_id and id = target_upload_id
  returning * into upload;
  return upload;
end;
$$;

create or replace function private.require_notice_run_user(p_owner_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  if p_owner_id is null or coalesce(auth.jwt()->'is_anonymous','false'::jsonb) <> 'false'::jsonb
    or exists (select 1 from private.account_deletion_fences f where f.user_id = p_owner_id)
    or not exists (select 1 from auth.users u where u.id = p_owner_id and u.confirmed_at is not null
      and u.is_anonymous is false and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= statement_timestamp()) for share) then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
end;
$$;

create or replace function private.require_saved_report_read_user()
returns uuid language plpgsql stable set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
begin
  if owner_id is null or coalesce(auth.jwt()->'is_anonymous', 'false'::jsonb) <> 'false'::jsonb
    or exists (select 1 from private.account_deletion_fences f where f.user_id = owner_id)
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
  return owner_id;
end;
$$;

-- 공개 영수증 응답(소유자 ID·대상 ID·이름·파일명·내부 오류를 포함하지 않는다).
create function private.deletion_receipt_payload(p_row private.data_deletion_requests)
returns jsonb language sql immutable set search_path = '' set timezone = 'UTC' as $$
  select jsonb_build_object(
    'receiptId', p_row.receipt_id,
    'scope', p_row.scope,
    'status', p_row.status,
    'requestedAt', p_row.requested_at,
    'completedAt', p_row.completed_at,
    'backup', case
      when p_row.backup_verified_at is not null then jsonb_build_object(
        'status', 'verified',
        'verifiedAt', p_row.backup_verified_at
      )
      else jsonb_build_object('status', 'unverified')
    end
  );
$$;

-- 읽기 전용 삭제 목록·영향 조회에서 확인된 비익명 소유자를 검증한다.
create function private.require_deletion_read_owner()
returns uuid language plpgsql stable set search_path = '' as $$
declare
  caller_id uuid := auth.uid();
begin
  if caller_id is null
    or coalesce(auth.jwt()->'is_anonymous', 'false'::jsonb) <> 'false'::jsonb
    or exists (select 1 from private.account_deletion_fences f where f.user_id = caller_id)
    or not exists (
      select 1 from auth.users u
      where u.id = caller_id
        and u.confirmed_at is not null
        and u.is_anonymous is false
        and u.deleted_at is null
        and (u.banned_until is null or u.banned_until <= statement_timestamp())
    ) then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  return caller_id;
end;
$$;

-- 쓰기 삭제 경로의 공통 첫 자문 잠금(homecierge:data-deletion:<owner>)과 auth.users 잠금을 한 순서로 잡는다.
create function private.lock_deletion_owner(p_for_account boolean default false)
returns uuid language plpgsql set search_path = '' as $$
declare
  caller_id uuid := auth.uid();
  account_ok boolean;
begin
  if caller_id is null
    or coalesce(auth.jwt()->'is_anonymous', 'false'::jsonb) <> 'false'::jsonb then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('homecierge:data-deletion:' || caller_id::text, 0));

  if coalesce(p_for_account, false) then
    select exists (
      select 1 from auth.users u
      where u.id = caller_id
        and u.confirmed_at is not null
        and u.is_anonymous is false
        and u.deleted_at is null
        and (u.banned_until is null or u.banned_until <= statement_timestamp())
      for update
    ) into account_ok;
  else
    select exists (
      select 1 from auth.users u
      where u.id = caller_id
        and u.confirmed_at is not null
        and u.is_anonymous is false
        and u.deleted_at is null
        and (u.banned_until is null or u.banned_until <= statement_timestamp())
      for share
    ) into account_ok;
  end if;

  if not coalesce(account_ok, false)
    or exists (select 1 from private.account_deletion_fences f where f.user_id = caller_id) then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  return caller_id;
end;
$$;

-- 개별·계정 삭제 공통 시작점.
-- 신규 영수증이면 대기 행을 기록하고 NULL을 반환한다.
-- 동일 소유·범위·대상의 멱등 재시도이면 중복 실행 없이 기존 공개 영수증 JSONB를 반환한다.
-- 다른 소유·범위·대상 재사용이나 완료된 계정 영수증 재사용은 PT409로 거부한다.
create function private.begin_data_deletion(
  p_owner uuid,
  p_receipt uuid,
  p_scope text,
  p_target uuid
) returns jsonb language plpgsql set search_path = '' as $$
declare
  now_ts timestamptz := clock_timestamp();
  expected_digest bytea;
  existing private.data_deletion_requests%rowtype;
begin
  if p_owner is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if not private.valid_deletion_receipt_id(p_receipt) then
    raise exception 'invalid_deletion_receipt' using errcode = '22023';
  end if;
  if p_scope is null or p_scope not in (
    'account','chat','analysis','upload','message','turn','fund','profile','report'
  ) then
    raise exception 'invalid_deletion_scope' using errcode = '22023';
  end if;
  if (p_scope in ('account','profile')) <> (p_target is null) then
    raise exception 'invalid_deletion_target' using errcode = '22023';
  end if;

  expected_digest := private.deletion_request_digest(p_owner, p_receipt, p_scope, p_target);

  loop
    insert into private.data_deletion_requests(
      receipt_id, scope, status, requested_at, owner_id, target_id, request_digest
    ) values (
      p_receipt, p_scope, 'processing', now_ts, p_owner, p_target, expected_digest
    )
    on conflict (receipt_id) do nothing;

    if found then
      return null;
    end if;

    select * into existing
      from private.data_deletion_requests r
     where r.receipt_id = p_receipt
     for update;

    if found then
      if existing.scope = p_scope
        and existing.request_digest is not null
        and existing.request_digest = expected_digest
        and (
          existing.status = 'live_deleted'
          or (existing.owner_id = p_owner and existing.target_id is not distinct from p_target)
        ) then
        return private.deletion_receipt_payload(existing);
      end if;
      raise exception 'deletion_receipt_conflict' using errcode = 'PT409';
    end if;
  end loop;
end;
$$;

-- 지정한 분석(및 선택 단일 업로드)의 등록·삭제대기 경로만 정확히 적재하고 등록 행을 deleted tombstone으로 전환한다.
-- storage.objects는 직접 삭제하지 않는다.
create function private.stage_deletion_uploads(
  p_owner uuid,
  p_receipt uuid,
  p_analysis_ids uuid[],
  p_upload_id uuid default null
) returns void language plpgsql set search_path = '' as $$
declare
  job private.data_deletion_requests%rowtype;
  upload_row public.analysis_uploads%rowtype;
begin
  if p_owner is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if not private.valid_deletion_receipt_id(p_receipt) then
    raise exception 'invalid_deletion_receipt' using errcode = '22023';
  end if;

  select * into job
    from private.data_deletion_requests r
   where r.receipt_id = p_receipt
   for update;
  if not found then
    raise exception 'deletion_receipt_not_found' using errcode = 'PT404';
  end if;

  if job.status = 'live_deleted' then
    if p_analysis_ids is not null and cardinality(p_analysis_ids) > 0 and exists (
      select 1
        from public.analysis_uploads u
       where u.user_id = p_owner
         and u.analysis_id = any(p_analysis_ids)
         and (p_upload_id is null or u.id = p_upload_id)
         and u.status <> 'deleted'
    ) then
      raise exception 'deletion_receipt_conflict' using errcode = 'PT409';
    end if;
    return;
  end if;

  if job.owner_id is distinct from p_owner then
    raise exception 'deletion_receipt_conflict' using errcode = 'PT409';
  end if;
  if p_analysis_ids is null or cardinality(p_analysis_ids) = 0 then
    return;
  end if;

  -- Storage 업로드 커밋 트리거(FOR SHARE)와 직렬화하기 위해 결정적 순서로 FOR UPDATE 잠금을 잡는다.
  for upload_row in
    select u.*
      from public.analysis_uploads u
     where u.user_id = p_owner
       and u.analysis_id = any(p_analysis_ids)
       and (p_upload_id is null or u.id = p_upload_id)
     order by u.analysis_id, u.id
     for update
  loop
    if not private.valid_deletion_upload_path(p_owner, upload_row.object_path) then
      raise exception 'invalid_deletion_upload_path' using errcode = 'PT409';
    end if;

    -- 등록·삭제대기 경로와, 이전 단일 삭제 tombstone 중 Storage 객체가 아직 남은 경로만 적재한다.
    if upload_row.status in ('registered', 'deletion_requested')
      or exists (
        select 1
          from storage.objects o
         where o.bucket_id = 'analysis-uploads'
           and o.name collate "C" = upload_row.object_path
      ) then
      insert into private.data_deletion_objects(receipt_id, owner_id, bucket_id, object_path)
      values (p_receipt, p_owner, 'analysis-uploads', upload_row.object_path)
      on conflict (receipt_id, bucket_id, object_path) do nothing;
    end if;

    if upload_row.status <> 'deleted' then
      -- 단일 업로드 삭제는 deleted tombstone을 유지해 재등록을 차단하고,
      -- 상위 분석·대화·계정 삭제 시에는 guard_analysis_upload_cascade가 연쇄 삭제를 허용한다.
      update public.analysis_uploads
         set status = 'deleted'
       where user_id = upload_row.user_id
         and analysis_id = upload_row.analysis_id
         and id = upload_row.id;
    end if;
  end loop;
end;
$$;

-- 남은 비동기 Storage 작업이 없는 비계정 요청을 즉시 live_deleted로 마감하고 익명화한다.
-- 계정 삭제는 별도 Auth Admin 하드 삭제까지 반드시 processing을 유지한다.
create function private.finish_data_deletion_request(p_receipt uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare
  job private.data_deletion_requests%rowtype;
  done_at timestamptz;
begin
  if not private.valid_deletion_receipt_id(p_receipt) then
    raise exception 'invalid_deletion_receipt' using errcode = '22023';
  end if;

  select * into job
    from private.data_deletion_requests r
   where r.receipt_id = p_receipt
   for update;
  if not found then
    raise exception 'deletion_receipt_not_found' using errcode = 'PT404';
  end if;

  if job.status = 'live_deleted' then
    return private.deletion_receipt_payload(job);
  end if;

  if job.scope = 'account' then
    return private.deletion_receipt_payload(job);
  end if;

  if exists (
    select 1
      from private.data_deletion_objects o
     where o.receipt_id = p_receipt
       and o.removed_at is null
  ) then
    return private.deletion_receipt_payload(job);
  end if;

  done_at := greatest(job.requested_at, clock_timestamp());
  delete from private.data_deletion_objects where receipt_id = p_receipt;

  update private.data_deletion_requests
     set status = 'live_deleted',
         completed_at = done_at,
         owner_id = null,
         target_id = null,
         blocked_reason = null,
         blocked_at = null
   where receipt_id = p_receipt
   returning * into job;

  return private.deletion_receipt_payload(job);
end;
$$;

-- Storage 버전에 따라 소유자 열이 하나만 채워진다. 기록된 모든 값이 일치해야 한다.
create function private.deletion_object_owned(p_owner uuid, p_owner_id text, p_legacy_owner uuid)
returns boolean language sql immutable set search_path = '' as $$
  select p_owner is not null and (p_owner_id is not null or p_legacy_owner is not null)
    and (p_owner_id is null or p_owner_id = p_owner::text)
    and (p_legacy_owner is null or p_legacy_owner = p_owner);
$$;

-- 소유자와 연결된 Storage 객체 중 다른 버킷·비정규 경로·소유자 불일치 객체가 있는지 검사한다.
create function private.owner_has_foreign_storage_objects(p_owner uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1
      from storage.objects o
     where (
       o.owner_id = p_owner::text
       or o.owner = p_owner
       or (o.bucket_id = 'analysis-uploads' and o.name collate "C" like (p_owner::text || '/%'))
     )
     and not (
       o.bucket_id = 'analysis-uploads'
       and private.valid_deletion_upload_path(p_owner, o.name)
       and private.deletion_object_owned(p_owner, o.owner_id, o.owner)
     )
  );
$$;

-- 로그인 소유자가 확인 클릭 시 발급한 무작위 v4 영수증으로 계정 삭제를 접수한다.
create function private.request_account_deletion(p_receipt uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller_id uuid := auth.uid();
  account_row record;
  existing_fence_receipt uuid;
  replay jsonb;
  analysis_ids uuid[];
begin
  if caller_id is null or coalesce(auth.jwt()->'is_anonymous', 'false'::jsonb) <> 'false'::jsonb then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if not private.valid_deletion_receipt_id(p_receipt) then
    raise exception 'invalid_deletion_receipt' using errcode = '22023';
  end if;

  -- 개별 삭제와 동일한 첫 자문 잠금 뒤 auth.users FOR UPDATE로 모든 쓰기·세션 경합을 직렬화한다.
  perform pg_advisory_xact_lock(hashtextextended('homecierge:data-deletion:' || caller_id::text, 0));

  select u.id, u.confirmed_at, u.is_anonymous, u.banned_until, u.deleted_at
    into account_row
    from auth.users u
   where u.id = caller_id
   for update;
  if not found then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  -- 이미 계정 삭제가 접수된 소유자의 동일 영수증 재시도는 수렴시키고, 다른 영수증은 차단한다.
  select f.receipt_id into existing_fence_receipt
    from private.account_deletion_fences f
   where f.user_id = caller_id;
  if found then
    if existing_fence_receipt = p_receipt then
      replay := private.begin_data_deletion(caller_id, p_receipt, 'account', null);
      if replay is not null then
        return replay;
      end if;
    end if;
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  if account_row.confirmed_at is null
    or account_row.is_anonymous is not false
    or account_row.deleted_at is not null
    or (account_row.banned_until is not null and account_row.banned_until > statement_timestamp()) then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  -- 타인의 영수증이나 다른 범위·대상에 이미 쓰인 영수증은 여기서 PT409로 거부한다.
  replay := private.begin_data_deletion(caller_id, p_receipt, 'account', null);
  if replay is not null then
    return replay;
  end if;

  -- 부모·분석 행을 결정적 순서로 잠가 진행 중인 분석 작업자와 직렬화한 뒤 업로드를 스테이지한다.
  perform 1 from public.user_profiles p where p.user_id = caller_id for update;
  perform 1 from public.chats c where c.user_id = caller_id order by c.id for update;
  select coalesce(array_agg(a.id order by a.id), '{}'::uuid[])
    into analysis_ids
    from (
      select id
        from public.analyses
       where user_id = caller_id
       order by id
       for update
    ) as a;

  perform private.stage_deletion_uploads(caller_id, p_receipt, analysis_ids, null);

  -- 이전 개별 삭제나 비정상 잔여로 app 버킷에 남은 소유자의 정규 경로 객체도 함께 적재한다.
  insert into private.data_deletion_objects(receipt_id, owner_id, bucket_id, object_path)
  select p_receipt, caller_id, 'analysis-uploads', o.name
    from storage.objects o
   where o.bucket_id = 'analysis-uploads'
     and (
       o.owner_id = caller_id::text
       or o.owner = caller_id
       or o.name collate "C" like (caller_id::text || '/%')
     )
     and private.valid_deletion_upload_path(caller_id, o.name)
     and private.deletion_object_owned(caller_id, o.owner_id, o.owner)
  on conflict (receipt_id, bucket_id, object_path) do nothing;

  -- 개인 앱 데이터를 즉시 원자적으로 삭제한다. 공유 공고·출처·법령과 다른 소유자 자료는 보존한다.
  delete from private.analysis_runs where user_id = caller_id;
  delete from public.chats where user_id = caller_id;
  delete from public.user_profiles where user_id = caller_id;
  delete from private.regional_news_attempts where user_id = caller_id;
  delete from private.commute_attempts where user_id = caller_id;

  -- 같은 트랜잭션(auth.users FOR UPDATE 보유 중) 안에서 계정 접근 울타리와 Auth 차단을 커밋한다.
  insert into private.account_deletion_fences(user_id, receipt_id, fenced_at)
  values (caller_id, p_receipt, clock_timestamp());

  update auth.users
     set banned_until = greatest(
           coalesce(banned_until, '-infinity'::timestamptz),
           clock_timestamp() + interval '100 years'
         )
   where id = caller_id;

  if to_regclass('auth.sessions') is not null
     and pg_catalog.has_table_privilege(current_user, 'auth.sessions', 'DELETE') then
    execute 'delete from auth.sessions where user_id = $1' using caller_id;
  end if;

  return private.finish_data_deletion_request(p_receipt);
end;
$$;

create function public.request_account_deletion(p_receipt uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.request_account_deletion(p_receipt);
$$;

-- 영수증 ID 소유만으로 상태를 조회한다. auth.users 삭제 이후에도 공개 상태와 시각만 반환한다.
create function private.read_deletion_receipt(p_receipt uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  job private.data_deletion_requests%rowtype;
begin
  if not private.valid_deletion_receipt_id(p_receipt) then
    raise exception 'invalid_deletion_receipt' using errcode = '22023';
  end if;

  select * into job
    from private.data_deletion_requests r
   where r.receipt_id = p_receipt;
  if not found then
    raise exception 'deletion_receipt_not_found' using errcode = 'PT404';
  end if;

  return private.deletion_receipt_payload(job);
end;
$$;

-- SQL 표준 RETURN은 생성 시 함수에 연결되어 익명 역할에 private 스키마 접근을 열 필요가 없다.
create function public.read_deletion_receipt(p_receipt uuid)
returns jsonb language sql stable security invoker set search_path = ''
return private.read_deletion_receipt(p_receipt);

-- 서비스 작업자 전용 작업 조회. 최대 50개 정규 경로 배치로 공정하게 반환하고,
-- 계정 Auth 삭제는 app 버킷 전체 부재와 외부 버킷 객체 부재를 확인한 뒤에만 스케줄한다.
create function private.deletion_work(p_receipt uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  max_batch constant integer := 50;
  candidate record;
  job private.data_deletion_requests%rowtype;
  batch_paths text[];
  has_foreign boolean;
  saw_foreign_block boolean := false;
  now_ts timestamptz;
begin
  if p_receipt is not null and not private.valid_deletion_receipt_id(p_receipt) then
    raise exception 'invalid_deletion_receipt' using errcode = '22023';
  end if;

  for candidate in
    select r.receipt_id
      from private.data_deletion_requests r
     where r.status = 'processing'
       and (p_receipt is null or r.receipt_id = p_receipt)
     order by (r.blocked_reason is not null) asc,
              r.attempt_count asc,
              r.last_claimed_at asc nulls first,
              r.job_order asc
  loop
    select * into job
      from private.data_deletion_requests r
     where r.receipt_id = candidate.receipt_id
       and r.status = 'processing'
     for update skip locked;
    if not found then
      continue;
    end if;

    now_ts := clock_timestamp();
    has_foreign := false;

    if job.scope = 'account' then
      -- 계정 삭제 시 app 버킷에 남은 소유자의 정규 경로 객체를 전역 확인해 누락 없이 적재한다.
      insert into private.data_deletion_objects(receipt_id, owner_id, bucket_id, object_path)
      select job.receipt_id, job.owner_id, 'analysis-uploads', so.name
        from storage.objects so
       where so.bucket_id = 'analysis-uploads'
         and (
           so.owner_id = job.owner_id::text
           or so.owner = job.owner_id
           or so.name collate "C" like (job.owner_id::text || '/%')
         )
         and private.valid_deletion_upload_path(job.owner_id, so.name)
         and private.deletion_object_owned(job.owner_id, so.owner_id, so.owner)
      on conflict (receipt_id, bucket_id, object_path)
      do update set removed_at = null
       where private.data_deletion_objects.removed_at is not null;
    end if;

    -- 스테이지된 경로 중 실제 storage.objects 소유가 다른 객체가 있는지 확인한다.
    select exists (
      select 1
        from private.data_deletion_objects o
        join storage.objects so
          on so.bucket_id = o.bucket_id
         and so.name collate "C" = o.object_path
       where o.receipt_id = job.receipt_id
         and o.removed_at is null
         and not (
           private.deletion_object_owned(job.owner_id, so.owner_id, so.owner)
         )
    ) into has_foreign;

    if job.scope = 'account' and private.owner_has_foreign_storage_objects(job.owner_id) then
      has_foreign := true;
    end if;

    -- 소유자가 일치하는 정규 app 버킷 경로만 최대 50건 배치로 선택한다.
    select coalesce(array_agg(p.object_path order by p.object_path collate "C"), '{}'::text[])
      into batch_paths
      from (
        select o.object_path
          from private.data_deletion_objects o
         where o.receipt_id = job.receipt_id
           and o.removed_at is null
           and private.valid_deletion_upload_path(job.owner_id, o.object_path)
           and not exists (
             select 1
               from storage.objects so
              where so.bucket_id = o.bucket_id
                and so.name collate "C" = o.object_path
                and not (
                  private.deletion_object_owned(job.owner_id, so.owner_id, so.owner)
                )
           )
         order by o.object_path collate "C"
         limit max_batch
      ) as p;

    if cardinality(batch_paths) > 0 then
      update private.data_deletion_requests
         set attempt_count = attempt_count + 1,
             last_claimed_at = now_ts,
             blocked_reason = case when has_foreign then blocked_reason else null end,
             blocked_at = case when has_foreign then blocked_at else null end
       where receipt_id = job.receipt_id;

      return jsonb_build_object(
        'receiptId', job.receipt_id,
        'ownerId', job.owner_id,
        'scope', job.scope,
        'paths', to_jsonb(batch_paths),
        'deleteAuth', false
      );
    end if;

    -- 관련 없는 버킷·비정규 경로·소유자 불일치 객체는 절대 삭제 대상에 넣지 않고 차단·보고한다.
    if has_foreign then
      saw_foreign_block := true;
      update private.data_deletion_requests
         set attempt_count = attempt_count + 1,
             last_claimed_at = now_ts,
             blocked_reason = 'foreign_storage_object',
             blocked_at = coalesce(blocked_at, now_ts)
       where receipt_id = job.receipt_id;

      if p_receipt is not null then
        raise exception 'deletion_foreign_storage_object' using errcode = 'PT409';
      end if;
      continue;
    end if;

    if job.scope = 'account' then
      -- Auth 삭제를 허용하기 직전 app 버킷 내 소유자 객체가 전역 0건인지 재확인한다.
      if exists (
        select 1
          from storage.objects so
         where so.bucket_id = 'analysis-uploads'
           and (
             so.owner_id = job.owner_id::text
             or so.owner = job.owner_id
             or so.name collate "C" like (job.owner_id::text || '/%')
           )
      ) then
        continue;
      end if;

      update private.data_deletion_requests
         set attempt_count = attempt_count + 1,
             last_claimed_at = now_ts,
             blocked_reason = null,
             blocked_at = null
       where receipt_id = job.receipt_id;

      return jsonb_build_object(
        'receiptId', job.receipt_id,
        'ownerId', job.owner_id,
        'scope', job.scope,
        'paths', '[]'::jsonb,
        'deleteAuth', true
      );
    end if;

    update private.data_deletion_requests
       set attempt_count = attempt_count + 1,
           last_claimed_at = now_ts,
           blocked_reason = null,
           blocked_at = null
     where receipt_id = job.receipt_id;

    return jsonb_build_object(
      'receiptId', job.receipt_id,
      'ownerId', job.owner_id,
      'scope', job.scope,
      'paths', '[]'::jsonb,
      'deleteAuth', false
    );
  end loop;

  if saw_foreign_block then
    raise exception 'deletion_foreign_storage_object' using errcode = 'PT409';
  end if;
  return null;
end;
$$;

create function public.deletion_work(p_receipt uuid default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.deletion_work(p_receipt);
$$;

-- 서비스 작업자 전용 진행 확인.
-- Storage 카탈로그 부재(및 계정 삭제 시 auth.users 부재)가 확인될 때만 live_deleted로 전이하고 식별자를 익명화한다.
create function private.advance_deletion_work(p_receipt uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.data_deletion_requests%rowtype;
  now_ts timestamptz := clock_timestamp();
  has_foreign boolean := false;
  still_pending boolean := false;
  auth_exists boolean := false;
  done_at timestamptz;
begin
  if not private.valid_deletion_receipt_id(p_receipt) then
    raise exception 'invalid_deletion_receipt' using errcode = '22023';
  end if;

  select * into job
    from private.data_deletion_requests r
   where r.receipt_id = p_receipt
   for update;
  if not found then
    raise exception 'deletion_receipt_not_found' using errcode = 'PT404';
  end if;

  if job.status = 'live_deleted' then
    return private.deletion_receipt_payload(job);
  end if;

  -- Storage 카탈로그에서 부재가 확인된 스테이지 경로만 제거 완료로 표시한다.
  update private.data_deletion_objects o
     set removed_at = now_ts
   where o.receipt_id = p_receipt
     and o.removed_at is null
     and not exists (
       select 1
         from storage.objects so
        where so.bucket_id = o.bucket_id
          and so.name collate "C" = o.object_path
     );

  -- 이미 제거 완료로 표시된 경로라도 카탈로그에 다시 존재하면 미완료로 되돌린다.
  update private.data_deletion_objects o
     set removed_at = null
   where o.receipt_id = p_receipt
     and o.removed_at is not null
     and exists (
       select 1
         from storage.objects so
        where so.bucket_id = o.bucket_id
          and so.name collate "C" = o.object_path
     );

  select exists (
    select 1
      from private.data_deletion_objects o
      join storage.objects so
        on so.bucket_id = o.bucket_id
       and so.name collate "C" = o.object_path
     where o.receipt_id = p_receipt
       and not (
         private.deletion_object_owned(job.owner_id, so.owner_id, so.owner)
       )
  ) into has_foreign;

  select exists (
    select 1
      from private.data_deletion_objects o
     where o.receipt_id = p_receipt
       and o.removed_at is null
  ) into still_pending;

  if job.scope = 'account' then
    if private.owner_has_foreign_storage_objects(job.owner_id) then
      has_foreign := true;
    end if;

    insert into private.data_deletion_objects(receipt_id, owner_id, bucket_id, object_path)
    select p_receipt, job.owner_id, 'analysis-uploads', so.name
      from storage.objects so
     where so.bucket_id = 'analysis-uploads'
       and (
         so.owner_id = job.owner_id::text
         or so.owner = job.owner_id
         or so.name collate "C" like (job.owner_id::text || '/%')
       )
       and private.valid_deletion_upload_path(job.owner_id, so.name)
       and private.deletion_object_owned(job.owner_id, so.owner_id, so.owner)
    on conflict (receipt_id, bucket_id, object_path)
    do update set removed_at = null
     where private.data_deletion_objects.removed_at is not null;

    if exists (
      select 1
        from private.data_deletion_objects o
       where o.receipt_id = p_receipt
         and o.removed_at is null
    ) or exists (
      select 1
        from storage.objects so
       where so.bucket_id = 'analysis-uploads'
         and (
           so.owner_id = job.owner_id::text
           or so.owner = job.owner_id
           or so.name collate "C" like (job.owner_id::text || '/%')
         )
    ) then
      still_pending := true;
    end if;

    select exists (
      select 1 from auth.users u where u.id = job.owner_id
    ) into auth_exists;
  end if;

  if has_foreign then
    update private.data_deletion_requests
       set blocked_reason = 'foreign_storage_object',
           blocked_at = coalesce(blocked_at, now_ts)
     where receipt_id = p_receipt
     returning * into job;
    return private.deletion_receipt_payload(job);
  end if;

  if still_pending or auth_exists then
    update private.data_deletion_requests
       set blocked_reason = null,
           blocked_at = null
     where receipt_id = p_receipt
     returning * into job;
    return private.deletion_receipt_payload(job);
  end if;

  done_at := greatest(job.requested_at, clock_timestamp());
  delete from private.data_deletion_objects where receipt_id = p_receipt;

  update private.data_deletion_requests
     set status = 'live_deleted',
         completed_at = done_at,
         owner_id = null,
         target_id = null,
         request_digest = case when scope = 'account' then null else request_digest end,
         blocked_reason = null,
         blocked_at = null
   where receipt_id = p_receipt
   returning * into job;

  return private.deletion_receipt_payload(job);
end;
$$;

create function public.advance_deletion_work(p_receipt uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.advance_deletion_work(p_receipt);
$$;

-- 서비스 운영자 전용 백업·외부 사본 확인 기록.
-- live_deleted 완료 이후이며 completedAt 이상, DB now() 이하 관측만 수용한다.
create function private.record_deletion_backup_review(
  p_receipt uuid,
  p_verified_at timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.data_deletion_requests%rowtype;
begin
  if not private.valid_deletion_receipt_id(p_receipt) or p_verified_at is null then
    raise exception 'invalid_deletion_backup_review' using errcode = '22023';
  end if;

  select * into job
    from private.data_deletion_requests r
   where r.receipt_id = p_receipt
   for update;
  if not found then
    raise exception 'deletion_receipt_not_found' using errcode = 'PT404';
  end if;

  if job.status <> 'live_deleted' or job.completed_at is null then
    raise exception 'deletion_not_completed' using errcode = 'PT409';
  end if;

  if p_verified_at < job.completed_at or p_verified_at > greatest(job.completed_at, now()) then
    raise exception 'invalid_deletion_backup_review' using errcode = '22023';
  end if;

  if job.backup_verified_at is not null then
    if job.backup_verified_at = p_verified_at then
      return private.deletion_receipt_payload(job);
    end if;
    raise exception 'deletion_backup_review_conflict' using errcode = 'PT409';
  end if;

  update private.data_deletion_requests
     set backup_verified_at = p_verified_at
   where receipt_id = p_receipt
   returning * into job;

  return private.deletion_receipt_payload(job);
end;
$$;

create function public.record_deletion_backup_review(
  p_receipt uuid,
  p_verified_at timestamptz
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.record_deletion_backup_review(p_receipt, p_verified_at);
$$;

-- 최소 권한 원칙: 모든 신규·갱신 함수의 기본 권한을 회수한 뒤 필요한 역할에만 부여한다.
revoke all on function
  private.valid_deletion_receipt_id(uuid),
  private.valid_deletion_upload_path(uuid,text),
  private.deletion_request_digest(uuid,uuid,text,uuid),
  private.current_account_access_active(),
  private.guard_root_account_not_deleting(),
  private.guard_child_account_not_deleting(),
  private.analysis_run_owner(),
  private.decide_profile_change_core(uuid,text,boolean),
  private.register_analysis_upload(uuid,uuid),
  private.change_analysis_upload_deletion(uuid,uuid,boolean),
  private.require_notice_run_user(uuid),
  private.require_saved_report_read_user(),
  private.deletion_receipt_payload(private.data_deletion_requests),
  private.require_deletion_read_owner(),
  private.lock_deletion_owner(boolean),
  private.begin_data_deletion(uuid,uuid,text,uuid),
  private.stage_deletion_uploads(uuid,uuid,uuid[],uuid),
  private.finish_data_deletion_request(uuid),
  private.deletion_object_owned(uuid,text,uuid),
  private.owner_has_foreign_storage_objects(uuid),
  private.request_account_deletion(uuid),
  public.request_account_deletion(uuid),
  private.read_deletion_receipt(uuid),
  public.read_deletion_receipt(uuid),
  private.deletion_work(uuid),
  public.deletion_work(uuid),
  private.advance_deletion_work(uuid),
  public.advance_deletion_work(uuid),
  private.record_deletion_backup_review(uuid,timestamptz),
  public.record_deletion_backup_review(uuid,timestamptz)
from public, anon, authenticated, service_role;

grant execute on function
  private.current_account_access_active(),
  private.register_analysis_upload(uuid,uuid),
  private.change_analysis_upload_deletion(uuid,uuid,boolean),
  private.request_account_deletion(uuid),
  public.request_account_deletion(uuid),
  private.read_deletion_receipt(uuid),
  public.read_deletion_receipt(uuid)
to authenticated;

grant execute on function
  private.read_deletion_receipt(uuid),
  public.read_deletion_receipt(uuid)
to anon;

grant execute on function
  private.deletion_work(uuid),
  public.deletion_work(uuid),
  private.advance_deletion_work(uuid),
  public.advance_deletion_work(uuid),
  private.record_deletion_backup_review(uuid,timestamptz),
  public.record_deletion_backup_review(uuid,timestamptz)
to service_role;

notify pgrst, 'reload schema';
