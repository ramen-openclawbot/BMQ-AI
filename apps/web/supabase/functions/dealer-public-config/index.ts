import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import { createServiceClient, errorResponse, jsonResponse } from "../_shared/dealer.ts";

const BANNER_URL_KEY = "dealer_landing_banner_url";
const BANNER_PATH_KEY = "dealer_landing_banner_path";
const BANNERS_KEY = "dealer_landing_banners";
const MAX_EVENT_BANNERS = 3;

type DealerLandingBanner = {
  id: string;
  eventLabel: string;
  url: string;
  path: string;
  enabled: boolean;
  contentTitle: string;
  contentIntro: string;
  contentHighlights: string[];
  contentTerms: string;
  contentNote: string;
  published: boolean;
};

const normalizeBanners = (raw: string | null | undefined, fallbackUrl: string | null, fallbackPath: string | null): DealerLandingBanner[] => {
  let parsed: DealerLandingBanner[] = [];

  if (raw) {
    try {
      const value = JSON.parse(raw);
      if (Array.isArray(value)) {
        parsed = value
          .slice(0, MAX_EVENT_BANNERS)
          .map((item, index) => ({
            id: typeof item?.id === "string" && item.id ? item.id : `event-${index + 1}`,
            eventLabel: typeof item?.eventLabel === "string" && item.eventLabel ? item.eventLabel : `Sự kiện ${index + 1}`,
            url: typeof item?.url === "string" ? item.url : "",
            path: typeof item?.path === "string" ? item.path : "",
            enabled: item?.enabled !== false,
            contentTitle: typeof item?.contentTitle === "string" && item.published !== false ? item.contentTitle : "",
            contentIntro: typeof item?.contentIntro === "string" && item.published !== false ? item.contentIntro : "",
            contentHighlights: Array.isArray(item?.contentHighlights) && item.published !== false
              ? item.contentHighlights.filter((line: unknown) => typeof line === "string" && line.trim()).slice(0, 6)
              : [],
            contentTerms: typeof item?.contentTerms === "string" && item.published !== false ? item.contentTerms : "",
            contentNote: typeof item?.contentNote === "string" && item.published !== false ? item.contentNote : "",
            published: item?.published !== false,
          }))
          .filter((item) => item.enabled && item.url);
      }
    } catch (_error) {
      parsed = [];
    }
  }

  if (!parsed.length && fallbackUrl) {
    parsed = [
      {
        id: "event-1",
        eventLabel: "Banner chính",
        url: fallbackUrl,
        path: fallbackPath || "",
        enabled: true,
        contentTitle: "",
        contentIntro: "",
        contentHighlights: [],
        contentTerms: "",
        contentNote: "",
        published: true,
      },
    ];
  }

  return parsed.slice(0, MAX_EVENT_BANNERS);
};

serve(async (req: Request) => {
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
      .in("key", [BANNER_URL_KEY, BANNER_PATH_KEY, BANNERS_KEY]);

    if (error) throw error;

    const bannerUrl = data?.find((row: { key: string; value: string }) => row.key === BANNER_URL_KEY)?.value || null;
    const bannerPath = data?.find((row: { key: string; value: string }) => row.key === BANNER_PATH_KEY)?.value || null;
    const bannersRaw = data?.find((row: { key: string; value: string }) => row.key === BANNERS_KEY)?.value || null;
    const banners = normalizeBanners(bannersRaw, bannerUrl, bannerPath);
    const primaryBanner = banners[0] || null;

    return jsonResponse(req, {
      success: true,
      landing: {
        banner_url: primaryBanner?.url || bannerUrl,
        banner_path: primaryBanner?.path || bannerPath,
        banners,
      },
    });
  } catch (error) {
    console.error("[dealer-public-config] Unexpected error", error);
    const message = error instanceof Error ? error.message : "Không tải được cấu hình landing đại lý";
    return errorResponse(req, message, 500, "dealer_public_config_failed");
  }
});
