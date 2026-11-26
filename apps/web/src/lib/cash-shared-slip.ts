// Pure shared-slip matcher. No Supabase / React / network imports: the cash
// settlement page feeds the candidate phiếu (cash, awaiting_receipts, same
// requester, with per-item remaining) and this module proposes which phiếu (and
// which item amounts) one uploaded slip should settle. The server still
// re-validates every allocation through public.submit_cash_shared_slip; this
// file only decides what to propose.
//
// Rules:
//   - the current phiếu is always part of a suggestion / allocation plan;
//   - a suggestion uses at most 10 phiếu, sums their remaining totals to the
//     slip amount (whole đồng) and prefers the fewest phiếu, then older phiếu;
//   - an allocation plan only succeeds when the selected phiếu total equals the
//     slip amount, and then fills every item's remaining (> 0) exactly.

export interface SharedSlipCandidateItem {
  id: string;
  remaining: number;
}

export interface SharedSlipCandidate {
  requestId: string;
  requestNumber: string;
  isCurrent: boolean;
  remainingTotal: number;
  items: SharedSlipCandidateItem[];
}

export type SharedSlipAllocation = {
  request_id: string;
  item_id: string;
  amount: number;
};

export interface SharedSlipSuggestion {
  requestIds: string[];
  exact: boolean;
}

export type SharedSlipPlan =
  | { ok: true; allocations: SharedSlipAllocation[] }
  | { ok: false; code: "current_required" }
  | { ok: false; code: "too_many_requests" }
  | { ok: false; code: "too_many_allocations" }
  | { ok: false; code: "total_mismatch"; diff: number };

const MAX_SHARED_REQUESTS = 10;
const MAX_SHARED_ALLOCATIONS = 100;

/** Finite amount, kept as-is (the server stores fractional numerics). */
const toAmount = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Whole-đồng comparison, matching the server's round() checks. */
const wholeDong = (value: unknown): number => Math.round(toAmount(value));

type NormalizedCandidate = SharedSlipCandidate & { items: SharedSlipCandidateItem[] };

const normalizeCandidates = (candidates: SharedSlipCandidate[] | null | undefined): NormalizedCandidate[] => {
  const seen = new Set<string>();
  const normalized: NormalizedCandidate[] = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || typeof candidate.requestId !== "string" || candidate.requestId === "") continue;
    if (seen.has(candidate.requestId)) continue;
    seen.add(candidate.requestId);
    normalized.push({
      requestId: candidate.requestId,
      requestNumber: typeof candidate.requestNumber === "string" ? candidate.requestNumber : "",
      isCurrent: candidate.isCurrent === true,
      remainingTotal: Math.max(0, toAmount(candidate.remainingTotal)),
      items: (Array.isArray(candidate.items) ? candidate.items : [])
        .filter((item) => item && typeof item.id === "string" && item.id !== "")
        .map((item) => ({ id: item.id, remaining: Math.max(0, toAmount(item.remaining)) })),
    });
  }
  return normalized;
};


type ExtraSubset = { indices: number[]; sum: number; openItems: number };

const openItemCount = (candidate: SharedSlipCandidate): number =>
  candidate.items.reduce((count, item) => count + (item.remaining > 0 ? 1 : 0), 0);

/** Every non-empty subset of one half (max 9 extras), in lexicographic order. */
const buildExtraSubsets = (
  extras: NormalizedCandidate[],
  start: number,
  end: number,
): ExtraSubset[] => {
  const subsets: ExtraSubset[] = [{ indices: [], sum: 0, openItems: 0 }];
  const chosen: number[] = [];

  const walk = (from: number, sum: number, openItems: number): void => {
    if (chosen.length >= MAX_SHARED_REQUESTS - 1) return;
    for (let index = from; index < end; index += 1) {
      const value = extras[index].remainingTotal;
      if (value <= 0) continue;
      const nextOpenItems = openItems + openItemCount(extras[index]);
      chosen.push(index);
      subsets.push({ indices: [...chosen], sum: sum + value, openItems: nextOpenItems });
      walk(index + 1, sum + value, nextOpenItems);
      chosen.pop();
    }
  };

  walk(start, 0, 0);
  return subsets;
};

const compareIndexSets = (left: number[], right: number[]): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
};

/**
 * Propose the phiếu that one slip settles. The current phiếu is mandatory; at
 * most 10 phiếu in total. Ties prefer fewer phiếu, then the order of the input
 * candidates (the server returns them oldest first). When nothing sums exactly
 * to the slip amount, the suggestion is the current phiếu only and exact=false.
 */
export function suggestSharedSlipRequests(
  slipAmount: number,
  candidates: SharedSlipCandidate[],
): SharedSlipSuggestion {
  const list = normalizeCandidates(candidates);
  const current = list.find((candidate) => candidate.isCurrent);
  if (!current) return { requestIds: [], exact: false };

  const currentId = current.requestId;
  const target = wholeDong(slipAmount);
  const base = current.remainingTotal;

  if (wholeDong(base) > target) return { requestIds: [currentId], exact: false };
  const currentOpenItems = openItemCount(current);
  if (currentOpenItems > MAX_SHARED_ALLOCATIONS) {
    return { requestIds: [currentId], exact: false };
  }
  if (wholeDong(base) === target) return { requestIds: [currentId], exact: true };

  const extras = list.filter((candidate) => candidate.requestId !== currentId && !candidate.isCurrent);
  const maxExtras = Math.min(extras.length, MAX_SHARED_REQUESTS - 1);
  if (maxExtras <= 0) return { requestIds: [currentId], exact: false };

  // Bounded meet-in-the-middle instead of a plain DFS: the old 200k-node cap
  // could stop before reaching the (up to 9) extras a valid combination needs
  // when the server returns 30 candidates.
  const mid = Math.floor(extras.length / 2);
  const leftSubsets = buildExtraSubsets(extras, 0, mid);
  const rightSubsets = buildExtraSubsets(extras, mid, extras.length);
  const rightCount = extras.length - mid;

  // Group right-half subsets by (count, whole-đồng sum); each group keeps the
  // lexicographic (oldest-first) generation order.
  const rightGroups = new Map<string, ExtraSubset[]>();
  for (const subset of rightSubsets) {
    const key = `${subset.indices.length}:${wholeDong(subset.sum)}`;
    const group = rightGroups.get(key);
    if (group) group.push(subset);
    else rightGroups.set(key, [subset]);
  }

  let best: number[] | null = null;

  // Fewest phiếu first: current + 1 extra, current + 2 extras, ...
  for (let extraCount = 1; extraCount <= maxExtras; extraCount += 1) {
    for (const left of leftSubsets) {
      const rightNeeded = extraCount - left.indices.length;
      if (rightNeeded < 0 || rightNeeded > rightCount) continue;

      const center = wholeDong(target - base - left.sum);
      // A rounded comparison can land one whole đồng either side.
      for (let delta = -1; delta <= 1; delta += 1) {
        const group = rightGroups.get(`${rightNeeded}:${center + delta}`);
        if (!group) continue;
        for (const right of group) {
          if (wholeDong(base + left.sum + right.sum) !== target) continue;
          if (currentOpenItems + left.openItems + right.openItems > MAX_SHARED_ALLOCATIONS) continue;
          const combined = [...left.indices, ...right.indices].sort((a, b) => a - b);
          if (!best || compareIndexSets(combined, best) < 0) best = combined;
          break;
        }
      }
    }

    if (best) {
      const selectedIds = new Set([currentId, ...best.map((index) => extras[index].requestId)]);
      return {
        requestIds: list.filter((candidate) => selectedIds.has(candidate.requestId)).map((candidate) => candidate.requestId),
        exact: true,
      };
    }
  }

  return { requestIds: [currentId], exact: false };
}

/**
 * Build the server allocations for one slip across the selected phiếu. Every
 * selected item contributes its full remaining; the selected phiếu total must
 * equal the slip amount (whole đồng) or the plan is rejected with the diff.
 */
export function planSharedSlipAllocations(
  slipAmount: number,
  candidates: SharedSlipCandidate[],
  selectedRequestIds: string[],
): SharedSlipPlan {
  const list = normalizeCandidates(candidates);
  const current = list.find((candidate) => candidate.isCurrent);
  const selectedIds = new Set(
    (Array.isArray(selectedRequestIds) ? selectedRequestIds : [])
      .filter((id): id is string => typeof id === "string" && id !== ""),
  );

  if (!current || !selectedIds.has(current.requestId)) {
    return { ok: false, code: "current_required" };
  }

  const selected = list.filter((candidate) => selectedIds.has(candidate.requestId));
  if (selected.length > MAX_SHARED_REQUESTS) {
    return { ok: false, code: "too_many_requests" };
  }
  const selectedOpenItems = selected.reduce((count, candidate) => count + openItemCount(candidate), 0);
  if (selectedOpenItems > MAX_SHARED_ALLOCATIONS) {
    return { ok: false, code: "too_many_allocations" };
  }
  const target = wholeDong(slipAmount);
  const selectedRemaining = selected.reduce((sum, candidate) => sum + candidate.remainingTotal, 0);
  if (wholeDong(selectedRemaining) !== target) {
    return { ok: false, code: "total_mismatch", diff: target - wholeDong(selectedRemaining) };
  }

  const allocations: SharedSlipAllocation[] = [];
  for (const candidate of selected) {
    for (const item of candidate.items) {
      if (item.remaining <= 0) continue;
      allocations.push({
        request_id: candidate.requestId,
        item_id: item.id,
        amount: item.remaining,
      });
    }
  }

  const allocated = allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
  if (wholeDong(allocated) !== target) {
    return { ok: false, code: "total_mismatch", diff: target - wholeDong(allocated) };
  }

  return { ok: true, allocations };
}
