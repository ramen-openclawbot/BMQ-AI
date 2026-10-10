import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { callOpenAiVision } from "../_shared/bank-slip-ocr.ts";

// Untyped database schema: the generated types are not shared with edge functions.
// deno-lint-ignore no-explicit-any
type AdminClient = ReturnType<typeof createClient<any>>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNC_BUCKET = "payment-unc";
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const jsonResponse = (req: Request, status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });

const structuredError = (req: Request, status: number, code: string, detail?: string) =>
  jsonResponse(req, status, { success: false, error: code, code, detail });

const asTrimmed = (value: unknown): string => String(value ?? "").trim();

const numericOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const decodeBase64 = (input: string): Uint8Array => {
  const raw = input.startsWith("data:") && input.includes(",")
    ? input.slice(input.indexOf(",") + 1)
    : input;
  const binary = atob(raw.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const vietnamYearMonth = (date: Date): { year: string; month: string } => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const valueOf = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";
  return { year: valueOf("year"), month: valueOf("month") };
};

/**
 * The caller must be owner, the PR creator, or have payment_requests edit.
 * Checked server-side with the service role so the client cannot spoof it.
 */
async function requireSettlementAccess(
  req: Request,
  supabaseAdmin: AdminClient,
  requestId: string,
): Promise<{ id: string; token: string } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return structuredError(req, 401, "not_allowed", "missing_authorization");
  }
  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return structuredError(req, 401, "not_allowed", "invalid_token");

  const { data: request, error: requestError } = await supabaseAdmin
    .from("payment_requests")
    .select("id,created_by")
    .eq("id", requestId)
    .maybeSingle();
  if (requestError) return structuredError(req, 500, "request_lookup_failed");
  if (!request) return structuredError(req, 404, "request_not_found");

  const { data: roles, error: roleError } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id);
  if (roleError) return structuredError(req, 500, "role_lookup_failed");
  const isOwner = (roles || []).some((row: { role?: string | null }) => row.role === "owner");

  const isCreator = request.created_by === user.id;
  if (!isOwner && !isCreator) {
    // Same rule as public.can_edit_payment_request (has_module_permission is service_role only).
    const { data: canEdit, error: permissionError } = await supabaseAdmin.rpc("has_module_permission", {
      _user_id: user.id,
      _module_key: "payment_requests",
      _permission: "edit",
    });
    if (permissionError) return structuredError(req, 500, "permission_lookup_failed");
    if (canEdit !== true) return structuredError(req, 403, "not_allowed", "payment_requests_edit_required");
  }

  return { id: user.id, token };
}

const findActiveReceiptBySha = async (supabaseAdmin: AdminClient, fileSha256: string) => {
  const { data, error } = await supabaseAdmin
    .from("payment_cash_receipts")
    .select("*")
    .eq("file_sha256", fileSha256)
    .neq("status", "discarded")
    .maybeSingle();
  if (error) return { receipt: null, error };
  return { receipt: data, error: null };
};

const handleExtract = async (
  req: Request,
  supabaseAdmin: AdminClient,
  body: Record<string, unknown>,
  actorId: string,
): Promise<Response> => {
  const requestId = asTrimmed(body.request_id || body.requestId);
  if (!UUID_RE.test(requestId)) return structuredError(req, 400, "request_id_required");

  const imageBase64 = asTrimmed(body.image_base64 || body.imageBase64);
  if (!imageBase64) return structuredError(req, 400, "image_required");

  const mimeType = asTrimmed(body.mime_type || body.mimeType) || "image/jpeg";
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    return structuredError(req, 400, "invalid_image_type");
  }
  if (imageBase64.length > 10 * 1024 * 1024) {
    return structuredError(req, 400, "image_too_large");
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(imageBase64);
  } catch {
    return structuredError(req, 400, "invalid_image_encoding");
  }

  const fileSha256 = await sha256Hex(bytes);

  // One active receipt per sha256 worldwide (partial unique index). A repeated
  // upload returns the existing row instead of writing a second file.
  const existing = await findActiveReceiptBySha(supabaseAdmin, fileSha256);
  if (existing.error) {
    console.error("[payment-cash-settle] Duplicate lookup failed", existing.error.message);
    return structuredError(req, 500, "receipt_lookup_failed");
  }
  if (existing.receipt) {
    return jsonResponse(req, 200, {
      success: true,
      mode: "extract",
      duplicate: true,
      receipt: existing.receipt,
    });
  }

  const { year, month } = vietnamYearMonth(new Date());
  const extension = MIME_EXTENSIONS[mimeType] || "jpg";
  const objectPath = `cash-receipts/${year}/${month}/${fileSha256}.${extension}`;
  const storagePath = `${UNC_BUCKET}/${objectPath}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(UNC_BUCKET)
    .upload(objectPath, bytes, { contentType: mimeType, upsert: true });
  if (uploadError) {
    console.error("[payment-cash-settle] Upload failed", uploadError.message);
    return structuredError(req, 500, "upload_failed");
  }

  // The cash slip prompt is the same OCR pipeline used by payment-unc-approve
  // with slip_type 'cash' (retail receipts / ride-hailing screenshots included).
  let extracted: (Awaited<ReturnType<typeof callOpenAiVision>> & {
    reference?: unknown;
    transfer_date?: unknown;
    beneficiary_name?: unknown;
    transfer_content?: unknown;
  }) | null = null;
  let ocrError: string | null = null;
  try {
    extracted = await callOpenAiVision(imageBase64, mimeType, "cash", { readBeneficiary: true });
  } catch (error) {
    ocrError = (error instanceof Error ? error.message : "ocr_failed").slice(0, 500);
    console.error("[payment-cash-settle] OCR failed", ocrError);
  }

  const ocrAmount = extracted ? numericOrNull(extracted.amount) : null;
  const row = {
    payment_request_id: requestId,
    storage_path: storagePath,
    file_sha256: fileSha256,
    ocr_amount: ocrAmount,
    ocr_payee: extracted?.beneficiary_name ? String(extracted.beneficiary_name) : null,
    ocr_date: extracted?.transfer_date ? String(extracted.transfer_date).slice(0, 10) : null,
    ocr_reference: extracted?.reference ? String(extracted.reference) : null,
    ocr_content: extracted?.transfer_content ? String(extracted.transfer_content) : null,
    ocr_error: ocrError,
    amount: ocrAmount,
    status: "uploaded",
    uploaded_by: actorId,
  };

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("payment_cash_receipts")
    .insert(row)
    .select()
    .single();
  if (insertError) {
    if ((insertError as { code?: string }).code === "23505") {
      const raced = await findActiveReceiptBySha(supabaseAdmin, fileSha256);
      if (raced.receipt) {
        return jsonResponse(req, 200, {
          success: true,
          mode: "extract",
          duplicate: true,
          receipt: raced.receipt,
        });
      }
    }
    console.error("[payment-cash-settle] Receipt insert failed", insertError.message);
    return structuredError(req, 500, "receipt_insert_failed");
  }

  return jsonResponse(req, 200, {
    success: true,
    mode: "extract",
    duplicate: false,
    receipt: inserted,
  });
};

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  if (req.method !== "POST") return structuredError(req, 405, "method_not_allowed");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return structuredError(req, 500, "server_misconfigured");
  }

  const supabaseAdmin: AdminClient = createClient<any>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return structuredError(req, 400, "invalid_json");
  }

  const mode = asTrimmed(body.mode);
  if (mode !== "extract") return structuredError(req, 400, "invalid_mode");

  const requestId = asTrimmed(body.request_id || body.requestId);
  if (!UUID_RE.test(requestId)) return structuredError(req, 400, "request_id_required");

  const access = await requireSettlementAccess(req, supabaseAdmin, requestId);
  if (access instanceof Response) return access;

  return handleExtract(req, supabaseAdmin, body, access.id);
});
