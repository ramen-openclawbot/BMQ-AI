import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  createServiceClient,
  errorResponse,
  generateDealerSessionToken,
  getRequestMetadata,
  getSessionExpiresAt,
  hashDealerOtp,
  hashDealerSessionToken,
  jsonResponse,
  normalizeDealerPhone,
  publicCustomerProfile,
  readJsonBody,
  timingSafeEqual,
} from "../_shared/dealer.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const body = await readJsonBody<{ phone?: unknown; otp?: unknown }>(req);
    const phoneNormalized = normalizeDealerPhone(body.phone);
    const otp = String(body.otp || "").trim();

    if (!phoneNormalized) {
      return errorResponse(req, "Số điện thoại không hợp lệ.", 400, "invalid_phone");
    }

    if (!/^\d{6}$/.test(otp)) {
      return errorResponse(req, "Mã OTP phải gồm 6 chữ số.", 400, "invalid_otp_format");
    }

    const supabase = createServiceClient();
    const now = new Date().toISOString();
    const { data: challenge, error: challengeError } = await supabase
      .from("dealer_otp_challenges")
      .select("*")
      .eq("phone_normalized", phoneNormalized)
      .is("consumed_at", null)
      .gt("expires_at", now)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (challengeError) throw challengeError;

    if (!challenge) {
      return errorResponse(req, "Mã OTP không đúng hoặc đã hết hạn.", 401, "otp_invalid_or_expired");
    }

    if (Number(challenge.attempts || 0) >= Number(challenge.max_attempts || 5)) {
      await supabase
        .from("dealer_otp_challenges")
        .update({ consumed_at: now, send_status: "max_attempts" })
        .eq("id", challenge.id);

      return errorResponse(req, "Mã OTP đã vượt quá số lần thử. Vui lòng yêu cầu mã mới.", 429, "otp_max_attempts");
    }

    const expectedHash = await hashDealerOtp(challenge.id, phoneNormalized, otp);
    const attempts = Number(challenge.attempts || 0) + 1;

    if (!timingSafeEqual(expectedHash, challenge.otp_hash)) {
      await supabase
        .from("dealer_otp_challenges")
        .update({
          attempts,
          consumed_at: attempts >= Number(challenge.max_attempts || 5) ? now : null,
          send_status: attempts >= Number(challenge.max_attempts || 5) ? "max_attempts" : challenge.send_status,
        })
        .eq("id", challenge.id);

      return errorResponse(req, "Mã OTP không đúng hoặc đã hết hạn.", 401, "otp_invalid_or_expired");
    }

    const { data: customer, error: customerError } = await supabase
      .from("mini_crm_customers")
      .select("id, customer_name, customer_code, customer_group, address, is_active, is_npp, supplied_by_npp_customer_id")
      .eq("id", challenge.customer_id)
      .maybeSingle();

    if (customerError) throw customerError;

    if (!customer?.is_active) {
      return errorResponse(req, "Hồ sơ đại lý đang tạm ngưng. Vui lòng liên hệ vận hành.", 403, "customer_inactive");
    }

    await supabase
      .from("dealer_otp_challenges")
      .update({
        attempts,
        consumed_at: now,
        send_status: "verified",
      })
      .eq("id", challenge.id);

    const sessionToken = generateDealerSessionToken();
    const sessionTokenHash = await hashDealerSessionToken(sessionToken);
    const expiresAt = getSessionExpiresAt();
    const requestMeta = getRequestMetadata(req);

    const { data: session, error: sessionError } = await supabase
      .from("dealer_sessions")
      .insert({
        customer_id: challenge.customer_id,
        contact_id: challenge.contact_id,
        token_hash: sessionTokenHash,
        expires_at: expiresAt,
        last_seen_at: now,
        request_ip: requestMeta.request_ip,
        user_agent: requestMeta.user_agent,
      })
      .select("id, expires_at")
      .single();

    if (sessionError) throw sessionError;

    return jsonResponse(req, {
      success: true,
      dealer_token: sessionToken,
      expires_at: session.expires_at,
      customer: publicCustomerProfile(customer),
    });
  } catch (error) {
    console.error("[dealer-auth-verify] Unexpected error", error);
    const message = error instanceof Error ? error.message : "Không thể xác thực OTP";
    return errorResponse(req, message, 500, "dealer_auth_verify_failed");
  }
});
