-- S-07: 저장 보고서(report-snapshot/v1) 생성·조회·목록·삭제 RPC와 섹션별 출처 권한 재검증을 추가한다.
-- 기존 public.reports의 레거시 행과 계약을 보존하면서 관리 대상 보고서의 본문은 private 스키마에 격리한다.
-- 제3자 뉴스, 실시간 출퇴근 경로, 원본 PDF·수집 JSON, 통제되지 않은 조건·자금 메모는 저장하지 않는다.

alter table public.reports
  add constraint reports_id_analysis_user_key unique (id, analysis_id, user_id);

alter table public.analysis_input_snapshots
  add constraint analysis_input_snapshots_id_analysis_user_key unique (id, analysis_id, user_id);

-- 분석별 보고서 버전이 삭제 이후에도 단조 증가하도록 별도 카운터를 유지한다.
create table private.analysis_report_versions (
  analysis_id uuid primary key references public.analyses(id) on delete cascade,
  last_version integer not null check (last_version > 0)
);
alter table private.analysis_report_versions enable row level security;
revoke all on private.analysis_report_versions from public, anon, authenticated, service_role;

-- 명시적으로 삭제한 보고서의 지연된 저장 재시도가 같은 보고서를 복구하지 않게 한다.
create table private.deleted_report_requests (
  user_id uuid not null,
  analysis_id uuid not null,
  request_id uuid not null,
  primary key (user_id, request_id),
  foreign key (analysis_id, user_id) references public.analyses(id, user_id) on delete cascade
);
create index deleted_report_requests_analysis_idx on private.deleted_report_requests(analysis_id, user_id);
alter table private.deleted_report_requests enable row level security;
revoke all on private.deleted_report_requests from public, anon, authenticated, service_role;

create table private.saved_analysis_reports (
  report_id uuid primary key,
  user_id uuid not null,
  analysis_id uuid not null,
  run_id uuid not null,
  snapshot_id uuid not null,
  request_id uuid not null,
  funding_room_digest bytea,
  report_order bigint generated always as identity not null unique,
  rules_version text not null,
  data_origin text not null check (data_origin in ('synthetic', 'collected')),
  comparison_sources text[] not null,
  comparison_value jsonb,
  comparison_identity jsonb,
  funding_state text not null check (
    funding_state in ('available', 'room_unselected', 'selection_unverified', 'source_restricted')
  ),
  funding_sources text[] not null,
  funding_value jsonb,
  law_sources text[] not null,
  law_value jsonb,
  unique (user_id, request_id),
  unique (report_id, analysis_id, user_id),
  foreign key (user_id)
    references auth.users(id) on delete cascade,
  foreign key (analysis_id, user_id)
    references public.analyses(id, user_id) on delete cascade,
  foreign key (report_id, analysis_id, user_id)
    references public.reports(id, analysis_id, user_id) on delete cascade,
  foreign key (run_id, analysis_id, user_id)
    references private.analysis_runs(id, analysis_id, user_id) on delete cascade,
  foreign key (run_id)
    references private.comparison_results(run_id) on delete cascade,
  foreign key (snapshot_id, analysis_id, user_id)
    references public.analysis_input_snapshots(id, analysis_id, user_id) on delete cascade,
  check (funding_room_digest is null or octet_length(funding_room_digest) = 32),
  check (funding_state <> 'room_unselected' or funding_room_digest is null),
  check (funding_value is null or funding_room_digest is not distinct from
    sha256(uuid_send(request_id) || convert_to(funding_value->>'room', 'UTF8'))),
  check (
    array_position(comparison_sources, null) is null
    and array_position(funding_sources, null) is null
    and array_position(law_sources, null) is null
  ),
  check (
    data_origin <> 'synthetic'
    or (
      comparison_sources = '{}'::text[]
      and funding_sources = '{}'::text[]
      and law_sources = '{}'::text[]
    )
  ),
  check (data_origin <> 'collected' or comparison_value is null or cardinality(comparison_sources) > 0),
  check (data_origin <> 'collected' or funding_value is null or cardinality(funding_sources) > 0),
  check (data_origin <> 'collected' or law_value is null or cardinality(law_sources) > 0),
  check ((comparison_value is null) = (comparison_identity is null)),
  check (
    comparison_value is null or (
      jsonb_typeof(comparison_value) = 'object'
      and comparison_value->>'contractVersion' = 'comparison/v1'
      and not private.comparison_contains_raw_payload(comparison_value)
    )
  ),
  check (
    comparison_identity is null or private.ingestion_v0_object(
      comparison_identity,
      array['houseManageNo','noticeNo','edition','noticeSource','noticeDate','title']
    )
  ),
  check ((funding_state = 'available') = (funding_value is not null)),
  check (
    funding_value is null or (
      jsonb_typeof(funding_value) = 'object'
      and private.ingestion_v0_object(
        funding_value,
        array['analysisId','snapshotId','modelNo','room','dataOrigin','scheduleStatus','schedules','funds']
      )
      and not private.comparison_contains_raw_payload(funding_value)
    )
  ),
  check (
    law_value is null or (
      jsonb_typeof(law_value) = 'object'
      and private.ingestion_v0_object(
        law_value,
        array['analysisId','snapshotId','dataOrigin','noticeDate','noticeSource','status','reference']
      )
      and not private.comparison_contains_raw_payload(law_value)
    )
  )
);

create index saved_analysis_reports_owner_order_idx
  on private.saved_analysis_reports(user_id, report_order desc);
create index saved_analysis_reports_analysis_run_idx
  on private.saved_analysis_reports(analysis_id, run_id, user_id);
create index saved_analysis_reports_snapshot_idx
  on private.saved_analysis_reports(snapshot_id);

alter table private.saved_analysis_reports enable row level security;
revoke all on private.saved_analysis_reports from public, anon, authenticated, service_role;

-- 저장 보고서에 포함된 자금 항목이 나중에 개별 삭제되면 고정본에서 해당 항목만 정리한다.
-- 자금 항목의 수정(UPDATE)과 신규 추가(INSERT)는 보고서의 고정 스냅샷을 바꾸지 않는다.
create table private.saved_report_funding_refs (
  report_id uuid not null,
  user_id uuid not null,
  analysis_id uuid not null,
  funding_entry_id uuid not null,
  primary key (report_id, funding_entry_id),
  foreign key (report_id, analysis_id, user_id)
    references private.saved_analysis_reports(report_id, analysis_id, user_id) on delete cascade
);
create index saved_report_funding_refs_entry_idx
  on private.saved_report_funding_refs(funding_entry_id);

alter table private.saved_report_funding_refs enable row level security;
revoke all on private.saved_report_funding_refs from public, anon, authenticated, service_role;

-- 실행·비교결과·수집본 연쇄 삭제로 private.saved_analysis_reports가 제거되면 public.reports 행도 함께 정리한다.
create function private.cleanup_deleted_saved_report()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.reports where id = old.report_id;
  return null;
end;
$$;

create trigger cleanup_deleted_saved_report
  after delete on private.saved_analysis_reports
  for each row execute function private.cleanup_deleted_saved_report();

-- 개별 자금 항목이 삭제되면 해당 항목을 포함한 저장 보고서의 고정 funds 목록에서 제거한다.
create function private.prune_deleted_funding_entry_from_reports()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  affected_report_ids uuid[];
begin
  select array_agg(ref.report_id order by ref.report_id)
    into affected_report_ids
    from private.saved_report_funding_refs ref
    where ref.funding_entry_id = old.id;

  if affected_report_ids is null or cardinality(affected_report_ids) = 0 then
    return null;
  end if;

  perform 1
    from private.saved_analysis_reports sr
    where sr.report_id = any(affected_report_ids)
    order by sr.report_id
    for update;

  update private.saved_analysis_reports sr
    set funding_value = jsonb_set(
      sr.funding_value,
      array['funds'],
      coalesce(
        (
          select jsonb_agg(item.value order by item.ordinality)
          from jsonb_array_elements(sr.funding_value->'funds') with ordinality as item(value, ordinality)
          where item.value->>'id' is distinct from old.id::text
        ),
        '[]'::jsonb
      ),
      false
    )
    where sr.report_id = any(affected_report_ids)
      and sr.funding_value is not null;

  delete from private.saved_report_funding_refs
    where funding_entry_id = old.id;

  return null;
end;
$$;

create trigger prune_deleted_funding_entry_from_reports
  after delete on public.funding_entries
  for each row execute function private.prune_deleted_funding_entry_from_reports();

-- 관리 대상 보고서는 권한 철회 여부와 무관하게 public.reports 직접 조회를 차단하고 레거시 행만 보존한다.
create function private.report_direct_select_allowed(p_report_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and auth.uid() = p_user_id
    and not exists (
      select 1 from private.saved_analysis_reports sr
      where sr.report_id = p_report_id and sr.user_id = p_user_id
    );
$$;

create policy managed_saved_reports_rpc_only on public.reports
  as restrictive for select to authenticated
  using (private.report_direct_select_allowed(id, user_id));

-- 읽기 전용 RPC에서 확인된 비익명 소유자를 검증한다.
create function private.require_saved_report_read_user()
returns uuid language plpgsql stable set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
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
  return owner_id;
end;
$$;

-- 실수집 섹션은 비어 있지 않은 출처 목록과 저장·재사용·표시·무기한 보관(및 내보내기 시 export_permission)을 모두 요구한다.
create function private.report_sources_allowed(
  p_requires_rights boolean,
  p_source_ids text[],
  p_require_export boolean
) returns boolean language sql stable set search_path = '' as $$
  select case
    when not coalesce(p_requires_rights, true) then true
    when p_source_ids is null or cardinality(p_source_ids) = 0 then false
    else not exists (
      select 1 from unnest(p_source_ids) as source(id)
      left join public.source_registry r on r.id = source.id
      where source.id is null
        or btrim(source.id) = ''
        or source.id in ('user_upload', 'upload')
        or r.id is null
        or r.retention_days is not null
        or r.storage_permission is distinct from 'allowed'
        or r.reuse_permission is distinct from 'allowed'
        or r.display_permission is distinct from 'allowed'
        or (p_require_export and r.export_permission is distinct from 'allowed')
    )
  end;
$$;

-- 조건에 명시된 모델·호실이 있으면 요청값과 대조한다. JSON null은 미선택으로 다룬다.
create function private.report_funding_selection_matches(conditions jsonb, model_no text, room text)
returns boolean language sql immutable set search_path = '' as $$
  select not exists (
    select 1 from (values
      (conditions->'modelNo', to_jsonb(model_no)),
      (conditions#>'{housingType,modelNo}', to_jsonb(model_no)),
      (conditions#>'{comparison,modelNo}', to_jsonb(model_no)),
      (conditions->'room', to_jsonb(room)),
      (conditions#>'{comparison,room}', to_jsonb(room))
    ) as selection(declared, requested)
    where selection.declared is not null
      and selection.declared <> 'null'::jsonb
      and selection.declared is distinct from selection.requested
  );
$$;

-- 수집본의 공고 카탈로그에서 보고된 모집공고일(RCRIT_PBLANC_DE)을 기존 법령 근거와 같은 기준으로 추출한다.
create function private.report_snapshot_notice_date(p_catalog jsonb)
returns date language plpgsql immutable set search_path = '' as $$
declare
  notice jsonb := p_catalog->'notice';
  date_field jsonb;
  raw_date text;
begin
  if notice is null or jsonb_typeof(notice) <> 'object' then
    return null;
  end if;
  date_field := notice#>'{fields,RCRIT_PBLANC_DE}';
  if notice->>'status' = 'reported'
    and p_catalog#>>'{collections,notice,declaredStatus}' = 'complete'
    and p_catalog#>>'{collections,notice,status}' = 'complete'
    and jsonb_typeof(notice->'evidence') = 'array'
    and notice->'evidence' <> '[]'::jsonb
    and date_field->>'status' = 'reported'
    and jsonb_typeof(date_field->'value') = 'string' then
    raw_date := date_field->>'value';
    if raw_date ~ '\A[0-9]{8}\Z' then
      raw_date := left(raw_date, 4) || '-' || substr(raw_date, 5, 2) || '-' || right(raw_date, 2);
    elsif raw_date ~ '\A[0-9]{4}[.][0-9]{2}[.][0-9]{2}\Z' then
      raw_date := replace(raw_date, '.', '-');
    end if;
    return private.law_reference_iso_date(raw_date);
  end if;
  return null;
end;
$$;

-- 고정된 수집본 대상에서 비교 섹션용 공고 식별 메타데이터만 추출한다.
create function private.report_snapshot_identity(p_snapshot public.analysis_input_snapshots)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  catalog jsonb := p_snapshot.result_snapshot->'catalog';
  notice jsonb := catalog->'notice';
  notice_date date := private.report_snapshot_notice_date(catalog);
  title_field jsonb;
  raw_title text;
  resolved_title text;
begin
  if notice is not null and jsonb_typeof(notice) = 'object'
    and notice->>'status' = 'reported'
    and catalog#>>'{collections,notice,declaredStatus}' = 'complete'
    and catalog#>>'{collections,notice,status}' = 'complete'
    and jsonb_typeof(notice->'evidence') = 'array'
    and notice->'evidence' <> '[]'::jsonb
    and not coalesce(catalog->'issues' @> '[{"code":"notice_field_conflict","field":"HOUSE_NM"}]'::jsonb, false) then
    title_field := notice#>'{fields,HOUSE_NM}';
    if title_field->>'status' = 'reported' and jsonb_typeof(title_field->'value') = 'string' then
      raw_title := btrim(
        title_field->>'value',
        U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
      );
      if raw_title <> '' and char_length(raw_title) <= 200 and raw_title !~ '[[:cntrl:]]' then
        resolved_title := raw_title;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'houseManageNo', p_snapshot.house_manage_no,
    'noticeNo', p_snapshot.notice_no,
    'edition', p_snapshot.edition,
    'noticeSource', p_snapshot.notice_source,
    'noticeDate', to_char(notice_date, 'YYYY-MM-DD'),
    'title', resolved_title
  );
end;
$$;

-- 저장 보고서 1건을 현재 출처 권한과 내보내기 여부에 따라 섹션별로 재검증해 직렬화한다.
create function private.saved_report_payload(
  p_report public.reports,
  p_saved private.saved_analysis_reports,
  p_for_export boolean
) returns jsonb language plpgsql stable set search_path = '' set timezone = 'UTC' as $$
declare
  requires_rights boolean := (p_saved.data_origin = 'collected');
  comp_read_ok boolean;
  comp_export_ok boolean;
  comp_status text;
  comp_value jsonb;
  comp_identity jsonb;

  fund_read_ok boolean;
  fund_export_ok boolean;
  fund_status text;
  fund_value jsonb;

  law_read_ok boolean;
  law_export_ok boolean;
  law_status text;
  law_value jsonb;
begin
  comp_read_ok := (p_saved.comparison_value is not null)
    and private.report_sources_allowed(requires_rights, p_saved.comparison_sources, false);
  comp_export_ok := comp_read_ok
    and private.report_sources_allowed(requires_rights, p_saved.comparison_sources, true);
  if not comp_read_ok then
    comp_status := 'source_restricted';
    comp_value := null;
    comp_identity := null;
  elsif p_for_export and not comp_export_ok then
    comp_status := 'export_restricted';
    comp_value := null;
    comp_identity := null;
  else
    comp_status := 'available';
    comp_value := p_saved.comparison_value;
    comp_identity := p_saved.comparison_identity;
  end if;

  if p_saved.funding_state = 'room_unselected' then
    fund_status := 'room_unselected';
    fund_export_ok := true;
    fund_value := null;
  else
    fund_read_ok := (p_saved.funding_state <> 'source_restricted')
      and private.report_sources_allowed(requires_rights, p_saved.funding_sources, false);
    fund_export_ok := fund_read_ok
      and private.report_sources_allowed(requires_rights, p_saved.funding_sources, true);
    if not fund_read_ok then
      fund_status := 'source_restricted';
      fund_value := null;
    elsif p_for_export and not fund_export_ok then
      fund_status := 'export_restricted';
      fund_value := null;
    elsif p_saved.funding_state = 'selection_unverified' then
      fund_status := 'selection_unverified';
      fund_value := null;
    else
      fund_status := 'available';
      fund_value := p_saved.funding_value;
    end if;
  end if;

  law_read_ok := (p_saved.law_value is not null)
    and private.report_sources_allowed(requires_rights, p_saved.law_sources, false);
  law_export_ok := law_read_ok
    and private.report_sources_allowed(requires_rights, p_saved.law_sources, true);
  if not law_read_ok then
    law_status := 'source_restricted';
    law_value := null;
  elsif p_for_export and not law_export_ok then
    law_status := 'export_restricted';
    law_value := null;
  else
    law_status := 'available';
    law_value := p_saved.law_value;
  end if;

  return jsonb_build_object(
    'contractVersion', 'report-snapshot/v1',
    'reportId', p_report.id,
    'analysisId', p_report.analysis_id,
    'runId', p_saved.run_id,
    'snapshotId', p_saved.snapshot_id,
    'version', p_report.snapshot_version,
    'createdAt', p_report.created_at,
    'queriedAt', p_report.queried_at,
    'rulesVersion', p_saved.rules_version,
    'dataOrigin', p_saved.data_origin,
    'sections', jsonb_build_object(
      'comparison', jsonb_build_object(
        'status', comp_status,
        'sources', to_jsonb(p_saved.comparison_sources),
        'exportAllowed', comp_export_ok,
        'value', comp_value,
        'identity', comp_identity
      ),
      'funding', jsonb_build_object(
        'status', fund_status,
        'sources', to_jsonb(p_saved.funding_sources),
        'exportAllowed', fund_export_ok,
        'value', fund_value
      ),
      'law', jsonb_build_object(
        'status', law_status,
        'sources', to_jsonb(p_saved.law_sources),
        'exportAllowed', law_export_ok,
        'value', law_value
      )
    )
  );
end;
$$;

-- 목록 조회는 수치·세부 식별 정보 없이 최신순 메타데이터(최대 30건)·queriedAt·표시 허가된 title만 반환한다.
create function private.saved_reports_list_payload(p_owner_id uuid, p_before_order bigint default null)
returns jsonb language sql stable set search_path = '' set timezone = 'UTC' as $$
  with fetched as (
    select
      sr.report_id,
      sr.analysis_id,
      sr.run_id,
      r.snapshot_version,
      r.created_at,
      r.queried_at,
      sr.data_origin,
      sr.comparison_sources,
      sr.comparison_value,
      sr.comparison_identity,
      sr.report_order
    from private.saved_analysis_reports sr
    join public.reports r
      on (r.id, r.analysis_id, r.user_id) = (sr.report_id, sr.analysis_id, sr.user_id)
    where sr.user_id = p_owner_id
      and (p_before_order is null or sr.report_order < p_before_order)
    order by sr.report_order desc
    limit 31
  ),
  page as (
    select *
    from fetched
    order by report_order desc
    limit 30
  )
  select jsonb_build_object(
    'reports', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'reportId', w.report_id,
            'analysisId', w.analysis_id,
            'runId', w.run_id,
            'version', w.snapshot_version,
            'createdAt', w.created_at,
            'queriedAt', w.queried_at,
            'dataOrigin', w.data_origin,
            'title', case
              when w.comparison_value is not null
                and private.report_sources_allowed(w.data_origin = 'collected', w.comparison_sources, false)
              then coalesce(
                nullif(btrim(w.comparison_identity->>'title'), ''),
                case
                  when jsonb_typeof(w.comparison_value#>'{target,name}') = 'string'
                    and btrim(w.comparison_value#>>'{target,name}') <> ''
                    and char_length(btrim(w.comparison_value#>>'{target,name}')) <= 200
                    and (w.comparison_value#>>'{target,name}') !~ '[[:cntrl:]]'
                  then btrim(w.comparison_value#>>'{target,name}')
                end
              )
              else null
            end
          )
          order by w.report_order desc
        )
        from page w
      ),
      '[]'::jsonb
    ),
    'nextCursor', case
      when (select count(*) > 30 from fetched) then (
        select w.report_id
        from page w
        order by w.report_order asc
        limit 1
      )
      else null
    end
  );
$$;

create function private.save_analysis_report(
  p_analysis_id uuid,
  p_run_id uuid,
  p_request_id uuid,
  p_funding_room text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  run_row private.analysis_runs%rowtype;
  comp_row private.comparison_results%rowtype;
  snapshot_row public.analysis_input_snapshots%rowtype;
  existing_saved private.saved_analysis_reports%rowtype;
  existing_report public.reports%rowtype;

  resolved_origin text;
  requires_rights boolean;
  queried_at_ts timestamptz;
  next_version integer;
  new_report public.reports%rowtype;
  new_saved private.saved_analysis_reports%rowtype;

  comp_has_invalid_source boolean := false;
  comp_sources text[] := '{}';
  comp_value jsonb := null;
  comp_identity jsonb := null;

  has_official_pdf boolean := false;
  has_upload_doc boolean := false;
  has_unknown_doc boolean := false;
  saved_schedules jsonb;
  raw_room_count integer := 0;
  distinct_room_count integer := 0;
  selected_room_json jsonb;
  single_valid_original_room boolean := false;
  original_room text := null;
  incoming_effective_room text := null;
  effective_funding_room text := null;
  raw_model_count integer := 0;
  distinct_model_count integer := 0;
  selected_model_json jsonb;
  selected_model text := null;
  known_funding_room boolean := false;
  fund_state text := 'room_unselected';
  fund_sources text[] := '{}';
  fund_value jsonb := null;
  catalog jsonb;
  catalog_room jsonb;
  schedule_status text := 'unavailable';
  room_schedules jsonb := '[]'::jsonb;
  frozen_funds jsonb := '[]'::jsonb;
  included_fund_ids uuid[] := '{}';

  law_sources text[] := '{}';
  law_value jsonb := null;
  target_obj jsonb;
  notice_obj jsonb;
  law_notice_date date;
  law_ref jsonb;
  law_status text;

  all_lock_sources text[];
begin
  perform private.require_notice_run_user(owner_id);
  if p_analysis_id is null or p_run_id is null or p_request_id is null then
    raise exception 'invalid_report_request' using errcode = '22023';
  end if;
  if p_funding_room is not null and not private.funding_label_valid(p_funding_room, true) then
    raise exception 'invalid_funding_room' using errcode = '22023';
  end if;

  -- 같은 소유자의 보고서 저장·재시도·삭제를 직렬화한 뒤 분석 → 실행 → 수집본 → 출처 순으로 잠근다.
  perform pg_advisory_xact_lock(hashtextextended('homecierge:saved-reports:' || owner_id::text, 0));

  perform 1 from public.analyses a
    where (a.id, a.user_id) = (p_analysis_id, owner_id)
    for no key update;
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;

  select r.* into run_row
    from private.analysis_runs r
    where (r.id, r.analysis_id, r.user_id) = (p_run_id, p_analysis_id, owner_id)
    for key share;
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;

  -- 소유권 확인 뒤 같은 요청 키의 멱등 재시도를 복원하고 다른 대상·유효 호실 재사용은 충돌로 거부한다.
  if exists (select 1 from private.deleted_report_requests d where (d.user_id, d.request_id) = (owner_id, p_request_id)) then
    raise exception 'report_request_retired' using errcode = 'PT409';
  end if;
  select sr.* into existing_saved
    from private.saved_analysis_reports sr
    where sr.user_id = owner_id and sr.request_id = p_request_id;
  if found then
    if (existing_saved.analysis_id, existing_saved.run_id) is distinct from (p_analysis_id, p_run_id) then
      raise exception 'report_request_conflict' using errcode = 'PT409';
    end if;

    if p_funding_room is not null then
      incoming_effective_room := p_funding_room;
    else
      select c.* into comp_row from private.comparison_results c where c.run_id = run_row.id;
      select
        count(*)::integer,
        count(distinct cand.val)::integer,
        (array_agg(cand.val))[1]
        into raw_room_count, distinct_room_count, selected_room_json
        from (
          select v as val from (values
            (comp_row.result#>'{target,room}'),
            (comp_row.result#>'{conditions,room}'),
            (case when comp_row.result#>>'{noticePrice,scope}' = 'selected_room' then comp_row.result#>'{noticePrice,room}' end),
            (run_row.conditions_snapshot#>'{comparison,room}'),
            (run_row.conditions_snapshot->'room')
          ) as t(v)
          where v is not null and v <> 'null'::jsonb
        ) as cand;
      if raw_room_count > 0 and distinct_room_count = 1
        and jsonb_typeof(selected_room_json) = 'string'
        and private.funding_label_valid(selected_room_json #>> '{}', true) then
        incoming_effective_room := selected_room_json #>> '{}';
      else
        incoming_effective_room := null;
      end if;
    end if;

    if existing_saved.funding_room_digest is distinct from sha256(uuid_send(p_request_id) || convert_to(incoming_effective_room, 'UTF8')) then
      raise exception 'report_request_conflict' using errcode = 'PT409';
    end if;

    select r.* into strict existing_report
      from public.reports r
      where (r.id, r.analysis_id, r.user_id) = (existing_saved.report_id, existing_saved.analysis_id, existing_saved.user_id);
    return private.saved_report_payload(existing_report, existing_saved, false);
  end if;

  if run_row.status <> 'finished' or run_row.snapshot_id is null then
    raise exception 'analysis_comparison_not_ready' using errcode = 'PT409';
  end if;

  select c.* into comp_row
    from private.comparison_results c
    where c.run_id = run_row.id
    for key share;
  if not found then
    raise exception 'analysis_comparison_not_ready' using errcode = 'PT409';
  end if;

  select s.* into snapshot_row
    from public.analysis_input_snapshots s
    where (s.id, s.analysis_id, s.user_id) = (run_row.snapshot_id, p_analysis_id, owner_id)
    for key share;
  if not found then
    raise exception 'analysis_snapshot_not_found' using errcode = 'PT404';
  end if;

  resolved_origin := case
    when snapshot_row.data_origin = 'collected' or comp_row.result->>'dataOrigin' = 'collected' then 'collected'
    else 'synthetic'
  end;
  requires_rights := (resolved_origin = 'collected');
  -- 기존 수집본 재분석에서도 원 수집본 보관 시각을 queriedAt으로 고정한다.
  queried_at_ts := snapshot_row.created_at;
  catalog := snapshot_row.result_snapshot->'catalog';

  -- 후보 출처 레지스트리 행을 정렬 순서로 먼저 잠가 세 섹션의 권한 판정을 한 시점으로 고정한다.
  if requires_rights then
    comp_has_invalid_source := comp_row.source_ids is null
      or cardinality(comp_row.source_ids) = 0
      or exists (
        select 1 from unnest(comp_row.source_ids) as t(src)
        where t.src is null or btrim(t.src) = ''
      );
    comp_sources := array(
      select s.src
      from (
        select distinct t.src
        from unnest(coalesce(comp_row.source_ids, '{}'::text[])) as t(src)
        where t.src is not null and btrim(t.src) <> ''
      ) as s
      order by s.src collate "C"
    );

    all_lock_sources := array(
      select s.src
      from (
        select distinct t.src
        from unnest(
          comp_sources
          || array[snapshot_row.notice_source, snapshot_row.notice_source || '_model', 'applyhome_notice_pdf', 'law_eflaw', 'user_upload']
        ) as t(src)
        where t.src is not null and btrim(t.src) <> ''
      ) as s
      order by s.src collate "C"
    );
    perform 1 from public.source_registry r where r.id = any(all_lock_sources) order by r.id for share;
  end if;

  -- 1) 비교 섹션: 실수집 비교는 비어 있지 않은 BE-05 출처 목록의 현재 권한을 모두 충족할 때만 저장한다.
  if not requires_rights then
    comp_value := comp_row.result;
    comp_identity := private.report_snapshot_identity(snapshot_row);
  elsif not comp_has_invalid_source
    and private.report_sources_allowed(true, comp_sources, false) then
    comp_value := comp_row.result;
    comp_identity := private.report_snapshot_identity(snapshot_row);
  end if;

  -- 2) 자금 섹션: 원래 비교가 명시한 호실을 우선 사용하고, 주택형 전용 실행에서만 검증된 선택 호실을 자금에 한정 적용한다.
  select f.schedules into saved_schedules
    from private.analysis_funding_schedule_snapshots f
    where f.snapshot_id = snapshot_row.id;

  select
    count(*)::integer,
    count(distinct cand.val)::integer,
    (array_agg(cand.val))[1]
    into raw_room_count, distinct_room_count, selected_room_json
    from (
      select v as val from (values
        (comp_row.result#>'{target,room}'),
        (comp_row.result#>'{conditions,room}'),
        (case when comp_row.result#>>'{noticePrice,scope}' = 'selected_room' then comp_row.result#>'{noticePrice,room}' end),
        (run_row.conditions_snapshot#>'{comparison,room}'),
        (run_row.conditions_snapshot->'room')
      ) as t(v)
      where v is not null and v <> 'null'::jsonb
    ) as cand;

  if raw_room_count = 0 and p_funding_room is null then
    -- 호실 미선택 실행에서는 첫 번째 또는 유일한 호실이라도 추측하지 않는다.
    fund_state := 'room_unselected';
    fund_sources := '{}';
    fund_value := null;
    effective_funding_room := null;
  else
    single_valid_original_room := raw_room_count > 0
      and distinct_room_count = 1
      and jsonb_typeof(selected_room_json) = 'string'
      and private.funding_label_valid(selected_room_json #>> '{}', true);
    if single_valid_original_room then
      original_room := selected_room_json #>> '{}';
    end if;

    -- 원래 비교가 명시한 호실과 다른 명시 요청은 거부한다.
    if raw_room_count > 0 and p_funding_room is not null
      and (not single_valid_original_room or p_funding_room is distinct from original_room) then
      raise exception 'funding_room_mismatch' using errcode = '22023';
    end if;

    effective_funding_room := case
      when raw_room_count = 0 then p_funding_room
      when single_valid_original_room then original_room
      else null
    end;

    if requires_rights then
      select
        coalesce(bool_or(d.value->>'source' = 'official'), false),
        coalesce(bool_or(d.value->>'source' = 'upload'), false),
        coalesce(bool_or(d.value->>'source' is null or d.value->>'source' not in ('official', 'upload')), false)
        into has_official_pdf, has_upload_doc, has_unknown_doc
        from jsonb_array_elements(coalesce(catalog->'documents', '[]'::jsonb)) as d(value);

      fund_sources := array(
        select s.src
        from (
          select distinct t.src
          from unnest(
            array[snapshot_row.notice_source, snapshot_row.notice_source || '_model']
            || case when has_official_pdf or coalesce(saved_schedules, '[]'::jsonb) <> '[]'::jsonb
                 then array['applyhome_notice_pdf'] else '{}'::text[] end
            || case when has_upload_doc then array['user_upload'] else '{}'::text[] end
          ) as t(src)
        ) as s
        order by s.src collate "C"
      );
    end if;

    -- 비공개 호실 존재 여부를 드러내지 않도록 출처 권한을 카탈로그 대조보다 먼저 확인한다.
    if requires_rights and (has_unknown_doc or not private.report_sources_allowed(true, fund_sources, false)) then
      fund_state := 'source_restricted';
      fund_value := null;
    else
      select
        count(*)::integer,
        count(distinct cand.val)::integer,
        (array_agg(cand.val))[1]
        into raw_model_count, distinct_model_count, selected_model_json
        from (
          select v as val from (values
            (comp_row.result#>'{target,modelNo}'),
            (comp_row.result#>'{conditions,modelNo}'),
            (run_row.conditions_snapshot#>'{comparison,modelNo}'),
            (run_row.conditions_snapshot#>'{housingType,modelNo}'),
            (run_row.conditions_snapshot->'modelNo'),
            (case when run_row.input->>'kind' = 'notice' then run_row.input->'modelNo' end)
          ) as t(v)
          where v is not null and v <> 'null'::jsonb
        ) as cand;

      if raw_model_count > 0 and distinct_model_count = 1
        and jsonb_typeof(selected_model_json) = 'string'
        and (selected_model_json #>> '{}') ~ '\A[0-9]{1,20}\Z' then
        selected_model := selected_model_json #>> '{}';
      end if;

      if raw_room_count = 0 then
        -- 주택형 전용 실행의 명시적 p_funding_room은 해당 스냅샷·주택형의 알려진 호실이어야 한다.
        if selected_model is null then
          raise exception 'invalid_funding_room' using errcode = '22023';
        end if;
        known_funding_room := exists (
          select 1
          from jsonb_array_elements(coalesce(catalog->'rooms', '[]'::jsonb)) as r(value)
          where (r.value->>'modelNo', r.value->>'room') = (selected_model, effective_funding_room)
        ) or (
          comp_row.result#>>'{target,modelNo}' = selected_model
          and jsonb_typeof(comp_row.result->'noticePrice') = 'object'
          and (
            exists (
              select 1
              from jsonb_array_elements(coalesce(comp_row.result#>'{noticePrice,confirmedRooms}', '[]'::jsonb)) as cr(value)
              where cr.value->>'room' = effective_funding_room
            )
            or exists (
              select 1
              from jsonb_array_elements(coalesce(comp_row.result#>'{noticePrice,heldRooms}', '[]'::jsonb)) as hr(value)
              where hr.value->>'room' = effective_funding_room
            )
          )
        );
        if known_funding_room is not true then
          raise exception 'invalid_funding_room' using errcode = '22023';
        end if;
      end if;

      if effective_funding_room is null or selected_model is null then
        fund_state := 'selection_unverified';
        fund_value := null;
      else
        schedule_status := 'unavailable';
        room_schedules := '[]'::jsonb;

        if coalesce(saved_schedules, '[]'::jsonb) <> '[]'::jsonb then
          select r.value into catalog_room
            from jsonb_array_elements(coalesce(catalog->'rooms', '[]'::jsonb)) as r(value)
            where (r.value->>'modelNo', r.value->>'room') = (selected_model, effective_funding_room);

          if snapshot_row.target_binding_status <> 'matched'
            or snapshot_row.notice_id is not null or snapshot_row.housing_type_id is not null
            or run_row.notice_id is not null or run_row.housing_type_id is not null
            or run_row.conditions_snapshot->'ingestion_target' is distinct from snapshot_row.conditions_snapshot->'ingestion_target'
            or not private.report_funding_selection_matches(snapshot_row.conditions_snapshot, selected_model, effective_funding_room)
            or not private.report_funding_selection_matches(run_row.conditions_snapshot, selected_model, effective_funding_room)
            or catalog_room is null
            or not private.funding_room_application_verified(catalog, catalog_room) then
            schedule_status := 'selection_unverified';
          else
            select coalesce(jsonb_agg(s.value order by s.position), '[]'::jsonb)
              into room_schedules
              from jsonb_array_elements(saved_schedules) with ordinality as s(value, position)
              where (s.value->>'modelNo', s.value->>'room') = (selected_model, effective_funding_room)
                and s.value->'houseType' = catalog_room->'houseType';
            if room_schedules <> '[]'::jsonb then
              schedule_status := 'available';
            end if;
          end if;
        end if;

        -- 자금 항목 메모(note)는 제외하고 원 단위 금액을 십진 문자열로 고정한다.
        select
          coalesce(jsonb_agg(jsonb_build_object(
            'id', f.id,
            'kind', f.kind,
            'amountWon', f.amount_won::text,
            'availableOn', f.available_on,
            'certainty', f.certainty
          ) order by f.available_on, f.id), '[]'::jsonb),
          coalesce(array_agg(f.id order by f.id), '{}'::uuid[])
          into frozen_funds, included_fund_ids
          from (
            select f.id, f.kind, f.amount_won, f.available_on, f.certainty
            from public.funding_entries f
            where (f.analysis_id, f.user_id) = (p_analysis_id, owner_id)
            order by f.id
            for share
          ) as f;

        fund_state := 'available';
        fund_value := jsonb_build_object(
          'analysisId', p_analysis_id,
          'snapshotId', snapshot_row.id,
          'modelNo', selected_model,
          'room', effective_funding_room,
          'dataOrigin', snapshot_row.data_origin,
          'scheduleStatus', schedule_status,
          'schedules', room_schedules,
          'funds', frozen_funds
        );
      end if;
    end if;
  end if;

  -- 3) 법령 섹션: 합성 입력은 외부 권한을 요구하지 않으며, 실수집은 공고 피드와 law_eflaw를 별도로 확인한다.
  if not requires_rights then
    law_sources := '{}';
    law_value := jsonb_build_object(
      'analysisId', p_analysis_id,
      'snapshotId', snapshot_row.id,
      'dataOrigin', snapshot_row.data_origin,
      'noticeDate', null,
      'noticeSource', snapshot_row.notice_source,
      'status', 'synthetic_input',
      'reference', null
    );
  elsif not private.report_sources_allowed(true, array[snapshot_row.notice_source], false) then
    law_sources := array[snapshot_row.notice_source];
    law_value := null;
  else
    notice_obj := catalog->'notice';
    target_obj := jsonb_build_object(
      'houseManageNo', snapshot_row.house_manage_no,
      'noticeNo', snapshot_row.notice_no,
      'edition', snapshot_row.edition
    );
    if snapshot_row.target_binding_status <> 'matched'
      or snapshot_row.notice_id is not null or snapshot_row.housing_type_id is not null
      or run_row.notice_id is not null or run_row.housing_type_id is not null
      or snapshot_row.conditions_snapshot->'ingestion_target'
         is distinct from (target_obj || jsonb_build_object('noticeSource', snapshot_row.notice_source))
      or catalog->'target' is distinct from target_obj
      or notice_obj->'source' is distinct from to_jsonb(snapshot_row.notice_source) then
      law_sources := array[snapshot_row.notice_source];
      law_value := jsonb_build_object(
        'analysisId', p_analysis_id,
        'snapshotId', snapshot_row.id,
        'dataOrigin', snapshot_row.data_origin,
        'noticeDate', null,
        'noticeSource', snapshot_row.notice_source,
        'status', 'selection_unverified',
        'reference', null
      );
    else
      law_notice_date := private.report_snapshot_notice_date(catalog);
      if law_notice_date is null then
        law_sources := array[snapshot_row.notice_source];
        law_value := jsonb_build_object(
          'analysisId', p_analysis_id,
          'snapshotId', snapshot_row.id,
          'dataOrigin', snapshot_row.data_origin,
          'noticeDate', null,
          'noticeSource', snapshot_row.notice_source,
          'status', 'notice_date_unverified',
          'reference', null
        );
      else
        law_sources := array(
          select s.src
          from (
            select distinct t.src
            from unnest(array[snapshot_row.notice_source, 'law_eflaw']) as t(src)
          ) as s
          order by s.src collate "C"
        );
        if not private.report_sources_allowed(true, law_sources, false) then
          law_value := null;
        else
          select lr.reference_value into law_ref
            from private.law_references lr
            where lr.as_of = law_notice_date;
          law_status := case when found then 'available' else 'version_unverified' end;
          law_value := jsonb_build_object(
            'analysisId', p_analysis_id,
            'snapshotId', snapshot_row.id,
            'dataOrigin', snapshot_row.data_origin,
            'noticeDate', to_char(law_notice_date, 'YYYY-MM-DD'),
            'noticeSource', snapshot_row.notice_source,
            'status', law_status,
            'reference', law_ref
          );
        end if;
      end if;
    end if;
  end if;

  -- 기존 레거시 public.reports 행과 이전 삭제 버전 모두와 충돌하지 않는 다음 버전을 발급한다.
  next_version := greatest(
    coalesce((select max(r.snapshot_version) from public.reports r where r.analysis_id = p_analysis_id), 0),
    coalesce((select v.last_version from private.analysis_report_versions v where v.analysis_id = p_analysis_id), 0)
  ) + 1;

  insert into private.analysis_report_versions(analysis_id, last_version)
    values (p_analysis_id, next_version)
    on conflict (analysis_id) do update set last_version = excluded.last_version;

  -- public.reports에는 제3자 자료·수치·임의 조건을 복제하지 않고 최소 메타 스텁과 버전·시각만 기록한다.
  insert into public.reports(
    user_id, analysis_id, snapshot_version,
    result_snapshot, conditions_snapshot, sources_snapshot, unknowns_snapshot,
    queried_at, created_at
  ) values (
    owner_id, p_analysis_id, next_version,
    '{"contractVersion":"report-snapshot/v1"}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb,
    queried_at_ts, clock_timestamp()
  ) returning * into new_report;

  insert into private.saved_analysis_reports(
    report_id, user_id, analysis_id, run_id, snapshot_id, request_id, funding_room_digest,
    rules_version, data_origin,
    comparison_sources, comparison_value, comparison_identity,
    funding_state, funding_sources, funding_value,
    law_sources, law_value
  ) values (
    new_report.id, owner_id, p_analysis_id, run_row.id, snapshot_row.id, p_request_id,
    sha256(uuid_send(p_request_id) || convert_to(effective_funding_room, 'UTF8')),
    run_row.rules_version, resolved_origin,
    comp_sources, comp_value, comp_identity,
    fund_state, fund_sources, fund_value,
    law_sources, law_value
  ) returning * into new_saved;

  if fund_state = 'available' and cardinality(included_fund_ids) > 0 then
    insert into private.saved_report_funding_refs(report_id, user_id, analysis_id, funding_entry_id)
      select new_report.id, owner_id, p_analysis_id, entry_id
      from unnest(included_fund_ids) as t(entry_id);
  end if;

  return private.saved_report_payload(new_report, new_saved, false);
end;
$$;

create function private.read_saved_analysis_report(
  p_report_id uuid,
  p_for_export boolean default false
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  owner_id uuid := private.require_saved_report_read_user();
  saved_row private.saved_analysis_reports%rowtype;
  report_row public.reports%rowtype;
begin
  if p_report_id is null or p_for_export is null then
    raise exception 'invalid_report_lookup' using errcode = '22023';
  end if;

  select sr.* into saved_row
    from private.saved_analysis_reports sr
    where sr.report_id = p_report_id and sr.user_id = owner_id;
  if not found then
    raise exception 'report_not_found' using errcode = 'PT404';
  end if;

  select r.* into strict report_row
    from public.reports r
    where (r.id, r.analysis_id, r.user_id) = (saved_row.report_id, saved_row.analysis_id, saved_row.user_id);

  return private.saved_report_payload(report_row, saved_row, p_for_export);
end;
$$;

create function private.list_saved_analysis_reports(p_before uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  owner_id uuid := private.require_saved_report_read_user();
  before_order bigint;
begin
  if p_before is not null then
    select sr.report_order into before_order
      from private.saved_analysis_reports sr
      where sr.user_id = owner_id and sr.report_id = p_before;
    if not found then
      raise exception 'report_cursor_not_found' using errcode = 'PT404';
    end if;
  end if;

  return private.saved_reports_list_payload(owner_id, before_order);
end;
$$;

create function private.delete_saved_analysis_report(p_report_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  target_report_id uuid;
begin
  perform private.require_notice_run_user(owner_id);
  if p_report_id is null then
    raise exception 'invalid_report_lookup' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('homecierge:saved-reports:' || owner_id::text, 0));

  select sr.report_id into target_report_id
    from private.saved_analysis_reports sr
    where sr.report_id = p_report_id and sr.user_id = owner_id
    for update;
  if not found then
    raise exception 'report_not_found' using errcode = 'PT404';
  end if;

  insert into private.deleted_report_requests(user_id, analysis_id, request_id)
    select user_id, analysis_id, request_id from private.saved_analysis_reports where report_id = target_report_id;
  delete from public.reports r
    where r.id = target_report_id and r.user_id = owner_id;
end;
$$;

create function public.save_analysis_report(
  p_analysis_id uuid,
  p_run_id uuid,
  p_request_id uuid,
  p_funding_room text default null
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.save_analysis_report(p_analysis_id, p_run_id, p_request_id, p_funding_room);
$$;

create function public.read_saved_analysis_report(
  p_report_id uuid,
  p_for_export boolean default false
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.read_saved_analysis_report(p_report_id, p_for_export);
$$;

create function public.list_saved_analysis_reports(p_before uuid default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.list_saved_analysis_reports(p_before);
$$;

create function public.delete_saved_analysis_report(p_report_id uuid)
returns void language sql security invoker set search_path = '' as $$
  select private.delete_saved_analysis_report(p_report_id);
$$;

revoke all on function
  private.cleanup_deleted_saved_report(),
  private.prune_deleted_funding_entry_from_reports(),
  private.report_direct_select_allowed(uuid,uuid),
  private.require_saved_report_read_user(),
  private.report_sources_allowed(boolean,text[],boolean),
  private.report_funding_selection_matches(jsonb,text,text),
  private.report_snapshot_notice_date(jsonb),
  private.report_snapshot_identity(public.analysis_input_snapshots),
  private.saved_report_payload(public.reports,private.saved_analysis_reports,boolean),
  private.saved_reports_list_payload(uuid,bigint),
  private.save_analysis_report(uuid,uuid,uuid,text),
  private.read_saved_analysis_report(uuid,boolean),
  private.list_saved_analysis_reports(uuid),
  private.delete_saved_analysis_report(uuid),
  public.save_analysis_report(uuid,uuid,uuid,text),
  public.read_saved_analysis_report(uuid,boolean),
  public.list_saved_analysis_reports(uuid),
  public.delete_saved_analysis_report(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  private.report_direct_select_allowed(uuid,uuid),
  private.save_analysis_report(uuid,uuid,uuid,text),
  private.read_saved_analysis_report(uuid,boolean),
  private.list_saved_analysis_reports(uuid),
  private.delete_saved_analysis_report(uuid),
  public.save_analysis_report(uuid,uuid,uuid,text),
  public.read_saved_analysis_report(uuid,boolean),
  public.list_saved_analysis_reports(uuid),
  public.delete_saved_analysis_report(uuid)
to authenticated;

notify pgrst, 'reload schema';
