import { useQuery } from "@tanstack/react-query";
import { db } from "@/lib/supabase-helpers";
import {
  parseSupplierProfileOverview,
  type SupplierProfileOverview,
} from "@/lib/supplier-profile";

export function useSupplierProfileOverview() {
  return useQuery<SupplierProfileOverview[]>({
    queryKey: ["supplier-profile-overview"],
    queryFn: async () => {
      const { data, error } = await db.rpc("supplier_profile_overview");
      if (error) throw error;
      return parseSupplierProfileOverview(data);
    },
    staleTime: 15000,
  });
}
