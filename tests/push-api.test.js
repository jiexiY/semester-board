import test from "node:test";
import assert from "node:assert/strict";

import { createPushTestHandler } from "../api/push/test.post.js";
import {
  PushSecurityError,
  pushSubscriptionFingerprint,
  signPushReceipt,
} from "../server/pushSecurity.js";

const ORIGIN = "https://dashboard.example";
const NOW = Date.parse("2026-08-26T14:00:00.000Z");
const REVISION = "a".repeat(64);
const ENVIRONMENT = {
  PUSH_SIGNING_SECRET: "s".repeat(48),
  VAPID_PUBLIC_KEY: "P".repeat(87),
  VAPID_PRIVATE_KEY: "p".repeat(43),
  VAPID_SUBJECT: "mailto:reminders@example.com",
};

function subscription(endpoint = "https://fcm.googleapis.com/fcm/send/browser-one") {
  return {
    endpoint,
    expirationTime: null,
    keys: {
      p256dh: "P".repeat(87),
      auth: "A".repeat(22),
    },
  };
}

function receiptFor(pushSubscription = subscription()) {
  return signPushReceipt({
    expiresAt: NOW + 60_000,
    revision: REVISION,
    runIds: ["wrun_api_test"],
    subscriptionHash: pushSubscriptionFingerprint(
      pushSubscription,
      ENVIRONMENT.PUSH_SIGNING_SECRET,
    ),
  }, ENVIRONMENT.PUSH_SIGNING_SECRET);
}

function request(body) {
  return new Request(`${ORIGIN}/api/push/test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "X-Vercel-Forwarded-For": "203.0.113.12",
    },
    body: JSON.stringify(body),
  });
}

test("push test verifies a subscription-bound receipt and derives its signed revision", async () => {
  const pushSubscription = subscription();
  const events = [];
  const handler = createPushTestHandler({
    environment: ENVIRONMENT,
    now: () => NOW,
    rateLimit: async ({ action, subscription: limitedSubscription }) => {
      await Promise.resolve();
      events.push(`rate:${action}:${limitedSubscription.endpoint}`);
    },
    send: async (sentSubscription, revision, vapid) => {
      events.push(`send:${revision}`);
      assert.deepEqual(sentSubscription, pushSubscription);
      assert.equal(vapid.privateKey, ENVIRONMENT.VAPID_PRIVATE_KEY);
      return { status: "sent" };
    },
  });

  const response = await handler.fetch(request({
    receipt: receiptFor(pushSubscription),
    subscription: pushSubscription,
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(events, [
    `rate:test:${pushSubscription.endpoint}`,
    `send:${REVISION}`,
  ]);
});

test("push test rejects a bare revision and a receipt for another subscription", async () => {
  const pushSubscription = subscription();
  let invoked = false;
  const handler = createPushTestHandler({
    environment: ENVIRONMENT,
    now: () => NOW,
    rateLimit: async () => { invoked = true; },
    send: async () => { invoked = true; return { status: "sent" }; },
  });

  const bareRevision = await handler.fetch(request({
    revision: REVISION,
    subscription: pushSubscription,
  }));
  assert.equal(bareRevision.status, 400);

  const otherSubscriptionReceipt = receiptFor(subscription(
    "https://fcm.googleapis.com/fcm/send/browser-two",
  ));
  const replay = await handler.fetch(request({
    receipt: otherSubscriptionReceipt,
    subscription: pushSubscription,
  }));
  assert.equal(replay.status, 401);
  assert.equal(invoked, false);
});

test("push test awaits an asynchronous limiter rejection and returns Retry-After", async () => {
  let sent = false;
  const handler = createPushTestHandler({
    environment: ENVIRONMENT,
    now: () => NOW,
    rateLimit: async () => {
      await Promise.resolve();
      throw new PushSecurityError("Too many push requests. Try again later.", {
        code: "rate_limited",
        retryAfterSeconds: 17,
        status: 429,
      });
    },
    send: async () => { sent = true; return { status: "sent" }; },
  });
  const pushSubscription = subscription();
  const response = await handler.fetch(request({
    receipt: receiptFor(pushSubscription),
    subscription: pushSubscription,
  }));

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "17");
  assert.equal((await response.json()).error, "rate_limited");
  assert.equal(sent, false);
});
