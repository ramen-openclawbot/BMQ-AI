import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getGmailAccessToken, sendGmail } from "../_shared/gmail-send.ts";
import { sendDealerOtpZns } from "../_shared/dealer.ts";
import {
  handleDealerSignupVerify,
  type DealerSignupVerificationRow,
  type DealerSignupVerifyDeps,
  type DealerSignupVerifyStore,
} from "./handler.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const store: DealerSignupVerifyStore = {
  async findBySessionChannel(sessionId, channel) {
    const { data, error } = await supabase
      .from("dealer_signup_verifications")
      .select("*")
      .eq("session_id", sessionId)
      .eq("channel", channel)
      .maybeSingle();
    if (error) throw error;
    return (data as DealerSignupVerificationRow | null) ?? null;
  },

  async upsertVerification(input) {
    const { data, error } = await supabase
      .from("dealer_signup_verifications")
      .upsert({
        session_id: input.sessionId,
        channel: input.channel,
        target_normalized: input.targetNormalized,
        code_hash: input.codeHash,
        expires_at: input.expiresAt,
        attempts: 0,
        verified_at: null,
        consumed_at: null,
        ip_hash: input.ipHash,
        created_at: input.createdAt,
      }, { onConflict: "session_id,channel" })
      .select("*")
      .single();
    if (error) throw error;
    return data as DealerSignupVerificationRow;
  },

  async deleteVerification(id) {
    const { error } = await supabase
      .from("dealer_signup_verifications")
      .delete()
      .eq("id", id);
    if (error) throw error;
  },

  async markVerified(id, verifiedAt) {
    const { error } = await supabase
      .from("dealer_signup_verifications")
      .update({ verified_at: verifiedAt, consumed_at: verifiedAt })
      .eq("id", id);
    if (error) throw error;
  },

  async setVerificationAttempts(id, attempts) {
    const { error } = await supabase
      .from("dealer_signup_verifications")
      .update({ attempts })
      .eq("id", id);
    if (error) throw error;
  },

  async invalidateSessionTokens(sessionId) {
    const { error } = await supabase
      .from("dealer_signup_verification_tokens")
      .update({ consumed_at: new Date().toISOString() })
      .eq("session_id", sessionId)
      .is("consumed_at", null);
    if (error) throw error;
  },

  async createVerificationToken(input) {
    const { error } = await supabase
      .from("dealer_signup_verification_tokens")
      .insert({
        session_id: input.sessionId,
        token_hash: input.tokenHash,
        phone_normalized: input.phoneNormalized,
        email_normalized: input.emailNormalized,
        expires_at: input.expiresAt,
      });
    if (error) throw error;
  },

  async checkRateLimit(ipHash, action, limit) {
    const { data, error } = await supabase.rpc("dealer_signup_record_rate_limit", {
      p_ip_hash: ipHash,
      p_action: action,
      p_limit: limit,
    });
    if (error) throw error;
    const value = (data || {}) as {
      allowed?: unknown;
      remaining?: unknown;
      retry_after_seconds?: unknown;
    };
    return {
      allowed: value.allowed === true,
      remaining: Math.max(0, Number(value.remaining) || 0),
      retry_after_seconds: Math.max(0, Number(value.retry_after_seconds) || 0),
    };
  },
};

function buildDeps(): DealerSignupVerifyDeps {
  const refreshTokenKey = Deno.env.get("DEALER_SIGNUP_GMAIL_REFRESH_TOKEN_KEY") ||
    "order_gmail_refresh_token";
  const from = Deno.env.get("DEALER_SIGNUP_GMAIL_FROM") ||
    "BMQ Đại lý <order@bmq.vn>";
  const replyTo = Deno.env.get("DEALER_SIGNUP_REPLY_TO") || "order@bmq.vn";

  return {
    store,
    sendPhoneOtp: (input) => sendDealerOtpZns(input),
    sendEmail: async (email) => {
      const accessToken = await getGmailAccessToken(
        supabase as unknown as Parameters<typeof getGmailAccessToken>[0],
        refreshTokenKey,
      );
      return await sendGmail({
        accessToken,
        from,
        to: email.to,
        replyTo,
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
    },
  };
}

serve((req) => handleDealerSignupVerify(req, buildDeps()));
