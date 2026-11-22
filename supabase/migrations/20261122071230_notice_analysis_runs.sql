-- BE-11: 로그인 사용자가 목록에서 고른 공고·회차·주택형으로 기존 실행 큐를 사용한다.
-- 별도 큐를 두지 않는다. 접수 때 대상과 기준일을 고정하고, 작업자는 BE-03 저장 경로로 실제 수집본을 남긴다.
alter table private.analysis_runs
  add column notice_request jsonb,
  add column notice_house_type text,
  drop constraint analysis_runs_error_code_check,
  add constraint analysis_runs_error_code_check check (error_code in ('run_internal_error','run_deadline_exceeded',
    'notice_selection_unverified','notice_feed_unavailable','notice_source_restricted','notice_capture_limit')),
  -- 공고 실행만 수집 요청과 주택형을 고정한다. 공고 전용 실패 사유는 다른 입력에 기록하지 않는다.
  add constraint analysis_runs_notice_selection_check check (
    (input->>'kind' = 'notice') = (notice_request is not null)
    and (notice_request is null) = (notice_house_type is null)
    and (input->>'kind' = 'notice' or error_code is null or error_code in ('run_internal_error','run_deadline_exceeded'))
  );

-- 공개 선택 값과 같은 형식만 받는다. 저장값은 입력을 다시 구성한 원형이다.
create function private.notice_run_input_valid(p_input jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(private.ingestion_v0_object(p_input,array['kind','noticeSource','houseManageNo','noticeNo','edition','modelNo'])
    and p_input ?& array['kind','noticeSource','houseManageNo','noticeNo','edition','modelNo']
    and jsonb_typeof(p_input->'kind') = 'string' and p_input->>'kind' = 'notice'
    and jsonb_typeof(p_input->'noticeSource') = 'string' and p_input->>'noticeSource' in ('applyhome_apt','applyhome_remainder')
    and jsonb_typeof(p_input->'houseManageNo') = 'string' and p_input->>'houseManageNo' ~ '\A[0-9]{10}\Z'
    and jsonb_typeof(p_input->'noticeNo') = 'string' and p_input->>'noticeNo' ~ '\A[0-9]{10}\Z'
    and jsonb_typeof(p_input->'edition') = 'string' and p_input->>'edition' ~ '\A[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z'
    and jsonb_typeof(p_input->'modelNo') = 'string' and p_input->>'modelNo' ~ '\A[0-9]{1,20}\Z', false);
$$;

-- 공고 실행은 확인된 일반 계정만 접수한다. 기존 합성·수집본 입력의 인증 조건은 바꾸지 않는다.
create function private.require_notice_run_user(p_owner_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  if p_owner_id is null or coalesce(auth.jwt()->'is_anonymous','false'::jsonb) <> 'false'::jsonb
    or not exists (select 1 from auth.users u where u.id = p_owner_id and u.confirmed_at is not null
      and u.is_anonymous is false and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= statement_timestamp()) for share) then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
end;
$$;

-- 선택 확인에 사용하는 목록·지역 사전과, 수집할 주택형·거래 출처다. 공고 PDF는 읽기와 저장 때 따로 확인한다.
create function private.notice_run_selection_sources(p_notice_source text)
returns text[] language sql immutable set search_path = '' as $$
  select array['applyhome_apt','applyhome_remainder','mois_legal_region_codes',
    p_notice_source || '_model','apt_trade','apt_rights'];
$$;

create function private.notice_run_capture_sources(p_notice_source text)
returns text[] language sql immutable set search_path = '' as $$
  select array[p_notice_source,p_notice_source || '_model','mois_legal_region_codes','apt_trade','apt_rights'];
$$;

create function private.require_notice_run_sources(p_source_ids text[])
returns void language plpgsql set search_path = '' as $$
begin
  perform private.require_comparison_sources(p_source_ids);
exception when insufficient_privilege then
  raise exception 'notice_source_restricted' using errcode = 'PT403';
end;
$$;

-- 색인 표시값은 앞뒤 공백을 제거한 원문이다. 수집본의 주택형 원문도 같은 기준으로 비교한다.
create function private.notice_run_house_type(p_value text)
returns text language sql immutable strict set search_path = '' as $$
  select regexp_replace(p_value,
    '\A[\t\n\u000B\f\r \u001C-\u001F\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\t\n\u000B\f\r \u001C-\u001F\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+\Z',
    '','g');
$$;

-- 게시된 최신 공고 목록에서 선택을 확인하고 수집 지역과 주택형을 반환한다.
create function private.notice_run_selection(p_input jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  published jsonb := private.notice_directory_index_value();
  feed text := p_input->>'noticeSource';
  candidate jsonb;
  sources jsonb;
  reasons jsonb;
  model jsonb;
begin
  if published is null or published->>'contractVersion' is distinct from 'notice-search-index/v1'
    or published->>'dataOrigin' is distinct from 'collected' or jsonb_typeof(published->'notices') is distinct from 'array'
    or not coalesce(private.notice_search_is_fresh(private.notice_search_epoch(published->>'observedAt')),false) then
    raise exception 'notice_index_not_ready' using errcode = 'PT409';
  end if;
  -- 제한 상태에서 공고 존재 여부를 드러내지 않도록 권한을 먼저 확인한다.
  perform private.require_notice_run_sources(private.notice_run_selection_sources(feed));

  select n.value into candidate from jsonb_array_elements(published->'notices') as n(value)
    where n.value->'houseManageNo' = p_input->'houseManageNo' and n.value->'noticeNo' = p_input->'noticeNo';
  if candidate is null then
    raise exception 'notice_not_found' using errcode = 'PT409';
  end if;
  sources := candidate->'sourceIds';
  reasons := coalesce(candidate->'reasonCodes','[]'::jsonb);
  if not coalesce(sources ? feed and not (sources ? 'applyhome_apt' and sources ? 'applyhome_remainder'),false) then
    raise exception 'notice_source_conflict' using errcode = 'PT409';
  end if;
  if coalesce(candidate->>'kind','unknown') in ('unknown','unsupported')
    or reasons ?| array['kind_unverified','notice_kind_unverified','notice_kind_unsupported'] then
    raise exception 'notice_kind_unsupported' using errcode = 'PT409';
  end if;
  if private.law_reference_iso_date(candidate->>'edition') is null
    or not coalesce((candidate->>'edition') collate "C" between published#>>'{publicationWindow,start}'
      and published#>>'{publicationWindow,end}',false)
    or reasons ?| array['publication_date_unverified','notice_metadata_conflict'] then
    raise exception 'notice_edition_unverified' using errcode = 'PT409';
  end if;
  if candidate->'edition' is distinct from p_input->'edition' then
    raise exception 'notice_edition_mismatch' using errcode = 'PT409';
  end if;
  if not coalesce(jsonb_typeof(candidate->'regionCode') = 'string' and candidate->>'regionCode' ~ '\A[0-9]{5}\Z'
    and published->'regionCodes' ? (candidate->>'regionCode'),false) or reasons ? 'region_unverified' then
    raise exception 'notice_region_unverified' using errcode = 'PT409';
  end if;
  -- 빈 주택형 목록과 다른 피드의 주택형은 선택 근거가 아니다.
  if sources ? (feed || '_model') and jsonb_typeof(candidate->'models') = 'array' then
    select m.value into model from jsonb_array_elements(candidate->'models') as m(value)
      where m.value->'modelNo' = p_input->'modelNo';
  end if;
  if model is null then
    raise exception 'notice_model_not_found' using errcode = 'PT409';
  end if;
  if not coalesce(private.notice_search_label(model->'houseType',64),false) then
    raise exception 'notice_model_unverified' using errcode = 'PT409';
  end if;
  return jsonb_build_object('regionCode',candidate->'regionCode','houseType',model->'houseType');
end;
$$;

-- 분석에 명시된 대상·주택형과 다르면 덮어쓰지 않는다. 같은 값이면 다른 조건을 보존해 병합한다.
create function private.notice_run_conditions(p_conditions jsonb,p_notice_id uuid,p_housing_type_id uuid,p_input jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  target jsonb := jsonb_build_object('houseManageNo',p_input->'houseManageNo','noticeNo',p_input->'noticeNo',
    'edition',p_input->'edition','noticeSource',p_input->'noticeSource');
  comparison jsonb := coalesce(p_conditions->'comparison','{}'::jsonb);
begin
  if p_notice_id is not null or p_housing_type_id is not null
    or jsonb_typeof(comparison) <> 'object'
    or (p_conditions ? 'ingestion_target' and p_conditions->'ingestion_target' is distinct from target)
    or exists (select 1 from (values (p_conditions->'modelNo'),(p_conditions#>'{housingType,modelNo}'),
        (comparison->'modelNo')) as declared(value)
      where declared.value is not null and declared.value is distinct from p_input->'modelNo') then
    raise exception 'analysis_notice_selection_conflict' using errcode = 'PT409';
  end if;
  return p_conditions || jsonb_build_object('ingestion_target',target,
    'comparison',comparison || jsonb_build_object('modelNo',p_input->'modelNo'));
end;
$$;

-- 기본 최근 1년, 접수 시점의 한국 날짜, 공고 소재 시·군·구 한 곳과 세 거래 유형을 요청한다.
create function private.notice_run_request(p_input jsonb,p_as_of date,p_region_code text)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('noticeSource',p_input->'noticeSource',
    'target',jsonb_build_object('houseManageNo',p_input->'houseManageNo','noticeNo',p_input->'noticeNo','edition',p_input->'edition'),
    'asOf',to_char(p_as_of,'YYYY-MM-DD'),'requestRegionCodes',jsonb_build_array(p_region_code),
    'tradeKinds','["sale","presale_right","occupancy_right"]'::jsonb);
$$;

create function private.notice_capture_input_matches(p_request jsonb,p_input jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(p_input) = 'object' and p_input - 'pageSize' = p_request
    and (not p_input ? 'pageSize' or (jsonb_typeof(p_input->'pageSize') = 'number'
      and p_input->>'pageSize' ~ '\A([1-9][0-9]{0,2}|1000)\Z')), false);
$$;

-- BE-02와 같이 최근 1년의 달력 기준과 365일 기준이 달라지면 D-02의 결정을 보류한다.
-- BE-03은 이어서 기간에 걸친 모든 계약월·요청 지역·출처의 배치 구성을 검증한다.
create function private.notice_capture_period_matches(p_as_of date,p_period jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  leap_day boolean := extract(month from p_as_of) = 2 and extract(day from p_as_of) = 29;
  calendar_start date := (p_as_of - interval '1 year')::date + 1;
begin
  if leap_day or calendar_start <> p_as_of - 364 then
    return coalesce(p_period->>'status' = 'decision_required' and p_period->'inProgressMonth' = 'null'::jsonb
      and p_period->'decision' = jsonb_build_object('decisionId','D-02','reasonCode',case when leap_day
        then 'basis_date_is_leap_day' else 'calendar_year_and_365_day_starts_differ' end),false);
  end if;
  return coalesce(p_period->>'status' = 'confirmed' and p_period->>'start' = to_char(calendar_start,'YYYY-MM-DD')
    and p_period->>'inProgressMonth' = to_char(p_as_of,'YYYYMM') and p_period->'decision' = 'null'::jsonb,false);
end;
$$;

-- 캡처의 번호쌍 요청과 별도로, 실제 응답의 공고일과 주택형 식별 근거를 확인한다.
create function private.require_notice_capture_selection(p_job private.analysis_runs,p_catalog jsonb)
returns void language plpgsql set search_path = '' as $$
declare
  notice jsonb := p_catalog->'notice';
  reported_date jsonb := notice#>'{fields,RCRIT_PBLANC_DE}';
  coverage jsonb;
begin
  for coverage in select p_catalog#>'{collections,notice}' union all select p_catalog#>'{collections,model}' loop
    if not coalesce(coverage->>'declaredStatus' = 'complete' and coverage->>'status' = 'complete'
      and coverage->'inScope' = coverage->'observations',false) then
      raise exception 'notice_capture_selection_mismatch' using errcode = 'PT422';
    end if;
  end loop;
  if not coalesce(notice->>'status' = 'reported' and notice->'evidence' @> '[{"collection":"notice"}]'::jsonb
    and reported_date->>'status' = 'reported' and reported_date->'value' = p_job.input->'edition',false) then
    raise exception 'notice_capture_selection_mismatch' using errcode = 'PT422';
  end if;
  if not exists (select 1 from jsonb_array_elements(p_catalog->'housingTypes') as m(value)
    where m.value->'modelNo' = p_job.input->'modelNo' and m.value->>'status' = 'linked'
      and m.value->'evidence' @> '[{"collection":"model"}]'::jsonb
      and m.value#>>'{houseType,status}' = 'reported' and jsonb_typeof(m.value#>'{houseType,value}') = 'string'
      and private.notice_run_house_type(m.value#>>'{houseType,value}') = p_job.notice_house_type) then
    raise exception 'notice_capture_model_mismatch' using errcode = 'PT422';
  end if;
end;
$$;

create or replace function private.enqueue_analysis_run(p_analysis_id uuid,p_idempotency_key uuid,p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := private.analysis_run_owner();
  fixed public.analyses%rowtype;
  job private.analysis_runs%rowtype;
  source_snapshot_id uuid;
  basis date := (private.synthetic_ingestion_run_request()->>'asOf')::date;
  submitted timestamptz;
  notice_selection jsonb;
  notice_request jsonb;
begin
  if p_analysis_id is null or p_idempotency_key is null then
    raise exception 'analysis_run_ids_required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input) = 'object' and p_input->'kind' = '"notice"'::jsonb then
    perform private.require_notice_run_user(owner_id);
    if not private.notice_run_input_valid(p_input) then
      raise exception 'invalid_analysis_run_input' using errcode = '22023';
    end if;
    p_input := jsonb_build_object('kind','notice','noticeSource',p_input->'noticeSource','houseManageNo',p_input->'houseManageNo',
      'noticeNo',p_input->'noticeNo','edition',p_input->'edition','modelNo',p_input->'modelNo');
  elsif p_input is distinct from '{"kind":"synthetic","fixture":"ingestion-v0"}'::jsonb then
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
  -- 같은 키의 재전송은 이후 색인 교체나 권한 변경과 무관하게 처음 접수한 실행을 반환한다.
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
  if p_input->>'kind' = 'notice' then
    notice_selection := private.notice_run_selection(p_input);
    fixed.conditions_snapshot := private.notice_run_conditions(fixed.conditions_snapshot,fixed.notice_id,fixed.housing_type_id,p_input);
  end if;

  -- 최근 60초의 신규 접수 최대 12건은 로컬 실행 실험값이다.
  submitted := clock_timestamp();
  if (select count(*) from private.analysis_runs r
    where r.user_id = owner_id and r.submitted_at > submitted - interval '60 seconds') >= 12 then
    raise exception 'analysis_run_rate_limited' using errcode = 'PT429';
  end if;
  if notice_selection is not null then
    -- 기준일은 접수 시점의 한국 날짜로 고정한다. 대상과 주택형은 분석·실행·이후 캡처에 같은 값으로 남는다.
    basis := (submitted at time zone 'Asia/Seoul')::date;
    notice_request := private.notice_run_request(p_input,basis,notice_selection->>'regionCode');
    update public.analyses a set conditions_snapshot = fixed.conditions_snapshot
      where (a.id,a.user_id) = (p_analysis_id,owner_id) and a.conditions_snapshot is distinct from fixed.conditions_snapshot;
  end if;
  insert into private.analysis_runs(analysis_id,user_id,idempotency_key,input,conditions_snapshot,profile_revision,
    rules_version,notice_id,housing_type_id,basis_date,submitted_at,next_claim_at,notice_request,notice_house_type)
  values (p_analysis_id,owner_id,p_idempotency_key,p_input,fixed.conditions_snapshot,
    (select p.revision from public.user_profiles p where p.user_id = owner_id),
    fixed.rules_version,fixed.notice_id,fixed.housing_type_id,basis,submitted,submitted,
    notice_request,notice_selection->>'houseType')
  returning * into job;
  return private.analysis_run_operation(job);
end;
$$;

-- 접수 때 고정한 조건·규칙·대상이 분석에 그대로 있는지 확인한다.
create function private.require_unchanged_run_inputs(p_job private.analysis_runs)
returns void language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.analyses a where (a.id,a.user_id) = (p_job.analysis_id,p_job.user_id)
    and (a.conditions_snapshot,a.rules_version,a.notice_id,a.housing_type_id) is not distinct from
        (p_job.conditions_snapshot,p_job.rules_version,p_job.notice_id,p_job.housing_type_id)) then
    raise exception 'analysis_run_input_changed' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.read_comparison_work(p_run_id uuid,p_generation integer,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id,p_generation,p_lease_token);
  synthetic_selection constant jsonb := '{"kind":"synthetic","fixture":"ingestion-v0"}';
  saved record;
  ingestion jsonb;
  evidence jsonb;
  notice_capture jsonb;
  use_synthetic_fixture boolean := job.input = synthetic_selection;
  -- 수집 요청의 번호·회차가 일치해도 별도 카탈로그 UUID에 대한 대응 근거가 필요하다.
  binding_issue text := case
    when job.notice_id is not null then 'target_identity_unverified'
    when job.housing_type_id is not null then 'housing_type_identity_unverified'
  end;
begin
  if job.input->>'kind' = 'notice' then
    -- 공고 실행은 완료 트랜잭션에서만 수집본을 만든다. 읽을 때는 고정한 요청과 현재 이용 조건만 전달한다.
    perform private.require_unchanged_run_inputs(job);
    perform private.require_notice_run_sources(private.notice_run_capture_sources(job.input->>'noticeSource'));
    notice_capture := jsonb_build_object('asOf',job.notice_request->'asOf',
      'requestRegionCodes',job.notice_request->'requestRegionCodes',
      'allowOfficialPdf',private.comparison_sources_permitted(array['applyhome_notice_pdf']));
  elsif job.input->>'kind' = 'snapshot' then
    select s.id,s.data_origin,s.result_snapshot,e.evidence,e.source_ids,
      s.data_origin = 'synthetic' and exists (
        select 1 from private.analysis_runs original
        join private.comparison_results c on c.run_id = original.id
        where (original.id,original.snapshot_id,original.analysis_id,original.user_id) =
          (s.capture_key,s.id,s.analysis_id,s.user_id)
          and original.status = 'finished' and original.input = synthetic_selection
      ) as demo_capture into saved
      from public.analysis_input_snapshots s
      left join private.comparison_evidence e on job.comparison_evidence_pinned and e.snapshot_id = s.id
      where (s.id,s.analysis_id,s.user_id) = ((job.input->>'snapshotId')::uuid,job.analysis_id,job.user_id)
      for key share of s;
    if not found then
      raise exception 'analysis_run_snapshot_missing' using errcode = '22023';
    end if;
    if saved.data_origin = 'collected' then
      perform private.require_comparison_sources(private.comparison_sources(saved.id,saved.source_ids));
    end if;
    ingestion := saved.result_snapshot;
    evidence := saved.evidence;
    use_synthetic_fixture := saved.demo_capture;
  end if;
  if job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;
  if notice_capture is not null then
    return jsonb_build_object('conditions',job.conditions_snapshot,'ingestion',null,'evidence',null,
      'useSyntheticFixture',false,'selectionBindingIssue',null,'noticeCapture',notice_capture);
  end if;
  return jsonb_build_object('conditions',job.conditions_snapshot,'ingestion',ingestion,'evidence',evidence,
    'useSyntheticFixture',use_synthetic_fixture,'selectionBindingIssue',binding_issue);
end;
$$;

create function private.is_notice_run_capture(p_capture_key uuid,p_analysis_id uuid,p_user_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from private.analysis_runs r
    where (r.id,r.analysis_id,r.user_id) = (p_capture_key,p_analysis_id,p_user_id) and r.input->>'kind' = 'notice');
$$;

-- 실제 수집에 쓰인 출처와 공고 실행에서 조회 지역을 정하는 데 쓰인 공식 지역 사전을 함께 재확인한다.
create or replace function private.comparison_sources(p_snapshot_id uuid,p_evidence_sources text[])
returns text[] language sql stable set search_path = '' as $$
  select array(
    select c.source_id from public.ingestion_collections c where c.snapshot_id = p_snapshot_id
    union
    select case d.acquisition_source when 'official' then 'applyhome_notice_pdf' when 'upload' then 'user_upload' end
      from public.ingestion_document_versions d where d.snapshot_id = p_snapshot_id
    union
    select 'mois_legal_region_codes' from public.analysis_input_snapshots s
      where s.id = p_snapshot_id and private.is_notice_run_capture(s.capture_key,s.analysis_id,s.user_id)
    union
    select unnest(p_evidence_sources)
  );
$$;

-- 직접 조회와 security_invoker 수집 뷰에서도 공고 실행에 사용한 출처의 현재 권한을 확인한다.
create function private.notice_run_snapshot_visible(p_snapshot_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select
      not private.is_notice_run_capture(s.capture_key,s.analysis_id,s.user_id)
      or private.comparison_sources_permitted(private.comparison_sources(s.id,null))
    from public.analysis_input_snapshots s where (s.id,s.user_id) = (p_snapshot_id,auth.uid())),false);
$$;

alter policy owner_read on public.analysis_input_snapshots using (
  (select auth.uid()) = user_id and coalesce(((select auth.jwt())->>'is_anonymous'),'false') = 'false'
  and private.notice_run_snapshot_visible(id)
);

create or replace function public.finish_analysis_run(p_run_id uuid,p_generation integer,p_lease_token uuid,p_input jsonb,p_result jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id,p_generation,p_lease_token);
  captured_id uuid;
  captured_key uuid;
  capture_sources text[];
  finished timestamptz;
begin
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
  elsif job.input->>'kind' = 'notice' then
    -- 접수 때 고정한 공고·회차·지역·기준일과 다른 요청이나 합성 자료는 저장하지 않는다.
    if not private.notice_capture_input_matches(job.notice_request,p_input)
      or jsonb_typeof(p_result) is distinct from 'object' or p_result->>'dataOrigin' is distinct from 'collected'
      or not private.notice_capture_period_matches(job.basis_date,p_result->'period') then
      raise exception 'invalid_notice_capture_payload' using errcode = '22023';
    end if;
    perform private.require_unchanged_run_inputs(job);
    capture_sources := private.notice_run_capture_sources(job.input->>'noticeSource');
    if jsonb_path_exists(p_result,'lax $.catalog.documents[*] ? (@.source == "official")') then
      capture_sources := array_append(capture_sources,'applyhome_notice_pdf');
    end if;
    perform private.require_notice_run_sources(capture_sources);
    -- BE-03 저장 함수가 대상·조건·기간·지역과 저장 허가를 같은 규칙으로 검사한다.
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
    -- BE-03은 잠근 부모에서 조건과 대상을 읽는다. 접수 때와 달라지면 캡처하지 않는다.
    perform private.require_unchanged_run_inputs(job);
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

-- 공고 실행의 비교 입력에는 지역·단지·면적 대응 근거가 비어 있다.
-- 기존 완료 RPC의 같은 트랜잭션 안에서 비교의 선택과 기간을 대조하고 검증되지 않은 지역 결론을 차단한다.
create function private.check_notice_run_comparison()
returns trigger language plpgsql set search_path = '' as $$
declare
  job private.analysis_runs%rowtype;
  capture_result jsonb;
  capture_period jsonb;
begin
  select * into job from private.analysis_runs r where r.id = new.run_id and r.input->>'kind' = 'notice';
  if not found then
    return new;
  end if;
  select s.result_snapshot into capture_result from public.analysis_input_snapshots s
    where (s.id,s.analysis_id,s.user_id) = (job.snapshot_id,job.analysis_id,job.user_id);
  capture_period := capture_result->'period';
  if not coalesce(new.result->'target' @> (job.notice_request->'target')
    and new.result#>'{conditions,asOf}' = job.notice_request->'asOf'
    and new.result#>'{conditions,period}' = capture_period
    and (case when capture_period->>'status' = 'confirmed' then
      new.result#>'{target,modelNo}' = job.input->'modelNo'
      and jsonb_typeof(new.result#>'{target,houseType}') = 'string'
      and private.notice_run_house_type(new.result#>>'{target,houseType}') = job.notice_house_type
      and new.result#>'{conditions,tradeKinds}' = job.notice_request->'tradeKinds'
    else new.result#>'{target,modelNo}' = 'null'::jsonb
      and new.result#>'{conditions,tradeKinds}' = '[]'::jsonb end)
    and new.result->>'completeness' <> 'complete'
    and new.result->'appliedScope' = 'null'::jsonb and new.result->'rankingComplete' = 'false'::jsonb
    and new.result->'comparables' = '[]'::jsonb and new.result->'targetReferences' = '[]'::jsonb
    and new.result->'tradeKinds' = '{}'::jsonb and new.result->'exclusions' = '[]'::jsonb
    and new.result#>'{regionDecision,priority}' = 'null'::jsonb
    and new.result#>'{regionDecision,expansion}' = 'null'::jsonb,false)
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

create trigger check_notice_run_comparison before insert on private.comparison_results
  for each row execute function private.check_notice_run_comparison();

-- 공고 실행의 공개 실패 사유를 남긴다. 임대·시도 횟수·재시도 대기는 fail_analysis_run과 같다.
create function public.fail_notice_analysis_run(
  p_run_id uuid,p_generation integer,p_lease_token uuid,p_retryable boolean,p_error_code text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype;
  failed_at timestamptz;
  retry boolean;
begin
  if p_retryable is null then
    raise exception 'analysis_run_retryable_required' using errcode = '22023';
  end if;
  if p_error_code is null or p_error_code not in ('notice_selection_unverified','notice_feed_unavailable',
      'notice_source_restricted','notice_capture_limit') then
    raise exception 'invalid_notice_run_error_code' using errcode = '22023';
  end if;
  job := private.lock_leased_analysis_run(p_run_id,p_generation,p_lease_token);
  if job.input->>'kind' is distinct from 'notice' then
    raise exception 'notice_analysis_run_required' using errcode = '22023';
  end if;
  failed_at := clock_timestamp();
  retry := p_retryable and job.attempt < 3;
  -- 재시도 대기에는 사유를 남기지 않는다. 종료한 실패에서만 화면이 사유를 읽는다.
  update private.analysis_runs set status = case when retry then 'retry_wait' else 'failed' end,
    next_claim_at = case when retry then failed_at + make_interval(secs => job.attempt) end,
    finished_at = case when not retry then failed_at end, lease_token = null,
    error_code = case when not retry then p_error_code end where id = job.id returning * into job;
  return private.analysis_run_operation(job);
end;
$$;

revoke all on function private.notice_run_input_valid(jsonb), private.require_notice_run_user(uuid),
  private.notice_run_selection_sources(text), private.notice_run_capture_sources(text),
  private.require_notice_run_sources(text[]), private.notice_run_house_type(text), private.notice_run_selection(jsonb),
  private.notice_run_conditions(jsonb,uuid,uuid,jsonb), private.notice_run_request(jsonb,date,text),
  private.notice_capture_input_matches(jsonb,jsonb), private.notice_capture_period_matches(date,jsonb),
  private.require_notice_capture_selection(private.analysis_runs,jsonb),
  private.require_unchanged_run_inputs(private.analysis_runs), private.is_notice_run_capture(uuid,uuid,uuid),
  private.notice_run_snapshot_visible(uuid), private.check_notice_run_comparison(),
  public.fail_notice_analysis_run(uuid,integer,uuid,boolean,text)
from public, anon, authenticated, service_role;
grant execute on function private.notice_run_snapshot_visible(uuid) to authenticated;
grant execute on function public.fail_notice_analysis_run(uuid,integer,uuid,boolean,text) to service_role;
