const DATABASE_NAME = "fall2026Quest:push";
const DATABASE_VERSION = 1;
const STATE_STORE = "state";
const DETAILS_STORE = "details";
const SETTINGS_KEY = "settings";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const REMINDER_TYPES = new Set(["class-1h", "assignment-24h", "exam-7d", "test"]);

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
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
    request.onerror = () => reject(request.error);
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function readLocalReminder(id) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([STATE_STORE, DETAILS_STORE], "readonly");
    const statePromise = requestValue(transaction.objectStore(STATE_STORE).get(SETTINGS_KEY));
    const detailPromise = requestValue(transaction.objectStore(DETAILS_STORE).get(id));
    const [state, detail] = await Promise.all([statePromise, detailPromise]);
    return { state, detail };
  } finally {
    database.close();
  }
}

function parsePushPayload(event) {
  if (!event.data) return null;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return null;
  }
  if (
    !payload
    || payload.v !== 1
    || !HASH_PATTERN.test(payload.id)
    || !REVISION_PATTERN.test(payload.revision)
    || !REMINDER_TYPES.has(payload.type)
    || typeof payload.targetAt !== "string"
  ) return null;

  const targetEpoch = Date.parse(payload.targetAt);
  if (!Number.isFinite(targetEpoch)) return null;
  return { ...payload, targetEpoch };
}

function genericCopy(type) {
  if (type === "class-1h") {
    return { title: "Class reminder", body: "An in-person class starts soon." };
  }
  if (type === "assignment-24h") {
    return { title: "Assignment reminder", body: "An assignment is due soon." };
  }
  if (type === "exam-7d") {
    return { title: "Exam reminder", body: "A midterm or final is coming up." };
  }
  return {
    title: "Reminders are on",
    body: "This browser can receive dashboard reminders.",
  };
}

function safeLocalUrl(value) {
  const rootUrl = new URL("/", self.location.origin).href;
  if (typeof value !== "string" || value.length > 2048) return rootUrl;
  try {
    const candidate = new URL(value, self.location.origin);
    return candidate.origin === self.location.origin ? candidate.href : rootUrl;
  } catch {
    return rootUrl;
  }
}

async function handlePush(event) {
  const payload = parsePushPayload(event);
  if (!payload || payload.targetEpoch <= Date.now()) return;

  let local;
  try {
    local = await readLocalReminder(payload.id);
  } catch {
    return;
  }
  if (
    !local.state?.enabled
    || !PROFILE_ID_PATTERN.test(local.state.profileId || "")
    || local.state.revision !== payload.revision
  ) return;

  const fallback = genericCopy(payload.type);
  const detailMatches = local.detail
    && (!local.detail.targetAt || local.detail.targetAt === payload.targetAt);
  const title = detailMatches && typeof local.detail.title === "string"
    ? local.detail.title.slice(0, 120)
    : fallback.title;
  const body = detailMatches && typeof local.detail.body === "string"
    ? local.detail.body.slice(0, 240)
    : fallback.body;
  const notificationUrl = safeLocalUrl(detailMatches ? local.detail.url : null);

  await self.registration.showNotification(title, {
    body,
    data: { url: notificationUrl },
    renotify: false,
    tag: `fall2026Quest:${payload.id}`,
    timestamp: payload.targetEpoch,
  });
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const targetUrl = safeLocalUrl(event.notification.data?.url);
    const windows = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
    const existing = windows.find((client) => {
      try {
        return new URL(client.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });
    if (existing) {
      if (typeof existing.navigate === "function") await existing.navigate(targetUrl);
      return existing.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});
