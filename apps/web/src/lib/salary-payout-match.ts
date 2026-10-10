/**
 * Pure matcher for the cash-salary payout flow.
 *
 * Inputs are the payout lines (one per published payslip, net_pay > 0) and the
 * receipts OCR'd for the payout. The matcher returns proposals that bind each
 * receipt to one line:
 *   * a receipt amount must equal the line net_pay exactly;
 *   * when an amount belongs to a single line it matches directly;
 *   * when several lines share the same amount, the beneficiary name is compared
 *     accent/case-insensitively with the employee name ('NGUYEN THI XUAN MAI' ~
 *     'Nguyễn Thị Xuân Mai') to resolve the tie;
 *   * a line that cannot be resolved (no receipt, wrong amount, or an
 *     unresolvable tie) is reported as missing; a receipt that is not used is
 *     reported as unmatched.
 *
 * No money is logged anywhere in this module.
 */

export interface SalaryPayoutLine {
  id: string;
  employee_name: string;
  net_pay: number;
  matched?: boolean;
}

export interface SalaryPayoutReceipt {
  id: string;
  amount: number | null;
  beneficiary?: string | null;
}

export type SalaryPayoutMatchReason = "amount" | "name";

export interface SalaryPayoutMatchProposal {
  receipt_id: string;
  line_id: string;
  reason: SalaryPayoutMatchReason;
}

export interface SalaryPayoutMatchResult {
  proposals: SalaryPayoutMatchProposal[];
  unmatched_receipts: string[];
  missing_lines: string[];
}

/** Name similarity below this is treated as "no usable name evidence". */
export const SALARY_PAYOUT_NAME_MATCH_THRESHOLD = 0.5;

/** Accent- and case-insensitive name normalisation. */
export const normalizeSalaryPayoutName = (value: unknown): string =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const nameTokens = (value: unknown): string[] => {
  const normalized = normalizeSalaryPayoutName(value);
  return normalized ? normalized.split(" ").filter(Boolean) : [];
};

/**
 * Token-overlap similarity in [0, 1]. Identical normalised names score 1.
 */
export const salaryPayoutNameSimilarity = (left: unknown, right: unknown): number => {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (a.length === 0 || b.length === 0) return 0;
  const aSet = new Set(a);
  const bSet = new Set(b);
  if ([...aSet].join(" ") === [...bSet].join(" ")) return 1;
  let shared = 0;
  for (const token of aSet) {
    if (bSet.has(token)) shared += 1;
  }
  const denominator = Math.max(aSet.size, bSet.size);
  return denominator === 0 ? 0 : shared / denominator;
};

const roundedAmount = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
};

const amountKey = (value: unknown): string | null => {
  const amount = roundedAmount(value);
  return amount === null ? null : String(amount);
};

interface RankedReceipt {
  receipt: SalaryPayoutReceipt;
  similarity: number;
}

const bestReceiptForLine = (
  candidates: SalaryPayoutReceipt[],
  line: SalaryPayoutLine,
): SalaryPayoutReceipt | null => {
  if (candidates.length === 0) return null;
  const ranked: RankedReceipt[] = candidates.map((receipt) => ({
    receipt,
    similarity: salaryPayoutNameSimilarity(line.employee_name, receipt.beneficiary),
  }));
  // Highest name similarity first, then a stable id tie-break so the same input
  // always produces the same proposal.
  ranked.sort((a, b) => b.similarity - a.similarity || a.receipt.id.localeCompare(b.receipt.id));
  return ranked[0].receipt;
};

/**
 * Match receipts to payout lines. Input arrays are not mutated. Already matched
 * lines (`matched === true`) are skipped.
 */
export const matchSalaryPayout = (
  lines: SalaryPayoutLine[],
  receipts: SalaryPayoutReceipt[],
): SalaryPayoutMatchResult => {
  const safeLines = Array.isArray(lines) ? lines : [];
  const safeReceipts = Array.isArray(receipts) ? receipts : [];

  const pendingLines = safeLines.filter((line) => line && line.matched !== true);
  const usedReceipts = new Set<string>();
  const proposals: SalaryPayoutMatchProposal[] = [];
  const missingLines: string[] = [];

  const receiptsByAmount = new Map<string, SalaryPayoutReceipt[]>();
  for (const receipt of safeReceipts) {
    if (!receipt) continue;
    const key = amountKey(receipt.amount);
    if (key === null) continue;
    const bucket = receiptsByAmount.get(key) ?? [];
    bucket.push(receipt);
    receiptsByAmount.set(key, bucket);
  }

  const linesByAmount = new Map<string, SalaryPayoutLine[]>();
  for (const line of pendingLines) {
    const key = amountKey(line.net_pay);
    if (key === null) continue;
    const bucket = linesByAmount.get(key) ?? [];
    bucket.push(line);
    linesByAmount.set(key, bucket);
  }

  const amounts = [...linesByAmount.keys()].sort();

  for (const amount of amounts) {
    const groupLines = linesByAmount.get(amount) ?? [];
    const groupReceipts = receiptsByAmount.get(amount) ?? [];

    if (groupReceipts.length === 0) {
      for (const line of groupLines) missingLines.push(line.id);
      continue;
    }

    if (groupLines.length === 1) {
      // The amount alone identifies the line; a duplicate receipt is simply left
      // unused (the best name candidate wins for determinism).
      const line = groupLines[0];
      const chosen = bestReceiptForLine(groupReceipts, line);
      if (chosen) {
        proposals.push({ receipt_id: chosen.id, line_id: line.id, reason: "amount" });
        usedReceipts.add(chosen.id);
      } else {
        missingLines.push(line.id);
      }
      continue;
    }

    // Several lines share the amount: resolve each by beneficiary name.
    for (const line of groupLines) {
      const available = groupReceipts.filter((receipt) => !usedReceipts.has(receipt.id));
      if (available.length === 0) {
        missingLines.push(line.id);
        continue;
      }
      const chosen = bestReceiptForLine(available, line);
      const similarity = chosen
        ? salaryPayoutNameSimilarity(line.employee_name, chosen.beneficiary)
        : 0;
      if (chosen && similarity >= SALARY_PAYOUT_NAME_MATCH_THRESHOLD) {
        proposals.push({ receipt_id: chosen.id, line_id: line.id, reason: "name" });
        usedReceipts.add(chosen.id);
      } else {
        // Unresolvable tie: leave the line missing and the receipt untouched.
        missingLines.push(line.id);
      }
    }
  }

  // Lines with a non-positive/invalid net_pay can never be matched.
  for (const line of pendingLines) {
    if (line && amountKey(line.net_pay) === null) missingLines.push(line.id);
  }

  const unmatchedReceipts = safeReceipts
    .filter((receipt) => receipt && !usedReceipts.has(receipt.id))
    .map((receipt) => receipt.id);

  return {
    proposals,
    unmatched_receipts: unmatchedReceipts,
    missing_lines: [...new Set(missingLines)],
  };
};
