import { useMutation } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

export type SuggestStockItemNameLocation = "q7" | "tan_tao";

/**
 * Either one receipt line, or the pending crate key (location + supplier +
 * normalized name) the Kho 2D game already uses. The edge function resolves the
 * crate to its newest receipt line that has an image.
 */
export type SuggestStockItemNameInput =
  | { goods_receipt_item_id: string }
  | {
      location: SuggestStockItemNameLocation;
      supplier_id: string | null;
      normalized_name: string;
    };

export interface StockItemNameSuggestion {
  full_name: string;
  unit: string | null;
  confidence: number;
  source: "invoice_image" | "cache";
}

interface SuggestStockItemNameResponse {
  suggestion?: StockItemNameSuggestion | null;
  reason?: string;
}

/**
 * supabase.functions.invoke hides the edge function's JSON body behind a generic
 * "non-2xx" error. Read it so the caller sees the real reason (and its code),
 * same as jevInvokeError in useMaterialAlias.ts.
 */
async function invokeError(error: unknown): Promise<Error> {
  const context = (error as { context?: unknown })?.context;
  if (context instanceof Response) {
    try {
      const body = (await context.clone().json()) as { error?: unknown; code?: unknown };
      const message = typeof body.error === "string" ? body.error : null;
      const code = typeof body.code === "string" ? body.code : null;
      if (message) return new Error(code ? `${message} (${code}, ${context.status})` : message);
    } catch {
      /* not JSON: fall through to the generic error */
    }
    return new Error(`Đọc ảnh hóa đơn lỗi ${context.status}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeSuggestion(data: unknown): StockItemNameSuggestion | null {
  const suggestion = (data as SuggestStockItemNameResponse | null)?.suggestion;
  if (!suggestion || typeof suggestion.full_name !== "string" || suggestion.full_name.trim() === "") {
    return null;
  }
  return {
    full_name: suggestion.full_name,
    unit: typeof suggestion.unit === "string" ? suggestion.unit : null,
    confidence: Number(suggestion.confidence ?? 0),
    source: suggestion.source === "cache" ? "cache" : "invoice_image",
  };
}

/**
 * Ask the suggest-stock-item-name edge function for the full printed name of a
 * new stock item. Resolves to null when the receipt has no image or no invoice
 * line matched; throws when the call fails.
 */
export function useSuggestStockItemName() {
  return useMutation({
    mutationFn: async (input: SuggestStockItemNameInput): Promise<StockItemNameSuggestion | null> => {
      const { data, error } = await supabase.functions.invoke("suggest-stock-item-name", {
        body: input,
      });
      if (error) throw await invokeError(error);
      return normalizeSuggestion(data);
    },
  });
}
