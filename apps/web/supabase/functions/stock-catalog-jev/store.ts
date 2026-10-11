// Service-role data access for the Q7 stock catalog Jev scan.
//
// Every read is a fixed SELECT / RPC from the service-role client; the client
// never supplies SQL, table names or filters. The only writes are
// stock_catalog_suggestions rows and the stock_catalog_jev_usage counter. Nothing
// here updates or deletes a business row and this module never merges an item.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.90.1";
import { candidatePairKey, type StockCatalogCandidate, type StockCatalogClassifyItem } from "./candidates.ts";
import {
  STOCK_CATALOG_DAILY_CALL_LIMIT,
  StockCatalogError,
  type StockCatalogSuggestionRow,
  type StockCatalogUsage,
} from "./handler.ts";

const STOCK_CATALOG_CLASSIFY_ITEM_LIMIT = 500;
const COUNT_LOOKBACK_DAYS = 90;

function fail(): never {
  throw new StockCatalogError("scan_failed", 503);
}

function asNumber(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function mapCandidate(row: Record<string, unknown>): StockCatalogCandidate {
  return {
    left_id: String(row.left_id),
    right_id: String(row.right_id),
    left_name: String(row.left_name ?? ""),
    right_name: String(row.right_name ?? ""),
    left_unit: String(row.left_unit ?? ""),
    right_unit: String(row.right_unit ?? ""),
    left_item_type: String(row.left_item_type ?? ""),
    right_item_type: String(row.right_item_type ?? ""),
    left_issue_count_90d: asNumber(row.left_issue_count_90d),
    right_issue_count_90d: asNumber(row.right_issue_count_90d),
    left_movement_count_90d: asNumber(row.left_movement_count_90d),
    right_movement_count_90d: asNumber(row.right_movement_count_90d),
    left_canonical_material_id: (row.left_canonical_material_id as string) ?? null,
    right_canonical_material_id: (row.right_canonical_material_id as string) ?? null,
    left_canonical_material_code: (row.left_canonical_material_code as string) ?? null,
    right_canonical_material_code: (row.right_canonical_material_code as string) ?? null,
    left_to_right_factor: asNullableNumber(row.left_to_right_factor),
    right_to_left_factor: asNullableNumber(row.right_to_left_factor),
  };
}

export interface StockCatalogStore {
  listCandidates(): Promise<StockCatalogCandidate[]>;
  listExistingMergePairKeys(promptVersion: string): Promise<string[]>;
  listUnclassifiedItems(promptVersion: string): Promise<StockCatalogClassifyItem[]>;
  getUsage(usageDate: string): Promise<StockCatalogUsage>;
  recordUsage(usage: StockCatalogUsage): Promise<void>;
  insertSuggestions(rows: StockCatalogSuggestionRow[]): Promise<void>;
}

export function createStockCatalogStore(admin: SupabaseClient): StockCatalogStore {
  return {
    async listCandidates() {
      const { data, error } = await admin.rpc("get_stock_catalog_candidates");
      if (error) fail();
      return ((data ?? []) as unknown as Record<string, unknown>[]).map(mapCandidate);
    },

    async listExistingMergePairKeys(promptVersion) {
      const { data, error } = await admin
        .from("stock_catalog_suggestions")
        .select("item_id,other_item_id")
        .eq("kind", "merge")
        .eq("prompt_version", promptVersion)
        .limit(5_000);
      if (error) fail();
      return ((data ?? []) as unknown as { item_id: string; other_item_id: string | null }[])
        .filter((row) => row.other_item_id !== null)
        .map((row) => candidatePairKey(row.item_id, row.other_item_id as string));
    },

    async listUnclassifiedItems(promptVersion) {
      const { data: existing, error: existingError } = await admin
        .from("stock_catalog_suggestions")
        .select("item_id")
        .eq("kind", "classify")
        .eq("prompt_version", promptVersion)
        .limit(5_000);
      if (existingError) fail();
      const seen = new Set(((existing ?? []) as unknown as { item_id: string }[]).map((row) => row.item_id));

      const { data, error } = await admin
        .from("kitchen_inventory_items")
        .select("id,name,unit,item_type,canonical_material_id")
        .eq("active", true)
        .is("item_class", null)
        .order("id", { ascending: true })
        .limit(STOCK_CATALOG_CLASSIFY_ITEM_LIMIT);
      if (error) fail();

      const rows = ((data ?? []) as unknown as {
        id: string;
        name: string | null;
        unit: string | null;
        item_type: string | null;
        canonical_material_id: string | null;
      }[]).filter((row) => !seen.has(row.id));
      if (rows.length === 0) return [];

      const since = new Date(Date.now() - COUNT_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
      const ids = rows.map((row) => row.id);
      const materialIds = [
        ...new Set(rows.map((row) => row.canonical_material_id).filter((id): id is string => typeof id === "string")),
      ];

      const issueCounts = new Map<string, number>();
      const movementCounts = new Map<string, number>();
      const materialCodes = new Map<string, string | null>();

      const { data: issueItems, error: issueItemsError } = await admin
        .from("production_material_issue_items")
        .select("kitchen_inventory_item_id,production_material_issues!inner(issue_date)")
        .in("kitchen_inventory_item_id", ids)
        .gte("production_material_issues.issue_date", since);
      if (issueItemsError) fail();
      for (const row of (issueItems ?? []) as unknown as { kitchen_inventory_item_id: string }[]) {
        issueCounts.set(row.kitchen_inventory_item_id, (issueCounts.get(row.kitchen_inventory_item_id) ?? 0) + 1);
      }

      const { data: movements, error: movementsError } = await admin
        .from("q7_inventory_movements")
        .select("kitchen_inventory_item_id")
        .in("kitchen_inventory_item_id", ids)
        .gte("movement_date", since);
      if (movementsError) fail();
      for (const row of (movements ?? []) as unknown as { kitchen_inventory_item_id: string }[]) {
        movementCounts.set(row.kitchen_inventory_item_id, (movementCounts.get(row.kitchen_inventory_item_id) ?? 0) + 1);
      }

      if (materialIds.length > 0) {
        const { data: materials, error: materialsError } = await admin
          .from("sku_cogs_materials")
          .select("id,material_code")
          .in("id", materialIds);
        if (materialsError) fail();
        for (const row of (materials ?? []) as unknown as { id: string; material_code: string | null }[]) {
          materialCodes.set(row.id, row.material_code ?? null);
        }
      }

      return rows.map((row) => ({
        id: row.id,
        name: row.name ?? "",
        unit: row.unit ?? "",
        item_type: row.item_type ?? "",
        issue_count_90d: issueCounts.get(row.id) ?? 0,
        movement_count_90d: movementCounts.get(row.id) ?? 0,
        canonical_material_id: row.canonical_material_id,
        canonical_material_code: row.canonical_material_id ? materialCodes.get(row.canonical_material_id) ?? null : null,
      }));
    },

    async getUsage(usageDate) {
      const { data, error } = await admin
        .from("stock_catalog_jev_usage")
        .select("usage_date,calls,cost,call_limit")
        .eq("usage_date", usageDate)
        .maybeSingle();
      if (error) fail();
      if (!data) {
        return { usage_date: usageDate, calls: 0, cost: 0, call_limit: STOCK_CATALOG_DAILY_CALL_LIMIT };
      }
      const row = data as unknown as { usage_date: string; calls: number; cost: number; call_limit: number };
      return {
        usage_date: row.usage_date,
        calls: asNumber(row.calls),
        cost: asNumber(row.cost),
        call_limit: asNumber(row.call_limit) || STOCK_CATALOG_DAILY_CALL_LIMIT,
      };
    },

    async recordUsage(usage) {
      const { error } = await admin
        .from("stock_catalog_jev_usage")
        .upsert(usage, { onConflict: "usage_date" });
      if (error) fail();
    },

    async insertSuggestions(rows) {
      if (rows.length === 0) return;
      const { error } = await admin.from("stock_catalog_suggestions").insert(rows);
      if (!error) return;
      // The unique (kind, pair, prompt_version) index can reject a concurrent
      // duplicate: keep the first writer and fall back to per-row inserts.
      if ((error as { code?: string }).code !== "23505") fail();
      for (const row of rows) {
        const { error: rowError } = await admin.from("stock_catalog_suggestions").insert(row);
        if (rowError && (rowError as { code?: string }).code !== "23505") fail();
      }
    },
  };
}
