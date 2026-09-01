import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_STUDY_SOURCE_FILE_BYTES,
  MAX_STUDY_SOURCE_FILE_NAME_LENGTH,
  STUDY_SOURCE_RECORD_KIND,
  deleteStudySource,
  filterStudySourceRecordsForIdentity,
  formatStudySourceRecord,
  isStudySourceRecord,
  validateStudySourceInput,
} from "../src/lib/studySourceStorage.js";
import {
  STUDY_SOURCE_DATABASE_NAME,
  STUDY_SOURCE_STORE_NAME,
} from "../src/lib/localStudySourceStorage.js";

const PROFILE_A = "profile_a_12345678";
const PROFILE_B = "profile_b_12345678";
const COURSE_A = "course_space_a_12345678";
const COURSE_B = "course_space_b_12345678";

function sourceFile(name = "reading.pdf", size = 1200) {
  return { lastModified: 0, name, size, type: "application/pdf" };
}

function sourceRecord(overrides = {}) {
  return {
    addedAt: "2026-08-30T20:00:00.000Z",
    courseCode: "MAT 1100",
    courseSpaceId: COURSE_A,
    fileName: "reading.pdf",
    id: "record_12345678",
    profileId: PROFILE_A,
    recordKind: STUDY_SOURCE_RECORD_KIND,
    size: 1200,
    ...overrides,
  };
}

test("local Study Deck sources use a dedicated IndexedDB database and store", () => {
  assert.equal(STUDY_SOURCE_DATABASE_NAME, "fall2026Quest:studySources");
  assert.equal(STUDY_SOURCE_STORE_NAME, "studySources");
  assert.doesNotMatch(STUDY_SOURCE_DATABASE_NAME, /syllab/iu);
  assert.doesNotMatch(STUDY_SOURCE_STORE_NAME, /syllab/iu);
});

test("Study Deck source validation requires an opaque course space and supported file", () => {
  const validation = validateStudySourceInput({
    courseCode: "  MAT   1100 ",
    courseSpaceId: COURSE_A,
    file: sourceFile(),
  });
  assert.equal(validation.valid, true);
  assert.equal(validation.value.courseCode, "MAT 1100");
  assert.equal(validation.value.courseSpaceId, COURSE_A);

  for (const badCourseSpaceId of ["", "MAT 1100", "../course-space", `${COURSE_A}/foreign`]) {
    const result = validateStudySourceInput({
      courseCode: "MAT 1100",
      courseSpaceId: badCourseSpaceId,
      file: sourceFile(),
    });
    assert.equal(result.valid, false, badCourseSpaceId);
    assert.ok(result.errors.some((error) => error.code === "course_space_id_required"));
  }
});

test("Study Deck source validation enforces type and 20 MiB size limits", () => {
  for (const [file, code] of [
    [sourceFile("malware.exe"), "unsupported_file_type"],
    [sourceFile("large.pdf", MAX_STUDY_SOURCE_FILE_BYTES + 1), "file_too_large"],
    [{ name: "invalid.pdf", size: Number.NaN, type: "application/pdf" }, "invalid_file_size"],
  ]) {
    const result = validateStudySourceInput({
      courseCode: "MAT 1100",
      courseSpaceId: COURSE_A,
      file,
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === code), code);
  }
});

test("Study Deck source validation rejects names the database cannot store", () => {
  const extension = ".pdf";
  const result = validateStudySourceInput({
    courseCode: "MAT 1100",
    courseSpaceId: COURSE_A,
    file: sourceFile(`${"a".repeat(MAX_STUDY_SOURCE_FILE_NAME_LENGTH - extension.length + 1)}${extension}`),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "file_name_too_long"));
});

test("dedicated Study Deck records cannot be confused with prefixed syllabus rows", () => {
  const storageRecord = sourceRecord({ cloud: true });
  assert.equal(isStudySourceRecord(storageRecord), true);
  assert.equal(isStudySourceRecord({
    courseName: "Study source · MAT 1100",
    fileName: "reading.pdf",
  }), false);
  assert.deepEqual(formatStudySourceRecord(storageRecord), {
    ...storageRecord,
    extension: "pdf",
    courseName: "MAT 1100",
    sizeLabel: "1.2 KiB",
    storageScope: "account",
    typeLabel: "PDF",
  });
});

test("non-source records cannot be formatted as Study Deck sources", () => {
  assert.equal(formatStudySourceRecord({
    courseCode: "CHE 1200",
    courseSpaceId: COURSE_A,
    fileName: "syllabus.pdf",
  }), null);
});

test("profile and course filtering never mixes source identities", () => {
  const records = [
    sourceRecord({ id: "record_a_12345678" }),
    sourceRecord({ courseSpaceId: COURSE_B, id: "record_b_12345678" }),
    sourceRecord({ id: "record_c_12345678", profileId: PROFILE_B }),
  ];
  const visible = filterStudySourceRecordsForIdentity(records, PROFILE_A, COURSE_A);
  assert.deepEqual(visible.map((record) => record.id), ["record_a_12345678"]);
});

test("source deletion refuses syllabi and cross-course source records before storage access", async () => {
  await assert.rejects(
    deleteStudySource({
      courseSpaceId: COURSE_A,
      profileId: PROFILE_A,
      record: { id: "syllabus_12345678", fileName: "syllabus.pdf" },
    }),
    /not a valid Study Deck source/,
  );
  await assert.rejects(
    deleteStudySource({
      courseSpaceId: COURSE_A,
      profileId: PROFILE_A,
      record: sourceRecord({ courseSpaceId: COURSE_B }),
    }),
    /different course space/,
  );
});
