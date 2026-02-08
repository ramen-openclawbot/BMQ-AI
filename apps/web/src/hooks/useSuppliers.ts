import { useQuery } from "@tanstack/react-query";
import { db } from "@/lib/supabase-helpers";

export interface Supplier {
  id: string;
  name: string;
  category: string;
  description: string | null;
  phone: string | null;
  email: string | null;
  rating: number;
  order_count: number;
  default_payment_method: 'bank_transfer' | 'cash' | null;
  contract_url: string | null;
  payment_terms_days: number | null;
}

export function useSuppliers() {
  return useQuery({
    queryKey: ["suppliers"],
    queryFn: async () => {
      const { data, error } = await db
        .from("suppliers")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Supplier[];
    },
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
    retry: 1,
  });
}
