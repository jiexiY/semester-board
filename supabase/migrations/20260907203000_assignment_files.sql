-- Private per-assignment working documents. Public clients use the publishable
-- key; both metadata rows and Storage objects are restricted to their owner.

create table if not exists public.account_features (
  user_id uuid primary key references auth.users(id) on delete cascade,
  grade_ops_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.account_features enable row level security;
revoke all on table public.account_features from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select on table public.account_features to authenticated;

drop policy if exists "account_features_select_own" on public.account_features;
create policy "account_features_select_own"
on public.account_features for select to authenticated
using ((select auth.uid()) = user_id);

create table if not exists public.assignment_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  assignment_id text not null check (char_length(assignment_id) between 1 and 160),
  course_id text not null check (char_length(course_id) between 1 and 160),
  file_name text not null check (char_length(file_name) between 1 and 255),
  storage_path text not null unique,
  mime_type text,
  size_bytes bigint not null check (size_bytes between 0 and 20971520),
  document_kind text not null default 'working-draft'
    check (document_kind in ('working-draft', 'study-support', 'reference', 'ready-for-review')),
  created_at timestamptz not null default now(),
  check (starts_with(storage_path, user_id::text || '/')),
  check (lower(storage_path) ~ '\.(pdf|doc|docx|txt)$')
);

create index if not exists assignment_files_owner_assignment_created_idx
  on public.assignment_files (user_id, assignment_id, created_at desc);

alter table public.assignment_files enable row level security;

revoke all on table public.assignment_files from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.assignment_files to authenticated;

drop policy if exists "assignment_files_select_own" on public.assignment_files;
create policy "assignment_files_select_own"
on public.assignment_files for select to authenticated
using (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.account_features
    where account_features.user_id = (select auth.uid())
      and account_features.grade_ops_enabled = true
  )
);

drop policy if exists "assignment_files_insert_own" on public.assignment_files;
create policy "assignment_files_insert_own"
on public.assignment_files for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.account_features
    where account_features.user_id = (select auth.uid())
      and account_features.grade_ops_enabled = true
  )
);

drop policy if exists "assignment_files_update_own" on public.assignment_files;
create policy "assignment_files_update_own"
on public.assignment_files for update to authenticated
using (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.account_features
    where account_features.user_id = (select auth.uid())
      and account_features.grade_ops_enabled = true
  )
)
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.account_features
    where account_features.user_id = (select auth.uid())
      and account_features.grade_ops_enabled = true
  )
);

drop policy if exists "assignment_files_delete_own" on public.assignment_files;
create policy "assignment_files_delete_own"
on public.assignment_files for delete to authenticated
using (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.account_features
    where account_features.user_id = (select auth.uid())
      and account_features.grade_ops_enabled = true
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'assignment-files',
  'assignment-files',
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

drop policy if exists "assignment_file_objects_select_own" on storage.objects;
create policy "assignment_file_objects_select_own"
on storage.objects for select to authenticated
using (
  bucket_id = 'assignment-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and owner_id = (select auth.uid())::text
  and exists (
    select 1 from public.account_features
    where account_features.user_id = (select auth.uid())
      and account_features.grade_ops_enabled = true
  )
);

drop policy if exists "assignment_file_objects_insert_own" on storage.objects;
create policy "assignment_file_objects_insert_own"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'assignment-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1 from public.account_features
    where account_features.user_id = (select auth.uid())
      and account_features.grade_ops_enabled = true
  )
);

drop policy if exists "assignment_file_objects_update_own" on storage.objects;
create policy "assignment_file_objects_update_own"
on storage.objects for update to authenticated
using (
  bucket_id = 'assignment-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and owner_id = (select auth.uid())::text
  and exists (
    select 1 from public.account_features
    where account_features.user_id = (select auth.uid())
      and account_features.grade_ops_enabled = true
  )
)
with check (
  bucket_id = 'assignment-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1 from public.account_features
    where account_features.user_id = (select auth.uid())
      and account_features.grade_ops_enabled = true
  )
);

drop policy if exists "assignment_file_objects_delete_own" on storage.objects;
create policy "assignment_file_objects_delete_own"
on storage.objects for delete to authenticated
using (
  bucket_id = 'assignment-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and owner_id = (select auth.uid())::text
  and exists (
    select 1 from public.account_features
    where account_features.user_id = (select auth.uid())
      and account_features.grade_ops_enabled = true
  )
);
