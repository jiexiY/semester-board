import {
  defineEventHandler,
  deleteCookie,
} from "nitro/h3";

import {
  AI_CONSENT_COOKIE,
  AI_CONSENT_POLICY,
  genericErrorResponse,
  getConsentCookieOptions,
  getConsentSigningSecret,
  noStoreJson,
  requireSameOrigin,
} from "../server/cloudAssistantSecurity.js";

export function createAiConsentDeleteHandler({ environment = process.env } = {}) {
  return defineEventHandler((event) => {
    try {
      requireSameOrigin(event);
      deleteCookie(event, AI_CONSENT_COOKIE, getConsentCookieOptions(event.req));
      return noStoreJson({
        available: Boolean(getConsentSigningSecret(environment)),
        consented: false,
        policy: AI_CONSENT_POLICY,
        expiresAt: null,
      });
    } catch (error) {
      return genericErrorResponse(error);
    }
  });
}

export default createAiConsentDeleteHandler();
