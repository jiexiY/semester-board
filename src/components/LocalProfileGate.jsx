import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import {
  LOCAL_PROFILE_MIN_PASSPHRASE_LENGTH,
  orderLocalProfilesForLogin,
  preferredLocalProfileId,
} from "../lib/localProfiles.js";

function readableError(error) {
  return error instanceof Error && error.message
    ? error.message
    : "That local profile action could not be completed.";
}

export function LocalProfileRestoring({ profileName, productName = "Semester Board", productSubtitle = "Private course workspace" }) {
  const titleId = useId();
  return (
    <main className="profile-gate" aria-labelledby={titleId}>
      <section className="profile-gate-card">
        <header className="profile-gate-brand">
          <span className="profile-gate-mark"><Icon name="lock" size={26} /></span>
          <div><h1 id={titleId}>{productName}</h1><p>{productSubtitle}</p></div>
        </header>
        <div className="profile-gate-copy" aria-live="polite" role="status">
          <h2>Restoring {profileName || "your local profile"}…</h2>
          <p>Checking saved progress, assistant history, reminders, and syllabi before the dashboard opens.</p>
        </div>
      </section>
    </main>
  );
}

export default function LocalProfileGate({ createProfile, notice, profiles, signIn, productName = "Semester Board", profileDescription = "Profiles remember each person’s attendance, progress, syllabi, and assistant history on this browser." }) {
  const [mode, setMode] = useState(() => (profiles.length ? "signin" : "create"));
  const [selectedProfileId, setSelectedProfileId] = useState(() => preferredLocalProfileId(profiles));
  const [name, setName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const titleId = useId();
  const errorId = useId();
  const firstFieldRef = useRef(null);
  const orderedProfiles = useMemo(() => orderLocalProfilesForLogin(profiles), [profiles]);

  useEffect(() => {
    if (!profiles.some((item) => item.id === selectedProfileId)) {
      setSelectedProfileId(preferredLocalProfileId(profiles));
    }
  }, [profiles, selectedProfileId]);

  useEffect(() => {
    setError(null);
    setPassphrase("");
    setConfirmation("");
    window.setTimeout(() => firstFieldRef.current?.focus(), 0);
  }, [mode]);

  const handleSignIn = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn({ profileId: selectedProfileId, passphrase });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (passphrase !== confirmation) {
      setError("The passphrases do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createProfile({ name, passphrase });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="profile-gate" aria-labelledby={titleId}>
      <section className="profile-gate-card">
        <header className="profile-gate-brand">
          <span className="profile-gate-mark"><Icon name="lock" size={26} /></span>
          <div>
            <h1 id={titleId}>{productName}</h1>
            <p>{productName}</p>
          </div>
        </header>

        <div className="profile-gate-copy">
          <h2>{mode === "signin" ? "Log in to your saved profile" : "Create a local profile"}</h2>
          <p>{profileDescription}</p>
        </div>

        {notice ? <p className="profile-gate-error" role="alert"><Icon name="warning" size={16} />{notice}</p> : null}

        <div className="profile-gate-modes" aria-label="Local profile actions" role="group">
          <button aria-pressed={mode === "signin"} onClick={() => setMode("signin")} type="button">Log in</button>
          <button aria-pressed={mode === "create"} onClick={() => setMode("create")} type="button">Create profile</button>
        </div>

        {mode === "signin" ? (
          profiles.length ? (
            <form className="profile-gate-form" onSubmit={handleSignIn}>
              <label>
                <span>Saved profile</span>
                <select
                  aria-describedby={error ? errorId : undefined}
                  aria-invalid={Boolean(error)}
                  ref={firstFieldRef}
                  required
                  value={selectedProfileId}
                  onChange={(event) => setSelectedProfileId(event.target.value)}
                >
                  {orderedProfiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <small>Saved on this browser only. Your most recently used profile appears first.</small>
              </label>
              <label>
                <span>Passphrase</span>
                <input
                  aria-describedby={error ? errorId : undefined}
                  aria-invalid={Boolean(error)}
                  autoComplete="current-password"
                  required
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </label>
              {error ? <p className="profile-gate-error" id={errorId} role="alert"><Icon name="warning" size={16} />{error}</p> : null}
              <button className="profile-gate-primary" disabled={busy || !selectedProfileId || !passphrase} type="submit">
                {busy ? "Checking…" : "Log in"}
              </button>
            </form>
          ) : (
            <section className="profile-gate-empty" aria-live="polite">
              <span><Icon name="attendance" size={22} /></span>
              <div>
                <h3>No saved profiles on this browser</h3>
                <p>Local profiles do not sync from another device or browser. Create one here before logging in.</p>
              </div>
              <button className="profile-gate-secondary" onClick={() => setMode("create")} type="button">Create profile</button>
            </section>
          )
        ) : (
          <form className="profile-gate-form" onSubmit={handleCreate}>
            <label>
              <span>Profile name</span>
              <input
                aria-describedby={error ? errorId : undefined}
                aria-invalid={Boolean(error)}
                autoComplete="username"
                maxLength="40"
                placeholder="Example: Alex"
                ref={firstFieldRef}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              <span>Passphrase</span>
              <input
                aria-describedby={`profile-passphrase-help${error ? ` ${errorId}` : ""}`}
                aria-invalid={Boolean(error)}
                autoComplete="new-password"
                minLength={LOCAL_PROFILE_MIN_PASSPHRASE_LENGTH}
                required
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
              <small id="profile-passphrase-help">At least 8 characters; 12 or more is better.</small>
            </label>
            <label>
              <span>Confirm passphrase</span>
              <input
                aria-describedby={error ? errorId : undefined}
                aria-invalid={Boolean(error)}
                autoComplete="new-password"
                minLength={LOCAL_PROFILE_MIN_PASSPHRASE_LENGTH}
                required
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            {profiles.length === 0 ? (
              <p className="profile-gate-migration"><Icon name="download" size={16} />If this browser already has dashboard data, this first profile will receive it.</p>
            ) : null}
            {error ? <p className="profile-gate-error" id={errorId} role="alert"><Icon name="warning" size={16} />{error}</p> : null}
            <div className="profile-gate-actions">
              <button className="profile-gate-primary" disabled={busy || !name.trim() || !passphrase || !confirmation} type="submit">
                {busy ? "Creating…" : "Create profile"}
              </button>
              <button className="profile-gate-secondary" disabled={busy} onClick={() => setMode("signin")} type="button">Log in</button>
            </div>
          </form>
        )}

        <aside className="profile-gate-privacy">
          <Icon name="shield" size={18} />
          <p><strong>Local profile only.</strong> This is not an online account. It does not sync across devices, there is no passphrase reset, and clearing browser data removes it. The passphrase prevents casual access through this screen, but it does not encrypt the saved files or protect them from browser developer tools.</p>
        </aside>
      </section>
    </main>
  );
}
