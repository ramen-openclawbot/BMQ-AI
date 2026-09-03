import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { constantTimeStringEqual } from "../_shared/facebook-messenger.ts";

export type MessengerWorkerEnv = { FACEBOOK_MESSENGER_WORKER_SECRET?: string; META_PAGE_ACCESS_TOKEN?: string; SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string };
export type ClaimedOutbox = { id: string; page_id: string; psid: string; text: string; tag: "RESPONSE" | "HUMAN_AGENT"; attempt_count: number; lease_token: string };
export type GraphResult = { kind: "accepted"; messageId: string } | { kind: "ambiguous_timeout"; safeReason: string } | { kind: "definitive_rejection"; safeCode: string };
export type MessengerWorkerDeps = {
  claimPending: () => Promise<ClaimedOutbox[]>;
  markSendCommitted: (id: string, leaseToken: string) => Promise<boolean>;
  postGraphMessage: (input: { endpoint: string; pageAccessToken: string; psid: string; text: string; tag: string }) => Promise<GraphResult>;
  markSent: (id: string, messageId: string, evidence: Record<string, unknown>) => Promise<void>;
  markFailed: (id: string, reason: string, evidence: Record<string, unknown>) => Promise<void>;
  markManualReconciliationRequired: (id: string, reason: string, evidence: Record<string, unknown>) => Promise<void>;
};

const jsonResponse = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SAFE_CODE_RE = /^[a-z0-9_:-]{1,80}$/;

export async function handleMessengerWorker(request: Request, env: MessengerWorkerEnv = Deno.env.toObject(), deps?: MessengerWorkerDeps): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  if (!env.FACEBOOK_MESSENGER_WORKER_SECRET || !env.META_PAGE_ACCESS_TOKEN) return jsonResponse({ error: "service_unavailable" }, 503);
  const supplied = request.headers.get("x-worker-secret") ?? "";
  if (!constantTimeStringEqual(supplied, env.FACEBOOK_MESSENGER_WORKER_SECRET)) return jsonResponse({ error: "unauthorized" }, 401);

  const active = deps ?? createDeps(env);
  try {
    const rows = await active.claimPending();
    let processed = 0;
    let manual = 0;
    let failed = 0;
    let sent = 0;
    let lostClaim = 0;
    for (const row of rows) {
      const committed = await active.markSendCommitted(row.id, row.lease_token);
      if (!committed) {
        lostClaim += 1;
        continue;
      }
      const result = await active.postGraphMessage({
        endpoint: `/v26.0/${encodeURIComponent(row.page_id)}/messages`,
        pageAccessToken: env.META_PAGE_ACCESS_TOKEN,
        psid: row.psid,
        text: row.text,
        tag: row.tag,
      });
      if (result.kind === "accepted") {
        await active.markSent(row.id, boundedMid(result.messageId), { provider: "meta", status: "accepted" });
        sent += 1;
      } else if (result.kind === "ambiguous_timeout") {
        await active.markManualReconciliationRequired(row.id, safeCode(result.safeReason) || "timeout_requires_manual_reconciliation", { provider: "meta", status: "ambiguous_timeout" });
        manual += 1;
      } else {
        await active.markFailed(row.id, safeCode(result.safeCode) || "provider_error_sanitized", { provider: "meta", status: "definitive_rejection" });
        failed += 1;
      }
      processed += 1;
    }
    return jsonResponse({ processed, sent, failed, manual_reconciliation_required: manual, lost_claim: lostClaim });
  } catch {
    return jsonResponse({ error: "internal_failure" }, 500);
  }
}

function createDeps(env: MessengerWorkerEnv): MessengerWorkerDeps {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.META_PAGE_ACCESS_TOKEN) throw new Error("missing_config");
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    claimPending: async () => {
      const { data, error } = await admin.rpc("facebook_claim_messenger_outbox", { p_limit: 10 });
      if (error) throw error;
      return (data || []) as ClaimedOutbox[];
    },
    markSendCommitted: async (id, leaseToken) => {
      const { data, error } = await admin.rpc("facebook_mark_messenger_outbox_send_committed", { p_outbox_id: id, p_lease_token: leaseToken });
      if (error) throw error;
      return data === true;
    },
    postGraphMessage: async (input) => postGraph(input),
    markSent: async (id, messageId, evidence) => {
      const { error } = await admin.rpc("facebook_mark_messenger_outbox_sent", { p_outbox_id: id, p_provider_message_id: messageId, p_evidence: evidence });
      if (error) throw error;
    },
    markFailed: async (id, reason, evidence) => {
      const { error } = await admin.rpc("facebook_mark_messenger_outbox_failed", { p_outbox_id: id, p_safe_reason: reason, p_evidence: evidence });
      if (error) throw error;
    },
    markManualReconciliationRequired: async (id, reason, evidence) => {
      const { error } = await admin.rpc("facebook_mark_messenger_outbox_manual_reconciliation", { p_outbox_id: id, p_safe_reason: reason, p_evidence: evidence });
      if (error) throw error;
    },
  };
}

async function postGraph(input: { endpoint: string; pageAccessToken: string; psid: string; text: string; tag: string }): Promise<GraphResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const url = `https://graph.facebook.com${input.endpoint}`;
    const body: Record<string, unknown> = {
      recipient: { id: input.psid },
      message: { text: input.text },
      messaging_type: input.tag === "HUMAN_AGENT" ? "MESSAGE_TAG" : "RESPONSE",
    };
    if (input.tag === "HUMAN_AGENT") body.tag = "HUMAN_AGENT";
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${input.pageAccessToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const parsed = await safeJson(response);
    if (response.ok && typeof parsed?.message_id === "string") return { kind: "accepted", messageId: parsed.message_id };
    const code = sanitizeProviderCode(parsed?.error?.code, response.status);
    return { kind: "definitive_rejection", safeCode: code };
  } catch {
    return { kind: "ambiguous_timeout", safeReason: "timeout_requires_manual_reconciliation" };
  } finally {
    clearTimeout(timeout);
  }
}

async function safeJson(response: Response): Promise<any> {
  try { return await response.json(); } catch { return {}; }
}
function sanitizeProviderCode(code: unknown, status: number): string {
  if (status === 429) return "provider_rate_limited";
  const safe = safeCode(String(code ?? "provider_error"));
  return safe ? `provider_error_${safe}`.slice(0, 80) : "provider_error_sanitized";
}
function safeCode(value: string): string | null {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 80);
  return SAFE_CODE_RE.test(normalized) ? normalized : null;
}
function boundedMid(value: string): string {
  return value.slice(0, 256);
}

if (import.meta.main) Deno.serve((request) => handleMessengerWorker(request));
