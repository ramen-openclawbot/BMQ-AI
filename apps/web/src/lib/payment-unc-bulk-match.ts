// Pure batch matcher for the "Trình chi gấp" bulk-UNC flow. No Supabase / React
// / network imports: the CEO uploads several UNC images at once, each image is
// read into a draft (amount, reference, transfer date, beneficiary name and
// transfer content) and this module proposes, per UNC, either one/many phiếu
// trình chi (matched) or the competing candidates (ambiguous) or nothing
// (unmatched / duplicate). The server still re-validates every confirm through
// public.approve_payment_requests_with_unc; this file only decides what to send.

import { normalizeUncReference } from "./payment-unc-matching";

export type UncBulkMatchStatus = "matched" | "ambiguous" | "unmatched" | "duplicate";

/** One UNC image already read by payment-unc-approve extract mode. */
export interface UncBulkRead {
  fileSha256: string;
  amount: number | null;
  beneficiaryName?: string | null;
  transferContent?: string | null;
  reference?: string | null;
  transferDate?: string | null;
}

/** One payable phiếu trình chi of the current đợt (remaining > 0). */
export interface UncBulkPaymentRequest {
  id: string;
  requestNumber: string;
  supplierId: string | null;
  supplierName: string | null;
  bankAccountName?: string | null;
  remaining: number;
  createdAt: string;
}

export interface UncBulkAllocation {
  paymentRequestId: string;
  amount: number;
}

export interface UncBulkOption {
  allocations: UncBulkAllocation[];
  total: number;
  supplierId: string | null;
  reason: string;
}

export interface UncBulkMatchResult {
  fileSha256: string;
  status: UncBulkMatchStatus;
  reason: string;
  allocations: UncBulkAllocation[];
  options: UncBulkOption[];
  supplierId: string | null;
}

const MAX_SUBSET_CANDIDATES = 20;
const MAX_SUBSET_RESULTS = 8;
const MAX_SUBSET_NODES = 50000;

const COMPANY_PREFIXES = [
  "cong ty tnhh mtv",
  "cong ty tnhh",
  "cong ty co phan",
  "cong ty cp",
  "cong ty",
  "cty tnhh",
  "cty",
  "tnhh mtv",
  "tnhh",
  "ctcp",
  "co phan",
  "doanh nghiep",
  "tap doan",
  "cp",
  "dn",
].sort((a, b) => b.length - a.length);

/** Lowercase, strip Vietnamese diacritics and collapse punctuation to spaces. */
export function foldUncText(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Drop leading company-form words (Công ty TNHH, CTCP, ...) after folding. */
export function normalizeCompanyName(value: string | null | undefined): string {
  let text = foldUncText(value);
  let changed = true;
  while (changed && text) {
    changed = false;
    for (const prefix of COMPANY_PREFIXES) {
      if (text === prefix) {
        text = "";
        changed = true;
        break;
      }
      if (text.startsWith(`${prefix} `)) {
        text = text.slice(prefix.length + 1).trim();
        changed = true;
        break;
      }
    }
  }
  return text;
}

/** Accent/company-prefix-insensitive name comparison. */
export function namesMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = normalizeCompanyName(left);
  const b = normalizeCompanyName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));
}

const formatVnd = (value: number): string =>
  `${new Intl.NumberFormat("vi-VN").format(Math.round(value))}\u00a0đ`;

const amountsEqual = (left: number, right: number): boolean =>
  Number.isFinite(left) && Number.isFinite(right) && Math.round(left * 100) === Math.round(right * 100);

const toAmount = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const requestTotal = (reqs: UncBulkPaymentRequest[]): number =>
  reqs.reduce((sum, req) => sum + Number(req.remaining), 0);

const allocationTotal = (allocations: UncBulkAllocation[]): number =>
  allocations.reduce((sum, allocation) => sum + Number(allocation.amount), 0);

const makeOption = (
  reqs: UncBulkPaymentRequest[],
  reason: string,
): UncBulkOption => ({
  allocations: reqs.map((req) => ({ paymentRequestId: req.id, amount: Number(req.remaining) })),
  total: requestTotal(reqs),
  supplierId: reqs[0]?.supplierId ?? null,
  reason,
});

const groupBy = <T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return groups;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Requests whose PR code appears in the UNC transfer content, tolerant of the
 * usual separators ("PR-AAAABBBB", "PR AAAABBBB", "pr.aaaabbbb").
 */
export function findMentionedRequests(
  transferContent: string | null | undefined,
  payable: UncBulkPaymentRequest[],
): UncBulkPaymentRequest[] {
  const content = String(transferContent ?? "").trim();
  if (!content) return [];
  const found: UncBulkPaymentRequest[] = [];
  for (const request of payable) {
    const needle = normalizeUncReference(request.requestNumber);
    if (!needle || needle.length < 4) continue;
    const body = needle
      .split("")
      .map((char) => escapeRegExp(char))
      .join("[\\s\\-_.\\/]*");
    const pattern = new RegExp(`(^|[^A-Za-z0-9])${body}([^A-Za-z0-9]|$)`, "i");
    if (pattern.test(content)) found.push(request);
  }
  return found;
}

/**
 * Bounded subset-sum over one supplier's payable requests. Returns every subset
 * (oldest first) whose remaining total equals the UNC amount, stopping after a
 * few results / search nodes so a large batch cannot hang the browser.
 */
function subsetOptions(candidates: UncBulkPaymentRequest[], amount: number): UncBulkOption[] {
  const sorted = [...candidates].sort((a, b) =>
    String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
  );
  const pool = sorted.slice(0, MAX_SUBSET_CANDIDATES);
  const options: UncBulkOption[] = [];
  const current: UncBulkPaymentRequest[] = [];
  let nodes = 0;

  const search = (start: number, sum: number): void => {
    if (options.length > MAX_SUBSET_RESULTS || nodes++ > MAX_SUBSET_NODES) return;
    if (amountsEqual(sum, amount)) {
      options.push(
        makeOption(
          current,
          `Tên người nhận khớp nhà cung cấp và tổng ${formatVnd(requestTotal(current))} bằng đúng số tiền UNC.`,
        ),
      );
      return;
    }
    for (let index = start; index < pool.length; index += 1) {
      const value = Number(pool[index].remaining);
      if (!Number.isFinite(value) || value <= 0) continue;
      if (sum + value > amount) continue;
      current.push(pool[index]);
      search(index + 1, sum + value);
      current.pop();
      if (options.length > MAX_SUBSET_RESULTS || nodes > MAX_SUBSET_NODES) break;
    }
  };

  search(0, 0);
  return options;
}

const emptyResult = (fileSha256: string): UncBulkMatchResult => ({
  fileSha256,
  status: "unmatched",
  reason: "",
  allocations: [],
  options: [],
  supplierId: null,
});

/**
 * Match every read UNC against the payable phiếu of the current đợt.
 *
 * Priority per UNC:
 *   1. transfer content mentions PR code(s) and their remaining total equals
 *      the UNC amount;
 *   2. beneficiary name matches a supplier (accent/company-prefix-insensitive)
 *      and one unique subset of that supplier's requests sums to the amount
 *      (oldest first, bounded search);
 *   3. amount alone, only when exactly one request across the whole đợt matches.
 * Several candidates -> ambiguous with the options; none -> unmatched; repeated
 * image hash or transaction reference -> duplicate. A request is never assigned
 * to two UNCs: on conflict every involved UNC becomes ambiguous.
 */
export function matchUncBulk(
  readings: UncBulkRead[],
  requests: UncBulkPaymentRequest[],
): UncBulkMatchResult[] {
  const payable = (requests ?? []).filter((request) => {
    const remaining = Number(request.remaining);
    return Number.isFinite(remaining) && remaining > 0;
  });

  const results: UncBulkMatchResult[] = readings.map((reading) => emptyResult(reading.fileSha256));

  // --- Duplicate images / references ---------------------------------------
  const duplicateReasons: (string | null)[] = readings.map(() => null);
  const bySha = new Map<string, number[]>();
  readings.forEach((reading, index) => {
    const sha = String(reading.fileSha256 ?? "").toLowerCase();
    if (!sha) return;
    const list = bySha.get(sha) ?? [];
    list.push(index);
    bySha.set(sha, list);
  });
  for (const list of bySha.values()) {
    if (list.length > 1) {
      for (const index of list) {
        duplicateReasons[index] = "Ảnh trùng: cùng mã SHA-256 với một UNC khác.";
      }
    }
  }
  const byReference = new Map<string, number[]>();
  readings.forEach((reading, index) => {
    const reference = normalizeUncReference(reading.reference);
    if (!reference) return;
    const list = byReference.get(reference) ?? [];
    list.push(index);
    byReference.set(reference, list);
  });
  for (const list of byReference.values()) {
    if (list.length > 1) {
      for (const index of list) {
        duplicateReasons[index] = duplicateReasons[index] ?? "Mã giao dịch trùng với một UNC khác.";
      }
    }
  }

  readings.forEach((reading, index) => {
    if (duplicateReasons[index]) {
      results[index] = {
        ...emptyResult(reading.fileSha256),
        status: "duplicate",
        reason: duplicateReasons[index] as string,
      };
      return;
    }

    const amount = toAmount(reading.amount);
    if (amount === null || amount <= 0) {
      results[index] = {
        ...emptyResult(reading.fileSha256),
        reason: "Chưa đọc được số tiền từ ảnh UNC.",
      };
      return;
    }

    // Rule 1 — PR code(s) in the transfer content.
    const mentioned = findMentionedRequests(reading.transferContent, payable);
    const mentionedOneSupplier =
      new Set(mentioned.map((request) => request.supplierId ?? `none:${request.id}`)).size === 1;
    if (mentioned.length > 0 && mentionedOneSupplier && amountsEqual(requestTotal(mentioned), amount)) {
      const option = makeOption(
        mentioned,
        `Nội dung chuyển khoản khớp mã phiếu ${mentioned.map((req) => req.requestNumber).join(", ")}.`,
      );
      results[index] = {
        ...emptyResult(reading.fileSha256),
        status: "matched",
        reason: option.reason,
        allocations: option.allocations,
        options: [option],
        supplierId: option.supplierId,
      };
      return;
    }

    // Rule 2 — beneficiary name matches a supplier.
    if (reading.beneficiaryName && String(reading.beneficiaryName).trim()) {
      const candidates = payable.filter((request) =>
        namesMatch(reading.beneficiaryName, request.supplierName)
        || namesMatch(reading.beneficiaryName, request.bankAccountName),
      );
      if (candidates.length > 0) {
        const groups = groupBy(
          candidates,
          (request) => request.supplierId ?? `name:${normalizeCompanyName(request.supplierName)}`,
        );
        const options: UncBulkOption[] = [];
        for (const group of groups.values()) options.push(...subsetOptions(group, amount));
        if (options.length === 1) {
          results[index] = {
            ...emptyResult(reading.fileSha256),
            status: "matched",
            reason: options[0].reason,
            allocations: options[0].allocations,
            options,
            supplierId: options[0].supplierId,
          };
          return;
        }
        if (options.length > 1) {
          results[index] = {
            ...emptyResult(reading.fileSha256),
            status: "ambiguous",
            reason: "Có nhiều tập phiếu cùng nhà cung cấp khớp số tiền UNC.",
            options,
          };
          return;
        }
        results[index] = {
          ...emptyResult(reading.fileSha256),
          reason: "Tên người nhận khớp nhà cung cấp nhưng không có tập phiếu nào có tổng bằng số tiền UNC.",
        };
        return;
      }
    }

    // Rule 3 — amount alone, only when exactly one request matches.
    const amountMatches = payable.filter((request) => amountsEqual(Number(request.remaining), amount));
    if (amountMatches.length === 1) {
      const option = makeOption(
        amountMatches,
        `Số tiền UNC khớp đúng số còn nợ của phiếu ${amountMatches[0].requestNumber}.`,
      );
      results[index] = {
        ...emptyResult(reading.fileSha256),
        status: "matched",
        reason: option.reason,
        allocations: option.allocations,
        options: [option],
        supplierId: option.supplierId,
      };
      return;
    }
    if (amountMatches.length > 1) {
      results[index] = {
        ...emptyResult(reading.fileSha256),
        status: "ambiguous",
        reason: "Nhiều phiếu có cùng số còn nợ bằng số tiền UNC.",
        options: amountMatches.map((request) =>
          makeOption([request], `Phiếu ${request.requestNumber} có số còn nợ bằng số tiền UNC.`),
        ),
      };
      return;
    }

    results[index] = {
      ...emptyResult(reading.fileSha256),
      reason: "Không tìm thấy phiếu nào khớp số tiền, mã phiếu hoặc tên người nhận.",
    };
  });

  // --- A request must not be assigned to two UNCs --------------------------
  const matchedByRequest = new Map<string, number[]>();
  results.forEach((result, index) => {
    if (result.status !== "matched") return;
    for (const allocation of result.allocations) {
      const list = matchedByRequest.get(allocation.paymentRequestId) ?? [];
      list.push(index);
      matchedByRequest.set(allocation.paymentRequestId, list);
    }
  });
  const conflicts = new Set<number>();
  for (const list of matchedByRequest.values()) {
    if (list.length > 1) list.forEach((index) => conflicts.add(index));
  }
  for (const index of conflicts) {
    const result = results[index];
    results[index] = {
      ...result,
      status: "ambiguous",
      allocations: [],
      options: result.allocations.length > 0
        ? [
            {
              allocations: result.allocations,
              total: allocationTotal(result.allocations),
              supplierId: result.supplierId,
              reason: result.reason,
            },
          ]
        : result.options,
      reason: "Phiếu này cũng được một UNC khác đề xuất; cả hai UNC cần xử lý thủ công.",
    };
  }

  return results;
}
