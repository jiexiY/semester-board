import { isEligibleActualMeeting } from "./attendanceFlow.js";

const COUNT_STATUSES = Object.freeze([
  "present",
  "late",
  "absent_excused",
  "absent_unexcused",
  "absent_pending",
  "not_checked",
]);

const COUNT_STATUS_SET = new Set(COUNT_STATUSES);

function recordId(record, fallback = null) {
  return record?.id ?? record?.meetingId ?? fallback;
}

function normalizedStatus(record) {
  return COUNT_STATUS_SET.has(record?.status) ? record.status : "not_checked";
}

function isEligibleManualRecord(record) {
  return record?.manualRecord === true
    && record?.disabled !== true
    && record?.eligible !== false
    && record?.checkInEnabled !== false
    && record?.status !== "cancelled"
    && record?.kind !== "no-class";
}

function countRecords(records) {
  const counts = Object.fromEntries(COUNT_STATUSES.map((status) => [status, 0]));
  counts.recorded = 0;

  for (const record of records) {
    const status = normalizedStatus(record);
    counts[status] += 1;
    if (status !== "not_checked") counts.recorded += 1;
  }

  return counts;
}

function migrationReviewRecords(courseId, checkins) {
  return Object.entries(
    checkins && typeof checkins === "object" && !Array.isArray(checkins) ? checkins : {},
  ).flatMap(([key, record]) => {
    if (!record || typeof record !== "object") return [];
    if (record.courseId !== courseId
      || record.migrationReview?.status !== "needs_review") return [];
    const id = recordId(record, key);
    return [{
      ...record,
      id,
      meetingId: record.meetingId ?? id,
      courseId,
      manualRecord: false,
    }];
  });
}

/**
 * Merges scheduled meetings with saved check-ins, then appends standalone
 * Canvas/imported records from the same check-ins map. Scheduled identity is
 * kept authoritative so a malformed saved entry cannot move a meeting to a
 * different course or duplicate it as a manual record.
 */
export function mergeCourseAttendanceEntries(courseId, meetings = [], checkins = {}) {
  const scheduledRecords = (Array.isArray(meetings) ? meetings : [])
    .filter((meeting) => meeting?.courseId === courseId)
    .map((meeting) => {
      const id = recordId(meeting);
      const saved = id == null ? null : checkins?.[id];
      return {
        ...meeting,
        ...(saved && typeof saved === "object" ? saved : {}),
        id,
        meetingId: id,
        courseId,
        manualRecord: false,
      };
    });

  const scheduledIds = new Set(
    scheduledRecords.flatMap((record) => [record.id, record.meetingId]).filter(Boolean),
  );
  const manualRecords = Object.entries(
    checkins && typeof checkins === "object" && !Array.isArray(checkins) ? checkins : {},
  ).flatMap(([key, record]) => {
    if (!record || typeof record !== "object") return [];
    if (record.manualRecord !== true || record.courseId !== courseId) return [];
    const id = recordId(record, key);
    if (scheduledIds.has(key) || scheduledIds.has(id)) return [];

    const normalized = {
      ...record,
      id,
      meetingId: record.meetingId ?? id,
      courseId,
      manualRecord: true,
    };
    return isEligibleManualRecord(normalized) ? [normalized] : [];
  });

  return [...scheduledRecords, ...manualRecords];
}

/**
 * Builds one attendance row per course, preserving the supplied course order.
 * Scheduled meetings must be eligible, dated, and on/before throughDate.
 * Manual records are already recorded facts and may be undated.
 */
export function buildAttendanceCourseRows(
  courses = [],
  meetings = [],
  checkins = {},
  throughDate = null,
) {
  return (Array.isArray(courses) ? courses : []).map((course) => {
    const merged = mergeCourseAttendanceEntries(course?.id, meetings, checkins);
    const reviewRecords = migrationReviewRecords(course?.id, checkins);
    const scheduledRecords = merged.filter((record) => (
      record.manualRecord !== true
      && isEligibleActualMeeting(record)
      && (!throughDate || record.date <= throughDate)
    ));
    const manualRecords = merged.filter((record) => record.manualRecord === true);
    const records = [...scheduledRecords, ...manualRecords];

    return {
      course,
      courseId: course?.id ?? null,
      scheduledRecords,
      manualRecords,
      reviewRecords,
      records,
      counts: countRecords(records),
    };
  });
}

/** Returns the exact records and status totals represented by course rows. */
export function summarizeAttendanceRows(rows = []) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const scheduledRecords = normalizedRows.flatMap((row) => (
    Array.isArray(row?.scheduledRecords) ? row.scheduledRecords : []
  ));
  const manualRecords = normalizedRows.flatMap((row) => (
    Array.isArray(row?.manualRecords) ? row.manualRecords : []
  ));
  const reviewRecords = normalizedRows.flatMap((row) => (
    Array.isArray(row?.reviewRecords) ? row.reviewRecords : []
  ));
  const records = normalizedRows.flatMap((row) => (
    Array.isArray(row?.records) ? row.records : []
  ));
  const totals = countRecords([]);

  for (const row of normalizedRows) {
    for (const status of COUNT_STATUSES) {
      totals[status] += Number(row?.counts?.[status]) || 0;
    }
    totals.recorded += Number(row?.counts?.recorded) || 0;
  }

  return {
    courseCount: normalizedRows.length,
    scheduledRecords,
    manualRecords,
    reviewRecords,
    reviewCount: reviewRecords.length,
    records,
    counts: totals,
  };
}
