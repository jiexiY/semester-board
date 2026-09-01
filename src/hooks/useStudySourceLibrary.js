import { useCallback, useEffect, useRef, useState } from "react";
import {
  addStudySource,
  deleteStudySource,
  listStudySources,
  readStudySource,
} from "../lib/studySourceStorage.js";
import {
  buildStudySourceIdentityKey,
  createStudySourceIdentityGuard,
  runStudySourceUploadBatch,
} from "../lib/studySourceRequests.js";

const IDLE_STATUS = Object.freeze({ state: "idle", message: "" });

function readableError(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sortSources(records) {
  return [...records].sort((left, right) => (
    String(right.addedAt || "").localeCompare(String(left.addedAt || ""))
    || String(left.fileName || "").localeCompare(String(right.fileName || ""), "en-US")
  ));
}

function optionalIdentityKey({ cloudMode, courseSpaceId, profileId }) {
  if (!courseSpaceId || !profileId) return "";
  try {
    return buildStudySourceIdentityKey({ cloudMode, courseSpaceId, profileId });
  } catch {
    return "";
  }
}

export function useStudySourceLibrary({
  client = null,
  courseSpaceId,
  enabled = true,
  profileId,
  sourceRevision = 0,
}) {
  const cloudMode = Boolean(client);
  const identityKey = optionalIdentityKey({ cloudMode, courseSpaceId, profileId });
  const guardRef = useRef(null);
  if (!guardRef.current) guardRef.current = createStudySourceIdentityGuard(identityKey);
  guardRef.current.setIdentity(identityKey);
  const [libraryState, setLibraryState] = useState(() => ({ identity: identityKey, sources: [] }));
  const [statusState, setStatusState] = useState(() => ({ identity: identityKey, value: IDLE_STATUS }));

  const commitStatus = useCallback((token, value) => {
    if (!guardRef.current.isCurrent(token)) return false;
    setStatusState({ identity: token.identity, value });
    return true;
  }, []);

  const refresh = useCallback(async () => {
    if (!identityKey) return [];
    const token = guardRef.current.capture();
    const records = await listStudySources({ client, courseSpaceId, profileId });
    if (guardRef.current.isCurrent(token)) {
      setLibraryState({ identity: token.identity, sources: sortSources(records) });
    }
    return records;
  }, [client, courseSpaceId, identityKey, profileId]);

  useEffect(() => {
    if (!enabled || !identityKey) return undefined;
    const token = guardRef.current.capture();
    commitStatus(token, {
      state: "loading",
      message: cloudMode ? "Loading this course's account sources…" : "Loading this course's device sources…",
    });
    listStudySources({ client, courseSpaceId, profileId })
      .then((records) => {
        if (!guardRef.current.isCurrent(token)) return;
        setLibraryState({ identity: token.identity, sources: sortSources(records) });
        commitStatus(token, IDLE_STATUS);
      })
      .catch((error) => {
        commitStatus(token, {
          state: "error",
          message: readableError(error, cloudMode
            ? "This course's private sources could not be loaded from your account."
            : "This course's sources could not be loaded from this browser."),
        });
      });
    return undefined;
  }, [client, cloudMode, commitStatus, courseSpaceId, enabled, identityKey, profileId, sourceRevision]);

  useEffect(() => {
    if (!enabled || !cloudMode) return undefined;
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      refresh().catch(() => {});
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [cloudMode, enabled, refresh]);

  const addFiles = useCallback(async (files, context = {}) => {
    const selected = Array.from(files || []).filter(Boolean);
    if (!selected.length) return { failed: [], saved: [] };
    if (!identityKey || context.courseSpaceId !== courseSpaceId) {
      const token = guardRef.current.capture();
      commitStatus(token, {
        state: "error",
        message: "Choose the matching course space before adding source files.",
      });
      return { failed: selected, saved: [] };
    }

    const token = guardRef.current.capture();
    commitStatus(token, {
      state: "saving",
      message: selected.length > 20
        ? `Saving the first 20 of ${selected.length} source files; the rest will remain available to retry…`
        : `Saving ${selected.length} source file${selected.length === 1 ? "" : "s"}…`,
    });
    const results = await runStudySourceUploadBatch(selected, (file) => addStudySource({
      client,
      courseCode: context.courseCode,
      courseSpaceId,
      file,
      profileId,
    }));
    const { failed, saved } = results;
    const savedCount = saved.length;
    const failedCount = failed.length;
    if (!guardRef.current.isCurrent(token)) return { failed, saved };

    try {
      const records = await listStudySources({ client, courseSpaceId, profileId });
      if (!guardRef.current.isCurrent(token)) return { failed, saved };
      setLibraryState({ identity: token.identity, sources: sortSources(records) });
    } catch (error) {
      commitStatus(token, {
        state: "error",
        message: savedCount
          ? `${savedCount} source file${savedCount === 1 ? " was" : "s were"} saved, but the library could not refresh.`
          : readableError(error, "The source library could not refresh."),
      });
      return { failed, saved };
    }
    if (failedCount) {
      commitStatus(token, {
        state: "error",
        message: `${savedCount} saved; ${failedCount} failed. ${readableError(results.errors[0], "Check the file type, 20 MiB limit, and 20-file batch limit.")}`,
      });
    } else {
      commitStatus(token, {
        state: "success",
        message: cloudMode
          ? `${savedCount} source file${savedCount === 1 ? " is" : "s are"} saved privately to this course space in your account.`
          : `${savedCount} source file${savedCount === 1 ? " is" : "s are"} saved to this course space on this device.`,
      });
    }
    return { failed, saved };
  }, [client, cloudMode, commitStatus, courseSpaceId, identityKey, profileId]);

  const removeFile = useCallback(async (record) => {
    if (!identityKey || record?.courseSpaceId !== courseSpaceId) return false;
    const token = guardRef.current.capture();
    commitStatus(token, {
      state: "removing",
      message: `Removing ${record?.fileName || "source file"}…`,
      removingId: record?.id || null,
    });
    try {
      const removed = await deleteStudySource({ client, courseSpaceId, profileId, record });
      if (!removed) throw new Error("That Study Deck source is no longer available.");
      if (!guardRef.current.isCurrent(token)) return true;
      setLibraryState((current) => current.identity === token.identity
        ? { ...current, sources: current.sources.filter((item) => item.id !== record.id) }
        : current);
      commitStatus(token, {
        state: "success",
        message: cloudMode
          ? `${record.fileName} was removed from this course space in your account and synced devices.`
          : `${record.fileName} was removed from this course space on this device.`,
      });
      return true;
    } catch (error) {
      commitStatus(token, {
        state: "error",
        message: readableError(error, "The Study Deck source could not be removed."),
      });
      return false;
    }
  }, [client, cloudMode, commitStatus, courseSpaceId, identityKey, profileId]);

  const readFile = useCallback(async (record) => {
    if (!identityKey || record?.courseSpaceId !== courseSpaceId) {
      throw new Error("Choose the matching course space before generating study content.");
    }
    const token = guardRef.current.capture();
    const blob = await readStudySource({ client, courseSpaceId, profileId, record });
    if (!guardRef.current.isCurrent(token)) {
      throw new Error("The active Study Deck course changed while reading its sources.");
    }
    return blob;
  }, [client, courseSpaceId, identityKey, profileId]);

  const sources = enabled && identityKey && libraryState.identity === identityKey
    ? libraryState.sources
    : [];
  const status = enabled && identityKey && statusState.identity === identityKey
    ? statusState.value
    : IDLE_STATUS;

  return {
    addFiles,
    cloudMode,
    courseSpaceId: identityKey ? courseSpaceId : null,
    refresh,
    readFile,
    removeFile,
    sources,
    status,
  };
}
