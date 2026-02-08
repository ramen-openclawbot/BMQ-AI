import { useQuery } from "@tanstack/react-query";

const API_BASE = import.meta.env.VITE_DJANGO_API_BASE || "/api";

export function useDjangoOverhead() {
  return useQuery({
    queryKey: ["django-overhead"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/overhead/costs/api/`);
      if (!res.ok) throw new Error("Failed to fetch overhead");
      const data = await res.json();
      return data.items as Array<any>;
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
