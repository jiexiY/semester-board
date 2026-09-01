import { normalizeProfileId } from "./profileStorage.js";

const DB_NAME = "fall2026Quest:push";
const DB_VERSION = 1;
const STATE_STORE = "state";
const DETAILS_STORE = "details";
export const PUSH_OWNER_SIGNAL_KEY = "fall2026Quest:pushOwner:v1";
const PUSH_OWNER_SIGNAL_SCHEMA_VERSION = 1;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STATE_STORE)) {
        database.createObjectStore(STATE_STORE);
      }
      if (!database.objectStoreNames.contains(DETAILS_STORE)) {
        database.createObjectStore(DETAILS_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Push storage could not be opened."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Push storage failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Push storage was interrupted."));
  });
}

export async function readPushSettings() {
  if (typeof window === "undefined" || !window.indexedDB) return null;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STATE_STORE, "readonly");
    const done = transactionDone(transaction);
    const request = transaction.objectStore(STATE_STORE).get("settings");
    const valueRequest = new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Push settings could not be read."));
    });
    const [value] = await Promise.all([valueRequest, done]);
    return value;
  } finally {
    database.close();
  }
}

export async function writePushSettings({
  enabled,
  endpointHash = null,
  profileId = null,
  receipt = null,
  revision = null,
}) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STATE_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STATE_STORE).put({
      enabled,
      endpointHash,
      profileId: profileId ? normalizeProfileId(profileId) : null,
      receipt,
      revision,
    }, "settings");
    await done;
  } finally {
    database.close();
  }
}

export async function writePushSchedule({
  details,
  enabled,
  endpointHash = null,
  profileId = null,
  receipt = null,
  revision = null,
}) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([STATE_STORE, DETAILS_STORE], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STATE_STORE).put({
      enabled,
      endpointHash,
      profileId: profileId ? normalizeProfileId(profileId) : null,
      receipt,
      revision,
    }, "settings");
    const detailStore = transaction.objectStore(DETAILS_STORE);
    detailStore.clear();
    for (const detail of details) detailStore.put(detail);
    await done;
  } finally {
    database.close();
  }
}

export async function disablePushSchedule() {
  if (typeof window === "undefined" || !window.indexedDB) return;
  const database = await openDatabase();
  try {
    const transaction = database.transaction([STATE_STORE, DETAILS_STORE], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STATE_STORE).put({
      enabled: false,
      endpointHash: null,
      profileId: null,
      receipt: null,
      revision: null,
    }, "settings");
    transaction.objectStore(DETAILS_STORE).clear();
    await done;
  } finally {
    database.close();
  }
}

export function isSchedulablePushReminder(reminder, now = Date.now()) {
  const remindAt = Date.parse(reminder?.remindAt);
  const targetAt = Date.parse(reminder?.targetAt);
  return Number.isFinite(remindAt)
    && Number.isFinite(targetAt)
    && remindAt > now
    && remindAt < targetAt;
}

export function genericPushReminderCopy(type) {
  if (type === "class-1h") {
    return {
      body: "Open the dashboard and sign in to view the class details.",
      title: "Class reminder",
    };
  }
  if (type === "assignment-24h") {
    return {
      body: "Open the dashboard and sign in to view the assignment details.",
      title: "Assignment reminder",
    };
  }
  if (type === "exam-7d") {
    return {
      body: "Open the dashboard and sign in to view the exam details.",
      title: "Exam reminder",
    };
  }
  return {
    body: "Open the dashboard and sign in to view the reminder details.",
    title: "Semester reminder",
  };
}

export function mergeLegacyPushSettings(settings, legacy) {
  const durable = settings && typeof settings === "object" ? settings : null;
  const hasCurrentSchema = durable
    && Object.hasOwn(durable, "receipt")
    && Object.hasOwn(durable, "endpointHash");
  if (hasCurrentSchema) return durable;

  const legacyIsComplete = typeof legacy?.receipt === "string"
    && typeof legacy?.revision === "string"
    && typeof legacy?.endpointHash === "string";
  if (legacyIsComplete) {
    return {
      enabled: durable?.enabled ?? true,
      endpointHash: legacy.endpointHash,
      receipt: legacy.receipt,
      revision: legacy.revision,
    };
  }
  if (!durable) return null;
  return {
    enabled: Boolean(durable.enabled),
    endpointHash: null,
    receipt: null,
    revision: durable.revision ?? null,
  };
}

export function pushSettingsBelongToProfile(settings, profileId) {
  if (!settings || typeof settings !== "object") return false;
  try {
    return settings.profileId === normalizeProfileId(profileId);
  } catch {
    return false;
  }
}

export function canAutomaticallySyncPushSettings(settings, profileId) {
  return settings?.enabled === true && pushSettingsBelongToProfile(settings, profileId);
}

export function createPushOwnerSignal({
  ownerProfileId = null,
  previousOwnerProfileId = null,
  nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`,
} = {}) {
  return JSON.stringify({
    schemaVersion: PUSH_OWNER_SIGNAL_SCHEMA_VERSION,
    ownerProfileId: ownerProfileId ? normalizeProfileId(ownerProfileId) : null,
    previousOwnerProfileId: previousOwnerProfileId
      ? normalizeProfileId(previousOwnerProfileId)
      : null,
    nonce: String(nonce).slice(0, 128),
  });
}

export function pushOwnerSignalDisplacesProfile(value, profileId) {
  let signal;
  let normalizedProfileId;
  try {
    signal = typeof value === "string" ? JSON.parse(value) : value;
    normalizedProfileId = normalizeProfileId(profileId);
  } catch {
    return false;
  }
  if (!signal || signal.schemaVersion !== PUSH_OWNER_SIGNAL_SCHEMA_VERSION) return false;
  if (signal.ownerProfileId) {
    try {
      if (normalizeProfileId(signal.ownerProfileId) === normalizedProfileId) return false;
      return signal.previousOwnerProfileId
        ? normalizeProfileId(signal.previousOwnerProfileId) === normalizedProfileId
        : false;
    } catch {
      return false;
    }
  }
  try {
    return signal.previousOwnerProfileId
      ? normalizeProfileId(signal.previousOwnerProfileId) === normalizedProfileId
      : false;
  } catch {
    return false;
  }
}

export function canClaimLegacyPushSettings(settings, legacy, claimProfileId, profileId) {
  let normalizedProfileId;
  try {
    normalizedProfileId = normalizeProfileId(profileId);
  } catch {
    return false;
  }
  if (claimProfileId !== normalizedProfileId) return false;
  return typeof settings?.receipt === "string"
    && typeof settings?.revision === "string"
    && typeof settings?.endpointHash === "string"
    && legacy?.receipt === settings.receipt
    && legacy?.revision === settings.revision
    && legacy?.endpointHash === settings.endpointHash;
}

export function decodeVapidPublicKey(value) {
  const normalized = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = window.atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function updateExistingServiceWorker(navigatorApi = globalThis.navigator) {
  if (!navigatorApi?.serviceWorker?.getRegistration) return false;
  try {
    const registration = await navigatorApi.serviceWorker.getRegistration("/");
    if (!registration?.update) return false;
    await registration.update();
    return true;
  } catch {
    return false;
  }
}

export function pushCapabilityStatus() {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in window.navigator)
    || !("PushManager" in window)
    || !("Notification" in window)
    || !window.indexedDB
    || !window.crypto?.subtle) {
    return "unsupported";
  }
  if (!window.navigator.locks || typeof window.navigator.locks.request !== "function") {
    return "unsupported";
  }
  return window.Notification.permission === "denied" ? "blocked" : "available";
}
