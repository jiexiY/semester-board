import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildGuideBalancedQuiz,
  buildQuiz,
  canonicalStudySpaceId,
  filterStudyCards,
  genericCourseDeckId,
  resolveStudySourceRefs,
  studyCardFacets,
  validateAuditedStudyDeck,
  validateStudyDeck,
} from "../src/lib/studyDeck.js";
import { normalizeStudyDeckState } from "../src/hooks/useDashboardState.js";

const studyDeckPageSource = await readFile(
  new URL("../src/components/StudyDeckPage.jsx", import.meta.url),
  "utf8",
);

function makeCard(id, { guideId = "guide-1", topicId = "topic-1", level = 1 } = {}) {
  return {
    id,
    courseId: "course-alpha",
    courseCode: "MAT 1100",
    guideId,
    topicId,
    level,
    topic: `Course topic ${topicId}`,
    objective: `Retrieve ${id}`,
    coreQuestion: `What is ${id}?`,
    canonicalAnswer: `Answer ${id}`,
    explanation: `Explanation ${id}`,
    misconception: `Misconception ${id}`,
    sourceCitation: `Source ${id}, p. 1`,
    sourceRefs: [`source-${guideId}`],
    visualization: null,
    abcd: { choices: ["A", "B", "C", "D"], correctIndex: 0 },
    fill: { prompt: "Complete ____.", acceptedAnswers: ["A"] },
    trueFalse: { statement: "A is supported.", correct: true, correction: "" },
    multipleAnswer: { prompt: "Select all.", choices: ["A", "B", "C", "D"], correctIndices: [0, 1] },
    acceptedAnswerVariants: ["A"],
    hint: "Recall the source.",
    difficulty: "recognition",
    prerequisites: [],
  };
}

test("guide and topic filters compose without mutating the source cards", () => {
  const cards = [
    makeCard("g1-a", { guideId: "guide-1", topicId: "topic-a" }),
    makeCard("g1-b", { guideId: "guide-1", topicId: "topic-b" }),
    makeCard("g2-a", { guideId: "guide-2", topicId: "topic-a", level: 2 }),
  ];
  const original = structuredClone(cards);

  assert.deepEqual(filterStudyCards(cards, { guideId: "guide-1" }).map((card) => card.id), ["g1-a", "g1-b"]);
  assert.deepEqual(filterStudyCards(cards, { topicId: "topic-a" }).map((card) => card.id), ["g1-a", "g2-a"]);
  assert.deepEqual(filterStudyCards(cards, { guideId: "guide-2", topicId: "topic-a", level: 2 }).map((card) => card.id), ["g2-a"]);
  assert.deepEqual(filterStudyCards(cards, { query: "explanation g1-b" }).map((card) => card.id), ["g1-b"]);
  assert.deepEqual(cards, original);
  assert.deepEqual(studyCardFacets(cards), {
    courses: [{ id: "course-alpha", count: 3 }],
    guides: [{ id: "guide-1", count: 2 }, { id: "guide-2", count: 1 }],
    topics: [{ id: "topic-a", count: 2 }, { id: "topic-b", count: 1 }],
  });
});

test("source manifest resolution reports exact missing, unaudited, and duplicate references", () => {
  const manifest = [
    { id: "source-guide-1", courseId: "course-alpha", auditStatus: "audited", label: "Guide 1" },
    { id: "source-guide-2", courseId: "course-alpha", auditStatus: "partial", label: "Guide 2" },
    { id: "source-guide-2", courseId: "course-alpha", auditStatus: "audited", label: "Duplicate" },
  ];
  const result = resolveStudySourceRefs(["source-guide-1", "source-guide-2", "missing"], manifest);

  assert.equal(result.ok, false);
  assert.deepEqual(result.resolved.map((entry) => entry.id), ["source-guide-1", "source-guide-2"]);
  assert.deepEqual(result.missing, ["missing"]);
  assert.deepEqual(result.unaudited, ["source-guide-2"]);
  assert.deepEqual(result.duplicateIds, ["source-guide-2"]);
});

test("audited validation is strict while generic import validation stays backward-compatible", () => {
  const card = makeCard("audited-card");
  const genericCard = { ...card };
  delete genericCard.courseId;
  delete genericCard.guideId;
  delete genericCard.topicId;
  delete genericCard.sourceRefs;
  assert.deepEqual(validateStudyDeck([genericCard]), []);

  const manifest = [{
    id: "source-guide-1",
    courseId: "course-alpha",
    auditStatus: "audited",
    label: "Guide 1",
  }];
  assert.deepEqual(validateAuditedStudyDeck([card], manifest), []);

  const errors = validateAuditedStudyDeck([
    { ...card, courseId: "course-beta", sourceRefs: ["source-guide-1", "missing"] },
  ], manifest);
  assert.ok(errors.some((error) => /unresolved source refs: missing/.test(error)));
  assert.ok(errors.some((error) => /sources from another course: source-guide-1/.test(error)));
});

test("guide-balanced quiz selection is seeded, deterministic, unique, and round-robin balanced", () => {
  const cards = [
    ...Array.from({ length: 5 }, (_, index) => makeCard(`g1-${index + 1}`, { guideId: "guide-1" })),
    ...Array.from({ length: 5 }, (_, index) => makeCard(`g2-${index + 1}`, { guideId: "guide-2" })),
    ...Array.from({ length: 5 }, (_, index) => makeCard(`g3-${index + 1}`, { guideId: "guide-3" })),
  ];
  const first = buildGuideBalancedQuiz(cards, 8, { seed: "exam-one" });
  const repeated = buildGuideBalancedQuiz(cards, 8, { seed: "exam-one" });
  const throughBuildQuiz = buildQuiz(cards, 1, 8, { seed: "exam-one" });

  assert.deepEqual(first.map((card) => card.id), repeated.map((card) => card.id));
  assert.deepEqual(first.map((card) => card.id), throughBuildQuiz.map((card) => card.id));
  assert.equal(first.length, 8);
  assert.equal(new Set(first.map((card) => card.id)).size, first.length);
  const counts = Object.values(Object.groupBy(first, (card) => card.guideId)).map((group) => group.length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
  assert.notDeepEqual(
    first.map((card) => card.id),
    buildGuideBalancedQuiz(cards, 8, { seed: "final-exam" }).map((card) => card.id),
  );
});

test("Study Deck default persistence depends only on primitive render state", () => {
  const start = studyDeckPageSource.indexOf("const selectedCourseIsValid");
  const end = studyDeckPageSource.indexOf("const addCourse", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const initializer = studyDeckPageSource.slice(start, end);
  const dependencies = initializer.match(/\}, \[([^\]]+)\]\);/)?.[1] || "";

  assert.match(dependencies, /activeCourseId/);
  assert.match(dependencies, /activeDeckId/);
  assert.match(dependencies, /selectedCourseIsValid/);
  assert.match(dependencies, /selectedDeckIsValid/);
  assert.doesNotMatch(dependencies, /\bactiveCourse\b/);
  assert.doesNotMatch(dependencies, /\bactiveDeck\b/);
  assert.doesNotMatch(dependencies, /\bactiveLevels\b/);
  assert.doesNotMatch(dependencies, /\bdecks\b/);
  assert.doesNotMatch(dependencies, /savedState\./);
  assert.match(studyDeckPageSource, /const id = canonicalStudySpaceId\(course\.id \|\| savedId\)/);
  assert.match(studyDeckPageSource, /id: genericCourseDeckId\(course\.id\)/);
  assert.match(studyDeckPageSource, /const courseSpaceId = canonicalStudySpaceId\(deck\.courseSpaceId\)/);
});

test("uploaded sources can generate private practice without chat AI consent", () => {
  assert.doesNotMatch(studyDeckPageSource, /generationAccessStatus\s*!==\s*["']ready["']/u);
  assert.match(studyDeckPageSource, /No source text will leave this browser/u);
  assert.match(studyDeckPageSource, /generationOrigin:\s*generated\.generationOrigin/u);
});

test("practice and quiz generation actions stay in the top Study Deck header", () => {
  const headerStart = studyDeckPageSource.indexOf('<header className="study-deck-hero">');
  const headerEnd = studyDeckPageSource.indexOf("</header>", headerStart);
  const practiceAction = studyDeckPageSource.indexOf('generateFromSources("practice")');
  const quizAction = studyDeckPageSource.indexOf('generateFromSources("quiz")');
  assert.ok(headerStart >= 0 && headerEnd > headerStart);
  assert.ok(practiceAction > headerStart && practiceAction < headerEnd);
  assert.ok(quizAction > headerStart && quizAction < headerEnd);
  assert.equal(studyDeckPageSource.match(/generateFromSources\("practice"\)/gu)?.length, 1);
  assert.equal(studyDeckPageSource.match(/generateFromSources\("quiz"\)/gu)?.length, 1);
});

test("long and opaque course-space IDs converge without truncating selections", () => {
  const identifiers = [
    "c".repeat(100),
    `course  ${"a".repeat(24)}  space`,
    "x".repeat(128),
  ];

  for (const rawIdentifier of identifiers) {
    const courseId = canonicalStudySpaceId(rawIdentifier);
    const deckId = genericCourseDeckId(rawIdentifier);
    assert.equal(courseId, rawIdentifier);
    assert.ok(deckId);
    assert.ok(deckId.length <= 128);

    const first = normalizeStudyDeckState({
      selectedCourseSpaceId: courseId,
      courseSpaces: [{ id: courseId, name: "Canonical ID course" }],
      selectedDeckByCourse: { [courseId]: deckId },
      challengeByDeck: { [deckId]: 1 },
      methodByDeck: { [deckId]: "flashcards" },
      reviewStartByDeck: { [deckId]: "2026-08-30T22:00" },
    });
    assert.equal(first.selectedCourseSpaceId, courseId);
    assert.equal(first.selectedDeckByCourse[courseId], deckId);
    assert.equal(first.challengeByDeck[deckId], 1);
    assert.equal(first.methodByDeck[deckId], "flashcards");
    assert.equal(first.reviewStartByDeck[deckId], "2026-08-30T22:00");
    assert.deepEqual(normalizeStudyDeckState(first), first);
  }
});
