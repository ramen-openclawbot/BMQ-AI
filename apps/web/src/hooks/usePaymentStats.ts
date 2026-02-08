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
      const { data, error } = await supabase
        .from("payment_requests")
        .select("status, payment_status, payment_method, total_amount, invoice_created, delivery_status");

      if (error) throw error;

      const pendingCount = data?.filter((r) => r.status === "pending").length || 0;
      const approvedCount = data?.filter((r) => 
        r.status === "approved" && r.payment_status === "unpaid"
      ).length || 0;
      const deliveredCount = data?.filter((r) => r.delivery_status === "delivered").length || 0;

      // Calculate totals for all unpaid requests (pending + approved)
      const uncTotal =
        data
          ?.filter(
            (r) =>
              r.payment_status === "unpaid" &&
              r.payment_method === "bank_transfer"
          )
          .reduce((sum, r) => sum + (r.total_amount || 0), 0) || 0;

      const cashTotal =
        data
          ?.filter(
            (r) =>
              r.payment_status === "unpaid" &&
              r.payment_method === "cash"
          )
          .reduce((sum, r) => sum + (r.total_amount || 0), 0) || 0;

      const totalUnpaid = uncTotal + cashTotal;

      const pendingInvoiceCount =
        data?.filter((r) => r.status === "approved" && !r.invoice_created).length || 0;

      return {
        pendingCount,
        approvedCount,
        uncTotal,
        cashTotal,
        totalUnpaid,
        pendingInvoiceCount,
        deliveredCount,
      } as PaymentStats;
    },
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}
