import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { parseFxMonthly } from "@/lib/finance/fx";
import type {
  FinanceAccrualSchedule,
  FinanceApRollforward,
  FinanceCloseChecklist,
  FinanceFxMonth,
  FinancePnl,
  FinanceManualAdjustment,
  FinanceManualAdjustmentKind,
  FinancePnlAccrual,
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

export function useFxMonthly(from: string | null | undefined, to: string | null | undefined) {
  return useQuery({
    queryKey: [FINANCE_QUERY_KEY, "fx-monthly", from, to],
    enabled: Boolean(from && to),
    queryFn: async (): Promise<FinanceFxMonth[]> => {
      if (!from || !to) throw new Error("finance_fx_monthly requires from and to");
      const { data, error } = await rpc("finance_fx_monthly", { p_from: from, p_to: to });
      if (error) throw error;
      return parseFxMonthly(data);
    },
  });
}

export function usePnlAccrual(month: string | null | undefined) {
  return useQuery({
    queryKey: [FINANCE_QUERY_KEY, "pnl-accrual", month],
    enabled: Boolean(month),
    queryFn: async (): Promise<FinancePnlAccrual> => {
      if (!month) throw new Error("finance_pnl_accrual requires a month");
      const { data, error } = await rpc("finance_pnl_accrual", { p_month: month });
      if (error) throw error;
      return data as FinancePnlAccrual;
    },
  });
}

type TableClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        order: (column: string, opts: { ascending: boolean }) => Promise<{ data: unknown; error: unknown }>;
      };
    };
  };
};

export function useManualAdjustments() {
  return useQuery({
    queryKey: [FINANCE_QUERY_KEY, "manual-adjustments"],
    queryFn: async (): Promise<FinanceManualAdjustment[]> => {
      const { data, error } = await (supabase as unknown as TableClient)
        .from("finance_manual_adjustments")
        .select("id,kind,category_code,label,period_from,period_to,total_amount,source_ref,note,status,created_by,created_at,updated_at")
        .eq("status", "active")
        .order("period_from", { ascending: false });
      if (error) throw error;
      return (data ?? []) as FinanceManualAdjustment[];
    },
  });
}

export type ManualAdjustmentInput = {
  kind: FinanceManualAdjustmentKind;
  categoryCode: string | null;
  label: string;
  periodFrom: string;
  periodTo: string;
  totalAmount: number;
  sourceRef: string | null;
  note: string | null;
};

export function useSaveManualAdjustment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: ManualAdjustmentInput) => {
      const { data, error } = await rpc("finance_manual_adjustment_save", {
        p_id: null,
        p_kind: input.kind,
        p_category_code: input.categoryCode,
        p_label: input.label,
        p_period_from: input.periodFrom,
        p_period_to: input.periodTo,
        p_total_amount: input.totalAmount,
        p_source_ref: input.sourceRef,
        p_note: input.note,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: [FINANCE_QUERY_KEY] }),
  });
}

export function useVoidManualAdjustment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await rpc("finance_manual_adjustment_void", { p_id: id });
      if (error) throw error;
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: [FINANCE_QUERY_KEY] }),
  });
}
