import type { createServiceClient, DealerSessionContext } from "./dealer.ts";

/**
 * Read-only route (point of sale) list for an NPP dealer. The routes are the
 * customers supplied by the signed-in NPP, exactly as dealer-catalog exposes
 * them. Nothing is written here.
 */

type DealerServiceClient = ReturnType<typeof createServiceClient>;

export type DealerRoute = {
  id: string;
  name: string;
  code: string | null;
  address: string | null;
};

type RouteRow = {
  id: string | null;
  customer_name: string | null;
  customer_code: string | null;
  address: string | null;
};

export async function loadDealerRoutes(
  supabase: DealerServiceClient,
  session: DealerSessionContext,
): Promise<DealerRoute[]> {
  const { data, error } = await supabase
    .from("mini_crm_customers")
    .select("id, customer_name, customer_code, address")
    .eq("supplied_by_npp_customer_id", session.customer.id)
    .order("customer_name", { ascending: true });

  if (error) throw error;

  const routes: DealerRoute[] = [];
  ((data || []) as RouteRow[]).forEach((row) => {
    if (!row.id || !row.customer_name) return;
    routes.push({
      id: row.id,
      name: row.customer_name,
      code: row.customer_code ?? null,
      address: row.address ?? null,
    });
  });

  return routes;
}
