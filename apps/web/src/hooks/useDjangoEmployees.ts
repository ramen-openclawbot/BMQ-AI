import { useQuery } from "@tanstack/react-query";

const API_BASE = import.meta.env.VITE_DJANGO_API_BASE || "/api";

export function useDjangoEmployees() {
  return useQuery({
    queryKey: ["django-employees"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/labor/employees/api/`);
      if (!res.ok) throw new Error("Failed to fetch employees");
      const data = await res.json();
      return data.items as Array<any>;
    },
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
