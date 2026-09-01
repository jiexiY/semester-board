import {
  STUDY_SOURCE_RECORD_KIND,
  StudySourceValidationError,
  formatStudySourceRecord,
  normalizeCourseSpaceId,
  normalizeStudySourceProfileId,
  validateStudySourceInput,
} from "./studySourceModel.js";

export const STUDY_SOURCE_BUCKET = "study-sources";
const SIGNED_URL_SECONDS = 60;
const STUDY_SOURCE_COLUMNS = "id, user_id, course_space_id, course_code, file_name, storage_path, mime_type, size_bytes, source_local_id, created_at";

function requireClient(client) {
  if (!client?.from || !client?.storage) throw new TypeError("A signed-in account client is required.");
  return client;
}

function rowToRecord(row) {
  if (!row) return null;
  return formatStudySourceRecord({
    addedAt: row.created_at,
    cloud: true,
    courseCode: row.course_code,
    courseSpaceId: row.course_space_id,
    fileName: row.file_name,
    id: row.id,
    mimeType: row.mime_type || "",
    profileId: row.user_id,
    recordKind: STUDY_SOURCE_RECORD_KIND,
    size: Number(row.size_bytes),
    sourceLocalId: row.source_local_id || null,
    storagePath: row.storage_path,
  });
}

export function cloudStudySourcePath(userId, courseSpaceId, recordId, extension) {
  const owner = normalizeStudySourceProfileId(userId);
  const space = normalizeCourseSpaceId(courseSpaceId);
  const id = String(recordId || "").trim();
  const suffix = String(extension || "").toLocaleLowerCase("en-US");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(id)) {
    throw new TypeError("A valid Study Deck source id is required.");
  }
  if (!/^(?:pdf|doc|docx|txt)$/u.test(suffix)) {
    throw new TypeError("A supported Study Deck source extension is required.");
  }
  return `${owner}/${space}/${id}/source.${suffix}`;
}

export function isOwnedStudySourcePath(storagePath, userId, courseSpaceId) {
  let owner;
  let space;
  try {
    owner = normalizeStudySourceProfileId(userId);
    space = normalizeCourseSpaceId(courseSpaceId);
  } catch {
    return false;
  }
  return typeof storagePath === "string"
    && storagePath.startsWith(`${owner}/${space}/`)
    && !storagePath.slice(`${owner}/${space}/`.length).includes("../");
}

export function assertOwnedStudySourceRecord(record, userId, courseSpaceId) {
  const owner = normalizeStudySourceProfileId(userId);
  const space = normalizeCourseSpaceId(courseSpaceId);
  if (
    !record?.id
    || record.recordKind !== STUDY_SOURCE_RECORD_KIND
    || record.courseSpaceId !== space
    || (record.profileId && record.profileId !== owner)
    || !isOwnedStudySourcePath(record.storagePath, owner, space)
  ) {
    throw new Error("That Study Deck source does not belong to this account and course space.");
  }
  return { owner, space };
}

async function queryOwnedMetadata(client, owner, space, field, value) {
  try {
    const result = await client
      .from("study_source_files")
      .select(STUDY_SOURCE_COLUMNS)
      .eq("user_id", owner)
      .eq("course_space_id", space)
      .eq(field, value)
      .maybeSingle();
    if (result.error) return { confirmed: false, data: null };
    return { confirmed: true, data: result.data || null };
  } catch {
    return { confirmed: false, data: null };
  }
}

async function recoverOwnedMetadata(client, owner, space, storagePath, sourceLocalId = null) {
  const lookups = [["storage_path", storagePath]];
  if (sourceLocalId) lookups.push(["source_local_id", sourceLocalId]);
  let confirmedAbsent = true;

  for (const [field, value] of lookups) {
    const result = await queryOwnedMetadata(client, owner, space, field, value);
    if (result.data) return { data: result.data, confirmedAbsent: false };
    if (!result.confirmed) confirmedAbsent = false;
  }

  return { data: null, confirmedAbsent };
}

async function removeStorageObject(client, storagePath) {
  try {
    const result = await client.storage.from(STUDY_SOURCE_BUCKET).remove([storagePath]);
    return Boolean(result) && !result.error;
  } catch {
    return false;
  }
}

function metadataFromRecord(record, owner, space) {
  if (
    !record?.id
    || !record?.courseCode
    || !record?.fileName
    || !isOwnedStudySourcePath(record.storagePath, owner, space)
  ) return null;
  const size = Number(record.size);
  if (!Number.isFinite(size) || size < 0) return null;
  const metadata = {
    course_code: record.courseCode,
    course_space_id: space,
    file_name: record.fileName,
    id: record.id,
    mime_type: record.mimeType || null,
    size_bytes: size,
    source_local_id: record.sourceLocalId || null,
    storage_path: record.storagePath,
    user_id: owner,
  };
  if (record.addedAt) metadata.created_at = record.addedAt;
  return metadata;
}

async function restoreMetadata(client, metadata) {
  try {
    const result = await client
      .from("study_source_files")
      .upsert({ ...metadata }, { onConflict: "id" });
    if (result && !result.error) return true;
  } catch {
    // An interrupted response may still have committed; verify ownership below.
  }
  const recovered = await recoverOwnedMetadata(
    client,
    metadata.user_id,
    metadata.course_space_id,
    metadata.storage_path,
    metadata.source_local_id || null,
  );
  return Boolean(recovered.data);
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function listCloudStudySources(client, userId, courseSpaceId) {
  requireClient(client);
  const owner = normalizeStudySourceProfileId(userId);
  const space = normalizeCourseSpaceId(courseSpaceId);
  const result = await client
    .from("study_source_files")
    .select(STUDY_SOURCE_COLUMNS)
    .eq("user_id", owner)
    .eq("course_space_id", space)
    .order("created_at", { ascending: false });
  if (result.error) throw new Error("Your private Study Deck source library could not be loaded.");
  return (result.data || [])
    .filter((row) => row.user_id === owner && row.course_space_id === space)
    .map(rowToRecord)
    .filter(Boolean);
}

export async function addCloudStudySource(client, input, userId, { sourceLocalId = null } = {}) {
  requireClient(client);
  const owner = normalizeStudySourceProfileId(userId);
  const validation = validateStudySourceInput(input);
  if (!validation.valid) throw new StudySourceValidationError(validation.errors);
  const value = validation.value;
  const sourceId = typeof sourceLocalId === "string" && sourceLocalId.trim()
    ? sourceLocalId.trim()
    : null;
  if (sourceId && sourceId.length > 300) {
    throw new TypeError("A Study Deck source migration id must be 300 characters or fewer.");
  }

  if (sourceId) {
    const existing = await client
      .from("study_source_files")
      .select(STUDY_SOURCE_COLUMNS)
      .eq("user_id", owner)
      .eq("course_space_id", value.courseSpaceId)
      .eq("source_local_id", sourceId)
      .maybeSingle();
    if (existing.error) throw new Error("The Study Deck source migration could not be checked safely.");
    if (existing.data) return rowToRecord(existing.data);
  }

  const recordId = sourceId
    ? `migrated_${(await sha256Hex(sourceId)).slice(0, 32)}`
    : (globalThis.crypto?.randomUUID?.()
      || `source_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`);
  const storagePath = cloudStudySourcePath(owner, value.courseSpaceId, recordId, value.extension);
  const upload = await client.storage.from(STUDY_SOURCE_BUCKET).upload(storagePath, value.file, {
    cacheControl: "3600",
    contentType: value.mimeType || undefined,
    upsert: Boolean(sourceId),
  });
  if (upload.error) {
    throw new Error("The source file could not be uploaded to your private account storage.");
  }

  const metadata = {
    course_code: value.courseCode,
    course_space_id: value.courseSpaceId,
    file_name: value.fileName,
    id: globalThis.crypto?.randomUUID?.() || undefined,
    mime_type: value.mimeType || null,
    size_bytes: value.size,
    source_local_id: sourceId,
    storage_path: storagePath,
    user_id: owner,
  };
  if (!metadata.id) delete metadata.id;
  const query = sourceId
    ? client.from("study_source_files").upsert(metadata, { onConflict: "user_id,source_local_id" })
    : client.from("study_source_files").insert(metadata);
  const saved = await query
    .select(STUDY_SOURCE_COLUMNS)
    .single();
  if (saved.error) {
    const recovered = await recoverOwnedMetadata(
      client,
      owner,
      value.courseSpaceId,
      storagePath,
      sourceId,
    );
    if (recovered.data) return rowToRecord(recovered.data);
    if (!recovered.confirmedAbsent) {
      throw new Error("The source upload status could not be confirmed. Reload this course library before trying again.");
    }
    await removeStorageObject(client, storagePath);
    throw new Error("The source upload did not finish. No library entry was created.");
  }

  const record = rowToRecord(saved.data);
  if (!record || record.profileId !== owner || record.courseSpaceId !== value.courseSpaceId) {
    throw new Error("The saved source could not be confirmed for this account and course space.");
  }
  return record;
}

export async function createCloudStudySourceUrl(client, record, userId, courseSpaceId) {
  requireClient(client);
  assertOwnedStudySourceRecord(record, userId, courseSpaceId);
  const result = await client.storage.from(STUDY_SOURCE_BUCKET).createSignedUrl(
    record.storagePath,
    SIGNED_URL_SECONDS,
    { download: false },
  );
  if (result.error || !result.data?.signedUrl) {
    throw new Error("A private link for this Study Deck source could not be created.");
  }
  return result.data.signedUrl;
}

export async function downloadCloudStudySource(client, record, userId, courseSpaceId) {
  requireClient(client);
  assertOwnedStudySourceRecord(record, userId, courseSpaceId);
  const result = await client.storage.from(STUDY_SOURCE_BUCKET).download(record.storagePath);
  if (result.error || !(result.data instanceof Blob)) {
    throw new Error("The Study Deck source could not be downloaded from your account.");
  }
  return result.data;
}

export async function deleteCloudStudySource(client, record, userId, courseSpaceId) {
  requireClient(client);
  const { owner, space } = assertOwnedStudySourceRecord(record, userId, courseSpaceId);
  const removedRow = await client
    .from("study_source_files")
    .delete()
    .eq("user_id", owner)
    .eq("course_space_id", space)
    .eq("id", record.id)
    .select(STUDY_SOURCE_COLUMNS)
    .maybeSingle();
  if (removedRow.error) {
    throw new Error("The source metadata could not be removed. The stored file was not changed.");
  }

  if (!removedRow.data) return false;
  const objectRemoved = await removeStorageObject(client, record.storagePath);
  if (!objectRemoved) {
    const metadata = removedRow.data || metadataFromRecord(record, owner, space);
    const restored = metadata ? await restoreMetadata(client, metadata) : false;
    if (restored) {
      throw new Error("The source file could not be removed. Its library entry was restored; reload and try again.");
    }
    throw new Error("The source file could not be removed. Reload this course library before trying again.");
  }
  return true;
}
