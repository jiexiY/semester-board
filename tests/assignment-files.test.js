import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ASSIGNMENT_FILE_BUCKET, assignmentFilePath } from "../src/lib/assignmentFiles.js";

const USER = "11111111-1111-4111-8111-111111111111";

test("assignment file paths are owner-scoped and hide raw course and assignment identifiers", async () => {
  const path = await assignmentFilePath(USER, "private-course", "canvas:7654321", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "docx");
  assert.match(path, new RegExp(`^${USER}/[a-f0-9]{24}/[a-f0-9]{32}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/document\\.docx$`, "u"));
  assert.doesNotMatch(path, /private-course|7654321/u);
  assert.equal(ASSIGNMENT_FILE_BUCKET, "assignment-files");
});

test("assignment file paths reject traversal and unsupported file types", async () => {
  await assert.rejects(assignmentFilePath(USER, "course/../other", "assignment", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "docx"));
  await assert.rejects(assignmentFilePath(USER, "course", "assignment", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "exe"));
});

test("assignment upload UI and grade operations are account-entitlement gated", async () => {
  const page = await readFile(new URL("../src/components/AssignmentDeckPage.jsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(page, /gradeOpsEnabled\s*\?\s*<AcademicCoachPanel/u);
  assert.match(page, /files=\{gradeOpsEnabled\s*\?/u);
  assert.match(app, /enabled:\s*accountFeatures\.gradeOpsEnabled/u);
});

test("assignment uploads snapshot the FileList before clearing the picker", async () => {
  const page = await readFile(new URL("../src/components/AssignmentDeckPage.jsx", import.meta.url), "utf8");
  const snapshotIndex = page.indexOf("Array.from(event.target.files || [])");
  const clearIndex = page.indexOf('event.target.value = ""');
  assert.notEqual(snapshotIndex, -1);
  assert.ok(clearIndex > snapshotIndex);
});
