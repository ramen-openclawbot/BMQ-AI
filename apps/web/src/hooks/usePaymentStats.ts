import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface PaymentStats {
  pendingCount: number;
  approvedCount: number;
  uncTotal: number;
  cashTotal: number;
  totalUnpaid: number;
  pendingInvoiceCount: number;
  deliveredCount: number;
}

export function usePaymentStats() {
  return useQuery({
    queryKey: ["payment-stats"],
    queryFn: async () => {
      // Server-side filtering — chỉ lấy count/sum cần thiết, không download toàn bộ bảng
      const [
        pendingRes,
        approvedUnpaidRes,
        deliveredRes,
        uncRes,
        cashRes,
        pendingInvoiceRes,
      ] = await Promise.all([
        // Count pending
        supabase
          .from("payment_requests")
          .select("*", { count: "exact", head: true })
          .eq("status", "pending"),

        // Count approved + unpaid
        supabase
          .from("payment_requests")
          .select("*", { count: "exact", head: true })
          .eq("status", "approved")
          .eq("payment_status", "unpaid"),

        // Count delivered
        supabase
          .from("payment_requests")
          .select("*", { count: "exact", head: true })
          .eq("delivery_status", "delivered"),

        // Sum UNC unpaid (bank_transfer) — chỉ lấy total_amount
        supabase
          .from("payment_requests")
          .select("total_amount")
          .eq("payment_status", "unpaid")
          .eq("payment_method", "bank_transfer"),

        // Sum cash unpaid — chỉ lấy total_amount
        supabase
          .from("payment_requests")
          .select("total_amount")
          .eq("payment_status", "unpaid")
          .eq("payment_method", "cash"),

        // Count approved but no invoice
        supabase
          .from("payment_requests")
          .select("*", { count: "exact", head: true })
          .eq("status", "approved")
          .eq("invoice_created", false),
      ]);

      const pendingCount = pendingRes.count || 0;
      const approvedCount = approvedUnpaidRes.count || 0;
      const deliveredCount = deliveredRes.count || 0;
      const pendingInvoiceCount = pendingInvoiceRes.count || 0;

      const uncTotal = (uncRes.data || []).reduce(
        (sum, r) => sum + (r.total_amount || 0),
        0,
      );
      const cashTotal = (cashRes.data || []).reduce(
        (sum, r) => sum + (r.total_amount || 0),
        0,
      );

      return {
        pendingCount,
        approvedCount,
        uncTotal,
        cashTotal,
        totalUnpaid: uncTotal + cashTotal,
        pendingInvoiceCount,
        deliveredCount,
      } as PaymentStats;
    },
    // Kế thừa global staleTime (2 phút), không override refetchOnWindowFocus
  });
}
