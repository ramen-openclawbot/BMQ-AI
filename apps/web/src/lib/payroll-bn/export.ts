// Excel export of the Bếp BN draft payroll. Amounts are exact rationals in the
// engine; the sheet shows them rounded to 2 decimals (net pay is already whole
// đồng), matching what the draft table displays.

import * as XLSX from "xlsx";

import { addRational, mulRational, rational, roundHalfUpToStep, type Rational } from "./money.ts";
import type { PayrollComparison } from "./compare.ts";
import type { PayrollGroup, PayrollLine, PayrollPeriod, PayrollResult } from "./types.ts";

const GROUP_ORDER: PayrollGroup[] = ["Văn phòng", "Bếp bánh", "Kho BN"];

export const PAYROLL_EXPORT_HEADER = [
  "Mã NV",
  "Họ tên",
  "Loại",
  "NC chuẩn",
  "NC thực tế",
  "Ngày lễ",
  "NC tính lương",
  "Giờ part-time",
  "Giờ TC",
  "Lương ngày công",
  "Lương TC",
  "Phụ cấp",
  "Thưởng nhiệm vụ",
  "Tổng thu nhập",
  "Thực nhận",
  "Ghi chú",
];

/** Exact rational → number with at most 2 decimals (half up), for display only. */
function cents(value: Rational): number {
  return Number(roundHalfUpToStep(mulRational(value, rational(100)), 1n)) / 100;
}

function lineRow(line: PayrollLine, code: string, name: string, type: string, note: string): (string | number)[] {
  const isEmployee = line.kind === "employee";
  const partTime = isEmployee && line.employmentType === "part_time";
  return [
    code,
    name,
    type,
    isEmployee && !partTime ? cents(line.standardDays) : "",
    cents(line.actualWorkDays),
    cents(line.holidayPayDays),
    cents(line.workDays),
    cents(line.partTimeHours),
    cents(line.overtimeHours),
    cents(addRational(line.dayPay, line.partTimePay)),
    cents(line.overtimePay),
    cents(line.allowance),
    cents(line.missionBonus),
    cents(line.grossPay),
    Number(line.netPayRounded),
    note,
  ];
}

/** Rows (header first) in the same order as the draft table: employees, then their group line, then the total. */
export function buildPayrollExportRows(
  period: PayrollPeriod,
  result: PayrollResult,
  notes: ReadonlyMap<string, string[]>,
): (string | number)[][] {
  const status = period.status === "locked" ? "Đã chốt" : "Nháp, chưa chốt";
  const rows: (string | number)[][] = [
    [`Bảng lương ${period.name} (${period.code})`],
    [`Kỳ ${period.dateFrom} → ${period.dateTo} · Trạng thái: ${status}`],
    [],
    PAYROLL_EXPORT_HEADER,
  ];
  for (const group of GROUP_ORDER) {
    const employees = result.employees.filter((line) => line.group === group);
    if (employees.length === 0) continue;
    for (const line of employees) {
      const note = notes.get(line.employeeCode)?.join("; ") ?? (line.flags.includes("terminated") ? "Nghỉ việc trong kỳ" : "");
      rows.push(lineRow(line, line.employeeCode, line.employeeName, line.employmentType === "part_time" ? "Part-time" : "Chính thức", note));
    }
    const summary = result.groups.find((line) => line.group === group);
    if (summary) rows.push(lineRow(summary, "", `Nhóm ${group}`, "", ""));
  }
  rows.push(lineRow(result.total, "", "Tổng cộng", "", ""));
  return rows;
}

/** "+12,3%", "−4,0%", "0,0%" or "—" when there is nothing to compare with. */
export function formatChange(change: number | null): string {
  if (change === null) return "—";
  const text = Math.abs(change).toFixed(1).replace(".", ",");
  if (change > 0) return `+${text}%`;
  if (change < 0) return `−${text}%`;
  return `${text}%`;
}

/** Header of the comparison column, e.g. "± % so T09.2026". */
export function changeColumnHeader(previousPeriodCode: string | null): string {
  return previousPeriodCode ? `± % so ${previousPeriodCode}` : "± % so kỳ trước";
}

/**
 * Insert the "± % so kỳ trước" column just before "Ghi chú" (net pay vs the
 * previous period). Employee rows are matched by code, group rows by their
 * "Nhóm …" label and the total by "Tổng cộng". Title rows are left as is.
 */
export function withChangeColumn(
  rows: (string | number)[][],
  comparison: PayrollComparison,
  previousPeriodCode: string | null,
): (string | number)[][] {
  const noteIndex = PAYROLL_EXPORT_HEADER.indexOf("Ghi chú");
  const headerIndex = rows.findIndex((row) => row[0] === PAYROLL_EXPORT_HEADER[0]);
  if (headerIndex < 0) return rows;
  return rows.map((row, index) => {
    if (index < headerIndex) return row;
    let cell: string;
    if (index === headerIndex) {
      cell = changeColumnHeader(previousPeriodCode);
    } else {
      const code = row[0];
      const label = String(row[1] ?? "");
      const change =
        typeof code === "string" && code !== ""
          ? comparison.byEmployee.get(code) ?? null
          : label === "Tổng cộng"
            ? comparison.total
            : label.startsWith("Nhóm ")
              ? comparison.byGroup.get(label.slice(5)) ?? null
              : null;
      cell = formatChange(change);
    }
    return [...row.slice(0, noteIndex), cell, ...row.slice(noteIndex)];
  });
}

export function payrollExportFileName(period: PayrollPeriod): string {
  const suffix = period.status === "locked" ? "da-chot" : "nhap";
  return `bang-luong-bep-bn-${period.code.replace(/[^A-Za-z0-9.-]+/g, "-")}-${suffix}.xlsx`;
}

/** Builds the workbook bytes; the caller decides how to download them. */
export function buildPayrollWorkbook(rows: (string | number)[][]): ArrayBuffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const header = rows.find((row) => row[0] === PAYROLL_EXPORT_HEADER[0]) ?? PAYROLL_EXPORT_HEADER;
  const noteIndex = header.indexOf("Ghi chú");
  sheet["!cols"] = header.map((_, index) => ({ wch: index === 1 ? 26 : index === noteIndex ? 40 : 14 }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Bang luong");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}
