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

// Salary payout supporting documents: a separate private bucket, no
// storage.objects policy, service-role only. The client gets signed URLs.
const SALARY_DOCUMENTS_BUCKET = "salary-documents";
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_MAX_COUNT = 20;
const ATTACHMENT_SIGNED_URL_SECONDS = 300;
const ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
const ATTACHMENT_MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};
const ATTACHMENT_EXTENSION_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  pdf: "application/pdf",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

// callOpenAiVision returns the normalized amount envelope; the tool also reads
// the extra slip fields below, exactly like payment-unc-approve / payment-cash-settle.
type SlipOcrResult = Awaited<ReturnType<typeof callOpenAiVision>> & {
  reference?: unknown;
  transfer_date?: unknown;
  beneficiary_name?: unknown;
  transfer_content?: unknown;
};

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

const bearerToken = (req: Request): string | null => {
  const authorization = req.headers.get("Authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
};

const readRoles = async (
  supabaseAdmin: AdminClient,
  userId: string,
): Promise<string[] | null> => {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (error) return null;
  return (data || []).map((row: { role?: string | null }) => String(row.role || ""));
};

/** Owner-only gate (CEO transfer slip extraction). */
async function requireOwner(
  req: Request,
  supabaseAdmin: AdminClient,
): Promise<{ id: string; token: string } | Response> {
  const token = bearerToken(req);
  if (!token) return structuredError(req, 401, "not_owner", "missing_authorization");
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return structuredError(req, 401, "not_owner", "invalid_token");
  const roles = await readRoles(supabaseAdmin, user.id);
  if (!roles) return structuredError(req, 500, "role_lookup_failed");
  if (!roles.includes("owner")) return structuredError(req, 403, "not_owner", "owner_role_required");
  return { id: user.id, token };
}

/** Owner, salary_cash edit or service-role automation (employee receipts). */
async function requireSalaryEdit(
  req: Request,
  supabaseAdmin: AdminClient,
): Promise<{ id: string; token: string } | Response> {
  const token = bearerToken(req);
  if (!token) return structuredError(req, 401, "not_allowed", "missing_authorization");
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return structuredError(req, 401, "not_allowed", "invalid_token");

  const roles = await readRoles(supabaseAdmin, user.id);
  if (!roles) return structuredError(req, 500, "role_lookup_failed");
  if (roles.includes("owner")) return { id: user.id, token };

  const { data: canEdit, error: permissionError } = await supabaseAdmin.rpc("has_module_permission", {
    _user_id: user.id,
    _module_key: "salary_cash",
    _permission: "edit",
  });
  if (permissionError) return structuredError(req, 500, "permission_lookup_failed");
  if (canEdit !== true) return structuredError(req, 403, "not_allowed", "salary_cash_edit_required");
  return { id: user.id, token };
}

const readUploadInput = (
  req: Request,
  body: Record<string, unknown>,
): { bytes: Uint8Array; mimeType: string; imageBase64: string } | Response => {
  const imageBase64 = asTrimmed(body.image_base64 || body.imageBase64);
  if (!imageBase64) return structuredError(req, 400, "image_required");

  const mimeType = asTrimmed(body.mime_type || body.mimeType) || "image/jpeg";
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    return structuredError(req, 400, "invalid_image_type");
  }
  if (imageBase64.length > 10 * 1024 * 1024) {
    return structuredError(req, 400, "image_too_large");
  }

  try {
    return { bytes: decodeBase64(imageBase64), mimeType, imageBase64 };
  } catch {
    return structuredError(req, 400, "invalid_image_encoding");
  }
};

/**
 * Owner or salary_cash <permission> gate for the attachment actions.
 * Errors use the attachment error vocabulary (insufficient_privilege).
 */
async function requireSalaryPermission(
  req: Request,
  supabaseAdmin: AdminClient,
  permission: "edit" | "view",
): Promise<{ id: string; isOwner: boolean } | Response> {
  const token = bearerToken(req);
  if (!token) return structuredError(req, 401, "insufficient_privilege", "missing_authorization");
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return structuredError(req, 401, "insufficient_privilege", "invalid_token");

  const roles = await readRoles(supabaseAdmin, user.id);
  if (!roles) return structuredError(req, 500, "role_lookup_failed");
  if (roles.includes("owner")) return { id: user.id, isOwner: true };

  const { data: allowed, error: permissionError } = await supabaseAdmin.rpc("has_module_permission", {
    _user_id: user.id,
    _module_key: "salary_cash",
    _permission: permission,
  });
  if (permissionError) return structuredError(req, 500, "permission_lookup_failed");
  if (allowed !== true) {
    return structuredError(req, 403, "insufficient_privilege", `salary_cash_${permission}_required`);
  }
  return { id: user.id, isOwner: false };
}

const fileExtensionOf = (name: string): string => {
  const base = name.split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
};

/** Declared mime when usable, else the extension fallback. */
const resolveAttachmentMime = (fileName: string, declaredType: string): string => {
  const declared = declaredType.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream") return declared;
  return ATTACHMENT_EXTENSION_MIME[fileExtensionOf(fileName)] || "";
};

const isExcelMime = (mime: string): boolean =>
  mime === "application/vnd.ms-excel" ||
  mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const readAttachmentInput = (
  req: Request,
  body: Record<string, unknown>,
): { bytes: Uint8Array; mimeType: string; fileName: string } | Response => {
  const imageBase64 = asTrimmed(body.image_base64 || body.imageBase64);
  const fileName = asTrimmed(body.file_name || body.fileName);
  if (!imageBase64 || !fileName) {
    return structuredError(req, 400, "unsupported_type", "file_required");
  }
  if (fileName.length > 200) {
    return structuredError(req, 400, "unsupported_type", "invalid_file_name");
  }

  const mimeType = resolveAttachmentMime(fileName, asTrimmed(body.mime_type || body.mimeType));
  if (!mimeType || !ATTACHMENT_MIME_TYPES.includes(mimeType)) {
    return structuredError(req, 400, "unsupported_type", mimeType || "unknown_type");
  }
  if (imageBase64.length > Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 32) {
    return structuredError(req, 400, "file_too_large");
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(imageBase64);
  } catch {
    return structuredError(req, 400, "unsupported_type", "invalid_encoding");
  }
  if (bytes.length < 1) return structuredError(req, 400, "unsupported_type", "empty_file");
  if (bytes.length > ATTACHMENT_MAX_BYTES) return structuredError(req, 400, "file_too_large");
  return { bytes, mimeType, fileName };
};

const findAttachmentById = async (supabaseAdmin: AdminClient, attachmentId: string) => {
  const { data, error } = await supabaseAdmin
    .from("salary_payout_attachments")
    .select("*")
    .eq("id", attachmentId)
    .maybeSingle();
  if (error) return { attachment: null, error };
  return { attachment: data, error: null };
};

const handleCeoExtract = async (
  req: Request,
  supabaseAdmin: AdminClient,
  body: Record<string, unknown>,
): Promise<Response> => {
  const owner = await requireOwner(req, supabaseAdmin);
  if (owner instanceof Response) return owner;

  const upload = readUploadInput(req, body);
  if (upload instanceof Response) return upload;

  const fileSha256 = await sha256Hex(upload.bytes);
  const { year, month } = vietnamYearMonth(new Date());
  const extension = MIME_EXTENSIONS[upload.mimeType] || "jpg";
  const objectPath = `salary/${year}/${month}/${fileSha256}.${extension}`;
  const storagePath = `${UNC_BUCKET}/${objectPath}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(UNC_BUCKET)
    .upload(objectPath, upload.bytes, { contentType: upload.mimeType, upsert: true });
  if (uploadError) {
    console.error("[salary-payout] CEO upload failed", uploadError.message);
    return structuredError(req, 500, "upload_failed");
  }

  let ocrAmount: number | null = null;
  let ocrReference: string | null = null;
  try {
    const extracted: SlipOcrResult = await callOpenAiVision(upload.imageBase64, upload.mimeType, "transfer", {
      readBeneficiary: true,
    });
    ocrAmount = numericOrNull(extracted.amount);
    ocrReference = extracted.reference ? String(extracted.reference) : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "ocr_failed";
    // Never echo extracted amounts/names; only the sanitized failure is logged.
    console.error("[salary-payout] CEO OCR failed", message.slice(0, 300));
    return structuredError(req, 502, "ocr_failed", message.slice(0, 300));
  }

  return jsonResponse(req, 200, {
    success: true,
    mode: "ceo_extract",
    storage_path: storagePath,
    file_sha256: fileSha256,
    ocr_amount: ocrAmount,
    ocr_reference: ocrReference,
  });
};

const findActiveReceiptBySha = async (supabaseAdmin: AdminClient, fileSha256: string) => {
  const { data, error } = await supabaseAdmin
    .from("salary_payout_receipts")
    .select("*")
    .eq("file_sha256", fileSha256)
    .neq("status", "discarded")
    .maybeSingle();
  if (error) return { receipt: null, error };
  return { receipt: data, error: null };
};

const handleReceiptExtract = async (
  req: Request,
  supabaseAdmin: AdminClient,
  body: Record<string, unknown>,
  actorId: string,
): Promise<Response> => {
  const payoutId = asTrimmed(body.payout_id || body.payoutId);
  if (!UUID_RE.test(payoutId)) return structuredError(req, 400, "payout_id_required");

  const { data: payout, error: payoutError } = await supabaseAdmin
    .from("salary_payouts")
    .select("id")
    .eq("id", payoutId)
    .maybeSingle();
  if (payoutError) return structuredError(req, 500, "payout_lookup_failed");
  if (!payout) return structuredError(req, 404, "payout_not_found");

  const upload = readUploadInput(req, body);
  if (upload instanceof Response) return upload;

  const fileSha256 = await sha256Hex(upload.bytes);

  // One active receipt per sha256; a repeated upload returns the existing row.
  const existing = await findActiveReceiptBySha(supabaseAdmin, fileSha256);
  if (existing.error) {
    console.error("[salary-payout] Duplicate lookup failed", existing.error.message);
    return structuredError(req, 500, "receipt_lookup_failed");
  }
  if (existing.receipt) {
    return jsonResponse(req, 200, {
      success: true,
      mode: "receipt_extract",
      duplicate: true,
      receipt: existing.receipt,
    });
  }

  const { year, month } = vietnamYearMonth(new Date());
  const extension = MIME_EXTENSIONS[upload.mimeType] || "jpg";
  const objectPath = `salary/receipts/${year}/${month}/${fileSha256}.${extension}`;
  const storagePath = `${UNC_BUCKET}/${objectPath}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(UNC_BUCKET)
    .upload(objectPath, upload.bytes, { contentType: upload.mimeType, upsert: true });
  if (uploadError) {
    console.error("[salary-payout] Receipt upload failed", uploadError.message);
    return structuredError(req, 500, "upload_failed");
  }

  let ocrAmount: number | null = null;
  let ocrBeneficiary: string | null = null;
  let ocrReference: string | null = null;
  let ocrError: string | null = null;
  try {
    const extracted: SlipOcrResult = await callOpenAiVision(upload.imageBase64, upload.mimeType, "receipt", {
      readBeneficiary: true,
    });
    ocrAmount = numericOrNull(extracted.amount);
    ocrBeneficiary = extracted.beneficiary_name ? String(extracted.beneficiary_name) : null;
    ocrReference = extracted.reference ? String(extracted.reference) : null;
  } catch (error) {
    ocrError = (error instanceof Error ? error.message : "ocr_failed").slice(0, 500);
    console.error("[salary-payout] Receipt OCR failed", ocrError);
  }

  const row = {
    payout_id: payoutId,
    storage_path: storagePath,
    file_sha256: fileSha256,
    ocr_amount: ocrAmount,
    ocr_beneficiary: ocrBeneficiary,
    ocr_reference: ocrReference,
    ocr_error: ocrError,
    status: "uploaded",
    uploaded_by: actorId,
  };

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("salary_payout_receipts")
    .insert(row)
    .select()
    .single();
  if (insertError) {
    if ((insertError as { code?: string }).code === "23505") {
      const raced = await findActiveReceiptBySha(supabaseAdmin, fileSha256);
      if (raced.receipt) {
        return jsonResponse(req, 200, {
          success: true,
          mode: "receipt_extract",
          duplicate: true,
          receipt: raced.receipt,
        });
      }
    }
    console.error("[salary-payout] Receipt insert failed", insertError.message);
    return structuredError(req, 500, "receipt_insert_failed");
  }

  return jsonResponse(req, 200, {
    success: true,
    mode: "receipt_extract",
    duplicate: false,
    receipt: inserted,
  });
};

// ---------------------------------------------------------------------------
// Supporting documents (salary-documents): attach / detach / attachment_url.
// Every action is service-role only and never enqueues a Zalo notice.
// ---------------------------------------------------------------------------

const handleAttach = async (
  req: Request,
  supabaseAdmin: AdminClient,
  body: Record<string, unknown>,
  actorId: string,
): Promise<Response> => {
  const payoutId = asTrimmed(body.payout_id || body.payoutId);
  if (!UUID_RE.test(payoutId)) return structuredError(req, 400, "payout_not_found");

  const { data: payout, error: payoutError } = await supabaseAdmin
    .from("salary_payouts")
    .select("id,status")
    .eq("id", payoutId)
    .maybeSingle();
  if (payoutError) return structuredError(req, 500, "payout_lookup_failed");
  if (!payout) return structuredError(req, 404, "payout_not_found");
  if (payout.status === "completed") return structuredError(req, 409, "payout_completed");

  const upload = readAttachmentInput(req, body);
  if (upload instanceof Response) return upload;

  const fileSha256 = await sha256Hex(upload.bytes);

  // Idempotent retry: same payout + same content returns the stored row.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("salary_payout_attachments")
    .select("*")
    .eq("payout_id", payoutId)
    .eq("file_sha256", fileSha256)
    .maybeSingle();
  if (existingError) return structuredError(req, 500, "attachment_lookup_failed");
  if (existing) {
    return jsonResponse(req, 200, { success: true, duplicate: true, attachment: existing });
  }

  const { count, error: countError } = await supabaseAdmin
    .from("salary_payout_attachments")
    .select("id", { count: "exact", head: true })
    .eq("payout_id", payoutId);
  if (countError) return structuredError(req, 500, "attachment_lookup_failed");
  if ((count ?? 0) >= ATTACHMENT_MAX_COUNT) {
    return structuredError(req, 400, "too_many_attachments");
  }

  const extension = ATTACHMENT_MIME_EXTENSIONS[upload.mimeType] || "bin";
  const objectPath = `${payoutId}/${fileSha256}.${extension}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(SALARY_DOCUMENTS_BUCKET)
    .upload(objectPath, upload.bytes, { contentType: upload.mimeType, upsert: true });
  if (uploadError) {
    console.error("[salary-payout] Attachment upload failed", uploadError.message);
    return structuredError(req, 500, "upload_failed");
  }

  const row = {
    payout_id: payoutId,
    storage_path: objectPath,
    file_name: upload.fileName,
    mime_type: upload.mimeType,
    size_bytes: upload.bytes.length,
    file_sha256: fileSha256,
    uploaded_by: actorId,
  };

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("salary_payout_attachments")
    .upsert(row, { onConflict: "payout_id,file_sha256", ignoreDuplicates: true })
    .select()
    .maybeSingle();
  if (insertError) {
    console.error("[salary-payout] Attachment insert failed", insertError.message);
    return structuredError(req, 500, "upload_failed");
  }
  if (inserted) {
    return jsonResponse(req, 200, { success: true, duplicate: false, attachment: inserted });
  }

  // Lost a race on (payout_id, file_sha256): return the row that won.
  const { data: raced, error: raceError } = await supabaseAdmin
    .from("salary_payout_attachments")
    .select("*")
    .eq("payout_id", payoutId)
    .eq("file_sha256", fileSha256)
    .maybeSingle();
  if (raceError || !raced) return structuredError(req, 500, "upload_failed");
  return jsonResponse(req, 200, { success: true, duplicate: true, attachment: raced });
};

const handleDetach = async (
  req: Request,
  supabaseAdmin: AdminClient,
  body: Record<string, unknown>,
  actor: { id: string; isOwner: boolean },
): Promise<Response> => {
  const attachmentId = asTrimmed(body.attachment_id || body.attachmentId);
  if (!UUID_RE.test(attachmentId)) return structuredError(req, 400, "attachment_not_found");

  const found = await findAttachmentById(supabaseAdmin, attachmentId);
  if (found.error) return structuredError(req, 500, "attachment_lookup_failed");
  const attachment = found.attachment as {
    id: string;
    payout_id: string;
    storage_path: string;
    uploaded_by: string | null;
  } | null;
  if (!attachment) return structuredError(req, 404, "attachment_not_found");

  // Owner, or the uploader holding salary_cash edit (already gated above).
  if (!actor.isOwner && attachment.uploaded_by !== actor.id) {
    return structuredError(req, 403, "insufficient_privilege", "uploader_or_owner_required");
  }

  const { data: payout, error: payoutError } = await supabaseAdmin
    .from("salary_payouts")
    .select("id,status")
    .eq("id", attachment.payout_id)
    .maybeSingle();
  if (payoutError) return structuredError(req, 500, "payout_lookup_failed");
  if (!payout) return structuredError(req, 404, "payout_not_found");
  if (payout.status === "completed") return structuredError(req, 409, "payout_completed");

  const { error: deleteError } = await supabaseAdmin
    .from("salary_payout_attachments")
    .delete()
    .eq("id", attachmentId);
  if (deleteError) {
    console.error("[salary-payout] Attachment delete failed", deleteError.message);
    return structuredError(req, 500, "attachment_delete_failed");
  }

  // Row is gone; a leftover private object is inert and never listed.
  const { error: removeError } = await supabaseAdmin.storage
    .from(SALARY_DOCUMENTS_BUCKET)
    .remove([attachment.storage_path]);
  if (removeError) {
    console.error("[salary-payout] Attachment object removal failed", removeError.message);
  }

  return jsonResponse(req, 200, { success: true, id: attachmentId, removed: true });
};

const handleAttachmentUrl = async (
  req: Request,
  supabaseAdmin: AdminClient,
  body: Record<string, unknown>,
): Promise<Response> => {
  const attachmentId = asTrimmed(body.attachment_id || body.attachmentId);
  if (!UUID_RE.test(attachmentId)) return structuredError(req, 400, "attachment_not_found");

  const found = await findAttachmentById(supabaseAdmin, attachmentId);
  if (found.error) return structuredError(req, 500, "attachment_lookup_failed");
  const attachment = found.attachment as {
    id: string;
    storage_path: string;
    file_name: string;
    mime_type: string;
  } | null;
  if (!attachment) return structuredError(req, 404, "attachment_not_found");

  // Excel downloads keep their file name; other kinds render inline.
  const options = isExcelMime(String(attachment.mime_type || ""))
    ? { download: String(attachment.file_name || "") }
    : undefined;
  const { data: signed, error: signedError } = await supabaseAdmin.storage
    .from(SALARY_DOCUMENTS_BUCKET)
    .createSignedUrl(String(attachment.storage_path), ATTACHMENT_SIGNED_URL_SECONDS, options);
  if (signedError || !signed?.signedUrl) {
    console.error("[salary-payout] Attachment signed url failed", signedError?.message);
    return structuredError(req, 500, "signed_url_failed");
  }

  return jsonResponse(req, 200, {
    success: true,
    attachment_id: attachmentId,
    signed_url: signed.signedUrl,
    expires_in: ATTACHMENT_SIGNED_URL_SECONDS,
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
  if (mode === "ceo_extract") {
    return handleCeoExtract(req, supabaseAdmin, body);
  }
  if (mode === "receipt_extract") {
    const actor = await requireSalaryEdit(req, supabaseAdmin);
    if (actor instanceof Response) return actor;
    return handleReceiptExtract(req, supabaseAdmin, body, actor.id);
  }
  if (mode === "attach") {
    const actor = await requireSalaryPermission(req, supabaseAdmin, "edit");
    if (actor instanceof Response) return actor;
    return handleAttach(req, supabaseAdmin, body, actor.id);
  }
  if (mode === "detach") {
    const actor = await requireSalaryPermission(req, supabaseAdmin, "edit");
    if (actor instanceof Response) return actor;
    return handleDetach(req, supabaseAdmin, body, actor);
  }
  if (mode === "attachment_url") {
    const actor = await requireSalaryPermission(req, supabaseAdmin, "view");
    if (actor instanceof Response) return actor;
    return handleAttachmentUrl(req, supabaseAdmin, body);
  }
  return structuredError(req, 400, "invalid_mode");
});
