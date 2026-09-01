export const CAMPUS_TIME_ZONE = "America/New_York";

export function campusDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CAMPUS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatCampusNow(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CAMPUS_TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function formatLongDate(dateKey) {
  if (!dateKey) return "Date not stated";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

export function formatShortDate(dateKey) {
  if (!dateKey) return "Date not stated";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dateKey}T12:00:00Z`));
}

export function formatWeekRange(week) {
  if (!week) return "";
  const start = new Date(`${week.start}T12:00:00Z`);
  const end = new Date(`${week.end}T12:00:00Z`);
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const left = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(start);
  const right = new Intl.DateTimeFormat("en-US", {
    month: sameMonth ? undefined : "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(end);
  return `${left}–${right}`;
}

export function dayName(dateKey, style = "short") {
  return new Intl.DateTimeFormat("en-US", { weekday: style, timeZone: "UTC" }).format(new Date(`${dateKey}T12:00:00Z`));
}

export function compareDateKeys(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function effectiveAssignmentDate(assignment, overrides) {
  return overrides?.[assignment.id]?.date || assignment.date || null;
}

export function effectiveAssignmentTime(assignment, overrides) {
  return overrides?.[assignment.id]?.time || assignment.time || null;
}

export function certaintyLabel(certainty, overridden = false) {
  if (overridden) return "Your date";
  return {
    confirmed: "Confirmed",
    derived: "Derived",
    provisional: "Provisional",
    tbd: "Date not listed",
    TBD: "Date not listed",
  }[certainty] || "Date not listed";
}

export function statusLabel(status) {
  return {
    not_checked: "Not checked",
    present: "Present",
    late: "Late",
    absent_pending: "Absent — pending",
    absent_excused: "Excused",
    absent_unexcused: "Unexcused",
    cancelled: "No class",
  }[status] || "Not checked";
}
