const EXAM_PATTERN = /\b(?:exam|midterm|final)\b/iu;

function dateNumber(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value || ""))) return null;
  const timestamp = Date.parse(`${value}T12:00:00Z`);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function daysFromDate(todayKey, dateKey) {
  const today = dateNumber(todayKey);
  const target = dateNumber(dateKey);
  if (today === null || target === null) return null;
  return Math.round((target - today) / 86_400_000);
}

export function isExamEvent(item) {
  return EXAM_PATTERN.test(`${item?.kind || ""} ${item?.title || item?.label || ""}`);
}

function weekStartKey(todayKey) {
  const timestamp = dateNumber(todayKey);
  if (timestamp === null) return todayKey;
  const date = new Date(timestamp);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function activeAssignments(assignments, todayKey) {
  return (assignments || []).filter((assignment) => {
    if (assignment?.trackable === false) return false;
    const daysAway = daysFromDate(todayKey, assignment?.date);
    return daysAway !== null && daysAway >= 0;
  });
}

export function buildAcademicCoachPlan({ assignments = [], courses = [], meetings = [], todayKey }) {
  const upcoming = activeAssignments(assignments, todayKey);
  const nextTwoWeeks = upcoming
    .filter((assignment) => daysFromDate(todayKey, assignment.date) <= 14)
    .sort((left, right) => left.date.localeCompare(right.date) || String(left.time || "").localeCompare(String(right.time || "")));
  const exams = upcoming
    .filter(isExamEvent)
    .map((assignment) => ({ ...assignment, daysAway: daysFromDate(todayKey, assignment.date) }))
    .sort((left, right) => left.daysAway - right.daysAway);
  const usableMeetings = (meetings || []).filter((meeting) => !meeting.disabled && meeting.date);
  const nextMeetingByCourse = new Map();
  const recentMeetingByCourse = new Map();
  for (const meeting of usableMeetings) {
    const daysAway = daysFromDate(todayKey, meeting.date);
    if (daysAway === null) continue;
    if (daysAway > 0 && daysAway <= 7 && !nextMeetingByCourse.has(meeting.courseId)) {
      nextMeetingByCourse.set(meeting.courseId, { ...meeting, daysAway });
    }
    if (daysAway <= 0 && daysAway >= -2) {
      const current = recentMeetingByCourse.get(meeting.courseId);
      if (!current || current.date < meeting.date) recentMeetingByCourse.set(meeting.courseId, { ...meeting, daysAway });
    }
  }
  const weekStart = weekStartKey(todayKey);
  return {
    exams,
    nextTwoWeeks,
    preClass: courses.flatMap((course) => {
      const meeting = nextMeetingByCourse.get(course.id);
      return meeting ? [{
        checkId: `preclass:${meeting.id}`,
        course,
        focus: `Pre-class knowledge check for ${course.code || course.title}. Cover the concepts, readings, vocabulary, and likely discussion points assigned before the ${meeting.date} class. Diagnose weak recall before class begins.`,
        label: "Pre-class knowledge check",
        meeting,
      }] : [];
    }),
    afterClass: courses.flatMap((course) => {
      const meeting = recentMeetingByCourse.get(course.id);
      return meeting ? [{
        checkId: `afterclass:${meeting.id}`,
        course,
        focus: `After-class retrieval quiz for ${course.code || course.title} based on the material covered by the ${meeting.date} class. Test definitions, relationships, examples, and one application question without relying on recognition alone.`,
        label: "After-class retrieval",
        meeting,
      }] : [];
    }),
    weekly: courses.map((course) => ({
      checkId: `weekly:${course.id}:${weekStart}`,
      course,
      focus: `Weekly cumulative quiz for ${course.code || course.title}, week beginning ${weekStart}. Cover this week's readings, class meetings, assignments, and recurring mistakes, with cumulative retrieval from earlier weeks.`,
      label: "Weekly cumulative quiz",
      weekStart,
    })),
    weekStart,
  };
}

export function studyCoachQuizUrl({ challenge = 6, course, focus, questions = 8 }) {
  const params = new URLSearchParams({
    auto: "1",
    challenge: String(challenge),
    coach: "1",
    courseCode: course?.code || "",
    courseId: course?.id || "",
    courseName: course?.title || course?.name || course?.code || "Course",
    focus,
    mode: "quiz",
    questions: String(questions),
  });
  return `/study-deck?${params.toString()}`;
}
