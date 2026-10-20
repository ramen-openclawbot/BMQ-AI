import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type {
  FinanceAccrualSchedule,
  FinanceApRollforward,
  FinanceCloseChecklist,
  FinancePnl,
  FinanceVariance,
} from "@/lib/finance/types";

type FinanceRpc = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

const rpc = (supabase as unknown as { rpc: FinanceRpc }).rpc.bind(supabase);

export const FINANCE_QUERY_KEY = "finance";

export function usePnl(from: string | null | undefined, to: string | null | undefined) {
  return useQuery({
    queryKey: [FINANCE_QUERY_KEY, "pnl", from, to],
    enabled: Boolean(from && to),
    queryFn: async (): Promise<FinancePnl> => {
      if (!from || !to) throw new Error("finance_pnl requires from and to");
      const { data, error } = await rpc("finance_pnl", { p_from: from, p_to: to });
      if (error) throw error;
      return data as FinancePnl;
    },
  });
}

export function useVariance(month: string | null | undefined) {
  return useQuery({
    queryKey: [FINANCE_QUERY_KEY, "variance", month],
    enabled: Boolean(month),
    queryFn: async (): Promise<FinanceVariance> => {
      if (!month) throw new Error("finance_variance requires a month");
      const { data, error } = await rpc("finance_variance", { p_month: month });
      if (error) throw error;
      return data as FinanceVariance;
    },
  });
}

export function useApRollforward(month: string | null | undefined) {
  return useQuery({
    queryKey: [FINANCE_QUERY_KEY, "ap-rollforward", month],
    enabled: Boolean(month),
    queryFn: async (): Promise<FinanceApRollforward> => {
      if (!month) throw new Error("finance_ap_rollforward requires a month");
      const { data, error } = await rpc("finance_ap_rollforward", { p_month: month });
      if (error) throw error;
      return data as FinanceApRollforward;
    },
  });
}

export function useAccrualSchedule(month: string | null | undefined) {
  return useQuery({
    queryKey: [FINANCE_QUERY_KEY, "accrual-schedule", month],
    enabled: Boolean(month),
    queryFn: async (): Promise<FinanceAccrualSchedule> => {
      if (!month) throw new Error("finance_accrual_schedule requires a month");
      const { data, error } = await rpc("finance_accrual_schedule", { p_month: month });
      if (error) throw error;
      return data as FinanceAccrualSchedule;
    },
  });
}

export function useCloseChecklist(month: string | null | undefined) {
  return useQuery({
    queryKey: [FINANCE_QUERY_KEY, "close-checklist", month],
    enabled: Boolean(month),
    queryFn: async (): Promise<FinanceCloseChecklist> => {
      if (!month) throw new Error("finance_close_checklist requires a month");
      const { data, error } = await rpc("finance_close_checklist", { p_month: month });
      if (error) throw error;
      return data as FinanceCloseChecklist;
    },
  });
}
