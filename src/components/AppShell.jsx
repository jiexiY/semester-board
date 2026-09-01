import { useRef, useState } from "react";
import { Icon } from "../icons";

const NAV_ITEMS = [
  { id: "overview", label: "Overview", icon: "overview" },
  { id: "week", label: "Week", icon: "calendar" },
  { id: "assignments", label: "Assignments", icon: "document" },
  { id: "attendance", label: "Attendance", icon: "attendance" },
  { id: "sources", label: "Sources", icon: "sources" },
];

function NavButton({ item, active, onSelect }) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      className={`nav-button${active ? " is-active" : ""}`}
      onClick={() => onSelect(item.id)}
      type="button"
    >
      <Icon name={item.icon} size={20} />
      <span>{item.label}</span>
    </button>
  );
}

export default function AppShell({ route, onRoute, nowLabel, onExport, onImport, children }) {
  const [backupOpen, setBackupOpen] = useState(false);
  const fileInput = useRef(null);

  const handleFile = async (event) => {
    const [file] = event.target.files;
    event.target.value = "";
    if (!file) return;
    await onImport(file);
    setBackupOpen(false);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="product-mark">SEMESTER / DESK</div>
        <nav className="nav-list">
          {NAV_ITEMS.map((item) => (
            <NavButton key={item.id} item={item} active={route === item.id} onSelect={onRoute} />
          ))}
        </nav>
        <div className="local-note">Saved on this device</div>
      </aside>

      <header className="utility-header">
        <div className="live-time"><Icon name="clock" size={18} /><span>{nowLabel}</span></div>
        <div className="backup-wrap">
          <button className="export-button" type="button" onClick={() => setBackupOpen((open) => !open)} aria-expanded={backupOpen}>
            <Icon name="export" size={20} />
            <span>Export</span>
            <Icon name="chevronDown" size={16} />
          </button>
          {backupOpen ? (
            <div className="backup-menu" role="menu">
              <button type="button" onClick={() => { onExport(); setBackupOpen(false); }} role="menuitem">
                <Icon name="download" size={18} /> Export backup
              </button>
              <button type="button" onClick={() => fileInput.current?.click()} role="menuitem">
                <Icon name="upload" size={18} /> Import backup
              </button>
            </div>
          ) : null}
          <input ref={fileInput} className="visually-hidden" type="file" accept="application/json,.json" onChange={handleFile} />
        </div>
      </header>

      <main className="main-stage">{children}</main>

      <nav className="mobile-nav" aria-label="Primary navigation">
        {NAV_ITEMS.map((item) => (
          <NavButton key={item.id} item={item} active={route === item.id} onSelect={onRoute} />
        ))}
      </nav>
    </div>
  );
}
