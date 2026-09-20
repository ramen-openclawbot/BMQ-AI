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
import type { AssetListResult, DataAdminStore, GenerationFinishInput, GenerationJob, GenerationStartInput, InsertResult } from "./handler.ts";

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

function mapGenerationStartError(message: string | undefined): never {
  const text = (message ?? "").toLowerCase();
  if (text.includes("forbidden")) fail("forbidden", 403);
  if (text.includes("idempotency_conflict")) fail("generation_idempotency_conflict", 409);
  if (text.includes("generation_busy")) fail("generation_busy", 409);
  if (text.includes("budget_exceeded")) fail("generation_budget_exceeded", 400);
  if (text.includes("invalid_idempotency_key")) fail("generation_invalid_idempotency_key", 400);
  if (text.includes("invalid_seeds")) fail("generation_invalid_seeds", 400);
  if (text.includes("invalid_budget")) fail("generation_invalid_budget", 400);
  if (text.includes("invalid_request")) fail("generation_invalid_request", 400);
  fail("store_unavailable", 503);
}

function mapGenerationFinishError(message: string | undefined): never {
  const text = (message ?? "").toLowerCase();
  if (text.includes("forbidden")) fail("forbidden", 403);
  if (text.includes("job_not_found")) fail("generation_job_not_found", 404);
  if (text.includes("job_finished")) fail("generation_job_finished", 409);
  if (text.includes("version_conflict")) fail("generation_version_conflict", 409);
  if (text.includes("invalid_status") || text.includes("invalid_summary") || text.includes("invalid_cost")) fail("generation_invalid_request", 400);
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

    async generationStart(input: GenerationStartInput, signal): Promise<{ job: GenerationJob; resumed: boolean; abandoned: boolean }> {
      // The RPC re-checks the owner, serializes starts per owner, stores the real
      // request fingerprint, rejects a same-key retry with a different contract,
      // enforces one running job per owner, derives created_by from auth.uid() and
      // is idempotent on the idempotency key.
      const { data, error } = await db
        .rpc("vnagent_generation_job_start", {
          p_request: input.request,
          p_idempotency_key: input.idempotencyKey,
          p_request_fingerprint: input.requestFingerprint,
          p_model: input.model,
          p_prompt_version: input.promptVersion,
          p_seed_ids: input.seedIds,
          p_budget_usd: input.budgetUsd,
          p_worst_case_cost_usd: input.worstCaseCostUsd,
        })
        .abortSignal(signal);
      if (error) mapGenerationStartError(error.message);
      const body = data as { job?: GenerationJob; resumed?: boolean; abandoned?: boolean } | null;
      if (!body?.job) fail("store_unavailable", 503);
      return { job: body.job, resumed: body.resumed === true, abandoned: body.abandoned === true };
    },

    async generationFinish(input: GenerationFinishInput, signal): Promise<GenerationJob> {
      const { data, error } = await db
        .rpc("vnagent_generation_job_finish", {
          p_job_id: input.jobId,
          p_expected_version: input.expectedVersion,
          p_status: input.status,
          p_result_summary: input.summary,
          p_actual_cost_usd: input.actualCostUsd,
          p_error_code: input.errorCode,
        })
        .abortSignal(signal);
      if (error) mapGenerationFinishError(error.message);
      const job = (data as { job?: GenerationJob } | null)?.job;
      if (!job) fail("store_unavailable", 503);
      return job;
    },

    async generationGet(jobId: string | null, idempotencyKey: string | null, signal): Promise<{ job: GenerationJob | null; jobs: GenerationJob[]; abandoned?: boolean }> {
      // `p_idempotency_key` is an exact-key lookup, so recovery never depends on a
      // bounded recent-jobs list missing the pending job. `abandoned` is the
      // server-evaluated expired-lease outcome (never the browser clock).
      const { data, error } = await db
        .rpc("vnagent_generation_job_get", { p_job_id: jobId, p_idempotency_key: idempotencyKey, p_limit: 10 })
        .abortSignal(signal);
      if (error) fail("store_unavailable", 503);
      const body = data as { job?: GenerationJob | null; jobs?: GenerationJob[]; abandoned?: boolean } | null;
      return { job: body?.job ?? null, jobs: Array.isArray(body?.jobs) ? body!.jobs! : [], abandoned: body?.abandoned === true };
    },
  };
}
