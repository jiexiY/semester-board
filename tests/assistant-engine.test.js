import test from "node:test";
import assert from "node:assert/strict";

import {
  answerAssistantQuery,
  buildAssistantReminders,
  buildDailyBriefing,
  campusDateTimeToDate,
  collectDueReminders,
  detectAssistantIntent,
  getReminderDeliveryId,
  parseCampusClock,
} from "../src/lib/assistantEngine.js";

const courses = [
  { id: "ast", code: "BIO 1010" },
  { id: "laa", code: "HIS 2100" },
];

const meeting = (id, date, time, extra = {}) => ({
  id,
  courseId: "ast",
  date,
  kind: "class",
  startTime: time,
  status: "not_checked",
  eligible: true,
  checkInEnabled: true,
  ...extra,
});

test("campus clock parsing and conversion use America/New_York", () => {
  assert.deepEqual(parseCampusClock("10:40 AM–11:30 AM"), { hour: 10, minute: 40 });
  assert.deepEqual(parseCampusClock("15:05"), { hour: 15, minute: 5 });
  assert.equal(parseCampusClock("Start of class"), null);
  assert.equal(
    campusDateTimeToDate("2026-08-25", "10:00 AM").toISOString(),
    "2026-08-25T14:00:00.000Z",
  );
});

test("class reminders fire one hour before eligible in-person meetings", () => {
  const reminders = buildAssistantReminders({
    courses,
    meetings: [
      meeting("in-person", "2026-08-25", "10:00 AM"),
      meeting("cancelled", "2026-08-25", "11:00 AM", { status: "cancelled" }),
      meeting("no-class", "2026-08-25", "12:00 PM", { kind: "no-class" }),
      meeting("online", "2026-08-25", "1:00 PM", { location: "Zoom" }),
      meeting("disabled", "2026-08-25", "2:00 PM", { disabled: true }),
      meeting("exam-event", "2026-08-25", "3:00 PM", { kind: "exam" }),
    ],
  });

  assert.deepEqual(reminders.map((reminder) => reminder.id), ["class:in-person:1h"]);
  assert.deepEqual(reminders[0], {
    id: "class:in-person:1h",
    type: "class-1h",
    targetAt: "2026-08-25T14:00:00.000Z",
    remindAt: "2026-08-25T13:00:00.000Z",
    title: "BIO 1010 class in one hour",
    body: "BIO 1010 starts at 10:00 AM.",
    courseCode: "BIO 1010",
    date: "2026-08-25",
    time: "10:00 AM",
    eventId: "in-person",
    courseId: "ast",
  });
});

test("assignment reminders use exact minus 24 hours or prior-day 9 AM for date-only work", () => {
  const reminders = buildAssistantReminders({
    courses,
    assignments: [
      { id: "timed", courseId: "ast", title: "Timed paper", date: "2026-08-26", time: "11:59 PM" },
      { id: "date-only", courseId: "ast", title: "Date-only reflection", date: "2026-08-26", time: null },
      { id: "undated", courseId: "ast", title: "Unknown", date: null },
      { id: "informational", courseId: "ast", title: "Info", date: "2026-08-26", trackable: false },
    ],
  });

  const timed = reminders.find((reminder) => reminder.id === "assignment:timed:24h");
  const dateOnly = reminders.find((reminder) => reminder.id === "assignment:date-only:24h");
  assert.equal(timed.targetAt, "2026-08-27T03:59:00.000Z");
  assert.equal(timed.remindAt, "2026-08-26T03:59:00.000Z");
  assert.equal(dateOnly.targetAt, "2026-08-27T04:00:00.000Z");
  assert.equal(dateOnly.remindAt, "2026-08-25T13:00:00.000Z");
  assert.equal(reminders.some((reminder) => reminder.eventId === "undated"), false);
  assert.equal(reminders.some((reminder) => reminder.eventId === "informational"), false);
});

test("start-of-class deadlines resolve to the actual same-day course meeting", () => {
  const reminders = buildAssistantReminders({
    courses,
    meetings: [meeting("class-start", "2026-08-25", "10:00 AM")],
    assignments: [{
      id: "semantic-start",
      courseId: "ast",
      title: "Unit Quiz",
      date: "2026-08-25",
      time: "Start of Tuesday class",
    }],
  });
  const reminder = reminders.find((item) => item.id === "assignment:semantic-start:24h");
  assert.equal(reminder.targetAt, "2026-08-25T14:00:00.000Z");
  assert.equal(reminder.remindAt, "2026-08-24T14:00:00.000Z");
  assert.equal(reminder.time, "Start of Tuesday class (10:00 AM)");

  const answer = answerAssistantQuery("What’s next?", {
    now: new Date("2026-08-25T15:00:00.000Z"),
    courses,
    meetings: [meeting("class-start", "2026-08-25", "10:00 AM")],
    assignments: [{
      id: "semantic-start",
      courseId: "ast",
      title: "Unit Quiz",
      date: "2026-08-25",
      time: "Start of Tuesday class",
    }],
  });
  assert.equal(answer.items.length, 0);
});

test("exam reminders prefer the linked exact schedule session while keeping Canvas due reminder", () => {
  const reminders = buildAssistantReminders({
    courses,
    assignments: [{
      id: "laa-final",
      courseId: "laa",
      title: "Final Assessment",
      kind: "exam",
      date: "2026-12-07",
      time: "11:59 PM",
    }],
    scheduleEvents: [{
      id: "laa-final-session",
      linkedAssignmentId: "laa-final",
      courseId: "laa",
      title: "Assessment session",
      kind: "exam",
      date: "2026-12-07",
      time: "3:00 PM–5:00 PM",
      startTime: "3:00 PM",
      status: "not_checked",
    }],
  });

  const assignment = reminders.find((reminder) => reminder.id === "assignment:laa-final:24h");
  const exam = reminders.find((reminder) => reminder.id === "exam:laa-final:7d");
  assert.equal(assignment.targetAt, "2026-12-08T04:59:00.000Z");
  assert.equal(exam.targetAt, "2026-12-07T20:00:00.000Z");
  assert.equal(exam.remindAt, "2026-11-30T20:00:00.000Z");
  assert.match(exam.title, /Assessment session/);
  assert.equal(reminders.filter((reminder) => reminder.type === "exam-7d").length, 1);
});

test("date-only finals remind seven calendar days earlier at 9 AM", () => {
  const reminders = buildAssistantReminders({
    courses,
    assignments: [{ id: "final-date-only", courseId: "ast", title: "Final reflection", kind: "final", date: "2026-09-01" }],
  });
  const exam = reminders.find((reminder) => reminder.id === "exam:final-date-only:7d");
  assert.equal(exam.remindAt, "2026-08-25T13:00:00.000Z");
  assert.equal(exam.time, null);
});

test("catch-up collection stops at the target and delivers each reminder once", () => {
  const reminders = [
    {
      id: "catch-up",
      type: "class-1h",
      courseCode: "BIO 1010",
      title: "BIO 1010 class in one hour",
      body: "BIO 1010 starts at 10:00 AM.",
      time: "10:00 AM",
      remindAt: "2026-08-25T13:00:00.000Z",
      targetAt: "2026-08-25T14:00:00.000Z",
    },
    { id: "expired", remindAt: "2026-08-25T11:00:00.000Z", targetAt: "2026-08-25T12:00:00.000Z" },
    { id: "future", remindAt: "2026-08-25T14:00:00.000Z", targetAt: "2026-08-25T15:00:00.000Z" },
    { id: "already", remindAt: "2026-08-25T13:00:00.000Z", targetAt: "2026-08-25T14:00:00.000Z" },
  ];
  const alreadyDeliveryId = getReminderDeliveryId(reminders[3]);
  const catchUpDeliveryId = getReminderDeliveryId(reminders[0]);
  const first = collectDueReminders(reminders, {
    now: new Date("2026-08-25T13:30:00.000Z"),
    deliveredIds: [alreadyDeliveryId],
  });
  assert.deepEqual(first.reminders.map((reminder) => reminder.id), ["catch-up"]);
  assert.equal(first.reminders[0].deliveryId, catchUpDeliveryId);
  assert.match(first.reminders[0].title, /in 30 minutes/i);
  assert.match(first.reminders[0].body, /starts in 30 minutes at 10:00 AM/i);
  assert.doesNotMatch(first.reminders[0].body, /one hour/i);
  assert.deepEqual(first.deliveredIds, [alreadyDeliveryId, catchUpDeliveryId]);

  const second = collectDueReminders(reminders, {
    now: new Date("2026-08-25T13:40:00.000Z"),
    deliveredIds: first.deliveredIds,
  });
  assert.deepEqual(second.reminders, []);
});

test("rescheduled reminder occurrences deliver again under the same stable reminder id", () => {
  const original = {
    id: "assignment:paper:24h",
    type: "assignment-24h",
    title: "Paper is due soon",
    body: "Paper is due in 24 hours at 5:00 PM.",
    time: "5:00 PM",
    remindAt: "2026-08-25T21:00:00.000Z",
    targetAt: "2026-08-26T21:00:00.000Z",
  };
  const first = collectDueReminders([original], {
    now: new Date("2026-08-25T22:00:00.000Z"),
  });
  assert.equal(first.reminders.length, 1);

  const rescheduled = {
    ...original,
    remindAt: "2026-08-26T21:00:00.000Z",
    targetAt: "2026-08-27T21:00:00.000Z",
  };
  const second = collectDueReminders([rescheduled], {
    now: new Date("2026-08-26T22:00:00.000Z"),
    deliveredIds: first.deliveredIds,
  });

  assert.equal(second.reminders.length, 1);
  assert.equal(second.reminders[0].id, original.id);
  assert.notEqual(second.reminders[0].deliveryId, first.reminders[0].deliveryId);
  assert.deepEqual(second.deliveredIds, [
    getReminderDeliveryId(original),
    getReminderDeliveryId(rescheduled),
  ]);
});

test("daily briefing reports today and picks the next still-upcoming item", () => {
  const briefing = buildDailyBriefing({
    now: new Date("2026-08-25T13:30:00.000Z"),
    courses,
    meetings: [
      meeting("past", "2026-08-25", "8:00 AM"),
      meeting("next", "2026-08-25", "10:00 AM"),
      meeting("tomorrow", "2026-08-26", "9:00 AM"),
    ],
    assignments: [{ id: "due-today", courseId: "ast", title: "Reflection", date: "2026-08-25", time: "5:00 PM" }],
    attendanceTotals: { present: 3, absent_unexcused: 1 },
  });

  assert.equal(briefing.dateKey, "2026-08-25");
  assert.equal(briefing.classes.length, 2);
  assert.equal(briefing.assignments.length, 1);
  assert.equal(briefing.next.id, "next");
  assert.match(briefing.body, /2 classes and 1 assignment due/i);
  assert.match(briefing.body, /1 unexcused absence recorded/i);
});

test("daily briefing and what-next prefer the exact linked exam session chronology", () => {
  const assignments = [{
    id: "laa-final",
    courseId: "laa",
    title: "Final Assessment",
    kind: "exam",
    date: "2026-12-07",
    time: "11:59 PM",
  }];
  const scheduleEvents = [
    {
      id: "laa-final-session",
      linkedAssignmentId: "laa-final",
      courseId: "laa",
      title: "Final Assessment — exam session",
      kind: "exam",
      date: "2026-12-07",
      time: "3:00 PM–5:00 PM",
      startTime: "3:00 PM",
      status: "not_checked",
    },
    {
      id: "duplicate-linked-session",
      linkedAssignmentId: "laa-final",
      courseId: "laa",
      title: "Duplicate final session",
      kind: "exam",
      date: "2026-12-07",
      startTime: "3:00 PM",
      status: "not_checked",
    },
  ];
  const context = {
    now: new Date("2026-12-07T18:00:00.000Z"),
    courses,
    meetings: [],
    assignments,
    scheduleEvents,
  };

  const briefing = buildDailyBriefing(context);
  assert.equal(briefing.exams.length, 1);
  assert.equal(briefing.exams[0].targetAt, "2026-12-07T20:00:00.000Z");
  assert.equal(briefing.assignments[0].targetAt, "2026-12-08T04:59:00.000Z");
  assert.equal(briefing.next.type, "exam");
  assert.match(briefing.body, /1 exam session today/i);

  const next = answerAssistantQuery("What's next?", context);
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].type, "exam");
  assert.equal(next.items[0].targetAt, "2026-12-07T20:00:00.000Z");
});

test("assistant intent detection covers every supported local command", () => {
  assert.equal(detectAssistantIntent("What's next?"), "what-next");
  assert.equal(detectAssistantIntent("What is due?"), "due");
  assert.equal(detectAssistantIntent("Show assignments"), "due");
  assert.equal(detectAssistantIntent("What do I have today?"), "today");
  assert.equal(detectAssistantIntent("Show my finals"), "exams");
  assert.equal(detectAssistantIntent("How is my attendance?"), "attendance");
  assert.equal(detectAssistantIntent("Show reminders"), "reminders");
  assert.equal(detectAssistantIntent("Hello"), "unknown");
});

test("assistant answers attendance, reminder, and what-next intents without external state", () => {
  const context = {
    now: new Date("2026-08-25T13:30:00.000Z"),
    courses,
    meetings: [meeting("next", "2026-08-25", "10:00 AM")],
    assignments: [],
    attendanceTotals: { counts: { present: 4, absent_excused: 1, absent_unexcused: 2 } },
    reminders: [{ id: "r1", remindAt: "2026-08-25T13:00:00.000Z", targetAt: "2026-08-25T14:00:00.000Z" }],
  };

  const next = answerAssistantQuery("What's next?", context);
  assert.equal(next.intent, "what-next");
  assert.equal(next.items[0].id, "next");

  const attendance = answerAssistantQuery("Attendance", context);
  assert.equal(attendance.attendanceTotals.absent_unexcused, 2);
  assert.match(attendance.body, /2 unexcused absences/i);

  const reminders = answerAssistantQuery("Reminders", context);
  assert.deepEqual(reminders.items.map((item) => item.id), ["r1"]);
});
