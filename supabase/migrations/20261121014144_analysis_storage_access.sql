-- Supabase Storage의 인증된 본문·메타데이터 조회에 같은 소유권 조건을 적용한다.
-- https://supabase.com/docs/guides/storage/security/access-control
alter policy analysis_upload_objects_select on storage.objects using (
  bucket_id <> 'analysis-uploads'
  or (
    owner_id = (select auth.uid()::text)
    and exists (
      select 1 from public.analysis_uploads
      where object_path = objects.name and (
        (
          status = 'registered' and (select
            storage.allow_only_operation('object.get_authenticated')
            or storage.allow_only_operation('object.get_authenticated_info')
          )
        )
        or (status = 'deletion_requested' and (select storage.allow_only_operation('object.delete_many')))
      )
    )
  )
);

-- 한 분석을 다시 열거나 정리할 때 소유자와 분석으로 자식 행을 찾는다.
create index analysis_input_snapshots_analysis_owner_created_idx
  on public.analysis_input_snapshots(analysis_id, user_id, created_at desc);
create index analysis_uploads_analysis_owner_idx
  on public.analysis_uploads(analysis_id, user_id);
