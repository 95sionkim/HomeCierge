-- 앱 표시와 재사용·내보내기의 출처 허용 여부를 각각 기록한다.
alter table public.source_registry add column display_permission text not null default 'unknown'
  check (display_permission in ('unknown','allowed','denied'));

create table private.comparison_evidence (
  snapshot_id uuid primary key references public.analysis_input_snapshots(id) on delete cascade,
  evidence jsonb not null,
  source_ids text[] not null
);
create table private.comparison_results (
  run_id uuid primary key references private.analysis_runs(id) on delete cascade,
  result jsonb not null,
  source_ids text[] not null
);
alter table private.comparison_evidence enable row level security;
alter table private.comparison_results enable row level security;
revoke all on private.comparison_evidence, private.comparison_results from public, anon, authenticated, service_role;

-- 근거는 스냅샷당 한 번 저장한다. 기존 실행과 등록 전 접수는 근거 없음으로 고정한다.
alter table private.analysis_runs add column comparison_evidence_pinned boolean not null default false;

create function private.pin_comparison_evidence()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.comparison_evidence_pinned := exists (
    select 1 from private.comparison_evidence e
    join public.analysis_input_snapshots s on s.id = e.snapshot_id
    where (s.id,s.analysis_id,s.user_id) = ((new.input->>'snapshotId')::uuid,new.analysis_id,new.user_id)
  );
  return new;
end;
$$;
create trigger pin_comparison_evidence before insert on private.analysis_runs
  for each row when (new.input->>'kind' = 'snapshot') execute function private.pin_comparison_evidence();

create function private.comparison_sources(p_snapshot_id uuid,p_evidence_sources text[])
returns text[] language sql stable set search_path = '' as $$
  select array(
    select c.source_id from public.ingestion_collections c where c.snapshot_id = p_snapshot_id
    union
    select case d.acquisition_source when 'official' then 'applyhome_notice_pdf' when 'upload' then 'user_upload' end
      from public.ingestion_document_versions d where d.snapshot_id = p_snapshot_id
    union
    select unnest(p_evidence_sources)
  );
$$;

create function private.comparison_sources_permitted(p_source_ids text[])
returns boolean language sql stable set search_path = '' as $$
  select not exists (
    select 1 from unnest(p_source_ids) as source(id)
    left join public.source_registry r on r.id = source.id
    where source.id in ('user_upload','upload') or r.retention_days is not null
      or r.storage_permission is distinct from 'allowed'
      or r.reuse_permission is distinct from 'allowed'
      or r.display_permission is distinct from 'allowed'
  );
$$;

create function private.require_comparison_sources(p_source_ids text[])
returns void language plpgsql set search_path = '' as $$
declare locked_count bigint;
begin
  -- 출처 허용 상태를 확인하는 동안 그 레지스트리 행을 고정한다.
  perform 1 from public.source_registry r where r.id = any(p_source_ids) order by r.id for share;
  get diagnostics locked_count = row_count;
  if locked_count <> cardinality(p_source_ids) or not private.comparison_sources_permitted(p_source_ids) then
    raise exception 'comparison_source_use_not_allowed' using errcode = '42501';
  end if;
end;
$$;

create function private.comparison_contains_raw_payload(value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_path_exists(value, 'strict $.** ? (@.type() == "object" &&
    (exists(@.body) || exists(@.response) || exists(@.payload) || exists(@.raw) || exists(@.rawBody) || exists(@.rawApi) ||
     exists(@.rawPdf) || exists(@.rawResponse) || exists(@.pdfBytes) || exists(@.pdfText) || exists(@.fileBytes)))');
$$;

create function public.register_comparison_evidence(p_snapshot_id uuid,p_evidence jsonb,p_source_ids text[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  snapshot public.analysis_input_snapshots%rowtype;
  existing private.comparison_evidence%rowtype;
  sources text[] := array(select distinct id from unnest(p_source_ids) as source(id) order by id);
  target jsonb := p_evidence->'target';
  notice jsonb := target->'notice';
begin
  if not coalesce(p_snapshot_id is not null
    and cardinality(sources) > 0 and array_position(sources,null) is null
    and not exists (select 1 from unnest(sources) as source(id) where id = '' or id <> btrim(id))
    and private.ingestion_v0_object(p_evidence,array['contractVersion','dataOrigin','target','scopes','regions','complexes','tradeLinks'])
    and p_evidence->>'contractVersion' = 'comparison-evidence/v1' and p_evidence->>'dataOrigin' = 'collected'
    and jsonb_typeof(target->'complexId') = 'string' and btrim(target->>'complexId') <> ''
    and jsonb_typeof(target->'evidence') = 'object' and jsonb_typeof(notice->'address') = 'string'
    and jsonb_typeof(p_evidence->'scopes') = 'object'
    and jsonb_typeof(p_evidence->'regions') = 'array'
    and jsonb_typeof(p_evidence->'complexes') = 'array'
    and jsonb_typeof(p_evidence->'tradeLinks') = 'array'
    and not private.comparison_contains_raw_payload(p_evidence),false)
    or exists (select 1 from jsonb_path_query(p_evidence,
      'strict $.** ? (@.type() == "object" && exists(@.evidence)).evidence') as ref(value)
      where not coalesce(private.ingestion_v0_object(ref.value,array['source','reference'])
        and jsonb_typeof(ref.value->'source') = 'string' and btrim(ref.value->>'source') <> ''
        and jsonb_typeof(ref.value->'reference') = 'string' and btrim(ref.value->>'reference') <> '',false)) then
    raise exception 'invalid_comparison_evidence' using errcode = '22023';
  end if;

  -- 접수와 마찬가지로 분석을 먼저 잠근다. 접수 시점에 등록을 마친 근거만 고정한다.
  perform 1 from public.analyses a
    join public.analysis_input_snapshots s on (s.analysis_id,s.user_id) = (a.id,a.user_id)
    where s.id = p_snapshot_id for no key update of a;
  if not found then
    raise exception 'analysis_snapshot_not_found' using errcode = 'PT404';
  end if;
  select * into snapshot from public.analysis_input_snapshots s
    where s.id = p_snapshot_id for key share;
  if not found then
    raise exception 'analysis_snapshot_not_found' using errcode = 'PT404';
  end if;
  if snapshot.data_origin <> 'collected' then
    raise exception 'comparison_evidence_requires_collected_snapshot' using errcode = '22023';
  end if;
  if not coalesce(target->'houseManageNo' = to_jsonb(snapshot.house_manage_no)
    and target->'noticeNo' = to_jsonb(snapshot.notice_no) and target->'edition' = to_jsonb(snapshot.edition)
    and notice->'source' = to_jsonb(snapshot.notice_source)
    and notice->'address' = snapshot.result_snapshot#>'{catalog,notice,fields,HSSPLY_ADRES,value}'
    and snapshot.result_snapshot#>'{catalog,notice,evidence}' @>
      jsonb_build_array(jsonb_build_object('page',notice->'page','position',notice->'position')),false) then
    raise exception 'comparison_evidence_target_mismatch' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_path_query(p_evidence,
    'strict $.** ? (@.type() == "object" && exists(@.source)).source') as ref(value)
    where jsonb_typeof(ref.value) <> 'string' or not ((ref.value #>> '{}') = any(sources))) then
    raise exception 'comparison_evidence_source_not_declared' using errcode = '42501';
  end if;

  perform private.require_comparison_sources(private.comparison_sources(p_snapshot_id,sources));
  select * into existing from private.comparison_evidence e where e.snapshot_id = p_snapshot_id;
  if found then
    if (existing.evidence,existing.source_ids) is distinct from (p_evidence,sources) then
      raise exception 'comparison_evidence_conflict' using errcode = '23505';
    end if;
    return p_snapshot_id;
  end if;

  insert into private.comparison_evidence(snapshot_id,evidence,source_ids) values (p_snapshot_id,p_evidence,sources);
  return p_snapshot_id;
end;
$$;

create function public.read_comparison_work(p_run_id uuid,p_generation integer,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id,p_generation,p_lease_token);
  synthetic_selection constant jsonb := '{"kind":"synthetic","fixture":"ingestion-v0"}';
  saved record;
  ingestion jsonb;
  evidence jsonb;
  use_synthetic_fixture boolean := job.input = synthetic_selection;
  -- 수집 요청의 번호·회차가 일치해도 별도 카탈로그 UUID에 대한 대응 근거가 필요하다.
  binding_issue text := case
    when job.notice_id is not null then 'target_identity_unverified'
    when job.housing_type_id is not null then 'housing_type_identity_unverified'
  end;
begin
  if job.input->>'kind' = 'snapshot' then
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
  return jsonb_build_object('conditions',job.conditions_snapshot,'ingestion',ingestion,'evidence',evidence,
    'useSyntheticFixture',use_synthetic_fixture,'selectionBindingIssue',binding_issue);
end;
$$;

create function public.finish_analysis_comparison(
  p_run_id uuid,p_generation integer,p_lease_token uuid,p_input jsonb,p_result jsonb,p_comparison jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id,p_generation,p_lease_token);
  operation jsonb;
  captured_id uuid;
  snapshot_origin text;
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
    and jsonb_typeof(p_comparison->'holds') = 'array'
    and jsonb_typeof(p_comparison->'exclusions') = 'array'
    and jsonb_typeof(p_comparison->'rankingComplete') = 'boolean'
    and not private.comparison_contains_raw_payload(p_comparison),false) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;
  if jsonb_array_length(p_comparison->'comparables') > 5 then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  operation := public.finish_analysis_run(p_run_id,p_generation,p_lease_token,p_input,p_result);
  captured_id := (operation->>'snapshotId')::uuid;
  select s.data_origin into snapshot_origin from public.analysis_input_snapshots s
    where (s.id,s.analysis_id,s.user_id) = (captured_id,job.analysis_id,job.user_id);
  if p_comparison->>'dataOrigin' is distinct from snapshot_origin then
    raise exception 'comparison_snapshot_origin_mismatch' using errcode = '22023';
  end if;
  if snapshot_origin = 'collected' then
    sources := private.comparison_sources(captured_id,(select e.source_ids from private.comparison_evidence e
      where e.snapshot_id = captured_id and job.comparison_evidence_pinned));
    perform private.require_comparison_sources(sources);
  end if;
  insert into private.comparison_results(run_id,result,source_ids) values (job.id,p_comparison,sources);
  -- 비교 저장까지 마치기 전에 임대가 만료되면 실행과 캡처도 함께 롤백한다.
  if job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;
  return operation;
end;
$$;

create function private.read_analysis_comparison(p_analysis_id uuid,p_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  owner_id uuid := private.analysis_run_owner();
  saved record;
begin
  select r.snapshot_id,r.rules_version,c.result,c.source_ids into saved from private.analysis_runs r
    left join private.comparison_results c on c.run_id = r.id and r.status = 'finished'
    where (r.id,r.analysis_id,r.user_id) = (p_run_id,p_analysis_id,owner_id);
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;
  if saved.result is null then
    raise exception 'analysis_comparison_not_ready' using errcode = 'PT409';
  end if;
  if not private.comparison_sources_permitted(saved.source_ids) then
    raise exception 'comparison_source_restricted' using errcode = 'PT403';
  end if;
  return jsonb_build_object('runId',p_run_id,'analysisId',p_analysis_id,'snapshotId',saved.snapshot_id,
    'rulesVersion',saved.rules_version,'result',saved.result);
end;
$$;

create function public.get_analysis_comparison(p_analysis_id uuid,p_run_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.read_analysis_comparison(p_analysis_id,p_run_id);
$$;

revoke all on function private.pin_comparison_evidence(), private.read_analysis_comparison(uuid,uuid),
  private.comparison_sources(uuid,text[]), private.comparison_sources_permitted(text[]),
  private.require_comparison_sources(text[]), private.comparison_contains_raw_payload(jsonb),
  public.register_comparison_evidence(uuid,jsonb,text[]), public.read_comparison_work(uuid,integer,uuid),
  public.finish_analysis_comparison(uuid,integer,uuid,jsonb,jsonb,jsonb),
  public.get_analysis_comparison(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.register_comparison_evidence(uuid,jsonb,text[]), public.read_comparison_work(uuid,integer,uuid),
  public.finish_analysis_comparison(uuid,integer,uuid,jsonb,jsonb,jsonb) to service_role;
grant execute on function private.read_analysis_comparison(uuid,uuid), public.get_analysis_comparison(uuid,uuid) to authenticated;
