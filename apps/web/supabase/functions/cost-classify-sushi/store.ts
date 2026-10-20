// Service-role data access for Sushi cost classification.
//
// Every read is a fixed SELECT / RPC from the service-role client; the client
// never supplies SQL, table names or filters. The only write is the audited
// RPC robot_apply_cost_classification, which itself enforces the manual
// override / approved guard and the daily cap.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.90.1";
import {
  COST_CLASSIFY_DEFAULT_DAILY_CAP,
  COST_CLASSIFY_DEFAULT_THRESHOLD,
  CostClassifyError,
  type ApplyCostInput,
  type ApplyCostResult,
  type CostCategoryRow,
  type CostSettings,
} from "./handler.ts";
import type {
  CostClassificationCandidate,
  CostFeedbackRow,
} from "./jev.ts";

function fail(): never {
  throw new CostClassifyError("scan_failed", 503);
}

function asNumber(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export interface CostClassifyStore {
  getSettings(): Promise<CostSettings>;
  listCategories(): Promise<CostCategoryRow[]>;
  listCandidates(limit: number): Promise<CostClassificationCandidate[]>;
  getFeedback(subjectKeys: string[]): Promise<CostFeedbackRow[]>;
  apply(input: ApplyCostInput): Promise<ApplyCostResult>;
  getWorkerSecret(): Promise<string | null>;
}

export function createCostClassifyStore(admin: SupabaseClient): CostClassifyStore {
  return {
    async getSettings() {
      const { data, error } = await admin
        .from("robot_settings")
        .select("cost_threshold,cost_daily_cap,cost_auto_enabled")
        .eq("id", true)
        .maybeSingle();
      if (error) fail();
      if (!data) {
        return {
          cost_threshold: COST_CLASSIFY_DEFAULT_THRESHOLD,
          cost_daily_cap: COST_CLASSIFY_DEFAULT_DAILY_CAP,
          cost_auto_enabled: true,
        };
      }
      const row = data as unknown as Record<string, unknown>;
      const threshold = asNullableNumber(row.cost_threshold);
      return {
        cost_threshold: threshold === null ? COST_CLASSIFY_DEFAULT_THRESHOLD : threshold,
        cost_daily_cap: row.cost_daily_cap === null || row.cost_daily_cap === undefined
          ? COST_CLASSIFY_DEFAULT_DAILY_CAP
          : asNumber(row.cost_daily_cap),
        cost_auto_enabled: typeof row.cost_auto_enabled === "boolean" ? row.cost_auto_enabled : true,
      };
    },

    async listCategories() {
      const { data, error } = await admin
        .from("cost_categories")
        .select("code,label,is_active,sort_order")
        .eq("is_active", true)
        .neq("code", "UNMAPPED_REVIEW")
        .order("sort_order", { ascending: true })
        .order("code", { ascending: true });
      if (error) fail();
      return ((data ?? []) as unknown as Record<string, unknown>[])
        .map((row) => ({
          code: asString(row.code),
          label: asString(row.label),
          is_active: typeof row.is_active === "boolean" ? row.is_active : true,
          sort_order: asNumber(row.sort_order),
        }))
        .filter((row) => row.code !== "" && row.label !== "");
    },

    async listCandidates(limit) {
      const { data, error } = await admin.rpc("cost_classify_sushi_candidates", { p_limit: limit });
      if (error) fail();
      return ((data ?? []) as unknown as Record<string, unknown>[])
        .map((row) => ({
          source_type: asString(row.source_type),
          source_line_id: asString(row.source_line_id),
          supplier_id: asNullableString(row.supplier_id),
          supplier_name: asNullableString(row.supplier_name),
          product_name: asString(row.product_name),
          product_code: asNullableString(row.product_code),
          unit: asNullableString(row.unit),
          quantity: asNullableNumber(row.quantity),
          unit_price: asNullableNumber(row.unit_price),
          line_amount: asNullableNumber(row.line_amount),
          document_date: asNullableString(row.document_date),
          note: asNullableString(row.note),
          subject_key: asNullableString(row.subject_key),
        }))
        .filter((row) => row.source_line_id !== "" && row.product_name !== "");
    },

    async getFeedback(subjectKeys) {
      const keys = [...new Set((subjectKeys ?? []).filter((key) => typeof key === "string" && key !== ""))];
      if (keys.length === 0) return [];
      const { data, error } = await admin.rpc("cost_classify_sushi_feedback", { p_subject_keys: keys });
      if (error) fail();
      return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
        id: asNullableString(row.id) ?? undefined,
        kind: asNullableString(row.kind) ?? undefined,
        subject_key: asString(row.subject_key),
        robot_choice: asNullableString(row.robot_choice),
        human_choice: asNullableString(row.human_choice),
        robot_probability: asNullableNumber(row.robot_probability),
        note: asNullableString(row.note),
        created_at: asNullableString(row.created_at),
      }));
    },

    async apply(input) {
      const { data, error } = await admin.rpc("robot_apply_cost_classification", {
        p_source_type: input.source_type,
        p_source_line_id: input.source_line_id,
        p_category_code: input.category_code,
        p_probability: input.probability,
        p_note: input.note,
      });
      if (error) fail();
      const row = (data ?? {}) as Record<string, unknown>;
      return {
        status: asString(row.status),
        reason: asNullableString(row.reason) ?? undefined,
        classification_id: asNullableString(row.classification_id) ?? undefined,
        action_id: asNullableString(row.action_id) ?? undefined,
        category_code: asNullableString(row.category_code) ?? undefined,
        review_status: asNullableString(row.review_status) ?? undefined,
      };
    },

    async getWorkerSecret() {
      const { data, error } = await admin
        .from("robot_worker_config")
        .select("worker_secret")
        .eq("id", "sushi-cost")
        .maybeSingle();
      if (error) fail();
      if (!data) return null;
      return asNullableString((data as unknown as Record<string, unknown>).worker_secret);
    },
  };
}
