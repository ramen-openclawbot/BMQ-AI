import {
  canApplyMessengerEventUpdate,
  constantTimeStringEqual,
  DEFAULT_MESSENGER_LIMITS,
  evaluateMessengerSendPolicy,
  normalizeMessengerWebhook,
  verifyMessengerSignature,
} from "./facebook-messenger.ts";
import type { MessengerLimits } from "./facebook-messenger.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const APP_SECRET = "unit-test-app-secret";
const PAGE_ID = "page-123";
const PSID = "user-456";
const MID = "mid.$abc";

type MessengerLimitsOverride = Partial<MessengerLimits>;

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      message ?? `expected ${format(actual)} to equal ${format(expected)}`,
    );
  }
}

function assertDeepEqual(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      message ?? `expected ${actualJson} to deeply equal ${expectedJson}`,
    );
  }
}

function assertMatch(actual: string, expected: RegExp, message?: string): void {
  if (!expected.test(actual)) {
    throw new Error(message ?? `expected ${actual} to match ${expected}`);
  }
}

function format(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

async function hmacSha256Hex(
  secret: string,
  rawBody: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    toArrayBuffer(rawBody),
  );
  return Array.from(new Uint8Array(signature)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function signedHeader(
  rawBody: Uint8Array,
  secret = APP_SECRET,
): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, rawBody)}`;
}

function rawJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function inboundMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sender: { id: PSID },
    recipient: { id: PAGE_ID },
    timestamp: 1_800_000_000_111,
    message: { mid: MID, text: "hello" },
    ...overrides,
  };
}

function referralEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sender: { id: PSID },
    recipient: { id: PAGE_ID },
    timestamp: 1_800_000_000_222,
    referral: { ref: "campaign-123", source: "SHORTLINK", type: "OPEN_THREAD" },
    ...overrides,
  };
}

function baseWebhook(overrides: Record<string, unknown> = {}) {
  return {
    object: "page",
    entry: [
      {
        id: PAGE_ID,
        time: 1_800_000_000_000,
        messaging: [
          inboundMessage({
            message: {
              mid: MID,
              text: "hello",
              attachments: [{
                type: "image",
                payload: { url: "https://example.test/image.jpg" },
              }],
            },
          }),
        ],
      },
    ],
    ...overrides,
  };
}

async function normalize(value: unknown, limits?: MessengerLimitsOverride) {
  return await normalizeMessengerWebhook({
    rawBody: rawJson(value),
    expectedPageId: PAGE_ID,
    limits,
  });
}

function repeatedEvents(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) =>
    inboundMessage({
      timestamp: index + 1,
      message: { mid: `m${index}`, text: "x" },
    }));
}

Deno.test("constant-time string comparison requires exact equal strings", () => {
  assertEqual(constantTimeStringEqual("abc123", "abc123"), true);
  assertEqual(constantTimeStringEqual("abc123", "abc124"), false);
  assertEqual(constantTimeStringEqual("abc123", "abc1234"), false);
});

Deno.test("verifies X-Hub-Signature-256 over exact raw bytes and rejects tampering", async () => {
  const rawBody = rawJson(baseWebhook());
  const header = await signedHeader(rawBody);

  assertEqual(
    await verifyMessengerSignature({
      rawBody,
      signatureHeader: header,
      appSecret: APP_SECRET,
    }),
    true,
  );

  const tamperedBody = encoder.encode(
    decoder.decode(rawBody).replace("hello", "hullo"),
  );
  assertEqual(
    await verifyMessengerSignature({
      rawBody: tamperedBody,
      signatureHeader: header,
      appSecret: APP_SECRET,
    }),
    false,
  );
});

Deno.test("rejects missing, malformed, whitespace-padded, and uppercase Messenger signatures", async () => {
  const rawBody = rawJson(baseWebhook());
  const header = await signedHeader(rawBody);
  const uppercaseHexHeader = `sha256=${
    header.slice("sha256=".length).toUpperCase()
  }`;

  assertEqual(
    await verifyMessengerSignature({
      rawBody,
      signatureHeader: null,
      appSecret: APP_SECRET,
    }),
    false,
  );
  assertEqual(
    await verifyMessengerSignature({
      rawBody,
      signatureHeader: "sha1=abcd",
      appSecret: APP_SECRET,
    }),
    false,
  );
  assertEqual(
    await verifyMessengerSignature({
      rawBody,
      signatureHeader: "sha256=not-hex",
      appSecret: APP_SECRET,
    }),
    false,
  );
  assertEqual(
    await verifyMessengerSignature({
      rawBody,
      signatureHeader: ` ${header}`,
      appSecret: APP_SECRET,
    }),
    false,
  );
  assertEqual(
    await verifyMessengerSignature({
      rawBody,
      signatureHeader: `${header} `,
      appSecret: APP_SECRET,
    }),
    false,
  );
  assertEqual(
    await verifyMessengerSignature({
      rawBody,
      signatureHeader: header.replace("sha256=", "SHA256="),
      appSecret: APP_SECRET,
    }),
    false,
  );
  assertEqual(
    await verifyMessengerSignature({
      rawBody,
      signatureHeader: uppercaseHexHeader,
      appSecret: APP_SECRET,
    }),
    false,
  );
});

Deno.test("normalizes supported Messenger event families for the exact configured Page", async () => {
  const rawBody = rawJson(baseWebhook({
    entry: [{
      id: PAGE_ID,
      time: 1_800_000_000_000,
      messaging: [
        inboundMessage({
          timestamp: 1,
          message: { mid: "m1", text: "inbound" },
        }),
        {
          sender: { id: PAGE_ID },
          recipient: { id: PSID },
          timestamp: 2,
          message: { mid: "m2", is_echo: true, text: "echo" },
        },
        {
          sender: { id: PSID },
          recipient: { id: PAGE_ID },
          timestamp: 3,
          delivery: { mids: ["m1"], watermark: 3 },
        },
        {
          sender: { id: PSID },
          recipient: { id: PAGE_ID },
          timestamp: 4,
          read: { watermark: 4 },
        },
        {
          sender: { id: PSID },
          recipient: { id: PAGE_ID },
          timestamp: 5,
          postback: { title: "Start", payload: "GET_STARTED" },
        },
        {
          sender: { id: PSID },
          recipient: { id: PAGE_ID },
          timestamp: 6,
          policy_enforcement: { action: "block", reason: "spam" },
        },
      ],
    }],
  }));

  const result = await normalizeMessengerWebhook({
    rawBody,
    expectedPageId: PAGE_ID,
  });

  assertEqual(result.ok, true);
  assertDeepEqual(result.ok ? result.events.map((event) => event.kind) : [], [
    "message",
    "message_echo",
    "message_delivery",
    "message_read",
    "messaging_postback",
    "messaging_policy_enforcement",
  ]);
  assert(result.ok, "normalization failed");
  assertEqual(result.events[0].pageId, PAGE_ID);
  assertEqual(result.events[0].senderId, PSID);
  assertEqual(result.events[0].text, "inbound");
  assertEqual(result.events[0].attachments.length, 0);
  assertEqual(result.events[1].senderId, PAGE_ID);
});

Deno.test("normalizes standalone Messenger referral events with bounded nullable fields", async () => {
  const result = await normalize(
    baseWebhook({ entry: [{ id: PAGE_ID, messaging: [referralEvent()] }] }),
  );

  assert(result.ok, "valid standalone referral should normalize");
  assertEqual(result.events.length, 1);
  assertEqual(result.events[0].kind, "messaging_referral");
  assertEqual(result.events[0].senderId, PSID);
  assertEqual(result.events[0].recipientId, PAGE_ID);
  assertEqual(result.events[0].referralRef, "campaign-123");
  assertEqual(result.events[0].referralSource, "SHORTLINK");
  assertEqual(result.events[0].referralType, "OPEN_THREAD");
  assertMatch(result.events[0].fingerprint, /^fbmsg_[a-f0-9]{64}$/);
});

Deno.test("rejects malformed Messenger referral fields fail-closed", async () => {
  for (
    const badReferral of [
      null,
      [],
      "campaign-123",
      { ref: 123, source: "SHORTLINK", type: "OPEN_THREAD" },
      { ref: "campaign-123", source: 123, type: "OPEN_THREAD" },
      { ref: "campaign-123", source: "SHORTLINK", type: 123 },
    ] as unknown[]
  ) {
    const result = await normalize(
      baseWebhook({
        entry: [{
          id: PAGE_ID,
          messaging: [referralEvent({ referral: badReferral })],
        }],
      }),
    );
    assertEqual(
      result.ok,
      false,
      `referral ${JSON.stringify(badReferral)} should be rejected`,
    );
    assertEqual(result.ok ? "" : result.error, "invalid_referral");
  }
});

Deno.test("enforces Messenger referral field length limits at and over boundaries", async () => {
  const atLimit = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [referralEvent({
          referral: { ref: "abc", source: "src", type: "typ" },
        })],
      }],
    }),
    {
      maxReferralRefChars: 3,
      maxReferralSourceChars: 3,
      maxReferralTypeChars: 3,
    },
  );
  assertEqual(atLimit.ok, true);

  for (
    const referral of [
      { ref: "abcd", source: "src", type: "typ" },
      { ref: "abc", source: "srcd", type: "typ" },
      { ref: "abc", source: "src", type: "typd" },
    ]
  ) {
    const result = await normalize(
      baseWebhook({
        entry: [{ id: PAGE_ID, messaging: [referralEvent({ referral })] }],
      }),
      {
        maxReferralRefChars: 3,
        maxReferralSourceChars: 3,
        maxReferralTypeChars: 3,
      },
    );
    assertEqual(
      result.ok,
      false,
      `${JSON.stringify(referral)} should be rejected`,
    );
    assertEqual(result.ok ? "" : result.error, "referral_field_too_large");
  }
});

Deno.test("fails closed for standalone referral events not inbound to the configured Page", async () => {
  for (
    const impossibleEvent of [
      referralEvent({ sender: { id: PAGE_ID }, recipient: { id: PSID } }),
      referralEvent({ recipient: { id: "other-page" } }),
    ]
  ) {
    const result = await normalize(
      baseWebhook({ entry: [{ id: PAGE_ID, messaging: [impossibleEvent] }] }),
    );
    assertEqual(
      result.ok,
      false,
      `${JSON.stringify(impossibleEvent)} must be rejected`,
    );
    assertEqual(result.ok ? "" : result.error, "invalid_referral_direction");
  }
});

Deno.test("includes Messenger referral fields in canonical fingerprints", async () => {
  const first = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [
          referralEvent({
            referral: { ref: "one", source: "ADS", type: "OPEN_THREAD" },
          }),
        ],
      }],
    }),
  );
  const second = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [
          referralEvent({
            referral: { ref: "two", source: "ADS", type: "OPEN_THREAD" },
          }),
        ],
      }],
    }),
  );

  assert(first.ok && second.ok, "referral normalization failed");
  assert(
    first.events[0].fingerprint !== second.events[0].fingerprint,
    "distinct referral refs must not collide",
  );
});

Deno.test("fails closed for directionally impossible message and echo events", async () => {
  for (
    const impossibleEvent of [
      {
        sender: { id: PAGE_ID },
        recipient: { id: PSID },
        timestamp: 10,
        message: {
          mid: "page-sender-without-echo",
          text: "outbound without echo",
        },
      },
      {
        sender: { id: PSID },
        recipient: { id: PAGE_ID },
        timestamp: 11,
        message: {
          mid: "user-sender-with-echo",
          is_echo: true,
          text: "fake echo",
        },
      },
      {
        sender: { id: PSID },
        recipient: { id: "other-page" },
        timestamp: 12,
        message: { mid: "cross-page-inbound", text: "not for configured page" },
      },
    ]
  ) {
    const result = await normalize(
      baseWebhook({ entry: [{ id: PAGE_ID, messaging: [impossibleEvent] }] }),
    );
    assertEqual(
      result.ok,
      false,
      `${JSON.stringify(impossibleEvent)} must be rejected`,
    );
    assertEqual(result.ok ? "" : result.error, "invalid_message_direction");
  }
});

Deno.test("keeps valid inbound messages and page echoes after direction checks", async () => {
  const result = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [
          inboundMessage({
            timestamp: 20,
            message: { mid: "inbound-mid", text: "in" },
          }),
          {
            sender: { id: PAGE_ID },
            recipient: { id: PSID },
            timestamp: 21,
            message: { mid: "echo-mid", is_echo: true, text: "out" },
          },
        ],
      }],
    }),
  );

  assert(result.ok, "valid inbound and echo events should normalize");
  assertDeepEqual(result.events.map((event) => event.kind), [
    "message",
    "message_echo",
  ]);
});

Deno.test("fails closed for outbound-shaped non-echo Messenger events", async () => {
  for (
    const impossibleEvent of [
      {
        sender: { id: PAGE_ID },
        recipient: { id: PSID },
        timestamp: 30,
        delivery: { mids: ["m1"], watermark: 30 },
      },
      {
        sender: { id: PAGE_ID },
        recipient: { id: PSID },
        timestamp: 31,
        read: { watermark: 31 },
      },
      {
        sender: { id: PAGE_ID },
        recipient: { id: PSID },
        timestamp: 32,
        postback: { title: "Start", payload: "GET_STARTED" },
      },
      {
        sender: { id: PAGE_ID },
        recipient: { id: PSID },
        timestamp: 33,
        policy_enforcement: { action: "block", reason: "spam" },
      },
      {
        sender: { id: PSID },
        recipient: { id: "other-page" },
        timestamp: 34,
        delivery: { mids: ["m1"], watermark: 34 },
      },
    ]
  ) {
    const result = await normalize(
      baseWebhook({ entry: [{ id: PAGE_ID, messaging: [impossibleEvent] }] }),
    );
    assertEqual(
      result.ok,
      false,
      `${JSON.stringify(impossibleEvent)} must be rejected`,
    );
    assertEqual(result.ok ? "" : result.error, "invalid_event_direction");
  }
});

Deno.test("rejects Messenger events with multiple recognized event kinds", async () => {
  const result = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [
          inboundMessage({
            message: { mid: "m1", text: "hello" },
            postback: { title: "Start", payload: "GET_STARTED" },
          }),
        ],
      }],
    }),
  );

  assertEqual(result.ok, false);
  assertEqual(result.ok ? "" : result.error, "ambiguous_event");
});

Deno.test("uses recursively canonical attachment payloads in fingerprints", async () => {
  const first = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [
          inboundMessage({
            message: {
              text: "same",
              attachments: [{
                type: "template",
                payload: {
                  b: 2,
                  nested: { y: true, x: ["one", { beta: 2, alpha: 1 }] },
                  a: 1,
                },
              }],
            },
          }),
        ],
      }],
    }),
  );
  const second = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [
          inboundMessage({
            message: {
              text: "same",
              attachments: [{
                type: "template",
                payload: {
                  a: 1,
                  nested: { x: ["one", { alpha: 1, beta: 2 }], y: true },
                  b: 2,
                },
              }],
            },
          }),
        ],
      }],
    }),
  );

  assert(first.ok && second.ok, "normalization failed");
  assertDeepEqual(
    first.events[0].attachments[0].payload,
    {
      b: 2,
      nested: { y: true, x: ["one", { beta: 2, alpha: 1 }] },
      a: 1,
    },
  );
  assertEqual(first.events[0].fingerprint, second.events[0].fingerprint);
});

Deno.test("rejects negative, fractional, unsafe, and missing event timestamps or watermarks", async () => {
  for (const timestamp of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    const result = await normalize(
      baseWebhook({
        entry: [{
          id: PAGE_ID,
          messaging: [
            inboundMessage({
              timestamp,
              message: { mid: "bad-ts", text: "x" },
            }),
          ],
        }],
      }),
    );
    assertEqual(
      result.ok,
      false,
      `timestamp ${format(timestamp)} must be rejected`,
    );
    assertEqual(result.ok ? "" : result.error, "missing_event_identity");
  }

  const timestampZero = await normalize(
    baseWebhook({
      entry: [{ id: PAGE_ID, messaging: [inboundMessage({ timestamp: 0 })] }],
    }),
  );
  assertEqual(timestampZero.ok, true);

  for (const watermark of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const delivery = await normalize(
      baseWebhook({
        entry: [{
          id: PAGE_ID,
          messaging: [{
            sender: { id: PSID },
            recipient: { id: PAGE_ID },
            timestamp: 1,
            delivery: { mids: ["m1"], watermark },
          }],
        }],
      }),
    );
    assertEqual(
      delivery.ok,
      false,
      `delivery watermark ${format(watermark)} must be rejected`,
    );
    assertEqual(delivery.ok ? "" : delivery.error, "invalid_watermark");

    const read = await normalize(
      baseWebhook({
        entry: [{
          id: PAGE_ID,
          messaging: [{
            sender: { id: PSID },
            recipient: { id: PAGE_ID },
            timestamp: 1,
            read: { watermark },
          }],
        }],
      }),
    );
    assertEqual(
      read.ok,
      false,
      `read watermark ${format(watermark)} must be rejected`,
    );
    assertEqual(read.ok ? "" : read.error, "invalid_watermark");
  }
});

Deno.test("fails closed for non-page object, wrong Page, oversized body, too many events, and oversized text or attachments", async () => {
  assertEqual((await normalize(baseWebhook({ object: "user" }))).ok, false);
  assertEqual(
    (await normalize(
      baseWebhook({ entry: [{ id: "other-page", messaging: [] }] }),
    )).ok,
    false,
  );

  const oversizedBody = encoder.encode(
    "{" + " ".repeat(DEFAULT_MESSENGER_LIMITS.maxBodyBytes + 1) + "}",
  );
  assertEqual(
    (await normalizeMessengerWebhook({
      rawBody: oversizedBody,
      expectedPageId: PAGE_ID,
    })).ok,
    false,
  );

  const tooManyEvents = repeatedEvents(
    DEFAULT_MESSENGER_LIMITS.maxMessagingEventsPerEntry + 1,
  );
  assertEqual(
    (await normalize(
      baseWebhook({ entry: [{ id: PAGE_ID, messaging: tooManyEvents }] }),
    )).ok,
    false,
  );

  const oversizedText = "x".repeat(DEFAULT_MESSENGER_LIMITS.maxTextChars + 1);
  assertEqual(
    (await normalize(
      baseWebhook({
        entry: [{
          id: PAGE_ID,
          messaging: [
            inboundMessage({ message: { mid: "m", text: oversizedText } }),
          ],
        }],
      }),
    )).ok,
    false,
  );

  const tooManyAttachments = Array.from({
    length: DEFAULT_MESSENGER_LIMITS.maxAttachmentsPerMessage + 1,
  }, () => ({ type: "image", payload: {} }));
  assertEqual(
    (await normalize(
      baseWebhook({
        entry: [{
          id: PAGE_ID,
          messaging: [
            inboundMessage({
              message: { mid: "m", attachments: tooManyAttachments },
            }),
          ],
        }],
      }),
    )).ok,
    false,
  );
});

Deno.test("enforces total messaging event limits across entries incrementally at boundaries", async () => {
  const limits = {
    maxEntries: 3,
    maxMessagingEventsPerEntry: 3,
    maxTotalMessagingEvents: 4,
  };
  const atLimit = await normalize(
    baseWebhook({
      entry: [
        { id: PAGE_ID, messaging: repeatedEvents(2) },
        { id: PAGE_ID, messaging: repeatedEvents(2) },
      ],
    }),
    limits,
  );
  assertEqual(atLimit.ok, true);
  assertEqual(atLimit.ok ? atLimit.events.length : 0, 4);

  const belowLimit = await normalize(
    baseWebhook({
      entry: [
        { id: PAGE_ID, messaging: repeatedEvents(1) },
        { id: PAGE_ID, messaging: repeatedEvents(2) },
      ],
    }),
    limits,
  );
  assertEqual(belowLimit.ok, true);
  assertEqual(belowLimit.ok ? belowLimit.events.length : 0, 3);

  const overLimit = await normalize(
    baseWebhook({
      entry: [
        { id: PAGE_ID, messaging: repeatedEvents(2) },
        { id: PAGE_ID, messaging: repeatedEvents(3) },
      ],
    }),
    limits,
  );
  assertEqual(overLimit.ok, false);
  assertEqual(overLimit.ok ? "" : overLimit.error, "too_many_messaging_events");
});

Deno.test("enforces entry count at and over the boundary", async () => {
  const limits = {
    maxEntries: 2,
    maxMessagingEventsPerEntry: 2,
    maxTotalMessagingEvents: 4,
  };
  const atLimit = await normalize(
    baseWebhook({
      entry: [
        { id: PAGE_ID, messaging: repeatedEvents(1) },
        { id: PAGE_ID, messaging: repeatedEvents(1) },
      ],
    }),
    limits,
  );
  assertEqual(atLimit.ok, true);

  const overLimit = await normalize(
    baseWebhook({
      entry: [
        { id: PAGE_ID, messaging: repeatedEvents(1) },
        { id: PAGE_ID, messaging: repeatedEvents(1) },
        { id: PAGE_ID, messaging: repeatedEvents(1) },
      ],
    }),
    limits,
  );
  assertEqual(overLimit.ok, false);
  assertEqual(overLimit.ok ? "" : overLimit.error, "too_many_entries");
});

Deno.test("validates supported attachment payload shape, URL, byte size, count boundary, and preserves bounded metadata", async () => {
  const metadataPayload = {
    url: "https://example.test/sticker.png",
    sticker_id: "sticker-123",
    reusable: true,
  };
  const accepted = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [
          inboundMessage({
            message: {
              mid: "m",
              attachments: [{ type: "image", payload: metadataPayload }],
            },
          }),
        ],
      }],
    }),
    { maxAttachmentPayloadBytes: 200, maxAttachmentUrlChars: 40 },
  );
  assertEqual(accepted.ok, true);
  assertDeepEqual(
    accepted.ok ? accepted.events[0].attachments[0].payload : null,
    metadataPayload,
  );

  const maxAttachments = Array.from(
    { length: 2 },
    (_, index) => ({
      type: "image",
      payload: { url: `https://example.test/${index}` },
    }),
  );
  assertEqual(
    (await normalize(
      baseWebhook({
        entry: [{
          id: PAGE_ID,
          messaging: [
            inboundMessage({
              message: { mid: "m", attachments: maxAttachments },
            }),
          ],
        }],
      }),
      {
        maxAttachmentsPerMessage: 2,
        maxAttachmentPayloadBytes: 200,
        maxAttachmentUrlChars: 40,
      },
    )).ok,
    true,
  );
  assertEqual(
    (await normalize(
      baseWebhook({
        entry: [{
          id: PAGE_ID,
          messaging: [
            inboundMessage({
              message: {
                mid: "m",
                attachments: [...maxAttachments, {
                  type: "image",
                  payload: { url: "https://example.test/2" },
                }],
              },
            }),
          ],
        }],
      }),
      {
        maxAttachmentsPerMessage: 2,
        maxAttachmentPayloadBytes: 200,
        maxAttachmentUrlChars: 40,
      },
    )).ok,
    false,
  );

  for (
    const malformedPayload of [
      undefined,
      null,
      [],
      "https://example.test/file.jpg",
      123,
      true,
    ] as unknown[]
  ) {
    const result = await normalize(
      baseWebhook({
        entry: [{
          id: PAGE_ID,
          messaging: [
            inboundMessage({
              message: {
                mid: "m",
                attachments: [{ type: "image", payload: malformedPayload }],
              },
            }),
          ],
        }],
      }),
      { maxAttachmentPayloadBytes: 200, maxAttachmentUrlChars: 40 },
    );
    assertEqual(
      result.ok,
      false,
      `payload ${format(malformedPayload)} should be rejected`,
    );
    assertEqual(result.ok ? "" : result.error, "invalid_attachment_payload");
  }

  for (
    const badUrl of [
      "",
      "http://example.test/file.jpg",
      "https://",
      " https://example.test/file.jpg",
      "https://example.test/file.jpg ",
      "HTTPS://example.test/file.jpg",
      `https://example.test/${"x".repeat(41)}`,
    ]
  ) {
    const result = await normalize(
      baseWebhook({
        entry: [{
          id: PAGE_ID,
          messaging: [
            inboundMessage({
              message: {
                mid: "m",
                attachments: [{ type: "image", payload: { url: badUrl } }],
              },
            }),
          ],
        }],
      }),
      { maxAttachmentPayloadBytes: 500, maxAttachmentUrlChars: 40 },
    );
    assertEqual(result.ok, false, `url ${format(badUrl)} should be rejected`);
    assertEqual(result.ok ? "" : result.error, "invalid_attachment_url");
  }
});

Deno.test("enforces attachment payload UTF-8 byte limits at and over boundary", async () => {
  const atLimitPayload = { sticker_id: "🙂" };
  const atLimitBytes =
    encoder.encode(JSON.stringify(atLimitPayload)).byteLength;
  const atLimit = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [
          inboundMessage({
            message: {
              mid: "m",
              attachments: [{ type: "image", payload: atLimitPayload }],
            },
          }),
        ],
      }],
    }),
    { maxAttachmentPayloadBytes: atLimitBytes },
  );
  assertEqual(atLimit.ok, true);

  const overLimit = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [
          inboundMessage({
            message: {
              mid: "m",
              attachments: [{ type: "image", payload: atLimitPayload }],
            },
          }),
        ],
      }],
    }),
    { maxAttachmentPayloadBytes: atLimitBytes - 1 },
  );
  assertEqual(overLimit.ok, false);
  assertEqual(
    overLimit.ok ? "" : overLimit.error,
    "attachment_payload_too_large",
  );
});

Deno.test("enforces delivery MID and postback payload limits at and over boundaries", async () => {
  const deliveryAt = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [{
          sender: { id: PSID },
          recipient: { id: PAGE_ID },
          timestamp: 1,
          delivery: { mids: ["m1", "m2"], watermark: 1 },
        }],
      }],
    }),
    { maxDeliveryMids: 2 },
  );
  assertEqual(deliveryAt.ok, true);

  const deliveryOver = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [{
          sender: { id: PSID },
          recipient: { id: PAGE_ID },
          timestamp: 1,
          delivery: { mids: ["m1", "m2", "m3"], watermark: 1 },
        }],
      }],
    }),
    { maxDeliveryMids: 2 },
  );
  assertEqual(deliveryOver.ok, false);
  assertEqual(
    deliveryOver.ok ? "" : deliveryOver.error,
    "invalid_delivery_mids",
  );

  const payloadAt = "x".repeat(3);
  const postbackAt = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [{
          sender: { id: PSID },
          recipient: { id: PAGE_ID },
          timestamp: 1,
          postback: { title: "T", payload: payloadAt },
        }],
      }],
    }),
    { maxPostbackPayloadChars: 3 },
  );
  assertEqual(postbackAt.ok, true);

  const postbackOver = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [{
          sender: { id: PSID },
          recipient: { id: PAGE_ID },
          timestamp: 1,
          postback: { title: "T", payload: "xxxx" },
        }],
      }],
    }),
    { maxPostbackPayloadChars: 3 },
  );
  assertEqual(postbackOver.ok, false);
  assertEqual(
    postbackOver.ok ? "" : postbackOver.error,
    "postback_payload_too_large",
  );
});

Deno.test("uses bounded opaque digests for Messenger MID fingerprints", async () => {
  const result = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [inboundMessage({ message: { mid: MID, text: "same" } })],
      }],
    }),
  );

  assert(result.ok, "normalization failed");
  assertEqual(result.events[0].messengerMessageId, MID);
  assertMatch(result.events[0].fingerprint, /^fbmsg_[a-f0-9]{64}$/);
  assert(
    !result.events[0].fingerprint.includes(MID),
    "fingerprint must not expose raw Messenger MID",
  );
  assertEqual(result.events[0].fingerprint.length, 70);
});

Deno.test("separates MID fingerprints by Page and event domain", async () => {
  const pageOne = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [
          inboundMessage({ message: { mid: "shared-mid", text: "first" } }),
        ],
      }],
    }),
  );
  const pageTwoBody = {
    object: "page",
    entry: [{
      id: "page-789",
      messaging: [{
        sender: { id: PSID },
        recipient: { id: "page-789" },
        timestamp: 1_800_000_000_111,
        message: { mid: "shared-mid", text: "first" },
      }],
    }],
  };
  const pageTwo = await normalizeMessengerWebhook({
    rawBody: rawJson(pageTwoBody),
    expectedPageId: "page-789",
  });
  const echo = await normalize(
    baseWebhook({
      entry: [{
        id: PAGE_ID,
        messaging: [{
          sender: { id: PAGE_ID },
          recipient: { id: PSID },
          timestamp: 1_800_000_000_111,
          message: { mid: "shared-mid", is_echo: true, text: "first" },
        }],
      }],
    }),
  );

  assert(pageOne.ok && pageTwo.ok && echo.ok, "normalization failed");
  assert(
    pageOne.events[0].fingerprint !== pageTwo.events[0].fingerprint,
    "cross-page MID reuse must not collide",
  );
  assert(
    pageOne.events[0].fingerprint !== echo.events[0].fingerprint,
    "message and echo domains must not collide",
  );
});

Deno.test("uses a stable duplicate fingerprint when Messenger MID is absent", async () => {
  const eventWithoutMid = inboundMessage({ message: { text: "same" } });
  const first = await normalize(
    baseWebhook({ entry: [{ id: PAGE_ID, messaging: [eventWithoutMid] }] }),
  );
  const second = await normalize(
    baseWebhook({ entry: [{ id: PAGE_ID, messaging: [eventWithoutMid] }] }),
  );

  assert(first.ok && second.ok, "normalization failed");
  assertEqual(first.events[0].messengerMessageId, null);
  assertEqual(first.events[0].fingerprint, second.events[0].fingerprint);
  assertMatch(first.events[0].fingerprint, /^fbmsg_[a-f0-9]{64}$/);
});

Deno.test("ordering helper prevents older Messenger events from overwriting newer state", () => {
  assertEqual(
    canApplyMessengerEventUpdate({
      incomingTimestampMs: 101,
      currentTimestampMs: 100,
    }),
    true,
  );
  assertEqual(
    canApplyMessengerEventUpdate({
      incomingTimestampMs: 100,
      currentTimestampMs: 100,
    }),
    true,
  );
  assertEqual(
    canApplyMessengerEventUpdate({
      incomingTimestampMs: 99,
      currentTimestampMs: 100,
    }),
    false,
  );
  assertEqual(
    canApplyMessengerEventUpdate({
      incomingTimestampMs: 99,
      currentTimestampMs: null,
    }),
    true,
  );
});

Deno.test("send policy permits RESPONSE only inside the 24 hour standard messaging window", () => {
  const nowMs = Date.UTC(2026, 8, 3, 12, 0, 0);
  assertEqual(
    evaluateMessengerSendPolicy({
      requestedTag: "RESPONSE",
      nowMs,
      lastUserMessageAtMs: nowMs - 24 * 60 * 60 * 1000,
    }).allowed,
    true,
  );
  assertEqual(
    evaluateMessengerSendPolicy({
      requestedTag: "RESPONSE",
      nowMs,
      lastUserMessageAtMs: nowMs - 24 * 60 * 60 * 1000 - 1,
    }).allowed,
    false,
  );
});

Deno.test("send policy permits HUMAN_AGENT only for approved authenticated humans inside seven days", () => {
  const nowMs = Date.UTC(2026, 8, 3, 12, 0, 0);
  assertEqual(
    evaluateMessengerSendPolicy({
      requestedTag: "HUMAN_AGENT",
      nowMs,
      lastUserMessageAtMs: nowMs - 7 * 24 * 60 * 60 * 1000,
      actorType: "human",
      actorAuthenticated: true,
      humanAgentFeatureEnabled: true,
      humanAgentApproved: true,
    }).allowed,
    true,
  );
  assertEqual(
    evaluateMessengerSendPolicy({
      requestedTag: "HUMAN_AGENT",
      nowMs,
      lastUserMessageAtMs: nowMs - 1,
      actorType: "ai",
      actorAuthenticated: true,
      humanAgentFeatureEnabled: true,
      humanAgentApproved: true,
    }).allowed,
    false,
  );
  assertEqual(
    evaluateMessengerSendPolicy({
      requestedTag: "HUMAN_AGENT",
      nowMs,
      lastUserMessageAtMs: nowMs - 1,
      actorType: "system",
      actorAuthenticated: true,
      humanAgentFeatureEnabled: true,
      humanAgentApproved: true,
    }).allowed,
    false,
  );
  assertEqual(
    evaluateMessengerSendPolicy({
      requestedTag: "HUMAN_AGENT",
      nowMs,
      lastUserMessageAtMs: nowMs - 1,
      actorType: "human",
      actorAuthenticated: true,
      humanAgentFeatureEnabled: false,
      humanAgentApproved: true,
    }).allowed,
    false,
  );
  assertEqual(
    evaluateMessengerSendPolicy({
      requestedTag: "HUMAN_AGENT",
      nowMs,
      lastUserMessageAtMs: nowMs - 7 * 24 * 60 * 60 * 1000 - 1,
      actorType: "human",
      actorAuthenticated: true,
      humanAgentFeatureEnabled: true,
      humanAgentApproved: true,
    }).allowed,
    false,
  );
});

Deno.test("send policy explicitly denies deprecated Messenger tags", () => {
  const nowMs = Date.UTC(2026, 8, 3, 12, 0, 0);
  for (
    const requestedTag of [
      "CONFIRMED_EVENT_UPDATE",
      "ACCOUNT_UPDATE",
      "POST_PURCHASE_UPDATE",
    ] as const
  ) {
    const decision = evaluateMessengerSendPolicy({
      requestedTag,
      nowMs,
      lastUserMessageAtMs: nowMs,
    });
    assertEqual(decision.allowed, false);
    assertEqual(
      decision.allowed ? "" : decision.reason,
      "deprecated_tag_denied",
    );
  }
});
