import {
  STUDY_SOURCE_RECORD_KIND,
  StudySourceStorageError,
  StudySourceValidationError,
  filterStudySourceRecordsForIdentity,
  formatStudySourceRecord,
  normalizeCourseSpaceId,
  normalizeStudySourceProfileId,
  validateStudySourceInput,
} from "./studySourceModel.js";

export const STUDY_SOURCE_DATABASE_NAME = "fall2026Quest:studySources";
export const STUDY_SOURCE_STORE_NAME = "studySources";
const DATABASE_VERSION = 1;
const DATABASE_NAME = STUDY_SOURCE_DATABASE_NAME;
const STORE_NAME = STUDY_SOURCE_STORE_NAME;
const PROFILE_COURSE_INDEX = "profileCourse";

let databasePromise = null;

function createRecordId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `source_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function indexedDbApi() {
  const api = globalThis.indexedDB;
  if (!api || typeof api.open !== "function") {
    throw new StudySourceStorageError(
      "Study Deck source storage is unavailable in this browser. Files were not saved.",
    );
  }
  return api;
}

function requestResult(request, action) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new StudySourceStorageError(
      `Could not ${action} in Study Deck source storage.`,
      request.error,
    ));
  });
}

function transactionDone(transaction, action) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new StudySourceStorageError(
      `Could not ${action} in Study Deck source storage.`,
      transaction.error,
    ));
    transaction.onabort = () => reject(new StudySourceStorageError(
      `Could not ${action} in Study Deck source storage.`,
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
      if (!store.indexNames.contains(PROFILE_COURSE_INDEX)) {
        store.createIndex(PROFILE_COURSE_INDEX, ["profileId", "courseSpaceId"], { unique: false });
      }
      if (!store.indexNames.contains("profileId")) {
        store.createIndex("profileId", "profileId", { unique: false });
      }
      if (!store.indexNames.contains("courseSpaceId")) {
        store.createIndex("courseSpaceId", "courseSpaceId", { unique: false });
      }
      if (!store.indexNames.contains("addedAt")) {
        store.createIndex("addedAt", "addedAt", { unique: false });
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
    request.onerror = () => reject(new StudySourceStorageError(
      "Could not open Study Deck source storage in this browser.",
      request.error,
    ));
    request.onblocked = () => {
      blocked = true;
      reject(new StudySourceStorageError(
        "Study Deck source storage is blocked by another open version of this app.",
      ));
    };
  });

  databasePromise = pending.catch((error) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

export async function listLocalStudySources(profileId, courseSpaceId) {
  const owner = normalizeStudySourceProfileId(profileId);
  const space = normalizeCourseSpaceId(courseSpaceId);
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const completed = transactionDone(transaction, "read source files");
  const index = transaction.objectStore(STORE_NAME).index(PROFILE_COURSE_INDEX);
  const [records] = await Promise.all([
    requestResult(index.getAll([owner, space]), "read source files"),
    completed,
  ]);

  return filterStudySourceRecordsForIdentity(records, owner, space)
    .sort((left, right) => String(right.addedAt || "").localeCompare(String(left.addedAt || "")));
}

export async function listLocalStudySourcesForProfile(profileId) {
  const owner = normalizeStudySourceProfileId(profileId);
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const completed = transactionDone(transaction, "read source files");
  const index = transaction.objectStore(STORE_NAME).index("profileId");
  const [records] = await Promise.all([
    requestResult(index.getAll(owner), "read source files"),
    completed,
  ]);

  return (Array.isArray(records) ? records : [])
    .filter((record) => record?.profileId === owner && record?.recordKind === STUDY_SOURCE_RECORD_KIND)
    .map(formatStudySourceRecord)
    .filter(Boolean)
    .sort((left, right) => String(right.addedAt || "").localeCompare(String(left.addedAt || "")));
}

export async function addLocalStudySource(input, profileId) {
  const owner = normalizeStudySourceProfileId(profileId);
  const validation = validateStudySourceInput(input);
  if (!validation.valid) throw new StudySourceValidationError(validation.errors);

  const {
    courseCode,
    courseSpaceId,
    extension,
    file,
    fileName,
    lastModified,
    mimeType,
    size,
  } = validation.value;
  const record = {
    addedAt: new Date().toISOString(),
    blob: file,
    courseCode,
    courseSpaceId,
    extension,
    fileName,
    id: createRecordId(),
    lastModified,
    mimeType,
    profileId: owner,
    recordKind: STUDY_SOURCE_RECORD_KIND,
    size,
  };

  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const completed = transactionDone(transaction, "save the source file");
  await Promise.all([
    requestResult(transaction.objectStore(STORE_NAME).add(record), "save the source file"),
    completed,
  ]);
  return formatStudySourceRecord(record);
}

export async function deleteLocalStudySource(record, profileId, courseSpaceId) {
  const owner = normalizeStudySourceProfileId(profileId);
  const space = normalizeCourseSpaceId(courseSpaceId);
  const id = String(record?.id || "").trim();
  if (!id || record?.recordKind !== STUDY_SOURCE_RECORD_KIND) {
    throw new Error("That file is not a valid Study Deck source.");
  }
  if (record.courseSpaceId !== space) {
    throw new Error("That source belongs to a different course space.");
  }

  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const completed = transactionDone(transaction, "delete the source file");
  const store = transaction.objectStore(STORE_NAME);
  const storedRecord = await requestResult(store.get(id), "read the source file");
  if (
    !storedRecord
    || storedRecord.profileId !== owner
    || storedRecord.courseSpaceId !== space
    || storedRecord.recordKind !== STUDY_SOURCE_RECORD_KIND
  ) {
    await completed;
    return false;
  }

  await requestResult(store.delete(id), "delete the source file");
  await completed;
  return true;
}

export async function readLocalStudySourceBlob(record, profileId, courseSpaceId) {
  const owner = normalizeStudySourceProfileId(profileId);
  const space = normalizeCourseSpaceId(courseSpaceId);
  const id = String(record?.id || "").trim();
  if (!id || record?.recordKind !== STUDY_SOURCE_RECORD_KIND || record.courseSpaceId !== space) {
    throw new Error("That file is not a valid Study Deck source for this course space.");
  }

  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const completed = transactionDone(transaction, "read the source file");
  const storedRecord = await requestResult(transaction.objectStore(STORE_NAME).get(id), "read the source file");
  await completed;
  if (
    !storedRecord
    || storedRecord.profileId !== owner
    || storedRecord.courseSpaceId !== space
    || storedRecord.recordKind !== STUDY_SOURCE_RECORD_KIND
    || !(storedRecord.blob instanceof Blob)
  ) {
    throw new Error("That Study Deck source is no longer available in this browser.");
  }
  return storedRecord.blob;
}
