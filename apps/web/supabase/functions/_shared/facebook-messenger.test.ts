import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MESSENGER_LIMITS,
  canApplyMessengerEventUpdate,
  constantTimeStringEqual,
  normalizeMessengerWebhook,
  verifyMessengerSignature,
  evaluateMessengerSendPolicy,
} from "./facebook-messenger.ts";

const encoder = new TextEncoder();
const APP_SECRET = "unit-test-app-secret";
const PAGE_ID = "page-123";
const PSID = "user-456";
const MID = "mid.$abc";

async function hmacSha256Hex(secret: string, rawBody: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, rawBody);
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedHeader(rawBody: Uint8Array, secret = APP_SECRET): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, rawBody)}`;
}

function rawJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function baseWebhook(overrides: Record<string, unknown> = {}) {
  return {
    object: "page",
    entry: [
      {
        id: PAGE_ID,
        time: 1_800_000_000_000,
        messaging: [
          {
            sender: { id: PSID },
            recipient: { id: PAGE_ID },
            timestamp: 1_800_000_000_111,
            message: { mid: MID, text: "hello", attachments: [{ type: "image", payload: { url: "https://example.test/image.jpg" } }] },
          },
        ],
      },
    ],
    ...overrides,
  };
}

test("constant-time string comparison requires exact equal strings", () => {
  assert.equal(constantTimeStringEqual("abc123", "abc123"), true);
  assert.equal(constantTimeStringEqual("abc123", "abc124"), false);
  assert.equal(constantTimeStringEqual("abc123", "abc1234"), false);
});

test("verifies X-Hub-Signature-256 over exact raw bytes and rejects tampering", async () => {
  const rawBody = rawJson(baseWebhook());
  const header = await signedHeader(rawBody);

  assert.equal(await verifyMessengerSignature({ rawBody, signatureHeader: header, appSecret: APP_SECRET }), true);

  const tamperedBody = encoder.encode(new TextDecoder().decode(rawBody).replace("hello", "hullo"));
  assert.equal(await verifyMessengerSignature({ rawBody: tamperedBody, signatureHeader: header, appSecret: APP_SECRET }), false);
});

test("rejects missing and malformed Messenger signatures", async () => {
  const rawBody = rawJson(baseWebhook());

  assert.equal(await verifyMessengerSignature({ rawBody, signatureHeader: null, appSecret: APP_SECRET }), false);
  assert.equal(await verifyMessengerSignature({ rawBody, signatureHeader: "sha1=abcd", appSecret: APP_SECRET }), false);
  assert.equal(await verifyMessengerSignature({ rawBody, signatureHeader: "sha256=not-hex", appSecret: APP_SECRET }), false);
});

test("normalizes supported Messenger event families for the exact configured Page", async () => {
  const rawBody = rawJson(baseWebhook({
    entry: [{
      id: PAGE_ID,
      time: 1_800_000_000_000,
      messaging: [
        { sender: { id: PSID }, recipient: { id: PAGE_ID }, timestamp: 1, message: { mid: "m1", text: "inbound" } },
        { sender: { id: PAGE_ID }, recipient: { id: PSID }, timestamp: 2, message: { mid: "m2", is_echo: true, text: "echo" } },
        { sender: { id: PSID }, recipient: { id: PAGE_ID }, timestamp: 3, delivery: { mids: ["m1"], watermark: 3 } },
        { sender: { id: PSID }, recipient: { id: PAGE_ID }, timestamp: 4, read: { watermark: 4 } },
        { sender: { id: PSID }, recipient: { id: PAGE_ID }, timestamp: 5, postback: { title: "Start", payload: "GET_STARTED" } },
        { sender: { id: PSID }, recipient: { id: PAGE_ID }, timestamp: 6, policy_enforcement: { action: "block", reason: "spam" } },
      ],
    }],
  }));

  const result = await normalizeMessengerWebhook({ rawBody, expectedPageId: PAGE_ID });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.events.map((event) => event.kind) : [], [
    "message",
    "message_echo",
    "message_delivery",
    "message_read",
    "messaging_postback",
    "messaging_policy_enforcement",
  ]);
  if (!result.ok) assert.fail("normalization failed");
  assert.equal(result.events[0].pageId, PAGE_ID);
  assert.equal(result.events[0].senderId, PSID);
  assert.equal(result.events[0].text, "inbound");
  assert.equal(result.events[0].attachments.length, 0);
  assert.equal(result.events[1].senderId, PAGE_ID);
});

test("fails closed for non-page object, wrong Page, oversized body, too many events, and oversized text or attachments", async () => {
  assert.equal((await normalizeMessengerWebhook({ rawBody: rawJson(baseWebhook({ object: "user" })), expectedPageId: PAGE_ID })).ok, false);
  assert.equal((await normalizeMessengerWebhook({ rawBody: rawJson(baseWebhook({ entry: [{ id: "other-page", messaging: [] }] })), expectedPageId: PAGE_ID })).ok, false);

  const oversizedBody = encoder.encode("{" + " ".repeat(DEFAULT_MESSENGER_LIMITS.maxBodyBytes + 1) + "}");
  assert.equal((await normalizeMessengerWebhook({ rawBody: oversizedBody, expectedPageId: PAGE_ID })).ok, false);

  const tooManyEvents = Array.from({ length: DEFAULT_MESSENGER_LIMITS.maxMessagingEventsPerEntry + 1 }, (_, index) => ({
    sender: { id: PSID }, recipient: { id: PAGE_ID }, timestamp: index + 1, message: { mid: `m${index}`, text: "x" },
  }));
  assert.equal((await normalizeMessengerWebhook({ rawBody: rawJson(baseWebhook({ entry: [{ id: PAGE_ID, messaging: tooManyEvents }] })), expectedPageId: PAGE_ID })).ok, false);

  const oversizedText = "x".repeat(DEFAULT_MESSENGER_LIMITS.maxTextChars + 1);
  assert.equal((await normalizeMessengerWebhook({ rawBody: rawJson(baseWebhook({ entry: [{ id: PAGE_ID, messaging: [{ sender: { id: PSID }, recipient: { id: PAGE_ID }, timestamp: 1, message: { mid: "m", text: oversizedText } }] }] })), expectedPageId: PAGE_ID })).ok, false);

  const tooManyAttachments = Array.from({ length: DEFAULT_MESSENGER_LIMITS.maxAttachmentsPerMessage + 1 }, () => ({ type: "image", payload: {} }));
  assert.equal((await normalizeMessengerWebhook({ rawBody: rawJson(baseWebhook({ entry: [{ id: PAGE_ID, messaging: [{ sender: { id: PSID }, recipient: { id: PAGE_ID }, timestamp: 1, message: { mid: "m", attachments: tooManyAttachments } }] }] })), expectedPageId: PAGE_ID })).ok, false);
});

test("uses a stable duplicate fingerprint when Messenger MID is absent", async () => {
  const eventWithoutMid = { sender: { id: PSID }, recipient: { id: PAGE_ID }, timestamp: 9, message: { text: "same" } };
  const first = await normalizeMessengerWebhook({ rawBody: rawJson(baseWebhook({ entry: [{ id: PAGE_ID, messaging: [eventWithoutMid] }] })), expectedPageId: PAGE_ID });
  const second = await normalizeMessengerWebhook({ rawBody: rawJson(baseWebhook({ entry: [{ id: PAGE_ID, messaging: [eventWithoutMid] }] })), expectedPageId: PAGE_ID });

  if (!first.ok || !second.ok) throw new Error("normalization failed");
  assert.equal(first.events[0].messengerMessageId, null);
  assert.equal(first.events[0].fingerprint, second.events[0].fingerprint);
  assert.match(first.events[0].fingerprint, /^fbmsg_[a-f0-9]{64}$/);
});

test("ordering helper prevents older Messenger events from overwriting newer state", () => {
  assert.equal(canApplyMessengerEventUpdate({ incomingTimestampMs: 101, currentTimestampMs: 100 }), true);
  assert.equal(canApplyMessengerEventUpdate({ incomingTimestampMs: 100, currentTimestampMs: 100 }), true);
  assert.equal(canApplyMessengerEventUpdate({ incomingTimestampMs: 99, currentTimestampMs: 100 }), false);
  assert.equal(canApplyMessengerEventUpdate({ incomingTimestampMs: 99, currentTimestampMs: null }), true);
});

test("send policy permits RESPONSE only inside the 24 hour standard messaging window", () => {
  const nowMs = Date.UTC(2026, 8, 3, 12, 0, 0);
  assert.equal(evaluateMessengerSendPolicy({ requestedTag: "RESPONSE", nowMs, lastUserMessageAtMs: nowMs - 24 * 60 * 60 * 1000 }).allowed, true);
  assert.equal(evaluateMessengerSendPolicy({ requestedTag: "RESPONSE", nowMs, lastUserMessageAtMs: nowMs - 24 * 60 * 60 * 1000 - 1 }).allowed, false);
});

test("send policy permits HUMAN_AGENT only for approved authenticated humans inside seven days", () => {
  const nowMs = Date.UTC(2026, 8, 3, 12, 0, 0);
  assert.equal(evaluateMessengerSendPolicy({ requestedTag: "HUMAN_AGENT", nowMs, lastUserMessageAtMs: nowMs - 7 * 24 * 60 * 60 * 1000, actorType: "human", actorAuthenticated: true, humanAgentFeatureEnabled: true, humanAgentApproved: true }).allowed, true);
  assert.equal(evaluateMessengerSendPolicy({ requestedTag: "HUMAN_AGENT", nowMs, lastUserMessageAtMs: nowMs - 1, actorType: "ai", actorAuthenticated: true, humanAgentFeatureEnabled: true, humanAgentApproved: true }).allowed, false);
  assert.equal(evaluateMessengerSendPolicy({ requestedTag: "HUMAN_AGENT", nowMs, lastUserMessageAtMs: nowMs - 1, actorType: "human", actorAuthenticated: true, humanAgentFeatureEnabled: false, humanAgentApproved: true }).allowed, false);
  assert.equal(evaluateMessengerSendPolicy({ requestedTag: "HUMAN_AGENT", nowMs, lastUserMessageAtMs: nowMs - 7 * 24 * 60 * 60 * 1000 - 1, actorType: "human", actorAuthenticated: true, humanAgentFeatureEnabled: true, humanAgentApproved: true }).allowed, false);
});

test("send policy explicitly denies deprecated Messenger tags", () => {
  const nowMs = Date.UTC(2026, 8, 3, 12, 0, 0);
  for (const requestedTag of ["CONFIRMED_EVENT_UPDATE", "ACCOUNT_UPDATE", "POST_PURCHASE_UPDATE"] as const) {
    const decision = evaluateMessengerSendPolicy({ requestedTag, nowMs, lastUserMessageAtMs: nowMs });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "deprecated_tag_denied");
  }
});
