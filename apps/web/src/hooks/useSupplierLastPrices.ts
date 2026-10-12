import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

// No UI: this hook only reads the most recent purchase line per scanned product
// name through the read-only RPC. The server owns the permission gate and the
// supplier / status / positive-number rules.

export const SUPPLIER_LAST_PRICES_QUERY_KEY = "supplier-last-line-prices";

export interface SupplierLastLine {
  product_name: string | null;
  normalized_name: string | null;
  unit: string | null;
  quantity: number | null;
  unit_price: number | null;
  po_number: string | null;
  created_at: string | null;
}

/** Keyed by the trimmed input name sent to the RPC; newest line first (up to 5). */
export type SupplierLastPricesMap = Map<string, SupplierLastLine[]>;

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  return null;
}

function asNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRow(value: unknown): { inputName: string; line: SupplierLastLine } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const inputName = asString(row.input_name);
  if (!inputName) return null;
  return {
    inputName: inputName.trim(),
    line: {
      product_name: asString(row.product_name),
      normalized_name: asString(row.normalized_name),
      unit: asString(row.unit),
      quantity: asNumber(row.quantity),
      unit_price: asNumber(row.unit_price),
      po_number: asString(row.po_number),
      created_at: asString(row.created_at),
    },
  };
}

/** Defensive parse: skip anything that is not a well-formed name row. */
export function parseSupplierLastPrices(data: unknown): SupplierLastPricesMap {
  const map: SupplierLastPricesMap = new Map();
  if (!Array.isArray(data)) return map;
  for (const value of data) {
    const parsed = parseRow(value);
    if (!parsed) continue;
    const list = map.get(parsed.inputName) ?? [];
    list.push(parsed.line);
    map.set(parsed.inputName, list);
  }
  return map;
}

/**
 * Latest previous purchase lines (up to 5) for each scanned name of one supplier. The
 * query only runs when a supplier and at least one non-empty name are present.
 */
export function useSupplierLastPrices(supplierId: string | null, names: string[]) {
  const cleanNames = Array.from(
    new Set((names ?? []).map((name) => String(name ?? "").trim()).filter(Boolean)),
  ).sort();

  return useQuery({
    queryKey: [SUPPLIER_LAST_PRICES_QUERY_KEY, supplierId, cleanNames],
    enabled: Boolean(supplierId) && cleanNames.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<SupplierLastPricesMap> => {
      const { data, error } = await supabase.rpc(
        "get_supplier_last_line_prices" as never,
        {
          p_supplier_id: supplierId as string,
          p_names: cleanNames,
        } as never,
      );
      if (error) throw error;
      return parseSupplierLastPrices(data);
    },
  });
}
