import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getReminderDeliveryId } from "../lib/assistantEngine.js";
import {
  PUSH_OWNER_SIGNAL_KEY,
  canAutomaticallySyncPushSettings,
  createPushOwnerSignal,
  canClaimLegacyPushSettings,
  decodeVapidPublicKey,
  disablePushSchedule,
  genericPushReminderCopy,
  isSchedulablePushReminder,
  mergeLegacyPushSettings,
  pushCapabilityStatus,
  pushOwnerSignalDisplacesProfile,
  pushSettingsBelongToProfile,
  readPushSettings,
  sha256Hex,
  writePushSchedule,
  writePushSettings,
} from "../lib/pushClient.js";
import { LEGACY_PROFILE_CLAIM_KEY, pushMirrorStorageKeys } from "../lib/profileStorage.js";

const MAX_REMINDERS = 512;

function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // IndexedDB is authoritative; localStorage is only a legacy migration mirror.
  }
}

function readLegacyPushSettings(storageKeys) {
  return {
    endpointHash: storageGet(storageKeys.endpointHash),
    receipt: storageGet(storageKeys.receipt),
    revision: storageGet(storageKeys.revision),
  };
}

async function readPrimaryPushSettings(profileId, storageKeys) {
  const legacy = readLegacyPushSettings(storageKeys);
  try {
    const durable = await readPushSettings();
    const merged = mergeLegacyPushSettings(durable, legacy);
    const mayClaimLegacy = !merged?.profileId && canClaimLegacyPushSettings(
      merged,
      legacy,
      storageGet(LEGACY_PROFILE_CLAIM_KEY),
      profileId,
    );
    const nextSettings = mayClaimLegacy
      ? { ...merged, profileId }
      : merged;
    if (nextSettings && (merged !== durable || nextSettings !== merged)) {
      await writePushSettings(nextSettings);
    }
    return nextSettings;
  } catch {
    const merged = mergeLegacyPushSettings(null, legacy);
    return canClaimLegacyPushSettings(
      merged,
      legacy,
      storageGet(LEGACY_PROFILE_CLAIM_KEY),
      profileId,
    ) ? { ...merged, profileId } : merged;
  }
}

function clearPushMirror(storageKeys) {
  storageSet(storageKeys.receipt, null);
  storageSet(storageKeys.revision, null);
  storageSet(storageKeys.endpointHash, null);
}

function clearPreviousPushMirror(settings, profileId) {
  const previousProfileId = settings?.profileId || storageGet(LEGACY_PROFILE_CLAIM_KEY);
  if (!previousProfileId || previousProfileId === profileId) return;
  try {
    clearPushMirror(pushMirrorStorageKeys(previousProfileId));
  } catch {
    // Ignore malformed legacy ownership metadata.
  }
}

function publishPushOwnerSignal(ownerProfileId, previousOwnerProfileId = null) {
  try {
    window.localStorage.setItem(PUSH_OWNER_SIGNAL_KEY, createPushOwnerSignal({
      ownerProfileId,
      previousOwnerProfileId,
    }));
  } catch {
    // IndexedDB ownership remains authoritative if cross-tab signaling is blocked.
  }
}

async function withPushScheduleLock(callback, { required = false } = {}) {
  const lockManager = typeof window !== "undefined" ? window.navigator?.locks : null;
  if (!lockManager || typeof lockManager.request !== "function") {
    if (required) throw new Error("This browser cannot safely coordinate closed-tab reminders across tabs.");
    return callback();
  }
  return lockManager.request("fall2026Quest:pushSchedule:v1", { mode: "exclusive" }, callback);
}

async function fetchWithTimeout(url, options, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function bytesEqual(left, right) {
  if (!left || left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left);
  return leftBytes.every((byte, index) => byte === right[index]);
}

async function readJsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || data?.error || "The reminder service could not complete that request.");
  return data;
}

async function prepareSchedule(reminders) {
  const now = Date.now();
  const future = reminders
    .filter((reminder) => isSchedulablePushReminder(reminder, now))
    .slice(0, MAX_REMINDERS);
  const prepared = await Promise.all(future.map(async (reminder) => {
    const deliveryId = getReminderDeliveryId(reminder);
    const id = await sha256Hex(deliveryId);
    const notificationCopy = genericPushReminderCopy(reminder.type);
    return {
      detail: {
        body: notificationCopy.body,
        id,
        targetAt: reminder.targetAt,
        title: notificationCopy.title,
        url: reminder.type === "class-1h" ? "/#attendance" : "/",
      },
      occurrence: {
        id,
        remindAt: reminder.remindAt,
        targetAt: reminder.targetAt,
        type: reminder.type,
      },
    };
  }));
  const occurrences = prepared.map(({ occurrence }) => occurrence);
  const revision = await sha256Hex(JSON.stringify(occurrences));
  return {
    details: prepared.map(({ detail }) => detail),
    occurrences,
    revision,
  };
}

export function usePushReminders(reminders = [], profileId) {
  const [phase, setPhase] = useState(() => {
    const capability = pushCapabilityStatus();
    return capability === "blocked" || capability === "unsupported" ? capability : "idle";
  });
  const [permission, setPermission] = useState(() => (
    typeof window !== "undefined" && "Notification" in window
      ? window.Notification.permission
      : "unsupported"
  ));
  const [notice, setNotice] = useState(null);
  const [scheduledCount, setScheduledCount] = useState(0);
  const syncingRef = useRef(false);
  const autoSignatureRef = useRef(null);
  const enabled = phase === "enabled" || phase === "syncing" || phase === "testing";
  const storageKeys = useMemo(() => pushMirrorStorageKeys(profileId), [profileId]);
  const reminderSignature = useMemo(() => reminders
    .map((reminder) => getReminderDeliveryId(reminder))
    .filter(Boolean)
    .join("|"), [reminders]);

  const syncSubscription = useCallback(async (
    subscription,
    { allowOwnershipTransfer = false, force = false } = {},
  ) => {
    if (syncingRef.current) return null;
    syncingRef.current = true;
    setPhase("syncing");
    try {
      return await withPushScheduleLock(async () => {
        const schedule = await prepareSchedule(reminders);
        const endpointHash = await sha256Hex(subscription.endpoint);
        const currentSettings = await readPrimaryPushSettings(profileId, storageKeys);
        if (!allowOwnershipTransfer && !canAutomaticallySyncPushSettings(currentSettings, profileId)) {
          setScheduledCount(0);
          setPhase("idle");
          setNotice("Closed-tab reminders changed in another profile or tab. Choose Enable reminders to turn them on here.");
          return { ownershipLost: true, scheduled: 0 };
        }
        if (!force
          && pushSettingsBelongToProfile(currentSettings, profileId)
          && currentSettings?.revision === schedule.revision
          && currentSettings?.endpointHash === endpointHash
          && currentSettings?.receipt) {
          await writePushSchedule({
            details: schedule.details,
            enabled: true,
            endpointHash,
            profileId,
            receipt: currentSettings.receipt,
            revision: schedule.revision,
          });
          publishPushOwnerSignal(profileId, profileId);
          setScheduledCount(schedule.occurrences.length);
          setPhase("enabled");
          return { scheduled: schedule.occurrences.length, unchanged: true };
        }

        const response = await fetch("/api/push/sync", {
          body: JSON.stringify({
            previousReceipt: currentSettings?.receipt || undefined,
            reminders: schedule.occurrences,
            revision: schedule.revision,
            subscription: subscription.toJSON(),
          }),
          cache: "no-store",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const result = await readJsonResponse(response);
        try {
          await writePushSchedule({
            details: schedule.details,
            enabled: true,
            endpointHash,
            profileId,
            receipt: result.receipt,
            revision: schedule.revision,
          });
        } catch {
          if (result.receipt) {
            await fetch("/api/push/disable", {
              body: JSON.stringify({ receipt: result.receipt }),
              cache: "no-store",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              method: "POST",
            }).catch(() => {});
          }
          throw new Error("The new reminder schedule could not be saved safely, so it was turned off. Try again.");
        }
        clearPreviousPushMirror(currentSettings, profileId);
        storageSet(storageKeys.receipt, result.receipt);
        storageSet(storageKeys.revision, schedule.revision);
        storageSet(storageKeys.endpointHash, endpointHash);
        publishPushOwnerSignal(
          profileId,
          currentSettings?.profileId || storageGet(LEGACY_PROFILE_CLAIM_KEY) || null,
        );
        setScheduledCount(result.scheduled ?? schedule.occurrences.length);
        setPhase("enabled");
        setNotice(`Closed-tab reminders are scheduled on this device (${result.scheduled ?? schedule.occurrences.length}).`);
        return result;
      }, { required: true });
    } catch (error) {
      setPhase("error");
      setNotice(error instanceof Error ? error.message : "Closed-tab reminders could not be scheduled.");
      throw error;
    } finally {
      syncingRef.current = false;
    }
  }, [profileId, reminders, storageKeys]);

  useEffect(() => {
    const handlePushOwnerChange = (event) => {
      if (event.key !== PUSH_OWNER_SIGNAL_KEY
        || !pushOwnerSignalDisplacesProfile(event.newValue, profileId)) return;
      autoSignatureRef.current = null;
      setScheduledCount(0);
      setPhase("idle");
      setNotice("Closed-tab reminders changed in another profile or tab. Choose Enable reminders to turn them on here.");
    };
    window.addEventListener("storage", handlePushOwnerChange);
    return () => window.removeEventListener("storage", handlePushOwnerChange);
  }, [profileId]);

  useEffect(() => {
    let cancelled = false;
    async function inspectExistingSubscription() {
      const capability = pushCapabilityStatus();
      if (capability === "unsupported" || capability === "blocked") return;
      try {
        const registration = await window.navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        const settings = await readPrimaryPushSettings(profileId, storageKeys);
        if (cancelled
          || !subscription
          || !settings?.enabled
          || !settings.receipt
          || !pushSettingsBelongToProfile(settings, profileId)) return;
        const endpointHash = await sha256Hex(subscription.endpoint);
        if (settings.endpointHash !== endpointHash) return;
        setPermission(window.Notification.permission);
        setPhase("enabled");
      } catch {
        // Do not register a worker or call the server merely by opening the dashboard.
      }
    }
    inspectExistingSubscription();
    return () => { cancelled = true; };
  }, [profileId, storageKeys]);

  useEffect(() => {
    if (!enabled || phase !== "enabled") return undefined;
    if (autoSignatureRef.current === reminderSignature) return undefined;
    autoSignatureRef.current = reminderSignature;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const registration = await window.navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        if (!cancelled && subscription) await syncSubscription(subscription);
      } catch {
        // syncSubscription already exposes an actionable notice.
      }
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, phase, reminderSignature, syncSubscription]);

  const enable = useCallback(async () => {
    const capability = pushCapabilityStatus();
    if (capability === "unsupported") {
      setPhase("unsupported");
      setNotice("This browser cannot safely coordinate closed-tab reminders. In-dashboard check-ins still work.");
      return;
    }
    if (capability === "blocked") {
      setPhase("blocked");
      setPermission("denied");
      setNotice("Notifications are blocked. Use the site controls beside the address bar, allow Notifications, then reload.");
      return;
    }

    setPhase("enabling");
    setNotice(null);
    try {
      let nextPermission = window.Notification.permission;
      if (nextPermission === "default") nextPermission = await window.Notification.requestPermission();
      setPermission(nextPermission);
      if (nextPermission !== "granted") {
        setPhase(nextPermission === "denied" ? "blocked" : "idle");
        setNotice(nextPermission === "denied"
          ? "Notifications are blocked. Use the site controls beside the address bar, allow Notifications, then reload."
          : "Notification permission was not granted. In-dashboard check-ins still work.");
        return;
      }

      const configResponse = await fetch("/api/push/config", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const config = await readJsonResponse(configResponse);
      if (!config.available || !config.publicKey) throw new Error("Closed-tab reminders are not configured on this deployment.");

      const registration = await window.navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await window.navigator.serviceWorker.ready;
      const publicKey = decodeVapidPublicKey(config.publicKey);
      let subscription = await registration.pushManager.getSubscription();
      if (subscription?.options?.applicationServerKey
        && !bytesEqual(subscription.options.applicationServerKey, publicKey)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          applicationServerKey: publicKey,
          userVisibleOnly: true,
        });
      }
      await syncSubscription(subscription, { allowOwnershipTransfer: true, force: true });
    } catch (error) {
      setPhase("error");
      setNotice(error instanceof Error ? error.message : "Closed-tab reminders could not be enabled.");
    }
  }, [syncSubscription]);

  const disable = useCallback(async ({ requireSafe = false } = {}) => {
    setPhase("disabling");
    let disabledOwnedSchedule;
    try {
      disabledOwnedSchedule = await withPushScheduleLock(async () => {
        const settings = await readPrimaryPushSettings(profileId, storageKeys);
        if (!pushSettingsBelongToProfile(settings, profileId)) {
          clearPushMirror(storageKeys);
          return false;
        }
        const receipt = settings?.receipt || null;
        await disablePushSchedule();
        clearPushMirror(storageKeys);
        publishPushOwnerSignal(null, profileId);
        if (receipt) {
          await fetchWithTimeout("/api/push/disable", {
            body: JSON.stringify({ receipt }),
            cache: "no-store",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }).catch(() => {});
        }
        try {
          const registration = await window.navigator.serviceWorker?.getRegistration?.("/");
          const subscription = await registration?.pushManager.getSubscription();
          await subscription?.unsubscribe();
        } catch {
          // The disabled IndexedDB state already makes the service worker suppress delivery.
        }
        return true;
      });
    } catch (error) {
      setPhase("error");
      setNotice("Closed-tab reminders could not be turned off safely. Try again before signing out.");
      if (requireSafe) throw error;
      return false;
    }

    if (!disabledOwnedSchedule) {
      setScheduledCount(0);
      setPhase(window.Notification?.permission === "denied" ? "blocked" : "idle");
      setNotice("Closed-tab reminders were not enabled for this local profile.");
      return false;
    }
    setScheduledCount(0);
    setPhase(window.Notification?.permission === "denied" ? "blocked" : "idle");
    setNotice("Closed-tab reminders are off on this device. In-dashboard check-ins remain active.");
    return true;
  }, [profileId, storageKeys]);

  const sendTest = useCallback(async () => {
    setPhase("testing");
    try {
      const registration = await window.navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      const settings = await readPrimaryPushSettings(profileId, storageKeys);
      const endpointHash = subscription ? await sha256Hex(subscription.endpoint) : null;
      if (
        !subscription
        || !settings?.enabled
        || !settings.receipt
        || !pushSettingsBelongToProfile(settings, profileId)
        || settings.endpointHash !== endpointHash
      ) {
        throw Object.assign(
          new Error("Enable closed-tab reminders before sending a test."),
          { code: "push_not_owned" },
        );
      }
      const response = await fetch("/api/push/test", {
        body: JSON.stringify({ receipt: settings.receipt, subscription: subscription.toJSON() }),
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      await readJsonResponse(response);
      setPhase("enabled");
      setNotice("Test reminder sent. Your operating system controls whether a banner is visible.");
    } catch (error) {
      // A failed test does not disable an otherwise valid subscription.
      setPhase(error?.code === "push_not_owned" ? "idle" : "enabled");
      setNotice(error instanceof Error ? error.message : "The test reminder could not be sent.");
    }
  }, [profileId, storageKeys]);

  const showPermissionHelp = useCallback(() => {
    setNotice("Use the site controls beside the address bar → Site settings → Notifications → Allow, then reload this page.");
  }, []);

  return {
    disable,
    enable,
    enabled,
    notice,
    permission,
    phase,
    scheduledCount,
    sendTest,
    setNotice,
    showPermissionHelp,
  };
}
