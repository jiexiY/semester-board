import { getExcuseDeadline } from "./attendance.js";

function clockMinutes(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
  if (!match) return Number.MAX_SAFE_INTEGER;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = match[3]?.toUpperCase();
  if (period === "AM" && hour === 12) hour = 0;
  if (period === "PM" && hour !== 12) hour += 12;
  return hour * 60 + minute;
}

export function effectiveMeetingStatus(meeting, checkins = {}) {
  return checkins?.[meeting?.id]?.status
    ?? meeting?.status
    ?? "not_checked";
}

export function isEligibleActualMeeting(meeting) {
  return Boolean(meeting?.date)
    && meeting?.disabled !== true
    && meeting?.eligible !== false
    && meeting?.checkInEnabled !== false
    && meeting?.status !== "cancelled"
    && meeting?.kind !== "no-class";
}

export function sortAttendanceMeetings(meetings = []) {
  return [...meetings].sort((left, right) => (
    String(left?.date ?? "").localeCompare(String(right?.date ?? ""))
    || clockMinutes(left?.startTime || left?.time) - clockMinutes(right?.startTime || right?.time)
    || String(left?.id ?? "").localeCompare(String(right?.id ?? ""))
  ));
}

export function eligibleAttendanceMeetings(meetings = []) {
  return sortAttendanceMeetings(meetings).filter(isEligibleActualMeeting);
}

/**
 * Header-entry priority: the oldest overdue/today unchecked meeting first,
 * then the next future unchecked meeting, then the latest eligible meeting.
 */
export function selectDefaultAttendanceMeeting(meetings, checkins, today) {
  const eligible = eligibleAttendanceMeetings(meetings);
  const pastOrToday = eligible.find((meeting) => (
    meeting.date <= today && effectiveMeetingStatus(meeting, checkins) === "not_checked"
  ));
  if (pastOrToday) return pastOrToday;

  const future = eligible.find((meeting) => (
    meeting.date > today && effectiveMeetingStatus(meeting, checkins) === "not_checked"
  ));
  return future || eligible.at(-1) || null;
}

/**
 * A no-penalty allowance position is derived from recorded unexcused or pending
 * absences in chronological order. Excused, present, cancelled, and unchecked
 * entries never consume an allowance position.
 */
export function allowancePositionForMeeting(course, selectedMeeting, meetings, checkins) {
  if (course?.attendancePolicy?.model !== "no_penalty_allowance" || !selectedMeeting) return null;
  const counted = eligibleAttendanceMeetings(meetings).filter((meeting) => {
    const status = effectiveMeetingStatus(meeting, checkins);
    return status === "absent_unexcused" || status === "absent_pending";
  });
  const index = counted.findIndex((meeting) => meeting.id === selectedMeeting.id);
  return index >= 0 ? index + 1 : null;
}

/** Produces the displayed per-meeting excuse rule from the canonical policy helper. */
export function excuseGuidanceForMeeting(
  course,
  meeting,
  entry = {},
  { allowancePosition = null } = {},
) {
  return getExcuseDeadline(course, {
    ...meeting,
    ...entry,
    allowancePosition,
  });
}

function blankMeetingPattern(id = "custom-meeting-1") {
  return {
    id,
    weekdays: [],
    startTime: "",
    endTime: "",
    countWeight: 1,
  };
}

export function normalizeMeetingPatterns(patterns, { includeBlank = true } = {}) {
  const source = Array.isArray(patterns) ? patterns : [];
  if (!source.length) return includeBlank ? [blankMeetingPattern()] : [];
  return source.map((pattern, index) => ({
    ...pattern,
    id: pattern?.id || `custom-meeting-${index + 1}`,
    weekdays: Array.isArray(pattern?.weekdays) ? [...pattern.weekdays] : [],
    startTime: pattern?.startTime || "",
    endTime: pattern?.endTime || "",
    countWeight: Number(pattern?.countWeight) === 2 ? 2 : 1,
  }));
}

export function meetingPatternsAreComplete(patterns) {
  return Array.isArray(patterns) && patterns.every((pattern) => (
    Array.isArray(pattern?.weekdays)
    && pattern.weekdays.length > 0
    && Boolean(pattern.startTime)
  ));
}

export function nextMeetingPattern(patterns) {
  const usedIds = new Set((Array.isArray(patterns) ? patterns : []).map((pattern) => pattern.id));
  let number = 1;
  while (usedIds.has(`custom-meeting-${number}`)) number += 1;
  return blankMeetingPattern(`custom-meeting-${number}`);
}

export function serializeMeetingPatterns(patterns) {
  return normalizeMeetingPatterns(patterns, { includeBlank: false }).map((pattern) => ({
    ...pattern,
    weekdays: [...pattern.weekdays],
    startTime: pattern.startTime,
    endTime: pattern.endTime || null,
    countWeight: Number(pattern.countWeight) === 2 ? 2 : 1,
  }));
}
