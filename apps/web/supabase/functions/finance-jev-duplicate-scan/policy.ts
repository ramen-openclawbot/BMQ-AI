// Decision policy for the Jev duplicate scan (v2, owner-approved 2026-10-10).
//
// Code owns the routing; Jev is one signal. The first live dry run showed Jev's
// p_same clustered at 0.36–0.46 for every pair, while its `relation` answer
// separated "same purchase" from "repeat order" well. So the policy combines the
// relation with facts code can check exactly (same invoice number, how far apart
// the phiếu were created, whether both have their own goods receipts on different
// days). Thresholds remain temporary and not calibrated; revisit them with CEO decisions.
// Jev itself never blocks or changes a spend; a human owns the call.

export type JevDuplicateStatus = "auto_clear" | "needs_review" | "auto_flag";

export const JEV_POLICY_VERSION = "jev-dup-policy-2026-10-10.v2";

export const JEV_DUPLICATE_THRESHOLDS = {
  /** p_same at or above this, with a decisive same_purchase relation, is an auto_flag. */
  autoFlag: 0.85,
  /** p_same at or below this, without a same_purchase relation, is auto_clear. */
  autoClear: 0.15,
  /** The relation must be at least this decisive to support an auto_flag. */
  relationSamePurchase: 0.6,
  /** Phiếu created this many days apart or fewer always go to the CEO. */
  closeCreatedDays: 1,
  /** Repeat-order auto_clear needs goods receipts at least this many days apart. */
  receiptDaysApart: 3,
} as const;

/** Exact facts from the two phiếu (YYYY-MM-DD dates; null when unknown). */
export interface JevPairFacts {
  created_older: string | null;
  created_newer: string | null;
  receipt_number_older: string | null;
  receipt_number_newer: string | null;
  receipt_date_older: string | null;
  receipt_date_newer: string | null;
  invoice_older: string | null;
  invoice_newer: string | null;
}

export interface JevPolicyInput {
  p_same: number;
  relation: string;
  relation_probability: number;
  facts?: JevPairFacts;
}

const norm = (value: string | null | undefined) => String(value ?? "").trim().toUpperCase().replace(/[\s._-]+/g, "");

/** Whole days between two YYYY-MM-DD dates, or null when either is missing/invalid. */
export function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  const ta = Date.parse(`${String(a ?? "").slice(0, 10)}T00:00:00Z`);
  const tb = Date.parse(`${String(b ?? "").slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round(Math.abs(ta - tb) / 86_400_000);
}

/**
 * auto_flag: same invoice number on both phiếu, or a strong decisive same_purchase answer.
 * needs_review: Jev leans same_purchase, or the phiếu were created ≤1 day apart, or anything unsure.
 * auto_clear: Jev says repeat_order/unrelated AND both phiếu have their own goods receipts
 *             dated ≥3 days apart; or the old strong-different rule (p_same ≤ 0.15).
 */
export function decideJevStatus(input: JevPolicyInput): JevDuplicateStatus {
  const t = JEV_DUPLICATE_THRESHOLDS;
  const f = input.facts;

  const invoiceA = norm(f?.invoice_older);
  const invoiceB = norm(f?.invoice_newer);
  if (invoiceA && invoiceA === invoiceB) return "auto_flag";

  if (input.p_same >= t.autoFlag && input.relation === "same_purchase" && input.relation_probability >= t.relationSamePurchase) {
    return "auto_flag";
  }

  const createdApart = daysBetween(f?.created_older, f?.created_newer);
  if (input.relation === "same_purchase") return "needs_review";
  if (createdApart !== null && createdApart <= t.closeCreatedDays) return "needs_review";

  const receiptA = norm(f?.receipt_number_older);
  const receiptB = norm(f?.receipt_number_newer);
  const receiptApart = daysBetween(f?.receipt_date_older, f?.receipt_date_newer);
  if (
    (input.relation === "repeat_order" || input.relation === "unrelated")
    && receiptA && receiptB && receiptA !== receiptB
    && receiptApart !== null && receiptApart >= t.receiptDaysApart
  ) {
    return "auto_clear";
  }

  if (input.p_same <= t.autoClear) return "auto_clear";
  return "needs_review";
}

/** Facts for the policy from the exact state sent to Jev. */
export function pairFactsFromState(state: {
  older: { created_date: string; goods_receipt_number: string | null; receipt_date: string | null; invoice_number: string | null };
  newer: { created_date: string; goods_receipt_number: string | null; receipt_date: string | null; invoice_number: string | null };
} | undefined): JevPairFacts | undefined {
  if (!state) return undefined;
  return {
    created_older: state.older.created_date || null,
    created_newer: state.newer.created_date || null,
    receipt_number_older: state.older.goods_receipt_number,
    receipt_number_newer: state.newer.goods_receipt_number,
    receipt_date_older: state.older.receipt_date,
    receipt_date_newer: state.newer.receipt_date,
    invoice_older: state.older.invoice_number,
    invoice_newer: state.newer.invoice_number,
  };
}
