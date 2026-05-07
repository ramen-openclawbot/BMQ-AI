import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { calculateMovementAmount, deriveSystemEndingQty, numberValue } from "@/lib/kitchen-inventory/calculations";
import type { KitchenMovementType } from "@/lib/kitchen-inventory/normalize";

type KitchenQueryResult = { data: unknown; error: Error | null };
type KitchenQueryBuilder = PromiseLike<KitchenQueryResult> & {
  select: (columns: string) => KitchenQueryBuilder;
  order: (column: string, options?: { ascending?: boolean }) => KitchenQueryBuilder;
  limit: (count: number) => KitchenQueryBuilder;
  eq: (column: string, value: string | number | boolean | null) => KitchenQueryBuilder;
  insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => Promise<KitchenQueryResult>;
  upsert: (payload: Record<string, unknown> | Record<string, unknown>[], options?: { onConflict?: string }) => Promise<KitchenQueryResult>;
};

const kitchenDb = supabase as unknown as { from: (table: string) => KitchenQueryBuilder };
const kitchenRpc = supabase as unknown as {
  rpc: (functionName: string, args: Record<string, unknown>) => Promise<KitchenQueryResult>;
};

export interface KitchenImportBatch {
  id: string;
  source_file_name: string;
  source_sheet_name: string;
  source_period_start: string | null;
  source_period_end: string | null;
  status: "uploaded" | "previewed" | "applied" | "partial" | "failed";
  rows_total: number;
  rows_approved: number;
  rows_review: number;
  rows_rejected: number;
  applied_at: string | null;
  created_at: string;
}

export interface KitchenImportRow {
  id: string;
  batch_id: string;
  source_row_number: number;
  source_month: string | null;
  source_item_name: string;
  source_item_type: string | null;
  source_unit: string | null;
  source_standard_unit_cost: number | null;
  source_opening_qty: number | null;
  source_purchase_qty: number | null;
  source_usage_qty: number | null;
  source_ending_qty: number | null;
  source_amount: number | null;
  approval_decision: "APPROVE" | "REVIEW" | "REJECT";
  import_status: "staged" | "applied" | "skipped" | "failed";
  issue_flags: unknown;
  canonical_item_id: string | null;
}

export interface KitchenItem {
  id: string;
  item_code: string;
  item_type: "ingredient" | "tool_supply";
  name: string;
  unit: string;
  standard_unit_cost: number;
  active: boolean;
  trusted_source_batch_id: string | null;
  updated_at: string;
}

export interface KitchenMovement {
  id: string;
  movement_date: string;
  period_month: string;
  item_id: string;
  movement_type: KitchenMovementType;
  quantity: number;
  unit: string;
  unit_cost: number;
  amount: number;
  source: "import_t3_t4" | "manual_daily" | "adjustment" | "goods_receipt_bridge";
  note: string | null;
  created_at: string;
}

export interface KitchenMonthlyClosing {
  id: string;
  period_month: string;
  item_id: string;
  opening_qty: number;
  purchase_qty: number;
  usage_qty: number;
  adjustment_qty: number;
  system_ending_qty: number;
  counted_ending_qty: number | null;
  variance_qty: number | null;
  unit_cost: number;
  usage_amount: number;
  status: "draft" | "reviewed" | "closed";
}

export interface KitchenOtherCost {
  id: string;
  cost_date: string;
  period_month: string;
  cost_type: string;
  description: string;
  amount: number;
}

export interface AddKitchenMovementInput {
  movement_date: string;
  item_id: string;
  movement_type: KitchenMovementType;
  quantity: number;
  unit_cost?: number;
  note?: string;
}

function monthStart(date: string) {
  return `${date.slice(0, 7)}-01`;
}

export function useKitchenInventory(periodMonth: string) {
  const { user, canEditModule } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canEdit = canEditModule("kitchen_inventory");

  const itemsQuery = useQuery({
    queryKey: ["kitchen-inventory", "items"],
    queryFn: async () => {
      const { data, error } = await kitchenDb
        .from("kitchen_inventory_items")
        .select("id,item_code,item_type,name,unit,standard_unit_cost,active,trusted_source_batch_id,updated_at")
        .order("item_code", { ascending: true });
      if (error) throw error;
      return (data || []) as KitchenItem[];
    },
  });

  const batchesQuery = useQuery({
    queryKey: ["kitchen-inventory", "batches"],
    queryFn: async () => {
      const { data, error } = await kitchenDb
        .from("kitchen_inventory_import_batches")
        .select("id,source_file_name,source_sheet_name,source_period_start,source_period_end,status,rows_total,rows_approved,rows_review,rows_rejected,applied_at,created_at")
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data || []) as KitchenImportBatch[];
    },
  });

  const latestBatchId = batchesQuery.data?.[0]?.id;

  const rowsQuery = useQuery({
    queryKey: ["kitchen-inventory", "rows", latestBatchId],
    queryFn: async () => {
      if (!latestBatchId) return [];
      const batchId = latestBatchId;
      const { data, error } = await kitchenDb
        .from("kitchen_inventory_import_rows")
        .select("id,batch_id,source_row_number,source_month,source_item_name,source_item_type,source_unit,source_standard_unit_cost,source_opening_qty,source_purchase_qty,source_usage_qty,source_ending_qty,source_amount,approval_decision,import_status,issue_flags,canonical_item_id")
        .eq("batch_id", batchId)
        .order("source_row_number", { ascending: true })
        .limit(500);
      if (error) throw error;
      return (data || []) as KitchenImportRow[];
    },
    enabled: !!latestBatchId,
  });

  const movementsQuery = useQuery({
    queryKey: ["kitchen-inventory", "movements", periodMonth],
    queryFn: async () => {
      const { data, error } = await kitchenDb
        .from("kitchen_inventory_movements")
        .select("id,movement_date,period_month,item_id,movement_type,quantity,unit,unit_cost,amount,source,note,created_at")
        .eq("period_month", periodMonth)
        .order("movement_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as KitchenMovement[];
    },
    enabled: !!periodMonth,
  });

  const closingsQuery = useQuery({
    queryKey: ["kitchen-inventory", "closings", periodMonth],
    queryFn: async () => {
      const { data, error } = await kitchenDb
        .from("kitchen_inventory_monthly_closings")
        .select("id,period_month,item_id,opening_qty,purchase_qty,usage_qty,adjustment_qty,system_ending_qty,counted_ending_qty,variance_qty,unit_cost,usage_amount,status")
        .eq("period_month", periodMonth)
        .order("status", { ascending: true });
      if (error) throw error;
      return (data || []) as KitchenMonthlyClosing[];
    },
    enabled: !!periodMonth,
  });

  const otherCostsQuery = useQuery({
    queryKey: ["kitchen-inventory", "other-costs", periodMonth],
    queryFn: async () => {
      const { data, error } = await kitchenDb
        .from("kitchen_other_costs")
        .select("id,cost_date,period_month,cost_type,description,amount")
        .eq("period_month", periodMonth)
        .order("cost_date", { ascending: false });
      if (error) throw error;
      return (data || []) as KitchenOtherCost[];
    },
    enabled: !!periodMonth,
  });

  const itemById = useMemo(() => {
    return new Map((itemsQuery.data || []).map((item) => [item.id, item]));
  }, [itemsQuery.data]);

  const draftClosings = useMemo(() => {
    const movements = movementsQuery.data || [];
    const items = itemsQuery.data || [];
    return items.map((item) => {
      const itemMovements = movements.filter((movement) => movement.item_id === item.id);
      const openingQty = itemMovements
        .filter((movement) => movement.movement_type === "opening")
        .reduce((sum, movement) => sum + numberValue(movement.quantity), 0);
      const purchaseQty = itemMovements
        .filter((movement) => movement.movement_type === "purchase")
        .reduce((sum, movement) => sum + numberValue(movement.quantity), 0);
      const usageQty = itemMovements
        .filter((movement) => movement.movement_type === "usage")
        .reduce((sum, movement) => sum + numberValue(movement.quantity), 0);
      const adjustmentQty = itemMovements
        .filter((movement) => movement.movement_type === "adjustment")
        .reduce((sum, movement) => sum + numberValue(movement.quantity), 0);
      const countedEnding = itemMovements
        .filter((movement) => movement.movement_type === "stock_count")
        .sort((a, b) => {
          const dateCompare = a.movement_date.localeCompare(b.movement_date);
          if (dateCompare !== 0) return dateCompare;
          return a.created_at.localeCompare(b.created_at);
        })
        .at(-1)?.quantity ?? null;
      const systemEndingQty = deriveSystemEndingQty({
        openingQty,
        purchaseQty,
        usageQty,
        adjustmentQty,
      });

      return {
        item,
        openingQty,
        purchaseQty,
        usageQty,
        adjustmentQty,
        systemEndingQty,
        countedEnding,
        varianceQty: countedEnding === null ? null : numberValue(countedEnding) - systemEndingQty,
        usageAmount: usageQty * numberValue(item.standard_unit_cost),
      };
    });
  }, [itemsQuery.data, movementsQuery.data]);

  const closeMonth = useMutation({
    mutationFn: async () => {
      if (!canEdit) throw new Error("Bạn không có quyền chốt tháng kho bếp.");
      if (!user?.id) throw new Error("Vui lòng đăng nhập lại trước khi chốt tháng.");
      if (!periodMonth) throw new Error("Vui lòng chọn tháng cần chốt.");
      if (draftClosings.length === 0) throw new Error("Chưa có item để chốt tháng.");
      const { error } = await kitchenRpc.rpc("close_kitchen_inventory_month", { p_period_month: periodMonth });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["kitchen-inventory", "closings"] });
      toast({ title: "Đã chốt tháng kho bếp" });
    },
    onError: (error: Error) => {
      toast({
        title: "Không thể chốt tháng",
        description: error.message || "Vui lòng thử lại",
        variant: "destructive",
      });
    },
  });

  const addMovement = useMutation({
    mutationFn: async (input: AddKitchenMovementInput) => {
      if (!canEdit) throw new Error("Bạn không có quyền ghi sổ kho bếp.");
      if (!user?.id) throw new Error("Vui lòng đăng nhập lại trước khi ghi sổ kho bếp.");
      const item = itemById.get(input.item_id);
      if (!item) throw new Error("Vui lòng chọn item từ danh mục chuẩn.");

      const unitCost = numberValue(input.unit_cost ?? item.standard_unit_cost);
      const amount = calculateMovementAmount(input.quantity, unitCost);
      const { error } = await kitchenDb.from("kitchen_inventory_movements").insert({
        movement_date: input.movement_date,
        period_month: monthStart(input.movement_date),
        item_id: item.id,
        movement_type: input.movement_type,
        quantity: input.quantity,
        unit: item.unit,
        unit_cost: unitCost,
        amount,
        source: input.movement_type === "adjustment" ? "adjustment" : "manual_daily",
        note: input.note || null,
        created_by: user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["kitchen-inventory", "movements"] });
      toast({ title: "Đã ghi sổ kho bếp" });
    },
    onError: (error: Error) => {
      toast({
        title: "Không thể ghi sổ",
        description: error.message || "Vui lòng thử lại",
        variant: "destructive",
      });
    },
  });

  return {
    canEdit,
    itemsQuery,
    batchesQuery,
    rowsQuery,
    movementsQuery,
    closingsQuery,
    otherCostsQuery,
    itemById,
    draftClosings,
    closeMonth,
    addMovement,
  };
}
