import { useId, useState } from "react";
import { Icon } from "../icons.jsx";
import { buildManualSemester } from "../lib/manualSemester.js";

const WEEKDAYS = [
  ["MO", "Mon"], ["TU", "Tue"], ["WE", "Wed"], ["TH", "Thu"],
  ["FR", "Fri"], ["SA", "Sat"], ["SU", "Sun"],
];
const ASSIGNMENT_KINDS = [
  ["assignment", "Assignment"], ["quiz", "Quiz"], ["exam", "Exam"],
  ["lab", "Lab"], ["paper", "Paper"], ["presentation", "Presentation"],
  ["project", "Project"],
];

let rowSequence = 0;

function rowKey(prefix) {
  rowSequence += 1;
  return `${prefix}-${rowSequence}`;
}

function emptyCourse() {
  return {
    key: rowKey("course"),
    code: "",
    title: "",
    weekdays: [],
    startTime: "",
    endTime: "",
    location: "",
    instructor: "",
    officeHours: "",
    officeLocation: "",
  };
}

function emptyAssignment(courseKey = "") {
  return {
    key: rowKey("assignment"),
    courseKey,
    title: "",
    date: "",
    time: "",
    kind: "assignment",
  };
}

export default function SemesterSetup({
  cloudMode,
  onImportBackup,
  onOpenDocuments,
  onSaveSemester,
}) {
  const importId = useId();
  const [label, setLabel] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [courses, setCourses] = useState(() => [emptyCourse()]);
  const [assignments, setAssignments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const updateCourse = (key, changes) => {
    setCourses((current) => current.map((course) => (
      course.key === key ? { ...course, ...changes } : course
    )));
    setFeedback(null);
  };

  const toggleCourseDay = (key, day) => {
    const course = courses.find((item) => item.key === key);
    const weekdays = course.weekdays.includes(day)
      ? course.weekdays.filter((value) => value !== day)
      : [...course.weekdays, day];
    updateCourse(key, { weekdays });
  };

  const removeCourse = (key) => {
    if (courses.length === 1) return;
    setCourses((current) => current.filter((course) => course.key !== key));
    setAssignments((current) => current.filter((assignment) => assignment.courseKey !== key));
  };

  const updateAssignment = (key, changes) => {
    setAssignments((current) => current.map((assignment) => (
      assignment.key === key ? { ...assignment, ...changes } : assignment
    )));
    setFeedback(null);
  };

  const saveSemester = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const semester = buildManualSemester({ label, startDate, endDate, courses, assignments });
      await onSaveSemester(semester);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "The semester could not be created.");
      setBusy(false);
    }
  };

  const importSemester = async (event) => {
    const [file] = event.target.files;
    event.target.value = "";
    if (!file || busy) return;
    setBusy(true);
    try {
      await onImportBackup(file);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="semester-setup is-guided" aria-labelledby="semester-setup-title">
      <form className="semester-setup-card" onSubmit={saveSemester}>
        <header className="semester-setup-heading">
          <span><Icon name="calendar" size={24} /></span>
          <div>
            <small>{cloudMode ? "Private account semester" : "Device-only semester"}</small>
            <h2 id="semester-setup-title">Set up your semester</h2>
            <p>Add the basics here—no JSON file and no AI required. You can store syllabi separately in Documents.</p>
          </div>
        </header>

        <section className="semester-setup-section" aria-labelledby="semester-term-title">
          <div className="semester-setup-section-heading">
            <span>1</span>
            <div><h3 id="semester-term-title">Semester dates</h3><p>These dates create the board timeline.</p></div>
          </div>
          <div className="semester-setup-term-fields">
            <label><span>Semester name</span><input maxLength={80} onChange={(event) => setLabel(event.target.value)} placeholder="Example: Fall 2026" required value={label} /></label>
            <label><span>First class date</span><input onChange={(event) => setStartDate(event.target.value)} required type="date" value={startDate} /></label>
            <label><span>Last class date</span><input min={startDate || undefined} onChange={(event) => setEndDate(event.target.value)} required type="date" value={endDate} /></label>
          </div>
        </section>

        <section className="semester-setup-section" aria-labelledby="semester-courses-title">
          <div className="semester-setup-section-heading">
            <span>2</span>
            <div><h3 id="semester-courses-title">Your courses</h3><p>Course code and name are required. Schedule and office hours are optional.</p></div>
          </div>
          <div className="semester-course-editor-list">
            {courses.map((course, index) => (
              <article className="semester-course-editor" key={course.key}>
                <header>
                  <strong>Course {index + 1}</strong>
                  {courses.length > 1 ? <button aria-label={`Remove course ${index + 1}`} onClick={() => removeCourse(course.key)} type="button"><Icon name="close" size={14} />Remove</button> : null}
                </header>
                <div className="semester-course-basics">
                  <label><span>Course code</span><input maxLength={40} onChange={(event) => updateCourse(course.key, { code: event.target.value })} placeholder="Example: PSY 2012" required value={course.code} /></label>
                  <label><span>Course name</span><input maxLength={160} onChange={(event) => updateCourse(course.key, { title: event.target.value })} placeholder="Example: General Psychology" required value={course.title} /></label>
                </div>
                <details className="semester-course-optional">
                  <summary>Add class schedule and office hours</summary>
                  <div className="semester-course-optional-body">
                    <fieldset>
                      <legend>Class days</legend>
                      <div className="semester-weekday-picker">
                        {WEEKDAYS.map(([value, dayLabel]) => <button aria-pressed={course.weekdays.includes(value)} key={value} onClick={() => toggleCourseDay(course.key, value)} type="button">{dayLabel}</button>)}
                      </div>
                    </fieldset>
                    <div className="semester-course-schedule-fields">
                      <label><span>Starts</span><input onChange={(event) => updateCourse(course.key, { startTime: event.target.value })} type="time" value={course.startTime} /></label>
                      <label><span>Ends</span><input onChange={(event) => updateCourse(course.key, { endTime: event.target.value })} type="time" value={course.endTime} /></label>
                      <label><span>Location</span><input maxLength={180} onChange={(event) => updateCourse(course.key, { location: event.target.value })} placeholder="Room or online" value={course.location} /></label>
                    </div>
                    <div className="semester-course-office-fields">
                      <label><span>Instructor</span><input maxLength={120} onChange={(event) => updateCourse(course.key, { instructor: event.target.value })} placeholder="Optional" value={course.instructor} /></label>
                      <label><span>Office hours</span><input maxLength={240} onChange={(event) => updateCourse(course.key, { officeHours: event.target.value })} placeholder="Example: Tue 2–4 PM or by appointment" value={course.officeHours} /></label>
                      <label><span>Office location</span><input maxLength={180} onChange={(event) => updateCourse(course.key, { officeLocation: event.target.value })} placeholder="Optional" value={course.officeLocation} /></label>
                    </div>
                  </div>
                </details>
              </article>
            ))}
          </div>
          <button className="semester-add-row" onClick={() => setCourses((current) => [...current, emptyCourse()])} type="button"><Icon name="plus" size={16} />Add another course</button>
        </section>

        <details className="semester-setup-section semester-assignment-editor" open={assignments.length > 0}>
          <summary><span>3</span><div><h3>Assignments and exams</h3><p>Optional—you can add known coursework now.</p></div><Icon name="chevronDown" size={17} /></summary>
          <div className="semester-assignment-list">
            {assignments.map((assignment, index) => (
              <article key={assignment.key}>
                <header><strong>Item {index + 1}</strong><button aria-label={`Remove assignment ${index + 1}`} onClick={() => setAssignments((current) => current.filter((item) => item.key !== assignment.key))} type="button"><Icon name="close" size={14} />Remove</button></header>
                <div className="semester-assignment-fields">
                  <label><span>Course</span><select onChange={(event) => updateAssignment(assignment.key, { courseKey: event.target.value })} required value={assignment.courseKey}><option value="">Choose course</option>{courses.map((course, courseIndex) => <option key={course.key} value={course.key}>{course.code || `Course ${courseIndex + 1}`}</option>)}</select></label>
                  <label><span>Title</span><input maxLength={240} onChange={(event) => updateAssignment(assignment.key, { title: event.target.value })} placeholder="Assignment title" required value={assignment.title} /></label>
                  <label><span>Type</span><select onChange={(event) => updateAssignment(assignment.key, { kind: event.target.value })} value={assignment.kind}>{ASSIGNMENT_KINDS.map(([value, kindLabel]) => <option key={value} value={value}>{kindLabel}</option>)}</select></label>
                  <label><span>Due date</span><input onChange={(event) => updateAssignment(assignment.key, { date: event.target.value })} type="date" value={assignment.date} /></label>
                  <label><span>Time</span><input disabled={!assignment.date} onChange={(event) => updateAssignment(assignment.key, { time: event.target.value })} type="time" value={assignment.time} /></label>
                </div>
              </article>
            ))}
            <button className="semester-add-row" onClick={() => setAssignments((current) => [...current, emptyAssignment(courses[0]?.key)])} type="button"><Icon name="plus" size={16} />Add assignment or exam</button>
          </div>
        </details>

        {feedback ? <p className="semester-setup-message is-error" role="alert"><Icon name="warning" size={17} />{feedback}</p> : null}

        <button className="semester-setup-primary" disabled={busy} type="submit"><Icon name="check" size={18} />{busy ? "Creating semester…" : "Create semester board"}</button>

        <div className="semester-setup-alternatives">
          <button onClick={onOpenDocuments} type="button"><Icon name="document" size={17} />Store syllabi and course documents</button>
          <label htmlFor={importId}><Icon name="upload" size={17} />Import an existing JSON backup</label>
          <input accept="application/json,.json" className="visually-hidden" disabled={busy} id={importId} onChange={importSemester} type="file" />
        </div>

        <p className="semester-setup-boundary"><Icon name="info" size={17} /><span>Syllabus files remain private references and do not fill schedule fields automatically. This setup makes no AI request.</span></p>
      </form>
    </main>
  );
}
