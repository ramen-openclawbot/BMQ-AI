/* Phiếu trình chi gấp (CEO): every request the accountant submitted, live paid/remaining
 * state, and per-row or multi-row "Chi UNC" / "Chi tiền mặt" with the matching slip.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Banknote, ChevronLeft, ChevronRight, CreditCard, Images, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/contexts/AuthContext";
import { usePaymentSubmission, type PaymentSubmissionItemDetail } from "@/hooks/usePaymentSubmissions";
import { UncApprovalDialog, type UncApprovalRequest } from "@/components/payment-requests/UncApprovalDialog";
import { UncBulkDialog } from "@/components/payment-requests/UncBulkDialog";
import type { UncBulkPaymentRequest } from "@/lib/payment-unc-bulk-match";
import { PaymentRequestDetailsDialog } from "@/components/dialogs/PaymentRequestDetailsDialog";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useFinanceReconciliationFlags } from "@/hooks/useFinanceReconciliationFlags";
import { financeReconciliationLabel, sortFlags, type FinanceReconciliationFlag } from "@/lib/finance-reconciliation-flags";
import "@/styles/bmq-reconciliation.css";
import "@/styles/bmq-urgent-payables.css";

const vnd = (value: number | null | undefined) => `${new Intl.NumberFormat("vi-VN").format(Math.round(Number(value ?? 0)))}\u00a0đ`;
const dmyhm = (iso: string) =>
  new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

const ddmm = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "");

interface ReceiptInfo {
  id: string;
  purchase_order_id: string | null;
  goods_receipt_id: string | null;
  goods_receipts: { receipt_number: string | null; receipt_date: string | null; status: string | null } | null;
}

/** Goods receipt + PO link per phiếu, for the "Đã/Chưa nhập kho" chip. */
function useSubmissionReceipts(ids: string[]) {
  return useQuery({
    queryKey: ["payment-submission-receipts", [...ids].sort()],
    enabled: ids.length > 0,
    queryFn: async (): Promise<ReceiptInfo[]> => {
      const { data, error } = await supabase
        .from("payment_requests")
        .select("id, purchase_order_id, goods_receipt_id, goods_receipts!payment_requests_goods_receipt_id_fkey(receipt_number, receipt_date, status)")
        .in("id", ids);
      if (error) throw error;
      return (data ?? []) as unknown as ReceiptInfo[];
    },
  });
}

const isOpenFlag = (f: FinanceReconciliationFlag) => !f.review_status || f.review_status === "needs_action";

const isPaid = (item: PaymentSubmissionItemDetail) => Number(item.remaining_amount) <= 0 || item.payment_status === "paid";

const toDialogRequest = (item: PaymentSubmissionItemDetail): UncApprovalRequest => ({
  id: item.payment_request_id,
  requestNumber: item.request_number,
  supplierName: item.supplier_name,
  supplierId: item.supplier_id,
  totalAmount: Number(item.total_amount ?? 0),
  allocatedAmount: Number(item.allocated_amount ?? 0),
  status: item.status,
  paymentStatus: item.payment_status,
  createdAt: item.created_at,
});

export default function PaymentSubmission() {
  const { id } = useParams<{ id: string }>();
  const { isOwner } = useAuth();
  const { data, isLoading, isError, refetch } = usePaymentSubmission(id ?? null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [payWith, setPayWith] = useState<{ method: "bank_transfer" | "cash"; ids: string[] } | null>(null);
  const [openRequest, setOpenRequest] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const items = useMemo(() => [...(data?.items ?? [])].sort((a, b) => a.position - b.position), [data]);
  const open = items.filter((i) => !isPaid(i));
  const paidCount = items.length - open.length;
  const remainingTotal = open.reduce((sum, i) => sum + Number(i.remaining_amount || 0), 0);
  const dialogRequests = payWith ? items.filter((i) => payWith.ids.includes(i.payment_request_id)).map(toDialogRequest) : [];

  const bulkRequests: UncBulkPaymentRequest[] = open.map((i) => ({
    id: i.payment_request_id,
    requestNumber: i.request_number,
    supplierId: i.supplier_id,
    supplierName: i.supplier_name,
    remaining: Number(i.remaining_amount || 0),
    createdAt: i.created_at,
  }));

  const itemIds = useMemo(() => items.map((i) => i.payment_request_id), [items]);
  const { data: receipts } = useSubmissionReceipts(itemIds);
  const receiptById = useMemo(() => new Map((receipts ?? []).map((r) => [r.id, r])), [receipts]);
  const flagEntityIds = useMemo(
    () => [...new Set([...itemIds, ...(receipts ?? []).map((r) => r.purchase_order_id).filter((v): v is string => !!v)])],
    [itemIds, receipts],
  );
  const { data: flags } = useFinanceReconciliationFlags({ entityIds: flagEntityIds, enabled: flagEntityIds.length > 0 && !!receipts });
  const flagsFor = (requestId: string) => {
    const poId = receiptById.get(requestId)?.purchase_order_id;
    return sortFlags((flags ?? []).filter((f) => isOpenFlag(f) && (f.entity_id === requestId || (poId && f.entity_id === poId))));
  };

  const togglePick = (requestId: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(requestId)) next.delete(requestId);
      else next.add(requestId);
      return next;
    });

  return (
    <div className="d3-ps min-w-0 pb-24" data-bmq-payment-submission>
      <Link to="/payment-requests" className="d3-ps-back"><ChevronLeft className="h-4 w-4" /> Duyệt chi</Link>

      {isLoading ? (
        <p className="d3-up-state"><Loader2 className="h-4 w-4 animate-spin" /> Đang tải phiếu trình chi…</p>
      ) : isError || !data ? (
        <p className="d3-up-state is-bad" role="alert" data-bmq-submission-error>
          <TriangleAlert className="h-4 w-4" />
          {isError ? "Không tải được phiếu trình chi, hoặc anh/chị chưa có quyền xem." : "Không tìm thấy phiếu trình chi."}{" "}
          {isError && <button type="button" onClick={() => refetch()}>Thử lại</button>}
        </p>
      ) : (
        <>
          <header className="d3-ps-head">
            <span className="d3-up-tag">Trình chi gấp · {dmyhm(data.created_at)}</span>
            <h1>{data.submission_number}</h1>
            {data.note && <p className="d3-ps-note">{data.note}</p>}
          </header>

          <section className="d3-ps-hero">
            <div>
              <span>Còn phải chi</span>
              <b data-bmq-submission-remaining>{vnd(remainingTotal)}</b>
            </div>
            <div>
              <span>Đã chi</span>
              <b>{paidCount}/{items.length} phiếu</b>
            </div>
            <div>
              <span>Tổng lúc trình</span>
              <b>{vnd(data.total_amount)}</b>
            </div>
          </section>

          {isOwner && open.length > 0 && (
            <button type="button" className="d3-ps-bulk" onClick={() => setBulkOpen(true)} data-bmq-submission-bulk-unc>
              <i><Images className="h-5 w-5" /></i>
              <span>
                <b>Up nhiều UNC một lần</b>
                <small>Hệ thống đọc và ghép vào từng phiếu, anh xem lại rồi mới chi</small>
              </span>
              <ChevronRight className="h-5 w-5" />
            </button>
          )}

          <ul className="d3-ps-rows">
            {items.map((item) => {
              const paid = isPaid(item);
              const partial = !paid && Number(item.allocated_amount) > 0;
              return (
                <li key={item.payment_request_id} className={cn("d3-ps-row", paid && "is-paid")} data-bmq-submission-row={item.request_number}>
                  {isOwner && !paid && (
                    <Checkbox
                      checked={picked.has(item.payment_request_id)}
                      onCheckedChange={() => togglePick(item.payment_request_id)}
                      aria-label={`Chọn ${item.request_number}`}
                    />
                  )}
                  <button type="button" className="d3-ps-open" onClick={() => setOpenRequest(item.payment_request_id)}>
                    <span className="d3-up-who">
                      <b>{item.supplier_name || "Chưa có nhà cung cấp"}</b>
                      <small>{item.request_number} · {item.title}</small>
                    </span>
                    <span className="d3-up-amt">
                      {new Intl.NumberFormat("vi-VN").format(Math.round(Number(paid ? item.remaining_at_submit : item.remaining_amount)))}
                      <small>đ</small>
                    </span>
                    <span className="d3-up-meta">
                      {paid ? (
                        <span className="d3-up-chip is-green">Đã chi</span>
                      ) : partial ? (
                        <span className="d3-up-chip is-blue">Đã trả một phần · còn {vnd(item.remaining_amount)}</span>
                      ) : (
                        <span className="d3-up-chip is-red">Chưa chi</span>
                      )}
                      {item.status === "pending" && !paid && <span className="d3-up-chip is-amber">Chờ duyệt</span>}
                      {(() => {
                        const rc = receiptById.get(item.payment_request_id);
                        if (!rc) return null;
                        const gr = rc.goods_receipts;
                        return gr?.receipt_number ? (
                          <span className="d3-up-chip is-green" data-bmq-submission-receipt="in">
                            Đã nhập kho {gr.receipt_number}{gr.receipt_date ? ` · ${ddmm(gr.receipt_date)}` : ""}
                          </span>
                        ) : item.requires_receipt ? (
                          <span className="d3-up-chip" data-bmq-submission-receipt="none">Chưa nhập kho</span>
                        ) : null;
                      })()}
                      {flagsFor(item.payment_request_id).map((f) => (
                        <span key={f.flag_key} className={cn("d3-up-chip", f.priority === "critical" ? "is-ink" : f.priority === "high" ? "is-red" : "is-amber")} data-bmq-submission-flag={f.label}>
                          {financeReconciliationLabel(f.label)}
                        </span>
                      ))}
                    </span>
                  </button>
                  {isOwner && !paid && (
                    <div className="d3-ps-acts">
                      <Button size="sm" className="d3-ps-unc" onClick={() => setPayWith({ method: "bank_transfer", ids: [item.payment_request_id] })} data-bmq-submission-pay-unc>
                        <CreditCard className="h-4 w-4" /> Chi UNC
                      </Button>
                      <Button size="sm" variant="outline" className="d3-ps-cash" onClick={() => setPayWith({ method: "cash", ids: [item.payment_request_id] })} data-bmq-submission-pay-cash>
                        <Banknote className="h-4 w-4" /> Tiền mặt
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {!isOwner && open.length > 0 && <p className="d3-up-state">Chỉ CEO (chủ) ghi chi trên phiếu này.</p>}
          {open.length === 0 && items.length > 0 && <p className="d3-up-state" data-bmq-submission-done>Đã chi hết các phiếu trong đợt trình này.</p>}

          {isOwner && picked.size > 0 && (
            <div className="d3-up-bar" data-bmq-submission-bar>
              <span>Đã chọn <b>{picked.size}</b> phiếu</span>
              <div>
                <Button variant="ghost" onClick={() => setPicked(new Set())}>Bỏ chọn</Button>
                <Button variant="outline" className="d3-ps-cash" onClick={() => setPayWith({ method: "cash", ids: Array.from(picked) })} data-bmq-submission-multi-cash>
                  <Banknote className="h-4 w-4" /> Tiền mặt
                </Button>
                <Button className="d3-up-go" onClick={() => setPayWith({ method: "bank_transfer", ids: Array.from(picked) })} data-bmq-submission-multi-unc>
                  <CreditCard className="h-4 w-4" /> Chi UNC ({picked.size})
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <UncApprovalDialog
        open={!!payWith}
        onOpenChange={(o) => !o && setPayWith(null)}
        mode="approve"
        requests={dialogRequests}
        paymentMethod={payWith?.method ?? "bank_transfer"}
        onDone={() => {
          setPicked(new Set());
          void refetch();
        }}
      />
      <UncBulkDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        requests={bulkRequests}
        onDone={() => {
          setPicked(new Set());
          void refetch();
        }}
      />
      <PaymentRequestDetailsDialog
        requestId={openRequest}
        open={!!openRequest}
        onOpenChange={(o) => !o && setOpenRequest(null)}
        onSelectRequest={setOpenRequest}
      />
    </div>
  );
}
