import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getGmailAccessToken, sendGmail } from "../_shared/gmail-send.ts";
import {
  createDealerSignupServiceClient,
  createSupabaseDealerSignupStore,
} from "../_shared/dealer-signup-http.ts";
import {
  DEALER_SIGNUP_DOCS_BUCKET,
  dealerContractDraftPath,
} from "../_shared/dealer-signup-review.ts";
import {
  handleDealerSignupSubmit,
  type DealerSignupSubmitDeps,
} from "./handler.ts";

const FONT_BASE = new URL("../_shared/fonts/", import.meta.url);
const PDF_ASSETS = Promise.all([
  Deno.readFile(new URL("NotoSans-Regular.ttf", FONT_BASE)),
  Deno.readFile(new URL("NotoSans-Bold.ttf", FONT_BASE)),
]).then(([regular, bold]) => ({ regular, bold }));

function buildDeps(): DealerSignupSubmitDeps {
  const supabase = createDealerSignupServiceClient();
  const refreshTokenKey = Deno.env.get("DEALER_SIGNUP_GMAIL_REFRESH_TOKEN_KEY") ||
    "order_gmail_refresh_token";
  const from = Deno.env.get("DEALER_SIGNUP_GMAIL_FROM") ||
    "BMQ Đại lý <order@bmq.vn>";
  const replyTo = Deno.env.get("DEALER_SIGNUP_REPLY_TO") || "order@bmq.vn";

  return {
    store: createSupabaseDealerSignupStore(supabase),
    loadContractAssets: () => PDF_ASSETS,
    approveSignup: async (input) => {
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
    uploadContractDraft: async (applicationId, pdf) => {
      const path = dealerContractDraftPath(applicationId);
      const { error } = await supabase.storage
        .from(DEALER_SIGNUP_DOCS_BUCKET)
        .upload(path, pdf, { contentType: "application/pdf", upsert: true });
      if (error) throw error;
      return path;
    },
    setContractDraft: async (applicationId, path) => {
      const { error } = await supabase.rpc("dealer_signup_set_contract_draft", {
        p_application_id: applicationId,
        p_storage_path: path,
      });
      if (error) throw error;
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

serve((req) => handleDealerSignupSubmit(req, buildDeps()));
