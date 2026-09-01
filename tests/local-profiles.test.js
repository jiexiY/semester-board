import test from "node:test";
import assert from "node:assert/strict";

import {
  LOCAL_PROFILE_REGISTRY_KEY,
  LOCAL_PROFILE_REGISTRY_LOCK_NAME,
  LOCAL_PROFILE_SESSION_KEY,
  LocalProfileError,
  completeSafeLocalProfileSignOut,
  createLocalProfile,
  createPassphraseVerifier,
  orderLocalProfilesForLogin,
  preferredLocalProfileId,
  readActiveLocalProfile,
  readLocalProfiles,
  signInLocalProfile,
  signOutLocalProfile,
  verifyPassphrase,
} from "../src/lib/localProfiles.js";
import {
  LEGACY_PROFILE_CLAIM_KEY,
  assistantStorageKey,
  claimLegacyLocalState,
  cloudChatStorageKey,
  cloudConsentSessionKey,
  dashboardStorageKey,
  pushMirrorStorageKeys,
} from "../src/lib/profileStorage.js";
import {
  MAX_CLOUD_HISTORY_CHARS,
  readStoredCloudMessages,
  trimCloudHistory,
} from "../src/hooks/useCloudAssistant.js";

const TEST_ITERATIONS = 1_000;

class MemoryStorage {
  constructor(entries = []) {
    this.values = new Map(entries.map(([key, value]) => [String(key), String(value)]));
  }

  getItem(key) {
    const normalizedKey = String(key);
    return this.values.has(normalizedKey) ? this.values.get(normalizedKey) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }
}

class SerialLockManager {
  constructor() {
    this.calls = [];
    this.active = 0;
    this.maximumActive = 0;
    this.tail = Promise.resolve();
  }

  request(name, options, operation) {
    this.calls.push({ name, options });
    const result = this.tail.then(async () => {
      this.active += 1;
      this.maximumActive = Math.max(this.maximumActive, this.active);
      try {
        return await operation({ name, mode: options.mode });
      } finally {
        this.active -= 1;
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }
}

class ThrowingSetStorage extends MemoryStorage {
  setItem() {
    throw new Error("storage write blocked");
  }
}

class ThrowingRemoveStorage extends MemoryStorage {
  removeItem() {
    throw new Error("storage removal blocked");
  }
}

test("local profiles store a derived verifier without persisting the plaintext passphrase", async () => {
  const storage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const passphrase = "private semester phrase";

  const profile = await createLocalProfile({
    name: "  Fall Student  ",
    passphrase,
    storage,
    sessionStorage,
    iterations: TEST_ITERATIONS,
  });

  const serializedRegistry = storage.getItem(LOCAL_PROFILE_REGISTRY_KEY);
  const registry = JSON.parse(serializedRegistry);
  assert.equal(serializedRegistry.includes(passphrase), false);
  assert.equal(registry.profiles[0].name, "Fall Student");
  assert.equal(registry.profiles[0].verifier.algorithm, "PBKDF2-SHA-256");
  assert.equal(registry.profiles[0].verifier.iterations, TEST_ITERATIONS);
  assert.notEqual(registry.profiles[0].verifier.hash, passphrase);
  assert.equal(profile.wasFirstProfile, true);
  assert.equal("wasFirstProfile" in registry.profiles[0], false);
  assert.equal(sessionStorage.getItem(LOCAL_PROFILE_SESSION_KEY), profile.id);
});

test("exclusive registry locks preserve concurrent creates and choose exactly one first profile", async () => {
  const storage = new MemoryStorage();
  const lockManager = new SerialLockManager();
  const firstSession = new MemoryStorage();
  const secondSession = new MemoryStorage();

  const [first, second] = await Promise.all([
    createLocalProfile({
      name: "First Tab",
      passphrase: "first tab passphrase",
      storage,
      sessionStorage: firstSession,
      iterations: TEST_ITERATIONS,
      lockManager,
    }),
    createLocalProfile({
      name: "Second Tab",
      passphrase: "second tab passphrase",
      storage,
      sessionStorage: secondSession,
      iterations: TEST_ITERATIONS,
      lockManager,
    }),
  ]);

  const registry = JSON.parse(storage.getItem(LOCAL_PROFILE_REGISTRY_KEY));
  assert.deepEqual(registry.profiles.map((profile) => profile.name), ["First Tab", "Second Tab"]);
  assert.deepEqual([first.wasFirstProfile, second.wasFirstProfile], [true, false]);
  assert.equal(lockManager.maximumActive, 1);
  assert.deepEqual(lockManager.calls, [
    { name: LOCAL_PROFILE_REGISTRY_LOCK_NAME, options: { mode: "exclusive" } },
    { name: LOCAL_PROFILE_REGISTRY_LOCK_NAME, options: { mode: "exclusive" } },
  ]);
});

test("sign-in updates the registry under the same exclusive lock", async () => {
  const storage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const profile = await createLocalProfile({
    name: "Locked Sign In",
    passphrase: "locked passphrase",
    storage,
    sessionStorage,
    iterations: TEST_ITERATIONS,
    lockManager: null,
  });
  const lockManager = new SerialLockManager();

  const signedIn = await signInLocalProfile({
    profileId: profile.id,
    passphrase: "locked passphrase",
    storage,
    sessionStorage,
    lockManager,
    now: () => new Date("2026-08-26T18:00:00.000Z"),
  });

  assert.equal(signedIn.lastUsedAt, "2026-08-26T18:00:00.000Z");
  assert.equal(lockManager.maximumActive, 1);
  assert.deepEqual(lockManager.calls, [
    { name: LOCAL_PROFILE_REGISTRY_LOCK_NAME, options: { mode: "exclusive" } },
  ]);
});

test("returning users log in from a fresh session without losing profile-scoped dashboard data", async () => {
  const storage = new MemoryStorage();
  const firstSession = new MemoryStorage();
  const profile = await createLocalProfile({
    name: "Returning Student",
    passphrase: "returning student phrase",
    storage,
    sessionStorage: firstSession,
    iterations: TEST_ITERATIONS,
  });
  const savedDashboard = JSON.stringify({ completedAssignments: { "enc-paper": true }, version: 1 });
  storage.setItem(dashboardStorageKey(profile.id), savedDashboard);
  signOutLocalProfile(firstSession);

  const freshSession = new MemoryStorage();
  assert.deepEqual(readLocalProfiles(storage).map(({ id, name }) => ({ id, name })), [{
    id: profile.id,
    name: "Returning Student",
  }]);
  assert.equal(readActiveLocalProfile({ storage, sessionStorage: freshSession }), null);

  const signedIn = await signInLocalProfile({
    profileId: profile.id,
    passphrase: "returning student phrase",
    storage,
    sessionStorage: freshSession,
    iterations: TEST_ITERATIONS,
  });

  assert.equal(signedIn.id, profile.id);
  assert.equal(readActiveLocalProfile({ storage, sessionStorage: freshSession }).id, profile.id);
  assert.equal(storage.getItem(dashboardStorageKey(profile.id)), savedDashboard);
});

test("login choices put the most recently used saved profile first without mutating the registry order", () => {
  const profiles = [
    { id: "profile_first", name: "First", createdAt: "2026-08-20T12:00:00.000Z", lastUsedAt: "2026-08-21T12:00:00.000Z" },
    { id: "profile_recent", name: "Recent", createdAt: "2026-08-20T13:00:00.000Z", lastUsedAt: "2026-08-27T12:00:00.000Z" },
    { id: "profile_unknown", name: "Unknown" },
  ];

  assert.deepEqual(orderLocalProfilesForLogin(profiles).map((profile) => profile.id), [
    "profile_recent",
    "profile_first",
    "profile_unknown",
  ]);
  assert.equal(preferredLocalProfileId(profiles), "profile_recent");
  assert.deepEqual(profiles.map((profile) => profile.id), ["profile_first", "profile_recent", "profile_unknown"]);
});

test("profile creation refuses to overwrite a corrupt saved-profile registry", async () => {
  const corruptRegistry = "{not-json";
  const storage = new MemoryStorage([[LOCAL_PROFILE_REGISTRY_KEY, corruptRegistry]]);

  await assert.rejects(
    createLocalProfile({
      name: "Do Not Overwrite",
      passphrase: "do not overwrite phrase",
      storage,
      sessionStorage: new MemoryStorage(),
      iterations: TEST_ITERATIONS,
    }),
    (error) => error instanceof LocalProfileError && error.code === "profile_registry_corrupt",
  );

  assert.equal(storage.getItem(LOCAL_PROFILE_REGISTRY_KEY), corruptRegistry);
});

test("a saved profile remains discoverable when automatic session login is blocked", async () => {
  const storage = new MemoryStorage();

  await assert.rejects(
    createLocalProfile({
      name: "Saved Before Session Failure",
      passphrase: "session failure phrase",
      storage,
      sessionStorage: new ThrowingSetStorage(),
      iterations: TEST_ITERATIONS,
    }),
    (error) => error instanceof LocalProfileError && error.code === "session_unavailable_after_create",
  );

  assert.deepEqual(readLocalProfiles(storage).map((profile) => profile.name), ["Saved Before Session Failure"]);
});

test("browser profile writes fail closed when cross-tab locks are unavailable", async () => {
  const priorWindow = globalThis.window;
  globalThis.window = {};
  try {
    await assert.rejects(
      createLocalProfile({
        lockManager: null,
        name: "Unsupported Browser",
        passphrase: "unsupported browser passphrase",
        sessionStorage: new MemoryStorage(),
        storage: new MemoryStorage(),
        iterations: TEST_ITERATIONS,
      }),
      (error) => error instanceof LocalProfileError && error.code === "locks_unavailable",
    );
  } finally {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});

test("passphrase verification accepts the correct secret and rejects a wrong one", async () => {
  const verifier = await createPassphraseVerifier("correct horse battery", {
    iterations: TEST_ITERATIONS,
  });

  assert.equal(await verifyPassphrase("correct horse battery", verifier), true);
  assert.equal(await verifyPassphrase("wrong horse battery", verifier), false);
});

test("profile names are unique after whitespace and case normalization", async () => {
  const storage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  await createLocalProfile({
    name: "Alex Student",
    passphrase: "first passphrase",
    storage,
    sessionStorage,
    iterations: TEST_ITERATIONS,
  });

  await assert.rejects(
    createLocalProfile({
      name: "  aLeX   sTuDeNt  ",
      passphrase: "second passphrase",
      storage,
      sessionStorage,
      iterations: TEST_ITERATIONS,
    }),
    (error) => error instanceof LocalProfileError && error.code === "duplicate_profile",
  );
});

test("stale sessions and corrupt registries fail closed and clear the active session", () => {
  const staleSession = new MemoryStorage([
    [LOCAL_PROFILE_SESSION_KEY, "profile-does-not-exist"],
  ]);
  assert.equal(readActiveLocalProfile({
    storage: new MemoryStorage(),
    sessionStorage: staleSession,
  }), null);
  assert.equal(staleSession.getItem(LOCAL_PROFILE_SESSION_KEY), null);

  const corruptSession = new MemoryStorage([
    [LOCAL_PROFILE_SESSION_KEY, "profile-corrupt-registry"],
  ]);
  assert.equal(readActiveLocalProfile({
    storage: new MemoryStorage([[LOCAL_PROFILE_REGISTRY_KEY, "{not-json"]]),
    sessionStorage: corruptSession,
  }), null);
  assert.equal(corruptSession.getItem(LOCAL_PROFILE_SESSION_KEY), null);
});

test("dashboard, assistant, cloud chat, and push mirror keys are distinct for every profile", () => {
  const firstId = "profile_alpha";
  const secondId = "profile_beta";
  const firstKeys = [
    dashboardStorageKey(firstId),
    assistantStorageKey(firstId),
    cloudChatStorageKey(firstId),
    cloudConsentSessionKey(firstId),
    ...Object.values(pushMirrorStorageKeys(firstId)),
  ];
  const secondKeys = [
    dashboardStorageKey(secondId),
    assistantStorageKey(secondId),
    cloudChatStorageKey(secondId),
    cloudConsentSessionKey(secondId),
    ...Object.values(pushMirrorStorageKeys(secondId)),
  ];

  assert.equal(new Set(firstKeys).size, firstKeys.length);
  assert.equal(new Set(secondKeys).size, secondKeys.length);
  assert.equal(firstKeys.some((key) => secondKeys.includes(key)), false);
  assert.ok(firstKeys.every((key) => key.includes(firstId)));
  assert.ok(secondKeys.every((key) => key.includes(secondId)));
});

test("saved Semester Chat conversations stay inside their exact local profile", () => {
  const firstKey = cloudChatStorageKey("profile_alpha");
  const secondKey = cloudChatStorageKey("profile_beta");
  const storage = new MemoryStorage([
    [firstKey, JSON.stringify([{
      body: "Help me plan my week.",
      createdAt: "2026-08-26T14:00:00.000Z",
      id: "user-first",
      role: "user",
      title: "untrusted title",
    }])],
    [secondKey, JSON.stringify([{
      body: "What should I prioritize?",
      createdAt: "2026-08-26T15:00:00.000Z",
      id: "user-second",
      role: "user",
    }])],
  ]);

  assert.deepEqual(readStoredCloudMessages(storage, firstKey), [{
    body: "Help me plan my week.",
    createdAt: "2026-08-26T14:00:00.000Z",
    id: "user-first",
    role: "user",
    title: "You",
  }]);
  assert.equal(readStoredCloudMessages(storage, firstKey)[0].body.includes("prioritize"), false);
  assert.equal(readStoredCloudMessages(storage, secondKey)[0].id, "user-second");
  assert.deepEqual(readStoredCloudMessages(new MemoryStorage([[firstKey, "{bad-json"]]), firstKey), []);
});

test("a restored long Semester Chat is trimmed newest-first before its next request", () => {
  const restored = Array.from({ length: 4 }, (_, index) => ({
    body: String(index).repeat(3_000),
    createdAt: `2026-08-26T1${index}:00:00.000Z`,
    id: `restored-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    title: index % 2 === 0 ? "You" : "Semester Board",
  }));
  const finalUser = {
    body: "Continue",
    createdAt: "2026-08-26T14:00:00.000Z",
    id: "final-user",
    role: "user",
    title: "You",
  };

  const trimmed = trimCloudHistory([...restored, finalUser]);
  assert.equal(trimmed.at(-1), finalUser);
  assert.equal(trimmed.some((message) => message.id === "restored-0"), false);
  assert.ok(trimmed.reduce((total, message) => total + message.body.length, 0) <= MAX_CLOUD_HISTORY_CHARS);
});

test("legacy local state is claimed once by the first profile and never overwritten", () => {
  const storage = new MemoryStorage([
    ["fall2026Quest:v1", "dashboard-state"],
    ["fall2026Quest:assistant:v2", "assistant-state"],
    ["fall2026Quest:pushReceipt:v1", "receipt-state"],
    [dashboardStorageKey("profile_first"), "existing-scoped-state"],
  ]);

  const firstClaim = claimLegacyLocalState(storage, "profile_first");
  assert.equal(firstClaim.claimed, true);
  assert.equal(storage.getItem(LEGACY_PROFILE_CLAIM_KEY), "profile_first");
  assert.equal(storage.getItem(dashboardStorageKey("profile_first")), "existing-scoped-state");
  assert.equal(storage.getItem(assistantStorageKey("profile_first")), "assistant-state");
  assert.equal(storage.getItem(pushMirrorStorageKeys("profile_first").receipt), "receipt-state");

  const secondClaim = claimLegacyLocalState(storage, "profile_second");
  assert.deepEqual(secondClaim, { claimed: false, copied: [] });
  assert.equal(storage.getItem(dashboardStorageKey("profile_second")), null);
  assert.equal(storage.getItem(assistantStorageKey("profile_second")), null);

  const repeatedFirstClaim = claimLegacyLocalState(storage, "profile_first");
  assert.deepEqual(repeatedFirstClaim, { claimed: true, copied: [] });
});

test("sign-out clears only the active session and preserves profiles and unrelated session data", async () => {
  const storage = new MemoryStorage();
  const sessionStorage = new MemoryStorage([["unrelated-session-key", "keep-me"]]);
  await createLocalProfile({
    name: "Persistent Student",
    passphrase: "persistent passphrase",
    storage,
    sessionStorage,
    iterations: TEST_ITERATIONS,
  });
  const registryBeforeSignOut = storage.getItem(LOCAL_PROFILE_REGISTRY_KEY);

  signOutLocalProfile(sessionStorage);

  assert.equal(sessionStorage.getItem(LOCAL_PROFILE_SESSION_KEY), null);
  assert.equal(sessionStorage.getItem("unrelated-session-key"), "keep-me");
  assert.equal(storage.getItem(LOCAL_PROFILE_REGISTRY_KEY), registryBeforeSignOut);
});

test("sign-out fails visibly instead of pretending a blocked session was cleared", () => {
  const sessionStorage = new ThrowingRemoveStorage([
    [LOCAL_PROFILE_SESSION_KEY, "profile_still_active"],
  ]);

  assert.throws(
    () => signOutLocalProfile(sessionStorage),
    (error) => error instanceof LocalProfileError && error.code === "session_unavailable",
  );
  assert.equal(sessionStorage.getItem(LOCAL_PROFILE_SESSION_KEY), "profile_still_active");
});

test("safe sign-out keeps the profile session intact when push shutdown fails", async () => {
  const calls = [];
  await assert.rejects(
    completeSafeLocalProfileSignOut({
      disablePush: async () => {
        calls.push("push");
        throw new Error("push storage unavailable");
      },
      clearCloudConsent: () => calls.push("cloud"),
      signOut: () => calls.push("session"),
    }),
    /push storage unavailable/,
  );
  assert.deepEqual(calls, ["push"]);
});

test("safe sign-out clears consent and the session only after push shutdown finishes", async () => {
  const calls = [];
  await completeSafeLocalProfileSignOut({
    disablePush: async () => calls.push("push"),
    clearCloudConsent: () => calls.push("cloud"),
    signOut: () => calls.push("session"),
  });
  assert.deepEqual(calls, ["push", "cloud", "session"]);
});
