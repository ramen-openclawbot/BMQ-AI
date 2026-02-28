import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const extractPoNumber = (subject: string) => {
  const m = subject.match(/PO\s*([0-9]{6,})/i) || subject.match(/\b(PO[0-9]{6,})\b/i);
  if (!m) return null;
  return m[1].toUpperCase().startsWith("PO") ? m[1].toUpperCase() : `PO${m[1]}`;
};

async function getGoogleAccessToken(supabaseAdmin: any): Promise<string> {
  const { data } = await supabaseAdmin.from("app_settings").select("value").eq("key", "google_gmail_refresh_token").maybeSingle();
  const refreshToken = data?.value;
  if (!refreshToken) throw new Error("Missing Gmail refresh token");

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Missing Google OAuth env");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token" }),
  });
  if (!tokenResponse.ok) throw new Error(await tokenResponse.text());
  const tokens = await tokenResponse.json();
  return tokens.access_token;
}

async function gmailApi(accessToken: string, path: string) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const accessToken = await getGoogleAccessToken(supabase);
    const list = await gmailApi(accessToken, `messages?q=${encodeURIComponent("to:po@bmq.vn kingfoodmart newer_than:2d")}&maxResults=1`);
    const msg = Array.isArray(list?.messages) ? list.messages[0] : null;
    if (!msg?.id) throw new Error("Không tìm thấy email Kingfoodmart mới");

    const detail = await gmailApi(accessToken, `messages/${msg.id}?format=full`);
    const headers = detail?.payload?.headers || [];
    const getHeader = (name: string) => headers.find((h: any) => String(h.name || "").toLowerCase() === name.toLowerCase())?.value || "";

    const from = getHeader("From");
    const subject = getHeader("Subject");
    const dateHeader = getHeader("Date");
    const emailMatch = from.match(/<([^>]+)>/);
    const fromEmail = (emailMatch?.[1] || from).trim().toLowerCase();
    const fromName = from.includes("<") ? from.split("<")[0].trim().replace(/^"|"$/g, "") : null;

    const attachmentNames: string[] = [];
    const walk = (parts: any[] = []) => {
      for (const p of parts) {
        if (p?.filename) attachmentNames.push(String(p.filename));
        if (Array.isArray(p?.parts)) walk(p.parts);
      }
    };
    walk(detail?.payload?.parts || []);

    const { data: customer } = await supabase
      .from("mini_crm_customers")
      .select("id,default_revenue_channel")
      .ilike("customer_name", "%kingfood%")
      .limit(1)
      .maybeSingle();

    const today = new Date().toISOString().slice(0, 10);

    const payload = {
      gmail_message_id: msg.id,
      gmail_thread_id: msg.threadId,
      from_email: fromEmail,
      from_name: fromName,
      email_subject: subject || null,
      body_preview: detail?.snippet || null,
      has_attachments: attachmentNames.length > 0,
      attachment_names: attachmentNames,
      // Force today for quick testing visibility
      received_at: new Date().toISOString(),
      matched_customer_id: customer?.id || null,
      match_status: "approved",
      review_note: `Set as real PO for today (${today}) by admin request`,
      reviewed_at: new Date().toISOString(),
      revenue_channel: customer?.default_revenue_channel || "cake_kingfoodmart",
      raw_payload: {
        gmail_id: msg.id,
        thread_id: msg.threadId,
        subject,
        from,
        po_number_guess: extractPoNumber(subject || "") || null,
      },
    };

    const { data: row, error } = await supabase
      .from("customer_po_inbox")
      .upsert(payload, { onConflict: "gmail_message_id" })
      .select("id,match_status,revenue_channel,attachment_names,received_at,email_subject")
      .single();

    if (error) throw error;

    return new Response(JSON.stringify({ success: true, po: row, po_number_guess: extractPoNumber(subject || "") }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
