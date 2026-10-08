import { useMemo } from "react";
import PayslipPortal from "@/pages/PayslipPortal";
import { createPayslipApiSource } from "@/lib/payslip-portal/api";

/** payroll.banhmique.vn: the employee payslip portal against the live Edge Functions. */
export default function PayslipPortalHost() {
  const source = useMemo(() => createPayslipApiSource(), []);
  return <PayslipPortal source={source} />;
}
