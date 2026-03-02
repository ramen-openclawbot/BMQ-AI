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

const toNum = (v: any) => {
  const raw = String(v ?? "").trim();
  if (!raw) return 0;

  // Giữ lại ký tự số + dấu phân cách thập phân/nghìn
  const s = raw.replace(/[^\d,.-]/g, "");
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  const normalize = (input: string, decimalSep: "," | ".") => {
    const parts = input.split(decimalSep);
    if (parts.length === 1) return input.replace(/[,.]/g, "");
    const decimal = parts.pop() || "";
    const integer = parts.join("").replace(/[,.]/g, "");
    return `${integer}.${decimal}`;
  };

  let normalized = s;
  if (hasComma && hasDot) {
    // Dấu xuất hiện sau cùng được xem là dấu thập phân
    normalized = s.lastIndexOf(",") > s.lastIndexOf(".") ? normalize(s, ",") : normalize(s, ".");
  } else if (hasComma) {
    normalized = /,\d{1,2}$/.test(s) ? normalize(s, ",") : s.replace(/,/g, "");
  } else if (hasDot) {
    normalized = /\.\d{1,2}$/.test(s) ? normalize(s, ".") : s.replace(/\./g, "");
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
};
const normalizeDate = (v: any): string | null => {
  const s = String(v || "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (m) {
    const mm = m[1].padStart(2, "0");
    const dd = m[2].padStart(2, "0");
    return `${m[3]}-${mm}-${dd}`;
  }
  return s.slice(0, 10);
};

const sanitizeVat = (subtotal: number, vat: number, vatRate: number) => {
  const s = Number(subtotal || 0);
  const v = Number(vat || 0);
  const byRate = vatRate > 0 ? Math.round(s * (vatRate / 100)) : Math.round(s * 0.08);
  if (s <= 0) return 0;
  if (v <= 0) return byRate;
  // VAT thực tế không thể lớn hơn 30% subtotal cho case PO hiện tại
  if (v > s * 0.3) return byRate;
  return v;
};

const sanitizeTotal = (subtotal: number, vat: number, total: number) => {
  const s = Number(subtotal || 0);
  const v = Number(vat || 0);
  const t = Number(total || 0);
  const expected = s + v;
  if (expected <= 0) return t > 0 ? t : 0;
  if (t <= 0) return expected;
  // chống parse nhầm cột gây total bị nhân/cộng sai lệch lớn
  if (t > expected * 1.5 || t < expected * 0.5) return expected;
  return t;
};

const parseByTemplateConfig = (rowsFlat: any[][], template: any) => {
  const cfg = template?.parser_config || {};
  const snapshotItems = Array.isArray(template?.confirmation_snapshot?.items) ? template.confirmation_snapshot.items : [];
  const allowedSourceNames = new Set(snapshotItems.map((x: any) => String(x?.sourceColumnName || x?.product || "").trim()).filter(Boolean));
  const nameOverrides = cfg?.productNameOverrides || {};
  const rawQuantityColumns = Array.isArray(cfg?.quantityColumns) ? cfg.quantityColumns : [];
  const quantityColumns = allowedSourceNames.size
    ? rawQuantityColumns.filter((q: any) => allowedSourceNames.has(String(q?.columnName || "").trim()))
    : rawQuantityColumns;
  if (!quantityColumns.length) return [] as any[];

  const headerRow = Number(cfg?.headerRow || 2);
  const dateColumnName = String(cfg?.dateColumnName || "Ngày/Date").toLowerCase();
  const header = rowsFlat?.[headerRow - 1] || [];
  let dateColIdx = header.findIndex((c: any) => String(c || "").toLowerCase().replace(/\s+/g, " ").includes(dateColumnName));
  if (dateColIdx < 0) dateColIdx = 1; // B column fallback

  const items: any[] = [];
  // rowsFlat là mảng 0-based: headerRow=2 => first data row index phải là 2 (Excel row 3)
  for (let r = Math.max(2, headerRow); r < rowsFlat.length; r += 1) {
    const row = rowsFlat[r] || [];
    const first = String(row?.[0] || "").toUpperCase();
    if (first.includes("TỔNG CỘNG") || first.includes("TONG CONG")) continue;

    const rawDate = row?.[dateColIdx];
    const date = normalizeDate(rawDate);
    if (!date) continue;

    for (const q of quantityColumns) {
      const colIndex = Number(q?.columnIndex || 0) - 1;
      if (colIndex < 0) continue;
      const qty = toNum(row?.[colIndex]);
      if (qty <= 0) continue;
      const sourceName = String(q?.columnName || `Cột ${colIndex + 1}`).trim();
      items.push({
        date,
        product_name: String(nameOverrides?.[sourceName] || sourceName).trim(),
        source_column_name: sourceName,
        sku: "",
        qty,
        unit: "",
        unit_price: 0,
        line_total: 0,
      });
    }
  }
  return items;
};

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
      // Không dùng cột [30] vì có file chứa giá trị tổng/định dạng gây nhân sai
      const line_total = qty * unit_price;
      return { sku, product_name, qty, unit, unit_price, line_total };
    })
    .filter((x) => /^SP\d+/i.test(x.sku) && x.product_name && x.qty > 0);
}

function extractKingfoodTotals(rows: any[][]) {
  const candidate = rows.find((r) => /^SP\d+/i.test(String(r?.[14] || "").trim()));
  if (!candidate) return { subtotal: 0, vat: 0, total: 0, vatRate: 0, poOrderDate: null as string | null };

  const headerRowIdx = rows.findIndex((r) =>
    (r || []).some((c) => {
      const t = String(c || "").toLowerCase();
      return t.includes("tổng tiền po (-vat)") || t.includes("tong tien po (-vat)");
    })
  );

  let subtotalIdx = 33;
  let vatIdx = 34;
  let totalIdx = 35;

  if (headerRowIdx >= 0) {
    const header = rows[headerRowIdx] || [];
    header.forEach((c, idx) => {
      const t = String(c || "").toLowerCase().trim();
      if (t.includes("tổng tiền po (-vat)") || t.includes("tong tien po (-vat)")) subtotalIdx = idx;
      if (t.includes("tổng thuế") || t.includes("tong thue")) vatIdx = idx;
      if (t.includes("tổng tiền po (+vat)") || t.includes("tong tien po (+vat)")) totalIdx = idx;
    });
  }

  const subtotal = toNum(candidate?.[subtotalIdx] ?? 0);
  const vat = toNum(candidate?.[vatIdx] ?? 0);
  const total = toNum(candidate?.[totalIdx] ?? 0);
  const vatRate = toNum(candidate?.[29] ?? 0);
  const poOrderDate = candidate?.[42] ? String(candidate[42]) : null;
  return { subtotal, vat, total, vatRate, poOrderDate };
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
      .select("id,gmail_message_id,matched_customer_id,raw_payload,received_at")
      .eq("id", inboxId)
      .single();
    if (inboxErr || !inbox?.gmail_message_id) throw new Error("Không tìm thấy gmail_message_id");

    const templateId = inbox?.raw_payload?.template_id || null;
    let activeTemplate: any = null;
    if (inbox?.matched_customer_id) {
      const { data } = await supabase
        .from("mini_crm_po_templates")
        .select("id,customer_id,template_name,parser_config,confirmation_snapshot,version_no,is_active")
        .eq("customer_id", inbox.matched_customer_id)
        .eq("is_active", true)
        .order("version_no", { ascending: false })
        .limit(1)
        .maybeSingle();
      activeTemplate = data || null;
    }
    if (!activeTemplate && templateId) {
      const { data } = await supabase
        .from("mini_crm_po_templates")
        .select("id,customer_id,template_name,parser_config,confirmation_snapshot,version_no,is_active")
        .eq("id", templateId)
        .maybeSingle();
      activeTemplate = data || null;
    }

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
    let extractedSubtotal = 0;
    let extractedVat = 0;
    let extractedTotal = 0;
    let extractedVatRate = 0;
    let extractedPoOrderDate: string | null = null;
    if (xlsxFile) {
      const attachment = await gmailApi(accessToken, `messages/${inbox.gmail_message_id}/attachments/${xlsxFile.attachmentId}`);
      const bytes = decodeBase64UrlToBytes(String(attachment?.data || ""));
      const workbook = XLSX.read(bytes, { type: "array" });

      for (const sheetName of workbook.SheetNames || []) {
        const rowsObj = XLSX.utils.sheet_to_json<Record<string, any>>(workbook.Sheets[sheetName], { defval: "" });
        const byHeader = mapRowsToItems(rowsObj);

        const rowsFlat = XLSX.utils.sheet_to_json<any[]>(workbook.Sheets[sheetName], { header: 1, raw: false, defval: "" });
        const byFlat = mapKingfoodFlatRows(rowsFlat);
        const byTemplate = activeTemplate ? parseByTemplateConfig(rowsFlat, activeTemplate) : [];
        const totalsFlat = extractKingfoodTotals(rowsFlat);

        const parsed = byTemplate.length > 0 ? byTemplate : (byFlat.length > byHeader.length ? byFlat : byHeader);
        if (parsed.length > items.length) {
          items = parsed;
          chosenSheet = sheetName;
          extractedSubtotal = totalsFlat.subtotal || 0;
          extractedVat = totalsFlat.vat || 0;
          extractedTotal = totalsFlat.total || 0;
          extractedVatRate = totalsFlat.vatRate || 0;
          extractedPoOrderDate = totalsFlat.poOrderDate || null;
        }
      }
    }

    const subtotalByLineTotal = items.reduce((s, i) => s + Number(i.line_total || 0), 0);
    const subtotalByQtyPrice = items.reduce((s, i) => s + (Number(i.qty || 0) * Number(i.unit_price || 0)), 0);
    const subtotalFromItems = (subtotalByQtyPrice > 0 && (subtotalByLineTotal > subtotalByQtyPrice * 1.5 || subtotalByLineTotal < subtotalByQtyPrice * 0.5))
      ? subtotalByQtyPrice
      : subtotalByLineTotal;
    // Kingfood sheet đã có subtotal chuẩn ở cột tổng hợp -> ưu tiên dùng để tránh lệch tạm tính
    const subtotal = extractedSubtotal > 0 ? extractedSubtotal : subtotalFromItems;
    const vatAmount = sanitizeVat(subtotal, extractedVat, extractedVatRate);
    const totalAmount = sanitizeTotal(subtotal, vatAmount, extractedTotal);
    const parseMeta = {
      parsed_at: new Date().toISOString(),
      parsed_by: user.id,
      parser: "po-parse-inbox-order:v5",
      source_sheet: chosenSheet,
      source_xlsx: xlsxFile?.filename || null,
      source_pdf: pdfFile?.filename || null,
      item_count: items.length,
      po_order_date: normalizeDate(extractedPoOrderDate) || normalizeDate(inbox.received_at),
      subtotal: subtotal,
      vat_amount: vatAmount,
      total_amount: totalAmount,
      subtotal_source: extractedSubtotal > 0 ? "sheet_subtotal_col_33" : "sum(qty*unit_price)",
      template_id: activeTemplate?.id || null,
      template_version_no: activeTemplate?.version_no || null,
      template_name: activeTemplate?.template_name || null,
      parse_mode: activeTemplate ? "crm_template" : "fallback_auto",
    };

    const rawPayload = {
      ...(inbox.raw_payload || {}),
      parse_meta: parseMeta,
      parsed_items_preview: items.slice(0, 200),
    };

    const { error: updateError } = await supabase
      .from("customer_po_inbox")
      .update({
        production_items: items,
        subtotal_amount: subtotal || null,
        vat_amount: vatAmount || 0,
        total_amount: totalAmount || subtotal || null,
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
        vat: vatAmount,
        total: totalAmount,
        items,
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
