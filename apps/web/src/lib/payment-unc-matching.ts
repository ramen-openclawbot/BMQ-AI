// Pure helpers for the owner UNC approval flow. No Supabase / React imports so
// the remaining-amount, exact-amount, same-supplier and reference-normalization
// rules stay unit-testable and mirror
// public.approve_payment_requests_with_unc + public.normalize_unc_reference.

export interface UncPaymentRequestInput {
  id: string;
  supplierId: string | null;
  totalAmount: number | null;
  allocatedAmount?: number | null;
  status?: string | null;
  paymentStatus?: string | null;
  createdBy?: string | null;
}

export type UncMatchCode =
  | "ok"
  | "no_requests"
  | "not_pending"
  | "supplier_mismatch"
  | "amount_mismatch"
  | "override_reason_required";

export interface UncMatchResult {
  ok: boolean;
  code: UncMatchCode;
  remainingTotal: number;
  supplierId: string | null;
  message: string;
}

/** Normalize a UNC reference exactly like public.normalize_unc_reference. */
export function normalizeUncReference(value: string | null | undefined): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return normalized.length > 0 ? normalized : null;
}

/** Remaining payable amount for one request (never below zero in the UI). */
export function remainingAmount(request: Pick<UncPaymentRequestInput, "totalAmount" | "allocatedAmount">): number {
  const total = Number(request.totalAmount ?? 0);
  const allocated = Number(request.allocatedAmount ?? 0);
  if (!Number.isFinite(total) || !Number.isFinite(allocated)) return 0;
  return total - allocated;
}

export function sumRemainingAmounts(requests: UncPaymentRequestInput[]): number {
  return requests.reduce((sum, request) => sum + remainingAmount(request), 0);
}

/**
 * All requests must share one supplier. A null supplier only matches other
 * nulls, exactly like the SQL `is distinct from` guard.
 */
export function areSameSupplier(requests: UncPaymentRequestInput[]): boolean {
  if (requests.length === 0) return false;
  const first = requests[0].supplierId ?? "__null__";
  return requests.every((request) => (request.supplierId ?? "__null__") === first);
}

export function isExactAmountMatch(remainingTotal: number, evidenceAmount: number | null | undefined): boolean {
  if (evidenceAmount === null || evidenceAmount === undefined) return false;
  const parsed = Number(evidenceAmount);
  return Number.isFinite(parsed) && Math.round(parsed * 100) === Math.round(remainingTotal * 100);
}

export interface EvaluateUncMatchInput {
  requests: UncPaymentRequestInput[];
  evidenceAmount: number | null | undefined;
  manualOverride?: boolean;
  overrideReason?: string | null;
}

/** Same validation order the approval RPC applies before writing anything. */
export function evaluatePaymentUncMatch(input: EvaluateUncMatchInput): UncMatchResult {
  const { requests, evidenceAmount, manualOverride = false, overrideReason } = input;
  const supplierId = requests.length > 0 ? requests[0].supplierId ?? null : null;
  const remainingTotal = sumRemainingAmounts(requests);

  if (requests.length === 0) {
    return { ok: false, code: "no_requests", remainingTotal, supplierId, message: "Chưa chọn duyệt chi nào." };
  }

  const nonPending = requests.find((request) =>
    (request.status && request.status !== "pending")
    || (request.paymentStatus && request.paymentStatus !== "unpaid")
    || remainingAmount(request) <= 0
  );
  if (nonPending) {
    return {
      ok: false,
      code: "not_pending",
      remainingTotal,
      supplierId,
      message: "Chỉ duyệt chi các yêu cầu đang chờ và chưa thanh toán.",
    };
  }

  if (!areSameSupplier(requests)) {
    return {
      ok: false,
      code: "supplier_mismatch",
      remainingTotal,
      supplierId,
      message: "Các duyệt chi phải cùng một nhà cung cấp.",
    };
  }

  if (manualOverride) {
    if (!overrideReason || !overrideReason.trim()) {
      return {
        ok: false,
        code: "override_reason_required",
        remainingTotal,
        supplierId,
        message: "Duyệt tay bắt buộc phải có lý do.",
      };
    }
    return { ok: true, code: "ok", remainingTotal, supplierId, message: "" };
  }

  if (!isExactAmountMatch(remainingTotal, evidenceAmount)) {
    return {
      ok: false,
      code: "amount_mismatch",
      remainingTotal,
      supplierId,
      message: "Số tiền UNC phải khớp chính xác tổng còn lại của các duyệt chi.",
    };
  }

  return { ok: true, code: "ok", remainingTotal, supplierId, message: "" };
}
