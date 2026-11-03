/**
 * Dealer location pin — client data layer and coordinate parser.
 *
 * No UI is wired here. The parser accepts a pasted pair or a Google Maps link,
 * normalizes swapped latitude/longitude, and rejects anything outside Vietnam.
 * The RPC helpers talk to crm_list_dealer_locations / crm_set_dealer_location.
 */

export const VIETNAM_LAT_MIN = 8;
export const VIETNAM_LAT_MAX = 24;
export const VIETNAM_LNG_MIN = 102;
export const VIETNAM_LNG_MAX = 110;

export const DEALER_LOCATION_SOURCES = [
  "manual_pin",
  "pasted_coordinates",
  "maps_link",
] as const;

export type DealerLocationSource = (typeof DEALER_LOCATION_SOURCES)[number];

export type ParsedDealerCoordinate = {
  lat: number;
  lng: number;
  source: DealerLocationSource;
};

export type DealerLocationRow = {
  id: string;
  customer_name: string;
  customer_group: string | null;
  address: string | null;
  phone: string | null;
  location_lat: number | null;
  location_lng: number | null;
  location_source: string | null;
  location_verified_at: string | null;
};

export type SetDealerLocationInput = {
  customerId: string;
  lat: number | null;
  lng: number | null;
  source: DealerLocationSource | null;
  note?: string | null;
  requestId?: string | null;
  clear?: boolean;
};

export type SetDealerLocationResult = {
  success: boolean;
  customer_id: string;
  location_lat: number | null;
  location_lng: number | null;
  location_verified_at: string | null;
};

type RpcErrorLike = {
  message?: string | null;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
};

export type DealerLocationRpcResult<T> = {
  data: T | null;
  error: RpcErrorLike | null;
};

export type DealerLocationRpcClient = {
  rpc<T = unknown>(
    fn: string,
    args?: Record<string, unknown>,
  ): PromiseLike<DealerLocationRpcResult<T>>;
};

const DEALER_LOCATION_ERROR_CODES = [
  "permission_denied",
  "customer_not_found",
  "customer_inactive",
  "not_a_dealer",
  "outside_vietnam",
  "invalid_source",
  "invalid_coordinate",
  "request_id_conflict",
] as const;

export type DealerLocationErrorCode =
  | (typeof DEALER_LOCATION_ERROR_CODES)[number]
  | "unknown";

const DEALER_LOCATION_ERROR_MESSAGES: Record<DealerLocationErrorCode, string> = {
  permission_denied: "Anh/chị không có quyền ghim vị trí đại lý.",
  customer_not_found: "Không tìm thấy khách hàng.",
  customer_inactive: "Khách hàng đã ngừng hoạt động.",
  not_a_dealer: "Khách hàng không thuộc nhóm đại lý.",
  outside_vietnam: "Tọa độ nằm ngoài Việt Nam.",
  invalid_source: "Nguồn vị trí không hợp lệ.",
  invalid_coordinate: "Tọa độ không hợp lệ.",
  request_id_conflict: "Mã yêu cầu đã được dùng cho khách hàng khác.",
  unknown: "Không lưu được vị trí đại lý.",
};

export class DealerLocationError extends Error {
  readonly code: DealerLocationErrorCode;

  constructor(code: DealerLocationErrorCode, message?: string) {
    super(message || DEALER_LOCATION_ERROR_MESSAGES[code]);
    this.name = "DealerLocationError";
    this.code = code;
  }
}

const NUMBER_PATTERN = String.raw`[+-]?\d+(?:\.\d+)?`;
const PLAIN_COMMA_PAIR = new RegExp(
  String.raw`^\s*(${NUMBER_PATTERN})\s*[,;]\s*(${NUMBER_PATTERN})\s*$`,
);
const PLAIN_SPACE_PAIR = new RegExp(
  String.raw`^\s*(${NUMBER_PATTERN})\s+(${NUMBER_PATTERN})\s*$`,
);
const AT_PAIR = new RegExp(
  String.raw`@(${NUMBER_PATTERN}),(${NUMBER_PATTERN})`,
);
const BANG_PAIR = new RegExp(
  String.raw`!3d(${NUMBER_PATTERN})!4d(${NUMBER_PATTERN})`,
);
const QUERY_PAIR = new RegExp(
  String.raw`[?&](?:q|query|ll|sll)=(${NUMBER_PATTERN})(?:,|%2C)(${NUMBER_PATTERN})`,
  "i",
);

function asFiniteNumber(value: string | number): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function isVietnamCoordinate(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= VIETNAM_LAT_MIN
    && lat <= VIETNAM_LAT_MAX
    && lng >= VIETNAM_LNG_MIN
    && lng <= VIETNAM_LNG_MAX
  );
}

export function roundDealerCoordinate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function coordinateFromPair(
  latText: string,
  lngText: string,
  source: DealerLocationSource,
): ParsedDealerCoordinate | null {
  const lat = asFiniteNumber(latText);
  const lng = asFiniteNumber(lngText);
  if (lat === null || lng === null) return null;

  if (isVietnamCoordinate(lat, lng)) {
    return {
      lat: roundDealerCoordinate(lat),
      lng: roundDealerCoordinate(lng),
      source,
    };
  }

  // Accept "lng, lat" when the user copied the pair the other way around.
  if (isVietnamCoordinate(lng, lat)) {
    return {
      lat: roundDealerCoordinate(lng),
      lng: roundDealerCoordinate(lat),
      source,
    };
  }

  return null;
}

function looksLikeMapLink(text: string): boolean {
  return /^https?:\/\//i.test(text)
    || /(?:^|\.)google\.[a-z.]+\//i.test(text)
    || /maps\.google\.[a-z.]+\//i.test(text)
    || /maps\.app\.goo\.gl\//i.test(text)
    || /goo\.gl\/maps\//i.test(text);
}

function parseMapLink(text: string): ParsedDealerCoordinate | null {
  const bang = text.match(BANG_PAIR);
  if (bang) return coordinateFromPair(bang[1], bang[2], "maps_link");

  const at = text.match(AT_PAIR);
  if (at) return coordinateFromPair(at[1], at[2], "maps_link");

  let url: URL | null = null;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    url = null;
  }

  if (url) {
    for (const key of ["q", "query", "ll", "sll"]) {
      const value = url.searchParams.get(key);
      if (!value) continue;
      const pair = value.match(
        new RegExp(
          String.raw`^\s*(${NUMBER_PATTERN})\s*,\s*(${NUMBER_PATTERN})\s*$`,
        ),
      );
      if (!pair) continue;
      const coordinate = coordinateFromPair(pair[1], pair[2], "maps_link");
      if (coordinate) return coordinate;
    }
  }

  const query = text.match(QUERY_PAIR);
  if (query) return coordinateFromPair(query[1], query[2], "maps_link");

  return null;
}

/**
 * Parse "10.7769, 106.7009", "10.7769 106.7009" or a Google Maps link
 * (@lat,lng, ?q=lat,lng, !3dlat!4dlng). Returns null for garbage or a point
 * outside Vietnam's bounding box.
 */
export function parseCoordinateInput(
  text: string | null | undefined,
): ParsedDealerCoordinate | null {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;

  if (looksLikeMapLink(trimmed)) {
    return parseMapLink(trimmed);
  }

  const commaPair = trimmed.match(PLAIN_COMMA_PAIR);
  if (commaPair) {
    return coordinateFromPair(commaPair[1], commaPair[2], "pasted_coordinates");
  }

  const spacePair = trimmed.match(PLAIN_SPACE_PAIR);
  if (spacePair) {
    return coordinateFromPair(spacePair[1], spacePair[2], "pasted_coordinates");
  }

  return null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function normalizeDealerLocationRow(raw: unknown): DealerLocationRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = asText(row.id);
  const customerName = asText(row.customer_name);
  if (!id || !customerName) return null;

  return {
    id,
    customer_name: customerName,
    customer_group: asText(row.customer_group),
    address: asText(row.address),
    phone: asText(row.phone),
    location_lat: asNumber(row.location_lat),
    location_lng: asNumber(row.location_lng),
    location_source: asText(row.location_source),
    location_verified_at: asText(row.location_verified_at),
  };
}

function toDealerLocationError(error: RpcErrorLike): DealerLocationError {
  const raw = error.message || "";
  const code = DEALER_LOCATION_ERROR_CODES.find((candidate) =>
    raw.includes(candidate)
  );
  if (code) return new DealerLocationError(code, raw);
  return new DealerLocationError("unknown", raw || undefined);
}

/** Stable retry key: pass the same value when the operator clicks twice. */
export function createDealerLocationRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2);
  return `dealer-location-${Date.now().toString(36)}-${random}`;
}

export async function listDealerLocations(
  client: DealerLocationRpcClient,
): Promise<DealerLocationRow[]> {
  const { data, error } = await client.rpc<unknown>(
    "crm_list_dealer_locations",
  );

  if (error) throw toDealerLocationError(error);
  if (!Array.isArray(data)) return [];

  return data
    .map(normalizeDealerLocationRow)
    .filter((row): row is DealerLocationRow => row !== null);
}

export async function setDealerLocation(
  input: SetDealerLocationInput,
  client: DealerLocationRpcClient,
): Promise<SetDealerLocationResult> {
  const clear = input.clear === true;
  const { data, error } = await client.rpc<unknown>("crm_set_dealer_location", {
    p_customer_id: input.customerId,
    p_lat: clear ? null : input.lat,
    p_lng: clear ? null : input.lng,
    p_source: clear ? null : input.source,
    p_note: input.note ?? null,
    p_request_id: input.requestId ?? null,
    p_clear: clear,
  });

  if (error) throw toDealerLocationError(error);
  if (!data || typeof data !== "object") {
    throw new DealerLocationError("unknown");
  }

  const result = data as Record<string, unknown>;
  return {
    success: result.success === true,
    customer_id: asText(result.customer_id) ?? input.customerId,
    location_lat: asNumber(result.location_lat),
    location_lng: asNumber(result.location_lng),
    location_verified_at: asText(result.location_verified_at),
  };
}

export function pinDealerLocation(
  input: {
    customerId: string;
    lat: number;
    lng: number;
    source: DealerLocationSource;
    note?: string | null;
    requestId?: string | null;
  },
  client: DealerLocationRpcClient,
): Promise<SetDealerLocationResult> {
  return setDealerLocation({ ...input, clear: false }, client);
}

export function clearDealerLocation(
  input: {
    customerId: string;
    note?: string | null;
    requestId?: string | null;
  },
  client: DealerLocationRpcClient,
): Promise<SetDealerLocationResult> {
  return setDealerLocation({
    customerId: input.customerId,
    lat: null,
    lng: null,
    source: null,
    note: input.note ?? null,
    requestId: input.requestId ?? null,
    clear: true,
  }, client);
}
