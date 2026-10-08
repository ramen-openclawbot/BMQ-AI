import { useAuth } from "@/contexts/AuthContext";
import { BepBnPayrollPanel } from "@/components/payroll/bep-bn/BepBnPayrollPanel";
import { useBepBnData } from "@/hooks/useBepBnData";

/** Payroll page: upload attendance → resolve issues → approve → payroll → export. */
export default function BepBnPayroll() {
  const { canEditModule, isOwner } = useAuth();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Bảng lương</h1>
        <p className="text-muted-foreground">
          Upload chấm công, xử lý vấn đề, duyệt, rồi xuất bảng lương Excel hoặc PDF.
        </p>
      </div>
      <BepBnPayrollPanel useData={useBepBnData} canEdit={canEditModule("payroll")} canLock={isOwner} />
    </div>
  );
}
