import test from "node:test";
import assert from "node:assert/strict";

import {
  ASSIGNMENTS,
  CANVAS_ASSIGNMENT_AUDIT,
  CANVAS_FILE_AUDIT,
  CANVAS_SOURCES,
  COURSES,
  SCHEDULE_EVENTS,
  SOURCE_NOTES,
  SOURCE_REFS,
} from "../src/data/semesterData.js";
import { DEFAULT_DASHBOARD_STATE, normalizeDashboardState } from "../src/hooks/useDashboardState.js";
import {
  DEFAULT_SEMESTER_STATE,
  normalizeSemesterState,
  privateSemesterFromImport,
  semesterHasBoardData,
} from "../src/lib/semesterState.js";

const privateSemester = {
  schemaVersion: 1,
  term: {
    id: "term-private",
    label: "Private term",
    classesBegin: { date: "2026-08-20" },
    classesEnd: { date: "2026-12-02" },
  },
  courses: [{
    id: "course-private",
    code: "COURSE 100",
    title: "Private Course",
    meetings: [],
  }],
  assignments: [{
    id: "assignment-private",
    courseId: "course-private",
    title: "Private Assignment",
    date: null,
  }],
  scheduleEvents: [],
  sourceRefs: { "course:syllabus": "Private syllabus" },
  sourceNotes: [],
  canvasSources: {},
  canvasAudit: null,
};

test("the public semester seed contains no account course or Canvas records", () => {
  assert.deepEqual(COURSES, []);
  assert.deepEqual(ASSIGNMENTS, []);
  assert.deepEqual(SCHEDULE_EVENTS, []);
  assert.deepEqual(SOURCE_REFS, {});
  assert.deepEqual(SOURCE_NOTES, []);
  assert.deepEqual(CANVAS_SOURCES, {});
  assert.deepEqual(CANVAS_ASSIGNMENT_AUDIT, []);
  assert.deepEqual(CANVAS_FILE_AUDIT, []);
});

test("private semester imports preserve valid account records", () => {
  const normalized = privateSemesterFromImport({
    kind: "semester-board-private-semester",
    schemaVersion: 1,
    semester: privateSemester,
  });
  assert.equal(normalized.courses[0].title, "Private Course");
  assert.equal(normalized.assignments[0].courseId, "course-private");
  assert.equal(semesterHasBoardData(normalized), true);
});

test("private semester normalization rejects foreign assignments and unsafe keys", () => {
  const normalized = normalizeSemesterState({
    ...privateSemester,
    assignments: [
      ...privateSemester.assignments,
      { id: "foreign-assignment", courseId: "missing-course", title: "Foreign" },
    ],
    sourceRefs: {
      safe: "kept",
      __proto__: "blocked",
    },
  });
  assert.deepEqual(normalized.assignments.map((assignment) => assignment.id), ["assignment-private"]);
  assert.equal(Object.hasOwn(normalized.sourceRefs, "safe"), true);
  assert.equal(Object.hasOwn(normalized.sourceRefs, "__proto__"), false);
});

test("private semester imports reject unsupported packages and invalid term dates", () => {
  assert.throws(() => privateSemesterFromImport({
    kind: "semester-board-private-semester",
    schemaVersion: 2,
    semester: privateSemester,
  }), /unsupported schema version/u);
  assert.throws(() => normalizeSemesterState({
    ...privateSemester,
    term: { classesBegin: { date: "not-a-date" }, classesEnd: { date: "2026-12-02" } },
  }), /invalid term date range/u);
});

test("version 1 dashboard rows migrate without injecting public semester data", () => {
  const migrated = normalizeDashboardState({
    schemaVersion: 1,
    completedAssignments: { old: true },
  });
  assert.equal(migrated.schemaVersion, DEFAULT_DASHBOARD_STATE.schemaVersion);
  assert.equal(migrated.completedAssignments.old, true);
  assert.deepEqual(migrated.semester, DEFAULT_SEMESTER_STATE);
  assert.equal(semesterHasBoardData(migrated.semester), false);
});

test("dashboard normalization keeps a private semester inside the synced payload", () => {
  const normalized = normalizeDashboardState({
    ...DEFAULT_DASHBOARD_STATE,
    semester: privateSemester,
  });
  assert.equal(normalized.semester.courses.length, 1);
  assert.equal(normalized.semester.assignments.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(normalized)) < 1_000_000);
});
