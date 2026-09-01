import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SEMESTER_CHAT_FACT_CHARS,
  MAX_SEMESTER_CHAT_FACTS,
  MAX_SEMESTER_CHAT_CONTEXT_CHARS,
  SEMESTER_CHAT_CONTEXT_VERSION,
  buildSemesterChatContext,
} from "../src/lib/assistantContext.js";
import { validateSemesterContext } from "../server/cloudAssistantSecurity.js";

const NOW = new Date("2026-08-26T13:00:00.000Z");

const course = {
  id: "ast",
  code: "BIO 1010",
  title: "Introductory Biology professor@example.edu",
  canvasCourseId: "private-canvas-course",
  assignmentsUrl: "https://canvas.example/private",
  officeHours: {
    entries: [{
      person: "Private Office Hours Host",
      location: "Private Office Hours Location",
      note: "Private Office Hours Note",
    }],
  },
};

const meeting = {
  id: "ast-2026-08-26-class",
  courseId: "ast",
  date: "2026-08-26",
  weekday: "WE",
  kind: "class",
  time: "3:00 PM–3:50 PM",
  startTime: "3:00 PM",
  endTime: "3:50 PM",
  location: "Room 101",
  eligible: true,
  checkInEnabled: true,
  status: "not_checked",
  sourceRefs: ["private-source-reference"],
};

test("semester chat snapshot contains useful board facts and excludes private raw state", () => {
  const snapshot = buildSemesterChatContext({
    now: NOW,
    courses: [course],
    meetings: [meeting],
    assignments: [
      {
        id: "paper",
        courseId: "ast",
        title: "Reflection paper https://canvas.example/private-assignment",
        date: "2026-08-28",
        time: "11:59 PM",
        canvasCourseId: "private-assignment-course-id",
        canvasAssignmentId: "private-assignment-id",
        canvasAssignmentUrl: "https://canvas.example/private-source-url",
        canvasFileIds: ["private-file-id"],
      },
      { id: "midterm", courseId: "ast", title: "Midterm Exam", kind: "exam", date: "2026-09-10", time: "3:00 PM" },
    ],
    attendanceTotals: {
      counts: { present: 4, late: 1, absent_excused: 1, absent_unexcused: 2, absent_pending: 0 },
      privateBreakdown: "do-not-share-breakdown",
    },
    reminders: [{
      id: "private-reminder-id",
      type: "assignment-24h",
      courseCode: "BIO 1010",
      remindAt: "2026-08-27T03:59:00.000Z",
      targetAt: "2026-08-28T03:59:00.000Z",
      endpoint: "https://push.example/private-capability",
    }],
    profileId: "private-profile-id",
    checkins: { secret: { note: "private attendance note" } },
    syllabusFiles: [{ name: "private-syllabus.pdf", instructorEmail: "professor@example.edu" }],
    pushSubscription: { endpoint: "https://push.example/private" },
  });

  assert.equal(snapshot.schemaVersion, SEMESTER_CHAT_CONTEXT_VERSION);
  assert.equal(snapshot.timeZone, "America/New_York");
  assert.equal(snapshot.campusDate, "2026-08-26");
  assert.deepEqual(Object.keys(snapshot), ["schemaVersion", "generatedAt", "timeZone", "campusDate", "facts"]);
  assert.deepEqual(validateSemesterContext(snapshot), snapshot);

  const facts = snapshot.facts.join("\n");
  assert.match(facts, /BIO 1010 — Introductory Biology/);
  assert.match(facts, /Wednesday, 3:00 PM–3:50 PM, Room 101/);
  assert.match(facts, /Upcoming assignment: BIO 1010 — Reflection paper/);
  assert.match(facts, /Upcoming exam: BIO 1010 — Midterm Exam/);
  assert.match(facts, /4 present, 1 late, 1 excused absences, 2 unexcused absences/);
  assert.match(facts, /Reminder: BIO 1010 assignment-24h/);
  assert.match(facts, /\[email removed\]/);
  assert.match(facts, /\[link removed\]/);

  for (const privateValue of [
    "private-canvas-course",
    "private-assignment-course-id",
    "private-assignment-id",
    "private-file-id",
    "canvas.example",
    "private-source-reference",
    "private-profile-id",
    "private attendance note",
    "private-syllabus.pdf",
    "professor@example.edu",
    "push.example",
    "private-reminder-id",
    "do-not-share-breakdown",
    "Private Office Hours Host",
    "Private Office Hours Location",
    "Private Office Hours Note",
  ]) {
    assert.equal(facts.includes(privateValue), false, privateValue);
  }
});

test("semester chat snapshot is bounded and strips control characters", () => {
  const courses = Array.from({ length: 20 }, (_, index) => ({
    id: `course-${index}`,
    code: `C${index}`,
    title: `${"Very long title ".repeat(40)}\n${index}`,
  }));
  const meetings = Array.from({ length: 80 }, (_, index) => ({
    id: `meeting-${index}`,
    courseId: courses[index % courses.length].id,
    date: `2026-09-${String((index % 20) + 1).padStart(2, "0")}`,
    weekday: ["MO", "TU", "WE", "TH", "FR"][index % 5],
    kind: index % 3 === 0 ? "discussion" : "class",
    time: `${8 + (index % 4)}:00 AM–${9 + (index % 4)}:00 AM`,
    startTime: `${8 + (index % 4)}:00 AM`,
    location: `Room ${index}`,
    eligible: true,
    checkInEnabled: true,
    status: "not_checked",
  }));

  const snapshot = buildSemesterChatContext({ now: NOW, courses, meetings });
  assert.ok(snapshot.facts.length <= MAX_SEMESTER_CHAT_FACTS);
  assert.ok(snapshot.facts.every((fact) => fact.length <= MAX_SEMESTER_CHAT_FACT_CHARS));
  assert.ok(snapshot.facts.reduce((total, fact) => total + fact.length, 0) <= MAX_SEMESTER_CHAT_CONTEXT_CHARS);
  assert.ok(snapshot.facts.every((fact) => !/[\u0000-\u001f\u007f]/.test(fact)));
  assert.doesNotThrow(() => validateSemesterContext(snapshot));
});
