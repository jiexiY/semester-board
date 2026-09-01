import { defineEventHandler } from "nitro/h3";
import { getRun, start } from "workflow/api";
import {
  errorResponse,
  jsonResponse,
  readJsonRequest,
  validateSyncPayload,
} from "../../server/pushProtocol.js";
import {
  assertSameOriginRequest,
  consumePushRateLimit,
  pushSubscriptionFingerprint,
  receiptExpiryForSchedule,
  requireSigningSecret,
  requireVapidConfig,
  signPushReceipt,
  verifyPushReceipt,
} from "../../server/pushSecurity.js";
import { sendReminderScheduleWorkflow } from "../../workflows/send-reminder.js";

async function cancelRuns(runIds) {
  const terminalStatuses = new Set(["cancelled", "completed", "failed"]);
  await Promise.all(runIds.map(async (runId) => {
    const run = getRun(runId);
    if (!(await run.exists)) return;
    if (terminalStatuses.has(await run.status)) return;
    try {
      await run.cancel();
    } catch (error) {
      if (terminalStatuses.has(await run.status)) return;
      throw error;
    }
  }));
}

function serviceUnavailable(message) {
  const error = new Error(message);
  error.code = "workflow_unavailable";
  error.status = 503;
  return error;
}

export default defineEventHandler(async (event) => {
  let replacementRun = null;
  try {
    assertSameOriginRequest(event.req);
    const body = validateSyncPayload(await readJsonRequest(event.req));
    const signingSecret = requireSigningSecret();
    requireVapidConfig();

    const previous = body.previousReceipt
      ? verifyPushReceipt(body.previousReceipt, signingSecret)
      : null;

    await consumePushRateLimit({
      action: "sync",
      request: event.req,
      secret: signingSecret,
      subscription: body.subscription,
    });
    if (body.reminders.length > 0) {
      replacementRun = await start(sendReminderScheduleWorkflow, [
        body.subscription,
        body.revision,
        body.reminders,
      ]);
    }

    if (previous?.runIds.length) {
      try {
        await cancelRuns(previous.runIds);
      } catch {
        if (replacementRun) await replacementRun.cancel().catch(() => {});
        throw serviceUnavailable("The previous reminder schedule could not be replaced safely.");
      }
    }

    const expiresAt = receiptExpiryForSchedule(body.reminders);
    const receipt = signPushReceipt({
      expiresAt,
      revision: body.revision,
      runIds: replacementRun ? [replacementRun.runId] : [],
      subscriptionHash: pushSubscriptionFingerprint(body.subscription, signingSecret),
    }, signingSecret);

    return jsonResponse({
      ok: true,
      expiresAt,
      receipt,
      revision: body.revision,
      scheduled: body.reminders.length,
    });
  } catch (error) {
    if (replacementRun) await replacementRun.cancel().catch(() => {});
    return errorResponse(error);
  }
});
