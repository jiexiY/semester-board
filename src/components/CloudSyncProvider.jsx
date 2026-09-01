import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "../icons.jsx";
import { CloudSyncContext, useCloudSync } from "../hooks/useSyncedResource.js";
import {
  CLOUD_SYNC_RESOURCES,
  isRetryableCloudSyncError,
  mergeCloudResource,
  readCloudResourceCache,
  reconcileAuthoritativeRecord,
  reconcileCachedRecord,
  removeCloudResourceCache,
  remoteRowToRecord,
  sanitizeCloudResource,
  writeCloudResourceCache,
} from "../lib/cloudSync.js";
const REMOTE_COLUMNS = "user_id, resource, payload, revision, updated_at";
const SAVE_DELAY_MS = 450;
const MAX_SAVE_RETRY_MS = 30000;

function readableSyncError() {
  return "Your changes are safe on this device, but they have not reached your account yet.";
}

function syncStatus(records, online, providerError, cacheWarning) {
  const values = Object.values(records);
  const conflicts = values.filter((record) => record?.conflict).length;
  const pending = values.filter((record) => record?.dirty).length;
  const saving = values.some((record) => record?.saving);
  if (conflicts) return { conflicts, label: "Sync needs review", pending, tone: "conflict" };
  if (!online) return {
    conflicts: 0,
    label: pending ? `Offline · ${pending} ${pending === 1 ? "change" : "changes"} waiting` : "Offline · saved on this device",
    pending,
    tone: "offline",
  };
  if (providerError) return {
    conflicts: 0,
    label: pending ? "Could not sync · saved on this device" : "Sync unavailable · showing device copy",
    pending,
    tone: "error",
  };
  if (saving || pending) return { conflicts: 0, label: "Saving to your account…", pending, tone: "saving" };
  if (cacheWarning) return { conflicts: 0, label: "Saved to account · offline copy unavailable", pending: 0, tone: "offline" };
  return { conflicts: 0, label: "Saved to your account", pending: 0, tone: "synced" };
}

function emptyRecord(userId, resource, payload) {
  return {
    base: undefined,
    conflict: null,
    dirty: false,
    localVersion: 0,
    payload,
    resource,
    revision: 0,
    updatedAt: null,
    userId,
  };
}

export function CloudSyncProvider({ children, client, userId }) {
  const [phase, setPhase] = useState("loading");
  const [records, setRecords] = useState({});
  const [providerError, setProviderError] = useState(null);
  const [cacheWarning, setCacheWarning] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [reloadToken, setReloadToken] = useState(0);
  const recordsRef = useRef({});
  const timersRef = useRef(new Map());
  const mountedRef = useRef(true);
  const remoteResourcesRef = useRef(new Set());
  const retryAttemptsRef = useRef(new Map());
  const saveOperationsRef = useRef(new Map());
  const refreshSequenceRef = useRef(0);
  const providerGenerationRef = useRef(0);

  const commitRecord = useCallback((resource, record) => {
    if (!mountedRef.current) return;
    const next = { ...recordsRef.current, [resource]: record };
    recordsRef.current = next;
    setRecords(next);
    try {
      writeCloudResourceCache(window.localStorage, record);
    } catch {
      setCacheWarning(true);
    }
  }, []);

  const removeRecord = useCallback((resource) => {
    if (!mountedRef.current) return;
    const next = { ...recordsRef.current };
    delete next[resource];
    recordsRef.current = next;
    setRecords(next);
    try {
      removeCloudResourceCache(window.localStorage, userId, resource);
    } catch {
      setCacheWarning(true);
    }
  }, [userId]);

  const readRemote = useCallback(async (resource) => {
    const result = await client
      .from("account_state")
      .select(REMOTE_COLUMNS)
      .eq("user_id", userId)
      .eq("resource", resource)
      .maybeSingle();
    if (result.error) throw result.error;
    return remoteRowToRecord(result.data, userId);
  }, [client, userId]);

  const resolveVersionConflict = useCallback(async (
    resource,
    snapshot,
    operationId,
    providerGeneration,
    suppliedRemote,
  ) => {
    const remote = suppliedRemote === undefined ? await readRemote(resource) : suppliedRemote;
    if (providerGenerationRef.current !== providerGeneration
      || saveOperationsRef.current.get(resource) !== operationId) return null;
    const current = recordsRef.current[resource] || snapshot;
    if (!remote) {
      commitRecord(resource, {
        ...current,
        conflict: {
          base: current.base,
          paths: ["cloud record"],
          remote: null,
          remoteRevision: 0,
          remoteUpdatedAt: null,
        },
        saving: false,
      });
      return null;
    }
    if (remote.revision < current.revision) {
      commitRecord(resource, {
        ...current,
        conflict: {
          base: current.base,
          paths: ["cloud record generation"],
          remote: remote.payload,
          remoteRevision: remote.revision,
          remoteUpdatedAt: remote.updatedAt,
        },
        saving: false,
      });
      return null;
    }
    const merged = mergeCloudResource(resource, current.base, current.payload, remote.payload);
    if (!merged.conflicts.length) {
      const next = {
        ...current,
        base: remote.payload,
        conflict: null,
        dirty: true,
        payload: merged.value,
        revision: remote.revision,
        saving: false,
        updatedAt: remote.updatedAt,
      };
      commitRecord(resource, next);
      return next;
    }
    commitRecord(resource, {
      ...current,
      conflict: {
        base: current.base,
        paths: merged.conflicts,
        remote: remote.payload,
        remoteRevision: remote.revision,
        remoteUpdatedAt: remote.updatedAt,
      },
      saving: false,
    });
    return null;
  }, [commitRecord, readRemote]);

  const flushResourceRef = useRef(null);
  const queueFlush = useCallback((resource, delay = SAVE_DELAY_MS) => {
    const existing = timersRef.current.get(resource);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      timersRef.current.delete(resource);
      void flushResourceRef.current?.(resource);
    }, delay);
    timersRef.current.set(resource, timer);
  }, []);

  const invalidateResourceSave = useCallback((resource) => {
    saveOperationsRef.current.set(resource, (saveOperationsRef.current.get(resource) || 0) + 1);
    retryAttemptsRef.current.delete(resource);
    const timer = timersRef.current.get(resource);
    if (timer) window.clearTimeout(timer);
    timersRef.current.delete(resource);
  }, []);

  const scheduleRetry = useCallback((resource) => {
    const attempt = (retryAttemptsRef.current.get(resource) || 0) + 1;
    retryAttemptsRef.current.set(resource, attempt);
    const delay = Math.min(MAX_SAVE_RETRY_MS, 1000 * (2 ** Math.min(attempt - 1, 5)));
    queueFlush(resource, delay);
  }, [queueFlush]);

  const flushResource = useCallback(async (resource) => {
    const snapshot = recordsRef.current[resource];
    if (!snapshot?.dirty || snapshot.conflict || snapshot.saving || navigator.onLine === false) return;
    const providerGeneration = providerGenerationRef.current;
    const operationId = (saveOperationsRef.current.get(resource) || 0) + 1;
    saveOperationsRef.current.set(resource, operationId);
    commitRecord(resource, { ...snapshot, saving: true });
    setProviderError(null);
    try {
      const payload = sanitizeCloudResource(resource, snapshot.payload);
      let result;
      if (snapshot.revision === 0) {
        result = await client
          .from("account_state")
          .insert({ payload, resource, user_id: userId })
          .select(REMOTE_COLUMNS)
          .single();
      } else {
        result = await client
          .from("account_state")
          .update({ payload })
          .eq("user_id", userId)
          .eq("resource", resource)
          .eq("revision", snapshot.revision)
          .select(REMOTE_COLUMNS)
          .maybeSingle();
      }

      if (result.error) {
        if (result.error.code === "23505") {
          const merged = await resolveVersionConflict(resource, snapshot, operationId, providerGeneration);
          if (merged) queueFlush(resource, 0);
          return;
        }
        throw result.error;
      }
      if (!result.data) {
        const merged = await resolveVersionConflict(resource, snapshot, operationId, providerGeneration);
        if (merged) queueFlush(resource, 0);
        return;
      }
      const acknowledged = remoteRowToRecord(result.data, userId);
      if (!acknowledged) throw new Error("The account service returned an invalid sync acknowledgement.");
      if (providerGenerationRef.current !== providerGeneration
        || saveOperationsRef.current.get(resource) !== operationId) return;
      retryAttemptsRef.current.delete(resource);
      remoteResourcesRef.current.add(resource);
      const current = recordsRef.current[resource] || snapshot;
      if (acknowledged.revision < current.revision
        || (current.conflict && current.conflict.remoteRevision >= acknowledged.revision)) {
        const next = { ...current, saving: false };
        commitRecord(resource, next);
        if (next.dirty && !next.conflict) queueFlush(resource, 0);
      } else if (current.localVersion !== snapshot.localVersion) {
        commitRecord(resource, {
          ...current,
          base: acknowledged.payload,
          dirty: true,
          revision: acknowledged.revision,
          saving: false,
          updatedAt: acknowledged.updatedAt,
        });
        queueFlush(resource, 0);
      } else {
        commitRecord(resource, {
          ...acknowledged,
          localVersion: current.localVersion,
          payload: current.payload,
        });
      }
    } catch (error) {
      if (providerGenerationRef.current !== providerGeneration
        || saveOperationsRef.current.get(resource) !== operationId) return;
      const current = recordsRef.current[resource] || snapshot;
      commitRecord(resource, { ...current, dirty: true, saving: false });
      setProviderError(readableSyncError());
      if (isRetryableCloudSyncError(error)) scheduleRetry(resource);
    }
  }, [client, commitRecord, queueFlush, resolveVersionConflict, scheduleRetry, userId]);
  flushResourceRef.current = flushResource;

  const refreshRemote = useCallback(async () => {
    const refreshId = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = refreshId;
    const providerGeneration = providerGenerationRef.current;
    try {
      const result = await client
        .from("account_state")
        .select(REMOTE_COLUMNS)
        .eq("user_id", userId);
      if (providerGenerationRef.current !== providerGeneration
        || refreshSequenceRef.current !== refreshId) return;
      if (result.error) throw result.error;
      const remoteByResource = Object.fromEntries((result.data || [])
        .map((row) => remoteRowToRecord(row, userId))
        .filter(Boolean)
        .map((record) => [record.resource, record]));
      remoteResourcesRef.current = new Set(Object.keys(remoteByResource));
      for (const resource of CLOUD_SYNC_RESOURCES) {
        const current = recordsRef.current[resource];
        const remote = remoteByResource[resource] || null;
        if (!current && remote) {
          commitRecord(resource, remote);
        } else if (current && !remote) {
          const reconciled = reconcileAuthoritativeRecord(current, null);
          invalidateResourceSave(resource);
          if (!reconciled) removeRecord(resource);
          else commitRecord(resource, { ...reconciled, saving: false });
        } else if (current && remote && remote.revision !== current.revision) {
          const reconciled = reconcileAuthoritativeRecord(current, remote);
          if (remote.revision < current.revision) invalidateResourceSave(resource);
          const next = { ...reconciled, saving: false };
          commitRecord(resource, next);
          if (next.dirty && !next.conflict) queueFlush(resource, 0);
        }
      }
      setProviderError(null);
      for (const resource of CLOUD_SYNC_RESOURCES) {
        const current = recordsRef.current[resource];
        if (current?.dirty && !current.conflict && !current.saving) queueFlush(resource, 0);
      }
    } catch {
      if (providerGenerationRef.current === providerGeneration
        && refreshSequenceRef.current === refreshId) setProviderError(readableSyncError());
    }
  }, [client, commitRecord, invalidateResourceSave, queueFlush, removeRecord, userId]);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    const providerGeneration = providerGenerationRef.current + 1;
    providerGenerationRef.current = providerGeneration;
    remoteResourcesRef.current = new Set();
    const load = async () => {
      setPhase("loading");
      setProviderError(null);
      setCacheWarning(false);
      const caches = Object.fromEntries(CLOUD_SYNC_RESOURCES
        .map((resource) => [resource, readCloudResourceCache(window.localStorage, userId, resource)])
        .filter(([, record]) => Boolean(record)));
      try {
        const result = await client
          .from("account_state")
          .select(REMOTE_COLUMNS)
          .eq("user_id", userId);
        if (result.error) throw result.error;
        if (!active || providerGenerationRef.current !== providerGeneration) return;
        const remoteByResource = Object.fromEntries((result.data || [])
          .map((row) => remoteRowToRecord(row, userId))
          .filter(Boolean)
          .map((record) => [record.resource, record]));
        remoteResourcesRef.current = new Set(Object.keys(remoteByResource));
        const next = {};
        for (const resource of CLOUD_SYNC_RESOURCES) {
          const reconciled = reconcileAuthoritativeRecord(caches[resource] || null, remoteByResource[resource] || null);
          if (reconciled) next[resource] = reconciled;
        }
        recordsRef.current = next;
        setRecords(next);
        for (const resource of CLOUD_SYNC_RESOURCES) {
          if (caches[resource] && !next[resource]) {
            try {
              removeCloudResourceCache(window.localStorage, userId, resource);
            } catch {
              setCacheWarning(true);
            }
          }
        }
        for (const record of Object.values(next)) {
          try {
            writeCloudResourceCache(window.localStorage, record);
          } catch {
            // A full or restricted browser cache must not make a healthy cloud account unusable.
            setCacheWarning(true);
          }
        }
        setPhase("ready");
        for (const record of Object.values(next)) {
          if (record.dirty && !record.conflict) queueFlush(record.resource, 0);
        }
      } catch {
        if (!active || providerGenerationRef.current !== providerGeneration) return;
        if (Object.keys(caches).length) {
          recordsRef.current = caches;
          setRecords(caches);
          setProviderError(readableSyncError());
          setPhase("ready");
          for (const record of Object.values(caches)) {
            if (record.dirty && !record.conflict) queueFlush(record.resource, 0);
          }
        } else {
          setProviderError("We could not load this account, and this device has no confirmed offline copy yet.");
          setPhase("blocked");
        }
      }
    };
    void load();
    return () => {
      active = false;
      mountedRef.current = false;
      providerGenerationRef.current += 1;
      refreshSequenceRef.current += 1;
      for (const timer of timersRef.current.values()) window.clearTimeout(timer);
      timersRef.current.clear();
      retryAttemptsRef.current.clear();
    };
  }, [client, queueFlush, reloadToken, userId]);

  useEffect(() => {
    if (phase !== "ready") return undefined;
    const goOnline = () => {
      setOnline(true);
      setProviderError(null);
      for (const resource of CLOUD_SYNC_RESOURCES) queueFlush(resource, 0);
      void refreshRemote();
    };
    const goOffline = () => setOnline(false);
    const refreshVisible = () => {
      if (document.visibilityState === "visible" && navigator.onLine !== false) {
        void refreshRemote();
      }
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [phase, queueFlush, refreshRemote]);

  useEffect(() => {
    if (phase !== "ready" || typeof client.channel !== "function") return undefined;
    const providerGeneration = providerGenerationRef.current;
    const channel = client
      .channel(`account-state-${userId}`)
      .on("postgres_changes", {
        event: "*",
        filter: `user_id=eq.${userId}`,
        schema: "public",
        table: "account_state",
      }, (event) => {
        if (providerGenerationRef.current !== providerGeneration) return;
        if (event.eventType === "DELETE") {
          const deletedResource = event.old?.user_id === userId
            && CLOUD_SYNC_RESOURCES.includes(event.old?.resource)
            ? event.old.resource
            : null;
          if (!deletedResource) return;
          remoteResourcesRef.current.delete(deletedResource);
          void refreshRemote();
          return;
        }
        const remote = remoteRowToRecord(event.new, userId);
        if (!remote) return;
        remoteResourcesRef.current.add(remote.resource);
        const current = recordsRef.current[remote.resource];
        if (!current) {
          commitRecord(remote.resource, remote);
        } else if (!current.dirty && remote.revision > current.revision) {
          commitRecord(remote.resource, remote);
        } else if (current.dirty && remote.revision > current.revision) {
          const reconciled = reconcileCachedRecord(current, remote);
          const next = { ...reconciled, saving: false };
          commitRecord(remote.resource, next);
          if (next.dirty && !next.conflict) queueFlush(remote.resource, 0);
        } else if (remote.revision < current.revision) {
          void refreshRemote();
        }
      })
      .subscribe();
    return () => { void client.removeChannel?.(channel); };
  }, [client, commitRecord, phase, queueFlush, refreshRemote, userId]);

  const updateResource = useCallback((resource, recipe, fallback) => {
    const current = recordsRef.current[resource] || emptyRecord(userId, resource, fallback);
    const nextPayload = typeof recipe === "function" ? recipe(current.payload ?? fallback) : recipe;
    const next = {
      ...current,
      conflict: null,
      dirty: true,
      localVersion: current.localVersion + 1,
      payload: nextPayload,
    };
    commitRecord(resource, next);
    queueFlush(resource);
  }, [commitRecord, queueFlush, userId]);

  const resolveConflict = useCallback((resource, choice) => {
    const current = recordsRef.current[resource];
    if (!current?.conflict) return;
    invalidateResourceSave(resource);
    if (choice === "cloud") {
      if (current.conflict.remote == null) {
        removeRecord(resource);
        return;
      }
      remoteResourcesRef.current.add(resource);
      commitRecord(resource, {
        ...current,
        base: current.conflict.remote ?? undefined,
        conflict: null,
        dirty: false,
        localVersion: current.localVersion + 1,
        payload: current.conflict.remote ?? undefined,
        revision: current.conflict.remoteRevision,
        saving: false,
        updatedAt: current.conflict.remoteUpdatedAt,
      });
      return;
    }
    commitRecord(resource, {
      ...current,
      base: current.conflict.remote ?? undefined,
      conflict: null,
      dirty: true,
      localVersion: current.localVersion + 1,
      revision: current.conflict.remoteRevision,
      saving: false,
      updatedAt: current.conflict.remoteUpdatedAt,
    });
    queueFlush(resource, 0);
  }, [commitRecord, invalidateResourceSave, queueFlush, removeRecord]);

  const importResources = useCallback(async (payloads) => {
    const providerGeneration = providerGenerationRef.current;
    if (remoteResourcesRef.current.size > 0 || Object.keys(recordsRef.current).length > 0) {
      throw new Error("This account already has synced board data. It was not overwritten.");
    }
    const rows = CLOUD_SYNC_RESOURCES.flatMap((resource) => (
      Object.hasOwn(payloads, resource)
        ? [{ payload: sanitizeCloudResource(resource, payloads[resource]), resource, user_id: userId }]
        : []
    ));
    if (!rows.length) return;
    const result = await client.from("account_state").insert(rows).select(REMOTE_COLUMNS);
    if (result.error) throw result.error;
    if (providerGenerationRef.current !== providerGeneration) {
      throw new Error("The account changed before the import finished. Reload before trying again.");
    }
    const imported = (result.data || []).map((row) => remoteRowToRecord(row, userId)).filter(Boolean);
    if (imported.length !== rows.length) throw new Error("The imported account data was not fully acknowledged.");
    for (const record of imported) commitRecord(record.resource, record);
    remoteResourcesRef.current = new Set(imported.map((record) => record.resource));
  }, [client, commitRecord, userId]);

  const status = useMemo(
    () => syncStatus(records, online, providerError, cacheWarning),
    [cacheWarning, online, providerError, records],
  );
  const value = useMemo(() => ({
    client,
    hasRemoteData: remoteResourcesRef.current.size > 0 || Object.keys(records).length > 0,
    importResources,
    providerError,
    records,
    resolveConflict,
    status,
    updateResource,
    userId,
  }), [client, importResources, providerError, records, resolveConflict, status, updateResource, userId]);

  if (phase === "loading") {
    return (
      <main className="profile-gate">
        <section className="profile-gate-card">
          <div className="profile-gate-copy" aria-live="polite" role="status">
            <h2>Opening your account…</h2>
            <p>Loading your latest synced board and checking for unsent changes on this device.</p>
          </div>
        </section>
      </main>
    );
  }
  if (phase === "blocked") {
    return (
      <main className="profile-gate">
        <section className="profile-gate-card">
          <div className="profile-gate-copy">
            <h2>Your account could not be opened</h2>
            <p>{providerError}</p>
          </div>
          <button className="profile-gate-primary" onClick={() => setReloadToken((value) => value + 1)} type="button">
            <Icon name="reset" size={17} />Retry
          </button>
        </section>
      </main>
    );
  }
  return <CloudSyncContext.Provider value={value}>{children}</CloudSyncContext.Provider>;
}

export { useCloudSync };

const RESOURCE_LABELS = Object.freeze({
  "assistant:v2": "assistant history",
  "cloudChat:v1": "Semester Chat history",
  "dashboard:v1": "dashboard progress",
});

export function CloudSyncConflictPanel() {
  const cloud = useCloudSync();
  const conflicts = Object.entries(cloud?.records || {}).filter(([, record]) => record?.conflict);
  if (!conflicts.length) return null;
  return (
    <aside className="cloud-sync-conflicts" aria-labelledby="cloud-sync-conflicts-title">
      <div>
        <span className="cloud-sync-conflicts-icon"><Icon name="warning" size={20} /></span>
        <div>
          <strong id="cloud-sync-conflicts-title">Choose which conflicting changes to keep</strong>
          <p>Another signed-in device changed the same saved field. Semester Board kept both copies and will not guess.</p>
        </div>
      </div>
      <ul>
        {conflicts.map(([resource, record]) => (
          <li key={resource}>
            <span>
              <strong>{RESOURCE_LABELS[resource] || resource}</strong>
              <small>{record.conflict.paths.slice(0, 3).join(", ")}{record.conflict.paths.length > 3 ? ` +${record.conflict.paths.length - 3} more` : ""}</small>
            </span>
            <span className="cloud-sync-conflict-actions">
              <button onClick={() => cloud.resolveConflict(resource, "device")} type="button">Keep this device</button>
              <button onClick={() => cloud.resolveConflict(resource, "cloud")} type="button">Use cloud copy</button>
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
