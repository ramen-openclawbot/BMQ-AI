import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw, Truck } from "lucide-react";

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
 * Read-only: nothing is confirmed and no delivery note is created here.
 * When the portal is not reachable the panel says so; the existing email PO
 * flow ("Kiểm tra PO") keeps working unchanged.
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
  orderTotalWithTax: number | null;
  statusLabel?: string;
};

type KfmResponse = {
  success: boolean;
  configured?: boolean;
  deliveryDate?: string;
  vendorCode?: string | null;
  vendorId?: number | null;
  count?: number;
  orders?: KfmOrder[];
  session?: { mode: string; obtainedAt: string };
  error?: string;
  step?: string;
  message?: string;
};

const money = (value: number | null | undefined) =>
  typeof value === "number"
    ? value.toLocaleString("vi-VN", { maximumFractionDigits: 0 })
    : "—";

async function fetchPortalOrders(deliveryDate: string): Promise<KfmResponse> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.");

  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kfm-portal-sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ deliveryDate }),
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
  return parsed;
}

export default function KfmPortalDialog({ isVi = true }: { isVi?: boolean }) {
  const [open, setOpen] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState(() => vnDateOffset(1));

  const query = useQuery({
    queryKey: ["kfm-portal-orders", deliveryDate],
    queryFn: () => fetchPortalOrders(deliveryDate),
    enabled: open,
    retry: false,
    staleTime: 30_000,
  });

  const data = query.data;
  const orders = data?.orders || [];

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
                ? "Đọc trực tiếp từ cổng đối tác — chỉ xem, không xác nhận, không tạo phiếu giao hàng."
                : "Read directly from the partner portal — view only, nothing is confirmed."}
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
                      <th className="p-2 text-right">{isVi ? "Tổng (gồm VAT)" : "Total"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.portalId} className="border-t border-border/60">
                        <td className="p-2 font-medium">{order.code}</td>
                        <td className="p-2">{order.locationName || "—"}</td>
                        <td className="p-2 text-right">{order.itemCount ?? "—"}</td>
                        <td className="p-2 text-right">{money(order.totalQty)}</td>
                        <td className="p-2 text-right">{money(order.orderTotalWithTax)}</td>
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
