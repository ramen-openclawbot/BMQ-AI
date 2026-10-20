import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseStockItemNames,
  type StockItemName,
  type StockNameLine,
} from "@/lib/stock-item-names";

export const STOCK_ITEM_NAMES_QUERY_KEY = "stock-item-names";

/** The new RPC is not in the generated Database type yet. */
type StockNamesRpcClient = {
  rpc: (
    fn: "get_stock_item_names_for_lines",
    args: { p_lines: StockNameLine[] },
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

function sortedLineKeys(lines: StockNameLine[]): string[] {
  return lines
    .map((line) =>
      [line.key, line.supplier_id ?? "", line.name, line.location ?? ""].join("|"),
    )
    .sort();
}

/**
 * Current warehouse names for document lines. An RPC failure deliberately
 * resolves to an empty map so the document keeps rendering its own product
 * names instead of losing the rows.
 */
export function useStockItemNames(lines: StockNameLine[]) {
  return useQuery({
    queryKey: [STOCK_ITEM_NAMES_QUERY_KEY, sortedLineKeys(lines)],
    enabled: lines.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, StockItemName>> => {
      try {
        const client = supabase as unknown as StockNamesRpcClient;
        const { data, error } = await client.rpc("get_stock_item_names_for_lines", {
          p_lines: lines,
        });

        if (error) {
          console.warn("[useStockItemNames] get_stock_item_names_for_lines failed", error);
          return new Map<string, StockItemName>();
        }

        return parseStockItemNames(data);
      } catch (error) {
        console.warn("[useStockItemNames] get_stock_item_names_for_lines failed", error);
        return new Map<string, StockItemName>();
      }
    },
  });
}
