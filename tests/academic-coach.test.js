import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAcademicCoachPlan,
  daysFromDate,
  isExamEvent,
  studyCoachQuizUrl,
} from "../src/lib/academicCoach.js";

const courses = [
  { id: "course-a", code: "AAA 1000", title: "Course A" },
  { id: "course-b", code: "BBB 2000", title: "Course B" },
];

test("academic coach builds two-week, meeting, weekly, and exam runways without inventing dates", () => {
  const plan = buildAcademicCoachPlan({
    assignments: [
      { id: "soon", courseId: "course-a", date: "2026-09-10", title: "Paper", kind: "paper" },
      { id: "exam", courseId: "course-b", date: "2026-09-20", title: "Midterm Assessment", kind: "assessment" },
      { id: "later", courseId: "course-a", date: "2026-09-30", title: "Later work", kind: "assignment" },
      { id: "unknown", courseId: "course-a", date: null, title: "Unknown", kind: "assignment" },
    ],
    courses,
    meetings: [
      { id: "old-a", courseId: "course-a", date: "2026-09-06" },
      { id: "recent-a", courseId: "course-a", date: "2026-09-07" },
      { id: "next-a", courseId: "course-a", date: "2026-09-08", time: "10:00 AM" },
      { id: "cancelled", courseId: "course-b", date: "2026-09-08", disabled: true },
    ],
    todayKey: "2026-09-07",
  });

  assert.deepEqual(plan.nextTwoWeeks.map((item) => item.id), ["soon", "exam"]);
  assert.deepEqual(plan.exams.map((item) => [item.id, item.daysAway]), [["exam", 13]]);
  assert.deepEqual(plan.preClass.map((item) => item.checkId), ["preclass:next-a"]);
  assert.deepEqual(plan.afterClass.map((item) => item.checkId), ["afterclass:recent-a"]);
  assert.equal(plan.weekly.length, 2);
  assert.equal(plan.weekStart, "2026-09-07");
});

test("coach date and exam helpers remain exact", () => {
  assert.equal(daysFromDate("2026-09-07", "2026-09-21"), 14);
  assert.equal(daysFromDate("2026-09-07", null), null);
  assert.equal(isExamEvent({ title: "Final Exam" }), true);
  assert.equal(isExamEvent({ title: "Final paper" }), true);
  assert.equal(isExamEvent({ title: "Weekly response" }), false);
});

test("quiz handoff carries only the requested course and source-grounded focus", () => {
  const url = new URL(studyCoachQuizUrl({ course: courses[0], focus: "Review chapter 2" }), "https://example.test");
  assert.equal(url.pathname, "/study-deck");
  assert.equal(url.searchParams.get("coach"), "1");
  assert.equal(url.searchParams.get("auto"), "1");
  assert.equal(url.searchParams.get("courseId"), "course-a");
  assert.equal(url.searchParams.get("focus"), "Review chapter 2");
  assert.equal(url.searchParams.get("mode"), "quiz");
  assert.equal(url.searchParams.get("questions"), "8");
});
