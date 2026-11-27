-- D-06 / A-56: 개인 자료 개별 목록 조회·삭제 영향 미리보기·개별 삭제 RPC와 복원 방지 키를 추가한다.
-- 선행 삭제 대기열의 private.begin_data_deletion / stage_deletion_uploads /
-- finish_data_deletion_request 계약을 재사용하며 storage.objects 메타데이터를 직접 삭제하지 않는다.

-- 삭제된 요청 키가 지연 재시도로 복원되지 않도록 소유자별 불투명 UUID만 최소 보관한다.
-- 계정 삭제 시 auth.users 연쇄 삭제로 함께 제거되며 개인 텍스트·금액·경로는 저장하지 않는다.
create table private.retired_deletion_keys (
  user_id uuid not null references auth.users(id) on delete cascade,
  key_kind text not null check (key_kind in (
    'workspace',
    'analysis_run',
    'chat_turn',
    'funding_entry',
    'profile_proposal',
    'upload',
    'snapshot'
  )),
  scope_id uuid not null,
  request_key uuid not null,
  primary key (user_id, key_kind, scope_id, request_key)
);

alter table private.retired_deletion_keys enable row level security;
revoke all on private.retired_deletion_keys from public, anon, authenticated, service_role;

create function private.guard_retired_workspace_key()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from private.retired_deletion_keys k
    where (k.user_id, k.key_kind, k.scope_id, k.request_key)
        = (new.user_id, 'workspace', new.user_id, new.directory_request_key)
  ) then
    raise exception 'workspace_request_retired' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger guard_retired_workspace_key
  before insert on public.analyses
  for each row when (new.directory_request_key is not null)
  execute function private.guard_retired_workspace_key();

create function private.guard_retired_analysis_run_key()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from private.retired_deletion_keys k
    where (k.user_id, k.key_kind, k.scope_id, k.request_key)
        = (new.user_id, 'analysis_run', new.analysis_id, new.idempotency_key)
  ) then
    raise exception 'analysis_run_request_retired' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger guard_retired_analysis_run_key
  before insert on private.analysis_runs
  for each row execute function private.guard_retired_analysis_run_key();

create function private.guard_retired_chat_turn_key()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from private.retired_deletion_keys k
    where (k.user_id, k.key_kind, k.scope_id, k.request_key)
        = (new.user_id, 'chat_turn', new.base_run_id, new.request_id)
  ) then
    raise exception 'analysis_chat_request_retired' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger guard_retired_chat_turn_key
  before insert on private.analysis_chat_turns
  for each row execute function private.guard_retired_chat_turn_key();

create function private.guard_retired_funding_entry_key()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from private.retired_deletion_keys k
    where (k.user_id, k.key_kind, k.scope_id, k.request_key)
        = (new.user_id, 'funding_entry', new.analysis_id, new.request_key)
  ) then
    raise exception 'funding_request_retired' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger guard_retired_funding_entry_key
  before insert on public.funding_entries
  for each row when (new.request_key is not null)
  execute function private.guard_retired_funding_entry_key();

create function private.guard_retired_profile_proposal_key()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from private.retired_deletion_keys k
    where (k.user_id, k.key_kind, k.scope_id, k.request_key)
        = (new.user_id, 'profile_proposal', new.user_id, new.request_id)
  ) then
    raise exception 'search_profile_request_retired' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger guard_retired_profile_proposal_key
  before insert on private.search_profile_proposals
  for each row execute function private.guard_retired_profile_proposal_key();

-- 단일 업로드는 analysis_uploads.status='deleted' tombstone이 재활성화를 막는다.
-- tombstone이 제거된 상태에서 동일 ID 재등록이 시도되면 보조 차단한다.
create function private.guard_retired_upload_key()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.analysis_uploads u
    where (u.user_id, u.analysis_id, u.id) = (new.user_id, new.analysis_id, new.id)
  ) and exists (
    select 1 from private.retired_deletion_keys k
    where (k.user_id, k.key_kind, k.scope_id, k.request_key)
        = (new.user_id, 'upload', new.analysis_id, new.id)
  ) then
    raise exception 'upload_request_retired' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger guard_retired_upload_key
  before insert on public.analysis_uploads
  for each row execute function private.guard_retired_upload_key();

create function private.guard_retired_snapshot_key()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from private.retired_deletion_keys k
    where (k.user_id, k.key_kind, k.scope_id, k.request_key)
        = (new.user_id, 'snapshot', new.analysis_id, new.capture_key)
  ) then
    raise exception 'snapshot_capture_retired' using errcode = 'PT409';
  end if;
  return new;
end;
$$;

create trigger guard_retired_snapshot_key
  before insert on public.analysis_input_snapshots
  for each row execute function private.guard_retired_snapshot_key();

create function private.purge_retired_keys_on_account_fence()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from private.retired_deletion_keys where user_id = new.user_id;
  return null;
end;
$$;

create trigger purge_retired_keys_on_account_fence
  after insert on private.account_deletion_fences
  for each row execute function private.purge_retired_keys_on_account_fence();

create function private.deletion_text_preview(p_text text, p_fallback text, p_max integer default 80)
returns text language plpgsql immutable set search_path = '' as $$
declare
  compact text;
begin
  if p_text is null then
    return p_fallback;
  end if;
  compact := btrim(regexp_replace(p_text, '[[:space:]]+', ' ', 'g'));
  if compact = '' then
    return p_fallback;
  end if;
  if char_length(compact) > p_max then
    return left(compact, greatest(1, p_max - 1)) || '…';
  end if;
  return compact;
end;
$$;

create function private.jsonb_mentions_uuid(p_value jsonb, p_target uuid)
returns boolean language sql immutable set search_path = '' as $$
  select case
    when p_value is null or p_target is null then false
    else position(lower(p_target::text) in lower(p_value::text)) > 0
  end;
$$;

create function private.legacy_report_references_any_uuid(p_report public.reports, p_ids uuid[])
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(cardinality(p_ids) > 0, false) and exists (
    select 1 from unnest(p_ids) as t(id)
    where private.jsonb_mentions_uuid(p_report.result_snapshot, t.id)
       or private.jsonb_mentions_uuid(p_report.conditions_snapshot, t.id)
       or private.jsonb_mentions_uuid(p_report.sources_snapshot, t.id)
       or private.jsonb_mentions_uuid(p_report.unknowns_snapshot, t.id)
  );
$$;

create function private.upload_doc_id_matches(
  p_doc_id text,
  p_user_id uuid,
  p_analysis_id uuid,
  p_upload_id uuid
) returns boolean language sql immutable set search_path = '' as $$
  select p_doc_id is not null and (
    lower(p_doc_id) = lower(p_upload_id::text)
    or p_doc_id = (p_user_id::text || '/' || p_analysis_id::text || '/' || p_upload_id::text || '.pdf')
    or lower(p_doc_id) = 'upload:' || lower(p_upload_id::text)
    or lower(p_doc_id) = 'upload/' || lower(p_upload_id::text)
  );
$$;

-- 실행 일부를 제거한 뒤 살아남은 분석의 latest_run_id와 요약 상태를 가장 최근 잔여 실행과 맞춘다.
create function private.resync_analysis_latest_run(p_owner_id uuid, p_analysis_id uuid)
returns void language plpgsql set search_path = '' as $$
declare
  latest private.analysis_runs%rowtype;
  next_status text := 'draft';
begin
  select r.* into latest
  from private.analysis_runs r
  where (r.analysis_id, r.user_id) = (p_analysis_id, p_owner_id)
  order by r.submission_order desc
  limit 1;

  if found then
    next_status := case latest.status
      when 'retry_wait' then 'queued'
      when 'finished' then 'input_ready'
      else latest.status
    end;
    update public.analyses a
      set latest_run_id = latest.id,
          status = next_status
      where (a.id, a.user_id) = (p_analysis_id, p_owner_id)
        and (a.latest_run_id, a.status) is distinct from (latest.id, next_status);
  else
    update public.analyses a
      set latest_run_id = null,
          status = 'draft'
      where (a.id, a.user_id) = (p_analysis_id, p_owner_id)
        and (a.latest_run_id, a.status) is distinct from (null::uuid, 'draft');
  end if;
end;
$$;

-- 삭제한 레거시 보고서 버전도 단조 증가 카운터에 반영해 이후 보고서 버전 충돌이나 재사용을 막는다.
create function private.bump_analysis_report_version(p_analysis_id uuid, p_min_version integer)
returns void language plpgsql set search_path = '' as $$
begin
  if p_analysis_id is null or p_min_version is null or p_min_version <= 0 then
    return;
  end if;
  insert into private.analysis_report_versions(analysis_id, last_version)
    values (p_analysis_id, p_min_version)
    on conflict (analysis_id) do update
      set last_version = greatest(private.analysis_report_versions.last_version, excluded.last_version);
end;
$$;

-- 대화 턴 1건과 승인된 기간 변경으로 파생된 모든 후속 실행·턴·보고서·프로필 제안 범위를 계산한다.
create function private.resolve_turn_deletion_scope(
  p_owner_id uuid,
  p_turn_id uuid,
  out analysis_id uuid,
  out base_run_id uuid,
  out descendant_run_ids uuid[],
  out affected_turn_ids uuid[],
  out managed_report_ids uuid[],
  out legacy_report_ids uuid[],
  out profile_change_ids uuid[]
) returns record language plpgsql stable set search_path = '' as $$
declare
  turn_row private.analysis_chat_turns%rowtype;
  earliest_descendant_at timestamptz;
  ref_ids uuid[];
begin
  select t.* into turn_row
  from private.analysis_chat_turns t
  where t.id = p_turn_id and t.user_id = p_owner_id;
  if not found then
    raise exception 'deletion_target_not_found' using errcode = 'PT404';
  end if;

  analysis_id := turn_row.analysis_id;
  base_run_id := turn_row.base_run_id;

  with recursive descendant_runs(run_id) as (
    select turn_row.result_run_id
    where turn_row.result_run_id is not null
    union
    select child.result_run_id
    from descendant_runs dr
    join private.analysis_chat_turns child
      on child.base_run_id = dr.run_id
      and child.user_id = p_owner_id
    where child.result_run_id is not null
  )
  select coalesce(array_agg(dr.run_id order by dr.run_id), '{}'::uuid[])
    into descendant_run_ids
    from descendant_runs dr;

  select coalesce(array_agg(tid order by tid), '{}'::uuid[])
    into affected_turn_ids
    from (
      select p_turn_id as tid
      union
      select t.id as tid
      from private.analysis_chat_turns t
      where t.user_id = p_owner_id
        and t.base_run_id = any(descendant_run_ids)
    ) as turns;

  if cardinality(descendant_run_ids) > 0 then
    select coalesce(array_agg(sr.report_id order by sr.report_id), '{}'::uuid[])
      into managed_report_ids
      from private.saved_analysis_reports sr
      where sr.user_id = p_owner_id
        and sr.run_id = any(descendant_run_ids);

    select coalesce(array_agg(sp.change_id order by sp.change_id), '{}'::uuid[])
      into profile_change_ids
      from private.search_profile_proposals sp
      where sp.user_id = p_owner_id
        and sp.run_id = any(descendant_run_ids);

    select min(r.submitted_at)
      into earliest_descendant_at
      from private.analysis_runs r
      where r.user_id = p_owner_id
        and r.id = any(descendant_run_ids);
  else
    managed_report_ids := '{}'::uuid[];
    profile_change_ids := '{}'::uuid[];
    earliest_descendant_at := null;
  end if;

  ref_ids := affected_turn_ids || descendant_run_ids;

  -- 승인된 후속 실행 이후 같은 분석에 저장돼 출처 실행을 판별할 수 없는 레거시 보고서나
  -- 턴·후속 실행 ID를 명시 참조하는 레거시 보고서를 함께 영향 범위에 포함한다.
  select coalesce(array_agg(r.id order by r.id), '{}'::uuid[])
    into legacy_report_ids
    from public.reports r
    where r.user_id = p_owner_id
      and not exists (
        select 1 from private.saved_analysis_reports sr
        where sr.report_id = r.id and sr.user_id = p_owner_id
      )
      and (
        private.legacy_report_references_any_uuid(r, ref_ids)
        or (
          earliest_descendant_at is not null
          and r.analysis_id = turn_row.analysis_id
          and r.created_at >= earliest_descendant_at
        )
      );
end;
$$;

-- 개별 자금 항목이 실제로 영향을 미치는 관리 보고서(금액 제거)와 레거시 보고서(파기)를 판별한다.
create function private.resolve_fund_deletion_scope(
  p_owner_id uuid,
  p_fund_id uuid,
  out analysis_id uuid,
  out request_key uuid,
  out managed_report_ids uuid[],
  out legacy_report_ids uuid[]
) returns record language plpgsql stable set search_path = '' as $$
declare
  fund_row public.funding_entries%rowtype;
begin
  select f.* into fund_row
  from public.funding_entries f
  where f.id = p_fund_id and f.user_id = p_owner_id;
  if not found then
    raise exception 'deletion_target_not_found' using errcode = 'PT404';
  end if;

  analysis_id := fund_row.analysis_id;
  request_key := fund_row.request_key;

  select coalesce(array_agg(rid order by rid), '{}'::uuid[])
    into managed_report_ids
    from (
      select ref.report_id as rid
      from private.saved_report_funding_refs ref
      where ref.user_id = p_owner_id
        and ref.funding_entry_id = p_fund_id
      union
      select sr.report_id as rid
      from private.saved_analysis_reports sr
      where sr.user_id = p_owner_id
        and sr.funding_value is not null
        and exists (
          select 1
          from jsonb_array_elements(coalesce(sr.funding_value->'funds', '[]'::jsonb)) as item(val)
          where item.val->>'id' = p_fund_id::text
        )
    ) as affected;

  -- 구조가 고정되지 않은 레거시 보고서는 같은 분석의 사본이거나 해당 자금 ID를 명시 참조하면
  -- 잔여 금액 보존을 막기 위해 영향 범위에 포함해 파기한다.
  select coalesce(array_agg(r.id order by r.id), '{}'::uuid[])
    into legacy_report_ids
    from public.reports r
    where r.user_id = p_owner_id
      and not exists (
        select 1 from private.saved_analysis_reports sr
        where sr.report_id = r.id and sr.user_id = p_owner_id
      )
      and (
        r.analysis_id = fund_row.analysis_id
        or private.legacy_report_references_any_uuid(r, array[p_fund_id])
      );
end;
$$;

-- 업로드 1건의 직접 바인딩 파생 스냅샷·실행·턴·보고서·프로필 제안을 판별한다.
-- 어떤 업로드에서 파생됐는지 특정할 수 없는 미바인딩 레거시 사본이 있으면 축소된 건수 대신 PT409로 명시 차단한다.
create function private.resolve_upload_deletion_scope(
  p_owner_id uuid,
  p_upload_id uuid,
  out analysis_id uuid,
  out object_path text,
  out bound_snapshot_ids uuid[],
  out affected_run_ids uuid[],
  out affected_turn_ids uuid[],
  out managed_report_ids uuid[],
  out legacy_report_ids uuid[],
  out profile_change_ids uuid[]
) returns record language plpgsql stable set search_path = '' as $$
declare
  matched_count integer;
  upload_row public.analysis_uploads%rowtype;
  bound_snapshot_texts text[];
  ref_ids uuid[];
begin
  select count(*)::integer into matched_count
  from public.analysis_uploads u
  where u.user_id = p_owner_id
    and u.id = p_upload_id
    and u.status <> 'deleted';

  if matched_count = 0 then
    raise exception 'deletion_target_not_found' using errcode = 'PT404';
  end if;
  if matched_count > 1 then
    raise exception 'deletion_upload_scope_unverified'
      using errcode = 'PT409',
            hint = '동일한 업로드 ID가 여러 분석에 등록되어 있어 분석 단위 삭제를 사용해야 합니다.';
  end if;

  select u.* into strict upload_row
  from public.analysis_uploads u
  where u.user_id = p_owner_id
    and u.id = p_upload_id
    and u.status <> 'deleted';

  analysis_id := upload_row.analysis_id;
  object_path := upload_row.object_path;

  -- 동일 분석의 스냅샷 중 이 업로드에 바인딩된 항목을 수집한다.
  select coalesce(array_agg(s.id order by s.id), '{}'::uuid[])
    into bound_snapshot_ids
    from public.analysis_input_snapshots s
    where (s.analysis_id, s.user_id) = (upload_row.analysis_id, p_owner_id)
      and (
        exists (
          select 1
          from jsonb_array_elements(coalesce(s.result_snapshot#>'{catalog,documents}', '[]'::jsonb)) as d(val)
          where d.val->>'source' = 'upload'
            and private.upload_doc_id_matches(d.val->>'id', p_owner_id, upload_row.analysis_id, p_upload_id)
        )
        or private.jsonb_mentions_uuid(s.conditions_snapshot, p_upload_id)
        or private.jsonb_mentions_uuid(s.input_snapshot, p_upload_id)
      );

  -- 이 업로드에 바인딩되지 않았지만 source='upload' 문서가 다른 등록 업로드에도 특정되지 않으면 차단한다.
  if exists (
    select 1
    from public.analysis_input_snapshots s
    where (s.analysis_id, s.user_id) = (upload_row.analysis_id, p_owner_id)
      and not (s.id = any(bound_snapshot_ids))
      and exists (
        select 1
        from jsonb_array_elements(coalesce(s.result_snapshot#>'{catalog,documents}', '[]'::jsonb)) as d(val)
        where d.val->>'source' = 'upload'
          and not exists (
            select 1
            from public.analysis_uploads other_u
            where other_u.user_id = p_owner_id
              and other_u.analysis_id = upload_row.analysis_id
              and other_u.id <> p_upload_id
              and private.upload_doc_id_matches(d.val->>'id', p_owner_id, upload_row.analysis_id, other_u.id)
          )
      )
  ) then
    raise exception 'deletion_upload_scope_unverified'
      using errcode = 'PT409',
            detail = 'analysis_id=' || upload_row.analysis_id::text,
            hint = '업로드와 연결이 확인되지 않은 이전 수집본이 있어 해당 분석 단위로 삭제 영향을 확인해 주세요.';
  end if;

  -- 레거시 보고서가 업로드 출처를 표시하지만 특정 업로드 UUID에 바인딩되지 않은 경우에도 명시 차단한다.
  if exists (
    select 1
    from public.reports r
    where (r.analysis_id, r.user_id) = (upload_row.analysis_id, p_owner_id)
      and not exists (
        select 1 from private.saved_analysis_reports sr
        where sr.report_id = r.id and sr.user_id = p_owner_id
      )
      and not private.legacy_report_references_any_uuid(r, array[p_upload_id])
      and (
        r.sources_snapshot @> '["user_upload"]'::jsonb
        or r.sources_snapshot @> '["upload"]'::jsonb
        or jsonb_path_exists(r.result_snapshot, 'lax $.** ? (@.type() == "object" && @.source == "upload")')
      )
      and not exists (
        select 1
        from public.analysis_uploads other_u
        where other_u.user_id = p_owner_id
          and other_u.analysis_id = upload_row.analysis_id
          and other_u.id <> p_upload_id
          and private.legacy_report_references_any_uuid(r, array[other_u.id])
      )
  ) then
    raise exception 'deletion_upload_scope_unverified'
      using errcode = 'PT409',
            detail = 'analysis_id=' || upload_row.analysis_id::text,
            hint = '업로드 출처 연결이 확인되지 않은 이전 보고서가 있어 해당 분석 단위로 삭제 영향을 확인해 주세요.';
  end if;

  bound_snapshot_texts := array(select s_id::text from unnest(bound_snapshot_ids) as t(s_id));

  with recursive derived_runs(run_id) as (
    select r.id
    from private.analysis_runs r
    where (r.analysis_id, r.user_id) = (upload_row.analysis_id, p_owner_id)
      and (
        r.snapshot_id = any(bound_snapshot_ids)
        or (r.input->>'kind' = 'snapshot' and r.input->>'snapshotId' = any(bound_snapshot_texts))
        or r.id in (
          select s.capture_key
          from public.analysis_input_snapshots s
          where s.id = any(bound_snapshot_ids)
        )
        or private.jsonb_mentions_uuid(r.conditions_snapshot, p_upload_id)
      )
    union
    select child.result_run_id
    from derived_runs dr
    join private.analysis_chat_turns child
      on child.base_run_id = dr.run_id
      and child.user_id = p_owner_id
    where child.result_run_id is not null
  )
  select coalesce(array_agg(dr.run_id order by dr.run_id), '{}'::uuid[])
    into affected_run_ids
    from derived_runs dr;

  select coalesce(array_agg(t.id order by t.id), '{}'::uuid[])
    into affected_turn_ids
    from private.analysis_chat_turns t
    where (t.analysis_id, t.user_id) = (upload_row.analysis_id, p_owner_id)
      and (
        t.base_run_id = any(affected_run_ids)
        or t.result_run_id = any(affected_run_ids)
      );

  select coalesce(array_agg(sr.report_id order by sr.report_id), '{}'::uuid[])
    into managed_report_ids
    from private.saved_analysis_reports sr
    where (sr.analysis_id, sr.user_id) = (upload_row.analysis_id, p_owner_id)
      and (
        sr.snapshot_id = any(bound_snapshot_ids)
        or sr.run_id = any(affected_run_ids)
      );

  select coalesce(array_agg(sp.change_id order by sp.change_id), '{}'::uuid[])
    into profile_change_ids
    from private.search_profile_proposals sp
    where sp.user_id = p_owner_id
      and sp.run_id = any(affected_run_ids);

  ref_ids := array[p_upload_id] || bound_snapshot_ids || affected_run_ids;

  select coalesce(array_agg(r.id order by r.id), '{}'::uuid[])
    into legacy_report_ids
    from public.reports r
    where r.user_id = p_owner_id
      and not exists (
        select 1 from private.saved_analysis_reports sr
        where sr.report_id = r.id and sr.user_id = p_owner_id
      )
      and private.legacy_report_references_any_uuid(r, ref_ids);
end;
$$;

-- 확인된 소유자의 삭제 가능 항목 목록을 최신순·안정 UUID 커서·최대 30건으로 반환한다.
create function private.list_deletion_items(p_kind text, p_before uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_owner_id uuid := private.require_deletion_read_owner();
  cursor_ts timestamptz;
  cursor_order bigint;
  payload jsonb;
begin
  if p_kind is null or p_kind not in ('chat','analysis','message','turn','fund','upload','report') then
    raise exception 'invalid_deletion_kind' using errcode = '22023';
  end if;

  if p_kind = 'chat' then
    if p_before is not null then
      select c.created_at into cursor_ts
      from public.chats c
      where c.user_id = v_owner_id and c.id = p_before;
      if not found then
        raise exception 'deletion_cursor_not_found' using errcode = 'PT404';
      end if;
    end if;

    with fetched as (
      select
        c.id,
        c.title,
        c.created_at,
        (select count(*)::integer from public.analyses a where (a.chat_id, a.user_id) = (c.id, c.user_id)) as analysis_count,
        (select count(*)::integer from public.chat_messages m where (m.chat_id, m.user_id) = (c.id, c.user_id)) as message_count
      from public.chats c
      where c.user_id = v_owner_id
        and (p_before is null or (c.created_at, c.id) < (cursor_ts, p_before))
      order by c.created_at desc, c.id desc
      limit 31
    ),
    page as (
      select * from fetched order by created_at desc, id desc limit 30
    )
    select jsonb_build_object(
      'items', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', w.id,
              'label', private.deletion_text_preview(w.title, '대화', 80),
              'detail', '분석 ' || w.analysis_count || '건 · 메시지 ' || w.message_count || '건'
            )
            order by w.created_at desc, w.id desc
          )
          from page w
        ),
        '[]'::jsonb
      ),
      'nextCursor', case
        when (select count(*) > 30 from fetched) then (
          select w.id from page w order by w.created_at asc, w.id asc limit 1
        )
        else null
      end
    ) into payload;
    return payload;

  elsif p_kind = 'analysis' then
    if p_before is not null then
      select a.created_at into cursor_ts
      from public.analyses a
      where a.user_id = v_owner_id and a.id = p_before;
      if not found then
        raise exception 'deletion_cursor_not_found' using errcode = 'PT404';
      end if;
    end if;

    with fetched as (
      select a.id, a.title, a.status, a.created_at, c.title as chat_title
      from public.analyses a
      join public.chats c on (c.id, c.user_id) = (a.chat_id, a.user_id)
      where a.user_id = v_owner_id
        and (p_before is null or (a.created_at, a.id) < (cursor_ts, p_before))
      order by a.created_at desc, a.id desc
      limit 31
    ),
    page as (
      select * from fetched order by created_at desc, id desc limit 30
    )
    select jsonb_build_object(
      'items', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', w.id,
              'label', private.deletion_text_preview(w.title, '분석', 80),
              'detail', private.deletion_text_preview(w.chat_title, '대화', 48) || ' · ' || w.status
            )
            order by w.created_at desc, w.id desc
          )
          from page w
        ),
        '[]'::jsonb
      ),
      'nextCursor', case
        when (select count(*) > 30 from fetched) then (
          select w.id from page w order by w.created_at asc, w.id asc limit 1
        )
        else null
      end
    ) into payload;
    return payload;

  elsif p_kind = 'message' then
    if p_before is not null then
      select m.created_at into cursor_ts
      from public.chat_messages m
      where m.user_id = v_owner_id and m.id = p_before;
      if not found then
        raise exception 'deletion_cursor_not_found' using errcode = 'PT404';
      end if;
    end if;

    with fetched as (
      select m.id, m.role, m.content, m.created_at, c.title as chat_title
      from public.chat_messages m
      join public.chats c on (c.id, c.user_id) = (m.chat_id, m.user_id)
      where m.user_id = v_owner_id
        and (p_before is null or (m.created_at, m.id) < (cursor_ts, p_before))
      order by m.created_at desc, m.id desc
      limit 31
    ),
    page as (
      select * from fetched order by created_at desc, id desc limit 30
    )
    select jsonb_build_object(
      'items', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', w.id,
              'label', private.deletion_text_preview(w.content, '메시지', 80),
              'detail', (
                case w.role
                  when 'user' then '사용자'
                  when 'assistant' then '안내'
                  when 'system' then '시스템'
                  else w.role
                end
              ) || ' · ' || private.deletion_text_preview(w.chat_title, '대화', 48)
            )
            order by w.created_at desc, w.id desc
          )
          from page w
        ),
        '[]'::jsonb
      ),
      'nextCursor', case
        when (select count(*) > 30 from fetched) then (
          select w.id from page w order by w.created_at asc, w.id asc limit 1
        )
        else null
      end
    ) into payload;
    return payload;

  elsif p_kind = 'turn' then
    if p_before is not null then
      select t.turn_order into cursor_order
      from private.analysis_chat_turns t
      where t.user_id = v_owner_id and t.id = p_before;
      if not found then
        raise exception 'deletion_cursor_not_found' using errcode = 'PT404';
      end if;
    end if;

    with fetched as (
      select
        t.id,
        t.turn_order,
        t.message,
        t.intent,
        t.proposed_start,
        t.proposed_end,
        t.proposal_status,
        a.title as analysis_title
      from private.analysis_chat_turns t
      join public.analyses a on (a.id, a.user_id) = (t.analysis_id, t.user_id)
      where t.user_id = v_owner_id
        and (p_before is null or (t.turn_order, t.id) < (cursor_order, p_before))
      order by t.turn_order desc, t.id desc
      limit 31
    ),
    page as (
      select * from fetched order by turn_order desc, id desc limit 30
    )
    select jsonb_build_object(
      'items', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', w.id,
              'label', private.deletion_text_preview(w.message, '비교 대화', 80),
              'detail', private.deletion_text_preview(w.analysis_title, '분석', 48) || ' · ' || (
                case
                  when w.intent = 'change_period' then
                    '기간 변경 ' || to_char(w.proposed_start, 'YYYY-MM-DD') || '~'
                    || to_char(w.proposed_end, 'YYYY-MM-DD') || ' (' || w.proposal_status || ')'
                  else w.intent
                end
              )
            )
            order by w.turn_order desc, w.id desc
          )
          from page w
        ),
        '[]'::jsonb
      ),
      'nextCursor', case
        when (select count(*) > 30 from fetched) then (
          select w.id from page w order by w.turn_order asc, w.id asc limit 1
        )
        else null
      end
    ) into payload;
    return payload;

  elsif p_kind = 'fund' then
    if p_before is not null then
      select f.created_at into cursor_ts
      from public.funding_entries f
      where f.user_id = v_owner_id and f.id = p_before;
      if not found then
        raise exception 'deletion_cursor_not_found' using errcode = 'PT404';
      end if;
    end if;

    with fetched as (
      select
        f.id,
        f.kind,
        f.amount_won,
        f.available_on,
        f.certainty,
        f.created_at,
        a.title as analysis_title
      from public.funding_entries f
      join public.analyses a on (a.id, a.user_id) = (f.analysis_id, f.user_id)
      where f.user_id = v_owner_id
        and (p_before is null or (f.created_at, f.id) < (cursor_ts, p_before))
      order by f.created_at desc, f.id desc
      limit 31
    ),
    page as (
      select * from fetched order by created_at desc, id desc limit 30
    )
    select jsonb_build_object(
      'items', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', w.id,
              'label', (
                case w.kind
                  when 'current' then '보유 자금'
                  when 'additional' then '추가 자금'
                  else w.kind
                end
              ) || ' ' || w.amount_won::text || '원',
              'detail', to_char(w.available_on, 'YYYY-MM-DD') || ' · ' || (
                case w.certainty
                  when 'confirmed' then '확정'
                  when 'expected' then '예상'
                  else w.certainty
                end
              ) || ' · ' || private.deletion_text_preview(w.analysis_title, '분석', 48)
            )
            order by w.created_at desc, w.id desc
          )
          from page w
        ),
        '[]'::jsonb
      ),
      'nextCursor', case
        when (select count(*) > 30 from fetched) then (
          select w.id from page w order by w.created_at asc, w.id asc limit 1
        )
        else null
      end
    ) into payload;
    return payload;

  elsif p_kind = 'upload' then
    if p_before is not null then
      select max(a.created_at) into cursor_ts
      from public.analysis_uploads u
      join public.analyses a on (a.id, a.user_id) = (u.analysis_id, u.user_id)
      where u.user_id = v_owner_id
        and u.id = p_before
        and u.status <> 'deleted';
      if cursor_ts is null then
        raise exception 'deletion_cursor_not_found' using errcode = 'PT404';
      end if;
    end if;

    with grouped as (
      select
        u.id,
        max(a.created_at) as sort_created_at,
        count(*)::integer as row_count,
        min(a.title) as analysis_title,
        bool_or(u.status = 'deletion_requested') as has_deletion_requested
      from public.analysis_uploads u
      join public.analyses a on (a.id, a.user_id) = (u.analysis_id, u.user_id)
      where u.user_id = v_owner_id
        and u.status <> 'deleted'
      group by u.id
    ),
    fetched as (
      select *
      from grouped g
      where p_before is null or (g.sort_created_at, g.id) < (cursor_ts, p_before)
      order by g.sort_created_at desc, g.id desc
      limit 31
    ),
    page as (
      select * from fetched order by sort_created_at desc, id desc limit 30
    )
    select jsonb_build_object(
      'items', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', w.id,
              'label', case
                when w.row_count > 1 then '업로드 PDF (복수 분석 중복)'
                else '업로드 PDF · ' || private.deletion_text_preview(w.analysis_title, '분석', 48)
              end,
              'detail', case
                when w.row_count > 1 then w.row_count::text || '개 분석에 동일 ID 등록 · 분석 단위 삭제 필요'
                when w.has_deletion_requested then '삭제 대기 중'
                else '등록됨'
              end
            )
            order by w.sort_created_at desc, w.id desc
          )
          from page w
        ),
        '[]'::jsonb
      ),
      'nextCursor', case
        when (select count(*) > 30 from fetched) then (
          select w.id from page w order by w.sort_created_at asc, w.id asc limit 1
        )
        else null
      end
    ) into payload;
    return payload;

  else
    -- p_kind = 'report': 관리 보고서와 이전 형식(public.reports 단독) 보고서를 모두 포함한다.
    if p_before is not null then
      select r.created_at into cursor_ts
      from public.reports r
      where r.user_id = v_owner_id and r.id = p_before;
      if not found then
        raise exception 'deletion_cursor_not_found' using errcode = 'PT404';
      end if;
    end if;

    with fetched as (
      select
        r.id,
        r.snapshot_version,
        r.created_at,
        a.title as analysis_title,
        (sr.report_id is not null) as is_managed,
        case
          when sr.report_id is not null
            and sr.comparison_value is not null
            and private.report_sources_allowed(sr.data_origin = 'collected', sr.comparison_sources, false)
          then coalesce(
            nullif(btrim(sr.comparison_identity->>'title'), ''),
            case
              when jsonb_typeof(sr.comparison_value#>'{target,name}') = 'string'
                and btrim(sr.comparison_value#>>'{target,name}') <> ''
                and char_length(btrim(sr.comparison_value#>>'{target,name}')) <= 200
                and (sr.comparison_value#>>'{target,name}') !~ '[[:cntrl:]]'
              then btrim(sr.comparison_value#>>'{target,name}')
            end
          )
          else null
        end as visible_notice_title
      from public.reports r
      join public.analyses a on (a.id, a.user_id) = (r.analysis_id, r.user_id)
      left join private.saved_analysis_reports sr
        on (sr.report_id, sr.analysis_id, sr.user_id) = (r.id, r.analysis_id, r.user_id)
      where r.user_id = v_owner_id
        and (p_before is null or (r.created_at, r.id) < (cursor_ts, p_before))
      order by r.created_at desc, r.id desc
      limit 31
    ),
    page as (
      select * from fetched order by created_at desc, id desc limit 30
    )
    select jsonb_build_object(
      'items', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', w.id,
              'label', case
                when w.is_managed then
                  private.deletion_text_preview(coalesce(w.visible_notice_title, w.analysis_title), '저장 보고서', 64)
                  || ' (v' || w.snapshot_version || ')'
                else
                  private.deletion_text_preview(w.analysis_title, '이전 보고서', 56)
                  || ' (이전 보고서 v' || w.snapshot_version || ')'
              end,
              'detail', case
                when w.is_managed then
                  private.deletion_text_preview(w.analysis_title, '분석', 48)
                  || ' · ' || to_char(w.created_at at time zone 'UTC', 'YYYY-MM-DD')
                else
                  '이전 형식 보고서 · ' || to_char(w.created_at at time zone 'UTC', 'YYYY-MM-DD')
              end
            )
            order by w.created_at desc, w.id desc
          )
          from page w
        ),
        '[]'::jsonb
      ),
      'nextCursor', case
        when (select count(*) > 30 from fetched) then (
          select w.id from page w order by w.created_at asc, w.id asc limit 1
        )
        else null
      end
    ) into payload;
    return payload;
  end if;
end;
$$;

-- 부작용 없이 실제 삭제·갱신 영향 건수를 계산해 반환한다. account 미리보기까지 지원한다.
create function private.read_deletion_impact(p_scope text, p_target uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_owner_id uuid := private.require_deletion_read_owner();
  c_chats integer := 0;
  c_messages integer := 0;
  c_analyses integer := 0;
  c_runs integer := 0;
  c_turns integer := 0;
  c_funds integer := 0;
  c_reports integer := 0;
  c_uploads integer := 0;
  c_profile_changes integer := 0;
  c_reports_deleted integer := 0;
  c_reports_updated integer := 0;
  c_storage_objects integer := 0;
  v_profile_cleared boolean := false;

  affected_analyses uuid[] := '{}'::uuid[];
  affected_runs uuid[] := '{}'::uuid[];
  affected_funds uuid[] := '{}'::uuid[];
  cross_legacy_reports integer := 0;
  turn_scope record;
  fund_scope record;
  upload_scope record;
begin
  if p_scope is null or p_scope not in (
    'chat','analysis','message','turn','fund','upload','report','profile','account'
  ) then
    raise exception 'invalid_deletion_scope' using errcode = '22023';
  end if;

  if p_scope in ('profile','account') then
    if p_target is not null then
      raise exception 'invalid_deletion_scope' using errcode = '22023';
    end if;
  else
    if p_target is null then
      raise exception 'invalid_deletion_scope' using errcode = '22023';
    end if;
  end if;

  if p_scope = 'chat' then
    if not exists (select 1 from public.chats c where c.id = p_target and c.user_id = v_owner_id) then
      raise exception 'deletion_target_not_found' using errcode = 'PT404';
    end if;

    c_chats := 1;
    select count(*)::integer into c_messages
      from public.chat_messages m where (m.chat_id, m.user_id) = (p_target, v_owner_id);
    select coalesce(array_agg(a.id order by a.id), '{}'::uuid[]) into affected_analyses
      from public.analyses a where (a.chat_id, a.user_id) = (p_target, v_owner_id);
    c_analyses := cardinality(affected_analyses);

    if c_analyses > 0 then
      select coalesce(array_agg(r.id order by r.id), '{}'::uuid[]) into affected_runs
        from private.analysis_runs r where r.user_id = v_owner_id and r.analysis_id = any(affected_analyses);
      c_runs := cardinality(affected_runs);

      select count(*)::integer into c_turns
        from private.analysis_chat_turns t where t.user_id = v_owner_id and t.analysis_id = any(affected_analyses);

      select coalesce(array_agg(f.id order by f.id), '{}'::uuid[]) into affected_funds
        from public.funding_entries f where f.user_id = v_owner_id and f.analysis_id = any(affected_analyses);
      c_funds := cardinality(affected_funds);

      select count(*)::integer into c_reports_deleted
        from public.reports r where r.user_id = v_owner_id and r.analysis_id = any(affected_analyses);

      if c_funds > 0 then
        select count(*)::integer into cross_legacy_reports
          from public.reports r
          where r.user_id = v_owner_id
            and not (r.analysis_id = any(affected_analyses))
            and not exists (
              select 1 from private.saved_analysis_reports sr
              where sr.report_id = r.id and sr.user_id = v_owner_id
            )
            and private.legacy_report_references_any_uuid(r, affected_funds);
        c_reports_deleted := c_reports_deleted + cross_legacy_reports;
      end if;
      c_reports := c_reports_deleted;

      select count(*)::integer into c_uploads
        from public.analysis_uploads u
        where u.user_id = v_owner_id and u.analysis_id = any(affected_analyses) and u.status <> 'deleted';

      select count(*)::integer into c_storage_objects
        from public.analysis_uploads u
        join storage.objects o
          on o.bucket_id = 'analysis-uploads' and o.name collate "C" = u.object_path
        where u.user_id = v_owner_id and u.analysis_id = any(affected_analyses);

      select count(*)::integer into c_profile_changes
        from private.search_profile_proposals sp
        where sp.user_id = v_owner_id
          and (sp.analysis_id = any(affected_analyses) or sp.run_id = any(affected_runs));
    end if;

  elsif p_scope = 'analysis' then
    if not exists (select 1 from public.analyses a where a.id = p_target and a.user_id = v_owner_id) then
      raise exception 'deletion_target_not_found' using errcode = 'PT404';
    end if;

    c_analyses := 1;
    select coalesce(array_agg(r.id order by r.id), '{}'::uuid[]) into affected_runs
      from private.analysis_runs r where (r.analysis_id, r.user_id) = (p_target, v_owner_id);
    c_runs := cardinality(affected_runs);

    select count(*)::integer into c_turns
      from private.analysis_chat_turns t where (t.analysis_id, t.user_id) = (p_target, v_owner_id);

    select coalesce(array_agg(f.id order by f.id), '{}'::uuid[]) into affected_funds
      from public.funding_entries f where (f.analysis_id, f.user_id) = (p_target, v_owner_id);
    c_funds := cardinality(affected_funds);

    select count(*)::integer into c_reports_deleted
      from public.reports r where (r.analysis_id, r.user_id) = (p_target, v_owner_id);

    if c_funds > 0 then
      select count(*)::integer into cross_legacy_reports
        from public.reports r
        where r.user_id = v_owner_id
          and r.analysis_id <> p_target
          and not exists (
            select 1 from private.saved_analysis_reports sr
            where sr.report_id = r.id and sr.user_id = v_owner_id
          )
          and private.legacy_report_references_any_uuid(r, affected_funds);
      c_reports_deleted := c_reports_deleted + cross_legacy_reports;
    end if;
    c_reports := c_reports_deleted;

    select count(*)::integer into c_uploads
      from public.analysis_uploads u
      where (u.analysis_id, u.user_id) = (p_target, v_owner_id) and u.status <> 'deleted';

    select count(*)::integer into c_storage_objects
      from public.analysis_uploads u
      join storage.objects o
        on o.bucket_id = 'analysis-uploads' and o.name collate "C" = u.object_path
      where (u.analysis_id, u.user_id) = (p_target, v_owner_id);

    select count(*)::integer into c_profile_changes
      from private.search_profile_proposals sp
      where sp.user_id = v_owner_id
        and (sp.analysis_id = p_target or sp.run_id = any(affected_runs));

  elsif p_scope = 'message' then
    if not exists (select 1 from public.chat_messages m where m.id = p_target and m.user_id = v_owner_id) then
      raise exception 'deletion_target_not_found' using errcode = 'PT404';
    end if;
    c_messages := 1;

  elsif p_scope = 'turn' then
    select * into turn_scope from private.resolve_turn_deletion_scope(v_owner_id, p_target);
    c_runs := cardinality(turn_scope.descendant_run_ids);
    c_turns := cardinality(turn_scope.affected_turn_ids);
    c_reports_deleted := cardinality(turn_scope.managed_report_ids) + cardinality(turn_scope.legacy_report_ids);
    c_reports := c_reports_deleted;
    c_profile_changes := cardinality(turn_scope.profile_change_ids);

  elsif p_scope = 'fund' then
    select * into fund_scope from private.resolve_fund_deletion_scope(v_owner_id, p_target);
    c_funds := 1;
    c_reports_updated := cardinality(fund_scope.managed_report_ids);
    c_reports_deleted := cardinality(fund_scope.legacy_report_ids);
    c_reports := c_reports_updated + c_reports_deleted;

  elsif p_scope = 'upload' then
    select * into upload_scope from private.resolve_upload_deletion_scope(v_owner_id, p_target);
    c_uploads := 1;
    c_runs := cardinality(upload_scope.affected_run_ids);
    c_turns := cardinality(upload_scope.affected_turn_ids);
    c_reports_deleted := cardinality(upload_scope.managed_report_ids) + cardinality(upload_scope.legacy_report_ids);
    c_reports := c_reports_deleted;
    c_profile_changes := cardinality(upload_scope.profile_change_ids);

    select count(*)::integer into c_storage_objects
      from storage.objects o
      where o.bucket_id = 'analysis-uploads'
        and o.name collate "C" = upload_scope.object_path;

  elsif p_scope = 'report' then
    if not exists (select 1 from public.reports r where r.id = p_target and r.user_id = v_owner_id) then
      raise exception 'deletion_target_not_found' using errcode = 'PT404';
    end if;
    c_reports_deleted := 1;
    c_reports := 1;

  elsif p_scope = 'profile' then
    select exists (
      select 1 from public.user_profiles p
      where p.user_id = v_owner_id
        and (p.search_conditions <> '{}'::jsonb or p.commute_destination is not null)
    ) into v_profile_cleared;
    select count(*)::integer into c_profile_changes
      from public.profile_change_requests pr where pr.user_id = v_owner_id;

  else
    -- 계정 전체의 영향만 읽는다. 실제 삭제는 별도 계정 삭제 요청에서 시작한다.
    select count(*)::integer into c_chats from public.chats c where c.user_id = v_owner_id;
    select count(*)::integer into c_messages from public.chat_messages m where m.user_id = v_owner_id;
    select count(*)::integer into c_analyses from public.analyses a where a.user_id = v_owner_id;
    select count(*)::integer into c_runs from private.analysis_runs r where r.user_id = v_owner_id;
    select count(*)::integer into c_turns from private.analysis_chat_turns t where t.user_id = v_owner_id;
    select count(*)::integer into c_funds from public.funding_entries f where f.user_id = v_owner_id;
    select count(*)::integer into c_reports_deleted from public.reports r where r.user_id = v_owner_id;
    c_reports := c_reports_deleted;
    select count(*)::integer into c_uploads
      from public.analysis_uploads u where u.user_id = v_owner_id and u.status <> 'deleted';
    select count(*)::integer into c_storage_objects
      from storage.objects o
      where o.bucket_id = 'analysis-uploads'
        and (
          o.owner_id = v_owner_id::text
          or o.owner = v_owner_id
          or o.name collate "C" like (v_owner_id::text || '/%')
        )
        and private.valid_deletion_upload_path(v_owner_id, o.name)
        and private.deletion_object_owned(v_owner_id, o.owner_id, o.owner);
    select count(*)::integer into c_profile_changes
      from public.profile_change_requests pr where pr.user_id = v_owner_id;
    select exists (
      select 1 from public.user_profiles p
      where p.user_id = v_owner_id
        and (p.search_conditions <> '{}'::jsonb or p.commute_destination is not null)
    ) into v_profile_cleared;
  end if;

  return jsonb_build_object(
    'scope', p_scope,
    'targetId', p_target,
    'counts', jsonb_build_object(
      'chats', c_chats,
      'messages', c_messages,
      'analyses', c_analyses,
      'runs', c_runs,
      'turns', c_turns,
      'funds', c_funds,
      'reports', c_reports,
      'uploads', c_uploads,
      'profileChanges', c_profile_changes
    ),
    'profileCleared', v_profile_cleared,
    'reportsDeleted', c_reports_deleted,
    'reportsUpdated', c_reports_updated,
    'storageObjects', c_storage_objects
  );
end;
$$;

-- 확인된 소유자의 개별 자료 또는 공유 프로필을 원자적으로 삭제·정리하고 공용 영수증을 반환한다.
-- account 삭제는 전용 계정 삭제 대기열 RPC가 처리하므로 여기서는 22023으로 거부한다.
create function private.delete_personal_data(
  p_scope text,
  p_receipt uuid,
  p_target uuid default null
) returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  v_owner_id uuid;
  existing_receipt jsonb;

  affected_analyses uuid[] := '{}'::uuid[];
  affected_runs uuid[] := '{}'::uuid[];
  affected_funds uuid[] := '{}'::uuid[];
  cross_legacy_ids uuid[] := '{}'::uuid[];
  profile_change_ids uuid[] := '{}'::uuid[];

  target_analysis_id uuid;
  report_row public.reports%rowtype;
  turn_scope record;
  fund_scope record;
  upload_scope record;
  bump_rec record;
  upload_match_count integer;
begin
  -- 공통 첫 자문 잠금(homecierge:data-deletion:<owner>) + auth.users FOR SHARE + 계정 울타리 확인을
  -- request_account_deletion과 같은 순서로 수행한다.
  v_owner_id := private.lock_deletion_owner(false);

  if not private.valid_deletion_receipt_id(p_receipt) then
    raise exception 'invalid_deletion_receipt' using errcode = '22023';
  end if;

  if p_scope is null or p_scope not in (
    'chat','analysis','message','turn','fund','upload','report','profile'
  ) then
    raise exception 'invalid_deletion_scope' using errcode = '22023';
  end if;

  if p_scope = 'profile' then
    if p_target is not null then
      raise exception 'invalid_deletion_scope' using errcode = '22023';
    end if;
  else
    if p_target is null then
      raise exception 'invalid_deletion_scope' using errcode = '22023';
    end if;
  end if;

  -- 멱등 재전송/영수증 충돌 확인을 대상 존재 검사보다 먼저 수행한다.
  -- 대상이 이미 삭제된 뒤의 동일 영수증 재전송은 PT404가 아니라 기존 영수증을 반환한다.
  existing_receipt := private.begin_data_deletion(v_owner_id, p_receipt, p_scope, p_target);
  if existing_receipt is not null then
    return existing_receipt;
  end if;

  if p_scope = 'chat' then
    perform pg_advisory_xact_lock(hashtextextended('homecierge:analysis-runs:' || v_owner_id::text, 0));
    perform pg_advisory_xact_lock(hashtextextended('homecierge:saved-reports:' || v_owner_id::text, 0));

    perform 1 from public.chats c
      where c.id = p_target and c.user_id = v_owner_id
      for update;
    if not found then
      raise exception 'deletion_target_not_found' using errcode = 'PT404';
    end if;

    select coalesce(array_agg(a.id order by a.id), '{}'::uuid[]) into affected_analyses
      from (
        select a.id from public.analyses a
        where (a.chat_id, a.user_id) = (p_target, v_owner_id)
        order by a.id
        for update
      ) as a;

    if cardinality(affected_analyses) > 0 then
      select coalesce(array_agg(r.id order by r.id), '{}'::uuid[]) into affected_runs
        from (
          select r.id from private.analysis_runs r
          where r.user_id = v_owner_id and r.analysis_id = any(affected_analyses)
          order by r.id
          for update
        ) as r;

      select coalesce(array_agg(f.id order by f.id), '{}'::uuid[]) into affected_funds
        from public.funding_entries f
        where f.user_id = v_owner_id and f.analysis_id = any(affected_analyses);

      if cardinality(affected_funds) > 0 then
        select coalesce(array_agg(r.id order by r.id), '{}'::uuid[]) into cross_legacy_ids
          from public.reports r
          where r.user_id = v_owner_id
            and not (r.analysis_id = any(affected_analyses))
            and not exists (
              select 1 from private.saved_analysis_reports sr
              where sr.report_id = r.id and sr.user_id = v_owner_id
            )
            and private.legacy_report_references_any_uuid(r, affected_funds);

        if cardinality(cross_legacy_ids) > 0 then
          perform 1 from public.analyses a
            where a.user_id = v_owner_id
              and a.id in (
                select distinct r.analysis_id from public.reports r
                where r.user_id = v_owner_id and r.id = any(cross_legacy_ids)
              )
            order by a.id
            for no key update;
        end if;
      end if;

      -- analysis_runs·부모 analyses 잠금 이후 search-profile 잠금 순서를 유지한다.
      perform pg_advisory_xact_lock(hashtextextended('homecierge:search-profile:' || v_owner_id::text, 0));
      perform 1 from public.user_profiles p where p.user_id = v_owner_id for update;

      select coalesce(array_agg(sp.change_id order by sp.change_id), '{}'::uuid[]) into profile_change_ids
        from private.search_profile_proposals sp
        where sp.user_id = v_owner_id
          and (sp.analysis_id = any(affected_analyses) or sp.run_id = any(affected_runs));

      if cardinality(profile_change_ids) > 0 then
        insert into private.retired_deletion_keys(user_id, key_kind, scope_id, request_key)
          select v_owner_id, 'profile_proposal', v_owner_id, sp.request_id
          from private.search_profile_proposals sp
          where sp.user_id = v_owner_id and sp.change_id = any(profile_change_ids)
          on conflict do nothing;

        delete from public.profile_change_requests pr
          where pr.user_id = v_owner_id and pr.id = any(profile_change_ids);
      end if;

      insert into private.retired_deletion_keys(user_id, key_kind, scope_id, request_key)
        select v_owner_id, 'workspace', v_owner_id, a.directory_request_key
        from public.analyses a
        where a.user_id = v_owner_id
          and a.id = any(affected_analyses)
          and a.directory_request_key is not null
        on conflict do nothing;

      if cardinality(cross_legacy_ids) > 0 then
        for bump_rec in
          select r.analysis_id, max(r.snapshot_version)::integer as max_ver
          from public.reports r
          where r.user_id = v_owner_id and r.id = any(cross_legacy_ids)
          group by r.analysis_id
          order by r.analysis_id
        loop
          perform private.bump_analysis_report_version(bump_rec.analysis_id, bump_rec.max_ver);
        end loop;

        delete from public.reports r
          where r.user_id = v_owner_id and r.id = any(cross_legacy_ids);
      end if;

      perform private.stage_deletion_uploads(v_owner_id, p_receipt, affected_analyses, null);

      -- analysis_runs.snapshot_id FK(NO ACTION)에 걸리지 않도록 실행 행을 먼저 제거한다.
      delete from private.analysis_runs r
        where r.user_id = v_owner_id and r.analysis_id = any(affected_analyses);
    end if;

    delete from public.chats c where c.id = p_target and c.user_id = v_owner_id;

  elsif p_scope = 'analysis' then
    perform pg_advisory_xact_lock(hashtextextended('homecierge:analysis-runs:' || v_owner_id::text, 0));
    perform pg_advisory_xact_lock(hashtextextended('homecierge:saved-reports:' || v_owner_id::text, 0));

    perform 1 from public.analyses a
      where (a.id, a.user_id) = (p_target, v_owner_id)
      for update;
    if not found then
      raise exception 'deletion_target_not_found' using errcode = 'PT404';
    end if;

    select coalesce(array_agg(r.id order by r.id), '{}'::uuid[]) into affected_runs
      from (
        select r.id from private.analysis_runs r
        where (r.analysis_id, r.user_id) = (p_target, v_owner_id)
        order by r.id
        for update
      ) as r;

    select coalesce(array_agg(f.id order by f.id), '{}'::uuid[]) into affected_funds
      from public.funding_entries f
      where (f.analysis_id, f.user_id) = (p_target, v_owner_id);

    if cardinality(affected_funds) > 0 then
      select coalesce(array_agg(r.id order by r.id), '{}'::uuid[]) into cross_legacy_ids
        from public.reports r
        where r.user_id = v_owner_id
          and r.analysis_id <> p_target
          and not exists (
            select 1 from private.saved_analysis_reports sr
            where sr.report_id = r.id and sr.user_id = v_owner_id
          )
          and private.legacy_report_references_any_uuid(r, affected_funds);

      if cardinality(cross_legacy_ids) > 0 then
        perform 1 from public.analyses a
          where a.user_id = v_owner_id
            and a.id in (
              select distinct r.analysis_id from public.reports r
              where r.user_id = v_owner_id and r.id = any(cross_legacy_ids)
            )
          order by a.id
          for no key update;
      end if;
    end if;

    perform pg_advisory_xact_lock(hashtextextended('homecierge:search-profile:' || v_owner_id::text, 0));
    perform 1 from public.user_profiles p where p.user_id = v_owner_id for update;

    select coalesce(array_agg(sp.change_id order by sp.change_id), '{}'::uuid[]) into profile_change_ids
      from private.search_profile_proposals sp
      where sp.user_id = v_owner_id
        and (sp.analysis_id = p_target or sp.run_id = any(affected_runs));

    if cardinality(profile_change_ids) > 0 then
      insert into private.retired_deletion_keys(user_id, key_kind, scope_id, request_key)
        select v_owner_id, 'profile_proposal', v_owner_id, sp.request_id
        from private.search_profile_proposals sp
        where sp.user_id = v_owner_id and sp.change_id = any(profile_change_ids)
        on conflict do nothing;

      delete from public.profile_change_requests pr
        where pr.user_id = v_owner_id and pr.id = any(profile_change_ids);
    end if;

    insert into private.retired_deletion_keys(user_id, key_kind, scope_id, request_key)
      select v_owner_id, 'workspace', v_owner_id, a.directory_request_key
      from public.analyses a
      where (a.id, a.user_id) = (p_target, v_owner_id)
        and a.directory_request_key is not null
      on conflict do nothing;

    if cardinality(cross_legacy_ids) > 0 then
      for bump_rec in
        select r.analysis_id, max(r.snapshot_version)::integer as max_ver
        from public.reports r
        where r.user_id = v_owner_id and r.id = any(cross_legacy_ids)
        group by r.analysis_id
        order by r.analysis_id
      loop
        perform private.bump_analysis_report_version(bump_rec.analysis_id, bump_rec.max_ver);
      end loop;

      delete from public.reports r
        where r.user_id = v_owner_id and r.id = any(cross_legacy_ids);
    end if;

    perform private.stage_deletion_uploads(v_owner_id, p_receipt, array[p_target], null);

    delete from private.analysis_runs r
      where (r.analysis_id, r.user_id) = (p_target, v_owner_id);
    delete from public.analyses a
      where (a.id, a.user_id) = (p_target, v_owner_id);

  elsif p_scope = 'message' then
    perform 1 from public.chat_messages m
      where m.id = p_target and m.user_id = v_owner_id
      for update;
    if not found then
      raise exception 'deletion_target_not_found' using errcode = 'PT404';
    end if;

    delete from public.chat_messages m
      where m.id = p_target and m.user_id = v_owner_id;

  elsif p_scope = 'turn' then
    perform pg_advisory_xact_lock(hashtextextended('homecierge:analysis-runs:' || v_owner_id::text, 0));
    perform pg_advisory_xact_lock(hashtextextended('homecierge:saved-reports:' || v_owner_id::text, 0));

    select t.analysis_id into target_analysis_id
      from private.analysis_chat_turns t
      where t.id = p_target and t.user_id = v_owner_id;
    if not found then
      raise exception 'deletion_target_not_found' using errcode = 'PT404';
    end if;

    perform 1 from public.analyses a
      where (a.id, a.user_id) = (target_analysis_id, v_owner_id)
      for no key update;

    select * into turn_scope from private.resolve_turn_deletion_scope(v_owner_id, p_target);

    if cardinality(turn_scope.legacy_report_ids) > 0 then
      perform 1 from public.analyses a
        where a.user_id = v_owner_id
          and a.id <> turn_scope.analysis_id
          and a.id in (
            select distinct r.analysis_id from public.reports r
            where r.user_id = v_owner_id and r.id = any(turn_scope.legacy_report_ids)
          )
        order by a.id
        for no key update;
    end if;

    if cardinality(turn_scope.descendant_run_ids) > 0 then
      perform 1 from private.analysis_runs r
        where r.user_id = v_owner_id and r.id = any(turn_scope.descendant_run_ids)
        order by r.id
        for update;
    end if;

    if cardinality(turn_scope.profile_change_ids) > 0 then
      perform pg_advisory_xact_lock(hashtextextended('homecierge:search-profile:' || v_owner_id::text, 0));
      perform 1 from public.user_profiles p where p.user_id = v_owner_id for update;

      insert into private.retired_deletion_keys(user_id, key_kind, scope_id, request_key)
        select v_owner_id, 'profile_proposal', v_owner_id, sp.request_id
        from private.search_profile_proposals sp
        where sp.user_id = v_owner_id and sp.change_id = any(turn_scope.profile_change_ids)
        on conflict do nothing;

      delete from public.profile_change_requests pr
        where pr.user_id = v_owner_id and pr.id = any(turn_scope.profile_change_ids);
    end if;

    if cardinality(turn_scope.managed_report_ids) > 0 then
      insert into private.deleted_report_requests(user_id, analysis_id, request_id)
        select sr.user_id, sr.analysis_id, sr.request_id
        from private.saved_analysis_reports sr
        where sr.user_id = v_owner_id and sr.report_id = any(turn_scope.managed_report_ids)
        on conflict do nothing;
    end if;

    if cardinality(turn_scope.legacy_report_ids) > 0 then
      for bump_rec in
        select r.analysis_id, max(r.snapshot_version)::integer as max_ver
        from public.reports r
        where r.user_id = v_owner_id and r.id = any(turn_scope.legacy_report_ids)
        group by r.analysis_id
        order by r.analysis_id
      loop
        perform private.bump_analysis_report_version(bump_rec.analysis_id, bump_rec.max_ver);
      end loop;
    end if;

    insert into private.retired_deletion_keys(user_id, key_kind, scope_id, request_key)
      select v_owner_id, 'chat_turn', t.base_run_id, t.request_id
      from private.analysis_chat_turns t
      where t.user_id = v_owner_id and t.id = any(turn_scope.affected_turn_ids)
      on conflict do nothing;

    if cardinality(turn_scope.descendant_run_ids) > 0 then
      insert into private.retired_deletion_keys(user_id, key_kind, scope_id, request_key)
        select v_owner_id, 'analysis_run', r.analysis_id, r.idempotency_key
        from private.analysis_runs r
        where r.user_id = v_owner_id and r.id = any(turn_scope.descendant_run_ids)
        on conflict do nothing;
    end if;

    delete from private.analysis_chat_turns t
      where t.user_id = v_owner_id and t.id = p_target;

    if cardinality(turn_scope.descendant_run_ids) > 0 then
      delete from private.analysis_runs r
        where r.user_id = v_owner_id and r.id = any(turn_scope.descendant_run_ids);
      perform private.resync_analysis_latest_run(v_owner_id, turn_scope.analysis_id);
    end if;

    if cardinality(turn_scope.legacy_report_ids) > 0 then
      delete from public.reports r
        where r.user_id = v_owner_id and r.id = any(turn_scope.legacy_report_ids);
    end if;

  elsif p_scope = 'fund' then
    perform pg_advisory_xact_lock(hashtextextended('homecierge:saved-reports:' || v_owner_id::text, 0));

    select f.analysis_id into target_analysis_id
      from public.funding_entries f
      where f.id = p_target and f.user_id = v_owner_id;
    if not found then
      raise exception 'deletion_target_not_found' using errcode = 'PT404';
    end if;

    perform 1 from public.analyses a
      where (a.id, a.user_id) = (target_analysis_id, v_owner_id)
      for no key update;

    perform 1 from public.funding_entries f
      where f.id = p_target and f.user_id = v_owner_id
      for update;
    if not found then
      raise exception 'deletion_target_not_found' using errcode = 'PT404';
    end if;

    select * into fund_scope from private.resolve_fund_deletion_scope(v_owner_id, p_target);

    if fund_scope.request_key is not null then
      insert into private.retired_deletion_keys(user_id, key_kind, scope_id, request_key)
        values (v_owner_id, 'funding_entry', fund_scope.analysis_id, fund_scope.request_key)
        on conflict do nothing;
    end if;

    if cardinality(fund_scope.managed_report_ids) > 0 then
      perform 1 from private.saved_analysis_reports sr
        where sr.user_id = v_owner_id and sr.report_id = any(fund_scope.managed_report_ids)
        order by sr.report_id
        for update;
    end if;

    if cardinality(fund_scope.legacy_report_ids) > 0 then
      for bump_rec in
        select r.analysis_id, max(r.snapshot_version)::integer as max_ver
        from public.reports r
        where r.user_id = v_owner_id and r.id = any(fund_scope.legacy_report_ids)
        group by r.analysis_id
        order by r.analysis_id
      loop
        if bump_rec.analysis_id <> fund_scope.analysis_id then
          perform 1 from public.analyses a
            where (a.id, a.user_id) = (bump_rec.analysis_id, v_owner_id) for no key update;
        end if;
        perform private.bump_analysis_report_version(bump_rec.analysis_id, bump_rec.max_ver);
      end loop;
    end if;

    -- 기존 AFTER DELETE 트리거가 saved_report_funding_refs 기반 관리 보고서를 정리한다.
    delete from public.funding_entries f
      where f.id = p_target and f.user_id = v_owner_id;

    -- 참조 행이 누락된 관리 보고서가 있더라도 고정 funds 배열에서 해당 항목을 보완 제거한다.
    if cardinality(fund_scope.managed_report_ids) > 0 then
      update private.saved_analysis_reports sr
        set funding_value = jsonb_set(
          sr.funding_value,
          array['funds'],
          coalesce(
            (
              select jsonb_agg(item.value order by item.ordinality)
              from jsonb_array_elements(sr.funding_value->'funds') with ordinality as item(value, ordinality)
              where item.value->>'id' is distinct from p_target::text
            ),
            '[]'::jsonb
          ),
          false
        )
        where sr.user_id = v_owner_id
          and sr.report_id = any(fund_scope.managed_report_ids)
          and sr.funding_value is not null
          and exists (
            select 1
            from jsonb_array_elements(coalesce(sr.funding_value->'funds', '[]'::jsonb)) as item(val)
            where item.val->>'id' = p_target::text
          );
    end if;

    if cardinality(fund_scope.legacy_report_ids) > 0 then
      delete from public.reports r
        where r.user_id = v_owner_id and r.id = any(fund_scope.legacy_report_ids);
    end if;

  elsif p_scope = 'upload' then
    perform pg_advisory_xact_lock(hashtextextended('homecierge:analysis-runs:' || v_owner_id::text, 0));
    perform pg_advisory_xact_lock(hashtextextended('homecierge:saved-reports:' || v_owner_id::text, 0));

    select count(*)::integer, (array_agg(u.analysis_id order by u.analysis_id))[1]
      into upload_match_count, target_analysis_id
      from public.analysis_uploads u
      where u.user_id = v_owner_id
        and u.id = p_target
        and u.status <> 'deleted';

    if upload_match_count = 0 then
      raise exception 'deletion_target_not_found' using errcode = 'PT404';
    end if;
    if upload_match_count > 1 then
      raise exception 'deletion_upload_scope_unverified'
        using errcode = 'PT409',
              hint = '동일한 업로드 ID가 여러 분석에 등록되어 있어 분석 단위 삭제를 사용해야 합니다.';
    end if;

    perform 1 from public.analyses a
      where (a.id, a.user_id) = (target_analysis_id, v_owner_id)
      for no key update;

    perform 1 from public.analysis_uploads u
      where (u.user_id, u.analysis_id, u.id) = (v_owner_id, target_analysis_id, p_target)
      for update;

    select * into upload_scope from private.resolve_upload_deletion_scope(v_owner_id, p_target);

    if cardinality(upload_scope.legacy_report_ids) > 0 then
      perform 1 from public.analyses a
        where a.user_id = v_owner_id
          and a.id <> upload_scope.analysis_id
          and a.id in (
            select distinct r.analysis_id from public.reports r
            where r.user_id = v_owner_id and r.id = any(upload_scope.legacy_report_ids)
          )
        order by a.id
        for no key update;
    end if;

    if cardinality(upload_scope.affected_run_ids) > 0 then
      perform 1 from private.analysis_runs r
        where r.user_id = v_owner_id and r.id = any(upload_scope.affected_run_ids)
        order by r.id
        for update;
    end if;

    if cardinality(upload_scope.bound_snapshot_ids) > 0 then
      perform 1 from public.analysis_input_snapshots s
        where s.user_id = v_owner_id and s.id = any(upload_scope.bound_snapshot_ids)
        order by s.id
        for update;
    end if;

    if cardinality(upload_scope.profile_change_ids) > 0 then
      perform pg_advisory_xact_lock(hashtextextended('homecierge:search-profile:' || v_owner_id::text, 0));
      perform 1 from public.user_profiles p where p.user_id = v_owner_id for update;

      insert into private.retired_deletion_keys(user_id, key_kind, scope_id, request_key)
        select v_owner_id, 'profile_proposal', v_owner_id, sp.request_id
        from private.search_profile_proposals sp
        where sp.user_id = v_owner_id and sp.change_id = any(upload_scope.profile_change_ids)
        on conflict do nothing;

      delete from public.profile_change_requests pr
        where pr.user_id = v_owner_id and pr.id = any(upload_scope.profile_change_ids);
    end if;

    if cardinality(upload_scope.managed_report_ids) > 0 then
      insert into private.deleted_report_requests(user_id, analysis_id, request_id)
        select sr.user_id, sr.analysis_id, sr.request_id
        from private.saved_analysis_reports sr
        where sr.user_id = v_owner_id and sr.report_id = any(upload_scope.managed_report_ids)
        on conflict do nothing;
    end if;

    if cardinality(upload_scope.legacy_report_ids) > 0 then
      for bump_rec in
        select r.analysis_id, max(r.snapshot_version)::integer as max_ver
        from public.reports r
        where r.user_id = v_owner_id and r.id = any(upload_scope.legacy_report_ids)
        group by r.analysis_id
        order by r.analysis_id
      loop
        perform private.bump_analysis_report_version(bump_rec.analysis_id, bump_rec.max_ver);
      end loop;
    end if;

    insert into private.retired_deletion_keys(user_id, key_kind, scope_id, request_key)
      values (v_owner_id, 'upload', upload_scope.analysis_id, p_target)
      on conflict do nothing;

    if cardinality(upload_scope.affected_turn_ids) > 0 then
      insert into private.retired_deletion_keys(user_id, key_kind, scope_id, request_key)
        select v_owner_id, 'chat_turn', t.base_run_id, t.request_id
        from private.analysis_chat_turns t
        where t.user_id = v_owner_id and t.id = any(upload_scope.affected_turn_ids)
        on conflict do nothing;

      delete from private.analysis_chat_turns t
        where t.user_id = v_owner_id and t.id = any(upload_scope.affected_turn_ids);
    end if;

    if cardinality(upload_scope.affected_run_ids) > 0 then
      insert into private.retired_deletion_keys(user_id, key_kind, scope_id, request_key)
        select v_owner_id, 'analysis_run', r.analysis_id, r.idempotency_key
        from private.analysis_runs r
        where r.user_id = v_owner_id and r.id = any(upload_scope.affected_run_ids)
        on conflict do nothing;

      delete from private.analysis_runs r
        where r.user_id = v_owner_id and r.id = any(upload_scope.affected_run_ids);
    end if;

    if cardinality(upload_scope.legacy_report_ids) > 0 then
      delete from public.reports r
        where r.user_id = v_owner_id and r.id = any(upload_scope.legacy_report_ids);
    end if;

    if cardinality(upload_scope.bound_snapshot_ids) > 0 then
      insert into private.retired_deletion_keys(user_id, key_kind, scope_id, request_key)
        select v_owner_id, 'snapshot', s.analysis_id, s.capture_key
        from public.analysis_input_snapshots s
        where s.user_id = v_owner_id and s.id = any(upload_scope.bound_snapshot_ids)
        on conflict do nothing;

      delete from public.analysis_input_snapshots s
        where s.user_id = v_owner_id and s.id = any(upload_scope.bound_snapshot_ids);
    end if;

    if cardinality(upload_scope.affected_run_ids) > 0 then
      perform private.resync_analysis_latest_run(v_owner_id, upload_scope.analysis_id);
    end if;

    perform private.stage_deletion_uploads(v_owner_id, p_receipt, array[upload_scope.analysis_id], p_target);

  elsif p_scope = 'report' then
    perform pg_advisory_xact_lock(hashtextextended('homecierge:saved-reports:' || v_owner_id::text, 0));

    select r.* into report_row
      from public.reports r
      where r.id = p_target and r.user_id = v_owner_id;
    if not found then
      raise exception 'deletion_target_not_found' using errcode = 'PT404';
    end if;

    perform 1 from public.analyses a
      where (a.id, a.user_id) = (report_row.analysis_id, v_owner_id)
      for no key update;

    select r.* into report_row
      from public.reports r
      where r.id = p_target and r.user_id = v_owner_id
      for update;
    if not found then
      raise exception 'deletion_target_not_found' using errcode = 'PT404';
    end if;

    perform private.bump_analysis_report_version(report_row.analysis_id, report_row.snapshot_version);

    insert into private.deleted_report_requests(user_id, analysis_id, request_id)
      select sr.user_id, sr.analysis_id, sr.request_id
      from private.saved_analysis_reports sr
      where sr.report_id = p_target and sr.user_id = v_owner_id
      on conflict do nothing;

    delete from public.reports r
      where r.id = p_target and r.user_id = v_owner_id;

  else
    -- p_scope = 'profile': 검색 조건·출퇴근 목적지·변경 이력을 정리하되 단조 증가 revision을 유지해
    -- 지연된 승인·레거시 목적지 확인 쓰기의 자동 복원을 차단하고 독립 분석·보고서 사실은 보존한다.
    perform pg_advisory_xact_lock(hashtextextended('homecierge:search-profile:' || v_owner_id::text, 0));

    insert into public.user_profiles(user_id)
      values (v_owner_id)
      on conflict (user_id) do nothing;

    perform 1 from public.user_profiles p
      where p.user_id = v_owner_id
      for update;

    insert into private.retired_deletion_keys(user_id, key_kind, scope_id, request_key)
      select v_owner_id, 'profile_proposal', v_owner_id, sp.request_id
      from private.search_profile_proposals sp
      where sp.user_id = v_owner_id
      on conflict do nothing;

    delete from public.profile_change_requests pr
      where pr.user_id = v_owner_id;

    update public.user_profiles
      set search_conditions = '{}'::jsonb,
          commute_destination = null,
          revision = revision + 1
      where user_id = v_owner_id;
  end if;

  return private.finish_data_deletion_request(p_receipt);
end;
$$;

create function public.list_deletion_items(p_kind text, p_before uuid default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.list_deletion_items(p_kind, p_before);
$$;

create function public.read_deletion_impact(p_scope text, p_target uuid default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.read_deletion_impact(p_scope, p_target);
$$;

create function public.delete_personal_data(
  p_scope text,
  p_receipt uuid,
  p_target uuid default null
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.delete_personal_data(p_scope, p_receipt, p_target);
$$;

revoke all on function
  private.guard_retired_workspace_key(),
  private.guard_retired_analysis_run_key(),
  private.guard_retired_chat_turn_key(),
  private.guard_retired_funding_entry_key(),
  private.guard_retired_profile_proposal_key(),
  private.guard_retired_upload_key(),
  private.guard_retired_snapshot_key(),
  private.purge_retired_keys_on_account_fence(),
  private.deletion_text_preview(text,text,integer),
  private.jsonb_mentions_uuid(jsonb,uuid),
  private.legacy_report_references_any_uuid(public.reports,uuid[]),
  private.upload_doc_id_matches(text,uuid,uuid,uuid),
  private.resync_analysis_latest_run(uuid,uuid),
  private.bump_analysis_report_version(uuid,integer),
  private.resolve_turn_deletion_scope(uuid,uuid),
  private.resolve_fund_deletion_scope(uuid,uuid),
  private.resolve_upload_deletion_scope(uuid,uuid),
  private.list_deletion_items(text,uuid),
  private.read_deletion_impact(text,uuid),
  private.delete_personal_data(text,uuid,uuid),
  public.list_deletion_items(text,uuid),
  public.read_deletion_impact(text,uuid),
  public.delete_personal_data(text,uuid,uuid)
from public, anon, authenticated, service_role;

grant execute on function
  private.list_deletion_items(text,uuid),
  private.read_deletion_impact(text,uuid),
  private.delete_personal_data(text,uuid,uuid),
  public.list_deletion_items(text,uuid),
  public.read_deletion_impact(text,uuid),
  public.delete_personal_data(text,uuid,uuid)
to authenticated;

notify pgrst, 'reload schema';
