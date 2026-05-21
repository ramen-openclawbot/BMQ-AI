import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import { createServiceClient, errorResponse, jsonResponse } from "../_shared/dealer.ts";

const BANNER_URL_KEY = "dealer_landing_banner_url";
const BANNER_PATH_KEY = "dealer_landing_banner_path";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", [BANNER_URL_KEY, BANNER_PATH_KEY]);

    if (error) throw error;

    const bannerUrl = data?.find((row: { key: string; value: string }) => row.key === BANNER_URL_KEY)?.value || null;
    const bannerPath = data?.find((row: { key: string; value: string }) => row.key === BANNER_PATH_KEY)?.value || null;

    return jsonResponse(req, {
      success: true,
      landing: {
        banner_url: bannerUrl,
        banner_path: bannerPath,
      },
    });
  } catch (error) {
    console.error("[dealer-public-config] Unexpected error", error);
    const message = error instanceof Error ? error.message : "Không tải được cấu hình landing đại lý";
    return errorResponse(req, message, 500, "dealer_public_config_failed");
  }
});
