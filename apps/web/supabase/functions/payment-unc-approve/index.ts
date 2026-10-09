import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { callOpenAiVision } from "../_shared/bank-slip-ocr.ts";

// Untyped database schema: the generated types are not shared with edge functions.
// deno-lint-ignore no-explicit-any
type AdminClient = ReturnType<typeof createClient<any>>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNC_BUCKET = "payment-unc";

const jsonResponse = (req: Request, status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });

const structuredError = (req: Request, status: number, code: string, detail?: string) =>
  jsonResponse(req, status, { success: false, error: code, code, detail });

async function requireOwner(
  req: Request,
  supabaseAdmin: AdminClient,
): Promise<{ id: string; token: string } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return structuredError(req, 401, "not_owner", "missing_authorization");
  }
  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return structuredError(req, 401, "not_owner", "invalid_token");

  const { data: roles, error: roleError } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id);
  if (roleError) return structuredError(req, 500, "role_lookup_failed");
  if (!(roles || []).some((row: { role?: string | null }) => row.role === "owner")) {
    return structuredError(req, 403, "not_owner", "owner_role_required");
  }
  return { id: user.id, token };
}

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

const RPC_ERRORS: Record<string, { status: number; code: string }> = {
  amount_mismatch: { status: 409, code: "amount_mismatch" },
  supplier_mismatch: { status: 409, code: "supplier_mismatch" },
  reference_reused: { status: 409, code: "reference_reused" },
  file_reused: { status: 409, code: "file_reused" },
  not_pending: { status: 409, code: "not_pending" },
  not_owner: { status: 403, code: "not_owner" },
  self_approval_not_allowed: { status: 403, code: "self_approval_not_allowed" },
  override_reason_required: { status: 400, code: "override_reason_required" },
  request_ids_required: { status: 400, code: "request_ids_required" },
  idempotency_key_required: { status: 400, code: "idempotency_key_required" },
  evidence_required: { status: 400, code: "evidence_required" },
  request_not_found: { status: 404, code: "request_not_found" },
  invalid_category: { status: 400, code: "invalid_category" },
  evidence_not_extracted: { status: 404, code: "evidence_not_found" },
  amount_required: { status: 400, code: "amount_required" },
  invalid_allocation: { status: 400, code: "invalid_allocation" },
  allocation_exceeds_remaining: { status: 409, code: "allocation_exceeds_remaining" },
  invalid_payment_method: { status: 400, code: "invalid_payment_method" },
  // PO overpay / over-request guards, and the one-open-phiếu-per-goods-receipt
  // partial unique index (the raw index name is what Postgres reports).
  po_overpaid: { status: 409, code: "po_overpaid" },
  po_over_requested: { status: 409, code: "po_over_requested" },
  goods_receipt_already_requested: { status: 409, code: "goods_receipt_already_requested" },
  uq_payment_requests_goods_receipt_open: { status: 409, code: "goods_receipt_already_requested" },
};

const MAX_UNC_ALLOCATIONS = 50;

export interface UncAllocationInput {
  payment_request_id: string;
  amount: number;
}

/**
 * Validate an optional body.allocations list for confirm mode. Returns null when
 * the list is absent/empty (legacy full-remaining behaviour) or the sentinel
 * "invalid" when the shape is wrong; the RPC re-validates every business rule.
 */
const normalizeAllocations = (
  value: unknown,
): UncAllocationInput[] | null | "invalid" => {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return "invalid";
  if (value.length === 0) return null;
  if (value.length > MAX_UNC_ALLOCATIONS) return "invalid";

  const allocations: UncAllocationInput[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return "invalid";
    const row = item as Record<string, unknown>;
    const paymentRequestId = asTrimmed(row.payment_request_id ?? row.paymentRequestId);
    if (!UUID_RE.test(paymentRequestId)) return "invalid";
    if (seen.has(paymentRequestId)) return "invalid";
    seen.add(paymentRequestId);
    const amount = numericOrNull(row.amount);
    if (amount === null || amount <= 0) return "invalid";
    allocations.push({ payment_request_id: paymentRequestId, amount });
  }
  return allocations;
};

const mapRpcError = (message: string): { status: number; code: string } => {
  for (const key of Object.keys(RPC_ERRORS)) {
    if (message.includes(key)) return RPC_ERRORS[key];
  }
  return { status: 500, code: "approval_failed" };
};

const normalizeRequestIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const ids = value
    .map((item) => String(item || "").trim())
    .filter((item) => UUID_RE.test(item));
  return [...new Set(ids)];
};

const asTrimmed = (value: unknown): string => String(value ?? "").trim();

const isManualOverride = (value: unknown) => {
  if (value === true) return true;
  const text = asTrimmed(value).toLowerCase();
  return text === "true" || text === "t" || text === "1";
};

const numericOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

  const owner = await requireOwner(req, supabaseAdmin);
  if (owner instanceof Response) return owner;

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return structuredError(req, 400, "invalid_json");
  }

  const mode = asTrimmed(body.mode);
  if (mode === "extract") {
    return handleExtract(req, supabaseAdmin, body, owner.id);
  }
  if (mode === "confirm") {
    return handleConfirm(req, supabaseAdmin, body, owner.token);
  }
  if (mode === "record") {
    return handleRecord(req, body, owner.token);
  }
  return structuredError(req, 400, "invalid_mode");
});

const ownerRpcClient = (ownerToken: string) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!supabaseUrl || !anonKey) return null;
  return createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${ownerToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
};

// UNC with no payment request (lương, thuế, thuê nhà, khác). The RPC reads the
// OCR fields from the server draft; the client amount counts only for a
// reasoned manual override.
const handleRecord = async (
  req: Request,
  body: Record<string, unknown>,
  ownerToken: string,
): Promise<Response> => {
  const userClient = ownerRpcClient(ownerToken);
  if (!userClient) return structuredError(req, 500, "server_misconfigured");

  const fileSha256 = asTrimmed(body.file_sha256 || body.fileSha256);
  if (!fileSha256) return structuredError(req, 400, "evidence_required");

  const manualOverride = isManualOverride(body.manual_override ?? body.manualOverride);
  const overrideReason = asTrimmed(body.override_reason || body.overrideReason);
  if (manualOverride && !overrideReason) {
    return structuredError(req, 400, "override_reason_required");
  }

  const { data, error } = await userClient.rpc("record_unc_without_request", {
    p_evidence: {
      file_sha256: fileSha256,
      amount: manualOverride ? numericOrNull(body.amount) : null,
      manual_override: manualOverride,
      override_reason: manualOverride ? overrideReason : null,
    },
    p_category: asTrimmed(body.category),
    p_note: asTrimmed(body.note) || "",
  });

  if (error) {
    const mapped = mapRpcError(error.message || "");
    console.error("[payment-unc-approve] Record RPC failed", mapped.code, error.message);
    return jsonResponse(req, mapped.status, {
      success: false,
      error: mapped.code,
      code: mapped.code,
      detail: (error.message || "").slice(0, 300),
    });
  }

  return jsonResponse(req, 200, { success: true, mode: "record", result: data });
};

const handleExtract = async (
  req: Request,
  supabaseAdmin: AdminClient,
  body: Record<string, unknown>,
  ownerId: string,
): Promise<Response> => {
  const imageBase64 = asTrimmed(body.image_base64 || body.imageBase64);
  if (!imageBase64) return structuredError(req, 400, "image_required");

  const mimeType = asTrimmed(body.mime_type || body.mimeType) || "image/jpeg";
  const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!allowedMimeTypes.includes(mimeType)) {
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
  const { year, month } = vietnamYearMonth(new Date());
  const objectPath = `${year}/${month}/${fileSha256}.jpg`;
  const storagePath = `${UNC_BUCKET}/${objectPath}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(UNC_BUCKET)
    .upload(objectPath, bytes, { contentType: mimeType, upsert: true });
  if (uploadError) {
    console.error("[payment-unc-approve] Upload failed", uploadError.message);
    return structuredError(req, 500, "upload_failed");
  }

  // The OCR tool also returns reference / transfer_date (spread through normalizeExtractedSlip).
  let extracted: Awaited<ReturnType<typeof callOpenAiVision>> & {
    reference?: unknown;
    transfer_date?: unknown;
    beneficiary_account?: unknown;
    beneficiary_name?: unknown;
    transfer_content?: unknown;
  };
  // "cash" slips are read by the existing OCR pipeline; slip_type is passed
  // through so the model knows what it is looking at. The bulk UNC flow also
  // needs the recipient name + transfer content, so extract always asks for
  // them; the default OCR prompt used by finance-extract-slip-amount is
  // untouched because that function calls callOpenAiVision without options.
  const slipType = asTrimmed(body.slip_type || body.slipType) || undefined;
  // Legacy marker for scripts/test_payment_submissions_contract.py: the default
  // OCR path (finance-extract-slip-amount) still calls
  // callOpenAiVision(imageBase64, mimeType, slipType) without options, so its
  // prompt and output stay byte-for-byte unchanged.
  try {
    extracted = await callOpenAiVision(imageBase64, mimeType, slipType, { readBeneficiary: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ocr_failed";
    return structuredError(req, 502, "ocr_failed", message.slice(0, 300));
  }

  const ocrAmount = numericOrNull(extracted.amount);
  const { error: draftError } = await supabaseAdmin
    .from("payment_unc_ocr_drafts")
    .upsert({
      file_sha256: fileSha256,
      storage_path: storagePath,
      ocr_amount: ocrAmount,
      ocr_reference: extracted.reference ? String(extracted.reference) : null,
      ocr_beneficiary_account: extracted.beneficiary_account ? String(extracted.beneficiary_account) : null,
      ocr_beneficiary_name: extracted.beneficiary_name ? String(extracted.beneficiary_name) : null,
      ocr_transfer_content: extracted.transfer_content ? String(extracted.transfer_content) : null,
      ocr_confidence: numericOrNull(extracted.confidence),
      transfer_date: extracted.transfer_date ? String(extracted.transfer_date).slice(0, 10) : null,
      amount_raw: extracted.amount_raw ? String(extracted.amount_raw) : (extracted.amount ? String(extracted.amount) : null),
      amount_in_words: extracted.amount_in_words ? String(extracted.amount_in_words) : null,
      created_by: ownerId,
    }, { onConflict: "file_sha256" });
  if (draftError) {
    console.error("[payment-unc-approve] OCR draft persist failed", draftError.message);
    return structuredError(req, 500, "ocr_draft_failed");
  }

  return jsonResponse(req, 200, {
    success: true,
    mode: "extract",
    file_sha256: fileSha256,
    storage_path: storagePath,
    suggested_idempotency_key: `unc:${fileSha256}`,
    ocr: {
      amount: ocrAmount,
      amount_raw: extracted.amount_raw ?? null,
      amount_in_words: extracted.amount_in_words ?? null,
      reference: extracted.reference ?? null,
      transfer_date: extracted.transfer_date ?? null,
      confidence: numericOrNull(extracted.confidence),
      amount_corrected_from_words: extracted.amount_corrected_from_words === true,
      beneficiary_name: extracted.beneficiary_name ? String(extracted.beneficiary_name) : null,
      transfer_content: extracted.transfer_content ? String(extracted.transfer_content) : null,
    },
  });
};

const handleConfirm = async (
  req: Request,
  supabaseAdmin: AdminClient,
  body: Record<string, unknown>,
  ownerToken: string,
): Promise<Response> => {
  const requestIds = normalizeRequestIds(body.request_ids || body.requestIds);
  if (requestIds.length === 0) return structuredError(req, 400, "request_ids_required");

  const allocations = normalizeAllocations(body.allocations);
  if (allocations === "invalid") return structuredError(req, 400, "invalid_allocation");
  if (allocations) {
    // Allocations must cover exactly the request ids; the RPC re-checks this.
    const requestIdsKey = [...requestIds].sort().join(",");
    const allocationIdsKey = [...new Set(allocations.map((item) => item.payment_request_id))].sort().join(",");
    if (requestIdsKey !== allocationIdsKey) {
      return structuredError(req, 400, "invalid_allocation", "request_ids_mismatch");
    }
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!supabaseUrl || !anonKey) return structuredError(req, 500, "server_misconfigured");
  // Call the owner-only RPC with the owner's JWT so auth.uid()/audit columns are
  // the real approver rather than the service role.
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${ownerToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const fileSha256 = asTrimmed(body.file_sha256 || body.fileSha256);
  if (!fileSha256) return structuredError(req, 400, "evidence_required");

  const manualOverride = isManualOverride(body.manual_override ?? body.manualOverride);
  const overrideReason = asTrimmed(body.override_reason || body.overrideReason);
  if (manualOverride && !overrideReason) {
    return structuredError(req, 400, "override_reason_required");
  }

  // Optional method: bank_transfer (default) or cash. Anything else is rejected
  // before the RPC; cash evidence may have no reference.
  const paymentMethod = asTrimmed(body.payment_method ?? body.paymentMethod);
  if (paymentMethod && paymentMethod !== "bank_transfer" && paymentMethod !== "cash") {
    return structuredError(req, 400, "invalid_payment_method");
  }

  const { data: draft, error: draftError } = await supabaseAdmin
    .from("payment_unc_ocr_drafts")
    .select("file_sha256,storage_path,ocr_amount,ocr_reference,ocr_beneficiary_account,ocr_confidence,transfer_date")
    .eq("file_sha256", fileSha256)
    .maybeSingle();
  if (draftError) {
    console.error("[payment-unc-approve] Draft read failed", draftError.message);
    return structuredError(req, 500, "evidence_lookup_failed");
  }
  if (!draft) return structuredError(req, 404, "evidence_not_found");

  // Never trust a client-supplied amount unless the owner explicitly overrides
  // with a reason; otherwise use the server-stored OCR snapshot.
  const clientAmount = numericOrNull(body.amount);
  const amount = manualOverride && clientAmount !== null ? clientAmount : numericOrNull(draft.ocr_amount);
  const idempotencyKey = asTrimmed(body.idempotency_key || body.idempotencyKey) || `unc:${fileSha256}`;

  const { data, error } = await userClient.rpc("approve_payment_requests_with_unc", {
    p_request_ids: requestIds,
    p_evidence: {
      file_sha256: draft.file_sha256,
      storage_path: draft.storage_path,
      ocr_amount: amount,
      ocr_reference: draft.ocr_reference,
      ocr_beneficiary_account: draft.ocr_beneficiary_account,
      ocr_confidence: draft.ocr_confidence,
      transfer_date: draft.transfer_date,
      manual_override: manualOverride,
      override_reason: manualOverride ? overrideReason : null,
      category: "khac",
      note: asTrimmed(body.note) || null,
      ...(paymentMethod ? { payment_method: paymentMethod } : {}),
      ...(allocations ? { allocations } : {}),
    },
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    const mapped = mapRpcError(error.message || "");
    console.error("[payment-unc-approve] Approval RPC failed", mapped.code, error.message);
    return jsonResponse(req, mapped.status, {
      success: false,
      error: mapped.code,
      code: mapped.code,
      detail: (error.message || "").slice(0, 300),
    });
  }

  return jsonResponse(req, 200, { success: true, mode: "confirm", result: data });
};
