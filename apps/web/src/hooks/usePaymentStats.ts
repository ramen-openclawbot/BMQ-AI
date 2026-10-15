import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getRemainingPaymentAmount, type PaymentRequestWithSupplier } from "@/hooks/usePaymentRequests";
import { getVietnamDayUtcRange } from "@/lib/vietnam-time";

export interface PaymentStats {
  /** Pending phiếu created today (Vietnam day). */
  pendingCount: number;
  /** Every pending phiếu, any date (red badge). */
  pendingTotalCount: number;
  /** Unpaid/partial, not rejected, created in the last 90 days (same as the Chưa thanh toán list). */
  unpaidRecentCount: number;
  approvedCount: number;
  uncTotal: number;
  cashTotal: number;
  totalUnpaid: number;
  pendingInvoiceCount: number;
  deliveredCount: number;
}

export function usePaymentStats() {
  const today = getVietnamDayUtcRange();

  return useQuery({
    queryKey: ["payment-stats", today.dateKey],
    queryFn: async () => {
      const { startIso, endIso } = getVietnamDayUtcRange();
      // Server-side filtering — chỉ lấy count/sum cần thiết, không download toàn bộ bảng
      const [
        pendingRes,
        approvedUnpaidRes,
        deliveredRes,
        uncRes,
        cashRes,
        pendingInvoiceRes,
        pendingTotalRes,
        unpaidRecentRes,
      ] = await Promise.all([
        // Count pending trong ngày hiện tại theo giờ Việt Nam (badge Duyệt chi)
        supabase
          .from("payment_requests")
          .select("*", { count: "exact", head: true })
          .eq("status", "pending")
          .gte("created_at", startIso)
          .lt("created_at", endIso),

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

        // Every pending phiếu (red badge on Duyệt chi)
        supabase
          .from("payment_requests")
          .select("*", { count: "exact", head: true })
          .eq("status", "pending"),

        // Unpaid in the last 90 days, matching the Chưa thanh toán list
        supabase
          .from("payment_requests")
          .select("*", { count: "exact", head: true })
          .in("payment_status", ["unpaid", "partial"])
          .neq("status", "rejected")
          .gte("created_at", new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()),
      ]);

      const pendingCount = pendingRes.count || 0;
      const pendingTotalCount = pendingTotalRes.count || 0;
      const unpaidRecentCount = unpaidRecentRes.count || 0;
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
        pendingTotalCount,
        unpaidRecentCount,
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
