// Pure helpers for the CEO cash-expense flow. No Supabase / React imports so
// the form validation, the stable idempotency key and the RPC error mapping stay
// unit-testable and mirror the SQL record RPC rules.

export const CEO_CASH_MAX_AMOUNT = 50_000_000;
export const CEO_CASH_MAX_AGE_DAYS = 90;
export const CEO_CASH_UNMAPPED_CATEGORY = "UNMAPPED_REVIEW";

export interface CeoCashExpenseFormFields {
  amount: number | null;
  expense_date: string | null;
  cost_category_code: string | null;
  description: string | null;
  payee_name?: string | null;
  items?: unknown[];
}

export type CeoCashExpenseValidation =
  | { ok: true }
  | { ok: false; code: string; message: string };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Vietnam calendar day (UTC+7, no DST) as YYYY-MM-DD. */
export function vietnamToday(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD strings (b - a), ignoring host timezone. */
export function daysBetweenIso(a: string, b: string): number {
  const start = Date.parse(`${a}T00:00:00Z`);
  const end = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return Number.NaN;
  return Math.round((end - start) / 86_400_000);
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/** Stable server idempotency key: one key per draft. */
export function ceoCashExpenseIdempotencyKey(draftId: string): string {
  return `ceo-cash:${String(draftId ?? "").trim()}`;
}

/**
 * Validate the CEO-confirmed fields with the same rules the SQL RPC enforces:
 * integer amount in 1..50.000.000, expense_date inside the last 90 Vietnam days,
 * an active cost category and a non-empty description.
 */
export function validateCeoCashExpenseForm(
  fields: CeoCashExpenseFormFields,
  options: { now?: Date } = {},
): CeoCashExpenseValidation {
  const amount = Number(fields?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    return { ok: false, code: "invalid_amount", message: ceoCashExpenseErrorMessage("invalid_amount") };
  }
  if (amount > CEO_CASH_MAX_AMOUNT) {
    return {
      ok: false,
      code: "amount_over_cash_limit",
      message: ceoCashExpenseErrorMessage("amount_over_cash_limit"),
    };
  }

  const expenseDate = String(fields?.expense_date ?? "").trim();
  const today = vietnamToday(options.now ?? new Date());
  if (!isValidIsoDate(expenseDate) || expenseDate > today) {
    return {
      ok: false,
      code: "date_out_of_range",
      message: ceoCashExpenseErrorMessage("date_out_of_range"),
    };
  }
  if (daysBetweenIso(expenseDate, today) > CEO_CASH_MAX_AGE_DAYS) {
    return {
      ok: false,
      code: "date_out_of_range",
      message: ceoCashExpenseErrorMessage("date_out_of_range"),
    };
  }

  const category = String(fields?.cost_category_code ?? "").trim();
  if (!category) {
    return {
      ok: false,
      code: "invalid_category",
      message: ceoCashExpenseErrorMessage("invalid_category"),
    };
  }

  const description = String(fields?.description ?? "").trim();
  if (!description) {
    return {
      ok: false,
      code: "description_required",
      message: ceoCashExpenseErrorMessage("description_required"),
    };
  }

  return { ok: true };
}

const RPC_ERROR_MESSAGES: Record<string, string> = {
  not_owner: "Chỉ chủ sở hữu (CEO) mới được ghi chi tiền mặt.",
  self_approval_not_allowed: "Có nhiều hơn một owner nên không thể tự duyệt phiếu do mình tạo.",
  self_approval: "Có nhiều hơn một owner nên không thể tự duyệt phiếu do mình tạo.",
  amount_over_cash_limit: "Số tiền vượt hạn mức chi tiền mặt 50.000.000 đ.",
  invalid_category: "Nhóm chi phí không hợp lệ hoặc đã ngừng dùng.",
  date_out_of_range: "Ngày chi không được ở tương lai hoặc cũ quá 90 ngày.",
  invalid_amount: "Số tiền không hợp lệ (phải là số nguyên lớn hơn 0).",
  description_required: "Cần nhập nội dung chi.",
  duplicate: "Ảnh/chứng từ này đã được ghi nhận trước đó.",
  draft_not_found: "Không tìm thấy bản nháp.",
  draft_discarded: "Bản nháp đã bị bỏ, không thể ghi.",
  draft_not_draft: "Chỉ bỏ được bản nháp đang chờ.",
  payment_not_recorded: "Chưa ghi nhận được thanh toán, vui lòng thử lại.",
  idempotency_key_required: "Thiếu khóa chống trùng.",
  draft_required: "Thiếu bản nháp.",
  not_pending: "Phiếu không còn ở trạng thái chờ duyệt.",
  payment_replayed: "Phiếu đã được ghi nhận trước đó.",
};

export const CEO_CASH_KNOWN_ERROR_CODES = Object.keys(RPC_ERROR_MESSAGES);

/** Vietnamese one-liner for a known RPC/edge error code. */
export function ceoCashExpenseErrorMessage(code: string | null | undefined): string {
  const key = String(code ?? "").trim();
  if (key && RPC_ERROR_MESSAGES[key]) return RPC_ERROR_MESSAGES[key];
  return "Không ghi nhận được phiếu chi tiền mặt. Vui lòng thử lại.";
}

/**
 * Extract a known code from a raw Supabase/Postgres error message, so the hook
 * can map it to a short Vietnamese sentence.
 */
export function parseCeoCashExpenseErrorCode(message: string | null | undefined): string {
  const text = String(message ?? "");
  for (const code of CEO_CASH_KNOWN_ERROR_CODES) {
    if (text.includes(code)) return code;
  }
  return "record_failed";
}
