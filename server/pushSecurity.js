import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/;
const VAPID_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_RECEIPT_RUNS = 8;
const MAX_TOKEN_LENGTH = 32 * 1024;
const MIN_SECRET_BYTES = 32;
export const PUSH_RATE_LIMIT_MAX_ENTRIES = 4_096;
export const PUSH_RATE_LIMITS = Object.freeze({
  sync: Object.freeze([
    Object.freeze({ scope: "subscription", limit: 8, windowMs: 60_000 }),
    Object.freeze({ scope: "ip", limit: 30, windowMs: 60_000 }),
  ]),
  test: Object.freeze([
    Object.freeze({ scope: "subscription", limit: 5, windowMs: 60_000 }),
    Object.freeze({ scope: "ip", limit: 30, windowMs: 60_000 }),
  ]),
});

export class PushSecurityError extends Error {
  constructor(message, {
    code = "forbidden",
    status = 403,
    retryAfterSeconds,
  } = {}) {
    super(message);
    this.name = "PushSecurityError";
    this.code = code;
    this.status = status;
    if (Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

function securityFail(message, options) {
  throw new PushSecurityError(message, options);
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    securityFail("Receipt is invalid.", { code: "invalid_receipt", status: 401 });
  }
  try {
    return Buffer.from(value, "base64url");
  } catch {
    securityFail("Receipt is invalid.", { code: "invalid_receipt", status: 401 });
  }
}

export function requireSigningSecret(environment = process.env) {
  const secret = environment.PUSH_SIGNING_SECRET;
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    securityFail("Push receipt signing is not configured.", {
      code: "push_not_configured",
      status: 503,
    });
  }
  return secret;
}

export function getVapidPublicKey(environment = process.env) {
  const publicKey = environment.VAPID_PUBLIC_KEY;
  if (
    typeof publicKey !== "string"
    || publicKey.length !== 87
    || !VAPID_KEY_PATTERN.test(publicKey)
  ) {
    securityFail("Web Push is not configured.", {
      code: "push_not_configured",
      status: 503,
    });
  }
  return publicKey;
}

export function requireVapidConfig(environment = process.env) {
  const publicKey = getVapidPublicKey(environment);
  const privateKey = environment.VAPID_PRIVATE_KEY;
  const subject = environment.VAPID_SUBJECT;

  if (
    typeof privateKey !== "string"
    || privateKey.length !== 43
    || !VAPID_KEY_PATTERN.test(privateKey)
  ) {
    securityFail("Web Push is not configured.", {
      code: "push_not_configured",
      status: 503,
    });
  }

  let subjectUrl;
  try {
    subjectUrl = new URL(subject);
  } catch {
    securityFail("Web Push is not configured.", {
      code: "push_not_configured",
      status: 503,
    });
  }
  if (subjectUrl.protocol !== "mailto:" && subjectUrl.protocol !== "https:") {
    securityFail("Web Push is not configured.", {
      code: "push_not_configured",
      status: 503,
    });
  }

  return { publicKey, privateKey, subject };
}

function firstForwardedValue(value) {
  return value?.split(",", 1)[0]?.trim() || null;
}

export function getTrustedPushClientAddress(request) {
  const value = firstForwardedValue(
    request.headers.get("x-vercel-forwarded-for")
      || request.headers.get("x-forwarded-for")
      || request.headers.get("x-real-ip"),
  );
  return value ? value.slice(0, 128) : "unknown";
}

function pushRateLimitDigest(secret, action, scope, value) {
  return createHmac("sha256", secret)
    .update(`fall-2026-quest.push-rate-limit.v1.${action}.${scope}.${value}`)
    .digest("base64url");
}

export function pushSubscriptionFingerprint(subscription, secret) {
  if (typeof subscription?.endpoint !== "string") {
    throw new TypeError("A validated push subscription is required.");
  }
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    throw new TypeError("A signing secret of at least 32 bytes is required.");
  }
  return createHmac("sha256", secret)
    .update(`fall-2026-quest.push-subscription.v1.${subscription.endpoint}`)
    .digest("base64url");
}

/**
 * A bounded warm-instance abuse brake. This deliberately does not claim to be
 * a distributed quota or WAF: buckets reset on cold starts and are not shared
 * between concurrent Vercel instances.
 */
export function createPushRateLimiter({
  limits = PUSH_RATE_LIMITS,
  store = new Map(),
  maxEntries = PUSH_RATE_LIMIT_MAX_ENTRIES,
} = {}) {
  return ({
    action,
    request,
    subscription,
    secret,
    now = Date.now(),
  }) => {
    const rules = limits[action];
    const nowMs = Number(now);
    if (!Array.isArray(rules) || !Number.isFinite(nowMs)) {
      throw new TypeError("A valid push rate-limit action and timestamp are required.");
    }
    if (typeof subscription?.endpoint !== "string") {
      throw new TypeError("A validated push subscription is required.");
    }
    if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
      throw new TypeError("A signing secret of at least 32 bytes is required.");
    }

    for (const [key, record] of store) {
      if (!record || record.resetAt <= nowMs) store.delete(key);
    }

    const identities = {
      ip: getTrustedPushClientAddress(request),
      subscription: subscription.endpoint,
    };
    const pending = rules.map((rule) => {
      const identity = identities[rule.scope];
      if (typeof identity !== "string") throw new TypeError("Invalid push rate-limit scope.");
      const key = pushRateLimitDigest(
        secret,
        action,
        `${rule.scope}:${rule.windowMs}`,
        identity,
      );
      const current = store.get(key);
      const record = current && current.resetAt > nowMs
        ? current
        : { count: 0, resetAt: nowMs + rule.windowMs };
      return { key, record, rule };
    });

    const additionalEntries = pending.reduce(
      (count, item) => count + (store.has(item.key) ? 0 : 1),
      0,
    );
    if (store.size + additionalEntries > maxEntries) {
      securityFail("Too many push requests. Try again later.", {
        code: "rate_limit_capacity",
        status: 429,
        retryAfterSeconds: 60,
      });
    }

    for (const { record, rule } of pending) {
      if (record.count >= rule.limit) {
        securityFail("Too many push requests. Try again later.", {
          code: "rate_limited",
          status: 429,
          retryAfterSeconds: Math.max(1, Math.ceil((record.resetAt - nowMs) / 1_000)),
        });
      }
    }
    for (const { key, record } of pending) {
      store.set(key, { count: record.count + 1, resetAt: record.resetAt });
    }
  };
}

export const consumePushRateLimit = createPushRateLimiter();

function requestTargetOrigin(request) {
  const requestUrl = new URL(request.url);
  const forwardedHost = firstForwardedValue(request.headers.get("x-forwarded-host"));
  const forwardedProtocol = firstForwardedValue(request.headers.get("x-forwarded-proto"));
  const host = forwardedHost || request.headers.get("host") || requestUrl.host;
  const protocol = (forwardedProtocol || requestUrl.protocol).replace(/:$/, "").toLowerCase();
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return requestUrl.origin;
  }
}

export function assertSameOriginRequest(request) {
  if (!(request instanceof Request)) {
    securityFail("Request could not be verified.");
  }

  let requestUrl;
  try {
    requestUrl = new URL(request.url);
  } catch {
    securityFail("Request could not be verified.");
  }
  if (requestUrl.protocol !== "https:" && requestUrl.protocol !== "http:") {
    securityFail("Request could not be verified.");
  }
  const targetOrigin = requestTargetOrigin(request);

  const origin = request.headers.get("origin");
  if (!origin || origin === "null") securityFail("A same-origin request is required.");

  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    securityFail("A same-origin request is required.");
  }
  if (originUrl.origin !== targetOrigin) {
    securityFail("A same-origin request is required.");
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    securityFail("A same-origin request is required.");
  }
  return targetOrigin;
}

function normalizeReceiptPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    securityFail("Receipt is invalid.", { code: "invalid_receipt", status: 401 });
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 5
    || keys.some((key) => ![
      "v",
      "revision",
      "runIds",
      "expiresAt",
      "subscriptionHash",
    ].includes(key))
  ) {
    securityFail("Receipt is invalid.", { code: "invalid_receipt", status: 401 });
  }
  if (value.v !== 1 || typeof value.revision !== "string" || !HASH_PATTERN.test(value.revision)) {
    securityFail("Receipt is invalid.", { code: "invalid_receipt", status: 401 });
  }
  if (
    !Array.isArray(value.runIds)
    || value.runIds.length > MAX_RECEIPT_RUNS
    || value.runIds.some((runId) => typeof runId !== "string" || !RUN_ID_PATTERN.test(runId))
    || new Set(value.runIds).size !== value.runIds.length
  ) {
    securityFail("Receipt is invalid.", { code: "invalid_receipt", status: 401 });
  }
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) {
    securityFail("Receipt is invalid.", { code: "invalid_receipt", status: 401 });
  }
  if (typeof value.subscriptionHash !== "string" || !FINGERPRINT_PATTERN.test(value.subscriptionHash)) {
    securityFail("Receipt is invalid.", { code: "invalid_receipt", status: 401 });
  }
  return {
    v: 1,
    revision: value.revision,
    runIds: [...value.runIds],
    expiresAt: value.expiresAt,
    subscriptionHash: value.subscriptionHash,
  };
}

export function signPushReceipt({ revision, runIds, expiresAt, subscriptionHash }, secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    securityFail("Push receipt signing is not configured.", {
      code: "push_not_configured",
      status: 503,
    });
  }
  const payload = normalizeReceiptPayload({
    v: 1,
    revision,
    runIds,
    expiresAt,
    subscriptionHash,
  });
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `v1.${encodedPayload}.${signature}`;
}

export function verifyPushReceipt(token, secret, { now = Date.now() } = {}) {
  if (
    typeof token !== "string"
    || token.length > MAX_TOKEN_LENGTH
    || typeof secret !== "string"
    || Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES
  ) {
    securityFail("Receipt is invalid.", { code: "invalid_receipt", status: 401 });
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    securityFail("Receipt is invalid.", { code: "invalid_receipt", status: 401 });
  }

  const expected = createHmac("sha256", secret).update(parts[1]).digest();
  const received = base64UrlDecode(parts[2]);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    securityFail("Receipt is invalid.", { code: "invalid_receipt", status: 401 });
  }

  let parsed;
  try {
    parsed = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
  } catch {
    securityFail("Receipt is invalid.", { code: "invalid_receipt", status: 401 });
  }
  const payload = normalizeReceiptPayload(parsed);
  if (payload.expiresAt <= now) {
    securityFail("Receipt has expired.", { code: "expired_receipt", status: 401 });
  }
  return payload;
}

export function verifyPushReceiptForSubscription(
  token,
  subscription,
  secret,
  options,
) {
  const payload = verifyPushReceipt(token, secret, options);
  const expected = Buffer.from(pushSubscriptionFingerprint(subscription, secret), "utf8");
  const received = Buffer.from(payload.subscriptionHash, "utf8");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    securityFail("Receipt does not match this push subscription.", {
      code: "invalid_receipt",
      status: 401,
    });
  }
  return payload;
}

export function receiptExpiryForSchedule(reminders, { now = Date.now() } = {}) {
  const latestTarget = reminders.reduce((latest, reminder) => {
    const epoch = Date.parse(reminder.targetAt);
    return Number.isFinite(epoch) ? Math.max(latest, epoch) : latest;
  }, now);
  return Math.max(now + 24 * 60 * 60 * 1000, latestTarget + 24 * 60 * 60 * 1000);
}
