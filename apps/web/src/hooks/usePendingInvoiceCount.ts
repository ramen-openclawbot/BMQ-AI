import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export function usePendingInvoiceCount() {
  return useQuery({
    queryKey: ["pending-invoice-count"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("payment_requests")
        .select("*", { count: "exact", head: true })
        .eq("payment_status", "paid")
        .eq("invoice_created", false);

      if (error) throw error;
      return count || 0;
    },
    staleTime: 30000,
  });
}
