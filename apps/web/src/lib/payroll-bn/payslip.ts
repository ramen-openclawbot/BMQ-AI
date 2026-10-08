// Pure builder for the published employee payslips of one Bếp BN period.
//
// The payslip reuses exactly what the engine already computed: it never
// recalculates salary, it only re-formats the existing PayrollEmployeeLine
// fields into the lines the portal contract (src/lib/payslip-portal/types.ts)
// renders. Net pay is the same rounded 'Thực nhận' the Excel/PDF export writes,
// and the note comes from the same adjustment reasons as the export's 'Ghi chú'.
//
// Framework-free: no React, no Supabase, no logging of money.

import { mulRational, rational, roundHalfUpToStep, type Rational } from "./money.ts";
import type { PayrollEmployee, PayrollPeriod, PayrollResult } from "./types.ts";
import type { PayslipLine, PayslipLineUnit } from "../payslip-portal/types.ts";

/** The snake_case row shape inserted by payroll_bn_publish_payslips. */
export interface PayslipRecord {
  employee_code: string;
  employee_name: string;
  group_name: string | null;
  period_name: string;
  date_from: string | null;
  date_to: string | null;
  net_pay: number;
  note: string | null;
  lines: PayslipLine[];
}

/** Exact rational → number with at most 2 decimals (half up), for display only. */
function cents(value: Rational): number {
  return Number(roundHalfUpToStep(mulRational(value, rational(100)), 1n)) / 100;
}

function line(key: string, label: string, value: number, unit: PayslipLineUnit): PayslipLine {
  return { key, label, value, unit };
}

/** Same rule as export.ts: adjustment reasons joined, else the terminated note. */
function noteFor(
  employeeCode: string,
  flags: readonly string[],
  notes: ReadonlyMap<string, string[]>,
): string | null {
  const joined = notes.get(employeeCode)?.join("; ");
  if (joined && joined.trim() !== "") return joined;
  return flags.includes("terminated") ? "Nghỉ việc trong kỳ" : null;
}

/**
 * One payslip per employee line of the result, in the same order. Only part-time
 * employees get the part-time hours / part-time pay lines.
 */
export function buildPayslips(
  period: PayrollPeriod,
  employees: readonly PayrollEmployee[],
  result: PayrollResult,
  notes: ReadonlyMap<string, string[]> = new Map(),
): PayslipRecord[] {
  const groupByCode = new Map(employees.map((employee) => [employee.code, employee.group]));

  return result.employees.map((employeeLine) => {
    const partTime = employeeLine.employmentType === "part_time";
    const lines: PayslipLine[] = [
      line("standard_days", "Ngày công chuẩn", cents(employeeLine.standardDays), "day"),
      line("actual_work_days", "Ngày công thực tế", cents(employeeLine.actualWorkDays), "day"),
      line("holiday_pay_days", "Ngày lễ hưởng lương", cents(employeeLine.holidayPayDays), "day"),
      line("work_days", "Ngày công tính lương", cents(employeeLine.workDays), "day"),
    ];
    if (partTime) {
      lines.push(line("part_time_hours", "Giờ part-time", cents(employeeLine.partTimeHours), "hour"));
    }
    lines.push(line("overtime_hours", "Giờ tăng ca", cents(employeeLine.overtimeHours), "hour"));
    lines.push(line("day_pay", "Lương ngày công", cents(employeeLine.dayPay), "vnd"));
    if (partTime) {
      lines.push(line("part_time_pay", "Lương part-time", cents(employeeLine.partTimePay), "vnd"));
    }
    lines.push(
      line("overtime_pay", "Lương tăng ca", cents(employeeLine.overtimePay), "vnd"),
      line("allowance", "Phụ cấp", cents(employeeLine.allowance), "vnd"),
      line("gross_pay", "Tổng thu nhập", cents(employeeLine.grossPay), "vnd"),
    );

    return {
      employee_code: employeeLine.employeeCode,
      employee_name: employeeLine.employeeName,
      group_name: groupByCode.get(employeeLine.employeeCode) ?? employeeLine.group,
      period_name: period.name,
      date_from: period.dateFrom ?? null,
      date_to: period.dateTo ?? null,
      // "Thực nhận" in export.ts is exactly the rounded engine value.
      net_pay: Number(employeeLine.netPayRounded),
      note: noteFor(employeeLine.employeeCode, employeeLine.flags, notes),
      lines,
    };
  });
}

/** The JSON array passed to the payroll_bn_publish_payslips RPC. */
export function toPublishPayload(payslips: readonly PayslipRecord[]): PayslipRecord[] {
  return payslips.map((payslip) => ({
    employee_code: payslip.employee_code,
    employee_name: payslip.employee_name,
    group_name: payslip.group_name,
    period_name: payslip.period_name,
    date_from: payslip.date_from,
    date_to: payslip.date_to,
    net_pay: payslip.net_pay,
    note: payslip.note,
    lines: payslip.lines.map((item) => ({ ...item })),
  }));
}
