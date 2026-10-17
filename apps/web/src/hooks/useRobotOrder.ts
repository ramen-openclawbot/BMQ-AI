import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  type CreateRobotOrderPackageInput,
  type RobotOrderPackageResult,
  type SupplierDebtCandidates,
  type SupplierDebtPickPattern,
} from "@/lib/robot-order";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

// No UI here: the hooks only call the robot-order RPCs and the debt_review edge
// mode. The server owns every permission gate and every write.
//
// Query keys are the exact strings the existing hooks already use, so an
// invalidation here refreshes the lists the finance / warehouse screens read.
export const SUPPLIER_DEBT_CANDIDATES_QUERY_KEY = "supplier-debt-candidates";
export const SUPPLIER_DEBT_PICK_PATTERN_QUERY_KEY = "supplier-debt-pick-pattern";
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
        p_debt: input.debt && input.debt.length > 0 ? input.debt : null,
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
      void queryClient.invalidateQueries({ queryKey: [SUPPLIER_DEBT_CANDIDATES_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [SUPPLIER_DEBT_PICK_PATTERN_QUERY_KEY] });
    },
  });
}

/** One supplier's learned debt-pick pattern, for phase-2 suggestions. */
export function useSupplierDebtPickPattern(supplierId: string | null) {
  return useQuery({
    queryKey: [SUPPLIER_DEBT_PICK_PATTERN_QUERY_KEY, supplierId],
    enabled: Boolean(supplierId),
    staleTime: 60 * 1000,
    queryFn: async (): Promise<SupplierDebtPickPattern | null> => {
      const { data, error } = await db.rpc("get_supplier_debt_pick_pattern", {
        p_supplier_id: supplierId,
      });
      if (error) throw error;
      return (data ?? null) as SupplierDebtPickPattern | null;
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
