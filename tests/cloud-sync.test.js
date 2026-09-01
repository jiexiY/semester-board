import test from "node:test";
import assert from "node:assert/strict";

import {
  CLOUD_CACHE_SCHEMA_VERSION,
  CLOUD_SYNC_RESOURCES,
  cloudResourceCacheKey,
  isRetryableCloudSyncError,
  mergeCloudResource,
  readCloudResourceCache,
  reconcileAuthoritativeRecord,
  reconcileCachedRecord,
  removeCloudResourceCache,
  remoteRowToRecord,
  sanitizeCloudResource,
  threeWayMerge,
  writeCloudResourceCache,
} from "../src/lib/cloudSync.js";
import { PROFILE_RESOURCES } from "../src/lib/profileStorage.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

class MemoryStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test("cloud sync exposes an explicit resource allowlist", () => {
  assert.deepEqual(CLOUD_SYNC_RESOURCES, [
    PROFILE_RESOURCES.dashboard,
    PROFILE_RESOURCES.assistant,
    PROFILE_RESOURCES.cloudChat,
  ]);
  assert.equal(Object.isFrozen(CLOUD_SYNC_RESOURCES), true);

  for (const resource of [
    PROFILE_RESOURCES.cloudConsent,
    PROFILE_RESOURCES.pushEndpoint,
    PROFILE_RESOURCES.pushReceipt,
    PROFILE_RESOURCES.pushRevision,
  ]) {
    assert.throws(
      () => sanitizeCloudResource(resource, {}),
      /cannot be synchronized/,
    );
    assert.throws(
      () => cloudResourceCacheKey(USER_A, resource),
      /cannot be cached/,
    );
  }
});

test("cloud sync retries only transient failures", () => {
  assert.equal(isRetryableCloudSyncError({ status: 429 }), true);
  assert.equal(isRetryableCloudSyncError({ status: 503 }), true);
  assert.equal(isRetryableCloudSyncError({ code: "08006" }), true);
  assert.equal(isRetryableCloudSyncError(new Error("Network request failed")), true);
  assert.equal(isRetryableCloudSyncError({ code: "42501", message: "permission denied" }), false);
  assert.equal(isRetryableCloudSyncError({ code: "23514", message: "check violation" }), false);
});

test("three-way merge combines disjoint local and remote edits", () => {
  const base = {
    completedAssignments: { "canvas-10": false },
    courseConfig: { encMeetings: [], syaSection: null },
  };
  const local = {
    completedAssignments: { "canvas-10": true },
    courseConfig: { encMeetings: [], syaSection: null },
  };
  const remote = {
    completedAssignments: { "canvas-10": false },
    courseConfig: { encMeetings: [], syaSection: "section-2" },
  };

  const merged = threeWayMerge(base, local, remote);

  assert.deepEqual(merged, {
    conflicts: [],
    value: {
      completedAssignments: { "canvas-10": true },
      courseConfig: { encMeetings: [], syaSection: "section-2" },
    },
  });
  assert.deepEqual(base.courseConfig, { encMeetings: [], syaSection: null });
});

test("reconcileCachedRecord preserves local state and records remote conflict metadata", () => {
  const base = {
    assignmentOverrides: { "canvas-20": { dueAt: "2026-09-01T16:00:00Z" } },
  };
  const local = {
    assignmentOverrides: { "canvas-20": { dueAt: "2026-09-02T16:00:00Z" } },
  };
  const remotePayload = {
    assignmentOverrides: { "canvas-20": { dueAt: "2026-09-03T16:00:00Z" } },
  };
  const cache = {
    base,
    conflict: null,
    dirty: true,
    localVersion: 7,
    payload: local,
    resource: PROFILE_RESOURCES.dashboard,
    revision: 4,
    updatedAt: "2026-08-28T14:00:00.000Z",
    userId: USER_A,
  };
  const remote = {
    base: remotePayload,
    conflict: null,
    dirty: false,
    localVersion: 0,
    payload: remotePayload,
    resource: PROFILE_RESOURCES.dashboard,
    revision: 5,
    updatedAt: "2026-08-28T15:00:00.000Z",
    userId: USER_A,
  };

  const reconciled = reconcileCachedRecord(cache, remote);

  assert.deepEqual(reconciled.payload, local);
  assert.equal(reconciled.localVersion, 7);
  assert.equal(reconciled.revision, 4);
  assert.equal(reconciled.updatedAt, "2026-08-28T14:00:00.000Z");
  assert.deepEqual(reconciled.conflict, {
    base,
    paths: ["assignmentOverrides.canvas-20.dueAt"],
    remote: remotePayload,
    remoteRevision: 5,
    remoteUpdatedAt: "2026-08-28T15:00:00.000Z",
  });

  remotePayload.assignmentOverrides["canvas-20"].dueAt = "mutated-after-reconcile";
  assert.equal(
    reconciled.conflict.remote.assignmentOverrides["canvas-20"].dueAt,
    "2026-09-03T16:00:00Z",
  );
});

test("reconcileCachedRecord never rolls a device back to a stale remote revision", () => {
  const cache = {
    base: { completedAssignments: { newer: true } },
    conflict: null,
    dirty: false,
    localVersion: 3,
    payload: { completedAssignments: { newer: true } },
    resource: PROFILE_RESOURCES.dashboard,
    revision: 9,
    updatedAt: "2026-08-28T18:00:00.000Z",
    userId: USER_A,
  };
  const staleRemote = {
    ...cache,
    base: { completedAssignments: { newer: false } },
    localVersion: 0,
    payload: { completedAssignments: { newer: false } },
    revision: 8,
    updatedAt: "2026-08-28T17:59:00.000Z",
  };

  assert.equal(reconcileCachedRecord(cache, staleRemote), cache);
  assert.equal(reconcileAuthoritativeRecord(cache, staleRemote), staleRemote);
  assert.deepEqual(reconcileAuthoritativeRecord({ ...cache, dirty: true }, staleRemote).conflict, {
    base: cache.base,
    paths: ["cloud record generation"],
    remote: staleRemote.payload,
    remoteRevision: 8,
    remoteUpdatedAt: "2026-08-28T17:59:00.000Z",
  });
});

test("authoritative remote absence removes clean cache and preserves unsent work for review", () => {
  const clean = {
    base: { completedAssignments: { one: true } },
    conflict: null,
    dirty: false,
    localVersion: 1,
    payload: { completedAssignments: { one: true } },
    resource: PROFILE_RESOURCES.dashboard,
    revision: 3,
    updatedAt: "2026-08-28T18:00:00.000Z",
    userId: USER_A,
  };

  assert.equal(reconcileCachedRecord(clean, null), null);
  assert.deepEqual(reconcileCachedRecord({ ...clean, dirty: true }, null).conflict, {
    base: clean.base,
    paths: ["cloud record"],
    remote: null,
    remoteRevision: 0,
    remoteUpdatedAt: null,
  });
  assert.equal(reconcileCachedRecord({ ...clean, dirty: true, revision: 0 }, null).conflict, null);
});

test("three-way merge applies unopposed deletion and flags delete-versus-edit", () => {
  const base = {
    assignmentOverrides: {
      deleted: { dueAt: "2026-09-01T16:00:00Z" },
      kept: { dueAt: "2026-09-04T16:00:00Z" },
    },
  };
  const local = {
    assignmentOverrides: {
      kept: { dueAt: "2026-09-04T16:00:00Z" },
    },
  };

  const unopposed = threeWayMerge(base, local, {
    assignmentOverrides: {
      deleted: { dueAt: "2026-09-01T16:00:00Z" },
      kept: { dueAt: "2026-09-05T16:00:00Z" },
    },
  });
  assert.deepEqual(unopposed, {
    conflicts: [],
    value: {
      assignmentOverrides: {
        kept: { dueAt: "2026-09-05T16:00:00Z" },
      },
    },
  });

  const conflicting = threeWayMerge(base, local, {
    assignmentOverrides: {
      deleted: { dueAt: "2026-09-06T16:00:00Z" },
      kept: { dueAt: "2026-09-04T16:00:00Z" },
    },
  });
  assert.deepEqual(conflicting.conflicts, ["assignmentOverrides.deleted"]);
  assert.equal(Object.hasOwn(conflicting.value.assignmentOverrides, "deleted"), false);
});

test("assistant merge unions messages and delivered reminder ids", () => {
  const merged = mergeCloudResource(
    PROFILE_RESOURCES.assistant,
    { deliveredIds: ["base"], messages: [] },
    {
      deliveredIds: ["base", "local-reminder"],
      messages: [
        { body: "Local first", createdAt: "2026-08-28T09:00:00.000Z", id: "local", role: "user" },
        { body: "Newer local copy", createdAt: "2026-08-28T11:00:00.000Z", id: "shared", role: "assistant" },
      ],
    },
    {
      deliveredIds: ["base", "remote-reminder"],
      messages: [
        { body: "Older remote copy", createdAt: "2026-08-28T10:00:00.000Z", id: "shared", role: "assistant" },
        { body: "Remote last", createdAt: "2026-08-28T12:00:00.000Z", id: "remote", role: "user" },
      ],
    },
  );

  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.value.deliveredIds, ["base", "remote-reminder", "local-reminder"]);
  assert.deepEqual(merged.value.messages.map((message) => message.id), ["local", "shared", "remote"]);
  assert.equal(merged.value.messages[1].body, "Newer local copy");
});

test("cloud chat merge deduplicates by id and orders messages deterministically", () => {
  const merged = mergeCloudResource(
    PROFILE_RESOURCES.cloudChat,
    [],
    [
      { body: "Local replacement", createdAt: "2026-08-28T10:00:00.000Z", id: "shared" },
      { body: "Same time B", createdAt: "2026-08-28T11:00:00.000Z", id: "b" },
    ],
    [
      { body: "Older remote", createdAt: "2026-08-28T09:00:00.000Z", id: "shared" },
      { body: "Same time A", createdAt: "2026-08-28T11:00:00.000Z", id: "a" },
    ],
  );

  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.value.map((message) => message.id), ["shared", "a", "b"]);
  assert.equal(merged.value[0].body, "Local replacement");
});

test("assistant sanitizer removes device notification state without mutating input", () => {
  const input = {
    deliveredIds: ["reminder-1"],
    messages: [{ id: "message-1" }],
    notificationsEnabled: true,
  };

  const sanitized = sanitizeCloudResource(PROFILE_RESOURCES.assistant, input);

  assert.deepEqual(sanitized, {
    deliveredIds: ["reminder-1"],
    messages: [{ id: "message-1" }],
  });
  assert.equal(input.notificationsEnabled, true);
});

test("cloud cache is owner-partitioned and rejects a forged owner envelope", () => {
  const storage = new MemoryStorage();
  const record = {
    base: { completedAssignments: {} },
    dirty: true,
    localVersion: 2,
    payload: { completedAssignments: { "canvas-30": true } },
    resource: PROFILE_RESOURCES.dashboard,
    revision: 3,
    updatedAt: "2026-08-28T16:00:00.000Z",
    userId: USER_A,
  };
  writeCloudResourceCache(storage, record);

  assert.deepEqual(readCloudResourceCache(storage, USER_A, PROFILE_RESOURCES.dashboard), {
    ...record,
    conflict: null,
  });
  assert.equal(readCloudResourceCache(storage, USER_B, PROFILE_RESOURCES.dashboard), null);

  storage.setItem(cloudResourceCacheKey(USER_B, PROFILE_RESOURCES.dashboard), JSON.stringify({
    ...record,
    schemaVersion: CLOUD_CACHE_SCHEMA_VERSION,
  }));
  assert.equal(readCloudResourceCache(storage, USER_B, PROFILE_RESOURCES.dashboard), null);

  removeCloudResourceCache(storage, USER_A, PROFILE_RESOURCES.dashboard);
  assert.equal(readCloudResourceCache(storage, USER_A, PROFILE_RESOURCES.dashboard), null);
});

test("foreign and unsupported remote rows are ignored", () => {
  const row = {
    payload: { completedAssignments: { "canvas-40": true } },
    resource: PROFILE_RESOURCES.dashboard,
    revision: 1,
    updated_at: "2026-08-28T17:00:00.000Z",
    user_id: USER_B,
  };

  assert.equal(remoteRowToRecord(row, USER_A), null);
  assert.equal(remoteRowToRecord({ ...row, resource: PROFILE_RESOURCES.pushReceipt }, USER_B), null);
  assert.deepEqual(remoteRowToRecord(row, USER_B), {
    base: row.payload,
    conflict: null,
    dirty: false,
    localVersion: 0,
    payload: row.payload,
    resource: PROFILE_RESOURCES.dashboard,
    revision: 1,
    updatedAt: "2026-08-28T17:00:00.000Z",
    userId: USER_B,
  });
});
