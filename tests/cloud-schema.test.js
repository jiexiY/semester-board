import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../supabase/migrations/202608280001_cloud_accounts.sql", import.meta.url);
const sql = await readFile(migrationUrl, "utf8");

test("every exposed account table enables RLS and receives explicit authenticated grants", () => {
  const grants = {
    account_profiles: "select, insert, update",
    account_state: "select, insert, update",
    syllabus_files: "select, insert, update, delete",
  };
  for (const [table, privileges] of Object.entries(grants)) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(sql, new RegExp(`grant ${privileges} on table public\\.${table} to authenticated`, "i"));
    assert.match(sql, new RegExp(
      `revoke all on table public\\.${table} from public, anon, authenticated`,
      "i",
    ));
  }
  for (const table of ["account_profiles", "account_state"]) {
    assert.match(sql, new RegExp(`drop policy if exists "${table}_delete_own"`, "i"));
    assert.doesNotMatch(sql, new RegExp(`create policy "${table}_delete_own"`, "i"));
  }
});

test("account state supports filtered Realtime delete detection", () => {
  assert.match(sql, /alter table public\.account_state replica identity full;/iu);
});

test("owner policies use auth.uid and updates require both USING and WITH CHECK", () => {
  for (const table of ["account_profiles", "account_state", "syllabus_files"]) {
    const updatePolicy = sql.match(new RegExp(
      `create policy "${table}_update_own"[\\s\\S]*?;`,
      "i",
    ))?.[0] || "";
    assert.match(updatePolicy, /to authenticated/i);
    assert.match(updatePolicy, /using \(\(select auth\.uid\(\)\) = user_id\)/i);
    assert.match(updatePolicy, /with check \(\(select auth\.uid\(\)\) = user_id\)/i);
  }
  assert.doesNotMatch(sql, /user_metadata[\s\S]{0,80}(?:using|with check)/i);
});

test("the syllabus bucket is private and all object operations are owner-prefix scoped", () => {
  const bucketUpsert = sql.match(
    /insert into storage\.buckets[\s\S]*?allowed_mime_types = excluded\.allowed_mime_types;/i,
  )?.[0] || "";
  assert.match(bucketUpsert, /values\s*\(\s*'syllabi',\s*'syllabi',\s*false,\s*20971520,\s*array\[\s*'application\/pdf',\s*'application\/msword',\s*'application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document',\s*'text\/plain',\s*'application\/octet-stream'\s*\]\s*\)/i);
  assert.match(bucketUpsert, /on conflict \(id\) do update/i);
  for (const column of ["name", "public", "file_size_limit", "allowed_mime_types"]) {
    assert.match(bucketUpsert, new RegExp(`${column} = excluded\\.${column}`, "i"));
  }
  assert.doesNotMatch(bucketUpsert, /on conflict \(id\) do nothing/i);
  for (const action of ["select", "insert", "update", "delete"]) {
    const policy = sql.match(new RegExp(
      `create policy "syllabi_objects_${action}_own"[\\s\\S]*?;`,
      "i",
    ))?.[0] || "";
    assert.match(policy, /bucket_id = 'syllabi'/i);
    assert.match(policy, /storage\.foldername\(name\)/i);
    assert.match(policy, /auth\.uid\(\)/i);
  }
});
