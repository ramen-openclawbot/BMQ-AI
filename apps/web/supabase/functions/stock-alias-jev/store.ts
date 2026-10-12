// Service-role data access for the stock-material alias Jev ranking.
//
// Every read is a fixed SELECT / RPC from the service-role client; the client
// never supplies SQL, table names or filters. The only write is a
// material_alias_jev_cache row and the shared stock_catalog_jev_usage counter.
// Nothing here updates or deletes a business row and no alias is applied.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.90.1";
import {
  MATERIAL_ALIAS_DAILY_CALL_LIMIT,
  MaterialAliasError,
  type CachedJevAnswer,
  type MaterialAliasBacklogRow,
  type MaterialAliasCacheKey,
  type MaterialAliasUsage,
  type NewItemRunRow,
} from "./handler.ts";
import { NONE_OPTION, type MaterialAliasCandidate } from "./jev.ts";
import type { NewItemSuggestionRow, NewItemUnmatchedRow } from "./new-items.ts";

function fail(): never {
  throw new MaterialAliasError("scan_failed", 503);
}

function asNumber(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function mapCandidate(row: Record<string, unknown>): MaterialAliasCandidate {
  const itemId = asNullableString(row.item_id);
  const skuId = asNullableString(row.sku_id);
  return {
    id: itemId ?? skuId ?? "",
    name: String(row.name ?? ""),
    unit: String(row.unit ?? ""),
    reason: String(row.reason ?? ""),
  };
}

function mapCachedAnswer(raw: unknown): CachedJevAnswer | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const parseLineType = (value: unknown): "goods" | "non_goods" | null =>
    value === "goods" || value === "non_goods" ? value : null;
  const parseLineTypeProbability = (value: unknown): number | null =>
    value === null || value === undefined ? null : asNumber(value);
  const choice = record.choice === null || record.choice === undefined ? null : String(record.choice);
  if (choice !== null && choice === NONE_OPTION) {
    return {
      choice: null,
      item_id: null,
      probability: 0,
      line_type: parseLineType(record.line_type),
      line_type_probability: parseLineTypeProbability(record.line_type_probability),
      confidence: null,
      pack: null,
      source: asNullableString(record.source),
    };
  }
  const parsePack = (value: unknown): CachedJevAnswer["pack"] => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const pack = value as Record<string, unknown>;
    return {
      label: String(pack.label ?? ""),
      base_qty: pack.base_qty === null || pack.base_qty === undefined ? null : asNumber(pack.base_qty),
      base_unit: asNullableString(pack.base_unit),
      multiplier: asNumber(pack.multiplier),
    };
  };
  return {
    choice,
    item_id: choice,
    probability: record.probability === undefined ? 0 : asNumber(record.probability),
    line_type: parseLineType(record.line_type),
    line_type_probability: parseLineTypeProbability(record.line_type_probability),
    confidence: record.confidence === null || record.confidence === undefined ? null : asNumber(record.confidence),
    pack: parsePack(record.pack),
    source: asNullableString(record.source),
  };
}

function cacheRowKey(parts: {
  normalized_name: unknown;
  location: unknown;
  prompt_version: unknown;
  candidates_hash: unknown;
  supplier_id: unknown;
}): string {
  return [
    String(parts.normalized_name ?? ""),
    String(parts.location ?? ""),
    String(parts.prompt_version ?? ""),
    String(parts.candidates_hash ?? ""),
    parts.supplier_id === null || parts.supplier_id === undefined ? "" : String(parts.supplier_id),
  ].join("|");
}

function cacheKeyString(key: MaterialAliasCacheKey): string {
  return [
    key.normalizedName,
    key.location,
    key.promptVersion,
    key.candidatesHash,
    key.supplierId ?? "",
  ].join("|");
}

function mapNewItemRun(row: Record<string, unknown>): NewItemRunRow {
  return {
    id: String(row.id ?? ""),
    location: String(row.location ?? "q7"),
    status: String(row.status ?? "queued") as NewItemRunRow["status"],
    processed: asNumber(row.processed),
    remaining: asNumber(row.remaining),
    calls: asNumber(row.calls),
    groups: asNumber(row.groups),
    last_error: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
  };
}

export interface MaterialAliasStore {
  getCache(key: MaterialAliasCacheKey): Promise<{ answer: CachedJevAnswer; cost: number | null } | null>;
  getCacheMany(keys: MaterialAliasCacheKey[]): Promise<Array<{ answer: CachedJevAnswer; cost: number | null } | null>>;
  putCache(key: MaterialAliasCacheKey, answer: CachedJevAnswer, cost: number | null): Promise<void>;
  getUsage(usageDate: string): Promise<MaterialAliasUsage>;
  incrementUsage(usageDate: string, calls: number, cost: number): Promise<void>;
  listBacklog(location: string, limit: number): Promise<MaterialAliasBacklogRow[]>;
  candidatesFor(name: string, location: string, limit: number): Promise<MaterialAliasCandidate[]>;
  /** Whole catalog of a location; the same rows on every call in one request. */
  catalogOptions(location: string): Promise<MaterialAliasCandidate[]>;
  listUnmatched(location: string, days: number): Promise<NewItemUnmatchedRow[]>;
  upsertNewItemSuggestions(location: string, rows: NewItemSuggestionRow[]): Promise<void>;
  getRawCache(key: MaterialAliasCacheKey): Promise<{ answer: Record<string, unknown>; cost: number | null } | null>;
  getRawCacheMany(keys: MaterialAliasCacheKey[]): Promise<Array<{ answer: Record<string, unknown>; cost: number | null } | null>>;
  putRawCache(key: MaterialAliasCacheKey, answer: Record<string, unknown>, cost: number | null): Promise<void>;
  getActiveNewItemRun(location: string): Promise<NewItemRunRow | null>;
  createNewItemRun(location: string, startedBy: string | null): Promise<NewItemRunRow>;
  updateNewItemRun(runId: string, patch: Partial<NewItemRunRow> & { finished_at?: string | null }): Promise<void>;
}

export function createMaterialAliasStore(admin: SupabaseClient): MaterialAliasStore {
  // One catalog read per location per store instance (the backlog loop reuses it
  // for every row).
  let catalogCache: { location: string; rows: MaterialAliasCandidate[] } | null = null;
  return {
    async getCache(key) {
      let query = admin
        .from("material_alias_jev_cache")
        .select("answer,cost")
        .eq("normalized_name", key.normalizedName)
        .eq("location", key.location)
        .eq("prompt_version", key.promptVersion)
        .eq("candidates_hash", key.candidatesHash)
        .order("created_at", { ascending: false })
        .limit(1);
      query = key.supplierId === null ? query.is("supplier_id", null) : query.eq("supplier_id", key.supplierId);
      const { data, error } = await query.maybeSingle();
      if (error) fail();
      if (!data) return null;
      const row = data as unknown as { answer: unknown; cost: number | null };
      const answer = mapCachedAnswer(row.answer);
      if (!answer) return null;
      return { answer, cost: row.cost === null || row.cost === undefined ? null : asNumber(row.cost) };
    },

    async getCacheMany(keys) {
      if (keys.length === 0) return [];
      const hashes = [...new Set(keys.map((key) => key.candidatesHash))];
      const locations = [...new Set(keys.map((key) => key.location))];
      const { data, error } = await admin
        .from("material_alias_jev_cache")
        .select("answer,cost,normalized_name,location,prompt_version,candidates_hash,supplier_id,created_at")
        .in("candidates_hash", hashes)
        .in("location", locations)
        .order("created_at", { ascending: false });
      if (error) fail();
      const byKey = new Map<string, Record<string, unknown>>();
      for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
        const key = cacheRowKey(row as never);
        if (!byKey.has(key)) byKey.set(key, row);
      }
      return keys.map((key) => {
        const row = byKey.get(cacheKeyString(key));
        if (!row) return null;
        const answer = mapCachedAnswer(row.answer);
        if (!answer) return null;
        return {
          answer,
          cost: row.cost === null || row.cost === undefined ? null : asNumber(row.cost),
        };
      });
    },

    async putCache(key, answer, cost) {
      const { error } = await admin.from("material_alias_jev_cache").insert({
        supplier_id: key.supplierId,
        normalized_name: key.normalizedName,
        location: key.location,
        prompt_version: key.promptVersion,
        candidates_hash: key.candidatesHash,
        answer,
        cost,
      });
      // A concurrent writer may win the unique key: keep the first answer.
      if (error && (error as { code?: string }).code !== "23505") fail();
    },

    async getUsage(usageDate) {
      const { data, error } = await admin
        .from("stock_catalog_jev_usage")
        .select("usage_date,calls,cost,call_limit")
        .eq("usage_date", usageDate)
        .maybeSingle();
      if (error) fail();
      if (!data) return { usage_date: usageDate, calls: 0, cost: 0, call_limit: MATERIAL_ALIAS_DAILY_CALL_LIMIT };
      const row = data as unknown as { usage_date: string; calls: number; cost: number; call_limit: number };
      return {
        usage_date: row.usage_date,
        calls: asNumber(row.calls),
        cost: asNumber(row.cost),
        call_limit: asNumber(row.call_limit) || MATERIAL_ALIAS_DAILY_CALL_LIMIT,
      };
    },

    async incrementUsage(usageDate, calls, cost) {
      const { error } = await admin.rpc("increment_stock_catalog_jev_usage", {
        p_date: usageDate,
        p_calls: calls,
        p_cost: cost,
      });
      if (error) fail();
    },

    async listBacklog(location, limit) {
      const { data, error } = await admin.rpc("get_material_alias_backlog", {
        p_location: location,
        p_limit: limit,
      });
      if (error) fail();
      return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
        supplier_id: asNullableString(row.supplier_id),
        normalized_name: String(row.normalized_name ?? ""),
        raw_name: String(row.raw_name ?? ""),
        raw_unit: asNullableString(row.raw_unit),
        location: String(row.location ?? location),
      })).filter((row) => row.normalized_name !== "" && row.raw_name !== "");
    },

    async candidatesFor(name, location, limit) {
      const { data, error } = await admin.rpc("material_alias_candidates", {
        p_name: name,
        p_location: location,
        p_limit: limit,
      });
      if (error) fail();
      return ((data ?? []) as unknown as Record<string, unknown>[])
        .map(mapCandidate)
        .filter((candidate) => candidate.id !== "");
    },

    async catalogOptions(location) {
      if (catalogCache && catalogCache.location === location) return catalogCache.rows;
      const { data, error } = await admin.rpc("material_alias_catalog_options", {
        p_location: location,
      });
      if (error) fail();
      const rows = ((data ?? []) as unknown as Record<string, unknown>[])
        .map(mapCandidate)
        .filter((candidate) => candidate.id !== "");
      catalogCache = { location, rows };
      return rows;
    },

    async listUnmatched(location, days) {
      const { data, error } = await admin.rpc("list_unmatched_purchase_names", {
        p_location: location,
        p_days: days,
      });
      if (error) fail();
      return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
        supplier_id: asNullableString(row.supplier_id),
        normalized_name: String(row.normalized_name ?? ""),
        raw_name: String(row.raw_name ?? ""),
        raw_unit: asNullableString(row.raw_unit),
        receipt_count: asNumber(row.receipt_count),
        receipt_days: asNumber(row.receipt_days),
        first_date: asNullableString(row.first_date),
        last_date: asNullableString(row.last_date),
        has_exact_candidate: asBoolean(row.has_exact_candidate),
        cached_match_item_id: asNullableString(row.cached_match_item_id),
        cached_match_line_type: asNullableString(row.cached_match_line_type),
      })).filter((row) => row.normalized_name !== "" && row.raw_name !== "");
    },

    async upsertNewItemSuggestions(location, rows) {
      const { error } = await admin.rpc("upsert_new_item_suggestions", {
        p_location: location,
        p_rows: rows,
      });
      if (error) fail();
    },

    async getRawCache(key) {
      let query = admin
        .from("material_alias_jev_cache")
        .select("answer,cost")
        .eq("normalized_name", key.normalizedName)
        .eq("location", key.location)
        .eq("prompt_version", key.promptVersion)
        .eq("candidates_hash", key.candidatesHash)
        .order("created_at", { ascending: false })
        .limit(1);
      query = key.supplierId === null ? query.is("supplier_id", null) : query.eq("supplier_id", key.supplierId);
      const { data, error } = await query.maybeSingle();
      if (error) fail();
      if (!data) return null;
      const row = data as unknown as { answer: unknown; cost: number | null };
      if (typeof row.answer !== "object" || row.answer === null || Array.isArray(row.answer)) return null;
      return {
        answer: row.answer as Record<string, unknown>,
        cost: row.cost === null || row.cost === undefined ? null : asNumber(row.cost),
      };
    },

    async getRawCacheMany(keys) {
      if (keys.length === 0) return [];
      const hashes = [...new Set(keys.map((key) => key.candidatesHash))];
      const locations = [...new Set(keys.map((key) => key.location))];
      const { data, error } = await admin
        .from("material_alias_jev_cache")
        .select("answer,cost,normalized_name,location,prompt_version,candidates_hash,supplier_id,created_at")
        .in("candidates_hash", hashes)
        .in("location", locations)
        .order("created_at", { ascending: false });
      if (error) fail();
      const byKey = new Map<string, Record<string, unknown>>();
      for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
        const key = cacheRowKey(row as never);
        if (!byKey.has(key)) byKey.set(key, row);
      }
      return keys.map((key) => {
        const row = byKey.get(cacheKeyString(key));
        if (!row || typeof row.answer !== "object" || row.answer === null || Array.isArray(row.answer)) {
          return null;
        }
        return {
          answer: row.answer as Record<string, unknown>,
          cost: row.cost === null || row.cost === undefined ? null : asNumber(row.cost),
        };
      });
    },

    async putRawCache(key, answer, cost) {
      const { error } = await admin.from("material_alias_jev_cache").insert({
        supplier_id: key.supplierId,
        normalized_name: key.normalizedName,
        location: key.location,
        prompt_version: key.promptVersion,
        candidates_hash: key.candidatesHash,
        answer,
        cost,
      });
      if (error && (error as { code?: string }).code !== "23505") fail();
    },

    async getActiveNewItemRun(location) {
      const { data, error } = await admin
        .from("stock_new_item_runs")
        .select("id,location,status,processed,remaining,calls,groups,last_error")
        .eq("location", location)
        .in("status", ["queued", "running", "paused"])
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail();
      return data ? mapNewItemRun(data as unknown as Record<string, unknown>) : null;
    },

    async createNewItemRun(location, startedBy) {
      const { data, error } = await admin
        .from("stock_new_item_runs")
        .insert({ location, status: "running", started_by: startedBy })
        .select("id,location,status,processed,remaining,calls,groups,last_error")
        .maybeSingle();
      if (error) {
        // A concurrent caller won the per-location unique index: join that run.
        if ((error as { code?: string }).code === "23505") {
          const { data: existing, error: existingError } = await admin
            .from("stock_new_item_runs")
            .select("id,location,status,processed,remaining,calls,groups,last_error")
            .eq("location", location)
            .in("status", ["queued", "running", "paused"])
            .order("started_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (!existingError && existing) return mapNewItemRun(existing as unknown as Record<string, unknown>);
        }
        fail();
      }
      return mapNewItemRun(data as unknown as Record<string, unknown>);
    },

    async updateNewItemRun(runId, patch) {
      const { error } = await admin
        .from("stock_new_item_runs")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", runId);
      if (error) fail();
    },
  };
}
