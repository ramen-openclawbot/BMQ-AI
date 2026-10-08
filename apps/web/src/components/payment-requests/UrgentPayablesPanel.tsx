/* Duyệt chi · Chưa thanh toán: the unpaid requests of the last 90 days, 10 per page
 * (server-side range, nothing else is loaded). Accounting ticks "Trình chi gấp" on one
 * or more rows and sends them to the CEO as one payment submission (Zalo link).
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, Loader2, Search, Send, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getRemainingPaymentAmount, type PaymentRequestWithSupplier } from "@/hooks/usePaymentRequests";
import { useCreatePaymentSubmission, useUnpaidPaymentRequestsPage } from "@/hooks/usePaymentSubmissions";
import { cn } from "@/lib/utils";
import "@/styles/bmq-urgent-payables.css";

const vnd = (value: number) => `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đ`;
const MAX_PER_SUBMISSION = 50;

const ageDays = (iso: string) => {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "hôm nay" : `${days} ngày`;
};

const dmy = (iso: string) => {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
};

const submissionError = (error: unknown) => {
  const message = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  if (message.includes("not_payable")) return "Có phiếu vừa được trả hoặc bị từ chối. Tải lại danh sách rồi chọn lại.";
  if (message.includes("insufficient_privilege") || message.includes("not_owner")) return "Anh/chị chưa có quyền trình chi.";
  if (message.includes("too_many_requests")) return `Mỗi lần trình tối đa ${MAX_PER_SUBMISSION} phiếu.`;
  return "Chưa gửi được phiếu trình chi. Thử lại.";
};

type Props = {
  canSubmit: boolean;
  onOpenRequest: (requestId: string) => void;
};

export function UrgentPayablesPanel({ canSubmit, onOpenRequest }: Props) {
  const [page, setPage] = useState(1);
  const [allTime, setAllTime] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Map<string, PaymentRequestWithSupplier>>(new Map());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState<{ id: string; number: string } | null>(null);

  const { data, isLoading, isError, isFetching, refetch } = useUnpaidPaymentRequestsPage({
    page,
    pageSize: 10,
    days: allTime ? null : 90,
    search,
  });
  const create = useCreatePaymentSubmission();

  const rows = data?.rows ?? [];
  const totalPages = data?.totalPages ?? 1;
  const selectedList = useMemo(() => Array.from(selected.values()), [selected]);
  const selectedTotal = selectedList.reduce((sum, r) => sum + getRemainingPaymentAmount(r), 0);

  const toggle = (row: PaymentRequestWithSupplier) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(row.id)) next.delete(row.id);
      else if (next.size < MAX_PER_SUBMISSION) next.set(row.id, row);
      else toast.error(`Mỗi lần trình tối đa ${MAX_PER_SUBMISSION} phiếu.`);
      return next;
    });
  };

  const submit = async () => {
    try {
      const result = await create.mutateAsync({ requestIds: selectedList.map((r) => r.id), note: note.trim() || null });
      setSent({ id: result.submission_id, number: result.submission_number });
      setSelected(new Map());
      setNote("");
      toast.success(`Đã trình chi gấp ${result.submission_number}`);
    } catch (error) {
      toast.error(submissionError(error));
    }
  };

  return (
    <section className="d3-up" data-bmq-urgent-payables>
      <div className="d3-up-head">
        <div className="min-w-0">
          <h2>
            Chưa thanh toán <b>{isLoading ? "…" : data?.totalCount ?? 0}</b>
          </h2>
          <p>{allTime ? "Tất cả thời gian" : "90 ngày gần nhất"} · mới nhất trước · 10 phiếu mỗi trang</p>
        </div>
        <label className="d3-up-toggle">
          <input
            type="checkbox"
            checked={allTime}
            onChange={(e) => {
              setAllTime(e.target.checked);
              setPage(1);
            }}
            data-bmq-urgent-all-time
          />
          <span>Xem cả phiếu cũ hơn 90 ngày</span>
        </label>
      </div>

      <div className="d3-up-search">
        <Search className="h-4 w-4" />
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Tìm nhà cung cấp, mã phiếu"
          aria-label="Tìm theo nhà cung cấp hoặc mã phiếu"
        />
      </div>

      {isLoading ? (
        <p className="d3-up-state"><Loader2 className="h-4 w-4 animate-spin" /> Đang tải…</p>
      ) : isError ? (
        <p className="d3-up-state is-bad" role="alert" data-bmq-urgent-error>
          <TriangleAlert className="h-4 w-4" /> Không tải được danh sách.{" "}
          <button type="button" onClick={() => refetch()}>Thử lại</button>
        </p>
      ) : rows.length === 0 ? (
        <p className="d3-up-state" data-bmq-urgent-empty>Không có phiếu chưa thanh toán {allTime ? "" : "trong 90 ngày"}.</p>
      ) : (
        <ul className={cn("d3-up-rows", isFetching && "is-fetching")}>
          {rows.map((row) => {
            const remaining = getRemainingPaymentAmount(row);
            const isOn = selected.has(row.id);
            return (
              <li key={row.id} className={cn("d3-up-row", isOn && "is-on")} data-bmq-urgent-row={row.request_number}>
                {canSubmit && (
                  <label className="d3-up-check">
                    <Checkbox checked={isOn} onCheckedChange={() => toggle(row)} aria-label={`Trình chi gấp ${row.request_number}`} />
                    <span>Trình chi gấp</span>
                  </label>
                )}
                <button type="button" className="d3-up-open" onClick={() => onOpenRequest(row.id)}>
                  <span className="d3-up-who">
                    <b>{row.suppliers?.name || "Chưa có nhà cung cấp"}</b>
                    <small>{row.request_number} · {row.title || "Đề nghị thanh toán"}</small>
                  </span>
                  <span className="d3-up-amt">
                    {new Intl.NumberFormat("vi-VN").format(Math.round(remaining))}
                    <small>đ</small>
                  </span>
                  <span className="d3-up-meta">
                    <span className={cn("d3-up-chip", row.status === "pending" ? "is-amber" : "is-green")}>
                      {row.status === "pending" ? "Chờ duyệt" : "Đã duyệt"}
                    </span>
                    {row.payment_status === "partial" && <span className="d3-up-chip is-blue">Đã trả một phần</span>}
                    <span>{dmy(row.created_at)} · {ageDays(row.created_at)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="d3-up-pages">
        <span>Trang {data?.page ?? page}/{totalPages}</span>
        <div>
          <Button variant="outline" size="icon" aria-label="Trang trước" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" aria-label="Trang sau" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {canSubmit && selectedList.length > 0 && (
        <div className="d3-up-bar" data-bmq-urgent-bar>
          <span>
            Đã chọn <b>{selectedList.length}</b> · Tổng <b>{vnd(selectedTotal)}</b>
          </span>
          <div>
            <Button type="button" variant="ghost" onClick={() => setSelected(new Map())}>Bỏ chọn</Button>
            <Button type="button" className="d3-up-go" onClick={() => { setSent(null); setConfirmOpen(true); }} data-bmq-urgent-submit-open>
              <Send className="h-4 w-4" /> Trình chi gấp
            </Button>
          </div>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={(open) => !create.isPending && setConfirmOpen(open)}>
        <DialogContent className="d3-up-dialog" data-bmq-urgent-dialog>
          {sent ? (
            <>
              <DialogHeader className="text-left">
                <span className="d3-up-tag">Trình chi gấp</span>
                <DialogTitle>Đã gửi {sent.number}</DialogTitle>
                <DialogDescription>Tin kèm link đã vào hàng gửi nhóm Zalo BMQ - Duyệt chi. CEO bấm link để chi từng khoản.</DialogDescription>
              </DialogHeader>
              <div className="d3-up-dialog-acts">
                <Button asChild variant="outline"><Link to={`/payment-requests/submissions/${sent.id}`}>Mở phiếu trình chi</Link></Button>
                <Button className="d3-up-go" onClick={() => setConfirmOpen(false)}>Xong</Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader className="text-left">
                <span className="d3-up-tag">Trình chi gấp</span>
                <DialogTitle>{selectedList.length} phiếu · {vnd(selectedTotal)}</DialogTitle>
                <DialogDescription>Gửi phiếu trình chi cho CEO qua nhóm Zalo BMQ - Duyệt chi.</DialogDescription>
              </DialogHeader>
              <ol className="d3-up-preview" data-bmq-urgent-preview>
                {selectedList.map((r) => (
                  <li key={r.id}>
                    <span>
                      <b>{r.suppliers?.name || "Chưa có nhà cung cấp"}</b>
                      <small>{r.request_number}</small>
                    </span>
                    <b>{vnd(getRemainingPaymentAmount(r))}</b>
                  </li>
                ))}
              </ol>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Ghi chú cho CEO (không bắt buộc), ví dụ: cần chi trước 15h để nhận hàng"
                aria-label="Ghi chú trình chi"
                rows={2}
                maxLength={200}
              />
              <div className="d3-up-dialog-acts">
                <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={create.isPending}>Hủy</Button>
                <Button className="d3-up-go" onClick={() => void submit()} disabled={create.isPending} data-bmq-urgent-submit>
                  {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Gửi trình chi
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
