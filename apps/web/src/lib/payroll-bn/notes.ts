// Shared "Ghi chú" builder for the Bếp BN payroll (2026-10-09).
//
// One pure function feeds the draft table, the Excel/PDF export and the
// published payslips, so the note column stays identical everywhere:
//   1. adjustment reasons, excluding the internal T09 overtime reference;
//   2. one short-shift note listing every attendance date credited below one
//      full công, with its credit;
//   3. the "chốt lương" reason for an employee who left during the period.
//
// It only formats: no amount is recalculated or changed. Framework-free.

import type {
  AdjustmentField,
  PayrollAdjustment,
  PayrollEmployeeLine,
} from "./types.ts";

const LEFT_IN_PERIOD_NOTE = "Nghỉ việc trong kỳ: không tính ngày lễ, tăng ca";

/** ISO YYYY-MM-DD → dd/MM (no date library needed). */
function dayMonth(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** Short-shift credit as written in the note, with a comma decimal. */
function creditText(credit: 0 | 0.5): string {
  return credit === 0.5 ? "0,5" : "0";
}

/**
 * Build the note list per employee. Employees with no note are absent from the
 * map, and the 'terminated' fallback stays in the callers.
 */
export function buildPayrollNotes(
  lines: readonly PayrollEmployeeLine[],
  adjustments: readonly PayrollAdjustment[],
  adjustmentLabels: Record<AdjustmentField, string>,
): Map<string, string[]> {
  const notes = new Map<string, string[]>();
  const push = (employeeCode: string, note: string) => {
    const list = notes.get(employeeCode) ?? [];
    list.push(note);
    notes.set(employeeCode, list);
  };

  // Hide only the internal reconciliation reference, not the adjustment itself.
  // Meaningful reasons keep their original text/order; audit data is untouched.
  for (const item of adjustments) {
    if (item.field === "overtime_hours" && item.reason.trim() === "Theo bảng lương DIEU CHINH T09") continue;
    push(item.employeeCode, `${adjustmentLabels[item.field]}: ${item.reason}`);
  }

  for (const line of lines) {
    // 2. Short shifts — one note for every affected attendance date.
    if (line.shortShiftDays.length > 0) {
      const parts = line.shortShiftDays.map(
        (day) => `${dayMonth(day.date)} (${creditText(day.credit)} công)`,
      );
      push(line.employeeCode, `Ca ngắn: ${parts.join(", ")}`);
    }
    // 3. Chốt lương — the employee left during the period.
    if (line.flags.includes("left_in_period")) {
      push(line.employeeCode, LEFT_IN_PERIOD_NOTE);
    }
  }

  return notes;
}
