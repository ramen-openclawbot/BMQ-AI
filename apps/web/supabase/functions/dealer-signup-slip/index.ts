import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getGmailAccessToken, sendGmail } from "../_shared/gmail-send.ts";
import { resolveDealerSession } from "../_shared/dealer.ts";
import { DEALER_SIGNUP_DOCS_BUCKET } from "../_shared/dealer-signup-review.ts";
import {
  DEALER_PAYMENT_SETTING_KEYS,
  dealerPaymentSettingsFromRows,
} from "../_shared/dealer-signup-payment.ts";
import {
  handleDealerSignupSlip,
  type DealerSignupSlipApplication,
  type DealerSignupSlipDeps,
  type DealerSignupSlipStore,
} from "./handler.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const store: DealerSignupSlipStore = {
  async findByTokenHash(hash: string) {
    const { data, error } = await supabase
      .from("dealer_signup_applications")
      .select("id, application_code, business_name, applicant_name, email, phone, status, slip_token_expires_at, crm_customer_id")
      .eq("slip_token_hash", hash)
      .maybeSingle();
    if (error) throw error;
    return (data as DealerSignupSlipApplication | null) ?? null;
  },

  async findWaitingByCustomerId(customerId: string) {
    const { data, error } = await supabase
      .from("dealer_signup_applications")
      .select("id, application_code, business_name, applicant_name, email, phone, status, slip_token_expires_at, crm_customer_id")
      .eq("crm_customer_id", customerId)
      .eq("status", "approved_waiting_slip")
      .maybeSingle();
    if (error) throw error;
    return (data as DealerSignupSlipApplication | null) ?? null;
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

  async upload(path, bytes, contentType) {
    const { error } = await supabase.storage
      .from(DEALER_SIGNUP_DOCS_BUCKET)
      .upload(path, bytes, { contentType, upsert: true });
    if (error) throw error;
  },

  async activate(applicationId, path) {
    const { data, error } = await supabase.rpc("dealer_signup_activate", {
      p_application_id: applicationId,
      p_storage_path: path,
    });
    if (error) throw error;
    const row = (data || {}) as {
      already_active?: unknown;
      already_submitted?: unknown;
      status?: unknown;
    };
    return {
      already_active: row.already_active === true,
      already_submitted: row.already_submitted === true,
      status: row.status ? String(row.status) : "slip_submitted",
    };
  },

  async setLastError(applicationId, code) {
    const { error } = await supabase
      .from("dealer_signup_applications")
      .update({ last_error_code: code.slice(0, 120) })
      .eq("id", applicationId);
    if (error) throw error;
  },
};

function buildDeps(): DealerSignupSlipDeps {
  const refreshTokenKey = Deno.env.get("DEALER_SIGNUP_GMAIL_REFRESH_TOKEN_KEY") ||
    "order_gmail_refresh_token";
  const from = Deno.env.get("DEALER_SIGNUP_GMAIL_FROM") ||
    "BMQ Đại lý <order@bmq.vn>";
  const replyTo = Deno.env.get("DEALER_SIGNUP_REPLY_TO") || "order@bmq.vn";

  return {
    store,
    resolveDealerSession: async (token) => {
      const session = await resolveDealerSession(
        supabase as unknown as Parameters<typeof resolveDealerSession>[0],
        token,
      );
      return session ? { customer: { id: session.customer.id } } : null;
    },
    loadPaymentSettings: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("key, value")
        .in("key", [...DEALER_PAYMENT_SETTING_KEYS]);
      if (error) throw error;
      return dealerPaymentSettingsFromRows(
        (data || []) as Array<{ key: string; value: string | null }>,
      );
    },
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
        attachments: email.attachments,
      });
    },
  };
}

serve((req) => handleDealerSignupSlip(req, buildDeps()));
