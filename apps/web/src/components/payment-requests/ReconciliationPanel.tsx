/* Đối soát (Duyệt chi): fixed-rule reconciliation labels from the
 * finance_reconciliation_flags view, grouped by PO / supplier. The CEO marks a flag
 * checked / false alarm / needs action, and may open a PO overpay allowance.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import {
  useAllowPurchaseOrderOverpay,
  useFinanceReconciliationFlags,
  useReviewFinanceFlag,
} from "@/hooks/useFinanceReconciliationFlags";
import {
  financeReconciliationLabel,
  groupFlags,
  sortFlags,
  type FinanceReconciliationFlag,
  type FinanceReconciliationReviewStatus,
} from "@/lib/finance-reconciliation-flags";
import { cn } from "@/lib/utils";
import "@/styles/bmq-urgent-payables.css";
import "@/styles/bmq-reconciliation.css";

const vnd = (value: unknown) => `${new Intl.NumberFormat("vi-VN").format(Math.round(Number(value ?? 0)))}\u00a0đ`;
const num = (value: unknown) => Number(value ?? 0);

const PRIORITY: Record<string, { label: string; tone: string }> = {
  critical: { label: "Nghiêm trọng", tone: "is-red" },
  high: { label: "Cao", tone: "is-amber" },
  medium: { label: "Trung bình", tone: "is-blue" },
  low: { label: "Thấp", tone: "" },
};

const REVIEW: Record<FinanceReconciliationReviewStatus, { label: string; tone: string }> = {
  checked: { label: "Đã kiểm tra", tone: "is-green" },
  false_alarm: { label: "Báo nhầm", tone: "" },
  needs_action: { label: "Cần xử lý", tone: "is-red" },
};

/** One readable line of evidence per label. */
export function describeFlag(flag: FinanceReconciliationFlag): string {
  const e = (flag.evidence ?? {}) as Record<string, unknown>;
  switch (flag.label) {
    case "po_overpaid":
      return `PO ${vnd(e.po_total)} · đã chi ${vnd(e.paid_total)} · vượt ${vnd(e.overpaid)}${num(e.allowance) > 0 ? ` (đã tính ngoại lệ ${vnd(e.allowance)})` : ""}`;
    case "po_over_requested":
      return `PO ${vnd(e.po_total)} · tổng đề nghị ${vnd(e.requested_total)} · vượt ${vnd(e.over_requested)}`;
    case "pr_twin_created": {
      const gap = num(e.gap_seconds);
      return `Giống ${String(e.twin_request_number ?? "")}, tạo cách ${gap < 60 ? `${gap} giây` : `${Math.round(gap / 60)} phút`}`;
    }
    case "paid_without_bank_evidence":
      return "Đã ghi chi nhưng không có ảnh UNC hay mã giao dịch";
    case "paid_without_receipt":
      return `Đã chi, chưa có phiếu nhập kho sau ${num(e.days_open)} ngày`;
    case "receipt_confirmed_delivery_pending":
      return `Phiếu nhập ${String(e.receipt_number ?? "")} đã xác nhận, phiếu chi vẫn ghi chưa giao`;
    case "invoice_zero_amount":
      return `Hóa đơn ${String(e.invoice_number ?? "")} ghi 0 đ`;
    default:
      return "";
  }
}

type Scope = "important" | "all";

interface Props {
  onOpenRequest?: (requestId: string) => void;
}

export function ReconciliationPanel({ onOpenRequest }: Props) {
  const { isOwner } = useAuth();
  const [scope, setScope] = useState<Scope>("important");
  const [hideReviewed, setHideReviewed] = useState(true);
  const [pageSize, setPageSize] = useState(12);
  const [reviewing, setReviewing] = useState<FinanceReconciliationFlag | null>(null);
  const [allowing, setAllowing] = useState<FinanceReconciliationFlag | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useFinanceReconciliationFlags({
    onlyOpen: hideReviewed,
    priorities: scope === "important" ? ["critical", "high"] : undefined,
  });

  const groups = useMemo(() => {
    const sorted = sortFlags(data ?? []);
    const grouped = groupFlags(sorted);
    // Keep the order of the most severe flag in each group.
    const order: string[] = [];
    sorted.forEach((f) => {
      const key = f.group_key || `entity:${f.entity_id}`;
      if (!order.includes(key)) order.push(key);
    });
    return order.map((key) => ({ key, flags: grouped[key] }));
  }, [data]);

  const total = data?.length ?? 0;
  const critical = (data ?? []).filter((f) => f.priority === "critical").length;
  const shown = groups.slice(0, pageSize);

  return (
    <section className="d3-rc" data-bmq-reconciliation>
      <header className="d3-rc-head">
        <div>
          <h2>Đối soát <b>{isLoading ? "…" : total}</b></h2>
          <p>Nhãn tính bằng luật cố định từ PO, phiếu chi, phiếu nhập và khoản đã chi. {critical > 0 && <b className="is-red">{critical} nghiêm trọng</b>}</p>
        </div>
        <div className="d3-rc-filters">
          <div className="d3-rc-seg" role="tablist" aria-label="Mức độ">
            <button type="button" role="tab" aria-selected={scope === "important"} className={cn(scope === "important" && "is-on")} onClick={() => { setScope("important"); setPageSize(12); }} data-bmq-rc-scope-important>
              Nghiêm trọng &amp; cao
            </button>
            <button type="button" role="tab" aria-selected={scope === "all"} className={cn(scope === "all" && "is-on")} onClick={() => { setScope("all"); setPageSize(12); }} data-bmq-rc-scope-all>
              Tất cả
            </button>
          </div>
          <label className="d3-up-toggle">
            <input type="checkbox" checked={hideReviewed} onChange={(e) => setHideReviewed(e.target.checked)} data-bmq-rc-hide-reviewed />
            Ẩn nhãn đã xử lý
          </label>
        </div>
      </header>

      {isLoading ? (
        <p className="d3-up-state"><Loader2 className="h-4 w-4 animate-spin" /> Đang tính nhãn đối soát…</p>
      ) : isError ? (
        <p className="d3-up-state is-bad" role="alert" data-bmq-rc-error>
          <TriangleAlert className="h-4 w-4" /> Không tải được nhãn đối soát. <button type="button" onClick={() => refetch()}>Thử lại</button>
        </p>
      ) : groups.length === 0 ? (
        <p className="d3-up-state" data-bmq-rc-empty>
          {hideReviewed ? "Không còn nhãn nào cần xem." : "Không có nhãn nào."}
          {scope === "important" && " Mức trung bình và thấp nằm ở “Tất cả”."}
        </p>
      ) : (
        <ul className={cn("d3-rc-groups", isFetching && "is-fetching")}>
          {shown.map(({ key, flags }) => {
            const head = flags[0];
            const isPo = key.startsWith("po:");
            const poRef = flags.find((f) => f.entity_type === "purchase_order")?.entity_ref
              ?? (flags.find((f) => (f.evidence as Record<string, unknown> | null)?.po_number)?.evidence as Record<string, unknown> | undefined)?.po_number;
            return (
              <li key={key} className="d3-rc-group" data-bmq-rc-group={key}>
                <div className="d3-rc-ghead">
                  <span>
                    <b>{isPo && poRef ? String(poRef) : head.supplier_name || "Chưa có nhà cung cấp"}</b>
                    <small>{isPo ? head.supplier_name || "Chưa có nhà cung cấp" : "Theo nhà cung cấp"}</small>
                  </span>
                </div>
                <ul className="d3-rc-flags">
                  {flags.map((flag) => {
                    const pr = PRIORITY[flag.priority] ?? PRIORITY.low;
                    const review = flag.review_status ? REVIEW[flag.review_status as FinanceReconciliationReviewStatus] : null;
                    const requests = Array.isArray((flag.evidence as Record<string, unknown> | null)?.requests)
                      ? ((flag.evidence as Record<string, unknown>).requests as Array<Record<string, unknown>>)
                      : [];
                    const canAllow = isOwner && flag.entity_type === "purchase_order" && (flag.label === "po_overpaid" || flag.label === "po_over_requested");
                    return (
                      <li key={flag.flag_key} className="d3-rc-flag" data-bmq-rc-flag={flag.label}>
                        <div className="d3-rc-ftop">
                          <span className={cn("d3-up-chip", pr.tone)}>{pr.label}</span>
                          <b>{financeReconciliationLabel(flag.label)}</b>
                          {review && <span className={cn("d3-up-chip", review.tone)}>{review.label}</span>}
                        </div>
                        <p className="d3-rc-why">
                          {flag.entity_type === "payment_request" && onOpenRequest ? (
                            <button type="button" className="d3-rc-ref" onClick={() => onOpenRequest(flag.entity_id)}>{flag.entity_ref}</button>
                          ) : (
                            <span className="d3-rc-ref is-plain">{flag.entity_ref}</span>
                          )}{" "}
                          · {describeFlag(flag)}
                        </p>
                        {requests.length > 0 && (
                          <ul className="d3-rc-reqs">
                            {requests.map((r) => (
                              <li key={String(r.request_number)}>
                                <span>{String(r.request_number)}{r.status === "rejected" ? " · đã từ chối" : ""}</span>
                                <b>đã chi {vnd(r.paid)}</b>
                              </li>
                            ))}
                          </ul>
                        )}
                        {flag.review_note && <p className="d3-rc-note">Ghi chú: {flag.review_note}</p>}
                        {isOwner && (
                          <div className="d3-rc-acts">
                            <Button size="sm" variant="outline" onClick={() => setReviewing(flag)} data-bmq-rc-review>
                              {review ? "Sửa đánh dấu" : "Đánh dấu"}
                            </Button>
                            {canAllow && (
                              <Button size="sm" variant="outline" onClick={() => setAllowing(flag)} data-bmq-rc-allow>
                                <ShieldAlert className="h-4 w-4" /> Mở ngoại lệ
                              </Button>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      )}

      {groups.length > shown.length && (
        <Button variant="outline" className="d3-rc-more" onClick={() => setPageSize((n) => n + 12)} data-bmq-rc-more>
          Xem thêm ({groups.length - shown.length} nhóm)
        </Button>
      )}

      <ReviewDialog flag={reviewing} onClose={() => setReviewing(null)} />
      <AllowDialog flag={allowing} onClose={() => setAllowing(null)} />
    </section>
  );
}

function ReviewDialog({ flag, onClose }: { flag: FinanceReconciliationFlag | null; onClose: () => void }) {
  const review = useReviewFinanceFlag();
  const [status, setStatus] = useState<FinanceReconciliationReviewStatus>("checked");
  const [note, setNote] = useState("");
  const [lastKey, setLastKey] = useState<string | null>(null);
  if (flag && flag.flag_key !== lastKey) {
    setLastKey(flag.flag_key);
    setStatus((flag.review_status as FinanceReconciliationReviewStatus) || "checked");
    setNote(flag.review_note ?? "");
  }

  const save = async () => {
    if (!flag) return;
    try {
      await review.mutateAsync({ flagKey: flag.flag_key, status, note: note.trim() || null });
      toast.success("Đã lưu đánh dấu đối soát");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error && error.message.includes("not_owner") ? "Chỉ CEO đánh dấu được." : "Chưa lưu được, thử lại.");
    }
  };

  return (
    <Dialog open={!!flag} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="d3-unc d3-rc-dialog" data-bmq-rc-review-dialog onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader className="d3-unc-head text-left sm:text-left">
          <span className="d3-unc-tag">Đánh dấu đối soát</span>
          <DialogTitle className="d3-unc-title">{flag ? `${financeReconciliationLabel(flag.label)} · ${flag.entity_ref}` : ""}</DialogTitle>
          <DialogDescription className="d3-unc-sub">{flag ? describeFlag(flag) : ""}</DialogDescription>
        </DialogHeader>
        <div className="d3-rc-choices" role="radiogroup" aria-label="Kết quả kiểm tra">
          {(Object.keys(REVIEW) as FinanceReconciliationReviewStatus[]).map((key) => (
            <button key={key} type="button" role="radio" aria-checked={status === key} className={cn("d3-rc-choice", status === key && "is-on")} onClick={() => setStatus(key)} data-bmq-rc-status={key}>
              {REVIEW[key].label}
            </button>
          ))}
        </div>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ghi chú (ví dụ: đã đối chiếu sao kê 24/03, chỉ chuyển 1 lần)" rows={3} data-bmq-rc-note />
        <div className="d3-up-dialog-acts">
          <Button variant="outline" onClick={onClose}>Hủy</Button>
          <Button onClick={() => void save()} disabled={review.isPending} data-bmq-rc-save>
            {review.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Lưu
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AllowDialog({ flag, onClose }: { flag: FinanceReconciliationFlag | null; onClose: () => void }) {
  const allow = useAllowPurchaseOrderOverpay();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [lastKey, setLastKey] = useState<string | null>(null);
  if (flag && flag.flag_key !== lastKey) {
    setLastKey(flag.flag_key);
    setAmount(String(Math.max(0, Math.round(num(flag.amount)))));
    setReason("");
  }
  const value = Number(amount.replace(/[^\d]/g, ""));
  const valid = value > 0 && reason.trim().length >= 5;

  const save = async () => {
    if (!flag || !valid) return;
    try {
      await allow.mutateAsync({ purchaseOrderId: flag.entity_id, extraAmount: value, reason: reason.trim() });
      toast.success(`Đã mở ngoại lệ ${vnd(value)} cho ${flag.entity_ref}`);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error && error.message.includes("not_owner") ? "Chỉ CEO mở được ngoại lệ." : "Chưa lưu được, thử lại.");
    }
  };

  return (
    <Dialog open={!!flag} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="d3-unc d3-rc-dialog" data-bmq-rc-allow-dialog onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader className="d3-unc-head text-left sm:text-left">
          <span className="d3-unc-tag">Ngoại lệ chi vượt PO</span>
          <DialogTitle className="d3-unc-title">{flag?.entity_ref}</DialogTitle>
          <DialogDescription className="d3-unc-sub">
            Cho phép tổng chi của PO này vượt giá trị PO thêm một khoản, ví dụ giao thêm hàng hoặc phí ship. Lý do được lưu lại để đối soát.
          </DialogDescription>
        </DialogHeader>
        <label className="d3-rc-field">
          <span>Số tiền được vượt thêm</span>
          <Input inputMode="numeric" value={amount ? new Intl.NumberFormat("vi-VN").format(value) : ""} onChange={(e) => setAmount(e.target.value)} data-bmq-rc-allow-amount />
        </label>
        <label className="d3-rc-field">
          <span>Lý do (tối thiểu 5 ký tự)</span>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Ví dụ: NCC giao thêm 2 thùng theo yêu cầu bếp" data-bmq-rc-allow-reason />
        </label>
        <div className="d3-up-dialog-acts">
          <Button variant="outline" onClick={onClose}>Hủy</Button>
          <Button onClick={() => void save()} disabled={!valid || allow.isPending} data-bmq-rc-allow-save>
            {allow.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Mở ngoại lệ
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
