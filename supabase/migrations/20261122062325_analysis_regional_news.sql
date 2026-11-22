-- 한 계정당 현재 조회 구간과 시도 횟수만 남긴다. 인증 계정을 삭제하면 함께 제거한다.
create table private.regional_news_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  attempts integer not null check (attempts between 1 and 6)
);
alter table private.regional_news_attempts enable row level security;
revoke all on private.regional_news_attempts from public, anon, authenticated, service_role;

create function private.regional_news_region(p_address text)
returns text language plpgsql immutable strict set search_path = '' as $$
declare
  -- 행정안전부 법정동 코드 전체자료 현존 시·군·구 (2026-11-22 확인).
  -- https://www.code.go.kr/stdcode/regCodeL.do
  -- 현존하지 않는 행정구역이나 신설 구역은 자료를 갱신하기 전까지 보류한다.
  districts constant jsonb := '{
    "서울특별시": "종로구 중구 용산구 성동구 광진구 동대문구 중랑구 성북구 강북구 도봉구 노원구 은평구 서대문구 마포구 양천구 강서구 구로구 금천구 영등포구 동작구 관악구 서초구 강남구 송파구 강동구",
    "전남광주통합특별시": "목포시 여수시 순천시 나주시 광양시 동구 서구 남구 북구 광산구 담양군 곡성군 구례군 고흥군 보성군 화순군 장흥군 강진군 해남군 영암군 무안군 함평군 영광군 장성군 완도군 진도군 신안군",
    "부산광역시": "중구 서구 동구 영도구 부산진구 동래구 남구 북구 해운대구 사하구 금정구 강서구 연제구 수영구 사상구 기장군",
    "대구광역시": "중구 동구 서구 남구 북구 수성구 달서구 달성군 군위군",
    "인천광역시": "제물포구 영종구 미추홀구 연수구 남동구 부평구 계양구 서해구 검단구 강화군 옹진군",
    "대전광역시": "동구 중구 서구 유성구 대덕구",
    "울산광역시": "중구 남구 동구 북구 울주군",
    "세종특별자치시": "",
    "경기도": "수원시 성남시 의정부시 안양시 부천시 광명시 평택시 동두천시 안산시 고양시 과천시 구리시 남양주시 오산시 시흥시 군포시 의왕시 하남시 용인시 파주시 이천시 안성시 김포시 화성시 광주시 양주시 포천시 여주시 연천군 가평군 양평군",
    "경기도 수원시": "장안구 권선구 팔달구 영통구",
    "경기도 성남시": "수정구 중원구 분당구",
    "경기도 안양시": "만안구 동안구",
    "경기도 부천시": "원미구 소사구 오정구",
    "경기도 안산시": "상록구 단원구",
    "경기도 고양시": "덕양구 일산동구 일산서구",
    "경기도 용인시": "처인구 기흥구 수지구",
    "경기도 화성시": "만세구 효행구 병점구 동탄구",
    "충청북도": "청주시 충주시 제천시 보은군 옥천군 영동군 증평군 진천군 괴산군 음성군 단양군",
    "충청북도 청주시": "상당구 서원구 흥덕구 청원구",
    "충청남도": "천안시 공주시 보령시 아산시 서산시 논산시 계룡시 당진시 금산군 부여군 서천군 청양군 홍성군 예산군 태안군",
    "충청남도 천안시": "동남구 서북구",
    "경상북도": "포항시 경주시 김천시 안동시 구미시 영주시 영천시 상주시 문경시 경산시 의성군 청송군 영양군 영덕군 청도군 고령군 성주군 칠곡군 예천군 봉화군 울진군 울릉군",
    "경상북도 포항시": "남구 북구",
    "경상남도": "창원시 진주시 통영시 사천시 김해시 밀양시 거제시 양산시 의령군 함안군 창녕군 고성군 남해군 하동군 산청군 함양군 거창군 합천군",
    "경상남도 창원시": "의창구 성산구 마산합포구 마산회원구 진해구",
    "제주특별자치도": "제주시 서귀포시",
    "강원특별자치도": "춘천시 원주시 강릉시 동해시 태백시 속초시 삼척시 홍천군 횡성군 영월군 평창군 정선군 철원군 화천군 양구군 인제군 고성군 양양군",
    "전북특별자치도": "전주시 군산시 익산시 정읍시 남원시 김제시 완주군 진안군 무주군 장수군 임실군 순창군 고창군 부안군",
    "전북특별자치도 전주시": "완산구 덕진구"
  }';
  -- 일대일 대응하는 시·도 약칭과 옛 광역 명칭만 정규화한다.
  aliases constant jsonb := '{
    "서울":"서울특별시", "서울시":"서울특별시", "부산":"부산광역시", "대구":"대구광역시",
    "인천":"인천광역시", "대전":"대전광역시", "울산":"울산광역시", "세종":"세종특별자치시",
    "세종시":"세종특별자치시", "경기":"경기도", "충북":"충청북도", "충남":"충청남도",
    "경북":"경상북도", "경남":"경상남도", "제주":"제주특별자치도", "제주도":"제주특별자치도",
    "강원":"강원특별자치도", "강원도":"강원특별자치도", "전북":"전북특별자치도", "전라북도":"전북특별자치도"
  }';
  address text;
  parts text[];
  province text;
  region text;
  address_start integer := 2;
begin
  if char_length(p_address) > 320 then return null; end if;
  address := btrim(normalize(translate(p_address,chr(160),' ')));
  if address collate "C" !~ '\A[가-힣A-Za-z0-9.,() -]+\Z' then return null; end if;
  parts := regexp_split_to_array(address,' +');
  province := coalesce(aliases->>parts[1],parts[1]);
  if not districts ? province then return null; end if;

  region := province;
  if province <> '세종특별자치시' then
    if not coalesce(parts[2] = any(string_to_array(districts->>province,' ')),false) then return null; end if;
    region := province || ' ' || parts[2];
    address_start := 3;
    if parts[3] = any(string_to_array(districts->>region,' ')) then
      region := region || ' ' || parts[3];
      address_start := 4;
    end if;
  end if;

  -- 다른 행정구역 표현이 따라오는 주소는 보류한다. 사업지구·신도시 표기는 검색어에 포함하지 않는다.
  if exists (select 1 from regexp_split_to_table(array_to_string(parts[address_start:],' '),'[ (),.]+') as t(token)
    where aliases ? t.token or t.token in ('광주','전남')
      or (t.token collate "C" ~ '\A[가-힣]+[시군구도](와|과)?\Z' and t.token !~ '(지구|신도시)(와|과)?\Z')) then
    return null;
  end if;
  return region;
end;
$$;

create function private.prepare_analysis_regional_news(p_analysis_id uuid,p_snapshot_id uuid)
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
      -- UTC 분 단위 고정 구간에서 계정마다 최대 6회. 기본키 갱신 조건으로 동시 요청도 제한한다.
      insert into private.regional_news_attempts as counter(user_id,window_start,attempts)
        values (caller_id,date_trunc('minute',clock_timestamp(),'UTC'),1)
        on conflict (user_id) do update set window_start = excluded.window_start,
          attempts = case when counter.window_start = excluded.window_start then counter.attempts + 1 else 1 end
        where counter.window_start < excluded.window_start
          or (counter.window_start = excluded.window_start and counter.attempts < 6);
      if not found then
        raise exception 'regional_news_rate_limited' using errcode = 'PT429';
      end if;
      preparation_status := 'ready';
    end if;
  end if;
  return jsonb_build_object('analysisId',p_analysis_id,'snapshotId',p_snapshot_id,'status',preparation_status,'region',region);
end;
$$;

create function public.prepare_analysis_regional_news(p_analysis_id uuid,p_snapshot_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.prepare_analysis_regional_news(p_analysis_id,p_snapshot_id);
$$;

revoke all on function private.regional_news_region(text),
  private.prepare_analysis_regional_news(uuid,uuid), public.prepare_analysis_regional_news(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.prepare_analysis_regional_news(uuid,uuid),
  public.prepare_analysis_regional_news(uuid,uuid) to authenticated;
