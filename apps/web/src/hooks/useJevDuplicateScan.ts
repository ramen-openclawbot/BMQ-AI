import { useMutation, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { FINANCE_RECONCILIATION_FLAGS_QUERY_KEY } from "@/hooks/useFinanceReconciliationFlags";

// No UI: this hook only calls the owner-only finance-jev-duplicate-scan edge
// function and the owner-only review_jev_duplicate_check RPC, then invalidates
// the reconciliation flag view. The server owns every threshold and read/write.

export type JevDuplicateScanMode = "dry_run" | "run";

export type JevReviewDecision = "same_purchase" | "different_purchase";

export interface JevDuplicateScanOptions {
  mode: JevDuplicateScanMode;
  limit?: number;
  days?: number;
}

export interface JevDuplicateScanItem {
  pair_key: string;
  pr_older: string;
  pr_newer: string;
  older_request: string;
  newer_request: string;
  status: "auto_clear" | "needs_review" | "auto_flag" | null;
  p_same: number | null;
  relation: string | null;
  relation_probability: number | null;
  relation_confidence: number | null;
  error: string | null;
}

export interface JevDuplicateScanResult {
  mode: JevDuplicateScanMode;
  candidates: number;
  checked: number;
  auto_clear: number;
  needs_review: number;
  auto_flag: number;
  failed: number;
  skipped_unchanged: number;
  items?: JevDuplicateScanItem[];
}

export interface RunJevDuplicateScanInput extends Partial<JevDuplicateScanOptions> {
  /** Selective rerun of already-checked pairs. */
  pair_keys?: string[];
}

/**
 * Runs the scan. `dry_run` never writes; `run` upserts the Jev result without
 * touching an existing CEO review. Both invalidate the flag view so a finished
 * run shows the new jev_possible_duplicate labels.
 */
export function useRunJevDuplicateScan(options: JevDuplicateScanOptions) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (overrides: RunJevDuplicateScanInput = {}): Promise<JevDuplicateScanResult> => {
      const body: Record<string, unknown> = {
        mode: overrides.mode ?? options.mode,
        limit: overrides.limit ?? options.limit ?? 50,
        days: overrides.days ?? options.days ?? 90,
      };
      if (overrides.pair_keys && overrides.pair_keys.length > 0) body.pair_keys = overrides.pair_keys;

      const { data, error } = await supabase.functions.invoke<JevDuplicateScanResult>(
        "finance-jev-duplicate-scan",
        { body },
      );
      if (error) throw error;
      return data as JevDuplicateScanResult;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [FINANCE_RECONCILIATION_FLAGS_QUERY_KEY] });
    },
  });
}

export interface ReviewJevDuplicateInput {
  pairKey: string;
  decision: JevReviewDecision;
  note?: string | null;
}

/** Records the CEO decision on one Jev duplicate pair. */
export function useReviewJevDuplicate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ReviewJevDuplicateInput) => {
      const { data, error } = await supabase.rpc("review_jev_duplicate_check", {
        p_pair_key: input.pairKey,
        p_decision: input.decision,
        p_note: input.note ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [FINANCE_RECONCILIATION_FLAGS_QUERY_KEY] });
    },
  });
}
