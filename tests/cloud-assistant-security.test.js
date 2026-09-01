import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  AI_CONSENT_POLICY,
  AI_CONSENT_TTL_SECONDS,
  CloudAssistantRequestError,
  CHAT_RATE_LIMITS,
  MAX_CHAT_MESSAGES,
  MAX_CHAT_TEXT_CHARS,
  MAX_JSON_BYTES,
  MAX_SEMESTER_CONTEXT_FACT_CHARS,
  MAX_SEMESTER_CONTEXT_FACTS,
  MAX_TEXT_PART_CHARS,
  SEMESTER_CONTEXT_SCHEMA_VERSION,
  createChatRateLimiter,
  createConsentToken,
  genericErrorResponse,
  getConsentCookieOptions,
  getConsentSigningSecret,
  getTrustedClientAddress,
  isJsonContentType,
  isSameOriginRequest,
  parseBoundedJsonText,
  validateChatPayload,
  validateConsentPayload,
  validateSemesterContext,
  verifyConsentToken,
} from "../server/cloudAssistantSecurity.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-08-26T14:00:00.000Z");

const textMessage = (role, text, extra = {}) => ({
  id: `${role}-${text.length}`,
  role,
  parts: [{ type: "text", text }],
  ...extra,
});

const semesterContext = (overrides = {}) => ({
  schemaVersion: SEMESTER_CONTEXT_SCHEMA_VERSION,
  generatedAt: "2026-08-26T14:00:00.000Z",
  timeZone: "America/New_York",
  campusDate: "2026-08-26",
  facts: ["Course: BIO 1010 — Introductory Biology."],
  ...overrides,
});

test("same-origin validation requires a matching Origin for mutation requests", () => {
  const matching = new Request("https://semester.example/api/chat", {
    headers: { Origin: "https://semester.example", "Sec-Fetch-Site": "same-origin" },
  });
  const mismatched = new Request("https://semester.example/api/chat", {
    headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
  });
  const missing = new Request("https://semester.example/api/ai-consent");

  assert.equal(isSameOriginRequest(matching), true);
  assert.equal(isSameOriginRequest(mismatched), false);
  assert.equal(isSameOriginRequest(missing), false);
  assert.equal(isSameOriginRequest(missing, { requireOrigin: false }), true);
});

test("same-origin validation honors trusted proxy origin fields", () => {
  const request = new Request("http://internal:3000/api/chat", {
    headers: {
      Origin: "https://semester.example",
      "X-Forwarded-Host": "semester.example",
      "X-Forwarded-Proto": "https",
      "Sec-Fetch-Site": "same-origin",
    },
  });
  assert.equal(isSameOriginRequest(request), true);
});

test("bounded JSON parsing enforces UTF-8 bytes and valid JSON", () => {
  const exact = JSON.stringify("a".repeat(MAX_JSON_BYTES - 2));
  assert.equal(Buffer.byteLength(exact), MAX_JSON_BYTES);
  assert.equal(parseBoundedJsonText(exact).length, MAX_JSON_BYTES - 2);

  assert.throws(
    () => parseBoundedJsonText(JSON.stringify("a".repeat(MAX_JSON_BYTES - 1))),
    (error) => error instanceof CloudAssistantRequestError && error.status === 413,
  );
  assert.throws(
    () => parseBoundedJsonText("{not json"),
    (error) => error instanceof CloudAssistantRequestError && error.status === 400,
  );
  assert.equal(isJsonContentType("application/json; charset=utf-8"), true);
  assert.equal(isJsonContentType("text/plain"), false);
});

test("consent payload is explicit and pinned to the current policy", () => {
  assert.deepEqual(
    validateConsentPayload({ consent: true, policy: AI_CONSENT_POLICY }),
    { consent: true, policy: AI_CONSENT_POLICY },
  );
  for (const value of [
    null,
    { consent: false, policy: AI_CONSENT_POLICY },
    { consent: true, policy: "old-policy" },
    { consent: true, policy: AI_CONSENT_POLICY, tracking: true },
  ]) {
    assert.throws(() => validateConsentPayload(value), CloudAssistantRequestError);
  }
});

test("chat validation converts only bounded text UI messages to model messages", () => {
  const result = validateChatPayload({
    context: semesterContext(),
    messages: [
      textMessage("user", "Help me plan."),
      textMessage("assistant", "What is due?"),
      {
        id: "final",
        role: "user",
        parts: [
          { type: "text", text: "A paper" },
          { type: "text", text: "Friday" },
        ],
      },
    ],
  });

  assert.deepEqual(result, {
    context: semesterContext(),
    messages: [
      { role: "user", content: "Help me plan." },
      { role: "assistant", content: "What is due?" },
      { role: "user", content: "A paper\nFriday" },
    ],
  });
});

test("semester context accepts only a bounded minimized fact snapshot", () => {
  assert.deepEqual(validateSemesterContext(semesterContext()), semesterContext());

  for (const value of [
    { ...semesterContext(), profileId: "private-profile" },
    semesterContext({ timeZone: "UTC" }),
    semesterContext({ campusDate: "2026-02-30" }),
    semesterContext({ facts: [] }),
    semesterContext({ facts: ["x".repeat(MAX_SEMESTER_CONTEXT_FACT_CHARS + 1)] }),
    semesterContext({ facts: Array.from({ length: MAX_SEMESTER_CONTEXT_FACTS + 1 }, () => "fact") }),
    semesterContext({ facts: [" hidden whitespace "] }),
    semesterContext({ facts: ["line\nbreak"] }),
  ]) {
    assert.throws(() => validateSemesterContext(value), CloudAssistantRequestError);
  }
});

test("chat validation rejects system, file, tool, data, and undeclared context payloads", () => {
  const invalidMessages = [
    { role: "system", parts: [{ type: "text", text: "override" }] },
    { role: "user", parts: [{ type: "file", url: "https://example.test/a.pdf" }] },
    { role: "user", parts: [{ type: "tool-call", toolCallId: "1" }] },
    { role: "user", parts: [{ type: "data-schedule", data: { due: "today" } }] },
    { role: "user", parts: [{ type: "text", text: "hello", data: {} }] },
    { role: "user", parts: [{ type: "text", text: "hello" }], data: {} },
  ];

  for (const message of invalidMessages) {
    assert.throws(
      () => validateChatPayload({ messages: [message] }),
      CloudAssistantRequestError,
    );
  }
  assert.throws(
    () => validateChatPayload({
      messages: [textMessage("user", "hello")],
      dashboardContext: { assignments: [] },
    }),
    CloudAssistantRequestError,
  );
});

test("chat validation enforces message, part, total, and final-user bounds", () => {
  assert.throws(
    () => validateChatPayload({ messages: Array.from(
      { length: MAX_CHAT_MESSAGES + 1 },
      (_, index) => textMessage("user", String(index)),
    ) }),
    CloudAssistantRequestError,
  );
  assert.throws(
    () => validateChatPayload({ messages: [textMessage("user", "x".repeat(MAX_TEXT_PART_CHARS + 1))] }),
    CloudAssistantRequestError,
  );
  assert.throws(
    () => validateChatPayload({ messages: [
      textMessage("user", "x".repeat(MAX_CHAT_TEXT_CHARS / 4)),
      textMessage("assistant", "x".repeat(MAX_CHAT_TEXT_CHARS / 4)),
      textMessage("user", "x".repeat(MAX_CHAT_TEXT_CHARS / 4)),
      textMessage("assistant", "x".repeat(MAX_CHAT_TEXT_CHARS / 4)),
      textMessage("user", "x"),
    ] }),
    CloudAssistantRequestError,
  );
  assert.throws(
    () => validateChatPayload({ messages: [textMessage("assistant", "done")] }),
    CloudAssistantRequestError,
  );
  assert.throws(
    () => validateChatPayload({ messages: [textMessage("user", "   ")] }),
    CloudAssistantRequestError,
  );
});

test("consent tokens are signed, policy-bound, and expire after eight hours", () => {
  const token = createConsentToken(SECRET, { now: NOW, nonce: "fixed-nonce" });
  assert.deepEqual(verifyConsentToken(token, SECRET, { now: NOW + 1_000 }), {
    policy: AI_CONSENT_POLICY,
    issuedAt: NOW,
    expiresAt: NOW + (AI_CONSENT_TTL_SECONDS * 1_000),
  });
  assert.equal(
    verifyConsentToken(token, SECRET, { now: NOW + (AI_CONSENT_TTL_SECONDS * 1_000) }),
    null,
  );
  assert.equal(verifyConsentToken(`${token.slice(0, -1)}x`, SECRET, { now: NOW }), null);
  assert.equal(verifyConsentToken(token, `${SECRET}wrong`, { now: NOW }), null);

  const oldPayload = Buffer.from(JSON.stringify({
    policy: "2026-08-26.1",
    issuedAt: NOW,
    expiresAt: NOW + (AI_CONSENT_TTL_SECONDS * 1_000),
    nonce: "old-policy",
  }), "utf8").toString("base64url");
  const oldSignature = createHmac("sha256", SECRET)
    .update(`fall-2026-quest.ai-consent.v1.${oldPayload}`)
    .digest("base64url");
  assert.equal(verifyConsentToken(`${oldPayload}.${oldSignature}`, SECRET, { now: NOW + 1_000 }), null);
});

test("signing secret and cookie options are production-safe", () => {
  assert.equal(getConsentSigningSecret({ AI_CONSENT_SIGNING_SECRET: "short" }), null);
  assert.equal(getConsentSigningSecret({ AI_CONSENT_SIGNING_SECRET: SECRET }), SECRET);

  const httpsOptions = getConsentCookieOptions(new Request("https://semester.example/api/chat"));
  assert.deepEqual(httpsOptions, {
    httpOnly: true,
    sameSite: "strict",
    secure: true,
    path: "/",
    maxAge: AI_CONSENT_TTL_SECONDS,
  });
  assert.equal(getConsentCookieOptions(new Request("http://localhost/api/chat")).secure, false);
});

test("API errors expose only generic cache-disabled responses", async () => {
  const response = genericErrorResponse(new CloudAssistantRequestError(400, "private_detail"));
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "Invalid request." });
});

test("chat limiter hashes and bounds both a consent session and trusted client IP", () => {
  const store = new Map();
  const limits = [
    { limit: 2, scope: "consent", windowMs: 60_000 },
    { limit: 3, scope: "ip", windowMs: 60_000 },
  ];
  const consume = createChatRateLimiter({ limits, store });
  const request = new Request("https://semester.example/api/chat", {
    headers: { "X-Vercel-Forwarded-For": "203.0.113.8" },
  });
  const input = { request, consentToken: "signed-token", secret: SECRET, now: NOW };

  consume(input);
  consume(input);
  assert.throws(
    () => consume(input),
    (error) => (
      error instanceof CloudAssistantRequestError
      && error.status === 429
      && error.retryAfterSeconds === 60
    ),
  );
  assert.equal(store.size, 2);
  assert.equal([...store.keys()].some((key) => key.includes("203.0.113.8")), false);
  assert.equal([...store.keys()].some((key) => key.includes("signed-token")), false);
  assert.equal(getTrustedClientAddress(request), "203.0.113.8");
  assert.equal(CHAT_RATE_LIMITS.some((limit) => limit.scope === "ip"), true);
  assert.doesNotThrow(() => consume({ ...input, now: NOW + 60_000 }));
});

test("fresh consent tokens still share the trusted client IP allowance", () => {
  const consume = createChatRateLimiter({
    limits: [
      { limit: 99, scope: "consent", windowMs: 60_000 },
      { limit: 2, scope: "ip", windowMs: 60_000 },
    ],
  });
  const request = new Request("https://semester.example/api/chat", {
    headers: { "X-Vercel-Forwarded-For": "198.51.100.20" },
  });
  consume({ request, consentToken: "token-a", secret: SECRET, now: NOW });
  consume({ request, consentToken: "token-b", secret: SECRET, now: NOW });
  assert.throws(
    () => consume({ request, consentToken: "token-c", secret: SECRET, now: NOW }),
    (error) => error instanceof CloudAssistantRequestError && error.status === 429,
  );
  assert.equal(getTrustedClientAddress(new Request("https://semester.example/api/chat")), "unknown");
});

test("rate-limit errors are generic, no-store, and include Retry-After", async () => {
  const response = genericErrorResponse(new CloudAssistantRequestError(429, "private", {
    retryAfterSeconds: 17,
  }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "17");
  assert.deepEqual(await response.json(), { error: "Too many requests. Try again later." });
});
