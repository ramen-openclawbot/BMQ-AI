/**
 * KFM / Seedcom partner portal client (HTTP-only, no browser).
 *
 * Verified contract (2026-09-12, read from the portal SPA bundles):
 *   SSO   : GET  https://sso.seedcom.vn/uaa/login            -> form (_csrf, username, password)
 *           POST https://sso.seedcom.vn/uaa/login            -> 302 Location .../sce/oauth?code=...
 *   Token : POST {SCE}/auth/sso/sce/exchange  { code, clientId, redirectUri } -> { success, token, refreshToken }
 *           POST {SCE}/auth/sso/sce/refresh   { refreshToken, clientId }      -> { success, token, refreshToken }
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
  headers.set("Accept", "application/json, text/plain, */*");
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

/** Step 1 — read the SSO login form and its CSRF token. */
export async function fetchLoginForm(
  jar: CookieJar = new CookieJar(),
): Promise<{ jar: CookieJar; csrf: string; action: string }> {
  const response = await request(jar, `${SSO_BASE}/login`);
  const html = await response.text();
  if (response.status !== 200) {
    throw new KfmPortalError("sso_form", response.status, "Không mở được trang đăng nhập SSO");
  }
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
  let action = actionMatch ? actionMatch[1] : "/login";
  if (action.startsWith("/")) action = `${SSO_BASE}${action}`;
  if (!csrf) {
    throw new KfmPortalError("sso_form", 200, "Trang SSO không có _csrf — cấu trúc form đã đổi");
  }
  return { jar, csrf, action };
}

type TokenPayload = { success?: boolean; token?: string; refreshToken?: string; message?: string };

function readTokens(step: string, status: number, payload: TokenPayload): KfmSession | null {
  if (status !== 200) return null;
  if (!payload?.success || !payload?.token) return null;
  return {
    token: payload.token,
    refreshToken: payload.refreshToken || "",
    mode: step === "refresh" ? "refresh" : "login",
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
  const { jar, csrf, action } = await fetchLoginForm();

  const response = await request(jar, action, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode({ username, password, _csrf: csrf }),
  });

  if (!REDIRECT_STATUS.has(response.status)) {
    throw new KfmPortalError("login", response.status, "Đăng nhập cổng KFM bị từ chối");
  }
  const location = response.headers.get("location") || "";
  let code = "";
  try {
    code = new URL(location).searchParams.get("code") || "";
  } catch {
    code = "";
  }
  if (!code) {
    throw new KfmPortalError("login", response.status, "SSO không trả về mã uỷ quyền");
  }

  const exchange = await request(null, `${SCE_API}/auth/sso/sce/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      clientId: SCE_CLIENT_ID,
      redirectUri: `${PORTAL_ORIGIN}/sce/oauth`,
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
