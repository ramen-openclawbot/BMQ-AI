import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  isStaleLinkError,
  parseQ7ExactLinkBatch,
  parseQ7MaterialLinkResult,
  parseQ7MaterialLinkReview,
  type Q7ExactLinkBatch,
  type Q7MaterialLinkResult,
  type Q7MaterialLinkReview,
} from "@/lib/q7-material-links";
import { STOCK_COUNT_QUERY_KEY } from "./useStockCount";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

export const Q7_MATERIAL_LINK_REVIEW_QUERY_KEY = "q7-material-link-review";

/** Linking changes the review, the warehouse game on_hand and the stock count. */
function invalidateQ7MaterialLinks(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [Q7_MATERIAL_LINK_REVIEW_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [STOCK_COUNT_QUERY_KEY] });
}

/** Unlinked Q7 items with exact-match suggestions and fuzzy candidates. */
export function useQ7MaterialLinkReview(enabled = true) {
  return useQuery({
    queryKey: [Q7_MATERIAL_LINK_REVIEW_QUERY_KEY],
    enabled,
    queryFn: async (): Promise<Q7MaterialLinkReview> => {
      const { data, error } = await (supabase as any).rpc("get_q7_material_link_review");
      if (error) throw error;
      return parseQ7MaterialLinkReview(data);
    },
  });
}

export interface LinkQ7ItemMaterialInput {
  itemId: string;
  /** Existing canonical material to link; mutually exclusive with createNew. */
  materialId?: string | null;
  /** Create a new canonical material from the item name/unit. */
  createNew?: boolean;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
  /**
   * How many material default units one item unit equals (e.g. 25000 g per bao)
   * for a non-standard unit pair; defaults to null.
   */
  unitFactor?: number | null;
}

/** Link one Q7 item to an exact match, an owner-chosen material, or a new one. */
export function useLinkQ7ItemMaterial() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LinkQ7ItemMaterialInput): Promise<Q7MaterialLinkResult> => {
      const { data, error } = await (supabase as any).rpc("link_q7_item_material", {
        p_item_id: input.itemId,
        p_material_id: input.materialId ?? null,
        p_create_new: input.createNew ?? false,
        p_request_id: input.requestId ?? crypto.randomUUID(),
        p_unit_factor: input.unitFactor ?? null,
      });
      if (error) throw error;
      return parseQ7MaterialLinkResult(data);
    },
    onSuccess: () => invalidateQ7MaterialLinks(queryClient),
    onError: (error) => { if (isStaleLinkError(error)) invalidateQ7MaterialLinks(queryClient); },
  });
}

export interface LinkQ7ExactMaterialsInput {
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Link every eligible Q7 item with exactly one exact material. */
export function useLinkQ7ExactMaterials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LinkQ7ExactMaterialsInput = {}): Promise<Q7ExactLinkBatch> => {
      const { data, error } = await (supabase as any).rpc("link_q7_exact_materials", {
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return parseQ7ExactLinkBatch(data);
    },
    onSuccess: () => invalidateQ7MaterialLinks(queryClient),
  });
}
