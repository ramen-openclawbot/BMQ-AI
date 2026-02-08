import { useQuery } from "@tanstack/react-query";

const API_BASE = import.meta.env.VITE_DJANGO_API_BASE || "/api";

export function useDjangoProducts() {
  return useQuery({
    queryKey: ["django-products"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/products/api/`);
      if (!res.ok) throw new Error("Failed to fetch products");
      const data = await res.json();
      return data.items as Array<any>;
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
