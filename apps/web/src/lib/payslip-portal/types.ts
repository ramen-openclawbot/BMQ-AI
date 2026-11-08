/**
 * Shapes shown by the employee payslip portal (luong.banhmique.vn, with the
 * legacy payroll.banhmique.vn host kept as a redirect/fallback).
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

// ---------------------------------------------------------------------------
// GPS attendance (Bếp Q7) — non-visual client contract
// ---------------------------------------------------------------------------

export type AttendanceEventKind = "in" | "out";
export type AttendanceDecision = "accepted" | "rejected";
export type AttendanceDayStatus = "complete" | "missing_in" | "missing_out" | "approved_override";

export interface PayrollAttendanceEvent {
  eventKind: AttendanceEventKind;
  decision: AttendanceDecision;
  reasonCode: string | null;
  message: string;
  workDate: string;
  serverReceivedAt: string;
  distanceM: number | null;
  suspectedProxy: boolean;
}

export interface PayrollAttendanceDaySummary {
  workDate: string;
  status: AttendanceDayStatus;
  message: string;
}

export interface PayrollAttendanceConsentState {
  requiredVersion: string;
  accepted: boolean;
  acceptedAt: string | null;
  withdrawnAt: string | null;
}

export interface PayrollAttendanceTodayPayload {
  employee: { code: string; name?: string | null };
  gateEnabled: boolean;
  siteConfigured: boolean;
  siteName: string | null;
  siteRadiusM: number | null;
  today: {
    workDate: string;
    status: AttendanceDayStatus;
    message: string;
    events: PayrollAttendanceEvent[];
    consent: PayrollAttendanceConsentState;
  };
  incompleteDays: PayrollAttendanceDaySummary[];
}

export interface PayrollAttendanceCheckinInput {
  kind: AttendanceEventKind;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  capturedAt: string;
  selfie: Blob;
  selfieFileName?: string;
}

export interface PayrollAttendanceCheckinResult {
  decision: AttendanceDecision;
  reasonCode: string | null;
  message: string;
  suspectedProxy: boolean;
  workDate: string | null;
  distanceM: number | null;
  eventId: string | null;
}

export interface PayrollAttendanceSource {
  getToday(): Promise<PayrollAttendanceTodayPayload>;
  checkIn(input: PayrollAttendanceCheckinInput): Promise<PayrollAttendanceCheckinResult>;
  acceptConsent(version: string): Promise<PayrollAttendanceConsentState>;
  withdrawConsent(): Promise<PayrollAttendanceConsentState>;
}
