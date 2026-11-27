-- 공고 PDF 서식 확장(가격 단위 unit 메타데이터) 및 공식 첨부 다중 해시 이력(A-59) 지원.
-- 기존 마이그레이션을 수정하지 않고 직전 정의를 유지한 채 필요한 검증·조회만 보강한다.

-- 가격 단위 메타데이터({kind, buildings, lines, floors: {from, to}, households}) 형식을 검증한다.
create function private.ingestion_v0_unit(unit jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(
    private.ingestion_v0_object(unit, array['kind','buildings','lines','floors','households'])
    and unit ?& array['kind','buildings','lines','floors','households']
    and unit->>'kind' in ('room','band')
    and jsonb_typeof(unit->'buildings') = 'array'
    and jsonb_array_length(unit->'buildings') <= 100
    and not exists (
      select 1 from jsonb_array_elements(unit->'buildings') as b(value)
      where jsonb_typeof(b.value) <> 'string'
        or b.value#>>'{}' = ''
        or b.value#>>'{}' <> btrim(b.value#>>'{}')
        or char_length(b.value#>>'{}') > 32
        or b.value#>>'{}' ~ '[\u0000-\u001F\u007F]'
    )
    and jsonb_typeof(unit->'lines') = 'array'
    and jsonb_array_length(unit->'lines') <= 100
    and not exists (
      select 1 from jsonb_array_elements(unit->'lines') as l(value)
      where jsonb_typeof(l.value) <> 'string'
        or l.value#>>'{}' = ''
        or l.value#>>'{}' <> btrim(l.value#>>'{}')
        or char_length(l.value#>>'{}') > 32
        or l.value#>>'{}' ~ '[\u0000-\u001F\u007F]'
    )
    and private.ingestion_v0_object(unit->'floors', array['from','to'])
    and (unit->'floors') ?& array['from','to']
    and (unit#>'{floors,from}' = 'null'::jsonb or private.ingestion_v0_count(unit#>'{floors,from}', 1, 300))
    and (unit#>'{floors,to}' = 'null'::jsonb or private.ingestion_v0_count(unit#>'{floors,to}', 1, 300))
    and (
      unit#>'{floors,from}' = 'null'::jsonb
      or unit#>'{floors,to}' = 'null'::jsonb
      or (unit#>>'{floors,from}')::integer <= (unit#>>'{floors,to}')::integer
    )
    and private.ingestion_v0_count(unit->'households', 1, 100000)
    and (unit->>'kind' <> 'room' or (unit->>'households')::integer = 1),
    false
  );
$$;

-- 수집 결과에 포함된 문서 버전과 값 근거를 대조한다. rooms[]의 선택적 unit 메타데이터를 허용·검증한다.
create or replace function private.check_ingestion_v0_catalog(catalog jsonb, target jsonb, notice_source text)
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
        'salePrice','requiredOptions','subtotal','unit'])
      and room ?& array['modelNo','houseType','room','status','salePrice','requiredOptions','subtotal']
      and (not (room ? 'unit') or private.ingestion_v0_unit(room->'unit'))
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

-- 같은 공고·회차에서 관측된 공식 첨부 해시 이력 전체를 보존·조회한다(A-59).
-- 같은 첨부 ID에 서로 다른 해시가 관측되어도 이전 판본을 누락하지 않고 모두 돌려준다.
create function private.official_notice_revisions(
  p_house_manage_no text,
  p_notice_no text,
  p_edition text
) returns jsonb language sql stable security definer set search_path = '' as $$
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
      order by idx.document_id collate "C", idx.sha256 collate "C"
    ),
    '[]'::jsonb
  )
  from private.official_notice_document_index idx
  where (idx.house_manage_no, idx.notice_no, idx.edition) = (p_house_manage_no, p_notice_no, p_edition);
$$;

-- 작업자에게 승인된 기간·조건 변경과 같은 회차의 이전 공식 첨부 해시 이력(존재할 때만)을 전달한다.
create or replace function public.read_comparison_work(p_run_id uuid, p_generation integer, p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id, p_generation, p_lease_token);
  synthetic_selection constant jsonb := '{"kind":"synthetic","fixture":"ingestion-v0"}';
  saved record;
  ingestion jsonb;
  evidence jsonb;
  notice_capture jsonb;
  official_revisions jsonb := '[]'::jsonb;
  approved_turn private.analysis_chat_turns%rowtype;
  comparison_period jsonb;
  comparison_conditions jsonb;
  eff_start date;
  eff_end date;
  snapshot_kinds jsonb;
  eff_kinds jsonb;
  payload jsonb;
  use_synthetic_fixture boolean := job.input = synthetic_selection;
  binding_issue text := case
    when job.notice_id is not null then 'target_identity_unverified'
    when job.housing_type_id is not null then 'housing_type_identity_unverified'
  end;
begin
  select * into approved_turn from private.analysis_chat_turns t
    where (t.result_run_id, t.analysis_id, t.user_id) = (job.id, job.analysis_id, job.user_id)
      and t.proposal_status = 'approved';

  if approved_turn.id is not null and job.input->>'kind' is distinct from 'snapshot' then
    raise exception 'invalid_analysis_chat_period' using errcode = '22023';
  end if;

  if job.input->>'kind' = 'notice' then
    perform private.require_unchanged_run_inputs(job);
    perform private.require_notice_run_sources(private.notice_run_capture_sources(job.input->>'noticeSource'));
    notice_capture := jsonb_build_object('asOf', job.notice_request->'asOf',
      'requestRegionCodes', job.notice_request->'requestRegionCodes',
      'allowOfficialPdf', private.comparison_sources_permitted(array['applyhome_notice_pdf']));
    official_revisions := private.official_notice_revisions(
      job.input->>'houseManageNo', job.input->>'noticeNo', job.input->>'edition'
    );
  elsif job.input->>'kind' = 'snapshot' then
    select s.id, s.data_origin, s.result_snapshot, s.period_start, s.period_end, e.evidence, e.source_ids,
      s.data_origin = 'synthetic' and exists (
        select 1 from private.analysis_runs original
        join private.comparison_results c on c.run_id = original.id
        where (original.id, original.snapshot_id, original.analysis_id, original.user_id) =
          (s.capture_key, s.id, s.analysis_id, s.user_id)
          and original.status = 'finished' and original.input = synthetic_selection
      ) as demo_capture into saved
      from public.analysis_input_snapshots s
      left join private.comparison_evidence e on job.comparison_evidence_pinned and e.snapshot_id = s.id
      where (s.id, s.analysis_id, s.user_id) = ((job.input->>'snapshotId')::uuid, job.analysis_id, job.user_id)
      for key share of s;
    if not found then
      raise exception 'analysis_run_snapshot_missing' using errcode = '22023';
    end if;
    if saved.data_origin = 'collected' then
      perform private.require_comparison_sources(private.comparison_sources(saved.id, saved.source_ids));
    end if;
    if approved_turn.id is not null then
      if saved.period_start is null or saved.period_end is null
        or saved.result_snapshot#>>'{period,status}' is distinct from 'confirmed' then
        raise exception 'invalid_analysis_chat_period' using errcode = '22023';
      end if;
      if approved_turn.intent = 'change_period' then
        if approved_turn.proposed_start < saved.period_start
          or approved_turn.proposed_end > saved.period_end
          or approved_turn.proposed_start > approved_turn.proposed_end then
          raise exception 'invalid_analysis_chat_period' using errcode = '22023';
        end if;
        comparison_period := jsonb_build_object(
          'start', to_char(approved_turn.proposed_start, 'YYYY-MM-DD'),
          'end', to_char(approved_turn.proposed_end, 'YYYY-MM-DD')
        );
        if approved_turn.effective_conditions is not null then
          comparison_conditions := approved_turn.effective_conditions;
        end if;
      elsif approved_turn.intent = 'change_conditions' then
        if approved_turn.effective_conditions is null
          or jsonb_typeof(approved_turn.effective_conditions) <> 'object'
          or approved_turn.effective_conditions = '{}'::jsonb then
          raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
        end if;
        if approved_turn.effective_conditions ? 'period' then
          eff_start := private.law_reference_iso_date(approved_turn.effective_conditions#>>'{period,start}');
          eff_end := private.law_reference_iso_date(approved_turn.effective_conditions#>>'{period,end}');
          if eff_start is null or eff_end is null or eff_start > eff_end
            or eff_start < saved.period_start or eff_end > saved.period_end then
            raise exception 'invalid_analysis_chat_period' using errcode = '22023';
          end if;
          comparison_period := jsonb_build_object(
            'start', to_char(eff_start, 'YYYY-MM-DD'),
            'end', to_char(eff_end, 'YYYY-MM-DD')
          );
        end if;
        if approved_turn.effective_conditions ? 'areaTolerancePercent'
          and private.normalize_area_tolerance(approved_turn.effective_conditions->'areaTolerancePercent') is null then
          raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
        end if;
        if approved_turn.effective_conditions ? 'tradeKinds' then
          snapshot_kinds := private.normalize_trade_kinds(saved.result_snapshot->'tradeKinds');
          eff_kinds := private.normalize_trade_kinds(approved_turn.effective_conditions->'tradeKinds');
          if snapshot_kinds is null or eff_kinds is null
            or exists (
              select 1 from jsonb_array_elements_text(eff_kinds) as req(kind)
              where not (snapshot_kinds ? req.kind)
            ) then
            raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
          end if;
        end if;
        if approved_turn.effective_conditions ? 'replacements'
          and private.normalize_replacements(approved_turn.effective_conditions->'replacements') is null then
          raise exception 'invalid_analysis_chat_condition' using errcode = '22023';
        end if;
        comparison_conditions := approved_turn.effective_conditions;
      end if;
    end if;
    ingestion := saved.result_snapshot;
    evidence := saved.evidence;
    use_synthetic_fixture := saved.demo_capture;
  end if;

  if job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;
  if notice_capture is not null then
    payload := jsonb_build_object('conditions', job.conditions_snapshot, 'ingestion', null, 'evidence', null,
      'useSyntheticFixture', false, 'selectionBindingIssue', null, 'noticeCapture', notice_capture);
    if official_revisions <> '[]'::jsonb then
      payload := payload || jsonb_build_object('officialRevisions', official_revisions);
    end if;
    return payload;
  end if;
  payload := jsonb_build_object('conditions', job.conditions_snapshot, 'ingestion', ingestion, 'evidence', evidence,
    'useSyntheticFixture', use_synthetic_fixture, 'selectionBindingIssue', binding_issue);
  if comparison_period is not null then
    payload := payload || jsonb_build_object('comparisonPeriod', comparison_period);
  end if;
  if comparison_conditions is not null then
    payload := payload || jsonb_build_object('comparisonConditions', comparison_conditions);
  end if;
  return payload;
end;
$$;

-- 작업자 전용: 업로드 보완 입력과 함께 같은 회차의 전체 공식 해시 이력(officialRevisions)을 전달한다.
create or replace function public.read_upload_supplement_work(
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
  official_revisions jsonb := '[]'::jsonb;
  notice_capture jsonb;
  payload jsonb;
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

  -- 같은 공고 번호쌍의 모호하지 않은 공식 첨부 해시는 업로드 대조(officialIndex)에, 같은 회차의 전체 이력은 A-59 비교에 쓴다.
  official_index := private.unambiguous_official_index(job.input->>'houseManageNo', job.input->>'noticeNo');
  official_revisions := private.official_notice_revisions(
    job.input->>'houseManageNo', job.input->>'noticeNo', job.input->>'edition'
  );

  notice_capture := jsonb_build_object(
    'asOf', job.notice_request->'asOf',
    'requestRegionCodes', job.notice_request->'requestRegionCodes',
    'allowOfficialPdf', private.comparison_sources_permitted(array['applyhome_notice_pdf'])
  );

  if job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;

  payload := jsonb_build_object(
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
  if official_revisions <> '[]'::jsonb then
    payload := payload || jsonb_build_object('officialRevisions', official_revisions);
  end if;
  return payload;
end;
$$;

revoke all on function
  private.ingestion_v0_unit(jsonb),
  private.check_ingestion_v0_catalog(jsonb, jsonb, text),
  private.official_notice_revisions(text, text, text),
  public.read_comparison_work(uuid, integer, uuid),
  public.read_upload_supplement_work(uuid, integer, uuid)
from public, anon, authenticated, service_role;

grant execute on function
  private.ingestion_v0_unit(jsonb),
  private.check_ingestion_v0_catalog(jsonb, jsonb, text),
  public.read_comparison_work(uuid, integer, uuid),
  public.read_upload_supplement_work(uuid, integer, uuid)
to service_role;

notify pgrst, 'reload schema';
