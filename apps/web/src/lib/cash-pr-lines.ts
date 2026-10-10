// Pure helpers for the dedicated "Tạo chi tiền mặt" form. No Supabase / React /
// network imports: the dialog turns each scan-invoice result into one khoản, and
// this module mirrors the server-side validation of
// public.create_cash_payment_request so the operator sees the Vietnamese error
// before the RPC. The server still re-validates every field.

export const CASH_PR_MAX_ITEMS = 30;
export const CASH_PR_MAX_ITEM_NAME = 200;
export const CASH_PR_MAX_ITEM_AMOUNT = 50_000_000;
export const CASH_PR_MAX_TOTAL = 200_000_000;
export const CASH_PR_MAX_TITLE = 200;

export interface CashPrScanItem {
  product_name?: string | null;
  quantity?: number | null;
  unit_price?: number | null;
}

export interface CashPrScanExtracted {
  total_amount?: number | null;
  supplier_name?: string | null;
  description?: string | null;
  invoice_number?: string | null;
  items?: CashPrScanItem[] | null;
}

export interface CashPrLine {
  name: string;
  amount: number | null;
}

export interface CashPrItemInput {
  name: string;
  amount: number;
  cost_category_code?: string | null;
}

export interface CashPrFormInput {
  title: string;
  description?: string | null;
  items: CashPrItemInput[];
}

export interface CashPrValidationResult {
  ok: boolean;
  messages: string[];
  total: number;
}

const MAX_ITEM_NAME = CASH_PR_MAX_ITEM_NAME;

const toAmount = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const cap = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;

// Accent/case-insensitive key used to compare payee vs description and to
// detect placeholder supplier names the AI sometimes returns.
const foldKey = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();

const PLACEHOLDER_SUPPLIER_KEYS = new Set([
  "",
  "-",
  "--",
  "n/a",
  "na",
  "unknown",
  "khong biet",
  "khong ro",
  "khong co",
  "hoa don",
]);

// Labels the reader sometimes returns as the "description" of an app screenshot.
const GENERIC_DESCRIPTION_KEYS = new Set([
  "tai khoan",
  "tong",
  "tong tien",
  "tong cong",
  "thanh toan",
  "thanh tien",
  "so tien",
  "tien mat",
  "nguoi nhan tra tien mat",
  "chi tiet thanh toan",
]);

/** True when the scanned supplier name carries no information ('Không biết', '-', ...). */
export function isPlaceholderSupplierName(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return PLACEHOLDER_SUPPLIER_KEYS.has(foldKey(String(value)));
}

/**
 * Turn ONE scan-invoice result into ONE khoản:
 *   amount = extracted.total_amount when > 0, else the sum of
 *            quantity * unit_price over the items, else null;
 *   name   = "payee — description" when a description is present (payee only
 *            when it is not a placeholder and not already inside the
 *            description), else supplier_name, else the first item name
 *            (+ " + N khoản khác" when there are more), else "Hoá đơn
 *            <index+1>", capped at 200 chars.
 */
export function cashLineFromScan(
  extracted: CashPrScanExtracted | null | undefined,
  index: number,
): CashPrLine {
  const items = Array.isArray(extracted?.items) ? (extracted?.items as CashPrScanItem[]) : [];

  let amount = toAmount(extracted?.total_amount);
  if (amount === null || amount <= 0) {
    const summed = items.reduce((sum, item) => {
      const quantity = toAmount(item?.quantity) ?? 0;
      const unitPrice = toAmount(item?.unit_price) ?? 0;
      return sum + quantity * unitPrice;
    }, 0);
    amount = summed > 0 ? summed : null;
  }

  const supplierName = toText(extracted?.supplier_name);
  const payeeName = supplierName && !isPlaceholderSupplierName(supplierName) ? supplierName : null;
  const rawDescription = toText(extracted?.description);
  const invoiceNumber = toText(extracted?.invoice_number);
  // A payment label ("Tài khoản", "Tổng tiền"...) is not a description: use the order number instead.
  const description = rawDescription && !GENERIC_DESCRIPTION_KEYS.has(foldKey(rawDescription))
    ? rawDescription
    : invoiceNumber;

  let name: string;
  if (description) {
    const descriptionKey = foldKey(description);
    const payeeAlreadyIncluded = payeeName !== null && descriptionKey.includes(foldKey(payeeName));
    name = payeeName && !payeeAlreadyIncluded ? `${payeeName} — ${description}` : description;
  } else if (payeeName) {
    name = payeeName;
  } else {
    const firstName = toText(items[0]?.product_name);
    if (firstName) {
      const others = items.length - 1;
      name = others > 0 ? `${firstName} + ${others} khoản khác` : firstName;
    } else {
      name = `Hoá đơn ${index + 1}`;
    }
  }

  return { name: cap(name, MAX_ITEM_NAME), amount };
}

/**
 * Mirrors the SQL validation of public.create_cash_payment_request:
 * title 1..200, 1..30 khoản, each name 1..200 chars, each amount an integer in
 * 1..50,000,000, total <= 200,000,000. Cost categories are only checked for
 * shape; the server decides active/inactive and falls back to UNMAPPED_REVIEW.
 */
export function validateCashPrForm(form: CashPrFormInput): CashPrValidationResult {
  const messages: string[] = [];

  const title = toText(form?.title);
  if (!title) {
    messages.push("Tiêu đề là bắt buộc.");
  } else if (title.length > CASH_PR_MAX_TITLE) {
    messages.push(`Tiêu đề tối đa ${CASH_PR_MAX_TITLE} ký tự.`);
  }

  const items = Array.isArray(form?.items) ? form.items : [];
  if (items.length < 1) {
    messages.push("Cần ít nhất 1 khoản.");
  }
  if (items.length > CASH_PR_MAX_ITEMS) {
    messages.push(`Tối đa ${CASH_PR_MAX_ITEMS} khoản.`);
  }

  let total = 0;
  items.forEach((item, index) => {
    const position = index + 1;

    const name = toText(item?.name);
    if (!name) {
      messages.push(`Khoản ${position}: tên khoản là bắt buộc.`);
    } else if (name.length > MAX_ITEM_NAME) {
      messages.push(`Khoản ${position}: tên tối đa ${MAX_ITEM_NAME} ký tự.`);
    }

    const amount = toAmount(item?.amount);
    if (amount === null || !Number.isInteger(amount)) {
      messages.push(
        `Khoản ${position}: số tiền phải là số nguyên từ 1 đến ${CASH_PR_MAX_ITEM_AMOUNT.toLocaleString("vi-VN")}.`,
      );
    } else if (amount < 1) {
      messages.push(
        `Khoản ${position}: số tiền phải là số nguyên từ 1 đến ${CASH_PR_MAX_ITEM_AMOUNT.toLocaleString("vi-VN")}.`,
      );
    } else {
      total += amount;
      if (amount > CASH_PR_MAX_ITEM_AMOUNT) {
        messages.push(
          `Khoản ${position}: số tiền tối đa ${CASH_PR_MAX_ITEM_AMOUNT.toLocaleString("vi-VN")}.`,
        );
      }
    }
  });

  if (total > CASH_PR_MAX_TOTAL) {
    messages.push(`Tổng tiền tối đa ${CASH_PR_MAX_TOTAL.toLocaleString("vi-VN")}.`);
  }

  return { ok: messages.length === 0, messages, total };
}

/**
 * Stable idempotency key per dialog session. Pass the same session id for every
 * retry; without one a fresh random id is generated.
 */
export function buildCashPrIdempotencyKey(sessionId?: string): string {
  const seed = (sessionId ?? "").trim();
  if (seed) return `cash-pr:${seed}`;
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `cash-pr:${random}`;
}
