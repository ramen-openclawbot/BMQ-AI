import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  parsePreparedSupplierOrder,
  parseSupplierOrderCatalog,
  parseSupplierOrderCatalogCandidates,
  parseSupplierOrderHistory,
  parseSupplierOrderHistoryBySupplier,
  parseSupplierOrderSuppliers,
  previewSupplierOrder,
  sendSupplierOrder,
  sendSupplierOrderLines,
  type PreparedSupplierOrder,
  type SendSupplierOrderInput,
  type SendSupplierOrderLinesInput,
  type SendSupplierOrderLinesResult,
  type SendSupplierOrderResult,
  type SupplierOrderCatalog,
  type SupplierOrderCatalogCandidate,
  type SupplierOrderHistoryBySupplierEntry,
  type SupplierOrderHistoryEntry,
  type SupplierOrderPreview,
  type SupplierOrderSupplierListEntry,
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

export function useOrderSuppliers() {
  return useQuery<SupplierOrderSupplierListEntry[]>({
    queryKey: ["supplier-order-suppliers"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("supplier_order_suppliers");
      if (error) throw error;
      return parseSupplierOrderSuppliers(data);
    },
    staleTime: 15000,
  });
}

export function useSupplierCatalog(supplierId: string | null | undefined) {
  return useQuery<SupplierOrderCatalog | null>({
    queryKey: ["supplier-order-catalog", supplierId],
    enabled: Boolean(supplierId),
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("supplier_order_catalog", {
        p_supplier_id: supplierId as string,
      });
      if (error) throw error;
      return parseSupplierOrderCatalog(data);
    },
    staleTime: 15000,
  });
}

export function useSupplierCatalogCandidates(supplierId: string | null | undefined) {
  return useQuery<SupplierOrderCatalogCandidate[]>({
    queryKey: ["supplier-order-catalog-candidates", supplierId],
    enabled: Boolean(supplierId),
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc(
        "supplier_order_catalog_candidates",
        { p_supplier_id: supplierId as string },
      );
      if (error) throw error;
      return parseSupplierOrderCatalogCandidates(data);
    },
    staleTime: 15000,
  });
}

export type SetSupplierCatalogItemInput = {
  supplierId: string;
  itemId: string;
  active: boolean;
  poUnit?: string;
  packSizePo?: number | null;
  productName?: string | null;
  listPrice?: number | null;
  listPriceIncludesVat?: boolean | null;
};

export function useSetSupplierCatalogItem() {
  const queryClient = useQueryClient();

  return useMutation<Record<string, unknown> | null, Error, SetSupplierCatalogItemInput>({
    mutationFn: async (input) => {
      const { data, error } = await (supabase as any).rpc("supplier_order_catalog_set", {
        p_supplier_id: input.supplierId,
        p_item_id: input.itemId,
        p_active: input.active,
        p_po_unit: input.poUnit ?? "kg",
        p_pack_size_po: input.packSizePo ?? null,
        p_product_name: input.productName ?? null,
        p_list_price: input.listPrice ?? null,
        p_list_price_includes_vat: input.listPriceIncludesVat ?? null,
      });
      if (error) throw error;
      return (data ?? null) as Record<string, unknown> | null;
    },
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["supplier-order-catalog", variables.supplierId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["supplier-order-catalog-candidates", variables.supplierId],
        }),
        queryClient.invalidateQueries({ queryKey: ["supplier-order-suppliers"] }),
      ]);
    },
  });
}

export type SetSupplierOrderEmailInput = {
  supplierId: string;
  email: string;
};

export function useSetSupplierOrderEmail() {
  const queryClient = useQueryClient();

  return useMutation<Record<string, unknown> | null, Error, SetSupplierOrderEmailInput>({
    mutationFn: async (input) => {
      const { data, error } = await (supabase as any).rpc(
        "supplier_order_set_supplier_email",
        {
          p_supplier_id: input.supplierId,
          p_email: input.email,
        },
      );
      if (error) throw error;
      return (data ?? null) as Record<string, unknown> | null;
    },
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["supplier-order-suppliers"] }),
        queryClient.invalidateQueries({
          queryKey: ["supplier-order-catalog", variables.supplierId],
        }),
      ]);
    },
  });
}

export function usePreviewSupplierOrder() {
  return useMutation<SupplierOrderPreview, Error, SendSupplierOrderLinesInput>({
    mutationFn: (input) => previewSupplierOrder(input),
  });
}

export function useSendSupplierOrderLines() {
  const queryClient = useQueryClient();

  return useMutation<
    SendSupplierOrderLinesResult,
    Error,
    SendSupplierOrderLinesInput
  >({
    mutationFn: (input) => sendSupplierOrderLines(input),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["supplier-order-catalog", variables.supplierId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["supplier-order-history-by-supplier", variables.supplierId],
        }),
        queryClient.invalidateQueries({ queryKey: ["supplier-order-history"] }),
        queryClient.invalidateQueries({ queryKey: ["supplier-order-suppliers"] }),
        queryClient.invalidateQueries({ queryKey: ["purchase-orders"] }),
      ]);
    },
  });
}

export function useSupplierOrderHistoryBySupplier(
  supplierId: string | null | undefined,
) {
  return useQuery<SupplierOrderHistoryBySupplierEntry[]>({
    queryKey: ["supplier-order-history-by-supplier", supplierId],
    enabled: Boolean(supplierId),
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc(
        "supplier_order_history_by_supplier",
        { p_supplier_id: supplierId as string },
      );
      if (error) throw error;
      return parseSupplierOrderHistoryBySupplier(data);
    },
    staleTime: 15000,
  });
}
