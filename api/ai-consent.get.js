import {
  defineEventHandler,
  getCookie,
} from "nitro/h3";

import {
  AI_CONSENT_COOKIE,
  AI_CONSENT_POLICY,
  genericErrorResponse,
  getConsentSigningSecret,
  noStoreJson,
  requireSameOrigin,
  verifyConsentToken,
} from "../server/cloudAssistantSecurity.js";

export function createAiConsentGetHandler({
  environment = process.env,
  now = () => Date.now(),
} = {}) {
  return defineEventHandler((event) => {
    try {
      requireSameOrigin(event, { requireOrigin: false });
      const secret = getConsentSigningSecret(environment);
      if (!secret) {
        return noStoreJson({
          available: false,
          consented: false,
          policy: AI_CONSENT_POLICY,
          expiresAt: null,
        });
      }

      const consent = verifyConsentToken(
        getCookie(event, AI_CONSENT_COOKIE),
        secret,
        { now: now() },
      );
      return noStoreJson({
        available: true,
        consented: Boolean(consent),
        policy: AI_CONSENT_POLICY,
        expiresAt: consent ? new Date(consent.expiresAt).toISOString() : null,
      });
    } catch (error) {
      return genericErrorResponse(error);
    }
  });
}

export default createAiConsentGetHandler();
