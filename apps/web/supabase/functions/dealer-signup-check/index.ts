import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  DEALER_SIGNUP_CHECK_LIMIT_PER_HOUR,
  createDealerSignupServiceClient,
  createSupabaseDealerSignupStore,
  dealerSignupError,
  dealerSignupJson,
  dealerSignupPreflight,
  getClientIp,
  hashClientIp,
  isWithinVietnam,
  parseFiniteNumber,
  readDealerSignupBody,
  safeErrorCode,
  type DealerSignupStore,
} from "../_shared/dealer-signup-http.ts";
import {
  evaluateDealerRouteEligibility,
  type Fetcher,
} from "../_shared/dealer-signup-distance.ts";

export type DealerSignupCheckDeps = {
  store: DealerSignupStore;
  fetcher?: Fetcher;
  env?: (key: string) => string | undefined;
  logger?: (code: string) => void;
};

type CheckBody = {
  lat?: unknown;
  lng?: unknown;
  address_text?: unknown;
};

export async function handleDealerSignupCheck(
  req: Request,
  deps: DealerSignupCheckDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") return dealerSignupPreflight(req);
  if (req.method !== "POST") {
    return dealerSignupError(req, "Method not allowed", 405, "method_not_allowed");
  }

  const env = deps.env ?? ((key: string) => Deno.env.get(key));
  const logger = deps.logger ?? ((code: string) => console.warn(`[dealer-signup-check] ${code}`));

  try {
    const body = await readDealerSignupBody<CheckBody>(req);
    const lat = parseFiniteNumber(body.lat);
    const lng = parseFiniteNumber(body.lng);
    const addressText = String(body.address_text ?? "").trim();

    if (lat === null || lng === null || !isWithinVietnam(lat, lng)) {
      return dealerSignupError(req, "Tọa độ không nằm trong phạm vi Việt Nam.", 400, "invalid_coordinates");
    }
    if (addressText.length < 3 || addressText.length > 500) {
      return dealerSignupError(req, "Địa chỉ không hợp lệ.", 400, "invalid_address");
    }

    const salt = env("DEALER_SIGNUP_IP_SALT") || env("SUPABASE_SERVICE_ROLE_KEY") || "dealer-signup-local";
    const ipHash = await hashClientIp(getClientIp(req), salt);

    let rateLimit;
    try {
      rateLimit = await deps.store.checkRateLimit(ipHash, "check", DEALER_SIGNUP_CHECK_LIMIT_PER_HOUR);
    } catch {
      logger("rate_limit_unavailable");
      return dealerSignupError(req, "Tạm thời chưa kiểm tra được vị trí. Vui lòng thử lại.", 503, "rate_limit_unavailable");
    }

    if (!rateLimit.allowed) {
      const response = dealerSignupError(req, "Bạn đã kiểm tra quá nhiều lần. Vui lòng thử lại sau.", 429, "rate_limited");
      response.headers.set("Retry-After", String(Math.max(1, rateLimit.retry_after_seconds)));
      return response;
    }

    const dealers = await deps.store.loadActiveDealers();
    const decision = await evaluateDealerRouteEligibility({
      origin: { lat, lng },
      dealers,
      fetcher: deps.fetcher,
    });

    return dealerSignupJson(req, {
      success: true,
      result: decision.result,
      nearest_distance_m: decision.nearest_distance_m,
      nearest_dealer_label: decision.nearest_dealer_label,
      distance_provider: decision.distance_provider,
      unlocated_dealer_count: decision.unlocated_dealer_count,
    });
  } catch (error) {
    logger(`request_failed:${safeErrorCode(error, "check_failed")}`);
    return dealerSignupError(req, "Không kiểm tra được vị trí. Vui lòng thử lại.", 500, "dealer_signup_check_failed");
  }
}

serve((req) =>
  handleDealerSignupCheck(req, {
    store: createSupabaseDealerSignupStore(createDealerSignupServiceClient()),
  })
);
