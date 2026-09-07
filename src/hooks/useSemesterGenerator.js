import { useCallback, useEffect, useRef, useState } from "react";
import { extractStudySourcePackets } from "../lib/studySourceText.js";

const IDLE = Object.freeze({ state: "idle", message: "" });

async function responseError(response) {
  const payload = await response.json().catch(() => null);
  if (response.status === 403) {
    return "Review and enable private AI generation before sending course-document excerpts.";
  }
  return payload?.error || "Semester Board could not build a semester draft right now.";
}

function sourceRecord(file, index) {
  const extension = String(file?.name || "").split(".").pop()?.toLocaleLowerCase("en-US") || "";
  return {
    blob: file,
    extension,
    fileName: String(file?.name || `Course document ${index + 1}`).slice(0, 160),
    id: `semester-source-${index + 1}`,
  };
}

export function useSemesterGenerator({ aiStatus }) {
  const [status, setStatus] = useState(IDLE);
  const controllerRef = useRef(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStatus(IDLE);
  }, []);

  const generate = useCallback(async ({ files }) => {
    if (aiStatus !== "ready") {
      throw new Error("Enable private AI generation before building a semester draft.");
    }
    const selected = Array.from(files || []).filter(Boolean);
    if (!selected.length) throw new Error("Add at least one readable course document first.");

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus({ state: "extracting", message: "Reading bounded text excerpts in this browser…" });
    try {
      const records = selected.map(sourceRecord);
      const extracted = await extractStudySourcePackets(records, async (record) => record.blob);
      if (!extracted.sources.length) {
        const reason = extracted.skipped[0]?.reason || "No readable course-document text was found.";
        throw new Error(reason);
      }
      if (controller.signal.aborted) throw new DOMException("Generation cancelled", "AbortError");
      setStatus({
        state: "generating",
        message: `Building a source-grounded semester draft from ${extracted.sources.length} document${extracted.sources.length === 1 ? "" : "s"}…`,
      });
      const response = await fetch("/api/chat", {
        body: JSON.stringify({ sources: extracted.sources }),
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Semester-Operation": "semester-generation",
        },
        method: "POST",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await responseError(response));
      const draft = await response.json();
      if (!Array.isArray(draft?.courses) || !draft.courses.length) {
        throw new Error("No supported courses were found. Nothing was saved.");
      }
      setStatus({
        state: "success",
        message: `Drafted ${draft.courses.length} course${draft.courses.length === 1 ? "" : "s"} and ${draft.assignments?.length || 0} coursework item${draft.assignments?.length === 1 ? "" : "s"}.`,
      });
      const usedSourceIds = new Set(extracted.sources.map((source) => source.id));
      const skippedByName = new Map(extracted.skipped.map((item) => [item.fileName, item.reason]));
      return {
        draft,
        extracted,
        records: records.map((record) => ({
          ...record,
          skipReason: skippedByName.get(record.fileName) || null,
          usedInGeneration: usedSourceIds.has(record.id),
        })),
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        setStatus(IDLE);
        throw error;
      }
      const message = error instanceof Error ? error.message : "Semester Board could not build a semester draft.";
      setStatus({ state: "error", message });
      throw new Error(message);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [aiStatus]);

  return { generate, reset, status };
}

