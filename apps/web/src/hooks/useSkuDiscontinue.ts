import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "@/hooks/useWarehouseGame";

export { isSkuDiscontinued } from "@/lib/sku-discontinue";

export type SkuDiscontinuedInput = {
  skuId: string;
  value: boolean;
};

/** Turn the "Ngưng kinh doanh" switch for one SKU; idempotent per request id. */
export function useSetSkuDiscontinued() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SkuDiscontinuedInput) => {
      const { data, error } = await supabase.rpc("set_sku_discontinued", {
        p_sku_id: input.skuId,
        p_value: input.value,
        p_request_id: crypto.randomUUID(),
      });
      if (error) throw error;
      return data as { sku_id: string; discontinued_at: string | null };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["product-skus"] });
      void queryClient.invalidateQueries({ queryKey: ["tan-tao-warehouse-snapshot"] });
      void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
    },
  });
}
