-- 비교 결과별 대화 이력과 분석 한정 기간 변경 승인 흐름을 저장한다.
-- 사용자 메시지와 의도·기간 제안 상태만 보관하며 외부 응답 원문이나 보조 답변 본문은 저장하지 않는다.
alter table private.analysis_runs
  add constraint analysis_runs_id_analysis_user_key unique (id, analysis_id, user_id);

create table private.analysis_chat_turns (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null,
  base_run_id uuid not null,
  user_id uuid not null,
  request_id uuid not null,
  turn_order bigint generated always as identity,
  message text not null,
  intent text not null check (intent in ('inclusion','holds','scope','price','period','change_period','help')),
  created_at timestamptz not null default clock_timestamp(),
  proposed_start date,
  proposed_end date,
  previous_start date,
  previous_end date,
  proposal_status text check (proposal_status is null or proposal_status in ('pending','approved','rejected','cancelled')),
  decided_at timestamptz,
  result_run_id uuid,
  foreign key (analysis_id, user_id) references public.analyses(id, user_id) on delete cascade,
  foreign key (base_run_id) references private.comparison_results(run_id) on delete cascade,
  foreign key (base_run_id, analysis_id, user_id) references private.analysis_runs(id, analysis_id, user_id) on delete cascade,
  foreign key (result_run_id, analysis_id, user_id) references private.analysis_runs(id, analysis_id, user_id) on delete cascade,
  unique (analysis_id, base_run_id, request_id),
  check (
    char_length(message) between 1 and 800
    and message !~ '[\u0001-\u0009\u000B-\u001F\u007F]'
    and message = btrim(
      message,
      U&' \000A\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
    )
  ),
  check (
    (
      intent = 'change_period'
      and proposed_start is not null and proposed_end is not null
      and previous_start is not null and previous_end is not null
      and proposal_status is not null
      and proposed_start <= proposed_end
      and previous_start <= previous_end
      and (proposed_start, proposed_end) is distinct from (previous_start, previous_end)
    ) or (
      intent <> 'change_period'
      and proposed_start is null and proposed_end is null
      and previous_start is null and previous_end is null
      and proposal_status is null and decided_at is null and result_run_id is null
    )
  ),
  check ((proposal_status = 'approved') = (result_run_id is not null)),
  check ((proposal_status in ('approved','rejected','cancelled')) = (decided_at is not null)),
  check (result_run_id is null or result_run_id <> base_run_id)
);

create index analysis_chat_turns_history_idx
  on private.analysis_chat_turns(analysis_id, base_run_id, turn_order desc);
create index analysis_chat_turns_owner_idx
  on private.analysis_chat_turns(user_id, analysis_id);
create unique index analysis_chat_turns_result_run_idx
  on private.analysis_chat_turns(result_run_id) where result_run_id is not null;

alter table private.analysis_chat_turns enable row level security;
revoke all on private.analysis_chat_turns from public, anon, authenticated, service_role;

-- 줄바꿈(LF) 외의 ASCII 제어 문자를 거부하고 앞뒤 공백·줄바꿈을 정리해 1~800 코드 포인트로 검증한다.
create function private.normalize_analysis_chat_message(p_message text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  trimmed text;
begin
  if p_message is null or p_message ~ '[\u0001-\u0009\u000B-\u001F\u007F]' then
    raise exception 'invalid_analysis_chat_turn' using errcode = '22023';
  end if;
  trimmed := btrim(
    p_message,
    U&' \000A\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
  );
  if char_length(trimmed) not between 1 and 800 then
    raise exception 'invalid_analysis_chat_turn' using errcode = '22023';
  end if;
  return trimmed;
end;
$$;

create function private.require_comparison_chat_sources(p_source_ids text[])
returns void language plpgsql set search_path = '' as $$
begin
  perform private.require_comparison_sources(p_source_ids);
exception when insufficient_privilege then
  raise exception 'comparison_source_restricted' using errcode = 'PT403';
end;
$$;

-- 동일 분석·소유자의 최근 30개 대화와, 승인된 기간 변경으로 이어진 직전 결과 실행 ID만 조합한다.
create function private.analysis_conversation_payload(p_owner_id uuid, p_analysis_id uuid, p_run_id uuid)
returns jsonb language sql stable set search_path = '' set timezone = 'UTC' as $$
  with recent as (
    select t.*
    from private.analysis_chat_turns t
    where (t.analysis_id, t.base_run_id, t.user_id) = (p_analysis_id, p_run_id, p_owner_id)
    order by t.turn_order desc
    limit 31
  ),
  windowed as (
    select r.*
    from recent r
    order by r.turn_order desc
    limit 30
  ),
  prev as (
    select t.base_run_id
    from private.analysis_chat_turns t
    join private.analysis_runs base_r
      on (base_r.id, base_r.analysis_id, base_r.user_id) = (t.base_run_id, t.analysis_id, t.user_id)
      and base_r.status = 'finished'
    join private.comparison_results base_c
      on base_c.run_id = base_r.id
    where (t.result_run_id, t.analysis_id, t.user_id) = (p_run_id, p_analysis_id, p_owner_id)
      and t.proposal_status = 'approved'
      and private.comparison_sources_permitted(base_c.source_ids)
  )
  select jsonb_build_object(
    'analysisId', p_analysis_id,
    'runId', p_run_id,
    'previousRunId', (select prev.base_run_id from prev),
    'turns', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', w.id,
            'runId', w.base_run_id,
            'message', w.message,
            'intent', w.intent,
            'createdAt', w.created_at,
            'proposal', case
              when w.intent = 'change_period' then jsonb_build_object(
                'start', to_char(w.proposed_start, 'YYYY-MM-DD'),
                'end', to_char(w.proposed_end, 'YYYY-MM-DD'),
                'previousStart', to_char(w.previous_start, 'YYYY-MM-DD'),
                'previousEnd', to_char(w.previous_end, 'YYYY-MM-DD'),
                'status', w.proposal_status,
                'resultRunId', w.result_run_id
              )
              else null
            end
          )
          order by w.turn_order asc
        )
        from windowed w
      ),
      '[]'::jsonb
    ),
    'hasEarlier', (select count(*) > 30 from recent)
  );
$$;

-- BE-02 trade_period(as_of, start, end)와 같은 사용자 확정 기간 객체를 생성한다.
create function private.expected_comparison_period(p_as_of date, p_start date, p_end date)
returns jsonb language sql immutable strict set search_path = '' as $$
  with months as (
    select jsonb_agg(to_char(boundary, 'YYYYMM') order by boundary) as list
    from generate_series(
      date_trunc('month', p_start::timestamp),
      date_trunc('month', p_end::timestamp),
      interval '1 month'
    ) as m(boundary)
  )
  select jsonb_build_object(
    'status', 'confirmed',
    'source', 'user_confirmed',
    'asOf', to_char(p_as_of, 'YYYY-MM-DD'),
    'start', to_char(p_start, 'YYYY-MM-DD'),
    'end', to_char(p_end, 'YYYY-MM-DD'),
    'bounds', 'inclusive',
    'months', months.list,
    'inProgressMonth', case
      when months.list ? to_char(p_as_of, 'YYYYMM') then to_jsonb(to_char(p_as_of, 'YYYYMM'))
      else 'null'::jsonb
    end,
    'decision', null
  )
  from months;
$$;

create function private.read_analysis_conversation(p_analysis_id uuid, p_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  saved record;
begin
  if owner_id is null or coalesce(auth.jwt()->'is_anonymous','false'::jsonb) <> 'false'::jsonb
    or not exists (select 1 from auth.users u where u.id = owner_id and u.confirmed_at is not null
      and u.is_anonymous is false and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= statement_timestamp())) then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if p_analysis_id is null or p_run_id is null then
    raise exception 'invalid_analysis_chat_turn' using errcode = '22023';
  end if;

  select r.id, c.result, c.source_ids into saved
    from private.analysis_runs r
    left join private.comparison_results c on c.run_id = r.id and r.status = 'finished'
    where (r.id, r.analysis_id, r.user_id) = (p_run_id, p_analysis_id, owner_id);
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;
  if saved.result is null then
    raise exception 'analysis_comparison_not_ready' using errcode = 'PT409';
  end if;
  if not private.comparison_sources_permitted(saved.source_ids) then
    raise exception 'comparison_source_restricted' using errcode = 'PT403';
  end if;

  return private.analysis_conversation_payload(owner_id, p_analysis_id, p_run_id);
end;
$$;

create function private.submit_analysis_chat_turn(
  p_analysis_id uuid,
  p_run_id uuid,
  p_request_id uuid,
  p_message text,
  p_intent text,
  p_start date default null,
  p_end date default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  trimmed_message text;
  analysis_row public.analyses%rowtype;
  base_run record;
  existing_turn private.analysis_chat_turns%rowtype;
  snapshot_row public.analysis_input_snapshots%rowtype;
  base_period jsonb;
  previous_start date;
  previous_end date;
begin
  perform private.require_notice_run_user(owner_id);
  if p_analysis_id is null or p_run_id is null or p_request_id is null
    or p_intent is null
    or p_intent not in ('inclusion','holds','scope','price','period','change_period','help') then
    raise exception 'invalid_analysis_chat_turn' using errcode = '22023';
  end if;
  trimmed_message := private.normalize_analysis_chat_message(p_message);

  if p_intent <> 'change_period' then
    if p_start is not null or p_end is not null then
      raise exception 'invalid_analysis_chat_period' using errcode = '22023';
    end if;
  else
    if p_start is null or p_end is null or p_start > p_end then
      raise exception 'invalid_analysis_chat_period' using errcode = '22023';
    end if;
  end if;

  -- 부모 분석을 잠가 같은 분석의 제출·결정·실행 접수를 직렬화한다.
  select * into analysis_row from public.analyses a
    where (a.id, a.user_id) = (p_analysis_id, owner_id) for no key update;
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;

  select r.*, c.result as comparison_result, c.source_ids as comparison_source_ids
    into base_run
    from private.analysis_runs r
    left join private.comparison_results c on c.run_id = r.id and r.status = 'finished'
    where (r.id, r.analysis_id, r.user_id) = (p_run_id, p_analysis_id, owner_id);
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;
  if base_run.comparison_result is null then
    raise exception 'analysis_comparison_not_ready' using errcode = 'PT409';
  end if;
  perform private.require_comparison_chat_sources(base_run.comparison_source_ids);

  -- 권한 확인 직후, 오래된 실행 검사보다 먼저 같은 요청 키의 멱등 재전송을 복원한다.
  select * into existing_turn from private.analysis_chat_turns t
    where (t.analysis_id, t.base_run_id, t.request_id) = (p_analysis_id, p_run_id, p_request_id);
  if found then
    if (existing_turn.message, existing_turn.intent, existing_turn.proposed_start, existing_turn.proposed_end)
       is distinct from (trimmed_message, p_intent, p_start, p_end) then
      raise exception 'analysis_chat_request_conflict' using errcode = 'PT409';
    end if;
    return private.analysis_conversation_payload(owner_id, p_analysis_id, p_run_id);
  end if;

  if p_intent = 'change_period' then
    if analysis_row.latest_run_id is distinct from base_run.id
      or (analysis_row.conditions_snapshot, analysis_row.rules_version, analysis_row.notice_id, analysis_row.housing_type_id)
         is distinct from (base_run.conditions_snapshot, base_run.rules_version, base_run.notice_id, base_run.housing_type_id) then
      raise exception 'analysis_chat_stale_run' using errcode = 'PT409';
    end if;

    select * into snapshot_row from public.analysis_input_snapshots s
      where (s.id, s.analysis_id, s.user_id) = (base_run.snapshot_id, p_analysis_id, owner_id)
      for key share;
    if not found
      or base_run.notice_id is not null or base_run.housing_type_id is not null
      or snapshot_row.notice_id is not null or snapshot_row.housing_type_id is not null
      or (snapshot_row.conditions_snapshot, snapshot_row.rules_version, snapshot_row.notice_id, snapshot_row.housing_type_id)
         is distinct from (base_run.conditions_snapshot, base_run.rules_version, base_run.notice_id, base_run.housing_type_id)
      or snapshot_row.period_start is null or snapshot_row.period_end is null
      or snapshot_row.result_snapshot#>>'{period,status}' is distinct from 'confirmed' then
      raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
    end if;

    base_period := base_run.comparison_result#>'{conditions,period}';
    if not coalesce(
      jsonb_typeof(base_period) = 'object'
      and base_period->>'status' = 'confirmed'
      and base_period->>'bounds' = 'inclusive'
      and base_period->>'asOf' = to_char(snapshot_row.as_of, 'YYYY-MM-DD')
      and jsonb_typeof(base_period->'start') = 'string'
      and jsonb_typeof(base_period->'end') = 'string',
      false
    ) then
      raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
    end if;
    previous_start := private.law_reference_iso_date(base_period->>'start');
    previous_end := private.law_reference_iso_date(base_period->>'end');
    if previous_start is null or previous_end is null
      or previous_start > previous_end
      or previous_start < snapshot_row.period_start
      or previous_end > snapshot_row.period_end then
      raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
    end if;

    -- 원래 수집 기간 안에서 이전 축소 이후 재확대는 허용하되, 현재와 동일한 범위와 수집 범위 밖은 거부한다.
    if p_start = previous_start and p_end = previous_end then
      raise exception 'invalid_analysis_chat_period' using errcode = '22023';
    end if;
    if p_start < snapshot_row.period_start or p_end > snapshot_row.period_end then
      raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
    end if;
  end if;

  insert into private.analysis_chat_turns(
    analysis_id, base_run_id, user_id, request_id, message, intent,
    proposed_start, proposed_end, previous_start, previous_end, proposal_status
  ) values (
    p_analysis_id, p_run_id, owner_id, p_request_id, trimmed_message, p_intent,
    case when p_intent = 'change_period' then p_start end,
    case when p_intent = 'change_period' then p_end end,
    case when p_intent = 'change_period' then previous_start end,
    case when p_intent = 'change_period' then previous_end end,
    case when p_intent = 'change_period' then 'pending' end
  );

  return private.analysis_conversation_payload(owner_id, p_analysis_id, p_run_id);
end;
$$;

create function private.decide_analysis_chat_turn(
  p_analysis_id uuid,
  p_run_id uuid,
  p_turn_id uuid,
  p_decision text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  target_status text;
  analysis_row public.analyses%rowtype;
  base_run record;
  turn_row private.analysis_chat_turns%rowtype;
  snapshot_row public.analysis_input_snapshots%rowtype;
  new_run_op jsonb;
  new_run_id uuid;
begin
  perform private.require_notice_run_user(owner_id);
  if p_analysis_id is null or p_run_id is null or p_turn_id is null
    or p_decision is null or p_decision not in ('approve','reject','cancel') then
    raise exception 'invalid_analysis_chat_decision' using errcode = '22023';
  end if;
  target_status := case p_decision
    when 'approve' then 'approved'
    when 'reject' then 'rejected'
    when 'cancel' then 'cancelled'
  end;

  -- 승인은 기존 실행 접수와 같은 계정 자문 잠금 → 부모 분석 잠금 순서를 따른다.
  if p_decision = 'approve' then
    perform pg_advisory_xact_lock(hashtextextended('homecierge:analysis-runs:' || owner_id::text, 0));
  end if;
  select * into analysis_row from public.analyses a
    where (a.id, a.user_id) = (p_analysis_id, owner_id) for no key update;
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;

  select r.*, c.result as comparison_result, c.source_ids as comparison_source_ids
    into base_run
    from private.analysis_runs r
    left join private.comparison_results c on c.run_id = r.id and r.status = 'finished'
    where (r.id, r.analysis_id, r.user_id) = (p_run_id, p_analysis_id, owner_id);
  if not found then
    raise exception 'analysis_run_not_found' using errcode = 'PT404';
  end if;
  if base_run.comparison_result is null then
    raise exception 'analysis_comparison_not_ready' using errcode = 'PT409';
  end if;
  perform private.require_comparison_chat_sources(base_run.comparison_source_ids);

  select * into turn_row from private.analysis_chat_turns t
    where (t.id, t.analysis_id, t.base_run_id, t.user_id) = (p_turn_id, p_analysis_id, p_run_id, owner_id)
    for update;
  if not found then
    raise exception 'analysis_chat_turn_not_found' using errcode = 'PT404';
  end if;
  if turn_row.intent <> 'change_period' then
    raise exception 'analysis_chat_decision_conflict' using errcode = 'PT409';
  end if;

  if turn_row.proposal_status = target_status then
    return private.analysis_conversation_payload(owner_id, p_analysis_id, p_run_id);
  end if;
  if turn_row.proposal_status <> 'pending' then
    raise exception 'analysis_chat_decision_conflict' using errcode = 'PT409';
  end if;

  if p_decision in ('reject', 'cancel') then
    update private.analysis_chat_turns
      set proposal_status = target_status, decided_at = clock_timestamp()
      where id = turn_row.id;
    return private.analysis_conversation_payload(owner_id, p_analysis_id, p_run_id);
  end if;

  -- 승인은 잠근 부모 분석의 최신 실행·조건·대상이 달라지지 않았을 때만 새 스냅샷 실행 하나를 만든다.
  if analysis_row.latest_run_id is distinct from base_run.id
    or (analysis_row.conditions_snapshot, analysis_row.rules_version, analysis_row.notice_id, analysis_row.housing_type_id)
       is distinct from (base_run.conditions_snapshot, base_run.rules_version, base_run.notice_id, base_run.housing_type_id) then
    raise exception 'analysis_chat_stale_run' using errcode = 'PT409';
  end if;

  select * into snapshot_row from public.analysis_input_snapshots s
    where (s.id, s.analysis_id, s.user_id) = (base_run.snapshot_id, p_analysis_id, owner_id)
    for key share;
  if not found
    or base_run.notice_id is not null or base_run.housing_type_id is not null
    or snapshot_row.notice_id is not null or snapshot_row.housing_type_id is not null
    or (snapshot_row.conditions_snapshot, snapshot_row.rules_version, snapshot_row.notice_id, snapshot_row.housing_type_id)
       is distinct from (base_run.conditions_snapshot, base_run.rules_version, base_run.notice_id, base_run.housing_type_id)
    or snapshot_row.period_start is null or snapshot_row.period_end is null
    or snapshot_row.result_snapshot#>>'{period,status}' is distinct from 'confirmed'
    or turn_row.proposed_start < snapshot_row.period_start
    or turn_row.proposed_end > snapshot_row.period_end then
    raise exception 'analysis_chat_period_unavailable' using errcode = 'PT409';
  end if;

  if snapshot_row.data_origin = 'collected' then
    perform private.require_comparison_chat_sources(private.comparison_sources(
      snapshot_row.id,
      (select e.source_ids from private.comparison_evidence e
        where e.snapshot_id = snapshot_row.id and base_run.comparison_evidence_pinned)
    ));
  end if;

  -- 기존 스냅샷 실행 접수 로직(계정 한도 PT429 포함)을 재사용하고 기준 실행의 근거 고정을 그대로 보존한다.
  new_run_op := private.enqueue_analysis_run(
    p_analysis_id,
    gen_random_uuid(),
    jsonb_build_object('kind', 'snapshot', 'snapshotId', base_run.snapshot_id)
  );
  new_run_id := (new_run_op->>'runId')::uuid;
  update private.analysis_runs
    set comparison_evidence_pinned = base_run.comparison_evidence_pinned
    where id = new_run_id
      and comparison_evidence_pinned is distinct from base_run.comparison_evidence_pinned;

  update private.analysis_chat_turns
    set proposal_status = 'approved',
        decided_at = clock_timestamp(),
        result_run_id = new_run_id
    where id = turn_row.id;

  return private.analysis_conversation_payload(owner_id, p_analysis_id, p_run_id);
end;
$$;

create function public.read_analysis_conversation(p_analysis_id uuid, p_run_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.read_analysis_conversation(p_analysis_id, p_run_id);
$$;

create function public.submit_analysis_chat_turn(
  p_analysis_id uuid,
  p_run_id uuid,
  p_request_id uuid,
  p_message text,
  p_intent text,
  p_start date default null,
  p_end date default null
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.submit_analysis_chat_turn(p_analysis_id, p_run_id, p_request_id, p_message, p_intent, p_start, p_end);
$$;

create function public.decide_analysis_chat_turn(
  p_analysis_id uuid,
  p_run_id uuid,
  p_turn_id uuid,
  p_decision text
) returns jsonb language sql security invoker set search_path = '' as $$
  select private.decide_analysis_chat_turn(p_analysis_id, p_run_id, p_turn_id, p_decision);
$$;

-- 승인된 기간 변경 실행을 완료할 때 기간(양 끝 포함)·기존 대상·근거·출처 고정을 검증한다.
create function private.check_approved_period_comparison(
  p_job private.analysis_runs,
  p_snapshot public.analysis_input_snapshots,
  p_turn private.analysis_chat_turns,
  p_comparison jsonb
) returns void language plpgsql set search_path = '' as $$
declare
  base_run record;
  expected_period jsonb;
  expected_months jsonb;
  demo_capture boolean;
  orig_notice_run private.analysis_runs%rowtype;
  expected_batch_count integer;
begin
  select r.*, c.result as comparison_result into base_run
    from private.analysis_runs r
    join private.comparison_results c on c.run_id = r.id and r.status = 'finished'
    where (r.id, r.analysis_id, r.user_id) = (p_turn.base_run_id, p_job.analysis_id, p_job.user_id);

  if not found
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
    or p_snapshot.result_snapshot#>>'{period,status}' is distinct from 'confirmed'
    or p_turn.proposed_start < p_snapshot.period_start
    or p_turn.proposed_end > p_snapshot.period_end
    or p_turn.proposed_start > p_turn.proposed_end then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  expected_period := private.expected_comparison_period(p_snapshot.as_of, p_turn.proposed_start, p_turn.proposed_end);
  expected_months := expected_period->'months';

  if not coalesce(
    p_comparison#>'{conditions,asOf}' = to_jsonb(to_char(p_snapshot.as_of, 'YYYY-MM-DD'))
    and p_comparison#>'{conditions,period}' = expected_period
    and p_comparison#>'{conditions,tradeKinds}' = p_snapshot.result_snapshot->'tradeKinds'
    and ((p_comparison->'conditions') - 'period') is not distinct from
        ((base_run.comparison_result->'conditions') - 'period')
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

  -- 승인된 기간의 계약월 밖 수집 기록을 포함한 미필터 결과를 거부한다.
  if exists (
    select 1 from jsonb_array_elements(p_comparison->'collections') as c(value)
    where not coalesce(
      jsonb_typeof(c.value) = 'object'
      and jsonb_typeof(c.value->'month') = 'string'
      and c.value->>'month' ~ '\A[0-9]{4}-(0[1-9]|1[0-2])\Z'
      and expected_months ? replace(c.value->>'month', '-', ''),
      false
    )
  ) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  -- 포함된 모든 주변 단지·자체 거래 관측은 양 끝을 포함한 승인 기간 안에 있어야 한다.
  if exists (
    select 1
    from (
      select value from jsonb_array_elements(p_comparison->'comparables')
      union all
      select value from jsonb_array_elements(p_comparison->'targetReferences')
    ) as item(entry)
    where jsonb_typeof(item.entry) <> 'object'
      or jsonb_typeof(item.entry->'tradeStats') <> 'object'
      or item.entry->'tradeStats' = '{}'::jsonb
      or exists (
        select 1 from jsonb_each(item.entry->'tradeStats') as ts(kind, stat)
        where jsonb_typeof(ts.stat) <> 'object'
          or jsonb_typeof(ts.stat->'observations') <> 'array'
          or jsonb_array_length(ts.stat->'observations') = 0
          or ts.stat->'count' is distinct from to_jsonb(jsonb_array_length(ts.stat->'observations'))
          or exists (
            select 1 from jsonb_array_elements(ts.stat->'observations') as o(obs)
            where jsonb_typeof(o.obs) <> 'object'
              or jsonb_typeof(o.obs->'contractDate') <> 'string'
              or private.law_reference_iso_date(o.obs->>'contractDate') is null
              or private.law_reference_iso_date(o.obs->>'contractDate') < p_turn.proposed_start
              or private.law_reference_iso_date(o.obs->>'contractDate') > p_turn.proposed_end
          )
      )
  ) then
    raise exception 'invalid_comparison_result' using errcode = '22023';
  end if;

  demo_capture := p_snapshot.data_origin = 'synthetic' and exists (
    select 1 from private.analysis_runs original
    join private.comparison_results c on c.run_id = original.id
    where (original.id, original.snapshot_id, original.analysis_id, original.user_id) =
      (p_snapshot.capture_key, p_snapshot.id, p_snapshot.analysis_id, p_snapshot.user_id)
      and original.status = 'finished'
      and original.input = '{"kind":"synthetic","fixture":"ingestion-v0"}'::jsonb
  );

  -- 검수된 비교 근거가 없는 실행에서 비교 후보나 완료 판정으로 권한을 상승시키는 쓰기를 차단한다.
  if not demo_capture and not p_job.comparison_evidence_pinned then
    if not coalesce(
      p_comparison->>'completeness' <> 'complete'
      and p_comparison->'appliedScope' = 'null'::jsonb
      and p_comparison->'rankingComplete' = 'false'::jsonb
      and p_comparison->'comparables' = '[]'::jsonb
      and p_comparison->'targetReferences' = '[]'::jsonb
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
        and r.input->>'kind' = 'notice';
    if found then
      select count(*)::integer into expected_batch_count
        from jsonb_array_elements(p_snapshot.result_snapshot->'tradeBatches') as b(batch)
        where expected_months ? replace(b.batch#>>'{record,month}', '-', '');

      if not coalesce(
        p_comparison#>'{target,modelNo}' = orig_notice_run.input->'modelNo'
        and jsonb_typeof(p_comparison#>'{target,houseType}') = 'string'
        and private.notice_run_house_type(p_comparison#>>'{target,houseType}') = orig_notice_run.notice_house_type
        and p_comparison#>'{conditions,tradeKinds}' = orig_notice_run.notice_request->'tradeKinds',
        false
      )
        or jsonb_array_length(p_comparison->'collections') <> expected_batch_count
        or exists (
          select 1 from jsonb_array_elements(p_snapshot.result_snapshot->'tradeBatches') as b(batch)
          cross join lateral (select b.batch->'record' as record) as capture
          where expected_months ? replace(capture.record->>'month', '-', '')
            and not exists (
              select 1 from jsonb_array_elements(p_comparison->'collections') as c(value)
              where (c.value->'source', c.value->'requestRegionCode', c.value->'month', c.value->'tradeKinds')
                = (capture.record->'source', capture.record->'requestRegionCode', capture.record->'month', capture.record->'tradeKinds')
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

create or replace function public.read_comparison_work(p_run_id uuid, p_generation integer, p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id, p_generation, p_lease_token);
  synthetic_selection constant jsonb := '{"kind":"synthetic","fixture":"ingestion-v0"}';
  saved record;
  ingestion jsonb;
  evidence jsonb;
  notice_capture jsonb;
  approved_turn private.analysis_chat_turns%rowtype;
  comparison_period jsonb;
  use_synthetic_fixture boolean := job.input = synthetic_selection;
  -- 수집 요청의 번호·회차가 일치해도 별도 카탈로그 UUID에 대한 대응 근거가 필요하다.
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
    -- 공고 실행은 완료 트랜잭션에서만 수집본을 만든다. 읽을 때는 고정한 요청과 현재 이용 조건만 전달한다.
    perform private.require_unchanged_run_inputs(job);
    perform private.require_notice_run_sources(private.notice_run_capture_sources(job.input->>'noticeSource'));
    notice_capture := jsonb_build_object('asOf', job.notice_request->'asOf',
      'requestRegionCodes', job.notice_request->'requestRegionCodes',
      'allowOfficialPdf', private.comparison_sources_permitted(array['applyhome_notice_pdf']));
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
        or saved.result_snapshot#>>'{period,status}' is distinct from 'confirmed'
        or approved_turn.proposed_start < saved.period_start
        or approved_turn.proposed_end > saved.period_end
        or approved_turn.proposed_start > approved_turn.proposed_end then
        raise exception 'invalid_analysis_chat_period' using errcode = '22023';
      end if;
      comparison_period := jsonb_build_object(
        'start', to_char(approved_turn.proposed_start, 'YYYY-MM-DD'),
        'end', to_char(approved_turn.proposed_end, 'YYYY-MM-DD')
      );
    end if;
    ingestion := saved.result_snapshot;
    evidence := saved.evidence;
    use_synthetic_fixture := saved.demo_capture;
  end if;

  if job.next_claim_at <= clock_timestamp() then
    raise exception 'analysis_run_stale_lease' using errcode = 'PT409';
  end if;
  if notice_capture is not null then
    return jsonb_build_object('conditions', job.conditions_snapshot, 'ingestion', null, 'evidence', null,
      'useSyntheticFixture', false, 'selectionBindingIssue', null, 'noticeCapture', notice_capture);
  end if;
  if comparison_period is not null then
    return jsonb_build_object('conditions', job.conditions_snapshot, 'ingestion', ingestion, 'evidence', evidence,
      'useSyntheticFixture', use_synthetic_fixture, 'selectionBindingIssue', binding_issue,
      'comparisonPeriod', comparison_period);
  end if;
  return jsonb_build_object('conditions', job.conditions_snapshot, 'ingestion', ingestion, 'evidence', evidence,
    'useSyntheticFixture', use_synthetic_fixture, 'selectionBindingIssue', binding_issue);
end;
$$;

-- 승인된 기간 변경 실행은 비교 결과 검증 없이 finish_analysis_run 단독으로 종료할 수 없다.
create function private.finish_analysis_run_core(
  p_run_id uuid,
  p_generation integer,
  p_lease_token uuid,
  p_input jsonb,
  p_result jsonb,
  p_allow_approved_chat_period boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id, p_generation, p_lease_token);
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
    if nullif(p_input, 'null'::jsonb) is not null or nullif(p_result, 'null'::jsonb) is not null then
      raise exception 'unexpected_analysis_run_payload' using errcode = '22023';
    end if;
    select s.id, s.capture_key into captured_id, captured_key from public.analysis_input_snapshots s
      where (s.id, s.analysis_id, s.user_id) = ((job.input->>'snapshotId')::uuid, job.analysis_id, job.user_id)
      for key share;
    if not found then
      raise exception 'analysis_run_snapshot_missing' using errcode = '22023';
    end if;
    if private.is_notice_run_capture(captured_key, job.analysis_id, job.user_id) then
      perform private.require_comparison_sources(private.comparison_sources(captured_id, null));
    end if;
  elsif job.input->>'kind' = 'notice' then
    -- 접수 때 고정한 공고·회차·지역·기준일과 다른 요청이나 합성 자료는 저장하지 않는다.
    if not private.notice_capture_input_matches(job.notice_request, p_input)
      or jsonb_typeof(p_result) is distinct from 'object' or p_result->>'dataOrigin' is distinct from 'collected'
      or not private.notice_capture_period_matches(job.basis_date, p_result->'period') then
      raise exception 'invalid_notice_capture_payload' using errcode = '22023';
    end if;
    perform private.require_unchanged_run_inputs(job);
    capture_sources := private.notice_run_capture_sources(job.input->>'noticeSource');
    if jsonb_path_exists(p_result, 'lax $.catalog.documents[*] ? (@.source == "official")') then
      capture_sources := array_append(capture_sources, 'applyhome_notice_pdf');
    end if;
    perform private.require_notice_run_sources(capture_sources);
    -- BE-03 저장 함수가 대상·조건·기간·지역과 저장 허가를 같은 규칙으로 검사한다.
    captured_id := public.save_ingestion_snapshot(job.user_id, job.analysis_id, job.id, p_input, p_result);
    if not exists (select 1 from public.analysis_input_snapshots s
      where (s.id, s.analysis_id, s.user_id) = (captured_id, job.analysis_id, job.user_id) and s.target_binding_status = 'matched'
        and s.conditions_snapshot->'ingestion_target' = (p_input->'target' || jsonb_build_object('noticeSource', p_input->'noticeSource'))) then
      raise exception 'ingestion_analysis_target_mismatch' using errcode = '22023';
    end if;
    perform private.require_notice_capture_selection(job, p_result->'catalog');
  else
    if p_input is distinct from private.synthetic_ingestion_run_request()
      or p_result->>'dataOrigin' is distinct from 'synthetic' then
      raise exception 'invalid_synthetic_run_payload' using errcode = '22023';
    end if;
    -- BE-03은 잠근 부모에서 조건과 대상을 읽는다. 접수 때와 달라지면 캡처하지 않는다.
    perform private.require_unchanged_run_inputs(job);
    captured_id := public.save_ingestion_snapshot(job.user_id, job.analysis_id, job.id, p_input, p_result);
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

create or replace function public.finish_analysis_run(
  p_run_id uuid, p_generation integer, p_lease_token uuid, p_input jsonb, p_result jsonb
) returns jsonb language sql security definer set search_path = '' as $$
  select private.finish_analysis_run_core(p_run_id, p_generation, p_lease_token, p_input, p_result, false);
$$;

create or replace function public.finish_analysis_comparison(
  p_run_id uuid, p_generation integer, p_lease_token uuid, p_input jsonb, p_result jsonb, p_comparison jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  job private.analysis_runs%rowtype := private.lock_leased_analysis_run(p_run_id, p_generation, p_lease_token);
  operation jsonb;
  captured_id uuid;
  snapshot public.analysis_input_snapshots%rowtype;
  approved_turn private.analysis_chat_turns%rowtype;
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
    perform private.check_approved_period_comparison(job, snapshot, approved_turn, p_comparison);
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

revoke all on function
  private.normalize_analysis_chat_message(text),
  private.require_comparison_chat_sources(text[]),
  private.analysis_conversation_payload(uuid,uuid,uuid),
  private.expected_comparison_period(date,date,date),
  private.check_approved_period_comparison(private.analysis_runs,public.analysis_input_snapshots,private.analysis_chat_turns,jsonb),
  private.finish_analysis_run_core(uuid,integer,uuid,jsonb,jsonb,boolean),
  private.read_analysis_conversation(uuid,uuid),
  private.submit_analysis_chat_turn(uuid,uuid,uuid,text,text,date,date),
  private.decide_analysis_chat_turn(uuid,uuid,uuid,text),
  public.read_analysis_conversation(uuid,uuid),
  public.submit_analysis_chat_turn(uuid,uuid,uuid,text,text,date,date),
  public.decide_analysis_chat_turn(uuid,uuid,uuid,text),
  public.read_comparison_work(uuid,integer,uuid),
  public.finish_analysis_run(uuid,integer,uuid,jsonb,jsonb),
  public.finish_analysis_comparison(uuid,integer,uuid,jsonb,jsonb,jsonb)
from public, anon, authenticated, service_role;

grant execute on function
  private.read_analysis_conversation(uuid,uuid),
  private.submit_analysis_chat_turn(uuid,uuid,uuid,text,text,date,date),
  private.decide_analysis_chat_turn(uuid,uuid,uuid,text),
  public.read_analysis_conversation(uuid,uuid),
  public.submit_analysis_chat_turn(uuid,uuid,uuid,text,text,date,date),
  public.decide_analysis_chat_turn(uuid,uuid,uuid,text)
to authenticated;

grant execute on function
  public.read_comparison_work(uuid,integer,uuid),
  public.finish_analysis_run(uuid,integer,uuid,jsonb,jsonb),
  public.finish_analysis_comparison(uuid,integer,uuid,jsonb,jsonb,jsonb)
to service_role;

notify pgrst, 'reload schema';
