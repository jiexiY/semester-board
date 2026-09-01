-- Study Deck source files are deliberately separate from syllabus_files.
-- Browser clients use the publishable key; table rows and storage objects are
-- both restricted to the authenticated owner's UUID path prefix.

create table if not exists public.study_source_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_space_id text not null
    check (char_length(course_space_id) between 8 and 128)
    check (course_space_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'),
  course_code text not null check (char_length(course_code) between 1 and 80),
  file_name text not null check (char_length(file_name) between 1 and 255),
  storage_path text not null unique,
  mime_type text,
  size_bytes bigint not null check (size_bytes between 0 and 20971520),
  created_at timestamptz not null default now(),
  check (storage_path like user_id::text || '/' || course_space_id || '/%'),
  check (lower(storage_path) ~ '\.(pdf|doc|docx|txt)$')
);

create index if not exists study_source_files_owner_course_created_idx
  on public.study_source_files (user_id, course_space_id, created_at desc);

alter table public.study_source_files enable row level security;

drop policy if exists "study_source_files_select_own" on public.study_source_files;
create policy "study_source_files_select_own"
on public.study_source_files for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "study_source_files_insert_own" on public.study_source_files;
create policy "study_source_files_insert_own"
on public.study_source_files for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "study_source_files_update_own" on public.study_source_files;
create policy "study_source_files_update_own"
on public.study_source_files for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "study_source_files_delete_own" on public.study_source_files;
create policy "study_source_files_delete_own"
on public.study_source_files for delete to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.study_source_files from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.study_source_files to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'study-sources',
  'study-sources',
  false,
  20971520,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'application/octet-stream'
  ]
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "study_sources_objects_select_own" on storage.objects;
create policy "study_sources_objects_select_own"
on storage.objects for select to authenticated
using (
  bucket_id = 'study-sources'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'
);

drop policy if exists "study_sources_objects_insert_own" on storage.objects;
create policy "study_sources_objects_insert_own"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'study-sources'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'
);

drop policy if exists "study_sources_objects_update_own" on storage.objects;
create policy "study_sources_objects_update_own"
on storage.objects for update to authenticated
using (
  bucket_id = 'study-sources'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'
)
with check (
  bucket_id = 'study-sources'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'
);

drop policy if exists "study_sources_objects_delete_own" on storage.objects;
create policy "study_sources_objects_delete_own"
on storage.objects for delete to authenticated
using (
  bucket_id = 'study-sources'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$'
);
