import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Printer, RefreshCw, Truck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

/** One delivery trip ("chuyến xe giao hàng") — the only place with driver + truck. */
type KfmDeliveryLoad = {
  portalId: number;
  loadCode: string | null;
  deliveryDate: string | null;
  status: string | null;
  driverName: string | null;
  driverPhone: string | null;
  licensePlate: string | null;
  vehicleTypeName: string | null;
  asnCount: number | null;
  bookingStartDatetime: string | null;
  bookingEndDatetime: string | null;
  places: Array<{ locationName: string | null; asnStatus: string | null }>;
  asns: Array<{
    asnId: number;
    asnCode: string | null;
    asnStatus: string | null;
    locationName: string | null;
    bookingTimeSlot: string | null;
    totalShipQty: number | null;
  }>;
};

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
  loads?: KfmDeliveryLoad[];
  counts?: Record<string, number>;
  filename?: string;
  base64?: string;
  session?: { mode: string; obtainedAt: string };
  error?: string;
  step?: string;
  message?: string;
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
  const body = viewer.document?.body;
  if (!body) return;
  viewer.document.title = title;
  body.innerHTML = `
    <div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:24px;background:#fff;color:#0f172a;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center">
      <span style="display:block;width:clamp(48px,14vw,72px);height:clamp(48px,14vw,72px);border-radius:9999px;border:5px solid #dbeafe;border-top-color:#2563eb;animation:kfm-spin .9s linear infinite"></span>
      <p style="margin:0;font-size:clamp(20px,6.5vw,32px);font-weight:700;line-height:1.25">${title}</p>
      <span style="display:flex;gap:8px">
        <span style="width:11px;height:11px;border-radius:9999px;background:#2563eb;animation:kfm-wait 1s infinite"></span>
        <span style="width:11px;height:11px;border-radius:9999px;background:#2563eb;animation:kfm-wait 1s infinite .15s"></span>
        <span style="width:11px;height:11px;border-radius:9999px;background:#2563eb;animation:kfm-wait 1s infinite .3s"></span>
      </span>
      <p style="margin:0;font-size:clamp(14px,4vw,19px);color:#475569">${hint}</p>
      <style>@keyframes kfm-wait{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-5px)}}@keyframes kfm-spin{to{transform:rotate(360deg)}}</style>
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

  // Trips are their own read: the portal keeps them under inbound-loads, not
  // under the order list, and they are the only rows carrying driver + truck.
  // The date filter is optional because yesterday's trip is often the one
  // being driven today.
  const [filterLoadsByDate, setFilterLoadsByDate] = useState(false);
  // Trips are an exception the operator asks for, not part of the PO task.
  const [showLoads, setShowLoads] = useState(false);
  // One keyed slot for every print action in the panel (`po-*`, `load-*`), so
  // the waiting banner, the toast and the disabled state stay in one place.
  const [printing, setPrinting] = useState<string | null>(null);

  // Trips are a second read: the portal keeps them under inbound-loads, not
  // under the order list. It is deferred until the operator opens the trips
  // section, so loading a PO costs one request instead of two.
  const loadsQuery = useQuery({
    queryKey: ["kfm-portal-loads", filterLoadsByDate ? deliveryDate : "all"],
    queryFn: () => callPortal({
      action: "loads",
      ...(filterLoadsByDate ? { deliveryDate } : {}),
    }),
    enabled: open && showLoads,
    retry: false,
    staleTime: 30_000,
  });
  const loads = loadsQuery.data?.loads || [];

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
   * Print a delivery trip. The sheet is rendered server side, so the operator
   * gets the same explicit "preparing" state the partner portal shows instead
   * of a blank tab that looks broken. The tab is opened on the click itself:
   * a window opened after the awaits is blocked as a popup.
   */
  const handlePrintLoad = (load: KfmDeliveryLoad) => {
    const viewer = typeof window !== "undefined" ? window.open("", "_blank") : null;
    const key = `load-${load.portalId}`;
    beginPrint(
      key,
      viewer,
      isVi
        ? `phiếu giao hàng ${load.loadCode || load.portalId}`
        : `delivery note ${load.loadCode || load.portalId}`,
    );
    void (async () => {
      try {
        const pdf = await callPortal({ action: "load-pdf", loadId: load.portalId });
        savePdf(
          pdf.base64 || "",
          pdf.filename || `PhieuGiaoHang-${load.loadCode || load.portalId}.pdf`,
          viewer,
        );
        finishPrint(
          key,
          isVi
            ? `Đã mở phiếu giao hàng ${load.loadCode || load.portalId}.`
            : `Delivery note ${load.loadCode || load.portalId} opened.`,
        );
      } catch (error) {
        failPrint(key, viewer, error);
      }
    })();
  };

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

            {/* Every print action — PO, delivery note and trip sheet — reports
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

              <div className="max-h-96 min-w-0 overflow-auto rounded-xl border border-border">
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
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 rounded-lg"
                              title={isVi ? "In PO" : "Print PO"}
                              data-kfm-action="print-po"
                              disabled={printing !== null || busy !== null}
                              onClick={() => handlePrintPo(order)}
                            >
                              {printing === `po-${order.portalId}`
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <Printer className="h-4 w-4" />}
                            </Button>
                            {/* The delivery note belongs to the trip, not to the order
                                row: printing it here only duplicated the truck icon. */}
                          </div>
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

          <div className="min-w-0 space-y-2" data-kfm-loads-section="v1">
            <Button
              variant="outline"
              size="sm"
              className="h-10 w-full justify-start rounded-xl sm:w-auto"
              data-kfm-loads-toggle="v1"
              aria-expanded={showLoads}
              onClick={() => setShowLoads((value) => !value)}
            >
              <Truck className="mr-2 h-4 w-4" />
              {isVi ? "Chuyến xe giao hàng" : "Delivery trips"}
              {showLoads && loads.length > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {isVi ? `${loads.length} chuyến` : `${loads.length} trips`}
                </Badge>
              )}
            </Button>

            {showLoads && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  data-kfm-loads-filter="v1"
                  onClick={() => setFilterLoadsByDate((value) => !value)}
                >
                  {filterLoadsByDate
                    ? (isVi ? "Bỏ lọc theo ngày" : "All dates")
                    : (isVi ? "Lọc theo ngày giao" : "Filter by date")}
                </Button>
              </div>
            )}

            {/* Same waiting state the partner portal shows while it renders the
                sheet server side — the operator sees the work, not a blank tab. */}

            {showLoads && loadsQuery.isLoading && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {isVi ? "Đang lấy chuyến giao…" : "Loading trips…"}
              </p>
            )}

            {showLoads && loadsQuery.isError && (
              <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm">
                {(loadsQuery.error as Error)?.message}
              </div>
            )}

            {showLoads && !loadsQuery.isLoading && !loadsQuery.isError && (
              <div className="max-h-72 min-w-0 overflow-auto rounded-xl border border-border">
                <table className="w-full min-w-[600px] text-sm">
                  <thead className="sticky top-0 bg-muted/80 text-left">
                    <tr>
                      <th className="p-2">{isVi ? "Chuyến" : "Trip"}</th>
                      <th className="p-2">{isVi ? "Ngày giao" : "Delivery"}</th>
                      <th className="p-2">{isVi ? "Tài xế" : "Driver"}</th>
                      <th className="p-2">{isVi ? "Xe" : "Truck"}</th>
                      <th className="p-2">{isVi ? "Trạng thái" : "Status"}</th>
                      <th className="sticky right-0 border-l border-border bg-muted p-2 text-right">
                        {isVi ? "Thao tác" : "Actions"}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {loads.map((load) => (
                      <tr key={load.portalId} className="border-t border-border/60">
                        <td className="p-2 font-medium">{load.loadCode || load.portalId}</td>
                        <td className="p-2">{load.deliveryDate || "—"}</td>
                        <td className="p-2">
                          {load.driverName || "—"}
                          {load.driverPhone && (
                            <span className="block text-xs text-muted-foreground">{load.driverPhone}</span>
                          )}
                        </td>
                        <td className="p-2">
                          {load.licensePlate || "—"}
                          {load.vehicleTypeName && (
                            <span className="block text-xs text-muted-foreground">{load.vehicleTypeName}</span>
                          )}
                        </td>
                        <td className="p-2">
                          <Badge variant="outline">{load.status || "—"}</Badge>
                        </td>
                        <td className="sticky right-0 border-l border-border bg-background p-2 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 rounded-lg"
                            title={isVi ? "In phiếu giao hàng" : "Print delivery note"}
                            data-kfm-action="print-load"
                            disabled={printing !== null || busy !== null}
                            onClick={() => handlePrintLoad(load)}
                          >
                            {printing === `load-${load.portalId}`
                              ? <Loader2 className="h-4 w-4 animate-spin" />
                              : <Printer className="h-4 w-4" />}
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {loads.length === 0 && (
                      <tr>
                        <td colSpan={6} className="p-6 text-center text-muted-foreground">
                          {isVi ? "Không có chuyến giao nào." : "No delivery trips."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
