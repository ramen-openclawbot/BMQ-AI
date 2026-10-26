// Service-role data access for the whole payment request stock label (Jev).
//
// Every read is a fixed SELECT / RPC from the service-role client; the client
// never supplies SQL, table names or filters. The only write is the audited RPC
// apply_payment_request_stock_label_jev, which itself enforces the manual-label
// guard, the enabled switch and the confidence threshold.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.90.1";
import {
  STOCK_LABEL_DEFAULT_DAILY_LIMIT,
  STOCK_LABEL_DEFAULT_MIN_CONFIDENCE,
  StockLabelError,
  type ApplyStockLabelInput,
  type ApplyStockLabelResult,
  type StockLabelSettings,
} from "./handler.ts";
import type {
  StockLabelCandidate,
  StockLabelClass,
  StockLabelExample,
} from "./jev.ts";

function fail(): never {
  throw new StockLabelError("scan_failed", 503);
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

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item !== "")
    : [];
}

function asExamples(value: unknown): StockLabelExample[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .slice(0, 5)
    .map((item) => ({
      title: asString(item.title),
      description: asNullableString(item.description),
      requires_receipt: item.requires_receipt === true,
      item_names: asStringArray(item.item_names),
    }));
}

/** Start of the current Vietnam calendar day, as an ISO instant (UTC). */
export function startOfVietnamDay(now: Date): Date {
  const offsetMs = 7 * 60 * 60 * 1000;
  const vn = new Date(now.getTime() + offsetMs);
  return new Date(
    Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - offsetMs,
  );
}

export interface StockLabelStore {
  getSettings(): Promise<StockLabelSettings>;
  countToday(): Promise<number>;
  listCandidates(limit: number): Promise<StockLabelCandidate[]>;
  apply(input: ApplyStockLabelInput): Promise<ApplyStockLabelResult>;
  getWorkerSecret(): Promise<string | null>;
}

export function createStockLabelStore(admin: SupabaseClient): StockLabelStore {
  return {
    async getSettings() {
      const { data, error } = await admin
        .from("payment_stock_label_jev_settings")
        .select("enabled,min_confidence,daily_limit")
        .eq("id", true)
        .maybeSingle();
      if (error) fail();
      if (!data) {
        return {
          enabled: false,
          min_confidence: STOCK_LABEL_DEFAULT_MIN_CONFIDENCE,
          daily_limit: STOCK_LABEL_DEFAULT_DAILY_LIMIT,
        };
      }
      const row = data as unknown as Record<string, unknown>;
      const threshold = asNullableNumber(row.min_confidence);
      return {
        enabled: row.enabled === true,
        min_confidence: threshold === null ? STOCK_LABEL_DEFAULT_MIN_CONFIDENCE : threshold,
        daily_limit: row.daily_limit === null || row.daily_limit === undefined
          ? STOCK_LABEL_DEFAULT_DAILY_LIMIT
          : asNumber(row.daily_limit),
      };
    },

    async countToday() {
      const start = startOfVietnamDay(new Date()).toISOString();
      const { count, error } = await admin
        .from("payment_stock_label_jev_runs")
        .select("id", { count: "exact", head: true })
        .gte("created_at", start)
        .or("skipped_reason.is.null,skipped_reason.neq.human_override");
      if (error) fail();
      return count ?? 0;
    },

    async listCandidates(limit) {
      const { data, error } = await admin.rpc("list_payment_requests_for_stock_label", {
        p_limit: limit,
      });
      if (error) fail();
      return ((data ?? []) as unknown as Record<string, unknown>[])
        .map((row) => ({
          request_id: asString(row.request_id),
          supplier_id: asNullableString(row.supplier_id),
          supplier_name: asNullableString(row.supplier_name),
          title: asNullableString(row.title),
          description: asNullableString(row.description),
          total_amount: asNullableNumber(row.total_amount),
          vat_amount: asNullableNumber(row.vat_amount),
          item_names: asStringArray(row.item_names),
          manual_examples: asExamples(row.manual_examples),
        }))
        .filter((row) => row.request_id !== "");
    },

    async apply(input) {
      const { data, error } = await admin.rpc("apply_payment_request_stock_label_jev", {
        p_request_id: input.request_id,
        p_class: input.class,
        p_confidence: input.confidence,
        p_reason: input.reason,
        p_model: input.model,
      });
      if (error) fail();
      const row = (data ?? {}) as Record<string, unknown>;
      const labelClass = row.class === "stock" || row.class === "non_stock"
        ? (row.class as StockLabelClass)
        : undefined;
      return {
        status: asString(row.status),
        reason: asNullableString(row.reason) ?? undefined,
        applied: row.applied === true,
        requires_receipt: typeof row.requires_receipt === "boolean" ? row.requires_receipt : null,
        no_receipt_reason: asNullableString(row.no_receipt_reason),
        class: labelClass,
      };
    },

    async getWorkerSecret() {
      const { data, error } = await admin
        .from("robot_worker_config")
        .select("worker_secret")
        .eq("id", "payment-stock-label-jev")
        .maybeSingle();
      if (error) fail();
      if (!data) return null;
      return asNullableString((data as unknown as Record<string, unknown>).worker_secret);
    },
  };
}
