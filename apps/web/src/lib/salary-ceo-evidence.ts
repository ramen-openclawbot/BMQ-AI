/**
 * Pure helpers for the CEO transfer slips of a salary payout.
 *
 * A payout can be advanced with 1..10 CEO bank-transfer slips. OCR may fail on
 * a slip, so the summary keeps the unread count separate from the amount check.
 * Amounts are compared in whole đồng: every value is rounded with Math.round
 * before summing/comparing.
 */

export interface SalaryCeoSlipLike {
  file_sha256: string;
  ocr_amount: number | null;
}

export type SalaryCeoSlipStatus = "empty" | "match" | "short" | "over" | "unread";

export interface SalaryCeoSlipSummary {
  /** Sum of the read OCR amounts, in whole đồng. */
  sum: number;
  unreadCount: number;
  /** Sha256 values that appear more than once, sorted. */
  duplicateShas: string[];
  status: SalaryCeoSlipStatus;
}

const normalizeSha = (sha: string | null | undefined): string =>
  String(sha ?? "").trim().toLowerCase();

const isUnread = (slip: SalaryCeoSlipLike): boolean =>
  slip.ocr_amount === null
  || slip.ocr_amount === undefined
  || !Number.isFinite(Number(slip.ocr_amount));

/** Keep the first slip for each sha256 (case/whitespace-insensitive). */
export function dedupeBySha<T extends { file_sha256: string }>(slips: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const slip of slips) {
    const sha = normalizeSha(slip.file_sha256);
    if (seen.has(sha)) continue;
    seen.add(sha);
    result.push(slip);
  }
  return result;
}

/**
 * Compare the OCR total of the CEO slips with the payout total.
 *
 * - empty: no slip was sent.
 * - unread: at least one slip has no OCR amount, so the total is unreliable.
 * - match/short/over: every slip was read and the sum is compared with total.
 *
 * Duplicate sha256 values are reported separately (the RPC rejects them); they
 * do not replace the empty/unread/amount status.
 */
export function summarizeCeoSlips(
  slips: readonly SalaryCeoSlipLike[],
  total: number,
): SalaryCeoSlipSummary {
  const safeSlips = Array.isArray(slips) ? slips : [];
  const counts = new Map<string, number>();
  let unreadCount = 0;
  let rawSum = 0;

  for (const slip of safeSlips) {
    const sha = normalizeSha(slip.file_sha256);
    counts.set(sha, (counts.get(sha) ?? 0) + 1);
    if (isUnread(slip)) {
      unreadCount += 1;
    } else {
      rawSum += Number(slip.ocr_amount);
    }
  }

  const duplicateShas = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([sha]) => sha)
    .sort();

  const sum = Math.round(rawSum);
  const roundedTotal = Math.round(Number(total) || 0);

  let status: SalaryCeoSlipStatus;
  if (safeSlips.length === 0) {
    status = "empty";
  } else if (unreadCount > 0) {
    status = "unread";
  } else if (sum === roundedTotal) {
    status = "match";
  } else if (sum < roundedTotal) {
    status = "short";
  } else {
    status = "over";
  }

  return { sum, unreadCount, duplicateShas, status };
}
