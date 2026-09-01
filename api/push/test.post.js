import { defineEventHandler } from "nitro/h3";
import webPush from "web-push";
import {
  errorResponse,
  jsonResponse,
  readJsonRequest,
  validateTestPayload,
} from "../../server/pushProtocol.js";
import {
  assertSameOriginRequest,
  consumePushRateLimit,
  requireSigningSecret,
  requireVapidConfig,
  verifyPushReceiptForSubscription,
} from "../../server/pushSecurity.js";

export async function sendTestNotification(subscription, revision, vapid) {
  const now = Date.now();
  const targetAt = new Date(now + 5 * 60 * 1000).toISOString();
  webPush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  try {
    await webPush.sendNotification(subscription, JSON.stringify({
      v: 1,
      id: revision,
      type: "test",
      revision,
      targetAt,
    }), {
      TTL: Math.max(0, Math.floor((Date.parse(targetAt) - Date.now()) / 1000)),
      topic: revision.slice(0, 32),
      urgency: "normal",
    });
    return { status: "sent" };
  } catch (error) {
    if (error?.statusCode === 404 || error?.statusCode === 410) {
      return { status: "subscription-gone" };
    }
    throw error;
  }
}

export function createPushTestHandler({
  environment = process.env,
  now = () => Date.now(),
  rateLimit = consumePushRateLimit,
  send = sendTestNotification,
} = {}) {
  return defineEventHandler(async (event) => {
    try {
      assertSameOriginRequest(event.req);
      const body = validateTestPayload(await readJsonRequest(event.req));
      const signingSecret = requireSigningSecret(environment);
      const issuedReceipt = verifyPushReceiptForSubscription(
        body.receipt,
        body.subscription,
        signingSecret,
        { now: now() },
      );
      const vapid = requireVapidConfig(environment);
      await rateLimit({
        action: "test",
        now: now(),
        request: event.req,
        secret: signingSecret,
        subscription: body.subscription,
      });
      const result = await send(body.subscription, issuedReceipt.revision, vapid);
      if (result.status !== "sent") {
        const error = new Error("This push subscription is no longer active.");
        error.code = "subscription_gone";
        error.status = 410;
        throw error;
      }
      return jsonResponse({ ok: true });
    } catch (error) {
      return errorResponse(error);
    }
  });
}

export default createPushTestHandler();
