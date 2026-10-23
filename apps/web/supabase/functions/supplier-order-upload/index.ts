// Public supplier delivery-document upload endpoint.
//
// No user auth: the one-time link token is hashed and resolved by a service-role
// RPC. The GET response only exposes the order summary (never storage paths or
// the token); uploads are stored privately in supplier-delivery-docs.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflightResponse, getCorsHeaders } from "../_shared/cors.ts";

const BUCKET = "supplier-delivery-docs";
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_UPLOADS_PER_HOUR = 30;
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const uploadWindows = new Map<string, number[]>();

function jsonResponse(
  body: unknown,
  status: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function allowUpload(tokenHash: string): boolean {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const previous = (uploadWindows.get(tokenHash) ?? []).filter(
    (timestamp) => timestamp > windowStart,
  );
  if (previous.length >= MAX_UPLOADS_PER_HOUR) {
    uploadWindows.set(tokenHash, previous);
    return false;
  }
  previous.push(now);
  uploadWindows.set(tokenHash, previous);
  if (uploadWindows.size > 5000) {
    for (const [key, timestamps] of uploadWindows) {
      if (!timestamps.some((timestamp) => timestamp > windowStart)) {
        uploadWindows.delete(key);
      }
    }
  }
  return true;
}

function safeFileName(raw: string | null, mime: string): string {
  let decoded = "";
  try {
    decoded = decodeURIComponent(String(raw ?? ""));
  } catch {
    decoded = String(raw ?? "");
  }
  const base = decoded
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return base || `delivery-document.${EXTENSIONS[mime] ?? "bin"}`;
}

function vnDateCompact(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replace(/-/g, "");
}

function errorMessage(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return "";
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  const url = new URL(req.url);
  const token = String(url.searchParams.get("t") ?? "").trim();
  const cors = corsHeaders;

  if (!token) return jsonResponse({ code: "link_invalid" }, 404, cors);

  const tokenHash = await sha256Hex(new TextEncoder().encode(token));
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (req.method === "GET") {
    const resolved = await admin.rpc("resolve_supplier_order_upload_token", {
      p_token_hash: tokenHash,
    });
    if (resolved.error || !resolved.data) {
      return jsonResponse({ code: "link_invalid" }, 404, cors);
    }
    const data = resolved.data as Record<string, unknown>;
    // Explicit projection: never expose storage paths or the link token.
    return jsonResponse(
      {
        po_number: data.po_number ?? null,
        supplier_name: data.supplier_name ?? null,
        product_name: data.product_name ?? null,
        quantity: data.quantity ?? null,
        unit: data.unit ?? null,
        sent_at: data.sent_at ?? null,
        upload_count: data.upload_count ?? 0,
      },
      200,
      cors,
    );
  }

  if (req.method !== "POST") {
    return jsonResponse({ code: "method_not_allowed" }, 405, cors);
  }

  if (!allowUpload(tokenHash)) {
    return jsonResponse({ code: "rate_limited" }, 429, cors);
  }

  const resolved = await admin.rpc("resolve_supplier_order_upload_token", {
    p_token_hash: tokenHash,
  });
  if (resolved.error || !resolved.data) {
    return jsonResponse({ code: "link_invalid" }, 404, cors);
  }
  const resolvedData = resolved.data as Record<string, unknown>;
  const orderRequestId = String(resolvedData.order_request_id ?? "");
  if (!orderRequestId) {
    return jsonResponse({ code: "link_invalid" }, 404, cors);
  }

  const mime = String(req.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!ALLOWED_TYPES.has(mime)) {
    return jsonResponse({ code: "unsupported_type" }, 415, cors);
  }
  // Refuse before reading the body or writing to storage.
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
    return jsonResponse({ code: "file_too_large" }, 413, cors);
  }
  if (Number(resolvedData.upload_count ?? 0) >= 10) {
    return jsonResponse({ code: "upload_limit_reached" }, 409, cors);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await req.arrayBuffer());
  } catch {
    return jsonResponse({ code: "empty_file" }, 413, cors);
  }
  if (bytes.byteLength === 0) {
    return jsonResponse({ code: "empty_file" }, 413, cors);
  }
  if (bytes.byteLength > MAX_BYTES) {
    return jsonResponse({ code: "file_too_large" }, 413, cors);
  }

  const fileName = safeFileName(req.headers.get("x-file-name"), mime);
  const sha256 = await sha256Hex(bytes);
  const extension = EXTENSIONS[mime] ?? "bin";
  const storagePath = `${orderRequestId}/${vnDateCompact()}-${sha256.slice(0, 16)}.${extension}`;

  const upload = await admin.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: mime,
    upsert: true,
  });
  if (upload.error) {
    return jsonResponse({ code: "storage_failed" }, 500, cors);
  }

  const recorded = await admin.rpc("record_supplier_order_upload", {
    p_token_hash: tokenHash,
    p_storage_path: storagePath,
    p_file_name: fileName,
    p_mime: mime,
    p_size: bytes.byteLength,
    p_sha256: sha256,
  });
  if (recorded.error) {
    const message = errorMessage(recorded.error);
    if (message.includes("upload_limit_reached")) {
      return jsonResponse({ code: "upload_limit_reached" }, 409, cors);
    }
    if (message.includes("link_invalid")) {
      return jsonResponse({ code: "link_invalid" }, 404, cors);
    }
    if (message.includes("unsupported_type")) {
      return jsonResponse({ code: "unsupported_type" }, 415, cors);
    }
    if (message.includes("invalid_file_size")) {
      return jsonResponse({ code: "file_too_large" }, 413, cors);
    }
    return jsonResponse({ code: "record_failed" }, 500, cors);
  }

  const data = (recorded.data ?? {}) as Record<string, unknown>;
  return jsonResponse(
    { uploaded: true, count: Number(data.count ?? 0) },
    200,
    cors,
  );
});
