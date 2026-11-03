import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { getGmailAccessToken, sendGmail } from "../_shared/gmail-send.ts";
import { buildDealerSignupContractPdf } from "../_shared/dealer-signup-contract.ts";
import {
  DEALER_SIGNUP_DOCS_BUCKET,
  type DealerSignupReviewApplication,
} from "../_shared/dealer-signup-review.ts";
import {
  DEALER_PAYMENT_SETTING_KEYS,
  dealerPaymentSettingsFromRows,
  dealerPaymentSettingsToRows,
  type DealerSignupPaymentSettings,
} from "../_shared/dealer-signup-payment.ts";
import {
  handleDealerSignupReview,
  type DealerSignupReviewActor,
  type DealerSignupReviewDeps,
  type DealerSignupReviewStore,
} from "./handler.ts";

const FONT_BASE = new URL("../_shared/fonts/", import.meta.url);
const PDF_ASSETS = Promise.all([
  Deno.readFile(new URL("NotoSans-Regular.ttf", FONT_BASE)),
  Deno.readFile(new URL("NotoSans-Bold.ttf", FONT_BASE)),
]).then(([regular, bold]) => ({ regular, bold }));

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function authError(req: Request, status: number, code: string): Response {
  return new Response(JSON.stringify({ success: false, error: code, code }), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

async function authenticate(req: Request): Promise<DealerSignupReviewActor> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) throw authError(req, 401, "unauthorized");

  const token = authHeader.slice(7).trim();
  if (!token) throw authError(req, 401, "unauthorized");

  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) throw authError(req, 401, "unauthorized");

  const { data: roles, error: roleError } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id);
  if (roleError) throw authError(req, 500, "role_lookup_failed");

  const isOwner = (roles || []).some((row: { role?: string | null }) => row.role === "owner");

  const permission = async (moduleKey: string, permissionKey: "view" | "edit") => {
    const { data, error } = await supabase.rpc("has_module_permission", {
      _user_id: user.id,
      _module_key: moduleKey,
      _permission: permissionKey,
    });
    if (error) throw authError(req, 500, "permission_lookup_failed");
    return data === true;
  };

  const [crmView, crmEdit, accountingEdit] = await Promise.all([
    permission("crm", "view"),
    permission("crm", "edit"),
    permission("accounting", "edit"),
  ]);

  return {
    userId: user.id,
    isOwner,
    crmView,
    crmEdit,
    accountingEdit,
  };
}

const store: DealerSignupReviewStore = {
  async getApplication(id: string) {
    const { data, error } = await supabase
      .from("dealer_signup_applications")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return (data as DealerSignupReviewApplication | null) ?? null;
  },

  async approve(input) {
    const { data, error } = await supabase.rpc("dealer_signup_approve", {
      p_application_id: input.applicationId,
      p_reviewer: input.reviewerId,
      p_mode: input.mode,
      p_customer_group: input.customerGroup,
      p_product_group: input.productGroup,
      p_slip_token_hash: input.slipTokenHash,
      p_expires_at: input.slipExpiresAt,
    });
    if (error) throw error;
    const row = (data || {}) as Record<string, unknown>;
    return {
      application_id: String(row.application_id || input.applicationId),
      application_code: String(row.application_code || ""),
      status: String(row.status || "approved_waiting_slip"),
      crm_customer_id: row.crm_customer_id ? String(row.crm_customer_id) : null,
      already_approved: row.already_approved === true,
    };
  },

  async setContractDraft(id: string, path: string) {
    const { error } = await supabase.rpc("dealer_signup_set_contract_draft", {
      p_application_id: id,
      p_storage_path: path,
    });
    if (error) throw error;
  },

  async setSignedContract(id: string, path: string, uploadedBy: string) {
    const { error } = await supabase.rpc("dealer_signup_set_signed_contract", {
      p_application_id: id,
      p_storage_path: path,
      p_uploaded_by: uploadedBy,
    });
    if (error) throw error;
  },

  async reject(id: string, reviewerId: string, reason: string) {
    const { error } = await supabase.rpc("dealer_signup_reject", {
      p_application_id: id,
      p_reviewer: reviewerId,
      p_reason: reason,
    });
    if (error) throw error;
  },

  async setLastError(id: string, code: string) {
    const { error } = await supabase
      .from("dealer_signup_applications")
      .update({ last_error_code: code.slice(0, 120) })
      .eq("id", id);
    if (error) throw error;
  },

  async rotateSlipToken(id: string, hash: string, expiresAt: string) {
    const { error } = await supabase
      .from("dealer_signup_applications")
      .update({ slip_token_hash: hash, slip_token_expires_at: expiresAt })
      .eq("id", id)
      .in("status", ["approved_waiting_slip", "email_failed"]);
    if (error) throw error;
  },

  async confirmPayment(id: string, reviewerId: string) {
    const { data, error } = await supabase.rpc("dealer_signup_confirm_payment", {
      p_application_id: id,
      p_reviewer: reviewerId,
    });
    if (error) throw error;
    const row = (data || {}) as Record<string, unknown>;
    return {
      application_id: String(row.application_id || id),
      application_code: String(row.application_code || ""),
      status: String(row.status || "active"),
      crm_customer_id: row.crm_customer_id ? String(row.crm_customer_id) : null,
      already_active: row.already_active === true,
      payment_confirmed_at: row.payment_confirmed_at ? String(row.payment_confirmed_at) : null,
    };
  },

  async rejectSlip(
    id: string,
    reviewerId: string,
    reason: string,
    newTokenHash: string,
    expiresAt: string,
  ) {
    const { data, error } = await supabase.rpc("dealer_signup_reject_slip", {
      p_application_id: id,
      p_reviewer: reviewerId,
      p_reason: reason,
      p_new_token_hash: newTokenHash,
      p_expires_at: expiresAt,
    });
    if (error) throw error;
    const row = (data || {}) as Record<string, unknown>;
    return {
      application_id: String(row.application_id || id),
      application_code: String(row.application_code || ""),
      status: String(row.status || "approved_waiting_slip"),
      slip_reject_reason: String(row.slip_reject_reason || reason),
      slip_expires_at: String(row.slip_expires_at || expiresAt),
    };
  },

  async loadPaymentSettings() {
    const { data, error } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", [...DEALER_PAYMENT_SETTING_KEYS]);
    if (error) throw error;
    return dealerPaymentSettingsFromRows(
      (data || []) as Array<{ key: string; value: string | null }>,
    );
  },

  async savePaymentSettings(settings: DealerSignupPaymentSettings) {
    const rows = dealerPaymentSettingsToRows(settings).map((row) => ({
      ...row,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .from("app_settings")
      .upsert(rows, { onConflict: "key" });
    if (error) throw error;
  },
};

function buildDeps(): DealerSignupReviewDeps {
  const refreshTokenKey = Deno.env.get("DEALER_SIGNUP_GMAIL_REFRESH_TOKEN_KEY") ||
    "order_gmail_refresh_token";
  const from = Deno.env.get("DEALER_SIGNUP_GMAIL_FROM") ||
    "BMQ Đại lý <order@bmq.vn>";
  const replyTo = Deno.env.get("DEALER_SIGNUP_REPLY_TO") || "order@bmq.vn";

  return {
    authenticate,
    store,
    buildContractPdf: buildDealerSignupContractPdf,
    loadContractAssets: () => PDF_ASSETS,
    uploadDocument: async (path, bytes, contentType) => {
      const { error } = await supabase.storage
        .from(DEALER_SIGNUP_DOCS_BUCKET)
        .upload(path, bytes, { contentType, upsert: true });
      if (error) throw error;
    },
    createSignedUrl: async (path, expiresInSeconds) => {
      const { data, error } = await supabase.storage
        .from(DEALER_SIGNUP_DOCS_BUCKET)
        .createSignedUrl(path, expiresInSeconds);
      if (error) throw error;
      if (!data?.signedUrl) throw new Error("signed_url_missing");
      return data.signedUrl;
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
        cc: email.cc,
        replyTo,
        subject: email.subject,
        html: email.html,
        text: email.text,
        attachments: email.attachments,
      });
    },
  };
}

serve((req) => handleDealerSignupReview(req, buildDeps()));
