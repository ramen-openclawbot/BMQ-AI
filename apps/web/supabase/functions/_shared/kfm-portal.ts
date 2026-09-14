/**
 * KFM / Seedcom partner portal client (HTTP-only, no browser).
 *
 * Verified contract (2026-09-12, read from the portal SPA bundles):
 *   SSO   : GET  {SSO}/oauth2/authorize?response_type=code&client_id=...&redirect_uri=...
 *             &scope=openid profile email&state=...&code_challenge=...&code_challenge_method=S256
 *             -> 302 to {SSO}/login, which carries the _csrf form
 *           POST {SSO}/login  (_csrf, username, password) -> 302, usually to /login?error=authorize
 *             EVEN WHEN THE CREDENTIAL IS ACCEPTED; re-issuing the authorize request
 *             on that same session is what returns the {redirect_uri}?code=... redirect
 *   Token : POST {SCE}/auth/sso/sce/exchange  { code, codeVerifier, redirectUri, clientId }
 *             -> { success, accessToken, refreshToken }
 *           POST {SCE}/auth/sso/sce/refresh   { refreshToken, clientId }
 *             -> { success, token, refreshToken }
 *   Read  : GET  {SCE}/api/v1/portal/me
 *           GET  {SCE}/api/v1/portal/orders?vendorId=&page=&size=&deliveryDateFrom=&deliveryDateTo=
 *
 * This module is READ-ONLY against the portal. It never confirms an order,
 * never submits an ASN, and never writes to the partner system.
 *
 * Secrets are read from the Edge Function environment only; they are never
 * logged, returned, or embedded in error messages.
 */

export const SSO_BASE = "https://sso.seedcom.vn/uaa";
export const SCE_API = "https://logis.seedcom.vn/sce-api";
export const SCE_CLIENT_ID = "sce-client-1i15ym2j";
export const PORTAL_ORIGIN = "https://partners.seedcom.vn";

/** Registered OAuth2 redirect target of the portal SPA (its `getSsoCallbackUrl`). */
export const SSO_CALLBACK_URL = `${PORTAL_ORIGIN}/sce/oauth`;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

export type KfmSession = {
  token: string;
  refreshToken: string;
  mode: "refresh" | "login";
  obtainedAt: string;
};

export type KfmOrder = {
  portalId: number;
  code: string;
  status: number | null;
  subStatus: number | null;
  deliveryDate: string | null;
  vendorId: number | null;
  vendorCode: string | null;
  vendorName: string | null;
  locationCode: string | null;
  locationName: string | null;
  itemCount: number | null;
  totalQty: number | null;
  orderTotal: number | null;
  taxTotal: number | null;
  orderTotalWithTax: number | null;
  vendorConfirmedAt: string | null;
  createdAt: string | null;
};

export class KfmPortalError extends Error {
  status: number;
  step: string;
  /** Technical breadcrumb for operators: which URL we hit and where we landed. */
  detail?: string;
  constructor(step: string, status: number, message: string) {
    super(message);
    this.name = "KfmPortalError";
    this.step = step;
    this.status = status;
  }
}

/** Minimal cookie jar: the SSO login needs JSESSIONID kept between GET and POST. */
class CookieJar {
  private store = new Map<string, string>();

  absorb(response: Response): void {
    const raw: string[] =
      typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : [];
    for (const line of raw) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "") this.store.delete(name);
      else this.store.set(name, value);
    }
  }

  header(): string {
    return Array.from(this.store.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

async function request(
  jar: CookieJar | null,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers || {});
  headers.set("User-Agent", USER_AGENT);
  if (!headers.has("Accept")) headers.set("Accept", "application/json, text/plain, */*");
  if (jar) {
    const cookie = jar.header();
    if (cookie) headers.set("Cookie", cookie);
  }
  const response = await fetch(url, { ...init, headers, redirect: "manual" });
  if (jar) jar.absorb(response);
  return response;
}

function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/** base64url, no padding — the encoding PKCE expects. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE pair — the verifier stays in this process, only the challenge goes to SSO. */
async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function absolute(url: string, base: string): string {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/** Read one query parameter off an absolute redirect target. */
function paramFromLocation(location: string, name: string): string {
  try {
    return new URL(location).searchParams.get(name) ?? "";
  } catch {
    return "";
  }
}

/**
 * Path and query KEYS only (never values) — enough to tell a wrong-path redirect
 * apart from a rejected password without leaking anything sensitive.
 */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    const keys = Array.from(parsed.searchParams.keys()).join(",");
    return keys ? `${parsed.pathname}?${keys}` : parsed.pathname;
  } catch {
    return url.slice(0, 120);
  }
}

function readLoginForm(html: string, pageUrl: string): { csrf: string; action: string } {
  const inputs = html.match(/<input[^>]*>/gi) || [];
  let csrf = "";
  for (const tag of inputs) {
    if (/name=["']_csrf["']/i.test(tag)) {
      const value = tag.match(/value=["']([^"']*)["']/i);
      csrf = value ? value[1] : "";
      break;
    }
  }
  const actionMatch = html.match(/<form[^>]*action=["']([^"']+)["']/i);
  // Resolve against the page URL, the way a browser would. The action already
  // carries the /uaa context path, so joining it to SSO_BASE posts to
  // /uaa/uaa/login — a path that answers with a redirect to /login and therefore
  // looks exactly like a rejected password.
  const action = absolute(actionMatch ? actionMatch[1] : "login", pageUrl);
  return { csrf, action };
}

/** The PKCE authorize request that tells SSO which client we are. */
function authorizeRequest(state: string, challenge: string): string {
  const authorize = new URL(`${SSO_BASE}/oauth2/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", SCE_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", SSO_CALLBACK_URL);
  authorize.searchParams.set("scope", "openid profile email");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return authorize.toString();
}

/**
 * Step 1 — start the OAuth2 authorization-code flow (PKCE) and land on the login
 * form. The authorize request is what tells SSO which client we are; posting
 * straight to /login without it returns a redirect that carries no code.
 */
async function beginLogin(
  jar: CookieJar,
  state: string,
  challenge: string,
): Promise<{ csrf: string; action: string }> {
  let pageUrl = authorizeRequest(state, challenge);
  let response = await request(jar, pageUrl);
  for (let hop = 0; hop < 6 && REDIRECT_STATUS.has(response.status); hop++) {
    const location = response.headers.get("location");
    if (!location) break;
    pageUrl = absolute(location, pageUrl);
    response = await request(jar, pageUrl);
  }
  const html = await response.text();
  if (response.status !== 200) {
    throw new KfmPortalError("sso_form", response.status, "Không mở được trang đăng nhập SSO");
  }
  const form = readLoginForm(html, pageUrl);
  if (!form.csrf) {
    throw new KfmPortalError("sso_form", 200, "Trang SSO không có _csrf — cấu trúc form đã đổi");
  }
  return form;
}

/**
 * Re-issue the authorize request on an already-authenticated session and follow
 * the chain until it carries `?code=`.
 */
async function replayAuthorize(
  jar: CookieJar,
  authorizeUrl: string,
): Promise<{ location: string; response: Response }> {
  let pageUrl = authorizeUrl;
  let response = await request(jar, pageUrl);
  let location = response.headers.get("location") || "";
  for (let hop = 0; hop < 8 && location && !paramFromLocation(location, "code"); hop++) {
    if (location.includes("/login")) break;
    pageUrl = absolute(location, pageUrl);
    response = await request(jar, pageUrl);
    location = response.headers.get("location") || "";
  }
  return { location, response };
}

type TokenPayload = {
  success?: boolean;
  token?: string;
  accessToken?: string;
  refreshToken?: string;
  message?: string;
};

function readTokens(step: "login" | "refresh", status: number, payload: TokenPayload): KfmSession | null {
  if (status !== 200 || !payload?.success) return null;
  // The exchange endpoint answers with `accessToken`; the refresh endpoint with `token`.
  const token = step === "refresh" ? payload.token : (payload.accessToken ?? payload.token);
  if (!token) return null;
  return {
    token,
    refreshToken: payload.refreshToken || "",
    mode: step,
    obtainedAt: new Date().toISOString(),
  };
}

/** Step 2a — renew an existing session without the password. */
export async function refreshSession(refreshToken: string): Promise<KfmSession | null> {
  if (!refreshToken) return null;
  const response = await request(null, `${SCE_API}/auth/sso/sce/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken, clientId: SCE_CLIENT_ID }),
  });
  let payload: TokenPayload = {};
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  return readTokens("refresh", response.status, payload);
}

/** Step 2b — full HTTP login. Never log `username`/`password`. */
export async function loginWithPassword(
  username: string,
  password: string,
): Promise<KfmSession> {
  if (!username || !password) {
    throw new KfmPortalError("login", 0, "Thiếu thông tin đăng nhập cổng KFM");
  }
  const jar = new CookieJar();
  const { verifier, challenge } = await createPkcePair();
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const { csrf, action } = await beginLogin(jar, state, challenge);

  let response = await request(jar, action, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode({ username, password, _csrf: csrf }),
  });

  // SSO answers with a redirect chain: login -> authorize -> {redirect_uri}?code=...
  //
  // Measured behaviour (2026-09-13): even when the credential is ACCEPTED, SSO
  // bounces the POST back to /login?error=authorize. That POST did authenticate
  // the session, but the saved authorize request is not replayed, so no code
  // comes back. Reading that bounce as "wrong password" is a false negative.
  // The session is real, so ask the authorize endpoint again on it.
  let location = response.headers.get("location") || "";
  for (
    let hop = 0;
    hop < 6 && location && !paramFromLocation(location, "code") && !location.includes("/login");
    hop++
  ) {
    response = await request(jar, absolute(location, SSO_BASE));
    location = response.headers.get("location") || "";
  }

  if (!paramFromLocation(location, "code")) {
    const replay = await replayAuthorize(jar, authorizeRequest(state, challenge));
    location = replay.location;
    response = replay.response;
  }

  const code = paramFromLocation(location, "code");
  if (!code) {
    const failure = new KfmPortalError(
      "login",
      response.status,
      "Cổng KFM từ chối tài khoản hoặc mật khẩu",
    );
    failure.detail = `POST ${pathOf(action)} -> ${pathOf(location || "(không chuyển hướng)")}`;
    throw failure;
  }
  const returnedState = paramFromLocation(location, "state");
  if (returnedState && returnedState !== state) {
    throw new KfmPortalError("login", response.status, "SSO trả về state không khớp");
  }

  const exchange = await request(null, `${SCE_API}/auth/sso/sce/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      codeVerifier: verifier,
      redirectUri: SSO_CALLBACK_URL,
      clientId: SCE_CLIENT_ID,
    }),
  });
  let payload: TokenPayload = {};
  try {
    payload = await exchange.json();
  } catch {
    throw new KfmPortalError("exchange", exchange.status, "Phản hồi đổi token không phải JSON");
  }
  const session = readTokens("login", exchange.status, payload);
  if (!session) {
    throw new KfmPortalError("exchange", exchange.status, "Đổi mã SSO không thành công");
  }
  return session;
}

/**
 * Obtain a session for this call: prefer the stored refresh token, fall back to
 * a fresh HTTP login. Never retries the password more than once.
 */
export async function openSession(env: {
  username?: string;
  password?: string;
  refreshToken?: string;
}): Promise<KfmSession> {
  if (env.refreshToken) {
    const renewed = await refreshSession(env.refreshToken);
    if (renewed) return renewed;
  }
  return await loginWithPassword(env.username || "", env.password || "");
}

async function authedGet(token: string, url: string): Promise<{ status: number; body: any }> {
  const response = await request(null, url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

export async function getMe(token: string): Promise<{
  vendorIds: number[];
  vendorCode: string | null;
  vendorName: string | null;
  username: string | null;
}> {
  const { status, body } = await authedGet(token, `${SCE_API}/api/v1/portal/me`);
  if (status !== 200) {
    throw new KfmPortalError("me", status, "Không đọc được thông tin nhà cung cấp");
  }
  const data = body?.data || {};
  const vendorIds = Array.isArray(data.vendorIds)
    ? data.vendorIds.filter((v: unknown): v is number => typeof v === "number")
    : [];
  return {
    vendorIds,
    vendorCode: data.vendorCode ?? null,
    vendorName: data.vendorName ?? null,
    username: data.username ?? null,
  };
}

const asNumber = (value: unknown): number | null => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/** Map a portal order row to BMQ's stable shape. */
export function normalizeOrder(row: Record<string, unknown>): KfmOrder {
  return {
    portalId: Number(row.id),
    code: String(row.code ?? ""),
    status: asNumber(row.status),
    subStatus: asNumber(row.subStatus),
    deliveryDate: asString(row.deliveryDate),
    vendorId: asNumber(row.vendorId),
    vendorCode: asString(row.vendorCode),
    vendorName: asString(row.vendorName),
    locationCode: asString(row.locationCode),
    locationName: asString(row.locationName),
    itemCount: asNumber(row.itemCount),
    totalQty: asNumber(row.totalQty),
    orderTotal: asNumber(row.orderTotal),
    taxTotal: asNumber(row.taxTotal),
    orderTotalWithTax: asNumber(row.orderTotalWithTax),
    vendorConfirmedAt: asString(row.vendorConfirmedAt),
    createdAt: asString(row.createdAt),
  };
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ListOrdersOptions = {
  vendorId: number;
  deliveryDateFrom?: string;
  deliveryDateTo?: string;
  page?: number;
  size?: number;
};

export async function listOrders(
  token: string,
  options: ListOrdersOptions,
): Promise<{ orders: KfmOrder[]; totalElements: number }> {
  const { vendorId } = options;
  if (!Number.isInteger(vendorId) || vendorId <= 0) {
    throw new KfmPortalError("orders", 0, "Thiếu vendorId hợp lệ");
  }
  for (const value of [options.deliveryDateFrom, options.deliveryDateTo]) {
    if (value !== undefined && !ISO_DATE.test(value)) {
      throw new KfmPortalError("orders", 0, "Ngày giao phải theo định dạng YYYY-MM-DD");
    }
  }
  const query = new URLSearchParams({
    vendorId: String(vendorId),
    page: String(options.page ?? 0),
    size: String(options.size ?? 50),
  });
  if (options.deliveryDateFrom) query.set("deliveryDateFrom", options.deliveryDateFrom);
  if (options.deliveryDateTo) query.set("deliveryDateTo", options.deliveryDateTo);

  const { status, body } = await authedGet(
    token,
    `${SCE_API}/api/v1/portal/orders?${query.toString()}`,
  );
  if (status !== 200) {
    throw new KfmPortalError("orders", status, "Không đọc được danh sách đơn từ cổng KFM");
  }
  const data = body?.data || {};
  const rows: Record<string, unknown>[] = Array.isArray(data.content) ? data.content : [];
  return {
    orders: rows.map(normalizeOrder),
    totalElements: asNumber(data.totalElements) ?? rows.length,
  };
}

/** Vietnam-time (UTC+7) ISO date, used as the default delivery date. */
export function vnDate(offsetDays = 0, now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + offsetDays * 86_400_000 + 7 * 3_600_000);
  return shifted.toISOString().slice(0, 10);
}

/** Business-friendly status label for the BMQ UI. */
export function statusLabel(status: number | null, subStatus: number | null): string {
  if (status === null) return "khong_ro";
  if (status === 3 || subStatus === 5) return "cho_giao";
  if (status === 5) return "da_giao";
  if (status === 6) return "huy";
  return `trang_thai_${status}`;
}

/* ------------------------------------------------------------------ *
 * Operator actions on the partner portal (confirm + printed documents).
 *
 * Verified against the portal SPA bundle (2026-09-13). Every call below is
 * made because an operator pressed a button in the BMQ UI; none of them is
 * scheduled, retried or fired by a background job.
 *   confirm   POST /api/v1/portal/orders/{id}/confirm?vendorId=
 *   detail    GET  /api/v1/portal/orders/{id}?vendorId=
 *   asns      GET  /api/v1/portal/orders/{id}/asn?vendorId=
 *   PO print  GET  /api/v1/purchase-orders/{id}/export-pdf
 *   ASN print GET  /api/v1/portal/asn/{id}/export-pdf?vendorId=&poId=&hidePrice=
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Delivery trips — the portal's "chuyến xe giao hàng" (inbound load IL-…).
 *
 * This is the only surface that carries the person who drives and the truck:
 * the order list does not. Verified live against the portal on 2026-09-13
 * (vendor V000217) — the field names below are the ones the API really sends.
 *   list   GET /api/v1/portal/inbound-loads?vendorId=&page=&size=&deliveryDate=
 *   detail GET /api/v1/portal/inbound-loads/{id}?vendorId=
 *   print  GET /api/v1/portal/inbound-loads/{id}/export-pdf?vendorId=&hidePrice=
 *
 * Read-only. Dispatch ("Giao hàng"), confirm, cancel and merge stay on the
 * portal and are never called from here.
 * ------------------------------------------------------------------ */

export type KfmDeliveryPlace = {
  locationId: number | null;
  locationName: string | null;
  asnStatus: string | null;
};

export type KfmDeliveryAsn = {
  asnId: number;
  asnCode: string | null;
  asnStatus: string | null;
  locationName: string | null;
  bookingTimeSlot: string | null;
  totalShipQty: number | null;
};

export type KfmDeliveryLoad = {
  portalId: number;
  loadCode: string | null;
  deliveryDate: string | null;
  /** Raw portal status (`DRAFT`/`CONFIRMED`/`DISPATCHED`/`RECEIVED`/`CANCELLED`). */
  status: string | null;
  driverName: string | null;
  driverPhone: string | null;
  /** The portal sends the plate as `licensePlate` (no plate key on the order rows). */
  licensePlate: string | null;
  vehicleTypeName: string | null;
  asnCount: number | null;
  bookingStartDatetime: string | null;
  bookingEndDatetime: string | null;
  note: string | null;
  places: KfmDeliveryPlace[];
  asns: KfmDeliveryAsn[];
};

/** Map one portal inbound-load row to BMQ's stable shape. */
export function normalizeDeliveryLoad(row: Record<string, unknown>): KfmDeliveryLoad {
  const places: Record<string, unknown>[] = Array.isArray(row.locations) ? row.locations : [];
  const asns: Record<string, unknown>[] = Array.isArray(row.asns) ? row.asns : [];
  return {
    portalId: Number(row.id),
    loadCode: asString(row.loadCode),
    deliveryDate: asString(row.deliveryDate),
    status: asString(row.loadStatus),
    driverName: asString(row.driverName),
    driverPhone: asString(row.driverPhone),
    licensePlate: asString(row.licensePlate),
    vehicleTypeName: asString(row.vehicleTypeName),
    asnCount: asNumber(row.asnCount),
    bookingStartDatetime: asString(row.bookingStartDatetime),
    bookingEndDatetime: asString(row.bookingEndDatetime),
    note: asString(row.note),
    places: places.map((place) => ({
      locationId: asNumber(place.locationId),
      locationName: asString(place.locationName),
      asnStatus: asString(place.asnStatus),
    })),
    asns: asns
      .map((asn) => ({
        asnId: Number(asn.id),
        asnCode: asString(asn.asnCode),
        asnStatus: asString(asn.asnStatus),
        locationName: asString(asn.locationName),
        bookingTimeSlot: asString(asn.bookingTimeSlot),
        totalShipQty: asNumber(asn.totalShipQty),
      }))
      .filter((asn) => Number.isFinite(asn.asnId) && asn.asnId > 0),
  };
}

/** Delivery trips of one vendor, newest portal page first. */
export async function listDeliveryLoads(
  token: string,
  options: { vendorId: number; deliveryDate?: string; page?: number; size?: number },
): Promise<{ loads: KfmDeliveryLoad[]; totalElements: number; counts: Record<string, number> }> {
  const { vendorId } = options;
  if (!Number.isInteger(vendorId) || vendorId <= 0) {
    throw new KfmPortalError("loads", 0, "Thiếu vendorId hợp lệ");
  }
  if (options.deliveryDate !== undefined && !ISO_DATE.test(options.deliveryDate)) {
    throw new KfmPortalError("loads", 0, "Ngày giao phải theo định dạng YYYY-MM-DD");
  }
  const query = new URLSearchParams({
    vendorId: String(vendorId),
    page: String(options.page ?? 0),
    size: String(options.size ?? 20),
  });
  if (options.deliveryDate) query.set("deliveryDate", options.deliveryDate);

  const { status, body } = await authedGet(
    token,
    `${SCE_API}/api/v1/portal/inbound-loads?${query.toString()}`,
  );
  if (status !== 200) {
    throw new KfmPortalError("loads", status, "Không đọc được danh sách chuyến giao từ cổng KFM");
  }
  const data = body?.data || {};
  const rows: Record<string, unknown>[] = Array.isArray(data.content) ? data.content : [];
  return {
    loads: rows.map(normalizeDeliveryLoad),
    totalElements: asNumber(data.totalElements) ?? rows.length,
    counts: await loadCounts(token, vendorId),
  };
}

/** Trip counters per portal status. Read-only, and never fatal for the list. */
async function loadCounts(token: string, vendorId: number): Promise<Record<string, number>> {
  const { status, body } = await authedGet(
    token,
    `${SCE_API}/api/v1/portal/inbound-loads/counts?vendorId=${vendorId}`,
  );
  const data = status === 200 ? (body?.data || {}) : {};
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const n = asNumber(value);
    if (n !== null) counts[key] = n;
  }
  return counts;
}

/** GET one trip with its delivery places and the delivery notes on it. */
export async function getDeliveryLoad(
  token: string,
  options: { vendorId: number; loadId: number },
): Promise<KfmDeliveryLoad> {
  const { status, body } = await authedGet(
    token,
    `${SCE_API}/api/v1/portal/inbound-loads/${options.loadId}?vendorId=${options.vendorId}`,
  );
  if (status !== 200) {
    throw new KfmPortalError("load_detail", status, "Không đọc được chi tiết chuyến giao");
  }
  const data = ((body?.data ?? body) || {}) as Record<string, unknown>;
  return normalizeDeliveryLoad(data);
}

/** The two layouts the portal's print menu offers. `FULL` carries prices. */
export type KfmPrintLayout = "FULL" | "NO_PRICE";

/**
 * Print the delivery note of one trip. The portal's own default layout carries
 * prices (`FULL`); `NO_PRICE` is the alternative it offers in the print menu.
 */
export async function fetchLoadPdf(
  token: string,
  options: { loadId: number; vendorId: number; layout?: KfmPrintLayout },
): Promise<Uint8Array> {
  const query = new URLSearchParams({ vendorId: String(options.vendorId) });
  const layout = options.layout ?? "FULL";
  if (layout === "NO_PRICE") query.set("hidePrice", "true");
  if (layout !== "FULL") query.set("layout", layout);
  return await fetchDocument(
    token,
    `${SCE_API}/api/v1/portal/inbound-loads/${options.loadId}/export-pdf?${query.toString()}`,
    "load_pdf",
  );
}

export type KfmOrderLine = {
  productCode: string | null;
  productName: string | null;
  unit: string | null;
  orderedQty: number | null;
  shippedQty: number | null;
};

export type KfmOrderDetail = {
  portalId: number;
  code: string | null;
  /** The purchase order behind the portal order — needed to print the PO. */
  purchaseOrderId: number | null;
  /** Warehouse the order is delivered to — the trip body's `stops[].locationId`. */
  locationId: number | null;
  lines: KfmOrderLine[];
};

/** GET one portal order with its lines and the purchase order it belongs to. */
export async function getOrderDetail(
  token: string,
  options: { vendorId: number; orderId: number },
): Promise<KfmOrderDetail> {
  const { status, body } = await authedGet(
    token,
    `${SCE_API}/api/v1/portal/orders/${options.orderId}?vendorId=${options.vendorId}`,
  );
  if (status !== 200) {
    throw new KfmPortalError("order_detail", status, "Không đọc được chi tiết đơn từ cổng KFM");
  }
  const data = ((body?.data ?? body) || {}) as Record<string, unknown>;
  const purchaseOrder = ((data.purchaseOrder ?? {}) as Record<string, unknown>);
  const rows: Record<string, unknown>[] = Array.isArray(data.items) ? data.items : [];
  return {
    portalId: asNumber(data.id) ?? options.orderId,
    code: asString(data.code),
    purchaseOrderId:
      asNumber(purchaseOrder.id) ?? asNumber(data.purchaseOrderId) ?? asNumber(data.poId),
    locationId: asNumber(data.locationId),

    lines: rows.map((row) => ({
      productCode: asString(row.productCode) ?? asString(row.barcode),
      productName: asString(row.productName),
      unit: asString(row.unit) ?? asString(row.unitName),
      orderedQty: asNumber(row.orderedQty) ?? asNumber(row.quantity) ?? asNumber(row.poQty),
      shippedQty: asNumber(row.shippedQty) ?? asNumber(row.shipQty),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Delivery-trip draft (read-only).
 *
 * The portal raises a delivery note through its trip form, and that form
 * builds `stops[].items[]` out of the purchase order's own print data
 * (`GET /api/v1/purchase-orders/{id}/print-data` -> `{po, items, shippedMap}`).
 * The mapping below is the portal's own, copied from its load-detail container,
 * so what this previews is what the portal would really send:
 *
 *   qty     = approvalStatus === "APPROVED" && finalQuantity != null
 *               ? finalQuantity : qty ?? orderedQty ?? quantity ?? 0
 *   shipped = shippedMap[productCode || internalCode] || 0
 *   the row is dropped when shipped >= qty   (nothing left to deliver)
 *   item    = { poId, poCode, poItemId, variantId, productCode, barcode,
 *               productName, unitName, shipQty: qty, cartons: 0 }
 *   stop    = { locationId: po.locationId, totalCartons: 0, totalPallets: 0, items }
 *
 * `shipQty` is therefore the ORDERED quantity, and `cartons` is always 0 — both
 * are what the portal itself sends. `totalCartons`/`totalPallets` are typed by
 * hand on the portal's screen, so they start at 0 here too.
 *
 * Nothing here posts: the draft is built in memory and returned for review.
 * ------------------------------------------------------------------ */

export type KfmTripItem = {
  poId: number;
  poCode: string;
  poItemId: number;
  variantId: number | null;
  productCode: string;
  barcode: string;
  productName: string;
  unitName: string;
  shipQty: number;
  cartons: number;
};

export type KfmTripStop = {
  locationId: number | null;
  totalCartons: number;
  totalPallets: number;
  items: KfmTripItem[];
};

export type KfmTripDraft = {
  deliveryDate: string;
  vehicleTypeId: number | null;
  stops: KfmTripStop[];
};

export type KfmTripSource = {
  /** The purchase order behind the portal order — it carries `locationId`. */
  po: Record<string, unknown>;
  /** Order lines, with the portal's own approved-quantity mapping applied. */
  items: Record<string, unknown>[];
  /** Product code -> quantity already delivered against it. */
  shippedMap: Record<string, number>;
};

/**
 * The payload the portal's trip form reads. It is the SAME read the panel's
 * order detail uses — `GET /api/v1/portal/orders/{id}?vendorId=` — because the
 * portal's own container feeds its trip builder from
 * `useLazyGetPortalOrderDetailQuery({ id, vendorId })`.
 *
 * The portal then rewrites `items` in its `transformResponse`: a RESOLVED
 * QUANTITY request on a product code turns into `finalQuantity` plus
 * `approvalStatus: "APPROVED"`. That rewritten shape is what decides how much
 * of a line goes on the trip, so it is applied here too.
 */
export async function getTripSource(
  token: string,
  options: { vendorId: number; orderId: number },
): Promise<KfmTripSource> {
  const { status, body } = await authedGet(
    token,
    `${SCE_API}/api/v1/portal/orders/${options.orderId}?vendorId=${options.vendorId}`,
  );
  if (status !== 200) {
    throw new KfmPortalError("trip_source", status, "Không đọc được đơn từ cổng KFM");
  }
  const data = ((body?.data ?? body) || {}) as Record<string, unknown>;
  const po = ((data.po ?? data.purchaseOrder ?? data) || {}) as Record<string, unknown>;
  const rows: Record<string, unknown>[] = Array.isArray(data.items) ? data.items : [];

  const approved = approvedQuantities(data);
  const shippedMap: Record<string, number> = {};
  for (const [key, value] of Object.entries((data.shippedMap ?? {}) as Record<string, unknown>)) {
    const n = asNumber(value);
    if (n !== null) shippedMap[key] = n;
  }

  return {
    po,
    items: rows.map((row) => {
      const productCode = asString(row.productCode) ?? asString(row.internalCode) ?? "";
      const finalQuantity = approved.get(productCode);
      return finalQuantity === undefined
        ? row
        : { ...row, finalQuantity, approvalStatus: "APPROVED" };
    }),
    shippedMap,
  };
}

/**
 * The portal's own approved-quantity map: product code -> proposed quantity,
 * taken from the RESOLVED quantity requests of the order. Requests of any other
 * kind (or any other status) are ignored, exactly as the portal ignores them.
 */
function approvedQuantities(data: Record<string, unknown>): Map<string, number> {
  const requests: Record<string, unknown>[] = Array.isArray(data.requests) ? data.requests : [];
  const requestItems: Record<string, unknown>[] = Array.isArray(data.requestItems)
    ? data.requestItems
    : [];
  const approved = new Map<string, number>();
  if (requests.length === 0 || requestItems.length === 0) return approved;
  for (const item of requestItems) {
    const parent = requests.find(
      (request) => request.id === (item.requestId ?? (item.request as Record<string, unknown>)?.id),
    );
    if (!parent || asString(parent.status) !== "RESOLVED") continue;
    const category = asString(item.requestCategory);
    if (category && category !== "QUANTITY") continue;
    const code = asString(item.productCode);
    const qty = asNumber(item.proposedQty) ?? asNumber(item.proposedValue);
    if (code && qty !== null) approved.set(code, qty);
  }
  return approved;
}

/**
 * The portal's own "how much of this line is going on the trip" rule.
 * The approved request quantity wins over the ordered one; when nothing was
 * approved the ordered quantity is used.
 */
export function tripShipQty(row: Record<string, unknown>): number {
  if (asString(row.approvalStatus) === "APPROVED") {
    const approved = asNumber(row.finalQuantity);
    if (approved !== null) return approved;
  }
  return (
    asNumber(row.qty) ?? asNumber(row.orderedQty) ?? asNumber(row.quantity) ?? 0
  );
}

/**
 * Map the purchase order's own rows to the portal's trip items, dropping the
 * lines it has already delivered in full. Field names and order are the ones
 * the portal's `createLoad` body carries.
 */
export function buildTripItems(
  po: Record<string, unknown>,
  rows: Record<string, unknown>[],
  shippedMap: Record<string, number>,
): { items: KfmTripItem[]; skipped: number } {
  const poId = asNumber(po.id) ?? 0;
  const poCode = asString(po.code) ?? "";
  const items: KfmTripItem[] = [];
  let skipped = 0;
  for (const row of rows) {
    const shipQty = tripShipQty(row);
    const productCode =
      asString(row.productCode) ?? asString(row.internalCode) ?? "";
    const shipped = shippedMap[productCode] ?? 0;
    if (shipped >= shipQty) {
      skipped += 1;
      continue;
    }
    items.push({
      poId,
      poCode,
      poItemId: asNumber(row.id) ?? 0,
      variantId: asNumber(row.variantId),
      productCode,
      barcode: asString(row.barcode) ?? "",
      productName: asString(row.productName) ?? "",
      unitName: asString(row.uomName) ?? asString(row.unitName) ?? "",
      shipQty,
      cartons: 0,
    });
  }
  return { items, skipped };
}

/**
 * Build the trip body for ONE order without sending it. Returns the exact
 * object `createLoad` would post, plus what was dropped on the way, so the
 * operator can compare the mapping against the portal's own screen.
 */
export function buildTripDraft(options: {
  deliveryDate: string;
  vehicleTypeId?: number | null;
  po: Record<string, unknown>;
  rows: Record<string, unknown>[];
  shippedMap: Record<string, number>;
}): { draft: KfmTripDraft; skipped: number } {
  const { items, skipped } = buildTripItems(options.po, options.rows, options.shippedMap);
  return {
    draft: {
      deliveryDate: options.deliveryDate,
      vehicleTypeId: options.vehicleTypeId ?? null,
      stops: [
        {
          locationId: asNumber(options.po.locationId),
          totalCartons: 0,
          totalPallets: 0,
          items,
        },
      ],
    },
    skipped,
  };
}

/** Confirm (accept) a purchase order on the portal. Operator-triggered only. */
export async function confirmOrder(
  token: string,
  options: { vendorId: number; orderId: number },
): Promise<void> {
  const response = await request(
    null,
    `${SCE_API}/api/v1/portal/orders/${options.orderId}/confirm?vendorId=${options.vendorId}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    },
  );
  if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
    throw new KfmPortalError(
      "confirm",
      response.status,
      "Cổng KFM không xác nhận được đơn này",
    );
  }
}

/** Delivery notes (ASN) already raised for a portal order. */
export async function listOrderAsns(
  token: string,
  options: { vendorId: number; orderId: number },
): Promise<Array<{ asnId: number; asnCode: string | null }>> {
  const { status, body } = await authedGet(
    token,
    `${SCE_API}/api/v1/portal/orders/${options.orderId}/asn?vendorId=${options.vendorId}`,
  );
  if (status !== 200) return [];
  const data = body?.data ?? body;
  const rows: Record<string, unknown>[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.content)
      ? data.content
      : [];
  return rows
    .map((row) => ({ asnId: Number(row.id), asnCode: asString(row.code) }))
    .filter((row) => Number.isFinite(row.asnId) && row.asnId > 0);
}

async function fetchDocument(token: string, url: string, step: string): Promise<Uint8Array> {
  const response = await request(null, url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/pdf,*/*" },
  });
  if (response.status !== 200) {
    throw new KfmPortalError(step, response.status, "Cổng KFM không trả về file in");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new KfmPortalError(step, response.status, "File in rỗng");
  }
  return new Uint8Array(buffer);
}

/** Print the PO. Prices stay off the sheet (the portal defaults to hiding them). */
export async function fetchPoPdf(token: string, poId: number): Promise<Uint8Array> {
  return await fetchDocument(
    token,
    `${SCE_API}/api/v1/purchase-orders/${poId}/export-pdf`,
    "po_pdf",
  );
}

/** Print one delivery note, price-free by default. */
export async function fetchAsnPdf(
  token: string,
  options: {
    asnId: number;
    vendorId: number;
    poId?: number | null;
    layout?: KfmPrintLayout;
  },
): Promise<Uint8Array> {
  const query = new URLSearchParams({ vendorId: String(options.vendorId) });
  if (options.poId) query.set("poId", String(options.poId));
  if ((options.layout ?? "FULL") === "NO_PRICE") query.set("hidePrice", "true");
  return await fetchDocument(
    token,
    `${SCE_API}/api/v1/portal/asn/${options.asnId}/export-pdf?${query.toString()}`,
    "asn_pdf",
  );
}
