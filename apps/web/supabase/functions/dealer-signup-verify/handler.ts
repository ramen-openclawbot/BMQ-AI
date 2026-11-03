/**
 * Public phone/email verification endpoint for dealer signup.
 *
 * `send` delivers a six-digit code over the existing dealer ZNS template
 * (phone) or Gmail order@ (email). `check` verifies codes and, once both
 * channels of the same session are verified with the same normalized targets,
 * returns a one-time verification token. Codes, hashes and tokens are never
 * logged or echoed.
 */
import { getCorsHeaders } from "../_shared/cors.ts";
import {
  getClientIp,
  hashClientIp,
  readDealerSignupBody,
  safeErrorCode,
  type RateLimitDecision,
} from "../_shared/dealer-signup-http.ts";
import {
  DEALER_VERIFICATION_MAX_ATTEMPTS,
  DEALER_VERIFICATION_RESEND_SECONDS,
  dealerVerificationCodeExpiresAt,
  dealerVerificationTokenExpiresAt,
  generateDealerSlipToken,
  generateDealerVerificationCode,
  hashDealerSlipToken,
  hashDealerVerificationCode,
  normalizeDealerVerificationEmail,
  normalizeDealerVerificationPhone,
  timingSafeEqualText,
  type DealerSignupVerificationChannel,
} from "../_shared/dealer-signup-review.ts";

export const DEALER_VERIFY_SEND_LIMIT_PER_HOUR = 10;
export const DEALER_VERIFY_CHECK_LIMIT_PER_HOUR = 30;

export type DealerSignupVerificationRow = {
  id: string;
  session_id: string;
  channel: DealerSignupVerificationChannel;
  target_normalized: string;
  code_hash: string;
  expires_at: string;
  attempts: number;
  verified_at: string | null;
  consumed_at: string | null;
  ip_hash: string;
  created_at: string;
};

export type DealerSignupVerificationTokenInput = {
  sessionId: string;
  tokenHash: string;
  phoneNormalized: string;
  emailNormalized: string;
  expiresAt: string;
};

export type DealerSignupVerifyStore = {
  findBySessionChannel(
    sessionId: string,
    channel: DealerSignupVerificationChannel,
  ): Promise<DealerSignupVerificationRow | null>;
  upsertVerification(input: {
    sessionId: string;
    channel: DealerSignupVerificationChannel;
    targetNormalized: string;
    codeHash: string;
    expiresAt: string;
    ipHash: string;
    createdAt: string;
  }): Promise<DealerSignupVerificationRow>;
  deleteVerification(id: string): Promise<void>;
  markVerified(id: string, verifiedAt: string): Promise<void>;
  setVerificationAttempts(id: string, attempts: number): Promise<void>;
  invalidateSessionTokens(sessionId: string): Promise<void>;
  createVerificationToken(input: DealerSignupVerificationTokenInput): Promise<void>;
  checkRateLimit(
    ipHash: string,
    action: "verify_send" | "verify_check",
    limit: number,
  ): Promise<RateLimitDecision>;
};

export type DealerSignupVerifyEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export type DealerSignupVerifyDeps = {
  store: DealerSignupVerifyStore;
  sendPhoneOtp?: (input: {
    phoneNormalized: string;
    otp: string;
    challengeId: string;
  }) => Promise<unknown>;
  sendEmail?: (email: DealerSignupVerifyEmail) => Promise<{ id: string }>;
  env?: (key: string) => string | undefined;
  now?: () => Date;
  logger?: (code: string) => void;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function verificationEmail(code: string): DealerSignupVerifyEmail {
  const safeCode = escapeHtml(code);
  return {
    to: "",
    subject: "Mã xác minh đăng ký đại lý BMQ",
    text: [
      "BMQ xác nhận đăng ký đại lý",
      "",
      `Mã xác minh của bạn là: ${code}`,
      "Mã có hiệu lực 10 phút. Không chia sẻ mã này cho bất kỳ ai.",
      "",
      "Trân trọng,",
      "BMQ",
    ].join("\n"),
    html: `<!doctype html><html><body style="margin:0;background:#f6f7f8;font-family:Arial,Helvetica,sans-serif;color:#111827">
  <div style="max-width:560px;margin:0 auto;padding:24px;background:#ffffff">
    <h1 style="font-size:20px;margin:0 0 16px">Xác minh đăng ký đại lý BMQ</h1>
    <p style="line-height:1.55;margin:0 0 12px">Mã xác minh email của bạn là:</p>
    <p style="font-size:28px;letter-spacing:6px;font-weight:bold;margin:0 0 12px">${safeCode}</p>
    <p style="line-height:1.55;margin:0 0 12px">Mã có hiệu lực 10 phút. Không chia sẻ mã này cho bất kỳ ai.</p>
    <p style="line-height:1.55;margin:24px 0 0">Trân trọng,<br/>BMQ</p>
  </div>
</body></html>`,
  };
}

function verificationSecret(env: (key: string) => string | undefined): string {
  return env("DEALER_SIGNUP_VERIFY_SECRET") ||
    env("DEALER_AUTH_OTP_PEPPER") ||
    env("SUPABASE_SERVICE_ROLE_KEY") ||
    "dealer-verify-local";
}

async function enforceRateLimit(
  req: Request,
  deps: DealerSignupVerifyDeps,
  ipHash: string,
  action: "verify_send" | "verify_check",
  limit: number,
): Promise<Response | null> {
  const logger = deps.logger ?? ((code: string) => console.warn(`[dealer-signup-verify] ${code}`));
  let decision: RateLimitDecision;
  try {
    decision = await deps.store.checkRateLimit(ipHash, action, limit);
  } catch {
    logger("rate_limit_unavailable");
    return errorJson(req, "Tạm thời chưa gửi được mã xác minh. Vui lòng thử lại.", 503, "rate_limit_unavailable");
  }
  if (decision.allowed) return null;
  const response = errorJson(req, "Bạn đã thử quá nhiều lần. Vui lòng thử lại sau.", 429, "rate_limited");
  response.headers.set("Retry-After", String(Math.max(1, decision.retry_after_seconds)));
  return response;
}

function readSessionId(body: Record<string, unknown>): string | null {
  const sessionId = String(body.session_id ?? body.sessionId ?? "").trim();
  return UUID_PATTERN.test(sessionId) ? sessionId : null;
}

async function handleSend(
  req: Request,
  deps: DealerSignupVerifyDeps,
  body: Record<string, unknown>,
): Promise<Response> {
  const now = (deps.now ?? (() => new Date()))();
  const env = deps.env ?? ((key: string) => Deno.env.get(key));
  const logger = deps.logger ?? ((code: string) => console.warn(`[dealer-signup-verify] ${code}`));

  const sessionId = readSessionId(body);
  if (!sessionId) {
    return errorJson(req, "Phiên xác minh không hợp lệ.", 400, "invalid_session_id");
  }

  const channel = String(body.channel ?? "").trim();
  if (channel !== "phone" && channel !== "email") {
    return errorJson(req, "Kênh xác minh không hợp lệ.", 400, "invalid_channel");
  }

  const target = channel === "phone"
    ? normalizeDealerVerificationPhone(body.phone)
    : normalizeDealerVerificationEmail(body.email);
  if (!target) {
    return errorJson(
      req,
      channel === "phone" ? "Số điện thoại không hợp lệ." : "Email không hợp lệ.",
      400,
      channel === "phone" ? "invalid_phone" : "invalid_email",
    );
  }

  const salt = env("DEALER_SIGNUP_IP_SALT") || env("SUPABASE_SERVICE_ROLE_KEY") ||
    "dealer-signup-local";
  const ipHash = await hashClientIp(getClientIp(req), salt);

  const limited = await enforceRateLimit(
    req,
    deps,
    ipHash,
    "verify_send",
    DEALER_VERIFY_SEND_LIMIT_PER_HOUR,
  );
  if (limited) return limited;

  const existing = await deps.store.findBySessionChannel(sessionId, channel);
  const existingCreatedAt = existing ? Date.parse(existing.created_at) : NaN;
  const sameTarget = existing?.target_normalized === target;

  if (existing && sameTarget && existing.verified_at) {
    return json(req, {
      success: true,
      channel,
      sent: false,
      already_verified: true,
      expires_at: existing.expires_at,
    });
  }

  if (existing && sameTarget && Number.isFinite(existingCreatedAt)) {
    const resendAt = existingCreatedAt + DEALER_VERIFICATION_RESEND_SECONDS * 1000;
    if (resendAt > now.getTime()) {
      const retryAfter = Math.max(1, Math.ceil((resendAt - now.getTime()) / 1000));
      const response = errorJson(
        req,
        `Vui lòng chờ ${retryAfter} giây trước khi gửi lại mã.`,
        429,
        "resend_too_soon",
      );
      response.headers.set("Retry-After", String(retryAfter));
      return response;
    }
  }

  const code = generateDealerVerificationCode();
  const codeHash = await hashDealerVerificationCode({
    sessionId,
    channel,
    targetNormalized: target,
    code,
    secret: verificationSecret(env),
  });
  const expiresAt = dealerVerificationCodeExpiresAt(now);

  let row: DealerSignupVerificationRow;
  try {
    row = await deps.store.upsertVerification({
      sessionId,
      channel,
      targetNormalized: target,
      codeHash,
      expiresAt,
      ipHash,
      createdAt: now.toISOString(),
    });
  } catch (error) {
    logger(`verification_save_failed:${safeErrorCode(error, "verification_save_failed")}`);
    return errorJson(req, "Chưa lưu được mã xác minh. Vui lòng thử lại.", 500, "verification_save_failed");
  }

  try {
    if (channel === "phone") {
      if (!deps.sendPhoneOtp) throw new Error("phone_otp_not_configured");
      await deps.sendPhoneOtp({
        phoneNormalized: target,
        otp: code,
        challengeId: `${sessionId}:phone`,
      });
    } else {
      if (!deps.sendEmail) throw new Error("email_sender_not_configured");
      await deps.sendEmail({ ...verificationEmail(code), to: target });
    }
  } catch (error) {
    // A failed delivery must not leave a 60-second cooldown behind.
    try {
      await deps.store.deleteVerification(row.id);
    } catch {
      // Nothing to do; the caller only sees a stable failure code.
    }
    logger(`verification_send_failed:${safeErrorCode(error, "verification_send_failed")}`);
    return errorJson(req, "Chưa gửi được mã xác minh. Vui lòng thử lại.", 502, "verification_send_failed");
  }

  return json(req, {
    success: true,
    channel,
    sent: true,
    expires_at: expiresAt,
    resend_after_seconds: DEALER_VERIFICATION_RESEND_SECONDS,
  });
}

type PendingCheck = {
  channel: DealerSignupVerificationChannel;
  target: string;
  code: string;
};

async function handleCheck(
  req: Request,
  deps: DealerSignupVerifyDeps,
  body: Record<string, unknown>,
): Promise<Response> {
  const now = (deps.now ?? (() => new Date()))();
  const env = deps.env ?? ((key: string) => Deno.env.get(key));
  const logger = deps.logger ?? ((code: string) => console.warn(`[dealer-signup-verify] ${code}`));

  const sessionId = readSessionId(body);
  if (!sessionId) {
    return errorJson(req, "Phiên xác minh không hợp lệ.", 400, "invalid_session_id");
  }

  const phone = body.phone === undefined || body.phone === null
    ? null
    : normalizeDealerVerificationPhone(body.phone);
  if (body.phone !== undefined && body.phone !== null && !phone) {
    return errorJson(req, "Số điện thoại không hợp lệ.", 400, "invalid_phone");
  }
  const email = body.email === undefined || body.email === null
    ? null
    : normalizeDealerVerificationEmail(body.email);
  if (body.email !== undefined && body.email !== null && !email) {
    return errorJson(req, "Email không hợp lệ.", 400, "invalid_email");
  }

  const salt = env("DEALER_SIGNUP_IP_SALT") || env("SUPABASE_SERVICE_ROLE_KEY") ||
    "dealer-signup-local";
  const ipHash = await hashClientIp(getClientIp(req), salt);

  const limited = await enforceRateLimit(
    req,
    deps,
    ipHash,
    "verify_check",
    DEALER_VERIFY_CHECK_LIMIT_PER_HOUR,
  );
  if (limited) return limited;

  const pending: PendingCheck[] = [];
  const explicitChannel = String(body.channel ?? "").trim();
  if (explicitChannel === "phone" || explicitChannel === "email") {
    const code = String(body.code ?? "").trim();
    if (!/^\d{6}$/.test(code)) {
      return errorJson(req, "Vui lòng nhập mã xác minh 6 số.", 400, "code_required");
    }
    const target = explicitChannel === "phone" ? phone : email;
    if (!target) {
      return errorJson(
        req,
        explicitChannel === "phone" ? "Thiếu số điện thoại." : "Thiếu email.",
        400,
        "verification_target_required",
      );
    }
    pending.push({ channel: explicitChannel, target, code });
  } else {
    if (body.phone_code !== undefined) {
      const code = String(body.phone_code ?? "").trim();
      if (!phone) return errorJson(req, "Thiếu số điện thoại.", 400, "verification_target_required");
      if (!/^\d{6}$/.test(code)) return errorJson(req, "Mã SĐT phải gồm 6 số.", 400, "code_required");
      pending.push({ channel: "phone", target: phone, code });
    }
    if (body.email_code !== undefined) {
      const code = String(body.email_code ?? "").trim();
      if (!email) return errorJson(req, "Thiếu email.", 400, "verification_target_required");
      if (!/^\d{6}$/.test(code)) return errorJson(req, "Mã email phải gồm 6 số.", 400, "code_required");
      pending.push({ channel: "email", target: email, code });
    }
    // No code + a known target is a status-only check: report verified flags.
    if (pending.length === 0 && !phone && !email) {
      return errorJson(req, "Vui lòng nhập mã xác minh.", 400, "code_required");
    }
  }

  for (const item of pending) {
    const row = await deps.store.findBySessionChannel(sessionId, item.channel);
    if (!row) {
      return errorJson(req, "Chưa gửi mã cho kênh này.", 400, "verification_not_sent");
    }
    if (row.target_normalized !== item.target) {
      return errorJson(
        req,
        "Thông tin đã thay đổi. Vui lòng gửi lại mã xác minh.",
        400,
        "verification_target_mismatch",
      );
    }
    if (row.verified_at) continue;

    if (row.attempts >= DEALER_VERIFICATION_MAX_ATTEMPTS) {
      return errorJson(req, "Bạn đã nhập sai quá 5 lần. Vui lòng gửi lại mã mới.", 429, "too_many_attempts");
    }
    if (Date.parse(row.expires_at) <= now.getTime()) {
      return errorJson(req, "Mã xác minh đã hết hạn. Vui lòng gửi lại mã mới.", 410, "code_expired");
    }

    const expected = await hashDealerVerificationCode({
      sessionId,
      channel: item.channel,
      targetNormalized: item.target,
      code: item.code,
      secret: verificationSecret(env),
    });
    if (!timingSafeEqualText(expected, row.code_hash)) {
      const attempts = row.attempts + 1;
      await deps.store.setVerificationAttempts(row.id, attempts);
      const remaining = Math.max(0, DEALER_VERIFICATION_MAX_ATTEMPTS - attempts);
      if (remaining === 0) {
        return errorJson(req, "Bạn đã nhập sai quá 5 lần. Vui lòng gửi lại mã mới.", 429, "too_many_attempts");
      }
      return errorJson(req, "Mã xác minh không đúng.", 400, "invalid_code");
    }

    await deps.store.markVerified(row.id, now.toISOString());
  }

  const phoneRow = phone ? await deps.store.findBySessionChannel(sessionId, "phone") : null;
  const emailRow = email ? await deps.store.findBySessionChannel(sessionId, "email") : null;
  const phoneVerified = Boolean(
    phone && phoneRow && phoneRow.target_normalized === phone && phoneRow.verified_at,
  );
  const emailVerified = Boolean(
    email && emailRow && emailRow.target_normalized === email && emailRow.verified_at,
  );

  if (!phoneVerified || !emailVerified) {
    return json(req, {
      success: true,
      verified: { phone: phoneVerified, email: emailVerified },
    });
  }

  const token = generateDealerSlipToken();
  const tokenHash = await hashDealerSlipToken(token);
  const expiresAt = dealerVerificationTokenExpiresAt(now);
  try {
    await deps.store.invalidateSessionTokens(sessionId);
    await deps.store.createVerificationToken({
      sessionId,
      tokenHash,
      phoneNormalized: phone!,
      emailNormalized: email!,
      expiresAt,
    });
  } catch (error) {
    logger(`verification_token_save_failed:${safeErrorCode(error, "verification_token_save_failed")}`);
    return errorJson(req, "Chưa tạo được mã xác minh. Vui lòng thử lại.", 500, "verification_token_save_failed");
  }

  return json(req, {
    success: true,
    verified: { phone: true, email: true },
    verification_token: token,
    verification_expires_at: expiresAt,
  });
}

export async function handleDealerSignupVerify(
  req: Request,
  deps: DealerSignupVerifyDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: getCorsHeaders(req) });
  }
  if (req.method !== "POST") {
    return errorJson(req, "Method not allowed", 405, "method_not_allowed");
  }

  const logger = deps.logger ?? ((code: string) => console.warn(`[dealer-signup-verify] ${code}`));

  try {
    const body = await readDealerSignupBody<Record<string, unknown>>(req);
    const action = String(body.action ?? new URL(req.url).searchParams.get("action") ?? "").trim();

    if (action === "send") return await handleSend(req, deps, body);
    if (action === "check") return await handleCheck(req, deps, body);
    return errorJson(req, "Thao tác không hợp lệ.", 400, "invalid_action");
  } catch (error) {
    logger(`request_failed:${safeErrorCode(error, "verification_failed")}`);
    return errorJson(req, "Không xác minh được thông tin. Vui lòng thử lại.", 500, "verification_failed");
  }
}
