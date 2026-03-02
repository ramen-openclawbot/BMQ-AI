import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const CRON_SECRET = Deno.env.get("PO_INGEST_CRON_SECRET");
    if (CRON_SECRET) {
      const token = req.headers.get("x-cron-secret");
      if (token !== CRON_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const body = await req.json().catch(() => ({}));
    const emails: IncomingEmail[] = Array.isArray(body?.emails) ? body.emails : [];

    if (!emails.length) {
      return new Response(JSON.stringify({ success: true, ingested: 0, note: "No emails provided" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: crmEmails, error: crmError } = await supabase
      .from("mini_crm_customer_emails")
      .select("email, customer_id, mini_crm_customers(default_revenue_channel)")
      .order("created_at", { ascending: true });

    if (crmError) throw crmError;

    const emailMap = new Map<string, { customerId: string; defaultRevenueChannel: string | null }>();
    for (const row of crmEmails || []) {
      const expanded = explodeEmails(String((row as any).email || ""));
      for (const key of expanded) {
        emailMap.set(key, {
          customerId: (row as any).customer_id,
          defaultRevenueChannel: (row as any).mini_crm_customers?.default_revenue_channel || null,
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
        revenue_channel: match?.defaultRevenueChannel || null,
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
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[po-gmail-ingest] Error", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
