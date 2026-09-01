import test from "node:test";
import assert from "node:assert/strict";

import { generateCourseMeetings } from "../src/lib/calendar.js";
import { formatOfficeHoursEntry, officeHoursStatusLabel } from "../src/lib/officeHours.js";

const confirmed = {
  id: "office-confirmed",
  person: "Professor Example",
  role: "Instructor",
  weekdays: ["TU", "WE"],
  time: "12:00 PM–1:00 PM",
  location: "Office 200",
  status: "confirmed",
  byAppointment: true,
};

test("office-hours formatting distinguishes confirmed, appointment, and TBD schedules", () => {
  assert.equal(
    formatOfficeHoursEntry(confirmed),
    "Tue · Wed · 12:00 PM–1:00 PM · Office 200 · By appointment",
  );
  assert.equal(
    formatOfficeHoursEntry({ status: "tbd", weekdays: [], time: null, location: "Office 300" }),
    "Hours TBD · Office 300",
  );
  assert.equal(formatOfficeHoursEntry({ status: "not_stated" }), "Not stated in supplied syllabus");
  assert.equal(officeHoursStatusLabel("confirmed"), "Syllabus confirmed");
  assert.equal(officeHoursStatusLabel("tbd"), "Not yet specified");
});

test("office hours never become class meetings or attendance check-ins", () => {
  const course = {
    id: "course-office-hours",
    meetings: [{
      id: "class-pattern",
      weekdays: ["MO"],
      generation: "derived_from_term",
      range: { startDate: "2026-08-17", endDate: "2026-08-24" },
    }],
    officeHours: { status: "confirmed", entries: [confirmed] },
  };
  const term = { classesBegin: { date: "2026-08-17" }, classesEnd: { date: "2026-08-24" } };
  const withoutOfficeHours = { ...course };
  delete withoutOfficeHours.officeHours;
  assert.deepEqual(generateCourseMeetings(course, term), generateCourseMeetings(withoutOfficeHours, term));
});
