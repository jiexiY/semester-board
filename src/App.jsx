import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import AlignedSemesterBoard from "./components/AlignedSemesterBoard";
import AssistantChatbox from "./components/AssistantChatbox";
import AssignmentDeckPage from "./components/AssignmentDeckPage";
import AttendancePage from "./components/AttendancePage";
import CloudAccountGate from "./components/CloudAccountGate";
import CloudMigrationBoundary from "./components/CloudMigrationBoundary";
import {
  CloudSyncConflictPanel,
  CloudSyncProvider,
  useCloudSync,
} from "./components/CloudSyncProvider";
import GlassHeader from "./components/GlassHeader";
import LocalProfileGate, { LocalProfileRestoring } from "./components/LocalProfileGate";
import SemesterSetup from "./components/SemesterSetup";
import SyllabusPage from "./components/SyllabusPage";
import { AssignmentSheet, AttendanceSheet, ScheduleSheet } from "./components/GlassSheets";
import TaskLegend from "./components/TaskLegend";
import { useDashboardState } from "./hooks/useDashboardState";
import { useAssistant } from "./hooks/useAssistant";
import { useCloudAccount } from "./hooks/useCloudAccount";
import { useCloudAssistant } from "./hooks/useCloudAssistant";
import { useLocalProfile } from "./hooks/useLocalProfile";
import { useStudySourceLibrary } from "./hooks/useStudySourceLibrary";
import { useStudyGenerator } from "./hooks/useStudyGenerator";
import { Icon } from "./icons";
import { completeSafeLocalProfileSignOut } from "./lib/localProfiles.js";
import { updateExistingServiceWorker } from "./lib/pushClient.js";
import { computeAttendanceSummary } from "./lib/attendance";
import {
  allowancePositionForMeeting,
  eligibleAttendanceMeetings,
  selectDefaultAttendanceMeeting,
  sortAttendanceMeetings,
} from "./lib/attendanceFlow";
import {
  buildAttendanceCourseRows,
  mergeCourseAttendanceEntries,
  summarizeAttendanceRows,
} from "./lib/attendanceRecords";
import { attendanceLabel, buildIntegratedCourseTimeline } from "./lib/board";
import { buildTermWeeks, generateCourseMeetings } from "./lib/calendar";
import { campusDayPosition } from "./lib/currentDay";
import { buildDailyCourseGrid } from "./lib/dailyGrid";
import { CAMPUS_TIME_ZONE, campusDateKey, formatWeekRange } from "./lib/format";
import { semesterHasBoardData } from "./lib/semesterState.js";

const StudyDeckPage = lazy(() => import("./components/StudyDeckPage"));

const DAY_LABELS = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };

function parseClockRange(startTime, endTime) {
  if (!startTime) return null;
  return [startTime, endTime].filter(Boolean).join("–");
}

function clockMinutes(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
  if (!match) return Number.MAX_SAFE_INTEGER;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = match[3]?.toUpperCase();
  if (period === "AM" && hour === 12) hour = 0;
  if (period === "PM" && hour !== 12) hour += 12;
  return hour * 60 + minute;
}

function formatEnteredTime(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return value;
  const hour = Number(match[1]);
  const minute = match[2];
  const hour12 = hour % 12 || 12;
  return `${hour12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

function configuredCourses(sourceCourses, config, term, cloudMode = false) {
  return sourceCourses.map((course) => {
    const sourceMeetings = Array.isArray(course.meetings) ? course.meetings : [];
    const scheduleNeedsUserInput = sourceMeetings.length > 0 && sourceMeetings.every((meeting) => (
      meeting.generation === "blocked" || meeting.eventGeneration === "blocked"
    ));
    const savedPatterns = config.customMeetingsByCourse?.[course.id] || [];
    if (!scheduleNeedsUserInput || !savedPatterns.length) return course;
    return {
      ...course,
      meetings: savedPatterns.map((meeting, index) => ({
        ...meeting,
        id: meeting.id || `${course.id}-custom-${index + 1}`,
        kind: "class",
        time: parseClockRange(formatEnteredTime(meeting.startTime), formatEnteredTime(meeting.endTime)),
        timeCertainty: "user",
        location: null,
        locationCertainty: "tbd",
        generation: "derived_from_term",
        range: { startDate: term.classesBegin.date, endDate: term.classesEnd.date },
        exceptions: [],
        certainty: "user",
        note: cloudMode
          ? "Schedule entered by you and synced to your Semester Board account."
          : "Schedule entered by you and stored only in this browser.",
        sourceRefs: [],
      })),
    };
  });
}

function cancelledRows(course, config) {
  const rows = [];
  for (const pattern of course.meetings || []) {
    if (pattern.selectionGate && pattern.optionId !== config.sectionByCourse?.[course.id]) continue;
    for (const exception of pattern.exceptions || []) {
      rows.push({
        id: `${course.id}-${exception.date}-${pattern.id}-cancelled`,
        meetingId: `${course.id}-${exception.date}-${pattern.id}-cancelled`,
        courseId: course.id,
        date: exception.date,
        kind: "no-class",
        startTime: pattern.time?.split(/\s*[–—]\s*/, 2)[0] || pattern.startTime || null,
        status: "cancelled",
        label: exception.label,
        disabled: true,
        eligible: false,
        checkInEnabled: false,
        certainty: exception.certainty || "confirmed",
      });
    }
  }
  return rows;
}

function generateMeetings(courses, config, term) {
  if (!term) return [];
  return courses.flatMap((course) => [
    ...generateCourseMeetings(course, term, { selectedSection: config.sectionByCourse?.[course.id] || null }),
    ...cancelledRows(course, config),
  ]).sort((left, right) => left.date.localeCompare(right.date)
    || clockMinutes(left.startTime) - clockMinutes(right.startTime)
    || left.id.localeCompare(right.id));
}

function findCurrentWeekIndex(weeks, today) {
  if (!weeks.length) return 0;
  const exact = weeks.findIndex((week) => today >= week.start && today <= week.end);
  if (exact >= 0) return exact;
  return today < weeks[0].start ? 0 : weeks.length - 1;
}

function meetingPatternLabel(pattern) {
  const days = (pattern.weekdays || []).map((day) => DAY_LABELS[day] || day).join(" · ");
  return [days, pattern.time, pattern.location].filter(Boolean).join(" · ");
}

function scheduleLabel(course, config) {
  const meetings = Array.isArray(course.meetings) ? course.meetings : [];
  const selectedSection = config.sectionByCourse?.[course.id] || null;
  const usable = meetings.filter((pattern) => pattern.generation !== "blocked" && (!pattern.selectionGate || pattern.optionId === selectedSection));
  if (!usable.length) return "Schedule needed";
  const core = usable.map(meetingPatternLabel).filter(Boolean);
  if (meetings.some((pattern) => pattern.selectionGate) && !selectedSection) return `${core.join(" · ")} · Section needed`;
  return core.join(" · ");
}

function campusDateLabel(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: CAMPUS_TIME_ZONE,
  }).format(date);
}

function pageFromHash() {
  if (window.location.hash === "#attendance") return "attendance";
  if (window.location.hash === "#syllabi") return "syllabi";
  if (window.location.hash === "#assignments") return "assignments";
  return "semester";
}

function isStandaloneStudyDeckRoute() {
  return window.location.pathname.replace(/\/+$/u, "") === "/study-deck";
}

const DASHBOARD_PAGES = [
  { id: "semester", label: "Semester board", shortLabel: "Board", icon: "overview" },
  { id: "attendance", label: "Attendance", shortLabel: "Attendance", icon: "attendance" },
  { id: "syllabi", label: "Documents", shortLabel: "Docs", icon: "book" },
  { id: "assignments", label: "Assignment deck", shortLabel: "Tasks", icon: "document" },
];

function PageSwitcher({ activePage, onChange }) {
  const handleKeyDown = (event, index) => {
    let nextIndex = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % DASHBOARD_PAGES.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + DASHBOARD_PAGES.length) % DASHBOARD_PAGES.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = DASHBOARD_PAGES.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    onChange(DASHBOARD_PAGES[nextIndex].id);
    event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[nextIndex]?.focus();
  };

  return (
    <div className="page-switcher" role="tablist" aria-label="Dashboard pages">
      {DASHBOARD_PAGES.map((page, index) => (
        <button
          aria-controls={`${page.id}-page`}
          aria-selected={activePage === page.id}
          id={`page-tab-${page.id}`}
          key={page.id}
          onClick={() => onChange(page.id)}
          onKeyDown={(event) => handleKeyDown(event, index)}
          role="tab"
          tabIndex={activePage === page.id ? 0 : -1}
          type="button"
        >
          <Icon name={page.icon} size={17} />
          <span className="page-switcher-label-long">{page.label}</span>
          <span className="page-switcher-label-short">{page.shortLabel}</span>
        </button>
      ))}
    </div>
  );
}

function SoloStudyDeck({ onSignOut, profile }) {
  const cloudSync = useCloudSync();
  const dashboard = useDashboardState(profile.id);
  const cloudAssistant = useCloudAssistant(profile.id, {});
  const { state } = dashboard;
  const studySources = useStudySourceLibrary({
    client: cloudSync?.client || null,
    courseSpaceId: state.studyDeck?.selectedCourseSpaceId || null,
    enabled: true,
    profileId: profile.id,
    sourceRevision: Number(state.studyDeck?.sourceRevisionByCourse?.[
      state.studyDeck?.selectedCourseSpaceId
    ] || 0),
  });
  const studyGenerator = useStudyGenerator({
    aiStatus: cloudAssistant.status,
    courseSpaceId: state.studyDeck?.selectedCourseSpaceId || null,
    readSourceFile: studySources.readFile,
  });

  useEffect(() => {
    void cloudAssistant.checkConsent();
  }, [cloudAssistant.checkConsent]);

  const signOut = async () => {
    await cloudAssistant.endSessionConsent();
    await onSignOut();
  };

  return (
    <div className="solo-study-deck-app">
      <header className="solo-study-deck-topbar">
        <a className="solo-study-deck-brand" href="/study-deck" aria-label="Study Deck home">
          <span><Icon name="target" size={22} /></span>
          <div><strong>Study Deck</strong><small>Private source-grounded practice</small></div>
        </a>
        <div className="solo-study-deck-account">
          <span className={`saved-status saved-status-${cloudSync?.status?.tone || "local"}`}><Icon name="shield" size={16} />{cloudSync?.status?.label || "Saved on this device"}</span>
          <a href="/">Semester Board</a>
          <button onClick={signOut} type="button">Sign out</button>
        </div>
      </header>

      <div className="solo-study-deck-stage">
        <CloudSyncConflictPanel />
        {cloudAssistant.status === "needs-consent" ? (
          <aside className="solo-study-deck-ai" role="status">
            <div><Icon name="target" size={18} /><p><strong>AI generation is off.</strong> Browser-only generation still works. Enable AI only if you want bounded source excerpts sent to the configured provider when you generate.</p></div>
            <button onClick={cloudAssistant.grantConsent} type="button">Enable AI generation</button>
          </aside>
        ) : null}
        {cloudAssistant.status === "ready" ? (
          <aside className="solo-study-deck-ai is-ready" role="status">
            <div><Icon name="check" size={18} /><p><strong>AI generation is available.</strong> Original files remain private; generation still asks before sending bounded excerpts.</p></div>
            <button onClick={cloudAssistant.revokeConsent} type="button">Turn off AI</button>
          </aside>
        ) : null}
        <Suspense fallback={<p className="solo-study-deck-loading" role="status">Loading Study Deck…</p>}>
          <StudyDeckPage
            generationAccessStatus={cloudAssistant.status}
            generationStatus={studyGenerator.status}
            onAddSourceFiles={studySources.addFiles}
            onGenerateStudyDeck={studyGenerator.generate}
            onRemoveSourceFile={studySources.removeFile}
            onStudyDeckState={dashboard.saveStudyDeck}
            profileId={profile.id}
            sourceLibrary={studySources.sources}
            sourceUploadStatus={studySources.status}
            studyDeckState={state.studyDeck}
          />
        </Suspense>
      </div>
    </div>
  );
}

function SemesterDashboard({ onSignOut, profile }) {
  const cloudSync = useCloudSync();
  const dashboard = useDashboardState(profile.id);
  const { state } = dashboard;
  const semester = state.semester;
  const term = semester?.term || null;
  const semesterReady = semesterHasBoardData(semester);
  const [now, setNow] = useState(() => new Date());
  const [activeCourseIndex, setActiveCourseIndex] = useState(0);
  const [activePage, setActivePage] = useState(pageFromHash);
  const [sheet, setSheet] = useState(null);
  const [toast, setToast] = useState(profile.notice || null);

  const weeks = useMemo(() => (semesterReady ? buildTermWeeks(term) : []), [semesterReady, term]);
  const todayPosition = campusDayPosition(now);
  const todayKey = todayPosition.dateKey;
  const currentWeekIndex = findCurrentWeekIndex(weeks, todayKey);
  const todayFraction = todayPosition.fraction;
  const cloudMode = profile.syncMode === "cloud";
  const saveDestination = cloudMode ? "to your account" : "on this device";
  const courses = useMemo(
    () => (semesterReady ? configuredCourses(semester.courses, state.courseConfig, term, cloudMode) : []),
    [cloudMode, semester.courses, semesterReady, state.courseConfig, term],
  );
  const meetings = useMemo(() => generateMeetings(courses, state.courseConfig, term), [courses, state.courseConfig, term]);
  const effectiveAssignments = useMemo(() => (semester.assignments || []).map((assignment) => {
    const override = state.assignmentOverrides[assignment.id];
    return {
      ...assignment,
      _sourceDate: assignment.date,
      date: override?.date || assignment.date || null,
      time: override && Object.hasOwn(override, "time") ? override.time : assignment.time,
      dateCertainty: override?.date ? "user" : assignment.dateCertainty,
      certainty: override?.date ? "user" : assignment.certainty,
      _overridden: Boolean(override?.date),
    };
  }), [semester.assignments, state.assignmentOverrides]);
  const scheduleEvents = semester.scheduleEvents || [];

  const lanes = useMemo(() => courses.map((course) => {
    const courseAssignments = effectiveAssignments.filter((assignment) => assignment.courseId === course.id);
    const courseScheduleEvents = scheduleEvents.filter((event) => event.courseId === course.id);
    const courseMeetings = meetings.filter((meeting) => meeting.courseId === course.id);
    const entries = mergeCourseAttendanceEntries(course.id, meetings, state.checkins);
    const policyEntries = entries.filter((entry) => !(
      entry.manualRecord
      && course.attendancePolicy?.countUnit === "period"
      && !Number.isFinite(entry.countWeight)
    ));
    const summary = computeAttendanceSummary(course, policyEntries);
    return {
      course,
      meetings: courseMeetings,
      summary,
      attendanceText: attendanceLabel(course, summary),
      scheduleText: scheduleLabel(course, state.courseConfig),
      timeline: buildIntegratedCourseTimeline({
        assignments: courseAssignments,
        meetings: courseMeetings,
        scheduleEvents: courseScheduleEvents,
      }),
    };
  }), [courses, effectiveAssignments, meetings, scheduleEvents, state.checkins, state.courseConfig]);
  const dailyGrid = useMemo(() => (semesterReady ? buildDailyCourseGrid(
    lanes,
    term.classesBegin.date,
    term.finalExamWindow?.endDate || term.classesEnd.date,
  ) : { rows: [], outsideCells: [] }), [lanes, semesterReady, term]);
  const attendanceRows = useMemo(() => {
    const rows = buildAttendanceCourseRows(courses, meetings, state.checkins, todayKey);
    return rows.map((row) => {
      const lane = lanes.find((item) => item.course.id === row.course.id);
      return {
        ...row,
        attendanceText: lane?.attendanceText,
        scheduleText: lane?.scheduleText,
        summary: lane?.summary,
      };
    });
  }, [courses, lanes, meetings, state.checkins, todayKey]);
  const attendanceTotals = useMemo(
    () => summarizeAttendanceRows(attendanceRows),
    [attendanceRows],
  );
  const assistant = useAssistant({
    assignments: effectiveAssignments,
    attendanceTotals,
    checkins: state.checkins,
    completedAssignments: state.completedAssignments,
    courses,
    meetings,
    now,
    profileId: profile.id,
    scheduleEvents,
    syncMode: profile.syncMode,
  });

  const handleSignOut = async () => {
    setToast("Signing out on this device…");
    if (profile.syncMode === "cloud") {
      try {
        await assistant.push.disable({ requireSafe: true });
        await assistant.cloud.endSessionConsent();
        await onSignOut();
        setSheet(null);
      } catch {
        setToast("Could not safely turn off this account's closed-tab reminders. You are still signed in—try Sign out again, or turn reminders off in the assistant first.");
      }
      return;
    }
    try {
      await completeSafeLocalProfileSignOut({
        clearCloudConsent: () => { void assistant.cloud.endSessionConsent(); },
        disablePush: () => assistant.push.disable({ requireSafe: true }),
        signOut: onSignOut,
      });
      setSheet(null);
    } catch {
      setToast("Could not safely turn off closed-tab reminders. You are still signed in—try Sign out again, or turn reminders off in the assistant first.");
    }
  };

  useEffect(() => {
    const refreshNow = () => setNow(new Date());
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshNow();
    };
    const timer = window.setInterval(refreshNow, 60000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  useEffect(() => {
    const syncPage = () => {
      setActivePage(pageFromHash());
      setSheet(null);
    };
    window.addEventListener("hashchange", syncPage);
    return () => window.removeEventListener("hashchange", syncPage);
  }, []);

  useEffect(() => {
    if (!window.location.hash || ["#attendance", "#syllabi", "#assignments"].includes(window.location.hash)) return;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }, []);

  useEffect(() => {
    const close = (event) => { if (event.key === "Escape") setSheet(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selectedCourse = sheet?.courseId ? courses.find((course) => course.id === sheet.courseId) : null;
  const selectedLane = sheet?.courseId ? lanes.find((lane) => lane.course.id === sheet.courseId) : null;
  const selectedAssignment = sheet?.assignmentId ? effectiveAssignments.find((assignment) => assignment.id === sheet.assignmentId) : null;
  const allSelectedMeetings = selectedLane ? sortAttendanceMeetings(selectedLane.meetings) : [];
  const selectedMeetings = eligibleAttendanceMeetings(allSelectedMeetings);
  const selectedMeeting = sheet?.meetingId
    ? allSelectedMeetings.find((meeting) => meeting.id === sheet.meetingId) || null
    : null;
  const selectedMeetingIndex = sheet?.meetingId
    ? selectedMeetings.findIndex((meeting) => meeting.id === sheet.meetingId)
    : -1;
  const selectedAllowancePosition = allowancePositionForMeeting(
    selectedCourse,
    selectedMeeting,
    selectedMeetings,
    state.checkins,
  );

  const safeImport = async (file) => {
    try {
      await dashboard.importBackup(file);
      setToast(cloudMode ? "Backup imported and queued to sync" : "Backup imported into this browser");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "That backup could not be imported");
    }
  };

  const toggleAssignment = (assignmentId) => {
    const wasComplete = Boolean(state.completedAssignments[assignmentId]);
    dashboard.toggleAssignment(assignmentId);
    setToast(wasComplete ? "Assignment reopened" : "Assignment completed");
  };

  const setAssignmentWorkStatus = (assignmentId, workStatus) => {
    dashboard.saveAssignmentWorkflow(assignmentId, { workStatus });
    const label = workStatus === "completed" ? "Completed" : workStatus === "in-progress" ? "In progress" : "Not started";
    setToast(`Work status: ${label}`);
  };

  const setAssignmentSubmissionStatus = (assignmentId, submissionStatus) => {
    dashboard.saveAssignmentWorkflow(assignmentId, { submissionStatus });
    const label = submissionStatus === "submitted" ? "Submitted" : submissionStatus === "missed" ? "Missed in Canvas" : submissionStatus === "not-submitted" ? "Not submitted" : "Not marked";
    setToast(`Canvas submission: ${label}`);
  };

  const openCourseAttendance = (lane) => {
    const meeting = selectDefaultAttendanceMeeting(
      lane.meetings,
      state.checkins,
      campusDateKey(now),
    );
    setSheet({
      type: "attendance",
      courseId: lane.course.id,
      meetingId: meeting?.id || null,
    });
  };

  const changePage = (page) => {
    setActivePage(page);
    setSheet(null);
    const hash = page === "semester" ? "" : `#${page}`;
    const nextUrl = `${window.location.pathname}${window.location.search}${hash}`;
    window.history.replaceState(null, "", nextUrl);
  };

  const addManualAttendanceRecord = (record) => {
    const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const meetingId = `manual-attendance-${suffix}`;
    dashboard.saveCheckin(meetingId, {
      ...record,
      checkInEnabled: true,
      createdAt: new Date().toISOString(),
      eligible: true,
      manualRecord: true,
    });
    setToast(`Canvas attendance record saved ${saveDestination}`);
  };

  const updateManualAttendanceRecord = (meetingId, updates) => {
    const current = state.checkins[meetingId];
    if (!current || (!current.manualRecord && !current.migrationReview)) return;
    dashboard.saveCheckin(meetingId, { ...current, ...updates });
    setToast(`Attendance record updated ${saveDestination}`);
  };

  const navigateAttendance = (direction) => {
    const nextIndex = selectedMeetingIndex + direction;
    const meeting = selectedMeetings[nextIndex];
    if (!meeting) return;
    setSheet((current) => ({ ...current, meetingId: meeting.id }));
  };

  return (
    <div className="board-app">
      <GlassHeader
        dateLabel={campusDateLabel(now)}
        onSignOut={handleSignOut}
        onExport={() => { dashboard.exportBackup(); setToast("Backup exported"); }}
        onImport={safeImport}
        onReset={() => {
          const confirmed = window.confirm(cloudMode
            ? "Reset all synced completion and attendance progress for this account? This will update every signed-in device."
            : "Reset all locally stored completion and attendance progress?");
          if (confirmed) {
            dashboard.resetProgress();
            setToast(cloudMode ? "Account progress reset and queued to sync" : "Local progress reset");
          }
        }}
        profile={profile}
        syncStatus={cloudSync?.status || null}
        termLabel={term?.label || "My semester"}
        weekLabel={weeks.length ? `Week ${currentWeekIndex + 1} · ${formatWeekRange(weeks[currentWeekIndex])}` : "Upload semester data"}
      />

      <PageSwitcher activePage={activePage} onChange={changePage} />
      <div className="dashboard-stage">
        <CloudSyncConflictPanel />

        <div className="dashboard-page-viewport">
          {activePage === "semester" ? (
            <div aria-labelledby="page-tab-semester" id="semester-page" role="tabpanel">
              {!semesterReady ? (
                <SemesterSetup
                  cloudMode={cloudMode}
                  onImportBackup={safeImport}
                  onOpenDocuments={() => changePage("syllabi")}
                  onSaveSemester={(nextSemester) => {
                    dashboard.saveSemester(nextSemester);
                    setToast(cloudMode ? "Semester created and queued to sync" : "Semester created on this device");
                  }}
                />
              ) : (
                <>
                  <TaskLegend />

                  <div className="mobile-course-switcher" role="tablist" aria-label="Courses">
                {lanes.map((lane, index) => (
                  <button
                    aria-controls={`course-column-${index}`}
                    aria-selected={activeCourseIndex === index}
                    key={lane.course.id}
                    onClick={() => setActiveCourseIndex(index)}
                    role="tab"
                    type="button"
                  >{lane.course.code.split(" ")[0]}</button>
                ))}
                    <div className="mobile-position"><strong>{activeCourseIndex + 1}</strong> of {lanes.length}</div>
                  </div>

                  <AlignedSemesterBoard
                activeCourseIndex={activeCourseIndex}
                checkins={state.checkins}
                completed={state.completedAssignments}
                dayRows={dailyGrid.rows}
                lanes={lanes}
                onAssignment={(course, assignment) => setSheet({
                  type: "assignment",
                  courseId: course.id,
                  assignmentId: assignment.linkedAssignmentId || assignment.id,
                })}
                onAttendance={openCourseAttendance}
                onMeeting={(course, meeting) => setSheet({ type: "attendance", courseId: course.id, meetingId: meeting.id })}
                onSchedule={(course) => setSheet({ type: "schedule", courseId: course.id })}
                onToggle={toggleAssignment}
                outsideCells={dailyGrid.outsideCells}
                todayFraction={todayFraction}
                todayKey={todayKey}
                  />
                </>
              )}
            </div>
          ) : activePage === "attendance" ? (
            <AttendancePage
              onAddRecord={addManualAttendanceRecord}
              onOpenCourse={(courseId) => {
                const lane = lanes.find((item) => item.course.id === courseId);
                if (lane) openCourseAttendance(lane);
              }}
              onUpdateRecord={updateManualAttendanceRecord}
              rows={attendanceRows}
              storageMode={profile.syncMode}
              todayKey={todayKey}
              totals={attendanceTotals}
            />
          ) : activePage === "syllabi" ? (
            <SyllabusPage cloudClient={cloudSync?.client || null} profileId={profile.id} />
          ) : activePage === "assignments" ? (
            <AssignmentDeckPage
              assignments={effectiveAssignments}
              assignmentWorkflow={state.assignmentWorkflow}
              completed={state.completedAssignments}
              courses={courses}
              onOpenAssignment={(assignment) => setSheet({
                type: "assignment",
                courseId: assignment.courseId,
                assignmentId: assignment.id,
              })}
              onSetSubmissionStatus={setAssignmentSubmissionStatus}
              onSetWorkStatus={setAssignmentWorkStatus}
              todayKey={todayKey}
            />
          ) : null}
        </div>
      </div>

      {sheet?.type === "assignment" ? (
        <AssignmentSheet
          assignment={selectedAssignment}
          course={selectedCourse}
          onClose={() => setSheet(null)}
          onSave={(assignmentId, override) => { dashboard.saveAssignmentOverride(assignmentId, override); setToast(`Verified date saved ${saveDestination}`); }}
        />
      ) : null}
      {sheet?.type === "attendance" && selectedLane ? (
        <AttendanceSheet
          allowancePosition={selectedAllowancePosition}
          attendanceText={selectedLane.attendanceText}
          checkins={state.checkins}
          course={selectedCourse}
          meeting={selectedMeeting}
          meetingCount={selectedMeetings.length}
          meetingIndex={selectedMeetingIndex}
          onClose={() => setSheet(null)}
          onNext={() => navigateAttendance(1)}
          onPrevious={() => navigateAttendance(-1)}
          onSave={(meetingId, entry) => { dashboard.saveCheckin(meetingId, entry); setToast(`Attendance saved · ${entry.status.replaceAll("_", " ")}`); }}
          summary={selectedLane.summary}
        />
      ) : null}
      {sheet?.type === "schedule" ? (
        <ScheduleSheet
          course={selectedCourse}
          courseConfig={state.courseConfig}
          onClose={() => setSheet(null)}
          onSave={(config) => { dashboard.saveCourseConfig(config); setToast(`Schedule saved ${saveDestination}`); }}
        />
      ) : null}

      <AssistantChatbox assistant={assistant} />
      {toast ? <div className="glass-toast" role="status">{toast}</div> : null}
    </div>
  );
}

export default function App() {
  const localProfile = useLocalProfile();
  const cloudAccount = useCloudAccount();
  const [useLocalOnly, setUseLocalOnly] = useState(false);
  const standaloneStudyDeck = isStandaloneStudyDeckRoute();

  useEffect(() => {
    void updateExistingServiceWorker(window.navigator);
  }, []);

  useEffect(() => {
    document.title = standaloneStudyDeck ? "Study Deck" : "Semester Board";
  }, [standaloneStudyDeck]);

  if (cloudAccount.configured && !useLocalOnly && cloudAccount.status === "restoring") {
    return <LocalProfileRestoring profileName="your cloud account" productName={standaloneStudyDeck ? "Study Deck" : "Semester Board"} productSubtitle={standaloneStudyDeck ? "Private source-grounded practice" : "Private course workspace"} />;
  }

  if (cloudAccount.configured && !useLocalOnly && !cloudAccount.profile) {
    return (
      <CloudAccountGate
        account={cloudAccount}
        localProfiles={localProfile.profiles}
        onUseLocal={() => setUseLocalOnly(true)}
        privacyDescription={standaloneStudyDeck ? "Courses, source metadata, generated decks, quiz progress, and Study Deck settings sync to private Supabase storage for this account. Source files use private account storage. AI consent stays on this device." : undefined}
        productDescription={standaloneStudyDeck ? "Use one private account to keep your courses, source library, and study progress available across your devices." : undefined}
        productName={standaloneStudyDeck ? "Study Deck" : "Semester Board"}
      />
    );
  }

  if (cloudAccount.configured && !useLocalOnly && cloudAccount.profile) {
    return (
      <CloudSyncProvider client={cloudAccount.client} key={cloudAccount.profile.id} userId={cloudAccount.profile.id}>
        <CloudMigrationBoundary account={cloudAccount} localProfiles={localProfile.profiles} productName={standaloneStudyDeck ? "Study Deck" : "Semester Board"} productSubtitle={standaloneStudyDeck ? "Private source-grounded practice" : "Private course workspace"}>
          {standaloneStudyDeck ? (
            <SoloStudyDeck
              key={cloudAccount.profile.id}
              onSignOut={() => cloudAccount.signOut({ everywhere: false })}
              profile={cloudAccount.profile}
            />
          ) : (
            <SemesterDashboard
              key={cloudAccount.profile.id}
              onSignOut={() => cloudAccount.signOut({ everywhere: false })}
              profile={cloudAccount.profile}
            />
          )}
        </CloudMigrationBoundary>
      </CloudSyncProvider>
    );
  }

  if (localProfile.restoring) {
    return <LocalProfileRestoring profileName={localProfile.restoringProfileName} productName={standaloneStudyDeck ? "Study Deck" : "Semester Board"} productSubtitle={standaloneStudyDeck ? "Private source-grounded practice" : "Private course workspace"} />;
  }

  if (!localProfile.profile) {
    return (
      <LocalProfileGate
        createProfile={localProfile.createProfile}
        notice={localProfile.restoreNotice || (!cloudAccount.configured
          ? "Cross-device accounts are not configured in this build yet. Device-only profiles remain available."
          : null)}
        profiles={localProfile.profiles}
        productName={standaloneStudyDeck ? "Study Deck" : "Semester Board"}
        profileDescription={standaloneStudyDeck ? "Profiles remember each person’s courses, private source library, generated decks, quizzes, and progress on this browser." : undefined}
        signIn={localProfile.signIn}
      />
    );
  }

  return standaloneStudyDeck ? (
    <SoloStudyDeck
      key={localProfile.profile.id}
      onSignOut={() => {
        localProfile.signOut();
        if (cloudAccount.configured) setUseLocalOnly(false);
      }}
      profile={{ ...localProfile.profile, syncMode: "local" }}
    />
  ) : (
    <SemesterDashboard
      key={localProfile.profile.id}
      onSignOut={() => {
        localProfile.signOut();
        if (cloudAccount.configured) setUseLocalOnly(false);
      }}
      profile={{ ...localProfile.profile, syncMode: "local" }}
    />
  );
}
