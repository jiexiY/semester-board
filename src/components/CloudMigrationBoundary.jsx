import { useMemo, useState } from "react";
import { Icon } from "../icons.jsx";
import { preferredLocalProfileId } from "../lib/localProfiles.js";
import {
  buildLocalMigrationManifest,
  migrateLocalProfileToCloud,
  unlockLocalProfileForMigration,
} from "../lib/localCloudMigration.js";
import { formatFileSize } from "../lib/syllabusStorage.js";
import { useCloudSync } from "./CloudSyncProvider.jsx";

function migrationError(error) {
  return error instanceof Error && error.message
    ? error.message
    : "Cloud migration did not finish. Your device-only profile was not changed.";
}

export default function CloudMigrationBoundary({ account, children, localProfiles = [] }) {
  const cloudSync = useCloudSync();
  const [dismissed, setDismissed] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState(() => preferredLocalProfileId(localProfiles));
  const [passphrase, setPassphrase] = useState("");
  const [manifest, setManifest] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const selectedProfile = useMemo(
    () => localProfiles.find((profile) => profile.id === selectedProfileId) || null,
    [localProfiles, selectedProfileId],
  );

  if (account.profile?.migrationStatus !== "pending" || !localProfiles.length || dismissed) {
    return children;
  }

  const reviewMigration = async (event) => {
    event.preventDefault();
    if (busy || !selectedProfileId || !passphrase) return;
    setBusy(true);
    setError(null);
    try {
      await unlockLocalProfileForMigration({ profileId: selectedProfileId, passphrase });
      setManifest(await buildLocalMigrationManifest({ profileId: selectedProfileId }));
      setPassphrase("");
    } catch (caught) {
      setError(migrationError(caught));
    } finally {
      setBusy(false);
    }
  };

  const confirmMigration = async () => {
    if (!manifest || busy || !selectedProfile) return;
    setBusy(true);
    setError(null);
    setProgress({
      completedFiles: 0,
      currentKind: manifest.syllabusCount ? "syllabus" : "study-source",
      totalFiles: manifest.syllabusCount + manifest.studySourceCount,
    });
    try {
      await migrateLocalProfileToCloud({
        client: account.client,
        cloudSync,
        manifest,
        onProgress: setProgress,
        profileId: selectedProfile.id,
        userId: account.profile.id,
      });
      await account.setMigrationStatus("imported");
    } catch (caught) {
      setError(migrationError(caught));
    } finally {
      setBusy(false);
    }
  };

  const keepCloud = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await account.setMigrationStatus("skipped");
    } catch (caught) {
      setError(migrationError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="profile-gate" aria-labelledby="cloud-migration-title">
      <section className="profile-gate-card">
        <header className="profile-gate-brand">
          <span className="profile-gate-mark"><Icon name="upload" size={26} /></span>
          <div><h1>Semester Board</h1><p>Private course workspace</p></div>
        </header>

        {cloudSync.hasRemoteData ? (
          <>
            <div className="profile-gate-copy">
              <h2 id="cloud-migration-title">Keep the account copy?</h2>
              <p>This account already has synced board data. We will not overwrite or combine it automatically with {selectedProfile?.name || "a profile on this device"}.</p>
            </div>
            <div className="profile-gate-disclosure">
              <strong>Your device-only profile is unchanged</strong>
              <p>You can sign out and open it to export a backup before deciding whether to replace anything manually.</p>
            </div>
            {error ? <p className="profile-gate-error" role="alert"><Icon name="warning" size={16} />{error}</p> : null}
            <div className="profile-gate-actions">
              <button className="profile-gate-primary" disabled={busy} onClick={keepCloud} type="button">{busy ? "Saving…" : "Keep cloud data"}</button>
              <button className="profile-gate-secondary" disabled={busy} onClick={() => setDismissed(true)} type="button">Not now</button>
            </div>
          </>
        ) : manifest ? (
          <>
            <div className="profile-gate-copy">
              <h2 id="cloud-migration-title">Review what will sync</h2>
              <p>Nothing is uploaded until you confirm. The original {selectedProfile?.name} profile will stay on this browser.</p>
            </div>
            <div className="profile-gate-disclosure">
              <strong>Will copy to {account.profile.email}</strong>
              <p>Attendance and notes, assignment progress, date overrides, schedule choices, assistant histories, Study Deck courses/decks/progress, {manifest.syllabusCount} {manifest.syllabusCount === 1 ? "syllabus" : "syllabi"} ({formatFileSize(manifest.syllabusBytes)}), and {manifest.studySourceCount} Study Deck source {manifest.studySourceCount === 1 ? "file" : "files"} ({formatFileSize(manifest.studySourceBytes)}).</p>
            </div>
            <div className="profile-gate-disclosure">
              <strong>Will stay on this device</strong>
              <p>The old profile verifier/passphrase, notification permission and push subscription, AI consent, and temporary Media Lab files.</p>
            </div>
            {progress && busy && progress.totalFiles > 0 ? <p className="profile-gate-migration" role="status">Uploading {progress.currentKind === "study-source" ? "Study Deck source" : "syllabus"} {Math.min(progress.completedFiles + 1, progress.totalFiles)} of {progress.totalFiles}…</p> : null}
            {error ? <p className="profile-gate-error" role="alert"><Icon name="warning" size={16} />{error}</p> : null}
            <div className="profile-gate-actions">
              <button className="profile-gate-primary" disabled={busy} onClick={confirmMigration} type="button">{busy ? "Moving data…" : "Confirm and sync"}</button>
              <button className="profile-gate-secondary" disabled={busy} onClick={() => setManifest(null)} type="button">Back</button>
            </div>
          </>
        ) : (
          <>
            <div className="profile-gate-copy">
              <h2 id="cloud-migration-title">Move data from this browser?</h2>
              <p>We found a device-only profile. Choose what to copy into {account.profile.email}; nothing will be uploaded until you review and confirm.</p>
            </div>
            <form className="profile-gate-form" onSubmit={reviewMigration}>
              <label>
                <span>Device-only profile</span>
                <select required value={selectedProfileId} onChange={(event) => { setSelectedProfileId(event.target.value); setError(null); }}>
                  {localProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                </select>
              </label>
              <label>
                <span>Device-only profile passphrase</span>
                <input autoComplete="current-password" required type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
                <small>This unlocks the local copy only. It is never uploaded or reused as your cloud password.</small>
              </label>
              {error ? <p className="profile-gate-error" role="alert"><Icon name="warning" size={16} />{error}</p> : null}
              <div className="profile-gate-actions">
                <button className="profile-gate-primary" disabled={busy || !passphrase} type="submit">{busy ? "Checking…" : "Review data"}</button>
                <button className="profile-gate-secondary" disabled={busy} onClick={() => setDismissed(true)} type="button">Not now</button>
              </div>
            </form>
            <button className="profile-gate-text-action" disabled={busy} onClick={keepCloud} type="button">Start this cloud account without the device-only data</button>
          </>
        )}
      </section>
    </main>
  );
}
