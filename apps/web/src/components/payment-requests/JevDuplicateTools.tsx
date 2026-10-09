/* Jev duplicate scan (Đối soát): the owner runs a dry run or a saved scan, compares a
 * flagged pair side by side and records "same purchase" / "different purchase".
 * Thresholds, candidates and writes all live on the server; this is display only.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronDown, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import {
  useReviewJevDuplicate,
  useRunJevDuplicateScan,
  type JevDuplicateScanResult,
} from "@/hooks/useJevDuplicateScan";
import type { FinanceReconciliationFlag } from "@/lib/finance-reconciliation-flags";
import { cn } from "@/lib/utils";

const vnd = (value: unknown) => `${new Intl.NumberFormat("vi-VN").format(Math.round(Number(value ?? 0)))}\u00a0đ`;
const pct = (value: unknown) => (value === null || value === undefined ? "—" : `${Math.round(Number(value) * 100)}%`);

export const JEV_RELATION_TEXT: Record<string, string> = {
  same_purchase: "cùng một lần mua",
  repeat_order: "đặt lại định kỳ",
  split_or_partial: "tách phiếu / trả từng phần",
  unrelated: "không liên quan",
};

const STATUS_TEXT: Record<string, { label: string; tone: string }> = {
  auto_flag: { label: "Jev: trùng", tone: "is-red" },
  needs_review: { label: "Cần anh duyệt", tone: "is-amber" },
  auto_clear: { label: "Jev: không trùng", tone: "is-green" },
};

const SCAN_ERROR: Record<string, string> = {
  disabled: "Jev đang tắt (công tắc an toàn).",
  forbidden: "Chỉ CEO quét được bằng Jev.",
  unauthorized: "Phiên đăng nhập hết hạn, anh đăng nhập lại.",
  unconfigured: "Máy chủ chưa có khóa AI cho Jev.",
  timeout: "Quét quá thời gian, chưa ghi gì. Thử lại với ít cặp hơn.",
};

async function scanErrorText(error: unknown): Promise<string> {
  const context = (error as { context?: Response } | null)?.context;
  if (context && typeof context.json === "function") {
    try {
      const body = await context.clone().json();
      if (body?.code && SCAN_ERROR[body.code]) return SCAN_ERROR[body.code];
      if (typeof body?.error === "string") return body.error;
    } catch { /* fall through */ }
  }
  return "Chưa quét được bằng Jev, chưa ghi gì. Thử lại sau.";
}

/** "Quét thử" / "Quét & lưu" bar at the top of Đối soát (owner only). */
export function JevScanBar() {
  const scan = useRunJevDuplicateScan({ mode: "dry_run", limit: 50, days: 90 });
  const [result, setResult] = useState<JevDuplicateScanResult | null>(null);
  const [mode, setMode] = useState<"dry_run" | "run" | null>(null);

  const start = async (next: "dry_run" | "run") => {
    setMode(next);
    try {
      const data = await scan.mutateAsync({ mode: next });
      if (next === "dry_run") setResult(data);
      else toast.success(`Jev đã quét ${data.checked} cặp: ${data.auto_flag} trùng, ${data.needs_review} cần duyệt, ${data.auto_clear} không trùng${data.failed ? `, ${data.failed} lỗi` : ""}.`);
    } catch (error) {
      toast.error(await scanErrorText(error));
    } finally {
      setMode(null);
    }
  };

  return (
    <div className="d3-jev-bar" data-bmq-jev-bar>
      <span className="d3-jev-ico"><Sparkles className="h-4 w-4" /></span>
      <span className="d3-jev-copy">
        <b>Jev quét chi trùng khác PO</b>
        <small>Cặp phiếu cùng NCC, số tiền gần nhau, trong 45 ngày · 50 cặp mỗi lần · 90 ngày gần nhất</small>
      </span>
      <div className="d3-jev-acts">
        <Button size="sm" variant="outline" disabled={scan.isPending} onClick={() => void start("dry_run")} data-bmq-jev-dry>
          {mode === "dry_run" && <Loader2 className="h-4 w-4 animate-spin" />} Quét thử (không ghi)
        </Button>
        <Button size="sm" disabled={scan.isPending} onClick={() => void start("run")} data-bmq-jev-run>
          {mode === "run" && <Loader2 className="h-4 w-4 animate-spin" />} Quét &amp; lưu
        </Button>
      </div>

      <Dialog open={!!result} onOpenChange={(o) => !o && setResult(null)}>
        <DialogContent className="d3-unc d3-jev-dialog" data-bmq-jev-result onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader className="d3-unc-head text-left sm:text-left">
            <span className="d3-unc-tag">Quét thử · chưa ghi gì</span>
            <DialogTitle className="d3-unc-title">Jev đã xem <b>{result?.checked ?? 0}</b> cặp</DialogTitle>
            <DialogDescription className="d3-unc-sub">
              {result?.candidates ?? 0} cặp ứng viên · {result?.auto_flag ?? 0} trùng · {result?.needs_review ?? 0} cần duyệt · {result?.auto_clear ?? 0} không trùng
              {result?.failed ? ` · ${result.failed} lỗi` : ""}{result?.skipped_unchanged ? ` · ${result.skipped_unchanged} đã quét, không đổi` : ""}
            </DialogDescription>
          </DialogHeader>
          {result?.items && result.items.length > 0 ? (
            <ul className="d3-jev-items">
              {[...result.items]
                .sort((a, b) => Number(b.p_same ?? -1) - Number(a.p_same ?? -1))
                .map((item) => {
                  const st = item.status ? STATUS_TEXT[item.status] : null;
                  return (
                    <li key={item.pair_key} data-bmq-jev-item={item.status ?? "error"}>
                      <span className="d3-jev-pair"><b>{item.older_request}</b> ↔ <b>{item.newer_request}</b></span>
                      <span className="d3-jev-meta">
                        {item.error ? (
                          <span className="d3-up-chip is-red">Lỗi Jev</span>
                        ) : (
                          <>
                            {st && <span className={cn("d3-up-chip", st.tone)}>{st.label}</span>}
                            <span>trùng {pct(item.p_same)}</span>
                            {item.relation && <span>· {JEV_RELATION_TEXT[item.relation] ?? item.relation}</span>}
                          </>
                        )}
                      </span>
                    </li>
                  );
                })}
            </ul>
          ) : (
            <p className="d3-up-state">Không có cặp mới cần Jev xem.</p>
          )}
          <div className="d3-up-dialog-acts">
            <Button variant="outline" onClick={() => setResult(null)}>Đóng</Button>
            <Button onClick={() => { setResult(null); void start("run"); }} disabled={scan.isPending} data-bmq-jev-save>
              Quét &amp; lưu
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One-line evidence for a jev_possible_duplicate flag. */
export function describeJevFlag(flag: FinanceReconciliationFlag): string {
  const e = (flag.evidence ?? {}) as Record<string, unknown>;
  const relation = e.relation ? JEV_RELATION_TEXT[String(e.relation)] ?? String(e.relation) : null;
  return `Giống ${String(e.older_request ?? "")} (${vnd(e.amount_older)}) · cách ${Number(e.days_apart ?? 0)} ngày · Jev: trùng ${pct(e.p_same)}${relation ? `, ${relation}` : ""}`;
}

interface PairSide {
  id: string;
  request_number: string;
  created_at: string;
  total_amount: number;
  title: string | null;
  goods_receipts: { receipt_number: string | null; receipt_date: string | null } | null;
  invoices: { invoice_number: string | null } | null;
  payment_request_items: Array<{ product_name: string | null; quantity: number | null; unit: string | null; line_total: number | null }> | null;
}

/** Side-by-side comparison + CEO decision for one Jev pair. */
export function JevPairReview({ flag, isOwner, onOpenRequest }: { flag: FinanceReconciliationFlag; isOwner: boolean; onOpenRequest?: (id: string) => void }) {
  const pairKey = flag.flag_key.replace(/^jev_possible_duplicate:/, "");
  const ids = pairKey.split(":");
  const [open, setOpen] = useState(false);
  const review = useReviewJevDuplicate();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["jev-pair", pairKey],
    enabled: open && ids.length === 2,
    queryFn: async (): Promise<PairSide[]> => {
      const { data: rows, error } = await supabase
        .from("payment_requests")
        .select("id, request_number, created_at, total_amount, title, goods_receipts!payment_requests_goods_receipt_id_fkey(receipt_number, receipt_date), invoices!payment_requests_invoice_id_fkey(invoice_number), payment_request_items(product_name, quantity, unit, line_total)")
        .in("id", ids);
      if (error) throw error;
      return ((rows ?? []) as unknown as PairSide[]).sort((a, b) => a.created_at.localeCompare(b.created_at));
    },
  });

  const decide = async (decision: "same_purchase" | "different_purchase") => {
    try {
      await review.mutateAsync({ pairKey, decision });
      toast.success(decision === "same_purchase" ? "Đã ghi: chi trùng" : "Đã ghi: không trùng, nhãn sẽ ẩn");
    } catch {
      toast.error("Chưa lưu được quyết định, thử lại.");
    }
  };

  return (
    <div className="d3-jev-review" data-bmq-jev-review={pairKey}>
      <button type="button" className={cn("d3-jev-toggle", open && "is-open")} onClick={() => setOpen((v) => !v)} aria-expanded={open} data-bmq-jev-compare>
        So sánh 2 phiếu <ChevronDown className="h-4 w-4" />
      </button>
      {open && (
        isLoading ? (
          <p className="d3-rc-note"><Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Đang tải 2 phiếu…</p>
        ) : isError || !data ? (
          <p className="d3-rc-note">Không tải được 2 phiếu.</p>
        ) : (
          <div className="d3-jev-grid">
            {data.map((side) => (
              <div key={side.id} className="d3-jev-side" data-bmq-jev-side={side.request_number}>
                <button type="button" className="d3-rc-ref" onClick={() => onOpenRequest?.(side.id)}>{side.request_number}</button>
                <b>{vnd(side.total_amount)}</b>
                <small>Tạo {side.created_at.slice(8, 10)}/{side.created_at.slice(5, 7)}/{side.created_at.slice(0, 4)}</small>
                <small>{side.goods_receipts?.receipt_number ? `Nhập kho ${side.goods_receipts.receipt_number}` : "Chưa có phiếu nhập"}{side.invoices?.invoice_number ? ` · HĐ ${side.invoices.invoice_number}` : ""}</small>
                <ul>
                  {(side.payment_request_items ?? []).slice(0, 6).map((it, i) => (
                    <li key={i}><span>{it.product_name || "—"}</span><span>{it.quantity ?? ""} {it.unit ?? ""}</span></li>
                  ))}
                  {(side.payment_request_items?.length ?? 0) > 6 && <li><span>+{(side.payment_request_items?.length ?? 0) - 6} dòng</span></li>}
                </ul>
              </div>
            ))}
          </div>
        )
      )}
      {isOwner && (
        <div className="d3-rc-acts">
          <Button size="sm" variant="outline" disabled={review.isPending} onClick={() => void decide("same_purchase")} data-bmq-jev-same>
            <Check className="h-4 w-4" /> Đúng là trùng
          </Button>
          <Button size="sm" variant="outline" disabled={review.isPending} onClick={() => void decide("different_purchase")} data-bmq-jev-diff>
            <X className="h-4 w-4" /> Không trùng
          </Button>
        </div>
      )}
    </div>
  );
}
