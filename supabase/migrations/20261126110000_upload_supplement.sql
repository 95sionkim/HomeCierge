-- 작업 B: 공식 PDF 확보 실패·판본 미확인 분석을 소유자 업로드로 보완하고 파생 자료를 업로드 삭제에 바인딩한다.

-- 서버가 공식 출처에서 독립적으로 확인한 첨부 해시 색인. 사용자 쓰기를 허용하지 않는다.
-- 작업자 수집본에 공식 상세 페이지 첨부로 기록된 판본만 트리거가 넣는다. 계정·분석 식별자는 남기지 않는다.
-- 같은 첨부 식별자에 서로 다른 해시·회차가 관찰되면 그 자리는 모호하므로 업로드 대조에 쓰지 않는다.
create table private.official_notice_document_index (
  document_id text not null
    check (document_id ~ '\Aapplyhome:[0-9]{10}:[0-9]{10}:[0-9]+:[0-9]+\Z'),
  house_manage_no text not null check (house_manage_no ~ '\A[0-9]{10}\Z'),
  notice_no text not null check (notice_no ~ '\A[0-9]{10}\Z'),
  edition text not null check (edition ~ '\A[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z'),
  sha256 text not null check (sha256 ~ '\A[0-9a-f]{64}\Z'),
  role text not null check (role in ('notice', 'correction', 'unclassified')),
  source text not null default 'official' check (source = 'official'),
  origin_check text not null default 'confirmed' check (origin_check = 'confirmed'),
  observed_at timestamptz not null default now(),
  primary key (document_id, sha256, edition),
  check (document_id like ('applyhome:' || house_manage_no || ':' || notice_no || ':%'))
);

create index official_notice_document_index_notice_idx
  on private.official_notice_document_index (house_manage_no, notice_no, edition);
create index official_notice_document_index_sha256_idx
  on private.official_notice_document_index (sha256);

alter table private.official_notice_document_index enable row level security;
revoke all on private.official_notice_document_index from public, anon, authenticated, service_role;

-- 수집본이 참조하는 소유자 업로드 문서와 public.analysis_uploads 행을 명시적으로 바인딩한다.
create table private.snapshot_upload_bindings (
  snapshot_id uuid not null references public.analysis_input_snapshots(id) on delete cascade,
  user_id uuid not null,
  analysis_id uuid not null,
  upload_id uuid not null,
  document_id text not null check (document_id = 'upload:' || upload_id::text),
  document_version text not null check (btrim(document_version) <> ''),
  created_at timestamptz not null default now(),
  primary key (snapshot_id, upload_id),
  foreign key (user_id, analysis_id, upload_id)
    references public.analysis_uploads(user_id, analysis_id, id) on delete cascade
);

create index snapshot_upload_bindings_owner_upload_idx
  on private.snapshot_upload_bindings (user_id, upload_id);

alter table private.snapshot_upload_bindings enable row level security;
revoke all on private.snapshot_upload_bindings from public, anon, authenticated, service_role;

-- 업로드 보완 실행을 등록 업로드와 기준 실행·수집본에 고정한다(대기·실행·실패 상태 포함).
create table private.upload_supplement_runs (
  run_id uuid primary key references private.analysis_runs(id) on delete cascade,
  user_id uuid not null,
  analysis_id uuid not null,
  upload_id uuid not null,
  base_run_id uuid references private.analysis_runs(id) on delete set null,
  base_snapshot_id uuid references public.analysis_input_snapshots(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (user_id, analysis_id, upload_id)
    references public.analysis_uploads(user_id, analysis_id, id) on delete cascade
);

create index upload_supplement_runs_analysis_base_idx
  on private.upload_supplement_runs (user_id, analysis_id, base_run_id);
create index upload_supplement_runs_owner_upload_idx
  on private.upload_supplement_runs (user_id, upload_id);

alter table private.upload_supplement_runs enable row level security;
revoke all on private.upload_supplement_runs from public, anon, authenticated, service_role;

-- upload_supplement 실행 유형과 업로드 전용 실패 사유를 허용하되 기존 notice·snapshot·synthetic 규칙은 유지한다.
alter table private.analysis_runs
  drop constraint analysis_runs_error_code_check,
  add constraint analysis_runs_error_code_check check (error_code in (
    'run_internal_error', 'run_deadline_exceeded',
    'notice_selection_unverified', 'notice_feed_unavailable', 'notice_source_restricted', 'notice_capture_limit',
    'upload_unavailable'
  )),
  drop constraint analysis_runs_notice_selection_check,
  add constraint analysis_runs_notice_selection_check check (
    (input->>'kind' in ('notice', 'upload_supplement')) = (notice_request is not null)
    and (notice_request is null) = (notice_house_type is null)
    and (
      (input->>'kind' = 'notice' and (error_code is null or error_code in (
        'run_internal_error', 'run_deadline_exceeded',
        'notice_selection_unverified', 'notice_feed_unavailable', 'notice_source_restricted', 'notice_capture_limit'
      )))
      or (input->>'kind' = 'upload_supplement' and (error_code is null or error_code in (
        'run_internal_error', 'run_deadline_exceeded',
        'notice_selection_unverified', 'notice_feed_unavailable', 'notice_source_restricted', 'notice_capture_limit',
        'upload_unavailable'
      )))
      or (input->>'kind' not in ('notice', 'upload_supplement') and (
        error_code is null or error_code in ('run_internal_error', 'run_deadline_exceeded')
      ))
    )
  );

-- canonical upload 문서 식별자('upload:<uuid>')에서 업로드 UUID를 추출한다.
create function private.bound_upload_uuid(p_document_id text)
returns uuid language sql immutable set search_path = '' as $$
  select case
    when p_document_id is not null
      and p_document_id ~ '\Aupload:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z'
    then substring(p_document_id from 8)::uuid
    else null
  end;
$$;

-- 실수집 스냅샷의 모든 source='upload' 문서가 같은 소유자·분석의 활성(registered) 업로드에 바인딩되었는지 확인·잠금한다.
create function private.verify_and_lock_snapshot_uploads(
  p_user_id uuid,
  p_analysis_id uuid,
  p_documents jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  doc jsonb;
  v_upload_id uuid;
begin
  for doc in
    select value
    from jsonb_array_elements(coalesce(p_documents, '[]'::jsonb))
    where value->>'source' = 'upload'
    order by value->>'id' collate "C"
  loop
    v_upload_id := private.bound_upload_uuid(doc->>'id');
    if v_upload_id is null then
      raise exception 'ingestion_upload_binding_required' using errcode = '42501';
    end if;
    perform 1
      from public.analysis_uploads u
      where (u.user_id, u.analysis_id, u.id) = (p_user_id, p_analysis_id, v_upload_id)
        and u.status = 'registered'
      for share;
    if not found then
      raise exception 'ingestion_upload_binding_required' using errcode = '42501';
    end if;
  end loop;
end;
$$;

-- 스냅샷 저장 직후 바인딩된 업로드 문서를 private.snapshot_upload_bindings에 기록한다.
create function private.record_snapshot_upload_bindings()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  doc jsonb;
  v_upload_id uuid;
begin
  for doc in
    select value
    from jsonb_array_elements(coalesce(new.result_snapshot#>'{catalog,documents}', '[]'::jsonb))
    where value->>'source' = 'upload'
  loop
    v_upload_id := private.bound_upload_uuid(doc->>'id');
    if v_upload_id is not null and exists (
      select 1 from public.analysis_uploads u
      where (u.user_id, u.analysis_id, u.id) = (new.user_id, new.analysis_id, v_upload_id)
    ) then
      insert into private.snapshot_upload_bindings(
        snapshot_id, user_id, analysis_id, upload_id, document_id, document_version
      ) values (
        new.id, new.user_id, new.analysis_id, v_upload_id, doc->>'id', doc->>'version'
      ) on conflict (snapshot_id, upload_id) do nothing;
    end if;
  end loop;
  return new;
end;
$$;

create trigger record_snapshot_upload_bindings
  after insert on public.analysis_input_snapshots
  for each row execute function private.record_snapshot_upload_bindings();

-- 실수집 저장 시 작업자가 공식 상세 페이지 첨부에서 내려받아 해시를 계산한 판본을 공식 색인에 남긴다.
-- 수집본 문서 목록에는 첨부 역할이 없으므로 'unclassified'로 둔다. 원본·정정 관계는 보완 실행 때 현재 상세 페이지로 다시 판정한다.
create function private.record_official_notice_documents()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.data_origin <> 'collected'
    or new.house_manage_no !~ '\A[0-9]{10}\Z' or new.notice_no !~ '\A[0-9]{10}\Z'
    or new.edition !~ '\A[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z' then
    return new;
  end if;
  insert into private.official_notice_document_index(
    document_id, house_manage_no, notice_no, edition, sha256, role
  )
  select distinct d.val->>'id', new.house_manage_no, new.notice_no, new.edition, substring(d.val->>'version' from 8),
    'unclassified'
  from jsonb_array_elements(coalesce(new.result_snapshot#>'{catalog,documents}', '[]'::jsonb)) as d(val)
  where d.val->>'source' = 'official'
    and d.val->>'originCheck' = 'confirmed'
    and d.val->>'version' ~ '\Asha256:[0-9a-f]{64}\Z'
    and d.val->>'id' ~ '\Aapplyhome:[0-9]{10}:[0-9]{10}:[0-9]+:[0-9]+\Z'
    and d.val->>'id' like ('applyhome:' || new.house_manage_no || ':' || new.notice_no || ':%')
    and (d.val->>'houseManageNo', d.val->>'noticeNo', d.val->>'edition')
      = (new.house_manage_no, new.notice_no, new.edition)
  on conflict do nothing;
  return new;
end;
$$;

create trigger record_official_notice_documents
  after insert on public.analysis_input_snapshots
  for each row execute function private.record_official_notice_documents();

-- 같은 첨부 식별자에 판본이 하나만 관찰된 공식 색인 행만 업로드 대조에 쓴다.
create function private.unambiguous_official_index(p_house_manage_no text, p_notice_no text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', idx.document_id,
        'houseManageNo', idx.house_manage_no,
        'noticeNo', idx.notice_no,
        'edition', idx.edition,
        'sha256', idx.sha256,
        'role', idx.role,
        'source', idx.source,
        'originCheck', idx.origin_check
      )
      order by idx.document_id collate "C", idx.edition collate "C"
    ),
    '[]'::jsonb
  )
  from private.official_notice_document_index idx
  where (idx.house_manage_no, idx.notice_no) = (p_house_manage_no, p_notice_no)
    and not exists (
      select 1 from private.official_notice_document_index other
      where other.document_id = idx.document_id
        and (other.sha256, other.edition) is distinct from (idx.sha256, idx.edition)
    );
$$;

create function private.snapshot_upload_doc_active(p_snapshot_id uuid, p_document_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from private.snapshot_upload_bindings b
    join public.analysis_uploads u
      on (u.user_id, u.analysis_id, u.id) = (b.user_id, b.analysis_id, b.upload_id)
    where b.snapshot_id = p_snapshot_id
      and b.document_id = p_document_id
      and u.status = 'registered'
  );
$$;

create function private.snapshot_bound_uploads_active(p_snapshot_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1
    from public.analysis_input_snapshots s
    cross join lateral jsonb_array_elements(coalesce(s.result_snapshot#>'{catalog,documents}', '[]'::jsonb)) as d(val)
    where s.id = p_snapshot_id
      and d.val->>'source' = 'upload'
      and not private.snapshot_upload_doc_active(s.id, d.val->>'id')
  );
$$;

-- BE-03 스냅샷 트리거: 미바인딩 업로드 문서는 계속 42501(ingestion_upload_binding_required)로 차단하되,
-- 같은 소유자·분석의 등록(registered) 업로드에 바인딩된 문서는 실수집 영속 저장을 허용한다.
create or replace function private.prepare_ingestion_snapshot()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  input jsonb := new.input_snapshot;
  result jsonb := new.result_snapshot;
  target jsonb := input->'target';
  period jsonb := result->'period';
  catalog jsonb := result->'catalog';
  regions jsonb := input->'requestRegionCodes';
  kinds jsonb := input->'tradeKinds';
  months jsonb;
  period_months jsonb;
  scope jsonb;
  coverage jsonb;
  catalog_refs jsonb;
  batch jsonb;
  trade jsonb;
  provenance jsonb;
  page integer;
  row_position bigint;
  source_id text;
  month text;
  collection_kind text;
  requested_sources text[];
  document_sources text[];
  storage_sources text[];
  permitted_source_count bigint;
  retention_enforcement_required boolean;
begin
  if not coalesce(private.ingestion_v0_object(input,array['noticeSource','target','asOf','start','end',
      'requestRegionCodes','tradeKinds','pageSize'])
    and private.ingestion_v0_object(target,array['houseManageNo','noticeNo','edition'])
    and target ?& array['houseManageNo','noticeNo','edition']
    and input->>'noticeSource' in ('applyhome_apt','applyhome_remainder')
    and input->>'asOf' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and pg_input_is_valid(input->>'asOf','date')
    and jsonb_typeof(regions) = 'array' and jsonb_typeof(kinds) = 'array'
    and (not input ? 'pageSize' or (jsonb_typeof(input->'pageSize') = 'number' and input->>'pageSize' ~ '^[1-9][0-9]*$')),
    false) then
    raise exception 'invalid_ingestion_request' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_each(target) as t(key,value)
      where jsonb_typeof(t.value) <> 'string' or t.value #>> '{}' = '' or t.value #>> '{}' <> btrim(t.value #>> '{}'))
    or jsonb_array_length(regions) = 0 or jsonb_array_length(kinds) = 0
    or exists (select 1 from jsonb_array_elements(regions) as r(value) where jsonb_typeof(r.value) <> 'string'
      or r.value #>> '{}' !~ '^[0-9]{5}$')
    or exists (select 1 from jsonb_array_elements(kinds) as k(value) where k.value not in ('"sale"'::jsonb,'"presale_right"'::jsonb,'"occupancy_right"'::jsonb))
    or (select count(distinct value) from jsonb_array_elements(regions)) <> jsonb_array_length(regions)
    or (select count(distinct value) from jsonb_array_elements(kinds)) <> jsonb_array_length(kinds) then
    raise exception 'invalid_ingestion_request_scope' using errcode = '22023';
  end if;

  if not coalesce(private.ingestion_v0_object(result,array['contractVersion','dataOrigin','target','asOf',
      'period','requestRegionCodes','tradeKinds','catalogCollections','catalog','tradeBatches'])
    and result->>'contractVersion' = 'ingestion/v0' and result->>'dataOrigin' in ('synthetic','collected')
    and result->'target' = target and result->'asOf' = input->'asOf'
    and result->'requestRegionCodes' = regions and result->'tradeKinds' = kinds
    and jsonb_typeof(result->'catalogCollections') = 'array' and jsonb_typeof(result->'tradeBatches') = 'array'
    and private.ingestion_v0_object(period,array['status','source','asOf','start','end','bounds','months','inProgressMonth','decision'])
    and period->'asOf' = input->'asOf' and period->>'bounds' = 'inclusive'
    and period->>'status' in ('confirmed','decision_required'), false)
    or jsonb_path_exists(result, 'strict $.** ? (@.type() == "object" &&
      (exists(@.body) || exists(@.response) || exists(@.payload) || exists(@.rawBody) || exists(@.rawApi) ||
       exists(@.rawPdf) || exists(@.rawResponse) || exists(@.pdfBytes) || exists(@.pdfText) || exists(@.fileBytes)))') then
    raise exception 'invalid_ingestion_result' using errcode = '22023';
  end if;

  new.as_of := (input->>'asOf')::date;
  new.page_size := coalesce((input->>'pageSize')::numeric,100);
  new.notice_source := input->>'noticeSource';
  new.house_manage_no := target->>'houseManageNo';
  new.notice_no := target->>'noticeNo';
  new.edition := target->>'edition';
  new.contract_version := result->>'contractVersion';
  new.data_origin := result->>'dataOrigin';

  if new.as_of < date '0002-01-01'
    or ((input->>'start' is null) <> (input->>'end' is null))
    or period->>'source' is distinct from (case when input->>'start' is null then 'default_recent_year' else 'user_confirmed' end) then
    raise exception 'invalid_ingestion_date_scope' using errcode = '22023';
  end if;
  if period->>'status' = 'confirmed' then
    if not coalesce(period->>'start' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and pg_input_is_valid(period->>'start','date')
      and period->>'end' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and pg_input_is_valid(period->>'end','date')
      and (case when input->>'start' is not null then input->'start' = period->'start' and input->'end' = period->'end'
        else input->'asOf' = period->'end' end), false) then
      raise exception 'invalid_ingestion_period' using errcode = '22023';
    end if;
    new.period_start := (period->>'start')::date;
    new.period_end := (period->>'end')::date;
    if new.period_start > new.period_end or new.period_end > new.as_of then
      raise exception 'invalid_ingestion_period' using errcode = '22023';
    end if;
    select jsonb_agg(to_char(boundary,'YYYYMM') order by boundary) into period_months
      from generate_series(date_trunc('month',new.period_start::timestamp),
        date_trunc('month',new.period_end::timestamp),interval '1 month') as m(boundary);
    months := period->'months';
    if months is distinct from period_months then
      raise exception 'invalid_ingestion_period_months' using errcode = '22023';
    end if;
  else
    if input->>'start' is not null or period->'start' is distinct from 'null'::jsonb
      or period->'end' is distinct from 'null'::jsonb or period->'months' is distinct from 'null'::jsonb
      or period#>>'{decision,decisionId}' is distinct from 'D-02' then
      raise exception 'invalid_ingestion_undecided_period' using errcode = '22023';
    end if;
    months := '[]'::jsonb;
  end if;

  document_sources := private.check_ingestion_v0_catalog(catalog,target,new.notice_source);
  scope := jsonb_build_object('cond[HOUSE_MANAGE_NO::EQ]',new.house_manage_no,'cond[PBLANC_NO::EQ]',new.notice_no);
  if jsonb_array_length(result->'catalogCollections') <> 2
    or (select count(distinct value->>'source') from jsonb_array_elements(result->'catalogCollections')) <> 2 then
    raise exception 'invalid_ingestion_catalog_collections' using errcode = '22023';
  end if;
  for coverage in select value from jsonb_array_elements(result->'catalogCollections') loop
    source_id := coverage->>'source';
    collection_kind := case when source_id = new.notice_source then 'notice' else 'model' end;
    if not coalesce(private.ingestion_v0_object(coverage,array['source','scope','status','pagesExpected','missingPages',
        'reportedTotalCount','rowsReceived','totalCountChanged','collectedAt','error','reasons'])
      and source_id in (new.notice_source,new.notice_source || '_model') and coverage->'scope' = scope
      and catalog#>array['collections',collection_kind,'source'] = coverage->'source'
      and catalog#>array['collections',collection_kind,'declaredStatus'] = coverage->'status'
      and catalog#>array['collections',collection_kind,'observations'] = coverage->'rowsReceived', false) then
      raise exception 'invalid_ingestion_catalog_collection_scope' using errcode = '22023';
    end if;
    perform private.check_ingestion_v0_coverage(coverage,coverage->'reasons',new.page_size);
    if collection_kind = 'notice' then
      catalog_refs := catalog#>'{notice,evidence}';
    else
      select coalesce(jsonb_agg(ref.value),'[]'::jsonb) into catalog_refs
        from jsonb_array_elements(catalog->'housingTypes') as m(value)
        cross join lateral jsonb_array_elements(m.value->'evidence') as ref(value);
    end if;
    if jsonb_array_length(catalog_refs) > (coverage->>'rowsReceived')::bigint
      or exists (select 1 from jsonb_array_elements(catalog_refs) as ref(value)
        group by ref.value->'page',ref.value->'position' having count(*) > 1)
      or exists (select 1 from jsonb_array_elements(catalog_refs) as ref(value)
        where not coalesce(private.ingestion_v0_object(ref.value,array['collection','page','position'])
          and ref.value->>'collection' = collection_kind
          and private.ingestion_v0_count(ref.value->'page',1,coalesce((coverage->>'pagesExpected')::integer,1))
          and private.ingestion_v0_count(ref.value->'position',1,9223372036854775807)
          and not (coverage->'missingPages' @> jsonb_build_array(ref.value->'page')), false)) then
      raise exception 'invalid_ingestion_catalog_locations' using errcode = '22023';
    end if;
  end loop;

  requested_sources := array_remove(array[
    case when kinds ? 'sale' then 'apt_trade' end,
    case when kinds ?| array['presale_right','occupancy_right'] then 'apt_rights' end],null);
  if jsonb_array_length(result->'tradeBatches') <> jsonb_array_length(regions)::bigint * jsonb_array_length(months) * cardinality(requested_sources)
    or exists (select 1 from jsonb_array_elements(result->'tradeBatches') as b(value)
      group by b.value#>>'{record,source}', b.value#>>'{record,requestRegionCode}', b.value#>>'{record,month}' having count(*) > 1)
    or exists (select 1 from jsonb_array_elements(result->'tradeBatches') as b(value)
      group by b.value#>>'{record,recordId}' having count(*) > 1) then
    raise exception 'invalid_ingestion_trade_batch_set' using errcode = '22023';
  end if;
  for batch in select value from jsonb_array_elements(result->'tradeBatches') loop
    coverage := batch->'record';
    source_id := coverage->>'source';
    month := coverage->>'month';
    if not coalesce(private.ingestion_v0_object(batch,array['record','reasons','trades'])
      and private.ingestion_v0_object(coverage,array['recordId','source','tradeKinds','requestRegionCode','month','status',
        'pagesExpected','missingPages','reportedTotalCount','rowsReceived','totalCountChanged','collectedAt','error'])
      and jsonb_typeof(coverage->'recordId') = 'string' and btrim(coverage->>'recordId') <> ''
      and source_id = any(requested_sources) and regions ? (coverage->>'requestRegionCode')
      and month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and months ? replace(month,'-','')
      and coverage->'tradeKinds' = (select jsonb_agg(value order by ordinality)
        from jsonb_array_elements(kinds) with ordinality
        where (source_id = 'apt_trade') = (value = '"sale"'::jsonb))
      and jsonb_typeof(batch->'trades') = 'array', false) then
      raise exception 'invalid_ingestion_trade_batch_scope' using errcode = '22023';
    end if;
    perform private.check_ingestion_v0_coverage(coverage,batch->'reasons',new.page_size);
    if to_jsonb(jsonb_array_length(batch->'trades')) <> coverage->'rowsReceived'
      or exists (select 1 from jsonb_array_elements(batch->'trades') as t(value)
        group by t.value#>'{provenance,page}',t.value#>'{provenance,position}' having count(*) > 1) then
      raise exception 'invalid_ingestion_trade_locations' using errcode = '22023';
    end if;
    scope := jsonb_build_object('LAWD_CD',coverage->>'requestRegionCode','DEAL_YMD',replace(month,'-',''));

    for trade in select value from jsonb_array_elements(batch->'trades') loop
      provenance := trade->'provenance';
      if not coalesce(private.ingestion_v0_object(trade,array['normalizerVersion','provenance','tradeKind',
          'tradeKindBasis','contractDate','amount','exclusiveArea','supplyArea','cancellation','identifiers','attributes',
          'withheldFields','checks','disposition','exclusionReason','exclusionReasons','issues','pendingReasons'])
        and trade->>'normalizerVersion' = 'ingestion-trades/v0' and private.ingestion_v0_object(provenance,array['source','request','page','position'])
        and provenance->>'source' = source_id and provenance->'request' = scope
        and private.ingestion_v0_count(provenance->'page',1,coalesce((coverage->>'pagesExpected')::integer,1))
        and private.ingestion_v0_count(provenance->'position',1,9223372036854775807)
        and not (coverage->'missingPages' @> jsonb_build_array(provenance->'page'))
        and (case when source_id = 'apt_trade' then trade->>'tradeKind' = 'sale'
          else trade->'tradeKind' = 'null'::jsonb or trade->>'tradeKind' in ('presale_right','occupancy_right') end)
        and trade->>'disposition' in ('excluded','held','follow_up_required')
        and trade#>>'{cancellation,status}' in ('cancelled','not_marked','unknown')
        and (trade#>'{contractDate,date}' = 'null'::jsonb or (trade#>>'{contractDate,date}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          and pg_input_is_valid(trade#>>'{contractDate,date}','date')))
        and (trade#>'{amount,won}' = 'null'::jsonb or (jsonb_typeof(trade#>'{amount,won}') = 'string'
          and trade#>>'{amount,won}' ~ '^[1-9][0-9]{0,19}$'))
        and trade#>>'{exclusiveArea,basis}' = 'exclusive' and (trade#>'{exclusiveArea,m2}' = 'null'::jsonb
          or (jsonb_typeof(trade#>'{exclusiveArea,m2}') = 'string' and length(trade#>>'{exclusiveArea,m2}') <= 24
            and trade#>>'{exclusiveArea,m2}' ~ '^([1-9][0-9]*(\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$'))
        and trade#>>'{supplyArea,basis}' = 'supply' and trade#>>'{supplyArea,status}' = 'unverified'
        and trade#>'{supplyArea,m2}' = 'null'::jsonb, false) then
        raise exception 'invalid_ingestion_trade_observation' using errcode = '22023';
      end if;
      page := (provenance->>'page')::integer;
      row_position := (provenance->>'position')::bigint;
      if coverage->>'status' = 'complete' and row_position > least(new.page_size,
          (coverage->>'reportedTotalCount')::bigint - (page - 1) * new.page_size) then
        raise exception 'invalid_ingestion_trade_position' using errcode = '22023';
      end if;
    end loop;
  end loop;

  select a.conditions_snapshot,a.rules_version,a.notice_id,a.housing_type_id
    into new.conditions_snapshot,new.rules_version,new.notice_id,new.housing_type_id
    from public.analyses a where (a.id,a.user_id) = (new.analysis_id,new.user_id) for share;
  if not found then
    raise exception 'ingestion_analysis_owner_mismatch' using errcode = '23503';
  end if;

  if new.conditions_snapshot ? 'ingestion_target' then
    if new.conditions_snapshot->'ingestion_target' is distinct from (target || jsonb_build_object('noticeSource',new.notice_source)) then
      raise exception 'ingestion_analysis_target_mismatch' using errcode = '22023';
    end if;
    new.target_binding_status := 'matched';
  elsif new.notice_id is not null then
    new.target_binding_status := 'unverified';
  else
    new.target_binding_status := 'unspecified';
  end if;

  if new.data_origin = 'collected' then
    if 'user_upload' = any(document_sources) then
      -- 소유자 등록 파일에 바인딩되지 않은 업로드는 계속 ingestion_upload_binding_required(42501)로 차단한다.
      perform private.verify_and_lock_snapshot_uploads(new.user_id, new.analysis_id, catalog->'documents');
    end if;
    storage_sources := array[new.notice_source,new.notice_source || '_model']
      || array(select src from unnest(document_sources) as s(src) where src is distinct from 'user_upload');
    if jsonb_array_length(months) > 0 then storage_sources := storage_sources || requested_sources; end if;
    select count(*),bool_or(permitted.retention_days is not null)
      into permitted_source_count,retention_enforcement_required
      from (select r.retention_days from public.source_registry r
        where r.id = any(storage_sources) and r.storage_permission = 'allowed' order by r.id for share) as permitted;
    if array_position(storage_sources,null) is not null
      or permitted_source_count <> (select count(distinct source) from unnest(storage_sources) as s(source)) then
      raise exception 'ingestion_storage_not_allowed' using errcode = '42501';
    end if;
    if retention_enforcement_required then
      raise exception 'ingestion_retention_enforcement_required' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

-- 공고 실행 캡처 판별에 upload_supplement를 포함한다.
create or replace function private.is_notice_run_capture(p_capture_key uuid, p_analysis_id uuid, p_user_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from private.analysis_runs r
    where (r.id, r.analysis_id, r.user_id) = (p_capture_key, p_analysis_id, p_user_id)
      and r.input->>'kind' in ('notice', 'upload_supplement')
  );
$$;

-- 바인딩된 활성(registered) 업로드 문서는 제3자 source_registry 대상에서 제외하되,
-- 미바인딩·삭제 요청된 업로드 문서와 comparison_evidence의 user_upload는 계속 차단한다.
create or replace function private.comparison_sources(p_snapshot_id uuid, p_evidence_sources text[])
returns text[] language sql stable set search_path = '' as $$
  select array(
    select c.source_id from public.ingestion_collections c where c.snapshot_id = p_snapshot_id
    union
    select 'applyhome_notice_pdf'
      from public.ingestion_document_versions d
      where d.snapshot_id = p_snapshot_id and d.acquisition_source = 'official'
    union
    select 'user_upload'
      from public.ingestion_document_versions d
      where d.snapshot_id = p_snapshot_id and d.acquisition_source = 'upload'
        and not private.snapshot_upload_doc_active(p_snapshot_id, d.document_id)
    union
    select 'mois_legal_region_codes' from public.analysis_input_snapshots s
      where s.id = p_snapshot_id and private.is_notice_run_capture(s.capture_key, s.analysis_id, s.user_id)
    union
    select unnest(p_evidence_sources)
  );
$$;

create or replace function private.read_analysis_comparison(p_analysis_id uuid, p_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  owner_id uuid := private.analysis_run_owner();
  saved record;
begin
  select r.snapshot_id, r.rules_version, c.result, c.source_ids
    into saved
    from private.analysis_runs r
    left join private.comparison_results c on c.run_id = r.id and r.status = 'finished'
    where (r.id, r.analysis_id, r.user_id) = (p_run_id, p_analysis_id, owner_id);
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;
  if saved.result is null then
    raise exception 'analysis_comparison_not_ready' using errcode = 'PT409';
  end if;
  if not private.comparison_sources_permitted(saved.source_ids)
    or (saved.result->>'dataOrigin' = 'collected' and not private.snapshot_bound_uploads_active(saved.snapshot_id)) then
    raise exception 'comparison_source_restricted' using errcode = 'PT403';
  end if;
  return jsonb_build_object(
    'runId', p_run_id,
    'analysisId', p_analysis_id,
    'snapshotId', saved.snapshot_id,
    'rulesVersion', saved.rules_version,
    'result', saved.result
  );
end;
$$;

-- 납부 일정 검증: 공식 PDF 외에 같은 공고·회차 확인과 활성 업로드 바인딩을 통과한 업로드 문서도 허용한다.
create or replace function private.check_funding_schedules(p_snapshot public.analysis_input_snapshots, p_schedules jsonb)
returns void language plpgsql stable set search_path = '' as $$
declare
  catalog jsonb := p_snapshot.result_snapshot->'catalog';
  verified_documents jsonb;
  schedule jsonb;
  room jsonb;
  price jsonb;
  price_evidence jsonb;
  installment jsonb;
  timing jsonb;
  date_status text;
  trigger_kind text;
  timing_refs jsonb;
  installment_sum numeric;
begin
  if jsonb_typeof(p_schedules) is distinct from 'array' then
    raise exception 'invalid_funding_schedules' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_schedules) as s(value)
    group by s.value->'modelNo',s.value->'houseType',s.value->'room',s.value->'item' having count(*) > 1
  ) then
    raise exception 'duplicate_funding_schedule_scope' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('document',d.document_id,'version',d.version)),'[]'::jsonb)
    into verified_documents
    from public.ingestion_document_versions d
    where d.snapshot_id = p_snapshot.id
      and d.status = 'accepted'
      and d.origin_check = 'confirmed'
      and (
        d.acquisition_source = 'official'
        or (
          d.acquisition_source = 'upload'
          and private.snapshot_upload_doc_active(p_snapshot.id, d.document_id)
        )
      )
      and (d.house_manage_no,d.notice_no,d.edition) = (p_snapshot.house_manage_no,p_snapshot.notice_no,p_snapshot.edition);

  for schedule in select value from jsonb_array_elements(p_schedules) loop
    if not coalesce(private.ingestion_v0_object(schedule,array['modelNo','houseType','room','item','status',
        'totalWon','reasons','evidence','installments'])
      and jsonb_typeof(schedule->'modelNo') = 'string' and schedule->>'modelNo' ~ '\A[0-9]{1,20}\Z'
      and jsonb_typeof(schedule->'houseType') = 'string' and private.funding_label_valid(schedule->>'houseType',false)
      and jsonb_typeof(schedule->'room') = 'string' and private.funding_label_valid(schedule->>'room',true)
      and schedule->>'item' in ('sale_price','required_options')
      and schedule->>'status' in ('confirmed','unverified','conflict')
      and jsonb_typeof(schedule->'reasons') = 'array' and jsonb_typeof(schedule->'installments') = 'array'
      and private.funding_schedule_refs_valid(schedule->'evidence',verified_documents),false) then
      raise exception 'invalid_funding_schedule' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(schedule->'reasons') as r(value)
      where jsonb_typeof(r.value) <> 'string' or r.value#>>'{}' !~ '\A[a-z][a-z0-9_]{0,79}\Z') then
      raise exception 'invalid_funding_schedule_reasons' using errcode = '22023';
    end if;

    if schedule->>'status' <> 'confirmed' then
      if schedule->'totalWon' is distinct from 'null'::jsonb
        or schedule->'installments' <> '[]'::jsonb or schedule->'reasons' = '[]'::jsonb then
        raise exception 'invalid_held_funding_schedule' using errcode = '22023';
      end if;
      continue;
    end if;

    select r.value into room from jsonb_array_elements(catalog->'rooms') as r(value)
      where (r.value->'modelNo',r.value->'houseType',r.value->'room') =
        (schedule->'modelNo',schedule->'houseType',schedule->'room');
    if room is null then
      raise exception 'funding_schedule_room_mismatch' using errcode = '22023';
    end if;
    if not private.funding_room_application_verified(catalog,room) then
      raise exception 'funding_schedule_room_unverified' using errcode = '22023';
    end if;
    price := case schedule->>'item' when 'sale_price' then room->'salePrice' else room->'requiredOptions' end;
    select jsonb_agg(r.value - 'evidenceIndex') into price_evidence
      from jsonb_array_elements(price->'evidence') as r(value);
    if not coalesce(price->>'status' = 'confirmed' and price->'won' = schedule->'totalWon'
      and schedule->'reasons' = '[]'::jsonb and schedule->'evidence' <> '[]'::jsonb
      and price_evidence @> (schedule->'evidence') and (schedule->'evidence') @> price_evidence,false) then
      raise exception 'funding_schedule_price_mismatch' using errcode = '22023';
    end if;

    installment_sum := 0;
    for installment in select value from jsonb_array_elements(schedule->'installments') loop
      timing := installment->'timing';
      date_status := timing->>'dateStatus';
      trigger_kind := timing->>'trigger';
      timing_refs := timing->'evidence';
      if not coalesce(private.ingestion_v0_object(installment,array['stage','won','timing'])
        and installment->>'stage' in ('deposit','interim','balance')
        and jsonb_typeof(installment->'won') = 'string' and installment->>'won' ~ '\A[1-9][0-9]{0,19}\Z'
        and private.ingestion_v0_object(timing,array['trigger','dateStatus','date','evidence'])
        and timing ? 'trigger' and private.funding_schedule_refs_valid(timing_refs,verified_documents)
        and (case date_status
          when 'exact' then trigger_kind in ('calendar_date','deadline','contract_signing','move_in')
            and jsonb_typeof(timing->'date') = 'string' and timing->>'date' ~ '\A[0-9]{4}-[0-9]{2}-[0-9]{2}\Z'
            and pg_input_is_valid(timing->>'date','date') and timing_refs <> '[]'::jsonb
          when 'relative' then trigger_kind in ('contract_signing','move_in')
          when 'range' then trigger_kind is null or trigger_kind in ('contract_signing','move_in')
          when 'unverified' then trigger_kind is null or trigger_kind in ('contract_signing','move_in')
          when 'missing' then trigger_kind is null
          else false end)
        and (date_status = 'exact' or (timing->'date' = 'null'::jsonb and timing_refs = '[]'::jsonb)),false) then
        raise exception 'invalid_funding_installment' using errcode = '22023';
      end if;
      if date_status = 'exact' and exists (
        (select r.value - 'page' from jsonb_array_elements(schedule->'evidence') as r(value)
          except select r.value - 'page' from jsonb_array_elements(timing_refs) as r(value))
        union all
        (select r.value - 'page' from jsonb_array_elements(timing_refs) as r(value)
          except select r.value - 'page' from jsonb_array_elements(schedule->'evidence') as r(value))
      ) then
        raise exception 'funding_installment_document_mismatch' using errcode = '22023';
      end if;
      installment_sum := installment_sum + (installment->>'won')::numeric;
    end loop;
    if installment_sum <> (schedule->>'totalWon')::numeric then
      raise exception 'funding_installment_sum_mismatch' using errcode = '22023';
    end if;
  end loop;
end;
$$;

-- 납부 일정이 실제로 사용한 문서 출처만 권한 대조한다(공식 PDF 전용 vs 바인딩된 소유자 업로드).
create function private.funding_schedule_sources_for_snapshot(
  p_snapshot_id uuid,
  p_notice_source text,
  p_schedules jsonb
) returns text[] language plpgsql stable security definer set search_path = '' as $$
declare
  has_official boolean := false;
  has_active_upload boolean := false;
  has_inactive_upload boolean := false;
  sources text[] := array[p_notice_source, p_notice_source || '_model'];
begin
  select
    coalesce(bool_or(d.acquisition_source = 'official'), false),
    coalesce(bool_or(d.acquisition_source = 'upload' and private.snapshot_upload_doc_active(p_snapshot_id, d.document_id)), false),
    coalesce(bool_or(d.acquisition_source = 'upload' and not private.snapshot_upload_doc_active(p_snapshot_id, d.document_id)), false)
    into has_official, has_active_upload, has_inactive_upload
    from public.ingestion_document_versions d
    where d.snapshot_id = p_snapshot_id;

  if has_official or (coalesce(p_schedules, '[]'::jsonb) <> '[]'::jsonb and not has_active_upload) then
    sources := array_append(sources, 'applyhome_notice_pdf');
  end if;
  if has_inactive_upload then
    sources := array_append(sources, 'user_upload');
  end if;
  return sources;
end;
$$;

create or replace function private.save_funding_schedule_snapshot(
  p_user_id uuid, p_analysis_id uuid, p_capture_key uuid, p_input jsonb, p_result jsonb, p_schedules jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  existing_id uuid;
  snapshot_id uuid;
  snapshot public.analysis_input_snapshots%rowtype;
  saved_schedules jsonb;
begin
  perform 1 from public.analyses a where (a.id,a.user_id) = (p_analysis_id,p_user_id) for no key update;
  if not found then
    raise exception 'ingestion_analysis_owner_mismatch' using errcode = '23503';
  end if;
  select s.id into existing_id from public.analysis_input_snapshots s
    where (s.user_id,s.analysis_id,s.capture_key) = (p_user_id,p_analysis_id,p_capture_key);
  if existing_id is null and exists (select 1 from private.analysis_runs r where r.id = p_capture_key) then
    raise exception 'analysis_run_fence_required' using errcode = '42501';
  end if;

  snapshot_id := public.save_ingestion_snapshot(p_user_id,p_analysis_id,p_capture_key,p_input,p_result);
  if existing_id is not null then
    select s.schedules into saved_schedules from private.analysis_funding_schedule_snapshots s where s.snapshot_id = existing_id;
    if coalesce(saved_schedules,'[]'::jsonb) is distinct from p_schedules then
      raise exception 'funding_schedule_capture_conflict' using errcode = '23505';
    end if;
    return snapshot_id;
  end if;

  select * into snapshot from public.analysis_input_snapshots s where s.id = snapshot_id;
  perform private.check_funding_schedules(snapshot,p_schedules);
  if snapshot.data_origin = 'collected' and p_schedules <> '[]'::jsonb then
    perform private.require_comparison_sources(
      private.funding_schedule_sources_for_snapshot(snapshot.id, snapshot.notice_source, p_schedules)
    );
  end if;
  insert into private.analysis_funding_schedule_snapshots(snapshot_id,schedules) values (snapshot_id,p_schedules);
  return snapshot_id;
end;
$$;

create or replace function private.read_analysis_funding_inputs(
  p_analysis_id uuid, p_snapshot_id uuid, p_model_no text, p_room text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  caller_id uuid := auth.uid();
  snapshot record;
  catalog jsonb;
  selected_room jsonb;
  schedule_status text := 'unavailable';
  schedules jsonb := '[]'::jsonb;
  funds jsonb;
begin
  if caller_id is null or coalesce(auth.jwt()->'is_anonymous','false'::jsonb) <> 'false'::jsonb
    or not exists (select 1 from auth.users u where u.id = caller_id and u.confirmed_at is not null
      and u.is_anonymous is false and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= statement_timestamp())) then
    raise exception 'funding_authentication_required' using errcode = '42501';
  end if;

  select s.*,a.conditions_snapshot as current_conditions,a.notice_id as current_notice_id,
    a.housing_type_id as current_housing_type_id,f.schedules as saved_schedules into snapshot
    from public.analysis_input_snapshots s
    join public.analyses a on (a.id,a.user_id) = (s.analysis_id,s.user_id)
    left join private.analysis_funding_schedule_snapshots f on f.snapshot_id = s.id
    where (s.id,s.analysis_id,s.user_id) = (p_snapshot_id,p_analysis_id,caller_id);
  if not found then
    raise exception 'analysis_snapshot_not_found' using errcode = 'PT404';
  end if;
  if p_model_no !~ '\A[0-9]{1,20}\Z' or not private.funding_label_valid(p_room,true) then
    raise exception 'invalid_funding_selection' using errcode = '22023';
  end if;

  if snapshot.saved_schedules <> '[]'::jsonb and snapshot.data_origin = 'collected'
    and not private.comparison_sources_permitted(
      private.funding_schedule_sources_for_snapshot(snapshot.id, snapshot.notice_source, snapshot.saved_schedules)
    ) then
    schedule_status := 'source_restricted';
  elsif snapshot.saved_schedules <> '[]'::jsonb then
    catalog := snapshot.result_snapshot->'catalog';
    select r.value into selected_room from jsonb_array_elements(catalog->'rooms') as r(value)
      where (r.value->>'modelNo',r.value->>'room') = (p_model_no,p_room);
    if snapshot.target_binding_status <> 'matched'
      or snapshot.notice_id is not null or snapshot.housing_type_id is not null
      or snapshot.current_notice_id is not null or snapshot.current_housing_type_id is not null
      or snapshot.current_conditions->'ingestion_target' is distinct from snapshot.conditions_snapshot->'ingestion_target'
      or not private.funding_selection_matches(snapshot.conditions_snapshot,p_model_no,p_room)
      or not private.funding_selection_matches(snapshot.current_conditions,p_model_no,p_room)
      or selected_room is null or not private.funding_room_application_verified(catalog,selected_room) then
      schedule_status := 'selection_unverified';
    else
      select coalesce(jsonb_agg(s.value order by s.position),'[]'::jsonb) into schedules
        from jsonb_array_elements(snapshot.saved_schedules) with ordinality as s(value,position)
        where (s.value->>'modelNo',s.value->>'room') = (p_model_no,p_room)
          and s.value->'houseType' = selected_room->'houseType';
      if schedules <> '[]'::jsonb then
        schedule_status := 'available';
      end if;
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'kind',f.kind,'amountWon',f.amount_won::text,
    'availableOn',f.available_on,'certainty',f.certainty) order by f.available_on,f.id),'[]'::jsonb)
    into funds from public.funding_entries f where (f.analysis_id,f.user_id) = (p_analysis_id,caller_id);
  return jsonb_build_object('analysisId',p_analysis_id,'snapshotId',p_snapshot_id,'modelNo',p_model_no,'room',p_room,
    'dataOrigin',snapshot.data_origin,'scheduleStatus',schedule_status,'schedules',schedules,'funds',funds);
end;
$$;

-- 업로드 보완 실행 완료 시 핀닝된 업로드의 활성 상태와 바인딩 일치를 확인한다(승인 기간 대화 가드 유지).
create or replace function private.finish_analysis_run_core(
  p_run_id uuid,
  p_generation integer,
  p_lease_token uuid,
  p_input jsonb,
  p_result jsonb,
  p_allow_approved_chat_period boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id,p_generation,p_lease_token);
  supplement_row private.upload_supplement_runs%rowtype;
  captured_id uuid;
  captured_key uuid;
  capture_sources text[];
  finished timestamptz;
begin
  if not p_allow_approved_chat_period and exists (
    select 1 from private.analysis_chat_turns t
    where (t.result_run_id, t.analysis_id, t.user_id) = (job.id, job.analysis_id, job.user_id)
      and t.proposal_status = 'approved'
  ) then
    raise exception 'comparison_finish_required' using errcode = '22023';
  end if;

  if job.input->>'kind' = 'snapshot' then
    if nullif(p_input,'null'::jsonb) is not null or nullif(p_result,'null'::jsonb) is not null then
      raise exception 'unexpected_analysis_run_payload' using errcode = '22023';
    end if;
    select s.id,s.capture_key into captured_id,captured_key from public.analysis_input_snapshots s
      where (s.id,s.analysis_id,s.user_id) = ((job.input->>'snapshotId')::uuid,job.analysis_id,job.user_id)
      for key share;
    if not found then
      raise exception 'analysis_run_snapshot_missing' using errcode = '22023';
    end if;
    if private.is_notice_run_capture(captured_key,job.analysis_id,job.user_id) then
      perform private.require_comparison_sources(private.comparison_sources(captured_id,null));
    end if;
  elsif job.input->>'kind' in ('notice', 'upload_supplement') then
    if not private.notice_capture_input_matches(job.notice_request,p_input)
      or jsonb_typeof(p_result) is distinct from 'object' or p_result->>'dataOrigin' is distinct from 'collected'
      or not private.notice_capture_period_matches(job.basis_date,p_result->'period') then
      raise exception 'invalid_notice_capture_payload' using errcode = '22023';
    end if;
    perform private.require_unchanged_run_inputs(job);

    if job.input->>'kind' = 'upload_supplement' then
      select * into supplement_row from private.upload_supplement_runs u
        where u.run_id = job.id;
      if not found then
        raise exception 'upload_supplement_not_found' using errcode = 'PT409';
      end if;
      perform 1 from public.analysis_uploads u
        where (u.user_id, u.analysis_id, u.id) = (job.user_id, job.analysis_id, supplement_row.upload_id)
          and u.status = 'registered'
        for share;
      if not found then
        raise exception 'upload_not_available' using errcode = 'PT409';
      end if;
      -- 업로드 보완 실행은 고정된 단일 업로드 ID 외의 다른 업로드 문서를 기록할 수 없다.
      if exists (
        select 1
        from jsonb_array_elements(coalesce(p_result#>'{catalog,documents}', '[]'::jsonb)) as d(val)
        where d.val->>'source' = 'upload'
          and d.val->>'id' is distinct from ('upload:' || supplement_row.upload_id::text)
      ) then
        raise exception 'invalid_notice_capture_payload' using errcode = '22023';
      end if;
    end if;

    capture_sources := private.notice_run_capture_sources(job.input->>'noticeSource');
    if jsonb_path_exists(p_result,'lax $.catalog.documents[*] ? (@.source == "official")') then
      capture_sources := array_append(capture_sources,'applyhome_notice_pdf');
    end if;
    perform private.require_notice_run_sources(capture_sources);
    captured_id := public.save_ingestion_snapshot(job.user_id,job.analysis_id,job.id,p_input,p_result);
    if not exists (select 1 from public.analysis_input_snapshots s
      where (s.id,s.analysis_id,s.user_id) = (captured_id,job.analysis_id,job.user_id) and s.target_binding_status = 'matched'
        and s.conditions_snapshot->'ingestion_target' = (p_input->'target' || jsonb_build_object('noticeSource',p_input->'noticeSource'))) then
      raise exception 'ingestion_analysis_target_mismatch' using errcode = '22023';
    end if;
    perform private.require_notice_capture_selection(job,p_result->'catalog');
  else
    if p_input is distinct from private.synthetic_ingestion_run_request()
      or p_result->>'dataOrigin' is distinct from 'synthetic' then
      raise exception 'invalid_synthetic_run_payload' using errcode = '22023';
    end if;
    perform private.require_unchanged_run_inputs(job);
    captured_id := public.save_ingestion_snapshot(job.user_id,job.analysis_id,job.id,p_input,p_result);
  end if;

  finished := clock_timestamp();
  if job.next_claim_at <= finished then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;
  update private.analysis_runs set status = 'finished', snapshot_id = captured_id,
    finished_at = finished, next_claim_at = null, lease_token = null where id = job.id returning * into job;
  return private.analysis_run_operation(job);
end;
$$;

-- 승인된 비교 조건 변경 검증이 근거 없는 업로드 보완(upload_supplement) 수집본에서도
-- 공고 실행(notice)과 동일한 주택형·수집목록 변조 방지 규칙을 적용하도록 확장한다.
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

-- 승인된 비교 조건 변경 검증(candidatePool 허용·check_approved_condition_comparison)과
-- 업로드 보완 실행의 기존 비교 근거 승계(동일 공고·회차·주소 대응 재확인)를 함께 수행한다.
create or replace function public.finish_analysis_comparison(
  p_run_id uuid, p_generation integer, p_lease_token uuid, p_input jsonb, p_result jsonb, p_comparison jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id, p_generation, p_lease_token);
  operation jsonb;
  captured_id uuid;
  snapshot public.analysis_input_snapshots%rowtype;
  approved_turn private.analysis_chat_turns%rowtype;
  base_snapshot_id uuid;
  base_ev private.comparison_evidence%rowtype;
  ev_target jsonb;
  ev_notice jsonb;
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

  -- 업로드 보완 실행은 기준 수집본에 등록된 비교 근거를 같은 공고·회차·주소 대응을 다시 확인한 뒤에만 승계한다.
  if job.input->>'kind' = 'upload_supplement' and snapshot.data_origin = 'collected' then
    select usr.base_snapshot_id into base_snapshot_id
      from private.upload_supplement_runs usr where usr.run_id = job.id;
    if base_snapshot_id is not null then
      select e.* into base_ev from private.comparison_evidence e where e.snapshot_id = base_snapshot_id;
      if found then
        ev_target := base_ev.evidence->'target';
        ev_notice := ev_target->'notice';
        if coalesce(
          ev_target->'houseManageNo' = to_jsonb(snapshot.house_manage_no)
          and ev_target->'noticeNo' = to_jsonb(snapshot.notice_no)
          and ev_target->'edition' = to_jsonb(snapshot.edition)
          and ev_notice->'source' = to_jsonb(snapshot.notice_source)
          and ev_notice->'address' = snapshot.result_snapshot#>'{catalog,notice,fields,HSSPLY_ADRES,value}'
          and snapshot.result_snapshot#>'{catalog,notice,evidence}' @>
            jsonb_build_array(jsonb_build_object('page', ev_notice->'page', 'position', ev_notice->'position')),
          false
        ) then
          perform private.require_comparison_sources(private.comparison_sources(captured_id, base_ev.source_ids));
          insert into private.comparison_evidence(snapshot_id, evidence, source_ids)
            values (captured_id, base_ev.evidence, base_ev.source_ids)
            on conflict (snapshot_id) do nothing;
          update private.analysis_runs set comparison_evidence_pinned = true where id = job.id;
          job.comparison_evidence_pinned := true;
        end if;
      end if;
    end if;
  end if;

  if snapshot.data_origin = 'collected' then
    sources := private.comparison_sources(captured_id, (select e.source_ids from private.comparison_evidence e
      where e.snapshot_id = captured_id and job.comparison_evidence_pinned));
    perform private.require_comparison_sources(sources);
  end if;
  insert into private.comparison_results(run_id, result, source_ids) values (job.id, p_comparison, sources);
  -- 비교 저장까지 마치기 전에 임대가 만료되면 실행과 캡처도 함께 롤백한다.
  if job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;
  return operation;
end;
$$;

create or replace function private.check_notice_run_comparison()
returns trigger language plpgsql set search_path = '' as $$
declare
  job private.analysis_runs%rowtype;
  capture_result jsonb;
  capture_period jsonb;
  has_pinned_evidence boolean;
begin
  select * into job from private.analysis_runs r
    where r.id = new.run_id and r.input->>'kind' in ('notice', 'upload_supplement');
  if not found then
    return new;
  end if;
  select s.result_snapshot into capture_result from public.analysis_input_snapshots s
    where (s.id,s.analysis_id,s.user_id) = (job.snapshot_id,job.analysis_id,job.user_id);
  capture_period := capture_result->'period';
  has_pinned_evidence := (job.input->>'kind' = 'upload_supplement' and job.comparison_evidence_pinned);

  if not coalesce(new.result->'target' @> (job.notice_request->'target')
    and new.result#>'{conditions,asOf}' = job.notice_request->'asOf'
    and new.result#>'{conditions,period}' = capture_period
    and (case when capture_period->>'status' = 'confirmed' then
      new.result#>'{target,modelNo}' = job.input->'modelNo'
      and jsonb_typeof(new.result#>'{target,houseType}') = 'string'
      and private.notice_run_house_type(new.result#>>'{target,houseType}') = job.notice_house_type
      and new.result#>'{conditions,tradeKinds}' = job.notice_request->'tradeKinds'
    else new.result#>'{target,modelNo}' = 'null'::jsonb
      and new.result#>'{target,houseType}' = 'null'::jsonb
      and new.result#>'{conditions,tradeKinds}' = '[]'::jsonb end)
    and (
      has_pinned_evidence
      or (
        new.result->>'completeness' <> 'complete'
        and new.result->'appliedScope' = 'null'::jsonb and new.result->'rankingComplete' = 'false'::jsonb
        and new.result->'comparables' = '[]'::jsonb and new.result->'targetReferences' = '[]'::jsonb
        and coalesce(new.result->'candidatePool', '[]'::jsonb) = '[]'::jsonb
        and new.result->'tradeKinds' = '{}'::jsonb and new.result->'exclusions' = '[]'::jsonb
        and new.result#>'{regionDecision,priority}' = 'null'::jsonb
        and new.result#>'{regionDecision,expansion}' = 'null'::jsonb
      )
    ), false)
    or jsonb_array_length(new.result->'collections') <> jsonb_array_length(capture_result->'tradeBatches')
    or exists (
      select 1 from jsonb_array_elements(capture_result->'tradeBatches') as b(batch)
      cross join lateral (select b.batch->'record' as record) as capture
      where not exists (
        select 1 from jsonb_array_elements(new.result->'collections') as c(value)
        where (c.value->'source',c.value->'requestRegionCode',c.value->'month',c.value->'tradeKinds')
          = (capture.record->'source',capture.record->'requestRegionCode',capture.record->'month',capture.record->'tradeKinds')
          and (c.value->'status' = capture.record->'status'
            or (c.value->>'status' = 'partial' and capture.record->>'status' in ('complete','empty')))
      )
    ) then
    raise exception 'invalid_notice_comparison_result' using errcode = '22023';
  end if;
  return new;
end;
$$;

create or replace function private.finish_notice_with_funding(
  p_run_id uuid, p_generation integer, p_lease_token uuid, p_input jsonb, p_result jsonb,
  p_comparison jsonb, p_schedules jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id,p_generation,p_lease_token);
  operation jsonb;
  snapshot public.analysis_input_snapshots%rowtype;
begin
  if job.input->>'kind' not in ('notice', 'upload_supplement') then
    raise exception 'notice_run_required' using errcode = '22023';
  end if;
  operation := public.finish_analysis_comparison(p_run_id,p_generation,p_lease_token,p_input,p_result,p_comparison);
  select * into strict snapshot from public.analysis_input_snapshots s
    where (s.id,s.capture_key,s.analysis_id,s.user_id) =
      ((operation->>'snapshotId')::uuid,job.id,job.analysis_id,job.user_id);
  if p_schedules <> '[]'::jsonb then
    perform private.require_comparison_sources(
      private.funding_schedule_sources_for_snapshot(snapshot.id, snapshot.notice_source, p_schedules)
    );
  end if;
  perform private.check_funding_schedules(snapshot,p_schedules);
  insert into private.analysis_funding_schedule_snapshots(snapshot_id,schedules) values (snapshot.id,p_schedules);
  if job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;
  return operation;
end;
$$;

create or replace function public.fail_notice_analysis_run(
  p_run_id uuid, p_generation integer, p_lease_token uuid, p_retryable boolean, p_error_code text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype;
  failed_at timestamptz;
  retry boolean;
begin
  if p_retryable is null then
    raise exception 'analysis_run_retryable_required' using errcode = '22023';
  end if;
  if p_error_code is null or p_error_code not in (
    'notice_selection_unverified', 'notice_feed_unavailable', 'notice_source_restricted', 'notice_capture_limit',
    'upload_unavailable'
  ) then
    raise exception 'invalid_notice_run_error_code' using errcode = '22023';
  end if;
  job := private.lock_leased_analysis_run(p_run_id,p_generation,p_lease_token);
  if job.input->>'kind' not in ('notice', 'upload_supplement') then
    raise exception 'notice_analysis_run_required' using errcode = '22023';
  end if;
  if p_error_code = 'upload_unavailable' and job.input->>'kind' <> 'upload_supplement' then
    raise exception 'invalid_notice_run_error_code' using errcode = '22023';
  end if;
  failed_at := clock_timestamp();
  retry := p_retryable and job.attempt < 3;
  update private.analysis_runs set status = case when retry then 'retry_wait' else 'failed' end,
    next_claim_at = case when retry then failed_at + make_interval(secs => job.attempt) end,
    finished_at = case when not retry then failed_at end, lease_token = null,
    error_code = case when not retry then p_error_code end where id = job.id returning * into job;
  return private.analysis_run_operation(job);
end;
$$;

-- 저장 보고서: 바인딩된 활성 소유자 업로드 문서가 포함된 수집본의 저장·읽기·내보내기를 허용하되,
-- 업로드가 삭제 요청/삭제되거나 미바인딩이면 계속 source_restricted로 차단한다.
create or replace function private.saved_report_payload(
  p_report public.reports,
  p_saved private.saved_analysis_reports,
  p_for_export boolean
) returns jsonb language plpgsql stable set search_path = '' set timezone = 'UTC' as $$
declare
  requires_rights boolean := (p_saved.data_origin = 'collected');
  uploads_active boolean := (not requires_rights) or private.snapshot_bound_uploads_active(p_saved.snapshot_id);

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
  comp_read_ok := uploads_active
    and (p_saved.comparison_value is not null)
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
    fund_read_ok := uploads_active
      and (p_saved.funding_state <> 'source_restricted')
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

create or replace function private.save_analysis_report(
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
  has_active_upload_doc boolean := false;
  has_inactive_upload_doc boolean := false;
  uploads_active boolean := true;
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
  -- 수집본이 인용한 소유자 업로드가 삭제 요청·삭제되었으면 비교·자금 섹션을 저장하지 않는다.
  uploads_active := (not requires_rights) or private.snapshot_bound_uploads_active(snapshot_row.id);
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
  elsif uploads_active and not comp_has_invalid_source
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
        coalesce(bool_or(d.value->>'source' = 'upload'
          and private.snapshot_upload_doc_active(snapshot_row.id, d.value->>'id')), false),
        coalesce(bool_or(d.value->>'source' = 'upload'
          and not private.snapshot_upload_doc_active(snapshot_row.id, d.value->>'id')), false),
        coalesce(bool_or(d.value->>'source' is null or d.value->>'source' not in ('official', 'upload')), false)
        into has_official_pdf, has_active_upload_doc, has_inactive_upload_doc, has_unknown_doc
        from jsonb_array_elements(coalesce(catalog->'documents', '[]'::jsonb)) as d(value);

      fund_sources := array(
        select s.src
        from (
          select distinct t.src
          from unnest(
            array[snapshot_row.notice_source, snapshot_row.notice_source || '_model']
            -- 바인딩된 소유자 업로드로만 확인한 일정은 공식 첨부 권한 대신 업로드의 활성 상태로 판정한다.
            || case when has_official_pdf
                   or (coalesce(saved_schedules, '[]'::jsonb) <> '[]'::jsonb and not has_active_upload_doc)
                 then array['applyhome_notice_pdf'] else '{}'::text[] end
            || case when has_inactive_upload_doc then array['user_upload'] else '{}'::text[] end
          ) as t(src)
        ) as s
        order by s.src collate "C"
      );
    end if;

    -- 비공개 호실 존재 여부를 드러내지 않도록 출처 권한을 카탈로그 대조보다 먼저 확인한다.
    if requires_rights and (not uploads_active or has_unknown_doc
      or not private.report_sources_allowed(true, fund_sources, false)) then
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
            (case when run_row.input->>'kind' in ('notice', 'upload_supplement') then run_row.input->'modelNo' end)
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

-- A-56: 업로드 1건 삭제 범위 확장 — 명시 바인딩 테이블(snapshot_upload_bindings, upload_supplement_runs)과
-- 재귀 파생 실행(스냅샷 재실행·비교 대화 후속 실행)을 모두 포함해 미리보기와 원자 삭제를 일치시킨다.
create or replace function private.resolve_upload_deletion_scope(
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

  select coalesce(array_agg(s.id order by s.id), '{}'::uuid[])
    into bound_snapshot_ids
    from public.analysis_input_snapshots s
    where (s.analysis_id, s.user_id) = (upload_row.analysis_id, p_owner_id)
      and (
        exists (
          select 1
          from private.snapshot_upload_bindings b
          where b.snapshot_id = s.id
            and (b.user_id, b.analysis_id, b.upload_id) = (p_owner_id, upload_row.analysis_id, p_upload_id)
        )
        or exists (
          select 1
          from private.upload_supplement_runs usr
          where usr.run_id = s.capture_key
            and (usr.user_id, usr.analysis_id, usr.upload_id) = (p_owner_id, upload_row.analysis_id, p_upload_id)
        )
        or exists (
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
        exists (
          select 1
          from private.upload_supplement_runs usr
          where usr.run_id = r.id
            and (usr.user_id, usr.analysis_id, usr.upload_id) = (p_owner_id, upload_row.analysis_id, p_upload_id)
        )
        or r.snapshot_id = any(bound_snapshot_ids)
        or (r.input->>'kind' = 'snapshot' and r.input->>'snapshotId' = any(bound_snapshot_texts))
        or (r.input->>'kind' = 'upload_supplement' and r.input->>'uploadId' = p_upload_id::text)
        or r.id in (
          select s.capture_key
          from public.analysis_input_snapshots s
          where s.id = any(bound_snapshot_ids)
        )
        or private.jsonb_mentions_uuid(r.conditions_snapshot, p_upload_id)
      )
    union
    select next_run.id
    from derived_runs dr
    join private.analysis_runs parent_r
      on parent_r.id = dr.run_id
      and parent_r.user_id = p_owner_id
    join private.analysis_runs next_run
      on (next_run.analysis_id, next_run.user_id) = (upload_row.analysis_id, p_owner_id)
      and (
        exists (
          select 1
          from private.analysis_chat_turns child
          where child.base_run_id = dr.run_id
            and child.user_id = p_owner_id
            and child.result_run_id = next_run.id
        )
        or (
          next_run.input->>'kind' = 'snapshot'
          and parent_r.snapshot_id is not null
          and next_run.input->>'snapshotId' = parent_r.snapshot_id::text
        )
      )
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

-- 업로드 보완 UI·API용 문서 요약(원문·URL·PDF 바이트 비노출).
create function private.upload_supplement_documents_summary(p_catalog jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', d.val->'id',
          'version', d.val->'version',
          'source', d.val->'source',
          'originCheck', d.val->'originCheck',
          'status', d.val->'status',
          'reasons', coalesce(d.val->'reasons', '[]'::jsonb),
          'houseManageNo', d.val->'houseManageNo',
          'noticeNo', d.val->'noticeNo',
          'edition', d.val->'edition'
        )
        order by d.ordinality
      )
      from jsonb_array_elements(coalesce(p_catalog->'documents', '[]'::jsonb)) with ordinality as d(val, ordinality)
    ),
    '[]'::jsonb
  );
$$;

create function private.upload_supplement_issues_summary(p_catalog jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'code', i.val->'code',
          'stage', i.val->'stage',
          'modelNo', i.val->'modelNo',
          'houseType', i.val->'houseType',
          'room', i.val->'room',
          'item', i.val->'item'
        )
        order by i.ordinality
      )
      from jsonb_array_elements(coalesce(p_catalog->'issues', '[]'::jsonb)) with ordinality as i(val, ordinality)
      where jsonb_typeof(i.val->'code') = 'string'
    ),
    '[]'::jsonb
  );
$$;

create function private.upload_supplement_run_payload(
  p_job private.analysis_runs,
  p_usr private.upload_supplement_runs,
  p_catalog jsonb default null
) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'contractVersion', 'upload-supplement-run/v1',
    'runId', p_job.id,
    'analysisId', p_job.analysis_id,
    'baseRunId', p_usr.base_run_id,
    'uploadId', p_usr.upload_id,
    'status', p_job.status,
    'attempt', p_job.attempt,
    'submittedAt', p_job.submitted_at,
    'finishedAt', p_job.finished_at,
    'snapshotId', p_job.snapshot_id,
    'errorCode', p_job.error_code,
    'input', p_job.input,
    'documents', case when p_catalog is null then '[]'::jsonb
      else private.upload_supplement_documents_summary(p_catalog) end,
    'issues', case when p_catalog is null then '[]'::jsonb
      else private.upload_supplement_issues_summary(p_catalog) end
  );
$$;

-- 소유자 화면이 특정 실행의 문서 확보·판본 보류 사유와 업로드 보완 대상 정보를 조회한다.
create function private.read_upload_supplement_context(p_analysis_id uuid, p_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  analysis_row public.analyses%rowtype;
  run_row private.analysis_runs%rowtype;
  snap_row public.analysis_input_snapshots%rowtype;
  comp_row private.comparison_results%rowtype;
  usr_row private.upload_supplement_runs%rowtype;
  has_usr boolean := false;
  has_snap boolean := false;
  has_comp boolean := false;
  has_schedules boolean := false;
  catalog jsonb := null;
  eligible boolean := false;
  needs_supplement boolean := false;
  v_notice_source text;
  v_house_manage_no text;
  v_notice_no text;
  v_edition text;
  v_model_no text;
  v_house_type text;
  v_room text;
  v_title text;
  v_has_accepted_doc boolean := false;
  v_has_doc_problem boolean := false;
  v_supply_unverified boolean := false;
  v_price_unverified boolean := false;
  reason_codes text[] := '{}';
  recent_supplements jsonb := '[]'::jsonb;
begin
  perform private.require_notice_run_user(owner_id);
  if p_analysis_id is null or p_run_id is null then
    raise exception 'invalid_upload_supplement_input' using errcode = '22023';
  end if;

  select * into analysis_row from public.analyses a
    where (a.id, a.user_id) = (p_analysis_id, owner_id);
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;

  select * into run_row from private.analysis_runs r
    where (r.id, r.analysis_id, r.user_id) = (p_run_id, p_analysis_id, owner_id);
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;

  select * into usr_row from private.upload_supplement_runs u
    where u.run_id = run_row.id and u.user_id = owner_id;
  has_usr := found;

  if run_row.snapshot_id is not null then
    select * into snap_row from public.analysis_input_snapshots s
      where (s.id, s.analysis_id, s.user_id) = (run_row.snapshot_id, p_analysis_id, owner_id);
    has_snap := found;
  end if;

  if has_snap and snap_row.data_origin = 'collected' then
    if not private.comparison_sources_permitted(private.comparison_sources(snap_row.id, null))
      or not private.snapshot_bound_uploads_active(snap_row.id) then
      raise exception 'comparison_source_restricted' using errcode = 'PT403';
    end if;
    catalog := snap_row.result_snapshot->'catalog';
  end if;

  if run_row.status = 'finished' then
    select * into comp_row from private.comparison_results c where c.run_id = run_row.id;
    has_comp := found;
  end if;

  if has_snap then
    select exists (
      select 1
      from private.analysis_funding_schedule_snapshots f,
           jsonb_array_elements(coalesce(f.schedules, '[]'::jsonb)) as sc(val)
      where f.snapshot_id = snap_row.id
        and sc.val->>'status' = 'confirmed'
    ) into has_schedules;
  end if;

  -- 대상 공고·회차·주택형·호실 추출
  v_notice_source := coalesce(
    run_row.input->>'noticeSource',
    snap_row.notice_source,
    run_row.conditions_snapshot#>>'{ingestion_target,noticeSource}'
  );
  v_house_manage_no := coalesce(
    run_row.input->>'houseManageNo',
    snap_row.house_manage_no,
    run_row.conditions_snapshot#>>'{ingestion_target,houseManageNo}'
  );
  v_notice_no := coalesce(
    run_row.input->>'noticeNo',
    snap_row.notice_no,
    run_row.conditions_snapshot#>>'{ingestion_target,noticeNo}'
  );
  v_edition := coalesce(
    run_row.input->>'edition',
    snap_row.edition,
    run_row.conditions_snapshot#>>'{ingestion_target,edition}'
  );
  v_model_no := coalesce(
    run_row.input->>'modelNo',
    case when has_comp then comp_row.result#>>'{target,modelNo}' end,
    run_row.conditions_snapshot#>>'{comparison,modelNo}',
    run_row.conditions_snapshot->>'modelNo',
    run_row.conditions_snapshot#>>'{housingType,modelNo}'
  );
  v_house_type := coalesce(
    run_row.notice_house_type,
    case when has_comp then comp_row.result#>>'{target,houseType}' end
  );
  if v_house_type is null and catalog is not null and v_model_no is not null then
    select m.val#>>'{houseType,value}' into v_house_type
      from jsonb_array_elements(coalesce(catalog->'housingTypes', '[]'::jsonb)) as m(val)
      where m.val->>'modelNo' = v_model_no
        and m.val->>'status' = 'linked'
        and m.val#>>'{houseType,status}' = 'reported'
      limit 1;
  end if;
  v_room := coalesce(
    run_row.conditions_snapshot#>>'{comparison,room}',
    run_row.conditions_snapshot->>'room',
    case when has_comp and comp_row.result#>>'{noticePrice,scope}' = 'selected_room'
      then comp_row.result#>>'{noticePrice,room}' end
  );
  v_title := coalesce(
    case when has_comp then comp_row.result#>>'{target,name}' end,
    case when catalog is not null then catalog#>>'{notice,fields,HOUSE_NM,value}' end,
    analysis_row.title
  );

  eligible := has_snap
    and run_row.status = 'finished'
    and snap_row.data_origin = 'collected'
    and snap_row.target_binding_status = 'matched'
    and v_notice_source in ('applyhome_apt', 'applyhome_remainder')
    and v_house_manage_no ~ '\A[0-9]{10}\Z'
    and v_notice_no ~ '\A[0-9]{10}\Z'
    and v_edition ~ '\A[0-9]{4}-[0-9]{2}-[0-9]{2}\Z'
    and v_model_no ~ '\A[0-9]{1,20}\Z'
    and v_house_type is not null
    and jsonb_array_length(coalesce(
      run_row.notice_request->'requestRegionCodes',
      snap_row.input_snapshot->'requestRegionCodes',
      '[]'::jsonb
    )) = 1;

  if eligible and catalog is not null then
    select exists (
      select 1 from jsonb_array_elements(coalesce(catalog->'documents', '[]'::jsonb)) as d(val)
      where d.val->>'status' = 'accepted' and d.val->>'originCheck' = 'confirmed'
    ) into v_has_accepted_doc;

    select exists (
      select 1 from jsonb_array_elements(coalesce(catalog->'documents', '[]'::jsonb)) as d(val)
      where (d.val->>'status' <> 'accepted' or d.val->>'originCheck' <> 'confirmed')
        and not (
          v_has_accepted_doc
          and d.val->>'status' = 'held'
          and d.val->>'originCheck' = 'confirmed'
          and coalesce(d.val->'reasons', '[]'::jsonb) <> '[]'::jsonb
          and coalesce(d.val->'reasons', '[]'::jsonb) <@ '["upload_duplicates_official","superseded_by_full_replacement"]'::jsonb
        )
    ) into v_has_doc_problem;

    if has_comp then
      v_supply_unverified := coalesce(comp_row.result#>>'{target,supplyArea,status}', 'unverified') <> 'confirmed';
      -- 호실을 고른 분석은 그 호실의 가격만 본다. 호실 미선택이면 보류된 호실도 보완 대상이다.
      v_price_unverified := coalesce(comp_row.result#>>'{noticePrice,status}', 'unverified') <> 'confirmed'
        or (coalesce(comp_row.result#>>'{noticePrice,scope}', '') <> 'selected_room'
          and jsonb_array_length(coalesce(comp_row.result#>'{noticePrice,heldRooms}', '[]'::jsonb)) > 0);
    end if;

    select array(
      select distinct r.code collate "C"
      from (
        select i.val->>'code' as code
          from jsonb_array_elements(coalesce(catalog->'issues', '[]'::jsonb)) as i(val)
          where jsonb_typeof(i.val->'code') = 'string'
        union all
        select r_elem.val #>> '{}' as code
          from jsonb_array_elements(coalesce(catalog->'documents', '[]'::jsonb)) as d(val)
          cross join lateral jsonb_array_elements(coalesce(d.val->'reasons', '[]'::jsonb)) as r_elem(val)
          where d.val->>'status' <> 'accepted'
            and jsonb_typeof(r_elem.val) = 'string'
            and not (
              v_has_accepted_doc
              and d.val->>'status' = 'held'
              and d.val->>'originCheck' = 'confirmed'
              and (r_elem.val #>> '{}') in ('upload_duplicates_official', 'superseded_by_full_replacement')
            )
        union all
        select h.val->>'reasonCode' as code
          from jsonb_array_elements(coalesce(case when has_comp then comp_row.result->'holds' end, '[]'::jsonb)) as h(val)
          where h.val->>'reasonCode' in (
            'target_supply_area_unverified', 'no_confirmed_room_subtotal', 'notice_room_price_unverified',
            'sale_price_unverified', 'required_options_unverified', 'subtotal_documents_differ',
            'document_origin_unverified', 'document_origin_conflict', 'room_subtotal_unverified'
          )
        union all
        select 'official_document_missing'::text where not v_has_accepted_doc
        union all
        select 'payment_schedule_missing'::text where not has_schedules and not v_has_accepted_doc
      ) as r
      where r.code is not null and btrim(r.code) <> ''
      order by 1
    ) into reason_codes;

    needs_supplement := (not v_has_accepted_doc)
      or v_has_doc_problem
      or v_supply_unverified
      or v_price_unverified
      or (not has_schedules)
      or cardinality(reason_codes) > 0;
  end if;

  select coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'runId', r.id,
          'baseRunId', u.base_run_id,
          'uploadId', u.upload_id,
          'status', r.status,
          'submittedAt', r.submitted_at,
          'finishedAt', r.finished_at,
          'snapshotId', r.snapshot_id,
          'errorCode', r.error_code
        )
        order by r.submitted_at desc, r.id desc
      )
      from (
        select u.run_id, u.base_run_id, u.upload_id, r.id, r.status, r.submitted_at, r.finished_at, r.snapshot_id, r.error_code
        from private.upload_supplement_runs u
        join private.analysis_runs r on r.id = u.run_id
        where (u.user_id, u.analysis_id) = (owner_id, p_analysis_id)
        order by r.submitted_at desc, r.id desc
        limit 10
      ) as sub(run_id, base_run_id, upload_id, id, status, submitted_at, finished_at, snapshot_id, error_code)
      cross join lateral (select sub.id, sub.status, sub.submitted_at, sub.finished_at, sub.snapshot_id, sub.error_code) as r
      cross join lateral (select sub.base_run_id, sub.upload_id) as u
    ),
    '[]'::jsonb
  ) into recent_supplements;

  return jsonb_build_object(
    'contractVersion', 'upload-supplement-context/v1',
    'analysisId', p_analysis_id,
    'runId', p_run_id,
    'runStatus', run_row.status,
    'snapshotId', run_row.snapshot_id,
    'eligible', eligible,
    'needsSupplement', needs_supplement,
    'target', jsonb_build_object(
      'title', v_title,
      'noticeSource', v_notice_source,
      'houseManageNo', v_house_manage_no,
      'noticeNo', v_notice_no,
      'edition', v_edition,
      'modelNo', v_model_no,
      'houseType', v_house_type,
      'room', v_room
    ),
    'reasonCodes', to_jsonb(reason_codes),
    'documents', case when catalog is null then '[]'::jsonb
      else private.upload_supplement_documents_summary(catalog) end,
    'issues', case when catalog is null then '[]'::jsonb
      else private.upload_supplement_issues_summary(catalog) end,
    'currentSupplement', case when has_usr then jsonb_build_object(
      'uploadId', usr_row.upload_id,
      'baseRunId', usr_row.base_run_id
    ) else null end,
    'recentSupplements', recent_supplements,
    'uploadRules', jsonb_build_object(
      'bucket', 'analysis-uploads',
      'accept', 'application/pdf',
      'maxBytes', 52428800,
      'sameNoticeRequired', true
    )
  );
end;
$$;

-- 소유자가 등록·업로드 완료한 비공개 PDF로 같은 공고·주택형·호실의 새 보완 실행을 접수한다.
create function private.enqueue_upload_supplement_run(
  p_analysis_id uuid,
  p_base_run_id uuid,
  p_upload_id uuid,
  p_idempotency_key uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  fixed public.analyses%rowtype;
  existing_job private.analysis_runs%rowtype;
  existing_usr private.upload_supplement_runs%rowtype;
  existing_snap public.analysis_input_snapshots%rowtype;
  base_job private.analysis_runs%rowtype;
  base_snap public.analysis_input_snapshots%rowtype;
  upload_row public.analysis_uploads%rowtype;
  v_notice_source text;
  v_house_manage_no text;
  v_notice_no text;
  v_edition text;
  v_model_no text;
  v_house_type text;
  v_region_codes jsonb;
  v_basis date;
  v_notice_request jsonb;
  v_input jsonb;
  submitted timestamptz;
  new_job private.analysis_runs%rowtype;
  new_usr private.upload_supplement_runs%rowtype;
begin
  perform private.require_notice_run_user(owner_id);
  if p_analysis_id is null or p_base_run_id is null or p_upload_id is null or p_idempotency_key is null then
    raise exception 'invalid_upload_supplement_input' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('homecierge:analysis-runs:' || owner_id::text, 0));

  select * into fixed from public.analyses a
    where (a.id, a.user_id) = (p_analysis_id, owner_id) for no key update;
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;

  -- 멱등 재전송을 대상 상태·속도 제한보다 먼저 확인한다.
  select * into existing_job from private.analysis_runs r
    where (r.analysis_id, r.idempotency_key) = (p_analysis_id, p_idempotency_key);
  if found then
    select * into existing_usr from private.upload_supplement_runs u where u.run_id = existing_job.id;
    if not found
      or existing_job.input->>'kind' is distinct from 'upload_supplement'
      or existing_usr.base_run_id is distinct from p_base_run_id
      or existing_usr.upload_id is distinct from p_upload_id then
      raise exception 'upload_supplement_conflict' using errcode = 'PT409';
    end if;
    if existing_job.snapshot_id is not null then
      select * into existing_snap from public.analysis_input_snapshots s where s.id = existing_job.snapshot_id;
    end if;
    return private.upload_supplement_run_payload(
      existing_job,
      existing_usr,
      case when existing_job.snapshot_id is not null then existing_snap.result_snapshot->'catalog' else null end
    );
  end if;

  select * into base_job from private.analysis_runs r
    where (r.id, r.analysis_id, r.user_id) = (p_base_run_id, p_analysis_id, owner_id) for key share;
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;
  if base_job.status <> 'finished' or base_job.snapshot_id is null then
    raise exception 'upload_supplement_base_not_ready' using errcode = 'PT409';
  end if;

  select * into base_snap from public.analysis_input_snapshots s
    where (s.id, s.analysis_id, s.user_id) = (base_job.snapshot_id, p_analysis_id, owner_id) for key share;
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;
  if base_snap.data_origin <> 'collected' or base_snap.target_binding_status <> 'matched'
    or base_job.notice_id is not null or base_job.housing_type_id is not null
    or fixed.notice_id is not null or fixed.housing_type_id is not null then
    raise exception 'upload_supplement_not_eligible' using errcode = 'PT409';
  end if;
  if (fixed.conditions_snapshot, fixed.rules_version) is distinct from (base_job.conditions_snapshot, base_job.rules_version) then
    raise exception 'upload_supplement_conflict' using errcode = 'PT409';
  end if;

  -- 업로드 파일의 소유권·활성 상태·실제 비공개 버킷 적재 여부를 확인한다.
  select * into upload_row from public.analysis_uploads u
    where (u.user_id, u.analysis_id, u.id) = (owner_id, p_analysis_id, p_upload_id)
    for share;
  if not found then
    raise exception 'upload_not_found' using errcode = 'PT404';
  end if;
  if upload_row.status <> 'registered' then
    raise exception 'upload_not_available' using errcode = 'PT409';
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'analysis-uploads'
      and o.name collate "C" = upload_row.object_path
  ) then
    raise exception 'upload_file_missing' using errcode = 'PT409';
  end if;

  v_notice_source := base_snap.notice_source;
  v_house_manage_no := base_snap.house_manage_no;
  v_notice_no := base_snap.notice_no;
  v_edition := base_snap.edition;
  v_model_no := coalesce(
    base_job.input->>'modelNo',
    base_job.conditions_snapshot#>>'{comparison,modelNo}',
    base_job.conditions_snapshot->>'modelNo',
    base_job.conditions_snapshot#>>'{housingType,modelNo}'
  );
  v_house_type := base_job.notice_house_type;
  if v_house_type is null and v_model_no is not null then
    select private.notice_run_house_type(m.val#>>'{houseType,value}') into v_house_type
      from jsonb_array_elements(coalesce(base_snap.result_snapshot#>'{catalog,housingTypes}', '[]'::jsonb)) as m(val)
      where m.val->>'modelNo' = v_model_no
        and m.val->>'status' = 'linked'
        and m.val#>>'{houseType,status}' = 'reported'
        and jsonb_typeof(m.val#>'{houseType,value}') = 'string'
      limit 1;
  end if;
  v_region_codes := coalesce(
    base_job.notice_request->'requestRegionCodes',
    base_snap.input_snapshot->'requestRegionCodes'
  );
  v_basis := coalesce(base_job.basis_date, base_snap.as_of);

  if v_notice_source not in ('applyhome_apt', 'applyhome_remainder')
    or v_house_manage_no !~ '\A[0-9]{10}\Z'
    or v_notice_no !~ '\A[0-9]{10}\Z'
    or v_edition !~ '\A[0-9]{4}-[0-9]{2}-[0-9]{2}\Z'
    or v_model_no is null or v_model_no !~ '\A[0-9]{1,20}\Z'
    or v_house_type is null or btrim(v_house_type) = ''
    or jsonb_typeof(v_region_codes) <> 'array' or jsonb_array_length(v_region_codes) <> 1
    or (v_region_codes->>0) !~ '\A[0-9]{5}\Z' then
    raise exception 'upload_supplement_not_eligible' using errcode = 'PT409';
  end if;

  perform private.require_notice_run_sources(private.notice_run_capture_sources(v_notice_source));

  submitted := clock_timestamp();
  if (select count(*) from private.analysis_runs r
    where r.user_id = owner_id and r.submitted_at > submitted - interval '60 seconds') >= 12 then
    raise exception 'analysis_run_rate_limited' using errcode = 'PT429';
  end if;

  v_input := jsonb_build_object(
    'kind', 'upload_supplement',
    'baseRunId', p_base_run_id,
    'uploadId', p_upload_id,
    'noticeSource', v_notice_source,
    'houseManageNo', v_house_manage_no,
    'noticeNo', v_notice_no,
    'edition', v_edition,
    'modelNo', v_model_no
  );
  v_notice_request := private.notice_run_request(v_input, v_basis, v_region_codes->>0);

  insert into private.analysis_runs(
    analysis_id, user_id, idempotency_key, input, conditions_snapshot, profile_revision,
    rules_version, notice_id, housing_type_id, basis_date, submitted_at, next_claim_at,
    notice_request, notice_house_type
  ) values (
    p_analysis_id, owner_id, p_idempotency_key, v_input, fixed.conditions_snapshot,
    (select p.revision from public.user_profiles p where p.user_id = owner_id),
    fixed.rules_version, null, null, v_basis, submitted, submitted,
    v_notice_request, v_house_type
  ) returning * into new_job;

  insert into private.upload_supplement_runs(
    run_id, user_id, analysis_id, upload_id, base_run_id, base_snapshot_id
  ) values (
    new_job.id, owner_id, p_analysis_id, p_upload_id, p_base_run_id, base_snap.id
  ) returning * into new_usr;

  return private.upload_supplement_run_payload(new_job, new_usr, null);
end;
$$;

-- 소유자가 특정 업로드 보완 실행의 진행 상태와 문서 대조·점검 결과를 조회한다.
create function private.get_upload_supplement_run(p_analysis_id uuid, p_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  job private.analysis_runs%rowtype;
  usr private.upload_supplement_runs%rowtype;
  snap public.analysis_input_snapshots%rowtype;
  catalog jsonb := null;
begin
  perform private.require_notice_run_user(owner_id);
  if p_analysis_id is null or p_run_id is null then
    raise exception 'invalid_upload_supplement_input' using errcode = '22023';
  end if;

  select u.* into usr from private.upload_supplement_runs u
    where (u.run_id, u.analysis_id, u.user_id) = (p_run_id, p_analysis_id, owner_id);
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;

  select r.* into strict job from private.analysis_runs r
    where (r.id, r.analysis_id, r.user_id) = (p_run_id, p_analysis_id, owner_id);

  if job.status = 'finished' and job.snapshot_id is not null then
    select s.* into snap from public.analysis_input_snapshots s
      where (s.id, s.analysis_id, s.user_id) = (job.snapshot_id, p_analysis_id, owner_id);
    if found and snap.data_origin = 'collected' then
      if not private.comparison_sources_permitted(private.comparison_sources(snap.id, null))
        or not private.snapshot_bound_uploads_active(snap.id) then
        raise exception 'comparison_source_restricted' using errcode = 'PT403';
      end if;
      catalog := snap.result_snapshot->'catalog';
    end if;
  end if;

  return private.upload_supplement_run_payload(job, usr, catalog);
end;
$$;

-- 작업자 전용: read_comparison_work를 수정하지 않고 업로드 보완 작업 입력과 서버 공식 해시 색인을 읽는다.
create function public.read_upload_supplement_work(
  p_run_id uuid,
  p_generation integer,
  p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id, p_generation, p_lease_token);
  usr private.upload_supplement_runs%rowtype;
  upload_row public.analysis_uploads%rowtype;
  base_ev private.comparison_evidence%rowtype;
  has_base_ev boolean := false;
  official_index jsonb := '[]'::jsonb;
  notice_capture jsonb;
begin
  if job.input->>'kind' is distinct from 'upload_supplement' then
    raise exception 'upload_supplement_run_required' using errcode = '22023';
  end if;

  perform private.require_unchanged_run_inputs(job);
  perform private.require_notice_run_sources(private.notice_run_capture_sources(job.input->>'noticeSource'));

  select * into usr from private.upload_supplement_runs u where u.run_id = job.id;
  if not found then
    raise exception 'upload_unavailable' using errcode = 'PT422';
  end if;

  select * into upload_row from public.analysis_uploads u
    where (u.user_id, u.analysis_id, u.id) = (job.user_id, job.analysis_id, usr.upload_id)
      and u.status = 'registered'
    for share;
  if not found then
    raise exception 'upload_unavailable' using errcode = 'PT422';
  end if;

  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'analysis-uploads'
      and o.name collate "C" = upload_row.object_path
  ) then
    raise exception 'upload_unavailable' using errcode = 'PT422';
  end if;

  if usr.base_snapshot_id is not null then
    select e.* into base_ev from private.comparison_evidence e where e.snapshot_id = usr.base_snapshot_id;
    if found and private.comparison_sources_permitted(base_ev.source_ids) then
      has_base_ev := true;
    end if;
  end if;

  -- 같은 공고 번호쌍의 모든 회차 공식 첨부 해시를 함께 전달해 다른 회차 충돌도 즉시 대조한다.
  official_index := private.unambiguous_official_index(job.input->>'houseManageNo', job.input->>'noticeNo');

  notice_capture := jsonb_build_object(
    'asOf', job.notice_request->'asOf',
    'requestRegionCodes', job.notice_request->'requestRegionCodes',
    'allowOfficialPdf', private.comparison_sources_permitted(array['applyhome_notice_pdf'])
  );

  if job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;

  return jsonb_build_object(
    'conditions', job.conditions_snapshot,
    'upload', jsonb_build_object(
      'uploadId', upload_row.id,
      'objectPath', upload_row.object_path
    ),
    'baseRunId', usr.base_run_id,
    'baseSnapshotId', usr.base_snapshot_id,
    'evidence', case when has_base_ev then base_ev.evidence else null end,
    'officialIndex', official_index,
    'useSyntheticFixture', false,
    'selectionBindingIssue', null,
    'noticeCapture', notice_capture
  );
end;
$$;

-- 작업자 전용: 업로드 PDF의 서버 계산 SHA-256으로 다른 공고의 공식 첨부와 같은 파일인지 조회한다.
-- 같은 번호쌍의 기록은 read_upload_supplement_work가 모호한 자리를 뺀 뒤 전달하므로 여기서는 돌려주지 않는다.
create function public.lookup_official_notice_document_index(
  p_run_id uuid,
  p_generation integer,
  p_lease_token uuid,
  p_sha256 text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id, p_generation, p_lease_token);
  rows_json jsonb;
begin
  if job.input->>'kind' is distinct from 'upload_supplement' then
    raise exception 'upload_supplement_run_required' using errcode = '22023';
  end if;
  if p_sha256 is null or p_sha256 !~ '\A[0-9a-f]{64}\Z' then
    raise exception 'invalid_document_sha256' using errcode = '22023';
  end if;
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', idx.document_id,
        'houseManageNo', idx.house_manage_no,
        'noticeNo', idx.notice_no,
        'edition', idx.edition,
        'sha256', idx.sha256,
        'role', idx.role,
        'source', idx.source,
        'originCheck', idx.origin_check
      )
      order by idx.document_id collate "C"
    ),
    '[]'::jsonb
  ) into rows_json
  from private.official_notice_document_index idx
  where idx.sha256 = p_sha256
    and (idx.house_manage_no, idx.notice_no) is distinct from (job.input->>'houseManageNo', job.input->>'noticeNo');
  return rows_json;
end;
$$;

-- 공용 얇은 invoker 진입점 (PostgREST 호환).
create function public.read_upload_supplement_context(p_analysis_id uuid, p_run_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.read_upload_supplement_context(p_analysis_id, p_run_id);
$$;

create function public.enqueue_upload_supplement_run(
  p_analysis_id uuid,
  p_base_run_id uuid,
  p_upload_id uuid,
  p_idempotency_key uuid
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.enqueue_upload_supplement_run(p_analysis_id, p_base_run_id, p_upload_id, p_idempotency_key);
$$;

create function public.get_upload_supplement_run(p_analysis_id uuid, p_run_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.get_upload_supplement_run(p_analysis_id, p_run_id);
$$;

revoke all on function
  private.bound_upload_uuid(text),
  private.verify_and_lock_snapshot_uploads(uuid, uuid, jsonb),
  private.record_snapshot_upload_bindings(),
  private.snapshot_upload_doc_active(uuid, text),
  private.snapshot_bound_uploads_active(uuid),
  private.funding_schedule_sources_for_snapshot(uuid, text, jsonb),
  private.upload_supplement_documents_summary(jsonb),
  private.upload_supplement_issues_summary(jsonb),
  private.upload_supplement_run_payload(private.analysis_runs, private.upload_supplement_runs, jsonb),
  private.read_upload_supplement_context(uuid, uuid),
  private.enqueue_upload_supplement_run(uuid, uuid, uuid, uuid),
  private.get_upload_supplement_run(uuid, uuid),
  public.read_upload_supplement_context(uuid, uuid),
  public.enqueue_upload_supplement_run(uuid, uuid, uuid, uuid),
  public.get_upload_supplement_run(uuid, uuid),
  public.read_upload_supplement_work(uuid, integer, uuid),
  public.lookup_official_notice_document_index(uuid, integer, uuid, text),
  private.record_official_notice_documents(),
  private.unambiguous_official_index(text, text),
  private.check_approved_condition_comparison(private.analysis_runs, public.analysis_input_snapshots, private.analysis_chat_turns, jsonb)
from public, anon, authenticated, service_role;

grant execute on function
  private.verify_and_lock_snapshot_uploads(uuid, uuid, jsonb),
  public.read_upload_supplement_work(uuid, integer, uuid),
  public.lookup_official_notice_document_index(uuid, integer, uuid, text)
to service_role;

grant execute on function
  private.read_upload_supplement_context(uuid, uuid),
  private.enqueue_upload_supplement_run(uuid, uuid, uuid, uuid),
  private.get_upload_supplement_run(uuid, uuid),
  public.read_upload_supplement_context(uuid, uuid),
  public.enqueue_upload_supplement_run(uuid, uuid, uuid, uuid),
  public.get_upload_supplement_run(uuid, uuid)
to authenticated;

notify pgrst, 'reload schema';
