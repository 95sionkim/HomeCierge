-- 두 목록은 게시 데이터 검증을 공유하고, 각 용도에서 확인한 최신 관측을 따로 보관한다.
create function private.validate_notice_publication(p_index jsonb)
returns void language plpgsql set search_path = '' as $$
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

end;
$$;

create or replace function public.publish_notice_search_index(p_index jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare observed_epoch numeric := private.notice_search_epoch(p_index->>'observedAt');
begin
  perform private.validate_notice_publication(p_index);
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

create table private.notice_directory_publication (
  singleton boolean primary key default true check (singleton),
  index_value jsonb not null,
  region_names jsonb not null
);
alter table private.notice_directory_publication enable row level security;
revoke all on private.notice_directory_publication from public, anon, authenticated, service_role;

-- 기존 배포에서 최초 전용 발행 전까지는 이미 검수한 공고 색인으로 읽기를 이어간다.
create function private.notice_directory_index_value()
returns jsonb language sql stable set search_path = '' as $$
  select coalesce((select index_value from private.notice_directory_publication),
                  (select index_value from private.notice_search_index));
$$;

create function public.publish_notice_directory(p_index jsonb,p_regions jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  observed numeric;
begin
  perform private.validate_notice_publication(p_index);
  if p_index->'coverage'->>'status' <> 'complete' or exists (
    select 1 from jsonb_array_elements(p_index->'notices') c(n)
    where n->'sourceIds' ? 'applyhome_notice_pdf'
       or exists (select 1 from jsonb_array_elements(n->'models') x(m) where m->'rooms' <> '[]'::jsonb)
  ) then
    raise exception 'invalid_directory_publication' using errcode = '22023';
  end if;
  if jsonb_typeof(p_regions) is distinct from 'object' or octet_length(p_regions::text) > 200000 then
    raise exception 'invalid_directory_regions' using errcode = '22023';
  end if;
  if (select jsonb_agg(code order by code collate "C") from jsonb_object_keys(p_regions) r(code))
     is distinct from p_index->'regionCodes' or exists (
       select 1 from jsonb_each(p_regions) r(code,label) where not private.notice_search_label(label,120)
     ) then
    raise exception 'invalid_directory_regions' using errcode = '22023';
  end if;
  observed := private.notice_search_epoch(p_index->>'observedAt');
  insert into private.notice_directory_publication as current_index(index_value,region_names) values (p_index,p_regions)
    on conflict (singleton) do update set index_value=excluded.index_value, region_names=excluded.region_names
    where private.notice_search_epoch(current_index.index_value->>'observedAt') < observed;
  if not found and not exists (select 1 from private.notice_directory_publication
    where index_value = p_index and region_names = p_regions) then
    raise exception 'notice_search_publication_conflict' using errcode = 'PT409';
  end if;
end;
$$;
revoke all on function private.validate_notice_publication(jsonb), private.notice_directory_index_value(),
  public.publish_notice_directory(jsonb,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.publish_notice_directory(jsonb,jsonb) to service_role;

-- 공고 목록은 일정과 주택형 식별자만 제공한다. 호실 가격을 담는 맞춤 검색 권한은 별도로 적용한다.
create function private.read_notice_directory_index()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  published jsonb;
  names jsonb;
  result_rows jsonb;
  allowed_models text[];
begin
  if caller is null or coalesce(auth.jwt()->'is_anonymous','false'::jsonb) <> 'false'::jsonb
    or not exists (select 1 from auth.users u where u.id = caller and u.confirmed_at is not null
      and u.is_anonymous is false and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= statement_timestamp())) then
    raise exception 'notice_search_authentication_required' using errcode = '42501';
  end if;

  select p.index_value,p.region_names into published,names from private.notice_directory_publication p;
  if not found then
    select i.index_value into published from private.notice_search_index i;
  end if;
  if published is null or not private.notice_search_is_fresh(private.notice_search_epoch(published->>'observedAt')) then
    return null;
  end if;
  if not private.comparison_sources_permitted(array['applyhome_apt','applyhome_remainder','mois_legal_region_codes']) then
    raise exception 'notice_search_source_use_not_allowed' using errcode = 'PT403';
  end if;
  allowed_models := array(select id from unnest(array['applyhome_apt_model','applyhome_remainder_model']) s(id)
    where private.comparison_sources_permitted(array[id]));

  -- 같은 공고에 여러 모델 출처가 들어 있다면 모두 확인되어야 모델 행을 표시할 수 있다.
  select coalesce(jsonb_agg(
    jsonb_build_object('houseManageNo',n->'houseManageNo','noticeNo',n->'noticeNo','edition',n->'edition',
      'title',n->'title','kind',n->'kind','regionCode',n->'regionCode','application',n->'application',
      'moveIn',null,'inventoryComplete',false,'sourceIds',sources.visible,'reasonCodes',reasons.visible,
      'models',case when sources.model_restricted then '[]'::jsonb else
        (select coalesce(jsonb_agg(jsonb_build_object('modelNo',m->'modelNo','houseType',m->'houseType',
          'supplyAreaM2',null,'areaEvidence','[]'::jsonb,'rooms','[]'::jsonb) order by pos),'[]')
         from jsonb_array_elements(n->'models') with ordinality as models(m,pos)) end)
    || (case when n ? 'applicationSegments' then jsonb_build_object('applicationSegments',n->'applicationSegments') else '{}'::jsonb end)
    || (case when n ? 'parentRegionCode' then jsonb_build_object('parentRegionCode',n->'parentRegionCode') else '{}'::jsonb end)
    order by ordinal),'[]'::jsonb) into result_rows
  from jsonb_array_elements(published->'notices') with ordinality as notices(n,ordinal)
  cross join lateral (
    select jsonb_agg(id order by pos) filter (where id in ('applyhome_apt','applyhome_remainder') or id = any(allowed_models)) as visible,
      bool_or(id in ('applyhome_apt_model','applyhome_remainder_model') and not id = any(allowed_models)) as model_restricted
    from jsonb_array_elements_text(n->'sourceIds') with ordinality as ids(id,pos)
  ) sources
  cross join lateral (
    select coalesce(jsonb_agg(code order by code),'[]'::jsonb) as visible from (
      select code from jsonb_array_elements_text(n->'reasonCodes') as r(code) where code = any(array[
        'publication_date_unverified','notice_metadata_conflict','notice_kind_unverified','notice_kind_unsupported',
        'kind_unverified','region_unverified','application_unverified','application_dates_unverified','application_split',
        'model_unverified','detail_collection_incomplete','detail_budget_exhausted','detail_page_limit_reached'])
      union select 'source_restricted' where sources.model_restricted
    ) as exposed
  ) reasons;

  return jsonb_build_object('contractVersion',published->'contractVersion','dataOrigin',published->'dataOrigin',
    'observedAt',published->'observedAt','publicationWindow',published->'publicationWindow',
    'regionCodes',published->'regionCodes','regionNames',coalesce(names,'{}'::jsonb),
    'coverage',published->'coverage','notices',result_rows);
end;
$$;

create function public.read_notice_directory_index()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.read_notice_directory_index();
$$;

revoke all on function private.read_notice_directory_index(), public.read_notice_directory_index()
  from public, anon, authenticated, service_role;
grant execute on function private.read_notice_directory_index(), public.read_notice_directory_index() to authenticated;
