-- Storage v1.98의 권한 검사는 임시 INSERT를 롤백하고, 최종 저장은 백엔드 메타데이터로 커밋한다.
-- https://github.com/supabase/storage/blob/v1.98.0/src/storage/uploader.ts
create function private.guard_analysis_upload_cache()
returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  cache_directives text[] := array(
    select lower(btrim(directive, E' \t') collate "C")
    from unnest(string_to_array(new.metadata->>'cacheControl', ',')) as part(directive)
  );
begin
  if not (
    cache_directives <@ array['private', 'max-age=0', 'no-cache', 'no-store']
    and cache_directives && array['max-age=0', 'no-cache', 'no-store']
  ) then
    raise exception 'analysis_upload_cache_control_required' using errcode = '42501';
  end if;
  return null;
end;
$$;

-- 권한 검사를 방해하지 않고 이 버킷의 최종 저장에만 적용한다.
create constraint trigger guard_analysis_upload_cache
after insert on storage.objects
deferrable initially deferred
for each row when (new.bucket_id = 'analysis-uploads')
execute function private.guard_analysis_upload_cache();

revoke all on function private.guard_analysis_upload_cache()
from public, anon, authenticated, service_role;
