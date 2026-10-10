/**
 * Pure normalization helpers for the CEO cash-expense OCR slice.
 *
 * No Deno/OpenAI/DB imports so the same rules can be unit-tested and reused by
 * the scan edge function. The SQL record RPC keeps its own server-side copy of
 * the business limits; the values here must stay in sync.
 */

export const CEO_CASH_MAX_AMOUNT = 50_000_000;
export const CEO_CASH_MAX_AGE_DAYS = 90;
export const CEO_CASH_MAX_PAYEE_LENGTH = 160;
export const CEO_CASH_MAX_DESCRIPTION_LENGTH = 500;
export const CEO_CASH_MAX_PRODUCT_NAME_LENGTH = 200;
export const CEO_CASH_MAX_UNIT_LENGTH = 32;
export const CEO_CASH_MAX_ITEMS = 50;
export const CEO_CASH_UNMAPPED_CATEGORY = "UNMAPPED_REVIEW";

export interface CeoCashExpenseOcrItem {
  product_name: string;
  quantity: number;
  unit: string | null;
  unit_price: number;
  line_total: number;
  cost_category_code: string;
}

export interface CeoCashExpenseOcrResult {
  payee_name: string | null;
  expense_date: string | null;
  amount: number;
  description: string;
  cost_category_code: string;
  items: CeoCashExpenseOcrItem[];
}

const foldVietnamese = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();

const UNIT_MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  nghin: 1_000,
  ngan: 1_000,
  tr: 1_000_000,
  trieu: 1_000_000,
  m: 1_000_000,
  million: 1_000_000,
  ty: 1_000_000_000,
};

const parseNumericSeparators = (input: string): number | null => {
  const cleaned = input.replace(/[^0-9,.-]/g, "");
  if (!cleaned) return null;

  const commaCount = (cleaned.match(/,/g) || []).length;
  const dotCount = (cleaned.match(/\./g) || []).length;
  let normalized = cleaned;

  if (commaCount > 0 && dotCount > 0) {
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");
    normalized = lastComma > lastDot
      ? cleaned.replace(/\./g, "").replace(",", ".").replace(/,/g, "")
      : cleaned.replace(/,/g, "");
  } else if (commaCount > 0) {
    const parts = cleaned.split(",");
    const tail = parts[parts.length - 1] || "";
    normalized = parts.length > 2 || tail.length === 3
      ? cleaned.replace(/,/g, "")
      : tail.length === 2
        ? cleaned.replace(",", ".")
        : cleaned.replace(/,/g, "");
  } else if (dotCount > 0) {
    const parts = cleaned.split(".");
    const tail = parts[parts.length - 1] || "";
    normalized = parts.length > 2 || tail.length === 3
      ? cleaned.replace(/\./g, "")
      : tail.length === 2
        ? cleaned
        : cleaned.replace(/\./g, "");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
};

/**
 * Parse common Vietnamese cash-expense amounts:
 *   "1.250.000" -> 1250000, "1,250,000đ" -> 1250000,
 *   "1tr2" -> 1200000, "50k" -> 50000, "2,5tr" -> 2500000.
 */
export function parseVnAmount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }

  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const folded = foldVietnamese(raw).replace(/\s+/g, "");
  const shorthand = folded.match(/^(\d+(?:[.,]\d+)?)(k|nghin|ngan|tr|trieu|m|million|ty)(\d*)$/);
  if (shorthand) {
    const base = Number(shorthand[1].replace(",", "."));
    const multiplier = UNIT_MULTIPLIERS[shorthand[2]] ?? 1;
    let scaled = base;
    const extra = shorthand[3];
    if (extra) {
      const digits = extra.replace(/[^0-9]/g, "");
      if (digits) scaled += Number(digits) / Math.pow(10, digits.length);
    }
    const total = scaled * multiplier;
    return Number.isFinite(total) && total > 0 ? Math.round(total) : null;
  }

  return parseNumericSeparators(folded);
}

const isValidYmd = (year: number, month: number, day: number): string | null => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

/** Parse dd/mm/yyyy (also dd-mm-yyyy / yyyy-mm-dd / Date) to YYYY-MM-DD or null. */
export function parseVnDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return isValidYmd(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return isValidYmd(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dmy) {
    let year = Number(dmy[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    return isValidYmd(year, Number(dmy[2]), Number(dmy[1]));
  }

  return null;
}

export function truncateText(value: unknown, max: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return max > 0 ? text.slice(0, max) : text;
}

export function normalizeCostCategory(value: unknown, allowed: readonly string[]): string {
  const code = truncateText(value, 64).toUpperCase();
  const safeAllowed = new Set(
    (Array.isArray(allowed) ? allowed : [])
      .map((entry) => String(entry ?? "").trim().toUpperCase())
      .filter(Boolean),
  );
  if (code && (safeAllowed.size === 0 || safeAllowed.has(code))) return code;
  return CEO_CASH_UNMAPPED_CATEGORY;
}

const parsePositiveNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  const raw = String(value ?? "").replace(",", ".").replace(/[^0-9.\-]/g, "");
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Normalize the raw `extract_cash_expense` tool output into a safe draft shape:
 * VN amounts, dd/mm/yyyy dates, active cost categories (else UNMAPPED_REVIEW) and
 * length-capped strings. Never throws.
 */
export function normalizeCeoCashExpenseOcr(
  raw: unknown,
  allowedCategories: readonly string[],
): CeoCashExpenseOcrResult {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const allowed = Array.from(new Set(
    [...(Array.isArray(allowedCategories) ? allowedCategories : []), CEO_CASH_UNMAPPED_CATEGORY]
      .map((entry) => String(entry ?? "").trim().toUpperCase())
      .filter(Boolean),
  ));

  const payeeName = truncateText(
    source.payee_name ?? source.payeeName ?? source.payee,
    CEO_CASH_MAX_PAYEE_LENGTH,
  );
  const expenseDate = parseVnDate(source.expense_date ?? source.expenseDate ?? source.date);
  const amount = parseVnAmount(source.total_amount ?? source.totalAmount ?? source.amount) ?? 0;
  const description = truncateText(
    source.description ?? source.content ?? source.note ?? source.notes,
    CEO_CASH_MAX_DESCRIPTION_LENGTH,
  );
  const category = normalizeCostCategory(
    source.cost_category_code ?? source.costCategoryCode ?? source.category,
    allowed,
  );

  const rawItems = Array.isArray(source.items) ? source.items : [];
  const items: CeoCashExpenseOcrItem[] = rawItems
    .slice(0, CEO_CASH_MAX_ITEMS)
    .map((entry): CeoCashExpenseOcrItem => {
      const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      const quantity = parsePositiveNumber(item.quantity ?? item.qty) ?? 1;
      const unitPrice = parseVnAmount(item.unit_price ?? item.unitPrice) ?? 0;
      const lineTotal = parseVnAmount(item.line_total ?? item.lineTotal)
        ?? Math.round(quantity * unitPrice);
      const itemCategory = normalizeCostCategory(
        item.cost_category_code ?? item.costCategoryCode ?? item.category,
        allowed,
      );
      const effectiveCategory = itemCategory === CEO_CASH_UNMAPPED_CATEGORY
        && category !== CEO_CASH_UNMAPPED_CATEGORY
        ? category
        : itemCategory;

      return {
        product_name: truncateText(
          item.product_name ?? item.productName ?? item.name,
          CEO_CASH_MAX_PRODUCT_NAME_LENGTH,
        ) || description,
        quantity,
        unit: truncateText(item.unit, CEO_CASH_MAX_UNIT_LENGTH) || null,
        unit_price: unitPrice,
        line_total: lineTotal,
        cost_category_code: effectiveCategory,
      };
    })
    .filter((item) => item.product_name.length > 0 || item.line_total > 0);

  return {
    payee_name: payeeName || null,
    expense_date: expenseDate,
    amount,
    description,
    cost_category_code: category,
    items,
  };
}
