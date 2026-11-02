import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getGmailAccessToken, sendGmail } from "../_shared/gmail-send.ts";
import {
  createDealerSignupServiceClient,
  createSupabaseDealerSignupStore,
} from "../_shared/dealer-signup-http.ts";
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
