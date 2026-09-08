import { useMemo, useState } from "react";
import { Icon } from "../icons";
import { buildAcademicCoachPlan, daysFromDate, studyCoachQuizUrl } from "../lib/academicCoach.js";
import { formatLongDate } from "../lib/format";

function dueLabel(item, todayKey) {
  const days = daysFromDate(todayKey, item.date);
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}

function QuizCard({ check, completed, onToggle, todayKey }) {
  const date = check.meeting?.date;
  return (
    <article className={`academic-coach-quiz-card${completed ? " is-complete" : ""}`}>
      <div>
        <span>{check.course.code || check.course.title}</span>
        <h4>{check.label}</h4>
        <p>{date ? `${formatLongDate(date)}${check.meeting.time ? ` · ${check.meeting.time}` : ""}` : `Week of ${formatLongDate(check.weekStart || todayKey)}`}</p>
      </div>
      <div className="academic-coach-quiz-actions">
        <a href={studyCoachQuizUrl({ course: check.course, focus: check.focus })} rel="noreferrer" target="_blank"><Icon name="target" size={15} />Start 8-question quiz</a>
        <button aria-pressed={completed} onClick={() => onToggle(check.checkId, !completed)} type="button"><Icon name={completed ? "check" : "clock"} size={15} />{completed ? "Reviewed" : "Mark reviewed"}</button>
      </div>
    </article>
  );
}

export default function AcademicCoachPanel({ assignments, coachState, courses, meetings, onSaveChapter, onToggleCheck, todayKey }) {
  const plan = useMemo(() => buildAcademicCoachPlan({ assignments, courses, meetings, todayKey }), [assignments, courses, meetings, todayKey]);
  const [courseId, setCourseId] = useState(courses[0]?.id || "");
  const activeCourse = courses.find((course) => course.id === courseId) || courses[0] || null;
  const chapter = activeCourse ? coachState?.chapterByCourse?.[activeCourse.id] || "" : "";
  const completed = coachState?.completedChecks || {};
  const chapterFocus = activeCourse && chapter.trim()
    ? `Chapter-finish mastery quiz for ${activeCourse.code || activeCourse.title}: ${chapter.trim()}. Test core claims, vocabulary, mechanisms, examples, comparisons, and application. Include cumulative links to earlier material where the sources support them.`
    : "";

  return (
    <section className="academic-coach" aria-labelledby="academic-coach-title">
      <header className="academic-coach-header">
        <div><span>Always one week ahead</span><h3 id="academic-coach-title">Grade operations center</h3><p>Prepare before class, retrieve after class, close every chapter, and start exams before urgency takes over.</p></div>
        <div className="academic-coach-metrics"><span><strong>{plan.nextTwoWeeks.length}</strong> next 14 days</span><span><strong>{plan.exams.filter((exam) => exam.daysAway <= 14).length}</strong> exams inside 14 days</span></div>
      </header>

      <div className="academic-coach-grid">
        <section className="academic-coach-pane">
          <div className="academic-coach-pane-heading"><span>This week + next</span><h4>Two-week execution queue</h4></div>
          <div className="academic-coach-due-list">
            {plan.nextTwoWeeks.length ? plan.nextTwoWeeks.map((assignment) => {
              const course = courses.find((item) => item.id === assignment.courseId);
              return <article key={assignment.id}><span>{course?.code || assignment.courseId}</span><strong>{assignment.title}</strong><small>{formatLongDate(assignment.date)}{assignment.time ? ` · ${assignment.time}` : " · time not stated"}</small><b>{dueLabel(assignment, todayKey)}</b></article>;
            }) : <p>No dated assignments fall inside the next 14 days.</p>}
          </div>
        </section>

        <section className="academic-coach-pane">
          <div className="academic-coach-pane-heading"><span>Before the room</span><h4>Pre-class checks</h4></div>
          <div className="academic-coach-quiz-list">
            {plan.preClass.length ? plan.preClass.map((check) => <QuizCard check={check} completed={Boolean(completed[check.checkId])} key={check.checkId} onToggle={onToggleCheck} todayKey={todayKey} />) : <p>Add a complete class schedule to activate pre-class checks.</p>}
          </div>
        </section>

        <section className="academic-coach-pane">
          <div className="academic-coach-pane-heading"><span>Lock it in</span><h4>After-class retrieval</h4></div>
          <div className="academic-coach-quiz-list">
            {plan.afterClass.length ? plan.afterClass.map((check) => <QuizCard check={check} completed={Boolean(completed[check.checkId])} key={check.checkId} onToggle={onToggleCheck} todayKey={todayKey} />) : <p>No class meeting from the last two days is available.</p>}
          </div>
        </section>

        <section className="academic-coach-pane">
          <div className="academic-coach-pane-heading"><span>Every seven days</span><h4>Weekly cumulative quizzes</h4></div>
          <div className="academic-coach-quiz-list">
            {plan.weekly.map((check) => <QuizCard check={check} completed={Boolean(completed[check.checkId])} key={check.checkId} onToggle={onToggleCheck} todayKey={todayKey} />)}
          </div>
        </section>
      </div>

      <section className="academic-coach-chapter">
        <div><span>Chapter closure</span><h4>Finish a chapter, then test it</h4><p>Name the completed chapter or unit. Semester Board carries that exact focus into a source-grounded Study Deck quiz.</p></div>
        <div className="academic-coach-chapter-controls">
          <label><span>Course</span><select onChange={(event) => setCourseId(event.target.value)} value={activeCourse?.id || ""}>{courses.map((course) => <option key={course.id} value={course.id}>{course.code || course.title}</option>)}</select></label>
          <label><span>Chapter or unit</span><input maxLength={160} onChange={(event) => activeCourse && onSaveChapter(activeCourse.id, event.target.value)} placeholder="Example: Weber — rationalization" type="text" value={chapter} /></label>
          <a aria-disabled={!chapterFocus} className={!chapterFocus ? "is-disabled" : ""} href={chapterFocus ? studyCoachQuizUrl({ challenge: 7, course: activeCourse, focus: chapterFocus }) : undefined} onClick={(event) => { if (!chapterFocus) event.preventDefault(); }} rel="noreferrer" target="_blank"><Icon name="check" size={16} />Generate chapter quiz</a>
        </div>
      </section>

      <section className="academic-coach-finals">
        <div className="academic-coach-pane-heading"><span>Long runway</span><h4>Midterms and finals</h4></div>
        {plan.exams.length ? <div>{plan.exams.map((exam) => {
          const course = courses.find((item) => item.id === exam.courseId);
          const focus = `Cumulative exam preparation for ${course?.code || course?.title || exam.courseId}: ${exam.title}, scheduled ${exam.date}. Build retrieval around the stated exam scope, course sources, earlier mistakes, and cross-topic comparison.`;
          return <article key={exam.id}><div><span>{course?.code || exam.courseId}</span><strong>{exam.title}</strong><small>{formatLongDate(exam.date)} · {exam.daysAway} days away</small></div><a href={studyCoachQuizUrl({ challenge: 8, course, focus })} rel="noreferrer" target="_blank">Start exam quiz</a></article>;
        })}</div> : <p>No dated midterm, final, or exam is available in this account yet.</p>}
      </section>
    </section>
  );
}
