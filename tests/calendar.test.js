import test from "node:test";
import assert from "node:assert/strict";

import { buildTermWeeks, generateCourseMeetings } from "../src/lib/calendar.js";

const TERM = {
  classesBegin: { date: "2026-08-20" },
  classesEnd: { date: "2026-09-04" },
  noClassDates: [{ date: "2026-09-01", label: "Private holiday" }],
};

test("buildTermWeeks creates inclusive Monday-Sunday ranges", () => {
  const weeks = buildTermWeeks(TERM);
  assert.deepEqual(weeks.map(({ index, start, end }) => ({ index, start, end })), [
    { index: 1, start: "2026-08-17", end: "2026-08-23" },
    { index: 2, start: "2026-08-24", end: "2026-08-30" },
    { index: 3, start: "2026-08-31", end: "2026-09-06" },
  ]);
});

test("recurring meetings use supplied private term exceptions", () => {
  const course = {
    id: "course-one",
    meetings: [{
      id: "course-one-tu-th",
      kind: "class",
      weekdays: ["TU", "TH"],
      time: "10:00 AM–11:00 AM",
      location: "Room 1",
      generation: "derived_from_term",
      range: { startDate: "2026-08-20", endDate: "2026-09-04" },
      exceptions: [],
    }],
  };
  const meetings = generateCourseMeetings(course, TERM);
  assert.deepEqual(meetings.map((meeting) => meeting.date), [
    "2026-08-20", "2026-08-25", "2026-08-27", "2026-09-03",
  ]);
  assert.ok(meetings.every((meeting) => meeting.location === "Room 1"));
});

test("blocked and unselected gated patterns do not create check-ins", () => {
  assert.deepEqual(generateCourseMeetings({
    id: "blocked-course",
    meetings: [{ id: "blocked", kind: "class", generation: "blocked" }],
  }, TERM), []);

  const selectable = {
    id: "selectable-course",
    meetings: [{
      id: "section-a",
      optionId: "section-a",
      selectionGate: "Choose a section",
      weekdays: ["TH"],
      generation: "derived_from_term",
      range: { startDate: "2026-08-20", endDate: "2026-08-28" },
    }],
  };
  assert.deepEqual(generateCourseMeetings(selectable, TERM), []);
  assert.equal(generateCourseMeetings(selectable, TERM, { selectedSection: "section-a" }).length, 2);
});

test("period metadata and weights survive expansion", () => {
  const meetings = generateCourseMeetings({
    id: "weighted-course",
    meetings: [{
      id: "double-period",
      weekdays: ["TH"],
      periods: ["2", "3"],
      countWeight: 2,
      startTime: "8:30 AM",
      endTime: "10:25 AM",
      generation: "derived_from_term",
      range: { startDate: "2026-08-20", endDate: "2026-08-20" },
    }],
  }, TERM);
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].countWeight, 2);
  assert.deepEqual(meetings[0].periods, ["2", "3"]);
});
