import { CloudAssistantRequestError } from "./cloudAssistantSecurity.js";

export const MAX_SEMESTER_GENERATION_JSON_BYTES = 96 * 1024;
export const MAX_SEMESTER_GENERATION_SOURCES = 8;
export const MAX_SEMESTER_GENERATION_SOURCE_CHARS = 16_000;
export const MAX_SEMESTER_GENERATION_TOTAL_CHARS = 64_000;

const BLOCKED_IDS = new Set(["__proto__", "constructor", "prototype"]);
const WEEKDAYS = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
const ASSIGNMENT_KINDS = new Set(["assignment", "exam", "lab", "paper", "presentation", "project", "quiz"]);
const isPlainObject = (value) => value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function hasOnlyKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeText(value, limit, { optional = false } = {}) {
  const text = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (!text && optional) return null;
  if (!text || text.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new CloudAssistantRequestError(400, "invalid_semester_generation_text");
  }
  return text;
}

function safeId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(id) || BLOCKED_IDS.has(id)) {
    throw new CloudAssistantRequestError(400, "invalid_semester_generation_id");
  }
  return id;
}

export function validateSemesterGenerationPayload(payload) {
  if (!isPlainObject(payload) || !hasOnlyKeys(payload, ["sources"])) {
    throw new CloudAssistantRequestError(400, "invalid_semester_generation_payload");
  }
  if (!Array.isArray(payload.sources) || !payload.sources.length
    || payload.sources.length > MAX_SEMESTER_GENERATION_SOURCES) {
    throw new CloudAssistantRequestError(400, "invalid_semester_generation_sources");
  }

  let totalChars = 0;
  const seen = new Set();
  const sources = payload.sources.map((source) => {
    if (!isPlainObject(source) || !hasOnlyKeys(source, ["fileName", "id", "text"])) {
      throw new CloudAssistantRequestError(400, "invalid_semester_generation_source");
    }
    const id = safeId(source.id);
    if (seen.has(id)) throw new CloudAssistantRequestError(400, "duplicate_semester_generation_source");
    seen.add(id);
    const text = safeText(source.text, MAX_SEMESTER_GENERATION_SOURCE_CHARS);
    totalChars += text.length;
    if (totalChars > MAX_SEMESTER_GENERATION_TOTAL_CHARS) {
      throw new CloudAssistantRequestError(413, "semester_generation_too_large");
    }
    return {
      fileName: safeText(source.fileName, 160),
      id,
      text,
    };
  });
  return { sources };
}

function outputText(value, fallback, limit) {
  const normalized = String(value || fallback || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
  return normalized || fallback;
}

function outputOptionalText(value, limit) {
  return outputText(value, "", limit) || null;
}

function outputDate(value) {
  const date = outputOptionalText(value, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

function outputSourceRefs(value, allowedSourceIds) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => outputOptionalText(item, 128))
    .filter((item) => item && allowedSourceIds.has(item)))].slice(0, 8);
}

function slug(value, fallback) {
  const normalized = outputText(value, fallback, 100)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72);
  return normalized && !BLOCKED_IDS.has(normalized) ? normalized : fallback;
}

function outputWeekdays(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((day) => String(day || "").toUpperCase())
    .filter((day) => WEEKDAYS.has(day)))];
}

function normalizeOfficeHours(value, sourceRefs, courseIndex) {
  const entries = (Array.isArray(value?.entries) ? value.entries : []).slice(0, 8).map((entry, index) => ({
    id: `office-${courseIndex + 1}-${index + 1}`,
    person: outputText(entry?.person, "Instructor", 100),
    role: outputText(entry?.role, "Instructor", 80),
    weekdays: outputWeekdays(entry?.weekdays),
    time: outputOptionalText(entry?.time, 80),
    location: outputOptionalText(entry?.location, 160),
    byAppointment: entry?.byAppointment === true,
    note: outputOptionalText(entry?.note, 320),
    status: "confirmed",
    sourceRefs: outputSourceRefs(entry?.sourceRefs, new Set(sourceRefs)).length
      ? outputSourceRefs(entry?.sourceRefs, new Set(sourceRefs))
      : sourceRefs,
  }));
  return {
    status: entries.length ? "confirmed" : "not_stated",
    entries,
    note: entries.length ? "Extracted from uploaded course documents; verify before relying on it." : "Not stated in the uploaded documents.",
  };
}

export function normalizeGeneratedSemesterDraft(output, sourceIds) {
  if (!isPlainObject(output) || !isPlainObject(output.term)
    || !Array.isArray(output.courses) || !output.courses.length || output.courses.length > 24
    || !Array.isArray(output.assignments) || output.assignments.length > 800
    || !Array.isArray(output.scheduleEvents) || output.scheduleEvents.length > 400) {
    throw new CloudAssistantRequestError(502, "invalid_generated_semester_draft");
  }
  const allowedSourceIds = new Set(sourceIds);
  const courseIdMap = new Map();
  const courses = output.courses.map((course, courseIndex) => {
    const originalId = outputText(course?.id, `course-${courseIndex + 1}`, 128);
    const sourceRefs = outputSourceRefs(course?.sourceRefs, allowedSourceIds);
    if (!sourceRefs.length) throw new CloudAssistantRequestError(502, "ungrounded_generated_course");
    const code = outputText(course?.code, `Course ${courseIndex + 1}`, 32);
    const id = `course-${courseIndex + 1}-${slug(code, `item-${courseIndex + 1}`)}`;
    courseIdMap.set(originalId, id);
    const meetings = (Array.isArray(course?.meetings) ? course.meetings : []).slice(0, 12).map((meeting, index) => {
      const weekdays = outputWeekdays(meeting?.weekdays);
      const time = outputOptionalText(meeting?.time, 80);
      const meetingRefs = outputSourceRefs(meeting?.sourceRefs, allowedSourceIds);
      return {
        id: `${id}-meeting-${index + 1}`,
        kind: outputText(meeting?.kind, "class", 40).toLocaleLowerCase("en-US"),
        weekdays,
        time,
        timeCertainty: time ? "document" : "not_stated",
        location: outputOptionalText(meeting?.location, 160),
        locationCertainty: meeting?.location ? "document" : "not_stated",
        generation: weekdays.length ? "derived_from_term" : "blocked",
        note: outputOptionalText(meeting?.note, 320),
        sourceRefs: meetingRefs.length ? meetingRefs : sourceRefs,
      };
    });
    return {
      id,
      code,
      shortTitle: outputText(course?.shortTitle, code, 80),
      title: outputText(course?.title, code, 160),
      meetings,
      officeHours: normalizeOfficeHours(course?.officeHours, sourceRefs, courseIndex),
      attendancePolicy: { mode: "not_stated", note: "Review the uploaded documents before recording attendance." },
      excuseRules: { status: "not_stated" },
      notes: outputOptionalText(course?.notes, 500),
      sourceRefs,
    };
  });

  const assignments = output.assignments.map((assignment, index) => {
    const mappedCourseId = courseIdMap.get(outputText(assignment?.courseId, "", 128));
    const sourceRefs = outputSourceRefs(assignment?.sourceRefs, allowedSourceIds);
    if (!mappedCourseId || !sourceRefs.length) {
      throw new CloudAssistantRequestError(502, "ungrounded_generated_assignment");
    }
    const title = outputText(assignment?.title, `Assignment ${index + 1}`, 240);
    const date = outputDate(assignment?.date);
    const time = outputOptionalText(assignment?.time, 80);
    const rawKind = outputText(assignment?.kind, "assignment", 40).toLocaleLowerCase("en-US");
    return {
      id: `assignment-${index + 1}-${slug(title, `item-${index + 1}`)}`,
      courseId: mappedCourseId,
      title,
      date,
      time,
      kind: ASSIGNMENT_KINDS.has(rawKind) ? rawKind : "assignment",
      certainty: date ? "document" : "not_stated",
      dateCertainty: date ? "document" : "not_stated",
      timeCertainty: time ? "document" : "not_stated",
      note: outputOptionalText(assignment?.note, 600),
      sourceStatus: "uploaded_document",
      sourceRefs,
    };
  });

  const scheduleEvents = output.scheduleEvents.flatMap((event, index) => {
    const mappedCourseId = courseIdMap.get(outputText(event?.courseId, "", 128));
    const sourceRefs = outputSourceRefs(event?.sourceRefs, allowedSourceIds);
    if (!mappedCourseId || !sourceRefs.length) return [];
    const title = outputText(event?.title, `Course event ${index + 1}`, 240);
    const date = outputDate(event?.date);
    const time = outputOptionalText(event?.time, 80);
    return [{
      id: `schedule-${index + 1}-${slug(title, `item-${index + 1}`)}`,
      courseId: mappedCourseId,
      title,
      date,
      time,
      kind: outputText(event?.kind, "class", 40).toLocaleLowerCase("en-US"),
      dateCertainty: date ? "document" : "not_stated",
      timeCertainty: time ? "document" : "not_stated",
      certainty: date ? "document" : "not_stated",
      note: outputOptionalText(event?.note, 600),
      sourceStatus: "uploaded_document",
      sourceRefs,
    }];
  });

  const classesBegin = outputDate(output.term.classesBegin);
  const classesEnd = outputDate(output.term.classesEnd);
  const finalExamStart = outputDate(output.term.finalExamStart);
  const finalExamEnd = outputDate(output.term.finalExamEnd);
  const noClassDates = [...new Set((Array.isArray(output.term.noClassDates) ? output.term.noClassDates : [])
    .map(outputDate).filter(Boolean))].sort();
  return {
    term: {
      label: outputText(output.term.label, "My semester", 80),
      institution: outputOptionalText(output.term.institution, 120),
      classesBegin,
      classesEnd,
      finalExamStart,
      finalExamEnd,
      noClassDates,
    },
    courses,
    assignments,
    scheduleEvents,
  };
}

