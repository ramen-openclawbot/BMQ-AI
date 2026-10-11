// Service-role data access for the stock routing Jev suggestions.
//
// Every read is a fixed SELECT / RPC from the service-role client; the client
// never supplies SQL, table names or filters. The only writes are
// supplier_routing_suggestions / material_category_suggestions rows, the shared
// stock_catalog_jev_usage counter and the two routing RPCs that apply a
// suggestion. Nothing here touches a payment, a purchase order or a receipt line.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.90.1";
import {
  STOCK_ROUTING_DAILY_CALL_LIMIT,
  StockRoutingError,
  type MaterialCategoryCandidate,
  type MaterialCategoryRow,
  type MaterialSuggestionInput,
  type StockRoutingUsage,
  type SupplierRoutingCandidate,
  type SupplierRoutingEvidence,
  type SupplierSuggestionInput,
} from "./handler.ts";

function fail(): never {
  throw new StockRoutingError("scan_failed", 503);
}

function asNumber(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function mapEvidence(raw: unknown): SupplierRoutingEvidence {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail();
  const record = raw as Record<string, unknown>;
  const rawItems = Array.isArray(record.top_items) ? record.top_items : [];
  const topItems = rawItems
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    .map((entry) => ({ name: asString(entry.name), line_count: asNumber(entry.line_count) }));
  const ruleHint = record.rule_hint;
  return {
    supplier_id: asString(record.supplier_id),
    supplier_name: asNullableString(record.supplier_name),
    category: asNullableString(record.category),
    receipt_count: asNumber(record.receipt_count),
    top_items: topItems,
    rule_hint:
      ruleHint === "q7" || ruleHint === "tan_tao" || ruleHint === "non_stock"
        ? ruleHint
        : null,
  };
}

export interface StockRoutingStore {
  getUsage(usageDate: string): Promise<StockRoutingUsage>;
  recordUsage(usage: StockRoutingUsage): Promise<void>;
  listSupplierCandidates(promptVersion: string, limit: number): Promise<SupplierRoutingCandidate[]>;
  putSupplierSuggestion(input: SupplierSuggestionInput): Promise<{ id: string }>;
  applySupplierRouting(
    supplierId: string,
    location: string,
    source: string,
    suggestionId: string,
  ): Promise<Record<string, unknown>>;
  listMaterialCandidates(promptVersion: string, limit: number): Promise<MaterialCategoryCandidate[]>;
  listCategories(): Promise<MaterialCategoryRow[]>;
  putMaterialSuggestion(input: MaterialSuggestionInput): Promise<{ id: string }>;
  decideMaterialCategory(suggestionId: string, action: "approve" | "reject"): Promise<Record<string, unknown>>;
}

export function createStockRoutingStore(admin: SupabaseClient): StockRoutingStore {
  return {
    async getUsage(usageDate) {
      const { data, error } = await admin
        .from("stock_catalog_jev_usage")
        .select("usage_date,calls,cost,call_limit")
        .eq("usage_date", usageDate)
        .maybeSingle();
      if (error) fail();
      if (!data) return { usage_date: usageDate, calls: 0, cost: 0, call_limit: STOCK_ROUTING_DAILY_CALL_LIMIT };
      const row = data as unknown as { usage_date: string; calls: number; cost: number; call_limit: number };
      return {
        usage_date: row.usage_date,
        calls: asNumber(row.calls),
        cost: asNumber(row.cost),
        call_limit: asNumber(row.call_limit) || STOCK_ROUTING_DAILY_CALL_LIMIT,
      };
    },

    async recordUsage(usage) {
      const { error } = await admin
        .from("stock_catalog_jev_usage")
        .upsert(usage, { onConflict: "usage_date" });
      if (error) fail();
    },

    async listSupplierCandidates(promptVersion, limit) {
      const { data, error } = await admin.rpc("get_stock_routing_supplier_candidates", {
        p_prompt_version: promptVersion,
        p_limit: limit,
        p_days: 180,
      });
      if (error) fail();
      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      const candidates: SupplierRoutingCandidate[] = [];
      for (const row of rows) {
        const supplierId = asNullableString(row.supplier_id);
        if (supplierId === null) continue;
        const { data: evidenceData, error: evidenceError } = await admin.rpc("supplier_routing_evidence", {
          p_supplier_id: supplierId,
        });
        if (evidenceError) fail();
        const evidence = mapEvidence(evidenceData);
        candidates.push({
          supplier_id: supplierId,
          receipt_count: evidence.receipt_count,
          manual: asNullableString(row.receiving_location_source) === "manual",
          evidence,
        });
      }
      return candidates;
    },

    async putSupplierSuggestion(input) {
      const { data, error } = await admin
        .from("supplier_routing_suggestions")
        .insert({
          supplier_id: input.supplierId,
          proposed_location: input.proposedLocation,
          probability: input.probability,
          jev_answer: input.jevAnswer,
          evidence: input.evidence,
          prompt_version: input.promptVersion,
          cost: input.cost,
          status: "pending",
        })
        .select("id")
        .single();
      if (error) fail();
      const id = asNullableString((data as unknown as Record<string, unknown>).id);
      if (id === null) fail();
      return { id };
    },

    async applySupplierRouting(supplierId, location, source, suggestionId) {
      const { data, error } = await admin.rpc("apply_supplier_routing", {
        p_supplier_id: supplierId,
        p_location: location,
        p_source: source,
        p_suggestion: suggestionId,
      });
      if (error) fail();
      return (data ?? {}) as Record<string, unknown>;
    },

    async listMaterialCandidates(promptVersion, limit) {
      const { data, error } = await admin.rpc("get_stock_routing_material_candidates", {
        p_prompt_version: promptVersion,
        p_limit: limit,
      });
      if (error) fail();
      return ((data ?? []) as unknown as Record<string, unknown>[])
        .map((row) => ({
          material_id: asString(row.material_id),
          material_code: asString(row.material_code),
          canonical_name: asString(row.canonical_name),
          default_unit: asString(row.default_unit),
          alias_names: Array.isArray(row.alias_names) ? row.alias_names.map((x) => asString(x)) : [],
        }))
        .filter((row) => row.material_id !== "" && row.canonical_name !== "");
    },

    async listCategories() {
      const { data, error } = await admin
        .from("stock_material_categories")
        .select("code,label_vi,sort_order")
        .order("sort_order", { ascending: true })
        .order("code", { ascending: true });
      if (error) fail();
      return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
        code: asString(row.code),
        label_vi: asString(row.label_vi),
        sort_order: asNumber(row.sort_order),
      })).filter((row) => row.code !== "");
    },

    async putMaterialSuggestion(input) {
      const { data, error } = await admin
        .from("material_category_suggestions")
        .insert({
          material_id: input.materialId,
          proposed_category: input.proposedCategory,
          probability: input.probability,
          jev_answer: input.jevAnswer,
          prompt_version: input.promptVersion,
          cost: input.cost,
          status: "pending",
        })
        .select("id")
        .single();
      if (error) fail();
      const id = asNullableString((data as unknown as Record<string, unknown>).id);
      if (id === null) fail();
      return { id };
    },

    async decideMaterialCategory(suggestionId, action) {
      const { data, error } = await admin.rpc("decide_material_category", {
        p_id: suggestionId,
        p_action: action,
        p_category: null,
      });
      if (error) fail();
      return (data ?? {}) as Record<string, unknown>;
    },
  };
}
