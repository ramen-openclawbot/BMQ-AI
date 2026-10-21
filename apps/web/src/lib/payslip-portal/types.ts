/**
 * Shapes shown by the employee payslip portal (payroll.banhmique.vn).
 * The portal only renders published payslips of locked periods; it never
 * computes salary itself.
 */

export type PayslipLineUnit = "vnd" | "day" | "hour";

export interface PayslipLine {
  key: string;
  label: string;
  value: number;
  unit: PayslipLineUnit;
}

export interface PayslipEmployee {
  code: string;
  name: string;
  groupName: string | null;
}

export interface Payslip {
  periodId: string;
  periodName: string;
  dateFrom: string | null;
  dateTo: string | null;
  publishedAt: string;
  employeeCode: string;
  employeeName: string;
  netPay: number;
  lines: PayslipLine[];
  note?: string | null;
}

export interface PayslipPortalSource {
  /** Always resolves with a generic message, whether or not the phone is registered. */
  startOtp(phone: string): Promise<{ message: string }>;
  verifyOtp(phone: string, otp: string): Promise<void>;
  /** Returns the signed-in employee, or null when there is no valid session. */
  restoreSession(): Promise<PayslipEmployee | null>;
  listPayslips(): Promise<{ employee: PayslipEmployee; payslips: Payslip[] }>;
  logout(): Promise<void>;
}

export class PayslipSessionExpiredError extends Error {
  constructor() {
    super("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
    this.name = "PayslipSessionExpiredError";
  }
}
