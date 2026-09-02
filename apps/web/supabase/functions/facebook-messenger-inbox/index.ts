import { createClient } from "npm:@supabase/supabase-js@2.90.1";

export type MessengerInboxEnv = { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string };
export type User = { id: string };
export type ReconcileInput = { outboxId: string; status: "sent" | "failed"; providerMessageId?: string; safeReason?: string; evidenceRef: string; actorId: string };
export type MessengerInboxDeps = {
  verifyJwt: (token: string) => Promise<User | null>;
  isOwner: (userId: string) => Promise<boolean>;
  hasModulePermission: (userId: string, moduleKey: string, mode: "view" | "edit") => Promise<boolean>;
  listConversations: () => Promise<Record<string, unknown>[]>;
  readConversation: (conversationId: string) => Promise<Record<string, unknown> | null>;
  reconcileOutbox: (input: ReconcileInput) => Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; reason: string }>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_TEXT_RE = /^[A-Za-z0-9._:$@/ -]{1,256}$/;
const jsonResponse = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleMessengerInbox(request: Request, env: MessengerInboxEnv = Deno.env.toObject(), deps?: MessengerInboxDeps): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  const token = bearer(request);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  const active = deps ?? createDeps(env, token);
  const user = await active.verifyJwt(token);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const tail = parts[parts.length - 1] === "facebook-messenger-inbox" ? "" : parts[parts.length - 1];

  if (request.method === "POST" && tail === "reconcile") {
    const [canEdit, owner] = await Promise.all([
      active.hasModulePermission(user.id, "facebook_messenger", "edit"),
      active.isOwner(user.id),
    ]);
    if (!canEdit || !owner) return jsonResponse({ error: "forbidden" }, 403);
    return handleReconcile(request, active, user.id);
  }

  if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405);
  if (!(await active.hasModulePermission(user.id, "facebook_messenger", "view"))) return jsonResponse({ error: "forbidden" }, 403);

  if (!tail) {
    const conversations = await active.listConversations();
    return jsonResponse({ conversations: conversations.map(minimizeConversation) });
  }
  if (!UUID_RE.test(tail)) return jsonResponse({ error: "invalid_conversation_id" }, 422);
  const detail = await active.readConversation(tail);
  if (!detail) return jsonResponse({ error: "not_found" }, 404);
  return jsonResponse({ conversation: minimizeConversationDetail(detail) });
}

async function handleReconcile(request: Request, deps: MessengerInboxDeps, actorId: string): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid_json" }, 400); }
  const outboxId = String(body.outbox_id || "").trim();
  const status = body.status === "sent" ? "sent" : body.status === "failed" ? "failed" : "";
  const providerMessageId = String(body.provider_message_id || "").trim();
  const safeReason = String(body.safe_reason || "").trim();
  const evidenceRef = String(body.evidence_ref || "").trim();
  if (!UUID_RE.test(outboxId) || !status || !SAFE_TEXT_RE.test(evidenceRef)) return jsonResponse({ error: "invalid_reconciliation" }, 422);
  if (status === "sent" && !SAFE_TEXT_RE.test(providerMessageId)) return jsonResponse({ error: "provider_evidence_required" }, 422);
  if (status === "failed" && !SAFE_TEXT_RE.test(safeReason)) return jsonResponse({ error: "safe_reason_required" }, 422);
  const result = await deps.reconcileOutbox({ outboxId, status, providerMessageId, safeReason, evidenceRef, actorId });
  if (!result.ok) return jsonResponse({ error: result.reason }, result.reason === "not_eligible" ? 409 : 422);
  return jsonResponse({ outbox: { id: result.row.id, status: result.row.status } });
}

function createDeps(env: MessengerInboxEnv, authToken: string): MessengerInboxDeps {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("missing_supabase_config");
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    verifyJwt: async (token) => {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : { id: data.user.id };
    },
    hasModulePermission: async (userId, moduleKey, mode) => hasPermission(admin, userId, moduleKey, mode),
    isOwner: async (userId) => isOwner(admin, userId),
    listConversations: async () => {
      void authToken;
      const { data, error } = await admin.rpc("facebook_list_messenger_conversations", {});
      if (error) throw error;
      return data || [];
    },
    readConversation: async (conversationId) => {
      const { data, error } = await admin.rpc("facebook_read_messenger_conversation", { p_conversation_id: conversationId });
      if (error) throw error;
      return data;
    },
    reconcileOutbox: async (input) => {
      const { data, error } = await admin.rpc("facebook_reconcile_messenger_outbox", {
        p_outbox_id: input.outboxId,
        p_status: input.status,
        p_provider_message_id: input.providerMessageId || null,
        p_safe_reason: input.safeReason || null,
        p_evidence_ref: input.evidenceRef,
        p_actor_id: input.actorId,
      });
      if (error) return { ok: false, reason: error.message.includes("not_eligible") ? "not_eligible" : "reconcile_failed" };
      return { ok: true, row: data?.row ?? data };
    },
  };
}

async function hasPermission(admin: any, userId: string, moduleKey: string, mode: "view" | "edit"): Promise<boolean> {
  const [{ data: roles }, { data: perms }] = await Promise.all([
    admin.from("user_roles").select("role").eq("user_id", userId),
    admin.from("user_module_permissions").select("can_view,can_edit").eq("user_id", userId).eq("module_key", moduleKey),
  ]);
  if ((roles || []).some((row: { role?: string }) => row.role === "owner")) return true;
  return (perms || []).some((row: { can_view?: boolean; can_edit?: boolean }) => mode === "edit" ? row.can_edit === true : row.can_view === true || row.can_edit === true);
}
async function isOwner(admin: any, userId: string): Promise<boolean> {
  const { data } = await admin.from("user_roles").select("role").eq("user_id", userId).eq("role", "owner");
  return (data || []).length > 0;
}
function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}
function minimizeConversation(row: Record<string, unknown>): Record<string, unknown> {
  return { id: row.id, display_name: typeof row.customer_name === "string" && row.customer_name ? row.customer_name : "Facebook sender", last_message_at: row.last_message_at ?? null, reply_window_expires_at: row.reply_window_expires_at ?? null };
}
function minimizeConversationDetail(row: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(row.messages) ? row.messages : [];
  return { ...minimizeConversation(row), messages: messages.map((msg: Record<string, unknown>) => ({ id: msg.id, direction: msg.direction, message_text: msg.message_text ?? null, received_at: msg.received_at ?? null, sent_at: msg.sent_at ?? null })) };
}

if (import.meta.main) Deno.serve((request) => handleMessengerInbox(request));
