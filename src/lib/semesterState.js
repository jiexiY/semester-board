export const SEMESTER_SCHEMA_VERSION = 1;

export const DEFAULT_SEMESTER_STATE = Object.freeze({
  schemaVersion: SEMESTER_SCHEMA_VERSION,
  term: null,
  courses: Object.freeze([]),
  assignments: Object.freeze([]),
  scheduleEvents: Object.freeze([]),
  sourceRefs: Object.freeze({}),
  sourceNotes: Object.freeze([]),
  canvasSources: Object.freeze({}),
  canvasAudit: null,
});

const MAX_SEMESTER_BYTES = 900 * 1024;
const MAX_COURSES = 24;
const MAX_ASSIGNMENTS = 800;
const MAX_SCHEDULE_EVENTS = 400;
const MAX_SOURCE_NOTES = 400;
const MAX_SOURCE_REFS = 1_200;
const MAX_DEPTH = 12;
const MAX_STRING_LENGTH = 12_000;
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanIdentifier(value) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean || clean.length > 160 || /[\u0000-\u001f\u007f]/u.test(clean) || BLOCKED_KEYS.has(clean)) return null;
  return clean;
}

function sanitizeJson(value, depth = 0) {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
  if (Array.isArray(value)) {
    return value.slice(0, 2_000)
      .map((entry) => sanitizeJson(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (!isRecord(value)) return undefined;
  const result = {};
  for (const [rawKey, entry] of Object.entries(value).slice(0, 2_000)) {
    const key = cleanIdentifier(rawKey);
    if (!key) continue;
    const safe = sanitizeJson(entry, depth + 1);
    if (safe !== undefined) result[key] = safe;
  }
  return result;
}

function normalizeEntityList(value, limit, validCourseIds = null) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of value.slice(0, limit * 3)) {
    if (!isRecord(entry)) continue;
    const id = cleanIdentifier(entry.id);
    if (!id || seen.has(id)) continue;
    const courseId = entry.courseId == null ? null : cleanIdentifier(entry.courseId);
    if (validCourseIds && (!courseId || !validCourseIds.has(courseId))) continue;
    const safe = sanitizeJson(entry);
    if (!safe) continue;
    safe.id = id;
    if (courseId) safe.courseId = courseId;
    seen.add(id);
    result.push(safe);
    if (result.length >= limit) break;
  }
  return result;
}

function serializedBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isIsoDate(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function normalizeTerm(value, hasCourses) {
  if (!isRecord(value)) {
    if (hasCourses) throw new Error("This private semester dataset is missing a valid term date range.");
    return null;
  }
  const term = sanitizeJson(value);
  const startDate = term?.classesBegin?.date;
  const endDate = term?.classesEnd?.date;
  if (!isIsoDate(startDate) || !isIsoDate(endDate) || startDate > endDate) {
    throw new Error("This private semester dataset has an invalid term date range.");
  }
  return term;
}

export function normalizeSemesterState(value) {
  if (!isRecord(value) || value.schemaVersion !== SEMESTER_SCHEMA_VERSION) {
    throw new Error("This semester file is not a supported Semester Board private-data export.");
  }

  const courses = normalizeEntityList(value.courses, MAX_COURSES).map((course) => ({
    ...course,
    meetings: Array.isArray(course.meetings) ? course.meetings : [],
  }));
  const courseIds = new Set(courses.map((course) => course.id));
  const normalized = {
    schemaVersion: SEMESTER_SCHEMA_VERSION,
    term: normalizeTerm(value.term, courses.length > 0),
    courses,
    assignments: normalizeEntityList(value.assignments, MAX_ASSIGNMENTS, courseIds),
    scheduleEvents: normalizeEntityList(value.scheduleEvents, MAX_SCHEDULE_EVENTS, courseIds),
    sourceRefs: Object.fromEntries(Object.entries(isRecord(value.sourceRefs) ? value.sourceRefs : {})
      .slice(0, MAX_SOURCE_REFS)
      .map(([key, entry]) => [cleanIdentifier(key), sanitizeJson(entry)])
      .filter(([key, entry]) => key && entry !== undefined)),
    sourceNotes: Array.isArray(value.sourceNotes)
      ? sanitizeJson(value.sourceNotes.slice(0, MAX_SOURCE_NOTES))
      : [],
    canvasSources: isRecord(value.canvasSources) ? sanitizeJson(value.canvasSources) : {},
    canvasAudit: isRecord(value.canvasAudit) ? sanitizeJson(value.canvasAudit) : null,
  };

  if (serializedBytes(normalized) > MAX_SEMESTER_BYTES) {
    throw new Error("This private semester dataset is too large to sync safely. Split it before importing.");
  }
  return normalized;
}

export function privateSemesterFromImport(value) {
  if (!isRecord(value) || value.kind !== "semester-board-private-semester") return null;
  if (value.schemaVersion !== SEMESTER_SCHEMA_VERSION) {
    throw new Error("This private semester export uses an unsupported schema version.");
  }
  return normalizeSemesterState(value.semester);
}

export function semesterHasBoardData(value) {
  return Boolean(value?.term && Array.isArray(value?.courses) && value.courses.length);
}
