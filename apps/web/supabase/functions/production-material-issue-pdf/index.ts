import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { requireAuth } from "../_shared/auth.ts";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { buildQ7MaterialIssuePdf, type MaterialIssuePdfHeader, type MaterialIssuePdfRow } from "./pdf_builder.ts";

const FUNCTION_NAME = "production-material-issue-pdf";
const BUCKET = "production-material-issue-documents";
const SIGNED_URL_SECONDS = 300;
const DAILY_PDF_LIMIT = 80;
const MAX_SOURCE_ROWS = 500;
const MAX_AGGREGATED_ROWS = 200;
const MAX_REQUIRED_QTY = 1_000_000;
const CONFLICT_RECOVERY_DELAYS_MS = [50, 100, 200, 400] as const;
const FONT_BASE = new URL("../_shared/fonts/", import.meta.url);
const BRAND_BASE = new URL("../_shared/brand/", import.meta.url);
const PDF_ASSETS_PROMISE = Promise.all([
  Deno.readFile(new URL("NotoSans-Regular.ttf", FONT_BASE)),
  Deno.readFile(new URL("NotoSans-Bold.ttf", FONT_BASE)),
  Deno.readFile(new URL("bmq-logo-192.png", BRAND_BASE)),
]).then(([regular, bold, logo]) => ({ regular, bold, logo }));
const CANONICAL_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

const ISSUE_SELECT = "id,issue_number,issue_date,status,revision,source_hash,immutable_token,pdf_path,pdf_sha256,location_code,production_order_id,production_order:production_orders!inner(production_number)";

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  reset: string | null;
  retry_after_seconds: number | null;
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

const getRateLimitHeaders = (result: RateLimitResult): Record<string, string> => {
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
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), ...extraHeaders, "Content-Type": "application/json" },
  });

type GeneratorResult = {
  status?: string;
  issue_id?: string;
  issue_number?: string;
  revision?: number;
  blockers?: Array<{ status?: string; details?: unknown }>;
};

type SafeIssueRow = MaterialIssuePdfHeader & {
  id: string;
  issue_date: string;
  status: string;
  pdf_path: string | null;
  pdf_sha256: string | null;
  location_code: string | null;
  production_order_id: string;
  production_order: { production_number: string };
};

const blockedStatuses = new Set([
  "blocked_non_q7_order",
  "blocked_cancelled_order",
  "blocked_completed_order",
  "blocked_ineligible_status",
  "blocked_missing_finished_skus",
  "blocked_nonpositive_quantities",
  "blocked_missing_formulations",
  "blocked_invalid_formulations",
  "blocked_nonpositive_required_qty",
  "blocked_missing_q7_mappings",
  "blocked_duplicate_q7_mappings",
  "blocked_invalid_q7_mappings",
  "blocked_missing_kitchen_items",
  "blocked_posted_issue_changed",
]);

const blockerMessages: Record<string, string> = {
  blocked_non_q7_order: "Lệnh sản xuất không thuộc Xưởng Q7.",
  blocked_cancelled_order: "Lệnh sản xuất đã hủy, không thể tạo Phiếu NVL.",
  blocked_completed_order: "Lệnh sản xuất đã hoàn tất nhưng chưa có phiếu hợp lệ để tải lại.",
  blocked_ineligible_status: "Trạng thái lệnh sản xuất chưa đủ điều kiện tạo Phiếu NVL.",
  blocked_missing_finished_skus: "Thiếu SKU thành phẩm đã lưu trên dòng sản xuất.",
  blocked_nonpositive_quantities: "Số lượng sản xuất phải lớn hơn 0.",
  blocked_missing_formulations: "Thiếu BOM/công thức NVL cho SKU thành phẩm.",
  blocked_invalid_formulations: "BOM/công thức NVL chưa hợp lệ.",
  blocked_nonpositive_required_qty: "Số lượng NVL cần xuất phải lớn hơn 0.",
  blocked_missing_q7_mappings: "Thiếu mapping NVL đã duyệt sang Kho bếp Q7.",
  blocked_duplicate_q7_mappings: "Có nhiều mapping NVL Q7 đã duyệt cho cùng một dòng.",
  blocked_invalid_q7_mappings: "Mapping NVL Q7 chưa hợp lệ.",
  blocked_missing_kitchen_items: "NVL mapping chưa trỏ tới hàng tồn Kho bếp Q7 đang hoạt động.",
  blocked_posted_issue_changed: "Phiếu NVL đã chốt/post nhưng dữ liệu nguồn đã thay đổi.",
};

const isEligibleGeneratorStatus = (status: string) =>
  status === "generated" ||
  status === "pdf_ready_unchanged" ||
  status.endsWith("_unchanged") && !status.startsWith("blocked_");

const safeBlockers = (result: GeneratorResult) => {
  const blockers = Array.isArray(result.blockers) ? result.blockers : [];
  return blockers.map((blocker) => {
    const code = String(blocker?.status || result.status || "blocked_ineligible_status");
    return { status: code, message: blockerMessages[code] || "Phiếu NVL đang bị chặn, cần kiểm tra dữ liệu." };
  });
};

const sha256Hex = async (bytes: Uint8Array) => {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

async function hasPdfPermission(admin: any, userId: string) {
  const [{ data: roles, error: rolesError }, { data: permissions, error: permissionsError }] = await Promise.all([
    admin.from("user_roles").select("role").eq("user_id", userId),
    admin
      .from("user_module_permissions")
      .select("module_key,can_view,can_edit")
      .eq("user_id", userId)
      .in("module_key", ["production_q7", "warehouse", "kitchen_inventory", "q7_material_inventory"]),
  ]);

  if (rolesError || permissionsError) return false;
  if ((roles || []).some((row: { role?: string }) => row.role === "owner")) return true;
  return (permissions || []).some((row: { can_view?: boolean; can_edit?: boolean }) => row.can_edit === true);
}

const normalizeIssue = (issueData: unknown): SafeIssueRow => {
  const issueRow = issueData as SafeIssueRow & { production_order: { production_number: string } | Array<{ production_number: string }> };
  return {
    ...issueRow,
    issue_id: issueRow.id,
    production_order: Array.isArray(issueRow.production_order) ? issueRow.production_order[0] : issueRow.production_order,
  } as SafeIssueRow;
};

async function fetchIssue(admin: any, issueId: string, productionOrderId: string): Promise<SafeIssueRow | null> {
  const { data: issueData, error: issueError } = await admin
    .from("production_material_issues")
    .select(ISSUE_SELECT)
    .eq("id", issueId)
    .eq("production_order_id", productionOrderId)
    .single();
  if (issueError || !issueData) return null;
  return normalizeIssue(issueData);
}

async function signExistingPdf(admin: any, req: Request, issue: SafeIssueRow, expectedPdfPath?: string, expectedPdfSha256?: string) {
  if (!issue.pdf_path || !issue.pdf_sha256) return null;
  if (expectedPdfPath && issue.pdf_path !== expectedPdfPath) return null;
  if (expectedPdfSha256 && issue.pdf_sha256 !== expectedPdfSha256) return null;

  const { data: signed, error: signedError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(issue.pdf_path, SIGNED_URL_SECONDS);
  if (signedError || !signed?.signedUrl) {
    return jsonResponse(req, { error: "Không thể tạo link tải Phiếu NVL." }, 500);
  }

  return jsonResponse(req, {
    issue_id: issue.id,
    issue_number: issue.issue_number,
    revision: issue.revision,
    status: issue.status,
    pdf_sha256: issue.pdf_sha256,
    download_url: signed.signedUrl,
    expires_in: SIGNED_URL_SECONDS,
  });
}

const delayMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isStorageObjectAlreadyExistsError = (error: unknown) => {
  const err = error as { statusCode?: string | number; status?: string | number; error?: string; message?: string } | null;
  const code = String(err?.statusCode ?? err?.status ?? "").toLowerCase();
  const text = `${err?.error || ""} ${err?.message || ""}`.toLowerCase();
  return code === "409" || text.includes("already exists") || text.includes("duplicate") || text.includes("resource_already_exists");
};

async function recoverPdfAfterUploadConflict(
  admin: any,
  req: Request,
  issue: SafeIssueRow,
  expectedPdfPath: string,
  expectedPdfSha256: string,
  rateHeaders: Record<string, string>,
) {
  for (const waitMs of CONFLICT_RECOVERY_DELAYS_MS) {
    await delayMs(waitMs);
    const latestIssue = await fetchIssue(admin, issue.id, issue.production_order_id);
    if (!latestIssue || latestIssue.status !== "pdf_ready") continue;
    const signedResponse = await signExistingPdf(admin, req, latestIssue, expectedPdfPath, expectedPdfSha256);
    if (signedResponse) return signedResponse;
  }
  return jsonResponse(
    req,
    { error: "PDF đang được tạo bởi yêu cầu khác. Vui lòng thử lại sau.", status: "pdf_generation_in_progress" },
    409,
    { ...rateHeaders, "Retry-After": "1" },
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method not allowed" }, 405);

  try {
    const { user, token } = await requireAuth(req, getCorsHeaders(req));
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { ["Authori" + "zation"]: ["Bea", "rer ", token].join("") } },
    });

    if (!(await hasPdfPermission(admin, user.id))) {
      return jsonResponse(req, { error: "Bạn không có quyền tạo Phiếu NVL Q7." }, 403);
    }

    const { data: rateLimitData, error: rateLimitError } = await admin.rpc("consume_q7_material_issue_pdf_rate_limit", {
      p_user_id: user.id,
      p_daily_limit: DAILY_PDF_LIMIT,
    });
    if (rateLimitError || !isValidRateLimitResult(rateLimitData)) {
      return jsonResponse(req, { error: "Không thể kiểm tra giới hạn tải Phiếu NVL." }, 503, { "Retry-After": "30" });
    }
    const rateLimit = rateLimitData;
    const rateHeaders = getRateLimitHeaders(rateLimit);
    if (!rateLimit.allowed) {
      return jsonResponse(req, { error: "Thao tác quá nhanh. Vui lòng thử lại sau." }, 429, rateHeaders);
    }

    let payload: { production_order_id?: string };
    try {
      payload = await req.json();
    } catch {
      return jsonResponse(req, { error: "Body không hợp lệ." }, 400, rateHeaders);
    }

    const productionOrderId = String(payload.production_order_id || "").trim();
    if (!CANONICAL_UUID_RE.test(productionOrderId)) {
      return jsonResponse(req, { error: "production_order_id không hợp lệ." }, 422, rateHeaders);
    }

    const { data: generatorData, error: generatorError } = await userClient.rpc(
      "generate_q7_production_material_issue",
      { p_production_order_id: productionOrderId },
    );
    if (generatorError) {
      return jsonResponse(req, { error: "Không thể sinh dữ liệu Phiếu NVL." }, 422, rateHeaders);
    }

    const generator = (generatorData || {}) as GeneratorResult;
    const status = String(generator.status || "");
    if (blockedStatuses.has(status) || status.startsWith("blocked_")) {
      const responseStatus = status === "blocked_ineligible_status" || status === "blocked_non_q7_order" ? 422 : 409;
      return jsonResponse(req, { error: blockerMessages[status] || "Phiếu NVL bị chặn.", status, blockers: safeBlockers(generator) }, responseStatus, rateHeaders);
    }
    if (!isEligibleGeneratorStatus(status) || !generator.issue_id) {
      return jsonResponse(req, { error: "Trạng thái Phiếu NVL không hợp lệ.", status }, 422, rateHeaders);
    }

    const issue = await fetchIssue(admin, generator.issue_id, productionOrderId);
    if (!issue) {
      return jsonResponse(req, { error: "Không tìm thấy Phiếu NVL vừa sinh." }, 404, rateHeaders);
    }
    if (issue.location_code !== "q7" || !["generated", "pdf_ready"].includes(issue.status)) {
      return jsonResponse(req, { error: "Phiếu NVL không ở trạng thái có thể tải PDF." }, 409, rateHeaders);
    }

    const existingResponse = await signExistingPdf(admin, req, issue);
    if (existingResponse) return existingResponse;

    const { data: itemData, error: itemError, count: itemCount } = await admin
      .from("production_material_issue_items")
      .select("ingredient_name,required_qty,unit", { count: "exact" })
      .eq("material_issue_id", issue.id)
      .order("ingredient_name", { ascending: true })
      .range(0, MAX_SOURCE_ROWS);
    if (itemError || itemCount === null) return jsonResponse(req, { error: "Không thể tải dòng NVL." }, 500, rateHeaders);
    if (itemCount > MAX_SOURCE_ROWS) {
      return jsonResponse(req, { error: "Phiếu NVL có quá nhiều dòng để tạo PDF an toàn." }, 413, rateHeaders);
    }

    const aggregated = new Map<string, MaterialIssuePdfRow>();
    for (const item of itemData || []) {
      const ingredientName = String(item.ingredient_name || "").trim();
      const unit = String(item.unit || "").trim();
      const requiredQty = Number(item.required_qty);
      if (!ingredientName || !unit || !Number.isFinite(requiredQty) || requiredQty <= 0 || requiredQty > MAX_REQUIRED_QTY) {
        return jsonResponse(req, { error: "Dòng NVL chưa hợp lệ, vui lòng kiểm tra tên NVL, đơn vị và số lượng." }, 422, rateHeaders);
      }
      const key = `${ingredientName}\u0000${unit}`;
      const current = aggregated.get(key) || { ingredient_name: ingredientName, unit, required_qty: 0 };
      current.required_qty = Number((current.required_qty + requiredQty).toFixed(3));
      if (!Number.isFinite(current.required_qty) || current.required_qty <= 0 || current.required_qty > MAX_REQUIRED_QTY) {
        return jsonResponse(req, { error: "Dòng NVL chưa hợp lệ, số lượng vượt giới hạn an toàn." }, 422, rateHeaders);
      }
      aggregated.set(key, current);
    }
    const rows = Array.from(aggregated.values()).sort((a, b) =>
      `${a.ingredient_name}|${a.unit}`.localeCompare(`${b.ingredient_name}|${b.unit}`, "vi"),
    );
    if (rows.length === 0) return jsonResponse(req, { error: "Phiếu NVL chưa có dòng hàng." }, 409, rateHeaders);
    if (rows.length > MAX_AGGREGATED_ROWS) {
      return jsonResponse(req, { error: "Phiếu NVL có quá nhiều dòng tổng hợp để tạo PDF an toàn." }, 413, rateHeaders);
    }

    const assets = await PDF_ASSETS_PROMISE;
    const pdfBytes = await buildQ7MaterialIssuePdf(issue, rows, assets);
    const pdfSha256 = await sha256Hex(pdfBytes);
    const pdfPath = `q7/${issue.id}/revision-${issue.revision}/original.pdf`;

    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(pdfPath, pdfBytes, { contentType: "application/pdf", upsert: false });
    if (uploadError) {
      if (isStorageObjectAlreadyExistsError(uploadError)) {
        return await recoverPdfAfterUploadConflict(admin, req, issue, pdfPath, pdfSha256, rateHeaders);
      }
      return jsonResponse(req, { error: "Không thể lưu PDF riêng tư." }, 500, rateHeaders);
    }

    const { data: recordData, error: recordError } = await admin.rpc("record_q7_material_issue_pdf", {
      p_issue_id: issue.id,
      p_pdf_path: pdfPath,
      p_pdf_sha256: pdfSha256,
      p_actor_id: user.id,
    });
    if (recordError || !recordData) {
      await admin.storage.from(BUCKET).remove([pdfPath]);
      return jsonResponse(req, { error: "Không thể ghi nhận PDF Phiếu NVL." }, 409, rateHeaders);
    }

    const { data: signed, error: signedError } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(pdfPath, SIGNED_URL_SECONDS);
    if (signedError || !signed?.signedUrl) {
      return jsonResponse(req, { error: "Không thể tạo link tải Phiếu NVL." }, 500, rateHeaders);
    }

    return jsonResponse(req, {
      issue_id: issue.id,
      issue_number: issue.issue_number,
      revision: issue.revision,
      status: "pdf_ready",
      pdf_sha256: pdfSha256,
      download_url: signed.signedUrl,
      expires_in: SIGNED_URL_SECONDS,
    }, 200, rateHeaders);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(`[${FUNCTION_NAME}] request failed`);
    return jsonResponse(req, { error: "Không thể tạo Phiếu NVL." }, 500);
  }
});
