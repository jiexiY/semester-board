import { readLocalProfiles, verifyPassphrase } from "./localProfiles.js";
import { PROFILE_RESOURCES, profileStorageKey } from "./profileStorage.js";
import { listSyllabi } from "./syllabusStorage.js";
import { addCloudSyllabus } from "./cloudSyllabusStorage.js";
import { addCloudStudySource } from "./cloudStudySourceStorage.js";
import { listLocalStudySourcesForProfile } from "./localStudySourceStorage.js";

const ALLOWED_RESOURCES = Object.freeze([
  PROFILE_RESOURCES.dashboard,
  PROFILE_RESOURCES.assistant,
  PROFILE_RESOURCES.cloudChat,
]);

function parseAllowedPayload(storage, profileId, resource) {
  try {
    const raw = storage?.getItem?.(profileStorageKey(profileId, resource));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (resource === PROFILE_RESOURCES.dashboard && parsed?.schemaVersion !== 1) return undefined;
    if (resource === PROFILE_RESOURCES.assistant && parsed?.schemaVersion !== 2) return undefined;
    if (resource === PROFILE_RESOURCES.cloudChat && !Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function unlockLocalProfileForMigration({ profileId, passphrase, storage = globalThis.localStorage }) {
  const profile = readLocalProfiles(storage).find((candidate) => candidate.id === profileId);
  if (!profile || !(await verifyPassphrase(passphrase, profile.verifier))) {
    throw new Error("The device-only profile or passphrase is incorrect.");
  }
  return { id: profile.id, name: profile.name };
}

export async function buildLocalMigrationManifest({
  listStudySourcesForProfile = listLocalStudySourcesForProfile,
  listSyllabiForProfile = listSyllabi,
  profileId,
  storage = globalThis.localStorage,
}) {
  const resources = Object.fromEntries(ALLOWED_RESOURCES.flatMap((resource) => {
    const payload = parseAllowedPayload(storage, profileId, resource);
    return payload === undefined ? [] : [[resource, payload]];
  }));
  const [studySources, syllabi] = await Promise.all([
    listStudySourcesForProfile(profileId),
    listSyllabiForProfile(profileId),
  ]);
  return {
    resourceCount: Object.keys(resources).length,
    resources,
    studySourceBytes: studySources.reduce((total, record) => total + (Number(record.size) || 0), 0),
    studySourceCount: studySources.length,
    studySources,
    syllabi,
    syllabusBytes: syllabi.reduce((total, record) => total + (Number(record.size) || 0), 0),
    syllabusCount: syllabi.length,
  };
}

export async function migrateLocalProfileToCloud({
  addStudySource = addCloudStudySource,
  addSyllabus = addCloudSyllabus,
  client,
  cloudSync,
  manifest,
  onProgress,
  profileId,
  userId,
}) {
  if (cloudSync.hasRemoteData) {
    throw new Error("This account already has synced data, so the device-only profile was not uploaded.");
  }
  const studySources = Array.isArray(manifest.studySources) ? manifest.studySources : [];
  const syllabi = Array.isArray(manifest.syllabi) ? manifest.syllabi : [];
  for (const record of syllabi) {
    if (!(record.blob instanceof Blob)) {
      throw new Error("One local syllabus file is unavailable. Nothing was uploaded or removed.");
    }
  }
  for (const record of studySources) {
    if (!(record.blob instanceof Blob)) {
      throw new Error("One local Study Deck source file is unavailable. Nothing was uploaded or removed.");
    }
  }

  let completedFiles = 0;
  const totalFiles = syllabi.length + studySources.length;
  for (const record of syllabi) {
    onProgress?.({ completedFiles, currentKind: "syllabus", totalFiles });
    await addSyllabus(client, {
      courseName: record.courseName,
      file: new File([record.blob], record.fileName, {
        lastModified: record.lastModified || Date.now(),
        type: record.mimeType || record.blob.type || "",
      }),
    }, userId, { sourceLocalId: `${profileId}:${record.id}` });
    completedFiles += 1;
  }
  for (const record of studySources) {
    onProgress?.({ completedFiles, currentKind: "study-source", totalFiles });
    await addStudySource(client, {
      courseCode: record.courseCode,
      courseSpaceId: record.courseSpaceId,
      file: new File([record.blob], record.fileName, {
        lastModified: record.lastModified || Date.now(),
        type: record.mimeType || record.blob.type || "",
      }),
    }, userId, { sourceLocalId: `${profileId}:${record.id}` });
    completedFiles += 1;
  }
  await cloudSync.importResources(manifest.resources);
  return {
    resourceCount: manifest.resourceCount,
    studySourceCount: studySources.length,
    syllabusCount: syllabi.length,
  };
}
