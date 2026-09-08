import { useEffect, useState } from "react";
import { Icon } from "../icons";
import {
  meetingPatternsAreComplete,
  excuseGuidanceForMeeting,
  nextMeetingPattern,
  normalizeMeetingPatterns,
  serializeMeetingPatterns,
} from "../lib/attendanceFlow";
import { dayName, formatLongDate } from "../lib/format";
import { formatOfficeHoursEntry, officeHoursStatusLabel } from "../lib/officeHours";

const ATTENDANCE_OPTIONS = [
  ["not_checked", "Not checked"],
  ["present", "Present"],
  ["late", "Late"],
  ["absent_pending", "Absent — pending excuse"],
  ["absent_excused", "Excused absence"],
  ["absent_unexcused", "Unexcused absence"],
];

const ABSENCE_REASON_OPTIONS = [
  ["general", "General / other"],
  ["illness_quarantine", "Illness or quarantine"],
  ["university_sponsored", "University-sponsored event"],
];

const WEEKDAYS = [
  ["MO", "Mon"],
  ["TU", "Tue"],
  ["WE", "Wed"],
  ["TH", "Thu"],
  ["FR", "Fri"],
];

function assignmentSourceStatus(assignment) {
  if (assignment?._overridden) return "Your verified local date";
  switch (assignment?.sourceStatus) {
    case "user-entered": return "Added by you";
    case "canvas-confirmed": return "Canvas confirmed";
    case "canvas-undated": return "Canvas — date not published";
    case "canvas-file-undated": return "Canvas files — date not published";
    case "canvas-undated-syllabus-confirmed": return "Canvas undated · syllabus date confirmed";
    case "canvas-undated-syllabus-provisional": return "Canvas undated · syllabus forecast";
    case "syllabus-only": return "Syllabus-only — not published in Canvas";
    case "syllabus-confirmed": return "Syllabus confirmed";
    default:
      if (assignment?.dateCertainty === "confirmed") return "Confirmed";
      if (assignment?.dateCertainty === "derived") return "Forecast";
      return assignment?.date ? "Verify in Canvas" : "Date not listed";
  }
}

function Sheet({ children, eyebrow, onClose, title, wide = false }) {
  return (
    <div className="sheet-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section aria-label={title} aria-modal="true" className={`glass-sheet${wide ? " is-wide" : ""}`} role="dialog">
        <div className="sheet-handle" aria-hidden="true" />
        <header className="sheet-header">
          <div>
            {eyebrow ? <p>{eyebrow}</p> : null}
            <h2>{title}</h2>
          </div>
          <button aria-label="Close" className="sheet-close" onClick={onClose} type="button"><Icon name="close" size={20} /></button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function AssignmentSheet({ assignment, course, onClose, onSave }) {
  const [date, setDate] = useState(assignment?.date || "");
  const [time, setTime] = useState(assignment?.time || "");

  useEffect(() => {
    setDate(assignment?.date || "");
    setTime(assignment?.time || "");
  }, [assignment?.id]);

  if (!assignment || !course) return null;
  const sourceDate = assignment._sourceDate || assignment.date;
  const canSave = /^\d{4}-\d{2}-\d{2}$/.test(date);

  return (
    <Sheet eyebrow={course.code} onClose={onClose} title={assignment.title}>
      <div className="sheet-body assignment-sheet-body">
        <div className="detail-grid">
          <div><span>Type</span><strong>{assignment.kind.replaceAll("-", " ")}</strong></div>
          <div><span>Source status</span><strong>{assignmentSourceStatus(assignment)}</strong></div>
          {assignment.canvasGroup ? <div><span>Canvas group</span><strong>{assignment.canvasGroup}</strong></div> : null}
          {assignment.trackable === false ? <div><span>Dashboard role</span><strong>Information only</strong></div> : null}
        </div>
        {assignment.informationalReason ? <p className="informational-note"><Icon name="info" size={18} />{assignment.informationalReason}</p> : null}
        {assignment.note ? <p className="source-note"><Icon name="info" size={18} />{assignment.note}</p> : null}
        {assignment.sourceUrl ? <a className="source-link" href={assignment.sourceUrl} rel="noreferrer" target="_blank"><Icon name="sources" size={16} />Open Canvas source</a> : null}
        <div className="edit-date-panel">
          <h3>{sourceDate ? "Adjust this date locally" : "Add a verified date"}</h3>
          <p>This changes only your browser copy. It does not update Canvas.</p>
          <label>
            <span>Date</span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label>
            <span>Time or note</span>
            <input placeholder="11:59 PM or Start of class" type="text" value={time} onChange={(event) => setTime(event.target.value)} />
          </label>
          <button className="primary-button" disabled={!canSave} onClick={() => { onSave(assignment.id, { date, time: time || null }); onClose(); }} type="button">
            <Icon name="check" size={18} />Save verified date
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function AttendanceSummary({ summary, attendanceText }) {
  return (
    <div className="attendance-summary-card">
      <span><Icon name="attendance" size={20} />Attendance runway</span>
      <strong>{attendanceText}</strong>
      <small>{summary.checkedCount} of {summary.eligibleCount} class check-ins logged</small>
    </div>
  );
}

export function AttendanceSheet({
  allowancePosition,
  attendanceText,
  checkins,
  course,
  meeting,
  meetingCount,
  meetingIndex,
  onClose,
  onNext,
  onPrevious,
  onSave,
  summary,
}) {
  if (!course) return null;
  const current = meeting
    ? (checkins[meeting.id] || { status: meeting.disabled ? "cancelled" : "not_checked" })
    : null;
  const excuse = meeting?.disabled
    ? null
    : excuseGuidanceForMeeting(course, meeting, current, { allowancePosition });
  const status = meeting?.disabled ? "cancelled" : current?.status || "not_checked";
  const absent = status.startsWith("absent");
  const tracksMissedInClassWork = course.attendancePolicy?.trackMissedInClassAssignment === true
    || course.excuseRules?.some((rule) => /alternative work/iu.test(String(rule?.action || "")));

  return (
    <Sheet eyebrow={course.code} onClose={onClose} title="Class check-in">
      <div className="sheet-body attendance-sheet-body">
        <AttendanceSummary attendanceText={attendanceText} summary={summary} />
        {meeting ? (
          <>
            {meetingIndex >= 0 ? (
              <nav aria-label="Move between eligible class meetings" className="meeting-stepper">
                <button disabled={meetingIndex === 0} onClick={onPrevious} type="button">
                  <Icon name="chevronLeft" size={17} />Previous
                </button>
                <span><strong>{meetingIndex + 1}</strong> of {meetingCount}</span>
                <button disabled={meetingIndex >= meetingCount - 1} onClick={onNext} type="button">
                  Next<Icon name="chevronRight" size={17} />
                </button>
              </nav>
            ) : null}

            <article className={`single-meeting-card${meeting.disabled ? " is-cancelled" : ""}`}>
              <div className="single-meeting-identity">
                <span>{dayName(meeting.date)}</span>
                <strong>{formatLongDate(meeting.date)}</strong>
                <small><Icon name="clock" size={15} />{meeting.time || meeting.startTime || "Time not stated"}</small>
              </div>

              <label className="meeting-status-field">
                <span>Status</span>
                <select
                  aria-label={`Attendance status for ${formatLongDate(meeting.date)}`}
                  disabled={meeting.disabled}
                  onChange={(event) => onSave(meeting.id, { ...current, status: event.target.value })}
                  value={status}
                >
                  {meeting.disabled ? <option value="cancelled">No class</option> : ATTENDANCE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>

              {absent ? (
                <div className="absence-detail-fields">
                  <label>
                    <span>Absence reason</span>
                    <select
                      aria-label={`Absence reason for ${formatLongDate(meeting.date)}`}
                      onChange={(event) => onSave(meeting.id, { ...current, reason: event.target.value })}
                      value={current?.reason || "general"}
                    >
                      {ABSENCE_REASON_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  {tracksMissedInClassWork ? (
                    <label className="missed-assignment-check">
                      <input
                        checked={Boolean(current?.missedInClassAssignment)}
                        onChange={(event) => onSave(meeting.id, { ...current, missedInClassAssignment: event.target.checked })}
                        type="checkbox"
                      />
                      <span>This absence missed an in-class assignment</span>
                    </label>
                  ) : null}
                </div>
              ) : null}

              <div className="excuse-deadline-card">
                <span><Icon name="info" size={16} />Excuse deadline</span>
                <strong>{meeting.disabled ? "Not applicable — no class" : excuse?.label || "Deadline not stated"}</strong>
                {excuse?.note ? <small>{excuse.note}</small> : null}
              </div>
            </article>
          </>
        ) : (
          <div className="sheet-empty">
            <Icon name="calendar" size={25} />
            <h3>No class schedule yet</h3>
            <p>Add this course’s meeting days and times before logging attendance.</p>
          </div>
        )}
      </div>
    </Sheet>
  );
}

function schedulePatternText(pattern) {
  const dayMap = Object.fromEntries(WEEKDAYS);
  const days = (pattern.weekdays || []).map((day) => dayMap[day] || day).join(" · ");
  return [days, pattern.time, pattern.location].filter(Boolean).join(" · ");
}

export function ScheduleSheet({ course, courseConfig, onClose, onSave }) {
  const [selectedOption, setSelectedOption] = useState(courseConfig.sectionByCourse?.[course?.id] || "");
  const [customPatterns, setCustomPatterns] = useState(() => normalizeMeetingPatterns(
    courseConfig.customMeetingsByCourse?.[course?.id],
  ));

  useEffect(() => {
    setSelectedOption(courseConfig.sectionByCourse?.[course?.id] || "");
    setCustomPatterns(normalizeMeetingPatterns(courseConfig.customMeetingsByCourse?.[course?.id]));
  }, [course, courseConfig]);

  if (!course) return null;
  const meetings = Array.isArray(course.meetings) ? course.meetings : [];
  const selectablePatterns = meetings.filter((pattern) => pattern.selectionGate && pattern.optionId);
  const canEditCustomSchedule = meetings.length > 0 && meetings.every((pattern) => (
    pattern.generation === "blocked" || pattern.eventGeneration === "blocked"
  ));
  const visiblePatterns = meetings.filter((pattern) => !pattern.selectionGate || pattern.optionId === selectedOption);
  const officeHours = course.officeHours || { status: "not_stated", entries: [], note: "Office hours have not been audited." };
  const customPatternsComplete = meetingPatternsAreComplete(customPatterns);

  const updateCustomPattern = (index, changes) => {
    setCustomPatterns((patterns) => patterns.map((pattern, patternIndex) => (
      patternIndex === index ? { ...pattern, ...changes } : pattern
    )));
  };

  const toggleCustomDay = (index, day) => {
    const pattern = customPatterns[index];
    const weekdays = pattern.weekdays.includes(day)
      ? pattern.weekdays.filter((value) => value !== day)
      : [...pattern.weekdays, day];
    updateCustomPattern(index, { weekdays });
  };

  const save = () => {
    const update = {};
    if (selectablePatterns.length) {
      update.sectionByCourse = {
        ...(courseConfig.sectionByCourse || {}),
        [course.id]: selectedOption || null,
      };
    }
    if (canEditCustomSchedule && customPatternsComplete) {
      update.customMeetingsByCourse = {
        ...(courseConfig.customMeetingsByCourse || {}),
        [course.id]: serializeMeetingPatterns(customPatterns),
      };
    }
    if (Object.keys(update).length) onSave(update);
    onClose();
  };

  return (
    <Sheet eyebrow={course.code} onClose={onClose} title="Schedule & office hours">
      <div className="sheet-body schedule-sheet-body">
        <header className="schedule-section-heading">
          <span><Icon name="calendar" size={18} /></span>
          <div>
            <h3>Class schedule</h3>
            <p>Recurring meetings for this course</p>
          </div>
        </header>

        {!canEditCustomSchedule ? (
          <div className="schedule-patterns">
            {visiblePatterns.filter((pattern) => pattern.generation !== "blocked").map((pattern) => (
              <div className="schedule-pattern" key={pattern.id}>
                <Icon name="clock" size={18} />
                <div><strong>{schedulePatternText(pattern)}</strong><span>{pattern.timeCertainty === "provisional" ? "Clock time — verify" : pattern.kind}</span></div>
              </div>
            ))}
          </div>
        ) : null}

        {selectablePatterns.length ? (
          <fieldset className="setup-fieldset">
            <legend>Registered section</legend>
            <p>Select only the option that matches your registration.</p>
            <div className="option-grid">
              {[{ optionId: "", label: "Not selected" }, ...selectablePatterns.map((pattern) => ({
                optionId: pattern.optionId,
                label: pattern.optionLabel || `${pattern.optionId} · ${schedulePatternText(pattern)}`,
              }))].map(({ optionId, label }) => (
                <button aria-pressed={selectedOption === optionId} key={optionId || "none"} onClick={() => setSelectedOption(optionId)} type="button">{label}</button>
              ))}
            </div>
          </fieldset>
        ) : null}

        {canEditCustomSchedule ? (
          <fieldset className="setup-fieldset">
            <legend>Recurring meetings</legend>
            <p>The supplied syllabus did not state this section’s schedule. Add every recurring pattern that applies to your registration.</p>
            <div className="enc-pattern-editor-list">
              {customPatterns.map((pattern, index) => (
                <section className="enc-pattern-editor" key={pattern.id}>
                  <header>
                    <strong>Pattern {index + 1}</strong>
                    <button
                      aria-label={`Remove meeting pattern ${index + 1}`}
                      className="remove-pattern-button"
                      onClick={() => setCustomPatterns((patterns) => patterns.filter((_, patternIndex) => patternIndex !== index))}
                      type="button"
                    ><Icon name="close" size={14} />Remove</button>
                  </header>
                  <div className="weekday-picker">
                    {WEEKDAYS.map(([value, label]) => (
                      <button
                        aria-pressed={pattern.weekdays.includes(value)}
                        key={value}
                        onClick={() => toggleCustomDay(index, value)}
                        type="button"
                      >{label}</button>
                    ))}
                  </div>
                  <div className="time-grid">
                    <label><span>Starts</span><input type="time" value={pattern.startTime} onChange={(event) => updateCustomPattern(index, { startTime: event.target.value })} /></label>
                    <label><span>Ends</span><input type="time" value={pattern.endTime} onChange={(event) => updateCustomPattern(index, { endTime: event.target.value })} /></label>
                    <label><span>Periods</span><select value={pattern.countWeight} onChange={(event) => updateCustomPattern(index, { countWeight: Number(event.target.value) })}><option value="1">1 period</option><option value="2">2 periods</option></select></label>
                  </div>
                </section>
              ))}
            </div>
            {!customPatterns.length ? <p className="enc-pattern-empty">No recurring patterns are saved for this course.</p> : null}
            {customPatterns.length && !customPatternsComplete ? <p className="enc-pattern-validation">Choose at least one weekday and a start time for every pattern.</p> : null}
            <button className="add-pattern-button" onClick={() => setCustomPatterns((patterns) => [...patterns, nextMeetingPattern(patterns)])} type="button"><Icon name="plus" size={16} />Add another pattern</button>
          </fieldset>
        ) : null}

        <section aria-labelledby={`office-hours-${course.id}`} className="office-hours-section">
          <header className="schedule-section-heading">
            <span><Icon name="attendance" size={18} /></span>
            <div>
              <h3 id={`office-hours-${course.id}`}>Office hours</h3>
              <p>{officeHours.status === "user" ? "Entered by you during setup" : "Audited from the supplied course syllabus"}</p>
            </div>
          </header>

          {officeHours.entries.length ? (
            <div className="office-hours-list">
              {officeHours.entries.map((entry) => (
                <article className={`office-hours-card is-${entry.status}`} key={entry.id}>
                  <div className="office-hours-card-head">
                    <div>
                      <strong>{entry.person}</strong>
                      <span>{entry.role}</span>
                    </div>
                    <span className="office-hours-status">{officeHoursStatusLabel(entry.status)}</span>
                  </div>
                  <p>{formatOfficeHoursEntry(entry)}</p>
                  {entry.note ? <small>{entry.note}</small> : null}
                </article>
              ))}
            </div>
          ) : (
            <div className="office-hours-empty">
              <Icon name="info" size={19} />
              <div>
                <strong>Not stated in supplied syllabus</strong>
                <p>{officeHours.note}</p>
              </div>
            </div>
          )}

          <p className="office-hours-time-note"><Icon name="info" size={14} />{officeHours.status === "user" ? "Times are shown exactly as you entered them." : "Times are shown exactly as written; the course sources do not state a time zone."}</p>
        </section>

        <button className="primary-button" disabled={canEditCustomSchedule && !customPatternsComplete} onClick={save} type="button"><Icon name="check" size={18} />{canEditCustomSchedule || selectablePatterns.length ? "Save schedule" : "Done"}</button>
      </div>
    </Sheet>
  );
}
