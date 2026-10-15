import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { parseReceiptLines, type ReceiptLine } from "@/lib/receipt-lines";
import {
  parseChangeStockItemUnitResult,
  parseManualTransferResult,
  parseRenameStockItemResult,
  parseSetItemPastryQ7Result,
  parseWarehouseGameSnapshot,
  parseWarehouseGameTransfers,
  type ChangeStockItemUnitResult,
  type ManualStockTransferResult,
  type Q7FinishedGoodsLine,
  type Q7FinishedGoodsPlannedLine,
  type Q7FinishedGoodsSlipResult,
  type RenameStockItemResult,
  type SetItemPastryQ7Result,
  type WarehouseGameLocation,
  type WarehouseGameSnapshot,
  type WarehouseGameTransfer,
} from "@/lib/warehouse-game";
import {
  MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY,
  MATERIAL_ALIAS_NEW_ITEM_QUERY_KEY,
  MATERIAL_ALIAS_NEW_ITEM_RUN_QUERY_KEY,
  MATERIAL_ALIAS_REVIEW_QUERY_KEY,
  STOCK_UNITS_QUERY_KEY,
  UNKNOWN_PURCHASE_UNITS_QUERY_KEY,
} from "./useMaterialAlias";
import { STOCK_CATALOG_REVIEW_QUERY_KEY } from "./useStockCatalog";

export const WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY = "warehouse-game-snapshot";

/** Both RPCs change the item name / unit, alias factors and the ledger view. */
function invalidateWarehouseGame(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_REVIEW_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_NEW_ITEM_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_NEW_ITEM_RUN_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [STOCK_CATALOG_REVIEW_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [STOCK_UNITS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [UNKNOWN_PURCHASE_UNITS_QUERY_KEY] });
}

/** One call for the whole warehouse view of a location. */
export function useWarehouseGameSnapshot(location: WarehouseGameLocation) {
  return useQuery({
    queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY, location],
    queryFn: async (): Promise<WarehouseGameSnapshot> => {
      const { data, error } = await supabase.rpc("get_warehouse_game_snapshot", {
        p_location: location,
      });
      if (error) throw error;
      return parseWarehouseGameSnapshot(data);
    },
  });
}

export interface RenameStockItemInput {
  itemId: string;
  newName: string;
  requestId: string;
}

/** Rename one live item; idempotent by requestId. */
export function useRenameStockItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RenameStockItemInput): Promise<RenameStockItemResult> => {
      const { data, error } = await supabase.rpc("rename_stock_item", {
        p_item_id: input.itemId,
        p_new_name: input.newName,
        p_request_id: input.requestId,
      });
      if (error) throw error;
      return parseRenameStockItemResult(data);
    },
    onSuccess: () => invalidateWarehouseGame(queryClient),
  });
}

export interface ChangeStockItemUnitInput {
  itemId: string;
  newUnit: string;
  /** 1 old unit = factor new units; required for a pack / count change. */
  factor?: number | null;
  requestId: string;
}

/** Move one item to another standard unit; idempotent by requestId. */
export function useChangeStockItemUnit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ChangeStockItemUnitInput): Promise<ChangeStockItemUnitResult> => {
      const { data, error } = await supabase.rpc("change_stock_item_unit", {
        p_item_id: input.itemId,
        p_new_unit: input.newUnit,
        p_factor: input.factor ?? null,
        p_request_id: input.requestId,
      });
      if (error) throw error;
      return parseChangeStockItemUnitResult(data);
    },
    onSuccess: () => invalidateWarehouseGame(queryClient),
  });
}

export interface SetItemPastryQ7Input {
  itemId: string;
  value: boolean;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Flag / unflag one item as pastry; idempotent by requestId. */
export function useSetItemPastryQ7() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetItemPastryQ7Input): Promise<SetItemPastryQ7Result> => {
      const { data, error } = await supabase.rpc("set_item_pastry_q7", {
        p_item_id: input.itemId,
        p_value: input.value,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return parseSetItemPastryQ7Result(data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
    },
  });
}

export type StockItemClass = "raw_material" | "packaging_supply" | "finished_goods" | "non_stock";

/** Set / change an item's group by hand (owner 16/10); supersedes any pending Bé Mì classify suggestion. */
export function useSetStockItemClass() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { itemId: string; itemClass: StockItemClass }) => {
      const { data, error } = await supabase.rpc("set_stock_item_class", { p_item_id: input.itemId, p_class: input.itemClass });
      if (error) throw error;
      return data as { item_id: string; old_class: string | null; item_class: StockItemClass };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [STOCK_CATALOG_REVIEW_QUERY_KEY] });
    },
  });
}

/** Set the group of many shelf items at once; all-or-nothing on the server (owner 16/10). */
export function useSetStockItemsClass() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { itemIds: string[]; itemClass: StockItemClass }) => {
      const { data, error } = await supabase.rpc("set_stock_items_class", { p_item_ids: input.itemIds, p_class: input.itemClass });
      if (error) throw error;
      return data as { updated: number; item_class: StockItemClass };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [STOCK_CATALOG_REVIEW_QUERY_KEY] });
    },
  });
}

export const STOCK_TRANSFERS_QUERY_KEY = "stock-transfers";

/** The newest Tân Tạo -> Q7 transfers for the warehouse game. */
export function useStockTransfers(limit = 30) {
  return useQuery({
    queryKey: [STOCK_TRANSFERS_QUERY_KEY, limit],
    queryFn: async (): Promise<WarehouseGameTransfer[]> => {
      const { data, error } = await supabase.rpc("get_stock_transfers", { p_limit: limit });
      if (error) throw error;
      return parseWarehouseGameTransfers(data);
    },
  });
}

export interface ManualStockTransferLineInput {
  itemId: string;
  quantity: number;
}

export interface ManualStockTransferInput {
  lines: ManualStockTransferLineInput[];
  note?: string | null;
  /** Idempotency key; defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
  /** Defaults to the server's Vietnam today when null / omitted. */
  transferDate?: string | null;
}

/** Create one manual Tân Tạo -> Q7 transfer slip; idempotent by requestId. */
export function useCreateManualTransfer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ManualStockTransferInput): Promise<ManualStockTransferResult> => {
      const { data, error } = await supabase.rpc(
        "create_manual_stock_transfer" as never,
        {
          p_lines: input.lines.map((line) => ({
            item_id: line.itemId,
            quantity: line.quantity,
          })),
          p_note: input.note ?? null,
          p_request_id: input.requestId ?? crypto.randomUUID(),
          p_transfer_date: input.transferDate ?? null,
        } as never,
      );
      if (error) throw error;
      return parseManualTransferResult(data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [STOCK_TRANSFERS_QUERY_KEY] });
    },
  });
}

export const Q7_FINISHED_GOODS_PLANNED_QUERY_KEY = "q7-finished-goods-planned";

/** The Q7 finished-goods plan lines for one date (defaults to the Vietnam today). */
export function useQ7FinishedGoodsPlanned(date: string) {
  return useQuery({
    queryKey: [Q7_FINISHED_GOODS_PLANNED_QUERY_KEY, date],
    queryFn: async (): Promise<Q7FinishedGoodsPlannedLine[]> => {
      const { data, error } = await supabase.rpc(
        "get_q7_finished_goods_planned" as never,
        { p_date: date } as never,
      );
      if (error) throw error;
      return (data ?? []) as Q7FinishedGoodsPlannedLine[];
    },
  });
}

export interface Q7FinishedGoodsReceiptInput {
  lines: Q7FinishedGoodsLine[];
  note?: string | null;
  /**
   * Idempotency key. The slip screen generates it once per submit attempt with
   * crypto.randomUUID() and reuses it on a retry, so the server replays the slip.
   */
  requestId?: string;
  /** Defaults to the server's Vietnam today when null / omitted. */
  date?: string | null;
}

/** Receive finished goods from production; idempotent by requestId. */
export function useCreateQ7FinishedGoodsReceipt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Q7FinishedGoodsReceiptInput): Promise<Q7FinishedGoodsSlipResult> => {
      const { data, error } = await supabase.rpc(
        "create_q7_finished_goods_receipt" as never,
        {
          p_lines: input.lines.map((line) => ({
            sku_id: line.sku_id,
            quantity: line.quantity,
            production_order_item_id: line.production_order_item_id ?? null,
          })),
          p_note: input.note ?? null,
          p_request_id: input.requestId ?? crypto.randomUUID(),
          p_date: input.date ?? null,
        } as never,
      );
      if (error) throw error;
      return data as Q7FinishedGoodsSlipResult;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY, "q7"] });
      void queryClient.invalidateQueries({ queryKey: [Q7_FINISHED_GOODS_PLANNED_QUERY_KEY] });
    },
  });
}

export interface Q7FinishedGoodsIssueInput {
  lines: Q7FinishedGoodsLine[];
  /** 'dispatch' (xuất kho) or 'write_off' (xuất hủy). */
  reason: "dispatch" | "write_off";
  note?: string | null;
  /** Idempotency key, generated once per submit attempt; see the receipt hook. */
  requestId?: string;
  /** Defaults to the server's Vietnam today when null / omitted. */
  date?: string | null;
}

/** Issue finished goods as a dispatch or a write-off; idempotent by requestId. */
export function useCreateQ7FinishedGoodsIssue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Q7FinishedGoodsIssueInput): Promise<Q7FinishedGoodsSlipResult> => {
      const { data, error } = await supabase.rpc(
        "create_q7_finished_goods_issue" as never,
        {
          p_lines: input.lines.map((line) => ({
            sku_id: line.sku_id,
            quantity: line.quantity,
          })),
          p_reason: input.reason,
          p_note: input.note ?? null,
          p_request_id: input.requestId ?? crypto.randomUUID(),
          p_date: input.date ?? null,
        } as never,
      );
      if (error) throw error;
      return data as Q7FinishedGoodsSlipResult;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY, "q7"] });
      void queryClient.invalidateQueries({ queryKey: [Q7_FINISHED_GOODS_PLANNED_QUERY_KEY] });
    },
  });
}

export const CRATE_RECEIPT_LINES_QUERY_KEY = "crate-receipt-lines";
export const ITEM_RECEIPT_LINES_QUERY_KEY = "item-receipt-lines";

/**
 * The receipt lines (with their delivery-note image paths) behind one pending
 * crate. `normalizedName === null` and `enabled === false` both skip the call.
 */
export function useCrateReceiptLines(
  location: WarehouseGameLocation,
  supplierId: string | null,
  normalizedName: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [CRATE_RECEIPT_LINES_QUERY_KEY, location, supplierId, normalizedName],
    enabled: enabled && normalizedName !== null,
    staleTime: 60_000,
    queryFn: async (): Promise<ReceiptLine[]> => {
      if (normalizedName === null) return [];
      const { data, error } = await supabase.rpc("get_crate_receipt_lines", {
        p_location: location,
        p_supplier_id: supplierId,
        p_normalized_name: normalizedName,
      });
      if (error) throw error;
      return parseReceiptLines(data);
    },
  });
}

/** The latest receipt lines (60 days) written with one unknown unit, for the unknown-units mission. */
export function useUnitVariantReceiptLines(unit: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["unit-variant-receipt-lines", unit],
    enabled: enabled && unit !== null,
    staleTime: 60_000,
    queryFn: async (): Promise<ReceiptLine[]> => {
      if (unit === null) return [];
      const { data, error } = await supabase.rpc("get_unit_variant_receipt_lines", { p_unit: unit });
      if (error) throw error;
      return parseReceiptLines(data);
    },
  });
}

/** The latest receipt lines (365 days) behind one stock material alias, for the alias-factor mission. */
export function useAliasReceiptLines(aliasId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["alias-receipt-lines", aliasId],
    enabled: enabled && aliasId !== null,
    staleTime: 60_000,
    queryFn: async (): Promise<ReceiptLine[]> => {
      if (aliasId === null) return [];
      const { data, error } = await supabase.rpc("get_alias_receipt_lines", { p_alias_id: aliasId });
      if (error) throw error;
      return parseReceiptLines(data);
    },
  });
}

/** The latest receipt lines matching any alias of one kitchen item. */
export function useItemReceiptLines(itemId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [ITEM_RECEIPT_LINES_QUERY_KEY, itemId],
    enabled: enabled && itemId !== null,
    staleTime: 60_000,
    queryFn: async (): Promise<ReceiptLine[]> => {
      if (itemId === null) return [];
      const { data, error } = await supabase.rpc("get_item_receipt_lines", {
        p_item_id: itemId,
      });
      if (error) throw error;
      return parseReceiptLines(data);
    },
  });
}
