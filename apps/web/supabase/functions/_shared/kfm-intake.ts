/** Portal intake: no write during polling, durable one-send decisions, GET-only recovery. */
import { KfmPortalError, confirmOrder, rejectOrder, getTripSource, listOrders, tripOrderInScope, tripPoConfirmation, vnDate, type KfmTripSource } from './kfm-portal.ts';
type Row = Record<string, any>;
type Admin = any;
export const canonicalPo = (value: unknown) => String(value || '').trim().toUpperCase();
export function intakeItems(source: KfmTripSource) {
  return source.items.map(row => ({
    productCode: String(row.productCode || ''), barcode: String(row.barcode || ''),
    productName: String(row.productName || ''), unitName: String(row.unitName || '').trim(),
    qty: Number(row.approvalStatus === 'APPROVED' && row.finalQuantity != null ? row.finalQuantity : row.qty ?? row.orderedQty ?? row.quantity),
    unitPrice: Number(row.finalUnitPrice ?? row.unitPrice ?? 0), taxRate: Number(row.taxRate || 0),
  }));
}
export function intakeSnapshot(source: KfmTripSource) {
  return { code: canonicalPo(source.po.code), deliveryDate: String(source.po.deliveryDate || '').slice(0, 10),
    locationId: Number(source.po.locationId), locationName: String(source.po.locationName || ''), items: intakeItems(source) };
}
export async function intakeRevision(source: KfmTripSource, withStatus = true) {
  const raw = JSON.stringify({ ...intakeSnapshot(source), ...(withStatus ? { status: source.po.status, subStatus: source.po.subStatus } : {}) });
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
function validSource(source: KfmTripSource) {
  const snapshot = intakeSnapshot(source);
  return snapshot.code && /^\d{4}-\d{2}-\d{2}$/.test(snapshot.deliveryDate) && snapshot.items.length > 0 && snapshot.items.every(row => row.productCode && row.productName && row.unitName && Number.isFinite(row.qty) && row.qty >= 0 && Number.isFinite(row.unitPrice) && row.unitPrice >= 0 && Number.isFinite(row.taxRate) && row.taxRate >= 0);
}
export function productionPayload(source: KfmTripSource, vendorId: number, actorId: string) {
  if (!validSource(source)) throw new KfmPortalError('intake', 0, 'PO thiếu ngày giao, sản phẩm hoặc số lượng hợp lệ. Chưa nhập vào sản xuất.');
  const snapshot = intakeSnapshot(source);
  const items = snapshot.items.filter(row => row.qty > 0).map(row => ({ product_name: row.productName, sku: row.barcode || row.productCode,
    sku_code: row.barcode === 'SP001596' ? 'KF-CROFFLE-40G-T0526' : null,
    product_code: row.productCode, qty: row.qty, unit: row.unitName, unit_price: row.unitPrice,
    line_total: Math.round(row.qty * row.unitPrice * (1 + row.taxRate / 100)), date: snapshot.deliveryDate,
    service_date: snapshot.deliveryDate, amount_includes_vat: true, vat_handling: 'no_extra_multiplier' }));
  if (!items.length) throw new KfmPortalError('intake', 0, 'PO không còn số lượng để sản xuất.');
  const subtotal = snapshot.items.reduce((sum, row) => sum + row.qty * row.unitPrice, 0);
  const total = items.reduce((sum, row) => sum + row.line_total, 0);
  if (!Number.isFinite(subtotal) || !Number.isFinite(total)) throw new KfmPortalError('intake', 0, 'Số tiền PO không hợp lệ.');
  return { gmail_message_id: `kfm-portal:${vendorId}:${source.po.id}`, from_email: 'portal@kingfoodmart.com', from_name: 'KINGFOOD MART',
    email_subject: `KFM Portal · ${snapshot.code}`, po_number: snapshot.code, delivery_date: snapshot.deliveryDate,
    production_items: items, subtotal_amount: subtotal, vat_amount: total - subtotal, total_amount: total,
    match_status: 'approved', reviewed_by: actorId, reviewed_at: new Date().toISOString(), has_attachments: false, attachment_names: [],
    raw_payload: { source: 'kfm_portal', kfm_order_id: Number(source.po.id), vendor_id: vendorId, location_id: snapshot.locationId,
      location_name: snapshot.locationName, portal_sub_status: source.po.subStatus, portal_confirmed_at: source.po.vendorConfirmedAt || null,
      parse_meta: { source: 'kfm_portal', parser: 'kfm-portal-intake:v1', amount_includes_vat: true, revenue_posting_allowed: false } } };
}
async function orderView(source: KfmTripSource, attempt?: Row) {
  return { orderId: Number(source.po.id), ...intakeSnapshot(source), status: source.po.status, subStatus: source.po.subStatus,
    revision: await intakeRevision(source), state: attempt ? (attempt.decision === 'confirm' && tripPoConfirmation(source.po).confirmed ? 'import_pending' : 'unknown') : 'pending',
    decision: attempt?.decision, message: attempt ? 'Yêu cầu đã gửi; chỉ kiểm tra kết quả, không gửi lại.' : undefined };
}
function checked(result: Row, message: string) { if (result.error) throw new KfmPortalError('intake', 0, message); return result.data; }
const PAGE_SIZE = 1000;
/**
 * Gia Von's finished-product definition (src/lib/skuType.ts): an explicit
 * `finished_good` type, or a legacy row whose type is absent and whose category
 * still names a finished product. The typed raw-material rows are excluded in
 * PostgREST so the catalog read stays small and cannot be truncated by the
 * mostly-raw-material catalog; legacy untyped rows are still fetched because
 * only the canonical accent/punctuation-normalized category fallback can
 * classify them, and a server-side `ilike` would silently drop a valid legacy
 * finished SKU. `mapIntakeSkus` re-applies the same predicate, so a raw material
 * can never become eligible even if it slips into the candidate set.
 */
export const FINISHED_SKU_QUERY = 'sku_type.eq.finished_good,sku_type.is.null';
/**
 * PostgREST returns at most one page per request (1000 rows by default), so an
 * unpaged catalog read silently dropped later SKUs and blocked an otherwise
 * valid PO. Read every page in a stable id order and fail closed on any page
 * error, short page or changed total, so a truncated catalog can never reach
 * mapIntakeSkus or the portal confirmation.
 */
async function readAllRows(makeQuery: () => Row, message: string): Promise<Row[]> {
  const rows: Row[] = [];
  let total: number | undefined;
  for (;;) {
    const page: Row = await makeQuery().order('id', { ascending: true }).range(rows.length, rows.length + PAGE_SIZE - 1);
    if (page.error || !Array.isArray(page.data)) throw new KfmPortalError('intake', 0, message);
    const count = typeof page.count === 'number' && Number.isSafeInteger(page.count) && page.count >= 0 ? page.count : undefined;
    if (count !== undefined) {
      if (total !== undefined && count !== total) throw new KfmPortalError('intake', 0, message);
      total = count;
    }
    rows.push(...page.data);
    if (total !== undefined && rows.length > total) throw new KfmPortalError('intake', 0, message);
    if (page.data.length < PAGE_SIZE) {
      if (total !== undefined && rows.length < total) throw new KfmPortalError('intake', 0, message);
      return rows;
    }
    if (total !== undefined && rows.length >= total) return rows;
  }
}
const skuText = (value: unknown) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const exactSkuName = (value: unknown) => skuText(value).replace(/\bbmq\b/g, ' ').replace(/\s+/g, ' ').trim();
const skuName = (value: unknown) => skuText(value).replace(/\bbmq\b/g, ' ').replace(/\b\d+(?:[.,]\d+)?\s*(?:g|gr|gram|grams|kg|ml|l|lit|litre|hop|cai|goi|thung)\b/g, ' ').replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
export function mapIntakeSkus(payload: Row, skus: Row[], settings: Row[]) {
  const enabled = new Set(settings.filter(row => row.is_enabled).map(row => row.sku_id));
  payload.production_items = payload.production_items.map((item: Row) => {
    const eligible = skus.filter(row => row.sku_type ? row.sku_type === 'finished_good' : /thanh pham|finished/.test(skuText(row.category)));
    const byCode = eligible.filter(row => skuText(row.sku_code) === skuText(item.sku_code || item.sku));
    // Preserve pack/weight distinctions (Croissant 50g vs 160g) before the legacy
    // relaxed name tier. A nonunique fallback is blocked, never chosen by order.
    const byExactName = eligible.filter(row => exactSkuName(row.product_name) && exactSkuName(row.product_name) === exactSkuName(item.product_name));
    const matches = byCode.length ? byCode : byExactName.length ? byExactName : eligible.filter(row => skuName(row.product_name) && skuName(row.product_name) === skuName(item.product_name));
    if (matches.length !== 1 || !enabled.has(matches[0].id)) throw new KfmPortalError('intake', 0, `SKU chưa khớp duy nhất hoặc chưa bật tại Q7: ${item.product_name}. Chưa xác nhận PO.`);
    return { ...item, sku_code: matches[0].sku_code, sku_id: matches[0].id };
  });
  return payload;
}
async function mappedPayload(admin: Admin, source: KfmTripSource, vendorId: number, actorId: string) {
  const [skus, settings] = await Promise.all([
    readAllRows(() => admin.from('product_skus').select('id,sku_code,product_name,sku_type,category', { count: 'exact' }).or(FINISHED_SKU_QUERY), 'Không đọc được mapping SKU.'),
    readAllRows(() => admin.from('production_location_sku_settings').select('sku_id,is_enabled', { count: 'exact' }).eq('location_code', 'q7'), 'Không đọc được SKU bật tại Q7.'),
  ]);
  return mapIntakeSkus(productionPayload(source, vendorId, actorId), skus, settings);
}
async function getAttempt(admin: Admin, vendorId: number, orderId: number) {
  return checked(await admin.from('kfm_po_intake_attempts').select('*').eq('vendor_id', vendorId).eq('order_id', orderId).maybeSingle(), 'Không đọc được nhật ký duyệt PO.');
}
export type TripIntakeGate = { ok: boolean; state: string; message?: string; inboxId?: string };
/**
 * The print flow may only write a delivery trip once the PO is confirmed on the
 * portal and, when confirmation was still pending, durably confirmed+imported.
 * It reuses the review popup's unique intake claim, so a confirm and a reject
 * can never both win for one PO, and a retry after a timeout only re-reads the
 * claimed decision (never re-sends it).
 *
 * An already-confirmed PO skips the portal write but an existing reject claim
 * still closes the gate; a still-pending PO only opens it after a fresh confirm
 * reaches a verified local import.
 */
export async function ensureTripIntake(admin: Admin, token: string, vendorId: number, actorId: string, orderId: number, source: KfmTripSource): Promise<TripIntakeGate> {
  const attempt = await getAttempt(admin, vendorId, orderId);
  if (attempt) {
    const result: Row = await recovery(admin, token, attempt);
    return { ok: result.state === 'imported', state: result.state, message: result.message, inboxId: result.inboxId };
  }
  // Already confirmed on the portal: never send a second confirmation. Reject is
  // only possible while the PO is pending, so a confirmed PO cannot be refused
  // later; the claim read above still catches an earlier refusal.
  if (tripPoConfirmation(source.po).confirmed) return { ok: true, state: 'confirmed' };
  const decision: Row = await handleKfmIntake(admin, token, vendorId, actorId, {
    action: 'intake-decide', orderId, vendorId, decision: 'confirm',
    requestId: crypto.randomUUID(), revision: await intakeRevision(source),
  });
  const result: Row = decision.result || { state: 'unknown', message: 'Chưa xác minh được quyết định duyệt PO. Chưa tạo phiếu giao hàng.' };
  return { ok: result.state === 'imported', state: result.state, message: result.message, inboxId: result.inboxId };
}
async function recovery(admin: Admin, token: string, attempt: Row) {
  if (['imported', 'rejected'].includes(attempt.state)) return { state: attempt.state, inboxId: attempt.inbox_id };
  let source: KfmTripSource;
  try { source = await getTripSource(token, { vendorId: attempt.vendor_id, orderId: attempt.order_id }); }
  catch { return { state: 'unknown', message: 'Chưa đọc được kết quả từ KFM. Chỉ kiểm tra lại, không gửi lại yêu cầu.' }; }
  if (attempt.decision === 'reject') {
    if (Number(source.po.subStatus) !== 11) return { state: 'unknown', message: 'KFM chưa xác nhận PO đã từ chối/hủy. Không gửi lại.' };
    checked(await admin.from('kfm_po_intake_attempts').update({ state: 'rejected', updated_at: new Date().toISOString() }).eq('vendor_id', attempt.vendor_id).eq('order_id', attempt.order_id), 'Đã đọc trạng thái từ chối nhưng chưa lưu kết quả.');
    return { state: 'rejected', message: 'KFM đã ghi nhận trạng thái từ chối/hủy PO.' };
  }
  if (!tripPoConfirmation(source.po).confirmed) return { state: 'unknown', message: 'Chưa xác minh PO được KFM xác nhận. Không nhập sản xuất và không gửi lại.' };
  if (await intakeRevision(source, false) !== attempt.content_revision) return { state: 'blocked', message: 'Nội dung PO đã thay đổi sau khi duyệt. Cần đối chiếu trên portal; chưa nhập sản xuất.' };
  let payload;
  try { payload = await mappedPayload(admin, source, attempt.vendor_id, attempt.actor_id); }
  catch { return { state: 'unknown', message: 'PO đã xác nhận; mapping SKU tại Q7 chưa hợp lệ. Sửa mapping rồi kiểm tra kết quả để nhập tiếp.' }; }
  const saved = await admin.rpc('kfm_import_confirmed_po', { p_vendor_id: attempt.vendor_id, p_order_id: attempt.order_id, p_payload: payload });
  if (saved.error) return { state: 'unknown', message: 'KFM đã xác nhận; chưa nhập được vào sản xuất. Chọn kiểm tra kết quả để tiếp tục, không xác nhận lại.' };
  return { state: 'imported', inboxId: saved.data };
}
export async function handleKfmIntake(admin: Admin, token: string, vendorId: number, actorId: string, payload: Row) {
  if (payload.action === 'intake-list') {
    const attempts: Row[] = checked(await admin.from('kfm_po_intake_attempts').select('*').eq('vendor_id', vendorId), 'Không tải được nhật ký PO.');
    const legacy: Row[] = checked(await admin.rpc('kfm_existing_po_numbers'), 'Không đối chiếu được PO đã nhập.');
    const imported = new Set(legacy.map(row => canonicalPo(row.po_number)));
    const candidates = new Map<number, Row>();
    for (let page = 0; page < 30; page++) {
      const result = await listOrders(token, { vendorId, deliveryDateFrom: vnDate(), page, size: 100 });
      for (const row of result.orders) {
        const attempt = attempts.find(a => a.order_id === row.portalId);
        if (attempt && ['imported', 'rejected'].includes(attempt.state)) continue;
        if (!attempt && (imported.has(canonicalPo(row.code)) || ![3, 5, 6, 9].includes(Number(row.subStatus)))) continue;
        candidates.set(row.portalId, row);
      }
      if (result.orders.length < 100 || (page + 1) * 100 >= result.totalElements) break;
      if (page === 29) throw new KfmPortalError('intake', 0, 'Danh sách PO quá lớn, chưa tải đầy đủ.');
    }
    // Uncertain operations survive delivery-day rollover; reconciliation remains GET-only.
    for (const attempt of attempts) if (!['imported', 'rejected'].includes(attempt.state)) candidates.set(attempt.order_id, {});
    const orders = [];
    for (const [orderId] of candidates) {
      const source = await getTripSource(token, { vendorId, orderId });
      if (Number(source.po.id) !== orderId) throw new KfmPortalError('intake', 0, 'Chi tiết PO không khớp mã đã tải.');
      if (!attempts.some(a => a.order_id === orderId) && ![3, 5, 6, 9].includes(Number(source.po.subStatus))) continue;
      orders.push(await orderView(source, attempts.find(a => a.order_id === orderId)));
    }
    return { success: true, vendorId, count: orders.length, orders };
  }
  const orderId = Number(payload.orderId);
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new KfmPortalError('intake', 0, 'Thiếu mã PO hợp lệ.');
  // Scope must be verified before reading detail or reconciling a mutation.
  if (!(await tripOrderInScope(token, vendorId, orderId))) throw new KfmPortalError('intake', 403, 'PO không thuộc danh sách nhà cung cấp được phép truy cập.');
  const existing = await getAttempt(admin, vendorId, orderId);
  if (existing) return { success: true, result: await recovery(admin, token, existing) };
  if (payload.action === 'intake-result') {
    const source = await getTripSource(token, { vendorId, orderId });
    return { success: true, result: { state: 'changed', message: 'Chưa có yêu cầu được ghi nhận. Xem lại PO trước khi gửi quyết định.' }, order: await orderView(source) };
  }
  if (!['confirm', 'reject'].includes(payload.decision) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.requestId || '')) throw new KfmPortalError('intake', 0, 'Quyết định hoặc mã yêu cầu không hợp lệ.');
  const reason = String(payload.reason || '').trim();
  if (payload.decision === 'reject' && (!reason || reason.length > 1000)) throw new KfmPortalError('intake', 0, 'Nhập lý do từ chối (tối đa 1000 ký tự).');
  const source = await getTripSource(token, { vendorId, orderId });
  if (Number(source.po.id) !== orderId || !validSource(source)) throw new KfmPortalError('intake', 0, 'PO không hợp lệ để duyệt.');
  const alreadyImported: Row[] = checked(await admin.rpc('kfm_existing_po_numbers'), 'Chưa đối chiếu được PO đã nhập. Chưa gửi quyết định.');
  if (alreadyImported.some(row => canonicalPo(row.po_number) === canonicalPo(source.po.code))) return { success: true, result: { state: 'blocked', message: 'PO đã có trong hệ thống. Làm mới danh sách; không gửi lại quyết định lên KFM.' } };
  if (await intakeRevision(source) !== payload.revision) return { success: true, result: { state: 'changed', message: 'PO đã thay đổi. Xem lại thông tin trước khi duyệt.' }, order: await orderView(source) };
  const subStatus = Number(source.po.subStatus);
  if (!(payload.decision === 'confirm' ? [3, 5, 6, 9] : [3]).includes(subStatus)) return { success: true, result: { state: 'blocked', message: 'Trạng thái PO không còn cho phép thao tác này. Làm mới danh sách.' } };
  // Legacy guard: a PO that already has a delivery trip in the journal must not
  // be refused. The unique claim written below is the race protection for new
  // writes; this also covers trips created before print auto-confirmation existed.
  if (payload.decision === 'reject') {
    const trip = await checked(await admin.from('kfm_trip_attempts').select('order_id').eq('vendor_id', vendorId).eq('order_id', orderId).maybeSingle(), 'Không đọc được nhật ký chuyến giao. Chưa gửi quyết định.');
    if (trip) return { success: true, result: { state: 'blocked', message: 'PO đã có chuyến/phiếu giao hàng trên hệ thống. Không từ chối/hủy; kiểm tra lại trên cổng KFM.' } };
  }
  // Validate import shape before sending confirmation, not after the irreversible action.
  if (payload.decision === 'confirm') {
    checked(await admin.rpc('kfm_intake_customer_id'), 'Mapping khách hàng KFM chưa rõ ràng. Chưa xác nhận PO.');
    await mappedPayload(admin, source, vendorId, actorId);
  }
  const fresh = await getTripSource(token, { vendorId, orderId });
  if (await intakeRevision(fresh) !== payload.revision) return { success: true, result: { state: 'changed', message: 'PO vừa thay đổi. Xem lại trước khi duyệt.' }, order: await orderView(fresh) };
  const attempt = { vendor_id: vendorId, order_id: orderId, po_number: canonicalPo(source.po.code), actor_id: actorId,
    request_id: payload.requestId, decision: payload.decision, reason: reason || null, state: 'sending', content_revision: await intakeRevision(source, false), snapshot: intakeSnapshot(source) };
  const claim = await admin.from('kfm_po_intake_attempts').insert(attempt);
  if (claim.error) {
    if (claim.error.code !== '23505') throw new KfmPortalError('intake', 0, 'Không khóa được yêu cầu duyệt; chưa gửi lên KFM.');
    const winner = await getAttempt(admin, vendorId, orderId);
    return { success: true, result: winner ? await recovery(admin, token, winner) : { state: 'blocked', message: 'Mã PO này đã có yêu cầu xử lý khác. Làm mới danh sách.' } };
  }
  try {
    if (payload.decision === 'reject') await rejectOrder(token, { vendorId, orderId, reason });
    else if (!tripPoConfirmation(source.po).confirmed) await confirmOrder(token, { vendorId, orderId });
  } catch { /* The durable claim remains held; recovery is read-only even after a timeout. */ }
  return { success: true, result: await recovery(admin, token, attempt) };
}
