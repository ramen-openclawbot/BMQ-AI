import { useMutation, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

/** Query key used by the Mini CRM customers list in src/pages/MiniCrm.tsx. */
export const MINI_CRM_CUSTOMERS_QUERY_KEY = "mini-crm-customers";

export interface SetDealerOrderLockInput {
  customerId: string;
  locked: boolean;
  reason?: string | null;
}

export interface SetDealerOrderLockResult {
  customer_id: string;
  order_locked: boolean;
  revoked_sessions: number;
}

/**
 * Owner / crm edit mutation for the manual per-dealer order lock. The server
 * RPC validates the permission, revokes active dealer sessions when locking and
 * appends the audit row; the hook only refreshes the customers list afterwards.
 */
export function useSetDealerOrderLock() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      customerId,
      locked,
      reason,
    }: SetDealerOrderLockInput): Promise<SetDealerOrderLockResult> => {
      const { data, error } = await supabase.rpc("set_dealer_order_lock", {
        p_customer_id: customerId,
        p_locked: locked,
        p_reason: reason ?? null,
      });
      if (error) throw error;
      return data as unknown as SetDealerOrderLockResult;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [MINI_CRM_CUSTOMERS_QUERY_KEY] });
    },
  });
}
