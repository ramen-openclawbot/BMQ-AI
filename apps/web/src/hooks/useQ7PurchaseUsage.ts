import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseQ7PurchaseUsageItemDetail,
  parseQ7PurchaseUsageReport,
  type Q7PurchaseUsageItemDetail,
  type Q7PurchaseUsageReport,
} from "@/lib/q7-purchase-usage";

export const Q7_PURCHASE_USAGE_REPORT_QUERY_KEY = "q7-purchase-usage-report";
export const Q7_PURCHASE_USAGE_ITEM_DETAIL_QUERY_KEY =
  "q7-purchase-usage-item-detail";

/** Purchase-vs-usage report for a date range (server defaults: last 3 months). */
export function useQ7PurchaseUsageReport(
  from?: string | null,
  to?: string | null,
) {
  return useQuery({
    queryKey: [Q7_PURCHASE_USAGE_REPORT_QUERY_KEY, from ?? null, to ?? null],
    queryFn: async (): Promise<Q7PurchaseUsageReport> => {
      const { data, error } = await supabase.rpc(
        "get_q7_purchase_usage_report",
        {
          p_from: from ?? null,
          p_to: to ?? null,
        },
      );
      if (error) throw error;
      return parseQ7PurchaseUsageReport(data);
    },
    staleTime: 60_000,
  });
}

/** Every purchase line and the top finished products for one kitchen item. */
export function useQ7PurchaseUsageItemDetail(
  itemId: string | null,
  from?: string | null,
  to?: string | null,
) {
  return useQuery({
    queryKey: [
      Q7_PURCHASE_USAGE_ITEM_DETAIL_QUERY_KEY,
      itemId,
      from ?? null,
      to ?? null,
    ],
    enabled: Boolean(itemId),
    queryFn: async (): Promise<Q7PurchaseUsageItemDetail> => {
      const { data, error } = await supabase.rpc(
        "get_q7_purchase_usage_item_detail",
        {
          p_item_id: itemId as string,
          p_from: from ?? null,
          p_to: to ?? null,
        },
      );
      if (error) throw error;
      return parseQ7PurchaseUsageItemDetail(data);
    },
    staleTime: 60_000,
  });
}
