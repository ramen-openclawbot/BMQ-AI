import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseStockCountUnitQuestion,
  parseStockCountUnitQuestions,
  type CountUnitAnswerInput,
  type StockCountUnitQuestion,
} from "@/lib/count-unit-questions";
import { MISSIONS_QUERY_KEY } from "./useMissions";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

export const COUNT_UNIT_QUESTIONS_QUERY_KEY = "count-unit-questions";

/** The new RPC names are not in the generated Database type yet. */
const rpcClient = supabase as any;

/** Answering a line moves the question list, the mission and the warehouse snapshot. */
function invalidateCountUnitQuestions(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [COUNT_UNIT_QUESTIONS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MISSIONS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
}

/** The 12 seeded questions of one batch, ordered by location then sort_order. */
export function useCountUnitQuestions(batch: string, enabled = true) {
  return useQuery({
    queryKey: [COUNT_UNIT_QUESTIONS_QUERY_KEY, batch],
    enabled: enabled && batch.trim() !== "",
    queryFn: async (): Promise<StockCountUnitQuestion[]> => {
      const { data, error } = await rpcClient.rpc("get_stock_count_unit_questions", {
        p_batch: batch,
      });
      if (error) throw error;
      return parseStockCountUnitQuestions(data);
    },
  });
}

export interface AnswerCountUnitQuestionInput extends CountUnitAnswerInput {
  questionId: string;
}

/**
 * Answer or skip one question. The server locks the question, records the stock
 * count once and replays the stored row on a second click.
 */
export function useAnswerCountUnitQuestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AnswerCountUnitQuestionInput): Promise<StockCountUnitQuestion> => {
      const { data, error } = await rpcClient.rpc("answer_stock_count_unit_question", {
        p_question_id: input.questionId,
        p_item_id: input.itemId ?? null,
        p_factor: input.factor ?? null,
        p_new_item_name: input.newItemName ?? null,
        p_new_item_unit: input.newItemUnit ?? null,
        p_skip: input.skip ?? false,
        p_note: input.note ?? null,
      });
      if (error) throw error;
      return parseStockCountUnitQuestion(data);
    },
    onSuccess: () => invalidateCountUnitQuestions(queryClient),
  });
}
