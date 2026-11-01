import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseKfmProductionPreflight,
  type KfmProductionPreflight,
} from "@/lib/kfm-moq";

export const KFM_PRODUCTION_PREFLIGHT_KEY = "kfm-production-preflight";
export const PRODUCTION_ORDERS_KEY = "production-orders";

/** Preview the KFM daily-pack total before creating a production order. */
export function useKfmProductionPreflight(
  poId: string | null | undefined,
  startDate: string | null | undefined,
  items: unknown[] | null | undefined,
) {
  return useQuery<KfmProductionPreflight>({
    queryKey: [KFM_PRODUCTION_PREFLIGHT_KEY, poId, startDate, items],
    enabled: Boolean(poId && startDate && Array.isArray(items)),
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc(
        "kfm_production_preflight",
        {
          p_po_id: poId,
          p_start_date: startDate,
          p_items: items ?? [],
        },
      );
      if (error) throw error;
      return parseKfmProductionPreflight(data);
    },
    staleTime: 15000,
  });
}

export type CancelProductionOrderInput = {
  orderId: string;
  reason?: string | null;
};

/** Cancel a Q7 production order through the server-side safety gate. */
export function useCancelProductionOrder() {
  const queryClient = useQueryClient();

  return useMutation<Record<string, unknown> | null, Error, CancelProductionOrderInput>({
    mutationFn: async (input) => {
      const { data, error } = await (supabase as any).rpc(
        "cancel_production_order",
        {
          p_order_id: input.orderId,
          p_reason: input.reason ?? null,
        },
      );
      if (error) throw error;
      return (data ?? null) as Record<string, unknown> | null;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [PRODUCTION_ORDERS_KEY],
      });
    },
  });
}
