import { CAMPUS_TIME_ZONE } from "./format.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateKeyMillis(dateKey, label) {
  if (!ISO_DATE.test(String(dateKey ?? ""))) {
    throw new TypeError(`${label} must be an ISO date (YYYY-MM-DD)`);
  }

  const [year, month, day] = dateKey.split("-").map(Number);
  const value = Date.UTC(year, month - 1, day);
  if (new Date(value).toISOString().slice(0, 10) !== dateKey) {
    throw new RangeError(`${label} must be a valid calendar date`);
  }
  return value;
}

function zonedWallClockParts(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError("date must be a valid Date");
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function zonedWallClockMillis(date, timeZone) {
  const parts = zonedWallClockParts(date, timeZone);
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

function dateKeyFromParts(parts) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function nextDateKey(dateKey) {
  return new Date(dateKeyMillis(dateKey, "date") + DAY_MS).toISOString().slice(0, 10);
}

function zonedMidnightEpoch(dateKey, timeZone) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const targetWallClock = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = targetWallClock;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = zonedWallClockMillis(new Date(guess), timeZone);
    const correction = targetWallClock - observed;
    guess += correction;
    if (correction === 0) break;
  }
  return guess;
}

export function campusDayPosition(date, timeZone = CAMPUS_TIME_ZONE) {
  const parts = zonedWallClockParts(date, timeZone);
  const dateKey = dateKeyFromParts(parts);
  const start = zonedMidnightEpoch(dateKey, timeZone);
  const end = zonedMidnightEpoch(nextDateKey(dateKey), timeZone);
  const fraction = Math.min(1, Math.max(0, (date.getTime() - start) / (end - start)));
  return { dateKey, fraction, dayLengthMs: end - start };
}

export function campusDayFraction(date, timeZone = CAMPUS_TIME_ZONE) {
  return campusDayPosition(date, timeZone).fraction;
}

/**
 * Returns continuous progress through an inclusive semester date range in the
 * campus wall clock. Null means the current time is outside that range.
 */
export function currentSemesterProgress(
  date,
  startDate,
  endDate,
  timeZone = CAMPUS_TIME_ZONE,
) {
  const start = dateKeyMillis(startDate, "startDate");
  const end = dateKeyMillis(endDate, "endDate");
  if (end < start) throw new RangeError("endDate must not be before startDate");

  const endExclusive = end + DAY_MS;
  const current = zonedWallClockMillis(date, timeZone);
  if (current < start || current >= endExclusive) return null;
  return (current - start) / (endExclusive - start);
}
