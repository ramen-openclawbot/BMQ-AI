import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle, ClipboardCheck, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";

export type KfmIntakeOrder = {
  orderId: number;
  code: string;
  deliveryDate: string | null;
  locationName: string | null;
  status?: string;
  subStatus?: string;
  revision: string;
  state: "pending" | "unknown" | "import_pending";
  decision?: "confirm" | "reject";
  message?: string;
  items: Array<{ productCode: string; barcode?: string; productName: string; unitName: string; qty: number }>;
};

type IntakeResult = {
  state: "imported" | "rejected" | "unknown" | "changed" | "blocked";
  inboxId?: string;
  message?: string;
};

type Props = {
  canDecide: boolean;
  isVi: boolean;
  paused: boolean;
  onImported: (inboxId: string) => Promise<void>;
};

async function intakeRequest(body: Record<string, unknown>) {
  const { data } = await supabase.auth.getSession();
  if (!data.session?.access_token) throw new Error("Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.");
  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kfm-portal-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  // Reconciliation/changed results are meaningful even when returned with 409.
  if ((!response.ok || value.success === false) && !value.result) {
    throw new Error(value.message || value.error || "Không thể kết nối Cổng KFM.");
  }
  return value;
}

/** Discovery never confirms a PO. Only explicit operator clicks reach intake-decide. */
export default function KfmPoIntake({ canDecide, isVi, paused, onImported }: Props) {
  const [orders, setOrders] = useState<KfmIntakeOrder[]>([]);
  const [vendorId, setVendorId] = useState<number | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [resumeInboxId, setResumeInboxId] = useState<string | null>(null);
  const [uncertainIds, setUncertainIds] = useState<Set<number>>(new Set());
  const dismissed = useRef(new Set<number>());
  const settled = useRef(new Set<number>());
  const requestBusy = useRef(false);
  const scanBusy = useRef(false);
  const activeIdRef = useRef<number | null>(null);
  const active = orders.find((order) => order.orderId === activeId) || null;

  const scan = useCallback(async (manual = false) => {
    if (!canDecide || scanBusy.current || requestBusy.current || (!manual && document.visibilityState !== "visible")) return;
    scanBusy.current = true;
    setChecking(true);
    try {
      const value = await intakeRequest({ action: "intake-list" });
      if (!Array.isArray(value.orders) || !Number.isFinite(Number(value.vendorId))) throw new Error("Dữ liệu PO từ KFM không hợp lệ.");
      setVendorId(Number(value.vendorId));
      const next = value.orders.filter((order: KfmIntakeOrder) => !settled.current.has(order.orderId));
      // Do not replace an order underneath an operator's decision form. The server
      // compares its revision before any confirm/reject and returns fresh data.
      setOrders((current) => {
        const selected = current.find((order) => order.orderId === activeIdRef.current);
        return selected ? [selected, ...next.filter((order: KfmIntakeOrder) => order.orderId !== selected.orderId)] : next;
      });
      if (manual) dismissed.current.clear();
      setNotice(next.length ? "" : (isVi ? "Không có PO KFM mới cần duyệt." : "No new KFM POs to review."));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Không thể kiểm tra PO KFM.");
    } finally {
      scanBusy.current = false;
      setChecking(false);
    }
  }, [canDecide, isVi]);

  useEffect(() => {
    if (!canDecide) return;
    void scan();
    const refresh = () => { if (document.visibilityState === "visible") void scan(); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [canDecide, scan]);

  useEffect(() => {
    if (paused || busy || !canDecide || activeId !== null) return;
    const next = orders.find((order) => !dismissed.current.has(order.orderId));
    if (next) {
      setActiveId(next.orderId);
      activeIdRef.current = next.orderId;
      setDetail(next.message || "");
      setRejecting(false);
      setReason("");
      setResumeInboxId(null);
    }
  }, [orders, paused, busy, canDecide, activeId]);

  const close = () => {
    if (requestBusy.current) return;
    // Closing defers the whole current queue, without recording a rejection.
    orders.forEach((order) => dismissed.current.add(order.orderId));
    setActiveId(null);
    activeIdRef.current = null;
  };

  const finish = (orderId: number) => {
    settled.current.add(orderId);
    setOrders((current) => current.filter((order) => order.orderId !== orderId));
    setActiveId(null);
    activeIdRef.current = null;
    setDetail("");
    setRejecting(false);
    setReason("");
    setResumeInboxId(null);
  };

  const act = async (decision?: "confirm" | "reject") => {
    if (!active || !vendorId || !canDecide || requestBusy.current) return;
    if (decision === "reject" && !reason.trim()) return;
    requestBusy.current = true;
    setBusy(true);
    setDetail("");
    const orderId = active.orderId;
    try {
      if (resumeInboxId) {
        await onImported(resumeInboxId);
        finish(orderId);
        return;
      }
      const value = await intakeRequest(decision ? {
        action: "intake-decide", orderId, vendorId, revision: active.revision,
        requestId: crypto.randomUUID(), decision, ...(decision === "reject" ? { reason: reason.trim() } : {}),
      } : { action: "intake-result", orderId, vendorId });
      const result = value.result as IntakeResult | undefined;
      if (!result) throw new Error("Chưa nhận được kết quả. Hãy tra cứu trước khi tiếp tục.");
      if (result.state === "imported" && result.inboxId) {
        setResumeInboxId(result.inboxId);
        await onImported(result.inboxId);
        finish(orderId);
      } else if (result.state === "rejected") {
        setNotice(result.message || (isVi ? `${active.code}: KFM đã ghi nhận từ chối / hủy.` : `${active.code}: KFM confirmed rejection / cancellation.`));
        finish(orderId);
      } else if (result.state === "changed" && value.order) {
        setOrders((current) => current.map((order) => order.orderId === orderId ? value.order : order));
        setUncertainIds((current) => { const next = new Set(current); next.delete(orderId); return next; });
        setDetail(result.message || (isVi ? "PO đã thay đổi. Hãy kiểm tra lại trước khi quyết định." : "The PO changed. Review it again before deciding."));
        setRejecting(false);
      } else {
        setUncertainIds((current) => new Set(current).add(orderId));
        setDetail(result.message || (isVi ? "Chưa xác minh kết quả. Chỉ tra cứu, không gửi lại." : "Result unverified. Check status; do not resend."));
      }
    } catch (error) {
      // A network error is not evidence that the remote mutation failed.
      setUncertainIds((current) => new Set(current).add(orderId));
      setDetail(error instanceof Error ? error.message : "Không thể xác minh kết quả từ KFM.");
    } finally {
      requestBusy.current = false;
      setBusy(false);
    }
  };

  const recoverOnly = !!active && (uncertainIds.has(active.orderId) || active.state !== "pending" || !!resumeInboxId);
  const alreadyConfirmed = !!active && [5, 6, 9].includes(Number(active.subStatus));
  return (
    <div className="min-w-0 max-w-full" data-kfm-po-intake="v1">
      <Button variant="outline" size="lg" className="h-12 w-full rounded-2xl border-primary/30 bg-card/80 text-base font-bold text-primary hover:bg-primary/10 hover:text-primary" disabled={!canDecide || checking || busy} onClick={() => void scan(true)}>
        {checking ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <ClipboardCheck className="mr-2 h-5 w-5" />}
        {isVi ? "Kiểm tra PO" : "Check POs"}{orders.length > 0 && <span className="ml-2 rounded-full bg-primary px-2 text-xs text-primary-foreground">{orders.length}</span>}
      </Button>
      {notice && <p role="status" className="mt-2 max-w-sm break-words text-sm text-muted-foreground">{notice}</p>}
      {/* Unmount the review portal on handoff so its exit animation cannot overlay the setup dialog. */}
      {!paused && <Dialog open={!!active && canDecide} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent className="flex max-h-[92dvh] w-[calc(100%-1.5rem)] max-w-3xl flex-col gap-0 overflow-hidden rounded-2xl p-0" onInteractOutside={(event) => event.preventDefault()} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
          <DialogHeader className="shrink-0 border-b p-5 pr-12">
            <DialogTitle className="text-xl font-bold">{isVi ? "Duyệt PO từ KFM" : "Review KFM PO"}</DialogTitle>
            <DialogDescription>{isVi ? "Xác nhận đơn trên KFM trước, sau đó thiết lập sản xuất. Đóng khung để xử lý sau." : "Confirm on KFM first, then set up production. Close to review later."}</DialogDescription>
          </DialogHeader>
          {active && <>
            <div className="min-h-0 overflow-y-auto p-5" data-kfm-intake-order={active.orderId}>
              <div className="mb-4 space-y-1 break-words">
                <p className="font-mono text-lg font-bold">{active.code}</p>
                <p className="text-sm"><span className="text-muted-foreground">{isVi ? "Ngày giao: " : "Delivery: "}</span>{active.deliveryDate || "—"}</p>
                <p className="text-sm"><span className="text-muted-foreground">{isVi ? "Kho nhận: " : "Warehouse: "}</span>{active.locationName || "—"}</p>
                <p className="text-xs text-muted-foreground">{active.items.length} {isVi ? "dòng sản phẩm" : "items"} · {orders.length} {isVi ? "PO chờ xử lý" : "POs awaiting review"}</p>
                {alreadyConfirmed && <p className="text-sm text-primary">{isVi ? "PO đã được xác nhận trên KFM. Tiếp tục để nhập vào sản xuất; không gửi xác nhận lại." : "Already confirmed on KFM. Continue to import for production; no confirmation is resent."}</p>}
              </div>
              <div className="divide-y rounded-xl border">
                {active.items.map((item, index) => <div key={`${item.productCode}-${index}`} className="flex min-w-0 items-start justify-between gap-3 p-3">
                  <div className="min-w-0"><p className="break-words text-sm font-medium">{item.productName}</p><p className="break-all text-xs text-muted-foreground">{item.productCode}</p></div>
                  <p className="shrink-0 text-right text-sm font-semibold">{Number(item.qty).toLocaleString(isVi ? "vi-VN" : "en-US")}<br/><span className="font-normal text-muted-foreground">{item.unitName}</span></p>
                </div>)}
              </div>
              {rejecting && !recoverOnly && <div className="mt-4 space-y-2">
                <Label htmlFor="kfm-reject-reason">{isVi ? "Lý do từ chối (gửi đến KFM)" : "Rejection reason (sent to KFM)"}</Label>
                <Textarea id="kfm-reject-reason" value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} maxLength={1000} className="min-h-24 text-base" autoFocus />
              </div>}
              {detail && <p role="alert" className="mt-4 break-words rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">{detail}</p>}
              {recoverOnly && <p className="mt-3 text-sm text-muted-foreground">{isVi ? "Đang chờ xác minh / hoàn tất nhập PO. Không gửi xác nhận hoặc từ chối lần nữa." : "Awaiting verification / import. No confirmation or rejection will be resent."}</p>}
            </div>
            <div className="flex shrink-0 flex-col gap-2 border-t bg-muted/20 p-4 sm:flex-row sm:justify-end">
              {recoverOnly ? <Button className="min-h-11" disabled={busy} onClick={() => void act()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : <RefreshCw className="mr-2 h-4 w-4"/>}{resumeInboxId ? (isVi ? "Tiếp tục thiết lập SX" : "Continue production setup") : (isVi ? "Tra cứu kết quả" : "Check result")}</Button> : <>
                {Number(active.subStatus) === 3 && <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => { if (rejecting) { setRejecting(false); setReason(""); } else setRejecting(true); }}>{rejecting ? (isVi ? "Quay lại" : "Back") : (isVi ? "Từ chối" : "Reject")}</Button>}
                {rejecting ? <Button variant="destructive" className="min-h-11" disabled={busy || !reason.trim()} onClick={() => void act("reject")}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin"/>}{isVi ? "Gửi từ chối đến KFM" : "Send rejection to KFM"}</Button> : <Button className="min-h-11" disabled={busy || active.items.length === 0} onClick={() => void act("confirm")}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : <CheckCircle className="mr-2 h-4 w-4"/>}{alreadyConfirmed ? (isVi ? "Tiếp tục nhập PO" : "Continue importing PO") : (isVi ? "Xác nhận" : "Confirm")}</Button>}
              </>}
            </div>
          </>}
        </DialogContent>
      </Dialog>}
    </div>
  );
}
