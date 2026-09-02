import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { evaluateMessengerSendPolicy } from "../_shared/facebook-messenger.ts";

export type MessengerSendEnv = { SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string };
export type VerifiedUser = { id: string };
export type ConversationPolicy = {
  id: string;
  last_user_message_at_ms: number | null;
  human_agent_enabled?: boolean;
  human_agent_approved?: boolean;
};
export type EnqueueIntent = { conversationId: string; text: string; idempotencyKey: string; actorId: string; tag: "RESPONSE" | "HUMAN_AGENT" };
export type EnqueueResult = { ok: true; row: Record<string, unknown> } | { ok: false; reason: string };
export type MessengerSendDeps = {
  nowMs: () => number;
  verifyJwt: (token: string) => Promise<VerifiedUser | null>;
  hasModulePermission: (userId: string, moduleKey: string, mode: "view" | "edit") => Promise<boolean>;
  resolveConversationPolicy: (conversationId: string) => Promise<ConversationPolicy | null>;
  enqueueOutbox: (intent: EnqueueIntent) => Promise<EnqueueResult>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{32,128}$/;
const MAX_TEXT = 2000;

const jsonResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleMessengerSend(request: Request, env: MessengerSendEnv = Deno.env.toObject(), deps?: MessengerSendDeps): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const token = bearer(request);
  if (!token) return jsonResponse({ error: "unauthorized" }, 401);
  const active = deps ?? createDeps(env, token);
  const user = await active.verifyJwt(token);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);
  if (!(await active.hasModulePermission(user.id, "facebook_messenger", "edit"))) {
    return jsonResponse({ error: "forbidden" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  const sendType = body.send_type === "human_agent" ? "human_agent" : "response";
  const actorType = body.actor_type === undefined ? "human" : body.actor_type;

  if (!UUID_RE.test(conversationId)) return jsonResponse({ error: "invalid_conversation_id" }, 422);
  if (text.length === 0 || text.length > MAX_TEXT) return jsonResponse({ error: "invalid_text" }, 422);
  if (!IDEMPOTENCY_RE.test(idempotencyKey)) return jsonResponse({ error: "invalid_idempotency_key" }, 422);
  if (sendType === "human_agent" && actorType !== "human") return jsonResponse({ error: "human_agent_requires_authenticated_human" }, 422);

  const conversation = await active.resolveConversationPolicy(conversationId);
  if (!conversation) return jsonResponse({ error: "conversation_not_found" }, 404);

  const decision = evaluateMessengerSendPolicy({
    requestedTag: sendType === "human_agent" ? "HUMAN_AGENT" : "RESPONSE",
    nowMs: active.nowMs(),
    lastUserMessageAtMs: conversation.last_user_message_at_ms,
    actorType: "human",
    actorAuthenticated: true,
    humanAgentFeatureEnabled: Boolean(conversation.human_agent_enabled),
    humanAgentApproved: Boolean(conversation.human_agent_approved),
  });
  if (!decision.allowed) return jsonResponse({ error: decision.reason }, 409);

  const result = await active.enqueueOutbox({ conversationId, text, idempotencyKey, actorId: user.id, tag: decision.tag });
  if (!result.ok) {
    const status = result.reason === "idempotency_conflict" ? 409 : result.reason === "disabled" ? 503 : 422;
    return jsonResponse({ error: result.reason }, status);
  }
  return jsonResponse({ outbox: minimizeOutbox(result.row) });
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

function createDeps(env: MessengerSendEnv, authToken: string): MessengerSendDeps {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("missing_supabase_config");
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    nowMs: () => Date.now(),
    verifyJwt: async (token) => {
      const { data, error } = await admin.auth.getUser(token);
      return error || !data.user ? null : { id: data.user.id };
    },
    hasModulePermission: async (userId, moduleKey, mode) => hasPermission(admin, userId, moduleKey, mode),
    resolveConversationPolicy: async (conversationId) => {
      const { data, error } = await admin.rpc("facebook_get_messenger_conversation_policy", { p_conversation_id: conversationId });
      if (error || !data) return null;
      const row = Array.isArray(data) ? data[0] : data;
      return row as ConversationPolicy;
    },
    enqueueOutbox: async (intent) => {
      const { data, error } = await admin.rpc("facebook_enqueue_messenger_outbox", {
        p_conversation_id: intent.conversationId,
        p_text: intent.text,
        p_idempotency_key: intent.idempotencyKey,
        p_tag: intent.tag,
        p_actor_id: intent.actorId,
      });
      if (error) return { ok: false, reason: safeError(error.message) };
      if (data?.ok === false) return { ok: false, reason: String(data.reason || "enqueue_failed") };
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

function safeError(message: string): string {
  if (message.includes("idempotency_conflict")) return "idempotency_conflict";
  if (message.includes("facebook_messenger_disabled")) return "disabled";
  return "enqueue_failed";
}
function minimizeOutbox(row: Record<string, unknown>): Record<string, unknown> {
  return { id: row.id, status: row.status, idempotency_key: row.idempotency_key };
}

if (import.meta.main) Deno.serve((request) => handleMessengerSend(request));
