export type PoDraftItem = {
  _rowId: string;
  sku: string;
  product_name: string;
  unit: string;
  qty: number;
  unit_price: number;
  line_total: number;
  specification: string;
  note: string;
  source: string;
};

export const extractPoNumberFromSubject = (subject?: string) => {
  const s = String(subject || "");
  const m = s.match(/\b(PO\d{6,})\b/i) || s.match(/PO\s*(\d{6,})/i);
  if (!m) return "";
  return m[1].toUpperCase().startsWith("PO") ? m[1].toUpperCase() : `PO${m[1]}`;
};

export const extractDeliveryDateFromSubject = (subject?: string) => {
  const s = String(subject || "");
  const m = s.match(/GIAO\s*NGÀY\s*(\d{2})[./-](\d{2})[./-](\d{4})/i);
  if (!m) return "";
  return `${m[3]}-${m[2]}-${m[1]}`;
};

export const formatVnd = (value: any) => `${Number(value || 0).toLocaleString("vi-VN")} ₫`;

export const calcSubtotalFromItems = (items: any[]) =>
  (Array.isArray(items) ? items : []).reduce((sum: number, it: any) => sum + Number(it?.line_total || 0), 0);

export const calcSafeTotal = (subtotal: any, vat: any, fallback: any = 0) => {
  const s = Number(subtotal || 0);
  const v = Number(vat || 0);
  const byParts = s + v;
  if (byParts > 0) return byParts;
  return Number(fallback || 0);
};

export const calcTotalFromRawPayload = (rawPayload: any) => {
  const meta = rawPayload?.parse_meta || {};
  const metaTotal = Number(meta?.total_amount || 0);
  if (metaTotal > 0) return metaTotal;
  const metaSubtotal = Number(meta?.subtotal || 0);
  const metaVat = Number(meta?.vat_amount || 0);
  if (metaSubtotal > 0) return metaSubtotal + metaVat;
  const items = Array.isArray(rawPayload?.parsed_items_preview) ? rawPayload.parsed_items_preview : [];
  return items.reduce((sum: number, it: any) => sum + Number(it?.line_total || 0), 0);
};

export const ALLOWED_PO_LINE_SOURCES = new Set(["parsed", "manually_added", "manually_edited"]);

export const sanitizePoLineSource = (value?: string | null) => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "parsed";
  if (ALLOWED_PO_LINE_SOURCES.has(raw)) return raw;
  if (raw.includes("manual") && raw.includes("add")) return "manually_added";
  if (raw.includes("manual") || raw.includes("edit")) return "manually_edited";
  return "parsed";
};

export const createPoDraftItem = (seed: any = {}): PoDraftItem => {
  const qty = Number(seed?.qty ?? seed?.quantity ?? seed?.qty_total ?? 0) || 0;
  const unitPrice = Number(seed?.unit_price || 0) || 0;
  const explicitLineTotal = Number(seed?.line_total || 0) || 0;
  const lineTotal = explicitLineTotal > 0 ? explicitLineTotal : qty * unitPrice;
  return {
    _rowId: String(seed?._rowId || seed?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    sku: String(seed?.sku || seed?.item_code || ""),
    product_name: String(seed?.product_name || seed?.name || ""),
    unit: String(seed?.unit || "cái"),
    qty,
    unit_price: unitPrice,
    line_total: lineTotal,
    specification: String(seed?.specification || seed?.description || ""),
    note: String(seed?.note || ""),
    source: sanitizePoLineSource(seed?.source || seed?.line_source || seed?.parse_source || (seed?._isManual ? "manually_added" : "parsed")),
  };
};

export const normalizePoDraftItems = (items: any[]) =>
  (Array.isArray(items) ? items : []).map((item: any) => createPoDraftItem(item));

export const createEmptyPoDraftItem = () => createPoDraftItem({ _isManual: true, source: "manually_added" });

export const calcDraftItemLineTotal = (item: any) => {
  const explicit = Number(item?.line_total || 0) || 0;
  if (explicit > 0) return explicit;
  const qty = Number(item?.qty || 0) || 0;
  const unitPrice = Number(item?.unit_price || 0) || 0;
  return qty * unitPrice;
};

export const calcDraftItemsAmount = (items: any[]) =>
  (Array.isArray(items) ? items : []).reduce((sum: number, item: any) => sum + calcDraftItemLineTotal(item), 0);

export const hasManualPoDraft = (po: any) => Boolean(po?.raw_payload?.manual_summary?.edited_at || po?.raw_payload?.manual_summary?.edited);

export const getPoDraftItemsFromRow = (po: any) => {
  if (!po) return [];
  if (hasManualPoDraft(po)) return normalizePoDraftItems(po?.production_items || []);
  if (Array.isArray(po?.production_items) && po.production_items.length > 0) return normalizePoDraftItems(po.production_items);
  if (Array.isArray(po?.raw_payload?.parsed_items_preview)) return normalizePoDraftItems(po.raw_payload.parsed_items_preview);
  return [];
};

export const buildPoDraftSignature = (draft: any) => {
  const items = (Array.isArray(draft?.production_items) ? draft.production_items : []).map((item: any) => ({
    _rowId: String(item?._rowId || ""),
    sku: String(item?.sku || "").trim(),
    product_name: String(item?.product_name || "").trim(),
    unit: String(item?.unit || "").trim(),
    qty: Number(item?.qty || 0) || 0,
    unit_price: Number(item?.unit_price || 0) || 0,
    line_total: Number(item?.line_total || 0) || 0,
    specification: String(item?.specification || "").trim(),
    note: String(item?.note || "").trim(),
    source: sanitizePoLineSource(item?.source),
  }));
  return JSON.stringify({
    customer_id: String(draft?.customer_id || "").trim(),
    po_number: String(draft?.po_number || "").trim(),
    delivery_date: String(draft?.delivery_date || "").trim(),
    subtotal_amount: Number(draft?.subtotal_amount || 0) || 0,
    vat_amount: Number(draft?.vat_amount || 0) || 0,
    total_amount: Number(draft?.total_amount || 0) || 0,
    notes: String(draft?.notes || "").trim(),
    items,
  });
};

export const createDraftFromPoRow = (po: any, fallbackCustomerId?: string | null) => {
  const items = getPoDraftItemsFromRow(po);
  const hasManual = hasManualPoDraft(po);
  const subtotal = hasManual
    ? Number(po?.subtotal_amount || 0)
    : Number(po?.subtotal_amount || po?.raw_payload?.parse_meta?.subtotal || calcSubtotalFromItems(items) || 0);
  const vat = hasManual
    ? Number(po?.vat_amount || 0)
    : Number(po?.vat_amount ?? po?.raw_payload?.parse_meta?.vat_amount ?? 0);
  const total = hasManual
    ? Number(po?.total_amount || calcSafeTotal(subtotal, vat, 0) || 0)
    : Number((subtotal > 0 ? subtotal + vat : 0) || po?.total_amount || po?.raw_payload?.parse_meta?.total_amount || 0);
  return {
    customer_id: po?.customer_id || fallbackCustomerId || "",
    po_number: po?.po_number || extractPoNumberFromSubject(po?.email_subject) || "",
    delivery_date: po?.delivery_date || extractDeliveryDateFromSubject(po?.email_subject) || "",
    subtotal_amount: subtotal || "",
    vat_amount: vat,
    total_amount: total || "",
    notes: String(po?.raw_payload?.manual_summary?.notes || ""),
    production_items: items,
  };
};

export const buildManualSummaryMessage = (po: any) => {
  if (!hasManualPoDraft(po)) return "";
  const editedAt = po?.raw_payload?.manual_summary?.edited_at;
  return `Đang dùng dữ liệu đã chỉnh tay${editedAt ? ` • lưu lúc ${new Date(editedAt).toLocaleString("vi-VN")}` : ""}`;
};

export const parseDraftItemsForSave = (items: any[]) =>
  (Array.isArray(items) ? items : [])
    .map((item: any) => ({
      sku: String(item?.sku || "").trim(),
      product_name: String(item?.product_name || "").trim(),
      unit: String(item?.unit || "").trim() || "cái",
      qty: Number(item?.qty || 0) || 0,
      unit_price: Number(item?.unit_price || 0) || 0,
      line_total: calcDraftItemLineTotal(item),
      specification: String(item?.specification || "").trim(),
      note: String(item?.note || "").trim(),
      line_source: sanitizePoLineSource(item?.source),
    }))
    .filter((item: any) => item.product_name || item.sku || item.qty || item.unit_price || item.line_total || item.note);
