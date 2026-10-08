import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { usePaymentUncApproval } from "@/hooks/usePaymentUncApproval";
import {
  matchUncBulk,
  type UncBulkAllocation,
  type UncBulkMatchResult,
  type UncBulkOption,
  type UncBulkPaymentRequest,
  type UncBulkRead,
} from "@/lib/payment-unc-bulk-match";

/** At most two OCR calls in flight so the OpenAI Vision gateway is not flooded. */
export const MAX_PARALLEL_UNC_READS = 2;

/**
 * Per-UNC status for the bulk flow:
 *   reading    — OCR request in flight;
 *   matched    — exactly one allocation set proposed (ready to confirm);
 *   ambiguous  — several candidates, needs a human choice;
 *   unmatched  — nothing proposed;
 *   duplicate  — repeated image hash or transaction reference;
 *   confirming — confirm call in flight;
 *   done       — confirmed through approve_payment_requests_with_unc;
 *   error      — read/confirm failed, `errorCode` carries the server code.
 */
export type PaymentUncBulkItemStatus =
  | "reading"
  | "matched"
  | "ambiguous"
  | "unmatched"
  | "duplicate"
  | "confirming"
  | "done"
  | "error";

export interface PaymentUncBulkItem {
  index: number;
  status: PaymentUncBulkItemStatus;
  fileSha256: string | null;
  amount: number | null;
  reference: string | null;
  beneficiaryName: string | null;
  reason: string;
  allocations: UncBulkAllocation[];
  options: UncBulkOption[];
  errorCode: string | null;
  errorDetail: string | null;
}

export interface PaymentUncBulkFile {
  image_base64: string;
  mime_type?: string;
  slip_type?: string;
}

export interface PaymentUncBulkRunInput {
  /** Several UNC images chosen in one go. */
  files: PaymentUncBulkFile[];
  /** Các phiếu còn nợ của đợt trình currently open. */
  requests: UncBulkPaymentRequest[];
}

/** One UNC the CEO approved after review, with the phiếu it pays. */
export interface PaymentUncBulkChoice {
  index: number;
  allocations: UncBulkAllocation[];
}

export interface PaymentUncBulkRunResult {
  results: UncBulkMatchResult[];
}

const initialItem = (index: number): PaymentUncBulkItem => ({
  index,
  status: "reading",
  fileSha256: null,
  amount: null,
  reference: null,
  beneficiaryName: null,
  reason: "",
  allocations: [],
  options: [],
  errorCode: null,
  errorDetail: null,
});

const errorCodeOf = (error: unknown): string => {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return "bulk_unc_failed";
};

const errorDetailOf = (error: unknown): string | null =>
  error instanceof Error ? error.message : null;

/**
 * No UI: reads many UNC images (extract mode, max two in parallel), pairs them
 * with the payable phiếu through the pure matchUncBulk helper and then confirms
 * each matched UNC sequentially through the existing confirm mutation (which
 * calls approve_payment_requests_with_unc with allocations and the
 * `unc:<sha>` idempotency key). One failing UNC never stops the others.
 */
export function usePaymentUncBulk() {
  const { extract, confirm } = usePaymentUncApproval();
  const queryClient = useQueryClient();
  const [items, setItems] = useState<PaymentUncBulkItem[]>([]);
  const [running, setRunning] = useState(false);
  const runIdRef = useRef(0);
  const readingsRef = useRef<Map<number, UncBulkRead>>(new Map());
  const requestsRef = useRef<UncBulkPaymentRequest[]>([]);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    readingsRef.current = new Map();
    requestsRef.current = [];
    setItems([]);
    setRunning(false);
  }, []);

  const run = useCallback(
    async ({ files, requests }: PaymentUncBulkRunInput): Promise<PaymentUncBulkRunResult> => {
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      const safeFiles = Array.isArray(files) ? files : [];
      const safeRequests = Array.isArray(requests) ? requests : [];

      setRunning(true);
      setItems(safeFiles.map((_, index) => initialItem(index)));

      const patch = (index: number, update: Partial<PaymentUncBulkItem>) => {
        if (runIdRef.current !== runId) return;
        setItems((previous) =>
          previous.map((item, itemIndex) => (itemIndex === index ? { ...item, ...update } : item)),
        );
      };

      // --- Read every image, at most MAX_PARALLEL_UNC_READS at a time -------
      const readings: (UncBulkRead | null)[] = new Array(safeFiles.length).fill(null);
      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= safeFiles.length) return;
          try {
            const response = await extract.mutateAsync({
              image_base64: safeFiles[index].image_base64,
              mime_type: safeFiles[index].mime_type,
              slip_type: safeFiles[index].slip_type,
            });
            const reading: UncBulkRead = {
              fileSha256: response.file_sha256,
              amount: response.ocr.amount,
              beneficiaryName: response.ocr.beneficiary_name ?? null,
              transferContent: response.ocr.transfer_content ?? null,
              reference: response.ocr.reference ?? null,
              transferDate: response.ocr.transfer_date ?? null,
            };
            readings[index] = reading;
            patch(index, {
              status: "reading",
              fileSha256: response.file_sha256,
              amount: response.ocr.amount,
              reference: response.ocr.reference ?? null,
              beneficiaryName: response.ocr.beneficiary_name ?? null,
            });
          } catch (error) {
            patch(index, {
              status: "error",
              errorCode: errorCodeOf(error),
              errorDetail: errorDetailOf(error),
            });
          }
        }
      };
      const workerCount = Math.min(MAX_PARALLEL_UNC_READS, safeFiles.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      // --- Pair each read UNC with the payable phiếu ------------------------
      const entries = readings
        .map((reading, index) => (reading ? { index, reading } : null))
        .filter((entry): entry is { index: number; reading: UncBulkRead } => entry !== null);
      const matchResults = matchUncBulk(entries.map((entry) => entry.reading), safeRequests);
      const planned = entries.map((entry, resultIndex) => ({ entry, result: matchResults[resultIndex] }));
      for (const { entry, result } of planned) {
        patch(entry.index, {
          status: result.status,
          reason: result.reason,
          allocations: result.allocations,
          options: result.options,
        });
      }

      // Nothing is paid here: the CEO reviews the proposed pairs, then calls confirmItems.
      readingsRef.current = new Map(planned.map(({ entry }) => [entry.index, entry.reading]));
      requestsRef.current = safeRequests;
      if (runIdRef.current === runId) setRunning(false);
      return { results: matchResults };
    },
    [extract],
  );

  /**
   * Pays only what the CEO ticked after reviewing: matched items keep their
   * proposal, ambiguous ones pass the option the CEO picked. One UNC at a time,
   * each through approve_payment_requests_with_unc with the unc:<sha> key.
   */
  const confirmItems = useCallback(
    async (choices: PaymentUncBulkChoice[]) => {
      const runId = runIdRef.current;
      const patch = (index: number, update: Partial<PaymentUncBulkItem>) => {
        if (runIdRef.current !== runId) return;
        setItems((previous) =>
          previous.map((item, itemIndex) => (itemIndex === index ? { ...item, ...update } : item)),
        );
      };
      const requestById = new Map(requestsRef.current.map((request) => [request.id, request]));
      const used = new Set<string>();
      setRunning(true);
      for (const choice of choices) {
        const reading = readingsRef.current.get(choice.index);
        if (!reading || choice.allocations.length === 0) continue;
        const selected = choice.allocations
          .map((allocation) => requestById.get(allocation.paymentRequestId))
          .filter((request): request is UncBulkPaymentRequest => Boolean(request));
        if (
          selected.length !== choice.allocations.length
          || choice.allocations.some((allocation) => used.has(allocation.paymentRequestId))
        ) {
          patch(choice.index, {
            status: "error",
            errorCode: "request_not_found",
            errorDetail: "Phiếu đã thay đổi hoặc đã được chọn cho UNC khác; tải lại rồi thử lại.",
          });
          continue;
        }
        choice.allocations.forEach((allocation) => used.add(allocation.paymentRequestId));

        patch(choice.index, { status: "confirming", allocations: choice.allocations });
        try {
          await confirm.mutateAsync({
            requests: selected.map((request) => ({
              id: request.id,
              supplierId: request.supplierId,
              totalAmount: Number(request.remaining),
              allocatedAmount: 0,
              status: "pending",
              paymentStatus: "unpaid",
            })),
            allocations: choice.allocations.map((allocation) => ({
              paymentRequestId: allocation.paymentRequestId,
              amount: allocation.amount,
            })),
            file_sha256: reading.fileSha256,
            amount: reading.amount,
            idempotency_key: `unc:${reading.fileSha256}`,
          });
          patch(choice.index, { status: "done" });
        } catch (error) {
          patch(choice.index, {
            status: "error",
            errorCode: errorCodeOf(error),
            errorDetail: errorDetailOf(error),
          });
        }
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["payment-submission"] }),
        queryClient.invalidateQueries({ queryKey: ["payment-submissions"] }),
        queryClient.invalidateQueries({ queryKey: ["payment-requests"] }),
        queryClient.invalidateQueries({ queryKey: ["unpaid-payment-requests-page"] }),
      ]);
      if (runIdRef.current === runId) setRunning(false);
    },
    [confirm, queryClient],
  );

  return { run, confirmItems, reset, items, running };
}

