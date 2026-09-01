import { CloudAssistantRequestError } from "./cloudAssistantSecurity.js";
import { validateStudyDeck } from "../src/lib/studyDeck.js";

export const MAX_STUDY_GENERATION_JSON_BYTES = 96 * 1024;
export const MAX_STUDY_GENERATION_SOURCES = 8;
export const MAX_STUDY_GENERATION_SOURCE_CHARS = 16_000;
export const MAX_STUDY_GENERATION_TOTAL_CHARS = 64_000;
export const MAX_GENERATED_CARDS = 8;

const BLOCKED_IDS = new Set(["__proto__", "constructor", "prototype"]);
const isPlainObject = (value) => value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function hasOnlyKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeText(value, limit) {
  const text = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (!text || text.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new CloudAssistantRequestError(400, "invalid_study_generation_text");
  }
  return text;
}

function safeId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(id) || BLOCKED_IDS.has(id)) {
    throw new CloudAssistantRequestError(400, "invalid_study_generation_id");
  }
  return id;
}

export function validateStudyGenerationPayload(payload) {
  if (!isPlainObject(payload) || !hasOnlyKeys(payload, ["course", "mode", "sources"])) {
    throw new CloudAssistantRequestError(400, "invalid_study_generation_payload");
  }
  if (!isPlainObject(payload.course) || !hasOnlyKeys(payload.course, ["code", "name"])) {
    throw new CloudAssistantRequestError(400, "invalid_study_generation_course");
  }
  const mode = payload.mode === "quiz" ? "quiz" : payload.mode === "practice" ? "practice" : null;
  if (!mode || !Array.isArray(payload.sources) || !payload.sources.length || payload.sources.length > MAX_STUDY_GENERATION_SOURCES) {
    throw new CloudAssistantRequestError(400, "invalid_study_generation_sources");
  }
  let totalChars = 0;
  const seen = new Set();
  const sources = payload.sources.map((source) => {
    if (!isPlainObject(source) || !hasOnlyKeys(source, ["fileName", "id", "text"])) {
      throw new CloudAssistantRequestError(400, "invalid_study_generation_source");
    }
    const id = safeId(source.id);
    if (seen.has(id)) throw new CloudAssistantRequestError(400, "duplicate_study_generation_source");
    seen.add(id);
    const text = safeText(source.text, MAX_STUDY_GENERATION_SOURCE_CHARS);
    totalChars += text.length;
    if (totalChars > MAX_STUDY_GENERATION_TOTAL_CHARS) {
      throw new CloudAssistantRequestError(413, "study_generation_too_large");
    }
    return {
      fileName: safeText(source.fileName, 160),
      id,
      text,
    };
  });
  return {
    course: {
      code: safeText(payload.course.code, 40),
      name: safeText(payload.course.name, 120),
    },
    mode,
    sources,
  };
}

function outputText(value, fallback, limit) {
  const normalized = String(value || fallback || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
  return normalized || fallback;
}

function outputStrings(value, limit, itemLimit = 180) {
  return (Array.isArray(value) ? value : [])
    .map((item) => outputText(item, "", itemLimit))
    .filter(Boolean)
    .slice(0, limit);
}

function outputId(value, index) {
  const candidate = outputText(value, `generated-card-${index + 1}`, 128)
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return candidate && !BLOCKED_IDS.has(candidate) ? candidate : `generated-card-${index + 1}`;
}

function projectCard(card, index, allowedSourceIds) {
  const sourceRefs = outputStrings(card?.sourceRefs, 8, 128)
    .filter((sourceId) => allowedSourceIds.has(sourceId));
  return {
    id: outputId(card?.id, index),
    level: Number(card?.level),
    topic: outputText(card?.topic, "Source topic", 160),
    objective: outputText(card?.objective, "Recall one source-supported idea.", 280),
    coreQuestion: outputText(card?.coreQuestion, "What does the source state?", 420),
    canonicalAnswer: outputText(card?.canonicalAnswer, "Answer not generated.", 600),
    explanation: outputText(card?.explanation, "Explanation not generated.", 900),
    misconception: outputText(card?.misconception, "A plausible unsupported alternative.", 420),
    sourceCitation: outputText(card?.sourceCitation, "Source location not stated", 320),
    sourceRefs,
    visualization: null,
    abcd: {
      choices: outputStrings(card?.abcd?.choices, 4, 260),
      correctIndex: Number(card?.abcd?.correctIndex),
    },
    fill: {
      prompt: outputText(card?.fill?.prompt, "Complete the supported statement: ____.", 420),
      acceptedAnswers: outputStrings(card?.fill?.acceptedAnswers, 8, 220),
    },
    trueFalse: {
      statement: outputText(card?.trueFalse?.statement, "The source supports this statement.", 420),
      correct: card?.trueFalse?.correct === true,
      correction: outputText(card?.trueFalse?.correction, "No correction supplied.", 420),
    },
    multipleAnswer: {
      prompt: outputText(card?.multipleAnswer?.prompt, "Select every source-supported answer.", 420),
      choices: outputStrings(card?.multipleAnswer?.choices, 6, 260),
      correctIndices: [...new Set((Array.isArray(card?.multipleAnswer?.correctIndices)
        ? card.multipleAnswer.correctIndices
        : []).map(Number).filter(Number.isInteger))].slice(0, 6),
    },
    acceptedAnswerVariants: outputStrings(card?.acceptedAnswerVariants, 8, 220),
    hint: outputText(card?.hint, "Return to the cited source location.", 280),
    difficulty: outputText(card?.difficulty, "recall", 40),
    prerequisites: outputStrings(card?.prerequisites, 8, 160),
  };
}

export function normalizeGeneratedStudyDeck(output, sourceIds) {
  if (!isPlainObject(output) || !Array.isArray(output.cards)
    || !output.cards.length || output.cards.length > MAX_GENERATED_CARDS) {
    throw new CloudAssistantRequestError(502, "invalid_generated_study_deck");
  }
  const allowedSourceIds = new Set(sourceIds);
  const cards = output.cards.map((card, index) => projectCard(card, index, allowedSourceIds));
  if (cards.some((card) => !card.sourceRefs.length)) {
    throw new CloudAssistantRequestError(502, "ungrounded_generated_card");
  }
  const errors = validateStudyDeck(cards);
  if (errors.length) throw new CloudAssistantRequestError(502, "invalid_generated_cards");
  return {
    title: outputText(output.title, "Generated study deck", 96),
    cards,
  };
}
