import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_STUDY_DECK_STATE,
  MAX_COURSE_SPACES,
  MAX_CUSTOM_DECK_BYTES,
  MAX_CUSTOM_DECKS,
  MAX_CUSTOM_DECK_TOTAL_BYTES,
  normalizeAssignmentWorkflow,
  normalizeDashboardState,
  normalizeStudyDeckState,
} from "../src/hooks/useDashboardState.js";

test("dashboard backups include an isolated study-deck state", () => {
  const state = normalizeDashboardState({ schemaVersion: 1 });

  assert.deepEqual(state.studyDeck, DEFAULT_STUDY_DECK_STATE);
  assert.deepEqual(state.checkins, {});
  assert.deepEqual(state.studyDeck.courseSpaces, []);
  assert.equal(state.studyDeck.selectedCourseSpaceId, null);
  assert.deepEqual(state.assignmentWorkflow, { byAssignment: {} });
});

test("assignment workflow keeps completion separate from Canvas submission", () => {
  const state = normalizeDashboardState({
    schemaVersion: 1,
    completedAssignments: { legacy: true, reopened: true },
    assignmentWorkflow: {
      byAssignment: {
        finished: { workStatus: "completed", submissionStatus: "not-submitted", updatedAt: "2026-09-01T12:00:00Z" },
        reopened: { workStatus: "in-progress", submissionStatus: "submitted" },
        missed: { workStatus: "completed", submissionStatus: "missed" },
        invalid: { workStatus: "done", submissionStatus: "probably" },
      },
    },
  });

  assert.equal(state.completedAssignments.legacy, true);
  assert.equal(state.completedAssignments.finished, true);
  assert.equal(state.completedAssignments.reopened, false);
  assert.equal(state.assignmentWorkflow.byAssignment.finished.workStatus, "completed");
  assert.equal(state.assignmentWorkflow.byAssignment.finished.submissionStatus, "not-submitted");
  assert.equal(state.assignmentWorkflow.byAssignment.reopened.submissionStatus, "submitted");
  assert.equal(state.assignmentWorkflow.byAssignment.missed.submissionStatus, "missed");
  assert.equal(state.completedAssignments.missed, true);
  assert.equal(state.assignmentWorkflow.byAssignment.invalid, undefined);
});

test("assignment workflow rejects unsafe identifiers and unsupported statuses", () => {
  const normalized = normalizeAssignmentWorkflow({
    byAssignment: {
      valid: { workStatus: "not-started", submissionStatus: "not-marked" },
      constructor: { workStatus: "completed" },
      malformed: { workStatus: "finished", submissionStatus: "sent" },
    },
  });

  assert.deepEqual(normalized, {
    byAssignment: { valid: { workStatus: "not-started", submissionStatus: "not-marked" } },
  });
});

test("study-deck state preserves supported progress for cloud and local profiles", () => {
  const state = normalizeStudyDeckState({
    selectedDeckId: "course-alpha-source-grounded",
    challengeByDeck: { "course-alpha-source-grounded": 7, invalid: 12 },
    methodByDeck: { "course-alpha-source-grounded": "multiple-answer", invalid: "essay" },
    errorBookByDeck: {
      "course-alpha-source-grounded": [{
        key: "sya:test",
        cardId: "sya-test",
        practiceMethod: "multiple-answer",
        needsReview: true,
        history: [{ correct: false }, null],
      }],
    },
    reviewStartByDeck: {
      "course-alpha-source-grounded": "2026-08-30T20:00",
      invalid: "not-a-date",
    },
  });

  assert.equal(state.selectedDeckId, "course-alpha-source-grounded");
  assert.deepEqual(state.challengeByDeck, { "course-alpha-source-grounded": 7 });
  assert.deepEqual(state.methodByDeck, { "course-alpha-source-grounded": "multiple-answer" });
  assert.deepEqual(state.errorBookByDeck["course-alpha-source-grounded"][0].history, [{ correct: false }]);
  assert.deepEqual(state.reviewStartByDeck, { "course-alpha-source-grounded": "2026-08-30T20:00" });
});

test("study-deck normalization rejects oversized or malformed custom decks", () => {
  const tooManyCards = Array.from({ length: 201 }, (_, index) => ({ id: `card-${index}` }));
  const state = normalizeStudyDeckState({
    courseSpaces: [{ id: "course-1", name: "Sociology", createdAt: "2026-08-30T12:00:00Z" }],
    customDecks: {
      valid: { title: "Imported", courseSpaceId: "course-1", cards: [{ id: "card-1" }] },
      empty: { title: "Empty", courseSpaceId: "course-1", cards: [] },
      oversized: { title: "Too large", courseSpaceId: "course-1", cards: tooManyCards },
      orphaned: { title: "Legacy orphan", courseSpaceId: "missing-course", cards: [{ id: "card-2" }] },
    },
  });

  assert.deepEqual(Object.keys(state.customDecks), ["valid"]);
});

test("study-deck normalization keeps custom deck data below the cloud payload budget", () => {
  const oversizedPayload = "x".repeat(MAX_CUSTOM_DECK_BYTES);
  const state = normalizeStudyDeckState({
    courseSpaces: [{ id: "course-1", name: "Sociology" }],
    customDecks: {
      valid: { title: "Imported", courseSpaceId: "course-1", cards: [{ id: "card-1", answer: "small" }] },
      oversized: { title: "Too many bytes", courseSpaceId: "course-1", cards: [{ id: "card-2", answer: oversizedPayload }] },
    },
  });

  assert.deepEqual(Object.keys(state.customDecks), ["valid"]);
});

test("study-deck normalization caps the combined size of otherwise valid custom decks", () => {
  const perDeckBytes = Math.floor(MAX_CUSTOM_DECK_TOTAL_BYTES * 0.56);
  const state = normalizeStudyDeckState({
    courseSpaces: [{ id: "course-1", name: "Sociology" }],
    customDecks: {
      first: { title: "First", courseSpaceId: "course-1", cards: [{ id: "card-1", answer: "a".repeat(perDeckBytes) }] },
      second: { title: "Second", courseSpaceId: "course-1", cards: [{ id: "card-2", answer: "b".repeat(perDeckBytes) }] },
    },
  });

  assert.deepEqual(Object.keys(state.customDecks), ["first"]);
});

test("course spaces isolate deck selection and preserve archived course data", () => {
  const state = normalizeStudyDeckState({
    selectedCourseSpaceId: " archived-course ",
    courseSpaces: [
      { id: "course-a", name: "  Sociology   Theory ", code: " MAT 1100 ", createdAt: "2026-08-30T12:00:00Z" },
      { id: "archived-course", name: "Old course", archived: true, createdAt: "2025-01-01" },
    ],
    customDecks: {
      "deck-a": { courseSpaceId: "course-a", cards: [{ id: "a" }] },
      "deck-old": { courseSpaceId: "archived-course", cards: [{ id: "old" }] },
    },
    selectedDeckByCourse: {
      "course-a": "deck-a",
      "archived-course": "deck-old",
      "missing-course": "deck-a",
    },
    sourceRevisionByCourse: { "course-a": 4.9, "archived-course": 2, "missing-course": 99 },
    deckSourceRevisionByDeck: { "deck-a": 3.8, "deck-old": 2 },
  });

  assert.equal(state.selectedCourseSpaceId, null, "an archived course cannot remain the active workspace");
  assert.equal(state.courseSpaces[0].name, "Sociology Theory");
  assert.equal(state.courseSpaces[0].code, "MAT 1100");
  assert.equal(state.courseSpaces[1].archived, true);
  assert.deepEqual(state.selectedDeckByCourse, { "course-a": "deck-a", "archived-course": "deck-old" });
  assert.deepEqual(state.sourceRevisionByCourse, { "course-a": 4, "archived-course": 2 });
  assert.deepEqual(state.deckSourceRevisionByDeck, { "deck-a": 3, "deck-old": 2 });
  assert.deepEqual(Object.keys(state.customDecks), ["deck-a", "deck-old"]);
});

test("course-space normalization caps entries and rejects cross-course or orphan deck references", () => {
  const courseSpaces = Array.from({ length: MAX_COURSE_SPACES + 4 }, (_, index) => ({
    id: `course-${index}`,
    name: `Course ${index}`,
  }));
  const customDecks = Object.fromEntries(Array.from({ length: MAX_CUSTOM_DECKS + 3 }, (_, index) => [
    `deck-${index}`,
    { courseSpaceId: index < MAX_COURSE_SPACES ? `course-${index}` : "missing", cards: [{ id: `card-${index}` }] },
  ]));
  customDecks.orphan = { cards: [{ id: "legacy" }] };
  const state = normalizeStudyDeckState({
    courseSpaces,
    customDecks,
    selectedDeckByCourse: {
      "course-0": "deck-0",
      "course-1": "deck-0",
      "course-12": "deck-12",
    },
    challengeByDeck: { orphan: 5, "deck-0": 6 },
  });

  assert.equal(state.courseSpaces.length, MAX_COURSE_SPACES);
  assert.ok(Object.keys(state.customDecks).length <= MAX_CUSTOM_DECKS);
  assert.equal(state.customDecks.orphan, undefined);
  assert.deepEqual(state.selectedDeckByCourse, { "course-0": "deck-0" });
  assert.deepEqual(state.challengeByDeck, { "deck-0": 6 });
});

test("Error Book data is schema-limited and cannot crowd a private deck out of sync", () => {
  const huge = "x".repeat(20_000);
  const entries = Array.from({ length: 200 }, (_, index) => ({
    key: `card-${index}:fill`,
    cardId: `card-${index}`,
    practiceMethod: "fill",
    question: huge,
    response: huge,
    correctAnswer: huge,
    explanation: huge,
    source: huge,
    reason: huge,
    needsReview: index % 2 === 0,
    injected: huge,
    history: Array.from({ length: 100 }, () => ({ response: huge, correct: false, occurredAt: "2026-08-30T12:00:00Z", injected: huge })),
  }));
  const state = normalizeStudyDeckState({ errorBookByDeck: { deck: entries } });
  const book = state.errorBookByDeck.deck;

  assert.ok(book.length <= 50);
  assert.ok(book[0].question.length <= 600);
  assert.ok(book[0].history.length <= 12);
  assert.equal("injected" in book[0], false);
  assert.equal("injected" in book[0].history[0], false);
  assert.ok(Buffer.byteLength(JSON.stringify(state.errorBookByDeck)) < 70 * 1024);
});

test("a private 672,860-byte deck still fits while the complete dashboard stays below Supabase's limit", () => {
  const privateDeckPayload = "s".repeat(672_000);
  const maliciousRetries = Array.from({ length: 200 }, (_, index) => ({
    key: `private-card-${index}:fill`,
    cardId: `private-card-${index}`,
    practiceMethod: "fill",
    question: "q".repeat(20_000),
    explanation: "e".repeat(20_000),
    history: Array.from({ length: 100 }, () => ({ response: "r".repeat(10_000), correct: false })),
  }));
  const state = normalizeDashboardState({
    schemaVersion: 1,
    studyDeck: {
      selectedCourseSpaceId: "sya-course",
      courseSpaces: [{ id: "sya-course", name: "MAT 1100", code: "MAT 1100", createdAt: "2026-08-30T12:00:00Z" }],
      customDecks: {
        "private-sya-deck": {
          courseSpaceId: "sya-course",
          title: "Private deck",
          cards: [{ id: "card-1", canonicalAnswer: privateDeckPayload }],
        },
      },
      errorBookByDeck: { "private-sya-deck": maliciousRetries },
    },
  });

  assert.ok(state.studyDeck.customDecks["private-sya-deck"]);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 1_000_000);
});
