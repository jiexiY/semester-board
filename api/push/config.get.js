import { defineEventHandler } from "nitro/h3";
import { errorResponse, jsonResponse } from "../../server/pushProtocol.js";
import { getVapidPublicKey } from "../../server/pushSecurity.js";

export default defineEventHandler(() => {
  try {
    return jsonResponse({
      available: true,
      publicKey: getVapidPublicKey(),
    });
  } catch (error) {
    return errorResponse(error);
  }
});
