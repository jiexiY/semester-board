import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MAX_ASSIGNMENT_FILE_BATCH,
  addAssignmentFile,
  deleteAssignmentFile,
  listAssignmentFiles,
  readAssignmentFile,
} from "../lib/assignmentFiles.js";

const IDLE = Object.freeze({ state: "idle", message: "" });

function readableError(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useAssignmentFiles({ client = null, enabled = true, profileId }) {
  const [files, setFiles] = useState([]);
  const [status, setStatus] = useState(IDLE);

  const refresh = useCallback(async () => {
    if (!enabled || !profileId) return [];
    const records = await listAssignmentFiles({ client, profileId });
    setFiles(records);
    return records;
  }, [client, enabled, profileId]);

  useEffect(() => {
    if (!enabled || !profileId) {
      setFiles([]);
      setStatus(IDLE);
      return undefined;
    }
    let current = true;
    setStatus({ state: "loading", message: "Loading private assignment documents…" });
    listAssignmentFiles({ client, profileId })
      .then((records) => {
        if (!current) return;
        setFiles(records);
        setStatus(IDLE);
      })
      .catch((error) => {
        if (!current) return;
        setStatus({ state: "error", message: readableError(error, "Assignment documents could not be loaded.") });
      });
    return () => { current = false; };
  }, [client, enabled, profileId]);

  const addFiles = useCallback(async (selectedFiles, context) => {
    const selected = Array.from(selectedFiles || []).slice(0, MAX_ASSIGNMENT_FILE_BATCH);
    if (!selected.length) return { failed: [], saved: [] };
    setStatus({ state: "saving", message: `Saving ${selected.length} private assignment document${selected.length === 1 ? "" : "s"}…` });
    const results = await Promise.allSettled(selected.map((file) => addAssignmentFile({
      assignmentId: context.assignmentId,
      client,
      courseId: context.courseId,
      documentKind: context.documentKind,
      file,
      profileId,
    })));
    const saved = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
    const failed = results.filter((result) => result.status === "rejected");
    try {
      await refresh();
    } catch (error) {
      setStatus({ state: "error", message: saved.length ? `${saved.length} document${saved.length === 1 ? " was" : "s were"} saved, but the list could not refresh.` : readableError(error, "Assignment documents could not be refreshed.") });
      return { failed, saved };
    }
    setStatus(failed.length ? {
      state: "error",
      message: `${saved.length} saved; ${failed.length} failed. ${readableError(failed[0]?.reason, "Check the file type and 20 MiB limit.")}`,
    } : {
      state: "success",
      message: `${saved.length} document${saved.length === 1 ? " is" : "s are"} saved ${client ? "privately to this account" : "on this device"}.`,
    });
    return { failed, saved };
  }, [client, profileId, refresh]);

  const removeFile = useCallback(async (record) => {
    setStatus({ state: "removing", message: `Removing ${record.fileName}…` });
    try {
      const removed = await deleteAssignmentFile({ client, profileId, record });
      if (!removed) throw new Error("That attachment is no longer available.");
      setFiles((current) => current.filter((item) => item.id !== record.id));
      setStatus({ state: "success", message: `${record.fileName} was removed.` });
      return true;
    } catch (error) {
      setStatus({ state: "error", message: readableError(error, "The document could not be removed.") });
      return false;
    }
  }, [client, profileId]);

  const downloadFile = useCallback(async (record) => {
    setStatus({ state: "loading", message: `Preparing ${record.fileName}…` });
    try {
      const blob = await readAssignmentFile({ client, profileId, record });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = record.fileName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus({ state: "success", message: `${record.fileName} downloaded.` });
      return true;
    } catch (error) {
      setStatus({ state: "error", message: readableError(error, "The document could not be downloaded.") });
      return false;
    }
  }, [client, profileId]);

  const byAssignment = useMemo(() => files.reduce((groups, file) => {
    groups[file.assignmentId] = [...(groups[file.assignmentId] || []), file];
    return groups;
  }, {}), [files]);

  return { addFiles, byAssignment, downloadFile, files, refresh, removeFile, status };
}
