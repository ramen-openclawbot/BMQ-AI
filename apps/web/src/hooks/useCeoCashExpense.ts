import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import {
  ceoCashExpenseErrorMessage,
  ceoCashExpenseIdempotencyKey,
  parseCeoCashExpenseErrorCode,
  validateCeoCashExpenseForm,
  type CeoCashExpenseFormFields,
} from "@/lib/ceo-cash-expense";

/** At most two OCR calls in flight so the OpenAI Vision gateway is not flooded. */
export const MAX_PARALLEL_CEO_CASH_READS = 2;

export interface CeoCashExpenseScanFile {
  image_base64: string;
  mime_type?: string;
}

export interface CeoCashExpenseOcrItem {
  product_name: string;
  quantity: number;
  unit: string | null;
  unit_price: number;
  line_total: number;
  cost_category_code: string;
}

export interface CeoCashExpenseDraft {
  id: string;
  file_sha256: string;
  storage_path: string;
  status: "draft" | "recorded" | "discarded";
  payee_name: string | null;
  matched_supplier_id: string | null;
  matched_supplier_name: string | null;
  expense_date: string | null;
  amount: number | null;
  description: string | null;
  cost_category_code: string | null;
  items: CeoCashExpenseOcrItem[];
  ocr_error: string | null;
  payment_request_id: string | null;
  payment_id: string | null;
  evidence_id: string | null;
}

export interface CeoCashExpenseRecordResult {
  payment_request_id: string;
  request_number: string | null;
  payment_id: string | null;
  evidence_id: string | null;
  replayed: boolean;
}

export type CeoCashExpenseScanStatus = "scanning" | "draft" | "error";

export interface CeoCashExpenseScanItem {
  index: number;
  status: CeoCashExpenseScanStatus;
  draft: CeoCashExpenseDraft | null;
  duplicate: boolean;
  errorCode: string | null;
  errorDetail: string | null;
}

export class CeoCashExpenseError extends Error {
  code: string;
  detail?: string;

  constructor(code: string, detail?: string) {
    super(code);
    this.name = "CeoCashExpenseError";
    this.code = code;
    this.detail = detail;
  }
}

export type CeoCashExpenseRecordOutcome =
  | { draftId: string; ok: true; result: CeoCashExpenseRecordResult }
  | { draftId: string; ok: false; code: string; message: string };

interface EdgeScanResponse {
  success: boolean;
  duplicate?: boolean;
  draft?: CeoCashExpenseDraft;
  code?: string;
  error?: string;
  detail?: string;
}

const extractEdgeError = async (error: unknown): Promise<CeoCashExpenseError> => {
  const context = (error as { context?: Response })?.context;
  if (context && typeof context.json === "function") {
    try {
      const payload = await context.json() as { code?: string; error?: string; detail?: string };
      const code = payload.code || payload.error || "scan_failed";
      return new CeoCashExpenseError(code, payload.detail);
    } catch {
      // Fall through to the generic error below.
    }
  }
  return new CeoCashExpenseError(
    "scan_failed",
    error instanceof Error ? error.message : undefined,
  );
};

const mapDraft = (row: Record<string, unknown>): CeoCashExpenseDraft => ({
  id: String(row.id ?? ""),
  file_sha256: String(row.file_sha256 ?? ""),
  storage_path: String(row.storage_path ?? ""),
  status: (row.status as CeoCashExpenseDraft["status"]) ?? "draft",
  payee_name: (row.payee_name as string | null) ?? null,
  matched_supplier_id: (row.matched_supplier_id as string | null) ?? null,
  matched_supplier_name: null,
  expense_date: (row.expense_date as string | null) ?? null,
  amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
  description: (row.description as string | null) ?? null,
  cost_category_code: (row.cost_category_code as string | null) ?? null,
  items: Array.isArray(row.items) ? (row.items as CeoCashExpenseOcrItem[]) : [],
  ocr_error: (row.ocr_error as string | null) ?? null,
  payment_request_id: (row.payment_request_id as string | null) ?? null,
  payment_id: (row.payment_id as string | null) ?? null,
  evidence_id: (row.evidence_id as string | null) ?? null,
});

const invalidateAfterRecord = (queryClient: ReturnType<typeof useQueryClient>) => {
  queryClient.invalidateQueries({ queryKey: ["ceo-cash-expense-drafts"] });
  queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
  queryClient.invalidateQueries({ queryKey: ["payment-request"] });
  queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
  queryClient.invalidateQueries({ queryKey: ["cost-classification-monthly-summary"] });
  queryClient.invalidateQueries({ queryKey: ["cost-classification-category-summary"] });
  queryClient.invalidateQueries({ queryKey: ["cost-classification-review-queue"] });
  queryClient.invalidateQueries({ queryKey: ["cost-classification-line-details"] });
};

/**
 * Data-only hook for the CEO cash-expense flow (no UI):
 *   - scanFiles reads 1..N voucher images through the ceo-cash-expense-scan edge
 *     function (at most two OCR calls in parallel); one failing image never
 *     breaks the whole batch;
 *   - record calls the owner-only record_ceo_cash_expense RPC with the stable
 *     "ceo-cash:<draft_id>" key. On a network/uncertain failure it re-reads the
 *     draft first so a successful-but-unconfirmed write is never repeated;
 *   - recordAll runs records sequentially and returns each result;
 *   - discard calls discard_ceo_cash_expense_draft.
 */
export function useCeoCashExpense() {
  const queryClient = useQueryClient();
  const [items, setItems] = useState<CeoCashExpenseScanItem[]>([]);
  const [running, setRunning] = useState(false);
  const runIdRef = useRef(0);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    setItems([]);
    setRunning(false);
  }, []);

  const readDraft = useCallback(async (draftId: string): Promise<CeoCashExpenseDraft | null> => {
    const { data, error } = await supabase
      .from("ceo_cash_expense_drafts")
      .select("*")
      .eq("id", draftId)
      .maybeSingle();
    if (error) {
      throw new CeoCashExpenseError("draft_lookup_failed", error.message);
    }
    return data ? mapDraft(data as Record<string, unknown>) : null;
  }, []);

  const scanFiles = useCallback(
    async (files: CeoCashExpenseScanFile[]): Promise<CeoCashExpenseScanItem[]> => {
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      const safeFiles = Array.isArray(files) ? files : [];
      const collected: CeoCashExpenseScanItem[] = safeFiles.map((_, index) => ({
        index,
        status: "scanning",
        draft: null,
        duplicate: false,
        errorCode: null,
        errorDetail: null,
      }));

      setRunning(true);
      setItems(collected.map((item) => ({ ...item })));

      const patch = (index: number, update: Partial<CeoCashExpenseScanItem>) => {
        collected[index] = { ...collected[index], ...update };
        if (runIdRef.current !== runId) return;
        setItems(collected.map((item) => ({ ...item })));
      };

      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= safeFiles.length) return;
          try {
            const { data, error } = await supabase.functions.invoke<EdgeScanResponse>(
              "ceo-cash-expense-scan",
              { body: safeFiles[index] },
            );
            if (error) throw await extractEdgeError(error);
            if (!data?.draft) {
              throw new CeoCashExpenseError(data?.code || data?.error || "scan_failed", data?.detail);
            }
            patch(index, {
              status: "draft",
              draft: data.draft,
              duplicate: data.duplicate === true,
            });
          } catch (error) {
            const code = error instanceof CeoCashExpenseError
              ? error.code
              : "scan_failed";
            const detail = error instanceof Error ? error.message : null;
            patch(index, { status: "error", errorCode: code, errorDetail: detail });
          }
        }
      };

      const workerCount = Math.min(MAX_PARALLEL_CEO_CASH_READS, safeFiles.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      if (runIdRef.current === runId) setRunning(false);
      return collected.map((item) => ({ ...item }));
    },
    [],
  );

  const record = useCallback(
    async (
      draftId: string,
      fields: CeoCashExpenseFormFields,
    ): Promise<CeoCashExpenseRecordResult> => {
      const trimmedId = String(draftId ?? "").trim();
      if (!trimmedId) throw new CeoCashExpenseError("draft_required");

      const validation = validateCeoCashExpenseForm(fields);
      if (validation.ok === false) {
        throw new CeoCashExpenseError(validation.code, validation.message);
      }

      const idempotencyKey = ceoCashExpenseIdempotencyKey(trimmedId);
      const { data, error } = await supabase.rpc("record_ceo_cash_expense", {
        p_draft_id: trimmedId,
        p_fields: fields as unknown as Json,
        p_idempotency_key: idempotencyKey,
      });

      if (error) {
        // Uncertain outcome: prefer reading the recorded state over retrying a write.
        try {
          const fresh = await readDraft(trimmedId);
          if (fresh?.status === "recorded" && fresh.payment_request_id) {
            invalidateAfterRecord(queryClient);
            return {
              payment_request_id: fresh.payment_request_id,
              request_number: null,
              payment_id: fresh.payment_id,
              evidence_id: fresh.evidence_id,
              replayed: true,
            };
          }
        } catch {
          // fall through to the mapped error
        }
        const code = parseCeoCashExpenseErrorCode(error.message);
        throw new CeoCashExpenseError(code, error.message);
      }

      invalidateAfterRecord(queryClient);
      const result = (data ?? {}) as Partial<CeoCashExpenseRecordResult>;
      return {
        payment_request_id: String(result.payment_request_id ?? ""),
        request_number: result.request_number ?? null,
        payment_id: result.payment_id ?? null,
        evidence_id: result.evidence_id ?? null,
        replayed: result.replayed === true,
      };
    },
    [queryClient, readDraft],
  );

  const recordAll = useCallback(
    async (
      entries: { draftId: string; fields: CeoCashExpenseFormFields }[],
    ): Promise<CeoCashExpenseRecordOutcome[]> => {
      const results: CeoCashExpenseRecordOutcome[] = [];
      for (const entry of Array.isArray(entries) ? entries : []) {
        try {
          const result = await record(entry.draftId, entry.fields);
          results.push({ draftId: entry.draftId, ok: true, result });
        } catch (error) {
          const code = error instanceof CeoCashExpenseError ? error.code : "record_failed";
          results.push({
            draftId: entry.draftId,
            ok: false,
            code,
            message: ceoCashExpenseErrorMessage(code),
          });
        }
      }
      return results;
    },
    [record],
  );

  const discard = useCallback(
    async (draftId: string): Promise<{ id: string; status: string }> => {
      const trimmedId = String(draftId ?? "").trim();
      if (!trimmedId) throw new CeoCashExpenseError("draft_required");
      const { data, error } = await supabase.rpc("discard_ceo_cash_expense_draft", {
        p_draft_id: trimmedId,
      });
      if (error) {
        const code = parseCeoCashExpenseErrorCode(error.message);
        throw new CeoCashExpenseError(code, error.message);
      }
      queryClient.invalidateQueries({ queryKey: ["ceo-cash-expense-drafts"] });
      const result = (data ?? {}) as { id?: string; status?: string };
      return { id: String(result.id ?? trimmedId), status: String(result.status ?? "discarded") };
    },
    [queryClient],
  );

  return { scanFiles, record, recordAll, discard, readDraft, items, running, reset };
}
