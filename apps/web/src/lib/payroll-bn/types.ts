// Shared domain types for the Bếp BN payroll module (GĐ1, no UI).
//
// Kept framework-free and dependency-free (except money's Rational) so the
// parser, anomaly detector, engine and reconciler can be unit-tested with
// node:test without any Supabase/React runtime.
//
// The engine accepts per-employee figures for the period:
//   * employment type  — official (chính thức) or part_time
//   * group            — Văn phòng, Bếp bánh or Kho BN
//   * monthly salary, hourly rate, allowance, start/end date, terminated flag
//   * actual work days / part-time hours / overtime hours, each with a source
// Every quantity can either be entered directly from the payroll sheet
// (`manual`) or derived from the attendance rows (`attendance`).

import type { Rational } from "./money.ts";
import type { RulesConfig } from "./rules-config.ts";

export type PayrollPeriodStatus = "draft" | "locked";

export interface PayrollPeriod {
  code: string;
  name: string;
  /** Inclusive ISO dates (YYYY-MM-DD). */
  dateFrom: string;
  dateTo: string;
  /** R2 — standard work days per group. */
  standardDaysByGroup: Record<string, number>;
  /** R2 — fallback standard work days when the group is absent. */
  defaultStandardDays: number;
  /** R9 — paid holiday dates in the period. */
  holidays: string[];
  rules: RulesConfig;
  status: PayrollPeriodStatus;
}

/** The three Bếp BN groups the payroll is split into. */
export type PayrollGroup = "Văn phòng" | "Bếp bánh" | "Kho BN";

export type EmploymentType = "official" | "part_time";

/** Where a per-employee quantity came from. */
export type MeasureSource = "manual" | "attendance";

export interface SourcedQuantity {
  value: number;
  source: MeasureSource;
}

/** Direct payroll-sheet figures for one employee (mode a). */
export interface PayrollEmployeeMeasures {
  actualWorkDays?: SourcedQuantity;
  partTimeHours?: SourcedQuantity;
  overtimeHours?: SourcedQuantity;
}

export interface PayrollEmployee {
  code: string;
  name: string;
  group: PayrollGroup;
  employmentType: EmploymentType;
  /** Lương chính thức (monthly salary in VND). */
  monthlySalary?: number | null;
  /** Đơn giá giờ (hourly rate in VND) for part-time pay. */
  hourlyRate?: number | null;
  /** Phụ cấp (fixed allowance in VND), added to gross pay. */
  allowance?: number | null;
  /** R3 — overtime hourly rate; missing/0 means overtime is worth 0. */
  overtimeRate?: number | null;
  /** R2/R7 — manual standard/work days override for the employee. */
  standardDaysOverride?: number | null;
  /** R9 — first working date (YYYY-MM-DD); holidays before it are not paid. */
  startDate?: string | null;
  /** R9 — last working date (YYYY-MM-DD); holidays after it are not paid. */
  endDate?: string | null;
  /** R9 — a terminated employee keeps an empty row (no holiday, no pay). */
  terminated?: boolean;
}

export interface AttendanceRow {
  employeeCode: string;
  employeeName: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Normalised HH:MM:SS, or null when the machine has no value. */
  checkIn: string | null;
  checkOut: string | null;
  department: string | null;
}

export type AdjustmentField =
  | "work_days"
  | "paid_work_days"
  | "part_time_hours"
  | "overtime_hours"
  | "exclude_overtime"
  | "exclude_holiday"
  | "net_pay";

export interface PayrollAdjustment {
  employeeCode: string;
  field: AdjustmentField;
  value?: number | string | null;
  reason: string;
  actor: string;
  at: string;
  oldValue?: number | string | null;
}

export interface PayrollLineBase {
  standardDays: Rational;
  /** R9 — NC thực tế before holidays. */
  actualWorkDays: Rational;
  /** R9 — holidays added to the payable day count. */
  holidayPayDays: Rational;
  /** R9 — NC tính lương = NC thực tế + ngày lễ được cộng. */
  workDays: Rational;
  /** R8 — part-time hours tracked separately from days. */
  partTimeHours: Rational;
  /** R3 — overtime hours tracked separately. */
  overtimeHours: Rational;
  overtimeAppliedHours: Rational;
  /** R1 — lương ngày công = lương chính thức × NC tính lương / NC chuẩn. */
  dayPay: Rational;
  /** R4 — part-time pay = part-time hours × hourly rate. */
  partTimePay: Rational;
  /** R3 — overtime actually paid = applied hours × rate (0 without a rate). */
  overtimePay: Rational;
  /** Overtime computed but not paid (excluded / reconcile-only, Q3). */
  overtimePayReconciled: Rational;
  /** Phụ cấp. */
  allowance: Rational;
  grossPay: Rational;
  netPay: Rational;
  /** R5 — final rounded amount in whole đồng. */
  netPayRounded: bigint;
  flags: string[];
}

export interface PayrollEmployeeLine extends PayrollLineBase {
  kind: "employee";
  employeeCode: string;
  employeeName: string;
  group: PayrollGroup;
  employmentType: EmploymentType;
  /**
   * 2026-10-09 — attendance dates credited below one full công under the
   * short-shift rule, with the exact credit. Only filled when NC thực tế comes
   * from attendance; manual measures, office defaults, part-time and terminated
   * rows keep it empty. Never affects any computed amount.
   */
  shortShiftDays: Array<{ date: string; credit: 0 | 0.5 }>;
}

export interface PayrollGroupLine extends PayrollLineBase {
  kind: "group";
  employeeCode: null;
  employeeName: null;
  group: PayrollGroup;
  employeeCount: number;
}

export interface PayrollTotalLine extends PayrollLineBase {
  kind: "total";
  employeeCode: null;
  employeeName: null;
  group: null;
  employeeCount: number;
}

export type PayrollLine = PayrollEmployeeLine | PayrollGroupLine | PayrollTotalLine;

export interface PayrollResult {
  periodCode: string;
  lines: PayrollLine[];
  employees: PayrollEmployeeLine[];
  groups: PayrollGroupLine[];
  total: PayrollTotalLine;
  warnings: string[];
}
