import { useQuery } from "@tanstack/react-query";

const API_BASE = import.meta.env.VITE_DJANGO_API_BASE || "/api";

export function useDjangoIngredients() {
  return useQuery({
    queryKey: ["django-ingredients"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/inventory/ingredients/api/`);
      if (!res.ok) throw new Error("Failed to fetch ingredients");
      const data = await res.json();
      return data.items as Array<any>;
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
