// Compare the rounded net pay of the current Bếp BN payroll with the previous
// period, by employee, by group and in total.
//
// Amounts are whole đồng bigints, so the percentage is computed as an exact
// integer fraction before the final 1-decimal rounding. A comparison is
// impossible (null) when there is no previous period, when the employee/group
// was absent from it, or when its amount is not positive.

import { rational, roundHalfUpToStep } from "./money.ts";
import type { PayrollResult } from "./types.ts";

export interface PayrollComparison {
  byEmployee: Map<string, number | null>;
  byGroup: Map<string, number | null>;
  total: number | null;
}

/**
 * (current - previous) / previous * 100 rounded to 1 decimal, positive when the
 * pay increased. Null when the previous amount is zero or negative.
 */
function percentChange(current: bigint, previous: bigint): number | null {
  if (previous <= 0n) return null;
  // Tenths of a percent: round((current - previous) * 1000 / previous).
  const tenths = roundHalfUpToStep(rational((current - previous) * 1000n, previous), 1n);
  return Number(tenths) / 10;
}

/** Percent change of a current amount against an optional previous amount. */
function compareAmount(current: bigint, previous: bigint | undefined): number | null {
  return previous === undefined ? null : percentChange(current, previous);
}

export function comparePayroll(
  current: PayrollResult,
  previous: PayrollResult | null,
): PayrollComparison {
  const previousEmployees = new Map<string, bigint>();
  const previousGroups = new Map<string, bigint>();
  if (previous) {
    for (const line of previous.employees) {
      previousEmployees.set(line.employeeCode, line.netPayRounded);
    }
    for (const line of previous.groups) {
      previousGroups.set(line.group, line.netPayRounded);
    }
  }

  const byEmployee = new Map<string, number | null>();
  for (const line of current.employees) {
    byEmployee.set(line.employeeCode, compareAmount(line.netPayRounded, previousEmployees.get(line.employeeCode)));
  }

  const byGroup = new Map<string, number | null>();
  for (const line of current.groups) {
    byGroup.set(line.group, compareAmount(line.netPayRounded, previousGroups.get(line.group)));
  }

  const total = previous
    ? percentChange(current.total.netPayRounded, previous.total.netPayRounded)
    : null;

  return { byEmployee, byGroup, total };
}
