import { useCallback, useEffect, useRef, useState } from "react";
import { useSyncedResource } from "./useSyncedResource.js";
import { PROFILE_RESOURCES, cloudConsentSessionKey } from "../lib/profileStorage.js";

export const CLOUD_POLICY_VERSION = "2026-09-01.1";
const MAX_CLOUD_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 3000;
export const MAX_CLOUD_HISTORY_CHARS = 12_000;
const CONSENT_MARKER_SCHEMA_VERSION = 1;

function readProfileConsentMarker(profileId) {
  try {
    const raw = window.sessionStorage.getItem(cloudConsentSessionKey(profileId));
    const marker = raw ? JSON.parse(raw) : null;
    if (marker?.schemaVersion !== CONSENT_MARKER_SCHEMA_VERSION
      || marker?.policy !== CLOUD_POLICY_VERSION
      || !Number.isFinite(Date.parse(marker?.expiresAt))
      || Date.parse(marker.expiresAt) <= Date.now()) return null;
    return marker;
  } catch {
    return null;
  }
}

function writeProfileConsentMarker(profileId, expiresAt) {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;
  try {
    window.sessionStorage.setItem(cloudConsentSessionKey(profileId), JSON.stringify({
      expiresAt: new Date(expiry).toISOString(),
      policy: CLOUD_POLICY_VERSION,
      schemaVersion: CONSENT_MARKER_SCHEMA_VERSION,
    }));
    return true;
  } catch {
    return false;
  }
}

function removeProfileConsentMarker(profileId) {
  try {
    window.sessionStorage.removeItem(cloudConsentSessionKey(profileId));
  } catch {
    // The in-memory consent state is still cleared below.
  }
}

function newId(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function chatMessage(role, body, id = newId(role)) {
  return {
    body,
    createdAt: new Date().toISOString(),
    id,
    role,
    title: role === "assistant" ? "Semester Board" : "You",
  };
}

export function normalizeStoredCloudMessages(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    if (!message || !["assistant", "user"].includes(message.role)) return [];
    const body = typeof message.body === "string" ? message.body.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
    const createdAt = typeof message.createdAt === "string" && Number.isFinite(Date.parse(message.createdAt))
      ? new Date(message.createdAt).toISOString()
      : null;
    const id = typeof message.id === "string" ? message.id.trim().slice(0, 160) : "";
    if (!body || !createdAt || !id) return [];
    return [{
      body,
      createdAt,
      id,
      role: message.role,
      title: message.role === "assistant" ? "Semester Board" : "You",
    }];
  }).slice(-MAX_CLOUD_MESSAGES);
}

export function readStoredCloudMessages(storage, storageKey) {
  try {
    const raw = storage?.getItem(storageKey);
    return raw ? normalizeStoredCloudMessages(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function trimCloudHistory(messages) {
  const kept = [];
  let textChars = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const bodyLength = typeof message?.body === "string" ? message.body.length : 0;
    if (!bodyLength || textChars + bodyLength > MAX_CLOUD_HISTORY_CHARS) continue;
    kept.push(message);
    textChars += bodyLength;
    if (kept.length >= MAX_CLOUD_MESSAGES - 1) break;
  }
  return kept.reverse();
}

async function responseError(response) {
  const payload = await response.json().catch(() => null);
  return payload?.error || "Semester Chat could not complete that request.";
}

export function useCloudAssistant(profileId, semesterContext) {
  const [status, setStatus] = useState("idle");
  const [messages, setMessages] = useSyncedResource({
    fallback: [],
    normalize: normalizeStoredCloudMessages,
    profileId,
    resource: PROFILE_RESOURCES.cloudChat,
  });
  const [error, setError] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const controllerRef = useRef(null);
  const checkedRef = useRef(false);

  const checkConsent = useCallback(async ({ force = false } = {}) => {
    if (checkedRef.current && !force) return;
    checkedRef.current = true;
    setStatus("checking");
    setError(null);
    try {
      const response = await fetch("/api/ai-consent", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json();
      if (!result.available) {
        setStatus("unavailable");
        return;
      }
      setExpiresAt(result.expiresAt || null);
      const marker = readProfileConsentMarker(profileId);
      setStatus(result.consented && marker ? "ready" : "needs-consent");
    } catch (caught) {
      setStatus("unavailable");
      setError(caught instanceof Error ? caught.message : "Semester Chat is unavailable.");
    }
  }, [profileId]);

  const grantConsent = useCallback(async () => {
    setStatus("checking");
    setError(null);
    try {
      const response = await fetch("/api/ai-consent", {
        body: JSON.stringify({ consent: true, policy: CLOUD_POLICY_VERSION }),
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json();
      if (!writeProfileConsentMarker(profileId, result.expiresAt)) {
        await fetch("/api/ai-consent", {
          cache: "no-store",
          credentials: "same-origin",
          method: "DELETE",
        }).catch(() => {});
        throw new Error("Semester Chat consent could not be isolated for this local profile.");
      }
      setExpiresAt(result.expiresAt || null);
      setStatus("ready");
    } catch (caught) {
      setStatus("needs-consent");
      setError(caught instanceof Error ? caught.message : "Semester Chat consent could not be recorded.");
    }
  }, [profileId]);

  const clearSessionConsent = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    removeProfileConsentMarker(profileId);
    checkedRef.current = false;
    setExpiresAt(null);
    setError(null);
    setStatus("needs-consent");
  }, [profileId]);

  const clearProfileConsent = useCallback(() => {
    clearSessionConsent();
    setMessages([]);
  }, [clearSessionConsent, setMessages]);

  const revokeConsent = useCallback(async () => {
    await fetch("/api/ai-consent", {
      cache: "no-store",
      credentials: "same-origin",
      method: "DELETE",
    }).catch(() => {});
    clearProfileConsent();
  }, [clearProfileConsent]);

  const endSessionConsent = useCallback(async () => {
    clearSessionConsent();
    await fetch("/api/ai-consent", {
      cache: "no-store",
      credentials: "same-origin",
      method: "DELETE",
    }).catch(() => {});
  }, [clearSessionConsent]);

  const clearMessages = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setMessages([]);
    setError(null);
    setStatus((current) => (current === "streaming" ? "ready" : current));
  }, []);

  const sendMessage = useCallback(async (value) => {
    const clean = String(value || "").trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!clean || status !== "ready") return;
    const user = chatMessage("user", clean);
    const history = trimCloudHistory([...messages, user].slice(-(MAX_CLOUD_MESSAGES - 1)));
    const assistantId = newId("assistant");
    const controller = new AbortController();
    controllerRef.current = controller;
    setMessages([...history, chatMessage("assistant", "", assistantId)]);
    setStatus("streaming");
    setError(null);
    try {
      const response = await fetch("/api/chat", {
        body: JSON.stringify({
          context: semesterContext,
          messages: history.map((message) => ({
            id: message.id,
            parts: [{ text: message.body, type: "text" }],
            role: message.role,
          })),
        }),
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const failure = Object.assign(new Error(await responseError(response)), {
          status: response.status,
        });
        if (response.status === 403) {
          removeProfileConsentMarker(profileId);
          setExpiresAt(null);
        }
        throw failure;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let body = "";
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        body += decoder.decode(chunk, { stream: true });
        setMessages((current) => current.map((message) => (
          message.id === assistantId ? { ...message, body } : message
        )));
      }
      body += decoder.decode();
      if (!body.trim()) throw new Error("Semester Chat returned an empty response.");
      setMessages((current) => current.map((message) => (
        message.id === assistantId ? { ...message, body } : message
      )).slice(-MAX_CLOUD_MESSAGES));
      setStatus("ready");
    } catch (caught) {
      if (caught?.name === "AbortError") {
        setMessages((current) => current.filter((message) => message.id !== assistantId));
        setStatus("ready");
      } else {
        setMessages((current) => current.map((message) => (
          message.id === assistantId
            ? { ...message, body: "Semester Board could not answer right now." }
            : message
        )));
        setError(caught instanceof Error ? caught.message : "Semester Chat could not answer right now.");
        setStatus(caught?.status === 403 ? "needs-consent" : "ready");
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [messages, profileId, semesterContext, status]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  return {
    checkConsent,
    clearProfileConsent,
    clearMessages,
    endSessionConsent,
    error,
    expiresAt,
    grantConsent,
    messages,
    revokeConsent,
    sendMessage,
    status,
  };
}
