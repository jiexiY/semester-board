export const MAX_PUSH_BODY_BYTES = 256 * 1024;
export const MAX_REMINDERS = 512;
export const MAX_FUTURE_DAYS = 370;
export const MAX_RECEIPT_LENGTH = 32 * 1024;

export const REMINDER_TYPES = Object.freeze([
  "class-1h",
  "assignment-24h",
  "exam-7d",
]);

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const ALLOWED_PUSH_HOSTS = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "web.push.apple.com",
]);

export class PushProtocolError extends Error {
  constructor(message, { code = "invalid_request", status = 400 } = {}) {
    super(message);
    this.name = "PushProtocolError";
    this.code = code;
    this.status = status;
  }
}

function fail(message, options) {
  throw new PushProtocolError(message, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
}

function assertExactKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains an unsupported field.`);
  }
}

function assertHash(value, label) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 hex digest.`);
  }
  return value;
}

function parseCanonicalDate(value, label) {
  if (typeof value !== "string" || value.length > 32) {
    fail(`${label} must be an ISO timestamp.`);
  }

  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    fail(`${label} must be a canonical UTC ISO timestamp.`);
  }
  return epoch;
}

function isAllowedPushHost(hostname) {
  const host = hostname.toLowerCase();
  return ALLOWED_PUSH_HOSTS.has(host)
    || host.endsWith(".notify.windows.com")
    || host.endsWith(".push.apple.com");
}

export function validatePushSubscription(value) {
  assertObject(value, "subscription");
  assertExactKeys(value, ["endpoint", "expirationTime", "keys"], "subscription");

  if (typeof value.endpoint !== "string" || value.endpoint.length > 2048) {
    fail("subscription.endpoint is invalid.");
  }

  let endpoint;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    fail("subscription.endpoint is invalid.");
  }

  if (
    endpoint.protocol !== "https:"
    || endpoint.username
    || endpoint.password
    || !isAllowedPushHost(endpoint.hostname)
  ) {
    fail("subscription.endpoint is not a supported Web Push endpoint.");
  }

  const expirationTime = value.expirationTime ?? null;
  if (
    expirationTime !== null
    && (!Number.isSafeInteger(expirationTime) || expirationTime <= 0)
  ) {
    fail("subscription.expirationTime is invalid.");
  }

  assertObject(value.keys, "subscription.keys");
  assertExactKeys(value.keys, ["p256dh", "auth"], "subscription.keys");

  const { p256dh, auth } = value.keys;
  if (
    typeof p256dh !== "string"
    || p256dh.length < 80
    || p256dh.length > 140
    || !BASE64URL_PATTERN.test(p256dh)
  ) {
    fail("subscription.keys.p256dh is invalid.");
  }
  if (
    typeof auth !== "string"
    || auth.length < 16
    || auth.length > 64
    || !BASE64URL_PATTERN.test(auth)
  ) {
    fail("subscription.keys.auth is invalid.");
  }

  return {
    endpoint: endpoint.href,
    expirationTime,
    keys: { p256dh, auth },
  };
}

export function validateReminderOccurrence(value, { now = Date.now() } = {}) {
  assertObject(value, "reminder");
  assertExactKeys(value, ["id", "type", "remindAt", "targetAt"], "reminder");

  const id = assertHash(value.id, "reminder.id");
  if (!REMINDER_TYPES.includes(value.type)) fail("reminder.type is invalid.");

  const remindAtEpoch = parseCanonicalDate(value.remindAt, "reminder.remindAt");
  const targetAtEpoch = parseCanonicalDate(value.targetAt, "reminder.targetAt");

  if (remindAtEpoch <= now) fail("reminder.remindAt must be in the future.");
  if (remindAtEpoch >= targetAtEpoch) {
    fail("reminder.remindAt must be before reminder.targetAt.");
  }
  if (targetAtEpoch <= now) fail("reminder.targetAt must be in the future.");
  if (targetAtEpoch > now + MAX_FUTURE_DAYS * DAY_MS) {
    fail(`reminder.targetAt cannot be more than ${MAX_FUTURE_DAYS} days away.`);
  }

  return {
    id,
    type: value.type,
    remindAt: value.remindAt,
    targetAt: value.targetAt,
  };
}

export function validateSyncPayload(value, { now = Date.now() } = {}) {
  assertObject(value, "request body");
  assertExactKeys(
    value,
    ["subscription", "revision", "reminders", "previousReceipt"],
    "request body",
  );

  const subscription = validatePushSubscription(value.subscription);
  const revision = assertHash(value.revision, "revision");
  if (!Array.isArray(value.reminders)) fail("reminders must be an array.");
  if (value.reminders.length > MAX_REMINDERS) {
    fail(`reminders cannot contain more than ${MAX_REMINDERS} occurrences.`);
  }

  const ids = new Set();
  const reminders = value.reminders.map((reminder) => {
    const normalized = validateReminderOccurrence(reminder, { now });
    if (ids.has(normalized.id)) fail("reminders cannot contain duplicate ids.");
    ids.add(normalized.id);
    return normalized;
  }).sort((left, right) => (
    left.remindAt.localeCompare(right.remindAt)
    || left.targetAt.localeCompare(right.targetAt)
    || left.id.localeCompare(right.id)
  ));

  let previousReceipt = null;
  if (value.previousReceipt !== undefined && value.previousReceipt !== null) {
    if (
      typeof value.previousReceipt !== "string"
      || value.previousReceipt.length < 16
      || value.previousReceipt.length > MAX_RECEIPT_LENGTH
    ) {
      fail("previousReceipt is invalid.");
    }
    previousReceipt = value.previousReceipt;
  }

  return { subscription, revision, reminders, previousReceipt };
}

export function validateDisablePayload(value) {
  assertObject(value, "request body");
  assertExactKeys(value, ["receipt"], "request body");
  if (
    typeof value.receipt !== "string"
    || value.receipt.length < 16
    || value.receipt.length > MAX_RECEIPT_LENGTH
  ) {
    fail("receipt is invalid.");
  }
  return { receipt: value.receipt };
}

export function validateTestPayload(value) {
  assertObject(value, "request body");
  assertExactKeys(value, ["subscription", "receipt"], "request body");
  if (
    typeof value.receipt !== "string"
    || value.receipt.length < 16
    || value.receipt.length > MAX_RECEIPT_LENGTH
  ) {
    fail("receipt is invalid.");
  }
  return {
    subscription: validatePushSubscription(value.subscription),
    receipt: value.receipt,
  };
}

async function readBoundedBody(request, maximumBytes) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0) {
      fail("Content-Length is invalid.");
    }
    if (parsedLength > maximumBytes) {
      fail("Request body is too large.", { code: "payload_too_large", status: 413 });
    }
  }

  if (!request.body) fail("Request body is required.");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        fail("Request body is too large.", { code: "payload_too_large", status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("Request body must be valid UTF-8.");
  }
}

export async function readJsonRequest(request, { maximumBytes = MAX_PUSH_BODY_BYTES } = {}) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    fail("Content-Type must be application/json.", {
      code: "unsupported_media_type",
      status: 415,
    });
  }

  const text = await readBoundedBody(request, maximumBytes);
  if (!text.trim()) fail("Request body is required.");
  try {
    return JSON.parse(text);
  } catch {
    fail("Request body must be valid JSON.");
  }
}

export function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function responseOptionsForError(error, status) {
  const headers = {};
  if (status === 429 && Number.isInteger(error?.retryAfterSeconds)) {
    headers["Retry-After"] = String(Math.max(1, error.retryAfterSeconds));
  }
  return { headers, status };
}

export function errorResponse(error) {
  if (error instanceof PushProtocolError) {
    return jsonResponse({ ok: false, error: error.code, message: error.message }, {
      ...responseOptionsForError(error, error.status),
    });
  }

  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === "string" ? error.code : "server_error";
  const message = status < 500 && typeof error?.message === "string"
    ? error.message
    : "The reminder service could not complete this request.";
  return jsonResponse(
    { ok: false, error: code, message },
    responseOptionsForError(error, status),
  );
}
