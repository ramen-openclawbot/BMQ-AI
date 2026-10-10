import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import {
  parseQ7AutoPurchaseStatus,
  parseQ7PurchaseForecast,
  type Q7AutoPurchaseStatus,
  type Q7PurchaseForecast,
  type Q7PurchaseMode,
} from "@/lib/purchase-forecast";

export const Q7_PURCHASE_FORECAST_QUERY_KEY = "q7-purchase-forecast";
export const Q7_AUTO_PURCHASE_STATUS_QUERY_KEY = "q7-auto-purchase-status";

/** Read the simulated forecast for a run day (defaults to today on the server). */
export function useQ7PurchaseForecast(asOf?: string | null, horizonDays = 14) {
  return useQuery({
    queryKey: [Q7_PURCHASE_FORECAST_QUERY_KEY, asOf ?? null, horizonDays],
    queryFn: async (): Promise<Q7PurchaseForecast> => {
      const { data, error } = await supabase.rpc("get_q7_purchase_forecast", {
        p_as_of: asOf ?? null,
        p_horizon_days: horizonDays,
      });
      if (error) throw error;
      return parseQ7PurchaseForecast(data);
    },
  });
}

/** Settings, the latest run and the 30 most recent decisions. */
export function useQ7AutoPurchaseStatus() {
  return useQuery({
    queryKey: [Q7_AUTO_PURCHASE_STATUS_QUERY_KEY],
    queryFn: async (): Promise<Q7AutoPurchaseStatus> => {
      const { data, error } = await supabase.rpc("get_q7_auto_purchase_status");
      if (error) throw error;
      return parseQ7AutoPurchaseStatus(data);
    },
    staleTime: 30_000,
  });
}

export interface UpsertQ7PurchaseItemSettingInput {
  kitchenInventoryItemId: string;
  mode: Q7PurchaseMode;
  supplierId?: string | null;
  packSize?: number | null;
  packLabel?: string | null;
  leadTimeDays?: number | null;
  safetyDays?: number | null;
  orderCycleDays?: number | null;
  maxOrderQty?: number | null;
}

/** Create or update one item's purchasing preference. */
export function useUpsertQ7PurchaseItemSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpsertQ7PurchaseItemSettingInput): Promise<unknown> => {
      const { data, error } = await supabase.rpc("upsert_q7_purchase_item_setting", {
        p_kitchen_inventory_item_id: input.kitchenInventoryItemId,
        p_mode: input.mode,
        p_supplier_id: input.supplierId ?? null,
        p_pack_size: input.packSize ?? null,
        p_pack_label: input.packLabel ?? null,
        p_lead_time_days: input.leadTimeDays ?? null,
        p_safety_days: input.safetyDays ?? null,
        p_order_cycle_days: input.orderCycleDays ?? null,
        p_max_order_qty: input.maxOrderQty ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [Q7_PURCHASE_FORECAST_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [Q7_AUTO_PURCHASE_STATUS_QUERY_KEY] });
    },
  });
}

export interface UpdateQ7AutoPurchaseSettingsInput {
  enabled?: boolean | null;
  systemActorId?: string | null;
  maxPoAmount?: number | null;
  maxDailyAmount?: number | null;
  maxStockCountAgeDays?: number | null;
  maxBacktestError?: number | null;
  runHourVn?: number | null;
}

/** Owner-only update of the global switch and safety limits. */
export function useUpdateQ7AutoPurchaseSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateQ7AutoPurchaseSettingsInput): Promise<unknown> => {
      const { data, error } = await supabase.rpc("update_q7_auto_purchase_settings", {
        p_enabled: input.enabled ?? null,
        p_system_actor_id: input.systemActorId ?? null,
        p_max_po_amount: input.maxPoAmount ?? null,
        p_max_daily_amount: input.maxDailyAmount ?? null,
        p_max_stock_count_age_days: input.maxStockCountAgeDays ?? null,
        p_max_backtest_error: input.maxBacktestError ?? null,
        p_run_hour_vn: input.runHourVn ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [Q7_AUTO_PURCHASE_STATUS_QUERY_KEY] });
    },
  });
}

/** Owner-only manual trigger; still idempotent per calendar day. */
export function useRunQ7AutoPurchaseNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<unknown> => {
      const { data, error } = await supabase.rpc("run_q7_auto_purchase_now");
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [Q7_PURCHASE_FORECAST_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [Q7_AUTO_PURCHASE_STATUS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
  });
}

export interface CreateQ7DraftPurchaseOrderLine {
  itemId: string;
  supplierId?: string | null;
  productName: string;
  quantity: number;
  unit?: string | null;
  unitPrice?: number | null;
  packSize?: number | null;
  packLabel?: string | null;
}

export interface CreateQ7DraftPurchaseOrdersInput {
  lines: CreateQ7DraftPurchaseOrderLine[];
  idempotencyKey: string;
}

/** Manual "create drafts from the suggestions" action; replays by key. */
export function useCreateQ7DraftPurchaseOrders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateQ7DraftPurchaseOrdersInput): Promise<unknown> => {
      const { data, error } = await supabase.rpc("create_q7_draft_purchase_orders", {
        // The RPC reads snake_case keys; quantities go out in packs when a pack size is known.
        p_lines: input.lines.map((line) => {
          const pack = line.packSize && line.packSize > 0 ? line.packSize : null;
          return {
            supplier_id: line.supplierId ?? null,
            product_name: line.productName,
            quantity: pack ? Math.round((line.quantity / pack) * 1000) / 1000 : line.quantity,
            unit: pack ? line.packLabel ?? line.unit ?? null : line.unit ?? null,
            unit_price:
              line.unitPrice === null || line.unitPrice === undefined
                ? null
                : pack
                  ? Math.round(line.unitPrice * pack * 100) / 100
                  : line.unitPrice,
          };
        }) as unknown as Json,
        p_idempotency_key: input.idempotencyKey,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [Q7_PURCHASE_FORECAST_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [Q7_AUTO_PURCHASE_STATUS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
  });
}
