const URGENCY_ORDER = Object.freeze({
  missed: 0,
  "ready-to-submit": 1,
  overdue: 2,
  today: 3,
  upcoming: 4,
  later: 5,
  undated: 6,
  completed: 7,
});

const WORK_STATUSES = new Set(["not-started", "in-progress", "completed"]);
const SUBMISSION_STATUSES = new Set(["not-marked", "not-submitted", "submitted", "missed"]);

function trackableAssignment(assignment) {
  return assignment?.trackable !== false;
}

export function assignmentWorkStatus(assignment, completed = {}, assignmentWorkflow = {}) {
  const savedStatus = assignmentWorkflow?.byAssignment?.[assignment.id]?.workStatus;
  if (WORK_STATUSES.has(savedStatus)) return savedStatus;
  return completed?.[assignment.id] === true ? "completed" : "not-started";
}

export function assignmentSubmissionStatus(assignment, assignmentWorkflow = {}) {
  const savedStatus = assignmentWorkflow?.byAssignment?.[assignment.id]?.submissionStatus;
  return SUBMISSION_STATUSES.has(savedStatus) ? savedStatus : "not-marked";
}

export function assignmentUrgency(assignment, completed = {}, todayKey, assignmentWorkflow = {}) {
  if (assignmentSubmissionStatus(assignment, assignmentWorkflow) === "missed") return "missed";
  if (assignmentWorkStatus(assignment, completed, assignmentWorkflow) === "completed") {
    return assignmentSubmissionStatus(assignment, assignmentWorkflow) === "submitted"
      ? "completed"
      : "ready-to-submit";
  }
  if (!assignment.date) return "undated";
  if (assignment.date < todayKey) return "overdue";
  if (assignment.date === todayKey) return "today";

  const due = new Date(`${assignment.date}T12:00:00Z`);
  const today = new Date(`${todayKey}T12:00:00Z`);
  const daysAway = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  return daysAway <= 7 ? "upcoming" : "later";
}

export function sortAssignmentDeck(assignments, completed = {}, todayKey, assignmentWorkflow = {}) {
  return [...assignments].sort((left, right) => {
    const leftUrgency = assignmentUrgency(left, completed, todayKey, assignmentWorkflow);
    const rightUrgency = assignmentUrgency(right, completed, todayKey, assignmentWorkflow);
    return URGENCY_ORDER[leftUrgency] - URGENCY_ORDER[rightUrgency]
      || (left.date || "9999-12-31").localeCompare(right.date || "9999-12-31")
      || left.courseId.localeCompare(right.courseId)
      || left.title.localeCompare(right.title);
  });
}

export function summarizeAssignmentDeck(assignments, completed = {}, todayKey, assignmentWorkflow = {}) {
  const trackable = assignments.filter(trackableAssignment);
  const summary = {
    total: trackable.length,
    completed: 0,
    submitted: 0,
    missed: 0,
    overdue: 0,
    dueToday: 0,
    dueSoon: 0,
    undated: 0,
  };

  for (const assignment of trackable) {
    const workStatus = assignmentWorkStatus(assignment, completed, assignmentWorkflow);
    const submissionStatus = assignmentSubmissionStatus(assignment, assignmentWorkflow);
    const urgency = assignmentUrgency(assignment, completed, todayKey, assignmentWorkflow);
    if (workStatus === "completed") summary.completed += 1;
    if (submissionStatus === "submitted") summary.submitted += 1;
    if (submissionStatus === "missed") summary.missed += 1;
    if (urgency === "overdue") summary.overdue += 1;
    if (urgency === "today") summary.dueToday += 1;
    if (urgency === "upcoming") summary.dueSoon += 1;
    if (urgency === "undated") summary.undated += 1;
  }

  return summary;
}

export function priorityAssignments(assignments, completed = {}, todayKey, assignmentWorkflow = {}, limit = 6) {
  return sortAssignmentDeck(assignments.filter(trackableAssignment), completed, todayKey, assignmentWorkflow)
    .filter((assignment) => {
      const urgency = assignmentUrgency(assignment, completed, todayKey, assignmentWorkflow);
      return urgency !== "completed" && urgency !== "later";
    })
    .slice(0, limit);
}

export function isTrackableAssignment(assignment) {
  return trackableAssignment(assignment);
}
