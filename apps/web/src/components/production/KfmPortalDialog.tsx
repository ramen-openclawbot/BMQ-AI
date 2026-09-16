import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Printer, RefreshCw, Truck } from "lucide-react";

import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { KfmTimeSelect, isCompleteKfmTime } from "./KfmTimeSelect";

/** Today's two-action print workspace. Portal writes only follow an operator click.
 * Hallmark: functional workbench; existing BMQ tokens, typography and primary color.
 * The filename stays stable for existing integration contracts; no modal is used.
 */

const AUTO_CONFIRM_NOTICE = "Tạo phiếu giao hàng sẽ tự động xác nhận đơn hàng. Sau bước này sẽ không thể yêu cầu chỉnh sửa nữa.";
const changeLabel = (category: string) => ({ QUANTITY: "Số lượng", QUALITY: "Ngoại quan", SHELF_LIFE: "Hạn sử dụng", DELIVERY_DATE: "Ngày giao", OTHER: "Khác" }[category] || category);

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export function vnDateOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000 + VN_OFFSET_MS).toISOString().slice(0, 10);
}

type KfmOrder = {
  portalId: number;
  code: string;
  deliveryDate: string | null;
  locationName: string | null;
  itemCount: number | null;
  totalQty: number | null;
  statusLabel?: string;
};

type KfmTripItem = {
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

type TripForm = {
  savedVehicleId?: number | null;
  savedDriverId?: number | null;
  vehicleTypeId: number | null;
  bookingTimeSlot: string;
  expectedTimeFrom: string;
  expectedTimeTo: string;
  licensePlate: string;
  driverName: string;
  driverPhone: string;
  note: string;
  totalCartons: number;
  totalPallets: number;
};
type TripOptions = {
  deliveryType: "HUB" | "FIXED" | "BOOKING" | null;
  vehicleTypes: Array<{ id: number; name: string }>;
  vehicleTypeId: number | null;
  slots: Array<{ value: string; available: boolean }>;
};
type TripResult = { poConfirmation?: { confirmed: boolean; label: string; subStatus: number | null }; state: "verified" | "unknown" | "not_sent"; message: string; loadId?: number; loadCode?: string; asns?: Array<{ asnId: number; asnCode: string }> };
type SavedFleet = { vehicles: Array<{ id: number; plateNumber: string; defaultDriverId: number | null }>; drivers: Array<{ id: number; name: string; phone: string }> };
type ExistingNote = { asnId: number; asnCode: string | null };
type TripCreate = { fleet: SavedFleet; needed: string[]; existingNotes?: ExistingNote[]; order: KfmOrder; date: string; revision: string; options: TripOptions; form: TripForm; items: KfmTripItem[]; warehouse: string; pendingChangeCategories: string[]; result?: TripResult; error?: string };


type KfmResponse = {
  success: boolean;
  configured?: boolean;
  action?: string;
  deliveryDate?: string;
  vendorCode?: string | null;
  vendorId?: number | null;
  count?: number;
  orders?: KfmOrder[];
  order?: { purchaseOrderId: number | null };
  existingNotes?: ExistingNote[];
  fleet?: SavedFleet;
  draft?: unknown;
  source?: unknown;
  rawRows?: unknown;
  shippedMap?: unknown;
  filename?: string;
  base64?: string;
  session?: { mode: string; obtainedAt: string };
  error?: string;
  step?: string;
  message?: string;
  revision?: string;
  options?: TripOptions;
  pendingChangeCategories?: string[];
  result?: TripResult;
};

const qty = (value: number | null | undefined) =>
  typeof value === "number" ? value.toLocaleString("vi-VN", { maximumFractionDigits: 0 }) : "—";

async function callPortal(body: Record<string, unknown>): Promise<KfmResponse> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.");

  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kfm-portal-sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  let parsed: KfmResponse;
  try {
    parsed = raw ? JSON.parse(raw) : { success: false };
  } catch {
    throw new Error("Phản hồi từ cổng KFM không hợp lệ.");
  }
  if (!response.ok && !parsed?.error) {
    throw new Error(parsed?.message || "Không gọi được cổng KFM");
  }
  if (parsed.success === false) {
    throw new Error(parsed.message || "Cổng KFM báo lỗi.");
  }
  return parsed;
}

function savePdf(base64: string, filename: string, viewer?: Window | null): void {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  if (viewer) {
    // Show the sheet in the tab opened on click; the blob must outlive that
    // navigation, so it is revoked on a delay instead of immediately.
    viewer.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * The tab opened on the click is blank until the sheet arrives, which reads as
 * a broken window. Write the panel's waiting state into that tab immediately;
 * the PDF replaces it when the file is ready. Styles are inline on purpose:
 * a fresh about:blank tab has none of the application CSS.
 */
function writePrintPlaceholder(viewer: Window, isVi: boolean, what: string): void {
  const title = isVi ? "Đang chuẩn bị file in..." : "Preparing the print file...";
  const hint = isVi ? `Đang tạo ${what}` : `Building ${what}`;
  const doc = viewer.document;
  const body = doc?.body;
  if (!doc || !body) return;
  doc.title = title;
  // A fresh about:blank tab carries no viewport meta, so a phone lays the page
  // out at the 980px default and then shrinks the whole thing: every clamp()
  // renders at a fraction of its size and the waiting page reads as a speck in
  // a white screen. Pin the real viewport before painting.
  const meta: Element = doc.querySelector('meta[name="viewport"]') || doc.createElement("meta");
  meta.setAttribute("name", "viewport");
  meta.setAttribute("content", "width=device-width,initial-scale=1");
  if (!meta.parentNode) (doc.head || doc.documentElement).appendChild(meta);
  // One animation only (the spinner): the bouncing dots were a second one.
  body.innerHTML = `
    <div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:clamp(12px,3vw,18px);padding:clamp(20px,6vw,40px);background:#fff;color:#0f172a;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center">
      <span style="display:block;width:clamp(40px,11vw,52px);height:clamp(40px,11vw,52px);border-radius:9999px;border:4px solid #dbeafe;border-top-color:#2563eb;animation:kfm-spin .9s linear infinite"></span>
      <p style="margin:0;font-size:clamp(15px,3.6vw,17px);font-weight:600;line-height:1.35">${title}</p>
      <p style="margin:0;font-size:clamp(12px,2.9vw,14px);color:#475569">${hint}</p>
      <style>@keyframes kfm-spin{to{transform:rotate(360deg)}}</style>
    </div>`;
}

export default function KfmPrintWorkspace({ isVi = true }: { isVi?: boolean }) {
  const [deliveryDate, setDeliveryDate] = useState(() => vnDateOffset(0));
  const [busy, setBusy] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["kfm-portal-orders", deliveryDate],
    queryFn: () => callPortal({ action: "list", deliveryDate }),
    retry: false,
    staleTime: 30_000,
  });

  const data = query.data;
  const orders = data?.orders || [];

  // One keyed slot for every print action in the panel (`po-*`, `asn-*`), so
  // the waiting banner, the toast and the disabled state stay in one place.
  const [printing, setPrinting] = useState<string | null>(null);

  const [creating, setCreating] = useState<TripCreate | null>(null);
  const createLock = useRef(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [dayNotice, setDayNotice] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, { error: boolean; message: string }>>({});

  // A tab can remain open overnight or be suspended on a phone. Refresh the
  // queue on return, but never retarget an operation already in flight.
  useEffect(() => {
    const syncDay = () => {
      const today = vnDateOffset(0);
      if (today !== deliveryDate && !createLock.current) {
        setDeliveryDate(today);
        // Keep an uncertain submitted request (or a verified PDF retry) readable.
        // Only unsent prepared forms expire; recovery never creates a new trip.
        setCreating(current => current?.result && current.result.state !== "not_sent" ? current : null);
        setFeedback({});
        setDayNotice(true);
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") syncDay(); };
    const timer = window.setInterval(syncDay, 1000);
    window.addEventListener("focus", syncDay);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", syncDay);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [deliveryDate]);

  const requireToday = (date: string) => {
    if (date !== vnDateOffset(0)) throw new Error("Đã sang ngày mới. Danh sách hôm nay đang được cập nhật; vui lòng chọn lại PO.");
  };


  const pdfFor = async (result: TripResult | ExistingNote, viewer: Window | null, key: string) => {
    const request = "asnId" in result
      ? { action: "asn-pdf", asnId: result.asnId, code: result.asnCode }
      : { action: "load-pdf", loadId: result.loadId, code: result.loadCode };
    const pdf = await callPortal({ ...request, layout: "NO_PRICE" });
    if (!pdf.base64) throw new Error("Cổng KFM chưa trả file in.");
    savePdf(pdf.base64, pdf.filename || "PhieuGiaoHang.pdf", viewer);
    finishPrint(key, "Đã mở phiếu giao hàng.");
    setCreating(null);
  };

  // Only fill unambiguous saved selections; portal does NOT choose the first vehicle.
  const fillSaved = (fleet: SavedFleet, options: TripOptions, previous?: TripForm): TripForm => {
    const vehicle = fleet.vehicles.find(row => row.id === previous?.savedVehicleId)
      || (fleet.vehicles.length === 1 ? fleet.vehicles[0] : undefined);
    const driver = fleet.drivers.find(row => row.id === previous?.savedDriverId)
      || fleet.drivers.find(row => row.id === vehicle?.defaultDriverId)
      || (fleet.drivers.length === 1 ? fleet.drivers[0] : undefined);
    const slots = options.slots.filter(row => row.available);
    return { note: "", totalCartons: 0, totalPallets: 0, expectedTimeFrom: "", expectedTimeTo: "", ...previous,
      vehicleTypeId: options.vehicleTypeId,
      bookingTimeSlot: slots.some(row => row.value === previous?.bookingTimeSlot) ? previous!.bookingTimeSlot : slots.length === 1 ? slots[0].value : "",
      savedVehicleId: vehicle?.id, savedDriverId: driver?.id,
      licensePlate: vehicle?.plateNumber || (fleet.vehicles.length ? "" : previous?.licensePlate || ""),
      driverName: driver?.name || (fleet.drivers.length && !driver ? "" : previous?.driverName || ""), driverPhone: driver?.phone || (fleet.drivers.length && !driver ? "" : previous?.driverPhone || "") };
  };
  const missingFields = (form: TripForm, options: TripOptions) => [
    ...(options.vehicleTypes.length && !form.vehicleTypeId ? ["vehicleTypeId"] : []),
    ...(!form.licensePlate.trim() ? ["licensePlate"] : []),
    ...(!form.driverName.trim() || !form.driverPhone.trim() ? ["driver"] : []),
    ...(options.deliveryType ? (!form.bookingTimeSlot ? ["bookingTimeSlot"] : [])
      : (!isCompleteKfmTime(form.expectedTimeFrom) || !isCompleteKfmTime(form.expectedTimeTo) || form.expectedTimeFrom >= form.expectedTimeTo ? ["time"] : [])),
  ];

  const sendAndPrint = async (snapshot: TripCreate, viewer: Window | null, key: string) => {
    requireToday(snapshot.date);
    // Persist uncertainty in the UI before sending; recovery is GET-only server-side.
    setCreating({ ...snapshot, result: { state: "unknown", message: "Đang chuẩn bị phiếu. Không gửi lại yêu cầu." } });
    try {
      const response = await callPortal({ action: "create-load", unifiedPrint: true, orderId: snapshot.order.portalId, deliveryDate: snapshot.date, revision: snapshot.revision, form: snapshot.form, confirmed: true, requestId: crypto.randomUUID() });
      if (response.existingNotes?.length) {
        if (response.existingNotes.length === 1) { await pdfFor(response.existingNotes[0], viewer, key); setCreating(null); }
        else { setCreating({ ...snapshot, existingNotes: response.existingNotes }); viewer?.close(); setPrinting(null); setFeedback(current => { const next = { ...current }; delete next[key.split("-").pop()!]; return next; }); toast.dismiss(key); }
        return;
      }
      if (!response.result) throw new Error("Chưa nhận được kết quả tạo phiếu.");
      setCreating({ ...snapshot, result: response.result });
      if (response.result.state === "verified") await pdfFor(response.result, viewer, key);
      else { viewer?.close(); setPrinting(null); setFeedback(current => { const next = { ...current }; delete next[key.split("-").pop()!]; return next; }); toast.dismiss(key); }
      void query.refetch();
    } catch (error) {
      setCreating(current => ({ ...snapshot, result: current?.result?.state === "verified" ? current.result : { state: "unknown", message: `${(error as Error).message} Chọn ‘Kiểm tra kết quả’; không gửi lại.` } }));
      failPrint(key, viewer, error);
    }
  };

  const openCreate = async (order: KfmOrder, date = deliveryDate, previous?: TripForm, autoStart = true) => {
    if (createLock.current) return;
    createLock.current = true; setCreateBusy(true); setBusy(`create-${order.portalId}`);
    const key = `asn-${order.portalId}`;
    const viewer = autoStart ? window.open("", "_blank") : null;
    beginPrint(key, viewer, `phiếu giao hàng ${order.code}`);
    const emptyOptions: TripOptions = { deliveryType: null, vehicleTypes: [], vehicleTypeId: null, slots: [] };
    const emptyFleet: SavedFleet = { vehicles: [], drivers: [] };
    const initial: TripCreate = { order, date, revision: "", options: emptyOptions, fleet: emptyFleet, needed: [], form: fillSaved(emptyFleet, emptyOptions, previous), items: [], pendingChangeCategories: [], warehouse: order.locationName || "" };
    setCreating(null);
    try {
      requireToday(date);
      const response = await callPortal({ action: "trip-options", unifiedPrint: true, orderId: order.portalId, deliveryDate: date, form: previous });
      if (response.result) {
        setCreating({ ...initial, result: response.result });
        if (response.result.state === "verified" && autoStart) await pdfFor(response.result, viewer, key);
        else { viewer?.close(); setPrinting(null); setFeedback(current => { const next = { ...current }; delete next[key.split("-").pop()!]; return next; }); toast.dismiss(key); }
        return;
      }
      if (response.existingNotes?.length) {
        if (response.existingNotes.length === 1 && autoStart) await pdfFor(response.existingNotes[0], viewer, key);
        else { setCreating({ ...initial, existingNotes: response.existingNotes }); viewer?.close(); setPrinting(null); setFeedback(current => { const next = { ...current }; delete next[key.split("-").pop()!]; return next; }); toast.dismiss(key); }
        return;
      }
      if (!response.options || !response.revision || !response.fleet) throw new Error("Chưa đọc được đầy đủ cấu hình xe/tài xế trên portal. Chưa tạo phiếu.");
      const form = fillSaved(response.fleet, response.options, previous);
      const snapshot: TripCreate = { ...initial, form, fleet: response.fleet, options: response.options, revision: response.revision,
        needed: missingFields(form, response.options), pendingChangeCategories: response.pendingChangeCategories || [],
        items: (response.draft as { stops?: Array<{ items: KfmTripItem[] }> })?.stops?.[0]?.items || [] };
      if (!snapshot.items.length) throw new Error("Không còn sản phẩm đủ điều kiện. Chưa tạo thêm phiếu.");
      if (autoStart && !snapshot.needed.length && !snapshot.pendingChangeCategories.length) await sendAndPrint(snapshot, viewer, key);
      else { setCreating(snapshot); viewer?.close(); setPrinting(null); setFeedback(current => { const next = { ...current }; delete next[key.split("-").pop()!]; return next; }); toast.dismiss(key); }
    } catch (error) { setCreating(current => current?.result ? current : { ...initial, error: (error as Error).message }); failPrint(key, viewer, error); }
    finally { createLock.current = false; setCreateBusy(false); setBusy(null); }
  };

  const submitCreate = async () => {
    if (!creating || createLock.current || creating.result || !creating.revision || missingFields(creating.form, creating.options).length) return;
    createLock.current = true; setCreateBusy(true); setBusy(`create-${creating.order.portalId}`);
    const key = `asn-${creating.order.portalId}`;
    const viewer = window.open("", "_blank");
    beginPrint(key, viewer, `phiếu giao hàng ${creating.order.code}`);
    try { await sendAndPrint(creating, viewer, key); }
    catch (error) { failPrint(key, viewer, error); }
    finally { createLock.current = false; setCreateBusy(false); setBusy(null); }
  };

  const checkCreate = async () => {
    if (!creating || createLock.current) return;
    createLock.current = true; setCreateBusy(true);
    const key = `asn-${creating.order.portalId}`;
    const viewer = window.open("", "_blank");
    beginPrint(key, viewer, `phiếu giao hàng ${creating.order.code}`);
    try {
      const response = await callPortal({ action: "trip-result", orderId: creating.order.portalId, deliveryDate: creating.date });
      if (!response.result) throw new Error("Chưa đọc được kết quả.");
      setCreating({ ...creating, result: response.result });
      if (response.result.state === "verified") await pdfFor(response.result, viewer, key);
      else { viewer?.close(); setPrinting(null); setFeedback(current => { const next = { ...current }; delete next[key.split("-").pop()!]; return next; }); toast.dismiss(key); }
    } catch (error) { failPrint(key, viewer, error); }
    finally { createLock.current = false; setCreateBusy(false); }
  };

  const printExisting = async (note: ExistingNote | TripResult) => {
    if (createLock.current) return;
    createLock.current = true;
    const key = `asn-${creating?.order.portalId}`;
    const viewer = window.open("", "_blank");
    beginPrint(key, viewer, "phiếu giao hàng");
    try { await pdfFor(note, viewer, key); }
    catch (error) { failPrint(key, viewer, error); }
    finally { createLock.current = false; }
  };

  /**
   * Every print action waits the same way: one keyed slot drives the banner,
   * the transient toast and the disabled state, and the tab opened on the click
   * immediately shows the waiting state instead of a blank page.
   */
  const beginPrint = (key: string, viewer: Window | null, what: string) => {
    setPrinting(key);
    setFeedback(current => ({ ...current, [key.split("-").pop()!]: { error: false, message: isVi ? "Đang chuẩn bị file in…" : "Preparing PDF…" } }));
    toast.loading(isVi ? "Đang chuẩn bị file in..." : "Preparing the print file...", {
      id: key,
      duration: Number.POSITIVE_INFINITY,
    });
    if (viewer) writePrintPlaceholder(viewer, isVi, what);
  };

  const finishPrint = (key: string, message: string) => {
    setPrinting(null);
    setFeedback(current => ({ ...current, [key.split("-").pop()!]: { error: false, message } }));
    toast.dismiss(key);
  };

  const failPrint = (key: string, viewer: Window | null, error: unknown) => {
    setPrinting(null);
    viewer?.close();
    setFeedback(current => ({ ...current, [key.split("-").pop()!]: { error: true, message: (error as Error)?.message || "Cổng KFM báo lỗi." } }));
    toast.dismiss(key);
  };

  const handlePrintPo = async (order: KfmOrder) => {
    if (createLock.current) return;
    createLock.current = true;
    const key = `po-${order.portalId}`;
    const viewer = window.open("", "_blank");
    beginPrint(key, viewer, `PO ${order.code}`);
    try {
      requireToday(deliveryDate);
      const detail = await callPortal({ action: "detail", deliveryDate, orderId: order.portalId });
      const poId = detail.order?.purchaseOrderId ?? order.portalId;
      const pdf = await callPortal({ action: "po-pdf", poId, code: order.code });
      if (!pdf.base64) throw new Error(isVi ? "Cổng KFM chưa trả file in PO." : "The KFM portal has not returned the PO PDF.");
      savePdf(pdf.base64, pdf.filename || `PO-${order.code}.pdf`, viewer);
      finishPrint(key, isVi ? `Đã mở PO ${order.code}.` : `PO ${order.code} opened.`);
    } catch (error) {
      failPrint(key, viewer, error);
    } finally {
      createLock.current = false;
    }
  };

  const renderOrderActions = (order: KfmOrder) => (
    <div className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:grid-cols-2" data-kfm-actions="direct-v1">
      <Button variant="outline" className="h-11 gap-2 whitespace-nowrap rounded-xl px-5"
        data-kfm-action="print-po" disabled={printing !== null || busy !== null || query.isFetching || query.isError}
        onClick={() => void handlePrintPo(order)}>
        {printing === `po-${order.portalId}` ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Printer className="h-4 w-4" />}
        {isVi ? "In PO" : "Print PO"}
      </Button>
      <Button className="h-11 gap-2 whitespace-nowrap rounded-xl px-5"
        data-kfm-action="print-asn" disabled={printing !== null || busy !== null || query.isFetching || query.isError}
        aria-expanded={creating?.order.portalId === order.portalId}
        aria-controls={creating?.order.portalId === order.portalId ? `kfm-form-${order.portalId}` : undefined}
        onClick={() => void openCreate(order)}>
        {printing === `asn-${order.portalId}` ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Truck className="h-4 w-4" />}
        {isVi ? "In phiếu giao hàng" : "Print delivery note"}
      </Button>
    </div>
  );

  const renderCreate = () => creating && (
<section className="mt-4 min-w-0 space-y-4 rounded-xl border border-border bg-muted/40 p-4" data-kfm-create="v2" id={`kfm-form-${creating.order.portalId}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="min-w-0 break-all text-sm font-semibold">In phiếu giao hàng · {creating.order.code}</h3>
                  <Button className="min-h-11" size="sm" variant="ghost" disabled={createBusy || printing !== null} onClick={() => setCreating(null)}>Đóng</Button>
                </div>
                {creating.error && <p role="alert" className="text-sm text-destructive">{creating.error}</p>}
                {creating.existingNotes ? <div className="flex flex-wrap gap-2">
                  <p className="w-full text-sm">Chọn phiếu đã có để in:</p>
                  {creating.existingNotes.map(note => <Button className="min-h-11" key={note.asnId} disabled={printing !== null} onClick={() => void printExisting(note)}>{note.asnCode || note.asnId}</Button>)}
                </div> : creating.result ? (
                  <div className="space-y-2 text-sm" data-kfm-create-result={creating.result.state} role="status">
                    <p>{creating.result.message}</p>
                    {creating.result.poConfirmation && <p data-kfm-po-readback="v1">PO: {creating.result.poConfirmation.label}</p>}
                    {creating.result.state === "verified" ? <Button className="min-h-11" disabled={printing !== null || createBusy} onClick={() => void printExisting(creating.result!)}>In phiếu giao hàng</Button>
                      : creating.result.state === "not_sent" ? <Button className="min-h-11" disabled={createBusy} onClick={() => void openCreate(creating.order, creating.date, creating.form, false)}>Kiểm tra lại thông tin</Button>
                      : <Button className="min-h-11" data-kfm-action="check-create" disabled={createBusy} onClick={() => void checkCreate()}>Kiểm tra kết quả</Button>}
                  </div>
                ) : creating.revision && <>
                  <p className="text-sm" data-kfm-auto-confirm="v1">{AUTO_CONFIRM_NOTICE}</p>
                  {creating.pendingChangeCategories.length > 0 && <p className="text-sm" data-kfm-pending-changes="v1">Yêu cầu chỉnh sửa sẽ tự động hủy: {creating.pendingChangeCategories.map(changeLabel).join(", ")}.</p>}
                  <p className="text-xs text-muted-foreground">{creating.warehouse} · {creating.date}<br />{[creating.form.licensePlate, creating.form.driverName, creating.form.driverPhone].filter(Boolean).join(" · ")}</p>
                  <fieldset disabled={createBusy} className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                    {creating.needed.includes("vehicleTypeId") && <label className="text-xs">Loại xe
                      <select data-kfm-field="vehicle" className="mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base sm:text-sm" value={creating.form.vehicleTypeId || ""} onChange={e => void openCreate(creating.order, creating.date, { ...creating.form, vehicleTypeId: Number(e.target.value) || null }, false)}>
                        <option value="">Chọn loại xe</option>{creating.options.vehicleTypes.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
                      </select>
                    </label>}
                    {creating.needed.includes("licensePlate") && <label className="text-xs">Xe đã lưu
                      {creating.fleet.vehicles.length ? <select data-kfm-field="saved-vehicle" className="mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base sm:text-sm" value={creating.form.savedVehicleId || ""} onChange={e => {
                        const form = fillSaved(creating.fleet, creating.options, { ...creating.form, savedVehicleId: Number(e.target.value) || null, savedDriverId: null, driverName: "", driverPhone: "" });
                        setCreating({ ...creating, form });
                      }}><option value="">Chọn xe</option>{creating.fleet.vehicles.map(row => <option key={row.id} value={row.id}>{row.plateNumber}</option>)}</select>
                      : <input data-kfm-field="plate" maxLength={40} className="mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base sm:text-sm" value={creating.form.licensePlate} onChange={e => setCreating({ ...creating, form: { ...creating.form, licensePlate: e.target.value } })} />}
                    </label>}
                    {creating.needed.includes("driver") && <label className="text-xs">Tài xế
                      {creating.fleet.drivers.length ? <select data-kfm-field="saved-driver" className="mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base sm:text-sm" value={creating.form.savedDriverId || ""} onChange={e => {
                        const driver = creating.fleet.drivers.find(row => row.id === Number(e.target.value));
                        setCreating({ ...creating, form: { ...creating.form, savedDriverId: driver?.id, driverName: driver?.name || "", driverPhone: driver?.phone || "" } });
                      }}><option value="">Chọn tài xế</option>{creating.fleet.drivers.map(row => <option key={row.id} value={row.id}>{row.name} · {row.phone}</option>)}</select>
                      : <div className="space-y-2">{([['driverName','Tên tài xế'],['driverPhone','Số điện thoại']] as const).map(([key,label]) => <input key={key} aria-label={label} placeholder={label} maxLength={key === 'driverName' ? 120 : 30} className="mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base sm:text-sm" value={creating.form[key]} onChange={e => setCreating({ ...creating, form: { ...creating.form, [key]: e.target.value } })} />)}</div>}
                    </label>}
                    {creating.needed.includes("driver") && creating.form.savedDriverId && ([['driverName','Tên tài xế','name'],['driverPhone','Số điện thoại','phone']] as const).map(([key,label,sourceKey]) => !creating.fleet.drivers.find(row => row.id === creating.form.savedDriverId)?.[sourceKey] && <label key={key} className="text-xs">{label}<input aria-label={label} maxLength={key === 'driverName' ? 120 : 30} className="mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base sm:text-sm" value={creating.form[key]} onChange={e => setCreating({ ...creating, form: { ...creating.form, [key]: e.target.value } })} /></label>)}
                    {creating.needed.includes("bookingTimeSlot") && <label className="text-xs">Khung giờ giao
                      <select data-kfm-field="slot" className="mt-1 block min-h-11 w-full min-w-0 rounded-lg border bg-background p-2 text-base sm:text-sm" value={creating.form.bookingTimeSlot} onChange={e => setCreating({ ...creating, form: { ...creating.form, bookingTimeSlot: e.target.value } })}>
                        <option value="">Chọn khung giờ</option>{creating.options.slots.map((slot,i) => <option key={i} value={slot.value} disabled={!slot.available}>{slot.value}</option>)}
                      </select>
                    </label>}
                    {creating.needed.includes("time") && ([['expectedTimeFrom','Giờ giao từ'],['expectedTimeTo','Giờ giao đến']] as const).map(([key,label]) => <KfmTimeSelect key={key} label={label} value={creating.form[key]} onChange={next => setCreating({ ...creating, form: { ...creating.form, [key]: next } })} />)}
                  </fieldset>
                  <Button className="min-h-11" data-kfm-action="submit-create" disabled={createBusy || missingFields(creating.form, creating.options).length > 0} onClick={() => void submitCreate()}>In phiếu giao hàng</Button>
                </>}
              </section>
  );

  return (
    <section className="mx-auto w-full min-w-0 max-w-6xl space-y-6 pb-8" data-kfm-today="v1" data-kfm-mobile="v2" data-kfm-unified-print="v1" data-kfm-po-print="v1">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
        <div className="flex min-w-0 items-start gap-3">
          <Button asChild variant="outline" className="h-11 w-11 shrink-0 rounded-xl p-0" aria-label={isVi ? "Quay lại xưởng Q7" : "Back to Q7"}>
            <Link to="/production/planning/q7"><ArrowLeft className="h-5 w-5" /></Link>
          </Button>
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-bold tracking-tight">{isVi ? "Cổng KFM" : "KFM portal"}</h1>
            <p className="mt-1 text-sm text-muted-foreground" data-kfm-today-date={deliveryDate}>
              {isVi ? "Hôm nay" : "Today"} · {deliveryDate.split("-").reverse().join("/")}
            </p>
          </div>
        </div>
        <Button variant="outline" className="h-11 gap-2 rounded-xl" onClick={() => void query.refetch()} disabled={query.isFetching || printing !== null || busy !== null}>
          {query.isFetching ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="h-4 w-4" />}
          {isVi ? "Làm mới" : "Refresh"}
        </Button>
      </header>

      <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
        {isVi ? "In PO để xem đơn hàng. In phiếu giao hàng: nếu chưa có phiếu, hệ thống tự xác nhận PO và tạo phiếu trước khi in." : "Print PO to view the order. Printing a delivery note confirms the PO and creates the note only if it does not exist."}
      </p>
      {dayNotice && <p role="status" className="rounded-xl bg-muted p-3 text-sm">{isVi ? "Đã sang ngày mới. Danh sách đã chuyển sang hôm nay." : "A new day has started. The list now shows today's orders."}</p>}
      {query.isError && <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{(query.error as Error)?.message}</div>}
      {data && data.configured === false && <p role="alert" className="rounded-xl border p-4 text-sm">{isVi ? "Chưa kết nối được Cổng KFM. Vui lòng liên hệ quản trị viên." : "KFM is not connected. Please contact your administrator."}</p>}
      {query.isFetching && <div role="status" className="flex items-center gap-3 py-6 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />{isVi ? "Đang tải đơn hôm nay…" : "Loading today's orders…"}</div>}
      {data?.success && data.configured !== false && <ul className="space-y-4" data-kfm-orders-cards="v2" aria-label={isVi ? "Đơn giao hôm nay" : "Today's delivery orders"}>
        {orders.map(order => (
          <li key={order.portalId} className="min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-5" data-kfm-order={order.portalId}>
            <div className="flex min-w-0 flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
              <div className="min-w-0 space-y-2">
                <h2 className="break-all text-lg font-semibold tracking-tight">{order.code}</h2>
                <p className="break-words text-sm text-muted-foreground">{order.locationName || "—"}</p>
                <p className="text-xs text-muted-foreground">{order.itemCount ?? "—"} {isVi ? "dòng sản phẩm" : "product lines"} · {isVi ? "SL" : "Qty"} {qty(order.totalQty)}</p>
              </div>
              <div className="shrink-0">{renderOrderActions(order)}</div>
            </div>
            {feedback[order.portalId] && !(creating?.order.portalId === order.portalId && creating.error) && (
              <p className={`mt-4 flex items-center gap-2 text-sm ${feedback[order.portalId].error ? "text-destructive" : "text-muted-foreground"}`}
                role={feedback[order.portalId].error ? "alert" : "status"} data-kfm-printing={printing?.endsWith(`-${order.portalId}`) ? "v1" : undefined}>
                {printing?.endsWith(`-${order.portalId}`) && <Loader2 className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" />}
                {feedback[order.portalId].message}
              </p>
            )}
            {creating?.order.portalId === order.portalId && renderCreate()}
          </li>
        ))}
        {!orders.length && !query.isFetching && !query.isError && <li className="rounded-2xl border border-dashed border-border px-5 py-14 text-center">
          <Printer className="mx-auto mb-4 h-7 w-7 text-muted-foreground" />
          <h2 className="font-semibold">{isVi ? "Hôm nay chưa có đơn giao" : "No delivery orders today"}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{isVi ? "Khi có PO trên cổng, bấm Làm mới để tải danh sách." : "Refresh when new POs are available on the portal."}</p>
        </li>}
      </ul>}
      {creating && !orders.some(order => order.portalId === creating.order.portalId) && renderCreate()}
    </section>
  );
}
