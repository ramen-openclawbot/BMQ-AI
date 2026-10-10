/* Chi lương: its own entry next to Chi tiền mặt, shown only to the owner and quyền Chi lương.
 * Lương bếp Q7 (from payroll) or Lương lẻ (typed list); the header follows the chosen kind.
 */
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SalaryPayoutCreate, type SalaryKind } from "@/components/payment-requests/SalaryPayoutCreate";
import "@/styles/bmq-unc-approval.css";
import "@/styles/bmq-unc-bulk.css";
import "@/styles/bmq-cash-settlement.css";

const HEAD: Record<SalaryKind, { title: string; sub: string }> = {
  q7: {
    title: "Tạo phiếu lương bếp Q7",
    sub: "Lấy lương thực nhận từ bảng lương Q7. CEO chuyển tiền cho kế toán, kế toán nộp bank slip từng nhân viên.",
  },
  manual: {
    title: "Tạo phiếu lương lẻ",
    sub: "Cho nhân viên BMQ ngoài bếp Q7: nhập tên và số tiền từng người. CEO chuyển tiền cho kế toán, kế toán nộp bank slip từng nhân viên.",
  },
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SalaryPayoutDialog({ open, onOpenChange }: Props) {
  const [kind, setKind] = useState<SalaryKind>("q7");

  const close = (next: boolean) => {
    if (!next) setKind("q7");
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="d3-unc d3-ub d3-cpr"
        data-bmq-salary-dialog
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <DialogHeader className="d3-unc-head text-left sm:text-left">
          <span className="d3-unc-tag">Chi lương</span>
          <DialogTitle className="d3-unc-title">{HEAD[kind].title}</DialogTitle>
          <DialogDescription className="d3-unc-sub">{HEAD[kind].sub}</DialogDescription>
        </DialogHeader>
        <SalaryPayoutCreate kind={kind} onKindChange={setKind} onDone={() => close(false)} />
      </DialogContent>
    </Dialog>
  );
}
