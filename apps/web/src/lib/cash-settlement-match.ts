// Pure cash-settlement matcher. No Supabase / React / network imports: the
// settlement page feeds the PR items (with any already-covered amount) and the
// uploaded receipts (with the OCR/confirmed amount), and this module proposes
// which receipt(s) cover which item. The server still re-validates every
// allocation through public.submit_cash_settlement; this file only decides what
// to propose.
//
// Rules:
//   1. exact single-receipt match first, and only when the pairing is mutually
//      unique (one receipt for that item and one item for that receipt);
//   2. then, for the remaining items, a subset of the remaining receipts whose
//      total equals the item remaining (bounded search). Several receipts may
//      cover one item (e.g. shipping 130.000 = 81.000 + 49.000), but if more
//      than one subset fits, the item is left unmatched (ambiguous);
//   3. never over-allocate: a receipt is used at most once and only for its full
//      amount.

export interface CashSettlementItemInput {
  id: string;
  label?: string | null;
  amount: number;
  /** Amount already allocated to this item by an earlier submit. */
  covered?: number | null;
}

export interface CashSettlementReceiptInput {
  id: string;
  amount: number | null;
  status?: string | null;
}

export interface CashSettlementAllocation {
  receipt_id: string;
  item_id: string;
  amount: number;
}

export type CashSettlementReceiptState = "matched" | "unmatched" | "no_amount";

export interface CashSettlementItemResult {
  item_id: string;
  label: string | null;
  amount: number;
  covered: number;
  remaining: number;
  fully_covered: boolean;
}

export interface CashSettlementReceiptResult {
  receipt_id: string;
  amount: number | null;
  state: CashSettlementReceiptState;
  matched: boolean;
  item_id: string | null;
}

export interface CashSettlementMatchResult {
  allocations: CashSettlementAllocation[];
  items: CashSettlementItemResult[];
  receipts: CashSettlementReceiptResult[];
  covered_total: number;
  remaining_total: number;
}

const MAX_SUBSET_RECEIPTS = 20;
const MAX_SUBSET_RESULTS = 20;
const MAX_SUBSET_NODES = 50000;

const amountsEqual = (left: number, right: number): boolean =>
  Number.isFinite(left) && Number.isFinite(right) && Math.round(left * 100) === Math.round(right * 100);

const toAmount = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

type InternalItem = {
  id: string;
  label: string | null;
  amount: number;
  baseCovered: number;
  allocated: number;
  remaining: number;
};

type InternalReceipt = {
  id: string;
  amount: number | null;
  status: string | null;
  used: boolean;
  itemId: string | null;
};

/** Bounded subset search: every receipt-id set (size >= minSize) summing to target. */
function findSubsets(
  pool: InternalReceipt[],
  target: number,
  minSize: number,
): string[][] {
  const sorted = [...pool]
    .filter((receipt) => receipt.amount !== null && (receipt.amount as number) > 0)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_SUBSET_RECEIPTS);

  const results: string[][] = [];
  const current: string[] = [];
  let nodes = 0;

  const search = (start: number, sum: number): void => {
    if (results.length >= MAX_SUBSET_RESULTS || nodes > MAX_SUBSET_NODES) return;
    if (current.length >= minSize && amountsEqual(sum, target)) {
      results.push([...current]);
      return;
    }
    for (let index = start; index < sorted.length; index += 1) {
      const amount = sorted[index].amount as number;
      if (sum + amount > target) continue;
      nodes += 1;
      current.push(sorted[index].id);
      search(index + 1, sum + amount);
      current.pop();
      if (results.length >= MAX_SUBSET_RESULTS || nodes > MAX_SUBSET_NODES) break;
    }
  };

  search(0, 0);
  return results;
}

export function matchCashSettlement(
  items: CashSettlementItemInput[],
  receipts: CashSettlementReceiptInput[],
): CashSettlementMatchResult {
  const safeItems: InternalItem[] = (Array.isArray(items) ? items : []).map((item) => {
    const amount = Math.max(0, toAmount(item.amount) ?? 0);
    const baseCovered = Math.max(0, toAmount(item.covered) ?? 0);
    return {
      id: String(item.id),
      label: item.label ?? null,
      amount,
      baseCovered,
      allocated: 0,
      remaining: Math.max(amount - baseCovered, 0),
    };
  });

  const internalReceipts: InternalReceipt[] = (Array.isArray(receipts) ? receipts : []).map((receipt) => ({
    id: String(receipt.id),
    amount: toAmount(receipt.amount),
    status: receipt.status ?? null,
    used: false,
    itemId: null,
  }));

  const allocations: CashSettlementAllocation[] = [];

  const availableReceipts = (): InternalReceipt[] =>
    internalReceipts.filter(
      (receipt) =>
        !receipt.used
        && receipt.amount !== null
        && (receipt.amount as number) > 0
        && (receipt.status === null || receipt.status === "uploaded"),
    );

  const allocate = (receipt: InternalReceipt, item: InternalItem, amount: number): void => {
    allocations.push({ receipt_id: receipt.id, item_id: item.id, amount });
    receipt.used = true;
    receipt.itemId = item.id;
    item.allocated += amount;
    item.remaining = Math.max(item.amount - item.baseCovered - item.allocated, 0);
  };

  // --- Rule 1: mutually-unique exact single-receipt matches ------------------
  let progress = true;
  while (progress) {
    progress = false;
    const open = safeItems.filter((item) => item.remaining > 0);
    const pool = availableReceipts();

    const pairs: Array<{ receipt: InternalReceipt; item: InternalItem }> = [];
    for (const item of open) {
      if (item.remaining <= 0) continue;
      const receiptsForItem = pool.filter((receipt) => amountsEqual(receipt.amount as number, item.remaining));
      if (receiptsForItem.length !== 1) continue;
      const receipt = receiptsForItem[0];
      const itemsForReceipt = open.filter((candidate) => amountsEqual(receipt.amount as number, candidate.remaining));
      if (itemsForReceipt.length !== 1) continue;
      pairs.push({ receipt, item });
    }

    for (const { receipt, item } of pairs) {
      if (receipt.used || item.remaining <= 0) continue;
      allocate(receipt, item, item.remaining);
      progress = true;
    }
  }

  // --- Rule 2: subset sums of the remaining receipts (>= 2 receipts) ---------
  for (const item of safeItems) {
    if (item.remaining <= 0) continue;
    const subsets = findSubsets(availableReceipts(), item.remaining, 2);
    if (subsets.length !== 1) continue;
    for (const receiptId of subsets[0]) {
      const receipt = internalReceipts.find((candidate) => candidate.id === receiptId && !candidate.used);
      if (!receipt || receipt.amount === null || item.remaining <= 0) continue;
      allocate(receipt, item, Math.min(receipt.amount, item.remaining));
    }
  }

  const itemResults: CashSettlementItemResult[] = safeItems.map((item) => {
    const covered = item.baseCovered + item.allocated;
    const remaining = Math.max(item.amount - covered, 0);
    return {
      item_id: item.id,
      label: item.label,
      amount: item.amount,
      covered,
      remaining,
      fully_covered: remaining <= 0,
    };
  });

  const receiptResults: CashSettlementReceiptResult[] = internalReceipts.map((receipt) => {
    let state: CashSettlementReceiptState;
    if (receipt.amount === null || receipt.amount <= 0) state = "no_amount";
    else if (receipt.used) state = "matched";
    else state = "unmatched";
    return {
      receipt_id: receipt.id,
      amount: receipt.amount,
      state,
      matched: state === "matched",
      item_id: receipt.used ? receipt.itemId : null,
    };
  });

  const coveredTotal = itemResults.reduce((sum, item) => sum + item.covered, 0);
  const remainingTotal = itemResults.reduce((sum, item) => sum + item.remaining, 0);

  return {
    allocations,
    items: itemResults,
    receipts: receiptResults,
    covered_total: coveredTotal,
    remaining_total: remainingTotal,
  };
}
