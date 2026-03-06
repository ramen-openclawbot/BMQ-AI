import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import * as XLSX from "npm:xlsx@0.18.5";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

const decodeBase64UrlToBytes = (input: string) => {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const raw = atob(normalized + padding);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

async function getGoogleAccessToken(supabaseAdmin: any): Promise<string> {
  const { data } = await supabaseAdmin.from("app_settings").select("value").eq("key", "google_gmail_refresh_token").maybeSingle();
  const refreshToken = data?.value;
  if (!refreshToken) throw new Error("Missing Gmail refresh token");
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Missing Google OAuth env");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token" }),
  });
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j.access_token;
}

async function gmailApi(accessToken: string, path: string) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", { auth: { persistSession: false, autoRefreshToken: false } });
    const accessToken = await getGoogleAccessToken(supabase);

    const { data: row } = await supabase
      .from("customer_po_inbox")
      .select("id,gmail_message_id,email_subject")
      .ilike("email_subject", "%KINGFOODMART%")
      .order("received_at", { ascending: false })
      .limit(1)
      .single();

    const detail = await gmailApi(accessToken, `messages/${row.gmail_message_id}?format=full`);
    const parts: Array<{ filename: string; attachmentId: string }> = [];
    const walk = (arr: any[] = []) => {
      for (const p of arr) {
        if (p?.filename && p?.body?.attachmentId) parts.push({ filename: String(p.filename), attachmentId: String(p.body.attachmentId) });
        if (Array.isArray(p?.parts)) walk(p.parts);
      }
    };
    walk(detail?.payload?.parts || []);

    const xlsxFile = parts.find((p) => /\.xlsx?$/.test(p.filename.toLowerCase()));
    if (!xlsxFile) throw new Error("Không có file XLSX");

    const attachment = await gmailApi(accessToken, `messages/${row.gmail_message_id}/attachments/${xlsxFile.attachmentId}`);
    const bytes = decodeBase64UrlToBytes(String(attachment?.data || ""));
    const wb = XLSX.read(bytes, { type: "array" });

    const sheets = (wb.SheetNames || []).map((name) => {
      const ws = wb.Sheets[name];
      const jsonRows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, raw: false, defval: "" });
      const sample = jsonRows.slice(0, 25);
      return {
        name,
        rowCount: jsonRows.length,
        colCountMax: jsonRows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0),
        sample,
      };
    });

    return new Response(JSON.stringify({ success: true, inboxId: row.id, subject: row.email_subject, xlsx: xlsxFile.filename, sheets }, null, 2), {
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }
});
