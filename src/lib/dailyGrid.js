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

function nextDateKey(dateKey) {
  const next = new Date(dateKeyMillis(dateKey, "date") + 24 * 60 * 60 * 1000);
  return next.toISOString().slice(0, 10);
}

function clockMinutes(value) {
  const match = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
  if (!match) return Number.MAX_SAFE_INTEGER;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = match[3]?.toUpperCase();
  if (period === "AM" && hour === 12) hour = 0;
  if (period === "PM" && hour !== 12) hour += 12;
  return hour * 60 + minute;
}

function compareEvents(left, right) {
  return clockMinutes(left?.time) - clockMinutes(right?.time)
    || String(left?.title ?? "").localeCompare(String(right?.title ?? ""))
    || String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

/**
 * Creates one shared row for every calendar day. Each row always has one cell
 * per course, so an event in one course never pulls the other course columns
 * out of alignment.
 */
export function buildDailyCourseGrid(lanes = [], startDate, endDate) {
  const courseIds = lanes.map((lane) => lane.course.id);
  if (new Set(courseIds).size !== courseIds.length) {
    throw new RangeError("course IDs must be unique");
  }
  const eventsByCourse = new Map(courseIds.map((courseId) => [courseId, new Map()]));

  for (const lane of lanes) {
    const courseEvents = eventsByCourse.get(lane.course.id);
    for (const event of lane.timeline?.dated || []) {
      if (!ISO_DATE.test(String(event?.date ?? ""))) continue;
      const bucket = courseEvents.get(event.date) || [];
      bucket.push(event);
      courseEvents.set(event.date, bucket);
    }
  }

  const sourceStart = dateKeyMillis(startDate, "startDate");
  const sourceEnd = dateKeyMillis(endDate, "endDate");
  if (sourceEnd < sourceStart) throw new RangeError("endDate must not be before startDate");

  const rows = [];
  let cursor = startDate;
  let previousMonth = null;

  while (cursor <= endDate) {
    const monthKey = cursor.slice(0, 7);
    const cells = courseIds.map((courseId) => ({
      courseId,
      events: [...(eventsByCourse.get(courseId).get(cursor) || [])].sort(compareEvents),
    }));
    const eventCount = cells.reduce((total, cell) => total + cell.events.length, 0);
    rows.push({
      date: cursor,
      monthKey,
      monthStart: monthKey !== previousMonth,
      cells,
      eventCount,
      empty: eventCount === 0,
    });
    previousMonth = monthKey;
    cursor = nextDateKey(cursor);
  }

  const outsideCells = courseIds.map((courseId) => ({
    courseId,
    events: [...eventsByCourse.get(courseId).entries()]
      .filter(([date]) => date < startDate || date > endDate)
      .flatMap(([, events]) => events)
      .sort((left, right) => left.date.localeCompare(right.date) || compareEvents(left, right)),
  }));

  return { rows, outsideCells };
}

export function buildDailyCourseRows(lanes = [], startDate, endDate) {
  return buildDailyCourseGrid(lanes, startDate, endDate).rows;
}
