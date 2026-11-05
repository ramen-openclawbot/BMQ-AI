// Shared "Ghi chú" builder for the Bếp BN payroll (2026-10-09).
//
// One pure function feeds the draft table, the Excel/PDF export and the
// published payslips, so the note column stays identical everywhere:
//   1. adjustment reasons, excluding the internal T09 overtime reference;
//   2. one short-shift note listing every attendance date credited below one
//      full công, with its credit;
//   3. one "missing check-out" note for the dates the reviewer excluded, so the
//      employee knows the day is unpaid on this payslip and how to appeal;
//   4. the "chốt lương" reason for an employee who left during the period;
//
// It only formats: no amount is recalculated or changed. Framework-free.

import type { IssueReview } from "./issue-review.ts";
import type {
  AdjustmentField,
  PayrollAdjustment,
  PayrollEmployeeLine,
} from "./types.ts";

const LEFT_IN_PERIOD_NOTE = "Nghỉ việc trong kỳ: không tính ngày lễ, tăng ca";
const MISSING_CHECK_OUT_PREFIX = "Ngày công không được tính do không chấm công giờ ra";
const MISSING_CHECK_OUT_SUFFIX =
  "Vui lòng liên hệ cấp quản lý để giải trình. Nếu được duyệt, ngày lương sẽ được chuyển bù vào tháng sau.";

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
  issueReviews: readonly IssueReview[] = [],
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

  // Only an excluded missing check-out removes a day from payroll; an accepted
  // review keeps the day, and other issue codes never produce this note.
  const missingCheckOutDays = new Map<string, Set<string>>();
  for (const review of issueReviews) {
    if (review.decision !== "excluded" || review.issueCode !== "missing_check_out") continue;
    const dates = missingCheckOutDays.get(review.employeeCode) ?? new Set<string>();
    dates.add(review.workDate);
    missingCheckOutDays.set(review.employeeCode, dates);
  }
  const missingCheckOutNote = (dates: Set<string>): string =>
    `${MISSING_CHECK_OUT_PREFIX}: ${[...dates].sort().map(dayMonth).join(", ")}. ${MISSING_CHECK_OUT_SUFFIX}`;
  const emittedMissingCheckOut = new Set<string>();

  for (const line of lines) {
    // 2. Short shifts — one note for every affected attendance date.
    if (line.shortShiftDays.length > 0) {
      const parts = line.shortShiftDays.map(
        (day) => `${dayMonth(day.date)} (${creditText(day.credit)} công)`,
      );
      push(line.employeeCode, `Ca ngắn: ${parts.join(", ")}`);
    }
    // 3. Missing check-out — the reviewer excluded these days from payroll.
    const missingDays = missingCheckOutDays.get(line.employeeCode);
    if (missingDays) {
      push(line.employeeCode, missingCheckOutNote(missingDays));
      emittedMissingCheckOut.add(line.employeeCode);
    }
    // 4. Chốt lương — the employee left during the period.
    if (line.flags.includes("left_in_period")) {
      push(line.employeeCode, LEFT_IN_PERIOD_NOTE);
    }
  }

  // Keep the note even when every attendance row of the employee was excluded,
  // i.e. when no payroll line remains for them to carry it.
  for (const [employeeCode, dates] of missingCheckOutDays) {
    if (emittedMissingCheckOut.has(employeeCode)) continue;
    push(employeeCode, missingCheckOutNote(dates));
  }

  return notes;
}
