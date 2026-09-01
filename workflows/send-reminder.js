import webPush from "web-push";
import { FatalError, sleep } from "workflow";
import { requireVapidConfig } from "../server/pushSecurity.js";

const MAX_WEB_PUSH_TTL_SECONDS = 28 * 24 * 60 * 60;

function pushPayload(occurrence, revision, { test = false } = {}) {
  return JSON.stringify({
    v: 1,
    id: occurrence.id,
    type: test ? "test" : occurrence.type,
    revision,
    targetAt: occurrence.targetAt,
  });
}

function pushOptions(occurrence, now = Date.now()) {
  const targetEpoch = Date.parse(occurrence.targetAt);
  const remainingSeconds = Math.max(0, Math.floor((targetEpoch - now) / 1000));
  return {
    TTL: Math.min(remainingSeconds, MAX_WEB_PUSH_TTL_SECONDS),
    topic: occurrence.id.slice(0, 32),
    urgency: occurrence.type === "class-1h" ? "high" : "normal",
  };
}

function statusCodeFromError(error) {
  const statusCode = Number(error?.statusCode);
  return Number.isInteger(statusCode) ? statusCode : null;
}

export async function sendReminderStep(subscription, occurrence, revision, options = {}) {
  "use step";

  const now = Date.now();
  if (Date.parse(occurrence.targetAt) <= now) return { status: "expired" };

  const vapid = requireVapidConfig();
  webPush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  try {
    await webPush.sendNotification(
      subscription,
      pushPayload(occurrence, revision, options),
      pushOptions(occurrence, now),
    );
    return { status: "sent" };
  } catch (error) {
    const statusCode = statusCodeFromError(error);
    if (statusCode === 404 || statusCode === 410) return { status: "subscription-gone" };
    if (statusCode !== null && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
      throw new FatalError(`Web Push rejected the request (${statusCode}).`);
    }
    throw error;
  }
}

export async function sendReminderScheduleWorkflow(subscription, revision, reminders) {
  "use workflow";

  let sent = 0;
  for (const occurrence of reminders) {
    await sleep(new Date(occurrence.remindAt));
    const result = await sendReminderStep(subscription, occurrence, revision);
    if (result.status === "subscription-gone") {
      return { status: "subscription-gone", sent };
    }
    if (result.status === "sent") sent += 1;
  }
  return { status: "complete", sent };
}

export const __pushInternals = Object.freeze({
  pushOptions,
  pushPayload,
});
