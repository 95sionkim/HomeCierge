-- 수집 결과와 실행 시점의 분석 입력을 한 번에 고정한다. 자료는 분석 소유자만 조회한다.
create table public.analysis_input_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  analysis_id uuid not null,
  capture_key uuid not null,
  input_snapshot jsonb not null,
  result_snapshot jsonb not null,
  conditions_snapshot jsonb not null,
  rules_version text not null,
  notice_id uuid,
  housing_type_id uuid,
  target_binding_status text not null check (target_binding_status in ('matched','unverified','unspecified')),
  contract_version text not null,
  data_origin text not null check (data_origin in ('synthetic','collected')),
  notice_source text not null,
  house_manage_no text not null,
  notice_no text not null,
  edition text not null,
  as_of date not null,
  period_start date,
  period_end date,
  page_size numeric not null,
  created_at timestamptz not null default now(),
  foreign key (analysis_id,user_id) references public.analyses(id,user_id) on delete cascade,
  unique (user_id,analysis_id,capture_key)
);
create index analysis_input_snapshots_owner_created_idx
  on public.analysis_input_snapshots(user_id,created_at desc,id);

alter table public.analysis_input_snapshots enable row level security;
revoke all on public.analysis_input_snapshots from public, anon, authenticated, service_role;
grant select on public.analysis_input_snapshots to authenticated, service_role;
grant insert(user_id,analysis_id,capture_key,input_snapshot,result_snapshot)
  on public.analysis_input_snapshots to service_role;
create policy owner_read on public.analysis_input_snapshots for select to authenticated using (
  (select auth.uid()) = user_id and coalesce(((select auth.jwt())->>'is_anonymous'),'false') = 'false'
);

create function private.ingestion_v0_object(value jsonb, allowed_keys text[])
returns boolean language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(value) = 'object' then value - allowed_keys = '{}'::jsonb else false end;
$$;

-- 숫자형 정수만 받아 조회 뷰에서 범위를 벗어난 캐스트가 발생하지 않게 한다.
create function private.ingestion_v0_count(value jsonb, minimum bigint, maximum bigint)
returns boolean language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(value) = 'number' and value::text ~ '^[0-9]+$'
    then value::numeric between minimum and maximum else false end;
$$;

create function private.check_ingestion_v0_coverage(coverage jsonb, reasons jsonb, page_size numeric)
returns void language plpgsql set search_path = '' as $$
declare
  state text := coverage->>'status';
  pages integer;
  total bigint;
  received bigint;
  missing jsonb := coverage->'missingPages';
  stamp text := coverage->>'collectedAt';
  error_value jsonb := coverage->'error';
begin
  if not coalesce(state in ('complete','empty','partial','failed')
    and (coverage->'pagesExpected' = 'null'::jsonb or private.ingestion_v0_count(coverage->'pagesExpected',1,10000))
    and (coverage->'reportedTotalCount' = 'null'::jsonb or private.ingestion_v0_count(coverage->'reportedTotalCount',0,999999999999999))
    and private.ingestion_v0_count(coverage->'rowsReceived',0,9223372036854775807)
    and jsonb_typeof(coverage->'totalCountChanged') = 'boolean'
    and jsonb_typeof(missing) = 'array' and jsonb_typeof(reasons) = 'array'
    and jsonb_typeof(coverage->'collectedAt') in ('null','string')
    and (error_value = 'null'::jsonb or (private.ingestion_v0_object(error_value,array['code','layer'])
      and error_value->>'code' in ('upstream_timeout','upstream_unavailable','upstream_rate_limited',
        'upstream_auth_rejected','upstream_business_error','upstream_malformed_response','upstream_response_too_large')
      and error_value->>'layer' in ('http','network','parse','business'))), false) then
    raise exception 'invalid_ingestion_collection' using errcode = '22023';
  end if;

  pages := (coverage->>'pagesExpected')::integer;
  total := (coverage->>'reportedTotalCount')::bigint;
  received := (coverage->>'rowsReceived')::bigint;
  if exists (select 1 from jsonb_array_elements(missing) as m(value)
      where not coalesce(private.ingestion_v0_count(m.value,2,pages),false))
    or (select count(distinct value) from jsonb_array_elements(missing)) <> jsonb_array_length(missing)
    or exists (select 1 from jsonb_array_elements(reasons) as r(value) where jsonb_typeof(r.value) <> 'string')
    -- ingestion_pages.valid_timestamp와 같은 범위를 적용한다. DB 시간대 변환은 필요 없다.
    or (stamp is not null and (stamp !~ '\A[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])\Z'
      or not pg_input_is_valid(left(stamp,10),'date')))
    or pages is distinct from (case when total is not null then greatest(1,ceil(total / page_size)) end)
    or (state = 'failed' and (received <> 0 or total is not null or stamp is not null
      or error_value = 'null'::jsonb or coverage->'totalCountChanged' = 'true'::jsonb))
    or (state <> 'failed' and stamp is null)
    or (state in ('failed','partial') and jsonb_array_length(reasons) = 0)
    or (state in ('complete','empty') and (total is null or received <> total
      or (state = 'empty') <> (received = 0) or jsonb_array_length(reasons) <> 0
      or jsonb_array_length(missing) <> 0 or coverage->'totalCountChanged' = 'true'::jsonb
      or error_value <> 'null'::jsonb)) then
    raise exception 'inconsistent_ingestion_collection' using errcode = '22023';
  end if;
end;
$$;

-- 수집 결과에 포함된 문서 버전과 값 근거를 대조한다. 문서를 별도 공개 카탈로그에 복제하지 않는다.
create function private.check_ingestion_v0_catalog(catalog jsonb, target jsonb, notice_source text)
returns text[] language plpgsql set search_path = '' as $$
declare
  versions jsonb := catalog->'documents';
  models jsonb := catalog->'housingTypes';
  rooms jsonb := catalog->'rooms';
  document jsonb;
  model jsonb;
  checked_area jsonb;
  room jsonb;
  price jsonb;
  subtotal jsonb;
  reference jsonb;
  document_sources text[] := '{}';
begin
  if not coalesce(private.ingestion_v0_object(catalog,array['contract','target','collections','notice',
      'housingTypes','housingTypesStatus','rooms','documents','issues'])
    and catalog->>'contract' = 'applyhome-catalog/v0' and catalog->'target' = target
    and catalog#>>'{notice,source}' = notice_source
    and jsonb_typeof(catalog#>'{notice,evidence}') = 'array'
    and jsonb_typeof(versions) = 'array' and jsonb_typeof(models) = 'array'
    and jsonb_typeof(rooms) = 'array' and jsonb_typeof(catalog->'issues') = 'array', false) then
    raise exception 'invalid_ingestion_catalog' using errcode = '22023';
  end if;

  for document in select value from jsonb_array_elements(versions) loop
    if not coalesce(private.ingestion_v0_object(document,array['id','version','source','originCheck',
        'houseManageNo','noticeNo','edition','status','reasons','records'])
      and jsonb_typeof(document->'id') = 'string' and btrim(document->>'id') <> ''
      and jsonb_typeof(document->'version') = 'string' and btrim(document->>'version') <> ''
      and jsonb_typeof(document->'reasons') = 'array'
      and document->>'status' in ('accepted','held','rejected')
      and (document->>'status' <> 'accepted' or (document->>'source' in ('official','upload')
        and document->>'originCheck' = 'confirmed' and document->'houseManageNo' = target->'houseManageNo'
        and document->'noticeNo' = target->'noticeNo' and document->'edition' = target->'edition')),
      false) then
      raise exception 'invalid_ingestion_document_version' using errcode = '22023';
    end if;
    -- PDF 이용 조건은 공고·주택형 API와 별개다. 업로드는 별도 보류 조건으로 구분한다.
    case document->>'source'
      when 'official' then document_sources := array_append(document_sources,'applyhome_notice_pdf');
      when 'upload' then document_sources := array_append(document_sources,'user_upload');
      else document_sources := array_append(document_sources,null);
    end case;
  end loop;

  if exists (select 1 from jsonb_array_elements(versions) as d(value)
      group by d.value->>'id', d.value->>'version' having count(*) > 1)
    or exists (select 1 from jsonb_array_elements(models) as m(value) group by m.value->>'modelNo' having count(*) > 1)
    or exists (select 1 from jsonb_array_elements(rooms) as r(value)
      group by r.value->>'modelNo', r.value->>'room' having count(*) > 1) then
    raise exception 'duplicate_ingestion_catalog_identity' using errcode = '22023';
  end if;

  for model in select value from jsonb_array_elements(models) loop
    checked_area := model->'checkedSupplyArea';
    if not coalesce(private.ingestion_v0_object(model,array['modelNo','status','reasons','houseType',
        'supplyArea','topAmount','evidence','checkedSupplyArea','subtotalRange'])
      and jsonb_typeof(model->'modelNo') = 'string' and btrim(model->>'modelNo') <> ''
      and model->>'status' in ('linked','held') and jsonb_typeof(model->'evidence') = 'array'
      and model#>>'{supplyArea,basis}' = 'supply' and checked_area->>'basis' = 'supply'
      and private.ingestion_v0_object(checked_area,array['basis','status','m2','reasons','evidence','values','decisionId'])
      and checked_area->>'status' in ('confirmed','unverified','conflict')
      and jsonb_typeof(checked_area->'evidence') = 'array'
      and (case when checked_area->>'status' = 'confirmed' then
        jsonb_typeof(checked_area->'m2') = 'string' and length(checked_area->>'m2') <= 24
        and checked_area->>'m2' ~ '^([1-9][0-9]*(\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$'
        and jsonb_array_length(checked_area->'evidence') > 0
        and not (checked_area->'evidence' @> '[{"document":null}]'::jsonb)
        else checked_area->'m2' = 'null'::jsonb end), false) then
      raise exception 'invalid_ingestion_housing_type' using errcode = '22023';
    end if;
  end loop;

  for room in select value from jsonb_array_elements(rooms) loop
    subtotal := room->'subtotal';
    if not coalesce(private.ingestion_v0_object(room,array['modelNo','houseType','room','status',
        'salePrice','requiredOptions','subtotal'])
      and jsonb_typeof(room->'room') = 'string' and btrim(room->>'room') <> ''
      and room->>'status' in ('confirmed','held') and room->'status' = subtotal->'status'
      and private.ingestion_v0_object(subtotal,array['status','won','basis','reasons','documents','decisionId'])
      and subtotal->>'basis' = 'sale_price_plus_required_options' and jsonb_typeof(subtotal->'documents') = 'array'
      and exists (select 1 from jsonb_array_elements(models) as m(value)
        where m.value->'modelNo' = room->'modelNo' and m.value#>'{houseType,value}' = room->'houseType'
          and m.value->>'status' = 'linked'), false) then
      raise exception 'invalid_ingestion_room' using errcode = '22023';
    end if;
    for price in select room->'salePrice' union all select room->'requiredOptions' loop
      if not coalesce(private.ingestion_v0_object(price,array['status','won','reasons','evidence','values','decisionId'])
        and price->>'status' in ('confirmed','unverified','conflict') and jsonb_typeof(price->'evidence') = 'array'
        and (case when price->>'status' = 'confirmed' then
          jsonb_typeof(price->'won') = 'string' and price->>'won' ~ '^(0|[1-9][0-9]{0,19})$'
          and jsonb_array_length(price->'evidence') > 0 and not (price->'evidence' @> '[{"document":null}]'::jsonb)
          else price->'won' = 'null'::jsonb end), false) then
        raise exception 'invalid_ingestion_room_price' using errcode = '22023';
      end if;
    end loop;
    if room#>>'{salePrice,won}' = '0' then
      raise exception 'invalid_ingestion_room_price' using errcode = '22023';
    end if;
    if subtotal->>'status' = 'confirmed' then
      if not coalesce(jsonb_typeof(subtotal->'won') = 'string' and subtotal->>'won' ~ '^[1-9][0-9]{0,19}$'
        and jsonb_array_length(subtotal->'documents') > 0, false) then
        raise exception 'invalid_ingestion_room_subtotal' using errcode = '22023';
      end if;
      if (subtotal->>'won')::numeric is distinct from
        (room#>>'{salePrice,won}')::numeric + (room#>>'{requiredOptions,won}')::numeric then
        raise exception 'invalid_ingestion_room_subtotal' using errcode = '22023';
      end if;
      for reference in select value from jsonb_array_elements(subtotal->'documents') loop
        if not coalesce(private.ingestion_v0_object(reference,array['id','version'])
          and jsonb_typeof(reference->'id') = 'string' and jsonb_typeof(reference->'version') = 'string'
          and room#>'{salePrice,evidence}' @> jsonb_build_array(jsonb_build_object('document',reference->'id','version',reference->'version'))
          and room#>'{requiredOptions,evidence}' @> jsonb_build_array(jsonb_build_object('document',reference->'id','version',reference->'version')),
          false) then
          raise exception 'invalid_ingestion_subtotal_reference' using errcode = '22023';
        end if;
      end loop;
    elsif subtotal->'won' is distinct from 'null'::jsonb or jsonb_array_length(subtotal->'documents') <> 0 then
      raise exception 'invalid_ingestion_room_subtotal' using errcode = '22023';
    end if;
  end loop;

  for reference in
    select ref.value from jsonb_array_elements(models) as m(value)
      cross join lateral jsonb_array_elements(m.value#>'{checkedSupplyArea,evidence}') as ref(value)
    union all
    select ref.value from jsonb_array_elements(rooms) as r(value)
      cross join lateral jsonb_array_elements((r.value#>'{salePrice,evidence}') || (r.value#>'{requiredOptions,evidence}')) as ref(value)
  loop
    if not coalesce(private.ingestion_v0_object(reference,array['document','version','page','evidenceIndex'])
      and private.ingestion_v0_count(reference->'evidenceIndex',0,9223372036854775807)
      and ((reference->'document' = 'null'::jsonb and reference->'version' = 'null'::jsonb and reference->'page' = 'null'::jsonb)
        or (private.ingestion_v0_count(reference->'page',1,9223372036854775807)
          and exists (select 1 from jsonb_array_elements(versions) as d(value) where d.value->'id' = reference->'document'
            and d.value->'version' = reference->'version' and d.value->>'status' = 'accepted'))), false) then
      raise exception 'invalid_ingestion_document_reference' using errcode = '22023';
    end if;
  end loop;

  return document_sources;
end;
$$;

-- 직접 서버 INSERT에도 같은 검사를 적용하고, 변경 가능한 분석 값을 INSERT 시점에 복사한다.
create function private.prepare_ingestion_snapshot()
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

  -- 명시한 분석 대상만 번호쌍·회차와 대조한다. 기존 공고 ID는 선택 자체를 보존한다.
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
    -- 파일 소유·문서 버전·파생 삭제를 연결할 수 있을 때까지 실수집 업로드 근거를 보류한다.
    if 'user_upload' = any(document_sources) then
      raise exception 'ingestion_upload_binding_required' using errcode = '42501';
    end if;
    storage_sources := array[new.notice_source,new.notice_source || '_model'] || document_sources;
    if jsonb_array_length(months) > 0 then storage_sources := storage_sources || requested_sources; end if;
    -- 저장 허가와 보존기간을 같은 레지스트리 행 잠금으로 확인한다.
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

revoke all on function private.ingestion_v0_object(jsonb,text[]), private.ingestion_v0_count(jsonb,bigint,bigint),
  private.check_ingestion_v0_coverage(jsonb,jsonb,numeric), private.check_ingestion_v0_catalog(jsonb,jsonb,text),
  private.prepare_ingestion_snapshot() from public, anon, authenticated, service_role;
grant execute on function private.ingestion_v0_object(jsonb,text[]), private.ingestion_v0_count(jsonb,bigint,bigint),
  private.check_ingestion_v0_coverage(jsonb,jsonb,numeric), private.check_ingestion_v0_catalog(jsonb,jsonb,text),
  private.prepare_ingestion_snapshot() to service_role;

create trigger prepare_ingestion_snapshot before insert on public.analysis_input_snapshots
  for each row execute function private.prepare_ingestion_snapshot();

create function public.save_ingestion_snapshot(
  p_user_id uuid, p_analysis_id uuid, p_capture_key uuid, p_input jsonb, p_result jsonb
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare existing public.analysis_input_snapshots%rowtype;
begin
  -- 동일 분석의 동시 저장은 부모 행에서 순서를 정한다. 두 호출은 같은 캡처를 덮어쓸 수 없다.
  perform 1 from public.analyses a where (a.id,a.user_id) = (p_analysis_id,p_user_id) for no key update;
  if not found then
    raise exception 'ingestion_analysis_owner_mismatch' using errcode = '23503';
  end if;
  select * into existing from public.analysis_input_snapshots s
    where (s.user_id,s.analysis_id,s.capture_key) = (p_user_id,p_analysis_id,p_capture_key);
  if found then
    if existing.input_snapshot is distinct from p_input or existing.result_snapshot is distinct from p_result then
      raise exception 'ingestion_capture_conflict' using errcode = '23505';
    end if;
    return existing.id;
  end if;

  insert into public.analysis_input_snapshots(user_id,analysis_id,capture_key,input_snapshot,result_snapshot)
    values (p_user_id,p_analysis_id,p_capture_key,p_input,p_result) returning id into existing.id;
  return existing.id;
end;
$$;
revoke all on function public.save_ingestion_snapshot(uuid,uuid,uuid,jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.save_ingestion_snapshot(uuid,uuid,uuid,jsonb,jsonb) to service_role;

-- 정규화 결과는 한 번만 보관하고, 정렬·대조에 사용하는 값은 형식이 있는 열로 읽는다.
create view public.ingestion_collections with (security_invoker = true) as
  select s.id as snapshot_id, s.user_id, s.analysis_id, s.data_origin, entries.collection_kind,
    entries.coverage->>'source' as source_id, entries.coverage->>'recordId' as record_id,
    entries.request_scope, entries.coverage->>'requestRegionCode' as request_region_code,
    (entries.coverage->>'month' || '-01')::date as contract_month, entries.coverage->'tradeKinds' as trade_kinds,
    s.page_size, entries.coverage->>'status' as status, (entries.coverage->>'pagesExpected')::integer as pages_expected,
    array(select value::integer from jsonb_array_elements_text(entries.coverage->'missingPages')) as missing_pages,
    (entries.coverage->>'reportedTotalCount')::bigint as reported_total_count,
    (entries.coverage->>'rowsReceived')::bigint as rows_received,
    (entries.coverage->>'totalCountChanged')::boolean as total_count_changed,
    entries.coverage->>'collectedAt' as collected_at,
    nullif(entries.coverage->'error','null'::jsonb) as error, entries.reasons
  from public.analysis_input_snapshots s
  cross join lateral (
    select case when c.value->>'source' = s.notice_source then 'notice' else 'model' end as collection_kind,
      c.value->'scope' as request_scope, c.value as coverage, c.value->'reasons' as reasons
      from jsonb_array_elements(s.result_snapshot->'catalogCollections') as c(value)
    union all
    select 'trade', jsonb_build_object('LAWD_CD',b.value#>>'{record,requestRegionCode}',
      'DEAL_YMD',replace(b.value#>>'{record,month}','-','')), b.value->'record', b.value->'reasons'
      from jsonb_array_elements(s.result_snapshot->'tradeBatches') as b(value)
  ) as entries;

-- BE-02가 반환한 페이지 계획과 누락 값에서 상태만 투영한다.
create view public.ingestion_collection_pages with (security_invoker = true) as
  select c.snapshot_id,c.user_id,c.analysis_id,c.data_origin,c.collection_kind,c.source_id,c.record_id,
    c.request_scope,c.request_region_code,c.contract_month,c.page_size,p.page,
    case when c.status = 'failed' then 'failed' when p.page = any(c.missing_pages) then 'missing' else 'received' end as page_status
  from public.ingestion_collections c cross join lateral generate_series(1,coalesce(c.pages_expected,1)) as p(page);

-- API에서 큰 원 단위 정수와 십진 면적의 정밀도를 보존하도록 문자열로 내보낸다.
create view public.ingestion_trade_observations with (security_invoker = true) as
  select s.id as snapshot_id,s.user_id,s.analysis_id,s.data_origin,
    b.value#>>'{record,source}' as source_id, b.value#>>'{record,recordId}' as record_id,
    b.value#>>'{record,requestRegionCode}' as request_region_code, (b.value#>>'{record,month}' || '-01')::date as contract_month,
    (t.value#>>'{provenance,page}')::integer as page, (t.value#>>'{provenance,position}')::bigint as row_position,
    t.value->>'tradeKind' as trade_kind, (t.value#>>'{contractDate,date}')::date as contract_date,
    t.value#>>'{amount,won}' as amount_won, t.value#>>'{exclusiveArea,m2}' as exclusive_area_m2,
    t.value#>>'{supplyArea,m2}' as supply_area_m2, t.value#>>'{cancellation,status}' as cancellation_status,
    t.value->>'disposition' as disposition, t.value as observation
  from public.analysis_input_snapshots s
  cross join lateral jsonb_array_elements(s.result_snapshot->'tradeBatches') as b(value)
  cross join lateral jsonb_array_elements(b.value->'trades') as t(value);

create view public.ingestion_document_versions with (security_invoker = true) as
  select s.id as snapshot_id,s.user_id,s.analysis_id,s.data_origin,
    d.value->>'id' as document_id, d.value->>'version' as version, d.value->>'source' as acquisition_source,
    d.value->>'originCheck' as origin_check, d.value->>'houseManageNo' as house_manage_no, d.value->>'noticeNo' as notice_no,
    d.value->>'edition' as edition, d.value->>'status' as status, d.value as document
  from public.analysis_input_snapshots s
  cross join lateral jsonb_array_elements(s.result_snapshot#>'{catalog,documents}') as d(value);

revoke all on public.ingestion_collections, public.ingestion_collection_pages, public.ingestion_trade_observations,
  public.ingestion_document_versions from public, anon, authenticated, service_role;
grant select on public.ingestion_collections, public.ingestion_collection_pages, public.ingestion_trade_observations,
  public.ingestion_document_versions to authenticated, service_role;
