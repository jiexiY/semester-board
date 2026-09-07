import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildManualSemester, formatManualClock } from "../src/lib/manualSemester.js";

const component = await readFile(new URL("../src/components/SemesterSetup.jsx", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const chatApi = await readFile(new URL("../api/chat.post.js", import.meta.url), "utf8");
const courseLane = await readFile(new URL("../src/components/CourseLane.jsx", import.meta.url), "utf8");

test("blank semester setup is a guided form with backup import as a secondary path", () => {
  assert.match(component, /Set up your semester/);
  assert.match(component, /Course code/);
  assert.match(component, /Add another course/);
  assert.match(component, /Add assignment or exam/);
  assert.match(component, /Create semester board/);
  assert.match(component, /Import an existing JSON backup/);
  assert.match(component, /This setup makes no AI request\./);
  assert.match(app, /onSaveSemester=\{\(nextSemester\) =>/);
  assert.match(app, /dashboard\.saveSemester\(nextSemester\)/);
  assert.doesNotMatch(component, /Generate semester draft|grantConsent|useSemesterGenerator/);
  assert.doesNotMatch(chatApi, /semester-generation|SEMESTER_GENERATION_INSTRUCTIONS/);
  assert.match(courseLane, /sourceStatus === "user-entered"\) return "Added by you"/);
});

test("manual semester setup creates normalized courses, schedules, office hours, and work", () => {
  const semester = buildManualSemester({
    label: "Fall 2026",
    startDate: "2026-08-24",
    endDate: "2026-12-04",
    courses: [{
      key: "course-ui-1",
      code: "PSY 2012",
      title: "General Psychology",
      weekdays: ["MO", "WE"],
      startTime: "09:30",
      endTime: "10:20",
      location: "Room 101",
      instructor: "Dr. Rivera",
      officeHours: "Tue 2–4 PM",
      officeLocation: "Office 12",
    }],
    assignments: [{
      key: "work-ui-1",
      courseKey: "course-ui-1",
      title: "Research summary",
      kind: "paper",
      date: "2026-09-12",
      time: "23:59",
    }],
  });
  assert.equal(semester.term.label, "Fall 2026");
  assert.equal(semester.courses[0].meetings[0].time, "9:30 AM–10:20 AM");
  assert.equal(semester.courses[0].officeHours.entries[0].status, "user");
  assert.equal(semester.assignments[0].courseId, semester.courses[0].id);
  assert.equal(semester.assignments[0].time, "11:59 PM");
});

test("manual semester setup leaves optional facts blank instead of inventing them", () => {
  const semester = buildManualSemester({
    label: "Spring term",
    startDate: "2027-01-11",
    endDate: "2027-04-28",
    courses: [{ key: "only", code: "ART 1000", title: "Foundations", weekdays: [] }],
    assignments: [],
  });
  assert.equal(semester.courses[0].meetings[0].generation, "blocked");
  assert.equal(semester.courses[0].officeHours.entries.length, 0);
  assert.equal(semester.assignments.length, 0);
  assert.equal(formatManualClock("00:05"), "12:05 AM");
  assert.equal(formatManualClock("not-time"), null);
});

test("manual semester setup rejects incomplete required fields", () => {
  assert.throws(() => buildManualSemester({
    label: "Fall",
    startDate: "2026-12-01",
    endDate: "2026-08-01",
    courses: [{ key: "only", code: "ART", title: "Art" }],
  }), /valid first and last class date/u);
  assert.throws(() => buildManualSemester({
    label: "Fall",
    startDate: "2026-08-01",
    endDate: "2026-12-01",
    courses: [{ key: "only", code: "", title: "Art" }],
  }), /course 1/u);
});
