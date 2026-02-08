import { useQuery } from "@tanstack/react-query";

const API_BASE = import.meta.env.VITE_DJANGO_API_BASE || "/api";

export function useDjangoRecentCosts() {
  return useQuery({
    queryKey: ["django-recent-costs"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/costs/recent/`);
      if (!res.ok) throw new Error("Failed to fetch recent costs");
      const data = await res.json();
      return data.items as Array<any>;
    },
  });
}
