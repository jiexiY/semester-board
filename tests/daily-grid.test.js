import test from "node:test";
import assert from "node:assert/strict";

import { buildDailyCourseGrid, buildDailyCourseRows } from "../src/lib/dailyGrid.js";

function lane(courseId, dated = []) {
  return { course: { id: courseId }, timeline: { dated, undated: [] } };
}

test("daily grid creates every calendar day with one cell per course", () => {
  const rows = buildDailyCourseRows([
    lane("course-a", [{ id: "a1", date: "2026-08-20", time: "9:00 AM", title: "Class" }]),
    lane("course-b", [{ id: "b1", date: "2026-08-22", time: "5:00 PM", title: "Paper" }]),
  ], "2026-08-20", "2026-08-22");

  assert.deepEqual(rows.map((row) => row.date), ["2026-08-20", "2026-08-21", "2026-08-22"]);
  assert.ok(rows.every((row) => row.cells.length === 2));
  assert.equal(rows[0].cells[0].events[0].id, "a1");
  assert.deepEqual(rows[0].cells[1].events, []);
  assert.equal(rows[1].empty, true);
  assert.equal(rows[2].cells[1].events[0].id, "b1");
});

test("a 114-day term renders four parallel course cells", () => {
  const lanes = [lane("sya"), lane("ast"), lane("enc"), lane("laa")];
  const rows = buildDailyCourseRows(lanes, "2026-08-20", "2026-12-11");

  assert.equal(rows.length, 114);
  assert.equal(rows[0].date, "2026-08-20");
  assert.equal(rows.at(-1).date, "2026-12-11");
  assert.ok(rows.every((row) => row.cells.length === 4));
  assert.ok(rows.every((row) => row.cells.every((cell, index) => cell.courseId === lanes[index].course.id)));
});

test("daily grid keeps multiple same-day events in one course cell", () => {
  const rows = buildDailyCourseRows([
    lane("course-a", [
      { id: "late", date: "2026-09-01", time: "11:59 PM", title: "Assignment" },
      { id: "early", date: "2026-09-01", time: "8:30 AM", title: "Class" },
    ]),
    lane("course-b"),
  ], "2026-09-01", "2026-09-01");

  assert.deepEqual(rows[0].cells[0].events.map((event) => event.id), ["early", "late"]);
  assert.equal(rows[0].cells[1].events.length, 0);
  assert.equal(rows[0].eventCount, 2);
});

test("daily grid marks month boundaries and separates dated events outside official bounds", () => {
  const grid = buildDailyCourseGrid([
    lane("course-a", [{ id: "final", date: "2026-12-12", title: "Final" }]),
  ], "2026-11-30", "2026-12-11");

  assert.equal(grid.rows[0].date, "2026-11-30");
  assert.equal(grid.rows.at(-1).date, "2026-12-11");
  assert.equal(grid.rows[0].monthStart, true);
  assert.equal(grid.rows.find((row) => row.date === "2026-12-01").monthStart, true);
  assert.equal(grid.outsideCells[0].events[0].id, "final");
});

test("daily grid rejects a reversed range", () => {
  assert.throws(
    () => buildDailyCourseRows([], "2026-12-11", "2026-08-20"),
    /must not be before/,
  );
  assert.throws(
    () => buildDailyCourseGrid([lane("duplicate"), lane("duplicate")], "2026-08-20", "2026-08-21"),
    /must be unique/,
  );
});
