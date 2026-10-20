// Pure helper for approving one payment batch with several UNC slips. Splits
// the per-request targets into one allocation list per slip so each slip can be
// confirmed by its own approve_payment_requests_with_unc (allocations) call.
// No React / Supabase imports so the split stays unit-testable.

import {
  remainingAmount,
  type UncAllocationInput,
  type UncPaymentRequestInput,
} from "@/lib/payment-unc-matching";

export type UncSlipInput = {
  fileSha256: string;
  amount: number | null;
};

export type UncSlipAllocation = {
  fileSha256: string;
  amount: number;
  allocations: UncAllocationInput[];
};

export type UncSlipPlanCode =
  | "no_slips"
  | "duplicate_slip"
  | "slip_amount_required"
  | "amount_mismatch"
  | "invalid_allocation"
  | "allocation_exceeds_remaining";

export type UncSlipAllocationsPlan =
  | { ok: true; slips: UncSlipAllocation[] }
  | { ok: false; code: UncSlipPlanCode };

/**
 * Split the targets across the chosen slips in order: each slip fills whatever
 * is still owed on the requests, oldest request first, until the slip amount is
 * used up. Targets are the amounts to settle per request; `requests` must
 * already be ordered oldest first. A slip may span several requests and a
 * request may be paid by several slips.
 */
export function planUncSlipAllocations(input: {
  requests: UncPaymentRequestInput[];
  targets: UncAllocationInput[];
  slips: UncSlipInput[];
}): UncSlipAllocationsPlan {
  const { requests, targets, slips } = input;

  if (slips.length === 0) return { ok: false, code: "no_slips" };

  const seenSha = new Set<string>();
  for (const slip of slips) {
    if (seenSha.has(slip.fileSha256)) return { ok: false, code: "duplicate_slip" };
    seenSha.add(slip.fileSha256);
  }

  const plannedSlips: { fileSha256: string; amount: number }[] = [];
  for (const slip of slips) {
    const raw = slip.amount === null || slip.amount === undefined ? Number.NaN : Number(slip.amount);
    if (!Number.isFinite(raw) || raw <= 0) return { ok: false, code: "slip_amount_required" };
    const amount = Math.round(raw);
    if (amount <= 0) return { ok: false, code: "slip_amount_required" };
    plannedSlips.push({ fileSha256: slip.fileSha256, amount });
  }

  const requestById = new Map(requests.map((request) => [request.id, request]));
  const targetByRequest = new Map<string, number>();
  for (const target of targets) {
    const raw = target.amount === null || target.amount === undefined ? Number.NaN : Number(target.amount);
    if (!Number.isFinite(raw)) return { ok: false, code: "invalid_allocation" };
    const amount = Math.round(raw);
    if (amount <= 0) continue;
    const id = String(target.paymentRequestId ?? "").trim();
    if (!id || !requestById.has(id) || targetByRequest.has(id)) {
      return { ok: false, code: "invalid_allocation" };
    }
    targetByRequest.set(id, amount);
  }

  if (targetByRequest.size === 0) return { ok: false, code: "invalid_allocation" };

  for (const [id, amount] of targetByRequest) {
    const request = requestById.get(id);
    if (!request || amount > Math.round(remainingAmount(request))) {
      return { ok: false, code: "allocation_exceeds_remaining" };
    }
  }

  const targetTotal = [...targetByRequest.values()].reduce((sum, amount) => sum + amount, 0);
  const slipTotal = plannedSlips.reduce((sum, slip) => sum + slip.amount, 0);
  if (targetTotal !== slipTotal) return { ok: false, code: "amount_mismatch" };

  const orderedIds = requests
    .map((request) => request.id)
    .filter((id) => targetByRequest.has(id));

  const remainingByRequest = new Map(targetByRequest);
  const result: UncSlipAllocation[] = [];
  for (const slip of plannedSlips) {
    let left = slip.amount;
    const allocations: UncAllocationInput[] = [];
    for (const id of orderedIds) {
      if (left <= 0) break;
      const available = remainingByRequest.get(id) ?? 0;
      if (available <= 0) continue;
      const take = Math.min(left, available);
      allocations.push({ paymentRequestId: id, amount: take });
      remainingByRequest.set(id, available - take);
      left -= take;
    }
    if (left !== 0 || allocations.length === 0) {
      return { ok: false, code: "invalid_allocation" };
    }
    result.push({ fileSha256: slip.fileSha256, amount: slip.amount, allocations });
  }

  for (const available of remainingByRequest.values()) {
    if (available !== 0) return { ok: false, code: "invalid_allocation" };
  }

  return { ok: true, slips: result };
}
