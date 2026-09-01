import test from "node:test";
import assert from "node:assert/strict";

import { computeAttendanceSummary, getExcuseDeadline, summarizeWeek } from "../src/lib/attendance.js";

const entry = (status, extra = {}) => ({ status, ...extra });

test("meeting thresholds count resolved misses and forecast pending risk", () => {
  const course = {
    id: "course-threshold",
    attendancePolicy: {
      model: "hard_threshold",
      countUnit: "meeting",
      counters: [
        { label: "Meetings before deduction", trigger: 2 },
        { label: "Meetings before failure", trigger: 3 },
      ],
    },
  };
  const summary = computeAttendanceSummary(course, [
    entry("absent_excused"), entry("absent_unexcused"), entry("absent_pending"), entry("present"),
  ]);
  assert.equal(summary.confirmedCount, 2);
  assert.equal(summary.pendingRiskCount, 3);
  assert.equal(summary.counters[0].confirmedTriggered, true);
  assert.equal(summary.counters[1].pendingRiskTriggered, true);
});

test("period thresholds use weights and keep pending separate", () => {
  const course = {
    id: "course-periods",
    attendancePolicy: { model: "hard_threshold", countUnit: "period", allowedBeforeFailure: 6, failureTrigger: 7 },
  };
  const summary = computeAttendanceSummary(course, [
    entry("absent_unexcused", { countWeight: 2 }),
    entry("absent_unexcused"),
    entry("absent_excused", { countWeight: 2 }),
    entry("absent_pending", { countWeight: 2 }),
  ]);
  assert.equal(summary.confirmedCount, 3);
  assert.equal(summary.pendingRiskCount, 5);
  assert.equal(summary.remaining, 3);
  assert.equal(summary.pendingRiskRemaining, 1);
});

test("no-penalty allowances never invent an unstated later consequence", () => {
  const course = {
    id: "course-allowance",
    attendancePolicy: { model: "no_penalty_allowance", allowance: 3, consequenceAfterAllowance: "TBD" },
  };
  const summary = computeAttendanceSummary(course, [
    entry("absent_unexcused"), entry("absent_unexcused"), entry("absent_excused"), entry("absent_pending"),
  ]);
  assert.equal(summary.remaining, 1);
  assert.equal(summary.pendingRiskRemaining, 0);
  assert.equal(summary.consequenceAfterAllowance, "TBD");
});

test("unknown thresholds record absences without fabricating absences left", () => {
  const summary = computeAttendanceSummary(
    { id: "course-unknown", attendancePolicy: { model: "unknown_threshold" } },
    [entry("absent_unexcused"), entry("absent_unexcused"), entry("absent_pending")],
  );
  assert.equal(summary.confirmedCount, 2);
  assert.equal(summary.remaining, null);
  assert.equal(summary.limitKnown, false);
});

test("configured alternative-work dates apply only after an excused missed assignment", () => {
  const course = {
    id: "course-alternative-work",
    excuseRules: [{
      scope: "Alternative work after an excused missed in-class assignment",
      action: "Propose an alternative assignment.",
      deadline: "Within one week",
      certainty: "confirmed",
      note: "This is not an excuse-document deadline.",
    }],
  };
  const due = getExcuseDeadline(course, {
    status: "absent_excused", date: "2026-09-24", missedInClassAssignment: true,
  });
  assert.equal(due.date, "2026-10-01");
  assert.equal(due.kind, "alternative_work_proposal");
  const pending = getExcuseDeadline(course, {
    status: "absent_pending", date: "2026-09-24", missedInClassAssignment: true,
  });
  assert.equal(pending.date, null);
});

test("source rules preserve unknown numeric excuse deadlines", () => {
  const deadline = getExcuseDeadline({
    id: "course-documentation",
    excuseRules: [{
      scope: "Emergency or illness",
      action: "Contact the instructor; documentation may be requested.",
      deadline: null,
      certainty: "tbd",
    }],
  }, { status: "absent_pending", date: "2026-09-01", reason: "illness" });
  assert.equal(deadline.date, null);
  assert.equal(deadline.exactDeadlineKnown, false);
  assert.match(deadline.label, /deadline not stated/i);
});

test("summarizeWeek reports checked versus eligible check-ins", () => {
  const summary = summarizeWeek(
    { id: "w1", startDate: "2026-08-17", endDate: "2026-08-23" },
    [
      { date: "2026-08-20", status: "present" },
      { date: "2026-08-21", status: "late" },
      { date: "2026-08-22", status: "absent_pending" },
      { date: "2026-08-23", status: "not_checked" },
      { date: "2026-08-23", status: "cancelled" },
    ],
  );
  assert.equal(summary.eligibleCount, 4);
  assert.equal(summary.checkedCount, 3);
  assert.equal(summary.completionRatio, 0.75);
});
