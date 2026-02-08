import { useQuery } from "@tanstack/react-query";

const API_BASE = import.meta.env.VITE_DJANGO_API_BASE || "/api";

export interface SkuCostItem {
  id: number;
  product_id: number;
  product_name: string;
  sku_code: string;
  category: string;
  unit: string | null;
  version: number;
  status: string;
  ingredient_cost: number;
  labor_cost: number;
  overhead_cost: number;
  total_cost_per_unit: number;
  margin: number;
  margin_percentage: number;
  updated_at: string | null;
}

export function useSkuCostsDjango() {
  return useQuery({
    queryKey: ["sku-costs-django"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/costs/list/`);
      if (!res.ok) {
        throw new Error("Failed to fetch SKU costs");
      }
      const data = await res.json();
      return data.items as SkuCostItem[];
    },
  });
}
