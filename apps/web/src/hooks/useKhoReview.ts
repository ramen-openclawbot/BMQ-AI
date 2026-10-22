import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { KhoReviewLinkResult, KhoReviewList } from "@/lib/kho-review";
import { KHO_ITEMS_QUERY_KEY } from "./useKhoItems";

export const KHO_REVIEW_QUERY_KEY = "kho-review";

/**
 * The generated Database type predates this migration; keep the calls typed
 * here instead of widening every RPC in the client (same wrapper as
 * useWarehouseGame.ts for set_item_kho_locations).
 */
const rpc = supabase as unknown as {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
};

function invalidateKhoReview(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [KHO_REVIEW_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [KHO_ITEMS_QUERY_KEY] });
}

/** The whole review list in one RPC: item gaps and material gaps with candidates. */
export function useKhoReviewList() {
  return useQuery({
    queryKey: [KHO_REVIEW_QUERY_KEY],
    queryFn: async (): Promise<KhoReviewList> => {
      const { data, error } = await rpc.rpc("kho_review_list");
      if (error) throw error;
      return data as KhoReviewList;
    },
  });
}

export interface KhoReviewLinkInput {
  receiptItemId: string;
  itemId: string;
  factor: number;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Link one receipt line to an existing item; idempotent by requestId. */
export function useKhoReviewLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: KhoReviewLinkInput): Promise<KhoReviewLinkResult> => {
      const { data, error } = await rpc.rpc("kho_review_link_line", {
        p_receipt_item_id: input.receiptItemId,
        p_item_id: input.itemId,
        p_factor: input.factor,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return data as KhoReviewLinkResult;
    },
    onSuccess: () => invalidateKhoReview(queryClient),
  });
}

export interface KhoReviewCreateItemInput {
  receiptItemId: string;
  name: string;
  unit: string;
  itemClass: "raw_material" | "packaging_supply";
  factor: number;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Create the item from a receipt line and link that line in one call. */
export function useKhoReviewCreateItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: KhoReviewCreateItemInput,
    ): Promise<KhoReviewLinkResult> => {
      const { data, error } = await rpc.rpc("kho_review_create_item_from_line", {
        p_receipt_item_id: input.receiptItemId,
        p_name: input.name,
        p_unit: input.unit,
        p_class: input.itemClass,
        p_factor: input.factor,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return data as KhoReviewLinkResult;
    },
    onSuccess: () => invalidateKhoReview(queryClient),
  });
}
