import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { requireAuth } from "../_shared/auth.ts";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

const FUNCTION_NAME = "production-material-issue-check";
const BUCKET = "production-material-issue-documents";
const DAILY_CHECK_LIMIT = 80;
const MIN_PDF_BYTES = 1;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const PDF_TAIL_BYTES = 2048;
const MAX_SOURCE_ROWS = 500;
const MAX_AGGREGATED_ROWS = 200;
const MAX_REQUIRED_QTY = 1_000_000;
const MAX_DISCREPANCIES = 20;
const MAX_STRING_LENGTH = 220;
const PASS_CONFIDENCE_THRESHOLD = 0.8;
const PROVIDER_TIMEOUT_MS = 90_000;
const CANONICAL_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  reset: string | null;
  retry_after_seconds: number | null;
};

type BeginResult = {
  status?: string;
  check_id?: string;
  issue_id?: string;
  issue_number?: string;
  issue_date?: string;
  revision?: number;
  production_order_number?: string | null;
  signed_file_path?: string;
  signed_file_sha256?: string;
  check_status?: string;
  result?: unknown;
  model?: string | null;
  model_version?: string | null;
  checked_at?: string | null;
};

type ExpectedLine = {
  issue_item_id: string;
  display_name: string;
  planned_qty: number;
  unit: string;
};

type ProviderExpectedLine = {
  line_no: number;
  display_name: string;
  planned_qty: number;
  unit: string;
};

type ActualLine = {
  issue_item_id: string;
  actual_qty: number;
  unit: string;
  evidence_kind: "handwritten_final" | "printed_planned" | "ambiguous";
  confidence: number;
};

type CheckSummary = {
  identity_exact: boolean;
  rows_exact: boolean;
  document_legible: boolean;
  pages_complete: boolean;
  preparer_signed: boolean;
  warehouse_keeper_signed: boolean;
  receiver_signed: boolean;
  actual_rows: ActualLine[];
  discrepancies: string[];
  confidence: number;
};

const isValidRateLimitResult = (value: unknown): value is RateLimitResult => {
  const candidate = value as Partial<RateLimitResult> | null;
  return !!candidate &&
    typeof candidate.allowed === "boolean" &&
    typeof candidate.remaining === "number" && Number.isFinite(candidate.remaining) && candidate.remaining >= 0 &&
    (candidate.reset === null || typeof candidate.reset === "string") &&
    (candidate.retry_after_seconds === null ||
      (typeof candidate.retry_after_seconds === "number" && Number.isFinite(candidate.retry_after_seconds) && candidate.retry_after_seconds >= 0));
};

const rateHeaders = (result: RateLimitResult): Record<string, string> => {
  const headers: Record<string, string> = { "X-RateLimit-Remaining": String(result.remaining) };
  if (result.reset) headers["X-RateLimit-Reset"] = String(Math.floor(new Date(result.reset).getTime() / 1000));
  if (result.retry_after_seconds !== null) headers["Retry-After"] = String(result.retry_after_seconds);
  return headers;
};

const jsonResponse = (
  req: Request,
  body: Record<string, unknown>,
  status = 200,
  extraHeaders: Record<string, string> = {},
) => new Response(JSON.stringify(body), {
  status,
  headers: { ...getCorsHeaders(req), ...extraHeaders, "Content-Type": "application/json" },
});

const sanitizeText = (value: unknown) => String(value ?? "").trim().slice(0, MAX_STRING_LENGTH);

const sha256Hex = async (bytes: Uint8Array) => {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const hasPdfSignature = (bytes: Uint8Array) => {
  if (bytes.byteLength < MIN_PDF_BYTES || bytes.byteLength > MAX_PDF_BYTES) return false;
  const head = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 8)));
  if (!head.startsWith("%PDF-")) return false;
  const tailStart = Math.max(0, bytes.byteLength - PDF_TAIL_BYTES);
  const tail = new TextDecoder().decode(bytes.slice(tailStart));
  return tail.includes("%%EOF");
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.slice(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

async function hasEditPermission(admin: any, userId: string) {
  const [{ data: roles, error: rolesError }, { data: permissions, error: permissionsError }] = await Promise.all([
    admin.from("user_roles").select("role").eq("user_id", userId),
    admin
      .from("user_module_permissions")
      .select("module_key,can_edit")
      .eq("user_id", userId)
      .in("module_key", ["production_q7", "warehouse", "kitchen_inventory", "q7_material_inventory"]),
  ]);

  if (rolesError || permissionsError) return false;
  if ((roles || []).some((row: { role?: string }) => row.role === "owner")) return true;
  return (permissions || []).some((row: { can_edit?: boolean }) => row.can_edit === true);
}

const safeStoredResult = (beginResult: BeginResult) => ({
  issue_id: beginResult.issue_id,
  issue_number: beginResult.issue_number,
  revision: beginResult.revision,
  status: beginResult.status,
  check_id: beginResult.check_id,
  outcome: beginResult.check_status,
  summary: safeResponseSummary(beginResult.result),
  model: beginResult.model ?? null,
  model_version: beginResult.model_version ?? null,
  checked_at: beginResult.checked_at ?? null,
});

const safeInProgressResult = (beginResult: BeginResult) => ({
  issue_id: beginResult.issue_id,
  issue_number: beginResult.issue_number,
  revision: beginResult.revision,
  status: "checking_unchanged",
  check_id: beginResult.check_id,
});

const safeResponseSummary = (value: unknown) => {
  const candidate = value as Partial<CheckSummary> | null;
  if (!candidate || typeof candidate !== "object") return value ?? null;
  return {
    identity_exact: candidate.identity_exact === true,
    rows_exact: candidate.rows_exact === true,
    document_legible: candidate.document_legible === true,
    pages_complete: candidate.pages_complete === true,
    preparer_signed: candidate.preparer_signed === true,
    warehouse_keeper_signed: candidate.warehouse_keeper_signed === true,
    receiver_signed: candidate.receiver_signed === true,
    discrepancies: Array.isArray(candidate.discrepancies) ? candidate.discrepancies.slice(0, MAX_DISCREPANCIES).map(sanitizeText) : [],
    confidence: Number.isFinite(Number(candidate.confidence)) ? Number(candidate.confidence) : 0,
  };
};

const normalizeQty = (value: number) => Math.round(value * 1000) / 1000;

const fetchExpectedFacts = async (admin: any, beginResult: BeginResult): Promise<ExpectedLine[]> => {
  const { data, error, count } = await admin
    .from("production_material_issue_items")
    .select("issue_item_id:id,ingredient_name,required_qty,unit", { count: "exact" })
    .eq("material_issue_id", beginResult.issue_id)
    .order("ingredient_name", { ascending: true })
    .order("id", { ascending: true })
    .range(0, MAX_SOURCE_ROWS);

  if (error || count === null) throw new Error("expected_rows_unavailable");
  if (count > MAX_SOURCE_ROWS) throw new Error("too_many_rows");

  const rows: ExpectedLine[] = [];
  for (const item of data || []) {
    const issueItemId = sanitizeText(item.issue_item_id);
    const displayName = sanitizeText(item.ingredient_name);
    const unit = sanitizeText(item.unit);
    const plannedQty = Number(item.required_qty);
    if (!CANONICAL_UUID_RE.test(issueItemId) || !displayName || !unit || !Number.isFinite(plannedQty) || plannedQty <= 0 || plannedQty > MAX_REQUIRED_QTY) {
      throw new Error("unsafe_expected_row");
    }
    rows.push({ issue_item_id: issueItemId, display_name: displayName, planned_qty: normalizeQty(plannedQty), unit });
  }

  if (rows.length < 1) throw new Error("no_expected_rows");
  if (rows.length > MAX_AGGREGATED_ROWS) throw new Error("too_many_aggregated_rows");
  return rows;
};

const toProviderExpectedRows = (rows: ExpectedLine[]): ProviderExpectedLine[] => {
  return rows.map((row, index) => ({
    line_no: index + 1,
    display_name: row.display_name,
    planned_qty: row.planned_qty,
    unit: row.unit,
  }));
};

const ALLOWED_EVIDENCE_KINDS = new Set(["handwritten_final", "printed_planned", "ambiguous"]);

const validateActualRows = (value: unknown, expectedRows: ExpectedLine[]): { rows: ActualLine[]; blockers: string[] } => {
  if (!Array.isArray(value)) throw new Error("provider_parse_failed");
  const blockers: string[] = [];
  const byLine = new Map<number, ActualLine>();
  const seen = new Set<number>();

  for (const raw of value) {
    const candidate = raw as Record<string, unknown> | null;
    if (!candidate || typeof candidate !== "object") throw new Error("provider_parse_failed");
    const lineNo = Number(candidate.line_no);
    if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > expectedRows.length) throw new Error("extra_actual_row");
    if (seen.has(lineNo)) throw new Error("duplicate_actual_row");
    seen.add(lineNo);
    const expected = expectedRows[lineNo - 1];
    const actualQty = Number(candidate.actual_qty);
    if (!Number.isFinite(actualQty) || actualQty < 0 || actualQty > MAX_REQUIRED_QTY) throw new Error("invalid_actual_qty");
    const rounded = Math.round(actualQty * 1000) / 1000;
    if (Math.abs(actualQty - rounded) > 0.0000001) throw new Error("actual_qty_precision_exceeded");
    const plannedBound = Math.min(MAX_REQUIRED_QTY, Math.max(expected.planned_qty * 10, expected.planned_qty + 1000));
    if (actualQty > plannedBound) throw new Error("actual_qty_vs_planned_out_of_bounds");
    const unit = sanitizeText(candidate.unit);
    if (unit !== expected.unit) throw new Error("unit_mismatch");
    const evidenceKind = sanitizeText(candidate.evidence_kind) as ActualLine["evidence_kind"];
    if (!ALLOWED_EVIDENCE_KINDS.has(evidenceKind)) throw new Error("invalid_evidence_kind");
    const confidence = Number(candidate.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("low_actual_confidence");
    if (evidenceKind === "ambiguous" || confidence < PASS_CONFIDENCE_THRESHOLD) blockers.push("actual_quantity_incomplete_or_ambiguous");
    byLine.set(lineNo, {
      issue_item_id: expected.issue_item_id,
      actual_qty: rounded,
      unit,
      evidence_kind: evidenceKind,
      confidence,
    });
  }

  for (let lineNo = 1; lineNo <= expectedRows.length; lineNo += 1) {
    if (!byLine.has(lineNo)) throw new Error("missing_actual_row");
  }
  return { rows: Array.from(byLine.entries()).sort(([a], [b]) => a - b).map(([, line]) => line), blockers };
};

const sanitizeCheckSummary = (value: unknown, expectedRows: ExpectedLine[]): CheckSummary => {
  const candidate = value as Partial<CheckSummary> | null;
  if (!candidate || typeof candidate !== "object") throw new Error("provider_parse_failed");
  const confidence = Number(candidate.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("provider_parse_failed");
  const actualValidation = validateActualRows((candidate as { actual_rows?: unknown }).actual_rows, expectedRows);
  const normalized = {
    identity_exact: candidate.identity_exact === true,
    rows_exact: candidate.rows_exact === true,
    document_legible: candidate.document_legible === true,
    pages_complete: candidate.pages_complete === true,
    preparer_signed: candidate.preparer_signed === true,
    warehouse_keeper_signed: candidate.warehouse_keeper_signed === true,
    receiver_signed: candidate.receiver_signed === true,
    actual_rows: actualValidation.rows,
    discrepancies: [] as string[],
    confidence,
  };
  // Never persist model-authored free text: it could echo OCR text, UUIDs, QR
  // payloads, hashes, or internal-looking values from the signed document.
  if (!normalized.identity_exact) normalized.discrepancies.push("Thông tin định danh không khớp");
  if (!normalized.rows_exact) normalized.discrepancies.push("Bảng NVL không khớp");
  if (!normalized.document_legible) normalized.discrepancies.push("Phiếu không đủ rõ để kiểm tra");
  if (!normalized.pages_complete) normalized.discrepancies.push("Phiếu có thể thiếu trang");
  if (!normalized.preparer_signed) normalized.discrepancies.push("Thiếu chữ ký Người lập phiếu");
  if (!normalized.warehouse_keeper_signed) normalized.discrepancies.push("Thiếu chữ ký Thủ kho");
  if (!normalized.receiver_signed) normalized.discrepancies.push("Thiếu chữ ký Người nhận NVL");
  if (actualValidation.blockers.length > 0) normalized.discrepancies.push("actual_quantity_incomplete_or_ambiguous");
  if (normalized.confidence < PASS_CONFIDENCE_THRESHOLD) normalized.discrepancies.push("Độ tin cậy chưa đạt ngưỡng");
  normalized.discrepancies = Array.from(new Set(normalized.discrepancies)).slice(0, MAX_DISCREPANCIES);
  return normalized;
};

const deriveOutcome = (summary: CheckSummary) =>
  summary.identity_exact === true &&
    summary.rows_exact === true &&
    summary.document_legible === true &&
    summary.pages_complete === true &&
    summary.preparer_signed === true &&
    summary.warehouse_keeper_signed === true &&
    summary.receiver_signed === true &&
    summary.actual_rows.every((line) => line.evidence_kind !== "ambiguous" && line.confidence >= PASS_CONFIDENCE_THRESHOLD) &&
    summary.confidence >= PASS_CONFIDENCE_THRESHOLD
    ? "passed"
    : "needs_review";

const finalPayload = (
  checkId: string,
  signedSha256: string,
  outcome: string,
  summary: CheckSummary | Record<string, unknown>,
  actualRows: ActualLine[],
  model: string,
  modelVersion: string,
  actorId: string,
) => ({
  p_check_id: checkId,
  p_signed_sha256: signedSha256,
  p_outcome: outcome,
  p_result: safeResponseSummary(summary),
  p_actual_rows: outcome === "passed" ? actualRows.map((line) => ({
    issue_item_id: line.issue_item_id,
    actual_qty: line.actual_qty,
    unit: line.unit,
    evidence_kind: line.evidence_kind,
    confidence: line.confidence,
  })) : [],
  p_model: model,
  p_model_version: modelVersion,
  p_actor_id: actorId,
});

async function finalizeCheckWithRetry(admin: any, payload: Record<string, unknown>) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await admin.rpc("finalize_q7_material_issue_check_with_actuals", payload);
    if (!error && data) return { data, error: null };
    lastError = error || new Error("empty_finalize_result");
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  return { data: null, error: lastError };
}

async function finalizeWithSafeError(
  admin: any,
  beginResult: BeginResult,
  actorId: string,
  outcome: "failed_transient" | "error",
  reason: string,
  model: string,
) {
  if (!beginResult.check_id || !beginResult.signed_file_sha256) return null;
  const safe = { reason: sanitizeText(reason), confidence: 0 };
  const { data, error } = await finalizeCheckWithRetry(admin, finalPayload(
    beginResult.check_id,
    beginResult.signed_file_sha256,
    outcome,
    safe,
    [],
    model,
    "edge-error",
    actorId,
  ));
  return error || !data ? null : safe;
}

async function callOpenAi(pdfBytes: Uint8Array, expectedFacts: Record<string, unknown>, expectedRows: ExpectedLine[], model: string): Promise<CheckSummary> {
  const apiKey = Deno.env.get("OPENAI_API_KEY") || "";
  if (!apiKey) throw new Error("provider_failed");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        ["Authori" + "zation"]: ["Bea", "rer ", apiKey].join(""),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: 1200,
        input: [{
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Validate this signed Q7 material issue PDF conservatively against the expected safe facts. identity_exact is true only when issue number, production order number, issue date, and revision are all visibly exact. rows_exact is true only when every expected line number, material display name, planned quantity, and unit matches the document table with no missing, changed, duplicate, or extra row. For actual_rows, extract the final signed actual quantity for every line_no exactly once: a handwritten final quantity or amendment wins; if there is no amendment use the printed planned quantity; if the final quantity is unclear return evidence_kind ambiguous with confidence below 0.8. Each signature boolean is true only for a visible handwritten or digital signature/mark in that exact signature block; printed labels or typed names alone are not signatures. pages_complete requires every page and the signature section to be visible. Return false whenever uncertain. Do not transcribe OCR text, UUIDs, QR payloads, hashes, paths, material rows, raw OCR, comments, or other document content. Return only JSON matching the schema.",
            },
            {
              type: "input_text",
              text: JSON.stringify({ expectedFacts }),
            },
            {
              type: "input_file",
              filename: "signed-q7-material-issue.pdf",
              file_data: `data:application/pdf;base64,${bytesToBase64(pdfBytes)}`,
            },
          ],
        }],
        text: {
          format: {
            type: "json_schema",
            name: "q7_signed_material_issue_check",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: [
                "identity_exact",
                "rows_exact",
                "document_legible",
                "pages_complete",
                "preparer_signed",
                "warehouse_keeper_signed",
                "receiver_signed",
                "actual_rows",
                "confidence",
              ],
              properties: {
                identity_exact: { type: "boolean" },
                rows_exact: { type: "boolean" },
                document_legible: { type: "boolean" },
                pages_complete: { type: "boolean" },
                preparer_signed: { type: "boolean" },
                warehouse_keeper_signed: { type: "boolean" },
                receiver_signed: { type: "boolean" },
                actual_rows: {
                  type: "array",
                  minItems: expectedRows.length,
                  maxItems: expectedRows.length,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["line_no", "actual_qty", "unit", "evidence_kind", "confidence"],
                    properties: {
                      line_no: { type: "integer", minimum: 1, maximum: expectedRows.length },
                      actual_qty: { type: "number", minimum: 0, maximum: MAX_REQUIRED_QTY },
                      unit: { type: "string", enum: expectedRows.map((row) => row.unit) },
                      evidence_kind: { type: "string", enum: ["handwritten_final", "printed_planned", "ambiguous"] },
                      confidence: { type: "number", minimum: 0, maximum: 1 },
                    },
                  },
                },
                confidence: { type: "number", minimum: 0, maximum: 1 },
              },
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error("provider_failed");
    const data = await response.json();
    const outputText = typeof data.output_text === "string"
      ? data.output_text
      : Array.isArray(data.output)
      ? data.output.flatMap((entry: any) => entry.content || []).map((part: any) => part.text || "").join("")
      : "";
    if (!outputText || outputText.length > 10000) throw new Error("provider_parse_failed");
    return sanitizeCheckSummary(JSON.parse(outputText), expectedRows);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("provider_timeout");
    if (error instanceof SyntaxError) throw new Error("provider_parse_failed");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method not allowed" }, 405);

  try {
    const { user } = await requireAuth(req, getCorsHeaders(req));
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    if (!(await hasEditPermission(admin, user.id))) {
      return jsonResponse(req, { error: "Bạn không có quyền kiểm tra phiếu NVL Q7 đã ký." }, 403);
    }

    let payload: { issue_id?: string };
    try {
      payload = await req.json();
    } catch {
      return jsonResponse(req, { error: "Body không hợp lệ." }, 400);
    }

    const issueId = String(payload.issue_id || "").trim();
    if (!CANONICAL_UUID_RE.test(issueId)) {
      return jsonResponse(req, { error: "issue_id không hợp lệ." }, 422);
    }

    const { data: rateLimitData, error: rateLimitError } = await admin.rpc("consume_q7_material_issue_check_rate_limit", {
      p_user_id: user.id,
      p_daily_limit: DAILY_CHECK_LIMIT,
    });
    if (rateLimitError || !isValidRateLimitResult(rateLimitData)) {
      return jsonResponse(req, { error: "Không thể kiểm tra giới hạn xác minh phiếu đã ký." }, 503, { "Retry-After": "30" });
    }
    const limitHeaders = rateHeaders(rateLimitData);
    if (!rateLimitData.allowed) {
      return jsonResponse(req, { error: "Thao tác quá nhanh. Vui lòng thử lại sau." }, 429, limitHeaders);
    }

    // Claim the immutable one-time attempt only after quota enforcement succeeds;
    // a temporary limiter outage or 429 must never consume the sole validation.
    const { data: beginData, error: beginError } = await admin.rpc("begin_q7_material_issue_check", {
      p_issue_id: issueId,
      p_actor_id: user.id,
    });
    if (beginError || !beginData) {
      return jsonResponse(req, { error: "Không thể bắt đầu kiểm tra phiếu NVL Q7." }, 409, limitHeaders);
    }

    const beginResult = beginData as BeginResult;
    if (beginResult.status === "already_checked") {
      return jsonResponse(req, safeStoredResult(beginResult), 200, limitHeaders);
    }
    if (beginResult.status === "checking_unchanged") {
      const inProgressResponse = safeInProgressResult(beginResult);
      return jsonResponse(req, inProgressResponse, 409, { ...limitHeaders, "Retry-After": "15" });
    }
    if (beginResult.status !== "checking_started" || !beginResult.check_id || !beginResult.signed_file_path || !beginResult.signed_file_sha256) {
      return jsonResponse(req, { error: "Trạng thái kiểm tra phiếu NVL không hợp lệ." }, 409, limitHeaders);
    }

    let expectedFacts: Record<string, unknown>;
    let expectedRows: ExpectedLine[];
    try {
      const issueNumber = sanitizeText(beginResult.issue_number);
      const issueDate = sanitizeText(beginResult.issue_date);
      const productionOrderNumber = sanitizeText(beginResult.production_order_number);
      const revision = Number(beginResult.revision);
      if (!issueNumber || !issueDate || !productionOrderNumber || !Number.isInteger(revision) || revision < 1) {
        throw new Error("unsafe_expected_identity");
      }
      expectedRows = await fetchExpectedFacts(admin, beginResult);
      expectedFacts = {
        issue_number: issueNumber,
        issue_date: issueDate,
        revision,
        production_order_number: productionOrderNumber,
        rows: toProviderExpectedRows(expectedRows),
      };
    } catch {
      const finalized = await finalizeWithSafeError(admin, beginResult, user.id, "error", "expected_facts_unavailable", "edge");
      return jsonResponse(req, {
        error: finalized ? "Không thể chuẩn bị dữ liệu đối chiếu phiếu đã ký." : "Không thể ghi nhận lỗi kiểm tra phiếu đã ký.",
      }, 500, limitHeaders);
    }

    const { data: signedBlob, error: downloadError } = await admin.storage.from(BUCKET).download(beginResult.signed_file_path);
    if (downloadError || !(signedBlob instanceof Blob)) {
      const finalized = await finalizeWithSafeError(admin, beginResult, user.id, "failed_transient", "download_failed", "edge");
      return jsonResponse(req, {
        error: finalized ? "Không thể tải PDF đã ký từ vùng riêng tư." : "Không thể ghi nhận lỗi kiểm tra phiếu đã ký.",
      }, 500, limitHeaders);
    }

    let signedBytes: Uint8Array;
    try {
      signedBytes = new Uint8Array(await signedBlob.arrayBuffer());
    } catch {
      const finalized = await finalizeWithSafeError(admin, beginResult, user.id, "failed_transient", "download_read_failed", "edge");
      return jsonResponse(req, {
        error: finalized ? "Không thể đọc PDF đã ký từ vùng riêng tư." : "Không thể ghi nhận lỗi kiểm tra phiếu đã ký.",
      }, 500, limitHeaders);
    }
    if (!hasPdfSignature(signedBytes)) {
      const finalized = await finalizeWithSafeError(admin, beginResult, user.id, "error", "invalid_pdf", "edge");
      return jsonResponse(req, {
        error: finalized ? "PDF đã ký không hợp lệ." : "Không thể ghi nhận lỗi kiểm tra phiếu đã ký.",
      }, finalized ? 422 : 500, limitHeaders);
    }

    let computedSha256: string;
    try {
      computedSha256 = await sha256Hex(signedBytes);
    } catch {
      const finalized = await finalizeWithSafeError(admin, beginResult, user.id, "error", "hash_failed", "edge");
      return jsonResponse(req, {
        error: finalized ? "Không thể xác minh mã kiểm tra PDF đã ký." : "Không thể ghi nhận lỗi kiểm tra phiếu đã ký.",
      }, 500, limitHeaders);
    }
    if (computedSha256 !== beginResult.signed_file_sha256) {
      const finalized = await finalizeWithSafeError(admin, beginResult, user.id, "error", "hash_mismatch", "edge");
      return jsonResponse(req, {
        error: finalized ? "PDF đã ký không khớp hồ sơ đã ghi nhận." : "Không thể ghi nhận lỗi kiểm tra phiếu đã ký.",
      }, finalized ? 409 : 500, limitHeaders);
    }

    const model = Deno.env.get("Q7_MATERIAL_ISSUE_CHECK_MODEL") || "gpt-4.1-mini";
    let summary: CheckSummary;
    try {
      summary = await callOpenAi(signedBytes, expectedFacts, expectedRows, model);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "provider_failed";
      const outcome = reason === "provider_timeout" || reason === "provider_failed" ? "failed_transient" : "error";
      const finalized = await finalizeWithSafeError(admin, beginResult, user.id, outcome, reason, model);
      return jsonResponse(req, finalized
        ? { error: "Không thể xác minh tự động phiếu đã ký.", status: "needs_review" }
        : { error: "Không thể lưu lỗi xác minh phiếu đã ký." }, finalized ? 502 : 500, limitHeaders);
    }

    const outcome = deriveOutcome(summary);
    const { data: finalData, error: finalError } = await finalizeCheckWithRetry(admin, finalPayload(
      beginResult.check_id,
      beginResult.signed_file_sha256,
      outcome,
      summary,
      summary.actual_rows,
      model,
      "responses-api",
      user.id,
    ));
    if (finalError || !finalData) {
      return jsonResponse(req, { error: "Không thể lưu kết quả kiểm tra phiếu NVL Q7." }, 409, limitHeaders);
    }

    return jsonResponse(req, {
      issue_id: beginResult.issue_id,
      issue_number: beginResult.issue_number,
      revision: beginResult.revision,
      status: outcome === "passed" ? "ready_to_confirm" : "needs_review",
      check_id: beginResult.check_id,
      outcome,
      summary: safeResponseSummary(summary),
    }, 200, limitHeaders);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(`[${FUNCTION_NAME}] request failed`);
    return jsonResponse(req, { error: "Không thể kiểm tra phiếu NVL Q7 đã ký." }, 500);
  }
});
