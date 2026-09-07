import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "../icons.jsx";
import {
  addCloudSyllabus,
  deleteCloudSyllabus,
} from "../lib/cloudSyllabusStorage.js";
import {
  courseNameForGeneratedSource,
  semesterFromGeneratedDraft,
} from "../lib/semesterGeneration.js";
import {
  addSyllabus,
  deleteSyllabus,
  formatFileSize,
} from "../lib/syllabusStorage.js";
import { CAMPUS_TIME_ZONE } from "../lib/format.js";

const ACCEPTED_FILES = ".pdf,.doc,.docx,.txt";
const SUPPORTED_EXTENSIONS = new Set(["pdf", "doc", "docx", "txt"]);
const MAX_FILES = 8;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function fileExtension(fileName = "") {
  return String(fileName).split(".").pop()?.toLocaleLowerCase("en-US") || "";
}

function readableError(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function uniqueFiles(current, incoming) {
  const seen = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  const next = [...current];
  const rejected = [];
  for (const file of incoming) {
    const extension = fileExtension(file.name);
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      rejected.push(`${file.name}: unsupported file type`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      rejected.push(`${file.name}: larger than 20 MB`);
      continue;
    }
    const identity = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(identity)) continue;
    if (next.length >= MAX_FILES) {
      rejected.push(`${file.name}: only ${MAX_FILES} files can be used per draft`);
      continue;
    }
    seen.add(identity);
    next.push(file);
  }
  return { files: next, rejected };
}

function assignmentLabel(assignment) {
  const due = assignment.date
    ? [assignment.date, assignment.time].filter(Boolean).join(" · ")
    : "Date not stated";
  return `${due} · ${assignment.kind || "assignment"}`;
}

function meetingLabel(meeting) {
  const days = Array.isArray(meeting.weekdays) ? meeting.weekdays.join(" · ") : "";
  return [days, meeting.time, meeting.location].filter(Boolean).join(" · ") || "Schedule details not stated";
}

async function rollbackSavedDocuments({ cloudClient, cloudMode, profileId, saved }) {
  await Promise.allSettled(saved.map((record) => (
    cloudMode
      ? deleteCloudSyllabus(cloudClient, record, profileId)
      : deleteSyllabus(record.id, profileId)
  )));
}

export default function SemesterSetup({
  ai,
  cloudClient = null,
  cloudMode,
  generator,
  onImportBackup,
  onSaveSemester,
  profileId,
}) {
  const inputId = useId();
  const backupId = useId();
  const inputRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [result, setResult] = useState(null);
  const [label, setLabel] = useState("My semester");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [consentChecked, setConsentChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const draft = result?.draft || null;
  const assignmentsByCourse = useMemo(() => {
    const groups = new Map();
    for (const assignment of draft?.assignments || []) {
      const group = groups.get(assignment.courseId) || [];
      group.push(assignment);
      groups.set(assignment.courseId, group);
    }
    return groups;
  }, [draft]);

  useEffect(() => {
    if (ai.status === "idle") void ai.checkConsent();
  }, [ai.checkConsent, ai.status]);

  const addFiles = (selected) => {
    const update = uniqueFiles(files, Array.from(selected || []));
    setFiles(update.files);
    setResult(null);
    generator.reset();
    setFeedback(update.rejected.length ? {
      type: "warning",
      text: update.rejected.slice(0, 3).join(" "),
    } : null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const removeFile = (index) => {
    setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index));
    setResult(null);
    generator.reset();
    setFeedback(null);
  };

  const buildDraft = async () => {
    if (!files.length || busy || ai.status !== "ready") return;
    setBusy(true);
    setFeedback(null);
    try {
      const generated = await generator.generate({ files });
      setResult(generated);
      setLabel(generated.draft.term?.label || "My semester");
      setStartDate(generated.draft.term?.classesBegin || "");
      setEndDate(generated.draft.term?.classesEnd || "");
      setFeedback({
        type: generated.extracted.skipped.length ? "warning" : "success",
        text: generated.extracted.skipped.length
          ? `${generated.extracted.skipped.length} file${generated.extracted.skipped.length === 1 ? " was" : "s were"} not readable for generation. Review the list before saving.`
          : "Draft ready. Review every course, schedule, and deadline before saving it.",
      });
    } catch (error) {
      if (error?.name !== "AbortError") {
        setFeedback({ type: "error", text: readableError(error, "The semester draft could not be generated.") });
      }
    } finally {
      setBusy(false);
    }
  };

  const enableGeneration = async () => {
    if (!consentChecked || busy) return;
    setBusy(true);
    setFeedback(null);
    await ai.grantConsent();
    setBusy(false);
  };

  const saveDraft = async () => {
    if (!result || busy) return;
    setBusy(true);
    setFeedback(null);
    const saved = [];
    try {
      const semester = semesterFromGeneratedDraft({
        draft: result.draft,
        endDate,
        label,
        sourceRecords: result.records,
        startDate,
        timeZone: CAMPUS_TIME_ZONE,
      });
      for (const source of result.records) {
        const input = {
          courseName: courseNameForGeneratedSource(result.draft, source.id),
          file: source.blob,
        };
        const record = cloudMode
          ? await addCloudSyllabus(cloudClient, input, profileId)
          : await addSyllabus(input, profileId);
        saved.push(record);
      }
      onSaveSemester(semester);
    } catch (error) {
      if (saved.length) await rollbackSavedDocuments({ cloudClient, cloudMode, profileId, saved });
      setFeedback({
        type: "error",
        text: `${readableError(error, "The semester could not be saved.")} ${saved.length ? "Any documents saved during this attempt were rolled back." : "Nothing was saved."}`,
      });
      setBusy(false);
    }
  };

  const importBackup = async (event) => {
    const [file] = event.target.files;
    event.target.value = "";
    if (file) await onImportBackup(file);
  };

  return (
    <main className="semester-setup" aria-labelledby="semester-setup-title">
      <section className="semester-setup-card">
        <header className="semester-setup-heading">
          <span><Icon name="spark" size={27} /></span>
          <div>
            <small>Private semester setup</small>
            <h2 id="semester-setup-title">Build your board from course documents</h2>
            <p>Upload syllabi, assignment sheets, exam guides, or course calendars. Semester Board extracts a draft for you to review before anything becomes your schedule.</p>
          </div>
        </header>

        <aside className="semester-setup-privacy">
          <Icon name="lock" size={18} />
          <p><strong>{cloudMode ? "Private account files" : "Device-only files"}.</strong> Original documents are saved only after you approve the draft. Bounded text excerpts and file names go to the configured AI provider only while consent is active. Files are never uploaded to Canvas.</p>
        </aside>

        {!draft ? (
          <>
            <section className="semester-setup-upload" aria-label="Course document upload">
              <label htmlFor={inputId}>
                <Icon name="upload" size={22} />
                <span><strong>Add course documents</strong><small>PDF, DOC, DOCX, or TXT · up to {MAX_FILES} files · 20 MB each</small></span>
              </label>
              <input
                accept={ACCEPTED_FILES}
                id={inputId}
                multiple
                onChange={(event) => addFiles(event.target.files)}
                ref={inputRef}
                type="file"
              />
            </section>

            {files.length ? (
              <ul className="semester-setup-files" aria-label="Selected course documents">
                {files.map((file, index) => (
                  <li key={`${file.name}:${file.size}:${file.lastModified}`}>
                    <Icon name="document" size={18} />
                    <span><strong>{file.name}</strong><small>{formatFileSize(file.size)}{fileExtension(file.name) === "doc" ? " · saved, but legacy DOC text cannot be read for generation" : ""}</small></span>
                    <button aria-label={`Remove ${file.name}`} onClick={() => removeFile(index)} type="button"><Icon name="close" size={15} /></button>
                  </li>
                ))}
              </ul>
            ) : null}

            {ai.status === "needs-consent" ? (
              <section className="semester-setup-consent">
                <label>
                  <input checked={consentChecked} onChange={(event) => setConsentChecked(event.target.checked)} type="checkbox" />
                  <span>I understand that bounded text excerpts and file names will be sent to the configured AI provider to create this draft. Consent lasts up to 8 hours and can be revoked in Semester Chat.</span>
                </label>
                <button disabled={!consentChecked || busy} onClick={enableGeneration} type="button">{busy ? "Enabling…" : "Enable private AI generation"}</button>
              </section>
            ) : null}

            {ai.status === "unavailable" ? (
              <p className="semester-setup-message is-error" role="alert"><Icon name="warning" size={17} />AI generation is unavailable in this deployment. Your files have not been uploaded.</p>
            ) : null}

            {ai.status === "needs-consent" && ai.error ? (
              <p className="semester-setup-message is-error" role="alert"><Icon name="warning" size={17} />{ai.error}</p>
            ) : null}

            <button
              className="semester-setup-primary"
              disabled={!files.length || busy || ai.status !== "ready"}
              onClick={buildDraft}
              type="button"
            >
              <Icon name="spark" size={18} />
              {busy || ["extracting", "generating"].includes(generator.status.state) ? "Building draft…" : "Generate semester draft"}
            </button>
            {generator.status.message ? <p className="semester-setup-progress" role="status">{generator.status.message}</p> : null}
          </>
        ) : (
          <section className="semester-setup-review" aria-labelledby="semester-setup-review-title">
            <div className="semester-setup-review-heading">
              <div><small>Review required</small><h3 id="semester-setup-review-title">Check the generated semester</h3></div>
              <button onClick={() => { setResult(null); generator.reset(); setFeedback(null); }} type="button">Change files</button>
            </div>

            <div className="semester-setup-term-fields">
              <label><span>Semester name</span><input maxLength={80} onChange={(event) => setLabel(event.target.value)} value={label} /></label>
              <label><span>First class date</span><input onChange={(event) => setStartDate(event.target.value)} required type="date" value={startDate} /></label>
              <label><span>Last class date</span><input onChange={(event) => setEndDate(event.target.value)} required type="date" value={endDate} /></label>
            </div>

            <div className="semester-setup-summary">
              <span><strong>{draft.courses.length}</strong> courses</span>
              <span><strong>{draft.assignments.length}</strong> coursework items</span>
              <span><strong>{draft.assignments.filter((item) => !item.date).length}</strong> dates not stated</span>
            </div>

            <div className="semester-setup-course-review">
              {draft.courses.map((course) => {
                const courseAssignments = assignmentsByCourse.get(course.id) || [];
                return (
                  <article key={course.id}>
                    <header><strong>{course.code}</strong><span>{course.title}</span></header>
                    <div className="semester-setup-review-block">
                      <small>Class meetings</small>
                      {course.meetings.length ? course.meetings.map((meeting) => <p key={meeting.id}>{meetingLabel(meeting)}</p>) : <p>Not stated in readable sources</p>}
                    </div>
                    <div className="semester-setup-review-block">
                      <small>Office hours</small>
                      {course.officeHours?.entries?.length ? course.officeHours.entries.map((entry) => (
                        <p key={entry.id}>{[entry.person, meetingLabel(entry), entry.byAppointment ? "By appointment" : null].filter(Boolean).join(" · ")}</p>
                      )) : <p>Not stated in readable sources</p>}
                    </div>
                    <div className="semester-setup-review-block">
                      <small>Assignments and exams · {courseAssignments.length}</small>
                      {courseAssignments.length ? <ul>{courseAssignments.map((assignment) => (
                        <li key={assignment.id}><strong>{assignment.title}</strong><span>{assignmentLabel(assignment)}</span></li>
                      ))}</ul> : <p>No graded work found in readable sources</p>}
                    </div>
                  </article>
                );
              })}
            </div>

            {result.extracted.skipped.length ? (
              <div className="semester-setup-skipped" role="status">
                <strong>Not used for generation</strong>
                {result.extracted.skipped.map((item) => <p key={item.fileName}>{item.fileName}: {item.reason}</p>)}
              </div>
            ) : null}

            <p className="semester-setup-review-note"><Icon name="warning" size={17} />Generated data can be incomplete or wrong. Compare every class time and deadline with the original documents. Unknown deadlines stay undated.</p>
            <button className="semester-setup-primary" disabled={busy || !startDate || !endDate} onClick={saveDraft} type="button">
              <Icon name="check" size={18} />{busy ? "Saving private semester…" : "Save documents and use this semester"}
            </button>
          </section>
        )}

        {feedback ? <p className={`semester-setup-message is-${feedback.type}`} role={feedback.type === "error" ? "alert" : "status"}><Icon name={feedback.type === "error" ? "warning" : "info"} size={17} />{feedback.text}</p> : null}

        <details className="semester-setup-backup">
          <summary>Already have a Semester Board backup?</summary>
          <p>JSON import remains available for an existing private backup; it is no longer the primary setup method.</p>
          <label htmlFor={backupId}><Icon name="upload" size={16} />Import private JSON backup</label>
          <input accept="application/json,.json" className="visually-hidden" id={backupId} onChange={importBackup} type="file" />
        </details>
      </section>
    </main>
  );
}

