import {
  CANVAS_ASSIGNMENT_AUDIT,
  CANVAS_AUDIT,
  CANVAS_FILE_AUDIT,
  canvasAuditCoverage,
} from "./canvasAudit.js";

// Public builds contain structure only. Personal courses, schedules, source
// references, and Canvas evidence are loaded from the signed-in user's private
// account_state row (or a device-only profile) at runtime.
export const TERM = Object.freeze({
  id: "semester-template",
  label: "My semester",
  institution: null,
  timeZone: null,
  timeZoneNote: "Times are displayed exactly as entered by the account owner.",
  classesBegin: Object.freeze({ date: "2026-08-17", certainty: "template" }),
  classesEnd: Object.freeze({ date: "2026-12-04", certainty: "template" }),
  readingDays: Object.freeze([]),
  finalExamWindow: Object.freeze({ startDate: "2026-12-05", endDate: "2026-12-11", certainty: "template" }),
  noClassDates: Object.freeze([]),
  subjectToChange: true,
  sourceRefs: Object.freeze([]),
});

export const COURSES = Object.freeze([]);
export const ASSIGNMENTS = Object.freeze([]);
export const SCHEDULE_EVENTS = Object.freeze([]);
export const SOURCE_REFS = Object.freeze({});
export const SOURCE_NOTES = Object.freeze([]);
export const CANVAS_SOURCES = Object.freeze({});

export {
  CANVAS_ASSIGNMENT_AUDIT,
  CANVAS_AUDIT,
  CANVAS_FILE_AUDIT,
  canvasAuditCoverage,
};
