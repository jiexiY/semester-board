const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export const LEGACY_PROFILE_CLAIM_KEY = "fall2026Quest:legacyProfileClaim:v1";

export const PROFILE_RESOURCES = Object.freeze({
  assistant: "assistant:v2",
  cloudChat: "cloudChat:v1",
  cloudConsent: "cloudConsent:v1",
  dashboard: "dashboard:v1",
  pushEndpoint: "pushEndpoint:v1",
  pushReceipt: "pushReceipt:v1",
  pushRevision: "pushRevision:v1",
});

const LEGACY_LOCAL_STORAGE_KEYS = Object.freeze({
  [PROFILE_RESOURCES.assistant]: "fall2026Quest:assistant:v2",
  [PROFILE_RESOURCES.dashboard]: "fall2026Quest:v1",
  [PROFILE_RESOURCES.pushEndpoint]: "fall2026Quest:pushEndpoint:v1",
  [PROFILE_RESOURCES.pushReceipt]: "fall2026Quest:pushReceipt:v1",
  [PROFILE_RESOURCES.pushRevision]: "fall2026Quest:pushRevision:v1",
});

export function normalizeProfileId(profileId) {
  const normalized = String(profileId || "").trim();
  if (!PROFILE_ID_PATTERN.test(normalized)) {
    throw new TypeError("A valid local profile id is required.");
  }
  return normalized;
}

export function profileStorageKey(profileId, resource) {
  const normalizedProfileId = normalizeProfileId(profileId);
  const normalizedResource = String(resource || "").trim();
  if (!normalizedResource || normalizedResource.length > 80 || !/^[A-Za-z0-9:_-]+$/.test(normalizedResource)) {
    throw new TypeError("A valid local profile storage resource is required.");
  }
  return `fall2026Quest:user:${normalizedProfileId}:${normalizedResource}`;
}

export function dashboardStorageKey(profileId) {
  return profileStorageKey(profileId, PROFILE_RESOURCES.dashboard);
}

export function assistantStorageKey(profileId) {
  return profileStorageKey(profileId, PROFILE_RESOURCES.assistant);
}

export function cloudConsentSessionKey(profileId) {
  return profileStorageKey(profileId, PROFILE_RESOURCES.cloudConsent);
}

export function cloudChatStorageKey(profileId) {
  return profileStorageKey(profileId, PROFILE_RESOURCES.cloudChat);
}

export function pushMirrorStorageKeys(profileId) {
  return {
    endpointHash: profileStorageKey(profileId, PROFILE_RESOURCES.pushEndpoint),
    receipt: profileStorageKey(profileId, PROFILE_RESOURCES.pushReceipt),
    revision: profileStorageKey(profileId, PROFILE_RESOURCES.pushRevision),
  };
}

export function claimLegacyLocalState(storage, profileId) {
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
    return { claimed: false, copied: [] };
  }

  const normalizedProfileId = normalizeProfileId(profileId);
  const existingClaim = storage.getItem(LEGACY_PROFILE_CLAIM_KEY);
  if (existingClaim) {
    return { claimed: existingClaim === normalizedProfileId, copied: [] };
  }

  const copied = [];
  for (const [resource, legacyKey] of Object.entries(LEGACY_LOCAL_STORAGE_KEYS)) {
    const legacyValue = storage.getItem(legacyKey);
    const targetKey = profileStorageKey(normalizedProfileId, resource);
    if (legacyValue !== null && storage.getItem(targetKey) === null) {
      storage.setItem(targetKey, legacyValue);
      copied.push(resource);
    }
  }
  storage.setItem(LEGACY_PROFILE_CLAIM_KEY, normalizedProfileId);
  return { claimed: true, copied };
}
