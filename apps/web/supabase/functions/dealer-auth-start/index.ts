import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  assertDealerZnsConfiguredOrDevSkip,
  createServiceClient,
  errorResponse,
  generateDealerOtp,
  getOtpExpiresAt,
  getRequestMetadata,
  hashDealerOtp,
  jsonResponse,
  maskDealerPhone,
  normalizeDealerPhone,
  readJsonBody,
  sendDealerOtpZns,
} from "../_shared/dealer.ts";

const GENERIC_AUTH_START_MESSAGE =
  "Nếu số điện thoại thuộc hồ sơ đại lý đang hoạt động, mã OTP sẽ được gửi qua Zalo ZNS.";
const CONTACT_SUPPORT_MESSAGE =
  "Số điện thoại này chưa có trong hệ thống đại lý BMQ hoặc chưa được kích hoạt. Vui lòng liên hệ CSKH BMQ để được hỗ trợ thêm số điện thoại.";
const OTP_RESEND_COOLDOWN_SECONDS = 60;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const body = await readJsonBody<{ phone?: unknown }>(req);
    const phoneNormalized = normalizeDealerPhone(body.phone);

    if (!phoneNormalized) {
      return errorResponse(req, "Số điện thoại không hợp lệ. Vui lòng nhập số di động Việt Nam.", 400, "invalid_phone");
    }

    try {
      assertDealerZnsConfiguredOrDevSkip();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Zalo ZNS is not configured";
      return errorResponse(req, message, 503, "zns_not_configured");
    }

    const supabase = createServiceClient();
    const { data: contacts, error: contactError } = await supabase
      .from("dealer_customer_contacts")
      .select(
        "id, customer_id, phone_normalized, contact_name, mini_crm_customers!inner(id, customer_name, is_active)",
      )
      .eq("phone_normalized", phoneNormalized)
      .eq("is_active", true)
      .eq("mini_crm_customers.is_active", true)
      .limit(2);

    if (contactError) throw contactError;

    if (!contacts?.length) {
      return jsonResponse(req, {
        success: true,
        otp_required: false,
        reason: "dealer_phone_not_registered",
        message: CONTACT_SUPPORT_MESSAGE,
      });
    }

    if (contacts.length > 1) {
      console.warn(`[dealer-auth-start] Duplicate active contacts for ${maskDealerPhone(phoneNormalized)}`);
      return jsonResponse(req, {
        success: true,
        otp_required: false,
        reason: "dealer_phone_needs_support",
        message: CONTACT_SUPPORT_MESSAGE,
      });
    }

    const cooldownSince = new Date(Date.now() - OTP_RESEND_COOLDOWN_SECONDS * 1000).toISOString();
    const { data: recentChallenge, error: cooldownError } = await supabase
      .from("dealer_otp_challenges")
      .select("id")
      .eq("phone_normalized", phoneNormalized)
      .gte("created_at", cooldownSince)
      .limit(1)
      .maybeSingle();

    if (cooldownError) throw cooldownError;

    if (recentChallenge) {
      return jsonResponse(req, {
        success: true,
        message: GENERIC_AUTH_START_MESSAGE,
        otp_required: true,
        retry_after_seconds: OTP_RESEND_COOLDOWN_SECONDS,
      });
    }

    const contact = contacts[0];
    const challengeId = crypto.randomUUID();
    const otp = generateDealerOtp();
    const expiresAt = getOtpExpiresAt();
    const otpHash = await hashDealerOtp(challengeId, phoneNormalized, otp);
    const requestMeta = getRequestMetadata(req);

    await supabase
      .from("dealer_otp_challenges")
      .update({
        consumed_at: new Date().toISOString(),
        send_status: "superseded",
      })
      .eq("phone_normalized", phoneNormalized)
      .is("consumed_at", null);

    const { error: insertError } = await supabase
      .from("dealer_otp_challenges")
      .insert({
        id: challengeId,
        customer_id: contact.customer_id,
        contact_id: contact.id,
        phone_normalized: phoneNormalized,
        otp_hash: otpHash,
        expires_at: expiresAt,
        request_ip: requestMeta.request_ip,
        user_agent: requestMeta.user_agent,
      });

    if (insertError) throw insertError;

    try {
      const sendResult = await sendDealerOtpZns({
        phoneNormalized,
        otp,
        challengeId,
      });

      await supabase
        .from("dealer_otp_challenges")
        .update({
          sent_at: new Date().toISOString(),
          send_provider: sendResult.provider,
          send_status: sendResult.skipped ? "dev_skipped" : "sent",
        })
        .eq("id", challengeId);

      return jsonResponse(req, {
        success: true,
        message: GENERIC_AUTH_START_MESSAGE,
        otp_required: true,
        expires_in_seconds: 300,
        dev_otp: sendResult.skipped ? otp : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Không gửi được Zalo ZNS OTP";
      console.error("[dealer-auth-start] ZNS send failed", message);

      await supabase
        .from("dealer_otp_challenges")
        .update({
          consumed_at: new Date().toISOString(),
          send_status: "failed",
          send_error: message,
        })
        .eq("id", challengeId);

      return errorResponse(req, message, 502, "zns_send_failed");
    }
  } catch (error) {
    console.error("[dealer-auth-start] Unexpected error", error);
    const message = error instanceof Error ? error.message : "Không thể bắt đầu xác thực đại lý";
    return errorResponse(req, message, 500, "dealer_auth_start_failed");
  }
});
