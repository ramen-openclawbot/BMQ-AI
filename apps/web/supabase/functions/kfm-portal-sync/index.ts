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
 *   intake-list — poll new portal POs; never confirms or imports
 *   intake-decide — explicit staff confirm/reject, readback, then import
 *   intake-result — read-only partner reconciliation and resumable local import
 *   confirm-po — explicit operator continuation for a trip that already reads
 *                 back: confirm its PO (or resume the pending import) through
 *                 the same durable intake claim; never creates a second trip
 *   confirm — retired; staff must use the durable intake path
 *   po-pdf   — download the PO sheet                   (operator click only)
 *   asn-pdf  — download one delivery-note sheet        (operator click only)
 *   loads    — read the delivery trips with driver and vehicle
 *   load-detail — read one trip with its delivery notes
 *   load-pdf — download the delivery note of one trip  (operator click only)
 *   trip-draft  — build the trip body for one order WITHOUT sending it
 *                 (read-only; the operator reviews it before any write)
 *   trip-options — read eligible PO and portal vehicle/time configuration
 *   create-load  — explicitly confirmed, permission-checked, durable single send
 *   trip-result  — read-only recovery of a saved attempt; NEVER resubmits
 *
 * The open Q7 page polls intake-list. Every partner write still requires a
 * staff decision or explicit delivery-print action; polling never writes KFM.
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
import { ensureTripIntake, handleKfmIntake, intakeRevision } from "../_shared/kfm-intake.ts";
import {
  ISO_DATE,
  KfmPortalError,
  buildTripDraft,
  buildTripSubmission,
  bookTripSlot,
  createDeliveryTrip,
  findCreatedTrip,
  getTripOptions,
  getSavedTripFleet,
  validateSavedTripForm,
  tripAsnIds,
  tripRevision,
  tripOrderInScope,
  verifyTripReadback,
  fetchAsnPdf,
  fetchLoadPdf,
  fetchPoPdf,
  getDeliveryLoad,
  getMe,
  getOrderDetail,
  getTripSource,
  getTripPendingChanges,
  tripPoConfirmation,
  listDeliveryLoads,
  listOrderAsns,
  listOrders,
  openSession,
  statusLabel,
  vnDate,
  type KfmSession,
} from "../_shared/kfm-portal.ts";

const ACTIONS = [
  "intake-list",
  "intake-decide",
  "intake-result",
  "confirm-po",
  "list",
  "detail",
  "confirm",
  "po-pdf",
  "asn-pdf",
  "loads",
  "load-detail",
  "load-pdf",
  "trip-draft",
  "trip-options",
  "create-load",
  "trip-result",
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
 * The portal has two layouts; the BMQ print action defaults to hidden prices.
 * Anything unrecognised falls back to hidden prices.
 */
function printLayout(value: unknown): "FULL" | "NO_PRICE" {
  return String(value) === "FULL" ? "FULL" : "NO_PRICE";
}

/** The portal names the printed sheet after the note's code, not its row id. */
function printCode(value: unknown): string {
  const code = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : "";
}

async function requireUser(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
  const url = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!url || !anon) return null;
  const client = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data, error } = await client.auth.getUser();
  return !error ? data?.user?.id ?? null : null;
}

function tripAdmin() {
  return createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", { auth: { persistSession: false } });
}

async function canCreateTrip(userId: string): Promise<boolean> {
  const admin = tripAdmin();
  const [roles, permissions] = await Promise.all([
    admin.from("user_roles").select("role").eq("user_id", userId),
    admin.from("user_module_permissions").select("can_edit").eq("user_id", userId).eq("module_key", "production_q7"),
  ]);
  if (roles.error || permissions.error) return false;
  return roles.data.some(row => row.role === "owner") || permissions.data.some(row => row.can_edit === true);
}

/** Only sanitized business identifiers leave the attempt journal. */
async function tripResult(token: string, row: any) {
  if (row.state === "verified" && row.result?.poConfirmation?.confirmed) return row.result;
  let load = null;
  try { load = await findCreatedTrip(token, row.vendor_id, row.body, row.baseline_asn_ids, row.load_id); } catch { /* uncertain, never retry */ }
  if (!load || !verifyTripReadback(load, row.body)) return { state: "unknown", loadId: row.load_id || null, message: "Chưa xác minh được chuyến/ASN. Không bấm tạo lại; dùng ‘Kiểm tra kết quả’ hoặc kiểm tra cổng KFM." };
  const asns = load.asns.map((asn: any) => ({ asnId: Number(asn.id || asn.asnId), asnCode: String(asn.code || asn.asnCode) }));
  const loadId = Number(load.id);
  const loadCode = String(load.loadCode || "");
  let poConfirmation = null;
  let revision = "";
  try {
    const source = await getTripSource(token, { vendorId: row.vendor_id, orderId: row.order_id });
    if (Number(source.po.id) === row.order_id) { poConfirmation = tripPoConfirmation(source.po); revision = await intakeRevision(source); }
  } catch { /* Keep the write locked; a result check only reads again. */ }
  if (!poConfirmation?.confirmed) return { state: "unknown", loadId, loadCode, asns, poConfirmation, intakeRevision: revision || undefined, message: `Chuyến và ASN đã khớp nhưng chưa xác minh PO đã xác nhận${poConfirmation ? ` (${poConfirmation.label})` : ""}. Không tạo lại; xác nhận PO rồi in phiếu, hoặc chọn ‘Kiểm tra kết quả’.` };
  const result = { state: "verified", loadId, loadCode, poConfirmation, asns, message: "Đã đọc lại chuyến, ASN và trạng thái PO: kho và từng dòng số lượng khớp; PO đã được xác nhận." };
  const saved = await tripAdmin().from("kfm_trip_attempts").update({ state: "verified", load_id: result.loadId, result }).eq("vendor_id", row.vendor_id).eq("order_id", row.order_id);
  if (saved.error) return { state: "unknown", loadId: result.loadId, message: "Chuyến đã được đọc lại nhưng chưa lưu được kết quả xác minh. Không tạo lại." };
  return result;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405, req);

  const userId = await requireUser(req);
  if (!userId) {
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
    layout?: string;
    code?: string;
    revision?: string;
    requestId?: string;
    confirmed?: boolean;
    unifiedPrint?: boolean;
    decision?: "confirm" | "reject";
    reason?: string;
    form?: import("../_shared/kfm-portal.ts").KfmTripForm;
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

  const tripAction = ["trip-options", "create-load", "trip-result"].includes(action);
  const intakeAction = ["intake-list", "intake-decide", "intake-result"].includes(action);
  if ((intakeAction || action === "confirm" || action === "confirm-po") && !(await canCreateTrip(userId))) return json({ success: false, error: "forbidden", message: "Anh/chị chưa có quyền duyệt PO tại Xưởng Q7." }, 403, req);
  const mayCreate = tripAction ? await canCreateTrip(userId) : false;
  if (tripAction && !mayCreate && !(action === "trip-options" && payload.unifiedPrint === true)) return json({ success: false, error: "forbidden", message: "Anh/chị chưa có quyền chỉnh sửa kế hoạch sản xuất để tạo phiếu." }, 403, req);
  if (tripAction && (!payload.deliveryDate || !ISO_DATE.test(payload.deliveryDate))) return json({ success: false, error: "bad_date", message: "Cần chọn ngày giao rõ ràng." }, 200, req);

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
          fallback: "retry_portal",
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
    if ((tripAction || intakeAction || action === "confirm" || action === "confirm-po") && !cached.vendorIds.includes(vendorId)) return json({ success: false, error: "forbidden_vendor", message: "Nhà cung cấp không thuộc tài khoản KFM." }, 403, req);

    const session = { mode: cached.session.mode, obtainedAt: cached.session.obtainedAt };

    if (intakeAction) return json(await handleKfmIntake(tripAdmin(), cached.session.token, vendorId, userId, payload), 200, req);

    // Explicit operator continuation for the print flow: confirm the portal PO,
    // or resume its pending import, only while a matching delivery trip already
    // reads back. Read-only checks never write; this action is the only writer.
    if (action === "confirm-po") {
      const orderId = Number(payload.orderId);
      if (!Number.isSafeInteger(orderId) || orderId <= 0) return json({ success: false, error: "bad_order_id", message: "Thiếu orderId hợp lệ." }, 200, req);
      const revision = typeof payload.revision === "string" && /^[0-9a-f]{64}$/i.test(payload.revision) ? payload.revision : "";
      if (!revision) return json({ success: false, error: "bad_revision", message: "Thiếu bản đối chiếu PO. Bấm ‘Kiểm tra kết quả’ rồi xác nhận lại." }, 200, req);
      const confirmDate = typeof payload.deliveryDate === "string" && ISO_DATE.test(payload.deliveryDate) ? payload.deliveryDate : "";
      if (!confirmDate) return json({ success: false, error: "bad_date", message: "Cần ngày giao rõ ràng để xác nhận PO." }, 200, req);
      const admin = tripAdmin();
      // Never confirm a PO without a matching trip in the journal: this action is
      // recovery for an existing note, not a second way to create one.
      const existing = await admin.from("kfm_trip_attempts").select("*").eq("vendor_id", vendorId).eq("order_id", orderId).maybeSingle();
      if (existing.error) throw new KfmPortalError("trip", 0, "Không đọc được khóa gửi phiếu. Chưa xác nhận PO.");
      if (!existing.data) return json({ success: false, error: "no_trip", message: "Chưa có phiếu giao hàng cho PO này. Dùng ‘In phiếu giao hàng’ để tạo." }, 200, req);
      if (String(existing.data.body?.deliveryDate || "") !== confirmDate) return json({ success: false, error: "trip_changed", message: "Phiếu giao hàng thuộc ngày khác. Tải lại trước khi xác nhận." }, 200, req);
      const readback = await tripResult(cached.session.token, existing.data);
      // Confirmation is only safe once the existing trip itself reads back.
      if (readback.state === "verified" || !readback.loadId || !readback.poConfirmation) return json({ success: true, action, vendorId, result: readback }, 200, req);
      const source = await getTripSource(cached.session.token, { vendorId, orderId });
      if (Number(source.po.id) !== orderId || !(await tripOrderInScope(cached.session.token, vendorId, orderId))) throw new KfmPortalError("trip", 0, "PO không thuộc danh sách của nhà cung cấp đã chọn.");
      if (Number(source.po.status) === 6 || Number(source.po.subStatus) === 11) return json({ success: true, action, vendorId, result: { state: "blocked", loadId: readback.loadId, message: "PO đã hủy. Không xác nhận; kiểm tra lại trên cổng KFM." } }, 200, req);
      if (await intakeRevision(source) !== revision) return json({ success: true, action, vendorId, result: { state: "changed", loadId: readback.loadId, message: "PO đã thay đổi sau khi tạo phiếu. Kiểm tra lại thông tin trước khi xác nhận." } }, 200, req);
      // Pending edit requests are not part of intakeRevision: re-read them right
      // before the explicit write instead of confirming over an unreviewed change.
      const pending = await getTripPendingChanges(cached.session.token, orderId);
      if (pending.length) return json({ success: true, action, vendorId, result: { state: "blocked", loadId: readback.loadId, message: "PO có yêu cầu chỉnh sửa chưa xử lý. Xử lý trên cổng KFM rồi kiểm tra kết quả, không xác nhận đè." } }, 200, req);
      const value = await handleKfmIntake(admin, cached.session.token, vendorId, userId, {
        action: "intake-decide",
        orderId,
        vendorId,
        decision: "confirm",
        requestId: payload.requestId,
        revision,
      });
      return json({ action, vendorId, ...value }, 200, req);
    }

    if (tripAction) {
      const orderId = Number(payload.orderId);
      if (!Number.isSafeInteger(orderId) || orderId <= 0) return json({ success: false, error: "bad_order_id", message: "Thiếu orderId hợp lệ." }, 200, req);
      const admin = tripAdmin();
      const existing = await admin.from("kfm_trip_attempts").select("*").eq("vendor_id", vendorId).eq("order_id", orderId).maybeSingle();
      if (existing.error) throw new KfmPortalError("trip", 0, "Không đọc được khóa gửi phiếu. Chưa gửi gì lên KFM.");
      if (existing.data) {
        const result = await tripResult(cached.session.token, existing.data);
        return json({ success: true, action, vendorId, result }, 200, req);
      }
      if (action === "trip-result") return json({ success: true, result: { state: "not_sent", message: "Chưa ghi nhận yêu cầu tạo trên máy chủ. Tải lại form để kiểm tra trước khi tạo." } }, 200, req);
      // Printing an existing note is read-only, even if the PO has no eligible rows.
      if (payload.unifiedPrint === true) {
        if (!(await tripOrderInScope(cached.session.token, vendorId, orderId))) throw new KfmPortalError("trip", 0, "PO không thuộc nhà cung cấp đã chọn.");
        const existingNotes = await listOrderAsns(cached.session.token, { vendorId, orderId, strict: true });
        if (existingNotes.length) return json({ success: true, existingNotes }, 200, req);
      }
      if (!mayCreate) return json({ success: false, error: "forbidden", message: "Chưa có phiếu để in; anh/chị chưa có quyền tạo phiếu." }, 403, req);
      const source = await getTripSource(cached.session.token, { vendorId, orderId });
      if (Number(source.po.id) !== orderId || !(await tripOrderInScope(cached.session.token, vendorId, orderId))) throw new KfmPortalError("trip", 0, "PO không thuộc danh sách của nhà cung cấp đã chọn.");
      if (Number(source.po.status) === 6) throw new KfmPortalError("trip", 0, "PO đã hủy, không được tạo phiếu.");
      source.pendingChanges = await getTripPendingChanges(cached.session.token, orderId);
      const { draft } = buildTripDraft({ deliveryDate, po: source.po, rows: source.items, shippedMap: source.shippedMap });
      if (!draft.stops[0].items.length) throw new KfmPortalError("trip", 0, "Tất cả sản phẩm đã được giao hoặc đã lên chuyến. Không tạo thêm.");
      const form = payload.form || {};
      const options = await getTripOptions(cached.session.token, vendorId, source, deliveryDate, Number(form.vehicleTypeId || payload.vehicleTypeId) || null);
      const fleet = payload.unifiedPrint === true ? await getSavedTripFleet(cached.session.token) : undefined;
      const revision = await tripRevision(source, deliveryDate, fleet);
      if (action === "trip-options") return json({ success: true, action, vendorId, revision, options, fleet, draft, pendingChangeCategories: [...new Set(source.pendingChanges.map(row => String(row.requestCategory || "OTHER")))], source: { locationName: source.po.locationName, poCode: source.po.code } }, 200, req);
      if (payload.confirmed !== true || !/^[0-9a-f-]{36}$/i.test(payload.requestId || "")) throw new KfmPortalError("trip", 0, "Cần xác nhận tạo phiếu từ form.");
      if (payload.revision !== revision) throw new KfmPortalError("trip_changed", 0, "PO hoặc số lượng đã phân bổ thay đổi. Tải lại form và kiểm tra trước khi tạo.");
      if (fleet) validateSavedTripForm(fleet, form);
      let body = buildTripSubmission(source, deliveryDate, options, form);
      const baseline = await tripAsnIds(cached.session.token, vendorId, orderId);
      const fresh = await getTripSource(cached.session.token, { vendorId, orderId });
      fresh.pendingChanges = await getTripPendingChanges(cached.session.token, orderId);
      const freshFleet = fleet ? await getSavedTripFleet(cached.session.token) : undefined;
      if (await tripRevision(fresh, deliveryDate, freshFleet) !== revision) throw new KfmPortalError("trip_changed", 0, "PO hoặc xe/tài xế thay đổi ngay trước lúc gửi. Tải lại để kiểm tra.");
      // Print intent auto-confirms the PO through the SAME durable intake claim
      // the review popup uses. The claim is written before the trip, so a
      // confirm and a reject cannot both win, and a refetch/retry after a
      // timeout only re-reads. A rejected, changed, unconfirmed or unimported
      // PO never opens the gate, so no trip is created for it.
      if (!tripPoConfirmation(fresh.po).confirmed && fresh.pendingChanges.length) throw new KfmPortalError("trip_changed", 0, "PO có yêu cầu chỉnh sửa chưa xử lý. Chưa xác nhận hoặc tạo phiếu.");
      const gate = await ensureTripIntake(admin, cached.session.token, vendorId, userId, orderId, fresh);
      if (!gate.ok) throw new KfmPortalError("trip", 0, gate.message || "PO chưa được xác nhận và nhập sản xuất. Chưa tạo phiếu giao hàng.");
      // Confirmation/import can take time. A historical intake record is not
      // evidence of the current portal state, quantities or allocations.
      const afterConfirm = await getTripSource(cached.session.token, { vendorId, orderId });
      afterConfirm.pendingChanges = await getTripPendingChanges(cached.session.token, orderId);
      const allocations = (value: Record<string, number>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      if (Number(afterConfirm.po.id) !== orderId || Number(afterConfirm.po.status) === 6 || !tripPoConfirmation(afterConfirm.po).confirmed
        || await intakeRevision(afterConfirm, false) !== await intakeRevision(fresh, false)
        || allocations(afterConfirm.shippedMap) !== allocations(fresh.shippedMap)
        || JSON.stringify(afterConfirm.pendingChanges) !== JSON.stringify(fresh.pendingChanges)) {
        throw new KfmPortalError("trip_changed", 0, "PO chưa xác nhận hoặc thông tin/phân bổ đã thay đổi sau bước xác nhận. Chưa tạo chuyến; tải lại để đối chiếu.");
      }
      if (fleet) validateSavedTripForm(await getSavedTripFleet(cached.session.token), form);
      body = buildTripSubmission(afterConfirm, deliveryDate, options, form);
      // Atomic DB unique key excludes concurrent browsers/users/Edge instances.
      // The claim is retained on every uncertain result, including booking errors.
      const row = { vendor_id: vendorId, order_id: orderId, actor_id: userId, request_id: payload.requestId, body, baseline_asn_ids: baseline };
      const claim = await admin.from("kfm_trip_attempts").insert(row);
      if (claim.error) {
        if (claim.error.code !== "23505") throw new KfmPortalError("trip", 0, "Không khóa được yêu cầu tạo. Chưa gửi lên KFM.");
        return json({ success: true, result: { state: "unknown", message: "PO đang có yêu cầu tạo khác. Chỉ kiểm tra kết quả, không gửi lại." } }, 200, req);
      }
      let loadId: number | null = null;
      try {
        if (options.deliveryType === "BOOKING") {
          const refs = await bookTripSlot(cached.session.token, source, options, body);
          body = { ...body, ...refs, stops: body.stops.map((stop: any) => ({ ...stop, ...refs, bookingCode: refs.qrToken })) };
          const booked = await admin.from("kfm_trip_attempts").update({ body }).eq("vendor_id", vendorId).eq("order_id", orderId);
          if (booked.error) throw new KfmPortalError("trip", 0, "Chưa lưu được lịch kho, dừng tạo chuyến.");
        }
        loadId = await createDeliveryTrip(cached.session.token, vendorId, body);
        await admin.from("kfm_trip_attempts").update({ load_id: loadId }).eq("vendor_id", vendorId).eq("order_id", orderId);
      } catch { /* Do not retry either write; recover by GET only. */ }
      const result = await tripResult(cached.session.token, { ...row, body, load_id: loadId });
      if (result.state !== "verified") await admin.from("kfm_trip_attempts").update({ state: "unknown" }).eq("vendor_id", vendorId).eq("order_id", orderId);
      return json({ success: true, action, vendorId, result }, 200, req);
    }

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
      return json({ success: false, error: "intake_required", message: "Duyệt PO từ Kiểm tra PO để xác nhận và nhập sản xuất an toàn." }, 200, req);
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
      const sourcePoId = Number(source.po.id);
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
          poId: Number.isInteger(sourcePoId) && sourcePoId > 0
            ? sourcePoId
            : detail.purchaseOrderId ?? null,
          poCode: String(source.po.code ?? detail.code ?? "") || null,
          locationId: draft.stops[0]?.locationId ?? null,
          locationName: source.po.locationName ?? null,
          itemCount: draft.stops[0]?.items.length ?? 0,
          totalShipQty: (draft.stops[0]?.items ?? []).reduce((sum, item) => sum + item.shipQty, 0),
          skippedCount: skipped,
          readFrom: `GET /api/v1/portal/orders/${orderId}?vendorId=${vendorId}`,
        },
        // Keep every source row and the actual filter values for reconciliation,
        // including when all lines are already covered by an existing trip.
        rawRows: source.items,
        shippedMap: source.shippedMap,
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
    // The client generates this bounded trace from fixed path labels, query-key
    // allowlist, statuses and cookie-presence booleans; no raw provider response.
    if (step === "login" && detail?.startsWith("postStatus=")) {
      console.info("kfm_sso_diagnostic", JSON.stringify({ status, detail }));
    }
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
      fallback: "retry_portal",
    }, 200, req);
  }
});
