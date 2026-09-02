import {
  handleMessengerWebhook,
  type MessengerWebhookDeps,
  type MessengerWebhookEnv,
} from "./index.ts";

const encoder = new TextEncoder();
const APP_SECRET = "unit-test-app-secret";
const VERIFY_TOKEN = "unit-test-verify-token";
const PAGE_ID = "page-123";
const PSID = "user-456";
const MID = "mid.$abc";
const AGENT_EMAIL = "inboxoggxdk@agent.instinct.co";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(message ?? `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
}

function assertIncludes(haystack: string, needle: string, message?: string): void {
  if (!haystack.includes(needle)) throw new Error(message ?? `expected ${haystack} to include ${needle}`);
}

async function bodyText(response: Response): Promise<string> {
  return await response.text();
}

async function hmacSha256Hex(secret: string, rawBody: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const exactRawBody = rawBody.buffer.slice(rawBody.byteOffset, rawBody.byteOffset + rawBody.byteLength) as ArrayBuffer;
  const signature = await crypto.subtle.sign("HMAC", key, exactRawBody);
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedRequest(value: unknown, options: { secret?: string; headers?: HeadersInit } = {}): Promise<Request> {
  const raw = encoder.encode(typeof value === "string" ? value : JSON.stringify(value));
  const headers = new Headers(options.headers);
  headers.set("x-hub-signature-256", `sha256=${await hmacSha256Hex(options.secret ?? APP_SECRET, raw)}`);
  headers.set("content-type", "application/json");
  headers.set("content-length", String(raw.byteLength));
  return new Request("https://example.test/functions/v1/facebook-messenger-webhook", {
    method: "POST",
    headers,
    body: raw,
  });
}

function webhookEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sender: { id: PSID },
    recipient: { id: PAGE_ID },
    timestamp: 1_800_000_000_000,
    message: { mid: MID, text: "hello from customer" },
    ...overrides,
  };
}

function webhookBody(events: Record<string, unknown>[] = [webhookEvent()], pageId = PAGE_ID): Record<string, unknown> {
  return {
    object: "page",
    entry: [{ id: pageId, time: 1_800_000_000_000, messaging: events }],
  };
}

function env(overrides: Partial<MessengerWebhookEnv> = {}): MessengerWebhookEnv {
  return {
    META_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
    META_APP_SECRET: APP_SECRET,
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    ...overrides,
  };
}

type IngestedEvent = Record<string, unknown>;

function deps(options: {
  pageId?: string;
  emailForward?: boolean;
  settingsError?: Error;
  ingestError?: Error;
  ingestResult?: Record<string, unknown>;
} = {}) {
  const calls: { settings: number; ingests: IngestedEvent[] } = { settings: 0, ingests: [] };
  const deps: MessengerWebhookDeps = {
    fetchSettings: async () => {
      calls.settings += 1;
      if (options.settingsError) throw options.settingsError;
      return {
        page_id: options.pageId ?? PAGE_ID,
        agent_email_forward_enabled: options.emailForward ?? false,
      };
    },
    ingestEvent: async (event) => {
      calls.ingests.push(event as unknown as IngestedEvent);
      if (options.ingestError) throw options.ingestError;
      return options.ingestResult ?? { status: "processed", duplicate: false };
    },
    requestId: () => "req_test",
  };
  return { deps, calls };
}

Deno.test("GET verifies exact token with bounded challenge and no permissive CORS", async () => {
  const request = new Request(`https://example.test/functions/v1/facebook-messenger-webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=challenge-123`, { method: "GET" });
  const response = await handleMessengerWebhook(request, env(), deps().deps);

  assertEqual(response.status, 200);
  assertEqual(await bodyText(response), "challenge-123");
  assertEqual(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assertEqual(response.headers.get("access-control-allow-origin"), null);
});

Deno.test("GET rejects wrong token and missing verify config", async () => {
  const wrong = await handleMessengerWebhook(new Request("https://example.test/functions/v1/facebook-messenger-webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=ok", { method: "GET" }), env(), deps().deps);
  assertEqual(wrong.status, 403);

  const missing = await handleMessengerWebhook(new Request(`https://example.test/functions/v1/facebook-messenger-webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=ok`, { method: "GET" }), env({ META_WEBHOOK_VERIFY_TOKEN: undefined }), deps().deps);
  assertEqual(missing.status, 503);
});

Deno.test("GET rejects invalid mode and oversized challenge", async () => {
  const wrongMode = await handleMessengerWebhook(new Request(`https://example.test/functions/v1/facebook-messenger-webhook?hub.mode=Subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=ok`, { method: "GET" }), env(), deps().deps);
  assertEqual(wrongMode.status, 403);

  const hugeChallenge = "x".repeat(257);
  const huge = await handleMessengerWebhook(new Request(`https://example.test/functions/v1/facebook-messenger-webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=${hugeChallenge}`, { method: "GET" }), env(), deps().deps);
  assertEqual(huge.status, 403);
});

Deno.test("wrong_signature_rejected before JSON parse or DB processing", async () => {
  const { deps: mockDeps, calls } = deps();
  const response = await handleMessengerWebhook(await signedRequest('{"object":', { secret: "wrong-secret" }), env(), mockDeps);

  assertEqual(response.status, 403);
  assertEqual(await bodyText(response), "wrong_signature_rejected");
  assertEqual(calls.settings, 0);
  assertEqual(calls.ingests.length, 0);
});

Deno.test("rejects unsupported methods and oversized content-length", async () => {
  const getDeps = deps().deps;
  const method = await handleMessengerWebhook(new Request("https://example.test/functions/v1/facebook-messenger-webhook", { method: "PUT" }), env(), getDeps);
  assertEqual(method.status, 405);

  const oversized = await handleMessengerWebhook(new Request("https://example.test/functions/v1/facebook-messenger-webhook", {
    method: "POST",
    headers: { "content-length": String(256 * 1024 + 1), "x-hub-signature-256": "sha256=" + "0".repeat(64) },
    body: "{}",
  }), env(), getDeps);
  assertEqual(oversized.status, 413);
});

Deno.test("wrong_page_rejected after signed body but before durable ingest", async () => {
  const { deps: mockDeps, calls } = deps({ pageId: PAGE_ID });
  const response = await handleMessengerWebhook(await signedRequest(webhookBody([webhookEvent()], "other-page")), env(), mockDeps);

  assertEqual(response.status, 403);
  assertEqual(await bodyText(response), "wrong_page_rejected");
  assertEqual(calls.settings, 1);
  assertEqual(calls.ingests.length, 0);
});

Deno.test("DB/settings and ingest failures return 5xx without ack", async () => {
  const settingsFailure = await handleMessengerWebhook(await signedRequest(webhookBody()), env(), deps({ settingsError: new Error("db down") }).deps);
  assertEqual(settingsFailure.status, 503);
  assert(await bodyText(settingsFailure) !== "EVENT_RECEIVED");

  const ingestFailure = await handleMessengerWebhook(await signedRequest(webhookBody()), env(), deps({ ingestError: new Error("rpc down") }).deps);
  assertEqual(ingestFailure.status, 500);
  assert(await bodyText(ingestFailure) !== "EVENT_RECEIVED");
});

Deno.test("successful signed POST durably ingests every event before ack", async () => {
  const { deps: mockDeps, calls } = deps({ emailForward: false });
  const response = await handleMessengerWebhook(await signedRequest(webhookBody([
    webhookEvent({ message: { mid: "m1", text: "one" }, timestamp: 1_800_000_000_001 }),
    webhookEvent({ message: { mid: "m2", text: "two" }, timestamp: 1_800_000_000_002 }),
  ])), env(), mockDeps);

  assertEqual(response.status, 200);
  assertEqual(await bodyText(response), "EVENT_RECEIVED");
  assertEqual(calls.ingests.length, 2);
  assertEqual(calls.ingests[0].p_page_id, PAGE_ID);
  assertEqual(calls.ingests[0].p_psid, PSID);
  assertEqual(calls.ingests[0].p_event_type, "message");
});

Deno.test("duplicate_event_idempotent still returns 200 without requiring side effects", async () => {
  const { deps: mockDeps, calls } = deps({ ingestResult: { status: "duplicate", duplicate: true } });
  const response = await handleMessengerWebhook(await signedRequest(webhookBody()), env(), mockDeps);

  assertEqual(response.status, 200);
  assertEqual(await bodyText(response), "EVENT_RECEIVED");
  assertEqual(calls.ingests.length, 1);
});

Deno.test("inbound RPC payload derives PSID and reply windows from non-Page participant", async () => {
  const { deps: mockDeps, calls } = deps();
  const response = await handleMessengerWebhook(await signedRequest(webhookBody([webhookEvent({ timestamp: 1_800_000_000_000 })])), env(), mockDeps);
  assertEqual(response.status, 200);

  const event = calls.ingests[0];
  assertEqual(event.p_psid, PSID);
  assertEqual(event.p_direction, "inbound");
  assertEqual(event.p_message_text, "hello from customer");
  assertEqual(event.p_event_timestamp, "2027-01-15T08:00:00.000Z");
  assertEqual(event.p_reply_window_expires_at, "2027-01-16T08:00:00.000Z");
  assertEqual(event.p_human_agent_window_expires_at, "2027-01-22T08:00:00.000Z");
});

Deno.test("old event ordering data is passed for SQL guard to prevent stale overwrite", async () => {
  const { deps: mockDeps, calls } = deps();
  const response = await handleMessengerWebhook(await signedRequest(webhookBody([webhookEvent({ timestamp: 1_700_000_000_000 })])), env(), mockDeps);
  assertEqual(response.status, 200);
  assertEqual(calls.ingests[0].p_event_timestamp, "2023-11-14T22:13:20.000Z");
});

Deno.test("email forwarding off/on uses fixed recipient and sanitized opaque payload with no raw PSID", async () => {
  const off = deps({ emailForward: false });
  await handleMessengerWebhook(await signedRequest(webhookBody()), env(), off.deps);
  assertEqual(off.calls.ingests[0].p_email_forward_enabled, false);
  assertEqual(off.calls.ingests[0].p_email_recipient, null);

  const on = deps({ emailForward: true });
  await handleMessengerWebhook(await signedRequest(webhookBody()), env(), on.deps);
  const payload = on.calls.ingests[0].p_email_payload;
  const serialized = JSON.stringify(payload);
  assertEqual(on.calls.ingests[0].p_email_forward_enabled, true);
  assertEqual(on.calls.ingests[0].p_email_recipient, AGENT_EMAIL);
  assertIncludes(serialized, "conversation_ref");
  assertIncludes(serialized, "sender_display");
  assertIncludes(serialized, "message_preview");
  assert(!serialized.includes(PSID), "email payload must not contain raw PSID");
});

Deno.test("echo, delivery, read, postback, and policy events are persisted without invented inbound text", async () => {
  const { deps: mockDeps, calls } = deps();
  const response = await handleMessengerWebhook(await signedRequest(webhookBody([
    { sender: { id: PAGE_ID }, recipient: { id: PSID }, timestamp: 11, message: { mid: "echo-mid", is_echo: true, text: "agent" } },
    { sender: { id: PSID }, recipient: { id: PAGE_ID }, timestamp: 12, delivery: { mids: ["echo-mid"], watermark: 12 } },
    { sender: { id: PSID }, recipient: { id: PAGE_ID }, timestamp: 13, read: { watermark: 13 } },
    { sender: { id: PSID }, recipient: { id: PAGE_ID }, timestamp: 14, postback: { title: "Start", payload: "START" } },
    { sender: { id: PSID }, recipient: { id: PAGE_ID }, timestamp: 15, policy_enforcement: { action: "block", reason: "spam" } },
  ])), env(), mockDeps);

  assertEqual(response.status, 200);
  assertEqual(calls.ingests.length, 5);
  assertEqual(calls.ingests[0].p_event_type, "message_echo");
  assertEqual(calls.ingests[0].p_direction, "outbound");
  assertEqual(calls.ingests[1].p_event_type, "message_delivery");
  assertEqual(calls.ingests[1].p_delivery_message_ids, JSON.stringify(["echo-mid"]));
  assertEqual(calls.ingests[3].p_event_type, "messaging_postback");
  assertEqual(calls.ingests[3].p_message_text, null);
  assertEqual(calls.ingests[4].p_event_type, "messaging_policy_enforcement");
  assertEqual(calls.ingests[4].p_message_text, null);
});

Deno.test("missing Meta app secret returns 503 and never reads settings", async () => {
  const { deps: mockDeps, calls } = deps();
  const response = await handleMessengerWebhook(await signedRequest(webhookBody()), env({ META_APP_SECRET: undefined }), mockDeps);
  assertEqual(response.status, 503);
  assertEqual(calls.settings, 0);
});

Deno.test("malformed JSON with valid signature is rejected after signature but before ingest", async () => {
  const { deps: mockDeps, calls } = deps();
  const response = await handleMessengerWebhook(await signedRequest("{not-json"), env(), mockDeps);
  assertEqual(response.status, 400);
  assertEqual(calls.settings, 1);
  assertEqual(calls.ingests.length, 0);
});
