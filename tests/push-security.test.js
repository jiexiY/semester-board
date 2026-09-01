import test from "node:test";
import assert from "node:assert/strict";

import {
  PushSecurityError,
  assertSameOriginRequest,
  createPushRateLimiter,
  getTrustedPushClientAddress,
  getVapidPublicKey,
  pushSubscriptionFingerprint,
  receiptExpiryForSchedule,
  requireSigningSecret,
  requireVapidConfig,
  signPushReceipt,
  verifyPushReceipt,
  verifyPushReceiptForSubscription,
} from "../server/pushSecurity.js";

const SECRET = "s".repeat(48);
const REVISION = "a".repeat(64);
const SUBSCRIPTION = {
  endpoint: "https://fcm.googleapis.com/fcm/send/browser-one",
};
const RECEIPT_PAYLOAD = {
  revision: REVISION,
  runIds: ["wrun_01J7EXAMPLE"],
  expiresAt: Date.parse("2026-12-20T00:00:00.000Z"),
  subscriptionHash: pushSubscriptionFingerprint(SUBSCRIPTION, SECRET),
};

test("same-origin verifier accepts a browser POST from the request origin", () => {
  const request = new Request("https://dashboard.example/api/push/sync", {
    method: "POST",
    headers: {
      Origin: "https://dashboard.example",
      "Sec-Fetch-Site": "same-origin",
    },
  });
  assert.equal(assertSameOriginRequest(request), "https://dashboard.example");

  const proxiedRequest = new Request("http://internal-runtime/api/push/sync", {
    headers: {
      Host: "internal-runtime",
      Origin: "https://dashboard.example",
      "Sec-Fetch-Site": "same-origin",
      "X-Forwarded-Host": "dashboard.example",
      "X-Forwarded-Proto": "https",
    },
  });
  assert.equal(assertSameOriginRequest(proxiedRequest), "https://dashboard.example");
});

test("same-origin verifier rejects missing, cross-origin, and cross-site origins", () => {
  assert.throws(
    () => assertSameOriginRequest(new Request("https://dashboard.example/api/push/sync")),
    PushSecurityError,
  );
  assert.throws(
    () => assertSameOriginRequest(new Request("https://dashboard.example/api/push/sync", {
      headers: { Origin: "https://attacker.example" },
    })),
    PushSecurityError,
  );
  assert.throws(
    () => assertSameOriginRequest(new Request("https://dashboard.example/api/push/sync", {
      headers: { Origin: "https://dashboard.example", "Sec-Fetch-Site": "cross-site" },
    })),
    PushSecurityError,
  );
});

test("HMAC receipt round-trips its revision, run ids, expiry, and subscription fingerprint", () => {
  const token = signPushReceipt(RECEIPT_PAYLOAD, SECRET);
  const verified = verifyPushReceipt(token, SECRET, {
    now: Date.parse("2026-08-26T00:00:00.000Z"),
  });
  assert.deepEqual(verified, { v: 1, ...RECEIPT_PAYLOAD });
  assert.equal(token.split(".").length, 3);
});

test("HMAC receipt is bound to the push subscription endpoint", () => {
  const token = signPushReceipt(RECEIPT_PAYLOAD, SECRET);
  assert.equal(
    verifyPushReceiptForSubscription(token, SUBSCRIPTION, SECRET, {
      now: Date.parse("2026-08-26T00:00:00.000Z"),
    }).revision,
    REVISION,
  );
  assert.throws(
    () => verifyPushReceiptForSubscription(token, {
      endpoint: "https://fcm.googleapis.com/fcm/send/browser-two",
    }, SECRET),
    (error) => error instanceof PushSecurityError && error.code === "invalid_receipt",
  );
});

test("HMAC receipt rejects tampering, another secret, and expiration", () => {
  const token = signPushReceipt(RECEIPT_PAYLOAD, SECRET);
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => verifyPushReceipt(tampered, SECRET), /Receipt is invalid/);
  assert.throws(() => verifyPushReceipt(token, "x".repeat(48)), /Receipt is invalid/);
  assert.throws(
    () => verifyPushReceipt(token, SECRET, { now: RECEIPT_PAYLOAD.expiresAt }),
    (error) => error instanceof PushSecurityError && error.code === "expired_receipt",
  );
});

test("receipt creation rejects weak secrets and malformed run ids", () => {
  assert.throws(
    () => signPushReceipt(RECEIPT_PAYLOAD, "short"),
    (error) => error instanceof PushSecurityError && error.status === 503,
  );
  assert.throws(
    () => signPushReceipt({ ...RECEIPT_PAYLOAD, runIds: ["bad run id"] }, SECRET),
    /Receipt is invalid/,
  );
});

test("environment helpers validate signing and VAPID material without exposing private data", () => {
  const environment = {
    PUSH_SIGNING_SECRET: SECRET,
    VAPID_PUBLIC_KEY: "P".repeat(87),
    VAPID_PRIVATE_KEY: "p".repeat(43),
    VAPID_SUBJECT: "mailto:reminders@example.com",
  };
  assert.equal(requireSigningSecret(environment), SECRET);
  assert.equal(getVapidPublicKey(environment), environment.VAPID_PUBLIC_KEY);
  assert.deepEqual(requireVapidConfig(environment), {
    publicKey: environment.VAPID_PUBLIC_KEY,
    privateKey: environment.VAPID_PRIVATE_KEY,
    subject: environment.VAPID_SUBJECT,
  });
  assert.throws(() => requireVapidConfig({}), /not configured/);
});

test("receipt expiry extends one day past the last target", () => {
  const now = Date.parse("2026-08-26T00:00:00.000Z");
  assert.equal(receiptExpiryForSchedule([
    { targetAt: "2026-09-01T00:00:00.000Z" },
    { targetAt: "2026-12-10T00:00:00.000Z" },
  ], { now }), Date.parse("2026-12-11T00:00:00.000Z"));
  assert.equal(receiptExpiryForSchedule([], { now }), now + 24 * 60 * 60 * 1000);
});

test("push limiter bounds subscription and IP requests without storing raw identifiers", () => {
  const store = new Map();
  const limit = createPushRateLimiter({
    limits: {
      test: [
        { scope: "subscription", limit: 2, windowMs: 60_000 },
        { scope: "ip", limit: 3, windowMs: 60_000 },
      ],
    },
    store,
  });
  const request = new Request("https://dashboard.example/api/push/test", {
    headers: { "X-Vercel-Forwarded-For": "203.0.113.10" },
  });
  assert.equal(getTrustedPushClientAddress(request), "203.0.113.10");

  limit({ action: "test", request, secret: SECRET, subscription: SUBSCRIPTION, now: 1_000 });
  limit({ action: "test", request, secret: SECRET, subscription: SUBSCRIPTION, now: 1_001 });
  assert.throws(
    () => limit({ action: "test", request, secret: SECRET, subscription: SUBSCRIPTION, now: 1_002 }),
    (error) => error instanceof PushSecurityError
      && error.status === 429
      && error.retryAfterSeconds === 60,
  );
  assert.equal([...store.keys()].some((key) => key.includes(SUBSCRIPTION.endpoint)), false);
  assert.equal([...store.keys()].some((key) => key.includes("203.0.113.10")), false);

  assert.doesNotThrow(() => limit({
    action: "test",
    request,
    secret: SECRET,
    subscription: SUBSCRIPTION,
    now: 61_001,
  }));
});

test("push limiter rejects safely when its bounded warm-instance store is full", () => {
  const limit = createPushRateLimiter({
    limits: { sync: [{ scope: "subscription", limit: 10, windowMs: 60_000 }] },
    maxEntries: 1,
  });
  const request = new Request("https://dashboard.example/api/push/sync");
  limit({ action: "sync", request, secret: SECRET, subscription: SUBSCRIPTION, now: 1_000 });
  assert.throws(
    () => limit({
      action: "sync",
      request,
      secret: SECRET,
      subscription: { endpoint: `${SUBSCRIPTION.endpoint}-two` },
      now: 1_001,
    }),
    (error) => error instanceof PushSecurityError
      && error.code === "rate_limit_capacity"
      && error.status === 429,
  );
});
