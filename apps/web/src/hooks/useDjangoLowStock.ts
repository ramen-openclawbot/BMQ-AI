import { useQuery } from "@tanstack/react-query";

const API_BASE = import.meta.env.VITE_DJANGO_API_BASE || "/api";

export function useDjangoLowStock() {
  return useQuery({
    queryKey: ["django-low-stock"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/inventory/ingredients/low-stock/`);
      if (!res.ok) throw new Error("Failed to fetch low stock");
      const data = await res.json();
      return data.items as Array<any>;
    },
  });
}
