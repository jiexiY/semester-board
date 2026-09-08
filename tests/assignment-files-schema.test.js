import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql = await readFile(new URL("../supabase/migrations/20260907203000_assignment_files.sql", import.meta.url), "utf8");

test("grade operations require an admin-created per-account entitlement", () => {
  assert.match(sql, /create table if not exists public\.account_features/iu);
  assert.match(sql, /grade_ops_enabled boolean not null default false/iu);
  assert.match(sql, /grant select on table public\.account_features to authenticated/iu);
  assert.doesNotMatch(sql, /grant (?:insert|update|delete)[^;]*account_features[^;]*authenticated/iu);
  assert.match(sql, /account_features_select_own[\s\S]*?auth\.uid\(\)\) = user_id/iu);
});

test("assignment metadata is private, owner-scoped, and entitlement-scoped", () => {
  assert.match(sql, /create table if not exists public\.assignment_files/iu);
  assert.match(sql, /alter table public\.assignment_files enable row level security/iu);
  assert.doesNotMatch(sql, /grant[^;]+assignment_files[^;]+to anon/iu);
  for (const action of ["select", "insert", "update", "delete"]) {
    const policy = sql.match(new RegExp(`create policy "assignment_files_${action}_own"[\\s\\S]*?;`, "iu"))?.[0] || "";
    assert.match(policy, /to authenticated/iu, action);
    assert.match(policy, /auth\.uid\(\)/iu, action);
    assert.match(policy, /account_features\.grade_ops_enabled = true/iu, action);
  }
});

test("assignment object storage is private and checks owner plus entitlement", () => {
  assert.match(sql, /'assignment-files',\s*'assignment-files',\s*false,\s*20971520/iu);
  for (const action of ["select", "insert", "update", "delete"]) {
    const policy = sql.match(new RegExp(`create policy "assignment_file_objects_${action}_own"[\\s\\S]*?;`, "iu"))?.[0] || "";
    assert.match(policy, /bucket_id = 'assignment-files'/iu, action);
    assert.match(policy, /storage\.foldername\(name\)/iu, action);
    assert.match(policy, /account_features\.grade_ops_enabled = true/iu, action);
  }
});
