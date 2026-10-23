import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  parsePreparedSupplierOrder,
  parseSupplierOrderHistory,
  sendSupplierOrder,
  type PreparedSupplierOrder,
  type SendSupplierOrderInput,
  type SendSupplierOrderResult,
  type SupplierOrderHistoryEntry,
} from "@/lib/supplier-order";

export function usePrepareSupplierOrder(
  itemId: string | null | undefined,
  enabled = true,
) {
  return useQuery<PreparedSupplierOrder | null>({
    queryKey: ["supplier-order-prepare", itemId],
    enabled: Boolean(itemId) && enabled,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("prepare_supplier_order", {
        p_item_id: itemId as string,
      });
      if (error) throw error;
      return parsePreparedSupplierOrder(data);
    },
    staleTime: 15000,
  });
}

export function useSupplierOrderHistory(itemId: string | null | undefined) {
  return useQuery<SupplierOrderHistoryEntry[]>({
    queryKey: ["supplier-order-history", itemId],
    enabled: Boolean(itemId),
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("supplier_order_history", {
        p_item_id: itemId as string,
      });
      if (error) throw error;
      return parseSupplierOrderHistory(data);
    },
    staleTime: 15000,
  });
}

export function useSendSupplierOrder() {
  const queryClient = useQueryClient();

  return useMutation<SendSupplierOrderResult, Error, SendSupplierOrderInput>({
    mutationFn: (input) => sendSupplierOrder(input),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["supplier-order-history", variables.itemId],
        }),
        queryClient.invalidateQueries({ queryKey: ["purchase-orders"] }),
      ]);
    },
  });
}
