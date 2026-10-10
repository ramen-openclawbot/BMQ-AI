/* Nộp chứng từ chi lẻ (link from the Zalo "Tạm ứng tiền mặt" notice): the staff member who
 * received the cash uploads every small receipt; the app matches them to the khoản approved
 * earlier and marks the phiếu "Hoàn tất chi tiền mặt" when all are covered.
 */
import { Link, useParams } from "react-router-dom";
import { ChevronLeft, Loader2, TriangleAlert } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useCashSettlement } from "@/hooks/useCashSettlement";
import { CashSettlementPanel } from "@/components/payment-requests/CashSettlementPanel";
import { PaymentUncEvidenceSection } from "@/components/payment-requests/PaymentUncEvidenceSection";
import { PaymentRequestAttachmentsStrip } from "@/components/payment-requests/PaymentRequestAttachmentsStrip";
import "@/styles/bmq-urgent-payables.css";
import "@/styles/bmq-cash-settlement.css";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const vnd = (value: number | null | undefined) => `${new Intl.NumberFormat("vi-VN").format(Math.round(Number(value ?? 0)))} đ`;

export default function CashSettlement() {
  const { id } = useParams<{ id: string }>();
  const requestId = id && UUID_RE.test(id) ? id : null;
  const { user, isOwner, canEditModule } = useAuth();
  const { data, isLoading, error } = useCashSettlement(requestId);
  const pr = data?.payment_request;
  const canEdit = !!pr && (isOwner || canEditModule("payment_requests") || pr.created_by === user?.id);

  return (
    <div className="d3-ps d3-csp min-w-0 pb-24" data-bmq-cash-settle-page>
      <Link to="/payment-requests" className="d3-ps-back"><ChevronLeft className="h-4 w-4" /> Duyệt chi</Link>
      {!requestId ? (
        <p className="d3-up-state is-bad" role="alert"><TriangleAlert className="h-4 w-4" /> Link không hợp lệ.</p>
      ) : isLoading ? (
        <p className="d3-up-state"><Loader2 className="h-4 w-4 animate-spin" /> Đang tải phiếu…</p>
      ) : error || !pr ? (
        <p className="d3-up-state is-bad" role="alert" data-bmq-cash-settle-page-error>
          <TriangleAlert className="h-4 w-4" /> Không tải được phiếu, hoặc anh/chị chưa có quyền xem.
        </p>
      ) : (
        <>
          <header className="d3-csp-head">
            <span className="d3-up-tag">Chi tiền mặt · nộp chứng từ chi lẻ</span>
            <h1>{pr.request_number}</h1>
            <p>
              {pr.title}
              {pr.requester_name ? ` · ${pr.requester_name}` : ""} · <b>{vnd(pr.total_amount)}</b>
            </p>
          </header>
          {pr.payment_method !== "cash" || !pr.cash_settlement_status ? (
            <p className="d3-up-state" data-bmq-cash-settle-not-ready>
              {pr.payment_method !== "cash"
                ? "Phiếu này không chi bằng tiền mặt."
                : "CEO chưa chuyển tiền cho phiếu này. Khi CEO bấm chi, nhóm Zalo sẽ nhận link nộp chứng từ."}
            </p>
          ) : (
            <>
              <div className="d3-csp-card">
                <CashSettlementPanel requestId={pr.id} canEdit={canEdit} />
              </div>
              <div className="d3-csp-card">
                <PaymentUncEvidenceSection requestId={pr.id} enabled title="CEO chuyển tiền cho nhân viên" />
              </div>
              <PaymentRequestAttachmentsStrip requestId={pr.id} className="d3-csp-card" />
            </>
          )}
        </>
      )}
    </div>
  );
}
