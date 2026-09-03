import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { constantTimeStringEqual } from "../_shared/facebook-messenger.ts";

export type AgentReplyEnv = {
  META_INSTINCT_REPLY_SECRET?: string;
  META_INSTINCT_REPLY_SECRET_PREVIOUS?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};
export type AgentReplyDeps = {
  nowSeconds: () => number;
  recordNonce: (nonce: string, timestampSeconds: number) => Promise<boolean>;
  enqueueReply: (input: { threadId: string; text: string; idempotencyKey: string; source: "instinct_bridge"; requestId: string; clientEvidence: Record<string, unknown> }) => Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; reason: string }>;
  requestId?: () => string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{32,128}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,96}$/;
const SIGNATURE_RE = /^[0-9a-f]{64}$/;
const MAX_TEXT = 2000;
const MAX_BODY_BYTES = 8192;
const MAX_SKEW_SECONDS = 300;
const encoder = new TextEncoder();

const jsonResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handleAgentReply(request: Request, env: AgentReplyEnv = Deno.env.toObject(), deps?: AgentReplyDeps): Promise<Response> {
  const requestId = deps?.requestId?.() ?? crypto.randomUUID();
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  const currentSecret = env.META_INSTINCT_REPLY_SECRET;
  if (!currentSecret || currentSecret.length < 16) return jsonResponse({ error: "service_unavailable" }, 503);

  const rawBody = await readBoundedBody(request);
  if (!rawBody) return jsonResponse({ error: "invalid_body" }, 422);

  const timestampHeader = request.headers.get("x-instinct-timestamp") ?? "";
  const nonce = request.headers.get("x-instinct-nonce") ?? "";
  const signature = request.headers.get("x-instinct-signature") ?? "";
  if (!/^\d{10}$/.test(timestampHeader) || !NONCE_RE.test(nonce) || !SIGNATURE_RE.test(signature)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const active = deps ?? createDeps(env);
  const timestampSeconds = Number(timestampHeader);
  if (Math.abs(active.nowSeconds() - timestampSeconds) > MAX_SKEW_SECONDS) {
    return jsonResponse({ error: "stale_timestamp_rejected" }, 401);
  }

  const signedBytes = concatBytes(encoder.encode(`${timestampHeader}.${nonce}.`), rawBody);
  const ok = await verifyAnySecret(signature, signedBytes, [currentSecret, env.META_INSTINCT_REPLY_SECRET_PREVIOUS].filter((v): v is string => Boolean(v)));
  if (!ok) return jsonResponse({ error: "bad_hmac_rejected" }, 401);

  if (!(await active.recordNonce(nonce, timestampSeconds))) return jsonResponse({ error: "nonce_replay_rejected" }, 409);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "idempotency_key,text,thread_id") return jsonResponse({ error: "invalid_schema" }, 422);
  const threadId = typeof body.thread_id === "string" ? body.thread_id.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (!UUID_RE.test(threadId)) return jsonResponse({ error: "invalid_thread_id" }, 422);
  if (text.length === 0 || text.length > MAX_TEXT) return jsonResponse({ error: "invalid_text" }, 422);
  if (!IDEMPOTENCY_RE.test(idempotencyKey)) return jsonResponse({ error: "invalid_idempotency_key" }, 422);

  const result = await active.enqueueReply({
    threadId,
    text,
    idempotencyKey,
    source: "instinct_bridge",
    requestId,
    clientEvidence: { auth: "hmac_sha256", nonce_hash: await sha256Hex(nonce), timestamp_seconds: timestampSeconds },
  });
  if (!result.ok) return jsonResponse({ error: result.reason }, statusForReason(result.reason));
  return jsonResponse({ outbox: minimizeOutbox(result.row) });
}

function statusForReason(reason: string): number {
  if (reason === "thread_not_found") return 404;
  if (reason === "disabled") return 503;
  if (reason === "rate_limited") return 429;
  if (reason === "idempotency_conflict") return 409;
  if (reason === "outside_window") return 409;
  if (reason === "suppressed") return 409;
  return 422;
}

function createDeps(env: AgentReplyEnv): AgentReplyDeps {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("missing_supabase_config");
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    nowSeconds: () => Math.floor(Date.now() / 1000),
    recordNonce: async (nonce, timestampSeconds) => {
      const { data, error } = await admin.rpc("facebook_record_instinct_reply_nonce", { p_nonce: nonce, p_timestamp_seconds: timestampSeconds });
      return !error && data === true;
    },
    enqueueReply: async (input) => {
      const { data, error } = await admin.rpc("facebook_enqueue_instinct_messenger_reply", {
        p_thread_id: input.threadId,
        p_text: input.text,
        p_idempotency_key: input.idempotencyKey,
        p_request_id: input.requestId,
        p_client_evidence: input.clientEvidence,
      });
      if (error) return { ok: false, reason: safeError(error.message) };
      if (data?.ok === false) return { ok: false, reason: String(data.reason || "enqueue_failed") };
      return { ok: true, row: data?.row ?? data };
    },
  };
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^[0-9]+$/.test(declared)) return null;
    if (Number(declared) > MAX_BODY_BYTES) return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released/cancelled */ }
  }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function verifyAnySecret(expectedHex: string, data: Uint8Array, secrets: string[]): Promise<boolean> {
  let matched = false;
  for (const secret of secrets.slice(0, 2)) {
    const actual = await hmacSha256Hex(secret, data);
    matched = constantTimeStringEqual(actual, expectedHex) || matched;
  }
  return matched;
}
async function hmacSha256Hex(secret: string, data: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const exact = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const signature = await crypto.subtle.sign("HMAC", key, exact);
  return hex(new Uint8Array(signature));
}
async function sha256Hex(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function safeError(message: string): string {
  if (message.includes("idempotency_conflict")) return "idempotency_conflict";
  if (message.includes("outside_window")) return "outside_window";
  if (message.includes("thread_not_found") || message.includes("conversation_not_found")) return "thread_not_found";
  if (message.includes("suppressed")) return "suppressed";
  if (message.includes("disabled")) return "disabled";
  if (message.includes("rate_limited")) return "rate_limited";
  return "enqueue_failed";
}
function minimizeOutbox(row: Record<string, unknown>): Record<string, unknown> {
  return { id: row.id, status: row.status, idempotency_key: row.idempotency_key };
}

if (import.meta.main) Deno.serve((request) => handleAgentReply(request));
