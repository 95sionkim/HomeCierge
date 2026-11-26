-- 작업 E: 공고·업로드 보완 실행에서 자동 생성한 비교 근거(comparison-evidence/v1)의 원자 저장과
-- 사용자 식별자 없는 공유 법정동·단지 근거 캐시(관측 시각·재사용 기한·출처 권한 강제)를 추가한다.
-- public.source_registry의 기존 권한 값은 변경하지 않는다.

alter table private.comparison_evidence
  add column if not exists metadata jsonb,
  add column if not exists updated_at timestamptz not null default now();

alter table private.comparison_evidence
  add constraint comparison_evidence_metadata_check check (
    metadata is null
    or (jsonb_typeof(metadata) = 'object' and not private.comparison_contains_raw_payload(metadata))
  );

-- 사용자·분석 식별자 없는 공식 법정동코드(시·군·구별 하위 법정동·읍·면·리) 공유 캐시.
create table private.legal_region_locality_cache (
  request_region_code text primary key check (request_region_code ~ '\A[0-9]{5}\Z'),
  region_name text not null check (length(btrim(region_name)) between 1 and 120 and region_name = btrim(region_name)),
  has_district boolean not null,
  expansion_kind text not null check (expansion_kind in ('district', 'municipality')),
  expansion_code text not null check (expansion_code ~ '\A[0-9]{5}\Z'),
  localities jsonb not null check (
    jsonb_typeof(localities) = 'array'
    and jsonb_array_length(localities) > 0
    and not private.comparison_contains_raw_payload(localities)
  ),
  source_id text not null default 'mois_legal_region_codes' references public.source_registry(id),
  observed_at timestamptz not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  check (source_id = 'mois_legal_region_codes'),
  check (expires_at > observed_at and expires_at <= observed_at + interval '90 days')
);

alter table private.legal_region_locality_cache enable row level security;
revoke all on private.legal_region_locality_cache from public, anon, authenticated, service_role;

-- 사용자·분석 식별자 없는 단지·출처 단위 공유 근거 캐시.
-- 청약홈 구조화 자료(applyhome_supply_area)와 저장·재사용이 허용된 경우의 카카오 대표 좌표(kakao_road_coordinate)만 허용한다.
create table private.complex_evidence_cache (
  complex_key text not null check (
    length(btrim(complex_key)) between 1 and 200
    and complex_key = btrim(complex_key)
    and complex_key !~ '[[:cntrl:]]'
  ),
  cache_kind text not null check (cache_kind in ('applyhome_supply_area', 'kakao_road_coordinate')),
  entry_data jsonb not null check (
    jsonb_typeof(entry_data) = 'object'
    and not private.comparison_contains_raw_payload(entry_data)
  ),
  source_ids text[] not null check (
    cardinality(source_ids) > 0
    and array_position(source_ids, null) is null
  ),
  observed_at timestamptz not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (complex_key, cache_kind),
  check (expires_at > observed_at and expires_at <= observed_at + interval '90 days')
);

create index complex_evidence_cache_expires_idx
  on private.complex_evidence_cache (cache_kind, expires_at);

alter table private.complex_evidence_cache enable row level security;
revoke all on private.complex_evidence_cache from public, anon, authenticated, service_role;

-- 수집본에 연결할 comparison-evidence/v1을 register_comparison_evidence와 동일한 규칙으로 검증·저장한다.
create function private.validate_and_store_comparison_evidence(
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
      private.ingestion_v0_object(ref.value, array['source', 'reference'])
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

-- 공고 실행과 업로드 보완 실행 모두 해당 수집본에 comparison_evidence가 고정된 경우에만
-- 적용 범위(appliedScope)와 비교 단지 통계를 포함한 비교 결과를 허용한다.
-- 근거가 고정되지 않은 공고 실행은 계속 comparison_evidence_unverified 보류 상태만 허용한다.
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
    where (s.id, s.analysis_id, s.user_id) = (job.snapshot_id, job.analysis_id, job.user_id);
  capture_period := capture_result->'period';
  has_pinned_evidence := (
    job.input->>'kind' in ('notice', 'upload_supplement')
    and job.comparison_evidence_pinned
    and exists (select 1 from private.comparison_evidence e where e.snapshot_id = job.snapshot_id)
  );

  if not coalesce(
    new.result->'target' @> (job.notice_request->'target')
    and new.result#>'{conditions,asOf}' = job.notice_request->'asOf'
    and new.result#>'{conditions,period}' = capture_period
    and (case when capture_period->>'status' = 'confirmed' then
      new.result#>'{target,modelNo}' = job.input->'modelNo'
      and jsonb_typeof(new.result#>'{target,houseType}') = 'string'
      and private.notice_run_house_type(new.result#>>'{target,houseType}') = job.notice_house_type
      and new.result#>'{conditions,tradeKinds}' = job.notice_request->'tradeKinds'
    else
      new.result#>'{target,modelNo}' = 'null'::jsonb
      and new.result#>'{target,houseType}' = 'null'::jsonb
      and new.result#>'{conditions,tradeKinds}' = '[]'::jsonb
    end)
    and (
      has_pinned_evidence
      or (
        new.result->>'completeness' <> 'complete'
        and new.result->'appliedScope' = 'null'::jsonb
        and new.result->'rankingComplete' = 'false'::jsonb
        and new.result->'comparables' = '[]'::jsonb
        and new.result->'targetReferences' = '[]'::jsonb
        and coalesce(new.result->'candidatePool', '[]'::jsonb) = '[]'::jsonb
        and new.result->'tradeKinds' = '{}'::jsonb
        and new.result->'exclusions' = '[]'::jsonb
        and new.result#>'{regionDecision,priority}' = 'null'::jsonb
        and new.result#>'{regionDecision,expansion}' = 'null'::jsonb
      )
    ),
    false
  )
    or jsonb_array_length(new.result->'collections') <> jsonb_array_length(capture_result->'tradeBatches')
    or exists (
      select 1 from jsonb_array_elements(capture_result->'tradeBatches') as b(batch)
      cross join lateral (select b.batch->'record' as record) as capture
      where not exists (
        select 1 from jsonb_array_elements(new.result->'collections') as c(value)
        where (c.value->'source', c.value->'requestRegionCode', c.value->'month', c.value->'tradeKinds')
          = (capture.record->'source', capture.record->'requestRegionCode', capture.record->'month', capture.record->'tradeKinds')
          and (c.value->'status' = capture.record->'status'
            or (c.value->>'status' = 'partial' and capture.record->>'status' in ('complete', 'empty')))
      )
    ) then
    raise exception 'invalid_notice_comparison_result' using errcode = '22023';
  end if;
  return new;
end;
$$;

-- 작업자 전용: 자동 비교 근거 구성에 필요한 출처별 현재 허용 상태를 source_registry에서 읽기 전용으로 조회한다.
create function private.read_auto_evidence_permissions(
  p_run_id uuid,
  p_generation integer,
  p_lease_token uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id, p_generation, p_lease_token);
  applyhome_apt boolean;
  applyhome_remainder boolean;
  mois_regions boolean;
  kakao_runtime boolean;
  kakao_storage boolean;
begin
  if job.input->>'kind' not in ('notice', 'upload_supplement') then
    raise exception 'notice_run_required' using errcode = '22023';
  end if;

  applyhome_apt := private.comparison_sources_permitted(array['applyhome_apt', 'applyhome_apt_model']);
  applyhome_remainder := private.comparison_sources_permitted(array['applyhome_remainder', 'applyhome_remainder_model']);
  mois_regions := private.comparison_sources_permitted(array['mois_legal_region_codes']);
  kakao_storage := private.comparison_sources_permitted(array['kakao_address']);
  select exists(
    select 1 from public.source_registry r
    where r.id = 'kakao_address' and r.display_permission = 'allowed'
  ) into kakao_runtime;

  if job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;

  return jsonb_build_object(
    'applyhomeApt', applyhome_apt,
    'applyhomeRemainder', applyhome_remainder,
    'moisRegions', mois_regions,
    'kakaoRuntime', kakao_runtime,
    'kakaoStorage', kakao_storage
  );
end;
$$;

-- 작업자 전용: 유효 기한과 출처 권한을 통과한 공유 법정동·단지 근거 캐시를 읽는다.
create function private.read_auto_evidence_cache(
  p_run_id uuid,
  p_generation integer,
  p_lease_token uuid,
  p_region_code text,
  p_complex_keys text[] default '{}'::text[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id, p_generation, p_lease_token);
  now_ts timestamptz := clock_timestamp();
  keys text[] := coalesce(p_complex_keys, '{}'::text[]);
  region_json jsonb := null;
  applyhome_json jsonb := '{}'::jsonb;
  kakao_json jsonb := '{}'::jsonb;
  kakao_storage_ok boolean := private.comparison_sources_permitted(array['kakao_address']);
begin
  if job.input->>'kind' not in ('notice', 'upload_supplement') then
    raise exception 'notice_run_required' using errcode = '22023';
  end if;
  if p_region_code is null or p_region_code !~ '\A[0-9]{5}\Z' then
    raise exception 'invalid_region_code' using errcode = '22023';
  end if;
  if cardinality(keys) > 500 or array_position(keys, null) is not null then
    raise exception 'invalid_cache_keys' using errcode = '22023';
  end if;

  if private.comparison_sources_permitted(array['mois_legal_region_codes']) then
    select jsonb_build_object(
      'requestRegionCode', r.request_region_code,
      'regionName', r.region_name,
      'hasDistrict', r.has_district,
      'expansionKind', r.expansion_kind,
      'expansionCode', r.expansion_code,
      'localities', r.localities,
      'observedAt', r.observed_at,
      'expiresAt', r.expires_at
    ) into region_json
    from private.legal_region_locality_cache r
    where r.request_region_code = p_region_code
      and r.expires_at > now_ts;
  end if;

  if cardinality(keys) > 0 then
    select coalesce(jsonb_object_agg(c.complex_key, c.entry_data), '{}'::jsonb)
      into applyhome_json
    from private.complex_evidence_cache c
    where c.cache_kind = 'applyhome_supply_area'
      and c.complex_key = any(keys)
      and c.expires_at > now_ts
      and private.comparison_sources_permitted(c.source_ids);

    if kakao_storage_ok then
      select coalesce(jsonb_object_agg(c.complex_key, c.entry_data), '{}'::jsonb)
        into kakao_json
      from private.complex_evidence_cache c
      where c.cache_kind = 'kakao_road_coordinate'
        and c.complex_key = any(keys)
        and c.expires_at > now_ts
        and private.comparison_sources_permitted(c.source_ids);
    end if;
  end if;

  if job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;

  return jsonb_build_object(
    'region', region_json,
    'applyhome', applyhome_json,
    'kakao', kakao_json
  );
end;
$$;

-- 작업자 전용: 출처의 저장·재사용·표시 허용이 확인된 공유 법정동·단지 근거 캐시만 갱신한다.
create function private.upsert_auto_evidence_cache(
  p_run_id uuid,
  p_generation integer,
  p_lease_token uuid,
  p_region jsonb default null,
  p_entries jsonb default '[]'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id, p_generation, p_lease_token);
  region_stored boolean := false;
  entries_stored integer := 0;
  region_obs timestamptz;
  region_exp timestamptz;
  entry jsonb;
  entry_kind text;
  entry_key text;
  entry_data jsonb;
  entry_sources text[];
  entry_obs timestamptz;
  entry_exp timestamptz;
begin
  if job.input->>'kind' not in ('notice', 'upload_supplement') then
    raise exception 'notice_run_required' using errcode = '22023';
  end if;

  if p_region is not null then
    if not coalesce(
      private.ingestion_v0_object(
        p_region,
        array['requestRegionCode', 'regionName', 'hasDistrict', 'expansionKind', 'expansionCode', 'localities', 'observedAt', 'expiresAt']
      )
      and p_region->>'requestRegionCode' ~ '\A[0-9]{5}\Z'
      and jsonb_typeof(p_region->'regionName') = 'string'
      and length(btrim(p_region->>'regionName')) between 1 and 120
      and jsonb_typeof(p_region->'hasDistrict') = 'boolean'
      and p_region->>'expansionKind' in ('district', 'municipality')
      and p_region->>'expansionCode' ~ '\A[0-9]{5}\Z'
      and jsonb_typeof(p_region->'localities') = 'array'
      and jsonb_array_length(p_region->'localities') > 0
      and jsonb_typeof(p_region->'observedAt') = 'string'
      and jsonb_typeof(p_region->'expiresAt') = 'string'
      and not private.comparison_contains_raw_payload(p_region),
      false
    ) then
      raise exception 'invalid_region_cache_entry' using errcode = '22023';
    end if;

    perform private.require_comparison_sources(array['mois_legal_region_codes']);
    region_obs := (p_region->>'observedAt')::timestamptz;
    region_exp := (p_region->>'expiresAt')::timestamptz;
    if region_exp <= region_obs or region_exp > region_obs + interval '90 days' then
      raise exception 'invalid_cache_ttl' using errcode = '22023';
    end if;

    insert into private.legal_region_locality_cache(
      request_region_code, region_name, has_district, expansion_kind, expansion_code,
      localities, source_id, observed_at, expires_at, updated_at
    ) values (
      p_region->>'requestRegionCode',
      btrim(p_region->>'regionName'),
      (p_region->>'hasDistrict')::boolean,
      p_region->>'expansionKind',
      p_region->>'expansionCode',
      p_region->'localities',
      'mois_legal_region_codes',
      region_obs,
      region_exp,
      clock_timestamp()
    )
    on conflict (request_region_code) do update set
      region_name = excluded.region_name,
      has_district = excluded.has_district,
      expansion_kind = excluded.expansion_kind,
      expansion_code = excluded.expansion_code,
      localities = excluded.localities,
      observed_at = excluded.observed_at,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at;
    region_stored := true;
  end if;

  if p_entries is null then
    p_entries := '[]'::jsonb;
  end if;
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 200 then
    raise exception 'invalid_evidence_cache_entries' using errcode = '22023';
  end if;

  for entry in select value from jsonb_array_elements(p_entries) loop
    if not coalesce(
      private.ingestion_v0_object(
        entry,
        array['complexKey', 'cacheKind', 'sourceIds', 'observedAt', 'expiresAt', 'entryData']
      )
      and jsonb_typeof(entry->'complexKey') = 'string'
      and length(btrim(entry->>'complexKey')) between 1 and 200
      and entry->>'complexKey' = btrim(entry->>'complexKey')
      and entry->>'complexKey' !~ '[[:cntrl:]]'
      and entry->>'cacheKind' in ('applyhome_supply_area', 'kakao_road_coordinate')
      and jsonb_typeof(entry->'sourceIds') = 'array'
      and jsonb_array_length(entry->'sourceIds') > 0
      and jsonb_typeof(entry->'observedAt') = 'string'
      and jsonb_typeof(entry->'expiresAt') = 'string'
      and jsonb_typeof(entry->'entryData') = 'object'
      and not private.comparison_contains_raw_payload(entry),
      false
    ) then
      raise exception 'invalid_evidence_cache_entry' using errcode = '22023';
    end if;

    entry_key := entry->>'complexKey';
    entry_kind := entry->>'cacheKind';
    entry_data := entry->'entryData';
    entry_sources := array(
      select distinct elem
      from jsonb_array_elements_text(entry->'sourceIds') as t(elem)
      order by elem
    );
    if cardinality(entry_sources) = 0
      or array_position(entry_sources, null) is not null
      or exists (select 1 from unnest(entry_sources) as s(id) where id = '' or id <> btrim(id)) then
      raise exception 'invalid_evidence_cache_entry' using errcode = '22023';
    end if;

    if entry_kind = 'applyhome_supply_area' then
      if not (entry_sources <@ array['applyhome_apt', 'applyhome_apt_model', 'applyhome_remainder', 'applyhome_remainder_model']) then
        raise exception 'invalid_evidence_cache_source' using errcode = '42501';
      end if;
    elsif entry_kind = 'kakao_road_coordinate' then
      if entry_sources <> array['kakao_address'] then
        raise exception 'invalid_evidence_cache_source' using errcode = '42501';
      end if;
    end if;

    -- 출처 권한이 허용되지 않은 항목(예: 저장 미허용 상태의 카카오 좌표)은 DB에서 저장을 차단한다.
    perform private.require_comparison_sources(entry_sources);

    entry_obs := (entry->>'observedAt')::timestamptz;
    entry_exp := (entry->>'expiresAt')::timestamptz;
    if entry_exp <= entry_obs or entry_exp > entry_obs + interval '90 days' then
      raise exception 'invalid_cache_ttl' using errcode = '22023';
    end if;

    insert into private.complex_evidence_cache(
      complex_key, cache_kind, entry_data, source_ids, observed_at, expires_at, updated_at
    ) values (
      entry_key, entry_kind, entry_data, entry_sources, entry_obs, entry_exp, clock_timestamp()
    )
    on conflict (complex_key, cache_kind) do update set
      entry_data = excluded.entry_data,
      source_ids = excluded.source_ids,
      observed_at = excluded.observed_at,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at;
    entries_stored := entries_stored + 1;
  end loop;

  if job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;

  return jsonb_build_object('regionStored', region_stored, 'entriesStored', entries_stored);
end;
$$;

-- 작업자 전용: 수집본 + 자동 비교 근거(comparison-evidence/v1) + 비교 결과(comparison/v1) +
-- (선택) 납부 일정을 한 트랜잭션에 원자 저장하고 comparison_evidence_pinned를 true로 고정한다.
create function private.finish_notice_with_evidence(
  p_run_id uuid,
  p_generation integer,
  p_lease_token uuid,
  p_input jsonb,
  p_result jsonb,
  p_comparison jsonb,
  p_evidence jsonb,
  p_evidence_sources text[],
  p_evidence_metadata jsonb default null,
  p_schedules jsonb default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id, p_generation, p_lease_token);
  operation jsonb;
  captured_id uuid;
  snapshot public.analysis_input_snapshots%rowtype;
  approved_turn private.analysis_chat_turns%rowtype;
  evidence_sources text[];
  sources text[];
begin
  if job.input->>'kind' not in ('notice', 'upload_supplement') then
    raise exception 'notice_run_required' using errcode = '22023';
  end if;

  if not coalesce(
    jsonb_typeof(p_comparison) = 'object'
    and p_comparison->>'contractVersion' = 'comparison/v1'
    and p_comparison->>'dataOrigin' = 'collected'
    and p_comparison->>'completeness' in ('complete', 'partial', 'unavailable')
    and (p_comparison->'appliedScope' = 'null'::jsonb or p_comparison->>'appliedScope' in ('priority', 'expansion'))
    and jsonb_typeof(p_comparison->'target') in ('object', 'null')
    and jsonb_typeof(p_comparison->'conditions') = 'object'
    and jsonb_typeof(p_comparison->'noticePrice') in ('object', 'null')
    and jsonb_typeof(p_comparison->'regionDecision') = 'object'
    and jsonb_typeof(p_comparison->'tradeKinds') = 'object'
    and jsonb_typeof(p_comparison->'collections') = 'array'
    and jsonb_typeof(p_comparison->'comparables') = 'array'
    and jsonb_typeof(p_comparison->'targetReferences') = 'array'
    and (not (p_comparison ? 'candidatePool') or jsonb_typeof(p_comparison->'candidatePool') = 'array')
    and jsonb_typeof(p_comparison->'holds') = 'array'
    and jsonb_typeof(p_comparison->'exclusions') = 'array'
    and jsonb_typeof(p_comparison->'rankingComplete') = 'boolean'
    and not private.comparison_contains_raw_payload(p_comparison),
    false
  ) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;
  if jsonb_array_length(p_comparison->'comparables') > 5 then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  operation := private.finish_analysis_run_core(p_run_id, p_generation, p_lease_token, p_input, p_result, true);
  captured_id := (operation->>'snapshotId')::uuid;
  select * into strict snapshot from public.analysis_input_snapshots s
    where (s.id, s.capture_key, s.analysis_id, s.user_id) = (captured_id, job.id, job.analysis_id, job.user_id);

  if p_comparison->>'dataOrigin' is distinct from snapshot.data_origin then
    raise exception 'comparison_snapshot_origin_mismatch' using errcode = '22023';
  end if;

  evidence_sources := private.validate_and_store_comparison_evidence(
    snapshot, p_evidence, p_evidence_sources, p_evidence_metadata
  );
  update private.analysis_runs set comparison_evidence_pinned = true where id = job.id;
  job.comparison_evidence_pinned := true;

  -- finish_analysis_comparison과 같이, 승인된 조건 변경의 결과 실행이면 승인 조건과 결과를 대조한다.
  select * into approved_turn from private.analysis_chat_turns t
    where (t.result_run_id, t.analysis_id, t.user_id) = (job.id, job.analysis_id, job.user_id)
      and t.proposal_status = 'approved';
  if found then
    perform private.check_approved_condition_comparison(job, snapshot, approved_turn, p_comparison);
  end if;

  sources := private.comparison_sources(snapshot.id, evidence_sources);
  perform private.require_comparison_sources(sources);
  insert into private.comparison_results(run_id, result, source_ids) values (job.id, p_comparison, sources);

  if p_schedules is not null then
    if jsonb_typeof(p_schedules) <> 'array' then
      raise exception 'invalid_funding_schedules' using errcode = '22023';
    end if;
    if p_schedules <> '[]'::jsonb then
      perform private.require_comparison_sources(
        private.funding_schedule_sources_for_snapshot(snapshot.id, snapshot.notice_source, p_schedules)
      );
    end if;
    perform private.check_funding_schedules(snapshot, p_schedules);
    insert into private.analysis_funding_schedule_snapshots(snapshot_id, schedules)
      values (snapshot.id, p_schedules);
  end if;

  if job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;
  return operation;
end;
$$;

-- 공용 얇은 invoker 진입점 (PostgREST 호환, service_role 전용).
create function public.read_auto_evidence_permissions(
  p_run_id uuid,
  p_generation integer,
  p_lease_token uuid
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.read_auto_evidence_permissions(p_run_id, p_generation, p_lease_token);
$$;

create function public.read_auto_evidence_cache(
  p_run_id uuid,
  p_generation integer,
  p_lease_token uuid,
  p_region_code text,
  p_complex_keys text[] default '{}'::text[]
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.read_auto_evidence_cache(p_run_id, p_generation, p_lease_token, p_region_code, p_complex_keys);
$$;

create function public.upsert_auto_evidence_cache(
  p_run_id uuid,
  p_generation integer,
  p_lease_token uuid,
  p_region jsonb default null,
  p_entries jsonb default '[]'::jsonb
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.upsert_auto_evidence_cache(p_run_id, p_generation, p_lease_token, p_region, p_entries);
$$;

create function public.finish_notice_with_evidence(
  p_run_id uuid,
  p_generation integer,
  p_lease_token uuid,
  p_input jsonb,
  p_result jsonb,
  p_comparison jsonb,
  p_evidence jsonb,
  p_evidence_sources text[],
  p_evidence_metadata jsonb default null,
  p_schedules jsonb default null
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.finish_notice_with_evidence(
    p_run_id, p_generation, p_lease_token, p_input, p_result,
    p_comparison, p_evidence, p_evidence_sources, p_evidence_metadata, p_schedules
  );
$$;

revoke all on function
  private.validate_and_store_comparison_evidence(public.analysis_input_snapshots, jsonb, text[], jsonb),
  private.check_notice_run_comparison(),
  private.read_auto_evidence_permissions(uuid, integer, uuid),
  private.read_auto_evidence_cache(uuid, integer, uuid, text, text[]),
  private.upsert_auto_evidence_cache(uuid, integer, uuid, jsonb, jsonb),
  private.finish_notice_with_evidence(uuid, integer, uuid, jsonb, jsonb, jsonb, jsonb, text[], jsonb, jsonb),
  public.read_auto_evidence_permissions(uuid, integer, uuid),
  public.read_auto_evidence_cache(uuid, integer, uuid, text, text[]),
  public.upsert_auto_evidence_cache(uuid, integer, uuid, jsonb, jsonb),
  public.finish_notice_with_evidence(uuid, integer, uuid, jsonb, jsonb, jsonb, jsonb, text[], jsonb, jsonb)
from public, anon, authenticated, service_role;

grant execute on function
  private.read_auto_evidence_permissions(uuid, integer, uuid),
  private.read_auto_evidence_cache(uuid, integer, uuid, text, text[]),
  private.upsert_auto_evidence_cache(uuid, integer, uuid, jsonb, jsonb),
  private.finish_notice_with_evidence(uuid, integer, uuid, jsonb, jsonb, jsonb, jsonb, text[], jsonb, jsonb),
  public.read_auto_evidence_permissions(uuid, integer, uuid),
  public.read_auto_evidence_cache(uuid, integer, uuid, text, text[]),
  public.upsert_auto_evidence_cache(uuid, integer, uuid, jsonb, jsonb),
  public.finish_notice_with_evidence(uuid, integer, uuid, jsonb, jsonb, jsonb, jsonb, text[], jsonb, jsonb)
to service_role;

notify pgrst, 'reload schema';
