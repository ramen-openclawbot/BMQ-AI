import { useQuery } from "@tanstack/react-query";

const API_BASE = import.meta.env.VITE_DJANGO_API_BASE || "/api";

export function useDjangoCostTrend(productId?: number) {
  return useQuery({
    queryKey: ["django-cost-trend", productId],
    enabled: !!productId,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/costs/product/${productId}/trend-public/`);
      if (!res.ok) throw new Error("Failed to fetch trend");
      return res.json();
    },
  });
}
