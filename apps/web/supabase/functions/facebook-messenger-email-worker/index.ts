import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { constantTimeStringEqual } from "../_shared/facebook-messenger.ts";

export type MessengerEmailWorkerEnv = {
  INSTINCT_EMAIL_WORKER_SECRET?: string;
  INSTINCT_EMAIL_RESEND_API_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};
export type ClaimedEmail = { id: string; recipient_email: string; subject: string; payload: Record<string, unknown>; email_fingerprint: string };
export type EmailResult = { kind: "accepted"; providerId: string } | { kind: "ambiguous_timeout"; safeReason: string } | { kind: "definitive_rejection"; safeCode: string };
export type MessengerEmailWorkerDeps = {
  claimPending: () => Promise<ClaimedEmail[]>;
  sendCommit: (row: ClaimedEmail) => Promise<boolean>;
  sendEmail: (input: { to: string; subject: string; text: string; idempotencyKey: string; payload: Record<string, unknown> }) => Promise<EmailResult>;
  markSent: (id: string, providerId: string, evidence: Record<string, unknown>) => Promise<void>;
  markFailed: (id: string, reason: string, evidence: Record<string, unknown>) => Promise<void>;
  markManualReconciliationRequired: (id: string, reason: string, evidence: Record<string, unknown>) => Promise<void>;
};

const AGENT_EMAIL = "inboxoggxdk@agent.instinct.co";
const SAFE_CODE_RE = /^[a-z0-9_:-]{1,120}$/;
const jsonResponse = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleMessengerEmailWorker(request: Request, env: MessengerEmailWorkerEnv = Deno.env.toObject(), deps?: MessengerEmailWorkerDeps): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  if (!env.INSTINCT_EMAIL_WORKER_SECRET || !env.INSTINCT_EMAIL_RESEND_API_KEY) return jsonResponse({ error: "service_unavailable" }, 503);
  const supplied = request.headers.get("x-worker-secret") ?? "";
  if (!constantTimeStringEqual(supplied, env.INSTINCT_EMAIL_WORKER_SECRET)) return jsonResponse({ error: "unauthorized" }, 401);

  const active = deps ?? createDeps(env);
  const rows = await active.claimPending();
  let sent = 0;
  let failed = 0;
  let manual = 0;
  let skippedCommitFalse = 0;
  for (const row of rows) {
    if (row.recipient_email !== AGENT_EMAIL) {
      await active.markFailed(row.id, "invalid_recipient", { provider: "email", status: "blocked" });
      failed += 1;
      continue;
    }
    const outbound = buildEmail(row);
    if (!(await active.sendCommit(row))) {
      skippedCommitFalse += 1;
      continue;
    }
    const result = await active.sendEmail(outbound);
    if (result.kind === "accepted") {
      await active.markSent(row.id, boundedProviderId(result.providerId), { provider: "resend", status: "accepted" });
      sent += 1;
    } else if (result.kind === "ambiguous_timeout") {
      await active.markManualReconciliationRequired(row.id, safeCode(result.safeReason) || "timeout_requires_manual_reconciliation", { provider: "resend", status: "ambiguous_timeout" });
      manual += 1;
    } else {
      await active.markFailed(row.id, safeCode(result.safeCode) || "provider_rejected", { provider: "resend", status: "definitive_rejection" });
      failed += 1;
    }
  }
  return jsonResponse({ processed: rows.length, sent, failed, manual_reconciliation_required: manual, skipped_commit_false: skippedCommitFalse });
}

function buildEmail(row: ClaimedEmail): { to: string; subject: string; text: string; idempotencyKey: string; payload: Record<string, unknown> } {
  const payload = minimizePayload(row.payload);
  const text = [
    "New Facebook Messenger message for Instinct.",
    `thread_id: ${payload.thread_id}`,
    `notification_id: ${payload.notification_id}`,
    `sender: ${payload.sender_display}`,
    "",
    String(payload.message_preview || ""),
  ].join("\n");
  return { to: AGENT_EMAIL, subject: row.subject.slice(0, 160), text, idempotencyKey: row.email_fingerprint, payload };
}
function minimizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    thread_id: String(payload.thread_id || ""),
    notification_id: String(payload.notification_id || ""),
    sender_display: String(payload.sender_display || "Facebook sender").slice(0, 120),
    message_preview: String(payload.message_preview || "").slice(0, 1000),
    received_at: String(payload.received_at || "").slice(0, 40),
    source: "facebook_messenger",
  };
}
function createDeps(env: MessengerEmailWorkerEnv): MessengerEmailWorkerDeps {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.INSTINCT_EMAIL_RESEND_API_KEY) throw new Error("missing_config");
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    claimPending: async () => {
      const { data, error } = await admin.rpc("facebook_claim_messenger_email_notifications", { p_limit: 10 });
      if (error) throw error;
      return (data || []) as ClaimedEmail[];
    },
    sendCommit: async (row) => {
      const { data, error } = await admin.rpc("facebook_commit_messenger_email_send", { p_email_id: row.id });
      if (error) throw error;
      return data === true;
    },
    sendEmail: async (input) => sendResendEmail(env.INSTINCT_EMAIL_RESEND_API_KEY!, input),
    markSent: async (id, providerId, evidence) => {
      const { error } = await admin.rpc("facebook_mark_messenger_email_sent", { p_email_id: id, p_provider_id: providerId, p_evidence: evidence });
      if (error) throw error;
    },
    markFailed: async (id, reason, evidence) => {
      const { error } = await admin.rpc("facebook_mark_messenger_email_failed", { p_email_id: id, p_safe_reason: reason, p_evidence: evidence });
      if (error) throw error;
    },
    markManualReconciliationRequired: async (id, reason, evidence) => {
      const { error } = await admin.rpc("facebook_mark_messenger_email_manual_reconciliation", { p_email_id: id, p_safe_reason: reason, p_evidence: evidence });
      if (error) throw error;
    },
  };
}
async function sendResendEmail(apiKey: string, input: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<EmailResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": input.idempotencyKey },
      body: JSON.stringify({ from: "BMQ Messenger <messenger@banhmique.vn>", to: [AGENT_EMAIL], subject: input.subject, text: input.text }),
      signal: controller.signal,
    });
    const parsed = await safeJson(response);
    if (response.ok && typeof parsed?.id === "string") return { kind: "accepted", providerId: parsed.id };
    return { kind: "definitive_rejection", safeCode: response.status === 429 ? "provider_rate_limited" : "provider_rejected" };
  } catch {
    return { kind: "ambiguous_timeout", safeReason: "timeout_requires_manual_reconciliation" };
  } finally {
    clearTimeout(timeout);
  }
}
async function safeJson(response: Response): Promise<any> { try { return await response.json(); } catch { return {}; } }
function safeCode(value: string): string | null { const s = value.toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 120); return SAFE_CODE_RE.test(s) ? s : null; }
function boundedProviderId(value: string): string { return value.slice(0, 256); }

if (import.meta.main) Deno.serve((request) => handleMessengerEmailWorker(request));
