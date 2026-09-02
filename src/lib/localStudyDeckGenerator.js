import { validateStudyDeck } from "./studyDeck.js";

export const MAX_LOCAL_STUDY_CARDS = 8;

const STOP_WORDS = new Set([
  "about", "after", "again", "also", "because", "before", "being", "between",
  "could", "does", "during", "each", "from", "have", "into", "more", "most",
  "other", "over", "same", "such", "than", "that", "their", "there", "these",
  "they", "this", "those", "through", "under", "very", "what", "when", "where",
  "which", "while", "with", "would", "your",
]);

function compactText(value, limit = 500) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function safeLeafName(value, fallback = "Course source") {
  const leaf = String(value || "").split(/[\\/]/u).at(-1);
  return compactText(leaf, 160) || fallback;
}

function normalizedKey(value) {
  return compactText(value, 260).toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function stableHash(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function sentenceChunks(value) {
  const text = compactText(value, 16_000);
  if (!text) return [];
  const sentences = text.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“'])/gu);
  return sentences.flatMap((sentence) => {
    const cleaned = compactText(sentence, 900);
    if (cleaned.length <= 460) return [cleaned];
    const words = cleaned.split(" ");
    const chunks = [];
    for (let offset = 0; offset < words.length; offset += 44) {
      chunks.push(words.slice(offset, offset + 44).join(" "));
    }
    return chunks;
  });
}

function sourceSections(source) {
  const text = String(source?.text || "");
  const parts = text.split(/(\[Page\s+\d+\])/giu);
  let location = "source excerpt";
  const sections = [];
  for (const part of parts) {
    const marker = part.match(/^\[Page\s+(\d+)\]$/iu);
    if (marker) {
      location = `page ${marker[1]}`;
      continue;
    }
    for (const statement of sentenceChunks(part)) sections.push({ location, statement });
  }
  return sections;
}

function wordTokens(statement) {
  return [...String(statement || "").matchAll(/[\p{L}\p{N}][\p{L}\p{N}’'-]*/gu)].map((match) => ({
    end: match.index + match[0].length,
    start: match.index,
    text: match[0],
  }));
}

function contentTokens(statement) {
  return wordTokens(statement).filter(({ text }) => {
    const key = text.toLocaleLowerCase("en-US");
    return text.length >= 4 && !STOP_WORDS.has(key) && !/^\d+$/u.test(text);
  });
}

function phraseForStatement(statement, shift = 0) {
  const tokens = contentTokens(statement);
  if (!tokens.length) return null;
  const index = Math.min(tokens.length - 1, Math.floor(tokens.length / 2) + shift);
  const start = tokens[index];
  const next = tokens[index + 1];
  const includeNext = next
    && statement.slice(start.end, next.start) === " "
    && !STOP_WORDS.has(next.text.toLocaleLowerCase("en-US"));
  const end = includeNext ? next.end : start.end;
  return {
    end,
    start: start.start,
    text: statement.slice(start.start, end),
  };
}

function uniquePhrases(values, excluded = []) {
  const blocked = new Set(excluded.map(normalizedKey));
  const seen = new Set(blocked);
  const result = [];
  for (const value of values) {
    const text = compactText(value, 120);
    const key = normalizedKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function deterministicChoices(correct, distractors, seed) {
  const selected = uniquePhrases(distractors, [correct]).slice(0, 3);
  const fallbacks = ["not stated", "another concept", "different evidence", "unrelated detail"];
  selected.push(...uniquePhrases(fallbacks, [correct, ...selected]).slice(0, 3 - selected.length));
  const choices = [correct, ...selected].slice(0, 4)
    .sort((left, right) => stableHash(`${seed}:${left}`).localeCompare(stableHash(`${seed}:${right}`)));
  return { choices, correctIndex: choices.indexOf(correct) };
}

function deterministicMultiChoices(correctPhrases, distractors, seed) {
  const correct = uniquePhrases(correctPhrases).slice(0, 2);
  const wrong = uniquePhrases(distractors, correct).slice(0, 2);
  const fallbacks = ["not stated", "different term", "unrelated detail"];
  wrong.push(...uniquePhrases(fallbacks, [...correct, ...wrong]).slice(0, 2 - wrong.length));
  const tagged = [
    ...correct.map((text) => ({ correct: true, text })),
    ...wrong.slice(0, 2).map((text) => ({ correct: false, text })),
  ].sort((left, right) => stableHash(`${seed}:${left.text}`).localeCompare(stableHash(`${seed}:${right.text}`)));
  return {
    choices: tagged.map((item) => item.text),
    correctIndices: tagged.flatMap((item, index) => item.correct ? [index] : []),
  };
}

function topicFor(statement) {
  const words = contentTokens(statement).slice(0, 4).map(({ text }) => text);
  return compactText(words.join(" "), 96) || "Source statement";
}

function candidatesFromSources(sources) {
  const candidates = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const sourceId = compactText(source?.id, 128);
    if (!sourceId) continue;
    const fileName = safeLeafName(source?.fileName);
    for (const section of sourceSections(source)) {
      const statement = compactText(section.statement, 460);
      const phrase = phraseForStatement(statement);
      if (statement.length < 48 || wordTokens(statement).length < 8 || !phrase) continue;
      candidates.push({ fileName, location: section.location, phrase, sourceId, statement });
    }
  }
  return candidates;
}

function cardForCandidate(candidate, index, candidates, courseLabel, challenge) {
  const otherPhrases = candidates.flatMap((item) => [
    item.phrase?.text,
    phraseForStatement(item.statement, -1)?.text,
    phraseForStatement(item.statement, 1)?.text,
  ]).filter(Boolean);
  const ownPhrases = contentTokens(candidate.statement).map(({ text }) => text);
  const answer = candidate.phrase.text;
  const secondary = uniquePhrases([
    phraseForStatement(candidate.statement, -1)?.text,
    phraseForStatement(candidate.statement, 1)?.text,
    ...ownPhrases,
  ], [answer])[0] || "source statement";
  const seed = `${candidate.sourceId}:${candidate.location}:${candidate.statement}`;
  const abcd = deterministicChoices(answer, [...otherPhrases, ...ownPhrases], `${seed}:abcd`);
  const multiple = deterministicMultiChoices(
    [answer, secondary],
    [...otherPhrases, ...ownPhrases],
    `${seed}:multiple`,
  );
  const cloze = `${candidate.statement.slice(0, candidate.phrase.start)}_____${candidate.statement.slice(candidate.phrase.end)}`;
  const citation = `${candidate.fileName}, ${candidate.location}`;
  return {
    id: `local-${stableHash(seed)}-${index + 1}`,
    level: challenge,
    topic: topicFor(candidate.statement),
    objective: `Restore one exact statement from ${candidate.fileName}.`,
    coreQuestion: `Which phrase completes this ${courseLabel} source statement exactly?`,
    canonicalAnswer: candidate.statement,
    explanation: `The complete source statement is: “${candidate.statement}”`,
    misconception: "Choosing a different source term instead of the phrase that appears at this cited location.",
    sourceCitation: citation,
    sourceRefs: [candidate.sourceId],
    visualization: null,
    abcd: {
      ...abcd,
      prompt: cloze,
    },
    fill: {
      prompt: cloze,
      acceptedAnswers: [answer],
    },
    trueFalse: {
      statement: candidate.statement,
      correct: true,
      correction: candidate.statement,
    },
    multipleAnswer: {
      prompt: "Select the two phrases that appear in the cited source statement.",
      ...multiple,
    },
    acceptedAnswerVariants: [answer],
    hint: `Check ${citation}.`,
    difficulty: challenge <= 3 ? (index < 2 ? "recognition" : "recall") : "extractive-recall",
    prerequisites: [],
  };
}

function balancedCandidates(candidates, limit) {
  const groups = new Map();
  for (const candidate of candidates) {
    const group = groups.get(candidate.sourceId) || [];
    group.push(candidate);
    groups.set(candidate.sourceId, group);
  }
  const selected = [];
  for (let offset = 0; selected.length < limit; offset += 1) {
    let added = false;
    for (const group of groups.values()) {
      if (group[offset]) {
        selected.push(group[offset]);
        added = true;
        if (selected.length === limit) break;
      }
    }
    if (!added) break;
  }
  return selected;
}

export function buildLocalStudyDeck({ course, mode = "practice", sources, focus = "", questionCount = 8, challenge = 6 } = {}) {
  const candidates = candidatesFromSources(sources);
  if (!candidates.length) {
    throw new Error("No readable source statements were long enough to turn into practice cards. Try a text-based PDF, DOCX, or TXT file with complete sentences.");
  }
  const requestedCount = Number.isInteger(Number(questionCount))
    ? Math.min(MAX_LOCAL_STUDY_CARDS, Math.max(1, Number(questionCount)))
    : MAX_LOCAL_STUDY_CARDS;
  const requestedChallenge = Number.isInteger(Number(challenge))
    ? Math.min(10, Math.max(1, Number(challenge)))
    : 6;
  const selected = balancedCandidates(candidates, requestedCount);
  const courseLabel = compactText(course?.code || course?.name, 48) || "course";
  const cards = selected.map((candidate, index) => cardForCandidate(candidate, index, selected, courseLabel, requestedChallenge));
  const errors = validateStudyDeck(cards);
  if (errors.length) throw new Error("The private browser-generated cards did not pass validation. Nothing was saved.");
  return {
    cards,
    challengeTargetGuaranteed: false,
    challengeTargetMethod: "Browser extractive recall; the requested challenge is an organizational target, not a validated cognitive-demand rating.",
    generationChallenge: requestedChallenge,
    generationFocus: compactText(focus, 240),
    generationOrigin: "local-extractive",
    generationQuestionCount: requestedCount,
    title: compactText(focus, 96) || `${courseLabel} ${mode === "quiz" ? "source quiz" : "source practice"}`,
  };
}
