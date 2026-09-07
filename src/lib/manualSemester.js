import { CAMPUS_TIME_ZONE } from "./format.js";
import { normalizeSemesterState, SEMESTER_SCHEMA_VERSION } from "./semesterState.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function cleanText(value, maxLength = 180) {
  return String(value || "").trim().slice(0, maxLength);
}

function slug(value, fallback) {
  return cleanText(value, 120)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || fallback;
}

function uniqueId(base, used) {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

export function formatManualClock(value) {
  const match = cleanText(value, 5).match(/^(\d{2}):(\d{2})$/u);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

function manualMeeting(courseId, course, term) {
  const weekdays = Array.isArray(course.weekdays)
    ? course.weekdays.filter((day) => ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].includes(day))
    : [];
  const startTime = formatManualClock(course.startTime);
  const endTime = formatManualClock(course.endTime);
  if (!weekdays.length || !startTime) {
    return {
      id: `${courseId}-schedule-needed`,
      kind: "class",
      weekdays: [],
      time: null,
      location: null,
      generation: "blocked",
      eventGeneration: "blocked",
      note: "Class schedule has not been entered yet.",
      sourceRefs: [],
    };
  }
  return {
    id: `${courseId}-class-1`,
    kind: "class",
    weekdays,
    time: [startTime, endTime].filter(Boolean).join("–"),
    startTime,
    endTime,
    timeCertainty: "user",
    location: cleanText(course.location, 180) || null,
    locationCertainty: course.location ? "user" : "tbd",
    generation: "derived_from_term",
    eventGeneration: "derived_from_term",
    range: { startDate: term.classesBegin.date, endDate: term.classesEnd.date },
    exceptions: [],
    certainty: "user",
    note: "Entered by the user during semester setup.",
    sourceRefs: [],
  };
}

function manualOfficeHours(courseId, course) {
  const time = cleanText(course.officeHours, 240);
  if (!time) {
    return {
      status: "not_stated",
      entries: [],
      note: "Office hours have not been entered yet.",
    };
  }
  return {
    status: "user",
    entries: [{
      id: `${courseId}-office-1`,
      person: cleanText(course.instructor, 120) || "Instructor",
      role: "Instructor",
      weekdays: [],
      time,
      location: cleanText(course.officeLocation, 180) || null,
      byAppointment: false,
      status: "user",
      note: "Entered by the user during semester setup.",
      sourceRefs: [],
    }],
    note: "Entered by the user during semester setup.",
  };
}

export function buildManualSemester(input = {}) {
  const label = cleanText(input.label, 80);
  const startDate = cleanText(input.startDate, 10);
  const endDate = cleanText(input.endDate, 10);
  if (!label) throw new Error("Enter a semester name.");
  if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate) || startDate > endDate) {
    throw new Error("Choose a valid first and last class date.");
  }
  const sourceCourses = Array.isArray(input.courses) ? input.courses : [];
  if (!sourceCourses.length) throw new Error("Add at least one course.");
  const term = {
    id: `term-${startDate}`,
    label,
    institution: null,
    timeZone: CAMPUS_TIME_ZONE,
    timeZoneNote: "Uses Semester Board's configured campus time zone.",
    classesBegin: { date: startDate, certainty: "user" },
    classesEnd: { date: endDate, certainty: "user" },
    readingDays: [],
    finalExamWindow: null,
    holidays: [],
    noClassDates: [],
  };
  const usedCourseIds = new Set();
  const courseKeyToId = new Map();
  const courses = sourceCourses.map((course, index) => {
    const code = cleanText(course.code, 40);
    const title = cleanText(course.title, 160);
    if (!code || !title) throw new Error(`Finish the code and course name for course ${index + 1}.`);
    const id = uniqueId(`course-${slug(code, `course-${index + 1}`)}`, usedCourseIds);
    courseKeyToId.set(String(course.key ?? index), id);
    return {
      id,
      code,
      shortTitle: code,
      title,
      instructor: cleanText(course.instructor, 120) || null,
      notes: "Created by the account owner in Semester Board.",
      sourceRefs: [],
      meetings: [manualMeeting(id, course, term)],
      officeHours: manualOfficeHours(id, course),
      attendancePolicy: {
        model: "unknown_threshold",
        countUnit: "meeting",
        note: "No numeric attendance limit was entered.",
      },
    };
  });
  const usedAssignmentIds = new Set();
  const assignments = (Array.isArray(input.assignments) ? input.assignments : []).map((assignment, index) => {
    const title = cleanText(assignment.title, 240);
    const courseId = courseKeyToId.get(String(assignment.courseKey));
    if (!courseId || !title) throw new Error(`Finish the course and title for assignment ${index + 1}.`);
    const id = uniqueId(`${courseId}-${slug(title, `assignment-${index + 1}`)}`, usedAssignmentIds);
    const date = DATE_PATTERN.test(cleanText(assignment.date, 10)) ? cleanText(assignment.date, 10) : null;
    return {
      id,
      courseId,
      title,
      date,
      time: date ? formatManualClock(assignment.time) : null,
      kind: ["assignment", "quiz", "exam", "lab", "paper", "presentation", "project"].includes(assignment.kind)
        ? assignment.kind
        : "assignment",
      note: "Added by the account owner during semester setup.",
      dateCertainty: "user",
      certainty: "user",
      sourceStatus: "user-entered",
      sourceRefs: [],
      trackable: true,
    };
  });
  return normalizeSemesterState({
    schemaVersion: SEMESTER_SCHEMA_VERSION,
    term,
    courses,
    assignments,
    scheduleEvents: [],
    sourceRefs: {},
    sourceNotes: [],
    canvasSources: {},
    canvasAudit: null,
  });
}
