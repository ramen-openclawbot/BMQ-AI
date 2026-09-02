declare const Deno: any;

type VerifyResult = { ok: true; appScopedUserId: string } | { ok: false; error: string };
type Env = { META_APP_SECRET?: string; PUBLIC_SITE_URL?: string; SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string };

type RegisterInput = {
  appScopedUserId: string;
  confirmationCodeHash: string;
  requestFingerprint: string;
};

type RegisterResult = {
  status: string;
  confirmationCodeHash?: string;
  requested_at?: string | null;
  completed_at?: string | null;
  repeated?: boolean;
};

type StatusResult = { status: string; requested_at: string | null; completed_at: string | null } | null;

type DeletionDeps = {
  registerDeletionRequest: (input: RegisterInput) => Promise<RegisterResult>;
};

type StatusDeps = {
  lookupDeletionStatus: (confirmationCodeHash: string) => Promise<StatusResult>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const FACEBOOK_DELETION_MAX_BODY_BYTES = 16 * 1024;
const CONFIRMATION_CODE_BYTES = 32;

export async function verifyMetaSignedRequest(signedRequest: string, appSecret: string): Promise<VerifyResult> {
  if (!appSecret) return { ok: false, error: "missing_app_secret" };
  const parts = signedRequest.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: "malformed_signed_request" };

  const [encodedSignature, encodedPayload] = parts;
  const expectedSignature = await hmacSha256Base64Url(appSecret, encodedPayload);
  if (!constantTimeStringEqual(encodedSignature, expectedSignature)) return { ok: false, error: "invalid_signature" };

  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(base64UrlDecode(encodedPayload)));
  } catch {
    return { ok: false, error: "malformed_payload" };
  }

  if (!isRecord(payload)) return { ok: false, error: "payload_not_object" };
  if (payload.algorithm !== "HMAC-SHA256") return { ok: false, error: "unsupported_algorithm" };
  if (typeof payload.user_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.user_id)) {
    return { ok: false, error: "missing_app_scoped_user_id" };
  }

  return { ok: true, appScopedUserId: payload.user_id };
}

export async function handleDataDeletionCallback(request: Request, env: Env, deps?: DeletionDeps): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return json({ error: "unsupported_media_type" }, 415);
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > FACEBOOK_DELETION_MAX_BODY_BYTES) {
    return json({ error: "body_too_large" }, 413);
  }

  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > FACEBOOK_DELETION_MAX_BODY_BYTES) return json({ error: "body_too_large" }, 413);

  const params = new URLSearchParams(decoder.decode(rawBody));
  const signedRequest = params.get("signed_request") || "";
  const verified = await verifyMetaSignedRequest(signedRequest, env.META_APP_SECRET || "");
  if (!verified.ok) return json({ error: "invalid_signed_request" }, 400);

  const confirmationCode = generateConfirmationCode();
  const confirmationCodeHash = await hashConfirmationCode(confirmationCode);
  const requestFingerprint = await hashText(`facebook-data-deletion:${verified.appScopedUserId}`);
  const register = deps ?? (await createSupabaseRpcDeps(env));
  await register.registerDeletionRequest({
    appScopedUserId: verified.appScopedUserId,
    confirmationCodeHash,
    requestFingerprint,
  });

  const siteUrl = normalizeSiteUrl(env.PUBLIC_SITE_URL || request.url);
  return json({
    url: `${siteUrl}/facebook-data-deletion.html?code=${encodeURIComponent(confirmationCode)}`,
    confirmation_code: confirmationCode,
  });
}

export async function handleStatusRequest(request: Request, deps: StatusDeps): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const url = new URL(request.url);
  const code = url.searchParams.get("code") || "";
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(code)) return json({ error: "invalid_code" }, 400);
  const status = await deps.lookupDeletionStatus(await hashConfirmationCode(code));
  if (!status) return json({ status: "not_found", requested_at: null, completed_at: null }, 404);
  return json({ status: status.status, requested_at: status.requested_at, completed_at: status.completed_at });
}

export async function hashConfirmationCode(code: string): Promise<string> {
  return hashText(`facebook-data-deletion-confirmation:${code}`);
}

async function createSupabaseRpcDeps(env: Env): Promise<DeletionDeps & StatusDeps> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("missing_supabase_configuration");
  const supabaseModule = "npm:@supabase/supabase-js@2.90.1";
  const { createClient } = await import(supabaseModule);
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    async registerDeletionRequest(input) {
      const { data, error } = await client.rpc("facebook_register_data_deletion_request", {
        p_app_scoped_user_id: input.appScopedUserId,
        p_confirmation_code_hash: input.confirmationCodeHash,
        p_request_fingerprint: input.requestFingerprint,
      });
      if (error) throw new Error("deletion_registration_failed");
      return Array.isArray(data) ? data[0] : data;
    },
    async lookupDeletionStatus(confirmationCodeHash) {
      const { data, error } = await client.rpc("facebook_lookup_data_deletion_status", {
        p_confirmation_code_hash: confirmationCodeHash,
      });
      if (error) throw new Error("deletion_status_lookup_failed");
      return Array.isArray(data) ? data[0] ?? null : data;
    },
  };
}

async function hmacSha256Base64Url(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return base64UrlEncode(new Uint8Array(signature));
}

async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return bytesToHex(new Uint8Array(digest));
}

function generateConfirmationCode(): string {
  const bytes = new Uint8Array(CONFIRMATION_CODE_BYTES);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < maxLength; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function normalizeSiteUrl(value: string): string {
  const parsed = new URL(value);
  return `${parsed.protocol}//${parsed.host}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

if (typeof Deno !== "undefined" && Deno?.serve) {
  Deno.serve(async (request: Request) => {
    const env: Env = {
      META_APP_SECRET: Deno.env.get("META_APP_SECRET"),
      PUBLIC_SITE_URL: Deno.env.get("PUBLIC_SITE_URL") || Deno.env.get("SITE_URL"),
      SUPABASE_URL: Deno.env.get("SUPABASE_URL"),
      SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    };
    const deps = await createSupabaseRpcDeps(env);
    const pathname = new URL(request.url).pathname;
    if (request.method === "GET" && pathname.endsWith("/status")) return handleStatusRequest(request, deps);
    return handleDataDeletionCallback(request, env, deps);
  });
}
