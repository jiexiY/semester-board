import { useCallback } from "react";
import { useSyncedResource } from "./useSyncedResource.js";
import { PROFILE_RESOURCES } from "../lib/profileStorage.js";
import {
  DEFAULT_SEMESTER_STATE,
  normalizeSemesterState,
  privateSemesterFromImport,
} from "../lib/semesterState.js";

const SCHEMA_VERSION = 3;

const STUDY_METHODS = new Set(["flashcards", "fill", "true-false", "multiple-answer"]);
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_DECK_STATE_KEYS = 32;
const MAX_ERROR_BOOK_ENTRIES_PER_DECK = 50;
const MAX_ERROR_BOOK_HISTORY = 12;
const MAX_ERROR_BOOK_TOTAL_BYTES = 64 * 1024;
const MAX_REVISION = 1_000_000_000;
const MAX_ASSIGNMENT_WORKFLOW_ENTRIES = 256;
const WORK_STATUSES = new Set(["not-started", "in-progress", "completed"]);
const SUBMISSION_STATUSES = new Set(["not-marked", "not-submitted", "submitted", "missed"]);
const MAX_COACH_CHECKS = 600;
const COACH_CHECK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,219}$/u;
const COACH_COURSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export const MAX_CUSTOM_DECK_BYTES = 700 * 1024;
export const MAX_CUSTOM_DECK_TOTAL_BYTES = 720 * 1024;
export const MAX_CUSTOM_DECKS = 12;
export const MAX_COURSE_SPACES = 12;

export const DEFAULT_STUDY_DECK_STATE = Object.freeze({
  selectedCourseSpaceId: null,
  courseSpaces: Object.freeze([]),
  selectedDeckByCourse: Object.freeze({}),
  sourceRevisionByCourse: Object.freeze({}),
  deckSourceRevisionByDeck: Object.freeze({}),
  selectedDeckId: null,
  challengeByDeck: Object.freeze({}),
  methodByDeck: Object.freeze({}),
  errorBookByDeck: Object.freeze({}),
  reviewStartByDeck: Object.freeze({}),
  generationSettingsByCourse: Object.freeze({}),
  customDecks: Object.freeze({}),
});

export const DEFAULT_DASHBOARD_STATE = {
  schemaVersion: SCHEMA_VERSION,
  updatedAt: null,
  semester: DEFAULT_SEMESTER_STATE,
  checkins: {},
  completedAssignments: {},
  assignmentWorkflow: {
    byAssignment: {},
  },
  assignmentOverrides: {},
  academicCoach: {
    chapterByCourse: {},
    completedChecks: {},
  },
  courseConfig: {
    sectionByCourse: {},
    customMeetingsByCourse: {},
  },
  studyDeck: DEFAULT_STUDY_DECK_STATE,
};

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeIdentifier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return null;
  }
  if (["__proto__", "constructor", "prototype"].includes(normalized)) return null;
  return normalized;
}

function normalizeText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeDate(value) {
  if (typeof value !== "string" || value.length > 80) return null;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function normalizeRevision(value) {
  if (value === null || value === "" || (typeof value !== "number" && typeof value !== "string")) return null;
  const revision = Number(value);
  if (!Number.isFinite(revision) || revision < 0) return null;
  return Math.min(MAX_REVISION, Math.floor(revision));
}

function normalizeCourseConfig(value, semester) {
  const source = isRecord(value) ? value : {};
  const courses = Array.isArray(semester?.courses) ? semester.courses : [];
  const validCourseIds = new Set(courses.map((course) => course.id));
  const sectionByCourse = {};
  for (const [rawCourseId, rawOptionId] of Object.entries(
    isRecord(source.sectionByCourse) ? source.sectionByCourse : {},
  ).slice(0, MAX_COURSE_SPACES * 2)) {
    const courseId = normalizeIdentifier(rawCourseId);
    const optionId = normalizeIdentifier(rawOptionId);
    if (courseId && optionId && validCourseIds.has(courseId)) sectionByCourse[courseId] = optionId;
  }

  const customMeetingsByCourse = {};
  for (const [rawCourseId, rawPatterns] of Object.entries(
    isRecord(source.customMeetingsByCourse) ? source.customMeetingsByCourse : {},
  ).slice(0, MAX_COURSE_SPACES * 2)) {
    const courseId = normalizeIdentifier(rawCourseId);
    if (!courseId || !validCourseIds.has(courseId) || !Array.isArray(rawPatterns)) continue;
    customMeetingsByCourse[courseId] = rawPatterns.slice(0, 8)
      .filter(isRecord)
      .map((pattern, index) => ({
        id: normalizeIdentifier(pattern.id) || `${courseId}-custom-${index + 1}`,
        weekdays: Array.isArray(pattern.weekdays)
          ? pattern.weekdays.filter((day) => ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].includes(day)).slice(0, 7)
          : [],
        startTime: normalizeText(pattern.startTime, 20),
        endTime: normalizeText(pattern.endTime, 20),
        countWeight: Number(pattern.countWeight) === 2 ? 2 : 1,
      }));
  }

  // Version 1 stored two one-course setup values. Migrate them by shape only,
  // so the public client no longer contains any personal course identifiers.
  const legacySection = normalizeIdentifier(source.syaSection);
  if (legacySection && !Object.keys(sectionByCourse).length) {
    const selectable = courses.filter((course) => course.meetings?.some((meeting) => meeting.selectionGate));
    if (selectable.length === 1) sectionByCourse[selectable[0].id] = legacySection;
  }
  if (Array.isArray(source.encMeetings) && !Object.keys(customMeetingsByCourse).length) {
    const editable = courses.filter((course) => course.meetings?.length
      && course.meetings.every((meeting) => meeting.generation === "blocked" || meeting.eventGeneration === "blocked"));
    if (editable.length === 1) {
      customMeetingsByCourse[editable[0].id] = source.encMeetings.slice(0, 8)
        .filter(isRecord)
        .map((pattern, index) => ({
          id: normalizeIdentifier(pattern.id) || `${editable[0].id}-custom-${index + 1}`,
          weekdays: Array.isArray(pattern.weekdays) ? pattern.weekdays.slice(0, 7) : [],
          startTime: normalizeText(pattern.startTime, 20),
          endTime: normalizeText(pattern.endTime, 20),
          countWeight: Number(pattern.countWeight) === 2 ? 2 : 1,
        }));
    }
  }
  return { sectionByCourse, customMeetingsByCourse };
}

export function normalizeAssignmentWorkflow(value) {
  const source = isRecord(value) && isRecord(value.byAssignment) ? value.byAssignment : {};
  const byAssignment = {};
  for (const [rawAssignmentId, rawEntry] of Object.entries(source).slice(0, MAX_ASSIGNMENT_WORKFLOW_ENTRIES * 2)) {
    const assignmentId = normalizeIdentifier(rawAssignmentId);
    if (!assignmentId || !isRecord(rawEntry)) continue;
    const workStatus = WORK_STATUSES.has(rawEntry.workStatus) ? rawEntry.workStatus : null;
    const submissionStatus = SUBMISSION_STATUSES.has(rawEntry.submissionStatus) ? rawEntry.submissionStatus : null;
    const updatedAt = normalizeDate(rawEntry.updatedAt);
    if (!workStatus && !submissionStatus) continue;
    byAssignment[assignmentId] = {
      ...(workStatus ? { workStatus } : {}),
      ...(submissionStatus ? { submissionStatus } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
    if (Object.keys(byAssignment).length >= MAX_ASSIGNMENT_WORKFLOW_ENTRIES) break;
  }
  return { byAssignment };
}

export function normalizeAcademicCoach(value) {
  const source = isRecord(value) ? value : {};
  const completedChecks = {};
  for (const [rawId, rawDate] of Object.entries(isRecord(source.completedChecks) ? source.completedChecks : {}).slice(0, MAX_COACH_CHECKS * 2)) {
    const id = String(rawId || "").trim();
    const completedAt = normalizeDate(rawDate);
    if (!COACH_CHECK_ID_PATTERN.test(id) || !completedAt) continue;
    completedChecks[id] = completedAt;
    if (Object.keys(completedChecks).length >= MAX_COACH_CHECKS) break;
  }
  const chapterByCourse = {};
  for (const [rawCourseId, rawChapter] of Object.entries(isRecord(source.chapterByCourse) ? source.chapterByCourse : {}).slice(0, MAX_COURSE_SPACES * 2)) {
    const courseId = normalizeIdentifier(rawCourseId);
    const chapter = normalizeText(rawChapter, 160);
    if (courseId && COACH_COURSE_ID_PATTERN.test(courseId) && chapter) chapterByCourse[courseId] = chapter;
  }
  return { chapterByCourse, completedChecks };
}

function safeDeckEntries(value, limit = MAX_DECK_STATE_KEYS) {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .map(([key, entry]) => [normalizeIdentifier(key), entry])
    .filter(([key]) => key)
    .slice(0, limit);
}

function serializedByteLength(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function normalizeCourseSpaces(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const courseSpaces = [];
  for (const candidate of value.slice(0, MAX_COURSE_SPACES * 4)) {
    if (!isRecord(candidate)) continue;
    const id = normalizeIdentifier(candidate.id);
    const name = normalizeText(candidate.name, 120);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    courseSpaces.push({
      id,
      name,
      code: normalizeText(candidate.code, 32),
      createdAt: normalizeDate(candidate.createdAt),
      archived: candidate.archived === true,
    });
    if (courseSpaces.length >= MAX_COURSE_SPACES) break;
  }
  return courseSpaces;
}

function normalizeResponse(value, maxStringLength = 500) {
  if (typeof value === "string") return normalizeText(value, maxStringLength);
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => normalizeResponse(item, 120))
      .filter((item) => item !== undefined);
  }
  return undefined;
}

function normalizeErrorHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_ERROR_BOOK_HISTORY).filter(isRecord).map((entry) => {
    const response = normalizeResponse(entry.response, 300);
    const occurredAt = normalizeDate(entry.occurredAt);
    return {
      ...(response === undefined ? {} : { response }),
      correct: entry.correct === true,
      ...(occurredAt ? { occurredAt } : {}),
    };
  });
}

function normalizeErrorEntry(value) {
  if (!isRecord(value)) return null;
  const key = normalizeIdentifier(value.key);
  const cardId = normalizeIdentifier(value.cardId);
  const practiceMethod = STUDY_METHODS.has(value.practiceMethod) ? value.practiceMethod : null;
  if (!key || !cardId || !practiceMethod) return null;
  return {
    key,
    cardId,
    question: normalizeText(value.question, 600),
    practiceMethod,
    response: normalizeResponse(value.response),
    correctAnswer: normalizeText(value.correctAnswer, 1_000),
    explanation: normalizeText(value.explanation, 1_200),
    source: normalizeText(value.source, 600),
    reason: normalizeText(value.reason, 160),
    needsReview: value.needsReview === true,
    history: normalizeErrorHistory(value.history),
  };
}

function normalizeCustomDecks(value, validCourseIds) {
  const customDecks = {};
  const rejectedDeckIds = new Set();
  let customDeckBytes = 0;
  let accepted = 0;
  for (const [rawDeckId, deck] of safeDeckEntries(value, MAX_CUSTOM_DECKS * 4)) {
    const deckId = normalizeIdentifier(rawDeckId);
    const courseSpaceId = normalizeIdentifier(deck?.courseSpaceId);
    if (!deckId || !isRecord(deck) || !courseSpaceId || !validCourseIds.has(courseSpaceId)
      || !Array.isArray(deck.cards) || deck.cards.length === 0 || deck.cards.length > 200) {
      if (deckId) rejectedDeckIds.add(deckId);
      continue;
    }
    const normalizedDeck = { ...deck, id: deckId, courseSpaceId };
    const bytes = serializedByteLength(normalizedDeck);
    if (accepted >= MAX_CUSTOM_DECKS || bytes > MAX_CUSTOM_DECK_BYTES
      || customDeckBytes + bytes > MAX_CUSTOM_DECK_TOTAL_BYTES) {
      rejectedDeckIds.add(deckId);
      continue;
    }
    customDecks[deckId] = normalizedDeck;
    customDeckBytes += bytes;
    accepted += 1;
  }
  return { customDecks, rejectedDeckIds };
}

export function normalizeStudyDeckState(value) {
  const source = isRecord(value) ? value : {};
  const courseSpaces = normalizeCourseSpaces(source.courseSpaces);
  const validCourseIds = new Set(courseSpaces.map((course) => course.id));
  const activeCourseIds = new Set(courseSpaces.filter((course) => !course.archived).map((course) => course.id));
  const { customDecks, rejectedDeckIds } = normalizeCustomDecks(source.customDecks, validCourseIds);
  const selectedCourseSpaceId = normalizeIdentifier(source.selectedCourseSpaceId);
  const selectedDeckByCourse = Object.fromEntries(safeDeckEntries(source.selectedDeckByCourse, MAX_COURSE_SPACES * 2)
    .map(([courseId, deckId]) => [courseId, normalizeIdentifier(deckId)])
    .filter(([courseId, deckId]) => {
      if (!validCourseIds.has(courseId) || !deckId || rejectedDeckIds.has(deckId)) return false;
      return !customDecks[deckId] || customDecks[deckId].courseSpaceId === courseId;
    }));
  const sourceRevisionByCourse = Object.fromEntries(safeDeckEntries(source.sourceRevisionByCourse, MAX_COURSE_SPACES * 2)
    .map(([courseId, revision]) => [courseId, normalizeRevision(revision)])
    .filter(([courseId, revision]) => validCourseIds.has(courseId) && revision !== null));
  const deckSourceRevisionByDeck = Object.fromEntries(safeDeckEntries(source.deckSourceRevisionByDeck)
    .map(([deckId, revision]) => [deckId, normalizeRevision(revision)])
    .filter(([deckId, revision]) => !rejectedDeckIds.has(deckId) && revision !== null));
  const challengeByDeck = Object.fromEntries(safeDeckEntries(source.challengeByDeck)
    .map(([deckId, challenge]) => [deckId, Number(challenge)])
    .filter(([deckId, challenge]) => !rejectedDeckIds.has(deckId)
      && Number.isInteger(challenge) && challenge >= 1 && challenge <= 10));
  const methodByDeck = Object.fromEntries(safeDeckEntries(source.methodByDeck)
    .filter(([deckId, method]) => !rejectedDeckIds.has(deckId) && STUDY_METHODS.has(method)));
  const errorBookByDeck = {};
  let errorBookBytes = 0;
  for (const [deckId, entries] of safeDeckEntries(source.errorBookByDeck)) {
    if (rejectedDeckIds.has(deckId) || !Array.isArray(entries)) continue;
    const normalizedEntries = [];
    for (const entry of entries.slice(0, MAX_ERROR_BOOK_ENTRIES_PER_DECK)) {
      const normalizedEntry = normalizeErrorEntry(entry);
      if (!normalizedEntry) continue;
      const bytes = serializedByteLength(normalizedEntry);
      if (errorBookBytes + bytes > MAX_ERROR_BOOK_TOTAL_BYTES) break;
      normalizedEntries.push(normalizedEntry);
      errorBookBytes += bytes;
    }
    if (normalizedEntries.length) errorBookByDeck[deckId] = normalizedEntries;
    if (errorBookBytes >= MAX_ERROR_BOOK_TOTAL_BYTES) break;
  }
  const reviewStartByDeck = Object.fromEntries(safeDeckEntries(source.reviewStartByDeck)
    .map(([deckId, start]) => [deckId, typeof start === "string" ? start.trim() : start])
    .filter(([deckId, start]) => !rejectedDeckIds.has(deckId)
      && typeof start === "string" && start.length <= 40 && !Number.isNaN(new Date(start).getTime())));
  const generationSettingsByCourse = Object.fromEntries(safeDeckEntries(source.generationSettingsByCourse, MAX_COURSE_SPACES * 2)
    .map(([courseId, settings]) => {
      if (!validCourseIds.has(courseId) || !isRecord(settings)) return [courseId, null];
      const questionCount = Number(settings.questionCount);
      const challenge = Number(settings.challenge);
      return [courseId, {
        focus: normalizeText(settings.focus, 240),
        questionCount: Number.isInteger(questionCount) && questionCount >= 1 && questionCount <= 8 ? questionCount : 8,
        challenge: Number.isInteger(challenge) && challenge >= 1 && challenge <= 10 ? challenge : 6,
      }];
    })
    .filter(([, settings]) => settings));
  const normalizedSelectedDeckId = normalizeIdentifier(source.selectedDeckId);
  const selectedDeckId = normalizedSelectedDeckId && !rejectedDeckIds.has(normalizedSelectedDeckId)
    ? normalizedSelectedDeckId
    : null;

  return {
    selectedCourseSpaceId: selectedCourseSpaceId && activeCourseIds.has(selectedCourseSpaceId)
      ? selectedCourseSpaceId
      : null,
    courseSpaces,
    selectedDeckByCourse,
    sourceRevisionByCourse,
    deckSourceRevisionByDeck,
    selectedDeckId,
    challengeByDeck,
    methodByDeck,
    errorBookByDeck,
    reviewStartByDeck,
    generationSettingsByCourse,
    customDecks,
  };
}

export function normalizeDashboardState(value) {
  if (!isRecord(value) || ![1, 2, SCHEMA_VERSION].includes(value.schemaVersion)) {
    throw new Error("This backup is not a supported Semester Board backup.");
  }
  const semester = value.semester ? normalizeSemesterState(value.semester) : DEFAULT_SEMESTER_STATE;
  const assignmentWorkflow = normalizeAssignmentWorkflow(value.assignmentWorkflow);
  const completedAssignments = isRecord(value.completedAssignments) ? { ...value.completedAssignments } : {};
  Object.entries(assignmentWorkflow.byAssignment).forEach(([assignmentId, entry]) => {
    if (entry.workStatus === "completed") completedAssignments[assignmentId] = true;
    if (entry.workStatus === "not-started" || entry.workStatus === "in-progress") {
      completedAssignments[assignmentId] = false;
    }
  });
  return {
    ...DEFAULT_DASHBOARD_STATE,
    ...value,
    schemaVersion: SCHEMA_VERSION,
    semester,
    checkins: isRecord(value.checkins) ? value.checkins : {},
    completedAssignments,
    assignmentWorkflow,
    assignmentOverrides: isRecord(value.assignmentOverrides) ? value.assignmentOverrides : {},
    academicCoach: normalizeAcademicCoach(value.academicCoach),
    courseConfig: normalizeCourseConfig(value.courseConfig, semester),
    studyDeck: normalizeStudyDeckState(value.studyDeck),
  };
}

export function useDashboardState(profileId) {
  const [state, setState] = useSyncedResource({
    fallback: DEFAULT_DASHBOARD_STATE,
    normalize: normalizeDashboardState,
    profileId,
    resource: PROFILE_RESOURCES.dashboard,
  });

  const mutate = useCallback((recipe) => {
    setState((current) => ({ ...recipe(current), updatedAt: new Date().toISOString() }));
  }, []);

  const saveCheckin = useCallback((meetingId, entry) => {
    mutate((current) => ({
      ...current,
      checkins: { ...current.checkins, [meetingId]: { ...entry, meetingId } },
    }));
  }, [mutate]);

  const toggleAssignment = useCallback((assignmentId) => {
    mutate((current) => {
      const completed = !current.completedAssignments[assignmentId];
      const currentEntry = current.assignmentWorkflow?.byAssignment?.[assignmentId] || {};
      return {
        ...current,
        completedAssignments: {
          ...current.completedAssignments,
          [assignmentId]: completed,
        },
        assignmentWorkflow: {
          byAssignment: {
            ...current.assignmentWorkflow?.byAssignment,
            [assignmentId]: {
              ...currentEntry,
              workStatus: completed ? "completed" : "not-started",
              updatedAt: new Date().toISOString(),
            },
          },
        },
      };
    });
  }, [mutate]);

  const saveAssignmentWorkflow = useCallback((assignmentId, update) => {
    const normalizedId = normalizeIdentifier(assignmentId);
    if (!normalizedId || !isRecord(update)) return;
    mutate((current) => {
      const currentEntry = current.assignmentWorkflow?.byAssignment?.[normalizedId] || {};
      const workStatus = WORK_STATUSES.has(update.workStatus) ? update.workStatus : currentEntry.workStatus;
      const submissionStatus = SUBMISSION_STATUSES.has(update.submissionStatus)
        ? update.submissionStatus
        : currentEntry.submissionStatus;
      const nextEntry = {
        ...(workStatus ? { workStatus } : {}),
        ...(submissionStatus ? { submissionStatus } : {}),
        updatedAt: new Date().toISOString(),
      };
      return {
        ...current,
        completedAssignments: workStatus ? {
          ...current.completedAssignments,
          [normalizedId]: workStatus === "completed",
        } : current.completedAssignments,
        assignmentWorkflow: normalizeAssignmentWorkflow({
          byAssignment: {
            ...current.assignmentWorkflow?.byAssignment,
            [normalizedId]: nextEntry,
          },
        }),
      };
    });
  }, [mutate]);

  const saveAssignmentOverride = useCallback((assignmentId, override) => {
    mutate((current) => ({
      ...current,
      assignmentOverrides: { ...current.assignmentOverrides, [assignmentId]: override },
    }));
  }, [mutate]);

  const saveAcademicCoachCheck = useCallback((checkId, completed) => {
    const normalizedId = String(checkId || "").trim();
    if (!COACH_CHECK_ID_PATTERN.test(normalizedId)) return;
    mutate((current) => {
      const completedChecks = { ...current.academicCoach?.completedChecks };
      if (completed) completedChecks[normalizedId] = new Date().toISOString();
      else delete completedChecks[normalizedId];
      return {
        ...current,
        academicCoach: normalizeAcademicCoach({
          ...current.academicCoach,
          completedChecks,
        }),
      };
    });
  }, [mutate]);

  const saveAcademicCoachChapter = useCallback((courseId, chapter) => {
    const normalizedCourseId = normalizeIdentifier(courseId);
    if (!normalizedCourseId) return;
    mutate((current) => ({
      ...current,
      academicCoach: normalizeAcademicCoach({
        ...current.academicCoach,
        chapterByCourse: {
          ...current.academicCoach?.chapterByCourse,
          [normalizedCourseId]: chapter,
        },
      }),
    }));
  }, [mutate]);

  const saveCourseConfig = useCallback((courseConfig) => {
    mutate((current) => ({ ...current, courseConfig: { ...current.courseConfig, ...courseConfig } }));
  }, [mutate]);

  const saveStudyDeck = useCallback((update) => {
    mutate((current) => {
      const next = typeof update === "function" ? update(current.studyDeck) : {
        ...current.studyDeck,
        ...update,
      };
      return { ...current, studyDeck: normalizeStudyDeckState(next) };
    });
  }, [mutate]);

  const saveSemester = useCallback((semester) => {
    const normalizedSemester = normalizeSemesterState(semester);
    setState((current) => ({
      ...current,
      schemaVersion: SCHEMA_VERSION,
      semester: normalizedSemester,
      courseConfig: normalizeCourseConfig(current.courseConfig, normalizedSemester),
      updatedAt: new Date().toISOString(),
    }));
  }, [setState]);

  const importBackup = useCallback(async (file) => {
    const parsed = JSON.parse(await file.text());
    const privateSemester = privateSemesterFromImport(parsed);
    if (privateSemester) {
      setState((current) => ({
        ...current,
        schemaVersion: SCHEMA_VERSION,
        semester: privateSemester,
        courseConfig: normalizeCourseConfig(current.courseConfig, privateSemester),
        updatedAt: new Date().toISOString(),
      }));
      return;
    }
    setState(normalizeDashboardState(parsed));
  }, [setState]);

  const exportBackup = useCallback(() => {
    const payload = { ...state, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `semester-board-private-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [state]);

  const resetProgress = useCallback(() => {
    setState((current) => ({
      ...DEFAULT_DASHBOARD_STATE,
      semester: current?.semester || DEFAULT_SEMESTER_STATE,
      studyDeck: normalizeStudyDeckState(current?.studyDeck),
    }));
  }, [setState]);

  return {
    state,
    saveCheckin,
    toggleAssignment,
    saveAssignmentWorkflow,
    saveAssignmentOverride,
    saveAcademicCoachCheck,
    saveAcademicCoachChapter,
    saveCourseConfig,
    saveStudyDeck,
    saveSemester,
    importBackup,
    exportBackup,
    resetProgress,
  };
}
