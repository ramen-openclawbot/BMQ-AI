import { useMemo } from "react";
import PayslipPortal from "@/pages/PayslipPortal";
import { createPayslipApiSource } from "@/lib/payslip-portal/api";
import { createPayrollAttendanceApi } from "@/lib/payslip-portal/attendance-api";
import { createPayrollMissionApi } from "@/lib/payslip-portal/mission-api";

/** luong.banhmique.vn: the employee payslip + attendance portal against the live Edge Functions. */
export default function PayslipPortalHost() {
  const source = useMemo(() => createPayslipApiSource(), []);
  const attendance = useMemo(() => createPayrollAttendanceApi(), []);
  const missions = useMemo(() => createPayrollMissionApi(), []);
  return <PayslipPortal source={source} attendance={attendance} missions={missions} />;
}
