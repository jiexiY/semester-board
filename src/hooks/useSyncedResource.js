import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { profileStorageKey } from "../lib/profileStorage.js";

export const CloudSyncContext = createContext(null);

function localResourceValue(profileId, resource, fallback, normalize) {
  try {
    const raw = window.localStorage.getItem(profileStorageKey(profileId, resource));
    return raw ? normalize(JSON.parse(raw)) : fallback;
  } catch {
    return fallback;
  }
}

export function useCloudSync() {
  return useContext(CloudSyncContext);
}

export function useSyncedResource({ fallback, normalize, profileId, resource }) {
  const cloud = useCloudSync();
  const storageKey = profileStorageKey(profileId, resource);
  const [localValue, setLocalValue] = useState(() => localResourceValue(profileId, resource, fallback, normalize));
  const rawCloudValue = cloud?.records?.[resource]?.payload;
  const value = useMemo(() => {
    if (!cloud) return localValue;
    try {
      return normalize(rawCloudValue ?? fallback);
    } catch {
      return fallback;
    }
  }, [cloud, fallback, localValue, normalize, rawCloudValue]);

  useEffect(() => {
    if (cloud) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(localValue));
    } catch {
      // Device-only profiles continue in memory when browser storage is unavailable.
    }
  }, [cloud, localValue, storageKey]);

  const setValue = useCallback((recipe) => {
    if (cloud) {
      cloud.updateResource(resource, (current) => {
        let normalized;
        try {
          normalized = normalize(current ?? fallback);
        } catch {
          normalized = fallback;
        }
        return typeof recipe === "function" ? recipe(normalized) : recipe;
      }, fallback);
    } else {
      setLocalValue((current) => (typeof recipe === "function" ? recipe(current) : recipe));
    }
  }, [cloud, fallback, normalize, resource]);

  return [value, setValue, cloud?.records?.[resource] || null];
}
