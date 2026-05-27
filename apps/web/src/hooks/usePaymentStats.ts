import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getRemainingPaymentAmount, type PaymentRequestWithSupplier } from "@/hooks/usePaymentRequests";

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
          .in("payment_status", ["unpaid", "partial"]),

        // Count delivered
        supabase
          .from("payment_requests")
          .select("*", { count: "exact", head: true })
          .eq("delivery_status", "delivered"),

        // Sum UNC outstanding (bank_transfer)
        supabase
          .from("payment_requests")
          .select("total_amount, payment_allocations(amount)")
          .in("payment_status", ["unpaid", "partial"])
          .eq("payment_method", "bank_transfer"),

        // Sum cash outstanding
        supabase
          .from("payment_requests")
          .select("total_amount, payment_allocations(amount)")
          .in("payment_status", ["unpaid", "partial"])
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
        (sum, r) => sum + getRemainingPaymentAmount(r as PaymentRequestWithSupplier),
        0,
      );
      const cashTotal = (cashRes.data || []).reduce(
        (sum, r) => sum + getRemainingPaymentAmount(r as PaymentRequestWithSupplier),
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
