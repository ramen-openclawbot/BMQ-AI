import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type Q7InventorySnapshotRow = {
  kitchen_inventory_item_id: string;
  item_name: string;
  unit: string;
  opening_qty: number | null;
  receipt_qty: number;
  usage_qty: number;
  adjustment_qty: number;
  balance_qty: number;
  is_negative: boolean;
  opening_audited: boolean;
};

export type Q7InventoryMovementRow = {
  id: string;
  kitchen_inventory_item_id: string;
  movement_date: string;
  movement_type: string;
  quantity: number;
  unit: string;
  note: string | null;
  created_at: string;
  kitchen_inventory_items?: { name?: string | null } | { name?: string | null }[] | null;
};

export function useQ7InventorySnapshot(asOfDate: string) {
  return useQuery<Q7InventorySnapshotRow[]>({
    queryKey: ["q7_inventory_snapshot", asOfDate],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("get_q7_inventory_snapshot", { p_as_of_date: asOfDate });
      if (error) throw error;
      return (data || []) as Q7InventorySnapshotRow[];
    },
  });
}

export function useQ7InventoryMovements(asOfDate: string) {
  return useQuery<Q7InventoryMovementRow[]>({
    queryKey: ["q7_inventory_movements", asOfDate],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("q7_inventory_movements")
        .select("id,kitchen_inventory_item_id,movement_date,movement_type,quantity,unit,note,created_at,kitchen_inventory_items(name)")
        .lte("movement_date", asOfDate)
        .order("movement_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data || []) as Q7InventoryMovementRow[];
    },
  });
}

export function useQ7InventoryMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["q7_inventory_snapshot"] });
    queryClient.invalidateQueries({ queryKey: ["q7_inventory_movements"] });
  };

  const recordReceiptMutation = useMutation({
    mutationFn: async (payload: {
      movementDate: string;
      kitchenInventoryItemId: string;
      quantity: number;
      unit: string;
      reference?: string | null;
      note?: string | null;
    }) => {
      const { data, error } = await (supabase as any).rpc("record_q7_inventory_receipt", {
        p_movement_date: payload.movementDate,
        p_kitchen_inventory_item_id: payload.kitchenInventoryItemId,
        p_quantity: payload.quantity,
        p_unit: payload.unit,
        p_source_ref_key: payload.reference || null,
        p_note: payload.note || null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });

  const backfillOpeningMutation = useMutation({
    mutationFn: async (payload: {
      effectiveDate: string;
      kitchenInventoryItemId: string;
      openingQty: number | null;
      unit: string;
      physicalCountQty?: number | null;
      physicalCountDate?: string | null;
      note?: string | null;
    }) => {
      const { data, error } = await (supabase as any).rpc("backfill_q7_inventory_opening", {
        p_effective_date: payload.effectiveDate,
        p_kitchen_inventory_item_id: payload.kitchenInventoryItemId,
        p_opening_qty: payload.openingQty,
        p_unit: payload.unit,
        p_physical_count_qty: payload.physicalCountQty ?? null,
        p_physical_count_date: payload.physicalCountDate || null,
        p_note: payload.note || null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });

  return { recordReceiptMutation, backfillOpeningMutation };
}
