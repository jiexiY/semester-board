import { normalizeProfileId } from "./profileStorage.js";

export const ASSIGNMENT_FILE_BUCKET = "assignment-files";
export const ASSIGNMENT_FILE_RECORD_KIND = "assignment-file";
export const MAX_ASSIGNMENT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ASSIGNMENT_FILE_BATCH = 10;
export const ASSIGNMENT_FILE_ACCEPT = ".doc,.docx,.pdf,.txt,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,text/plain";

const ACCEPTED_EXTENSIONS = new Set(["doc", "docx", "pdf", "txt"]);
const DOCUMENT_KINDS = new Set(["working-draft", "study-support", "reference", "ready-for-review"]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const DATABASE_NAME = "fall2026Quest:assignmentFiles";
const STORE_NAME = "assignmentFiles";
const DATABASE_VERSION = 1;
const PROFILE_INDEX = "profileId";
const CLOUD_COLUMNS = "id, user_id, assignment_id, course_id, file_name, storage_path, mime_type, size_bytes, document_kind, created_at";

let databasePromise = null;

function normalizeIdentifier(value, label) {
  const normalized = String(value || "").trim();
  if (!IDENTIFIER_PATTERN.test(normalized)) throw new TypeError(`A valid ${label} is required.`);
  return normalized;
}

function extensionFor(fileName) {
  const normalized = String(fileName || "").trim();
  const dot = normalized.lastIndexOf(".");
  return dot > 0 ? normalized.slice(dot + 1).toLocaleLowerCase("en-US") : "";
}

export function formatAssignmentFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1024) return `${Math.round(size)} B`;
  const units = ["KiB", "MiB"];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${Math.round(value * 10) / 10} ${units[index]}`;
}

function validateInput({ assignmentId, courseId, documentKind = "working-draft", file } = {}) {
  const normalizedAssignmentId = normalizeIdentifier(assignmentId, "assignment id");
  const normalizedCourseId = normalizeIdentifier(courseId, "course id");
  const kind = DOCUMENT_KINDS.has(documentKind) ? documentKind : "working-draft";
  const fileName = String(file?.name || "").trim();
  const extension = extensionFor(fileName);
  const size = Number(file?.size);
  if (!file || !fileName) throw new TypeError("Choose a named assignment document.");
  if (fileName.length > 255) throw new TypeError("The assignment document name must be 255 characters or fewer.");
  if (!ACCEPTED_EXTENSIONS.has(extension)) throw new TypeError("Use a DOC, DOCX, PDF, or TXT assignment document.");
  if (!Number.isFinite(size) || size < 0 || size > MAX_ASSIGNMENT_FILE_BYTES) {
    throw new TypeError("The assignment document must be 20 MiB or smaller.");
  }
  return {
    assignmentId: normalizedAssignmentId,
    courseId: normalizedCourseId,
    documentKind: kind,
    extension,
    file,
    fileName,
    mimeType: typeof file.type === "string" ? file.type : "",
    size,
  };
}

function formatRecord(record) {
  if (!record || record.recordKind !== ASSIGNMENT_FILE_RECORD_KIND) return null;
  try {
    return {
      ...record,
      assignmentId: normalizeIdentifier(record.assignmentId, "assignment id"),
      courseId: normalizeIdentifier(record.courseId, "course id"),
      documentKind: DOCUMENT_KINDS.has(record.documentKind) ? record.documentKind : "working-draft",
      size: Number(record.size) || 0,
      sizeLabel: formatAssignmentFileSize(record.size),
      storageScope: record.cloud ? "account" : "device",
      typeLabel: extensionFor(record.fileName).toUpperCase() || "FILE",
    };
  } catch {
    return null;
  }
}

function createRecordId() {
  return globalThis.crypto?.randomUUID?.() || `assignment_file_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB?.open) {
      reject(new Error("Assignment document storage is unavailable in this browser."));
      return;
    }
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!store.indexNames.contains(PROFILE_INDEX)) store.createIndex(PROFILE_INDEX, PROFILE_INDEX, { unique: false });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        databasePromise = null;
      };
      resolve(request.result);
    };
    request.onerror = () => reject(new Error("Assignment document storage could not be opened."));
    request.onblocked = () => reject(new Error("Close other Semester Board tabs, then retry the assignment upload."));
  }).catch((error) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

function requestResult(request, message) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(message));
  });
}

function transactionDone(transaction, message) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error(message));
    transaction.onabort = () => reject(new Error(message));
  });
}

async function listLocalFiles(profileId) {
  const owner = normalizeProfileId(profileId);
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const done = transactionDone(transaction, "Assignment documents could not be read.");
  const records = await requestResult(transaction.objectStore(STORE_NAME).index(PROFILE_INDEX).getAll(owner), "Assignment documents could not be read.");
  await done;
  return (records || []).filter((record) => record.profileId === owner).map(formatRecord).filter(Boolean);
}

async function addLocalFile(input, profileId) {
  const owner = normalizeProfileId(profileId);
  const value = validateInput(input);
  const record = {
    ...value,
    addedAt: new Date().toISOString(),
    blob: value.file,
    cloud: false,
    id: createRecordId(),
    profileId: owner,
    recordKind: ASSIGNMENT_FILE_RECORD_KIND,
  };
  delete record.file;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const done = transactionDone(transaction, "The assignment document could not be saved.");
  await requestResult(transaction.objectStore(STORE_NAME).add(record), "The assignment document could not be saved.");
  await done;
  return formatRecord(record);
}

async function readLocalFile(record, profileId) {
  const owner = normalizeProfileId(profileId);
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const done = transactionDone(transaction, "The assignment document could not be read.");
  const stored = await requestResult(transaction.objectStore(STORE_NAME).get(record.id), "The assignment document could not be read.");
  await done;
  if (!stored || stored.profileId !== owner || stored.recordKind !== ASSIGNMENT_FILE_RECORD_KIND || !(stored.blob instanceof Blob)) {
    throw new Error("That assignment document is no longer available on this device.");
  }
  return stored.blob;
}

async function deleteLocalFile(record, profileId) {
  const owner = normalizeProfileId(profileId);
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const done = transactionDone(transaction, "The assignment document could not be removed.");
  const store = transaction.objectStore(STORE_NAME);
  const stored = await requestResult(store.get(record.id), "The assignment document could not be read.");
  if (!stored || stored.profileId !== owner || stored.recordKind !== ASSIGNMENT_FILE_RECORD_KIND) {
    await done;
    return false;
  }
  await requestResult(store.delete(record.id), "The assignment document could not be removed.");
  await done;
  return true;
}

function requireCloudClient(client) {
  if (!client?.from || !client?.storage) throw new TypeError("A signed-in account client is required.");
}

function cloudRowToRecord(row) {
  return formatRecord({
    addedAt: row.created_at,
    assignmentId: row.assignment_id,
    cloud: true,
    courseId: row.course_id,
    documentKind: row.document_kind,
    fileName: row.file_name,
    id: row.id,
    mimeType: row.mime_type || "",
    profileId: row.user_id,
    recordKind: ASSIGNMENT_FILE_RECORD_KIND,
    size: Number(row.size_bytes),
    storagePath: row.storage_path,
  });
}

async function sha256(value) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function assignmentFilePath(userId, courseId, assignmentId, recordId, extension) {
  const owner = normalizeProfileId(userId);
  const course = normalizeIdentifier(courseId, "course id");
  const assignment = normalizeIdentifier(assignmentId, "assignment id");
  const id = normalizeIdentifier(recordId, "assignment file id");
  const suffix = String(extension || "").toLocaleLowerCase("en-US");
  if (!ACCEPTED_EXTENSIONS.has(suffix)) throw new TypeError("A supported assignment document extension is required.");
  const courseHash = (await sha256(course)).slice(0, 24);
  const assignmentHash = (await sha256(assignment)).slice(0, 32);
  return `${owner}/${courseHash}/${assignmentHash}/${id}/document.${suffix}`;
}

function isOwnedCloudRecord(record, owner) {
  return record?.recordKind === ASSIGNMENT_FILE_RECORD_KIND
    && record.profileId === owner
    && typeof record.storagePath === "string"
    && record.storagePath.startsWith(`${owner}/`)
    && !record.storagePath.slice(owner.length + 1).includes("../");
}

async function listCloudFiles(client, profileId) {
  requireCloudClient(client);
  const owner = normalizeProfileId(profileId);
  const result = await client.from("assignment_files").select(CLOUD_COLUMNS).eq("user_id", owner).order("created_at", { ascending: false });
  if (result.error) throw new Error("Your private assignment documents could not be loaded.");
  return (result.data || []).filter((row) => row.user_id === owner).map(cloudRowToRecord).filter(Boolean);
}

async function addCloudFile(client, input, profileId) {
  requireCloudClient(client);
  const owner = normalizeProfileId(profileId);
  const value = validateInput(input);
  const recordId = createRecordId();
  const storagePath = await assignmentFilePath(owner, value.courseId, value.assignmentId, recordId, value.extension);
  const upload = await client.storage.from(ASSIGNMENT_FILE_BUCKET).upload(storagePath, value.file, {
    cacheControl: "3600",
    contentType: value.mimeType || undefined,
    upsert: false,
  });
  if (upload.error) throw new Error("The document could not be uploaded to your private account storage.");
  const metadata = {
    assignment_id: value.assignmentId,
    course_id: value.courseId,
    document_kind: value.documentKind,
    file_name: value.fileName,
    mime_type: value.mimeType || null,
    size_bytes: value.size,
    storage_path: storagePath,
    user_id: owner,
  };
  const saved = await client.from("assignment_files").insert(metadata).select(CLOUD_COLUMNS).single();
  if (saved.error) {
    await client.storage.from(ASSIGNMENT_FILE_BUCKET).remove([storagePath]);
    throw new Error("The document upload did not finish; no attachment entry was created.");
  }
  const record = cloudRowToRecord(saved.data);
  if (!record || !isOwnedCloudRecord(record, owner)) throw new Error("The saved document could not be confirmed for this account.");
  return record;
}

async function readCloudFile(client, record, profileId) {
  requireCloudClient(client);
  const owner = normalizeProfileId(profileId);
  if (!isOwnedCloudRecord(record, owner)) throw new Error("That document does not belong to this account.");
  const result = await client.storage.from(ASSIGNMENT_FILE_BUCKET).download(record.storagePath);
  if (result.error || !(result.data instanceof Blob)) throw new Error("The assignment document could not be downloaded.");
  return result.data;
}

async function deleteCloudFile(client, record, profileId) {
  requireCloudClient(client);
  const owner = normalizeProfileId(profileId);
  if (!isOwnedCloudRecord(record, owner)) throw new Error("That document does not belong to this account.");
  const removed = await client.from("assignment_files").delete().eq("user_id", owner).eq("id", record.id).select(CLOUD_COLUMNS).maybeSingle();
  if (removed.error) throw new Error("The document entry could not be removed.");
  if (!removed.data) return false;
  const object = await client.storage.from(ASSIGNMENT_FILE_BUCKET).remove([record.storagePath]);
  if (object.error) {
    await client.from("assignment_files").upsert(removed.data, { onConflict: "id" });
    throw new Error("The stored document could not be removed; its attachment entry was restored.");
  }
  return true;
}

export async function listAssignmentFiles({ client = null, profileId }) {
  const files = client ? await listCloudFiles(client, profileId) : await listLocalFiles(profileId);
  return files.sort((left, right) => String(right.addedAt || "").localeCompare(String(left.addedAt || "")));
}

export async function addAssignmentFile({ assignmentId, client = null, courseId, documentKind, file, profileId }) {
  const input = { assignmentId, courseId, documentKind, file };
  return client ? addCloudFile(client, input, profileId) : addLocalFile(input, profileId);
}

export async function readAssignmentFile({ client = null, profileId, record }) {
  return client ? readCloudFile(client, record, profileId) : readLocalFile(record, profileId);
}

export async function deleteAssignmentFile({ client = null, profileId, record }) {
  return client ? deleteCloudFile(client, record, profileId) : deleteLocalFile(record, profileId);
}
