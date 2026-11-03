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
  | "email_failed"
  | "approved_waiting_slip"
  | "slip_submitted"
  | "active"
  | "rejected_manual";

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
  verification_token: string;
};

export type DealerSignupSubmitResult = {
  success: boolean;
  result: DealerSignupResult;
  status: DealerSignupStatus;
  application_code: string;
  nearest_distance_m?: number | null;
  email_message_id?: string | null;
  dealer_onboarding_status?: "waiting_slip" | "slip_submitted" | "active" | null;
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
  readonly status: number | null;

  constructor(
    message: string,
    code: string | null = null,
    rateLimited = false,
    status: number | null = null,
  ) {
    super(message);
    this.name = "DealerSignupApiError";
    this.code = code;
    this.rateLimited = rateLimited;
    this.status = status;
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

// ---------------------------------------------------------------------------
// CRM review, signed contract and bank slip API
// ---------------------------------------------------------------------------
export type DealerSignupFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type DealerSignupRequestOptions = {
  accessToken?: string;
  fetcher?: DealerSignupFetcher;
  /** Optional override for tests or a non-Vite caller. */
  supabaseUrl?: string;
};

export type DealerSignupReviewAction =
  | "approve"
  | "regenerate_contract"
  | "resend_slip_link"
  | "reject"
  | "download"
  | "confirm_payment"
  | "reject_slip"
  | "get_payment_settings"
  | "set_payment_settings";

export type DealerSignupPaymentSettings = {
  bank_name: string;
  bank_bin: string;
  account_number: string;
  account_name: string;
  amount_vnd: number;
  transfer_note_template: string;
};

export type DealerSignupPaymentInfo = {
  bank_name: string;
  bank_bin: string;
  account_number: string;
  account_name: string;
  amount_vnd: number;
  transfer_note: string;
  qr_url: string;
};

export type DealerSignupDocumentKind = "contract_draft" | "contract_signed" | "slip";

export type DealerSignupReviewResult = {
  success: boolean;
  application_id?: string;
  application_code?: string;
  status?: DealerSignupStatus | string;
  already_approved?: boolean;
  crm_customer_id?: string | null;
  dealer_onboarding_status?: "waiting_slip" | "slip_submitted" | "active" | null;
  contract_ready?: boolean;
  contract_draft_path?: string;
  email_sent?: boolean;
  email_error_code?: string;
  contract_error_code?: string;
  slip_expires_at?: string;
  reject_reason?: string;
  slip_reject_reason?: string;
  payment_confirmed_at?: string | null;
  already_active?: boolean;
  payment_settings?: DealerSignupPaymentSettings | null;
  path?: string;
  uploaded_at?: string;
  url?: string;
  expires_in?: number;
};

export type DealerSignupDocumentUrl = {
  success: boolean;
  application_id?: string;
  application_code?: string;
  kind: DealerSignupDocumentKind;
  url: string;
  expires_in: number;
};

export type DealerSignupSlipStatus = "valid" | "slip_submitted" | "expired" | "used" | "invalid";

export type DealerSignupSlipStatusResult = {
  success: boolean;
  status: DealerSignupSlipStatus;
  application_code?: string;
  business_name?: string;
  can_upload?: boolean;
  payment_info?: DealerSignupPaymentInfo | null;
};

export type DealerSignupSlipUploadResult = {
  success: boolean;
  status: "slip_submitted" | "active";
  already_active?: boolean;
  already_submitted?: boolean;
  application_code?: string;
  business_name?: string;
  email_sent?: boolean;
};

function edgeFunctionUrl(name: string, supabaseUrl?: string): string {
  const base = supabaseUrl ||
    (typeof import.meta.env === "object" && import.meta.env
      ? import.meta.env.VITE_SUPABASE_URL
      : "");
  if (!base) {
    throw new DealerSignupApiError("Thiếu cấu hình Supabase.", "missing_supabase_url");
  }
  return `${String(base).replace(/\/+$/, "")}/functions/v1/${name}`;
}

/** Supabase gateway key, sent like callEdgeFunction does; empty in tests. */
function publishableKeyHeader(): Record<string, string> {
  const key = typeof import.meta.env === "object" && import.meta.env
    ? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
    : "";
  return key ? { apikey: String(key) } : {};
}

async function requireAccessToken(provided?: string): Promise<string> {
  if (provided) return provided;
  const { supabase } = await import("@/integrations/supabase/client");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new DealerSignupApiError(
      "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
      "unauthorized",
      false,
      401,
    );
  }
  return token;
}

async function readApiResponse<T>(response: Response): Promise<T> {
  let payload: Record<string, unknown> = {};
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new DealerSignupApiError(
      String(payload.error || payload.message || `HTTP ${response.status}`),
      typeof payload.code === "string" ? payload.code : null,
      response.status === 429,
      response.status,
    );
  }

  return payload as T;
}

/**
 * One CRM review action. The Edge Function enforces owner / crm edit on the
 * server; this client only forwards the Supabase access token.
 */
export async function reviewDealerSignup(
  input: {
    action: DealerSignupReviewAction;
    applicationId?: string;
    reason?: string;
    kind?: DealerSignupDocumentKind;
    settings?: Partial<DealerSignupPaymentSettings>;
  },
  options: DealerSignupRequestOptions = {},
): Promise<DealerSignupReviewResult> {
  const token = await requireAccessToken(options.accessToken);
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(
    `${edgeFunctionUrl("dealer-signup-review", options.supabaseUrl)}?action=${encodeURIComponent(input.action)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...publishableKeyHeader(),
      },
      body: JSON.stringify({
        action: input.action,
        application_id: input.applicationId,
        reason: input.reason,
        kind: input.kind,
        payment_settings: input.settings,
      }),
    },
  );
  return await readApiResponse<DealerSignupReviewResult>(response);
}

/** Signed URL valid for five minutes; permission is checked server-side. */
export async function getDealerSignupDocumentUrl(
  input: { applicationId: string; kind: DealerSignupDocumentKind },
  options: DealerSignupRequestOptions = {},
): Promise<DealerSignupDocumentUrl> {
  const result = await reviewDealerSignup(
    { action: "download", applicationId: input.applicationId, kind: input.kind },
    options,
  );
  if (!result.success) {
    throw new DealerSignupApiError("Không tải được giấy tờ hồ sơ.", "document_missing");
  }
  return {
    success: true,
    application_id: result.application_id,
    application_code: result.application_code,
    kind: input.kind,
    url: String(result.url || ""),
    expires_in: Number(result.expires_in || 300),
  };
}

/** Accounting/crm edit uploads the stamped contract (multipart). */
export async function uploadDealerSignedContract(
  input: { applicationId: string; file: File },
  options: DealerSignupRequestOptions = {},
): Promise<DealerSignupReviewResult> {
  const token = await requireAccessToken(options.accessToken);
  const fetcher = options.fetcher ?? fetch;
  const form = new FormData();
  form.set("application_id", input.applicationId);
  form.set("file", input.file);

  const response = await fetcher(
    `${edgeFunctionUrl("dealer-signup-review", options.supabaseUrl)}?action=upload_signed_contract`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, ...publishableKeyHeader() },
      body: form,
    },
  );
  return await readApiResponse<DealerSignupReviewResult>(response);
}

/** Public link status; never returns CCCD or phone number. */
export async function getDealerSlipStatus(
  token: string,
  options: { fetcher?: DealerSignupFetcher; supabaseUrl?: string } = {},
): Promise<DealerSignupSlipStatusResult> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(
    `${edgeFunctionUrl("dealer-signup-slip", options.supabaseUrl)}?token=${encodeURIComponent(token)}`,
    { method: "GET", headers: publishableKeyHeader() },
  );
  return await readApiResponse<DealerSignupSlipStatusResult>(response);
}

/** Upload a bank slip with the link token or an existing dealer session. */
export async function uploadDealerSlip(
  input: { file: File; token?: string; dealerToken?: string },
  options: { fetcher?: DealerSignupFetcher; supabaseUrl?: string } = {},
): Promise<DealerSignupSlipUploadResult> {
  const fetcher = options.fetcher ?? fetch;
  const form = new FormData();
  form.set("file", input.file);
  if (input.token) form.set("token", input.token);

  const query = input.token ? `?token=${encodeURIComponent(input.token)}` : "";
  const response = await fetcher(
    `${edgeFunctionUrl("dealer-signup-slip", options.supabaseUrl)}${query}`,
    {
      method: "POST",
      headers: {
        ...publishableKeyHeader(),
        ...(input.dealerToken ? { "x-dealer-session": input.dealerToken } : {}),
      },
      body: form,
    },
  );
  return await readApiResponse<DealerSignupSlipUploadResult>(response);
}

export type DealerSignupVerifyChannel = "phone" | "email";

export type DealerSignupVerifySendResult = {
  success: boolean;
  channel: DealerSignupVerifyChannel;
  sent: boolean;
  already_verified?: boolean;
  expires_at?: string;
  resend_after_seconds?: number;
};

export type DealerSignupVerifyCheckResult = {
  success: boolean;
  verified: { phone: boolean; email: boolean };
  verification_token?: string;
  verification_expires_at?: string;
};

async function publicDealerSignupInvoke<T>(
  functionName: string,
  body: Record<string, unknown>,
  options: { fetcher?: DealerSignupFetcher; supabaseUrl?: string } = {},
): Promise<T> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(
    edgeFunctionUrl(functionName, options.supabaseUrl),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...publishableKeyHeader(),
      },
      body: JSON.stringify(body),
    },
  );
  return await readApiResponse<T>(response);
}

/** One UUID for both OTP channels of a single signup attempt. */
export function createDealerSignupVerificationSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2);
  return `dealer-verify-${Date.now().toString(36)}-${random}`;
}

export function sendDealerSignupVerification(
  input: {
    sessionId: string;
    channel: DealerSignupVerifyChannel;
    phone?: string;
    email?: string;
  },
  options: { fetcher?: DealerSignupFetcher; supabaseUrl?: string } = {},
): Promise<DealerSignupVerifySendResult> {
  return publicDealerSignupInvoke<DealerSignupVerifySendResult>(
    "dealer-signup-verify",
    {
      action: "send",
      session_id: input.sessionId,
      channel: input.channel,
      phone: input.phone,
      email: input.email,
    },
    options,
  );
}

export function checkDealerSignupVerification(
  input: {
    sessionId: string;
    phone?: string;
    email?: string;
    channel?: DealerSignupVerifyChannel;
    code?: string;
    phoneCode?: string;
    emailCode?: string;
  },
  options: { fetcher?: DealerSignupFetcher; supabaseUrl?: string } = {},
): Promise<DealerSignupVerifyCheckResult> {
  return publicDealerSignupInvoke<DealerSignupVerifyCheckResult>(
    "dealer-signup-verify",
    {
      action: "check",
      session_id: input.sessionId,
      phone: input.phone,
      email: input.email,
      channel: input.channel,
      code: input.code,
      phone_code: input.phoneCode,
      email_code: input.emailCode,
    },
    options,
  );
}

export function confirmDealerSignupPayment(
  input: { applicationId: string },
  options: DealerSignupRequestOptions = {},
): Promise<DealerSignupReviewResult> {
  return reviewDealerSignup(
    { action: "confirm_payment", applicationId: input.applicationId },
    options,
  );
}

export function rejectDealerSignupSlip(
  input: { applicationId: string; reason: string },
  options: DealerSignupRequestOptions = {},
): Promise<DealerSignupReviewResult> {
  return reviewDealerSignup(
    { action: "reject_slip", applicationId: input.applicationId, reason: input.reason },
    options,
  );
}

export function getDealerSignupPaymentSettings(
  options: DealerSignupRequestOptions = {},
): Promise<DealerSignupReviewResult> {
  return reviewDealerSignup({ action: "get_payment_settings" }, options);
}

export function setDealerSignupPaymentSettings(
  input: { settings: DealerSignupPaymentSettings },
  options: DealerSignupRequestOptions = {},
): Promise<DealerSignupReviewResult> {
  return reviewDealerSignup(
    { action: "set_payment_settings", settings: input.settings },
    options,
  );
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
