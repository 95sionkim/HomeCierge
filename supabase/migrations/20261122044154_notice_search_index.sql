-- 로그인 후 공고 탐색에서 공유할 공식 자료의 최신 버전만 보관한다.
create table private.notice_search_index (
  singleton boolean primary key default true check (singleton),
  index_value jsonb not null check ((index_value->>'contractVersion' = 'notice-search-index/v1'
    and index_value->>'dataOrigin' = 'collected') is true)
);
alter table private.notice_search_index enable row level security;
revoke all on private.notice_search_index from public, anon, authenticated, service_role;

create function private.notice_search_period(value jsonb, monthly boolean)
returns boolean language sql immutable set search_path = '' as $$
  select private.ingestion_v0_object(value,array['start','end'])
    and jsonb_typeof(value->'start') = 'string' and jsonb_typeof(value->'end') = 'string'
    and case when monthly then
      value->>'start' ~ '\A[0-9]{4}-[0-9]{2}\Z' and value->>'end' ~ '\A[0-9]{4}-[0-9]{2}\Z'
      and pg_input_is_valid((value->>'start') || '-01','date') and pg_input_is_valid((value->>'end') || '-01','date')
    else
      value->>'start' ~ '\A[0-9]{4}-[0-9]{2}-[0-9]{2}\Z' and value->>'end' ~ '\A[0-9]{4}-[0-9]{2}-[0-9]{2}\Z'
      and pg_input_is_valid(value->>'start','date') and pg_input_is_valid(value->>'end','date')
    end
    and (value->>'start') collate "C" <= (value->>'end') collate "C";
$$;

create function private.notice_search_epoch(value text)
returns numeric language plpgsql immutable strict set search_path = '' as $$
declare
  utc_second timestamptz;
  fraction text;
begin
  if value !~ '\A[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt]([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?([Zz]|[+-]([01][0-9]|2[0-3]):[0-5][0-9])\Z'
    or not pg_input_is_valid(left(value,10),'date') then
    return null;
  end if;
  utc_second := replace(left(value,19),'t','T')::timestamp at time zone 'UTC';
  if right(value,1) not in ('Z','z') then
    utc_second := utc_second - right(value,6)::interval;
  end if;
  -- 소수 초를 따로 더해 저장 가능한 두 관측을 마이크로초 반올림으로 합치지 않는다.
  fraction := substring(value from '\.([0-9]+)');
  return extract(epoch from utc_second) + ('0.' || coalesce(fraction,'0'))::numeric;
end;
$$;

create function private.notice_search_is_fresh(observed_epoch numeric)
returns boolean language sql stable set search_path = '' as $$
  select observed_epoch between extract(epoch from statement_timestamp() - interval '72 hours')
    and extract(epoch from statement_timestamp() + interval '5 minutes');
$$;

create function private.notice_search_label(value jsonb, max_length integer)
returns boolean language sql immutable set search_path = '' as $$
  -- 앱의 문자열 길이 검사와 같은 단위로 공개 표시 문구를 제한한다.
  select jsonb_typeof(value) = 'string' and length(regexp_replace(label,'[\U00010000-\U0010FFFF]','aa','g')) <= max_length
    and label <> '' and label !~ '(\A[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]|[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]\Z)'
    and label !~* '([[:cntrl:]]|://|//[a-z0-9]|www[.]|https?:|ftp:|file:|javascript:|data:|blob:|mailto:|tel:|analysis-uploads|upload[:/]|@)'
  from (select value#>>'{}' as label) as public_label;
$$;

create function private.notice_search_refs(refs jsonb, document_pattern text, pdf_source boolean, checked_value boolean)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(refs) is distinct from 'array' then
    return false;
  end if;
  if jsonb_array_length(refs) = 0 then
    return not checked_value;
  end if;
  return pdf_source and jsonb_array_length(refs) <= 16 and not exists (
    select 1 from jsonb_array_elements(refs) as r(value)
    where not coalesce(private.ingestion_v0_object(r.value,array['document','version','page'])
      and jsonb_typeof(r.value->'document') = 'string' and r.value->>'document' ~ document_pattern
      and jsonb_typeof(r.value->'version') = 'string' and r.value->>'version' ~ '\Asha256:[0-9a-f]{64}\Z'
      and private.ingestion_v0_count(r.value->'page',1,2147483647), false)
  );
end;
$$;

-- 수집 작업자가 값의 의미와 원문을 검수한다. 발행 경계에서는 공개 필드와 근거 식별자만 받는다.
create function private.check_notice_search_candidate(candidate jsonb, region_codes jsonb, apt_status text, remainder_status text)
returns void language plpgsql set search_path = '' as $$
declare
  models jsonb := candidate->'models';
  sources jsonb := candidate->'sourceIds';
  reasons jsonb := candidate->'reasonCodes';
  region_code text := candidate->>'regionCode';
  parent_region_code text := candidate->>'parentRegionCode';
  application jsonb := candidate->'application';
  segments jsonb := candidate->'applicationSegments';
  segment jsonb;
  previous_segment_end text;
  complete_inventory boolean := candidate->'inventoryComplete' = 'true'::jsonb;
  apt_source boolean := sources ? 'applyhome_apt';
  remainder_source boolean := sources ? 'applyhome_remainder';
  apt_model_source boolean := sources ? 'applyhome_apt_model';
  remainder_model_source boolean := sources ? 'applyhome_remainder_model';
  pdf_source boolean := sources ? 'applyhome_notice_pdf';
  document_pattern text := '\Aapplyhome:' || (candidate->>'houseManageNo') || ':' || (candidate->>'noticeNo')
    || ':[0-9]{1,20}:[0-9]{1,20}\Z';
  model jsonb;
  rooms jsonb;
  room jsonb;
begin
  if not coalesce(private.ingestion_v0_object(candidate,array['houseManageNo','noticeNo','edition','title','kind',
      'regionCode','parentRegionCode','application','applicationSegments','moveIn',
      'inventoryComplete','models','sourceIds','reasonCodes'])
    and jsonb_typeof(candidate->'houseManageNo') = 'string' and candidate->>'houseManageNo' ~ '\A[0-9]{10}\Z'
    and jsonb_typeof(candidate->'noticeNo') = 'string' and candidate->>'noticeNo' ~ '\A[0-9]{10}\Z'
    and jsonb_typeof(candidate->'edition') = 'string' and candidate->>'edition' ~ '\A[0-9a-zA-Z][0-9a-zA-Z._-]{0,63}\Z'
    and (candidate->'title' = 'null'::jsonb or private.notice_search_label(candidate->'title',200))
    and candidate->>'kind' in ('new_sale','unranked','remaining','resupply','unknown','unsupported')
    and (candidate->'regionCode' = 'null'::jsonb
      or (jsonb_typeof(candidate->'regionCode') = 'string' and region_codes ? region_code))
    and (parent_region_code is null or (jsonb_typeof(candidate->'parentRegionCode') = 'string'
      and region_code is not null and parent_region_code <> region_code and region_codes ? parent_region_code))
    and (application = 'null'::jsonb or private.notice_search_period(application,false))
    and (candidate->'moveIn' = 'null'::jsonb or private.notice_search_period(candidate->'moveIn',true))
    and jsonb_typeof(candidate->'inventoryComplete') = 'boolean'
    and jsonb_typeof(models) = 'array' and jsonb_typeof(sources) = 'array' and jsonb_typeof(reasons) = 'array', false) then
    raise exception 'invalid_notice_search_candidate' using errcode = '22023';
  end if;

  -- 분리 일정의 전체 범위를 연속 접수로 읽지 않도록, 확인된 날이 없어도 빈 배열을 요구한다.
  if (segments is not null) <> (application <> 'null'::jsonb and reasons ? 'application_split') then
    raise exception 'invalid_notice_search_application_segments' using errcode = '22023';
  end if;
  if segments is not null then
    if jsonb_typeof(segments) <> 'array' then
      raise exception 'invalid_notice_search_application_segments' using errcode = '22023';
    end if;
    if jsonb_array_length(segments) > 10 then
      raise exception 'invalid_notice_search_application_segments' using errcode = '22023';
    end if;
    for segment in select value from jsonb_array_elements(segments) with ordinality order by ordinality loop
      if not coalesce(private.notice_search_period(segment,false)
        and (segment->>'start') collate "C" >= application->>'start'
        and (segment->>'end') collate "C" <= application->>'end'
        and (previous_segment_end is null or (segment->>'start') collate "C" > previous_segment_end), false) then
        raise exception 'invalid_notice_search_application_segments' using errcode = '22023';
      end if;
      previous_segment_end := segment->>'end';
    end loop;
  end if;

  if jsonb_array_length(models) > 100 or jsonb_array_length(sources) > 5 or jsonb_array_length(reasons) > 32
    or not (apt_source or remainder_source)
    or (apt_source and apt_status not in ('complete','partial'))
    or (remainder_source and remainder_status not in ('complete','partial'))
    or (apt_model_source and not apt_source) or (remainder_model_source and not remainder_source)
    or (jsonb_array_length(models) > 0 and not (apt_model_source or remainder_model_source))
    or (complete_inventory and jsonb_array_length(models) = 0)
    or exists (select 1 from jsonb_array_elements_text(sources) as s(id)
      where s.id is null or s.id not in ('applyhome_apt','applyhome_remainder','applyhome_apt_model',
        'applyhome_remainder_model','applyhome_notice_pdf'))
    or (select count(distinct value) from jsonb_array_elements(sources)) <> jsonb_array_length(sources)
    or exists (select 1 from jsonb_array_elements_text(reasons) as r(code)
      where r.code is null or r.code not in ('publication_date_unverified','notice_metadata_conflict',
        'notice_kind_unverified','notice_kind_unsupported','kind_unverified','region_unverified','application_unverified',
        'application_dates_unverified','application_split','move_in_unverified','model_unverified','detail_collection_incomplete',
        'detail_budget_exhausted','detail_page_limit_reached','document_budget_exhausted','official_document_unverified',
        'source_restricted','source_unverified','inventory_unverified','inventory_incomplete','supply_area_unverified',
        'room_price_unverified','price_unverified'))
    or (select count(distinct value) from jsonb_array_elements(reasons)) <> jsonb_array_length(reasons)
    or exists (select 1 from jsonb_array_elements(models) as m(value) group by m.value->>'modelNo' having count(*) > 1) then
    raise exception 'inconsistent_notice_search_candidate' using errcode = '22023';
  end if;

  for model in select value from jsonb_array_elements(models) loop
    rooms := model->'rooms';
    if not coalesce(private.ingestion_v0_object(model,array['modelNo','houseType','supplyAreaM2','areaEvidence','rooms'])
      and jsonb_typeof(model->'modelNo') = 'string' and model->>'modelNo' ~ '\A[0-9]{1,20}\Z'
      and (model->'houseType' = 'null'::jsonb or private.notice_search_label(model->'houseType',64))
      and (model->'supplyAreaM2' = 'null'::jsonb or (jsonb_typeof(model->'supplyAreaM2') = 'string'
        and length(model->>'supplyAreaM2') <= 24
        and model->>'supplyAreaM2' ~ '\A([1-9][0-9]*(\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)\Z'))
      and private.notice_search_refs(model->'areaEvidence',document_pattern,pdf_source,model->'supplyAreaM2' <> 'null'::jsonb)
      and jsonb_typeof(rooms) = 'array', false) then
      raise exception 'invalid_notice_search_model' using errcode = '22023';
    end if;
    if jsonb_array_length(rooms) > 2000 or (complete_inventory and jsonb_array_length(rooms) = 0)
      or exists (select 1 from jsonb_array_elements(rooms) as r(value) group by r.value->>'room' having count(*) > 1) then
      raise exception 'inconsistent_notice_search_room_inventory' using errcode = '22023';
    end if;
    for room in select value from jsonb_array_elements(rooms) loop
      if not coalesce(private.ingestion_v0_object(room,array['room','subtotalWon','priceEvidence'])
        and private.notice_search_label(room->'room',64)
        and (room->'subtotalWon' = 'null'::jsonb or (jsonb_typeof(room->'subtotalWon') = 'string'
          and room->>'subtotalWon' ~ '\A[1-9][0-9]{0,19}\Z'))
        and private.notice_search_refs(room->'priceEvidence',document_pattern,pdf_source,room->'subtotalWon' <> 'null'::jsonb),
        false) then
        raise exception 'invalid_notice_search_room' using errcode = '22023';
      end if;
    end loop;
  end loop;
end;
$$;

create function private.notice_search_sources(index_value jsonb)
returns text[] language sql immutable set search_path = '' as $$
  select array(
    select 'applyhome_apt'
    union select 'applyhome_remainder'
    union select 'mois_legal_region_codes'
    union select s.id from jsonb_array_elements(index_value->'notices') as n(value)
      cross join lateral jsonb_array_elements_text(n.value->'sourceIds') as s(id)
  );
$$;

create function public.publish_notice_search_index(p_index jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  window_value jsonb := p_index->'publicationWindow';
  coverage jsonb := p_index->'coverage';
  feeds jsonb := coverage->'sources';
  notices jsonb := p_index->'notices';
  region_codes jsonb := p_index->'regionCodes';
  observed_epoch numeric;
  korea_date date;
  window_start date;
  window_end date;
  feed jsonb;
  apt_status text;
  remainder_status text;
  expected_coverage text;
  candidate jsonb;
  source_ids text[];
  locked_sources integer;
begin
  if not coalesce(octet_length(p_index::text) <= 2097152
    and private.ingestion_v0_object(p_index,array['contractVersion','dataOrigin','observedAt','publicationWindow',
      'coverage','notices','regionCodes'])
    and p_index->>'contractVersion' = 'notice-search-index/v1' and p_index->>'dataOrigin' = 'collected'
    and jsonb_typeof(p_index->'observedAt') = 'string' and private.notice_search_period(window_value,false)
    and private.ingestion_v0_object(coverage,array['status','sources'])
    and jsonb_typeof(feeds) = 'array' and jsonb_typeof(notices) = 'array' and jsonb_typeof(region_codes) = 'array', false) then
    raise exception 'invalid_notice_search_index' using errcode = '22023';
  end if;
  observed_epoch := private.notice_search_epoch(p_index->>'observedAt');
  korea_date := (to_timestamp(floor(observed_epoch)::double precision) at time zone 'Asia/Seoul')::date;
  window_start := (window_value->>'start')::date;
  window_end := (window_value->>'end')::date;
  if not coalesce(private.notice_search_is_fresh(observed_epoch) and korea_date = window_end
    and window_end - window_start < 366, false) then
    raise exception 'invalid_notice_search_publication_scope' using errcode = '22023';
  end if;
  if jsonb_array_length(feeds) <> 2 or jsonb_array_length(notices) > 1000 then
    raise exception 'invalid_notice_search_index' using errcode = '22023';
  end if;
  if jsonb_array_length(region_codes) not between 1 and 1000
    or exists (select 1 from jsonb_array_elements(region_codes) as r(value)
      where jsonb_typeof(r.value) <> 'string' or r.value#>>'{}' !~ '\A[0-9]{5}\Z')
    or region_codes is distinct from (select jsonb_agg(code order by code collate "C")
      from (select distinct value as code from jsonb_array_elements_text(region_codes)) as distinct_codes) then
    raise exception 'invalid_notice_search_region_codes' using errcode = '22023';
  end if;

  for feed in select value from jsonb_array_elements(feeds) loop
    if not coalesce(private.ingestion_v0_object(feed,array['source','status'])
      and feed->>'source' in ('applyhome_apt','applyhome_remainder')
      and feed->>'status' in ('complete','empty','partial','failed'), false) then
      raise exception 'invalid_notice_search_coverage' using errcode = '22023';
    end if;
    case feed->>'source'
      when 'applyhome_apt' then apt_status := feed->>'status';
      when 'applyhome_remainder' then remainder_status := feed->>'status';
    end case;
  end loop;
  expected_coverage := case
    when apt_status in ('complete','empty') and remainder_status in ('complete','empty') then 'complete'
    when apt_status = 'failed' and remainder_status = 'failed' then 'unavailable'
    else 'partial'
  end;
  if apt_status is null or remainder_status is null or coverage->>'status' is distinct from expected_coverage then
    raise exception 'inconsistent_notice_search_coverage' using errcode = '22023';
  end if;

  for candidate in select value from jsonb_array_elements(notices) loop
    perform private.check_notice_search_candidate(candidate,region_codes,apt_status,remainder_status);
  end loop;
  if (apt_status = 'complete' and not exists (select 1 from jsonb_array_elements(notices) as n(value)
        where n.value->'sourceIds' ? 'applyhome_apt'))
    or (remainder_status = 'complete' and not exists (select 1 from jsonb_array_elements(notices) as n(value)
        where n.value->'sourceIds' ? 'applyhome_remainder'))
    or exists (select 1 from jsonb_array_elements(notices) as n(value)
      group by n.value->>'houseManageNo', n.value->>'noticeNo' having count(*) > 1) then
    raise exception 'inconsistent_notice_search_coverage' using errcode = '22023';
  end if;

  -- 발행 중에는 출처 권한을 고정한다. 공고가 없어도 두 피드와 지역 사전의 권한을 확인한다.
  source_ids := private.notice_search_sources(p_index);
  perform 1 from public.source_registry r where r.id = any(source_ids) order by r.id for share;
  get diagnostics locked_sources = row_count;
  if locked_sources <> cardinality(source_ids) or not private.comparison_sources_permitted(source_ids) then
    raise exception 'notice_search_source_use_not_allowed' using errcode = '42501';
  end if;

  -- 행이 처음 생기는 시점과 교체 시점을 같은 고유 키에서 보호한다.
  insert into private.notice_search_index as published(index_value) values (p_index)
    on conflict (singleton) do update set index_value = excluded.index_value
    where private.notice_search_epoch(published.index_value->>'observedAt') < observed_epoch;
  if found then
    return;
  end if;
  if exists (select 1 from private.notice_search_index where index_value = p_index) then
    return;
  end if;
  raise exception 'notice_search_publication_conflict' using errcode = 'PT409';
end;
$$;

create function public.read_notice_search_index()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  caller_id uuid := auth.uid();
  published jsonb;
begin
  if caller_id is null or coalesce(auth.jwt()->'is_anonymous','false'::jsonb) <> 'false'::jsonb
    or not exists (select 1 from auth.users u where u.id = caller_id and u.confirmed_at is not null
      and u.is_anonymous is false and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= statement_timestamp())) then
    raise exception 'notice_search_authentication_required' using errcode = '42501';
  end if;

  select i.index_value into published from private.notice_search_index i;
  if published is null or not coalesce(private.notice_search_is_fresh(
    private.notice_search_epoch(published->>'observedAt')),false) then
    return null;
  end if;
  if not private.comparison_sources_permitted(private.notice_search_sources(published)) then
    raise exception 'notice_search_source_use_not_allowed' using errcode = 'PT403';
  end if;
  return published;
end;
$$;

revoke all on function private.notice_search_period(jsonb,boolean), private.notice_search_epoch(text),
  private.notice_search_is_fresh(numeric), private.notice_search_label(jsonb,integer),
  private.notice_search_refs(jsonb,text,boolean,boolean), private.check_notice_search_candidate(jsonb,jsonb,text,text),
  private.notice_search_sources(jsonb), public.publish_notice_search_index(jsonb), public.read_notice_search_index()
  from public, anon, authenticated, service_role;
grant execute on function public.publish_notice_search_index(jsonb) to service_role;
grant execute on function public.read_notice_search_index() to authenticated;
