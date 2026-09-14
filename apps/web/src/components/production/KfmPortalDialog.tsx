import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Printer, RefreshCw, Truck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";

/**
 * "Cổng KFM" — reads tomorrow's POs straight from the KFM/Seedcom partner
 * portal through the `kfm-portal-sync` Edge Function.
 *
 * Products and quantities only: money is deliberately not shown here. The
 * panel replaces the email PO parse as the source of the day's orders, and
 * every action on the portal (create delivery note, print PO, print delivery note) is a
 * manual click — nothing runs on a schedule.
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

export default function KfmPortalDialog({ isVi = true }: { isVi?: boolean }) {
  const [open, setOpen] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState(() => vnDateOffset(1));
  const [busy, setBusy] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["kfm-portal-orders", deliveryDate],
    queryFn: () => callPortal({ action: "list", deliveryDate }),
    enabled: open,
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

  const pdfFor = async (result: TripResult | ExistingNote, viewer: Window | null, key: string) => {
    const request = "asnId" in result
      ? { action: "asn-pdf", asnId: result.asnId, code: result.asnCode }
      : { action: "load-pdf", loadId: result.loadId, code: result.loadCode };
    const pdf = await callPortal({ ...request, layout: "NO_PRICE" });
    if (!pdf.base64) throw new Error("Cổng KFM chưa trả file in.");
    savePdf(pdf.base64, pdf.filename || "PhieuGiaoHang.pdf", viewer);
    finishPrint(key, "Đã mở phiếu giao hàng.");
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
      : (!form.expectedTimeFrom || !form.expectedTimeTo || form.expectedTimeFrom >= form.expectedTimeTo ? ["time"] : [])),
  ];

  const sendAndPrint = async (snapshot: TripCreate, viewer: Window | null, key: string) => {
    // Persist uncertainty in the UI before sending; recovery is GET-only server-side.
    setCreating({ ...snapshot, result: { state: "unknown", message: "Đang chuẩn bị phiếu. Không gửi lại yêu cầu." } });
    try {
      const response = await callPortal({ action: "create-load", unifiedPrint: true, orderId: snapshot.order.portalId, deliveryDate: snapshot.date, revision: snapshot.revision, form: snapshot.form, confirmed: true, requestId: crypto.randomUUID() });
      if (response.existingNotes?.length) {
        if (response.existingNotes.length === 1) { await pdfFor(response.existingNotes[0], viewer, key); setCreating(null); }
        else { setCreating({ ...snapshot, existingNotes: response.existingNotes }); viewer?.close(); setPrinting(null); toast.dismiss(key); }
        return;
      }
      if (!response.result) throw new Error("Chưa nhận được kết quả tạo phiếu.");
      setCreating({ ...snapshot, result: response.result });
      if (response.result.state === "verified") await pdfFor(response.result, viewer, key);
      else { viewer?.close(); setPrinting(null); toast.dismiss(key); }
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
      const response = await callPortal({ action: "trip-options", unifiedPrint: true, orderId: order.portalId, deliveryDate: date, form: previous });
      if (response.result) {
        setCreating({ ...initial, result: response.result });
        if (response.result.state === "verified" && autoStart) await pdfFor(response.result, viewer, key);
        else { viewer?.close(); setPrinting(null); toast.dismiss(key); }
        return;
      }
      if (response.existingNotes?.length) {
        if (response.existingNotes.length === 1 && autoStart) await pdfFor(response.existingNotes[0], viewer, key);
        else { setCreating({ ...initial, existingNotes: response.existingNotes }); viewer?.close(); setPrinting(null); toast.dismiss(key); }
        return;
      }
      if (!response.options || !response.revision || !response.fleet) throw new Error("Chưa đọc được đầy đủ cấu hình xe/tài xế trên portal. Chưa tạo phiếu.");
      const form = fillSaved(response.fleet, response.options, previous);
      const snapshot: TripCreate = { ...initial, form, fleet: response.fleet, options: response.options, revision: response.revision,
        needed: missingFields(form, response.options), pendingChangeCategories: response.pendingChangeCategories || [],
        items: (response.draft as { stops?: Array<{ items: KfmTripItem[] }> })?.stops?.[0]?.items || [] };
      if (!snapshot.items.length) throw new Error("Không còn sản phẩm đủ điều kiện. Chưa tạo thêm phiếu.");
      if (autoStart && !snapshot.needed.length && !snapshot.pendingChangeCategories.length) await sendAndPrint(snapshot, viewer, key);
      else { setCreating(snapshot); viewer?.close(); setPrinting(null); toast.dismiss(key); }
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
      else { viewer?.close(); setPrinting(null); toast.dismiss(key); }
    } catch (error) { failPrint(key, viewer, error); }
    finally { createLock.current = false; setCreateBusy(false); }
  };

  const printExisting = async (note: ExistingNote | TripResult) => {
    if (createLock.current) return;
    createLock.current = true;
    const key = "existing-note";
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
    toast.loading(isVi ? "Đang chuẩn bị file in..." : "Preparing the print file...", {
      id: key,
      duration: Number.POSITIVE_INFINITY,
    });
    if (viewer) writePrintPlaceholder(viewer, isVi, what);
  };

  const finishPrint = (key: string, message: string) => {
    setPrinting(null);
    toast.success(message, { id: key, duration: 4000 });
  };

  const failPrint = (key: string, viewer: Window | null, error: unknown) => {
    setPrinting(null);
    viewer?.close();
    toast.error((error as Error)?.message || "Cổng KFM báo lỗi.", { id: key, duration: 6000 });
  };

  const handlePrintPo = async (order: KfmOrder) => {
    if (createLock.current) return;
    createLock.current = true;
    const key = `po-${order.portalId}`;
    const viewer = window.open("", "_blank");
    beginPrint(key, viewer, `PO ${order.code}`);
    try {
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
    <div className="flex items-center justify-end gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-lg"
            title={isVi ? "In phiếu" : "Print"}
            data-kfm-action="print-menu"
            disabled={printing !== null || busy !== null}
          >
            {printing === `po-${order.portalId}` || (printing !== null && printing.startsWith(`asn-${order.portalId}`))
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Printer className="h-4 w-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem data-kfm-action="print-po" onSelect={() => void handlePrintPo(order)}>
            <Printer className="mr-2 h-4 w-4" />
            {isVi ? "In PO" : "Print PO"}
          </DropdownMenuItem>
          <DropdownMenuItem data-kfm-action="print-asn" onSelect={() => void openCreate(order)}>
            <Truck className="mr-2 h-4 w-4" />
            {isVi ? "In phiếu giao hàng" : "Print delivery note"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <>
      <Button
        variant="outline"
        size="lg"
        className="h-12 rounded-2xl border-border bg-card/80 text-base text-foreground hover:bg-muted"
        onClick={() => setOpen(true)}
        data-kfm-portal-entry="v1"
      >
        <Truck className="mr-2 h-5 w-5" />
        {isVi ? "Cổng KFM" : "KFM portal"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[90dvh] max-w-3xl overflow-y-auto"
          data-kfm-mobile="v1"
          data-kfm-unified-print="v1"
          data-kfm-po-print="v1"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Truck className="h-5 w-5" />
              {isVi ? "Đơn hàng từ cổng KFM" : "Orders from the KFM portal"}
            </DialogTitle>
            <DialogDescription>
              {isVi
                ? "In phiếu đã có; nếu chưa có, thao tác in sẽ tạo phiếu và tự xác nhận PO bằng thông tin xe/tài xế đã lưu trên portal."
                : "Print an existing note, or create it and confirm the PO using saved portal vehicle/driver details."}
            </DialogDescription>
          </DialogHeader>

          {/* The native date control keeps its own intrinsic width on iOS, which
              used to push the trailing badge off the dialog. Let the row shrink
              and give the input a full-width line on phones only. */}
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <label className="text-sm text-muted-foreground" htmlFor="kfm-delivery-date">
              {isVi ? "Ngày giao" : "Delivery date"}
            </label>
            <input
              id="kfm-delivery-date"
              type="date"
              value={deliveryDate}
              onChange={(event) => setDeliveryDate(event.target.value)}
              className="h-10 w-full min-w-0 rounded-xl border border-border bg-background px-3 text-sm sm:w-auto"
            />
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
            >
              {query.isFetching
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <RefreshCw className="mr-2 h-4 w-4" />}
              {isVi ? "Tải lại" : "Reload"}
            </Button>
            {data?.vendorCode && (
              <Badge variant="outline" className="sm:ml-auto">
                {data.vendorCode}
              </Badge>
            )}
          </div>

            {/* Every print action — the PO sheet and the delivery note — reports
                its work here: the operator sees the wait instead of a blank tab. */}
            {printing !== null && (
              <div
                className="flex min-w-0 items-center gap-3 rounded-xl border border-primary/40 bg-primary/5 p-3"
                data-kfm-printing="v1"
                role="status"
              >
                <Printer className="h-4 w-4 animate-pulse text-primary" />
                <span className="text-sm font-medium">
                  {isVi ? "Đang chuẩn bị file in..." : "Preparing the print file..."}
                </span>
                <span className="ml-auto flex items-center gap-1" aria-hidden="true">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" />
                </span>
              </div>
            )}

            {creating && (
              <section className="min-w-0 space-y-3 rounded-xl border p-3" data-kfm-create="v2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="min-w-0 break-all text-sm font-semibold">In phiếu giao hàng · {creating.order.code}</h3>
                  <Button size="sm" variant="ghost" disabled={createBusy || printing !== null} onClick={() => setCreating(null)}>Đóng</Button>
                </div>
                {creating.error && <p role="alert" className="text-sm text-destructive">{creating.error}</p>}
                {creating.existingNotes ? <div className="flex flex-wrap gap-2">
                  <p className="w-full text-sm">Chọn phiếu đã có để in:</p>
                  {creating.existingNotes.map(note => <Button key={note.asnId} disabled={printing !== null} onClick={() => void printExisting(note)}>{note.asnCode || note.asnId}</Button>)}
                </div> : creating.result ? (
                  <div className="space-y-2 text-sm" data-kfm-create-result={creating.result.state} role="status">
                    <p>{creating.result.message}</p>
                    {creating.result.poConfirmation && <p data-kfm-po-readback="v1">PO: {creating.result.poConfirmation.label}</p>}
                    {creating.result.state === "verified" ? <Button disabled={printing !== null || createBusy} onClick={() => void printExisting(creating.result!)}>In phiếu giao hàng</Button>
                      : creating.result.state === "not_sent" ? <Button disabled={createBusy} onClick={() => void openCreate(creating.order, creating.date, creating.form, false)}>Kiểm tra lại thông tin</Button>
                      : <Button data-kfm-action="check-create" disabled={createBusy} onClick={() => void checkCreate()}>Kiểm tra kết quả</Button>}
                  </div>
                ) : creating.revision && <>
                  <p className="text-sm" data-kfm-auto-confirm="v1">{AUTO_CONFIRM_NOTICE}</p>
                  {creating.pendingChangeCategories.length > 0 && <p className="text-sm" data-kfm-pending-changes="v1">Yêu cầu chỉnh sửa sẽ tự động hủy: {creating.pendingChangeCategories.map(changeLabel).join(", ")}.</p>}
                  <p className="text-xs text-muted-foreground">{creating.warehouse} · {creating.date}<br />{[creating.form.licensePlate, creating.form.driverName, creating.form.driverPhone].filter(Boolean).join(" · ")}</p>
                  <fieldset disabled={createBusy} className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                    {creating.needed.includes("vehicleTypeId") && <label className="text-xs">Loại xe
                      <select data-kfm-field="vehicle" className="mt-1 block w-full min-w-0 rounded-md border bg-background p-2" value={creating.form.vehicleTypeId || ""} onChange={e => void openCreate(creating.order, creating.date, { ...creating.form, vehicleTypeId: Number(e.target.value) || null }, false)}>
                        <option value="">Chọn loại xe</option>{creating.options.vehicleTypes.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
                      </select>
                    </label>}
                    {creating.needed.includes("licensePlate") && <label className="text-xs">Xe đã lưu
                      {creating.fleet.vehicles.length ? <select data-kfm-field="saved-vehicle" className="mt-1 block w-full min-w-0 rounded-md border bg-background p-2" value={creating.form.savedVehicleId || ""} onChange={e => {
                        const form = fillSaved(creating.fleet, creating.options, { ...creating.form, savedVehicleId: Number(e.target.value) || null, savedDriverId: null, driverName: "", driverPhone: "" });
                        setCreating({ ...creating, form });
                      }}><option value="">Chọn xe</option>{creating.fleet.vehicles.map(row => <option key={row.id} value={row.id}>{row.plateNumber}</option>)}</select>
                      : <input data-kfm-field="plate" maxLength={40} className="mt-1 block w-full min-w-0 rounded-md border bg-background p-2" value={creating.form.licensePlate} onChange={e => setCreating({ ...creating, form: { ...creating.form, licensePlate: e.target.value } })} />}
                    </label>}
                    {creating.needed.includes("driver") && <label className="text-xs">Tài xế
                      {creating.fleet.drivers.length ? <select data-kfm-field="saved-driver" className="mt-1 block w-full min-w-0 rounded-md border bg-background p-2" value={creating.form.savedDriverId || ""} onChange={e => {
                        const driver = creating.fleet.drivers.find(row => row.id === Number(e.target.value));
                        setCreating({ ...creating, form: { ...creating.form, savedDriverId: driver?.id, driverName: driver?.name || "", driverPhone: driver?.phone || "" } });
                      }}><option value="">Chọn tài xế</option>{creating.fleet.drivers.map(row => <option key={row.id} value={row.id}>{row.name} · {row.phone}</option>)}</select>
                      : <div className="space-y-2">{([['driverName','Tên tài xế'],['driverPhone','Số điện thoại']] as const).map(([key,label]) => <input key={key} aria-label={label} placeholder={label} maxLength={key === 'driverName' ? 120 : 30} className="mt-1 block w-full min-w-0 rounded-md border bg-background p-2" value={creating.form[key]} onChange={e => setCreating({ ...creating, form: { ...creating.form, [key]: e.target.value } })} />)}</div>}
                    </label>}
                    {creating.needed.includes("driver") && creating.form.savedDriverId && ([['driverName','Tên tài xế','name'],['driverPhone','Số điện thoại','phone']] as const).map(([key,label,sourceKey]) => !creating.fleet.drivers.find(row => row.id === creating.form.savedDriverId)?.[sourceKey] && <label key={key} className="text-xs">{label}<input aria-label={label} maxLength={key === 'driverName' ? 120 : 30} className="mt-1 block w-full min-w-0 rounded-md border bg-background p-2" value={creating.form[key]} onChange={e => setCreating({ ...creating, form: { ...creating.form, [key]: e.target.value } })} /></label>)}
                    {creating.needed.includes("bookingTimeSlot") && <label className="text-xs">Khung giờ giao
                      <select data-kfm-field="slot" className="mt-1 block w-full min-w-0 rounded-md border bg-background p-2" value={creating.form.bookingTimeSlot} onChange={e => setCreating({ ...creating, form: { ...creating.form, bookingTimeSlot: e.target.value } })}>
                        <option value="">Chọn khung giờ</option>{creating.options.slots.map((slot,i) => <option key={i} value={slot.value} disabled={!slot.available}>{slot.value}</option>)}
                      </select>
                    </label>}
                    {creating.needed.includes("time") && ([['expectedTimeFrom','Giờ giao từ'],['expectedTimeTo','Giờ giao đến']] as const).map(([key,label]) => <label key={key} className="text-xs">{label}<input type="time" className="mt-1 block w-full min-w-0 rounded-md border bg-background p-2" value={creating.form[key]} onChange={e => setCreating({ ...creating, form: { ...creating.form, [key]: e.target.value } })} /></label>)}
                  </fieldset>
                  <Button data-kfm-action="submit-create" disabled={createBusy || missingFields(creating.form, creating.options).length > 0} onClick={() => void submitCreate()}>In phiếu giao hàng</Button>
                </>}
              </section>
            )}
            {query.isFetching && <p className="text-sm text-muted-foreground">Đang tải đơn hàng…</p>}

          {query.isError && (
            <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
              {(query.error as Error)?.message}
            </div>
          )}

          {data && data.configured === false && (
            <div className="rounded-xl border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-semibold">
                {isVi ? "Cổng KFM chưa được cấu hình" : "KFM portal is not configured yet"}
              </p>
              <p className="mt-1">
                {isVi
                  ? "Cần đặt tài khoản cổng (KFM_PORTAL_USERNAME / KFM_PORTAL_PASSWORD) trong Supabase secrets. Trong lúc chờ, nút “Kiểm tra PO” theo email vẫn chạy bình thường."
                  : "Portal credentials must be added to Supabase secrets. The email PO check keeps working meanwhile."}
              </p>
            </div>
          )}

          {data && data.success === false && data.configured !== false && (
            <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
              <p className="font-semibold">
                {data.error === "session_expired"
                  ? (isVi ? "Phiên cổng KFM đã hết hạn" : "KFM portal session expired")
                  : (isVi ? "Cổng KFM đang lỗi" : "KFM portal error")}
              </p>
              <p className="mt-1">{data.message}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {isVi
                  ? `Bước: ${data.step || "—"} · Luồng email PO vẫn dùng được.`
                  : `Step: ${data.step || "—"} · The email PO flow still works.`}
              </p>
            </div>
          )}

          {data?.success && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="secondary">{isVi ? `${orders.length} đơn` : `${orders.length} orders`}</Badge>
                <span>{isVi ? "Ngày giao" : "Delivery"}: {data.deliveryDate}</span>
                {data.session?.mode && (
                  <span className="text-xs sm:ml-auto">
                    {isVi ? "Phiên" : "Session"}: {data.session.mode === "refresh" ? "refresh token" : "đăng nhập mới"}
                  </span>
                )}
              </div>

              {/* Reported 2026-09-14: the five-column table had to be dragged
                  sideways on a phone, which scrolled the "PO100…" prefix off the
                  screen. Small screens get one stacked card per order instead;
                  the table only renders where it actually fits. */}
              <ul className="space-y-2 md:hidden" data-kfm-orders-cards="v1">
                {orders.map((order) => (
                  <li key={order.portalId} className="rounded-xl border border-border p-3">
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <span className="min-w-0 break-all text-sm font-semibold">{order.code}</span>
                      {renderOrderActions(order)}
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">{isVi ? "Kho nhận" : "Location"}</dt>
                        <dd className="mt-0.5 break-words">{order.locationName || "—"}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">{isVi ? "Số dòng" : "Items"}</dt>
                        <dd className="mt-0.5">{order.itemCount ?? "—"}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">{isVi ? "SL" : "Qty"}</dt>
                        <dd className="mt-0.5">{qty(order.totalQty)}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
                {orders.length === 0 && (
                  <li className="rounded-xl border border-border p-6 text-center text-sm text-muted-foreground">
                    {isVi ? "Không có đơn nào cho ngày này." : "No orders for this date."}
                  </li>
                )}
              </ul>

              <div className="hidden max-h-96 min-w-0 overflow-auto rounded-xl border border-border md:block">
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="sticky top-0 bg-muted/80 text-left">
                    <tr>
                      <th className="p-2">{isVi ? "Mã PO" : "PO"}</th>
                      <th className="p-2">{isVi ? "Kho nhận" : "Location"}</th>
                      <th className="p-2 text-right">{isVi ? "Số dòng" : "Items"}</th>
                      <th className="p-2 text-right">{isVi ? "SL" : "Qty"}</th>
                      <th className="sticky right-0 border-l border-border bg-muted p-2 text-right">
                        {isVi ? "Thao tác" : "Actions"}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.portalId} className="border-t border-border/60">
                        <td className="p-2 font-medium">{order.code}</td>
                        <td className="p-2">{order.locationName || "—"}</td>
                        <td className="p-2 text-right">{order.itemCount ?? "—"}</td>
                        <td className="p-2 text-right">{qty(order.totalQty)}</td>
                        <td className="sticky right-0 border-l border-border bg-background p-2">
                          {renderOrderActions(order)}
                        </td>
                      </tr>
                    ))}
                    {orders.length === 0 && (
                      <tr>
                        <td colSpan={5} className="p-6 text-center text-muted-foreground">
                          {isVi ? "Không có đơn nào cho ngày này." : "No orders for this date."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

        </DialogContent>
      </Dialog>
    </>
  );
}
