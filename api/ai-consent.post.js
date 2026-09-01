import {
  defineEventHandler,
  setCookie,
} from "nitro/h3";

import {
  AI_CONSENT_COOKIE,
  AI_CONSENT_POLICY,
  CloudAssistantRequestError,
  createConsentToken,
  genericErrorResponse,
  getConsentCookieOptions,
  getConsentSigningSecret,
  noStoreJson,
  readBoundedJson,
  requireSameOrigin,
  validateConsentPayload,
  verifyConsentToken,
} from "../server/cloudAssistantSecurity.js";

export function createAiConsentPostHandler({
  environment = process.env,
  now = () => Date.now(),
} = {}) {
  return defineEventHandler(async (event) => {
    try {
      requireSameOrigin(event);
      validateConsentPayload(await readBoundedJson(event));

      const secret = getConsentSigningSecret(environment);
      if (!secret) {
        throw new CloudAssistantRequestError(503, "consent_not_configured");
      }

      const issuedAt = now();
      const token = createConsentToken(secret, { now: issuedAt });
      const verified = verifyConsentToken(token, secret, { now: issuedAt });
      if (!verified) {
        throw new CloudAssistantRequestError(500, "consent_token_creation_failed");
      }
      setCookie(event, AI_CONSENT_COOKIE, token, getConsentCookieOptions(event.req));

      return noStoreJson({
        available: true,
        consented: true,
        policy: AI_CONSENT_POLICY,
        expiresAt: new Date(verified.expiresAt).toISOString(),
      });
    } catch (error) {
      return genericErrorResponse(error);
    }
  });
}

export default createAiConsentPostHandler();
