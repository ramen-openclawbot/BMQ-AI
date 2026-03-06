import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

async function getGoogleAccessToken(supabaseAdmin: any): Promise<string> {
  const { data: gmailTokenData } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "google_gmail_refresh_token")
    .maybeSingle();

  const { data: legacyTokenData } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "google_drive_refresh_token")
    .maybeSingle();

  const refreshToken = gmailTokenData?.value || legacyTokenData?.value;
  if (!refreshToken) throw new Error("Missing Gmail refresh token");

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Missing Google OAuth client env");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenResponse.ok) throw new Error(await tokenResponse.text());
  const tokens = await tokenResponse.json();
  return tokens.access_token;
}

async function gmailApi(accessToken: string, path: string) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    const debugSecret = Deno.env.get("PO_DEBUG_SECRET");
    if (debugSecret) {
      const token = req.headers.get("x-debug-secret");
      if (token !== debugSecret) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } });
      }
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const body = await req.json().catch(() => ({}));
    const query = String(body?.query || "to:po@bmq.vn newer_than:2d");

    const accessToken = await getGoogleAccessToken(supabase);
    const list = await gmailApi(accessToken, `messages?q=${encodeURIComponent(query)}&maxResults=5`);
    const messages = Array.isArray(list?.messages) ? list.messages : [];

    const results: any[] = [];
    for (const m of messages) {
      const detail = await gmailApi(accessToken, `messages/${m.id}?format=full`);
      const headers = detail?.payload?.headers || [];
      const getHeader = (name: string) => headers.find((h: any) => String(h.name || "").toLowerCase() === name.toLowerCase())?.value || "";

      const attachments: Array<{ filename: string; mimeType: string; hasAttachmentId: boolean }> = [];
      const walk = (parts: any[] = []) => {
        for (const p of parts) {
          if (p?.filename) {
            attachments.push({
              filename: String(p.filename),
              mimeType: String(p.mimeType || ""),
              hasAttachmentId: Boolean(p?.body?.attachmentId),
            });
          }
          if (Array.isArray(p?.parts)) walk(p.parts);
        }
      };
      walk(detail?.payload?.parts || []);

      results.push({
        messageId: m.id,
        threadId: m.threadId,
        from: getHeader("From"),
        subject: getHeader("Subject"),
        date: getHeader("Date"),
        snippet: detail?.snippet || "",
        attachments,
        hasPdf: attachments.some((a) => a.filename.toLowerCase().endsWith(".pdf") || a.mimeType.includes("pdf")),
        hasXlsx: attachments.some((a) => a.filename.toLowerCase().endsWith(".xlsx") || a.mimeType.includes("spreadsheet") || a.mimeType.includes("excel")),
      });
    }

    return new Response(JSON.stringify({ success: true, query, count: results.length, messages: results }, null, 2), {
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }
});
