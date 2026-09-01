export const LOCAL_PROFILE_SCHEMA_VERSION = 1;
export const LOCAL_PROFILE_REGISTRY_KEY = "fall2026Quest:profiles:v1";
export const LOCAL_PROFILE_SESSION_KEY = "fall2026Quest:activeProfile:v1";
export const LOCAL_PROFILE_REGISTRY_LOCK_NAME = "fall2026Quest:profiles:v1:write";
export const LOCAL_PROFILE_PBKDF2_ITERATIONS = 310_000;
export const LOCAL_PROFILE_MIN_PASSPHRASE_LENGTH = 8;

const MAX_PROFILE_NAME_LENGTH = 40;
const MAX_PASSPHRASE_LENGTH = 128;

export class LocalProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalProfileError";
    this.code = code;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = globalThis.atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function cryptoProvider(override) {
  const provider = override || globalThis.crypto;
  if (!provider?.subtle || typeof provider.getRandomValues !== "function") {
    throw new LocalProfileError(
      "crypto_unavailable",
      "Secure local profile verification is unavailable in this browser.",
    );
  }
  return provider;
}

function storageProvider(storage, label) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    throw new LocalProfileError("storage_unavailable", `${label} storage is unavailable in this browser.`);
  }
  return storage;
}

export function normalizeLocalProfileName(value) {
  return String(value || "").trim().replace(/\s+/gu, " ");
}

function profileNameKey(value) {
  return normalizeLocalProfileName(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

export function validateLocalProfileInput({ name, passphrase } = {}) {
  const normalizedName = normalizeLocalProfileName(name);
  const secret = typeof passphrase === "string" ? passphrase : "";
  const errors = [];
  if (!normalizedName) errors.push({ field: "name", message: "Enter a profile name." });
  if (normalizedName.length > MAX_PROFILE_NAME_LENGTH) {
    errors.push({ field: "name", message: `Profile names must be ${MAX_PROFILE_NAME_LENGTH} characters or fewer.` });
  }
  if (secret.length < LOCAL_PROFILE_MIN_PASSPHRASE_LENGTH) {
    errors.push({
      field: "passphrase",
      message: `Use at least ${LOCAL_PROFILE_MIN_PASSPHRASE_LENGTH} characters for the passphrase.`,
    });
  }
  if (secret.length > MAX_PASSPHRASE_LENGTH) {
    errors.push({ field: "passphrase", message: `Passphrases must be ${MAX_PASSPHRASE_LENGTH} characters or fewer.` });
  }
  return {
    errors,
    valid: errors.length === 0,
    value: errors.length === 0 ? { name: normalizedName, nameKey: profileNameKey(normalizedName), passphrase: secret } : null,
  };
}

function validVerifier(value) {
  return isRecord(value)
    && value.algorithm === "PBKDF2-SHA-256"
    && Number.isInteger(value.iterations)
    && value.iterations >= 1_000
    && typeof value.salt === "string"
    && typeof value.hash === "string";
}

function validProfile(value) {
  return isRecord(value)
    && value.schemaVersion === LOCAL_PROFILE_SCHEMA_VERSION
    && typeof value.id === "string"
    && value.id.length >= 8
    && typeof value.name === "string"
    && value.name.length > 0
    && value.name.length <= MAX_PROFILE_NAME_LENGTH
    && typeof value.nameKey === "string"
    && validVerifier(value.verifier);
}

function parseLocalProfiles(storage, { strict = false } = {}) {
  try {
    const raw = storage?.getItem?.(LOCAL_PROFILE_REGISTRY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)
      || parsed.schemaVersion !== LOCAL_PROFILE_SCHEMA_VERSION
      || !Array.isArray(parsed.profiles)
      || (strict && !parsed.profiles.every(validProfile))) {
      if (strict) throw new LocalProfileError(
        "profile_registry_corrupt",
        "Saved local profiles could not be read. No profile data was changed.",
      );
      return [];
    }
    return parsed.profiles.filter(validProfile);
  } catch (error) {
    if (strict && error instanceof LocalProfileError) throw error;
    if (strict) throw new LocalProfileError(
      "profile_registry_corrupt",
      "Saved local profiles could not be read. No profile data was changed.",
    );
    return [];
  }
}

export function readLocalProfiles(storage = globalThis.localStorage) {
  return parseLocalProfiles(storage);
}

function readLocalProfilesForWrite(storage) {
  return parseLocalProfiles(storage, { strict: true });
}

export function orderLocalProfilesForLogin(profiles = []) {
  return profiles
    .map((profile, index) => ({
      index,
      profile,
      usedAt: Date.parse(profile?.lastUsedAt || profile?.createdAt || ""),
    }))
    .toSorted((left, right) => {
      const leftTime = Number.isFinite(left.usedAt) ? left.usedAt : Number.NEGATIVE_INFINITY;
      const rightTime = Number.isFinite(right.usedAt) ? right.usedAt : Number.NEGATIVE_INFINITY;
      return rightTime - leftTime || left.index - right.index;
    })
    .map(({ profile }) => profile);
}

export function preferredLocalProfileId(profiles = []) {
  return orderLocalProfilesForLogin(profiles)[0]?.id || "";
}

function writeLocalProfiles(storage, profiles) {
  storageProvider(storage, "Local profile").setItem(LOCAL_PROFILE_REGISTRY_KEY, JSON.stringify({
    schemaVersion: LOCAL_PROFILE_SCHEMA_VERSION,
    profiles,
  }));
}

async function withLocalProfileRegistryLock(lockManager, operation) {
  const manager = lockManager === undefined ? globalThis.navigator?.locks : lockManager;
  if (!manager || typeof manager.request !== "function") {
    if (typeof window === "undefined") return operation();
    throw new LocalProfileError(
      "locks_unavailable",
      "This browser cannot safely coordinate local profiles across tabs. Use a current version of Chrome, Edge, Firefox, or Safari.",
    );
  }
  return manager.request(LOCAL_PROFILE_REGISTRY_LOCK_NAME, { mode: "exclusive" }, operation);
}

function publicProfile(profile) {
  if (!profile) return null;
  return {
    createdAt: profile.createdAt,
    id: profile.id,
    lastUsedAt: profile.lastUsedAt,
    name: profile.name,
  };
}

function timingSafeBytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

async function derivePassphraseBytes(passphrase, salt, iterations, provider) {
  const material = await provider.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await provider.subtle.deriveBits({
    hash: "SHA-256",
    iterations,
    name: "PBKDF2",
    salt,
  }, material, 256);
  return new Uint8Array(bits);
}

export async function createPassphraseVerifier(passphrase, {
  cryptoApi,
  iterations = LOCAL_PROFILE_PBKDF2_ITERATIONS,
} = {}) {
  const provider = cryptoProvider(cryptoApi);
  const salt = provider.getRandomValues(new Uint8Array(16));
  const hash = await derivePassphraseBytes(passphrase, salt, iterations, provider);
  return {
    algorithm: "PBKDF2-SHA-256",
    hash: bytesToBase64Url(hash),
    iterations,
    salt: bytesToBase64Url(salt),
  };
}

export async function verifyPassphrase(passphrase, verifier, { cryptoApi } = {}) {
  if (!validVerifier(verifier) || typeof passphrase !== "string") return false;
  try {
    const provider = cryptoProvider(cryptoApi);
    const actual = await derivePassphraseBytes(
      passphrase,
      base64UrlToBytes(verifier.salt),
      verifier.iterations,
      provider,
    );
    return timingSafeBytesEqual(actual, base64UrlToBytes(verifier.hash));
  } catch {
    return false;
  }
}

function newProfileId(provider) {
  if (typeof provider.randomUUID === "function") return provider.randomUUID();
  return `profile_${bytesToBase64Url(provider.getRandomValues(new Uint8Array(18)))}`;
}

export async function createLocalProfile({
  name,
  passphrase,
  storage = globalThis.localStorage,
  sessionStorage = globalThis.sessionStorage,
  cryptoApi,
  iterations = LOCAL_PROFILE_PBKDF2_ITERATIONS,
  lockManager,
  now = () => new Date(),
} = {}) {
  const validation = validateLocalProfileInput({ name, passphrase });
  if (!validation.valid) {
    throw new LocalProfileError("invalid_profile", validation.errors[0].message);
  }
  const persistentStorage = storageProvider(storage, "Local profile");
  const session = storageProvider(sessionStorage, "Session");
  const provider = cryptoProvider(cryptoApi);
  const result = await withLocalProfileRegistryLock(lockManager, async () => {
    const profiles = readLocalProfilesForWrite(persistentStorage);
    if (profiles.some((profile) => profile.nameKey === validation.value.nameKey)) {
      throw new LocalProfileError("duplicate_profile", "A local profile with that name already exists.");
    }

    const verifier = await createPassphraseVerifier(validation.value.passphrase, {
      cryptoApi: provider,
      iterations,
    });
    const latestProfiles = readLocalProfilesForWrite(persistentStorage);
    if (latestProfiles.some((profile) => profile.nameKey === validation.value.nameKey)) {
      throw new LocalProfileError("duplicate_profile", "A local profile with that name already exists.");
    }

    const timestamp = now().toISOString();
    const profile = {
      schemaVersion: LOCAL_PROFILE_SCHEMA_VERSION,
      id: newProfileId(provider),
      name: validation.value.name,
      nameKey: validation.value.nameKey,
      createdAt: timestamp,
      lastUsedAt: timestamp,
      verifier,
    };
    const wasFirstProfile = latestProfiles.length === 0;
    writeLocalProfiles(persistentStorage, [...latestProfiles, profile]);
    return { ...publicProfile(profile), wasFirstProfile };
  });
  try {
    session.setItem(LOCAL_PROFILE_SESSION_KEY, result.id);
  } catch {
    throw new LocalProfileError(
      "session_unavailable_after_create",
      "The profile was saved, but this tab could not log in automatically. Choose Log in and try again.",
    );
  }
  return result;
}

export async function signInLocalProfile({
  profileId,
  passphrase,
  storage = globalThis.localStorage,
  sessionStorage = globalThis.sessionStorage,
  cryptoApi,
  lockManager,
  now = () => new Date(),
} = {}) {
  const persistentStorage = storageProvider(storage, "Local profile");
  const session = storageProvider(sessionStorage, "Session");
  const result = await withLocalProfileRegistryLock(lockManager, async () => {
    const profiles = readLocalProfilesForWrite(persistentStorage);
    const index = profiles.findIndex((candidate) => candidate.id === profileId);
    const profile = index >= 0 ? profiles[index] : null;
    if (!profile || !(await verifyPassphrase(passphrase, profile.verifier, { cryptoApi }))) {
      throw new LocalProfileError("invalid_credentials", "The profile or passphrase is incorrect.");
    }

    const latestProfiles = readLocalProfilesForWrite(persistentStorage);
    const latestIndex = latestProfiles.findIndex((candidate) => candidate.id === profileId);
    const latestProfile = latestIndex >= 0 ? latestProfiles[latestIndex] : null;
    if (!latestProfile) {
      throw new LocalProfileError("invalid_credentials", "The profile or passphrase is incorrect.");
    }
    const updated = { ...latestProfile, lastUsedAt: now().toISOString() };
    writeLocalProfiles(persistentStorage, latestProfiles.with(latestIndex, updated));
    return publicProfile(updated);
  });
  try {
    session.setItem(LOCAL_PROFILE_SESSION_KEY, result.id);
  } catch {
    throw new LocalProfileError(
      "session_unavailable",
      "This tab could not keep the profile logged in. The saved profile and its data were not removed.",
    );
  }
  return result;
}

export function readActiveLocalProfile({
  storage = globalThis.localStorage,
  sessionStorage = globalThis.sessionStorage,
} = {}) {
  try {
    const activeId = sessionStorage?.getItem?.(LOCAL_PROFILE_SESSION_KEY);
    if (!activeId) return null;
    const profile = readLocalProfiles(storage).find((candidate) => candidate.id === activeId);
    if (!profile) {
      sessionStorage?.removeItem?.(LOCAL_PROFILE_SESSION_KEY);
      return null;
    }
    return publicProfile(profile);
  } catch {
    return null;
  }
}

export function signOutLocalProfile(sessionStorage = globalThis.sessionStorage) {
  if (!sessionStorage || typeof sessionStorage.removeItem !== "function") {
    throw new LocalProfileError(
      "session_unavailable",
      "This tab could not sign out. Your saved profile and its data were not removed.",
    );
  }
  try {
    sessionStorage.removeItem(LOCAL_PROFILE_SESSION_KEY);
  } catch {
    throw new LocalProfileError(
      "session_unavailable",
      "This tab could not sign out. Your saved profile and its data were not removed.",
    );
  }
}

export async function completeSafeLocalProfileSignOut({
  clearCloudConsent,
  disablePush,
  signOut,
} = {}) {
  if (typeof disablePush !== "function"
    || typeof clearCloudConsent !== "function"
    || typeof signOut !== "function") {
    throw new TypeError("Safe local profile sign-out actions are required.");
  }
  await disablePush();
  clearCloudConsent();
  signOut();
}
