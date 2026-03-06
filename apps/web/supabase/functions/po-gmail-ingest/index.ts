import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { requireCronSecret } from "../_shared/auth.ts";

type IncomingEmail = {
  messageId?: string;
  threadId?: string;
  fromEmail: string;
  fromName?: string;
  subject?: string;
  bodyPreview?: string;
  hasAttachments?: boolean;
  attachmentNames?: string[];
  receivedAt?: string;
  rawPayload?: Record<string, unknown>;
};

const normalizeEmail = (value: string) => {
  const raw = String(value || "").trim().toLowerCase();
  const inBracket = raw.match(/<([^>]+)>/)?.[1] || raw;
  return inBracket.trim();
};

const explodeEmails = (value: string): string[] => {
  return String(value || "")
    .split(/[;,\n]+/)
    .map((part) => normalizeEmail(part))
    .filter(Boolean);
};

const revenueChannelFromCustomerGroup = (group: string | null | undefined) => {
  switch (String(group || "").toLowerCase()) {
    case "online":
      return "online";
    case "banhmi_agency":
      return "agency";
    case "b2b":
      return "b2b";
    case "banhmi_point":
    default:
      return "retail";
  }
};

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    requireCronSecret(req, "PO_INGEST_CRON_SECRET", getCorsHeaders(req));

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const body = await req.json().catch(() => ({}));
    const emails: IncomingEmail[] = Array.isArray(body?.emails) ? body.emails : [];

    if (!emails.length) {
      return new Response(JSON.stringify({ success: true, ingested: 0, note: "No emails provided" }), {
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }

    const { data: crmEmails, error: crmError } = await supabase
      .from("mini_crm_customer_emails")
      .select("email, customer_id, mini_crm_customers(customer_group,is_active)")
      .order("created_at", { ascending: true });

    if (crmError) throw crmError;

    const emailMap = new Map<string, { customerId: string; revenueChannel: string | null }>();
    for (const row of crmEmails || []) {
      const isActive = Boolean((row as any).mini_crm_customers?.is_active);
      if (!isActive) continue;
      const expanded = explodeEmails(String((row as any).email || ""));
      for (const key of expanded) {
        emailMap.set(key, {
          customerId: (row as any).customer_id,
          revenueChannel: revenueChannelFromCustomerGroup((row as any).mini_crm_customers?.customer_group || null),
        });
      }
    }

    let ingested = 0;
    for (const item of emails) {
      const fromEmail = normalizeEmail(String(item.fromEmail || ""));
      if (!fromEmail) continue;

      const match = emailMap.get(fromEmail);
      const matchStatus = match ? "pending_approval" : "unmatched";

      const payload = {
        gmail_message_id: item.messageId || null,
        gmail_thread_id: item.threadId || null,
        from_email: fromEmail,
        from_name: item.fromName || null,
        email_subject: item.subject || null,
        body_preview: item.bodyPreview || null,
        has_attachments: Boolean(item.hasAttachments),
        attachment_names: item.attachmentNames || [],
        received_at: item.receivedAt || new Date().toISOString(),
        matched_customer_id: match?.customerId || null,
        match_status: matchStatus,
        revenue_channel: match?.revenueChannel || null,
        raw_payload: item.rawPayload || item,
      };

      const query = supabase.from("customer_po_inbox").upsert(payload, {
        onConflict: "gmail_message_id",
        ignoreDuplicates: false,
      });

      const { error } = await query;
      if (error) throw error;
      ingested += 1;
    }

    return new Response(JSON.stringify({ success: true, ingested }), {
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[po-gmail-ingest] Error", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }
});
