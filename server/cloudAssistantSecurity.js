import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  assertBodySize,
  getRequestHeader,
  readRawBody,
} from "nitro/h3";

export const AI_CONSENT_POLICY = "2026-09-07.1";
export const AI_CONSENT_COOKIE = "fall_quest_ai_consent";
export const AI_CONSENT_TTL_SECONDS = 8 * 60 * 60;
export const MAX_JSON_BYTES = 32 * 1024;
export const MAX_CHAT_MESSAGES = 12;
export const MAX_TEXT_PART_CHARS = 3_000;
export const MAX_CHAT_TEXT_CHARS = 12_000;
export const SEMESTER_CONTEXT_SCHEMA_VERSION = 1;
export const MAX_SEMESTER_CONTEXT_FACTS = 64;
export const MAX_SEMESTER_CONTEXT_FACT_CHARS = 320;
export const MAX_SEMESTER_CONTEXT_CHARS = 16_000;
export const CHAT_RATE_LIMITS = Object.freeze([
  Object.freeze({ limit: 8, scope: "consent", windowMs: 60 * 1_000 }),
  Object.freeze({ limit: 40, scope: "consent", windowMs: AI_CONSENT_TTL_SECONDS * 1_000 }),
  Object.freeze({ limit: 12, scope: "ip", windowMs: 60 * 1_000 }),
  Object.freeze({ limit: 100, scope: "ip", windowMs: AI_CONSENT_TTL_SECONDS * 1_000 }),
]);

const COOKIE_SIGNATURE_CONTEXT = "fall-2026-quest.ai-consent.v1";
const MIN_SIGNING_SECRET_BYTES = 32;
const MAX_MESSAGE_ID_CHARS = 200;
const MAX_TEXT_PARTS_PER_MESSAGE = 12;

const GENERIC_ERROR_MESSAGES = Object.freeze({
  400: "Invalid request.",
  403: "Forbidden.",
  413: "Request too large.",
  415: "Unsupported request.",
  429: "Too many requests. Try again later.",
  500: "Assistant unavailable.",
  502: "Assistant unavailable.",
  503: "Assistant unavailable.",
});

export class CloudAssistantRequestError extends Error {
  constructor(status, code, { retryAfterSeconds } = {}) {
    super(code);
    this.name = "CloudAssistantRequestError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const isPlainObject = (value) => (
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);

const hasOnlyKeys = (value, allowedKeys) => {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const normalizeNowMs = (now) => {
  const value = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(value)) {
    throw new TypeError("now must be a valid timestamp");
  }
  return Math.floor(value);
};

const firstForwardedValue = (value) => value?.split(",", 1)[0]?.trim() || null;

const rateLimitDigest = (secret, scope, value) => createHmac("sha256", secret)
  .update(`fall-2026-quest.chat-rate-limit.v1.${scope}.${value}`)
  .digest("base64url");

export function getTrustedClientAddress(request) {
  return firstForwardedValue(
    request.headers.get("x-vercel-forwarded-for")
      || request.headers.get("x-forwarded-for")
      || request.headers.get("x-real-ip"),
  ) || "unknown";
}

export function createChatRateLimiter({
  limits = CHAT_RATE_LIMITS,
  store = new Map(),
  maxEntries = 10_000,
} = {}) {
  return ({ request, consentToken, secret, now = Date.now() }) => {
    const nowMs = normalizeNowMs(now);
    const identities = {
      consent: consentToken,
      ip: getTrustedClientAddress(request),
    };

    if (store.size >= maxEntries) {
      for (const [key, record] of store) {
        if (record.resetAt <= nowMs) store.delete(key);
      }
    }
    if (store.size >= maxEntries) {
      throw new CloudAssistantRequestError(429, "rate_limit_capacity", {
        retryAfterSeconds: 60,
      });
    }

    for (const limit of limits) {
      const identity = identities[limit.scope];
      const key = rateLimitDigest(secret, `${limit.scope}:${limit.windowMs}`, identity);
      const current = store.get(key);
      const record = !current || current.resetAt <= nowMs
        ? { count: 0, resetAt: nowMs + limit.windowMs }
        : current;
      if (record.count >= limit.limit) {
        throw new CloudAssistantRequestError(429, "rate_limited", {
          retryAfterSeconds: Math.max(1, Math.ceil((record.resetAt - nowMs) / 1_000)),
        });
      }
    }

    for (const limit of limits) {
      const identity = identities[limit.scope];
      const key = rateLimitDigest(secret, `${limit.scope}:${limit.windowMs}`, identity);
      const current = store.get(key);
      const record = !current || current.resetAt <= nowMs
        ? { count: 0, resetAt: nowMs + limit.windowMs }
        : current;
      store.set(key, { count: record.count + 1, resetAt: record.resetAt });
    }
  };
}

export const consumeChatRateLimit = createChatRateLimiter();

export function getRequestTargetOrigin(request) {
  const requestUrl = new URL(request.url);
  const forwardedHost = firstForwardedValue(request.headers.get("x-forwarded-host"));
  const forwardedProto = firstForwardedValue(request.headers.get("x-forwarded-proto"));
  const host = forwardedHost || request.headers.get("host") || requestUrl.host;
  const protocol = (forwardedProto || requestUrl.protocol).replace(/:$/, "").toLowerCase();

  if (!host || !/^[a-z][a-z0-9+.-]*$/i.test(protocol)) {
    return requestUrl.origin;
  }

  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return requestUrl.origin;
  }
}

export function isSameOriginRequest(request, { requireOrigin = true } = {}) {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return false;
  }

  const suppliedOrigin = request.headers.get("origin");
  if (!suppliedOrigin) {
    return !requireOrigin;
  }

  try {
    return new URL(suppliedOrigin).origin === getRequestTargetOrigin(request);
  } catch {
    return false;
  }
}

export function requireSameOrigin(event, options) {
  if (!isSameOriginRequest(event.req, options)) {
    throw new CloudAssistantRequestError(403, "origin_rejected");
  }
}

export function isJsonContentType(contentType) {
  if (typeof contentType !== "string") return false;
  return contentType.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

export function parseBoundedJsonText(rawBody, maxBytes = MAX_JSON_BYTES) {
  if (typeof rawBody !== "string" || rawBody.length === 0) {
    throw new CloudAssistantRequestError(400, "invalid_json");
  }
  if (Buffer.byteLength(rawBody, "utf8") > maxBytes) {
    throw new CloudAssistantRequestError(413, "body_too_large");
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new CloudAssistantRequestError(400, "invalid_json");
  }
}

export async function readBoundedJson(event, maxBytes = MAX_JSON_BYTES) {
  if (!isJsonContentType(getRequestHeader(event, "content-type"))) {
    throw new CloudAssistantRequestError(415, "unsupported_content_type");
  }

  try {
    await assertBodySize(event, maxBytes);
  } catch {
    throw new CloudAssistantRequestError(413, "body_too_large");
  }

  const rawBody = await readRawBody(event);
  return parseBoundedJsonText(rawBody, maxBytes);
}

export function validateConsentPayload(payload) {
  if (
    !isPlainObject(payload)
    || !hasOnlyKeys(payload, ["consent", "policy"])
    || payload.consent !== true
    || payload.policy !== AI_CONSENT_POLICY
  ) {
    throw new CloudAssistantRequestError(400, "invalid_consent_payload");
  }

  return { consent: true, policy: AI_CONSENT_POLICY };
}

export function validateSemesterContext(value) {
  if (
    !isPlainObject(value)
    || !hasOnlyKeys(value, ["schemaVersion", "generatedAt", "timeZone", "campusDate", "facts"])
    || value.schemaVersion !== SEMESTER_CONTEXT_SCHEMA_VERSION
    || typeof value.generatedAt !== "string"
    || !Number.isFinite(Date.parse(value.generatedAt))
    || new Date(value.generatedAt).toISOString() !== value.generatedAt
    || value.timeZone !== "America/New_York"
    || typeof value.campusDate !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.campusDate)
    || !Array.isArray(value.facts)
    || value.facts.length === 0
    || value.facts.length > MAX_SEMESTER_CONTEXT_FACTS
  ) {
    throw new CloudAssistantRequestError(400, "invalid_semester_context");
  }

  let totalChars = 0;
  const facts = value.facts.map((fact) => {
    if (
      typeof fact !== "string"
      || fact.length === 0
      || fact.length > MAX_SEMESTER_CONTEXT_FACT_CHARS
      || fact.trim() !== fact
      || /[\u0000-\u001f\u007f]/.test(fact)
    ) {
      throw new CloudAssistantRequestError(400, "invalid_semester_fact");
    }
    totalChars += fact.length;
    if (totalChars > MAX_SEMESTER_CONTEXT_CHARS) {
      throw new CloudAssistantRequestError(400, "semester_context_too_long");
    }
    return fact;
  });

  const parsedCampusDate = new Date(`${value.campusDate}T00:00:00.000Z`);
  if (
    Number.isNaN(parsedCampusDate.getTime())
    || parsedCampusDate.toISOString().slice(0, 10) !== value.campusDate
  ) {
    throw new CloudAssistantRequestError(400, "invalid_semester_context_date");
  }

  return {
    schemaVersion: SEMESTER_CONTEXT_SCHEMA_VERSION,
    generatedAt: value.generatedAt,
    timeZone: value.timeZone,
    campusDate: value.campusDate,
    facts,
  };
}

export function validateChatPayload(payload) {
  if (!isPlainObject(payload) || !hasOnlyKeys(payload, ["messages", "context"])) {
    throw new CloudAssistantRequestError(400, "invalid_chat_payload");
  }
  if (
    !Array.isArray(payload.messages)
    || payload.messages.length === 0
    || payload.messages.length > MAX_CHAT_MESSAGES
  ) {
    throw new CloudAssistantRequestError(400, "invalid_messages");
  }

  let totalChars = 0;
  const messages = payload.messages.map((message) => {
    if (
      !isPlainObject(message)
      || !hasOnlyKeys(message, ["id", "role", "parts"])
      || (message.role !== "user" && message.role !== "assistant")
      || !Array.isArray(message.parts)
      || message.parts.length === 0
      || message.parts.length > MAX_TEXT_PARTS_PER_MESSAGE
      || (
        message.id !== undefined
        && (typeof message.id !== "string" || message.id.length === 0 || message.id.length > MAX_MESSAGE_ID_CHARS)
      )
    ) {
      throw new CloudAssistantRequestError(400, "invalid_message");
    }

    const textParts = message.parts.map((part) => {
      if (
        !isPlainObject(part)
        || !hasOnlyKeys(part, ["type", "text"])
        || part.type !== "text"
        || typeof part.text !== "string"
        || part.text.length > MAX_TEXT_PART_CHARS
      ) {
        throw new CloudAssistantRequestError(400, "invalid_message_part");
      }
      totalChars += part.text.length;
      if (totalChars > MAX_CHAT_TEXT_CHARS) {
        throw new CloudAssistantRequestError(400, "chat_too_long");
      }
      return part.text;
    });

    return {
      role: message.role,
      content: textParts.join("\n"),
    };
  });

  const finalMessage = messages.at(-1);
  if (finalMessage.role !== "user" || finalMessage.content.trim().length === 0) {
    throw new CloudAssistantRequestError(400, "final_user_message_required");
  }

  return {
    context: validateSemesterContext(payload.context),
    messages,
  };
}

export function getConsentSigningSecret(environment = process.env) {
  const secret = environment?.AI_CONSENT_SIGNING_SECRET;
  if (
    typeof secret !== "string"
    || Buffer.byteLength(secret, "utf8") < MIN_SIGNING_SECRET_BYTES
  ) {
    return null;
  }
  return secret;
}

const signConsentPayload = (encodedPayload, secret) => createHmac("sha256", secret)
  .update(`${COOKIE_SIGNATURE_CONTEXT}.${encodedPayload}`)
  .digest("base64url");

export function createConsentToken(secret, {
  now = Date.now(),
  nonce = randomBytes(12).toString("base64url"),
} = {}) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < MIN_SIGNING_SECRET_BYTES) {
    throw new TypeError("A signing secret of at least 32 bytes is required");
  }

  const issuedAt = normalizeNowMs(now);
  const expiresAt = issuedAt + (AI_CONSENT_TTL_SECONDS * 1_000);
  const payload = {
    policy: AI_CONSENT_POLICY,
    issuedAt,
    expiresAt,
    nonce,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signConsentPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifyConsentToken(token, secret, { now = Date.now() } = {}) {
  if (
    typeof token !== "string"
    || typeof secret !== "string"
    || Buffer.byteLength(secret, "utf8") < MIN_SIGNING_SECRET_BYTES
  ) {
    return null;
  }

  const segments = token.split(".");
  if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    return null;
  }

  const [encodedPayload, suppliedSignature] = segments;
  const expectedSignature = signConsentPayload(encodedPayload, secret);
  const suppliedBytes = Buffer.from(suppliedSignature, "base64url");
  const expectedBytes = Buffer.from(expectedSignature, "base64url");
  if (
    suppliedBytes.length !== expectedBytes.length
    || !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const nowMs = normalizeNowMs(now);
  if (
    !isPlainObject(payload)
    || payload.policy !== AI_CONSENT_POLICY
    || !Number.isInteger(payload.issuedAt)
    || !Number.isInteger(payload.expiresAt)
    || typeof payload.nonce !== "string"
    || payload.nonce.length === 0
    || payload.issuedAt > nowMs
    || payload.expiresAt <= nowMs
    || payload.expiresAt - payload.issuedAt !== AI_CONSENT_TTL_SECONDS * 1_000
  ) {
    return null;
  }

  return {
    policy: payload.policy,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
}

export function getConsentCookieOptions(request) {
  const origin = getRequestTargetOrigin(request);
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: new URL(origin).protocol === "https:",
    path: "/",
    maxAge: AI_CONSENT_TTL_SECONDS,
  };
}

export function noStoreJson(value, { status = 200, headers } = {}) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export function genericErrorResponse(error, fallbackStatus = 500) {
  const status = error instanceof CloudAssistantRequestError
    ? error.status
    : fallbackStatus;
  const safeStatus = GENERIC_ERROR_MESSAGES[status] ? status : fallbackStatus;
  return noStoreJson(
    { error: GENERIC_ERROR_MESSAGES[safeStatus] || GENERIC_ERROR_MESSAGES[500] },
    {
      status: safeStatus,
      headers: safeStatus === 429 && Number.isInteger(error?.retryAfterSeconds)
        ? { "Retry-After": String(error.retryAfterSeconds) }
        : undefined,
    },
  );
}
