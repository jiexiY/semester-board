import { useCallback, useEffect, useRef, useState } from "react";
import { validateStudyDeck } from "../lib/studyDeck.js";
import { extractStudySourcePackets } from "../lib/studySourceText.js";

const IDLE = Object.freeze({ state: "idle", message: "" });

async function responseError(response) {
  const payload = await response.json().catch(() => null);
  if (response.status === 403) {
    return "Enable Conversational AI in Semester Board chat before sending private course excerpts for generation.";
  }
  return payload?.error || "Semester Board could not generate study content right now.";
}

export function useStudyGenerator({ aiStatus, courseSpaceId, readSourceFile }) {
  const [status, setStatus] = useState(IDLE);
  const controllerRef = useRef(null);

  useEffect(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStatus(IDLE);
  }, [courseSpaceId]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const generate = useCallback(async ({ course, mode, records }) => {
    if (!course?.id || course.id !== courseSpaceId) {
      throw new Error("The active Study Deck course changed. Open the course and try again.");
    }
    if (aiStatus !== "ready") {
      throw new Error("Enable Conversational AI in Semester Board chat before generating from private course sources.");
    }
    if (!Array.isArray(records) || !records.length) {
      throw new Error("Add at least one readable source file to this course first.");
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus({ state: "extracting", message: "Reading bounded excerpts from this course’s private sources…" });
    try {
      const extracted = await extractStudySourcePackets(records, readSourceFile);
      if (!extracted.sources.length) {
        const reason = extracted.skipped[0]?.reason || "No readable source text was found.";
        throw new Error(reason);
      }
      if (course.id !== courseSpaceId || controller.signal.aborted) throw new DOMException("Generation cancelled", "AbortError");
      setStatus({ state: "generating", message: `Generating a validated ${mode} deck from ${extracted.sources.length} source${extracted.sources.length === 1 ? "" : "s"}…` });
      const response = await fetch("/api/chat", {
        body: JSON.stringify({
          course: {
            code: course.code || course.name,
            name: course.name,
          },
          mode,
          sources: extracted.sources,
        }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Semester-Operation": "study-generation",
        },
        method: "POST",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await responseError(response));
      const deck = await response.json();
      const errors = validateStudyDeck(deck?.cards);
      if (errors.length) throw new Error("The generated cards did not pass the Study Deck validator. Nothing was saved.");
      setStatus({ state: "success", message: `${deck.cards.length} draft cards were generated and validated.` });
      return { ...deck, ...extracted };
    } catch (error) {
      if (error?.name === "AbortError") {
        setStatus(IDLE);
        throw error;
      }
      const message = error instanceof Error ? error.message : "Semester Board could not generate study content.";
      setStatus({ state: "error", message });
      throw new Error(message);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [aiStatus, courseSpaceId, readSourceFile]);

  return {
    generate,
    status,
  };
}
