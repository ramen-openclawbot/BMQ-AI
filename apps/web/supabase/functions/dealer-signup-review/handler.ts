/**
 * CRM review endpoint for dealer signup applications.
 *
 * The handler is separated from index.ts so permissions, idempotency and
 * document rules can be tested without Supabase, Gmail or storage.
 */
import type { GmailAttachment } from "../_shared/gmail-send.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import type {
  DealerContractInput,
  DealerContractPdfAssets,
} from "../_shared/dealer-signup-contract.ts";
import {
  buildDealerSignupApprovedEmail,
  buildDealerSignupRejectedEmail,
  dealerContractDraftPath,
  dealerSignedContractPath,
  dealerSignupPublicBaseUrl,
  dealerSlipTokenExpiresAt,
  documentTimestamp,
  generateDealerSlipToken,
  hashDealerSlipToken,
  validateDealerSignupDocument,
  type DealerSignupApprovalResult,
  type DealerSignupReviewApplication,
} from "../_shared/dealer-signup-review.ts";

export type DealerSignupReviewActor = {
  userId: string;
  isOwner: boolean;
  crmView: boolean;
  crmEdit: boolean;
  accountingEdit: boolean;
};

export type DealerSignupReviewEmail = {
  to: string;
  cc?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: GmailAttachment[];
};

export type DealerSignupReviewStore = {
  getApplication(id: string): Promise<DealerSignupReviewApplication | null>;
  approve(input: {
    applicationId: string;
    reviewerId: string | null;
    mode: "auto" | "manual";
    customerGroup: string | null;
    productGroup: string | null;
    slipTokenHash: string;
    slipExpiresAt: string;
  }): Promise<DealerSignupApprovalResult>;
  setContractDraft(id: string, path: string): Promise<void>;
  setSignedContract(id: string, path: string, uploadedBy: string): Promise<void>;
  reject(id: string, reviewerId: string, reason: string): Promise<void>;
  setLastError(id: string, code: string): Promise<void>;
  rotateSlipToken(id: string, hash: string, expiresAt: string): Promise<void>;
};

export type DealerSignupReviewDeps = {
  authenticate: (req: Request) => Promise<DealerSignupReviewActor>;
  store: DealerSignupReviewStore;
  buildContractPdf: (
    input: DealerContractInput,
    assets?: DealerContractPdfAssets,
  ) => Promise<Uint8Array>;
  loadContractAssets: () => Promise<DealerContractPdfAssets>;
  uploadDocument: (path: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  createSignedUrl: (path: string, expiresInSeconds: number) => Promise<string>;
  sendEmail: (email: DealerSignupReviewEmail) => Promise<{ id: string }>;
  now?: () => Date;
  env?: (key: string) => string | undefined;
  logger?: (code: string) => void;
};

const SIGNED_URL_SECONDS = 300;

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function errorJson(req: Request, message: string, status: number, code: string): Response {
  return json(req, { success: false, error: message, code }, status);
}

function vietnamDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function safeCode(error: unknown, fallback: string): string {
  const candidate = (error as { code?: unknown } | null)?.code;
  if (typeof candidate === "string" && /^[a-z0-9_]{1,80}$/i.test(candidate)) return candidate;
  return fallback;
}

function isDuplicatePhone(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code || "");
  const message = String((error as Error | null)?.message || "");
  return code === "23505" || message.includes("đang được dùng");
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function canManage(actor: DealerSignupReviewActor): boolean {
  return actor.isOwner || actor.crmEdit;
}

function canDownload(actor: DealerSignupReviewActor): boolean {
  return actor.isOwner || actor.crmView || actor.crmEdit || actor.accountingEdit;
}

function canUploadSignedContract(actor: DealerSignupReviewActor): boolean {
  return actor.isOwner || actor.crmEdit || actor.accountingEdit;
}

// Normalise a Postgres date to YYYY-MM-DD for the contract PDF.
function applicationCccdValidUntil(application: DealerSignupReviewApplication): string {
  return String(application.cccd_valid_until || "").slice(0, 10);
}

function contractDateFor(
  application: DealerSignupReviewApplication,
  now: Date,
): string {
  const base = application.reviewed_at ? new Date(application.reviewed_at) : now;
  return vietnamDate(Number.isFinite(base.getTime()) ? base : now);
}

function buildContractInput(
  application: DealerSignupReviewApplication,
  contractDate: string,
): DealerContractInput {
  return {
    application_code: application.application_code,
    contract_date: contractDate,
    applicant_name: application.applicant_name,
    business_name: application.business_name,
    cccd: application.cccd,
    cccd_valid_until: applicationCccdValidUntil(application),
    phone: application.phone,
    email: application.email,
    address_text: application.address_text,
  };
}

async function loadApplication(
  req: Request,
  deps: DealerSignupReviewDeps,
  rawId: unknown,
): Promise<DealerSignupReviewApplication | Response> {
  const id = String(rawId ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return errorJson(req, "Mã hồ sơ không hợp lệ.", 400, "invalid_application_id");
  }
  const application = await deps.store.getApplication(id);
  if (!application) {
    return errorJson(req, "Không tìm thấy hồ sơ đăng ký.", 404, "application_not_found");
  }
  return application;
}

function isApproved(application: DealerSignupReviewApplication): boolean {
  return application.status === "approved_waiting_slip" ||
    application.status === "active" ||
    Boolean(application.crm_customer_id);
}

export async function handleDealerSignupReview(
  req: Request,
  deps: DealerSignupReviewDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: getCorsHeaders(req) });
  }
  if (req.method !== "POST") {
    return errorJson(req, "Method not allowed", 405, "method_not_allowed");
  }

  const logger = deps.logger ?? ((code: string) => console.warn(`[dealer-signup-review] ${code}`));
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? ((key: string) => Deno.env.get(key));

  let actor: DealerSignupReviewActor;
  try {
    actor = await deps.authenticate(req);
  } catch (error) {
    if (error instanceof Response) return error;
    return errorJson(req, "Phiên đăng nhập không hợp lệ.", 401, "unauthorized");
  }
  if (!actor?.userId) {
    return errorJson(req, "Phiên đăng nhập không hợp lệ.", 401, "unauthorized");
  }

  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  let action = (url.searchParams.get("action") || "").trim();

  if (action === "upload_signed_contract") {
    if (!canUploadSignedContract(actor)) {
      return errorJson(req, "Bạn không có quyền tải hợp đồng đã đóng dấu.", 403, "forbidden");
    }
    try {
      return await handleUploadSignedContract(req, deps, actor, url, now, logger);
    } catch (error) {
      logger(`upload_signed_contract_failed:${safeCode(error, "upload_failed")}`);
      return errorJson(req, "Không upload được hợp đồng đã đóng dấu.", 500, safeCode(error, "upload_failed"));
    }
  }

  body = await readJson(req);
  action = action || String(body.action || "").trim();

  if (!action) {
    return errorJson(req, "Thiếu thao tác xử lý hồ sơ.", 400, "action_required");
  }

  if (action === "download") {
    if (!canDownload(actor)) {
      return errorJson(req, "Bạn không có quyền tải giấy tờ hồ sơ.", 403, "forbidden");
    }
    return await handleDownload(req, deps, body);
  }

  if (!canManage(actor)) {
    return errorJson(req, "Bạn không có quyền duyệt hồ sơ đại lý.", 403, "forbidden");
  }

  try {
    switch (action) {
      case "approve":
        return await handleApprove(req, deps, body, actor, now, env, logger);
      case "regenerate_contract":
        return await handleRegenerateContract(req, deps, body, now, logger);
      case "resend_slip_link":
        return await handleResendSlipLink(req, deps, body, now, env, logger);
      case "reject":
        return await handleReject(req, deps, body, actor, logger);
      default:
        return errorJson(req, "Thao tác không hợp lệ.", 400, "invalid_action");
    }
  } catch (error) {
    logger(`action_failed:${safeCode(error, "review_failed")}`);
    return errorJson(req, "Không xử lý được hồ sơ đại lý.", 500, safeCode(error, "review_failed"));
  }
}

async function handleApprove(
  req: Request,
  deps: DealerSignupReviewDeps,
  body: Record<string, unknown>,
  actor: DealerSignupReviewActor,
  now: () => Date,
  env: (key: string) => string | undefined,
  logger: (code: string) => void,
): Promise<Response> {
  const loaded = await loadApplication(req, deps, body.application_id ?? body.applicationId);
  if (loaded instanceof Response) return loaded;

  if (isApproved(loaded)) {
    return json(req, {
      success: true,
      already_approved: true,
      application_id: loaded.id,
      application_code: loaded.application_code,
      status: loaded.status,
      contract_ready: Boolean(loaded.contract_draft_path),
      email_sent: false,
      crm_customer_id: loaded.crm_customer_id,
    });
  }

  if (!["manual_review", "contract_sent", "email_failed"].includes(loaded.status)) {
    return errorJson(req, "Hồ sơ này không còn ở trạng thái có thể duyệt.", 409, "application_not_approvable");
  }

  const approvalTime = now();
  const slipToken = generateDealerSlipToken();
  const slipTokenHash = await hashDealerSlipToken(slipToken);
  const slipExpiresAt = dealerSlipTokenExpiresAt(approvalTime);

  let approval: DealerSignupApprovalResult;
  try {
    approval = await deps.store.approve({
      applicationId: loaded.id,
      reviewerId: actor.userId,
      mode: "manual",
      customerGroup: null,
      productGroup: null,
      slipTokenHash,
      slipExpiresAt,
    });
  } catch (error) {
    if (isDuplicatePhone(error)) {
      return errorJson(
        req,
        String((error as Error)?.message || "Số điện thoại đã thuộc khách hàng khác."),
        409,
        "duplicate_phone",
      );
    }
    logger(`approve_failed:${safeCode(error, "approve_failed")}`);
    return errorJson(req, "Không duyệt được hồ sơ đại lý.", 500, safeCode(error, "approve_failed"));
  }

  // A concurrent request already approved it; never create a second PDF/email.
  if (approval.already_approved) {
    return json(req, {
      success: true,
      already_approved: true,
      application_id: loaded.id,
      application_code: loaded.application_code,
      status: approval.status,
      contract_ready: Boolean(loaded.contract_draft_path),
      email_sent: false,
      crm_customer_id: approval.crm_customer_id,
    });
  }

  const pdfInput = buildContractInput(loaded, vietnamDate(approvalTime));
  let contractReady = false;
  let pdfError: string | null = null;
  try {
    const assets = await deps.loadContractAssets();
    const pdf = await deps.buildContractPdf(pdfInput, assets);
    const path = dealerContractDraftPath(loaded.id);
    await deps.uploadDocument(path, pdf, "application/pdf");
    await deps.store.setContractDraft(loaded.id, path);
    contractReady = true;
  } catch (error) {
    pdfError = safeCode(error, "contract_pdf_failed");
    await deps.store.setLastError(loaded.id, pdfError);
    logger(`contract_failed:${pdfError}`);
  }

  let emailSent = false;
  let emailError: string | null = null;
  try {
    const mail = buildDealerSignupApprovedEmail({
      applicantName: loaded.applicant_name,
      applicationCode: loaded.application_code,
      businessName: loaded.business_name,
      slipToken,
      publicBaseUrl: dealerSignupPublicBaseUrl(env),
    });
    await deps.sendEmail({ to: loaded.email, ...mail });
    emailSent = true;
  } catch (error) {
    emailError = safeCode(error, "email_send_failed");
    await deps.store.setLastError(loaded.id, emailError);
    logger(`email_failed:${emailError}`);
  }

  return json(req, {
    success: true,
    already_approved: false,
    application_id: loaded.id,
    application_code: loaded.application_code,
    status: "approved_waiting_slip",
    crm_customer_id: approval.crm_customer_id,
    dealer_onboarding_status: "waiting_slip",
    contract_ready: contractReady,
    email_sent: emailSent,
    slip_expires_at: slipExpiresAt,
    ...(pdfError ? { contract_error_code: pdfError } : {}),
    ...(emailError ? { email_error_code: emailError } : {}),
  });
}

async function handleRegenerateContract(
  req: Request,
  deps: DealerSignupReviewDeps,
  body: Record<string, unknown>,
  now: () => Date,
  _logger: (code: string) => void,
): Promise<Response> {
  const loaded = await loadApplication(req, deps, body.application_id ?? body.applicationId);
  if (loaded instanceof Response) return loaded;

  if (loaded.status !== "approved_waiting_slip" && loaded.status !== "active") {
    return errorJson(req, "Chỉ tạo lại hợp đồng cho hồ sơ đã duyệt.", 409, "application_not_approved");
  }

  const pdfInput = buildContractInput(loaded, contractDateFor(loaded, now()));
  try {
    const assets = await deps.loadContractAssets();
    const pdf = await deps.buildContractPdf(pdfInput, assets);
    const path = dealerContractDraftPath(loaded.id);
    await deps.uploadDocument(path, pdf, "application/pdf");
    await deps.store.setContractDraft(loaded.id, path);
    return json(req, {
      success: true,
      application_id: loaded.id,
      application_code: loaded.application_code,
      status: loaded.status,
      contract_ready: true,
      contract_draft_path: path,
    });
  } catch (error) {
    const code = safeCode(error, "contract_pdf_failed");
    await deps.store.setLastError(loaded.id, code);
    return errorJson(req, "Không tạo lại được hợp đồng.", 500, code);
  }
}

async function handleResendSlipLink(
  req: Request,
  deps: DealerSignupReviewDeps,
  body: Record<string, unknown>,
  now: () => Date,
  env: (key: string) => string | undefined,
  logger: (code: string) => void,
): Promise<Response> {
  const loaded = await loadApplication(req, deps, body.application_id ?? body.applicationId);
  if (loaded instanceof Response) return loaded;

  if (
    !loaded.crm_customer_id ||
    (loaded.status !== "approved_waiting_slip" && loaded.status !== "email_failed")
  ) {
    return errorJson(req, "Chỉ gửi lại link cho hồ sơ đang chờ bank slip.", 409, "application_not_waiting_slip");
  }

  const slipToken = generateDealerSlipToken();
  const slipTokenHash = await hashDealerSlipToken(slipToken);
  const slipExpiresAt = dealerSlipTokenExpiresAt(now());
  await deps.store.rotateSlipToken(loaded.id, slipTokenHash, slipExpiresAt);

  try {
    const mail = buildDealerSignupApprovedEmail({
      applicantName: loaded.applicant_name,
      applicationCode: loaded.application_code,
      businessName: loaded.business_name,
      slipToken,
      publicBaseUrl: dealerSignupPublicBaseUrl(env),
    });
    await deps.sendEmail({ to: loaded.email, ...mail });
    return json(req, {
      success: true,
      application_id: loaded.id,
      application_code: loaded.application_code,
      email_sent: true,
      slip_expires_at: slipExpiresAt,
    });
  } catch (error) {
    const code = safeCode(error, "email_send_failed");
    await deps.store.setLastError(loaded.id, code);
    logger(`resend_email_failed:${code}`);
    return json(req, {
      success: true,
      application_id: loaded.id,
      application_code: loaded.application_code,
      email_sent: false,
      email_error_code: code,
      slip_expires_at: slipExpiresAt,
    });
  }
}

async function handleReject(
  req: Request,
  deps: DealerSignupReviewDeps,
  body: Record<string, unknown>,
  actor: DealerSignupReviewActor,
  logger: (code: string) => void,
): Promise<Response> {
  const reason = String(body.reason ?? "").trim();
  if (!reason) {
    return errorJson(req, "Vui lòng nhập lý do từ chối.", 400, "reject_reason_required");
  }
  if (reason.length > 500) {
    return errorJson(req, "Lý do từ chối tối đa 500 ký tự.", 400, "reject_reason_too_long");
  }

  const loaded = await loadApplication(req, deps, body.application_id ?? body.applicationId);
  if (loaded instanceof Response) return loaded;

  if (!["manual_review", "contract_sent", "email_failed"].includes(loaded.status)) {
    return errorJson(req, "Chỉ từ chối được hồ sơ chưa duyệt.", 409, "application_not_rejectable");
  }

  try {
    await deps.store.reject(loaded.id, actor.userId, reason);
  } catch (error) {
    const code = safeCode(error, "reject_failed");
    logger(`reject_failed:${code}`);
    return errorJson(req, "Không từ chối được hồ sơ.", 500, code);
  }

  let emailSent = false;
  let emailError: string | null = null;
  try {
    const mail = buildDealerSignupRejectedEmail({
      applicantName: loaded.applicant_name,
      applicationCode: loaded.application_code,
      reason,
    });
    await deps.sendEmail({ to: loaded.email, ...mail });
    emailSent = true;
  } catch (error) {
    emailError = safeCode(error, "email_send_failed");
    await deps.store.setLastError(loaded.id, emailError);
    logger(`reject_email_failed:${emailError}`);
  }

  return json(req, {
    success: true,
    application_id: loaded.id,
    application_code: loaded.application_code,
    status: "rejected_manual",
    reject_reason: reason,
    email_sent: emailSent,
    ...(emailError ? { email_error_code: emailError } : {}),
  });
}

async function handleDownload(
  req: Request,
  deps: DealerSignupReviewDeps,
  body: Record<string, unknown>,
): Promise<Response> {
  const kind = String(body.kind ?? "").trim();
  if (!["contract_draft", "contract_signed", "slip"].includes(kind)) {
    return errorJson(req, "Loại giấy tờ không hợp lệ.", 400, "invalid_document_kind");
  }

  const loaded = await loadApplication(req, deps, body.application_id ?? body.applicationId);
  if (loaded instanceof Response) return loaded;

  const path = kind === "contract_draft"
    ? loaded.contract_draft_path
    : kind === "contract_signed"
    ? loaded.contract_signed_path
    : loaded.slip_storage_path;

  if (!path) {
    return errorJson(req, "Hồ sơ chưa có giấy tờ này.", 404, "document_missing");
  }

  const url = await deps.createSignedUrl(path, SIGNED_URL_SECONDS);
  return json(req, {
    success: true,
    application_id: loaded.id,
    application_code: loaded.application_code,
    kind,
    url,
    expires_in: SIGNED_URL_SECONDS,
  });
}

async function handleUploadSignedContract(
  req: Request,
  deps: DealerSignupReviewDeps,
  actor: DealerSignupReviewActor,
  url: URL,
  now: () => Date,
  logger: (code: string) => void,
): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return errorJson(req, "Dữ liệu upload không hợp lệ.", 400, "invalid_multipart_body");
  }

  const applicationId = String(
    form.get("application_id") ?? form.get("applicationId") ?? url.searchParams.get("application_id") ?? "",
  ).trim();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return errorJson(req, "Vui lòng chọn hợp đồng đã đóng dấu.", 400, "file_required");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const validation = validateDealerSignupDocument({ kind: "signed_contract", bytes });
  if (!validation.ok) {
    return errorJson(req, validation.error, 400, validation.code);
  }

  const loaded = await loadApplication(req, deps, applicationId);
  if (loaded instanceof Response) return loaded;
  if (loaded.status !== "approved_waiting_slip" && loaded.status !== "active") {
    return errorJson(req, "Chỉ upload hợp đồng cho hồ sơ đã duyệt.", 409, "application_not_approved");
  }

  const path = dealerSignedContractPath(loaded.id, documentTimestamp(now()), validation.extension);
  try {
    await deps.uploadDocument(path, bytes, validation.mimeType);
    await deps.store.setSignedContract(loaded.id, path, actor.userId);
  } catch (error) {
    logger(`signed_contract_upload_failed:${safeCode(error, "upload_failed")}`);
    return errorJson(req, "Không lưu được hợp đồng đã đóng dấu.", 500, safeCode(error, "upload_failed"));
  }

  return json(req, {
    success: true,
    application_id: loaded.id,
    application_code: loaded.application_code,
    kind: "contract_signed",
    path,
    uploaded_at: now().toISOString(),
  });
}
