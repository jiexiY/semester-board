// Canvas audit records are user data. The public bundle exposes only the
// schema helpers; audited course, assignment, file, and URL records belong in
// the authenticated user's private semester payload.
export const CANVAS_ASSIGNMENT_AUDIT = Object.freeze([]);
export const CANVAS_FILE_AUDIT = Object.freeze([]);
export const CANVAS_AUDIT = Object.freeze({
  schemaVersion: 2,
  observedDate: null,
  courses: Object.freeze([]),
  blockedItems: Object.freeze([]),
  reviewCandidateFiles: Object.freeze([]),
});

export function canvasAuditCoverage(assignments = []) {
  const records = Array.isArray(assignments) ? assignments : [];
  return {
    assignmentAuditCount: CANVAS_ASSIGNMENT_AUDIT.length,
    canvasAssignmentCount: records.filter((assignment) => assignment?.canvasAssignmentId).length,
    canvasFileCount: records.reduce((count, assignment) => count + (assignment?.canvasFiles?.length || 0), 0),
    fileAuditCount: CANVAS_FILE_AUDIT.length,
  };
}

export function attachCanvasEvidence(assignments = []) {
  return Array.isArray(assignments) ? assignments.map((assignment) => ({ ...assignment })) : [];
}
