import { normalizeProfileId } from "./profileStorage.js";

export const STUDY_SOURCE_RECORD_KIND = "study-source";
export const MAX_STUDY_SOURCE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_STUDY_SOURCE_FILE_NAME_LENGTH = 255;
export const MAX_STUDY_SOURCE_UPLOAD_BATCH = 20;
export const STUDY_SOURCE_UPLOAD_CONCURRENCY = 4;
export const ACCEPTED_STUDY_SOURCE_EXTENSIONS = Object.freeze([
  "pdf",
  "doc",
  "docx",
  "txt",
]);

const ACCEPTED_EXTENSION_SET = new Set(ACCEPTED_STUDY_SOURCE_EXTENSIONS);
const COURSE_SPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;

export class StudySourceValidationError extends Error {
  constructor(errors) {
    const normalizedErrors = Array.isArray(errors) ? errors : [];
    super(normalizedErrors.map((error) => error.message).join(" ") || "Invalid Study Deck source.");
    this.name = "StudySourceValidationError";
    this.errors = normalizedErrors;
  }
}

export class StudySourceStorageError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "StudySourceStorageError";
  }
}

export function normalizeStudySourceProfileId(profileId) {
  return normalizeProfileId(profileId);
}

export function normalizeCourseSpaceId(courseSpaceId) {
  const normalized = String(courseSpaceId || "").trim();
  if (!COURSE_SPACE_ID_PATTERN.test(normalized)) {
    throw new TypeError("A valid Study Deck course space id is required.");
  }
  return normalized;
}

export function normalizeStudySourceCourseCode(courseCode) {
  const normalized = String(courseCode || "").trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > 80) {
    throw new TypeError("A Study Deck course display code between 1 and 80 characters is required.");
  }
  return normalized;
}

export function getStudySourceFileExtension(fileName) {
  const normalized = String(fileName ?? "").trim();
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === normalized.length - 1) return "";
  return normalized.slice(lastDot + 1).toLocaleLowerCase("en-US");
}

export function formatStudySourceFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1024) return `${Math.round(size)} B`;

  const units = ["KiB", "MiB", "GiB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${Math.round(value * 10) / 10} ${units[unitIndex]}`;
}

export function validateStudySourceInput({ courseCode, courseSpaceId, file } = {}) {
  const errors = [];
  let normalizedCourseSpaceId = "";
  let normalizedCourseCode = "";

  try {
    normalizedCourseSpaceId = normalizeCourseSpaceId(courseSpaceId);
  } catch {
    errors.push({
      code: "course_space_id_required",
      field: "courseSpaceId",
      message: "Choose a valid course space before adding sources.",
    });
  }

  try {
    normalizedCourseCode = normalizeStudySourceCourseCode(courseCode);
  } catch {
    errors.push({
      code: "course_code_required",
      field: "courseCode",
      message: "A course display code is required.",
    });
  }

  const fileExists = Boolean(file) && typeof file === "object";
  const fileName = fileExists && typeof file.name === "string" ? file.name.trim() : "";
  const extension = getStudySourceFileExtension(fileName);
  const size = fileExists ? Number(file.size) : Number.NaN;

  if (!fileExists) {
    errors.push({ code: "file_required", field: "file", message: "Choose a source file." });
  } else {
    if (!fileName) {
      errors.push({
        code: "file_name_required",
        field: "file",
        message: "The source file must have a name.",
      });
    } else if (fileName.length > MAX_STUDY_SOURCE_FILE_NAME_LENGTH) {
      errors.push({
        code: "file_name_too_long",
        field: "file",
        message: "The source file name must be 255 characters or fewer.",
      });
    } else if (!ACCEPTED_EXTENSION_SET.has(extension)) {
      errors.push({
        code: "unsupported_file_type",
        field: "file",
        message: "Use a PDF, DOC, DOCX, or TXT source file.",
      });
    }

    if (!Number.isFinite(size) || size < 0) {
      errors.push({
        code: "invalid_file_size",
        field: "file",
        message: "The source file size is invalid.",
      });
    } else if (size > MAX_STUDY_SOURCE_FILE_BYTES) {
      errors.push({
        code: "file_too_large",
        field: "file",
        message: "The source file must be 20 MiB or smaller.",
      });
    }
  }

  const valid = errors.length === 0;
  return {
    errors,
    valid,
    value: valid ? {
      courseCode: normalizedCourseCode,
      courseSpaceId: normalizedCourseSpaceId,
      extension,
      file,
      fileName,
      lastModified: Number.isFinite(Number(file.lastModified)) ? Number(file.lastModified) : null,
      mimeType: typeof file.type === "string" ? file.type : "",
      size,
    } : null,
  };
}

export function isStudySourceRecord(record) {
  return record?.recordKind === STUDY_SOURCE_RECORD_KIND
    && typeof record?.courseSpaceId === "string"
    && COURSE_SPACE_ID_PATTERN.test(record.courseSpaceId);
}

export function formatStudySourceRecord(record = {}) {
  if (record.recordKind !== STUDY_SOURCE_RECORD_KIND) return null;

  let courseSpaceId;
  let courseCode;
  try {
    courseSpaceId = normalizeCourseSpaceId(record.courseSpaceId);
    courseCode = normalizeStudySourceCourseCode(record.courseCode);
  } catch {
    return null;
  }

  const fileName = String(record.fileName ?? record.blob?.name ?? "Untitled source").trim()
    || "Untitled source";
  const extension = record.extension || getStudySourceFileExtension(fileName);
  const size = Number.isFinite(Number(record.size))
    ? Number(record.size)
    : (Number.isFinite(Number(record.blob?.size)) ? Number(record.blob.size) : 0);

  return {
    ...record,
    courseCode,
    courseName: courseCode,
    courseSpaceId,
    extension,
    fileName,
    recordKind: STUDY_SOURCE_RECORD_KIND,
    size,
    sizeLabel: formatStudySourceFileSize(size),
    storageScope: record.cloud ? "account" : "device",
    typeLabel: ACCEPTED_EXTENSION_SET.has(extension) ? extension.toUpperCase() : "FILE",
  };
}

export function recordBelongsToStudySourceIdentity(record, profileId, courseSpaceId) {
  let owner;
  let space;
  try {
    owner = normalizeStudySourceProfileId(profileId);
    space = normalizeCourseSpaceId(courseSpaceId);
  } catch {
    return false;
  }
  return isStudySourceRecord(record)
    && record.profileId === owner
    && record.courseSpaceId === space;
}

export function filterStudySourceRecordsForIdentity(records, profileId, courseSpaceId) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => recordBelongsToStudySourceIdentity(record, profileId, courseSpaceId))
    .map(formatStudySourceRecord)
    .filter(Boolean);
}
