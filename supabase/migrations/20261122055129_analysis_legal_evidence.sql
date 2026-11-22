-- 공고일마다 확인한 「주택공급에 관한 규칙」의 판본과 조문 표지만 저장한다.
create table private.law_references (
  as_of date primary key,
  reference_value jsonb not null
);
alter table private.law_references enable row level security;
revoke all on private.law_references from public, anon, authenticated, service_role;

create function private.law_reference_iso_date(value text)
returns date language sql immutable strict set search_path = '' as $$
  select case when value ~ '\A[0-9]{4}-[0-9]{2}-[0-9]{2}\Z' and pg_input_is_valid(value,'date')
    then value::date end;
$$;

create function private.publish_law_reference(p_reference jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  reference_date date := private.law_reference_iso_date(p_reference->>'asOf');
  promulgated_date date := private.law_reference_iso_date(p_reference->>'promulgatedOn');
  effective_date date := private.law_reference_iso_date(p_reference->>'effectiveOn');
  observed_epoch numeric := private.notice_search_epoch(p_reference->>'observedAt');
  articles jsonb := p_reference->'articles';
begin
  if not coalesce(private.ingestion_v0_object(p_reference,array['contractVersion','dataOrigin','asOf',
      'observedAt','title','mst','lawId','promulgatedOn','effectiveOn','articles'])
    and p_reference->'contractVersion' = '"law-reference/v1"'::jsonb
    and p_reference->'dataOrigin' = '"collected"'::jsonb
    and p_reference->'title' = '"주택공급에 관한 규칙"'::jsonb
    and jsonb_typeof(p_reference->'mst') = 'string' and p_reference->>'mst' ~ '\A[0-9]{1,20}\Z' and p_reference->>'mst' ~ '[1-9]'
    and jsonb_typeof(p_reference->'lawId') = 'string' and p_reference->>'lawId' ~ '\A[0-9]{1,20}\Z' and p_reference->>'lawId' ~ '[1-9]'
    and promulgated_date <= reference_date and effective_date <= reference_date
    and observed_epoch >= extract(epoch from (reference_date::timestamp at time zone 'Asia/Seoul'))
    and observed_epoch <= extract(epoch from statement_timestamp() + interval '5 minutes')
    and jsonb_typeof(articles) = 'array', false) then
    raise exception 'invalid_law_reference' using errcode = '22023';
  end if;

  if jsonb_array_length(articles) not between 1 and 64
    or exists (select 1 from jsonb_array_elements(articles) as a(value)
      where not coalesce(private.ingestion_v0_object(a.value,array['number','branch','heading'])
        and jsonb_typeof(a.value->'number') = 'string' and a.value->>'number' ~ '\A[1-9][0-9]{0,3}\Z'
        and (a.value->'branch' = 'null'::jsonb or (jsonb_typeof(a.value->'branch') = 'string'
          and a.value->>'branch' ~ '\A[1-9][0-9]?\Z'))
        -- 공통 라벨 검사는 UTF-16 단위를 센다. 조문 제목은 코드 포인트 160개까지다.
        and private.notice_search_label(a.value->'heading',320) and char_length(a.value->>'heading') <= 160
        and a.value->>'heading' !~* '[<>]|\mOC\M[[:space:]]*[:=]', false))
    or exists (select 1 from jsonb_array_elements(articles) as a(value)
      group by a.value->>'number',a.value->>'branch' having count(*) > 1) then
    raise exception 'invalid_law_reference' using errcode = '22023';
  end if;

  -- 출처 권한을 잠근 뒤 공고일의 기존 참조보다 나중 관측만 같은 행에 반영한다.
  perform private.require_comparison_sources(array['law_eflaw']);
  insert into private.law_references as published(as_of,reference_value) values (reference_date,p_reference)
    on conflict (as_of) do update set reference_value = excluded.reference_value
    where private.notice_search_epoch(published.reference_value->>'observedAt') < observed_epoch;
  if not found and not exists (select 1 from private.law_references r
      where r.as_of = reference_date and r.reference_value = p_reference) then
    raise exception 'law_reference_publication_conflict' using errcode = 'PT409';
  end if;
end;
$$;

create function private.read_analysis_legal_evidence(p_analysis_id uuid,p_snapshot_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  caller_id uuid := auth.uid();
  snapshot public.analysis_input_snapshots%rowtype;
  catalog jsonb;
  target jsonb;
  notice jsonb;
  date_field jsonb;
  raw_date text;
  notice_date date;
  evidence_status text;
  law_reference jsonb;
begin
  if caller_id is null or coalesce(auth.jwt()->'is_anonymous','false'::jsonb) <> 'false'::jsonb
    or not exists (select 1 from auth.users u where u.id = caller_id and u.confirmed_at is not null
      and u.is_anonymous is false and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= statement_timestamp())) then
    raise exception 'legal_authentication_required' using errcode = '42501';
  end if;
  select s.* into snapshot from public.analysis_input_snapshots s
    where (s.id,s.analysis_id,s.user_id) = (p_snapshot_id,p_analysis_id,caller_id);
  if not found then
    raise exception 'analysis_snapshot_not_found' using errcode = 'PT404';
  end if;

  if snapshot.data_origin = 'synthetic' then
    evidence_status := 'synthetic_input';
  elsif not private.comparison_sources_permitted(array[snapshot.notice_source]) then
    evidence_status := 'source_restricted';
  else
    catalog := snapshot.result_snapshot->'catalog';
    notice := catalog->'notice';
    target := jsonb_build_object('houseManageNo',snapshot.house_manage_no,'noticeNo',snapshot.notice_no,'edition',snapshot.edition);
    -- 캡처 당시 명시한 공고 번호쌍·회차로 판정한다.
    if snapshot.target_binding_status <> 'matched' or snapshot.notice_id is not null or snapshot.housing_type_id is not null
      or snapshot.conditions_snapshot->'ingestion_target' is distinct from (target || jsonb_build_object('noticeSource',snapshot.notice_source))
      or catalog->'target' is distinct from target or notice->'source' is distinct from to_jsonb(snapshot.notice_source) then
      evidence_status := 'selection_unverified';
    else
      date_field := notice#>'{fields,RCRIT_PBLANC_DE}';
      if notice->>'status' = 'reported' and catalog#>>'{collections,notice,declaredStatus}' = 'complete'
        and catalog#>>'{collections,notice,status}' = 'complete'
        and jsonb_typeof(notice->'evidence') = 'array' and notice->'evidence' <> '[]'::jsonb
        and date_field->>'status' = 'reported' and jsonb_typeof(date_field->'value') = 'string' then
        raw_date := date_field->>'value';
        if raw_date ~ '\A[0-9]{8}\Z' then
          raw_date := left(raw_date,4) || '-' || substr(raw_date,5,2) || '-' || right(raw_date,2);
        elsif raw_date ~ '\A[0-9]{4}[.][0-9]{2}[.][0-9]{2}\Z' then
          raw_date := replace(raw_date,'.','-');
        end if;
        notice_date := private.law_reference_iso_date(raw_date);
      end if;
      if notice_date is null then
        evidence_status := 'notice_date_unverified';
      elsif not private.comparison_sources_permitted(array['law_eflaw']) then
        evidence_status := 'source_restricted';
      else
        select r.reference_value into law_reference from private.law_references r where r.as_of = notice_date;
        evidence_status := case when found then 'available' else 'version_unverified' end;
      end if;
    end if;
  end if;
  return jsonb_build_object('analysisId',p_analysis_id,'snapshotId',p_snapshot_id,'dataOrigin',snapshot.data_origin,
    'noticeDate',to_char(notice_date,'YYYY-MM-DD'),'noticeSource',snapshot.notice_source,
    'status',evidence_status,'reference',law_reference);
end;
$$;

create function public.publish_law_reference(p_reference jsonb)
returns void language sql security invoker set search_path = '' as $$
  select private.publish_law_reference(p_reference);
$$;

create function public.read_analysis_legal_evidence(p_analysis_id uuid,p_snapshot_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.read_analysis_legal_evidence(p_analysis_id,p_snapshot_id);
$$;

revoke all on function private.law_reference_iso_date(text),
  private.publish_law_reference(jsonb), public.publish_law_reference(jsonb),
  private.read_analysis_legal_evidence(uuid,uuid), public.read_analysis_legal_evidence(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.publish_law_reference(jsonb), public.publish_law_reference(jsonb) to service_role;
grant execute on function private.read_analysis_legal_evidence(uuid,uuid), public.read_analysis_legal_evidence(uuid,uuid) to authenticated;
