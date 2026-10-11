import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";

/** Value of the item <select> option that switches the row to "create a new item". */
export const NEW_ITEM_OPTION = "__new__";

export interface StockCatalogItem {
  id: string;
  name: string;
  unit: string;
}

/** Active, unmerged Q7 kitchen items for the "Chọn khác" picker. */
export function useStockCatalogItems(enabled = true) {
  return useQuery({
    queryKey: ["stock-catalog-items"],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<StockCatalogItem[]> => {
      const { data, error } = await supabase
        .from("kitchen_inventory_items")
        .select("id,name,unit")
        .eq("active", true)
        .is("merged_into_id", null)
        .order("name");
      if (error) throw error;
      return (data ?? []).map((row) => ({ id: row.id, name: row.name, unit: row.unit ?? "" }));
    },
  });
}

/**
 * Suggested name for a new item from an invoice line: drop "[Thùng]" prefixes,
 * keep the Vietnamese half of "A / B" bilingual names and trailing pack sizes.
 */
export function cleanNewItemName(raw: string): string {
  const noPrefix = raw.replace(/^\s*(\[[^\]]*\]\s*)+/, "");
  const parts = noPrefix.split("/").map((part) => part.trim()).filter(Boolean);
  const vietnamese = parts.find((part) => /[à-ỹđ]/i.test(part)) ?? parts[0] ?? noPrefix;
  return vietnamese.replace(/\s+/g, " ").trim();
}

const WEIGHT = new Set(["kg", "g", "gr", "gram"]);
const VOLUME = new Set(["l", "lit", "ml"]);

/** Default stock unit for a new item: weight → g, volume → ml, otherwise cái. */
export function defaultNewItemUnit(raw: string, invoiceUnit?: string | null): string {
  const unit = raw.toLowerCase().match(/\d\s*(kg|gr|gram|g|lit|ml|l)\b/)?.[1]
    ?? invoiceUnit?.trim().toLowerCase().match(/^(kg|gr|gram|g|lit|ml|l)$/)?.[1];
  if (unit && WEIGHT.has(unit)) return "g";
  if (unit && VOLUME.has(unit)) return "ml";
  return "cái";
}

const toBase = (qty: number, unit: string) =>
  unit === "kg" || unit === "l" || unit === "lit" ? qty * 1000 : qty;

/**
 * Pack read from an invoice name, converted into the stock unit when both are
 * weights or both are volumes: "Bột mì 888 Cam (25kg)" with unit g → 25 000.
 */
export function packFactorFor(raw: string, stockUnit: string): { label: string; factor: number } | null {
  const match = raw.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(kg|gr|gram|g|lit|ml|l)\b(?:\s*x\s*(\d+))?/);
  if (!match) return null;
  const qty = Number(match[1].replace(",", "."));
  const packUnit = match[2];
  const count = match[3] ? Number(match[3]) : 1;
  const target = stockUnit.trim().toLowerCase();
  const sameKind = (WEIGHT.has(packUnit) && WEIGHT.has(target)) || (VOLUME.has(packUnit) && VOLUME.has(target));
  if (!Number.isFinite(qty) || qty <= 0 || !sameKind) return null;
  const factor = (toBase(qty, packUnit) * count) / toBase(1, target);
  return { label: match[0].replace(/\s+/g, ""), factor: Math.round(factor * 1000) / 1000 };
}

const UNIT_CHOICES = ["g", "ml", "cái", "Hộp", "Cuộn", "Chai", "Bịch", "Gói"];

/** Name + stock unit inputs shown when "Tạo mặt hàng mới" is picked. */
export function NewStockItemFields({
  name,
  unit,
  onName,
  onUnit,
  idPrefix,
}: {
  name: string;
  unit: string;
  onName: (value: string) => void;
  onUnit: (value: string) => void;
  idPrefix: string;
}) {
  return (
    <>
      <label className="d3-ma-field d3-ma-item">
        <span>Tên mặt hàng mới</span>
        <Input value={name} onChange={(event) => onName(event.target.value)} aria-label="Tên mặt hàng mới" />
      </label>
      <label className="d3-ma-field">
        <span>Đơn vị kho</span>
        <Input value={unit} onChange={(event) => onUnit(event.target.value)} list={`${idPrefix}-units`} aria-label="Đơn vị kho của mặt hàng mới" />
        <datalist id={`${idPrefix}-units`}>
          {UNIT_CHOICES.map((value) => <option key={value} value={value} />)}
        </datalist>
      </label>
    </>
  );
}
