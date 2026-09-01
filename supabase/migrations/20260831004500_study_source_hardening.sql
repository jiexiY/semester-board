-- Tighten course/path integrity and make device-to-cloud source migration
-- idempotent. This follows the initial study_source_files migration so an old
-- client can continue to ignore the new nullable source_local_id column.

alter table public.study_source_files
  drop constraint if exists study_source_files_check;

alter table public.study_source_files
  drop constraint if exists study_source_files_storage_path_owner_course_check;

alter table public.study_source_files
  add constraint study_source_files_storage_path_owner_course_check
  check (starts_with(storage_path, user_id::text || '/' || course_space_id || '/'));

alter table public.study_source_files
  add column if not exists source_local_id text;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.study_source_files'::regclass
      and conname = 'study_source_files_source_local_id_length_check'
  ) then
    alter table public.study_source_files
      add constraint study_source_files_source_local_id_length_check
      check (
        source_local_id is null
        or char_length(source_local_id) between 1 and 300
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.study_source_files'::regclass
      and conname = 'study_source_files_owner_source_local_id_key'
  ) then
    alter table public.study_source_files
      add constraint study_source_files_owner_source_local_id_key
      unique (user_id, source_local_id);
  end if;
end;
$$;
