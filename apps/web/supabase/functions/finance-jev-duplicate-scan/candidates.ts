// Pure candidate-pair builder for the Jev duplicate scan.
//
// Given the payment requests of one supplier window, code decides which pairs
// are even worth asking Jev about; Jev never selects its own candidates. A pair
// is a candidate when both phiếu share a non-null supplier, sit on different
// purchase orders (a missing PO counts as a different one), are not rejected,
// have a positive total, differ by at most 5% of the larger amount and were
// created at most 45 days apart. Already-checked pairs whose exact state hash is
// unchanged are skipped. No I/O, no Supabase, no clock beyond the inputs.

export const CANDIDATE_AMOUNT_TOLERANCE = 0.05;
export const CANDIDATE_MAX_DAYS_APART = 45;
export const CANDIDATE_MIN_LIMIT = 1;
export const CANDIDATE_MAX_LIMIT = 100;
export const CANDIDATE_DEFAULT_LIMIT = 50;

export interface CandidateRequest {
  id: string;
  request_number: string;
  supplier_id: string | null;
  purchase_order_id: string | null;
  status: string;
  total_amount: number | null;
  created_at: string;
}

export interface CandidatePair {
  /** least(id_a, id_b) || ':' || greatest(id_a, id_b) */
  pair_key: string;
  supplier_id: string;
  pr_older: string;
  pr_newer: string;
  amount_older: number;
  amount_newer: number;
  days_apart: number;
  older: CandidateRequest;
  newer: CandidateRequest;
}

export interface ExistingStateHash {
  pair_key: string;
  state_hash: string | null;
}

export interface CandidateSelection {
  /** Selected pairs after the state-hash skip and the batch limit. */
  pairs: CandidatePair[];
  /** Total candidate pairs before the skip. */
  candidates: number;
  /** Pairs dropped because their stored state hash is unchanged. */
  skipped_unchanged: number;
}

/** Canonical pair key so both writers/readers agree regardless of argument order. */
export function candidatePairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
}

function amount(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Whole days between two ISO timestamps (absolute; 0 when unparsable). */
export function daysApart(createdA: string, createdB: string): number {
  const a = Date.parse(createdA);
  const b = Date.parse(createdB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.floor(Math.abs(a - b) / 86_400_000);
}

export function isCandidatePair(left: CandidateRequest, right: CandidateRequest): boolean {
  if (left.id === right.id) return false;
  if (!left.supplier_id || left.supplier_id !== right.supplier_id) return false;
  if (left.status === "rejected" || right.status === "rejected") return false;
  if (left.purchase_order_id === right.purchase_order_id) return false;
  const leftAmount = amount(left.total_amount);
  const rightAmount = amount(right.total_amount);
  if (!(leftAmount > 0) || !(rightAmount > 0)) return false;
  const larger = Math.max(leftAmount, rightAmount);
  if (Math.abs(leftAmount - rightAmount) > CANDIDATE_AMOUNT_TOLERANCE * larger) return false;
  const days = daysApart(left.created_at, right.created_at);
  if (!Number.isFinite(days) || days > CANDIDATE_MAX_DAYS_APART) return false;
  return true;
}

/** Oldest by created_at first; a tie falls back to the smaller id. */
function orderPair(left: CandidateRequest, right: CandidateRequest): [CandidateRequest, CandidateRequest] {
  if (left.created_at !== right.created_at) {
    return left.created_at < right.created_at ? [left, right] : [right, left];
  }
  return left.id < right.id ? [left, right] : [right, left];
}

export function toCandidatePair(left: CandidateRequest, right: CandidateRequest): CandidatePair {
  const [older, newer] = orderPair(left, right);
  return {
    pair_key: candidatePairKey(left.id, right.id),
    supplier_id: older.supplier_id as string,
    pr_older: older.id,
    pr_newer: newer.id,
    amount_older: amount(older.total_amount),
    amount_newer: amount(newer.total_amount),
    days_apart: daysApart(older.created_at, newer.created_at),
    older,
    newer,
  };
}

/**
 * Same amount first, then closer dates, then the newer phiếu first. Ties fall
 * back to pair_key so the order is deterministic.
 */
function comparePairs(left: CandidatePair, right: CandidatePair): number {
  const leftSame = Math.abs(left.amount_older - left.amount_newer) < 0.5 ? 0 : 1;
  const rightSame = Math.abs(right.amount_older - right.amount_newer) < 0.5 ? 0 : 1;
  if (leftSame !== rightSame) return leftSame - rightSame;
  if (left.days_apart !== right.days_apart) return left.days_apart - right.days_apart;
  const byNewer = right.newer.created_at.localeCompare(left.newer.created_at);
  if (byNewer !== 0) return byNewer;
  return left.pair_key.localeCompare(right.pair_key);
}

/** All qualifying pairs, sorted by priority. No skip and no limit. */
export function buildCandidatePairs(requests: readonly CandidateRequest[]): CandidatePair[] {
  const pairs: CandidatePair[] = [];
  for (let i = 0; i < requests.length; i += 1) {
    for (let j = i + 1; j < requests.length; j += 1) {
      if (isCandidatePair(requests[i], requests[j])) {
        pairs.push(toCandidatePair(requests[i], requests[j]));
      }
    }
  }
  return pairs.sort(comparePairs);
}

/**
 * Build, drop pairs whose stored state hash is unchanged, then cut to the batch
 * limit. `stateHashOf` is injected so this module stays free of state/hashing
 * dependencies; the handler passes the hash it already computed.
 */
export async function selectCandidateBatch(
  requests: readonly CandidateRequest[],
  options: {
    limit: number;
    existing: readonly ExistingStateHash[];
    stateHashOf: (pair: CandidatePair) => string | Promise<string>;
    /** Optional allow-list for a selective rerun. */
    pairKeys?: ReadonlySet<string>;
  },
): Promise<CandidateSelection> {
  const all = buildCandidatePairs(requests);
  const pairs = options.pairKeys ? all.filter((pair) => options.pairKeys!.has(pair.pair_key)) : all;
  const stored = new Map<string, string | null>();
  for (const row of options.existing) stored.set(row.pair_key, row.state_hash);

  const unchanged: CandidatePair[] = [];
  const changed: CandidatePair[] = [];
  for (const pair of pairs) {
    const storedHash = stored.get(pair.pair_key);
    if (storedHash !== undefined && storedHash !== null && storedHash === await options.stateHashOf(pair)) {
      unchanged.push(pair);
    } else {
      changed.push(pair);
    }
  }

  const limit = Math.max(CANDIDATE_MIN_LIMIT, Math.min(CANDIDATE_MAX_LIMIT, Math.floor(options.limit)));
  return {
    pairs: changed.slice(0, limit),
    candidates: pairs.length,
    skipped_unchanged: unchanged.length,
  };
}
