const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULT_TERM_TEMPLATE = Object.freeze({
  classesBegin: "2026-08-20",
  classesEnd: "2026-12-02",
  noClassDates: Object.freeze([]),
});

const WEEKDAY_TOKENS = Object.freeze(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
const WEEKDAY_ALIASES = Object.freeze({
  SU: "SU",
  SUN: "SU",
  SUNDAY: "SU",
  MO: "MO",
  MON: "MO",
  MONDAY: "MO",
  TU: "TU",
  TUE: "TU",
  TUES: "TU",
  TUESDAY: "TU",
  WE: "WE",
  WED: "WE",
  WEDNESDAY: "WE",
  TH: "TH",
  THU: "TH",
  THUR: "TH",
  THURS: "TH",
  THURSDAY: "TH",
  FR: "FR",
  FRI: "FR",
  FRIDAY: "FR",
  SA: "SA",
  SAT: "SA",
  SATURDAY: "SA",
});

function unwrapDate(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.date === "string") return value.date;
  return null;
}

function requireIsoDate(value, fieldName) {
  const date = unwrapDate(value);
  if (!date || !ISO_DATE.test(date)) {
    throw new TypeError(`${fieldName} must be an ISO date (YYYY-MM-DD)`);
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new RangeError(`${fieldName} is not a valid calendar date`);
  }
  return date;
}

function parseIsoDate(date) {
  return new Date(`${requireIsoDate(date, "date")}T00:00:00.000Z`);
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, numberOfDays) {
  const next = parseIsoDate(date);
  next.setUTCDate(next.getUTCDate() + numberOfDays);
  return toIsoDate(next);
}

function mondayOnOrBefore(date) {
  const parsed = parseIsoDate(date);
  const offset = (parsed.getUTCDay() + 6) % 7;
  return addDays(date, -offset);
}

function sundayOnOrAfter(date) {
  const parsed = parseIsoDate(date);
  return addDays(date, 6 - ((parsed.getUTCDay() + 6) % 7));
}

function weekdayToken(date) {
  return WEEKDAY_TOKENS[parseIsoDate(date).getUTCDay()];
}

function normalizeWeekday(value) {
  return WEEKDAY_ALIASES[String(value ?? "").trim().toUpperCase()] ?? null;
}

function collectIsoDates(value, target) {
  if (typeof value === "string") {
    if (ISO_DATE.test(value)) target.add(value);
    return target;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectIsoDates(item, target);
    return target;
  }
  if (value && typeof value === "object") {
    if (typeof value.date === "string" && ISO_DATE.test(value.date)) {
      target.add(value.date);
    } else {
      for (const nested of Object.values(value)) collectIsoDates(nested, target);
    }
  }
  return target;
}

function getTermDate(termConfig, key, fallback) {
  const aliases = key === "classesBegin"
    ? ["classesBegin", "classStart", "startDate", "start"]
    : ["classesEnd", "classEnd", "endDate", "end"];
  for (const alias of aliases) {
    const candidate = unwrapDate(termConfig?.[alias]);
    if (candidate) return requireIsoDate(candidate, alias);
  }
  return fallback;
}

function getPatternList(course) {
  if (Array.isArray(course?.meetings)) return course.meetings;
  if (Array.isArray(course?.meetingPatterns)) return course.meetingPatterns;
  return [];
}

function patternIsSelected(pattern, course, options, patternIndex) {
  if (!pattern.selectionGate) return true;
  if (pattern.selected === true || pattern.enabled === true || pattern.sectionSelected === true) {
    return true;
  }
  if (course?.selectedSection || course?.section) return true;
  if (
    (pattern.optionId && options?.selectedSection === pattern.optionId)
    || (pattern.optionId && options?.selectedOptionId === pattern.optionId)
    || (pattern.id && options?.selectedMeetingId === pattern.id)
  ) return true;

  const selected = options?.selectedPatternIds;
  if (selected instanceof Set) return selected.has(pattern.id ?? patternIndex);
  if (Array.isArray(selected)) return selected.includes(pattern.id ?? patternIndex);
  return false;
}

function rangeFrom(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 2) {
    return [requireIsoDate(value[0], "range start"), requireIsoDate(value[1], "range end")];
  }
  if (typeof value === "object") {
    const start = unwrapDate(value.start ?? value.startDate);
    const end = unwrapDate(value.end ?? value.endDate);
    if (start && end) {
      return [requireIsoDate(start, "range start"), requireIsoDate(end, "range end")];
    }
  }
  return null;
}

function intersectRange(baseStart, baseEnd, ranges) {
  let start = baseStart;
  let end = baseEnd;
  for (const range of ranges) {
    if (!range) continue;
    if (range[0] > start) start = range[0];
    if (range[1] < end) end = range[1];
  }
  return [start, end];
}

function stablePart(value, fallback) {
  const normalized = String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

function normalizedMeeting(course, pattern, patternIndex, date) {
  const courseId = course.id ?? stablePart(course.code, "course");
  const patternId = pattern.id ?? `${stablePart(pattern.kind, "meeting")}-${patternIndex + 1}`;
  const eventGeneration = pattern.eventGeneration ?? pattern.generation ?? "derived_from_term";
  const isExplicit = eventGeneration === "explicit_dates" || eventGeneration === "explicit";
  const status = pattern.status === "cancelled" ? "cancelled" : "not_checked";
  const displayedTime = pattern.time
    ?? ([pattern.startTime, pattern.endTime].filter(Boolean).join("–") || null);
  const timeParts = typeof displayedTime === "string"
    ? displayedTime.split(/\s*[–—]\s*/, 2)
    : [];
  const certainty = pattern.certainty
    ?? pattern.dateStatus
    ?? (isExplicit ? "provisional" : "derived");

  return {
    id: pattern.meetingId ?? `${courseId}-${date}-${stablePart(patternId, patternIndex + 1)}`,
    meetingId: pattern.meetingId ?? `${courseId}-${date}-${stablePart(patternId, patternIndex + 1)}`,
    courseId,
    date,
    weekday: weekdayToken(date),
    kind: pattern.kind ?? "class",
    time: displayedTime,
    startTime: pattern.startTime ?? timeParts[0] ?? null,
    endTime: pattern.endTime ?? timeParts[1] ?? null,
    timeStatus: pattern.timeStatus ?? pattern.timeCertainty ?? "TBD",
    timeCertainty: pattern.timeCertainty ?? pattern.timeStatus ?? "TBD",
    location: pattern.location ?? null,
    locationStatus: pattern.locationStatus ?? pattern.locationCertainty ?? "TBD",
    locationCertainty: pattern.locationCertainty ?? pattern.locationStatus ?? "TBD",
    periods: Array.isArray(pattern.periods)
      ? [...pattern.periods]
      : (Array.isArray(pattern.periodLabels) ? [...pattern.periodLabels] : []),
    periodLabels: Array.isArray(pattern.periodLabels)
      ? [...pattern.periodLabels]
      : (Array.isArray(pattern.periods) ? [...pattern.periods] : []),
    status,
    countWeight: Number.isFinite(pattern.countWeight) ? pattern.countWeight : 1,
    eligible: status !== "cancelled" && pattern.eligible !== false,
    checkInEnabled: status !== "cancelled" && pattern.checkInEnabled !== false,
    certainty,
    dateStatus: certainty,
    sourceLabel: pattern.sourceLabel
      ?? (isExplicit ? "Tentative — verify source" : "Derived from the private term calendar"),
    note: pattern.note ?? null,
    sourceRefs: Array.isArray(pattern.sourceRefs) ? [...pattern.sourceRefs] : [],
  };
}

/**
 * Builds inclusive Monday-Sunday dashboard weeks from the supplied private
 * term dates. A generic date-only template is used only by pure helper tests.
 */
export function buildTermWeeks(termConfig = {}) {
  const classesBegin = getTermDate(
    termConfig,
    "classesBegin",
    DEFAULT_TERM_TEMPLATE.classesBegin,
  );
  const classesEnd = getTermDate(
    termConfig,
    "classesEnd",
    DEFAULT_TERM_TEMPLATE.classesEnd,
  );
  const startDate = termConfig.weekStart
    ? requireIsoDate(termConfig.weekStart, "weekStart")
    : mondayOnOrBefore(classesBegin);
  const endDate = termConfig.weekEnd
    ? requireIsoDate(termConfig.weekEnd, "weekEnd")
    : sundayOnOrAfter(classesEnd);

  if (startDate > endDate) throw new RangeError("term week start must not be after term week end");

  const weeks = [];
  let cursor = startDate;
  let index = 1;
  while (cursor <= endDate) {
    const weekEnd = addDays(cursor, 6);
    weeks.push({
      id: cursor,
      index,
      label: `Week ${index}`,
      start: cursor,
      end: weekEnd,
      startDate: cursor,
      endDate: weekEnd,
    });
    cursor = addDays(cursor, 7);
    index += 1;
  }
  return weeks;
}

/**
 * Expands confirmed weekday patterns into dated check-ins. Private term
 * no-class dates, pattern exceptions, and course-specific exceptions are
 * omitted rather than presented as eligible check-ins.
 */
export function generateCourseMeetings(course, termConfig = {}, options = {}) {
  if (!course || typeof course !== "object") throw new TypeError("course is required");

  const classesBegin = getTermDate(
    termConfig,
    "classesBegin",
    DEFAULT_TERM_TEMPLATE.classesBegin,
  );
  const classesEnd = getTermDate(
    termConfig,
    "classesEnd",
    DEFAULT_TERM_TEMPLATE.classesEnd,
  );
  const courseRange = rangeFrom(course.checkInSeed?.range ?? course.meetingRange);
  const [courseStart, courseEnd] = intersectRange(classesBegin, classesEnd, [courseRange]);
  if (courseStart > courseEnd) return [];

  const noClassDates = new Set();
  collectIsoDates(DEFAULT_TERM_TEMPLATE.noClassDates, noClassDates);
  collectIsoDates(termConfig.noClassDates, noClassDates);
  collectIsoDates(termConfig.exceptions, noClassDates);
  collectIsoDates(course.noClassDates, noClassDates);
  collectIsoDates(course.exceptions, noClassDates);
  collectIsoDates(course.explicitNoClass, noClassDates);
  collectIsoDates(course.checkInSeed?.explicitNoClass, noClassDates);
  collectIsoDates(course.checkInSeed?.sharedCalendarNoClass, noClassDates);

  const generated = [];
  const patterns = getPatternList(course);
  patterns.forEach((pattern, patternIndex) => {
    if (!pattern || typeof pattern !== "object") return;
    if (
      pattern.eventGeneration === "blocked"
      || pattern.generation === "blocked"
      || pattern.blocked === true
    ) return;
    if (!patternIsSelected(pattern, course, options, patternIndex)) return;

    const patternNoClassDates = new Set(noClassDates);
    collectIsoDates(pattern.exceptions, patternNoClassDates);
    collectIsoDates(pattern.noClassDates, patternNoClassDates);

    const patternRange = rangeFrom(pattern.range ?? pattern.dateRange);
    const [start, end] = intersectRange(courseStart, courseEnd, [patternRange]);
    if (start > end) return;

    const explicitDates = new Set();
    collectIsoDates(pattern.explicitDates ?? pattern.dates, explicitDates);

    if (explicitDates.size > 0 || (pattern.date && !pattern.weekdays)) {
      if (pattern.date) collectIsoDates(pattern.date, explicitDates);
      for (const date of explicitDates) {
        if (date < start || date > end || patternNoClassDates.has(date)) continue;
        generated.push(normalizedMeeting(course, pattern, patternIndex, date));
      }
      return;
    }

    const weekdays = new Set(
      (Array.isArray(pattern.weekdays) ? pattern.weekdays : [])
        .map(normalizeWeekday)
        .filter(Boolean),
    );
    if (weekdays.size === 0) return;

    let date = start;
    while (date <= end) {
      if (weekdays.has(weekdayToken(date)) && !patternNoClassDates.has(date)) {
        generated.push(normalizedMeeting(course, pattern, patternIndex, date));
      }
      date = addDays(date, 1);
    }
  });

  return generated.sort((left, right) => (
    left.date.localeCompare(right.date)
    || String(left.startTime ?? "").localeCompare(String(right.startTime ?? ""))
    || left.id.localeCompare(right.id)
  ));
}
