import { createClient } from "npm:@supabase/supabase-js@2.90.1";

declare const Deno: any;

type VerifyResult = { ok: true; appScopedUserId: string } | { ok: false; error: string };
type Env = {
  META_APP_SECRET?: string;
  META_APP_ID?: string;
  META_DELETION_CONFIRMATION_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

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

type DeletionDepsFactory = (env: Env) => Promise<DeletionDeps & StatusDeps>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const FACEBOOK_DELETION_MAX_BODY_BYTES = 16 * 1024;
const CONFIRMATION_CODE_BYTES = 32;
const CONFIRMATION_CODE_DOMAIN = "bmq-facebook-data-deletion-confirmation-code:v1";
const REQUEST_FINGERPRINT_DOMAIN = "bmq-facebook-data-deletion-request-fingerprint:v1";

export async function verifyMetaSignedRequest(signedRequest: string, appSecret: string, expectedAppId: string): Promise<VerifyResult> {
  if (!appSecret) return { ok: false, error: "missing_app_secret" };
  if (typeof expectedAppId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(expectedAppId)) return { ok: false, error: "missing_app_id" };
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
  if (typeof payload.app_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.app_id) || payload.app_id !== expectedAppId) {
    return { ok: false, error: "invalid_app_id" };
  }
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
  const verified = await verifyMetaSignedRequest(signedRequest, env.META_APP_SECRET || "", env.META_APP_ID || "");
  if (!verified.ok) return json({ error: "invalid_signed_request" }, 400);
  if (!env.META_DELETION_CONFIRMATION_SECRET) return json({ error: "missing_confirmation_secret" }, 500);

  const statusUrlBase = validateStatusUrlBase(env.SUPABASE_URL || "");
  if (!statusUrlBase.ok) return json({ error: "invalid_status_url_configuration" }, 500);

  const confirmationCode = await deriveConfirmationCode(env.META_DELETION_CONFIRMATION_SECRET, verified.appScopedUserId);
  const confirmationCodeHash = await hashConfirmationCode(confirmationCode);
  const requestFingerprint = await deriveRequestFingerprint(env.META_DELETION_CONFIRMATION_SECRET, verified.appScopedUserId);
  const register = deps ?? (await createSupabaseRpcDeps(env));
  await register.registerDeletionRequest({
    appScopedUserId: verified.appScopedUserId,
    confirmationCodeHash,
    requestFingerprint,
  });

  return json({
    url: buildStatusUrl(statusUrlBase.origin, confirmationCode),
    confirmation_code: confirmationCode,
  });
}

export async function handleStatusRequest(request: Request, deps: StatusDeps): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const url = new URL(request.url);
  const code = url.searchParams.get("code") || "";
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(code)) return json({ error: "invalid_code" }, 400);
  const status = await deps.lookupDeletionStatus(await hashConfirmationCode(code));
  const body = status ?? { status: "not_found", requested_at: null, completed_at: null };
  const statusCode = status ? 200 : 404;
  if (url.searchParams.get("format") === "json") {
    return json({ status: body.status, requested_at: body.requested_at, completed_at: body.completed_at }, statusCode);
  }
  return html(renderStatusHtml(body), statusCode);
}

export async function hashConfirmationCode(code: string): Promise<string> {
  return hashText(`facebook-data-deletion-confirmation:${code}`);
}

async function createSupabaseRpcDeps(env: Env): Promise<DeletionDeps & StatusDeps> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("missing_supabase_configuration");
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

async function deriveConfirmationCode(secret: string, appScopedUserId: string): Promise<string> {
  const bytes = await hmacSha256Bytes(secret, `${CONFIRMATION_CODE_DOMAIN}:${appScopedUserId}`);
  return base64UrlEncode(bytes.slice(0, CONFIRMATION_CODE_BYTES));
}

async function deriveRequestFingerprint(secret: string, appScopedUserId: string): Promise<string> {
  const bytes = await hmacSha256Bytes(secret, `${REQUEST_FINGERPRINT_DOMAIN}:${appScopedUserId}`);
  return bytesToHex(bytes);
}

async function hmacSha256Base64Url(secret: string, text: string): Promise<string> {
  return base64UrlEncode(await hmacSha256Bytes(secret, text));
}

async function hmacSha256Bytes(secret: string, text: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return new Uint8Array(signature);
}

async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return bytesToHex(new Uint8Array(digest));
}

function validateStatusUrlBase(configuredUrl: string): { ok: true; origin: string } | { ok: false } {
  if (!configuredUrl) return { ok: false };
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    return { ok: false };
  }
  if (parsed.username || parsed.password || parsed.hash) return { ok: false };
  const isLocalHttp = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !isLocalHttp) return { ok: false };
  return { ok: true, origin: parsed.origin };
}

function buildStatusUrl(trustedOrigin: string, confirmationCode: string): string {
  const statusUrl = new URL("/functions/v1/facebook-data-deletion/status", trustedOrigin);
  statusUrl.searchParams.set("code", confirmationCode);
  return statusUrl.toString();
}

function renderStatusHtml(status: Exclude<StatusResult, null>): string {
  const labels: Record<string, string> = {
    requested: "Đã nhận yêu cầu, đang chờ xử lý.",
    processing: "Yêu cầu đang được xử lý.",
    pending_manual_mapping: "BMQ đã nhận yêu cầu nhưng cần đối chiếu thủ công để xác định đúng hội thoại. Trạng thái này không có nghĩa là đã xóa xong.",
    completed: "Đã hoàn tất xóa dữ liệu Messenger được ánh xạ chắc chắn.",
    failed: "Yêu cầu gặp lỗi xử lý. Vui lòng liên hệ BMQ bằng mã xác nhận đã nhận.",
    not_found: "Không tìm thấy yêu cầu cho mã xác nhận này.",
  };
  const label = labels[status.status] || "Trạng thái chưa xác định.";
  const requested = status.requested_at ? `<p><strong>Thời điểm nhận:</strong> <time>${escapeHtml(status.requested_at)}</time></p>` : "";
  const completed = status.completed_at ? `<p><strong>Hoàn tất:</strong> <time>${escapeHtml(status.completed_at)}</time></p>` : "";
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Trạng thái xóa dữ liệu Messenger | BMQ</title>
  <style>
    body { margin: 0; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #fff7ed; color: #1f2937; line-height: 1.6; }
    main { max-width: 760px; margin: 0 auto; padding: 40px 20px 64px; }
    .card { background: #fff; border: 1px solid #fed7aa; border-radius: 18px; padding: 24px; box-shadow: 0 12px 30px rgba(146, 64, 14, .08); }
    h1 { line-height: 1.2; }
    .status { background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px; padding: 14px 16px; }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <p>Bánh Mì Que · BMQ</p>
      <h1>Trạng thái xóa dữ liệu Messenger</h1>
      <div class="status"><strong>${escapeHtml(status.status)}</strong>: ${escapeHtml(label)}</div>
      ${requested}
      ${completed}
      <p>Trang công khai, không cần đăng nhập. Trang này chỉ hiển thị trạng thái tối thiểu và không hiển thị định danh hoặc nội dung Messenger.</p>
    </section>
  </main>
</body>
</html>`;
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function handleDataDeletionHttpRequest(
  request: Request,
  env: Env,
  depsFactory: DeletionDepsFactory = createSupabaseRpcDeps,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (request.method === "GET" && pathname.endsWith("/status")) {
    const code = new URL(request.url).searchParams.get("code") || "";
    if (!/^[A-Za-z0-9_-]{22,128}$/.test(code)) return json({ error: "invalid_code" }, 400);
    try {
      return handleStatusRequest(request, await depsFactory(env));
    } catch {
      return json({ error: "service_unavailable" }, 503);
    }
  }
  return handleDataDeletionCallback(request, env);
}

if (typeof Deno !== "undefined" && Deno?.serve) {
  Deno.serve((request: Request) => {
    const env: Env = {
      META_APP_SECRET: Deno.env.get("META_APP_SECRET"),
      META_APP_ID: Deno.env.get("META_APP_ID"),
      META_DELETION_CONFIRMATION_SECRET: Deno.env.get("META_DELETION_CONFIRMATION_SECRET"),
      SUPABASE_URL: Deno.env.get("SUPABASE_URL"),
      SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    };
    return handleDataDeletionHttpRequest(request, env);
  });
}
