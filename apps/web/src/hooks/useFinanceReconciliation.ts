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
      const [byCreatedAtRes, byInvoiceDateRes] = await Promise.all([
        supabase
          .from("payment_requests")
          .select("id,total_amount")
          .eq("payment_method", "bank_transfer")
          .gte("created_at", `${date}T00:00:00`)
          .lte("created_at", `${date}T23:59:59.999`),
        (supabase as any)
          .from("payment_requests")
          .select("id,total_amount,invoices!payment_requests_invoice_id_fkey(invoice_date)")
          .eq("payment_method", "bank_transfer")
          .eq("invoices.invoice_date", date),
      ]);

      if (byCreatedAtRes.error) throw byCreatedAtRes.error;
      if (byInvoiceDateRes.error) throw byInvoiceDateRes.error;

      const merged = new Map<string, number>();
      for (const row of (byCreatedAtRes.data || []) as any[]) {
        merged.set(row.id, Number(row.total_amount || 0));
      }
      for (const row of (byInvoiceDateRes.data || []) as any[]) {
        if (!merged.has(row.id)) merged.set(row.id, Number(row.total_amount || 0));
      }

      return Array.from(merged.values()).reduce((sum, amount) => sum + amount, 0);
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
