import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseMaterialLinkReview,
  type MaterialLinkLocation,
  type MaterialLinkReview,
} from "@/lib/material-link-quest";
import {
  parseQ7ExactLinkBatch,
  parseQ7MaterialLinkResult,
  type Q7ExactLinkBatch,
  type Q7MaterialLinkResult,
} from "@/lib/q7-material-links";
import { MISSIONS_QUERY_KEY } from "./useMissions";
import { Q7_MATERIAL_LINK_REVIEW_QUERY_KEY } from "./useQ7MaterialLinks";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

export const MATERIAL_LINK_REVIEW_QUERY_KEY = "material-link-review";

/** The new RPC names are not in the generated Database type yet. */
const rpcClient = supabase as any;

/** Linking changes both reviews, the warehouse game on_hand and the missions. */
function invalidateMaterialLinks(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [MATERIAL_LINK_REVIEW_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [Q7_MATERIAL_LINK_REVIEW_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MISSIONS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
}

/** Unlinked items of one warehouse with suggestions, SKUs and last-buy facts. */
export function useMaterialLinkReview(location: MaterialLinkLocation, enabled = true) {
  return useQuery({
    queryKey: [MATERIAL_LINK_REVIEW_QUERY_KEY, location],
    enabled,
    queryFn: async (): Promise<MaterialLinkReview> => {
      const { data, error } = await rpcClient.rpc("get_material_link_review", {
        p_location: location,
      });
      if (error) throw error;
      return parseMaterialLinkReview(data);
    },
  });
}

export interface LinkItemMaterialInput {
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

/** Link one item of either warehouse to a material (idempotent by request id). */
export function useLinkItemMaterial() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LinkItemMaterialInput): Promise<Q7MaterialLinkResult> => {
      const { data, error } = await rpcClient.rpc("link_item_material", {
        p_item_id: input.itemId,
        p_material_id: input.materialId ?? null,
        p_create_new: input.createNew ?? false,
        p_request_id: input.requestId ?? crypto.randomUUID(),
        p_unit_factor: input.unitFactor ?? null,
      });
      if (error) throw error;
      return parseQ7MaterialLinkResult(data);
    },
    onSuccess: () => invalidateMaterialLinks(queryClient),
  });
}

export interface LinkExactMaterialsInput {
  location: MaterialLinkLocation;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Link every eligible item of a warehouse with exactly one exact material. */
export function useLinkExactMaterials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LinkExactMaterialsInput): Promise<Q7ExactLinkBatch> => {
      const { data, error } = await rpcClient.rpc("link_exact_materials", {
        p_location: input.location,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return parseQ7ExactLinkBatch(data);
    },
    onSuccess: () => invalidateMaterialLinks(queryClient),
  });
}

export interface MaterialLinkSkipResult {
  item_id: string;
  skipped: boolean;
}

export interface SkipItemLinkInput {
  itemId: string;
  note?: string | null;
}

/** Mark one unlinked item as "not a material" so it leaves the review. */
export function useSkipItemLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SkipItemLinkInput): Promise<MaterialLinkSkipResult> => {
      const { data, error } = await rpcClient.rpc("skip_item_material_link", {
        p_item_id: input.itemId,
        p_reason: "not_material",
        p_note: input.note ?? null,
      });
      if (error) throw error;
      return data as MaterialLinkSkipResult;
    },
    onSuccess: () => invalidateMaterialLinks(queryClient),
  });
}

export interface UnskipItemLinkInput {
  itemId: string;
}

/** Bring a skipped item back into the review. */
export function useUnskipItemLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UnskipItemLinkInput): Promise<MaterialLinkSkipResult> => {
      const { data, error } = await rpcClient.rpc("unskip_item_material_link", {
        p_item_id: input.itemId,
      });
      if (error) throw error;
      return data as MaterialLinkSkipResult;
    },
    onSuccess: () => invalidateMaterialLinks(queryClient),
  });
}
