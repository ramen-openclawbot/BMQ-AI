import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

type GmailMessage = {
  id: string;
  threadId: string;
};

const decodeBase64Url = (input: string) => {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const base64 = normalized + padding;
  try {
    return decodeURIComponent(escape(atob(base64)));
  } catch {
    return atob(base64);
  }
};

async function getGoogleAccessToken(supabaseAdmin: any): Promise<string> {
  const { data: tokenData, error } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "google_drive_refresh_token")
    .maybeSingle();

  if (error || !tokenData?.value) {
    throw new Error("Google chưa kết nối hoặc thiếu refresh token");
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Thiếu GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokenData.value,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    throw new Error(`Không thể refresh Google access token: ${err}`);
  }

  const tokens = await tokenResponse.json();
  return tokens.access_token;
}

async function gmailApi(accessToken: string, path: string) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail API error (${res.status}): ${err}`);
  }
  return await res.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const supabaseAdmin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid user token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const maxResults = Math.min(Math.max(Number(body?.maxResults || 20), 1), 100);
    const query = String(body?.query || "to:po@bmq.vn newer_than:14d");

    const accessToken = await getGoogleAccessToken(supabaseAdmin);

    const list = await gmailApi(accessToken, `messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);
    const messages: GmailMessage[] = Array.isArray(list?.messages) ? list.messages : [];

    const { data: crmEmails } = await supabaseAdmin
      .from("mini_crm_customer_emails")
      .select("email, customer_id, mini_crm_customers(default_revenue_channel)");

    const emailMap = new Map<string, { customerId: string; defaultRevenueChannel: string | null }>();
    for (const row of crmEmails || []) {
      const key = String((row as any).email || "").toLowerCase().trim();
      if (!key) continue;
      emailMap.set(key, {
        customerId: (row as any).customer_id,
        defaultRevenueChannel: (row as any).mini_crm_customers?.default_revenue_channel || null,
      });
    }

    let synced = 0;
    for (const m of messages) {
      const detail = await gmailApi(accessToken, `messages/${m.id}?format=full`);
      const headers: Array<{ name: string; value: string }> = detail?.payload?.headers || [];

      const getHeader = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
      const from = getHeader("From");
      const subject = getHeader("Subject");
      const dateHeader = getHeader("Date");

      const emailMatch = from.match(/<([^>]+)>/);
      const fromEmail = (emailMatch?.[1] || from).trim().toLowerCase();
      const fromName = from.includes("<") ? from.split("<")[0].trim().replace(/^"|"$/g, "") : null;

      const snippet = detail?.snippet || "";
      const attachmentNames: string[] = [];

      const walkParts = (parts: any[] = []) => {
        for (const p of parts) {
          if (p?.filename) attachmentNames.push(String(p.filename));
          if (Array.isArray(p?.parts)) walkParts(p.parts);
        }
      };
      walkParts(detail?.payload?.parts || []);

      const match = emailMap.get(fromEmail);
      const payload = {
        gmail_message_id: m.id,
        gmail_thread_id: m.threadId,
        from_email: fromEmail,
        from_name: fromName,
        email_subject: subject || null,
        body_preview: snippet || null,
        has_attachments: attachmentNames.length > 0,
        attachment_names: attachmentNames,
        received_at: dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString(),
        matched_customer_id: match?.customerId || null,
        match_status: match ? "pending_approval" : "unmatched",
        revenue_channel: match?.defaultRevenueChannel || null,
        raw_payload: {
          gmail_id: m.id,
          thread_id: m.threadId,
          snippet,
          subject,
          from,
        },
      };

      const { error } = await supabaseAdmin.from("customer_po_inbox").upsert(payload, { onConflict: "gmail_message_id" });
      if (error) throw error;
      synced += 1;
    }

    return new Response(JSON.stringify({ success: true, synced, query }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[po-gmail-sync] Error", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
