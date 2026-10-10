/**
 * Data-only hook for the cash-salary payout flow (Chi lương tiền mặt).
 *
 * The generated Database type does not know the payroll_bn_* / salary_payout_*
 * tables yet, so the Supabase client is cast once into the small local shape
 * used here. No JSX, no money/name logging.
 *
 * Writes go through the SECURITY DEFINER RPCs (create_salary_payout,
 * record_salary_payout_ceo_payment, submit_salary_payout_matches,
 * discard_salary_payout_receipt, cancel_salary_payout) and the salary-payout
 * edge function (OCR). Every RPC is idempotent by a stable key, and an uncertain
 * network error re-reads state before any retry instead of blindly repeating.
 */

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

/** At most two OCR calls in flight so the OpenAI Vision gateway is not flooded. */
export const MAX_PARALLEL_SALARY_RECEIPT_EXTRACTS = 2;

// ---------------------------------------------------------------------------
// Local client shape (covers the new tables missing from generated types)
// ---------------------------------------------------------------------------

interface DbErrorLike {
  message?: string;
  code?: string | null;
}

interface DbResult<T> {
  data: T | null;
  error: DbErrorLike | null;
}

interface SalaryPayoutQuery {
  select(columns?: string): SalaryPayoutQuery;
  eq(column: string, value: unknown): SalaryPayoutQuery;
  neq(column: string, value: unknown): SalaryPayoutQuery;
  order(column: string, options?: { ascending?: boolean }): SalaryPayoutQuery;
  limit(count: number): SalaryPayoutQuery;
  maybeSingle(): PromiseLike<DbResult<unknown>>;
  then<TResult1 = DbResult<unknown>, TResult2 = never>(
    onfulfilled?: ((value: DbResult<unknown>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>;
}

export interface SalaryPayoutClient {
  from(table: string): SalaryPayoutQuery;
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<DbResult<unknown>>;
  functions: {
    invoke(name: string, options?: { body?: unknown; headers?: Record<string, string> }): PromiseLike<
      DbResult<unknown>
    >;
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SalaryPayoutStatus = "pending" | "advanced" | "completed" | "cancelled";
export type SalaryPayoutReceiptStatus = "uploaded" | "matched" | "discarded";

export interface SalaryPayoutPeriodOption {
  period_id: string;
  period_name: string;
  published_at: string | null;
}

export interface SalaryPayoutHeader {
  id: string;
  payout_number: string;
  payroll_period_id: string;
  period_name: string;
  employee_count: number;
  total_amount: number;
  status: SalaryPayoutStatus;
  ceo_evidence_storage_path: string | null;
  ceo_evidence_sha256: string | null;
  ceo_paid_at: string | null;
  ceo_paid_by: string | null;
  completed_at: string | null;
  completed_by: string | null;
  created_by: string | null;
  created_at: string;
  note: string | null;
}

export interface SalaryPayoutLine {
  id: string;
  payout_id: string;
  employee_code: string;
  employee_name: string;
  net_pay: number;
  receipt_storage_path: string | null;
  receipt_sha256: string | null;
  receipt_amount: number | null;
  receipt_beneficiary: string | null;
  receipt_reference: string | null;
  matched_at: string | null;
  matched_by: string | null;
}

export interface SalaryPayoutReceipt {
  id: string;
  payout_id: string;
  storage_path: string;
  file_sha256: string;
  ocr_amount: number | null;
  ocr_beneficiary: string | null;
  ocr_reference: string | null;
  ocr_error: string | null;
  status: SalaryPayoutReceiptStatus;
  uploaded_by: string | null;
  created_at: string;
}

export interface SalaryPayoutData {
  payout: SalaryPayoutHeader;
  lines: SalaryPayoutLine[];
  receipts: SalaryPayoutReceipt[];
}

export interface SalaryPayoutCreateResult {
  payout_id: string;
  payout_number: string;
  period_name: string;
  employee_count: number;
  total_amount: number;
  status: SalaryPayoutStatus;
  replayed?: boolean;
}

export interface SalaryPayoutCeoEvidence {
  storage_path: string;
  file_sha256: string;
  ocr_amount: number | null;
  ocr_reference?: string | null;
}

export interface SalaryPayoutCeoPaymentResult {
  payout_id: string;
  payout_number: string;
  status: SalaryPayoutStatus;
  ceo_evidence_storage_path: string;
  ceo_evidence_sha256: string;
  idempotent?: boolean;
}

export interface SalaryPayoutSubmitMatchInput {
  receipt_id: string;
  line_id: string;
  /** Only consulted by the RPC when the receipt OCR amount is null. */
  amount?: number;
}

export interface SalaryPayoutSubmitResult {
  payout_id: string;
  status: SalaryPayoutStatus;
  matched_count: number;
  remaining_count: number;
  idempotent?: boolean;
}

export interface SalaryReceiptFileInput {
  image_base64: string;
  mime_type?: string;
}

export interface SalaryReceiptExtractItem {
  index: number;
  ok: boolean;
  duplicate?: boolean;
  receipt?: SalaryPayoutReceipt;
  errorCode?: string;
  errorDetail?: string;
}

// ---------------------------------------------------------------------------
// Idempotency keys (stable from the inputs so a retry replays)
// ---------------------------------------------------------------------------

export const buildSalaryPayoutCreateKey = (periodId: string): string =>
  `salary-payout:create:${periodId}`;

export const buildSalaryPayoutCeoPaymentKey = (payoutId: string, fileSha256: string): string =>
  `salary-payout:ceo:${payoutId}:${fileSha256}`;

export const buildSalaryPayoutMatchKey = (
  payoutId: string,
  matches: SalaryPayoutSubmitMatchInput[],
): string => {
  const pairs = [...new Set((matches || []).map((match) => `${match.receipt_id}:${match.line_id}`))]
    .sort()
    .join(",");
  return `salary-payout:match:${payoutId}:${pairs}`;
};

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

const client = supabase as unknown as SalaryPayoutClient;

export const loadSalaryPayout = async (payoutId: string): Promise<SalaryPayoutData | null> => {
  const { data, error } = await client.rpc("get_salary_payout", { p_id: payoutId });
  if (error) throw error;
  return (data as unknown as SalaryPayoutData) ?? null;
};

export const listPublishedPayrollPeriods = async (): Promise<SalaryPayoutPeriodOption[]> => {
  const { data, error } = await client
    .from("payroll_bn_payslips")
    .select("period_id,period_name,published_at")
    .order("published_at", { ascending: false });
  if (error) throw error;

  const options = new Map<string, SalaryPayoutPeriodOption>();
  for (const row of (data || []) as Array<{
    period_id: string | null;
    period_name: string | null;
    published_at: string | null;
  }>) {
    if (!row.period_id) continue;
    const existing = options.get(row.period_id);
    if (!existing || (!existing.published_at && row.published_at)) {
      options.set(row.period_id, {
        period_id: row.period_id,
        period_name: row.period_name || "Kỳ lương",
        published_at: row.published_at ?? null,
      });
    }
  }
  return [...options.values()];
};

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const KNOWN_SALARY_PAYOUT_ERRORS = [
  "insufficient_privilege",
  "period_id_required",
  "period_not_found",
  "no_published_payslips",
  "payout_already_exists",
  "payout_not_found",
  "payout_id_required",
  "not_pending",
  "not_advanced",
  "idempotency_key_required",
  "invalid_matches",
  "matches_required",
  "receipt_not_uploaded",
  "receipt_not_found",
  "receipt_required",
  "receipt_amount_required",
  "line_not_found",
  "line_already_matched",
  "amount_mismatch",
  "evidence_required",
  "evidence_reused",
  "invalid_evidence_sha256",
  "invalid_evidence_amount",
];

const errorMessageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown })?.message;
  return message === undefined ? String(error ?? "") : String(message);
};

const knownSalaryPayoutErrorCode = (error: unknown): string | null => {
  const message = errorMessageOf(error);
  return KNOWN_SALARY_PAYOUT_ERRORS.find((code) => message.includes(code)) ?? null;
};

const extractFunctionError = async (error: unknown): Promise<{ code: string; detail?: string }> => {
  const context = (error as { context?: Response })?.context;
  if (context && typeof context.json === "function") {
    try {
      const payload = await context.json() as { code?: string; error?: string; detail?: string };
      return { code: payload.code || payload.error || "salary_receipt_failed", detail: payload.detail };
    } catch {
      // Fall through to the generic error below.
    }
  }
  return { code: "salary_receipt_failed", detail: errorMessageOf(error) };
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSalaryPayout(payoutId: string | null) {
  const queryClient = useQueryClient();

  const periodsQuery = useQuery({
    queryKey: ["salary-payout", "periods"],
    queryFn: listPublishedPayrollPeriods,
    staleTime: 30_000,
  });

  const query = useQuery({
    queryKey: ["salary-payout", payoutId],
    enabled: !!payoutId,
    staleTime: 10_000,
    queryFn: () => (payoutId ? loadSalaryPayout(payoutId) : Promise.resolve(null)),
  });

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["salary-payout"] });
  }, [queryClient]);

  const create = useCallback(
    async (
      periodId: string,
      options?: { idempotencyKey?: string },
    ): Promise<SalaryPayoutCreateResult> => {
      const idempotencyKey = options?.idempotencyKey?.trim() || buildSalaryPayoutCreateKey(periodId);
      try {
        const { data, error } = await client.rpc("create_salary_payout", {
          p_period_id: periodId,
          p_idempotency_key: idempotencyKey,
        });
        if (error) throw error;
        invalidate();
        return data as unknown as SalaryPayoutCreateResult;
      } catch (error) {
        if (knownSalaryPayoutErrorCode(error)) throw error;
        // Uncertain outcome: read the live payout for this period before retrying.
        const { data } = await client
          .from("salary_payouts")
          .select("id,payout_number,period_name,employee_count,total_amount,status")
          .eq("payroll_period_id", periodId)
          .neq("status", "cancelled")
          .limit(1)
          .maybeSingle();
        const row = data as Record<string, unknown> | null;
        if (row?.id) {
          invalidate();
          return {
            payout_id: String(row.id),
            payout_number: String(row.payout_number || ""),
            period_name: String(row.period_name || ""),
            employee_count: Number(row.employee_count || 0),
            total_amount: Number(row.total_amount || 0),
            status: row.status as SalaryPayoutStatus,
            replayed: true,
          };
        }
        throw error;
      }
    },
    [invalidate],
  );

  const ceoExtract = useCallback(
    async (imageBase64: string, mimeType?: string): Promise<SalaryPayoutCeoEvidence> => {
      const { data, error } = await client.functions.invoke("salary-payout", {
        body: { mode: "ceo_extract", image_base64: imageBase64, mime_type: mimeType },
      });
      if (error) throw error;
      const payload = data as { storage_path?: string; file_sha256?: string; ocr_amount?: number | null; ocr_reference?: string | null };
      if (!payload?.storage_path || !payload?.file_sha256) throw new Error("ceo_extract_failed");
      return {
        storage_path: payload.storage_path,
        file_sha256: payload.file_sha256,
        ocr_amount: payload.ocr_amount ?? null,
        ocr_reference: payload.ocr_reference ?? null,
      };
    },
    [],
  );

  const recordCeoPayment = useCallback(
    async (
      targetPayoutId: string,
      evidence: SalaryPayoutCeoEvidence,
      options?: { idempotencyKey?: string },
    ): Promise<SalaryPayoutCeoPaymentResult> => {
      const idempotencyKey = options?.idempotencyKey?.trim()
        || buildSalaryPayoutCeoPaymentKey(targetPayoutId, evidence.file_sha256);
      try {
        const { data, error } = await client.rpc("record_salary_payout_ceo_payment", {
          p_id: targetPayoutId,
          p_evidence: {
            storage_path: evidence.storage_path,
            file_sha256: evidence.file_sha256,
            ocr_amount: evidence.ocr_amount,
          },
          p_idempotency_key: idempotencyKey,
        });
        if (error) throw error;
        invalidate();
        return data as unknown as SalaryPayoutCeoPaymentResult;
      } catch (error) {
        if (knownSalaryPayoutErrorCode(error)) throw error;
        const fresh = await loadSalaryPayout(targetPayoutId);
        if (fresh && fresh.payout.ceo_evidence_sha256 === evidence.file_sha256) {
          invalidate();
          return {
            payout_id: fresh.payout.id,
            payout_number: fresh.payout.payout_number,
            status: fresh.payout.status,
            ceo_evidence_storage_path: fresh.payout.ceo_evidence_storage_path || evidence.storage_path,
            ceo_evidence_sha256: fresh.payout.ceo_evidence_sha256,
            idempotent: true,
          };
        }
        throw error;
      }
    },
    [invalidate],
  );

  const extractReceipts = useCallback(
    async (
      targetPayoutId: string,
      files: SalaryReceiptFileInput[],
    ): Promise<SalaryReceiptExtractItem[]> => {
      const safeFiles = Array.isArray(files) ? files : [];
      const results: SalaryReceiptExtractItem[] = safeFiles.map((_, index) => ({ index, ok: false }));

      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= safeFiles.length) return;
          try {
            const { data, error } = await client.functions.invoke("salary-payout", {
              body: {
                mode: "receipt_extract",
                payout_id: targetPayoutId,
                image_base64: safeFiles[index].image_base64,
                mime_type: safeFiles[index].mime_type,
              },
            });
            if (error) throw error;
            const payload = data as {
              success?: boolean;
              duplicate?: boolean;
              receipt?: SalaryPayoutReceipt;
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

      const workerCount = Math.min(MAX_PARALLEL_SALARY_RECEIPT_EXTRACTS, safeFiles.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      invalidate();
      return results;
    },
    [invalidate],
  );

  const discard = useCallback(
    async (receiptId: string) => {
      const { data, error } = await client.rpc("discard_salary_payout_receipt", {
        p_receipt_id: receiptId,
      });
      if (error) throw error;
      invalidate();
      return data as unknown as { id: string; status: string };
    },
    [invalidate],
  );

  const submitMatches = useCallback(
    async (
      targetPayoutId: string,
      matches: SalaryPayoutSubmitMatchInput[],
      options?: { idempotencyKey?: string },
    ): Promise<SalaryPayoutSubmitResult> => {
      const safeMatches = Array.isArray(matches) ? matches : [];
      const idempotencyKey = options?.idempotencyKey?.trim()
        || buildSalaryPayoutMatchKey(targetPayoutId, safeMatches);
      try {
        const { data, error } = await client.rpc("submit_salary_payout_matches", {
          p_id: targetPayoutId,
          p_matches: safeMatches,
          p_idempotency_key: idempotencyKey,
        });
        if (error) throw error;
        invalidate();
        return data as unknown as SalaryPayoutSubmitResult;
      } catch (error) {
        if (knownSalaryPayoutErrorCode(error)) throw error;
        // Uncertain outcome: re-read the payout and only synthesize when the
        // submitted lines are actually matched.
        const fresh = await loadSalaryPayout(targetPayoutId);
        if (fresh) {
          const matchedIds = new Set(
            fresh.lines.filter((line) => line.receipt_storage_path !== null).map((line) => line.id),
          );
          const landed = safeMatches.every((match) => matchedIds.has(match.line_id));
          if (landed) {
            invalidate();
            const remaining = fresh.lines.filter((line) => line.receipt_storage_path === null).length;
            return {
              payout_id: fresh.payout.id,
              status: fresh.payout.status,
              matched_count: safeMatches.length,
              remaining_count: remaining,
              idempotent: true,
            };
          }
        }
        throw error;
      }
    },
    [invalidate],
  );

  return {
    periods: periodsQuery.data ?? [],
    isLoadingPeriods: periodsQuery.isLoading,
    periodsError: periodsQuery.error,
    refetchPeriods: periodsQuery.refetch,
    data: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    create,
    load: loadSalaryPayout,
    ceoExtract,
    recordCeoPayment,
    extractReceipts,
    discard,
    submitMatches,
  };
}
