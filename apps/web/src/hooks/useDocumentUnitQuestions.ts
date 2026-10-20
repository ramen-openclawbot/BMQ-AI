import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseDocumentUnitQuestion,
  parseDocumentUnitQuestions,
  type DocumentUnitAnswerInput,
  type DocumentUnitQuestion,
} from "@/lib/document-unit-questions";
import { MISSIONS_QUERY_KEY } from "./useMissions";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

export const DOCUMENT_UNIT_QUESTIONS_QUERY_KEY = "document-unit-questions";

/** The new RPC names are not in the generated Database type yet. */
const rpcClient = supabase as any;

/** Answering a line moves the question list, the mission and the warehouse snapshot. */
function invalidateDocumentUnitQuestions(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [DOCUMENT_UNIT_QUESTIONS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MISSIONS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
}

/** The questions of one batch (owner only on the server). */
export function useDocumentUnitQuestions(batch: string, enabled = true) {
  return useQuery({
    queryKey: [DOCUMENT_UNIT_QUESTIONS_QUERY_KEY, batch],
    enabled: enabled && batch.trim() !== "",
    queryFn: async (): Promise<DocumentUnitQuestion[]> => {
      const { data, error } = await rpcClient.rpc("get_document_unit_questions", {
        p_batch: batch,
      });
      if (error) throw error;
      return parseDocumentUnitQuestions(data);
    },
  });
}

export interface AnswerDocumentUnitQuestionInput extends DocumentUnitAnswerInput {
  questionId: string;
}

/**
 * Answer or skip one question. The server locks the question, retires the old
 * conversion of the same pair and replays the stored row on a second click.
 */
export function useAnswerDocumentUnitQuestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AnswerDocumentUnitQuestionInput): Promise<DocumentUnitQuestion> => {
      const { data, error } = await rpcClient.rpc("answer_document_unit_question", {
        p_id: input.questionId,
        p_action: input.action,
        p_factor: input.factor ?? null,
        p_actual_unit: input.actualUnit ?? null,
        p_reason: input.reason ?? null,
      });
      if (error) throw error;
      return parseDocumentUnitQuestion(data);
    },
    onSuccess: () => invalidateDocumentUnitQuestions(queryClient),
  });
}
