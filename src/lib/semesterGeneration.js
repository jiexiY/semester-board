import { SEMESTER_SCHEMA_VERSION, normalizeSemesterState } from "./semesterState.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function validSemesterDate(value) {
  const date = String(value || "").trim();
  if (!DATE_PATTERN.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function courseNameForGeneratedSource(draft, sourceId) {
  const match = (Array.isArray(draft?.courses) ? draft.courses : [])
    .find((course) => Array.isArray(course?.sourceRefs) && course.sourceRefs.includes(sourceId));
  if (!match) return "Semester documents";
  return [match.code, match.title].filter(Boolean).join(" — ").slice(0, 120);
}

export function semesterFromGeneratedDraft({
  draft,
  endDate,
  label,
  sourceRecords,
  startDate,
  timeZone = null,
}) {
  if (!validSemesterDate(startDate) || !validSemesterDate(endDate)) {
    throw new Error("Enter the semester start and end dates before saving this draft.");
  }
  if (startDate > endDate) throw new Error("The semester end date must be after its start date.");
  if (!Array.isArray(draft?.courses) || !draft.courses.length) {
    throw new Error("This draft does not contain a course.");
  }

  let finalStart = validSemesterDate(draft?.term?.finalExamStart)
    ? draft.term.finalExamStart
    : null;
  let finalEnd = validSemesterDate(draft?.term?.finalExamEnd)
    ? draft.term.finalExamEnd
    : null;
  if (finalStart && finalEnd && finalStart > finalEnd) {
    finalStart = null;
    finalEnd = null;
  }
  const sourceRefs = Object.fromEntries((Array.isArray(sourceRecords) ? sourceRecords : []).map((source) => [
    source.id,
    {
      fileName: source.fileName,
      kind: "uploaded_document",
      label: source.fileName,
      usedInGeneration: source.usedInGeneration === true,
      ...(source.skipReason ? { note: String(source.skipReason).slice(0, 320) } : {}),
    },
  ]));
  const allSourceIds = Object.keys(sourceRefs);
  return normalizeSemesterState({
    schemaVersion: SEMESTER_SCHEMA_VERSION,
    term: {
      id: `semester-${startDate}`,
      label: String(label || draft.term?.label || "My semester").trim().slice(0, 80) || "My semester",
      institution: draft.term?.institution || null,
      timeZone,
      timeZoneNote: timeZone ? "Uses Semester Board's configured campus time zone." : "Time zone not stated.",
      classesBegin: { date: startDate, certainty: draft.term?.classesBegin === startDate ? "document" : "user" },
      classesEnd: { date: endDate, certainty: draft.term?.classesEnd === endDate ? "document" : "user" },
      readingDays: [],
      finalExamWindow: finalStart && finalEnd ? {
        startDate: finalStart,
        endDate: finalEnd,
        certainty: "document",
      } : null,
      noClassDates: (Array.isArray(draft.term?.noClassDates) ? draft.term.noClassDates : [])
        .filter((date) => validSemesterDate(date) && date >= startDate && date <= endDate),
      subjectToChange: true,
      sourceRefs: allSourceIds,
    },
    courses: draft.courses,
    assignments: Array.isArray(draft.assignments) ? draft.assignments : [],
    scheduleEvents: Array.isArray(draft.scheduleEvents) ? draft.scheduleEvents : [],
    sourceRefs,
    sourceNotes: [{
      note: "Generated from readable excerpts in uploaded course documents. Dates, times, policies, skipped files, and source coverage require user review.",
      sourceRefs: allSourceIds,
      status: "review_required",
    }],
    canvasSources: {},
    canvasAudit: null,
  });
}

