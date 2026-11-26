-- S-01 채팅 홈·채팅 화면·S-02 공고 찾기용 채팅 영속 RPC와 멱등 키를 추가한다.
-- 새 사용자 데이터 테이블을 만들지 않고 기존 chats·chat_messages·analyses를 사용해
-- 기존 삭제 범위(채팅·분석·메시지)와 계정 삭제 울타리를 그대로 유지한다.

alter table public.chats
  add column request_key uuid;

create unique index chats_owner_request_key_idx
  on public.chats(user_id, request_key)
  where request_key is not null;

alter table public.chat_messages
  add column request_key uuid,
  add column message_order bigint generated always as identity;

create unique index chat_messages_owner_request_role_idx
  on public.chat_messages(user_id, chat_id, role, request_key)
  where request_key is not null;

create index chat_messages_owner_chat_order_idx
  on public.chat_messages(user_id, chat_id, created_at, message_order, id);

create function private.chat_home_owner()
returns uuid language plpgsql stable set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
begin
  if owner_id is null
    or coalesce(auth.jwt()->>'is_anonymous', 'false') <> 'false'
    or not private.current_account_access_active() then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  return owner_id;
end;
$$;

create function private.normalize_chat_title(p_title text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  cleaned text;
begin
  if p_title is null then
    raise exception 'invalid_chat_title' using errcode = '22023';
  end if;
  cleaned := regexp_replace(
    p_title,
    '\A[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+\Z',
    '',
    'g'
  );
  if char_length(cleaned) < 1 or char_length(cleaned) > 200 or cleaned ~ '[[:cntrl:]]' then
    raise exception 'invalid_chat_title' using errcode = '22023';
  end if;
  return cleaned;
end;
$$;

create function private.normalize_chat_message(p_content text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  cleaned text;
begin
  if p_content is null or replace(p_content, chr(10), '') ~ '[[:cntrl:]]' then
    raise exception 'invalid_chat_message' using errcode = '22023';
  end if;
  cleaned := regexp_replace(
    p_content,
    '\A[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+\Z',
    '',
    'g'
  );
  if char_length(cleaned) < 1 or char_length(cleaned) > 800 then
    raise exception 'invalid_chat_message' using errcode = '22023';
  end if;
  return cleaned;
end;
$$;

create function private.chat_summary_json(
  p_owner_id uuid,
  p_chat_id uuid,
  p_title text,
  p_created_at timestamptz,
  p_updated_at timestamptz
)
returns jsonb language plpgsql stable set search_path = '' set timezone = 'UTC' as $$
declare
  msg_count integer := 0;
  last_msg_at timestamptz;
  last_msg_preview text;
  analysis_count integer := 0;
  last_analysis_at timestamptz;
  latest_analysis jsonb := null;
  last_activity timestamptz;
begin
  select count(*)::integer, max(m.created_at)
    into msg_count, last_msg_at
    from public.chat_messages m
    where (m.chat_id, m.user_id) = (p_chat_id, p_owner_id);

  select left(m.content, 120)
    into last_msg_preview
    from public.chat_messages m
    where (m.chat_id, m.user_id) = (p_chat_id, p_owner_id)
    order by m.created_at desc, m.message_order desc, m.id desc
    limit 1;

  select count(*)::integer, max(a.updated_at)
    into analysis_count, last_analysis_at
    from public.analyses a
    where (a.chat_id, a.user_id) = (p_chat_id, p_owner_id);

  select jsonb_build_object(
      'analysisId', a.id,
      'title', a.title,
      'status', a.status,
      'latestRunId', a.latest_run_id,
      'latestRunStatus', r.status,
      'latestRunErrorCode', r.error_code,
      'noticeNo', a.conditions_snapshot#>>'{ingestion_target,noticeNo}',
      'houseManageNo', a.conditions_snapshot#>>'{ingestion_target,houseManageNo}',
      'edition', a.conditions_snapshot#>>'{ingestion_target,edition}',
      'modelNo', a.conditions_snapshot#>>'{comparison,modelNo}',
      'houseType', r.notice_house_type,
      'updatedAt', a.updated_at
    )
    into latest_analysis
    from public.analyses a
    left join private.analysis_runs r
      on (r.id, r.analysis_id, r.user_id) = (a.latest_run_id, a.id, a.user_id)
    where (a.chat_id, a.user_id) = (p_chat_id, p_owner_id)
    order by a.updated_at desc, a.created_at desc, a.id desc
    limit 1;

  last_activity := greatest(
    p_updated_at,
    coalesce(last_msg_at, p_updated_at),
    coalesce(last_analysis_at, p_updated_at)
  );

  return jsonb_build_object(
    'chatId', p_chat_id,
    'title', p_title,
    'createdAt', p_created_at,
    'updatedAt', p_updated_at,
    'lastActivityAt', last_activity,
    'messageCount', msg_count,
    'analysisCount', analysis_count,
    'lastMessagePreview', last_msg_preview,
    'latestAnalysis', latest_analysis
  );
end;
$$;

create function private.list_chats(p_before uuid default null, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' set timezone = 'UTC' as $$
declare
  owner_id uuid := private.chat_home_owner();
  resolved_limit integer := coalesce(p_limit, 20);
  cursor_activity timestamptz;
  items jsonb;
  next_cursor uuid := null;
  total_fetched integer := 0;
begin
  if resolved_limit < 1 or resolved_limit > 50 then
    raise exception 'invalid_chat_limit' using errcode = '22023';
  end if;

  if p_before is not null then
    select greatest(
        c.updated_at,
        coalesce((select max(m.created_at) from public.chat_messages m where (m.chat_id, m.user_id) = (c.id, c.user_id)), c.updated_at),
        coalesce((select max(a.updated_at) from public.analyses a where (a.chat_id, a.user_id) = (c.id, c.user_id)), c.updated_at)
      )
      into cursor_activity
      from public.chats c
      where (c.id, c.user_id) = (p_before, owner_id);
    if not found then
      raise exception 'chat_not_found' using errcode = 'PT404';
    end if;
  end if;

  with ranked as (
    select
      c.id,
      c.title,
      c.created_at,
      c.updated_at,
      greatest(
        c.updated_at,
        coalesce((select max(m.created_at) from public.chat_messages m where (m.chat_id, m.user_id) = (c.id, c.user_id)), c.updated_at),
        coalesce((select max(a.updated_at) from public.analyses a where (a.chat_id, a.user_id) = (c.id, c.user_id)), c.updated_at)
      ) as last_activity_at
    from public.chats c
    where c.user_id = owner_id
  ),
  fetched as (
    select
      r.id,
      r.title,
      r.created_at,
      r.updated_at,
      r.last_activity_at,
      row_number() over (order by r.last_activity_at desc, r.id desc) as rn
    from ranked r
    where p_before is null or (r.last_activity_at, r.id) < (cursor_activity, p_before)
    order by r.last_activity_at desc, r.id desc
    limit resolved_limit + 1
  )
  select
    count(*)::integer,
    coalesce(
      jsonb_agg(
        private.chat_summary_json(owner_id, f.id, f.title, f.created_at, f.updated_at)
        order by f.rn
      ) filter (where f.rn <= resolved_limit),
      '[]'::jsonb
    ),
    (select f2.id from fetched f2 where f2.rn = resolved_limit)
    into total_fetched, items, next_cursor
    from fetched f;

  if total_fetched <= resolved_limit then
    next_cursor := null;
  end if;

  return jsonb_build_object(
    'contractVersion', 'chat-home/v1',
    'chats', items,
    'nextCursor', next_cursor
  );
end;
$$;

create function private.create_chat(p_request_key uuid, p_title text default null)
returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  owner_id uuid := private.chat_home_owner();
  resolved_title text;
  existing public.chats%rowtype;
  created public.chats%rowtype;
begin
  if p_request_key is null then
    raise exception 'chat_request_key_required' using errcode = '22023';
  end if;
  resolved_title := case when p_title is null then '새 채팅' else private.normalize_chat_title(p_title) end;

  perform pg_advisory_xact_lock(hashtextextended('homecierge:chats:' || owner_id::text, 0));

  select * into existing
    from public.chats c
    where (c.user_id, c.request_key) = (owner_id, p_request_key);
  if found then
    if existing.title is distinct from resolved_title then
      raise exception 'chat_request_conflict' using errcode = 'PT409';
    end if;
    return jsonb_build_object(
      'contractVersion', 'chat-home/v1',
      'chat', private.chat_summary_json(owner_id, existing.id, existing.title, existing.created_at, existing.updated_at)
    );
  end if;

  insert into public.chats(user_id, title, request_key)
    values (owner_id, resolved_title, p_request_key)
    returning * into created;

  return jsonb_build_object(
    'contractVersion', 'chat-home/v1',
    'chat', private.chat_summary_json(owner_id, created.id, created.title, created.created_at, created.updated_at)
  );
end;
$$;

create function private.read_chat_detail(p_chat_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' set timezone = 'UTC' as $$
declare
  owner_id uuid := private.chat_home_owner();
  chat_row public.chats%rowtype;
  messages_json jsonb;
  analyses_json jsonb;
begin
  if p_chat_id is null then
    raise exception 'chat_id_required' using errcode = '22023';
  end if;

  select * into chat_row
    from public.chats c
    where (c.id, c.user_id) = (p_chat_id, owner_id);
  if not found then
    raise exception 'chat_not_found' using errcode = 'PT404';
  end if;

  select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', m.id,
          'role', m.role,
          'content', m.content,
          'createdAt', m.created_at
        )
        order by m.created_at asc, m.message_order asc, m.id asc
      ),
      '[]'::jsonb
    )
    into messages_json
    from public.chat_messages m
    where (m.chat_id, m.user_id) = (p_chat_id, owner_id);

  select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'analysisId', a.id,
          'title', a.title,
          'status', a.status,
          'latestRunId', a.latest_run_id,
          'latestRunStatus', r.status,
          'latestRunErrorCode', r.error_code,
          'noticeNo', a.conditions_snapshot#>>'{ingestion_target,noticeNo}',
          'houseManageNo', a.conditions_snapshot#>>'{ingestion_target,houseManageNo}',
          'edition', a.conditions_snapshot#>>'{ingestion_target,edition}',
          'modelNo', a.conditions_snapshot#>>'{comparison,modelNo}',
          'houseType', r.notice_house_type,
          'createdAt', a.created_at,
          'updatedAt', a.updated_at
        )
        order by a.created_at asc, a.id asc
      ),
      '[]'::jsonb
    )
    into analyses_json
    from public.analyses a
    left join private.analysis_runs r
      on (r.id, r.analysis_id, r.user_id) = (a.latest_run_id, a.id, a.user_id)
    where (a.chat_id, a.user_id) = (p_chat_id, owner_id);

  return jsonb_build_object(
    'contractVersion', 'chat-detail/v1',
    'chat', private.chat_summary_json(owner_id, chat_row.id, chat_row.title, chat_row.created_at, chat_row.updated_at),
    'messages', messages_json,
    'analyses', analyses_json
  );
end;
$$;

create function private.rename_chat(p_chat_id uuid, p_title text)
returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  owner_id uuid := private.chat_home_owner();
  resolved_title text;
  updated public.chats%rowtype;
begin
  if p_chat_id is null then
    raise exception 'chat_id_required' using errcode = '22023';
  end if;
  resolved_title := private.normalize_chat_title(p_title);

  perform pg_advisory_xact_lock(hashtextextended('homecierge:chats:' || owner_id::text, 0));

  update public.chats c
    set title = resolved_title
    where (c.id, c.user_id) = (p_chat_id, owner_id)
    returning * into updated;
  if not found then
    raise exception 'chat_not_found' using errcode = 'PT404';
  end if;

  return jsonb_build_object(
    'contractVersion', 'chat-home/v1',
    'chat', private.chat_summary_json(owner_id, updated.id, updated.title, updated.created_at, updated.updated_at)
  );
end;
$$;

-- 사용자 메시지는 role='user'로 저장하고, 규칙 기반 정형 assistant 응답만 서버 함수 안에서 생성·기록한다.
create function private.post_chat_message(
  p_chat_id uuid,
  p_request_key uuid,
  p_message text,
  p_action text,
  p_query text default null,
  p_mode text default null
)
returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  owner_id uuid := private.chat_home_owner();
  clean_message text;
  clean_query text;
  compact_query text;
  chat_row public.chats%rowtype;
  existing_user public.chat_messages%rowtype;
  existing_assistant public.chat_messages%rowtype;
  user_row public.chat_messages%rowtype;
  assistant_row public.chat_messages%rowtype;
  assistant_text text;
  published jsonb;
  window_start text;
  window_end text;
  observed_kst text;
  match_count integer := 0;
  same_title_groups integer := 0;
  query_label text;
  coverage_complete boolean := false;
  scope_label text;
  user_ts timestamptz;
  assistant_ts timestamptz;
begin
  if p_chat_id is null or p_request_key is null then
    raise exception 'invalid_chat_message_input' using errcode = '22023';
  end if;
  clean_message := private.normalize_chat_message(p_message);

  if p_action is null or p_action not in ('lookup', 'help', 'pdf_guide') then
    raise exception 'invalid_chat_message_action' using errcode = '22023';
  end if;

  if p_action = 'lookup' then
    if p_mode is null or p_mode not in ('name', 'number') then
      raise exception 'invalid_chat_lookup_mode' using errcode = '22023';
    end if;
    clean_query := private.normalize_chat_title(p_query);
    if char_length(clean_query) > 120 then
      raise exception 'invalid_chat_lookup_query' using errcode = '22023';
    end if;
    if p_mode = 'number' and clean_query !~ '\A[0-9]{1,10}\Z' then
      raise exception 'invalid_chat_lookup_query' using errcode = '22023';
    end if;
  else
    if p_query is not null or p_mode is not null then
      raise exception 'invalid_chat_message_input' using errcode = '22023';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('homecierge:chats:' || owner_id::text, 0));

  select * into chat_row
    from public.chats c
    where (c.id, c.user_id) = (p_chat_id, owner_id)
    for update;
  if not found then
    raise exception 'chat_not_found' using errcode = 'PT404';
  end if;

  select * into existing_user
    from public.chat_messages m
    where (m.user_id, m.chat_id, m.role, m.request_key) = (owner_id, p_chat_id, 'user', p_request_key);
  if found then
    if existing_user.content is distinct from clean_message then
      raise exception 'chat_request_conflict' using errcode = 'PT409';
    end if;
    select * into existing_assistant
      from public.chat_messages m
      where (m.user_id, m.chat_id, m.role, m.request_key) = (owner_id, p_chat_id, 'assistant', p_request_key);
    return jsonb_build_object(
      'contractVersion', 'chat-message/v1',
      'chatId', p_chat_id,
      'action', p_action,
      'userMessage', jsonb_build_object(
        'id', existing_user.id,
        'role', existing_user.role,
        'content', existing_user.content,
        'createdAt', existing_user.created_at
      ),
      'assistantMessage', case when existing_assistant.id is not null then jsonb_build_object(
        'id', existing_assistant.id,
        'role', existing_assistant.role,
        'content', existing_assistant.content,
        'createdAt', existing_assistant.created_at
      ) else null end
    );
  end if;

  if exists (
    select 1 from public.chat_messages m
    where (m.user_id, m.chat_id, m.request_key) = (owner_id, p_chat_id, p_request_key)
  ) then
    raise exception 'chat_request_conflict' using errcode = 'PT409';
  end if;

  if p_action = 'help' then
    assistant_text := '공고명이나 10자리 공고번호를 입력하시면 게시된 청약홈 공유 색인에서 회차를 구별해 찾아 드립니다. 접수 중인 공고는 오늘의 청약에서, 희망 지역·예산 조건 탐색은 맞춤 검색에서 이용하실 수 있습니다. 개인 청약 자격 판정이나 가격 전망은 제공하지 않습니다.';
  elsif p_action = 'pdf_guide' then
    assistant_text := '공고 PDF 보완은 공고와 주택형을 먼저 고른 뒤 분석 화면에서 진행할 수 있습니다. 먼저 공고명이나 10자리 공고번호를 입력해 검토할 회차를 찾아 주세요.';
  else
    published := private.notice_directory_index_value();
    if not private.comparison_sources_permitted(array['applyhome_apt', 'applyhome_remainder', 'mois_legal_region_codes']) then
      assistant_text := '현재 공고 목록 출처의 표시 권한을 확인 중이어서 공고 찾기를 보류했습니다. 출처 권한이 확인된 뒤 다시 시도해 주세요.';
    elsif published is null
      or not coalesce(private.notice_search_is_fresh(private.notice_search_epoch(published->>'observedAt')), false) then
      assistant_text := '최근 게시된 공고 색인을 준비 중이어서 공고 찾기를 실행할 수 없습니다. 잠시 후 다시 시도하거나 오늘의 청약에서 수집 상태를 확인해 주세요.';
    else
      window_start := replace(published#>>'{publicationWindow,start}', '-', '.');
      window_end := replace(published#>>'{publicationWindow,end}', '-', '.');
      observed_kst := to_char((published->>'observedAt')::timestamptz at time zone 'Asia/Seoul', 'YYYY.MM.DD HH24:MI') || ' KST';
      query_label := case when p_mode = 'number' then '공고번호 ' || clean_query else '‘' || clean_query || '’' end;
      -- 부분 수집·조회 불가 색인에서는 0건이나 건수를 확정값처럼 기록하지 않는다.
      coverage_complete := published#>>'{coverage,status}' = 'complete';
      scope_label := '모집공고일 ' || window_start || '–' || window_end || ', 관측 시각 ' || observed_kst;

      if p_mode = 'number' then
        with matched as (
          select n.value as item
          from jsonb_array_elements(published->'notices') as n(value)
          where n.value->>'kind' is distinct from 'unsupported'
            and (
              (char_length(clean_query) = 10 and (n.value->>'noticeNo' = clean_query or n.value->>'houseManageNo' = clean_query))
              or (char_length(clean_query) < 10 and (
                strpos(coalesce(n.value->>'noticeNo', ''), clean_query) > 0
                or strpos(coalesce(n.value->>'houseManageNo', ''), clean_query) > 0
              ))
            )
        )
        select
          count(*)::integer,
          (select count(*)::integer from (
            select item->>'title' as t from matched where item->>'title' is not null group by item->>'title' having count(*) > 1
          ) dup)
          into match_count, same_title_groups
          from matched;
      else
        compact_query := lower(regexp_replace(clean_query, '[[:space:]]+', '', 'g'));
        with matched as (
          select n.value as item
          from jsonb_array_elements(published->'notices') as n(value)
          where n.value->>'kind' is distinct from 'unsupported'
            and n.value->>'title' is not null
            and strpos(lower(regexp_replace(n.value->>'title', '[[:space:]]+', '', 'g')), compact_query) > 0
        )
        select
          count(*)::integer,
          (select count(*)::integer from (
            select item->>'title' as t from matched where item->>'title' is not null group by item->>'title' having count(*) > 1
          ) dup)
          into match_count, same_title_groups
          from matched;
      end if;

      if match_count = 0 and not coverage_complete then
        assistant_text := '공유 색인(' || scope_label || ')의 공고 수집이 완전하지 않아 ' || query_label
          || '에 해당하는 공고가 없다고 확정할 수 없습니다. 누락된 회차가 있을 수 있으니 오늘의 청약에서 수집 상태를 확인하거나 잠시 후 다시 찾아 주세요.';
      elsif match_count = 0 then
        assistant_text := '조회 범위(' || scope_label || ') 안에서 '
          || query_label || '에 해당하는 공고를 찾지 못했습니다. 이 기간 밖의 회차는 현재 조회 범위 밖입니다.';
      elsif same_title_groups > 0 then
        assistant_text := query_label || ' 검색 결과 총 ' || match_count
          || '건을 찾았습니다. 같은 이름의 다른 회차가 포함되어 있어 합치지 않았습니다. 공고일·공고번호·주택관리번호·유형·접수 상태를 확인해 회차를 고르세요. (조회 범위: '
          || scope_label || ')';
      else
        assistant_text := query_label || ' 검색 결과 ' || match_count
          || '건을 찾았습니다. 공고일·공고번호·유형을 확인해 검토할 회차를 고른 뒤 주택형을 선택하세요. (조회 범위: '
          || scope_label || ')';
      end if;
      if match_count > 0 and not coverage_complete then
        assistant_text := assistant_text || ' 공유 색인의 공고 수집이 완전하지 않아 누락된 회차가 있을 수 있습니다.';
      end if;
    end if;
  end if;

  user_ts := clock_timestamp();
  insert into public.chat_messages(user_id, chat_id, role, content, created_at, request_key)
    values (owner_id, p_chat_id, 'user', clean_message, user_ts, p_request_key)
    returning * into user_row;

  assistant_ts := greatest(clock_timestamp(), user_ts);
  insert into public.chat_messages(user_id, chat_id, role, content, created_at, request_key)
    values (owner_id, p_chat_id, 'assistant', assistant_text, assistant_ts, p_request_key)
    returning * into assistant_row;

  update public.chats c
    set updated_at = assistant_ts
    where (c.id, c.user_id) = (p_chat_id, owner_id);

  return jsonb_build_object(
    'contractVersion', 'chat-message/v1',
    'chatId', p_chat_id,
    'action', p_action,
    'userMessage', jsonb_build_object(
      'id', user_row.id,
      'role', user_row.role,
      'content', user_row.content,
      'createdAt', user_row.created_at
    ),
    'assistantMessage', jsonb_build_object(
      'id', assistant_row.id,
      'role', assistant_row.role,
      'content', assistant_row.content,
      'createdAt', assistant_row.created_at
    )
  );
end;
$$;

-- 선택한 공고·주택형의 분석을 현재 채팅에 연결해 한 트랜잭션으로 접수한다.
create function private.start_chat_notice_workspace(p_chat_id uuid, p_request_key uuid, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  owner_id uuid := private.chat_home_owner();
  workspace_id uuid;
  existing_chat_id uuid;
  label text;
  published jsonb;
  notice_title text;
  house_type text;
  run_result jsonb;
begin
  if p_chat_id is null or p_request_key is null
    or jsonb_typeof(p_input) is distinct from 'object'
    or p_input->>'kind' is distinct from 'notice'
    or (p_input->>'noticeNo') is null or (p_input->>'noticeNo') !~ '\A[0-9]{10}\Z'
    or (p_input->>'modelNo') is null or (p_input->>'modelNo') !~ '\A[0-9]{1,20}\Z' then
    raise exception 'invalid_analysis_run_input' using errcode = '22023';
  end if;

  -- delete_personal_data('chat') 및 start_notice_workspace와 동일한 잠금 순서를 유지한다.
  perform pg_advisory_xact_lock(hashtextextended('homecierge:analysis-runs:' || owner_id::text, 0));

  perform 1 from public.chats c
    where (c.id, c.user_id) = (p_chat_id, owner_id)
    for update;
  if not found then
    raise exception 'chat_not_found' using errcode = 'PT404';
  end if;

  select a.id, a.chat_id into workspace_id, existing_chat_id
    from public.analyses a
    where a.user_id = owner_id and a.directory_request_key = p_request_key;

  if workspace_id is not null and existing_chat_id <> p_chat_id then
    raise exception 'chat_request_conflict' using errcode = 'PT409';
  end if;

  if workspace_id is null then
    published := private.notice_directory_index_value();
    if published is not null and jsonb_typeof(published->'notices') = 'array' then
      select
        n.value->>'title',
        (select m.value->>'houseType'
           from jsonb_array_elements(coalesce(n.value->'models', '[]'::jsonb)) as m(value)
           where m.value->>'modelNo' = p_input->>'modelNo'
           limit 1)
        into notice_title, house_type
        from jsonb_array_elements(published->'notices') as n(value)
        where n.value->>'houseManageNo' = p_input->>'houseManageNo'
          and n.value->>'noticeNo' = p_input->>'noticeNo'
        limit 1;
    end if;
    label := left(
      coalesce(nullif(notice_title, ''), '공고 ' || (p_input->>'noticeNo'))
        || ' · ' || coalesce(nullif(house_type, ''), '주택형 ' || (p_input->>'modelNo')),
      200
    );
    insert into public.analyses(user_id, chat_id, title, directory_request_key)
      values (owner_id, p_chat_id, label, p_request_key)
      returning id into workspace_id;
  end if;

  run_result := public.enqueue_analysis_run(workspace_id, p_request_key, p_input);

  update public.chats c
    set updated_at = greatest(c.updated_at, clock_timestamp())
    where (c.id, c.user_id) = (p_chat_id, owner_id);

  return run_result || jsonb_build_object('chatId', p_chat_id);
end;
$$;

create function public.list_chats(p_before uuid default null, p_limit integer default 20)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.list_chats(p_before, p_limit);
$$;

create function public.create_chat(p_request_key uuid, p_title text default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.create_chat(p_request_key, p_title);
$$;

create function public.read_chat_detail(p_chat_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.read_chat_detail(p_chat_id);
$$;

create function public.rename_chat(p_chat_id uuid, p_title text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.rename_chat(p_chat_id, p_title);
$$;

create function public.post_chat_message(
  p_chat_id uuid,
  p_request_key uuid,
  p_message text,
  p_action text,
  p_query text default null,
  p_mode text default null
)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.post_chat_message(p_chat_id, p_request_key, p_message, p_action, p_query, p_mode);
$$;

create function public.start_chat_notice_workspace(p_chat_id uuid, p_request_key uuid, p_input jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.start_chat_notice_workspace(p_chat_id, p_request_key, p_input);
$$;

revoke all on function
  private.chat_home_owner(),
  private.normalize_chat_title(text),
  private.normalize_chat_message(text),
  private.chat_summary_json(uuid, uuid, text, timestamptz, timestamptz),
  private.list_chats(uuid, integer),
  private.create_chat(uuid, text),
  private.read_chat_detail(uuid),
  private.rename_chat(uuid, text),
  private.post_chat_message(uuid, uuid, text, text, text, text),
  private.start_chat_notice_workspace(uuid, uuid, jsonb),
  public.list_chats(uuid, integer),
  public.create_chat(uuid, text),
  public.read_chat_detail(uuid),
  public.rename_chat(uuid, text),
  public.post_chat_message(uuid, uuid, text, text, text, text),
  public.start_chat_notice_workspace(uuid, uuid, jsonb)
from public, anon, authenticated, service_role;

grant execute on function
  private.list_chats(uuid, integer),
  private.create_chat(uuid, text),
  private.read_chat_detail(uuid),
  private.rename_chat(uuid, text),
  private.post_chat_message(uuid, uuid, text, text, text, text),
  private.start_chat_notice_workspace(uuid, uuid, jsonb),
  public.list_chats(uuid, integer),
  public.create_chat(uuid, text),
  public.read_chat_detail(uuid),
  public.rename_chat(uuid, text),
  public.post_chat_message(uuid, uuid, text, text, text, text),
  public.start_chat_notice_workspace(uuid, uuid, jsonb)
to authenticated;
