/**
 * kfm-portal-sync — the KFM/Seedcom partner-portal bridge for BMQ.
 *
 * Why a backend proxy: the portal API (logis.seedcom.vn) rejects browser
 * preflight from ai.banhmique.vn ("Invalid CORS request"), so the SPA cannot
 * call it directly. This function holds the session and does the HTTP work.
 *
 * Reads and operator actions:
 *   list     — read the POs of one delivery date (default)
 *   detail   — read one order (lines + the purchase order behind it)
 *   confirm  — confirm one PO on the portal            (operator click only)
 *   po-pdf   — download the PO sheet                   (operator click only)
 *   asn-pdf  — download one delivery-note sheet        (operator click only)
 *   loads    — read the delivery trips with driver and vehicle
 *   load-detail — read one trip with its delivery notes
 *   load-pdf — download the delivery note of one trip  (operator click only)
 *   trip-draft  — build the trip body for one order WITHOUT sending it
 *                 (read-only; the operator reviews it before any write)
 *
 * Nothing here is scheduled, retried or triggered by a background job: every
 * call happens because a person pressed a button in the BMQ UI.
 *
 * Request  (POST, authenticated app user):
 *   { "action"?: "list"|"detail"|"confirm"|"po-pdf"|"asn-pdf"|"loads"|"load-detail"|"load-pdf"|"trip-draft",
 *     "deliveryDate"?: "YYYY-MM-DD", "vendorId"?: number, "size"?: number,
 *     "orderId"?: number, "poId"?: number, "asnId"?: number, "loadId"?: number,
 *     "vehicleTypeId"?: number }
 * Response:
 *   list   : { success, configured, deliveryDate, vendorId, vendorCode, count, orders[], session }
 *   detail : { success, order: { portalId, code, purchaseOrderId, lines[], asns[] } }
 *   confirm: { success, orderId }
 *   po-pdf / asn-pdf: { success, filename, contentType, base64 }
 *   loads  : { success, count, totalElements, counts, loads[] }
 *   load-detail: { success, load }
 *   load-pdf: { success, filename, contentType, base64 }
 *   trip-draft: { success, draft, source, rawRows }  — nothing is written
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
  buildTripDraft,
  confirmOrder,
  fetchAsnPdf,
  fetchLoadPdf,
  fetchPoPdf,
  getDeliveryLoad,
  getMe,
  getOrderDetail,
  getTripSource,
  listDeliveryLoads,
  listOrderAsns,
  listOrders,
  openSession,
  statusLabel,
  vnDate,
  type KfmSession,
} from "../_shared/kfm-portal.ts";

const ACTIONS = [
  "list",
  "detail",
  "confirm",
  "po-pdf",
  "asn-pdf",
  "loads",
  "load-detail",
  "load-pdf",
  "trip-draft",
] as const;
type KfmAction = typeof ACTIONS[number];

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

/** Edge-runtimes have btoa but no Buffer; encode in chunks so long PDFs fit. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/**
 * The portal's print menu has exactly two layouts and `FULL` (prices shown) is
 * its default; anything unrecognised falls back to that default.
 */
function printLayout(value: unknown): "FULL" | "NO_PRICE" {
  return String(value) === "NO_PRICE" ? "NO_PRICE" : "FULL";
}

/** The portal names the printed sheet after the note's code, not its row id. */
function printCode(value: unknown): string {
  const code = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : "";
}

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

  let payload: {
    action?: string;
    deliveryDate?: string;
    vendorId?: number;
    size?: number;
    orderId?: number;
    poId?: number;
    asnId?: number;
    loadId?: number;
    vehicleTypeId?: number;
  } = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const action = (ACTIONS as readonly string[]).includes(String(payload.action))
    ? (payload.action as KfmAction)
    : "list";
  // A stale deployment used to answer an unknown action by quietly running the
  // order list instead, so the caller saw a successful response carrying the
  // wrong payload. Fail loudly instead; only a missing action may default.
  if (payload.action !== undefined && action === "list" && String(payload.action) !== "list") {
    return json({
      success: false,
      configured: true,
      error: "unknown_action",
      message: "Hành động này chưa có trên máy chủ. Cần triển khai lại cổng KFM.",
    }, 200, req);
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
      action,
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
          action,
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
        success: false, configured: true, action, deliveryDate,
        error: "no_vendor",
        message: "Tài khoản cổng KFM không gắn nhà cung cấp nào.",
      }, 200, req);
    }

    const session = { mode: cached.session.mode, obtainedAt: cached.session.obtainedAt };

    if (action === "detail") {
      const orderId = Number(payload.orderId);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return json({ success: false, action, error: "bad_order_id", message: "Thiếu orderId." }, 200, req);
      }
      const detail = await getOrderDetail(cached.session.token, { vendorId, orderId });
      const asns = await listOrderAsns(cached.session.token, { vendorId, orderId });
      return json({ success: true, configured: true, action, vendorId, vendorCode: cached.vendorCode, order: { ...detail, asns }, session }, 200, req);
    }

    if (action === "confirm") {
      const orderId = Number(payload.orderId);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return json({ success: false, action, error: "bad_order_id", message: "Thiếu orderId." }, 200, req);
      }
      await confirmOrder(cached.session.token, { vendorId, orderId });
      return json({ success: true, configured: true, action, orderId, session }, 200, req);
    }

    if (action === "po-pdf" || action === "asn-pdf") {
      const isPo = action === "po-pdf";
      const targetId = Number(isPo ? payload.poId : payload.asnId);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        return json({
          success: false, action, error: "bad_target_id",
          message: isPo ? "Thiếu poId." : "Thiếu asnId.",
        }, 200, req);
      }
      const poId = Number(payload.poId);
      const layout = printLayout(payload.layout);
      const bytes = isPo
        ? await fetchPoPdf(cached.session.token, targetId)
        : await fetchAsnPdf(cached.session.token, {
            asnId: targetId,
            vendorId,
            poId: Number.isInteger(poId) && poId > 0 ? poId : null,
            layout,
          });
      return json({
        success: true,
        configured: true,
        action,
        layout,
        filename: `${isPo ? "PO" : "PhieuGiaoHang"}-${printCode(payload.code) || targetId}.pdf`,
        contentType: "application/pdf",
        base64: toBase64(bytes),
        byteLength: bytes.byteLength,
        session,
      }, 200, req);
    }

    if (action === "trip-draft") {
      // Read-only: assemble the body the portal's trip form would post, so the
      // operator can check the mapping before anything reaches the partner.
      const orderId = Number(payload.orderId);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return json({ success: false, action, error: "bad_order_id", message: "Thiếu orderId." }, 200, req);
      }
      const detail = await getOrderDetail(cached.session.token, { vendorId, orderId });
      const source = await getTripSource(cached.session.token, { vendorId, orderId });
      const vehicleTypeId = Number(payload.vehicleTypeId);
      const { draft, skipped } = buildTripDraft({
        deliveryDate,
        vehicleTypeId: Number.isInteger(vehicleTypeId) && vehicleTypeId > 0 ? vehicleTypeId : null,
        po: source.po,
        rows: source.items,
        shippedMap: source.shippedMap,
      });
      return json({
        success: true,
        configured: true,
        action,
        deliveryDate,
        vendorId,
        vendorCode: cached.vendorCode,
        draft,
        source: {
          orderId,
          poId: detail.purchaseOrderId ?? draft.stops[0]?.items[0]?.poId ?? null,
          poCode: String(source.po.code ?? detail.code ?? "") || null,
          locationId: draft.stops[0]?.locationId ?? null,
          locationName: source.po.locationName ?? null,
          itemCount: draft.stops[0]?.items.length ?? 0,
          totalShipQty: (draft.stops[0]?.items ?? []).reduce((sum, item) => sum + item.shipQty, 0),
          skippedCount: skipped,
          readFrom: `GET /api/v1/portal/orders/${orderId}?vendorId=${vendorId}`,
        },
        // A couple of the portal's own rows, so a changed field name on the
        // partner side is visible in the panel instead of silently mapping to 0.
        rawRows: source.items.slice(0, 2),
        shippedMapKeys: Object.keys(source.shippedMap).slice(0, 5),
        session,
      }, 200, req);
    }

    if (action === "loads") {
      const { loads, totalElements, counts } = await listDeliveryLoads(cached.session.token, {
        vendorId,
        deliveryDate: payload.deliveryDate && ISO_DATE.test(payload.deliveryDate)
          ? payload.deliveryDate
          : undefined,
        page: 0,
        size: Number.isInteger(Number(payload.size)) ? Math.min(Number(payload.size), 100) : 20,
      });
      return json({
        success: true,
        configured: true,
        action,
        deliveryDate,
        vendorId,
        vendorCode: cached.vendorCode,
        count: loads.length,
        totalElements,
        counts,
        loads,
        session,
        source: "kfm_portal",
      }, 200, req);
    }

    if (action === "load-detail") {
      const loadId = Number(payload.loadId);
      if (!Number.isInteger(loadId) || loadId <= 0) {
        return json({ success: false, action, error: "bad_load_id", message: "Thiếu loadId." }, 200, req);
      }
      const load = await getDeliveryLoad(cached.session.token, { vendorId, loadId });
      return json({
        success: true,
        configured: true,
        action,
        vendorId,
        vendorCode: cached.vendorCode,
        load,
        session,
      }, 200, req);
    }

    if (action === "load-pdf") {
      const loadId = Number(payload.loadId);
      if (!Number.isInteger(loadId) || loadId <= 0) {
        return json({ success: false, action, error: "bad_load_id", message: "Thiếu loadId." }, 200, req);
      }
      const bytes = await fetchLoadPdf(cached.session.token, {
        loadId,
        vendorId,
        layout: printLayout(payload.layout),
      });
      return json({
        success: true,
        configured: true,
        action,
        filename: `PhieuGiaoHang_${printCode(payload.code) || loadId}.pdf`,
        contentType: "application/pdf",
        base64: toBase64(bytes),
        byteLength: bytes.byteLength,
        session,
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
      action,
      deliveryDate,
      vendorId,
      vendorCode: cached.vendorCode,
      count: orders.length,
      totalElements,
      orders: orders.map((order) => ({ ...order, statusLabel: statusLabel(order.status, order.subStatus) })),
      session,
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
      action,
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
