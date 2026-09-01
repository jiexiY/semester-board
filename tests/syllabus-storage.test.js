import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCEPTED_SYLLABUS_EXTENSIONS,
  MAX_SYLLABUS_FILE_BYTES,
  formatFileSize,
  formatSyllabusRecord,
  formatSyllabusType,
  getSyllabusFileExtension,
  validateSyllabusInput,
} from "../src/lib/syllabusStorage.js";

function file(name, size = 1024, type = "") {
  return { name, size, type, lastModified: 1_787_616_000_000 };
}

test("syllabus file extensions are normalized and limited to the supported set", () => {
  assert.deepEqual(ACCEPTED_SYLLABUS_EXTENSIONS, ["pdf", "doc", "docx", "txt"]);
  assert.equal(getSyllabusFileExtension("Course.SYLLABUS.PDF"), "pdf");
  assert.equal(getSyllabusFileExtension("notes.docx"), "docx");
  assert.equal(getSyllabusFileExtension("no-extension"), "");
  assert.equal(getSyllabusFileExtension("trailing."), "");
  assert.equal(formatSyllabusType("outline.DOC"), "DOC");
  assert.equal(formatSyllabusType("outline.pages"), "FILE");
});

test("validation accepts PDF, DOC, DOCX, and TXT files and trims the course name", () => {
  for (const extension of ACCEPTED_SYLLABUS_EXTENSIONS) {
    const result = validateSyllabusInput({
      file: file(`syllabus.${extension}`, 4096),
      courseName: "  BIO 1010  ",
    });

    assert.equal(result.valid, true, extension);
    assert.deepEqual(result.errors, []);
    assert.equal(result.value.courseName, "BIO 1010");
    assert.equal(result.value.extension, extension);
    assert.equal(result.value.size, 4096);
  }
});

test("the exact 20 MiB boundary is accepted and larger files are rejected", () => {
  assert.equal(MAX_SYLLABUS_FILE_BYTES, 20 * 1024 * 1024);
  assert.equal(validateSyllabusInput({
    file: file("boundary.pdf", MAX_SYLLABUS_FILE_BYTES),
    courseName: "HIS 2100",
  }).valid, true);

  const tooLarge = validateSyllabusInput({
    file: file("too-large.pdf", MAX_SYLLABUS_FILE_BYTES + 1),
    courseName: "HIS 2100",
  });
  assert.equal(tooLarge.valid, false);
  assert.deepEqual(tooLarge.errors.map((error) => error.code), ["file_too_large"]);
});

test("validation reports missing course, missing file, and unsupported types independently", () => {
  const missing = validateSyllabusInput({ courseName: "   " });
  assert.deepEqual(missing.errors.map((error) => error.code), [
    "course_name_required",
    "file_required",
  ]);

  const unsupported = validateSyllabusInput({
    file: file("slides.pptx"),
    courseName: "MAT 1100",
  });
  assert.equal(unsupported.valid, false);
  assert.deepEqual(unsupported.errors.map((error) => error.code), ["unsupported_file_type"]);

  const invalidSize = validateSyllabusInput({
    file: file("notes.txt", Number.NaN),
    courseName: "CHE 1200",
  });
  assert.deepEqual(invalidSize.errors.map((error) => error.code), ["invalid_file_size"]);
});

test("formatFileSize uses binary units without overstating file precision", () => {
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(900), "900 B");
  assert.equal(formatFileSize(1536), "1.5 KiB");
  assert.equal(formatFileSize(2 * 1024 * 1024), "2 MiB");
  assert.equal(formatFileSize(Number.NaN), "0 B");
});

test("formatSyllabusRecord derives stable display metadata without removing the blob", () => {
  const blob = file("source.DOCX", 1.5 * 1024 * 1024, "application/octet-stream");
  const formatted = formatSyllabusRecord({
    id: "record-1",
    courseName: "  Writing  ",
    blob,
    addedAt: "2026-08-25T12:00:00.000Z",
  });

  assert.equal(formatted.courseName, "Writing");
  assert.equal(formatted.fileName, "source.DOCX");
  assert.equal(formatted.extension, "docx");
  assert.equal(formatted.typeLabel, "DOCX");
  assert.equal(formatted.size, 1.5 * 1024 * 1024);
  assert.equal(formatted.sizeLabel, "1.5 MiB");
  assert.equal(formatted.blob, blob);
});
