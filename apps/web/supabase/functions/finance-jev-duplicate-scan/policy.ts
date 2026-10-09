// Provisional decision policy for the Jev duplicate scan.
//
// The thresholds below are TEMPORARY and NOT calibrated: no labelled Jev
// evaluation has been run on this domain yet. They only separate an obvious
// same-purchase pair (auto_flag) and an obvious different pair (auto_clear) from
// the middle, which always goes to the CEO as needs_review. Jev itself never
// blocks or changes a spend; code owns the routing and a human owns the call.

export type JevDuplicateStatus = "auto_clear" | "needs_review" | "auto_flag";

export const JEV_DUPLICATE_THRESHOLDS = {
  /** p_same at or above this, with a same_purchase relation, is an auto_flag. */
  autoFlag: 0.85,
  /** p_same at or below this, without a same_purchase relation, is auto_clear. */
  autoClear: 0.15,
  /** The relation must be at least this decisive to support an auto_flag. */
  relationSamePurchase: 0.6,
} as const;

export interface JevPolicyInput {
  p_same: number;
  relation: string;
  relation_probability: number;
}

/**
 * auto_flag: strong same-purchase belief AND a decisive same_purchase relation.
 * auto_clear: strong different-purchase belief AND the relation is not
 * same_purchase. Everything else — including every error — is needs_review.
 */
export function decideJevStatus(input: JevPolicyInput): JevDuplicateStatus {
  if (
    input.p_same >= JEV_DUPLICATE_THRESHOLDS.autoFlag
    && input.relation === "same_purchase"
    && input.relation_probability >= JEV_DUPLICATE_THRESHOLDS.relationSamePurchase
  ) {
    return "auto_flag";
  }
  if (input.p_same <= JEV_DUPLICATE_THRESHOLDS.autoClear && input.relation !== "same_purchase") {
    return "auto_clear";
  }
  return "needs_review";
}
