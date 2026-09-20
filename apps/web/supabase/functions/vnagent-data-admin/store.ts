// Supabase-backed store for the VNAgent data-assets admin.
//
// Every read/write runs with the caller's bearer token, so row level security
// (owner-only) is the ultimate authority and no service-role client is used.
// All mutations go through the reviewed SECURITY DEFINER RPCs; there is no
// direct table INSERT/UPDATE grant for authenticated callers.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.90.1";
import {
  DataAdminError,
  type AssetFilterInput,
  type ContributionInput,
  type DataAsset,
  type ExportQuery,
  type TransitionInput,
} from "./data-assets.ts";
import type { AssetListResult, DataAdminStore, InsertResult } from "./handler.ts";

const ASSET_COLUMNS =
  "id,tenant,dataset_stage,source_kind,source_designation,interaction_id,question,source_answer,expected_intent,expected_filters,provenance,snapshot_at,effective_at,evaluation_status,verified_intent,verified_conditions,evidence,reviewer_id,version,dedupe_key,created_by,created_at,updated_at";

const JEV_COLUMNS =
  "id,request_id,model,prompt_version,registry_version,attempted,decided,screen,circuit,metric,metric_probability,period,period_probability,support,support_probability,threshold,fallback,cost,token_counts,stage_timings,counts,decision,created_at";

function fail(code: string, status: number): never {
  throw new DataAdminError(code, status);
}

function nextIsoDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function mapTransitionError(message: string | undefined): never {
  const text = (message ?? "").toLowerCase();
  if (text.includes("version_conflict")) fail("version_conflict", 409);
  if (text.includes("asset_not_found")) fail("asset_not_found", 404);
  if (text.includes("forbidden")) fail("forbidden", 403);
  if (text.includes("gold_") || text.includes("demotion_reason_required")) fail("gold_verification_required", 422);
  if (text.includes("invalid_transition") || text.includes("invalid_stage")) fail("invalid_transition", 409);
  fail("store_unavailable", 503);
}

function mapCreateError(message: string | undefined): never {
  const text = (message ?? "").toLowerCase();
  if (text.includes("forbidden")) fail("forbidden", 403);
  if (text.includes("question_required")) fail("question_required", 400);
  if (text.includes("invalid_source_kind")) fail("invalid_source_kind", 400);
  if (text.includes("invalid_source_designation")) fail("invalid_source_designation", 400);
  if (text.includes("invalid_expected_intent")) fail("invalid_expected_intent", 400);
  if (text.includes("invalid_expected_filters")) fail("invalid_expected_filters", 400);
  fail("store_unavailable", 503);
}

export function createDataAdminStore(db: SupabaseClient): DataAdminStore {
  return {
    async metrics(today, signal) {
      const { data, error } = await db.rpc("vnagent_data_admin_metrics", { p_today: today }).abortSignal(signal);
      if (error) fail("metrics_unavailable", 503);
      return data;
    },

    async timeseries(days, signal) {
      const { data, error } = await db.rpc("vnagent_data_admin_timeseries", { p_days: days }).abortSignal(signal);
      if (error) fail("metrics_unavailable", 503);
      return data;
    },

    async listAssets(filters: AssetFilterInput, signal): Promise<AssetListResult> {
      let query = db
        .from("vnagent_data_assets")
        .select(ASSET_COLUMNS, { count: "exact" })
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true })
        .range(filters.offset, filters.offset + filters.limit - 1);
      if (filters.stage) query = query.eq("dataset_stage", filters.stage);
      if (filters.sourceKind) query = query.eq("source_kind", filters.sourceKind);
      if (filters.evaluationStatus) query = query.eq("evaluation_status", filters.evaluationStatus);
      if (filters.search) {
        const escaped = filters.search.replace(/[%_\\]/g, (character) => `\\${character}`);
        query = query.ilike("question", `%${escaped}%`);
      }
      const { data, error, count } = await query.abortSignal(signal);
      if (error) fail("store_unavailable", 503);
      return { rows: (data ?? []) as unknown as DataAsset[], total: count ?? null };
    },

    async listExportAssets(filters: ExportQuery, signal): Promise<AssetListResult> {
      // Every filter (including the date predicates) is applied in SQL BEFORE the
      // LIMIT, with a deterministic stable sort, so the rows and the total always
      // describe the same filter scope and truncation is accurate.
      let query = db
        .from("vnagent_data_assets")
        .select(ASSET_COLUMNS, { count: "exact" })
        .order("effective_at", { ascending: false })
        .order("id", { ascending: true });
      if (filters.stage) query = query.eq("dataset_stage", filters.stage);
      if (filters.sourceKind) query = query.eq("source_kind", filters.sourceKind);
      if (filters.evaluationStatus) query = query.eq("evaluation_status", filters.evaluationStatus);
      if (filters.assetIds) query = query.in("id", filters.assetIds);
      if (filters.from) query = query.gte("effective_at", `${filters.from}T00:00:00+07:00`);
      if (filters.to) query = query.lt("effective_at", `${nextIsoDay(filters.to)}T00:00:00+07:00`);
      query = query.range(0, filters.limit - 1);
      const { data, error, count } = await query.abortSignal(signal);
      if (error) fail("store_unavailable", 503);
      return { rows: (data ?? []) as unknown as DataAsset[], total: count ?? 0 };
    },

    async getAsset(id, signal): Promise<DataAsset | null> {
      const { data, error } = await db
        .from("vnagent_data_assets")
        .select(ASSET_COLUMNS)
        .eq("id", id)
        .abortSignal(signal)
        .maybeSingle();
      if (error) fail("store_unavailable", 503);
      return (data as unknown as DataAsset) ?? null;
    },

    async createAsset(input: ContributionInput, key: string, signal): Promise<InsertResult> {
      // The RPC re-checks the owner, forces the raw stage/not_evaluated status and
      // derives created_by from auth.uid(); the client never supplies identity.
      const { data, error } = await db
        .rpc("vnagent_create_data_asset", {
          p_question: input.question,
          p_source_kind: input.sourceKind,
          p_source_designation: input.sourceDesignation,
          p_expected_intent: input.expectedIntent,
          p_expected_filters: input.expectedFilters,
          p_provenance: input.provenance,
          p_snapshot_at: input.snapshotAt,
          p_dedupe_key: key,
        })
        .abortSignal(signal);
      if (error) mapCreateError(error.message);
      const body = data as { status?: string; asset?: DataAsset } | null;
      if (!body?.asset) fail("store_unavailable", 503);
      return { status: body.status === "duplicate" ? "duplicate" : "created", asset: body.asset };
    },

    async transitionAsset(input: TransitionInput, signal): Promise<DataAsset> {
      const { data, error } = await db
        .rpc("vnagent_transition_data_asset", {
          p_asset_id: input.assetId,
          p_expected_version: input.expectedVersion,
          p_to_stage: input.toStage,
          p_reason: input.reason,
          p_verified: input.verified,
        })
        .abortSignal(signal);
      if (error) mapTransitionError(error.message);
      const asset = (data as { asset?: DataAsset } | null)?.asset;
      if (!asset) fail("store_unavailable", 503);
      return asset;
    },

    async listJev(limit, signal) {
      const { data, error } = await db
        .from("vnagent_jev_events")
        .select(JEV_COLUMNS)
        .order("created_at", { ascending: false })
        .limit(limit)
        .abortSignal(signal);
      if (error) fail("store_unavailable", 503);
      return data ?? [];
    },
  };
}
