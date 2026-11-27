-- 지역 뉴스 쪽 넘김 조회에 맞춰 계정별 분당 호출 한도를 6회에서 12회로 확대한다.
alter table private.regional_news_attempts
  drop constraint regional_news_attempts_attempts_check,
  add constraint regional_news_attempts_attempts_check check (attempts between 1 and 12);

create or replace function private.prepare_analysis_regional_news(p_analysis_id uuid,p_snapshot_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller_id uuid := auth.uid();
  snapshot public.analysis_input_snapshots%rowtype;
  catalog jsonb;
  target jsonb;
  notice jsonb;
  collection jsonb;
  address_field jsonb;
  region text;
  preparation_status text;
begin
  -- 계정 행을 먼저 잠가 계정 삭제와 한도 기록이 엇갈리지 않게 한다.
  if caller_id is null or coalesce(auth.jwt()->'is_anonymous','false'::jsonb) <> 'false'::jsonb
    or not exists (select 1 from auth.users u where u.id = caller_id and u.confirmed_at is not null
      and u.is_anonymous is false and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= statement_timestamp()) for share) then
    raise exception 'regional_news_authentication_required' using errcode = '42501';
  end if;
  select s.* into snapshot from public.analysis_input_snapshots s
    where (s.id,s.analysis_id,s.user_id) = (p_snapshot_id,p_analysis_id,caller_id) for key share;
  if not found then
    raise exception 'analysis_snapshot_not_found' using errcode = 'PT404';
  end if;

  catalog := snapshot.result_snapshot->'catalog';
  target := jsonb_build_object('houseManageNo',snapshot.house_manage_no,'noticeNo',snapshot.notice_no,'edition',snapshot.edition);
  notice := catalog->'notice';
  collection := catalog#>'{collections,notice}';
  address_field := notice#>'{fields,HSSPLY_ADRES}';

  if snapshot.data_origin = 'synthetic' then
    preparation_status := 'synthetic_input';
  -- 주소는 캡처 당시 선택된 번호쌍·회차와 공개 공고 목록의 확인된 관측에서만 읽는다.
  elsif not coalesce(snapshot.target_binding_status = 'matched' and snapshot.notice_id is null
    and snapshot.housing_type_id is null and snapshot.notice_source in ('applyhome_apt','applyhome_remainder')
    and snapshot.conditions_snapshot->'ingestion_target' = (target || jsonb_build_object('noticeSource',snapshot.notice_source))
    and snapshot.input_snapshot->'target' = target and snapshot.input_snapshot->>'noticeSource' = snapshot.notice_source
    and snapshot.result_snapshot->'target' = target and snapshot.result_snapshot->>'dataOrigin' = 'collected'
    and catalog->>'contract' = 'applyhome-catalog/v0' and catalog->'target' = target
    and notice->>'source' = snapshot.notice_source
    and notice->>'status' = 'reported' and coalesce(notice->'reasons','[]'::jsonb) = '[]'::jsonb
    and collection->>'source' = snapshot.notice_source and collection->>'declaredStatus' = 'complete'
    and collection->>'status' = 'complete' and collection->'inScope' = collection->'observations'
    and case when jsonb_typeof(notice->'evidence') = 'array' then
      notice->'evidence' @> '[{"collection":"notice"}]'::jsonb
        and collection->'inScope' = to_jsonb(jsonb_array_length(notice->'evidence'))
      else false end
    and snapshot.result_snapshot->'catalogCollections' @> jsonb_build_array(jsonb_build_object(
      'source',snapshot.notice_source,'status','complete','reasons','[]'::jsonb,'rowsReceived',collection->'inScope',
      'scope',jsonb_build_object('cond[HOUSE_MANAGE_NO::EQ]',snapshot.house_manage_no,'cond[PBLANC_NO::EQ]',snapshot.notice_no)))
    and not catalog->'issues' @> '[{"collection":"notice"}]'::jsonb,false) then
    preparation_status := 'selection_unverified';
  -- 뉴스 발췌의 일회 조회는 표시 권한만 확인한다. 이 마이그레이션에서 출처 권한을 등록하지 않는다.
  elsif not private.comparison_sources_permitted(array[snapshot.notice_source,'mois_legal_region_codes'])
    or not exists (select 1 from public.source_registry r where r.id = 'naver_news' and r.display_permission = 'allowed') then
    preparation_status := 'source_restricted';
  else
    if coalesce(private.ingestion_v0_object(address_field,array['status','value','reasons'])
      and address_field->>'status' = 'reported' and jsonb_typeof(address_field->'value') = 'string'
      and coalesce(address_field->'reasons','[]'::jsonb) = '[]'::jsonb
      and not catalog->'issues' @> '[{"code":"notice_field_conflict","field":"HSSPLY_ADRES"}]'::jsonb,false) then
      region := private.regional_news_region(address_field->>'value');
    end if;

    if region is null then
      preparation_status := 'region_unverified';
    else
      -- UTC 분 단위 고정 구간에서 계정마다 최대 12회. 기본키 갱신 조건으로 동시 요청도 제한한다.
      insert into private.regional_news_attempts as counter(user_id,window_start,attempts)
        values (caller_id,date_trunc('minute',clock_timestamp(),'UTC'),1)
        on conflict (user_id) do update set window_start = excluded.window_start,
          attempts = case when counter.window_start = excluded.window_start then counter.attempts + 1 else 1 end
        where counter.window_start < excluded.window_start
          or (counter.window_start = excluded.window_start and counter.attempts < 12);
      if not found then
        raise exception 'regional_news_rate_limited' using errcode = 'PT429';
      end if;
      preparation_status := 'ready';
    end if;
  end if;
  return jsonb_build_object('analysisId',p_analysis_id,'snapshotId',p_snapshot_id,'status',preparation_status,'region',region);
end;
$$;
