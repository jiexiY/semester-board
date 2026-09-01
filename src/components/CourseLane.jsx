import { Icon } from "../icons";
import { dayName, formatShortDate, statusLabel } from "../lib/format";
import { TASK_CATEGORY_META } from "./TaskLegend";

function certaintyText(assignment) {
  if (assignment._overridden) return "Your date";
  if (assignment.sourceStatus === "syllabus-only") return "Syllabus only";
  if (assignment.sourceStatus === "canvas-file-undated") return "Canvas file";
  if (assignment.dateCertainty === "confirmed") return "Confirmed";
  if (assignment.dateCertainty === "derived") return "Forecast";
  if (assignment.dateCertainty === "provisional") return "Verify";
  return "Date needed";
}

function meetingTitle(meeting) {
  if (meeting.disabled) return meeting.label || "No class";
  if (meeting.kind === "discussion") return "Discussion section";
  if (meeting.kind === "lecture") return "Class lecture";
  return "Class meeting";
}

export function TimelineItem({
  checkins,
  completed,
  event,
  hideDate = false,
  onAssignment,
  onMeeting,
  onToggle,
  undated = false,
}) {
  const isMeeting = event.source === "meeting";
  const isSchedule = event.source === "schedule";
  const assignment = event.assignment;
  const meeting = event.meeting;
  const scheduleEvent = event.scheduleEvent;
  const courseworkRecord = isSchedule ? scheduleEvent : assignment;
  const informational = isSchedule || (!isMeeting && assignment?.trackable === false);
  const category = event.category || "assignment";
  const meta = TASK_CATEGORY_META[category] || TASK_CATEGORY_META.assignment;
  const cancelled = Boolean(event.cancelled || meeting?.disabled);
  const itemComplete = !isMeeting && !informational && Boolean(completed[assignment.id]);
  const currentStatus = isMeeting
    ? (cancelled ? "No class" : statusLabel(checkins[meeting.id]?.status || "not_checked"))
    : (isSchedule ? certaintyText(scheduleEvent) : certaintyText(assignment));
  const title = isMeeting ? meetingTitle(meeting) : event.title;
  const time = event.time || (isMeeting ? meeting.startTime || meeting.time : assignment?.time);
  const open = () => {
    if (isMeeting) return onMeeting(meeting);
    if (isSchedule) return onAssignment(scheduleEvent);
    return onAssignment(assignment);
  };

  return (
    <article
      className={`timeline-item task-${category}${itemComplete ? " is-complete" : ""}${undated ? " is-undated" : ""}${hideDate ? " is-aligned-day" : ""}${cancelled ? " is-cancelled" : ""}${informational ? " is-informational" : ""}`}
      data-event-type={category}
    >
      <span className="rail-dot" aria-hidden="true" />
      {!undated && !hideDate ? (
        <div className="timeline-date">
          <small>{dayName(event.date)}</small>
          <strong>{formatShortDate(event.date)}</strong>
        </div>
      ) : null}
      <button className="timeline-copy" onClick={open} type="button">
        <strong>{title}</strong>
        <span className="timeline-meta">
          <span className="task-type-label"><Icon name={meta.icon} size={12} strokeWidth={1.9} />{meta.label}</span>
          <i aria-hidden="true">·</i>
          <span>{time || "Time not stated"}</span>
        </span>
      </button>
      <span className={`certainty-label${isMeeting ? " meeting-state-label" : ` certainty-${courseworkRecord?.dateCertainty || "tbd"}`}`}>{currentStatus}</span>
      {isMeeting ? (
        <button
          aria-label={`Open attendance for ${title} on ${formatShortDate(event.date)}`}
          className="meeting-status-control"
          disabled={cancelled}
          onClick={open}
          type="button"
        >
          <Icon name={cancelled ? "close" : "attendance"} size={15} strokeWidth={1.9} />
        </button>
      ) : informational ? (
        <span
          aria-label={`${title} is informational and has no completion checkbox`}
          className="informational-control"
          title="Information only"
        >
          <Icon name="info" size={15} strokeWidth={1.9} />
        </span>
      ) : (
        <button
          aria-checked={itemComplete}
          aria-label={`${itemComplete ? "Reopen" : "Complete"} ${assignment.title}`}
          className="completion-control"
          onClick={() => onToggle(assignment.id)}
          role="checkbox"
          type="button"
        >
          {itemComplete ? <Icon name="check" size={16} strokeWidth={2.2} /> : null}
        </button>
      )}
    </article>
  );
}

export function CourseLaneHeader({
  attendanceText,
  course,
  onAttendance,
  onSchedule,
  scheduleText,
}) {
  return (
    <div className="lane-head">
      <div className="course-heading">
        <h2>{course.code}</h2>
        <p>{course.title}</p>
      </div>
      <button
        aria-label={`Open schedule and office hours for ${course.code}`}
        className="lane-info-button"
        onClick={onSchedule}
        title="Schedule & office hours"
        type="button"
      >
        <Icon name="calendar" size={18} />
        <span>{scheduleText}</span>
        <Icon name="chevronRight" size={16} />
      </button>
      <button className="lane-info-button" onClick={onAttendance} type="button">
        <Icon name="attendance" size={18} />
        <span>{attendanceText}</span>
        <Icon name="chevronRight" size={16} />
      </button>
    </div>
  );
}

export default function CourseLane({
  active,
  attendanceText,
  checkins,
  completed,
  course,
  laneNumber,
  onAssignment,
  onAttendance,
  onMeeting,
  onSchedule,
  onToggle,
  scheduleText,
  timeline,
}) {
  return (
    <section
      aria-label={`${course.code} ${course.title}`}
      className={`course-lane lane-${laneNumber}${active ? " is-mobile-active" : ""}`}
      data-course-id={course.id}
    >
      <CourseLaneHeader
        attendanceText={attendanceText}
        course={course}
        onAttendance={onAttendance}
        onSchedule={onSchedule}
        scheduleText={scheduleText}
      />

      <div className="lane-scroll">
        <div className="timeline" aria-label={`${course.code} chronological classes and coursework`}>
          {timeline.monthGroups.length ? timeline.monthGroups.map((group) => (
            <section className="month-group" key={group.key}>
              <div className="month-divider"><span>{group.label}</span><i /></div>
              <div className="month-items">
                {group.items.map((event) => (
                  <TimelineItem
                    checkins={checkins}
                    completed={completed}
                    event={event}
                    key={event.id}
                    onAssignment={onAssignment}
                    onMeeting={onMeeting}
                    onToggle={onToggle}
                  />
                ))}
              </div>
            </section>
          )) : (
            <div className="timeline-empty">
              <Icon name="calendar" size={23} />
              <strong>No dated work yet</strong>
              <p>Add dates only after Canvas or your instructor confirms them.</p>
            </div>
          )}

          {timeline.undated.length ? (
            <details className="undated-group" open={timeline.dated.length <= 3}>
              <summary>
                <span>Dates to confirm</span>
                <strong>{timeline.undated.length}</strong>
                <Icon name="chevronDown" size={16} />
              </summary>
              <div className="undated-items">
                {timeline.undated.map((event) => (
                  <TimelineItem
                    checkins={checkins}
                    completed={completed}
                    event={event}
                    key={event.id}
                    onAssignment={onAssignment}
                    onMeeting={onMeeting}
                    onToggle={onToggle}
                    undated
                  />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </section>
  );
}
