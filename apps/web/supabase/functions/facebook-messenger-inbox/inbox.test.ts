import {
  handleMessengerInbox,
  type MessengerInboxDeps,
  type MessengerInboxEnv,
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

function env(overrides: Partial<MessengerInboxEnv> = {}): MessengerInboxEnv {
  return { SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service", ...overrides };
}
function deps(overrides: Partial<MessengerInboxDeps> = {}) {
  const calls: Record<string, unknown[]> = { auth: [], permission: [], enabled: [], list: [], read: [], reconcile: [] };
  const active = {
    verifyJwt: async (token) => {
      calls.auth.push(token);
      return token === "fresh-token" ? { id: USER_ID } : null;
    },
    isOwner: async () => true,
    hasModulePermission: async (_userId, _moduleKey, mode) => mode === "view" || mode === "edit",
    resolveSettingsEnabled: async () => {
      calls.enabled.push(true);
      return false;
    },
    listConversations: async () => {
      calls.list.push(true);
      return [{ id: CONVERSATION_ID, customer_name: null, identity_fallback: "psid-secret", last_message_at: "2026-09-03T06:00:00Z", raw_identity: { psid: "leak" }, psid: "leak" }];
    },
    readConversation: async () => {
      calls.read.push(true);
      return { id: CONVERSATION_ID, customer_name: null, identity_fallback: "psid-secret", messages: [{ id: "m1", direction: "inbound", message_text: "hello", payload: { raw: "leak" }, psid: "leak" }] };
    },
    reconcileOutbox: async (input) => {
      calls.reconcile.push(input);
      return { ok: true, row: { id: input.outboxId, status: input.status } };
    },
    ...(overrides as Record<string, unknown>),
  } as MessengerInboxDeps;
  return { deps: active, calls };
}
function request(path = "", token = "fresh-token", init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return new Request(`https://example.test/functions/v1/facebook-messenger-inbox${path}`, { method: "GET", ...init, headers });
}

Deno.test("inbox list/read require fresh JWT and can_view, then return minimized masked fields only", async () => {
  assertEqual((await handleMessengerInbox(request("", "stale"), env(), deps().deps)).status, 401);

  const forbidden = deps({ hasModulePermission: async () => false });
  assertEqual((await handleMessengerInbox(request(""), env(), forbidden.deps)).status, 403);
  assertEqual((forbidden.calls.list as unknown[]).length, 0);

  const list = await handleMessengerInbox(request(""), env(), deps().deps);
  assertEqual(list.status, 200);
  const body = await json(list);
  const first = (body.conversations as Record<string, unknown>[])[0];
  assertEqual(first.customerDisplayName, "Facebook sender");
  assertEqual(body.enabled, false);
  assert(!("psid" in first));
  assert(!("raw_identity" in first));

  const detail = await handleMessengerInbox(request(`/${CONVERSATION_ID}`), env(), deps().deps);
  const detailBody = await json(detail);
  assertEqual(detailBody.enabled, false);
  assert(!JSON.stringify(detailBody).includes("psid-secret"));
  assert(!JSON.stringify(detailBody).includes("raw"));
});

Deno.test("owner-only reconciliation requires can_edit/owner path, evidence, and ambiguous committed state", async () => {
  const body = { outbox_id: "33333333-3333-4333-8333-333333333333", status: "sent", provider_message_id: "mid.$abc", evidence_ref: "ops-ticket-1" };
  const noEdit = deps({ hasModulePermission: async (_u, _m, mode) => mode === "view" });
  assertEqual((await handleMessengerInbox(request("/reconcile", "fresh-token", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), env(), noEdit.deps)).status, 403);

  const editButNotOwner = deps({ isOwner: async () => false });
  assertEqual((await handleMessengerInbox(request("/reconcile", "fresh-token", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), env(), editButNotOwner.deps)).status, 403);

  assertEqual((await handleMessengerInbox(request("/reconcile", "fresh-token", { method: "POST", body: JSON.stringify({ ...body, provider_message_id: "" }), headers: { "content-type": "application/json" } }), env(), deps().deps)).status, 422);

  const response = await handleMessengerInbox(request("/reconcile", "fresh-token", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), env(), deps().deps);
  assertEqual(response.status, 200);
});


Deno.test("inbox supports Supabase invoke POST action contract for list and read", async () => {
  const active = deps();
  const list = await handleMessengerInbox(request("", "fresh-token", { method: "POST", body: JSON.stringify({ action: "list" }), headers: { "content-type": "application/json" } }), env(), active.deps);
  assertEqual(list.status, 200);
  assertEqual((active.calls.list as unknown[]).length, 1);
  assertEqual((await json(list)).enabled, false);

  const read = await handleMessengerInbox(request("", "fresh-token", { method: "POST", body: JSON.stringify({ action: "read", conversation_id: CONVERSATION_ID }), headers: { "content-type": "application/json" } }), env(), active.deps);
  assertEqual(read.status, 200);
  assertEqual((active.calls.read as unknown[]).length, 1);
  assertEqual((await json(read)).enabled, false);
});

Deno.test("inbox enabled flag is true only for exact true and fail-closed for missing or lookup errors", async () => {
  const enabled = deps({ resolveSettingsEnabled: async () => true } as Partial<MessengerInboxDeps>);
  const enabledList = await json(await handleMessengerInbox(request("", "fresh-token", { method: "POST", body: JSON.stringify({ action: "list" }) }), env(), enabled.deps));
  assertEqual(enabledList.enabled, true);

  const missing = deps({ resolveSettingsEnabled: async () => false } as Partial<MessengerInboxDeps>);
  const missingRead = await json(await handleMessengerInbox(request("", "fresh-token", { method: "POST", body: JSON.stringify({ action: "read", conversation_id: CONVERSATION_ID }) }), env(), missing.deps));
  assertEqual(missingRead.enabled, false);

  const failed = deps({ resolveSettingsEnabled: async () => { throw new Error("settings_lookup_failed"); } } as Partial<MessengerInboxDeps>);
  const failedList = await handleMessengerInbox(request("", "fresh-token", { method: "POST", body: JSON.stringify({ action: "list" }) }), env(), failed.deps);
  assertEqual(failedList.status, 200);
  assertEqual((await json(failedList)).enabled, false);
});


Deno.test("inbox maps canonical SQL rows to exact camelCase DTO and omits sensitive/provider fields", async () => {
  const active = deps({
    listConversations: async () => [{
      id: CONVERSATION_ID, customer_name: "Ada", last_message_at: "2026-09-03T06:00:00Z", last_message_preview: "hello",
      reply_window_expired: true, reply_blocked: true, reconciliation_status: "manual_reconciliation_required", blocking_outbox_id: "33333333-3333-4333-8333-333333333333",
      page_id: "page-secret", psid: "psid-secret", provider_evidence: { token: "secret" }, raw_payload: { leak: true },
    }],
    readConversation: async () => ({
      id: CONVERSATION_ID, customer_name: "Ada", last_message_at: "2026-09-03T06:00:00Z", last_message_preview: "hello",
      reply_window_expired: false, reply_blocked: false, reconciliation_status: null,
      page_id: "page-secret", psid: "psid-secret",
      messages: [{ id: "m1", direction: "inbound", message_text: "hello", created_at: "2026-09-03T06:00:00Z", received_at: "2026-09-03T06:00:00Z", page_id: "page-secret", psid: "psid-secret", payload: { token: "secret" } }],
    }),
  });
  const list = await json(await handleMessengerInbox(request("", "fresh-token", { method: "POST", body: JSON.stringify({ action: "list" }) }), env(), active.deps));
  const first = (list.conversations as Record<string, unknown>[])[0];
  assertEqual(Object.keys(first).sort().join(","), "blockingOutboxId,customerDisplayName,id,lastMessageAt,lastMessagePreview,manualReconciliationStatus,reconciliationStatus,replyBlocked,replyWindowExpired");
  assertEqual(first.customerDisplayName, "Ada");
  assertEqual(first.lastMessagePreview, "hello");
  assertEqual(first.replyWindowExpired, true);
  assertEqual(first.replyBlocked, true);
  assertEqual(first.reconciliationStatus, "manual_reconciliation_required");
  assert(!JSON.stringify(first).includes("page-secret"));
  assert(!JSON.stringify(first).includes("psid-secret"));

  const read = await json(await handleMessengerInbox(request("", "fresh-token", { method: "POST", body: JSON.stringify({ action: "read", conversation_id: CONVERSATION_ID }) }), env(), active.deps));
  const detail = read.selectedConversation as Record<string, unknown>;
  const msg = (detail.messages as Record<string, unknown>[])[0];
  assertEqual(Object.keys(msg).sort().join(","), "createdAt,direction,id,text");
  assertEqual(msg.text, "hello");
  assertEqual(msg.createdAt, "2026-09-03T06:00:00Z");
  assert(!JSON.stringify(detail).includes("page-secret"));
  assert(!JSON.stringify(detail).includes("payload"));
});
