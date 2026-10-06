/* "Chứng từ thanh toán" in a payment request: every payment that settled it, the UNC image,
 * how much of the UNC went to this request, and the other requests paid by the same UNC.
 * Read-only. Visible to owner and to users who can view Duyệt chi (enforced server-side).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileImage, Loader2, TriangleAlert } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getUncEvidenceSignedUrl, usePaymentRequestUncEvidence } from "@/hooks/usePaymentRequestUncEvidence";
import type { UncEvidenceDisplayRow } from "@/lib/payment-unc-evidence";
import "@/styles/bmq-unc-approval.css";

const vnd = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đ`;

const dmy = (value: string | null | undefined) => {
  const m = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : value || "—";
};

function UncThumb({ row, onOpen }: { row: UncEvidenceDisplayRow; onOpen: (url: string) => void }) {
  const { data: url, isLoading } = useQuery({
    queryKey: ["unc-evidence-url", row.storagePath],
    queryFn: () => getUncEvidenceSignedUrl(row.storagePath),
    enabled: !!row.storagePath,
    staleTime: 5 * 60 * 1000,
  });
  if (isLoading) {
    return (
      <span className="d3-unc-ev-thumb is-empty" aria-busy="true">
        <Loader2 className="h-4 w-4 animate-spin" />
      </span>
    );
  }
  if (!url) {
    return (
      <span className="d3-unc-ev-thumb is-empty" title="Không mở được ảnh UNC">
        <FileImage className="h-5 w-5" />
      </span>
    );
  }
  return (
    <button type="button" className="d3-unc-ev-thumb" onClick={() => onOpen(url)} aria-label="Xem ảnh UNC" data-bmq-unc-ev-image>
      <img src={url} alt="Ảnh UNC" loading="lazy" />
    </button>
  );
}

type Props = {
  requestId: string | null;
  /** Only worth loading when the request has received a payment. */
  enabled: boolean;
  onSelectRequest?: (requestId: string) => void;
};

export function PaymentUncEvidenceSection({ requestId, enabled, onSelectRequest }: Props) {
  const { data, isLoading, isError } = usePaymentRequestUncEvidence(enabled ? requestId : null);
  const [zoom, setZoom] = useState<string | null>(null);

  if (!enabled) return null;

  return (
    <section className="d3-unc-ev" data-bmq-unc-evidence aria-label="Chứng từ thanh toán">
      <h3>Chứng từ thanh toán</h3>
      {isLoading ? (
        <p className="d3-unc-ev-note">
          <Loader2 className="h-4 w-4 animate-spin" /> Đang tải chứng từ…
        </p>
      ) : isError ? (
        <p className="d3-unc-ev-note is-bad" role="alert" data-bmq-unc-ev-error>
          <TriangleAlert className="h-4 w-4" /> Không tải được chứng từ UNC. Tải lại trang để thử lại.
        </p>
      ) : !data || data.length === 0 ? (
        <p className="d3-unc-ev-note">Chưa có khoản thanh toán nào được ghi cho phiếu này.</p>
      ) : (
        <ul>
          {data.map((row) => (
            <li key={row.paymentId} data-bmq-unc-ev-row={row.paymentNumber}>
              <div className="d3-unc-ev-body">
                <div className="d3-unc-ev-head">
                  <b>{row.paymentNumber}</b>
                  <span>{dmy(row.evidenceTransferDate || row.paymentDate)}</span>
                </div>
                <p className="d3-unc-ev-amount">
                  Trả cho phiếu này <b>{vnd(row.allocatedToRequest)}</b>
                  {row.paymentTotal !== row.allocatedToRequest && <> trên tổng chuyển <b>{vnd(row.paymentTotal)}</b></>}
                </p>
                {row.referenceNumber && <p className="d3-unc-ev-ref">Mã giao dịch: {row.referenceNumber}</p>}
                {row.manualOverride && (
                  <p className="d3-unc-ev-flag">Duyệt tay{row.overrideReason ? `: ${row.overrideReason}` : ""}</p>
                )}
                {!row.hasEvidence && <p className="d3-unc-ev-note">Khoản này chưa có ảnh UNC lưu trong app.</p>}
                {row.siblings.length > 0 && (
                  <div className="d3-unc-ev-sib" data-bmq-unc-ev-siblings>
                    <span>UNC này còn trả cho:</span>
                    <ul>
                      {row.siblings.map((s) => (
                        <li key={s.requestId}>
                          {onSelectRequest ? (
                            <button type="button" onClick={() => onSelectRequest(s.requestId)}>
                              {s.requestNumber}
                            </button>
                          ) : (
                            <span>{s.requestNumber}</span>
                          )}
                          <b>{vnd(s.amount)}</b>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              {row.hasEvidence && <UncThumb row={row} onOpen={setZoom} />}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={!!zoom} onOpenChange={(open) => !open && setZoom(null)}>
        <DialogContent className="d3-unc-ev-zoom">
          <DialogHeader>
            <DialogTitle>Ảnh UNC</DialogTitle>
            <DialogDescription>Chứng từ chuyển khoản đã lưu cùng khoản thanh toán.</DialogDescription>
          </DialogHeader>
          {zoom && <img src={zoom} alt="Ảnh UNC phóng to" />}
        </DialogContent>
      </Dialog>
    </section>
  );
}
