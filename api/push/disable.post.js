import { defineEventHandler } from "nitro/h3";
import { getRun } from "workflow/api";
import {
  errorResponse,
  jsonResponse,
  readJsonRequest,
  validateDisablePayload,
} from "../../server/pushProtocol.js";
import {
  assertSameOriginRequest,
  requireSigningSecret,
  verifyPushReceipt,
} from "../../server/pushSecurity.js";

async function cancelRunSafely(runId) {
  const terminalStatuses = new Set(["cancelled", "completed", "failed"]);
  const run = getRun(runId);
  if (!(await run.exists)) return false;
  if (terminalStatuses.has(await run.status)) return false;
  try {
    await run.cancel();
    return true;
  } catch (error) {
    if (terminalStatuses.has(await run.status)) return false;
    throw error;
  }
}

export default defineEventHandler(async (event) => {
  try {
    assertSameOriginRequest(event.req);
    const { receipt } = validateDisablePayload(await readJsonRequest(event.req));
    const signed = verifyPushReceipt(receipt, requireSigningSecret());
    const cancelled = await Promise.all(signed.runIds.map(cancelRunSafely));
    return jsonResponse({ ok: true, cancelled: cancelled.filter(Boolean).length });
  } catch (error) {
    return errorResponse(error);
  }
});
