/* Chi tiền mặt — one bank slip pays several tạm ứng phiếu of the same requester.
 * Opened from a receipt whose amount exceeds what the current phiếu still owes. Lists the
 * requester's cash phiếu still awaiting receipts, pre-ticks the combination whose remaining
 * equals the slip, and confirms through submit_cash_shared_slip (server re-validates all).
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, Lock, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { LoadingState } from "@/components/ui/loading";
import { loadCashSharedSlipCandidates, type CashSharedSlipSubmitResult } from "@/hooks/useCashSettlement";
import { planSharedSlipAllocations, suggestSharedSlipRequests, type SharedSlipAllocation } from "@/lib/cash-shared-slip";
import { cn } from "@/lib/utils";

const vnd = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${new Intl.NumberFormat("vi-VN").format(Math.round(Number(value)))} đ`;

const ERROR_TEXT: Record<string, string> = {
  shared_total_mismatch: "Tổng các phiếu đã chọn chưa bằng số tiền trên slip.",
  requester_mismatch: "Chỉ gộp được các phiếu của cùng một người đề nghị.",
  receipt_amount_missing: "Chưa đọc được số tiền trên slip.",
  not_awaiting_receipts: "Có phiếu không còn chờ chứng từ. Tải lại trang.",
  receipt_not_uploaded: "Slip đã được ghép hoặc đã bỏ. Tải lại trang.",
  item_over_allocated: "Có khoản đã đủ chứng từ. Tải lại trang.",
  insufficient_privilege: "Anh/chị chưa có quyền nộp chứng từ cho một trong các phiếu này.",
};

const errorText = (error: unknown) => {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error ?? "");
  const code = Object.keys(ERROR_TEXT).find((key) => message.includes(key));
  return code ? ERROR_TEXT[code] : "Chưa lưu được. Thử lại sau.";
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  receiptId: string;
  slipAmount: number;
  submit: (receiptId: string, allocations: SharedSlipAllocation[]) => Promise<CashSharedSlipSubmitResult>;
  onDone: (result: CashSharedSlipSubmitResult) => void;
}

export function CashSharedSlipDialog({ open, onOpenChange, requestId, receiptId, slipAmount, submit, onDone }: Props) {
  const query = useQuery({
    queryKey: ["cash-shared-slip-candidates", requestId, receiptId],
    enabled: open,
    staleTime: 0,
    queryFn: () => loadCashSharedSlipCandidates(requestId),
  });
  const candidates = useMemo(() => query.data ?? [], [query.data]);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPicked(null);
      setSaveError(null);
    }
  }, [open]);

  const suggestion = useMemo(() => (candidates.length ? suggestSharedSlipRequests(slipAmount, candidates) : null), [candidates, slipAmount]);
  useEffect(() => {
    if (suggestion && picked === null) setPicked(new Set(suggestion.requestIds));
  }, [suggestion, picked]);

  const selected = useMemo(() => picked ?? new Set<string>(), [picked]);
  const selectedTotal = candidates.filter((c) => selected.has(c.requestId)).reduce((s, c) => s + c.remainingTotal, 0);
  const diff = Math.round(slipAmount) - Math.round(selectedTotal);
  const plan = useMemo(() => planSharedSlipAllocations(slipAmount, candidates, [...selected]), [slipAmount, candidates, selected]);
  const others = candidates.filter((c) => !c.isCurrent);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const confirm = async () => {
    if (!plan.ok) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await submit(receiptId, plan.allocations);
      onDone(result);
      onOpenChange(false);
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const planHint = ((p) => {
    if (p.ok) return null;
    const code = "code" in p ? p.code : null;
    if (code === "too_many_requests") return "Tối đa 10 phiếu cho một slip.";
    if (code === "too_many_allocations") return "Quá nhiều khoản cho một slip (tối đa 100).";
    if (code === "current_required") return "Phiếu đang mở phải nằm trong lựa chọn.";
    return diff > 0 ? `Còn thiếu ${vnd(diff)} so với slip. Chọn thêm phiếu.` : `Vượt slip ${vnd(-diff)}. Bỏ bớt phiếu.`;
  })(plan);

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="d3-css-dialog" data-bmq-cash-shared>
        <DialogTitle>Trả chung cho nhiều phiếu</DialogTitle>
        <DialogDescription>
          Slip <b>{vnd(slipAmount)}</b>. Chọn các phiếu tạm ứng của cùng người đề nghị mà slip này trả, tổng phải bằng đúng số trên slip.
        </DialogDescription>

        {query.isLoading ? (
          <LoadingState flat rows={3} label="Đang tải các phiếu…" />
        ) : query.error ? (
          <p className="d3-ub-why is-bad" role="alert"><TriangleAlert className="h-3.5 w-3.5" /> Không tải được danh sách phiếu.</p>
        ) : (
          <>
            {suggestion?.exact && plan.ok && (
              <p className="d3-ub-why is-ok" data-bmq-cash-shared-suggest><Check className="h-3.5 w-3.5" /> Đã chọn sẵn các phiếu cộng đúng số trên slip.</p>
            )}
            {others.length === 0 && (
              <p className="d3-ub-why is-bad" data-bmq-cash-shared-none><TriangleAlert className="h-3.5 w-3.5" /> Không có phiếu tạm ứng nào khác của người này đang chờ chứng từ.</p>
            )}
            <ul className="d3-css-list" aria-label="Phiếu tạm ứng">
              {candidates.map((c) => {
                const on = selected.has(c.requestId);
                return (
                  <li key={c.requestId}>
                    <button
                      type="button"
                      className={cn("d3-css-row", on && "is-on")}
                      aria-pressed={on}
                      disabled={c.isCurrent || saving}
                      onClick={() => toggle(c.requestId)}
                      data-bmq-cash-shared-row={c.requestNumber}
                    >
                      <span className="d3-css-box">{c.isCurrent ? <Lock className="h-3 w-3" /> : on && <Check className="h-3.5 w-3.5" />}</span>
                      <span className="d3-css-name">
                        <b>{c.requestNumber}</b>
                        <small>{c.isCurrent ? "Phiếu đang mở" : `${c.items.filter((i) => i.remaining > 0).length} khoản chưa có chứng từ`}</small>
                      </span>
                      <span className="d3-css-amt">{vnd(c.remainingTotal)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="d3-css-sum" data-bmq-cash-shared-sum={plan.ok ? "ok" : "mismatch"}>
              <span>Đã chọn {selected.size} phiếu</span>
              <b>{vnd(selectedTotal)} / {vnd(slipAmount)}</b>
            </div>
            {planHint && <p className="d3-ub-why is-bad" data-bmq-cash-shared-hint><TriangleAlert className="h-3.5 w-3.5" /> {planHint}</p>}
            {saveError && <p className="d3-ub-why is-bad" role="alert"><TriangleAlert className="h-3.5 w-3.5" /> {saveError}</p>}
            <Button className="d3-ub-go d3-css-go" disabled={!plan.ok || saving} onClick={() => void confirm()} data-bmq-cash-shared-confirm>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Ghép slip vào {selected.size} phiếu
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
