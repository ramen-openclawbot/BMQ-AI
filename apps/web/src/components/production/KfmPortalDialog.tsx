import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, FileText, Loader2, Printer, RefreshCw, Truck } from "lucide-react";

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

function savePdf(base64: string, filename: string): void {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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

  const handlePrintPo = (order: KfmOrder) => {
    void runAction(`po-${order.portalId}`, async () => {
      const detail = await callPortal({ action: "detail", deliveryDate, orderId: order.portalId });
      // The portal prints a PO by order id: its own "print PO" action calls
      // GET /api/v1/purchase-orders/{orderId}/export-pdf. Only fall back to a
      // dedicated PO id when the detail payload actually carries one.
      const poId = detail.order?.purchaseOrderId ?? order.portalId;
      if (!poId) throw new Error(isVi ? "Đơn này chưa có PO để in." : "This order has no PO to print.");
      const pdf = await callPortal({ action: "po-pdf", poId });
      savePdf(pdf.base64 || "", pdf.filename || `PO-${order.code}.pdf`);
      return isVi ? `Đã tải PO ${order.code}.` : `PO ${order.code} downloaded.`;
    });
  };

  const handlePrintAsn = (order: KfmOrder) => {
    void runAction(`asn-${order.portalId}`, async () => {
      const detail = await callPortal({ action: "detail", deliveryDate, orderId: order.portalId });
      const asn = detail.order?.asns?.[0];
      if (!asn) throw new Error(isVi ? "Đơn này chưa có phiếu giao hàng." : "This order has no delivery note yet.");
      const pdf = await callPortal({ action: "asn-pdf", asnId: asn.asnId, poId: detail.order?.purchaseOrderId ?? undefined });
      savePdf(pdf.base64 || "", pdf.filename || `Phieu-giao-hang-${asn.asnCode || asn.asnId}.pdf`);
      return isVi ? `Đã tải phiếu giao hàng ${asn.asnCode || asn.asnId}.` : "Delivery note downloaded.";
    });
  };

  const busyIcon = (key: string) =>
    busy === key ? <Loader2 className="h-4 w-4 animate-spin" /> : null;

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
        <DialogContent className="max-w-3xl">
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

          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-muted-foreground" htmlFor="kfm-delivery-date">
              {isVi ? "Ngày giao" : "Delivery date"}
            </label>
            <input
              id="kfm-delivery-date"
              type="date"
              value={deliveryDate}
              onChange={(event) => setDeliveryDate(event.target.value)}
              className="h-10 rounded-xl border border-border bg-background px-3 text-sm"
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
              <Badge variant="outline" className="ml-auto">
                {data.vendorCode}
              </Badge>
            )}
          </div>

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
                  <span className="ml-auto text-xs">
                    {isVi ? "Phiên" : "Session"}: {data.session.mode === "refresh" ? "refresh token" : "đăng nhập mới"}
                  </span>
                )}
              </div>

              <div className="max-h-96 overflow-auto rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/80 text-left">
                    <tr>
                      <th className="p-2">{isVi ? "Mã PO" : "PO"}</th>
                      <th className="p-2">{isVi ? "Kho nhận" : "Location"}</th>
                      <th className="p-2 text-right">{isVi ? "Số dòng" : "Items"}</th>
                      <th className="p-2 text-right">{isVi ? "SL" : "Qty"}</th>
                      <th className="p-2 text-right">{isVi ? "Thao tác" : "Actions"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.portalId} className="border-t border-border/60">
                        <td className="p-2 font-medium">{order.code}</td>
                        <td className="p-2">{order.locationName || "—"}</td>
                        <td className="p-2 text-right">{order.itemCount ?? "—"}</td>
                        <td className="p-2 text-right">{qty(order.totalQty)}</td>
                        <td className="p-2">
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
                              disabled={busy !== null}
                              onClick={() => handlePrintPo(order)}
                            >
                              {busyIcon(`po-${order.portalId}`) || <Printer className="h-4 w-4" />}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 rounded-lg"
                              title={isVi ? "In phiếu giao hàng" : "Print delivery note"}
                              data-kfm-action="print-asn"
                              disabled={busy !== null}
                              onClick={() => handlePrintAsn(order)}
                            >
                              {busyIcon(`asn-${order.portalId}`) || <FileText className="h-4 w-4" />}
                            </Button>
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
        </DialogContent>
      </Dialog>
    </>
  );
}
