import type { GmailAttachment } from "../_shared/gmail-send.ts";
import {
  DEALER_SIGNUP_SUBMIT_LIMIT_PER_HOUR,
  dealerSignupError,
  dealerSignupJson,
  dealerSignupPreflight,
  escapeHtml,
  generateApplicationCode,
  getClientIp,
  hashClientIp,
  isIdempotencyKey,
  isIsoDate,
  isWithinVietnam,
  normalizeCccd,
  normalizeEmail,
  normalizeVietnamPhone,
  parseFiniteNumber,
  readDealerSignupBody,
  safeErrorCode,
  vietnamDate,
  type DealerSignupApplication,
  type DealerSignupStore,
  type NewDealerSignupApplication,
} from "../_shared/dealer-signup-http.ts";
import {
  evaluateDealerRouteEligibility,
  type Fetcher,
} from "../_shared/dealer-signup-distance.ts";
import {
  buildDealerSignupContractPdf,
  contractTerm,
  formatContractDate,
  loadDefaultContractFonts,
  type DealerContractInput,
  type DealerContractPdfAssets,
} from "../_shared/dealer-signup-contract.ts";
import {
  buildDealerContractEmailInsert,
  dealerContractDraftPath,
  dealerSignupPublicBaseUrl,
  dealerSlipTokenExpiresAt,
  generateDealerSlipToken,
  hashDealerSlipToken,
  isDealerSlipTokenShape,
  normalizeDealerVerificationEmail,
  type DealerSignupApprovalResult,
} from "../_shared/dealer-signup-review.ts";

export type DealerSignupEmail = {
  to: string;
  cc?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: GmailAttachment[];
};

const REVIEW_REASON_LABELS: Record<string, string> = {
  distance_near_threshold: "Quãng đường tới đại lý gần nhất sát ngưỡng 2 km",
  dealer_location_missing: "Có đại lý chưa có vị trí trên hệ thống",
  dealer_route_missing: "Bản đồ không tìm được đường tới một đại lý gần",
};

/** Owner-readable reason, keeping the stable code for searching. */
function reviewReasonLabel(code: string | null): string {
  const key = code || "manual_review";
  const label = REVIEW_REASON_LABELS[key] ?? (key.startsWith("osrm_") ? "Dịch vụ bản đồ tạm lỗi khi đo quãng đường" : "Cần kiểm tra thêm");
  return `${label} (${key})`;
}

export type DealerSignupSubmitDeps = {
  store: DealerSignupStore;
  evaluateRouteEligibility?: typeof evaluateDealerRouteEligibility;
  buildContractPdf?: (
    input: DealerContractInput,
    assets?: DealerContractPdfAssets,
  ) => Promise<Uint8Array>;
  loadContractAssets?: () => Promise<DealerContractPdfAssets>;
  sendEmail?: (email: DealerSignupEmail) => Promise<{ id: string }>;
  /** Creates the CRM customer exactly once; returns an existing result on retry. */
  approveSignup?: (input: {
    applicationId: string;
    mode: "auto" | "manual";
    reviewerId: string | null;
    customerGroup: string | null;
    productGroup: string | null;
    slipTokenHash: string;
    slipExpiresAt: string;
  }) => Promise<DealerSignupApprovalResult>;
  /** Stores the generated PDF; returns its bucket path. */
  uploadContractDraft?: (applicationId: string, pdf: Uint8Array) => Promise<string>;
  setContractDraft?: (applicationId: string, path: string) => Promise<void>;
  /** Atomically consumes the one-time phone+email verification token. */
  consumeVerificationToken?: (input: {
    tokenHash: string;
    phoneNormalized: string;
    emailNormalized: string;
  }) => Promise<{ phone_verified_at: string | null; email_verified_at: string | null } | null>;
  fetcher?: Fetcher;
  env?: (key: string) => string | undefined;
  now?: () => Date;
  logger?: (code: string) => void;
};

type DealerSignupApplicationWithVerification = NewDealerSignupApplication & {
  phone_verified_at: string | null;
  email_verified_at: string | null;
};

type ValidatedSignup = {
  applicantName: string;
  businessName: string;
  cccd: string;
  cccdValidUntil: string;
  phone: string;
  email: string;
  addressText: string;
  lat: number;
  lng: number;
  idempotencyKey: string;
};

type ValidationFailure = { ok: false; error: string; code: string };
type ValidationSuccess = { ok: true; value: ValidatedSignup };

const asTrimmed = (value: unknown): string => String(value ?? "").trim();

/** The signup form stores 0xxxxxxxxx; verification tokens use 84xxxxxxxxx. */
function toDealerPhone84(localPhone: string): string {
  return localPhone.startsWith("0") ? `84${localPhone.slice(1)}` : localPhone;
}

function validateSignup(body: Record<string, unknown>): ValidationSuccess | ValidationFailure {
  const applicantName = asTrimmed(body.applicant_name ?? body.full_name);
  if (applicantName.length < 2 || applicantName.length > 200) {
    return { ok: false, error: "Vui lòng nhập họ tên người đại diện.", code: "invalid_applicant_name" };
  }

  const businessName = asTrimmed(body.business_name);
  if (businessName.length < 2 || businessName.length > 200) {
    return { ok: false, error: "Vui lòng nhập tên hộ kinh doanh/đại lý.", code: "invalid_business_name" };
  }

  const cccd = normalizeCccd(body.cccd);
  if (!cccd) {
    return { ok: false, error: "CCCD phải gồm 9 hoặc 12 chữ số.", code: "invalid_cccd" };
  }

  const cccdValidUntil = asTrimmed(body.cccd_valid_until);
  if (!isIsoDate(cccdValidUntil)) {
    return { ok: false, error: "Ngày hết hạn CCCD không hợp lệ.", code: "invalid_cccd_valid_until" };
  }

  const phone = normalizeVietnamPhone(body.phone);
  if (!phone) {
    return { ok: false, error: "Số điện thoại không hợp lệ.", code: "invalid_phone" };
  }

  const email = normalizeEmail(body.email);
  if (!email) {
    return { ok: false, error: "Email không hợp lệ.", code: "invalid_email" };
  }

  const addressText = asTrimmed(body.address_text);
  if (addressText.length < 5 || addressText.length > 500) {
    return { ok: false, error: "Địa chỉ không hợp lệ.", code: "invalid_address" };
  }

  const lat = parseFiniteNumber(body.lat);
  const lng = parseFiniteNumber(body.lng);
  if (lat === null || lng === null || !isWithinVietnam(lat, lng)) {
    return { ok: false, error: "Tọa độ không nằm trong phạm vi Việt Nam.", code: "invalid_coordinates" };
  }

  const accepted = body.terms_accepted === true ||
    body.agree_terms === true ||
    body.terms_agreed === true ||
    body.accepted_terms === true;
  if (!accepted) {
    return { ok: false, error: "Vui lòng đồng ý điều khoản hợp đồng.", code: "terms_required" };
  }

  const idempotencyKey = asTrimmed(body.idempotency_key ?? body.idempotencyKey);
  if (!isIdempotencyKey(idempotencyKey)) {
    return { ok: false, error: "Mã chống gửi trùng không hợp lệ.", code: "invalid_idempotency_key" };
  }

  return {
    ok: true,
    value: {
      applicantName,
      businessName,
      cccd,
      cccdValidUntil,
      phone,
      email,
      addressText,
      lat,
      lng,
      idempotencyKey,
    },
  };
}

function cachedResponse(application: DealerSignupApplication): Record<string, unknown> {
  const status = String(application.status);
  const result = status === "rejected_too_close"
    ? "too_close"
    : status === "manual_review" || status === "rejected_manual" || status === "email_failed"
    ? "manual_review"
    : "eligible";

  return {
    success: true,
    result,
    status: application.status,
    application_code: application.application_code,
    nearest_distance_m: application.nearest_distance_m,
    email_message_id: application.email_message_id,
    ...(status === "approved_waiting_slip" || status === "active"
      ? { dealer_onboarding_status: status === "active" ? "active" : "waiting_slip" }
      : {}),
  };
}

function emailHtml(title: string, paragraphs: string[], details: Array<[string, string]>): string {
  const rows = details
    .map(([label, value]) => `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;vertical-align:top">${escapeHtml(label)}</td><td style="padding:4px 0;color:#111827">${escapeHtml(value)}</td></tr>`)
    .join("");
  return `<!doctype html><html><body style="margin:0;background:#f6f7f8;font-family:Arial,Helvetica,sans-serif;color:#111827">
  <div style="max-width:640px;margin:0 auto;padding:24px;background:#ffffff">
    <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>
    ${paragraphs.map((paragraph) => `<p style="line-height:1.55;margin:0 0 12px">${escapeHtml(paragraph)}</p>`).join("")}
    ${rows ? `<table style="border-collapse:collapse;margin:16px 0;font-size:14px">${rows}</table>` : ""}
    <p style="line-height:1.55;margin:24px 0 0">Trân trọng,<br/>BMQ</p>
  </div>
</body></html>`;
}

function emailText(title: string, paragraphs: string[], details: Array<[string, string]>): string {
  return [
    title,
    "",
    ...paragraphs.flatMap((paragraph) => [paragraph, ""]),
    ...details.map(([label, value]) => `${label}: ${value}`),
    "",
    "Trân trọng,",
    "BMQ",
  ].join("\n");
}

export async function handleDealerSignupSubmit(
  req: Request,
  deps: DealerSignupSubmitDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return dealerSignupPreflight(req);
  if (req.method !== "POST") {
    return dealerSignupError(req, "Method not allowed", 405, "method_not_allowed");
  }

  const env = deps.env ?? ((key: string) => Deno.env.get(key));
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? ((code: string) => console.warn(`[dealer-signup-submit] ${code}`));
  const evaluateRoute = deps.evaluateRouteEligibility ?? evaluateDealerRouteEligibility;
  const buildPdf = deps.buildContractPdf ?? buildDealerSignupContractPdf;

  try {
    const body = await readDealerSignupBody<Record<string, unknown>>(req);
    const validation = validateSignup(body);
    if (!validation.ok) {
      return dealerSignupError(req, validation.error, 400, validation.code);
    }
    const input = validation.value;

    // A retried key always wins over the rate limit and never sends again.
    // This also lets a retry succeed after the verification token was consumed.
    const existing = await deps.store.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return dealerSignupJson(req, cachedResponse(existing));

    const verificationToken = asTrimmed(body.verification_token ?? body.verificationToken);
    if (!isDealerSlipTokenShape(verificationToken)) {
      return dealerSignupError(
        req,
        "Vui lòng xác minh số điện thoại và email trước khi gửi hồ sơ.",
        400,
        "verification_required",
      );
    }
    const verificationTokenHash = await hashDealerSlipToken(verificationToken);
    const phoneNormalized = toDealerPhone84(input.phone);
    const emailNormalized = normalizeDealerVerificationEmail(input.email);
    if (!emailNormalized) {
      return dealerSignupError(req, "Email không hợp lệ.", 400, "invalid_email");
    }

    const salt = env("DEALER_SIGNUP_IP_SALT") || env("SUPABASE_SERVICE_ROLE_KEY") || "dealer-signup-local";
    const ipHash = await hashClientIp(getClientIp(req), salt);

    let rateLimit;
    try {
      rateLimit = await deps.store.checkRateLimit(ipHash, "submit", DEALER_SIGNUP_SUBMIT_LIMIT_PER_HOUR);
    } catch {
      logger("rate_limit_unavailable");
      return dealerSignupError(req, "Tạm thời chưa nhận được hồ sơ. Vui lòng thử lại.", 503, "rate_limit_unavailable");
    }
    if (!rateLimit.allowed) {
      const response = dealerSignupError(req, "Bạn đã gửi hồ sơ quá nhiều lần. Vui lòng thử lại sau.", 429, "rate_limited");
      response.headers.set("Retry-After", String(Math.max(1, rateLimit.retry_after_seconds)));
      return response;
    }

    const dealers = await deps.store.loadActiveDealers();
    const decision = await evaluateRoute({
      origin: { lat: input.lat, lng: input.lng },
      dealers,
      fetcher: deps.fetcher,
    });

    let verification: { phone_verified_at: string | null; email_verified_at: string | null } | null;
    try {
      verification = deps.consumeVerificationToken
        ? await deps.consumeVerificationToken({
          tokenHash: verificationTokenHash,
          phoneNormalized,
          emailNormalized,
        })
        : null;
    } catch (error) {
      logger(`verification_consume_failed:${safeErrorCode(error, "verification_invalid")}`);
      verification = null;
    }
    if (!verification) {
      return dealerSignupError(
        req,
        "Mã xác minh không hợp lệ, đã hết hạn hoặc đã được sử dụng. Vui lòng xác minh lại.",
        400,
        "verification_invalid",
      );
    }

    const contractDate = vietnamDate(now());
    const baseRow: Omit<
      DealerSignupApplicationWithVerification,
      "application_code" | "status"
    > = {
      applicant_name: input.applicantName,
      cccd: input.cccd,
      cccd_valid_until: input.cccdValidUntil,
      phone: input.phone,
      email: input.email,
      business_name: input.businessName,
      address_text: input.addressText,
      lat: input.lat,
      lng: input.lng,
      nearest_dealer_customer_id: decision.nearest_dealer_customer_id,
      nearest_distance_m: decision.nearest_distance_m,
      distance_provider: decision.distance_provider,
      unlocated_dealer_count: decision.unlocated_dealer_count,
      idempotency_key: input.idempotencyKey,
      client_ip_hash: ipHash,
      contract_sent_at: null,
      email_message_id: null,
      last_error_code: null,
      phone_verified_at: verification.phone_verified_at,
      email_verified_at: verification.email_verified_at,
    };

    let inserted: DealerSignupApplication | null = null;
    const initialStatus = decision.result === "too_close"
      ? "rejected_too_close"
      : decision.result === "manual_review"
      ? "manual_review"
      : "email_failed";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const applicationCode = generateApplicationCode(now());
      try {
        inserted = await deps.store.insert({
          ...baseRow,
          application_code: applicationCode,
          status: initialStatus,
          // For an eligible application this is a durable in-progress marker.
          // If the process dies after sending, a retry cannot send a second copy.
          last_error_code: decision.result === "eligible" ? "email_send_in_progress" : null,
        });
        break;
      } catch (error) {
        if (safeErrorCode(error) === "23505") {
          const duplicate = await deps.store.findByIdempotencyKey(input.idempotencyKey);
          if (duplicate) return dealerSignupJson(req, cachedResponse(duplicate));
          if (attempt < 2) continue;
        }
        throw error;
      }
    }

    if (!inserted) throw new Error("application_insert_failed");

    if (decision.result === "too_close") {
      return dealerSignupJson(req, {
        success: true,
        result: "too_close",
        status: inserted.status,
        application_code: inserted.application_code,
        nearest_distance_m: decision.nearest_distance_m,
      });
    }

    const bmqEmail = normalizeEmail(env("DEALER_SIGNUP_BMQ_EMAIL"));
    if (!bmqEmail) {
      await deps.store.update(inserted.id, {
        status: "email_failed",
        last_error_code: "bmq_email_not_configured",
      });
      logger("bmq_email_not_configured");
      return dealerSignupError(req, "Chưa cấu hình email nhận hồ sơ BMQ.", 503, "bmq_email_not_configured");
    }

    if (decision.result === "manual_review") {
      const details: Array<[string, string]> = [
        ["Mã hồ sơ", inserted.application_code],
        ["Họ tên", input.applicantName],
        ["Hộ kinh doanh", input.businessName],
        ["CCCD", input.cccd],
        ["Ngày hết hạn CCCD", formatContractDate(input.cccdValidUntil)],
        ["Điện thoại", input.phone],
        ["Email", input.email],
        ["Địa chỉ", input.addressText],
        ["Lý do xét tay", reviewReasonLabel(decision.reason_code)],
        ["Đại lý thiếu vị trí", String(decision.unlocated_dealer_count)],
      ];

      const bmqMail: DealerSignupEmail = {
        to: bmqEmail,
        subject: `[Đăng ký đại lý] Cần xét tay – ${inserted.application_code}`,
        text: emailText(
          "Hồ sơ đăng ký đại lý cần xét tay",
          ["Hồ sơ mới cần BMQ kiểm tra vị trí và liên hệ khách.", "Khách đã được thông báo BMQ sẽ liên hệ."],
          details,
        ),
        html: emailHtml(
          "Hồ sơ đăng ký đại lý cần xét tay",
          ["Hồ sơ mới cần BMQ kiểm tra vị trí và liên hệ khách.", "Khách đã được thông báo BMQ sẽ liên hệ."],
          details,
        ),
      };

      const customerMail: DealerSignupEmail = {
        to: input.email,
        subject: `BMQ đã nhận hồ sơ đăng ký đại lý – ${inserted.application_code}`,
        text: emailText(
          "BMQ đã nhận hồ sơ đăng ký đại lý",
          [
            `Kính gửi ${input.applicantName},`,
            "BMQ đã nhận được hồ sơ đăng ký đại lý của anh/chị.",
            "BMQ sẽ liên hệ với anh/chị để kiểm tra thông tin và hướng dẫn bước tiếp theo.",
            "Hồ sơ chưa được xác nhận tự động và chưa có hợp đồng đính kèm trong email này.",
          ],
          [["Mã hồ sơ", inserted.application_code]],
        ),
        html: emailHtml(
          "BMQ đã nhận hồ sơ đăng ký đại lý",
          [
            `Kính gửi ${input.applicantName},`,
            "BMQ đã nhận được hồ sơ đăng ký đại lý của anh/chị.",
            "BMQ sẽ liên hệ với anh/chị để kiểm tra thông tin và hướng dẫn bước tiếp theo.",
            "Hồ sơ chưa được xác nhận tự động và chưa có hợp đồng đính kèm trong email này.",
          ],
          [["Mã hồ sơ", inserted.application_code]],
        ),
      };

      try {
        const bmqSent = await requireEmailSender(deps)(bmqMail);
        await requireEmailSender(deps)(customerMail);
        await deps.store.update(inserted.id, {
          status: "manual_review",
          email_message_id: bmqSent.id,
          last_error_code: null,
        });
      } catch (error) {
        const code = safeErrorCode(error, "email_send_failed");
        await deps.store.update(inserted.id, {
          status: "email_failed",
          last_error_code: code,
        });
        logger(`email_failed:${code}`);
        return dealerSignupError(req, "Chưa gửi được email xác nhận. Vui lòng thử lại sau.", 502, code);
      }

      return dealerSignupJson(req, {
        success: true,
        result: "manual_review",
        status: "manual_review",
        application_code: inserted.application_code,
        nearest_distance_m: decision.nearest_distance_m,
      });
    }

    // Eligible: build the contract, send one copy to the customer with BMQ in
    // cc, then persist the successful message id.
    const contractInput: DealerContractInput = {
      application_code: inserted.application_code,
      contract_date: contractDate,
      applicant_name: input.applicantName,
      business_name: input.businessName,
      cccd: input.cccd,
      cccd_valid_until: input.cccdValidUntil,
      phone: input.phone,
      email: input.email,
      address_text: input.addressText,
    };

    let pdf: Uint8Array;
    try {
      const assets = deps.loadContractAssets ? await deps.loadContractAssets() : await loadDefaultContractFonts();
      pdf = await buildPdf(contractInput, assets);
    } catch (error) {
      const code = safeErrorCode(error, "contract_pdf_failed");
      await deps.store.update(inserted.id, {
        status: "email_failed",
        last_error_code: code,
      });
      logger(`contract_pdf_failed:${code}`);
      return dealerSignupError(req, "Chưa tạo được hợp đồng. Vui lòng thử lại sau.", 500, code);
    }

    const term = contractTerm(contractDate);
    const attachmentName = `HopDong-BMQ-${inserted.application_code}.pdf`;

    // New dealer onboarding: approve first (creates exactly one waiting_slip
    // CRM customer), then store the same PDF and email one contract containing
    // the bank-slip link. A failed approval falls back to manual review and
    // never sends the contract.
    const slipToken = generateDealerSlipToken();
    const slipTokenHash = await hashDealerSlipToken(slipToken);
    const slipExpiresAt = dealerSlipTokenExpiresAt(now());
    const publicBaseUrl = dealerSignupPublicBaseUrl(env);

    let approved: DealerSignupApprovalResult;
    try {
      if (!deps.approveSignup) throw new Error("approval_not_configured");
      approved = await deps.approveSignup({
        applicationId: inserted.id,
        mode: "auto",
        reviewerId: null,
        customerGroup: null,
        productGroup: null,
        slipTokenHash,
        slipExpiresAt,
      });
    } catch (error) {
      const rawCode = safeErrorCode(error, "approval_failed");
      const message = String((error as Error)?.message || "");
      const duplicatePhone = rawCode === "23505" || message.includes("đang được dùng");
      const code = duplicatePhone ? "duplicate_phone" : rawCode;
      await deps.store.update(inserted.id, {
        status: "manual_review",
        last_error_code: code,
      });
      logger(`approval_failed:${code}`);

      const reasonLabel = duplicatePhone
        ? "Số điện thoại đã thuộc khách hàng khác — cần xét tay và xử lý số điện thoại"
        : reviewReasonLabel(code);
      const details: Array<[string, string]> = [
        ["Mã hồ sơ", inserted.application_code],
        ["Họ tên", input.applicantName],
        ["Hộ kinh doanh", input.businessName],
        ["CCCD", input.cccd],
        ["Ngày hết hạn CCCD", formatContractDate(input.cccdValidUntil)],
        ["Điện thoại", input.phone],
        ["Email", input.email],
        ["Địa chỉ", input.addressText],
        ["Lý do xét tay", reasonLabel],
      ];

      const bmqMail: DealerSignupEmail = {
        to: bmqEmail,
        subject: `[Đăng ký đại lý] Cần xét tay – ${inserted.application_code}`,
        text: emailText(
          "Hồ sơ đăng ký đại lý cần xét tay",
          [
            "Hồ sơ đủ điều kiện nhưng chưa thể duyệt tự động. BMQ vui lòng kiểm tra và duyệt tay.",
            "Khách chưa nhận hợp đồng và chưa được tạo tài khoản đại lý.",
          ],
          details,
        ),
        html: emailHtml(
          "Hồ sơ đăng ký đại lý cần xét tay",
          [
            "Hồ sơ đủ điều kiện nhưng chưa thể duyệt tự động. BMQ vui lòng kiểm tra và duyệt tay.",
            "Khách chưa nhận hợp đồng và chưa được tạo tài khoản đại lý.",
          ],
          details,
        ),
      };

      const customerMail: DealerSignupEmail = {
        to: input.email,
        subject: `BMQ đã nhận hồ sơ đăng ký đại lý – ${inserted.application_code}`,
        text: emailText(
          "BMQ đã nhận hồ sơ đăng ký đại lý",
          [
            `Kính gửi ${input.applicantName},`,
            "BMQ đã nhận được hồ sơ đăng ký đại lý của anh/chị.",
            "BMQ sẽ liên hệ để kiểm tra thông tin trước khi gửi hợp đồng.",
          ],
          [["Mã hồ sơ", inserted.application_code]],
        ),
        html: emailHtml(
          "BMQ đã nhận hồ sơ đăng ký đại lý",
          [
            `Kính gửi ${input.applicantName},`,
            "BMQ đã nhận được hồ sơ đăng ký đại lý của anh/chị.",
            "BMQ sẽ liên hệ để kiểm tra thông tin trước khi gửi hợp đồng.",
          ],
          [["Mã hồ sơ", inserted.application_code]],
        ),
      };

      try {
        const bmqSent = await requireEmailSender(deps)(bmqMail);
        await requireEmailSender(deps)(customerMail);
        await deps.store.update(inserted.id, { email_message_id: bmqSent.id });
      } catch (mailError) {
        logger(`manual_review_email_failed:${safeErrorCode(mailError, "email_send_failed")}`);
      }

      return dealerSignupJson(req, {
        success: true,
        result: "manual_review",
        status: "manual_review",
        application_code: inserted.application_code,
        nearest_distance_m: decision.nearest_distance_m,
        duplicate_phone: duplicatePhone,
      });
    }

    const draftPath = dealerContractDraftPath(inserted.id);
    let storedDraftPath = draftPath;
    try {
      if (!deps.uploadContractDraft || !deps.setContractDraft) {
        throw new Error("contract_storage_not_configured");
      }
      storedDraftPath = await deps.uploadContractDraft(inserted.id, pdf);
      await deps.setContractDraft(inserted.id, storedDraftPath);
    } catch (error) {
      const code = safeErrorCode(error, "contract_storage_failed");
      await deps.store.update(inserted.id, {
        status: "approved_waiting_slip" as DealerSignupApplication["status"],
        last_error_code: code,
      });
      logger(`contract_storage_failed:${code}`);
      return dealerSignupError(
        req,
        "Đã duyệt hồ sơ nhưng chưa lưu được hợp đồng. Vui lòng thử lại sau.",
        500,
        code,
      );
    }

    const accountInsert = buildDealerContractEmailInsert({ slipToken, publicBaseUrl });
    const contractParagraphs = [
      `Kính gửi ${input.applicantName},`,
      "BMQ gửi anh/chị hợp đồng phân phối bánh mì que BMQ (đại lý mở 01 điểm) đã điền thông tin đăng ký.",
      "Vui lòng kiểm tra thông tin trong hợp đồng, ký và gửi lại bản ký cho BMQ.",
      "Bản dự thảo chỉ có hiệu lực khi hai bên ký.",
      ...accountInsert.text,
    ];
    const contractHtmlParagraphs = [
      `Kính gửi ${input.applicantName},`,
      "BMQ gửi anh/chị hợp đồng phân phối bánh mì que BMQ (đại lý mở 01 điểm) đã điền thông tin đăng ký.",
      "Vui lòng kiểm tra thông tin trong hợp đồng, ký và gửi lại bản ký cho BMQ.",
      "Bản dự thảo chỉ có hiệu lực khi hai bên ký.",
      ...accountInsert.html,
    ];

    const details: Array<[string, string]> = [
      ["Mã hồ sơ", inserted.application_code],
      ["Họ tên", input.applicantName],
      ["Hộ kinh doanh", input.businessName],
      ["CCCD", input.cccd],
      ["Ngày hết hạn CCCD", formatContractDate(input.cccdValidUntil)],
      ["Điện thoại", input.phone],
      ["Địa chỉ", input.addressText],
      ["Hiệu lực hợp đồng", `${formatContractDate(term.start)} – ${formatContractDate(term.end)}`],
    ];

    const customerMail: DealerSignupEmail = {
      to: input.email,
      cc: bmqEmail,
      subject: `Hợp đồng phân phối BMQ – ${inserted.application_code}`,
      text: emailText(
        "Hợp đồng phân phối bánh mì que BMQ",
        contractParagraphs,
        details,
      ),
      html: emailHtml(
        "Hợp đồng phân phối bánh mì que BMQ",
        contractHtmlParagraphs,
        details,
      ),
      attachments: [{
        filename: attachmentName,
        mimeType: "application/pdf",
        data: pdf,
      }],
    };

    try {
      const sent = await requireEmailSender(deps)(customerMail);
      await deps.store.update(inserted.id, {
        status: "approved_waiting_slip" as DealerSignupApplication["status"],
        contract_sent_at: now().toISOString(),
        email_message_id: sent.id,
        last_error_code: null,
      });

      return dealerSignupJson(req, {
        success: true,
        result: "eligible",
        status: "approved_waiting_slip",
        application_code: inserted.application_code,
        nearest_distance_m: decision.nearest_distance_m,
        email_message_id: sent.id,
        crm_customer_id: approved.crm_customer_id,
        dealer_onboarding_status: "waiting_slip",
        contract_draft_path: storedDraftPath,
        slip_expires_at: slipExpiresAt,
      });
    } catch (error) {
      const code = safeErrorCode(error, "email_send_failed");
      await deps.store.update(inserted.id, {
        status: "email_failed",
        last_error_code: code,
      });
      logger(`email_failed:${code}`);
      return dealerSignupError(req, "Chưa gửi được hợp đồng qua email. Vui lòng thử lại sau.", 502, code);
    }
  } catch (error) {
    logger(`request_failed:${safeErrorCode(error, "submit_failed")}`);
    return dealerSignupError(req, "Không gửi được hồ sơ. Vui lòng thử lại.", 500, "dealer_signup_submit_failed");
  }
}

function requireEmailSender(
  deps: DealerSignupSubmitDeps,
): (email: DealerSignupEmail) => Promise<{ id: string }> {
  if (!deps.sendEmail) throw Object.assign(new Error("email_sender_not_configured"), { code: "email_sender_not_configured" });
  return deps.sendEmail;
}
