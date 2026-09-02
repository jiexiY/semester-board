import assert from "node:assert/strict";
import test from "node:test";

import { buildLocalStudyDeck, MAX_LOCAL_STUDY_CARDS } from "../src/lib/localStudyDeckGenerator.js";
import { gradePracticeResponse, validateStudyDeck } from "../src/lib/studyDeck.js";

const SOURCES = [{
  id: "source-lecture-1",
  fileName: "Lecture notes.txt",
  text: `[Page 1]
Social facts are patterns of acting, thinking, and feeling that exist outside individual consciousness. They exercise coercive power by shaping behavior through established social expectations. Sociological analysis studies these patterns as observable features of collective life.

[Page 2]
The course distinguishes empirical description from unsupported personal assumption when evaluating social evidence.`,
}];

test("private local generation turns uploaded source text into valid practice cards", () => {
  const deck = buildLocalStudyDeck({
    course: { code: "SYA 4110", name: "Development of Sociological Thought" },
    mode: "practice",
    sources: SOURCES,
  });

  assert.equal(deck.generationOrigin, "local-extractive");
  assert.ok(deck.cards.length >= 1);
  assert.ok(deck.cards.length <= MAX_LOCAL_STUDY_CARDS);
  assert.deepEqual(validateStudyDeck(deck.cards), []);
  assert.ok(deck.cards.every((card) => card.sourceRefs[0] === SOURCES[0].id));
  assert.ok(deck.cards.every((card) => /Lecture notes\.txt, page [12]/u.test(card.sourceCitation)));
  const first = deck.cards[0];
  assert.equal(gradePracticeResponse(first, "flashcards", first.abcd.correctIndex), true);
  assert.equal(gradePracticeResponse(first, "fill", first.fill.acceptedAnswers[0]), true);
  assert.equal(gradePracticeResponse(first, "true-false", true), true);
  assert.equal(gradePracticeResponse(first, "multiple-answer", first.multipleAnswer.correctIndices), true);
});

test("private local generation is deterministic and keeps exact source statements", () => {
  const input = { course: { code: "AST 2031" }, mode: "quiz", sources: SOURCES };
  const first = buildLocalStudyDeck(input);
  const repeated = buildLocalStudyDeck(input);

  assert.deepEqual(repeated, first);
  assert.ok(first.cards.every((card) => SOURCES[0].text.includes(card.canonicalAnswer)));
  assert.ok(first.cards.every((card) => card.fill.prompt.includes("_____")));
});

test("private local generation explains when uploaded files contain no usable prose", () => {
  assert.throws(() => buildLocalStudyDeck({
    course: { code: "ENC 3464" },
    sources: [{ id: "source-empty", fileName: "outline.txt", text: "A B C" }],
  }), /No readable source statements/iu);
});
