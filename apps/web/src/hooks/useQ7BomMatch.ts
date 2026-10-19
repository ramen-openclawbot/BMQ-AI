import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { MISSIONS_QUERY_KEY } from "./useMissions";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";
import {
  parseQ7BomCatchUpResult,
  parseQ7BomMismatchReview,
  parseQ7BomResolveResult,
  type Q7BomAction,
  type Q7BomCatchUpResult,
  type Q7BomMismatchLine,
  type Q7BomResolveResult,
} from "@/lib/q7-bom-match";

export const Q7_BOM_MISMATCH_REVIEW_QUERY_KEY = "q7-bom-mismatch-review";

/** One request id per click so resolve_q7_bom_line can replay safely. */
function newRequestId(): string {
  return crypto.randomUUID();
}

/** A decision moves the review board, missions and the warehouse snapshot. */
function invalidateQ7BomMatch(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [Q7_BOM_MISMATCH_REVIEW_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MISSIONS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
  // useQ7MaterialInventory keeps its snapshot under this key.
  void queryClient.invalidateQueries({ queryKey: ["q7_inventory_snapshot"] });
}

/** Open Q7 BOM lines with their ranked counted-item candidates. */
export function useQ7BomMismatchReview(enabled = true) {
  return useQuery({
    queryKey: [Q7_BOM_MISMATCH_REVIEW_QUERY_KEY],
    enabled,
    queryFn: async (): Promise<Q7BomMismatchLine[]> => {
      const { data, error } = await (supabase as any).rpc("get_q7_bom_mismatch_review");
      if (error) throw error;
      return parseQ7BomMismatchReview(data);
    },
  });
}

export interface Q7BomProductLine {
  canonicalMaterialId: string;
  product: string;
  skuCode: string | null;
  issueId: string;
  issueNumber: string;
  issueDate: string;
  qty: number;
  unit: string;
}

/** Which finished products (and which PXK slips) a BOM line is deducted for (owner 19/10). */
export function useQ7BomLineProducts(canonicalMaterialIds: string[]) {
  const ids = [...canonicalMaterialIds].sort();
  return useQuery({
    queryKey: [Q7_BOM_MISMATCH_REVIEW_QUERY_KEY, "products", ids],
    enabled: ids.length > 0,
    queryFn: async (): Promise<Q7BomProductLine[]> => {
      const { data, error } = await (supabase as any).rpc("get_q7_bom_line_products", { p_canonical_material_ids: ids });
      if (error) throw error;
      return (Array.isArray(data) ? data : []).flatMap((row: Record<string, unknown>) => {
        if (!row || typeof row.issue_id !== "string" || typeof row.canonical_material_id !== "string") return [];
        return [{
          canonicalMaterialId: row.canonical_material_id,
          product: typeof row.product === "string" ? row.product : "Không rõ sản phẩm",
          skuCode: typeof row.sku_code === "string" ? row.sku_code : null,
          issueId: row.issue_id,
          issueNumber: typeof row.issue_number === "string" ? row.issue_number : "",
          issueDate: typeof row.issue_date === "string" ? row.issue_date : "",
          qty: Number(row.qty ?? 0) || 0,
          unit: typeof row.unit === "string" ? row.unit : "",
        }];
      });
    },
  });
}

export interface ResolveQ7BomLineInput {
  canonicalMaterialId: string;
  sourceUnit: string;
  action: Q7BomAction;
  targetItemId?: string | null;
  factor?: number | null;
  note?: string | null;
  requestId?: string;
}

/** Owner decision: re-point or exclude one BOM line. */
export function useResolveQ7BomLine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ResolveQ7BomLineInput): Promise<Q7BomResolveResult> => {
      const { data, error } = await (supabase as any).rpc("resolve_q7_bom_line", {
        p_canonical_material_id: input.canonicalMaterialId,
        p_source_unit: input.sourceUnit,
        p_action: input.action,
        p_target_item_id: input.targetItemId ?? null,
        p_factor: input.factor ?? null,
        p_note: input.note ?? null,
        p_request_id: input.requestId ?? newRequestId(),
      });
      if (error) throw error;
      return parseQ7BomResolveResult(data);
    },
    onSuccess: () => invalidateQ7BomMatch(queryClient),
  });
}

export interface PostPendingQ7IssuesInput {
  dryRun?: boolean;
}

/** Owner / cron catch-up: regenerate stale issues then post each issue once. */
export function usePostPendingQ7Issues() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: PostPendingQ7IssuesInput = {},
    ): Promise<Q7BomCatchUpResult> => {
      const { data, error } = await (supabase as any).rpc("post_pending_q7_material_issues", {
        p_dry_run: input.dryRun ?? false,
      });
      if (error) throw error;
      return parseQ7BomCatchUpResult(data);
    },
    onSuccess: () => invalidateQ7BomMatch(queryClient),
  });
}
