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
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

const toNum = (v: any) => Number(String(v ?? "0").replace(/[,.](?=\d{3}\b)/g, "")) || 0;

function mapRowsToItems(rows: Record<string, any>[]) {
  const findKey = (row: Record<string, any>, candidates: string[]) => {
    for (const k of Object.keys(row || {})) {
      const n = k.toLowerCase();
      if (candidates.some((c) => n.includes(c))) return k;
    }
    return null;
  };

  return rows
    .map((row) => {
      const kName = findKey(row, ["tên", "ten", "product", "hàng", "item"]);
      const kSku = findKey(row, ["mã", "ma", "sku", "code"]);
      const kQty = findKey(row, ["sl", "số lượng", "so luong", "qty", "quantity"]);
      const kUnit = findKey(row, ["đvt", "dvt", "unit"]);
      const kPrice = findKey(row, ["đơn giá", "don gia", "unit price", "price"]);
      const kAmount = findKey(row, ["thành tiền", "thanh tien", "amount", "line total", "total"]);

      const product_name = kName ? String(row[kName] || "").trim() : "";
      const sku = kSku ? String(row[kSku] || "").trim() : "";
      const qty = toNum(kQty ? row[kQty] : 0);
      const unit_price = toNum(kPrice ? row[kPrice] : 0);
      const line_total = toNum(kAmount ? row[kAmount] : 0) || qty * unit_price;
      const unit = kUnit ? String(row[kUnit] || "").trim() : "";
      return { sku, product_name, qty, unit, unit_price, line_total };
    })
    .filter((x) => x.product_name && x.qty > 0);
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
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", { auth: { persistSession: false, autoRefreshToken: false } });
    const accessToken = await getGoogleAccessToken(supabase);

    const { data: row } = await supabase
      .from("customer_po_inbox")
      .select("id,gmail_message_id,raw_payload")
      .ilike("email_subject", "%KINGFOODMART%")
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!row?.gmail_message_id) throw new Error("Không tìm thấy PO Kingfoodmart trong inbox");

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
    if (!xlsxFile) throw new Error("Không có file XLSX để parse");

    const attachment = await gmailApi(accessToken, `messages/${row.gmail_message_id}/attachments/${xlsxFile.attachmentId}`);
    const bytes = decodeBase64UrlToBytes(String(attachment?.data || ""));
    const wb = XLSX.read(bytes, { type: "array" });
    let bestItems: any[] = [];
    let bestSheet = "";
    for (const sheet of wb.SheetNames || []) {
      const rowsObj = XLSX.utils.sheet_to_json<Record<string, any>>(wb.Sheets[sheet], { defval: "" });
      const parsedByHeader = mapRowsToItems(rowsObj);

      const rowsFlat = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sheet], { header: 1, raw: false, defval: "" });
      const parsedFlat = mapKingfoodFlatRows(rowsFlat);

      const parsed = parsedFlat.length > parsedByHeader.length ? parsedFlat : parsedByHeader;
      if (parsed.length > bestItems.length) {
        bestItems = parsed;
        bestSheet = sheet;
      }
    }
    const items = bestItems;
    const subtotal = items.reduce((s, i) => s + Number(i.line_total || 0), 0);

    const parseMeta = {
      parsed_at: new Date().toISOString(),
      source_xlsx: xlsxFile.filename,
      source_sheet: bestSheet || null,
      item_count: items.length,
      subtotal,
    };

    const updatePayload: any = {
      raw_payload: { ...(row.raw_payload || {}), parse_meta: parseMeta, parsed_items_preview: items.slice(0, 100) },
    };

    // Try new columns if available
    updatePayload.production_items = items;
    updatePayload.subtotal_amount = subtotal;
    updatePayload.total_amount = subtotal;

    let updateErr: any = null;
    const { error } = await supabase.from("customer_po_inbox").update(updatePayload).eq("id", row.id);
    updateErr = error;
    if (updateErr && String(updateErr.message || "").includes("column")) {
      // fallback for old schema
      const { error: fallbackErr } = await supabase
        .from("customer_po_inbox")
        .update({ raw_payload: { ...(row.raw_payload || {}), parse_meta: parseMeta, parsed_items_preview: items.slice(0, 100) } })
        .eq("id", row.id);
      if (fallbackErr) throw fallbackErr;
    } else if (updateErr) {
      throw updateErr;
    }

    return new Response(JSON.stringify({ success: true, inboxId: row.id, itemCount: items.length, subtotal, xlsx: xlsxFile.filename, sheet: bestSheet || null }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
