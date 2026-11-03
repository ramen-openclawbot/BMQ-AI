/**
 * Pure helpers for the dealer signup review flow: bank-slip tokens, file
 * validation and Vietnamese email content. No network, database or Gmail
 * access here so everything can be unit-tested.
 */

export const DEALER_SIGNUP_DOCS_BUCKET = "dealer-signup-docs";
export const DEALER_SIGNUP_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const DEALER_SLIP_TOKEN_TTL_DAYS = 14;
export const DEALER_SIGNUP_PUBLIC_BASE_URL = "https://dathang.banhmique.vn";

export type DealerSignupReviewStatus =
  | "rejected_too_close"
  | "manual_review"
  | "contract_sent"
  | "email_failed"
  | "approved_waiting_slip"
  | "active"
  | "rejected_manual";

export type DealerSignupApprovalMode = "auto" | "manual";

export type DealerSignupReviewApplication = {
  id: string;
  application_code: string;
  status: DealerSignupReviewStatus;
  applicant_name: string;
  cccd: string;
  cccd_valid_until: string;
  phone: string;
  email: string;
  business_name: string;
  address_text: string;
  crm_customer_id: string | null;
  contract_draft_path: string | null;
  contract_signed_path: string | null;
  slip_storage_path: string | null;
  slip_token_expires_at: string | null;
  reviewed_at?: string | null;
  reject_reason?: string | null;
  last_error_code?: string | null;
};

export type DealerSignupApprovalResult = {
  application_id: string;
  application_code: string;
  status: string;
  crm_customer_id: string | null;
  already_approved: boolean;
};

export type DealerSignupActivationResult = {
  application_id: string;
  application_code: string;
  status: string;
  crm_customer_id: string | null;
  slip_storage_path?: string | null;
  already_active: boolean;
};

export type DealerSignupEmailContent = {
  subject: string;
  html: string;
  text: string;
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `DEALER_SIGNUP_PUBLIC_BASE_URL`, falling back to the production portal. */
export function dealerSignupPublicBaseUrl(
  env: (key: string) => string | undefined = () => undefined,
): string {
  const configured = String(env("DEALER_SIGNUP_PUBLIC_BASE_URL") || "").trim();
  const candidate = configured || DEALER_SIGNUP_PUBLIC_BASE_URL;
  if (!/^https?:\/\/[^\s]+$/i.test(candidate)) return DEALER_SIGNUP_PUBLIC_BASE_URL;
  return candidate.replace(/\/+$/, "");
}

export function buildDealerBankSlipUrl(baseUrl: string, token: string): string {
  const base = String(baseUrl || DEALER_SIGNUP_PUBLIC_BASE_URL).replace(/\/+$/, "");
  return `${base}/dai-ly-moi/bank-slip?token=${encodeURIComponent(token)}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** 32 cryptographically random bytes, base64url without padding. */
export function generateDealerSlipToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function hashDealerSlipToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function dealerSlipTokenExpiresAt(
  now: Date = new Date(),
  days: number = DEALER_SLIP_TOKEN_TTL_DAYS,
): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function isDealerSlipTokenShape(token: unknown): boolean {
  const value = String(token ?? "").trim();
  return /^[A-Za-z0-9_-]{20,200}$/.test(value);
}

// ---------------------------------------------------------------------------
// File validation by magic bytes; never trust the browser MIME type.
// ---------------------------------------------------------------------------
export type DealerSignupDocumentKind = "bank_slip" | "signed_contract";
export type DealerSignupDocumentFormat = "pdf" | "jpg" | "png" | "webp";

const FORMAT_MIME: Record<DealerSignupDocumentFormat, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const ALLOWED_FORMATS: Record<DealerSignupDocumentKind, DealerSignupDocumentFormat[]> = {
  bank_slip: ["pdf", "jpg", "png", "webp"],
  signed_contract: ["pdf", "jpg", "png"],
};

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.length <= bytes.length && prefix.every((value, index) => bytes[index] === value);
}

export function detectDealerSignupDocumentFormat(
  bytes: Uint8Array,
): DealerSignupDocumentFormat | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // %PDF-
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

export type DealerSignupDocumentValidation =
  | {
    ok: true;
    format: DealerSignupDocumentFormat;
    extension: DealerSignupDocumentFormat;
    mimeType: string;
  }
  | { ok: false; code: string; error: string };

export function validateDealerSignupDocument(input: {
  kind: DealerSignupDocumentKind;
  bytes: Uint8Array;
}): DealerSignupDocumentValidation {
  const bytes = input.bytes;
  if (!bytes || bytes.length === 0) {
    return { ok: false, code: "file_required", error: "Vui lòng chọn tệp để tải lên." };
  }
  if (bytes.length > DEALER_SIGNUP_MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      code: "file_too_large",
      error: "Tệp vượt quá 10 MB. Vui lòng chọn tệp nhỏ hơn.",
    };
  }

  const format = detectDealerSignupDocumentFormat(bytes);
  if (!format || !ALLOWED_FORMATS[input.kind].includes(format)) {
    return {
      ok: false,
      code: "invalid_file_type",
      error: input.kind === "bank_slip"
        ? "Chỉ nhận ảnh JPEG/PNG/WebP hoặc PDF cho bank slip."
        : "Chỉ nhận PDF/JPEG/PNG cho hợp đồng đã đóng dấu.",
    };
  }

  return {
    ok: true,
    format,
    extension: format,
    mimeType: FORMAT_MIME[format],
  };
}

// ---------------------------------------------------------------------------
// Storage paths
// ---------------------------------------------------------------------------
export function dealerContractDraftPath(applicationId: string): string {
  return `${applicationId}/contract-draft.pdf`;
}

export function documentTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function dealerSignedContractPath(
  applicationId: string,
  timestamp: string,
  extension: DealerSignupDocumentFormat,
): string {
  return `${applicationId}/contract-signed-${timestamp}.${extension}`;
}

export function dealerSlipPath(
  applicationId: string,
  timestamp: string,
  extension: DealerSignupDocumentFormat,
): string {
  return `${applicationId}/slip-${timestamp}.${extension}`;
}

// ---------------------------------------------------------------------------
// Email content (Vietnamese, HTML-escaped)
// ---------------------------------------------------------------------------
function emailShell(title: string, paragraphs: string[], details: Array<[string, string]>): string {
  const rows = details
    .map(([label, value]) =>
      `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;vertical-align:top">${escapeHtml(label)}</td><td style="padding:4px 0;color:#111827">${escapeHtml(value)}</td></tr>`
    )
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

function emailTextBody(title: string, paragraphs: string[], details: Array<[string, string]>): string {
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

export type DealerSignupApprovedEmailInput = {
  applicantName: string;
  applicationCode: string;
  businessName: string;
  slipToken: string;
  publicBaseUrl: string;
};

/** Congratulations email for a manually approved application. */
export function buildDealerSignupApprovedEmail(
  input: DealerSignupApprovedEmailInput,
): DealerSignupEmailContent {
  const slipUrl = buildDealerBankSlipUrl(input.publicBaseUrl, input.slipToken);
  const paragraphs = [
    `Kính gửi ${input.applicantName},`,
    `Hồ sơ đăng ký đại lý của hộ kinh doanh ${input.businessName} đã được BMQ duyệt.`,
    "Anh/chị có thể đăng nhập dathang.banhmique.vn bằng số điện thoại đã đăng ký (nhận mã OTP qua Zalo) để theo dõi tài khoản đại lý.",
    "Tài khoản đang chờ bank slip. Vui lòng upload bank slip để bắt đầu đặt bánh.",
    `Upload bank slip tại: ${slipUrl}`,
    "Liên kết có hiệu lực 14 ngày. Nếu liên kết hết hạn, anh/chị vui lòng liên hệ BMQ để được gửi lại.",
  ];
  return {
    subject: `BMQ đã duyệt hồ sơ đại lý – ${input.applicationCode}`,
    text: emailTextBody(
      "BMQ đã duyệt hồ sơ đăng ký đại lý",
      paragraphs,
      [["Mã hồ sơ", input.applicationCode]],
    ),
    html: emailShell(
      "BMQ đã duyệt hồ sơ đăng ký đại lý",
      paragraphs,
      [["Mã hồ sơ", input.applicationCode]],
    ),
  };
}

export type DealerContractEmailInsertInput = {
  slipToken: string;
  publicBaseUrl: string;
};

/**
 * Extra paragraphs appended to the existing automatic contract email so the
 * customer still receives exactly one email containing the PDF and the link.
 */
export function buildDealerContractEmailInsert(
  input: DealerContractEmailInsertInput,
): { text: string[]; html: string[] } {
  const slipUrl = buildDealerBankSlipUrl(input.publicBaseUrl, input.slipToken);
  const text = [
    "Anh/chị có thể đăng nhập dathang.banhmique.vn bằng số điện thoại đã đăng ký (nhận mã OTP qua Zalo).",
    "Tài khoản đang chờ bank slip. Sau khi upload bank slip, anh/chị sẽ đặt bánh được ngay trên hệ thống BMQ.",
    `Upload bank slip tại: ${slipUrl}`,
    "Liên kết bank slip có hiệu lực 14 ngày.",
  ];
  const html = [
    "Anh/chị có thể đăng nhập dathang.banhmique.vn bằng số điện thoại đã đăng ký (nhận mã OTP qua Zalo).",
    "Tài khoản đang chờ bank slip. Sau khi upload bank slip, anh/chị sẽ đặt bánh được ngay trên hệ thống BMQ.",
    `Upload bank slip tại: ${escapeHtml(slipUrl)}`,
    "Liên kết bank slip có hiệu lực 14 ngày.",
  ];
  return { text, html };
}

export function buildDealerSignupRejectedEmail(input: {
  applicantName: string;
  applicationCode: string;
  reason: string;
}): DealerSignupEmailContent {
  const paragraphs = [
    `Kính gửi ${input.applicantName},`,
    `BMQ rất tiếc chưa thể duyệt hồ sơ đăng ký đại lý ${input.applicationCode} lần này.`,
    `Lý do: ${input.reason}`,
    "Nếu cần thêm thông tin, anh/chị vui lòng liên hệ BMQ để được hướng dẫn.",
  ];
  return {
    subject: `BMQ chưa duyệt được hồ sơ đại lý – ${input.applicationCode}`,
    text: emailTextBody("Kết quả xét hồ sơ đăng ký đại lý", paragraphs, [
      ["Mã hồ sơ", input.applicationCode],
      ["Lý do", input.reason],
    ]),
    html: emailShell("Kết quả xét hồ sơ đăng ký đại lý", paragraphs, [
      ["Mã hồ sơ", input.applicationCode],
      ["Lý do", input.reason],
    ]),
  };
}

export function buildDealerSignupSlipBmqEmail(input: {
  applicantName: string;
  businessName: string;
  applicationCode: string;
  phone?: string;
}): DealerSignupEmailContent {
  const paragraphs = [
    `Đại lý ${input.businessName} vừa upload bank slip và đã được kích hoạt đặt bánh.`,
    "Vui lòng kiểm tra bank slip trong hồ sơ đại lý trên Mini CRM.",
  ];
  const details: Array<[string, string]> = [
    ["Mã hồ sơ", input.applicationCode],
    ["Hộ kinh doanh", input.businessName],
    ["Người đại diện", input.applicantName],
  ];
  if (input.phone) details.push(["Điện thoại", input.phone]);
  return {
    subject: `[Đại lý] Bank slip mới – ${input.applicationCode}`,
    text: emailTextBody("Đại lý mới đã upload bank slip", paragraphs, details),
    html: emailShell("Đại lý mới đã upload bank slip", paragraphs, details),
  };
}
