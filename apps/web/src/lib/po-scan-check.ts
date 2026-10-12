/**
 * Pure rules for the PO scan price/unit warning (no React, no Supabase).
 *
 * A scanned purchase-order line is compared against the supplier's most recent
 * previous purchase line for the same normalized product name. The rules only
 * classify and suggest; they never write and never look anything up.
 */

export type PoScanCheckKind = "ok" | "swap" | "price" | "unit";

export interface PoScanLine {
  quantity: number;
  unit: string;
  unit_price: number;
}

export interface PoScanLastLine {
  quantity: number;
  unit: string;
  unit_price: number;
  po_number?: string | null;
}

export interface PoScanSuggestion {
  quantity: number;
  unit: string;
  unit_price: number;
}

export interface PoScanCheckResult {
  kind: PoScanCheckKind;
  message: string | null;
  suggestion: PoScanSuggestion | null;
}

/** A price this many times larger / smaller is treated as a likely misread. */
const OUTLIER_RATIO_HIGH = 5;
const OUTLIER_RATIO_LOW = 0.2;
/** How close the swapped price must sit to the previous price to call a swap. */
const SWAP_MATCH_MIN = 0.8;
const SWAP_MATCH_MAX = 1.25;

function stripAccents(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

/**
 * Accent-free, lowercased unit key mapped back to the canonical Vietnamese
 * spelling. `tu`/`to` -> `tờ` because stripping the accents of `từ` gives `tu`
 * and of `tờ` gives `to`. Unknown units keep their accent-free spelling.
 */
const PO_UNIT_CANONICAL: Readonly<Record<string, string>> = {
  g: "g",
  gr: "g",
  gam: "g",
  gram: "g",
  kg: "kg",
  ki: "kg",
  ky: "kg",
  kgs: "kg",
  kilogam: "kg",
  l: "l",
  lit: "l",
  liter: "l",
  to: "tờ",
  tu: "tờ",
  cai: "cái",
  chiec: "cái",
  goi: "gói",
  hop: "hộp",
  cuon: "cuộn",
  chai: "chai",
  bich: "bịch",
  can: "can",
  bao: "bao",
  qua: "quả",
  con: "con",
  cay: "cây",
  thung: "thùng",
  khoi: "khối",
  binh: "bình",
  nap: "nắp",
};

/** Canonical Vietnamese spelling of a unit, tolerant of common misreads. */
export function normalizePoUnit(unit: string): string {
  const stripped = stripAccents(String(unit ?? "").trim().toLowerCase());
  if (!stripped) return "";
  return PO_UNIT_CANONICAL[stripped] ?? stripped;
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(value);
}

function unitLabel(unit: string | null | undefined): string {
  const label = String(unit ?? "").trim();
  return label || "đơn vị";
}

const OK_RESULT: PoScanCheckResult = { kind: "ok", message: null, suggestion: null };

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Classify one scanned line against the supplier's previous line.
 *
 * - no previous line, or any non-positive quantity/price -> `ok`
 * - price ratio >= 5x or <= 0.2x:
 *   - when the swapped quantity/price lands within 0.8-1.25x of the previous
 *     price, the unit price was probably read as the quantity -> `swap`
 *   - otherwise -> `price`
 * - otherwise, a different canonical unit -> `unit`
 * - otherwise -> `ok`
 */
export function checkScannedLine(
  line: PoScanLine,
  last: PoScanLastLine | null,
): PoScanCheckResult {
  if (!last) return OK_RESULT;

  const lineQuantity = Number(line?.quantity);
  const linePrice = Number(line?.unit_price);
  const lastQuantity = Number(last.quantity);
  const lastPrice = Number(last.unit_price);

  if (
    !isPositive(lineQuantity) ||
    !isPositive(linePrice) ||
    !isPositive(lastQuantity) ||
    !isPositive(lastPrice)
  ) {
    return OK_RESULT;
  }

  const priceRatio = linePrice / lastPrice;
  const outlier = priceRatio >= OUTLIER_RATIO_HIGH || priceRatio <= OUTLIER_RATIO_LOW;
  const suffix = last.po_number ? ` (${last.po_number})` : "";
  const lastUnit = unitLabel(last.unit);

  if (outlier) {
    const swappedPriceRatio = lineQuantity / lastPrice;
    if (swappedPriceRatio >= SWAP_MATCH_MIN && swappedPriceRatio <= SWAP_MATCH_MAX) {
      return {
        kind: "swap",
        message: `Nghi đảo số lượng/đơn giá — lần trước ${formatMoney(lastPrice)}đ/${lastUnit}${suffix}`,
        suggestion: { quantity: linePrice, unit: last.unit, unit_price: lineQuantity },
      };
    }
    return {
      kind: "price",
      message: `Đơn giá lệch nhiều — lần trước ${formatMoney(lastPrice)}đ/${lastUnit}`,
      suggestion: null,
    };
  }

  if (normalizePoUnit(line.unit) !== normalizePoUnit(last.unit)) {
    return {
      kind: "unit",
      message: `Đơn vị khác lần trước (${last.unit})`,
      suggestion: { quantity: lineQuantity, unit: last.unit, unit_price: linePrice },
    };
  }

  return OK_RESULT;
}

/**
 * Check a scanned line against several previous lines (newest first).
 * Swap against some lines but agreement with others means the history itself
 * disagrees (owner 12/10: PO-000775 stored 185 gói × 5.000đ, PO-000744 5.000 tờ × 185đ):
 * warn with both references and no one-tap fix. Otherwise a swap wins, any
 * agreeing line means ok, else the newest line's warning.
 */
export function checkAgainstHistory(line: PoScanLine, history: PoScanLastLine[]): PoScanCheckResult {
  const results = history.map((last) => checkScannedLine(line, last));
  const swapAt = results.findIndex((result) => result.kind === "swap");
  const okAt = results.findIndex((result) => result.kind === "ok");
  if (swapAt >= 0 && okAt >= 0) {
    const ref = (last: PoScanLastLine) => `${formatMoney(last.unit_price)}đ/${unitLabel(last.unit)}${last.po_number ? ` (${last.po_number})` : ""}`;
    return {
      kind: "price",
      message: `Giá các lần trước không khớp nhau: ${ref(history[okAt])} · ${ref(history[swapAt])} — soát lại số lượng và đơn giá`,
      suggestion: null,
    };
  }
  if (swapAt >= 0) return results[swapAt];
  if (!results.length || okAt >= 0) return OK_RESULT;
  return results[0];
}
