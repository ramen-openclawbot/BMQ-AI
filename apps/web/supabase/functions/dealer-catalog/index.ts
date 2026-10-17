import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  createServiceClient,
  errorResponse,
  extractDealerSessionToken,
  jsonResponse,
  publicCustomerProfile,
  readJsonBody,
  resolveDealerSessionWithLock,
} from "../_shared/dealer.ts";
import { dealerOrderLockedResponseBody } from "../_shared/dealer-order-lock.ts";
import { loadDealerCatalog } from "../_shared/dealer-catalog-data.ts";

type DealerRouteCustomer = {
  id: string;
  customer_name: string | null;
  customer_code: string | null;
  address: string | null;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const body = req.method === "POST" ? await readJsonBody<Record<string, unknown>>(req) : {};
    const supabase = createServiceClient();
    const token = extractDealerSessionToken(body, req);
    const resolution = token ? await resolveDealerSessionWithLock(supabase, token) : null;
    const sessionContext = resolution?.session ?? null;

    if (resolution?.locked) {
      return jsonResponse(req, dealerOrderLockedResponseBody(), 423);
    }

    if (!sessionContext) {
      return errorResponse(req, "Phiên đại lý đã hết hạn. Vui lòng đăng nhập lại để xem catalog.", 401, "dealer_session_required");
    }

    const products = await loadDealerCatalog(supabase, sessionContext);

    const { data: routeCustomers, error: routeError } = await supabase
      .from("mini_crm_customers")
      .select("id, customer_name, customer_code, address")
      .eq("supplied_by_npp_customer_id", sessionContext.customer.id)
      .order("customer_name", { ascending: true });

    if (routeError) throw routeError;

    const dealerRoutes = ((routeCustomers || []) as DealerRouteCustomer[])
      .filter((route) => route.id && route.customer_name)
      .map((route) => ({
        id: route.id,
        name: route.customer_name || "Điểm bán",
        code: route.customer_code,
        address: route.address,
      }));

    const now = new Date().toISOString();
    const { data: announcements, error: announcementError } = await supabase
      .from("dealer_announcements")
      .select("id, title, body, severity, starts_at, ends_at")
      .eq("is_active", true)
      .or(`starts_at.is.null,starts_at.lte.${now}`)
      .or(`ends_at.is.null,ends_at.gt.${now}`)
      .order("created_at", { ascending: false });

    if (announcementError) throw announcementError;

    return jsonResponse(req, {
      success: true,
      products,
      announcements: announcements || [],
      customer: sessionContext
        ? publicCustomerProfile(sessionContext.customer, sessionContext.contact)
        : null,
      dealer_routes: dealerRoutes,
    });
  } catch (error) {
    console.error("[dealer-catalog] Unexpected error", error);
    const message = error instanceof Error ? error.message : "Không tải được catalog đại lý";
    return errorResponse(req, message, 500, "dealer_catalog_failed");
  }
});
