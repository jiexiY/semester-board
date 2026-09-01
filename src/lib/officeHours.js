const WEEKDAY_LABELS = Object.freeze({
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
});

export function formatOfficeHoursEntry(entry = {}) {
  if (entry.status === "not_stated") return "Not stated in supplied syllabus";

  const days = Array.isArray(entry.weekdays)
    ? entry.weekdays.map((day) => WEEKDAY_LABELS[day] || day).join(" · ")
    : "";
  const scheduledTime = [days, entry.time].filter(Boolean).join(" · ") || "Hours TBD";

  return [
    scheduledTime,
    entry.location,
    entry.byAppointment ? "By appointment" : null,
  ].filter(Boolean).join(" · ");
}

export function officeHoursStatusLabel(status) {
  if (status === "confirmed") return "Syllabus confirmed";
  if (status === "tbd") return "Not yet specified";
  return "Not stated";
}
