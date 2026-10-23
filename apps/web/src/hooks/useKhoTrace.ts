import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { KhoTraceCandidate, KhoTraceReport } from "@/lib/kho-trace";

export const KHO_TRACE_QUERY_KEY = "kho-trace";

/**
 * Production order items that can be traced in a date range, newest first.
 * The generated Database type predates these RPCs, so the call is typed at the
 * boundary with `as any`.
 */
export function useTraceCandidates(
  from: string | null | undefined,
  to: string | null | undefined,
) {
  const fromDate = String(from ?? "").trim() || null;
  const toDate = String(to ?? "").trim() || null;

  return useQuery({
    queryKey: [KHO_TRACE_QUERY_KEY, "candidates", fromDate, toDate],
    queryFn: async (): Promise<KhoTraceCandidate[]> => {
      const { data, error } = await (supabase as any).rpc("kho_trace_candidates", {
        p_from: fromDate,
        p_to: toDate,
      });
      if (error) throw error;
      return (data ?? []) as KhoTraceCandidate[];
    },
  });
}

/** Full KFM trace report for one production order item. */
export function useTraceReport(itemId: string | null | undefined) {
  const id = String(itemId ?? "").trim();

  return useQuery({
    queryKey: [KHO_TRACE_QUERY_KEY, "report", id],
    enabled: id !== "",
    queryFn: async (): Promise<KhoTraceReport | null> => {
      const { data, error } = await (supabase as any).rpc("kho_trace_report", {
        p_production_order_item_id: id,
      });
      if (error) throw error;
      return (data ?? null) as KhoTraceReport | null;
    },
  });
}
