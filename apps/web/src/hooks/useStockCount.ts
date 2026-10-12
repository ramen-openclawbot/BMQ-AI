import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseSaveLineResult,
  parseStockCountReview,
  parseStockCountSession,
  type StockCountLine,
  type StockCountLocation,
  type StockCountReview,
  type StockCountSession,
} from "@/lib/stock-count";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

export const STOCK_COUNT_QUERY_KEY = "stock-count";
export const WAREHOUSE_GAME_QUERY_KEY = "warehouse-game";

/** Both the review and the game on_hand change after a count write. */
function invalidateStockCount(queryClient: QueryClient, location: StockCountLocation): void {
  void queryClient.invalidateQueries({ queryKey: [STOCK_COUNT_QUERY_KEY, location] });
  void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_QUERY_KEY, location] });
  void queryClient.invalidateQueries({
    queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY, location],
  });
}

/** Open session + recent history of one warehouse. */
export function useStockCountReview(location: StockCountLocation, limit = 20) {
  return useQuery({
    queryKey: [STOCK_COUNT_QUERY_KEY, location, limit],
    queryFn: async (): Promise<StockCountReview> => {
      const { data, error } = await supabase.rpc("get_stock_count_review", {
        p_location: location,
        p_limit: limit,
      });
      if (error) throw error;
      return parseStockCountReview(data);
    },
    enabled: Boolean(location),
  });
}

export interface StartStockCountInput {
  location: StockCountLocation;
  /** Defaults to a fresh crypto.randomUUID(). */
  idempotencyKey?: string;
}

/** Open (or return) the single open session of a location. */
export function useStartStockCount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: StartStockCountInput): Promise<StockCountSession> => {
      const { data, error } = await supabase.rpc("start_stock_count", {
        p_location: input.location,
        p_idempotency_key: input.idempotencyKey ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return parseStockCountSession(data);
    },
    onSuccess: (_session, input) => invalidateStockCount(queryClient, input.location),
  });
}

export interface SaveStockCountLineInput {
  location: StockCountLocation;
  sessionId: string;
  lineId: string;
  /** `null` clears the saved count of the line. */
  countedQty: number | null;
  note?: string | null;
}

/** Save / clear one counted line of an open session. */
export function useSaveStockCountLine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveStockCountLineInput): Promise<StockCountLine> => {
      const { data, error } = await supabase.rpc("save_stock_count_line", {
        p_session_id: input.sessionId,
        p_line_id: input.lineId,
        p_counted_qty: input.countedQty,
        p_note: input.note ?? null,
      });
      if (error) throw error;
      return parseSaveLineResult(data);
    },
    onSuccess: (_line, input) => invalidateStockCount(queryClient, input.location),
  });
}

export interface SubmitStockCountInput {
  location: StockCountLocation;
  sessionId: string;
  /** Defaults to a fresh crypto.randomUUID(). */
  idempotencyKey?: string;
}

/** Close the session, writing every counted difference through the stock RPCs. */
export function useSubmitStockCount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitStockCountInput): Promise<StockCountSession> => {
      const { data, error } = await supabase.rpc("submit_stock_count", {
        p_session_id: input.sessionId,
        p_idempotency_key: input.idempotencyKey ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return parseStockCountSession(data);
    },
    onSuccess: (_session, input) => invalidateStockCount(queryClient, input.location),
  });
}

export interface CancelStockCountInput {
  location: StockCountLocation;
  sessionId: string;
}

/** Discard an open session without writing any adjustment. */
export function useCancelStockCount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CancelStockCountInput): Promise<StockCountSession> => {
      const { data, error } = await supabase.rpc("cancel_stock_count", {
        p_session_id: input.sessionId,
      });
      if (error) throw error;
      return parseStockCountSession(data);
    },
    onSuccess: (_session, input) => invalidateStockCount(queryClient, input.location),
  });
}
