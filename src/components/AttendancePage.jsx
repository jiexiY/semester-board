import { useMemo, useState } from "react";
import { Icon } from "../icons";
import { formatLongDate, statusLabel } from "../lib/format";

const STATUS_OPTIONS = [
  ["present", "Present"],
  ["late", "Late"],
  ["absent_excused", "Excused absence"],
  ["absent_pending", "Absent — pending excuse"],
  ["absent_unexcused", "Unexcused absence"],
];

const SUMMARY_METRICS = [
  { key: "present", label: "Present", icon: "check" },
  { key: "absent_excused", label: "Excused", icon: "shield" },
  { key: "absent_pending", label: "Pending", icon: "clock" },
];

const COURSE_METRICS = [
  ["present", "Present"],
  ["absent_unexcused", "Unexcused"],
  ["absent_excused", "Excused"],
  ["absent_pending", "Pending"],
];

function countOf(counts, key) {
  const value = Number(counts?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function isRecorded(record) {
  return Boolean(record?.status)
    && record.status !== "not_checked"
    && record.status !== "cancelled";
}

function recordIdentifier(record) {
  return record?.meetingId || record?.id || null;
}

function compareRecords(left, right) {
  if (left.date && right.date && left.date !== right.date) {
    return right.date.localeCompare(left.date);
  }
  if (left.date !== right.date) return left.date ? -1 : 1;
  return left.courseCode.localeCompare(right.courseCode);
}

function policySummary(row) {
  if (row.attendanceText) return row.attendanceText;
  const summary = row.summary;
  if (!summary) return row.course?.attendancePolicy?.note || null;
  if (summary.limitKnown === false) {
    return `${summary.confirmedCount ?? 0} unexcused recorded · limit not stated`;
  }
  if (Number.isFinite(summary.remaining)) {
    const unit = summary.countUnit === "period" ? "policy periods" : "policy absences";
    return `${summary.remaining} ${unit} remaining`;
  }
  const finalCounter = summary.counters?.at(-1);
  if (Number.isFinite(finalCounter?.confirmedRemaining)) {
    return `${finalCounter.confirmedRemaining} meetings before ${finalCounter.label.toLowerCase()}`;
  }
  return summary.metricLabel || row.course?.attendancePolicy?.note || null;
}

function EmptyRecords({ icon = "attendance", title, children }) {
  return (
    <div className="attendance-page-empty" role="status">
      <span className="attendance-page-empty-icon"><Icon name={icon} size={23} /></span>
      <div>
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}

function AttendanceRecord({ record, todayKey, onUpdateRecord }) {
  const updateId = recordIdentifier(record);
  const isToday = Boolean(record.date && record.date === todayKey);
  const detail = record.evidence || record.note;

  return (
    <li className={`attendance-record attendance-record-${record.status.replaceAll("_", "-")}`}>
      <div className="attendance-record-date">
        <Icon name="calendar" size={17} />
        <span>
          <strong>{record.date ? formatLongDate(record.date) : "Date not stated"}</strong>
          <small>{isToday ? "Today" : record.time || "Attendance record"}</small>
        </span>
      </div>

      <div className="attendance-record-course">
        <strong>{record.courseCode}</strong>
        <small>{record.courseTitle}</small>
      </div>

      <div className="attendance-record-source">
        <span>{record.source || (record.manualRecord ? "Canvas" : "Dashboard")}</span>
        {record.manualRecord ? <small>Manual record</small> : null}
      </div>

      {record.manualRecord && updateId ? (
        <label className="attendance-record-status-control">
          <span className="attendance-page-visually-hidden">Status for {record.courseCode} {record.date ? formatLongDate(record.date) : "record without a date"}</span>
          <select
            aria-label={`Status for ${record.courseCode} ${record.date ? formatLongDate(record.date) : "record without a date"}`}
            onChange={(event) => onUpdateRecord(updateId, { status: event.target.value })}
            value={record.status}
          >
            {STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      ) : (
        <span className={`attendance-record-status attendance-status-${record.status.replaceAll("_", "-")}`}>
          {statusLabel(record.status)}
        </span>
      )}

      {detail ? <p className="attendance-record-evidence"><Icon name="sources" size={15} />{detail}</p> : null}
    </li>
  );
}

function MigrationReviewRecord({ record, onUpdateRecord }) {
  const updateId = recordIdentifier(record);
  const status = record.status || "not_checked";

  return (
    <li className="attendance-record attendance-record-review">
      <div className="attendance-record-date">
        <Icon name="warning" size={17} />
        <span>
          <strong>{record.date ? formatLongDate(record.date) : "Date not stated"}</strong>
          <small>Previous user-entered schedule</small>
        </span>
      </div>

      <div className="attendance-record-course">
        <strong>{record.courseCode}</strong>
        <small>{record.courseTitle}</small>
      </div>

      <div className="attendance-record-source">
        <span>{statusLabel(status)}</span>
        <small>Excluded from totals</small>
      </div>

      <div className="attendance-review-actions">
        <button
          onClick={() => onUpdateRecord(updateId, {
            checkInEnabled: true,
            disabled: false,
            eligible: true,
            manualRecord: true,
            migrationReview: null,
            source: "Previous schedule — confirmed manually",
          })}
          type="button"
        >Keep as manual</button>
        <button
          onClick={() => onUpdateRecord(updateId, {
            checkInEnabled: false,
            disabled: true,
            eligible: false,
            manualRecord: true,
            migrationReview: null,
            source: "Previous schedule — excluded manually",
          })}
          type="button"
        >Exclude</button>
      </div>

      <p className="attendance-record-evidence">
        <Icon name="info" size={15} />
        This old check-in could not be matched safely to one current class meeting. Choose whether it should remain as a manual attendance record.
      </p>
    </li>
  );
}

function CourseSummaryCard({ row, onOpenCourse }) {
  const courseCode = row.course?.code || row.courseId;
  const courseTitle = row.course?.title || row.course?.shortTitle || "Course";
  const policy = policySummary(row);

  return (
    <article className="attendance-course-card">
      <header className="attendance-course-card-header">
        <div>
          <h4>{courseCode}</h4>
          <p>{courseTitle}</p>
        </div>
        <button
          aria-label={`Open ${courseCode} attendance check-ins`}
          className="attendance-course-open"
          onClick={() => onOpenCourse(row.courseId)}
          type="button"
        >
          Open <Icon name="chevronRight" size={16} />
        </button>
      </header>

      <dl className="attendance-course-counts">
        {COURSE_METRICS.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{countOf(row.counts, key)}</dd>
          </div>
        ))}
      </dl>

      <div className="attendance-course-footer">
        <p>{policy || "No policy calculation is available for this course."}</p>
        <small>{countOf(row.counts, "not_checked")} not checked in this dashboard</small>
      </div>
    </article>
  );
}

function AddCanvasRecord({ rows, onAddRecord, storageMode }) {
  const cloudMode = storageMode === "cloud";
  const firstCourseId = rows[0]?.courseId || "";
  const [courseId, setCourseId] = useState("");
  const [status, setStatus] = useState("absent_unexcused");
  const [date, setDate] = useState("");
  const [evidence, setEvidence] = useState("");
  const selectedCourseId = courseId || firstCourseId;

  const handleSubmit = (event) => {
    event.preventDefault();
    const cleanEvidence = evidence.trim();
    if (!selectedCourseId || !cleanEvidence) return;

    onAddRecord({
      manualRecord: true,
      courseId: selectedCourseId,
      date: date || null,
      status,
      source: "Canvas",
      note: cleanEvidence,
      evidence: cleanEvidence,
    });

    setCourseId("");
    setStatus("absent_unexcused");
    setDate("");
    setEvidence("");
  };

  return (
    <details className="attendance-page-add-record">
      <summary>
        <span className="attendance-page-add-icon"><Icon name="plus" size={18} /></span>
        <span><strong>Add Canvas record</strong><small>Enter only what Canvas actually shows.</small></span>
        <Icon name="chevronDown" size={17} />
      </summary>

      <form className="attendance-page-add-form" onSubmit={handleSubmit}>
        <p className="attendance-page-form-note"><Icon name="info" size={16} />This saves a record {cloudMode ? "to your synced account" : "in this browser"}. It does not change Canvas.</p>

        <div className="attendance-page-form-grid">
          <label>
            <span>Course</span>
            <select required value={selectedCourseId} onChange={(event) => setCourseId(event.target.value)}>
              {rows.map((row) => (
                <option key={row.courseId} value={row.courseId}>{row.course?.code || row.courseId}</option>
              ))}
            </select>
          </label>

          <label>
            <span>Status</span>
            <select required value={status} onChange={(event) => setStatus(event.target.value)}>
              {STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>

          <label>
            <span>Date <small>Optional</small></span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>

          <label className="attendance-page-evidence-field">
            <span>Canvas evidence</span>
            <input
              placeholder="Example: Canvas attendance shows Unexcused"
              required
              type="text"
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
            />
          </label>
        </div>

        <button className="attendance-page-save-record" disabled={!selectedCourseId || !evidence.trim()} type="submit">
          <Icon name="plus" size={17} />{cloudMode ? "Save account record" : "Save local record"}
        </button>
      </form>
    </details>
  );
}

export default function AttendancePage({
  rows = [],
  totals = {},
  todayKey,
  onAddRecord,
  onOpenCourse,
  onUpdateRecord,
  storageMode = "local",
}) {
  const cloudMode = storageMode === "cloud";
  const counts = totals.counts || {};
  const records = useMemo(() => rows.flatMap((row) => {
    const manualIds = new Set((row.manualRecords || []).map(recordIdentifier).filter(Boolean));
    return (row.records || [])
      .filter(isRecorded)
      .map((record, index) => ({
        ...record,
        courseId: row.courseId,
        courseCode: row.course?.code || row.courseId,
        courseTitle: row.course?.shortTitle || row.course?.title || "Course",
        manualRecord: record.manualRecord === true
          || manualIds.has(recordIdentifier(record)),
        pageKey: recordIdentifier(record)
          || `${row.courseId}-${record.date || "undated"}-${record.status}-${index}`,
      }));
  }).sort(compareRecords), [rows]);
  const unexcusedRecords = records.filter((record) => record.status === "absent_unexcused");
  const reviewRecords = useMemo(() => rows.flatMap((row) => (
    (row.reviewRecords || []).map((record, index) => ({
      ...record,
      courseId: row.courseId,
      courseCode: row.course?.code || row.courseId,
      courseTitle: row.course?.shortTitle || row.course?.title || "Course",
      pageKey: recordIdentifier(record) || `${row.courseId}-review-${index}`,
    }))
  )), [rows]);

  return (
    <main
      aria-labelledby="attendance-page-title"
      className="attendance-page"
      id="attendance-page"
      role="tabpanel"
    >
      <header className="attendance-page-header">
        <div className="attendance-page-title-group">
          <span className="attendance-page-title-icon"><Icon name="attendance" size={25} /></span>
          <div>
            <h2 id="attendance-page-title">Attendance</h2>
            <p>Presence and absence records across your private courses.</p>
          </div>
        </div>
        <p className="attendance-page-local-note"><Icon name="shield" size={16} />{cloudMode ? "Private account sync" : "Recorded on this device"}</p>
      </header>

      <section className="attendance-page-overview" aria-label="Attendance totals">
        <article className="attendance-page-primary-total">
          <span>Unexcused absences</span>
          <strong>{countOf(counts, "absent_unexcused")}</strong>
          <p>{cloudMode ? "Synced privately" : "Recorded locally"} across {totals.courseCount ?? rows.length} courses</p>
        </article>

        <div className="attendance-page-summary-grid">
          {SUMMARY_METRICS.map((metric) => (
            <article className={`attendance-page-summary-stat attendance-summary-${metric.key.replaceAll("_", "-")}`} key={metric.key}>
              <span><Icon name={metric.icon} size={18} />{metric.label}</span>
              <strong>{countOf(counts, metric.key)}</strong>
            </article>
          ))}
        </div>

        <div className="attendance-page-unchecked">
          <Icon name="info" size={19} />
          <div>
            <strong>{countOf(counts, "not_checked")} class meetings not checked in this dashboard</strong>
            <p>Not checked means unknown. It does not mean absent.</p>
          </div>
        </div>
      </section>

      <AddCanvasRecord rows={rows} onAddRecord={onAddRecord} storageMode={storageMode} />

      {reviewRecords.length ? (
        <section className="attendance-page-review" aria-labelledby="attendance-page-review-title">
          <div className="attendance-page-section-heading">
            <div>
              <h3 id="attendance-page-review-title">Schedule migration review</h3>
              <p>These old schedule records are preserved but do not affect any attendance total until you confirm them.</p>
            </div>
            <span>{reviewRecords.length} to review</span>
          </div>
          <ul className="attendance-record-list">
            {reviewRecords.map((record) => (
              <MigrationReviewRecord
                key={`review-${record.pageKey}`}
                onUpdateRecord={onUpdateRecord}
                record={record}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <section className="attendance-page-courses" aria-labelledby="attendance-page-courses-title">
        <div className="attendance-page-section-heading">
          <div>
            <h3 id="attendance-page-courses-title">By course</h3>
            <p>Raw status counts stay separate from each syllabus policy calculation.</p>
          </div>
          <span>{rows.length} courses</span>
        </div>
        <div className="attendance-course-grid">
          {rows.map((row) => (
            <CourseSummaryCard key={row.courseId} row={row} onOpenCourse={onOpenCourse} />
          ))}
        </div>
      </section>

      <section className="attendance-page-history" aria-labelledby="attendance-page-unexcused-title">
        <div className="attendance-page-section-heading">
          <div>
            <h3 id="attendance-page-unexcused-title">Unexcused history</h3>
            <p>Only records explicitly marked unexcused appear here.</p>
          </div>
          <span>{unexcusedRecords.length} records</span>
        </div>
        {unexcusedRecords.length ? (
          <ul className="attendance-record-list">
            {unexcusedRecords.map((record) => (
              <AttendanceRecord key={`unexcused-${record.pageKey}`} record={record} todayKey={todayKey} onUpdateRecord={onUpdateRecord} />
            ))}
          </ul>
        ) : (
          <EmptyRecords icon="check" title="No unexcused absences recorded">
            Nothing in this dashboard is currently classified as unexcused.
          </EmptyRecords>
        )}
      </section>

      <section className="attendance-page-records" aria-labelledby="attendance-page-records-title">
        <div className="attendance-page-section-heading">
          <div>
            <h3 id="attendance-page-records-title">All recorded attendance</h3>
            <p>Present, late, excused, pending, and unexcused entries.</p>
          </div>
          <span>{countOf(counts, "recorded")} records</span>
        </div>
        {records.length ? (
          <ul className="attendance-record-list">
            {records.map((record) => (
              <AttendanceRecord key={`all-${record.pageKey}`} record={record} todayKey={todayKey} onUpdateRecord={onUpdateRecord} />
            ))}
          </ul>
        ) : (
          <EmptyRecords title="No attendance recorded yet">
            Open a course check-in or add a Canvas record when you have verified evidence.
          </EmptyRecords>
        )}
      </section>
    </main>
  );
}
