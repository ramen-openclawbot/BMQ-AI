import {
  handleMessengerSend,
  type MessengerSendDeps,
  type MessengerSendEnv,
} from "./index.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (!Object.is(actual, expected)) throw new Error(message ?? `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
}
async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json();
}

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-09-03T06:00:00.000Z");
const freshConversation = {
  id: CONVERSATION_ID,
  last_user_message_at_ms: NOW - 24 * 60 * 60 * 1000,
  human_agent_enabled: false,
  human_agent_approved: false,
};

function env(overrides: Partial<MessengerSendEnv> = {}): MessengerSendEnv {
  return { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service", ...overrides };
}
function deps(overrides: Partial<MessengerSendDeps> = {}) {
  const calls: Record<string, unknown[]> = { auth: [], permission: [], conversation: [], enqueue: [] };
  const active: MessengerSendDeps = {
    nowMs: () => NOW,
    verifyJwt: async (token) => {
      calls.auth.push(token);
      if (token !== "fresh-token") return null;
      return { id: USER_ID };
    },
    hasModulePermission: async (userId, moduleKey, mode) => {
      calls.permission.push({ userId, moduleKey, mode });
      return true;
    },
    resolveConversationPolicy: async (conversationId) => {
      calls.conversation.push(conversationId);
      if (conversationId !== CONVERSATION_ID) return null;
      return freshConversation;
    },
    enqueueOutbox: async (intent) => {
      calls.enqueue.push(intent);
      return { ok: true, row: { id: "outbox-1", status: "pending", idempotency_key: intent.idempotencyKey } };
    },
    ...overrides,
  };
  return { deps: active, calls };
}
function request(body: unknown, token = "fresh-token") {
  return new Request("https://example.test/functions/v1/facebook-messenger-send", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("send requires fresh server-verified JWT and facebook_messenger can_edit", async () => {
  const missing = await handleMessengerSend(request({ conversation_id: CONVERSATION_ID, text: "hello", idempotency_key: "k".repeat(32) }, "stale-token"), env(), deps().deps);
  assertEqual(missing.status, 401);

  const { deps: noEdit, calls } = deps({ hasModulePermission: async () => false });
  const forbidden = await handleMessengerSend(request({ conversation_id: CONVERSATION_ID, text: "hello", idempotency_key: "k".repeat(32) }), env(), noEdit);
  assertEqual(forbidden.status, 403);
  assertEqual((calls.enqueue as unknown[]).length, 0);
});

Deno.test("send derives actor and policy server-side, ignores client page psid tag actor fields", async () => {
  const { deps: active, calls } = deps();
  const response = await handleMessengerSend(request({
    conversation_id: CONVERSATION_ID,
    text: "hello",
    idempotency_key: "a".repeat(32),
    page_id: "evil-page",
    psid: "evil-psid",
    tag: "HUMAN_AGENT",
    actor_id: "spoof",
    provider_state: "sent",
  }), env(), active);

  assertEqual(response.status, 200);
  const intent = (calls.enqueue as Record<string, unknown>[])[0];
  assertEqual(intent.actorId, USER_ID);
  assertEqual(intent.conversationId, CONVERSATION_ID);
  assertEqual(intent.tag, "RESPONSE");
  assertEqual(intent.text, "hello");
  assert(!("page_id" in intent));
  assert(!("psid" in intent));
});

Deno.test("send rejects empty text, oversized text, and missing explicit bounded idempotency key", async () => {
  const base = { conversation_id: CONVERSATION_ID, idempotency_key: "b".repeat(32) };
  assertEqual((await handleMessengerSend(request({ ...base, text: "   " }), env(), deps().deps)).status, 422);
  assertEqual((await handleMessengerSend(request({ ...base, text: "x".repeat(2001) }), env(), deps().deps)).status, 422);
  assertEqual((await handleMessengerSend(request({ conversation_id: CONVERSATION_ID, text: "ok", idempotency_key: "short" }), env(), deps().deps)).status, 422);
});

Deno.test("send enforces exact 24h RESPONSE boundary and expired policy", async () => {
  const boundary = await handleMessengerSend(request({ conversation_id: CONVERSATION_ID, text: "ok", idempotency_key: "c".repeat(32) }), env(), deps().deps);
  assertEqual(boundary.status, 200);

  const expiredDeps = deps({ resolveConversationPolicy: async () => ({ ...freshConversation, last_user_message_at_ms: NOW - 24 * 60 * 60 * 1000 - 1 }) }).deps;
  const expired = await handleMessengerSend(request({ conversation_id: CONVERSATION_ID, text: "ok", idempotency_key: "d".repeat(32) }), env(), expiredDeps);
  assertEqual(expired.status, 409);
  assertEqual((await json(expired)).error, "outside_standard_messaging_window");
});

Deno.test("send disabled mode creates no outbox backlog and maps idempotency conflicts fail closed", async () => {
  const disabled = deps({ enqueueOutbox: async () => ({ ok: false, reason: "disabled" }) });
  const disabledResponse = await handleMessengerSend(request({ conversation_id: CONVERSATION_ID, text: "ok", idempotency_key: "e".repeat(32) }), env(), disabled.deps);
  assertEqual(disabledResponse.status, 503);

  const conflict = deps({ enqueueOutbox: async () => ({ ok: false, reason: "idempotency_conflict" }) }).deps;
  const conflictResponse = await handleMessengerSend(request({ conversation_id: CONVERSATION_ID, text: "ok", idempotency_key: "f".repeat(32) }), env(), conflict);
  assertEqual(conflictResponse.status, 409);
});

Deno.test("human agent path requires explicit human-only approval and denies AI/system", async () => {
  const noApproval = await handleMessengerSend(request({ conversation_id: CONVERSATION_ID, text: "ok", idempotency_key: "g".repeat(32), send_type: "human_agent" }), env(), deps().deps);
  assertEqual(noApproval.status, 409);

  const approvedHuman = deps({ resolveConversationPolicy: async () => ({ ...freshConversation, last_user_message_at_ms: NOW - 3 * 24 * 60 * 60 * 1000, human_agent_enabled: true, human_agent_approved: true }) }).deps;
  assertEqual((await handleMessengerSend(request({ conversation_id: CONVERSATION_ID, text: "ok", idempotency_key: "h".repeat(32), send_type: "human_agent" }), env(), approvedHuman)).status, 200);

  const ai = await handleMessengerSend(request({ conversation_id: CONVERSATION_ID, text: "ok", idempotency_key: "i".repeat(32), send_type: "human_agent", actor_type: "ai" }), env(), approvedHuman);
  assertEqual(ai.status, 422);
});
