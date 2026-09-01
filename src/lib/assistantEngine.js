import { isEligibleActualMeeting } from "./attendanceFlow.js";
import {
  CAMPUS_TIME_ZONE,
  campusDateKey,
  effectiveAssignmentDate,
  effectiveAssignmentTime,
} from "./format.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDateKey(value) {
  if (!ISO_DATE.test(String(value ?? ""))) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addCalendarDays(dateKey, amount) {
  if (!validDateKey(dateKey)) return null;
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function normalizedNow(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function parseCampusClock(value) {
  const match = String(value ?? "").trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = match[3]?.toUpperCase() ?? null;
  if (minute < 0 || minute > 59) return null;

  if (period) {
    if (hour < 1 || hour > 12) return null;
    if (period === "AM" && hour === 12) hour = 0;
    if (period === "PM" && hour !== 12) hour += 12;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return { hour, minute };
}

function timeZoneOffsetMilliseconds(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
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
  const representedAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return representedAsUtc - date.getTime();
}

/** Converts a campus-local date and clock into an absolute Date. */
export function campusDateTimeToDate(dateKey, time, timeZone = CAMPUS_TIME_ZONE) {
  const clock = typeof time === "object" && time
    ? { hour: Number(time.hour), minute: Number(time.minute) }
    : parseCampusClock(time);
  if (!validDateKey(dateKey) || !clock) return null;
  if (
    !Number.isInteger(clock.hour)
    || !Number.isInteger(clock.minute)
    || clock.hour < 0
    || clock.hour > 23
    || clock.minute < 0
    || clock.minute > 59
  ) return null;

  const [year, month, day] = dateKey.split("-").map(Number);
  const wallClockUtc = Date.UTC(year, month - 1, day, clock.hour, clock.minute, 0);
  let timestamp = wallClockUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = timeZoneOffsetMilliseconds(new Date(timestamp), timeZone);
    const corrected = wallClockUtc - offset;
    if (corrected === timestamp) break;
    timestamp = corrected;
  }
  return new Date(timestamp);
}

function dateOnlyTarget(dateKey) {
  const nextDate = addCalendarDays(dateKey, 1);
  return nextDate ? campusDateTimeToDate(nextDate, { hour: 0, minute: 0 }) : null;
}

function dateOnlyReminder(dateKey, daysBefore) {
  const reminderDate = addCalendarDays(dateKey, -daysBefore);
  return reminderDate
    ? campusDateTimeToDate(reminderDate, { hour: 9, minute: 0 })
    : null;
}

function courseCodeFor(courseId, courses) {
  return courses.find((course) => course?.id === courseId)?.code ?? "Course";
}

function completedAssignment(assignment, completedAssignments) {
  return completedAssignments?.[assignment?.id] === true;
}

function explicitlyOnline(meeting) {
  if (meeting?.inPerson === false) return true;
  const description = [
    meeting?.deliveryMode,
    meeting?.modality,
    meeting?.location,
    meeting?.platform,
  ].filter(Boolean).join(" ");
  return /\bonline\b|\bremote\b|\bzoom\b|\bteams\b|\bweb\b/i.test(description);
}

function eligibleAssignment(assignment, completedAssignments) {
  return assignment
    && assignment.trackable !== false
    && !completedAssignment(assignment, completedAssignments);
}

function isMidtermOrFinal(item) {
  const descriptor = `${item?.kind ?? ""} ${item?.title ?? ""}`;
  return /\bmidterm\b|\bfinal\b/i.test(descriptor);
}

function isClassMeeting(meeting) {
  const kind = String(meeting?.kind ?? "class").toLowerCase();
  return ["class", "lecture", "discussion", "lab", "seminar", "studio"].includes(kind);
}

function effectiveOverrides(context) {
  return context.assignmentOverrides ?? context.overrides ?? {};
}

function semanticClassStart(assignment, date, time, meetings) {
  if (!/\bstart of\b.*\bclass\b/i.test(String(time ?? ""))) return null;
  const candidates = meetings
    .filter((meeting) => (
      meeting?.courseId === assignment?.courseId
      && meeting?.date === date
      && isEligibleActualMeeting(meeting)
      && !explicitlyOnline(meeting)
    ))
    .map((meeting) => {
      const displayedTime = meeting.startTime || meeting.time;
      const clock = parseCampusClock(displayedTime);
      return clock ? { clock, displayedTime } : null;
    })
    .filter(Boolean)
    .sort((left, right) => (
      (left.clock.hour * 60 + left.clock.minute)
      - (right.clock.hour * 60 + right.clock.minute)
    ));
  return candidates[0] ?? null;
}

function assignmentMoment(assignment, overrides, meetings = []) {
  const date = effectiveAssignmentDate(assignment, overrides);
  if (!validDateKey(date)) return null;
  const time = effectiveAssignmentTime(assignment, overrides);
  const exact = parseCampusClock(time);
  const semantic = exact ? null : semanticClassStart(assignment, date, time, meetings);
  const resolvedClock = exact || semantic?.clock || null;
  const displayTime = semantic ? `${time} (${semantic.displayedTime})` : (time || null);
  return {
    date,
    time: displayTime,
    exact: Boolean(resolvedClock),
    target: resolvedClock ? campusDateTimeToDate(date, resolvedClock) : dateOnlyTarget(date),
  };
}

function scheduleMoment(event) {
  if (!validDateKey(event?.date)) return null;
  const time = event.startTime || event.time || null;
  const exact = parseCampusClock(time);
  return {
    date: event.date,
    time,
    exact: Boolean(exact),
    target: exact ? campusDateTimeToDate(event.date, exact) : dateOnlyTarget(event.date),
  };
}

function preferredExamSources(assignments, scheduleEvents, overrides, completedAssignments, meetings = []) {
  const eligibleEvents = scheduleEvents.filter((event) => (
    isEligibleActualMeeting(event)
    && (String(event.kind).toLowerCase() === "exam" || isMidtermOrFinal(event))
  ));
  const usedEventIds = new Set();
  const sources = [];

  for (const assignment of assignments) {
    if (!eligibleAssignment(assignment, completedAssignments) || !isMidtermOrFinal(assignment)) continue;
    const matching = eligibleEvents
      .filter((event) => event.linkedAssignmentId === assignment.id)
      .sort((left, right) => (
        String(left.date).localeCompare(String(right.date))
        || String(left.startTime || left.time || "").localeCompare(String(right.startTime || right.time || ""))
      ))[0];
    if (matching) usedEventIds.add(matching.id);
    sources.push({
      id: assignment.id,
      courseId: assignment.courseId,
      title: matching?.title || assignment.title,
      moment: matching ? scheduleMoment(matching) : assignmentMoment(assignment, overrides, meetings),
      source: matching || assignment,
    });
  }

  for (const event of eligibleEvents) {
    if (usedEventIds.has(event.id)) continue;
    if (event.linkedAssignmentId && sources.some((source) => source.id === event.linkedAssignmentId)) continue;
    if (!isMidtermOrFinal(event)) continue;
    sources.push({
      id: event.linkedAssignmentId || event.id,
      courseId: event.courseId,
      title: event.title,
      moment: scheduleMoment(event),
      source: event,
    });
  }

  return sources.filter((source) => source.moment?.target);
}

function reminderRecord({
  id,
  type,
  target,
  remindAt,
  title,
  body,
  courseCode,
  date,
  time,
  eventId,
  courseId,
}) {
  return {
    id,
    type,
    targetAt: target.toISOString(),
    remindAt: remindAt.toISOString(),
    title,
    body,
    courseCode,
    date,
    time: time || null,
    eventId,
    courseId: courseId ?? null,
  };
}

/** Builds every deterministic reminder candidate; no delivery state is read or changed. */
export function buildAssistantReminders(context = {}) {
  const courses = Array.isArray(context.courses) ? context.courses : [];
  const meetings = Array.isArray(context.meetings) ? context.meetings : [];
  const assignments = Array.isArray(context.assignments) ? context.assignments : [];
  const scheduleEvents = Array.isArray(context.scheduleEvents) ? context.scheduleEvents : [];
  const overrides = effectiveOverrides(context);
  const completedAssignments = context.completedAssignments ?? context.completed ?? {};
  const reminders = [];

  for (const meeting of meetings) {
    if (!isEligibleActualMeeting(meeting) || !isClassMeeting(meeting) || explicitlyOnline(meeting)) continue;
    const time = meeting.startTime || meeting.time;
    const target = campusDateTimeToDate(meeting.date, time);
    if (!target) continue;
    const courseCode = courseCodeFor(meeting.courseId, courses);
    reminders.push(reminderRecord({
      id: `class:${meeting.id}:1h`,
      type: "class-1h",
      target,
      remindAt: new Date(target.getTime() - HOUR_MS),
      title: `${courseCode} class in one hour`,
      body: `${courseCode} starts at ${time}${meeting.location ? ` in ${meeting.location}` : ""}.`,
      courseCode,
      date: meeting.date,
      time,
      eventId: meeting.id,
      courseId: meeting.courseId,
    }));
  }

  for (const assignment of assignments) {
    if (!eligibleAssignment(assignment, completedAssignments)) continue;
    const moment = assignmentMoment(assignment, overrides, meetings);
    if (!moment?.target) continue;
    const remindAt = moment.exact
      ? new Date(moment.target.getTime() - DAY_MS)
      : dateOnlyReminder(moment.date, 1);
    if (!remindAt) continue;
    const courseCode = courseCodeFor(assignment.courseId, courses);
    reminders.push(reminderRecord({
      id: `assignment:${assignment.id}:24h`,
      type: "assignment-24h",
      target: moment.target,
      remindAt,
      title: `${assignment.title} is due soon`,
      body: moment.exact
        ? `${assignment.title} is due in 24 hours at ${moment.time}.`
        : `${assignment.title} is due tomorrow; no exact time is stated.`,
      courseCode,
      date: moment.date,
      time: moment.time,
      eventId: assignment.id,
      courseId: assignment.courseId,
    }));
  }

  for (const exam of preferredExamSources(
    assignments,
    scheduleEvents,
    overrides,
    completedAssignments,
    meetings,
  )) {
    const remindAt = exam.moment.exact
      ? new Date(exam.moment.target.getTime() - (7 * DAY_MS))
      : dateOnlyReminder(exam.moment.date, 7);
    if (!remindAt) continue;
    const courseCode = courseCodeFor(exam.courseId, courses);
    reminders.push(reminderRecord({
      id: `exam:${exam.id}:7d`,
      type: "exam-7d",
      target: exam.moment.target,
      remindAt,
      title: `${exam.title} is one week away`,
      body: exam.moment.exact
        ? `${exam.title} starts in seven days at ${exam.moment.time}.`
        : `${exam.title} is in seven days; no exact time is stated.`,
      courseCode,
      date: exam.moment.date,
      time: exam.moment.time,
      eventId: exam.source.id,
      courseId: exam.courseId,
    }));
  }

  return reminders.sort((left, right) => (
    left.remindAt.localeCompare(right.remindAt)
    || left.targetAt.localeCompare(right.targetAt)
    || left.id.localeCompare(right.id)
  ));
}

function deliveredIdSet(value) {
  if (value instanceof Set) return new Set(value);
  if (Array.isArray(value)) return new Set(value);
  if (value && typeof value === "object") {
    return new Set(Object.entries(value).filter(([, delivered]) => Boolean(delivered)).map(([id]) => id));
  }
  return new Set();
}

/** Stable per occurrence so moving either boundary makes a reminder deliverable again. */
export function getReminderDeliveryId(reminder) {
  if (!reminder?.id || !reminder?.remindAt || !reminder?.targetAt) return null;
  return `${reminder.id}|${reminder.remindAt}|${reminder.targetAt}`;
}

function remainingTimePhrase(targetAt, now) {
  const remainingMinutes = Math.max(1, Math.ceil((targetAt.getTime() - now.getTime()) / 60000));
  if (remainingMinutes < 60) return `in ${plural(remainingMinutes, "minute")}`;

  const totalHours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  if (totalHours < 24) {
    return `in ${plural(totalHours, "hour")}${minutes ? ` ${plural(minutes, "minute")}` : ""}`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `in ${plural(days, "day")}${hours ? ` ${plural(hours, "hour")}` : ""}`;
}

function reminderSubject(reminder) {
  if (reminder.type === "class-1h") return `${reminder.courseCode || "Course"} class`;
  if (reminder.type === "assignment-24h") return String(reminder.title || "Assignment").replace(/ is due soon$/i, "");
  if (reminder.type === "exam-7d") return String(reminder.title || "Exam").replace(/ is one week away$/i, "");
  return reminder.title || "Reminder";
}

function withCurrentReminderCopy(reminder, now, targetAt, deliveryId) {
  const remaining = remainingTimePhrase(targetAt, now);
  const subject = reminderSubject(reminder);
  const clock = reminder.time ? ` at ${reminder.time}` : "";

  if (reminder.type === "class-1h") {
    return {
      ...reminder,
      deliveryId,
      title: `${subject} ${remaining}`,
      body: `${reminder.courseCode || "Class"} starts ${remaining}${clock}.`,
    };
  }
  if (reminder.type === "assignment-24h") {
    return {
      ...reminder,
      deliveryId,
      title: `${subject} is due ${remaining}`,
      body: `${subject} is due ${remaining}${clock}.`,
    };
  }
  if (reminder.type === "exam-7d") {
    return {
      ...reminder,
      deliveryId,
      title: `${subject} ${remaining}`,
      body: `${subject} starts ${remaining}${clock}.`,
    };
  }
  return { ...reminder, deliveryId };
}

/** Collects due/catch-up reminders only until their target, once per occurrence. */
export function collectDueReminders(reminders = [], options = {}) {
  const now = normalizedNow(options.now);
  const delivered = deliveredIdSet(options.deliveredIds);
  const due = (Array.isArray(reminders) ? reminders : []).flatMap((reminder) => {
    const deliveryId = getReminderDeliveryId(reminder);
    if (!deliveryId || delivered.has(deliveryId)) return [];
    const remindAt = new Date(reminder.remindAt);
    const targetAt = new Date(reminder.targetAt);
    if (Number.isNaN(remindAt.getTime()) || Number.isNaN(targetAt.getTime())) return [];
    if (!(remindAt.getTime() <= now.getTime() && now.getTime() < targetAt.getTime())) return [];
    return [withCurrentReminderCopy(reminder, now, targetAt, deliveryId)];
  }).sort((left, right) => (
    left.targetAt.localeCompare(right.targetAt) || left.id.localeCompare(right.id)
  ));

  for (const reminder of due) delivered.add(reminder.deliveryId);
  return { reminders: due, deliveredIds: [...delivered] };
}

function assignmentItem(assignment, courses, overrides, meetings = []) {
  const moment = assignmentMoment(assignment, overrides, meetings);
  if (!moment?.target) return null;
  return {
    id: assignment.id,
    type: "assignment",
    title: assignment.title,
    courseCode: courseCodeFor(assignment.courseId, courses),
    courseId: assignment.courseId,
    date: moment.date,
    time: moment.time,
    targetAt: moment.target.toISOString(),
  };
}

function meetingItem(meeting, courses) {
  if (!isEligibleActualMeeting(meeting) || !isClassMeeting(meeting)) return null;
  const time = meeting.startTime || meeting.time;
  const target = campusDateTimeToDate(meeting.date, time);
  if (!target) return null;
  const courseCode = courseCodeFor(meeting.courseId, courses);
  return {
    id: meeting.id,
    type: "class",
    title: `${courseCode} ${meeting.kind === "discussion" ? "discussion" : "class"}`,
    courseCode,
    courseId: meeting.courseId,
    date: meeting.date,
    time,
    targetAt: target.toISOString(),
  };
}

function examItem(exam, courses) {
  return {
    id: exam.id,
    type: "exam",
    title: exam.title,
    courseCode: courseCodeFor(exam.courseId, courses),
    courseId: exam.courseId,
    date: exam.moment.date,
    time: exam.moment.time,
    targetAt: exam.moment.target.toISOString(),
    eventId: exam.source.id,
  };
}

function occurrenceKey(item) {
  return `${item?.id ?? ""}|${item?.targetAt ?? ""}`;
}

function withoutExamOccurrenceDuplicates(items, exams) {
  const examOccurrences = new Set(exams.map(occurrenceKey));
  return items.filter((item) => !examOccurrences.has(occurrenceKey(item)));
}

function mergeChronology(...groups) {
  const unique = new Map();
  for (const item of groups.flat()) {
    if (!item) continue;
    const key = `${item.type}|${occurrenceKey(item)}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()].sort((left, right) => (
    left.targetAt.localeCompare(right.targetAt)
    || String(left.type).localeCompare(String(right.type))
    || String(left.id).localeCompare(String(right.id))
  ));
}

function normalizedAttendanceTotals(value) {
  const counts = value?.counts ?? value ?? {};
  return {
    present: Number(counts.present) || 0,
    late: Number(counts.late) || 0,
    absent_excused: Number(counts.absent_excused) || 0,
    absent_unexcused: Number(counts.absent_unexcused) || 0,
    absent_pending: Number(counts.absent_pending) || 0,
    not_checked: Number(counts.not_checked) || 0,
    recorded: Number(counts.recorded) || 0,
  };
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Builds a structured, deterministic campus-day briefing. */
export function buildDailyBriefing(context = {}) {
  const now = normalizedNow(context.now);
  const dateKey = campusDateKey(now);
  const courses = Array.isArray(context.courses) ? context.courses : [];
  const meetings = Array.isArray(context.meetings) ? context.meetings : [];
  const assignments = Array.isArray(context.assignments) ? context.assignments : [];
  const scheduleEvents = Array.isArray(context.scheduleEvents) ? context.scheduleEvents : [];
  const overrides = effectiveOverrides(context);
  const completedAssignments = context.completedAssignments ?? context.completed ?? {};
  const attendanceTotals = normalizedAttendanceTotals(context.attendanceTotals);

  const classes = meetings
    .filter((meeting) => meeting?.date === dateKey)
    .map((meeting) => meetingItem(meeting, courses))
    .filter(Boolean)
    .sort((left, right) => left.targetAt.localeCompare(right.targetAt));
  const dueAssignments = assignments
    .filter((assignment) => (
      eligibleAssignment(assignment, completedAssignments)
      && effectiveAssignmentDate(assignment, overrides) === dateKey
    ))
    .map((assignment) => assignmentItem(assignment, courses, overrides, meetings))
    .filter(Boolean)
    .sort((left, right) => left.targetAt.localeCompare(right.targetAt));
  const exams = preferredExamSources(
    assignments,
    scheduleEvents,
    overrides,
    completedAssignments,
    meetings,
  ).map((exam) => examItem(exam, courses))
    .filter((exam) => exam.date === dateKey)
    .sort((left, right) => left.targetAt.localeCompare(right.targetAt));
  const chronologyAssignments = withoutExamOccurrenceDuplicates(dueAssignments, exams);
  const items = mergeChronology(exams, classes, chronologyAssignments);
  const next = items
    .filter((item) => new Date(item.targetAt).getTime() > now.getTime())
    [0] ?? null;

  const bodyParts = [
    `Today: ${plural(classes.length, "class", "classes")} and ${plural(chronologyAssignments.length, "assignment")} due.`,
  ];
  if (exams.length) bodyParts.push(`${plural(exams.length, "exam session")} today.`);
  if (next) bodyParts.push(`Next: ${next.title}${next.time ? ` at ${next.time}` : ""}.`);
  if (attendanceTotals.absent_unexcused > 0) {
    bodyParts.push(`${plural(attendanceTotals.absent_unexcused, "unexcused absence")} recorded.`);
  }

  return {
    date: dateKey,
    dateKey,
    title: "Daily briefing",
    body: bodyParts.join(" "),
    classes,
    assignments: chronologyAssignments,
    exams,
    items,
    next,
    attendanceTotals,
  };
}

export function detectAssistantIntent(query) {
  const text = String(query ?? "").trim().toLowerCase();
  if (/\bremind|\bnotification|\balert/.test(text)) return "reminders";
  if (/\battendance\b|\babsen|\bpresent\b|\blate\b/.test(text)) return "attendance";
  if (/\bexams?\b|\bmidterms?\b|\bfinals?\b/.test(text)) return "exams";
  if (/\bdue\b|\bdeadline|\bassignments?\b/.test(text)) return "due";
  if (/\btoday\b/.test(text)) return "today";
  if (/what(?:'s| is)? next|\bnext\b|\bupcoming\b/.test(text)) return "what-next";
  return "unknown";
}

/** Answers supported local intents using only the supplied dashboard snapshot. */
export function answerAssistantQuery(query, context = {}) {
  const intent = detectAssistantIntent(query);
  const now = normalizedNow(context.now);
  const courses = Array.isArray(context.courses) ? context.courses : [];
  const meetings = Array.isArray(context.meetings) ? context.meetings : [];
  const assignments = Array.isArray(context.assignments) ? context.assignments : [];
  const scheduleEvents = Array.isArray(context.scheduleEvents) ? context.scheduleEvents : [];
  const overrides = effectiveOverrides(context);
  const completedAssignments = context.completedAssignments ?? context.completed ?? {};

  const upcomingMeetings = meetings
    .map((meeting) => meetingItem(meeting, courses))
    .filter((item) => item && new Date(item.targetAt).getTime() > now.getTime())
    .sort((left, right) => left.targetAt.localeCompare(right.targetAt));
  const upcomingAssignments = assignments
    .filter((assignment) => eligibleAssignment(assignment, completedAssignments))
    .map((assignment) => assignmentItem(assignment, courses, overrides, meetings))
    .filter((item) => item && new Date(item.targetAt).getTime() > now.getTime())
    .sort((left, right) => left.targetAt.localeCompare(right.targetAt));
  const exams = preferredExamSources(
    assignments,
    scheduleEvents,
    overrides,
    completedAssignments,
    meetings,
  ).map((exam) => examItem(exam, courses))
    .filter((exam) => new Date(exam.targetAt).getTime() > now.getTime())
    .sort((left, right) => left.targetAt.localeCompare(right.targetAt));
  const chronologyAssignments = withoutExamOccurrenceDuplicates(upcomingAssignments, exams);
  const upcoming = mergeChronology(exams, upcomingMeetings, chronologyAssignments);

  if (intent === "today") {
    const briefing = buildDailyBriefing({ ...context, now });
    return { intent, title: briefing.title, body: briefing.body, items: briefing.items, briefing };
  }
  if (intent === "what-next") {
    const item = upcoming[0] ?? null;
    return {
      intent,
      title: "What’s next",
      body: item ? `${item.title}${item.time ? ` at ${item.time}` : ""}.` : "Nothing dated is coming up.",
      items: item ? [item] : [],
    };
  }
  if (intent === "due") {
    return {
      intent,
      title: "Upcoming due work",
      body: upcomingAssignments.length
        ? `${plural(upcomingAssignments.length, "assignment")} with a stated date.`
        : "No upcoming assignment dates are stated.",
      items: upcomingAssignments,
    };
  }
  if (intent === "exams") {
    return {
      intent,
      title: "Upcoming exams",
      body: exams.length ? `${plural(exams.length, "midterm or final")} coming up.` : "No upcoming midterm or final is dated.",
      items: exams,
    };
  }
  if (intent === "attendance") {
    const totals = normalizedAttendanceTotals(context.attendanceTotals);
    return {
      intent,
      title: "Attendance",
      body: `${plural(totals.present, "present record")}, ${plural(totals.absent_excused, "excused absence")}, and ${plural(totals.absent_unexcused, "unexcused absence")}.`,
      items: [],
      attendanceTotals: totals,
    };
  }
  if (intent === "reminders") {
    const reminders = (Array.isArray(context.reminders) ? context.reminders : [])
      .filter((reminder) => new Date(reminder.targetAt).getTime() > now.getTime())
      .sort((left, right) => left.remindAt.localeCompare(right.remindAt));
    return {
      intent,
      title: "Reminders",
      body: reminders.length ? `${plural(reminders.length, "reminder")} scheduled.` : "No upcoming reminders are scheduled.",
      items: reminders,
    };
  }

  return {
    intent,
    title: "Semester assistant",
    body: "Ask what’s next, what is due, what is happening today, about exams, attendance, or reminders.",
    items: [],
  };
}
