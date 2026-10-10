import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

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
            results[index] = {
              index,
              ok: false,
              errorCode: mapped.code,
              errorDetail: mapped.detail,
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

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    extractReceipts,
    discard,
    submit,
  };
}
