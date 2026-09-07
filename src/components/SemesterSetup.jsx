import { useId, useState } from "react";
import { Icon } from "../icons.jsx";

export default function SemesterSetup({
  cloudMode,
  onImportBackup,
  onOpenDocuments,
}) {
  const inputId = useId();
  const [busy, setBusy] = useState(false);

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
    <main className="semester-setup" aria-labelledby="semester-setup-title">
      <section className="semester-setup-card">
        <header className="semester-setup-heading">
          <span><Icon name="upload" size={25} /></span>
          <div>
            <small>{cloudMode ? "Private account semester" : "Device-only semester"}</small>
            <h2 id="semester-setup-title">Upload your semester data</h2>
            <p>The Semester Board design is ready. Import structured Semester Board data to fill its courses, class meetings, office hours, assignments, exams, and term dates.</p>
          </div>
        </header>

        <label className={`semester-data-import${busy ? " is-busy" : ""}`} htmlFor={inputId}>
          <Icon name="upload" size={21} />
          <span>
            <strong>{busy ? "Importing semester…" : "Choose semester data file"}</strong>
            <small>Semester Board JSON · validated before it fills this {cloudMode ? "account" : "profile"}</small>
          </span>
        </label>
        <input
          accept="application/json,.json"
          className="visually-hidden"
          disabled={busy}
          id={inputId}
          onChange={importSemester}
          type="file"
        />

        <button className="semester-setup-secondary" onClick={onOpenDocuments} type="button">
          <Icon name="document" size={18} />
          Store syllabi and course documents
        </button>

        <aside className="semester-setup-boundary">
          <Icon name="info" size={18} />
          <p><strong>Documents are reference files, not structured board data.</strong> A PDF or Word syllabus can be stored privately, but it cannot reliably fill schedules and deadlines by itself without AI. This setup does not use AI.</p>
        </aside>
      </section>
    </main>
  );
}
