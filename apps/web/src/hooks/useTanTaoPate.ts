import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseTanTaoPateProductionResult,
  parseTanTaoPateRecipe,
  type TanTaoPatePackInput,
  type TanTaoPateProductionResult,
  type TanTaoPateRecipe,
} from "@/lib/tan-tao-pate";
import { MISSIONS_QUERY_KEY } from "./useMissions";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

export const TAN_TAO_PATE_RECIPE_QUERY_KEY = "tan-tao-pate-recipe";

/** The recipe RPCs are not in the generated Database type yet. */
const rpcClient = supabase as any;

function newRequestId(): string {
  return crypto.randomUUID();
}

/** Recipe changes move the recipe, the owner mission and the warehouse snapshot. */
function invalidateTanTaoPate(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [TAN_TAO_PATE_RECIPE_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MISSIONS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: ["tan-tao-warehouse-snapshot"] });
}

export function useTanTaoPateRecipe(code = "pate-heo", enabled = true) {
  return useQuery({
    queryKey: [TAN_TAO_PATE_RECIPE_QUERY_KEY, code],
    enabled: enabled && code.trim() !== "",
    queryFn: async (): Promise<TanTaoPateRecipe> => {
      const { data, error } = await rpcClient.rpc("get_tan_tao_recipe", { p_code: code });
      if (error) throw error;
      return parseTanTaoPateRecipe(data);
    },
  });
}

export interface AnswerTanTaoPateLineInput {
  lineId: string;
  itemId?: string | null;
  grams?: number | null;
  notUsed?: boolean;
  packItemId?: string | null;
  labelItemId?: string | null;
  pateGrams?: number | null;
  requestId?: string;
}

/** Answer / re-answer one recipe line; the server keeps the first answer author. */
export function useAnswerTanTaoPateLine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AnswerTanTaoPateLineInput): Promise<TanTaoPateRecipe> => {
      const { data, error } = await rpcClient.rpc("answer_tan_tao_recipe_line", {
        p_line_id: input.lineId,
        p_item_id: input.itemId ?? null,
        p_grams: input.grams ?? null,
        p_not_used: input.notUsed ?? false,
        p_pack_item_id: input.packItemId ?? null,
        p_label_item_id: input.labelItemId ?? null,
        p_pate_grams: input.pateGrams ?? null,
        p_request_id: input.requestId ?? newRequestId(),
      });
      if (error) throw error;
      return parseTanTaoPateRecipe(data);
    },
    onSuccess: () => invalidateTanTaoPate(queryClient),
  });
}

export interface SetTanTaoPateBatchInput {
  code?: string;
  batchOutputKg: number;
  requestId?: string;
}

/** Set the single batch-output question. */
export function useSetTanTaoPateBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetTanTaoPateBatchInput): Promise<TanTaoPateRecipe> => {
      const { data, error } = await rpcClient.rpc("set_tan_tao_recipe_batch", {
        p_code: input.code ?? "pate-heo",
        p_batch_output_kg: input.batchOutputKg,
        p_request_id: input.requestId ?? newRequestId(),
      });
      if (error) throw error;
      return parseTanTaoPateRecipe(data);
    },
    onSuccess: () => invalidateTanTaoPate(queryClient),
  });
}

export interface RecordTanTaoPateProductionInput {
  date: string;
  batches: number;
  packs: TanTaoPatePackInput[];
  note?: string | null;
  requestId?: string;
}

/**
 * Post one production slip: ingredient usage, packaging usage and the packed
 * PATE SKUs. Reusing requestId returns the stored slip without new movements.
 */
export function useRecordTanTaoPateProduction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: RecordTanTaoPateProductionInput,
    ): Promise<TanTaoPateProductionResult> => {
      const { data, error } = await rpcClient.rpc("record_tan_tao_pate_production", {
        p_date: input.date,
        p_batches: input.batches,
        p_packs: input.packs,
        p_note: input.note ?? null,
        p_request_id: input.requestId ?? newRequestId(),
      });
      if (error) throw error;
      return parseTanTaoPateProductionResult(data);
    },
    onSuccess: () => invalidateTanTaoPate(queryClient),
  });
}
