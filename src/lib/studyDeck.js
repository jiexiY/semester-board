const REVIEW_OFFSETS = Object.freeze([
  { id: "four-hours", label: "About four hours", hours: 4 },
  { id: "one-day", label: "One day", days: 1 },
  { id: "three-days", label: "Three days", days: 3 },
  { id: "seven-days", label: "Seven days", days: 7 },
  { id: "fourteen-days", label: "Fourteen days", days: 14 },
  { id: "thirty-days", label: "Thirty days", days: 30 },
]);

const REQUIRED_CARD_FIELDS = Object.freeze([
  "id",
  "level",
  "topic",
  "objective",
  "coreQuestion",
  "canonicalAnswer",
  "explanation",
  "misconception",
  "sourceCitation",
  "abcd",
  "fill",
  "trueFalse",
  "multipleAnswer",
  "acceptedAnswerVariants",
  "difficulty",
  "prerequisites",
]);

const MAX_STUDY_IDENTIFIER_LENGTH = 128;
const BLOCKED_STUDY_IDENTIFIERS = new Set(["__proto__", "constructor", "prototype"]);

export function canonicalStudySpaceId(value) {
  if (typeof value !== "string") return null;
  const identifier = value.trim();
  if (!identifier
    || identifier.length > MAX_STUDY_IDENTIFIER_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(identifier)
    || BLOCKED_STUDY_IDENTIFIERS.has(identifier)) return null;
  return identifier;
}

export function genericCourseDeckId(courseSpaceId) {
  const identifier = canonicalStudySpaceId(courseSpaceId);
  if (!identifier) return null;
  const direct = `course-workspace-${identifier}`;
  if (direct.length <= MAX_STUDY_IDENTIFIER_LENGTH) return direct;
  const forward = deterministicRank("course-workspace", identifier).toString(36);
  const backward = deterministicRank("course-workspace", [...identifier].reverse().join("")).toString(36);
  return `course-workspace-${forward}${backward}`;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}

function sameNumberSet(left = [], right = []) {
  const leftSet = new Set(left.map(Number));
  const rightSet = new Set(right.map(Number));
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function icsDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsText(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\\;");
}

function arrayOfStrings(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function manifestEntries(sourceManifest) {
  if (Array.isArray(sourceManifest)) return sourceManifest;
  if (Array.isArray(sourceManifest?.entries)) return sourceManifest.entries;
  if (!sourceManifest || typeof sourceManifest !== "object") return [];
  return Object.entries(sourceManifest).map(([id, entry]) => ({ id, ...(entry || {}) }));
}

function deterministicRank(seed, value) {
  const text = `${seed}:${value}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function compareDeterministically(seed, left, right, valueForItem) {
  const leftValue = String(valueForItem(left));
  const rightValue = String(valueForItem(right));
  const rankDifference = deterministicRank(seed, leftValue) - deterministicRank(seed, rightValue);
  return rankDifference || leftValue.localeCompare(rightValue, "en-US");
}

export function studyCardGuideIds(card) {
  return arrayOfStrings(card?.guideIds?.length ? card.guideIds : card?.guideId);
}

export function filterStudyCards(cards, filters = {}) {
  if (!Array.isArray(cards)) return [];
  const courseIds = new Set(arrayOfStrings(filters.courseIds?.length ? filters.courseIds : filters.courseId));
  const guideIds = new Set(arrayOfStrings(filters.guideIds?.length ? filters.guideIds : filters.guideId));
  const topicIds = new Set(arrayOfStrings(filters.topicIds?.length ? filters.topicIds : filters.topicId));
  const levels = new Set((Array.isArray(filters.levels) ? filters.levels : filters.level ? [filters.level] : [])
    .map(Number)
    .filter(Number.isInteger));
  const query = normalizeText(filters.query);

  return cards.filter((card) => {
    if (courseIds.size && !courseIds.has(String(card.courseId || ""))) return false;
    if (guideIds.size && !studyCardGuideIds(card).some((guideId) => guideIds.has(guideId))) return false;
    const cardTopicIds = arrayOfStrings(card.topicIds?.length ? card.topicIds : (card.topicId || card.topic));
    if (topicIds.size && !cardTopicIds.some((topicId) => topicIds.has(topicId))) return false;
    if (levels.size && !levels.has(Number(card.level))) return false;
    if (query) {
      const searchable = normalizeText([
        card.topic,
        card.objective,
        card.coreQuestion,
        card.canonicalAnswer,
        card.explanation,
      ].filter(Boolean).join(" "));
      if (!searchable.includes(query)) return false;
    }
    return true;
  });
}

export function studyCardFacets(cards) {
  const counts = {
    courses: new Map(),
    guides: new Map(),
    topics: new Map(),
  };
  for (const card of Array.isArray(cards) ? cards : []) {
    const courseId = String(card.courseId || "").trim();
    if (courseId) counts.courses.set(courseId, (counts.courses.get(courseId) || 0) + 1);
    for (const guideId of studyCardGuideIds(card)) {
      counts.guides.set(guideId, (counts.guides.get(guideId) || 0) + 1);
    }
    for (const topicId of arrayOfStrings(card.topicIds?.length ? card.topicIds : (card.topicId || card.topic))) {
      counts.topics.set(topicId, (counts.topics.get(topicId) || 0) + 1);
    }
  }
  const toFacets = (map) => [...map.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((left, right) => left.id.localeCompare(right.id, "en-US"));
  return {
    courses: toFacets(counts.courses),
    guides: toFacets(counts.guides),
    topics: toFacets(counts.topics),
  };
}

export function resolveStudySourceRefs(sourceRefs, sourceManifest) {
  const refs = arrayOfStrings(sourceRefs);
  const entries = manifestEntries(sourceManifest);
  const byId = new Map();
  const duplicateIds = new Set();
  for (const entry of entries) {
    const id = String(entry?.id || "").trim();
    if (!id) continue;
    if (byId.has(id)) duplicateIds.add(id);
    else byId.set(id, entry);
  }

  const resolved = refs.filter((ref) => byId.has(ref)).map((ref) => byId.get(ref));
  const missing = refs.filter((ref) => !byId.has(ref));
  const unaudited = refs.filter((ref) => {
    const entry = byId.get(ref);
    return entry && entry.auditStatus !== "audited";
  });

  return {
    ok: missing.length === 0 && unaudited.length === 0 && duplicateIds.size === 0,
    refs,
    resolved,
    missing,
    unaudited,
    duplicateIds: [...duplicateIds].sort((left, right) => left.localeCompare(right, "en-US")),
  };
}

export function cardsForChallenge(cards, challenge) {
  const level = Number(challenge);
  if (level === 5) return cards.filter((card) => card.level <= 5);
  if (level === 10) return cards.filter((card) => card.level <= 10);
  return cards.filter((card) => card.level === level);
}

export function gradePracticeResponse(card, method, response) {
  if (!card) return false;
  if (method === "flashcards") return Number(response) === Number(card.abcd.correctIndex);
  if (method === "fill") {
    const accepted = new Set([
      ...(card.fill.acceptedAnswers || []),
      ...(card.acceptedAnswerVariants || []),
      card.canonicalAnswer,
    ].map(normalizeText).filter(Boolean));
    return accepted.has(normalizeText(response));
  }
  if (method === "true-false") return Boolean(response) === Boolean(card.trueFalse.correct);
  if (method === "multiple-answer") {
    return sameNumberSet(response, card.multipleAnswer.correctIndices);
  }
  return false;
}

export function correctAnswerForMethod(card, method) {
  if (method === "flashcards") return card.abcd.choices[card.abcd.correctIndex];
  if (method === "fill") return card.fill.acceptedAnswers.join("; ");
  if (method === "true-false") return card.trueFalse.correct ? "True" : `False — ${card.trueFalse.correction}`;
  if (method === "multiple-answer") {
    return card.multipleAnswer.correctIndices.map((index) => card.multipleAnswer.choices[index]).join("; ");
  }
  return card.canonicalAnswer;
}

export function recordErrorBookEntry(entries, {
  card,
  method,
  response,
  reason,
  occurredAt = new Date().toISOString(),
}) {
  const key = `${card.id}:${method}`;
  const historyItem = { response, correct: false, occurredAt };
  const existingIndex = entries.findIndex((entry) => entry.key === key);
  if (existingIndex < 0) {
    return [...entries, {
      key,
      cardId: card.id,
      question: card.coreQuestion,
      practiceMethod: method,
      response,
      correctAnswer: correctAnswerForMethod(card, method),
      explanation: card.explanation,
      source: card.sourceCitation,
      reason,
      needsReview: true,
      history: [historyItem],
    }];
  }

  return entries.map((entry, index) => index === existingIndex ? {
    ...entry,
    response,
    reason,
    needsReview: true,
    history: [...entry.history, historyItem],
  } : entry);
}

export function resolveErrorBookEntry(entries, {
  cardId,
  method,
  response,
  occurredAt = new Date().toISOString(),
}) {
  const key = `${cardId}:${method}`;
  return entries.map((entry) => entry.key === key ? {
    ...entry,
    response,
    needsReview: false,
    history: [...entry.history, { response, correct: true, occurredAt }],
  } : entry);
}

export function buildGuideBalancedQuiz(cards, requestedCount = 25, { seed = "semester-board" } = {}) {
  const available = Array.isArray(cards) ? cards : [];
  if (!available.length) return [];
  const count = Math.max(1, Math.min(Number(requestedCount) || 25, available.length));
  const groups = new Map();
  for (const card of available) {
    const guideId = studyCardGuideIds(card)[0] || "__ungrouped__";
    const group = groups.get(guideId) || [];
    group.push(card);
    groups.set(guideId, group);
  }

  const orderedGroups = [...groups.entries()]
    .sort((left, right) => compareDeterministically(`${seed}:guides`, left, right, ([guideId]) => guideId))
    .map(([guideId, group]) => ({
      guideId,
      cards: [...group].sort((left, right) => compareDeterministically(
        `${seed}:${guideId}:cards`,
        left,
        right,
        (card) => card.id,
      )),
    }));

  const selected = [];
  for (let round = 0; selected.length < count; round += 1) {
    let added = false;
    for (const group of orderedGroups) {
      const card = group.cards[round];
      if (!card) continue;
      selected.push(card);
      added = true;
      if (selected.length === count) break;
    }
    if (!added) break;
  }
  return selected;
}

export function buildQuiz(cards, challenge, requestedCount = 25, options = {}) {
  const available = cardsForChallenge(cards, challenge);
  const count = Math.max(1, Math.min(Number(requestedCount) || 25, available.length));
  const hasGuideMetadata = available.some((card) => studyCardGuideIds(card).length > 0);
  if (options.balanceByGuide !== false && hasGuideMetadata) {
    return buildGuideBalancedQuiz(available, count, options);
  }
  return available.slice(0, count);
}

export function scoreQuiz(questions, responses, threshold = 80) {
  const graded = questions.map((card) => ({
    card,
    response: responses[card.id],
    correct: Number(responses[card.id]) === Number(card.abcd.correctIndex),
  }));
  const answered = graded.filter((item) => item.response !== undefined).length;
  const correct = graded.filter((item) => item.correct).length;
  const percentage = questions.length ? Math.round((correct / questions.length) * 100) : 0;
  const topicBuckets = new Map();

  for (const item of graded) {
    const bucket = topicBuckets.get(item.card.topic) || { topic: item.card.topic, correct: 0, total: 0 };
    bucket.total += 1;
    if (item.correct) bucket.correct += 1;
    topicBuckets.set(item.card.topic, bucket);
  }

  const topics = [...topicBuckets.values()].map((bucket) => ({
    ...bucket,
    percentage: Math.round((bucket.correct / bucket.total) * 100),
  }));
  const severeGap = topics.some((topic) => topic.percentage < 60);

  return {
    answered,
    correct,
    percentage,
    topics,
    items: graded,
    recommendation: percentage >= threshold && !severeGap ? "advance" : "reinforce",
    severeGap,
    threshold,
  };
}

export function buildReviewSchedule(startValue) {
  const start = new Date(startValue);
  if (Number.isNaN(start.getTime())) return [];

  return REVIEW_OFFSETS.map((offset) => {
    const review = new Date(start);
    if (offset.hours) review.setHours(review.getHours() + offset.hours);
    if (offset.days) review.setDate(review.getDate() + offset.days);
    const hour = review.getHours();
    if (hour >= 22) review.setDate(review.getDate() + 1);
    if (hour >= 22 || hour < 8) review.setHours(9, 0, 0, 0);
    return { id: offset.id, label: offset.label, date: review };
  });
}

export function buildReviewCalendar(schedule, title = "Semester Board active-recall review") {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Semester Board//Study Deck//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  schedule.forEach((item, index) => {
    const start = item.date;
    const end = new Date(start.getTime() + 20 * 60 * 1000);
    lines.push(
      "BEGIN:VEVENT",
      `UID:semester-board-review-${index + 1}-${start.getTime()}@local`,
      `DTSTAMP:${icsDate(new Date(0))}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${icsText(title)}`,
      "DESCRIPTION:Forgetting-curve-inspired active-recall review suggestion. This is a practical heuristic, not a personalized scientific prediction.",
      "END:VEVENT",
    );
  });
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

export function buildAnkiCsv(cards) {
  const rows = cards.map((card) => {
    const back = [card.canonicalAnswer, card.explanation, `Source: ${card.sourceCitation}`].filter(Boolean).join(" — ");
    return `${csvCell(card.coreQuestion)},${csvCell(back)}`;
  });
  return ["#separator:Comma", "#html:false", "#columns:Front,Back", ...rows].join("\r\n");
}

export function validateStudyDeck(cards, options = {}) {
  const errors = [];
  if (!Array.isArray(cards) || !cards.length) return ["Deck must contain at least one card."];
  const ids = new Set();
  const strictSources = options.requireAuditedSourceRefs === true;

  for (const [index, card] of cards.entries()) {
    for (const field of REQUIRED_CARD_FIELDS) {
      if (!(field in card) || card[field] === null || card[field] === "") {
        errors.push(`Card ${index + 1} is missing ${field}.`);
      }
    }
    if (ids.has(card.id)) errors.push(`Duplicate card id: ${card.id}.`);
    ids.add(card.id);
    if (!Number.isInteger(card.level) || card.level < 1 || card.level > 10) {
      errors.push(`Card ${card.id || index + 1} must use challenge level 1–10.`);
    }
    if (!Array.isArray(card.abcd?.choices) || card.abcd.choices.length !== 4) {
      errors.push(`Card ${card.id || index + 1} must have exactly four ABCD choices.`);
    }
    if (new Set((card.abcd?.choices || []).map(normalizeText)).size !== 4) {
      errors.push(`Card ${card.id || index + 1} must have four distinct ABCD choices.`);
    }
    if (!Number.isInteger(card.abcd?.correctIndex) || card.abcd.correctIndex < 0 || card.abcd.correctIndex > 3) {
      errors.push(`Card ${card.id || index + 1} must have one valid ABCD answer.`);
    }
    const multiChoices = card.multipleAnswer?.choices || [];
    const multiCorrect = [...new Set(card.multipleAnswer?.correctIndices || [])];
    if (multiChoices.length < 4 || multiChoices.length > 6) {
      errors.push(`Card ${card.id || index + 1} must have four to six multiple-answer choices.`);
    }
    if (new Set(multiChoices.map(normalizeText)).size !== multiChoices.length) {
      errors.push(`Card ${card.id || index + 1} must have distinct multiple-answer choices.`);
    }
    if (multiCorrect.length < 2 || multiCorrect.some((choice) => choice < 0 || choice >= multiChoices.length)) {
      errors.push(`Card ${card.id || index + 1} must have at least two valid multiple-answer choices.`);
    }
    if (!Array.isArray(card.fill?.acceptedAnswers) || !card.fill.acceptedAnswers.length) {
      errors.push(`Card ${card.id || index + 1} must have a fill-in accepted answer.`);
    }
    if (strictSources) {
      if (!String(card.courseId || "").trim()) {
        errors.push(`Card ${card.id || index + 1} must identify its course for audited validation.`);
      }
      if (!String(card.topicId || "").trim()) {
        errors.push(`Card ${card.id || index + 1} must identify its topic for audited validation.`);
      }
      if (!studyCardGuideIds(card).length) {
        errors.push(`Card ${card.id || index + 1} must identify at least one guide for audited validation.`);
      }
      if (!Array.isArray(card.sourceRefs) || !card.sourceRefs.length) {
        errors.push(`Card ${card.id || index + 1} must cite at least one audited source reference.`);
      } else {
        const resolution = resolveStudySourceRefs(card.sourceRefs, options.sourceManifest);
        if (resolution.duplicateIds.length) {
          errors.push(`Source manifest contains duplicate ids: ${resolution.duplicateIds.join(", ")}.`);
        }
        if (resolution.missing.length) {
          errors.push(`Card ${card.id || index + 1} has unresolved source refs: ${resolution.missing.join(", ")}.`);
        }
        if (resolution.unaudited.length) {
          errors.push(`Card ${card.id || index + 1} has source refs that are not audited: ${resolution.unaudited.join(", ")}.`);
        }
        const wrongCourseRefs = resolution.resolved.filter((entry) => (
          entry.courseId && card.courseId && entry.courseId !== card.courseId
        )).map((entry) => entry.id);
        if (wrongCourseRefs.length) {
          errors.push(`Card ${card.id || index + 1} cites sources from another course: ${wrongCourseRefs.join(", ")}.`);
        }
      }
    }
  }
  return errors;
}

export function validateAuditedStudyDeck(cards, sourceManifest) {
  return validateStudyDeck(cards, { sourceManifest, requireAuditedSourceRefs: true });
}

export function deckTemplate() {
  return {
    title: "Replace with a source-grounded deck title",
    generalKnowledge: "disabled",
    cards: [{
      id: "subject-level-01-card-01",
      level: 1,
      topic: "Replace with a topic",
      objective: "Replace with one observable learning objective",
      coreQuestion: "Replace with one clear retrieval question",
      canonicalAnswer: "Replace with the supported answer",
      explanation: "Replace with a concise source-grounded explanation",
      misconception: "Replace with a plausible misconception",
      sourceCitation: "Replace with a real source and location",
      visualization: null,
      abcd: { choices: ["Correct answer", "Plausible distractor A", "Plausible distractor B", "Plausible distractor C"], correctIndex: 0 },
      fill: { prompt: "Replace one meaningful term with ____.", acceptedAnswers: ["Correct answer"] },
      trueFalse: { statement: "Replace with a precise statement.", correct: true, correction: "" },
      multipleAnswer: { prompt: "Select all correct answers.", choices: ["Correct A", "Correct B", "Distractor A", "Distractor B"], correctIndices: [0, 1] },
      acceptedAnswerVariants: ["Correct answer"],
      hint: "Replace with an optional non-answer-bearing hint",
      difficulty: "recognition",
      prerequisites: [],
    }],
  };
}
