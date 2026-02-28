import { useQuery } from "@tanstack/react-query";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { supabase } from "@/integrations/supabase/client";

export function useDailyDeclaration(closingDate: Date) {
  const date = format(closingDate, "yyyy-MM-dd");

  return useQuery({
    queryKey: ["daily-declaration", date],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .select("*")
        .eq("closing_date", date)
        .maybeSingle();

      if (error) throw error;
      return data || null;
    },
  });
}

export function useUncDetailAmount(closingDate: Date) {
  const date = format(closingDate, "yyyy-MM-dd");

  return useQuery({
    queryKey: ["unc-detail-amount", date],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_requests")
        .select("id,total_amount")
        .eq("payment_method", "bank_transfer")
        .gte("created_at", `${date}T00:00:00`)
        .lte("created_at", `${date}T23:59:59.999`);

      if (error) throw error;
      return (data || []).reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
    },
  });
}

export function useDailyReconciliation(closingDate: Date) {
  const date = format(closingDate, "yyyy-MM-dd");

  return useQuery({
    queryKey: ["daily-reconciliation", date],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("daily_reconciliations")
        .select("*")
        .eq("closing_date", date)
        .maybeSingle();

      if (error) throw error;
      return data || null;
    },
  });
}

export function useMonthlyReconciliation(month: Date) {
  const start = format(startOfMonth(month), "yyyy-MM-dd");
  const end = format(endOfMonth(month), "yyyy-MM-dd");

  return useQuery({
    queryKey: ["monthly-reconciliation", format(month, "yyyy-MM")],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("daily_reconciliations")
        .select("*")
        .gte("closing_date", start)
        .lte("closing_date", end)
        .order("closing_date", { ascending: true });

      if (error) throw error;

      const rows = data || [];
      const totalUncDetail = rows.reduce((s: number, r: any) => s + Number(r.unc_detail_amount || 0), 0);
      const totalUncDeclared = rows.reduce((s: number, r: any) => s + Number(r.unc_declared_amount || 0), 0);
      const netVariance = rows.reduce((s: number, r: any) => s + Number(r.variance_amount || 0), 0);
      const matchDays = rows.filter((r: any) => r.status === "match").length;

      return {
        rows,
        totalUncDetail,
        totalUncDeclared,
        netVariance,
        matchDays,
        totalDays: rows.length,
      };
    },
  });
}
