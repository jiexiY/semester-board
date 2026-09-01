import test from "node:test";
import assert from "node:assert/strict";

import { computeAttendanceSummary } from "../src/lib/attendance.js";
import {
  buildAttendanceCourseRows,
  mergeCourseAttendanceEntries,
  summarizeAttendanceRows,
} from "../src/lib/attendanceRecords.js";

const course = (id, code = id) => ({ id, code });
const meeting = (id, courseId, date, extra = {}) => ({
  id,
  meetingId: id,
  courseId,
  date,
  kind: "class",
  status: "not_checked",
  eligible: true,
  checkInEnabled: true,
  ...extra,
});

test("mergeCourseAttendanceEntries maps scheduled check-ins and appends eligible manual records", () => {
  const meetings = [
    meeting("a-meeting", "course-a", "2026-08-20"),
    meeting("b-meeting", "course-b", "2026-08-20"),
  ];
  const checkins = {
    "a-meeting": {
      status: "present",
      note: "Saved scheduled note",
      courseId: "course-b",
      manualRecord: true,
    },
    "canvas-a-1": {
      manualRecord: true,
      courseId: "course-a",
      date: "2026-08-19",
      status: "absent_unexcused",
      source: "Canvas",
      note: "Imported attendance detail",
    },
    "canvas-a-disabled": {
      manualRecord: true,
      courseId: "course-a",
      status: "absent_unexcused",
      disabled: true,
    },
    "canvas-b-1": {
      manualRecord: true,
      courseId: "course-b",
      status: "absent_excused",
    },
  };

  const records = mergeCourseAttendanceEntries("course-a", meetings, checkins);

  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => ({
      id: record.id,
      courseId: record.courseId,
      status: record.status,
      manualRecord: record.manualRecord,
    })),
    [
      { id: "a-meeting", courseId: "course-a", status: "present", manualRecord: false },
      { id: "canvas-a-1", courseId: "course-a", status: "absent_unexcused", manualRecord: true },
    ],
  );
  assert.equal(records[0].note, "Saved scheduled note");
  assert.equal(records[1].source, "Canvas");
  assert.equal(records[1].note, "Imported attendance detail");
});

test("buildAttendanceCourseRows counts only eligible scheduled meetings through the requested date", () => {
  const courses = [course("course-a")];
  const meetings = [
    meeting("present", "course-a", "2026-08-20"),
    meeting("late", "course-a", "2026-08-21"),
    meeting("unchecked", "course-a", "2026-08-22"),
    meeting("future", "course-a", "2026-08-24"),
    meeting("cancelled", "course-a", "2026-08-20", { status: "cancelled" }),
    meeting("disabled", "course-a", "2026-08-20", { disabled: true }),
    meeting("not-enabled", "course-a", "2026-08-20", { checkInEnabled: false }),
    meeting("no-class", "course-a", "2026-08-20", { kind: "no-class" }),
  ];
  const checkins = {
    present: { status: "present" },
    late: { status: "late" },
    future: { status: "absent_unexcused" },
    disabled: { status: "present" },
    "not-enabled": { status: "present" },
  };

  const [row] = buildAttendanceCourseRows(courses, meetings, checkins, "2026-08-22");

  assert.deepEqual(row.scheduledRecords.map((record) => record.id), ["present", "late", "unchecked"]);
  assert.equal(row.manualRecords.length, 0);
  assert.equal(row.records.length, 3);
  assert.deepEqual(row.counts, {
    present: 1,
    late: 1,
    absent_excused: 0,
    absent_unexcused: 0,
    absent_pending: 0,
    not_checked: 1,
    recorded: 2,
  });
});

test("manual records are course-isolated, may be undated, and preserve course order", () => {
  const courses = [course("course-b", "B"), course("course-a", "A")];
  const checkins = {
    "manual-a": {
      manualRecord: true,
      courseId: "course-a",
      status: "absent_excused",
      source: "Canvas attendance",
    },
    "manual-b-undated": {
      manualRecord: true,
      courseId: "course-b",
      status: "absent_unexcused",
      note: "Canvas did not expose a meeting date",
    },
    "manual-other": {
      manualRecord: true,
      courseId: "course-c",
      status: "present",
    },
  };

  const rows = buildAttendanceCourseRows(courses, [], checkins, "2026-08-25");

  assert.deepEqual(rows.map((row) => row.courseId), ["course-b", "course-a"]);
  assert.deepEqual(rows.map((row) => row.manualRecords.map((record) => record.id)), [
    ["manual-b-undated"],
    ["manual-a"],
  ]);
  assert.equal(rows[0].manualRecords[0].date, undefined);
  assert.equal(rows[0].counts.absent_unexcused, 1);
  assert.equal(rows[1].counts.absent_excused, 1);
});

test("replacing a saved status moves one record between buckets without duplication", () => {
  const courses = [course("course-a")];
  const meetings = [meeting("meeting-1", "course-a", "2026-08-20")];
  const absentRows = buildAttendanceCourseRows(
    courses,
    meetings,
    { "meeting-1": { status: "absent_unexcused" } },
    "2026-08-25",
  );
  const presentRows = buildAttendanceCourseRows(
    courses,
    meetings,
    { "meeting-1": { status: "present" } },
    "2026-08-25",
  );

  assert.equal(absentRows[0].records.length, 1);
  assert.equal(absentRows[0].counts.absent_unexcused, 1);
  assert.equal(presentRows[0].records.length, 1);
  assert.equal(presentRows[0].counts.absent_unexcused, 0);
  assert.equal(presentRows[0].counts.present, 1);
});

test("raw attendance counts stay separate from period-weighted policy risk", () => {
  const enc = {
    id: "course-gamma",
    code: "CHE 1200",
    attendancePolicy: {
      model: "hard_threshold",
      countUnit: "period",
      allowedBeforeFailure: 6,
      failureTrigger: 7,
    },
  };
  const meetings = [meeting(
    "enc-double-period",
    enc.id,
    "2026-08-24",
    { countWeight: 2 },
  )];
  const checkins = { "enc-double-period": { status: "absent_unexcused" } };

  const [row] = buildAttendanceCourseRows([enc], meetings, checkins, "2026-08-25");
  const policy = computeAttendanceSummary(enc, row.records);

  assert.equal(row.records.length, 1);
  assert.equal(row.counts.absent_unexcused, 1);
  assert.equal(policy.confirmedCount, 2);
  assert.equal(policy.remaining, 4);
});

test("summarizeAttendanceRows aggregates every exact status count", () => {
  const courses = [course("course-a"), course("course-b")];
  const meetings = [
    meeting("a-present", "course-a", "2026-08-20"),
    meeting("a-pending", "course-a", "2026-08-21"),
    meeting("b-late", "course-b", "2026-08-20"),
    meeting("b-unchecked", "course-b", "2026-08-21"),
  ];
  const checkins = {
    "a-present": { status: "present" },
    "a-pending": { status: "absent_pending" },
    "b-late": { status: "late" },
    "b-excused-manual": {
      manualRecord: true,
      courseId: "course-b",
      status: "absent_excused",
    },
    "a-unexcused-manual": {
      manualRecord: true,
      courseId: "course-a",
      status: "absent_unexcused",
      date: "2026-08-19",
    },
  };

  const rows = buildAttendanceCourseRows(courses, meetings, checkins, "2026-08-25");

  const summary = summarizeAttendanceRows(rows);

  assert.equal(summary.courseCount, 2);
  assert.deepEqual(summary.scheduledRecords.map((record) => record.id), [
    "a-present",
    "a-pending",
    "b-late",
    "b-unchecked",
  ]);
  assert.deepEqual(summary.manualRecords.map((record) => record.id), [
    "a-unexcused-manual",
    "b-excused-manual",
  ]);
  assert.deepEqual(summary.records.map((record) => record.id), [
    "a-present",
    "a-pending",
    "a-unexcused-manual",
    "b-late",
    "b-unchecked",
    "b-excused-manual",
  ]);
  assert.deepEqual(summary.counts, {
    present: 1,
    late: 1,
    absent_excused: 1,
    absent_unexcused: 1,
    absent_pending: 1,
    not_checked: 1,
    recorded: 5,
  });
});
