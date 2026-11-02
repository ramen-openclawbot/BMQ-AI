/**
 * Pure route-distance logic for the dealer signup flow.
 *
 * Distances come from the public OSRM table API on OpenStreetMap's bike
 * profile. The module never logs the request URL or the raw provider response.
 * A fetcher can be injected so tests never touch the network.
 */

export const ELIGIBILITY_THRESHOLD_M = 2000;
export const REVIEW_BAND_M = 500;
export const DEALER_PREFILTER_RADIUS_M = 8000;
export const OSRM_MAX_DESTINATIONS = 50;
export const OSRM_TIMEOUT_MS = 10_000;
export const OSRM_PROVIDER = "osm_osrm_bike";
export const OSRM_DEFAULT_BASE_URL = "https://routing.openstreetmap.de/routed-bike";
export const OSRM_USER_AGENT = "BMQ-dealer-signup/1.0 (+https://dathang.banhmique.vn)";

export type LatLng = {
  lat: number;
  lng: number;
};

export type DealerRecord = {
  id: string;
  customer_name?: string | null;
  address?: string | null;
  customer_group?: string | null;
  is_active?: boolean | null;
  location_lat?: number | string | null;
  location_lng?: number | string | null;
};

export type DealerCandidate = {
  id: string;
  label: string;
  address: string | null;
  lat: number;
  lng: number;
  straight_distance_m: number;
};

export type DealerSelection = {
  candidates: DealerCandidate[];
  unlocated_dealer_count: number;
  active_dealer_count: number;
};

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type MeasuredRouteDistance = {
  dealer: DealerCandidate;
  distance_m: number | null;
};

export type RouteDistanceResult = {
  distances: MeasuredRouteDistance[];
  distance_provider: string;
  error_code: string | null;
  requested_count: number;
  batch_count: number;
};

export type EligibilityResult =
  | "too_close"
  | "eligible"
  | "manual_review";

export type EligibilityDecision = {
  result: EligibilityResult;
  nearest_dealer_customer_id: string | null;
  nearest_dealer_name: string | null;
  nearest_dealer_label: string | null;
  nearest_distance_m: number | null;
  distance_provider: string;
  reason_code: string | null;
  unlocated_dealer_count: number;
};

const DEALER_GROUPS = new Set(["banhmi_agency", "banhmi_point"]);

const toFiniteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const CITY_OR_COUNTRY = /^(tp\.?\s*hcm|tp\.?\s*hồ chí minh|thành phố hồ chí minh|hồ chí minh|ho chi minh|việt nam|viet nam|vn)$/i;

/**
 * Public-safe dealer label: only a ward/district or a street name. It never
 * contains the internal customer id, a phone number or the full address.
 */
export function dealerLabel(address: string | null | undefined): string {
  const raw = normalizeText(address);
  if (!raw) return "Khu vực lân cận";

  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !CITY_OR_COUNTRY.test(part))
    // Never expose a phone number or an internal code embedded in the address.
    .filter((part) => !/(?:\+?84|0)\d{8,10}/.test(part.replace(/[\s.-]/g, "")))
    .filter((part) => !/^(mã|ma|code|mst)(\s|:)/i.test(part));

  if (parts.length >= 2) {
    return parts.slice(-2).join(", ").slice(0, 120);
  }

  if (parts.length === 1) {
    // Drop a leading house number, keeping the street name only.
    return parts[0].replace(/^\d+[A-Za-z0-9/.-]*\s+/, "").slice(0, 120) || "Khu vực lân cận";
  }

  return "Khu vực lân cận";
}

/** Great-circle distance in metres. */
export function haversineMeters(
  originLat: number,
  originLng: number,
  destinationLat: number,
  destinationLng: number,
): number {
  const radius = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(destinationLat - originLat);
  const dLng = toRadians(destinationLng - originLng);
  const lat1 = toRadians(originLat);
  const lat2 = toRadians(destinationLat);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Select active agency/point dealers and pre-filter by great-circle distance.
 * Only dealers closer than 8 km are sent to OSRM; dealers without a usable
 * coordinate are counted so the final decision cannot silently pass.
 */
export function selectDealerCandidates(
  dealers: DealerRecord[],
  origin: LatLng,
): DealerSelection {
  const candidates: DealerCandidate[] = [];
  let unlocatedDealerCount = 0;
  let activeDealerCount = 0;

  for (const dealer of dealers || []) {
    if (!dealer || !dealer.id) continue;
    if (dealer.is_active === false) continue;
    if (!DEALER_GROUPS.has(normalizeText(dealer.customer_group))) continue;

    activeDealerCount += 1;

    const lat = toFiniteNumber(dealer.location_lat);
    const lng = toFiniteNumber(dealer.location_lng);
    if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      unlocatedDealerCount += 1;
      continue;
    }

    const straightDistance = haversineMeters(origin.lat, origin.lng, lat, lng);
    if (straightDistance >= DEALER_PREFILTER_RADIUS_M) continue;

    candidates.push({
      id: dealer.id,
      label: dealerLabel(dealer.address),
      address: normalizeText(dealer.address) || null,
      lat,
      lng,
      straight_distance_m: straightDistance,
    });
  }

  candidates.sort((left, right) => left.straight_distance_m - right.straight_distance_m);

  return {
    candidates,
    unlocated_dealer_count: unlocatedDealerCount,
    active_dealer_count: activeDealerCount,
  };
}

/** Review band in metres, configured by a bounded integer environment value. */
export function resolveReviewBandM(value?: unknown): number {
  const raw = value === undefined || value === null || value === ""
    ? Deno.env.get("DEALER_SIGNUP_REVIEW_BAND_M")
    : value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return REVIEW_BAND_M;
  return Math.max(0, Math.min(2000, Math.trunc(parsed)));
}

const osrmBaseUrl = (override?: string | null): string => {
  const value = normalizeText(override ?? Deno.env.get("OSRM_BASE_URL")) || OSRM_DEFAULT_BASE_URL;
  return value.replace(/\/+$/, "");
};

export function buildOsrmTableUrl(
  baseUrl: string,
  origin: LatLng,
  destinations: DealerCandidate[],
): string {
  const coordinates = [origin, ...destinations]
    .map((point) => `${point.lng},${point.lat}`)
    .join(";");
  return `${osrmBaseUrl(baseUrl)}/table/v1/driving/${coordinates}?sources=0&annotations=distance`;
}

type OsrmPayload = {
  code?: unknown;
  distances?: unknown;
};

/**
 * Call the OSRM table API with the bike routing base. At most 50 dealers are
 * sent per call. Missing routes and provider errors are represented as null
 * distances plus a stable osrm_* error code, never as eligible.
 */
export async function computeRouteDistances(input: {
  origin: LatLng;
  destinations: DealerCandidate[];
  fetcher?: Fetcher;
  timeoutMs?: number;
  baseUrl?: string | null;
}): Promise<RouteDistanceResult> {
  const destinations = input.destinations || [];
  const result: RouteDistanceResult = {
    distances: destinations.map((dealer) => ({ dealer, distance_m: null })),
    distance_provider: OSRM_PROVIDER,
    error_code: null,
    requested_count: destinations.length,
    batch_count: 0,
  };

  if (destinations.length === 0) return result;

  const fetcher = input.fetcher ?? fetch;
  const timeoutMs = input.timeoutMs ?? OSRM_TIMEOUT_MS;
  const baseUrl = osrmBaseUrl(input.baseUrl);

  for (let offset = 0; offset < destinations.length; offset += OSRM_MAX_DESTINATIONS) {
    const chunk = destinations.slice(offset, offset + OSRM_MAX_DESTINATIONS);
    result.batch_count += 1;

    let response: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await fetcher(buildOsrmTableUrl(baseUrl, input.origin, chunk), {
          method: "GET",
          headers: { "User-Agent": OSRM_USER_AGENT },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      result.error_code = (error as { name?: string } | null)?.name === "AbortError"
        ? "osrm_timeout"
        : "osrm_network_error";
      continue;
    }

    if (!response.ok) {
      result.error_code = "osrm_unavailable";
      continue;
    }

    let payload: OsrmPayload;
    try {
      const parsed = await response.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        result.error_code = "osrm_invalid_response";
        continue;
      }
      payload = parsed as OsrmPayload;
    } catch {
      result.error_code = "osrm_invalid_response";
      continue;
    }

    // A non-Ok OSRM code means no usable route, not a valid measurement.
    if (payload.code !== "Ok") continue;

    const rows = payload.distances;
    if (!Array.isArray(rows) || !Array.isArray(rows[0])) {
      result.error_code = "osrm_invalid_response";
      continue;
    }

    const row = rows[0] as unknown[];
    for (let localIndex = 0; localIndex < chunk.length; localIndex += 1) {
      const distance = toFiniteNumber(row[localIndex + 1]);
      if (distance === null || distance < 0) continue;

      result.distances[offset + localIndex] = {
        dealer: chunk[localIndex],
        distance_m: distance,
      };
    }
  }

  return result;
}

/**
 * Combine the pre-filter, the route measurements and missing-location counts.
 *
 * Decision order:
 * 1. any measured route below 2,000 m is too_close;
 * 2. any dealer without coordinates is manual_review;
 * 3. a provider error or missing route is manual_review;
 * 4. a nearest route inside the 2,000–2,000+band buffer is manual_review;
 * 5. otherwise eligible.
 */
export function decideEligibility(input: {
  candidates: DealerCandidate[];
  distances: MeasuredRouteDistance[];
  unlocatedDealerCount: number;
  errorCode?: string | null;
  provider?: string | null;
  reviewBandM?: number;
}): EligibilityDecision {
  const provider = normalizeText(input.provider) || OSRM_PROVIDER;
  const reviewBandM = resolveReviewBandM(input.reviewBandM);
  const measured = (input.distances || []).filter(
    (entry) => entry?.dealer && entry.distance_m !== null && entry.distance_m !== undefined,
  ) as Array<{ dealer: DealerCandidate; distance_m: number }>;

  const nearest = measured.reduce<{ dealer: DealerCandidate; distance_m: number } | null>(
    (current, entry) => (!current || entry.distance_m < current.distance_m ? entry : current),
    null,
  );

  const base = {
    nearest_dealer_customer_id: nearest?.dealer.id ?? null,
    nearest_dealer_name: nearest?.dealer.label ?? null,
    nearest_dealer_label: nearest?.dealer.label ?? null,
    nearest_distance_m: nearest ? Math.round(nearest.distance_m) : null,
    distance_provider: provider,
    unlocated_dealer_count: Math.max(0, Number(input.unlocatedDealerCount) || 0),
  };

  if (nearest && nearest.distance_m < ELIGIBILITY_THRESHOLD_M) {
    return {
      result: "too_close",
      reason_code: "dealer_within_2km",
      ...base,
    };
  }

  if (base.unlocated_dealer_count > 0) {
    return {
      result: "manual_review",
      reason_code: "dealer_location_missing",
      ...base,
    };
  }

  const missingRoute = (input.distances || []).some(
    (entry) => !entry || entry.distance_m === null || entry.distance_m === undefined,
  );

  if (input.errorCode) {
    return {
      result: "manual_review",
      reason_code: input.errorCode,
      ...base,
    };
  }

  if (missingRoute || (input.distances || []).length !== (input.candidates || []).length) {
    return {
      result: "manual_review",
      reason_code: "dealer_route_missing",
      ...base,
    };
  }

  if (
    nearest &&
    nearest.distance_m >= ELIGIBILITY_THRESHOLD_M &&
    nearest.distance_m < ELIGIBILITY_THRESHOLD_M + reviewBandM
  ) {
    return {
      result: "manual_review",
      reason_code: "distance_near_threshold",
      ...base,
    };
  }

  return {
    result: "eligible",
    reason_code: null,
    ...base,
  };
}

/** End-to-end helper used by the Edge Functions. */
export async function evaluateDealerRouteEligibility(input: {
  origin: LatLng;
  dealers: DealerRecord[];
  fetcher?: Fetcher;
  timeoutMs?: number;
  baseUrl?: string | null;
  reviewBandM?: number;
}): Promise<EligibilityDecision> {
  const selection = selectDealerCandidates(input.dealers, input.origin);
  const distanceResult = await computeRouteDistances({
    origin: input.origin,
    destinations: selection.candidates,
    fetcher: input.fetcher,
    timeoutMs: input.timeoutMs,
    baseUrl: input.baseUrl,
  });

  return decideEligibility({
    candidates: selection.candidates,
    distances: distanceResult.distances,
    unlocatedDealerCount: selection.unlocated_dealer_count,
    errorCode: distanceResult.error_code,
    provider: distanceResult.distance_provider,
    reviewBandM: input.reviewBandM,
  });
}

/** Backward-compatible alias for callers that have not migrated the name yet. */
export const evaluateDealerEligibility = evaluateDealerRouteEligibility;
