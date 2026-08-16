import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { requireAuth } from "../_shared/auth.ts";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

const FUNCTION_NAME = "production-material-issue-signed-upload";
const BUCKET = "production-material-issue-documents";
const DAILY_UPLOAD_LIMIT = 80;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_UPLOAD_BYTES + 512 * 1024;
const PDF_TAIL_BYTES = 2048;
const CANONICAL_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const ISSUE_SELECT = "id,issue_number,status,revision,location_code,is_current,superseded_by_issue_id,pdf_path,pdf_sha256,signed_file_path,signed_file_sha256";

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  reset: string | null;
  retry_after_seconds: number | null;
};

type IssueRow = {
  id: string;
  issue_number: string;
  status: string;
  revision: number;
  location_code: string | null;
  is_current: boolean;
  superseded_by_issue_id: string | null;
  pdf_path: string | null;
  pdf_sha256: string | null;
  signed_file_sha256: string | null;
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

const sha256Hex = async (bytes: Uint8Array) => {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const hasPdfSignature = (bytes: Uint8Array) => {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_UPLOAD_BYTES) return false;
  const head = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 8)));
  if (!head.startsWith("%PDF-")) return false;
  const tailStart = Math.max(0, bytes.byteLength - PDF_TAIL_BYTES);
  const tail = new TextDecoder().decode(bytes.slice(tailStart));
  return tail.includes("%%EOF");
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

const fetchIssue = async (admin: any, issueId: string): Promise<IssueRow | null> => {
  const { data, error } = await admin
    .from("production_material_issues")
    .select(ISSUE_SELECT)
    .eq("id", issueId)
    .single();
  if (error || !data) return null;
  return data as IssueRow;
};

const isStorageObjectAlreadyExistsError = (error: unknown) => {
  const err = error as { statusCode?: string | number; status?: string | number; error?: string; message?: string } | null;
  const code = String(err?.statusCode ?? err?.status ?? "").toLowerCase();
  const text = `${err?.error || ""} ${err?.message || ""}`.toLowerCase();
  return code === "409" || text.includes("already exists") || text.includes("duplicate") || text.includes("resource_already_exists");
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  if (req.method !== "POST") return jsonResponse(req, { error: "Method not allowed" }, 405);

  try {
    const contentLength = Number(req.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return jsonResponse(req, { error: "File PDF vượt quá giới hạn 20MB." }, 413);
    }

    const { user } = await requireAuth(req, getCorsHeaders(req));
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    if (!(await hasEditPermission(admin, user.id))) {
      return jsonResponse(req, { error: "Bạn không có quyền tải phiếu NVL Q7 đã ký." }, 403);
    }

    const { data: rateLimitData, error: rateLimitError } = await admin.rpc("consume_q7_material_issue_signed_upload_rate_limit", {
      p_user_id: user.id,
      p_daily_limit: DAILY_UPLOAD_LIMIT,
    });
    if (rateLimitError || !isValidRateLimitResult(rateLimitData)) {
      return jsonResponse(req, { error: "Không thể kiểm tra giới hạn tải phiếu đã ký." }, 503, { "Retry-After": "30" });
    }
    const limitHeaders = rateHeaders(rateLimitData);
    if (!rateLimitData.allowed) {
      return jsonResponse(req, { error: "Thao tác quá nhanh. Vui lòng thử lại sau." }, 429, limitHeaders);
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return jsonResponse(req, { error: "Multipart body không hợp lệ." }, 400, limitHeaders);
    }

    const issueId = String(form.get("issue_id") || "").trim();
    if (!CANONICAL_UUID_RE.test(issueId)) {
      return jsonResponse(req, { error: "issue_id không hợp lệ." }, 422, limitHeaders);
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return jsonResponse(req, { error: "Thiếu file PDF đã ký." }, 400, limitHeaders);
    }
    if (file.type !== "application/pdf") {
      return jsonResponse(req, { error: "Chỉ chấp nhận file application/pdf." }, 415, limitHeaders);
    }
    if (file.size < 1 || file.size > MAX_UPLOAD_BYTES) {
      return jsonResponse(req, { error: "File PDF vượt quá giới hạn 20MB." }, 413, limitHeaders);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!hasPdfSignature(bytes)) {
      return jsonResponse(req, { error: "PDF không hợp lệ hoặc thiếu dấu kết thúc %%EOF." }, 422, limitHeaders);
    }

    const issue = await fetchIssue(admin, issueId);
    if (!issue) return jsonResponse(req, { error: "Không tìm thấy phiếu NVL Q7." }, 404, limitHeaders);
    if (issue.location_code !== "q7" || issue.is_current !== true || issue.superseded_by_issue_id !== null) {
      return jsonResponse(req, { error: "Phiếu NVL Q7 không còn hiệu lực." }, 409, limitHeaders);
    }
    if (!issue.pdf_path || !issue.pdf_sha256) {
      return jsonResponse(req, { error: "Phiếu NVL chưa có PDF gốc để đối chiếu." }, 409, limitHeaders);
    }
    if (issue.status !== "pdf_ready" && issue.status !== "signed_uploaded") {
      return jsonResponse(req, { error: "Trạng thái phiếu NVL không cho phép tải bản đã ký." }, 409, limitHeaders);
    }

    const signedSha256 = await sha256Hex(bytes);
    const signedPath = `q7/${issue.id}/revision-${issue.revision}/signed/${signedSha256}.pdf`;
    let uploadedByThisRequest = false;

    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(signedPath, bytes, { contentType: "application/pdf", upsert: false });
    if (uploadError) {
      if (!isStorageObjectAlreadyExistsError(uploadError)) {
        return jsonResponse(req, { error: "Không thể lưu PDF đã ký ở vùng riêng tư." }, 500, limitHeaders);
      }
    } else {
      uploadedByThisRequest = true;
    }

    const { data: recordData, error: recordError } = await admin.rpc("record_q7_material_issue_signed_upload", {
      p_issue_id: issue.id,
      p_signed_path: signedPath,
      p_signed_sha256: signedSha256,
      p_actor_id: user.id,
    });
    if (recordError || !recordData) {
      if (uploadedByThisRequest) await admin.storage.from(BUCKET).remove([signedPath]);
      return jsonResponse(req, { error: "Không thể ghi nhận PDF đã ký." }, uploadedByThisRequest ? 409 : 409, limitHeaders);
    }

    const record = recordData as { status?: string; issue_number?: string; revision?: number; signed_sha256?: string };
    const status = String(record.status || "signed_uploaded");
    if (status !== "signed_uploaded" && status !== "signed_uploaded_unchanged") {
      if (uploadedByThisRequest) await admin.storage.from(BUCKET).remove([signedPath]);
      return jsonResponse(req, { error: "Kết quả ghi nhận PDF đã ký không hợp lệ." }, 409, limitHeaders);
    }

    return jsonResponse(req, {
      issue_id: issue.id,
      issue_number: record.issue_number || issue.issue_number,
      revision: record.revision || issue.revision,
      status,
      signed_sha256: record.signed_sha256 || signedSha256,
      size: bytes.byteLength,
    }, 200, limitHeaders);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(`[${FUNCTION_NAME}] request failed`);
    return jsonResponse(req, { error: "Không thể tải phiếu NVL Q7 đã ký." }, 500);
  }
});
