import {
  addCloudStudySource,
  deleteCloudStudySource,
  downloadCloudStudySource,
  listCloudStudySources,
} from "./cloudStudySourceStorage.js";
import {
  addLocalStudySource,
  deleteLocalStudySource,
  listLocalStudySources,
  readLocalStudySourceBlob,
} from "./localStudySourceStorage.js";
import {
  STUDY_SOURCE_RECORD_KIND,
  formatStudySourceRecord,
  isStudySourceRecord,
  normalizeCourseSpaceId,
  normalizeStudySourceCourseCode,
} from "./studySourceModel.js";

export {
  ACCEPTED_STUDY_SOURCE_EXTENSIONS,
  MAX_STUDY_SOURCE_FILE_BYTES,
  MAX_STUDY_SOURCE_FILE_NAME_LENGTH,
  MAX_STUDY_SOURCE_UPLOAD_BATCH,
  STUDY_SOURCE_RECORD_KIND,
  STUDY_SOURCE_UPLOAD_CONCURRENCY,
  StudySourceStorageError,
  StudySourceValidationError,
  filterStudySourceRecordsForIdentity,
  formatStudySourceFileSize,
  formatStudySourceRecord,
  getStudySourceFileExtension,
  isStudySourceRecord,
  normalizeCourseSpaceId,
  normalizeStudySourceCourseCode,
  recordBelongsToStudySourceIdentity,
  validateStudySourceInput,
} from "./studySourceModel.js";

export async function listStudySources({ client = null, courseSpaceId, profileId }) {
  const space = normalizeCourseSpaceId(courseSpaceId);
  return client
    ? listCloudStudySources(client, profileId, space)
    : listLocalStudySources(profileId, space);
}

export async function addStudySource({
  client = null,
  courseCode,
  courseSpaceId,
  file,
  profileId,
}) {
  const input = {
    courseCode: normalizeStudySourceCourseCode(courseCode),
    courseSpaceId: normalizeCourseSpaceId(courseSpaceId),
    file,
  };
  const record = client
    ? await addCloudStudySource(client, input, profileId)
    : await addLocalStudySource(input, profileId);
  const formatted = formatStudySourceRecord(record);
  if (!formatted) throw new Error("The saved file was not a valid Study Deck source.");
  return formatted;
}

export async function deleteStudySource({
  client = null,
  courseSpaceId,
  profileId,
  record,
}) {
  const space = normalizeCourseSpaceId(courseSpaceId);
  if (
    !isStudySourceRecord(record)
    || record.recordKind !== STUDY_SOURCE_RECORD_KIND
    || !record.id
    || !record.fileName
  ) {
    throw new Error("That file is not a valid Study Deck source.");
  }
  if (record.courseSpaceId !== space) {
    throw new Error("That source belongs to a different course space.");
  }
  return client
    ? deleteCloudStudySource(client, record, profileId, space)
    : deleteLocalStudySource(record, profileId, space);
}

export async function readStudySource({
  client = null,
  courseSpaceId,
  profileId,
  record,
}) {
  const space = normalizeCourseSpaceId(courseSpaceId);
  if (!isStudySourceRecord(record) || record.courseSpaceId !== space) {
    throw new Error("That source belongs to a different Study Deck course space.");
  }
  return client
    ? downloadCloudStudySource(client, record, profileId, space)
    : readLocalStudySourceBlob(record, profileId, space);
}
