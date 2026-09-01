import { isEligibleActualMeeting } from "./attendanceFlow.js";
import {
  answerAssistantQuery,
  campusDateTimeToDate,
} from "./assistantEngine.js";
import {
  CAMPUS_TIME_ZONE,
  campusDateKey,
} from "./format.js";

export const SEMESTER_CHAT_CONTEXT_VERSION = 1;
export const MAX_SEMESTER_CHAT_FACTS = 64;
export const MAX_SEMESTER_CHAT_FACT_CHARS = 320;
export const MAX_SEMESTER_CHAT_CONTEXT_CHARS = 16_000;

const MAX_COURSE_FACTS = 8;
const MAX_SCHEDULE_FACTS = 16;
const MAX_CLASS_FACTS = 16;
const MAX_ASSIGNMENT_FACTS = 16;
const MAX_EXAM_FACTS = 8;
const MAX_REMINDER_FACTS = 12;

const WEEKDAY_LABELS = Object.freeze({
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
});

function cleanFact(value) {
  return String(value ?? "")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link removed]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email removed]")
    .replace(/\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[phone removed]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SEMESTER_CHAT_FACT_CHARS);
}

function safeDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function safeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function courseCodeFor(courseId, coursesById) {
  return coursesById.get(courseId)?.code || "Course";
}

function displayedMeetingTime(meeting) {
  return meeting.time || [meeting.startTime, meeting.endTime].filter(Boolean).join("–") || "time not stated";
}

function displayedLocation(value) {
  return cleanFact(value) || "location not stated";
}

function uniqueBy(items, keyFor) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFor(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Builds the only dashboard data that may leave the browser for Semester Chat.
 * Raw check-ins, attendance notes, profile data, Canvas identifiers and URLs,
 * syllabus files, push subscriptions, and storage metadata are intentionally ignored.
 */
export function buildSemesterChatContext(context = {}) {
  const now = safeDate(context.now);
  const courses = Array.isArray(context.courses) ? context.courses : [];
  const meetings = Array.isArray(context.meetings) ? context.meetings : [];
  const reminders = Array.isArray(context.reminders) ? context.reminders : [];
  const coursesById = new Map(courses.map((course) => [course.id, course]));
  const assistantContext = { ...context, now, reminders };
  const upcomingAssignments = answerAssistantQuery("What is due?", assistantContext).items || [];
  const upcomingExams = answerAssistantQuery("Show my exams", assistantContext).items || [];
  const examOccurrences = new Set(upcomingExams.map((item) => `${item.id}|${item.targetAt}`));
  const facts = [];
  let factChars = 0;
  const addFact = (value) => {
    const fact = cleanFact(value);
    if (
      !fact
      || facts.length >= MAX_SEMESTER_CHAT_FACTS
      || factChars + fact.length > MAX_SEMESTER_CHAT_CONTEXT_CHARS
    ) return;
    facts.push(fact);
    factChars += fact.length;
  };

  courses.slice(0, MAX_COURSE_FACTS).forEach((course) => {
    addFact(`Course: ${course.code || "Code not stated"} — ${course.title || course.shortTitle || "title not stated"}.`);
  });

  uniqueBy(
    meetings.filter(isEligibleActualMeeting),
    (meeting) => [
      meeting.courseId,
      meeting.kind,
      meeting.weekday,
      displayedMeetingTime(meeting),
      meeting.location,
    ].join("|"),
  ).slice(0, MAX_SCHEDULE_FACTS).forEach((meeting) => {
    const courseCode = courseCodeFor(meeting.courseId, coursesById);
    const weekday = WEEKDAY_LABELS[meeting.weekday] || meeting.weekday || "day not stated";
    const kind = meeting.kind === "discussion" ? "discussion" : "class";
    addFact(`Class pattern: ${courseCode} ${kind} meets ${weekday}, ${displayedMeetingTime(meeting)}, ${displayedLocation(meeting.location)}.`);
  });

  meetings.map((meeting) => {
    if (!isEligibleActualMeeting(meeting)) return null;
    const target = campusDateTimeToDate(meeting.date, meeting.startTime || meeting.time);
    if (!target || target.getTime() <= now.getTime()) return null;
    return { meeting, targetAt: target.toISOString() };
  }).filter(Boolean)
    .sort((left, right) => left.targetAt.localeCompare(right.targetAt))
    .slice(0, MAX_CLASS_FACTS)
    .forEach(({ meeting }) => {
      const courseCode = courseCodeFor(meeting.courseId, coursesById);
      const kind = meeting.kind === "discussion" ? "discussion" : "class";
      addFact(`Upcoming class: ${courseCode} ${kind} on ${meeting.date}, ${displayedMeetingTime(meeting)}, ${displayedLocation(meeting.location)}.`);
    });

  upcomingAssignments
    .filter((item) => !examOccurrences.has(`${item.id}|${item.targetAt}`))
    .slice(0, MAX_ASSIGNMENT_FACTS)
    .forEach((item) => {
      addFact(`Upcoming assignment: ${item.courseCode} — ${item.title}; due ${item.date}${item.time ? ` at ${item.time}` : "; exact time not stated"}.`);
    });

  upcomingExams.slice(0, MAX_EXAM_FACTS).forEach((item) => {
    addFact(`Upcoming exam: ${item.courseCode} — ${item.title}; ${item.date}${item.time ? ` at ${item.time}` : "; exact time not stated"}.`);
  });

  const attendance = context.attendanceTotals?.counts ?? context.attendanceTotals ?? {};
  addFact([
    "Aggregate attendance:",
    `${safeCount(attendance.present)} present,`,
    `${safeCount(attendance.late)} late,`,
    `${safeCount(attendance.absent_excused)} excused absences,`,
    `${safeCount(attendance.absent_unexcused)} unexcused absences,`,
    `${safeCount(attendance.absent_pending)} pending absences.`
  ].join(" "));

  reminders
    .filter((reminder) => Number.isFinite(Date.parse(reminder?.targetAt)) && Date.parse(reminder.targetAt) > now.getTime())
    .sort((left, right) => String(left.remindAt).localeCompare(String(right.remindAt)))
    .slice(0, MAX_REMINDER_FACTS)
    .forEach((reminder) => {
      addFact(`Reminder: ${reminder.courseCode || "Course"} ${reminder.type || "event"}; notify ${reminder.remindAt}; target ${reminder.targetAt}.`);
    });

  return {
    schemaVersion: SEMESTER_CHAT_CONTEXT_VERSION,
    generatedAt: now.toISOString(),
    timeZone: CAMPUS_TIME_ZONE,
    campusDate: campusDateKey(now),
    facts,
  };
}
