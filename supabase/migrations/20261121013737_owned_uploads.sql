-- 분석별 사용자 PDF를 공유 공고의 문서 근거와 분리한다.
create table public.analysis_uploads (
  user_id uuid not null,
  analysis_id uuid not null,
  id uuid not null,
  object_path text collate "C" generated always as
    (user_id::text || '/' || analysis_id::text || '/' || id::text || '.pdf') stored unique,
  status text not null default 'registered'
    check (status in ('registered', 'deletion_requested', 'deleted')),
  primary key (user_id, analysis_id, id),
  foreign key (analysis_id, user_id) references public.analyses(id, user_id) on delete cascade
);

alter table public.analysis_uploads enable row level security;
revoke all on public.analysis_uploads from public, anon, authenticated, service_role;
grant select on public.analysis_uploads to authenticated;
create policy owner_read on public.analysis_uploads
for select to authenticated using (
  user_id = (select auth.uid())
  and coalesce(((select auth.jwt())->>'is_anonymous'), 'false') = 'false'
  and status <> 'deleted'
);

insert into storage.buckets (id, name, public, allowed_mime_types)
values ('analysis-uploads', 'analysis-uploads', false, array['application/pdf']);

create function private.register_analysis_upload(target_analysis_id uuid, target_upload_id uuid)
returns public.analysis_uploads
language plpgsql security definer set search_path = '' as $$
declare
  caller_id uuid := auth.uid();
  upload public.analysis_uploads;
begin
  if caller_id is null or coalesce(auth.jwt()->>'is_anonymous', 'false') <> 'false'
     or not exists (select 1 from auth.users where id = caller_id) then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if target_analysis_id is null or target_upload_id is null then
    raise exception 'analysis_upload_ids_required' using errcode = '22023';
  end if;

  -- 등록과 상위 분석 삭제를 직렬화한다.
  perform 1 from public.analyses
  where id = target_analysis_id and user_id = caller_id
  for key share;
  if not found then
    raise exception 'analysis_not_found' using errcode = 'P0002';
  end if;

  insert into public.analysis_uploads (user_id, analysis_id, id)
  values (caller_id, target_analysis_id, target_upload_id)
  on conflict (user_id, analysis_id, id) do nothing;

  -- 동일한 등록 키는 삭제 처리 중이거나 마쳤어도 다시 활성화하지 않는다.
  select * into upload from public.analysis_uploads
  where user_id = caller_id and analysis_id = target_analysis_id and id = target_upload_id;
  return upload;
end;
$$;

create function private.change_analysis_upload_deletion(
  target_analysis_id uuid, target_upload_id uuid, finalize boolean
)
returns public.analysis_uploads
language plpgsql security definer set search_path = '' as $$
declare
  caller_id uuid := auth.uid();
  upload public.analysis_uploads;
begin
  if caller_id is null or coalesce(auth.jwt()->>'is_anonymous', 'false') <> 'false'
     or not exists (select 1 from auth.users where id = caller_id) then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select * into upload from public.analysis_uploads
  where user_id = caller_id and analysis_id = target_analysis_id and id = target_upload_id
  for update;
  if not found then
    raise exception 'analysis_upload_not_found' using errcode = 'P0002';
  end if;
  if upload.status = 'deleted' or (not finalize and upload.status = 'deletion_requested') then
    return upload;
  end if;

  if finalize then
    if upload.status <> 'deletion_requested' then
      raise exception 'analysis_upload_deletion_required' using errcode = '55000';
    end if;
    -- 파일은 호출자가 Storage API로 지운다. 여기서는 카탈로그의 부재만 확인한다.
    if exists (
      select 1 from storage.objects
      where bucket_id = 'analysis-uploads' and name collate "C" = upload.object_path
    ) then
      raise exception 'analysis_upload_object_exists' using errcode = '55000';
    end if;
  end if;

  update public.analysis_uploads
  set status = case when finalize then 'deleted' else 'deletion_requested' end
  where user_id = caller_id and analysis_id = target_analysis_id and id = target_upload_id
  returning * into upload;
  return upload;
end;
$$;

create function public.register_analysis_upload(analysis_id uuid, upload_id uuid)
returns public.analysis_uploads
language sql security invoker set search_path = ''
as $$ select private.register_analysis_upload(analysis_id, upload_id); $$;

create function public.request_analysis_upload_deletion(analysis_id uuid, upload_id uuid)
returns public.analysis_uploads
language sql security invoker set search_path = ''
as $$ select private.change_analysis_upload_deletion(analysis_id, upload_id, false); $$;

create function public.finalize_analysis_upload_deletion(analysis_id uuid, upload_id uuid)
returns public.analysis_uploads
language sql security invoker set search_path = ''
as $$ select private.change_analysis_upload_deletion(analysis_id, upload_id, true); $$;

revoke all on function
  private.register_analysis_upload(uuid, uuid),
  private.change_analysis_upload_deletion(uuid, uuid, boolean),
  public.register_analysis_upload(uuid, uuid),
  public.request_analysis_upload_deletion(uuid, uuid),
  public.finalize_analysis_upload_deletion(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function
  private.register_analysis_upload(uuid, uuid),
  private.change_analysis_upload_deletion(uuid, uuid, boolean),
  public.register_analysis_upload(uuid, uuid),
  public.request_analysis_upload_deletion(uuid, uuid),
  public.finalize_analysis_upload_deletion(uuid, uuid)
to authenticated;

-- 최종 상태의 최소 식별 행만 연쇄 삭제할 수 있다.
create function private.guard_analysis_upload_cascade()
returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status <> 'deleted' then
    raise exception 'analysis_upload_cleanup_required' using errcode = '23503';
  end if;
  return old;
end;
$$;

create trigger guard_analysis_upload_cascade before delete on public.analysis_uploads
for each row execute function private.guard_analysis_upload_cascade();

-- Storage의 사전 권한 검사와 실제 저장 사이에도 등록 상태가 바뀔 수 있다.
-- 최종 객체 행이 커밋될 때까지 등록 행을 잠가 삭제 요청과 순서를 정한다.
create function private.guard_analysis_upload_object_write()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if old.bucket_id = 'analysis-uploads' or new.bucket_id = 'analysis-uploads' then
      raise exception 'analysis_upload_object_immutable' using errcode = '42501';
    end if;
  elsif new.bucket_id = 'analysis-uploads' then
    perform 1 from public.analysis_uploads
    where object_path = new.name and user_id::text = new.owner_id and status = 'registered'
    for share;
    if not found then
      raise exception 'analysis_upload_registration_required' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger guard_analysis_upload_object_write before insert or update on storage.objects
for each row execute function private.guard_analysis_upload_object_write();

revoke all on function private.guard_analysis_upload_cascade(), private.guard_analysis_upload_object_write()
from public, anon, authenticated, service_role;

-- 제한 정책은 다른 버킷 정책이 넓어져도 이 버킷에 필요한 동작만 허용한다.
create policy analysis_upload_objects on storage.objects
for all to authenticated using (bucket_id = 'analysis-uploads')
with check (bucket_id = 'analysis-uploads');

create policy analysis_upload_objects_block_anon on storage.objects as restrictive
for all to anon using (bucket_id <> 'analysis-uploads')
with check (bucket_id <> 'analysis-uploads');

create policy analysis_upload_objects_insert on storage.objects as restrictive
for insert to authenticated with check (
  bucket_id <> 'analysis-uploads'
  or (
    (select storage.allow_only_operation('object.upload'))
    and owner_id = (select auth.uid()::text)
    and exists (
      select 1 from public.analysis_uploads
      where object_path = objects.name and status = 'registered'
    )
  )
);

create policy analysis_upload_objects_select on storage.objects as restrictive
for select to authenticated using (
  bucket_id <> 'analysis-uploads'
  or (
    owner_id = (select auth.uid()::text)
    and exists (
      select 1 from public.analysis_uploads
      where object_path = objects.name and (
        (status = 'registered' and (select storage.allow_only_operation('object.get_authenticated')))
        or (status = 'deletion_requested' and (select storage.allow_only_operation('object.delete_many')))
      )
    )
  )
);

create policy analysis_upload_objects_delete on storage.objects as restrictive
for delete to authenticated using (
  bucket_id <> 'analysis-uploads'
  or (
    (select storage.allow_only_operation('object.delete_many'))
    and owner_id = (select auth.uid()::text)
    and exists (
      select 1 from public.analysis_uploads
      where object_path = objects.name and status = 'deletion_requested'
    )
  )
);

create policy analysis_upload_objects_block_update on storage.objects as restrictive
for update to authenticated using (bucket_id <> 'analysis-uploads')
with check (bucket_id <> 'analysis-uploads');
