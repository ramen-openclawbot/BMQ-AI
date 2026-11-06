import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowRight, CheckCircle, ClipboardCheck, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { LoadingState } from "@/components/ui/loading";
import { parseKfmPoChanges, type KfmPoChange } from "@/lib/kfmPoChange";

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

type HistoryRange = { deliveryDateFrom: string; deliveryDateTo: string };
type ChangeOutcome = { orderId: number; tone: "success" | "info" | "error"; state: string; text: string };
const dayLabel = (date: string | null) => date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.split("-").reverse().join("/") : (date || "—");
const ORDER_STATUS_VI: Record<string, string> = { planned: "kế hoạch", in_progress: "đang sản xuất", completed: "đã xong", cancelled: "đã hủy" };
const vnToday = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const validDay = (date: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "0001-01-01") return false;
  const value = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
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
  onImported: (inboxId: string) => Promise<KfmIntakeOutcome | void> | KfmIntakeOutcome | void;
  awaitingSetup?: KfmAwaitingSetupPo[];
  awaitingSetupLoading?: boolean;
  awaitingSetupError?: boolean;
  onRefreshAwaitingSetup?: () => Promise<void>;
};

async function intakeRequest(body: Record<string, unknown>, signal?: AbortSignal) {
  const { data } = await supabase.auth.getSession();
  if (!data.session?.access_token) throw new Error("Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.");
  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/kfm-portal-sync?forceFunctionRegion=ap-northeast-2`, {
    method: "POST",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
    headers: { "Content-Type": "application/json", "x-region": "ap-northeast-2", Authorization: `Bearer ${data.session.access_token}` },
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
  const [historyMode, setHistoryMode] = useState(false);
  const [historyEditing, setHistoryEditing] = useState(false);
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");
  const [historyError, setHistoryError] = useState("");
  const lastRange = useRef<HistoryRange | null>(null);
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
  const [changes, setChanges] = useState<KfmPoChange[]>([]);
  const [changeOutcome, setChangeOutcome] = useState<ChangeOutcome | null>(null);
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

  const scan = async (range: HistoryRange | null = null) => {
    if (!canDecide || paused || scanBusy.current || requestBusy.current) return;
    lastRange.current = range;
    setHistoryMode(!!range);
    setHistoryEditing(false);
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
    setChanges([]);
    setChangeOutcome(null);
    setActiveId(null);
    // Refresh read-only pending data alongside the portal check so a PO imported
    // from the separate print workspace shows up without a page reload.
    const refresh = refreshAwaitingSetup();
    try {
      const value = await intakeRequest({ action: "intake-list", ...(range || {}) }, controller.signal);
      if (generation !== scanGeneration.current) return;
      if (!Array.isArray(value.orders) || !Number.isFinite(Number(value.vendorId))) throw new Error("Dữ liệu PO từ KFM không hợp lệ.");
      setVendorId(Number(value.vendorId));
      setChanges(parseKfmPoChanges(value.changed));
      const next = value.orders.filter((order: KfmIntakeOrder) => !settled.current.has(order.orderId));
      setOrders(next);
      setActiveId(next[0]?.orderId ?? null);
      setDetail(next[0]?.message || "");
      setRejecting(false);
      setReason("");
      setResumeInboxId(null);
      await refresh;
      // The parallel read can predate POs this scan just removed as cancelled on KFM.
      if (Array.isArray(value.removed) && value.removed.length > 0) await refreshAwaitingSetup();
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

  const openHistory = () => {
    if (!canDecide || paused || scanBusy.current || requestBusy.current) return;
    setHistoryMode(true);
    setHistoryEditing(true);
    setHistoryError("");
    setScanError("");
    setNotice("");
    setSetupMessage(null);
    setActiveId(null);
    setOpen(true);
  };
  const scanHistory = () => {
    if (!validDay(historyFrom) || !validDay(historyTo) || historyFrom > historyTo || historyTo > vnToday() || (Date.parse(historyTo) - Date.parse(historyFrom)) / 86_400_000 > 6) {
      setHistoryError(isVi ? "Nhập đủ ngày giao từ/đến hợp lệ, từ không sau đến, tối đa 7 ngày và không sau hôm nay tại Việt Nam." : "Enter both valid delivery dates in order, up to 7 inclusive days, no later than today in Vietnam.");
      return;
    }
    setHistoryError("");
    void scan({ deliveryDateFrom: historyFrom, deliveryDateTo: historyTo });
  };

  // Cancel read-only discovery on unmount; never poll or scan on focus/entry.
  useEffect(() => () => {
    scanGeneration.current++;
    scanController.current?.abort();
  }, []);

  useEffect(() => {
    if (!open || historyEditing || checking || scanError || notice || paused || busy || !canDecide || activeId !== null) return;
    const next = orders[0];
    if (next) {
      setActiveId(next.orderId);
      setDetail(next.message || "");
      setRejecting(false);
      setReason("");
      setResumeInboxId(null);
    }
  }, [orders, open, historyEditing, checking, scanError, notice, paused, busy, canDecide, activeId]);

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

  // Apply a KFM quantity edit to an already-imported PO. The server re-reads the
  // portal and refuses when the PO changed again since this scan.
  const applyChange = async (change: KfmPoChange) => {
    if (!vendorId || !canDecide || paused || change.blocked || requestBusy.current) return;
    requestBusy.current = true;
    setBusy(true);
    setOperation(isVi ? `Đang cập nhật ${change.code} theo KFM…` : `Updating ${change.code} from KFM…`);
    setChangeOutcome(null);
    try {
      const value = await intakeRequest({ action: "intake-apply-change", orderId: change.orderId, vendorId, revision: change.revision });
      const result = value.result || {};
      const state = String(result.state || "");
      const drop = () => setChanges((current) => current.filter((row) => row.orderId !== change.orderId));
      if (state === "updated") {
        drop();
        const cancelled = (Array.isArray(result.cancelledOrders) ? result.cancelledOrders : []).map((row: { production_number?: string }) => row?.production_number).filter(Boolean);
        setChangeOutcome({ orderId: change.orderId, tone: "success", state, text: isVi
          ? `${change.code} đã cập nhật theo KFM: ${qtyText(change.oldTotalQty)} → ${qtyText(change.newTotalQty)}.${cancelled.length ? ` Đã hủy lệnh cũ ${cancelled.join(", ")}.` : ""} PO đã về mục Chờ thiết lập SX để tạo lệnh mới.`
          : `${change.code} updated from KFM: ${qtyText(change.oldTotalQty)} → ${qtyText(change.newTotalQty)}.${cancelled.length ? ` Cancelled ${cancelled.join(", ")}.` : ""} The PO is back in setup pending.` });
        await refreshAwaitingSetup();
      } else if (state === "noop") {
        drop();
        setChangeOutcome({ orderId: change.orderId, tone: "info", state, text: isVi ? `${change.code} đã khớp số trên KFM; không cần cập nhật.` : `${change.code} already matches KFM; nothing to update.` });
      } else if (state === "blocked") {
        const started = (Array.isArray(result.warnings) ? result.warnings : []).map((row: { production_number?: string }) => row?.production_number).filter(Boolean);
        setChanges((current) => current.map((row) => row.orderId === change.orderId ? { ...row, blocked: true } : row));
        setChangeOutcome({ orderId: change.orderId, tone: "error", state, text: result.message || (isVi
          ? `Chưa cập nhật ${change.code}: ${started.length ? `lệnh ${started.join(", ")}` : "lệnh sản xuất"} đã bắt đầu làm. Cần xử lý tay; dữ liệu chưa thay đổi.`
          : `${change.code} not updated: production already started. Handle it manually; nothing changed.`) });
      } else {
        setChangeOutcome({ orderId: change.orderId, tone: "error", state: state || "changed", text: result.message || (isVi ? "PO trên KFM vừa đổi lại. Bấm Kiểm tra PO lại để xem số mới." : "The PO changed again on KFM. Check POs again.") });
      }
    } catch (error) {
      setChangeOutcome({ orderId: change.orderId, tone: "error", state: "error", text: error instanceof Error && !["TimeoutError", "AbortError"].includes(error.name) ? error.message : (isVi ? "Chưa xác minh được kết quả. Bấm Kiểm tra PO lại trước khi cập nhật tiếp." : "Result unverified. Check POs again before retrying.") });
    } finally {
      requestBusy.current = false;
      setBusy(false);
    }
  };
  const qtyText = (value: number) => Number(value).toLocaleString(isVi ? "vi-VN" : "en-US");

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
      <div className="mt-4" data-kfm-awaiting-setup-loading>
        <LoadingState flat rows={2} label={isVi ? "Đang tải danh sách PO chờ thiết lập SX…" : "Loading confirmed POs awaiting setup…"} />
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

  const changeOutcomeBlock = changeOutcome ? (
    <p role={changeOutcome.tone === "error" ? "alert" : "status"} data-kfm-po-change-result={changeOutcome.state}
      className={`break-words rounded-xl border p-3 text-sm ${changeOutcome.tone === "error" ? "border-destructive/40 bg-destructive/5 text-destructive" : changeOutcome.tone === "success" ? "border-success/40 bg-success/10 text-foreground" : "border-border bg-muted/40 text-foreground"}`}>
      {changeOutcome.text}
    </p>
  ) : null;

  const renderChanges = (embedded: boolean) => (changes.length > 0 || changeOutcome) && (
    <section data-kfm-po-change="v1" aria-label={isVi ? "PO KFM đã đổi số lượng" : "KFM POs with changed quantities"} className={embedded ? "mb-5 space-y-3 border-b pb-5" : "space-y-3 px-5 pb-2 pt-5"}>
      {changes.length > 0 && <div>
        <h3 className={`${embedded ? "flex" : "sr-only"} items-center gap-2 text-base font-bold text-foreground`}>
          <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0 text-amber-600" />
          {isVi ? "KFM đã đổi số lượng" : "KFM changed quantities"}
        </h3>
        <p className="mt-1 break-words text-xs text-muted-foreground">{isVi ? "PO đã nhận vào BMQ nhưng KFM vừa sửa số. Cập nhật để sản xuất theo số mới." : "Imported POs that KFM edited afterwards. Update to produce the new quantities."}</p>
      </div>}
      {changeOutcomeBlock}
      {changes.map((change) => {
        const edited = change.lines.filter((line) => line.oldQty !== line.newQty);
        const unchanged = change.lines.length - edited.length;
        const delta = change.newTotalQty - change.oldTotalQty;
        const planned = change.productionOrders.filter((order) => order.status === "planned");
        const started = change.productionOrders.filter((order) => !["planned", "cancelled"].includes(order.status));
        return (
          <article key={change.orderId} data-kfm-po-change-item={change.orderId} className="min-w-0 rounded-xl border bg-card">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b p-3 sm:p-4">
              <div className="min-w-0">
                <p className="break-all font-mono text-base font-semibold">{change.code}</p>
                <p className="text-xs text-muted-foreground">{isVi ? "Giao " : "Delivery "}{dayLabel(change.deliveryDate)} · {edited.length} {isVi ? "dòng đổi" : "lines changed"}</p>
              </div>
              <p className="flex shrink-0 items-baseline gap-2 tabular-nums" aria-label={isVi ? `Tổng từ ${change.oldTotalQty} thành ${change.newTotalQty}` : `Total ${change.oldTotalQty} to ${change.newTotalQty}`}>
                <span className="text-sm text-muted-foreground line-through decoration-muted-foreground/60">{qtyText(change.oldTotalQty)}</span>
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 self-center text-muted-foreground" />
                <span className="text-xl font-bold">{qtyText(change.newTotalQty)}</span>
                {delta !== 0 && <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${delta > 0 ? "bg-success/15 text-success" : "bg-destructive/10 text-destructive"}`}>{delta > 0 ? "+" : "−"}{qtyText(Math.abs(delta))}</span>}
              </p>
            </div>
            <ul className="divide-y">
              {edited.map((line) => (
                <li key={line.sku} className="flex min-w-0 items-start justify-between gap-3 px-3 py-2.5 sm:px-4">
                  <div className="min-w-0"><p className="break-words text-sm font-medium">{line.productName || line.sku}</p><p className="break-all text-xs text-muted-foreground">{line.sku}</p></div>
                  <p className="flex shrink-0 items-baseline gap-1.5 text-right tabular-nums">
                    <span className="text-sm text-muted-foreground line-through decoration-muted-foreground/60">{qtyText(line.oldQty)}</span>
                    <ArrowRight aria-hidden="true" className="h-3 w-3 self-center text-muted-foreground" />
                    <span className="text-sm font-semibold">{qtyText(line.newQty)}</span>
                    <span className="text-xs text-muted-foreground">{line.unit}</span>
                  </p>
                </li>
              ))}
            </ul>
            {unchanged > 0 && <p className="border-t px-3 py-2 text-xs text-muted-foreground sm:px-4">{isVi ? `${unchanged} dòng còn lại không đổi` : `${unchanged} other lines unchanged`}</p>}
            <div className="space-y-3 border-t bg-muted/30 p-3 sm:p-4">
              {change.blocked || started.length > 0 ? (
                <p role="alert" className="break-words text-sm text-destructive">{isVi
                  ? `${started.length ? `Lệnh ${started.map((order) => `${order.productionNumber} (${ORDER_STATUS_VI[order.status] || order.status})`).join(", ")}` : "Lệnh sản xuất"} đã bắt đầu làm. Không cập nhật tự động; cần xử lý tay.`
                  : "Production already started. Not updated automatically; handle it manually."}</p>
              ) : (
                <p className="break-words text-sm text-muted-foreground">{isVi
                  ? (planned.length ? `Cập nhật sẽ hủy lệnh ${planned.map((order) => order.productionNumber).join(", ")} theo số cũ. PO về mục Chờ thiết lập SX để tạo lệnh mới.` : "Chưa có lệnh sản xuất. Cập nhật xong, PO về mục Chờ thiết lập SX.")
                  : (planned.length ? `Updating cancels ${planned.map((order) => order.productionNumber).join(", ")}; the PO returns to setup pending.` : "No production order yet; the PO returns to setup pending.")}</p>
              )}
              {!(change.blocked || started.length > 0) && <Button className="min-h-11 w-full gap-2 sm:w-auto" data-kfm-action="apply-change" disabled={busy || !canDecide || paused} onClick={() => void applyChange(change)}>
                <RefreshCw aria-hidden="true" className="h-4 w-4" />{isVi ? "Cập nhật theo KFM" : "Update from KFM"}
              </Button>}
            </div>
          </article>
        );
      })}
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
    <div className="min-w-0 max-w-full" data-kfm-po-intake="manual-popup-v2" data-kfm-history="delivery-range-v1">
      <Button ref={trigger} size="lg" data-kfm-check-po="primary-v1" className="h-12 w-full gap-2 rounded-2xl text-base font-bold shadow-sm" disabled={!canDecide || paused || checking || busy} onClick={() => void scan()}>
        {checking ? <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin motion-reduce:animate-none" /> : <ClipboardCheck aria-hidden="true" className="h-5 w-5" />}
        {isVi ? "Kiểm tra PO" : "Check POs"}
      </Button>
      <Button variant="outline" className="mt-2 min-h-11 w-full" disabled={!canDecide || paused || checking || busy} onClick={openHistory}>
        {isVi ? "Tra cứu PO cũ" : "Look up historical POs"}
      </Button>
      {/* Unmount the review portal on handoff so its exit animation cannot overlay the setup dialog. */}
      {!paused && <Dialog open={open && canDecide} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent className={`flex max-h-[92dvh] w-[calc(100%-1.5rem)] max-w-[720px] flex-col gap-0 overflow-hidden rounded-2xl p-0 motion-reduce:animate-none [&>button]:right-2 [&>button]:top-2 [&>button]:flex [&>button]:h-11 [&>button]:w-11 [&>button]:items-center [&>button]:justify-center ${busy ? "[&>button]:hidden" : ""}`} onCloseAutoFocus={(event) => { event.preventDefault(); if (!handingOff.current) trigger.current?.focus(); }} onInteractOutside={(event) => event.preventDefault()} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
          <DialogHeader className="shrink-0 border-b p-5 pr-12">
            <DialogTitle className="text-xl font-bold">{checking ? (isVi ? "Kiểm tra PO" : "Check POs") : scanError ? (isVi ? "Chưa kiểm tra được PO" : "Unable to check POs") : busy ? (isVi ? "Đang xử lý PO" : "Processing PO") : active ? (isVi ? `Có ${orders.length} PO cần duyệt` : `${orders.length} POs to review`) : changes.length > 0 ? (isVi ? `${changes.length} PO KFM đã đổi số lượng` : `${changes.length} KFM POs changed`) : awaitingSetup.length > 0 ? (isVi ? `${awaitingSetup.length} PO chờ thiết lập SX` : `${awaitingSetup.length} POs awaiting setup`) : (isVi ? "Kết quả kiểm tra" : "Check result")}</DialogTitle>
            <DialogDescription>{active ? active.code : "Portal KFM"}{historyMode && !historyEditing && lastRange.current && <span className="block" data-kfm-history-summary>{isVi ? "Ngày giao KFM: " : "KFM delivery: "}{lastRange.current.deliveryDateFrom} – {lastRange.current.deliveryDateTo}</span>}</DialogDescription>
          </DialogHeader>
          {historyMode && historyEditing && !checking && !busy && <form className="shrink-0 space-y-3 border-b px-5 py-3" onSubmit={(event) => { event.preventDefault(); scanHistory(); }}>
            <p className="text-xs text-muted-foreground">{isVi ? "Tra cứu theo ngày giao trên KFM, tối đa 7 ngày. Đây không phải ngày sản xuất; mở thiết lập SX và chọn ngày dự kiến trước khi tạo lệnh." : "Search KFM delivery dates, up to 7 days. These are not production dates; open setup and choose the planned date before creating an order."}</p>
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1"><Label htmlFor="kfm-history-from">{isVi ? "Ngày giao từ (KFM)" : "KFM delivery date from"}</Label><Input id="kfm-history-from" type="date" max={vnToday()} value={historyFrom} onChange={(event) => { setHistoryFrom(event.target.value); setHistoryError(""); }} className="min-h-11 min-w-0 max-w-full text-base" /></div>
              <div className="min-w-0 space-y-1"><Label htmlFor="kfm-history-to">{isVi ? "Ngày giao đến (KFM)" : "KFM delivery date to"}</Label><Input id="kfm-history-to" type="date" max={vnToday()} value={historyTo} onChange={(event) => { setHistoryTo(event.target.value); setHistoryError(""); }} className="min-h-11 min-w-0 max-w-full text-base" /></div>
            </div>
            {historyError && <p role="alert" className="text-sm text-destructive">{historyError}</p>}
            <Button type="submit" className="min-h-11 w-full" disabled={!canDecide || paused}>{isVi ? "Tra cứu PO cũ" : "Look up historical POs"}</Button>
          </form>}
          {historyEditing && !checking && !busy ? <>
            <p className="min-h-0 overflow-y-auto p-5 text-sm text-muted-foreground">{isVi ? "Chọn khoảng ngày giao rồi bấm Tra cứu PO cũ. Chưa gọi KFM hoặc nhập PO." : "Choose delivery dates and press Look up historical POs. No KFM request or import has been made."}</p>
            <div className="flex justify-end border-t p-4"><Button variant="outline" className="min-h-11" onClick={close}>{isVi ? "Đóng" : "Close"}</Button></div>
          </> : (checking || busy) ? <>
            <div role="status" aria-live="polite" className="min-h-0 overflow-y-auto px-5 py-10 text-center" data-kfm-intake-progress>
              <Loader2 aria-hidden="true" className="mx-auto mb-5 h-10 w-10 animate-spin text-primary motion-reduce:animate-none" />
              <h3 className="text-lg font-semibold">{checking ? (isVi ? "Đang kiểm tra PO…" : "Checking POs…") : operation}</h3>
              <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">{checking ? (isVi ? "Đang lấy danh sách đơn từ KFM. Chưa xác nhận hoặc từ chối đơn nào." : "Loading orders from KFM. No orders are being confirmed or rejected.") : (isVi ? "Chờ KFM xác nhận kết quả trước khi tiếp tục. Không cần bấm lại." : "Waiting for KFM to verify the result. Do not click again.")}</p>
            </div>
            <div className="flex justify-end border-t p-4"><Button variant="outline" className="min-h-11" disabled={busy} onClick={close}>{busy ? (isVi ? "Đang xử lý…" : "Processing…") : (isVi ? "Đóng" : "Close")}</Button></div>
          </> : active ? <>
            <div className="min-h-0 overflow-y-auto p-5" data-kfm-intake-order={active.orderId}>
              {renderChanges(true)}
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
            {!scanError && renderChanges(false)}
            {showRecovery && renderAwaitingSetup(false)}
            <div className="flex flex-wrap justify-end gap-2 border-t p-4">
              <Button variant="outline" className="min-h-11" onClick={close}>{isVi ? "Đóng" : "Close"}</Button>
              {scanError && <Button className="min-h-11" onClick={() => void scan(lastRange.current)}>{isVi ? "Thử lại" : "Try again"}</Button>}
              {notice && orders.length > 0 && <Button className="min-h-11" onClick={() => setNotice("")}>{isVi ? "PO tiếp theo" : "Next PO"}</Button>}
            </div>
          </> : showRecovery || changes.length > 0 || changeOutcome ? <>
            <div className="min-h-0 overflow-y-auto">
              {renderChanges(false)}
              {showRecovery && renderAwaitingSetup(false)}
            </div>
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
