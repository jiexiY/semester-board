import test from "node:test";
import assert from "node:assert/strict";

import { computeAttendanceSummary } from "../src/lib/attendance.js";
import {
  attendanceLabel,
  buildCourseTimeline,
  buildIntegratedCourseTimeline,
  classifyTimelineEvent,
  monthLabel,
} from "../src/lib/board.js";

test("buildCourseTimeline sorts dated work chronologically without dating TBD items", () => {
  const assignments = [
    { id: "late", title: "Later", date: "2026-09-20", time: null, kind: "paper" },
    { id: "tbd-b", title: "Beta", date: null, kind: "paper" },
    { id: "same-b", title: "Beta", date: "2026-08-25", time: "3:00 PM", kind: "quiz" },
    { id: "same-a", title: "Alpha", date: "2026-08-25", time: "10:40 AM", kind: "quiz" },
    { id: "same-undisclosed", title: "No time", date: "2026-08-25", time: null, kind: "quiz" },
    { id: "tbd-a", title: "Alpha", date: null, kind: "exam" },
    { id: "invalid", title: "No invented placement", date: "TBD", kind: "lab" },
  ];
  const before = assignments.map(({ id, date }) => ({ id, date }));
  const timeline = buildCourseTimeline(assignments);

  assert.deepEqual(timeline.dated.map((item) => item.id), ["same-a", "same-b", "same-undisclosed", "late"]);
  assert.deepEqual(timeline.undated.map((item) => item.id), ["tbd-a", "invalid", "tbd-b"]);
  assert.deepEqual(assignments.map(({ id, date }) => ({ id, date })), before);
  assert.equal(timeline.undated.every((item) => item.date == null || item.date === "TBD"), true);
});

test("monthGroups are chronological and contain only dated assignments", () => {
  const timeline = buildCourseTimeline([
    { id: "oct", title: "October", date: "2026-10-01", kind: "exam" },
    { id: "aug-b", title: "August B", date: "2026-08-30", kind: "quiz" },
    { id: "unknown", title: "Unknown", date: null, kind: "paper" },
    { id: "aug-a", title: "August A", date: "2026-08-23", kind: "study-guide" },
  ]);

  assert.deepEqual(timeline.monthGroups.map(({ key, label }) => ({ key, label })), [
    { key: "2026-08", label: "August 2026" },
    { key: "2026-10", label: "October 2026" },
  ]);
  assert.deepEqual(timeline.monthGroups[0].items.map((item) => item.id), ["aug-a", "aug-b"]);
  assert.equal(timeline.monthGroups.flatMap((group) => group.items).some((item) => item.id === "unknown"), false);
});

test("monthLabel is UTC-stable and honest for missing or invalid dates", () => {
  assert.equal(monthLabel("2026-12-10"), "December 2026");
  assert.equal(monthLabel(null), "Date not stated");
  assert.equal(monthLabel("2026-02-30"), "Date not stated");
});

test("attendanceLabel follows each policy model without course identifiers", () => {
  const unknown = { id: "unknown", attendancePolicy: { model: "unknown_threshold" } };
  const allowance = { id: "allowance", attendancePolicy: { model: "no_penalty_allowance", allowance: 3 } };
  const periods = { id: "periods", attendancePolicy: { model: "hard_threshold", countUnit: "period", allowedBeforeFailure: 6, failureTrigger: 7 } };
  const meetings = { id: "meetings", attendancePolicy: { model: "hard_threshold", countUnit: "meeting", counters: [{ label: "Meetings before failure", trigger: 3 }] } };

  const unknownSummary = computeAttendanceSummary(unknown, [
    { status: "absent_unexcused" },
    { status: "absent_unexcused" },
  ]);
  assert.equal(attendanceLabel(unknown, unknownSummary), "2 unexcused absences recorded · limit not stated");

  const allowanceSummary = computeAttendanceSummary(allowance, [
    { status: "absent_unexcused" },
  ]);
  assert.equal(attendanceLabel(allowance, allowanceSummary), "2 no-penalty absences left");

  const periodSummary = computeAttendanceSummary(periods, [
    { status: "absent_unexcused", countWeight: 2 },
  ]);
  assert.equal(attendanceLabel(periods, periodSummary), "4 periods left before failure");

  const meetingSummary = computeAttendanceSummary(meetings, [
    { status: "absent_unexcused" },
  ]);
  assert.equal(attendanceLabel(meetings, meetingSummary), "1 meeting before failure");
});

test("attendanceLabel never substitutes a number when a requested runway is absent", () => {
  assert.equal(
    attendanceLabel({ attendancePolicy: { model: "no_penalty_allowance" } }, { remaining: null }),
    "No-penalty allowance not available",
  );
  assert.equal(
    attendanceLabel({ attendancePolicy: { model: "unknown_threshold" } }, { confirmedCount: 4, remaining: 99 }),
    "4 unexcused absences recorded · limit not stated",
  );
});

test("integrated timeline merges coursework and meetings in chronological clock order", () => {
  const assignment = Object.freeze({
    id: "quiz",
    title: "Reading Quiz",
    date: "2026-08-25",
    time: "Start of Tuesday class",
    kind: "quiz",
  });
  const meeting = Object.freeze({
    id: "class",
    meetingId: "class",
    date: "2026-08-25",
    startTime: "10:40 AM",
    endTime: "11:30 AM",
    kind: "lecture",
    status: "not_checked",
  });
  const earlierAssignment = Object.freeze({
    id: "paper",
    title: "Response Paper",
    date: "2026-08-23",
    time: null,
    kind: "paper",
  });

  const timeline = buildIntegratedCourseTimeline(
    [assignment, earlierAssignment],
    [meeting],
  );

  assert.deepEqual(timeline.dated.map((event) => event.id), [
    "assignment:paper",
    "meeting:class",
    "assignment:quiz",
  ]);
  assert.equal(timeline.dated[1].title, "Lecture");
  assert.equal(timeline.dated[1].time, "10:40 AM–11:30 AM");
  assert.equal(timeline.dated[1].category, "class");
  assert.equal(timeline.dated[1].source, "meeting");
  assert.equal(timeline.dated[1].meeting, meeting);
  assert.equal(assignment.date, "2026-08-25", "source objects remain untouched");
  assert.equal(Object.hasOwn(assignment, "category"), false);
});

test("integrated timeline includes cancelled and no-class meeting occurrences", () => {
  const timeline = buildIntegratedCourseTimeline({
    assignments: [],
    meetings: [
      {
        id: "holiday",
        date: "2026-09-07",
        kind: "no-class",
        label: "Labor Day — no class",
        status: "cancelled",
        disabled: true,
        eligible: false,
        checkInEnabled: false,
      },
      {
        id: "ordinary",
        date: "2026-09-08",
        kind: "class",
        status: "not_checked",
      },
    ],
  });

  assert.equal(timeline.dated.length, 2);
  assert.equal(timeline.dated[0].title, "Labor Day — no class");
  assert.equal(timeline.dated[0].cancelled, true);
  assert.equal(timeline.dated[0].category, "class");
  assert.equal(timeline.dated[0].meeting.eligible, false);
  assert.equal(timeline.dated[1].cancelled, false);
});

test("integrated timeline preserves undated work and never promotes meeting patterns", () => {
  const undated = { id: "fog", title: "Midterm Exam", date: null, kind: "exam" };
  const timeline = buildIntegratedCourseTimeline({
    assignments: [undated],
    meetings: [{ id: "pattern", date: null, kind: "class", weekdays: ["MO"] }],
  });

  assert.equal(timeline.dated.length, 0);
  assert.equal(timeline.undated.length, 1);
  assert.equal(timeline.undated[0].id, "assignment:fog");
  assert.equal(timeline.undated[0].date, null);
  assert.equal(timeline.undated[0].category, "exam");
  assert.equal(timeline.undated[0].assignment, undated);
  assert.equal(timeline.monthGroups.length, 0);
});

test("timeline classification covers every requested event family", () => {
  assert.equal(classifyTimelineEvent({ kind: "lecture" }), "class");
  assert.equal(classifyTimelineEvent({ kind: "assignment", title: "Worksheet" }), "assignment");
  assert.equal(classifyTimelineEvent({ kind: "exam" }), "exam");
  assert.equal(classifyTimelineEvent({ kind: "lab" }), "lab");
  assert.equal(classifyTimelineEvent({ kind: "paper" }), "paper");
  assert.equal(classifyTimelineEvent({ kind: "presentation" }), "project");
  assert.equal(classifyTimelineEvent({ kind: "quiz" }), "quiz");
  assert.equal(classifyTimelineEvent({ kind: "study-guide", title: "Study Guide - Final Exam" }), "assignment");
  assert.equal(classifyTimelineEvent({ kind: "reflection", title: "Final Project Individual Reflection" }), "project");
  assert.equal(classifyTimelineEvent({ kind: "reflection", title: "Observing-lab Written Reflection" }), "assignment");
});

test("integrated month groups contain both class and coursework events", () => {
  const timeline = buildIntegratedCourseTimeline({
    assignments: [{ id: "final", title: "Final Exam", date: "2026-12-10", kind: "exam" }],
    meetings: [{ id: "aug-class", date: "2026-08-21", kind: "class" }],
  });

  assert.deepEqual(timeline.monthGroups.map((group) => group.key), ["2026-08", "2026-12"]);
  assert.deepEqual(
    timeline.monthGroups.flatMap((group) => group.items).map((event) => event.category),
    ["class", "exam"],
  );
});

test("integrated timeline keeps linked schedule events separate from Canvas cutoffs", () => {
  const timeline = buildIntegratedCourseTimeline({
    assignments: [{ id: "final", title: "Final Assessment", date: "2026-12-07", time: "11:59 PM", kind: "exam" }],
    meetings: [],
    scheduleEvents: [{
      id: "final-session",
      title: "Final Assessment — exam session",
      date: "2026-12-07",
      time: "3:00 PM–5:00 PM",
      kind: "exam",
      linkedAssignmentId: "final",
    }],
  });

  assert.deepEqual(timeline.dated.map((event) => event.id), [
    "schedule:final-session",
    "assignment:final",
  ]);
  assert.equal(timeline.dated[0].source, "schedule");
  assert.equal(timeline.dated[0].informational, true);
  assert.equal(timeline.dated[1].time, "11:59 PM");
});
