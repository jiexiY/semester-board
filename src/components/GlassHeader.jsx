import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";

export default function GlassHeader({
  dateLabel,
  weekLabel,
  onExport,
  onImport,
  onReset,
  onSignOut,
  profile,
  syncStatus,
  termLabel,
}) {
  const [activeMenu, setActiveMenu] = useState(null);
  const [signingOut, setSigningOut] = useState(false);
  const fileInput = useRef(null);
  const actionsRef = useRef(null);
  const backupButtonRef = useRef(null);
  const profileButtonRef = useRef(null);
  const cloudMode = profile.syncMode === "cloud";

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key !== "Escape" || !activeMenu) return;
      const trigger = activeMenu === "backup" ? backupButtonRef : profileButtonRef;
      setActiveMenu(null);
      window.setTimeout(() => trigger.current?.focus(), 0);
    };
    const closeOutside = (event) => {
      if (!actionsRef.current?.contains(event.target)) setActiveMenu(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [activeMenu]);

  const handleImport = async (event) => {
    const [file] = event.target.files;
    event.target.value = "";
    if (!file) return;
    await onImport(file);
    setActiveMenu(null);
  };

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await onSignOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <header className="glass-topbar">
      <div className="brand-lockup">
        <h1>{termLabel || "My semester"}</h1>
        <span>Semester Board</span>
      </div>

      <div className="term-context" aria-label="Current semester position">
        <span><Icon name="calendar" size={18} />{dateLabel}</span>
        <i aria-hidden="true" />
        <span><Icon name="overview" size={18} />{weekLabel}</span>
        <i aria-hidden="true" />
        <span className={`saved-status saved-status-${syncStatus?.tone || "local"}`}>
          <Icon name={syncStatus?.tone === "conflict" ? "warning" : "shield"} size={17} />
          {syncStatus?.label || "Saved on this device"}
        </span>
      </div>

      <div className="topbar-actions" ref={actionsRef}>
        <div className="backup-control">
          <button
            aria-label="Backup options"
            aria-expanded={activeMenu === "backup"}
            aria-haspopup="menu"
            className="backup-button"
            onClick={() => setActiveMenu((open) => (open === "backup" ? null : "backup"))}
            type="button"
            ref={backupButtonRef}
          >
            <Icon name="export" size={19} />
            <span>Backup</span>
            <Icon name="chevronDown" size={15} />
          </button>
          {activeMenu === "backup" ? (
            <div className="backup-popover" role="menu">
              <button onClick={() => { onExport(); setActiveMenu(null); }} role="menuitem" type="button">
                <Icon name="download" size={18} />Export backup
              </button>
              <button onClick={() => fileInput.current?.click()} role="menuitem" type="button">
                <Icon name="upload" size={18} />Import backup
              </button>
              <button className="danger-action" onClick={() => { onReset(); setActiveMenu(null); }} role="menuitem" type="button">
                <Icon name="reset" size={18} />{cloudMode ? "Reset synced board data" : "Reset local progress"}
              </button>
            </div>
          ) : null}
          <input ref={fileInput} aria-label="Import backup file" className="visually-hidden" type="file" accept="application/json,.json" onChange={handleImport} />
        </div>

        <div className="profile-control">
          <button
            aria-label={`Profile options for ${profile.name}`}
            aria-expanded={activeMenu === "profile"}
            aria-haspopup="menu"
            className="profile-button"
            onClick={() => setActiveMenu((open) => (open === "profile" ? null : "profile"))}
            type="button"
            ref={profileButtonRef}
          >
            <span className="profile-avatar" aria-hidden="true">{profile.name.slice(0, 1).toUpperCase()}</span>
            <span className="profile-button-name">{profile.name}</span>
            <Icon name="chevronDown" size={15} />
          </button>
          {activeMenu === "profile" ? (
            <div className="profile-popover" role="menu">
              <div className="profile-popover-summary">
                <span className="profile-avatar" aria-hidden="true">{profile.name.slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{profile.name}</strong>
                  <span>{cloudMode ? `${profile.email} · Cloud sync on` : "Device-only profile on this browser"}</span>
                </div>
              </div>
              <button disabled={signingOut} onClick={handleSignOut} role="menuitem" type="button">
                <Icon name="lock" size={18} />{signingOut ? "Signing out…" : (cloudMode ? "Sign out on this device" : "Sign out")}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
