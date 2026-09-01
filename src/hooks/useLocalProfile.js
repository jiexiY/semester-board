import { useCallback, useEffect, useState } from "react";
import {
  LOCAL_PROFILE_REGISTRY_KEY,
  createLocalProfile,
  readActiveLocalProfile,
  readLocalProfiles,
  signInLocalProfile,
  signOutLocalProfile,
} from "../lib/localProfiles.js";
import { claimLegacyLocalState } from "../lib/profileStorage.js";
import { claimLegacySyllabi } from "../lib/syllabusStorage.js";

function browserProfiles() {
  return typeof window === "undefined" ? [] : readLocalProfiles(window.localStorage);
}

function browserSession() {
  return typeof window === "undefined"
    ? null
    : readActiveLocalProfile({ storage: window.localStorage, sessionStorage: window.sessionStorage });
}

async function migrateLegacyState(profileId) {
  const currentProfiles = readLocalProfiles(window.localStorage);
  if (currentProfiles[0]?.id !== profileId) return { migrated: false, warning: null };

  let migrated = false;
  const failures = [];
  let localClaim = null;
  try {
    localClaim = claimLegacyLocalState(window.localStorage, profileId);
    migrated = localClaim.copied.length > 0;
    if (!localClaim.claimed) failures.push("browser progress");
  } catch {
    failures.push("browser progress");
  }

  if (localClaim?.claimed) {
    try {
      const syllabusClaim = await claimLegacySyllabi(profileId);
      migrated = migrated || syllabusClaim.claimed > 0;
    } catch {
      failures.push("syllabi");
    }
  }

  return {
    migrated,
    warning: failures.length
      ? `This profile is ready, but existing ${failures.join(" and ")} could not be moved yet. Sign out and back in to retry.`
      : null,
  };
}

export function useLocalProfile() {
  const [profiles, setProfiles] = useState(browserProfiles);
  const [restoredProfile] = useState(browserSession);
  const [profile, setProfile] = useState(null);
  const [restoring, setRestoring] = useState(() => Boolean(restoredProfile));
  const [restoreNotice, setRestoreNotice] = useState(null);

  const refreshProfiles = useCallback(() => setProfiles(browserProfiles()), []);

  useEffect(() => {
    const syncProfiles = (event) => {
      if (event.key === null || event.key === LOCAL_PROFILE_REGISTRY_KEY) refreshProfiles();
    };
    window.addEventListener("storage", syncProfiles);
    return () => window.removeEventListener("storage", syncProfiles);
  }, [refreshProfiles]);

  useEffect(() => {
    if (!restoredProfile) return undefined;
    let active = true;

    const restore = async () => {
      const migration = await migrateLegacyState(restoredProfile.id);
      if (migration.warning) throw new Error(migration.warning);
      if (!active) return;
      setProfile({
        ...restoredProfile,
        notice: migration.warning || (migration.migrated
          ? "Existing browser data was moved into this local profile."
          : null),
      });
      refreshProfiles();
      setRestoring(false);
    };

    restore().catch(() => {
      if (!active) return;
      signOutLocalProfile(window.sessionStorage);
      setProfile(null);
      setRestoreNotice("Existing browser data could not be checked safely, so the dashboard stayed locked. Sign in again to retry; your saved data was not replaced.");
      setRestoring(false);
    });
    return () => { active = false; };
  }, [refreshProfiles, restoredProfile]);

  const createProfile = useCallback(async ({ name, passphrase }) => {
    let created;
    try {
      created = await createLocalProfile({
        name,
        passphrase,
        storage: window.localStorage,
        sessionStorage: window.sessionStorage,
      });
    } catch (error) {
      refreshProfiles();
      throw error;
    }
    const migration = created.wasFirstProfile
      ? await migrateLegacyState(created.id)
      : { migrated: false, warning: null };
    if (migration.warning) {
      signOutLocalProfile(window.sessionStorage);
      setRestoreNotice("Existing browser data could not be checked safely, so the dashboard stayed locked. Sign in again to retry; your saved data was not replaced.");
      refreshProfiles();
      throw new Error("Existing browser data could not be moved safely. Sign in again to retry.");
    }
    const activeProfile = {
      ...created,
      notice: migration.warning || (migration.migrated ? "Existing browser data was moved into this local profile." : null),
    };
    setRestoring(false);
    setRestoreNotice(null);
    refreshProfiles();
    setProfile(activeProfile);
    return { migrated: migration.migrated, profile: activeProfile, warning: migration.warning };
  }, [refreshProfiles]);

  const signIn = useCallback(async ({ profileId, passphrase }) => {
    const signedIn = await signInLocalProfile({
      profileId,
      passphrase,
      storage: window.localStorage,
      sessionStorage: window.sessionStorage,
    });
    const migration = await migrateLegacyState(signedIn.id);
    if (migration.warning) {
      signOutLocalProfile(window.sessionStorage);
      setRestoreNotice("Existing browser data could not be checked safely, so the dashboard stayed locked. Sign in again to retry; your saved data was not replaced.");
      throw new Error("Existing browser data could not be moved safely. Sign in again to retry.");
    }
    const activeProfile = {
      ...signedIn,
      notice: migration.warning || (migration.migrated ? "Existing browser data was moved into this local profile." : null),
    };
    setRestoring(false);
    setRestoreNotice(null);
    refreshProfiles();
    setProfile(activeProfile);
    return activeProfile;
  }, [refreshProfiles]);

  const signOut = useCallback(() => {
    signOutLocalProfile(window.sessionStorage);
    setProfile(null);
  }, []);

  return {
    createProfile,
    profile,
    profiles,
    restoreNotice,
    restoring,
    restoringProfileName: restoredProfile?.name || null,
    signIn,
    signOut,
  };
}
