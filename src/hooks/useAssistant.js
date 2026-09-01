import { useCallback, useEffect, useMemo, useState } from "react";
import { useSyncedResource } from "./useSyncedResource.js";
import {
  answerAssistantQuery,
  buildAssistantReminders,
  buildDailyBriefing,
  collectDueReminders,
  getReminderDeliveryId,
} from "../lib/assistantEngine.js";
import { campusDateKey } from "../lib/format.js";
import { buildSemesterChatContext } from "../lib/assistantContext.js";
import { useCloudAssistant } from "./useCloudAssistant.js";
import { usePushReminders } from "./usePushReminders.js";
import { PROFILE_RESOURCES } from "../lib/profileStorage.js";

const SCHEMA_VERSION = 2;
const MAX_MESSAGES = 80;
const MAX_DELIVERED_IDS = 1600;

export const DEFAULT_ASSISTANT_STATE = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  messages: [],
  deliveredIds: [],
  lastDailyBriefingDate: null,
  notificationsEnabled: false,
});

function messageId(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function itemLine(item) {
  return [item?.courseCode, item?.title, item?.date, item?.time]
    .filter(Boolean)
    .join(" · ");
}

function assistantMessage(payload, meta = {}) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const itemLines = items.slice(0, 4).map(itemLine).filter(Boolean);
  if (items.length > 4) itemLines.push(`+ ${items.length - 4} more`);
  const baseBody = payload?.body || String(payload || "I’m ready when you are.");
  return {
    id: messageId("assistant"),
    role: "assistant",
    title: payload?.title || "Semester assistant",
    body: itemLines.length ? `${baseBody}\n${itemLines.join("\n")}` : baseBody,
    createdAt: new Date().toISOString(),
    kind: meta.kind || "reply",
    reminderId: meta.reminderId || null,
  };
}

function userMessage(body) {
  return {
    id: messageId("user"),
    role: "user",
    title: "You",
    body,
    createdAt: new Date().toISOString(),
    kind: "question",
    reminderId: null,
  };
}

function trimMessages(messages) {
  return messages.slice(-MAX_MESSAGES);
}

export function normalizeAssistantState(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== SCHEMA_VERSION) {
    return DEFAULT_ASSISTANT_STATE;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    messages: Array.isArray(value.messages)
      ? value.messages.filter((message) => message && typeof message.body === "string").slice(-MAX_MESSAGES)
      : [],
    deliveredIds: Array.isArray(value.deliveredIds)
      ? value.deliveredIds.filter((id) => typeof id === "string").slice(-MAX_DELIVERED_IDS)
      : [],
    lastDailyBriefingDate: typeof value.lastDailyBriefingDate === "string"
      ? value.lastDailyBriefingDate
      : null,
    notificationsEnabled: value.notificationsEnabled === true,
  };
}

export function useAssistant({
  assignments = [],
  attendanceTotals = {},
  checkins = {},
  completedAssignments = {},
  courses = [],
  meetings = [],
  now = new Date(),
  profileId,
  scheduleEvents = [],
  syncMode = "local",
}) {
  const [state, setState] = useSyncedResource({
    fallback: DEFAULT_ASSISTANT_STATE,
    normalize: normalizeAssistantState,
    profileId,
    resource: PROFILE_RESOURCES.assistant,
  });
  const [notice, setNotice] = useState(null);
  const nowEpoch = now.getTime();
  const todayKey = campusDateKey(now);

  const context = useMemo(() => ({
    assignments,
    attendanceTotals,
    checkins,
    completedAssignments,
    courses,
    meetings,
    now,
    scheduleEvents,
  }), [
    assignments,
    attendanceTotals,
    checkins,
    completedAssignments,
    courses,
    meetings,
    nowEpoch,
    scheduleEvents,
  ]);

  const reminders = useMemo(
    () => buildAssistantReminders(context),
    [context],
  );
  const semesterChatContext = useMemo(
    () => buildSemesterChatContext({ ...context, reminders }),
    [context, reminders],
  );
  const push = usePushReminders(reminders, profileId);
  const cloud = useCloudAssistant(profileId, semesterChatContext);

  const dueResult = useMemo(() => collectDueReminders(reminders, {
    now,
    deliveredIds: state.deliveredIds,
  }), [nowEpoch, reminders, state.deliveredIds]);
  const dueSignature = dueResult.reminders
    .map((reminder) => reminder.deliveryId || getReminderDeliveryId(reminder))
    .join("|");

  useEffect(() => {
    setState((current) => {
      if (current.lastDailyBriefingDate === todayKey) return current;
      const briefing = buildDailyBriefing(context);
      return {
        ...current,
        lastDailyBriefingDate: todayKey,
        messages: trimMessages([
          ...current.messages,
          assistantMessage(briefing, { kind: "daily" }),
        ]),
      };
    });
  }, [context, todayKey]);

  useEffect(() => {
    if (!dueSignature) return;

    setState((current) => {
      const fresh = collectDueReminders(reminders, {
        now,
        deliveredIds: current.deliveredIds,
      });
      if (!fresh.reminders.length) return current;
      return {
        ...current,
        deliveredIds: fresh.deliveredIds.slice(-MAX_DELIVERED_IDS),
        messages: trimMessages([
          ...current.messages,
          ...fresh.reminders.map((reminder) => assistantMessage(reminder, {
            kind: "reminder",
            reminderId: reminder.deliveryId || getReminderDeliveryId(reminder),
          })),
        ]),
      };
    });

  }, [dueSignature]);

  const sendMessage = useCallback((text) => {
    const clean = String(text || "").trim();
    if (!clean) return;
    const response = answerAssistantQuery(clean, { ...context, reminders });
    setState((current) => ({
      ...current,
      messages: trimMessages([
        ...current.messages,
        userMessage(clean),
        assistantMessage(response),
      ]),
    }));
  }, [context, reminders]);

  const clearMessages = useCallback(() => {
    const briefing = buildDailyBriefing(context);
    setState((current) => ({
      ...current,
      messages: [assistantMessage(briefing, { kind: "daily" })],
      lastDailyBriefingDate: todayKey,
    }));
    setNotice(syncMode === "cloud" ? "Chat cleared from your synced account." : "Chat cleared from this device.");
  }, [context, syncMode, todayKey]);

  const delivered = useMemo(() => new Set(state.deliveredIds), [state.deliveredIds]);
  const upcomingReminders = useMemo(() => reminders
    .filter((reminder) => new Date(reminder.targetAt).getTime() > nowEpoch)
    .map((reminder) => ({
      ...reminder,
      delivered: delivered.has(getReminderDeliveryId(reminder)),
    }))
    .filter((reminder) => !reminder.delivered)
    .slice(0, 8), [delivered, nowEpoch, reminders]);

  return {
    cloud,
    clearMessages,
    disableNotifications: push.disable,
    enableNotifications: push.enable,
    messages: state.messages,
    notice,
    notificationPermission: push.permission,
    notificationsEnabled: push.enabled,
    push,
    reminders,
    sendMessage,
    setNotice,
    syncMode,
    upcomingReminders,
  };
}
