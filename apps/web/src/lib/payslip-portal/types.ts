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

// ---------------------------------------------------------------------------
// Monthly missions + surprise gifts (Bếp Q7) — non-visual client contract
// ---------------------------------------------------------------------------

export type PayrollMissionStatus = "pending" | "accepted" | "declined";
export type PayrollMissionDecision = "accept" | "decline";
export type PayrollMissionItemKind =
  | "attendance_regular"
  | "punctual"
  | "draw_ticket"
  | "manual";

export interface PayrollMissionItem {
  key: string;
  label: string;
  detail: string | null;
  kind: PayrollMissionItemKind;
  amountVnd: number;
}

export interface PayrollMissionCampaign {
  title: string;
  summary: string | null;
  startsOn: string;
  endsOn: string;
  items: PayrollMissionItem[];
  rules: string[];
  draw: Record<string, unknown> | null;
}

export interface PayrollMissionProgressDetail {
  daysWithIn: number;
  daysComplete: number;
  daysMissingOut: number;
  onTimeDays: number;
  minDays: number;
  graceMinutes: number;
  cutoff: string;
  windowFrom: string;
  windowTo: string;
}

export interface PayrollMissionProgressItem {
  key: string;
  kind: PayrollMissionItemKind;
  met: boolean;
  detail: PayrollMissionProgressDetail;
}

export interface PayrollMissionEarnedItem {
  key: string;
  amountVnd: number;
}

export interface PayrollMissionReview {
  earned: PayrollMissionEarnedItem[];
  disqualified: boolean;
}

export interface PayrollMissionTicket {
  quarter: string;
  issuedAt: string;
  voidReason: string | null;
}

export interface PayrollMissionOffer {
  id: string;
  status: PayrollMissionStatus;
  campaign: PayrollMissionCampaign;
  progress: PayrollMissionProgressItem[];
  review: PayrollMissionReview | null;
  ticket: PayrollMissionTicket | null;
}

export interface PayrollMissionSource {
  /** The employee's current offer, or null when no active campaign is open. */
  getMission(): Promise<PayrollMissionOffer | null>;
  /** Accept/decline the employee's own pending offer (server is idempotent). */
  respondMission(
    offerId: string,
    decision: PayrollMissionDecision,
  ): Promise<PayrollMissionOffer | null>;
}

// ---------------------------------------------------------------------------
// Weekly Bếp bánh shift registration (giai đoạn 1)
// ---------------------------------------------------------------------------

export type PayrollShiftState = "registered" | "waitlist";
export type PayrollShiftSourceType = "employee" | "manager" | "carried";
export type PayrollShiftWeekStatus = "open" | "published";

export interface PayrollShiftType {
  code: string;
  label: string | null;
  startTime: string;
  endTime: string | null;
  sort: number;
  active: boolean;
}

export interface PayrollShiftMyEntry {
  shiftCode: string | null;
  state: PayrollShiftState;
  source: PayrollShiftSourceType;
  previousShiftCode: string | null;
}

export interface PayrollShiftCoverageCell {
  code: string;
  registered: number;
  needed: number;
  full: boolean;
  needMore: boolean;
}

export interface PayrollShiftQuotaGroupCell {
  quotaGroup: string;
  registered: number;
  needed: number;
  full: boolean;
}

export interface PayrollShiftDay {
  workDate: string;
  closed: boolean;
  my: PayrollShiftMyEntry | null;
  shifts: PayrollShiftCoverageCell[];
  quotaGroups: PayrollShiftQuotaGroupCell[];
  offCount: number;
  offFull: boolean;
  totalStaff: number;
}

export interface PayrollShiftSuggestion {
  workDate: string;
  shiftCode: string | null;
  state: PayrollShiftState;
  carried: boolean;
}

export interface PayrollShiftCurrentEntry {
  workDate: string;
  shiftCode: string | null;
  state: PayrollShiftState;
  source: PayrollShiftSourceType;
}

export interface PayrollShiftWeekInfo {
  weekStart: string;
  status: PayrollShiftWeekStatus;
  opensAt: string | null;
  deadline: string | null;
  canEdit: boolean;
  closedDates: string[];
}

export interface PayrollShiftWeek {
  eligible: boolean;
  week: PayrollShiftWeekInfo;
  shiftTypes: PayrollShiftType[];
  days: PayrollShiftDay[];
  suggestion: PayrollShiftSuggestion[];
  currentWeek: PayrollShiftCurrentEntry[];
}

export interface PayrollShiftRegistrationEntry {
  workDate: string;
  shiftCode: string | null;
}

export interface PayrollShiftSource {
  /** The employee's own target week (defaults to next week on the server). */
  getShiftWeek(weekStart?: string): Promise<PayrollShiftWeek>;
  /** Replace this employee's week choices (server is idempotent until deadline). */
  submitShiftRegistration(
    weekStart: string | null | undefined,
    entries: PayrollShiftRegistrationEntry[],
  ): Promise<PayrollShiftWeek>;
}
