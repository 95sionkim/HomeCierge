-- 작업 P: 분석 저장 지연을 줄이기 위해 거래·호실·납부 일정·비교 근거 검증을 집합 연산으로 바꾸고,
-- 저장 응답 유실(커밋 불확실) 시 작업자가 실행 상태를 안전하게 확인하는 service_role 전용 조회 RPC를 추가한다.
-- 모든 기존 검증 규칙·오류 코드·권한 경계는 직전 마이그레이션 정의와 동일하게 유지한다.

-- 1. 작업자 전용 실행 상태 조회 RPC (응답 유실로 커밋 여부가 불확실할 때만 상태를 확인한다).
-- FOR SHARE 잠금으로 진행 중인 완료 트랜잭션이 커밋 또는 롤백될 때까지 기다린 뒤 확정 상태를 읽는다.
create function private.read_analysis_run_status(
  p_run_id uuid,
  p_generation integer,
  p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype;
  lease_active boolean;
begin
  if p_run_id is null or p_generation is null or p_generation < 1 or p_lease_token is null then
    raise exception 'invalid_analysis_run_lookup' using errcode = '22023';
  end if;
  select * into job from private.analysis_runs r where r.id = p_run_id for share;
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;
  lease_active := (
    job.status = 'running'
    and job.attempt is not distinct from p_generation
    and job.lease_token is not distinct from p_lease_token
    and job.next_claim_at > clock_timestamp()
  );
  return private.analysis_run_operation(job) || jsonb_build_object('leaseActive', lease_active);
end;
$$;

-- FOR SHARE 행 잠금에 닿으므로 VOLATILE로 선언한다(PostgREST 읽기 전용 트랜잭션 25006 방지).
create function public.read_analysis_run_status(
  p_run_id uuid,
  p_generation integer,
  p_lease_token uuid
) returns jsonb language sql volatile security invoker set search_path = '' as $$
  select private.read_analysis_run_status(p_run_id, p_generation, p_lease_token);
$$;

revoke all on function
  private.read_analysis_run_status(uuid, integer, uuid),
  public.read_analysis_run_status(uuid, integer, uuid)
from public, anon, authenticated, service_role;

grant execute on function
  private.read_analysis_run_status(uuid, integer, uuid),
  public.read_analysis_run_status(uuid, integer, uuid)
to service_role;

-- 2. 원문 페이로드 키 검출: 텍스트 사전 검사 통과 시에만 전체 jsonb_path_exists를 수행한다.
-- PostgreSQL jsonb::text는 ASCII 객체 키를 항상 `"key":` 형식으로 출력하므로 거짓 음성이 없다.
-- 직전 정의: 20261121024901_comparison_results.sql
create or replace function private.comparison_contains_raw_payload(value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case
    when value is null then null
    when value::text !~ '"(body|response|payload|raw|rawBody|rawApi|rawPdf|rawResponse|pdfBytes|pdfText|fileBytes)":' then false
    else jsonb_path_exists(value, 'strict $.** ? (@.type() == "object" &&
      (exists(@.body) || exists(@.response) || exists(@.payload) || exists(@.raw) || exists(@.rawBody) || exists(@.rawApi) ||
       exists(@.rawPdf) || exists(@.rawResponse) || exists(@.pdfBytes) || exists(@.pdfText) || exists(@.fileBytes)))')
  end;
$$;

-- 3. 카탈로그 검증: housingTypes·rooms·문서 참조 루프를 집합 연산으로 바꾼다.
-- 직전 정의: 20261127110000_notice_formats_and_revisions.sql
create or replace function private.check_ingestion_v0_catalog(catalog jsonb, target jsonb, notice_source text)
returns text[] language plpgsql set search_path = '' as $$
declare
  versions jsonb := catalog->'documents';
  models jsonb := catalog->'housingTypes';
  rooms jsonb := catalog->'rooms';
  document jsonb;
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

  if exists (
    select 1
    from jsonb_array_elements(models) as m(value)
    where not coalesce(
      (case when jsonb_typeof(m.value) = 'object'
        then (m.value - array['modelNo','status','reasons','houseType',
          'supplyArea','topAmount','evidence','checkedSupplyArea','subtotalRange']) = '{}'::jsonb
        else false end)
      and jsonb_typeof(m.value->'modelNo') = 'string' and btrim(m.value->>'modelNo') <> ''
      and m.value->>'status' in ('linked','held') and jsonb_typeof(m.value->'evidence') = 'array'
      and m.value#>>'{supplyArea,basis}' = 'supply' and m.value#>>'{checkedSupplyArea,basis}' = 'supply'
      and (case when jsonb_typeof(m.value->'checkedSupplyArea') = 'object'
        then ((m.value->'checkedSupplyArea') - array['basis','status','m2','reasons','evidence','values','decisionId']) = '{}'::jsonb
        else false end)
      and m.value#>>'{checkedSupplyArea,status}' in ('confirmed','unverified','conflict')
      and jsonb_typeof(m.value#>'{checkedSupplyArea,evidence}') = 'array'
      and (case when m.value#>>'{checkedSupplyArea,status}' = 'confirmed' then
        jsonb_typeof(m.value#>'{checkedSupplyArea,m2}') = 'string'
        and length(m.value#>>'{checkedSupplyArea,m2}') <= 24
        and m.value#>>'{checkedSupplyArea,m2}' ~ '^([1-9][0-9]*(\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$'
        and (case when jsonb_typeof(m.value#>'{checkedSupplyArea,evidence}') = 'array'
          then jsonb_array_length(m.value#>'{checkedSupplyArea,evidence}') > 0
            and not ((m.value#>'{checkedSupplyArea,evidence}') @> '[{"document":null}]'::jsonb)
          else false end)
        else m.value#>'{checkedSupplyArea,m2}' = 'null'::jsonb end),
      false
    )
  ) then
    raise exception 'invalid_ingestion_housing_type' using errcode = '22023';
  end if;

  if exists (
    with linked_models as (
      select m.value->'modelNo' as model_no, m.value#>'{houseType,value}' as house_type
      from jsonb_array_elements(models) as m(value)
      where m.value->>'status' = 'linked'
    )
    select 1
    from jsonb_array_elements(rooms) as r(value)
    where not coalesce(
      (case when jsonb_typeof(r.value) = 'object'
        then (r.value - array['modelNo','houseType','room','status',
          'salePrice','requiredOptions','subtotal','unit']) = '{}'::jsonb
          and r.value ?& array['modelNo','houseType','room','status','salePrice','requiredOptions','subtotal']
          and (not (r.value ? 'unit') or private.ingestion_v0_unit(r.value->'unit'))
        else false end)
      and jsonb_typeof(r.value->'room') = 'string' and btrim(r.value->>'room') <> ''
      and r.value->>'status' in ('confirmed','held') and r.value->'status' = r.value#>'{subtotal,status}'
      and (case when jsonb_typeof(r.value->'subtotal') = 'object'
        then ((r.value->'subtotal') - array['status','won','basis','reasons','documents','decisionId']) = '{}'::jsonb
        else false end)
      and r.value#>>'{subtotal,basis}' = 'sale_price_plus_required_options'
      and jsonb_typeof(r.value#>'{subtotal,documents}') = 'array'
      and exists (
        select 1 from linked_models lm
        where lm.model_no = r.value->'modelNo' and lm.house_type = r.value->'houseType'
      ),
      false
    )
  ) then
    raise exception 'invalid_ingestion_room' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(rooms) as r(value)
    where r.value#>>'{salePrice,won}' = '0'
      or not coalesce(
        (case when jsonb_typeof(r.value->'salePrice') = 'object'
          then ((r.value->'salePrice') - array['status','won','reasons','evidence','values','decisionId']) = '{}'::jsonb
          else false end)
        and r.value#>>'{salePrice,status}' in ('confirmed','unverified','conflict')
        and jsonb_typeof(r.value#>'{salePrice,evidence}') = 'array'
        and (case when r.value#>>'{salePrice,status}' = 'confirmed' then
          jsonb_typeof(r.value#>'{salePrice,won}') = 'string'
          and r.value#>>'{salePrice,won}' ~ '^(0|[1-9][0-9]{0,19})$'
          and (case when jsonb_typeof(r.value#>'{salePrice,evidence}') = 'array'
            then jsonb_array_length(r.value#>'{salePrice,evidence}') > 0
              and not ((r.value#>'{salePrice,evidence}') @> '[{"document":null}]'::jsonb)
            else false end)
          else r.value#>'{salePrice,won}' = 'null'::jsonb end)
        and (case when jsonb_typeof(r.value->'requiredOptions') = 'object'
          then ((r.value->'requiredOptions') - array['status','won','reasons','evidence','values','decisionId']) = '{}'::jsonb
          else false end)
        and r.value#>>'{requiredOptions,status}' in ('confirmed','unverified','conflict')
        and jsonb_typeof(r.value#>'{requiredOptions,evidence}') = 'array'
        and (case when r.value#>>'{requiredOptions,status}' = 'confirmed' then
          jsonb_typeof(r.value#>'{requiredOptions,won}') = 'string'
          and r.value#>>'{requiredOptions,won}' ~ '^(0|[1-9][0-9]{0,19})$'
          and (case when jsonb_typeof(r.value#>'{requiredOptions,evidence}') = 'array'
            then jsonb_array_length(r.value#>'{requiredOptions,evidence}') > 0
              and not ((r.value#>'{requiredOptions,evidence}') @> '[{"document":null}]'::jsonb)
            else false end)
          else r.value#>'{requiredOptions,won}' = 'null'::jsonb end),
        false
      )
  ) then
    raise exception 'invalid_ingestion_room_price' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(rooms) as r(value)
    where (
      r.value#>>'{subtotal,status}' = 'confirmed'
      and not coalesce(
        jsonb_typeof(r.value#>'{subtotal,won}') = 'string'
        and r.value#>>'{subtotal,won}' ~ '^[1-9][0-9]{0,19}$'
        and jsonb_array_length(r.value#>'{subtotal,documents}') > 0
        and (case
          when jsonb_typeof(r.value#>'{subtotal,won}') = 'string'
            and r.value#>>'{subtotal,won}' ~ '^[1-9][0-9]{0,19}$'
            and r.value#>>'{salePrice,status}' = 'confirmed'
            and r.value#>>'{requiredOptions,status}' = 'confirmed'
          then (r.value#>>'{subtotal,won}')::numeric =
            (r.value#>>'{salePrice,won}')::numeric + (r.value#>>'{requiredOptions,won}')::numeric
          else false end),
        false
      )
    ) or (
      r.value#>>'{subtotal,status}' <> 'confirmed'
      and (r.value#>'{subtotal,won}' is distinct from 'null'::jsonb
        or jsonb_array_length(r.value#>'{subtotal,documents}') <> 0)
    )
  ) then
    raise exception 'invalid_ingestion_room_subtotal' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(rooms) as r(value)
    cross join lateral jsonb_array_elements(r.value#>'{subtotal,documents}') as ref(value)
    where r.value#>>'{subtotal,status}' = 'confirmed'
      and not coalesce(
        (case when jsonb_typeof(ref.value) = 'object'
          then (ref.value - array['id','version']) = '{}'::jsonb
          else false end)
        and jsonb_typeof(ref.value->'id') = 'string'
        and jsonb_typeof(ref.value->'version') = 'string'
        and (r.value#>'{salePrice,evidence}') @> jsonb_build_array(jsonb_build_object('document',ref.value->'id','version',ref.value->'version'))
        and (r.value#>'{requiredOptions,evidence}') @> jsonb_build_array(jsonb_build_object('document',ref.value->'id','version',ref.value->'version')),
        false
      )
  ) then
    raise exception 'invalid_ingestion_subtotal_reference' using errcode = '22023';
  end if;

  if exists (
    with accepted_docs as (
      select d.value->'id' as doc_id, d.value->'version' as doc_ver
      from jsonb_array_elements(versions) as d(value)
      where d.value->>'status' = 'accepted'
    ),
    all_refs as (
      select ref.value
      from jsonb_array_elements(models) as m(value)
      cross join lateral jsonb_array_elements(m.value#>'{checkedSupplyArea,evidence}') as ref(value)
      union all
      select ref.value
      from jsonb_array_elements(rooms) as r(value)
      cross join lateral jsonb_array_elements((r.value#>'{salePrice,evidence}') || (r.value#>'{requiredOptions,evidence}')) as ref(value)
    )
    select 1
    from all_refs as ref
    where not coalesce(
      (case when jsonb_typeof(ref.value) = 'object'
        then (ref.value - array['document','version','page','evidenceIndex']) = '{}'::jsonb
        else false end)
      and (case when jsonb_typeof(ref.value->'evidenceIndex') = 'number'
          and (ref.value->'evidenceIndex')::text ~ '^[0-9]+$'
        then (ref.value->'evidenceIndex')::numeric between 0 and 9223372036854775807
        else false end)
      and (
        (ref.value->'document' = 'null'::jsonb and ref.value->'version' = 'null'::jsonb and ref.value->'page' = 'null'::jsonb)
        or (
          (case when jsonb_typeof(ref.value->'page') = 'number'
              and (ref.value->'page')::text ~ '^[0-9]+$'
            then (ref.value->'page')::numeric between 1 and 9223372036854775807
            else false end)
          and exists (
            select 1 from accepted_docs ad
            where ad.doc_id = ref.value->'document' and ad.doc_ver = ref.value->'version'
          )
        )
      ),
      false
    )
  ) then
    raise exception 'invalid_ingestion_document_reference' using errcode = '22023';
  end if;

  return document_sources;
end;
$$;

-- 4. 스냅샷 저장 트리거: 거래별 PL/pgSQL 루프를 단일 집합 연산으로 바꾸고 원문 키 검사를 최적화한다.
-- 직전 정의: 20261126110000_upload_supplement.sql
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
    or (
      result::text ~ '"(body|response|payload|rawBody|rawApi|rawPdf|rawResponse|pdfBytes|pdfText|fileBytes)":'
      and jsonb_path_exists(result, 'strict $.** ? (@.type() == "object" &&
        (exists(@.body) || exists(@.response) || exists(@.payload) || exists(@.rawBody) || exists(@.rawApi) ||
         exists(@.rawPdf) || exists(@.rawResponse) || exists(@.pdfBytes) || exists(@.pdfText) || exists(@.fileBytes)))')
    ) then
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
    if to_jsonb(jsonb_array_length(batch->'trades')) <> coverage->'rowsReceived' then
      raise exception 'invalid_ingestion_trade_locations' using errcode = '22023';
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(result->'tradeBatches') with ordinality as b(val, ord)
    cross join lateral jsonb_array_elements(b.val->'trades') as t(val)
    group by b.ord, t.val#>'{provenance,page}', t.val#>'{provenance,position}'
    having count(*) > 1
  ) then
    raise exception 'invalid_ingestion_trade_locations' using errcode = '22023';
  end if;

  if exists (
    with batches as (
      select
        b.val->'trades' as trades,
        b.val#>>'{record,source}' as source_id,
        jsonb_build_object(
          'LAWD_CD', b.val#>>'{record,requestRegionCode}',
          'DEAL_YMD', replace(b.val#>>'{record,month}', '-', '')
        ) as scope,
        coalesce((b.val#>>'{record,pagesExpected}')::integer, 1) as max_page,
        array(
          select m.val::integer
          from jsonb_array_elements_text(b.val#>'{record,missingPages}') as m(val)
        ) as missing_pages
      from jsonb_array_elements(result->'tradeBatches') as b(val)
    )
    select 1
    from batches b
    cross join lateral jsonb_array_elements(b.trades) as t(val)
    where not coalesce(
      (case when jsonb_typeof(t.val) = 'object'
        then (t.val - array['normalizerVersion','provenance','tradeKind',
          'tradeKindBasis','contractDate','amount','exclusiveArea','supplyArea','cancellation','identifiers','attributes',
          'withheldFields','checks','disposition','exclusionReason','exclusionReasons','issues','pendingReasons']) = '{}'::jsonb
        else false end)
      and t.val->>'normalizerVersion' = 'ingestion-trades/v0'
      and (case when jsonb_typeof(t.val->'provenance') = 'object'
        then ((t.val->'provenance') - array['source','request','page','position']) = '{}'::jsonb
        else false end)
      and t.val#>>'{provenance,source}' = b.source_id
      and t.val#>'{provenance,request}' = b.scope
      and (case
        when jsonb_typeof(t.val#>'{provenance,page}') = 'number'
          and (t.val#>>'{provenance,page}') ~ '^[0-9]+$'
        then (t.val#>>'{provenance,page}')::numeric between 1 and b.max_page
        else false end)
      and (case
        when jsonb_typeof(t.val#>'{provenance,position}') = 'number'
          and (t.val#>>'{provenance,position}') ~ '^[0-9]+$'
        then (t.val#>>'{provenance,position}')::numeric between 1 and 9223372036854775807
        else false end)
      and (case
        when b.missing_pages = '{}'::integer[] then true
        when jsonb_typeof(t.val#>'{provenance,page}') = 'number'
          and (t.val#>>'{provenance,page}') ~ '^[0-9]+$'
          and (t.val#>>'{provenance,page}')::numeric between 1 and b.max_page
        then not ((t.val#>>'{provenance,page}')::integer = any(b.missing_pages))
        else false end)
      and (case
        when b.source_id = 'apt_trade' then t.val->>'tradeKind' = 'sale'
        else t.val->'tradeKind' = 'null'::jsonb or t.val->>'tradeKind' in ('presale_right','occupancy_right') end)
      and t.val->>'disposition' in ('excluded','held','follow_up_required')
      and t.val#>>'{cancellation,status}' in ('cancelled','not_marked','unknown')
      and (case
        when t.val#>'{contractDate,date}' = 'null'::jsonb then true
        when jsonb_typeof(t.val#>'{contractDate,date}') = 'string'
          and t.val#>>'{contractDate,date}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        then pg_input_is_valid(t.val#>>'{contractDate,date}','date')
        else false end)
      and (t.val#>'{amount,won}' = 'null'::jsonb
        or (jsonb_typeof(t.val#>'{amount,won}') = 'string'
          and t.val#>>'{amount,won}' ~ '^[1-9][0-9]{0,19}$'))
      and t.val#>>'{exclusiveArea,basis}' = 'exclusive'
      and (t.val#>'{exclusiveArea,m2}' = 'null'::jsonb
        or (jsonb_typeof(t.val#>'{exclusiveArea,m2}') = 'string'
          and length(t.val#>>'{exclusiveArea,m2}') <= 24
          and t.val#>>'{exclusiveArea,m2}' ~ '^([1-9][0-9]*(\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$'))
      and t.val#>>'{supplyArea,basis}' = 'supply'
      and t.val#>>'{supplyArea,status}' = 'unverified'
      and t.val#>'{supplyArea,m2}' = 'null'::jsonb,
      false
    )
  ) then
    raise exception 'invalid_ingestion_trade_observation' using errcode = '22023';
  end if;

  if exists (
    with batches as (
      select
        b.val->'trades' as trades,
        (b.val#>>'{record,reportedTotalCount}')::bigint as reported_total
      from jsonb_array_elements(result->'tradeBatches') as b(val)
      where b.val#>>'{record,status}' = 'complete'
    )
    select 1
    from batches b
    cross join lateral jsonb_array_elements(b.trades) as t(val)
    where (t.val#>>'{provenance,position}')::bigint > least(
      new.page_size,
      b.reported_total - ((t.val#>>'{provenance,page}')::integer - 1) * new.page_size
    )
  ) then
    raise exception 'invalid_ingestion_trade_position' using errcode = '22023';
  end if;

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

-- 5. 납부 일정 검증: O(R*S) 중첩 호실 탐색과 납부 회차별 루프를 집합 연산(해시 조인)으로 바꾼다.
-- 직전 정의: 20261126110000_upload_supplement.sql
create or replace function private.check_funding_schedules(p_snapshot public.analysis_input_snapshots, p_schedules jsonb)
returns void language plpgsql stable set search_path = '' as $$
declare
  catalog jsonb := p_snapshot.result_snapshot->'catalog';
  verified_doc_keys text[];
  trim_chars constant text := U&' \00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
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

  select coalesce(array_agg(distinct (d.document_id || E'\x1f' || d.version)), '{}'::text[])
    into verified_doc_keys
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

  if exists (
    select 1
    from jsonb_array_elements(p_schedules) as s(value)
    where not coalesce(
      (case when jsonb_typeof(s.value) = 'object'
        then (s.value - array['modelNo','houseType','room','item','status',
          'totalWon','reasons','evidence','installments']) = '{}'::jsonb
        else false end)
      and jsonb_typeof(s.value->'modelNo') = 'string'
      and s.value->>'modelNo' ~ '\A[0-9]{1,20}\Z'
      and jsonb_typeof(s.value->'houseType') = 'string'
      and s.value->>'houseType' !~ '[\u0001-\u001F\u007F-\u009F]'
      and btrim(s.value->>'houseType', trim_chars) <> ''
      and length(s.value->>'houseType') <= 120
      and jsonb_typeof(s.value->'room') = 'string'
      and s.value->>'room' !~ '[\u0001-\u001F\u007F-\u009F]'
      and btrim(s.value->>'room', trim_chars) <> ''
      and s.value->>'room' = btrim(s.value->>'room', trim_chars)
      and length(regexp_replace(s.value->>'room','[\U00010000-\U0010FFFF]','aa','g')) <= 120
      and s.value->>'item' in ('sale_price','required_options')
      and s.value->>'status' in ('confirmed','unverified','conflict')
      and jsonb_typeof(s.value->'reasons') = 'array'
      and jsonb_typeof(s.value->'installments') = 'array'
      and (case when jsonb_typeof(s.value->'evidence') = 'array' then
        not exists (
          select 1 from jsonb_array_elements(s.value->'evidence') as r(value)
          where not coalesce(
            (case when jsonb_typeof(r.value) = 'object'
              then (r.value - array['document','version','page']) = '{}'::jsonb
              else false end)
            and jsonb_typeof(r.value->'document') = 'string'
            and r.value->>'document' ~ '\A[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z'
            and jsonb_typeof(r.value->'version') = 'string'
            and r.value->>'version' ~ '\A[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z'
            and (case when jsonb_typeof(r.value->'page') = 'number'
                and (r.value->>'page') ~ '^[0-9]+$'
              then (r.value->>'page')::numeric between 1 and 9007199254740991
              else false end)
            and ((r.value->>'document') || E'\x1f' || (r.value->>'version')) = any(verified_doc_keys),
            false
          )
        )
        else false end),
      false
    )
  ) then
    raise exception 'invalid_funding_schedule' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_schedules) as s(value)
    cross join lateral jsonb_array_elements(s.value->'reasons') as r(value)
    where jsonb_typeof(r.value) <> 'string' or r.value#>>'{}' !~ '\A[a-z][a-z0-9_]{0,79}\Z'
  ) then
    raise exception 'invalid_funding_schedule_reasons' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_schedules) as s(value)
    where s.value->>'status' <> 'confirmed'
      and (
        s.value->'totalWon' is distinct from 'null'::jsonb
        or s.value->'installments' <> '[]'::jsonb
        or s.value->'reasons' = '[]'::jsonb
      )
  ) then
    raise exception 'invalid_held_funding_schedule' using errcode = '22023';
  end if;

  if exists (
    with rooms_tbl as (
      select r.value->'modelNo' as model_no, r.value->'houseType' as house_type, r.value->'room' as room
      from jsonb_array_elements(catalog->'rooms') as r(value)
    )
    select 1
    from jsonb_array_elements(p_schedules) as s(value)
    left join rooms_tbl rm
      on rm.model_no = s.value->'modelNo'
      and rm.house_type = s.value->'houseType'
      and rm.room = s.value->'room'
    where s.value->>'status' = 'confirmed'
      and rm.room is null
  ) then
    raise exception 'funding_schedule_room_mismatch' using errcode = '22023';
  end if;

  if exists (
    with linked_models as (
      select distinct m.value->'modelNo' as model_no, m.value#>'{houseType,value}' as house_type
      from jsonb_array_elements(catalog->'housingTypes') as m(value)
      where m.value->>'status' = 'linked'
        and m.value#>>'{houseType,status}' = 'reported'
        and m.value->'evidence' <> '[]'::jsonb
    ),
    conflicting_rooms as (
      select r.value->'room' as room
      from jsonb_array_elements(catalog->'rooms') as r(value)
      group by r.value->'room'
      having count(*) > 1 and count(distinct coalesce((r.value->'modelNo')::text, '')) > 1
    ),
    issue_rooms as (
      select distinct i.value->'room' as room
      from jsonb_array_elements(catalog->'issues') as i(value)
      where i.value->>'code' in ('room_model_conflict','house_type_mismatch')
    ),
    rooms_tbl as (
      select r.value->'modelNo' as model_no, r.value->'houseType' as house_type, r.value->'room' as room, r.value as val
      from jsonb_array_elements(catalog->'rooms') as r(value)
    )
    select 1
    from jsonb_array_elements(p_schedules) as s(value)
    join rooms_tbl rm
      on rm.model_no = s.value->'modelNo'
      and rm.house_type = s.value->'houseType'
      and rm.room = s.value->'room'
    left join linked_models lm
      on lm.model_no = rm.model_no and lm.house_type = rm.house_type
    left join conflicting_rooms cr on cr.room = rm.room
    left join issue_rooms ir on ir.room = rm.room
    where s.value->>'status' = 'confirmed'
      and (
        lm.model_no is null
        or cr.room is not null
        or ir.room is not null
        or coalesce(rm.val#>'{subtotal,reasons}' ?| array['room_model_conflict','house_type_mismatch'], false)
      )
  ) then
    raise exception 'funding_schedule_room_unverified' using errcode = '22023';
  end if;

  if exists (
    with rooms_tbl as (
      select r.value->'modelNo' as model_no, r.value->'houseType' as house_type, r.value->'room' as room, r.value as val
      from jsonb_array_elements(catalog->'rooms') as r(value)
    )
    select 1
    from jsonb_array_elements(p_schedules) as s(value)
    join rooms_tbl rm
      on rm.model_no = s.value->'modelNo'
      and rm.house_type = s.value->'houseType'
      and rm.room = s.value->'room'
    cross join lateral (
      select case s.value->>'item' when 'sale_price' then rm.val->'salePrice' else rm.val->'requiredOptions' end as price
    ) as p
    cross join lateral (
      select jsonb_agg(e.value - 'evidenceIndex') as price_evidence
      from jsonb_array_elements(p.price->'evidence') as e(value)
    ) as pe
    where s.value->>'status' = 'confirmed'
      and not coalesce(
        p.price->>'status' = 'confirmed'
        and p.price->'won' = s.value->'totalWon'
        and s.value->'reasons' = '[]'::jsonb
        and s.value->'evidence' <> '[]'::jsonb
        and pe.price_evidence @> (s.value->'evidence')
        and (s.value->'evidence') @> pe.price_evidence,
        false
      )
  ) then
    raise exception 'funding_schedule_price_mismatch' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_schedules) as s(value)
    cross join lateral jsonb_array_elements(s.value->'installments') as inst(value)
    where s.value->>'status' = 'confirmed'
      and not coalesce(
        (case when jsonb_typeof(inst.value) = 'object'
          then (inst.value - array['stage','won','timing']) = '{}'::jsonb
          else false end)
        and inst.value->>'stage' in ('deposit','interim','balance')
        and jsonb_typeof(inst.value->'won') = 'string'
        and inst.value->>'won' ~ '\A[1-9][0-9]{0,19}\Z'
        and (case when jsonb_typeof(inst.value->'timing') = 'object'
          then ((inst.value->'timing') - array['trigger','dateStatus','date','evidence']) = '{}'::jsonb
            and (inst.value->'timing') ? 'trigger'
          else false end)
        and (case when jsonb_typeof(inst.value#>'{timing,evidence}') = 'array' then
          not exists (
            select 1 from jsonb_array_elements(inst.value#>'{timing,evidence}') as r(value)
            where not coalesce(
              (case when jsonb_typeof(r.value) = 'object'
                then (r.value - array['document','version','page']) = '{}'::jsonb
                else false end)
              and jsonb_typeof(r.value->'document') = 'string'
              and r.value->>'document' ~ '\A[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z'
              and jsonb_typeof(r.value->'version') = 'string'
              and r.value->>'version' ~ '\A[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z'
              and (case when jsonb_typeof(r.value->'page') = 'number'
                  and (r.value->>'page') ~ '^[0-9]+$'
                then (r.value->>'page')::numeric between 1 and 9007199254740991
                else false end)
              and ((r.value->>'document') || E'\x1f' || (r.value->>'version')) = any(verified_doc_keys),
              false
            )
          )
          else false end)
        and (case inst.value#>>'{timing,dateStatus}'
          when 'exact' then inst.value#>>'{timing,trigger}' in ('calendar_date','deadline','contract_signing','move_in')
            and jsonb_typeof(inst.value#>'{timing,date}') = 'string'
            and inst.value#>>'{timing,date}' ~ '\A[0-9]{4}-[0-9]{2}-[0-9]{2}\Z'
            and pg_input_is_valid(inst.value#>>'{timing,date}','date')
            and inst.value#>'{timing,evidence}' <> '[]'::jsonb
          when 'relative' then inst.value#>>'{timing,trigger}' in ('contract_signing','move_in')
          when 'range' then inst.value#>>'{timing,trigger}' is null or inst.value#>>'{timing,trigger}' in ('contract_signing','move_in')
          when 'unverified' then inst.value#>>'{timing,trigger}' is null or inst.value#>>'{timing,trigger}' in ('contract_signing','move_in')
          when 'missing' then inst.value#>>'{timing,trigger}' is null
          else false end)
        and (inst.value#>>'{timing,dateStatus}' = 'exact'
          or (inst.value#>'{timing,date}' = 'null'::jsonb and inst.value#>'{timing,evidence}' = '[]'::jsonb)),
        false
      )
  ) then
    raise exception 'invalid_funding_installment' using errcode = '22023';
  end if;

  if exists (
    with confirmed_schedules as (
      select
        s.value->'installments' as installments,
        array(
          select distinct (r.value->>'document') || E'\x1f' || (r.value->>'version')
          from jsonb_array_elements(s.value->'evidence') as r(value)
          order by 1
        ) as sched_docs
      from jsonb_array_elements(p_schedules) as s(value)
      where s.value->>'status' = 'confirmed'
    )
    select 1
    from confirmed_schedules cs
    cross join lateral jsonb_array_elements(cs.installments) as inst(value)
    where inst.value#>>'{timing,dateStatus}' = 'exact'
      and cs.sched_docs is distinct from array(
        select distinct (r.value->>'document') || E'\x1f' || (r.value->>'version')
        from jsonb_array_elements(inst.value#>'{timing,evidence}') as r(value)
        order by 1
      )
  ) then
    raise exception 'funding_installment_document_mismatch' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_schedules) as s(value)
    where s.value->>'status' = 'confirmed'
      and coalesce(
        (select sum((inst.value->>'won')::numeric) from jsonb_array_elements(s.value->'installments') as inst(value)),
        0
      ) <> (s.value->>'totalWon')::numeric
  ) then
    raise exception 'funding_installment_sum_mismatch' using errcode = '22023';
  end if;
end;
$$;

-- 6. 비교 근거 검증: tradeLinks 등 수천 건의 evidence 객체 검증에서 비인라인 SQL 함수 호출을 제거한다.
-- 직전 정의: 20261126150000_auto_comparison_evidence.sql
create or replace function private.validate_and_store_comparison_evidence(
  p_snapshot public.analysis_input_snapshots,
  p_evidence jsonb,
  p_source_ids text[],
  p_metadata jsonb default null
) returns text[] language plpgsql set search_path = '' as $$
declare
  existing private.comparison_evidence%rowtype;
  sources text[] := array(select distinct id from unnest(coalesce(p_source_ids, '{}'::text[])) as source(id) order by id);
  target jsonb := p_evidence->'target';
  notice jsonb := target->'notice';
begin
  if not coalesce(
    p_snapshot.id is not null
    and cardinality(sources) > 0
    and array_position(sources, null) is null
    and not exists (select 1 from unnest(sources) as source(id) where id = '' or id <> btrim(id))
    and private.ingestion_v0_object(
      p_evidence,
      array['contractVersion', 'dataOrigin', 'target', 'scopes', 'regions', 'complexes', 'tradeLinks']
    )
    and p_evidence->>'contractVersion' = 'comparison-evidence/v1'
    and p_evidence->>'dataOrigin' = 'collected'
    and jsonb_typeof(target->'complexId') = 'string'
    and btrim(target->>'complexId') <> ''
    and jsonb_typeof(target->'evidence') = 'object'
    and jsonb_typeof(notice->'address') = 'string'
    and jsonb_typeof(p_evidence->'scopes') = 'object'
    and jsonb_typeof(p_evidence->'regions') = 'array'
    and jsonb_typeof(p_evidence->'complexes') = 'array'
    and jsonb_typeof(p_evidence->'tradeLinks') = 'array'
    and not private.comparison_contains_raw_payload(p_evidence)
    and (
      p_metadata is null
      or (jsonb_typeof(p_metadata) = 'object' and not private.comparison_contains_raw_payload(p_metadata))
    ),
    false
  ) or exists (
    select 1 from jsonb_path_query(
      p_evidence,
      'strict $.** ? (@.type() == "object" && exists(@.evidence)).evidence'
    ) as ref(value)
    where not coalesce(
      (case when jsonb_typeof(ref.value) = 'object'
        then (ref.value - array['source', 'reference']) = '{}'::jsonb
        else false end)
      and jsonb_typeof(ref.value->'source') = 'string'
      and btrim(ref.value->>'source') <> ''
      and jsonb_typeof(ref.value->'reference') = 'string'
      and btrim(ref.value->>'reference') <> '',
      false
    )
  ) then
    raise exception 'invalid_comparison_evidence' using errcode = '22023';
  end if;

  if p_snapshot.data_origin <> 'collected' then
    raise exception 'comparison_evidence_requires_collected_snapshot' using errcode = '22023';
  end if;

  if not coalesce(
    target->'houseManageNo' = to_jsonb(p_snapshot.house_manage_no)
    and target->'noticeNo' = to_jsonb(p_snapshot.notice_no)
    and target->'edition' = to_jsonb(p_snapshot.edition)
    and notice->'source' = to_jsonb(p_snapshot.notice_source)
    and notice->'address' = p_snapshot.result_snapshot#>'{catalog,notice,fields,HSSPLY_ADRES,value}'
    and p_snapshot.result_snapshot#>'{catalog,notice,evidence}' @>
      jsonb_build_array(jsonb_build_object('page', notice->'page', 'position', notice->'position')),
    false
  ) then
    raise exception 'comparison_evidence_target_mismatch' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_path_query(
      p_evidence,
      'strict $.** ? (@.type() == "object" && exists(@.source)).source'
    ) as ref(value)
    where jsonb_typeof(ref.value) <> 'string' or not ((ref.value #>> '{}') = any(sources))
  ) then
    raise exception 'comparison_evidence_source_not_declared' using errcode = '42501';
  end if;

  perform private.require_comparison_sources(private.comparison_sources(p_snapshot.id, sources));

  select * into existing from private.comparison_evidence e where e.snapshot_id = p_snapshot.id;
  if found then
    if (existing.evidence, existing.source_ids) is distinct from (p_evidence, sources) then
      raise exception 'comparison_evidence_conflict' using errcode = '23505';
    end if;
    if existing.metadata is null and p_metadata is not null then
      update private.comparison_evidence
        set metadata = p_metadata, updated_at = clock_timestamp()
        where snapshot_id = p_snapshot.id;
    end if;
    return sources;
  end if;

  insert into private.comparison_evidence(snapshot_id, evidence, source_ids, metadata, updated_at)
    values (p_snapshot.id, p_evidence, sources, p_metadata, clock_timestamp());
  return sources;
end;
$$;

-- 7. 승인된 비교 조건 변경 검증: 비교 결과의 tradeStats.observations 날짜 검사에서 반복 함수 호출을 제거한다.
-- 직전 정의: 20261126110000_upload_supplement.sql
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
            where not coalesce(
              jsonb_typeof(o.obs) = 'object'
              and jsonb_typeof(o.obs->'contractDate') = 'string'
              and (case
                when o.obs->>'contractDate' ~ '\A[0-9]{4}-[0-9]{2}-[0-9]{2}\Z'
                  and pg_input_is_valid(o.obs->>'contractDate', 'date')
                then (o.obs->>'contractDate')::date between expected_start and expected_end
                else false end),
              false
            )
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

notify pgrst, 'reload schema';
