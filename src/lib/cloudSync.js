import { PROFILE_RESOURCES, normalizeProfileId, profileStorageKey } from "./profileStorage.js";

export const CLOUD_CACHE_SCHEMA_VERSION = 1;
export const CLOUD_SYNC_RESOURCES = Object.freeze([
  PROFILE_RESOURCES.dashboard,
  PROFILE_RESOURCES.assistant,
  PROFILE_RESOURCES.cloudChat,
]);

const RESOURCE_SET = new Set(CLOUD_SYNC_RESOURCES);
const MISSING = Symbol("missing");

export function isRetryableCloudSyncError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLocaleLowerCase("en-US");
  return status === 429
    || status >= 500
    || /^(?:08|53|57P0)/u.test(code)
    || code.startsWith("PGRST00")
    || /network|fetch|timeout|timed out|connection|rate limit|too many/u.test(message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function equivalent(left, right) {
  if (left === MISSING || right === MISSING) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeNode(base, local, remote, path, conflicts) {
  if (equivalent(local, remote)) return clone(local === MISSING ? undefined : local);
  if (equivalent(local, base)) return clone(remote === MISSING ? undefined : remote);
  if (equivalent(remote, base)) return clone(local === MISSING ? undefined : local);

  if (isRecord(local) && isRecord(remote) && (isRecord(base) || base === MISSING)) {
    const result = {};
    const baseRecord = isRecord(base) ? base : {};
    const keys = new Set([...Object.keys(baseRecord), ...Object.keys(local), ...Object.keys(remote)]);
    for (const key of keys) {
      const child = mergeNode(
        Object.hasOwn(baseRecord, key) ? baseRecord[key] : MISSING,
        Object.hasOwn(local, key) ? local[key] : MISSING,
        Object.hasOwn(remote, key) ? remote[key] : MISSING,
        [...path, key],
        conflicts,
      );
      if (child !== undefined) result[key] = child;
    }
    return result;
  }

  conflicts.push(path.join(".") || "root");
  return clone(local === MISSING ? undefined : local);
}

export function threeWayMerge(base, local, remote) {
  const conflicts = [];
  const value = mergeNode(base ?? {}, local ?? {}, remote ?? {}, [], conflicts);
  return { conflicts: [...new Set(conflicts)], value };
}

function unionMessages(...messageLists) {
  const byId = new Map();
  for (const message of messageLists.flat()) {
    if (!message || typeof message.id !== "string") continue;
    const current = byId.get(message.id);
    if (!current || String(message.createdAt || "") >= String(current.createdAt || "")) {
      byId.set(message.id, clone(message));
    }
  }
  return [...byId.values()].sort((left, right) => (
    String(left.createdAt || "").localeCompare(String(right.createdAt || ""))
      || String(left.id).localeCompare(String(right.id))
  ));
}

export function mergeCloudResource(resource, base, local, remote) {
  if (resource === PROFILE_RESOURCES.cloudChat) {
    return { conflicts: [], value: unionMessages(remote || [], local || []).slice(-12) };
  }
  if (resource === PROFILE_RESOURCES.assistant) {
    const merged = threeWayMerge(base, local, remote);
    const deliveredIds = [...new Set([
      ...(Array.isArray(remote?.deliveredIds) ? remote.deliveredIds : []),
      ...(Array.isArray(local?.deliveredIds) ? local.deliveredIds : []),
    ])].slice(-1600);
    return {
      conflicts: merged.conflicts.filter((path) => !path.startsWith("messages") && !path.startsWith("deliveredIds")),
      value: {
        ...merged.value,
        deliveredIds,
        messages: unionMessages(remote?.messages || [], local?.messages || []).slice(-80),
      },
    };
  }
  return threeWayMerge(base, local, remote);
}

export function sanitizeCloudResource(resource, payload) {
  if (!RESOURCE_SET.has(resource)) throw new TypeError("That account resource cannot be synchronized.");
  const safe = clone(payload);
  if (resource === PROFILE_RESOURCES.assistant && isRecord(safe)) {
    delete safe.notificationsEnabled;
  }
  return safe;
}

export function cloudResourceCacheKey(userId, resource) {
  if (!RESOURCE_SET.has(resource)) throw new TypeError("That account resource cannot be cached.");
  return profileStorageKey(normalizeProfileId(userId), `cloudCache:${resource}`);
}

export function readCloudResourceCache(storage, userId, resource) {
  try {
    const raw = storage?.getItem?.(cloudResourceCacheKey(userId, resource));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)
      || parsed.schemaVersion !== CLOUD_CACHE_SCHEMA_VERSION
      || parsed.userId !== userId
      || parsed.resource !== resource
      || !Number.isInteger(parsed.revision)
      || parsed.revision < 0
      || typeof parsed.dirty !== "boolean") return null;
    return {
      base: clone(parsed.base),
      conflict: isRecord(parsed.conflict) ? clone(parsed.conflict) : null,
      dirty: parsed.dirty,
      localVersion: Number.isInteger(parsed.localVersion) ? parsed.localVersion : 0,
      payload: clone(parsed.payload),
      resource,
      revision: parsed.revision,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      userId,
    };
  } catch {
    return null;
  }
}

export function writeCloudResourceCache(storage, record) {
  const userId = normalizeProfileId(record?.userId);
  const resource = record?.resource;
  if (!RESOURCE_SET.has(resource)) throw new TypeError("That account resource cannot be cached.");
  storage?.setItem?.(cloudResourceCacheKey(userId, resource), JSON.stringify({
    base: record.base,
    conflict: record.conflict || null,
    dirty: Boolean(record.dirty),
    localVersion: Number.isInteger(record.localVersion) ? record.localVersion : 0,
    payload: record.payload,
    resource,
    revision: Number.isInteger(record.revision) ? record.revision : 0,
    schemaVersion: CLOUD_CACHE_SCHEMA_VERSION,
    updatedAt: record.updatedAt || null,
    userId,
  }));
}

export function removeCloudResourceCache(storage, userId, resource) {
  storage?.removeItem?.(cloudResourceCacheKey(userId, resource));
}

export function remoteRowToRecord(row, userId) {
  if (!row || row.user_id !== userId || !RESOURCE_SET.has(row.resource)) return null;
  const revision = Number(row.revision);
  if (!Number.isInteger(revision) || revision < 1) return null;
  return {
    base: clone(row.payload),
    conflict: null,
    dirty: false,
    localVersion: 0,
    payload: clone(row.payload),
    resource: row.resource,
    revision,
    updatedAt: row.updated_at || null,
    userId,
  };
}

export function reconcileCachedRecord(cache, remote) {
  if (!cache) return remote;
  if (!remote) {
    if (!cache.dirty) return null;
    if (cache.revision === 0) return cache;
    return {
      ...cache,
      conflict: {
        base: clone(cache.base),
        paths: ["cloud record"],
        remote: null,
        remoteRevision: 0,
        remoteUpdatedAt: null,
      },
      saving: false,
    };
  }
  if (remote.revision < cache.revision) return cache;
  if (!cache.dirty) return remote;
  if (cache.revision === remote.revision) return cache;
  const merged = mergeCloudResource(cache.resource, cache.base, cache.payload, remote.payload);
  if (!merged.conflicts.length) {
    return {
      ...cache,
      base: clone(remote.payload),
      conflict: null,
      dirty: true,
      payload: merged.value,
      revision: remote.revision,
      updatedAt: remote.updatedAt,
    };
  }
  return {
    ...cache,
    conflict: {
      base: clone(cache.base),
      paths: merged.conflicts,
      remote: clone(remote.payload),
      remoteRevision: remote.revision,
      remoteUpdatedAt: remote.updatedAt,
    },
  };
}

export function reconcileAuthoritativeRecord(cache, remote) {
  if (cache && remote && remote.revision < cache.revision) {
    if (!cache.dirty) return remote;
    return {
      ...cache,
      conflict: {
        base: clone(cache.base),
        paths: ["cloud record generation"],
        remote: clone(remote.payload),
        remoteRevision: remote.revision,
        remoteUpdatedAt: remote.updatedAt,
      },
      saving: false,
    };
  }
  return reconcileCachedRecord(cache, remote);
}
