import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { AI_QUOTA_CODE, AI_QUOTA_MESSAGE, isAiQuotaError, notifyAiQuotaExhausted } from "@/lib/ai-errors";
import type { SharedSlipAllocation, SharedSlipCandidate } from "@/lib/cash-shared-slip";

/** At most two OCR calls in flight so the OpenAI Vision gateway is not flooded. */
export const MAX_PARALLEL_CASH_RECEIPT_EXTRACTS = 2;

export interface CashSettlementItem {
  id: string;
  product_name: string;
  amount: number;
  covered: number;
}

export type CashReceiptStatus = "uploaded" | "allocated" | "discarded";

export interface CashSettlementReceipt {
  id: string;
  payment_request_item_id: string | null;
  storage_path: string;
  file_sha256: string;
  ocr_amount: number | null;
  ocr_payee: string | null;
  ocr_date: string | null;
  ocr_reference: string | null;
  ocr_content: string | null;
  ocr_error: string | null;
  amount: number | null;
  status: CashReceiptStatus;
  uploaded_by: string | null;
  created_at: string;
  allocated_at: string | null;
  /** Split allocations when one receipt pays 2+ items; [] for legacy receipts. */
  splits?: { item_id: string; amount: number; request_id?: string }[];
  /** Set when the receipt belongs to another phiếu and was split into this one. */
  shared_from_request_id?: string | null;
  shared_from_request_number?: string | null;
}

export interface CashSettlementAttachment {
  id: string;
  storage_path: string;
  file_name: string | null;
  mime_type: string | null;
  uploaded_by: string | null;
  created_at: string;
}

export interface CashSettlementHeader {
  id: string;
  request_number: string;
  title: string;
  description: string | null;
  status: string;
  payment_status: string;
  payment_method: string | null;
  total_amount: number | null;
  supplier_id: string | null;
  supplier_name: string | null;
  created_by: string | null;
  requester_name: string | null;
  cash_settlement_status: "awaiting_receipts" | "completed" | null;
  cash_settled_at: string | null;
  cash_settled_by: string | null;
}

export interface CashSettlementData {
  payment_request: CashSettlementHeader;
  items: CashSettlementItem[];
  receipts: CashSettlementReceipt[];
  evidence: unknown[];
  attachments: CashSettlementAttachment[];
}

export type CashSettlementAllocationInput = {
  receipt_id: string;
  item_id: string;
  amount: number;
};

export interface CashSettlementSubmitResult {
  status: "awaiting_receipts" | "completed";
  covered_total: number;
  remaining_total: number;
  items: { item_id: string; amount: number; covered: number }[];
  idempotent?: boolean;
}

export interface CashSharedSlipRequestResult {
  request_id: string;
  request_number: string;
  status: "awaiting_receipts" | "completed";
  covered_total: number;
  remaining_total: number;
}

export interface CashSharedSlipSubmitResult {
  status: "ok";
  requests: CashSharedSlipRequestResult[];
  idempotent?: boolean;
}

export interface CashReceiptFileInput {
  image_base64: string;
  mime_type?: string;
}

export interface CashReceiptExtractItem {
  index: number;
  ok: boolean;
  duplicate?: boolean;
  receipt?: CashSettlementReceipt;
  errorCode?: string;
  errorDetail?: string;
}

export const loadCashSettlement = async (requestId: string): Promise<CashSettlementData | null> => {
  const { data, error } = await supabase.rpc("get_cash_settlement", { p_request_id: requestId });
  if (error) throw error;
  return (data as unknown as CashSettlementData) ?? null;
};

interface CashSharedSlipCandidateRow {
  id: string;
  request_number: string;
  title?: string | null;
  supplier_name?: string | null;
  total_amount?: number | null;
  is_current?: boolean;
  remaining_total?: number | null;
  items?: { id: string; remaining?: number | null }[];
}

/** Load the cash phiếu of the same requester that one slip may settle. */
export const loadCashSharedSlipCandidates = async (requestId: string): Promise<SharedSlipCandidate[]> => {
  const { data, error } = await supabase.rpc("list_cash_shared_slip_candidates", { p_request_id: requestId });
  if (error) throw error;
  const rows = Array.isArray(data) ? (data as unknown as CashSharedSlipCandidateRow[]) : [];
  return rows.map((row) => ({
    requestId: row.id,
    requestNumber: row.request_number,
    isCurrent: row.is_current === true,
    remainingTotal: Number(row.remaining_total) || 0,
    items: (Array.isArray(row.items) ? row.items : []).map((item) => ({
      id: item.id,
      remaining: Number(item.remaining) || 0,
    })),
  }));
};

/** Stable key: one submit per request + receipt set, so a retry replays instead of duplicating. */
export const buildCashSettlementIdempotencyKey = (
  requestId: string,
  allocations: CashSettlementAllocationInput[],
): string => {
  const receipts = [...new Set((allocations || []).map((allocation) => allocation.receipt_id))]
    .sort()
    .join(",");
  return `cash-settle:${requestId}:${receipts}`;
};

const KNOWN_CASH_SETTLEMENT_ERRORS = [
  "insufficient_privilege",
  "request_id_required",
  "idempotency_key_required",
  "invalid_allocation",
  "allocation_required",
  "receipt_not_uploaded",
  "item_not_found",
  "item_over_allocated",
  "receipt_over_allocated",
  "not_awaiting_receipts",
  "request_not_found",
  "shared_total_mismatch",
  "requester_mismatch",
  "receipt_amount_missing",
  "invalid_idempotency_key",
];

const knownCashSettlementErrorCode = (error: unknown): string | null => {
  const message = error instanceof Error
    ? error.message
    : String((error as { message?: unknown })?.message ?? error ?? "");
  return KNOWN_CASH_SETTLEMENT_ERRORS.find((code) => message.includes(code)) ?? null;
};

const extractFunctionError = async (error: unknown): Promise<{ code: string; detail?: string }> => {
  const context = (error as { context?: Response })?.context;
  if (context && typeof context.json === "function") {
    try {
      const payload = await context.json() as { code?: string; error?: string; detail?: string };
      return { code: payload.code || payload.error || "cash_receipt_failed", detail: payload.detail };
    } catch {
      // Fall through to the generic error below.
    }
  }
  return {
    code: "cash_receipt_failed",
    detail: error instanceof Error ? error.message : undefined,
  };
};

const allocationLanded = (data: CashSettlementData, allocations: CashSettlementAllocationInput[]): boolean => {
  const allocated = new Set(
    data.receipts.filter((receipt) => receipt.status === "allocated").map((receipt) => receipt.id),
  );
  return allocations.every((allocation) => allocated.has(allocation.receipt_id));
};

const synthesizeResult = (data: CashSettlementData): CashSettlementSubmitResult => {
  const items = (data.items || []).map((item) => ({
    item_id: item.id,
    amount: Number(item.amount) || 0,
    covered: Number(item.covered) || 0,
  }));
  const covered = items.reduce((sum, item) => sum + item.covered, 0);
  const expected = items.reduce((sum, item) => sum + item.amount, 0);
  return {
    status: data.payment_request.cash_settlement_status === "completed" ? "completed" : "awaiting_receipts",
    covered_total: covered,
    remaining_total: Math.max(expected - covered, 0),
    items,
    idempotent: true,
  };
};

/**
 * Short, stable shared-slip idempotency key component. The full allocation
 * signature can be thousands of bytes (up to 100 rows), which would overflow
 * the payment_cash_settlement_idempotency btree primary key, so hash it.
 */
const sha256Hex = async (value: string): Promise<string> => {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
      // Non-secure contexts may not expose SubtleCrypto; use the fallback below.
    }
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
};

const toCents = (value: unknown): number => Math.round(Number(value) * 100);

/** True only when the fresh receipt carries exactly the submitted split rows. */
const receiptHasExactSplits = (
  receipt: CashSettlementReceipt,
  allocations: SharedSlipAllocation[],
): boolean => {
  const splits = receipt.splits ?? [];
  if (splits.length !== allocations.length) return false;
  const byItem = new Map(splits.map((split) => [split.item_id, split.amount]));
  return allocations.every((allocation) => {
    const amount = byItem.get(allocation.item_id);
    return amount !== undefined && toCents(amount) === toCents(allocation.amount);
  });
};

/** Rebuild the per-phiếu result after an uncertain shared submit. */
const rebuildSharedSlipResult = (
  requestIds: string[],
  dataById: Map<string, CashSettlementData>,
): CashSharedSlipSubmitResult => {
  const requests = requestIds.map((requestId) => {
    const data = dataById.get(requestId) as CashSettlementData;
    const items = data.items || [];
    const covered = items.reduce((sum, item) => sum + (Number(item.covered) || 0), 0);
    const expected = items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
    return {
      request_id: requestId,
      request_number: data.payment_request.request_number,
      status: data.payment_request.cash_settlement_status === "completed"
        ? "completed" as const
        : "awaiting_receipts" as const,
      covered_total: covered,
      remaining_total: Math.max(expected - covered, 0),
    };
  });
  return { status: "ok", requests, idempotent: true };
};

/**
 * Data-only hook for the cash settlement page: load the settlement, OCR many
 * receipts (max two at a time), discard uploaded receipts and submit the
 * allocation. No JSX.
 */
export function useCashSettlement(requestId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["cash-settlement", requestId],
    enabled: !!requestId,
    staleTime: 15000,
    queryFn: () => (requestId ? loadCashSettlement(requestId) : Promise.resolve(null)),
  });

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["cash-settlement"] });
    queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
    queryClient.invalidateQueries({ queryKey: ["payment-request"] });
    queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
  }, [queryClient]);

  const extractReceipts = useCallback(
    async (files: CashReceiptFileInput[]): Promise<CashReceiptExtractItem[]> => {
      if (!requestId) throw new Error("missing_request_id");
      const safeFiles = Array.isArray(files) ? files : [];
      const results: CashReceiptExtractItem[] = safeFiles.map((_, index) => ({ index, ok: false }));

      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= safeFiles.length) return;
          try {
            const { data, error } = await supabase.functions.invoke("payment-cash-settle", {
              body: {
                mode: "extract",
                request_id: requestId,
                image_base64: safeFiles[index].image_base64,
                mime_type: safeFiles[index].mime_type,
              },
            });
            if (error) throw error;
            const payload = data as {
              success?: boolean;
              duplicate?: boolean;
              receipt?: CashSettlementReceipt;
            };
            results[index] = {
              index,
              ok: true,
              duplicate: payload?.duplicate === true,
              receipt: payload?.receipt,
            };
          } catch (error) {
            const mapped = await extractFunctionError(error);
            const quota = isAiQuotaError(mapped) || isAiQuotaError(error);
            if (quota) notifyAiQuotaExhausted();
            results[index] = {
              index,
              ok: false,
              errorCode: quota ? AI_QUOTA_CODE : mapped.code,
              errorDetail: quota ? AI_QUOTA_MESSAGE : mapped.detail,
            };
          }
        }
      };

      const workerCount = Math.min(MAX_PARALLEL_CASH_RECEIPT_EXTRACTS, safeFiles.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      invalidate();
      return results;
    },
    [requestId, invalidate],
  );

  const discard = useCallback(
    async (receiptId: string) => {
      const { data, error } = await supabase.rpc("discard_cash_receipt", { p_receipt_id: receiptId });
      if (error) throw error;
      invalidate();
      return data as unknown as { id: string; status: string };
    },
    [invalidate],
  );

  const submit = useCallback(
    async (
      allocations: CashSettlementAllocationInput[],
      options?: { idempotencyKey?: string },
    ): Promise<CashSettlementSubmitResult> => {
      if (!requestId) throw new Error("missing_request_id");
      const safeAllocations = Array.isArray(allocations) ? allocations : [];
      const idempotencyKey = options?.idempotencyKey?.trim()
        || buildCashSettlementIdempotencyKey(requestId, safeAllocations);

      try {
        const { data, error } = await supabase.rpc("submit_cash_settlement", {
          p_request_id: requestId,
          p_allocations: safeAllocations,
          p_idempotency_key: idempotencyKey,
        });
        if (error) throw error;
        invalidate();
        return data as unknown as CashSettlementSubmitResult;
      } catch (error) {
        // A deterministic business rejection is final; an uncertain failure
        // (network/timeout) must re-read the settlement before any retry so a
        // landed write is never repeated.
        if (knownCashSettlementErrorCode(error)) throw error;
        const fresh = await loadCashSettlement(requestId);
        if (fresh && allocationLanded(fresh, safeAllocations)) {
          invalidate();
          return synthesizeResult(fresh);
        }
        throw error;
      }
    },
    [requestId, invalidate],
  );

  const submitSharedSlip = useCallback(
    async (
      receiptId: string,
      allocations: SharedSlipAllocation[],
    ): Promise<CashSharedSlipSubmitResult> => {
      if (!requestId) throw new Error("missing_request_id");
      const safeAllocations = Array.isArray(allocations) ? allocations : [];
      // Stable key: a retry of the same receipt + sorted allocation list replays
      // the stored result instead of writing more split rows / Zalo outbox rows.
      const signature = safeAllocations
        .map((allocation) => `${allocation.request_id}:${allocation.item_id}:${allocation.amount}`)
        .sort()
        .join("|");
      // Postgres renders uuid::text in lowercase; match that so the server's
      // cash-shared:<receipt_id>: prefix check always recognizes the key.
      const keyReceiptId = String(receiptId).trim().toLowerCase();
      const idempotencyKey = `cash-shared:${keyReceiptId}:${await sha256Hex(signature)}`;

      try {
        const { data, error } = await supabase.rpc("submit_cash_shared_slip", {
          p_receipt_id: receiptId,
          p_allocations: safeAllocations,
          p_idempotency_key: idempotencyKey,
        });
        if (error) throw error;
        invalidate();
        return data as unknown as CashSharedSlipSubmitResult;
      } catch (error) {
        // A deterministic business rejection is final. An uncertain failure
        // (network/timeout) re-reads the receipt's phiếu: if the receipt is
        // already allocated the write landed, so never retry it.
        if (knownCashSettlementErrorCode(error)) throw error;
        const fresh = await loadCashSettlement(requestId);
        const receipt = fresh?.receipts.find((entry) => entry.id === receiptId);
        if (
          !fresh
          || !receipt
          || receipt.status !== "allocated"
          || !receiptHasExactSplits(receipt, safeAllocations)
        ) {
          throw error;
        }

        // The submitted split rows are on the receipt. Re-read every affected
        // phiếu so the caller gets the real per-phiếu result instead of a
        // blanket success (a different single-phiếu allocation must not pass).
        const requestIds = [...new Set(safeAllocations.map((allocation) => allocation.request_id))];
        const datasets = await Promise.all(requestIds.map((id) => (
          id === requestId ? Promise.resolve(fresh) : loadCashSettlement(id)
        )));
        const dataById = new Map<string, CashSettlementData>();
        requestIds.forEach((id, index) => {
          const data = datasets[index];
          if (data) dataById.set(id, data);
        });
        if (dataById.size !== requestIds.length) throw error;

        invalidate();
        return rebuildSharedSlipResult(requestIds, dataById);
      }
    },
    [requestId, invalidate],
  );

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    extractReceipts,
    discard,
    submit,
    submitSharedSlip,
  };
}
