import { Icon } from "../icons";

export function PageIntro({ title, meta, description, actions }) {
  return (
    <div className="page-intro">
      <div>
        {meta ? <p className="page-meta">{meta}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function Badge({ children, tone = "neutral", title }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

export function CertaintyBadge({ certainty, overridden = false }) {
  const labels = {
    confirmed: "Confirmed",
    derived: "Derived",
    provisional: "Verify in Canvas",
    tbd: "Date not listed",
    TBD: "Date not listed",
  };
  const tone = overridden ? "solid" : certainty === "confirmed" ? "outline" : certainty === "tbd" || certainty === "TBD" ? "muted" : "hatched";
  return <Badge tone={tone}>{overridden ? "Your date" : labels[certainty] || "Date not listed"}</Badge>;
}

export function SectionHeader({ title, detail, action }) {
  return (
    <div className="section-header">
      <div>
        <h2>{title}</h2>
        {detail ? <p>{detail}</p> : null}
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  );
}

export function Notice({ title, children, icon = "info", compact = false }) {
  return (
    <div className={`notice${compact ? " notice-compact" : ""}`} role="note">
      <Icon name={icon} size={20} />
      <div><strong>{title}</strong>{children ? <p>{children}</p> : null}</div>
    </div>
  );
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="empty-state">
      <span className="empty-rule" aria-hidden="true" />
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function IconButton({ name, label, className = "", ...props }) {
  return (
    <button className={`icon-button ${className}`} aria-label={label} title={label} type="button" {...props}>
      <Icon name={name} size={19} />
    </button>
  );
}

export function CourseIdentity({ course, compact = false }) {
  return (
    <div className={`course-identity${compact ? " is-compact" : ""}`}>
      <strong>{course.code}</strong>
      <span>{course.shortTitle || course.title}</span>
    </div>
  );
}

export function Segmented({ value, options, onChange, label }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          aria-pressed={value === option.value}
          className={value === option.value ? "is-active" : ""}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function CloseButton({ onClick, label = "Close" }) {
  return <IconButton name="close" label={label} onClick={onClick} />;
}
