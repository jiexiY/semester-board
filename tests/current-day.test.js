import test from "node:test";
import assert from "node:assert/strict";

import { campusDayFraction, campusDayPosition, currentSemesterProgress } from "../src/lib/currentDay.js";
import { campusDateKey } from "../src/lib/format.js";

test("current semester progress moves continuously through a campus day", () => {
  const midnight = currentSemesterProgress(
    new Date("2026-08-20T04:00:00.000Z"),
    "2026-08-20",
    "2026-08-20",
  );
  const noon = currentSemesterProgress(
    new Date("2026-08-20T16:00:00.000Z"),
    "2026-08-20",
    "2026-08-20",
  );

  assert.equal(midnight, 0);
  assert.equal(noon, 0.5);
});

test("current semester progress is absent outside the inclusive term", () => {
  assert.equal(
    currentSemesterProgress(new Date("2026-08-19T16:00:00.000Z"), "2026-08-20", "2026-12-11"),
    null,
  );
  assert.equal(
    currentSemesterProgress(new Date("2026-12-12T05:00:00.000Z"), "2026-08-20", "2026-12-11"),
    null,
  );
});

test("current semester progress remains monotonic across the DST boundary", () => {
  const before = currentSemesterProgress(
    new Date("2026-10-31T16:00:00.000Z"),
    "2026-08-20",
    "2026-12-11",
  );
  const after = currentSemesterProgress(
    new Date("2026-11-01T17:00:00.000Z"),
    "2026-08-20",
    "2026-12-11",
  );

  assert.ok(after > before);
});

test("campus date rollover uses the configured local time", () => {
  assert.equal(campusDateKey(new Date("2026-08-20T03:59:00.000Z")), "2026-08-19");
  assert.equal(campusDateKey(new Date("2026-08-20T04:00:00.000Z")), "2026-08-20");
});

test("current semester progress rejects malformed or reversed ranges", () => {
  assert.throws(
    () => currentSemesterProgress(new Date(), "08/20/2026", "2026-12-11"),
    /ISO date/,
  );
  assert.throws(
    () => currentSemesterProgress(new Date(), "2026-12-11", "2026-08-20"),
    /must not be before/,
  );
});

test("campus day fraction locates the red line within the current day row", () => {
  assert.equal(campusDayFraction(new Date("2026-08-20T04:00:00.000Z")), 0);
  assert.equal(campusDayFraction(new Date("2026-08-20T16:00:00.000Z")), 0.5);
});

test("campus day position uses the real 25-hour DST fallback day", () => {
  const firstOneThirty = campusDayPosition(new Date("2026-11-01T05:30:00.000Z"));
  const secondOneThirty = campusDayPosition(new Date("2026-11-01T06:30:00.000Z"));
  const midpoint = campusDayPosition(new Date("2026-11-01T16:30:00.000Z"));

  assert.equal(firstOneThirty.dateKey, "2026-11-01");
  assert.equal(firstOneThirty.dayLengthMs, 25 * 60 * 60 * 1000);
  assert.ok(secondOneThirty.fraction > firstOneThirty.fraction);
  assert.equal(midpoint.fraction, 0.5);
});
