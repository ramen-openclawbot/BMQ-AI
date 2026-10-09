import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type {
  FinanceReconciliationFlag,
  FinanceReconciliationReviewStatus,
} from "@/lib/finance-reconciliation-flags";

// No UI: this hook only exposes the reconciliation flag view and the two
// server-authority RPCs (CEO review state + PO overpay allowance).

export const FINANCE_RECONCILIATION_FLAGS_QUERY_KEY = "finance-reconciliation-flags";

export interface UseFinanceReconciliationFlagsOptions {
  /** Optional entity_id allow-list (purchase order or payment request ids). */
  entityIds?: string[];
  /** When true, only flags the CEO has not reviewed yet. */
  onlyOpen?: boolean;
  /** Optional priority allow-list, e.g. ["critical", "high"]. */
  priorities?: string[];
  /** Skip the query (e.g. while ids are still loading). */
  enabled?: boolean;
}

export function useFinanceReconciliationFlags(
  options: UseFinanceReconciliationFlagsOptions = {},
) {
  const { entityIds, onlyOpen, priorities, enabled = true } = options;

  return useQuery({
    queryKey: [
      FINANCE_RECONCILIATION_FLAGS_QUERY_KEY,
      entityIds && entityIds.length > 0 ? [...entityIds].sort() : null,
      onlyOpen ?? false,
      priorities && priorities.length > 0 ? [...priorities].sort() : null,
    ],
    enabled,
    queryFn: async (): Promise<FinanceReconciliationFlag[]> => {
      let query = supabase.from("finance_reconciliation_flags").select("*");

      if (entityIds && entityIds.length > 0) {
        query = query.in("entity_id", entityIds);
      }
      if (onlyOpen) {
        query = query.is("review_status", null);
      }
      if (priorities && priorities.length > 0) {
        query = query.in("priority", priorities);
      }
      query = query.limit(2000);

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as unknown as FinanceReconciliationFlag[];
    },
  });
}

export interface ReviewFinanceFlagInput {
  flagKey: string;
  status: FinanceReconciliationReviewStatus;
  note?: string | null;
}

export function useReviewFinanceFlag() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ReviewFinanceFlagInput) => {
      const { data, error } = await (supabase as any).rpc(
        "review_finance_reconciliation_flag",
        {
          p_flag_key: input.flagKey,
          p_status: input.status,
          p_note: input.note ?? null,
        },
      );
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [FINANCE_RECONCILIATION_FLAGS_QUERY_KEY] });
    },
  });
}

export interface AllowPurchaseOrderOverpayInput {
  purchaseOrderId: string;
  extraAmount: number;
  reason: string;
}

export function useAllowPurchaseOrderOverpay() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: AllowPurchaseOrderOverpayInput) => {
      const { data, error } = await (supabase as any).rpc(
        "allow_purchase_order_overpay",
        {
          p_purchase_order_id: input.purchaseOrderId,
          p_extra_amount: input.extraAmount,
          p_reason: input.reason,
        },
      );
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [FINANCE_RECONCILIATION_FLAGS_QUERY_KEY] });
    },
  });
}
