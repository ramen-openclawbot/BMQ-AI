import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  dealerSignupError,
  dealerSignupJson,
  dealerSignupPreflight,
} from "../_shared/dealer-signup-http.ts";
import {
  ELIGIBILITY_THRESHOLD_M,
  resolveReviewBandM,
} from "../_shared/dealer-signup-distance.ts";

const DEFAULT_CENTER = { lat: 10.7769, lng: 106.7009 };
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = "© OpenStreetMap contributors";
const GEOCODER_URL = "https://photon.komoot.io/api/";

export function handleDealerSignupConfig(req: Request): Response {
  if (req.method === "OPTIONS") return dealerSignupPreflight(req);
  if (req.method !== "GET" && req.method !== "POST") {
    return dealerSignupError(req, "Method not allowed", 405, "method_not_allowed");
  }

  return dealerSignupJson(req, {
    success: true,
    configured: true,
    map_provider: "osm",
    tile_url: TILE_URL,
    tile_attribution: TILE_ATTRIBUTION,
    geocoder_url: GEOCODER_URL,
    threshold_m: ELIGIBILITY_THRESHOLD_M,
    review_band_m: resolveReviewBandM(),
    default_center: DEFAULT_CENTER,
    map_center: DEFAULT_CENTER,
  });
}

serve(handleDealerSignupConfig);
