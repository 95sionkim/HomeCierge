-- 기존 실행 계획의 InitPlan을 확인했다. JWT 함수 자체를 스칼라 하위 질의로
-- 분리해 검사 도구에도 한 번 평가하는 의도를 명시하며 소유권 조건은 유지한다.
do $$
declare name text;
begin
  foreach name in array array['user_profiles','chats','chat_messages','profile_change_requests','analyses','funding_entries','reports'] loop
    execute format('alter policy owner_access on public.%I using ((select auth.uid()) = user_id and coalesce(((select auth.jwt())->>''is_anonymous''),''false'') = ''false'') with check ((select auth.uid()) = user_id and coalesce(((select auth.jwt())->>''is_anonymous''),''false'') = ''false'')', name);
  end loop;
  foreach name in array array['source_registry','notices','notice_documents','housing_types'] loop
    execute format('alter policy signed_in_read on public.%I using ((select auth.uid()) is not null and coalesce(((select auth.jwt())->>''is_anonymous''),''false'') = ''false'')', name);
  end loop;
end;
$$;

-- 수집 기록은 서버 전용이다. 일반 사용자에게 권한을 추가하지 않는다.
create policy server_ingestion_only on private.ingestion_runs
for all to service_role using (true) with check (true);
