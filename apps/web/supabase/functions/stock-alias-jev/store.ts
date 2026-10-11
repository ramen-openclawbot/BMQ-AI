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
} from "./handler.ts";
import { NONE_OPTION, type MaterialAliasCandidate } from "./jev.ts";

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

function mapCandidate(row: Record<string, unknown>): MaterialAliasCandidate {
  const itemId = asNullableString(row.item_id);
  const skuId = asNullableString(row.sku_id);
  return {
    id: itemId ?? skuId ?? "",
    name: String(row.name ?? ""),
    unit: String(row.unit ?? ""),
  };
}

function mapCachedAnswer(raw: unknown): CachedJevAnswer | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const choice = record.choice === null || record.choice === undefined ? null : String(record.choice);
  if (choice !== null && choice === NONE_OPTION) return { choice: null, item_id: null, probability: 0, confidence: null, pack: null };
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
    confidence: record.confidence === null || record.confidence === undefined ? null : asNumber(record.confidence),
    pack: parsePack(record.pack),
  };
}

export interface MaterialAliasStore {
  getCache(key: MaterialAliasCacheKey): Promise<{ answer: CachedJevAnswer; cost: number | null } | null>;
  putCache(key: MaterialAliasCacheKey, answer: CachedJevAnswer, cost: number | null): Promise<void>;
  getUsage(usageDate: string): Promise<MaterialAliasUsage>;
  recordUsage(usage: MaterialAliasUsage): Promise<void>;
  listBacklog(location: string, limit: number): Promise<MaterialAliasBacklogRow[]>;
  candidatesFor(name: string, location: string, limit: number): Promise<MaterialAliasCandidate[]>;
}

export function createMaterialAliasStore(admin: SupabaseClient): MaterialAliasStore {
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

    async recordUsage(usage) {
      const { error } = await admin
        .from("stock_catalog_jev_usage")
        .upsert(usage, { onConflict: "usage_date" });
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
  };
}
