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
  const calls: Record<string, unknown[]> = { auth: [], permission: [], list: [], read: [], reconcile: [] };
  const active: MessengerInboxDeps = {
    verifyJwt: async (token) => {
      calls.auth.push(token);
      return token === "fresh-token" ? { id: USER_ID } : null;
    },
    isOwner: async () => true,
    hasModulePermission: async (_userId, _moduleKey, mode) => mode === "view" || mode === "edit",
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
    ...overrides,
  };
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
  assertEqual(first.display_name, "Facebook sender");
  assert(!("psid" in first));
  assert(!("raw_identity" in first));

  const detail = await handleMessengerInbox(request(`/${CONVERSATION_ID}`), env(), deps().deps);
  const detailBody = await json(detail);
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

  const read = await handleMessengerInbox(request("", "fresh-token", { method: "POST", body: JSON.stringify({ action: "read", conversation_id: CONVERSATION_ID }), headers: { "content-type": "application/json" } }), env(), active.deps);
  assertEqual(read.status, 200);
  assertEqual((active.calls.read as unknown[]).length, 1);
});
