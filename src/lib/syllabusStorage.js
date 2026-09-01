import { normalizeProfileId } from "./profileStorage.js";

export const MAX_SYLLABUS_FILE_BYTES = 20 * 1024 * 1024;

export const ACCEPTED_SYLLABUS_EXTENSIONS = Object.freeze([
  "pdf",
  "doc",
  "docx",
  "txt",
]);

const ACCEPTED_EXTENSION_SET = new Set(ACCEPTED_SYLLABUS_EXTENSIONS);
const DATABASE_NAME = "fall2026Quest:syllabi";
const DATABASE_VERSION = 2;
const STORE_NAME = "syllabi";

let databasePromise = null;

export class SyllabusValidationError extends Error {
  constructor(errors) {
    const normalizedErrors = Array.isArray(errors) ? errors : [];
    super(normalizedErrors.map((error) => error.message).join(" ") || "Invalid syllabus file.");
    this.name = "SyllabusValidationError";
    this.errors = normalizedErrors;
  }
}

export class SyllabusStorageError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "SyllabusStorageError";
  }
}

export function getSyllabusFileExtension(fileName) {
  const normalized = String(fileName ?? "").trim();
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === normalized.length - 1) return "";
  return normalized.slice(lastDot + 1).toLowerCase();
}

export function formatSyllabusType(fileOrName) {
  const fileName = typeof fileOrName === "string" ? fileOrName : fileOrName?.name;
  const extension = getSyllabusFileExtension(fileName);
  return ACCEPTED_EXTENSION_SET.has(extension) ? extension.toUpperCase() : "FILE";
}

export function formatFileSize(bytes) {
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
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

/**
 * Pure input validation for file-picker and drag/drop flows. File extensions
 * are authoritative because browser MIME values for local Office documents
 * are inconsistent across operating systems.
 */
export function validateSyllabusInput({ file, courseName } = {}) {
  const errors = [];
  const normalizedCourseName = typeof courseName === "string" ? courseName.trim() : "";
  const fileExists = Boolean(file) && typeof file === "object";
  const fileName = fileExists && typeof file.name === "string" ? file.name.trim() : "";
  const extension = getSyllabusFileExtension(fileName);
  const size = fileExists ? Number(file.size) : Number.NaN;

  if (!normalizedCourseName) {
    errors.push({
      field: "courseName",
      code: "course_name_required",
      message: "Course name is required.",
    });
  }

  if (!fileExists) {
    errors.push({
      field: "file",
      code: "file_required",
      message: "Choose a syllabus file.",
    });
  } else {
    if (!fileName) {
      errors.push({
        field: "file",
        code: "file_name_required",
        message: "The syllabus file must have a name.",
      });
    } else if (!ACCEPTED_EXTENSION_SET.has(extension)) {
      errors.push({
        field: "file",
        code: "unsupported_file_type",
        message: "Use a PDF, DOC, DOCX, or TXT file.",
      });
    }

    if (!Number.isFinite(size) || size < 0) {
      errors.push({
        field: "file",
        code: "invalid_file_size",
        message: "The syllabus file size is invalid.",
      });
    } else if (size > MAX_SYLLABUS_FILE_BYTES) {
      errors.push({
        field: "file",
        code: "file_too_large",
        message: "The syllabus file must be 20 MiB or smaller.",
      });
    }
  }

  const valid = errors.length === 0;
  return {
    valid,
    errors,
    value: valid ? {
      file,
      courseName: normalizedCourseName,
      fileName,
      extension,
      mimeType: typeof file.type === "string" ? file.type : "",
      size,
      lastModified: Number.isFinite(Number(file.lastModified)) ? Number(file.lastModified) : null,
    } : null,
  };
}

export function formatSyllabusRecord(record = {}) {
  const fileName = record.fileName ?? record.blob?.name ?? "Untitled syllabus";
  const extension = record.extension || getSyllabusFileExtension(fileName);
  const size = Number.isFinite(Number(record.size))
    ? Number(record.size)
    : (Number.isFinite(Number(record.blob?.size)) ? Number(record.blob.size) : 0);

  return {
    ...record,
    courseName: String(record.courseName ?? "").trim(),
    fileName,
    extension,
    typeLabel: ACCEPTED_EXTENSION_SET.has(extension) ? extension.toUpperCase() : "FILE",
    size,
    sizeLabel: formatFileSize(size),
  };
}

function createRecordId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `syllabus-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function indexedDbApi() {
  const api = globalThis.indexedDB;
  if (!api || typeof api.open !== "function") {
    throw new SyllabusStorageError(
      "Syllabus storage is unavailable in this browser. Files were not saved.",
    );
  }
  return api;
}

function requestResult(request, action) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new SyllabusStorageError(
      `Could not ${action} in browser storage.`,
      request.error,
    ));
  });
}

function transactionDone(transaction, action) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new SyllabusStorageError(
      `Could not ${action} in browser storage.`,
      transaction.error,
    ));
    transaction.onabort = () => reject(new SyllabusStorageError(
      `Could not ${action} in browser storage.`,
      transaction.error,
    ));
  });
}

function openDatabase() {
  if (databasePromise) return databasePromise;

  const pending = new Promise((resolve, reject) => {
    let request;
    let blocked = false;
    try {
      request = indexedDbApi().open(DATABASE_NAME, DATABASE_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!store.indexNames.contains("addedAt")) {
        store.createIndex("addedAt", "addedAt", { unique: false });
      }
      if (!store.indexNames.contains("courseName")) {
        store.createIndex("courseName", "courseName", { unique: false });
      }
      if (!store.indexNames.contains("profileId")) {
        store.createIndex("profileId", "profileId", { unique: false });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) {
        database.close();
        return;
      }
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      reject(new SyllabusStorageError(
        "Could not open syllabus storage in this browser.",
        request.error,
      ));
    };
    request.onblocked = () => {
      blocked = true;
      reject(new SyllabusStorageError(
        "Syllabus storage is blocked by another open version of this app.",
      ));
    };
  });

  databasePromise = pending.catch((error) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

/** Assigns unowned pre-profile records to the first local profile, in place. */
export async function claimLegacySyllabi(profileId) {
  const normalizedProfileId = normalizeProfileId(profileId);
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const completed = transactionDone(transaction, "claim legacy syllabi");
  const store = transaction.objectStore(STORE_NAME);

  const claimed = await new Promise((resolve, reject) => {
    let claimedCount = 0;
    const request = store.openCursor();

    request.onerror = () => reject(new SyllabusStorageError(
      "Could not claim legacy syllabi in browser storage.",
      request.error,
    ));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(claimedCount);
        return;
      }

      const record = cursor.value;
      const recordProfileId = typeof record?.profileId === "string"
        ? record.profileId.trim()
        : "";
      if (recordProfileId) {
        cursor.continue();
        return;
      }

      const updateRequest = cursor.update({ ...record, profileId: normalizedProfileId });
      updateRequest.onerror = () => reject(new SyllabusStorageError(
        "Could not claim legacy syllabi in browser storage.",
        updateRequest.error,
      ));
      updateRequest.onsuccess = () => {
        claimedCount += 1;
        cursor.continue();
      };
    };
  });

  await completed;
  return { claimed };
}

/** Lists locally stored syllabus records for one profile, newest first. */
export async function listSyllabi(profileId) {
  const normalizedProfileId = normalizeProfileId(profileId);
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const completed = transactionDone(transaction, "read syllabi");
  const profileIndex = transaction.objectStore(STORE_NAME).index("profileId");
  const [records] = await Promise.all([
    requestResult(profileIndex.getAll(normalizedProfileId), "read syllabi"),
    completed,
  ]);

  return records
    .map(formatSyllabusRecord)
    .sort((left, right) => String(right.addedAt ?? "").localeCompare(String(left.addedAt ?? "")));
}

/** Adds a syllabus and its actual File/Blob to browser-local IndexedDB. */
export async function addSyllabus(input, profileId) {
  const validation = validateSyllabusInput(input);
  if (!validation.valid) throw new SyllabusValidationError(validation.errors);
  const normalizedProfileId = normalizeProfileId(profileId);

  const { file, courseName, fileName, extension, mimeType, size, lastModified } = validation.value;
  const record = {
    id: createRecordId(),
    profileId: normalizedProfileId,
    courseName,
    fileName,
    extension,
    mimeType,
    size,
    lastModified,
    addedAt: new Date().toISOString(),
    blob: file,
  };

  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const completed = transactionDone(transaction, "save the syllabus");
  await Promise.all([
    requestResult(transaction.objectStore(STORE_NAME).add(record), "save the syllabus"),
    completed,
  ]);
  return formatSyllabusRecord(record);
}

/** Deletes one profile-owned syllabus record and its Blob. */
export async function deleteSyllabus(id, profileId) {
  const normalizedId = String(id ?? "").trim();
  if (!normalizedId) throw new TypeError("A syllabus id is required.");
  const normalizedProfileId = normalizeProfileId(profileId);

  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const completed = transactionDone(transaction, "delete the syllabus");
  const store = transaction.objectStore(STORE_NAME);
  const record = await requestResult(store.get(normalizedId), "read the syllabus");
  if (!record || record.profileId !== normalizedProfileId) {
    await completed;
    return false;
  }

  await requestResult(store.delete(normalizedId), "delete the syllabus");
  await completed;
  return true;
}
