import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PUSH_BODY_BYTES,
  MAX_REMINDERS,
  PushProtocolError,
  readJsonRequest,
  validatePushSubscription,
  validateSyncPayload,
  validateTestPayload,
} from "../server/pushProtocol.js";

const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const REVISION = "a".repeat(64);
const RECEIPT = "r".repeat(16);

function subscription(overrides = {}) {
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/opaque-browser-subscription",
    expirationTime: null,
    keys: {
      p256dh: "P".repeat(87),
      auth: "A".repeat(22),
    },
    ...overrides,
  };
}

function reminder(index = 1, overrides = {}) {
  return {
    id: index.toString(16).padStart(64, "0"),
    type: "assignment-24h",
    remindAt: "2026-08-27T12:00:00.000Z",
    targetAt: "2026-08-28T12:00:00.000Z",
    ...overrides,
  };
}

function syncBody(reminders = [reminder()]) {
  return {
    subscription: subscription(),
    revision: REVISION,
    reminders,
  };
}

test("sync protocol normalizes and sorts only opaque reminder records", () => {
  const later = reminder(2, {
    remindAt: "2026-08-29T12:00:00.000Z",
    targetAt: "2026-08-30T12:00:00.000Z",
  });
  const earlier = reminder(1);
  const result = validateSyncPayload(syncBody([later, earlier]), { now: NOW });

  assert.deepEqual(result.reminders, [earlier, later]);
  assert.equal(result.revision, REVISION);
  assert.equal(result.previousReceipt, null);
  assert.deepEqual(Object.keys(result.reminders[0]).sort(), ["id", "remindAt", "targetAt", "type"]);
});

test("sync protocol rejects descriptive or unknown reminder fields", () => {
  assert.throws(
    () => validateSyncPayload(syncBody([{ ...reminder(), courseName: "Private course" }]), { now: NOW }),
    PushProtocolError,
  );
  assert.throws(
    () => validateSyncPayload({ ...syncBody(), studentName: "Private student" }, { now: NOW }),
    PushProtocolError,
  );
});

test("sync protocol accepts a full 512-occurrence semester and rejects overflow", () => {
  const fullSemester = Array.from({ length: MAX_REMINDERS }, (_, index) => reminder(index + 1));
  assert.equal(validateSyncPayload(syncBody(fullSemester), { now: NOW }).reminders.length, 512);
  assert.throws(
    () => validateSyncPayload(syncBody([...fullSemester, reminder(513)]), { now: NOW }),
    /more than 512/,
  );
});

test("sync protocol requires unique lowercase SHA-256 ids and revision", () => {
  assert.throws(
    () => validateSyncPayload(syncBody([reminder(1), reminder(1)]), { now: NOW }),
    /duplicate ids/,
  );
  assert.throws(
    () => validateSyncPayload({ ...syncBody(), revision: "A".repeat(64) }, { now: NOW }),
    /lowercase SHA-256/,
  );
  assert.throws(
    () => validateSyncPayload(syncBody([reminder(1, { id: "course-1" })]), { now: NOW }),
    /lowercase SHA-256/,
  );
});

test("sync protocol enforces type, time ordering, canonical timestamps, and horizon", () => {
  assert.throws(
    () => validateSyncPayload(syncBody([reminder(1, {
      remindAt: new Date(NOW).toISOString(),
      targetAt: "2026-08-28T12:00:00.000Z",
    })]), { now: NOW }),
    /must be in the future/,
  );
  assert.throws(
    () => validateSyncPayload(syncBody([reminder(1, {
      remindAt: "2026-08-26T11:59:59.999Z",
      targetAt: "2026-08-28T12:00:00.000Z",
    })]), { now: NOW }),
    /must be in the future/,
  );
  assert.throws(
    () => validateSyncPayload(syncBody([reminder(1, { type: "final" })]), { now: NOW }),
    /type is invalid/,
  );
  assert.throws(
    () => validateSyncPayload(syncBody([reminder(1, {
      remindAt: "2026-08-28T12:00:00.000Z",
      targetAt: "2026-08-28T12:00:00.000Z",
    })]), { now: NOW }),
    /must be before/,
  );
  assert.throws(
    () => validateSyncPayload(syncBody([reminder(1, { remindAt: "2026-08-27T12:00:00Z" })]), { now: NOW }),
    /canonical UTC/,
  );
  assert.throws(
    () => validateSyncPayload(syncBody([reminder(1, {
      remindAt: "2027-08-30T12:00:00.000Z",
      targetAt: "2027-09-01T12:00:00.000Z",
    })]), { now: NOW }),
    /370 days/,
  );
});

test("push subscription validation allows known push services and blocks SSRF endpoints", () => {
  const normalized = validatePushSubscription(subscription());
  assert.match(normalized.endpoint, /^https:\/\/fcm\.googleapis\.com\//);

  assert.throws(
    () => validatePushSubscription(subscription({ endpoint: "https://127.0.0.1/internal" })),
    /supported Web Push endpoint/,
  );
  assert.throws(
    () => validatePushSubscription(subscription({ endpoint: "http://fcm.googleapis.com/insecure" })),
    /supported Web Push endpoint/,
  );
});

test("test payload requires a receipt and accepts no bare revision or notification copy", () => {
  assert.deepEqual(validateTestPayload({ subscription: subscription(), receipt: RECEIPT }), {
    subscription: subscription(),
    receipt: RECEIPT,
  });
  assert.throws(
    () => validateTestPayload({ subscription: subscription(), receipt: RECEIPT, body: "hello" }),
    /unsupported field/,
  );
  assert.throws(
    () => validateTestPayload({ subscription: subscription(), revision: REVISION }),
    /unsupported field/,
  );
});

test("JSON reader enforces media type and the 256 KiB byte limit", async () => {
  const validRequest = new Request("https://dashboard.example/api/push/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  });
  assert.deepEqual(await readJsonRequest(validRequest), { ok: true });

  await assert.rejects(
    readJsonRequest(new Request("https://dashboard.example/api/push/sync", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    })),
    (error) => error instanceof PushProtocolError && error.status === 415,
  );

  await assert.rejects(
    readJsonRequest(new Request("https://dashboard.example/api/push/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(MAX_PUSH_BODY_BYTES) }),
    })),
    (error) => error instanceof PushProtocolError && error.status === 413,
  );
});
