// Pure helpers for reading text-layer PDF invoices.
//
// No Deno / Supabase / AI imports: the handler fetches the bytes and the AI
// fields, these helpers only decide whether a text looks like an invoice and
// turn the model answer into validated numbers. Tests exercise them directly.

export interface PdfInvoiceLine {
  name: string | null;
  unit: string | null;
  quantity: number | null;
  unit_price: number | null;
  amount: number | null;
  vat_rate: number | null;
}

export interface PdfInvoice {
  seller_name: string | null;
  seller_tax_code: string | null;
  buyer_tax_code: string | null;
  invoice_number: string | null;
  invoice_series: string | null;
  invoice_date: string | null;
  subtotal: number | null;
  vat_amount: number | null;
  total_amount: number | null;
  lines: PdfInvoiceLine[];
}

export type PdfInvoiceInvalidReason =
  | "not_invoice"
  | "no_total"
  | "amount_mismatch"
  | "bad_tax_code"
  | "buyer_is_seller";

export type PdfInvoiceValidation =
  | { ok: true }
  | { ok: false; reason: PdfInvoiceInvalidReason };

/** BMQ's own tax code: when it appears as the seller the model read the buyer. */
export const BMQ_TAX_CODE = "0311840107";

/** Fold Vietnamese diacritics (including đ) to plain ASCII. */
export function foldVietnamese(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/**
 * True when the text carries both an invoice word and a tax-code label.
 * Diacritic insensitive, so "HÓA ĐƠN" and "HOA DON" both match.
 */
export function looksLikeInvoiceText(text: string): boolean {
  if (typeof text !== "string" || text.trim() === "") return false;
  const normalized = foldVietnamese(text).toLowerCase().replace(/\s+/g, " ");
  const hasInvoiceWord = /\bhoa\s*don\b/.test(normalized)
    || /\binvoice\b/.test(normalized);
  const hasTaxLabel = /\bma\s*so\s*thue\b/.test(normalized)
    || /\btax\s*code\b/.test(normalized);
  return hasInvoiceWord && hasTaxLabel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Numbers printed on Vietnamese invoices: "." separates thousands and ","
 * separates decimals. Accepts plain JSON numbers too. Returns null when the
 * value is missing or unreadable.
 */
export function parsePdfNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  let text = value.trim();
  if (text === "") return null;
  const negative = text.startsWith("-");
  text = text.replace(/[^\d.,]/g, "");
  if (text === "") return null;

  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");

  if (lastDot !== -1 && lastComma !== -1) {
    // The right-most separator is the decimal one; the other groups thousands.
    const decimalAt = Math.max(lastDot, lastComma);
    const integerPart = text.slice(0, decimalAt).replace(/[.,]/g, "");
    const fractionPart = text.slice(decimalAt + 1).replace(/[.,]/g, "");
    text = fractionPart === "" ? integerPart : `${integerPart}.${fractionPart}`;
  } else if (lastComma !== -1) {
    // Two or more comma groups are thousands ("1,234,567"). A single group is
    // a Vietnamese decimal ("0,204", "10,016").
    text = /^\d{1,3}(,\d{3}){2,}$/.test(text)
      ? text.replace(/,/g, "")
      : text.replace(/,/g, ".");
  } else if (lastDot !== -1) {
    // "." is the Vietnamese thousands separator ("1.234.567", "116.393").
    // A non-grouped dot is a decimal point ("1234.56").
    text = /^\d{1,3}(\.\d{3})+$/.test(text) ? text.replace(/\./g, "") : text;
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function formatIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${
    String(day).padStart(2, "0")
  }`;
}

/** Accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY and DD.MM.YYYY with an optional time. */
export function normalizePdfDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (iso) return formatIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const local = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})(?:\s.*)?$/.exec(text);
  if (local) return formatIsoDate(Number(local[3]), Number(local[2]), Number(local[1]));

  // Vietnamese long form printed at the top of many invoices.
  const longForm = /(\d{1,2})\s*thang\s*(\d{1,2})\s*nam\s*(\d{4})/i.exec(
    foldVietnamese(text),
  );
  if (longForm) {
    return formatIsoDate(Number(longForm[3]), Number(longForm[2]), Number(longForm[1]));
  }

  return null;
}

function digitsOnly(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/\D/g, "");
  return digits === "" ? null : digits;
}

function normalizeLine(raw: unknown): PdfInvoiceLine {
  const line = isRecord(raw) ? raw : {};
  return {
    name: textOrNull(line.name),
    unit: textOrNull(line.unit),
    quantity: parsePdfNumber(line.quantity),
    unit_price: parsePdfNumber(line.unit_price),
    amount: parsePdfNumber(line.amount),
    vat_rate: parsePdfNumber(line.vat_rate),
  };
}

/** Turn the model's possibly-stringy answer into the invoice shape we validate. */
export function normalizePdfInvoice(raw: unknown): PdfInvoice {
  const value = isRecord(raw) ? raw : {};
  const rawLines = Array.isArray(value.lines) ? value.lines : [];
  return {
    seller_name: textOrNull(value.seller_name),
    seller_tax_code: digitsOnly(value.seller_tax_code),
    buyer_tax_code: digitsOnly(value.buyer_tax_code),
    invoice_number: textOrNull(value.invoice_number),
    invoice_series: textOrNull(value.invoice_series),
    invoice_date: normalizePdfDate(value.invoice_date),
    subtotal: parsePdfNumber(value.subtotal),
    vat_amount: parsePdfNumber(value.vat_amount),
    total_amount: parsePdfNumber(value.total_amount),
    lines: rawLines.map(normalizeLine),
  };
}

/**
 * An accepted PDF invoice needs a positive total, a seller tax code of 10 or
 * 13 digits, a seller that is not BMQ itself and, when both parts exist, a
 * total that matches subtotal + VAT within 1 đồng.
 */
export function validatePdfInvoice(
  inv: PdfInvoice | null | undefined,
): PdfInvoiceValidation {
  if (!inv) return { ok: false, reason: "not_invoice" };

  if (inv.total_amount === null || inv.total_amount <= 0) {
    return { ok: false, reason: "no_total" };
  }

  const taxCode = inv.seller_tax_code ?? "";
  if (!/^\d{10}$/.test(taxCode) && !/^\d{13}$/.test(taxCode)) {
    return { ok: false, reason: "bad_tax_code" };
  }
  if (taxCode === BMQ_TAX_CODE) return { ok: false, reason: "buyer_is_seller" };

  if (inv.subtotal !== null && inv.vat_amount !== null) {
    if (Math.abs(inv.subtotal + inv.vat_amount - inv.total_amount) > 1) {
      return { ok: false, reason: "amount_mismatch" };
    }
  }

  return { ok: true };
}
