import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260831003009_study_source_files.sql",
  import.meta.url,
);
const sql = await readFile(migrationUrl, "utf8");
const hardeningSql = await readFile(new URL(
  "../supabase/migrations/20260831004500_study_source_hardening.sql",
  import.meta.url,
), "utf8");

test("study sources use a dedicated table with explicit course-space metadata", () => {
  assert.match(sql, /create table if not exists public\.study_source_files/iu);
  assert.match(sql, /course_space_id text not null/iu);
  assert.match(sql, /course_code text not null/iu);
  assert.match(sql, /size_bytes bigint not null check \(size_bytes between 0 and 20971520\)/iu);
  assert.match(sql, /storage_path like user_id::text \|\| '\/' \|\| course_space_id \|\| '\/%'/iu);
  assert.match(sql, /study_source_files_owner_course_created_idx[\s\S]*user_id, course_space_id, created_at desc/iu);
  assert.doesNotMatch(sql, /insert into public\.syllabus_files/iu);
});

test("study source table enables RLS and grants only authenticated CRUD", () => {
  assert.match(sql, /alter table public\.study_source_files enable row level security/iu);
  assert.match(sql, /revoke all on table public\.study_source_files from public, anon, authenticated/iu);
  assert.match(sql, /grant select, insert, update, delete on table public\.study_source_files to authenticated/iu);
  assert.doesNotMatch(sql, /grant[^;]+study_source_files[^;]+to anon/iu);

  for (const action of ["select", "insert", "update", "delete"]) {
    const policy = sql.match(new RegExp(
      `create policy "study_source_files_${action}_own"[\\s\\S]*?;`,
      "iu",
    ))?.[0] || "";
    assert.match(policy, /to authenticated/iu, action);
    assert.match(policy, /\(select auth\.uid\(\)\) = user_id/iu, action);
    if (action === "update") {
      assert.match(policy, /using/iu);
      assert.match(policy, /with check/iu);
    }
  }
});

test("study source bucket is private, limited, and owner-path scoped for every operation", () => {
  const bucket = sql.match(
    /insert into storage\.buckets[\s\S]*?allowed_mime_types = excluded\.allowed_mime_types;/iu,
  )?.[0] || "";
  assert.match(bucket, /'study-sources',\s*'study-sources',\s*false,\s*20971520/iu);
  for (const mime of [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "application/octet-stream",
  ]) assert.match(bucket, new RegExp(mime.replaceAll("/", "\\/"), "iu"));
  assert.match(bucket, /on conflict \(id\) do update/iu);

  for (const action of ["select", "insert", "update", "delete"]) {
    const policy = sql.match(new RegExp(
      `create policy "study_sources_objects_${action}_own"[\\s\\S]*?;`,
      "iu",
    ))?.[0] || "";
    assert.match(policy, /bucket_id = 'study-sources'/iu, action);
    assert.match(policy, /\(storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/iu, action);
    assert.match(policy, /\(storage\.foldername\(name\)\)\[2\]/iu, action);
  }
});

test("follow-up migration replaces wildcard path matching with an exact prefix check", () => {
  assert.match(hardeningSql, /drop constraint if exists study_source_files_check/iu);
  assert.match(
    hardeningSql,
    /check \(starts_with\(storage_path, user_id::text \|\| '\/' \|\| course_space_id \|\| '\/'\)\)/iu,
  );
  assert.doesNotMatch(hardeningSql, /storage_path like/iu);
  assert.match(sql, /check \(lower\(storage_path\) ~ '\\\.\(pdf\|doc\|docx\|txt\)\$'\)/iu);
});

test("follow-up migration adds a bounded per-account local migration identity", () => {
  assert.match(hardeningSql, /add column if not exists source_local_id text/iu);
  assert.match(hardeningSql, /char_length\(source_local_id\) between 1 and 300/iu);
  assert.match(hardeningSql, /unique \(user_id, source_local_id\)/iu);
});
