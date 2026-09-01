import { normalizeProfileId } from "./profileStorage.js";
import {
  SyllabusValidationError,
  formatSyllabusRecord,
  validateSyllabusInput,
} from "./syllabusStorage.js";

export const SYLLABUS_BUCKET = "syllabi";
const SIGNED_URL_SECONDS = 60;
const SYLLABUS_COLUMNS = "id, user_id, course_name, file_name, storage_path, mime_type, size_bytes, source_local_id, created_at";

function rowToRecord(row) {
  if (!row) return null;
  return formatSyllabusRecord({
    addedAt: row.created_at,
    cloud: true,
    courseName: row.course_name,
    fileName: row.file_name,
    id: row.id,
    mimeType: row.mime_type || "",
    size: Number(row.size_bytes),
    sourceLocalId: row.source_local_id || null,
    storagePath: row.storage_path,
  });
}

function requireClient(client) {
  if (!client?.from || !client?.storage) throw new TypeError("A signed-in account client is required.");
  return client;
}

async function queryOwnedMetadata(client, owner, field, value) {
  try {
    const result = await client
      .from("syllabus_files")
      .select(SYLLABUS_COLUMNS)
      .eq("user_id", owner)
      .eq(field, value)
      .maybeSingle();
    if (result.error) return { data: null, confirmed: false };
    return { data: result.data || null, confirmed: true };
  } catch {
    return { data: null, confirmed: false };
  }
}

async function recoverOwnedMetadata(client, owner, storagePath, sourceId = null) {
  const lookups = [["storage_path", storagePath]];
  if (sourceId) lookups.push(["source_local_id", sourceId]);
  let confirmedAbsent = true;

  for (const [field, value] of lookups) {
    const result = await queryOwnedMetadata(client, owner, field, value);
    if (result.data) return { data: result.data, confirmedAbsent: false };
    if (!result.confirmed) confirmedAbsent = false;
  }

  return { data: null, confirmedAbsent };
}

async function removeStorageObject(client, storagePath) {
  try {
    const result = await client.storage.from(SYLLABUS_BUCKET).remove([storagePath]);
    return Boolean(result) && !result.error;
  } catch {
    return false;
  }
}

function metadataFromRecord(record, owner) {
  if (!record?.id || !record?.storagePath || !record?.courseName || !record?.fileName) return null;
  const size = Number(record.size);
  if (!Number.isFinite(size) || size < 0) return null;
  const metadata = {
    course_name: record.courseName,
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
    const restored = await client
      .from("syllabus_files")
      .upsert({ ...metadata }, { onConflict: "id" });
    if (restored && !restored.error) return true;
  } catch {
    // An interrupted response can still mean the row committed. Verify below.
  }

  const recovery = await recoverOwnedMetadata(
    client,
    metadata.user_id,
    metadata.storage_path,
    metadata.source_local_id || null,
  );
  return Boolean(recovery.data);
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function cloudSyllabusPath(userId, recordId, extension) {
  const owner = normalizeProfileId(userId);
  const id = String(recordId || "").trim();
  const suffix = String(extension || "").toLocaleLowerCase("en-US");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(id)) throw new TypeError("A valid syllabus id is required.");
  if (!/^(?:pdf|doc|docx|txt)$/u.test(suffix)) throw new TypeError("A supported syllabus extension is required.");
  return `${owner}/${id}/syllabus.${suffix}`;
}

export async function listCloudSyllabi(client, userId) {
  requireClient(client);
  const owner = normalizeProfileId(userId);
  const result = await client
    .from("syllabus_files")
    .select(SYLLABUS_COLUMNS)
    .eq("user_id", owner)
    .order("created_at", { ascending: false });
  if (result.error) throw new Error("Your private syllabus library could not be loaded.");
  return (result.data || []).filter((row) => row.user_id === owner).map(rowToRecord).filter(Boolean);
}

export async function addCloudSyllabus(client, input, userId, { sourceLocalId = null } = {}) {
  requireClient(client);
  const owner = normalizeProfileId(userId);
  const validation = validateSyllabusInput(input);
  if (!validation.valid) throw new SyllabusValidationError(validation.errors);
  const sourceId = typeof sourceLocalId === "string" && sourceLocalId.trim()
    ? sourceLocalId.trim().slice(0, 180)
    : null;

  if (sourceId) {
    const existing = await client
      .from("syllabus_files")
      .select(SYLLABUS_COLUMNS)
      .eq("user_id", owner)
      .eq("source_local_id", sourceId)
      .maybeSingle();
    if (existing.error) throw new Error("The syllabus migration could not be checked safely.");
    if (existing.data) return rowToRecord(existing.data);
  }

  const recordId = sourceId
    ? `migrated_${(await sha256Hex(sourceId)).slice(0, 32)}`
    : (globalThis.crypto?.randomUUID?.() || `syllabus_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
  const storagePath = cloudSyllabusPath(owner, recordId, validation.value.extension);
  const upload = await client.storage.from(SYLLABUS_BUCKET).upload(storagePath, validation.value.file, {
    cacheControl: "3600",
    contentType: validation.value.mimeType || undefined,
    upsert: Boolean(sourceId),
  });
  if (upload.error) throw new Error("The syllabus file could not be uploaded to your private account storage.");

  const metadata = {
    course_name: validation.value.courseName,
    file_name: validation.value.fileName,
    id: globalThis.crypto?.randomUUID?.() || undefined,
    mime_type: validation.value.mimeType || null,
    size_bytes: validation.value.size,
    source_local_id: sourceId,
    storage_path: storagePath,
    user_id: owner,
  };
  if (!metadata.id) delete metadata.id;
  const query = sourceId
    ? client.from("syllabus_files").upsert(metadata, { onConflict: "user_id,source_local_id" })
    : client.from("syllabus_files").insert(metadata);
  const saved = await query
    .select(SYLLABUS_COLUMNS)
    .single();
  if (saved.error) {
    const recovery = await recoverOwnedMetadata(client, owner, storagePath, sourceId);
    if (recovery.data) return rowToRecord(recovery.data);
    if (!recovery.confirmedAbsent) {
      throw new Error("The syllabus upload status could not be confirmed. Reload your library before trying again.");
    }
    await removeStorageObject(client, storagePath);
    throw new Error("The syllabus upload did not finish. No library entry was created.");
  }
  return rowToRecord(saved.data);
}

export async function createCloudSyllabusUrl(client, record, userId) {
  requireClient(client);
  const owner = normalizeProfileId(userId);
  if (!record?.storagePath?.startsWith(`${owner}/`)) throw new Error("That syllabus does not belong to this account.");
  const result = await client.storage.from(SYLLABUS_BUCKET).createSignedUrl(record.storagePath, SIGNED_URL_SECONDS, {
    download: false,
  });
  if (result.error || !result.data?.signedUrl) throw new Error("A private link for this syllabus could not be created.");
  return result.data.signedUrl;
}

export async function downloadCloudSyllabus(client, record, userId) {
  requireClient(client);
  const owner = normalizeProfileId(userId);
  if (!record?.storagePath?.startsWith(`${owner}/`)) throw new Error("That syllabus does not belong to this account.");
  const result = await client.storage.from(SYLLABUS_BUCKET).download(record.storagePath);
  if (result.error || !(result.data instanceof Blob)) throw new Error("The syllabus could not be downloaded from your account.");
  return result.data;
}

export async function deleteCloudSyllabus(client, record, userId) {
  requireClient(client);
  const owner = normalizeProfileId(userId);
  if (!record?.id || !record?.storagePath?.startsWith(`${owner}/`)) {
    throw new Error("That syllabus does not belong to this account.");
  }
  const removedRow = await client
    .from("syllabus_files")
    .delete()
    .eq("user_id", owner)
    .eq("id", record.id)
    .select(SYLLABUS_COLUMNS)
    .maybeSingle();
  if (removedRow.error) {
    throw new Error("The syllabus metadata could not be removed. The stored file was not changed.");
  }

  const objectRemoved = await removeStorageObject(client, record.storagePath);
  if (!objectRemoved) {
    const metadata = removedRow.data || metadataFromRecord(record, owner);
    const restored = metadata ? await restoreMetadata(client, metadata) : false;
    if (restored) {
      throw new Error("The syllabus file could not be removed. Its library entry was restored; reload and try again.");
    }
    throw new Error("The syllabus file could not be removed. Reload your syllabus library before trying again.");
  }
  return Boolean(removedRow.data);
}
