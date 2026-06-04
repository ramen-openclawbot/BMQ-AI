import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";

type GmailAttachmentPart = {
  filename: string;
  mimeType: string;
  attachmentId: string;
};

function jsonResponse(req: Request, status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

function decodeBase64UrlToBytes(data: string): Uint8Array {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function safeDownloadName(name: string) {
  return name.replace(/[\r\n]/g, " ").replace(/[\\/]/g, "_").trim() || "po-attachment";
}

async function gmailApi(accessToken: string, path: string) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(await response.text());
  return await response.json();
}

async function getGoogleAccessToken(supabaseAdmin: any): Promise<string> {
  const { data } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "google_gmail_refresh_token")
    .maybeSingle();
  const refreshToken = data?.value;
  if (!refreshToken) throw new Error("Missing Gmail refresh token");

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Missing Google OAuth client env");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!tokenResponse.ok) throw new Error(await tokenResponse.text());
  const tokenJson = await tokenResponse.json();
  if (!tokenJson.access_token) throw new Error("Google token response missing access_token");
  return String(tokenJson.access_token);
}

async function userCanViewProduction(supabaseAdmin: any, userId: string): Promise<boolean> {
  const { data: roles, error: rolesError } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .limit(10);
  if (rolesError) throw rolesError;
  if ((roles || []).some((row: any) => row.role === "owner" || row.role === "admin")) return true;

  const { data: perms, error: permsError } = await supabaseAdmin
    .from("user_module_permissions")
    .select("module_key,can_view,can_edit")
    .eq("user_id", userId)
    .in("module_key", ["production_q7", "production"]);
  if (permsError) throw permsError;
  return (perms || []).some((row: any) => Boolean(row.can_view || row.can_edit));
}

function collectAttachmentParts(parts: any[] = [], out: GmailAttachmentPart[] = []) {
  for (const part of parts) {
    if (part?.filename && part?.body?.attachmentId) {
      out.push({
        filename: String(part.filename),
        mimeType: String(part.mimeType || "application/octet-stream"),
        attachmentId: String(part.body.attachmentId),
      });
    }
    if (Array.isArray(part?.parts)) collectAttachmentParts(part.parts, out);
  }
  return out;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  if (req.method !== "POST") return jsonResponse(req, 405, { error: "Method not allowed" });

  const corsHeaders = getCorsHeaders(req);
  try {
    const { user } = await requireAuth(req, corsHeaders);
    const supabaseAdmin = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (!(await userCanViewProduction(supabaseAdmin, user.id))) {
      return jsonResponse(req, 403, { error: "Forbidden: production view permission required" });
    }

    const body = await req.json().catch(() => ({}));
    const inboxId = String(body?.inboxId || "").trim();
    const filename = String(body?.filename || "").trim();
    if (!inboxId || !filename) return jsonResponse(req, 400, { error: "Missing inboxId or filename" });

    const { data: po, error: poError } = await supabaseAdmin
      .from("customer_po_inbox")
      .select("id,gmail_message_id,attachment_names,po_number")
      .eq("id", inboxId)
      .maybeSingle();
    if (poError) throw poError;
    if (!po?.gmail_message_id) return jsonResponse(req, 404, { error: "PO email source not found" });

    const allowedNames = Array.isArray(po.attachment_names) ? po.attachment_names.map((name: unknown) => String(name)) : [];
    if (!allowedNames.includes(filename)) return jsonResponse(req, 403, { error: "Attachment is not registered on this PO" });

    const accessToken = await getGoogleAccessToken(supabaseAdmin);
    const detail = await gmailApi(accessToken, `messages/${po.gmail_message_id}?format=full`);
    const part = collectAttachmentParts(detail?.payload?.parts || []).find((candidate) => candidate.filename === filename);
    if (!part) return jsonResponse(req, 404, { error: "Attachment not found in Gmail message" });

    const attachment = await gmailApi(accessToken, `messages/${po.gmail_message_id}/attachments/${part.attachmentId}`);
    const bytes = decodeBase64UrlToBytes(String(attachment?.data || ""));
    const downloadName = safeDownloadName(part.filename);
    const contentType = part.mimeType || "application/octet-stream";

    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `inline; filename="${downloadName}"`,
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("po-gmail-attachment error", error);
    return jsonResponse(req, 500, { error: String((error as Error)?.message || error) });
  }
});
