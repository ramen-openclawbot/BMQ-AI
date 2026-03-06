import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import * as XLSX from "npm:xlsx@0.18.5";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

const decodeBase64UrlToBytes = (input: string) => {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const raw = atob(normalized + padding);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

const extractPoNumber = (subject: string) => {
  const m = subject.match(/PO\s*([0-9]{6,})/i) || subject.match(/\b(PO[0-9]{6,})\b/i);
  if (!m) return null;
  return m[1].toUpperCase().startsWith("PO") ? m[1].toUpperCase() : `PO${m[1]}`;
};

async function getGoogleAccessToken(supabaseAdmin: any): Promise<string> {
  const { data: gmailTokenData } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "google_gmail_refresh_token")
    .maybeSingle();

  const refreshToken = gmailTokenData?.value;
  if (!refreshToken) throw new Error("Thiếu Gmail refresh token");

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

function mapRowsToItems(rows: Record<string, any>[]) {
  const keyOf = (row: Record<string, any>, candidates: string[]) => {
    const keys = Object.keys(row || {});
    for (const k of keys) {
      const normalized = k.toLowerCase().trim();
      if (candidates.some((c) => normalized.includes(c))) return k;
    }
    return null;
  };

  return rows
    .map((row) => {
      const productNameKey = keyOf(row, ["tên", "ten", "product", "hàng", "item"]);
      const skuKey = keyOf(row, ["mã", "ma", "sku", "code"]);
      const qtyKey = keyOf(row, ["sl", "số lượng", "so luong", "qty", "quantity"]);
      const unitKey = keyOf(row, ["đvt", "dvt", "unit"]);
      const priceKey = keyOf(row, ["đơn giá", "don gia", "unit price", "price"]);
      const amountKey = keyOf(row, ["thành tiền", "thanh tien", "amount", "line total", "total"]);

      const product_name = productNameKey ? String(row[productNameKey] || "").trim() : "";
      const sku = skuKey ? String(row[skuKey] || "").trim() : "";
      const qty = Number(String(qtyKey ? row[qtyKey] ?? 0 : 0).replace(/[,.](?=\d{3}\b)/g, "")) || 0;
      const unit_price = Number(String(priceKey ? row[priceKey] ?? 0 : 0).replace(/[,.](?=\d{3}\b)/g, "")) || 0;
      const line_total = Number(String(amountKey ? row[amountKey] ?? 0 : 0).replace(/[,.](?=\d{3}\b)/g, "")) || qty * unit_price;
      const unit = unitKey ? String(row[unitKey] || "").trim() : "";
      return { sku, product_name, qty, unit, unit_price, line_total };
    })
    .filter((r) => r.product_name && r.qty > 0);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const accessToken = await getGoogleAccessToken(supabase);
    const list = await gmailApi(accessToken, `messages?q=${encodeURIComponent("to:po@bmq.vn kingfoodmart newer_than:2d")}&maxResults=1`);
    const m = Array.isArray(list?.messages) ? list.messages[0] : null;
    if (!m?.id) throw new Error("Không tìm thấy email Kingfoodmart mới nhất");

    const detail = await gmailApi(accessToken, `messages/${m.id}?format=full`);
    const headers = detail?.payload?.headers || [];
    const getHeader = (name: string) => headers.find((h: any) => String(h.name || "").toLowerCase() === name.toLowerCase())?.value || "";

    const from = getHeader("From");
    const subject = getHeader("Subject");
    const dateHeader = getHeader("Date");
    const emailMatch = from.match(/<([^>]+)>/);
    const fromEmail = (emailMatch?.[1] || from).trim().toLowerCase();
    const fromName = from.includes("<") ? from.split("<")[0].trim().replace(/^"|"$/g, "") : null;
    const snippet = detail?.snippet || "";

    const attachmentParts: Array<{ filename: string; mimeType: string; attachmentId: string }> = [];
    const walkParts = (parts: any[] = []) => {
      for (const p of parts) {
        if (p?.filename && p?.body?.attachmentId) {
          attachmentParts.push({ filename: String(p.filename), mimeType: String(p.mimeType || ""), attachmentId: String(p.body.attachmentId) });
        }
        if (Array.isArray(p?.parts)) walkParts(p.parts);
      }
    };
    walkParts(detail?.payload?.parts || []);

    const xlsxFile = attachmentParts.find((a) => /\.xlsx?$/.test(a.filename.toLowerCase()));
    const pdfFile = attachmentParts.find((a) => a.filename.toLowerCase().endsWith(".pdf"));

    let items: any[] = [];
    if (xlsxFile) {
      const attachment = await gmailApi(accessToken, `messages/${m.id}/attachments/${xlsxFile.attachmentId}`);
      const bytes = decodeBase64UrlToBytes(String(attachment?.data || ""));
      const workbook = XLSX.read(bytes, { type: "array" });
      const firstSheet = workbook.SheetNames[0];
      if (firstSheet) {
        const rows = XLSX.utils.sheet_to_json<Record<string, any>>(workbook.Sheets[firstSheet], { defval: "" });
        items = mapRowsToItems(rows);
      }
    }

    const subtotal = items.reduce((sum, it) => sum + Number(it.line_total || 0), 0);

    const { data: customer } = await supabase
      .from("mini_crm_customers")
      .select("id")
      .ilike("customer_name", "%kingfood%")
      .limit(1)
      .maybeSingle();

    const attachmentNames = attachmentParts.map((a) => a.filename);
    const today = new Date();
    const deliveryDate = today.toISOString().slice(0, 10);

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
      matched_customer_id: customer?.id || null,
      match_status: "approved",
      review_note: "Auto-promoted as real PO by admin request",
      reviewed_at: new Date().toISOString(),
      revenue_channel: "agency",
      po_number: extractPoNumber(subject || "") || null,
      delivery_date: deliveryDate,
      subtotal_amount: subtotal || null,
      vat_amount: null,
      total_amount: subtotal || null,
      production_items: items,
      posted_to_revenue: false,
      raw_payload: {
        gmail_id: m.id,
        thread_id: m.threadId,
        snippet,
        subject,
        from,
        parse_meta: {
          promoted_at: new Date().toISOString(),
          source_xlsx: xlsxFile?.filename || null,
          source_pdf: pdfFile?.filename || null,
          item_count: items.length,
        },
      },
    };

    const { data: upserted, error } = await supabase
      .from("customer_po_inbox")
      .upsert(payload, { onConflict: "gmail_message_id" })
      .select("id,po_number,total_amount,match_status,revenue_channel,delivery_date")
      .single();

    if (error) throw error;

    return new Response(JSON.stringify({ success: true, po: upserted, parsedItems: items.length, attachments: attachmentNames }), {
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }
});
