/**
 * Pure data layer for the temporary "Rà soát nhập kho" tab.
 *
 * Server contract (apps/web/supabase/migrations/20261102720000_kho_review.sql):
 *   kho_review_list() -> { items, materials }
 *   kho_review_link_line(uuid, uuid, numeric, uuid) -> KhoReviewLinkResult
 *   kho_review_create_item_from_line(uuid, text, text, text, numeric, uuid)
 *     -> KhoReviewLinkResult
 *
 * Jev slice (apps/web/supabase/migrations/20261102740000_kho_review_jev.sql):
 *   kho_review_list() also returns target_key + the latest jev_* marks;
 *   kho_review_jev_feedback(text, uuid, text, uuid) records the human decision.
 *
 * Read/fix slice (apps/web/supabase/migrations/20261102750000_kho_review_read_line.sql):
 *   kho-review-read-line reads one line's photo (Indra OCR, DeepSeek fallback);
 *   kho_review_line_context(uuid), kho_review_fix_line_unit(uuid, text, uuid),
 *   kho_review_undo_unit_fix(uuid) and kho_review_factor_hint(uuid, uuid, text)
 *   are the database-gated helpers behind it.
 *
 * `items` are active items that have a place at a kho and either no linked
 * receipt line or a negative balance there.  `materials` are canonical recipe
 * ingredients whose cogs_ingredient_stock_map row is still missing / suggested.
 * Every row carries up to 5 candidate receipt lines.
 */

export type KhoReviewLocation = "tan_tao" | "q7";

/** 'no_docs_negative' means both reasons apply to the same item/kho row. */
export type KhoReviewReason = "no_docs" | "negative" | "no_docs_negative";

/** Jev suggestion only; Jev never links or creates anything by itself. */
export type KhoReviewJevVerdict = "same_item" | "different" | "unsure";

export interface KhoReviewCandidate {
  receipt_item_id: string;
  receipt_number: string;
  receipt_date: string;
  /** goods_receipts.receiving_location (null only on legacy rows). */
  location: KhoReviewLocation | null;
  supplier_name: string | null;
  product_name: string;
  unit: string | null;
  actual_quantity: number | null;
  unit_price: number | null;
  image_url: string | null;
  /** shared words / target words, 0..1. */
  score: number;
  /** Alias target already recorded for this supplier + name + kho. */
  linked_item_id: string | null;
  /** A 'gr-item:' ledger movement already exists for the line. */
  posted: boolean;
  /** Latest Jev mark for this (target, receipt line) pair, if any. */
  jev_verdict: KhoReviewJevVerdict | null;
  jev_probability: number | null;
  jev_model: string | null;
}

export interface KhoReviewItem {
  item_id: string;
  item_code: string;
  name: string;
  unit: string;
  item_class: string | null;
  location: KhoReviewLocation;
  qty: number;
  reason: KhoReviewReason;
  /** 'i:<item_id>:<location>' — same key the server and Jev marks use. */
  target_key: string;
  candidates: KhoReviewCandidate[];
}

export interface KhoReviewMaterial {
  canonical_material_id: string;
  name: string;
  /** public.normalize_document_unit(recipe unit). */
  recipe_unit: string;
  sku_codes: string[];
  /** 'm:<canonical_material_id>:<recipe_unit>' — same key the server uses. */
  target_key: string;
  candidates: KhoReviewCandidate[];
}

export interface KhoReviewList {
  items: KhoReviewItem[];
  materials: KhoReviewMaterial[];
}

export interface KhoReviewLinkResult {
  status: "linked" | "created";
  /** Only the create-from-line result carries item_id. */
  item_id?: string;
  alias_id: string;
  posted: boolean;
  location: KhoReviewLocation;
}

export interface KhoReviewJevFeedbackResult {
  status: "recorded";
  updated: number;
  target_key: string;
  receipt_item_id: string;
  human_action: "linked" | "dismissed";
}

export type KhoReviewOcrEngine = "indra" | "deepseek";

/** One photo read of a candidate receipt line; never a link or an item. */
export interface KhoReviewLineRead {
  ok: true;
  found: boolean;
  /** public.normalize_document_unit() spelling of the printed unit. */
  doc_unit: string | null;
  doc_quantity: number | null;
  doc_unit_price: number | null;
  /** Only when the document prints a pack count, e.g. "Hộp 100 cái". */
  pack_count: number | null;
  pack_unit: string | null;
  evidence_text: string | null;
  /** The printed unit differs from the currently stored line unit. */
  unit_mismatch: boolean;
  ocr_engine: KhoReviewOcrEngine;
  ocr_fallback_reason: string | null;
  cached: boolean;
}

export type KhoReviewFactorSource =
  | "approved_conversion"
  | "alias"
  | "name_pack"
  | "standard";

/** A server-proven factor only; null source means "type it yourself". */
export interface KhoReviewFactorHint {
  factor: number | null;
  source: KhoReviewFactorSource | null;
}

/** Short Vietnamese label for the item/kho row reason. */
export function reviewReasonText(reason: KhoReviewReason): string {
  switch (reason) {
    case "no_docs":
      return "Chưa có phiếu mua";
    case "negative":
      return "Đang âm";
    case "no_docs_negative":
      return "Chưa có phiếu mua, đang âm";
  }
}

/**
 * Short Vietnamese label for one Jev suggestion.  A same-item mark carries the
 * probability as a percentage; different / unsure do not.  No mark -> null.
 */
export function jevVerdictText(
  verdict: KhoReviewJevVerdict | null | undefined,
  probability: number | null | undefined,
): string | null {
  if (verdict === null || verdict === undefined) return null;
  switch (verdict) {
    case "same_item": {
      if (typeof probability !== "number" || !Number.isFinite(probability)) {
        return "Jev: đúng món";
      }
      const clamped = Math.max(0, Math.min(1, probability));
      return `Jev: đúng món ${Math.round(clamped * 100)}%`;
    }
    case "different":
      return "Jev: khác loại";
    case "unsure":
      return "Jev: chưa chắc";
  }
}

const MEASURE_FACTORS: Record<string, Record<string, number>> = {
  kg: { g: 1000 },
  g: { g: 1 },
  l: { ml: 1000 },
  ml: { ml: 1 },
};

/**
 * Standard factor for a receipt line unit -> the item's standard unit.
 * kg -> g = 1000, l -> ml = 1000, the same unit = 1, anything else = null
 * (the owner types the factor instead of the client guessing).
 */
export function suggestedFactor(
  lineUnit: string | null | undefined,
  itemUnit: string | null | undefined,
): number | null {
  const from = (lineUnit ?? "").trim().toLowerCase();
  const to = (itemUnit ?? "").trim().toLowerCase();
  if (from === "" || to === "") return null;
  if (from === to) return 1;
  return MEASURE_FACTORS[from]?.[to] ?? null;
}

/** Same obvious-misread map as public.normalize_document_unit (for display only). */
function normalizeUnit(value: string | null | undefined): string {
  let v = (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  v = v.replace(/^\s*\(\s*kg\s*\)\s*$/, "kg");
  v = v.replace(/\s*\(\s*pack\s*\)\s*$/i, "");
  v = v.replace(/\([^()]*\)/g, "").replace(/[()]/g, "").trim();
  v = v.replace(/\s+/g, " ");
  switch (v) {
    case "ky":
    case "ký":
    case "kilogram":
      return "kg";
    case "b bao":
      return "bao";
    case "hop":
    case "hôp":
      return "hộp";
    default:
      return v;
  }
}

function formatQuantity(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toLocaleString("vi-VN", { maximumFractionDigits: 3 });
}

/**
 * Short sentence when the printed unit differs from the stored line unit, e.g.
 * "Phiếu ghi 7 hộp, dữ liệu đang là kg".  No mismatch / no printed unit -> null.
 */
export function unitMismatchText(
  read: Pick<KhoReviewLineRead, "found" | "doc_unit" | "doc_quantity">,
  storedUnit: string | null | undefined,
): string | null {
  const docUnit = (read.doc_unit ?? "").trim();
  const stored = (storedUnit ?? "").trim();
  if (!read.found || docUnit === "" || stored === "") return null;
  if (normalizeUnit(docUnit) === normalizeUnit(stored)) return null;
  const quantity = read.doc_quantity;
  const printed = typeof quantity === "number" && Number.isFinite(quantity) && quantity > 0
    ? `${formatQuantity(quantity)} ${docUnit}`
    : docUnit;
  return `Phiếu ghi ${printed}, dữ liệu đang là ${stored}`;
}

/**
 * Prefill the factor from printed pack content only when the pack unit is the
 * item unit, e.g. read "Hộp 100 cái" for a "cái" item -> 100.  Never guesses.
 */
export function factorFromRead(
  read: Pick<KhoReviewLineRead, "found" | "pack_count" | "pack_unit">,
  itemUnit: string | null | undefined,
): number | null {
  const packUnit = (read.pack_unit ?? "").trim();
  const target = (itemUnit ?? "").trim();
  if (!read.found || packUnit === "" || target === "") return null;
  if (normalizeUnit(packUnit) !== normalizeUnit(target)) return null;
  if (typeof read.pack_count !== "number" || !Number.isFinite(read.pack_count) || read.pack_count <= 0) {
    return null;
  }
  return read.pack_count;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return "";
  const record = error as {
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  return [record.message, record.details, record.hint]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ");
}

/**
 * Short Vietnamese sentence for an RPC error.  The long `item_not_found`
 * check runs after `goods_receipt_item_not_found` because it is a substring.
 */
export function khoReviewErrorText(error: unknown): string {
  const text = errorText(error);
  if (text.includes("kho_review_forbidden")) {
    return "Anh/chị không có quyền rà soát nhập kho.";
  }
  if (text.includes("unknown_unit")) {
    return "Đơn vị mới không hợp lệ.";
  }
  if (text.includes("line_posted")) {
    return "Dòng phiếu đã ghi sổ kho, không sửa được đơn vị.";
  }
  if (text.includes("line_linked")) {
    return "Dòng phiếu đã liên kết mặt hàng, không sửa được đơn vị.";
  }
  if (text.includes("no_image")) {
    return "Dòng phiếu này chưa có ảnh để đọc.";
  }
  if (text.includes("ocr_failed")) {
    return "Chưa đọc được ảnh phiếu. Anh/chị thử lại giúp.";
  }
  if (text.includes("not_on_document")) {
    return "Không thấy dòng hàng này trên phiếu.";
  }
  if (text.includes("fix_not_found")) {
    return "Không tìm thấy lần sửa đơn vị.";
  }
  if (text.includes("invalid_request") || text.includes("invalid_json")) {
    return "Yêu cầu không hợp lệ.";
  }
  if (text.includes("timeout")) {
    return "Đọc phiếu quá lâu, anh/chị thử lại giúp.";
  }
  if (text.includes("invalid_factor")) {
    return "Hệ số quy đổi phải lớn hơn 0.";
  }
  if (text.includes("goods_receipt_item_not_found")) {
    return "Không tìm thấy dòng phiếu nhập.";
  }
  if (text.includes("item_not_found")) {
    return "Không tìm thấy mặt hàng.";
  }
  if (text.includes("item_wrong_kho")) {
    return "Mặt hàng không thuộc kho của phiếu này.";
  }
  if (text.includes("invalid_class")) {
    return "Nhóm hàng không hợp lệ.";
  }
  if (text.includes("not_found")) {
    return "Không tìm thấy dòng phiếu nhập.";
  }
  return "Có lỗi xảy ra, anh/chị thử lại giúp.";
}
