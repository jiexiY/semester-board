export const ATTENDANCE_STATUSES = Object.freeze([
  "not_checked",
  "present",
  "late",
  "absent_pending",
  "absent_excused",
  "absent_unexcused",
  "cancelled",
]);

const STATUS_SET = new Set(ATTENDANCE_STATUSES);

function entryStatus(entry) {
  const status = entry?.status ?? entry?.attendanceStatus ?? "not_checked";
  return STATUS_SET.has(status) ? status : "not_checked";
}

function entryIsEligible(entry) {
  return entryStatus(entry) !== "cancelled"
    && entry?.eligible !== false
    && entry?.checkInEnabled !== false;
}

function entryWeight(entry, unit) {
  if (unit !== "period") return 1;
  const weight = entry?.countWeight ?? entry?.weight ?? 1;
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

function getEntries(course, entries) {
  if (Array.isArray(entries)) return entries;
  if (Array.isArray(course?.attendanceEntries)) return course.attendanceEntries;
  if (Array.isArray(course?.meetingEntries)) return course.meetingEntries;
  if (Array.isArray(course?.meetings)) return course.meetings;
  return [];
}

function countStatus(entries, wantedStatus, unit = "meeting") {
  return entries.reduce((total, entry) => {
    if (!entryIsEligible(entry) || entryStatus(entry) !== wantedStatus) return total;
    return total + entryWeight(entry, unit);
  }, 0);
}

function countAnyStatus(entries, wantedStatuses, unit = "meeting") {
  const wanted = new Set(wantedStatuses);
  return entries.reduce((total, entry) => {
    if (!entryIsEligible(entry) || !wanted.has(entryStatus(entry))) return total;
    return total + entryWeight(entry, unit);
  }, 0);
}

function baseSummary(entries, policy) {
  const statusCounts = Object.fromEntries(ATTENDANCE_STATUSES.map((status) => [status, 0]));
  for (const entry of entries) statusCounts[entryStatus(entry)] += 1;

  const eligibleCount = entries.filter(entryIsEligible).length;
  const checkedCount = entries.filter((entry) => (
    entryIsEligible(entry) && entryStatus(entry) !== "not_checked"
  )).length;

  return {
    model: policy?.model ?? "unknown_threshold",
    countUnit: policy?.countUnit ?? "meeting",
    statusCounts,
    eligibleCount,
    checkedCount,
    uncheckedCount: Math.max(0, eligibleCount - checkedCount),
    pendingCount: countStatus(entries, "absent_pending", policy?.countUnit),
  };
}

function thresholdCounter(label, trigger, confirmedCount, pendingRiskCount) {
  const allowedBeforeTrigger = Math.max(0, trigger - 1);
  return {
    label,
    trigger,
    confirmedRemaining: Math.max(0, allowedBeforeTrigger - confirmedCount),
    pendingRiskRemaining: Math.max(0, allowedBeforeTrigger - pendingRiskCount),
    confirmedTriggered: confirmedCount >= trigger,
    pendingRiskTriggered: pendingRiskCount >= trigger,
  };
}

function meetingThresholdSummary(course, entries, policy, base) {
  // When the policy does not say excused absences are excluded, an
  // approved excused absence is therefore still a confirmed missed meeting;
  // a pending absence appears only in the pending-risk forecast.
  const confirmedMissed = countAnyStatus(
    entries,
    ["absent_excused", "absent_unexcused"],
    "meeting",
  );
  const pending = countStatus(entries, "absent_pending", "meeting");
  const pendingRiskMissed = confirmedMissed + pending;
  const policyCounters = policy?.counters ?? policy?.thresholds;
  const configuredCounters = Array.isArray(policyCounters) && policyCounters.length > 0
    ? policyCounters
    : [
      { label: "Missed meetings before 10% deduction", trigger: 2 },
      { label: "Missed meetings before course failure", trigger: 3 },
    ];

  return {
    ...base,
    courseId: course.id ?? null,
    metricLabel: "All missed meetings (conservative policy-risk count)",
    confirmedCount: confirmedMissed,
    pendingRiskCount: pendingRiskMissed,
    pendingCount: pending,
    limitKnown: true,
    counters: configuredCounters.map((counter) => thresholdCounter(
      counter.label ?? counter.counterLabel ?? counter.consequence,
      counter.trigger,
      confirmedMissed,
      pendingRiskMissed,
    )),
    scopeWarning: policy?.scopeWarning
      ?? "The syllabus does not say that excused absences are excluded from these thresholds.",
  };
}

function periodThresholdSummary(course, entries, policy, base) {
  const confirmedPeriods = countStatus(entries, "absent_unexcused", "period");
  const pendingPeriods = countStatus(entries, "absent_pending", "period");
  const pendingRiskPeriods = confirmedPeriods + pendingPeriods;
  const allowedBeforeFailure = policy?.allowedBeforeFailure ?? 6;
  const failureTrigger = policy?.failureTrigger ?? (allowedBeforeFailure + 1);

  return {
    ...base,
    courseId: course.id ?? null,
    metricLabel: policy?.counterLabel ?? "Missed periods before automatic-failure threshold",
    confirmedCount: confirmedPeriods,
    pendingRiskCount: pendingRiskPeriods,
    pendingCount: pendingPeriods,
    remaining: Math.max(0, allowedBeforeFailure - confirmedPeriods),
    pendingRiskRemaining: Math.max(0, allowedBeforeFailure - pendingRiskPeriods),
    failureTrigger,
    failureTriggered: confirmedPeriods >= failureTrigger,
    pendingRiskFailure: pendingRiskPeriods >= failureTrigger,
    limitKnown: true,
    counters: [thresholdCounter(
      policy?.counterLabel ?? "Missed periods before automatic-failure threshold",
      failureTrigger,
      confirmedPeriods,
      pendingRiskPeriods,
    )],
  };
}

function allowanceSummary(course, entries, policy, base) {
  const confirmedAbsences = countStatus(entries, "absent_unexcused", "meeting");
  const pendingAbsences = countStatus(entries, "absent_pending", "meeting");
  const pendingRiskAbsences = confirmedAbsences + pendingAbsences;
  const allowance = policy?.allowance ?? 3;

  return {
    ...base,
    courseId: course.id ?? null,
    metricLabel: policy?.counterLabel ?? "No-penalty absences remaining",
    confirmedCount: confirmedAbsences,
    pendingRiskCount: pendingRiskAbsences,
    pendingCount: pendingAbsences,
    allowance,
    remaining: Math.max(0, allowance - confirmedAbsences),
    pendingRiskRemaining: Math.max(0, allowance - pendingRiskAbsences),
    limitKnown: true,
    consequenceAfterAllowance: policy?.consequenceAfterAllowance ?? "TBD",
    displayNote: policy?.displayNote
      ?? "Penalty after the three-absence allowance is not stated.",
  };
}

function unknownSummary(course, entries, policy, base) {
  const unexcused = countStatus(entries, "absent_unexcused", "meeting");
  const pending = countStatus(entries, "absent_pending", "meeting");
  return {
    ...base,
    courseId: course.id ?? null,
    metricLabel: policy?.recordedMetric ?? "Unexcused absences recorded",
    confirmedCount: unexcused,
    pendingRiskCount: unexcused + pending,
    pendingCount: pending,
    remaining: null,
    pendingRiskRemaining: null,
    limitKnown: false,
    limitLabel: "Absence limit not stated",
    counters: [],
  };
}

/**
 * Computes the course-specific live attendance card. Pending excuses never
 * mutate into another status: they are shown separately as a risk forecast.
 */
export function computeAttendanceSummary(course, entries) {
  if (!course || typeof course !== "object") throw new TypeError("course is required");
  const resolvedEntries = getEntries(course, entries);
  const policy = course.attendancePolicy ?? {};
  const base = baseSummary(resolvedEntries, policy);

  if (policy.model === "unknown_threshold") {
    return unknownSummary(course, resolvedEntries, policy, base);
  }

  if (policy.model === "no_penalty_allowance") {
    return allowanceSummary(course, resolvedEntries, policy, base);
  }
  if (policy.model === "hard_threshold" && policy.countUnit === "period") {
    return periodThresholdSummary(course, resolvedEntries, policy, base);
  }
  if (policy.model === "hard_threshold") {
    return meetingThresholdSummary(course, resolvedEntries, policy, base);
  }
  return unknownSummary(course, resolvedEntries, policy, base);
}

function addCalendarDays(date, amount) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""))) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

function deadlineResult(overrides) {
  return {
    applies: true,
    kind: "excuse_documentation",
    date: null,
    dateStatus: "TBD",
    time: null,
    timeStatus: "TBD",
    ruleStatus: "TBD",
    exactDeadlineKnown: false,
    label: "Excuse deadline not stated",
    note: null,
    ...overrides,
  };
}

/**
 * Returns a human-readable rule without inventing a numeric excuse deadline.
 * A configured +7-day alternative-work rule is calculated only for an excused
 * absence that actually caused a missed in-class assignment.
 */
export function getExcuseDeadline(course, absence = {}) {
  if (!course || typeof course !== "object") throw new TypeError("course is required");
  const policy = course.attendancePolicy ?? {};
  const rules = Array.isArray(course.excuseRules) ? course.excuseRules : [];
  const status = entryStatus(absence);
  const referenceDate = absence.date
    ?? absence.meetingDate
    ?? absence.missedAssignmentDate
    ?? null;
  const reason = String(absence.reason ?? absence.scope ?? "").toLowerCase();
  const isEmergency = /emergency|illness|quarantine/.test(reason);
  const missedInClassAssignment = absence.missedInClassAssignment === true
    || absence.missedAssignment === true;

  const alternativeWorkRule = rules.find((rule) => /alternative work/iu.test(`${rule?.scope || ""} ${rule?.action || ""}`));
  if (alternativeWorkRule && status === "absent_excused" && missedInClassAssignment) {
      const calculatedDate = addCalendarDays(referenceDate, 7);
      if (calculatedDate) {
        return deadlineResult({
          kind: "alternative_work_proposal",
          date: calculatedDate,
          dateStatus: "provisional",
          ruleStatus: alternativeWorkRule.certainty || "confirmed",
          label: "Alternative-work proposal due",
          referenceDate,
          note: alternativeWorkRule.note || "Seven calendar days after the missed in-class assignment. This is not an excuse-document deadline.",
        });
      }
      return deadlineResult({
        kind: "alternative_work_proposal",
        ruleStatus: alternativeWorkRule.certainty || "confirmed",
        label: "Alternative-work proposal date unavailable — missed-assignment date required",
        referenceDate,
        note: "The +7-day calculation applies, but the missed-assignment date is missing.",
      });
  }
  if (alternativeWorkRule && missedInClassAssignment) {
    return deadlineResult({
      label: "Excuse documentation deadline not stated",
      referenceDate,
      note: "The alternative-work rule applies only after the absence is excused.",
    });
  }

  if (policy.model === "no_penalty_allowance") {
    const allowance = Number(policy.allowance);
    const allowancePosition = Number(absence.allowancePosition);
    if (absence.withinNoPenaltyAllowance === true
      || (Number.isFinite(allowancePosition) && allowancePosition >= 1 && allowancePosition <= allowance)) {
      return deadlineResult({
        applies: false,
        ruleStatus: "confirmed",
        label: "No justification required for this no-penalty absence",
        referenceDate,
      });
    }
  }

  const requestedScope = `${reason} ${absence.kind || ""}`;
  const matchingRule = rules.find((rule) => {
    const scope = String(rule?.scope || "").toLowerCase();
    if (!scope) return false;
    if (/discussion/iu.test(requestedScope) && scope.includes("discussion")) return true;
    if (/university|sponsored/iu.test(requestedScope) && /university|sponsored/iu.test(scope)) return true;
    if (isEmergency && /illness|emergency|quarantine/iu.test(scope)) return true;
    if (/lecture/iu.test(requestedScope) && scope.includes("lecture")) return true;
    if (!requestedScope.trim() && /general|other|documentation/iu.test(scope)) return true;
    return false;
  }) || rules.find((rule) => /planned|general|other|documentation/iu.test(String(rule?.scope || "")));

  if (matchingRule) {
    const action = String(matchingRule.action || "Contact the instructor.").trim();
    const deadline = String(matchingRule.deadline || "").trim();
    return deadlineResult({
      ruleStatus: matchingRule.certainty || "TBD",
      label: `${action}${deadline ? ` ${deadline}.` : " Exact deadline not stated."}`,
      referenceDate,
      note: matchingRule.note || null,
    });
  }

  return deadlineResult({ referenceDate });
}

/**
 * Summarizes check-in completion for one week. Preferred call shape is
 * summarizeWeek(week, meetings); summarizeWeek(meetings, week) is accepted to
 * keep the pure helper convenient in selectors.
 */
export function summarizeWeek(weekOrMeetings, meetingsOrWeek) {
  const firstIsArray = Array.isArray(weekOrMeetings);
  const meetings = firstIsArray
    ? weekOrMeetings
    : (Array.isArray(meetingsOrWeek) ? meetingsOrWeek : weekOrMeetings?.meetings ?? []);
  const week = firstIsArray ? meetingsOrWeek : weekOrMeetings;
  const startDate = week?.startDate ?? week?.start ?? null;
  const endDate = week?.endDate ?? week?.end ?? null;
  const inWeek = meetings.filter((meeting) => {
    if (!meeting?.date || (!startDate && !endDate)) return true;
    if (startDate && meeting.date < startDate) return false;
    if (endDate && meeting.date > endDate) return false;
    return true;
  });
  const eligible = inWeek.filter(entryIsEligible);
  const checked = eligible.filter((entry) => entryStatus(entry) !== "not_checked");
  const statusCounts = Object.fromEntries(ATTENDANCE_STATUSES.map((status) => [status, 0]));
  for (const entry of inWeek) statusCounts[entryStatus(entry)] += 1;

  const eligibleCount = eligible.length;
  const checkedCount = checked.length;
  return {
    weekId: week?.id ?? startDate,
    startDate,
    endDate,
    checked: checkedCount,
    eligible: eligibleCount,
    checkedCount,
    eligibleCount,
    uncheckedCount: Math.max(0, eligibleCount - checkedCount),
    completionRatio: eligibleCount === 0 ? 0 : checkedCount / eligibleCount,
    complete: eligibleCount > 0 && checkedCount === eligibleCount,
    statusCounts,
  };
}
