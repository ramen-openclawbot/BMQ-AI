/**
 * Public bank-slip page API for newly approved dealers.
 *
 * Authentication is either the one-time token from the approved email or a
 * valid dealer session whose customer owns the waiting application. Tokens and
 * dealer session tokens are never logged or echoed back.
 */
import type { GmailAttachment } from "../_shared/gmail-send.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import {
  buildDealerSignupSlipBmqEmail,
  dealerSlipPath,
  documentTimestamp,
  hashDealerSlipToken,
  isDealerSlipTokenShape,
  validateDealerSignupDocument,
} from "../_shared/dealer-signup-review.ts";
import {
  buildDealerPaymentInfo,
  type DealerSignupPaymentInfo,
  type DealerSignupPaymentSettings,
} from "../_shared/dealer-signup-payment.ts";

export const DEALER_SIGNUP_SLIP_LIMIT_PER_HOUR = 10;

export type DealerSignupSlipApplication = {
  id: string;
  application_code: string;
  business_name: string;
  applicant_name: string;
  email: string;
  phone: string;
  status: string;
  slip_token_expires_at: string | null;
  crm_customer_id: string | null;
};

export type DealerSignupSlipStore = {
  findByTokenHash(hash: string): Promise<DealerSignupSlipApplication | null>;
  findWaitingByCustomerId(customerId: string): Promise<DealerSignupSlipApplication | null>;
  checkRateLimit(
    ipHash: string,
    action: "slip",
    limit: number,
  ): Promise<{ allowed: boolean; remaining: number; retry_after_seconds: number }>;
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  activate(
    applicationId: string,
    path: string,
  ): Promise<{ already_active: boolean; already_submitted?: boolean; status?: string }>;
  setLastError(applicationId: string, code: string): Promise<void>;
};

export type DealerSignupSlipEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: GmailAttachment[];
};

export type DealerSignupSlipSession = {
  customer: { id: string };
};

export type DealerSignupSlipDeps = {
  store: DealerSignupSlipStore;
  resolveDealerSession: (token: string) => Promise<DealerSignupSlipSession | null>;
  sendEmail?: (email: DealerSignupSlipEmail) => Promise<{ id: string }>;
  loadPaymentSettings?: () => Promise<DealerSignupPaymentSettings | null>;
  env?: (key: string) => string | undefined;
  now?: () => Date;
  logger?: (code: string) => void;
};

export type SlipStatus = "valid" | "slip_submitted" | "expired" | "used" | "invalid";

const encoder = new TextEncoder();

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

export function getClientIp(req: Request): string {
  const forwarded = (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim();
  return forwarded ||
    req.headers.get("cf-connecting-ip")?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    "unknown";
}

export async function hashClientIp(ip: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${salt}:${ip}`));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeCode(error: unknown, fallback: string): string {
  const candidate = (error as { code?: unknown } | null)?.code;
  if (typeof candidate === "string" && /^[a-z0-9_]{1,80}$/i.test(candidate)) return candidate;
  return fallback;
}

export function resolveSlipStatus(
  application: DealerSignupSlipApplication | null,
  now: Date,
): SlipStatus {
  if (!application) return "invalid";
  if (application.status === "active") return "used";
  if (application.status === "slip_submitted") return "slip_submitted";
  if (application.status !== "approved_waiting_slip") return "invalid";
  if (
    application.slip_token_expires_at &&
    new Date(application.slip_token_expires_at).getTime() < now.getTime()
  ) {
    return "expired";
  }
  return "valid";
}

async function paymentInfoFor(
  deps: DealerSignupSlipDeps,
  applicationCode: string,
  logger: (code: string) => void,
): Promise<DealerSignupPaymentInfo | null> {
  if (!deps.loadPaymentSettings) return null;
  try {
    return buildDealerPaymentInfo(await deps.loadPaymentSettings(), applicationCode);
  } catch (error) {
    logger(`payment_settings_read_failed:${safeCode(error, "payment_settings_read_failed")}`);
    return null;
  }
}

async function handleStatus(
  req: Request,
  deps: DealerSignupSlipDeps,
): Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? ((code: string) => console.warn(`[dealer-signup-slip] ${code}`));
  const token = new URL(req.url).searchParams.get("token") || "";
  if (!isDealerSlipTokenShape(token)) {
    return json(req, { success: false, status: "invalid", payment_info: null });
  }

  const hash = await hashDealerSlipToken(token);
  const application = await deps.store.findByTokenHash(hash);
  const status = resolveSlipStatus(application, now());

  if (!application || status === "invalid") {
    return json(req, { success: false, status: "invalid", payment_info: null });
  }

  const paymentInfo = await paymentInfoFor(deps, application.application_code, logger);

  return json(req, {
    success: status === "valid" || status === "slip_submitted",
    status,
    application_code: application.application_code,
    business_name: application.business_name,
    can_upload: status === "valid",
    payment_info: paymentInfo,
  });
}

async function handleUpload(
  req: Request,
  deps: DealerSignupSlipDeps,
): Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? ((key: string) => Deno.env.get(key));
  const logger = deps.logger ?? ((code: string) => console.warn(`[dealer-signup-slip] ${code}`));

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return errorJson(req, "Dữ liệu upload không hợp lệ.", 400, "invalid_multipart_body");
  }

  const url = new URL(req.url);
  const token = String(url.searchParams.get("token") || form.get("token") || "").trim();
  const dealerToken = String(
    req.headers.get("x-dealer-session") ||
      form.get("dealer_token") ||
      form.get("session_token") ||
      "",
  ).trim();

  if (!token && !dealerToken) {
    return errorJson(req, "Vui lòng dùng link bank slip hoặc đăng nhập đại lý.", 401, "dealer_auth_required");
  }

  const salt = env("DEALER_SIGNUP_IP_SALT") || env("SUPABASE_SERVICE_ROLE_KEY") || "dealer-signup-local";
  const ipHash = await hashClientIp(getClientIp(req), salt);
  let rateLimit;
  try {
    rateLimit = await deps.store.checkRateLimit(ipHash, "slip", DEALER_SIGNUP_SLIP_LIMIT_PER_HOUR);
  } catch {
    logger("rate_limit_unavailable");
    return errorJson(req, "Tạm thời chưa nhận được bank slip. Vui lòng thử lại.", 503, "rate_limit_unavailable");
  }
  if (!rateLimit.allowed) {
    const response = errorJson(req, "Bạn đã upload quá nhiều lần. Vui lòng thử lại sau.", 429, "rate_limited");
    response.headers.set("Retry-After", String(Math.max(1, rateLimit.retry_after_seconds)));
    return response;
  }

  let application: DealerSignupSlipApplication | null = null;

  if (token) {
    if (!isDealerSlipTokenShape(token)) {
      return errorJson(req, "Link bank slip không hợp lệ.", 404, "slip_token_invalid");
    }
    const hash = await hashDealerSlipToken(token);
    application = await deps.store.findByTokenHash(hash);
    const status = resolveSlipStatus(application, now());
    if (status === "used") {
      return errorJson(req, "Link bank slip đã được sử dụng.", 409, "slip_token_used");
    }
    if (status === "expired") {
      return errorJson(req, "Link bank slip đã hết hạn. Vui lòng liên hệ BMQ để gửi lại.", 410, "slip_token_expired");
    }
    if (status === "slip_submitted") {
      return errorJson(
        req,
        "Bank slip đã được gửi và đang chờ kế toán xác nhận tiền.",
        409,
        "slip_already_submitted",
      );
    }
    if (status === "invalid") {
      return errorJson(req, "Link bank slip không hợp lệ.", 404, "slip_token_invalid");
    }
  } else {
    const session = await deps.resolveDealerSession(dealerToken);
    if (!session?.customer?.id) {
      return errorJson(req, "Phiên đại lý không hợp lệ. Vui lòng đăng nhập lại.", 401, "dealer_session_invalid");
    }
    application = await deps.store.findWaitingByCustomerId(session.customer.id);
    if (!application) {
      return errorJson(
        req,
        "Tài khoản này không có hồ sơ đang chờ bank slip.",
        403,
        "dealer_not_waiting_slip",
      );
    }
  }

  if (!application) {
    return errorJson(req, "Link bank slip không hợp lệ.", 404, "slip_token_invalid");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return errorJson(req, "Vui lòng chọn ảnh hoặc PDF bank slip.", 400, "file_required");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const validation = validateDealerSignupDocument({ kind: "bank_slip", bytes });
  if (!validation.ok) {
    return errorJson(req, validation.error, 400, validation.code);
  }

  const path = dealerSlipPath(application.id, documentTimestamp(now()), validation.extension);
  try {
    await deps.store.upload(path, bytes, validation.mimeType);
  } catch (error) {
    logger(`slip_upload_failed:${safeCode(error, "upload_failed")}`);
    return errorJson(req, "Không lưu được bank slip. Vui lòng thử lại.", 500, "upload_failed");
  }

  let activation: { already_active: boolean; already_submitted?: boolean; status?: string };
  try {
    activation = await deps.store.activate(application.id, path);
  } catch (error) {
    logger(`slip_activate_failed:${safeCode(error, "activate_failed")}`);
    return errorJson(req, "Không lưu được bank slip để chờ xác nhận.", 500, "activate_failed");
  }

  let emailSent = false;
  const bmqEmail = String(env("DEALER_SIGNUP_BMQ_EMAIL") || "").trim();
  if (!activation.already_active && !activation.already_submitted && bmqEmail && deps.sendEmail) {
    try {
      const mail = buildDealerSignupSlipBmqEmail({
        applicantName: application.applicant_name,
        businessName: application.business_name,
        applicationCode: application.application_code,
        phone: application.phone,
      });
      await deps.sendEmail({ to: bmqEmail, ...mail });
      emailSent = true;
    } catch (error) {
      const code = safeCode(error, "email_send_failed");
      logger(`bmq_email_failed:${code}`);
      try {
        await deps.store.setLastError(application.id, code);
      } catch {
        // The activation already succeeded; never fail the upload for a log write.
      }
    }
  }

  return json(req, {
    success: true,
    status: activation.status ?? "slip_submitted",
    already_active: activation.already_active,
    already_submitted: activation.already_submitted === true,
    application_code: application.application_code,
    business_name: application.business_name,
    email_sent: emailSent,
  });
}

export async function handleDealerSignupSlip(
  req: Request,
  deps: DealerSignupSlipDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: getCorsHeaders(req) });
  }

  if (req.method === "GET") {
    try {
      return await handleStatus(req, deps);
    } catch (error) {
      const logger = deps.logger ?? ((code: string) => console.warn(`[dealer-signup-slip] ${code}`));
      logger(`status_failed:${safeCode(error, "status_failed")}`);
      return errorJson(req, "Không kiểm tra được link bank slip.", 500, "slip_status_failed");
    }
  }

  if (req.method !== "POST") {
    return errorJson(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    return await handleUpload(req, deps);
  } catch (error) {
    const logger = deps.logger ?? ((code: string) => console.warn(`[dealer-signup-slip] ${code}`));
    logger(`upload_failed:${safeCode(error, "upload_failed")}`);
    return errorJson(req, "Không upload được bank slip.", 500, "slip_upload_failed");
  }
}
