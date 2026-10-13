/**
 * Read the unit of measure written in the trailing parentheses of a PO line
 * name, e.g. "BAO PE 13X23 (BAO 10 KG)" -> "bao".
 *
 * Vietnamese purchase orders routinely append the unit (sometimes with the
 * packing, e.g. "(HỘP 100 CÁI)") inside a parenthesised suffix. GPT often puts
 * that whole bracket into the product name and leaves `unit` empty or wrong, so
 * the scan-purchase-order edge function applies this pure override after parsing
 * the tool-call JSON. Only the last parentheses counts, and only when it closes
 * at the very end of the (right-trimmed) name.
 */
import { stripVietnamese } from "./bank-slip-ocr.ts";

/** First token (accent/case-insensitive, `đ` -> `d`) -> canonical unit label. */
const UNIT_BY_FIRST_TOKEN: Record<string, string> = {
  kg: "kg",
  ki: "kg",
  ky: "kg",
  g: "g",
  gr: "g",
  gram: "g",
  l: "l",
  lit: "l",
  ml: "ml",
  cuon: "cuộn",
  hop: "hộp",
  bao: "bao",
  thung: "thùng",
  chai: "chai",
  lon: "lon",
  goi: "gói",
  bich: "bịch",
  cai: "cái",
  con: "con",
  tui: "túi",
};

/**
 * Extract the unit from the final parenthesised group of `name`.
 * Returns null when there is no trailing bracket, the bracket is empty, or its
 * first token is not a recognized unit (e.g. "(Hàng Nhập)", "(40/50gsm)").
 */
export const unitFromNameSuffix = (name: unknown): string | null => {
  if (typeof name !== "string") return null;

  const trimmed = name.trimEnd();
  if (!trimmed.endsWith(")")) return null;

  const match = /\(([^()]*)\)$/.exec(trimmed);
  if (!match) return null;

  const firstToken = match[1].trim().split(/\s+/)[0] ?? "";
  if (!firstToken) return null;

  return UNIT_BY_FIRST_TOKEN[stripVietnamese(firstToken)] ?? null;
};

/**
 * Return a copy of `items` where every object line whose `product_name` ends in
 * a recognized unit bracket gets `unit` overwritten with that unit. Product
 * name, quantity and prices are never touched, and the input array/objects are
 * not mutated. Non-object entries are passed through unchanged.
 */
export const applyNameSuffixUnits = (items: unknown): unknown[] => {
  if (!Array.isArray(items)) return [];

  return items.map((item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;

    const record = item as Record<string, unknown>;
    const unit = unitFromNameSuffix(record.product_name);
    return unit === null ? { ...record } : { ...record, unit };
  });
};
