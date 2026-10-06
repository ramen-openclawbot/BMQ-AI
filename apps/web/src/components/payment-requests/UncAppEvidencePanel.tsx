/* CEO khai báo: UNC đã ghi trong app cho ngày đang xem (duyệt chi bằng UNC +
 * UNC không có đề nghị chi). Owner only; the RPC refuses everyone else.
 */
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUncEvidenceDayTotal } from "@/hooks/usePaymentUncApproval";
import { UncApprovalDialog } from "./UncApprovalDialog";
import "@/styles/bmq-unc-approval.css";

const vnd = (value: number) => `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đ`;

type Props = {
  /** Vietnam calendar day, yyyy-MM-dd. */
  date: string;
  declaredTotal: number;
  disabled?: boolean;
  onUseTotal: (total: number) => void;
};

export function UncAppEvidencePanel({ date, declaredTotal, disabled, onUseTotal }: Props) {
  const [showDialog, setShowDialog] = useState(false);
  const { data, isLoading, isError } = useUncEvidenceDayTotal(date);
  const total = data?.total ?? 0;
  const count = data?.count ?? 0;
  const differs = Math.round(total) !== Math.round(declaredTotal || 0);

  return (
    <div className="d3-unc-app" data-bmq-unc-app>
      <div className="d3-unc-app-row">
        <span>UNC đã ghi trong app{count ? ` · ${count} phiếu` : ""}</span>
        <b data-bmq-unc-app-total>{isLoading ? "…" : isError ? "Không tải được" : vnd(total)}</b>
      </div>
      <div className="d3-unc-app-btns">
        {count > 0 && differs && (
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onUseTotal(total)} data-bmq-unc-app-use>
            Dùng số này
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" className="gap-1" disabled={disabled} onClick={() => setShowDialog(true)} data-bmq-unc-app-add>
          <Plus className="h-3.5 w-3.5" /> UNC không có đề nghị chi
        </Button>
      </div>
      <UncApprovalDialog open={showDialog} onOpenChange={setShowDialog} mode="standalone" />
    </div>
  );
}
