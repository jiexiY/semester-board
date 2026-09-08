import { useMemo, useState } from "react";
import { Icon } from "../icons";
import AcademicCoachPanel from "./AcademicCoachPanel";
import { ASSIGNMENT_FILE_ACCEPT } from "../lib/assignmentFiles.js";
import {
  assignmentSubmissionStatus,
  assignmentUrgency,
  assignmentWorkStatus,
  isTrackableAssignment,
  priorityAssignments,
  sortAssignmentDeck,
  summarizeAssignmentDeck,
} from "../lib/assignmentDeck";
import { formatLongDate } from "../lib/format";

const STATUS_FILTERS = [
  ["active", "Open work"],
  ["all", "All"],
  ["completed", "Completed"],
  ["missed", "Missed"],
  ["undated", "Date missing"],
];

const URGENCY_LABELS = {
  overdue: "Past due — verify status",
  today: "Due today",
  upcoming: "Due within 7 days",
  later: "Scheduled",
  undated: "Date not listed",
  "ready-to-submit": "Work complete · submission not marked",
  completed: "Completed and submitted",
  missed: "Missed in Canvas",
};

const WORK_STATUS_OPTIONS = [
  ["not-started", "Not started"],
  ["in-progress", "In progress"],
  ["completed", "Completed"],
];

const SUBMISSION_STATUS_OPTIONS = [
  ["not-marked", "Not marked"],
  ["not-submitted", "Not submitted"],
  ["submitted", "Submitted"],
  ["missed", "Missed"],
];

function deadlineLabel(assignment) {
  if (!assignment.date) return "Date not listed";
  return `${formatLongDate(assignment.date)}${assignment.time ? ` · ${assignment.time}` : " · time not stated"}`;
}

const DOCUMENT_KIND_OPTIONS = [
  ["working-draft", "Working draft"],
  ["study-support", "Study support"],
  ["reference", "Reference"],
  ["ready-for-review", "Ready for my review"],
];

function AssignmentFilePanel({ assignment, files, onAddFiles, onDownload, onRemove }) {
  const [documentKind, setDocumentKind] = useState("working-draft");
  const inputId = `assignment-file-${assignment.id.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
  const handleFiles = async (event) => {
    const selected = Array.from(event.target.files || []);
    event.target.value = "";
    if (!selected.length) return;
    await onAddFiles(selected, {
      assignmentId: assignment.id,
      courseId: assignment.courseId,
      documentKind,
    });
  };
  return (
    <details className="assignment-file-panel">
      <summary><Icon name="upload" size={15} />Assignment documents <span>{files.length}</span></summary>
      <div className="assignment-file-panel-body">
        <div className="assignment-file-upload-row">
          <label><span>Document role</span><select onChange={(event) => setDocumentKind(event.target.value)} value={documentKind}>{DOCUMENT_KIND_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <input accept={ASSIGNMENT_FILE_ACCEPT} className="visually-hidden" id={inputId} multiple onChange={handleFiles} type="file" />
          <label className="assignment-file-upload" htmlFor={inputId}><Icon name="upload" size={16} />Upload DOCX, DOC, PDF, or TXT</label>
        </div>
        {files.length ? <ul>{files.map((file) => (
          <li key={file.id}>
            <span className="assignment-file-type">{file.typeLabel}</span>
            <div><strong>{file.fileName}</strong><small>{DOCUMENT_KIND_OPTIONS.find(([value]) => value === file.documentKind)?.[1] || "Working draft"} · {file.sizeLabel} · {file.storageScope}</small></div>
            <button onClick={() => onDownload(file)} type="button">Download</button>
            <button className="is-danger" onClick={() => { if (window.confirm(`Remove “${file.fileName}” from this assignment?`)) void onRemove(file); }} type="button">Remove</button>
          </li>
        ))}</ul> : <p>No document is attached to this assignment yet.</p>}
      </div>
    </details>
  );
}

function AssignmentRow({ assignment, assignmentWorkflow, completed, course, files, onAddFiles, onDownloadFile, onOpen, onRemoveFile, onSetSubmissionStatus, onSetWorkStatus, todayKey }) {
  const workStatus = assignmentWorkStatus(assignment, completed, assignmentWorkflow);
  const submissionStatus = assignmentSubmissionStatus(assignment, assignmentWorkflow);
  const isDone = workStatus === "completed";
  const urgency = assignmentUrgency(assignment, completed, todayKey, assignmentWorkflow);
  return (
    <article className={`assignment-deck-row urgency-${urgency}${isDone ? " is-complete" : ""}`}>
      <div className="assignment-deck-row-copy">
        <div className="assignment-deck-row-kicker">
          <span>{course?.code || assignment.courseId}</span>
          <span>{assignment.kind || "assignment"}</span>
          <span className={`assignment-deck-urgency urgency-${urgency}`}>{URGENCY_LABELS[urgency]}</span>
        </div>
        <h3>{assignment.title}</h3>
        <p>{deadlineLabel(assignment)}</p>
        {assignment.note ? <small>{assignment.note}</small> : null}
      </div>
      <div className="assignment-deck-status-controls">
        <label>
          <span>Work status</span>
          <select
            aria-label={`Work status for ${assignment.title}`}
            onChange={(event) => onSetWorkStatus(assignment.id, event.target.value)}
            value={workStatus}
          >
            {WORK_STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>Canvas submission</span>
          <select
            aria-label={`Canvas submission status for ${assignment.title}`}
            onChange={(event) => onSetSubmissionStatus(assignment.id, event.target.value)}
            value={submissionStatus}
          >
            {SUBMISSION_STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      <div className="assignment-deck-row-actions">
        <button onClick={() => onOpen(assignment)} type="button">Details</button>
        {assignment.sourceUrl ? <a href={assignment.sourceUrl} rel="noreferrer" target="_blank">Canvas list <span aria-hidden="true">↗</span></a> : null}
      </div>
      {Array.isArray(files) ? <AssignmentFilePanel assignment={assignment} files={files} onAddFiles={onAddFiles} onDownload={onDownloadFile} onRemove={onRemoveFile} /> : null}
    </article>
  );
}

export default function AssignmentDeckPage({
  academicCoach,
  assignmentFiles,
  assignmentFileStatus,
  assignments,
  assignmentWorkflow,
  completed,
  courses,
  gradeOpsEnabled,
  meetings,
  onAddAssignmentFiles,
  onDownloadAssignmentFile,
  onOpenAssignment,
  onRemoveAssignmentFile,
  onSaveCoachChapter,
  onSetSubmissionStatus,
  onSetWorkStatus,
  onToggleCoachCheck,
  todayKey,
}) {
  const [courseFilter, setCourseFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [query, setQuery] = useState("");
  const courseById = useMemo(
    () => Object.fromEntries(courses.map((course) => [course.id, course])),
    [courses],
  );
  const summary = useMemo(
    () => summarizeAssignmentDeck(assignments, completed, todayKey, assignmentWorkflow),
    [assignments, assignmentWorkflow, completed, todayKey],
  );
  const priority = useMemo(
    () => priorityAssignments(assignments, completed, todayKey, assignmentWorkflow),
    [assignments, assignmentWorkflow, completed, todayKey],
  );
  const visible = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return sortAssignmentDeck(assignments.filter(isTrackableAssignment), completed, todayKey, assignmentWorkflow)
      .filter((assignment) => courseFilter === "all" || assignment.courseId === courseFilter)
      .filter((assignment) => {
        const urgency = assignmentUrgency(assignment, completed, todayKey, assignmentWorkflow);
        const workStatus = assignmentWorkStatus(assignment, completed, assignmentWorkflow);
        if (statusFilter === "completed") return workStatus === "completed";
        if (statusFilter === "missed") return assignmentSubmissionStatus(assignment, assignmentWorkflow) === "missed";
        if (statusFilter === "undated") return urgency === "undated";
        if (statusFilter === "active") return urgency !== "completed";
        return true;
      })
      .filter((assignment) => !normalizedQuery || [
        assignment.title,
        assignment.kind,
        courseById[assignment.courseId]?.code,
        courseById[assignment.courseId]?.title,
      ].some((value) => String(value || "").toLowerCase().includes(normalizedQuery)));
  }, [assignments, assignmentWorkflow, completed, courseById, courseFilter, query, statusFilter, todayKey]);

  const visibleByCourse = useMemo(() => courses.map((course) => ({
    course,
    assignments: visible.filter((assignment) => assignment.courseId === course.id),
  })).filter((group) => group.assignments.length), [courses, visible]);

  return (
    <section aria-labelledby="page-tab-assignments" className="assignment-deck-page" id="assignments-page" role="tabpanel">
      <header className="assignment-deck-hero">
        <div className="assignment-deck-hero-icon"><Icon name="document" size={24} /></div>
        <div>
          <span>Source-grounded course workbench</span>
          <h2>Assignment Deck</h2>
          <p>Track whether the work is finished separately from whether you submitted it to Canvas.</p>
        </div>
      </header>

      {gradeOpsEnabled ? <AcademicCoachPanel
        assignments={assignments}
        coachState={academicCoach}
        courses={courses}
        meetings={meetings}
        onSaveChapter={onSaveCoachChapter}
        onToggleCheck={onToggleCoachCheck}
        todayKey={todayKey}
      /> : null}

      {gradeOpsEnabled && assignmentFileStatus?.message ? <div className={`assignment-file-status is-${assignmentFileStatus.state}`} role={assignmentFileStatus.state === "error" ? "alert" : "status"}>{assignmentFileStatus.message}</div> : null}

      <div className="assignment-deck-metrics" aria-label="Assignment summary">
        <article><span>Total trackable</span><strong>{summary.total}</strong></article>
        <article className="is-alert"><span>Past due</span><strong>{summary.overdue}</strong></article>
        <article className="is-today"><span>Due today</span><strong>{summary.dueToday}</strong></article>
        <article><span>Next 7 days</span><strong>{summary.dueSoon}</strong></article>
        <article><span>Date missing</span><strong>{summary.undated}</strong></article>
        <article className="is-complete"><span>Completed</span><strong>{summary.completed}</strong></article>
        <article className="is-submitted"><span>Submitted</span><strong>{summary.submitted}</strong></article>
        <article className="is-missed"><span>Missed in Canvas</span><strong>{summary.missed}</strong></article>
      </div>

      <section className="assignment-deck-priority" aria-labelledby="assignment-priority-title">
        <div className="assignment-deck-section-heading">
          <div><span>Start here</span><h3 id="assignment-priority-title">Priority queue</h3></div>
          <p>Items marked Missed stay at the front for review, followed by completed work needing a submission update and urgent work. A past date is not proof that work is incomplete.</p>
        </div>
        {priority.length ? (
          <div className="assignment-deck-priority-grid">
            {priority.map((assignment, index) => {
              const course = courseById[assignment.courseId];
              const urgency = assignmentUrgency(assignment, completed, todayKey, assignmentWorkflow);
              return (
                <button key={assignment.id} onClick={() => onOpenAssignment(assignment)} type="button">
                  <span>{String(index + 1).padStart(2, "0")} · {course?.code || assignment.courseId}</span>
                  <strong>{assignment.title}</strong>
                  <small>{deadlineLabel(assignment)}</small>
                  <b className={`urgency-${urgency}`}>{URGENCY_LABELS[urgency]}</b>
                </button>
              );
            })}
          </div>
        ) : <p className="assignment-deck-empty">No open priority items match the current source inventory.</p>}
      </section>

      <section className="assignment-deck-library" aria-labelledby="assignment-library-title">
        <div className="assignment-deck-section-heading">
          <div><span>All courses</span><h3 id="assignment-library-title">Course assignment library</h3></div>
          <p>{visible.length} item{visible.length === 1 ? "" : "s"} shown</p>
        </div>
        <div className="assignment-deck-filters">
          <label>
            <span className="visually-hidden">Search assignments</span>
            <input onChange={(event) => setQuery(event.target.value)} placeholder="Search assignments" type="search" value={query} />
          </label>
          <label>
            <span className="visually-hidden">Filter by course</span>
            <select onChange={(event) => setCourseFilter(event.target.value)} value={courseFilter}>
              <option value="all">All courses</option>
              {courses.map((course) => <option key={course.id} value={course.id}>{course.code}</option>)}
            </select>
          </label>
          <div className="assignment-deck-status-filters" role="group" aria-label="Filter assignment status">
            {STATUS_FILTERS.map(([value, label]) => (
              <button aria-pressed={statusFilter === value} key={value} onClick={() => setStatusFilter(value)} type="button">{label}</button>
            ))}
          </div>
        </div>

        {visibleByCourse.length ? visibleByCourse.map(({ course, assignments: courseAssignments }) => {
          const courseCompleted = courseAssignments.filter(
            (assignment) => assignmentWorkStatus(assignment, completed, assignmentWorkflow) === "completed",
          ).length;
          return (
            <section className="assignment-deck-course" key={course.id}>
              <header>
                <div><span>{course.code}</span><h3>{course.title}</h3></div>
                <p>{courseCompleted} of {courseAssignments.length} shown items complete</p>
              </header>
              <div className="assignment-deck-course-progress" aria-hidden="true"><span style={{ width: `${courseAssignments.length ? (courseCompleted / courseAssignments.length) * 100 : 0}%` }} /></div>
              <div className="assignment-deck-list">
                {courseAssignments.map((assignment) => (
                  <AssignmentRow
                    assignment={assignment}
                    assignmentWorkflow={assignmentWorkflow}
                    completed={completed}
                    course={course}
                    files={gradeOpsEnabled ? assignmentFiles?.[assignment.id] || [] : null}
                    key={assignment.id}
                    onAddFiles={onAddAssignmentFiles}
                    onDownloadFile={onDownloadAssignmentFile}
                    onOpen={onOpenAssignment}
                    onRemoveFile={onRemoveAssignmentFile}
                    onSetSubmissionStatus={onSetSubmissionStatus}
                    onSetWorkStatus={onSetWorkStatus}
                    todayKey={todayKey}
                  />
                ))}
              </div>
            </section>
          );
        }) : <p className="assignment-deck-empty">No assignments match these filters.</p>}
      </section>

      <aside className="assignment-deck-boundary" role="note">
        <Icon name="shield" size={19} />
        <p><strong>Work status and Canvas submission are separate.</strong> Semester Board never submits to Canvas or assumes that a past deadline means the work is done. Mark Submitted or Missed yourself after checking Canvas.</p>
      </aside>
    </section>
  );
}
