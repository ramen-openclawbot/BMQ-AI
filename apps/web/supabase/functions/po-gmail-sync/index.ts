import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

type GmailMessage = {
  id: string;
  threadId: string;
};

const extractPoNumber = (subject: string) => {
  const m = subject.match(/PO\s*([0-9]{6,})/i) || subject.match(/\b(PO[0-9]{6,})\b/i);
  if (!m) return null;
  return m[1].toUpperCase().startsWith("PO") ? m[1].toUpperCase() : `PO${m[1]}`;
};

const extractDeliveryDate = (subject: string) => {
  const m = subject.match(/GIAO\s*NGÀY\s*(\d{2})[./-](\d{2})[./-](\d{4})/i);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
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

const normalizeEmail = (value: string) => {
  const raw = String(value || "").trim().toLowerCase();
  const inBracket = raw.match(/<([^>]+)>/)?.[1] || raw;
  const candidate = inBracket.trim();
  const direct = candidate.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0];
  if (direct) return direct.toLowerCase();
  const fallback = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0];
  return (fallback || candidate).trim().toLowerCase();
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

async function getGoogleAccessToken(supabaseAdmin: any): Promise<string> {
  const { data: gmailTokenData } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "google_gmail_refresh_token")
    .maybeSingle();

  // backward compatibility: fallback to old shared token key
  const { data: legacyTokenData } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "google_drive_refresh_token")
    .maybeSingle();

  const refreshToken = gmailTokenData?.value || legacyTokenData?.value;

  if (!refreshToken) {
    throw new Error("Chưa kết nối Gmail PO hoặc thiếu refresh token");
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Thiếu GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET");

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
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const supabaseAdmin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    // Enforce JWT authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing auth" }), {
        status: 401,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }
    const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !authUser) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const mode = String(body?.mode || "preview").toLowerCase(); // preview | import
    const includeOnlyCrm = body?.includeOnlyCrm !== false;
    const maxResults = Math.min(Math.max(Number(body?.maxResults || 20), 1), 100);
    const query = String(body?.query || "in:anywhere deliveredto:po@bmq.vn newer_than:30d");
    const importMessageIds = new Set<string>(Array.isArray(body?.messageIds) ? body.messageIds.map((x: any) => String(x)) : []);

    const accessToken = await getGoogleAccessToken(supabaseAdmin);

    const profile = await gmailApi(accessToken, "profile");
    const list = await gmailApi(accessToken, `messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);
    const messages: GmailMessage[] = Array.isArray(list?.messages) ? list.messages : [];

    const { data: crmEmails } = await supabaseAdmin
      .from("mini_crm_customer_emails")
      .select("email, customer_id, mini_crm_customers(customer_group,is_active)");

    const emailMap = new Map<string, { customerId: string; revenueChannel: string | null }>();
    for (const row of crmEmails || []) {
      const rawEmail = String((row as any).email || "");
      const expanded = explodeEmails(rawEmail);
      const isActive = Boolean((row as any).mini_crm_customers?.is_active);
      if (!isActive) continue;
      for (const key of expanded) {
        emailMap.set(key, {
          customerId: (row as any).customer_id,
          revenueChannel: revenueChannelFromCustomerGroup((row as any).mini_crm_customers?.customer_group || null),
        });
      }
    }

    const activeCustomerIds = Array.from(new Set(Array.from(emailMap.values()).map((v) => v.customerId)));
    const { data: activeTemplates } = await supabaseAdmin
      .from("mini_crm_po_templates")
      .select("id, customer_id, template_name, file_name, parser_config, sample_preview, is_active, updated_at")
      .eq("is_active", true)
      .in("customer_id", activeCustomerIds.length ? activeCustomerIds : ["00000000-0000-0000-0000-000000000000"]);

    const templateMap = new Map<string, any>();
    for (const t of activeTemplates || []) {
      templateMap.set(String((t as any).customer_id), t);
    }

    let synced = 0;
    let matchedCount = 0;
    let unmatchedCount = 0;
    let skippedInvalidFrom = 0;
    let upsertErrorCount = 0;
    let skippedNotInCrm = 0;
    const skippedNotInCrmSamples: string[] = [];
    const upsertErrors: Array<{ messageId: string; error: string }> = [];
    const previews: any[] = [];

    for (const m of messages) {
      const detail = await gmailApi(accessToken, `messages/${m.id}?format=full`);
      const headers: Array<{ name: string; value: string }> = detail?.payload?.headers || [];

      const getHeader = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
      const from = getHeader("From");
      const subject = getHeader("Subject");
      const dateHeader = getHeader("Date");

      const fromEmail = normalizeEmail(from);
      if (!fromEmail || !fromEmail.includes("@")) {
        skippedInvalidFrom += 1;
        continue;
      }
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
      if (match) matchedCount += 1;
      else unmatchedCount += 1;

      if (includeOnlyCrm && !match) {
        skippedNotInCrm += 1;
        if (skippedNotInCrmSamples.length < 5) skippedNotInCrmSamples.push(fromEmail);
        continue;
      }

      const template = match?.customerId ? templateMap.get(match.customerId) : null;

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
        revenue_channel: match?.revenueChannel || null,
        po_number: extractPoNumber(subject || ""),
        delivery_date: extractDeliveryDate(subject || ""),
        raw_payload: {
          gmail_id: m.id,
          thread_id: m.threadId,
          snippet,
          subject,
          from,
          template_id: template?.id || null,
          template_name: template?.template_name || null,
        },
      };

      previews.push({
        messageId: m.id,
        threadId: m.threadId,
        fromEmail,
        fromName,
        subject: subject || "(no subject)",
        receivedAt: payload.received_at,
        snippet,
        attachmentNames,
        matchedCustomerId: match?.customerId || null,
        matchStatus: payload.match_status,
        template: template
          ? {
              id: template.id,
              name: template.template_name,
              fileName: template.file_name,
              parserConfig: template.parser_config,
              samplePreview: template.sample_preview,
              updatedAt: template.updated_at,
            }
          : null,
      });

      const shouldImport = mode === "import" && (importMessageIds.size === 0 || importMessageIds.has(m.id));
      if (!shouldImport) continue;

      const { error } = await supabaseAdmin.from("customer_po_inbox").upsert(payload, { onConflict: "gmail_message_id" });
      if (error) {
        upsertErrorCount += 1;
        if (upsertErrors.length < 5) {
          upsertErrors.push({ messageId: m.id, error: String(error.message || error) });
        }
        continue;
      }
      synced += 1;
    }

    const { count: inboxCount } = await supabaseAdmin
      .from("customer_po_inbox")
      .select("id", { count: "exact", head: true });

    return new Response(JSON.stringify({
      success: true,
      mode,
      includeOnlyCrm,
      synced,
      query,
      mailbox: profile?.emailAddress || null,
      resultSizeEstimate: Number(list?.resultSizeEstimate || 0),
      fetched: messages.length,
      previews,
      debug: {
        matchedCount,
        unmatchedCount,
        skippedInvalidFrom,
        skippedNotInCrm,
        skippedNotInCrmSamples,
        upsertErrorCount,
        upsertErrors,
        inboxCount: Number(inboxCount || 0),
      },
    }), {
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[po-gmail-sync] Error", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }
});
