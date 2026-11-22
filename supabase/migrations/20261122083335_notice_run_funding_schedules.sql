-- 공고 실행에서 같은 판본을 읽어 만든 비교 결과와 납부 일정을 함께 커밋한다.
create function private.finish_notice_with_funding(
  p_run_id uuid, p_generation integer, p_lease_token uuid, p_input jsonb, p_result jsonb,
  p_comparison jsonb, p_schedules jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id,p_generation,p_lease_token);
  operation jsonb;
  snapshot public.analysis_input_snapshots%rowtype;
begin
  if job.input->>'kind' is distinct from 'notice' then
    raise exception 'notice_run_required' using errcode = '22023';
  end if;
  operation := public.finish_analysis_comparison(p_run_id,p_generation,p_lease_token,p_input,p_result,p_comparison);
  select * into strict snapshot from public.analysis_input_snapshots s
    where (s.id,s.capture_key,s.analysis_id,s.user_id) =
      ((operation->>'snapshotId')::uuid,job.id,job.analysis_id,job.user_id);
  if p_schedules <> '[]'::jsonb then
    perform private.require_comparison_sources(private.funding_schedule_sources(snapshot.notice_source));
  end if;
  perform private.check_funding_schedules(snapshot,p_schedules);
  insert into private.analysis_funding_schedule_snapshots(snapshot_id,schedules) values (snapshot.id,p_schedules);
  if job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;
  return operation;
end;
$$;

create function public.finish_notice_with_funding(
  p_run_id uuid, p_generation integer, p_lease_token uuid, p_input jsonb, p_result jsonb,
  p_comparison jsonb, p_schedules jsonb
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.finish_notice_with_funding(p_run_id,p_generation,p_lease_token,p_input,p_result,p_comparison,p_schedules);
$$;
revoke all on function private.finish_notice_with_funding(uuid,integer,uuid,jsonb,jsonb,jsonb,jsonb),
  public.finish_notice_with_funding(uuid,integer,uuid,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.finish_notice_with_funding(uuid,integer,uuid,jsonb,jsonb,jsonb,jsonb),
  public.finish_notice_with_funding(uuid,integer,uuid,jsonb,jsonb,jsonb,jsonb) to service_role;
notify pgrst, 'reload schema';
