-- 실행 행이 발행 대기 기록도 맡는다. 다른 전송 단계 없이 DB에서 직접 인수한다.
alter table public.analyses add column latest_run_id uuid,
  drop constraint analyses_status_check,
  add constraint analyses_status_check
    check (status in ('draft','queued','running','partial','completed','failed','input_ready','cancelled'));

create table private.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null,
  user_id uuid not null,
  idempotency_key uuid not null,
  submission_order bigint generated always as identity,
  input jsonb not null,
  conditions_snapshot jsonb not null,
  profile_revision bigint,
  rules_version text not null,
  notice_id uuid,
  housing_type_id uuid,
  basis_date date not null,
  status text not null default 'queued'
    check (status in ('queued','running','retry_wait','finished','failed','cancelled')),
  attempt integer not null default 0 check (attempt between 0 and 3),
  submitted_at timestamptz not null,
  finished_at timestamptz,
  -- 대기에는 다음 인수 가능 시각, 실행 중에는 임대 만료 시각이다.
  next_claim_at timestamptz,
  lease_token uuid,
  snapshot_id uuid references public.analysis_input_snapshots(id),
  error_code text check (error_code in ('run_internal_error','run_deadline_exceeded')),
  foreign key (analysis_id,user_id) references public.analyses(id,user_id) on delete cascade,
  unique (analysis_id,idempotency_key),
  check ((next_claim_at is not null) = (status in ('queued','running','retry_wait'))),
  check ((lease_token is not null) = (status = 'running')),
  check ((finished_at is not null) = (status in ('finished','failed','cancelled'))),
  check ((snapshot_id is not null) = (status = 'finished')),
  check ((error_code is not null) = (status = 'failed')),
  check (status <> 'retry_wait' or attempt < 3)
);
create index analysis_runs_latest_idx on private.analysis_runs(analysis_id,user_id,submission_order desc);
create index analysis_runs_snapshot_idx on private.analysis_runs(snapshot_id) where snapshot_id is not null;
create index analysis_runs_recent_idx on private.analysis_runs(user_id,submitted_at);
create index analysis_runs_claim_idx on private.analysis_runs(next_claim_at,submission_order)
  where next_claim_at is not null;
alter table private.analysis_runs enable row level security;
revoke all on private.analysis_runs from public, anon, authenticated, service_role;

create function private.analysis_run_operation(job private.analysis_runs)
returns jsonb language sql stable set search_path = '' set timezone = 'UTC' as $$
  select jsonb_build_object('runId',job.id,'analysisId',job.analysis_id,'status',job.status,
    'attempt',job.attempt,'submittedAt',job.submitted_at,'finishedAt',job.finished_at,
    'input',job.input,'snapshotId',job.snapshot_id,'errorCode',job.error_code);
$$;

create function private.sync_analysis_run_status()
returns trigger language plpgsql set search_path = '' as $$
declare summary text := case new.status
  when 'retry_wait' then 'queued' when 'finished' then 'input_ready' else new.status end;
begin
  -- 부모를 잠근 상태에서 가장 최근 접수의 상태와 실행 ID를 함께 투영한다.
  update public.analyses a set status = summary, latest_run_id = new.id
  where (a.id,a.user_id) = (new.analysis_id,new.user_id)
    and (a.status,a.latest_run_id) is distinct from (summary,new.id)
    and not exists (select 1 from private.analysis_runs r
      where (r.analysis_id,r.user_id) = (new.analysis_id,new.user_id)
        and r.submission_order > new.submission_order);
  return null;
end;
$$;
create trigger sync_analysis_run_status after insert or update of status on private.analysis_runs
  for each row execute function private.sync_analysis_run_status();

-- BE-03 독립 수집은 유지하며 실행 ID를 캡처 키로 쓰는 신규 저장은 finish RPC에 한정한다.
create function private.reject_unfenced_run_capture()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from private.analysis_runs r where r.id = new.capture_key) then
    raise exception 'analysis_run_fence_required' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger guard_analysis_run_capture before insert on public.analysis_input_snapshots
  for each row when (not pg_catalog.has_table_privilege(current_user,'private.analysis_runs','UPDATE'))
  execute function private.reject_unfenced_run_capture();

create function private.analysis_run_owner()
returns uuid language plpgsql stable set search_path = '' as $$
declare owner_id uuid := auth.uid();
begin
  if owner_id is null or coalesce(auth.jwt()->>'is_anonymous','false') <> 'false'
    or not exists (select 1 from auth.users u where u.id = owner_id) then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  return owner_id;
end;
$$;

-- 공개 합성 재생 예시의 요청 식별값이다. 원응답과 정규화 본문은 여기에 두지 않는다.
create function private.synthetic_ingestion_run_request()
returns jsonb language sql immutable set search_path = '' as $$
  select '{"noticeSource":"applyhome_apt",
    "target":{"houseManageNo":"9900000001","noticeNo":"9900000042","edition":"synthetic-edition-1"},
    "asOf":"2026-11-10","start":"2026-10-10","end":"2026-10-31",
    "requestRegionCodes":["99999"],"tradeKinds":["sale","presale_right","occupancy_right"],"pageSize":2}'::jsonb;
$$;

create function private.enqueue_analysis_run(p_analysis_id uuid,p_idempotency_key uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := private.analysis_run_owner();
  fixed public.analyses%rowtype;
  job private.analysis_runs%rowtype;
  source_snapshot_id uuid;
  basis date := (private.synthetic_ingestion_run_request()->>'asOf')::date;
  submitted timestamptz;
begin
  if p_analysis_id is null or p_idempotency_key is null then
    raise exception 'analysis_run_ids_required' using errcode = '22023';
  end if;
  if p_input is distinct from '{"kind":"synthetic","fixture":"ingestion-v0"}'::jsonb then
    if not coalesce(private.ingestion_v0_object(p_input,array['kind','snapshotId'])
      and p_input->>'kind' = 'snapshot'
      and jsonb_typeof(p_input->'snapshotId') = 'string'
      and p_input->>'snapshotId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false) then
      raise exception 'invalid_analysis_run_input' using errcode = '22023';
    end if;
    source_snapshot_id := (p_input->>'snapshotId')::uuid;
    p_input := jsonb_build_object('kind','snapshot','snapshotId',source_snapshot_id);
  end if;

  -- 같은 계정의 접수를 직렬화한 뒤 부모 → 실행 → 캡처 순으로 잠근다.
  perform pg_advisory_xact_lock(hashtextextended('homecierge:analysis-runs:' || owner_id::text,0));
  select * into fixed from public.analyses a
    where (a.id,a.user_id) = (p_analysis_id,owner_id) for no key update;
  if not found then
    raise exception 'analysis_not_found' using errcode = 'PT404';
  end if;
  select * into job from private.analysis_runs r
    where (r.analysis_id,r.idempotency_key) = (p_analysis_id,p_idempotency_key);
  if found then
    if job.input is distinct from p_input then
      raise exception 'analysis_run_idempotency_conflict' using errcode = 'PT409';
    end if;
    return private.analysis_run_operation(job);
  end if;

  if source_snapshot_id is not null then
    select s.conditions_snapshot,s.rules_version,s.notice_id,s.housing_type_id,s.as_of
      into fixed.conditions_snapshot,fixed.rules_version,fixed.notice_id,fixed.housing_type_id,basis
      from public.analysis_input_snapshots s
      where (s.id,s.analysis_id,s.user_id) = (source_snapshot_id,p_analysis_id,owner_id) for key share;
    if not found then
      raise exception 'analysis_snapshot_not_found' using errcode = 'PT404';
    end if;
  end if;

  -- 최근 60초의 신규 접수 최대 12건은 로컬 실행 실험값이다.
  submitted := clock_timestamp();
  if (select count(*) from private.analysis_runs r
    where r.user_id = owner_id and r.submitted_at > submitted - interval '60 seconds') >= 12 then
    raise exception 'analysis_run_rate_limited' using errcode = 'PT429';
  end if;
  insert into private.analysis_runs(analysis_id,user_id,idempotency_key,input,conditions_snapshot,profile_revision,
    rules_version,notice_id,housing_type_id,basis_date,submitted_at,next_claim_at)
  values (p_analysis_id,owner_id,p_idempotency_key,p_input,fixed.conditions_snapshot,
    (select p.revision from public.user_profiles p where p.user_id = owner_id),
    fixed.rules_version,fixed.notice_id,fixed.housing_type_id,basis,submitted,submitted)
  returning * into job;
  return private.analysis_run_operation(job);
end;
$$;

create function private.read_analysis_run(p_analysis_id uuid,p_run_id uuid,p_cancel boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := private.analysis_run_owner();
  job private.analysis_runs%rowtype;
begin
  if p_analysis_id is null or p_run_id is null or p_cancel is null then
    raise exception 'invalid_analysis_run_lookup' using errcode = '22023';
  end if;
  if p_cancel then
    perform 1 from public.analyses a where (a.id,a.user_id) = (p_analysis_id,owner_id) for no key update;
    if not found then
      raise exception 'analysis_run_not_found' using errcode = 'PT404';
    end if;
  end if;
  select * into job from private.analysis_runs r where (r.id,r.analysis_id,r.user_id) = (p_run_id,p_analysis_id,owner_id);
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;
  if not p_cancel or job.status = 'cancelled' then
    return private.analysis_run_operation(job);
  end if;
  if job.status in ('finished','failed') then
    raise exception 'analysis_run_already_terminal' using errcode = 'PT409';
  end if;
  update private.analysis_runs set status = 'cancelled', finished_at = clock_timestamp(),
    next_claim_at = null, lease_token = null where id = job.id returning * into job;
  return private.analysis_run_operation(job);
end;
$$;

create function public.enqueue_analysis_run(p_analysis_id uuid,p_idempotency_key uuid,p_input jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.enqueue_analysis_run(p_analysis_id,p_idempotency_key,p_input);
$$;
create function public.get_analysis_run(p_analysis_id uuid,p_run_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.read_analysis_run(p_analysis_id,p_run_id,false);
$$;
create function public.cancel_analysis_run(p_analysis_id uuid,p_run_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.read_analysis_run(p_analysis_id,p_run_id,true);
$$;

create function private.check_analysis_run_lease(p_lease_seconds integer)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if p_lease_seconds is null or p_lease_seconds not between 1 and 300 then
    raise exception 'invalid_analysis_run_lease' using errcode = '22023';
  end if;
end;
$$;

-- 3회 인수, 1~300초 임대, 실패 후 1·2초 재시도는 로컬 실행 실험값이다.
create function public.claim_analysis_run(p_lease_seconds integer,p_run_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  candidate record;
  job private.analysis_runs%rowtype;
  scanned_at timestamptz := clock_timestamp();
  locked_at timestamptz;
begin
  perform private.check_analysis_run_lease(p_lease_seconds);
  for candidate in
    select r.id,r.analysis_id,r.user_id from private.analysis_runs r
    where r.next_claim_at <= scanned_at and (p_run_id is null or r.id = p_run_id)
    order by (r.attempt = 3) desc,r.next_claim_at,r.submission_order
  loop
    perform 1 from public.analyses a where (a.id,a.user_id) = (candidate.analysis_id,candidate.user_id)
      for no key update skip locked;
    if not found then
      continue;
    end if;
    select * into job from private.analysis_runs r where r.id = candidate.id for update skip locked;
    locked_at := clock_timestamp();
    if not found or job.next_claim_at is null or job.next_claim_at > locked_at then
      continue;
    end if;
    if job.attempt = 3 then
      update private.analysis_runs set status = 'failed', error_code = 'run_deadline_exceeded',
        finished_at = locked_at, next_claim_at = null, lease_token = null where id = job.id;
      continue;
    end if;

    update private.analysis_runs set status = 'running', attempt = attempt + 1, lease_token = gen_random_uuid(),
      next_claim_at = locked_at + make_interval(secs => p_lease_seconds)
      where id = job.id returning * into job;
    return jsonb_build_object('runId',job.id,'analysisId',job.analysis_id,'userId',job.user_id,
      'input',job.input,'generation',job.attempt,'leaseToken',job.lease_token);
  end loop;
  return null;
end;
$$;

create function private.lock_leased_analysis_run(p_run_id uuid,p_generation integer,p_lease_token uuid)
returns private.analysis_runs language plpgsql set search_path = '' as $$
declare job private.analysis_runs%rowtype;
begin
  perform 1 from public.analyses a join private.analysis_runs r on (a.id,a.user_id) = (r.analysis_id,r.user_id)
    where r.id = p_run_id for no key update of a;
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;
  select * into job from private.analysis_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;
  if job.status <> 'running' or job.attempt is distinct from p_generation
    or job.lease_token is distinct from p_lease_token or job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;
  return job;
end;
$$;

create function public.renew_analysis_run(p_run_id uuid,p_generation integer,p_lease_token uuid,p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare job private.analysis_runs%rowtype;
begin
  perform private.check_analysis_run_lease(p_lease_seconds);
  job := private.lock_leased_analysis_run(p_run_id,p_generation,p_lease_token);
  update private.analysis_runs set next_claim_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    where id = job.id returning * into job;
  return private.analysis_run_operation(job);
end;
$$;

create function public.finish_analysis_run(p_run_id uuid,p_generation integer,p_lease_token uuid,p_input jsonb,p_result jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id,p_generation,p_lease_token);
  captured_id uuid;
  finished timestamptz;
begin
  if job.input->>'kind' = 'snapshot' then
    if nullif(p_input,'null'::jsonb) is not null or nullif(p_result,'null'::jsonb) is not null then
      raise exception 'unexpected_analysis_run_payload' using errcode = '22023';
    end if;
    select s.id into captured_id from public.analysis_input_snapshots s
      where (s.id,s.analysis_id,s.user_id) = ((job.input->>'snapshotId')::uuid,job.analysis_id,job.user_id)
      for key share;
    if not found then
      raise exception 'analysis_run_snapshot_missing' using errcode = '22023';
    end if;
  else
    if p_input is distinct from private.synthetic_ingestion_run_request()
      or p_result->>'dataOrigin' is distinct from 'synthetic' then
      raise exception 'invalid_synthetic_run_payload' using errcode = '22023';
    end if;
    -- BE-03은 잠근 부모에서 조건과 대상을 읽는다. 접수 때와 달라지면 캡처하지 않는다.
    if not exists (select 1 from public.analyses a where (a.id,a.user_id) = (job.analysis_id,job.user_id)
      and (a.conditions_snapshot,a.rules_version,a.notice_id,a.housing_type_id) is not distinct from
          (job.conditions_snapshot,job.rules_version,job.notice_id,job.housing_type_id)) then
      raise exception 'analysis_run_input_changed' using errcode = '22023';
    end if;
    captured_id := public.save_ingestion_snapshot(job.user_id,job.analysis_id,job.id,p_input,p_result);
  end if;

  -- 캡처 잠금이나 정규화 저장이 지연되면 방금 시도한 저장도 같은 트랜잭션에서 롤백한다.
  finished := clock_timestamp();
  if job.next_claim_at <= finished then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;
  update private.analysis_runs set status = 'finished', snapshot_id = captured_id,
    finished_at = finished, next_claim_at = null, lease_token = null where id = job.id returning * into job;
  return private.analysis_run_operation(job);
end;
$$;

create function public.fail_analysis_run(p_run_id uuid,p_generation integer,p_lease_token uuid,p_retryable boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype;
  failed_at timestamptz;
  retry boolean;
begin
  if p_retryable is null then
    raise exception 'analysis_run_retryable_required' using errcode = '22023';
  end if;
  job := private.lock_leased_analysis_run(p_run_id,p_generation,p_lease_token);
  failed_at := clock_timestamp();
  retry := p_retryable and job.attempt < 3;
  update private.analysis_runs set status = case when retry then 'retry_wait' else 'failed' end,
    next_claim_at = case when retry then failed_at + make_interval(secs => job.attempt) end,
    finished_at = case when not retry then failed_at end, lease_token = null,
    error_code = case when not retry then 'run_internal_error' end where id = job.id returning * into job;
  return private.analysis_run_operation(job);
end;
$$;

revoke all on function private.analysis_run_operation(private.analysis_runs), private.sync_analysis_run_status(),
  private.reject_unfenced_run_capture(), private.analysis_run_owner(), private.synthetic_ingestion_run_request(),
  private.check_analysis_run_lease(integer), private.lock_leased_analysis_run(uuid,integer,uuid),
  private.enqueue_analysis_run(uuid,uuid,jsonb), private.read_analysis_run(uuid,uuid,boolean),
  public.enqueue_analysis_run(uuid,uuid,jsonb), public.get_analysis_run(uuid,uuid), public.cancel_analysis_run(uuid,uuid),
  public.claim_analysis_run(integer,uuid), public.renew_analysis_run(uuid,integer,uuid,integer),
  public.finish_analysis_run(uuid,integer,uuid,jsonb,jsonb), public.fail_analysis_run(uuid,integer,uuid,boolean)
from public, anon, authenticated, service_role;
grant execute on function private.enqueue_analysis_run(uuid,uuid,jsonb), private.read_analysis_run(uuid,uuid,boolean),
  public.enqueue_analysis_run(uuid,uuid,jsonb), public.get_analysis_run(uuid,uuid), public.cancel_analysis_run(uuid,uuid)
to authenticated;
grant execute on function public.claim_analysis_run(integer,uuid), public.renew_analysis_run(uuid,integer,uuid,integer),
  public.finish_analysis_run(uuid,integer,uuid,jsonb,jsonb), public.fail_analysis_run(uuid,integer,uuid,boolean)
to service_role;
