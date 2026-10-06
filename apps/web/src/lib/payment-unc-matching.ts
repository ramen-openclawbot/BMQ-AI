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

// ---------------------------------------------------------------------------
// Phase 2: multi-request allocation ("UNC trả nhiều phiếu").
// ---------------------------------------------------------------------------

export interface UncAllocationInput {
  /** payment_requests.id this allocation settles. */
  paymentRequestId: string;
  amount: number;
}

export type UncAllocationCode =
  | "ok"
  | "invalid_allocation"
  | "not_pending"
  | "supplier_mismatch"
  | "allocation_exceeds_remaining"
  | "amount_mismatch"
  | "override_reason_required";

export interface UncAllocationResult {
  ok: boolean;
  code: UncAllocationCode;
  allocatedTotal: number;
  supplierId: string | null;
  message: string;
}

export interface EvaluateUncAllocationsInput {
  requests: UncPaymentRequestInput[];
  allocations: UncAllocationInput[];
  evidenceAmount: number | null | undefined;
  manualOverride?: boolean;
  overrideReason?: string | null;
}

const allocationFail = (
  code: UncAllocationCode,
  message: string,
  allocatedTotal: number,
  supplierId: string | null,
): UncAllocationResult => ({ ok: false, code, allocatedTotal, supplierId, message });

/**
 * Client-side mirror of the RPC allocations branch. Every request must be
 * pending or already approved with a positive remaining amount; each allocation
 * must settle one request present in the list, once, without exceeding its
 * remaining amount; the allocations must cover the whole request set and share
 * one supplier; their sum must equal the evidence amount unless a reasoned
 * manual override is supplied.
 */
export function evaluateUncAllocations(input: EvaluateUncAllocationsInput): UncAllocationResult {
  const { requests, allocations, evidenceAmount, manualOverride = false, overrideReason } = input;
  const supplierId = requests.length > 0 ? requests[0].supplierId ?? null : null;
  const allocatedTotal = allocations.reduce((sum, allocation) => {
    const amount = Number(allocation.amount ?? 0);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);

  if (requests.length === 0 || allocations.length === 0) {
    return allocationFail("invalid_allocation", "Danh sách phân bổ không hợp lệ.", allocatedTotal, supplierId);
  }
  if (allocations.length > 50) {
    return allocationFail("invalid_allocation", "Chỉ phân bổ tối đa 50 phiếu mỗi lần.", allocatedTotal, supplierId);
  }

  const requestById = new Map(requests.map((request) => [request.id, request]));
  const seen = new Set<string>();
  for (const allocation of allocations) {
    const id = String(allocation.paymentRequestId ?? "").trim();
    const amount = Number(allocation.amount);
    if (!id || !Number.isFinite(amount) || amount <= 0) {
      return allocationFail("invalid_allocation", "Số tiền phân bổ phải lớn hơn 0.", allocatedTotal, supplierId);
    }
    if (!requestById.has(id) || seen.has(id)) {
      return allocationFail("invalid_allocation", "Phiếu phân bổ không hợp lệ hoặc bị lặp.", allocatedTotal, supplierId);
    }
    seen.add(id);
  }
  if (seen.size !== requests.length) {
    return allocationFail("invalid_allocation", "Mỗi phiếu phải có đúng một dòng phân bổ.", allocatedTotal, supplierId);
  }

  const nonPending = requests.find((request) =>
    (request.status && request.status !== "pending" && request.status !== "approved")
    || (request.paymentStatus && request.paymentStatus !== "unpaid" && request.paymentStatus !== "partial")
    || remainingAmount(request) <= 0
  );
  if (nonPending) {
    return allocationFail("not_pending", "Chỉ phân bổ cho phiếu đang chờ hoặc đã duyệt còn nợ.", allocatedTotal, supplierId);
  }

  if (!areSameSupplier(requests)) {
    return allocationFail("supplier_mismatch", "Các duyệt chi phải cùng một nhà cung cấp.", allocatedTotal, supplierId);
  }

  for (const allocation of allocations) {
    const request = requestById.get(String(allocation.paymentRequestId).trim());
    if (!request) {
      return allocationFail("invalid_allocation", "Phiếu phân bổ không hợp lệ hoặc bị lặp.", allocatedTotal, supplierId);
    }
    if (Number(allocation.amount) > remainingAmount(request)) {
      return allocationFail(
        "allocation_exceeds_remaining",
        "Số tiền phân bổ vượt quá số còn lại của phiếu.",
        allocatedTotal,
        supplierId,
      );
    }
  }

  if (manualOverride) {
    if (!overrideReason || !overrideReason.trim()) {
      return allocationFail("override_reason_required", "Duyệt tay bắt buộc phải có lý do.", allocatedTotal, supplierId);
    }
    return { ok: true, code: "ok", allocatedTotal, supplierId, message: "" };
  }

  if (!isExactAmountMatch(allocatedTotal, evidenceAmount)) {
    return allocationFail("amount_mismatch", "Tổng phân bổ phải khớp chính xác số tiền UNC.", allocatedTotal, supplierId);
  }

  return { ok: true, code: "ok", allocatedTotal, supplierId, message: "" };
}
