import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Eye, Loader2, Printer, RefreshCw, Truck } from "lucide-react";

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
 * every action on the portal (confirm, print PO, print delivery note) is a
 * manual click — nothing runs on a schedule.
 */

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

type KfmOrderDetail = {
  portalId: number;
  code: string | null;
  purchaseOrderId: number | null;
  asns: Array<{ asnId: number; asnCode: string | null }>;
};

/** The portal's print menu: `FULL` shows prices and is its own default. */
type KfmPrintLayout = "FULL" | "NO_PRICE";

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

/** The read-only delivery-note body plus the numbers behind it. */
type KfmTripDraft = {
  code: string;
  deliveryDate: string;
  items: KfmTripItem[];
  locationId: number | null;
  locationName: string | null;
  totalShipQty: number;
  skippedCount: number;
  text: string;
};

type TripForm = {
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
type TripResult = { state: "verified" | "unknown" | "not_sent"; message: string; loadId?: number; loadCode?: string; asns?: Array<{ asnId: number; asnCode: string }> };
type TripCreate = { order: KfmOrder; date: string; revision: string; options: TripOptions; form: TripForm; items: KfmTripItem[]; warehouse: string; result?: TripResult; error?: string };


type KfmResponse = {
  success: boolean;
  configured?: boolean;
  action?: string;
  deliveryDate?: string;
  vendorCode?: string | null;
  vendorId?: number | null;
  count?: number;
  orders?: KfmOrder[];
  order?: KfmOrderDetail;
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

  // The original read-only preview stays separate from the operator create form.
  const [draft, setDraft] = useState<KfmTripDraft | null>(null);
  const [creating, setCreating] = useState<TripCreate | null>(null);
  const createLock = useRef(false);
  const [createBusy, setCreateBusy] = useState(false);

  const openCreate = async (order: KfmOrder, date = deliveryDate, form?: TripForm) => {
    if (createLock.current) return;
    createLock.current = true; setCreateBusy(true); setBusy(`create-${order.portalId}`);
    const blank: TripForm = { vehicleTypeId: null, bookingTimeSlot: "", expectedTimeFrom: "", expectedTimeTo: "", licensePlate: "", driverName: "", driverPhone: "", note: "", totalCartons: 0, totalPallets: 0 };
    const initial: TripCreate = { order, date, revision: "", options: { deliveryType: null, vehicleTypes: [], vehicleTypeId: null, slots: [] }, form: form || blank, items: [], warehouse: order.locationName || "" };
    setDraft(null); setCreating(initial);
    try {
      const result = await callPortal({ action: "trip-options", orderId: order.portalId, deliveryDate: date, form: form || blank });
      if (result.result) { setCreating({ ...initial, result: result.result }); return; }
      if (!result.options || !result.revision) throw new Error("Máy chủ chưa trả đủ thông tin tạo phiếu.");
      const items = (result.draft as { stops?: Array<{ items: KfmTripItem[] }> })?.stops?.[0]?.items || [];
      setCreating({ ...initial, revision: result.revision, options: result.options, items,
        warehouse: String((result.source as { locationName?: string })?.locationName || initial.warehouse),
        form: { ...(form || blank), vehicleTypeId: result.options.vehicleTypeId, bookingTimeSlot: "" } });
    } catch (error) { setCreating({ ...initial, error: (error as Error).message }); }
    finally { createLock.current = false; setCreateBusy(false); setBusy(null); }
  };

  const submitCreate = async () => {
    if (!creating || createLock.current || !creating.revision || creating.result || !creating.items.length) return;
    if (!window.confirm(`Tạo phiếu giao hàng thật cho ${creating.order.code}, ngày ${creating.date}, ${creating.items.length} dòng tại ${creating.warehouse}?`)) return;
    createLock.current = true; setCreateBusy(true); setBusy(`create-${creating.order.portalId}`);
    const snapshot = creating;
    // Once a POST is attempted the form cannot send it again, even on HTTP failure.
    setCreating({ ...snapshot, result: { state: "unknown", message: "Đang gửi và đọc lại chuyến/ASN. Không gửi lại yêu cầu." } });
    try {
      const response = await callPortal({ action: "create-load", orderId: snapshot.order.portalId, deliveryDate: snapshot.date, revision: snapshot.revision, form: snapshot.form, confirmed: true, requestId: crypto.randomUUID() });
      if (!response.result) throw new Error("Chưa nhận được kết quả tạo phiếu.");
      setCreating({ ...snapshot, result: response.result });
      void query.refetch();
    } catch (error) { setCreating({ ...snapshot, result: { state: "unknown", message: `${(error as Error).message} Chọn ‘Kiểm tra kết quả’ trước khi làm tiếp.` } }); }
    finally { createLock.current = false; setCreateBusy(false); setBusy(null); }
  };

  const checkCreate = async () => {
    if (!creating || createLock.current) return;
    createLock.current = true; setCreateBusy(true); setBusy(`create-${creating.order.portalId}`);
    try {
      const result = await callPortal({ action: "trip-result", orderId: creating.order.portalId, deliveryDate: creating.date });
      setCreating({ ...creating, result: result.result });
    } catch (error) { setCreating({ ...creating, result: { state: "unknown", message: (error as Error).message } }); }
    finally { createLock.current = false; setCreateBusy(false); setBusy(null); }
  };

  const printCreated = (layout: KfmPrintLayout) => {
    const result = creating?.result;
    if (!result?.loadId || result.state !== "verified" || printing) return;
    const viewer = window.open("", "_blank");
    const key = `load-${result.loadId}`;
    const what = `phiếu giao hàng ${result.loadCode || result.loadId}`;
    beginPrint(key, viewer, what);
    void (async () => {
      try {
        const pdf = await callPortal({ action: "load-pdf", loadId: result.loadId, code: result.loadCode, layout });
        if (!pdf.base64) throw new Error("Cổng KFM chưa trả file in.");
        savePdf(pdf.base64, pdf.filename || `PhieuGiaoHang_${result.loadCode || result.loadId}.pdf`, viewer);
        finishPrint(key, "Đã mở phiếu giao hàng từ cổng KFM.");
      } catch (error) { failPrint(key, viewer, error); }
    })();
  };

  const runAction = async (key: string, work: () => Promise<string>) => {
    setBusy(key);
    try {
      const message = await work();
      toast.success(message);
    } catch (error) {
      toast.error((error as Error)?.message || "Cổng KFM báo lỗi.");
    } finally {
      setBusy(null);
    }
  };

  const handleConfirm = (order: KfmOrder) => {
    if (!window.confirm(isVi
      ? `Xác nhận đơn ${order.code} với cổng KFM?`
      : `Confirm order ${order.code} on the KFM portal?`)) return;
    void runAction(`confirm-${order.portalId}`, async () => {
      await callPortal({ action: "confirm", deliveryDate, orderId: order.portalId });
      await query.refetch();
      return isVi ? `Đã xác nhận đơn ${order.code}.` : `Order ${order.code} confirmed.`;
    });
  };

  const busyIcon = (key: string) =>
    busy === key ? <Loader2 className="h-4 w-4 animate-spin" /> : null;

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

  const handlePrintPo = (order: KfmOrder) => {
    // Open the tab while the click is still a user gesture: a window opened
    // after the awaits below is treated as a popup and blocked.
    const viewer = typeof window !== "undefined" ? window.open("", "_blank") : null;
    const key = `po-${order.portalId}`;
    beginPrint(key, viewer, `PO ${order.code}`);
    void (async () => {
      try {
        const detail = await callPortal({ action: "detail", deliveryDate, orderId: order.portalId });
        // The portal prints a PO by order id: its own "print PO" action calls
        // GET /api/v1/purchase-orders/{orderId}/export-pdf. Only fall back to a
        // dedicated PO id when the detail payload actually carries one.
        const poId = detail.order?.purchaseOrderId ?? order.portalId;
        if (!poId) throw new Error(isVi ? "Đơn này chưa có PO để in." : "This order has no PO to print.");
        const pdf = await callPortal({ action: "po-pdf", poId });
        savePdf(pdf.base64 || "", pdf.filename || `PO-${order.code}.pdf`, viewer);
        finishPrint(key, isVi ? `Đã mở PO ${order.code}.` : `PO ${order.code} opened.`);
      } catch (error) {
        failPrint(key, viewer, error);
      }
    })();
  };

  /**
   * Print the order's delivery note. The note belongs to the order's ASN, so
   * its id comes from the order detail, and the sheet is the portal's own
   * export because that is the copy the warehouse counter expects.
   */
  const handlePrintAsn = (order: KfmOrder, layout: KfmPrintLayout) => {
    const viewer = typeof window !== "undefined" ? window.open("", "_blank") : null;
    const key = `asn-${order.portalId}-${layout}`;
    beginPrint(
      key,
      viewer,
      isVi ? `phiếu giao hàng ${order.code}` : `delivery note ${order.code}`,
    );
    void (async () => {
      try {
        const detail = await callPortal({ action: "detail", deliveryDate, orderId: order.portalId });
        const asn = detail.order?.asns?.[0];
        if (!asn) {
          throw new Error(isVi ? "Đơn này chưa có phiếu giao hàng." : "This order has no delivery note yet.");
        }
        const pdf = await callPortal({
          action: "asn-pdf",
          asnId: asn.asnId,
          poId: detail.order?.purchaseOrderId ?? undefined,
          code: asn.asnCode ?? undefined,
          layout,
        });
        savePdf(
          pdf.base64 || "",
          pdf.filename || `PhieuGiaoHang_${asn.asnCode || asn.asnId}.pdf`,
          viewer,
        );
        finishPrint(
          key,
          isVi
            ? `Đã mở phiếu giao hàng ${asn.asnCode || asn.asnId}.`
            : `Delivery note ${asn.asnCode || asn.asnId} opened.`,
        );
      } catch (error) {
        failPrint(key, viewer, error);
      }
    })();
  };

  /**
   * Read-only draft of the trip body behind one order's delivery note. The
   * portal raises the note through its trip form, so this shows the exact
   * payload before any create action is switched on — the operator compares it
   * with the portal's own screen. It never posts.
   */
  const handlePreviewLoad = (order: KfmOrder) => {
    void runAction(`preview-${order.portalId}`, async () => {
      const result = await callPortal({
        action: "trip-draft",
        deliveryDate,
        orderId: order.portalId,
      });
      const stop = (result.draft as { stops?: Array<{ items?: KfmTripItem[]; locationId?: number | null }> })
        ?.stops?.[0];
      const items = stop?.items ?? [];
      setDraft({
        code: order.code,
        deliveryDate: String(result.deliveryDate ?? deliveryDate),
        items,
        locationId: stop?.locationId ?? null,
        locationName: (result.source as { locationName?: string | null } | undefined)?.locationName ?? null,
        totalShipQty: items.reduce((sum, item) => sum + (item.shipQty || 0), 0),
        skippedCount: Number((result.source as { skippedCount?: number } | undefined)?.skippedCount ?? 0),
        text: JSON.stringify({ draft: result.draft, source: result.source, rawRows: result.rawRows, shippedMap: result.shippedMap }, null, 2),
      });
      if (items.length === 0) {
        return isVi
          ? "Không có dòng đủ điều kiện tạo chuyến mới."
          : "No eligible lines for a new trip.";
      }
      return isVi
        ? `Đã ráp thử phiếu giao hàng ${order.code}.`
        : `Delivery note draft for ${order.code} is ready.`;
    });
  };

  /**
   * One action cluster per order, shared by the phone card and the wide table.
   * The row used to carry a second truck button for the delivery note, and the
   * two trucks on one row were what read as a duplicate. Both sheets now come
   * from the printer menu, which is portalled, so the scrolling table cannot
   * clip it.
   */
  const renderOrderActions = (order: KfmOrder) => (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="h-8 rounded-lg"
        title={isVi ? "Xác nhận đơn" : "Confirm order"}
        data-kfm-action="confirm"
        disabled={busy !== null}
        onClick={() => handleConfirm(order)}
      >
        {busyIcon(`confirm-${order.portalId}`) || <CheckCircle2 className="h-4 w-4" />}
      </Button>
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
            {printing !== null && printing.startsWith(`asn-${order.portalId}`)
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Printer className="h-4 w-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem data-kfm-action="print-po" onSelect={() => handlePrintPo(order)}>
            <Printer className="mr-2 h-4 w-4" />
            {isVi ? "In PO" : "Print PO"}
          </DropdownMenuItem>
          <DropdownMenuItem data-kfm-action="print-asn" onSelect={() => handlePrintAsn(order, "FULL")}>
            <Truck className="mr-2 h-4 w-4" />
            {isVi ? "In phiếu giao hàng (có giá)" : "Print delivery note (with prices)"}
          </DropdownMenuItem>
          <DropdownMenuItem data-kfm-action="print-asn-no-price" onSelect={() => handlePrintAsn(order, "NO_PRICE")}>
            <Truck className="mr-2 h-4 w-4" />
            {isVi ? "In phiếu giao hàng (không giá)" : "Print delivery note (price-free)"}
          </DropdownMenuItem>
          <DropdownMenuItem data-kfm-action="preview-load" onSelect={() => handlePreviewLoad(order)}>
            <Eye className="mr-2 h-4 w-4" />
            {isVi ? "Xem trước phiếu giao hàng" : "Preview delivery note"}
          </DropdownMenuItem>
          <DropdownMenuItem data-kfm-action="create-load" onSelect={() => void openCreate(order)}>
            <Truck className="mr-2 h-4 w-4" />
            {isVi ? "Tạo phiếu giao hàng" : "Create delivery note"}
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
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Truck className="h-5 w-5" />
              {isVi ? "Đơn hàng từ cổng KFM" : "Orders from the KFM portal"}
            </DialogTitle>
            <DialogDescription>
              {isVi
                ? "Đọc trực tiếp từ cổng đối tác — chỉ sản phẩm và số lượng. Xác nhận và in là thao tác tay từng đơn."
                : "Read directly from the partner portal — products and quantities only. Confirm and print are manual, one order at a time."}
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
              <section className="min-w-0 rounded-xl border border-border p-3 space-y-3" data-kfm-create="v1">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 break-all text-sm font-semibold">Tạo phiếu giao hàng · {creating.order.code}</h3>
                  <Button variant="ghost" size="sm" disabled={createBusy} onClick={() => setCreating(null)}>Đóng</Button>
                </div>
                <p className="text-xs text-muted-foreground">Một PO / một chuyến · {creating.warehouse} · {creating.date}</p>
                {createBusy && <p className="flex gap-2 text-sm" role="status"><Loader2 className="h-4 w-4 animate-spin" />Đang kiểm tra cổng KFM…</p>}
                {creating.error && <p role="alert" className="text-sm text-destructive">{creating.error}</p>}
                {creating.result ? (
                  <div className="space-y-2 text-sm" data-kfm-create-result={creating.result.state} role="status">
                    <p>{creating.result.message}</p>
                    {creating.result.state === "verified" ? <>
                      <p className="break-all font-medium">{creating.result.loadCode} · {creating.result.asns?.map(asn => asn.asnCode).join(", ")}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={printing !== null} onClick={() => printCreated("FULL")}>In phiếu (có giá)</Button>
                        <Button size="sm" variant="outline" disabled={printing !== null} onClick={() => printCreated("NO_PRICE")}>In phiếu (không giá)</Button>
                      </div>
                    </> : creating.result.state === "not_sent" ? (
                      <Button size="sm" variant="outline" disabled={createBusy} onClick={() => void openCreate(creating.order, creating.date, creating.form)}>Tải lại và xem trước</Button>
                    ) : (
                      <Button size="sm" variant="outline" data-kfm-action="check-create" disabled={createBusy} onClick={() => void checkCreate()}>Kiểm tra kết quả</Button>
                    )}
                  </div>
                ) : creating.revision && (
                  <>
                    <fieldset disabled={createBusy} className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="min-w-0 text-xs">Ngày giao
                        <input className="mt-1 block w-full min-w-0 rounded-md border bg-background p-2 text-sm" type="date" value={creating.date} onChange={e => void openCreate(creating.order, e.target.value, creating.form)} />
                      </label>
                      <label className="min-w-0 text-xs">Loại xe{creating.options.vehicleTypes.length ? " *" : ""}
                        <select className="mt-1 block w-full min-w-0 rounded-md border bg-background p-2 text-sm" data-kfm-field="vehicle" value={creating.form.vehicleTypeId || ""} onChange={e => void openCreate(creating.order, creating.date, { ...creating.form, vehicleTypeId: Number(e.target.value) || null })}>
                          <option value="">Chọn loại xe</option>
                          {creating.options.vehicleTypes.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
                        </select>
                      </label>
                      {creating.options.deliveryType ? (
                        <label className="min-w-0 text-xs sm:col-span-2">Khung giờ giao * · {creating.options.deliveryType === "BOOKING" ? "Đặt lịch kho" : creating.options.deliveryType === "HUB" ? "Giao qua HUB" : "Theo lịch cố định"}
                          <select className="mt-1 block w-full min-w-0 rounded-md border bg-background p-2 text-sm" value={creating.form.bookingTimeSlot} onChange={e => setCreating({ ...creating, form: { ...creating.form, bookingTimeSlot: e.target.value } })}>
                            <option value="">Chọn khung giờ</option>
                            {creating.options.slots.map((slot, index) => <option key={`${slot.value}-${index}`} value={slot.value} disabled={!slot.available}>{slot.value}{slot.available ? "" : " · Hết chỗ/đã qua"}</option>)}
                          </select>
                        </label>
                      ) : ([['expectedTimeFrom', 'Giờ giao từ *'], ['expectedTimeTo', 'Giờ giao đến *']] as const).map(([key, label]) => (
                        <label key={key} className="min-w-0 text-xs">{label}<input type="time" className="mt-1 block w-full min-w-0 rounded-md border bg-background p-2 text-sm" value={creating.form[key]} onChange={e => setCreating({ ...creating, form: { ...creating.form, [key]: e.target.value } })} /></label>
                      ))}
                      {([['licensePlate', 'Biển số xe', 40], ['driverName', 'Tên tài xế', 120], ['driverPhone', 'Số điện thoại tài xế', 30], ['note', 'Ghi chú', 1000]] as const).map(([key, label, max]) => (
                        <label key={key} className="min-w-0 text-xs">{label}<input maxLength={max} className="mt-1 block w-full min-w-0 rounded-md border bg-background p-2 text-sm" value={creating.form[key]} onChange={e => setCreating({ ...creating, form: { ...creating.form, [key]: e.target.value } })} /></label>
                      ))}
                      {([['totalCartons', 'Tổng số thùng'], ['totalPallets', 'Tổng số pallet']] as const).map(([key, label]) => (
                        <label key={key} className="min-w-0 text-xs">{label}<input type="number" min="0" step="1" className="mt-1 block w-full min-w-0 rounded-md border bg-background p-2 text-sm" value={creating.form[key]} onChange={e => setCreating({ ...creating, form: { ...creating.form, [key]: Number(e.target.value) } })} /></label>
                      ))}
                    </fieldset>
                    <div className="max-h-64 overflow-auto rounded-lg border">
                      <table className="w-full text-left text-xs" data-kfm-create-items="v1">
                        <thead className="sticky top-0 bg-muted"><tr><th className="p-2">Sản phẩm</th><th className="p-2">ĐVT</th><th className="p-2 text-right">SL giao</th></tr></thead>
                        <tbody>{creating.items.map(item => <tr key={item.poItemId} className="border-t"><td className="p-2">{item.productName}<span className="block text-muted-foreground">{item.productCode}</span></td><td className="p-2">{item.unitName}</td><td className="p-2 text-right">{qty(item.shipQty)}</td></tr>)}</tbody>
                      </table>
                    </div>
                    <p className="text-xs text-muted-foreground">Kiểm tra thông tin trước khi xác nhận. Máy chủ sẽ đọc lại PO và số lượng đã phân bổ. Thao tác này tạo chuyến và phiếu thật trên KFM.</p>
                    <Button data-kfm-action="submit-create" disabled={createBusy || !creating.items.length || Boolean(creating.options.vehicleTypes.length && !creating.form.vehicleTypeId) || (creating.options.deliveryType ? !creating.form.bookingTimeSlot : !creating.form.expectedTimeFrom || !creating.form.expectedTimeTo)} onClick={() => void submitCreate()}>Xác nhận & Tạo phiếu</Button>
                  </>
                )}
              </section>
            )}

            {/* Stage 1 of the create-delivery-note work: the assembled body, for
                review only. Nothing here reaches the partner portal. */}
            {draft && (
              <div className="min-w-0 rounded-xl border border-border p-3" data-kfm-load-preview="v1">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 break-all text-sm font-medium">
                    {isVi ? `Xem trước phiếu giao hàng ${draft.code}` : `Delivery note draft ${draft.code}`}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 rounded-lg"
                    onClick={() => setDraft(null)}
                  >
                    {isVi ? "Đóng" : "Close"}
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {isVi
                    ? "Chỉ xem các dòng đủ điều kiện tạo chuyến mới, không phải phiếu đã tạo. Chưa gửi gì lên cổng KFM."
                    : "Eligible lines for a new trip only, not an existing delivery note. Nothing has been sent to KFM."}
                </p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <span className="rounded-md bg-muted px-2 py-1">
                    {isVi ? "Ngày giao" : "Delivery date"}: {draft.deliveryDate}
                  </span>
                  <span className="rounded-md bg-muted px-2 py-1">
                    {isVi ? "Kho nhận" : "Warehouse"}: {draft.locationName || draft.locationId || "—"}
                  </span>
                  <span className="rounded-md bg-muted px-2 py-1">
                    {isVi ? "Số dòng" : "Lines"}: {draft.items.length} · {isVi ? "Tổng SL" : "Qty"}:{" "}
                    {draft.totalShipQty.toLocaleString("vi-VN")}
                  </span>
                </div>
                {draft.items.length === 0 ? (
                  <p className="mt-2 text-sm" data-kfm-load-empty="v1">
                    {isVi
                      ? "Không có dòng đủ điều kiện tạo chuyến mới. Để xem phiếu đã tạo, chọn ‘In phiếu giao hàng’ trong menu in của đơn."
                      : "No eligible lines for a new trip. To view an existing note, choose ‘Print delivery note’ in the order’s print menu."}
                  </p>
                ) : (
                <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-border">
                  <table className="w-full text-left text-xs" data-kfm-load-items="v1">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th className="px-2 py-1.5 font-medium">#</th>
                        <th className="px-2 py-1.5 font-medium">{isVi ? "Mã SP" : "Code"}</th>
                        <th className="px-2 py-1.5 font-medium">{isVi ? "Tên SP" : "Product"}</th>
                        <th className="px-2 py-1.5 font-medium">{isVi ? "ĐVT" : "Unit"}</th>
                        <th className="px-2 py-1.5 text-right font-medium">{isVi ? "SL đặt" : "Ordered"}</th>
                        <th className="px-2 py-1.5 text-right font-medium">{isVi ? "Thùng" : "Cartons"}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {draft.items.map((item, index) => (
                        <tr key={`${item.poItemId}-${index}`} className="border-t border-border">
                          <td className="px-2 py-1.5 text-muted-foreground">{index + 1}</td>
                          <td className="px-2 py-1.5 font-mono">{item.productCode || item.barcode || "—"}</td>
                          <td className="px-2 py-1.5">{item.productName || "—"}</td>
                          <td className="px-2 py-1.5">{item.unitName || "—"}</td>
                          <td className="px-2 py-1.5 text-right">{item.shipQty.toLocaleString("vi-VN")}</td>
                          <td className="px-2 py-1.5 text-right">{item.cartons}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                )}
                {draft.skippedCount > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {isVi
                      ? `${draft.skippedCount} dòng không còn đủ điều kiện thêm mới theo số lượng đã giao hoặc đã lên chuyến trên cổng KFM.`
                      : `${draft.skippedCount} line(s) excluded based on quantities already delivered or assigned to a trip in KFM.`}
                  </p>
                )}
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {isVi ? "Dữ liệu đối chiếu (chưa gửi)" : "Reconciliation data (not sent)"}
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">
                    {draft.text}
                  </pre>
                </details>
              </div>
            )}

          {query.isLoading && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {isVi ? "Đang lấy đơn từ cổng KFM…" : "Loading orders…"}
            </p>
          )}

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
