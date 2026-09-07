import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const component = await readFile(new URL("../src/components/SemesterSetup.jsx", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const chatApi = await readFile(new URL("../api/chat.post.js", import.meta.url), "utf8");

test("blank semester setup imports structured data without AI generation", () => {
  assert.match(component, /accept="application\/json,\.json"/);
  assert.match(component, /Choose semester data file/);
  assert.match(component, /This setup does not use AI\./);
  assert.match(component, /onOpenDocuments/);
  assert.doesNotMatch(component, /Generate semester draft|grantConsent|useSemesterGenerator/);
  assert.match(app, /onImportBackup=\{safeImport\}/);
  assert.match(app, /onOpenDocuments=\{\(\) => changePage\("syllabi"\)\}/);
  assert.doesNotMatch(app, /useSemesterGenerator|saveSemester/);
  assert.doesNotMatch(chatApi, /semester-generation|SEMESTER_GENERATION_INSTRUCTIONS/);
});
