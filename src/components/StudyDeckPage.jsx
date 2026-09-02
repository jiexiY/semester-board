import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import {
  buildAnkiCsv,
  buildQuiz,
  buildReviewCalendar,
  buildReviewSchedule,
  canonicalStudySpaceId,
  cardsForChallenge,
  correctAnswerForMethod,
  deckTemplate,
  genericCourseDeckId,
  gradePracticeResponse,
  recordErrorBookEntry,
  resolveErrorBookEntry,
  scoreQuiz,
  validateStudyDeck,
} from "../lib/studyDeck";

const CHALLENGE_LEVELS = Object.freeze([
  { level: 1, title: "Foundations", cognitiveDemand: "Recognize a core idea or definition." },
  { level: 2, title: "Recall", cognitiveDemand: "Retrieve terms and concise supported answers." },
  { level: 3, title: "Connect", cognitiveDemand: "Relate two source-grounded ideas." },
  { level: 4, title: "Apply", cognitiveDemand: "Apply a concept to a supported example." },
  { level: 5, title: "Checkpoint", cognitiveDemand: "Review the supported material from levels 1–5." },
  { level: 6, title: "Analyze", cognitiveDemand: "Break down a claim, method, or relationship." },
  { level: 7, title: "Compare", cognitiveDemand: "Compare supported positions or evidence." },
  { level: 8, title: "Evaluate", cognitiveDemand: "Evaluate a claim within the supplied evidence." },
  { level: 9, title: "Synthesize", cognitiveDemand: "Synthesize multiple source-grounded ideas." },
  { level: 10, title: "Final review", cognitiveDemand: "Review all supported challenge levels." },
]);

const GENERIC_DECK = Object.freeze({
  id: "generic-study-deck-shell",
  deckKind: "generic",
  title: "Build your Study Deck",
  subtitle: "Start with your own sources or canonical-card JSON",
  description: "A blank per-profile workspace with no preloaded course claims.",
  courseCode: "Course",
  courseId: null,
  generalKnowledge: "unknown",
  cards: Object.freeze([]),
  sourceManifest: [],
  coverage: {
    status: "empty",
    cardCount: 0,
    targetCardCount: 200,
    paddingDisabled: true,
    levelCounts: Object.freeze(Object.fromEntries(Array.from({ length: 10 }, (_, index) => [index + 1, 0]))),
    scopeRule: "No tested scope is active until a user-provided deck is imported from reviewed source evidence.",
  },
});

const EMPTY_STUDY_DECK_STATE = Object.freeze({
  selectedDeckId: null,
  selectedCourseSpaceId: null,
  courseSpaces: Object.freeze([]),
  selectedDeckByCourse: Object.freeze({}),
  sourceRevisionByCourse: Object.freeze({}),
  deckSourceRevisionByDeck: Object.freeze({}),
  challengeByDeck: Object.freeze({}),
  methodByDeck: Object.freeze({}),
  errorBookByDeck: Object.freeze({}),
  reviewStartByDeck: Object.freeze({}),
  generationSettingsByCourse: Object.freeze({}),
  customDecks: Object.freeze({}),
});

const SOURCE_ACCEPT = ".pdf,.doc,.docx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain";
const SOURCE_EXTENSIONS = new Set(["pdf", "doc", "docx", "txt"]);
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_BATCH = 20;
const MAX_CUSTOM_DECKS = 12;
const MAX_CUSTOM_DECK_FILE_BYTES = 700 * 1024;
const MAX_CUSTOM_DECK_TOTAL_BYTES = 720 * 1024;
const MAX_COURSE_SPACES = 12;

const TOOLS = [
  { id: "practice", label: "Practice", icon: "target" },
  { id: "quiz", label: "Quiz", icon: "check" },
  { id: "errors", label: "Error Book", icon: "flag" },
  { id: "reviews", label: "Check-in", icon: "clock" },
  { id: "sources", label: "Sources", icon: "book" },
  { id: "lab", label: "Media Lab", icon: "lab" },
  { id: "coverage", label: "Coverage", icon: "sources" },
];

const METHODS = [
  { id: "flashcards", label: "ABCD cards", description: "Recognition with four distinct choices." },
  { id: "fill", label: "Fill the blank", description: "Recall a key term or concise supported answer." },
  { id: "true-false", label: "True or false", description: "Catch a plausible misconception." },
  { id: "multiple-answer", label: "Select all", description: "Choose the complete supported set." },
];

function stableTextHash(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableContentHash(value) {
  const text = String(value || "");
  let forward = 2166136261;
  let backward = 2246822519;
  for (let index = 0; index < text.length; index += 1) {
    forward ^= text.charCodeAt(index);
    forward = Math.imul(forward, 16777619);
    backward ^= text.charCodeAt(text.length - index - 1);
    backward = Math.imul(backward, 3266489917);
  }
  return `${(forward >>> 0).toString(36)}${(backward >>> 0).toString(36)}`;
}

function serializedBytes(value) {
  try {
    return new Blob([typeof value === "string" ? value : JSON.stringify(value)]).size;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function normalizedCourseSpaces(value) {
  const entries = Array.isArray(value)
    ? value.map((course) => [course?.id, course])
    : value && typeof value === "object"
      ? Object.entries(value)
      : [];
  return entries.flatMap(([savedId, course]) => {
    if (!course || typeof course !== "object") return [];
    const id = canonicalStudySpaceId(course.id || savedId);
    const name = safePublicText(course.name || course.title, "", 80);
    if (!id || !name) return [];
    return [{
      ...course,
      id,
      name,
      code: safePublicText(course.code || course.courseCode, "", 32),
      archived: Boolean(course.archived || course.archivedAt),
    }];
  }).sort((left, right) => (
    Number(left.archived) - Number(right.archived)
    || String(left.createdAt || "").localeCompare(String(right.createdAt || ""))
    || left.name.localeCompare(right.name, "en-US")
  ));
}

function genericDeckForCourse(course) {
  return {
    ...GENERIC_DECK,
    id: genericCourseDeckId(course.id),
    title: `${course.name} study workspace`,
    subtitle: "Add private sources or import source-reviewed canonical cards",
    courseCode: course.code || course.name,
    courseId: course.id,
    courseSpaceId: course.id,
  };
}

function safeFileStem(value, fallback = "study-deck") {
  const stem = String(value || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLocaleLowerCase("en-US")
    .slice(0, 72);
  return stem || fallback;
}

function firstSupportedLevel(cards) {
  return [...new Set((cards || []).map((card) => Number(card.level)).filter(Number.isInteger))]
    .sort((left, right) => left - right)[0] || 1;
}

function safePublicText(value, fallback = "", limit = 240) {
  const text = String(value || "")
    .replace(/\b[a-f\d]{24,}\b/giu, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, limit);
  return text || fallback;
}

function safePublicLabel(value, fallback = "Untitled source") {
  const leaf = String(value || "").split(/[\\/]/).at(-1);
  return safePublicText(leaf, fallback, 120);
}

function safeSourceCitation(value) {
  return String(value || "")
    .split(";")
    .map((part) => safePublicText(part.replace(/(?:[A-Za-z]:)?(?:[^;]*[\\/])+/g, ""), "Source location not stated", 220))
    .join("; ");
}

function safeOpaqueIdentifier(value) {
  const identifier = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(identifier)) return null;
  if (["__proto__", "constructor", "prototype"].includes(identifier)) return null;
  return identifier;
}

function sanitizeImportedCards(cards) {
  return cards.map((card) => ({
    ...card,
    sourceRefs: Array.isArray(card.sourceRefs)
      ? [...new Set(card.sourceRefs.map(safeOpaqueIdentifier).filter(Boolean))].slice(0, 20)
      : [],
    sourceCitation: safeSourceCitation(card.sourceCitation),
  }));
}

function sanitizeSourceManifest(value) {
  const entries = Array.isArray(value) ? value : Array.isArray(value?.entries) ? value.entries : [];
  return entries.slice(0, 200).map((entry) => {
    const id = safeOpaqueIdentifier(entry?.id);
    return {
      ...(id ? { id } : {}),
      publicLabel: safePublicLabel(entry?.publicLabel || entry?.label || entry?.name),
      sourceKind: safePublicText(entry?.sourceKind, "User-provided source", 48),
      role: safePublicText(entry?.role, "", 72),
      unitCount: Number.isFinite(Number(entry?.unitCount)) ? Math.max(0, Number(entry.unitCount)) : null,
      auditStatus: "user-provided",
      status: "user-provided",
    };
  });
}

function sanitizeCoverage(value, cards) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const number = (key, fallback = null) => {
    if (source[key] === null || source[key] === undefined || source[key] === "") return fallback;
    return Number.isFinite(Number(source[key])) ? Math.max(0, Number(source[key])) : fallback;
  };
  const levelCounts = Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
    const level = index + 1;
    const stated = Number(source.levelCounts?.[level]);
    return [level, Number.isFinite(stated) ? Math.max(0, stated) : cards.filter((card) => card.level === level).length];
  }));
  const publicList = (items) => (Array.isArray(items) ? items : []).slice(0, 100).map((item) => (
    typeof item === "string"
      ? safePublicLabel(item)
      : {
        label: safePublicLabel(item?.label || item?.publicLabel || item?.name || item?.fileName),
        reason: safePublicText(item?.reason, "", 180),
      }
  ));

  return {
    status: "imported-unaudited",
    promptCount: number("promptCount"),
    mappedPromptCount: number("mappedPromptCount"),
    partialPromptCount: number("partialPromptCount"),
    blockedPromptCount: number("blockedPromptCount"),
    supportedOrAccountedPromptCount: number("supportedOrAccountedPromptCount"),
    duplicatePromptMappings: number("duplicatePromptMappings"),
    assessmentRuleCount: number("assessmentRuleCount"),
    mappedAssessmentRuleCount: number("mappedAssessmentRuleCount"),
    assessmentRuleCardCount: number("assessmentRuleCardCount"),
    cardCount: cards.length,
    targetCardCount: number("targetCardCount", 200),
    paddingDisabled: true,
    sourceFileCount: number("sourceFileCount"),
    readableSourceFileCount: number("readableSourceFileCount"),
    generationFocus: safePublicText(source.generationFocus, "", 240),
    generationQuestionCount: Math.min(8, Math.max(1, number("generationQuestionCount", Math.min(8, Math.max(1, cards.length || 8))))),
    generationChallenge: Math.min(10, Math.max(1, number("generationChallenge", firstSupportedLevel(cards)))),
    challengeTargetGuaranteed: source.challengeTargetGuaranteed === true,
    challengeTargetMethod: safePublicText(source.challengeTargetMethod, "", 240),
    levelCounts,
    guideCoverage: (Array.isArray(source.guideCoverage) ? source.guideCoverage : []).slice(0, 100).map((guide) => ({
      label: safePublicLabel(guide?.label || guide?.title, "Untitled guide"),
      promptCount: Number.isFinite(Number(guide?.promptCount)) ? Math.max(0, Number(guide.promptCount)) : 0,
      mappedPromptCount: Number.isFinite(Number(guide?.mappedPromptCount)) ? Math.max(0, Number(guide.mappedPromptCount)) : 0,
      partialPromptCount: Number.isFinite(Number(guide?.partialPromptCount)) ? Math.max(0, Number(guide.partialPromptCount)) : 0,
      blockedPromptCount: Number.isFinite(Number(guide?.blockedPromptCount)) ? Math.max(0, Number(guide.blockedPromptCount)) : 0,
      status: "user-provided",
    })),
    blockedPrompts: (Array.isArray(source.blockedPrompts) ? source.blockedPrompts : []).slice(0, 200).map((prompt) => ({
      promptId: safePublicText(prompt?.promptId, "Unidentified prompt", 96),
      status: prompt?.status === "partial" ? "partial" : "blocked",
      reason: safePublicText(prompt?.reason, "The imported file did not state a reason.", 480),
      topic: safePublicText(prompt?.topic, "Topic not stated", 160),
    })),
    ambiguities: (Array.isArray(source.ambiguities) ? source.ambiguities : []).slice(0, 100).map((item) => ({
      promptId: safePublicText(item?.promptId, "Unidentified prompt", 96),
      sourceFile: safePublicLabel(item?.sourceFile, "Source not stated"),
      sourcePage: Number.isFinite(Number(item?.sourcePage)) ? Math.max(0, Number(item.sourcePage)) : null,
      note: safePublicText(item?.note, "The imported file did not state a note.", 480),
    })),
    partialSourceFiles: publicList(source.partialSourceFiles),
    blockedSourceFiles: publicList(source.blockedSourceFiles),
    scopeRule: safePublicText(source.scopeRule, "The importer states this scope; Semester Board has not independently audited it.", 320),
  };
}

function normalizedCustomDecks(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([savedId, deck]) => {
    if (!deck || typeof deck !== "object" || !Array.isArray(deck.cards) || !deck.cards.length) return [];
    if (validateStudyDeck(deck.cards).length) return [];
    const id = canonicalStudySpaceId(deck.id || savedId);
    const courseSpaceId = canonicalStudySpaceId(deck.courseSpaceId);
    if (!id || !courseSpaceId) return [];
    const safeCards = sanitizeImportedCards(deck.cards);
    return [{
      ...deck,
      id,
      title: safePublicText(deck.title, "Imported study deck", 96),
      deckKind: "custom",
      generalKnowledge: deck.generalKnowledge || "unknown",
      courseId: safePublicText(deck.courseId, "", 96) || null,
      courseCode: safePublicText(deck.courseCode, "Course", 40),
      courseSpaceId,
      cards: safeCards,
      sourceManifest: sanitizeSourceManifest(deck.sourceManifest),
      coverage: sanitizeCoverage(deck.coverage, safeCards),
    }];
  });
}

function sourceLabel(source) {
  if (typeof source === "string") return safePublicLabel(source);
  return safePublicLabel(source?.publicLabel || source?.label || source?.fileName || source?.name);
}

function sourceStatusLabel(source) {
  return source?.storageScope === "account" ? "Private account" : "This device";
}

function sourceAddedLabel(source) {
  const value = source?.addedAt || source?.createdAt;
  if (!value) return "Added date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Added date unavailable";
  return `Added ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date)}`;
}

function localInputValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function downloadText(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatReviewDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function sourceShort(citation) {
  const [source] = String(citation).split(";");
  return source;
}

function displayPracticeResponse(card, method, response) {
  if (response === "I don’t know") return response;
  if (method === "flashcards") return card?.abcd?.choices?.[Number(response)] ?? String(response);
  if (method === "multiple-answer") {
    return (response || []).map((index) => card?.multipleAnswer?.choices?.[index] ?? index).join("; ");
  }
  if (method === "true-false") return response ? "True" : "False";
  return String(response);
}

function StudyEmpty({ children, icon = "sources", title }) {
  return (
    <div className="study-deck-empty" role="status">
      <span><Icon name={icon} size={23} /></span>
      <div><strong>{title}</strong><p>{children}</p></div>
    </div>
  );
}

function ChallengePicker({ cards, onChange, value }) {
  return (
    <fieldset className="study-deck-levels">
      <legend>Challenge level</legend>
      <div className="study-deck-level-grid">
        {CHALLENGE_LEVELS.map((level) => {
          const levelId = level.level ?? level.id;
          const levelLabel = level.title || level.band;
          const supported = cards.some((card) => card.level === levelId);
          return (
            <button
              aria-pressed={value === levelId}
              className={supported ? "" : "study-deck-level-blocked"}
              disabled={!supported}
              key={levelId}
              onClick={() => onChange(levelId)}
              title={supported ? (level.cognitiveDemand || levelLabel) : "Source material needed"}
              type="button"
            >
              <strong>{levelId}</strong>
              <span>{supported ? levelLabel : "Needs sources"}</span>
            </button>
          );
        })}
      </div>
      <p>Levels 5 and 10 become cumulative reviews once those levels have source-backed cards.</p>
    </fieldset>
  );
}

function MethodInput({ card, method, multiResponse, response, setMultiResponse, setResponse }) {
  if (method === "fill") {
    return (
      <label className="study-deck-fill">
        <span>{card.fill.prompt}</span>
        <input
          autoComplete="off"
          onChange={(event) => setResponse(event.target.value)}
          placeholder="Type your answer"
          type="text"
          value={response}
        />
      </label>
    );
  }

  if (method === "true-false") {
    return (
      <fieldset className="study-deck-answer-group">
        <legend>{card.trueFalse.statement}</legend>
        {["true", "false"].map((value) => (
          <label key={value}>
            <input checked={response === value} name={`tf-${card.id}`} onChange={() => setResponse(value)} type="radio" />
            <span><strong>{value === "true" ? "True" : "False"}</strong></span>
          </label>
        ))}
      </fieldset>
    );
  }

  const choices = method === "multiple-answer" ? card.multipleAnswer.choices : card.abcd.choices;
  const prompt = method === "multiple-answer" ? card.multipleAnswer.prompt : card.abcd.prompt;
  return (
    <fieldset className="study-deck-answer-group">
      <legend>{prompt}</legend>
      {choices.map((choice, index) => {
        const checked = method === "multiple-answer" ? multiResponse.includes(index) : response !== "" && Number(response) === index;
        return (
          <label key={`${card.id}-${index}`}>
            <input
              checked={checked}
              name={method === "multiple-answer" ? undefined : `abcd-${card.id}`}
              onChange={() => {
                if (method === "multiple-answer") {
                  setMultiResponse((current) => current.includes(index)
                    ? current.filter((item) => item !== index)
                    : [...current, index]);
                } else {
                  setResponse(String(index));
                }
              }}
              type={method === "multiple-answer" ? "checkbox" : "radio"}
            />
            <span><b>{String.fromCharCode(65 + index)}</b><strong>{choice}</strong></span>
          </label>
        );
      })}
    </fieldset>
  );
}

function PracticePanel({ cards, challenge, errorBook, method, onChallenge, onErrorBook, onMethod, onOpenErrors, onRetryConsumed, retryTarget }) {
  const available = useMemo(() => cardsForChallenge(cards, challenge), [cards, challenge]);
  const [index, setIndex] = useState(0);
  const [response, setResponse] = useState("");
  const [multiResponse, setMultiResponse] = useState([]);
  const [feedback, setFeedback] = useState(null);
  const headingRef = useRef(null);
  const card = available[index];

  const resetAnswer = () => {
    setResponse("");
    setMultiResponse([]);
    setFeedback(null);
  };

  useEffect(() => {
    setIndex(0);
    resetAnswer();
  }, [challenge, method]);

  useEffect(() => {
    if (!retryTarget || retryTarget.method !== method) return;
    const retryIndex = available.findIndex((item) => item.id === retryTarget.cardId);
    if (retryIndex >= 0) {
      setIndex(retryIndex);
      resetAnswer();
    }
    onRetryConsumed();
  }, [available, method, onRetryConsumed, retryTarget]);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [index]);

  if (!card) return <StudyEmpty title="No cards at this level">Import source-grounded canonical cards or choose an available level.</StudyEmpty>;

  const submittedResponse = method === "multiple-answer"
    ? multiResponse
    : method === "true-false"
      ? response === "true"
      : response;
  const hasResponse = method === "multiple-answer" ? multiResponse.length > 0 : response !== "";

  const submit = (dontKnow = false) => {
    const correct = !dontKnow && gradePracticeResponse(card, method, submittedResponse);
    if (correct) {
      onErrorBook((entries) => resolveErrorBookEntry(entries, {
        cardId: card.id,
        method,
        response: submittedResponse,
      }));
    } else {
      onErrorBook((entries) => recordErrorBookEntry(entries, {
        card,
        method,
        response: dontKnow ? "I don’t know" : submittedResponse,
        reason: dontKnow ? "Skipped — I don’t know" : "Incorrect response",
      }));
    }
    setFeedback({ correct, dontKnow });
  };

  const move = (nextIndex) => {
    setIndex(Math.max(0, Math.min(available.length - 1, nextIndex)));
    resetAnswer();
  };

  const unresolved = errorBook.filter((entry) => entry.needsReview).length;

  return (
    <div className="study-deck-practice-layout">
      <aside className="study-deck-practice-sidebar">
        <ChallengePicker cards={cards} onChange={onChallenge} value={challenge} />
        <fieldset className="study-deck-methods">
          <legend>Practice method</legend>
          {METHODS.map((item) => (
            <button aria-pressed={method === item.id} key={item.id} onClick={() => onMethod(item.id)} type="button">
              <strong>{item.label}</strong><span>{item.description}</span>
            </button>
          ))}
        </fieldset>
        <button className="study-deck-error-link" onClick={onOpenErrors} type="button">
          <Icon name="flag" size={17} /><span>Error Book</span><strong>{unresolved}</strong>
        </button>
      </aside>

      <section className="study-deck-card" aria-labelledby="study-active-card-title">
        <div className="study-deck-card-meta">
          <span>Level {challenge} · {card.topic}</span>
          <span>{index + 1} / {available.length}</span>
        </div>
        <div aria-hidden="true" className="study-deck-progress"><span style={{ width: `${((index + 1) / available.length) * 100}%` }} /></div>
        <h3 id="study-active-card-title" ref={headingRef} tabIndex="-1">{card.coreQuestion}</h3>
        <p className="study-deck-objective">Objective · {card.objective}</p>

        <MethodInput
          card={card}
          method={method}
          multiResponse={multiResponse}
          response={response}
          setMultiResponse={setMultiResponse}
          setResponse={setResponse}
        />

        {!feedback ? (
          <div className="study-deck-card-actions">
            <button className="study-deck-button-primary" disabled={!hasResponse} onClick={() => submit(false)} type="button">Check answer</button>
            <button className="study-deck-button-ghost" onClick={() => submit(true)} type="button">I don’t know</button>
          </div>
        ) : (
          <div className={`study-deck-feedback ${feedback.correct ? "study-deck-feedback-correct" : "study-deck-feedback-wrong"}`} aria-live="polite">
            <div className="study-deck-feedback-title">
              <Icon name={feedback.correct ? "check" : "warning"} size={19} />
              <strong>{feedback.correct ? "Correct" : feedback.dontKnow ? "Added for review" : "Not yet"}</strong>
            </div>
            <p><b>Answer:</b> {correctAnswerForMethod(card, method)}</p>
            <p>{card.explanation}</p>
            <p><b>Watch for:</b> {card.misconception}</p>
            <small><Icon name="sources" size={14} />{card.sourceCitation}</small>
            <div className="study-deck-card-actions">
              {!feedback.correct ? <button className="study-deck-button-primary" onClick={resetAnswer} type="button">Try again</button> : null}
              <button className="study-deck-button-ghost" disabled={index === available.length - 1} onClick={() => move(index + 1)} type="button">Next card</button>
            </div>
          </div>
        )}

        <footer className="study-deck-card-footer">
          <button disabled={index === 0} onClick={() => move(index - 1)} type="button"><Icon name="chevronLeft" size={16} />Back</button>
          <button onClick={() => { setIndex(0); resetAnswer(); }} type="button"><Icon name="reset" size={16} />Restart</button>
          <button disabled={index === available.length - 1} onClick={() => move(index + 1)} type="button">Skip forward<Icon name="chevronRight" size={16} /></button>
        </footer>
      </section>
    </div>
  );
}

function QuizPanel({ cards, deck, onErrorBook }) {
  const questionHeadingRef = useRef(null);
  const savedLevel = Number(deck?.coverage?.generationChallenge);
  const initialLevel = cardsForChallenge(cards, savedLevel).length ? savedLevel : firstSupportedLevel(cards);
  const savedCount = Number(deck?.coverage?.generationQuestionCount);
  const initialCount = Number.isInteger(savedCount) && savedCount >= 1 && savedCount <= 8
    ? savedCount
    : Math.min(8, Math.max(1, cards.length));
  const [level, setLevel] = useState(initialLevel);
  const [requestedCount, setRequestedCount] = useState(initialCount);
  const [minutes, setMinutes] = useState(60);
  const [questions, setQuestions] = useState(null);
  const [responses, setResponses] = useState({});
  const [index, setIndex] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [result, setResult] = useState(null);

  const finish = (force = false) => {
    if (!questions) return;
    const unanswered = questions.filter((card) => responses[card.id] === undefined).length;
    if (!force && unanswered && !window.confirm(`Submit with ${unanswered} unanswered question${unanswered === 1 ? "" : "s"}?`)) return;
    const nextResult = scoreQuiz(questions, responses, 80);
    onErrorBook?.((entries) => nextResult.items.reduce((book, item) => (
      item.correct
        ? resolveErrorBookEntry(book, {
          cardId: item.card.id,
          method: "flashcards",
          response: item.response,
        })
        : recordErrorBookEntry(book, {
          card: item.card,
          method: "flashcards",
          response: item.response === undefined ? "I don’t know" : item.response,
          reason: item.response === undefined ? "Unanswered timed-quiz question" : "Incorrect timed-quiz response",
        })
    ), entries));
    setResult(nextResult);
  };

  useEffect(() => {
    if (!questions || result) return undefined;
    if (secondsLeft <= 0) {
      finish(true);
      return undefined;
    }
    const timer = window.setInterval(() => setSecondsLeft((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [questions, result, secondsLeft]);

  useEffect(() => {
    if (questions && !result) questionHeadingRef.current?.focus({ preventScroll: true });
  }, [index, questions, result]);

  const start = () => {
    const next = buildQuiz(cards, level, requestedCount);
    setQuestions(next);
    setResponses({});
    setIndex(0);
    setSecondsLeft(minutes * 60);
    setResult(null);
  };

  const reset = () => {
    setQuestions(null);
    setResponses({});
    setResult(null);
    setIndex(0);
  };

  if (!questions) {
    const supported = cardsForChallenge(cards, level).length;
    return (
      <section className="study-deck-quiz-setup" aria-labelledby="study-quiz-title">
        <div className="study-deck-section-heading">
          <div><span className="study-deck-eyebrow">Timed assessment</span><h3 id="study-quiz-title">Build a source-backed quiz</h3></div>
          <span className="study-deck-pill">80% target</span>
        </div>
        <ChallengePicker cards={cards} onChange={setLevel} value={level} />
        <div className="study-deck-quiz-settings">
          <label><span>Requested questions</span><select onChange={(event) => setRequestedCount(Number(event.target.value))} value={requestedCount}>{[1, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25].map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
          <label><span>Time limit</span><select onChange={(event) => setMinutes(Number(event.target.value))} value={minutes}><option value="20">20 minutes</option><option value="40">40 minutes</option><option value="60">60 minutes</option></select></label>
        </div>
        <div className="study-deck-quiz-honesty">
          <Icon name="info" size={18} />
          <p><strong>{Math.min(requestedCount, supported)} unique questions available.</strong> {supported < requestedCount ? `${requestedCount - supported} requested questions are omitted because repetition and padding are disabled.` : "No duplicate questions will be used."}</p>
        </div>
        <button className="study-deck-button-primary study-deck-start-quiz" disabled={!supported} onClick={start} type="button">Start quiz</button>
      </section>
    );
  }

  if (result) {
    const copiedSummary = `Study Deck result: ${result.correct}/${questions.length} (${result.percentage}%). Recommendation: ${result.recommendation}.`;
    return (
      <section className="study-deck-results" aria-labelledby="study-results-title">
        <div className="study-deck-result-hero">
          <span>{result.percentage}%</span>
          <div><span className="study-deck-eyebrow">Quiz complete</span><h3 id="study-results-title">{result.recommendation === "advance" ? "Ready for the next supported challenge" : "Reinforce the missed topics"}</h3><p>{result.correct} correct · {result.answered} answered · {questions.length} total</p></div>
        </div>
        <p className="study-deck-recommendation"><Icon name="info" size={17} />This is a practice recommendation, not a claim that you have mastered the course material.</p>
        <div className="study-deck-topic-results">
          {result.topics.map((topic) => <div key={topic.topic}><strong>{topic.topic}</strong><span>{topic.correct}/{topic.total} · {topic.percentage}%</span></div>)}
        </div>
        <details className="study-deck-review-answers">
          <summary>Review all answers</summary>
          <ol>
            {result.items.map((item) => (
              <li className={item.correct ? "is-correct" : "is-wrong"} key={item.card.id}>
                <strong>{item.card.coreQuestion}</strong>
                <p>Your answer: {item.response === undefined ? "Unanswered" : item.card.abcd.choices[item.response]}</p>
                <p>Correct answer: {item.card.abcd.choices[item.card.abcd.correctIndex]}</p>
                <small>{item.card.explanation} · {item.card.sourceCitation}</small>
              </li>
            ))}
          </ol>
        </details>
        <div className="study-deck-card-actions">
          <button className="study-deck-button-primary" onClick={start} type="button">Retake</button>
          <button className="study-deck-button-ghost" onClick={() => navigator.clipboard?.writeText(copiedSummary)} type="button">Copy result</button>
          <button className="study-deck-button-ghost" onClick={reset} type="button">Return to setup</button>
        </div>
      </section>
    );
  }

  const current = questions[index];
  const minutesLeft = Math.floor(secondsLeft / 60);
  const clockSeconds = String(secondsLeft % 60).padStart(2, "0");
  return (
    <section className="study-deck-quiz-session" aria-labelledby="study-quiz-question">
      <header className="study-deck-quiz-bar">
        <div><span>Question {index + 1} of {questions.length}</span><strong role="timer">{minutesLeft}:{clockSeconds}</strong></div>
        <button onClick={() => finish(false)} type="button">Submit quiz</button>
      </header>
      <div className="study-deck-quiz-body">
        <aside className="study-deck-palette" aria-label="Question palette">
          {questions.map((card, questionIndex) => <button aria-label={`Question ${questionIndex + 1}${responses[card.id] === undefined ? ", unanswered" : ", answered"}`} aria-pressed={index === questionIndex} className={responses[card.id] === undefined ? "is-unanswered" : "is-answered"} key={card.id} onClick={() => setIndex(questionIndex)} type="button">{questionIndex + 1}</button>)}
        </aside>
        <div className="study-deck-quiz-question">
          <span className="study-deck-eyebrow">{current.topic}</span>
          <h3 id="study-quiz-question" ref={questionHeadingRef} tabIndex="-1">{current.coreQuestion}</h3>
          <fieldset className="study-deck-answer-group">
            <legend className="visually-hidden">Choose one answer</legend>
            {current.abcd.choices.map((choice, choiceIndex) => (
              <label key={choice}>
                <input checked={Number(responses[current.id]) === choiceIndex} name={`quiz-${current.id}`} onChange={() => setResponses((values) => ({ ...values, [current.id]: choiceIndex }))} type="radio" />
                <span><b>{String.fromCharCode(65 + choiceIndex)}</b><strong>{choice}</strong></span>
              </label>
            ))}
          </fieldset>
          <div className="study-deck-card-footer">
            <button disabled={index === 0} onClick={() => setIndex(index - 1)} type="button"><Icon name="chevronLeft" size={16} />Previous</button>
            <button disabled={index === questions.length - 1} onClick={() => setIndex(index + 1)} type="button">Next<Icon name="chevronRight" size={16} /></button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ErrorBookPanel({ cards, entries, onEntries, onPractice }) {
  const [filter, setFilter] = useState("unresolved");
  const visible = entries.filter((entry) => filter === "all" || (filter === "resolved" ? !entry.needsReview : entry.needsReview));
  return (
    <section className="study-deck-errors" aria-labelledby="study-errors-title">
      <div className="study-deck-section-heading">
        <div><span className="study-deck-eyebrow">Retry loop</span><h3 id="study-errors-title">Error Book</h3><p>One row per concept and practice mode. Correct retries resolve the same row without erasing its history.</p></div>
        <button className="study-deck-button-ghost" disabled={!entries.length} onClick={() => { if (window.confirm("Clear the saved Error Book for this deck?")) onEntries([]); }} type="button">Clear Error Book</button>
      </div>
      <div className="study-deck-filter" role="group" aria-label="Error Book filter">
        {["unresolved", "resolved", "all"].map((value) => <button aria-pressed={filter === value} key={value} onClick={() => setFilter(value)} type="button">{value[0].toUpperCase() + value.slice(1)} <span>{entries.filter((entry) => value === "all" || (value === "resolved" ? !entry.needsReview : entry.needsReview)).length}</span></button>)}
      </div>
      {!visible.length ? <StudyEmpty icon="flag" title="No matching review items">Wrong, unanswered, and “I don’t know” responses appear here for this deck.</StudyEmpty> : (
        <div className="study-deck-error-list">
          {visible.map((entry) => {
            const card = cards.find((item) => item.id === entry.cardId);
            return (
              <article className={entry.needsReview ? "needs-review" : "is-resolved"} key={entry.key}>
                <div className="study-deck-error-status"><span>{entry.needsReview ? "Needs review" : "Resolved"}</span><small>{entry.history.length} attempt{entry.history.length === 1 ? "" : "s"}</small></div>
                <h4>{entry.question}</h4>
                <p><b>Last response:</b> {displayPracticeResponse(card, entry.practiceMethod, entry.response)}</p>
                <p><b>Correct answer:</b> {entry.correctAnswer}</p>
                <small>{entry.source}</small>
                {entry.needsReview && card ? <button className="study-deck-button-primary" onClick={() => onPractice(card, entry.practiceMethod)} type="button">Try again now</button> : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ReviewPanel({ deckTitle, hasCards, onStart, start }) {
  const [alertsOn, setAlertsOn] = useState(false);
  const [notice, setNotice] = useState("");
  const announcedRef = useRef(new Set());
  const schedule = useMemo(() => buildReviewSchedule(start), [start]);

  useEffect(() => {
    if (!alertsOn) return undefined;
    const check = () => {
      const now = Date.now();
      const due = schedule.find((item) => Math.abs(item.date.getTime() - now) < 60_000 && !announcedRef.current.has(item.id));
      if (due) {
        announcedRef.current.add(due.id);
        setNotice(`Review check-in: ${due.label}. Open Practice when you are ready.`);
      }
    };
    check();
    const timer = window.setInterval(check, 30_000);
    return () => window.clearInterval(timer);
  }, [alertsOn, schedule]);

  return (
    <section className="study-deck-reviews" aria-labelledby="study-reviews-title">
      <div className="study-deck-section-heading">
        <div><span className="study-deck-eyebrow">Spaced active recall</span><h3 id="study-reviews-title">Review check-ins</h3><p>Suggested at 4 hours, then 1, 3, 7, 14, and 30 days. Quiet-hour events move to 9:00 AM.</p></div>
      </div>
      <div className="study-deck-review-controls">
        <label><span>Start from</span><input onChange={(event) => onStart(event.target.value)} type="datetime-local" value={start} /></label>
        <button aria-pressed={alertsOn} className={alertsOn ? "study-deck-button-primary" : "study-deck-button-ghost"} onClick={() => setAlertsOn((value) => !value)} type="button"><Icon name="bell" size={17} />{alertsOn ? "In-tab alerts on" : "Turn on in-tab alerts"}</button>
        <button className="study-deck-button-ghost" disabled={!hasCards || !schedule.length} onClick={() => downloadText(`${safeFileStem(deckTitle)}-reviews.ics`, buildReviewCalendar(schedule, `${deckTitle} active-recall review`), "text/calendar;charset=utf-8")} title={hasCards ? "Download this deck's review schedule" : "Import a non-empty deck before exporting a review calendar"} type="button"><Icon name="download" size={17} />Download calendar</button>
      </div>
      <p className="study-deck-review-limit"><Icon name="info" size={16} />In-tab alerts work only while this dashboard tab stays open. The schedule is a practical heuristic, not a personalized scientific prediction.</p>
      <div className="study-deck-review-timeline">
        {schedule.map((item, index) => <article key={item.id}><span>{index + 1}</span><div><strong>{item.label}</strong><p>{formatReviewDate(item.date)}</p></div></article>)}
      </div>
      <div aria-live="polite" className="study-deck-live-notice">{notice}</div>
    </section>
  );
}

function formatSourceSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "Size not stated";
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KiB`;
  return `${Math.round(size / (1024 * 102.4)) / 10} MiB`;
}

function GenerationSetup({ activeCourse, onChange, settings }) {
  const focusId = useId();
  const countId = useId();
  const challengeId = useId();
  return (
    <section className="study-deck-generation-setup" aria-labelledby="study-generation-setup-title">
      <div className="study-deck-generation-setup-heading">
        <div><span className="study-deck-eyebrow">Generation setup</span><h3 id="study-generation-setup-title">Shape the next Practice or Quiz deck</h3></div>
        <span className="study-deck-pill">Saved per course</span>
      </div>
      <div className="study-deck-generation-fields">
        <label className="study-deck-generation-focus" htmlFor={focusId}><span>Study focus</span><input disabled={!activeCourse} id={focusId} maxLength={240} onChange={(event) => onChange({ focus: event.target.value })} placeholder="What should this deck help you learn?" type="text" value={settings.focus} /></label>
        <label htmlFor={countId}><span>Questions</span><select disabled={!activeCourse} id={countId} onChange={(event) => onChange({ questionCount: Number(event.target.value) })} value={settings.questionCount}>{[1, 2, 3, 4, 5, 6, 7, 8].map((count) => <option key={count} value={count}>{count}</option>)}</select></label>
        <label htmlFor={challengeId}><span>Challenge</span><select disabled={!activeCourse} id={challengeId} onChange={(event) => onChange({ challenge: Number(event.target.value) })} value={settings.challenge}>{CHALLENGE_LEVELS.map((item) => <option key={item.level} value={item.level}>{item.level} · {item.title}</option>)}</select></label>
      </div>
      <p><Icon name="info" size={15} />Challenge is a generation target. AI-assisted drafts remain unaudited; the browser-only fallback creates extractive recall cards and cannot guarantee analytical Challenge 6 quality.</p>
    </section>
  );
}

function SourcesPanel({
  activeCourse,
  activeDeck,
  generationNotice,
  generationStatus,
  onAddSourceFiles,
  onRemoveSourceFile,
  onSourcesChanged,
  sourceLibrary,
  sourceUploadStatus,
}) {
  const inputId = useId();
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [notice, setNotice] = useState(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const statusName = typeof sourceUploadStatus === "string"
    ? sourceUploadStatus
    : sourceUploadStatus?.state || sourceUploadStatus?.status || "idle";
  const statusMessage = typeof sourceUploadStatus === "object" ? sourceUploadStatus?.message : "";
  const externallyBusy = ["loading", "uploading", "saving", "removing"].includes(statusName);
  const generationState = generationStatus?.state || "idle";
  const generating = ["extracting", "generating"].includes(generationState);
  const busy = localBusy || externallyBusy || generating;
  const records = (Array.isArray(sourceLibrary) ? sourceLibrary : []).filter((record) => (
    record?.courseSpaceId === activeCourse.id
  ));

  const chooseFiles = (fileList) => {
    if (busy) return;
    const candidates = [...(fileList || [])];
    const batch = candidates.slice(0, MAX_SOURCE_BATCH);
    const supported = batch.filter((file) => {
      const extension = String(file?.name || "").split(".").pop().toLocaleLowerCase("en-US");
      return SOURCE_EXTENSIONS.has(extension) && Number(file?.size) <= MAX_SOURCE_BYTES;
    });
    const rejected = candidates.length - supported.length;
    setSelectedFiles(supported);
    setNotice(rejected ? {
      type: "error",
      text: `${rejected} file${rejected === 1 ? " was" : "s were"} skipped. Use PDF, DOC, DOCX, or TXT files no larger than 20 MiB, with at most 20 files in one batch.`,
    } : null);
  };

  const saveFiles = async () => {
    if (!selectedFiles.length || busy) return;
    if (typeof onAddSourceFiles !== "function") {
      setNotice({ type: "error", text: "Source storage is not connected in this dashboard build. No files were saved." });
      return;
    }
    setLocalBusy(true);
    setNotice(null);
    try {
      const result = await onAddSourceFiles(selectedFiles, {
        deckId: activeDeck.id,
        courseSpaceId: activeCourse.id,
        courseCode: activeCourse.code || activeCourse.name,
        courseId: activeCourse.id,
      });
      const failed = Array.isArray(result?.failed) ? result.failed.length : Number(result?.failed || 0);
      const saved = Array.isArray(result?.saved) ? result.saved.length : Number(result?.saved || 0);
      const fullyConfirmed = result === true || result && typeof result === "object" && failed === 0 && saved >= selectedFiles.length;
      if (fullyConfirmed) {
        onSourcesChanged?.();
        setSelectedFiles([]);
        if (inputRef.current) inputRef.current.value = "";
        setNotice({
          type: "success",
          text: "Source files saved to this course. Existing imported decks are now marked as potentially stale; no cards or progress were changed. Files are not parsed or added to tested scope until their content is reviewed and mapped to canonical cards.",
        });
      } else if (failed > 0) {
        if (saved > 0) onSourcesChanged?.();
        if (Array.isArray(result?.failed)) setSelectedFiles(result.failed);
        setNotice({
          type: "error",
          text: `${saved} source file${saved === 1 ? " was" : "s were"} saved and imported decks were marked potentially stale; ${failed} failed. No cards or progress changed. Only the failed file${failed === 1 ? " remains" : "s remain"} selected for a safe retry.`,
        });
      } else {
        setNotice({ type: "error", text: "Source storage did not confirm that every selected file was saved. The selection is preserved; reload the library before retrying." });
      }
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "The source files could not be saved." });
    } finally {
      setLocalBusy(false);
    }
  };

  const removeSource = async (record) => {
    if (typeof onRemoveSourceFile !== "function" || busy) return;
    const name = sourceLabel(record);
    const removalScope = record?.storageScope === "account"
      ? "This removes it from your private account and synced devices."
      : "This removes it from this browser only.";
    if (!window.confirm(`Remove “${name}” from the private source library? ${removalScope} Imported cards, quizzes, and progress will remain unchanged, but imported decks in this course will be marked as potentially stale. This cannot be undone.`)) return;
    setRemovingId(record?.id || name);
    setNotice(null);
    try {
      const removed = await onRemoveSourceFile(record);
      if (removed) {
        onSourcesChanged?.();
        setNotice({ type: "success", text: `${name} was removed. Existing cards and progress were not changed; imported decks are now marked as potentially stale until you review and re-import an updated canonical deck.` });
      }
      else setNotice({ type: "error", text: `${name} was not removed. Reload the library before trying again.` });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "The source file could not be removed." });
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <section className="study-deck-sources" aria-labelledby="study-sources-title">
      <div className="study-deck-section-heading">
        <div>
          <span className="study-deck-eyebrow">Private source library</span>
          <h3 id="study-sources-title">Material Sources</h3>
          <p>Store readings, study guides, or exam materials for {activeCourse.name}. Files stay private until you explicitly choose a generation action.</p>
        </div>
        <span className="study-deck-pill">{records.length} stored</span>
      </div>

      <div className="study-deck-source-upload-grid">
        <div className="study-deck-source-upload">
          <input
            accept={SOURCE_ACCEPT}
            disabled={busy}
            id={inputId}
            multiple
            onChange={(event) => chooseFiles(event.target.files)}
            ref={inputRef}
            type="file"
          />
          <label
            aria-disabled={busy}
            className={`${dragging ? "is-dragging" : ""}${busy ? " is-disabled" : ""}`.trim()}
            htmlFor={inputId}
            onDragEnter={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
            onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
            onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
            onDrop={(event) => { event.preventDefault(); setDragging(false); if (!busy) chooseFiles(event.dataTransfer.files); }}
          >
            <span><Icon name="upload" size={24} /></span>
            <strong>Drop source files here or choose files</strong>
            <small>PDF, DOC, DOCX, or TXT · 20 MiB each · up to 20 per batch</small>
          </label>
          {selectedFiles.length ? (
            <ul className="study-deck-source-selection" aria-label="Files ready to save">
              {selectedFiles.map((file) => <li key={`${file.name}:${file.size}`}><span>{file.name}</span><small>{formatSourceSize(file.size)}</small></li>)}
            </ul>
          ) : null}
          <button className="study-deck-button-primary" disabled={!selectedFiles.length || busy || typeof onAddSourceFiles !== "function"} onClick={saveFiles} type="button">
            <Icon name="upload" size={17} />{statusName === "loading" ? "Loading library…" : busy && statusName !== "removing" ? "Saving…" : selectedFiles.length ? `Save ${selectedFiles.length} source${selectedFiles.length === 1 ? "" : "s"}` : "Save sources"}
          </button>
          {typeof onAddSourceFiles !== "function" ? <p className="study-deck-source-connection"><Icon name="info" size={16} />The source-library connection is unavailable. The file picker will not save anything.</p> : null}
        </div>

        <div className="study-deck-source-library">
          <h4>Stored for {activeCourse.code || activeCourse.name}</h4>
          {!records.length ? <StudyEmpty icon="book" title="No source files stored">Upload at least one source before generating a draft Practice or Quiz deck.</StudyEmpty> : (
            <ul>
              {records.map((record) => {
                const recordId = record?.id || sourceLabel(record);
                const isRemoving = removingId === recordId || sourceUploadStatus?.removingId === recordId;
                return (
                  <li key={recordId}>
                    <span className="study-deck-source-file-icon"><Icon name="document" size={19} /></span>
                    <div><strong>{sourceLabel(record)}</strong><small>{record?.typeLabel || "FILE"} · {formatSourceSize(record?.sizeBytes ?? record?.size)} · {sourceStatusLabel(record)} · {sourceAddedLabel(record)}</small></div>
                    {typeof onRemoveSourceFile === "function" ? <button disabled={busy} onClick={() => removeSource(record)} type="button">{isRemoving ? "Removing…" : "Remove"}</button> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="study-deck-source-boundary"><Icon name="warning" size={17} /><p><strong>Generation is explicit and produces an unaudited draft.</strong> Practice works privately in this browser without chat AI. If Conversational AI is enabled, Semester Board asks before sending bounded excerpts to the configured provider; original files are never sent. Adding, replacing, or removing a file never silently edits cards, quizzes, or progress. Legacy DOC files must be converted to DOCX, PDF, or TXT before generation.</p></div>
      {generationStatus?.message || generationNotice || statusMessage || notice ? (
        <div
          className={`study-deck-import-notice is-${generationNotice?.type || notice?.type || (generationState === "error" || statusName === "error" ? "error" : "success")}`}
          role={generationNotice?.type === "error" || notice?.type === "error" || generationState === "error" || statusName === "error" ? "alert" : "status"}
        >
          {generationNotice?.text || generationStatus?.message || notice?.text || statusMessage}
        </div>
      ) : null}
    </section>
  );
}

function MediaLabPanel() {
  const inputId = useId();
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState("");
  const [cues, setCues] = useState([]);
  const [response, setResponse] = useState("");
  const [checked, setChecked] = useState(false);
  const [hint, setHint] = useState(false);

  useEffect(() => {
    if (!file) { setUrl(""); return undefined; }
    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  const words = response.trim() ? response.trim().split(/\s+/).length : 0;
  const type = file?.type?.split("/")[0];
  return (
    <section className="study-deck-lab" aria-labelledby="study-lab-title">
      <div className="study-deck-section-heading">
        <div><span className="study-deck-eyebrow">Device-only workspace</span><h3 id="study-lab-title">Multimedia analysis lab</h3><p>Observe an image, audio clip, or video without uploading it or inventing a grade.</p></div>
        <span className="study-deck-pill study-deck-pill-warn">Ungraded observation mode</span>
      </div>
      <div className="study-deck-lab-grid">
        <div className="study-deck-media-stage">
          {url && type === "image" ? <img alt={`Local study media: ${file.name}`} src={url} /> : null}
          {url && type === "audio" ? <audio controls src={url}>Your browser cannot play this audio.</audio> : null}
          {url && type === "video" ? <video controls src={url}>Your browser cannot play this video.</video> : null}
          {!url ? <StudyEmpty icon="lab" title="Choose local media">Supported by your browser: images, audio, and video. The file stays on this device.</StudyEmpty> : null}
          <input accept="image/*,audio/*,video/*" id={inputId} onChange={(event) => { setFile(event.target.files?.[0] || null); setChecked(false); setResponse(""); setCues([]); }} type="file" />
          <label className="study-deck-button-primary" htmlFor={inputId}><Icon name="upload" size={17} />{file ? "Replace media" : "Choose media"}</label>
          {file ? <small>{file.name} · not uploaded or saved</small> : null}
        </div>
        <div className="study-deck-lab-notes">
          <fieldset>
            <legend>Observation cues</legend>
            {["Pattern or structure", "Evidence you can point to", "Uncertainty or missing context"].map((cue) => <label key={cue}><input checked={cues.includes(cue)} onChange={() => setCues((values) => values.includes(cue) ? values.filter((value) => value !== cue) : [...values, cue])} type="checkbox" />{cue}</label>)}
          </fieldset>
          <label><span>What do you notice, and what evidence supports it?</span><textarea onChange={(event) => { setResponse(event.target.value); setChecked(false); }} placeholder="Describe only what the media supports…" rows="7" value={response} /><small>{words} words</small></label>
          {hint ? <p className="study-deck-lab-hint">Start with one visible or audible detail, then separate your interpretation from that evidence.</p> : null}
          <div className="study-deck-card-actions">
            <button className="study-deck-button-primary" disabled={!file || !response.trim()} onClick={() => setChecked(true)} type="button">Check response</button>
            <button className="study-deck-button-ghost" onClick={() => setHint((value) => !value)} type="button">{hint ? "Hide hint" : "Show hint"}</button>
            <button className="study-deck-button-ghost" onClick={() => { setResponse("I don’t know yet."); setChecked(true); }} type="button">I don’t know</button>
          </div>
          {checked ? <div className="study-deck-lab-feedback" role="status"><Icon name="info" size={18} /><p><strong>Saved nowhere; not graded.</strong> {cues.length ? `You used ${cues.length} observation cue${cues.length === 1 ? "" : "s"}.` : "Try selecting at least one observation cue."} A matching source rubric is required before this can be scored.</p></div> : null}
        </div>
      </div>
    </section>
  );
}

function CourseSpaceForm({ initialCourse = null, onCancel, onSave, submitLabel }) {
  const [name, setName] = useState(initialCourse?.name || "");
  const [code, setCode] = useState(initialCourse?.code || "");
  const [notice, setNotice] = useState("");

  const submit = (event) => {
    event.preventDefault();
    const nextName = safePublicText(name, "", 80);
    const nextCode = safePublicText(code, "", 32);
    if (!nextName) {
      setNotice("Course name is required.");
      return;
    }
    onSave({ code: nextCode, name: nextName });
  };

  return (
    <form className="study-deck-course-form" onSubmit={submit}>
      <label><span>Course name</span><input autoFocus={!initialCourse} maxLength="80" onChange={(event) => setName(event.target.value)} placeholder="e.g. General Biology" value={name} /></label>
      <label><span>Course code <small>optional</small></span><input maxLength="32" onChange={(event) => setCode(event.target.value)} placeholder="e.g. BIO 101" value={code} /></label>
      <div className="study-deck-course-form-actions">
        <button className="study-deck-button-primary" type="submit"><Icon name={initialCourse ? "check" : "plus"} size={16} />{submitLabel}</button>
        {onCancel ? <button className="study-deck-button-ghost" onClick={onCancel} type="button">Cancel</button> : null}
      </div>
      {notice ? <p role="alert">{notice}</p> : null}
    </form>
  );
}

function CourseSpaceManager({ activeCourseId, courses, onAdd, onArchive, onRename, onRestore, onSelect }) {
  const activeCourses = courses.filter((course) => !course.archived);
  const archivedCourses = courses.filter((course) => course.archived);
  const activeCourse = activeCourses.find((course) => course.id === activeCourseId) || null;
  const canAddCourse = courses.length < MAX_COURSE_SPACES;
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    setRenaming(false);
  }, [activeCourseId]);

  const saveNewCourse = (input) => {
    onAdd(input);
    setCreating(false);
  };

  return (
    <section className="study-deck-courses" aria-labelledby="study-courses-title">
      <div className="study-deck-courses-heading">
        <div><span className="study-deck-eyebrow">Separate study spaces</span><h3 id="study-courses-title">Your courses</h3><p>Sources, decks, quizzes, progress, and exports stay inside the course where you add them.</p></div>
        <button className="study-deck-button-primary" disabled={!canAddCourse} onClick={() => { setCreating(true); setRenaming(false); }} title={canAddCourse ? "Create a separate course space" : `A profile can hold ${MAX_COURSE_SPACES} course spaces, including archived courses.`} type="button"><Icon name="plus" size={16} />Add course</button>
      </div>

      {activeCourses.length ? (
        <div className="study-deck-course-strip" role="group" aria-label="Active courses">
          {activeCourses.map((course) => (
            <button aria-pressed={course.id === activeCourseId} key={course.id} onClick={() => onSelect(course.id)} type="button">
              <span>{course.code || "Course"}</span><strong>{course.name}</strong>
            </button>
          ))}
        </div>
      ) : (
        <div className="study-deck-first-course">
          <span><Icon name="book" size={24} /></span>
          <div><strong>Create your first course space</strong><p>New profiles begin empty. A course gives its sources, decks, quizzes, and progress a private boundary.</p></div>
          {!creating && canAddCourse ? <button className="study-deck-button-primary" onClick={() => setCreating(true)} type="button"><Icon name="plus" size={16} />Create first course</button> : null}
        </div>
      )}

      {creating && canAddCourse ? <CourseSpaceForm onCancel={activeCourses.length ? () => setCreating(false) : null} onSave={saveNewCourse} submitLabel="Create course" /> : null}

      {activeCourse && !creating ? (
        <div className="study-deck-course-manage">
          <div><span>Open course</span><strong>{activeCourse.name}</strong><small>{activeCourse.code || "No course code"}</small></div>
          <div>
            <button className="study-deck-button-ghost" onClick={() => setRenaming((value) => !value)} type="button"><Icon name="edit" size={15} />Rename</button>
            <button className="study-deck-course-archive" onClick={() => onArchive(activeCourse)} type="button">Archive</button>
          </div>
        </div>
      ) : null}
      {activeCourse && renaming && !creating ? <CourseSpaceForm initialCourse={activeCourse} onCancel={() => setRenaming(false)} onSave={(input) => { onRename(activeCourse.id, input); setRenaming(false); }} submitLabel="Save changes" /> : null}

      {archivedCourses.length ? (
        <details className="study-deck-archived-courses">
          <summary>Archived courses <span>{archivedCourses.length}</span></summary>
          <div>
            {archivedCourses.map((course) => (
              <article key={course.id}><div><strong>{course.name}</strong><small>{course.code || "No course code"} · sources and progress preserved</small></div><button className="study-deck-button-ghost" onClick={() => onRestore(course.id)} type="button">Restore</button></article>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function DeckPicker({ activeDeckId, customDecks, deckSourceRevisionByDeck, genericDeck, onSelect, sourceRevision }) {
  return (
    <section className="study-deck-picker" aria-labelledby="study-deck-picker-title">
      <div className="study-deck-picker-heading">
        <div><span className="study-deck-eyebrow">Course and deck</span><h3 id="study-deck-picker-title">Choose what to study</h3></div>
        <small>Every profile starts blank. Only decks imported into this profile appear here.</small>
      </div>
      <div className="study-deck-picker-grid" role="group" aria-label="Available study decks">
        <button aria-pressed={activeDeckId === genericDeck.id} className="is-generic" onClick={() => onSelect(genericDeck.id)} type="button">
          <span><strong>Blank deck workspace</strong><small>Attach private sources or import canonical-card JSON for this course</small></span>
          <b>Blank</b>
        </button>
        {customDecks.map((deck) => {
          const stale = sourceRevision > Number(deckSourceRevisionByDeck?.[deck.id] || 0);
          const generated = ["ai-assisted", "local-extractive"].includes(deck.generationOrigin);
          const generationLabel = deck.generationOrigin === "local-extractive"
            ? "Private browser draft · citations unaudited"
            : "AI-generated draft · citations unaudited";
          return (
            <button aria-pressed={activeDeckId === deck.id} className={`is-custom${stale ? " is-stale" : ""}`} key={deck.id} onClick={() => onSelect(deck.id)} type="button">
              <span><strong>{deck.title}</strong><small>{deck.cards.length} structurally valid cards · {stale ? "sources changed; review needed" : generated ? generationLabel : "citations unaudited"}</small></span>
              <b>{stale ? "Needs review" : generated ? "Draft" : "Custom"}</b>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function CoveragePanel({ deck, importNotice, isImported, onImportDeck, onImportNotice, onRemoveCustom }) {
  const importId = useId();
  const importDeck = async (file) => {
    if (!file) return;
    try {
      if (Number(file.size) > MAX_CUSTOM_DECK_FILE_BYTES) {
        onImportNotice({ type: "error", text: "Import stopped: canonical deck JSON must be 700 KiB or smaller so the profile stays within the dashboard cloud payload limit." });
        return;
      }
      const parsed = JSON.parse(await file.text());
      const nextCards = Array.isArray(parsed) ? parsed : parsed.cards;
      const errors = validateStudyDeck(nextCards);
      if (errors.length) {
        onImportNotice({ type: "error", text: `Import stopped: ${errors.slice(0, 4).join(" ")}` });
        return;
      }
      if (nextCards.length > 200) {
        onImportNotice({ type: "error", text: "Import stopped: a custom deck can contain at most 200 canonical cards." });
        return;
      }
      const safeCards = sanitizeImportedCards(nextCards);
      const title = safePublicText(Array.isArray(parsed) ? "Imported study deck" : parsed.title, "Imported study deck", 96);
      const result = onImportDeck({
        cards: safeCards,
        title,
        courseId: Array.isArray(parsed) ? null : safePublicText(parsed.courseId, "", 96) || null,
        courseCode: Array.isArray(parsed) ? null : safePublicText(parsed.courseCode, "", 40) || null,
        coverage: Array.isArray(parsed) ? null : sanitizeCoverage(parsed.coverage, safeCards),
        sourceManifest: Array.isArray(parsed) ? [] : sanitizeSourceManifest(parsed.sourceManifest),
      });
      if (result?.ok === false) {
        onImportNotice({ type: "error", text: result.message });
        return;
      }
      onImportNotice({ type: "success", text: result?.message || `${safeCards.length} structurally valid canonical cards were saved to this course. Their claims and citations remain user-provided and unaudited.` });
    } catch (error) {
      onImportNotice({ type: "error", text: `Import stopped: ${error instanceof Error ? error.message : "invalid JSON"}` });
    }
  };

  const cards = deck.cards || [];
  const coverage = deck.coverage || {};
  const manifest = Array.isArray(deck.sourceManifest)
    ? deck.sourceManifest
    : Array.isArray(deck.sourceManifest?.entries)
      ? deck.sourceManifest.entries
      : [];
  const levelCounts = Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
    const level = index + 1;
    const explicit = Number(coverage.levelCounts?.[level]);
    return [level, Number.isFinite(explicit) ? explicit : cards.filter((card) => card.level === level).length];
  }));
  const exactPromptCounts = coverage.promptCount !== null
    && coverage.promptCount !== undefined
    && Number.isFinite(Number(coverage.promptCount));
  const summary = exactPromptCounts ? [
    { value: cards.length, label: "canonical cards" },
    { value: Number(coverage.promptCount), label: "tested prompts" },
    { value: coverage.mappedPromptCount === null || coverage.mappedPromptCount === undefined ? "Unknown" : Number(coverage.mappedPromptCount), label: "grounded / mapped" },
    { value: coverage.partialPromptCount === null || coverage.partialPromptCount === undefined ? "Unknown" : Number(coverage.partialPromptCount), label: "partial prompts" },
    { value: coverage.blockedPromptCount === null || coverage.blockedPromptCount === undefined ? "Unknown" : Number(coverage.blockedPromptCount), label: "blocked prompts" },
  ] : [
    { value: cards.length, label: "canonical cards" },
    { value: new Set(cards.map((card) => card.topic)).size, label: "covered topics" },
    { value: Object.values(levelCounts).filter((count) => count > 0).length, label: "supported levels" },
    { value: 0, label: "fabricated filler cards" },
  ];
  const guideCoverage = Array.isArray(coverage.guideCoverage) ? coverage.guideCoverage : [];
  const promptGaps = Array.isArray(coverage.blockedPrompts) ? coverage.blockedPrompts : [];
  const wordingNotes = Array.isArray(coverage.ambiguities) ? coverage.ambiguities : [];
  const included = Array.isArray(coverage.included) ? coverage.included : [];
  const partial = Array.isArray(coverage.partiallySupported) ? coverage.partiallySupported : [];
  const missing = Array.isArray(coverage.missing) ? coverage.missing : [];
  const traceLabels = manifest.length
    ? [...new Set(manifest.map(sourceLabel).filter(Boolean))]
    : [...new Set(cards.map((card) => sourceShort(card.sourceCitation)).filter(Boolean))];
  const manifestIds = new Set(manifest.map((source) => safeOpaqueIdentifier(source?.id)).filter(Boolean));
  const cardsWithSourceRefs = cards.filter((card) => Array.isArray(card.sourceRefs) && card.sourceRefs.length).length;
  const referencedManifestIds = new Set(cards.flatMap((card) => (
    Array.isArray(card.sourceRefs) ? card.sourceRefs.map(safeOpaqueIdentifier).filter(Boolean) : []
  )));
  const unresolvedSourceRefs = [...referencedManifestIds].filter((sourceId) => !manifestIds.has(sourceId));

  return (
    <section className="study-deck-coverage" aria-labelledby="study-coverage-title">
      <div className="study-deck-section-heading">
        <div><span className="study-deck-eyebrow">Evidence boundary</span><h3 id="study-coverage-title">Coverage map</h3><p>{deck.title} contains {cards.length} canonical cards. The same records power every practice method, the timed quiz, and the Anki export.</p></div>
        <span className="study-deck-pill">{isImported ? "User-provided · unaudited" : "No active deck"}</span>
      </div>
      <div className="study-deck-coverage-summary">
        {summary.map((item) => <article key={item.label}><strong>{item.value}</strong><span>{item.label}</span></article>)}
      </div>

      <div className="study-deck-level-coverage" aria-label="Canonical cards by challenge level">
        {Object.entries(levelCounts).map(([level, count]) => <span className={count ? "is-supported" : ""} key={level}><b>L{level}</b><strong>{count}</strong></span>)}
      </div>

      {isImported ? (
        <div className="study-deck-imported-boundary"><Icon name="warning" size={18} /><p><strong>Imported coverage is not audited.</strong> The file passed structural validation, but Semester Board has not verified its claims or citations against the named sources.</p></div>
      ) : null}

      {guideCoverage.length ? (
        <div className="study-deck-guide-coverage">
          <div className="study-deck-guide-coverage-heading"><h4>Tested-prompt ledger</h4><span>{coverage.mappedPromptCount ?? cards.length} grounded · {coverage.partialPromptCount ?? 0} partial · {coverage.blockedPromptCount ?? 0} blocked</span></div>
          <div>
            {guideCoverage.map((guide) => (
              <article className="is-partial" key={guide.guideId || guide.label}>
                <span>{isImported ? "Imported ledger" : "Source ledger"}</span>
                <strong>{guide.label || "Untitled guide"}</strong>
                <small>{Number(guide.mappedPromptCount || 0)} grounded · {Number(guide.partialPromptCount || 0)} partial · {Number(guide.blockedPromptCount || 0)} blocked of {Number(guide.promptCount || 0)}</small>
              </article>
            ))}
          </div>
          <p className="study-deck-scope-rule"><Icon name="info" size={16} />{coverage.scopeRule || "Explicit study and exam materials define tested scope."}</p>
        </div>
      ) : (
        <div className="study-deck-coverage-grid">
          <article className="is-included"><span>Included</span><ul>{included.length ? included.map((item) => <li key={item}>{item}</li>) : <li>Canonical card structure and source labels supplied by this deck.</li>}</ul></article>
          <article className="is-partial"><span>Partial evidence</span><ul>{partial.length ? partial.map((item) => <li key={item}>{item}</li>) : <li>No separate partial-evidence list was supplied.</li>}</ul></article>
          <article className="is-missing"><span>Sources still needed</span><ul>{missing.length ? missing.map((item) => <li key={item}>{item}</li>) : <li>No additional source gap was stated.</li>}</ul></article>
        </div>
      )}

      {coverage.partialSourceFiles?.length || coverage.blockedSourceFiles?.length ? (
        <div className="study-deck-source-blockers">
          {coverage.partialSourceFiles?.length ? <article><strong>Partially readable sources · {coverage.partialSourceFiles.length}</strong><ul>{coverage.partialSourceFiles.map((source) => <li key={sourceLabel(source)}>{sourceLabel(source)}{source?.reason ? ` — ${source.reason}` : ""}</li>)}</ul></article> : null}
          {coverage.blockedSourceFiles?.length ? <article><strong>Blocked sources · {coverage.blockedSourceFiles.length}</strong><ul>{coverage.blockedSourceFiles.map((source) => <li key={sourceLabel(source)}>{sourceLabel(source)}</li>)}</ul></article> : null}
        </div>
      ) : null}

      {promptGaps.length ? (
        <details className="study-deck-prompt-gaps">
          <summary>{promptGaps.filter((prompt) => prompt.status === "partial").length} partial and {promptGaps.filter((prompt) => prompt.status === "blocked").length} blocked prompt records</summary>
          <ul>
            {promptGaps.map((prompt) => (
              <li key={`${prompt.promptId}:${prompt.status}`}>
                <span>{prompt.status}</span>
                <strong>{prompt.promptId} · {prompt.topic}</strong>
                <p>{prompt.reason}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {wordingNotes.length ? (
        <details className="study-deck-prompt-gaps is-note">
          <summary>{wordingNotes.length} source-wording note{wordingNotes.length === 1 ? "" : "s"}</summary>
          <ul>
            {wordingNotes.map((item) => (
              <li key={`${item.promptId}:${item.sourceFile}`}>
                <span>source note</span>
                <strong>{item.promptId} · {item.sourceFile}{item.sourcePage === null ? "" : ` · p. ${item.sourcePage}`}</strong>
                <p>{item.note}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="study-deck-source-list">
        <h4>Current source trace</h4>
        {cardsWithSourceRefs ? (
          <p className="study-deck-source-reference-summary">
            <strong>{cardsWithSourceRefs} of {cards.length} cards</strong> retain exact manifest references across {referencedManifestIds.size} cited source{referencedManifestIds.size === 1 ? "" : "s"}; {unresolvedSourceRefs.length} reference{unresolvedSourceRefs.length === 1 ? " is" : "s are"} unresolved.
          </p>
        ) : null}
        {traceLabels.length ? traceLabels.map((source) => <span key={source}><Icon name="sources" size={15} />{source}</span>) : <p>No source labels are active. Attach files in Sources or import a canonical deck with public source labels.</p>}
      </div>
      <div className="study-deck-import-box">
        <div><h4>Review and update this course deck</h4><p>Download the schema, fill it only from this course’s real sources, then import canonical-card JSON. Valid imports stay in this course and are never presented as independently audited.</p></div>
        <div className="study-deck-import-actions">
          <button className="study-deck-button-ghost" onClick={() => downloadText("study-deck-template.json", JSON.stringify(deckTemplate(), null, 2), "application/json;charset=utf-8")} type="button"><Icon name="download" size={17} />Download JSON template</button>
          <input accept="application/json,.json" id={importId} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; importDeck(file); }} type="file" />
          <label className="study-deck-button-primary" htmlFor={importId}><Icon name="upload" size={17} />Import canonical JSON</label>
          {isImported ? <button className="study-deck-button-ghost" onClick={onRemoveCustom} type="button"><Icon name="close" size={17} />Remove custom deck</button> : null}
        </div>
      </div>
      {importNotice ? <div className={`study-deck-import-notice is-${importNotice.type}`} role={importNotice.type === "error" ? "alert" : "status"}>{importNotice.text}</div> : null}
    </section>
  );
}

export default function StudyDeckPage({
  confirmStudyGeneration = (message) => window.confirm(message),
  generationAccessStatus = "unavailable",
  generationStatus = { state: "idle", message: "" },
  onAddSourceFiles,
  onGenerateStudyDeck,
  onRemoveSourceFile,
  onStudyDeckState,
  sourceLibrary = [],
  sourceUploadStatus = "idle",
  studyDeckState,
}) {
  const [tool, setTool] = useState("sources");
  const [fallbackState, setFallbackState] = useState(EMPTY_STUDY_DECK_STATE);
  const [importNotice, setImportNotice] = useState(null);
  const [generationNotice, setGenerationNotice] = useState(null);
  const [retryTarget, setRetryTarget] = useState(null);

  const savedState = studyDeckState && typeof studyDeckState === "object"
    ? { ...EMPTY_STUDY_DECK_STATE, ...studyDeckState }
    : fallbackState;
  const persistStudyDeck = useCallback((update) => {
    const apply = (current) => {
      const base = current && typeof current === "object"
        ? { ...EMPTY_STUDY_DECK_STATE, ...current }
        : { ...EMPTY_STUDY_DECK_STATE };
      return typeof update === "function" ? update(base) : { ...base, ...update };
    };
    if (typeof onStudyDeckState === "function") onStudyDeckState(apply);
    else setFallbackState(apply);
  }, [onStudyDeckState]);

  const courses = useMemo(() => normalizedCourseSpaces(savedState.courseSpaces), [savedState.courseSpaces]);
  const activeCourses = useMemo(() => courses.filter((course) => !course.archived), [courses]);
  const activeCourse = useMemo(() => (
    activeCourses.find((course) => course.id === savedState.selectedCourseSpaceId)
    || activeCourses[0]
    || null
  ), [activeCourses, savedState.selectedCourseSpaceId]);
  const genericDeck = useMemo(() => activeCourse ? genericDeckForCourse(activeCourse) : null, [activeCourse]);
  const allCustomDecks = useMemo(() => normalizedCustomDecks(savedState.customDecks), [savedState.customDecks]);
  const customDecks = useMemo(() => activeCourse
    ? allCustomDecks.filter((deck) => deck.courseSpaceId === activeCourse.id)
    : [], [activeCourse, allCustomDecks]);
  const decks = useMemo(() => genericDeck ? [genericDeck, ...customDecks] : [], [customDecks, genericDeck]);
  const activeCourseId = activeCourse?.id || null;
  const selectedDeckId = activeCourse ? savedState.selectedDeckByCourse?.[activeCourse.id] : null;
  const activeDeck = decks.find((deck) => deck.id === selectedDeckId) || genericDeck;
  const activeDeckId = activeDeck?.id || "no-active-course";
  const cards = activeDeck?.cards || [];
  const defaultGenerationFocus = activeCourse
    ? `Help me study ${activeCourse.code || activeCourse.name} for this semester.`
    : "";
  const storedGenerationSettings = activeCourse
    ? savedState.generationSettingsByCourse?.[activeCourse.id]
    : null;
  const storedQuestionCount = Number(storedGenerationSettings?.questionCount);
  const storedGenerationChallenge = Number(storedGenerationSettings?.challenge);
  const generationSettings = {
    focus: safePublicText(storedGenerationSettings?.focus, defaultGenerationFocus, 240),
    questionCount: Number.isInteger(storedQuestionCount) && storedQuestionCount >= 1 && storedQuestionCount <= 8 ? storedQuestionCount : 8,
    challenge: Number.isInteger(storedGenerationChallenge) && storedGenerationChallenge >= 1 && storedGenerationChallenge <= 10 ? storedGenerationChallenge : 6,
  };
  const activeLevels = useMemo(() => new Set(cards.map((card) => Number(card.level))), [cards]);
  const configuredChallenge = Number(savedState.challengeByDeck?.[activeDeckId]);
  const challenge = activeLevels.has(configuredChallenge) ? configuredChallenge : firstSupportedLevel(cards);
  const configuredMethod = savedState.methodByDeck?.[activeDeckId];
  const method = METHODS.some((item) => item.id === configuredMethod) ? configuredMethod : "flashcards";
  const errorBook = Array.isArray(savedState.errorBookByDeck?.[activeDeckId])
    ? savedState.errorBookByDeck[activeDeckId]
    : [];
  const defaultReviewStart = useMemo(
    () => localInputValue(new Date(Date.now() + 10 * 60 * 1000)),
    [activeDeckId],
  );
  const reviewStart = savedState.reviewStartByDeck?.[activeDeckId] || defaultReviewStart;
  const isImported = activeDeck?.deckKind === "custom";
  const sourceRevision = activeCourse ? Number(savedState.sourceRevisionByCourse?.[activeCourse.id] || 0) : 0;
  const activeSourceCount = activeCourse && Array.isArray(sourceLibrary)
    ? sourceLibrary.filter((record) => record?.courseSpaceId === activeCourse.id).length
    : 0;
  const generationInProgress = ["extracting", "generating"].includes(generationStatus?.state);
  const generationDisabled = !activeCourse || !activeSourceCount || generationInProgress || typeof onGenerateStudyDeck !== "function";
  const generationActionTitle = !activeCourse
    ? "Create or select a course first."
    : !activeSourceCount
      ? "Add and save at least one material source for this course first."
      : typeof onGenerateStudyDeck !== "function"
        ? "Study generation is unavailable in this dashboard build."
        : generationInProgress
          ? "A Study Deck is being generated."
          : `Generate from ${activeSourceCount} saved source${activeSourceCount === 1 ? "" : "s"} in ${activeCourse.name}.`;
  const activeDeckSourceRevision = Number(savedState.deckSourceRevisionByDeck?.[activeDeckId] || 0);
  const deckIsStale = isImported && sourceRevision > activeDeckSourceRevision;
  const selectedCourseIsValid = Boolean(activeCourseId)
    && savedState.selectedCourseSpaceId === activeCourseId;
  const selectedDeckIsValid = Boolean(activeDeck)
    && decks.some((deck) => deck.id === selectedDeckId);
  const savedChallenge = Number(savedState.challengeByDeck?.[activeDeckId]);
  const challengeIsValid = activeLevels.size
    ? activeLevels.has(savedChallenge)
    : Number.isInteger(savedChallenge) && savedChallenge >= 1 && savedChallenge <= 10;
  const methodIsValid = METHODS.some((item) => item.id === savedState.methodByDeck?.[activeDeckId]);
  const reviewStartIsValid = Boolean(savedState.reviewStartByDeck?.[activeDeckId]);

  useEffect(() => {
    if (!activeCourseId || activeDeckId === "no-active-course") return;
    if (selectedCourseIsValid
      && selectedDeckIsValid
      && challengeIsValid
      && methodIsValid
      && reviewStartIsValid) return;
    persistStudyDeck((current) => ({
      ...current,
      selectedCourseSpaceId: activeCourseId,
      selectedDeckByCourse: selectedDeckIsValid
        ? current.selectedDeckByCourse
        : { ...current.selectedDeckByCourse, [activeCourseId]: activeDeckId },
      challengeByDeck: challengeIsValid ? current.challengeByDeck : { ...current.challengeByDeck, [activeDeckId]: challenge },
      methodByDeck: methodIsValid ? current.methodByDeck : { ...current.methodByDeck, [activeDeckId]: method },
      reviewStartByDeck: reviewStartIsValid ? current.reviewStartByDeck : { ...current.reviewStartByDeck, [activeDeckId]: reviewStart },
    }));
  }, [activeCourseId, activeDeckId, challenge, challengeIsValid, method, methodIsValid, persistStudyDeck, reviewStart, reviewStartIsValid, selectedCourseIsValid, selectedDeckIsValid]);

  const addCourse = ({ code, name }) => {
    const timestamp = Date.now();
    const id = `course-${stableTextHash(`${name}:${code}:${timestamp}`)}-${timestamp.toString(36)}`;
    const course = {
      id,
      name,
      code,
      archived: false,
      createdAt: new Date(timestamp).toISOString(),
    };
    const blankDeckId = genericDeckForCourse(course).id;
    persistStudyDeck((current) => ({
      ...current,
      selectedCourseSpaceId: id,
      courseSpaces: [...(Array.isArray(current.courseSpaces) ? current.courseSpaces : []), course],
      selectedDeckByCourse: { ...current.selectedDeckByCourse, [id]: blankDeckId },
      generationSettingsByCourse: {
        ...current.generationSettingsByCourse,
        [id]: { focus: `Help me study ${code || name} for this semester.`, questionCount: 8, challenge: 6 },
      },
    }));
    setTool("sources");
    setImportNotice(null);
    setGenerationNotice(null);
    setRetryTarget(null);
  };

  const updateGenerationSettings = (patch) => {
    if (!activeCourse) return;
    const next = {
      ...generationSettings,
      ...patch,
    };
    persistStudyDeck((current) => ({
      ...current,
      generationSettingsByCourse: {
        ...current.generationSettingsByCourse,
        [activeCourse.id]: next,
      },
    }));
  };

  const selectCourse = (courseId) => {
    if (!activeCourses.some((course) => course.id === courseId)) return;
    persistStudyDeck((current) => ({ ...current, selectedCourseSpaceId: courseId }));
    setTool("sources");
    setImportNotice(null);
    setGenerationNotice(null);
    setRetryTarget(null);
  };

  const renameCourse = (courseId, { code, name }) => {
    persistStudyDeck((current) => {
      const courseSpaces = Array.isArray(current.courseSpaces) ? current.courseSpaces : [];
      if (!courseSpaces.some((course) => course.id === courseId)) return current;
      return {
        ...current,
        courseSpaces: courseSpaces.map((course) => course.id === courseId
          ? { ...course, code, name }
          : course),
      };
    });
  };

  const archiveCourse = (course) => {
    if (!window.confirm(`Archive “${course.name}”? The course will leave the active switcher, but its sources, decks, quizzes, settings, and progress will remain saved and can be restored.`)) return;
    const nextCourse = activeCourses.find((item) => item.id !== course.id) || null;
    persistStudyDeck((current) => {
      const courseSpaces = Array.isArray(current.courseSpaces) ? current.courseSpaces : [];
      return {
        ...current,
        selectedCourseSpaceId: nextCourse?.id || null,
        courseSpaces: courseSpaces.map((item) => item.id === course.id
          ? { ...item, archived: true }
          : item),
      };
    });
    setTool("sources");
    setImportNotice(null);
  };

  const restoreCourse = (courseId) => {
    persistStudyDeck((current) => {
      const courseSpaces = Array.isArray(current.courseSpaces) ? current.courseSpaces : [];
      if (!courseSpaces.some((course) => course.id === courseId)) return current;
      return {
        ...current,
        selectedCourseSpaceId: courseId,
        courseSpaces: courseSpaces.map((course) => course.id === courseId
          ? { ...course, archived: false }
          : course),
      };
    });
    setTool("sources");
    setImportNotice(null);
  };

  const selectDeck = (deckId) => {
    if (!activeCourse) return;
    const nextDeck = decks.find((deck) => deck.id === deckId);
    if (!nextDeck) return;
    persistStudyDeck((current) => ({
      ...current,
      selectedDeckByCourse: { ...current.selectedDeckByCourse, [activeCourse.id]: deckId },
    }));
    setRetryTarget(null);
    setImportNotice(null);
  };

  const setChallenge = (nextChallenge) => persistStudyDeck((current) => ({
    ...current,
    challengeByDeck: { ...current.challengeByDeck, [activeDeck.id]: nextChallenge },
  }));

  const setMethod = (nextMethod) => persistStudyDeck((current) => ({
    ...current,
    methodByDeck: { ...current.methodByDeck, [activeDeck.id]: nextMethod },
  }));

  const setErrorBook = (update) => persistStudyDeck((current) => {
    const entries = Array.isArray(current.errorBookByDeck?.[activeDeck.id]) ? current.errorBookByDeck[activeDeck.id] : [];
    const nextEntries = typeof update === "function" ? update(entries) : update;
    return {
      ...current,
      errorBookByDeck: { ...current.errorBookByDeck, [activeDeck.id]: nextEntries },
    };
  });

  const setReviewStart = (start) => persistStudyDeck((current) => ({
    ...current,
    reviewStartByDeck: { ...current.reviewStartByDeck, [activeDeck.id]: start },
  }));

  const retryCard = (card, retryMethod) => {
    setChallenge(card.level);
    setMethod(retryMethod);
    setRetryTarget({ cardId: card.id, method: retryMethod });
    setTool("practice");
  };

  const importCustomDeck = ({ cards: importedCards, coverage, generatedAt = null, generationOrigin = "manual-import", sourceManifest, title }) => {
    if (!activeCourse) return { ok: false, message: "Create or open a course before importing a deck." };
    const identityPayload = JSON.stringify({
      cards: importedCards,
      courseSpaceId: activeCourse.id,
      coverage,
      generationOrigin,
      sourceManifest,
      title,
    });
    const id = `custom-${safeFileStem(activeCourse.id, "course").slice(0, 24)}-${stableContentHash(identityPayload)}-${serializedBytes(identityPayload).toString(36)}`;
    const record = {
      id,
      title,
      cards: importedCards,
      courseCode: activeCourse.code || activeCourse.name,
      courseId: activeCourse.id,
      courseSpaceId: activeCourse.id,
      coverage,
      generatedAt,
      generationOrigin,
      sourceManifest,
      generalKnowledge: "unknown",
    };
    if (serializedBytes(record) > MAX_CUSTOM_DECK_FILE_BYTES) {
      return { ok: false, message: "Import stopped: the normalized custom deck exceeds the 700 KiB per-deck sync limit. Remove nonessential metadata or split the reviewed material into a smaller deck." };
    }
    const currentDecks = savedState.customDecks && typeof savedState.customDecks === "object"
      ? savedState.customDecks
      : {};
    const attestingUnchangedDeck = Boolean(
      currentDecks[id]
      && activeDeck?.id === id
      && sourceRevision > Number(savedState.deckSourceRevisionByDeck?.[id] || 0)
    );
    if (attestingUnchangedDeck && !window.confirm("This canonical JSON is unchanged even though this course’s sources changed. Mark it current only if you reviewed the changed sources and confirmed that no card or answer needs an update.")) {
      return { ok: false, message: "Import cancelled: the stale marker remains because the unchanged deck was not attested as reviewed against the changed sources." };
    }
    if (!currentDecks[id] && Object.keys(currentDecks).length >= MAX_CUSTOM_DECKS) {
      return { ok: false, message: `Import stopped: this profile can store at most ${MAX_CUSTOM_DECKS} custom decks. Archive a course does not remove its decks; remove a deck you no longer need before importing another.` };
    }
    const nextCustomDecks = { ...currentDecks, [id]: record };
    if (serializedBytes(nextCustomDecks) > MAX_CUSTOM_DECK_TOTAL_BYTES) {
      return { ok: false, message: "Import stopped: all custom decks together must stay at or below about 720 KiB so account sync remains reliable. Remove an unused custom deck or import a smaller canonical deck." };
    }
    const initialLevel = firstSupportedLevel(importedCards);
    persistStudyDeck((current) => ({
      ...current,
      selectedCourseSpaceId: activeCourse.id,
      selectedDeckByCourse: { ...current.selectedDeckByCourse, [activeCourse.id]: id },
      customDecks: { ...current.customDecks, [id]: record },
      deckSourceRevisionByDeck: {
        ...current.deckSourceRevisionByDeck,
        [id]: Number(current.sourceRevisionByCourse?.[activeCourse.id] || 0),
      },
      challengeByDeck: { ...current.challengeByDeck, [id]: current.challengeByDeck?.[id] || initialLevel },
      methodByDeck: { ...current.methodByDeck, [id]: current.methodByDeck?.[id] || "flashcards" },
      errorBookByDeck: { ...current.errorBookByDeck, [id]: current.errorBookByDeck?.[id] || [] },
      reviewStartByDeck: { ...current.reviewStartByDeck, [id]: current.reviewStartByDeck?.[id] || localInputValue(new Date(Date.now() + 10 * 60 * 1000)) },
    }));
    return {
      ok: true,
      message: attestingUnchangedDeck
        ? `The unchanged ${importedCards.length}-card deck was marked current after your review attestation. Its claims and citations remain user-provided and unaudited.`
        : generationOrigin === "ai-assisted"
          ? `${importedCards.length} AI-generated draft cards were saved only to ${activeCourse.name}. Their claims, answers, and citations are unaudited and must be checked against the sources.`
          : generationOrigin === "local-extractive"
            ? `${importedCards.length} private browser-generated cards were saved only to ${activeCourse.name}. No source text left this browser; the extracted statements and citations are still unaudited.`
          : `${importedCards.length} structurally valid canonical cards were saved only to ${activeCourse.name}. Their claims and citations remain user-provided and unaudited.`,
    };
  };

  const generateFromSources = async (mode) => {
    if (!activeCourse) {
      setGenerationNotice({ type: "error", text: "Create or open a course before generating study content." });
      return;
    }
    const records = (Array.isArray(sourceLibrary) ? sourceLibrary : []).filter((record) => (
      record?.courseSpaceId === activeCourse.id
    ));
    if (!records.length) {
      setGenerationNotice({ type: "error", text: "Upload at least one source file to this course first." });
      return;
    }
    if (typeof onGenerateStudyDeck !== "function") {
      setGenerationNotice({ type: "error", text: "Study generation is not connected in this dashboard build." });
      return;
    }
    const cloudGeneration = generationAccessStatus === "ready";
    const approved = confirmStudyGeneration(cloudGeneration
      ? `Generate ${generationSettings.questionCount} draft ${mode} question${generationSettings.questionCount === 1 ? "" : "s"} targeting Challenge ${generationSettings.challenge} from up to 48 private course sources? The browser will extract at most 64,000 characters total and send those excerpts, source names, study focus, and the course name/code to the configured AI provider. Original files are not sent. Legacy DOC and image-only PDF files may be skipped. If the provider is unavailable, the browser will create private extractive recall cards instead. Generated cards may be wrong and must be checked against the sources. Continue?`
      : `Generate ${generationSettings.questionCount} private draft ${mode} question${generationSettings.questionCount === 1 ? "" : "s"} from up to 48 course sources in this browser? No source text will leave this browser. Legacy DOC and image-only PDF files may be skipped. The fallback uses exact source statements for extractive recall; Challenge ${generationSettings.challenge} is only an organizational target, not a guaranteed analytical difficulty. Continue?`);
    if (!approved) return;
    setGenerationNotice(null);
    try {
      persistStudyDeck((current) => ({
        ...current,
        generationSettingsByCourse: { ...current.generationSettingsByCourse, [activeCourse.id]: generationSettings },
      }));
      const generated = await onGenerateStudyDeck({
        course: activeCourse,
        mode,
        records,
        ...generationSettings,
      });
      const localGeneration = generated.generationOrigin === "local-extractive";
      const sourceManifest = generated.sources.map((source) => ({
        id: source.id,
        publicLabel: source.fileName,
        sourceKind: localGeneration ? "Browser-read course source" : "AI-read course source",
        role: "generation evidence",
        auditStatus: "user-provided",
      }));
      const result = importCustomDeck({
        cards: sanitizeImportedCards(generated.cards),
        title: safePublicText(generated.title, `${activeCourse.name} generated study deck`, 96),
        generationOrigin: generated.generationOrigin || "ai-assisted",
        generatedAt: new Date().toISOString(),
        sourceManifest,
        coverage: {
          sourceFileCount: records.length,
          readableSourceFileCount: generated.sources.length,
          generationFocus: generated.generationFocus || generationSettings.focus,
          generationQuestionCount: generated.generationQuestionCount || generationSettings.questionCount,
          generationChallenge: generated.generationChallenge || generationSettings.challenge,
          challengeTargetGuaranteed: generated.challengeTargetGuaranteed === true,
          challengeTargetMethod: generated.challengeTargetMethod || "Requested generation target; cognitive demand is not independently audited.",
          blockedSourceFiles: generated.skipped,
          scopeRule: localGeneration
            ? "Only bounded text extracted inside this browser was used for this private extractive draft. No source text was transmitted; every statement and citation remains unaudited."
            : "Only the bounded text extracted from the named course sources was supplied for this AI-generated draft. Every claim and citation remains unaudited.",
        },
      });
      if (result?.ok === false) throw new Error(result.message);
      const skippedCount = generated.skipped?.length || 0;
      setGenerationNotice({
        type: "success",
        text: `${result.message}${skippedCount ? ` ${skippedCount} file${skippedCount === 1 ? " was" : "s were"} skipped; review Coverage for the blocked list.` : ""}`,
      });
      setTool(mode);
    } catch (error) {
      if (error?.name === "AbortError") return;
      setGenerationNotice({ type: "error", text: error instanceof Error ? error.message : "Study content could not be generated." });
    }
  };

  const removeCustomDeck = () => {
    if (!activeCourse || !isImported || !window.confirm(`Remove “${activeDeck.title}” and its saved practice state from ${activeCourse.name}? This does not remove source files or other course data. This change will sync to signed-in devices.`)) return;
    persistStudyDeck((current) => {
      const customDecks = { ...current.customDecks };
      const challengeByDeck = { ...current.challengeByDeck };
      const methodByDeck = { ...current.methodByDeck };
      const errorBookByDeck = { ...current.errorBookByDeck };
      const reviewStartByDeck = { ...current.reviewStartByDeck };
      const deckSourceRevisionByDeck = { ...current.deckSourceRevisionByDeck };
      delete customDecks[activeDeck.id];
      delete challengeByDeck[activeDeck.id];
      delete methodByDeck[activeDeck.id];
      delete errorBookByDeck[activeDeck.id];
      delete reviewStartByDeck[activeDeck.id];
      delete deckSourceRevisionByDeck[activeDeck.id];
      return {
        ...current,
        selectedDeckByCourse: { ...current.selectedDeckByCourse, [activeCourse.id]: genericDeck.id },
        customDecks,
        deckSourceRevisionByDeck,
        challengeByDeck,
        methodByDeck,
        errorBookByDeck,
        reviewStartByDeck,
      };
    });
    setImportNotice({ type: "success", text: `The custom deck and its saved practice state were removed from ${activeCourse.name}. Its source library was not changed.` });
  };

  const markSourcesChanged = () => {
    if (!activeCourse) return;
    persistStudyDeck((current) => ({
      ...current,
      sourceRevisionByCourse: {
        ...current.sourceRevisionByCourse,
        [activeCourse.id]: Number(current.sourceRevisionByCourse?.[activeCourse.id] || 0) + 1,
      },
    }));
  };

  const openDeckUpdate = () => {
    const generated = ["ai-assisted", "local-extractive"].includes(activeDeck?.generationOrigin);
    setTool(generated ? "sources" : "coverage");
    setImportNotice({
      type: "warning",
      text: generated
        ? "Sources changed after this draft was generated. Existing cards and progress remain unchanged. Review the changed evidence, then explicitly generate a new draft when you are ready."
        : "Sources changed after this deck was imported. Existing cards and progress remain unchanged. Review the evidence, update your canonical JSON outside the dashboard, then import that updated file here.",
    });
  };

  const scopeMessage = isImported
    ? ["ai-assisted", "local-extractive"].includes(activeDeck?.generationOrigin)
      ? <p><strong>{cards.length} {activeDeck?.generationOrigin === "local-extractive" ? "private browser-generated" : "AI-generated"} draft card{cards.length === 1 ? " is" : "s are"} active only in {activeCourse?.name}.</strong> Their structure passed validation, but their statements, answers, and citations have not been independently audited.</p>
      : <p><strong>{cards.length} imported card{cards.length === 1 ? " is" : "s are"} active only in {activeCourse?.name}.</strong> Their structure passed validation, but their claims and citations have not been independently audited.</p>
    : <p><strong>{activeCourse?.name || "This course"} has a blank Study Deck workspace.</strong> No course claims or cards are preloaded. Add private source files, then explicitly generate a draft or import source-reviewed canonical cards.</p>;

  return (
    <main aria-labelledby="study-deck-title" className="study-deck-page" id="study-page" role="tabpanel">
      <header className="study-deck-hero">
        <div className="study-deck-hero-copy">
          <span className="study-deck-hero-icon"><Icon name="target" size={27} /></span>
          <div><span className="study-deck-eyebrow">{activeCourse ? `${activeCourse.code || "Course"} · source-grounded active recall` : "Source-grounded active recall"}</span><h2 id="study-deck-title">{activeDeck?.title || "Create your first course"}</h2><p>{activeDeck?.subtitle || "Keep every course’s sources, decks, and progress in its own private workspace."}</p></div>
        </div>
        <div className="study-deck-hero-actions">
          <span className="study-deck-session-note"><Icon name="lock" size={15} />Saved to this profile · cloud accounts sync dashboard data.</span>
          <div className="study-deck-hero-action-buttons" aria-label="Study Deck actions">
            <button className="study-deck-button-primary" disabled={generationDisabled} onClick={() => generateFromSources("practice")} title={generationActionTitle} type="button"><Icon name="target" size={16} />{generationInProgress ? "Generating…" : "Generate practice"}</button>
            <button className="study-deck-button-ghost" disabled={generationDisabled} onClick={() => generateFromSources("quiz")} title={generationActionTitle} type="button"><Icon name="check" size={16} />{generationInProgress ? "Generating…" : "Generate quiz"}</button>
            <button className="study-deck-button-ghost" disabled={!activeCourse || !cards.length} onClick={() => downloadText(`${safeFileStem(activeDeck.title)}-anki.csv`, buildAnkiCsv(cards), "text/csv;charset=utf-8")} type="button"><Icon name="download" size={16} />Anki CSV</button>
          </div>
        </div>
      </header>

      <GenerationSetup activeCourse={activeCourse} onChange={updateGenerationSettings} settings={generationSettings} />

      <CourseSpaceManager activeCourseId={activeCourse?.id || null} courses={courses} onAdd={addCourse} onArchive={archiveCourse} onRename={renameCourse} onRestore={restoreCourse} onSelect={selectCourse} />

      {!activeCourse ? (
        <aside className="study-deck-scope-note">
          <Icon name="info" size={18} />
          <p><strong>No course is active.</strong> Create a course above, or restore an archived course. New profiles have no personalized sources or study content.</p>
        </aside>
      ) : (
        <>
          <DeckPicker activeDeckId={activeDeck.id} customDecks={customDecks} deckSourceRevisionByDeck={savedState.deckSourceRevisionByDeck} genericDeck={genericDeck} onSelect={selectDeck} sourceRevision={sourceRevision} />

          <aside className="study-deck-scope-note">
            <Icon name="info" size={18} />
            {scopeMessage}
          </aside>

          {deckIsStale ? (
            <aside className="study-deck-stale-banner" role="status">
              <span><Icon name="warning" size={19} /></span>
              <div><strong>Sources changed; these cards may be stale.</strong><p>The imported cards, quiz bank, and progress were intentionally left unchanged. Review the source change before updating this deck.</p></div>
              <button className="study-deck-button-primary" onClick={openDeckUpdate} type="button">Review &amp; update</button>
            </aside>
          ) : null}

          {generationNotice && tool !== "sources" ? (
            <div className={`study-deck-import-notice is-${generationNotice.type}`} role={generationNotice.type === "error" ? "alert" : "status"}>{generationNotice.text}</div>
          ) : null}

          <nav className="study-deck-tools" aria-label={`${activeCourse.name} study deck tools`}>
            {TOOLS.map((item) => (
              <button aria-current={tool === item.id ? "page" : undefined} disabled={!cards.length && ["practice", "quiz"].includes(item.id)} key={item.id} onClick={() => setTool(item.id)} type="button">
                <Icon name={item.icon} size={17} /><span>{item.label}</span>
                {item.id === "errors" && errorBook.some((entry) => entry.needsReview) ? <b>{errorBook.filter((entry) => entry.needsReview).length}</b> : null}
              </button>
            ))}
          </nav>

          <div className="study-deck-workspace">
            {tool === "practice" ? <PracticePanel cards={cards} challenge={challenge} errorBook={errorBook} key={`practice:${activeDeck.id}`} method={method} onChallenge={setChallenge} onErrorBook={setErrorBook} onMethod={setMethod} onOpenErrors={() => setTool("errors")} onRetryConsumed={() => setRetryTarget(null)} retryTarget={retryTarget} /> : null}
            {tool === "quiz" ? <QuizPanel cards={cards} deck={activeDeck} key={`quiz:${activeDeck.id}`} onErrorBook={setErrorBook} /> : null}
            {tool === "errors" ? <ErrorBookPanel cards={cards} entries={errorBook} key={`errors:${activeDeck.id}`} onEntries={setErrorBook} onPractice={retryCard} /> : null}
            {tool === "reviews" ? <ReviewPanel deckTitle={activeDeck.title} hasCards={Boolean(cards.length)} key={`reviews:${activeDeck.id}`} onStart={setReviewStart} start={reviewStart} /> : null}
            {tool === "sources" ? <SourcesPanel activeCourse={activeCourse} activeDeck={activeDeck} generationNotice={generationNotice} generationStatus={generationStatus} key={`sources:${activeCourse.id}`} onAddSourceFiles={onAddSourceFiles} onRemoveSourceFile={onRemoveSourceFile} onSourcesChanged={markSourcesChanged} sourceLibrary={sourceLibrary} sourceUploadStatus={sourceUploadStatus} /> : null}
            {tool === "lab" ? <MediaLabPanel key={`lab:${activeCourse.id}`} /> : null}
            {tool === "coverage" ? <CoveragePanel deck={activeDeck} importNotice={importNotice} isImported={isImported} key={`coverage:${activeDeck.id}`} onImportDeck={importCustomDeck} onImportNotice={setImportNotice} onRemoveCustom={removeCustomDeck} /> : null}
          </div>
        </>
      )}
    </main>
  );
}
