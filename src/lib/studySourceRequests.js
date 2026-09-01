import {
  MAX_STUDY_SOURCE_UPLOAD_BATCH,
  STUDY_SOURCE_UPLOAD_CONCURRENCY,
  normalizeCourseSpaceId,
  normalizeStudySourceProfileId,
} from "./studySourceModel.js";

export function buildStudySourceIdentityKey({ cloudMode = false, courseSpaceId, profileId }) {
  const owner = normalizeStudySourceProfileId(profileId);
  const space = normalizeCourseSpaceId(courseSpaceId);
  return `${cloudMode ? "account" : "device"}:${owner}:${space}`;
}

export function createStudySourceIdentityGuard(initialIdentity = "") {
  let identity = String(initialIdentity || "");
  let generation = 0;

  return {
    capture() {
      return Object.freeze({ generation, identity });
    },
    get generation() {
      return generation;
    },
    get identity() {
      return identity;
    },
    isCurrent(token) {
      return Boolean(token)
        && token.identity === identity
        && token.generation === generation;
    },
    setIdentity(nextIdentity) {
      const next = String(nextIdentity || "");
      if (next !== identity) {
        identity = next;
        generation += 1;
      }
      return Object.freeze({ generation, identity });
    },
  };
}

/**
 * Runs at most four source uploads at once and considers files after the first
 * twenty failed without invoking the worker. Returned saved/failed entries are
 * the original File objects in picker order.
 */
export async function runStudySourceUploadBatch(files, worker) {
  if (typeof worker !== "function") throw new TypeError("A Study Deck source upload worker is required.");
  const selected = Array.from(files || []).filter(Boolean);
  const statuses = new Array(selected.length);
  const errors = new Array(selected.length);
  const acceptedCount = Math.min(selected.length, MAX_STUDY_SOURCE_UPLOAD_BATCH);
  for (let index = acceptedCount; index < selected.length; index += 1) {
    statuses[index] = "rejected";
    errors[index] = new Error(`Upload batches are limited to ${MAX_STUDY_SOURCE_UPLOAD_BATCH} source files.`);
  }

  let cursor = 0;
  const runWorker = async () => {
    while (cursor < acceptedCount) {
      const index = cursor;
      cursor += 1;
      try {
        await worker(selected[index], index);
        statuses[index] = "fulfilled";
      } catch (error) {
        statuses[index] = "rejected";
        errors[index] = error;
      }
    }
  };
  const workerCount = Math.min(STUDY_SOURCE_UPLOAD_CONCURRENCY, acceptedCount);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return {
    errors: errors.filter(Boolean),
    failed: selected.filter((_, index) => statuses[index] === "rejected"),
    saved: selected.filter((_, index) => statuses[index] === "fulfilled"),
  };
}
