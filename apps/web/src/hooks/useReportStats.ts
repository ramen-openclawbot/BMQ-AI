import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { startOfMonth, endOfMonth, format } from "date-fns";
import { getRemainingPaymentAmount, type PaymentRequestWithSupplier } from "@/hooks/usePaymentRequests";

export interface MonthlyReceiptStats {
  totalQuantity: number;
  totalValue: number;
  totalReceipts: number;
  totalPOs: number;
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

type JoinedSupplier = { name?: string | null } | Array<{ name?: string | null }> | null;
type SupplierStatsRow = {
  id: string;
  name: string;
  purchase_orders?: Array<{ total_amount: number | null; status: string | null }> | null;
  goods_receipts?: Array<{ total_quantity: number | null; status: string | null }> | null;
  payment_requests?: Array<PaymentRequestWithSupplier> | null;
};

const getJoinedSupplierName = (supplier: JoinedSupplier) => {
  const row = Array.isArray(supplier) ? supplier[0] : supplier;
  return row?.name || "Không xác định";
};

export function useMonthlyReceiptStats(month: Date = new Date()) {
  const start = startOfMonth(month);
  const end = endOfMonth(month);

  return useQuery({
    queryKey: ["monthly-receipt-stats", format(month, "yyyy-MM")],
    queryFn: async () => {
      // 2 queries chạy song song thay vì tuần tự
      const [poRes, receiptsRes] = await Promise.all([
        supabase
          .from("purchase_orders")
          .select("id, total_amount, supplier_id, suppliers(id, name)")
          .gte("order_date", format(start, "yyyy-MM-dd"))
          .lte("order_date", format(end, "yyyy-MM-dd")),
        supabase
          .from("goods_receipts")
          .select("id, total_quantity")
          .gte("receipt_date", format(start, "yyyy-MM-dd"))
          .lte("receipt_date", format(end, "yyyy-MM-dd"))
          .eq("status", "received"),
      ]);

      if (poRes.error) throw poRes.error;
      if (receiptsRes.error) throw receiptsRes.error;

      const purchaseOrders = poRes.data;
      const receipts = receiptsRes.data;

      const supplierMap = new Map<string, { name: string; quantity: number; value: number }>();
      let totalValue = 0;

      purchaseOrders?.forEach((po) => {
        const value = po.total_amount || 0;
        totalValue += value;

        const supplierName = getJoinedSupplierName(po.suppliers as JoinedSupplier);
        const supplierId = po.supplier_id || "unknown";

        if (supplierMap.has(supplierId)) {
          const existing = supplierMap.get(supplierId)!;
          existing.value += value;
          existing.quantity += 1;
        } else {
          supplierMap.set(supplierId, { name: supplierName, quantity: 1, value });
        }
      });

      const totalQuantity = receipts?.reduce((sum, r) => sum + (r.total_quantity || 0), 0) || 0;

      return {
        totalQuantity,
        totalValue,
        totalReceipts: receipts?.length || 0,
        totalPOs: purchaseOrders?.length || 0,
        bySupplier: Array.from(supplierMap.values()).sort((a, b) => b.value - a.value),
      } as MonthlyReceiptStats;
    },
    staleTime: 2 * 60_000, // 2 phút
  });
}

export function useDebtStats() {
  return useQuery({
    queryKey: ["debt-stats"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_requests")
        .select("id, total_amount, payment_method, supplier_id, suppliers(id, name), payment_allocations(amount)")
        .in("payment_status", ["unpaid", "partial"]);

      if (error) throw error;

      const supplierDebtMap = new Map<string, { name: string; debt: number; count: number }>();
      let totalDebt = 0;
      let uncDebt = 0;
      let cashDebt = 0;

      data?.forEach((r) => {
        const amount = getRemainingPaymentAmount(r as PaymentRequestWithSupplier);
        totalDebt += amount;

        if (r.payment_method === "bank_transfer") {
          uncDebt += amount;
        } else if (r.payment_method === "cash") {
          cashDebt += amount;
        }

        const supplierName = getJoinedSupplierName(r.suppliers as JoinedSupplier);
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
    staleTime: 2 * 60_000, // 2 phút (trước: 30s)
  });
}

export function useSupplierStats() {
  return useQuery({
    queryKey: ["supplier-stats"],
    queryFn: async () => {
      // 1 query duy nhất với joins — thay vì 4 queries riêng biệt
      const { data: suppliers, error } = await supabase
        .from("suppliers")
        .select(`
          id, name,
          purchase_orders(total_amount, status),
          goods_receipts(total_quantity, status),
          payment_requests(total_amount, payment_status, payment_allocations(amount))
        `);

      if (error) throw error;

      const stats: SupplierStats[] = (suppliers || [])
        .map((s) => {
          const supplier = s as SupplierStatsRow;
          const orders = Array.isArray(supplier.purchase_orders) ? supplier.purchase_orders : [];
          const receipts = Array.isArray(supplier.goods_receipts)
            ? supplier.goods_receipts.filter((r) => r.status === "received")
            : [];
          const unpaid = Array.isArray(supplier.payment_requests)
            ? supplier.payment_requests.filter((r) => r.payment_status === "unpaid" || r.payment_status === "partial")
            : [];

          return {
            id: supplier.id,
            name: supplier.name,
            totalOrders: orders.length,
            totalValue: orders.reduce((sum, o) => sum + (o.total_amount || 0), 0),
            totalReceipts: receipts.length,
            totalQuantity: receipts.reduce((sum, r) => sum + (r.total_quantity || 0), 0),
            unpaidAmount: unpaid.reduce((sum, u) => sum + getRemainingPaymentAmount(u), 0),
          };
        })
        .filter((s) => s.totalOrders > 0 || s.totalReceipts > 0 || s.unpaidAmount > 0)
        .sort((a, b) => b.totalValue - a.totalValue);

      return stats;
    },
    staleTime: 2 * 60_000, // 2 phút (trước: 60s)
  });
}
