import test from "node:test";
import assert from "node:assert/strict";
import {
  assignmentSubmissionStatus,
  assignmentUrgency,
  assignmentWorkStatus,
  priorityAssignments,
  sortAssignmentDeck,
  summarizeAssignmentDeck,
} from "../src/lib/assignmentDeck.js";

const assignments = [
  { id: "past", courseId: "a", title: "Past", date: "2026-08-30" },
  { id: "today", courseId: "a", title: "Today", date: "2026-09-01" },
  { id: "soon", courseId: "b", title: "Soon", date: "2026-09-04" },
  { id: "later", courseId: "b", title: "Later", date: "2026-10-01" },
  { id: "undated", courseId: "a", title: "Undated", date: null },
  { id: "aggregate", courseId: "a", title: "Aggregate", date: null, trackable: false },
];

test("assignment urgency preserves missing dates and distinguishes due windows", () => {
  assert.equal(assignmentUrgency(assignments[0], {}, "2026-09-01"), "overdue");
  assert.equal(assignmentUrgency(assignments[1], {}, "2026-09-01"), "today");
  assert.equal(assignmentUrgency(assignments[2], {}, "2026-09-01"), "upcoming");
  assert.equal(assignmentUrgency(assignments[3], {}, "2026-09-01"), "later");
  assert.equal(assignmentUrgency(assignments[4], {}, "2026-09-01"), "undated");
  assert.equal(assignmentUrgency(assignments[0], { past: true }, "2026-09-01"), "ready-to-submit");
});

test("work completion and Canvas submission are independent statuses", () => {
  const workflow = {
    byAssignment: {
      past: { workStatus: "completed", submissionStatus: "not-submitted" },
      today: { workStatus: "in-progress", submissionStatus: "submitted" },
      soon: { workStatus: "not-started", submissionStatus: "missed" },
    },
  };
  assert.equal(assignmentWorkStatus(assignments[0], {}, workflow), "completed");
  assert.equal(assignmentSubmissionStatus(assignments[0], workflow), "not-submitted");
  assert.equal(assignmentUrgency(assignments[0], {}, "2026-09-01", workflow), "ready-to-submit");
  assert.equal(assignmentWorkStatus(assignments[1], {}, workflow), "in-progress");
  assert.equal(assignmentSubmissionStatus(assignments[1], workflow), "submitted");
  assert.equal(assignmentSubmissionStatus(assignments[3], workflow), "not-marked");
  assert.equal(assignmentSubmissionStatus(assignments[2], workflow), "missed");
  assert.equal(assignmentUrgency(assignments[2], {}, "2026-09-01", workflow), "missed");
});

test("assignment deck summary excludes aggregate non-trackable records", () => {
  assert.deepEqual(summarizeAssignmentDeck(assignments, { past: true }, "2026-09-01"), {
    total: 5,
    completed: 1,
    submitted: 0,
    missed: 0,
    overdue: 0,
    dueToday: 1,
    dueSoon: 1,
    undated: 1,
  });
});

test("priority deck orders urgent work and does not imply that later work is due now", () => {
  assert.deepEqual(
    priorityAssignments(assignments, {}, "2026-09-01").map((assignment) => assignment.id),
    ["past", "today", "soon", "undated"],
  );
  assert.deepEqual(
    sortAssignmentDeck(assignments.slice(0, 5), { past: true }, "2026-09-01").map((assignment) => assignment.id),
    ["past", "today", "soon", "later", "undated"],
  );
});

test("completed work remains in the priority queue until Canvas submission is marked", () => {
  const workflow = { byAssignment: { past: { workStatus: "completed", submissionStatus: "submitted" } } };
  assert.equal(assignmentUrgency(assignments[0], {}, "2026-09-01", workflow), "completed");
  assert.equal(priorityAssignments(assignments, {}, "2026-09-01", workflow).some((item) => item.id === "past"), false);
  assert.equal(priorityAssignments(assignments, { past: true }, "2026-09-01").some((item) => item.id === "past"), true);
});

test("missed Canvas status is independent of work completion and leads the review queue", () => {
  const workflow = { byAssignment: { later: { workStatus: "completed", submissionStatus: "missed" } } };
  assert.equal(assignmentWorkStatus(assignments[3], {}, workflow), "completed");
  assert.equal(assignmentSubmissionStatus(assignments[3], workflow), "missed");
  assert.equal(assignmentUrgency(assignments[3], {}, "2026-09-01", workflow), "missed");
  assert.equal(priorityAssignments(assignments, {}, "2026-09-01", workflow)[0].id, "later");
  assert.equal(summarizeAssignmentDeck(assignments, {}, "2026-09-01", workflow).missed, 1);
});
