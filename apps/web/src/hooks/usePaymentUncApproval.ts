import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  evaluatePaymentUncMatch,
  normalizeUncReference,
  type UncMatchCode,
  type UncPaymentRequestInput,
} from "@/lib/payment-unc-matching";

export { normalizeUncReference };
export type { UncMatchCode, UncPaymentRequestInput };

export interface UncOcrResult {
  amount: number | null;
  amount_raw: string | null;
  amount_in_words: string | null;
  reference: string | null;
  transfer_date: string | null;
  confidence: number | null;
  amount_corrected_from_words: boolean;
}

export interface UncExtractResponse {
  success: true;
  mode: "extract";
  file_sha256: string;
  storage_path: string;
  suggested_idempotency_key: string;
  ocr: UncOcrResult;
}

export interface UncConfirmResponse {
  success: true;
  mode: "confirm";
  result: {
    status: string;
    payment_id: string;
    payment_request_ids: string[];
    amount: number;
    evidence_amount: number | null;
    manual_override: boolean;
    reference_number: string | null;
    idempotent: boolean;
  };
}

export class PaymentUncApprovalError extends Error {
  code: string;
  detail?: string;

  constructor(code: string, detail?: string) {
    super(code);
    this.name = "PaymentUncApprovalError";
    this.code = code;
    this.detail = detail;
  }
}

const extractError = async (error: unknown): Promise<PaymentUncApprovalError> => {
  const context = (error as { context?: Response })?.context;
  if (context && typeof context.json === "function") {
    try {
      const payload = await context.json() as { code?: string; error?: string; detail?: string };
      return new PaymentUncApprovalError(payload.code || payload.error || "approval_failed", payload.detail);
    } catch {
      // Fall through to the generic error below.
    }
  }
  return new PaymentUncApprovalError(
    "approval_failed",
    error instanceof Error ? error.message : undefined,
  );
};

async function invokePaymentUncApproval<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("payment-unc-approve", { body });
  if (error) throw await extractError(error);
  return data as T;
}

export function usePaymentUncApproval() {
  const queryClient = useQueryClient();

  const extract = useMutation({
    mutationFn: async (payload: {
      image_base64: string;
      mime_type?: string;
      slip_type?: string;
    }) => invokePaymentUncApproval<UncExtractResponse>({ mode: "extract", ...payload }),
  });

  const confirm = useMutation({
    mutationFn: async (payload: {
      requests: UncPaymentRequestInput[];
      file_sha256: string;
      amount?: number | null;
      manual_override?: boolean;
      override_reason?: string | null;
      idempotency_key?: string;
      note?: string | null;
    }) => {
      // Fail fast on the same guards the RPC enforces; the server re-validates.
      const match = evaluatePaymentUncMatch({
        requests: payload.requests,
        evidenceAmount: payload.amount,
        manualOverride: payload.manual_override,
        overrideReason: payload.override_reason,
      });
      if (!match.ok) throw new PaymentUncApprovalError(match.code);

      return invokePaymentUncApproval<UncConfirmResponse>({
        mode: "confirm",
        request_ids: payload.requests.map((request) => request.id),
        file_sha256: payload.file_sha256,
        amount: payload.amount,
        manual_override: payload.manual_override === true,
        override_reason: payload.override_reason ?? null,
        idempotency_key: payload.idempotency_key,
        note: payload.note ?? null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-request"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      queryClient.invalidateQueries({ queryKey: ["unc-evidence-day-total"] });
    },
  });

  const record = useMutation({
    mutationFn: async (payload: {
      file_sha256: string;
      category: UncStandaloneCategory;
      note?: string | null;
      amount?: number | null;
      manual_override?: boolean;
      override_reason?: string | null;
    }) => {
      if (payload.manual_override && !payload.override_reason?.trim()) {
        throw new PaymentUncApprovalError("override_reason_required");
      }
      return invokePaymentUncApproval<UncRecordResponse>({
        mode: "record",
        file_sha256: payload.file_sha256,
        category: payload.category,
        note: payload.note ?? null,
        amount: payload.amount ?? null,
        manual_override: payload.manual_override === true,
        override_reason: payload.override_reason ?? null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unc-evidence-day-total"] });
    },
  });

  return { extract, confirm, record };
}

export type UncStandaloneCategory = "luong" | "thue" | "thue_nha" | "khac";

export interface UncRecordResponse {
  success: true;
  mode: "record";
  result: { id: string; category: UncStandaloneCategory; ocr_amount: number | null; reference_number: string | null };
}

export interface UncEvidenceDayTotal {
  total: number;
  count: number;
}

/** Owner-only: UNC total for one Vietnam day from evidence uploaded in the app. */
export function useUncEvidenceDayTotal(date: string | null, enabled = true) {
  return useQuery({
    queryKey: ["unc-evidence-day-total", date],
    enabled: enabled && !!date,
    queryFn: async (): Promise<UncEvidenceDayTotal> => {
      const { data, error } = await supabase.rpc("finance_unc_total_from_evidence", { p_date: date as string });
      if (error) throw error;
      const row = (data ?? {}) as { total_amount?: unknown; evidence_count?: unknown };
      return {
        total: Number(row.total_amount ?? 0) || 0,
        count: Number(row.evidence_count ?? 0) || 0,
      };
    },
  });
}
