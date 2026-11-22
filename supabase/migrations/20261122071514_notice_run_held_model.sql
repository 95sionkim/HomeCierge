-- 기간 판정이 보류된 비교는 모델번호와 주택형을 모두 비워, 다른 주택형이 표시되는 것을 막는다.
create or replace function private.check_notice_run_comparison()
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
      and new.result#>'{target,houseType}' = 'null'::jsonb
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
