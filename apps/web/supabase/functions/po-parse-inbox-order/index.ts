import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import * as XLSX from "npm:xlsx@0.18.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const decodeBase64UrlToBytes = (input: string) => {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const raw = atob(normalized + padding);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

async function getGoogleAccessToken(supabaseAdmin: any): Promise<string> {
  const { data: gmailTokenData } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "google_gmail_refresh_token")
    .maybeSingle();

  const refreshToken = gmailTokenData?.value;
  if (!refreshToken) throw new Error("Thiếu Google Gmail refresh token");

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

const toNum = (v: any) => Number(String(v ?? "0").replace(/[,.](?=\d{3}\b)/g, "")) || 0;

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
      const qty = toNum(qtyKey ? row[qtyKey] : 0);
      const unit_price = toNum(priceKey ? row[priceKey] : 0);
      const line_total = toNum(amountKey ? row[amountKey] : 0) || (qty * unit_price);
      const unit = unitKey ? String(row[unitKey] || "").trim() : "";

      return { sku, product_name, qty, unit, unit_price, line_total };
    })
    .filter((r) => r.product_name && r.qty > 0);
}

function mapKingfoodFlatRows(rows: any[][]) {
  return rows
    .map((r) => {
      const sku = String(r?.[14] || "").trim();
      const product_name = String(r?.[15] || "").trim();
      const unit = String(r?.[16] || "").trim();
      const qty = toNum(r?.[17] ?? r?.[18] ?? 0);
      const unit_price = toNum(r?.[20] ?? 0);
      const line_total = toNum(r?.[30] ?? 0) || qty * unit_price;
      return { sku, product_name, qty, unit, unit_price, line_total };
    })
    .filter((x) => /^SP\d+/i.test(x.sku) && x.product_name && x.qty > 0);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid user token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const inboxId = String(body?.inboxId || "");
    if (!inboxId) throw new Error("Thiếu inboxId");

    const { data: inbox, error: inboxErr } = await supabase
      .from("customer_po_inbox")
      .select("id,gmail_message_id,raw_payload")
      .eq("id", inboxId)
      .single();
    if (inboxErr || !inbox?.gmail_message_id) throw new Error("Không tìm thấy gmail_message_id");

    const accessToken = await getGoogleAccessToken(supabase);
    const detail = await gmailApi(accessToken, `messages/${inbox.gmail_message_id}?format=full`);

    const attachmentParts: Array<{ filename: string; mimeType: string; attachmentId: string }> = [];
    const walkParts = (parts: any[] = []) => {
      for (const p of parts) {
        if (p?.filename && p?.body?.attachmentId) {
          attachmentParts.push({
            filename: String(p.filename),
            mimeType: String(p.mimeType || ""),
            attachmentId: String(p.body.attachmentId),
          });
        }
        if (Array.isArray(p?.parts)) walkParts(p.parts);
      }
    };
    walkParts(detail?.payload?.parts || []);

    const xlsxFile = attachmentParts.find((a) => a.filename.toLowerCase().endsWith(".xlsx") || a.filename.toLowerCase().endsWith(".xls"));
    const pdfFile = attachmentParts.find((a) => a.filename.toLowerCase().endsWith(".pdf"));

    let items: any[] = [];
    let chosenSheet: string | null = null;
    if (xlsxFile) {
      const attachment = await gmailApi(accessToken, `messages/${inbox.gmail_message_id}/attachments/${xlsxFile.attachmentId}`);
      const bytes = decodeBase64UrlToBytes(String(attachment?.data || ""));
      const workbook = XLSX.read(bytes, { type: "array" });

      for (const sheetName of workbook.SheetNames || []) {
        const rowsObj = XLSX.utils.sheet_to_json<Record<string, any>>(workbook.Sheets[sheetName], { defval: "" });
        const byHeader = mapRowsToItems(rowsObj);

        const rowsFlat = XLSX.utils.sheet_to_json<any[]>(workbook.Sheets[sheetName], { header: 1, raw: false, defval: "" });
        const byFlat = mapKingfoodFlatRows(rowsFlat);

        const parsed = byFlat.length > byHeader.length ? byFlat : byHeader;
        if (parsed.length > items.length) {
          items = parsed;
          chosenSheet = sheetName;
        }
      }
    }

    const subtotal = items.reduce((s, i) => s + Number(i.line_total || 0), 0);
    const parseMeta = {
      parsed_at: new Date().toISOString(),
      parsed_by: user.id,
      parser: "po-parse-inbox-order:v2",
      source_sheet: chosenSheet,
      source_xlsx: xlsxFile?.filename || null,
      source_pdf: pdfFile?.filename || null,
      item_count: items.length,
    };

    const rawPayload = {
      ...(inbox.raw_payload || {}),
      parse_meta: parseMeta,
    };

    const { error: updateError } = await supabase
      .from("customer_po_inbox")
      .update({
        production_items: items,
        subtotal_amount: subtotal || null,
        total_amount: subtotal || null,
        raw_payload: rawPayload,
      })
      .eq("id", inboxId);

    if (updateError) throw updateError;

    return new Response(JSON.stringify({
      success: true,
      inboxId,
      parsed: {
        xlsx: xlsxFile?.filename || null,
        pdf: pdfFile?.filename || null,
        itemCount: items.length,
        subtotal,
      },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
