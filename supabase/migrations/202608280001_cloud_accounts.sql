-- Semester Board cloud accounts. Browser clients use only the Supabase
-- publishable key; every exposed row is additionally restricted by auth.uid().

create table if not exists public.account_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  migration_status text not null default 'pending'
    check (migration_status in ('pending', 'imported', 'skipped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.account_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  resource text not null
    check (resource in ('dashboard:v1', 'assistant:v2', 'cloudChat:v1')),
  payload jsonb not null
    check (jsonb_typeof(payload) in ('object', 'array'))
    check (octet_length(payload::text) <= 1000000),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, resource)
);

-- Required for the user_id-filtered Realtime subscription to receive DELETE
-- events. With RLS enabled, Supabase still exposes only primary-key fields.
alter table public.account_state replica identity full;

create table if not exists public.syllabus_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_name text not null check (char_length(course_name) between 1 and 120),
  file_name text not null check (char_length(file_name) between 1 and 255),
  storage_path text not null unique,
  mime_type text,
  size_bytes bigint not null check (size_bytes between 0 and 20971520),
  source_local_id text,
  created_at timestamptz not null default now(),
  unique (user_id, source_local_id),
  check (storage_path like user_id::text || '/%')
);

create index if not exists syllabus_files_user_created_idx
  on public.syllabus_files (user_id, created_at desc);

create or replace function public.set_semester_board_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.bump_semester_board_state_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.revision = old.revision + 1;
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.create_semester_board_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_name text;
begin
  requested_name := left(trim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 40);
  if requested_name = '' then
    requested_name := left(split_part(coalesce(new.email, 'Student'), '@', 1), 40);
  end if;
  if requested_name = '' then requested_name := 'Student'; end if;

  insert into public.account_profiles (user_id, display_name)
  values (new.id, requested_name)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists account_profiles_set_updated_at on public.account_profiles;
create trigger account_profiles_set_updated_at
before update on public.account_profiles
for each row execute function public.set_semester_board_updated_at();

drop trigger if exists account_state_bump_revision on public.account_state;
create trigger account_state_bump_revision
before update on public.account_state
for each row execute function public.bump_semester_board_state_revision();

drop trigger if exists create_semester_board_profile_after_signup on auth.users;
create trigger create_semester_board_profile_after_signup
after insert on auth.users
for each row execute function public.create_semester_board_profile();

revoke all on function public.set_semester_board_updated_at() from public, anon, authenticated;
revoke all on function public.bump_semester_board_state_revision() from public, anon, authenticated;
revoke all on function public.create_semester_board_profile() from public, anon, authenticated;

alter table public.account_profiles enable row level security;
alter table public.account_state enable row level security;
alter table public.syllabus_files enable row level security;

drop policy if exists "account_profiles_select_own" on public.account_profiles;
create policy "account_profiles_select_own"
on public.account_profiles for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "account_profiles_insert_own" on public.account_profiles;
create policy "account_profiles_insert_own"
on public.account_profiles for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "account_profiles_update_own" on public.account_profiles;
create policy "account_profiles_update_own"
on public.account_profiles for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "account_profiles_delete_own" on public.account_profiles;

drop policy if exists "account_state_select_own" on public.account_state;
create policy "account_state_select_own"
on public.account_state for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "account_state_insert_own" on public.account_state;
create policy "account_state_insert_own"
on public.account_state for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "account_state_update_own" on public.account_state;
create policy "account_state_update_own"
on public.account_state for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "account_state_delete_own" on public.account_state;

drop policy if exists "syllabus_files_select_own" on public.syllabus_files;
create policy "syllabus_files_select_own"
on public.syllabus_files for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "syllabus_files_insert_own" on public.syllabus_files;
create policy "syllabus_files_insert_own"
on public.syllabus_files for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "syllabus_files_update_own" on public.syllabus_files;
create policy "syllabus_files_update_own"
on public.syllabus_files for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "syllabus_files_delete_own" on public.syllabus_files;
create policy "syllabus_files_delete_own"
on public.syllabus_files for delete to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.account_profiles from public, anon, authenticated;
revoke all on table public.account_state from public, anon, authenticated;
revoke all on table public.syllabus_files from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select, insert, update on table public.account_profiles to authenticated;
grant select, insert, update on table public.account_state to authenticated;
grant select, insert, update, delete on table public.syllabus_files to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'syllabi',
  'syllabi',
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

drop policy if exists "syllabi_objects_select_own" on storage.objects;
create policy "syllabi_objects_select_own"
on storage.objects for select to authenticated
using (
  bucket_id = 'syllabi'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "syllabi_objects_insert_own" on storage.objects;
create policy "syllabi_objects_insert_own"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'syllabi'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "syllabi_objects_update_own" on storage.objects;
create policy "syllabi_objects_update_own"
on storage.objects for update to authenticated
using (
  bucket_id = 'syllabi'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'syllabi'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "syllabi_objects_delete_own" on storage.objects;
create policy "syllabi_objects_delete_own"
on storage.objects for delete to authenticated
using (
  bucket_id = 'syllabi'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'account_state'
  ) then
    alter publication supabase_realtime add table public.account_state;
  end if;
end;
$$;
