function text(value) {
  return String(value ?? "").trim();
}

function compareText(left, right) {
  return text(left).localeCompare(text(right), "en", {
    numeric: true,
    sensitivity: "base",
  });
}

function parseTimeMinutes(value) {
  const first = text(value).split(/\s*[–—-]\s*/, 1)[0];
  const match = first.match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!match) return Number.POSITIVE_INFINITY;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();
  if (minute > 59 || hour > (meridiem ? 12 : 23)) return Number.POSITIVE_INFINITY;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (meridiem === "PM" && hour !== 12) hour += 12;
  return hour * 60 + minute;
}

function compareDated(left, right) {
  const dateOrder = left.date.localeCompare(right.date);
  if (dateOrder) return dateOrder;

  const leftMinutes = parseTimeMinutes(left.time);
  const rightMinutes = parseTimeMinutes(right.time);
  if (leftMinutes !== rightMinutes) {
    if (Number.isFinite(leftMinutes) && Number.isFinite(rightMinutes)) {
      return leftMinutes - rightMinutes;
    }
    if (Number.isFinite(leftMinutes)) return -1;
    if (Number.isFinite(rightMinutes)) return 1;
  }

  const rawTimeOrder = compareText(left.time, right.time);
  if (rawTimeOrder) return rawTimeOrder;
  return compareText(left.title, right.title);
}

function validDateKey(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(dateKey))) return false;
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === dateKey;
}

export const TIMELINE_EVENT_TYPES = Object.freeze([
  "class",
  "assignment",
  "exam",
  "lab",
  "paper",
  "project",
  "quiz",
]);

function assignmentEventType(assignment) {
  const kind = text(assignment?.kind).toLowerCase();
  const title = text(assignment?.title).toLowerCase();
  if (kind === "exam") return "exam";
  if (kind === "quiz") return "quiz";
  if (kind === "lab") return "lab";
  if (kind === "paper") return "paper";
  if (kind === "presentation") return "project";
  if (/\bpaper\b/.test(title)) return "paper";
  if (/\bproject\b|\bpresentation\b|\bproposal\b|research report/.test(title)) {
    return "project";
  }
  return "assignment";
}

/**
 * Normalizes an event into one of the seven visual timeline categories.
 * Callers can pass sourceType explicitly; otherwise meeting-shaped records
 * are recognized by their meeting fields and class-like kinds.
 */
export function classifyTimelineEvent(event, sourceType = null) {
  const kind = text(event?.kind).toLowerCase();
  const looksLikeMeeting = sourceType === "meeting"
    || event?.meetingId != null
    || event?.checkInEnabled != null
    || ["class", "lecture", "discussion", "no-class"].includes(kind);
  return looksLikeMeeting ? "class" : assignmentEventType(event);
}

export function monthLabel(dateKey) {
  if (!validDateKey(dateKey)) return "Date not stated";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dateKey}T12:00:00.000Z`));
}

/**
 * Splits one course's assignment stream without inventing placement for
 * undated source items. Input assignment objects are never mutated.
 */
export function buildCourseTimeline(assignments = []) {
  const source = Array.isArray(assignments) ? assignments : [];
  const dated = source
    .filter((assignment) => validDateKey(assignment?.date))
    .sort(compareDated);
  const undated = source
    .filter((assignment) => !validDateKey(assignment?.date))
    .sort((left, right) => (
      compareText(left?.kind, right?.kind) || compareText(left?.title, right?.title)
    ));

  const monthGroups = [];
  for (const assignment of dated) {
    const key = assignment.date.slice(0, 7);
    let group = monthGroups.at(-1);
    if (!group || group.key !== key) {
      group = { key, label: monthLabel(assignment.date), items: [] };
      monthGroups.push(group);
    }
    group.items.push(assignment);
  }

  return { dated, undated, monthGroups };
}

function meetingTime(meeting) {
  if (meeting?.time) return meeting.time;
  const parts = [meeting?.startTime, meeting?.endTime].filter(Boolean);
  return parts.length ? parts.join("–") : null;
}

function meetingTitle(meeting) {
  if (meeting?.label) return meeting.label;
  if (meeting?.status === "cancelled" || meeting?.kind === "no-class") return "No class";
  const kind = text(meeting?.kind || "class");
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function normalizedAssignmentEvent(assignment) {
  return {
    id: `assignment:${assignment?.id}`,
    source: "assignment",
    category: classifyTimelineEvent(assignment, "assignment"),
    date: assignment?.date ?? null,
    time: assignment?.time ?? null,
    title: assignment?.title ?? "Untitled assignment",
    assignment,
  };
}

function normalizedMeetingEvent(meeting) {
  return {
    id: `meeting:${meeting?.id}`,
    source: "meeting",
    category: "class",
    date: meeting?.date ?? null,
    time: meetingTime(meeting),
    title: meetingTitle(meeting),
    meeting,
    cancelled: Boolean(meeting?.disabled),
  };
}

function normalizedScheduleEvent(scheduleEvent) {
  return {
    id: `schedule:${scheduleEvent?.id}`,
    source: "schedule",
    category: classifyTimelineEvent(scheduleEvent, "schedule"),
    date: scheduleEvent?.date ?? null,
    time: scheduleEvent?.time ?? null,
    title: scheduleEvent?.title ?? "Untitled schedule event",
    scheduleEvent,
    informational: true,
  };
}

/**
 * Merges dated coursework and generated class meetings into one chronological
 * stream. Cancelled/no-class records remain visible. Undated coursework is
 * returned separately and keeps its original null/unknown date; an undated
 * meeting pattern is not a dated occurrence and is therefore not fabricated
 * into the stream.
 *
 * Accepts either `(assignments, meetings)` or
 * `{ assignments, meetings, scheduleEvents }`. Schedule events are
 * informational, non-checkable rows such as an exam sitting whose Canvas
 * submission cutoff is represented by a separate assignment record.
 */
export function buildIntegratedCourseTimeline(assignmentsOrOptions = [], meetingsArgument = []) {
  const optionsShape = !Array.isArray(assignmentsOrOptions)
    && assignmentsOrOptions
    && typeof assignmentsOrOptions === "object";
  const assignments = optionsShape
    ? (Array.isArray(assignmentsOrOptions.assignments) ? assignmentsOrOptions.assignments : [])
    : (Array.isArray(assignmentsOrOptions) ? assignmentsOrOptions : []);
  const meetings = optionsShape
    ? (Array.isArray(assignmentsOrOptions.meetings) ? assignmentsOrOptions.meetings : [])
    : (Array.isArray(meetingsArgument) ? meetingsArgument : []);
  const scheduleEvents = optionsShape && Array.isArray(assignmentsOrOptions.scheduleEvents)
    ? assignmentsOrOptions.scheduleEvents
    : [];

  const assignmentEvents = assignments.map(normalizedAssignmentEvent);
  const meetingEvents = meetings.map(normalizedMeetingEvent);
  const scheduleTimelineEvents = scheduleEvents.map(normalizedScheduleEvent);
  const dated = [
    ...assignmentEvents.filter((event) => validDateKey(event.date)),
    ...meetingEvents.filter((event) => validDateKey(event.date)),
    ...scheduleTimelineEvents.filter((event) => validDateKey(event.date)),
  ].sort(compareDated);
  const undated = [...assignmentEvents, ...scheduleTimelineEvents]
    .filter((event) => !validDateKey(event.date))
    .sort((left, right) => (
      compareText(left.category, right.category) || compareText(left.title, right.title)
    ));

  const monthGroups = [];
  for (const event of dated) {
    const key = event.date.slice(0, 7);
    let group = monthGroups.at(-1);
    if (!group || group.key !== key) {
      group = { key, label: monthLabel(event.date), items: [] };
      monthGroups.push(group);
    }
    group.items.push(event);
  }

  return { dated, undated, monthGroups };
}

function countLabel(value, singular, plural = `${singular}s`) {
  if (!Number.isFinite(value)) return null;
  return `${value} ${value === 1 ? singular : plural}`;
}

/**
 * Compact attendance runway copy. The label reports only what each source
 * policy supports; an unknown threshold never receives a fabricated count.
 */
export function attendanceLabel(course, summary = {}) {
  const policy = course?.attendancePolicy || {};

  if (policy.model === "unknown_threshold" || summary.limitKnown === false) {
    const recorded = Number.isFinite(summary.confirmedCount) ? summary.confirmedCount : 0;
    return `${countLabel(recorded, "unexcused absence")} recorded · limit not stated`;
  }

  if (policy.model === "no_penalty_allowance") {
    const remaining = countLabel(summary.remaining, "no-penalty absence");
    return remaining ? `${remaining} left` : "No-penalty allowance not available";
  }

  if (policy.model === "hard_threshold" && policy.countUnit === "period") {
    const remaining = countLabel(summary.remaining, "period");
    return remaining ? `${remaining} left before failure` : "Failure runway not available";
  }

  if (policy.model === "hard_threshold") {
    const failure = summary.counters?.find((counter) => (
      /failure/i.test(counter?.label ?? "") || Number(counter?.trigger) === 3
    )) ?? summary.counters?.at(-1);
    const remaining = countLabel(failure?.confirmedRemaining, "meeting");
    return remaining ? `${remaining} before failure` : "Failure runway not available";
  }

  return summary.limitLabel ?? "Attendance limit not stated";
}
