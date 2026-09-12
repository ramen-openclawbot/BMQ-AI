/**
 * kfm-portal-sync — read KFM/Seedcom partner-portal orders for a delivery date.
 *
 * Why a backend proxy: the portal API (logis.seedcom.vn) rejects browser
 * preflight from ai.banhmique.vn ("Invalid CORS request"), so the SPA cannot
 * call it directly. This function holds the session and does the HTTP work.
 *
 * Read-only by design: it never confirms an order, never submits an ASN and
 * never writes to the partner system.
 *
 * Request  (POST, authenticated app user):
 *   { "deliveryDate": "YYYY-MM-DD", "vendorId"?: number, "size"?: number }
 * Response:
 *   { success, configured, deliveryDate, vendorId, vendorCode, count, orders[], session }
 *
 * Secrets (Supabase Edge Function env only, never logged):
 *   KFM_PORTAL_USERNAME, KFM_PORTAL_PASSWORD, KFM_PORTAL_REFRESH_TOKEN (optional)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { corsPreflightResponse, getCorsHeaders } from "../_shared/cors.ts";
import {
  ISO_DATE,
  KfmPortalError,
  getMe,
  listOrders,
  openSession,
  statusLabel,
  vnDate,
  type KfmSession,
} from "../_shared/kfm-portal.ts";

/** Warm-instance session cache — avoids one login per request while it lasts. */
let cached: { session: KfmSession; vendorIds: number[]; vendorCode: string | null } | null = null;

/**
 * A rejected credential must not be retried on every app request: the partner
 * portal locks accounts after repeated failures. Failed logins are memoised for
 * a short cooldown so a mistaken secret cannot hammer the account.
 */
const LOGIN_COOLDOWN_MS = 5 * 60 * 1000;
let lastCredentialFailure: { at: number; step: string; status: number; message: string } | null = null;

const json = (body: unknown, status: number, req: Request) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });

async function requireUser(req: Request): Promise<boolean> {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return false;
  const url = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!url || !anon) return false;
  const client = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data, error } = await client.auth.getUser();
  return !error && Boolean(data?.user);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405, req);

  if (!(await requireUser(req))) {
    return json({ success: false, error: "unauthorized" }, 401, req);
  }

  let payload: { deliveryDate?: string; vendorId?: number; size?: number } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const deliveryDate = payload.deliveryDate && ISO_DATE.test(payload.deliveryDate)
    ? payload.deliveryDate
    : vnDate(1); // KFM orders tomorrow's delivery today.

  const username = Deno.env.get("KFM_PORTAL_USERNAME") || "";
  const password = Deno.env.get("KFM_PORTAL_PASSWORD") || "";
  const refreshToken = Deno.env.get("KFM_PORTAL_REFRESH_TOKEN") || "";
  const configured = Boolean((username && password) || refreshToken);
  if (!configured) {
    return json({
      success: false,
      configured: false,
      deliveryDate,
      error: "not_configured",
      message:
        "Chưa cấu hình tài khoản cổng KFM. Cần đặt KFM_PORTAL_USERNAME và KFM_PORTAL_PASSWORD trong Supabase secrets.",
    }, 200, req);
  }

  try {
    if (!cached) {
      const cooldownLeftMs = lastCredentialFailure
        ? LOGIN_COOLDOWN_MS - (Date.now() - lastCredentialFailure.at)
        : 0;
      if (cooldownLeftMs > 0 && lastCredentialFailure) {
        return json({
          success: false,
          configured: true,
          deliveryDate,
          error: "login_cooldown",
          step: lastCredentialFailure.step,
          message: lastCredentialFailure.message,
          retryAfterSeconds: Math.ceil(cooldownLeftMs / 1000),
          fallback: "po-gmail-sync",
        }, 200, req);
      }
      const session = await openSession({ username, password, refreshToken });
      const me = await getMe(session.token);
      cached = { session, vendorIds: me.vendorIds, vendorCode: me.vendorCode };
      lastCredentialFailure = null;
    }

    const requestedVendor = Number(payload.vendorId);
    const vendorId = Number.isInteger(requestedVendor) && requestedVendor > 0
      ? requestedVendor
      : cached.vendorIds[0];
    if (!vendorId) {
      return json({
        success: false, configured: true, deliveryDate,
        error: "no_vendor",
        message: "Tài khoản cổng KFM không gắn nhà cung cấp nào.",
      }, 200, req);
    }

    const size = Number.isInteger(Number(payload.size)) ? Math.min(Number(payload.size), 200) : 100;
    const { orders, totalElements } = await listOrders(cached.session.token, {
      vendorId,
      deliveryDateFrom: deliveryDate,
      deliveryDateTo: deliveryDate,
      page: 0,
      size,
    });

    return json({
      success: true,
      configured: true,
      deliveryDate,
      vendorId,
      vendorCode: cached.vendorCode,
      count: orders.length,
      totalElements,
      orders: orders.map((order) => ({ ...order, statusLabel: statusLabel(order.status, order.subStatus) })),
      session: { mode: cached.session.mode, obtainedAt: cached.session.obtainedAt },
      source: "kfm_portal",
    }, 200, req);
  } catch (error) {
    // A rejected session must not stay cached, or every later call fails the same way.
    cached = null;
    const isPortal = error instanceof KfmPortalError;
    const step = isPortal ? (error as KfmPortalError).step : "unknown";
    const status = isPortal ? (error as KfmPortalError).status : 0;
    const message = isPortal
      ? (error as KfmPortalError).message
      : "Lỗi không xác định khi gọi cổng KFM";
    const detail = isPortal ? (error as KfmPortalError).detail : undefined;
    const expired = step === "me" && status === 401;
    // Bad credentials are remembered so the account is not hammered into a lockout.
    if (step === "login" || step === "exchange" || step === "sso_form") {
      lastCredentialFailure = { at: Date.now(), step, status, message };
    }
    return json({
      success: false,
      configured: true,
      deliveryDate,
      error: expired ? "session_expired" : `portal_${step}`,
      step,
      message,
      detail,
      // The UI falls back to the existing Gmail PO flow when this is not success.
      fallback: "po-gmail-sync",
    }, 200, req);
  }
});
