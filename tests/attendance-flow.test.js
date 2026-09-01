import test from "node:test";
import assert from "node:assert/strict";

import { computeAttendanceSummary, getExcuseDeadline } from "../src/lib/attendance.js";
import {
  allowancePositionForMeeting,
  meetingPatternsAreComplete,
  eligibleAttendanceMeetings,
  excuseGuidanceForMeeting,
  nextMeetingPattern,
  normalizeMeetingPatterns,
  selectDefaultAttendanceMeeting,
  serializeMeetingPatterns,
} from "../src/lib/attendanceFlow.js";
import { generateCourseMeetings } from "../src/lib/calendar.js";

const meeting = (id, date, extra = {}) => ({
  id,
  date,
  kind: "class",
  status: "not_checked",
  ...extra,
});

test("header selection prioritizes the oldest eligible unchecked meeting due by today", () => {
  const meetings = [
    meeting("future", "2026-08-24"),
    meeting("oldest", "2026-08-20"),
    meeting("today", "2026-08-21"),
    meeting("holiday", "2026-08-19", { kind: "no-class", disabled: true, status: "cancelled" }),
  ];
  const selected = selectDefaultAttendanceMeeting(meetings, {}, "2026-08-21");

  assert.equal(selected.id, "oldest");
  assert.deepEqual(eligibleAttendanceMeetings(meetings).map((item) => item.id), ["oldest", "today", "future"]);
});

test("header selection falls forward to future unchecked, then latest eligible", () => {
  const meetings = [
    meeting("past", "2026-08-20"),
    meeting("future-a", "2026-08-24"),
    meeting("future-b", "2026-08-26"),
  ];
  assert.equal(selectDefaultAttendanceMeeting(
    meetings,
    { past: { status: "present" } },
    "2026-08-21",
  ).id, "future-a");
  assert.equal(selectDefaultAttendanceMeeting(
    meetings,
    {
      past: { status: "present" },
      "future-a": { status: "late" },
      "future-b": { status: "absent_excused" },
    },
    "2026-08-21",
  ).id, "future-b");
});

test("allowance position counts only chronological unexcused and pending entries", () => {
  const course = { attendancePolicy: { model: "no_penalty_allowance", allowance: 3 } };
  const meetings = [
    meeting("a", "2026-08-21"),
    meeting("cancelled", "2026-08-22", { disabled: true, status: "cancelled" }),
    meeting("b", "2026-08-24"),
    meeting("excused", "2026-08-25"),
    meeting("c", "2026-08-26"),
  ];
  const checkins = {
    a: { status: "absent_unexcused" },
    cancelled: { status: "absent_unexcused" },
    b: { status: "absent_pending" },
    excused: { status: "absent_excused" },
    c: { status: "absent_unexcused" },
  };

  assert.equal(allowancePositionForMeeting(course, meetings[0], meetings, checkins), 1);
  assert.equal(allowancePositionForMeeting(course, meetings[2], meetings, checkins), 2);
  assert.equal(allowancePositionForMeeting(course, meetings[4], meetings, checkins), 3);
  assert.equal(allowancePositionForMeeting(course, meetings[3], meetings, checkins), null);
  assert.match(
    excuseGuidanceForMeeting(course, meetings[4], checkins.c, { allowancePosition: 3 }).label,
    /no justification required/i,
  );
});

test("source rules preserve prior notification and separate discussion guidance", () => {
  const course = { excuseRules: [
    { scope: "Lecture", action: "Notify the instructor before class and obtain approval.", deadline: "Before class", certainty: "confirmed" },
    { scope: "Discussion", action: "Notify the discussion assistant before the absence and obtain approval.", deadline: "Before discussion", certainty: "confirmed" },
  ] };
  const lecture = excuseGuidanceForMeeting(
    course,
    meeting("lecture", "2026-08-25", { kind: "lecture" }),
    { status: "absent_pending", reason: "illness_quarantine" },
  );
  const discussion = excuseGuidanceForMeeting(
    course,
    meeting("discussion", "2026-08-24", { kind: "discussion" }),
    { status: "absent_pending", reason: "general" },
  );

  assert.match(lecture.label, /before class and obtain approval/i);
  assert.doesNotMatch(lecture.label, /as soon as/i);
  assert.match(discussion.label, /discussion assistant before the absence and obtain approval/i);
});

test("raw deadline helper keeps scoped approval language", () => {
  const course = { excuseRules: [
    { scope: "Lecture", action: "Notify the instructor before class and obtain approval.", deadline: "Before class", certainty: "confirmed" },
    { scope: "Discussion", action: "Notify the discussion assistant before the absence and obtain approval.", deadline: "Before discussion", certainty: "confirmed" },
  ] };
  const lecture = getExcuseDeadline(
    course,
    { date: "2026-08-25", kind: "lecture", status: "absent_pending", reason: "illness_quarantine" },
  );
  const discussion = getExcuseDeadline(
    course,
    { date: "2026-08-24", kind: "discussion", status: "absent_pending", reason: "illness_quarantine" },
  );

  assert.match(lecture.label, /before class and obtain approval/i);
  assert.doesNotMatch(lecture.label, /as soon as/i);
  assert.match(discussion.label, /discussion assistant before the absence and obtain approval/i);
});

test("illness guidance preserves a possible documentation note without inventing a deadline", () => {
  const guidance = getExcuseDeadline(
    { excuseRules: [{ scope: "Illness or quarantine", action: "A signed note may be required.", deadline: null, certainty: "tbd", note: "A signed note may be required." }] },
    { date: "2026-09-01", status: "absent_pending", reason: "illness_quarantine" },
  );

  assert.equal(guidance.date, null);
  assert.equal(guidance.exactDeadlineKnown, false);
  assert.match(guidance.label, /deadline not stated/i);
  assert.match(guidance.note, /signed note may be required/i);
});

test("saved reason and missed-assignment fields drive source-backed guidance", () => {
  const sponsored = excuseGuidanceForMeeting(
    { excuseRules: [{ scope: "University-sponsored event", action: "Discuss the absence with the instructor.", deadline: "Before the missed date", certainty: "confirmed" }] },
    meeting("sponsored", "2026-09-01"),
    { status: "absent_pending", reason: "university_sponsored" },
  );
  assert.match(sponsored.label, /before the missed date/i);

  const alternative = excuseGuidanceForMeeting(
    { excuseRules: [{ scope: "Alternative work after an excused missed in-class assignment", action: "Propose alternative work.", deadline: "Within one week", certainty: "confirmed" }] },
    meeting("alternative", "2026-09-24"),
    {
      status: "absent_excused",
      reason: "general",
      missedInClassAssignment: true,
    },
  );
  assert.equal(alternative.date, "2026-10-01");
  assert.match(alternative.label, /alternative-work proposal/i);
});

test("a recurring double-period pattern produces two-period absence weight", () => {
  const course = {
    id: "period-course",
    attendancePolicy: {
      model: "hard_threshold",
      countUnit: "period",
      allowedBeforeFailure: 6,
      failureTrigger: 7,
    },
    meetings: [{
      id: "period-custom",
      kind: "class",
      weekdays: ["MO"],
      time: "9:00 AM–10:50 AM",
      generation: "derived_from_term",
      countWeight: 2,
      range: { startDate: "2026-08-20", endDate: "2026-08-31" },
    }],
  };
  const generated = generateCourseMeetings(course);
  const summary = computeAttendanceSummary(course, [
    { ...generated[0], status: "absent_unexcused" },
  ]);

  assert.equal(generated[0].countWeight, 2);
  assert.equal(summary.confirmedCount, 2);
  assert.equal(summary.remaining, 4);
});

test("meeting editor helpers preserve and serialize multiple recurring patterns", () => {
  const source = [
    { id: "mw", weekdays: ["MO", "WE"], startTime: "09:00", endTime: "09:50", countWeight: 1, userNote: "keep" },
    { id: "fr", weekdays: ["FR"], startTime: "09:00", endTime: "10:50", countWeight: 2 },
  ];
  const normalized = normalizeMeetingPatterns(source);
  const serialized = serializeMeetingPatterns(normalized);

  assert.equal(normalized.length, 2);
  assert.notEqual(normalized[0], source[0]);
  assert.notEqual(normalized[0].weekdays, source[0].weekdays);
  assert.equal(normalized[0].userNote, "keep");
  assert.equal(meetingPatternsAreComplete(normalized), true);
  assert.deepEqual(serialized.map((pattern) => ({ id: pattern.id, days: pattern.weekdays, weight: pattern.countWeight })), [
    { id: "mw", days: ["MO", "WE"], weight: 1 },
    { id: "fr", days: ["FR"], weight: 2 },
  ]);
  assert.equal(nextMeetingPattern(normalized).id, "custom-meeting-1");
  assert.equal(meetingPatternsAreComplete([...normalized, nextMeetingPattern(normalized)]), false);
});
