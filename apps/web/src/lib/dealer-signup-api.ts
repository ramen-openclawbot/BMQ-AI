/**
 * Web client for the public dealer signup API. No UI is wired here.
 */
export const DEALER_SIGNUP_THRESHOLD_M = 2000;
export const DEALER_SIGNUP_REVIEW_BAND_M = 500;
export const DEALER_SIGNUP_GEOCODER_URL = "https://photon.komoot.io/api/";

export type DealerSignupConfig = {
  configured: boolean;
  map_provider: "osm";
  tile_url: string;
  tile_attribution: string;
  geocoder_url: string;
  threshold_m: number;
  review_band_m: number;
  default_center: { lat: number; lng: number };
  map_center: { lat: number; lng: number };
};

export type DealerSignupResult = "too_close" | "eligible" | "manual_review";
export type DealerSignupStatus =
  | "rejected_too_close"
  | "manual_review"
  | "contract_sent"
  | "email_failed";

export type DealerSignupCheckInput = {
  lat: number;
  lng: number;
  address_text: string;
};

export type DealerSignupCheckResult = {
  success: boolean;
  result: DealerSignupResult;
  nearest_distance_m: number | null;
  nearest_dealer_label: string | null;
  distance_provider?: string;
  unlocated_dealer_count?: number;
};

export type DealerSignupSubmitInput = {
  applicant_name: string;
  business_name: string;
  cccd: string;
  cccd_valid_until: string;
  phone: string;
  email: string;
  address_text: string;
  lat: number;
  lng: number;
  terms_accepted: boolean;
  idempotency_key: string;
};

export type DealerSignupSubmitResult = {
  success: boolean;
  result: DealerSignupResult;
  status: DealerSignupStatus;
  application_code: string;
  nearest_distance_m?: number | null;
  email_message_id?: string | null;
};

export type PhotonGeocodeResult = {
  label: string;
  lat: number;
  lng: number;
};

export type PhotonFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class DealerSignupApiError extends Error {
  readonly code: string | null;
  readonly rateLimited: boolean;

  constructor(message: string, code: string | null = null, rateLimited = false) {
    super(message);
    this.name = "DealerSignupApiError";
    this.code = code;
    this.rateLimited = rateLimited;
  }
}

async function invoke<T>(functionName: string, body: Record<string, unknown>): Promise<T> {
  const { callEdgeFunction } = await import("./fetch-with-timeout");
  const { data, error, code, isRateLimited } = await callEdgeFunction<T>(functionName, body);
  if (error || !data) {
    throw new DealerSignupApiError(
      error || "Không kết nối được máy chủ BMQ.",
      code ?? null,
      isRateLimited === true,
    );
  }
  return data;
}

export function getDealerSignupConfig(): Promise<DealerSignupConfig> {
  return invoke<DealerSignupConfig>("dealer-signup-config", {});
}

export function checkDealerSignupLocation(
  input: DealerSignupCheckInput,
): Promise<DealerSignupCheckResult> {
  return invoke<DealerSignupCheckResult>("dealer-signup-check", {
    lat: input.lat,
    lng: input.lng,
    address_text: input.address_text,
  });
}

export function submitDealerSignup(
  input: DealerSignupSubmitInput,
): Promise<DealerSignupSubmitResult> {
  return invoke<DealerSignupSubmitResult>("dealer-signup-submit", { ...input });
}

/** Stable idempotency key for one application form session. */
export function createDealerSignupIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2);
  return `dealer-signup-${Date.now().toString(36)}-${random}`;
}

function textProperty(properties: Record<string, unknown>, key: string): string {
  const value = properties[key];
  return typeof value === "string" ? value.trim() : "";
}

function photonLabel(properties: Record<string, unknown>): string {
  const name = textProperty(properties, "name");
  const houseNumber = textProperty(properties, "housenumber");
  const street = textProperty(properties, "street");
  const district = textProperty(properties, "district");
  const city = textProperty(properties, "city");
  const streetLine = [houseNumber, street].filter(Boolean).join(" ");

  const parts = [name, streetLine, district, city]
    .filter(Boolean)
    .filter((part, index, values) =>
      values.findIndex((value) => value.toLowerCase() === part.toLowerCase()) === index)
    .filter((part) => {
      if (part !== name || !streetLine) return true;
      const lower = part.toLowerCase();
      return !streetLine.toLowerCase().includes(lower) && !lower.includes(streetLine.toLowerCase());
    });

  return parts.join(", ") || "Địa điểm";
}

/**
 * Geocode an address through Photon (OpenStreetMap) inside Vietnam's bbox.
 * lang=default: Photon rejects "vi" with HTTP 400 (only default/de/en/fr);
 * "default" returns local Vietnamese names whatever the browser language.
 * Returns at most five suggestions; provider failures yield an empty list.
 */
export async function geocodeAddressPhoton(
  query: string,
  fetcher: PhotonFetcher = fetch,
): Promise<PhotonGeocodeResult[]> {
  const trimmed = String(query || "").trim();
  if (!trimmed) return [];

  const params = new URLSearchParams({
    q: trimmed,
    limit: "5",
    lang: "default",
    bbox: "102,8,110,24",
  });
  const url = `${DEALER_SIGNUP_GEOCODER_URL}?${params.toString().replace(/%2C/g, ",")}`;

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch {
    return [];
  }

  if (!response.ok) return [];

  let payload: { features?: unknown };
  try {
    payload = await response.json();
  } catch {
    return [];
  }

  if (!Array.isArray(payload?.features)) return [];

  return payload.features.flatMap((feature) => {
    const item = feature as {
      properties?: Record<string, unknown>;
      geometry?: { coordinates?: unknown };
    };
    const coordinates = item?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return [];

    const lng = Number(coordinates[0]);
    const lat = Number(coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return [];

    return [{
      label: photonLabel(item.properties || {}),
      lat,
      lng,
    }];
  });
}
