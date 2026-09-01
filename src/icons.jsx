const iconPaths = {
  overview: <><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></>,
  document: <><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/></>,
  attendance: <><circle cx="12" cy="7" r="4"/><path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2"/></>,
  sources: <><path d="M3 5.5A4.5 4.5 0 0 1 7.5 1H11v18H7.5A4.5 4.5 0 0 0 3 23z"/><path d="M21 5.5A4.5 4.5 0 0 0 16.5 1H13v18h3.5A4.5 4.5 0 0 1 21 23z"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  export: <><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 13v7h14v-7"/></>,
  chevronRight: <path d="m9 18 6-6-6-6"/>,
  chevronLeft: <path d="m15 18-6-6 6-6"/>,
  chevronDown: <path d="m6 9 6 6 6-6"/>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
  warning: <><path d="M12 3 2.8 20h18.4z"/><path d="M12 9v5M12 17h.01"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  edit: <><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10z"/><path d="m13.5 6.5 3.5 3.5"/></>,
  download: <><path d="M12 3v12M8 11l4 4 4-4"/><path d="M5 19h14"/></>,
  upload: <><path d="M12 21V9M8 13l4-4 4 4"/><path d="M5 5h14"/></>,
  map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/></>,
  flag: <><path d="M5 21V4"/><path d="M5 5h11l-2 4 2 4H5"/></>,
  shield: <path d="M12 2 20 5v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V5z"/>,
  book: <><path d="M3 5.5A4.5 4.5 0 0 1 7.5 1H11v18H7.5A4.5 4.5 0 0 0 3 23z"/><path d="M21 5.5A4.5 4.5 0 0 0 16.5 1H13v18h3.5A4.5 4.5 0 0 1 21 23z"/></>,
  target: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></>,
  lab: <><path d="M9 2v6l-5 9.3A3.2 3.2 0 0 0 6.8 22h10.4a3.2 3.2 0 0 0 2.8-4.7L15 8V2"/><path d="M8 2h8M7 15h10"/><path d="M9.5 18h.01M14.5 18h.01"/></>,
  spark: <><path d="m12 2 1.5 6.5L20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/></>,
  message: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4.5A2.5 2.5 0 0 1 4 13.5z"/><path d="M8 8h8M8 12h5"/></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
  send: <><path d="m3 11 18-8-7 18-3-7z"/><path d="M11 14 21 3"/></>,
  fog: <><path d="M4 8h9M3 12h15M7 16h14"/><path d="M16 6h4M3 18h2"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  reset: <><path d="M4 7v5h5"/><path d="M5.5 16a8 8 0 1 0 0-8L4 9"/></>,
};

export function Icon({ name, size = 20, className = "", strokeWidth = 1.7 }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
    >
      {iconPaths[name]}
    </svg>
  );
}
