// SQL 제약과 RLS를 검사하는 메모리 DB다. Auth와 Storage HTTP 서비스는 사용하지 않는다.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';

const migrations = new URL('../../../supabase/migrations/', import.meta.url);

export async function createBe03Db() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as
        $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;

      create schema storage;
      create table storage.buckets (
        id text primary key,
        name text not null unique,
        public boolean default false,
        file_size_limit bigint,
        allowed_mime_types text[]
      );
      create table storage.objects (
        id uuid primary key default gen_random_uuid(),
        bucket_id text not null references storage.buckets(id),
        name text not null,
        owner uuid,
        owner_id text,
        metadata jsonb,
        unique (bucket_id, name)
      );
      create function storage.foldername(name text) returns text[] language sql immutable as $$
        select parts[1:cardinality(parts) - 1] from (select string_to_array(name, '/') as parts) as path
      $$;
      create function storage.allow_only_operation(expected_operation text) returns boolean language sql stable as $$
        select coalesce(
          regexp_replace(nullif(current_setting('storage.operation', true), ''), '^storage[.]', '') =
          regexp_replace(expected_operation, '^storage[.]', ''), false)
      $$;
      alter table storage.buckets enable row level security;
      alter table storage.objects enable row level security;
      grant usage on schema auth, public, storage to anon, authenticated, service_role;
      grant select, insert, update, delete on storage.buckets, storage.objects to anon, authenticated;
      grant all on storage.buckets, storage.objects to service_role;
    `);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(await readFile(new URL(file, migrations), 'utf8'));
    }
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
