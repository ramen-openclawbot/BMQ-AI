import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  type CreateRobotOrderPackageInput,
  type ItemPurchaseFact,
  type RobotOrderPackageResult,
  type SupplierDebtCandidates,
} from "@/lib/robot-order";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

// No UI here: the hooks only call the robot-order RPCs and the debt_review edge
// mode. The server owns every permission gate and every write.
//
// Query keys are the exact strings the existing hooks already use, so an
// invalidation here refreshes the lists the finance / warehouse screens read.
export const ITEM_PURCHASE_FACTS_QUERY_KEY = "item-purchase-facts";
export const SUPPLIER_DEBT_CANDIDATES_QUERY_KEY = "supplier-debt-candidates";
export const PURCHASE_ORDERS_QUERY_KEY = "purchase-orders";
export const PAYMENT_REQUESTS_QUERY_KEY = "payment-requests";
export const PAYMENT_SUBMISSIONS_QUERY_KEY = "payment-submissions";

// The generated database types do not know the new RPCs yet.
const db = supabase as unknown as {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
};

export interface DebtReviewResult {
  supplier_id: string;
  evaluated: number;
  marked: number;
  stopped: "quota" | null;
}

/** Last supplier / price / unit / date per kitchen item plus a suggested qty. */
export function useItemPurchaseFacts(itemIds: string[]) {
  const ids = Array.from(new Set((itemIds ?? []).filter(Boolean))).sort();

  return useQuery({
    queryKey: [ITEM_PURCHASE_FACTS_QUERY_KEY, ids],
    enabled: ids.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<ItemPurchaseFact[]> => {
      const { data, error } = await db.rpc("get_item_purchase_facts", { p_item_ids: ids });
      if (error) throw error;
      return Array.isArray(data) ? (data as ItemPurchaseFact[]) : [];
    },
  });
}

/** One supplier's unpaid payment requests plus POs without a live PR. */
export function useSupplierDebtCandidates(supplierId: string | null) {
  return useQuery({
    queryKey: [SUPPLIER_DEBT_CANDIDATES_QUERY_KEY, supplierId],
    enabled: Boolean(supplierId),
    staleTime: 60 * 1000,
    queryFn: async (): Promise<SupplierDebtCandidates | null> => {
      const { data, error } = await db.rpc("get_supplier_debt_candidates", {
        p_supplier_id: supplierId,
      });
      if (error) throw error;
      return (data ?? null) as SupplierDebtCandidates | null;
    },
  });
}

/**
 * Create the draft PO(s), submit the chosen old debt and write the learned
 * cutover in one RPC. Invalidates the lists a package can change.
 */
export function useCreateRobotOrderPackage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateRobotOrderPackageInput): Promise<RobotOrderPackageResult> => {
      const { data, error } = await db.rpc("create_robot_order_package", {
        p_lines: input.lines,
        p_debt: input.debt,
        p_note: input.note,
        p_idempotency_key: input.idempotency_key,
      });
      if (error) throw error;
      return data as RobotOrderPackageResult;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [PURCHASE_ORDERS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [PAYMENT_REQUESTS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [PAYMENT_SUBMISSIONS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [ITEM_PURCHASE_FACTS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [SUPPLIER_DEBT_CANDIDATES_QUERY_KEY] });
    },
  });
}

/** Ask Jev to rate the supplier's still-unmarked old documents. */
export function useRunDebtReview() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (supplierId: string): Promise<DebtReviewResult> => {
      const { data, error } = await supabase.functions.invoke("stock-alias-jev", {
        body: { mode: "debt_review", supplier_id: supplierId },
      });
      if (error) throw error;
      return data as DebtReviewResult;
    },
    onSuccess: (_result, supplierId) => {
      void queryClient.invalidateQueries({
        queryKey: [SUPPLIER_DEBT_CANDIDATES_QUERY_KEY, supplierId],
      });
    },
  });
}
