import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { format } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { batchDatesByLimit, mapCutoverError } from "@/lib/finance-cutover";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface CutoverPreviewDay {
  closing_date: string;
  unc_declared: number;
  unc_evidence_total: number;
  unc_file_count: number;
  qtm_topup: number;
  qtm_spent_total: number;
  qtm_file_count: number;
  low_confidence_count: number;
  evidence_scanned: boolean;
  blockers: unknown[];
}

export interface CutoverPreview {
  period_month: string;
  from_date: string;
  to_date: string;
  day_count: number;
  days: CutoverPreviewDay[];
  unc_declared_total: number;
  unc_evidence_total: number;
  unc_variance: number;
  qtm_opening_balance: number;
  qtm_topup_total: number;
  qtm_spent_total: number;
  qtm_closing_computed: number;
  days_missing_evidence: string[];
  prior_unclosed_before_month: boolean;
  prior_unclosed_before_month_date: string | null;
  preview_hash: string;
}

export interface PeriodCutover {
  id: string;
  period_month: string;
  from_date: string;
  to_date: string;
  day_count: number;
  unc_declared_total: number;
  unc_evidence_total: number;
  unc_variance: number;
  qtm_opening_balance: number;
  qtm_topup_total: number;
  qtm_spent_total: number;
  qtm_closing_computed: number;
  qtm_closing_counted: number | null;
  qtm_count_variance: number;
  days_missing_evidence: string[];
  preview_hash: string;
  note: string | null;
  status: "closed" | "reverted";
  created_by: string | null;
  created_at: string;
  reverted_by: string | null;
  reverted_at: string | null;
  revert_note: string | null;
}

export interface CutoverCloseSummary {
  ok: boolean;
  already_closed: boolean;
  cutover_id: string;
  period_month: string;
  from_date?: string;
  to_date?: string;
  day_count?: number;
  summary?: PeriodCutover;
}

export interface CollectEvidenceProgress {
  month: string;
  batchIndex: number;
  batchCount: number;
  dates: string[];
}

export interface CollectEvidenceResult {
  month: string;
  collected: string[];
  failed: string[];
  batchCount: number;
}

export interface CloseCutoverInput {
  month: Date | string;
  expectedHash: string;
  qtmCounted?: number | null;
  note?: string | null;
}

export interface RevertCutoverInput {
  cutoverId: string;
  note: string;
}

// ---------------------------------------------------------------------------
// Query keys / shared invalidation
// ---------------------------------------------------------------------------
export const CUTOVER_PREVIEW_KEY = "finance-cutover-preview";
export const CUTOVER_HISTORY_KEY = "finance-cutover-history";

/// Existing per-day/monthly reconciliation query key prefixes.
const FINANCE_RECONCILIATION_KEYS = [
  "finance-daily-snapshot",
  "daily-declaration",
  "daily-declaration-images",
  "unc-detail-amount",
  "daily-reconciliation",
  "monthly-reconciliation",
  "qtm-opening-balance",
];

function toMonthKey(month: Date | string): string {
  if (month instanceof Date) return format(month, "yyyy-MM-01");
  if (/^\d{4}-\d{2}$/.test(month)) return `${month}-01`;
  return month;
}

function invalidateCutoverQueries(queryClient: QueryClient) {
  for (const key of [CUTOVER_PREVIEW_KEY, CUTOVER_HISTORY_KEY, ...FINANCE_RECONCILIATION_KEYS]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export function useCutoverPreview(month: Date | string, enabled = true) {
  const key = toMonthKey(month);

  return useQuery({
    queryKey: [CUTOVER_PREVIEW_KEY, key],
    enabled,
    queryFn: async (): Promise<CutoverPreview> => {
      const { data, error } = await (supabase as any).rpc(
        "finance_cutover_preview",
        { p_month: key },
      );
      if (error) throw error;
      return data as CutoverPreview;
    },
    staleTime: 30_000,
  });
}

export function useCutoverHistory() {
  return useQuery({
    queryKey: [CUTOVER_HISTORY_KEY],
    queryFn: async (): Promise<PeriodCutover[]> => {
      const { data, error } = await (supabase as any)
        .from("finance_period_cutovers")
        .select("*")
        .order("period_month", { ascending: false });

      if (error) throw error;
      return (data || []) as PeriodCutover[];
    },
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Evidence collection (no closing)
// ---------------------------------------------------------------------------
export function useCollectCutoverEvidence() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      { month, onProgress, force = false }: {
        month: Date | string;
        /** Re-scan every declared day, overwriting evidence that was already stored. */
        force?: boolean;
        onProgress?: (progress: CollectEvidenceProgress) => void;
      },
    ): Promise<CollectEvidenceResult> => {
      const key = toMonthKey(month);

      const { data, error } = await (supabase as any).rpc(
        "finance_cutover_preview",
        { p_month: key },
      );
      if (error) throw error;

      const preview = data as CutoverPreview;
      const unscanned = (preview?.days || [])
        .filter((day) => force || !day.evidence_scanned)
        .map((day) => day.closing_date)
        .sort();
      const batches = batchDatesByLimit(unscanned, 10);
      const collected: string[] = [];
      const failed: string[] = [];

      for (let index = 0; index < batches.length; index += 1) {
        const dates = batches[index];
        onProgress?.({
          month: key,
          batchIndex: index,
          batchCount: batches.length,
          dates,
        });

        const { data: invoked, error: invokeError } = await supabase.functions
          .invoke("finance-auto-close-day", {
            body: { mode: "evidence_only", dates },
          });

        if (invokeError) {
          // Stop immediately and report the batch that failed; never retry.
          failed.push(...dates);
          break;
        }

        const results = Array.isArray((invoked as any)?.results)
          ? (invoked as any).results
          : [];
        const failedInBatch = dates.filter((date) => {
          const row = results.find((item: any) =>
            String(item?.closingDate) === date
          );
          return !row || row.status === "error";
        });
        const succeededInBatch = dates.filter((date) =>
          !failedInBatch.includes(date)
        );

        collected.push(...succeededInBatch);
        if (failedInBatch.length > 0) {
          // Stop on the first batch with hard failures and report them.
          failed.push(...failedInBatch);
          break;
        }
      }

      return { month: key, collected, failed, batchCount: batches.length };
    },
    onSuccess: () => invalidateCutoverQueries(queryClient),
  });
}

// ---------------------------------------------------------------------------
// Close / revert
// ---------------------------------------------------------------------------
export function useCloseCutoverMonth() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CloseCutoverInput): Promise<CutoverCloseSummary> => {
      const { data, error } = await (supabase as any).rpc(
        "finance_cutover_close_month",
        {
          p_month: toMonthKey(input.month),
          p_expected_hash: input.expectedHash,
          p_qtm_counted: input.qtmCounted ?? null,
          p_note: input.note ?? null,
        },
      );

      if (error) throw new Error(mapCutoverError(error));
      return data as CutoverCloseSummary;
    },
    onSuccess: () => invalidateCutoverQueries(queryClient),
  });
}

export function useRevertCutover() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RevertCutoverInput) => {
      const { data, error } = await (supabase as any).rpc(
        "finance_cutover_revert",
        {
          p_cutover_id: input.cutoverId,
          p_note: input.note,
        },
      );

      if (error) throw new Error(mapCutoverError(error));
      return data;
    },
    onSuccess: () => invalidateCutoverQueries(queryClient),
  });
}
