import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle, ClipboardCheck, Loader2, RefreshCw } from "lucide-react";
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

/** A confirmed KFM portal PO that still has no linked production order. */
export type KfmAwaitingSetupPo = {
  id: string;
  poNumber: string;
  deliveryDate: string | null;
  itemCount: number;
};

/** Outcome of the handoff: the setup dialog opened, or someone else already linked the PO. */
export type KfmIntakeOutcome = "setup-opened" | "already-linked";

type IntakeResult = {
  state: "imported" | "rejected" | "unknown" | "changed" | "blocked";
  inboxId?: string;
  message?: string;
};

type Props = {
  canDecide: boolean;
  isVi: boolean;
  paused: boolean;
  onImported: (inboxId: string) => Promise<KfmIntakeOutcome | void> | KfmIntakeOutcome | void;
  awaitingSetup?: KfmAwaitingSetupPo[];
  awaitingSetupLoading?: boolean;
  awaitingSetupError?: boolean;
  onRefreshAwaitingSetup?: () => Promise<void>;
};

async function intakeRequest(body: Record<string, unknown>, signal?: AbortSignal) {
  const { data } = await supabase.auth.getSession();
  if (!data.session?.access_token) throw new Error("Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.");
  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kfm-portal-sync`, {
    method: "POST",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
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

/** Hallmark · component: manual PO popup · inherited BMQ tokens
 * States: default, hover, focus, active, disabled, loading, error, success.
 * Pre-emit critique: P4 H4 E4 S5 R4 V4. Component scope, no page restructuring.
 * Manual discovery only; external decisions retain server journal/recovery.
 * Confirmed-but-unlinked POs are surfaced here so setup is reachable from the popup.
 */
export default function KfmPoIntake({ canDecide, isVi, paused, onImported, awaitingSetup = [], awaitingSetupLoading = false, awaitingSetupError = false, onRefreshAwaitingSetup }: Props) {
  const [orders, setOrders] = useState<KfmIntakeOrder[]>([]);
  const [vendorId, setVendorId] = useState<number | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [scanError, setScanError] = useState("");
  const [operation, setOperation] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [resumeInboxId, setResumeInboxId] = useState<string | null>(null);
  const [uncertainIds, setUncertainIds] = useState<Set<number>>(new Set());
  const [setupMessage, setSetupMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const scanController = useRef<AbortController | null>(null);
  const scanGeneration = useRef(0);
  const settled = useRef(new Set<number>());
  const requestBusy = useRef(false);
  const scanBusy = useRef(false);
  const handingOff = useRef(false);
  const active = orders.find((order) => order.orderId === activeId) || null;

  const refreshAwaitingSetup = async () => {
    if (!onRefreshAwaitingSetup) return;
    try {
      await onRefreshAwaitingSetup();
    } catch {
      // The read failure is reported through awaitingSetupError, not the scan result.
    }
  };

  const scan = async () => {
    if (!canDecide || paused || scanBusy.current || requestBusy.current) return;
    const generation = ++scanGeneration.current;
    const controller = new AbortController();
    scanController.current = controller;
    scanBusy.current = true;
    handingOff.current = false;
    setOpen(true);
    setChecking(true);
    setScanError("");
    setNotice("");
    setSetupMessage(null);
    setActiveId(null);
    // Refresh read-only pending data alongside the portal check so a PO imported
    // from the separate print workspace shows up without a page reload.
    const refresh = refreshAwaitingSetup();
    try {
      const value = await intakeRequest({ action: "intake-list" }, controller.signal);
      if (generation !== scanGeneration.current) return;
      if (!Array.isArray(value.orders) || !Number.isFinite(Number(value.vendorId))) throw new Error("Dữ liệu PO từ KFM không hợp lệ.");
      setVendorId(Number(value.vendorId));
      const next = value.orders.filter((order: KfmIntakeOrder) => !settled.current.has(order.orderId));
      setOrders(next);
      setActiveId(next[0]?.orderId ?? null);
      setDetail(next[0]?.message || "");
      setRejecting(false);
      setReason("");
      setResumeInboxId(null);
      await refresh;
    } catch (error) {
      if (generation !== scanGeneration.current) return;
      setScanError(error instanceof Error && error.name !== "TimeoutError" ? error.message : (isVi ? "KFM chưa phản hồi. Hãy thử kiểm tra lại." : "KFM did not respond. Please try again."));
      await refresh;
    } finally {
      if (generation === scanGeneration.current) {
        scanBusy.current = false;
        setChecking(false);
      }
    }
  };

  // Cancel read-only discovery on unmount; never poll or scan on focus/entry.
  useEffect(() => () => {
    scanGeneration.current++;
    scanController.current?.abort();
  }, []);

  useEffect(() => {
    if (!open || checking || scanError || notice || paused || busy || !canDecide || activeId !== null) return;
    const next = orders[0];
    if (next) {
      setActiveId(next.orderId);
      setDetail(next.message || "");
      setRejecting(false);
      setReason("");
      setResumeInboxId(null);
    }
  }, [orders, open, checking, scanError, notice, paused, busy, canDecide, activeId]);

  const close = () => {
    if (requestBusy.current) return;
    // Closing a scan cancels it; stale responses cannot reopen this popup.
    ++scanGeneration.current;
    scanController.current?.abort();
    scanBusy.current = false;
    setChecking(false);
    setOpen(false);
    setActiveId(null);
    setSetupMessage(null);
  };

  const finish = (orderId: number) => {
    settled.current.add(orderId);
    setOrders((current) => current.filter((order) => order.orderId !== orderId));
    setActiveId(null);
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
    setOperation(resumeInboxId ? (isVi ? "Đang mở thiết lập sản xuất…" : "Opening production setup…") : decision === "reject" ? (isVi ? "Đang gửi từ chối đến KFM…" : "Sending rejection to KFM…") : decision === "confirm" ? (isVi ? "Đang xác nhận PO trên KFM…" : "Confirming PO on KFM…") : (isVi ? "Đang tra cứu kết quả…" : "Checking the result…"));
    setDetail("");
    const orderId = active.orderId;
    try {
      if (resumeInboxId) {
        handingOff.current = true;
        setOpen(false);
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
        handingOff.current = true;
        setOpen(false);
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
      handingOff.current = false;
      setOpen(true);
      // A network error is not evidence that the remote mutation failed.
      setUncertainIds((current) => new Set(current).add(orderId));
      setDetail(error instanceof Error && !["TimeoutError", "AbortError"].includes(error.name) ? error.message : (isVi ? "Chưa xác minh được kết quả từ KFM. Hãy tra cứu trước khi tiếp tục." : "KFM result unverified. Check the result before continuing."));
    } finally {
      requestBusy.current = false;
      setBusy(false);
    }
  };

  // Open the existing production setup for a confirmed PO. This is read-only:
  // the operator still submits the setup dialog explicitly.
  const continueSetup = async (po: KfmAwaitingSetupPo) => {
    if (!canDecide || paused || requestBusy.current) return;
    requestBusy.current = true;
    setBusy(true);
    setOperation(isVi ? "Đang mở thiết lập sản xuất…" : "Opening production setup…");
    setSetupMessage(null);
    try {
      handingOff.current = true;
      setOpen(false);
      const outcome = await onImported(po.id);
      if (outcome === "already-linked") {
        handingOff.current = false;
        setOpen(true);
        setSetupMessage({ tone: "info", text: isVi ? `${po.poNumber} đã được lập lệnh sản xuất ở nơi khác; không tạo trùng.` : `${po.poNumber} already has a production order; nothing was duplicated.` });
        await refreshAwaitingSetup();
      }
    } catch (error) {
      handingOff.current = false;
      setOpen(true);
      setSetupMessage({ tone: "error", text: error instanceof Error ? error.message : (isVi ? "Chưa mở được thiết lập sản xuất." : "Could not open production setup.") });
      await refreshAwaitingSetup();
    } finally {
      requestBusy.current = false;
      setBusy(false);
    }
  };

  const recoverOnly = !!active && (uncertainIds.has(active.orderId) || active.state !== "pending" || !!resumeInboxId);
  const alreadyConfirmed = !!active && [5, 6, 9].includes(Number(active.subStatus));
  const showRecovery = awaitingSetup.length > 0 || awaitingSetupLoading || awaitingSetupError;

  const setupMessageBlock = setupMessage ? (
    <p role={setupMessage.tone === "error" ? "alert" : "status"} className={`mt-3 break-words rounded-lg border p-3 text-sm ${setupMessage.tone === "error" ? "border-destructive/50 bg-destructive/10 text-destructive" : "border-primary/40 bg-primary/10 text-primary"}`}>
      {setupMessage.text}
    </p>
  ) : null;

  const awaitingSetupBlock = <>
    <div>
      <h3 className="flex items-center gap-2 text-base font-bold text-foreground">
        <ClipboardCheck aria-hidden="true" className="h-4 w-4 text-primary" />
        {isVi ? "PO KFM đã xác nhận · Chờ thiết lập SX" : "Confirmed KFM POs · Setup pending"}
      </h3>
      <p className="mt-1 break-words text-xs text-muted-foreground">
        {isVi ? "Đã nhập từ KFM nhưng chưa có lệnh sản xuất. Mở đúng thiết lập; bước này chưa tạo gì." : "Imported from KFM without a production order yet. Opens the real setup; nothing is created here."}
      </p>
    </div>
    {awaitingSetupLoading ? (
      <div role="status" aria-live="polite" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground" data-kfm-awaiting-setup-loading>
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        {isVi ? "Đang tải danh sách PO chờ thiết lập SX…" : "Loading confirmed POs awaiting setup…"}
      </div>
    ) : awaitingSetupError ? (
      <p role="alert" className="mt-4 break-words text-sm text-destructive" data-kfm-awaiting-setup-error>
        {isVi ? "Không đọc được danh sách PO chờ thiết lập SX. Đây chưa phải là “không có PO”; hãy thử lại." : "Could not read the POs awaiting setup. This is not “no POs”; please retry."}
      </p>
    ) : (
      <ul className="mt-4 space-y-2">
        {awaitingSetup.map((po) => (
          <li key={po.id} data-kfm-awaiting-setup-item={po.id} className="flex min-w-0 flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 break-words">
              <p className="font-mono font-semibold">{po.poNumber}</p>
              <p className="text-sm text-muted-foreground">{isVi ? "Ngày giao: " : "Delivery: "}{po.deliveryDate || "—"} · {po.itemCount} {isVi ? "dòng sản phẩm" : "items"}</p>
            </div>
            <Button variant="outline" className="min-h-11 shrink-0" disabled={busy || !canDecide} onClick={() => void continueSetup(po)}>
              {isVi ? "Tiếp tục thiết lập SX" : "Continue production setup"}
            </Button>
          </li>
        ))}
      </ul>
    )}
  </>;

  const renderAwaitingSetup = (embedded: boolean) => (
    <section data-kfm-awaiting-setup="v1" className={embedded ? "mt-5 border-t pt-4" : "px-5 py-6"} aria-label={isVi ? "PO chờ thiết lập sản xuất" : "POs awaiting production setup"}>
      {awaitingSetupBlock}
      {setupMessageBlock}
    </section>
  );

  const emptyResult = (
    <div role="status" className="min-h-0 overflow-y-auto px-5 py-10 text-center">
      <CheckCircle aria-hidden="true" className="mx-auto mb-5 h-10 w-10 text-primary" />
      <h3 className="text-lg font-semibold">{isVi ? "Không có PO mới cần duyệt" : "No new POs to review"}</h3>
      <p className="mt-3 break-words text-sm text-muted-foreground">{isVi ? "Đã kiểm tra xong. Không có đơn mới cần duyệt và không có PO KFM nào đang chờ thiết lập sản xuất." : "The check is complete. No new orders to review and no confirmed KFM POs awaiting production setup."}</p>
    </div>
  );

  return (
    <div className="min-w-0 max-w-full" data-kfm-po-intake="manual-popup-v2">
      <Button ref={trigger} variant="outline" size="lg" className="h-12 w-full rounded-2xl border-primary/30 bg-card/80 text-base font-bold text-primary hover:bg-primary/10 hover:text-primary" disabled={!canDecide || paused || checking || busy} onClick={() => void scan()}>
        {checking ? <Loader2 className="mr-2 h-5 w-5 animate-spin motion-reduce:animate-none" /> : <ClipboardCheck className="mr-2 h-5 w-5" />}
        {isVi ? "Kiểm tra PO" : "Check POs"}
      </Button>
      {/* Unmount the review portal on handoff so its exit animation cannot overlay the setup dialog. */}
      {!paused && <Dialog open={open && canDecide} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent className={`flex max-h-[92dvh] w-[calc(100%-1.5rem)] max-w-[720px] flex-col gap-0 overflow-hidden rounded-2xl p-0 motion-reduce:animate-none [&>button]:right-2 [&>button]:top-2 [&>button]:flex [&>button]:h-11 [&>button]:w-11 [&>button]:items-center [&>button]:justify-center ${busy ? "[&>button]:hidden" : ""}`} onCloseAutoFocus={(event) => { event.preventDefault(); if (!handingOff.current) trigger.current?.focus(); }} onInteractOutside={(event) => event.preventDefault()} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
          <DialogHeader className="shrink-0 border-b p-5 pr-12">
            <DialogTitle className="text-xl font-bold">{checking ? (isVi ? "Kiểm tra PO" : "Check POs") : scanError ? (isVi ? "Chưa kiểm tra được PO" : "Unable to check POs") : busy ? (isVi ? "Đang xử lý PO" : "Processing PO") : active ? (isVi ? `Có ${orders.length} PO cần duyệt` : `${orders.length} POs to review`) : awaitingSetup.length > 0 ? (isVi ? `${awaitingSetup.length} PO chờ thiết lập SX` : `${awaitingSetup.length} POs awaiting setup`) : (isVi ? "Kết quả kiểm tra" : "Check result")}</DialogTitle>
            <DialogDescription>{active ? active.code : "Portal KFM"}</DialogDescription>
          </DialogHeader>
          {(checking || busy) ? <>
            <div role="status" aria-live="polite" className="min-h-0 overflow-y-auto px-5 py-10 text-center" data-kfm-intake-progress>
              <Loader2 aria-hidden="true" className="mx-auto mb-5 h-10 w-10 animate-spin text-primary motion-reduce:animate-none" />
              <h3 className="text-lg font-semibold">{checking ? (isVi ? "Đang kiểm tra PO…" : "Checking POs…") : operation}</h3>
              <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">{checking ? (isVi ? "Đang lấy danh sách đơn từ KFM. Chưa xác nhận hoặc từ chối đơn nào." : "Loading orders from KFM. No orders are being confirmed or rejected.") : (isVi ? "Chờ KFM xác nhận kết quả trước khi tiếp tục. Không cần bấm lại." : "Waiting for KFM to verify the result. Do not click again.")}</p>
            </div>
            <div className="flex justify-end border-t p-4"><Button variant="outline" className="min-h-11" disabled={busy} onClick={close}>{busy ? (isVi ? "Đang xử lý…" : "Processing…") : (isVi ? "Đóng" : "Close")}</Button></div>
          </> : active ? <>
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
              <p className="mt-4 text-sm text-muted-foreground">{isVi ? "Xác nhận đơn trên KFM trước, sau đó chuyển sang thiết lập sản xuất. Chưa tạo phiếu giao hàng." : "Confirm on KFM first, then set up production. No delivery note is created here."}</p>
              {rejecting && !recoverOnly && <div className="mt-4 space-y-2">
                <Label htmlFor="kfm-reject-reason">{isVi ? "Lý do từ chối (gửi đến KFM)" : "Rejection reason (sent to KFM)"}</Label>
                <Textarea id="kfm-reject-reason" value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} maxLength={1000} className="min-h-24 text-base" autoFocus />
              </div>}
              {detail && <p role="alert" className="mt-4 break-words rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">{detail}</p>}
              {recoverOnly && <p className="mt-3 text-sm text-muted-foreground">{isVi ? "Đang chờ xác minh / hoàn tất nhập PO. Không gửi xác nhận hoặc từ chối lần nữa." : "Awaiting verification / import. No confirmation or rejection will be resent."}</p>}
              {showRecovery && renderAwaitingSetup(true)}
            </div>
            <div className="flex shrink-0 flex-col gap-2 border-t bg-muted/20 p-4 sm:flex-row sm:justify-end">
              <Button variant="ghost" className="min-h-11 sm:mr-auto" onClick={close}>{isVi ? "Để sau" : "Later"}</Button>
              {recoverOnly ? <Button className="min-h-11" disabled={busy} onClick={() => void act()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : <RefreshCw className="mr-2 h-4 w-4"/>}{resumeInboxId ? (isVi ? "Tiếp tục thiết lập SX" : "Continue production setup") : (isVi ? "Tra cứu kết quả" : "Check result")}</Button> : <>
                {Number(active.subStatus) === 3 && <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => { if (rejecting) { setRejecting(false); setReason(""); } else setRejecting(true); }}>{rejecting ? (isVi ? "Quay lại" : "Back") : (isVi ? "Từ chối" : "Reject")}</Button>}
                {rejecting ? <Button variant="destructive" className="min-h-11" disabled={busy || !reason.trim()} onClick={() => void act("reject")}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin"/>}{isVi ? "Gửi từ chối đến KFM" : "Send rejection to KFM"}</Button> : <Button className="min-h-11" disabled={busy || active.items.length === 0} onClick={() => void act("confirm")}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : <CheckCircle className="mr-2 h-4 w-4"/>}{alreadyConfirmed ? (isVi ? "Tiếp tục nhập PO" : "Continue importing PO") : (isVi ? "Xác nhận" : "Confirm")}</Button>}
              </>}
            </div>
          </> : scanError || notice ? <>
            <div role={scanError ? "alert" : "status"} className="min-h-0 overflow-y-auto px-5 py-10 text-center">
              {scanError ? <AlertCircle aria-hidden="true" className="mx-auto mb-5 h-10 w-10 text-destructive" /> : <CheckCircle aria-hidden="true" className="mx-auto mb-5 h-10 w-10 text-primary" />}
              <h3 className="text-lg font-semibold">{scanError ? (isVi ? "Chưa có kết quả kiểm tra" : "No check result yet") : notice || (isVi ? "Không có PO mới cần duyệt" : "No new POs to review")}</h3>
              <p className="mt-3 break-words text-sm text-muted-foreground">{scanError || (notice ? (isVi ? "PO không được nhập vào sản xuất." : "The PO was not imported for production.") : (isVi ? "Đã kiểm tra xong. Không có đơn mới hoặc đơn chờ duyệt trong lần kiểm tra này." : "The check is complete. No new or pending orders were found."))}</p>
            </div>
            {showRecovery && renderAwaitingSetup(false)}
            <div className="flex flex-wrap justify-end gap-2 border-t p-4">
              <Button variant="outline" className="min-h-11" onClick={close}>{isVi ? "Đóng" : "Close"}</Button>
              {scanError && <Button className="min-h-11" onClick={() => void scan()}>{isVi ? "Thử lại" : "Try again"}</Button>}
              {notice && orders.length > 0 && <Button className="min-h-11" onClick={() => setNotice("")}>{isVi ? "PO tiếp theo" : "Next PO"}</Button>}
            </div>
          </> : showRecovery ? <>
            {renderAwaitingSetup(false)}
            <div className="flex flex-wrap justify-end gap-2 border-t p-4">
              <Button variant="outline" className="min-h-11" onClick={close}>{isVi ? "Đóng" : "Close"}</Button>
            </div>
          </> : <>
            {emptyResult}
            {setupMessageBlock}
            <div className="flex flex-wrap justify-end gap-2 border-t p-4">
              <Button variant="outline" className="min-h-11" onClick={close}>{isVi ? "Đóng" : "Close"}</Button>
            </div>
          </>}
        </DialogContent>
      </Dialog>}
    </div>
  );
}
