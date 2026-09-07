import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import {
  addSyllabus,
  deleteSyllabus,
  formatFileSize,
  listSyllabi,
} from "../lib/syllabusStorage.js";
import {
  addCloudSyllabus,
  createCloudSyllabusUrl,
  deleteCloudSyllabus,
  downloadCloudSyllabus,
  listCloudSyllabi,
} from "../lib/cloudSyllabusStorage.js";

const ACCEPTED_FILES = ".pdf,.doc,.docx,.txt";
const SUPPORTED_EXTENSIONS = new Set(["pdf", "doc", "docx", "txt"]);

function fileExtension(fileName = "") {
  return fileName.split(".").pop()?.toLowerCase() || "";
}

function fileTypeLabel(record) {
  const extension = fileExtension(record.fileName);
  if (extension === "pdf") return "PDF";
  if (extension === "doc") return "Word DOC";
  if (extension === "docx") return "Word DOCX";
  if (extension === "txt") return "Text";
  return record.mimeType || "Document";
}

function formatAddedDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function readableError(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function compareSyllabi(left, right) {
  const dateOrder = String(right.addedAt || "").localeCompare(String(left.addedAt || ""));
  if (dateOrder) return dateOrder;
  return String(left.fileName || "").localeCompare(String(right.fileName || ""));
}

export default function SyllabusPage({ cloudClient = null, profileId }) {
  const cloudMode = Boolean(cloudClient);
  const fileInputId = useId();
  const courseInputId = useId();
  const fileHelpId = useId();
  const fileInputRef = useRef(null);
  const dragDepthRef = useRef(0);
  const objectUrlTimersRef = useRef(new Map());
  const [syllabi, setSyllabi] = useState([]);
  const [courseName, setCourseName] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [feedback, setFeedback] = useState(null);

  const sortedSyllabi = useMemo(
    () => [...syllabi].sort(compareSyllabi),
    [syllabi],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setSyllabi([]);

    const loadLibrary = async () => {
      try {
        const records = cloudMode
          ? await listCloudSyllabi(cloudClient, profileId)
          : await listSyllabi(profileId);
        if (active) setSyllabi(Array.isArray(records) ? records : []);
      } catch (error) {
        if (active) {
          setFeedback({
            type: "error",
            text: readableError(error, cloudMode
              ? "Your private course-document library could not be loaded from your account."
              : "The course-document library could not be opened in this browser."),
          });
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    loadLibrary();
    return () => { active = false; };
  }, [cloudClient, cloudMode, profileId]);

  useEffect(() => {
    if (!cloudMode) return undefined;
    const refreshWhenVisible = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        setSyllabi(await listCloudSyllabi(cloudClient, profileId));
      } catch {
        // Keep the last confirmed account library visible while temporarily offline.
      }
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [cloudClient, cloudMode, profileId]);

  useEffect(() => () => {
    for (const [url, timer] of objectUrlTimersRef.current) {
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
    }
    objectUrlTimersRef.current.clear();
  }, []);

  const retireObjectUrl = (url, delay) => {
    const timer = window.setTimeout(() => {
      URL.revokeObjectURL(url);
      objectUrlTimersRef.current.delete(url);
    }, delay);
    objectUrlTimersRef.current.set(url, timer);
  };

  const objectUrlFor = (record) => {
    if (!(record.blob instanceof Blob)) {
      throw new Error("This stored file is unavailable. Remove it and add the original file again.");
    }
    return URL.createObjectURL(record.blob);
  };

  const chooseFile = (file) => {
    setFeedback(null);
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (!SUPPORTED_EXTENSIONS.has(fileExtension(file.name))) {
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setFeedback({ type: "error", text: "Choose a PDF, DOC, DOCX, or TXT course document." });
      return;
    }
    setSelectedFile(file);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    chooseFile(event.dataTransfer.files?.[0]);
  };

  const handleUpload = async (event) => {
    event.preventDefault();
    const cleanCourseName = courseName.trim();
    if (!cleanCourseName || !selectedFile || uploading) return;

    setUploading(true);
    setFeedback(null);
    let saved = false;
    try {
      if (cloudMode) {
        await addCloudSyllabus(cloudClient, { courseName: cleanCourseName, file: selectedFile }, profileId);
      } else {
        await addSyllabus({ courseName: cleanCourseName, file: selectedFile }, profileId);
      }
      saved = true;
      const records = cloudMode
        ? await listCloudSyllabi(cloudClient, profileId)
        : await listSyllabi(profileId);
      setSyllabi(Array.isArray(records) ? records : []);
      setCourseName("");
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setFeedback({
        type: "success",
        text: cloudMode ? "Course document saved to your private account." : "Course document saved in this browser.",
      });
    } catch (error) {
      setFeedback({
        type: "error",
        text: saved
          ? "The course document was saved, but the list could not refresh. Reload this page to see it."
          : readableError(error, cloudMode
            ? "The course document could not be saved to your account."
            : "The course document could not be saved in this browser."),
      });
    } finally {
      setUploading(false);
    }
  };

  const handleOpen = async (record) => {
    setFeedback(null);
    let url = null;
    try {
      url = cloudMode
        ? await createCloudSyllabusUrl(cloudClient, record, profileId)
        : objectUrlFor(record);
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      link.remove();
      if (!cloudMode) retireObjectUrl(url, 60_000);
      url = null;
      setFeedback({ type: "success", text: `Opened ${record.fileName}.` });
    } catch (error) {
      if (url && !cloudMode) URL.revokeObjectURL(url);
      setFeedback({ type: "error", text: readableError(error, "The course document could not be opened.") });
    }
  };

  const handleDownload = async (record) => {
    setFeedback(null);
    let url = null;
    try {
      url = cloudMode
        ? URL.createObjectURL(await downloadCloudSyllabus(cloudClient, record, profileId))
        : objectUrlFor(record);
      const link = document.createElement("a");
      link.href = url;
      link.download = record.fileName || "syllabus";
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      retireObjectUrl(url, 1_000);
      url = null;
      setFeedback({ type: "success", text: `Download started for ${record.fileName}.` });
    } catch (error) {
      if (url) URL.revokeObjectURL(url);
      setFeedback({ type: "error", text: readableError(error, "The course document could not be downloaded.") });
    }
  };

  const handleRemove = async (record) => {
    const confirmed = window.confirm(
      cloudMode
        ? `Remove “${record.fileName}” from your account and every synced device? This cannot be undone.`
        : `Remove “${record.fileName}” from this browser? This cannot be undone.`,
    );
    if (!confirmed) return;

    setRemovingId(record.id);
    setFeedback(null);
    try {
      const removed = cloudMode
        ? await deleteCloudSyllabus(cloudClient, record, profileId)
        : await deleteSyllabus(record.id, profileId);
      if (removed) {
        setSyllabi((current) => current.filter((item) => item.id !== record.id));
        setFeedback({
          type: "success",
          text: cloudMode
            ? `${record.fileName} was removed from your account.`
            : `${record.fileName} was removed from this browser.`,
        });
      } else {
        setFeedback({ type: "error", text: cloudMode
          ? "That course document is not available in this account."
          : "That course document is not available in this local profile." });
      }
    } catch (error) {
      setFeedback({ type: "error", text: readableError(error, "The course document could not be removed.") });
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <main
      aria-labelledby="syllabus-page-title"
      className="syllabus-page"
      id="syllabi-page"
      role="tabpanel"
    >
      <header className="syllabus-page-header">
        <div className="syllabus-page-title-group">
          <span className="syllabus-page-title-icon"><Icon name="book" size={25} /></span>
          <div>
            <h2 id="syllabus-page-title">Course document library</h2>
            <p>Keep syllabi, assignment sheets, exam guides, and calendars beside your semester plan.</p>
          </div>
        </div>
        <span className="syllabus-page-file-count">{sortedSyllabi.length} {sortedSyllabi.length === 1 ? "file" : "files"}</span>
      </header>

      <aside className="syllabus-page-privacy" aria-label="File privacy">
        <span className="syllabus-page-privacy-icon"><Icon name="lock" size={19} /></span>
        <div>
          <strong>{cloudMode ? "Private account storage" : "Stored only in this browser"}</strong>
          <p>{cloudMode
            ? "Files are uploaded to a private Supabase Storage bucket so they are available on your signed-in devices. They are not uploaded to Canvas and are not end-to-end encrypted by Semester Board."
            : "Files are not uploaded to Canvas or a server. Clearing browser data can remove them, and anyone with access to this browser profile may be able to open them."}</p>
        </div>
      </aside>

      <section className="syllabus-page-upload" aria-labelledby="syllabus-page-upload-title">
        <div className="syllabus-page-section-heading">
          <div>
            <h3 id="syllabus-page-upload-title">Add a course document</h3>
            <p>Label the course, then select a syllabus or supporting document.</p>
          </div>
        </div>

        <form className="syllabus-upload-form" onSubmit={handleUpload}>
          <label className="syllabus-upload-course" htmlFor={courseInputId}>
            <span>Course name</span>
            <input
              autoComplete="off"
              id={courseInputId}
              maxLength={120}
              onChange={(event) => { setCourseName(event.target.value); setFeedback(null); }}
              placeholder="Example: Course code or title"
              required
              type="text"
              value={courseName}
            />
          </label>

          <div
            className={`syllabus-upload-dropzone${dragging ? " syllabus-upload-dropzone-active" : ""}${selectedFile ? " syllabus-upload-dropzone-selected" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              dragDepthRef.current += 1;
              setDragging(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
              if (dragDepthRef.current === 0) setDragging(false);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            <input
              accept={ACCEPTED_FILES}
              aria-describedby={fileHelpId}
              aria-required="true"
              className="syllabus-upload-file-input"
              id={fileInputId}
              onChange={(event) => chooseFile(event.target.files?.[0])}
              ref={fileInputRef}
              type="file"
            />
            <label className="syllabus-upload-file-label" htmlFor={fileInputId}>
              <span className="syllabus-upload-file-icon"><Icon name={selectedFile ? "check" : "upload"} size={23} /></span>
              {selectedFile ? (
                <span>
                  <strong>{selectedFile.name}</strong>
                  <small id={fileHelpId}>{formatFileSize(selectedFile.size)} · Choose another file</small>
                </span>
              ) : (
                <span>
                  <strong>Drop a course document here or choose a file</strong>
                  <small id={fileHelpId}>PDF, DOC, DOCX, or TXT</small>
                </span>
              )}
            </label>
          </div>

          <button
            className="syllabus-upload-submit"
            disabled={!courseName.trim() || !selectedFile || uploading}
            type="submit"
          >
            <Icon name="upload" size={18} />
            {uploading ? "Saving…" : (cloudMode ? "Save document to account" : "Save document locally")}
          </button>
        </form>
      </section>

      <div className="syllabus-page-feedback" aria-atomic="true" aria-live="polite">
        {feedback ? (
          <div
            className={`syllabus-page-message syllabus-page-message-${feedback.type}`}
            role={feedback.type === "error" ? "alert" : "status"}
          >
            <Icon name={feedback.type === "error" ? "warning" : "check"} size={17} />
            <span>{feedback.text}</span>
          </div>
        ) : null}
      </div>

      <section className="syllabus-page-library" aria-labelledby="syllabus-page-library-title">
        <div className="syllabus-page-section-heading">
          <div>
            <h3 id="syllabus-page-library-title">Saved course documents</h3>
            <p>{cloudMode ? "Open or download a private account copy whenever you need it." : "Open or download a local copy whenever you need it."}</p>
          </div>
        </div>

        {loading ? (
          <div className="syllabus-page-loading" role="status">
            <Icon name="clock" size={20} />{cloudMode ? "Loading your account library…" : "Loading this browser’s library…"}
          </div>
        ) : sortedSyllabi.length ? (
          <ul className="syllabus-library-list">
            {sortedSyllabi.map((record) => (
              <li className="syllabus-library-item" key={record.id}>
                <span className="syllabus-library-file-icon"><Icon name="document" size={21} /></span>
                <div className="syllabus-library-identity">
                  <strong>{record.fileName}</strong>
                  <span>{record.courseName}</span>
                </div>
                <div className="syllabus-library-meta">
                  <span>{fileTypeLabel(record)} · {formatFileSize(record.size)}</span>
                  <small>Added {formatAddedDate(record.addedAt)}</small>
                </div>
                <div className="syllabus-library-actions" aria-label={`Actions for ${record.fileName}`} role="group">
                  <button aria-label={`Open ${record.fileName}`} type="button" onClick={() => handleOpen(record)}><Icon name="sources" size={16} />Open</button>
                  <button aria-label={`Download ${record.fileName}`} type="button" onClick={() => handleDownload(record)}><Icon name="download" size={16} />Download</button>
                  <button
                    aria-label={`Remove ${record.fileName}`}
                    className="syllabus-library-remove"
                    disabled={removingId === record.id}
                    type="button"
                    onClick={() => handleRemove(record)}
                  >
                    <Icon name="close" size={16} />{removingId === record.id ? "Removing…" : "Remove"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="syllabus-page-empty" role="status">
            <span className="syllabus-page-empty-icon"><Icon name="book" size={26} /></span>
            <div>
              <strong>No course documents saved yet</strong>
              <p>{cloudMode
                ? "Add a PDF, Word document, or text file to build your private synced course library."
                : "Add a PDF, Word document, or text file to build this browser’s private course library."}</p>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
