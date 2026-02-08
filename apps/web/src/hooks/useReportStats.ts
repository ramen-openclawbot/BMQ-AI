import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { startOfMonth, endOfMonth, format } from "date-fns";

export interface MonthlyReceiptStats {
  totalQuantity: number;
  totalReceipts: number;
  bySupplier: { name: string; quantity: number; value: number }[];
}

export interface DebtStats {
  totalDebt: number;
  uncDebt: number;
  cashDebt: number;
  bySupplier: { name: string; debt: number; count: number }[];
}

export interface SupplierStats {
  id: string;
  name: string;
  totalOrders: number;
  totalValue: number;
  totalReceipts: number;
  totalQuantity: number;
  unpaidAmount: number;
}

export function useMonthlyReceiptStats(month: Date = new Date()) {
  const start = startOfMonth(month);
  const end = endOfMonth(month);

  return useQuery({
    queryKey: ["monthly-receipt-stats", format(month, "yyyy-MM")],
    queryFn: async () => {
      // Get goods receipts for the month
      const { data: receipts, error: receiptsError } = await supabase
        .from("goods_receipts")
        .select("id, total_quantity, supplier_id, suppliers(id, name)")
        .gte("receipt_date", format(start, "yyyy-MM-dd"))
        .lte("receipt_date", format(end, "yyyy-MM-dd"))
        .eq("status", "received");

      if (receiptsError) throw receiptsError;

      // Aggregate by supplier
      const supplierMap = new Map<string, { name: string; quantity: number; value: number }>();
      let totalQuantity = 0;

      receipts?.forEach((r) => {
        const qty = r.total_quantity || 0;
        totalQuantity += qty;
        const supplierName = (r.suppliers as any)?.name || "Không xác định";
        const supplierId = r.supplier_id || "unknown";

        if (supplierMap.has(supplierId)) {
          const existing = supplierMap.get(supplierId)!;
          existing.quantity += qty;
        } else {
          supplierMap.set(supplierId, { name: supplierName, quantity: qty, value: 0 });
        }
      });

      return {
        totalQuantity,
        totalReceipts: receipts?.length || 0,
        bySupplier: Array.from(supplierMap.values()).sort((a, b) => b.quantity - a.quantity),
      } as MonthlyReceiptStats;
    },
    staleTime: 60000,
  });
}

export function useDebtStats() {
  return useQuery({
    queryKey: ["debt-stats"],
    queryFn: async () => {
      // Get all unpaid payment requests with supplier info
      const { data, error } = await supabase
        .from("payment_requests")
        .select("id, total_amount, payment_method, supplier_id, suppliers(id, name)")
        .eq("payment_status", "unpaid");

      if (error) throw error;

      const supplierDebtMap = new Map<string, { name: string; debt: number; count: number }>();
      let totalDebt = 0;
      let uncDebt = 0;
      let cashDebt = 0;

      data?.forEach((r) => {
        const amount = r.total_amount || 0;
        totalDebt += amount;

        if (r.payment_method === "bank_transfer") {
          uncDebt += amount;
        } else if (r.payment_method === "cash") {
          cashDebt += amount;
        }

        const supplierName = (r.suppliers as any)?.name || "Không xác định";
        const supplierId = r.supplier_id || "unknown";

        if (supplierDebtMap.has(supplierId)) {
          const existing = supplierDebtMap.get(supplierId)!;
          existing.debt += amount;
          existing.count += 1;
        } else {
          supplierDebtMap.set(supplierId, { name: supplierName, debt: amount, count: 1 });
        }
      });

      return {
        totalDebt,
        uncDebt,
        cashDebt,
        bySupplier: Array.from(supplierDebtMap.values()).sort((a, b) => b.debt - a.debt),
      } as DebtStats;
    },
    staleTime: 30000,
  });
}

export function useSupplierStats() {
  return useQuery({
    queryKey: ["supplier-stats"],
    queryFn: async () => {
      // Get all suppliers
      const { data: suppliers, error: suppliersError } = await supabase
        .from("suppliers")
        .select("id, name");

      if (suppliersError) throw suppliersError;

      // Get purchase orders
      const { data: orders, error: ordersError } = await supabase
        .from("purchase_orders")
        .select("supplier_id, total_amount, status");

      if (ordersError) throw ordersError;

      // Get goods receipts
      const { data: receipts, error: receiptsError } = await supabase
        .from("goods_receipts")
        .select("supplier_id, total_quantity, status")
        .eq("status", "received");

      if (receiptsError) throw receiptsError;

      // Get unpaid payment requests
      const { data: unpaid, error: unpaidError } = await supabase
        .from("payment_requests")
        .select("supplier_id, total_amount")
        .eq("payment_status", "unpaid");

      if (unpaidError) throw unpaidError;

      // Aggregate stats per supplier
      const statsMap = new Map<string, SupplierStats>();

      suppliers?.forEach((s) => {
        statsMap.set(s.id, {
          id: s.id,
          name: s.name,
          totalOrders: 0,
          totalValue: 0,
          totalReceipts: 0,
          totalQuantity: 0,
          unpaidAmount: 0,
        });
      });

      orders?.forEach((o) => {
        if (o.supplier_id && statsMap.has(o.supplier_id)) {
          const stats = statsMap.get(o.supplier_id)!;
          stats.totalOrders += 1;
          stats.totalValue += o.total_amount || 0;
        }
      });

      receipts?.forEach((r) => {
        if (r.supplier_id && statsMap.has(r.supplier_id)) {
          const stats = statsMap.get(r.supplier_id)!;
          stats.totalReceipts += 1;
          stats.totalQuantity += r.total_quantity || 0;
        }
      });

      unpaid?.forEach((u) => {
        if (u.supplier_id && statsMap.has(u.supplier_id)) {
          const stats = statsMap.get(u.supplier_id)!;
          stats.unpaidAmount += u.total_amount || 0;
        }
      });

      return Array.from(statsMap.values())
        .filter((s) => s.totalOrders > 0 || s.totalReceipts > 0 || s.unpaidAmount > 0)
        .sort((a, b) => b.totalValue - a.totalValue);
    },
    staleTime: 60000,
  });
}
