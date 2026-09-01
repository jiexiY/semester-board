import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import {
  canAutomaticallySyncPushSettings,
  canClaimLegacyPushSettings,
  createPushOwnerSignal,
  genericPushReminderCopy,
  isSchedulablePushReminder,
  mergeLegacyPushSettings,
  pushOwnerSignalDisplacesProfile,
  pushSettingsBelongToProfile,
  updateExistingServiceWorker,
} from "../src/lib/pushClient.js";

const NOW = Date.parse("2026-08-26T14:00:00.000Z");

async function dispatchServiceWorkerPush({ profileId }) {
  const notifications = [];
  const listeners = new Map();
  const id = "a".repeat(64);
  const revision = "b".repeat(64);
  const targetAt = new Date(Date.now() + 60_000).toISOString();
  const state = {
    enabled: true,
    revision,
    ...(profileId === undefined ? {} : { profileId }),
  };
  const detail = {
    body: "Open the dashboard and sign in to view the class details.",
    id,
    targetAt,
    title: "Class reminder",
    url: "/#attendance",
  };

  function requestWithResult(result) {
    const request = {};
    queueMicrotask(() => {
      request.result = result;
      request.onsuccess?.();
    });
    return request;
  }

  const database = {
    close() {},
    transaction() {
      return {
        objectStore(storeName) {
          return {
            get() {
              return requestWithResult(storeName === "state" ? state : detail);
            },
          };
        },
      };
    },
  };
  const indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = database;
        request.onsuccess?.();
      });
      return request;
    },
  };
  const workerScope = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    clients: {
      claim: async () => {},
      matchAll: async () => [],
      openWindow: async () => null,
    },
    location: { origin: "https://fall-2026-quest.vercel.app" },
    registration: {
      showNotification: async (...args) => notifications.push(args),
    },
    skipWaiting() {},
  };
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    Date,
    Promise,
    Set,
    URL,
    indexedDB,
    queueMicrotask,
    self: workerScope,
  });

  let pushTask;
  listeners.get("push")({
    data: {
      json: () => ({
        id,
        revision,
        targetAt,
        type: "class-1h",
        v: 1,
      }),
    },
    waitUntil(task) {
      pushTask = task;
    },
  });
  await pushTask;
  return notifications;
}

test("client schedules only reminders strictly after the current instant", () => {
  const reminder = {
    remindAt: new Date(NOW + 1).toISOString(),
    targetAt: new Date(NOW + 60_000).toISOString(),
  };
  assert.equal(isSchedulablePushReminder(reminder, NOW), true);
  assert.equal(isSchedulablePushReminder({
    ...reminder,
    remindAt: new Date(NOW).toISOString(),
  }, NOW), false);
  assert.equal(isSchedulablePushReminder({
    ...reminder,
    remindAt: new Date(NOW - 1).toISOString(),
  }, NOW), false);
});

test("current IndexedDB receipt state wins over the legacy localStorage mirror", () => {
  const durable = {
    enabled: true,
    endpointHash: "durable-endpoint",
    receipt: "durable-receipt",
    revision: "durable-revision",
  };
  assert.equal(mergeLegacyPushSettings(durable, {
    endpointHash: "legacy-endpoint",
    receipt: "legacy-receipt",
    revision: "legacy-revision",
  }), durable);
});

test("old IndexedDB records migrate a complete legacy receipt exactly once", () => {
  assert.deepEqual(mergeLegacyPushSettings({ enabled: true, revision: "old" }, {
    endpointHash: "endpoint",
    receipt: "receipt",
    revision: "revision",
  }), {
    enabled: true,
    endpointHash: "endpoint",
    receipt: "receipt",
    revision: "revision",
  });
});

test("push settings belong only to their exact valid local profile", () => {
  assert.equal(pushSettingsBelongToProfile({ profileId: "profile_alpha" }, "profile_alpha"), true);
  assert.equal(pushSettingsBelongToProfile({ profileId: "profile_alpha" }, "profile_beta"), false);
  assert.equal(pushSettingsBelongToProfile({}, "profile_alpha"), false);
  assert.equal(pushSettingsBelongToProfile(null, "profile_alpha"), false);
  assert.equal(pushSettingsBelongToProfile({ profileId: "profile_alpha" }, "bad"), false);
});

test("automatic push refresh preserves the current profile owner", () => {
  const owned = { enabled: true, profileId: "profile_alpha" };
  assert.equal(canAutomaticallySyncPushSettings(owned, "profile_alpha"), true);
  assert.equal(canAutomaticallySyncPushSettings(owned, "profile_beta"), false);
  assert.equal(canAutomaticallySyncPushSettings({ ...owned, enabled: false }, "profile_alpha"), false);
  assert.equal(canAutomaticallySyncPushSettings({ enabled: true }, "profile_alpha"), false);
});

test("push owner signals notify losing profiles and same-profile disable tabs", () => {
  const takeover = createPushOwnerSignal({
    ownerProfileId: "profile_beta",
    previousOwnerProfileId: "profile_alpha",
    nonce: "takeover",
  });
  assert.equal(pushOwnerSignalDisplacesProfile(takeover, "profile_alpha"), true);
  assert.equal(pushOwnerSignalDisplacesProfile(takeover, "profile_beta"), false);
  assert.equal(pushOwnerSignalDisplacesProfile(takeover, "profile_gamma"), false);

  const disabled = createPushOwnerSignal({
    ownerProfileId: null,
    previousOwnerProfileId: "profile_beta",
    nonce: "disabled",
  });
  assert.equal(pushOwnerSignalDisplacesProfile(disabled, "profile_alpha"), false);
  assert.equal(pushOwnerSignalDisplacesProfile(disabled, "profile_beta"), true);
  assert.equal(pushOwnerSignalDisplacesProfile("{bad json", "profile_beta"), false);
});

test("existing service workers are updated without registering a new worker", async () => {
  const calls = [];
  const updated = await updateExistingServiceWorker({
    serviceWorker: {
      getRegistration: async (scope) => {
        calls.push(["get", scope]);
        return { update: async () => calls.push(["update"]) };
      },
      register: async () => calls.push(["register"]),
    },
  });
  assert.equal(updated, true);
  assert.deepEqual(calls, [["get", "/"], ["update"]]);
  assert.equal(await updateExistingServiceWorker({ serviceWorker: { getRegistration: async () => null } }), false);
});

test("legacy push ownership can be claimed only by the profile that received matching mirrors", () => {
  const settings = {
    enabled: true,
    endpointHash: "endpoint",
    receipt: "receipt",
    revision: "revision",
  };
  const matchingMirror = {
    endpointHash: "endpoint",
    receipt: "receipt",
    revision: "revision",
  };

  assert.equal(canClaimLegacyPushSettings(
    settings,
    matchingMirror,
    "profile_alpha",
    "profile_alpha",
  ), true);
  assert.equal(canClaimLegacyPushSettings(
    settings,
    matchingMirror,
    "profile_alpha",
    "profile_beta",
  ), false);
  assert.equal(canClaimLegacyPushSettings(
    settings,
    { ...matchingMirror, receipt: null },
    "profile_alpha",
    "profile_alpha",
  ), false);
});

test("generic locked-screen copy maps every supported reminder type without course details", () => {
  assert.deepEqual(genericPushReminderCopy("class-1h"), {
    body: "Open the dashboard and sign in to view the class details.",
    title: "Class reminder",
  });
  assert.deepEqual(genericPushReminderCopy("assignment-24h"), {
    body: "Open the dashboard and sign in to view the assignment details.",
    title: "Assignment reminder",
  });
  assert.deepEqual(genericPushReminderCopy("exam-7d"), {
    body: "Open the dashboard and sign in to view the exam details.",
    title: "Exam reminder",
  });
  assert.deepEqual(genericPushReminderCopy("unexpected"), {
    body: "Open the dashboard and sign in to view the reminder details.",
    title: "Semester reminder",
  });
});

test("service worker suppresses legacy and malformed unowned push state", async () => {
  assert.equal((await dispatchServiceWorkerPush({ profileId: undefined })).length, 0);
  assert.equal((await dispatchServiceWorkerPush({ profileId: "bad" })).length, 0);
});

test("service worker still shows reminders owned by a valid local profile", async () => {
  const notifications = await dispatchServiceWorkerPush({ profileId: "profile_alpha" });
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0][0], "Class reminder");
  assert.deepEqual(notifications[0][1].body, "Open the dashboard and sign in to view the class details.");
});
