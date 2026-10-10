import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseStockLedgerOverview,
  type StockLedgerLocation,
  type StockLedgerOverview,
} from "@/lib/stock-ledger";

export const STOCK_LEDGER_OVERVIEW_QUERY_KEY = "stock-ledger-overview";

/** Read the aggregated stock ledger for one location. */
export function useStockLedgerOverview(
  location: StockLedgerLocation,
  asOf?: string | null,
) {
  return useQuery({
    queryKey: [STOCK_LEDGER_OVERVIEW_QUERY_KEY, location, asOf ?? null],
    queryFn: async (): Promise<StockLedgerOverview> => {
      const { data, error } = await supabase.rpc("get_stock_ledger_overview", {
        p_location: location,
        p_as_of: asOf ?? null,
      });
      if (error) throw error;
      return parseStockLedgerOverview(data);
    },
    enabled: Boolean(location),
  });
}

export interface ResolveStockAliasInput {
  goodsReceiptItemId: string;
  location: StockLedgerLocation;
  kitchenInventoryItemId?: string | null;
  tanTaoSkuId?: string | null;
  conversionFactor: number;
  applyToSupplier?: boolean;
}

/**
 * Assign a material name alias once; the server replays the alias over every
 * matching unposted receipt line and returns the number of ledger rows written.
 */
export function useResolveStockAlias() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ResolveStockAliasInput): Promise<number> => {
      const { data, error } = await supabase.rpc("resolve_stock_alias", {
        p_goods_receipt_item_id: input.goodsReceiptItemId,
        p_location: input.location,
        p_kitchen_inventory_item_id: input.kitchenInventoryItemId ?? null,
        p_tan_tao_sku_id: input.tanTaoSkuId ?? null,
        p_conversion_factor: input.conversionFactor,
        p_apply_to_supplier: input.applyToSupplier ?? true,
      });
      if (error) throw error;
      return Number(data ?? 0);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [STOCK_LEDGER_OVERVIEW_QUERY_KEY],
      });
    },
  });
}

export interface RecordStockCountInput {
  kitchenInventoryItemId: string;
  countedQty: number;
  countDate: string;
  note?: string | null;
  idempotencyKey: string;
}

/** Weekly Q7 physical count; writes the difference as an adjustment. */
export function useRecordStockCount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RecordStockCountInput): Promise<Record<string, unknown>> => {
      const { data, error } = await supabase.rpc("record_q7_stock_count", {
        p_kitchen_inventory_item_id: input.kitchenInventoryItemId,
        p_counted_qty: input.countedQty,
        p_count_date: input.countDate,
        p_note: input.note ?? null,
        p_idempotency_key: input.idempotencyKey,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [STOCK_LEDGER_OVERVIEW_QUERY_KEY],
      });
    },
  });
}

export interface SetSupplierReceivingLocationInput {
  supplierId: string;
  location: StockLedgerLocation | null;
}

/** Default receiving location copied onto new goods receipts. */
export function useSetSupplierReceivingLocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      input: SetSupplierReceivingLocationInput,
    ): Promise<Record<string, unknown>> => {
      const { data, error } = await supabase.rpc("set_supplier_receiving_location", {
        p_supplier_id: input.supplierId,
        p_location: input.location,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [STOCK_LEDGER_OVERVIEW_QUERY_KEY],
      });
    },
  });
}

export interface SetReceiptLocationInput {
  receiptId: string;
  location: StockLedgerLocation;
  rememberForSupplier?: boolean;
}

/** Receiving warehouse for one goods receipt; also saved as the supplier default. */
export function useSetGoodsReceiptReceivingLocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SetReceiptLocationInput): Promise<Record<string, unknown>> => {
      const { data, error } = await supabase.rpc("set_goods_receipt_receiving_location", {
        p_receipt_id: input.receiptId,
        p_location: input.location,
        p_remember_for_supplier: input.rememberForSupplier ?? true,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["goods-receipts"] });
      void queryClient.invalidateQueries({ queryKey: [STOCK_LEDGER_OVERVIEW_QUERY_KEY] });
    },
  });
}

export interface RecordTanTaoCountInput {
  skuCode: string;
  countedQty: number;
  note?: string | null;
  idempotencyKey: string;
}

/** Tân Tạo physical count through the existing warehouse RPC. */
export function useRecordTanTaoStockCount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RecordTanTaoCountInput): Promise<unknown> => {
      const { data, error } = await (supabase as any).rpc("record_tan_tao_stock_count", {
        p_sku_code: input.skuCode,
        p_count: input.countedQty,
        p_reason: input.note?.trim() || "Kiểm kê tuần",
        p_idempotency_key: input.idempotencyKey,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [STOCK_LEDGER_OVERVIEW_QUERY_KEY] });
    },
  });
}
