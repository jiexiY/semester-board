import { Fragment, useEffect, useRef } from "react";
import { Icon } from "../icons";
import { dayName, formatShortDate } from "../lib/format";
import { monthLabel } from "../lib/board";
import { CourseLaneHeader, TimelineItem } from "./CourseLane";

function DayCell({
  active,
  cell,
  checkins,
  completed,
  course,
  index,
  onAssignment,
  onMeeting,
  onToggle,
}) {
  const empty = cell.events.length === 0;
  return (
    <div
      aria-label={`${course.code}: ${empty ? "No scheduled items" : `${cell.events.length} scheduled item${cell.events.length === 1 ? "" : "s"}`}`}
      className={`aligned-day-cell course-column-${index + 1}${empty ? " is-empty" : " has-events"}${active ? " is-mobile-active" : ""}`}
      data-course-id={course.id}
    >
      {empty ? null : (
        <div className="aligned-day-items">
          {cell.events.map((event) => (
            <TimelineItem
              checkins={checkins}
              completed={completed}
              event={event}
              hideDate
              key={event.id}
              onAssignment={(assignment) => onAssignment(course, assignment)}
              onMeeting={(meeting) => onMeeting(course, meeting)}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UndatedCell({
  active,
  checkins,
  completed,
  course,
  events,
  index,
  onAssignment,
  onMeeting,
  onToggle,
}) {
  if (!events.length) {
    return (
      <div
        aria-label={`${course.code}: No dates to confirm`}
        className={`aligned-undated-cell is-empty course-column-${index + 1}${active ? " is-mobile-active" : ""}`}
      />
    );
  }

  return (
    <details
      className={`aligned-undated-cell course-column-${index + 1}${active ? " is-mobile-active" : ""}`}
      open={events.length <= 4}
    >
      <summary>
        <span>{events.length} date{events.length === 1 ? "" : "s"} needed</span>
        <Icon name="chevronDown" size={16} />
      </summary>
      <div className="aligned-undated-items">
        {events.map((event) => (
          <TimelineItem
            checkins={checkins}
            completed={completed}
            event={event}
            key={event.id}
            onAssignment={(assignment) => onAssignment(course, assignment)}
            onMeeting={(meeting) => onMeeting(course, meeting)}
            onToggle={onToggle}
            undated
          />
        ))}
      </div>
    </details>
  );
}

function OutsideCell({
  active,
  checkins,
  completed,
  course,
  events,
  index,
  onAssignment,
  onMeeting,
  onToggle,
}) {
  if (!events.length) {
    return (
      <div
        aria-label={`${course.code}: No items outside official term dates`}
        className={`aligned-undated-cell is-empty course-column-${index + 1}${active ? " is-mobile-active" : ""}`}
      />
    );
  }

  return (
    <details className={`aligned-undated-cell course-column-${index + 1}${active ? " is-mobile-active" : ""}`}>
      <summary>
        <span>{events.length} outside date{events.length === 1 ? "" : "s"}</span>
        <Icon name="chevronDown" size={16} />
      </summary>
      <div className="aligned-undated-items">
        {events.map((event) => (
          <TimelineItem
            checkins={checkins}
            completed={completed}
            event={event}
            key={event.id}
            onAssignment={(assignment) => onAssignment(course, assignment)}
            onMeeting={(meeting) => onMeeting(course, meeting)}
            onToggle={onToggle}
          />
        ))}
      </div>
    </details>
  );
}

export default function AlignedSemesterBoard({
  activeCourseIndex,
  checkins,
  completed,
  dayRows,
  lanes,
  onAssignment,
  onAttendance,
  onMeeting,
  onSchedule,
  onToggle,
  outsideCells = [],
  todayFraction,
  todayKey,
}) {
  const scrollRef = useRef(null);
  const todayRowRef = useRef(null);
  const lastAutoScrolledDate = useRef(null);

  useEffect(() => {
    if (!todayRowRef.current || lastAutoScrolledDate.current === todayKey) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const board = scrollRef.current;
      const row = todayRowRef.current;
      const header = board?.querySelector(".aligned-header-row");
      if (!board || !row) return;
      const boardTop = board.getBoundingClientRect().top;
      const rowTop = row.getBoundingClientRect().top;
      const target = board.scrollTop + rowTop - boardTop - (header?.offsetHeight || 0) - 14;
      board.scrollTop = Math.max(0, target);
      lastAutoScrolledDate.current = todayKey;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dayRows.length, todayKey]);

  return (
    <main
      className="course-board"
      aria-label={`Aligned day-by-day semester board with ${lanes.length} course${lanes.length === 1 ? "" : "s"}`}
      ref={scrollRef}
    >
      <div className="aligned-board" id="aligned-semester-board">
        <div className="aligned-header-row">
          <div className="date-axis-head" aria-hidden="true">Day</div>
          {lanes.map((lane, index) => (
            <section
              aria-label={`${lane.course.code} ${lane.course.title}`}
              className={`aligned-course-head course-column-${index + 1}${activeCourseIndex === index ? " is-mobile-active" : ""}`}
              data-course-id={lane.course.id}
              id={`course-column-${index}`}
              key={lane.course.id}
            >
              <CourseLaneHeader
                attendanceText={lane.attendanceText}
                course={lane.course}
                onAttendance={() => onAttendance(lane)}
                onSchedule={() => onSchedule(lane.course)}
                scheduleText={lane.scheduleText}
              />
            </section>
          ))}
        </div>

        <div className="aligned-day-grid" aria-label="Shared calendar days">
          {dayRows.map((row) => (
            <Fragment key={row.date}>
              {row.monthStart ? (
                <div className="shared-month-divider">
                  <span>{monthLabel(row.date)}</span>
                  <i />
                </div>
              ) : null}
              <section
                aria-current={row.date === todayKey ? "date" : undefined}
                aria-label={`${dayName(row.date, "long")}, ${formatShortDate(row.date)}`}
                className={`shared-day-row${row.empty ? " is-empty-day" : " has-events"}${row.date === todayKey ? " is-today" : ""}`}
                data-date={row.date}
                ref={row.date === todayKey ? todayRowRef : null}
              >
                <header className="shared-day-label">
                  <small>{dayName(row.date)}</small>
                  <strong>{formatShortDate(row.date)}</strong>
                </header>
                {lanes.map((lane, index) => (
                  <DayCell
                    active={activeCourseIndex === index}
                    cell={row.cells[index]}
                    checkins={checkins}
                    completed={completed}
                    course={lane.course}
                    index={index}
                    key={lane.course.id}
                    onAssignment={onAssignment}
                    onMeeting={onMeeting}
                    onToggle={onToggle}
                  />
                ))}
                {row.date === todayKey ? (
                  <div
                    aria-label={`Today, ${formatShortDate(todayKey)} — current time across all courses`}
                    className="exact-current-day-line"
                    role="img"
                    style={{ "--today-row-position": `${(todayFraction * 100).toFixed(4)}%` }}
                  >
                    <span>Today · {formatShortDate(todayKey)}</span>
                  </div>
                ) : null}
              </section>
            </Fragment>
          ))}

          {outsideCells.some((cell) => cell.events.length) ? (
            <section className="aligned-undated-section" aria-label="Items outside official term dates">
              <div className="shared-month-divider is-undated-divider">
                <span>Outside official term dates</span>
                <i />
              </div>
              <div className="aligned-undated-row">
                <div className="undated-axis-label">Outside term</div>
                {lanes.map((lane, index) => (
                  <OutsideCell
                    active={activeCourseIndex === index}
                    checkins={checkins}
                    completed={completed}
                    course={lane.course}
                    events={outsideCells[index]?.events || []}
                    index={index}
                    key={lane.course.id}
                    onAssignment={onAssignment}
                    onMeeting={onMeeting}
                    onToggle={onToggle}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section className="aligned-undated-section" aria-label="Dates to confirm">
            <div className="shared-month-divider is-undated-divider">
              <span>Dates to confirm</span>
              <i />
            </div>
            <div className="aligned-undated-row">
              <div className="undated-axis-label">Unscheduled</div>
              {lanes.map((lane, index) => (
                <UndatedCell
                  active={activeCourseIndex === index}
                  checkins={checkins}
                  completed={completed}
                  course={lane.course}
                  events={lane.timeline.undated}
                  index={index}
                  key={lane.course.id}
                  onAssignment={onAssignment}
                  onMeeting={onMeeting}
                  onToggle={onToggle}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
